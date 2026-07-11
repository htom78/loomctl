import { createHmac } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { readTenantAuditEvents, type TenantAuditAppender, type TenantAuditEvent, type TenantRole } from "../audit.js";
import { createAgentGitServiceIssueWorkspaceAttachment, listAgentGitServiceIssueWorkspaces, type AgentGitServiceIssueWorkspace } from "../agent-git-service.js";
import { appendRunEvent } from "../run-store.js";
import { type QueuedRunStatus, type ReadableRunState, type RunningRunStatus } from "../run-state.js";
import type { DeploymentGate, HarnessEvent, ProjectContractEvidence, ProjectContractPatch, ProjectContractStatusEvidence, ReviewClaim, ReviewGate, RunMetadata, RunRequesterSummary, RunSummary } from "../events.js";
import { controlPlaneProviderCatalogEntry } from "../control-plane.js";
import { type GiteaIssueComment } from "../gitea.js";
import { updateProjectTemplateContract } from "../project-templates.js";
import { reviewerFocusForFailureKind } from "../../brain-evidence.js";
import { persistedRunningRunHasActiveAdmissionClaim } from "./admission.js";
import { RunRequestBody, RunPresetName, RunEventContext, InitialRunEvent, QueuedRun, ActiveRun, ActiveRunSlot, RunReplay, RunEvidenceCheckpoint, RunReplayEntry, RunChangedFileHint, RunExternalEffectEvidence, createAsyncRunFromBody, resumePausedRun, readRunState, writeRunPauseRequest, runEventContext, runEvidenceUrl, recordRunExternalEffect, recordRunError, writeRunSummary, writeRunStatus, runEvidenceCheckpoint, runReplayFromEvents, publicRunErrorSummary, isRunSummaryState, runExternalEffectEvidence, latestRunExternalEffect, runEvidencePath, runChangedFileHintsField, readRunEventsIfPresent, linkedIssueRuns, activeRunKey } from "./runs.js";
import { HarnessWorkspaceContext, ActiveWorkspaceSession, WorkspaceSessionSummary, WorkspaceCommandSummary, WorkspaceCommandResponse, WorkspaceInfo, runWorkspaceSessionRoot, runWorkspaceCommandRoot, readWorkspaceCommandSummaries, readWorkspaceSessionSummaries, workspaceDiff, workspaceInfo, runWorkspaceContext, workspaceDiffChangedFiles } from "./workspace.js";
import { controlPlaneProviderName } from "./status.js";
import { VasCaseReviewDecision, VasCaseClaimAction, RunReviewVasEvidence, VAS_LITE_REVIEW_PRESET, reviewVasLiteCase, claimVasLiteCase, readVasLiteCase, vasLiteRunCaseId, vasLiteCaseClaimAction, vasLiteCaseReviewDecisionField, runReviewVasEvidence, linkedIssueVasCases, linkedVasCaseIdsByProject } from "./vas.js";
import { ProjectContractRequestBody, ProjectSummary, projectContractFromBody, runProjectQuery, projectContractEvidenceField, projectContractPatchField, projectContractStatusEvidenceField } from "./projects.js";
import { TenantAccess, effectiveTenantAllowedTools, requireTenantTool, brainSignalFailureKind, runTenantAuditTrail, tenantRoleField, readTenantPolicy, requireTenantAccess, tenantRoleRank } from "./tenants.js";
import { HarnessServerOptions, PullRequestReporterResult, WorkspacePullRequestRequest, IssueCommentReaderContext } from "./types.js";
import { compactObject, latestAuditData, replayText, recordData, stringField, booleanField, numberField, headerValue, readJson, requireSafeName, optionalSafeName, optionalString, optionalClientId, timingSafeHexEqual, booleanFlag, badRequest, unauthorized, notFound, writeJson, isNotFound, startedAt, readJsonBody, readRawBody } from "./shared.js";

async function readReviewJson(req: IncomingMessage): Promise<ReviewRequestBody> {
  return readJsonBody<ReviewRequestBody>(req);
}

async function readReviewClaimJson(req: IncomingMessage): Promise<ReviewClaimRequestBody> {
  return readJsonBody<ReviewClaimRequestBody>(req);
}

async function readDeploymentJson(req: IncomingMessage): Promise<DeploymentRequestBody> {
  return readJsonBody<DeploymentRequestBody>(req);
}

async function readIssueCommentSyncJson(req: IncomingMessage): Promise<IssueCommentSyncRequestBody> {
  return readJsonBody<IssueCommentSyncRequestBody>(req);
}


interface HandoffFollowupRunRequestBody {
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
  queue?: unknown;
  syncIssueComments?: unknown;
  sourceCheckpointVersion?: unknown;
  clientId?: unknown;
  note?: unknown;
}
type RunReviewClaimAction = "claim" | "release";

interface ReviewRequestBody {
  decision?: unknown;
  note?: unknown;
  merge?: unknown;
  contractPatch?: unknown;
  clientId?: unknown;
}

interface ReviewClaimRequestBody {
  action?: unknown;
  clientId?: unknown;
}

interface DeploymentRequestBody {
  decision?: unknown;
  note?: unknown;
  clientId?: unknown;
}

interface IssueCommentSyncRequestBody {
  clientId?: unknown;
}

interface IssueCommentSyncContext {
  access?: TenantAccess;
  clientId?: string;
  deliveryId?: string;
  controlPlaneProvider?: string;
  actorPrefix?: string;
  controlPlaneIdentity?: IssueCommentControlPlaneIdentity;
}

interface IssueCommentControlPlaneIdentity {
  externalActor?: string;
  actor?: string;
  role?: TenantRole;
}

interface IssueCommentSkippedCounts {
  duplicate: number;
  loom: number;
  empty: number;
}

interface InitialIssueCommentEventsResult {
  events: InitialRunEvent[];
  skipped: IssueCommentSkippedCounts;
}

interface IssueCommentSyncResult {
  events: HarnessEvent[];
  pauseRequested: number;
  resumeRequested: number;
  runReviewRequested: number;
  runReviewClaimRequested: number;
  deploymentRequested: number;
  vasReviewRequested: number;
  vasRunRequested: number;
  vasClaimRequested: number;
  handoffFollowupRequested: number;
  skipped: IssueCommentSkippedCounts;
}

interface PreparedIssueCommentUserMessage {
  id: string;
  data?: Record<string, unknown>;
  skipped?: "empty" | "loom";
  pauseRequested?: boolean;
  resumeRequested?: boolean;
  runReviewRequested?: boolean;
  runReviewClaimRequested?: boolean;
  deploymentRequested?: boolean;
  vasReviewRequested?: boolean;
  vasRunRequested?: boolean;
  vasClaimRequested?: boolean;
  handoffFollowupRequested?: boolean;
}

interface IssueCommentResumeResult {
  requested: number;
  resumed: number;
  denied: number;
}

interface IssueCommentRunReviewResult {
  requested: number;
  reviewed: number;
  denied: number;
}

interface IssueCommentRunReviewClaimResult {
  requested: number;
  claimed: number;
  released: number;
  denied: number;
}

interface IssueCommentDeploymentResult {
  requested: number;
  deployed: number;
  denied: number;
}

interface IssueCommentVasReviewResult {
  requested: number;
  reviewed: number;
  denied: number;
}

interface IssueCommentVasRunResult {
  requested: number;
  started: number;
  denied: number;
  startedRuns: Array<{
    project: string;
    runId: string;
    status: RunningRunStatus["status"] | QueuedRunStatus["status"];
    caseId: string;
    controlPlaneProvider?: string;
    controlPlaneCommentId?: string;
    controlPlaneCommentUrl?: string;
    giteaCommentId?: string;
    giteaCommentUrl?: string;
  }>;
}

interface IssueCommentVasClaimResult {
  requested: number;
  claimed: number;
  released: number;
  denied: number;
  claimedCases: Array<{
    project: string;
    caseId: string;
    action: "claimed" | "released";
    controlPlaneProvider?: string;
    controlPlaneCommentId?: string;
    controlPlaneCommentUrl?: string;
    giteaCommentId?: string;
    giteaCommentUrl?: string;
  }>;
}

interface IssueCommentHandoffFollowupResult {
  requested: number;
  started: number;
  denied: number;
  startedRuns: Array<{
    project: string;
    sourceRunId: string;
    runId: string;
    status: RunningRunStatus["status"] | QueuedRunStatus["status"];
    sourceCheckpointVersion?: string;
    sourceProjectContractStatus?: ProjectContractStatusEvidence;
    controlPlaneProvider?: string;
    controlPlaneCommentId?: string;
    controlPlaneCommentUrl?: string;
    giteaCommentId?: string;
    giteaCommentUrl?: string;
    links: {
      workbench: string;
      handoffPackage: string;
    };
  }>;
}

interface ProjectHumanGateRunSummary {
  runId: string;
  goal: string;
  status: "review_required" | "deployment_required";
  startedAt?: string;
  issue?: string;
  issueUrl?: string;
  branch?: string;
  baseBranch?: string;
  pullRequestIndex?: number;
  pullRequestUrl?: string;
  requester?: RunRequesterSummary;
  reviewStatus?: ReviewGate["status"];
  deploymentStatus?: DeploymentGate["status"];
  claim?: ReviewClaim;
}

interface RunReviewSummary {
  runId: string;
  goal: string;
  status: ReadableRunState["status"];
  metadata?: RunMetadata;
  projectContract?: ProjectContractEvidence;
  projectContractStatus?: ProjectContractStatusEvidence;
  requester?: RunSummary["requester"];
  brain?: RunReviewBrainEvidence;
  vas?: RunReviewVasEvidence;
  review?: ReviewGate;
  deployment?: DeploymentGate;
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  verification?: RunSummary["verification"];
  evaluation?: RunSummary["evaluation"];
  reviewer?: RunSummary["reviewer"];
  modelUsage?: RunSummary["modelUsage"];
  error?: RunSummary["error"];
  checkpoint: RunEvidenceCheckpoint;
  diff: WorkspaceCommandResponse;
  changedFiles?: RunChangedFileHint[];
  timeline: RunReplayEntry[];
}

interface RunReviewBrainEvidence {
  outcome: "pass" | "fail";
  failureKind?: string;
  reviewerFocus?: string;
}

interface RunHandoffPackage {
  tenant: string;
  project: string;
  runId: string;
  generatedAt: string;
  checkpoint: RunEvidenceCheckpoint;
  reviewSummary: RunReviewSummary;
  workspace: WorkspaceInfo;
  handoff: RunHandoffEvidence;
  gateTrail: RunHandoffGateTrailEntry[];
  messages: RunHandoffMessageEvidence[];
  issueCommentSeeds: IssueCommentSeedEvidence[];
  externalEffects: RunExternalEffectEvidence[];
  followupRuns: RunHandoffFollowupEvidence[];
  commands: WorkspaceCommandSummary[];
  sessions: WorkspaceSessionSummary[];
  auditTrail: TenantAuditEvent[];
  links: RunHandoffLinks;
}

interface RunHandoffEvidence {
  issue?: string;
  issueUrl?: string;
  branch?: string;
  baseBranch?: string;
  commit?: string;
  pullRequestIndex?: number;
  pullRequestUrl?: string;
  reviewRequired?: boolean;
  deploymentRequired?: boolean;
}

interface RunHandoffMessageEvidence {
  seq: number;
  ts: string;
  kind: string;
  source?: string;
  content?: string;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  pauseRequested?: boolean;
  resumeRequested?: boolean;
  runReviewRequested?: boolean;
  runReviewDecision?: string;
  runReviewContractPatch?: ProjectContractPatch;
  runReviewClaimRequested?: boolean;
  runReviewClaimAction?: string;
  deploymentRequested?: boolean;
  deploymentDecision?: string;
  vasReviewRequested?: boolean;
  vasReviewDecision?: string;
  vasRunRequested?: boolean;
  vasRunCaseId?: string;
  vasClaimRequested?: boolean;
  vasClaimAction?: string;
  vasClaimCaseId?: string;
  issue?: string;
  issueUrl?: string;
  controlPlaneProvider?: string;
  controlPlaneCommentId?: string;
  controlPlaneCommentUrl?: string;
  controlPlaneExternalActor?: string;
  giteaCommentId?: string;
  giteaCommentUrl?: string;
  giteaCreatedAt?: string;
  giteaUpdatedAt?: string;
  syncedByActor?: string;
  syncedByRole?: TenantRole;
  deliveryId?: string;
  syncedIntoRun?: boolean;
  sourceRunId?: string;
  sourceProject?: string;
  sourceStatus?: string;
  sourceGoal?: string;
  sourceCheckpointVersion?: string;
  sourceProjectContract?: ProjectContractEvidence;
  sourceProjectContractStatus?: ProjectContractStatusEvidence;
  sourceIssue?: string;
  sourceIssueUrl?: string;
  sourceBranch?: string;
  sourceBaseBranch?: string;
  sourceCommit?: string;
  sourcePullRequestUrl?: string;
  sourceReviewStatus?: string;
  sourceDeploymentStatus?: string;
  sourceChangedFileCount?: number;
  sourceChangedFiles?: RunChangedFileHint[];
  sourceCommandCount?: number;
  sourceCommands?: RunHandoffSourceCommandEvidence[];
  sourceSessionCount?: number;
  sourceSessions?: RunHandoffSourceSessionEvidence[];
  sourceMessageCount?: number;
  sourceGateCount?: number;
  sourceExternalEffectCount?: number;
  sourceReplayUrl?: string;
  sourceHandoffPackageUrl?: string;
}

interface RunHandoffSourceCommandEvidence {
  commandId: string;
  command: string;
  exitCode: number;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
}

interface RunHandoffSourceSessionEvidence {
  sessionId: string;
  command: string;
  status: WorkspaceSessionSummary["status"];
  exitCode?: number;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
}

interface RunHandoffFollowupEvidence {
  runId: string;
  project: string;
  status?: ReadableRunState["status"];
  goal?: string;
  createdAt: string;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  controlPlaneProvider?: string;
  controlPlaneCommentId?: string;
  controlPlaneCommentUrl?: string;
  giteaCommentId?: string;
  giteaCommentUrl?: string;
  sourceCheckpointVersion?: string;
  sourceProjectContractStatus?: ProjectContractStatusEvidence;
  links: {
    run: string;
    workbench: string;
    handoffPackage: string;
  };
}

interface IssueCommentSeedEvidence {
  runId?: string;
  issue?: string;
  issueUrl?: string;
  initial?: boolean;
  synced?: number;
  skippedDuplicate?: number;
  skippedLoom?: number;
  skippedEmpty?: number;
  handoffFollowupRequested?: number;
  handoffFollowupStarted?: number;
  handoffFollowupDenied?: number;
  handoffFollowupRunId?: string;
  sourceCheckpointVersion?: string;
  controlPlaneProvider?: string;
  controlPlaneCommentId?: string;
  controlPlaneCommentUrl?: string;
  giteaCommentId?: string;
  giteaCommentUrl?: string;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
}

interface RunHandoffGateTrailEntry {
  gate: "review" | "deployment";
  seq: number;
  ts: string;
  source: "run_event";
  status?: "pending" | "approved" | "rejected";
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  note?: string;
  contractPatch?: ProjectContractPatch;
}

interface RunHandoffLinks {
  run: string;
  events: string;
  replay: string;
  reviewSummary: string;
  followupRuns: string;
  workspace: string;
  diff: string;
  dashboard: string;
  workbench: string;
}
const HANDOFF_FOLLOWUP_CONTEXT_LIMIT = 20;

function projectHumanGateRunSummary(
  states: ReadableRunState[],
): Partial<Pick<ProjectSummary, "reviewRequiredRunCount" | "reviewRequiredRunIds" | "reviewRequiredRuns" | "deploymentRequiredRunCount" | "deploymentRequiredRunIds" | "deploymentRequiredRuns">> {
  const reviewRequiredRuns = states
    .filter((state) => state.status === "review_required")
    .map(projectHumanGateRunDetail);
  const deploymentRequiredRuns = states
    .filter((state) => state.status === "deployment_required")
    .map(projectHumanGateRunDetail);
  const reviewRequiredRunIds = reviewRequiredRuns.map((run) => run.runId);
  const deploymentRequiredRunIds = deploymentRequiredRuns.map((run) => run.runId);
  return compactObject({
    reviewRequiredRunCount: reviewRequiredRunIds.length || undefined,
    reviewRequiredRunIds: reviewRequiredRunIds.length ? reviewRequiredRunIds : undefined,
    reviewRequiredRuns: reviewRequiredRuns.length ? reviewRequiredRuns : undefined,
    deploymentRequiredRunCount: deploymentRequiredRunIds.length || undefined,
    deploymentRequiredRunIds: deploymentRequiredRunIds.length ? deploymentRequiredRunIds : undefined,
    deploymentRequiredRuns: deploymentRequiredRuns.length ? deploymentRequiredRuns : undefined,
  });
}

function projectHumanGateRunDetail(state: ReadableRunState): ProjectHumanGateRunSummary {
  const metadata = state.metadata;
  const review = isRunSummaryState(state) ? state.review : undefined;
  const deployment = isRunSummaryState(state) ? state.deployment : undefined;
  return compactObject({
    runId: state.runId,
    goal: state.goal,
    status: state.status as "review_required" | "deployment_required",
    startedAt: startedAt(state),
    issue: metadata?.issue,
    issueUrl: metadata?.issueUrl,
    branch: metadata?.branch,
    baseBranch: metadata?.baseBranch,
    pullRequestIndex: metadata?.pullRequestIndex,
    pullRequestUrl: metadata?.pullRequestUrl,
    requester: state.requester,
    reviewStatus: review?.status,
    deploymentStatus: deployment?.status,
    claim: review?.claim,
  });
}

function controlPlaneIssueCommentActorPrefix(options: HarnessServerOptions): string {
  const provider = controlPlaneProviderName(options);
  return provider === "gitea-forgejo" ? "gitea" : provider;
}

