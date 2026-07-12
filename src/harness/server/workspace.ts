import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { join, posix, resolve } from "node:path";
import { type TenantAuditAppender, type TenantRole } from "../audit.js";
import { appendRunEvent } from "../run-store.js";
import type { DeploymentGate, ReviewGate, RunRequesterSummary, RunSummary } from "../events.js";
import { formatRunRequesterSummary, parseGiteaIssueRef } from "../gitea.js";
import { readAgentGitServiceProjectProvisioningReceipt } from "../agent-git-service-provisioning.js";
import { WORKSPACE_GIT_DIFF_COMMAND } from "../git-diff.js";
import { createWorkspaceGitCommit } from "../git-commit.js";
import { createLocalExecutor, type CommandResult, type WorkspaceExecutor, type WorkspaceExecutionOptions, type WorkspaceDescription, type WorkspaceFileEntry, type WorkspacePathInfo, type WorkspaceSession } from "../executor.js";
import { WorkspaceSessionAdmissionClaimHandle, tryAcquireWorkspaceSessionAdmissionClaims, startWorkspaceSessionAdmissionClaimHeartbeat, workspaceSessionHasActiveAdmissionClaim } from "./admission.js";
import { RunEventContext, QueuedRun, ActiveRunSlot, RunChangedFileHint, RunPresenceEntry, RunPresenceRegistry, isSafePersistedRunState, listPersistedRunDirs, readRunState, findBlockingPersistedRunningRun, runEventContext, runRequester, publicRunRequester, runEvidenceUrl, writeRunSummary, writeRunStatus, readRunStateForScan, refreshRunPresenceFromDisk, purgeExpiredRunPresence, runPresenceEntries } from "./runs.js";
import { reportAgentGitServiceWorkspaceHandoffAttachment } from "./gates.js";
import { controlPlaneIssueUrl } from "./status.js";
import { ProjectSummary, projectWorkspaceSessionRoot, projectWorkspaceCommandRoot, readTenantProjectSummariesWithActivity, requireProjectExists, ProjectSourceDefaultValues, readProjectSourceDefaults, readAgentGitServiceAgentTokenSecret, projectWorkspaceContext, listTenantProjectNames, isProjectDirectoryName, refreshProjectPresenceFromDisk, projectPresenceEntries } from "./projects.js";
import { TenantExecutorLimits, TenantAccess, effectiveTenantExecutorLimits, effectiveTenantExecutorTemplateParameters, requireTenantTool, readTenantPolicy, requireTenantAccess, isSafeTenantDirectoryName } from "./tenants.js";
import { HarnessServerOptions, PullRequestReporterResult, WorkspacePullRequestRequest, RunWorkspaceIsolation, HarnessWorkspaceContext } from "./types.js";
import { markdownInlineCode, optionalSessionEventString, optionalSessionEventNumber, optionalSessionEventRole, hasRequestValue, compactObject, compactMetadata, seqAfter, recordData, stringField, requireSafeName, optionalSafeName, requireString, optionalString, optionalClientId, isSafeDirectoryName, booleanFlag, positiveIntValue, badRequest, payloadTooLarge, conflict, notFound, writeJson, isNotFound, startedAt, readJsonBody, workspacePullRequestRef } from "./shared.js";

async function readWorkspaceFileJson(req: IncomingMessage): Promise<WorkspaceFileWriteRequestBody> {
  return readJsonBody<WorkspaceFileWriteRequestBody>(req);
}

async function readWorkspaceFileMoveJson(req: IncomingMessage): Promise<WorkspaceFileMoveRequestBody> {
  return readJsonBody<WorkspaceFileMoveRequestBody>(req);
}

async function readWorkspaceCommandJson(req: IncomingMessage): Promise<WorkspaceCommandRequestBody> {
  return readJsonBody<WorkspaceCommandRequestBody>(req);
}

async function readWorkspaceCommitJson(req: IncomingMessage): Promise<WorkspaceCommitRequestBody> {
  return readJsonBody<WorkspaceCommitRequestBody>(req);
}

async function readWorkspacePullRequestJson(req: IncomingMessage): Promise<WorkspacePullRequestRequestBody> {
  return readJsonBody<WorkspacePullRequestRequestBody>(req);
}

async function readWorkspaceSessionJson(req: IncomingMessage): Promise<WorkspaceSessionRequestBody> {
  return readJsonBody<WorkspaceSessionRequestBody>(req);
}

async function readWorkspaceSessionInputJson(req: IncomingMessage): Promise<WorkspaceSessionInputRequestBody> {
  return readJsonBody<WorkspaceSessionInputRequestBody>(req);
}

async function readWorkspaceClientJson(req: IncomingMessage): Promise<WorkspaceClientRequestBody> {
  return readJsonBody<WorkspaceClientRequestBody>(req);
}

interface WorkspaceFileWriteRequestBody {
  path?: unknown;
  content?: unknown;
  baseUpdatedAt?: unknown;
  clientId?: unknown;
}

interface WorkspaceFileMoveRequestBody {
  fromPath?: unknown;
  toPath?: unknown;
  baseUpdatedAt?: unknown;
  clientId?: unknown;
}

interface WorkspaceCommandRequestBody {
  command?: unknown;
  timeoutMs?: unknown;
  clientId?: unknown;
}

interface WorkspaceCommitRequestBody {
  message?: unknown;
  clientId?: unknown;
}

interface WorkspacePullRequestRequestBody {
  issue?: unknown;
  branch?: unknown;
  baseBranch?: unknown;
  title?: unknown;
  body?: unknown;
  commit?: unknown;
  push?: unknown;
  reviewRequired?: unknown;
  deploymentRequired?: unknown;
  clientId?: unknown;
}

interface WorkspaceSessionRequestBody {
  command?: unknown;
  clientId?: unknown;
}

interface WorkspaceSessionInputRequestBody {
  input?: unknown;
  clientId?: unknown;
}

interface WorkspaceClientRequestBody {
  baseUpdatedAt?: unknown;
  clientId?: unknown;
}

interface ActiveWorkspaceSession {
  sessionId: string;
  route: { kind: "project" } | { kind: "run"; runId: string };
  context: HarnessWorkspaceContext;
  command: string;
  session: WorkspaceSession;
  sessionDir: string;
  summary: WorkspaceSessionSummary;
  events: WorkspaceSessionEvent[];
  cleanup: Array<() => void>;
  admissionClaim: WorkspaceSessionAdmissionClaimHandle;
  admissionHeartbeat: () => void;
  status: "running" | "exited";
  workspaceKey: string;
  persistQueue: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

interface WorkspaceSessionEvent {
  seq: number;
  ts: string;
  type: "start" | "input" | "stop" | "stdout" | "stderr" | "exit";
  data?: string;
  dataBytes?: number;
  dataTruncated?: true;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  exitCode?: number;
  signal?: string;
}

interface WorkspaceSessionSummary {
  sessionId: string;
  tenant: string;
  project: string;
  runId?: string;
  route: "project" | "run";
  command: string;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  status: "running" | "exited" | "orphaned";
  startedAt: string;
  lastActivityAt: string;
  idleExpiresAt?: string;
  endedAt?: string;
  eventCount: number;
  exitCode?: number;
  signal?: string;
}

interface WorkspaceCommandSummary extends WorkspaceCommandResponse {
  commandId: string;
  tenant: string;
  project: string;
  runId?: string;
  route: "project" | "run";
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  startedAt: string;
  endedAt: string;
}

interface TenantWorkspaceUsageWarningListResponse {
  tenant: string;
  projects: ProjectSummary[];
}

type WorkspaceFileResponse =
  | {
      path: string;
      kind: "directory";
      entries: WorkspaceFileEntry[];
    }
  | {
      path: string;
      kind: "file";
      size: number;
      updatedAt: string;
      content: string;
      previousPath?: string;
    };

interface WorkspaceCommandResponse {
  command: string;
  stdout: string;
  stdoutBytes?: number;
  stdoutTruncated?: true;
  stderr: string;
  stderrBytes?: number;
  stderrTruncated?: true;
  exitCode: number;
}

interface WorkspaceCommitResponse extends WorkspaceCommandResponse {
  message: string;
  commit?: string;
  noChanges?: true;
}

interface WorkspacePullRequestResponse {
  tenant: string;
  project: string;
  runId?: string;
  issue: string;
  issueUrl?: string;
  branch: string;
  baseBranch?: string;
  title: string;
  commit?: string;
  push: boolean;
  pullRequestIndex?: number;
  pullRequestUrl?: string;
  reviewRequired?: boolean;
  deploymentRequired?: boolean;
  status?: RunSummary["status"];
}

interface WorkspaceInfo {
  tenant: string;
  project: string;
  runId?: string;
  route: "project" | "run";
  cwd: string;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  issue?: string;
  executorLimits?: TenantExecutorLimits;
  executorTemplateParameters?: string[];
  executor?: WorkspaceDescription;
  workspaceBytes?: number;
  workspaceByteLimit?: number;
}

type WorkspaceCommandRoute = { kind: "project" } | { kind: "run"; runId: string };

const WORKSPACE_FILE_READ_LIMIT_BYTES = 256 * 1024;
const WORKSPACE_FILE_WRITE_LIMIT_BYTES = 256 * 1024;
const WORKSPACE_OUTPUT_LIMIT_BYTES = 64 * 1024;
const WORKSPACE_SESSION_INPUT_LIMIT_BYTES = 64 * 1024;
const WORKSPACE_USAGE_COMMAND = "find . -path './.loom' -prune -o -type f -exec sh -c 'for path do wc -c < \"$path\"; done' sh {} + | awk '{ total += $1 } END { print total + 0 }'";
const WORKSPACE_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_WORKSPACE_SESSIONS = 32;
const DEFAULT_WORKSPACE_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function boundedWorkspaceOutput(value: string): { value: string; bytes: number; truncated?: true } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= WORKSPACE_OUTPUT_LIMIT_BYTES) {
    return { value, bytes: buffer.length };
  }

  let end = WORKSPACE_OUTPUT_LIMIT_BYTES;
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }

  return {
    value: buffer.subarray(0, end).toString("utf8"),
    bytes: buffer.length,
    truncated: true,
  };
}

function workspaceSessionLimit(options: HarnessServerOptions): number {
  return options.maxWorkspaceSessions ?? DEFAULT_MAX_WORKSPACE_SESSIONS;
}

function tenantWorkspaceSessionLimit(options: HarnessServerOptions): number {
  return options.maxTenantWorkspaceSessions ?? workspaceSessionLimit(options);
}

async function effectiveTenantWorkspaceSessionLimit(options: HarnessServerOptions, tenant: string): Promise<number> {
  const policy = await readTenantPolicy(resolve(options.workspaceRoot), tenant, options);
  return policy?.limits?.maxWorkspaceSessions ?? tenantWorkspaceSessionLimit(options);
}

async function effectiveTenantWorkspaceByteLimit(options: HarnessServerOptions, tenant: string): Promise<number | undefined> {
  return (await readTenantPolicy(resolve(options.workspaceRoot), tenant, options))?.limits?.maxWorkspaceBytes;
}

function workspaceCommandTimeoutMs(options: HarnessServerOptions): number {
  return options.workspaceCommandTimeoutMs ?? WORKSPACE_COMMAND_TIMEOUT_MS;
}

function workspaceSessionIdleTimeoutMs(options: HarnessServerOptions): number {
  return options.workspaceSessionIdleTimeoutMs ?? DEFAULT_WORKSPACE_SESSION_IDLE_TIMEOUT_MS;
}

function activeWorkspaceSessionCount(activeSessions: Map<string, ActiveWorkspaceSession>): number {
  return [...activeSessions.values()].filter((session) => session.status === "running").length;
}

function activeTenantWorkspaceSessionCount(activeSessions: Map<string, ActiveWorkspaceSession>, tenant: string): number {
  return [...activeSessions.values()].filter((session) => session.status === "running" && session.context.tenant === tenant).length;
}

async function workspaceDirectoryUsageBytes(root: string): Promise<number> {
  try {
    return await workspaceDirectoryUsageBytesAt(root);
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
}

async function workspaceDirectoryUsageBytesAt(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.name === ".loom") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await workspaceDirectoryUsageBytesAt(path);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += (await stat(path)).size;
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
  }
  return total;
}

