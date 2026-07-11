import { chmod, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, posix, resolve } from "node:path";
import { readTenantAuditEvents, type TenantAuditAppender, type TenantAuditEvent, type TenantRole } from "../audit.js";
import { parseAgentGitServiceRepoRef } from "../agent-git-service.js";
import { type ReadableRunState } from "../run-state.js";
import type { ProjectContractEvidence, ProjectContractPatch, ProjectContractStatusEvidence, ProjectRunPolicyEvidence, ReviewClaim, RunModelUsageSummary, RunRequesterSummary, RunSummary } from "../events.js";
import { type ControlPlaneProviderCatalogName } from "../control-plane.js";
import { AGENT_GIT_SERVICE_PROJECT_PROVISIONING_RECEIPT_PATH, provisionAgentGitServiceProjectAgent, readAgentGitServiceProjectProvisioningReceipt, type AgentGitServiceProjectProvisioningResult, type ProvisionAgentGitServiceProjectAgentOptions } from "../agent-git-service-provisioning.js";
import { projectMetadataDefaultSkills, projectTemplateContractStatus, readProjectTemplateMetadata, seedProjectTemplate, updateProjectTemplateContract, updateProjectTemplateDefaultSkills, updateProjectTemplateRunPolicy, type ProjectTemplateContract, type ProjectTemplateContractStatus, type ProjectTemplateMetadata, type ProjectTemplateName, type ProjectTemplateRunPolicy } from "../project-templates.js";
import { RunRequestBody, QueuedRun, ActiveRunSlot, RunPresenceEntry, StoredRunPresenceEntry, RunPresenceRegistry, RUN_PRESENCE_TTL_MS, activeRunCollaboratorSummary, queuedRunPositions, readRunStatesForListing, isRunSummaryState, createAgent, runPresetName, presenceClientId, presenceLabel, presenceFocus, persistPresenceEntry, refreshRunPresenceFromDisk, refreshPresenceDirectory, purgeExpiredRunPresence, publicRunPresenceEntry, readPresenceJson } from "./runs.js";
import { HarnessWorkspaceContext, ActiveWorkspaceSession, WorkspaceSessionSummary, WorkspaceCommandSummary, workspaceDirectoryUsageBytes, activeWorkspaceSessionDetails, readWorkspaceCommandSummaries, readWorkspaceSessionSummaries, workspaceDiff, workspaceInfo, workspaceSessionActivityAt, compactWorkspaceSessionSummary, listWorkspaceTenantNames } from "./workspace.js";
import { ProjectHumanGateRunSummary, projectHumanGateRunSummary, reviewClaimField } from "./gates.js";
import { ActiveRunResourceStatus, HarnessProfileReadiness, QueuedRunResourceStatus, activeRunResourceStatuses, statusActiveRunDetails, queuedRunResourceStatus, controlPlaneProviderName, publicControlPlaneBaseUrl, upsertTenantControlPlaneIdentity, controlPlaneProviderNameField } from "./status.js";
import { VAS_LITE_REVIEW_PRESET, vasLiteReviewPresetInput, readVasLiteProjectReadiness } from "./vas.js";
import { TenantControlPlaneIdentity, TenantPolicyLimits, TenantAccess, requireTenantTool, readTenantPolicy, tenantPolicyControlPlaneIdentityActor, tenantPolicyApiKeyActor, tenantPolicyRole, sanitizeTenantControlPlaneIdentity, tenantPolicyAuditData, requireTenantAccess } from "./tenants.js";
import { HarnessServerOptions } from "./types.js";
import { compactStringList, optionalSourceRepo, optionalSourceGitRef, optionalSourceIssue, compactObject, writeJsonFileAtomic, recordData, stringField, booleanField, numberField, stringArrayField, stringArrayFieldAllowEmpty, requireSafeName, optionalSafeName, requireString, optionalString, optionalBoolean, optionalClientId, envNameValue, stringArray, booleanFlag, badRequest, conflict, notFound, writeJson, isNotFound, isAlreadyExists, startedAt, readJsonBody } from "./shared.js";

async function readProjectCreateJson(req: IncomingMessage): Promise<ProjectCreateRequestBody> {
  return readJsonBody<ProjectCreateRequestBody>(req);
}

async function readProjectSourceDefaultsJson(req: IncomingMessage): Promise<ProjectSourceDefaultsRequestBody> {
  return readJsonBody<ProjectSourceDefaultsRequestBody>(req);
}

async function readProjectDefaultSkillsJson(req: IncomingMessage): Promise<ProjectDefaultSkillsRequestBody> {
  return readJsonBody<ProjectDefaultSkillsRequestBody>(req);
}

async function readProjectRunPolicyJson(req: IncomingMessage): Promise<ProjectRunPolicyRequestBody> {
  return readJsonBody<ProjectRunPolicyRequestBody>(req);
}

async function readProjectContractJson(req: IncomingMessage): Promise<ProjectContractRequestBody> {
  return readJsonBody<ProjectContractRequestBody>(req);
}

async function readAgentGitServiceProjectProvisionJson(req: IncomingMessage): Promise<AgentGitServiceProjectProvisionRequestBody> {
  return readJsonBody<AgentGitServiceProjectProvisionRequestBody>(req);
}

async function readAgentGitServiceProvisioningPlanApplyJson(req: IncomingMessage): Promise<AgentGitServiceProvisioningPlanApplyRequestBody> {
  return readJsonBody<AgentGitServiceProvisioningPlanApplyRequestBody>(req);
}


interface AgentGitServiceProjectProvisionRequestBody {
  repo?: unknown;
  permission?: unknown;
  agentPrefixLogin?: unknown;
  defaultRepoName?: unknown;
  tokenEnvName?: unknown;
  controlPlaneIdentity?: unknown;
  storeAgentToken?: unknown;
  force?: unknown;
  clientId?: unknown;
}

interface AgentGitServiceProvisioningPlanApplyRequestBody {
  projects?: unknown;
  dryRun?: unknown;
  eligibleOnly?: unknown;
  clientId?: unknown;
}

interface AgentGitServiceProvisioningControlPlaneIdentityRequest {
  actor?: string;
  role: TenantRole;
}

interface AgentGitServiceAgentTokenSecretEvidence {
  stored: true;
  tokenEnvName: string;
  secretRef: string;
}

interface ProjectCreateRequestBody {
  project?: unknown;
  template?: unknown;
  repo?: unknown;
  branch?: unknown;
  baseBranch?: unknown;
  issue?: unknown;
  defaultSkills?: unknown;
  preset?: unknown;
  presetInput?: unknown;
  reviewRequired?: unknown;
  deploymentRequired?: unknown;
  objective?: unknown;
  constraints?: unknown;
  successCriteria?: unknown;
  clientId?: unknown;
}

interface ProjectSourceDefaultsRequestBody {
  repo?: unknown;
  branch?: unknown;
  baseBranch?: unknown;
  issue?: unknown;
  clientId?: unknown;
}

interface ProjectDefaultSkillsRequestBody {
  defaultSkills?: unknown;
  clientId?: unknown;
}

interface ProjectRunPolicyRequestBody {
  preset?: unknown;
  presetInput?: unknown;
  reviewRequired?: unknown;
  deploymentRequired?: unknown;
  clientId?: unknown;
}

interface ProjectContractRequestBody {
  objective?: unknown;
  constraints?: unknown;
  successCriteria?: unknown;
  clientId?: unknown;
}

type ProjectWorkspaceActivityType =
  | "workspace_file_written"
  | "workspace_file_moved"
  | "workspace_file_deleted"
  | "workspace_file_conflicted"
  | "workspace_commit_created"
  | "workspace_pull_request_created";

interface ProjectWorkspaceActivitySummary {
  type: ProjectWorkspaceActivityType;
  ts: string;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  path?: string;
  fromPath?: string;
  toPath?: string;
  operation?: string;
  expectedUpdatedAt?: string;
  observedUpdatedAt?: string;
  observedKind?: string;
  activeEditorCount?: number;
  bytes?: number;
  commit?: string;
  message?: string;
  issue?: string;
  issueUrl?: string;
  branch?: string;
  baseBranch?: string;
  pullRequestIndex?: number;
  pullRequestUrl?: string;
}

type ProjectControlActivityType =
  | "project_created"
  | "project_source_defaults_updated"
  | "project_default_skills_updated"
  | "project_run_policy_updated"
  | "project_contract_updated"
  | "vas_case_created"
  | "vas_case_claimed"
  | "vas_case_reviewed"
  | "run_comment_added"
  | "run_issue_comments_synced"
  | "run_resumed"
  | "queued_run_recovered"
  | "queued_run_recovery_failed"
  | "run_cancelled"
  | "run_abandoned"
	  | "run_review_claimed"
	  | "review_decided"
	  | "deployment_decided"
	  | "run_handoff_followup_created"
	  | "run_handoff_followup_denied"
	  | "tenant_control_plane_restore_dry_run"
  | "agent_git_service_project_agent_provisioned"
  | "agent_git_service_wiki_memory_updated"
  | "agent_git_service_wiki_memory_failed";

interface ProjectControlActivitySummary {
  type: ProjectControlActivityType;
  ts: string;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  template?: ProjectTemplateName;
  runId?: string;
  caseId?: string;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  issue?: string;
  issueUrl?: string;
  message?: string;
  note?: string;
  source?: string;
  decision?: string;
  status?: string;
  action?: string;
  claimedAt?: string;
  previousClaim?: ReviewClaim;
  cleared?: boolean;
  defaultSkills?: string[];
  runPolicy?: ProjectTemplateRunPolicy;
  contract?: ProjectTemplateContract;
  reason?: string;
  queued?: boolean;
  stale?: boolean;
  pauseRequested?: boolean;
  resumeRequested?: boolean;
  resumed?: boolean;
  runReviewRequested?: boolean;
  runReviewed?: boolean;
  runReviewDenied?: boolean;
  runReviewClaimRequested?: boolean;
  runReviewClaimed?: boolean;
  runReviewClaimReleased?: boolean;
  deploymentRequested?: boolean;
  deployed?: boolean;
  deploymentDenied?: boolean;
  vasReviewRequested?: boolean;
  vasReviewed?: boolean;
  vasReviewDenied?: boolean;
  vasRunRequested?: boolean;
  vasRunStarted?: boolean;
  vasRunDenied?: boolean;
  vasClaimRequested?: boolean;
  vasClaimed?: boolean;
  vasClaimReleased?: boolean;
  vasClaimDenied?: boolean;
  synced?: number;
  skippedDuplicate?: number;
  followupRunId?: string;
  followupStatus?: string;
  expectedCheckpointVersion?: string;
  observedCheckpointVersion?: string;
  goal?: string;
  sourceStatus?: string;
  provider?: ControlPlaneProviderCatalogName;
  sourceProvider?: ControlPlaneProviderCatalogName;
  targetProvider?: ControlPlaneProviderCatalogName;
  format?: string;
  projectCount?: number;
  runCount?: number;
  auditEventCount?: number;
  secretScrubbed?: boolean;
  cutoverReady?: boolean;
  agentGitServiceProjectAgentsMissingProjects?: string[];
  agentGitServiceProjectAgentsMissingSecretProjects?: string[];
  agentLogin?: string;
  agentRepoFullName?: string;
  permission?: string;
  grantStatus?: string;
  tokenEnvName?: string;
  tokenMaterial?: string;
  receiptPath?: string;
  page?: string;
  sha?: string;
  url?: string;
  learningCount?: number;
  error?: string;
}

interface ProjectModelUsageSummary extends RunModelUsageSummary {
  runCount: number;
}

interface ProjectRequesterModelUsageSummary extends ProjectModelUsageSummary {
  requester: RunRequesterSummary;
}

interface ProjectModelUsageWarning {
  kind: "project_total_tokens" | "requester_total_tokens" | "project_cost_usd" | "requester_cost_usd";
  threshold: number;
  actual: number;
  requester?: RunRequesterSummary;
}

interface ProjectWorkspaceByteWarning {
  kind: "workspace_bytes" | "workspace_byte_limit";
  threshold: number;
  actual: number;
  limit?: number;
}

type ProjectQueuedRunSummary = QueuedRunResourceStatus;

type ProjectConcurrencyState = "active" | "queued" | "contended";

interface ProjectConcurrencySummary {
  state: ProjectConcurrencyState;
  runningRunId?: string;
  activeRunDetails?: ActiveRunResourceStatus[];
  queuedRunCount?: number;
  activeWorkspaceSessions?: number;
  activeProjectCollaboratorCount?: number;
  activeRunCollaboratorCount?: number;
  workspaceConflictCount?: number;
  latestWorkspaceConflict?: ProjectWorkspaceActivitySummary;
}