function issueCommentSyncContextForOptions(
  options: HarnessServerOptions,
  context: IssueCommentSyncContext,
): IssueCommentSyncContext {
  const provider = controlPlaneProviderName(options);
  return {
    ...context,
    controlPlaneProvider: provider,
    actorPrefix: controlPlaneIssueCommentActorPrefix(options),
  };
}

async function reportAgentGitServiceWorkspaceHandoffAttachment(
  options: HarnessServerOptions,
  summary: RunSummary,
  request: WorkspacePullRequestRequest,
  result: PullRequestReporterResult | void,
): Promise<RunSummary> {
  if (controlPlaneProviderName(options) !== "agent-git-service") return summary;
  const baseUrl = options.controlPlaneBaseUrl?.trim();
  const token = options.controlPlaneAdminToken?.trim();
  const summaryUrl = summary.metadata?.summaryUrl;
  const handoffPackageUrl = summaryUrl ? runEvidenceUrl(summaryUrl, "handoff-package") : undefined;
  if (!baseUrl || !token || !summaryUrl || !handoffPackageUrl) return summary;
  const handoffFollowupsUrl = runEvidenceUrl(summaryUrl, "handoff-runs");
  const listIssueWorkspaces = options.agentGitServiceListIssueWorkspaces ?? listAgentGitServiceIssueWorkspaces;
  const createIssueWorkspaceAttachment = options.agentGitServiceCreateIssueWorkspaceAttachment ?? createAgentGitServiceIssueWorkspaceAttachment;

  try {
    const workspaces = await listIssueWorkspaces({
      baseUrl,
      token,
      issue: request.issue,
      limit: 100,
    });
    const workspace = selectAgentGitServiceHandoffWorkspace(workspaces, request.branch);
    if (!workspace) return summary;
    const attachment = await createIssueWorkspaceAttachment({
      baseUrl,
      token,
      issue: request.issue,
      workspaceId: workspace.id,
      name: `Loom handoff package ${summary.runId}`,
      url: handoffPackageUrl,
      contentType: "application/json",
    });
    return recordRunExternalEffect(summary, {
      kind: "agent_git_service_workspace_attachment",
      controlPlaneProvider: "agent-git-service",
      issue: request.issue,
      issueUrl: request.issueUrl,
      branch: request.branch,
      baseBranch: request.baseBranch,
      pullRequestIndex: result?.index,
      pullRequestUrl: result?.url,
      workspaceId: workspace.id,
      workspaceAgentLogin: workspace.agentLogin,
      workspaceBranch: workspace.branch,
      workspaceStatus: workspace.status,
      attachmentId: attachment.id,
      attachmentUrl: attachment.url,
      handoffPackageUrl,
      handoffFollowupsUrl,
      clientId: request.clientId,
    }, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return recordRunExternalEffect(summary, {
      kind: "agent_git_service_workspace_attachment_failed",
      controlPlaneProvider: "agent-git-service",
      issue: request.issue,
      issueUrl: request.issueUrl,
      branch: request.branch,
      baseBranch: request.baseBranch,
      handoffPackageUrl,
      handoffFollowupsUrl,
      error: message,
      clientId: request.clientId,
    }, options);
  }
}

function selectAgentGitServiceHandoffWorkspace(
  workspaces: AgentGitServiceIssueWorkspace[],
  branch: string,
): AgentGitServiceIssueWorkspace | undefined {
  return workspaces.find((workspace) => workspace.branch === branch);
}

async function appendInitialIssueCommentSyncAuditEvent(
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  access: TenantAccess | undefined,
  project: string,
  runId: string,
  issue: string,
  issueUrl: string | undefined,
  result: InitialIssueCommentEventsResult,
  clientId: string | undefined,
  preset: RunPresetName | undefined,
  presetInput: Record<string, unknown> | undefined,
): Promise<void> {
  await appendAuditEvent(tenant, "run_issue_comments_synced", compactObject({
    project,
    runId,
    preset,
    presetInput,
    issue,
    issueUrl,
    initial: true,
    synced: result.events.length,
    skippedDuplicate: result.skipped.duplicate,
    skippedLoom: result.skipped.loom,
    skippedEmpty: result.skipped.empty,
    clientId,
  }), access);
}

async function handleReviewRun(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "review") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const runId = requireSafeName(segments[3], "runId");
  const project = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  const runDir = join(workspaceRoot, tenant, project, ".loom", "runs", runId);

  const body = await readReviewJson(req);
  const decision = reviewDecision(body.decision);
  const note = optionalString(body.note, "note");
  const merge = booleanFlag(body.merge, "merge");
  const contractPatch = projectContractPatchFromReviewBody(body);
  const clientId = optionalClientId(body.clientId);

  const summary = await readRunState(runDir, options);
  if (summary.status === "running") {
    throw badRequest("cannot review a running run.");
  }
  if (summary.status === "queued") {
    throw badRequest("cannot review a queued run.");
  }
  if (!summary.review?.required || summary.review.status !== "pending") {
    throw badRequest("run is not pending human review.");
  }
  if (merge && decision !== "approved") {
    throw badRequest("merge requires an approved decision.");
  }

  const reviewed = await decideRunReview(
    workspaceRoot,
    options,
    appendAuditEvent,
    tenant,
    project,
    runId,
    runDir,
    summary,
    decision,
    note,
    merge,
    contractPatch,
    access,
    clientId,
  );
  writeJson(res, 200, reviewed);
  return true;
}

async function decideRunReview(
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  runId: string,
  runDir: string,
  summary: RunSummary,
  decision: "approved" | "rejected",
  note: string | undefined,
  merge: boolean,
  contractPatch: ProjectContractPatch | undefined,
  access: TenantAccess | undefined,
  clientId: string | undefined,
): Promise<RunSummary> {
  if (decision === "rejected") {
    const review: ReviewGate = compactReview({ required: true, status: "rejected", note, contractPatch });
    const reviewed = await writeReviewedSummary(options, { ...summary, status: "failed", review }, runDir, review, runEventContext(access, clientId));
    await appendAuditEvent(tenant, "review_decided", compactObject({
      project,
      runId,
      decision,
      status: reviewed.status,
      merge: false,
      note,
      contractPatch,
      clientId,
    }), access);
    return reviewed;
  }

  if (merge) {
    if (!summary.metadata?.pullRequestIndex) {
      throw badRequest("merge requires a linked pull request.");
    }
    if (!options.mergeReporter) {
      throw badRequest("merge reporter is not configured.");
    }
  }

  const review: ReviewGate = compactReview({ required: true, status: "approved", note, merged: merge || undefined, contractPatch });
  const status = summary.deployment?.required && summary.deployment.status === "pending" ? "deployment_required" : "passed";
  let reviewed: RunSummary = { ...summary, status, review };
  if (merge && options.mergeReporter) {
    try {
      await options.mergeReporter(reviewed, note);
      reviewed = await recordRunExternalEffect(reviewed, {
        kind: "pull_request_merge",
        issue: reviewed.metadata?.issue,
        issueUrl: reviewed.metadata?.issueUrl,
        pullRequestIndex: reviewed.metadata?.pullRequestIndex,
      }, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorMessage = `merge reporter failed: ${message}`;
      await recordRunError(summary, errorMessage, options);
      throw new Error(errorMessage);
    }
  }
  reviewed = await writeReviewedSummary(options, reviewed, runDir, review, runEventContext(access, clientId));
  await appendAuditEvent(tenant, "review_decided", compactObject({
    project,
    runId,
    decision,
    status: reviewed.status,
    merge,
    note,
    contractPatch,
    clientId,
  }), access);
  if (contractPatch) {
    const projectRoot = join(workspaceRoot, tenant, project);
    const updated = await updateProjectTemplateContract(projectRoot, { tenant, project }, contractPatch);
    if (!updated) throw notFound("project not found");
    await appendAuditEvent(tenant, "project_contract_updated", compactObject({
      project,
      runId,
      source: "review_decided",
      contract: contractPatch,
      clientId,
    }), access);
  }
  return reviewed;
}

async function handleClaimRunReview(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "review-claim") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const runId = requireSafeName(segments[3], "runId");
  const project = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  const runDir = join(workspaceRoot, tenant, project, ".loom", "runs", runId);

  const body = await readReviewClaimJson(req);
  const action = runReviewClaimAction(body.action);
  const clientId = optionalClientId(body.clientId);

  const summary = await readRunState(runDir, options);
  if (summary.status === "running") {
    throw badRequest("cannot claim review for a running run.");
  }
  if (summary.status === "queued") {
    throw badRequest("cannot claim review for a queued run.");
  }
  const review = summary.review;
  if (!review?.required || review.status !== "pending") {
    throw badRequest("run is not pending human review.");
  }

  const updated = await claimRunReview(
    options,
    appendAuditEvent,
    tenant,
    project,
    runId,
    runDir,
    summary,
    review,
    action,
    access,
    clientId,
  );
  writeJson(res, 200, updated);
  return true;
}

async function claimRunReview(
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  runId: string,
  runDir: string,
  summary: RunSummary,
  review: ReviewGate,
  action: RunReviewClaimAction,
  access: TenantAccess | undefined,
  clientId: string | undefined,
): Promise<RunSummary> {
  const previousClaim = review.claim;
  const claim: ReviewClaim | undefined = action === "claim"
    ? compactObject({
      actor: access?.actor,
      role: access?.role,
      clientId,
      claimedAt: new Date().toISOString(),
    })
    : undefined;
  const updatedReview = compactReview({ ...review, claim });
  const event = await appendRunEvent(runDir, "review_claim", compactObject({
    action: action === "claim" ? "claimed" : "released",
    claimedAt: claim?.claimedAt,
    previousClaim,
    ...runEventContext(access, clientId),
  }), options.stateBackend?.events);
  const updated = { ...summary, review: updatedReview, eventCount: event.seq };
  await writeRunSummary(updated, options);
  await writeRunStatus(runDir, updated, options);
  await appendAuditEvent(tenant, "run_review_claimed", compactObject({
    project,
    runId,
    action: action === "claim" ? "claimed" : "released",
    claimedAt: claim?.claimedAt,
    previousClaim,
    clientId,
  }), access);
  return updated;
}

async function handleDeploymentRun(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "deployment") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const runId = requireSafeName(segments[3], "runId");
  const project = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  const runDir = join(workspaceRoot, tenant, project, ".loom", "runs", runId);

  const body = await readDeploymentJson(req);
  const decision = reviewDecision(body.decision);
  const note = optionalString(body.note, "note");
  const clientId = optionalClientId(body.clientId);
  const summary = await readRunState(runDir, options);
  if (summary.status === "running") {
    throw badRequest("cannot deploy a running run.");
  }
  if (summary.status === "queued") {
    throw badRequest("cannot deploy a queued run.");
  }
  if (summary.review?.required && summary.review.status === "pending") {
    throw badRequest("run is still pending human review.");
  }
  if (summary.status !== "deployment_required" || !summary.deployment?.required || summary.deployment.status !== "pending") {
    throw badRequest("run is not pending deployment approval.");
  }

  const deployed = await decideRunDeployment(
    options,
    appendAuditEvent,
    tenant,
    project,
    runId,
    runDir,
    summary,
    decision,
    note,
    access,
    clientId,
  );
  writeJson(res, 200, deployed);
  return true;
}

async function decideRunDeployment(
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  runId: string,
  runDir: string,
  summary: RunSummary,
  decision: "approved" | "rejected",
  note: string | undefined,
  access: TenantAccess | undefined,
  clientId: string | undefined,
): Promise<RunSummary> {
  const deployment: DeploymentGate = compactDeployment({ required: true, status: decision, note });
  const deployed = await writeDeploymentSummary(options, { ...summary, status: decision === "approved" ? "passed" : "failed", deployment }, runDir, deployment, runEventContext(access, clientId));
  await appendAuditEvent(tenant, "deployment_decided", compactObject({
    project,
    runId,
    decision,
    status: deployed.status,
    note,
    clientId,
  }), access);
  return deployed;
}

