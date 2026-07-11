import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { readTenantAuditEvents, type TenantAuditActor, type TenantAuditAppender, type TenantAuditEvent, type TenantRole } from "../audit.js";
import { sanitizeTenantApiKey, tenantApiKeyMatches, type SanitizedTenantApiKey, type TenantApiKey } from "../server-auth.js";
import { parseTenantPolicyApiKeys } from "../server-api-keys.js";
import { type ReadableRunState } from "../run-state.js";
import type { RunMetadata, RunRequesterSummary, RunSummary } from "../events.js";
import { CONTROL_PLANE_PROVIDER_BOUNDARY, controlPlaneProviderCatalogEntry, type ControlPlaneProviderCatalogName } from "../control-plane.js";
import type { RunSignal } from "../../brain.js";
import { brainFailureKindForSummary } from "../../brain-evidence.js";
import { assertTenantName } from "../../tenant.js";
import { HarnessConcurrencyAdmissionStatus } from "./admission.js";
import { QueuedRun, ActiveRunSlot, RunCreateIdempotencyStatus, RunPresenceRegistry, readRunStatesForListing, runEvidenceUrl } from "./runs.js";
import { RunWorkspaceIsolation, ActiveWorkspaceSession, WorkspaceSessionSummary, activeWorkspaceSessionDetails, runWorkspaceIsolation } from "./workspace.js";
import { HarnessControlPlaneStatus, SanitizedTenantControlPlaneIdentity, ActiveRunResourceStatus, HarnessVisionLock, HarnessServerStatus, HarnessProfileReadiness, HarnessStateBackendStatus, HarnessIdentityStatus, QueuedRunResourceStatus, OrphanedRunningRunResourceStatus, harnessTenantServerStatus, harnessControlPlaneStatus, controlPlaneProviderName, tenantControlPlaneIdentityKey } from "./status.js";
import { ProjectSummary, agentGitServiceProjectAgentsReadinessForProvider, readTenantProjectSummariesWithActivity, readProjectSummary, requireProjectName, listTenantProjectNames } from "./projects.js";
import { HarnessServerOptions, ControlPlaneProviderName, TenantExecutorLimits } from "./types.js";
import { compactObject, seqAfter, recordData, stringField, numberField, stringArrayField, stringArrayFieldAllowEmpty, arraysEqual, streamQueryToken, safeEqualString, bearerToken, headerValue, requireSafeName, requireString, optionalString, optionalClientId, envNameValue, optionalEnvNameValue, templateParameterValue, stringArray, positiveIntValue, positiveNumberValue, dockerMemoryValue, dockerNetworkValue, badRequest, unauthorized, forbidden, notFound, writeJson, isNotFound, startedAt, readJsonBody } from "./shared.js";

async function readBrainSignalJson(req: IncomingMessage): Promise<BrainSignalRequestBody> {
  return readJsonBody<BrainSignalRequestBody>(req);
}

async function readTenantPolicyJson(req: IncomingMessage): Promise<TenantPolicyRequestBody> {
  return readJsonBody<TenantPolicyRequestBody>(req);
}

async function readTenantPolicySettingsJson(req: IncomingMessage): Promise<TenantPolicySettingsRequestBody> {
  return readJsonBody<TenantPolicySettingsRequestBody>(req);
}

async function readTenantPolicyEscalationJson(req: IncomingMessage): Promise<TenantPolicyEscalationRequestBody> {
  return readJsonBody<TenantPolicyEscalationRequestBody>(req);
}

async function readTenantPolicyEscalationDecisionJson(req: IncomingMessage): Promise<TenantPolicyEscalationDecisionRequestBody> {
  return readJsonBody<TenantPolicyEscalationDecisionRequestBody>(req);
}

async function readTenantControlPlaneBackupManifestJson(req: IncomingMessage): Promise<unknown> {
  return readJsonBody<unknown>(req);
}


export interface TenantControlPlaneIdentity {
  provider: string;
  externalActor: string;
  actor: string;
  role: TenantRole;
}

export interface TenantPolicy {
  schemaVersion: 1;
  apiKeys?: TenantApiKey[];
  controlPlaneIdentities?: TenantControlPlaneIdentity[];
  modelKeyEnv?: string;
  executorTemplateParameters?: string[];
  limits?: TenantPolicyLimits;
  allowedTools?: string[];
}

export interface TenantPolicyLimits {
  maxActiveRuns?: number;
  maxWorkspaceSessions?: number;
  maxWorkspaceBytes?: number;
  workspaceByteWarning?: number;
  executorCpus?: number;
  executorMemory?: string;
  executorPidsLimit?: number;
  executorNetwork?: string;
  modelProjectTotalTokenWarning?: number;
  modelRequesterTotalTokenWarning?: number;
  modelProjectTotalTokenLimit?: number;
  modelRequesterTotalTokenLimit?: number;
  modelProjectCostUsdWarning?: number;
  modelRequesterCostUsdWarning?: number;
  modelProjectCostUsdLimit?: number;
  modelRequesterCostUsdLimit?: number;
}

interface TenantPolicyRequestBody {
  schemaVersion?: unknown;
  apiKeys?: unknown;
  controlPlaneIdentities?: unknown;
  modelKeyEnv?: unknown;
  executorTemplateParameters?: unknown;
  limits?: unknown;
  allowedTools?: unknown;
}

interface TenantPolicySettingsRequestBody {
  modelKeyEnv?: unknown;
  executorTemplateParameters?: unknown;
  limits?: unknown;
  allowedTools?: unknown;
  clientId?: unknown;
}

interface TenantPolicyEscalationRequestBody {
  requestedTools?: unknown;
  limits?: unknown;
  source?: unknown;
  reason?: unknown;
  clientId?: unknown;
}

interface TenantPolicyEscalationDecisionRequestBody {
  decision?: unknown;
  note?: unknown;
  clientId?: unknown;
}

interface TenantPolicyEscalation {
  schemaVersion: 1;
  id: string;
  tenant: string;
  status: "pending" | "approved" | "rejected";
  requestedTools?: string[];
  limits?: TenantPolicyLimits;
  source?: TenantPolicyEscalationSource;
  policyChange?: TenantPolicyChange;
  reason: string;
  actor?: string;
  role?: TenantRole;
  createdAt: string;
  decidedBy?: string;
  decidedRole?: TenantRole;
  decidedAt?: string;
  decisionNote?: string;
}

interface TenantPolicyEscalationSource {
  kind: "manual" | "model_usage_warning" | "workspace_usage_warning" | "workspace_pr" | "run_slot_pressure";
  project?: string;
  runId?: string;
  detail?: string;
}

interface TenantPolicyChange {
  modelKeyEnv?: TenantPolicyValueChange<string>;
  executorTemplateParameters?: TenantPolicyArrayChange;
  controlPlaneIdentities?: TenantPolicyControlPlaneIdentityChange;
  allowedTools?: TenantPolicyArrayChange;
  limits?: TenantPolicyLimitsChange;
}

interface TenantPolicyControlPlaneIdentityChange {
  before?: SanitizedTenantControlPlaneIdentity[];
  after?: SanitizedTenantControlPlaneIdentity[];
  added?: SanitizedTenantControlPlaneIdentity[];
  removed?: SanitizedTenantControlPlaneIdentity[];
}

interface TenantPolicyValueChange<T> {
  before?: T;
  after?: T;
}

interface TenantPolicyArrayChange {
  before?: string[];
  after?: string[];
  added?: string[];
  removed?: string[];
}

interface TenantPolicyLimitsChange {
  before?: TenantPolicyLimits;
  after?: TenantPolicyLimits;
  changed?: string[];
}

interface SanitizedTenantPolicy {
  schemaVersion: 1;
  apiKeys?: SanitizedTenantApiKey[];
  controlPlaneIdentities?: SanitizedTenantControlPlaneIdentity[];
  modelKeyEnv?: string;
  executorTemplateParameters?: string[];
  limits?: TenantPolicyLimits;
  allowedTools?: string[];
}

interface BrainSignalRequestBody {
  ts?: unknown;
  project?: unknown;
  runId?: unknown;
  runDir?: unknown;
  status?: unknown;
  issue?: unknown;
  issueUrl?: unknown;
  dashboardUrl?: unknown;
  summaryUrl?: unknown;
  reviewSummaryUrl?: unknown;
  handoffPackageUrl?: unknown;
  handoffFollowupsUrl?: unknown;
  failureKind?: unknown;
  modelRequestCount?: unknown;
  modelPromptTokens?: unknown;
  modelCompletionTokens?: unknown;
  modelTotalTokens?: unknown;
  modelCostUsd?: unknown;
  skills?: unknown;
  outcome?: unknown;
  notes?: unknown;
  clientId?: unknown;
}

interface TenantBrainSignalFeedEntry {
  seq: number;
  ts: string;
  source: "completed_run" | "workspace_signal" | "workspace_conflict" | "vas_learning";
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  project?: string;
  caseId?: string;
  runId?: string;
  operation?: string;
  path?: string;
  expectedUpdatedAt?: string;
  observedUpdatedAt?: string;
  observedKind?: string;
  activeEditorCount?: number;
  status?: string;
  issue?: string;
  issueUrl?: string;
  dashboardUrl?: string;
  summaryUrl?: string;
  reviewSummaryUrl?: string;
  handoffPackageUrl?: string;
  handoffFollowupsUrl?: string;
  outcome?: string;
  failureKind?: string;
  reviewerStatus?: string;
  reviewerExitCode?: number;
  reviewerCommands?: unknown;
  modelRequestCount?: number;
  modelPromptTokens?: number;
  modelCompletionTokens?: number;
  modelTotalTokens?: number;
  modelCostUsd?: number;
  learningCount?: number;
  skillCount?: number;
}

