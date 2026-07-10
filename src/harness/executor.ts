import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execa } from "execa";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size?: number;
  updatedAt?: string;
}

export type WorkspacePathInfo =
  | { path: string; kind: "missing" }
  | { path: string; kind: "directory"; entries: WorkspaceFileEntry[] }
  | { path: string; kind: "file"; size: number; updatedAt: string };

export interface WorkspaceSessionOutputEvent {
  stream: "stdout" | "stderr";
  data: string;
}

export interface WorkspaceSessionExitEvent {
  exitCode: number;
  signal?: string;
}

export interface WorkspaceSession {
  onOutput(listener: (event: WorkspaceSessionOutputEvent) => void): () => void;
  onExit(listener: (event: WorkspaceSessionExitEvent) => void): () => void;
  write(input: string): Promise<void>;
  stop(): Promise<void>;
}

export interface WorkspaceGitCredentialOptions {
  tokenEnvName: string;
  username?: string;
}

export interface WorkspaceExecutionOptions {
  env?: Record<string, string>;
  gitCredential?: WorkspaceGitCredentialOptions;
}

export interface WorkspaceDescription {
  kind: string;
  [key: string]: string | number | boolean | undefined;
}

export interface WorkspaceExecutor {
  prepare?(options?: WorkspaceExecutionOptions): Promise<void>;
  inspectPath(path: string): Promise<WorkspacePathInfo>;
  readFile(path: string, maxBytes?: number): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile?(path: string): Promise<void>;
  moveFile?(fromPath: string, toPath: string): Promise<void>;
  runCommand(command: string, timeoutMs?: number, signal?: AbortSignal, options?: WorkspaceExecutionOptions): Promise<CommandResult>;
  startSession?(command: string, options?: WorkspaceExecutionOptions): Promise<WorkspaceSession> | WorkspaceSession;
  describePath?(path: string): string;
  describeWorkspace?(): WorkspaceDescription;
}

export interface LocalExecutorOptions {
  cwd: string;
}

export const PROCESS_SESSION_STOP_GRACE_MS = 5_000;

export interface ProcessSessionOptions {
  cwd?: string;
  stopGraceMs?: number;
  env?: Record<string, string>;
}

export function createLocalExecutor(options: LocalExecutorOptions): WorkspaceExecutor {
  const cwd = resolve(options.cwd);

  return {
    async inspectPath(path: string): Promise<WorkspacePathInfo> {
      const target = safePath(cwd, path, true);
      const relPath = workspaceRelativePath(cwd, target);
      let stats;
      try {
        await assertRealPathInside(cwd, target, path, true);
        stats = await stat(target);
      } catch (error) {
        if (isNotFound(error)) return { path: relPath, kind: "missing" };
        throw error;
      }
      if (stats.isDirectory()) {
        const entries = await readdir(target, { withFileTypes: true });
        const visibleEntries = entries
          .filter((entry) => entry.name !== ".loom")
          .filter((entry) => entry.isDirectory() || entry.isFile())
          .sort((a, b) => a.name.localeCompare(b.name));
        const files = await Promise.all(
          visibleEntries.map(async (entry): Promise<WorkspaceFileEntry> => {
            const childPath = join(target, entry.name);
            const childStats = await stat(childPath);
            return compactWorkspaceFileEntry({
              name: entry.name,
              path: join(relPath, entry.name).split(sep).join("/"),
              kind: entry.isDirectory() ? "directory" : "file",
              size: entry.isFile() ? childStats.size : undefined,
              updatedAt: childStats.mtime.toISOString(),
            });
          }),
        );
        return { path: relPath, kind: "directory", entries: files };
      }
      if (stats.isFile()) {
        return {
          path: relPath,
          kind: "file",
          size: stats.size,
          updatedAt: stats.mtime.toISOString(),
        };
      }
      return { path: relPath, kind: "missing" };
    },

    async readFile(path: string, maxBytes?: number): Promise<string> {
      const content = await readFile(await safeExistingPath(cwd, path), "utf8");
      return typeof maxBytes === "number" ? content.slice(0, maxBytes) : content;
    },

    async writeFile(path: string, content: string): Promise<void> {
      const target = await safeWritablePath(cwd, path);
      await writeFile(target, content, "utf8");
    },

    async deleteFile(path: string): Promise<void> {
      await unlink(await safeExistingPath(cwd, path));
    },

    async moveFile(fromPath: string, toPath: string): Promise<void> {
      const source = await safeExistingPath(cwd, fromPath);
      const target = await safeWritablePath(cwd, toPath);
      await rename(source, target);
    },

    async runCommand(command: string, timeoutMs = 120_000, signal?: AbortSignal, execution?: WorkspaceExecutionOptions): Promise<CommandResult> {
      const env = safeWorkspaceEnv(execution?.env);
      const result = await execa("sh", ["-lc", command], {
        cwd,
        timeout: timeoutMs,
        cancelSignal: signal,
        env: env ? { ...process.env, ...env } : undefined,
        reject: false,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 1,
      };
    },

    startSession(command: string, execution?: WorkspaceExecutionOptions): WorkspaceSession {
      return createProcessSession("sh", ["-lc", command], { cwd, env: execution?.env });
    },

    describePath(path: string): string {
      return relative(cwd, safePath(cwd, path));
    },

    describeWorkspace(): WorkspaceDescription {
      return { kind: "local", cwd };
    },
  };
}

export function createProcessSession(
  file: string,
  args: string[],
  options: ProcessSessionOptions = {},
): WorkspaceSession {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...safeWorkspaceEnv(options.env) } : undefined,
    stdio: "pipe",
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const outputListeners: Array<(event: WorkspaceSessionOutputEvent) => void> = [];
  const exitListeners: Array<(event: WorkspaceSessionExitEvent) => void> = [];
  const stopWaiters: Array<() => void> = [];
  let exited = false;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;

  child.stdout.on("data", (data) => emitOutput({ stream: "stdout", data: String(data) }));
  child.stderr.on("data", (data) => emitOutput({ stream: "stderr", data: String(data) }));
  child.on("error", (error) => {
    emitOutput({ stream: "stderr", data: `${error.message}\n` });
    emitExit({ exitCode: 1 });
  });
  child.on("exit", (code, signal) => {
    emitExit({ exitCode: code ?? (signal ? 143 : 1), signal: signal ?? undefined });
  });

  function emitOutput(event: WorkspaceSessionOutputEvent): void {
    for (const listener of outputListeners) listener(event);
  }

  function emitExit(event: WorkspaceSessionExitEvent): void {
    if (exited) return;
    exited = true;
    if (stopTimer) clearTimeout(stopTimer);
    for (const listener of exitListeners) listener(event);
    for (const resolve of stopWaiters.splice(0)) resolve();
  }

  function waitForExit(): Promise<void> {
    if (exited) return Promise.resolve();
    return new Promise((resolve) => stopWaiters.push(resolve));
  }

  return {
    onOutput(listener: (event: WorkspaceSessionOutputEvent) => void): () => void {
      outputListeners.push(listener);
      return () => {
        const index = outputListeners.indexOf(listener);
        if (index >= 0) outputListeners.splice(index, 1);
      };
    },

    onExit(listener: (event: WorkspaceSessionExitEvent) => void): () => void {
      exitListeners.push(listener);
      return () => {
        const index = exitListeners.indexOf(listener);
        if (index >= 0) exitListeners.splice(index, 1);
      };
    },

    async write(input: string): Promise<void> {
      if (exited || child.stdin.destroyed) {
        throw new Error("workspace session is not running");
      }
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(input, (error) => (error ? reject(error) : resolve()));
      });
    },

    async stop(): Promise<void> {
      if (exited) return;
      child.kill("SIGTERM");
      const stopGraceMs = options.stopGraceMs ?? PROCESS_SESSION_STOP_GRACE_MS;
      if (stopGraceMs > 0 && !stopTimer) {
        stopTimer = setTimeout(() => {
          if (!exited) child.kill("SIGKILL");
        }, stopGraceMs);
        stopTimer.unref?.();
      }
      await waitForExit();
    },
  };
}

