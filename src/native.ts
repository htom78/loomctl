import { execa } from "execa";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoomConfig } from "./config.js";
import { giteaIssueUrl, parseGiteaIssueRef } from "./harness/gitea.js";
import { safeGitRef } from "./harness/git-ref.js";

export interface RunGoalOpts {
  project: string;
  /** The verifiable stop condition handed to the native /goal. */
  condition: string;
  /** Task worktree id; native --resume keys off cwd, so this namespaces the session. */
  worktree: string;
  /** Optional Gitea/Forgejo issue linked to this native goal run. */
  issue?: string;
  /** Skills active in this native goal run; forwarded to Stop-hook brain signals. */
  skills?: string[];
  modelTier?: "default" | "reasoning" | "cheap";
}

type NativeGoalSessionMode = "cold_start" | "resume_by_cwd";

interface NativeGoalWorkspace {
  project: string;
  worktree: string;
  branch: string;
  cwd: string;
  sessionMode: NativeGoalSessionMode;
}

interface NativeGoalContext {
  schemaVersion: 1;
  project: string;
  runId: string;
  worktree: string;
  branch: string;
  cwd: string;
  engine: LoomConfig["engine"];
  condition: string;
  issue?: string;
  issueUrl?: string;
  skills: string[];
  modelTier: "default" | "reasoning" | "cheap";
  model: string;
  sessionMode: NativeGoalSessionMode;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  status: "running" | "passed" | "failed";
}

/**
 * Run a NATIVE /goal. This DELEGATES the loop to Claude Code / Codex —
 * it does not reimplement worktrees, sub-agents, resume, or the checker.
 * We only:
 *   1) point the model endpoint at the central gateway (compliant + central billing),
 *   2) set cwd to the project's worktree (persistent workspace → native --resume works),
 *   3) hand the verifiable stop condition to the native /goal.
 */
export async function runGoal(cfg: LoomConfig, o: RunGoalOpts): Promise<number> {
  const issue = nativeGoalIssue(cfg, o.issue);
  const workspace = await prepareNativeGoalWorkspace(cfg, o);
  const cwd = workspace.cwd;
  const model = cfg.models[o.modelTier ?? "default"] ?? cfg.models.default;
  const contextPath = nativeGoalContextPath(cwd);
  const context = await writeNativeGoalContext(contextPath, cfg, o, workspace, model, issue);
  const skillsText = context.skills.join("\n");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // LiteLLM exposes an Anthropic-compatible surface; the native CLI talks to it as if it were Anthropic.
    ANTHROPIC_BASE_URL: cfg.gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: process.env[cfg.gatewayKeyEnv] ?? "",
    ANTHROPIC_MODEL: model,
    LOOM_NATIVE_GOAL_CONTEXT: contextPath,
    LOOM_RUN_ID: context.runId,
    LOOM_RUN_DIR: cwd,
    ...(skillsText ? { LOOM_NATIVE_GOAL_SKILLS: skillsText, LOOM_SKILLS: skillsText } : {}),
    ...(issue.issue ? { LOOM_NATIVE_GOAL_ISSUE: issue.issue, LOOM_ISSUE: issue.issue } : {}),
    ...(issue.issueUrl ? { LOOM_NATIVE_GOAL_ISSUE_URL: issue.issueUrl, LOOM_ISSUE_URL: issue.issueUrl } : {}),
  };

  // SEAM: the exact way to launch headless goal mode depends on your installed CLI version.
  // The shape is fixed: run the native goal loop in `cwd` until `condition` holds.
  const { bin, args } = buildInvocation(cfg.engine, o.condition);

  const child = execa(bin, args, { cwd, env, stdio: "inherit", reject: false });
  const { exitCode } = await child;
  const code = exitCode ?? 1;
  await writeNativeGoalContextResult(contextPath, context, code);
  return code;
}

export async function prepareNativeGoalCwd(cfg: LoomConfig, o: Pick<RunGoalOpts, "project" | "worktree">): Promise<string> {
  return (await prepareNativeGoalWorkspace(cfg, o)).cwd;
}