interface TenantBrainSignalFeedResponse {
  tenant: string;
  count: number;
  signals: TenantBrainSignalFeedEntry[];
}

type TenantAccess = TenantAuditActor & { modelKeyEnv?: string };

interface TenantHarnessServerStatus {
  tenant: string;
  server: {
    startedAt: string;
    uptimeMs: number;
    controlPlane: HarnessControlPlaneStatus;
    runWorkspaceIsolation: RunWorkspaceIsolation;
    runCreateIdempotency: RunCreateIdempotencyStatus;
    concurrencyAdmission: HarnessConcurrencyAdmissionStatus;
    stateBackend: HarnessStateBackendStatus;
    identity?: HarnessIdentityStatus;
  };
  readiness: HarnessProfileReadiness;
  visionLock: HarnessVisionLock;
  limits: HarnessServerStatus["limits"];
  policy: {
    allowedTools: string[];
  };
  resources: {
    activeRuns: number;
    activeRunDetails?: ActiveRunResourceStatus[];
    queuedRuns: number;
    activeWorkspaceSessions: number;
    activeWorkspaceSessionDetails: WorkspaceSessionSummary[];
    orphanedRunningRunDetails: Array<Omit<OrphanedRunningRunResourceStatus, "runDir">>;
    queuedRunDetails: QueuedRunResourceStatus[];
  };
}

interface TenantModelUsageWarningListResponse {
  tenant: string;
  projects: ProjectSummary[];
}

interface TenantControlPlaneBackupManifest {
  schemaVersion: 1;
  tenant: string;
  generatedAt: string;
  controlPlane: HarnessControlPlaneStatus;
  policy: SanitizedTenantPolicy & { apiKeyCount: number };
  audit: {
    eventCount: number;
    lastSeq?: number;
    lastEventAt?: string;
  };
  projects: TenantControlPlaneBackupProject[];
}

interface TenantControlPlaneBackupProject {
  project: string;
  summary: ProjectSummary;
  runs: TenantControlPlaneBackupRun[];
}

interface TenantControlPlaneBackupRun {
  runId: string;
  status: ReadableRunState["status"];
  goal: string;
  startedAt?: string;
  queuedAt?: string;
  metadata?: RunMetadata;
  requester?: RunRequesterSummary;
}

interface TenantControlPlaneRestoreDryRunResult {
  schemaVersion: 1;
  tenant: string;
  mode: "dry-run";
  valid: true;
  applied: false;
  provider: ControlPlaneProviderCatalogName;
  sourceProvider: ControlPlaneProviderName;
  targetProvider: ControlPlaneProviderCatalogName;
  format: "tenant-control-plane-backup-v1";
  projects: {
    expected: number;
    existing: number;
    names: string[];
    missing: string[];
    extra: string[];
  };
  runs: {
    expected: number;
  };
  audit: {
    eventCount: number;
  };
  secretScrubbed: true;
  cutoverReadiness?: TenantControlPlaneCutoverReadiness;
}

interface TenantControlPlaneCutoverReadiness {
  stage: "tenant-default-cutover";
  targetProvider: ControlPlaneProviderCatalogName;
  ok: boolean;
  checks: {
    agentGitServiceProjectAgents?: Omit<HarnessProfileReadiness["checks"]["agentGitServiceProjectAgents"], "required">;
  };
}

async function effectiveTenantExecutorLimits(options: HarnessServerOptions, tenant: string): Promise<TenantExecutorLimits | undefined> {
  const limits = (await readTenantPolicy(resolve(options.workspaceRoot), tenant, options))?.limits;
  const executorLimits = compactObject({
    cpus: limits?.executorCpus,
    memory: limits?.executorMemory,
    pidsLimit: limits?.executorPidsLimit,
    network: limits?.executorNetwork,
  });
  return Object.keys(executorLimits).length ? executorLimits : undefined;
}

async function effectiveTenantExecutorTemplateParameters(options: HarnessServerOptions, tenant: string): Promise<string[] | undefined> {
  return (await readTenantPolicy(resolve(options.workspaceRoot), tenant, options))?.executorTemplateParameters;
}

async function effectiveTenantAllowedTools(options: HarnessServerOptions, tenant: string): Promise<string[]> {
  const serverTools = options.allowedTools ?? [];
  const policy = await readTenantPolicy(resolve(options.workspaceRoot), tenant, options);
  if (policy?.allowedTools === undefined) return serverTools;
  const denied = policy.allowedTools.filter((tool) => !serverTools.includes(tool));
  if (denied.length) {
    throw badRequest(`tenant policy allowedTools not permitted by server: ${denied.join(", ")}`);
  }
  return [...new Set(policy.allowedTools)];
}

async function requireTenantTool(options: HarnessServerOptions, tenant: string, tool: string, message: string): Promise<void> {
  const allowedTools = await effectiveTenantAllowedTools(options, tenant);
  if (!allowedTools.includes(tool)) {
    throw badRequest(message);
  }
}

function readTenantPolicySync(workspaceRoot: string, tenant: string): TenantPolicy | undefined {
  try {
    return tenantPolicyFromUnknown(JSON.parse(readFileSync(tenantPolicyPath(workspaceRoot, tenant), "utf8")));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function handleListTenantPolicyEscalations(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "policy" || segments[3] !== "escalations") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  writeJson(res, 200, await readTenantPolicyEscalations(workspaceRoot, tenant));
  return true;
}

async function handleCreateTenantPolicyEscalation(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "policy" || segments[3] !== "escalations") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url);
  const body = await readTenantPolicyEscalationJson(req);
  const clientId = optionalClientId(body.clientId);
  const escalation = tenantPolicyEscalationFromBody(tenant, body, access);
  await writeTenantPolicyEscalation(workspaceRoot, tenant, escalation);
  await appendAuditEvent(tenant, "tenant_policy_escalation_requested", compactObject({
    ...tenantPolicyEscalationAuditData(escalation),
    clientId,
  }), access);
  writeJson(res, 201, escalation);
  return true;
}

async function handleCreateBrainSignal(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "brain" || segments[3] !== "signals") return false;

  if (!options.brainSignalIngest) {
    throw badRequest("brain signal ingest is not configured.");
  }
  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const body = await readBrainSignalJson(req);
  const { signal, clientId } = brainSignalFromBody(body);
  await options.brainSignalIngest(signal);
  await appendAuditEvent(tenant, "brain_signal_ingested", compactObject({
    source: "workspace_signal",
    project: signal.project,
    runId: signal.runId,
    status: signal.status,
    issue: signal.issue,
    issueUrl: signal.issueUrl,
    dashboardUrl: signal.dashboardUrl,
    summaryUrl: signal.summaryUrl,
    reviewSummaryUrl: signal.reviewSummaryUrl,
    handoffPackageUrl: signal.handoffPackageUrl,
    handoffFollowupsUrl: signal.handoffFollowupsUrl,
    outcome: signal.outcome,
    failureKind: signal.failureKind,
    modelRequestCount: signal.modelRequestCount,
    modelPromptTokens: signal.modelPromptTokens,
    modelCompletionTokens: signal.modelCompletionTokens,
    modelTotalTokens: signal.modelTotalTokens,
    modelCostUsd: signal.modelCostUsd,
    skillCount: signal.skills.length,
    clientId,
  }), access);
  writeJson(res, 202, {
    ingested: true,
    tenant,
    project: signal.project,
    runId: signal.runId,
    dashboardUrl: signal.dashboardUrl,
    summaryUrl: signal.summaryUrl,
    reviewSummaryUrl: signal.reviewSummaryUrl,
    handoffPackageUrl: signal.handoffPackageUrl,
    handoffFollowupsUrl: signal.handoffFollowupsUrl,
    outcome: signal.outcome,
    failureKind: signal.failureKind,
    modelRequestCount: signal.modelRequestCount,
    modelPromptTokens: signal.modelPromptTokens,
    modelCompletionTokens: signal.modelCompletionTokens,
    modelTotalTokens: signal.modelTotalTokens,
    modelCostUsd: signal.modelCostUsd,
    skills: signal.skills,
  });
  return true;
}

async function handleReadTenantBrainSignals(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "brain" || segments[3] !== "signals") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = auditProjectFilter(url);
  const runId = brainSignalRunFilter(url);
  const signals = filterTenantBrainSignalEvents(await readTenantAuditEvents(workspaceRoot, tenant, options.stateBackend?.events), seqAfter(url), auditLimit(url), project, runId)
    .map(tenantBrainSignalFeedEntry);
  const body: TenantBrainSignalFeedResponse = {
    tenant,
    count: signals.length,
    signals,
  };
  writeJson(res, 200, body);
  return true;
}