async function handleGiteaIssueCommentWebhook(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  queuedRuns: QueuedRun[],
  scheduleQueuedRuns: () => void,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  const webhookRoute = issueCommentWebhookRoute(segments, url, options);
  if (!webhookRoute) return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const project = optionalSafeName(url.searchParams.get("project"), "project");
  if (!options.giteaWebhookSecret) {
    throw badRequest(`${webhookRoute.label} webhook secret is not configured.`);
  }

  const raw = await readRawBody(req);
  verifyControlPlaneWebhookSignature(req, raw, options.giteaWebhookSecret, webhookRoute.label);
  const eventName = giteaWebhookEventName(req);
  if (eventName && eventName !== "issue_comment") {
    writeJson(res, 202, { ignored: true, reason: "unsupported event", event: eventName });
    return true;
  }

  const payload = parseWebhookJson(raw);
  const action = stringField(payload, "action");
  if (action === "deleted") {
    writeJson(res, 202, { ignored: true, reason: "deleted comment" });
    return true;
  }
  const parsed = issueCommentWebhookPayload(payload);
  if (!parsed) {
    writeJson(res, 202, { ignored: true, reason: "not an issue comment payload" });
    return true;
  }

  const deliveryId = webhookDeliveryId(req);
  const access: TenantAccess = { actor: webhookRoute.actor, role: "viewer" };
  const controlPlaneIdentity = await issueCommentControlPlaneIdentity(
    workspaceRoot,
    tenant,
    options,
    webhookRoute.provider,
    parsed.comment.author,
    webhookRoute.actorPrefix,
  );
  const syncContext: IssueCommentSyncContext = {
    access,
    deliveryId,
    controlPlaneProvider: webhookRoute.provider,
    actorPrefix: webhookRoute.actorPrefix,
    controlPlaneIdentity,
  };
  const runs = await linkedIssueRuns(workspaceRoot, tenant, parsed.issue, project);
  const linkedVasCases = await linkedIssueVasCases(workspaceRoot, tenant, parsed.issue, project);
  const matchedRuns: Array<{ project: string; runId: string; synced: number; pauseRequested?: number; resumeRequested?: number; resumed?: number; resumeDenied?: number; runReviewRequested?: number; runReviewed?: number; runReviewDenied?: number; runReviewClaimRequested?: number; runReviewClaimed?: number; runReviewClaimReleased?: number; runReviewClaimDenied?: number; deploymentRequested?: number; deployed?: number; deploymentDenied?: number; vasReviewRequested?: number; vasReviewed?: number; vasReviewDenied?: number; vasRunRequested?: number; vasRunStarted?: number; vasRunDenied?: number; vasRunId?: string; vasClaimRequested?: number; vasClaimed?: number; vasClaimReleased?: number; vasClaimDenied?: number; handoffFollowupRequested?: number; handoffFollowupStarted?: number; handoffFollowupDenied?: number; handoffFollowupRunId?: string }> = [];
  const skipped = { duplicate: 0, loom: 0, empty: 0 };
  let synced = 0;
  let pauseRequested = 0;
  let resumeRequested = 0;
  let resumed = 0;
  let resumeDenied = 0;
  let runReviewRequested = 0;
  let runReviewed = 0;
  let runReviewDenied = 0;
  let runReviewClaimRequested = 0;
  let runReviewClaimed = 0;
  let runReviewClaimReleased = 0;
  let runReviewClaimDenied = 0;
  let deploymentRequested = 0;
  let deployed = 0;
  let deploymentDenied = 0;
  let vasReviewRequested = 0;
  let vasReviewed = 0;
  let vasReviewDenied = 0;
  let vasRunRequested = 0;
  let vasRunStarted = 0;
  let vasRunDenied = 0;
  let vasClaimRequested = 0;
  let vasClaimed = 0;
  let vasClaimReleased = 0;
  let vasClaimDenied = 0;
  let handoffFollowupRequested = 0;
  let handoffFollowupStarted = 0;
  let handoffFollowupDenied = 0;
  const startedVasRuns: IssueCommentVasRunResult["startedRuns"] = [];
  const claimedVasCases: IssueCommentVasClaimResult["claimedCases"] = [];
  const startedHandoffFollowups: IssueCommentHandoffFollowupResult["startedRuns"] = [];
  const reviewedRunCommands = new Set<string>();
  const claimedRunReviewCommands = new Set<string>();
  const deployedRunCommands = new Set<string>();
  const startedVasRunCommands = new Set<string>();
  const claimedVasCaseCommands = new Set<string>();
  const startedHandoffFollowupCommands = new Set<string>();
  const linkedVasCaseIds = linkedVasCaseIdsByProject(runs, linkedVasCases);

  for (const run of runs) {
    const result = await syncIssueCommentsIntoRun(options, run.runDir, run.state, parsed.issue, [parsed.comment], syncContext);
    const runPauseRequested = await requestPauseForIssueCommentCommands(options, tenant, run.project, run.runId, run.runDir, run.state, result.events, activeRuns);
    const runResume = await resumeRunsForIssueCommentCommands(
      workspaceRoot,
      options,
      activeRuns,
      activeRunSlots,
      activeWorkspaces,
      scheduleQueuedRuns,
      appendAuditEvent,
      tenant,
      run.project,
      run.runId,
      run.runDir,
      run.state,
      result.events,
    );
    const runVasReview = await reviewVasLiteCasesForIssueCommentCommands(
      workspaceRoot,
      options,
      appendAuditEvent,
      tenant,
      run.project,
      run.runId,
      run.state,
      result.events,
    );
    const runReview = await reviewRunsForIssueCommentCommands(
      workspaceRoot,
      options,
      appendAuditEvent,
      tenant,
      run.project,
      run.runId,
      run.runDir,
      run.state,
      result.events,
      reviewedRunCommands,
    );
    const runReviewClaim = await claimRunReviewsForIssueCommentCommands(
      workspaceRoot,
      options,
      appendAuditEvent,
      tenant,
      run.project,
      run.runId,
      run.runDir,
      run.state,
      result.events,
      claimedRunReviewCommands,
    );
    const runDeployment = await deployRunsForIssueCommentCommands(
      workspaceRoot,
      options,
      appendAuditEvent,
      tenant,
      run.project,
      run.runId,
      run.runDir,
      run.state,
      result.events,
      deployedRunCommands,
    );
    const runVasRun = await startVasLiteReviewRunsForIssueCommentCommands(
      workspaceRoot,
      options,
      activeRuns,
      activeRunSlots,
      activeWorkspaces,
      queuedRuns,
      scheduleQueuedRuns,
      appendAuditEvent,
      tenant,
      run.project,
      run.state,
      result.events,
      linkedVasCaseIds,
      startedVasRunCommands,
    );
    const runVasClaim = await claimVasLiteCasesForIssueCommentCommands(
      workspaceRoot,
      options,
      appendAuditEvent,
      tenant,
      run.project,
      run.state,
      result.events,
      linkedVasCaseIds,
      claimedVasCaseCommands,
    );
    const runHandoffFollowup = await startHandoffFollowupRunsForIssueCommentCommands(
      workspaceRoot,
      options,
      activeRuns,
      activeRunSlots,
      activeWorkspaces,
      activeSessions,
      queuedRuns,
      scheduleQueuedRuns,
      appendAuditEvent,
      tenant,
      run.project,
      run.runId,
      run.runDir,
      run.state,
      result.events,
      startedHandoffFollowupCommands,
    );
    skipped.duplicate += result.skipped.duplicate;
    skipped.loom += result.skipped.loom;
    skipped.empty += result.skipped.empty;
    synced += result.events.length;
    pauseRequested += runPauseRequested;
    resumeRequested += runResume.requested;
    resumed += runResume.resumed;
    resumeDenied += runResume.denied;
    runReviewRequested += runReview.requested;
    runReviewed += runReview.reviewed;
    runReviewDenied += runReview.denied;
    runReviewClaimRequested += runReviewClaim.requested;
    runReviewClaimed += runReviewClaim.claimed;
    runReviewClaimReleased += runReviewClaim.released;
    runReviewClaimDenied += runReviewClaim.denied;
    deploymentRequested += runDeployment.requested;
    deployed += runDeployment.deployed;
    deploymentDenied += runDeployment.denied;
    vasReviewRequested += runVasReview.requested;
    vasReviewed += runVasReview.reviewed;
    vasReviewDenied += runVasReview.denied;
    vasRunRequested += runVasRun.requested;
    vasRunStarted += runVasRun.started;
    vasRunDenied += runVasRun.denied;
    vasClaimRequested += runVasClaim.requested;
    vasClaimed += runVasClaim.claimed;
    vasClaimReleased += runVasClaim.released;
    vasClaimDenied += runVasClaim.denied;
    handoffFollowupRequested += runHandoffFollowup.requested;
    handoffFollowupStarted += runHandoffFollowup.started;
    handoffFollowupDenied += runHandoffFollowup.denied;
    startedVasRuns.push(...runVasRun.startedRuns);
    claimedVasCases.push(...runVasClaim.claimedCases);
    startedHandoffFollowups.push(...runHandoffFollowup.startedRuns);
    matchedRuns.push(compactObject({
      project: run.project,
      runId: run.runId,
      synced: result.events.length,
      pauseRequested: runPauseRequested || undefined,
      resumeRequested: runResume.requested || undefined,
      resumed: runResume.resumed || undefined,
      resumeDenied: runResume.denied || undefined,
      runReviewRequested: runReview.requested || undefined,
      runReviewed: runReview.reviewed || undefined,
      runReviewDenied: runReview.denied || undefined,
      runReviewClaimRequested: runReviewClaim.requested || undefined,
      runReviewClaimed: runReviewClaim.claimed || undefined,
      runReviewClaimReleased: runReviewClaim.released || undefined,
      runReviewClaimDenied: runReviewClaim.denied || undefined,
      deploymentRequested: runDeployment.requested || undefined,
      deployed: runDeployment.deployed || undefined,
      deploymentDenied: runDeployment.denied || undefined,
      vasReviewRequested: runVasReview.requested || undefined,
      vasReviewed: runVasReview.reviewed || undefined,
      vasReviewDenied: runVasReview.denied || undefined,
      vasRunRequested: runVasRun.requested || undefined,
      vasRunStarted: runVasRun.started || undefined,
      vasRunDenied: runVasRun.denied || undefined,
      vasRunId: runVasRun.startedRuns[0]?.runId,
      vasClaimRequested: runVasClaim.requested || undefined,
      vasClaimed: runVasClaim.claimed || undefined,
      vasClaimReleased: runVasClaim.released || undefined,
      vasClaimDenied: runVasClaim.denied || undefined,
      handoffFollowupRequested: runHandoffFollowup.requested || undefined,
      handoffFollowupStarted: runHandoffFollowup.started || undefined,
      handoffFollowupDenied: runHandoffFollowup.denied || undefined,
      handoffFollowupRunId: runHandoffFollowup.startedRuns[0]?.runId,
      sourceCheckpointVersion: runHandoffFollowup.startedRuns[0]?.sourceCheckpointVersion,
    }));
    await appendAuditEvent(tenant, "run_issue_comments_synced", compactObject({
      project: run.project,
      runId: run.runId,
      issue: parsed.issue,
      issueUrl: run.state.metadata?.issueUrl,
      synced: result.events.length,
      pauseRequested: runPauseRequested || undefined,
      resumeRequested: runResume.requested || undefined,
      resumed: runResume.resumed || undefined,
      resumeDenied: runResume.denied || undefined,
      runReviewRequested: runReview.requested || undefined,
      runReviewed: runReview.reviewed || undefined,
      runReviewDenied: runReview.denied || undefined,
      runReviewClaimRequested: runReviewClaim.requested || undefined,
      runReviewClaimed: runReviewClaim.claimed || undefined,
      runReviewClaimReleased: runReviewClaim.released || undefined,
      runReviewClaimDenied: runReviewClaim.denied || undefined,
      deploymentRequested: runDeployment.requested || undefined,
      deployed: runDeployment.deployed || undefined,
      deploymentDenied: runDeployment.denied || undefined,
      vasReviewRequested: runVasReview.requested || undefined,
      vasReviewed: runVasReview.reviewed || undefined,
      vasReviewDenied: runVasReview.denied || undefined,
      vasRunRequested: runVasRun.requested || undefined,
      vasRunStarted: runVasRun.started || undefined,
      vasRunDenied: runVasRun.denied || undefined,
      vasClaimRequested: runVasClaim.requested || undefined,
      vasClaimed: runVasClaim.claimed || undefined,
      vasClaimReleased: runVasClaim.released || undefined,
      vasClaimDenied: runVasClaim.denied || undefined,
      handoffFollowupRequested: runHandoffFollowup.requested || undefined,
      handoffFollowupStarted: runHandoffFollowup.started || undefined,
      handoffFollowupDenied: runHandoffFollowup.denied || undefined,
      handoffFollowupRunId: runHandoffFollowup.startedRuns[0]?.runId,
      sourceCheckpointVersion: runHandoffFollowup.startedRuns[0]?.sourceCheckpointVersion,
      ...issueCommentAuditCommentEvidence(result.events),
      skippedDuplicate: result.skipped.duplicate,
      skippedLoom: result.skipped.loom,
      skippedEmpty: result.skipped.empty,
      deliveryId,
    }), access);
  }

  const directVasRunEvents = issueCommentVasRunCommandEvents(parsed.issue, parsed.comment, syncContext);
  const directVasRunEventData = recordData(directVasRunEvents[0]?.data);
  const directVasClaimEvents = issueCommentVasClaimCommandEvents(parsed.issue, parsed.comment, syncContext);
  const directVasClaimEventData = recordData(directVasClaimEvents[0]?.data);
  const directVasCaseProjects = [...new Set(linkedVasCases.map((entry) => entry.project))];
  for (const currentProject of directVasCaseProjects) {
    const directVasClaim = await claimVasLiteCasesForIssueCommentCommands(
      workspaceRoot,
      options,
      appendAuditEvent,
      tenant,
      currentProject,
      undefined,
      directVasClaimEvents,
      linkedVasCaseIds,
      claimedVasCaseCommands,
    );
    vasClaimRequested += directVasClaim.requested;
    vasClaimed += directVasClaim.claimed;
    vasClaimReleased += directVasClaim.released;
    vasClaimDenied += directVasClaim.denied;
    claimedVasCases.push(...directVasClaim.claimedCases);
    if (directVasClaim.requested || directVasClaim.claimed || directVasClaim.released || directVasClaim.denied) {
      const claimed = directVasClaim.claimedCases[0];
      await appendAuditEvent(tenant, "run_issue_comments_synced", compactObject({
        project: currentProject,
        caseId: claimed?.caseId ?? stringField(directVasClaimEventData, "vasClaimCaseId"),
        issue: parsed.issue,
        synced: 0,
        vasClaimRequested: directVasClaim.requested || undefined,
        vasClaimed: directVasClaim.claimed || undefined,
        vasClaimReleased: directVasClaim.released || undefined,
        vasClaimDenied: directVasClaim.denied || undefined,
        vasClaimAction: stringField(directVasClaimEventData, "vasClaimAction"),
        controlPlaneProvider: stringField(directVasClaimEventData, "controlPlaneProvider"),
        controlPlaneCommentId: stringField(directVasClaimEventData, "controlPlaneCommentId") ?? stringField(directVasClaimEventData, "giteaCommentId"),
        controlPlaneCommentUrl: stringField(directVasClaimEventData, "controlPlaneCommentUrl") ?? stringField(directVasClaimEventData, "giteaCommentUrl"),
        giteaCommentId: stringField(directVasClaimEventData, "giteaCommentId"),
        deliveryId,
      }), access);
    }

    const directVasRun = await startVasLiteReviewRunsForIssueCommentCommands(
      workspaceRoot,
      options,
      activeRuns,
      activeRunSlots,
      activeWorkspaces,
      queuedRuns,
      scheduleQueuedRuns,
      appendAuditEvent,
      tenant,
      currentProject,
      undefined,
      directVasRunEvents,
      linkedVasCaseIds,
      startedVasRunCommands,
    );
    vasRunRequested += directVasRun.requested;
    vasRunStarted += directVasRun.started;
    vasRunDenied += directVasRun.denied;
    startedVasRuns.push(...directVasRun.startedRuns);
    if (directVasRun.requested || directVasRun.started || directVasRun.denied) {
      const started = directVasRun.startedRuns[0];
      await appendAuditEvent(tenant, "run_issue_comments_synced", compactObject({
        project: currentProject,
        runId: started?.runId,
        issue: parsed.issue,
        synced: 0,
        vasRunRequested: directVasRun.requested || undefined,
        vasRunStarted: directVasRun.started || undefined,
        vasRunDenied: directVasRun.denied || undefined,
        vasRunId: started?.runId,
        caseId: started?.caseId,
        controlPlaneProvider: stringField(directVasRunEventData, "controlPlaneProvider"),
        controlPlaneCommentId: stringField(directVasRunEventData, "controlPlaneCommentId") ?? stringField(directVasRunEventData, "giteaCommentId"),
        controlPlaneCommentUrl: stringField(directVasRunEventData, "controlPlaneCommentUrl") ?? stringField(directVasRunEventData, "giteaCommentUrl"),
        giteaCommentId: stringField(directVasRunEventData, "giteaCommentId"),
        deliveryId,
      }), access);
    }
  }

  writeJson(res, synced > 0 || runReviewed > 0 || runReviewClaimed > 0 || runReviewClaimReleased > 0 || deployed > 0 || vasRunStarted > 0 || vasReviewed > 0 || vasClaimed > 0 || vasClaimReleased > 0 || handoffFollowupStarted > 0 || resumed > 0 ? 202 : 200, {
    issue: parsed.issue,
    synced,
    pauseRequested,
    resumeRequested,
    resumed,
    resumeDenied,
    runReviewRequested,
    runReviewed,
    runReviewDenied,
    runReviewClaimRequested,
    runReviewClaimed,
    runReviewClaimReleased,
    runReviewClaimDenied,
    deploymentRequested,
    deployed,
    deploymentDenied,
    vasReviewRequested,
    vasReviewed,
    vasReviewDenied,
    vasRunRequested,
    vasRunStarted,
    vasRunDenied,
    vasClaimRequested,
    vasClaimed,
    vasClaimReleased,
    vasClaimDenied,
    handoffFollowupRequested,
    handoffFollowupStarted,
    handoffFollowupDenied,
    startedVasRuns,
    claimedVasCases,
    startedHandoffFollowups,
    skipped,
    matchedRuns,
  });
  return true;
}

interface IssueCommentWebhookRoute {
  provider: string;
  actor: string;
  actorPrefix: string;
  label: string;
}

function issueCommentWebhookRoute(segments: string[], url: URL, options: HarnessServerOptions): IssueCommentWebhookRoute | undefined {
  if (segments.length !== 5) return undefined;
  if (segments[0] !== "tenants" || segments[2] !== "webhooks" || segments[4] !== "issue-comments") return undefined;
  if (segments[3] === "gitea") {
    return {
      provider: "gitea-forgejo",
      actor: "gitea-webhook",
      actorPrefix: "gitea",
      label: "gitea",
    };
  }
  if (segments[3] !== "control-plane") return undefined;
  const provider = url.searchParams.get("provider")?.trim() || controlPlaneProviderName(options);
  const catalogEntry = controlPlaneProviderCatalogEntry(provider);
  if (!catalogEntry) throw badRequest(`unsupported control-plane webhook provider: ${provider}`);
  return {
    provider,
    actor: `${provider}-webhook`,
    actorPrefix: provider,
    label: "control-plane",
  };
}

async function issueCommentControlPlaneIdentity(
  workspaceRoot: string,
  tenant: string,
  options: HarnessServerOptions,
  provider: string,
  author: string | undefined,
  actorPrefix: string,
): Promise<IssueCommentControlPlaneIdentity> {
  const externalActor = issueCommentActor(author, actorPrefix);
  const rawAuthor = author?.trim() || undefined;
  if (!externalActor) return {};
  const policy = await readTenantPolicy(resolve(workspaceRoot), tenant, options);
  const mapped = policy?.controlPlaneIdentities?.find((identity) =>
    identity.provider === provider &&
    (identity.externalActor === externalActor || (rawAuthor !== undefined && identity.externalActor === rawAuthor))
  );
  if (!mapped) return { externalActor, actor: externalActor };
  return { externalActor, actor: mapped.actor, role: mapped.role };
}