interface ProjectSummary {
  project: string;
  runCount: number;
  template?: ProjectTemplateName;
  defaultSkills?: string[];
  runPolicy?: ProjectTemplateRunPolicy;
  contract?: ProjectTemplateContract;
  contractStatus?: ProjectTemplateContractStatus;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  issue?: string;
  latestRunId?: string;
  latestStatus?: RunSummary["status"] | "running" | "queued";
  latestStartedAt?: string;
  activityAt?: string;
  latestWorkspaceCommand?: WorkspaceCommandSummary;
  latestWorkspaceSession?: WorkspaceSessionSummary;
  latestWorkspaceActivity?: ProjectWorkspaceActivitySummary;
  workspaceConflictCount?: number;
  latestWorkspaceConflict?: ProjectWorkspaceActivitySummary;
  concurrency?: ProjectConcurrencySummary;
  latestControlActivity?: ProjectControlActivitySummary;
  activeWorkspaceSessions?: number;
  activeWorkspaceSessionDetails?: WorkspaceSessionSummary[];
  activeProjectCollaboratorCount?: number;
  activeProjectCollaborators?: RunPresenceEntry[];
  activeRunCollaboratorCount?: number;
  activeRunCollaborators?: RunPresenceEntry[];
  runningRunId?: string;
  queuedRunCount?: number;
  queuedRunIds?: string[];
  queuedRuns?: ProjectQueuedRunSummary[];
  reviewRequiredRunCount?: number;
  reviewRequiredRunIds?: string[];
  reviewRequiredRuns?: ProjectHumanGateRunSummary[];
  deploymentRequiredRunCount?: number;
  deploymentRequiredRunIds?: string[];
  deploymentRequiredRuns?: ProjectHumanGateRunSummary[];
  modelUsage?: ProjectModelUsageSummary;
  modelUsageByRequester?: ProjectRequesterModelUsageSummary[];
  modelUsageWarnings?: ProjectModelUsageWarning[];
  workspaceBytes?: number;
  workspaceByteLimit?: number;
  workspaceByteWarningThreshold?: number;
  workspaceByteWarnings?: ProjectWorkspaceByteWarning[];
  vasCaseCount?: number;
  vasNeedsReviewCaseCount?: number;
  vasReviewedRunCount?: number;
  vasUnreviewedRunCount?: number;
  controlPlane?: ProjectControlPlaneSummary;
}

interface ProjectControlPlaneSummary {
  provider: ControlPlaneProviderCatalogName;
  agentGitServiceProjectAgent?: AgentGitServiceProjectAgentSummary;
}

interface AgentGitServiceProjectAgentSummary {
  ready: boolean;
  receiptPresent: boolean;
  secretRootConfigured: boolean;
  secretStored: boolean;
  receiptPath?: string;
  agentLogin?: string;
  agentRepoFullName?: string;
  repo?: string;
  permission?: string;
  grantStatus?: string;
  tokenEnvName?: string;
}

interface ProjectDetail extends ProjectSummary {
  template: ProjectTemplateName;
  createdAt: string;
  activityAt: string;
}

type TenantAgentGitServiceProvisioningPlanMissing = "receipt" | "secret" | "secretRoot" | "repo";

interface TenantAgentGitServiceProvisioningPlanProject {
  project: string;
  ready: boolean;
  receiptPresent: boolean;
  secretRootConfigured: boolean;
  secretStored: boolean;
  repoConfigured: boolean;
  repo?: string;
  permission: NonNullable<ProvisionAgentGitServiceProjectAgentOptions["permission"]>;
  tokenEnvName: string;
  receiptPath?: string;
  agentLogin?: string;
  agentRepoFullName?: string;
  grantStatus?: string;
  missing: TenantAgentGitServiceProvisioningPlanMissing[];
  provisionCommandArgs?: string[];
}

interface TenantAgentGitServiceProvisioningPlan {
  schemaVersion: 1;
  tenant: string;
  provider: "agent-git-service";
  baseUrl?: string;
  projectCount: number;
  readyProjectCount: number;
  provisionedProjectCount: number;
  secretRootConfigured: boolean;
  secretStoredProjectCount: number;
  missingProjectCount: number;
  missingSecretProjectCount: number;
  repoConfiguredProjectCount: number;
  projects: TenantAgentGitServiceProvisioningPlanProject[];
}

type TenantAgentGitServiceProvisioningPlanApplyProjectStatus = "would-provision" | "provisioned" | "skipped" | "failed";

interface TenantAgentGitServiceProvisioningPlanApplyProject {
  project: string;
  status: TenantAgentGitServiceProvisioningPlanApplyProjectStatus;
  reason?: string;
  readyBefore?: boolean;
  readyAfter?: boolean;
  repo?: string;
  tokenEnvName?: string;
  receiptPath?: string;
  agentLogin?: string;
  agentRepoFullName?: string;
  grantStatus?: string;
  missing?: TenantAgentGitServiceProvisioningPlanMissing[];
  agentTokenSecret?: AgentGitServiceAgentTokenSecretEvidence;
  error?: string;
}

interface TenantAgentGitServiceProvisioningPlanApplyResult {
  schemaVersion: 1;
  tenant: string;
  provider: "agent-git-service";
  dryRun: boolean;
  eligibleOnly: boolean;
  tokenMaterial: "stored-only";
  projectCount: number;
  eligibleProjectCount: number;
  wouldProvisionProjectCount: number;
  provisionedProjectCount: number;
  skippedProjectCount: number;
  failedProjectCount: number;
  projects: TenantAgentGitServiceProvisioningPlanApplyProject[];
}

interface ProjectActivitySummary {
  activityAt: string;
  latestWorkspaceCommand?: WorkspaceCommandSummary;
  latestWorkspaceSession?: WorkspaceSessionSummary;
  latestWorkspaceActivity?: ProjectWorkspaceActivitySummary;
  workspaceConflictCount?: number;
  latestWorkspaceConflict?: ProjectWorkspaceActivitySummary;
  latestControlActivity?: ProjectControlActivitySummary;
}

function activeProjectWorkspaceSessionCount(activeSessions: Map<string, ActiveWorkspaceSession>, tenant: string, project: string): number {
  return [...activeSessions.values()].filter((session) =>
    session.status === "running" && session.context.tenant === tenant && session.context.project === project
  ).length;
}

function activeProjectWorkspaceSessionDetails(
  activeSessions: Map<string, ActiveWorkspaceSession>,
  tenant: string,
  project: string,
): WorkspaceSessionSummary[] {
  return [...activeSessions.values()]
    .filter((session) => session.status === "running" && session.context.tenant === tenant && session.context.project === project)
    .map((session) => compactWorkspaceSessionSummary({ ...session.summary, status: session.status }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId));
}

function activeProjectWorkspaceSessionSummary(
  activeSessions: Map<string, ActiveWorkspaceSession>,
  tenant: string,
  project: string,
): Partial<Pick<ProjectSummary, "activeWorkspaceSessionDetails">> {
  const sessions = activeProjectWorkspaceSessionDetails(activeSessions, tenant, project);
  if (!sessions.length) return {};
  return { activeWorkspaceSessionDetails: sessions };
}

async function readActiveProjectWorkspaceSessionDetails(
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  tenant: string,
  project: string,
): Promise<WorkspaceSessionSummary[]> {
  return (await readWorkspaceSessionSummaries(
    projectWorkspaceSessionRoot(workspaceRoot, tenant, project),
    activeSessions,
    { route: "project", tenant, project },
    options,
  )).filter((session) => session.status === "running");
}

function activeProjectWorkspaceSessionSummaryFromDetails(
  sessions: WorkspaceSessionSummary[],
): Partial<Pick<ProjectSummary, "activeWorkspaceSessionDetails">> {
  if (!sessions.length) return {};
  return { activeWorkspaceSessionDetails: sessions };
}

async function queuedProjectRunSummary(
  options: HarnessServerOptions,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  queuedRuns: QueuedRun[],
  tenant: string,
  project: string,
): Promise<Partial<Pick<ProjectSummary, "queuedRunCount" | "queuedRunIds" | "queuedRuns">>> {
  const projectQueuedRuns = queuedRuns.filter((run) => run.tenant === tenant && run.project === project);
  const queuedRunIds = projectQueuedRuns.map((run) => run.runId);
  if (!queuedRunIds.length) return {};
  const queuedRunDetails = await Promise.all(projectQueuedRuns.map((run) => queuedRunResourceStatus(options, activeRunSlots, activeWorkspaces, {
    tenant: run.tenant,
    project: run.project,
    runId: run.runId,
    goal: run.goal,
    queuedAt: run.status.queuedAt,
    ...queuedRunPositions(queuedRuns, run),
    runRoot: run.runRoot,
  })));
  return { queuedRunCount: queuedRunIds.length, queuedRunIds, queuedRuns: queuedRunDetails };
}

function projectModelUsageSummary(
  states: ReadableRunState[],
  policyLimits: TenantPolicyLimits | undefined,
): Partial<Pick<ProjectSummary, "modelUsage" | "modelUsageByRequester" | "modelUsageWarnings">> {
  const total: ProjectModelUsageSummary = { runCount: 0, requestCount: 0 };
  const byRequester = new Map<string, ProjectRequesterModelUsageSummary>();
  for (const state of states) {
    const usage = projectRunModelUsage(state);
    if (!usage) continue;
    addProjectModelUsage(total, usage);
    const requester = state.requester ?? {};
    const key = projectModelUsageRequesterKey(requester);
    let requesterUsage = byRequester.get(key);
    if (!requesterUsage) {
      requesterUsage = { requester, runCount: 0, requestCount: 0 };
      byRequester.set(key, requesterUsage);
    }
    addProjectModelUsage(requesterUsage, usage);
  }
  if (!total.runCount) return {};
  const modelUsageByRequester = [...byRequester.values()]
    .sort(compareProjectRequesterModelUsage)
    .map(compactProjectRequesterModelUsage);
  const modelUsage = compactProjectModelUsage(total);
  return {
    modelUsage,
    modelUsageByRequester: modelUsageByRequester.length ? modelUsageByRequester : undefined,
    modelUsageWarnings: projectModelUsageWarnings(modelUsage, modelUsageByRequester, policyLimits),
  };
}

function projectModelUsageWarnings(
  modelUsage: ProjectModelUsageSummary,
  modelUsageByRequester: ProjectRequesterModelUsageSummary[],
  policyLimits: TenantPolicyLimits | undefined,
): ProjectModelUsageWarning[] | undefined {
  const warnings: ProjectModelUsageWarning[] = [];
  const projectThreshold = policyLimits?.modelProjectTotalTokenWarning;
  if (projectThreshold !== undefined && (modelUsage.totalTokens ?? 0) > projectThreshold) {
    warnings.push({
      kind: "project_total_tokens",
      threshold: projectThreshold,
      actual: modelUsage.totalTokens ?? 0,
    });
  }
  const requesterThreshold = policyLimits?.modelRequesterTotalTokenWarning;
  if (requesterThreshold !== undefined) {
    for (const entry of modelUsageByRequester) {
      const totalTokens = entry.totalTokens ?? 0;
      if (totalTokens <= requesterThreshold) continue;
      warnings.push({
        kind: "requester_total_tokens",
        threshold: requesterThreshold,
        actual: totalTokens,
        requester: entry.requester,
      });
    }
  }
  const projectCostThreshold = policyLimits?.modelProjectCostUsdWarning;
  if (projectCostThreshold !== undefined && (modelUsage.costUsd ?? 0) > projectCostThreshold) {
    warnings.push({
      kind: "project_cost_usd",
      threshold: projectCostThreshold,
      actual: modelUsage.costUsd ?? 0,
    });
  }
  const requesterCostThreshold = policyLimits?.modelRequesterCostUsdWarning;
  if (requesterCostThreshold !== undefined) {
    for (const entry of modelUsageByRequester) {
      const costUsd = entry.costUsd ?? 0;
      if (costUsd <= requesterCostThreshold) continue;
      warnings.push({
        kind: "requester_cost_usd",
        threshold: requesterCostThreshold,
        actual: costUsd,
        requester: entry.requester,
      });
    }
  }
  return warnings.length ? warnings : undefined;
}

async function projectWorkspaceUsageSummary(
  projectRoot: string,
  policyLimits: TenantPolicyLimits | undefined,
): Promise<Partial<Pick<ProjectSummary, "workspaceBytes" | "workspaceByteLimit" | "workspaceByteWarningThreshold" | "workspaceByteWarnings">>> {
  const workspaceByteLimit = policyLimits?.maxWorkspaceBytes;
  const workspaceByteWarningThreshold = policyLimits?.workspaceByteWarning;
  if (workspaceByteLimit === undefined && workspaceByteWarningThreshold === undefined) return {};
  const workspaceBytes = await workspaceDirectoryUsageBytes(projectRoot);
  return compactObject({
    workspaceBytes,
    workspaceByteLimit,
    workspaceByteWarningThreshold,
    workspaceByteWarnings: projectWorkspaceByteWarnings(workspaceBytes, workspaceByteLimit, workspaceByteWarningThreshold),
  });
}

function projectWorkspaceByteWarnings(
  workspaceBytes: number,
  workspaceByteLimit: number | undefined,
  workspaceByteWarningThreshold: number | undefined,
): ProjectWorkspaceByteWarning[] | undefined {
  const warnings: ProjectWorkspaceByteWarning[] = [];
  if (workspaceByteWarningThreshold !== undefined && workspaceBytes > workspaceByteWarningThreshold) {
    warnings.push({
      kind: "workspace_bytes",
      threshold: workspaceByteWarningThreshold,
      actual: workspaceBytes,
      limit: workspaceByteLimit,
    });
  }
  if (workspaceByteLimit !== undefined && workspaceBytes >= workspaceByteLimit) {
    warnings.push({
      kind: "workspace_byte_limit",
      threshold: workspaceByteLimit,
      actual: workspaceBytes,
      limit: workspaceByteLimit,
    });
  }
  return warnings.length ? warnings : undefined;
}