async function handleDecideTenantPolicyEscalation(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 6) return false;
  if (segments[0] !== "tenants" || segments[2] !== "policy" || segments[3] !== "escalations" || segments[5] !== "decision") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const escalationId = requireSafeName(segments[4], "escalationId");
  const body = await readTenantPolicyEscalationDecisionJson(req);
  const clientId = optionalClientId(body.clientId);
  const decision = tenantPolicyEscalationDecision(body.decision);
  const note = optionalString(body.note, "note");
  const escalation = await readTenantPolicyEscalation(workspaceRoot, tenant, escalationId);
  if (escalation.status !== "pending") {
    throw badRequest("tenant policy escalation is already decided.");
  }

  let policy: TenantPolicy | undefined;
  let policyChange: TenantPolicyChange | undefined;
  if (decision === "approved") {
    const currentPolicy = await readTenantPolicy(workspaceRoot, tenant, options);
    policy = mergeApprovedTenantPolicyEscalation(currentPolicy, escalation, options);
    policyChange = tenantPolicyEscalationPolicyChange(currentPolicy, policy, escalation);
  }

  const decided = compactObject({
    ...escalation,
    status: decision,
    policyChange,
    decidedBy: access?.actor,
    decidedRole: access?.role,
    decidedAt: new Date().toISOString(),
    decisionNote: note,
  });

  if (policy) {
    await writeTenantPolicy(workspaceRoot, tenant, policy, options);
    await appendAuditEvent(tenant, "tenant_policy_updated", compactObject({
      ...tenantPolicyAuditData(policy),
      escalationId,
      policyChange,
      clientId,
    }), access);
  }

  await writeTenantPolicyEscalation(workspaceRoot, tenant, decided);
  await appendAuditEvent(tenant, "tenant_policy_escalation_decided", compactObject({
    escalationId,
    decision,
    note,
    policyChange,
    clientId,
  }), access);
  writeJson(res, 200, decided);
  return true;
}

async function handleReadTenantPolicy(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3) return false;
  if (segments[0] !== "tenants" || segments[2] !== "policy") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  writeJson(res, 200, sanitizeTenantPolicy(await readTenantPolicy(workspaceRoot, tenant, options)));
  return true;
}

async function handleReadTenantAccess(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3) return false;
  if (segments[0] !== "tenants" || segments[2] !== "access") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url);
  writeJson(res, 200, {
    tenant,
    actor: access?.actor ?? "anonymous",
    role: access?.role ?? "admin",
    authenticated: Boolean(access),
  });
  return true;
}

async function handleReadTenantStatus(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  allowedTools: string[],
  startedAt: string,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  queuedRuns: QueuedRun[],
  activeSessions: Map<string, ActiveWorkspaceSession>,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3) return false;
  if (segments[0] !== "tenants" || segments[2] !== "status") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  writeJson(
    res,
    200,
    await harnessTenantServerStatus(tenant, workspaceRoot, options, allowedTools, startedAt, activeRunSlots, activeWorkspaces, queuedRuns, activeSessions),
  );
  return true;
}

async function handleReadTenantControlPlaneBackup(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "control-plane" || segments[3] !== "backup") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url, "admin");
  writeJson(res, 200, await tenantControlPlaneBackupManifest(workspaceRoot, tenant, options));
  return true;
}

async function handleReadTenantControlPlaneCutoverReadiness(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "control-plane" || segments[3] !== "cutover-readiness") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url, "admin");
  const targetProvider = tenantControlPlaneRestoreTargetProvider(url, options);
  const readiness = await tenantControlPlaneCutoverReadiness(workspaceRoot, tenant, options, targetProvider);
  if (!readiness) {
    throw badRequest("tenant control-plane cutover readiness currently supports targetProvider=agent-git-service.");
  }
  writeJson(res, 200, readiness);
  return true;
}

async function handleTenantControlPlaneRestoreDryRun(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "control-plane" || segments[3] !== "restore-dry-run") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const manifest = await readTenantControlPlaneBackupManifestJson(req);
  const result = await tenantControlPlaneRestoreDryRun(workspaceRoot, tenant, options, manifest, tenantControlPlaneRestoreTargetProvider(url, options));
  await appendAuditEvent(tenant, "tenant_control_plane_restore_dry_run", tenantControlPlaneRestoreDryRunAuditData(result), access);
  writeJson(res, 200, result);
  return true;
}

async function handleUpdateTenantPolicy(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3) return false;
  if (segments[0] !== "tenants" || segments[2] !== "policy") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const policy = tenantPolicyFromUnknown(await readTenantPolicyJson(req));
  const denied = (policy.allowedTools ?? []).filter((tool) => !(options.allowedTools ?? []).includes(tool));
  if (denied.length) {
    throw badRequest(`tenant policy allowedTools not permitted by server: ${denied.join(", ")}`);
  }

  const existing = await readTenantPolicy(workspaceRoot, tenant, options);
  const policyChange = tenantPolicyReplacementChange(existing, policy);
  await writeTenantPolicy(workspaceRoot, tenant, policy, options);
  await appendAuditEvent(tenant, "tenant_policy_updated", compactObject({
    ...tenantPolicyAuditData(policy),
    policyChange,
  }), access);
  writeJson(res, 200, sanitizeTenantPolicy(policy));
  return true;
}

async function handleUpdateTenantPolicySettings(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "policy" || segments[3] !== "settings") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const body = tenantPolicySettingsFromUnknown(await readTenantPolicySettingsJson(req));
  const clientId = optionalClientId(body.clientId);
  const existing = await readTenantPolicy(workspaceRoot, tenant, options);
  const policy = mergeTenantPolicySettings(existing, body, options);
  const policyChange = tenantPolicySettingsChange(existing, policy, body);
  await writeTenantPolicy(workspaceRoot, tenant, policy, options);
  await appendAuditEvent(tenant, "tenant_policy_updated", compactObject({
    ...tenantPolicyAuditData(policy),
    policyChange,
    clientId,
  }), access);
  writeJson(res, 200, sanitizeTenantPolicy(policy));
  return true;
}

async function handleReadTenantAudit(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 && segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "audit") return false;
  const stream = segments.length === 4 && segments[3] === "stream";
  if (segments.length === 4 && !stream) return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const projectFilter = auditProjectFilter(url);
  if (stream) {
    await streamTenantAuditEvents(res, workspaceRoot, tenant, seqAfter(url, req), projectFilter, options.stateBackend?.events);
    return true;
  }

  writeJson(
    res,
    200,
    filterTenantAuditEvents(await readTenantAuditEvents(workspaceRoot, tenant, options.stateBackend?.events), seqAfter(url), auditLimit(url), projectFilter),
  );
  return true;
}