async function handleSyncRunIssueComments(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  queuedRuns: QueuedRun[],
  scheduleQueuedRuns: () => void,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 6) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "issue-comments" || segments[5] !== "sync") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url);
  const runId = requireSafeName(segments[3], "runId");
  const project = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  const runDir = join(workspaceRoot, tenant, project, ".loom", "runs", runId);

  if (!options.issueCommentReader) {
    throw badRequest("issue comment reader is not configured.");
  }

  try {
    const state = await readRunState(runDir, options);
    const issue = state.metadata?.issue;
    if (!issue) throw badRequest("run is not linked to an issue.");
    const body = await readIssueCommentSyncJson(req);
    const clientId = optionalClientId(body.clientId);
    const comments = await options.issueCommentReader(issue, { tenant, project, runId });
    const { events, skipped } = await syncIssueCommentsIntoRun(
      options,
      runDir,
      state,
      issue,
      comments,
      issueCommentSyncContextForOptions(options, { access, clientId }),
    );
    const pauseRequested = await requestPauseForIssueCommentCommands(options, tenant, project, runId, runDir, state, events, activeRuns);
    const resume = await resumeRunsForIssueCommentCommands(
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
      events,
    );
    const vasReview = await reviewVasLiteCasesForIssueCommentCommands(
      workspaceRoot,
      options,
      appendAuditEvent,
      tenant,
      project,
      runId,
      state,
      events,
    );
    const runReview = await reviewRunsForIssueCommentCommands(
      workspaceRoot,
      options,
      appendAuditEvent,
      tenant,
      project,
      runId,
      runDir,
      state,
      events,
    );
    const runReviewClaim = await claimRunReviewsForIssueCommentCommands(
      workspaceRoot,
      options,
      appendAuditEvent,
      tenant,
      project,
      runId,
      runDir,
      state,
      events,
    );
    const deployment = await deployRunsForIssueCommentCommands(
      workspaceRoot,
      options,
      appendAuditEvent,
      tenant,
      project,
      runId,
      runDir,
      state,
      events,
    );
    const vasRun = await startVasLiteReviewRunsForIssueCommentCommands(
      workspaceRoot,
      options,
      activeRuns,
      activeRunSlots,
      activeWorkspaces,
      queuedRuns,
      scheduleQueuedRuns,
      appendAuditEvent,
      tenant,
      project,
      state,
      events,
      linkedVasCaseIdsByProject([{ project, runId, runDir, state }]),
      new Set<string>(),
    );
    const vasClaim = await claimVasLiteCasesForIssueCommentCommands(
      workspaceRoot,
      options,
      appendAuditEvent,
      tenant,
      project,
      state,
      events,
      linkedVasCaseIdsByProject([{ project, runId, runDir, state }]),
      new Set<string>(),
    );
    const handoffFollowup = await startHandoffFollowupRunsForIssueCommentCommands(
      workspaceRoot,
      options,
      activeRuns,
      activeRunSlots,
      activeWorkspaces,
      activeSessions,
      queuedRuns,
      scheduleQueuedRuns,
      appendAuditEvent,
      tenant,
      project,
      runId,
      runDir,
      state,
      events,
      new Set<string>(),
    );

    await appendAuditEvent(tenant, "run_issue_comments_synced", compactObject({
      project,
      runId,
      issue,
      issueUrl: state.metadata?.issueUrl,
      synced: events.length,
      pauseRequested: pauseRequested || undefined,
      resumeRequested: resume.requested || undefined,
      resumed: resume.resumed || undefined,
      resumeDenied: resume.denied || undefined,
      runReviewRequested: runReview.requested || undefined,
      runReviewed: runReview.reviewed || undefined,
      runReviewDenied: runReview.denied || undefined,
      runReviewClaimRequested: runReviewClaim.requested || undefined,
      runReviewClaimed: runReviewClaim.claimed || undefined,
      runReviewClaimReleased: runReviewClaim.released || undefined,
      runReviewClaimDenied: runReviewClaim.denied || undefined,
      deploymentRequested: deployment.requested || undefined,
      deployed: deployment.deployed || undefined,
      deploymentDenied: deployment.denied || undefined,
      vasReviewRequested: vasReview.requested || undefined,
      vasReviewed: vasReview.reviewed || undefined,
      vasReviewDenied: vasReview.denied || undefined,
      vasRunRequested: vasRun.requested || undefined,
      vasRunStarted: vasRun.started || undefined,
      vasRunDenied: vasRun.denied || undefined,
      vasClaimRequested: vasClaim.requested || undefined,
      vasClaimed: vasClaim.claimed || undefined,
      vasClaimReleased: vasClaim.released || undefined,
      vasClaimDenied: vasClaim.denied || undefined,
      handoffFollowupRequested: handoffFollowup.requested || undefined,
      handoffFollowupStarted: handoffFollowup.started || undefined,
      handoffFollowupDenied: handoffFollowup.denied || undefined,
      handoffFollowupRunId: handoffFollowup.startedRuns[0]?.runId,
      sourceCheckpointVersion: handoffFollowup.startedRuns[0]?.sourceCheckpointVersion,
      ...issueCommentAuditCommentEvidence(events),
      skippedDuplicate: skipped.duplicate,
      skippedLoom: skipped.loom,
      skippedEmpty: skipped.empty,
      clientId,
    }), access);
    writeJson(res, events.length ? 201 : 200, {
      issue,
      issueUrl: state.metadata?.issueUrl,
      synced: events.length,
      pauseRequested,
      resumeRequested: resume.requested,
      resumed: resume.resumed,
      resumeDenied: resume.denied,
      runReviewRequested: runReview.requested,
      runReviewed: runReview.reviewed,
      runReviewDenied: runReview.denied,
      runReviewClaimRequested: runReviewClaim.requested,
      runReviewClaimed: runReviewClaim.claimed,
      runReviewClaimReleased: runReviewClaim.released,
      runReviewClaimDenied: runReviewClaim.denied,
      deploymentRequested: deployment.requested,
      deployed: deployment.deployed,
      deploymentDenied: deployment.denied,
      vasReviewRequested: vasReview.requested,
      vasReviewed: vasReview.reviewed,
      vasReviewDenied: vasReview.denied,
      vasRunRequested: vasRun.requested,
      vasRunStarted: vasRun.started,
      vasRunDenied: vasRun.denied,
      vasClaimRequested: vasClaim.requested,
      vasClaimed: vasClaim.claimed,
      vasClaimReleased: vasClaim.released,
      vasClaimDenied: vasClaim.denied,
      handoffFollowupRequested: handoffFollowup.requested,
      handoffFollowupStarted: handoffFollowup.started,
      handoffFollowupDenied: handoffFollowup.denied,
      startedVasRuns: vasRun.startedRuns,
      claimedVasCases: vasClaim.claimedCases,
      startedHandoffFollowups: handoffFollowup.startedRuns,
      skipped,
      events,
    });
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function handleCreateRunHandoffFollowup(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  queuedRuns: QueuedRun[],
  scheduleQueuedRuns: () => void,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "handoff-runs") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const sourceRunId = requireSafeName(segments[3], "runId");
  const body = await readJson(req) as HandoffFollowupRunRequestBody;
  const clientId = optionalClientId(body.clientId);

  try {
    const sourceContext = await runWorkspaceContext(url, workspaceRoot, tenant, sourceRunId, options);
    const project = sourceContext.project;
    const sourceRunDir = join(workspaceRoot, tenant, project, ".loom", "runs", sourceRunId);
    const sourceState = await readRunState(sourceRunDir, options);
    const sourceEvents = await readRunEventsIfPresent(sourceRunDir, options);
    const sourceAuditTrail = runTenantAuditTrail(await readTenantAuditEvents(workspaceRoot, tenant, options.stateBackend?.events), project, sourceRunId);
    const sourceFollowupRuns = await runHandoffFollowupRuns(workspaceRoot, tenant, project, sourceRunId, sourceAuditTrail);
    const sourceCheckpoint = runEvidenceCheckpoint(sourceState, sourceEvents, {
      auditTrail: sourceAuditTrail,
      followupRuns: sourceFollowupRuns,
    });
    const sourceCheckpointVersion = optionalString(body.sourceCheckpointVersion, "sourceCheckpointVersion");
    if (sourceCheckpointVersion && sourceCheckpointVersion !== sourceCheckpoint.version) {
      await appendAuditEvent(tenant, "run_handoff_followup_denied", compactObject({
        project,
        runId: sourceRunId,
        reason: "handoff checkpoint changed",
        expectedCheckpointVersion: sourceCheckpointVersion,
        observedCheckpointVersion: sourceCheckpoint.version,
        sourceStatus: sourceState.status,
        clientId,
      }), access);
      const currentAuditTrail = runTenantAuditTrail(await readTenantAuditEvents(workspaceRoot, tenant, options.stateBackend?.events), project, sourceRunId);
      const currentFollowupRuns = await runHandoffFollowupRuns(workspaceRoot, tenant, project, sourceRunId, currentAuditTrail);
      writeJson(res, 409, {
        error: "handoff checkpoint changed",
        expectedCheckpointVersion: sourceCheckpointVersion,
        observedCheckpointVersion: sourceCheckpoint.version,
        currentCheckpoint: runEvidenceCheckpoint(sourceState, sourceEvents, {
          auditTrail: currentAuditTrail,
          followupRuns: currentFollowupRuns,
        }),
      });
      return true;
    }
    const handoff = runHandoffEvidence(sourceState, sourceEvents, sourceAuditTrail);
    const sourceProjectContract = sourceState.metadata?.projectContract;
    const sourceProjectContractStatus = sourceState.metadata?.projectContractStatus;
    const sourceAllowedTools = await effectiveTenantAllowedTools(options, tenant);
    const sourceChangedFiles = sourceAllowedTools.includes("git.diff")
      ? workspaceDiffChangedFiles(await workspaceDiff(sourceContext, options))
      : [];
    const sourceCommands = await readWorkspaceCommandSummaries(
      runWorkspaceCommandRoot(workspaceRoot, tenant, project, sourceRunId),
      { route: "run", tenant, project, runId: sourceRunId },
    );
    const sourceSessions = await readWorkspaceSessionSummaries(
      runWorkspaceSessionRoot(workspaceRoot, tenant, project, sourceRunId),
      activeSessions,
      { route: "run", tenant, project, runId: sourceRunId },
      options,
    );
    const goal = optionalString(body.goal, "goal") ?? handoffFollowupDefaultGoal(sourceState);
    const note = optionalHandoffFollowupNote(body.note);
    const status = await createAsyncRunFromBody(
      workspaceRoot,
      options,
      activeRuns,
      activeRunSlots,
      activeWorkspaces,
      queuedRuns,
      scheduleQueuedRuns,
      appendAuditEvent,
      compactObject({
        tenant,
        project,
        async: true,
        queue: body.queue === undefined ? true : body.queue,
        preset: body.preset ?? sourceState.metadata?.runPreset,
        presetInput: body.presetInput ?? sourceState.metadata?.runPresetInput,
        goal,
        script: body.script,
        agentCommand: body.agentCommand,
        ...handoffFollowupModelFields(body, sourceState),
        repo: optionalString(body.repo, "repo") ?? sourceContext.repo,
        branch: optionalString(body.branch, "branch") ?? handoff.branch ?? sourceContext.branch,
        baseBranch: optionalString(body.baseBranch, "baseBranch") ?? handoff.baseBranch ?? sourceContext.baseBranch,
        issue: optionalString(body.issue, "issue") ?? handoff.issue ?? sourceContext.issue,
        pullRequest: body.pullRequest,
        reviewRequired: body.reviewRequired,
        deploymentRequired: body.deploymentRequired,
        syncIssueComments: body.syncIssueComments,
        verify: body.verify,
        evaluate: body.evaluate,
        reviewer: body.reviewer,
        skills: body.skills,
        allowedTools: body.allowedTools,
        maxIterations: body.maxIterations,
        clientId: body.clientId,
      }),
      access,
      [
        handoffFollowupInitialRunEvent({
          tenant,
          project,
          sourceRunId,
          sourceState,
          sourceEvents,
          handoff,
          sourceChangedFiles,
          sourceCommands,
          sourceSessions,
          sourceCheckpointVersion: sourceCheckpoint.version,
          sourceProjectContract,
          sourceProjectContractStatus,
          note,
          access,
          clientId,
        }),
      ],
      {
        handoffSourceRunId: sourceRunId,
        handoffSourceProject: project,
        handoffSourceStatus: sourceState.status,
        handoffSourceGoal: sourceState.goal,
        handoffSourceCheckpointVersion: sourceCheckpoint.version,
        handoffSourceProjectContract: sourceProjectContract,
        handoffSourceProjectContractStatus: sourceProjectContractStatus,
        handoffSourceReplayUrl: `/tenants/${tenant}/runs/${sourceRunId}/replay${runProjectQuery(project)}`,
        handoffSourceHandoffPackageUrl: runEvidencePath(tenant, project, sourceRunId, "handoff-package"),
      },
    );
    await appendAuditEvent(tenant, "run_handoff_followup_created", compactObject({
      project,
      runId: sourceRunId,
      followupRunId: status.runId,
      followupStatus: status.status,
      goal,
      sourceStatus: sourceState.status,
      sourceCheckpointVersion: sourceCheckpoint.version,
      sourceProjectContract,
      sourceProjectContractStatus,
      sourceIssue: handoff.issue,
      sourceBranch: handoff.branch,
      sourceBaseBranch: handoff.baseBranch,
      sourcePullRequestUrl: handoff.pullRequestUrl,
      clientId,
    }), access);
    writeJson(res, 202, status);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function handleListRunHandoffFollowups(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "handoff-runs") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const runId = requireSafeName(segments[3], "runId");

  try {
    const context = await runWorkspaceContext(url, workspaceRoot, tenant, runId, options);
    const state = await readRunState(join(workspaceRoot, tenant, context.project, ".loom", "runs", runId), options);
    const auditTrail = runTenantAuditTrail(await readTenantAuditEvents(workspaceRoot, tenant, options.stateBackend?.events), context.project, runId);
    const events = await readRunEventsIfPresent(join(workspaceRoot, tenant, context.project, ".loom", "runs", runId), options);
    const followupRuns = await runHandoffFollowupRuns(workspaceRoot, tenant, context.project, runId, auditTrail);
    writeJson(res, 200, {
      tenant,
      project: context.project,
      runId,
      checkpoint: runEvidenceCheckpoint(state, events, { auditTrail, followupRuns }),
      source: {
        runId,
        project: context.project,
        status: state.status,
        goal: state.goal,
        links: {
          run: `/tenants/${tenant}/runs/${runId}${runProjectQuery(context.project)}`,
          replay: `/tenants/${tenant}/runs/${runId}/replay${runProjectQuery(context.project)}`,
          workbench: `/workbench?${new URLSearchParams({ tenant, project: context.project, runId }).toString()}`,
          handoffPackage: runEvidencePath(tenant, context.project, runId, "handoff-package"),
        },
      },
      followupRuns,
      links: {
        handoffPackage: runEvidencePath(tenant, context.project, runId, "handoff-package"),
      },
    });
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function handleReadRunHandoffPackage(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeSessions: Map<string, ActiveWorkspaceSession>,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "handoff-package") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  await requireTenantTool(options, tenant, "git.diff", "handoff packages require git.diff to be allowed by the server.");
  const runId = requireSafeName(segments[3], "runId");

  try {
    const context = await runWorkspaceContext(url, workspaceRoot, tenant, runId, options);
    const runDir = join(workspaceRoot, tenant, context.project, ".loom", "runs", runId);
    const state = await readRunState(runDir, options);
    const events = await readRunEventsIfPresent(runDir, options);
    const replay = runReplayFromEvents(state, events);
    const diff = await workspaceDiff(context, options);
    const auditTrail = runTenantAuditTrail(await readTenantAuditEvents(workspaceRoot, tenant, options.stateBackend?.events), context.project, runId);
    const followupRuns = await runHandoffFollowupRuns(workspaceRoot, tenant, context.project, runId, auditTrail);
    const body: RunHandoffPackage = {
      tenant,
      project: context.project,
      runId,
      generatedAt: new Date().toISOString(),
      checkpoint: runEvidenceCheckpoint(state, events, { auditTrail, followupRuns }),
      reviewSummary: runReviewSummary(state, replay, diff, tenant, context.project),
      workspace: await workspaceInfo(context, { kind: "run", runId }, options),
      handoff: runHandoffEvidence(state, events, auditTrail),
      gateTrail: runHandoffGateTrail(events),
      messages: runHandoffMessages(events),
      issueCommentSeeds: issueCommentSeedEvidence(auditTrail),
      externalEffects: runExternalEffectEvidence(events),
      followupRuns,
      commands: await readWorkspaceCommandSummaries(
        runWorkspaceCommandRoot(workspaceRoot, tenant, context.project, runId),
        { route: "run", tenant, project: context.project, runId },
      ),
      sessions: await readWorkspaceSessionSummaries(
        runWorkspaceSessionRoot(workspaceRoot, tenant, context.project, runId),
        activeSessions,
        { route: "run", tenant, project: context.project, runId },
        options,
      ),
      auditTrail,
      links: runHandoffLinks(tenant, context.project, runId),
    };
    writeJson(res, 200, body);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

async function handleReadRunReviewSummary(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "runs" || segments[4] !== "review-summary") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  await requireTenantTool(options, tenant, "git.diff", "review summaries require git.diff to be allowed by the server.");
  const runId = requireSafeName(segments[3], "runId");
  const project = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  const runDir = join(workspaceRoot, tenant, project, ".loom", "runs", runId);

  try {
    const state = await readRunState(runDir, options);
    const replay = runReplayFromEvents(state, await readRunEventsIfPresent(runDir, options));
    const diff = await workspaceDiff(await runWorkspaceContext(url, workspaceRoot, tenant, runId, options), options);
    writeJson(res, 200, runReviewSummary(state, replay, diff, tenant, project));
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
}

function projectContractPatchFromReviewBody(body: ReviewRequestBody): ProjectContractPatch | undefined {
  if (body.contractPatch === undefined) return undefined;
  if (typeof body.contractPatch !== "object" || body.contractPatch === null || Array.isArray(body.contractPatch)) {
    throw badRequest("contractPatch must be an object.");
  }
  const patch = projectContractFromBody(body.contractPatch as ProjectContractRequestBody);
  if (!patch) throw badRequest("contractPatch must include objective, constraints, or successCriteria.");
  return patch;
}

function applyProjectContractStatusGate(body: RunRequestBody, status: ProjectContractStatusEvidence | undefined): RunRequestBody {
  if (status?.ok !== false || body.reviewRequired === true) return body;
  return { ...body, reviewRequired: true };
}

async function writeReviewedSummary(options: HarnessServerOptions, summary: RunSummary, runDir: string, review: ReviewGate, context: RunEventContext = {}): Promise<RunSummary> {
  await appendRunEvent(runDir, "review_gate", compactObject({ ...review, ...context }), options.stateBackend?.events);
  const finish = await appendRunEvent(runDir, "finish", compactObject({ status: summary.status, ...context }), options.stateBackend?.events);
  const reviewed = { ...summary, eventCount: finish.seq };
  await writeRunSummary(reviewed, options);
  await writeRunStatus(runDir, reviewed, options);
  return reviewed;
}

async function writeDeploymentSummary(options: HarnessServerOptions, summary: RunSummary, runDir: string, deployment: DeploymentGate, context: RunEventContext = {}): Promise<RunSummary> {
  await appendRunEvent(runDir, "deployment_gate", compactObject({ ...deployment, ...context }), options.stateBackend?.events);
  const finish = await appendRunEvent(runDir, "finish", compactObject({ status: summary.status, ...context }), options.stateBackend?.events);
  const deployed = { ...summary, eventCount: finish.seq };
  await writeRunSummary(deployed, options);
  await writeRunStatus(runDir, deployed, options);
  return deployed;
}

function compactReview(review: ReviewGate): ReviewGate {
  return Object.fromEntries(Object.entries(review).filter(([, value]) => value !== undefined)) as ReviewGate;
}

function compactDeployment(deployment: DeploymentGate): DeploymentGate {
  return Object.fromEntries(Object.entries(deployment).filter(([, value]) => value !== undefined)) as DeploymentGate;
}

function runReviewSummary(
  state: ReadableRunState,
  replay: RunReplay,
  diff: WorkspaceCommandResponse,
  tenant?: string,
  project?: string,
): RunReviewSummary {
  const changedFiles = workspaceDiffChangedFiles(diff);
  return compactObject({
    runId: state.runId,
    goal: state.goal,
    status: state.status,
    metadata: state.metadata,
    projectContract: state.metadata?.projectContract,
    projectContractStatus: state.metadata?.projectContractStatus,
    requester: "requester" in state ? state.requester : undefined,
    brain: runReviewBrainEvidence(state),
    vas: runReviewVasEvidence(state, tenant, project),
    review: "review" in state ? state.review : undefined,
    deployment: "deployment" in state ? state.deployment : undefined,
    startedAt: startedAt(state),
    endedAt: "endedAt" in state ? state.endedAt : undefined,
    eventCount: "eventCount" in state ? state.eventCount : replay.timeline.length,
    verification: "verification" in state ? state.verification : undefined,
    evaluation: "evaluation" in state ? state.evaluation : undefined,
    reviewer: "reviewer" in state ? state.reviewer : undefined,
    modelUsage: "modelUsage" in state ? state.modelUsage : undefined,
    error: "error" in state ? publicRunErrorSummary(state.error) : undefined,
    checkpoint: replay.checkpoint,
    diff,
    changedFiles: changedFiles.length ? changedFiles : undefined,
    timeline: replay.timeline,
  });
}

function runReviewBrainEvidence(state: ReadableRunState): RunReviewBrainEvidence | undefined {
  if (!isRunSummaryState(state)) return undefined;
  const outcome: RunReviewBrainEvidence["outcome"] = state.status === "failed" || state.status === "error" ? "fail" : "pass";
  const failureKind = brainSignalFailureKind(state);
  if (!failureKind && outcome === "pass") return undefined;
  const evidence: RunReviewBrainEvidence = { outcome };
  if (failureKind) {
    evidence.failureKind = failureKind;
    evidence.reviewerFocus = reviewerFocusForFailureKind(failureKind);
  }
  return evidence;
}

function issueCommentSeedEvidence(auditTrail: TenantAuditEvent[]): IssueCommentSeedEvidence[] {
  return auditTrail.flatMap((event) => {
    if (event.type !== "run_issue_comments_synced") return [];
    const data = recordData(event.data);
    return [compactObject({
      runId: stringField(data, "runId"),
      issue: stringField(data, "issue"),
      issueUrl: stringField(data, "issueUrl"),
      initial: booleanField(data, "initial"),
      synced: numberField(data, "synced"),
      skippedDuplicate: numberField(data, "skippedDuplicate"),
      skippedLoom: numberField(data, "skippedLoom"),
      skippedEmpty: numberField(data, "skippedEmpty"),
      handoffFollowupRequested: numberField(data, "handoffFollowupRequested"),
      handoffFollowupStarted: numberField(data, "handoffFollowupStarted"),
      handoffFollowupDenied: numberField(data, "handoffFollowupDenied"),
      handoffFollowupRunId: stringField(data, "handoffFollowupRunId"),
      sourceCheckpointVersion: stringField(data, "sourceCheckpointVersion"),
      controlPlaneProvider: stringField(data, "controlPlaneProvider"),
      controlPlaneCommentId: stringField(data, "controlPlaneCommentId") ?? stringField(data, "giteaCommentId"),
      controlPlaneCommentUrl: stringField(data, "controlPlaneCommentUrl") ?? stringField(data, "giteaCommentUrl"),
      giteaCommentId: stringField(data, "giteaCommentId"),
      giteaCommentUrl: stringField(data, "giteaCommentUrl"),
      actor: event.actor,
      role: event.role,
      clientId: stringField(data, "clientId"),
    })];
  });
}

function runHandoffEvidence(
  state: ReadableRunState,
  events: HarnessEvent[],
  auditTrail: TenantAuditEvent[],
): RunHandoffEvidence {
  const metadata = state.metadata;
  const commitAudit = latestAuditData(auditTrail, "workspace_commit_created");
  const prAudit = latestAuditData(auditTrail, "workspace_pull_request_created");
  const prExternal = latestRunExternalEffect(events, "pull_request");
  return compactObject({
    issue: metadata?.issue ?? stringField(prAudit, "issue") ?? stringField(prExternal, "issue"),
    issueUrl: metadata?.issueUrl ?? stringField(prAudit, "issueUrl") ?? stringField(prExternal, "issueUrl"),
    branch: metadata?.branch ?? stringField(prAudit, "branch") ?? stringField(prExternal, "branch"),
    baseBranch: metadata?.baseBranch ?? stringField(prAudit, "baseBranch") ?? stringField(prExternal, "baseBranch"),
    commit: stringField(commitAudit, "commit") ?? stringField(prAudit, "commit") ?? stringField(prExternal, "commit"),
    pullRequestIndex: metadata?.pullRequestIndex ?? numberField(prAudit, "pullRequestIndex") ?? numberField(prExternal, "pullRequestIndex"),
    pullRequestUrl: metadata?.pullRequestUrl ?? stringField(prAudit, "pullRequestUrl") ?? stringField(prExternal, "pullRequestUrl"),
    reviewRequired: "review" in state ? state.review?.required : undefined,
    deploymentRequired: "deployment" in state ? state.deployment?.required : undefined,
  });
}

function runHandoffGateTrail(events: HarnessEvent[]): RunHandoffGateTrailEntry[] {
  return events.flatMap((event) => {
    if (event.type !== "review_gate" && event.type !== "deployment_gate") return [];
    const data = recordData(event.data);
    const entry: RunHandoffGateTrailEntry = compactObject({
      gate: event.type === "review_gate" ? "review" : "deployment",
      seq: event.seq,
      ts: event.ts,
      source: "run_event",
      status: gateStatusField(data, "status"),
      actor: stringField(data, "actor"),
      role: tenantRoleField(data, "role"),
      clientId: stringField(data, "clientId"),
      note: stringField(data, "note"),
      contractPatch: projectContractPatchField(data, "contractPatch"),
    }) as RunHandoffGateTrailEntry;
    return [entry];
  });
}

function runHandoffMessages(events: HarnessEvent[]): RunHandoffMessageEvidence[] {
  return events.flatMap((event) => {
    if (event.type !== "user_message") return [];
    const data = recordData(event.data);
    const entry: RunHandoffMessageEvidence = compactObject({
      seq: event.seq,
      ts: event.ts,
      kind: stringField(data, "kind") ?? "goal",
      source: stringField(data, "source"),
      content: stringField(data, "content"),
      actor: stringField(data, "actor"),
      role: tenantRoleField(data, "role"),
      clientId: stringField(data, "clientId"),
      pauseRequested: booleanField(data, "pauseRequested"),
      resumeRequested: booleanField(data, "resumeRequested"),
      runReviewRequested: booleanField(data, "runReviewRequested"),
      runReviewDecision: stringField(data, "runReviewDecision"),
      runReviewContractPatch: projectContractPatchField(data, "runReviewContractPatch"),
      runReviewClaimRequested: booleanField(data, "runReviewClaimRequested"),
      runReviewClaimAction: stringField(data, "runReviewClaimAction"),
      deploymentRequested: booleanField(data, "deploymentRequested"),
      deploymentDecision: stringField(data, "deploymentDecision"),
      vasReviewRequested: booleanField(data, "vasReviewRequested"),
      vasReviewDecision: stringField(data, "vasReviewDecision"),
      vasRunRequested: booleanField(data, "vasRunRequested"),
      vasRunCaseId: stringField(data, "vasRunCaseId"),
      vasClaimRequested: booleanField(data, "vasClaimRequested"),
      vasClaimAction: stringField(data, "vasClaimAction"),
      vasClaimCaseId: stringField(data, "vasClaimCaseId"),
      issue: stringField(data, "issue"),
      issueUrl: stringField(data, "issueUrl"),
      controlPlaneProvider: stringField(data, "controlPlaneProvider"),
      controlPlaneCommentId: stringField(data, "controlPlaneCommentId"),
      controlPlaneCommentUrl: stringField(data, "controlPlaneCommentUrl"),
      controlPlaneExternalActor: stringField(data, "controlPlaneExternalActor"),
      giteaCommentId: stringField(data, "giteaCommentId"),
      giteaCommentUrl: stringField(data, "giteaCommentUrl"),
      giteaCreatedAt: stringField(data, "giteaCreatedAt"),
      giteaUpdatedAt: stringField(data, "giteaUpdatedAt"),
      syncedByActor: stringField(data, "syncedByActor"),
      syncedByRole: tenantRoleField(data, "syncedByRole"),
      deliveryId: stringField(data, "deliveryId"),
      syncedIntoRun: booleanField(data, "syncedIntoRun"),
      sourceRunId: stringField(data, "sourceRunId"),
      sourceProject: stringField(data, "sourceProject"),
      sourceStatus: stringField(data, "sourceStatus"),
      sourceGoal: stringField(data, "sourceGoal"),
      sourceCheckpointVersion: stringField(data, "sourceCheckpointVersion"),
      sourceProjectContract: projectContractEvidenceField(data, "sourceProjectContract"),
      sourceProjectContractStatus: projectContractStatusEvidenceField(data, "sourceProjectContractStatus"),
      sourceIssue: stringField(data, "sourceIssue"),
      sourceIssueUrl: stringField(data, "sourceIssueUrl"),
      sourceBranch: stringField(data, "sourceBranch"),
      sourceBaseBranch: stringField(data, "sourceBaseBranch"),
      sourceCommit: stringField(data, "sourceCommit"),
      sourcePullRequestUrl: stringField(data, "sourcePullRequestUrl"),
      sourceReviewStatus: stringField(data, "sourceReviewStatus"),
      sourceDeploymentStatus: stringField(data, "sourceDeploymentStatus"),
      sourceChangedFileCount: numberField(data, "sourceChangedFileCount"),
      sourceChangedFiles: runChangedFileHintsField(data, "sourceChangedFiles"),
      sourceCommandCount: numberField(data, "sourceCommandCount"),
      sourceCommands: runHandoffSourceCommandsField(data, "sourceCommands"),
      sourceSessionCount: numberField(data, "sourceSessionCount"),
      sourceSessions: runHandoffSourceSessionsField(data, "sourceSessions"),
      sourceMessageCount: numberField(data, "sourceMessageCount"),
      sourceGateCount: numberField(data, "sourceGateCount"),
      sourceExternalEffectCount: numberField(data, "sourceExternalEffectCount"),
      sourceReplayUrl: stringField(data, "sourceReplayUrl"),
      sourceHandoffPackageUrl: stringField(data, "sourceHandoffPackageUrl"),
    }) as RunHandoffMessageEvidence;
    return [entry];
  });
}

function issueCommentAuditCommentEvidence(events: HarnessEvent[]): Record<string, unknown> {
  if (events.length !== 1) return {};
  const data = recordData(events[0]?.data);
  if (!isControlPlaneIssueComment(data)) return {};
  return compactObject({
    controlPlaneProvider: stringField(data, "controlPlaneProvider"),
    controlPlaneCommentId: stringField(data, "controlPlaneCommentId") ?? stringField(data, "giteaCommentId"),
    controlPlaneCommentUrl: stringField(data, "controlPlaneCommentUrl") ?? stringField(data, "giteaCommentUrl"),
    controlPlaneExternalActor: stringField(data, "controlPlaneExternalActor"),
    giteaCommentId: stringField(data, "giteaCommentId"),
    giteaCommentUrl: stringField(data, "giteaCommentUrl"),
  });
}

export function isControlPlaneIssueComment(data: unknown): boolean {
  const record = recordData(data);
  return record.kind === "issue_comment" && (record.source === "gitea" || record.source === "control_plane");
}

export function issueCommentCommandId(data: unknown, eventSeq: number): string {
  const record = recordData(data);
  return stringField(record, "controlPlaneCommentId") ?? stringField(record, "giteaCommentId") ?? String(eventSeq);
}

async function runHandoffFollowupRuns(
  workspaceRoot: string,
  tenant: string,
  project: string,
  runId: string,
  auditTrail: TenantAuditEvent[],
): Promise<RunHandoffFollowupEvidence[]> {
  const followups = await Promise.all(auditTrail.flatMap((event) => {
    if (event.type !== "run_handoff_followup_created") return [];
    const data = recordData(event.data);
    if (data.project !== project || data.runId !== runId) return [];
    const followupRunId = stringField(data, "followupRunId");
    if (!followupRunId) return [];
    return [runHandoffFollowupEvidence(workspaceRoot, tenant, project, followupRunId, event)];
  }));
  return followups.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function runHandoffFollowupEvidence(
  workspaceRoot: string,
  tenant: string,
  project: string,
  followupRunId: string,
  event: TenantAuditEvent,
): Promise<RunHandoffFollowupEvidence> {
  const data = recordData(event.data);
  let state: ReadableRunState | undefined;
  try {
    state = await readRunState(join(workspaceRoot, tenant, project, ".loom", "runs", followupRunId));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return compactObject({
    runId: followupRunId,
    project,
    status: state?.status ?? stringField(data, "followupStatus"),
    goal: state?.goal ?? stringField(data, "goal"),
    createdAt: event.ts,
    actor: event.actor,
    role: event.role,
    clientId: stringField(data, "clientId"),
    controlPlaneProvider: stringField(data, "controlPlaneProvider"),
    controlPlaneCommentId: stringField(data, "controlPlaneCommentId") ?? stringField(data, "giteaCommentId"),
    controlPlaneCommentUrl: stringField(data, "controlPlaneCommentUrl") ?? stringField(data, "giteaCommentUrl"),
    giteaCommentId: stringField(data, "giteaCommentId"),
    giteaCommentUrl: stringField(data, "giteaCommentUrl"),
    sourceCheckpointVersion: state?.metadata?.handoffSourceCheckpointVersion ?? stringField(data, "sourceCheckpointVersion"),
    sourceProjectContractStatus: state?.metadata?.handoffSourceProjectContractStatus ?? projectContractStatusEvidenceField(data, "sourceProjectContractStatus"),
    links: {
      run: `/tenants/${tenant}/runs/${followupRunId}${runProjectQuery(project)}`,
      workbench: `/workbench?${new URLSearchParams({ tenant, project, runId: followupRunId }).toString()}`,
      handoffPackage: runEvidencePath(tenant, project, followupRunId, "handoff-package"),
    },
  }) as RunHandoffFollowupEvidence;
}

function gateStatusField(data: Record<string, unknown>, key: string): RunHandoffGateTrailEntry["status"] | undefined {
  const value = data[key];
  return value === "pending" || value === "approved" || value === "rejected" ? value : undefined;
}

function runHandoffLinks(tenant: string, project: string, runId: string): RunHandoffLinks {
  const query = runProjectQuery(project);
  const workbench = new URLSearchParams({ tenant, project, runId });
  return {
    run: `/tenants/${tenant}/runs/${runId}${query}`,
    events: `/tenants/${tenant}/runs/${runId}/events${query}`,
    replay: `/tenants/${tenant}/runs/${runId}/replay${query}`,
    reviewSummary: runEvidencePath(tenant, project, runId, "review-summary"),
    followupRuns: `/tenants/${tenant}/runs/${runId}/handoff-runs${query}`,
    workspace: `/tenants/${tenant}/runs/${runId}/workspace${query}`,
    diff: `/tenants/${tenant}/runs/${runId}/diff${query}`,
    dashboard: `/?${workbench.toString()}`,
    workbench: `/workbench?${workbench.toString()}`,
  };
}

function reviewClaimField(data: Record<string, unknown>, key: string): ReviewClaim | undefined {
  const value = recordData(data[key]);
  const claim = compactObject({
    actor: stringField(value, "actor"),
    role: stringField(value, "role"),
    clientId: stringField(value, "clientId"),
    claimedAt: stringField(value, "claimedAt"),
  });
  return Object.keys(claim).length ? claim as ReviewClaim : undefined;
}

function runHandoffSourceCommandsField(data: Record<string, unknown>, key: string): RunHandoffSourceCommandEvidence[] | undefined {
  const value = data[key];
  if (!Array.isArray(value)) return undefined;
  const commands = value.flatMap((item) => {
    const record = recordData(item);
    const commandId = stringField(record, "commandId");
    const command = stringField(record, "command");
    const exitCode = numberField(record, "exitCode");
    if (!commandId || !command || exitCode === undefined) return [];
    return [compactObject({
      commandId,
      command,
      exitCode,
      actor: stringField(record, "actor"),
      role: tenantRoleField(record, "role"),
      clientId: stringField(record, "clientId"),
    })];
  });
  return commands.length ? commands : undefined;
}

function runHandoffSourceSessionsField(data: Record<string, unknown>, key: string): RunHandoffSourceSessionEvidence[] | undefined {
  const value = data[key];
  if (!Array.isArray(value)) return undefined;
  const sessions = value.flatMap((item) => {
    const record = recordData(item);
    const sessionId = stringField(record, "sessionId");
    const command = stringField(record, "command");
    const status = runHandoffSourceSessionStatusField(record, "status");
    if (!sessionId || !command || !status) return [];
    return [compactObject({
      sessionId,
      command,
      status,
      exitCode: numberField(record, "exitCode"),
      actor: stringField(record, "actor"),
      role: tenantRoleField(record, "role"),
      clientId: stringField(record, "clientId"),
    })];
  });
  return sessions.length ? sessions : undefined;
}

function runHandoffSourceSessionStatusField(data: Record<string, unknown>, key: string): WorkspaceSessionSummary["status"] | undefined {
  const value = data[key];
  return value === "running" || value === "exited" || value === "orphaned" ? value : undefined;
}

function optionalHandoffFollowupNote(value: unknown): string | undefined {
  const note = optionalString(value, "note")?.trim();
  if (note === undefined) return undefined;
  if (note.length > 4000 || /\0/.test(note)) {
    throw badRequest("note must be a string at most 4000 characters.");
  }
  return note;
}

async function initialIssueCommentEventsForRun(
  options: HarnessServerOptions,
  syncIssueComments: boolean,
  issue: string | undefined,
  issueUrl: string | undefined,
  context: IssueCommentSyncContext,
  readerContext: IssueCommentReaderContext,
): Promise<InitialIssueCommentEventsResult> {
  const skipped: IssueCommentSkippedCounts = { duplicate: 0, loom: 0, empty: 0 };
  if (!syncIssueComments) return { events: [], skipped };
  if (!issue) throw badRequest("syncIssueComments requires issue.");
  if (!options.issueCommentReader) {
    throw badRequest("syncIssueComments requires an issue comment reader.");
  }
  const seenIds = new Set<string>();
  const events: InitialRunEvent[] = [];
  for (const comment of await options.issueCommentReader(issue, readerContext)) {
    const prepared = issueCommentUserMessage(issue, issueUrl, comment, context);
    if (prepared.skipped === "empty") {
      skipped.empty += 1;
      continue;
    }
    if (prepared.skipped === "loom") {
      skipped.loom += 1;
      continue;
    }
    if (seenIds.has(prepared.id)) {
      skipped.duplicate += 1;
      continue;
    }
    if (!prepared.data) continue;
    seenIds.add(prepared.id);
    events.push({ type: "user_message", data: prepared.data });
  }
  return { events, skipped };
}

async function syncIssueCommentsIntoRun(
  options: HarnessServerOptions,
  runDir: string,
  state: ReadableRunState,
  issue: string,
  comments: GiteaIssueComment[],
  context: IssueCommentSyncContext,
): Promise<IssueCommentSyncResult> {
  const existingEvents = await readRunEventsIfPresent(runDir, options);
  const syncedIds = syncedIssueCommentIds(existingEvents, issue);
  const events: HarnessEvent[] = [];
  let pauseRequested = 0;
  let resumeRequested = 0;
  let runReviewRequested = 0;
  let runReviewClaimRequested = 0;
  let deploymentRequested = 0;
  let vasReviewRequested = 0;
  let vasRunRequested = 0;
  let vasClaimRequested = 0;
  let handoffFollowupRequested = 0;
  const skipped = { duplicate: 0, loom: 0, empty: 0 };

  for (const comment of comments) {
    const prepared = issueCommentUserMessage(issue, state.metadata?.issueUrl, comment, context);
    if (prepared.skipped === "empty") {
      skipped.empty += 1;
      continue;
    }
    if (prepared.skipped === "loom") {
      skipped.loom += 1;
      continue;
    }
    if (syncedIds.has(prepared.id)) {
      skipped.duplicate += 1;
      continue;
    }
    if (!prepared.data) continue;
    if (prepared.pauseRequested) pauseRequested += 1;
    if (prepared.resumeRequested) resumeRequested += 1;
    if (prepared.runReviewRequested) runReviewRequested += 1;
    if (prepared.runReviewClaimRequested) runReviewClaimRequested += 1;
    if (prepared.deploymentRequested) deploymentRequested += 1;
    if (prepared.vasReviewRequested) vasReviewRequested += 1;
    if (prepared.vasRunRequested) vasRunRequested += 1;
    if (prepared.vasClaimRequested) vasClaimRequested += 1;
    if (prepared.handoffFollowupRequested) handoffFollowupRequested += 1;
    const event = await appendRunEvent(runDir, "user_message", prepared.data, options.stateBackend?.events);
    syncedIds.add(prepared.id);
    events.push(event);
  }

  if (events.length && state.status !== "running" && state.status !== "queued") {
    const observed: RunSummary = { ...state, eventCount: events.at(-1)?.seq ?? ("eventCount" in state ? state.eventCount : existingEvents.length) };
    await writeRunSummary(observed, options);
    await writeRunStatus(runDir, observed, options);
  }

  return { events, pauseRequested, resumeRequested, runReviewRequested, runReviewClaimRequested, deploymentRequested, vasReviewRequested, vasRunRequested, vasClaimRequested, handoffFollowupRequested, skipped };
}

function issueCommentUserMessage(
  issue: string,
  issueUrl: string | undefined,
  comment: GiteaIssueComment,
  context: IssueCommentSyncContext,
): PreparedIssueCommentUserMessage {
  const id = issueCommentId(comment);
  const provider = context.controlPlaneProvider ?? "gitea-forgejo";
  const isGiteaProvider = provider === "gitea-forgejo";
  const actor = issueCommentIdentityActor(comment, context);
  const content = issueCommentContent(comment.body);
  if (!content) return { id, skipped: "empty" };
  if (isLoomGeneratedIssueComment(content)) return { id, skipped: "loom" };
  const pauseReason = issueCommentPauseReason(content);
  const resumeReason = issueCommentResumeReason(content);
  const runReview = issueCommentRunReviewCommand(content);
  const runReviewClaim = issueCommentRunReviewClaimCommand(content);
  const deployment = issueCommentDeploymentCommand(content);
  const vasReview = issueCommentVasReviewCommand(content);
  const vasRun = issueCommentVasRunCommand(content);
  const vasClaim = issueCommentVasClaimCommand(content);
  const handoffFollowup = issueCommentHandoffFollowupCommand(content);
  return {
    id,
    pauseRequested: Boolean(pauseReason),
    resumeRequested: Boolean(resumeReason),
    runReviewRequested: Boolean(runReview),
    runReviewClaimRequested: Boolean(runReviewClaim),
    deploymentRequested: Boolean(deployment),
    vasReviewRequested: Boolean(vasReview),
    vasRunRequested: Boolean(vasRun),
    vasClaimRequested: Boolean(vasClaim),
    handoffFollowupRequested: Boolean(handoffFollowup),
    data: compactObject({
      kind: "issue_comment",
      source: "control_plane",
      controlPlaneProvider: provider,
      content,
      pauseRequested: pauseReason ? true : undefined,
      pauseReason,
      resumeRequested: resumeReason ? true : undefined,
      resumeReason,
      runReviewRequested: runReview ? true : undefined,
      runReviewDecision: runReview?.decision,
      runReviewNote: runReview?.note,
      runReviewContractPatch: runReview?.contractPatch,
      runReviewClaimRequested: runReviewClaim ? true : undefined,
      runReviewClaimAction: runReviewClaim?.action,
      runReviewClaimNote: runReviewClaim?.note,
      deploymentRequested: deployment ? true : undefined,
      deploymentDecision: deployment?.decision,
      deploymentNote: deployment?.note,
      vasReviewRequested: vasReview ? true : undefined,
      vasReviewDecision: vasReview?.decision,
      vasReviewNote: vasReview?.note,
      vasRunRequested: vasRun ? true : undefined,
      vasRunCaseId: vasRun?.caseId,
      vasRunNote: vasRun?.note,
      vasClaimRequested: vasClaim ? true : undefined,
      vasClaimAction: vasClaim?.action,
      vasClaimCaseId: vasClaim?.caseId,
      vasClaimNote: vasClaim?.note,
      handoffFollowupRequested: handoffFollowup ? true : undefined,
      handoffFollowupNote: handoffFollowup?.note,
      issue,
      issueUrl,
      controlPlaneCommentId: id,
      controlPlaneCommentUrl: comment.url,
      giteaCommentId: isGiteaProvider ? id : undefined,
      giteaCommentUrl: isGiteaProvider ? comment.url : undefined,
      giteaCreatedAt: isGiteaProvider ? comment.createdAt : undefined,
      giteaUpdatedAt: isGiteaProvider ? comment.updatedAt : undefined,
      actor: actor.actor,
      role: actor.role,
      controlPlaneExternalActor: actor.externalActor !== actor.actor ? actor.externalActor : undefined,
      syncedByActor: context.access?.actor,
      syncedByRole: context.access?.role,
      clientId: context.clientId,
      deliveryId: context.deliveryId,
    }),
  };
}

function issueCommentVasRunCommandEvents(issue: string, comment: GiteaIssueComment, context: IssueCommentSyncContext): HarnessEvent[] {
  const content = issueCommentContent(comment.body);
  if (!content || isLoomGeneratedIssueComment(content)) return [];
  const vasRun = issueCommentVasRunCommand(content);
  if (!vasRun) return [];
  const provider = context.controlPlaneProvider ?? "gitea-forgejo";
  const isGiteaProvider = provider === "gitea-forgejo";
  const actor = issueCommentIdentityActor(comment, context);
  return [{
    runId: "issue-comment",
    seq: 0,
    ts: new Date().toISOString(),
    type: "user_message",
    data: compactObject({
      kind: "issue_comment",
      source: "control_plane",
      controlPlaneProvider: provider,
      content,
      vasRunRequested: true,
      vasRunCaseId: vasRun.caseId,
      vasRunNote: vasRun.note,
      issue,
      controlPlaneCommentId: issueCommentId(comment),
      controlPlaneCommentUrl: comment.url,
      giteaCommentId: isGiteaProvider ? issueCommentId(comment) : undefined,
      giteaCommentUrl: isGiteaProvider ? comment.url : undefined,
      giteaCreatedAt: isGiteaProvider ? comment.createdAt : undefined,
      giteaUpdatedAt: isGiteaProvider ? comment.updatedAt : undefined,
      actor: actor.actor,
      role: actor.role,
      controlPlaneExternalActor: actor.externalActor !== actor.actor ? actor.externalActor : undefined,
      deliveryId: context.deliveryId,
    }),
  }];
}

function issueCommentVasClaimCommandEvents(issue: string, comment: GiteaIssueComment, context: IssueCommentSyncContext): HarnessEvent[] {
  const content = issueCommentContent(comment.body);
  if (!content || isLoomGeneratedIssueComment(content)) return [];
  const vasClaim = issueCommentVasClaimCommand(content);
  if (!vasClaim) return [];
  const provider = context.controlPlaneProvider ?? "gitea-forgejo";
  const isGiteaProvider = provider === "gitea-forgejo";
  const actor = issueCommentIdentityActor(comment, context);
  return [{
    runId: "issue-comment",
    seq: 0,
    ts: new Date().toISOString(),
    type: "user_message",
    data: compactObject({
      kind: "issue_comment",
      source: "control_plane",
      controlPlaneProvider: provider,
      content,
      vasClaimRequested: true,
      vasClaimAction: vasClaim.action,
      vasClaimCaseId: vasClaim.caseId,
      vasClaimNote: vasClaim.note,
      issue,
      controlPlaneCommentId: issueCommentId(comment),
      controlPlaneCommentUrl: comment.url,
      giteaCommentId: isGiteaProvider ? issueCommentId(comment) : undefined,
      giteaCommentUrl: isGiteaProvider ? comment.url : undefined,
      giteaCreatedAt: isGiteaProvider ? comment.createdAt : undefined,
      giteaUpdatedAt: isGiteaProvider ? comment.updatedAt : undefined,
      actor: actor.actor,
      role: actor.role,
      controlPlaneExternalActor: actor.externalActor !== actor.actor ? actor.externalActor : undefined,
      deliveryId: context.deliveryId,
    }),
  }];
}

function issueCommentIdentityActor(
  comment: Pick<GiteaIssueComment, "author">,
  context: IssueCommentSyncContext,
): IssueCommentControlPlaneIdentity {
  const externalActor = issueCommentActor(comment.author, context.actorPrefix);
  const identity = context.controlPlaneIdentity;
  if (identity && identity.externalActor === externalActor) return identity;
  if (!externalActor) return {};
  return { externalActor, actor: externalActor };
}

function handoffFollowupInitialRunEvent(input: {
  tenant: string;
  project: string;
  sourceRunId: string;
  sourceState: ReadableRunState;
  sourceEvents: HarnessEvent[];
  handoff: RunHandoffEvidence;
  sourceChangedFiles: RunChangedFileHint[];
  sourceCommands: WorkspaceCommandSummary[];
  sourceSessions: WorkspaceSessionSummary[];
  sourceCheckpointVersion?: string;
  sourceProjectContract?: ProjectContractEvidence;
  sourceProjectContractStatus?: ProjectContractStatusEvidence;
  note?: string;
  access?: TenantAccess;
  clientId?: string;
  controlPlaneProvider?: string;
  controlPlaneCommentId?: string;
  controlPlaneCommentUrl?: string;
  giteaCommentId?: string;
  giteaCommentUrl?: string;
}): InitialRunEvent {
  const sourceChangedFiles = runHandoffSourceChangedFiles(input.sourceChangedFiles);
  const sourceCommands = runHandoffSourceCommands(input.sourceCommands);
  const sourceSessions = runHandoffSourceSessions(input.sourceSessions);
  return {
    type: "user_message",
    data: compactObject({
      kind: "handoff_followup",
      source: "handoff_package",
      content: input.note ?? `Continue from handoff package for run ${input.sourceRunId}.`,
      sourceRunId: input.sourceRunId,
      sourceProject: input.project,
      sourceStatus: input.sourceState.status,
      sourceGoal: input.sourceState.goal,
      sourceCheckpointVersion: input.sourceCheckpointVersion,
      sourceProjectContract: input.sourceProjectContract,
      sourceProjectContractStatus: input.sourceProjectContractStatus,
      sourceIssue: input.handoff.issue,
      sourceIssueUrl: input.handoff.issueUrl,
      sourceBranch: input.handoff.branch,
      sourceBaseBranch: input.handoff.baseBranch,
      sourceCommit: input.handoff.commit,
      sourcePullRequestUrl: input.handoff.pullRequestUrl,
      sourceReviewStatus: "review" in input.sourceState ? input.sourceState.review?.status : undefined,
      sourceDeploymentStatus: "deployment" in input.sourceState ? input.sourceState.deployment?.status : undefined,
      sourceChangedFileCount: input.sourceChangedFiles.length,
      sourceChangedFiles: sourceChangedFiles.length ? sourceChangedFiles : undefined,
      sourceCommandCount: input.sourceCommands.length,
      sourceCommands: sourceCommands.length ? sourceCommands : undefined,
      sourceSessionCount: input.sourceSessions.length,
      sourceSessions: sourceSessions.length ? sourceSessions : undefined,
      sourceMessageCount: runHandoffMessages(input.sourceEvents).length,
      sourceGateCount: runHandoffGateTrail(input.sourceEvents).length,
      sourceExternalEffectCount: runExternalEffectEvidence(input.sourceEvents).length,
      sourceReplayUrl: `/tenants/${input.tenant}/runs/${input.sourceRunId}/replay${runProjectQuery(input.project)}`,
      sourceHandoffPackageUrl: runEvidencePath(input.tenant, input.project, input.sourceRunId, "handoff-package"),
      actor: input.access?.actor,
      role: input.access?.role,
      clientId: input.clientId,
      controlPlaneProvider: input.controlPlaneProvider,
      controlPlaneCommentId: input.controlPlaneCommentId,
      controlPlaneCommentUrl: input.controlPlaneCommentUrl,
      giteaCommentId: input.giteaCommentId,
      giteaCommentUrl: input.giteaCommentUrl,
    }),
  };
}

function runHandoffSourceChangedFiles(files: RunChangedFileHint[]): RunChangedFileHint[] {
  return files.slice(0, HANDOFF_FOLLOWUP_CONTEXT_LIMIT).map((file) => compactObject({
    path: file.path,
    status: file.status,
    previousPath: file.previousPath,
  }));
}

function runHandoffSourceCommands(commands: WorkspaceCommandSummary[]): RunHandoffSourceCommandEvidence[] {
  return commands.slice(0, HANDOFF_FOLLOWUP_CONTEXT_LIMIT).map((command) => compactObject({
    commandId: command.commandId,
    command: command.command,
    exitCode: command.exitCode,
    actor: command.actor,
    role: command.role,
    clientId: command.clientId,
  }));
}

function runHandoffSourceSessions(sessions: WorkspaceSessionSummary[]): RunHandoffSourceSessionEvidence[] {
  return sessions.slice(0, HANDOFF_FOLLOWUP_CONTEXT_LIMIT).map((session) => compactObject({
    sessionId: session.sessionId,
    command: session.command,
    status: session.status,
    exitCode: session.exitCode,
    actor: session.actor,
    role: session.role,
    clientId: session.clientId,
  }));
}

function handoffFollowupModelFields(
  body: Pick<HandoffFollowupRunRequestBody, "model" | "modelProtocol">,
  sourceState: ReadableRunState,
): Pick<RunRequestBody, "model" | "modelProtocol"> {
  return compactObject({
    model: body.model ?? sourceState.metadata?.model,
    modelProtocol: body.modelProtocol ?? sourceState.metadata?.modelProtocol,
  });
}

function handoffFollowupDefaultGoal(sourceState: ReadableRunState): string {
  return `Continue from handoff package for run ${sourceState.runId}: ${replayText(sourceState.goal) ?? sourceState.goal}`;
}

function issueCommentInitialRunEvent(event: HarnessEvent): InitialRunEvent {
  return {
    type: "user_message",
    data: compactObject({
      ...recordData(event.data),
      syncedIntoRun: true,
    }),
  };
}

async function requestPauseForIssueCommentCommands(
  options: HarnessServerOptions,
  tenant: string,
  project: string,
  runId: string,
  runDir: string,
  state: ReadableRunState,
  events: HarnessEvent[],
  activeRuns: Map<string, ActiveRun>,
): Promise<number> {
  if (state.status !== "running") return 0;
  const active = activeRuns.has(activeRunKey(tenant, project, runId));
  if (!active && !await persistedRunningRunHasActiveAdmissionClaim(options, runDir, state)) return 0;
  let requested = 0;
  for (const event of events) {
    const data = recordData(event.data);
    if (!isControlPlaneIssueComment(data) || booleanField(data, "pauseRequested") !== true) continue;
    await writeRunPauseRequest(runDir, {
      reason: stringField(data, "pauseReason") ?? "issue comment requested pause",
      actor: stringField(data, "actor"),
      role: "viewer",
      eventSeq: event.seq,
    }, options);
    requested += 1;
  }
  return requested;
}

async function resumeRunsForIssueCommentCommands(
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
  events: HarnessEvent[],
): Promise<IssueCommentResumeResult> {
  let currentState = state;
  const result: IssueCommentResumeResult = { requested: 0, resumed: 0, denied: 0 };
  for (const event of events) {
    const data = recordData(event.data);
    if (!isControlPlaneIssueComment(data) || booleanField(data, "resumeRequested") !== true) continue;
    result.requested += 1;
    const access = await issueCommentActorAccess(workspaceRoot, tenant, options, stringField(data, "actor"));
    if (tenantRoleRank(access.role) < tenantRoleRank("developer")) {
      result.denied += 1;
      continue;
    }
    if (currentState.status !== "paused") continue;
    await resumePausedRun(
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
      currentState,
      access,
      undefined,
    );
    result.resumed += 1;
    currentState = await readRunState(runDir);
  }
  return result;
}

async function reviewRunsForIssueCommentCommands(
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  runId: string,
  runDir: string,
  state: ReadableRunState,
  events: HarnessEvent[],
  reviewedCommands?: Set<string>,
): Promise<IssueCommentRunReviewResult> {
  let currentState = state;
  const result: IssueCommentRunReviewResult = { requested: 0, reviewed: 0, denied: 0 };
  for (const event of events) {
    const data = recordData(event.data);
    if (!isControlPlaneIssueComment(data) || booleanField(data, "runReviewRequested") !== true) continue;
    if (currentState.status === "running" || currentState.status === "queued") continue;
    const review = currentState.review;
    if (!review?.required || review.status !== "pending") continue;
    const decision = stringField(data, "runReviewDecision");
    if (decision !== "approved" && decision !== "rejected") continue;
    const commandKey = `${issueCommentCommandId(data, event.seq)}\0${decision}`;
    if (reviewedCommands?.has(commandKey)) continue;
    reviewedCommands?.add(commandKey);
    result.requested += 1;
    const access = await issueCommentActorAccess(workspaceRoot, tenant, options, stringField(data, "actor"));
    if (tenantRoleRank(access.role) < tenantRoleRank("developer")) {
      result.denied += 1;
      continue;
    }
    try {
      await decideRunReview(
        workspaceRoot,
        options,
        appendAuditEvent,
        tenant,
        project,
        runId,
        runDir,
        currentState,
        decision,
        stringField(data, "runReviewNote"),
        false,
        issueCommentRunReviewContractPatchFromData(data),
        access,
        undefined,
      );
      result.reviewed += 1;
      currentState = await readRunState(runDir);
    } catch (error) {
      if (error instanceof Error && ["BadRequest", "Conflict", "Forbidden"].includes(error.name)) {
        result.denied += 1;
        continue;
      }
      throw error;
    }
  }
  return result;
}

async function claimRunReviewsForIssueCommentCommands(
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  runId: string,
  runDir: string,
  state: ReadableRunState,
  events: HarnessEvent[],
  claimedCommands?: Set<string>,
): Promise<IssueCommentRunReviewClaimResult> {
  let currentState = state;
  const result: IssueCommentRunReviewClaimResult = { requested: 0, claimed: 0, released: 0, denied: 0 };
  for (const event of events) {
    const data = recordData(event.data);
    if (!isControlPlaneIssueComment(data) || booleanField(data, "runReviewClaimRequested") !== true) continue;
    if (currentState.status === "running" || currentState.status === "queued") continue;
    const review = currentState.review;
    if (!review?.required || review.status !== "pending") continue;
    const action = runReviewClaimAction(stringField(data, "runReviewClaimAction"));
    const commandKey = `${issueCommentCommandId(data, event.seq)}\0${action}`;
    if (claimedCommands?.has(commandKey)) continue;
    claimedCommands?.add(commandKey);
    result.requested += 1;
    const access = await issueCommentActorAccess(workspaceRoot, tenant, options, stringField(data, "actor"));
    if (tenantRoleRank(access.role) < tenantRoleRank("developer")) {
      result.denied += 1;
      continue;
    }
    try {
      await claimRunReview(
        options,
        appendAuditEvent,
        tenant,
        project,
        runId,
        runDir,
        currentState,
        review,
        action,
        access,
        undefined,
      );
      if (action === "claim") {
        result.claimed += 1;
      } else {
        result.released += 1;
      }
      currentState = await readRunState(runDir);
    } catch (error) {
      if (error instanceof Error && ["BadRequest", "Conflict", "Forbidden"].includes(error.name)) {
        result.denied += 1;
        continue;
      }
      throw error;
    }
  }
  return result;
}

async function deployRunsForIssueCommentCommands(
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  runId: string,
  runDir: string,
  state: ReadableRunState,
  events: HarnessEvent[],
  deployedCommands?: Set<string>,
): Promise<IssueCommentDeploymentResult> {
  let currentState = state;
  const result: IssueCommentDeploymentResult = { requested: 0, deployed: 0, denied: 0 };
  for (const event of events) {
    const data = recordData(event.data);
    if (!isControlPlaneIssueComment(data) || booleanField(data, "deploymentRequested") !== true) continue;
    if (currentState.status === "running" || currentState.status === "queued") continue;
    if (currentState.review?.required && currentState.review.status === "pending") continue;
    if (currentState.status !== "deployment_required" || !currentState.deployment?.required || currentState.deployment.status !== "pending") continue;
    const decision = stringField(data, "deploymentDecision");
    if (decision !== "approved" && decision !== "rejected") continue;
    const commandKey = `${issueCommentCommandId(data, event.seq)}\0${decision}`;
    if (deployedCommands?.has(commandKey)) continue;
    deployedCommands?.add(commandKey);
    result.requested += 1;
    const access = await issueCommentActorAccess(workspaceRoot, tenant, options, stringField(data, "actor"));
    if (tenantRoleRank(access.role) < tenantRoleRank("admin")) {
      result.denied += 1;
      continue;
    }
    try {
      await decideRunDeployment(
        options,
        appendAuditEvent,
        tenant,
        project,
        runId,
        runDir,
        currentState,
        decision,
        stringField(data, "deploymentNote"),
        access,
        undefined,
      );
      result.deployed += 1;
      currentState = await readRunState(runDir);
    } catch (error) {
      if (error instanceof Error && ["BadRequest", "Conflict", "Forbidden"].includes(error.name)) {
        result.denied += 1;
        continue;
      }
      throw error;
    }
  }
  return result;
}

async function reviewVasLiteCasesForIssueCommentCommands(
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  runId: string,
  state: ReadableRunState,
  events: HarnessEvent[],
): Promise<IssueCommentVasReviewResult> {
  const result: IssueCommentVasReviewResult = { requested: 0, reviewed: 0, denied: 0 };
  const caseId = vasLiteRunCaseId(state);
  for (const event of events) {
    const data = recordData(event.data);
    if (!isControlPlaneIssueComment(data) || booleanField(data, "vasReviewRequested") !== true) continue;
    result.requested += 1;
    const access = await issueCommentActorAccess(workspaceRoot, tenant, options, stringField(data, "actor"));
    if (tenantRoleRank(access.role) < tenantRoleRank("developer")) {
      result.denied += 1;
      continue;
    }
    if (!caseId) continue;
    const decision = vasLiteCaseReviewDecisionField(data, "vasReviewDecision");
    if (!decision) continue;
    await reviewVasLiteCase(
      workspaceRoot,
      options,
      tenant,
      project,
      caseId,
      decision,
      {
        decision,
        note: stringField(data, "vasReviewNote"),
        runId,
      },
      access,
      undefined,
      appendAuditEvent,
    );
    result.reviewed += 1;
  }
  return result;
}

async function claimVasLiteCasesForIssueCommentCommands(
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  state: ReadableRunState | undefined,
  events: HarnessEvent[],
  linkedVasCaseIds: Map<string, Set<string>>,
  claimedCommands: Set<string>,
): Promise<IssueCommentVasClaimResult> {
  const result: IssueCommentVasClaimResult = { requested: 0, claimed: 0, released: 0, denied: 0, claimedCases: [] };
  const projectCaseIds = linkedVasCaseIds.get(project) ?? new Set<string>();
  for (const event of events) {
    const data = recordData(event.data);
    if (!isControlPlaneIssueComment(data) || booleanField(data, "vasClaimRequested") !== true) continue;
    result.requested += 1;
    const access = await issueCommentActorAccess(workspaceRoot, tenant, options, stringField(data, "actor"));
    if (tenantRoleRank(access.role) < tenantRoleRank("developer")) {
      result.denied += 1;
      continue;
    }

    const explicitCaseId = optionalSafeName(stringField(data, "vasClaimCaseId"), "caseId");
    if (!explicitCaseId && projectCaseIds.size > 1) {
      result.denied += 1;
      continue;
    }
    const caseId = explicitCaseId ?? (state ? vasLiteRunCaseId(state) : undefined) ?? [...projectCaseIds][0];
    if (!caseId) {
      result.denied += 1;
      continue;
    }
    const action = vasLiteCaseClaimAction(stringField(data, "vasClaimAction"));
    const commandKey = `${project}\0${issueCommentCommandId(data, event.seq)}\0${caseId}\0${action}`;
    if (claimedCommands.has(commandKey)) continue;
    claimedCommands.add(commandKey);

    try {
      await claimVasLiteCase(
        workspaceRoot,
        tenant,
        project,
        caseId,
        action,
        access,
        undefined,
        appendAuditEvent,
      );
      const claimedCase = {
        project,
        caseId,
        controlPlaneProvider: stringField(data, "controlPlaneProvider"),
        controlPlaneCommentId: stringField(data, "controlPlaneCommentId") ?? stringField(data, "giteaCommentId"),
        controlPlaneCommentUrl: stringField(data, "controlPlaneCommentUrl") ?? stringField(data, "giteaCommentUrl"),
        giteaCommentId: stringField(data, "giteaCommentId"),
        giteaCommentUrl: stringField(data, "giteaCommentUrl"),
      };
      if (action === "claim") {
        result.claimed += 1;
        result.claimedCases.push({ ...claimedCase, action: "claimed" });
      } else {
        result.released += 1;
        result.claimedCases.push({ ...claimedCase, action: "released" });
      }
    } catch (error) {
      if (error instanceof Error && ["BadRequest", "Conflict", "Forbidden"].includes(error.name)) {
        result.denied += 1;
        continue;
      }
      throw error;
    }
  }
  return result;
}

async function startVasLiteReviewRunsForIssueCommentCommands(
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  queuedRuns: QueuedRun[],
  scheduleQueuedRuns: () => void,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  state: ReadableRunState | undefined,
  events: HarnessEvent[],
  linkedVasCaseIds: Map<string, Set<string>>,
  startedCommands: Set<string>,
): Promise<IssueCommentVasRunResult> {
  const result: IssueCommentVasRunResult = { requested: 0, started: 0, denied: 0, startedRuns: [] };
  const projectCaseIds = linkedVasCaseIds.get(project) ?? new Set<string>();
  for (const event of events) {
    const data = recordData(event.data);
    if (!isControlPlaneIssueComment(data) || booleanField(data, "vasRunRequested") !== true) continue;
    result.requested += 1;
    const access = await issueCommentActorAccess(workspaceRoot, tenant, options, stringField(data, "actor"));
    if (tenantRoleRank(access.role) < tenantRoleRank("developer")) {
      result.denied += 1;
      continue;
    }

    const explicitCaseId = optionalSafeName(stringField(data, "vasRunCaseId"), "caseId");
    if (!explicitCaseId && projectCaseIds.size > 1) {
      result.denied += 1;
      continue;
    }
    const caseId = explicitCaseId ?? (state ? vasLiteRunCaseId(state) : undefined) ?? [...projectCaseIds][0];
    if (!caseId) {
      result.denied += 1;
      continue;
    }
    const commandKey = `${project}\0${issueCommentCommandId(data, event.seq)}\0${caseId}`;
    if (startedCommands.has(commandKey)) continue;
    startedCommands.add(commandKey);

    try {
      const caseRecord = await readVasLiteCase(join(workspaceRoot, tenant, project), caseId);
      const status = await createAsyncRunFromBody(
        workspaceRoot,
        options,
        activeRuns,
        activeRunSlots,
        activeWorkspaces,
        queuedRuns,
        scheduleQueuedRuns,
        appendAuditEvent,
        {
          tenant,
          project,
          preset: VAS_LITE_REVIEW_PRESET,
          presetInput: { caseId },
          async: true,
          queue: true,
          ...(state ? handoffFollowupModelFields({}, state) : {}),
          issue: stringField(data, "issue") ?? state?.metadata?.issue ?? stringField(caseRecord, "issue"),
          repo: state?.metadata?.repo ?? stringField(caseRecord, "repo"),
          branch: state?.metadata?.branch ?? stringField(caseRecord, "branch"),
          baseBranch: state?.metadata?.baseBranch ?? stringField(caseRecord, "baseBranch"),
        },
        access,
        [issueCommentInitialRunEvent(event)],
      );
      result.started += 1;
      result.startedRuns.push({
        project,
        runId: status.runId,
        status: status.status,
        caseId,
        controlPlaneProvider: stringField(data, "controlPlaneProvider"),
        controlPlaneCommentId: stringField(data, "controlPlaneCommentId") ?? stringField(data, "giteaCommentId"),
        controlPlaneCommentUrl: stringField(data, "controlPlaneCommentUrl") ?? stringField(data, "giteaCommentUrl"),
        giteaCommentId: stringField(data, "giteaCommentId"),
        giteaCommentUrl: stringField(data, "giteaCommentUrl"),
      });
    } catch (error) {
      if (error instanceof Error && ["BadRequest", "Conflict", "Forbidden"].includes(error.name)) {
        result.denied += 1;
        continue;
      }
      throw error;
    }
  }
  return result;
}

async function startHandoffFollowupRunsForIssueCommentCommands(
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  queuedRuns: QueuedRun[],
  scheduleQueuedRuns: () => void,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  sourceRunId: string,
  sourceRunDir: string,
  sourceState: ReadableRunState,
  events: HarnessEvent[],
  startedCommands: Set<string>,
): Promise<IssueCommentHandoffFollowupResult> {
  const result: IssueCommentHandoffFollowupResult = { requested: 0, started: 0, denied: 0, startedRuns: [] };
  for (const event of events) {
    const data = recordData(event.data);
    if (!isControlPlaneIssueComment(data) || booleanField(data, "handoffFollowupRequested") !== true) continue;
    const commandKey = issueCommentCommandId(data, event.seq);
    if (startedCommands.has(commandKey)) continue;
    startedCommands.add(commandKey);
    result.requested += 1;

    const access = await issueCommentActorAccess(workspaceRoot, tenant, options, stringField(data, "actor"));
    if (tenantRoleRank(access.role) < tenantRoleRank("developer")) {
      await appendAuditEvent(tenant, "run_handoff_followup_denied", compactObject({
        project,
        runId: sourceRunId,
        reason: "developer access required",
        sourceStatus: sourceState.status,
        controlPlaneProvider: stringField(data, "controlPlaneProvider"),
        controlPlaneCommentId: stringField(data, "controlPlaneCommentId") ?? stringField(data, "giteaCommentId"),
        controlPlaneCommentUrl: stringField(data, "controlPlaneCommentUrl") ?? stringField(data, "giteaCommentUrl"),
        giteaCommentId: stringField(data, "giteaCommentId"),
        giteaCommentUrl: stringField(data, "giteaCommentUrl"),
        deliveryId: stringField(data, "deliveryId"),
      }), access);
      result.denied += 1;
      continue;
    }

    try {
      const sourceContext: HarnessWorkspaceContext = {
        tenant,
        project,
        runId: sourceRunId,
        cwd: join(workspaceRoot, tenant, project),
        repo: sourceState.metadata?.repo,
        branch: sourceState.metadata?.branch,
        baseBranch: sourceState.metadata?.baseBranch,
        issue: sourceState.metadata?.issue,
      };
      const sourceEvents = await readRunEventsIfPresent(sourceRunDir);
      const sourceAuditTrail = runTenantAuditTrail(await readTenantAuditEvents(workspaceRoot, tenant, options.stateBackend?.events), project, sourceRunId);
      const sourceFollowupRuns = await runHandoffFollowupRuns(workspaceRoot, tenant, project, sourceRunId, sourceAuditTrail);
      const sourceCheckpoint = runEvidenceCheckpoint(sourceState, sourceEvents, {
        auditTrail: sourceAuditTrail,
        followupRuns: sourceFollowupRuns,
      });
      const handoff = runHandoffEvidence(sourceState, sourceEvents, sourceAuditTrail);
      const sourceProjectContract = sourceState.metadata?.projectContract;
      const sourceProjectContractStatus = sourceState.metadata?.projectContractStatus;
      const sourceAllowedTools = await effectiveTenantAllowedTools(options, tenant);
      const sourceChangedFiles = sourceAllowedTools.includes("git.diff")
        ? workspaceDiffChangedFiles(await workspaceDiff(sourceContext, options))
        : [];
      const sourceCommands = await readWorkspaceCommandSummaries(
        runWorkspaceCommandRoot(workspaceRoot, tenant, project, sourceRunId),
        { route: "run", tenant, project, runId: sourceRunId },
      );
      const sourceSessions = await readWorkspaceSessionSummaries(
      runWorkspaceSessionRoot(workspaceRoot, tenant, project, sourceRunId),
      activeSessions,
      { route: "run", tenant, project, runId: sourceRunId },
      options,
    );
      const goal = handoffFollowupDefaultGoal(sourceState);
      const note = stringField(data, "handoffFollowupNote");
      const status = await createAsyncRunFromBody(
        workspaceRoot,
        options,
        activeRuns,
        activeRunSlots,
        activeWorkspaces,
        queuedRuns,
        scheduleQueuedRuns,
        appendAuditEvent,
        compactObject({
          tenant,
          project,
          async: true,
          queue: true,
          preset: sourceState.metadata?.runPreset,
          presetInput: sourceState.metadata?.runPresetInput,
          goal,
          ...handoffFollowupModelFields({}, sourceState),
          repo: sourceContext.repo,
          branch: handoff.branch ?? sourceContext.branch,
          baseBranch: handoff.baseBranch ?? sourceContext.baseBranch,
          issue: handoff.issue ?? sourceContext.issue,
          verify: [],
          skills: sourceState.skills,
        }),
        access,
        [
          handoffFollowupInitialRunEvent({
            tenant,
            project,
            sourceRunId,
            sourceState,
            sourceEvents,
            handoff,
            sourceChangedFiles,
            sourceCommands,
            sourceSessions,
            sourceCheckpointVersion: sourceCheckpoint.version,
            sourceProjectContract,
            sourceProjectContractStatus,
            note,
            access,
            controlPlaneProvider: stringField(data, "controlPlaneProvider"),
            controlPlaneCommentId: stringField(data, "controlPlaneCommentId") ?? stringField(data, "giteaCommentId"),
            controlPlaneCommentUrl: stringField(data, "controlPlaneCommentUrl") ?? stringField(data, "giteaCommentUrl"),
            giteaCommentId: stringField(data, "giteaCommentId"),
            giteaCommentUrl: stringField(data, "giteaCommentUrl"),
          }),
        ],
        {
          handoffSourceRunId: sourceRunId,
          handoffSourceProject: project,
          handoffSourceStatus: sourceState.status,
          handoffSourceGoal: sourceState.goal,
          handoffSourceCheckpointVersion: sourceCheckpoint.version,
          handoffSourceProjectContract: sourceProjectContract,
          handoffSourceProjectContractStatus: sourceProjectContractStatus,
          handoffSourceReplayUrl: `/tenants/${tenant}/runs/${sourceRunId}/replay${runProjectQuery(project)}`,
          handoffSourceHandoffPackageUrl: runEvidencePath(tenant, project, sourceRunId, "handoff-package"),
          handoffSourceControlPlaneProvider: stringField(data, "controlPlaneProvider"),
          handoffSourceControlPlaneCommentId: stringField(data, "controlPlaneCommentId") ?? stringField(data, "giteaCommentId"),
          handoffSourceControlPlaneCommentUrl: stringField(data, "controlPlaneCommentUrl") ?? stringField(data, "giteaCommentUrl"),
          handoffSourceGiteaCommentId: stringField(data, "giteaCommentId"),
          handoffSourceGiteaCommentUrl: stringField(data, "giteaCommentUrl"),
        },
      );
      await appendAuditEvent(tenant, "run_handoff_followup_created", compactObject({
        project,
        runId: sourceRunId,
        followupRunId: status.runId,
        followupStatus: status.status,
        goal,
        sourceStatus: sourceState.status,
        sourceCheckpointVersion: sourceCheckpoint.version,
        sourceProjectContract,
        sourceProjectContractStatus,
        sourceIssue: handoff.issue,
        sourceBranch: handoff.branch,
        sourceBaseBranch: handoff.baseBranch,
        sourcePullRequestUrl: handoff.pullRequestUrl,
        controlPlaneProvider: stringField(data, "controlPlaneProvider"),
        controlPlaneCommentId: stringField(data, "controlPlaneCommentId") ?? stringField(data, "giteaCommentId"),
        controlPlaneCommentUrl: stringField(data, "controlPlaneCommentUrl") ?? stringField(data, "giteaCommentUrl"),
        giteaCommentId: stringField(data, "giteaCommentId"),
        giteaCommentUrl: stringField(data, "giteaCommentUrl"),
        deliveryId: stringField(data, "deliveryId"),
      }), access);
      result.started += 1;
      result.startedRuns.push({
        project,
        sourceRunId,
        runId: status.runId,
        status: status.status,
        sourceCheckpointVersion: sourceCheckpoint.version,
        sourceProjectContractStatus,
        controlPlaneProvider: stringField(data, "controlPlaneProvider"),
        controlPlaneCommentId: stringField(data, "controlPlaneCommentId") ?? stringField(data, "giteaCommentId"),
        controlPlaneCommentUrl: stringField(data, "controlPlaneCommentUrl") ?? stringField(data, "giteaCommentUrl"),
        giteaCommentId: stringField(data, "giteaCommentId"),
        giteaCommentUrl: stringField(data, "giteaCommentUrl"),
        links: {
          workbench: `/workbench?${new URLSearchParams({ tenant, project, runId: status.runId }).toString()}`,
          handoffPackage: runEvidencePath(tenant, project, status.runId, "handoff-package"),
        },
      });
    } catch (error) {
      if (error instanceof Error && ["BadRequest", "Conflict", "Forbidden"].includes(error.name)) {
        result.denied += 1;
        continue;
      }
      throw error;
    }
  }
  return result;
}

async function issueCommentActorAccess(
  workspaceRoot: string,
  tenant: string,
  options: HarnessServerOptions,
  actor: string | undefined,
): Promise<TenantAccess> {
  const fallbackActor = actor ?? "gitea";
  const prefixedLogin = /^[a-z0-9][a-z0-9-]*:/i.test(fallbackActor)
    ? fallbackActor.slice(fallbackActor.indexOf(":") + 1)
    : undefined;
  const login = prefixedLogin ?? fallbackActor;
  const policy = await readTenantPolicy(resolve(workspaceRoot), tenant, options);
  const controlPlaneIdentity = policy?.controlPlaneIdentities?.find((identity) => identity.actor === fallbackActor);
  if (controlPlaneIdentity) {
    return { actor: controlPlaneIdentity.actor, role: controlPlaneIdentity.role };
  }
  const tenantApiKeys = [...(options.tenantApiKeys?.[tenant] ?? []), ...(policy?.apiKeys ?? [])];
  const matched = tenantApiKeys.find((key) => key.actor === fallbackActor || key.actor === login || key.actor === `gitea:${login}`);
  return { actor: fallbackActor, role: matched?.role ?? "viewer" };
}

function syncedIssueCommentIds(events: HarnessEvent[], issue: string): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== "user_message") continue;
    const data = recordData(event.data);
    if (!isControlPlaneIssueComment(data) || data.issue !== issue) continue;
    const id = stringField(data, "controlPlaneCommentId") ?? stringField(data, "giteaCommentId");
    if (id) ids.add(id);
  }
  return ids;
}

function issueCommentId(comment: GiteaIssueComment): string {
  return String(comment.id);
}

function issueCommentContent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const content = value.trim();
  if (!content || /\0/.test(content)) return undefined;
  if (content.length <= 4000) return content;
  return `${content.slice(0, 3997)}...`;
}

function issueCommentPauseReason(content: string): string | undefined {
  return issueCommentCommandReason(content, "pause", "issue comment requested pause");
}

function issueCommentResumeReason(content: string): string | undefined {
  return issueCommentCommandReason(content, "resume", "issue comment requested resume");
}

function issueCommentRunReviewCommand(content: string): { decision: "approved" | "rejected"; note?: string; contractPatch?: ProjectContractPatch } | undefined {
  const approvedNote = issueCommentCommandText(content, "approve");
  if (approvedNote !== undefined) {
    const patch = issueCommentContractPatchFromReviewNote(approvedNote);
    return compactObject({ decision: "approved" as const, note: patch.note || undefined, contractPatch: patch.contractPatch });
  }
  const changesNote = issueCommentCommandText(content, "request-changes");
  if (changesNote !== undefined) {
    const patch = issueCommentContractPatchFromReviewNote(changesNote);
    return compactObject({ decision: "rejected" as const, note: patch.note || undefined, contractPatch: patch.contractPatch });
  }
  return undefined;
}

function issueCommentContractPatchFromReviewNote(note: string): { note: string; contractPatch?: ProjectContractPatch } {
  const lines = note.split(/\r?\n/);
  const noteLines: string[] = [];
  const patchLines: string[] = [];
  let inPatch = false;
  let foundPatch = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inPatch && trimmed.toLowerCase() === "```loom-contract-patch") {
      if (foundPatch) throw badRequest("issue comment can include only one loom-contract-patch block.");
      foundPatch = true;
      inPatch = true;
      continue;
    }
    if (inPatch) {
      if (trimmed === "```") {
        inPatch = false;
        continue;
      }
      patchLines.push(line);
      continue;
    }
    noteLines.push(line);
  }
  if (inPatch) throw badRequest("loom-contract-patch block must be closed.");
  if (!foundPatch) return { note: note.trim() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(patchLines.join("\n"));
  } catch {
    throw badRequest("loom-contract-patch block must contain a JSON object.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("loom-contract-patch block must contain a JSON object.");
  }
  const contractPatch = projectContractFromBody(parsed as ProjectContractRequestBody);
  if (!contractPatch) throw badRequest("loom-contract-patch block must include objective, constraints, or successCriteria.");
  return { note: noteLines.join("\n").trim(), contractPatch };
}

function issueCommentRunReviewContractPatchFromData(data: Record<string, unknown>): ProjectContractPatch | undefined {
  if (data.runReviewContractPatch === undefined) return undefined;
  const value = data.runReviewContractPatch;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("runReviewContractPatch must be an object.");
  }
  const contractPatch = projectContractFromBody(value as ProjectContractRequestBody);
  if (!contractPatch) throw badRequest("runReviewContractPatch must include objective, constraints, or successCriteria.");
  return contractPatch;
}