function activeWorkspaceSessionDetails(activeSessions: Map<string, ActiveWorkspaceSession>, tenant?: string): WorkspaceSessionSummary[] {
  return [...activeSessions.values()]
    .filter((session) => session.status === "running" && (tenant === undefined || session.context.tenant === tenant))
    .map((session) => compactWorkspaceSessionSummary({ ...session.summary, status: session.status }))
    .sort((a, b) =>
      a.tenant.localeCompare(b.tenant)
      || a.project.localeCompare(b.project)
      || (a.runId ?? "").localeCompare(b.runId ?? "")
      || a.startedAt.localeCompare(b.startedAt)
      || a.sessionId.localeCompare(b.sessionId)
    );
}

async function statusActiveWorkspaceSessionDetails(
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  tenantFilter?: string,
): Promise<WorkspaceSessionSummary[]> {
  const details: WorkspaceSessionSummary[] = [];
  const tenants = tenantFilter ? [tenantFilter] : await listWorkspaceTenantNames(workspaceRoot);
  for (const tenant of tenants) {
    const projects = await listTenantProjectNames(workspaceRoot, tenant);
    for (const project of projects) {
      details.push(...(await readWorkspaceSessionSummaries(
        projectWorkspaceSessionRoot(workspaceRoot, tenant, project),
        activeSessions,
        { route: "project", tenant, project },
        options,
      )).filter((session) => session.status === "running"));
    }
  }

  const runDirs = await listPersistedRunDirs(workspaceRoot, tenantFilter);
  for (const runDir of runDirs) {
    const state = await readRunStateForScan(runDir);
    if (!state || !isSafePersistedRunState(state)) continue;
    const data = recordData(state);
    const tenant = stringField(data, "tenant") ?? "";
    const project = stringField(data, "project") ?? "";
    const runId = stringField(data, "runId") ?? "";
    details.push(...(await readWorkspaceSessionSummaries(
      runWorkspaceSessionRoot(workspaceRoot, tenant, project, runId),
      activeSessions,
      { route: "run", tenant, project, runId },
      options,
    )).filter((session) => session.status === "running"));
  }

  return details.sort((a, b) =>
    a.tenant.localeCompare(b.tenant)
    || a.project.localeCompare(b.project)
    || (a.runId ?? "").localeCompare(b.runId ?? "")
    || a.startedAt.localeCompare(b.startedAt)
    || a.sessionId.localeCompare(b.sessionId)
  );
}

async function handleRunWorkspaceCommand(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "commands") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const project = requireSafeName(segments[3], "project");
  await requireTenantTool(options, tenant, "shell.exec", "workspace commands require shell.exec to be allowed by the server.");
  await requireProjectExists(workspaceRoot, tenant, project);

  await runWorkspaceCommand(
    req,
    res,
    projectWorkspaceContext(workspaceRoot, tenant, project, "manual-command"),
    { kind: "project" },
    projectWorkspaceCommandRoot(workspaceRoot, tenant, project),
    options,
    activeWorkspaces,
    appendAuditEvent,
    access,
  );
  return true;
}

async function handleRunScopedWorkspaceCommand(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "commands") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const runId = requireSafeName(segments[3], "runId");
  await requireTenantTool(options, tenant, "shell.exec", "workspace commands require shell.exec to be allowed by the server.");

  try {
    const context = await runWorkspaceContext(url, workspaceRoot, tenant, runId, options);
    await runWorkspaceCommand(
      req,
      res,
      context,
      { kind: "run", runId },
      runWorkspaceCommandRoot(workspaceRoot, tenant, context.project, runId),
      options,
      activeWorkspaces,
      appendAuditEvent,
      access,
    );
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function runWorkspaceCommand(
  req: IncomingMessage,
  res: ServerResponse,
  context: HarnessWorkspaceContext,
  route: WorkspaceCommandRoute,
  commandRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
  access: TenantAccess | undefined,
): Promise<void> {
  const body = await readWorkspaceCommandJson(req);
  const command = requireString(body.command, "command");
  const clientId = optionalClientId(body.clientId);
  const maxTimeoutMs = workspaceCommandTimeoutMs(options);
  const timeoutMs = body.timeoutMs === undefined
    ? maxTimeoutMs
    : positiveIntValue(body.timeoutMs, "timeoutMs");
  if (timeoutMs > maxTimeoutMs) {
    throw badRequest(`timeoutMs exceeds server maximum of ${maxTimeoutMs}ms.`);
  }
  const workspaceKey = workspaceRouteKey(options, context, route);
  const activeRunId = activeWorkspaces.get(workspaceKey);
  if (activeRunId) {
    throw conflict(`tenant project already has an active run: ${activeRunId}`);
  }
  const persistedRunId = await findBlockingPersistedRunningRun(options, join(context.cwd, ".loom", "runs"));
  if (persistedRunId) {
    throw conflict(`tenant project already has an active run: ${persistedRunId}`);
  }
  activeWorkspaces.set(workspaceKey, context.runId);

  try {
    const commandId = randomUUID();
    const startedAt = new Date().toISOString();
    const executor = await preparedWorkspaceExecutor(context, options);
    await enforceWorkspaceBytesAvailable(context, options, executor);
    const result = await executor.runCommand(command, timeoutMs);
    const stdout = boundedWorkspaceOutput(result.stdout);
    const stderr = boundedWorkspaceOutput(result.stderr);
    const response: WorkspaceCommandSummary = compactWorkspaceCommandSummary({
      commandId,
      tenant: context.tenant,
      project: context.project,
      runId: route.kind === "run" ? route.runId : undefined,
      route: route.kind,
      actor: access?.actor,
      role: access?.role,
      clientId,
      command,
      stdout: stdout.value,
      stdoutBytes: stdout.bytes,
      stdoutTruncated: stdout.truncated,
      stderr: stderr.value,
      stderrBytes: stderr.bytes,
      stderrTruncated: stderr.truncated,
      exitCode: result.exitCode,
      startedAt,
      endedAt: new Date().toISOString(),
    });
    await writeWorkspaceCommandSummary(join(commandRoot, commandId), response);
    await appendAuditEvent(context.tenant, "workspace_command_ran", compactObject({
      project: context.project,
      runId: route.kind === "run" ? route.runId : undefined,
      commandId,
      command,
      exitCode: result.exitCode,
      clientId,
    }), access);
    writeJson(res, 200, response);
  } finally {
    activeWorkspaces.delete(workspaceKey);
  }
}

async function handleCreateWorkspaceCommit(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "commits") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  await requireTenantTool(options, tenant, "git.commit", "workspace commits require git.commit to be allowed by the server.");
  const project = requireSafeName(segments[3], "project");
  await requireProjectExists(workspaceRoot, tenant, project);
  await commitWorkspace(
    req,
    res,
    projectWorkspaceContext(workspaceRoot, tenant, project, "workspace-commit"),
    { kind: "project" },
    options,
    activeWorkspaces,
    appendAuditEvent,
    access,
  );
  return true;
}

async function handleCreateRunWorkspaceCommit(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "commits") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  await requireTenantTool(options, tenant, "git.commit", "workspace commits require git.commit to be allowed by the server.");
  const runId = requireSafeName(segments[3], "runId");
  try {
    await commitWorkspace(
      req,
      res,
      await runWorkspaceContext(url, workspaceRoot, tenant, runId, options),
      { kind: "run", runId },
      options,
      activeWorkspaces,
      appendAuditEvent,
      access,
    );
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function commitWorkspace(
  req: IncomingMessage,
  res: ServerResponse,
  context: HarnessWorkspaceContext,
  route: WorkspaceCommandRoute,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
  access: TenantAccess | undefined,
): Promise<void> {
  const body = await readWorkspaceCommitJson(req);
  const message = workspaceCommitMessage(body.message);
  const clientId = optionalClientId(body.clientId);
  const workspaceKey = workspaceRouteKey(options, context, route);
  const activeRunId = activeWorkspaces.get(workspaceKey);
  if (activeRunId) {
    throw conflict(`tenant project already has an active run: ${activeRunId}`);
  }
  const persistedRunId = await findBlockingPersistedRunningRun(options, join(context.cwd, ".loom", "runs"));
  if (persistedRunId) {
    throw conflict(`tenant project already has an active run: ${persistedRunId}`);
  }
  activeWorkspaces.set(workspaceKey, context.runId);

  try {
    const executor = await preparedWorkspaceExecutor(context, options);
    const result = await createWorkspaceGitCommit(executor, message, workspaceCommandTimeoutMs(options));
    const stdout = boundedWorkspaceOutput(result.stdout);
    const stderr = boundedWorkspaceOutput(result.stderr);
    const response: WorkspaceCommitResponse = compactObject({
      command: result.command,
      message,
      commit: result.commit,
      stdout: stdout.value,
      stdoutBytes: stdout.bytes,
      stdoutTruncated: stdout.truncated,
      stderr: stderr.value,
      stderrBytes: stderr.bytes,
      stderrTruncated: stderr.truncated,
      exitCode: result.exitCode,
      noChanges: result.noChanges,
    });

    if (result.noChanges) {
      writeJson(res, 400, { error: "no workspace changes to commit", ...response });
      return;
    }
    if (result.exitCode !== 0) {
      writeJson(res, 400, { error: "workspace commit failed", ...response });
      return;
    }

    await appendAuditEvent(context.tenant, "workspace_commit_created", compactObject({
      project: context.project,
      runId: route.kind === "run" ? route.runId : undefined,
      commit: result.commit,
      message,
      clientId,
    }), access);
    writeJson(res, 201, response);
  } finally {
    activeWorkspaces.delete(workspaceKey);
  }
}

async function handleCreateWorkspacePullRequest(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "pull-requests") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  await requireTenantTool(options, tenant, "git.pr", "workspace pull request handoffs require git.pr to be allowed by the server.");
  if (!options.workspacePullRequestReporter) {
    throw badRequest("workspace pull request handoffs require a pull request reporter.");
  }
  const project = requireSafeName(segments[3], "project");
  await requireProjectExists(workspaceRoot, tenant, project);
  const sourceDefaults = await readProjectSourceDefaults(join(workspaceRoot, tenant), project);
  await createWorkspacePullRequest(
    req,
    res,
    projectWorkspaceContext(workspaceRoot, tenant, project, "workspace-pr"),
    { kind: "project" },
    options,
    activeWorkspaces,
    appendAuditEvent,
    access,
    undefined,
    sourceDefaults,
  );
  return true;
}