async function handleListTenantModelUsageWarnings(
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
  if (segments[0] !== "tenants" || segments[2] !== "model-usage" || segments[3] !== "warnings") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);

  try {
    const projects = (await readTenantProjectSummariesWithActivity(workspaceRoot, options, tenant, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, projectPresence, runPresence))
      .filter((project) => Array.isArray(project.modelUsageWarnings) && project.modelUsageWarnings.length > 0);
    const response: TenantModelUsageWarningListResponse = { tenant, projects };
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

async function tenantControlPlaneBackupManifest(
  workspaceRoot: string,
  tenant: string,
  options: HarnessServerOptions,
): Promise<TenantControlPlaneBackupManifest> {
  const policy = await readTenantPolicy(workspaceRoot, tenant, options);
  const auditEvents = await readTenantAuditEvents(workspaceRoot, tenant, options.stateBackend?.events);
  const lastAudit = auditEvents[auditEvents.length - 1];
  const projectNames = await listTenantProjectNames(workspaceRoot, tenant);
  const tenantRoot = join(workspaceRoot, tenant);
  const projects = await Promise.all(projectNames.map(async (project) => ({
    project,
    summary: await readProjectSummary(tenantRoot, tenant, project, policy?.limits),
    runs: await tenantControlPlaneBackupRuns(workspaceRoot, tenant, project, options),
  })));
  projects.sort((a, b) => a.project.localeCompare(b.project));
  return {
    schemaVersion: 1,
    tenant,
    generatedAt: new Date().toISOString(),
    controlPlane: harnessControlPlaneStatus(options),
    policy: {
      ...sanitizeTenantPolicy(policy),
      apiKeyCount: policy?.apiKeys?.length ?? 0,
    },
    audit: compactObject({
      eventCount: auditEvents.length,
      lastSeq: lastAudit?.seq,
      lastEventAt: lastAudit?.ts,
    }),
    projects,
  };
}

async function tenantControlPlaneBackupRuns(
  workspaceRoot: string,
  tenant: string,
  project: string,
  options: HarnessServerOptions,
): Promise<TenantControlPlaneBackupRun[]> {
  try {
    const states = await readRunStatesForListing(join(workspaceRoot, tenant, project, ".loom", "runs"), tenant, project, options);
    states.sort((a, b) => startedAt(b).localeCompare(startedAt(a)));
    return states.map((state) => compactObject({
      runId: state.runId,
      status: state.status,
      goal: state.goal,
      startedAt: "startedAt" in state ? state.startedAt : undefined,
      queuedAt: "queuedAt" in state ? state.queuedAt : undefined,
      metadata: state.metadata,
      requester: state.requester,
    }));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function tenantControlPlaneRestoreTargetProvider(
  url: URL,
  options: HarnessServerOptions,
): ControlPlaneProviderCatalogName {
  const value = url.searchParams.get("targetProvider");
  if (value === null) return controlPlaneProviderName(options);
  const provider = value.trim();
  const catalogEntry = controlPlaneProviderCatalogEntry(provider);
  if (!catalogEntry) {
    throw badRequest("targetProvider must be a supported control-plane provider.");
  }
  return catalogEntry.name;
}

async function tenantControlPlaneRestoreDryRun(
  workspaceRoot: string,
  tenant: string,
  options: HarnessServerOptions,
  value: unknown,
  targetProvider: ControlPlaneProviderCatalogName,
): Promise<TenantControlPlaneRestoreDryRunResult> {
  if (tenantControlPlaneBackupManifestContainsSecret(value)) {
    throw badRequest("tenant control-plane backup manifest contains secret material.");
  }
  const manifest = tenantControlPlaneBackupManifestRecord(value);
  const schemaVersion = manifest.schemaVersion;
  if (schemaVersion !== 1) throw badRequest("tenant control-plane backup manifest schemaVersion must be 1.");
  if (manifest.tenant !== tenant) throw badRequest("tenant control-plane backup manifest tenant does not match the route tenant.");

  const controlPlane = recordData(manifest.controlPlane);
  const provider = stringField(controlPlane, "provider");
  const sourceProvider = controlPlaneProviderName(options);
  if (provider !== sourceProvider) {
    throw badRequest("tenant control-plane backup manifest provider does not match this server.");
  }
  const boundary = stringArrayFieldAllowEmpty(controlPlane, "boundary") ?? [];
  const missingBoundary = CONTROL_PLANE_PROVIDER_BOUNDARY.filter((capability) => !boundary.includes(capability));
  if (missingBoundary.length) {
    throw badRequest(`tenant control-plane backup manifest is missing control-plane boundary: ${missingBoundary.join(", ")}.`);
  }
  const targetProviderEntry = controlPlaneProviderCatalogEntry(targetProvider);
  const missingTargetBoundary = CONTROL_PLANE_PROVIDER_BOUNDARY.filter((capability) => !targetProviderEntry?.boundary.includes(capability));
  if (missingTargetBoundary.length) {
    throw badRequest(`target control-plane provider ${targetProvider} is missing control-plane boundary: ${missingTargetBoundary.join(", ")}.`);
  }

  const projectEntries = tenantControlPlaneBackupManifestProjects(manifest.projects);
  const expectedProjects = projectEntries.map((entry) => entry.project).sort((a, b) => a.localeCompare(b));
  const existingProjects = (await listTenantProjectNames(workspaceRoot, tenant)).sort((a, b) => a.localeCompare(b));
  const expectedProjectSet = new Set(expectedProjects);
  const existingProjectSet = new Set(existingProjects);
  const missing = expectedProjects.filter((project) => !existingProjectSet.has(project));
  const extra = existingProjects.filter((project) => !expectedProjectSet.has(project));
  const expectedRuns = projectEntries.reduce((sum, entry) => sum + entry.runs.length, 0);
  const audit = recordData(manifest.audit);
  const eventCount = numberField(audit, "eventCount");
  if (eventCount === undefined || eventCount < 0) {
    throw badRequest("tenant control-plane backup manifest audit.eventCount must be a non-negative number.");
  }
  const cutoverReadiness = await tenantControlPlaneCutoverReadiness(workspaceRoot, tenant, options, targetProvider);

  return compactObject({
    schemaVersion: 1,
    tenant,
    mode: "dry-run",
    valid: true,
    applied: false,
    provider: targetProvider,
    sourceProvider,
    targetProvider,
    format: "tenant-control-plane-backup-v1",
    projects: {
      expected: expectedProjects.length,
      existing: existingProjects.length,
      names: expectedProjects,
      missing,
      extra,
    },
    runs: {
      expected: expectedRuns,
    },
    audit: {
      eventCount,
    },
    secretScrubbed: true,
    cutoverReadiness,
  }) as TenantControlPlaneRestoreDryRunResult;
}

async function tenantControlPlaneCutoverReadiness(
  workspaceRoot: string,
  tenant: string,
  options: HarnessServerOptions,
  targetProvider: ControlPlaneProviderCatalogName,
): Promise<TenantControlPlaneCutoverReadiness | undefined> {
  if (targetProvider !== "agent-git-service") return undefined;
  const agentGitServiceProjectAgents = await agentGitServiceProjectAgentsReadinessForProvider(
    workspaceRoot,
    options,
    targetProvider,
    tenant,
  );
  return {
    stage: "tenant-default-cutover",
    targetProvider,
    ok: agentGitServiceProjectAgents.ok,
    checks: {
      agentGitServiceProjectAgents,
    },
  };
}

function tenantControlPlaneBackupManifestRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("tenant control-plane backup manifest must be an object.");
  }
  return value as Record<string, unknown>;
}

function tenantControlPlaneBackupManifestProjects(value: unknown): Array<{ project: string; runs: unknown[] }> {
  if (!Array.isArray(value)) throw badRequest("tenant control-plane backup manifest projects must be an array.");
  return value.map((entry, index) => {
    const projectEntry = recordData(entry);
    if (!Object.keys(projectEntry).length) {
      throw badRequest(`tenant control-plane backup manifest projects[${index}] must be an object.`);
    }
    const project = requireProjectName(projectEntry.project, `projects[${index}].project`);
    const runs = projectEntry.runs;
    if (!Array.isArray(runs)) {
      throw badRequest(`tenant control-plane backup manifest projects[${index}].runs must be an array.`);
    }
    for (const [runIndex, run] of runs.entries()) {
      const runEntry = recordData(run);
      if (!stringField(runEntry, "runId")) {
        throw badRequest(`tenant control-plane backup manifest projects[${index}].runs[${runIndex}].runId is required.`);
      }
    }
    return { project, runs };
  });
}

function tenantControlPlaneBackupManifestContainsSecret(value: unknown): boolean {
  if (typeof value === "string") return value.includes("sha256:");
  if (Array.isArray(value)) return value.some((entry) => tenantControlPlaneBackupManifestContainsSecret(entry));
  if (typeof value !== "object" || value === null) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "token" || key === "tokenHash") return true;
    if (tenantControlPlaneBackupManifestContainsSecret(entry)) return true;
  }
  return false;
}

function tenantControlPlaneRestoreDryRunAuditData(result: TenantControlPlaneRestoreDryRunResult): Record<string, unknown> {
  const agentGitServiceProjectAgents = result.cutoverReadiness?.checks.agentGitServiceProjectAgents;
  return compactObject({
    provider: result.provider,
    sourceProvider: result.sourceProvider,
    targetProvider: result.targetProvider,
    format: result.format,
    projectCount: result.projects.expected,
    projects: result.projects.names,
    runCount: result.runs.expected,
    missingProjectCount: result.projects.missing.length,
    extraProjectCount: result.projects.extra.length,
    auditEventCount: result.audit.eventCount,
    secretScrubbed: result.secretScrubbed,
    cutoverReady: result.cutoverReadiness?.ok,
    agentGitServiceProjectAgentsMissingProjects: agentGitServiceProjectAgents?.missingProjects.length
      ? agentGitServiceProjectAgents.missingProjects
      : undefined,
    agentGitServiceProjectAgentsMissingSecretProjects: agentGitServiceProjectAgents?.missingSecretProjects.length
      ? agentGitServiceProjectAgents.missingSecretProjects
      : undefined,
  });
}

function brainSignalAuditData(summary: RunSummary): Record<string, unknown> {
  return compactObject({
    source: "completed_run",
    project: summary.metadata?.project,
    runId: summary.runId,
    status: summary.status,
    issue: summary.metadata?.issue,
    issueUrl: summary.metadata?.issueUrl,
    dashboardUrl: summary.metadata?.dashboardUrl,
    summaryUrl: summary.metadata?.summaryUrl,
    reviewSummaryUrl: summary.metadata?.summaryUrl ? runEvidenceUrl(summary.metadata.summaryUrl, "review-summary") : undefined,
    handoffPackageUrl: summary.metadata?.summaryUrl ? runEvidenceUrl(summary.metadata.summaryUrl, "handoff-package") : undefined,
    handoffFollowupsUrl: summary.metadata?.summaryUrl ? runEvidenceUrl(summary.metadata.summaryUrl, "handoff-runs") : undefined,
    outcome: summary.status === "failed" || summary.status === "error" ? "fail" : "pass",
    failureKind: brainSignalFailureKind(summary),
    reviewerStatus: summary.reviewer ? (summary.reviewer.ok ? "passed" : "flagged") : undefined,
    reviewerExitCode: summary.reviewer?.exitCode,
    reviewerCommands: summary.reviewer?.commands.length ? summary.reviewer.commands : undefined,
    modelRequestCount: summary.modelUsage?.requestCount,
    modelPromptTokens: summary.modelUsage?.promptTokens,
    modelCompletionTokens: summary.modelUsage?.completionTokens,
    modelTotalTokens: summary.modelUsage?.totalTokens,
    modelCostUsd: summary.modelUsage?.costUsd,
    skillCount: summary.skills.length,
  });
}

function brainSignalFailureKind(summary: RunSummary): string | undefined {
  return brainFailureKindForSummary(summary);
}

function auditLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return 100;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw badRequest("limit must be an integer between 1 and 500.");
  }
  return parsed;
}

function auditProjectFilter(url: URL): string | undefined {
  const raw = url.searchParams.get("project");
  if (raw === null || raw === "") return undefined;
  return requireProjectName(raw, "project");
}

function brainSignalRunFilter(url: URL): string | undefined {
  const raw = url.searchParams.get("runId");
  if (raw === null || raw === "") return undefined;
  return requireSafeName(raw, "runId");
}

function filterTenantAuditEvents(events: TenantAuditEvent[], after: number, limit: number, project?: string): TenantAuditEvent[] {
  return events
    .filter((event) => event.seq > after)
    .filter((event) => !project || recordData(event.data).project === project)
    .slice(0, limit);
}