function issueCommentRunReviewClaimCommand(content: string): { action: RunReviewClaimAction; note?: string } | undefined {
  const lines = content.split(/\r?\n/);
  let action: RunReviewClaimAction | undefined;
  const rest: string[] = [];
  for (const line of lines) {
    const match = line.trim().match(/^\/loom\s+(claim-review|release-review-claim)$/i);
    if (match) {
      const currentAction: RunReviewClaimAction = match[1].toLowerCase() === "claim-review" ? "claim" : "release";
      if (action && action !== currentAction) {
        throw badRequest("run review claim commands in one comment must use the same action.");
      }
      action = currentAction;
      continue;
    }
    rest.push(line);
  }
  if (!action) return undefined;
  const note = rest.join("\n").trim();
  return compactObject({ action, note: note || undefined });
}

function issueCommentDeploymentCommand(content: string): { decision: "approved" | "rejected"; note?: string } | undefined {
  const approvedNote = issueCommentCommandText(content, "approve-deploy");
  if (approvedNote !== undefined) {
    return compactObject({ decision: "approved" as const, note: approvedNote || undefined });
  }
  const rejectedNote = issueCommentCommandText(content, "reject-deploy");
  if (rejectedNote !== undefined) {
    return compactObject({ decision: "rejected" as const, note: rejectedNote || undefined });
  }
  return undefined;
}