function projectRunModelUsage(state: ReadableRunState): RunModelUsageSummary | undefined {
  if (!isRunSummaryState(state)) return undefined;
  const usage = state.modelUsage;
  if (!usage || typeof usage.requestCount !== "number" || !Number.isFinite(usage.requestCount) || usage.requestCount < 0) return undefined;
  return usage;
}

function addProjectModelUsage(target: ProjectModelUsageSummary, usage: RunModelUsageSummary): void {
  target.runCount += 1;
  target.requestCount += usage.requestCount;
  addProjectModelUsageToken(target, "promptTokens", usage.promptTokens);
  addProjectModelUsageToken(target, "completionTokens", usage.completionTokens);
  addProjectModelUsageToken(target, "totalTokens", usage.totalTokens);
  addProjectModelUsageToken(target, "costUsd", usage.costUsd);
}

function addProjectModelUsageToken(
  target: ProjectModelUsageSummary,
  key: "promptTokens" | "completionTokens" | "totalTokens" | "costUsd",
  value: number | undefined,
): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
  const next = (target[key] ?? 0) + value;
  target[key] = key === "costUsd" ? Math.round(next * 1_000_000_000_000) / 1_000_000_000_000 : next;
}

function compactProjectModelUsage(summary: ProjectModelUsageSummary): ProjectModelUsageSummary {
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined)) as ProjectModelUsageSummary;
}

function compactProjectRequesterModelUsage(summary: ProjectRequesterModelUsageSummary): ProjectRequesterModelUsageSummary {
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined)) as ProjectRequesterModelUsageSummary;
}

function projectModelUsageRequesterKey(requester: RunRequesterSummary): string {
  return JSON.stringify([requester.actor ?? "", requester.role ?? "", requester.clientId ?? ""]);
}

function compareProjectRequesterModelUsage(a: ProjectRequesterModelUsageSummary, b: ProjectRequesterModelUsageSummary): number {
  const total = (b.totalTokens ?? 0) - (a.totalTokens ?? 0);
  if (total) return total;
  const cost = (b.costUsd ?? 0) - (a.costUsd ?? 0);
  if (cost) return cost;
  const requests = b.requestCount - a.requestCount;
  if (requests) return requests;
  return projectModelUsageRequesterLabel(a.requester).localeCompare(projectModelUsageRequesterLabel(b.requester));
}

function projectModelUsageRequesterLabel(requester: RunRequesterSummary): string {
  return requester.actor ?? requester.clientId ?? "unknown";
}

function activeProjectCollaboratorSummary(
  presence: RunPresenceRegistry,
  tenant: string,
  project: string,
): Partial<Pick<ProjectSummary, "activeProjectCollaboratorCount" | "activeProjectCollaborators">> {
  purgeExpiredRunPresence(presence);
  const collaborators = projectPresenceEntries(presence, tenant, project);
  if (!collaborators.length) return {};
  return {
    activeProjectCollaboratorCount: collaborators.length,
    activeProjectCollaborators: collaborators,
  };
}

async function agentGitServiceProjectAgentsReadiness(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenantScope?: string,
): Promise<Omit<HarnessProfileReadiness["checks"]["agentGitServiceProjectAgents"], "required">> {
  return agentGitServiceProjectAgentsReadinessForProvider(workspaceRoot, options, controlPlaneProviderName(options), tenantScope);
}

async function agentGitServiceProjectAgentsReadinessForProvider(
  workspaceRoot: string,
  options: HarnessServerOptions,
  provider: ControlPlaneProviderCatalogName,
  tenantScope?: string,
): Promise<Omit<HarnessProfileReadiness["checks"]["agentGitServiceProjectAgents"], "required">> {
  if (provider !== "agent-git-service") {
    return {
      ok: true,
      provider,
      tenantCount: 0,
      projectCount: 0,
      provisionedProjectCount: 0,
      secretRootConfigured: false,
      secretStoredProjectCount: 0,
      missingProjects: [],
      missingSecretProjects: [],
    };
  }

  const projects: Array<{ tenant: string; project: string; ref: string }> = [];
  for (const tenant of tenantScope ? [tenantScope] : await listWorkspaceTenantNames(workspaceRoot)) {
    for (const project of await listTenantProjectNames(workspaceRoot, tenant)) {
      projects.push({ tenant, project, ref: `${tenant}/${project}` });
    }
  }

  const projectTenants = new Set(projects.map((project) => project.tenant));
  const secretRootConfigured = Boolean(options.agentGitServiceTokenSecretRoot?.trim());
  const missingProjects: string[] = [];
  const missingSecretProjects: string[] = [];
  let provisionedProjectCount = 0;
  let secretStoredProjectCount = 0;

  for (const project of projects) {
    const receipt = await readAgentGitServiceProjectProvisioningReceipt(workspaceRoot, project.tenant, project.project);
    if (!receipt) {
      missingProjects.push(project.ref);
      continue;
    }
    provisionedProjectCount += 1;
    const secret = secretRootConfigured
      ? await readAgentGitServiceAgentTokenSecret(options.agentGitServiceTokenSecretRoot as string, project.tenant, project.project, receipt.tokenEnvName)
      : undefined;
    if (secret === undefined) {
      missingSecretProjects.push(project.ref);
    } else {
      secretStoredProjectCount += 1;
    }
  }

  return {
    ok: missingProjects.length === 0 && missingSecretProjects.length === 0,
    provider,
    tenantCount: projectTenants.size,
    projectCount: projects.length,
    provisionedProjectCount,
    secretRootConfigured,
    secretStoredProjectCount,
    missingProjects,
    missingSecretProjects,
  };
}

async function handleReadTenantAgentGitServiceProvisioningPlan(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (
    segments[0] !== "tenants" ||
    segments[2] !== "control-plane" ||
    segments[3] !== "agent-git-service" ||
    segments[4] !== "provisioning-plan"
  ) {
    return false;
  }

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url, "admin");
  writeJson(res, 200, await tenantAgentGitServiceProvisioningPlan(workspaceRoot, tenant, options));
  return true;
}

async function handleApplyTenantAgentGitServiceProvisioningPlan(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 6) return false;
  if (
    segments[0] !== "tenants" ||
    segments[2] !== "control-plane" ||
    segments[3] !== "agent-git-service" ||
    segments[4] !== "provisioning-plan" ||
    segments[5] !== "apply"
  ) {
    return false;
  }

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const body = await readAgentGitServiceProvisioningPlanApplyJson(req);
  const result = await applyTenantAgentGitServiceProvisioningPlan(workspaceRoot, tenant, options, body, access, appendAuditEvent);
  writeJson(res, 200, result);
  return true;
}

function projectWorkspaceSessionRoot(workspaceRoot: string, tenant: string, project: string): string {
  return join(workspaceRoot, tenant, project, ".loom", "sessions");
}

function projectWorkspaceCommandRoot(workspaceRoot: string, tenant: string, project: string): string {
  return join(workspaceRoot, tenant, project, ".loom", "commands");
}

async function handleReadProjectWorkspaceInfo(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "workspace") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  await requireProjectExists(workspaceRoot, tenant, project);
  writeJson(
    res,
    200,
    await workspaceInfo(projectWorkspaceContext(workspaceRoot, tenant, project, "workspace-info"), { kind: "project" }, options),
  );
  return true;
}

async function handleReadProjectWorkspaceDiff(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "diff") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  await requireTenantTool(options, tenant, "git.diff", "workspace diffs require git.diff to be allowed by the server.");
  const project = requireSafeName(segments[3], "project");
  await requireProjectExists(workspaceRoot, tenant, project);
  writeJson(res, 200, await workspaceDiff(projectWorkspaceContext(workspaceRoot, tenant, project, "workspace-diff"), options));
  return true;
}

async function handleCreateProject(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const body = await readProjectCreateJson(req);
  const project = requireProjectName(body.project, "project");
  const template = projectTemplateName(body.template);
  const sourceDefaults = projectSourceDefaultsFromBody(body);
  const defaultSkills = body.defaultSkills === undefined ? undefined : projectDefaultSkillsFromBody(body);
  const runPolicy = projectRunPolicyRequestHasContent(body) ? projectRunPolicyFromBody(body) : undefined;
  if (runPolicy?.preset === VAS_LITE_REVIEW_PRESET && template !== "vas-lite") {
    throw badRequest("vas-lite-review policy requires a vas-lite project template.");
  }
  const contract = projectContractRequestHasContent(body) ? projectContractFromBody(body) : undefined;
  const clientId = optionalClientId(body.clientId);
  const tenantRoot = join(workspaceRoot, tenant);
  const projectRoot = join(tenantRoot, project);

  await mkdir(tenantRoot, { recursive: true });
  try {
    await mkdir(projectRoot);
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw conflict(`tenant project already exists: ${project}`);
    }
    throw error;
  }
  await seedProjectTemplate(projectRoot, { tenant, project, template, sourceDefaults });
  if (defaultSkills !== undefined) await updateProjectTemplateDefaultSkills(projectRoot, { tenant, project }, defaultSkills);
  if (runPolicy !== undefined) await updateProjectTemplateRunPolicy(projectRoot, { tenant, project }, runPolicy);
  if (contract !== undefined) await updateProjectTemplateContract(projectRoot, { tenant, project }, contract);
  await writeProjectSourceDefaults(tenantRoot, project, sourceDefaults);

  await appendAuditEvent(tenant, "project_created", compactObject({
    project,
    template: template === "empty" ? undefined : template,
    ...sourceDefaults,
    defaultSkills,
    runPolicy,
    contract,
    clientId,
  }), access);
  writeJson(res, 201, await readProjectSummaryWithAuditActivity(workspaceRoot, options, tenantRoot, tenant, project));
  return true;
}

async function handleProvisionAgentGitServiceProjectAgent(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 7) return false;
  if (
    segments[0] !== "tenants" ||
    segments[2] !== "projects" ||
    segments[4] !== "control-plane" ||
    segments[5] !== "agent-git-service" ||
    segments[6] !== "provision"
  ) {
    return false;
  }

  const tenant = requireSafeName(segments[1], "tenant");
  const project = requireProjectName(segments[3], "project");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  if ((options.controlPlaneProvider ?? "gitea-forgejo") !== "agent-git-service") {
    throw badRequest("agent-git-service provisioning requires --control-plane-provider agent-git-service.");
  }
  const baseUrl = optionalString(options.controlPlaneBaseUrl, "controlPlaneBaseUrl")?.trim();
  if (!baseUrl) {
    throw badRequest("agent-git-service provisioning requires a configured control-plane URL.");
  }
  const adminToken = agentGitServiceProvisioningToken(options, tenant);
  await requireProjectMetadata(workspaceRoot, tenant, project);

  const body = await readAgentGitServiceProjectProvisionJson(req);
  const force = optionalBoolean(body.force, "force") ?? false;
  const storeAgentToken = optionalBoolean(body.storeAgentToken, "storeAgentToken") ?? false;
  const tokenEnvName = envNameValue(body.tokenEnvName, "tokenEnvName");
  if (storeAgentToken && !options.agentGitServiceTokenSecretRoot?.trim()) {
    throw badRequest("storeAgentToken requires --agent-git-service-token-secret-root.");
  }
  const existing = await readAgentGitServiceProjectProvisioningReceipt(workspaceRoot, tenant, project);
  if (existing && !force) {
    writeJson(res, 409, {
      error: "agent-git-service project agent is already provisioned.",
      receiptPath: AGENT_GIT_SERVICE_PROJECT_PROVISIONING_RECEIPT_PATH,
      receipt: existing,
    });
    return true;
  }
  const clientId = optionalClientId(body.clientId);
  const controlPlaneIdentityRequest = agentGitServiceProvisioningControlPlaneIdentityRequest(body.controlPlaneIdentity);
  const result = await provisionAgentGitServiceProjectAgent({
    workspaceRoot,
    tenant,
    project,
    baseUrl,
    adminToken,
    repo: agentGitServiceProvisioningRepo(body.repo),
    agentPrefixLogin: optionalSafeName(body.agentPrefixLogin, "agentPrefixLogin"),
    defaultRepoName: optionalSafeName(body.defaultRepoName, "defaultRepoName"),
    permission: agentGitServiceProvisioningPermission(body.permission),
    tokenEnvName,
    createAgent: options.agentGitServiceCreateAgent,
    grantRepoAccess: options.agentGitServiceGrantRepoAccess,
  });
  const agentTokenSecret = storeAgentToken
    ? await writeAgentGitServiceAgentTokenSecret(options.agentGitServiceTokenSecretRoot!, tenant, project, tokenEnvName, result.agentToken)
    : undefined;
  const controlPlaneIdentity = controlPlaneIdentityRequest === undefined
    ? undefined
    : agentGitServiceProvisioningControlPlaneIdentity(controlPlaneIdentityRequest, result.receipt.agentLogin);
  if (controlPlaneIdentity) {
    const { policy, policyChange } = await upsertTenantControlPlaneIdentity(workspaceRoot, tenant, controlPlaneIdentity, options);
    if (policyChange) {
      await appendAuditEvent(tenant, "tenant_policy_updated", compactObject({
        ...tenantPolicyAuditData(policy),
        policyChange,
        clientId,
      }), access);
    }
  }

  await appendAuditEvent(tenant, "agent_git_service_project_agent_provisioned", agentGitServiceProjectProvisioningAuditData(result, clientId, controlPlaneIdentity, agentTokenSecret), access);
  writeJson(res, 201, compactObject({
    receiptPath: AGENT_GIT_SERVICE_PROJECT_PROVISIONING_RECEIPT_PATH,
    receipt: result.receipt,
    agentToken: agentTokenSecret === undefined ? result.agentToken : undefined,
    agentTokenSecret,
  }));
  return true;
}