async function handleCreateRunWorkspacePullRequest(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "pull-requests") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  await requireTenantTool(options, tenant, "git.pr", "workspace pull request handoffs require git.pr to be allowed by the server.");
  if (!options.workspacePullRequestReporter) {
    throw badRequest("workspace pull request handoffs require a pull request reporter.");
  }
  const runId = requireSafeName(segments[3], "runId");
  try {
    const context = await runWorkspaceContext(url, workspaceRoot, tenant, runId, options);
    const runDir = join(workspaceRoot, tenant, context.project, ".loom", "runs", runId);
    const state = await readRunState(runDir, options);
    if (state.status === "running") throw badRequest("cannot create a pull request for a running run.");
    if (state.status === "queued") throw badRequest("cannot create a pull request for a queued run.");
    const sourceDefaults = await readProjectSourceDefaults(join(workspaceRoot, tenant), context.project);
    await createWorkspacePullRequest(
      req,
      res,
      context,
      { kind: "run", runId },
      options,
      activeWorkspaces,
      appendAuditEvent,
      access,
      { summary: state, runDir },
      sourceDefaults,
    );
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function createWorkspacePullRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: HarnessWorkspaceContext,
  route: WorkspaceCommandRoute,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
  access: TenantAccess | undefined,
  run?: { summary: RunSummary; runDir: string },
  sourceDefaults: ProjectSourceDefaultValues = {},
): Promise<void> {
  const body = await readWorkspacePullRequestJson(req);
  const reviewRequired = booleanFlag(body.reviewRequired, "reviewRequired");
  const deploymentRequired = booleanFlag(body.deploymentRequired, "deploymentRequired");
  validateWorkspacePullRequestRun(run?.summary, reviewRequired, deploymentRequired);
  const issue = workspacePullRequestIssue(body.issue, run?.summary.metadata?.issue ?? sourceDefaults.issue);
  const issueUrl = workspacePullRequestIssueUrl(issue, options);
  const branchFallback = workspacePullRequestBranchFallback(body.branch, run?.summary.metadata?.branch ?? sourceDefaults.branch, route, options);
  const branch = requiredWorkspacePullRequestRef(body.branch, branchFallback, "branch");
  const baseBranch = workspacePullRequestRef(body.baseBranch, run?.summary.metadata?.baseBranch ?? sourceDefaults.baseBranch, "baseBranch", true);
  const clientId = optionalClientId(body.clientId);
  const push = body.push === undefined ? true : booleanFlag(body.push, "push");
  const title = workspacePullRequestTitle(body.title, run?.summary, context.project);
  const commitFromRequest = optionalWorkspacePullRequestCommit(body.commit);
  const workspaceKey = workspaceRouteKey(options, context, route);
  const activeRunId = activeWorkspaces.get(workspaceKey);
  if (activeRunId) {
    throw conflict(`tenant project already has an active run: ${activeRunId}`);
  }
  const persistedRunId = await findBlockingPersistedRunningRun(options, join(context.cwd, ".loom", "runs"));
  if (persistedRunId) {
    throw conflict(`tenant project already has an active run: ${persistedRunId}`);
  }
  activeWorkspaces.set(workspaceKey, context.runId);

  try {
    const executor = await preparedWorkspaceExecutor(context, options);
    const commit = commitFromRequest ?? await readWorkspaceHeadCommit(executor, options);
    const defaultBody = formatWorkspacePullRequestBody({
      tenant: context.tenant,
      project: context.project,
      runId: route.kind === "run" ? route.runId : undefined,
      requester: run?.summary.requester ?? publicRunRequester(runRequester(access, clientId)),
      issue,
      issueUrl,
      branch,
      baseBranch,
      commit,
      summary: run?.summary,
      reviewRequired,
      deploymentRequired,
    });
    const request: WorkspacePullRequestRequest = compactObject({
      tenant: context.tenant,
      project: context.project,
      runId: route.kind === "run" ? route.runId : undefined,
      issue,
      issueUrl,
      branch,
      baseBranch,
      title,
      body: workspacePullRequestBody(body.body, defaultBody),
      commit,
      push,
      actor: access?.actor,
      role: access?.role,
      clientId,
    });

    if (push) {
      const pushed = await pushWorkspaceBranch(executor, branch, options);
      if (pushed.exitCode !== 0) {
        const stdout = boundedWorkspaceOutput(pushed.stdout);
        const stderr = boundedWorkspaceOutput(pushed.stderr);
        writeJson(res, 400, {
          error: "workspace branch push failed",
          command: pushed.command,
          stdout: stdout.value,
          stdoutBytes: stdout.bytes,
          stdoutTruncated: stdout.truncated,
          stderr: stderr.value,
          stderrBytes: stderr.bytes,
          stderrTruncated: stderr.truncated,
          exitCode: pushed.exitCode,
        });
        return;
      }
    }

    let result: PullRequestReporterResult | void;
    try {
      result = await options.workspacePullRequestReporter?.(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw badRequest(`workspace pull request reporter failed: ${message}`);
    }

    const response: WorkspacePullRequestResponse = compactObject({
      tenant: context.tenant,
      project: context.project,
      runId: route.kind === "run" ? route.runId : undefined,
      issue,
      issueUrl,
      branch,
      baseBranch,
      title,
      commit,
      push,
      pullRequestIndex: result?.index,
      pullRequestUrl: result?.url,
      reviewRequired: reviewRequired || undefined,
      deploymentRequired: deploymentRequired || undefined,
    });

    let runStatus: RunSummary["status"] | undefined;
    if (run && route.kind === "run") {
      const withPullRequest = await attachWorkspacePullRequestToRunSummary(options, run.summary, run.runDir, request, result, reviewRequired, deploymentRequired, runEventContext(access, clientId));
      const updated = await reportAgentGitServiceWorkspaceHandoffAttachment(options, withPullRequest, request, result);
      runStatus = updated.status;
    }

    await appendAuditEvent(context.tenant, "workspace_pull_request_created", compactObject({
      project: context.project,
      runId: route.kind === "run" ? route.runId : undefined,
      issue,
      issueUrl,
      branch,
      baseBranch,
      commit,
      push,
      pullRequestIndex: result?.index,
      pullRequestUrl: result?.url,
      reviewRequired: reviewRequired || undefined,
      deploymentRequired: deploymentRequired || undefined,
      status: runStatus,
      clientId,
    }), access);
    writeJson(res, 201, compactObject({ ...response, status: runStatus }));
  } finally {
    activeWorkspaces.delete(workspaceKey);
  }
}

async function attachWorkspacePullRequestToRunSummary(
  options: HarnessServerOptions,
  summary: RunSummary,
  runDir: string,
  request: WorkspacePullRequestRequest,
  result: PullRequestReporterResult | void,
  reviewRequired: boolean,
  deploymentRequired: boolean,
  eventContext: RunEventContext,
): Promise<RunSummary> {
  let updated: RunSummary = {
    ...summary,
    metadata: compactMetadata({
      ...(summary.metadata ?? {}),
      issue: request.issue,
      issueUrl: request.issueUrl,
      branch: request.branch,
      baseBranch: request.baseBranch,
      pullRequestIndex: result?.index,
      pullRequestUrl: result?.url,
    }),
  };
  const external = await appendRunEvent(runDir, "external_effect", compactObject({
    kind: "pull_request",
    issue: request.issue,
    issueUrl: request.issueUrl,
    branch: request.branch,
    baseBranch: request.baseBranch,
    commit: request.commit,
    pullRequestIndex: result?.index,
    pullRequestUrl: result?.url,
    clientId: request.clientId,
    requester: summary.requester,
  }), options.stateBackend?.events);
  updated = { ...updated, eventCount: external.seq };

  if (reviewRequired && updated.status === "passed") {
    const review: ReviewGate = { required: true, status: "pending" };
    const reviewEvent = await appendRunEvent(runDir, "review_gate", compactObject({ ...review, ...eventContext }), options.stateBackend?.events);
    updated = { ...updated, status: "review_required", review, eventCount: reviewEvent.seq };
  }
  if (deploymentRequired && !updated.deployment?.required && (updated.status === "passed" || updated.status === "review_required")) {
    const deployment: DeploymentGate = { required: true, status: "pending" };
    const deploymentEvent = await appendRunEvent(runDir, "deployment_gate", compactObject({ ...deployment, ...eventContext }), options.stateBackend?.events);
    const status = updated.status === "review_required" ? "review_required" : "deployment_required";
    updated = { ...updated, status, deployment, eventCount: deploymentEvent.seq };
  }

  await writeRunSummary(updated, options);
  await writeRunStatus(runDir, updated, options);
  return updated;
}

function validateWorkspacePullRequestRun(summary: RunSummary | undefined, reviewRequired: boolean, deploymentRequired: boolean): void {
  if (!summary) {
    if (reviewRequired) throw badRequest("reviewRequired requires a run workspace.");
    if (deploymentRequired) throw badRequest("deploymentRequired requires a run workspace.");
    return;
  }
  if (summary.status !== "passed" && summary.status !== "review_required" && summary.status !== "deployment_required") {
    throw badRequest("run is not eligible for pull request handoff.");
  }
  if (reviewRequired && summary.status === "deployment_required") {
    throw badRequest("reviewRequired cannot be added after deployment approval is pending.");
  }
}

async function readWorkspaceHeadCommit(
  executor: WorkspaceExecutor,
  options: HarnessServerOptions,
): Promise<string | undefined> {
  const result = await executor.runCommand("git rev-parse --short HEAD", workspaceCommandTimeoutMs(options));
  if (result.exitCode !== 0) return undefined;
  return firstWorkspaceToken(result.stdout);
}

async function pushWorkspaceBranch(
  executor: WorkspaceExecutor,
  branch: string,
  options: HarnessServerOptions,
): Promise<WorkspaceCommandResponse> {
  const command = `git push -u origin HEAD:${branch}`;
  const result = await executor.runCommand(command, workspaceCommandTimeoutMs(options));
  return {
    command,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

function workspacePullRequestIssue(value: unknown, fallback?: string): string {
  const issue = (optionalString(value, "issue") ?? fallback)?.trim();
  if (!issue) throw badRequest("issue is required.");
  try {
    parseGiteaIssueRef(issue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw badRequest(message);
  }
  return issue;
}

function workspacePullRequestIssueUrl(issue: string, options: HarnessServerOptions): string | undefined {
  return controlPlaneIssueUrl(options, issue);
}

function requiredWorkspacePullRequestRef(value: unknown, fallback: string | undefined, field: string): string {
  const ref = workspacePullRequestRef(value, fallback, field);
  if (!ref) throw badRequest(`${field} is required.`);
  return ref;
}

function workspacePullRequestBranchFallback(
  value: unknown,
  fallback: string | undefined,
  route: WorkspaceCommandRoute,
  options: HarnessServerOptions,
): string | undefined {
  if (hasRequestValue(value) || !fallback || route.kind !== "run" || !runWorkspacesAreIsolated(options)) return fallback;
  const candidate = `${fallback}/${route.runId}`;
  return candidate.length <= 160 ? candidate : `loom/${route.runId}`;
}

function workspacePullRequestTitle(value: unknown, summary: RunSummary | undefined, project: string): string {
  const fallback = summary ? `Loom run ${summary.runId}: ${summary.goal}` : `Loom workspace handoff: ${project}`;
  return workspacePullRequestSingleLine(value, "title", fallback, 200);
}

function workspacePullRequestBody(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw badRequest("body must be a string.");
  if (Buffer.byteLength(value, "utf8") > 16 * 1024) {
    throw badRequest("body must be at most 16 KiB.");
  }
  return value;
}

function optionalWorkspacePullRequestCommit(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return workspacePullRequestSingleLine(value, "commit", undefined, 80);
}

function workspacePullRequestSingleLine(value: unknown, field: string, fallback: string | undefined, maxLength: number): string {
  const text = (optionalString(value, field) ?? fallback)?.trim();
  if (!text) throw badRequest(`${field} is required.`);
  if (text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw badRequest(`${field} must be a single-line string at most ${maxLength} characters.`);
  }
  return text;
}

function formatWorkspacePullRequestBody(request: {
  tenant: string;
  project: string;
  runId?: string;
  requester?: RunRequesterSummary;
  issue: string;
  issueUrl?: string;
  branch: string;
  baseBranch?: string;
  commit?: string;
  summary?: RunSummary;
  reviewRequired?: boolean;
  deploymentRequired?: boolean;
}): string {
  const requester = formatRunRequesterSummary(request.requester);
  const lines = [
    "Created by Loom workspace handoff.",
    "",
    `Tenant: ${request.tenant}`,
    `Project: ${request.project}`,
    requester ? `Requester: ${requester}` : "",
    request.runId ? `Run: ${request.runId}` : "",
    `Branch: ${request.branch}`,
    request.baseBranch ? `Base: ${request.baseBranch}` : "",
    request.commit ? `Commit: ${request.commit}` : "",
    request.issueUrl ? `Issue: ${request.issueUrl}` : `Issue: ${request.issue}`,
  ].filter(Boolean);

  const summary = request.summary;
  if (summary?.metadata?.dashboardUrl) lines.push(`Dashboard: ${summary.metadata.dashboardUrl}`);
  if (summary?.metadata?.summaryUrl) {
    lines.push(`Summary: ${summary.metadata.summaryUrl}`);
    const reviewSummaryUrl = runEvidenceUrl(summary.metadata.summaryUrl, "review-summary");
    const handoffPackageUrl = runEvidenceUrl(summary.metadata.summaryUrl, "handoff-package");
    const handoffFollowupsUrl = runEvidenceUrl(summary.metadata.summaryUrl, "handoff-runs");
    if (reviewSummaryUrl) lines.push(`Review summary: ${reviewSummaryUrl}`);
    if (handoffPackageUrl) lines.push(`Handoff package: ${handoffPackageUrl}`);
    if (handoffFollowupsUrl) lines.push(`Follow-up runs: ${handoffFollowupsUrl}`);
  }
  if (summary?.verification) {
    lines.push(`Verification: ${summary.verification.ok ? "passed" : "failed"} (exit ${summary.verification.exitCode})`);
    if (summary.verification.commands.length) {
      lines.push(`Verification commands: ${summary.verification.commands.map(markdownInlineCode).join(", ")}`);
    }
  }
  if (summary?.evaluation) {
    lines.push(`Evaluation: ${summary.evaluation.ok ? "passed" : "failed"} (exit ${summary.evaluation.exitCode})`);
    if (summary.evaluation.commands.length) {
      lines.push(`Evaluation commands: ${summary.evaluation.commands.map(markdownInlineCode).join(", ")}`);
    }
  }
  if (summary?.reviewer) {
    lines.push(`Reviewer: ${summary.reviewer.ok ? "passed" : "flagged"} (exit ${summary.reviewer.exitCode})`);
    if (summary.reviewer.commands.length) {
      lines.push(`Reviewer commands: ${summary.reviewer.commands.map(markdownInlineCode).join(", ")}`);
    }
  }
  if (summary?.review?.required || request.reviewRequired) {
    lines.push(`Review: ${summary?.review?.status ?? "pending"}`);
  }
  if (summary?.deployment?.required || request.deploymentRequired) {
    lines.push(`Deployment: ${summary?.deployment?.status ?? "pending"}`);
  }

  return lines.join("\n") + "\n";
}

function firstWorkspaceToken(value: string): string | undefined {
  const token = value.trim().split(/\s+/)[0];
  return token || undefined;
}

async function handleListWorkspaceCommands(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "commands") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  await requireProjectExists(workspaceRoot, tenant, project);
  writeJson(res, 200, await readWorkspaceCommandSummaries(
    projectWorkspaceCommandRoot(workspaceRoot, tenant, project),
    { route: "project", tenant, project },
  ));
  return true;
}

async function handleListRunWorkspaceCommands(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "commands") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const runId = requireSafeName(segments[3], "runId");
  const project = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  writeJson(res, 200, await readWorkspaceCommandSummaries(
    runWorkspaceCommandRoot(workspaceRoot, tenant, project, runId),
    { route: "run", tenant, project, runId },
  ));
  return true;
}

async function handleCreateWorkspaceSession(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "sessions") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const project = requireSafeName(segments[3], "project");
  await requireProjectExists(workspaceRoot, tenant, project);
  const sessionId = randomUUID();
  await createWorkspaceSession(
    req,
    res,
    projectWorkspaceContext(workspaceRoot, tenant, project, `terminal-${sessionId}`),
    { kind: "project" },
    sessionId,
    join(projectWorkspaceSessionRoot(workspaceRoot, tenant, project), sessionId),
    options,
    activeWorkspaces,
    activeSessions,
    appendAuditEvent,
    access,
  );
  return true;
}

async function handleCreateRunWorkspaceSession(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "sessions") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const runId = requireSafeName(segments[3], "runId");
  try {
    const context = await runWorkspaceContext(url, workspaceRoot, tenant, runId, options);
    const sessionId = randomUUID();
    await createWorkspaceSession(
      req,
      res,
      context,
      { kind: "run", runId },
      sessionId,
      join(runWorkspaceSessionRoot(workspaceRoot, tenant, context.project, runId), sessionId),
      options,
      activeWorkspaces,
      activeSessions,
      appendAuditEvent,
      access,
    );
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function createWorkspaceSession(
  req: IncomingMessage,
  res: ServerResponse,
  context: HarnessWorkspaceContext,
  route: ActiveWorkspaceSession["route"],
  sessionId: string,
  sessionDir: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  appendAuditEvent: TenantAuditAppender,
  access: TenantAccess | undefined,
): Promise<void> {
  await requireTenantTool(options, context.tenant, "shell.exec", "workspace sessions require shell.exec to be allowed by the server.");
  const body = await readWorkspaceSessionJson(req);
  const command = optionalString(body.command, "command") ?? "sh";
  const clientId = optionalClientId(body.clientId);
  const globalSessionLimit = workspaceSessionLimit(options);
  if (activeWorkspaceSessionCount(activeSessions) >= globalSessionLimit) {
    throw conflict("active workspace session limit reached");
  }
  const tenantSessionLimit = await effectiveTenantWorkspaceSessionLimit(options, context.tenant);
  if (activeTenantWorkspaceSessionCount(activeSessions, context.tenant) >= tenantSessionLimit) {
    throw conflict("active workspace session tenant limit reached");
  }
  const workspaceKey = workspaceRouteKey(options, context, route);
  const activeRunId = activeWorkspaces.get(workspaceKey);
  if (activeRunId) {
    throw conflict(`tenant project already has an active run: ${activeRunId}`);
  }
  const persistedRunId = await findBlockingPersistedRunningRun(options, join(context.cwd, ".loom", "runs"));
  if (persistedRunId) {
    throw conflict(`tenant project already has an active run: ${persistedRunId}`);
  }
  const sessionAdmission = await tryAcquireWorkspaceSessionAdmissionClaims(options, context, route, sessionId, globalSessionLimit, tenantSessionLimit);
  if (!sessionAdmission.ok) {
    if (sessionAdmission.scope === "global") {
      throw conflict(`active workspace session limit reached: ${sessionAdmission.sessionIds.join(", ")}`);
    }
    throw conflict(`active workspace session tenant limit reached: ${sessionAdmission.sessionIds.join(", ")}`);
  }
  let admissionHeartbeat: (() => void) | undefined;
  activeWorkspaces.set(workspaceKey, context.runId);

  try {
    const executor = await preparedWorkspaceExecutor(context, options);
    await enforceWorkspaceBytesAvailable(context, options, executor);
    if (!executor.startSession) {
      throw badRequest("configured executor does not support workspace sessions.");
    }
    const session = await executor.startSession(command);
    const startedAt = new Date().toISOString();
    const idleTimeoutMs = workspaceSessionIdleTimeoutMs(options);
    const idleExpiresAt = workspaceSessionIdleExpiresAt(startedAt, idleTimeoutMs);
    admissionHeartbeat = startWorkspaceSessionAdmissionClaimHeartbeat(options, sessionAdmission.handle, () => {
      void session.stop().catch(() => undefined);
    });
    const active: ActiveWorkspaceSession = {
      sessionId,
      route,
      context,
      command,
      session,
      sessionDir,
      summary: compactWorkspaceSessionSummary({
        sessionId,
        tenant: context.tenant,
        project: context.project,
        runId: route.kind === "run" ? route.runId : undefined,
        route: route.kind,
        command,
        actor: access?.actor,
        role: access?.role,
        clientId,
        status: "running",
        startedAt,
        lastActivityAt: startedAt,
        idleExpiresAt,
        eventCount: 0,
      }),
      events: [],
      cleanup: [],
      admissionClaim: sessionAdmission.handle,
      admissionHeartbeat,
      status: "running",
      workspaceKey,
      persistQueue: Promise.resolve(),
    };
    active.cleanup.push(
      session.onOutput((event) => {
        resetWorkspaceSessionIdleTimer(active, options);
        const output = boundedWorkspaceOutput(event.data);
        void appendWorkspaceSessionEvent(active, {
          type: event.stream,
          data: output.value,
          dataBytes: output.bytes,
          dataTruncated: output.truncated,
        });
      }),
    );
    active.cleanup.push(
      session.onExit((event) => {
        void appendWorkspaceSessionEvent(active, { type: "exit", exitCode: event.exitCode, signal: event.signal }).then(async () => {
          await appendAuditEvent(context.tenant, "workspace_session_exited", compactObject({
            project: context.project,
            runId: route.kind === "run" ? route.runId : undefined,
            sessionId,
            exitCode: event.exitCode,
            signal: event.signal,
            clientId,
          }), access);
          await active.admissionClaim.release();
          activeSessions.delete(sessionId);
        });
        active.status = "exited";
        active.admissionHeartbeat();
        clearWorkspaceSessionIdleTimer(active);
        for (const cleanup of active.cleanup) cleanup();
        activeWorkspaces.delete(workspaceKey);
      }),
    );
    activeSessions.set(sessionId, active);
    await appendWorkspaceSessionEvent(active, compactObject({
      type: "start" as const,
      data: command,
      actor: access?.actor,
      role: access?.role,
      clientId,
    }));
    await appendAuditEvent(context.tenant, "workspace_session_started", compactObject({
      project: context.project,
      runId: route.kind === "run" ? route.runId : undefined,
      sessionId,
      command,
      clientId,
    }), access);
    resetWorkspaceSessionIdleTimer(active, options);
    writeJson(res, 201, active.summary);
  } catch (error) {
    admissionHeartbeat?.();
    await sessionAdmission.handle.release();
    activeWorkspaces.delete(workspaceKey);
    throw error;
  }
}

async function handleListWorkspaceSessions(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeSessions: Map<string, ActiveWorkspaceSession>,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "sessions") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  await requireProjectExists(workspaceRoot, tenant, project);
  writeJson(res, 200, await readWorkspaceSessionSummaries(
    projectWorkspaceSessionRoot(workspaceRoot, tenant, project),
    activeSessions,
    { route: "project", tenant, project },
    options,
  ));
  return true;
}

async function handleListRunWorkspaceSessions(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeSessions: Map<string, ActiveWorkspaceSession>,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "sessions") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const runId = requireSafeName(segments[3], "runId");
  const project = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  writeJson(res, 200, await readWorkspaceSessionSummaries(
    runWorkspaceSessionRoot(workspaceRoot, tenant, project, runId),
    activeSessions,
    { route: "run", tenant, project, runId },
    options,
  ));
  return true;
}