function issueCommentVasReviewCommand(content: string): { decision: VasCaseReviewDecision; note?: string } | undefined {
  const approvedNote = issueCommentCommandText(content, "approve-vas");
  if (approvedNote !== undefined) {
    return compactObject({ decision: "approved" as const, note: approvedNote || undefined });
  }
  const changesNote = issueCommentCommandText(content, "request-vas-changes");
  if (changesNote !== undefined) {
    return compactObject({ decision: "changes_requested" as const, note: changesNote || undefined });
  }
  return undefined;
}

function issueCommentVasRunCommand(content: string): { caseId?: string; note?: string } | undefined {
  const lines = content.split(/\r?\n/);
  let commandFound = false;
  let caseId: string | undefined;
  const rest: string[] = [];
  for (const line of lines) {
    const match = line.trim().match(/^\/loom\s+run-vas-review(?:\s+([A-Za-z0-9._-]+))?$/i);
    if (match) {
      commandFound = true;
      const currentCaseId = match[1] ? requireSafeName(match[1], "caseId") : undefined;
      if (caseId && currentCaseId && caseId !== currentCaseId) {
        throw badRequest("run-vas-review commands in one comment must target the same caseId.");
      }
      caseId = currentCaseId ?? caseId;
      continue;
    }
    rest.push(line);
  }
  if (!commandFound) return undefined;
  const note = rest.join("\n").trim();
  return compactObject({ caseId, note: note || undefined });
}

