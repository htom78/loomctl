import type { CommandResult, WorkspaceExecutor } from "./executor.js";

export interface WorkspaceGitCommitResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  commit?: string;
  noChanges?: true;
}

const workspaceCommitPathspecArgs = "-- . ':(exclude).loom'";

export function workspaceGitCommitCommand(message: string): string {
  return `${gitAddWorkspaceCommand()} && ${gitUnstageLoomCommand()} && ${gitCommitWorkspaceCommand(message)}`;
}

export async function createWorkspaceGitCommit(
  executor: WorkspaceExecutor,
  message: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WorkspaceGitCommitResult> {
  const command = workspaceGitCommitCommand(message);
  const add = await executor.runCommand(gitAddWorkspaceCommand(), timeoutMs, signal);
  if (add.exitCode !== 0) return commandResult(command, add);

  const unstageLoom = await executor.runCommand(gitUnstageLoomCommand(), timeoutMs, signal);
  if (unstageLoom.exitCode !== 0) return commandResult(command, unstageLoom);

  const staged = await executor.runCommand(gitDiffCachedWorkspaceCommand(), timeoutMs, signal);
  if (staged.exitCode === 0) {
    return { command, stdout: "no workspace changes to commit\n", stderr: "", exitCode: 1, noChanges: true };
  }
  if (staged.exitCode !== 1) return commandResult(command, staged);

  const commit = await executor.runCommand(gitCommitWorkspaceCommand(message), timeoutMs, signal);
  if (commit.exitCode !== 0) return commandResult(command, commit);

  const head = await executor.runCommand("git rev-parse --short HEAD", timeoutMs, signal);
  return {
    command,
    stdout: commit.stdout,
    stderr: [commit.stderr, head.stderr].filter(Boolean).join("\n"),
    exitCode: head.exitCode === 0 ? 0 : head.exitCode,
    commit: head.exitCode === 0 ? firstToken(head.stdout) : undefined,
  };
}

function gitAddWorkspaceCommand(): string {
  return `git add -A ${workspaceCommitPathspecArgs}`;
}

function gitDiffCachedWorkspaceCommand(): string {
  return `git diff --cached --quiet ${workspaceCommitPathspecArgs}`;
}

function gitUnstageLoomCommand(): string {
  return `(git reset -q -- .loom 2>/dev/null || true)`;
}

function gitCommitWorkspaceCommand(message: string): string {
  return `git commit --only -m ${shellQuote(message)} ${workspaceCommitPathspecArgs}`;
}

function commandResult(command: string, result: CommandResult): WorkspaceGitCommitResult {
  return {
    command,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

function firstToken(value: string): string | undefined {
  const token = value.trim().split(/\s+/)[0];
  return token || undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