async function handleWriteWorkspaceSessionInput(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  options: HarnessServerOptions,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const match = await workspaceSessionRoute(url, req, options, activeSessions, "input", "developer");
  if (!match) return false;
  const body = await readWorkspaceSessionInputJson(req);
  const input = requireString(body.input, "input");
  const clientId = optionalClientId(body.clientId);
  const inputBytes = Buffer.byteLength(input, "utf8");
  if (inputBytes > WORKSPACE_SESSION_INPUT_LIMIT_BYTES) {
    throw payloadTooLarge("session input too large");
  }
  if (match.session.status !== "running") {
    throw badRequest("workspace session is not running.");
  }
  resetWorkspaceSessionIdleTimer(match.session, options);
  await appendWorkspaceSessionEvent(match.session, compactObject({
    type: "input" as const,
    dataBytes: inputBytes,
    actor: match.access?.actor,
    role: match.access?.role,
    clientId,
  }));
  await match.session.session.write(input);
  await appendAuditEvent(match.session.context.tenant, "workspace_session_input_sent", compactObject({
    project: match.session.context.project,
    runId: match.session.route.kind === "run" ? match.session.route.runId : undefined,
    sessionId: match.session.sessionId,
    bytes: inputBytes,
    clientId,
  }), match.access);
  writeJson(res, 200, { sessionId: match.session.sessionId, accepted: true });
  return true;
}

async function handleStopWorkspaceSession(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  options: HarnessServerOptions,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const match = await workspaceSessionRoute(url, req, options, activeSessions, "stop", "developer");
  if (!match) return false;
  const body = await readWorkspaceClientJson(req);
  const clientId = optionalClientId(body.clientId);
  if (match.session.status === "running") {
    clearWorkspaceSessionIdleTimer(match.session);
    await appendWorkspaceSessionEvent(match.session, compactObject({
      type: "stop" as const,
      actor: match.access?.actor,
      role: match.access?.role,
      clientId,
    }));
    await match.session.session.stop();
  }
  await appendAuditEvent(match.session.context.tenant, "workspace_session_stopped", compactObject({
    project: match.session.context.project,
    runId: match.session.route.kind === "run" ? match.session.route.runId : undefined,
    sessionId: match.session.sessionId,
    status: match.session.status === "running" ? "stopping" : "exited",
    clientId,
  }), match.access);
  writeJson(res, 200, { sessionId: match.session.sessionId, status: match.session.status === "running" ? "stopping" : "exited" });
  return true;
}

async function handleReadWorkspaceSessionEvents(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  options: HarnessServerOptions,
  activeSessions: Map<string, ActiveWorkspaceSession>,
): Promise<boolean> {
  let match;
  try {
    match = await workspaceSessionRoute(url, req, options, activeSessions, "events");
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "NotFound") throw error;
    const persisted = await readPersistedWorkspaceSessionEvents(url, req, options);
    if (!persisted) throw error;
    if (persisted.stream) {
      streamStaticWorkspaceSessionEvents(res, persisted.events, seqAfter(url, req));
      return true;
    }
    writeJson(res, 200, filterWorkspaceSessionEvents(persisted.events, seqAfter(url)));
    return true;
  }
  if (!match) return false;
  if (match.stream) {
    await streamWorkspaceSessionEvents(res, match.session, seqAfter(url, req));
    return true;
  }
  await match.session.persistQueue;
  if (match.session.status === "exited") {
    activeSessions.delete(match.session.sessionId);
  }
  writeJson(res, 200, filterWorkspaceSessionEvents(match.session.events, seqAfter(url)));
  return true;
}

