import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";
import { createAgentWithSetupSteps, createCommandAgent, createScriptedAgentFromSteps, type AgentStep, type HarnessAgent } from "../agents.js";
import { type TenantAuditActor, type TenantAuditAppender, type TenantAuditEvent, type TenantRole } from "../audit.js";
import { makeRunId, runHarness, type RunPauseRequest, type RunRequester } from "../loop.js";
import { scrubSecretText } from "../redact.js";
import { createOpenAiCompatibleAgent, type ModelAgentProtocol } from "../model-agent.js";
import { appendRunEvent, readRunEvents } from "../run-store.js";
import { readQueuedRunSnapshot as loadQueuedRunSnapshot, readRunState as loadRunState, readRunStateIfPresent as loadRunStateIfPresent, listStoredRunStates, writeQueuedRunSnapshot as persistQueuedRunSnapshot, writeRunStatus as persistRunStatus, writeRunSummary as persistRunSummary, type QueuedRunBlockedReason, type QueuedRunConcurrencySummary, type QueuedRunSnapshot, type QueuedRunStatus, type ReadableRunState, type RunningRunStatus } from "../run-state.js";
import type { HarnessEvent, ProjectContractEvidence, ProjectContractPatch, ProjectContractStatusEvidence, ProjectRunPolicyEvidence, RunMetadata, RunRequesterSummary, RunSummary } from "../events.js";
import { ensureProjectTemplateMetadata, projectMetadataDefaultSkills, readProjectTemplateMetadata } from "../project-templates.js";
import { StateConflictError } from "../storage/contracts.js";
import { RunAdmissionClaimHandle, QueuedRunAdmission, runHeartbeatIntervalMs, runningRunStatusWithLease, refreshRunningRunLease, runningRunIsStale, tryAcquireActiveRunAdmission, startRunAdmissionClaimHeartbeat, runAdmissionHeartbeatError, persistedRunningRunHasActiveAdmissionClaim, queuedAdmissionTenantActiveRunLimit, queuedAdmissionProjectActiveWorkspace, queuedAdmissionPersistedRunningRun, queuedAdmissionAuditData } from "./admission.js";
import { workspaceExecutor, activeRunWorkspaceKey, runWorkspacesAreIsolated } from "./workspace.js";
import { InitialIssueCommentEventsResult, RunHandoffFollowupEvidence, issueCommentSyncContextForOptions, appendInitialIssueCommentSyncAuditEvent, applyProjectContractStatusGate, initialIssueCommentEventsForRun } from "./gates.js";
import { queuedRunResourceStatus, controlPlaneIssueUrl, controlPlaneProviderName } from "./status.js";
import { VasLiteReviewPresetInput, VAS_LITE_REVIEW_PRESET, VAS_LITE_REVIEW_VERIFY_COMMANDS, requireVasLiteProject, vasLiteReviewPresetInput, readVasLiteCase, listVasLiteLearnings, vasLiteReviewGuidance, vasLiteReviewGoal, vasLiteReviewScript, vasLiteReviewContextStep } from "./vas.js";
import { ProjectSummary, readProjectSummary, ProjectSourceDefaultValues, applyProjectRunPolicy, readProjectContractEvidence, readProjectContractStatusEvidence, readProjectSourceDefaults, runProjectQuery, listTenantProjectNames, isProjectDirectoryName, runPresenceRootFromProjectRoot, projectPresenceKey, projectPresenceEntries, projectModelUsageRequesterKey, projectModelUsageRequesterLabel, projectContractPatchField } from "./projects.js";
import { TenantAccess, effectiveTenantAllowedTools, tenantRoleField, readTenantPolicy, tenantPolicyRole, requireTenantAccess, isSafeTenantDirectoryName, isTenantRole, brainSignalAuditData } from "./tenants.js";
import { HarnessServerOptions } from "./types.js";
import { CancelRequestBody, delay, hasRequestValue, optionalSourceRepo, optionalSourceGitRef, optionalSourceIssue, compactObject, compactMetadata, writeJsonFileAtomic, seqAfter, filterEvents, boundedDiagnosticText, isSensitiveDiagnosticKey, recordData, stringField, booleanField, numberField, stringArrayField, replayText, requireSafeName, optionalSafeName, requireString, optionalString, optionalClientId, optionalClientRequestId, isSafeDirectoryName, envNameValue, stringArray, allowedToolSubset, booleanFlag, positiveInt, badRequest, conflict, notFound, writeJson, isNotFound, isAlreadyExists, startedAt, readJsonBody } from "./shared.js";