function issueCommentVasClaimCommand(content: string): { action: VasCaseClaimAction; caseId?: string; note?: string } | undefined {
  const lines = content.split(/\r?\n/);
  let action: VasCaseClaimAction | undefined;
  let caseId: string | undefined;
  const rest: string[] = [];
  for (const line of lines) {
    const match = line.trim().match(/^\/loom\s+(claim-vas|release-vas-claim)(?:\s+([A-Za-z0-9._-]+))?$/i);
    if (match) {
      const currentAction: VasCaseClaimAction = match[1].toLowerCase() === "claim-vas" ? "claim" : "release";
      if (action && action !== currentAction) {
        throw badRequest("VAS claim commands in one comment must use the same action.");
      }
      action = currentAction;
      const currentCaseId = match[2] ? requireSafeName(match[2], "caseId") : undefined;
      if (caseId && currentCaseId && caseId !== currentCaseId) {
        throw badRequest("VAS claim commands in one comment must target the same caseId.");
      }
      caseId = currentCaseId ?? caseId;
      continue;
    }
    rest.push(line);
  }
  if (!action) return undefined;
  const note = rest.join("\n").trim();
  return compactObject({ action, caseId, note: note || undefined });
}

function issueCommentHandoffFollowupCommand(content: string): { note?: string } | undefined {
  const lines = content.split(/\r?\n/);
  let commandFound = false;
  const rest: string[] = [];
  for (const line of lines) {
    if (line.trim().match(/^\/loom\s+run-handoff-followup$/i)) {
      commandFound = true;
      continue;
    }
    rest.push(line);
  }
  if (!commandFound) return undefined;
  const note = rest.join("\n").trim();
  return compactObject({ note: note || undefined });
}