async function workspaceSessionRoute(
  url: URL,
  req: IncomingMessage,
  options: HarnessServerOptions,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  action: "input" | "stop" | "events",
  requiredRole: TenantRole = "viewer",
): Promise<{ session: ActiveWorkspaceSession; stream: boolean; access: TenantAccess | undefined } | false> {
  const segments = url.pathname.split("/").filter(Boolean);
  const projectRoute = segments[0] === "tenants" && segments[2] === "projects" && segments[4] === "sessions";
  const runRoute = segments[0] === "tenants" && segments[2] === "runs" && segments[4] === "sessions";
  if (!projectRoute && !runRoute) return false;
  if (segments.length !== 7 && segments.length !== 8) return false;
  if (segments[6] !== action) return false;
  const stream = action === "events" && segments.length === 8 && segments[7] === "stream";
  if (segments.length === 8 && !stream) return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, requiredRole);
  const sessionId = requireSafeName(segments[5], "sessionId");
  const session = activeSessions.get(sessionId);
  if (!session || session.context.tenant !== tenant) {
    throw notFound("workspace session not found");
  }
  if (projectRoute) {
    const project = requireSafeName(segments[3], "project");
    if (session.route.kind !== "project" || session.context.project !== project) {
      throw notFound("workspace session not found");
    }
  }
  if (runRoute) {
    const runId = requireSafeName(segments[3], "runId");
    if (session.route.kind !== "run" || session.route.runId !== runId) {
      throw notFound("workspace session not found");
    }
  }
  return { session, stream, access };
}

async function appendWorkspaceSessionEvent(
  session: ActiveWorkspaceSession,
  event: Omit<WorkspaceSessionEvent, "seq" | "ts">,
): Promise<WorkspaceSessionEvent> {
  const observed = compactObject({
    seq: session.events.length + 1,
    ts: new Date().toISOString(),
    ...event,
  });
  session.events.push(observed);
  session.summary = workspaceSessionSummaryForEvent(session.summary, observed);
  if (session.status === "running") {
    const idleTimeoutMs = workspaceSessionIdleTimeoutMsFromSummary(session.summary);
    session.summary = compactWorkspaceSessionSummary({
      ...session.summary,
      idleExpiresAt: workspaceSessionIdleExpiresAt(observed.ts, idleTimeoutMs),
    });
  }
  const persist = session.persistQueue.then(async () => {
    await mkdir(session.sessionDir, { recursive: true });
    await appendFile(join(session.sessionDir, "events.jsonl"), JSON.stringify(observed) + "\n", "utf8");
    await writeWorkspaceSessionSummary(session.sessionDir, session.summary);
  });
  session.persistQueue = persist.catch(() => undefined);
  await persist;
  return observed;
}

function resetWorkspaceSessionIdleTimer(session: ActiveWorkspaceSession, options: HarnessServerOptions): void {
  clearWorkspaceSessionIdleTimer(session);
  const timeoutMs = workspaceSessionIdleTimeoutMs(options);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || session.status !== "running") {
    session.summary = compactWorkspaceSessionSummary({ ...session.summary, idleExpiresAt: undefined });
    return;
  }
  const now = new Date().toISOString();
  session.summary = compactWorkspaceSessionSummary({
    ...session.summary,
    lastActivityAt: now,
    idleExpiresAt: workspaceSessionIdleExpiresAt(now, timeoutMs),
  });
  session.idleTimer = setTimeout(() => {
    if (session.status !== "running") return;
    void appendWorkspaceSessionEvent(session, {
      type: "stderr",
      data: `workspace session idle timeout after ${timeoutMs}ms\n`,
    }).finally(() => {
      if (session.status === "running") {
        void session.session.stop();
      }
    });
  }, timeoutMs);
  session.idleTimer.unref?.();
}

function workspaceSessionIdleExpiresAt(from: string, timeoutMs: number): string | undefined {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return new Date(Date.parse(from) + timeoutMs).toISOString();
}

function workspaceSessionIdleTimeoutMsFromSummary(summary: WorkspaceSessionSummary): number {
  const idleExpiresAt = summary.idleExpiresAt;
  const lastActivityAt = summary.lastActivityAt;
  if (!idleExpiresAt || !lastActivityAt) return Number.NaN;
  const timeoutMs = Date.parse(idleExpiresAt) - Date.parse(lastActivityAt);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : Number.NaN;
}

function clearWorkspaceSessionIdleTimer(session: ActiveWorkspaceSession): void {
  if (!session.idleTimer) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = undefined;
}

function filterWorkspaceSessionEvents(events: WorkspaceSessionEvent[], after: number): WorkspaceSessionEvent[] {
  return events.filter((event) => event.seq > after);
}