async function streamEvents(res: ServerResponse, runDir: string, after: number, options: HarnessServerOptions): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders();

  let lastSeq = after;
  const deadline = Date.now() + 60_000;

  while (!res.destroyed && Date.now() < deadline) {
    const allEvents = await readRunEventsIfPresent(runDir, options);
    const events = filterEvents(allEvents, lastSeq);
    for (const event of events) {
      lastSeq = Math.max(lastSeq, event.seq);
      res.write(`event: harness_event\n`);
      res.write(`id: ${event.seq}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const latestEvent = latestRunEvent(allEvents);
    const state = await readRunStateIfPresent(runDir, options);
    if (shouldCloseRunEventStream(state, latestEvent, lastSeq)) {
      res.end();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  res.end();
}

async function readCancelJson(req: IncomingMessage): Promise<CancelRequestBody> {
  return readJsonBody<CancelRequestBody>(req);
}

async function readRunCommentJson(req: IncomingMessage): Promise<RunCommentRequestBody> {
  return readJsonBody<RunCommentRequestBody>(req);
}

async function readRunResumeJson(req: IncomingMessage): Promise<RunResumeRequestBody> {
  return readJsonBody<RunResumeRequestBody>(req);
}

async function readPresenceJson(req: IncomingMessage): Promise<PresenceRequestBody> {
  return readJsonBody<PresenceRequestBody>(req);
}

interface RunRequestBody {
  tenant?: unknown;
  project?: unknown;
  clientRequestId?: unknown;
  preset?: unknown;
  presetInput?: unknown;
  goal?: unknown;
  script?: unknown;
  agentCommand?: unknown;
  model?: unknown;
  modelProtocol?: unknown;
  repo?: unknown;
  branch?: unknown;
  baseBranch?: unknown;
  issue?: unknown;
  pullRequest?: unknown;
  reviewRequired?: unknown;
  deploymentRequired?: unknown;
  verify?: unknown;
  evaluate?: unknown;
  reviewer?: unknown;
  skills?: unknown;
  allowedTools?: unknown;
  maxIterations?: unknown;
  async?: unknown;
  queue?: unknown;
  syncIssueComments?: unknown;
  clientId?: unknown;
  __presetSetupSteps?: AgentStep[];
}

type RunPresetName = "vas-lite-review";

interface RunCommentRequestBody {
  message?: unknown;
  pause?: unknown;
  clientId?: unknown;
}

interface RunResumeRequestBody {
  clientId?: unknown;
}

interface PresenceRequestBody {
  clientId?: unknown;
  label?: unknown;
  focus?: unknown;
}

interface RunEventContext {
  actor?: string;
  role?: TenantRole;
  clientId?: string;
}

interface RunCancelRequest extends RunEventContext {
  reason?: string;
}

interface LinkedIssueRun {
  project: string;
  runId: string;
  runDir: string;
  state: ReadableRunState;
}

interface InitialRunEvent {
  type: "user_message";
  data: Record<string, unknown>;
}

interface HarnessRunStart {
  tenant: string;
  project: string;
  runId: string;
  goal: string;
  cwd: string;
  runRoot: string;
  runDir: string;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  verifyCommands: string[];
  evaluationCommands: string[];
  reviewerCommands: string[];
  agent: HarnessAgent;
  skills: string[];
  maxIterations: number;
  allowedTools: string[];
  metadata: RunMetadata;
  reviewRequired: boolean;
  deploymentRequired: boolean;
  pullRequest: boolean;
  requester?: RunRequester;
  resumeRequester?: RunRequester;
  access?: TenantAccess;
  resume?: boolean;
  startedAt?: string;
}

interface QueuedRun extends HarnessRunStart {
  status: QueuedRunStatus;
  access?: TenantAccess;
}

type HarnessQueuedRunSnapshot = QueuedRunSnapshot<RunRequestBody, RunRequester>;

interface DistributedQueuedRunEnvelope {
  status: QueuedRunStatus;
  snapshot: HarnessQueuedRunSnapshot;
}

interface RunCreateRequestRecord {
  schemaVersion: 1;
  tenant: string;
  project: string;
  clientRequestId: string;
  requestHash: string;
  runId: string;
  runDir: string;
  statusCode: number;
  createdAt: string;
}

interface ActiveRun {
  controller: AbortController;
  completion: Promise<RunSummary>;
}

interface ActiveRunSlot {
  tenant: string;
  project: string;
  runId: string;
}

interface RunCreateIdempotencyStatus {
  clientRequestId: true;
  sharedRunStore: true;
  crossServerReplay: true;
  simultaneousCreateReplay: true;
  conflictOnRequestMismatch: true;
}

interface QueueRecoveryAudit {
  status: "pending" | "completed" | "error";
  scannedQueuedRuns: number;
  recoveredQueuedRuns: number;
  failedQueuedRuns: number;
  errors: QueueRecoveryError[];
  startedAt: string;
  endedAt?: string;
  message?: string;
}

interface QueueRecoveryError {
  tenant?: string;
  project?: string;
  runId?: string;
  message: string;
}

interface StaleRunCleanupAudit {
  status: "disabled" | "pending" | "completed" | "error";
  scannedRunningRuns: number;
  abandonedStaleRuns: number;
  skippedRunningRuns: number;
  errors: StaleRunCleanupError[];
  startedAt?: string;
  endedAt?: string;
  message?: string;
}

interface StaleRunCleanupError {
  tenant?: string;
  project?: string;
  runId?: string;
  message: string;
}

interface RunReplay {
  runId: string;
  goal: string;
  status: ReadableRunState["status"];
  metadata?: RunMetadata;
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  checkpoint: RunEvidenceCheckpoint;
  timeline: RunReplayEntry[];
}

interface RunEvidenceCheckpoint {
  schemaVersion: 1;
  version: string;
  run: {
    runId: string;
    status: ReadableRunState["status"];
    eventCount: number;
    lastEventSeq?: number;
    lastEventAt?: string;
  };
  audit?: {
    eventCount: number;
    lastSeq?: number;
    lastEventAt?: string;
  };
  followups?: {
    count: number;
    runIds: string[];
  };
}

interface RunReplayEntry {
  seq: number;
  ts: string;
  type: HarnessEvent["type"];
  title: string;
  detail?: string;
  requester?: RunRequesterSummary;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  toolName?: string;
  actionId?: string;
  ok?: boolean;
  status?: string;
  iteration?: number;
  actionCount?: number;
  finishRequested?: boolean;
  phase?: string;
  plan?: string;
  contractPatch?: ProjectContractPatch;
  runReviewContractPatch?: ProjectContractPatch;
}

type RunChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

interface RunChangedFileHint {
  path: string;
  status: RunChangedFileStatus;
  previousPath?: string;
}

interface RunExternalEffectEvidence {
  seq: number;
  ts: string;
  kind?: string;
  requester?: RunRequesterSummary;
  issue?: string;
  issueUrl?: string;
  dashboardUrl?: string;
  summaryUrl?: string;
  reviewSummaryUrl?: string;
  handoffPackageUrl?: string;
  branch?: string;
  baseBranch?: string;
  commit?: string;
  pullRequestIndex?: number;
  pullRequestUrl?: string;
  clientId?: string;
  status?: string;
  outcome?: string;
  failureKind?: string;
  reviewerStatus?: string;
  reviewerExitCode?: number;
  reviewerCommands?: string[];
  skillCount?: number;
}

interface RunPresenceEntry {
  tenant: string;
  project: string;
  runId?: string;
  clientId: string;
  label: string;
  focus?: string;
  actor?: string;
  role?: TenantRole;
  seenAt: string;
  expiresAt: string;
}

interface StoredRunPresenceEntry extends RunPresenceEntry {
  expiresAtMs: number;
}

type RunPresenceRegistry = Map<string, StoredRunPresenceEntry>;
const RUN_PRESENCE_TTL_MS = 45_000;
const RUN_PAUSE_REQUEST_FILE = "pause-request.json";
const RUN_CANCEL_REQUEST_FILE = "cancel-request.json";
const RUN_CONTROL_POLL_INTERVAL_MS = 250;
const DISTRIBUTED_RUN_QUEUE = "harness-runs";
const DISTRIBUTED_RUN_QUEUE_CLAIM_TTL_MS = 120_000;
const DISTRIBUTED_RUN_QUEUE_POLL_MS = 250;
const RUN_CREATE_REQUEST_REPLAY_TIMEOUT_MS = 30_000;
const RUN_CREATE_REQUEST_REPLAY_POLL_MS = 10;

function tenantActiveRunLimit(options: HarnessServerOptions): number | undefined {
  return options.maxTenantActiveRuns;
}

async function effectiveTenantActiveRunLimit(options: HarnessServerOptions, tenant: string): Promise<number | undefined> {
  const policy = await readTenantPolicy(resolve(options.workspaceRoot), tenant, options);
  return policy?.limits?.maxActiveRuns ?? tenantActiveRunLimit(options);
}

function tenantRunCapacityScope(tenant: string): string {
  return `tenant-runs:${tenant}`;
}

function activeTenantRunCount(activeRunSlots: Map<string, ActiveRunSlot>, tenant: string): number {
  return [...activeRunSlots.values()].filter((run) => run.tenant === tenant).length;
}

function activeTenantRunIds(activeRunSlots: Map<string, ActiveRunSlot>, tenant: string): string[] {
  return [...activeRunSlots.values()].filter((run) => run.tenant === tenant).map((run) => run.runId);
}

function queuedTenantRunCount(queuedRuns: QueuedRun[], tenant: string): number {
  return queuedRuns.filter((run) => run.tenant === tenant).length;
}

async function enforceModelUsageTokenLimitsForRun(
  workspaceRoot: string,
  options: HarnessServerOptions,
  run: Pick<HarnessRunStart, "tenant" | "project" | "metadata" | "requester">,
): Promise<void> {
  if (run.metadata.agentMode !== "model") return;
  await enforceModelUsageTokenLimits(workspaceRoot, options, run.tenant, run.project, run.requester);
}

function activeRunCollaboratorSummary(
  presence: RunPresenceRegistry,
  tenant: string,
  project: string,
): Partial<Pick<ProjectSummary, "activeRunCollaboratorCount" | "activeRunCollaborators">> {
  purgeExpiredRunPresence(presence);
  const collaborators = projectPresenceEntries(presence, tenant, project);
  if (!collaborators.length) return {};
  return {
    activeRunCollaboratorCount: collaborators.length,
    activeRunCollaborators: collaborators,
  };
}

function nextQueuedRunPositions(queuedRuns: QueuedRun[], run: Pick<QueuedRun, "tenant" | "project">): Pick<QueuedRunStatus, "tenantQueuePosition" | "projectQueuePosition"> {
  return {
    tenantQueuePosition: queuedRuns.filter((queuedRun) => queuedRun.tenant === run.tenant).length + 1,
    projectQueuePosition: queuedRuns.filter((queuedRun) => queuedRun.tenant === run.tenant && queuedRun.project === run.project).length + 1,
  };
}

function queuedRunPositions(
  queuedRuns: QueuedRun[],
  run: Pick<QueuedRun, "tenant" | "project" | "runId"> & Partial<Pick<QueuedRunStatus, "tenantQueuePosition" | "projectQueuePosition">>,
): Pick<QueuedRunStatus, "tenantQueuePosition" | "projectQueuePosition"> {
  let tenantQueuePosition = 0;
  let projectQueuePosition = 0;
  for (const queuedRun of queuedRuns) {
    if (queuedRun.tenant === run.tenant) tenantQueuePosition += 1;
    if (queuedRun.tenant === run.tenant && queuedRun.project === run.project) projectQueuePosition += 1;
    if (queuedRun.tenant === run.tenant && queuedRun.project === run.project && queuedRun.runId === run.runId) {
      return { tenantQueuePosition, projectQueuePosition };
    }
  }
  return compactObject({
    tenantQueuePosition: run.tenantQueuePosition,
    projectQueuePosition: run.projectQueuePosition,
  });
}

function queuedRunConcurrencySummary(
  blockedReason: QueuedRunBlockedReason,
  blockedByRunIds?: string[],
  evidence: Partial<QueuedRunConcurrencySummary> = {},
): QueuedRunConcurrencySummary {
  const state: QueuedRunConcurrencySummary["state"] = blockedReason === "ready" ? "ready" : "blocked";
  return compactObject({
    state,
    blockedReason,
    blockedByRunIds: blockedByRunIds && blockedByRunIds.length > 0 ? blockedByRunIds : undefined,
    ...evidence,
  }) as QueuedRunConcurrencySummary;
}

async function handleListRuns(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  queuedRuns: QueuedRun[],
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  const runsRoot = join(workspaceRoot, tenant, project, ".loom", "runs");

  try {
    const states = await readRunStatesForListing(runsRoot, tenant, project, options);
    states.sort((a, b) => startedAt(b).localeCompare(startedAt(a)));
    writeJson(res, 200, await runStatesForReadResponse(states, workspaceRoot, options, activeRunSlots, activeWorkspaces, queuedRuns));
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 200, []);
      return true;
    }
    throw error;
  }
}

async function handleCreateRun(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  queuedRuns: QueuedRun[],
  scheduleQueuedRuns: () => void,
  appendAuditEvent: TenantAuditAppender,
): Promise<void> {
  const body = await readJson(req);
  const tenant = requireSafeName(body.tenant, "tenant");
  const access = await requireTenantAccess(req, tenant, options, undefined, "developer");
  const project = optionalSafeName(body.project, "project") ?? "default";
  const projectRunPolicy = await applyProjectRunPolicy(workspaceRoot, tenant, project, body);
  const effectiveBody = projectRunPolicy.body;
  const preset = runPresetName(effectiveBody.preset);
  const cwd = join(workspaceRoot, tenant, project);
  if (preset !== VAS_LITE_REVIEW_PRESET) {
    await ensureProjectTemplateMetadata(cwd, { tenant, project, template: "empty" });
  }
  const projectContract = await readProjectContractEvidence(workspaceRoot, tenant, project);
  const projectContractStatus = await readProjectContractStatusEvidence(workspaceRoot, tenant, project);
  const presetBody = await applyRunPreset(effectiveBody, preset, workspaceRoot, tenant, project);
  const gatedBody = applyProjectContractStatusGate(presetBody, projectContractStatus);
  const runSource = runSourceFromBody(gatedBody, await readProjectSourceDefaults(join(workspaceRoot, tenant), project));
  const snapshotBody = runRequestWithResolvedSource(gatedBody, runSource);
  const presetInput = runPresetInputForMetadata(preset, gatedBody.presetInput);
  const goal = requireString(gatedBody.goal, "goal");
  const { repo, branch, baseBranch, issue } = runSource;
  const pullRequest = booleanFlag(gatedBody.pullRequest, "pullRequest");
  const reviewRequired = booleanFlag(gatedBody.reviewRequired, "reviewRequired");
  const deploymentRequired = booleanFlag(gatedBody.deploymentRequired, "deploymentRequired");
  const clientId = optionalClientId(gatedBody.clientId);
  const clientRequestId = optionalClientRequestId(gatedBody.clientRequestId);
  const requester = runRequester(access, clientId);
  const syncIssueComments = booleanFlag(gatedBody.syncIssueComments, "syncIssueComments");
  if (pullRequest && (!issue || !branch)) {
    throw badRequest("pullRequest requires issue and branch.");
  }
  if (pullRequest && !options.pullRequestReporter) {
    throw badRequest("pullRequest requires a pull request reporter.");
  }
  const verifyCommands = stringArray(gatedBody.verify, "verify");
  const evaluationCommands = stringArray(gatedBody.evaluate, "evaluate");
  const reviewerCommands = stringArray(gatedBody.reviewer, "reviewer");
  const skills = await runSkillsForRequest(workspaceRoot, tenant, project, gatedBody);
  const allowedTools = allowedToolSubset(gatedBody.allowedTools, await effectiveTenantAllowedTools(options, tenant));
  const asyncRequested = gatedBody.async === true;
  const queueRequested = booleanFlag(gatedBody.queue, "queue");
  if (queueRequested && !asyncRequested) {
    throw badRequest("queue requires async.");
  }
  await enforceModelUsageTokenLimitsForBody(workspaceRoot, options, tenant, project, gatedBody, requester);
  const agent = await createAgent(gatedBody, cwd, options, tenant, access);
  const maxIterations = positiveInt(gatedBody.maxIterations, options.defaultMaxIterations ?? 20);
  const runRoot = join(cwd, ".loom", "runs");
  const requestHash = clientRequestId ? runCreateRequestHash(snapshotBody, requester) : undefined;
  const runId = makeRunId();
  const runDir = join(runRoot, runId);
  let runCreateRequestRecord = clientRequestId && requestHash
    ? createRunCreateRequestRecord(tenant, project, clientRequestId, requestHash, runId, runDir, asyncRequested ? 202 : 201)
    : undefined;
  let runCreateRequestRecordOwned = false;
  if (runCreateRequestRecord) {
    const claim = await claimRunCreateRequestRecord(runRoot, runCreateRequestRecord, options);
    if (!claim.created) {
      writeJson(res, claim.replay.statusCode, claim.replay.body);
      return;
    }
    runCreateRequestRecord = claim.record;
    runCreateRequestRecordOwned = true;
  }
  const releaseRunCreateRequestRecord = async () => {
    if (runCreateRequestRecordOwned) await deleteRunCreateRequestRecord(runRoot, runCreateRequestRecord, options);
  };
  const metadata = runMetadata({ tenant, project, runId, repo, branch, baseBranch, issue, runPreset: preset, runPresetInput: presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, ...runAgentMetadata(gatedBody, options) }, options);
  const initialIssueComments = await initialIssueCommentEventsForRun(
    options,
    syncIssueComments,
    issue,
    metadata.issueUrl,
    issueCommentSyncContextForOptions(options, { access, clientId }),
    { tenant, project, runId },
  );
  const runKey = activeRunKey(tenant, project, runId);
	  const workspaceKey = activeRunWorkspaceKey(options, tenant, project, runId);
  const run: HarnessRunStart = {
    tenant,
    project,
    runId,
    goal,
    cwd,
    runRoot,
    runDir,
    repo,
    branch,
    baseBranch,
    verifyCommands,
    evaluationCommands,
    reviewerCommands,
    agent,
    skills,
    maxIterations,
    allowedTools,
    metadata,
    reviewRequired,
    deploymentRequired,
    pullRequest,
    requester,
    access,
  };
  const activeRunId = activeWorkspaces.get(workspaceKey);
    if (activeRunId) {
      if (queueRequested) {
        const status = await queueAsyncRun({ options, queuedRuns, appendAuditEvent, run, admission: queuedAdmissionProjectActiveWorkspace(activeRunId), statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: initialIssueComments.events, snapshotBody, syncIssueComments, issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
      await writeRunCreateRequestRecord(runRoot, runCreateRequestRecord, options);
      writeJson(res, 202, status);
      return;
    }
    await releaseRunCreateRequestRecord();
    throw conflict(`tenant project already has an active run: ${activeRunId}`);
  }
	  const persistedRunId = await findBlockingPersistedRunningRun(options, runRoot);
  if (persistedRunId) {
    if (queueRequested) {
      const status = await queueAsyncRun({ options, queuedRuns, appendAuditEvent, run, admission: queuedAdmissionPersistedRunningRun(persistedRunId), statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: initialIssueComments.events, snapshotBody, syncIssueComments, issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
      await writeRunCreateRequestRecord(runRoot, runCreateRequestRecord, options);
      writeJson(res, 202, status);
      return;
    }
    await releaseRunCreateRequestRecord();
    throw conflict(`tenant project already has an active run: ${persistedRunId}`);
  }
  const tenantRunLimit = await effectiveTenantActiveRunLimit(options, tenant);
  const tenantRunIds = tenantRunLimit !== undefined ? activeTenantRunIds(activeRunSlots, tenant) : [];
  if (tenantRunLimit !== undefined && tenantRunIds.length >= tenantRunLimit) {
    if (queueRequested) {
      const status = await queueAsyncRun({ options, queuedRuns, appendAuditEvent, run, admission: queuedAdmissionTenantActiveRunLimit(tenantRunIds, tenantRunLimit), statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: initialIssueComments.events, snapshotBody, syncIssueComments, issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
      await writeRunCreateRequestRecord(runRoot, runCreateRequestRecord, options);
      writeJson(res, 202, status);
      return;
    }
    await releaseRunCreateRequestRecord();
    throw conflict("active run tenant limit reached");
  }

  const admissionClaim = await tryAcquireActiveRunAdmission(options, run, tenantRunLimit);
  if (!admissionClaim.ok) {
    if (queueRequested) {
      const status = await queueAsyncRun({ options, queuedRuns, appendAuditEvent, run, admission: admissionClaim.admission, statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: initialIssueComments.events, snapshotBody, syncIssueComments, issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
      await writeRunCreateRequestRecord(runRoot, runCreateRequestRecord, options);
      writeJson(res, 202, status);
      return;
    }
    await releaseRunCreateRequestRecord();
    throw admissionClaim.error;
  }

  if (asyncRequested) {
    let claimOwnedByRun = false;
    try {
      await mkdir(runDir, { recursive: true });
      await appendInitialRunEvents(runDir, initialIssueComments.events, options);
      await writeQueuedRunSnapshot(runDir, snapshotBody, requester, options);
      const status = await startAsyncRun(run, options, activeRuns, activeRunSlots, activeWorkspaces, scheduleQueuedRuns, appendAuditEvent, admissionClaim.handle);
      claimOwnedByRun = true;
    await appendAuditEvent(tenant, "run_created", compactObject({
      project,
      runId,
      preset,
      presetInput,
      projectRunPolicy: projectRunPolicy.evidence,
      projectContract,
      projectContractStatus,
      goal,
      status: status.status,
      async: true,
      queued: false,
      clientId,
    }), access);
    if (syncIssueComments && issue) {
      await appendInitialIssueCommentSyncAuditEvent(appendAuditEvent, tenant, access, project, runId, issue, metadata.issueUrl, initialIssueComments, clientId, preset, presetInput);
    }
    await writeRunCreateRequestRecord(runRoot, runCreateRequestRecord, options);
    writeJson(res, 202, status);
    return;
    } catch (error) {
      if (!claimOwnedByRun) await releaseRunCreateRequestRecord();
      throw error;
    } finally {
      if (!claimOwnedByRun) await admissionClaim.handle.release();
    }
  }

  activeWorkspaces.set(workspaceKey, runId);
  activeRunSlots.set(runKey, { tenant, project, runId });
  const admissionController = new AbortController();
  const stopAdmissionHeartbeat = startRunAdmissionClaimHeartbeat(options, admissionClaim.handle, (error) => {
    admissionController.abort(runAdmissionHeartbeatError(error));
  });
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await appendInitialRunEvents(runDir, initialIssueComments.events, options);
    const executor = await workspaceExecutor(options, { tenant, project, runId, cwd, repo, branch, baseBranch });

    const summary = await runHarness({
      runId,
      goal,
      cwd,
      runRoot,
      verifyCommands,
      evaluationCommands,
      reviewerCommands,
      agent,
      skills,
      maxIterations,
      allowedTools,
      executor,
      metadata,
      reviewRequired,
      deploymentRequired,
      requester,
      signal: admissionController.signal,
      stateBackend: options.stateBackend,
    });
    const reported = await finalizeRun(options, summary, pullRequest, appendAuditEvent);

    await appendAuditEvent(tenant, "run_created", compactObject({
      project,
      runId,
      preset,
      presetInput,
      projectRunPolicy: projectRunPolicy.evidence,
      projectContract,
      projectContractStatus,
      goal,
      status: reported.status,
      async: false,
      queued: false,
      clientId,
    }), access);
    if (syncIssueComments && issue) {
      await appendInitialIssueCommentSyncAuditEvent(appendAuditEvent, tenant, access, project, runId, issue, metadata.issueUrl, initialIssueComments, clientId, preset, presetInput);
    }
    await writeRunCreateRequestRecord(runRoot, runCreateRequestRecord, options);
    writeJson(res, 201, reported);
  } finally {
    stopAdmissionHeartbeat();
    activeRunSlots.delete(runKey);
    activeWorkspaces.delete(workspaceKey);
    await admissionClaim.handle.release();
    scheduleQueuedRuns();
  }
}

async function createAsyncRunFromBody(
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  queuedRuns: QueuedRun[],
  scheduleQueuedRuns: () => void,
  appendAuditEvent: TenantAuditAppender,
  body: RunRequestBody,
  access: TenantAccess | undefined,
  initialEvents: InitialRunEvent[] = [],
  metadataOverrides: Partial<RunMetadata> = {},
): Promise<RunningRunStatus | QueuedRunStatus> {
  const tenant = requireSafeName(body.tenant, "tenant");
  const project = optionalSafeName(body.project, "project") ?? "default";
  const projectRunPolicy = await applyProjectRunPolicy(workspaceRoot, tenant, project, body);
  const policyBody = projectRunPolicy.body;
  const preset = runPresetName(policyBody.preset);
  const cwd = join(workspaceRoot, tenant, project);
  if (preset !== VAS_LITE_REVIEW_PRESET) {
    await ensureProjectTemplateMetadata(cwd, { tenant, project, template: "empty" });
  }
  const projectContract = await readProjectContractEvidence(workspaceRoot, tenant, project);
  const projectContractStatus = await readProjectContractStatusEvidence(workspaceRoot, tenant, project);
  const effectiveBody = await applyRunPreset(policyBody, preset, workspaceRoot, tenant, project);
  const gatedBody = applyProjectContractStatusGate(effectiveBody, projectContractStatus);
  const runSource = runSourceFromBody(gatedBody, await readProjectSourceDefaults(join(workspaceRoot, tenant), project));
  const snapshotBody = runRequestWithResolvedSource(gatedBody, runSource);
  const presetInput = runPresetInputForMetadata(preset, gatedBody.presetInput);
  const goal = requireString(gatedBody.goal, "goal");
  const clientId = optionalClientId(gatedBody.clientId);
  const requester = runRequester(access, clientId);
  const syncIssueComments = booleanFlag(gatedBody.syncIssueComments, "syncIssueComments");
  if (gatedBody.async !== true) {
    throw badRequest("async run creation requires async.");
  }
  await enforceModelUsageTokenLimitsForBody(workspaceRoot, options, tenant, project, gatedBody, requester);
  const queueRequested = booleanFlag(gatedBody.queue, "queue");
  const runId = makeRunId();
  const runRoot = join(cwd, ".loom", "runs");
  const runDir = join(runRoot, runId);
  const metadata = runMetadata({
    tenant,
    project,
    runId,
    ...runSource,
    runPreset: preset,
    runPresetInput: presetInput,
    projectRunPolicy: projectRunPolicy.evidence,
    projectContract,
    projectContractStatus,
    ...runAgentMetadata(gatedBody, options),
    ...metadataOverrides,
  }, options);
  const run = {
    ...(await harnessRunStartFromSnapshot(
    workspaceRoot,
    options,
    { runId, tenant, project, goal, runDir, metadata },
    { schemaVersion: 1, request: snapshotBody, requester },
    )),
    access,
  };
  const initialIssueComments = await initialIssueCommentEventsForRun(
    options,
    syncIssueComments,
    runSource.issue,
    metadata.issueUrl,
    issueCommentSyncContextForOptions(options, { access, clientId }),
    { tenant, project, runId },
  );
  const runInitialEvents = [
    ...initialEvents,
    ...initialIssueComments.events,
  ];
  const runKey = activeRunKey(tenant, project, runId);
	  const workspaceKey = activeRunWorkspaceKey(options, tenant, project, runId);
  const activeRunId = activeWorkspaces.get(workspaceKey);
  if (activeRunId) {
    if (queueRequested) {
      return queueAsyncRun({ options, queuedRuns, appendAuditEvent, run, admission: queuedAdmissionProjectActiveWorkspace(activeRunId), statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: runInitialEvents, snapshotBody, syncIssueComments, issue: runSource.issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
    }
    throw conflict(`tenant project already has an active run: ${activeRunId}`);
  }
	  const persistedRunId = await findBlockingPersistedRunningRun(options, runRoot);
  if (persistedRunId) {
    if (queueRequested) {
      return queueAsyncRun({ options, queuedRuns, appendAuditEvent, run, admission: queuedAdmissionPersistedRunningRun(persistedRunId), statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: runInitialEvents, snapshotBody, syncIssueComments, issue: runSource.issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
    }
    throw conflict(`tenant project already has an active run: ${persistedRunId}`);
  }
  const tenantRunLimit = await effectiveTenantActiveRunLimit(options, tenant);
  const tenantRunIds = tenantRunLimit !== undefined ? activeTenantRunIds(activeRunSlots, tenant) : [];
  if (tenantRunLimit !== undefined && tenantRunIds.length >= tenantRunLimit) {
    if (!queueRequested) throw conflict("active run tenant limit reached");
    return queueAsyncRun({ options, queuedRuns, appendAuditEvent, run, admission: queuedAdmissionTenantActiveRunLimit(tenantRunIds, tenantRunLimit), statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: runInitialEvents, snapshotBody, syncIssueComments, issue: runSource.issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
  }

  const admissionClaim = await tryAcquireActiveRunAdmission(options, run, tenantRunLimit);
  if (!admissionClaim.ok) {
    if (!queueRequested) throw admissionClaim.error;
    return queueAsyncRun({ options, queuedRuns, appendAuditEvent, run, admission: admissionClaim.admission, statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: runInitialEvents, snapshotBody, syncIssueComments, issue: runSource.issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
  }
  let claimOwnedByRun = false;
  try {
    await mkdir(runDir, { recursive: true });
    await appendInitialRunEvents(runDir, runInitialEvents, options);
    await writeQueuedRunSnapshot(runDir, snapshotBody, requester, options);
    const status = await startAsyncRun(run, options, activeRuns, activeRunSlots, activeWorkspaces, scheduleQueuedRuns, appendAuditEvent, admissionClaim.handle);
    claimOwnedByRun = true;
    await appendAuditEvent(tenant, "run_created", compactObject({
      project,
      runId,
      preset,
      presetInput,
      projectRunPolicy: projectRunPolicy.evidence,
      projectContract,
      projectContractStatus,
      goal,
      status: status.status,
      async: true,
      queued: false,
      clientId,
    }), access);
    if (syncIssueComments && runSource.issue) {
      await appendInitialIssueCommentSyncAuditEvent(appendAuditEvent, tenant, access, project, runId, runSource.issue, metadata.issueUrl, initialIssueComments, clientId, preset, presetInput);
    }
    if (!activeRuns.has(runKey)) {
      scheduleQueuedRuns();
    }
    return status;
  } finally {
    if (!claimOwnedByRun) await admissionClaim.handle.release();
  }
}

async function queueAsyncRun(input: {
  options: HarnessServerOptions;
  queuedRuns: QueuedRun[];
  appendAuditEvent: TenantAuditAppender;
  run: HarnessRunStart;
  admission: QueuedRunAdmission;
  statusInput: {
    tenant: string;
    project: string;
    runId: string;
    goal: string;
    metadata?: RunMetadata;
    requester?: RunRequester;
    runDir: string;
  };
  runDir: string;
  initialEvents: InitialRunEvent[];
  snapshotBody: RunRequestBody;
  syncIssueComments: boolean;
  issue?: string;
  issueUrl?: string;
  initialIssueComments: InitialIssueCommentEventsResult;
  preset: RunPresetName | undefined;
  presetInput: Record<string, unknown> | undefined;
  projectRunPolicy: ProjectRunPolicyEvidence | undefined;
  projectContract: ProjectContractEvidence | undefined;
  projectContractStatus: ProjectContractStatusEvidence | undefined;
  clientId: string | undefined;
  access: TenantAccess | undefined;
}): Promise<QueuedRunStatus> {
  const { tenant, project, runId, goal, metadata, requester, runDir } = input.statusInput;
  const status: QueuedRunStatus = {
    runId,
    tenant,
    project,
    goal,
    status: "queued",
    skills: input.run.skills,
    metadata,
    requester: publicRunRequester(requester),
    queuedAt: new Date().toISOString(),
    ...nextQueuedRunPositions(input.queuedRuns, input.run),
    ...input.admission,
    runDir,
  };
  await mkdir(input.runDir, { recursive: true });
  await appendInitialRunEvents(input.runDir, input.initialEvents, input.options);
  const snapshot = await writeQueuedRunSnapshot(input.runDir, input.snapshotBody, requester, input.options);
  await writeRunStatus(input.runDir, status, input.options);
  await input.options.stateBackend?.queues.enqueue<DistributedQueuedRunEnvelope>(DISTRIBUTED_RUN_QUEUE, runId, { status, snapshot });
  input.queuedRuns.push({ ...input.run, status, access: input.access });
  await input.appendAuditEvent(tenant, "run_created", compactObject({
    project,
    runId,
    preset: input.preset,
    presetInput: input.presetInput,
    projectRunPolicy: input.projectRunPolicy,
    projectContract: input.projectContract,
    projectContractStatus: input.projectContractStatus,
    goal,
    status: status.status,
    async: true,
    queued: true,
    tenantQueuePosition: status.tenantQueuePosition,
    projectQueuePosition: status.projectQueuePosition,
    ...queuedAdmissionAuditData(input.admission),
    clientId: input.clientId,
  }), input.access);
  if (input.syncIssueComments && input.issue) {
    await appendInitialIssueCommentSyncAuditEvent(input.appendAuditEvent, tenant, input.access, project, runId, input.issue, input.issueUrl, input.initialIssueComments, input.clientId, input.preset, input.presetInput);
  }
  return status;
}

async function appendInitialRunEvents(runDir: string, events: InitialRunEvent[], options: HarnessServerOptions): Promise<void> {
  for (const event of events) {
    await appendRunEvent(runDir, event.type, event.data, options.stateBackend?.events);
  }
}

async function applyRunPreset(
  body: RunRequestBody,
  preset: RunPresetName | undefined,
  workspaceRoot: string,
  tenant: string,
  project: string,
): Promise<RunRequestBody> {
  const projectRoot = join(workspaceRoot, tenant, project);
  if (!preset) {
    if (body.presetInput !== undefined) throw badRequest("presetInput requires preset.");
    return body;
  }
  if (preset === VAS_LITE_REVIEW_PRESET) {
    await requireVasLiteProject(workspaceRoot, tenant, project, "vas-lite-review preset requires a vas-lite project template.");
    const input = vasLiteReviewPresetInput(body.presetInput);
    const caseRecord = await readVasLiteCase(projectRoot, input.caseId);
    const priorLearnings = (await listVasLiteLearnings(projectRoot))
      .filter((learning) => learning.caseId !== input.caseId && learning.reviewDecision === "approved");
    const reviewGuidance = vasLiteReviewGuidance(caseRecord);
    const presetInput = {
      ...input,
      priorLearningCount: priorLearnings.length,
      reviewCount: reviewGuidance.reviewCount,
      correctionCount: reviewGuidance.correctionCount,
      caseLearningCount: reviewGuidance.learningCount,
    };
    return {
      ...body,
      presetInput,
      __presetSetupSteps: hasExplicitAgent(body) ? [vasLiteReviewContextStep(presetInput, caseRecord, priorLearnings, reviewGuidance)] : undefined,
      goal: hasRequestValue(body.goal) ? body.goal : vasLiteReviewGoal(input.caseId),
      script: hasExplicitAgent(body) ? body.script : vasLiteReviewScript(presetInput, caseRecord, priorLearnings, reviewGuidance),
      verify: body.verify === undefined ? VAS_LITE_REVIEW_VERIFY_COMMANDS : body.verify,
    };
  }
  return body;
}

async function runSkillsForRequest(workspaceRoot: string, tenant: string, project: string, body: RunRequestBody): Promise<string[]> {
  if (body.skills !== undefined) return stringArray(body.skills, "skills");

  const metadata = await readProjectTemplateMetadata(join(workspaceRoot, tenant, project), { tenant, project });
  if (metadata) return projectMetadataDefaultSkills(metadata);
  return [];
}

function runPresetInputForMetadata(preset: RunPresetName | undefined, input: unknown): Record<string, unknown> | undefined {
  if (!preset) return undefined;
  if (preset === VAS_LITE_REVIEW_PRESET) {
    const normalized = input as VasLiteReviewPresetInput;
    return {
      caseId: normalized.caseId,
      priorLearningCount: normalized.priorLearningCount ?? 0,
      reviewCount: normalized.reviewCount ?? 0,
      correctionCount: normalized.correctionCount ?? 0,
      caseLearningCount: normalized.caseLearningCount ?? 0,
    };
  }
  return undefined;
}

async function drainQueuedRuns(
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  queuedRuns: QueuedRun[],
  scheduleQueuedRuns: () => void,
  appendAuditEvent: TenantAuditAppender,
): Promise<void> {
  await syncDistributedQueuedRuns(resolve(options.workspaceRoot), options, queuedRuns);
  for (let index = 0; index < queuedRuns.length;) {
    const run = queuedRuns[index];
    const tenantRunLimit = await effectiveTenantActiveRunLimit(options, run.tenant);
    if (tenantRunLimit !== undefined && activeTenantRunCount(activeRunSlots, run.tenant) >= tenantRunLimit) {
      index += 1;
      continue;
    }
    if (activeWorkspaces.has(activeRunWorkspaceKey(options, run.tenant, run.project, run.runId))) {
      index += 1;
      continue;
    }
    if (await findBlockingPersistedRunningRun(options, run.runRoot)) {
      index += 1;
      continue;
    }
    const admissionClaim = await tryAcquireActiveRunAdmission(options, run, tenantRunLimit);
    if (!admissionClaim.ok) {
      index += 1;
      continue;
    }

    const queueOwner = distributedRunQueueOwner(options);
    const queueClaim = options.stateBackend
      ? await options.stateBackend.queues.claim<DistributedQueuedRunEnvelope>(
          DISTRIBUTED_RUN_QUEUE,
          run.runId,
          queueOwner,
          DISTRIBUTED_RUN_QUEUE_CLAIM_TTL_MS,
        )
      : undefined;
    if (options.stateBackend && !queueClaim) {
      await admissionClaim.handle.release();
      queuedRuns.splice(index, 1);
      continue;
    }

    const queuePositions = queuedRunPositions(queuedRuns, run);
    queuedRuns.splice(index, 1);
    try {
      await enforceModelUsageTokenLimitsForRun(resolve(options.workspaceRoot), options, run);
      const status = await startAsyncRun(run, options, activeRuns, activeRunSlots, activeWorkspaces, scheduleQueuedRuns, appendAuditEvent, admissionClaim.handle);
      if (options.stateBackend) {
        await options.stateBackend.queues.acknowledge(DISTRIBUTED_RUN_QUEUE, run.runId, queueOwner).catch(() => false);
      }
      await appendAuditEvent(run.tenant, "run_started", compactObject({
        project: run.project,
        runId: run.runId,
        goal: run.goal,
        status: status.status,
        async: true,
        queued: true,
        queuedAt: run.status.queuedAt,
        tenantQueuePosition: queuePositions.tenantQueuePosition,
        projectQueuePosition: queuePositions.projectQueuePosition,
        startedAt: status.startedAt,
      }), run.access);
    } catch (error) {
      await admissionClaim.handle.release();
      await failQueuedRun(options, run, error);
      if (options.stateBackend) {
        await options.stateBackend.queues.acknowledge(DISTRIBUTED_RUN_QUEUE, run.runId, queueOwner).catch(() => false);
      }
    }
  }
}

async function recoverQueuedRuns(
  workspaceRoot: string,
  options: HarnessServerOptions,
  queuedRuns: QueuedRun[],
  audit: QueueRecoveryAudit,
  appendAuditEvent: TenantAuditAppender,
): Promise<void> {
  if (options.stateBackend) {
    await syncDistributedQueuedRuns(workspaceRoot, options, queuedRuns, audit);
    return;
  }
  const runDirs = await listPersistedRunDirs(workspaceRoot);
  for (const runDir of runDirs) {
    const state = await readRunStateForScan(runDir);
    if (!state) continue;
    if (!isSafePersistedRunState(state)) continue;
    if (state.status !== "queued") continue;
    audit.scannedQueuedRuns += 1;

    try {
      const snapshot = await readQueuedRunSnapshot(runDir);
      const recovered = await queuedRunFromSnapshot(workspaceRoot, options, state, snapshot);
      queuedRuns.push(recovered);
      const queuePositions = queuedRunPositions(queuedRuns, recovered);
      audit.recoveredQueuedRuns += 1;
      await appendAuditEvent(state.tenant, "queued_run_recovered", compactObject({
        project: state.project,
        runId: state.runId,
        goal: state.goal,
        status: state.status,
        queued: true,
        queuedAt: state.queuedAt,
        tenantQueuePosition: queuePositions.tenantQueuePosition,
        projectQueuePosition: queuePositions.projectQueuePosition,
      }), { actor: "system", role: "admin" });
    } catch (error) {
      const recoveryError = queueRecoveryError(state, error);
      audit.failedQueuedRuns += 1;
      audit.errors.push(recoveryError);
      await failQueuedStatus(options, state, error);
      await appendAuditEvent(state.tenant, "queued_run_recovery_failed", compactObject({
        project: state.project,
        runId: state.runId,
        goal: state.goal,
        status: "error",
        queued: true,
        queuedAt: state.queuedAt,
        message: recoveryError.message,
      }), { actor: "system", role: "admin" });
    }
  }
}

async function syncDistributedQueuedRuns(
  workspaceRoot: string,
  options: HarnessServerOptions,
  queuedRuns: QueuedRun[],
  audit?: QueueRecoveryAudit,
): Promise<void> {
  const backend = options.stateBackend;
  if (!backend) return;
  const items = await backend.queues.list<DistributedQueuedRunEnvelope>(DISTRIBUTED_RUN_QUEUE);
  const queuedIds = new Set(items.map((item) => item.id));
  for (let index = queuedRuns.length - 1; index >= 0; index -= 1) {
    if (!queuedIds.has(queuedRuns[index].runId)) queuedRuns.splice(index, 1);
  }
  if (audit) audit.scannedQueuedRuns += items.length;

  for (const item of items) {
    if (queuedRuns.some((run) => run.runId === item.id)) continue;
    const envelope = distributedQueuedRunEnvelope(item.value, item.id);
    if (!envelope) {
      if (audit) {
        audit.failedQueuedRuns += 1;
        audit.errors.push({ runId: item.id, message: "invalid distributed queued run envelope" });
      }
      continue;
    }

    const persisted = await readRunStateIfPresent(envelope.status.runDir, options);
    if (persisted && persisted.status !== "queued") {
      await acknowledgeStaleDistributedQueueItem(options, item.id);
      continue;
    }

    try {
      const recovered = await queuedRunFromSnapshot(workspaceRoot, options, envelope.status, envelope.snapshot);
      queuedRuns.push(recovered);
      if (audit) audit.recoveredQueuedRuns += 1;
    } catch (error) {
      if (audit) {
        audit.failedQueuedRuns += 1;
        audit.errors.push(queueRecoveryError(envelope.status, error));
      }
    }
  }
}

async function acknowledgeStaleDistributedQueueItem(options: HarnessServerOptions, runId: string): Promise<void> {
  const backend = options.stateBackend;
  if (!backend) return;
  const owner = distributedRunQueueOwner(options);
  const claimed = await backend.queues.claim(DISTRIBUTED_RUN_QUEUE, runId, owner, DISTRIBUTED_RUN_QUEUE_CLAIM_TTL_MS);
  if (claimed) await backend.queues.acknowledge(DISTRIBUTED_RUN_QUEUE, runId, owner);
}

function distributedQueuedRunEnvelope(value: unknown, id: string): DistributedQueuedRunEnvelope | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const envelope = value as Partial<DistributedQueuedRunEnvelope>;
  const status = envelope.status;
  const snapshot = envelope.snapshot;
  if (!status || status.status !== "queued" || status.runId !== id) return undefined;
  if (!snapshot || snapshot.schemaVersion !== 1 || typeof snapshot.request !== "object" || snapshot.request === null) return undefined;
  return envelope as DistributedQueuedRunEnvelope;
}

function distributedRunQueueOwner(options: HarnessServerOptions): string {
  return `server:${options.instanceId ?? process.pid}`;
}

async function cleanupStaleRunningRuns(
  workspaceRoot: string,
  options: HarnessServerOptions,
  audit: StaleRunCleanupAudit,
  appendAuditEvent: TenantAuditAppender,
): Promise<void> {
  const runDirs = await listPersistedRunDirs(workspaceRoot);
  for (const runDir of runDirs) {
    const state = await readRunStateForScan(runDir);
    if (!state) continue;
    if (!isSafePersistedRunState(state)) continue;
    if (state.status !== "running") continue;
    audit.scannedRunningRuns += 1;

    if (!runningRunIsStale(state)) {
      audit.skippedRunningRuns += 1;
      continue;
    }
    if (await persistedRunningRunHasActiveAdmissionClaim(options, runDir, state)) {
      audit.skippedRunningRuns += 1;
      continue;
    }
    try {
      await abandonRunningStatus(options, state, runDir, "auto-abandoned stale run lease", true);
      await appendAuditEvent(state.tenant, "stale_run_auto_abandoned", {
        project: state.project,
        runId: state.runId,
        goal: state.goal,
        status: "cancelled",
        reason: "auto-abandoned stale run lease",
      }, { actor: "system", role: "admin" });
      audit.abandonedStaleRuns += 1;
    } catch (error) {
      audit.errors.push(staleRunCleanupError(state, error));
    }
  }
}

function queueRecoveryError(state: QueuedRunStatus, error: unknown): QueueRecoveryError {
  return {
    tenant: state.tenant,
    project: state.project,
    runId: state.runId,
    message: error instanceof Error ? error.message : String(error),
  };
}

function staleRunCleanupError(state: RunningRunStatus, error: unknown): StaleRunCleanupError {
  return {
    tenant: state.tenant,
    project: state.project,
    runId: state.runId,
    message: error instanceof Error ? error.message : String(error),
  };
}

function isSafePersistedRunState(state: ReadableRunState): boolean {
  const data = recordData(state);
  const tenant = stringField(data, "tenant");
  const project = stringField(data, "project");
  const runId = stringField(data, "runId");
  return tenant !== undefined
    && project !== undefined
    && runId !== undefined
    && isSafeTenantDirectoryName(tenant)
    && isProjectDirectoryName(project)
    && isSafeDirectoryName(runId);
}

async function listPersistedRunDirs(workspaceRoot: string, tenantFilter?: string): Promise<string[]> {
  let tenantEntries;
  try {
    tenantEntries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const runDirs: string[] = [];
  for (const tenantEntry of tenantEntries) {
    if (!tenantEntry.isDirectory() || !isSafeTenantDirectoryName(tenantEntry.name)) continue;
    if (tenantFilter && tenantEntry.name !== tenantFilter) continue;
    const tenantRoot = join(workspaceRoot, tenantEntry.name);
    let projectEntries;
    try {
      projectEntries = await readdir(tenantRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory() || !isProjectDirectoryName(projectEntry.name)) continue;
      const runsRoot = join(tenantRoot, projectEntry.name, ".loom", "runs");
      let runEntries;
      try {
        runEntries = await readdir(runsRoot, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      for (const runEntry of runEntries) {
        if (runEntry.isDirectory() && isSafeDirectoryName(runEntry.name)) {
          runDirs.push(join(runsRoot, runEntry.name));
        }
      }
    }
  }
  return runDirs;
}

async function queuedRunFromSnapshot(
  workspaceRoot: string,
  options: HarnessServerOptions,
  status: QueuedRunStatus,
  snapshot: HarnessQueuedRunSnapshot,
): Promise<QueuedRun> {
  const body = snapshot.request;
  if (body.async !== true || !booleanFlag(body.queue, "queue")) {
    throw badRequest("queued run snapshot must be async and queued.");
  }
  try {
    return {
      ...await harnessRunStartFromSnapshot(workspaceRoot, options, status, snapshot),
      status,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "run snapshot goal does not match run status.") {
      throw badRequest("queued run snapshot goal does not match queued status.");
    }
    throw error;
  }
}

async function harnessRunStartFromSnapshot(
  workspaceRoot: string,
  options: HarnessServerOptions,
  status: { runId: string; tenant: string; project: string; goal: string; runDir: string; metadata?: RunMetadata },
  snapshot: HarnessQueuedRunSnapshot,
): Promise<HarnessRunStart> {
  const body = snapshot.request;
  const tenant = requireSafeName(body.tenant, "tenant");
  const project = optionalSafeName(body.project, "project") ?? "default";
  if (tenant !== status.tenant || project !== status.project) {
    throw badRequest("queued run snapshot does not match queued status.");
  }

  const goal = requireString(body.goal, "goal");
  if (goal !== status.goal) {
    throw badRequest("run snapshot goal does not match run status.");
  }

  const runSource = runSourceFromBody(body, await readProjectSourceDefaults(join(workspaceRoot, tenant), project));
  const { repo, branch, baseBranch, issue } = runSource;
  const preset = runPresetName(body.preset);
  const presetInput = runPresetInputForMetadata(preset, body.presetInput);
  const pullRequest = booleanFlag(body.pullRequest, "pullRequest");
  const reviewRequired = booleanFlag(body.reviewRequired, "reviewRequired");
  const deploymentRequired = booleanFlag(body.deploymentRequired, "deploymentRequired");
  if (pullRequest && (!issue || !branch)) {
    throw badRequest("pullRequest requires issue and branch.");
  }
  if (pullRequest && !options.pullRequestReporter) {
    throw badRequest("pullRequest requires a pull request reporter.");
  }

  const cwd = join(workspaceRoot, tenant, project);
  const verifyCommands = stringArray(body.verify, "verify");
  const evaluationCommands = stringArray(body.evaluate, "evaluate");
  const reviewerCommands = stringArray(body.reviewer, "reviewer");
  const skills = await runSkillsForRequest(workspaceRoot, tenant, project, body);
  const allowedTools = allowedToolSubset(body.allowedTools, await effectiveTenantAllowedTools(options, tenant));
  const maxIterations = positiveInt(body.maxIterations, options.defaultMaxIterations ?? 20);
  const runRoot = join(cwd, ".loom", "runs");
  const requester = runRequesterFromUnknown(snapshot.requester);
  const agent = await createAgent(body, cwd, options, tenant, requester);

  return {
    tenant,
    project,
    runId: status.runId,
    goal,
    cwd,
    runRoot,
    runDir: status.runDir,
    repo,
    branch,
    baseBranch,
    verifyCommands,
    evaluationCommands,
    reviewerCommands,
    agent,
    skills,
    maxIterations,
    allowedTools,
    metadata: status.metadata ?? runMetadata({ tenant, project, runId: status.runId, repo, branch, baseBranch, issue, runPreset: preset, runPresetInput: presetInput, ...runAgentMetadata(body, options) }, options),
    reviewRequired,
    deploymentRequired,
    pullRequest,
    requester,
  };
}

async function startAsyncRun(
  run: HarnessRunStart,
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  scheduleQueuedRuns: () => void,
  appendAuditEvent: TenantAuditAppender,
  admissionClaim: RunAdmissionClaimHandle,
): Promise<RunningRunStatus> {
  const runKey = activeRunKey(run.tenant, run.project, run.runId);
  const workspaceKey = activeRunWorkspaceKey(options, run.tenant, run.project, run.runId);
  activeWorkspaces.set(workspaceKey, run.runId);
  activeRunSlots.set(runKey, { tenant: run.tenant, project: run.project, runId: run.runId });

  let completionOwnsWorkspace = false;
  let stopHeartbeat = () => {};
  let stopControlPolling = () => {};
  let writtenStatus: RunningRunStatus | undefined;
  try {
    await mkdir(run.cwd, { recursive: true });
    const controller = new AbortController();
    let remoteCancelRequest: RunCancelRequest | undefined;
    let status = runningRunStatusWithLease({
      runId: run.runId,
      tenant: run.tenant,
      project: run.project,
      goal: run.goal,
      status: "running",
      skills: run.skills,
      metadata: run.metadata,
      requester: publicRunRequester(run.requester),
      startedAt: run.startedAt ?? new Date().toISOString(),
      runDir: run.runDir,
    }, options);
    writtenStatus = status;
    await mkdir(run.runDir, { recursive: true });
    await writeRunStatus(run.runDir, status, options);
    let heartbeatStopped = false;
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatStopped || heartbeatBusy) return;
      heartbeatBusy = true;
      void admissionClaim.refresh()
        .then(async () => {
          if (heartbeatStopped) return;
          const refreshed = refreshRunningRunLease(status, options);
          await writeRunStatus(run.runDir, refreshed, options);
          status = refreshed;
          writtenStatus = refreshed;
        })
        .catch((error) => {
          if (!controller.signal.aborted) controller.abort(runAdmissionHeartbeatError(error));
        })
        .finally(() => {
          heartbeatBusy = false;
        });
    }, runHeartbeatIntervalMs(options));
    heartbeat.unref?.();
    stopHeartbeat = () => {
      heartbeatStopped = true;
      clearInterval(heartbeat);
    };
    let controlPollingStopped = false;
    let controlPollingBusy = false;
    const controlPolling = setInterval(() => {
      if (controlPollingStopped || controlPollingBusy || controller.signal.aborted) return;
      controlPollingBusy = true;
      void readRunCancelRequest(run.runDir, options)
        .then(async (request) => {
          if (controlPollingStopped || !request || controller.signal.aborted) return;
          remoteCancelRequest = request;
          await deleteRunCancelRequest(run.runDir, options).catch(() => undefined);
          controller.abort(new Error(request.reason ?? "run cancelled by user"));
        })
        .catch(() => undefined)
        .finally(() => {
          controlPollingBusy = false;
        });
    }, RUN_CONTROL_POLL_INTERVAL_MS);
    controlPolling.unref?.();
    stopControlPolling = () => {
      controlPollingStopped = true;
      clearInterval(controlPolling);
    };
    const executor = await workspaceExecutor(options, {
      tenant: run.tenant,
      project: run.project,
      runId: run.runId,
      cwd: run.cwd,
      repo: run.repo,
      branch: run.branch,
      baseBranch: run.baseBranch,
    });
    const completion = runHarness({
      runId: run.runId,
      goal: run.goal,
      cwd: run.cwd,
      runRoot: run.runRoot,
      verifyCommands: run.verifyCommands,
      evaluationCommands: run.evaluationCommands,
      reviewerCommands: run.reviewerCommands,
      agent: run.agent,
      skills: run.skills,
      maxIterations: run.maxIterations,
      allowedTools: run.allowedTools,
      executor,
      metadata: run.metadata,
      reviewRequired: run.reviewRequired,
      deploymentRequired: run.deploymentRequired,
      requester: run.requester,
      resumeRequester: run.resumeRequester,
      resume: run.resume,
      startedAt: run.startedAt,
      control: {
        shouldPause: () => readRunPauseRequest(run.runDir, options),
      },
      signal: controller.signal,
      stateBackend: options.stateBackend,
    }).then(async (summary) => {
      stopHeartbeat();
      stopControlPolling();
      const reported = await finalizeRun(options, summary, run.pullRequest, appendAuditEvent);
      await writeRunStatus(run.runDir, reported, options);
      await appendRunFinishedAuditEvent(appendAuditEvent, options, run, reported);
      if (reported.status === "cancelled" && remoteCancelRequest) {
        await appendRunCancelledAuditEvent(appendAuditEvent, run, reported, remoteCancelRequest);
      }
      return reported;
    }).catch(async (error) => {
      stopHeartbeat();
      stopControlPolling();
      const message = error instanceof Error ? error.message : String(error);
      const failed: RunSummary = {
        runId: run.runId,
        goal: run.goal,
        status: "error",
        skills: run.skills,
        metadata: run.metadata,
        requester: publicRunRequester(run.requester),
        startedAt: status.startedAt,
        endedAt: new Date().toISOString(),
        eventCount: 0,
        runDir: run.runDir,
        verification: null,
        error: { message },
      };
      await writeRunSummary(failed, options);
      await writeRunStatus(run.runDir, failed, options);
      await appendRunFinishedAuditEvent(appendAuditEvent, options, run, failed);
      throw new Error(message);
    }).finally(async () => {
      stopHeartbeat();
      stopControlPolling();
      activeRuns.delete(runKey);
      activeRunSlots.delete(runKey);
      activeWorkspaces.delete(workspaceKey);
      await admissionClaim.release();
      scheduleQueuedRuns();
    });
    activeRuns.set(runKey, { controller, completion });
    completionOwnsWorkspace = true;
    void completion.catch(() => undefined);
    return status;
  } catch (error) {
    stopHeartbeat();
    stopControlPolling();
    if (!completionOwnsWorkspace && writtenStatus) {
      const message = error instanceof Error ? error.message : String(error);
      const failed: RunSummary = {
        runId: run.runId,
        goal: run.goal,
        status: "error",
        skills: run.skills,
        metadata: run.metadata,
        requester: publicRunRequester(run.requester),
        startedAt: writtenStatus.startedAt,
        endedAt: new Date().toISOString(),
        eventCount: 0,
        runDir: run.runDir,
        verification: null,
        error: { message },
      };
      await writeRunSummary(failed, options).catch(() => undefined);
      await writeRunStatus(run.runDir, failed, options).catch(() => undefined);
      await appendRunFinishedAuditEvent(appendAuditEvent, options, run, failed).catch(() => undefined);
    }
    throw error;
  } finally {
    if (!completionOwnsWorkspace) {
      stopHeartbeat();
      stopControlPolling();
      activeRunSlots.delete(runKey);
      activeWorkspaces.delete(workspaceKey);
      await admissionClaim.release();
      scheduleQueuedRuns();
    }
  }
}

async function appendRunFinishedAuditEvent(
  appendAuditEvent: TenantAuditAppender,
  options: HarnessServerOptions,
  run: HarnessRunStart,
  summary: RunSummary,
): Promise<void> {
  const queuedStatus = queuedRunStatusForAudit(run);
  const modelAuditData = await runFinishedModelUsageAuditData(options, run, summary);
  await appendAuditEvent(run.tenant, "run_finished", compactObject({
    project: run.project,
    runId: run.runId,
    goal: run.goal,
    status: summary.status,
    async: true,
    queued: queuedStatus ? true : false,
    queuedAt: queuedStatus?.queuedAt,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    eventCount: summary.eventCount,
    ...modelAuditData,
  }), run.access);
}

async function appendRunCancelledAuditEvent(
  appendAuditEvent: TenantAuditAppender,
  run: HarnessRunStart,
  summary: RunSummary,
  request: RunCancelRequest,
): Promise<void> {
  await appendAuditEvent(run.tenant, "run_cancelled", compactObject({
    project: run.project,
    runId: run.runId,
    status: summary.status,
    reason: request.reason ?? "run cancelled by user",
    queued: false,
    clientId: request.clientId,
  }), runCancelRequestAccess(request));
}

function runCancelRequestAccess(request: RunCancelRequest): TenantAuditActor | undefined {
  if (!request.actor || !request.role) return undefined;
  return { actor: request.actor, role: request.role };
}

async function runFinishedModelUsageAuditData(
  options: HarnessServerOptions,
  run: HarnessRunStart,
  summary: RunSummary,
): Promise<Record<string, unknown>> {
  if (!summary.modelUsage) return {};
  const tenantRoot = join(resolve(options.workspaceRoot), run.tenant);
  const policyLimits = (await readTenantPolicy(resolve(options.workspaceRoot), run.tenant, options))?.limits;
  const projectSummary = await readProjectSummary(tenantRoot, run.tenant, run.project, policyLimits);
  return compactObject({
    modelUsage: summary.modelUsage,
    modelUsageWarnings: projectSummary.modelUsageWarnings,
  });
}

function queuedRunStatusForAudit(run: HarnessRunStart): QueuedRunStatus | undefined {
  const status = (run as { status?: unknown }).status;
  if (!status || typeof status !== "object" || Array.isArray(status)) return undefined;
  const data = status as Partial<QueuedRunStatus>;
  return data.status === "queued" && typeof data.queuedAt === "string" ? data as QueuedRunStatus : undefined;
}

async function failQueuedRun(options: HarnessServerOptions, run: QueuedRun, error: unknown): Promise<void> {
  await failQueuedStatus(options, run.status, error);
}

async function failQueuedStatus(options: HarnessServerOptions, status: QueuedRunStatus, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const event = await appendRunEvent(status.runDir, "error", { message }, options.stateBackend?.events);
  const failed: RunSummary = {
    runId: status.runId,
    goal: status.goal,
    status: "error",
    skills: status.skills,
    metadata: status.metadata,
    requester: status.requester,
    startedAt: status.queuedAt,
    endedAt: new Date().toISOString(),
    eventCount: event.seq,
    runDir: status.runDir,
    verification: null,
  };
  await writeRunSummary(failed, options);
  await writeRunStatus(status.runDir, failed, options);
}

async function abandonRunningStatus(
  options: HarnessServerOptions,
  state: RunningRunStatus,
  runDir: string,
  reason: string,
  stale: boolean,
): Promise<RunSummary> {
  await appendRunEvent(runDir, "cancel", compactObject({ reason, abandoned: true, stale: stale ? true : undefined }), options.stateBackend?.events);
  const finish = await appendRunEvent(runDir, "finish", { status: "cancelled" }, options.stateBackend?.events);
  const abandoned: RunSummary = {
    runId: state.runId,
    goal: state.goal,
    status: "cancelled",
    skills: state.skills,
    metadata: state.metadata,
    requester: state.requester,
    startedAt: state.startedAt,
    endedAt: new Date().toISOString(),
    eventCount: finish.seq,
    runDir,
    verification: null,
  };
  await writeRunSummary(abandoned, options);
  await writeRunStatus(runDir, abandoned, options);
  return abandoned;
}

async function handleAbandonRun(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  activeWorkspaces: Map<string, string>,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs") return false;
  if (segments[4] !== "abandon" && segments[4] !== "abandon-stale") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const runId = requireSafeName(segments[3], "runId");
  const project = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  const staleOnly = segments[4] === "abandon-stale";
  const runDir = join(workspaceRoot, tenant, project, ".loom", "runs", runId);
  const state = await readRunState(runDir, options);
  if (state.status !== "running") {
    throw badRequest("run is not running.");
  }
  if (activeRuns.has(activeRunKey(tenant, project, runId))) {
    throw badRequest("run is active in this server process; use cancel.");
  }
  if (await persistedRunningRunHasActiveAdmissionClaim(options, runDir, state)) {
    throw conflict("run is active in another server process; use cancel on the owning server.");
  }
  if (staleOnly && !runningRunIsStale(state)) {
    throw conflict("run lease is still active.");
  }

  const body = await readCancelJson(req);
  const reason = optionalString(body.reason, "reason") ?? (staleOnly ? "stale run abandoned by user" : "run abandoned by user");
  const clientId = optionalClientId(body.clientId);
  const abandoned = await abandonRunningStatus(options, state, runDir, reason, staleOnly);
	  activeWorkspaces.delete(activeRunWorkspaceKey(options, tenant, project, runId));
  await appendAuditEvent(tenant, "run_abandoned", compactObject({
    project,
    runId,
    status: abandoned.status,
    reason,
    stale: staleOnly,
    clientId,
  }), access);
  writeJson(res, 200, abandoned);
  return true;
}

async function handleCancelRun(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  queuedRuns: QueuedRun[],
  scheduleQueuedRuns: () => void,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "cancel") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const runId = requireSafeName(segments[3], "runId");
  const project = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  const runDir = join(workspaceRoot, tenant, project, ".loom", "runs", runId);
  const state = await readRunState(runDir, options);
  const body = await readCancelJson(req);
  const reason = optionalString(body.reason, "reason") ?? "run cancelled by user";
  const clientId = optionalClientId(body.clientId);
  if (state.status === "queued") {
    const queuePositions = queuedRunPositions(queuedRuns, {
      tenant,
      project,
      runId,
      tenantQueuePosition: state.tenantQueuePosition,
      projectQueuePosition: state.projectQueuePosition,
    });
    const cancelled = await cancelQueuedRun(options, runDir, tenant, project, runId, state, queuedRuns, reason);
    scheduleQueuedRuns();
    await appendAuditEvent(tenant, "run_cancelled", compactObject({
      project,
      runId,
      status: cancelled.status,
      reason,
      queued: true,
      queuedAt: state.queuedAt,
      tenantQueuePosition: queuePositions.tenantQueuePosition,
      projectQueuePosition: queuePositions.projectQueuePosition,
      clientId,
    }), access);
    writeJson(res, 200, cancelled);
    return true;
  }
  if (state.status !== "running") {
    throw badRequest("run is not running.");
  }

  const active = activeRuns.get(activeRunKey(tenant, project, runId));
  if (!active) {
    if (await persistedRunningRunHasActiveAdmissionClaim(options, runDir, state)) {
      await writeRunCancelRequest(runDir, {
        reason,
        ...runEventContext(access, clientId),
      }, options);
      writeJson(res, 202, {
        status: "running",
        cancelRequested: true,
        runId,
        tenant,
        project,
      });
      return true;
    }
    throw badRequest("run is not running in this server process.");
  }

  active.controller.abort(new Error(reason));
  const cancelled = await active.completion;
  await appendAuditEvent(tenant, "run_cancelled", compactObject({
    project,
    runId,
    status: cancelled.status,
    reason,
    queued: false,
    clientId,
  }), access);
  writeJson(res, 200, cancelled);
  return true;
}

async function cancelQueuedRun(
  options: HarnessServerOptions,
  runDir: string,
  tenant: string,
  project: string,
  runId: string,
  state: QueuedRunStatus,
  queuedRuns: QueuedRun[],
  reason: string,
): Promise<RunSummary> {
  const queueOwner = distributedRunQueueOwner(options);
  const queueClaim = options.stateBackend
    ? await options.stateBackend.queues.claim(DISTRIBUTED_RUN_QUEUE, runId, queueOwner, DISTRIBUTED_RUN_QUEUE_CLAIM_TTL_MS)
    : undefined;
  if (options.stateBackend && !queueClaim) {
    throw conflict("queued run is being started or cancelled by another server");
  }
  try {
  const index = queuedRuns.findIndex((run) => run.tenant === tenant && run.project === project && run.runId === runId);
  if (index >= 0) {
    queuedRuns.splice(index, 1);
  }
  await appendRunEvent(runDir, "cancel", { reason, queued: true }, options.stateBackend?.events);
  const finish = await appendRunEvent(runDir, "finish", { status: "cancelled" }, options.stateBackend?.events);
  const cancelled: RunSummary = {
    runId,
    goal: state.goal,
    status: "cancelled",
    skills: state.skills,
    metadata: state.metadata,
    requester: state.requester,
    startedAt: state.queuedAt,
    endedAt: new Date().toISOString(),
    eventCount: finish.seq,
    runDir,
    verification: null,
  };
  await writeRunSummary(cancelled, options);
  await writeRunStatus(runDir, cancelled, options);
  if (options.stateBackend) {
    await options.stateBackend.queues.acknowledge(DISTRIBUTED_RUN_QUEUE, runId, queueOwner);
  }
  return cancelled;
  } catch (error) {
    if (options.stateBackend && queueClaim) {
      await options.stateBackend.queues.release(DISTRIBUTED_RUN_QUEUE, runId, queueOwner).catch(() => false);
    }
    throw error;
  }
}

async function handleResumeRun(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  scheduleQueuedRuns: () => void,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "resume") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const runId = requireSafeName(segments[3], "runId");
  const project = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  const runDir = join(workspaceRoot, tenant, project, ".loom", "runs", runId);
  const body = await readRunResumeJson(req);
  const clientId = optionalClientId(body.clientId);
  const state = await readRunState(runDir, options);
  const status = await resumePausedRun(
    workspaceRoot,
    options,
    activeRuns,
    activeRunSlots,
    activeWorkspaces,
    scheduleQueuedRuns,
    appendAuditEvent,
    tenant,
    project,
    runId,
    runDir,
    state,
    access,
    clientId,
  );
  writeJson(res, 202, status);
  return true;
}

async function resumePausedRun(
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  scheduleQueuedRuns: () => void,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  runId: string,
  runDir: string,
  state: ReadableRunState,
  access: TenantAccess | undefined,
  clientId?: string,
): Promise<RunningRunStatus> {
  if (state.status !== "paused") {
    throw badRequest("run is not paused.");
  }

	  const workspaceKey = activeRunWorkspaceKey(options, tenant, project, runId);
  const activeRunId = activeWorkspaces.get(workspaceKey);
  if (activeRunId) {
    throw conflict(`tenant project already has an active run: ${activeRunId}`);
  }
	  const persistedRunId = await findBlockingPersistedRunningRun(options, join(workspaceRoot, tenant, project, ".loom", "runs"));
  if (persistedRunId) {
    throw conflict(`tenant project already has an active run: ${persistedRunId}`);
  }
  const tenantRunLimit = await effectiveTenantActiveRunLimit(options, tenant);
  if (tenantRunLimit !== undefined && activeTenantRunCount(activeRunSlots, tenant) >= tenantRunLimit) {
    throw conflict("active run tenant limit reached");
  }

  const snapshot = await readQueuedRunSnapshot(runDir, options);
  const run = await harnessRunStartFromSnapshot(workspaceRoot, options, { ...state, tenant, project }, snapshot);
  const resumeRequester = runRequester(access, clientId);
  await enforceModelUsageTokenLimitsForRun(workspaceRoot, options, run);
  const admissionClaim = await tryAcquireActiveRunAdmission(options, run, tenantRunLimit);
  if (!admissionClaim.ok) throw admissionClaim.error;
  let claimOwnedByRun = false;
  await deleteRunPauseRequest(runDir, options);
  const status = await startAsyncRun({
      ...run,
      resumeRequester,
      access,
      resume: true,
      startedAt: state.startedAt,
    }, options, activeRuns, activeRunSlots, activeWorkspaces, scheduleQueuedRuns, appendAuditEvent, admissionClaim.handle)
    .then((value) => {
      claimOwnedByRun = true;
      return value;
    })
    .finally(async () => {
      if (!claimOwnedByRun) await admissionClaim.handle.release();
    });
  await appendAuditEvent(tenant, "run_resumed", compactObject({
    project,
    runId,
    status: status.status,
    clientId,
  }), access);
  return status;
}

async function handleCreateRunComment(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "comments") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url);
  const runId = requireSafeName(segments[3], "runId");
  const project = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  const runDir = join(workspaceRoot, tenant, project, ".loom", "runs", runId);

  try {
    const state = await readRunState(runDir, options);
    const body = await readRunCommentJson(req);
    const message = runCommentMessage(body.message);
    const pauseRequested = booleanFlag(body.pause, "pause");
    const clientId = optionalClientId(body.clientId);
    const context = runEventContext(access, clientId);
    if (pauseRequested) {
      if (state.status !== "running") {
        throw badRequest("pause can only be requested for a running run.");
      }
      const active = activeRuns.has(activeRunKey(tenant, project, runId));
      if (!active && !await persistedRunningRunHasActiveAdmissionClaim(options, runDir, state)) {
        throw badRequest("pause requires an active run in this server process.");
      }
    }
    const event = await appendRunEvent(runDir, "user_message", compactObject({
      kind: "comment",
      content: message,
      pauseRequested: pauseRequested ? true : undefined,
      ...context,
    }), options.stateBackend?.events);
    if (pauseRequested) {
      await writeRunPauseRequest(runDir, {
        reason: message,
        eventSeq: event.seq,
        ...context,
      }, options);
    }

    if (state.status !== "running" && state.status !== "queued") {
      const observed: RunSummary = { ...state, eventCount: event.seq };
      await writeRunSummary(observed, options);
      await writeRunStatus(runDir, observed, options);
    }

    await appendAuditEvent(tenant, "run_comment_added", compactObject({
      project,
      runId,
      message,
      eventSeq: event.seq,
      pauseRequested: pauseRequested ? true : undefined,
      clientId,
    }), access);
    writeJson(res, 201, event);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function handleUpdateRunPresence(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  presence: RunPresenceRegistry,
): Promise<boolean> {
  const context = await runPresenceContext(url, req, workspaceRoot, options);
  if (!context) return false;

  purgeExpiredRunPresence(presence);
  const body = await readPresenceJson(req);
  const clientId = presenceClientId(body.clientId);
  const label = presenceLabel(body.label, context.access, clientId);
  const focus = presenceFocus(body.focus);
  const nowMs = Date.now();
  const seenAt = new Date(nowMs).toISOString();
  const expiresAtMs = nowMs + RUN_PRESENCE_TTL_MS;
  const entry: StoredRunPresenceEntry = compactObject({
    tenant: context.tenant,
    project: context.project,
    runId: context.runId,
    clientId,
    label,
    focus,
    actor: context.access?.actor,
    role: context.access?.role,
    seenAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
  });
  presence.set(runPresenceKey(context.tenant, context.project, context.runId, clientId), entry);
  await persistPresenceEntry(runPresenceRootFromProjectRoot(context.cwd, context.runId), entry);
  writeJson(res, 200, publicRunPresenceEntry(entry));
  return true;
}

async function handleListRunPresence(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  presence: RunPresenceRegistry,
): Promise<boolean> {
  const context = await runPresenceContext(url, req, workspaceRoot, options);
  if (!context) return false;

  await refreshRunPresenceFromDisk(presence, context.cwd, context.tenant, context.project, context.runId);
  purgeExpiredRunPresence(presence);
  writeJson(res, 200, runPresenceEntries(presence, context.tenant, context.project, context.runId));
  return true;
}

async function runPresenceContext(
  url: URL,
  req: IncomingMessage,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<{ tenant: string; project: string; runId: string; cwd: string; access?: TenantAccess } | false> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "presence") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url);
  const runId = requireSafeName(segments[3], "runId");
  const project = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  const runDir = join(workspaceRoot, tenant, project, ".loom", "runs", runId);
  try {
    await readRunState(runDir, options);
  } catch (error) {
    if (isNotFound(error)) throw notFound("run not found");
    throw error;
  }
  return { tenant, project, runId, cwd: join(workspaceRoot, tenant, project), access };
}

async function handleReadRun(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  queuedRuns: QueuedRun[],
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 && segments.length !== 5 && segments.length !== 6) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs") return false;
  if (segments.length === 5 && segments[4] !== "events" && segments[4] !== "replay") return false;
  if (segments.length === 6 && (segments[4] !== "events" || segments[5] !== "stream")) return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const runId = requireSafeName(segments[3], "runId");
  const project = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  const runDir = join(workspaceRoot, tenant, project, ".loom", "runs", runId);

  try {
    if (segments[4] === "events" && segments[5] === "stream") {
      await readRunState(runDir, options);
      await streamEvents(res, runDir, seqAfter(url, req), options);
      return true;
    }

    if (segments[4] === "events") {
      await readRunState(runDir, options);
      writeJson(res, 200, filterEvents(await readRunEventsIfPresent(runDir, options), seqAfter(url)));
      return true;
    }

    if (segments[4] === "replay") {
      const state = await readRunState(runDir, options);
      writeJson(res, 200, runReplayFromEvents(state, await readRunEventsIfPresent(runDir, options)));
      return true;
    }

    const summary = await readRunState(runDir, options);
    writeJson(res, 200, await runStateForReadResponse(summary, workspaceRoot, options, activeRunSlots, activeWorkspaces, queuedRuns));
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function runStateForReadResponse(
  state: ReadableRunState,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  queuedRuns: QueuedRun[],
): Promise<ReadableRunState> {
  if (state.status !== "queued") return state;
  const detail = await queuedRunResourceStatus(options, activeRunSlots, activeWorkspaces, {
    tenant: state.tenant,
    project: state.project,
    runId: state.runId,
    goal: state.goal,
    queuedAt: state.queuedAt,
    ...queuedRunPositions(queuedRuns, state),
    runRoot: join(workspaceRoot, state.tenant, state.project, ".loom", "runs"),
  });
  return compactObject({
    ...state,
    tenantQueuePosition: detail.tenantQueuePosition,
    projectQueuePosition: detail.projectQueuePosition,
    blockedReason: detail.blockedReason,
    blockedByRunIds: detail.blockedByRunIds,
    limit: detail.limit,
    concurrency: detail.concurrency,
  }) as QueuedRunStatus;
}

async function runStatesForReadResponse(
  states: ReadableRunState[],
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  queuedRuns: QueuedRun[],
): Promise<ReadableRunState[]> {
  return Promise.all(states.map((state) => runStateForReadResponse(state, workspaceRoot, options, activeRunSlots, activeWorkspaces, queuedRuns)));
}

async function readRunStatesForListing(runsRoot: string, tenant: string, project: string, options?: HarnessServerOptions): Promise<ReadableRunState[]> {
  if (options?.stateBackend) {
    return (await listStoredRunStates(options.stateBackend.documents, tenant)).filter((state) =>
      state.metadata?.project === project || ("project" in state && state.project === project),
    );
  }
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const states = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const state = await readRunStateForScan(join(runsRoot, entry.name));
        if (!state) return undefined;
        if (!runStateMatchesListingPath(state, entry.name, tenant, project)) return undefined;
        return state;
      }),
  );
  return states.filter((state): state is ReadableRunState => state !== undefined);
}

function runStateMatchesListingPath(state: ReadableRunState, entryName: string, tenant: string, project: string): boolean {
  if (!isSafeDirectoryName(state.runId) || state.runId !== entryName) return false;
  const declaredTenant = "tenant" in state ? state.tenant : state.metadata?.tenant;
  const declaredProject = "project" in state ? state.project : state.metadata?.project;
  if (declaredTenant !== undefined && (!isSafeTenantDirectoryName(declaredTenant) || declaredTenant !== tenant)) return false;
  if (declaredProject !== undefined && (!isProjectDirectoryName(declaredProject) || declaredProject !== project)) return false;
  return true;
}

function runSourceFromBody(body: RunRequestBody, defaults: ProjectSourceDefaultValues): ProjectSourceDefaultValues {
  return compactObject({
    repo: optionalSourceRepo(body.repo) ?? defaults.repo,
    branch: optionalSourceGitRef(body.branch, "branch", defaults.branch),
    baseBranch: optionalSourceGitRef(body.baseBranch, "baseBranch", defaults.baseBranch),
    issue: optionalSourceIssue(body.issue, defaults.issue),
  });
}

function runRequestWithResolvedSource(body: RunRequestBody, source: ProjectSourceDefaultValues): RunRequestBody {
  return compactObject({
    ...body,
    repo: source.repo,
    branch: source.branch,
    baseBranch: source.baseBranch,
    issue: source.issue,
  });
}

async function readRunState(runDir: string, options?: HarnessServerOptions): Promise<ReadableRunState> {
  return loadRunState(runDir, options?.stateBackend?.documents);
}

async function writeRunPauseRequest(runDir: string, request: RunPauseRequest, options?: HarnessServerOptions): Promise<void> {
  const value = {
    schemaVersion: 1,
    requestedAt: new Date().toISOString(),
    ...request,
  };
  await options?.stateBackend?.documents.put("run-pause-request", basename(runDir), value);
  await writeJsonFileAtomic(join(runDir, RUN_PAUSE_REQUEST_FILE), value);
}

async function readRunPauseRequest(runDir: string, options?: HarnessServerOptions): Promise<RunPauseRequest | undefined> {
  try {
    const stored = await options?.stateBackend?.documents.get<Record<string, unknown>>("run-pause-request", basename(runDir));
    const data = stored?.value ?? JSON.parse(await readFile(join(runDir, RUN_PAUSE_REQUEST_FILE), "utf8")) as Record<string, unknown>;
    if (data.schemaVersion !== 1) return undefined;
    return compactObject({
      reason: typeof data.reason === "string" ? data.reason : undefined,
      actor: typeof data.actor === "string" ? data.actor : undefined,
      role: typeof data.role === "string" ? data.role : undefined,
      clientId: typeof data.clientId === "string" ? data.clientId : undefined,
      eventSeq: typeof data.eventSeq === "number" ? data.eventSeq : undefined,
    }) as RunPauseRequest;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function deleteRunPauseRequest(runDir: string, options?: HarnessServerOptions): Promise<void> {
  await options?.stateBackend?.documents.delete("run-pause-request", basename(runDir));
  try {
    await unlink(join(runDir, RUN_PAUSE_REQUEST_FILE));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function writeRunCancelRequest(runDir: string, request: RunCancelRequest, options?: HarnessServerOptions): Promise<void> {
  const value = {
    schemaVersion: 1,
    requestedAt: new Date().toISOString(),
    ...request,
  };
  await options?.stateBackend?.documents.put("run-cancel-request", basename(runDir), value);
  await writeJsonFileAtomic(join(runDir, RUN_CANCEL_REQUEST_FILE), value);
}

async function readRunCancelRequest(runDir: string, options?: HarnessServerOptions): Promise<RunCancelRequest | undefined> {
  try {
    const stored = await options?.stateBackend?.documents.get<Record<string, unknown>>("run-cancel-request", basename(runDir));
    const data = stored?.value ?? JSON.parse(await readFile(join(runDir, RUN_CANCEL_REQUEST_FILE), "utf8")) as Record<string, unknown>;
    if (data.schemaVersion !== 1) return undefined;
    return compactObject({
      reason: typeof data.reason === "string" ? data.reason : undefined,
      actor: typeof data.actor === "string" ? data.actor : undefined,
      role: isTenantRole(data.role) ? data.role : undefined,
      clientId: typeof data.clientId === "string" ? data.clientId : undefined,
    }) as RunCancelRequest;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function deleteRunCancelRequest(runDir: string, options?: HarnessServerOptions): Promise<void> {
  await options?.stateBackend?.documents.delete("run-cancel-request", basename(runDir));
  try {
    await unlink(join(runDir, RUN_CANCEL_REQUEST_FILE));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

	async function findPersistedRunningRun(runRoot: string): Promise<string | undefined> {
	  try {
	    const entries = await readdir(runRoot, { withFileTypes: true });
	    const states = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readRunState(join(runRoot, entry.name))),
    );
    states.sort((a, b) => startedAt(b).localeCompare(startedAt(a)));
    return states.find((state) => state.status === "running" && !runningRunIsStale(state))?.runId;
  } catch (error) {
    if (isNotFound(error)) return undefined;
	    throw error;
	  }
	}
	
	async function findBlockingPersistedRunningRun(options: HarnessServerOptions, runRoot: string): Promise<string | undefined> {
	  if (runWorkspacesAreIsolated(options)) return undefined;
	  return findPersistedRunningRun(runRoot);
	}

function runEventContext(access: TenantAccess | undefined, clientId: string | undefined): RunEventContext {
  return compactObject({
    actor: access?.actor,
    role: access?.role,
    clientId,
  });
}

function runRequester(access: TenantAccess | undefined, clientId: string | undefined): RunRequester | undefined {
  const requester = compactObject({
    actor: access?.actor,
    role: access?.role,
    clientId,
    modelKeyEnv: access?.modelKeyEnv,
  });
  return Object.keys(requester).length ? requester : undefined;
}

function publicRunRequester(requester: RunRequester | undefined): RunRequesterSummary | undefined {
  if (!requester) return undefined;
  const summary = compactObject({
    actor: requester.actor,
    role: requester.role,
    clientId: requester.clientId,
  });
  return Object.keys(summary).length ? summary : undefined;
}

function runRequesterFromUnknown(value: unknown): RunRequester | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("requester must be an object.");
  }
  const input = value as Record<string, unknown>;
  return runRequester(
    input.actor === undefined && input.role === undefined ? undefined : {
      actor: requireString(input.actor, "requester.actor"),
      role: tenantPolicyRole(input.role, "requester.role"),
      modelKeyEnv: input.modelKeyEnv === undefined ? undefined : envNameValue(input.modelKeyEnv, "requester.modelKeyEnv"),
    },
    optionalClientId(input.clientId),
  );
}

function runMetadata(
  input: {
    tenant: string;
    project: string;
    runId: string;
    repo?: string;
    branch?: string;
    baseBranch?: string;
    issue?: string;
    runPreset?: RunMetadata["runPreset"];
    runPresetInput?: RunMetadata["runPresetInput"];
    projectRunPolicy?: RunMetadata["projectRunPolicy"];
    projectContract?: RunMetadata["projectContract"];
    projectContractStatus?: RunMetadata["projectContractStatus"];
    agentMode?: RunMetadata["agentMode"];
    model?: string;
    modelProtocol?: RunMetadata["modelProtocol"];
    handoffSourceRunId?: string;
    handoffSourceProject?: string;
    handoffSourceStatus?: string;
    handoffSourceGoal?: string;
    handoffSourceCheckpointVersion?: string;
    handoffSourceProjectContract?: RunMetadata["handoffSourceProjectContract"];
    handoffSourceProjectContractStatus?: RunMetadata["handoffSourceProjectContractStatus"];
    handoffSourceReplayUrl?: string;
    handoffSourceHandoffPackageUrl?: string;
    handoffSourceControlPlaneProvider?: string;
    handoffSourceControlPlaneCommentId?: string;
    handoffSourceControlPlaneCommentUrl?: string;
    handoffSourceGiteaCommentId?: string;
    handoffSourceGiteaCommentUrl?: string;
  },
  options: HarnessServerOptions,
): RunMetadata {
  return compactMetadata({
    tenant: input.tenant,
    project: input.project,
    issue: input.issue,
    repo: input.repo,
    branch: input.branch,
    baseBranch: input.baseBranch,
    runPreset: input.runPreset,
    runPresetInput: input.runPresetInput,
    projectRunPolicy: input.projectRunPolicy,
    projectContract: input.projectContract,
    projectContractStatus: input.projectContractStatus,
    agentMode: input.agentMode,
    model: input.model,
    modelProtocol: input.modelProtocol,
    handoffSourceRunId: input.handoffSourceRunId,
    handoffSourceProject: input.handoffSourceProject,
    handoffSourceStatus: input.handoffSourceStatus,
    handoffSourceGoal: input.handoffSourceGoal,
    handoffSourceCheckpointVersion: input.handoffSourceCheckpointVersion,
    handoffSourceProjectContract: input.handoffSourceProjectContract,
    handoffSourceProjectContractStatus: input.handoffSourceProjectContractStatus,
    handoffSourceReplayUrl: input.handoffSourceReplayUrl,
    handoffSourceHandoffPackageUrl: input.handoffSourceHandoffPackageUrl,
    handoffSourceControlPlaneProvider: input.handoffSourceControlPlaneProvider,
    handoffSourceControlPlaneCommentId: input.handoffSourceControlPlaneCommentId,
    handoffSourceControlPlaneCommentUrl: input.handoffSourceControlPlaneCommentUrl,
    handoffSourceGiteaCommentId: input.handoffSourceGiteaCommentId,
    handoffSourceGiteaCommentUrl: input.handoffSourceGiteaCommentUrl,
    issueUrl: input.issue ? controlPlaneIssueUrl(options, input.issue) : undefined,
    dashboardUrl: options.publicUrl ? runDashboardUrl(options.publicUrl, input.tenant, input.project, input.runId) : undefined,
    summaryUrl: options.publicUrl ? runUrl(options.publicUrl, input.tenant, input.project, input.runId) : undefined,
  });
}

function runUrl(publicUrl: string, tenant: string, project: string, runId: string): string {
  const base = publicUrl.replace(/\/+$/, "");
  return `${base}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(runId)}?project=${encodeURIComponent(project)}`;
}

function runDashboardUrl(publicUrl: string, tenant: string, project: string, runId: string): string {
  const base = publicUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ tenant, project, runId });
  return `${base}/?${params.toString()}`;
}

function runEvidenceUrl(summaryUrl: string, child: "review-summary" | "handoff-package" | "handoff-runs"): string | undefined {
  try {
    const url = new URL(summaryUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${child}`;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function finalizeRun(
  options: HarnessServerOptions,
  summary: RunSummary,
  pullRequestRequested: boolean,
  appendAuditEvent?: TenantAuditAppender,
): Promise<RunSummary> {
  const withPullRequest = await reportPullRequest(options, summary, pullRequestRequested);
  await writeRunSummary(withPullRequest, options);
  const withIssue = await reportIssue(options, withPullRequest);
  return reportBrainIngest(options, withIssue, appendAuditEvent);
}

async function recordRunExternalEffect(summary: RunSummary, data: Record<string, unknown>, options: HarnessServerOptions): Promise<RunSummary> {
  const event = await appendRunEvent(summary.runDir, "external_effect", compactObject({
    ...data,
    requester: summary.requester,
  }), options.stateBackend?.events);
  const observed: RunSummary = { ...summary, eventCount: event.seq };
  await writeRunSummary(observed, options);
  await writeRunStatus(summary.runDir, observed, options);
  return observed;
}

async function markRunError(summary: RunSummary, message: string, options: HarnessServerOptions): Promise<RunSummary> {
  // Reporter/upstream failure messages can echo credentials; scrub before they
  // persist into the summary and error event (both viewer-readable).
  message = scrubSecretText(message);
  const event = await recordRunError(summary, message, options);
  const failed: RunSummary = {
    ...summary,
    status: "error",
    endedAt: new Date().toISOString(),
    eventCount: event.seq,
    error: { message },
  };
  await writeRunSummary(failed, options);
  await writeRunStatus(summary.runDir, failed, options);
  return failed;
}

async function recordRunError(summary: RunSummary, message: string, options: HarnessServerOptions): Promise<HarnessEvent> {
  message = scrubSecretText(message);
  const event = await appendRunEvent(summary.runDir, "error", { message }, options.stateBackend?.events);
  const observed = { ...summary, eventCount: event.seq };
  await writeRunSummary(observed, options);
  await writeRunStatus(summary.runDir, observed, options);
  return event;
}

async function writeRunSummary(summary: RunSummary, options?: HarnessServerOptions): Promise<void> {
  await persistRunSummary(summary, options?.stateBackend?.documents);
}

async function writeRunStatus(runDir: string, status: ReadableRunState, options?: HarnessServerOptions): Promise<void> {
  await persistRunStatus(runDir, status, options?.stateBackend?.documents);
}

async function writeQueuedRunSnapshot(runDir: string, request: RunRequestBody, requester?: RunRequester, options?: HarnessServerOptions): Promise<HarnessQueuedRunSnapshot> {
  const snapshot: HarnessQueuedRunSnapshot = {
    schemaVersion: 1,
    request,
    requester,
  };
  await persistQueuedRunSnapshot(runDir, snapshot, options?.stateBackend?.documents);
  return snapshot;
}

function runCreateRequestHash(request: RunRequestBody, requester?: RunRequester): string {
  return createHash("sha256")
    .update(JSON.stringify({ request, requester }), "utf8")
    .digest("hex");
}

function createRunCreateRequestRecord(
  tenant: string,
  project: string,
  clientRequestId: string,
  requestHash: string,
  runId: string,
  runDir: string,
  statusCode: number,
): RunCreateRequestRecord {
  return {
    schemaVersion: 1,
    tenant,
    project,
    clientRequestId,
    requestHash,
    runId,
    runDir,
    statusCode,
    createdAt: new Date().toISOString(),
  };
}

async function readRunCreateRequestReplay(
  runRoot: string,
  tenant: string,
  project: string,
  clientRequestId: string,
  requestHash: string,
  options?: HarnessServerOptions,
  waitForStateMs = 0,
): Promise<{ statusCode: number; body: Record<string, unknown> } | undefined> {
  let record: RunCreateRequestRecord | undefined;
  const stored = await options?.stateBackend?.documents.get<unknown>(
    "run-create-request",
    runCreateRequestDocumentKey(tenant, project, clientRequestId),
  );
  if (stored) {
    record = runCreateRequestRecordFromUnknown(stored.value);
  } else {
    try {
      record = runCreateRequestRecordFromUnknown(
        JSON.parse(await readFile(runCreateRequestPath(runRoot, clientRequestId), "utf8")),
      );
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
  if (!record) return undefined;
  if (record.tenant !== tenant || record.project !== project || record.clientRequestId !== clientRequestId) return undefined;
  if (record.requestHash !== requestHash) {
    throw conflict("clientRequestId already belongs to a different run request.");
  }
  const deadline = Date.now() + waitForStateMs;
  try {
    for (;;) {
      try {
        const state = await readRunState(record.runDir, options);
        return {
          statusCode: record.statusCode,
          body: { ...state, idempotentReplay: true },
        };
      } catch (error) {
        if (!isNotFound(error) || Date.now() >= deadline) throw error;
        await delay(RUN_CREATE_REQUEST_REPLAY_POLL_MS);
      }
    }
  } catch (error) {
    if (isNotFound(error)) {
      throw conflict("clientRequestId already belongs to a run that is not readable.");
    }
    throw error;
  }
}

async function claimRunCreateRequestRecord(
  runRoot: string,
  record: RunCreateRequestRecord,
  options?: HarnessServerOptions,
): Promise<
  | { created: true; record: RunCreateRequestRecord }
  | { created: false; replay: { statusCode: number; body: Record<string, unknown> } }
> {
  await mkdir(runCreateRequestDir(runRoot), { recursive: true });
  const path = runCreateRequestPath(runRoot, record.clientRequestId);
  if (options?.stateBackend) {
    try {
      await options.stateBackend.documents.put(
        "run-create-request",
        runCreateRequestDocumentKey(record.tenant, record.project, record.clientRequestId),
        record,
        { expectedVersion: 0 },
      );
      await writeJsonFileAtomic(path, record);
      return { created: true, record };
    } catch (error) {
      if (!(error instanceof StateConflictError)) throw error;
      const replay = await readRunCreateRequestReplay(
        runRoot,
        record.tenant,
        record.project,
        record.clientRequestId,
        record.requestHash,
        options,
        RUN_CREATE_REQUEST_REPLAY_TIMEOUT_MS,
      );
      if (!replay) throw conflict("clientRequestId already belongs to a run request that is not readable.");
      return { created: false, replay };
    }
  }
  try {
    const file = await open(path, "wx");
    try {
      await file.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8");
    } finally {
      await file.close();
    }
    return { created: true, record };
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const replay = await readRunCreateRequestReplay(
      runRoot,
      record.tenant,
      record.project,
      record.clientRequestId,
      record.requestHash,
      options,
      RUN_CREATE_REQUEST_REPLAY_TIMEOUT_MS,
    );
    if (!replay) throw conflict("clientRequestId already belongs to a run request that is not readable.");
    return { created: false, replay };
  }
}

async function writeRunCreateRequestRecord(runRoot: string, record: RunCreateRequestRecord | undefined, options?: HarnessServerOptions): Promise<void> {
  if (!record) return;
  await options?.stateBackend?.documents.put(
    "run-create-request",
    runCreateRequestDocumentKey(record.tenant, record.project, record.clientRequestId),
    record,
  );
  await mkdir(runCreateRequestDir(runRoot), { recursive: true });
  await writeJsonFileAtomic(runCreateRequestPath(runRoot, record.clientRequestId), record);
}

async function deleteRunCreateRequestRecord(runRoot: string, record: RunCreateRequestRecord | undefined, options?: HarnessServerOptions): Promise<void> {
  if (!record) return;
  if (options?.stateBackend) {
    const key = runCreateRequestDocumentKey(record.tenant, record.project, record.clientRequestId);
    const current = await options.stateBackend.documents.get<RunCreateRequestRecord>("run-create-request", key);
    if (current?.value.runId === record.runId && current.value.requestHash === record.requestHash) {
      await options.stateBackend.documents.delete("run-create-request", key);
    }
  }
  const path = runCreateRequestPath(runRoot, record.clientRequestId);
  const current = await readRunCreateRequestRecord(path);
  if (current?.runId !== record.runId || current.requestHash !== record.requestHash) return;
  await unlink(path).catch((error) => {
    if (!isNotFound(error)) throw error;
  });
}

function runCreateRequestRecordFromUnknown(value: unknown): RunCreateRequestRecord | undefined {
  const data = recordData(value);
  if (data.schemaVersion !== 1) return undefined;
  const tenant = stringField(data, "tenant");
  const project = stringField(data, "project");
  const clientRequestId = stringField(data, "clientRequestId");
  const requestHash = stringField(data, "requestHash");
  const runId = stringField(data, "runId");
  const runDir = stringField(data, "runDir");
  const statusCode = numberField(data, "statusCode");
  const createdAt = stringField(data, "createdAt");
  if (!tenant || !project || !clientRequestId || !requestHash || !runId || !runDir || !statusCode || !createdAt) {
    return undefined;
  }
  return { schemaVersion: 1, tenant, project, clientRequestId, requestHash, runId, runDir, statusCode, createdAt };
}

async function readRunCreateRequestRecord(path: string): Promise<RunCreateRequestRecord | undefined> {
  try {
    return runCreateRequestRecordFromUnknown(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function runCreateRequestDir(runRoot: string): string {
  return join(runRoot, ".requests");
}

function runCreateRequestPath(runRoot: string, clientRequestId: string): string {
  const key = createHash("sha256").update(clientRequestId, "utf8").digest("hex");
  return join(runCreateRequestDir(runRoot), `${key}.json`);
}

function runCreateRequestDocumentKey(tenant: string, project: string, clientRequestId: string): string {
  return `${tenant}:${project}:${createHash("sha256").update(clientRequestId, "utf8").digest("hex")}`;
}

async function readQueuedRunSnapshot(runDir: string, options?: HarnessServerOptions): Promise<HarnessQueuedRunSnapshot> {
  const snapshot = await loadQueuedRunSnapshot<RunRequestBody, RunRequester>(runDir, options?.stateBackend?.documents);
  if (snapshot.schemaVersion !== 1 || typeof snapshot.request !== "object" || snapshot.request === null) {
    throw badRequest("invalid queued run snapshot.");
  }
  return snapshot;
}

function runEvidenceCheckpoint(
  state: ReadableRunState,
  events: HarnessEvent[],
  options: { auditTrail?: TenantAuditEvent[]; followupRuns?: RunHandoffFollowupEvidence[] } = {},
): RunEvidenceCheckpoint {
  const lastEvent = events[events.length - 1];
  const auditTrail = options.auditTrail ?? [];
  const lastAudit = auditTrail[auditTrail.length - 1];
  const checkpoint = compactObject({
    schemaVersion: 1,
    run: compactObject({
      runId: state.runId,
      status: state.status,
      eventCount: "eventCount" in state ? state.eventCount : events.length,
      lastEventSeq: lastEvent?.seq,
      lastEventAt: lastEvent?.ts,
    }),
    audit: options.auditTrail ? compactObject({
      eventCount: auditTrail.length,
      lastSeq: lastAudit?.seq,
      lastEventAt: lastAudit?.ts,
    }) : undefined,
    followups: options.followupRuns ? {
      count: options.followupRuns.length,
      runIds: options.followupRuns.map((run) => run.runId),
    } : undefined,
  }) as Omit<RunEvidenceCheckpoint, "version">;
  return {
    ...checkpoint,
    version: createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex").slice(0, 16),
  };
}

function runReplayFromEvents(state: ReadableRunState, events: HarnessEvent[]): RunReplay {
  const replay: RunReplay = {
    runId: state.runId,
    goal: state.goal,
    status: state.status,
    startedAt: startedAt(state),
    eventCount: "eventCount" in state ? state.eventCount : events.length,
    checkpoint: runEvidenceCheckpoint(state, events),
    timeline: events.map(replayEntryFromEvent),
  };
  if (state.metadata) replay.metadata = state.metadata;
  if ("endedAt" in state) replay.endedAt = state.endedAt;
  return replay;
}

function publicRunErrorSummary(error: RunSummary["error"] | undefined): RunSummary["error"] | undefined {
  if (!error) return undefined;
  const details = publicRunErrorDetails(error.details);
  return compactObject({
    message: error.message,
    phase: error.phase,
    iteration: error.iteration,
    kind: error.kind,
    details: Object.keys(details).length ? details : undefined,
  });
}

function publicRunErrorDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!details) return {};
  return Object.fromEntries(Object.entries(details).flatMap(([key, value]) => {
    if (isSensitiveDiagnosticKey(key)) return [];
    const detailValue = publicRunErrorDetailValue(value);
    const detailKey = boundedDiagnosticText(key, 40).replace(/\s+/g, "_");
    return detailKey && detailValue !== undefined ? [[detailKey, detailValue]] : [];
  }));
}

function publicRunErrorDetailValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") return boundedDiagnosticText(value, 160);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

function isRunSummaryState(state: ReadableRunState): state is RunSummary {
  return "endedAt" in state && "verification" in state;
}

function runExternalEffectEvidence(events: HarnessEvent[]): RunExternalEffectEvidence[] {
  return events.flatMap((event) => {
    if (event.type !== "external_effect") return [];
    const data = recordData(event.data);
    const entry: RunExternalEffectEvidence = compactObject({
      seq: event.seq,
      ts: event.ts,
      kind: stringField(data, "kind"),
      requester: runRequesterSummaryField(data, "requester"),
      issue: stringField(data, "issue"),
      issueUrl: stringField(data, "issueUrl"),
      dashboardUrl: stringField(data, "dashboardUrl"),
      summaryUrl: stringField(data, "summaryUrl"),
      reviewSummaryUrl: stringField(data, "reviewSummaryUrl"),
      handoffPackageUrl: stringField(data, "handoffPackageUrl"),
      branch: stringField(data, "branch"),
      baseBranch: stringField(data, "baseBranch"),
      commit: stringField(data, "commit"),
      pullRequestIndex: numberField(data, "pullRequestIndex"),
      pullRequestUrl: stringField(data, "pullRequestUrl"),
      clientId: stringField(data, "clientId"),
      status: stringField(data, "status"),
      outcome: stringField(data, "outcome"),
      failureKind: stringField(data, "failureKind"),
      reviewerStatus: stringField(data, "reviewerStatus"),
      reviewerExitCode: numberField(data, "reviewerExitCode"),
      reviewerCommands: stringArrayField(data, "reviewerCommands"),
      skillCount: numberField(data, "skillCount"),
    }) as RunExternalEffectEvidence;
    return [entry];
  });
}

function latestRunExternalEffect(events: HarnessEvent[], kind: string): Record<string, unknown> {
  const event = [...events].reverse().find((entry) => {
    const data = recordData(entry.data);
    return entry.type === "external_effect" && data.kind === kind;
  });
  return recordData(event?.data);
}

function runEvidencePath(tenant: string, project: string, runId: string, child: "review-summary" | "handoff-package"): string {
  return `/tenants/${tenant}/runs/${runId}/${child}${runProjectQuery(project)}`;
}

function runRequesterSummaryField(data: Record<string, unknown>, key: string): RunRequesterSummary | undefined {
  const value = recordData(data[key]);
  const requester = compactObject({
    actor: stringField(value, "actor"),
    role: stringField(value, "role"),
    clientId: stringField(value, "clientId"),
  });
  return Object.keys(requester).length ? requester : undefined;
}

function runChangedFileHintsField(data: Record<string, unknown>, key: string): RunChangedFileHint[] | undefined {
  const value = data[key];
  if (!Array.isArray(value)) return undefined;
  const files = value.flatMap((item) => {
    const record = recordData(item);
    const path = stringField(record, "path");
    const status = runChangedFileStatusField(record, "status");
    if (!path || !status) return [];
    return [compactObject({ path, status, previousPath: stringField(record, "previousPath") })];
  });
  return files.length ? files : undefined;
}

function runChangedFileStatusField(data: Record<string, unknown>, key: string): RunChangedFileStatus | undefined {
  const value = data[key];
  return value === "added" || value === "modified" || value === "deleted" || value === "renamed" || value === "copied"
    ? value
    : undefined;
}

function shouldCloseRunEventStream(state: ReadableRunState | undefined, latestEvent: HarnessEvent | undefined, lastSeq: number): boolean {
  if (!state || !latestEvent || latestEvent.type !== "finish") return false;
  if (latestEvent.seq > lastSeq) return false;
  return state.status !== "running" && state.status !== "queued";
}

function latestRunEvent(events: HarnessEvent[]): HarnessEvent | undefined {
  return events.reduce<HarnessEvent | undefined>(
    (latest, event) => latest === undefined || event.seq > latest.seq ? event : latest,
    undefined,
  );
}

async function readRunEventsIfPresent(runDir: string, options?: HarnessServerOptions): Promise<HarnessEvent[]> {
  try {
    return await readRunEvents(runDir, options?.stateBackend?.events);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function readRunStateIfPresent(runDir: string, options?: HarnessServerOptions): Promise<ReadableRunState | undefined> {
  return loadRunStateIfPresent(runDir, options?.stateBackend?.documents);
}

async function readRunStateForScan(runDir: string, options?: HarnessServerOptions): Promise<ReadableRunState | undefined> {
  try {
    return await readRunState(runDir, options);
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function createAgent(body: RunRequestBody, cwd: string, options: HarnessServerOptions, tenant: string, access?: { modelKeyEnv?: string }): Promise<HarnessAgent> {
  let agent: HarnessAgent;
  const setupSteps = runPresetName(body.preset) === VAS_LITE_REVIEW_PRESET && Array.isArray(body.__presetSetupSteps)
    ? body.__presetSetupSteps
    : [];
  if (Array.isArray(body.script)) {
    agent = createScriptedAgentFromSteps(body.script as AgentStep[], { assistantEventOffset: setupSteps.length });
  } else if (typeof body.agentCommand === "string" && body.agentCommand.trim()) {
    agent = createCommandAgent(body.agentCommand, cwd);
  } else {
    const model = requestedModel(body, options);
    if (!model) {
      throw badRequest("Either script, agentCommand, or model is required.");
    }
    if (!options.modelBaseUrl) {
      throw badRequest("modelBaseUrl is required when using model agent.");
    }
    agent = createOpenAiCompatibleAgent({
      baseUrl: options.modelBaseUrl,
      model,
      protocol: requestedModelProtocol(body, options),
      apiKey: await effectiveTenantModelApiKey(options, tenant, access),
    });
  }

  if (setupSteps.length > 0) {
    return createAgentWithSetupSteps(setupSteps, agent);
  }
  return agent;
}

function runAgentMetadata(body: RunRequestBody, options: HarnessServerOptions): Pick<RunMetadata, "agentMode" | "model" | "modelProtocol"> {
  if (Array.isArray(body.script)) return { agentMode: "script" };
  if (typeof body.agentCommand === "string" && body.agentCommand.trim()) return { agentMode: "command" };
  const model = requestedModel(body, options);
  const modelProtocol = requestedModelProtocol(body, options);
  return model ? compactObject({ agentMode: "model" as const, model, modelProtocol: modelProtocol === "json" ? undefined : modelProtocol }) : {};
}

function requestedModel(body: RunRequestBody, options: HarnessServerOptions): string | undefined {
  return typeof body.model === "string" && body.model.trim() ? body.model.trim() : options.defaultModel;
}

function requestedModelProtocol(body: RunRequestBody, options: HarnessServerOptions): ModelAgentProtocol {
  if (body.modelProtocol === undefined) return options.modelProtocol ?? "json";
  if (body.modelProtocol !== "json" && body.modelProtocol !== "tool-call") {
    throw badRequest("modelProtocol must be json or tool-call.");
  }
  return body.modelProtocol;
}

async function effectiveTenantModelApiKey(options: HarnessServerOptions, tenant: string, access?: { modelKeyEnv?: string }): Promise<string | undefined> {
  const policy = await readTenantPolicy(resolve(options.workspaceRoot), tenant, options);
  const envName = access?.modelKeyEnv ?? policy?.modelKeyEnv ?? options.tenantModelKeyEnvs?.[tenant];
  if (!envName) return options.modelApiKey;
  const value = process.env[envName];
  if (!value) throw badRequest(`tenant model key env ${envName} is not set.`);
  return value;
}

function runPresetName(value: unknown): RunPresetName | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === VAS_LITE_REVIEW_PRESET) return value;
  throw badRequest("preset must be vas-lite-review.");
}

function presenceClientId(value: unknown): string {
  const clientId = requireString(value, "clientId").trim();
  if (clientId.length > 120 || /[\0\r\n]/.test(clientId)) {
    throw badRequest("clientId must be a single-line string at most 120 characters.");
  }
  return clientId;
}

function runCommentMessage(value: unknown): string {
  const message = requireString(value, "message").trim();
  if (message.length > 4000 || /\0/.test(message)) {
    throw badRequest("message must be a string at most 4000 characters.");
  }
  return message;
}

async function linkedIssueRuns(workspaceRoot: string, tenant: string, issue: string, project?: string): Promise<LinkedIssueRun[]> {
  const projects = project ? [project] : await listTenantProjectNames(workspaceRoot, tenant);
  const runs: LinkedIssueRun[] = [];
  for (const currentProject of projects) {
    const runsRoot = join(workspaceRoot, tenant, currentProject, ".loom", "runs");
    let entries;
    try {
      entries = await readdir(runsRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = join(runsRoot, entry.name);
      let state: ReadableRunState;
      try {
        state = await readRunState(runDir);
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      if (state.metadata?.issue !== issue) continue;
      runs.push({ project: currentProject, runId: state.runId, runDir, state });
    }
  }
  runs.sort((a, b) => startedAt(b.state).localeCompare(startedAt(a.state)));
  return runs;
}

function presenceLabel(value: unknown, access: TenantAccess | undefined, clientId: string): string {
  const label = (optionalString(value, "label") ?? access?.actor ?? clientId).trim();
  if (label.length > 120 || /[\0\r\n]/.test(label)) {
    throw badRequest("label must be a single-line string at most 120 characters.");
  }
  return label;
}

function presenceFocus(value: unknown): string | undefined {
  const focus = optionalString(value, "focus")?.trim();
  if (focus === undefined) return undefined;
  if (!focus) return undefined;
  if (focus.length > 160 || /[\0\r\n]/.test(focus)) {
    throw badRequest("focus must be a single-line string at most 160 characters.");
  }
  return focus;
}

function activeRunKey(tenant: string, project: string, runId: string): string {
  return `${tenant}\0${project}\0${runId}`;
}

function presenceFilePath(root: string, clientId: string): string {
  return join(root, `${createHash("sha256").update(clientId).digest("hex")}.json`);
}

async function persistPresenceEntry(root: string, entry: StoredRunPresenceEntry): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeJsonFileAtomic(presenceFilePath(root, entry.clientId), entry);
}

async function refreshRunPresenceFromDisk(
  presence: RunPresenceRegistry,
  projectRoot: string,
  tenant: string,
  project: string,
  runId: string,
): Promise<void> {
  await refreshPresenceDirectory(presence, runPresenceRootFromProjectRoot(projectRoot, runId), { tenant, project, runId });
}

async function refreshPresenceDirectory(
  presence: RunPresenceRegistry,
  root: string,
  expected: { tenant: string; project: string; runId?: string },
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const nowMs = Date.now();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(root, entry.name);
    const stored = await readStoredPresenceEntry(path);
    if (!stored) continue;
    const key = presenceRegistryKey(stored);
    if (stored.expiresAtMs <= nowMs) {
      presence.delete(key);
      await unlink(path).catch((error) => {
        if (!isNotFound(error)) throw error;
      });
      continue;
    }
    if (
      stored.tenant !== expected.tenant ||
      stored.project !== expected.project ||
      stored.runId !== expected.runId
    ) {
      continue;
    }
    presence.set(key, stored);
  }
}

async function readStoredPresenceEntry(path: string): Promise<StoredRunPresenceEntry | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return storedPresenceEntryFromRecord(value);
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function storedPresenceEntryFromRecord(value: Record<string, unknown>): StoredRunPresenceEntry | undefined {
  const tenant = stringField(value, "tenant");
  const project = stringField(value, "project");
  const runId = stringField(value, "runId");
  const clientId = stringField(value, "clientId");
  const label = stringField(value, "label");
  const focus = stringField(value, "focus");
  const actor = stringField(value, "actor");
  const role = tenantRoleField(value, "role");
  const seenAt = stringField(value, "seenAt");
  const expiresAt = stringField(value, "expiresAt");
  const expiresAtMs = typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs)
    ? value.expiresAtMs
    : expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  if (!tenant || !project || !clientId || !label || !seenAt || !expiresAt || !Number.isFinite(expiresAtMs)) {
    return undefined;
  }
  return compactObject({
    tenant,
    project,
    runId,
    clientId,
    label,
    focus,
    actor,
    role,
    seenAt,
    expiresAt,
    expiresAtMs,
  }) as StoredRunPresenceEntry;
}

function presenceRegistryKey(entry: Pick<StoredRunPresenceEntry, "tenant" | "project" | "runId" | "clientId">): string {
  return entry.runId
    ? runPresenceKey(entry.tenant, entry.project, entry.runId, entry.clientId)
    : projectPresenceKey(entry.tenant, entry.project, entry.clientId);
}

function runPresenceKey(tenant: string, project: string, runId: string, clientId: string): string {
  return `${tenant}\0${project}\0${runId}\0${clientId}`;
}

function purgeExpiredRunPresence(presence: RunPresenceRegistry, nowMs = Date.now()): void {
  for (const [key, entry] of presence) {
    if (entry.expiresAtMs <= nowMs) presence.delete(key);
  }
}

function runPresenceEntries(
  presence: RunPresenceRegistry,
  tenant: string,
  project: string,
  runId: string,
): RunPresenceEntry[] {
  return [...presence.values()]
    .filter((entry) => entry.tenant === tenant && entry.project === project && entry.runId === runId)
    .sort((a, b) => a.label.localeCompare(b.label) || a.clientId.localeCompare(b.clientId))
    .map(publicRunPresenceEntry);
}

function publicRunPresenceEntry(entry: StoredRunPresenceEntry): RunPresenceEntry {
  const { expiresAtMs: _expiresAtMs, ...publicEntry } = entry;
  return publicEntry;
}

async function enforceModelUsageTokenLimitsForBody(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenant: string,
  project: string,
  body: RunRequestBody,
  requester: RunRequester | undefined,
): Promise<void> {
  if (runAgentMetadata(body, options).agentMode !== "model") return;
  await enforceModelUsageTokenLimits(workspaceRoot, options, tenant, project, requester);
}

async function enforceModelUsageTokenLimits(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenant: string,
  project: string,
  requester: RunRequester | undefined,
): Promise<void> {
  const policyLimits = (await readTenantPolicy(workspaceRoot, tenant, options))?.limits;
  const projectTokenLimit = policyLimits?.modelProjectTotalTokenLimit;
  const requesterTokenLimit = policyLimits?.modelRequesterTotalTokenLimit;
  const projectCostLimit = policyLimits?.modelProjectCostUsdLimit;
  const requesterCostLimit = policyLimits?.modelRequesterCostUsdLimit;
  if (
    projectTokenLimit === undefined &&
    requesterTokenLimit === undefined &&
    projectCostLimit === undefined &&
    requesterCostLimit === undefined
  ) return;

  const summary = await readProjectSummary(join(workspaceRoot, tenant), tenant, project, policyLimits);
  const projectTokens = summary.modelUsage?.totalTokens ?? 0;
  if (projectTokenLimit !== undefined && projectTokens >= projectTokenLimit) {
    throw conflict(`project model token limit exceeded: ${projectTokens} >= ${projectTokenLimit}`);
  }
  const projectCostUsd = summary.modelUsage?.costUsd ?? 0;
  if (projectCostLimit !== undefined && projectCostUsd >= projectCostLimit) {
    throw conflict(`project model cost limit exceeded: ${projectCostUsd} >= ${projectCostLimit}`);
  }

  if (requesterTokenLimit === undefined && requesterCostLimit === undefined) return;
  const publicRequester = publicRunRequester(requester) ?? {};
  const requesterKey = projectModelUsageRequesterKey(publicRequester);
  const requesterUsage = (summary.modelUsageByRequester ?? [])
    .find((entry) => projectModelUsageRequesterKey(entry.requester) === requesterKey);
  const requesterTokens = requesterUsage?.totalTokens ?? 0;
  if (requesterTokenLimit !== undefined && requesterTokens >= requesterTokenLimit) {
    throw conflict(`requester model token limit exceeded for ${projectModelUsageRequesterLabel(publicRequester)}: ${requesterTokens} >= ${requesterTokenLimit}`);
  }
  const requesterCostUsd = requesterUsage?.costUsd ?? 0;
  if (requesterCostLimit !== undefined && requesterCostUsd >= requesterCostLimit) {
    throw conflict(`requester model cost limit exceeded for ${projectModelUsageRequesterLabel(publicRequester)}: ${requesterCostUsd} >= ${requesterCostLimit}`);
  }
}

function hasExplicitAgent(body: RunRequestBody): boolean {
  return body.script !== undefined || body.agentCommand !== undefined || body.model !== undefined;
}

async function reportIssue(options: HarnessServerOptions, summary: RunSummary): Promise<RunSummary> {
  if (summary.status === "cancelled" || summary.status === "paused") return summary;
  if (!summary.metadata?.issue || !options.issueReporter) return summary;
  try {
    await options.issueReporter(summary);
    return recordRunExternalEffect(summary, {
      kind: "issue_comment",
      controlPlaneProvider: controlPlaneProviderName(options),
      issue: summary.metadata.issue,
      issueUrl: summary.metadata.issueUrl,
      dashboardUrl: summary.metadata.dashboardUrl,
      summaryUrl: summary.metadata.summaryUrl,
      reviewSummaryUrl: summary.metadata.summaryUrl ? runEvidenceUrl(summary.metadata.summaryUrl, "review-summary") : undefined,
      handoffPackageUrl: summary.metadata.summaryUrl ? runEvidenceUrl(summary.metadata.summaryUrl, "handoff-package") : undefined,
      handoffFollowupsUrl: summary.metadata.summaryUrl ? runEvidenceUrl(summary.metadata.summaryUrl, "handoff-runs") : undefined,
    }, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markRunError(summary, `issue reporter failed: ${message}`, options);
  }
}

async function reportPullRequest(
  options: HarnessServerOptions,
  summary: RunSummary,
  pullRequestRequested: boolean,
): Promise<RunSummary> {
  if (!pullRequestRequested || !options.pullRequestReporter) return summary;
  if (summary.status !== "passed" && summary.status !== "review_required" && summary.status !== "deployment_required") return summary;
  try {
    const result = await options.pullRequestReporter(summary);
    const withPullRequest = result ? {
      ...summary,
      metadata: {
        ...summary.metadata,
        pullRequestIndex: result.index,
        pullRequestUrl: result.url,
      },
    } : summary;
    return recordRunExternalEffect(withPullRequest, {
      kind: "pull_request",
      controlPlaneProvider: controlPlaneProviderName(options),
      issue: withPullRequest.metadata?.issue,
      issueUrl: withPullRequest.metadata?.issueUrl,
      branch: withPullRequest.metadata?.branch,
      baseBranch: withPullRequest.metadata?.baseBranch,
      pullRequestIndex: withPullRequest.metadata?.pullRequestIndex,
      pullRequestUrl: withPullRequest.metadata?.pullRequestUrl,
      dashboardUrl: withPullRequest.metadata?.dashboardUrl,
      summaryUrl: withPullRequest.metadata?.summaryUrl,
      reviewSummaryUrl: withPullRequest.metadata?.summaryUrl ? runEvidenceUrl(withPullRequest.metadata.summaryUrl, "review-summary") : undefined,
      handoffPackageUrl: withPullRequest.metadata?.summaryUrl ? runEvidenceUrl(withPullRequest.metadata.summaryUrl, "handoff-package") : undefined,
      handoffFollowupsUrl: withPullRequest.metadata?.summaryUrl ? runEvidenceUrl(withPullRequest.metadata.summaryUrl, "handoff-runs") : undefined,
    }, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markRunError(summary, `pull request reporter failed: ${message}`, options);
  }
}

async function reportBrainIngest(
  options: HarnessServerOptions,
  summary: RunSummary,
  appendAuditEvent?: TenantAuditAppender,
): Promise<RunSummary> {
  if (!options.brainIngest || summary.status === "cancelled" || summary.status === "paused") return summary;
  try {
    await options.brainIngest(summary);
    const data = brainSignalAuditData(summary);
    if (appendAuditEvent && summary.metadata?.tenant) {
      await appendAuditEvent(summary.metadata.tenant, "brain_signal_ingested", data);
    }
    return recordRunExternalEffect(summary, {
      kind: "brain_ingest",
      ...data,
      skills: summary.skills,
    }, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markRunError(summary, `brain ingest failed: ${message}`, options);
  }
}

async function readJson(req: IncomingMessage): Promise<RunRequestBody> {
  return readJsonBody<RunRequestBody>(req);
}

function replayEntryFromEvent(event: HarnessEvent): RunReplayEntry {
  const data = recordData(event.data);
  return compactReplayEntry({
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    title: replayTitle(event, data),
    detail: replayDetail(data),
    requester: runRequesterSummaryField(data, "requester"),
    actor: stringField(data, "actor"),
    role: tenantRoleField(data, "role"),
    clientId: stringField(data, "clientId"),
    toolName: stringField(data, "toolName"),
    actionId: stringField(data, "actionId") ?? stringField(data, "id"),
    ok: booleanField(data, "ok"),
    status: stringField(data, "status"),
    iteration: numberField(data, "iteration"),
    actionCount: numberField(data, "actionCount"),
    finishRequested: booleanField(data, "finishRequested"),
    phase: stringField(data, "phase"),
    plan: stringField(data, "plan"),
    contractPatch: projectContractPatchField(data, "contractPatch"),
    runReviewContractPatch: projectContractPatchField(data, "runReviewContractPatch"),
  });
}

function replayTitle(event: HarnessEvent, data: Record<string, unknown>): string {
  if (event.type === "user_message") return `User: ${replayText(data.content) ?? replayText(data.goal) ?? "message"}`;
  if (event.type === "assistant_message") {
    const iteration = numberField(data, "iteration");
    return iteration === undefined ? "Assistant message" : `Assistant message ${iteration}`;
  }
  if (event.type === "action") return `Tool action: ${stringField(data, "toolName") ?? "unknown"}`;
  if (event.type === "observation") {
    const toolName = stringField(data, "toolName") ?? "unknown";
    return `Observation: ${toolName} ${booleanField(data, "ok") === false ? "failed" : "passed"}`;
  }
  if (event.type === "verification") return `Verification ${booleanField(data, "ok") === false ? "failed" : "passed"}`;
  if (event.type === "evaluation") return `Evaluation ${booleanField(data, "ok") === false ? "failed" : "passed"}`;
  if (event.type === "reviewer") return `Reviewer ${booleanField(data, "ok") === false ? "flagged" : "passed"}`;
  if (event.type === "finish") return `Finish: ${stringField(data, "status") ?? "unknown"}`;
  if (event.type === "workspace_prepare") return `Workspace prepare: ${stringField(data, "status") ?? "unknown"}`;
  if (event.type === "review_gate") return `Review: ${stringField(data, "status") ?? "unknown"}`;
  if (event.type === "review_claim") return `Review claim: ${stringField(data, "action") ?? "unknown"}`;
  if (event.type === "deployment_gate") return `Deployment: ${stringField(data, "status") ?? "unknown"}`;
  if (event.type === "external_effect") return `External effect: ${stringField(data, "kind") ?? "unknown"}`;
  if (event.type === "agent_retry") return `Agent retry: ${stringField(data, "kind") ?? "unknown"}`;
  if (event.type === "model_usage") return `Model usage: ${stringField(data, "model") ?? stringField(data, "responseModel") ?? "unknown"}`;
  if (event.type === "run_metadata") return "Run metadata";
  if (event.type === "run_policy") return "Run policy";
  if (event.type === "resume") return "Resume";
  if (event.type === "pause") return "Pause";
  if (event.type === "cancel") return "Cancel";
  if (event.type === "error") return "Error";
  return event.type;
}

function replayDetail(data: Record<string, unknown>): string | undefined {
  const detail =
    replayText(data.content) ??
    replayText(data.message) ??
    replayText(data.output) ??
    replayText(data.error) ??
    replayText(data.reason) ??
    replayText(data.note) ??
    undefined;
  const plan = replayText(data.plan);
  const retry = replayRetryDetail(data);
  const modelUsage = replayModelUsageDetail(data);
  const diagnostics = replayDiagnosticDetail(data);
  const lines = [
    detail,
    plan ? `plan: ${plan}` : undefined,
    retry,
    modelUsage,
    diagnostics,
  ].filter((line): line is string => Boolean(line));
  if (lines.length) return lines.join("\n");
  return Object.keys(data).length ? replayText(JSON.stringify(data)) : undefined;
}

function replayDiagnosticDetail(data: Record<string, unknown>): string | undefined {
  const kind = replayText(data.kind);
  const details = replayDiagnosticDetails(data.details);
  const lines = [
    kind ? `kind=${kind}` : undefined,
    details ? `details=${details}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return lines.length ? lines.join("\n") : undefined;
}

function replayModelUsageDetail(data: Record<string, unknown>): string | undefined {
  const lines = [
    stringField(data, "requestId") ? `requestId=${stringField(data, "requestId")}` : undefined,
    stringField(data, "responseModel") ? `responseModel=${stringField(data, "responseModel")}` : undefined,
    numberField(data, "promptTokens") === undefined ? undefined : `promptTokens=${numberField(data, "promptTokens")}`,
    numberField(data, "completionTokens") === undefined ? undefined : `completionTokens=${numberField(data, "completionTokens")}`,
    numberField(data, "totalTokens") === undefined ? undefined : `totalTokens=${numberField(data, "totalTokens")}`,
    numberField(data, "costUsd") === undefined ? undefined : `costUsd=${numberField(data, "costUsd")}`,
    numberField(data, "attempt") === undefined ? undefined : `attempt=${numberField(data, "attempt")}`,
  ].filter((line): line is string => Boolean(line));
  return lines.length ? lines.join("\n") : undefined;
}

function replayRetryDetail(data: Record<string, unknown>): string | undefined {
  const attempt = numberField(data, "attempt");
  const nextAttempt = numberField(data, "nextAttempt");
  const lines = [
    attempt === undefined ? undefined : `attempt=${attempt}`,
    nextAttempt === undefined ? undefined : `nextAttempt=${nextAttempt}`,
  ].filter((line): line is string => Boolean(line));
  return lines.length ? lines.join("\n") : undefined;
}

function replayDiagnosticDetails(value: unknown): string | undefined {
  const details = recordData(value);
  // This detail renders into viewer-readable run replay and the tenant audit
  // stream. Drop entries whose key names a secret and bound each value, matching
  // the run-summary diagnostic filter, so an upstream error that echoes a token
  // cannot leak through the diagnostic path.
  const pairs = Object.entries(details)
    .filter(([key]) => !isSensitiveDiagnosticKey(key))
    .map(([key, entry]) => {
      const rendered = replayDiagnosticValue(entry);
      return rendered === undefined ? undefined : `${key}=${boundedDiagnosticText(rendered, 200)}`;
    })
    .filter((pair): pair is string => pair !== undefined);
  return pairs.length ? replayText(pairs.join(" ")) : undefined;
}

function replayDiagnosticValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Drop nested objects/arrays rather than JSON.stringify them: a nested
  // { token: ... } sitting under a non-sensitive top-level key would otherwise
  // leak here. Mirrors publicRunErrorDetailValue in the run-summary path.
  return undefined;
}

function compactReplayEntry(entry: RunReplayEntry): RunReplayEntry {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as RunReplayEntry;
}

function runCreateIdempotencyStatus(): RunCreateIdempotencyStatus {
  return {
    clientRequestId: true,
    sharedRunStore: true,
    crossServerReplay: true,
    simultaneousCreateReplay: true,
    conflictOnRequestMismatch: true,
  };
}

export { RunRequestBody, RunPresetName, RunCommentRequestBody, RunResumeRequestBody, PresenceRequestBody, RunEventContext, LinkedIssueRun, InitialRunEvent, HarnessRunStart, QueuedRun, ActiveRun, ActiveRunSlot, RunCreateIdempotencyStatus, QueueRecoveryAudit, StaleRunCleanupAudit, RunReplay, RunEvidenceCheckpoint, RunReplayEntry, RunChangedFileHint, RunExternalEffectEvidence, RunPresenceEntry, StoredRunPresenceEntry, RunPresenceRegistry, RUN_PRESENCE_TTL_MS, RUN_PAUSE_REQUEST_FILE, RUN_CANCEL_REQUEST_FILE, RUN_CONTROL_POLL_INTERVAL_MS, DISTRIBUTED_RUN_QUEUE_POLL_MS, tenantActiveRunLimit, effectiveTenantActiveRunLimit, tenantRunCapacityScope, activeTenantRunCount, activeTenantRunIds, queuedTenantRunCount, activeRunCollaboratorSummary, queuedRunPositions, queuedRunConcurrencySummary, handleListRuns, handleCreateRun, createAsyncRunFromBody, drainQueuedRuns, recoverQueuedRuns, cleanupStaleRunningRuns, isSafePersistedRunState, listPersistedRunDirs, handleAbandonRun, handleCancelRun, handleResumeRun, resumePausedRun, handleCreateRunComment, handleUpdateRunPresence, handleListRunPresence, handleReadRun, readRunStatesForListing, readRunState, writeRunPauseRequest, findBlockingPersistedRunningRun, runEventContext, runRequester, publicRunRequester, runUrl, runDashboardUrl, runEvidenceUrl, recordRunExternalEffect, markRunError, recordRunError, writeRunSummary, writeRunStatus, runEvidenceCheckpoint, runReplayFromEvents, publicRunErrorSummary, isRunSummaryState, runExternalEffectEvidence, latestRunExternalEffect, runEvidencePath, runRequesterSummaryField, runChangedFileHintsField, shouldCloseRunEventStream, latestRunEvent, readRunEventsIfPresent, readRunStateIfPresent, readRunStateForScan, createAgent, runAgentMetadata, runPresetName, presenceClientId, linkedIssueRuns, presenceLabel, presenceFocus, activeRunKey, persistPresenceEntry, refreshRunPresenceFromDisk, refreshPresenceDirectory, purgeExpiredRunPresence, runPresenceEntries, publicRunPresenceEntry, runCreateIdempotencyStatus, readPresenceJson, readJson };