function filterTenantBrainSignalEvents(
  events: TenantAuditEvent[],
  after: number,
  limit: number,
  project?: string,
  runId?: string,
): TenantAuditEvent[] {
  return events
    .filter((event) => event.type === "brain_signal_ingested" || event.type === "workspace_file_conflicted")
    .filter((event) => event.seq > after)
    .filter((event) => !project || recordData(event.data).project === project)
    .filter((event) => !runId || recordData(event.data).runId === runId)
    .slice(0, limit);
}

function tenantBrainSignalFeedEntry(event: TenantAuditEvent): TenantBrainSignalFeedEntry {
  const data = recordData(event.data);
  return compactObject({
    seq: event.seq,
    ts: event.ts,
    source: brainSignalSource(data, event),
    actor: event.actor,
    role: event.role,
    clientId: stringField(data, "clientId"),
    project: stringField(data, "project"),
    caseId: stringField(data, "caseId"),
    runId: stringField(data, "runId"),
    operation: stringField(data, "operation"),
    path: stringField(data, "path"),
    expectedUpdatedAt: stringField(data, "expectedUpdatedAt"),
    observedUpdatedAt: stringField(data, "observedUpdatedAt"),
    observedKind: stringField(data, "observedKind"),
    activeEditorCount: numberField(data, "activeEditorCount"),
    status: stringField(data, "status"),
    issue: stringField(data, "issue"),
    issueUrl: stringField(data, "issueUrl"),
    dashboardUrl: stringField(data, "dashboardUrl"),
    summaryUrl: stringField(data, "summaryUrl"),
    reviewSummaryUrl: stringField(data, "reviewSummaryUrl"),
    handoffPackageUrl: stringField(data, "handoffPackageUrl"),
    handoffFollowupsUrl: stringField(data, "handoffFollowupsUrl"),
    outcome: stringField(data, "outcome"),
    failureKind: stringField(data, "failureKind"),
    reviewerStatus: stringField(data, "reviewerStatus"),
    reviewerExitCode: numberField(data, "reviewerExitCode"),
    reviewerCommands: stringArrayField(data, "reviewerCommands"),
    modelRequestCount: numberField(data, "modelRequestCount"),
    modelPromptTokens: numberField(data, "modelPromptTokens"),
    modelCompletionTokens: numberField(data, "modelCompletionTokens"),
    modelTotalTokens: numberField(data, "modelTotalTokens"),
    modelCostUsd: numberField(data, "modelCostUsd"),
    learningCount: numberField(data, "learningCount"),
    skillCount: numberField(data, "skillCount"),
  });
}

function brainSignalSource(data: Record<string, unknown>, event: TenantAuditEvent): TenantBrainSignalFeedEntry["source"] {
  if (event.type === "workspace_file_conflicted") return "workspace_conflict";
  if (data.source === "completed_run" || data.source === "workspace_signal" || data.source === "vas_learning") return data.source;
  return event.actor || stringField(data, "clientId") ? "workspace_signal" : "completed_run";
}

function runTenantAuditTrail(events: TenantAuditEvent[], project: string, runId: string): TenantAuditEvent[] {
  return events.filter((event) => {
    const data = recordData(event.data);
    return data.project === project && (data.runId === runId || data.followupRunId === runId);
  });
}

function tenantRoleField(data: Record<string, unknown>, key: string): TenantRole | undefined {
  const value = data[key];
  return value === "admin" || value === "developer" || value === "viewer" ? value : undefined;
}