async function streamWorkspaceSessionEvents(
  res: ServerResponse,
  session: ActiveWorkspaceSession,
  after: number,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders();

  let lastSeq = after;
  const deadline = Date.now() + 60_000;

  while (!res.destroyed && Date.now() < deadline) {
    const events = filterWorkspaceSessionEvents(session.events, lastSeq);
    for (const event of events) {
      lastSeq = Math.max(lastSeq, event.seq);
      res.write(`event: workspace_session\n`);
      res.write(`id: ${event.seq}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "exit") {
        res.end();
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  res.end();
}

function streamStaticWorkspaceSessionEvents(res: ServerResponse, events: WorkspaceSessionEvent[], after: number): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of filterWorkspaceSessionEvents(events, after)) {
    res.write(`event: workspace_session\n`);
    res.write(`id: ${event.seq}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

async function readPersistedWorkspaceSessionEvents(
  url: URL,
  req: IncomingMessage,
  options: HarnessServerOptions,
): Promise<{ events: WorkspaceSessionEvent[]; stream: boolean } | false> {
  const segments = url.pathname.split("/").filter(Boolean);
  const projectRoute = segments[0] === "tenants" && segments[2] === "projects" && segments[4] === "sessions";
  const runRoute = segments[0] === "tenants" && segments[2] === "runs" && segments[4] === "sessions";
  if (!projectRoute && !runRoute) return false;
  if (segments.length !== 7 && segments.length !== 8) return false;
  if (segments[6] !== "events") return false;
  const stream = segments.length === 8 && segments[7] === "stream";
  if (segments.length === 8 && !stream) return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const sessionId = requireSafeName(segments[5], "sessionId");
  const sessionRoot = projectRoute
    ? projectWorkspaceSessionRoot(resolve(options.workspaceRoot), tenant, requireSafeName(segments[3], "project"))
    : runWorkspaceSessionRoot(
        resolve(options.workspaceRoot),
        tenant,
        optionalSafeName(url.searchParams.get("project"), "project") ?? "default",
        requireSafeName(segments[3], "runId"),
      );
  return { events: await readWorkspaceSessionEventsFromDisk(join(sessionRoot, sessionId)), stream };
}

function runWorkspaceSessionRoot(workspaceRoot: string, tenant: string, project: string, runId: string): string {
  return join(workspaceRoot, tenant, project, ".loom", "runs", runId, "sessions");
}

function runWorkspaceCommandRoot(workspaceRoot: string, tenant: string, project: string, runId: string): string {
  return join(workspaceRoot, tenant, project, ".loom", "runs", runId, "commands");
}

async function readWorkspaceCommandSummaries(
  commandRoot: string,
  context: WorkspaceCommandListContext,
): Promise<WorkspaceCommandSummary[]> {
  let entries;
  try {
    entries = await readdir(commandRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readWorkspaceCommandSummary(join(commandRoot, entry.name), entry.name, context)),
  );
  const readable = summaries.filter((summary): summary is WorkspaceCommandSummary => summary !== undefined);
  readable.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return readable;
}

type WorkspaceCommandListContext =
  | { route: "project"; tenant: string; project: string }
  | { route: "run"; tenant: string; project: string; runId: string };

async function readWorkspaceCommandSummary(
  commandDir: string,
  commandId: string,
  context: WorkspaceCommandListContext,
): Promise<WorkspaceCommandSummary | undefined> {
  let summary: WorkspaceCommandSummary;
  try {
    summary = JSON.parse(await readFile(join(commandDir, "summary.json"), "utf8")) as WorkspaceCommandSummary;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
  return workspaceCommandSummaryMatchesContext(summary, commandId, context) ? summary : undefined;
}

function workspaceCommandSummaryMatchesContext(
  summary: WorkspaceCommandSummary,
  commandId: string,
  context: WorkspaceCommandListContext,
): boolean {
  const data = recordData(summary);
  const declaredCommandId = stringField(data, "commandId");
  const tenant = stringField(data, "tenant");
  const project = stringField(data, "project");
  const runId = stringField(data, "runId");
  const route = stringField(data, "route");
  const command = stringField(data, "command");
  const stdout = stringField(data, "stdout");
  const stderr = stringField(data, "stderr");
  const startedAt = stringField(data, "startedAt");
  const endedAt = stringField(data, "endedAt");
  return declaredCommandId === commandId
    && isSafeDirectoryName(declaredCommandId)
    && tenant === context.tenant
    && isSafeTenantDirectoryName(tenant)
    && project === context.project
    && isProjectDirectoryName(project)
    && route === context.route
    && command !== undefined
    && stdout !== undefined
    && stderr !== undefined
    && typeof data.exitCode === "number"
    && startedAt !== undefined
    && endedAt !== undefined
    && (context.route === "project"
      ? runId === undefined
      : runId === context.runId && isSafeDirectoryName(runId));
}

async function writeWorkspaceCommandSummary(commandDir: string, summary: WorkspaceCommandSummary): Promise<void> {
  await mkdir(commandDir, { recursive: true });
  await writeFile(join(commandDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
}

async function readWorkspaceSessionSummaries(
  sessionRoot: string,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  context: WorkspaceSessionListContext,
  options: HarnessServerOptions,
): Promise<WorkspaceSessionSummary[]> {
  let entries;
  try {
    entries = await readdir(sessionRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readWorkspaceSessionSummary(join(sessionRoot, entry.name), entry.name, activeSessions, context, options)),
  );
  const readable = summaries.filter((summary): summary is WorkspaceSessionSummary => summary !== undefined);
  readable.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return readable;
}

type WorkspaceSessionListContext =
  | { route: "project"; tenant: string; project: string }
  | { route: "run"; tenant: string; project: string; runId: string };

async function readWorkspaceSessionSummary(
  sessionDir: string,
  sessionId: string,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  context: WorkspaceSessionListContext,
  options: HarnessServerOptions,
): Promise<WorkspaceSessionSummary | undefined> {
  const active = activeSessions.get(sessionId);
  if (active) {
    return workspaceSessionSummaryMatchesContext(active.summary, sessionId, context) ? active.summary : undefined;
  }
  let summary: WorkspaceSessionSummary;
  try {
    summary = JSON.parse(await readFile(join(sessionDir, "status.json"), "utf8")) as WorkspaceSessionSummary;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!workspaceSessionSummaryMatchesContext(summary, sessionId, context)) return undefined;
  if (summary.status === "running") {
    if (await workspaceSessionHasActiveAdmissionClaim(options, summary)) return compactWorkspaceSessionSummary(summary);
    return compactWorkspaceSessionSummary({ ...summary, status: "orphaned", idleExpiresAt: undefined });
  }
  return summary;
}

function workspaceSessionSummaryMatchesContext(
  summary: WorkspaceSessionSummary,
  sessionId: string,
  context: WorkspaceSessionListContext,
): boolean {
  const data = recordData(summary);
  const declaredSessionId = stringField(data, "sessionId");
  const tenant = stringField(data, "tenant");
  const project = stringField(data, "project");
  const runId = stringField(data, "runId");
  const route = stringField(data, "route");
  const command = stringField(data, "command");
  const startedAt = stringField(data, "startedAt");
  const status = stringField(data, "status");
  return declaredSessionId === sessionId
    && isSafeDirectoryName(declaredSessionId)
    && tenant === context.tenant
    && isSafeTenantDirectoryName(tenant)
    && project === context.project
    && isProjectDirectoryName(project)
    && route === context.route
    && command !== undefined
    && startedAt !== undefined
    && (status === "running" || status === "exited" || status === "orphaned")
    && typeof data.eventCount === "number"
    && (context.route === "project"
      ? runId === undefined
      : runId === context.runId && isSafeDirectoryName(runId));
}

async function writeWorkspaceSessionSummary(sessionDir: string, summary: WorkspaceSessionSummary): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "status.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
}

async function readWorkspaceSessionEventsFromDisk(sessionDir: string): Promise<WorkspaceSessionEvent[]> {
  try {
    const raw = await readFile(join(sessionDir, "events.jsonl"), "utf8");
    return parseWorkspaceSessionEvents(raw);
  } catch (error) {
    if (isNotFound(error)) throw notFound("workspace session not found");
    throw error;
  }
}

const workspaceSessionEventTypes = new Set<string>(["start", "input", "stop", "stdout", "stderr", "exit"]);

function parseWorkspaceSessionEvents(raw: string): WorkspaceSessionEvent[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const event = parseWorkspaceSessionEventLine(line);
      return event ? [event] : [];
    });
}

function parseWorkspaceSessionEventLine(line: string): WorkspaceSessionEvent | undefined {
  try {
    const event = JSON.parse(line) as unknown;
    if (!isWorkspaceSessionEvent(event)) return undefined;
    return event;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isWorkspaceSessionEvent(value: unknown): value is WorkspaceSessionEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.seq === "number"
    && Number.isInteger(event.seq)
    && event.seq > 0
    && typeof event.ts === "string"
    && typeof event.type === "string"
    && workspaceSessionEventTypes.has(event.type)
    && optionalSessionEventString(event.data)
    && optionalSessionEventNumber(event.dataBytes)
    && (event.dataTruncated === undefined || event.dataTruncated === true)
    && optionalSessionEventString(event.actor)
    && optionalSessionEventRole(event.role)
    && optionalSessionEventString(event.clientId)
    && optionalSessionEventNumber(event.exitCode)
    && optionalSessionEventString(event.signal);
}

function workspaceSessionSummaryForEvent(
  summary: WorkspaceSessionSummary,
  event: WorkspaceSessionEvent,
): WorkspaceSessionSummary {
  const next: WorkspaceSessionSummary = { ...summary, eventCount: event.seq };
  next.lastActivityAt = event.ts;
  if (event.type === "exit") {
    next.status = "exited";
    next.endedAt = event.ts;
    next.idleExpiresAt = undefined;
    next.exitCode = event.exitCode;
    next.signal = event.signal;
  }
  return compactWorkspaceSessionSummary(next);
}

async function handleWriteWorkspaceFile(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
  presence: RunPresenceRegistry,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "files") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  await requireTenantTool(options, tenant, "file.write", "workspace file writes require file.write to be allowed by the server.");
  const project = requireSafeName(segments[3], "project");
  await requireProjectExists(workspaceRoot, tenant, project);
  await writeWorkspaceFile(req, res, projectWorkspaceContext(workspaceRoot, tenant, project, "workspace-files"), { kind: "project" }, options, activeWorkspaces, appendAuditEvent, access, presence);
  return true;
}

async function handleWriteRunWorkspaceFile(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
  presence: RunPresenceRegistry,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "files") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  await requireTenantTool(options, tenant, "file.write", "workspace file writes require file.write to be allowed by the server.");
  const runId = requireSafeName(segments[3], "runId");
  try {
    await writeWorkspaceFile(req, res, await runWorkspaceContext(url, workspaceRoot, tenant, runId, options), { kind: "run", runId }, options, activeWorkspaces, appendAuditEvent, access, presence);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function handleDeleteWorkspaceFile(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
  presence: RunPresenceRegistry,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "files") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  await requireTenantTool(options, tenant, "file.write", "workspace file deletes require file.write to be allowed by the server.");
  const project = requireSafeName(segments[3], "project");
  await requireProjectExists(workspaceRoot, tenant, project);
  await deleteWorkspaceFile(url, req, res, projectWorkspaceContext(workspaceRoot, tenant, project, "workspace-files"), { kind: "project" }, options, activeWorkspaces, appendAuditEvent, access, presence);
  return true;
}

async function handleMoveWorkspaceFile(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
  presence: RunPresenceRegistry,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 6) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "files" || segments[5] !== "move") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  await requireTenantTool(options, tenant, "file.write", "workspace file moves require file.write to be allowed by the server.");
  const project = requireSafeName(segments[3], "project");
  await requireProjectExists(workspaceRoot, tenant, project);
  await moveWorkspaceFile(req, res, projectWorkspaceContext(workspaceRoot, tenant, project, "workspace-files"), { kind: "project" }, options, activeWorkspaces, appendAuditEvent, access, presence);
  return true;
}

async function handleMoveRunWorkspaceFile(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
  presence: RunPresenceRegistry,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 6) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "files" || segments[5] !== "move") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  await requireTenantTool(options, tenant, "file.write", "workspace file moves require file.write to be allowed by the server.");
  const runId = requireSafeName(segments[3], "runId");
  try {
    await moveWorkspaceFile(req, res, await runWorkspaceContext(url, workspaceRoot, tenant, runId, options), { kind: "run", runId }, options, activeWorkspaces, appendAuditEvent, access, presence);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function moveWorkspaceFile(
  req: IncomingMessage,
  res: ServerResponse,
  context: HarnessWorkspaceContext,
  route: WorkspaceCommandRoute,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
  access: TenantAccess | undefined,
  presence: RunPresenceRegistry,
): Promise<void> {
  const body = await readWorkspaceFileMoveJson(req);
  if (typeof body.fromPath !== "string" || !body.fromPath.trim()) {
    throw badRequest("fromPath is required.");
  }
  if (typeof body.toPath !== "string" || !body.toPath.trim()) {
    throw badRequest("toPath is required.");
  }
  const fromPath = workspaceFileRelativePath(body.fromPath, false);
  const toPath = workspaceFileRelativePath(body.toPath, false);
  if (fromPath === toPath) {
    throw badRequest("target workspace path must differ from source path.");
  }
  const clientId = optionalClientId(body.clientId);
  const workspaceKey = workspaceRouteKey(options, context, route);
  const activeRunId = activeWorkspaces.get(workspaceKey);
  if (activeRunId) {
    throw conflict(`tenant project already has an active run: ${activeRunId}`);
  }
  const persistedRunId = await findBlockingPersistedRunningRun(options, join(context.cwd, ".loom", "runs"));
  if (persistedRunId) {
    throw conflict(`tenant project already has an active run: ${persistedRunId}`);
  }
  activeWorkspaces.set(workspaceKey, context.runId);

  try {
    const executor = await preparedWorkspaceExecutor(context, options);
    const source = await executor.inspectPath(fromPath);
    const baseUpdatedAt = optionalString(body.baseUpdatedAt, "baseUpdatedAt");
    if (baseUpdatedAt !== undefined && (source.kind !== "file" || source.updatedAt !== baseUpdatedAt)) {
      await recordWorkspaceFileConflict(res, context, route, appendAuditEvent, access, presence, {
        operation: "move",
        path: fromPath,
        toPath,
        clientId,
        expectedUpdatedAt: baseUpdatedAt,
        observed: source,
      });
      return;
    }
    if (source.kind === "missing") {
      writeJson(res, 404, { error: "workspace source path not found" });
      return;
    }
    if (source.kind === "directory") {
      throw badRequest("workspace source path must be a file.");
    }
    const target = await executor.inspectPath(toPath);
    if (target.kind !== "missing") {
      throw badRequest("target workspace path already exists.");
    }
    if (!executor.moveFile) {
      throw badRequest("workspace executor does not support file moves.");
    }

    await executor.moveFile(fromPath, toPath);
    const moved = await executor.inspectPath(toPath);
    const response: WorkspaceFileResponse = {
      path: toPath,
      previousPath: fromPath,
      kind: "file",
      size: moved.kind === "file" ? moved.size : source.size,
      updatedAt: moved.kind === "file" ? moved.updatedAt : new Date().toISOString(),
      content: await executor.readFile(toPath),
    };
    await appendAuditEvent(context.tenant, "workspace_file_moved", compactObject({
      project: context.project,
      runId: route.kind === "run" ? route.runId : undefined,
      fromPath,
      path: toPath,
      clientId,
    }), access);
    writeJson(res, 200, response);
  } finally {
    activeWorkspaces.delete(workspaceKey);
  }
}

async function handleDeleteRunWorkspaceFile(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
  presence: RunPresenceRegistry,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "files") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  await requireTenantTool(options, tenant, "file.write", "workspace file deletes require file.write to be allowed by the server.");
  const runId = requireSafeName(segments[3], "runId");
  try {
    await deleteWorkspaceFile(url, req, res, await runWorkspaceContext(url, workspaceRoot, tenant, runId, options), { kind: "run", runId }, options, activeWorkspaces, appendAuditEvent, access, presence);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function deleteWorkspaceFile(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  context: HarnessWorkspaceContext,
  route: WorkspaceCommandRoute,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
  access: TenantAccess | undefined,
  presence: RunPresenceRegistry,
): Promise<void> {
  const body = await readWorkspaceClientJson(req);
  const clientId = optionalClientId(body.clientId);
  const relativePath = workspaceFileRelativePath(url.searchParams.get("path") ?? "", false);
  const workspaceKey = workspaceRouteKey(options, context, route);
  const activeRunId = activeWorkspaces.get(workspaceKey);
  if (activeRunId) {
    throw conflict(`tenant project already has an active run: ${activeRunId}`);
  }
  const persistedRunId = await findBlockingPersistedRunningRun(options, join(context.cwd, ".loom", "runs"));
  if (persistedRunId) {
    throw conflict(`tenant project already has an active run: ${persistedRunId}`);
  }
  activeWorkspaces.set(workspaceKey, context.runId);

  try {
    const executor = await preparedWorkspaceExecutor(context, options);
    const target = await executor.inspectPath(relativePath);
    const baseUpdatedAt = optionalString(body.baseUpdatedAt, "baseUpdatedAt");
    if (baseUpdatedAt !== undefined && (target.kind !== "file" || target.updatedAt !== baseUpdatedAt)) {
      await recordWorkspaceFileConflict(res, context, route, appendAuditEvent, access, presence, {
        operation: "delete",
        path: relativePath,
        clientId,
        expectedUpdatedAt: baseUpdatedAt,
        observed: target,
      });
      return;
    }
    if (target.kind === "missing") {
      writeJson(res, 404, { error: "workspace path not found" });
      return;
    }
    if (target.kind === "directory") {
      throw badRequest("workspace path must be a file.");
    }
    if (!executor.deleteFile) {
      throw badRequest("workspace executor does not support file deletes.");
    }

    await executor.deleteFile(relativePath);
    await appendAuditEvent(context.tenant, "workspace_file_deleted", compactObject({
      project: context.project,
      runId: route.kind === "run" ? route.runId : undefined,
      path: relativePath,
      clientId,
    }), access);
    writeJson(res, 200, { path: relativePath, kind: "deleted" });
  } finally {
    activeWorkspaces.delete(workspaceKey);
  }
}

async function writeWorkspaceFile(
  req: IncomingMessage,
  res: ServerResponse,
  context: HarnessWorkspaceContext,
  route: WorkspaceCommandRoute,
  options: HarnessServerOptions,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
  access: TenantAccess | undefined,
  presence: RunPresenceRegistry,
): Promise<void> {
  const body = await readWorkspaceFileJson(req);
  if (typeof body.path !== "string" || !body.path.trim()) {
    throw badRequest("path is required.");
  }
  if (typeof body.content !== "string") {
    throw badRequest("content is required.");
  }
  const contentSize = Buffer.byteLength(body.content, "utf8");
  if (contentSize > WORKSPACE_FILE_WRITE_LIMIT_BYTES) {
    throw badRequest(`workspace file is too large to write over HTTP: ${contentSize} bytes`);
  }
  const clientId = optionalClientId(body.clientId);

  const relativePath = workspaceFileRelativePath(body.path, false);
  const workspaceKey = workspaceRouteKey(options, context, route);
  const activeRunId = activeWorkspaces.get(workspaceKey);
  if (activeRunId) {
    throw conflict(`tenant project already has an active run: ${activeRunId}`);
  }
  const persistedRunId = await findBlockingPersistedRunningRun(options, join(context.cwd, ".loom", "runs"));
  if (persistedRunId) {
    throw conflict(`tenant project already has an active run: ${persistedRunId}`);
  }
  activeWorkspaces.set(workspaceKey, context.runId);

  try {
    const executor = await preparedWorkspaceExecutor(context, options);
    const before = await executor.inspectPath(relativePath);
    if (before.kind === "directory") {
      throw badRequest("workspace path must be a file.");
    }
    const baseUpdatedAt = optionalString(body.baseUpdatedAt, "baseUpdatedAt");
    if (baseUpdatedAt !== undefined && (before.kind !== "file" || before.updatedAt !== baseUpdatedAt)) {
      await recordWorkspaceFileConflict(res, context, route, appendAuditEvent, access, presence, {
        operation: "write",
        path: relativePath,
        clientId,
        expectedUpdatedAt: baseUpdatedAt,
        observed: before,
      });
      return;
    }

    await enforceWorkspaceWriteByteLimit(context, options, executor, contentSize, before.kind === "file" ? before.size : 0);
    await executor.writeFile(relativePath, body.content);
    const after = await executor.inspectPath(relativePath);
    const response: WorkspaceFileResponse = {
      path: relativePath,
      kind: "file",
      size: after.kind === "file" ? after.size : contentSize,
      updatedAt: after.kind === "file" ? after.updatedAt : new Date().toISOString(),
      content: await executor.readFile(relativePath),
    };
    await appendAuditEvent(context.tenant, "workspace_file_written", compactObject({
      project: context.project,
      runId: route.kind === "run" ? route.runId : undefined,
      path: relativePath,
      bytes: contentSize,
      clientId,
    }), access);
    writeJson(res, 200, response);
  } finally {
    activeWorkspaces.delete(workspaceKey);
  }
}

async function recordWorkspaceFileConflict(
  res: ServerResponse,
  context: HarnessWorkspaceContext,
  route: WorkspaceCommandRoute,
  appendAuditEvent: TenantAuditAppender,
  access: TenantAccess | undefined,
  presence: RunPresenceRegistry,
  input: {
    operation: "write" | "move" | "delete";
    path: string;
    toPath?: string;
    clientId?: string;
    expectedUpdatedAt: string;
    observed: WorkspacePathInfo;
  },
): Promise<void> {
  const activeEditors = await workspaceFileActiveEditors(presence, context, route, input.path, input.clientId);
  await appendAuditEvent(context.tenant, "workspace_file_conflicted", compactObject({
    project: context.project,
    runId: route.kind === "run" ? route.runId : undefined,
    operation: input.operation,
    path: input.path,
    toPath: input.toPath,
    clientId: input.clientId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    observedUpdatedAt: input.observed.kind === "file" ? input.observed.updatedAt : undefined,
    observedKind: input.observed.kind,
    activeEditorCount: activeEditors.length,
    activeEditors: activeEditors.map(workspaceFileConflictEditor),
  }), access);
  writeJson(res, 409, {
    error: "workspace file changed since it was loaded.",
    activeEditors,
  });
}

function workspaceFileConflictEditor(entry: RunPresenceEntry): Record<string, unknown> {
  return compactObject({
    tenant: entry.tenant,
    project: entry.project,
    runId: entry.runId,
    clientId: entry.clientId,
    label: entry.label,
    focus: entry.focus,
    actor: entry.actor,
    role: entry.role,
  });
}

async function handleReadRunWorkspaceInfo(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "workspace") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const runId = requireSafeName(segments[3], "runId");
  try {
    writeJson(res, 200, await workspaceInfo(await runWorkspaceContext(url, workspaceRoot, tenant, runId, options), { kind: "run", runId }, options));
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function handleReadRunWorkspaceDiff(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "diff") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  await requireTenantTool(options, tenant, "git.diff", "workspace diffs require git.diff to be allowed by the server.");
  const runId = requireSafeName(segments[3], "runId");
  try {
    writeJson(res, 200, await workspaceDiff(await runWorkspaceContext(url, workspaceRoot, tenant, runId, options), options));
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function workspaceDiff(
  context: HarnessWorkspaceContext,
  options: HarnessServerOptions,
): Promise<WorkspaceCommandResponse> {
  const executor = await preparedWorkspaceExecutor(context, options);
  const result = await executor.runCommand(WORKSPACE_GIT_DIFF_COMMAND, workspaceCommandTimeoutMs(options));
  const stdout = boundedWorkspaceOutput(result.stdout);
  const stderr = boundedWorkspaceOutput(result.stderr);
  return compactObject({
    command: WORKSPACE_GIT_DIFF_COMMAND,
    stdout: stdout.value,
    stdoutBytes: stdout.bytes,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.value,
    stderrBytes: stderr.bytes,
    stderrTruncated: stderr.truncated,
    exitCode: result.exitCode,
  } satisfies WorkspaceCommandResponse);
}

async function workspaceInfo(
  context: HarnessWorkspaceContext,
  route: WorkspaceCommandRoute,
  options: HarnessServerOptions,
): Promise<WorkspaceInfo> {
  await mkdir(context.cwd, { recursive: true });
  const effectiveContext = await effectiveWorkspaceContext(options, context);
  const executor = options.createExecutor?.(context.cwd, effectiveContext) ?? createLocalExecutor({ cwd: context.cwd });
  const workspaceByteLimit = await effectiveTenantWorkspaceByteLimit(options, context.tenant);
  const executorDescription = compactWorkspaceDescription(executor.describeWorkspace?.());
  const workspaceBytes = workspaceByteLimit !== undefined && executorDescription?.kind === "local"
    ? await workspaceUsageBytes(executor, options)
    : undefined;
  return compactWorkspaceInfo({
    tenant: effectiveContext.tenant,
    project: effectiveContext.project,
    runId: route.kind === "run" ? route.runId : undefined,
    route: route.kind,
    cwd: effectiveContext.cwd,
    repo: effectiveContext.repo,
    branch: effectiveContext.branch,
    baseBranch: effectiveContext.baseBranch,
    issue: effectiveContext.issue,
    executorLimits: effectiveContext.executorLimits,
    executorTemplateParameters: effectiveContext.executorTemplateParameters,
    executor: executorDescription,
    workspaceBytes,
    workspaceByteLimit,
  });
}

async function enforceWorkspaceWriteByteLimit(
  context: HarnessWorkspaceContext,
  options: HarnessServerOptions,
  executor: WorkspaceExecutor,
  contentBytes: number,
  replacedBytes: number,
): Promise<void> {
  const limit = await effectiveTenantWorkspaceByteLimit(options, context.tenant);
  if (limit === undefined) return;
  const current = await workspaceUsageBytes(executor, options);
  const next = Math.max(0, current - replacedBytes) + contentBytes;
  if (next > limit) {
    throw conflict(`workspace byte limit exceeded: ${next} > ${limit}`);
  }
}

async function enforceWorkspaceBytesAvailable(
  context: HarnessWorkspaceContext,
  options: HarnessServerOptions,
  executor: WorkspaceExecutor,
): Promise<void> {
  const limit = await effectiveTenantWorkspaceByteLimit(options, context.tenant);
  if (limit === undefined) return;
  const current = await workspaceUsageBytes(executor, options);
  if (current >= limit) {
    throw conflict(`workspace byte limit exhausted: ${current} >= ${limit}`);
  }
}

async function workspaceUsageBytes(executor: WorkspaceExecutor, options: HarnessServerOptions): Promise<number> {
  const result = await executor.runCommand(WORKSPACE_USAGE_COMMAND, Math.min(workspaceCommandTimeoutMs(options), 30_000));
  if (result.exitCode !== 0) {
    const stderr = boundedWorkspaceOutput(result.stderr);
    throw badRequest(`workspace usage check failed${stderr.value ? `: ${stderr.value}` : ""}`);
  }
  const value = Number(result.stdout.trim().split(/\s+/)[0] ?? "");
  if (!Number.isInteger(value) || value < 0) {
    throw badRequest("workspace usage check returned invalid output.");
  }
  return value;
}

async function handleReadWorkspaceFile(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "files") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  await requireTenantTool(options, tenant, "file.read", "workspace file reads require file.read to be allowed by the server.");
  const project = requireSafeName(segments[3], "project");
  await requireProjectExists(workspaceRoot, tenant, project);
  await readWorkspaceFile(url, res, projectWorkspaceContext(workspaceRoot, tenant, project, "workspace-files"), options);
  return true;
}

async function handleReadRunWorkspaceFile(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "files") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  await requireTenantTool(options, tenant, "file.read", "workspace file reads require file.read to be allowed by the server.");
  const runId = requireSafeName(segments[3], "runId");
  try {
    await readWorkspaceFile(url, res, await runWorkspaceContext(url, workspaceRoot, tenant, runId, options), options);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function readWorkspaceFile(
  url: URL,
  res: ServerResponse,
  context: HarnessWorkspaceContext,
  options: HarnessServerOptions,
): Promise<void> {
  const relativePath = workspaceFileRelativePath(url.searchParams.get("path") ?? "", true);
  const executor = await preparedWorkspaceExecutor(context, options);
  const target = await executor.inspectPath(relativePath);
  if (target.kind === "missing") {
    writeJson(res, 404, { error: "workspace path not found" });
    return;
  }
  if (target.kind === "directory") {
    writeJson(res, 200, target);
    return;
  }
  if (target.size > WORKSPACE_FILE_READ_LIMIT_BYTES) {
    throw badRequest(`workspace file is too large to read over HTTP: ${target.size} bytes`);
  }
  const body: WorkspaceFileResponse = {
    path: target.path,
    kind: "file",
    size: target.size,
    updatedAt: target.updatedAt,
    content: await executor.readFile(target.path),
  };
  writeJson(res, 200, body);
}

async function handleListTenantWorkspaceUsageWarnings(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  queuedRuns: QueuedRun[],
  projectPresence: RunPresenceRegistry,
  runPresence: RunPresenceRegistry,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "workspace-usage" || segments[3] !== "warnings") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);

  try {
    const projects = (await readTenantProjectSummariesWithActivity(workspaceRoot, options, tenant, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, projectPresence, runPresence))
      .filter((project) => Array.isArray(project.workspaceByteWarnings) && project.workspaceByteWarnings.length > 0);
    const response: TenantWorkspaceUsageWarningListResponse = { tenant, projects };
    writeJson(res, 200, response);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 200, { tenant, projects: [] });
      return true;
    }
    throw error;
  }
}

function workspaceSessionActivityAt(session: WorkspaceSessionSummary): string {
  return session.endedAt ?? session.lastActivityAt ?? session.startedAt;
}

async function preparedWorkspaceExecutor(
  context: HarnessWorkspaceContext,
  options: HarnessServerOptions,
): Promise<WorkspaceExecutor> {
  await mkdir(context.cwd, { recursive: true });
  const executor = await workspaceExecutor(options, context);
  await executor.prepare?.();
  return executor;
}

async function workspaceExecutor(
  options: HarnessServerOptions,
  context: HarnessWorkspaceContext,
): Promise<WorkspaceExecutor> {
  const effectiveContext = await effectiveWorkspaceContext(options, context);
  const baseExecutor = options.createExecutor?.(context.cwd, effectiveContext) ?? createLocalExecutor({ cwd: context.cwd });
  return withWorkspaceSecretExecutionOptions(baseExecutor, await workspaceSecretExecutionOptions(options, effectiveContext));
}

async function effectiveWorkspaceContext(
  options: HarnessServerOptions,
  context: HarnessWorkspaceContext,
): Promise<HarnessWorkspaceContext> {
  const executorLimits = await effectiveTenantExecutorLimits(options, context.tenant);
  const executorTemplateParameters = await effectiveTenantExecutorTemplateParameters(options, context.tenant);
  const projectSourceDefaults = await readProjectSourceDefaults(join(resolve(options.workspaceRoot), context.tenant), context.project);
  return compactObject({
    ...context,
    repo: context.repo ?? projectSourceDefaults.repo,
    branch: context.branch ?? projectSourceDefaults.branch,
    baseBranch: context.baseBranch ?? projectSourceDefaults.baseBranch,
    issue: context.issue ?? projectSourceDefaults.issue,
    executorLimits,
    executorTemplateParameters,
  });
}

async function workspaceSecretExecutionOptions(
  options: HarnessServerOptions,
  context: Pick<HarnessWorkspaceContext, "tenant" | "project">,
): Promise<WorkspaceExecutionOptions | undefined> {
  if (!options.agentGitServiceTokenSecretRoot?.trim()) return undefined;
  const receipt = await readAgentGitServiceProjectProvisioningReceipt(options.workspaceRoot, context.tenant, context.project);
  if (!receipt) return undefined;
  const secret = await readAgentGitServiceAgentTokenSecret(options.agentGitServiceTokenSecretRoot, context.tenant, context.project, receipt.tokenEnvName);
  return secret === undefined
    ? undefined
    : {
        env: { [receipt.tokenEnvName]: secret },
        gitCredential: { tokenEnvName: receipt.tokenEnvName },
      };
}

function withWorkspaceSecretExecutionOptions(executor: WorkspaceExecutor, execution: WorkspaceExecutionOptions | undefined): WorkspaceExecutor {
  if (!execution) return executor;
  return {
    ...executor,
    prepare: executor.prepare === undefined
      ? undefined
      : (options?: WorkspaceExecutionOptions): Promise<void> =>
          executor.prepare!(mergeWorkspaceExecutionOptions(execution, options)),
    runCommand(command: string, timeoutMs?: number, signal?: AbortSignal, options?: WorkspaceExecutionOptions): Promise<CommandResult> {
      return executor.runCommand(command, timeoutMs, signal, mergeWorkspaceExecutionOptions(execution, options));
    },
    startSession: executor.startSession === undefined
      ? undefined
      : (command: string, options?: WorkspaceExecutionOptions): Promise<WorkspaceSession> | WorkspaceSession =>
          executor.startSession!(command, mergeWorkspaceExecutionOptions(execution, options)),
  };
}

function mergeWorkspaceExecutionOptions(
  secretExecution: WorkspaceExecutionOptions,
  options: WorkspaceExecutionOptions | undefined,
): WorkspaceExecutionOptions {
  return {
    ...secretExecution,
    ...options,
    env: { ...(secretExecution.env ?? {}), ...(options?.env ?? {}) },
    gitCredential: options?.gitCredential ?? secretExecution.gitCredential,
  };
}

async function runWorkspaceContext(
  url: URL,
  workspaceRoot: string,
  tenant: string,
  runId: string,
  options: HarnessServerOptions,
): Promise<HarnessWorkspaceContext> {
  const requestedProject = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  const runDir = join(workspaceRoot, tenant, requestedProject, ".loom", "runs", runId);
  const state = await readRunState(runDir, options);
  const metadata = state.metadata;
  const project = metadata?.project ?? ("project" in state ? state.project : requestedProject);
  const cwd = join(workspaceRoot, tenant, project);
  return {
    tenant,
    project,
    runId,
    cwd,
    repo: metadata?.repo,
    branch: metadata?.branch,
    baseBranch: metadata?.baseBranch,
    issue: metadata?.issue,
  };
}

function workspaceFileRelativePath(rawPath: string, allowRoot: boolean): string {
  const normalizedInput = rawPath.replaceAll("\\", "/").trim();
  if (!normalizedInput) {
    if (allowRoot) return "";
    throw badRequest("path is required.");
  }
  if (normalizedInput.includes("\0") || normalizedInput.startsWith("/")) {
    throw badRequest("workspace file path must stay inside workspace.");
  }
  const relativePath = posix.normalize(normalizedInput);
  if (relativePath === "." || relativePath === ".." || relativePath.startsWith("../")) {
    if (allowRoot && relativePath === ".") return "";
    throw badRequest("workspace file path must stay inside workspace.");
  }
  if (relativePath.split("/").includes(".loom")) {
    throw badRequest("internal workspace path is not exposed by this endpoint.");
  }
  return relativePath;
}

function compactWorkspaceSessionSummary(summary: WorkspaceSessionSummary): WorkspaceSessionSummary {
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined)) as WorkspaceSessionSummary;
}