function issueCommentCommandReason(content: string, command: "pause" | "resume", defaultReason: string): string | undefined {
  const reason = issueCommentCommandText(content, command);
  if (reason === undefined) return undefined;
  return reason || defaultReason;
}

function issueCommentCommandText(content: string, command: "pause" | "resume" | "approve" | "request-changes" | "approve-deploy" | "reject-deploy" | "approve-vas" | "request-vas-changes"): string | undefined {
  const lines = content.split(/\r?\n/);
  let commandFound = false;
  const rest: string[] = [];
  for (const line of lines) {
    if (line.trim().toLowerCase() === `/loom ${command}`) {
      commandFound = true;
      continue;
    }
    rest.push(line);
  }
  if (!commandFound) return undefined;
  return rest.join("\n").trim();
}

function isLoomGeneratedIssueComment(content: string): boolean {
  return /<!--\s*loom-run:/i.test(content);
}

function issueCommentActor(value: unknown, prefix = "gitea"): string | undefined {
  if (typeof value !== "string") return undefined;
  const actor = value.trim();
  if (!actor || actor.length > 120 || /[\0\r\n]/.test(actor)) return undefined;
  return `${prefix}:${actor}`;
}

function issueCommentWebhookPayload(payload: Record<string, unknown>): { issue: string; comment: GiteaIssueComment } | undefined {
  const repository = recordData(payload.repository);
  const issue = recordData(payload.issue);
  const comment = recordData(payload.comment);
  const repo = webhookRepositoryFullName(repository);
  const index = numberField(issue, "number") ?? numberField(issue, "index");
  const body = stringField(comment, "body");
  if (!repo || index === undefined || !body) return undefined;
  return {
    issue: `${repo}#${index}`,
    comment: {
      id: String(comment.id ?? ""),
      body,
      author: webhookCommentAuthor(comment),
      url: stringField(comment, "html_url") ?? stringField(comment, "url"),
      createdAt: stringField(comment, "created_at"),
      updatedAt: stringField(comment, "updated_at"),
    },
  };
}

function webhookRepositoryFullName(repository: Record<string, unknown>): string | undefined {
  const fullName = stringField(repository, "full_name");
  if (fullName) return fullName;
  const owner = recordData(repository.owner);
  const ownerName = stringField(owner, "login") ?? stringField(owner, "username") ?? stringField(owner, "name");
  const repoName = stringField(repository, "name");
  return ownerName && repoName ? `${ownerName}/${repoName}` : undefined;
}

function webhookCommentAuthor(comment: Record<string, unknown>): string | undefined {
  const user = recordData(comment.user);
  return stringField(user, "login") ?? stringField(user, "username") ?? stringField(user, "name");
}

function parseWebhookJson(raw: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw.toString("utf8") || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw badRequest("webhook payload must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.name === "BadRequest") throw error;
    throw badRequest("invalid JSON webhook payload");
  }
}

function verifyControlPlaneWebhookSignature(req: IncomingMessage, raw: Buffer, secret: string, label = "gitea"): void {
  const provided = webhookSignature(req);
  if (!provided) throw unauthorized(`missing ${label} webhook signature`);
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  if (!timingSafeHexEqual(provided, expected)) {
    throw unauthorized(`invalid ${label} webhook signature`);
  }
}

function webhookSignature(req: IncomingMessage): string | undefined {
  const signature =
    headerValue(req.headers["x-gitea-signature"]) ??
    headerValue(req.headers["x-forgejo-signature"]) ??
    headerValue(req.headers["x-hub-signature-256"]);
  return signature?.replace(/^sha256=/i, "").trim().toLowerCase();
}

function giteaWebhookEventName(req: IncomingMessage): string | undefined {
  return headerValue(req.headers["x-gitea-event-type"]) ??
    headerValue(req.headers["x-forgejo-event-type"]) ??
    headerValue(req.headers["x-github-event-type"]) ??
    headerValue(req.headers["x-gitea-event"]) ??
    headerValue(req.headers["x-forgejo-event"]) ??
    headerValue(req.headers["x-github-event"]);
}

function webhookDeliveryId(req: IncomingMessage): string | undefined {
  const value = headerValue(req.headers["x-gitea-delivery"]) ?? headerValue(req.headers["x-forgejo-delivery"]) ?? headerValue(req.headers["x-github-delivery"]);
  if (!value || value.length > 160 || /[\0\r\n]/.test(value)) return undefined;
  return value;
}

function reviewDecision(value: unknown): "approved" | "rejected" {
  if (value !== "approved" && value !== "rejected") {
    throw badRequest("decision must be approved or rejected.");
  }
  return value;
}

function runReviewClaimAction(value: unknown): RunReviewClaimAction {
  if (value === undefined || value === null || value === "" || value === "claim") return "claim";
  if (value === "release") return "release";
  throw badRequest("action must be claim or release.");
}

export { ReviewRequestBody, ReviewClaimRequestBody, DeploymentRequestBody, IssueCommentSyncRequestBody, InitialIssueCommentEventsResult, ProjectHumanGateRunSummary, RunHandoffFollowupEvidence, IssueCommentSeedEvidence, projectHumanGateRunSummary, issueCommentSyncContextForOptions, reportAgentGitServiceWorkspaceHandoffAttachment, appendInitialIssueCommentSyncAuditEvent, handleReviewRun, handleClaimRunReview, handleDeploymentRun, handleGiteaIssueCommentWebhook, handleSyncRunIssueComments, handleCreateRunHandoffFollowup, handleListRunHandoffFollowups, handleReadRunHandoffPackage, handleReadRunReviewSummary, applyProjectContractStatusGate, issueCommentSeedEvidence, reviewClaimField, initialIssueCommentEventsForRun, reviewDecision };