async function prepareNativeGoalWorkspace(cfg: LoomConfig, o: Pick<RunGoalOpts, "project" | "worktree">): Promise<NativeGoalWorkspace> {
  const project = safeNativeProject(o.project);
  const worktree = safeNativeWorktree(o.worktree);
  const branch = safeGitRef(`loom/${worktree}`, "native goal worktree");
  const projectRoot = join(cfg.workspaceRoot, project);
  await assertDirectory(projectRoot, `native goal project not found: ${project}`);

  const cwd = join(projectRoot, ".wt", worktree);
  const existing = await directoryStatus(cwd);
  if (existing === "file") {
    throw new Error(`native goal worktree path is not a directory: ${cwd}`);
  }
  if (existing === "directory") {
    return { project, worktree, branch, cwd, sessionMode: "resume_by_cwd" };
  }

  await mkdir(join(projectRoot, ".wt"), { recursive: true });
  if (await isGitRepository(projectRoot)) {
    await execa("git", ["worktree", "add", "-B", branch, cwd, "HEAD"], { cwd: projectRoot });
  } else {
    await mkdir(cwd, { recursive: true });
  }
  return { project, worktree, branch, cwd, sessionMode: "cold_start" };
}

function nativeGoalContextPath(cwd: string): string {
  return join(cwd, ".loom", "native-goal.json");
}

async function writeNativeGoalContext(
  path: string,
  cfg: LoomConfig,
  opts: RunGoalOpts,
  workspace: NativeGoalWorkspace,
  model: string,
  issue: { issue?: string; issueUrl?: string },
): Promise<NativeGoalContext> {
  const previous = await readNativeGoalContext(path);
  const now = new Date().toISOString();
  const context: NativeGoalContext = {
    schemaVersion: 1,
    project: workspace.project,
    runId: makeNativeRunId(),
    worktree: workspace.worktree,
    branch: workspace.branch,
    cwd: workspace.cwd,
    engine: cfg.engine,
    condition: opts.condition,
    issue: issue.issue,
    issueUrl: issue.issueUrl,
    skills: nativeGoalSkills(opts.skills),
    modelTier: opts.modelTier ?? "default",
    model,
    sessionMode: workspace.sessionMode,
    attempt: typeof previous?.attempt === "number" ? previous.attempt + 1 : 1,
    createdAt: typeof previous?.createdAt === "string" ? previous.createdAt : now,
    updatedAt: now,
    startedAt: now,
    status: "running",
  };
  await mkdir(join(workspace.cwd, ".loom"), { recursive: true });
  await writeFile(path, JSON.stringify(context, null, 2) + "\n", "utf8");
  return context;
}

function nativeGoalIssue(cfg: LoomConfig, value: string | undefined): { issue?: string; issueUrl?: string } {
  const issue = value?.trim();
  if (!issue) return {};
  parseGiteaIssueRef(issue);
  return { issue, issueUrl: giteaIssueUrl(cfg.giteaUrl, issue) };
}

function nativeGoalSkills(value: string[] | undefined): string[] {
  return value?.map((skill) => skill.trim()).filter(Boolean) ?? [];
}

function makeNativeRunId(): string {
  return `native-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
}

async function writeNativeGoalContextResult(path: string, context: NativeGoalContext, exitCode: number): Promise<void> {
  const endedAt = new Date().toISOString();
  await writeFile(path, JSON.stringify({
    ...context,
    updatedAt: endedAt,
    endedAt,
    exitCode,
    status: exitCode === 0 ? "passed" : "failed",
  }, null, 2) + "\n", "utf8");
}

async function readNativeGoalContext(path: string): Promise<Partial<NativeGoalContext> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Partial<NativeGoalContext>
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function buildInvocation(engine: LoomConfig["engine"], condition: string): { bin: string; args: string[] } {
  if (engine === "codex") {
    return { bin: "codex", args: ["goal", condition] };
  }
  // Claude Code: drive /goal until the verifiable condition holds.
  return {
    bin: "claude",
    args: ["--permission-mode", "bypassPermissions", "-p", `/goal ${JSON.stringify(condition)}`],
  };
}

function safeNativeProject(value: string): string {
  const project = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(project) || project === "." || project === "..") {
    throw new Error(`native goal project name is not safe: ${value}`);
  }
  return project;
}

function safeNativeWorktree(value: string): string {
  const worktree = value
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .replace(/^-+/, "")
    .replace(/^\.+/, "");
  return worktree || "main";
}

async function assertDirectory(path: string, message: string): Promise<void> {
  const status = await directoryStatus(path);
  if (status !== "directory") throw new Error(message);
}

async function directoryStatus(path: string): Promise<"directory" | "file" | "missing"> {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function isGitRepository(cwd: string): Promise<boolean> {
  const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd, reject: false });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}