function compactWorkspaceCommandSummary(summary: WorkspaceCommandSummary): WorkspaceCommandSummary {
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined)) as WorkspaceCommandSummary;
}

function compactWorkspaceInfo(info: WorkspaceInfo): WorkspaceInfo {
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)) as WorkspaceInfo;
}

function compactWorkspaceDescription(description: WorkspaceDescription | undefined): WorkspaceDescription | undefined {
  if (!description) return undefined;
  return Object.fromEntries(Object.entries(description).filter(([, value]) => value !== undefined)) as WorkspaceDescription;
}

function workspaceDiffChangedFiles(diff: WorkspaceCommandResponse): RunChangedFileHint[] {
  const files: RunChangedFileHint[] = [];
  let current: RunChangedFileHint | undefined;
  for (const line of diff.stdout.split("\n")) {
    const args = workspaceDiffGitArgs(line);
    if (args) {
      const previousPath = workspaceDiffPath(args[0], "a/");
      const path = workspaceDiffPath(args[1], "b/") || previousPath;
      current = path ? { path, status: "modified" } : undefined;
      if (current) files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode") || line === "--- /dev/null") {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode") || line === "+++ /dev/null") {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.previousPath = unquoteWorkspaceDiffPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.status = "renamed";
      current.path = unquoteWorkspaceDiffPath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("copy from ")) {
      current.status = "copied";
      current.previousPath = unquoteWorkspaceDiffPath(line.slice("copy from ".length));
      continue;
    }
    if (line.startsWith("copy to ")) {
      current.status = "copied";
      current.path = unquoteWorkspaceDiffPath(line.slice("copy to ".length));
    }
  }
  return files;
}