async function handleReadAgentGitServiceProjectProvisioningReceipt(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 7) return false;
  if (
    segments[0] !== "tenants" ||
    segments[2] !== "projects" ||
    segments[4] !== "control-plane" ||
    segments[5] !== "agent-git-service" ||
    segments[6] !== "provision"
  ) {
    return false;
  }

  const tenant = requireSafeName(segments[1], "tenant");
  const project = requireProjectName(segments[3], "project");
  await requireTenantAccess(req, tenant, options, url);
  await requireProjectMetadata(workspaceRoot, tenant, project);
  const receipt = await readAgentGitServiceProjectProvisioningReceipt(workspaceRoot, tenant, project);
  if (!receipt) throw notFound("agent-git-service project agent provisioning receipt not found");
  writeJson(res, 200, {
    receiptPath: AGENT_GIT_SERVICE_PROJECT_PROVISIONING_RECEIPT_PATH,
    receipt,
  });
  return true;
}

function agentGitServiceProvisioningToken(options: HarnessServerOptions, tenant: string): string {
  const token = options.controlPlaneTenantTokens?.[tenant] ?? options.controlPlaneAdminToken;
  if (!token?.trim()) {
    throw badRequest("agent-git-service provisioning requires a configured control-plane token.");
  }
  return token;
}

