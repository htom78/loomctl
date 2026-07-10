import type { ToolAction, ToolObservation, VerificationResult } from "./events.js";
import { createLocalExecutor, type CommandResult, type WorkspaceExecutionOptions, type WorkspaceExecutor } from "./executor.js";
import { WORKSPACE_GIT_DIFF_PATCH_COMMAND, WORKSPACE_GIT_DIFF_STAT_COMMAND } from "./git-diff.js";
import { createWorkspaceGitCommit } from "./git-commit.js";

export interface ToolRuntimeOptions {
  cwd: string;
  verifyCommands: string[];
  timeoutMs?: number;
  allowedTools?: string[];
  executor?: WorkspaceExecutor;
  executionEnv?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ToolRuntime {
  execute(action: ToolAction & { id: string }): Promise<ToolObservation>;
}

export const SUPPORTED_ACTION_TOOLS = ["file.read", "file.write", "shell.exec", "git.diff", "git.commit", "verify.run"];
const TOOL_FILE_READ_LIMIT_BYTES = 256 * 1024;

export function effectiveAllowedTools(allowedTools?: string[]): string[] {
  return allowedTools === undefined ? [...SUPPORTED_ACTION_TOOLS] : [...allowedTools];
}

export function createToolRuntime(options: ToolRuntimeOptions): ToolRuntime {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const executor = options.executor ?? createLocalExecutor({ cwd: options.cwd });
  const allowedTools = effectiveAllowedTools(options.allowedTools);
  const execution = options.executionEnv ? { env: options.executionEnv } : undefined;

  return {
    async execute(action: ToolAction & { id: string }): Promise<ToolObservation> {
      try {
        throwIfAborted(options.signal);
        if (!isToolAllowed(action.toolName, allowedTools)) {
          return observation(action, false, "", 1, `tool not allowed: ${action.toolName}`);
        }

        if (action.toolName === "file.read") {
          const maxBytes = boundedFileReadBytes(action.input.maxBytes);
          const path = String(action.input.path ?? "");
          rejectReservedWorkspacePath(path);
          const content = await executor.readFile(path, maxBytes);
          return observation(action, true, content, 0);
        }

        if (action.toolName === "file.write") {
          const path = String(action.input.path ?? "");
          const content = String(action.input.content ?? "");
          rejectReservedWorkspacePath(path);
          await executor.writeFile(path, content);
          return observation(action, true, `wrote ${executor.describePath?.(path) ?? path}`, 0);
        }

        if (action.toolName === "shell.exec") {
          const command = String(action.input.command ?? "");
          if (!command.trim()) {
            return observation(action, false, "", 1, "shell.exec requires input.command");
          }
          return runShell(action, executor, command, timeoutMs, options.signal, execution);
        }

        if (action.toolName === "git.diff") {
          const stat = await executor.runCommand(WORKSPACE_GIT_DIFF_STAT_COMMAND, timeoutMs, options.signal, execution);
          const diff = await executor.runCommand(WORKSPACE_GIT_DIFF_PATCH_COMMAND, timeoutMs, options.signal, execution);
          return observation(
            action,
            stat.exitCode === 0 && diff.exitCode === 0,
            [stat.stdout, diff.stdout].filter(Boolean).join("\n\n"),
            diff.exitCode || stat.exitCode,
            stat.stderr || diff.stderr,
          );
        }

        if (action.toolName === "git.commit") {
          const message = gitCommitMessage(action.input.message);
          const result = await createWorkspaceGitCommit(executor, message, timeoutMs, options.signal);
          const output = [result.stdout, result.commit ? `commit ${result.commit}` : ""].filter(Boolean).join("\n");
          return observation(
            action,
            result.exitCode === 0,
            output,
            result.exitCode,
            result.noChanges ? "no workspace changes to commit" : result.stderr,
          );
        }

        if (action.toolName === "verify.run") {
          const result = await runVerification(executor, options.verifyCommands, action.input.command, timeoutMs, options.signal, execution);
          return {
            actionId: action.id,
            toolName: action.toolName,
            ok: result.ok,
            output: result.output,
            exitCode: result.exitCode,
            error: result.ok ? undefined : result.output,
          };
        }

        return observation(action, false, "", 1, `unknown tool: ${action.toolName}`);
      } catch (error) {
        if (options.signal?.aborted) throw cancelledError(options.signal);
        const message = error instanceof Error ? error.message : String(error);
        return observation(action, false, "", 1, message);
      }
    },
  };
}

function isToolAllowed(toolName: string, allowedTools: string[]): boolean {
  return allowedTools.includes(toolName);
}

function gitCommitMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("git.commit requires input.message");
  }
  const message = value.trim();
  if (message.length > 200 || /[\0\r\n]/.test(message)) {
    throw new Error("git.commit input.message must be a single-line string at most 200 characters.");
  }
  return message;
}

function rejectReservedWorkspacePath(path: string): void {
  const parts = path.replaceAll("\\", "/").trim().split("/");
  if (parts.includes(".loom")) {
    throw new Error("path is reserved for Loom internals");
  }
}

function boundedFileReadBytes(value: unknown): number {
  if (value === undefined) return 65_536;
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return 65_536;
  return Math.min(TOOL_FILE_READ_LIMIT_BYTES, Math.max(0, Math.trunc(bytes)));
}

export async function runVerification(
  executor: WorkspaceExecutor,
  configuredCommands: string[],
  overrideCommand?: unknown,
  timeoutMs = 120_000,
  signal?: AbortSignal,
  execution?: WorkspaceExecutionOptions,
): Promise<VerificationResult> {
  throwIfAborted(signal);
  const commands = typeof overrideCommand === "string" && overrideCommand.trim() ? [overrideCommand] : configuredCommands;
  if (commands.length === 0) {
    return { ok: true, output: "No verification commands configured.", exitCode: 0, commands: [] };
  }

  const outputs: string[] = [];
  for (const command of commands) {
    throwIfAborted(signal);
    const result = await executor.runCommand(command, timeoutMs, signal, execution);
    outputs.push(formatCommandOutput(command, result));
    if (result.exitCode !== 0) {
      return {
        ok: false,
        output: outputs.join("\n"),
        exitCode: result.exitCode,
        commands,
      };
    }
  }

  return {
    ok: true,
    output: outputs.join("\n"),
    exitCode: 0,
    commands,
  };
}

async function runShell(
  action: ToolAction & { id: string },
  executor: WorkspaceExecutor,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
  execution?: WorkspaceExecutionOptions,
): Promise<ToolObservation> {
  const result = await executor.runCommand(command, timeoutMs, signal, execution);
  return observation(action, result.exitCode === 0, result.stdout, result.exitCode, result.stderr);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError(signal);
}

function cancelledError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" && reason.trim() ? reason : "run cancelled");
}

function observation(
  action: ToolAction & { id: string },
  ok: boolean,
  output: string,
  exitCode: number,
  error?: string,
): ToolObservation {
  return {
    actionId: action.id,
    toolName: action.toolName,
    ok,
    output,
    exitCode,
    error: error || undefined,
  };
}

function formatCommandOutput(command: string, result: CommandResult): string {
  return [
    `$ ${command}`,
    `exitCode=${result.exitCode}`,
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