export function safeWorkspaceEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const safeEntries = Object.entries(env).map(([name, value]) => {
    safeWorkspaceEnvName(name);
    if (typeof value !== "string" || /[\0\r\n]/.test(value)) {
      throw new Error(`workspace env value is not a single-line string: ${name}`);
    }
    return [name, value] as const;
  });
  if (!safeEntries.length) return undefined;
  return Object.fromEntries(safeEntries);
}

export function safeWorkspaceEnvName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`workspace env name is not safe: ${name}`);
  }
  return name;
}

function safePath(cwd: string, inputPath: string, allowRoot = false): string {
  if (!inputPath.trim()) {
    if (allowRoot) return cwd;
    throw new Error("path is required");
  }
  const target = resolve(cwd, inputPath);
  const rel = relative(cwd, target);
  if (rel.startsWith("..") || (!allowRoot && rel === "") || (!allowRoot && resolve(target) === cwd)) {
    throw new Error(`path escapes workspace: ${inputPath}`);
  }
  return target;
}

async function safeExistingPath(cwd: string, inputPath: string): Promise<string> {
  const target = safePath(cwd, inputPath);
  await assertRealPathInside(cwd, target, inputPath);
  return target;
}

async function safeWritablePath(cwd: string, inputPath: string): Promise<string> {
  const target = safePath(cwd, inputPath);
  const parent = dirname(target);
  await mkdir(cwd, { recursive: true });
  await assertWritableParentInside(cwd, parent, inputPath);
  await mkdir(parent, { recursive: true });
  await assertRealPathInside(cwd, parent, inputPath, true);
  try {
    await assertRealPathInside(cwd, target, inputPath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return target;
}

async function assertWritableParentInside(cwd: string, parent: string, inputPath: string): Promise<void> {
  const realCwd = await realpath(cwd);
  let current = parent;
  while (true) {
    try {
      assertPathInside(realCwd, await realpath(current), inputPath, true);
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const next = dirname(current);
      if (next === current) throw error;
      current = next;
    }
  }
}

async function assertRealPathInside(cwd: string, target: string, inputPath: string, allowRoot = false): Promise<void> {
  assertPathInside(await realpath(cwd), await realpath(target), inputPath, allowRoot);
}

function assertPathInside(realCwd: string, realTarget: string, inputPath: string, allowRoot = false): void {
  const rel = relative(realCwd, realTarget);
  if (rel === ".." || rel.startsWith(`..${sep}`) || (!allowRoot && rel === "")) {
    throw new Error(`path escapes workspace: ${inputPath}`);
  }
}

function workspaceRelativePath(cwd: string, target: string): string {
  const rel = relative(cwd, target);
  return rel === "" ? "" : rel.split(sep).join("/");
}

function compactWorkspaceFileEntry(entry: WorkspaceFileEntry): WorkspaceFileEntry {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as WorkspaceFileEntry;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