async function writeAgentGitServiceAgentTokenSecret(
  secretRoot: string,
  tenant: string,
  project: string,
  tokenEnvName: string,
  agentToken: string,
): Promise<AgentGitServiceAgentTokenSecretEvidence> {
  const secretRef = posix.join(tenant, project, tokenEnvName);
  const secretRootPath = resolve(secretRoot);
  const secretPath = resolve(secretRootPath, tenant, project, tokenEnvName);
  if (!secretPath.startsWith(`${secretRootPath}/`)) {
    throw badRequest("agent-git-service token secret path escapes the configured secret root.");
  }
  await mkdir(dirname(secretPath), { recursive: true, mode: 0o700 });
  await writeFile(secretPath, `${agentToken}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(secretPath, 0o600);
  return { stored: true, tokenEnvName, secretRef };
}

function agentGitServiceProvisioningPermission(value: unknown): ProvisionAgentGitServiceProjectAgentOptions["permission"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "read" || value === "write" || value === "admin") return value;
  throw badRequest("permission must be read, write, or admin.");
}

function agentGitServiceProvisioningRepo(value: unknown): string {
  const repo = requireString(value, "repo");
  try {
    parseAgentGitServiceRepoRef(repo);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw badRequest(message);
  }
  return repo;
}

function agentGitServiceProvisioningControlPlaneIdentityRequest(value: unknown): AgentGitServiceProvisioningControlPlaneIdentityRequest | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("controlPlaneIdentity must be an object.");
  }
  const input = value as Record<string, unknown>;
  return {
    actor: input.actor === undefined ? undefined : tenantPolicyApiKeyActor(input.actor),
    role: tenantPolicyRole(input.role, "controlPlaneIdentity.role"),
  };
}

function agentGitServiceProvisioningControlPlaneIdentity(
  request: AgentGitServiceProvisioningControlPlaneIdentityRequest,
  agentLogin: string,
): TenantControlPlaneIdentity {
  return {
    provider: "agent-git-service",
    externalActor: tenantPolicyControlPlaneIdentityActor(agentLogin, "controlPlaneIdentity.externalActor"),
    actor: request.actor ?? tenantPolicyApiKeyActor(agentLogin),
    role: request.role,
  };
}

function agentGitServiceProjectProvisioningAuditData(
  result: AgentGitServiceProjectProvisioningResult,
  clientId: string | undefined,
  controlPlaneIdentity?: TenantControlPlaneIdentity,
  agentTokenSecret?: AgentGitServiceAgentTokenSecretEvidence,
): Record<string, unknown> {
  return compactObject({
    provider: result.receipt.provider,
    project: result.receipt.project,
    repo: result.receipt.repo,
    agentLogin: result.receipt.agentLogin,
    agentRepoFullName: result.receipt.agentRepoFullName,
    permission: result.receipt.permission,
    grantStatus: result.receipt.grantStatus,
    grantInvitationId: result.receipt.grantInvitationId,
    grantUrl: result.receipt.grantUrl,
    tokenEnvName: result.receipt.tokenEnvName,
    tokenMaterial: result.receipt.tokenMaterial,
    agentTokenSecret,
    controlPlaneIdentity: controlPlaneIdentity === undefined ? undefined : sanitizeTenantControlPlaneIdentity(controlPlaneIdentity),
    receiptPath: AGENT_GIT_SERVICE_PROJECT_PROVISIONING_RECEIPT_PATH,
    clientId,
  });
}

async function handleUpdateProjectSourceDefaults(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "source-defaults") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const project = requireProjectName(segments[3], "project");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const body = await readProjectSourceDefaultsJson(req);
  const sourceDefaults = projectSourceDefaultsFromBody(body);
  const clientId = optionalClientId(body.clientId);
  const tenantRoot = join(workspaceRoot, tenant);
  const projectRoot = join(tenantRoot, project);

  try {
    await readdir(projectRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) throw notFound("project not found");
    throw error;
  }

  await writeProjectSourceDefaults(tenantRoot, project, sourceDefaults);
  await appendAuditEvent(tenant, "project_source_defaults_updated", compactObject({
    project,
    ...sourceDefaults,
    cleared: Object.keys(sourceDefaults).length ? undefined : true,
    clientId,
  }), access);
  writeJson(res, 200, await readProjectSummaryWithAuditActivity(workspaceRoot, options, tenantRoot, tenant, project));
  return true;
}

async function handleUpdateProjectDefaultSkills(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "default-skills") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const project = requireProjectName(segments[3], "project");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const body = await readProjectDefaultSkillsJson(req);
  const defaultSkills = projectDefaultSkillsFromBody(body);
  const clientId = optionalClientId(body.clientId);
  const tenantRoot = join(workspaceRoot, tenant);
  const projectRoot = join(tenantRoot, project);
  const metadata = await updateProjectTemplateDefaultSkills(projectRoot, { tenant, project }, defaultSkills);
  if (!metadata) throw notFound("project not found");

  await appendAuditEvent(tenant, "project_default_skills_updated", compactObject({
    project,
    defaultSkills,
    cleared: defaultSkills.length ? undefined : true,
    clientId,
  }), access);
  writeJson(res, 200, await readProjectSummaryWithAuditActivity(workspaceRoot, options, tenantRoot, tenant, project));
  return true;
}

async function handleUpdateProjectRunPolicy(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "run-policy") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const project = requireProjectName(segments[3], "project");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const body = await readProjectRunPolicyJson(req);
  const runPolicy = projectRunPolicyFromBody(body);
  const clientId = optionalClientId(body.clientId);
  const tenantRoot = join(workspaceRoot, tenant);
  const projectRoot = join(tenantRoot, project);
  const metadata = await readProjectTemplateMetadata(projectRoot, { tenant, project });
  if (!metadata) throw notFound("project not found");
  if (runPolicy?.preset === VAS_LITE_REVIEW_PRESET && metadata.template !== "vas-lite") {
    throw badRequest("vas-lite-review policy requires a vas-lite project template.");
  }
  const updated = await updateProjectTemplateRunPolicy(projectRoot, { tenant, project }, runPolicy);
  if (!updated) throw notFound("project not found");

  await appendAuditEvent(tenant, "project_run_policy_updated", compactObject({
    project,
    runPolicy,
    cleared: runPolicy ? undefined : true,
    clientId,
  }), access);
  writeJson(res, 200, await readProjectSummaryWithAuditActivity(workspaceRoot, options, tenantRoot, tenant, project));
  return true;
}

async function handleUpdateProjectContract(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "contract") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const project = requireProjectName(segments[3], "project");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const body = await readProjectContractJson(req);
  const contract = projectContractFromBody(body);
  const clientId = optionalClientId(body.clientId);
  const tenantRoot = join(workspaceRoot, tenant);
  const projectRoot = join(tenantRoot, project);
  const updated = await updateProjectTemplateContract(projectRoot, { tenant, project }, contract);
  if (!updated) throw notFound("project not found");

  await appendAuditEvent(tenant, "project_contract_updated", compactObject({
    project,
    contract,
    cleared: contract ? undefined : true,
    clientId,
  }), access);
  writeJson(res, 200, await readProjectSummaryWithAuditActivity(workspaceRoot, options, tenantRoot, tenant, project));
  return true;
}

async function handleListProjects(
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
  if (segments.length !== 3) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);

  try {
    writeJson(res, 200, await readTenantProjectSummariesWithActivity(workspaceRoot, options, tenant, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, projectPresence, runPresence));
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 200, []);
      return true;
    }
    throw error;
  }
}

async function readTenantProjectSummariesWithActivity(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenant: string,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  queuedRuns: QueuedRun[],
  projectPresence: RunPresenceRegistry,
  runPresence: RunPresenceRegistry,
): Promise<ProjectSummary[]> {
  const tenantRoot = join(workspaceRoot, tenant);
  const projectNames = await listTenantProjectNames(workspaceRoot, tenant);
  const tenantAuditEvents = await readTenantAuditEvents(workspaceRoot, tenant, options.stateBackend?.events);
  const policyLimits = (await readTenantPolicy(workspaceRoot, tenant, options))?.limits;
  const activeRunDetails = await statusActiveRunDetails(workspaceRoot, options, activeRunSlots, tenant);
  const projects = await Promise.all(
    projectNames.map((project) => readProjectSummaryWithActivity(workspaceRoot, options, tenantRoot, tenant, project, activeRunDetails, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, projectPresence, runPresence, tenantAuditEvents, policyLimits)),
  );
  projects.sort((a, b) => a.project.localeCompare(b.project));
  return projects;
}

async function tenantAgentGitServiceProvisioningPlan(
  workspaceRoot: string,
  tenant: string,
  options: HarnessServerOptions,
): Promise<TenantAgentGitServiceProvisioningPlan> {
  if (controlPlaneProviderName(options) !== "agent-git-service") {
    throw badRequest("agent-git-service provisioning plan requires --control-plane-provider agent-git-service.");
  }
  const rawBaseUrl = optionalString(options.controlPlaneBaseUrl, "controlPlaneBaseUrl")?.trim();
  const projectNames = await listTenantProjectNames(workspaceRoot, tenant);
  projectNames.sort((a, b) => a.localeCompare(b));
  const secretRootConfigured = Boolean(options.agentGitServiceTokenSecretRoot?.trim());
  const projects = await Promise.all(
    projectNames.map((project) => tenantAgentGitServiceProvisioningPlanProject(workspaceRoot, tenant, project, options, secretRootConfigured)),
  );
  return {
    schemaVersion: 1,
    tenant,
    provider: "agent-git-service",
    baseUrl: rawBaseUrl ? publicControlPlaneBaseUrl(rawBaseUrl) : undefined,
    projectCount: projects.length,
    readyProjectCount: projects.filter((project) => project.ready).length,
    provisionedProjectCount: projects.filter((project) => project.receiptPresent).length,
    secretRootConfigured,
    secretStoredProjectCount: projects.filter((project) => project.secretStored).length,
    missingProjectCount: projects.filter((project) => !project.receiptPresent).length,
    missingSecretProjectCount: projects.filter((project) => project.receiptPresent && !project.secretStored).length,
    repoConfiguredProjectCount: projects.filter((project) => project.repoConfigured).length,
    projects,
  };
}

async function applyTenantAgentGitServiceProvisioningPlan(
  workspaceRoot: string,
  tenant: string,
  options: HarnessServerOptions,
  body: AgentGitServiceProvisioningPlanApplyRequestBody,
  access: TenantAccess | undefined,
  appendAuditEvent: TenantAuditAppender,
): Promise<TenantAgentGitServiceProvisioningPlanApplyResult> {
  const dryRun = optionalBoolean(body.dryRun, "dryRun") ?? false;
  const eligibleOnly = optionalBoolean(body.eligibleOnly, "eligibleOnly") ?? false;
  const clientId = optionalClientId(body.clientId);
  const requestedProjects = agentGitServiceProvisioningPlanApplyProjects(body.projects);
  const plan = await tenantAgentGitServiceProvisioningPlan(workspaceRoot, tenant, options);
  const planProjects = new Map(plan.projects.map((project) => [project.project, project]));
  const selectedProjects = (requestedProjects ?? plan.projects.map((project) => project.project))
    .filter((projectName) => {
      if (!eligibleOnly) return true;
      const planProject = planProjects.get(projectName);
      return planProject ? agentGitServiceProvisioningPlanProjectIsEligible(planProject) : false;
    });
  const baseUrl = optionalString(options.controlPlaneBaseUrl, "controlPlaneBaseUrl")?.trim();
  const secretRoot = options.agentGitServiceTokenSecretRoot?.trim();
  const adminToken = dryRun ? undefined : agentGitServiceProvisioningToken(options, tenant);
  if (!dryRun && !baseUrl) {
    throw badRequest("agent-git-service provisioning plan apply requires a configured control-plane URL.");
  }
  if (!dryRun && !secretRoot) {
    throw badRequest("agent-git-service provisioning plan apply requires --agent-git-service-token-secret-root.");
  }

  const projects: TenantAgentGitServiceProvisioningPlanApplyProject[] = [];
  for (const projectName of selectedProjects) {
    const planProject = planProjects.get(projectName);
    if (!planProject) {
      projects.push({
        project: projectName,
        status: "skipped",
        reason: "project not registered",
      });
      continue;
    }
    if (!agentGitServiceProvisioningPlanProjectIsEligible(planProject)) {
      projects.push(compactObject({
        project: planProject.project,
        status: "skipped" as const,
        reason: agentGitServiceProvisioningPlanProjectSkipReason(planProject),
        readyBefore: planProject.ready,
        readyAfter: planProject.ready,
        repo: planProject.repo,
        tokenEnvName: planProject.tokenEnvName,
        receiptPath: planProject.receiptPath,
        agentLogin: planProject.agentLogin,
        agentRepoFullName: planProject.agentRepoFullName,
        grantStatus: planProject.grantStatus,
        missing: planProject.missing,
      }) as TenantAgentGitServiceProvisioningPlanApplyProject);
      continue;
    }
    if (dryRun) {
      projects.push(compactObject({
        project: planProject.project,
        status: "would-provision" as const,
        readyBefore: planProject.ready,
        readyAfter: false,
        repo: planProject.repo,
        tokenEnvName: planProject.tokenEnvName,
        missing: planProject.missing,
      }) as TenantAgentGitServiceProvisioningPlanApplyProject);
      continue;
    }

    try {
      const result = await provisionAgentGitServiceProjectAgent({
        workspaceRoot,
        tenant,
        project: planProject.project,
        baseUrl: baseUrl as string,
        adminToken: adminToken as string,
        repo: planProject.repo as string,
        permission: planProject.permission,
        tokenEnvName: planProject.tokenEnvName,
        createAgent: options.agentGitServiceCreateAgent,
        grantRepoAccess: options.agentGitServiceGrantRepoAccess,
      });
      const agentTokenSecret = await writeAgentGitServiceAgentTokenSecret(secretRoot as string, tenant, planProject.project, planProject.tokenEnvName, result.agentToken);
      await appendAuditEvent(tenant, "agent_git_service_project_agent_provisioned", agentGitServiceProjectProvisioningAuditData(result, clientId, undefined, agentTokenSecret), access);
      projects.push(compactObject({
        project: planProject.project,
        status: "provisioned" as const,
        readyBefore: planProject.ready,
        readyAfter: true,
        repo: result.receipt.repo,
        tokenEnvName: result.receipt.tokenEnvName,
        receiptPath: AGENT_GIT_SERVICE_PROJECT_PROVISIONING_RECEIPT_PATH,
        agentLogin: result.receipt.agentLogin,
        agentRepoFullName: result.receipt.agentRepoFullName,
        grantStatus: result.receipt.grantStatus,
        agentTokenSecret,
      }) as TenantAgentGitServiceProvisioningPlanApplyProject);
    } catch (error) {
      projects.push(compactObject({
        project: planProject.project,
        status: "failed" as const,
        readyBefore: planProject.ready,
        readyAfter: false,
        repo: planProject.repo,
        tokenEnvName: planProject.tokenEnvName,
        missing: planProject.missing,
        error: error instanceof Error ? error.message : String(error),
      }) as TenantAgentGitServiceProvisioningPlanApplyProject);
    }
  }

  const result: TenantAgentGitServiceProvisioningPlanApplyResult = {
    schemaVersion: 1,
    tenant,
    provider: "agent-git-service",
    dryRun,
    eligibleOnly,
    tokenMaterial: "stored-only",
    projectCount: projects.length,
    eligibleProjectCount: projects.filter((project) => project.status === "would-provision" || project.status === "provisioned" || project.status === "failed").length,
    wouldProvisionProjectCount: projects.filter((project) => project.status === "would-provision").length,
    provisionedProjectCount: projects.filter((project) => project.status === "provisioned").length,
    skippedProjectCount: projects.filter((project) => project.status === "skipped").length,
    failedProjectCount: projects.filter((project) => project.status === "failed").length,
    projects,
  };
  if (!dryRun) {
    await appendAuditEvent(tenant, "agent_git_service_tenant_provisioning_plan_applied", agentGitServiceProvisioningPlanApplyAuditData(result, clientId), access);
  }
  return result;
}

function agentGitServiceProvisioningPlanProjectIsEligible(project: TenantAgentGitServiceProvisioningPlanProject): boolean {
  return Boolean(project.repo && Array.isArray(project.provisionCommandArgs) && project.provisionCommandArgs.length);
}

function agentGitServiceProvisioningPlanProjectSkipReason(project: TenantAgentGitServiceProvisioningPlanProject): string {
  if (project.ready) return "ready";
  if (!project.repoConfigured) return "repo missing";
  if (!project.secretRootConfigured) return "secret root missing";
  return "not eligible";
}

function agentGitServiceProvisioningPlanApplyProjects(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw badRequest("projects must be an array.");
  const projects: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const project = requireProjectName(item, "projects");
    if (seen.has(project)) continue;
    seen.add(project);
    projects.push(project);
  }
  return projects;
}

function agentGitServiceProvisioningPlanApplyAuditData(
  result: TenantAgentGitServiceProvisioningPlanApplyResult,
  clientId: string | undefined,
): Record<string, unknown> {
  return compactObject({
    provider: result.provider,
    dryRun: result.dryRun,
    eligibleOnly: result.eligibleOnly,
    projectCount: result.projectCount,
    eligibleProjectCount: result.eligibleProjectCount,
    provisionedProjectCount: result.provisionedProjectCount,
    skippedProjectCount: result.skippedProjectCount,
    failedProjectCount: result.failedProjectCount,
    projects: result.projects.map((project) => compactObject({
      project: project.project,
      status: project.status,
      reason: project.reason,
      error: project.error,
    })),
    clientId,
  });
}

async function tenantAgentGitServiceProvisioningPlanProject(
  workspaceRoot: string,
  tenant: string,
  project: string,
  options: HarnessServerOptions,
  secretRootConfigured: boolean,
): Promise<TenantAgentGitServiceProvisioningPlanProject> {
  const tenantRoot = join(workspaceRoot, tenant);
  const [receipt, sourceDefaults] = await Promise.all([
    readAgentGitServiceProjectProvisioningReceipt(workspaceRoot, tenant, project),
    readProjectSourceDefaults(tenantRoot, project),
  ]);
  const secretStored = receipt && secretRootConfigured
    ? await agentGitServiceAgentTokenSecretExists(options.agentGitServiceTokenSecretRoot as string, tenant, project, receipt.tokenEnvName)
    : false;
  const repo = receipt?.repo ?? sourceDefaults.repo;
  const permission: NonNullable<ProvisionAgentGitServiceProjectAgentOptions["permission"]> = receipt?.permission ?? "write";
  const tokenEnvName = receipt?.tokenEnvName ?? agentGitServiceDefaultProjectAgentTokenEnvName(tenant, project);
  const receiptPresent = Boolean(receipt);
  const repoConfigured = Boolean(repo);
  const missing: TenantAgentGitServiceProvisioningPlanMissing[] = [];
  if (!receiptPresent) missing.push("receipt");
  if (receiptPresent && !secretStored) missing.push(secretRootConfigured ? "secret" : "secretRoot");
  if (!repoConfigured) missing.push("repo");
  const ready = Boolean(receipt && secretStored);
  return compactObject({
    project,
    ready,
    receiptPresent,
    secretRootConfigured,
    secretStored,
    repoConfigured,
    repo,
    permission,
    tokenEnvName,
    receiptPath: receipt ? AGENT_GIT_SERVICE_PROJECT_PROVISIONING_RECEIPT_PATH : undefined,
    agentLogin: receipt?.agentLogin,
    agentRepoFullName: receipt?.agentRepoFullName,
    grantStatus: receipt?.grantStatus,
    missing,
    provisionCommandArgs: !ready && repo && secretRootConfigured
      ? agentGitServiceProvisioningPlanCommandArgs({ tenant, project, repo, tokenEnvName, permission, force: receiptPresent })
      : undefined,
  });
}

function agentGitServiceProvisioningPlanCommandArgs(input: {
  tenant: string;
  project: string;
  repo: string;
  tokenEnvName: string;
  permission: NonNullable<ProvisionAgentGitServiceProjectAgentOptions["permission"]>;
  force: boolean;
}): string[] {
  const args = [
    "loom",
    "harness",
    "provision-agent-git-service",
    "--tenant",
    input.tenant,
    "--project",
    input.project,
    "--repo",
    input.repo,
    "--token-env-name",
    input.tokenEnvName,
    "--permission",
    input.permission,
    "--store-agent-token",
  ];
  if (input.force) args.push("--force");
  return args;
}

function agentGitServiceDefaultProjectAgentTokenEnvName(tenant: string, project: string): string {
  return `LOOM_${agentGitServiceTokenEnvSegment(tenant)}_${agentGitServiceTokenEnvSegment(project)}_AGENT_TOKEN`;
}

function agentGitServiceTokenEnvSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

async function handleReadProject(
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
  if (segments[0] !== "tenants" || segments[2] !== "projects") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireProjectName(segments[3], "project");
  writeJson(res, 200, await readProjectDetail(workspaceRoot, options, tenant, project, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, projectPresence, runPresence, await readTenantAuditEvents(workspaceRoot, tenant, options.stateBackend?.events)));
  return true;
}

const AGENT_GIT_SERVICE_VAS_LEARNINGS_PAGE = "vas/learnings";

async function handleUpdateProjectPresence(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  presence: RunPresenceRegistry,
): Promise<boolean> {
  const context = await projectPresenceContext(url, req, workspaceRoot, options);
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
    clientId,
    label,
    focus,
    actor: context.access?.actor,
    role: context.access?.role,
    seenAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
  });
  presence.set(projectPresenceKey(context.tenant, context.project, clientId), entry);
  await persistPresenceEntry(projectPresenceRootFromProjectRoot(context.cwd), entry);
  writeJson(res, 200, publicRunPresenceEntry(entry));
  return true;
}

async function handleListProjectPresence(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  presence: RunPresenceRegistry,
): Promise<boolean> {
  const context = await projectPresenceContext(url, req, workspaceRoot, options);
  if (!context) return false;

  await refreshProjectPresenceFromDisk(presence, context.cwd, context.tenant, context.project);
  purgeExpiredRunPresence(presence);
  writeJson(res, 200, projectPresenceEntries(presence, context.tenant, context.project));
  return true;
}

async function projectPresenceContext(
  url: URL,
  req: IncomingMessage,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<{ tenant: string; project: string; cwd: string; access?: TenantAccess } | false> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "presence") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  await requireProjectExists(workspaceRoot, tenant, project);
  return { tenant, project, cwd: join(workspaceRoot, tenant, project), access };
}

async function requireProjectExists(workspaceRoot: string, tenant: string, project: string): Promise<void> {
  await requireProjectMetadata(workspaceRoot, tenant, project);
}

async function requireProjectMetadata(workspaceRoot: string, tenant: string, project: string): Promise<ProjectTemplateMetadata> {
  const metadata = await readProjectTemplateMetadata(join(workspaceRoot, tenant, project), { tenant, project });
  if (!metadata) throw notFound("project not found");
  return metadata;
}

async function readProjectDetail(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenant: string,
  project: string,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  queuedRuns: QueuedRun[],
  projectPresence: RunPresenceRegistry,
  runPresence: RunPresenceRegistry,
  tenantAuditEvents: TenantAuditEvent[],
): Promise<ProjectDetail> {
  const metadata = await requireProjectMetadata(workspaceRoot, tenant, project);
  const policyLimits = (await readTenantPolicy(workspaceRoot, tenant, options))?.limits;
  const summary = await readProjectSummary(join(workspaceRoot, tenant), tenant, project, policyLimits);
  const fallbackActivityAt = summary.latestStartedAt ?? metadata.createdAt;
  const activitySummary = await readProjectActivitySummary(workspaceRoot, options, tenant, project, fallbackActivityAt, activeSessions, tenantAuditEvents);
  const activeWorkspaceSessionDetails = await readActiveProjectWorkspaceSessionDetails(workspaceRoot, options, activeSessions, tenant, project);
  const controlPlane = await projectControlPlaneSummary(workspaceRoot, options, tenant, project);
  const projectRoot = join(workspaceRoot, tenant, project);
  await refreshProjectPresenceFromDisk(projectPresence, projectRoot, tenant, project);
  await refreshProjectRunPresenceFromDisk(runPresence, projectRoot, tenant, project);
  const detail = compactProjectDetail({
    ...summary,
    ...controlPlane,
    template: metadata.template,
    createdAt: metadata.createdAt,
    ...activitySummary,
    activeWorkspaceSessions: activeWorkspaceSessionDetails.length,
    ...activeProjectWorkspaceSessionSummaryFromDetails(activeWorkspaceSessionDetails),
    ...(await queuedProjectRunSummary(options, activeRunSlots, activeWorkspaces, queuedRuns, tenant, project)),
    ...activeProjectCollaboratorSummary(projectPresence, tenant, project),
    ...activeRunCollaboratorSummary(runPresence, tenant, project),
  });
  const activeRunDetails = await statusActiveRunDetails(workspaceRoot, options, activeRunSlots, tenant);
  return compactProjectDetail({
    ...detail,
    concurrency: projectConcurrencySummary(detail, activeProjectRunResourceStatuses(options, activeRunDetails, tenant, project)),
  });
}

async function readProjectSummaryWithActivity(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenantRoot: string,
  tenant: string,
  project: string,
  activeRunDetails: ActiveRunSlot[],
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  queuedRuns: QueuedRun[],
  projectPresence: RunPresenceRegistry,
  runPresence: RunPresenceRegistry,
  tenantAuditEvents: TenantAuditEvent[],
  policyLimits?: TenantPolicyLimits,
): Promise<ProjectSummary> {
  const summary = await readProjectSummary(tenantRoot, tenant, project, policyLimits);
  const metadata = await readProjectTemplateMetadata(join(tenantRoot, project), { tenant, project });
  if (!metadata) return summary;
  const fallbackActivityAt = summary.latestStartedAt ?? metadata.createdAt;
  const activitySummary = await readProjectActivitySummary(workspaceRoot, options, tenant, project, fallbackActivityAt, activeSessions, tenantAuditEvents);
  const activeWorkspaceSessionDetails = await readActiveProjectWorkspaceSessionDetails(workspaceRoot, options, activeSessions, tenant, project);
  const controlPlane = await projectControlPlaneSummary(workspaceRoot, options, tenant, project);
  const projectRoot = join(workspaceRoot, tenant, project);
  await refreshProjectPresenceFromDisk(projectPresence, projectRoot, tenant, project);
  await refreshProjectRunPresenceFromDisk(runPresence, projectRoot, tenant, project);
  const projectSummary = compactProjectSummary({
    ...summary,
    ...controlPlane,
    ...activitySummary,
    activeWorkspaceSessions: activeWorkspaceSessionDetails.length,
    ...activeProjectWorkspaceSessionSummaryFromDetails(activeWorkspaceSessionDetails),
    ...(await queuedProjectRunSummary(options, activeRunSlots, activeWorkspaces, queuedRuns, tenant, project)),
    ...activeProjectCollaboratorSummary(projectPresence, tenant, project),
    ...activeRunCollaboratorSummary(runPresence, tenant, project),
  });
  return compactProjectSummary({
    ...projectSummary,
    concurrency: projectConcurrencySummary(projectSummary, activeProjectRunResourceStatuses(options, activeRunDetails, tenant, project)),
  });
}

async function readProjectSummaryWithAuditActivity(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenantRoot: string,
  tenant: string,
  project: string,
  policyLimits?: TenantPolicyLimits,
): Promise<ProjectSummary> {
  const summary = await readProjectSummary(tenantRoot, tenant, project, policyLimits);
  const metadata = await readProjectTemplateMetadata(join(tenantRoot, project), { tenant, project });
  if (!metadata) return summary;
  const tenantAuditEvents = await readTenantAuditEvents(workspaceRoot, tenant, options.stateBackend?.events);
  const activitySummary = await readProjectActivitySummary(
    workspaceRoot,
    options,
    tenant,
    project,
    summary.latestStartedAt ?? metadata.createdAt,
    new Map<string, ActiveWorkspaceSession>(),
    tenantAuditEvents,
  );
  const controlPlane = await projectControlPlaneSummary(workspaceRoot, options, tenant, project);
  return compactProjectSummary({
    ...summary,
    ...controlPlane,
    ...activitySummary,
  });
}

async function projectControlPlaneSummary(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenant: string,
  project: string,
): Promise<Pick<ProjectSummary, "controlPlane">> {
  const provider = controlPlaneProviderName(options);
  if (provider !== "agent-git-service") return {};
  const receipt = await readAgentGitServiceProjectProvisioningReceipt(workspaceRoot, tenant, project);
  const secretRootConfigured = Boolean(options.agentGitServiceTokenSecretRoot?.trim());
  const secretStored = receipt && secretRootConfigured
    ? (await readAgentGitServiceAgentTokenSecret(options.agentGitServiceTokenSecretRoot as string, tenant, project, receipt.tokenEnvName)) !== undefined
    : false;
  return {
    controlPlane: {
      provider,
      agentGitServiceProjectAgent: compactObject({
        ready: Boolean(receipt && secretStored),
        receiptPresent: Boolean(receipt),
        secretRootConfigured,
        secretStored,
        receiptPath: receipt ? AGENT_GIT_SERVICE_PROJECT_PROVISIONING_RECEIPT_PATH : undefined,
        agentLogin: receipt?.agentLogin,
        agentRepoFullName: receipt?.agentRepoFullName,
        repo: receipt?.repo,
        permission: receipt?.permission,
        grantStatus: receipt?.grantStatus,
        tokenEnvName: receipt?.tokenEnvName,
      }) as AgentGitServiceProjectAgentSummary,
    },
  };
}

function activeProjectRunResourceStatuses(
  options: HarnessServerOptions,
  activeRunDetails: ActiveRunSlot[],
  tenant: string,
  project: string,
): ActiveRunResourceStatus[] {
  return activeRunResourceStatuses(
    options,
    activeRunDetails.filter((run) => run.tenant === tenant && run.project === project),
  );
}

function projectConcurrencySummary(
  project: ProjectSummary,
  activeRunDetails: ActiveRunResourceStatus[] = [],
): ProjectConcurrencySummary | undefined {
  const hasWorkspaceConflicts = (project.workspaceConflictCount ?? 0) > 0;
  const hasQueuedRuns = (project.queuedRunCount ?? 0) > 0;
  const hasActiveWork = Boolean(
    project.runningRunId
      || activeRunDetails.length > 0
      || (project.activeWorkspaceSessions ?? 0) > 0
      || (project.activeProjectCollaboratorCount ?? 0) > 0
      || (project.activeRunCollaboratorCount ?? 0) > 0,
  );
  const state: ProjectConcurrencyState | undefined = hasWorkspaceConflicts
    ? "contended"
    : hasQueuedRuns
      ? "queued"
      : hasActiveWork
        ? "active"
        : undefined;
  if (!state) return undefined;
  return compactObject({
    state,
    runningRunId: project.runningRunId,
    activeRunDetails: activeRunDetails.length ? activeRunDetails : undefined,
    queuedRunCount: (project.queuedRunCount ?? 0) > 0 ? project.queuedRunCount : undefined,
    activeWorkspaceSessions: (project.activeWorkspaceSessions ?? 0) > 0 ? project.activeWorkspaceSessions : undefined,
    activeProjectCollaboratorCount: (project.activeProjectCollaboratorCount ?? 0) > 0 ? project.activeProjectCollaboratorCount : undefined,
    activeRunCollaboratorCount: (project.activeRunCollaboratorCount ?? 0) > 0 ? project.activeRunCollaboratorCount : undefined,
    workspaceConflictCount: project.workspaceConflictCount,
    latestWorkspaceConflict: project.latestWorkspaceConflict,
  });
}

async function readProjectActivitySummary(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenant: string,
  project: string,
  fallbackActivityAt: string,
  activeSessions: Map<string, ActiveWorkspaceSession>,
  tenantAuditEvents: TenantAuditEvent[],
): Promise<ProjectActivitySummary> {
  const [commands, sessions] = await Promise.all([
    readWorkspaceCommandSummaries(projectWorkspaceCommandRoot(workspaceRoot, tenant, project), { route: "project", tenant, project }),
    readWorkspaceSessionSummaries(
      projectWorkspaceSessionRoot(workspaceRoot, tenant, project),
      activeSessions,
      { route: "project", tenant, project },
      options,
    ),
  ]);
  let activityAt = fallbackActivityAt;
  let latestWorkspaceCommand: WorkspaceCommandSummary | undefined;
  let latestWorkspaceSession: WorkspaceSessionSummary | undefined;
  for (const command of commands) {
    if (command.endedAt > activityAt) activityAt = command.endedAt;
    if (!latestWorkspaceCommand
      || command.endedAt > latestWorkspaceCommand.endedAt
      || (command.endedAt === latestWorkspaceCommand.endedAt && command.startedAt > latestWorkspaceCommand.startedAt)
      || (command.endedAt === latestWorkspaceCommand.endedAt
        && command.startedAt === latestWorkspaceCommand.startedAt
        && command.commandId > latestWorkspaceCommand.commandId)) {
      latestWorkspaceCommand = command;
    }
  }
  for (const session of sessions) {
    const sessionActivityAt = workspaceSessionActivityAt(session);
    if (sessionActivityAt > activityAt) activityAt = sessionActivityAt;
    if (!latestWorkspaceSession
      || sessionActivityAt > workspaceSessionActivityAt(latestWorkspaceSession)
      || (sessionActivityAt === workspaceSessionActivityAt(latestWorkspaceSession)
        && session.startedAt > latestWorkspaceSession.startedAt)
      || (sessionActivityAt === workspaceSessionActivityAt(latestWorkspaceSession)
        && session.startedAt === latestWorkspaceSession.startedAt
        && session.sessionId > latestWorkspaceSession.sessionId)) {
      latestWorkspaceSession = session;
    }
  }
  const latestWorkspaceActivity = latestProjectWorkspaceActivity(tenantAuditEvents, project);
  if (latestWorkspaceActivity && latestWorkspaceActivity.ts > activityAt) activityAt = latestWorkspaceActivity.ts;
  const workspaceConflictSummary = projectWorkspaceConflictSummary(tenantAuditEvents, project);
  if (workspaceConflictSummary.latestWorkspaceConflict && workspaceConflictSummary.latestWorkspaceConflict.ts > activityAt) {
    activityAt = workspaceConflictSummary.latestWorkspaceConflict.ts;
  }
  const latestControlActivity = latestProjectControlActivity(tenantAuditEvents, project);
  if (latestControlActivity && latestControlActivity.ts > activityAt) activityAt = latestControlActivity.ts;
  return compactObject({
    activityAt,
    latestWorkspaceCommand,
    latestWorkspaceSession,
    latestWorkspaceActivity,
    ...workspaceConflictSummary,
    latestControlActivity,
  });
}

const projectWorkspaceActivityTypes = new Set<string>([
  "workspace_file_written",
  "workspace_file_moved",
  "workspace_file_deleted",
  "workspace_file_conflicted",
  "workspace_commit_created",
  "workspace_pull_request_created",
]);

function latestProjectWorkspaceActivity(
  events: TenantAuditEvent[],
  project: string,
): ProjectWorkspaceActivitySummary | undefined {
  let latest: { seq: number; activity: ProjectWorkspaceActivitySummary } | undefined;
  for (const event of events) {
    if (!projectWorkspaceActivityTypes.has(event.type)) continue;
    const data = recordData(event.data);
    if (data.project !== project || stringField(data, "runId") !== undefined) continue;
    const activity = projectWorkspaceActivitySummary(event as TenantAuditEvent, data);
    if (!latest || activity.ts > latest.activity.ts || (activity.ts === latest.activity.ts && event.seq > latest.seq)) {
      latest = { seq: event.seq, activity };
    }
  }
  return latest?.activity;
}

function projectWorkspaceActivitySummary(
  event: TenantAuditEvent,
  data: Record<string, unknown>,
): ProjectWorkspaceActivitySummary {
  return compactObject({
    type: event.type as ProjectWorkspaceActivityType,
    ts: event.ts,
    actor: event.actor,
    role: event.role,
    clientId: stringField(data, "clientId"),
    path: stringField(data, "path"),
    fromPath: stringField(data, "fromPath"),
    toPath: stringField(data, "toPath"),
    operation: stringField(data, "operation"),
    expectedUpdatedAt: stringField(data, "expectedUpdatedAt"),
    observedUpdatedAt: stringField(data, "observedUpdatedAt"),
    observedKind: stringField(data, "observedKind"),
    activeEditorCount: numberField(data, "activeEditorCount"),
    bytes: numberField(data, "bytes"),
    commit: stringField(data, "commit"),
    message: stringField(data, "message"),
    issue: stringField(data, "issue"),
    issueUrl: stringField(data, "issueUrl"),
    branch: stringField(data, "branch"),
    baseBranch: stringField(data, "baseBranch"),
    pullRequestIndex: numberField(data, "pullRequestIndex"),
    pullRequestUrl: stringField(data, "pullRequestUrl"),
  });
}

function projectWorkspaceConflictSummary(
  events: TenantAuditEvent[],
  project: string,
): Pick<ProjectActivitySummary, "workspaceConflictCount" | "latestWorkspaceConflict"> {
  let workspaceConflictCount = 0;
  let latest: { seq: number; activity: ProjectWorkspaceActivitySummary } | undefined;
  for (const event of events) {
    if (event.type !== "workspace_file_conflicted") continue;
    const data = recordData(event.data);
    if (data.project !== project || stringField(data, "runId") !== undefined) continue;
    workspaceConflictCount += 1;
    const activity = projectWorkspaceActivitySummary(event, data);
    if (!latest || activity.ts > latest.activity.ts || (activity.ts === latest.activity.ts && event.seq > latest.seq)) {
      latest = { seq: event.seq, activity };
    }
  }
  return compactObject({
    workspaceConflictCount: workspaceConflictCount > 0 ? workspaceConflictCount : undefined,
    latestWorkspaceConflict: latest?.activity,
  });
}

const projectControlActivityTypes = new Set<string>([
  "project_created",
  "project_source_defaults_updated",
  "project_default_skills_updated",
  "project_run_policy_updated",
  "project_contract_updated",
  "vas_case_created",
  "vas_case_claimed",
  "vas_case_reviewed",
  "run_comment_added",
  "run_issue_comments_synced",
  "run_resumed",
  "queued_run_recovered",
  "queued_run_recovery_failed",
  "run_cancelled",
  "run_abandoned",
  "run_review_claimed",
	  "review_decided",
	  "deployment_decided",
	  "run_handoff_followup_created",
	  "run_handoff_followup_denied",
	  "tenant_control_plane_restore_dry_run",
  "agent_git_service_project_agent_provisioned",
  "agent_git_service_wiki_memory_updated",
  "agent_git_service_wiki_memory_failed",
	]);

function latestProjectControlActivity(
  events: TenantAuditEvent[],
  project: string,
): ProjectControlActivitySummary | undefined {
  let latest: { seq: number; activity: ProjectControlActivitySummary } | undefined;
	  for (const event of events) {
	    if (!projectControlActivityTypes.has(event.type)) continue;
	    const data = recordData(event.data);
	    if (!projectControlActivityMatchesProject(event, data, project)) continue;
	    const activity = projectControlActivitySummary(event as TenantAuditEvent, data);
	    if (!latest || activity.ts > latest.activity.ts || (activity.ts === latest.activity.ts && event.seq > latest.seq)) {
	      latest = { seq: event.seq, activity };
    }
  }
	  return latest?.activity;
	}
	
	function projectControlActivityMatchesProject(
	  event: TenantAuditEvent,
	  data: Record<string, unknown>,
	  project: string,
	): boolean {
	  if (data.project === project) return true;
	  if (event.type !== "tenant_control_plane_restore_dry_run") return false;
	  return stringArrayFieldAllowEmpty(data, "projects")?.includes(project) ?? false;
	}
	
	function projectControlActivitySummary(
	  event: TenantAuditEvent,
	  data: Record<string, unknown>,
	): ProjectControlActivitySummary {
  return compactObject({
    type: event.type as ProjectControlActivityType,
    ts: event.ts,
    actor: event.actor,
    role: event.role,
    clientId: stringField(data, "clientId"),
    template: projectTemplateNameField(data, "template"),
    runId: stringField(data, "runId"),
    caseId: stringField(data, "caseId"),
    repo: stringField(data, "repo"),
    branch: stringField(data, "branch"),
    baseBranch: stringField(data, "baseBranch"),
    issue: stringField(data, "issue"),
    issueUrl: stringField(data, "issueUrl"),
    message: stringField(data, "message"),
    note: stringField(data, "note"),
    source: stringField(data, "source"),
    decision: stringField(data, "decision"),
    status: stringField(data, "status"),
    action: stringField(data, "action"),
    claimedAt: stringField(data, "claimedAt"),
    previousClaim: reviewClaimField(data, "previousClaim"),
    cleared: booleanField(data, "cleared"),
    defaultSkills: stringArrayFieldAllowEmpty(data, "defaultSkills"),
    runPolicy: projectTemplateRunPolicyField(data, "runPolicy"),
    contract: projectTemplateContractField(data, "contract"),
    reason: stringField(data, "reason"),
    queued: booleanField(data, "queued"),
    stale: booleanField(data, "stale"),
    pauseRequested: booleanField(data, "pauseRequested"),
    resumeRequested: booleanField(data, "resumeRequested"),
    resumed: booleanField(data, "resumed"),
    runReviewRequested: booleanField(data, "runReviewRequested"),
    runReviewed: booleanField(data, "runReviewed"),
    runReviewDenied: booleanField(data, "runReviewDenied"),
    runReviewClaimRequested: booleanField(data, "runReviewClaimRequested"),
    runReviewClaimed: booleanField(data, "runReviewClaimed"),
    runReviewClaimReleased: booleanField(data, "runReviewClaimReleased"),
    deploymentRequested: booleanField(data, "deploymentRequested"),
    deployed: booleanField(data, "deployed"),
    deploymentDenied: booleanField(data, "deploymentDenied"),
    vasReviewRequested: booleanField(data, "vasReviewRequested"),
    vasReviewed: booleanField(data, "vasReviewed"),
    vasReviewDenied: booleanField(data, "vasReviewDenied"),
    vasRunRequested: booleanField(data, "vasRunRequested"),
    vasRunStarted: booleanField(data, "vasRunStarted"),
    vasRunDenied: booleanField(data, "vasRunDenied"),
    vasClaimRequested: booleanField(data, "vasClaimRequested"),
    vasClaimed: booleanField(data, "vasClaimed"),
    vasClaimReleased: booleanField(data, "vasClaimReleased"),
    vasClaimDenied: booleanField(data, "vasClaimDenied"),
    synced: numberField(data, "synced"),
    skippedDuplicate: numberField(data, "skippedDuplicate"),
    followupRunId: stringField(data, "followupRunId"),
    followupStatus: stringField(data, "followupStatus"),
    expectedCheckpointVersion: stringField(data, "expectedCheckpointVersion"),
    observedCheckpointVersion: stringField(data, "observedCheckpointVersion"),
    goal: stringField(data, "goal"),
    sourceStatus: stringField(data, "sourceStatus"),
    provider: controlPlaneProviderNameField(data, "provider"),
    sourceProvider: controlPlaneProviderNameField(data, "sourceProvider"),
    targetProvider: controlPlaneProviderNameField(data, "targetProvider"),
    format: stringField(data, "format"),
    projectCount: numberField(data, "projectCount"),
    runCount: numberField(data, "runCount"),
    auditEventCount: numberField(data, "auditEventCount"),
    secretScrubbed: booleanField(data, "secretScrubbed"),
    cutoverReady: booleanField(data, "cutoverReady"),
    agentGitServiceProjectAgentsMissingProjects: stringArrayFieldAllowEmpty(
      data,
      "agentGitServiceProjectAgentsMissingProjects",
    ),
    agentGitServiceProjectAgentsMissingSecretProjects: stringArrayFieldAllowEmpty(
      data,
      "agentGitServiceProjectAgentsMissingSecretProjects",
    ),
    agentLogin: stringField(data, "agentLogin"),
    agentRepoFullName: stringField(data, "agentRepoFullName"),
    permission: stringField(data, "permission"),
    grantStatus: stringField(data, "grantStatus"),
    tokenEnvName: stringField(data, "tokenEnvName"),
    tokenMaterial: stringField(data, "tokenMaterial"),
    receiptPath: stringField(data, "receiptPath"),
    page: stringField(data, "page"),
    sha: stringField(data, "sha"),
    url: stringField(data, "url"),
    learningCount: numberField(data, "learningCount"),
    error: stringField(data, "error"),
  });
}

async function readProjectSummary(
  tenantRoot: string,
  tenant: string,
  project: string,
  policyLimits?: TenantPolicyLimits,
): Promise<ProjectSummary> {
  const projectRoot = join(tenantRoot, project);
  const runsRoot = join(projectRoot, ".loom", "runs");
  const metadata = await readProjectTemplateMetadata(projectRoot, { tenant, project });
  const template = metadata?.template === "empty" ? undefined : metadata?.template;
  const defaultSkills = projectDefaultSkillsSummary(metadata);
  const runPolicy = projectRunPolicySummary(metadata);
  const contract = projectContractSummary(metadata);
  const contractStatus = projectContractStatusSummary(metadata);
  const sourceDefaults = await readProjectSourceDefaults(tenantRoot, project);
  const vasReadiness = metadata?.template === "vas-lite" ? await readVasLiteProjectReadiness(projectRoot, tenant, project) : {};
  const workspaceUsage = await projectWorkspaceUsageSummary(projectRoot, policyLimits);
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return compactProjectSummary({ project, runCount: 0, template, ...defaultSkills, ...runPolicy, ...contract, ...contractStatus, ...workspaceUsage, ...sourceDefaults, ...vasReadiness });
    throw error;
  }
  const states = await readRunStatesForListing(runsRoot, tenant, project);
  states.sort((a, b) => startedAt(b).localeCompare(startedAt(a)));
  const latest = states[0];
  const running = states.find((state) => state.status === "running");
  return compactProjectSummary({
    project,
    runCount: states.length,
    template,
    ...defaultSkills,
    ...runPolicy,
    ...contract,
    ...contractStatus,
    latestRunId: latest?.runId,
    latestStatus: latest?.status,
    latestStartedAt: latest ? startedAt(latest) : undefined,
    runningRunId: running?.runId,
    ...projectHumanGateRunSummary(states),
    ...projectModelUsageSummary(states, policyLimits),
    ...workspaceUsage,
    ...sourceDefaults,
    ...vasReadiness,
  });
}

function projectDefaultSkillsSummary(metadata: ProjectTemplateMetadata | undefined): Pick<ProjectSummary, "defaultSkills"> {
  if (!metadata) return {};
  const defaultSkills = projectMetadataDefaultSkills(metadata);
  if (metadata.defaultSkills !== undefined || defaultSkills.length > 0) return { defaultSkills };
  return {};
}

function projectRunPolicySummary(metadata: ProjectTemplateMetadata | undefined): Pick<ProjectSummary, "runPolicy"> {
  if (!metadata?.runPolicy) return {};
  return { runPolicy: metadata.runPolicy };
}

function projectContractSummary(metadata: ProjectTemplateMetadata | undefined): Pick<ProjectSummary, "contract"> {
  const contract = compactProjectContract(metadata?.contract);
  return contract ? { contract } : {};
}

function projectContractStatusSummary(metadata: ProjectTemplateMetadata | undefined): Pick<ProjectSummary, "contractStatus"> {
  const contractStatus = projectTemplateContractStatus(metadata);
  return contractStatus ? { contractStatus } : {};
}

type ProjectSourceDefaultValues = Pick<ProjectSummary, "repo" | "branch" | "baseBranch" | "issue">;

interface ProjectSourceDefaults extends ProjectSourceDefaultValues {
  schemaVersion: 1;
  project: string;
}

function projectSourceDefaultsFromBody(body: ProjectCreateRequestBody): ProjectSourceDefaultValues {
  return compactObject({
    repo: optionalSourceRepo(body.repo),
    branch: optionalSourceGitRef(body.branch, "branch"),
    baseBranch: optionalSourceGitRef(body.baseBranch, "baseBranch"),
    issue: optionalSourceIssue(body.issue),
  });
}

function projectDefaultSkillsFromBody(body: ProjectDefaultSkillsRequestBody): string[] {
  if (body.defaultSkills === undefined) {
    throw badRequest("defaultSkills must be an array of strings.");
  }
  return stringArray(body.defaultSkills, "defaultSkills");
}

function projectRunPolicyFromBody(body: ProjectRunPolicyRequestBody): ProjectTemplateRunPolicy | undefined {
  const preset = runPresetName(body.preset);
  if (!preset && body.presetInput !== undefined) throw badRequest("presetInput requires preset.");
  const reviewRequired = booleanFlag(body.reviewRequired, "reviewRequired");
  const deploymentRequired = booleanFlag(body.deploymentRequired, "deploymentRequired");
  const runPolicy = compactObject({
    preset,
    presetInput: preset === VAS_LITE_REVIEW_PRESET ? vasLiteReviewPresetInput(body.presetInput) : undefined,
    reviewRequired: reviewRequired || undefined,
    deploymentRequired: deploymentRequired || undefined,
  });
  return Object.keys(runPolicy).length ? runPolicy : undefined;
}

function projectRunPolicyRequestHasContent(body: ProjectRunPolicyRequestBody): boolean {
  return body.preset !== undefined ||
    body.presetInput !== undefined ||
    body.reviewRequired !== undefined ||
    body.deploymentRequired !== undefined;
}

function projectContractFromBody(body: ProjectContractRequestBody): ProjectTemplateContract | undefined {
  return compactProjectContract({
    objective: optionalString(body.objective, "objective"),
    constraints: stringArray(body.constraints, "constraints"),
    successCriteria: stringArray(body.successCriteria, "successCriteria"),
  });
}

function projectContractRequestHasContent(body: ProjectContractRequestBody): boolean {
  return body.objective !== undefined ||
    body.constraints !== undefined ||
    body.successCriteria !== undefined;
}

function compactProjectContract(contract: ProjectTemplateContract | undefined): ProjectTemplateContract | undefined {
  if (!contract) return undefined;
  const constraints = compactStringList(contract.constraints);
  const successCriteria = compactStringList(contract.successCriteria);
  const compacted = compactObject({
    objective: contract.objective?.trim() || undefined,
    constraints: constraints.length ? constraints : undefined,
    successCriteria: successCriteria.length ? successCriteria : undefined,
  });
  return Object.keys(compacted).length ? compacted : undefined;
}

interface ProjectRunPolicyApplication {
  body: RunRequestBody;
  evidence?: ProjectRunPolicyEvidence;
}

async function applyProjectRunPolicy(
  workspaceRoot: string,
  tenant: string,
  project: string,
  body: RunRequestBody,
): Promise<ProjectRunPolicyApplication> {
  const metadata = await readProjectTemplateMetadata(join(workspaceRoot, tenant, project), { tenant, project });
  const runPolicy = metadata?.runPolicy;
  if (!runPolicy) return { body };
  const inheritPreset = body.preset === undefined;
  return {
    body: {
      ...body,
      preset: inheritPreset ? runPolicy.preset : body.preset,
      presetInput: body.presetInput === undefined && inheritPreset ? runPolicy.presetInput : body.presetInput,
      reviewRequired: body.reviewRequired === undefined ? runPolicy.reviewRequired : body.reviewRequired,
      deploymentRequired: body.deploymentRequired === undefined ? runPolicy.deploymentRequired : body.deploymentRequired,
    },
    evidence: projectRunPolicyEvidence(body, runPolicy),
  };
}

function projectRunPolicyEvidence(
  body: RunRequestBody,
  runPolicy: ProjectTemplateRunPolicy,
): ProjectRunPolicyEvidence | undefined {
  const fields: ProjectRunPolicyEvidence["fields"] = [];
  const inheritPreset = body.preset === undefined;
  const evidence = compactObject({
    source: "project.runPolicy" as const,
    fields,
    preset: inheritPreset && runPolicy.preset !== undefined ? runPolicy.preset : undefined,
    presetInput: body.presetInput === undefined && inheritPreset && runPolicy.presetInput !== undefined ? runPolicy.presetInput : undefined,
    reviewRequired: body.reviewRequired === undefined && runPolicy.reviewRequired !== undefined ? runPolicy.reviewRequired : undefined,
    deploymentRequired: body.deploymentRequired === undefined && runPolicy.deploymentRequired !== undefined ? runPolicy.deploymentRequired : undefined,
  });
  if (evidence.preset !== undefined) fields.push("preset");
  if (evidence.presetInput !== undefined) fields.push("presetInput");
  if (evidence.reviewRequired !== undefined) fields.push("reviewRequired");
  if (evidence.deploymentRequired !== undefined) fields.push("deploymentRequired");
  return fields.length ? evidence as ProjectRunPolicyEvidence : undefined;
}

async function readProjectContractEvidence(
  workspaceRoot: string,
  tenant: string,
  project: string,
): Promise<ProjectContractEvidence | undefined> {
  const metadata = await readProjectTemplateMetadata(join(workspaceRoot, tenant, project), { tenant, project });
  return projectContractEvidence(metadata?.contract);
}

async function readProjectContractStatusEvidence(
  workspaceRoot: string,
  tenant: string,
  project: string,
): Promise<ProjectContractStatusEvidence | undefined> {
  const metadata = await readProjectTemplateMetadata(join(workspaceRoot, tenant, project), { tenant, project });
  const status = projectTemplateContractStatus(metadata);
  return status ? { source: "project.contractStatus", ...status } : undefined;
}

function projectContractEvidence(contract: ProjectTemplateContract | undefined): ProjectContractEvidence | undefined {
  const compacted = compactProjectContract(contract);
  return compacted ? { source: "project.contract", ...compacted } : undefined;
}

async function readProjectSourceDefaults(tenantRoot: string, project: string): Promise<ProjectSourceDefaultValues> {
  try {
    const value = JSON.parse(await readFile(projectSourceDefaultsPath(tenantRoot, project), "utf8"));
    return projectSourceDefaultsFromUnknown(value, project) ?? {};
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writeProjectSourceDefaults(
  tenantRoot: string,
  project: string,
  defaults: ProjectSourceDefaultValues,
): Promise<void> {
  if (!Object.keys(defaults).length) {
    try {
      await unlink(projectSourceDefaultsPath(tenantRoot, project));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return;
  }
  await mkdir(projectSourceDefaultsDir(tenantRoot), { recursive: true });
  await writeJsonFileAtomic(projectSourceDefaultsPath(tenantRoot, project), {
    schemaVersion: 1,
    project,
    ...defaults,
  } satisfies ProjectSourceDefaults);
}

function projectSourceDefaultsFromUnknown(value: unknown, project: string): ProjectSourceDefaultValues | undefined {
  const input = recordData(value);
  if (input.schemaVersion !== 1) return undefined;
  if (stringField(input, "project") !== project) return undefined;
  try {
    return compactObject({
      repo: optionalSourceRepo(input.repo),
      branch: optionalSourceGitRef(input.branch, "branch"),
      baseBranch: optionalSourceGitRef(input.baseBranch, "baseBranch"),
      issue: optionalSourceIssue(input.issue),
    });
  } catch {
    return undefined;
  }
}

function projectSourceDefaultsDir(tenantRoot: string): string {
  return join(tenantRoot, ".loom", "projects");
}

function projectSourceDefaultsPath(tenantRoot: string, project: string): string {
  return join(projectSourceDefaultsDir(tenantRoot), `${project}.json`);
}

async function readAgentGitServiceAgentTokenSecret(
  secretRoot: string,
  tenant: string,
  project: string,
  tokenEnvName: string,
): Promise<string | undefined> {
  const secretRootPath = resolve(secretRoot);
  const secretPath = resolve(secretRootPath, tenant, project, tokenEnvName);
  if (!secretPath.startsWith(`${secretRootPath}/`)) {
    throw badRequest("agent-git-service token secret path escapes the configured secret root.");
  }
  try {
    const token = (await readFile(secretPath, "utf8")).replace(/\r?\n$/, "");
    return token || undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function agentGitServiceAgentTokenSecretExists(
  secretRoot: string,
  tenant: string,
  project: string,
  tokenEnvName: string,
): Promise<boolean> {
  const secretRootPath = resolve(secretRoot);
  const secretPath = resolve(secretRootPath, tenant, project, tokenEnvName);
  if (!secretPath.startsWith(`${secretRootPath}/`)) {
    throw badRequest("agent-git-service token secret path escapes the configured secret root.");
  }
  try {
    return (await stat(secretPath)).isFile();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function projectWorkspaceContext(workspaceRoot: string, tenant: string, project: string, runId: string): HarnessWorkspaceContext {
  const cwd = join(workspaceRoot, tenant, project);
  return { tenant, project, runId, cwd };
}

function compactProjectSummary(project: ProjectSummary): ProjectSummary {
  return Object.fromEntries(Object.entries(project).filter(([, value]) => value !== undefined)) as ProjectSummary;
}

function compactProjectDetail(project: ProjectDetail): ProjectDetail {
  return Object.fromEntries(Object.entries(project).filter(([, value]) => value !== undefined)) as ProjectDetail;
}

function runProjectQuery(project: string): string {
  if (project === "default") return "";
  return `?project=${encodeURIComponent(project)}`;
}

function projectTemplateNameField(data: Record<string, unknown>, key: string): ProjectTemplateName | undefined {
  const value = data[key];
  return value === "empty" || value === "vas-lite" ? value : undefined;
}
	
	function projectTemplateRunPolicyField(data: Record<string, unknown>, key: string): ProjectTemplateRunPolicy | undefined {
  const value = recordData(data[key]);
  const preset = value.preset === VAS_LITE_REVIEW_PRESET ? VAS_LITE_REVIEW_PRESET : undefined;
  const presetInputValue = recordData(value.presetInput);
  const caseId = stringField(presetInputValue, "caseId");
  const runPolicy = compactObject({
    preset,
    presetInput: preset && caseId ? { caseId } : undefined,
    reviewRequired: booleanField(value, "reviewRequired"),
    deploymentRequired: booleanField(value, "deploymentRequired"),
  }) as ProjectTemplateRunPolicy;
  return Object.keys(runPolicy).length ? runPolicy : undefined;
}

function projectTemplateContractField(data: Record<string, unknown>, key: string): ProjectTemplateContract | undefined {
  const value = recordData(data[key]);
  const contract = compactObject({
    objective: stringField(value, "objective"),
    constraints: stringArrayField(value, "constraints"),
    successCriteria: stringArrayField(value, "successCriteria"),
  }) as ProjectTemplateContract;
  return contract.objective || contract.constraints || contract.successCriteria ? contract : undefined;
}

function projectContractEvidenceField(data: Record<string, unknown>, key: string): ProjectContractEvidence | undefined {
  const value = recordData(data[key]);
  if (value.source !== "project.contract") return undefined;
  const evidence = compactObject({
    source: "project.contract",
    objective: stringField(value, "objective"),
    constraints: stringArrayField(value, "constraints"),
    successCriteria: stringArrayField(value, "successCriteria"),
  }) as ProjectContractEvidence;
  return evidence.objective || evidence.constraints || evidence.successCriteria ? evidence : undefined;
}

function projectContractPatchField(data: Record<string, unknown>, key: string): ProjectContractPatch | undefined {
  const value = recordData(data[key]);
  const patch = compactObject({
    objective: stringField(value, "objective"),
    constraints: stringArrayField(value, "constraints"),
    successCriteria: stringArrayField(value, "successCriteria"),
  }) as ProjectContractPatch;
  return patch.objective || patch.constraints || patch.successCriteria ? patch : undefined;
}

function projectContractStatusEvidenceField(data: Record<string, unknown>, key: string): ProjectContractStatusEvidence | undefined {
  const value = recordData(data[key]);
  if (value.source !== "project.contractStatus") return undefined;
  const ok = booleanField(value, "ok");
  const missing = Array.isArray(value.missing) && value.missing.every((item) => typeof item === "string")
    ? value.missing
    : undefined;
  return ok === undefined || missing === undefined ? undefined : { source: "project.contractStatus", ok, missing };
}

function requireProjectName(value: unknown, field: string): string {
  const name = requireSafeName(value, field);
  if (name === ".loom") {
    throw badRequest(`${field} is reserved.`);
  }
  return name;
}

function projectTemplateName(value: unknown): ProjectTemplateName {
  if (value === undefined || value === null || value === "") return "empty";
  if (value === "empty" || value === "vas-lite") return value;
  throw badRequest("template must be empty or vas-lite.");
}

async function listTenantProjectNames(workspaceRoot: string, tenant: string): Promise<string[]> {
  try {
    const tenantRoot = join(workspaceRoot, tenant);
    const entries = await readdir(tenantRoot, { withFileTypes: true });
    const projects = await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || !isProjectDirectoryName(entry.name)) return undefined;
      const metadata = await readProjectTemplateMetadata(join(tenantRoot, entry.name), { tenant, project: entry.name });
      return metadata ? entry.name : undefined;
    }));
    return projects.filter((project): project is string => project !== undefined);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function isProjectDirectoryName(name: string): boolean {
  try {
    requireProjectName(name, "project");
    return true;
  } catch {
    return false;
  }
}

function projectPresenceRootFromProjectRoot(projectRoot: string): string {
  return join(projectRoot, ".loom", "presence", "project");
}

function runPresenceRootFromProjectRoot(projectRoot: string, runId: string): string {
  return join(projectRoot, ".loom", "runs", runId, "presence");
}

async function refreshProjectPresenceFromDisk(
  presence: RunPresenceRegistry,
  projectRoot: string,
  tenant: string,
  project: string,
): Promise<void> {
  await refreshPresenceDirectory(presence, projectPresenceRootFromProjectRoot(projectRoot), { tenant, project });
}

async function refreshProjectRunPresenceFromDisk(
  presence: RunPresenceRegistry,
  projectRoot: string,
  tenant: string,
  project: string,
): Promise<void> {
  const runsRoot = join(projectRoot, ".loom", "runs");
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => refreshRunPresenceFromDisk(presence, projectRoot, tenant, project, entry.name)));
}

function projectPresenceKey(tenant: string, project: string, clientId: string): string {
  return `${tenant}\0${project}\0${clientId}`;
}

function projectPresenceEntries(
  presence: RunPresenceRegistry,
  tenant: string,
  project: string,
): RunPresenceEntry[] {
  return [...presence.values()]
    .filter((entry) => entry.tenant === tenant && entry.project === project)
    .sort((a, b) => a.label.localeCompare(b.label) || a.clientId.localeCompare(b.clientId))
    .map(publicRunPresenceEntry);
}

export { AgentGitServiceProjectProvisionRequestBody, AgentGitServiceProvisioningPlanApplyRequestBody, ProjectCreateRequestBody, ProjectSourceDefaultsRequestBody, ProjectDefaultSkillsRequestBody, ProjectRunPolicyRequestBody, ProjectContractRequestBody, ProjectSummary, projectModelUsageRequesterKey, projectModelUsageRequesterLabel, agentGitServiceProjectAgentsReadiness, agentGitServiceProjectAgentsReadinessForProvider, handleReadTenantAgentGitServiceProvisioningPlan, handleApplyTenantAgentGitServiceProvisioningPlan, projectWorkspaceSessionRoot, projectWorkspaceCommandRoot, handleReadProjectWorkspaceInfo, handleReadProjectWorkspaceDiff, handleCreateProject, handleProvisionAgentGitServiceProjectAgent, handleReadAgentGitServiceProjectProvisioningReceipt, handleUpdateProjectSourceDefaults, handleUpdateProjectDefaultSkills, handleUpdateProjectRunPolicy, handleUpdateProjectContract, handleListProjects, readTenantProjectSummariesWithActivity, handleReadProject, AGENT_GIT_SERVICE_VAS_LEARNINGS_PAGE, handleUpdateProjectPresence, handleListProjectPresence, requireProjectExists, requireProjectMetadata, readProjectSummary, ProjectSourceDefaultValues, projectContractFromBody, applyProjectRunPolicy, readProjectContractEvidence, readProjectContractStatusEvidence, readProjectSourceDefaults, readAgentGitServiceAgentTokenSecret, projectWorkspaceContext, runProjectQuery, projectContractEvidenceField, projectContractPatchField, projectContractStatusEvidenceField, requireProjectName, listTenantProjectNames, isProjectDirectoryName, runPresenceRootFromProjectRoot, refreshProjectPresenceFromDisk, projectPresenceKey, projectPresenceEntries };