function workspaceDiffGitArgs(line: string): string[] | undefined {
  if (!line.startsWith("diff --git ")) return undefined;
  const args = splitWorkspaceDiffArgs(line.slice("diff --git ".length));
  return args.length >= 2 ? args.slice(0, 2) : undefined;
}

function splitWorkspaceDiffArgs(text: string): string[] {
  const args: string[] = [];
  let index = 0;
  while (index < text.length) {
    while (text[index] === " ") index += 1;
    if (index >= text.length) break;
    if (text[index] === "\"") {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === "\\" && end + 1 < text.length) {
          end += 2;
          continue;
        }
        if (text[end] === "\"") break;
        end += 1;
      }
      args.push(text.slice(index, Math.min(end + 1, text.length)));
      index = end + 1;
      continue;
    }
    let end = index;
    while (end < text.length && text[end] !== " ") end += 1;
    args.push(text.slice(index, end));
    index = end;
  }
  return args;
}

function workspaceDiffPath(value: string, prefix: "a/" | "b/"): string {
  const path = unquoteWorkspaceDiffPath(value);
  if (!path || path === "/dev/null") return "";
  return path.startsWith(prefix) ? path.slice(prefix.length) : "";
}

function unquoteWorkspaceDiffPath(value: string): string {
  const text = String(value || "").trim();
  if (!text.startsWith("\"")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(1, -1);
  }
}

async function listWorkspaceTenantNames(workspaceRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isSafeTenantDirectoryName(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function workspaceCommitMessage(value: unknown): string {
  const message = requireString(value, "message").trim();
  if (message.length > 200 || /[\0\r\n]/.test(message)) {
    throw badRequest("message must be a single-line string at most 200 characters.");
  }
  return message;
}

async function workspaceFileActiveEditors(
  presence: RunPresenceRegistry,
  context: HarnessWorkspaceContext,
  route: WorkspaceCommandRoute,
  relativePath: string,
  clientId: string | undefined,
): Promise<RunPresenceEntry[]> {
  if (route.kind === "run") {
    await refreshRunPresenceFromDisk(presence, context.cwd, context.tenant, context.project, route.runId);
  } else {
    await refreshProjectPresenceFromDisk(presence, context.cwd, context.tenant, context.project);
  }
  purgeExpiredRunPresence(presence);
  const focus = `file:${relativePath}`;
  const entries = route.kind === "run"
    ? runPresenceEntries(presence, context.tenant, context.project, route.runId)
    : projectPresenceEntries(presence, context.tenant, context.project);
  return entries
    .filter((entry) => entry.clientId !== clientId)
    .filter((entry) => entry.focus === focus);
}

function workspaceRouteKey(
  options: HarnessServerOptions,
  context: Pick<HarnessWorkspaceContext, "tenant" | "project">,
  route: WorkspaceCommandRoute | ActiveWorkspaceSession["route"],
): string {
  return route.kind === "run" && runWorkspacesAreIsolated(options)
    ? activeWorkspaceKey(context.tenant, context.project, route.runId)
    : activeWorkspaceKey(context.tenant, context.project);
}

function activeRunWorkspaceKey(options: HarnessServerOptions, tenant: string, project: string, runId: string): string {
  return activeWorkspaceKey(tenant, project, runWorkspacesAreIsolated(options) ? runId : undefined);
}

function activeRunWorkspaceLeaseKey(options: HarnessServerOptions, tenant: string, project: string, runId: string): string {
  return runWorkspacesAreIsolated(options) ? `${tenant}/${project}/${runId}` : `${tenant}/${project}`;
}

function runWorkspacesAreIsolated(options: HarnessServerOptions): boolean {
  return runWorkspaceIsolation(options) === "run";
}

function runWorkspaceIsolation(options: HarnessServerOptions): RunWorkspaceIsolation {
  return options.runWorkspaceIsolation ?? "project";
}

function activeWorkspaceKey(tenant: string, project: string, runId?: string): string {
  return runId === undefined ? `${tenant}\0${project}` : `${tenant}\0${project}\0${runId}`;
}

export type { RunWorkspaceIsolation, HarnessWorkspaceContext } from "./types.js";
export { WorkspaceFileWriteRequestBody, WorkspaceFileMoveRequestBody, WorkspaceCommandRequestBody, WorkspaceCommitRequestBody, WorkspacePullRequestRequestBody, WorkspaceSessionRequestBody, WorkspaceSessionInputRequestBody, WorkspaceClientRequestBody, ActiveWorkspaceSession, WorkspaceSessionSummary, WorkspaceCommandSummary, WorkspaceCommandResponse, WorkspaceInfo, WORKSPACE_FILE_READ_LIMIT_BYTES, WORKSPACE_FILE_WRITE_LIMIT_BYTES, WORKSPACE_OUTPUT_LIMIT_BYTES, WORKSPACE_SESSION_INPUT_LIMIT_BYTES, DEFAULT_MAX_WORKSPACE_SESSIONS, workspaceSessionLimit, tenantWorkspaceSessionLimit, effectiveTenantWorkspaceSessionLimit, workspaceCommandTimeoutMs, workspaceSessionIdleTimeoutMs, workspaceDirectoryUsageBytes, activeWorkspaceSessionDetails, statusActiveWorkspaceSessionDetails, handleRunWorkspaceCommand, handleRunScopedWorkspaceCommand, handleCreateWorkspaceCommit, handleCreateRunWorkspaceCommit, handleCreateWorkspacePullRequest, handleCreateRunWorkspacePullRequest, handleListWorkspaceCommands, handleListRunWorkspaceCommands, handleCreateWorkspaceSession, handleCreateRunWorkspaceSession, handleListWorkspaceSessions, handleListRunWorkspaceSessions, handleWriteWorkspaceSessionInput, handleStopWorkspaceSession, handleReadWorkspaceSessionEvents, clearWorkspaceSessionIdleTimer, runWorkspaceSessionRoot, runWorkspaceCommandRoot, readWorkspaceCommandSummaries, readWorkspaceSessionSummaries, handleWriteWorkspaceFile, handleWriteRunWorkspaceFile, handleDeleteWorkspaceFile, handleMoveWorkspaceFile, handleMoveRunWorkspaceFile, handleDeleteRunWorkspaceFile, handleReadRunWorkspaceInfo, handleReadRunWorkspaceDiff, workspaceDiff, workspaceInfo, handleReadWorkspaceFile, handleReadRunWorkspaceFile, handleListTenantWorkspaceUsageWarnings, workspaceSessionActivityAt, workspaceExecutor, runWorkspaceContext, compactWorkspaceSessionSummary, workspaceDiffChangedFiles, listWorkspaceTenantNames, activeRunWorkspaceKey, activeRunWorkspaceLeaseKey, runWorkspacesAreIsolated, runWorkspaceIsolation };