async function streamTenantAuditEvents(
  res: ServerResponse,
  workspaceRoot: string,
  tenant: string,
  after: number,
  project?: string,
  eventStore?: import("../storage/contracts.js").EventStore,
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
    const events = filterTenantAuditEvents(await readTenantAuditEvents(workspaceRoot, tenant, eventStore), lastSeq, 500, project);
    for (const event of events) {
      lastSeq = Math.max(lastSeq, event.seq);
      res.write(`event: tenant_audit\n`);
      res.write(`id: ${event.seq}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  res.end();
}

async function readTenantPolicy(workspaceRoot: string, tenant: string, options?: HarnessServerOptions): Promise<TenantPolicy | undefined> {
  const stored = await options?.stateBackend?.documents.get<unknown>("tenant-policy", tenant);
  if (stored) return tenantPolicyFromUnknown(stored.value);
  try {
    return tenantPolicyFromUnknown(JSON.parse(await readFile(tenantPolicyPath(workspaceRoot, tenant), "utf8")));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeTenantPolicy(workspaceRoot: string, tenant: string, policy: TenantPolicy, options?: HarnessServerOptions): Promise<void> {
  await options?.stateBackend?.documents.put("tenant-policy", tenant, policy);
  await mkdir(tenantPolicyDir(workspaceRoot, tenant), { recursive: true });
  await writeFile(tenantPolicyPath(workspaceRoot, tenant), JSON.stringify(policy, null, 2) + "\n", "utf8");
}

function tenantPolicyFromUnknown(value: unknown): TenantPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("tenant policy must be an object.");
  }
  const input = value as TenantPolicyRequestBody;
  if (input.schemaVersion !== 1) {
    throw badRequest("tenant policy schemaVersion must be 1.");
  }
  return compactObject({
    schemaVersion: 1 as const,
    apiKeys: parseTenantPolicyApiKeys(input.apiKeys),
    controlPlaneIdentities: tenantPolicyControlPlaneIdentities(input.controlPlaneIdentities),
    modelKeyEnv: input.modelKeyEnv === undefined ? undefined : envNameValue(input.modelKeyEnv, "modelKeyEnv"),
    executorTemplateParameters: input.executorTemplateParameters === undefined
      ? undefined
      : tenantPolicyTemplateParameters(input.executorTemplateParameters),
    limits: tenantPolicyLimits(input.limits),
    allowedTools: input.allowedTools === undefined ? undefined : [...new Set(stringArray(input.allowedTools, "allowedTools"))],
  });
}

function tenantPolicyControlPlaneIdentities(value: unknown): TenantControlPlaneIdentity[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw badRequest("controlPlaneIdentities must be an array.");
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw badRequest(`controlPlaneIdentities[${index}] must be an object.`);
    }
    const identity = entry as Record<string, unknown>;
    const provider = tenantPolicyControlPlaneIdentityProvider(identity.provider, `controlPlaneIdentities[${index}].provider`);
    return {
      provider,
      externalActor: tenantPolicyControlPlaneIdentityActor(identity.externalActor, `controlPlaneIdentities[${index}].externalActor`),
      actor: tenantPolicyApiKeyActor(identity.actor),
      role: tenantPolicyRole(identity.role, `controlPlaneIdentities[${index}].role`),
    };
  });
}

function tenantPolicyControlPlaneIdentityProvider(value: unknown, field: string): string {
  const provider = requireString(value, field).trim();
  if (!controlPlaneProviderCatalogEntry(provider)) {
    throw badRequest(`${field} must be a supported control-plane provider.`);
  }
  return provider;
}

function tenantPolicyControlPlaneIdentityActor(value: unknown, field: string): string {
  const actor = requireString(value, field).trim();
  if (actor.length > 160 || /[\0\r\n]/.test(actor)) {
    throw badRequest(`${field} must be a single-line string at most 160 characters.`);
  }
  return actor;
}

function tenantPolicyApiKeyActor(value: unknown): string {
  const actor = requireString(value, "actor").trim();
  if (actor.length > 120 || /[\0\r\n]/.test(actor)) {
    throw badRequest("actor must be a single-line string at most 120 characters.");
  }
  return actor;
}

function tenantPolicyRole(value: unknown, field: string): TenantRole {
  if (value !== "admin" && value !== "developer" && value !== "viewer") {
    throw badRequest(`${field} must be admin, developer, or viewer.`);
  }
  return value;
}

function tenantPolicyLimits(value: unknown): TenantPolicyLimits | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("limits must be an object.");
  }
  const input = value as Record<string, unknown>;
  return compactObject({
    maxActiveRuns: input.maxActiveRuns === undefined ? undefined : positiveIntValue(input.maxActiveRuns, "limits.maxActiveRuns"),
    maxWorkspaceSessions: input.maxWorkspaceSessions === undefined ? undefined : positiveIntValue(input.maxWorkspaceSessions, "limits.maxWorkspaceSessions"),
    maxWorkspaceBytes: input.maxWorkspaceBytes === undefined ? undefined : positiveIntValue(input.maxWorkspaceBytes, "limits.maxWorkspaceBytes"),
    workspaceByteWarning: input.workspaceByteWarning === undefined ? undefined : positiveIntValue(input.workspaceByteWarning, "limits.workspaceByteWarning"),
    executorCpus: input.executorCpus === undefined ? undefined : positiveNumberValue(input.executorCpus, "limits.executorCpus"),
    executorMemory: input.executorMemory === undefined ? undefined : dockerMemoryValue(input.executorMemory, "limits.executorMemory"),
    executorPidsLimit: input.executorPidsLimit === undefined ? undefined : positiveIntValue(input.executorPidsLimit, "limits.executorPidsLimit"),
    executorNetwork: input.executorNetwork === undefined ? undefined : dockerNetworkValue(input.executorNetwork, "limits.executorNetwork"),
    modelProjectTotalTokenWarning: input.modelProjectTotalTokenWarning === undefined ? undefined : positiveIntValue(input.modelProjectTotalTokenWarning, "limits.modelProjectTotalTokenWarning"),
    modelRequesterTotalTokenWarning: input.modelRequesterTotalTokenWarning === undefined ? undefined : positiveIntValue(input.modelRequesterTotalTokenWarning, "limits.modelRequesterTotalTokenWarning"),
    modelProjectTotalTokenLimit: input.modelProjectTotalTokenLimit === undefined ? undefined : positiveIntValue(input.modelProjectTotalTokenLimit, "limits.modelProjectTotalTokenLimit"),
    modelRequesterTotalTokenLimit: input.modelRequesterTotalTokenLimit === undefined ? undefined : positiveIntValue(input.modelRequesterTotalTokenLimit, "limits.modelRequesterTotalTokenLimit"),
    modelProjectCostUsdWarning: input.modelProjectCostUsdWarning === undefined ? undefined : positiveNumberValue(input.modelProjectCostUsdWarning, "limits.modelProjectCostUsdWarning"),
    modelRequesterCostUsdWarning: input.modelRequesterCostUsdWarning === undefined ? undefined : positiveNumberValue(input.modelRequesterCostUsdWarning, "limits.modelRequesterCostUsdWarning"),
    modelProjectCostUsdLimit: input.modelProjectCostUsdLimit === undefined ? undefined : positiveNumberValue(input.modelProjectCostUsdLimit, "limits.modelProjectCostUsdLimit"),
    modelRequesterCostUsdLimit: input.modelRequesterCostUsdLimit === undefined ? undefined : positiveNumberValue(input.modelRequesterCostUsdLimit, "limits.modelRequesterCostUsdLimit"),
  });
}

function tenantPolicyTemplateParameters(value: unknown): string[] {
  return [...new Set(stringArray(value, "executorTemplateParameters").map((entry, index) => templateParameterValue(entry, `executorTemplateParameters[${index}]`)))];
}

function tenantPolicySettingsFromUnknown(value: unknown): TenantPolicySettingsRequestBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("tenant policy settings must be an object.");
  }
  return value as TenantPolicySettingsRequestBody;
}

function mergeTenantPolicySettings(
  policy: TenantPolicy | undefined,
  body: TenantPolicySettingsRequestBody,
  options: HarnessServerOptions,
): TenantPolicy {
  const allowedTools = body.allowedTools === undefined
    ? policy?.allowedTools
    : tenantPolicyAllowedToolsSetting(body.allowedTools);
  const denied = (allowedTools ?? []).filter((tool) => !(options.allowedTools ?? []).includes(tool));
  if (denied.length) {
    throw badRequest(`tenant policy allowedTools not permitted by server: ${denied.join(", ")}`);
  }
  return compactObject({
    schemaVersion: 1 as const,
    apiKeys: policy?.apiKeys,
    controlPlaneIdentities: policy?.controlPlaneIdentities,
    modelKeyEnv: Object.hasOwn(body, "modelKeyEnv")
      ? optionalEnvNameValue(body.modelKeyEnv, "modelKeyEnv")
      : policy?.modelKeyEnv,
    executorTemplateParameters: body.executorTemplateParameters === undefined
      ? policy?.executorTemplateParameters
      : tenantPolicyTemplateParameters(body.executorTemplateParameters),
    limits: body.limits === undefined ? policy?.limits : tenantPolicyLimits(body.limits),
    allowedTools,
  });
}

function tenantPolicyAllowedToolsSetting(value: unknown): string[] | undefined {
  if (value === null) return undefined;
  return [...new Set(stringArray(value, "allowedTools"))];
}

function sanitizeTenantPolicy(policy: TenantPolicy | undefined): SanitizedTenantPolicy {
  return compactObject({
    schemaVersion: 1 as const,
    apiKeys: policy?.apiKeys?.map(sanitizeTenantApiKey),
    controlPlaneIdentities: policy?.controlPlaneIdentities?.map(sanitizeTenantControlPlaneIdentity),
    modelKeyEnv: policy?.modelKeyEnv,
    executorTemplateParameters: policy?.executorTemplateParameters,
    limits: policy?.limits,
    allowedTools: policy?.allowedTools,
  });
}

function sanitizeTenantControlPlaneIdentity(identity: TenantControlPlaneIdentity): SanitizedTenantControlPlaneIdentity {
  return {
    provider: identity.provider,
    externalActor: identity.externalActor,
    actor: identity.actor,
    role: identity.role,
  };
}

function tenantPolicyAuditData(policy: TenantPolicy): Record<string, unknown> {
  return compactObject({
    apiKeyCount: policy.apiKeys?.length ?? 0,
    apiKeys: policy.apiKeys?.map(sanitizeTenantApiKey),
    controlPlaneIdentities: policy.controlPlaneIdentities?.map(sanitizeTenantControlPlaneIdentity),
    modelKeyEnv: policy.modelKeyEnv,
    executorTemplateParameters: policy.executorTemplateParameters,
    limits: policy.limits,
    allowedTools: policy.allowedTools,
  });
}

function tenantPolicyDir(workspaceRoot: string, tenant: string): string {
  return join(workspaceRoot, tenant, ".loom");
}

function tenantPolicyPath(workspaceRoot: string, tenant: string): string {
  return join(tenantPolicyDir(workspaceRoot, tenant), "policy.json");
}

async function readTenantPolicyEscalations(workspaceRoot: string, tenant: string): Promise<TenantPolicyEscalation[]> {
  let entries;
  try {
    entries = await readdir(tenantPolicyEscalationDir(workspaceRoot, tenant), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const escalations = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readTenantPolicyEscalationPath(join(tenantPolicyEscalationDir(workspaceRoot, tenant), entry.name))),
  );
  escalations.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return escalations;
}

async function readTenantPolicyEscalation(workspaceRoot: string, tenant: string, escalationId: string): Promise<TenantPolicyEscalation> {
  try {
    return await readTenantPolicyEscalationPath(tenantPolicyEscalationPath(workspaceRoot, tenant, escalationId));
  } catch (error) {
    if (isNotFound(error)) throw notFound("tenant policy escalation not found");
    throw error;
  }
}

async function readTenantPolicyEscalationPath(path: string): Promise<TenantPolicyEscalation> {
  return tenantPolicyEscalationFromUnknown(JSON.parse(await readFile(path, "utf8")));
}

async function writeTenantPolicyEscalation(workspaceRoot: string, tenant: string, escalation: TenantPolicyEscalation): Promise<void> {
  await mkdir(tenantPolicyEscalationDir(workspaceRoot, tenant), { recursive: true });
  await writeFile(tenantPolicyEscalationPath(workspaceRoot, tenant, escalation.id), JSON.stringify(escalation, null, 2) + "\n", "utf8");
}

function tenantPolicyEscalationFromBody(
  tenant: string,
  body: TenantPolicyEscalationRequestBody,
  access: TenantAccess | undefined,
): TenantPolicyEscalation {
  const requestedTools = body.requestedTools === undefined ? undefined : [...new Set(stringArray(body.requestedTools, "requestedTools"))];
  const limits = tenantPolicyLimits(body.limits);
  const source = tenantPolicyEscalationSource(body.source);
  if ((requestedTools?.length ?? 0) === 0 && (!limits || Object.keys(limits).length === 0)) {
    throw badRequest("tenant policy escalation requires requestedTools or limits.");
  }
  return compactObject({
    schemaVersion: 1 as const,
    id: randomUUID(),
    tenant,
    status: "pending" as const,
    requestedTools,
    limits,
    source,
    reason: requireString(body.reason, "reason"),
    actor: access?.actor,
    role: access?.role,
    createdAt: new Date().toISOString(),
  });
}

function tenantPolicyEscalationFromUnknown(value: unknown): TenantPolicyEscalation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("tenant policy escalation must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1) {
    throw badRequest("tenant policy escalation schemaVersion must be 1.");
  }
  const status = tenantPolicyEscalationStatus(input.status);
  const decidedBy = optionalString(input.decidedBy, "decidedBy");
  const decidedRole = input.decidedRole === undefined ? undefined : tenantPolicyRole(input.decidedRole, "decidedRole");
  const decidedAt = optionalString(input.decidedAt, "decidedAt");
  const decisionNote = optionalString(input.decisionNote, "decisionNote");
  return compactObject({
    schemaVersion: 1 as const,
    id: requireSafeName(input.id, "id"),
    tenant: requireSafeName(input.tenant, "tenant"),
    status,
    requestedTools: input.requestedTools === undefined ? undefined : [...new Set(stringArray(input.requestedTools, "requestedTools"))],
    limits: tenantPolicyLimits(input.limits),
    source: tenantPolicyEscalationSource(input.source),
    policyChange: tenantPolicyEscalationPolicyChangeFromUnknown(input.policyChange),
    reason: requireString(input.reason, "reason"),
    actor: optionalString(input.actor, "actor"),
    role: input.role === undefined ? undefined : tenantPolicyRole(input.role, "role"),
    createdAt: requireString(input.createdAt, "createdAt"),
    decidedBy,
    decidedRole,
    decidedAt,
    decisionNote,
  });
}

function tenantPolicyEscalationSource(value: unknown): TenantPolicyEscalationSource | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("tenant policy escalation source must be an object.");
  }
  const input = value as Record<string, unknown>;
  const kind = tenantPolicyEscalationSourceKind(input.kind);
  return compactObject({
    kind,
    project: input.project === undefined ? undefined : requireSafeName(input.project, "source.project"),
    runId: input.runId === undefined ? undefined : requireSafeName(input.runId, "source.runId"),
    detail: optionalString(input.detail, "source.detail"),
  });
}

function tenantPolicyEscalationSourceKind(value: unknown): TenantPolicyEscalationSource["kind"] {
  if (value !== "manual" && value !== "model_usage_warning" && value !== "workspace_usage_warning" && value !== "workspace_pr" && value !== "run_slot_pressure") {
    throw badRequest("tenant policy escalation source.kind must be manual, model_usage_warning, workspace_usage_warning, workspace_pr, run_slot_pressure.");
  }
  return value;
}

const TENANT_POLICY_LIMIT_KEYS = [
  "maxActiveRuns",
  "maxWorkspaceSessions",
  "maxWorkspaceBytes",
  "workspaceByteWarning",
  "executorCpus",
  "executorMemory",
  "executorPidsLimit",
  "executorNetwork",
  "modelProjectTotalTokenWarning",
  "modelRequesterTotalTokenWarning",
  "modelProjectTotalTokenLimit",
  "modelRequesterTotalTokenLimit",
  "modelProjectCostUsdWarning",
  "modelRequesterCostUsdWarning",
  "modelProjectCostUsdLimit",
  "modelRequesterCostUsdLimit",
] as const;

function tenantPolicyEscalationPolicyChangeFromUnknown(value: unknown): TenantPolicyChange | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("tenant policy escalation policyChange must be an object.");
  }
  const input = value as Record<string, unknown>;
  return compactObject({
    modelKeyEnv: tenantPolicyStringChangeFromUnknown(input.modelKeyEnv, "policyChange.modelKeyEnv"),
    executorTemplateParameters: tenantPolicyArrayChangeFromUnknown(input.executorTemplateParameters, "policyChange.executorTemplateParameters"),
    allowedTools: tenantPolicyEscalationAllowedToolsChangeFromUnknown(input.allowedTools),
    limits: tenantPolicyEscalationLimitsChangeFromUnknown(input.limits),
  });
}

function tenantPolicyStringChangeFromUnknown(value: unknown, field: string): TenantPolicyValueChange<string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(`${field} must be an object.`);
  }
  const input = value as Record<string, unknown>;
  return compactObject({
    before: optionalString(input.before, `${field}.before`),
    after: optionalString(input.after, `${field}.after`),
  });
}

function tenantPolicyArrayChangeFromUnknown(value: unknown, field: string): TenantPolicyArrayChange | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(`${field} must be an object.`);
  }
  const input = value as Record<string, unknown>;
  return compactObject({
    before: input.before === undefined ? undefined : stringArray(input.before, `${field}.before`),
    after: input.after === undefined ? undefined : stringArray(input.after, `${field}.after`),
    added: input.added === undefined ? undefined : stringArray(input.added, `${field}.added`),
    removed: input.removed === undefined ? undefined : stringArray(input.removed, `${field}.removed`),
  });
}

function tenantPolicyEscalationAllowedToolsChangeFromUnknown(value: unknown): TenantPolicyArrayChange | undefined {
  return tenantPolicyArrayChangeFromUnknown(value, "policyChange.allowedTools");
}

function tenantPolicyEscalationLimitsChangeFromUnknown(value: unknown): TenantPolicyLimitsChange | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("tenant policy escalation policyChange.limits must be an object.");
  }
  const input = value as Record<string, unknown>;
  const changed = input.changed === undefined ? undefined : tenantPolicyLimitKeyArray(input.changed, "policyChange.limits.changed");
  return compactObject({
    before: tenantPolicyLimits(input.before),
    after: tenantPolicyLimits(input.after),
    changed,
  });
}

function tenantPolicyLimitKeyArray(value: unknown, field: string): string[] {
  const keys = stringArray(value, field);
  const unknown = keys.filter((key) => !TENANT_POLICY_LIMIT_KEYS.includes(key as (typeof TENANT_POLICY_LIMIT_KEYS)[number]));
  if (unknown.length) {
    throw badRequest(`${field} contains unknown limit keys: ${unknown.join(", ")}`);
  }
  return [...new Set(keys)];
}

function tenantPolicyEscalationStatus(value: unknown): TenantPolicyEscalation["status"] {
  if (value !== "pending" && value !== "approved" && value !== "rejected") {
    throw badRequest("tenant policy escalation status must be pending, approved, or rejected.");
  }
  return value;
}

function tenantPolicyEscalationDecision(value: unknown): "approved" | "rejected" {
  if (value !== "approved" && value !== "rejected") {
    throw badRequest("decision must be approved or rejected.");
  }
  return value;
}

function mergeApprovedTenantPolicyEscalation(
  policy: TenantPolicy | undefined,
  escalation: TenantPolicyEscalation,
  options: HarnessServerOptions,
): TenantPolicy {
  const requestedTools = escalation.requestedTools ?? [];
  const serverTools = options.allowedTools ?? [];
  const denied = requestedTools.filter((tool) => !serverTools.includes(tool));
  if (denied.length) {
    throw badRequest(`tenant policy escalation tools not permitted by server: ${denied.join(", ")}`);
  }
  const allowedTools = requestedTools.length
    ? [...new Set([...(policy?.allowedTools ?? serverTools), ...requestedTools])]
    : policy?.allowedTools;
  const limits = compactObject({ ...(policy?.limits ?? {}), ...(escalation.limits ?? {}) });
  return compactObject({
    schemaVersion: 1 as const,
    apiKeys: policy?.apiKeys,
    controlPlaneIdentities: policy?.controlPlaneIdentities,
    modelKeyEnv: policy?.modelKeyEnv,
    executorTemplateParameters: policy?.executorTemplateParameters,
    limits: Object.keys(limits).length ? limits : undefined,
    allowedTools,
  });
}

function tenantPolicyEscalationPolicyChange(
  before: TenantPolicy | undefined,
  after: TenantPolicy,
  escalation: TenantPolicyEscalation,
): TenantPolicyChange | undefined {
  const allowedTools = tenantPolicyArrayChange(before?.allowedTools, after.allowedTools, escalation.requestedTools);
  const limits = tenantPolicyLimitsChange(before?.limits, after.limits, escalation.limits);
  const change = compactObject({ allowedTools, limits });
  return Object.keys(change).length ? change : undefined;
}

function tenantPolicyReplacementChange(
  before: TenantPolicy | undefined,
  after: TenantPolicy,
): TenantPolicyChange | undefined {
  const change = compactObject({
    modelKeyEnv: tenantPolicyValueChange(before?.modelKeyEnv, after.modelKeyEnv),
    executorTemplateParameters: tenantPolicyArrayChange(before?.executorTemplateParameters, after.executorTemplateParameters),
    controlPlaneIdentities: tenantPolicyControlPlaneIdentityChange(before?.controlPlaneIdentities, after.controlPlaneIdentities),
    allowedTools: tenantPolicyArrayChange(before?.allowedTools, after.allowedTools),
    limits: tenantPolicyLimitsChange(before?.limits, after.limits, undefined, true),
  });
  return Object.keys(change).length ? change : undefined;
}

function tenantPolicySettingsChange(
  before: TenantPolicy | undefined,
  after: TenantPolicy,
  body: TenantPolicySettingsRequestBody,
): TenantPolicyChange | undefined {
  const change = compactObject({
    modelKeyEnv: Object.hasOwn(body, "modelKeyEnv")
      ? tenantPolicyValueChange(before?.modelKeyEnv, after.modelKeyEnv)
      : undefined,
    executorTemplateParameters: body.executorTemplateParameters === undefined
      ? undefined
      : tenantPolicyArrayChange(before?.executorTemplateParameters, after.executorTemplateParameters),
    allowedTools: body.allowedTools === undefined
      ? undefined
      : tenantPolicyArrayChange(before?.allowedTools, after.allowedTools),
    limits: body.limits === undefined
      ? undefined
      : tenantPolicyLimitsChange(before?.limits, after.limits, after.limits),
  });
  return Object.keys(change).length ? change : undefined;
}

function tenantPolicyValueChange<T>(
  before: T | undefined,
  after: T | undefined,
): TenantPolicyValueChange<T> | undefined {
  if (before === after) return undefined;
  return compactObject({ before, after });
}

function tenantPolicyArrayChange(
  before: string[] | undefined,
  after: string[] | undefined,
  requestedItems?: string[],
): TenantPolicyArrayChange | undefined {
  const beforeTools = before ?? [];
  const afterTools = after ?? [];
  const requested = requestedItems ?? [...beforeTools, ...afterTools];
  const added = requested.filter((tool) => !beforeTools.includes(tool) && afterTools.includes(tool));
  const removed = requested.filter((tool) => beforeTools.includes(tool) && !afterTools.includes(tool));
  if (!added.length && !removed.length && arraysEqual(beforeTools, afterTools)) return undefined;
  return compactObject({
    before,
    after,
    added: added.length ? added : undefined,
    removed: removed.length ? removed : undefined,
  });
}

function tenantPolicyControlPlaneIdentityChange(
  before: TenantControlPlaneIdentity[] | undefined,
  after: TenantControlPlaneIdentity[] | undefined,
): TenantPolicyControlPlaneIdentityChange | undefined {
  const beforeIdentities = (before ?? []).map(sanitizeTenantControlPlaneIdentity);
  const afterIdentities = (after ?? []).map(sanitizeTenantControlPlaneIdentity);
  const beforeKeys = beforeIdentities.map(tenantControlPlaneIdentityKey);
  const afterKeys = afterIdentities.map(tenantControlPlaneIdentityKey);
  const added = afterIdentities.filter((identity) => !beforeKeys.includes(tenantControlPlaneIdentityKey(identity)));
  const removed = beforeIdentities.filter((identity) => !afterKeys.includes(tenantControlPlaneIdentityKey(identity)));
  if (!added.length && !removed.length && arraysEqual(beforeKeys, afterKeys)) return undefined;
  return compactObject({
    before: beforeIdentities.length ? beforeIdentities : undefined,
    after: afterIdentities.length ? afterIdentities : undefined,
    added: added.length ? added : undefined,
    removed: removed.length ? removed : undefined,
  });
}

function tenantPolicyLimitsChange(
  before: TenantPolicyLimits | undefined,
  after: TenantPolicyLimits | undefined,
  requestedLimits: TenantPolicyLimits | undefined,
  includeAll = false,
): TenantPolicyLimitsChange | undefined {
  const changed = TENANT_POLICY_LIMIT_KEYS.filter((key) =>
    (includeAll || (requestedLimits !== undefined && Object.hasOwn(requestedLimits, key))) && before?.[key] !== after?.[key],
  );
  if (!changed.length) return undefined;
  return compactObject({
    before,
    after,
    changed,
  });
}

function tenantPolicyEscalationAuditData(escalation: TenantPolicyEscalation): Record<string, unknown> {
  return compactObject({
    escalationId: escalation.id,
    status: escalation.status,
    requestedTools: escalation.requestedTools,
    limits: escalation.limits,
    source: escalation.source,
    policyChange: escalation.policyChange,
    reason: escalation.reason,
  });
}

function tenantPolicyEscalationDir(workspaceRoot: string, tenant: string): string {
  return join(tenantPolicyDir(workspaceRoot, tenant), "escalations");
}

function tenantPolicyEscalationPath(workspaceRoot: string, tenant: string, escalationId: string): string {
  return join(tenantPolicyEscalationDir(workspaceRoot, tenant), `${escalationId}.json`);
}

async function requireTenantAccess(
  req: IncomingMessage,
  tenant: string,
  options: HarnessServerOptions,
  url?: URL,
  requiredRole: TenantRole = "viewer",
): Promise<TenantAccess | undefined> {
  const policy = await readTenantPolicy(resolve(options.workspaceRoot), tenant, options);
  const tokens = options.tenantTokens ?? {};
  const apiKeys = options.tenantApiKeys ?? {};
  const oidc = options.oidcAuthenticator;
  const hasGlobalAuth = Object.keys(tokens).length > 0 || Object.keys(apiKeys).length > 0 || Boolean(oidc);
  const hasTenantPolicyAuth = (policy?.apiKeys?.length ?? 0) > 0;
  if (!hasGlobalAuth && !hasTenantPolicyAuth) return undefined;

  const tenantApiKeys = [...(apiKeys[tenant] ?? []), ...(policy?.apiKeys ?? [])];
  const expected = tokens[tenant];
  if (!expected && tenantApiKeys.length === 0 && !oidc) {
    throw unauthorized(`unknown tenant: ${tenant}`);
  }

  const headerCredential =
    bearerToken(req.headers.authorization) ??
    headerValue(req.headers["x-loom-tenant-token"]);
  const provided = headerCredential ?? streamQueryToken(url);
  const apiKey = tenantApiKeys.find((key) => tenantApiKeyMatches(key, provided));
  if (apiKey) {
    const access = compactObject({ actor: apiKey.actor, role: apiKey.role, modelKeyEnv: apiKey.modelKeyEnv });
    requireTenantRole(access, requiredRole);
    return access;
  }

  if (expected && safeEqualString(provided, expected)) {
    const access = { actor: "legacy-token", role: "admin" as const };
    requireTenantRole(access, requiredRole);
    return access;
  }

  if (oidc && headerCredential) {
    let identity;
    try {
      identity = await oidc.authenticate(headerCredential, tenant);
    } catch {
      throw unauthorized("invalid tenant token");
    }
    const access = { actor: identity.actor, role: identity.role };
    requireTenantRole(access, requiredRole);
    return access;
  }

  if (!provided || !safeEqualString(provided, expected)) {
    throw unauthorized("invalid tenant token");
  }

  return undefined;
}

function isSafeTenantDirectoryName(name: string): boolean {
  try {
    assertTenantName(name);
    return true;
  } catch {
    return false;
  }
}

function requireTenantRole(access: TenantAccess, requiredRole: TenantRole): void {
  if (tenantRoleRank(access.role) < tenantRoleRank(requiredRole)) {
    throw forbidden(`tenant access requires ${requiredRole} role.`);
  }
}

function isTenantRole(value: unknown): value is TenantRole {
  return value === "admin" || value === "developer" || value === "viewer";
}

function tenantRoleRank(role: TenantRole): number {
  if (role === "viewer") return 0;
  if (role === "developer") return 1;
  return 2;
}

function brainSignalFromBody(body: BrainSignalRequestBody): { signal: RunSignal; clientId?: string } {
  const signal: RunSignal = compactObject({
    ts: brainSignalLine(body.ts ?? new Date().toISOString(), "ts", 120),
    project: requireProjectName(body.project, "project"),
    runId: optionalBrainSignalLine(body.runId, "runId", 200),
    runDir: optionalBrainSignalLine(body.runDir, "runDir", 1000),
    status: optionalBrainSignalLine(body.status, "status", 120),
    issue: optionalBrainSignalLine(body.issue, "issue", 300),
    issueUrl: optionalBrainSignalLine(body.issueUrl, "issueUrl", 1000),
    dashboardUrl: optionalBrainSignalLine(body.dashboardUrl, "dashboardUrl", 1000),
    summaryUrl: optionalBrainSignalLine(body.summaryUrl, "summaryUrl", 1000),
    reviewSummaryUrl: optionalBrainSignalLine(body.reviewSummaryUrl, "reviewSummaryUrl", 1000),
    handoffPackageUrl: optionalBrainSignalLine(body.handoffPackageUrl, "handoffPackageUrl", 1000),
    handoffFollowupsUrl: optionalBrainSignalLine(body.handoffFollowupsUrl, "handoffFollowupsUrl", 1000),
    failureKind: optionalBrainSignalLine(body.failureKind, "failureKind", 120),
    modelRequestCount: optionalBrainSignalNonNegativeInt(body.modelRequestCount, "modelRequestCount"),
    modelPromptTokens: optionalBrainSignalNonNegativeInt(body.modelPromptTokens, "modelPromptTokens"),
    modelCompletionTokens: optionalBrainSignalNonNegativeInt(body.modelCompletionTokens, "modelCompletionTokens"),
    modelTotalTokens: optionalBrainSignalNonNegativeInt(body.modelTotalTokens, "modelTotalTokens"),
    modelCostUsd: optionalBrainSignalNonNegativeNumber(body.modelCostUsd, "modelCostUsd"),
    skills: brainSignalSkills(body.skills),
    outcome: brainSignalOutcome(body.outcome),
    notes: optionalBrainSignalText(body.notes, "notes", 4000),
  });
  return { signal, clientId: optionalClientId(body.clientId) };
}

function brainSignalSkills(value: unknown): string[] {
  return stringArray(value, "skills").map((skill, index) => brainSignalLine(skill, `skills[${index}]`, 160));
}

function brainSignalOutcome(value: unknown): RunSignal["outcome"] {
  if (value !== "pass" && value !== "fail") {
    throw badRequest("outcome must be pass or fail.");
  }
  return value;
}

function optionalBrainSignalLine(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return brainSignalLine(value, field, maxLength);
}

function brainSignalLine(value: unknown, field: string, maxLength: number): string {
  const text = requireString(value, field).trim();
  if (text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw badRequest(`${field} must be a single-line string at most ${maxLength} characters.`);
  }
  return text;
}

function optionalBrainSignalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = requireString(value, field).trim();
  if (text.length > maxLength || /\0/.test(text)) {
    throw badRequest(`${field} must be text at most ${maxLength} characters.`);
  }
  return text;
}

function optionalBrainSignalNonNegativeInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw badRequest(`${field} must be a non-negative integer.`);
  }
  return parsed;
}

function optionalBrainSignalNonNegativeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw badRequest(`${field} must be a non-negative number.`);
  }
  return parsed;
}

export type { TenantExecutorLimits } from "./types.js";
export { TenantPolicyRequestBody, TenantPolicySettingsRequestBody, TenantPolicyEscalationRequestBody, TenantPolicyEscalationDecisionRequestBody, TenantPolicyChange, BrainSignalRequestBody, TenantAccess, TenantHarnessServerStatus, effectiveTenantExecutorLimits, effectiveTenantExecutorTemplateParameters, effectiveTenantAllowedTools, requireTenantTool, readTenantPolicySync, handleListTenantPolicyEscalations, handleCreateTenantPolicyEscalation, handleCreateBrainSignal, handleReadTenantBrainSignals, handleDecideTenantPolicyEscalation, handleReadTenantPolicy, handleReadTenantAccess, handleReadTenantStatus, handleReadTenantControlPlaneBackup, handleReadTenantControlPlaneCutoverReadiness, handleTenantControlPlaneRestoreDryRun, handleUpdateTenantPolicy, handleUpdateTenantPolicySettings, handleReadTenantAudit, handleListTenantModelUsageWarnings, brainSignalAuditData, brainSignalFailureKind, runTenantAuditTrail, tenantRoleField, readTenantPolicy, writeTenantPolicy, tenantPolicyFromUnknown, tenantPolicyControlPlaneIdentityActor, tenantPolicyApiKeyActor, tenantPolicyRole, sanitizeTenantControlPlaneIdentity, tenantPolicyAuditData, tenantPolicyReplacementChange, requireTenantAccess, isSafeTenantDirectoryName, requireTenantRole, isTenantRole, tenantRoleRank };
