import { posix } from "node:path";
import { execa } from "execa";

import { createProcessSession, safeWorkspaceEnv, safeWorkspaceEnvName, type CommandResult, type WorkspaceExecutionOptions, type WorkspaceExecutor, type WorkspaceFileEntry, type WorkspaceGitCredentialOptions, type WorkspacePathInfo, type WorkspaceSession } from "./executor.js";
import { safeGitRef } from "./git-ref.js";

export type CoderCommandRunner = (file: string, args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<CommandResult>;

export interface CoderExecutorOptions {
  workspace: string;
  remoteCwd: string;
  template?: string;
  repoCwd?: string;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  ideUrl?: string;
  previewUrl?: string;
  templateParameters?: string[];
  templateResourceLimits?: CoderTemplateResourceLimits;
  coderBin?: string;
  commandRunner?: CoderCommandRunner;
}

export interface CoderTemplateResourceLimits {
  cpus?: number;
  memory?: string;
  pidsLimit?: number;
}

const SECRET_BEARING_TEMPLATE_PARAMETER_PARTS = new Set(["token", "key", "secret", "password"]);
const SECRET_BEARING_IDE_URL_QUERY_PARTS = new Set([...SECRET_BEARING_TEMPLATE_PARAMETER_PARTS, "auth", "authorization"]);

export function createCoderExecutor(options: CoderExecutorOptions): WorkspaceExecutor {
  const workspace = safeCoderWorkspace(options.workspace);
  const remoteCwd = normalizeRemotePath(options.remoteCwd, "remoteCwd");
  const template = safeCoderTemplate(options.template);
  const repoCwd = options.repoCwd ? normalizeRemotePath(options.repoCwd, "repoCwd") : undefined;
  const repo = safeGitRepo(options.repo);
  const branch = options.branch ? safeGitRef(options.branch, "branch") : undefined;
  const baseBranch = options.baseBranch ? safeGitRef(options.baseBranch, "baseBranch") : "origin/main";
  const ideUrl = options.ideUrl ? safeWorkspaceUrl(options.ideUrl, "ideUrl") : undefined;
  const previewUrl = options.previewUrl ? safeWorkspaceUrl(options.previewUrl, "previewUrl") : undefined;
  const templateParameters = mergeTemplateParameters([
    ...(options.templateParameters ?? []).map(safeTemplateParameter),
    ...resourceLimitTemplateParameters(options.templateResourceLimits),
  ]);
  const coderBin = options.coderBin ?? "coder";
  const commandRunner = options.commandRunner ?? runProcess;
  if (repoCwd && repo && !branch) {
    throw new Error("coder executor repoCwd requires branch");
  }

  return {
    async prepare(execution?: WorkspaceExecutionOptions): Promise<void> {
      const env = safeWorkspaceEnv(execution?.env);
      const gitCredential = safeWorkspaceGitCredential(execution?.gitCredential);
      if (template) {
        const show = await commandRunner(coderBin, ["show", workspace], 120_000);
        if (show.exitCode !== 0) {
          ensureOk(await commandRunner(coderBin, createWorkspaceArgs(template, templateParameters, workspace), 120_000));
        }
      }
      ensureOk(await commandRunner(coderBin, ["start", "--yes", workspace], 120_000));
      if (repo) {
        if (repoCwd) {
          if (!branch) throw new Error("coder executor repoCwd requires branch");
          ensureOk(
            await runWorkspace(
              coderBin,
              workspace,
              mkdirCommand([posix.dirname(repoCwd), posix.dirname(remoteCwd)]),
              commandRunner,
            ),
          );
          ensureOk(await runWorkspace(coderBin, workspace, workspaceShellCommand(syncCommand(repoCwd, repo), env, gitCredential), commandRunner));
          ensureOk(await runWorkspace(coderBin, workspace, workspaceShellCommand(worktreeCommand(repoCwd, remoteCwd, branch, baseBranch), env, gitCredential), commandRunner));
        } else {
          ensureOk(await runWorkspace(coderBin, workspace, mkdirCommand([posix.dirname(remoteCwd)]), commandRunner));
          ensureOk(await runWorkspace(coderBin, workspace, workspaceShellCommand(syncCommand(remoteCwd, repo), env, gitCredential), commandRunner));
        }
        if (branch && !repoCwd) {
          ensureOk(await runWorkspace(coderBin, workspace, workspaceShellCommand(switchBranchCommand(remoteCwd, branch, baseBranch), env, gitCredential), commandRunner));
        }
      } else {
        ensureOk(await runWorkspace(coderBin, workspace, mkdirCommand([remoteCwd]), commandRunner));
      }
    },

    async readFile(path: string, maxBytes?: number): Promise<string> {
      const target = safeRelativePath(path);
      const byteLimit = typeof maxBytes === "number" && Number.isFinite(maxBytes) ? Math.max(0, Math.trunc(maxBytes)) : undefined;
      const command =
        byteLimit === undefined ? `cat -- ${shellQuote(target)}` : `head -c ${byteLimit} -- ${shellQuote(target)}`;
      const result = await runRemote(coderBin, workspace, remoteCwd, guardedExistingPathCommand(target, command), commandRunner);
      ensureOk(result);
      return result.stdout;
    },

    async inspectPath(path: string): Promise<WorkspacePathInfo> {
      const target = safeRelativePath(path, true);
      const result = await runRemote(coderBin, workspace, remoteCwd, guardedInspectPathCommand(target), commandRunner);
      ensureOk(result);
      return parseInspectPathOutput(result.stdout, target);
    },

    async writeFile(path: string, content: string): Promise<void> {
      const target = safeRelativePath(path);
      const dir = posix.dirname(target);
      const encoded = Buffer.from(content, "utf8").toString("base64");
      const command = [
        remotePathGuardPrelude(),
        `loom_safe_writable_path ${shellQuote(target)}`,
        `mkdir -p -- ${shellQuote(dir)}`,
        `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(target)}`,
      ].join(" && ");
      ensureOk(await runRemote(coderBin, workspace, remoteCwd, command, commandRunner));
    },

    async deleteFile(path: string): Promise<void> {
      const target = safeRelativePath(path);
      ensureOk(await runRemote(coderBin, workspace, remoteCwd, guardedExistingPathCommand(target, `rm -f -- ${shellQuote(target)}`), commandRunner));
    },

    async moveFile(fromPath: string, toPath: string): Promise<void> {
      const source = safeRelativePath(fromPath);
      const target = safeRelativePath(toPath);
      const dir = posix.dirname(target);
      const command = [
        remotePathGuardPrelude(),
        `loom_safe_existing_path ${shellQuote(source)}`,
        `loom_safe_writable_path ${shellQuote(target)}`,
        `mkdir -p -- ${shellQuote(dir)}`,
        `mv -- ${shellQuote(source)} ${shellQuote(target)}`,
      ].join(" && ");
      ensureOk(await runRemote(coderBin, workspace, remoteCwd, command, commandRunner));
    },

    async runCommand(command: string, timeoutMs = 120_000, signal?: AbortSignal, execution?: WorkspaceExecutionOptions): Promise<CommandResult> {
      return runRemote(coderBin, workspace, remoteCwd, `${workspaceEnvPrefix(execution?.env)}sh -lc ${shellQuote(command)}`, commandRunner, timeoutMs, signal);
    },

    startSession(command: string, execution?: WorkspaceExecutionOptions): WorkspaceSession {
      return createProcessSession(coderBin, [
        "ssh",
        workspace,
        "--",
        "sh",
        "-lc",
        `cd ${shellQuote(remoteCwd)} && ${workspaceEnvPrefix(execution?.env)}sh -lc ${shellQuote(command)}`,
      ]);
    },

    describeWorkspace() {
      return compactWorkspaceDescription({
        kind: "coder",
        workspace,
        remoteCwd,
        repoCwd,
        branch,
        baseBranch,
        ideUrl,
        previewUrl,
      });
    },

    describePath(path: string): string {
      return safeRelativePath(path);
    },
  };
}

async function runRemote(
  coderBin: string,
  workspace: string,
  remoteCwd: string,
  command: string,
  commandRunner: CoderCommandRunner,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return commandRunner(
    coderBin,
    ["ssh", workspace, "--", "sh", "-lc", `cd ${shellQuote(remoteCwd)} && ${command}`],
    timeoutMs,
    signal,
  );
}

async function runWorkspace(
  coderBin: string,
  workspace: string,
  command: string,
  commandRunner: CoderCommandRunner,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return commandRunner(coderBin, ["ssh", workspace, "--", "sh", "-lc", command], timeoutMs, signal);
}

function workspaceEnvPrefix(env: Record<string, string> | undefined): string {
  const safe = safeWorkspaceEnv(env);
  if (!safe) return "";
  return `env ${Object.entries(safe)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ")} `;
}

function workspaceShellCommand(
  command: string,
  env: Record<string, string> | undefined,
  gitCredential?: WorkspaceGitCredentialOptions,
): string {
  const preparedCommand = gitCredential ? gitCredentialCommand(command, gitCredential) : command;
  return env || gitCredential ? `${workspaceEnvPrefix(env)}sh -lc ${shellQuote(preparedCommand)}` : preparedCommand;
}

function safeWorkspaceGitCredential(credential: WorkspaceGitCredentialOptions | undefined): WorkspaceGitCredentialOptions | undefined {
  if (!credential) return undefined;
  const tokenEnvName = safeWorkspaceEnvName(credential.tokenEnvName);
  const username = credential.username?.trim() || "x-access-token";
  if (username.includes("\0") || username.includes("\r") || username.includes("\n")) {
    throw new Error("workspace git credential username is not a single-line string");
  }
  return { tokenEnvName, username };
}

function gitCredentialCommand(command: string, credential: WorkspaceGitCredentialOptions): string {
  const tokenEnvName = safeWorkspaceEnvName(credential.tokenEnvName);
  const username = credential.username ?? "x-access-token";
  return [
    ": loom-git-credential;",
    'loom_git_askpass=$(mktemp "${TMPDIR:-/tmp}/loom-git-askpass.XXXXXX") || exit 1',
    'chmod 700 "$loom_git_askpass" || exit 1',
    `cat > "$loom_git_askpass" <<'LOOM_GIT_ASKPASS'`,
    "#!/bin/sh",
    'case "$1" in',
    `*Username*) printf '%s\\n' ${shellQuote(username)} ;;`,
    `*) printenv ${shellQuote(tokenEnvName)} ;;`,
    "esac",
    "LOOM_GIT_ASKPASS",
    `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$loom_git_askpass" sh -lc ${shellQuote(command)}`,
    "status=$?",
    'rm -f "$loom_git_askpass"',
    'exit "$status"',
  ].join("\n");
}

async function runProcess(file: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  const result = await execa(file, args, {
    timeout: timeoutMs,
    cancelSignal: signal,
    reject: false,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}

function safeRelativePath(inputPath: string, allowRoot = false): string {
  const cleaned = inputPath.replaceAll("\\", "/").trim();
  if (!cleaned) {
    if (allowRoot) return ".";
    throw new Error(`path escapes workspace: ${inputPath}`);
  }
  if (cleaned.includes("\0") || cleaned.startsWith("/")) {
    throw new Error(`path escapes workspace: ${inputPath}`);
  }
  const parts = cleaned.split("/");
  if (parts.includes("..")) {
    throw new Error(`path escapes workspace: ${inputPath}`);
  }
  const normalized = posix.normalize(cleaned);
  if (allowRoot && normalized === ".") {
    return ".";
  }
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`path escapes workspace: ${inputPath}`);
  }
  return normalized;
}

function ensureOk(result: CommandResult): void {
  if (result.exitCode === 0) return;
  throw new Error(result.stderr || result.stdout || `remote command failed with exit code ${result.exitCode}`);
}

// Restrict git to network/ssh transports so a repo URL cannot invoke the
// ext::/fd:: transport helpers (arbitrary command execution) or file:
// (out-of-workspace reads). Exported once so every git child in the command
// body inherits it, in both the credentialed and public-clone paths.
const GIT_PROTOCOL_ALLOWLIST = "https:http:ssh:git";

function withGitProtocolGuard(body: string): string {
  return `export GIT_ALLOW_PROTOCOL=${GIT_PROTOCOL_ALLOWLIST}; ${body}`;
}

function syncCommand(remoteCwd: string, repo: string): string {
  return withGitProtocolGuard(`if [ -d ${shellQuote(posix.join(remoteCwd, ".git"))} ]; then cd ${shellQuote(remoteCwd)} && git fetch --all --prune; else rm -rf ${shellQuote(remoteCwd)} && git clone ${shellQuote(repo)} ${shellQuote(remoteCwd)}; fi`);
}

function switchBranchCommand(remoteCwd: string, branch: string, baseBranch: string): string {
  return withGitProtocolGuard(`cd ${shellQuote(remoteCwd)} && (git switch ${shellQuote(branch)} || git switch -c ${shellQuote(branch)} ${shellQuote(baseBranch)})`);
}

function worktreeCommand(repoCwd: string, remoteCwd: string, branch: string, baseBranch: string): string {
  return withGitProtocolGuard(`if [ -e ${shellQuote(posix.join(remoteCwd, ".git"))} ]; then cd ${shellQuote(remoteCwd)} && git fetch --all --prune && git switch ${shellQuote(branch)}; else rm -rf ${shellQuote(remoteCwd)} && cd ${shellQuote(repoCwd)} && git worktree add -B ${shellQuote(branch)} ${shellQuote(remoteCwd)} ${shellQuote(baseBranch)}; fi`);
}

function inspectPathCommand(target: string): string {
  const quoted = shellQuote(target);
  return [
    ": loom-inspect-path;",
    `if [ ! -e ${quoted} ]; then printf 'missing\\t%s\\n' ${quoted};`,
    `elif [ -f ${quoted} ]; then printf 'file\\t%s\\t%s\\t%s\\n' ${quoted} "$(stat -c %s -- ${quoted})" "$(stat -c %Y -- ${quoted})";`,
    `elif [ -d ${quoted} ]; then printf 'directory\\t%s\\n' ${quoted}; find -- ${quoted} -mindepth 1 -maxdepth 1 \\( -type f -o -type d \\) ! -name .loom -printf 'entry\\t%f\\t%P\\t%y\\t%s\\t%T@\\n' | sort;`,
    `else printf 'missing\\t%s\\n' ${quoted}; fi`,
  ].join(" ");
}

function guardedExistingPathCommand(target: string, command: string): string {
  return [remotePathGuardPrelude(), `loom_safe_existing_path ${shellQuote(target)}`, command].join(" && ");
}

function guardedInspectPathCommand(target: string): string {
  return [remotePathGuardPrelude(), `loom_safe_inspect_path ${shellQuote(target)}`, inspectPathCommand(target)].join(" && ");
}

function remotePathGuardPrelude(): string {
  return [
    ": loom-safe-path;",
    "loom_safe_path_inside() { root=$(pwd -P) || exit 1; target=$(realpath -- \"$1\") || exit 1; case \"$target\" in \"$root\"/*) return 0;; \"$root\") if [ \"${2:-}\" = allow-root ]; then return 0; fi;; esac; printf \"%s\\n\" \"path escapes workspace: $1\" >&2; exit 1; };",
    "loom_safe_existing_path() { loom_safe_path_inside \"$1\" \"${2:-}\"; };",
    "loom_safe_writable_path() { root=$(pwd -P) || exit 1; dir=$(dirname -- \"$1\") || exit 1; while [ ! -e \"$dir\" ]; do next=$(dirname -- \"$dir\") || exit 1; if [ \"$next\" = \"$dir\" ]; then printf \"%s\\n\" \"path escapes workspace: $1\" >&2; exit 1; fi; dir=\"$next\"; done; parent=$(realpath -- \"$dir\") || exit 1; case \"$parent\" in \"$root\"|\"$root\"/*) ;; *) printf \"%s\\n\" \"path escapes workspace: $1\" >&2; exit 1;; esac; if [ -e \"$1\" ] || [ -L \"$1\" ]; then loom_safe_path_inside \"$1\"; fi; };",
    "loom_safe_inspect_path() { if [ -e \"$1\" ] || [ -L \"$1\" ]; then loom_safe_path_inside \"$1\" allow-root; fi; };",
    "true",
  ].join(" ");
}

function parseInspectPathOutput(stdout: string, target: string): WorkspacePathInfo {
  const lines = stdout
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);
  const [kind, rawPath = target, size, updatedAt] = lines[0]?.split("\t") ?? [];
  const path = displayRemotePath(rawPath || target);
  if (kind === "missing") {
    return { path, kind: "missing" };
  }
  if (kind === "file") {
    return {
      path,
      kind: "file",
      size: parseRemoteSize(size),
      updatedAt: parseRemoteTimestamp(updatedAt),
    };
  }
  if (kind === "directory") {
    const entries = lines
      .slice(1)
      .filter((line) => line.startsWith("entry\t"))
      .map((line): WorkspaceFileEntry => {
        const [, name, relativePath, type, entrySize, entryUpdatedAt] = line.split("\t");
        const entryPath = displayRemotePath(target === "." ? relativePath : posix.join(target, relativePath));
        const entryKind = type === "d" || type === "directory" ? "directory" : "file";
        return compactRemoteFileEntry({
          name,
          path: entryPath,
          kind: entryKind,
          size: entryKind === "file" ? parseRemoteSize(entrySize) : undefined,
          updatedAt: parseRemoteTimestamp(entryUpdatedAt),
        });
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { path, kind: "directory", entries };
  }
  throw new Error(`unexpected remote inspect output: ${stdout}`);
}

function displayRemotePath(path: string): string {
  if (!path || path === ".") return "";
  return path.replace(/^\.\//, "");
}

function parseRemoteSize(value: string | undefined): number {
  const size = Number(value);
  return Number.isFinite(size) ? size : 0;
}

function parseRemoteTimestamp(value: string | undefined): string {
  if (!value) return new Date(0).toISOString();
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString();
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? new Date(0).toISOString() : timestamp.toISOString();
}

function compactRemoteFileEntry(entry: WorkspaceFileEntry): WorkspaceFileEntry {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as WorkspaceFileEntry;
}

function compactWorkspaceDescription<T extends Record<string, string | undefined>>(description: T): T {
  return Object.fromEntries(Object.entries(description).filter(([, value]) => value !== undefined)) as T;
}

function safeWorkspaceUrl(value: string, field: "ideUrl" | "previewUrl"): string {
  const url = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${field} must be an http or https URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} must be an http or https URL`);
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    [...parsed.searchParams.keys()].some(isSecretBearingIdeUrlQueryKey)
  ) {
    throw new Error(`${field} must not include credentials, fragments, or secret-bearing query parameters`);
  }
  return url;
}

function isSecretBearingIdeUrlQueryKey(key: string): boolean {
  return hasSecretBearingNamePart(key, SECRET_BEARING_IDE_URL_QUERY_PARTS);
}

function hasSecretBearingNamePart(name: string, secretParts: Set<string>): boolean {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return parts.some((part) => secretParts.has(part));
}

function safeTemplateParameter(value: string): string {
  const param = value.trim();
  const separator = param.indexOf("=");
  if (separator <= 0) {
    throw new Error(`template parameter must be name=value: ${value}`);
  }
  const name = param.slice(0, separator);
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`template parameter name is not safe: ${name}`);
  }
  if (hasSecretBearingNamePart(name, SECRET_BEARING_TEMPLATE_PARAMETER_PARTS)) {
    throw new Error(`template parameter name must not be secret-bearing: ${name}`);
  }
  if (param.includes("\0")) {
    throw new Error("template parameter contains an invalid NUL byte");
  }
  return param;
}

function resourceLimitTemplateParameters(limits: CoderTemplateResourceLimits | undefined): string[] {
  if (!limits) return [];
  const parameters: string[] = [];
  if (limits.cpus !== undefined) {
    parameters.push(safeTemplateParameter(`cpus=${formatTemplateNumber(limits.cpus)}`));
  }
  if (limits.memory !== undefined) {
    parameters.push(safeTemplateParameter(`memory_gb=${memoryToGbParameter(limits.memory)}`));
  }
  if (limits.pidsLimit !== undefined) {
    parameters.push(safeTemplateParameter(`pids_limit=${limits.pidsLimit}`));
  }
  return parameters;
}

function mergeTemplateParameters(parameters: string[]): string[] {
  const order: string[] = [];
  const byName = new Map<string, string>();
  for (const parameter of parameters) {
    const name = parameter.slice(0, parameter.indexOf("="));
    if (!byName.has(name)) order.push(name);
    byName.set(name, parameter);
  }
  return order.map((name) => byName.get(name) as string);
}

function memoryToGbParameter(memory: string): string {
  const value = memory.trim().toLowerCase();
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)(b|k|kb|ki|kib|m|mb|mi|mib|g|gb|gi|gib|t|tb|ti|tib)?$/);
  if (!match) {
    throw new Error(`template resource memory must be a size like 512m or 4g: ${memory}`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "g";
  const gib =
    unit === "b" ? amount / 1024 / 1024 / 1024 :
    unit === "k" || unit === "kb" || unit === "ki" || unit === "kib" ? amount / 1024 / 1024 :
    unit === "m" || unit === "mb" || unit === "mi" || unit === "mib" ? amount / 1024 :
    unit === "t" || unit === "tb" || unit === "ti" || unit === "tib" ? amount * 1024 :
    amount;
  return formatTemplateNumber(gib);
}

function formatTemplateNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`template resource value must be a positive number: ${value}`);
  }
  return Number(value.toFixed(6)).toString();
}

function createWorkspaceArgs(template: string, templateParameters: string[], workspace: string): string[] {
  const args = ["create", "--template", template, "--yes", "--use-parameter-defaults"];
  for (const parameter of templateParameters) {
    args.push("--parameter", parameter);
  }
  args.push(workspace);
  return args;
}

function safeCoderWorkspace(value: string): string {
  const workspace = value.trim();
  if (!workspace) {
    throw new Error("coder executor workspace is required");
  }
  if (workspace.startsWith("-") || hasUnsafeCoderIdentifierChar(workspace)) {
    throw new Error(`workspace is not safe: ${value}`);
  }
  return workspace;
}

function safeCoderTemplate(value: string | undefined): string | undefined {
  const template = value?.trim();
  if (!template) return undefined;
  if (template.startsWith("-") || hasUnsafeCoderIdentifierChar(template)) {
    throw new Error(`template is not safe: ${value}`);
  }
  return template;
}

function hasUnsafeCoderIdentifierChar(value: string): boolean {
  return /[\s\x00-\x1F\x7F]/.test(value);
}

function safeGitRepo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const repo = value.trim();
  if (!repo) return undefined;
  if (repo.includes("\0") || repo.startsWith("-")) {
    throw new Error(`repo is not safe: ${value}`);
  }
  // Reject git transport-helper syntax ("ext::<cmd>", "fd::...") and file:
  // transports. These are not shell-metacharacter injection (shellQuote handles
  // that) — git itself would execute the helper command. GIT_ALLOW_PROTOCOL
  // (see syncCommand/worktreeCommand) is the enforcing layer; this is an
  // earlier, clearer rejection. "scheme://" and scp-like "git@host:path" pass.
  if (/^[a-z][a-z0-9+.-]*::/i.test(repo) || /^file:/i.test(repo)) {
    throw new Error(`repo transport is not allowed: ${value}`);
  }
  return repo;
}

function mkdirCommand(paths: string[]): string {
  return `mkdir -p ${[...new Set(paths)].map(shellQuote).join(" ")}`;
}

function normalizeRemotePath(path: string, field: string): string {
  if (!path.trim() || !path.startsWith("/")) {
    throw new Error(`coder executor ${field} must be an absolute path`);
  }
  if (path.includes("\0")) {
    throw new Error(`coder executor ${field} contains an invalid NUL byte`);
  }
  const normalized = posix.normalize(path);
  if (normalized === "/") {
    throw new Error(`coder executor ${field} must not be the filesystem root`);
  }
  return normalized;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
