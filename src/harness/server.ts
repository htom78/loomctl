import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, open, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, posix, relative, resolve } from "node:path";

import {
  createAgentWithSetupSteps,
  createCommandAgent,
  createScriptedAgentFromSteps,
  type AgentStep,
  type HarnessAgent,
} from "./agents.js";
import { createTenantAuditAppender, readTenantAuditEvents, type TenantAuditActor, type TenantAuditAppender, type TenantAuditEvent, type TenantRole } from "./audit.js";
import {
  createAgentGitServiceIssueWorkspaceAttachment,
  listAgentGitServiceIssueWorkspaces,
  parseAgentGitServiceRepoRef,
  readAgentGitServiceWikiMemory,
  type AgentGitServiceIssueWorkspace,
  updateAgentGitServiceWikiMemory,
} from "./agent-git-service.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { OPERATOR_COCKPIT_HTML } from "./operator-cockpit.js";
import { WORKBENCH_HTML } from "./workbench.js";
import { makeRunId, runHarness, type RunPauseRequest, type RunRequester } from "./loop.js";
import { createOpenAiCompatibleAgent, type ModelAgentProtocol } from "./model-agent.js";
import { appendRunEvent, readRunEvents } from "./run-store.js";
import type { DeploymentGate, HarnessEvent, ProjectContractEvidence, ProjectContractPatch, ProjectContractStatusEvidence, ProjectRunPolicyEvidence, ReviewClaim, ReviewGate, RunMetadata, RunModelUsageSummary, RunRequesterSummary, RunSummary } from "./events.js";
import { CONTROL_PLANE_PROVIDER_BOUNDARY, controlPlaneProviderCatalogEntry, type ControlPlaneProvider, type ControlPlaneProviderAdoptionStage, type ControlPlaneProviderBoundary, type ControlPlaneProviderCatalogName } from "./control-plane.js";
import { controlPlaneProviderAdapter as resolveControlPlaneProviderAdapter } from "./control-plane-registry.js";
import { formatRunRequesterSummary, parseGiteaIssueRef, type GiteaIssueComment } from "./gitea.js";
import {
  AGENT_GIT_SERVICE_PROJECT_PROVISIONING_RECEIPT_PATH,
  provisionAgentGitServiceProjectAgent,
  readAgentGitServiceProjectProvisioningReceipt,
  type AgentGitServiceProjectProvisioningResult,
  type ProvisionAgentGitServiceProjectAgentOptions,
} from "./agent-git-service-provisioning.js";
import { safeGitRef } from "./git-ref.js";
import { WORKSPACE_GIT_DIFF_COMMAND } from "./git-diff.js";
import { createWorkspaceGitCommit } from "./git-commit.js";
import { HARNESS_VISION_LOCK as SHARED_HARNESS_VISION_LOCK, ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES, ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS } from "./profile-contract.js";
import { runPlatformOperatorCockpitLoop } from "./platform-operator-cockpit-loop.js";
import { readPlatformOperatorCockpitExecutionStatus, runPlatformOperatorCockpitRunner } from "./platform-operator-cockpit-runner.js";
import {
  DEFAULT_AGENT_GIT_SERVICE_OPERATOR_COCKPIT_QUEUE_STORE_PATH,
  OPERATOR_COCKPIT_EXECUTION_QUEUE_CLAIM_TTL_MS,
  OPERATOR_COCKPIT_EXECUTION_QUEUE_DIR,
  createAgentGitServiceOperatorCockpitQueueBackend,
  createFilesystemOperatorCockpitQueueBackend,
  normalizeAgentGitServiceOperatorCockpitQueuePath,
  normalizeAgentGitServiceOperatorCockpitQueueRepo,
  type OperatorCockpitExecutionQueueItem,
  type OperatorCockpitQueueBackend,
} from "./operator-cockpit-queue-backend.js";
import { createPlatformOperatorCockpitNext, createPlatformOperatorStatus, type PlatformOperatorStatusResult } from "./platform-operator-status.js";
import { createPlatformOperatorApprovals } from "./platform-operator-approvals.js";
import { createPlatformOperatorHandoffPacket, createPlatformOperatorHandoffPacketFromStatus, type PlatformOperatorHandoffPacketResult } from "./platform-operator-handoff-packet.js";
import { writePlatformOperatorTargetInputTemplate } from "./platform-operator-target-input-template.js";
import { writePlatformStagingTargetsApply } from "./platform-staging-targets-apply.js";
import { importPlatformCiArtifactReports } from "./platform-ci-artifact-import.js";
import { platformOperatorAgsEvidenceAllowedReports } from "./platform-operator-ags-evidence-import.js";
import { syncPlatformOperatorAgsEvidence } from "./platform-operator-ags-evidence-sync.js";
import { ensureProjectTemplateMetadata, projectMetadataDefaultSkills, projectTemplateContractStatus, readProjectTemplateMetadata, seedProjectTemplate, updateProjectTemplateContract, updateProjectTemplateDefaultSkills, updateProjectTemplateRunPolicy, type ProjectTemplateContract, type ProjectTemplateContractStatus, type ProjectTemplateMetadata, type ProjectTemplateName, type ProjectTemplateRunPolicy } from "./project-templates.js";
import type { RunSignal } from "../brain.js";
import { brainFailureKindForSummary, reviewerFocusForFailureKind } from "../brain-evidence.js";
import {
  PROCESS_SESSION_STOP_GRACE_MS,
  createLocalExecutor,
  type CommandResult,
  type WorkspaceExecutor,
  type WorkspaceExecutionOptions,
  type WorkspaceDescription,
  type WorkspaceFileEntry,
  type WorkspacePathInfo,
  type WorkspaceSession,
} from "./executor.js";
import { assertTenantName } from "../tenant.js";

export interface HarnessServerOptions {
  workspaceRoot: string;
  profile?: string;
  controlPlaneProvider?: ControlPlaneProviderName;
  executorKind?: string;
  executorHomeRoot?: string;
  defaultMaxIterations?: number;
  modelBaseUrl?: string;
  modelApiKey?: string;
  modelProtocol?: ModelAgentProtocol;
  tenantModelKeyEnvs?: Record<string, string>;
  defaultModel?: string;
  allowedTools?: string[];
  tenantTokens?: Record<string, string>;
  tenantApiKeys?: Record<string, TenantApiKey[]>;
  controlPlaneAgentIdentity?: ControlPlaneAgentIdentityConfig;
  createExecutor?: (cwd: string, context: HarnessWorkspaceContext) => WorkspaceExecutor;
  runWorkspaceIsolation?: RunWorkspaceIsolation;
  allowUnsafeLocalExecutor?: boolean;
  issueReporter?: (summary: RunSummary) => Promise<void>;
  pullRequestReporter?: (summary: RunSummary) => Promise<PullRequestReporterResult | void>;
  workspacePullRequestReporter?: (request: WorkspacePullRequestRequest) => Promise<PullRequestReporterResult | void>;
  mergeReporter?: (summary: RunSummary, note?: string) => Promise<void>;
  issueCommentReader?: (issue: string, context: IssueCommentReaderContext) => Promise<GiteaIssueComment[]>;
  giteaWebhookSecret?: string;
  brainIngest?: (summary: RunSummary) => Promise<void> | void;
  brainSignalIngest?: (signal: RunSignal) => Promise<void> | void;
  publicUrl?: string;
  issueBaseUrl?: string;
  workspaceCommandTimeoutMs?: number;
  maxWorkspaceSessions?: number;
  maxTenantWorkspaceSessions?: number;
  maxTenantActiveRuns?: number;
  workspaceSessionIdleTimeoutMs?: number;
  runLeaseTtlMs?: number;
  autoAbandonStaleRuns?: boolean;
  controlPlaneBaseUrl?: string;
  controlPlaneAdminToken?: string;
  controlPlaneTenantTokens?: Record<string, string>;
  operatorBundleDir?: string;
  operatorCockpitQueueBackend?: OperatorCockpitQueueBackendName;
  operatorCockpitQueueAgentGitServiceRepo?: string;
  operatorCockpitQueueAgentGitServicePath?: string;
  agentGitServiceCreateAgent?: ProvisionAgentGitServiceProjectAgentOptions["createAgent"];
  agentGitServiceGrantRepoAccess?: ProvisionAgentGitServiceProjectAgentOptions["grantRepoAccess"];
  agentGitServiceListIssueWorkspaces?: typeof listAgentGitServiceIssueWorkspaces;
  agentGitServiceCreateIssueWorkspaceAttachment?: typeof createAgentGitServiceIssueWorkspaceAttachment;
  agentGitServiceReadWikiMemory?: typeof readAgentGitServiceWikiMemory;
  agentGitServiceUpdateWikiMemory?: typeof updateAgentGitServiceWikiMemory;
  agentGitServiceTokenSecretRoot?: string;
}

export interface PullRequestReporterResult {
  index?: number;
  url?: string;
}

export interface WorkspacePullRequestRequest {
  tenant: string;
  project: string;
  runId?: string;
  issue: string;
  issueUrl?: string;
  branch: string;
  baseBranch?: string;
  title: string;
  body: string;
  commit?: string;
  push: boolean;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
}

export interface IssueCommentReaderContext {
  tenant: string;
  project: string;
  runId?: string;
}

export type ControlPlaneProviderName = ControlPlaneProviderCatalogName;
export type OperatorCockpitQueueBackendName = "filesystem" | "agent-git-service";
export type ControlPlaneAgentIdentityMode = "shared" | "tenant-scoped";
type RunWorkspaceIsolation = "project" | "run";

export interface ControlPlaneAgentIdentityConfig {
  mode: ControlPlaneAgentIdentityMode;
  tenants?: string[];
}

interface HarnessControlPlaneStatus {
  provider: ControlPlaneProviderName;
  boundary: ControlPlaneProviderBoundary[];
  apiBasePath?: string;
  discoveryEndpoints: string[];
  nativeCapabilities: string[];
  adoptionStages: ControlPlaneProviderAdoptionStage[];
  discovery?: ControlPlaneDiscoveryStatus;
}

interface ControlPlaneDiscoveryEndpointStatus {
  endpoint: string;
  url: string;
  ok: boolean;
  tenant?: string;
  status?: number;
  error?: string;
}

type ControlPlaneDiscoveryTokenMode = "none" | "admin" | "tenant-scoped";

interface ControlPlaneDiscoveryTenantStatus {
  tenant: string;
  ok: boolean;
  endpointCount: number;
  okEndpointCount: number;
  missingEndpoints: string[];
}

interface ControlPlaneDiscoveryStatus {
  ok: boolean;
  baseUrl: string;
  endpointCount: number;
  okEndpointCount: number;
  missingEndpoints: string[];
  tokenMode: ControlPlaneDiscoveryTokenMode;
  tenantCount: number;
  tenantOkCount: number;
  missingTenants: string[];
  endpoints: ControlPlaneDiscoveryEndpointStatus[];
  tenantResults?: ControlPlaneDiscoveryTenantStatus[];
}

export interface TenantApiKey {
  token?: string;
  tokenHash?: string;
  actor: string;
  role: TenantRole;
  modelKeyEnv?: string;
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

export interface TenantExecutorLimits {
  cpus?: number;
  memory?: string;
  pidsLimit?: number;
  network?: string;
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

interface TenantPolicyApiKeyCreateRequestBody {
  actor?: unknown;
  role?: unknown;
  modelKeyEnv?: unknown;
  token?: unknown;
  clientId?: unknown;
}

interface TenantPolicyApiKeyRevokeRequestBody {
  actor?: unknown;
  role?: unknown;
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

interface TenantOperatorCockpitLoopExecuteRequestBody {
  execute?: unknown;
  confirm?: unknown;
  queue?: unknown;
  maxSteps?: unknown;
  requireExternalStaging?: unknown;
  requireOperatorApprovals?: unknown;
  requireAgentGitService?: unknown;
  repo?: unknown;
  ref?: unknown;
  clientId?: unknown;
}

interface OperatorCockpitQueuedExecutionSummary {
  queueId: string;
  tenant: string;
  dir: string;
  status: "executed" | "failed" | "blocked";
  enqueuedAt: string;
  startedAt: string;
  finishedAt: string;
  execution?: Awaited<ReturnType<typeof runPlatformOperatorCockpitRunner>>;
  refreshed?: Awaited<ReturnType<typeof runPlatformOperatorCockpitLoop>>;
}

interface TenantOperatorTargetInputTemplateRequestBody {
  overwrite?: unknown;
  requireExternalStaging?: unknown;
  requireOperatorApprovals?: unknown;
  requireAgentGitService?: unknown;
  repo?: unknown;
  ref?: unknown;
  clientId?: unknown;
}

interface TenantOperatorRealStagingTargetInputRequestBody {
  schemaVersion?: unknown;
  targets?: unknown;
  expectedInputSha256?: unknown;
  requireExternalStaging?: unknown;
  requireOperatorApprovals?: unknown;
  requireAgentGitService?: unknown;
  repo?: unknown;
  ref?: unknown;
  clientId?: unknown;
}

interface TenantOperatorRealStagingTargetsApplyRequestBody {
  expectedInputSha256?: unknown;
  autoRefreshBundle?: unknown;
  requireExternalStaging?: unknown;
  requireOperatorApprovals?: unknown;
  requireAgentGitService?: unknown;
  repo?: unknown;
  ref?: unknown;
  clientId?: unknown;
}

interface TenantOperatorBundleRefreshRequestBody {
  expectedApplyReportSha256?: unknown;
  requireExternalStaging?: unknown;
  requireOperatorApprovals?: unknown;
  requireAgentGitService?: unknown;
  repo?: unknown;
  ref?: unknown;
  clientId?: unknown;
}

interface TenantOperatorGithubActionsTargetInputRequestBody {
  schemaVersion?: unknown;
  repo?: unknown;
  ref?: unknown;
  expectedInputSha256?: unknown;
  requireExternalStaging?: unknown;
  requireOperatorApprovals?: unknown;
  requireAgentGitService?: unknown;
  clientId?: unknown;
}

interface TenantOperatorCiArtifactImportRequestBody {
  artifactDir?: unknown;
  phase?: unknown;
  runId?: unknown;
  requireExternalStaging?: unknown;
  requireOperatorApprovals?: unknown;
  requireAgentGitService?: unknown;
  repo?: unknown;
  ref?: unknown;
  clientId?: unknown;
}

interface TenantOperatorAgsEvidenceImportRequestBody {
  artifactDir?: unknown;
  phase?: unknown;
  runId?: unknown;
  requireExternalStaging?: unknown;
  requireOperatorApprovals?: unknown;
  requireAgentGitService?: unknown;
  repo?: unknown;
  ref?: unknown;
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
  apiKeys?: Array<{ actor: string; role: TenantRole; modelKeyEnv?: string }>;
  controlPlaneIdentities?: SanitizedTenantControlPlaneIdentity[];
  modelKeyEnv?: string;
  executorTemplateParameters?: string[];
  limits?: TenantPolicyLimits;
  allowedTools?: string[];
}

interface SanitizedTenantControlPlaneIdentity {
  provider: string;
  externalActor: string;
  actor: string;
  role: TenantRole;
}

export interface HarnessWorkspaceContext {
  tenant: string;
  project: string;
  runId: string;
  cwd: string;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  issue?: string;
  executorLimits?: TenantExecutorLimits;
  executorTemplateParameters?: string[];
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

type RunPresetName = "vas-lite-review";

interface VasLiteReviewPresetInput {
  caseId: string;
  priorLearningCount?: number;
  reviewCount?: number;
  correctionCount?: number;
  caseLearningCount?: number;
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

interface VasCaseCreateRequestBody {
  caseId?: unknown;
  title?: unknown;
  source?: unknown;
  repo?: unknown;
  branch?: unknown;
  baseBranch?: unknown;
  issue?: unknown;
  clientId?: unknown;
}

interface VasCaseReviewRequestBody {
  decision?: unknown;
  note?: unknown;
  corrections?: unknown;
  learnings?: unknown;
  runId?: unknown;
  clientId?: unknown;
}

interface VasCaseClaimRequestBody {
  action?: unknown;
  clientId?: unknown;
}

interface VasCaseReviewRunRequestBody {
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
  syncIssueComments?: unknown;
  verify?: unknown;
  evaluate?: unknown;
  reviewer?: unknown;
  skills?: unknown;
  allowedTools?: unknown;
  maxIterations?: unknown;
  clientId?: unknown;
}

type VasCaseReviewDecision = "approved" | "changes_requested";
type VasCaseClaimAction = "claim" | "release";
type RunReviewClaimAction = "claim" | "release";

interface VasLiteCaseClaim {
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  claimedAt: string;
}

interface VasLiteCaseSummary {
  id: string;
  status?: string;
  title?: string;
  source?: unknown;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  issue?: string;
  sourceDefaultFields?: Array<"repo" | "branch" | "baseBranch" | "issue">;
  path: string;
  reportPath?: string;
  reviewCount?: number;
  correctionCount?: number;
  learningCount?: number;
  runCount?: number;
  reviewedRunCount?: number;
  unreviewedRunCount?: number;
  latestRunId?: string;
  latestRunStatus?: ReadableRunState["status"];
  latestRunStartedAt?: string;
  latestRunReviewDecision?: VasCaseReviewDecision;
  latestRunReviewedAt?: string;
  claim?: VasLiteCaseClaim;
}

interface VasLiteCaseListResponse {
  project: string;
  template: "vas-lite";
  cases: VasLiteCaseSummary[];
}

type VasLiteReviewQueueReason = "needs_review" | "needs_revision" | "unreviewed_run";

interface VasLiteReviewQueueItem extends VasLiteCaseSummary {
  reasons: VasLiteReviewQueueReason[];
  links: {
    reviewPackage: string;
    runs: string;
    artifacts: string;
    review: string;
    reviewRuns: string;
  };
}

interface VasLiteReviewQueueResponse {
  project: string;
  template: "vas-lite";
  cases: VasLiteReviewQueueItem[];
}

interface VasLiteCaseRunLink {
  runCount: number;
  runIds: string[];
  latestRunId?: string;
  latestRunStatus?: ReadableRunState["status"];
  latestRunStartedAt?: string;
}

interface VasLiteLearningSummary {
  caseId: string;
  text: string;
  source?: string;
  reviewDecision?: VasCaseReviewDecision;
  reviewedAt?: string;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  runId?: string;
}

interface VasLiteReviewGuidanceReview {
  decision?: VasCaseReviewDecision;
  note?: string;
  reviewedAt?: string;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  runId?: string;
}

interface VasLiteReviewGuidanceText {
  text: string;
  source?: string;
  reviewDecision?: VasCaseReviewDecision;
  reviewedAt?: string;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  runId?: string;
}

interface VasLiteReviewGuidance {
  reviewCount: number;
  correctionCount: number;
  learningCount: number;
  latestReview?: VasLiteReviewGuidanceReview;
  recentReviews?: VasLiteReviewGuidanceReview[];
  corrections?: VasLiteReviewGuidanceText[];
  learnings?: VasLiteReviewGuidanceText[];
}

interface VasLiteLearningListResponse {
  project: string;
  template: "vas-lite";
  learnings: VasLiteLearningSummary[];
}

interface VasLiteCaseArtifactsResponse {
  project: string;
  template: "vas-lite";
  caseId: string;
  contextPath: string;
  reportPath: string;
  reviewDraftPath: string;
  context?: Record<string, unknown>;
  report?: string;
  reviewDraft?: Record<string, unknown>;
}

interface VasLiteCaseReviewPackageResponse {
  project: string;
  template: "vas-lite";
  caseId: string;
  case: VasLiteCaseSummary;
  artifacts: VasLiteCaseArtifactsResponse;
  runs: VasLiteCaseRunSummary[];
  reviews: Record<string, unknown>[];
  corrections: Record<string, unknown>[];
  learnings: VasLiteLearningSummary[];
  issueCommentSeeds: IssueCommentSeedEvidence[];
  auditTrail: TenantAuditEvent[];
  links: {
    artifacts: string;
    runs: string;
    review: string;
    reviewRuns: string;
  };
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

interface VasLiteCaseRunSummary {
  runId: string;
  status: ReadableRunState["status"];
  goal: string;
  startedAt: string;
  endedAt?: string;
  agentMode?: RunMetadata["agentMode"];
  model?: string;
  issue?: string;
  issueUrl?: string;
  summaryUrl?: string;
  reviewSummaryUrl?: string;
  handoffPackageUrl?: string;
  pullRequestIndex?: number;
  pullRequestUrl?: string;
  reviewGateStatus?: ReviewGate["status"];
  deploymentGateStatus?: DeploymentGate["status"];
  failureKind?: string;
  reviewerFocus?: string;
  error?: RunSummary["error"];
  contextPath?: string;
  reportPath?: string;
  reviewDraftPath?: string;
  contextWritten?: boolean;
  reportWritten?: boolean;
  reviewDraftWritten?: boolean;
  runPresetInput?: Record<string, unknown>;
  reviewStatus?: "reviewed" | "unreviewed";
  reviewDecision?: VasCaseReviewDecision;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewedRole?: TenantRole;
  reviewedClientId?: string;
}

interface VasLiteCaseRunListResponse {
  project: string;
  template: "vas-lite";
  caseId: string;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  issue?: string;
  sourceDefaultFields?: Array<"repo" | "branch" | "baseBranch" | "issue">;
  runs: VasLiteCaseRunSummary[];
}

interface VasLiteRunState {
  caseId: string;
  state: ReadableRunState;
}

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

interface CancelRequestBody {
  reason?: unknown;
  clientId?: unknown;
}

interface RunCommentRequestBody {
  message?: unknown;
  pause?: unknown;
  clientId?: unknown;
}

interface IssueCommentSyncRequestBody {
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

type TenantAccess = TenantAuditActor & { modelKeyEnv?: string };

interface RunEventContext {
  actor?: string;
  role?: TenantRole;
  clientId?: string;
}

interface RunCancelRequest extends RunEventContext {
  reason?: string;
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

interface LinkedIssueRun {
  project: string;
  runId: string;
  runDir: string;
  state: ReadableRunState;
}

interface LinkedIssueVasCase {
  project: string;
  caseId: string;
  record: Record<string, unknown>;
}

interface InitialRunEvent {
  type: "user_message";
  data: Record<string, unknown>;
}

interface RunningRunStatus {
  runId: string;
  tenant: string;
  project: string;
  goal: string;
  status: "running";
  skills: string[];
  metadata?: RunMetadata;
  requester?: RunRequesterSummary;
  startedAt: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  runDir: string;
}

interface QueuedRunStatus {
  runId: string;
  tenant: string;
  project: string;
  goal: string;
  status: "queued";
  skills: string[];
  metadata?: RunMetadata;
  requester?: RunRequesterSummary;
  queuedAt: string;
  tenantQueuePosition?: number;
  projectQueuePosition?: number;
  blockedReason?: QueuedRunBlockedReason;
  blockedByRunIds?: string[];
  limit?: number;
  concurrency?: QueuedRunConcurrencySummary;
  runDir: string;
}

type ReadableRunState = RunSummary | RunningRunStatus | QueuedRunStatus;

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

interface QueuedRunSnapshot {
  schemaVersion: 1;
  request: RunRequestBody;
  requester?: RunRequester;
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

interface ActiveRunResourceStatus extends ActiveRunSlot {
  workspaceLeaseScope: RunWorkspaceIsolation;
  workspaceLeaseKey: string;
}

interface RunAdmissionClaim {
  schemaVersion: 1;
  tenant: string;
  project: string;
  runId: string;
  scope: "project" | "run";
  heartbeatAt: string;
  leaseExpiresAt: string;
}

interface RunAdmissionClaimHandle {
  claim: RunAdmissionClaim;
  release: () => Promise<void>;
  refresh: () => Promise<void>;
}

type RunAdmissionClaimResult =
  | { ok: true; handle: RunAdmissionClaimHandle }
  | { ok: false; runId: string };

interface TenantRunAdmissionClaim {
  schemaVersion: 1;
  tenant: string;
  project: string;
  runId: string;
  limit: number;
  heartbeatAt: string;
  leaseExpiresAt: string;
}

interface TenantRunAdmissionClaimHandle {
  claim: TenantRunAdmissionClaim;
  release: () => Promise<void>;
  refresh: () => Promise<void>;
}

type TenantRunAdmissionClaimResult =
  | { ok: true; handle: TenantRunAdmissionClaimHandle }
  | { ok: false; runIds: string[]; limit: number };

type ActiveRunAdmissionResult =
  | { ok: true; handle: RunAdmissionClaimHandle }
  | { ok: false; admission: QueuedRunAdmission; error: Error };

interface WorkspaceSessionAdmissionClaim {
  schemaVersion: 1;
  tenant: string;
  project: string;
  runId?: string;
  route: "project" | "run";
  sessionId: string;
  limit: number;
  heartbeatAt: string;
  leaseExpiresAt: string;
}

interface WorkspaceSessionAdmissionClaimHandle {
  claim: WorkspaceSessionAdmissionClaim;
  release: () => Promise<void>;
  refresh: () => Promise<void>;
}

type WorkspaceSessionAdmissionClaimResult =
  | { ok: true; handle: WorkspaceSessionAdmissionClaimHandle }
  | { ok: false; sessionIds: string[]; limit: number };

interface HarnessVisionLock {
  target: string;
  mvpIsScopeReduction: boolean;
  capabilities: string[];
}

interface RunCreateIdempotencyStatus {
  clientRequestId: true;
  sharedRunStore: true;
  crossServerReplay: true;
  simultaneousCreateReplay: true;
  conflictOnRequestMismatch: true;
}

interface HarnessConcurrencyAdmissionStatus {
  schemaVersion: "loom-concurrency-admission/v1";
  runWorkspaceIsolation: RunWorkspaceIsolation;
  activeRun: {
    claimScope: "project" | "run";
    claimPattern: string;
    leaseTtlMs: number;
    crossServer: true;
    staleClaimCleanup: true;
  };
  tenantActiveRuns: {
    enabled: boolean;
    limit: number | null;
    claimPattern: string;
    mutexPattern: string;
    crossServer: true;
    staleClaimCleanup: true;
  };
  workspaceSessions: {
    globalLimit: number;
    tenantLimit: number;
    globalClaimPattern: string;
    tenantClaimPattern: string;
    mutexPattern: string;
    crossServer: true;
    staleClaimCleanup: true;
  };
  queueing: {
    asyncRuns: true;
    persistedSnapshots: true;
    restartRecovery: true;
    blockedReasons: Array<Exclude<QueuedRunBlockedReason, "ready">>;
  };
  operatorCockpitQueue: {
    backend: OperatorCockpitQueueBackendName;
    requestedBackend: OperatorCockpitQueueBackendName;
    activeBackend: OperatorCockpitQueueBackendName;
    fallbackReason?: "agent-git-service-candidate-not-ready" | "agent-git-service-queue-repo-missing" | "agent-git-service-queue-config-invalid";
    queueItemPattern: string;
    claimPattern: string;
    store:
      | {
          kind: "filesystem";
          queueItemPattern: string;
          claimPattern: string;
        }
      | {
          kind: "agent-git-service-contents";
          repo: string;
          path: string;
        };
    persistedSnapshots: true;
    restartRecovery: true;
    sharedBundleClaims: true;
    staleClaimCleanup: true;
    claimTtlMs: typeof OPERATOR_COCKPIT_EXECUTION_QUEUE_CLAIM_TTL_MS;
    futureBackends: ["agent-git-service"];
    candidateBackends: {
      agentGitService: {
        backend: "agent-git-service";
        ready: boolean;
        configured: {
          provider: boolean;
          baseUrl: boolean;
          token: boolean;
        };
        missing: Array<"controlPlaneProvider" | "controlPlaneBaseUrl" | "controlPlaneToken">;
      };
    };
  };
  runControl: {
    crossServer: true;
    requestFiles: [typeof RUN_PAUSE_REQUEST_FILE, typeof RUN_CANCEL_REQUEST_FILE];
    ownerLoopPollMs: typeof RUN_CONTROL_POLL_INTERVAL_MS;
  };
  idempotency: RunCreateIdempotencyStatus;
}

interface HarnessServerStatus {
  server: {
    workspaceRoot: string;
    profile?: string;
    startedAt: string;
    uptimeMs: number;
    controlPlane: HarnessControlPlaneStatus;
    runWorkspaceIsolation: RunWorkspaceIsolation;
    runCreateIdempotency: RunCreateIdempotencyStatus;
    concurrencyAdmission: HarnessConcurrencyAdmissionStatus;
  };
  readiness: HarnessProfileReadiness;
  limits: {
    jsonBodyBytes: number;
    workspaceFileReadBytes: number;
    workspaceFileWriteBytes: number;
    workspaceOutputBytes: number;
    workspaceSessionInputBytes: number;
    workspaceCommandTimeoutMs: number;
    maxWorkspaceSessions: number;
    maxTenantWorkspaceSessions: number;
    maxTenantActiveRuns: number | null;
    workspaceSessionIdleTimeoutMs: number;
    runLeaseTtlMs: number;
    processSessionStopGraceMs: number;
  };
  resources: {
    activeRuns: number;
    activeRunDetails?: ActiveRunResourceStatus[];
    queuedRuns: number;
    activeWorkspaceSessions: number;
    activeWorkspaceSessionDetails: WorkspaceSessionSummary[];
    queueRecovery: QueueRecoveryAudit;
    staleRunCleanup: StaleRunCleanupAudit;
    orphanedRunningRunDetails: OrphanedRunningRunResourceStatus[];
    queuedRunDetails: QueuedRunResourceStatus[];
    tenants: TenantResourceStatus[];
  };
  policy: {
    allowedTools: string[];
  };
  visionLock: HarnessVisionLock;
}

interface HarnessProfileReadiness {
  profile?: string;
  ok: boolean;
  missing: string[];
  goldenPath: {
    required: boolean;
    ok: boolean;
    capabilities: string[];
    missingCapabilities: string[];
  };
  checks: {
    onlineSandboxTools: {
      required: boolean;
      ok: boolean;
      missingTools: string[];
    };
    sandboxExecutor: {
      required: boolean;
      ok: boolean;
      executorKind?: string;
    };
    persistentHome: {
      required: boolean;
      ok: boolean;
      executorKind?: string;
      homeRoot?: string;
    };
    tenantAuth: {
      required: boolean;
      ok: boolean;
      roles: Record<TenantRole, boolean>;
      missingRoles: TenantRole[];
      legacyTokens: boolean;
    };
    model: {
      required: boolean;
      ok: boolean;
      baseUrlConfigured: boolean;
      keyConfigured: boolean;
      keyMode: "none" | "server" | "tenant-scoped" | "policy-key-scoped" | "mixed";
      tenantCount: number;
      missingTenantCount: number;
      missingEnvNames?: string[];
    };
    controlPlanePullRequest: {
      required: boolean;
      ok: boolean;
      provider: ControlPlaneProviderName;
    };
    controlPlaneMerge: {
      required: boolean;
      ok: boolean;
      provider: ControlPlaneProviderName;
    };
    controlPlaneIssueComments: {
      required: boolean;
      ok: boolean;
      provider: ControlPlaneProviderName;
    };
    controlPlaneIssueUrl: {
      required: boolean;
      ok: boolean;
      provider: ControlPlaneProviderName;
    };
    controlPlaneSignedWebhooks: {
      required: boolean;
      ok: boolean;
      provider: ControlPlaneProviderName;
    };
    controlPlaneDiscovery: {
      required: boolean;
      ok: boolean;
      provider: ControlPlaneProviderName;
      baseUrlConfigured: boolean;
      endpointCount: number;
      okEndpointCount: number;
      missingEndpoints: string[];
      tokenMode: ControlPlaneDiscoveryTokenMode;
      tenantCount: number;
      tenantOkCount: number;
      missingTenants: string[];
    };
    controlPlaneGitTransport: {
      required: boolean;
      ok: boolean;
      provider: ControlPlaneProviderName;
      sampleRepo?: string;
      sampleRemoteUrl?: string;
    };
    controlPlaneWorkspaceBranchLease: {
      required: boolean;
      ok: boolean;
      provider: ControlPlaneProviderName;
      runWorkspaceIsolation: RunWorkspaceIsolation;
      branchDerivation: "run-suffixed";
      activeRunLeaseEvidence: boolean;
    };
    controlPlaneAgentIdentity: {
      required: boolean;
      ok: boolean;
      provider: ControlPlaneProviderName;
      mode: ControlPlaneAgentIdentityMode | "none";
      tenantCount: number;
      missingTenantCount: number;
    };
    agentGitServiceProjectAgents: {
      required: boolean;
      ok: boolean;
      provider: ControlPlaneProviderName;
      tenantCount: number;
      projectCount: number;
      provisionedProjectCount: number;
      secretRootConfigured: boolean;
      secretStoredProjectCount: number;
      missingProjects: string[];
      missingSecretProjects: string[];
    };
    controlPlaneBackupRestoreMigration: {
      required: boolean;
      ok: boolean;
      provider: ControlPlaneProviderName;
      format: "tenant-control-plane-backup-v1";
    };
    giteaPullRequest: {
      required: boolean;
      ok: boolean;
      compatibility?: boolean;
    };
    brainSignalIngest: {
      required: boolean;
      ok: boolean;
    };
    coderExecutor: {
      required: boolean;
      ok: boolean;
      executorKind?: string;
    };
    runWorkspaceIsolation: {
      required: boolean;
      ok: boolean;
      mode: RunWorkspaceIsolation;
    };
    runCreateIdempotency: {
      required: boolean;
      ok: boolean;
    } & RunCreateIdempotencyStatus;
  };
}

interface TenantHarnessServerStatus {
  tenant: string;
  server: {
    startedAt: string;
    uptimeMs: number;
    controlPlane: HarnessControlPlaneStatus;
    runWorkspaceIsolation: RunWorkspaceIsolation;
    runCreateIdempotency: RunCreateIdempotencyStatus;
    concurrencyAdmission: HarnessConcurrencyAdmissionStatus;
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

interface TenantResourceStatus {
  tenant: string;
  activeRuns: number;
  queuedRuns: number;
  activeWorkspaceSessions: number;
  activeWorkspaceSessionDetails?: WorkspaceSessionSummary[];
}

type QueuedRunBlockedReason = "tenant_active_run_limit" | "project_active_workspace" | "persisted_running_run" | "ready";

interface QueuedRunConcurrencySummary {
  state: "blocked" | "ready";
  blockedReason: QueuedRunBlockedReason;
  blockedByRunIds?: string[];
  activeTenantRunCount?: number;
  tenantActiveRunLimit?: number;
  projectActiveRunId?: string;
  persistedRunId?: string;
}

interface QueuedRunAdmission {
  blockedReason: QueuedRunBlockedReason;
  concurrency: QueuedRunConcurrencySummary;
  blockedByRunIds?: string[];
  limit?: number;
}

interface QueuedRunResourceStatus {
  tenant: string;
  project: string;
  runId: string;
  goal: string;
  queuedAt: string;
  tenantQueuePosition?: number;
  projectQueuePosition?: number;
  blockedReason: QueuedRunBlockedReason;
  blockedByRunIds?: string[];
  limit?: number;
  concurrency?: QueuedRunConcurrencySummary;
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

interface OrphanedRunningRunResourceStatus {
  tenant: string;
  project: string;
  runId: string;
  goal: string;
  startedAt: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  stale: boolean;
  staleReason?: "lease_expired";
  runDir: string;
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

interface TenantModelUsageWarningListResponse {
  tenant: string;
  projects: ProjectSummary[];
}

interface TenantWorkspaceUsageWarningListResponse {
  tenant: string;
  projects: ProjectSummary[];
}

interface ProjectDetail extends ProjectSummary {
  template: ProjectTemplateName;
  createdAt: string;
  activityAt: string;
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

interface TenantControlPlaneCutoverReadiness {
  stage: "tenant-default-cutover";
  targetProvider: ControlPlaneProviderCatalogName;
  ok: boolean;
  checks: {
    agentGitServiceProjectAgents?: Omit<HarnessProfileReadiness["checks"]["agentGitServiceProjectAgents"], "required">;
  };
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

type RunChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

interface RunChangedFileHint {
  path: string;
  status: RunChangedFileStatus;
  previousPath?: string;
}

interface RunReviewBrainEvidence {
  outcome: "pass" | "fail";
  failureKind?: string;
  reviewerFocus?: string;
}

interface RunReviewVasEvidence {
  preset: RunPresetName;
  caseId: string;
  links: {
    artifacts: string;
    runs: string;
    reviewPackage: string;
    reviewRuns: string;
  };
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
const HTTP_JSON_BODY_LIMIT_BYTES = 1_000_000;
const DEFAULT_MAX_WORKSPACE_SESSIONS = 32;
const HANDOFF_FOLLOWUP_CONTEXT_LIMIT = 20;
const DEFAULT_WORKSPACE_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RUN_LEASE_TTL_MS = 120_000;
const CONTROL_PLANE_GIT_TRANSPORT_SAMPLE_REPO = "team/smoke";
const ONLINE_SANDBOX_REQUIRED_TENANT_ROLES: TenantRole[] = ["admin", "developer", "viewer"];
const HARNESS_VISION_LOCK: HarnessVisionLock = {
  ...SHARED_HARNESS_VISION_LOCK,
  capabilities: [...SHARED_HARNESS_VISION_LOCK.capabilities],
};
const RUN_PRESENCE_TTL_MS = 45_000;
const QUEUED_RUN_REQUEST_FILE = "queued-request.json";
const RUN_PAUSE_REQUEST_FILE = "pause-request.json";
const RUN_CANCEL_REQUEST_FILE = "cancel-request.json";
const RUN_CONTROL_POLL_INTERVAL_MS = 250;
const RUN_CREATE_REQUEST_REPLAY_TIMEOUT_MS = 30_000;
const RUN_CREATE_REQUEST_REPLAY_POLL_MS = 10;
const RUN_ADMISSION_DIR = ".admission";
const PROJECT_RUN_ADMISSION_LOCK_FILE = "project.lock.json";
const TENANT_ADMISSION_DIR = "admission";
const TENANT_ACTIVE_RUN_ADMISSION_DIR = "active-runs";
const TENANT_ACTIVE_RUN_ADMISSION_LOCK_DIR = "active-runs.lock";
const WORKSPACE_SESSION_ADMISSION_DIR = "workspace-sessions";
const WORKSPACE_SESSION_ADMISSION_LOCK_DIR = "workspace-sessions.lock";
const TENANT_WORKSPACE_SESSION_ADMISSION_DIR = WORKSPACE_SESSION_ADMISSION_DIR;
const TENANT_WORKSPACE_SESSION_ADMISSION_LOCK_DIR = WORKSPACE_SESSION_ADMISSION_LOCK_DIR;
const VAS_LITE_REVIEW_PRESET: RunPresetName = "vas-lite-review";
const VAS_LITE_LOOP = "ingest -> evidence -> prediction -> reconstruction -> review -> learning update";
const VAS_LITE_REVIEW_GOAL = "Review VAS Lite bootstrap case";
const VAS_LITE_REVIEW_REPORT_PATH = "cases/bootstrap/reports/latest.md";
const VAS_LITE_REVIEW_CONTEXT_PATH = "cases/bootstrap/reports/context.json";
const VAS_LITE_REVIEW_DRAFT_PATH = "cases/bootstrap/reports/review-draft.json";
const VAS_LITE_REVIEW_VERIFY_COMMANDS = ["node src/loop.js status"];
const VAS_LITE_REVIEW_GUIDANCE_LIMIT = 5;

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

function tenantActiveRunLimit(options: HarnessServerOptions): number | undefined {
  return options.maxTenantActiveRuns;
}

async function effectiveTenantWorkspaceSessionLimit(options: HarnessServerOptions, tenant: string): Promise<number> {
  const policy = await readTenantPolicy(resolve(options.workspaceRoot), tenant);
  return policy?.limits?.maxWorkspaceSessions ?? tenantWorkspaceSessionLimit(options);
}

async function effectiveTenantWorkspaceByteLimit(options: HarnessServerOptions, tenant: string): Promise<number | undefined> {
  return (await readTenantPolicy(resolve(options.workspaceRoot), tenant))?.limits?.maxWorkspaceBytes;
}

async function effectiveTenantActiveRunLimit(options: HarnessServerOptions, tenant: string): Promise<number | undefined> {
  const policy = await readTenantPolicy(resolve(options.workspaceRoot), tenant);
  return policy?.limits?.maxActiveRuns ?? tenantActiveRunLimit(options);
}

async function effectiveTenantExecutorLimits(options: HarnessServerOptions, tenant: string): Promise<TenantExecutorLimits | undefined> {
  const limits = (await readTenantPolicy(resolve(options.workspaceRoot), tenant))?.limits;
  const executorLimits = compactObject({
    cpus: limits?.executorCpus,
    memory: limits?.executorMemory,
    pidsLimit: limits?.executorPidsLimit,
    network: limits?.executorNetwork,
  });
  return Object.keys(executorLimits).length ? executorLimits : undefined;
}

async function effectiveTenantExecutorTemplateParameters(options: HarnessServerOptions, tenant: string): Promise<string[] | undefined> {
  return (await readTenantPolicy(resolve(options.workspaceRoot), tenant))?.executorTemplateParameters;
}

async function effectiveTenantAllowedTools(options: HarnessServerOptions, tenant: string): Promise<string[]> {
  const serverTools = options.allowedTools ?? [];
  const policy = await readTenantPolicy(resolve(options.workspaceRoot), tenant);
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

function workspaceCommandTimeoutMs(options: HarnessServerOptions): number {
  return options.workspaceCommandTimeoutMs ?? WORKSPACE_COMMAND_TIMEOUT_MS;
}

function workspaceSessionIdleTimeoutMs(options: HarnessServerOptions): number {
  return options.workspaceSessionIdleTimeoutMs ?? DEFAULT_WORKSPACE_SESSION_IDLE_TIMEOUT_MS;
}

function runLeaseTtlMs(options: HarnessServerOptions): number {
  return options.runLeaseTtlMs ?? DEFAULT_RUN_LEASE_TTL_MS;
}

function runHeartbeatIntervalMs(options: HarnessServerOptions): number {
  return Math.max(10, Math.floor(runLeaseTtlMs(options) / 3));
}

function runningRunStatusWithLease(status: Omit<RunningRunStatus, "heartbeatAt" | "leaseExpiresAt">, options: HarnessServerOptions): RunningRunStatus {
  return refreshRunningRunLease(status, options);
}

function refreshRunningRunLease(status: RunningRunStatus, options: HarnessServerOptions): RunningRunStatus {
  const heartbeatAt = new Date().toISOString();
  return {
    ...status,
    heartbeatAt,
    leaseExpiresAt: new Date(Date.parse(heartbeatAt) + runLeaseTtlMs(options)).toISOString(),
  };
}

function runningRunIsStale(state: RunningRunStatus, nowMs = Date.now()): boolean {
  if (!state.leaseExpiresAt) return false;
  const leaseExpiresAt = Date.parse(state.leaseExpiresAt);
  return Number.isFinite(leaseExpiresAt) && leaseExpiresAt <= nowMs;
}

function runAdmissionClaimIsStale(claim: Pick<RunAdmissionClaim, "leaseExpiresAt">, nowMs = Date.now()): boolean {
  const leaseExpiresAt = Date.parse(claim.leaseExpiresAt);
  return Number.isFinite(leaseExpiresAt) && leaseExpiresAt <= nowMs;
}

function runAdmissionClaimFor(run: Pick<HarnessRunStart, "tenant" | "project" | "runId">, options: HarnessServerOptions): RunAdmissionClaim {
  const heartbeatAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    tenant: run.tenant,
    project: run.project,
    runId: run.runId,
    scope: runWorkspacesAreIsolated(options) ? "run" : "project",
    heartbeatAt,
    leaseExpiresAt: new Date(Date.parse(heartbeatAt) + runLeaseTtlMs(options)).toISOString(),
  };
}

function runAdmissionLockPath(options: HarnessServerOptions, run: Pick<HarnessRunStart, "runRoot" | "runId">): string {
  const filename = runWorkspacesAreIsolated(options) ? `${run.runId}.lock.json` : PROJECT_RUN_ADMISSION_LOCK_FILE;
  return join(run.runRoot, RUN_ADMISSION_DIR, filename);
}

async function tryAcquireRunAdmissionClaim(
  options: HarnessServerOptions,
  run: Pick<HarnessRunStart, "tenant" | "project" | "runId" | "runRoot">,
): Promise<RunAdmissionClaimResult> {
  const lockPath = runAdmissionLockPath(options, run);
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const claim = runAdmissionClaimFor(run, options);
    try {
      const file = await open(lockPath, "wx");
      try {
        await file.writeFile(JSON.stringify(claim, null, 2) + "\n", "utf8");
      } finally {
        await file.close();
      }
      return { ok: true, handle: runAdmissionClaimHandle(options, lockPath, claim) };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const blockingRunId = await blockingRunAdmissionClaimId(options, lockPath);
      if (blockingRunId) return { ok: false, runId: blockingRunId };
    }
  }
  return { ok: false, runId: "unknown" };
}

function runAdmissionClaimHandle(options: HarnessServerOptions, lockPath: string, claim: RunAdmissionClaim): RunAdmissionClaimHandle {
  return {
    claim,
    release: () => releaseRunAdmissionClaim(lockPath, claim.runId),
    refresh: () => refreshRunAdmissionClaim(options, lockPath, claim),
  };
}

async function blockingRunAdmissionClaimId(options: HarnessServerOptions, lockPath: string): Promise<string | undefined> {
  const claim = await readRunAdmissionClaim(lockPath);
  if (claim) {
    if (!runAdmissionClaimIsStale(claim)) return claim.runId;
    await unlink(lockPath).catch((error) => {
      if (!isNotFound(error)) throw error;
    });
    return undefined;
  }
  const stats = await stat(lockPath).catch((error) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (!stats) return undefined;
  if (stats.mtimeMs + runLeaseTtlMs(options) <= Date.now()) {
    await unlink(lockPath).catch((error) => {
      if (!isNotFound(error)) throw error;
    });
    return undefined;
  }
  return "unknown";
}

async function readRunAdmissionClaim(lockPath: string): Promise<RunAdmissionClaim | undefined> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    if (
      value.schemaVersion === 1 &&
      typeof value.tenant === "string" &&
      typeof value.project === "string" &&
      typeof value.runId === "string" &&
      (value.scope === "project" || value.scope === "run") &&
      typeof value.heartbeatAt === "string" &&
      typeof value.leaseExpiresAt === "string"
    ) {
      return value as unknown as RunAdmissionClaim;
    }
    return undefined;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function refreshRunAdmissionClaim(options: HarnessServerOptions, lockPath: string, claim: RunAdmissionClaim): Promise<void> {
  const current = await readRunAdmissionClaim(lockPath);
  if (current?.runId !== claim.runId) return;
  await writeJsonFileAtomic(lockPath, runAdmissionClaimFor(claim, options));
}

async function releaseRunAdmissionClaim(lockPath: string, runId: string): Promise<void> {
  const current = await readRunAdmissionClaim(lockPath);
  if (current && current.runId !== runId) return;
  await unlink(lockPath).catch((error) => {
    if (!isNotFound(error)) throw error;
  });
}

function runAdmissionConflict(claim: Extract<RunAdmissionClaimResult, { ok: false }>): Error {
  return conflict(`tenant project already has an active run: ${claim.runId}`);
}

function tenantRunAdmissionClaimFor(
  run: Pick<HarnessRunStart, "tenant" | "project" | "runId">,
  limit: number,
  options: HarnessServerOptions,
): TenantRunAdmissionClaim {
  const heartbeatAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    tenant: run.tenant,
    project: run.project,
    runId: run.runId,
    limit,
    heartbeatAt,
    leaseExpiresAt: new Date(Date.parse(heartbeatAt) + runLeaseTtlMs(options)).toISOString(),
  };
}

function tenantRunAdmissionRoot(options: HarnessServerOptions, tenant: string): string {
  return join(resolve(options.workspaceRoot), tenant, ".loom", TENANT_ADMISSION_DIR, TENANT_ACTIVE_RUN_ADMISSION_DIR);
}

function tenantRunAdmissionLockDir(options: HarnessServerOptions, tenant: string): string {
  return join(resolve(options.workspaceRoot), tenant, ".loom", TENANT_ADMISSION_DIR, TENANT_ACTIVE_RUN_ADMISSION_LOCK_DIR);
}

function tenantRunAdmissionClaimPath(options: HarnessServerOptions, run: Pick<HarnessRunStart, "tenant" | "runId">): string {
  return join(tenantRunAdmissionRoot(options, run.tenant), `${run.runId}.json`);
}

async function tryAcquireTenantRunAdmissionClaim(
  options: HarnessServerOptions,
  run: Pick<HarnessRunStart, "tenant" | "project" | "runId">,
  limit: number,
): Promise<TenantRunAdmissionClaimResult> {
  const releaseMutex = await acquireTenantRunAdmissionMutex(options, run.tenant);
  try {
    const activeRunIds = await activeTenantRunAdmissionClaimIds(options, run.tenant);
    if (activeRunIds.length >= limit) return { ok: false, runIds: activeRunIds, limit };
    const claim = tenantRunAdmissionClaimFor(run, limit, options);
    const claimPath = tenantRunAdmissionClaimPath(options, run);
    await mkdir(dirname(claimPath), { recursive: true });
    const file = await open(claimPath, "wx");
    try {
      await file.writeFile(JSON.stringify(claim, null, 2) + "\n", "utf8");
    } finally {
      await file.close();
    }
    return { ok: true, handle: tenantRunAdmissionClaimHandle(options, claimPath, claim) };
  } finally {
    await releaseMutex();
  }
}

async function activeTenantRunAdmissionClaimIds(options: HarnessServerOptions, tenant: string): Promise<string[]> {
  const root = tenantRunAdmissionRoot(options, tenant);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const runIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(root, entry.name);
    const claim = await readTenantRunAdmissionClaim(path);
    if (claim) {
      if (runAdmissionClaimIsStale(claim)) {
        await unlink(path).catch((error) => {
          if (!isNotFound(error)) throw error;
        });
        continue;
      }
      if (claim.tenant === tenant) runIds.push(claim.runId);
      continue;
    }
    const stats = await stat(path).catch((error) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (!stats) continue;
    if (stats.mtimeMs + runLeaseTtlMs(options) <= Date.now()) {
      await unlink(path).catch((error) => {
        if (!isNotFound(error)) throw error;
      });
      continue;
    }
    const fallbackRunId = entry.name.slice(0, -".json".length);
    runIds.push(isSafeDirectoryName(fallbackRunId) ? fallbackRunId : "unknown");
  }
  return [...new Set(runIds)].sort((a, b) => a.localeCompare(b));
}

function tenantRunAdmissionClaimHandle(
  options: HarnessServerOptions,
  claimPath: string,
  claim: TenantRunAdmissionClaim,
): TenantRunAdmissionClaimHandle {
  return {
    claim,
    release: () => releaseTenantRunAdmissionClaim(claimPath, claim.runId),
    refresh: () => refreshTenantRunAdmissionClaim(options, claimPath, claim),
  };
}

async function readTenantRunAdmissionClaim(claimPath: string): Promise<TenantRunAdmissionClaim | undefined> {
  try {
    const value = JSON.parse(await readFile(claimPath, "utf8")) as Record<string, unknown>;
    if (
      value.schemaVersion === 1 &&
      typeof value.tenant === "string" &&
      typeof value.project === "string" &&
      typeof value.runId === "string" &&
      typeof value.limit === "number" &&
      Number.isInteger(value.limit) &&
      value.limit >= 1 &&
      typeof value.heartbeatAt === "string" &&
      typeof value.leaseExpiresAt === "string"
    ) {
      return value as unknown as TenantRunAdmissionClaim;
    }
    return undefined;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function refreshTenantRunAdmissionClaim(
  options: HarnessServerOptions,
  claimPath: string,
  claim: TenantRunAdmissionClaim,
): Promise<void> {
  const current = await readTenantRunAdmissionClaim(claimPath);
  if (current?.runId !== claim.runId) return;
  await writeJsonFileAtomic(claimPath, tenantRunAdmissionClaimFor(claim, claim.limit, options));
}

async function releaseTenantRunAdmissionClaim(claimPath: string, runId: string): Promise<void> {
  const current = await readTenantRunAdmissionClaim(claimPath);
  if (current && current.runId !== runId) return;
  await unlink(claimPath).catch((error) => {
    if (!isNotFound(error)) throw error;
  });
}

async function acquireTenantRunAdmissionMutex(options: HarnessServerOptions, tenant: string): Promise<() => Promise<void>> {
  const lockDir = tenantRunAdmissionLockDir(options, tenant);
  await mkdir(dirname(lockDir), { recursive: true });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await mkdir(lockDir);
      return async () => {
        await rmdir(lockDir).catch((error) => {
          if (!isNotFound(error)) throw error;
        });
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const stats = await stat(lockDir).catch((statError) => {
        if (isNotFound(statError)) return undefined;
        throw statError;
      });
      if (stats && stats.mtimeMs + runLeaseTtlMs(options) <= Date.now()) {
        await rmdir(lockDir).catch((removeError) => {
          if (!isNotFound(removeError)) throw removeError;
        });
        continue;
      }
      if (Date.now() >= deadline) throw conflict("tenant active run admission is busy");
      await delay(10);
    }
  }
}

function combinedRunAdmissionClaimHandle(
  runClaim: RunAdmissionClaimHandle,
  tenantClaim: TenantRunAdmissionClaimHandle | undefined,
): RunAdmissionClaimHandle {
  return {
    claim: runClaim.claim,
    refresh: async () => {
      await runClaim.refresh();
      await tenantClaim?.refresh();
    },
    release: async () => {
      await runClaim.release();
      await tenantClaim?.release();
    },
  };
}

async function tryAcquireActiveRunAdmission(
  options: HarnessServerOptions,
  run: Pick<HarnessRunStart, "tenant" | "project" | "runId" | "runRoot">,
  tenantRunLimit: number | undefined,
): Promise<ActiveRunAdmissionResult> {
  let tenantClaim: TenantRunAdmissionClaimHandle | undefined;
  if (tenantRunLimit !== undefined) {
    const tenantAdmission = await tryAcquireTenantRunAdmissionClaim(options, run, tenantRunLimit);
    if (!tenantAdmission.ok) {
      return {
        ok: false,
        admission: queuedAdmissionTenantActiveRunLimit(tenantAdmission.runIds, tenantAdmission.limit),
        error: conflict(`active run tenant limit reached: ${tenantAdmission.runIds.join(", ")}`),
      };
    }
    tenantClaim = tenantAdmission.handle;
  }

  const runAdmission = await tryAcquireRunAdmissionClaim(options, run);
  if (!runAdmission.ok) {
    await tenantClaim?.release();
    return {
      ok: false,
      admission: queuedAdmissionProjectActiveWorkspace(runAdmission.runId),
      error: runAdmissionConflict(runAdmission),
    };
  }

  return { ok: true, handle: combinedRunAdmissionClaimHandle(runAdmission.handle, tenantClaim) };
}

function workspaceSessionAdmissionClaimFor(
  context: Pick<HarnessWorkspaceContext, "tenant" | "project">,
  route: ActiveWorkspaceSession["route"],
  sessionId: string,
  limit: number,
  options: HarnessServerOptions,
): WorkspaceSessionAdmissionClaim {
  const heartbeatAt = new Date().toISOString();
  return compactObject({
    schemaVersion: 1 as const,
    tenant: context.tenant,
    project: context.project,
    runId: route.kind === "run" ? route.runId : undefined,
    route: route.kind,
    sessionId,
    limit,
    heartbeatAt,
    leaseExpiresAt: new Date(Date.parse(heartbeatAt) + runLeaseTtlMs(options)).toISOString(),
  }) as WorkspaceSessionAdmissionClaim;
}

function globalWorkspaceSessionAdmissionRoot(options: HarnessServerOptions): string {
  return join(resolve(options.workspaceRoot), ".loom", TENANT_ADMISSION_DIR, WORKSPACE_SESSION_ADMISSION_DIR);
}

function globalWorkspaceSessionAdmissionLockDir(options: HarnessServerOptions): string {
  return join(resolve(options.workspaceRoot), ".loom", TENANT_ADMISSION_DIR, WORKSPACE_SESSION_ADMISSION_LOCK_DIR);
}

function globalWorkspaceSessionAdmissionClaimPath(
  options: HarnessServerOptions,
  claim: Pick<WorkspaceSessionAdmissionClaim, "sessionId">,
): string {
  return join(globalWorkspaceSessionAdmissionRoot(options), `${claim.sessionId}.json`);
}

function workspaceSessionAdmissionRoot(options: HarnessServerOptions, tenant: string): string {
  return join(resolve(options.workspaceRoot), tenant, ".loom", TENANT_ADMISSION_DIR, TENANT_WORKSPACE_SESSION_ADMISSION_DIR);
}

function workspaceSessionAdmissionLockDir(options: HarnessServerOptions, tenant: string): string {
  return join(resolve(options.workspaceRoot), tenant, ".loom", TENANT_ADMISSION_DIR, TENANT_WORKSPACE_SESSION_ADMISSION_LOCK_DIR);
}

function workspaceSessionAdmissionClaimPath(
  options: HarnessServerOptions,
  claim: Pick<WorkspaceSessionAdmissionClaim, "tenant" | "sessionId">,
): string {
  return join(workspaceSessionAdmissionRoot(options, claim.tenant), `${claim.sessionId}.json`);
}

async function tryAcquireWorkspaceSessionAdmissionClaims(
  options: HarnessServerOptions,
  context: Pick<HarnessWorkspaceContext, "tenant" | "project">,
  route: ActiveWorkspaceSession["route"],
  sessionId: string,
  globalLimit: number,
  tenantLimit: number,
): Promise<WorkspaceSessionAdmissionClaimResult & { scope?: "global" | "tenant" }> {
  const globalAdmission = await tryAcquireGlobalWorkspaceSessionAdmissionClaim(options, context, route, sessionId, globalLimit);
  if (!globalAdmission.ok) return { ...globalAdmission, scope: "global" };
  try {
    const tenantAdmission = await tryAcquireTenantWorkspaceSessionAdmissionClaim(options, context, route, sessionId, tenantLimit);
    if (!tenantAdmission.ok) {
      await globalAdmission.handle.release();
      return { ...tenantAdmission, scope: "tenant" };
    }
    return {
      ok: true,
      handle: combinedWorkspaceSessionAdmissionClaimHandle([globalAdmission.handle, tenantAdmission.handle]),
    };
  } catch (error) {
    await globalAdmission.handle.release();
    throw error;
  }
}

async function tryAcquireGlobalWorkspaceSessionAdmissionClaim(
  options: HarnessServerOptions,
  context: Pick<HarnessWorkspaceContext, "tenant" | "project">,
  route: ActiveWorkspaceSession["route"],
  sessionId: string,
  limit: number,
): Promise<WorkspaceSessionAdmissionClaimResult> {
  const releaseMutex = await acquireWorkspaceSessionAdmissionMutex(options, globalWorkspaceSessionAdmissionLockDir(options));
  try {
    const activeSessionIds = await activeWorkspaceSessionAdmissionClaimIds(options, globalWorkspaceSessionAdmissionRoot(options));
    if (activeSessionIds.length >= limit) return { ok: false, sessionIds: activeSessionIds, limit };
    const claim = workspaceSessionAdmissionClaimFor(context, route, sessionId, limit, options);
    const claimPath = globalWorkspaceSessionAdmissionClaimPath(options, claim);
    await mkdir(dirname(claimPath), { recursive: true });
    const file = await open(claimPath, "wx");
    try {
      await file.writeFile(JSON.stringify(claim, null, 2) + "\n", "utf8");
    } finally {
      await file.close();
    }
    return { ok: true, handle: workspaceSessionAdmissionClaimHandle(options, claimPath, claim) };
  } finally {
    await releaseMutex();
  }
}

async function tryAcquireTenantWorkspaceSessionAdmissionClaim(
  options: HarnessServerOptions,
  context: Pick<HarnessWorkspaceContext, "tenant" | "project">,
  route: ActiveWorkspaceSession["route"],
  sessionId: string,
  limit: number,
): Promise<WorkspaceSessionAdmissionClaimResult> {
  const releaseMutex = await acquireWorkspaceSessionAdmissionMutex(options, workspaceSessionAdmissionLockDir(options, context.tenant));
  try {
    const activeSessionIds = await activeWorkspaceSessionAdmissionClaimIds(options, workspaceSessionAdmissionRoot(options, context.tenant), (claim) => claim.tenant === context.tenant);
    if (activeSessionIds.length >= limit) return { ok: false, sessionIds: activeSessionIds, limit };
    const claim = workspaceSessionAdmissionClaimFor(context, route, sessionId, limit, options);
    const claimPath = workspaceSessionAdmissionClaimPath(options, claim);
    await mkdir(dirname(claimPath), { recursive: true });
    const file = await open(claimPath, "wx");
    try {
      await file.writeFile(JSON.stringify(claim, null, 2) + "\n", "utf8");
    } finally {
      await file.close();
    }
    return { ok: true, handle: workspaceSessionAdmissionClaimHandle(options, claimPath, claim) };
  } finally {
    await releaseMutex();
  }
}

async function activeWorkspaceSessionAdmissionClaimIds(
  options: HarnessServerOptions,
  root: string,
  includeClaim: (claim: WorkspaceSessionAdmissionClaim) => boolean = () => true,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const sessionIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(root, entry.name);
    const claim = await readWorkspaceSessionAdmissionClaim(path);
    if (claim) {
      if (runAdmissionClaimIsStale(claim)) {
        await unlink(path).catch((error) => {
          if (!isNotFound(error)) throw error;
        });
        continue;
      }
      if (includeClaim(claim)) sessionIds.push(claim.sessionId);
      continue;
    }
    const stats = await stat(path).catch((error) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (!stats) continue;
    if (stats.mtimeMs + runLeaseTtlMs(options) <= Date.now()) {
      await unlink(path).catch((error) => {
        if (!isNotFound(error)) throw error;
      });
      continue;
    }
    const fallbackSessionId = entry.name.slice(0, -".json".length);
    sessionIds.push(isSafeDirectoryName(fallbackSessionId) ? fallbackSessionId : "unknown");
  }
  return [...new Set(sessionIds)].sort((a, b) => a.localeCompare(b));
}

function combinedWorkspaceSessionAdmissionClaimHandle(handles: WorkspaceSessionAdmissionClaimHandle[]): WorkspaceSessionAdmissionClaimHandle {
  return {
    claim: handles[handles.length - 1].claim,
    release: async () => {
      await Promise.all(handles.map((handle) => handle.release()));
    },
    refresh: async () => {
      await Promise.all(handles.map((handle) => handle.refresh()));
    },
  };
}

function workspaceSessionAdmissionClaimHandle(
  options: HarnessServerOptions,
  claimPath: string,
  claim: WorkspaceSessionAdmissionClaim,
): WorkspaceSessionAdmissionClaimHandle {
  return {
    claim,
    release: () => releaseWorkspaceSessionAdmissionClaim(claimPath, claim.sessionId),
    refresh: () => refreshWorkspaceSessionAdmissionClaim(options, claimPath, claim),
  };
}

async function readWorkspaceSessionAdmissionClaim(claimPath: string): Promise<WorkspaceSessionAdmissionClaim | undefined> {
  try {
    const value = JSON.parse(await readFile(claimPath, "utf8")) as Record<string, unknown>;
    if (
      value.schemaVersion === 1 &&
      typeof value.tenant === "string" &&
      typeof value.project === "string" &&
      (value.runId === undefined || typeof value.runId === "string") &&
      (value.route === "project" || value.route === "run") &&
      (value.route !== "run" || typeof value.runId === "string") &&
      typeof value.sessionId === "string" &&
      typeof value.limit === "number" &&
      Number.isInteger(value.limit) &&
      value.limit >= 1 &&
      typeof value.heartbeatAt === "string" &&
      typeof value.leaseExpiresAt === "string"
    ) {
      return value as unknown as WorkspaceSessionAdmissionClaim;
    }
    return undefined;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function refreshWorkspaceSessionAdmissionClaim(
  options: HarnessServerOptions,
  claimPath: string,
  claim: WorkspaceSessionAdmissionClaim,
): Promise<void> {
  const current = await readWorkspaceSessionAdmissionClaim(claimPath);
  if (current?.sessionId !== claim.sessionId) return;
  const route: ActiveWorkspaceSession["route"] = claim.route === "run"
    ? { kind: "run", runId: claim.runId ?? "" }
    : { kind: "project" };
  await writeJsonFileAtomic(claimPath, workspaceSessionAdmissionClaimFor(claim, route, claim.sessionId, claim.limit, options));
}

async function releaseWorkspaceSessionAdmissionClaim(claimPath: string, sessionId: string): Promise<void> {
  const current = await readWorkspaceSessionAdmissionClaim(claimPath);
  if (current && current.sessionId !== sessionId) return;
  await unlink(claimPath).catch((error) => {
    if (!isNotFound(error)) throw error;
  });
}

async function acquireWorkspaceSessionAdmissionMutex(options: HarnessServerOptions, lockDir: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockDir), { recursive: true });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await mkdir(lockDir);
      return async () => {
        await rmdir(lockDir).catch((error) => {
          if (!isNotFound(error)) throw error;
        });
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const stats = await stat(lockDir).catch((statError) => {
        if (isNotFound(statError)) return undefined;
        throw statError;
      });
      if (stats && stats.mtimeMs + runLeaseTtlMs(options) <= Date.now()) {
        await rmdir(lockDir).catch((removeError) => {
          if (!isNotFound(removeError)) throw removeError;
        });
        continue;
      }
      if (Date.now() >= deadline) throw conflict("workspace session admission is busy");
      await delay(10);
    }
  }
}

function startWorkspaceSessionAdmissionClaimHeartbeat(options: HarnessServerOptions, claim: WorkspaceSessionAdmissionClaimHandle): () => void {
  let stopped = false;
  const heartbeat = setInterval(() => {
    if (stopped) return;
    void claim.refresh().catch(() => undefined);
  }, runHeartbeatIntervalMs(options));
  heartbeat.unref?.();
  return () => {
    stopped = true;
    clearInterval(heartbeat);
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startRunAdmissionClaimHeartbeat(options: HarnessServerOptions, claim: RunAdmissionClaimHandle): () => void {
  let stopped = false;
  const heartbeat = setInterval(() => {
    if (stopped) return;
    void claim.refresh().catch(() => undefined);
  }, runHeartbeatIntervalMs(options));
  heartbeat.unref?.();
  return () => {
    stopped = true;
    clearInterval(heartbeat);
  };
}

function activeWorkspaceSessionCount(activeSessions: Map<string, ActiveWorkspaceSession>): number {
  return [...activeSessions.values()].filter((session) => session.status === "running").length;
}

function activeTenantWorkspaceSessionCount(activeSessions: Map<string, ActiveWorkspaceSession>, tenant: string): number {
  return [...activeSessions.values()].filter((session) => session.status === "running" && session.context.tenant === tenant).length;
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

function activeTenantRunCount(activeRunSlots: Map<string, ActiveRunSlot>, tenant: string): number {
  return [...activeRunSlots.values()].filter((run) => run.tenant === tenant).length;
}

function activeTenantRunIds(activeRunSlots: Map<string, ActiveRunSlot>, tenant: string): string[] {
  return [...activeRunSlots.values()].filter((run) => run.tenant === tenant).map((run) => run.runId);
}

async function statusActiveTenantRunIds(
  options: HarnessServerOptions,
  activeRunSlots: Map<string, ActiveRunSlot>,
  tenant: string,
): Promise<string[]> {
  const runIds = new Set(activeTenantRunIds(activeRunSlots, tenant));
  if (await effectiveTenantActiveRunLimit(options, tenant) !== undefined) {
    for (const runId of await activeTenantRunAdmissionClaimIds(options, tenant)) {
      runIds.add(runId);
    }
  }
  return [...runIds].sort((a, b) => a.localeCompare(b));
}

function queuedTenantRunCount(queuedRuns: QueuedRun[], tenant: string): number {
  return queuedRuns.filter((run) => run.tenant === tenant).length;
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

async function enforceModelUsageTokenLimitsForBody(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenant: string,
  project: string,
  body: RunRequestBody,
  requester: RunRequester | undefined,
): Promise<void> {
  if (runAgentMetadata(body, options).agentMode !== "model") return;
  await enforceModelUsageTokenLimits(workspaceRoot, tenant, project, requester);
}

async function enforceModelUsageTokenLimitsForRun(
  workspaceRoot: string,
  run: Pick<HarnessRunStart, "tenant" | "project" | "metadata" | "requester">,
): Promise<void> {
  if (run.metadata.agentMode !== "model") return;
  await enforceModelUsageTokenLimits(workspaceRoot, run.tenant, run.project, run.requester);
}

async function enforceModelUsageTokenLimits(
  workspaceRoot: string,
  tenant: string,
  project: string,
  requester: RunRequester | undefined,
): Promise<void> {
  const policyLimits = (await readTenantPolicy(workspaceRoot, tenant))?.limits;
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

function tenantResourceStatuses(
  activeRunDetails: ActiveRunSlot[],
  queuedRuns: QueuedRun[],
  activeSessionDetails: WorkspaceSessionSummary[],
): TenantResourceStatus[] {
  const byTenant = new Map<string, TenantResourceStatus>();
  const ensureTenant = (tenant: string): TenantResourceStatus => {
    const existing = byTenant.get(tenant);
    if (existing) return existing;
    const status = { tenant, activeRuns: 0, queuedRuns: 0, activeWorkspaceSessions: 0 };
    byTenant.set(tenant, status);
    return status;
  };
  for (const run of activeRunDetails) {
    ensureTenant(run.tenant).activeRuns += 1;
  }
  for (const run of queuedRuns) {
    ensureTenant(run.tenant).queuedRuns += 1;
  }
  for (const session of activeSessionDetails) {
    ensureTenant(session.tenant).activeWorkspaceSessions += 1;
  }
  return [...byTenant.values()].sort((a, b) => a.tenant.localeCompare(b.tenant));
}

function activeRunResourceStatuses(options: HarnessServerOptions, activeRunDetails: ActiveRunSlot[]): ActiveRunResourceStatus[] {
  return activeRunDetails.map((run) => ({
    ...run,
    workspaceLeaseScope: runWorkspaceIsolation(options),
    workspaceLeaseKey: activeRunWorkspaceLeaseKey(options, run.tenant, run.project, run.runId),
  }));
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

function tenantResourceStatusWithSessionDetails(
  status: TenantResourceStatus,
  activeSessionDetails: WorkspaceSessionSummary[],
): TenantResourceStatus {
  const details = activeSessionDetails.filter((session) => session.tenant === status.tenant);
  return compactObject({
    ...status,
    activeWorkspaceSessionDetails: details.length ? details : undefined,
  });
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

async function statusActiveRunDetails(
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRunSlots: Map<string, ActiveRunSlot>,
  tenantFilter?: string,
): Promise<ActiveRunSlot[]> {
  const byKey = new Map<string, ActiveRunSlot>();
  const addRun = (run: ActiveRunSlot): void => {
    if (tenantFilter && run.tenant !== tenantFilter) return;
    byKey.set(activeRunKey(run.tenant, run.project, run.runId), run);
  };

  for (const run of activeRunSlots.values()) addRun(run);

  const runDirs = await listPersistedRunDirs(workspaceRoot, tenantFilter);
  for (const runDir of runDirs) {
    const state = await readRunStateForScan(runDir);
    if (!state || !isSafePersistedRunState(state) || state.status !== "running") continue;
    const key = activeRunKey(state.tenant, state.project, state.runId);
    if (byKey.has(key)) continue;
    if (await persistedRunningRunHasActiveAdmissionClaim(options, runDir, state)) {
      addRun({ tenant: state.tenant, project: state.project, runId: state.runId });
    }
  }

  return [...byKey.values()].sort((a, b) =>
    a.tenant.localeCompare(b.tenant)
    || a.project.localeCompare(b.project)
    || a.runId.localeCompare(b.runId)
  );
}

async function persistedRunningRunHasActiveAdmissionClaim(
  options: HarnessServerOptions,
  runDir: string,
  state: RunningRunStatus,
): Promise<boolean> {
  const claim = await readRunAdmissionClaim(runAdmissionLockPath(options, {
    runRoot: dirname(runDir),
    runId: state.runId,
  }));
  return claim?.tenant === state.tenant
    && claim.project === state.project
    && claim.runId === state.runId
    && !runAdmissionClaimIsStale(claim);
}

async function queuedRunResourceStatuses(
  options: HarnessServerOptions,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  queuedRuns: QueuedRun[],
  tenantFilter?: string,
): Promise<QueuedRunResourceStatus[]> {
  const statuses: QueuedRunResourceStatus[] = [];
  for (const run of queuedRuns) {
    if (tenantFilter && run.tenant !== tenantFilter) continue;
    statuses.push(await queuedRunResourceStatus(options, activeRunSlots, activeWorkspaces, {
      tenant: run.tenant,
      project: run.project,
      runId: run.runId,
      goal: run.goal,
      queuedAt: run.status.queuedAt,
      ...queuedRunPositions(queuedRuns, run),
      runRoot: run.runRoot,
    }));
  }
  return statuses;
}

async function queuedRunResourceStatus(
  options: HarnessServerOptions,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  run: { tenant: string; project: string; runId: string; goal: string; queuedAt: string; tenantQueuePosition?: number; projectQueuePosition?: number; runRoot: string },
): Promise<QueuedRunResourceStatus> {
  const tenantRunLimit = await effectiveTenantActiveRunLimit(options, run.tenant);
  const tenantRunIds = await statusActiveTenantRunIds(options, activeRunSlots, run.tenant);
  const base = {
    tenant: run.tenant,
    project: run.project,
    runId: run.runId,
    goal: run.goal,
    queuedAt: run.queuedAt,
    tenantQueuePosition: run.tenantQueuePosition,
    projectQueuePosition: run.projectQueuePosition,
  };
  if (tenantRunLimit !== undefined && tenantRunIds.length >= tenantRunLimit) {
    return compactObject({
      ...base,
      ...queuedAdmissionTenantActiveRunLimit(tenantRunIds, tenantRunLimit),
    });
  }

	  const activeRunId = activeWorkspaces.get(activeRunWorkspaceKey(options, run.tenant, run.project, run.runId));
	  if (activeRunId) {
	    return {
	      ...base,
	      ...queuedAdmissionProjectActiveWorkspace(activeRunId),
	    };
	  }
	
	  const persistedRunId = await findBlockingPersistedRunningRun(options, run.runRoot);
  if (persistedRunId) {
    return {
      ...base,
      ...queuedAdmissionPersistedRunningRun(persistedRunId),
    };
  }

  return { ...base, ...queuedAdmissionReady() };
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

function queuedAdmissionTenantActiveRunLimit(tenantRunIds: string[], tenantRunLimit: number): QueuedRunAdmission {
  return compactObject({
    blockedReason: "tenant_active_run_limit" as const,
    blockedByRunIds: tenantRunIds,
    limit: tenantRunLimit,
    concurrency: queuedRunConcurrencySummary("tenant_active_run_limit", tenantRunIds, {
      activeTenantRunCount: tenantRunIds.length,
      tenantActiveRunLimit: tenantRunLimit,
    }),
  });
}

function queuedAdmissionProjectActiveWorkspace(activeRunId: string): QueuedRunAdmission {
  return {
    blockedReason: "project_active_workspace",
    blockedByRunIds: [activeRunId],
    concurrency: queuedRunConcurrencySummary("project_active_workspace", [activeRunId], {
      projectActiveRunId: activeRunId,
    }),
  };
}

function queuedAdmissionPersistedRunningRun(persistedRunId: string): QueuedRunAdmission {
  return {
    blockedReason: "persisted_running_run",
    blockedByRunIds: [persistedRunId],
    concurrency: queuedRunConcurrencySummary("persisted_running_run", [persistedRunId], {
      persistedRunId,
    }),
  };
}

function queuedAdmissionReady(): QueuedRunAdmission {
  return {
    blockedReason: "ready",
    concurrency: queuedRunConcurrencySummary("ready"),
  };
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

async function orphanedRunningRunResourceStatuses(
  workspaceRoot: string,
  activeRunDetails: ActiveRunSlot[],
  tenantFilter?: string,
): Promise<OrphanedRunningRunResourceStatus[]> {
  const runDirs = await listPersistedRunDirs(workspaceRoot, tenantFilter);
  const statuses: OrphanedRunningRunResourceStatus[] = [];
  const activeRunKeys = new Set(activeRunDetails.map((run) => activeRunKey(run.tenant, run.project, run.runId)));
  for (const runDir of runDirs) {
    const state = await readRunStateForScan(runDir);
    if (!state) continue;
    if (!isSafePersistedRunState(state)) continue;
    if (state.status !== "running") continue;
    if (activeRunKeys.has(activeRunKey(state.tenant, state.project, state.runId))) continue;
    const stale = runningRunIsStale(state);
    statuses.push({
      tenant: state.tenant,
      project: state.project,
      runId: state.runId,
      goal: state.goal,
      startedAt: state.startedAt,
      heartbeatAt: state.heartbeatAt,
      leaseExpiresAt: state.leaseExpiresAt,
      stale,
      staleReason: stale ? "lease_expired" : undefined,
      runDir: state.runDir,
    });
  }
  return statuses.sort((a, b) => `${a.tenant}/${a.project}/${a.runId}`.localeCompare(`${b.tenant}/${b.project}/${b.runId}`));
}

async function harnessServerStatus(
  workspaceRoot: string,
  options: HarnessServerOptions,
  startedAt: string,
  allowedTools: string[],
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  queuedRuns: QueuedRun[],
  activeSessions: Map<string, ActiveWorkspaceSession>,
  queueRecovery: QueueRecoveryAudit,
  staleRunCleanup: StaleRunCleanupAudit,
): Promise<HarnessServerStatus> {
  const activeSessionDetails = await statusActiveWorkspaceSessionDetails(workspaceRoot, options, activeSessions);
  const activeRunDetails = await statusActiveRunDetails(workspaceRoot, options, activeRunSlots);
  const activeRunResourceDetails = activeRunResourceStatuses(options, activeRunDetails);
  const controlPlaneDiscovery = await controlPlaneDiscoveryStatus(options);
  return {
    server: {
      workspaceRoot,
      profile: options.profile,
      startedAt,
      uptimeMs: Math.max(0, Date.now() - Date.parse(startedAt)),
      controlPlane: harnessControlPlaneStatus(options, controlPlaneDiscovery),
      runWorkspaceIsolation: runWorkspaceIsolation(options),
      runCreateIdempotency: runCreateIdempotencyStatus(),
      concurrencyAdmission: await harnessConcurrencyAdmissionStatus(options),
    },
    readiness: await harnessProfileReadiness(workspaceRoot, options, allowedTools, undefined, controlPlaneDiscovery),
    limits: harnessServerLimits(options),
    resources: compactObject({
      activeRuns: activeRunDetails.length,
      activeRunDetails: activeRunResourceDetails.length ? activeRunResourceDetails : undefined,
      queuedRuns: queuedRuns.length,
      activeWorkspaceSessions: activeSessionDetails.length,
      activeWorkspaceSessionDetails: activeSessionDetails,
      queueRecovery,
      staleRunCleanup,
      orphanedRunningRunDetails: await orphanedRunningRunResourceStatuses(workspaceRoot, activeRunDetails),
      queuedRunDetails: await queuedRunResourceStatuses(options, activeRunSlots, activeWorkspaces, queuedRuns),
      tenants: tenantResourceStatuses(activeRunDetails, queuedRuns, activeSessionDetails)
        .map((status) => tenantResourceStatusWithSessionDetails(status, activeSessionDetails)),
    }),
    policy: {
      allowedTools,
    },
    visionLock: HARNESS_VISION_LOCK,
  };
}

async function harnessProfileReadiness(
  workspaceRoot: string,
  options: HarnessServerOptions,
  allowedTools: string[],
  tenantScope?: string,
  controlPlaneDiscovery?: ControlPlaneDiscoveryStatus,
): Promise<HarnessProfileReadiness> {
  const profile = options.profile;
  const onlineSandboxRequired = profile === "online-sandbox" || profile === "platform-readiness";
  const platformRequired = profile === "platform-readiness";
  const missingOnlineSandboxTools = ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS.filter((tool) => !allowedTools.includes(tool));
  const gitPrAllowed = allowedTools.includes("git.pr");
  const sandboxExecutorOk = options.executorKind === "docker" || options.executorKind === "coder";
  const persistentHomeOk = options.executorKind === "coder" || Boolean(options.executorHomeRoot);
  const runWorkspaceIsolationMode = runWorkspaceIsolation(options);
  const runCreateIdempotency = runCreateIdempotencyStatus();
  const model = await modelReadiness(workspaceRoot, options, tenantScope);
  const tenantAuth = await tenantAuthReadiness(workspaceRoot, options, tenantScope);
  const controlPlaneAgentIdentity = await controlPlaneAgentIdentityReadiness(workspaceRoot, options, tenantScope);
  const agentGitServiceProjectAgents = await agentGitServiceProjectAgentsReadiness(workspaceRoot, options, tenantScope);
  const controlPlaneDiscoveryReadiness = controlPlaneDiscoveryReadinessStatus(options, platformRequired, controlPlaneDiscovery);
  const controlPlaneGitTransport = controlPlaneGitTransportReadiness(options, gitPrAllowed);
  const checks: HarnessProfileReadiness["checks"] = {
    onlineSandboxTools: {
      required: onlineSandboxRequired,
      ok: missingOnlineSandboxTools.length === 0,
      missingTools: missingOnlineSandboxTools,
    },
    sandboxExecutor: compactObject({
      required: onlineSandboxRequired,
      ok: sandboxExecutorOk,
      executorKind: options.executorKind,
    }),
    persistentHome: compactObject({
      required: onlineSandboxRequired,
      ok: persistentHomeOk,
      executorKind: options.executorKind,
      homeRoot: options.executorHomeRoot,
    }),
    tenantAuth: {
      required: onlineSandboxRequired,
      ok: tenantAuth.ok,
      roles: tenantAuth.roles,
      missingRoles: tenantAuth.missingRoles,
      legacyTokens: tenantAuth.legacyTokens,
    },
    model: {
      required: platformRequired,
      ...model,
    },
    controlPlanePullRequest: {
      required: platformRequired,
      ok: Boolean(options.pullRequestReporter),
      provider: controlPlaneProviderName(options),
    },
    controlPlaneMerge: {
      required: platformRequired,
      ok: Boolean(options.mergeReporter),
      provider: controlPlaneProviderName(options),
    },
    controlPlaneIssueComments: {
      required: platformRequired,
      ok: Boolean(options.issueCommentReader),
      provider: controlPlaneProviderName(options),
    },
    controlPlaneIssueUrl: {
      required: platformRequired,
      ok: Boolean(options.issueBaseUrl),
      provider: controlPlaneProviderName(options),
    },
    controlPlaneSignedWebhooks: {
      required: platformRequired,
      ok: Boolean(options.giteaWebhookSecret),
      provider: controlPlaneProviderName(options),
    },
    controlPlaneDiscovery: controlPlaneDiscoveryReadiness,
    controlPlaneGitTransport,
    controlPlaneWorkspaceBranchLease: {
      required: platformRequired,
      ok: runWorkspaceIsolationMode === "run" && Boolean(options.workspacePullRequestReporter) && gitPrAllowed,
      provider: controlPlaneProviderName(options),
      runWorkspaceIsolation: runWorkspaceIsolationMode,
      branchDerivation: "run-suffixed",
      activeRunLeaseEvidence: true,
    },
    controlPlaneAgentIdentity: {
      required: platformRequired,
      ...controlPlaneAgentIdentity,
    },
    agentGitServiceProjectAgents: {
      required: platformRequired && controlPlaneProviderName(options) === "agent-git-service",
      ...agentGitServiceProjectAgents,
    },
    controlPlaneBackupRestoreMigration: {
      required: platformRequired,
      ok: true,
      provider: controlPlaneProviderName(options),
      format: "tenant-control-plane-backup-v1",
    },
    giteaPullRequest: {
      required: platformRequired,
      ok: Boolean(options.pullRequestReporter),
      compatibility: true,
    },
    brainSignalIngest: {
      required: platformRequired,
      ok: Boolean(options.brainSignalIngest),
    },
    coderExecutor: compactObject({
      required: platformRequired,
      ok: options.executorKind === "coder",
      executorKind: options.executorKind,
    }),
    runWorkspaceIsolation: {
      required: platformRequired,
      ok: runWorkspaceIsolationMode === "run",
      mode: runWorkspaceIsolationMode,
    },
    runCreateIdempotency: {
      required: onlineSandboxRequired,
      ok: true,
      ...runCreateIdempotency,
    },
  };
  const missing = Object.entries(checks)
    .filter(([, check]) => check.required && !check.ok && !isCompatibilityReadinessCheck(check))
    .map(([name]) => name);
  return {
    profile,
    ok: missing.length === 0,
    missing,
    goldenPath: {
      required: onlineSandboxRequired,
      ok: !onlineSandboxRequired || missing.length === 0,
      capabilities: [...ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES],
      missingCapabilities: onlineSandboxRequired && missing.length > 0 ? ["profile-readiness"] : [],
    },
    checks,
  };
}

async function harnessTenantServerStatus(
  tenant: string,
  workspaceRoot: string,
  options: HarnessServerOptions,
  allowedTools: string[],
  startedAt: string,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  queuedRuns: QueuedRun[],
  activeSessions: Map<string, ActiveWorkspaceSession>,
): Promise<TenantHarnessServerStatus> {
  const activeSessionDetails = await statusActiveWorkspaceSessionDetails(workspaceRoot, options, activeSessions, tenant);
  const activeRunDetails = await statusActiveRunDetails(workspaceRoot, options, activeRunSlots, tenant);
  const activeRunResourceDetails = activeRunResourceStatuses(options, activeRunDetails);
  const controlPlaneDiscovery = await controlPlaneDiscoveryStatus(options, tenant);
  return {
    tenant,
    server: {
      startedAt,
      uptimeMs: Math.max(0, Date.now() - Date.parse(startedAt)),
      controlPlane: harnessControlPlaneStatus(options, controlPlaneDiscovery),
      runWorkspaceIsolation: runWorkspaceIsolation(options),
      runCreateIdempotency: runCreateIdempotencyStatus(),
      concurrencyAdmission: await harnessConcurrencyAdmissionStatus(options, tenant),
    },
    readiness: await harnessProfileReadiness(workspaceRoot, options, allowedTools, tenant, controlPlaneDiscovery),
    visionLock: HARNESS_VISION_LOCK,
    limits: await harnessTenantServerLimits(options, tenant),
    policy: {
      allowedTools: await effectiveTenantAllowedTools(options, tenant),
    },
    resources: compactObject({
      activeRuns: activeRunDetails.length,
      activeRunDetails: activeRunResourceDetails.length ? activeRunResourceDetails : undefined,
      queuedRuns: queuedTenantRunCount(queuedRuns, tenant),
      activeWorkspaceSessions: activeSessionDetails.length,
      activeWorkspaceSessionDetails: activeSessionDetails,
      orphanedRunningRunDetails: (await orphanedRunningRunResourceStatuses(workspaceRoot, activeRunDetails, tenant))
        .map(publicOrphanedRunningRunStatus),
      queuedRunDetails: await queuedRunResourceStatuses(options, activeRunSlots, activeWorkspaces, queuedRuns, tenant),
    }),
  };
}

function harnessControlPlaneStatus(
  options: HarnessServerOptions,
  discovery?: ControlPlaneDiscoveryStatus,
): HarnessControlPlaneStatus {
  const provider = controlPlaneProviderName(options);
  const catalogEntry = controlPlaneProviderCatalogEntry(provider);
  return compactObject({
    provider,
    boundary: [...CONTROL_PLANE_PROVIDER_BOUNDARY],
    apiBasePath: catalogEntry?.apiBasePath,
    discoveryEndpoints: [...(catalogEntry?.discoveryEndpoints ?? [])],
    nativeCapabilities: [...(catalogEntry?.nativeCapabilities ?? [])],
    adoptionStages: (catalogEntry?.adoptionStages ?? []).map((stage) => ({ ...stage, evidence: [...stage.evidence] })),
    discovery,
  });
}

function controlPlaneProviderName(options: HarnessServerOptions): ControlPlaneProviderName {
  return options.controlPlaneProvider ?? "gitea-forgejo";
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

function controlPlaneProviderAdapter(options: HarnessServerOptions): ControlPlaneProvider {
  const provider = resolveControlPlaneProviderAdapter(controlPlaneProviderName(options));
  if (!provider) throw new Error(`unsupported control-plane provider: ${controlPlaneProviderName(options)}`);
  return provider;
}

function controlPlaneIssueUrl(options: HarnessServerOptions, issue: string): string | undefined {
  return options.issueBaseUrl ? controlPlaneProviderAdapter(options).issueUrl(options.issueBaseUrl, issue) : undefined;
}

async function controlPlaneDiscoveryStatus(options: HarnessServerOptions, tenantScope?: string): Promise<ControlPlaneDiscoveryStatus | undefined> {
  const provider = controlPlaneProviderName(options);
  if (provider !== "agent-git-service") return undefined;
  const catalogEntry = controlPlaneProviderCatalogEntry(provider);
  const baseUrl = options.controlPlaneBaseUrl?.trim();
  if (!catalogEntry || !baseUrl || catalogEntry.discoveryEndpoints.length === 0) return undefined;
  if (tenantScope) {
    const tenantToken = options.controlPlaneTenantTokens?.[tenantScope]?.trim();
    const adminToken = options.controlPlaneAdminToken?.trim();
    const token = tenantToken || adminToken;
    return controlPlaneDiscoveryStatusForToken(
      baseUrl,
      catalogEntry.apiBasePath,
      catalogEntry.discoveryEndpoints,
      token,
      token ? (tenantToken ? "tenant-scoped" : "admin") : "none",
      token && tenantToken ? tenantScope : undefined,
    );
  }
  const adminToken = options.controlPlaneAdminToken?.trim();
  if (adminToken) {
    return controlPlaneDiscoveryStatusForToken(
      baseUrl,
      catalogEntry.apiBasePath,
      catalogEntry.discoveryEndpoints,
      adminToken,
      "admin",
    );
  }

  const tenantNames = await controlPlaneDiscoveryTenantNames(options);
  if (tenantNames.length > 0) {
    return controlPlaneDiscoveryStatusForTenants(
      baseUrl,
      catalogEntry.apiBasePath,
      catalogEntry.discoveryEndpoints,
      tenantNames,
      options.controlPlaneTenantTokens ?? {},
    );
  }

  return controlPlaneDiscoveryStatusForToken(
    baseUrl,
    catalogEntry.apiBasePath,
    catalogEntry.discoveryEndpoints,
    undefined,
    "none",
  );
}

async function controlPlaneDiscoveryStatusForToken(
  baseUrl: string,
  apiBasePath: string,
  discoveryEndpoints: readonly string[],
  token: string | undefined,
  tokenMode: ControlPlaneDiscoveryTokenMode,
  tenant?: string,
): Promise<ControlPlaneDiscoveryStatus> {
  const endpoints = await Promise.all(discoveryEndpoints.map((endpoint) =>
    probeControlPlaneDiscoveryEndpoint(baseUrl, apiBasePath, endpoint, token, tenant),
  ));
  const missingEndpoints = endpoints.filter((endpoint) => !endpoint.ok).map((endpoint) => endpoint.endpoint);
  const okEndpointCount = endpoints.length - missingEndpoints.length;
  return {
    ok: missingEndpoints.length === 0,
    baseUrl: publicControlPlaneBaseUrl(baseUrl),
    endpointCount: endpoints.length,
    okEndpointCount,
    missingEndpoints,
    tokenMode,
    tenantCount: tenant ? 1 : 0,
    tenantOkCount: tenant && missingEndpoints.length === 0 ? 1 : 0,
    missingTenants: tenant && missingEndpoints.length > 0 ? [tenant] : [],
    endpoints,
  };
}

async function controlPlaneDiscoveryStatusForTenants(
  baseUrl: string,
  apiBasePath: string,
  discoveryEndpoints: readonly string[],
  tenants: string[],
  tokens: Record<string, string>,
): Promise<ControlPlaneDiscoveryStatus> {
  const tenantResults: ControlPlaneDiscoveryTenantStatus[] = [];
  const allEndpoints: ControlPlaneDiscoveryEndpointStatus[] = [];
  for (const tenant of tenants) {
    const token = tokens[tenant]?.trim();
    const endpoints = token
      ? await Promise.all(discoveryEndpoints.map((endpoint) =>
        probeControlPlaneDiscoveryEndpoint(baseUrl, apiBasePath, endpoint, token, tenant),
      ))
      : discoveryEndpoints.map((endpoint) => ({
        endpoint,
        tenant,
        url: publicUrl(controlPlaneDiscoveryEndpointUrl(baseUrl, apiBasePath, endpoint)),
        ok: false,
        error: "tenant_token_missing",
      }));
    const missingEndpoints = endpoints.filter((endpoint) => !endpoint.ok).map((endpoint) => endpoint.endpoint);
    tenantResults.push({
      tenant,
      ok: missingEndpoints.length === 0,
      endpointCount: endpoints.length,
      okEndpointCount: endpoints.length - missingEndpoints.length,
      missingEndpoints,
    });
    allEndpoints.push(...endpoints);
  }

  const missingTenants = tenantResults.filter((result) => !result.ok).map((result) => result.tenant);
  const missingEndpointNames = [...new Set(allEndpoints.filter((endpoint) => !endpoint.ok).map((endpoint) => endpoint.endpoint))].sort();
  const tenantOkCount = tenantResults.length - missingTenants.length;
  return {
    ok: missingTenants.length === 0,
    baseUrl: publicControlPlaneBaseUrl(baseUrl),
    endpointCount: allEndpoints.length,
    okEndpointCount: allEndpoints.filter((endpoint) => endpoint.ok).length,
    missingEndpoints: missingEndpointNames,
    tokenMode: "tenant-scoped",
    tenantCount: tenantResults.length,
    tenantOkCount,
    missingTenants,
    endpoints: allEndpoints,
    tenantResults,
  };
}

async function controlPlaneDiscoveryTenantNames(options: HarnessServerOptions): Promise<string[]> {
  const tenants = new Set(await tenantAuthTenantNames(options.workspaceRoot, options));
  for (const tenant of Object.keys(options.controlPlaneTenantTokens ?? {})) {
    if (isSafeTenantDirectoryName(tenant)) tenants.add(tenant);
  }
  return [...tenants].sort((a, b) => a.localeCompare(b));
}

function controlPlaneDiscoveryReadinessStatus(
  options: HarnessServerOptions,
  platformRequired: boolean,
  discovery?: ControlPlaneDiscoveryStatus,
): HarnessProfileReadiness["checks"]["controlPlaneDiscovery"] {
  const provider = controlPlaneProviderName(options);
  const required = platformRequired && provider === "agent-git-service";
  return {
    required,
    ok: required ? Boolean(discovery?.ok) : true,
    provider,
    baseUrlConfigured: Boolean(options.controlPlaneBaseUrl?.trim()),
    endpointCount: discovery?.endpointCount ?? 0,
    okEndpointCount: discovery?.okEndpointCount ?? 0,
    missingEndpoints: discovery?.missingEndpoints ?? [],
    tokenMode: discovery?.tokenMode ?? "none",
    tenantCount: discovery?.tenantCount ?? 0,
    tenantOkCount: discovery?.tenantOkCount ?? 0,
    missingTenants: discovery?.missingTenants ?? [],
  };
}

async function probeControlPlaneDiscoveryEndpoint(
  baseUrl: string,
  apiBasePath: string,
  endpoint: string,
  token?: string,
  tenant?: string,
): Promise<ControlPlaneDiscoveryEndpointStatus> {
  const url = controlPlaneDiscoveryEndpointUrl(baseUrl, apiBasePath, endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    return {
      endpoint,
      url: publicUrl(url),
      ok: response.ok,
      ...(tenant ? { tenant } : {}),
      status: response.status,
    };
  } catch {
    return {
      endpoint,
      url: publicUrl(url),
      ok: false,
      ...(tenant ? { tenant } : {}),
      error: "request_failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function controlPlaneDiscoveryEndpointUrl(baseUrl: string, apiBasePath: string, endpoint: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const rootPath = basePath.endsWith(apiBasePath)
    ? basePath.slice(0, -apiBasePath.length).replace(/\/+$/, "")
    : basePath;
  url.pathname = `${rootPath}${endpoint}`;
  url.search = "";
  url.hash = "";
  return url;
}

function publicControlPlaneBaseUrl(baseUrl: string): string {
  return publicUrl(new URL(baseUrl));
}

function publicUrl(url: URL): string {
  const copy = new URL(url.toString());
  copy.username = "";
  copy.password = "";
  return copy.toString();
}

function controlPlaneGitTransportReadiness(
  options: HarnessServerOptions,
  gitPrAllowed: boolean,
): HarnessProfileReadiness["checks"]["controlPlaneGitTransport"] {
  const evidence = controlPlaneGitTransportEvidence(options);
  return compactObject({
    required: options.profile === "platform-readiness",
    ok: Boolean(options.workspacePullRequestReporter) && gitPrAllowed && Boolean(evidence.sampleRemoteUrl),
    provider: controlPlaneProviderName(options),
    ...evidence,
  });
}

function controlPlaneGitTransportEvidence(options: HarnessServerOptions): { sampleRepo?: string; sampleRemoteUrl?: string } {
  if (!options.issueBaseUrl) return {};
  try {
    return {
      sampleRepo: CONTROL_PLANE_GIT_TRANSPORT_SAMPLE_REPO,
      sampleRemoteUrl: controlPlaneProviderAdapter(options).gitRemoteUrl(options.issueBaseUrl, CONTROL_PLANE_GIT_TRANSPORT_SAMPLE_REPO),
    };
  } catch {
    return { sampleRepo: CONTROL_PLANE_GIT_TRANSPORT_SAMPLE_REPO };
  }
}

function isCompatibilityReadinessCheck(check: { required: boolean; ok: boolean }): boolean {
  return "compatibility" in check && check.compatibility === true;
}

function harnessServerLimits(options: HarnessServerOptions): HarnessServerStatus["limits"] {
  return {
    jsonBodyBytes: HTTP_JSON_BODY_LIMIT_BYTES,
    workspaceFileReadBytes: WORKSPACE_FILE_READ_LIMIT_BYTES,
    workspaceFileWriteBytes: WORKSPACE_FILE_WRITE_LIMIT_BYTES,
    workspaceOutputBytes: WORKSPACE_OUTPUT_LIMIT_BYTES,
    workspaceSessionInputBytes: WORKSPACE_SESSION_INPUT_LIMIT_BYTES,
    workspaceCommandTimeoutMs: workspaceCommandTimeoutMs(options),
    maxWorkspaceSessions: workspaceSessionLimit(options),
    maxTenantWorkspaceSessions: tenantWorkspaceSessionLimit(options),
    maxTenantActiveRuns: tenantActiveRunLimit(options) ?? null,
    workspaceSessionIdleTimeoutMs: workspaceSessionIdleTimeoutMs(options),
    runLeaseTtlMs: runLeaseTtlMs(options),
    processSessionStopGraceMs: PROCESS_SESSION_STOP_GRACE_MS,
  };
}

async function harnessTenantServerLimits(options: HarnessServerOptions, tenant: string): Promise<HarnessServerStatus["limits"]> {
  return {
    ...harnessServerLimits(options),
    maxTenantWorkspaceSessions: await effectiveTenantWorkspaceSessionLimit(options, tenant),
    maxTenantActiveRuns: await effectiveTenantActiveRunLimit(options, tenant) ?? null,
  };
}

function publicOrphanedRunningRunStatus(
  status: OrphanedRunningRunResourceStatus,
): Omit<OrphanedRunningRunResourceStatus, "runDir"> {
  const { runDir: _runDir, ...publicStatus } = status;
  return publicStatus;
}

function requireSafeLocalExecutorOptions(options: HarnessServerOptions, allowedTools: string[]): void {
  if (options.createExecutor || options.allowUnsafeLocalExecutor) return;
  const reasons = [
    allowedTools.includes("shell.exec") ? "shell.exec is allowed" : undefined,
    hasTenantAuth(options) ? "tenant authentication is configured" : undefined,
  ].filter((reason): reason is string => Boolean(reason));
  if (!reasons.length) return;
  throw new Error(
    `local executor is not isolated for shared HTTP use (${reasons.join("; ")}). ` +
      "Configure createExecutor for Docker/Coder or set allowUnsafeLocalExecutor for single-user local development.",
  );
}

function hasTenantAuth(options: HarnessServerOptions): boolean {
  return Object.keys(options.tenantTokens ?? {}).length > 0 ||
    Object.values(options.tenantApiKeys ?? {}).some((keys) => keys.length > 0) ||
    hasPolicyTenantAuth(options.workspaceRoot);
}

function hasPolicyTenantAuth(workspaceRoot: string): boolean {
  let entries;
  try {
    entries = readdirSync(workspaceRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeTenantDirectoryName(entry.name)) continue;
    if ((readTenantPolicySync(workspaceRoot, entry.name)?.apiKeys?.length ?? 0) > 0) return true;
  }
  return false;
}

function readTenantPolicySync(workspaceRoot: string, tenant: string): TenantPolicy | undefined {
  try {
    return tenantPolicyFromUnknown(JSON.parse(readFileSync(tenantPolicyPath(workspaceRoot, tenant), "utf8")));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function controlPlaneAgentIdentityReadiness(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenantScope?: string,
): Promise<Omit<HarnessProfileReadiness["checks"]["controlPlaneAgentIdentity"], "required">> {
  const requiredTenants = tenantScope ? [tenantScope] : await tenantAuthTenantNames(workspaceRoot, options);
  const mode = options.controlPlaneAgentIdentity?.mode ?? "none";
  const configuredTenants = new Set(
    (options.controlPlaneAgentIdentity?.tenants ?? []).filter(isSafeTenantDirectoryName),
  );
  const missingTenantCount = mode === "tenant-scoped"
    ? requiredTenants.filter((tenant) => !configuredTenants.has(tenant)).length
    : requiredTenants.length;
  return {
    ok: mode === "tenant-scoped" && requiredTenants.length > 0 && missingTenantCount === 0,
    provider: controlPlaneProviderName(options),
    mode,
    tenantCount: requiredTenants.length,
    missingTenantCount,
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

async function modelReadiness(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenantScope?: string,
): Promise<Omit<HarnessProfileReadiness["checks"]["model"], "required">> {
  const tenantNames = tenantScope ? [tenantScope] : await tenantAuthTenantNames(workspaceRoot, options);
  const serverKeyConfigured = Boolean(options.modelApiKey);
  let serverCoveredTenantCount = 0;
  let scopedTenantCount = 0;
  let policyKeyScopedTenantCount = 0;
  let missingTenantCount = 0;
  const missingEnvNames: string[] = [];

  for (const tenant of tenantNames) {
    const coverage = await tenantModelKeyCoverage(workspaceRoot, options, tenant, serverKeyConfigured);
    if (coverage.serverCovered) serverCoveredTenantCount += 1;
    if (coverage.tenantScoped) scopedTenantCount += 1;
    if (coverage.policyKeyScoped) policyKeyScopedTenantCount += 1;
    if (!coverage.ok) {
      missingTenantCount += 1;
      missingEnvNames.push(...coverage.missingEnvNames);
    }
  }

  const scopedCoverageCount = scopedTenantCount + policyKeyScopedTenantCount;
  const keyConfigured = serverKeyConfigured || (tenantNames.length > 0 && missingTenantCount === 0 && scopedCoverageCount > 0);
  return compactObject({
    ok: Boolean(options.modelBaseUrl) && keyConfigured && missingTenantCount === 0,
    baseUrlConfigured: Boolean(options.modelBaseUrl),
    keyConfigured,
    keyMode: modelKeyMode(serverKeyConfigured, scopedTenantCount, policyKeyScopedTenantCount, serverCoveredTenantCount),
    tenantCount: tenantNames.length,
    missingTenantCount,
    missingEnvNames: missingEnvNames.length ? [...new Set(missingEnvNames)] : undefined,
  });
}

async function tenantModelKeyCoverage(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenant: string,
  serverKeyConfigured: boolean,
): Promise<{
  ok: boolean;
  serverCovered: boolean;
  tenantScoped: boolean;
  policyKeyScoped: boolean;
  missingEnvNames: string[];
}> {
  const policy = await readTenantPolicy(workspaceRoot, tenant);
  const fallbackEnvName = policy?.modelKeyEnv ?? options.tenantModelKeyEnvs?.[tenant];
  const explicitKeyEnvNames = [
    ...(options.tenantApiKeys?.[tenant] ?? []),
    ...(policy?.apiKeys ?? []),
  ].flatMap((key) => key.modelKeyEnv ? [key.modelKeyEnv] : []);
  const fallbackConsumerCount = [
    ...(options.tenantApiKeys?.[tenant] ?? []),
    ...(policy?.apiKeys ?? []),
  ].filter((key) => !key.modelKeyEnv).length + (options.tenantTokens?.[tenant] ? 1 : 0);
  const missingEnvNames = explicitKeyEnvNames.filter((envName) => !process.env[envName]);
  let serverCovered = false;
  let tenantScoped = false;
  const policyKeyScoped = explicitKeyEnvNames.length > 0 && missingEnvNames.length === 0;

  if (fallbackConsumerCount > 0) {
    if (fallbackEnvName) {
      if (process.env[fallbackEnvName]) {
        tenantScoped = true;
      } else {
        missingEnvNames.push(fallbackEnvName);
      }
    } else if (serverKeyConfigured) {
      serverCovered = true;
    } else {
      return { ok: false, serverCovered, tenantScoped, policyKeyScoped, missingEnvNames };
    }
  }

  return { ok: missingEnvNames.length === 0, serverCovered, tenantScoped, policyKeyScoped, missingEnvNames };
}

function modelKeyMode(
  serverKeyConfigured: boolean,
  scopedTenantCount: number,
  policyKeyScopedTenantCount: number,
  serverCoveredTenantCount: number,
): "none" | "server" | "tenant-scoped" | "policy-key-scoped" | "mixed" {
  const activeModes = [
    serverCoveredTenantCount > 0 || (serverKeyConfigured && scopedTenantCount === 0 && policyKeyScopedTenantCount === 0)
      ? "server"
      : undefined,
    scopedTenantCount > 0 ? "tenant-scoped" : undefined,
    policyKeyScopedTenantCount > 0 ? "policy-key-scoped" : undefined,
  ].filter(Boolean);
  if (activeModes.length > 1) return "mixed";
  if (activeModes.length === 1) return activeModes[0] as "server" | "tenant-scoped" | "policy-key-scoped";
  return "none";
}

async function tenantAuthTenantNames(workspaceRoot: string, options: HarnessServerOptions): Promise<string[]> {
  const tenants = new Set<string>();
  for (const tenant of Object.keys(options.tenantTokens ?? {})) {
    if (isSafeTenantDirectoryName(tenant)) tenants.add(tenant);
  }
  for (const [tenant, keys] of Object.entries(options.tenantApiKeys ?? {})) {
    if (keys.length > 0 && isSafeTenantDirectoryName(tenant)) tenants.add(tenant);
  }
  for (const tenant of await policyStatusAccessTenantNames(workspaceRoot)) {
    tenants.add(tenant);
  }
  return [...tenants].sort((a, b) => a.localeCompare(b));
}

async function policyStatusAccessTenantNames(workspaceRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const tenants: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeTenantDirectoryName(entry.name)) continue;
    if ((await readTenantPolicy(workspaceRoot, entry.name))?.apiKeys?.length) tenants.push(entry.name);
  }
  return tenants;
}

async function tenantAuthReadiness(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenantScope?: string,
): Promise<Omit<HarnessProfileReadiness["checks"]["tenantAuth"], "required">> {
  const roles: Record<TenantRole, boolean> = {
    admin: false,
    developer: false,
    viewer: false,
  };
  const configuredKeys = Object.entries(options.tenantApiKeys ?? {})
    .filter(([tenant]) => isSafeTenantDirectoryName(tenant) && (!tenantScope || tenant === tenantScope))
    .flatMap(([, keys]) => keys);
  const policyKeys = tenantScope
    ? (await readTenantPolicy(workspaceRoot, tenantScope))?.apiKeys ?? []
    : await policyStatusAccessKeys(workspaceRoot);
  for (const key of [...configuredKeys, ...policyKeys]) {
    roles[key.role] = true;
  }
  const missingRoles = ONLINE_SANDBOX_REQUIRED_TENANT_ROLES.filter((role) => !roles[role]);
  return {
    ok: missingRoles.length === 0,
    roles,
    missingRoles,
    legacyTokens: tenantScope
      ? Boolean(options.tenantTokens?.[tenantScope])
      : Object.keys(options.tenantTokens ?? {}).length > 0,
  };
}

export function createHarnessHttpServer(options: HarnessServerOptions): Server {
  const workspaceRoot = resolve(options.workspaceRoot);
  const allowedTools = options.allowedTools ?? ["file.read", "file.write", "git.diff", "git.commit", "verify.run"];
  requireSafeLocalExecutorOptions({ ...options, workspaceRoot }, allowedTools);
  const activeRuns = new Map<string, ActiveRun>();
  const activeRunSlots = new Map<string, ActiveRunSlot>();
  const activeWorkspaces = new Map<string, string>();
  const activeSessions = new Map<string, ActiveWorkspaceSession>();
  const runPresence: RunPresenceRegistry = new Map();
  const projectPresence: RunPresenceRegistry = new Map();
  const queuedRuns: QueuedRun[] = [];
  const serverOptions = { ...options, workspaceRoot, allowedTools };
  const startedAt = new Date().toISOString();
  const appendAuditEvent = createTenantAuditAppender(workspaceRoot);
  const operatorCockpitQueueBackend = createOperatorCockpitQueueBackend(serverOptions);
  const operatorCockpitExecutionQueue: OperatorCockpitExecutionQueueItem[] = [];
  let lastOperatorCockpitQueuedExecution: OperatorCockpitQueuedExecutionSummary | undefined;
  let operatorCockpitExecutionQueuePumpRunning = false;
  let closing = false;
  const scheduleOperatorCockpitExecutionQueue = () => {
    if (closing) return;
    if (operatorCockpitExecutionQueuePumpRunning) return;
    operatorCockpitExecutionQueuePumpRunning = true;
    const timeout = setTimeout(() => {
      if (closing) {
        operatorCockpitExecutionQueuePumpRunning = false;
        return;
      }
      void drainOperatorCockpitExecutionQueue(
        operatorCockpitQueueBackend,
        operatorCockpitExecutionQueue,
        serverOptions,
        appendAuditEvent,
        (summary) => {
          lastOperatorCockpitQueuedExecution = summary;
        },
      ).finally(() => {
        operatorCockpitExecutionQueuePumpRunning = false;
        if (operatorCockpitExecutionQueue.length > 0) scheduleOperatorCockpitExecutionQueue();
      });
    }, 50);
    timeout.unref?.();
  };
  void operatorCockpitQueueBackend.recover(tenantOperatorBundleDir(workspaceRoot, serverOptions)).then((items) => {
    operatorCockpitExecutionQueue.push(...items);
    if (operatorCockpitExecutionQueue.length > 0) scheduleOperatorCockpitExecutionQueue();
  }).catch(() => undefined);
  const queueRecovery: QueueRecoveryAudit = {
    status: "pending",
    scannedQueuedRuns: 0,
    recoveredQueuedRuns: 0,
    failedQueuedRuns: 0,
    errors: [],
    startedAt: new Date().toISOString(),
  };
  const staleRunCleanup: StaleRunCleanupAudit = serverOptions.autoAbandonStaleRuns
    ? {
        status: "pending",
        scannedRunningRuns: 0,
        abandonedStaleRuns: 0,
        skippedRunningRuns: 0,
        errors: [],
        startedAt: new Date().toISOString(),
      }
    : {
        status: "disabled",
        scannedRunningRuns: 0,
        abandonedStaleRuns: 0,
        skippedRunningRuns: 0,
        errors: [],
  };
  let drainingQueuedRuns = false;
  let queuedRunDrainRequested = false;
  const scheduleQueuedRuns = () => {
    if (closing) return;
    queuedRunDrainRequested = true;
    if (drainingQueuedRuns) return;
    drainingQueuedRuns = true;
    void (async () => {
      try {
        while (queuedRunDrainRequested) {
          queuedRunDrainRequested = false;
          await drainQueuedRuns(serverOptions, activeRuns, activeRunSlots, activeWorkspaces, queuedRuns, scheduleQueuedRuns, appendAuditEvent);
        }
      } finally {
        drainingQueuedRuns = false;
        if (queuedRunDrainRequested) scheduleQueuedRuns();
      }
    })();
  };
  const runStaleCleanup = async (): Promise<void> => {
    if (!serverOptions.autoAbandonStaleRuns) return;
    try {
      await cleanupStaleRunningRuns(workspaceRoot, serverOptions, staleRunCleanup, appendAuditEvent);
      staleRunCleanup.status = "completed";
      staleRunCleanup.endedAt = new Date().toISOString();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      staleRunCleanup.status = "error";
      staleRunCleanup.endedAt = new Date().toISOString();
      staleRunCleanup.message = message;
      staleRunCleanup.errors.push({ message });
    }
  };
  void runStaleCleanup().then(() => recoverQueuedRuns(workspaceRoot, serverOptions, queuedRuns, queueRecovery, appendAuditEvent)).then(() => {
    queueRecovery.status = "completed";
    queueRecovery.endedAt = new Date().toISOString();
    if (queuedRuns.length > 0) scheduleQueuedRuns();
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    queueRecovery.status = "error";
    queueRecovery.endedAt = new Date().toISOString();
    queueRecovery.message = message;
    queueRecovery.errors.push({ message });
  });

  const server = createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
        writeHtml(res, 200, DASHBOARD_HTML);
        return;
      }

      if (req.method === "GET" && url.pathname === "/workbench") {
        writeHtml(res, 200, WORKBENCH_HTML);
        return;
      }

      if (req.method === "GET" && url.pathname === "/operator-cockpit") {
        writeHtml(res, 200, OPERATOR_COCKPIT_HTML);
        return;
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        writeJson(res, 200, serverHealth(startedAt));
        return;
      }

      if (req.method === "GET" && url.pathname === "/readyz") {
        const readiness = serverReadiness(startedAt, queueRecovery, staleRunCleanup);
        writeJson(res, readiness.ready ? 200 : 503, readiness);
        return;
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        await requireServerStatusAccess(req, workspaceRoot, serverOptions, url);
        writeText(res, 200, await serverMetrics(
          workspaceRoot,
          serverOptions,
          startedAt,
          activeRunSlots,
          queuedRuns,
          activeSessions,
          queueRecovery,
          staleRunCleanup,
        ));
        return;
      }

      if (req.method === "GET" && url.pathname === "/status") {
        await requireServerStatusAccess(req, workspaceRoot, serverOptions, url);
        writeJson(res, 200, await harnessServerStatus(workspaceRoot, serverOptions, startedAt, allowedTools, activeRunSlots, activeWorkspaces, queuedRuns, activeSessions, queueRecovery, staleRunCleanup));
        return;
      }

      if (req.method === "POST" && url.pathname === "/runs") {
        await handleCreateRun(req, res, workspaceRoot, serverOptions, activeRuns, activeRunSlots, activeWorkspaces, queuedRuns, scheduleQueuedRuns, appendAuditEvent);
        return;
      }

      if (req.method === "POST") {
        const giteaWebhook = await handleGiteaIssueCommentWebhook(url, req, res, workspaceRoot, serverOptions, activeRuns, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, scheduleQueuedRuns, appendAuditEvent);
        if (giteaWebhook) return;

        const brainSignal = await handleCreateBrainSignal(url, req, res, serverOptions, appendAuditEvent);
        if (brainSignal) return;

        const policyApiKeyRevoke = await handleRevokeTenantPolicyApiKey(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (policyApiKeyRevoke) return;

        const policyApiKey = await handleCreateTenantPolicyApiKey(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (policyApiKey) return;

        const policySettings = await handleUpdateTenantPolicySettings(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (policySettings) return;

        const restoreDryRun = await handleTenantControlPlaneRestoreDryRun(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (restoreDryRun) return;

        const agentGitServiceProvisioningPlanApply = await handleApplyTenantAgentGitServiceProvisioningPlan(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (agentGitServiceProvisioningPlanApply) return;

        const operatorTargetInputTemplate = await handleWriteTenantOperatorTargetInputTemplate(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (operatorTargetInputTemplate) return;

        const operatorRealStagingTargetInput = await handleWriteTenantOperatorRealStagingTargetInput(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (operatorRealStagingTargetInput) return;

        const operatorRealStagingTargetsApply = await handleApplyTenantOperatorRealStagingTargets(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (operatorRealStagingTargetsApply) return;

        const operatorBundleRefresh = await handleRefreshTenantOperatorBundle(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (operatorBundleRefresh) return;

        const operatorGithubActionsTargetInput = await handleWriteTenantOperatorGithubActionsTargetInput(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (operatorGithubActionsTargetInput) return;

        const operatorCiArtifactImport = await handleImportTenantOperatorCiArtifact(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (operatorCiArtifactImport) return;

        const operatorAgsEvidenceImport = await handleImportTenantOperatorAgsEvidence(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (operatorAgsEvidenceImport) return;

        const operatorAgsEvidenceSync = await handleSyncTenantOperatorAgsEvidence(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (operatorAgsEvidenceSync) return;

        const operatorCockpitLoopExecuted = await handleExecuteTenantOperatorCockpitLoop(url, req, res, workspaceRoot, serverOptions, appendAuditEvent, operatorCockpitQueueBackend, operatorCockpitExecutionQueue, scheduleOperatorCockpitExecutionQueue);
        if (operatorCockpitLoopExecuted) return;

        const escalationDecision = await handleDecideTenantPolicyEscalation(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (escalationDecision) return;

        const escalation = await handleCreateTenantPolicyEscalation(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (escalation) return;

        const createdProject = await handleCreateProject(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (createdProject) return;

        const agentGitServiceProvisioned = await handleProvisionAgentGitServiceProjectAgent(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (agentGitServiceProvisioned) return;

        const createdVasCase = await handleCreateVasLiteCase(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (createdVasCase) return;

        const reviewedVasCase = await handleReviewVasLiteCase(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (reviewedVasCase) return;

        const claimedVasCase = await handleClaimVasLiteCase(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (claimedVasCase) return;

        const createdVasReviewRun = await handleCreateVasLiteCaseReviewRun(url, req, res, workspaceRoot, serverOptions, activeRuns, activeRunSlots, activeWorkspaces, queuedRuns, scheduleQueuedRuns, appendAuditEvent);
        if (createdVasReviewRun) return;

        const stoppedSession = await handleStopWorkspaceSession(url, req, res, serverOptions, activeSessions, appendAuditEvent);
        if (stoppedSession) return;

        const sessionInput = await handleWriteWorkspaceSessionInput(url, req, res, serverOptions, activeSessions, appendAuditEvent);
        if (sessionInput) return;

        const runSession = await handleCreateRunWorkspaceSession(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, activeSessions, appendAuditEvent);
        if (runSession) return;

        const projectSession = await handleCreateWorkspaceSession(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, activeSessions, appendAuditEvent);
        if (projectSession) return;

        const runFile = await handleWriteRunWorkspaceFile(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent, runPresence);
        if (runFile) return;

        const runFileMove = await handleMoveRunWorkspaceFile(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent, runPresence);
        if (runFileMove) return;

        const runCommit = await handleCreateRunWorkspaceCommit(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent);
        if (runCommit) return;

        const runPullRequest = await handleCreateRunWorkspacePullRequest(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent);
        if (runPullRequest) return;

        const runCommand = await handleRunScopedWorkspaceCommand(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent);
        if (runCommand) return;

        const handoffFollowup = await handleCreateRunHandoffFollowup(url, req, res, workspaceRoot, serverOptions, activeRuns, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, scheduleQueuedRuns, appendAuditEvent);
        if (handoffFollowup) return;

        const command = await handleRunWorkspaceCommand(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent);
        if (command) return;

        const file = await handleWriteWorkspaceFile(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent, projectPresence);
        if (file) return;

        const fileMove = await handleMoveWorkspaceFile(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent, projectPresence);
        if (fileMove) return;

        const projectCommit = await handleCreateWorkspaceCommit(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent);
        if (projectCommit) return;

        const projectPullRequest = await handleCreateWorkspacePullRequest(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent);
        if (projectPullRequest) return;

        const projectPresenceUpdated = await handleUpdateProjectPresence(url, req, res, workspaceRoot, serverOptions, projectPresence);
        if (projectPresenceUpdated) return;

        const abandoned = await handleAbandonRun(url, req, res, workspaceRoot, serverOptions, activeRuns, activeWorkspaces, appendAuditEvent);
        if (abandoned) return;

        const cancelled = await handleCancelRun(url, req, res, workspaceRoot, serverOptions, activeRuns, queuedRuns, scheduleQueuedRuns, appendAuditEvent);
        if (cancelled) return;

        const resumed = await handleResumeRun(url, req, res, workspaceRoot, serverOptions, activeRuns, activeRunSlots, activeWorkspaces, scheduleQueuedRuns, appendAuditEvent);
        if (resumed) return;

        const claimedReview = await handleClaimRunReview(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (claimedReview) return;

        const reviewed = await handleReviewRun(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (reviewed) return;

        const deployed = await handleDeploymentRun(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (deployed) return;

        const syncedIssueComments = await handleSyncRunIssueComments(url, req, res, workspaceRoot, serverOptions, activeRuns, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, scheduleQueuedRuns, appendAuditEvent);
        if (syncedIssueComments) return;

        const runComment = await handleCreateRunComment(url, req, res, workspaceRoot, serverOptions, activeRuns, appendAuditEvent);
        if (runComment) return;

        const presence = await handleUpdateRunPresence(url, req, res, workspaceRoot, serverOptions, runPresence);
        if (presence) return;
      }

      if (req.method === "PUT") {
        const projectRunPolicy = await handleUpdateProjectRunPolicy(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (projectRunPolicy) return;

        const projectContract = await handleUpdateProjectContract(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (projectContract) return;

        const projectDefaultSkills = await handleUpdateProjectDefaultSkills(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (projectDefaultSkills) return;

        const projectSourceDefaults = await handleUpdateProjectSourceDefaults(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (projectSourceDefaults) return;

        const policy = await handleUpdateTenantPolicy(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (policy) return;
      }

      if (req.method === "DELETE") {
        const runFile = await handleDeleteRunWorkspaceFile(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent, runPresence);
        if (runFile) return;

        const file = await handleDeleteWorkspaceFile(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent, projectPresence);
        if (file) return;
      }

      if (req.method === "GET") {
        const access = await handleReadTenantAccess(url, req, res, serverOptions);
        if (access) return;

        const tenantStatus = await handleReadTenantStatus(url, req, res, workspaceRoot, serverOptions, allowedTools, startedAt, activeRunSlots, activeWorkspaces, queuedRuns, activeSessions);
        if (tenantStatus) return;

        const operatorCockpitLoop = await handleReadTenantOperatorCockpitLoop(url, req, res, workspaceRoot, serverOptions);
        if (operatorCockpitLoop) return;

        const operatorCockpitExecutionStatus = await handleReadTenantOperatorCockpitExecutionStatus(url, req, res, workspaceRoot, serverOptions, operatorCockpitQueueBackend, operatorCockpitExecutionQueue, lastOperatorCockpitQueuedExecution);
        if (operatorCockpitExecutionStatus) return;

        const operatorApprovals = await handleReadTenantOperatorApprovals(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (operatorApprovals) return;

        const operatorHandoffPacket = await handleReadTenantOperatorHandoffPacket(url, req, res, workspaceRoot, serverOptions, appendAuditEvent);
        if (operatorHandoffPacket) return;

        const backup = await handleReadTenantControlPlaneBackup(url, req, res, workspaceRoot, serverOptions);
        if (backup) return;

        const cutoverReadiness = await handleReadTenantControlPlaneCutoverReadiness(url, req, res, workspaceRoot, serverOptions);
        if (cutoverReadiness) return;

        const agentGitServiceProvisioningPlan = await handleReadTenantAgentGitServiceProvisioningPlan(url, req, res, workspaceRoot, serverOptions);
        if (agentGitServiceProvisioningPlan) return;

        const escalations = await handleListTenantPolicyEscalations(url, req, res, workspaceRoot, serverOptions);
        if (escalations) return;

        const policy = await handleReadTenantPolicy(url, req, res, workspaceRoot, serverOptions);
        if (policy) return;

        const audit = await handleReadTenantAudit(url, req, res, workspaceRoot, serverOptions);
        if (audit) return;

        const brainSignals = await handleReadTenantBrainSignals(url, req, res, workspaceRoot, serverOptions);
        if (brainSignals) return;

        const runCommands = await handleListRunWorkspaceCommands(url, req, res, workspaceRoot, serverOptions);
        if (runCommands) return;

        const projectCommands = await handleListWorkspaceCommands(url, req, res, workspaceRoot, serverOptions);
        if (projectCommands) return;

        const agentGitServiceProvisioningReceipt = await handleReadAgentGitServiceProjectProvisioningReceipt(url, req, res, workspaceRoot, serverOptions);
        if (agentGitServiceProvisioningReceipt) return;

        const runSessions = await handleListRunWorkspaceSessions(url, req, res, workspaceRoot, serverOptions, activeSessions);
        if (runSessions) return;

        const projectSessions = await handleListWorkspaceSessions(url, req, res, workspaceRoot, serverOptions, activeSessions);
        if (projectSessions) return;

        const projectPresenceListed = await handleListProjectPresence(url, req, res, workspaceRoot, serverOptions, projectPresence);
        if (projectPresenceListed) return;

        const vasReviewQueue = await handleListVasLiteReviewQueue(url, req, res, workspaceRoot, serverOptions);
        if (vasReviewQueue) return;

        const vasLearnings = await handleListVasLiteLearnings(url, req, res, workspaceRoot, serverOptions);
        if (vasLearnings) return;

        const vasCaseReviewPackage = await handleReadVasLiteCaseReviewPackage(url, req, res, workspaceRoot, serverOptions);
        if (vasCaseReviewPackage) return;

        const vasCaseRuns = await handleListVasLiteCaseRuns(url, req, res, workspaceRoot, serverOptions);
        if (vasCaseRuns) return;

        const vasCaseArtifacts = await handleReadVasLiteCaseArtifacts(url, req, res, workspaceRoot, serverOptions);
        if (vasCaseArtifacts) return;

        const vasCases = await handleListVasLiteCases(url, req, res, workspaceRoot, serverOptions);
        if (vasCases) return;

        const sessionEvents = await handleReadWorkspaceSessionEvents(url, req, res, serverOptions, activeSessions);
        if (sessionEvents) return;

        const handoffFollowups = await handleListRunHandoffFollowups(url, req, res, workspaceRoot, serverOptions);
        if (handoffFollowups) return;

        const handoffPackage = await handleReadRunHandoffPackage(url, req, res, workspaceRoot, serverOptions, activeSessions);
        if (handoffPackage) return;

        const reviewSummary = await handleReadRunReviewSummary(url, req, res, workspaceRoot, serverOptions);
        if (reviewSummary) return;

        const runDiff = await handleReadRunWorkspaceDiff(url, req, res, workspaceRoot, serverOptions);
        if (runDiff) return;

        const projectDiff = await handleReadProjectWorkspaceDiff(url, req, res, workspaceRoot, serverOptions);
        if (projectDiff) return;

        const runWorkspace = await handleReadRunWorkspaceInfo(url, req, res, workspaceRoot, serverOptions);
        if (runWorkspace) return;

        const projectWorkspace = await handleReadProjectWorkspaceInfo(url, req, res, workspaceRoot, serverOptions);
        if (projectWorkspace) return;

        const runFile = await handleReadRunWorkspaceFile(url, req, res, workspaceRoot, serverOptions);
        if (runFile) return;

        const file = await handleReadWorkspaceFile(url, req, res, workspaceRoot, serverOptions);
        if (file) return;

        const project = await handleReadProject(url, req, res, workspaceRoot, serverOptions, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, projectPresence, runPresence);
        if (project) return;

        const projects = await handleListProjects(url, req, res, workspaceRoot, serverOptions, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, projectPresence, runPresence);
        if (projects) return;

        const modelUsageWarnings = await handleListTenantModelUsageWarnings(url, req, res, workspaceRoot, serverOptions, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, projectPresence, runPresence);
        if (modelUsageWarnings) return;

        const workspaceUsageWarnings = await handleListTenantWorkspaceUsageWarnings(url, req, res, workspaceRoot, serverOptions, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, projectPresence, runPresence);
        if (workspaceUsageWarnings) return;

        const listed = await handleListRuns(url, req, res, workspaceRoot, serverOptions, activeRunSlots, activeWorkspaces, queuedRuns);
        if (listed) return;

        const presence = await handleListRunPresence(url, req, res, workspaceRoot, serverOptions, runPresence);
        if (presence) return;

        const handled = await handleReadRun(url, req, res, workspaceRoot, serverOptions, activeRunSlots, activeWorkspaces, queuedRuns);
        if (handled) return;
      }

      writeJson(res, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(res, statusForError(error), { error: message });
    }
  });
  server.once("close", () => {
    closing = true;
    queuedRunDrainRequested = false;
    queuedRuns.splice(0);
    operatorCockpitExecutionQueue.splice(0);
    for (const active of activeRuns.values()) {
      active.controller.abort(new Error("harness server closed"));
    }
    for (const session of activeSessions.values()) {
      clearWorkspaceSessionIdleTimer(session);
      for (const cleanup of session.cleanup) cleanup();
      session.admissionHeartbeat();
      void session.admissionClaim.release().catch(() => undefined);
      void session.session.stop().catch(() => undefined);
      activeWorkspaces.delete(session.workspaceKey);
    }
    activeSessions.clear();
  });
  return server;
}

function serverHealth(startedAt: string): { ok: true; startedAt: string; uptimeMs: number } {
  return {
    ok: true,
    startedAt,
    uptimeMs: Math.max(0, Date.now() - Date.parse(startedAt)),
  };
}

function serverReadiness(
  startedAt: string,
  queueRecovery: QueueRecoveryAudit,
  staleRunCleanup: StaleRunCleanupAudit,
): { ready: boolean; startedAt: string; uptimeMs: number; checks: { queueRecovery: string; staleRunCleanup: string } } {
  const checks = {
    queueRecovery: queueRecovery.status,
    staleRunCleanup: staleRunCleanup.status,
  };
  return {
    ready: checks.queueRecovery === "completed" && (checks.staleRunCleanup === "completed" || checks.staleRunCleanup === "disabled"),
    startedAt,
    uptimeMs: Math.max(0, Date.now() - Date.parse(startedAt)),
    checks,
  };
}

async function serverMetrics(
  workspaceRoot: string,
  options: HarnessServerOptions,
  startedAt: string,
  activeRunSlots: Map<string, ActiveRunSlot>,
  queuedRuns: QueuedRun[],
  activeSessions: Map<string, ActiveWorkspaceSession>,
  queueRecovery: QueueRecoveryAudit,
  staleRunCleanup: StaleRunCleanupAudit,
): Promise<string> {
  const readiness = serverReadiness(startedAt, queueRecovery, staleRunCleanup);
  const activeRunDetails = await statusActiveRunDetails(workspaceRoot, options, activeRunSlots);
  const activeSessionDetails = await statusActiveWorkspaceSessionDetails(workspaceRoot, options, activeSessions);
  const orphanedRuns = await orphanedRunningRunResourceStatuses(workspaceRoot, activeRunDetails);
  const operationalBacklog = await metricsOperationalBacklog(workspaceRoot);
  return prometheusMetrics([
    ["loom_harness_ready", "Whether the harness server readiness probe is ready.", readiness.ready ? 1 : 0],
    ["loom_harness_active_runs", "Active harness runs across the shared workspace root.", activeRunDetails.length],
    ["loom_harness_queued_runs", "Queued harness runs held in this server queue.", queuedRuns.length],
    ["loom_harness_active_workspace_sessions", "Active workspace terminal sessions across the shared workspace root.", activeSessionDetails.length],
    ["loom_harness_orphaned_running_runs", "Persisted running runs without a live admission claim.", orphanedRuns.length],
    ["loom_harness_review_required_runs", "Runs currently waiting for human review.", operationalBacklog.reviewRequiredRuns],
    ["loom_harness_deployment_required_runs", "Runs currently waiting for deployment approval.", operationalBacklog.deploymentRequiredRuns],
    ["loom_harness_model_usage_warning_projects", "Tenant projects currently above model usage warning thresholds.", operationalBacklog.modelUsageWarningProjects],
    ["loom_harness_workspace_usage_warning_projects", "Tenant projects currently above workspace usage warning thresholds.", operationalBacklog.workspaceUsageWarningProjects],
    ["loom_harness_queue_recovery_completed", "Whether startup queued-run recovery completed.", queueRecovery.status === "completed" ? 1 : 0],
    ["loom_harness_stale_run_cleanup_ready", "Whether stale-run cleanup is completed or disabled.", staleRunCleanup.status === "completed" || staleRunCleanup.status === "disabled" ? 1 : 0],
  ]);
}

interface MetricsOperationalBacklog {
  reviewRequiredRuns: number;
  deploymentRequiredRuns: number;
  modelUsageWarningProjects: number;
  workspaceUsageWarningProjects: number;
}

async function metricsOperationalBacklog(workspaceRoot: string): Promise<MetricsOperationalBacklog> {
  const backlog: MetricsOperationalBacklog = {
    reviewRequiredRuns: 0,
    deploymentRequiredRuns: 0,
    modelUsageWarningProjects: 0,
    workspaceUsageWarningProjects: 0,
  };

  for (const tenant of await listWorkspaceTenantNames(workspaceRoot)) {
    const tenantRoot = join(workspaceRoot, tenant);
    const policyLimits = (await readTenantPolicy(workspaceRoot, tenant))?.limits;
    for (const project of await listTenantProjectNames(workspaceRoot, tenant)) {
      const summary = await readProjectSummary(tenantRoot, tenant, project, policyLimits);
      backlog.reviewRequiredRuns += summary.reviewRequiredRunCount ?? 0;
      backlog.deploymentRequiredRuns += summary.deploymentRequiredRunCount ?? 0;
      if ((summary.modelUsageWarnings?.length ?? 0) > 0) backlog.modelUsageWarningProjects += 1;
      if ((summary.workspaceByteWarnings?.length ?? 0) > 0) backlog.workspaceUsageWarningProjects += 1;
    }
  }

  return backlog;
}

function prometheusMetrics(metrics: Array<[string, string, number]>): string {
  const lines: string[] = [];
  for (const [name, help, value] of metrics) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  }
  return `${lines.join("\n")}\n`;
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
  const signals = filterTenantBrainSignalEvents(await readTenantAuditEvents(workspaceRoot, tenant), seqAfter(url), auditLimit(url), project, runId)
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
    const currentPolicy = await readTenantPolicy(workspaceRoot, tenant);
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
    await writeTenantPolicy(workspaceRoot, tenant, policy);
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
  writeJson(res, 200, sanitizeTenantPolicy(await readTenantPolicy(workspaceRoot, tenant)));
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

async function handleReadTenantOperatorCockpitLoop(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "operator" || segments[3] !== "cockpit-loop") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url, "admin");
  if (optionalQueryBoolean(url, "execute") === true) {
    throw badRequest("operator cockpit-loop execution is not exposed through GET.");
  }
  const dir = tenantOperatorBundleDir(workspaceRoot, options);
  const reportPath = join(dir, "reports", "operator-cockpit-loop.json");
  const result = await runPlatformOperatorCockpitLoop({
    dir,
    repoRoot: workspaceRoot,
    ...operatorCockpitCiTargetFromQuery(url),
    report: reportPath,
    requireExternalStaging: optionalQueryBoolean(url, "requireExternalStaging"),
    requireOperatorApprovals: optionalQueryBoolean(url, "requireOperatorApprovals"),
    requireAgentGitService: optionalQueryBoolean(url, "requireAgentGitService"),
  });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeJsonFileAtomic(reportPath, result);
  writeJson(res, 200, result);
  return true;
}

async function handleReadTenantOperatorCockpitExecutionStatus(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  queueBackend: OperatorCockpitQueueBackend,
  queue: OperatorCockpitExecutionQueueItem[],
  lastQueuedExecution: OperatorCockpitQueuedExecutionSummary | undefined,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "operator" || segments[3] !== "cockpit-execution-status") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url, "admin");
  const dir = tenantOperatorBundleDir(workspaceRoot, options);
  const status = readPlatformOperatorCockpitExecutionStatus({ dir });
  writeJson(res, 200, {
    ...status,
    tenant,
    coordination: operatorCockpitQueueBackendStatus(options, tenant),
    queue: await queueBackend.snapshot(queue, tenant, dir),
    ...(lastQueuedExecution?.tenant === tenant && lastQueuedExecution.dir === dir ? { lastQueuedExecution } : {}),
  });
  return true;
}

async function handleReadTenantOperatorApprovals(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "operator" || segments[3] !== "approvals") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const clientId = optionalClientId(optionalQueryString(url, "clientId"));
  const dir = tenantOperatorBundleDir(workspaceRoot, options);
  const reportPath = join(dir, "reports", "operator-approvals.json");
  const result = createPlatformOperatorApprovals({
    dir,
    report: reportPath,
  });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeJsonFileAtomic(reportPath, result);
  await appendAuditEvent(tenant, "operator_approvals_exported", compactObject({
    clientId,
    dir,
    reportPath,
    ok: result.ok,
    approvalCount: result.approvals.length,
    missingReports: result.missingReports,
    failedReports: result.failedReports,
    missingGateReports: result.missingGateReports,
    stageMismatchReports: result.stageMismatchReports,
    missingRequirementReports: result.missingRequirementReports,
    nextActionCount: result.nextActions.length,
  }), access);
  writeJson(res, 200, result);
  return true;
}

async function handleReadTenantOperatorHandoffPacket(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "operator" || segments[3] !== "handoff-packet") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const clientId = optionalClientId(optionalQueryString(url, "clientId"));
  const ciTarget = operatorCockpitCiTargetFromQuery(url);
  const dir = tenantOperatorBundleDir(workspaceRoot, options);
  const reportPath = join(dir, "reports", "operator-handoff-packet.json");
  const result = createPlatformOperatorHandoffPacket({
    dir,
    repoRoot: workspaceRoot,
    ...ciTarget,
    report: reportPath,
    requireExternalStaging: optionalQueryBoolean(url, "requireExternalStaging"),
    requireOperatorApprovals: optionalQueryBoolean(url, "requireOperatorApprovals"),
    requireAgentGitService: optionalQueryBoolean(url, "requireAgentGitService"),
  });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeJsonFileAtomic(reportPath, result);
  await appendAuditEvent(tenant, "operator_handoff_packet_exported", compactObject({
    clientId,
    dir,
    reportPath,
    ok: result.ok,
    phase: result.phase,
    missingInputCount: result.handoff.missingInputCount,
    commandRefCount: result.handoff.commandRefCount,
    blockingGroupIds: result.handoff.blockingGroupIds,
    ...(Object.keys(ciTarget).length ? { githubTarget: ciTarget } : {}),
  }), access);
  writeJson(res, 200, result);
  return true;
}

async function handleExecuteTenantOperatorCockpitLoop(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
  queueBackend: OperatorCockpitQueueBackend,
  queue: OperatorCockpitExecutionQueueItem[],
  scheduleQueue: () => void,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "operator" || segments[3] !== "cockpit-loop") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  await requireTenantTool(options, tenant, "shell.exec", "operator cockpit execution requires shell.exec to be allowed by the server.");
  const body = await readTenantOperatorCockpitLoopExecuteJson(req);
  if (optionalBoolean(body.execute, "execute") !== true) {
    throw badRequest("execute must be true.");
  }
  if (body.confirm !== "execute-current-cockpit-command") {
    throw badRequest("confirm must be execute-current-cockpit-command.");
  }
  const clientId = optionalClientId(body.clientId);
  const ciTarget = operatorCockpitCiTargetFromBody(body);
  const maxSteps = optionalOperatorCockpitMaxSteps(body.maxSteps);
  const dir = tenantOperatorBundleDir(workspaceRoot, options);
  const reportDir = join(dir, "reports");
  const executeReportPath = join(reportDir, "operator-cockpit-runner-execute.json");
  const loopReportPath = join(reportDir, "operator-cockpit-loop.json");
  const nextPath = join(reportDir, "operator-cockpit-next.json");
  const queueRequested = optionalBoolean(body.queue, "queue") === true;
  const executionStatus = readPlatformOperatorCockpitExecutionStatus({ dir });
  if (queueRequested && executionStatus.state === "locked") {
    const item: OperatorCockpitExecutionQueueItem = {
      queueId: randomUUID(),
      tenant,
      dir,
      enqueuedAt: new Date().toISOString(),
      status: "queued",
      ...(clientId ? { clientId } : {}),
      access,
      ciTarget,
      maxSteps,
      requireExternalStaging: optionalBoolean(body.requireExternalStaging, "requireExternalStaging"),
      requireOperatorApprovals: optionalBoolean(body.requireOperatorApprovals, "requireOperatorApprovals"),
      requireAgentGitService: optionalBoolean(body.requireAgentGitService, "requireAgentGitService"),
    };
    await queueBackend.persist(item);
    queue.push(item);
    scheduleQueue();
    const result = {
      schemaVersion: "platform-operator-cockpit-loop-queue/v1",
      ok: false,
      tokenFree: true,
      tenant,
      dir,
      queueId: item.queueId,
      status: item.status,
      queuePosition: queueBackend.position(queue, item),
      enqueuedAt: item.enqueuedAt,
      executionStatus,
    };
    writeJson(res, 202, result);
    return true;
  }
  if (maxSteps > 1) {
    const refreshed = await runPlatformOperatorCockpitLoop({
      dir,
      repoRoot: workspaceRoot,
      ...ciTarget,
      execute: true,
      maxSteps,
      report: loopReportPath,
      requireExternalStaging: optionalBoolean(body.requireExternalStaging, "requireExternalStaging"),
      requireOperatorApprovals: optionalBoolean(body.requireOperatorApprovals, "requireOperatorApprovals"),
      requireAgentGitService: optionalBoolean(body.requireAgentGitService, "requireAgentGitService"),
    });
    await mkdir(reportDir, { recursive: true });
    await writeJsonFileAtomic(loopReportPath, refreshed);
    const execution = operatorCockpitLoopLastExecution(refreshed);
    if (execution) await writeJsonFileAtomic(executeReportPath, execution);
    const executedCount = refreshed.iterations.filter((iteration) => iteration.runner.mode === "executed").length;
    const result = {
      schemaVersion: "platform-operator-cockpit-loop-execute/v1",
      ok: refreshed.ok,
      tokenFree: true,
      tenant,
      dir,
      executeReportPath,
      loopReportPath,
      ...(execution ? { execution } : {}),
      refreshed,
    };
    const auditData = compactObject({
      clientId,
      dir,
      maxSteps: refreshed.maxSteps,
      iterationCount: refreshed.iterations.length,
      executedCount,
      phase: execution?.phase,
      state: execution?.state,
      mode: execution?.mode,
      commandLabel: execution?.commandRef?.label,
      exitCode: execution?.execution?.exitCode,
      ok: refreshed.ok,
      executeReportPath,
      loopReportPath,
      ...(Object.keys(ciTarget).length ? { githubTarget: ciTarget } : {}),
    });
    if (execution?.mode === "blocked") {
      await appendAuditEvent(tenant, "operator_cockpit_loop_execution_blocked", compactObject({
        ...auditData,
        executionLease: execution.executionLease,
      }), access);
      writeJson(res, 409, result);
      return true;
    }
    await appendAuditEvent(tenant, "operator_cockpit_loop_executed", auditData, access);
    writeJson(res, 200, result);
    return true;
  }
  const existingStepId = await tenantOperatorCockpitNextCurrentStepId(nextPath);
  const refreshedNext = createPlatformOperatorCockpitNext({
    dir,
    repoRoot: workspaceRoot,
    ...ciTarget,
    requireExternalStaging: optionalBoolean(body.requireExternalStaging, "requireExternalStaging"),
    requireOperatorApprovals: optionalBoolean(body.requireOperatorApprovals, "requireOperatorApprovals"),
    requireAgentGitService: optionalBoolean(body.requireAgentGitService, "requireAgentGitService"),
  });
  if (
    refreshedNext.state === "ready-to-run" &&
    refreshedNext.commandRef?.commandArgs.length &&
    (existingStepId === undefined || existingStepId === refreshedNext.currentStepId)
  ) {
    await mkdir(reportDir, { recursive: true });
    await writeJsonFileAtomic(nextPath, refreshedNext);
  }
  const execution = await runPlatformOperatorCockpitRunner({
    dir,
    next: nextPath,
    execute: true,
    report: executeReportPath,
  });
  await mkdir(reportDir, { recursive: true });
  await writeJsonFileAtomic(executeReportPath, execution);
  if (execution.mode === "blocked") {
    const result = {
      schemaVersion: "platform-operator-cockpit-loop-execute/v1",
      ok: false,
      tokenFree: true,
      tenant,
      dir,
      executeReportPath,
      execution,
    };
    await appendAuditEvent(tenant, "operator_cockpit_loop_execution_blocked", compactObject({
      clientId,
      dir,
      phase: execution.phase,
      state: execution.state,
      mode: execution.mode,
      commandLabel: execution.commandRef?.label,
      executionLease: execution.executionLease,
      executeReportPath,
      ...(Object.keys(ciTarget).length ? { githubTarget: ciTarget } : {}),
    }), access);
    writeJson(res, 409, result);
    return true;
  }
  const refreshed = await runPlatformOperatorCockpitLoop({
    dir,
    repoRoot: workspaceRoot,
    ...ciTarget,
    report: loopReportPath,
    requireExternalStaging: optionalBoolean(body.requireExternalStaging, "requireExternalStaging"),
    requireOperatorApprovals: optionalBoolean(body.requireOperatorApprovals, "requireOperatorApprovals"),
    requireAgentGitService: optionalBoolean(body.requireAgentGitService, "requireAgentGitService"),
  });
  await writeJsonFileAtomic(loopReportPath, refreshed);
  const result = {
    schemaVersion: "platform-operator-cockpit-loop-execute/v1",
    ok: execution.ok,
    tokenFree: true,
    tenant,
    dir,
    executeReportPath,
    loopReportPath,
    execution,
    refreshed,
  };
  await appendAuditEvent(tenant, "operator_cockpit_loop_executed", compactObject({
    clientId,
    dir,
    phase: execution.phase,
    state: execution.state,
    mode: execution.mode,
    commandLabel: execution.commandRef?.label,
    exitCode: execution.execution?.exitCode,
    ok: execution.ok,
    executeReportPath,
    loopReportPath,
    ...(Object.keys(ciTarget).length ? { githubTarget: ciTarget } : {}),
  }), access);
  writeJson(res, 200, result);
  return true;
}

async function handleWriteTenantOperatorTargetInputTemplate(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "operator" || segments[3] !== "target-input-template") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const body = await readTenantOperatorTargetInputTemplateJson(req);
  const clientId = optionalClientId(body.clientId);
  const ciTarget = operatorCockpitCiTargetFromBody(body);
  const dir = tenantOperatorBundleDir(workspaceRoot, options);
  const reportPath = join(dir, "reports", "operator-target-input-template.json");
  const result = writePlatformOperatorTargetInputTemplate({
    dir,
    repoRoot: workspaceRoot,
    ...ciTarget,
    report: reportPath,
    overwrite: optionalBoolean(body.overwrite, "overwrite"),
    requireExternalStaging: optionalBoolean(body.requireExternalStaging, "requireExternalStaging"),
    requireOperatorApprovals: optionalBoolean(body.requireOperatorApprovals, "requireOperatorApprovals"),
    requireAgentGitService: optionalBoolean(body.requireAgentGitService, "requireAgentGitService"),
  });
  const responseBody = {
    ...result,
    tenant,
    handoffPacketPath: result.reportPaths.operatorHandoffPacket,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeJsonFileAtomic(reportPath, responseBody);
  await appendAuditEvent(tenant, "operator_target_input_template_written", compactObject({
    clientId,
    dir,
    reportPath,
    inputPath: result.inputPath,
    inputSha256: result.inputSha256,
    byteLength: result.byteLength,
    fieldNames: result.fieldNames,
    written: result.written,
    existed: result.existed,
    overwritten: result.overwritten,
    inputFileOk: result.inputFile?.ok,
    inputFileMissing: result.inputFile?.missing,
    handoffPacketPath: result.reportPaths.operatorHandoffPacket,
    reportPaths: result.reportPaths,
    cockpitState: result.cockpit?.state,
    cockpitPhase: result.cockpit?.phase,
    ...(Object.keys(ciTarget).length ? { githubTarget: ciTarget } : {}),
  }), access);
  writeJson(res, result.ok ? (result.written ? 201 : 200) : 400, responseBody);
  return true;
}

async function handleWriteTenantOperatorRealStagingTargetInput(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "operator" || segments[3] !== "real-staging-target-input") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const body = await readTenantOperatorRealStagingTargetInputJson(req);
  const clientId = optionalClientId(body.clientId);
  const ciTarget = operatorCockpitCiTargetFromBody(body);
  const dir = tenantOperatorBundleDir(workspaceRoot, options);
  const reportDir = join(dir, "reports");
  const inputPath = await tenantOperatorRealStagingTargetInputPath(dir);
  const reportPaths = {
    operatorStatus: join(reportDir, "operator-status.json"),
    operatorCockpitPlan: join(reportDir, "operator-cockpit-plan.json"),
    operatorCockpitNext: join(reportDir, "operator-cockpit-next.json"),
    operatorHandoffPacket: join(reportDir, "operator-handoff-packet.json"),
  };
  const requireExternalStaging = optionalBoolean(body.requireExternalStaging, "requireExternalStaging");
  const requireOperatorApprovals = optionalBoolean(body.requireOperatorApprovals, "requireOperatorApprovals");
  const requireAgentGitService = optionalBoolean(body.requireAgentGitService, "requireAgentGitService");
  const expectedInputSha256 = optionalSha256Hex(body.expectedInputSha256, "expectedInputSha256");
  const currentInputSha256 = await optionalFileSha256(inputPath);
  if (expectedInputSha256 && currentInputSha256 !== expectedInputSha256) {
    writeJson(res, 409, {
      schemaVersion: "platform-operator-input-write-conflict/v1",
      ok: false,
      tokenFree: true,
      tenant,
      dir,
      inputPath,
      expectedInputSha256,
      currentInputExists: currentInputSha256 !== undefined,
      ...(currentInputSha256 ? { currentInputSha256 } : {}),
      missing: ["inputSha256.mismatch"],
      nextActions: ["Refresh the operator cockpit, reapply your edits to the latest input file, then submit again with the current inputSha256."],
    });
    return true;
  }
  const input = tenantOperatorRealStagingTargetInputFromBody(body);
  const inputText = `${JSON.stringify(input, null, 2)}\n`;
  const inputSha256 = createHash("sha256").update(inputText, "utf8").digest("hex");
  const byteLength = Buffer.byteLength(inputText, "utf8");
  const fieldNames = Object.keys(input.targets);
  await mkdir(dirname(inputPath), { recursive: true });
  await writeJsonFileAtomic(inputPath, input);
  const operatorStatus = createPlatformOperatorStatus({
    dir,
    repoRoot: workspaceRoot,
    ...ciTarget,
    report: reportPaths.operatorStatus,
    requireExternalStaging,
    requireOperatorApprovals,
    requireAgentGitService,
  });
  const handoffPacket = createPlatformOperatorHandoffPacketFromStatus(operatorStatus, reportPaths.operatorHandoffPacket);
  await mkdir(reportDir, { recursive: true });
  await writeJsonFileAtomic(reportPaths.operatorStatus, operatorStatus);
  await writeJsonFileAtomic(reportPaths.operatorCockpitPlan, operatorStatus.cockpitPlan);
  await writeJsonFileAtomic(reportPaths.operatorCockpitNext, handoffPacket.cockpit);
  await writeJsonFileAtomic(reportPaths.operatorHandoffPacket, handoffPacket);
  const inputFile = handoffPacket.blockingGroups
    .find((group) => group.id === "external-targets")
    ?.targetInputRefs
    ?.find((ref) => ref.inputTemplatePath === inputPath)
    ?.inputFile;
  const result = {
    schemaVersion: "platform-operator-target-input-write/v1",
    ok: true,
    tokenFree: true,
    tenant,
    dir,
    inputPath,
    inputSha256,
    byteLength,
    fieldNames,
    ...(inputFile ? { inputFile } : {}),
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    cockpit: handoffPacket.cockpit,
  };
  await appendAuditEvent(tenant, "operator_real_staging_target_input_written", compactObject({
    clientId,
    dir,
    inputPath,
    inputSha256,
    byteLength,
    fieldNames,
    inputFileOk: inputFile?.ok,
    inputFileMissing: inputFile?.missing,
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    handoffOk: handoffPacket.ok,
    handoffPhase: handoffPacket.phase,
    ...(Object.keys(ciTarget).length ? { githubTarget: ciTarget } : {}),
  }), access);
  writeJson(res, 201, result);
  return true;
}

async function handleWriteTenantOperatorGithubActionsTargetInput(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "operator" || segments[3] !== "github-actions-target-input") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const body = await readTenantOperatorGithubActionsTargetInputJson(req);
  const clientId = optionalClientId(body.clientId);
  const dir = tenantOperatorBundleDir(workspaceRoot, options);
  const reportDir = join(dir, "reports");
  const inputPath = await tenantOperatorGithubActionsTargetInputPath(dir);
  const reportPaths = {
    operatorStatus: join(reportDir, "operator-status.json"),
    operatorCockpitPlan: join(reportDir, "operator-cockpit-plan.json"),
    operatorCockpitNext: join(reportDir, "operator-cockpit-next.json"),
    operatorHandoffPacket: join(reportDir, "operator-handoff-packet.json"),
  };
  const requireExternalStaging = optionalBoolean(body.requireExternalStaging, "requireExternalStaging");
  const requireOperatorApprovals = optionalBoolean(body.requireOperatorApprovals, "requireOperatorApprovals");
  const requireAgentGitService = optionalBoolean(body.requireAgentGitService, "requireAgentGitService");
  const expectedInputSha256 = optionalSha256Hex(body.expectedInputSha256, "expectedInputSha256");
  const currentInputSha256 = await optionalFileSha256(inputPath);
  if (expectedInputSha256 && currentInputSha256 !== expectedInputSha256) {
    writeJson(res, 409, {
      schemaVersion: "platform-operator-input-write-conflict/v1",
      ok: false,
      tokenFree: true,
      tenant,
      dir,
      inputPath,
      expectedInputSha256,
      currentInputExists: currentInputSha256 !== undefined,
      ...(currentInputSha256 ? { currentInputSha256 } : {}),
      missing: ["inputSha256.mismatch"],
      nextActions: ["Refresh the operator cockpit, reapply your edits to the latest input file, then submit again with the current inputSha256."],
    });
    return true;
  }
  const input = tenantOperatorGithubActionsTargetInputFromBody(body);
  const inputText = `${JSON.stringify(input, null, 2)}\n`;
  const inputSha256 = createHash("sha256").update(inputText, "utf8").digest("hex");
  const byteLength = Buffer.byteLength(inputText, "utf8");
  const fieldNames = ["repo", "ref"];
  await mkdir(dirname(inputPath), { recursive: true });
  await writeJsonFileAtomic(inputPath, input);
  const operatorStatus = createPlatformOperatorStatus({
    dir,
    repoRoot: workspaceRoot,
    repo: input.repo,
    ref: input.ref,
    report: reportPaths.operatorStatus,
    requireExternalStaging,
    requireOperatorApprovals,
    requireAgentGitService,
  });
  const handoffPacket = createPlatformOperatorHandoffPacketFromStatus(operatorStatus, reportPaths.operatorHandoffPacket);
  await mkdir(reportDir, { recursive: true });
  await writeJsonFileAtomic(reportPaths.operatorStatus, operatorStatus);
  await writeJsonFileAtomic(reportPaths.operatorCockpitPlan, operatorStatus.cockpitPlan);
  await writeJsonFileAtomic(reportPaths.operatorCockpitNext, handoffPacket.cockpit);
  await writeJsonFileAtomic(reportPaths.operatorHandoffPacket, handoffPacket);
  const result = {
    schemaVersion: "platform-operator-github-actions-target-input-write/v1",
    ok: true,
    tokenFree: true,
    tenant,
    dir,
    inputPath,
    inputSha256,
    byteLength,
    fieldNames,
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    githubTarget: {
      repo: input.repo,
      ref: input.ref,
    },
    cockpit: handoffPacket.cockpit,
  };
  await appendAuditEvent(tenant, "operator_github_actions_target_input_written", compactObject({
    clientId,
    dir,
    inputPath,
    inputSha256,
    byteLength,
    fieldNames,
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    handoffOk: handoffPacket.ok,
    handoffPhase: handoffPacket.phase,
    githubTarget: result.githubTarget,
  }), access);
  writeJson(res, 201, result);
  return true;
}

async function handleApplyTenantOperatorRealStagingTargets(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "operator" || segments[3] !== "real-staging-targets-apply") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const body = await readTenantOperatorRealStagingTargetsApplyJson(req);
  const clientId = optionalClientId(body.clientId);
  const ciTarget = operatorCockpitCiTargetFromBody(body);
  const dir = tenantOperatorBundleDir(workspaceRoot, options);
  const reportDir = join(dir, "reports");
  const inputPath = await tenantOperatorRealStagingTargetInputPath(dir);
  const applyReportPath = join(reportDir, "staging-targets-apply.json");
  const reportPaths = {
    operatorStatus: join(reportDir, "operator-status.json"),
    operatorCockpitPlan: join(reportDir, "operator-cockpit-plan.json"),
    operatorCockpitNext: join(reportDir, "operator-cockpit-next.json"),
    operatorHandoffPacket: join(reportDir, "operator-handoff-packet.json"),
  };
  const requireExternalStaging = optionalBoolean(body.requireExternalStaging, "requireExternalStaging");
  const requireOperatorApprovals = optionalBoolean(body.requireOperatorApprovals, "requireOperatorApprovals");
  const requireAgentGitService = optionalBoolean(body.requireAgentGitService, "requireAgentGitService");
  const autoRefreshBundle = optionalBoolean(body.autoRefreshBundle, "autoRefreshBundle") === true;
  const expectedInputSha256 = optionalSha256Hex(body.expectedInputSha256, "expectedInputSha256");
  const currentInputSha256 = await optionalFileSha256(inputPath);
  if (expectedInputSha256 && currentInputSha256 !== expectedInputSha256) {
    writeJson(res, 409, {
      schemaVersion: "platform-operator-input-write-conflict/v1",
      ok: false,
      tokenFree: true,
      tenant,
      dir,
      inputPath,
      expectedInputSha256,
      currentInputExists: currentInputSha256 !== undefined,
      ...(currentInputSha256 ? { currentInputSha256 } : {}),
      missing: ["inputSha256.mismatch"],
      nextActions: ["Refresh the operator cockpit, reapply your edits to the latest input file, then submit again with the current inputSha256."],
    });
    return true;
  }
  const stagingTargetsApply = await writePlatformStagingTargetsApply({
    dir,
    input: inputPath,
    report: applyReportPath,
  });
  let bundleRefreshData: Awaited<ReturnType<typeof refreshOperatorBundleFromRealPlan>> | undefined;
  let applyReportSha256: string | undefined;
  if (autoRefreshBundle && stagingTargetsApply.ok) {
    applyReportSha256 = await optionalFileSha256(applyReportPath);
    const applyReport = await readOperatorBundleRefreshApplyReport(applyReportPath, dir);
    bundleRefreshData = await refreshOperatorBundleFromRealPlan({
      dir,
      reportDir,
      applyReportPath,
      applyReportSha256,
      applyReport,
    });
  }
  const operatorStatus = createPlatformOperatorStatus({
    dir,
    repoRoot: workspaceRoot,
    ...ciTarget,
    report: reportPaths.operatorStatus,
    requireExternalStaging,
    requireOperatorApprovals,
    requireAgentGitService,
  });
  const handoffPacket = createPlatformOperatorHandoffPacketFromStatus(operatorStatus, reportPaths.operatorHandoffPacket);
  await mkdir(reportDir, { recursive: true });
  await writeJsonFileAtomic(reportPaths.operatorStatus, operatorStatus);
  await writeJsonFileAtomic(reportPaths.operatorCockpitPlan, operatorStatus.cockpitPlan);
  await writeJsonFileAtomic(reportPaths.operatorCockpitNext, handoffPacket.cockpit);
  await writeJsonFileAtomic(reportPaths.operatorHandoffPacket, handoffPacket);
  const bundleRefresh = bundleRefreshData
    ? {
      schemaVersion: "platform-operator-bundle-refresh/v1",
      ok: true,
      tokenFree: true,
      tenant,
      dir,
      applyReportPath,
      ...(applyReportSha256 ? { applyReportSha256 } : {}),
      ...bundleRefreshData,
      handoffPacketPath: reportPaths.operatorHandoffPacket,
      reportPaths,
      cockpit: handoffPacket.cockpit,
    }
    : undefined;
  const result = {
    schemaVersion: "platform-operator-real-staging-targets-apply/v1",
    ok: stagingTargetsApply.ok,
    tokenFree: true,
    tenant,
    dir,
    inputPath,
    ...(currentInputSha256 ? { inputSha256: currentInputSha256 } : {}),
    applyReportPath,
    realPlanPath: stagingTargetsApply.realPlanPath,
    realTargetsReportPath: stagingTargetsApply.realTargetsReportPath,
    stagingTargetsApply,
    ...(bundleRefresh ? { bundleRefresh } : {}),
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    cockpit: handoffPacket.cockpit,
  };
  await appendAuditEvent(tenant, "operator_real_staging_targets_applied", compactObject({
    clientId,
    dir,
    inputPath,
    inputSha256: currentInputSha256,
    applyReportPath,
    applyOk: stagingTargetsApply.ok,
    realPlanPath: stagingTargetsApply.realPlanPath,
    realPlanSha256: stagingTargetsApply.realPlanSha256,
    realTargetsReportPath: stagingTargetsApply.realTargetsReportPath,
    realTargetsReportSha256: stagingTargetsApply.realTargetsReportSha256,
    missing: stagingTargetsApply.missing,
    autoRefreshBundle,
    bundleRefreshOk: bundleRefresh?.ok,
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    handoffOk: handoffPacket.ok,
    handoffPhase: handoffPacket.phase,
    ...(Object.keys(ciTarget).length ? { githubTarget: ciTarget } : {}),
  }), access);
  if (bundleRefresh) {
    await appendAuditEvent(tenant, "operator_bundle_refreshed", compactObject({
      clientId,
      dir,
      applyReportPath,
      applyReportSha256,
      sourceRealPlanPath: bundleRefresh.sourceRealPlanPath,
      sourceRealPlanSha256: bundleRefresh.sourceRealPlanSha256,
      planPath: bundleRefresh.planPath,
      planSha256: bundleRefresh.planSha256,
      manifestPath: bundleRefresh.manifestPath,
      manifestSha256: bundleRefresh.manifestSha256,
      updatedFiles: bundleRefresh.updatedFiles,
      handoffPacketPath: reportPaths.operatorHandoffPacket,
      reportPaths,
      handoffOk: handoffPacket.ok,
      handoffPhase: handoffPacket.phase,
      ...(Object.keys(ciTarget).length ? { githubTarget: ciTarget } : {}),
    }), access);
  }
  writeJson(res, 200, result);
  return true;
}

async function handleImportTenantOperatorCiArtifact(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "operator" || segments[3] !== "ci-artifact-import") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const body = await readTenantOperatorCiArtifactImportJson(req);
  const clientId = optionalClientId(body.clientId);
  const ciTarget = operatorCockpitCiTargetFromBody(body);
  const dir = tenantOperatorBundleDir(workspaceRoot, options);
  const reportDir = join(dir, "reports");
  const importReportPath = join(reportDir, "ci-artifact-import.json");
  const reportPaths = {
    operatorStatus: join(reportDir, "operator-status.json"),
    operatorCockpitPlan: join(reportDir, "operator-cockpit-plan.json"),
    operatorCockpitNext: join(reportDir, "operator-cockpit-next.json"),
    operatorHandoffPacket: join(reportDir, "operator-handoff-packet.json"),
  };
  const requireExternalStaging = optionalBoolean(body.requireExternalStaging, "requireExternalStaging");
  const requireOperatorApprovals = optionalBoolean(body.requireOperatorApprovals, "requireOperatorApprovals");
  const requireAgentGitService = optionalBoolean(body.requireAgentGitService, "requireAgentGitService");
  const artifactDir = tenantOperatorCiArtifactImportDir(dir, body.artifactDir);
  const phase = optionalOperatorCiArtifactImportPhase(body.phase) ?? "post-serve";
  const runId = optionalOperatorCiArtifactImportRunId(body.runId);
  const artifactImport = await importPlatformCiArtifactReports({
    dir,
    artifactDir,
    phase,
    ...(runId ? { runId } : {}),
    report: importReportPath,
  });
  await mkdir(reportDir, { recursive: true });
  await writeJsonFileAtomic(importReportPath, artifactImport);
  const operatorStatus = createPlatformOperatorStatus({
    dir,
    repoRoot: workspaceRoot,
    ...ciTarget,
    report: reportPaths.operatorStatus,
    requireExternalStaging,
    requireOperatorApprovals,
    requireAgentGitService,
  });
  const handoffPacket = createPlatformOperatorHandoffPacketFromStatus(operatorStatus, reportPaths.operatorHandoffPacket);
  await writeJsonFileAtomic(reportPaths.operatorStatus, operatorStatus);
  await writeJsonFileAtomic(reportPaths.operatorCockpitPlan, operatorStatus.cockpitPlan);
  await writeJsonFileAtomic(reportPaths.operatorCockpitNext, handoffPacket.cockpit);
  await writeJsonFileAtomic(reportPaths.operatorHandoffPacket, handoffPacket);
  const status = operatorImportStatusSummary(operatorStatus);
  const handoff = operatorImportHandoffSummary(handoffPacket);
  const ok = artifactImport.ok && status.ok && handoff.ok;
  const result = {
    schemaVersion: "platform-operator-ci-artifact-import/v1",
    ok,
    tokenFree: true,
    tenant,
    dir,
    artifactDir,
    phase,
    ...(runId ? { runId } : {}),
    importReportPath,
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    artifactImportOk: artifactImport.ok,
    status,
    handoff,
    artifactImport,
    cockpit: handoffPacket.cockpit,
  };
  await appendAuditEvent(tenant, "operator_ci_artifact_imported", compactObject({
    clientId,
    dir,
    artifactDir,
    phase,
    runId,
    importReportPath,
    ok,
    artifactImportOk: artifactImport.ok,
    importedReportCount: artifactImport.importedReports.length,
    missingReports: artifactImport.missingReports,
    invalidReports: artifactImport.invalidReports,
    hashMismatchedReports: artifactImport.hashMismatchedReports,
    unsafeReports: artifactImport.unsafeReports,
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    handoffOk: handoffPacket.ok,
    handoffPhase: handoffPacket.phase,
    statusOk: operatorStatus.ok,
    statusPhase: operatorStatus.phase,
    ...(Object.keys(ciTarget).length ? { githubTarget: ciTarget } : {}),
  }), access);
  writeJson(res, 200, result);
  return true;
}

async function handleImportTenantOperatorAgsEvidence(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "operator" || segments[3] !== "ags-evidence-import") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const body = await readTenantOperatorAgsEvidenceImportJson(req);
  const clientId = optionalClientId(body.clientId);
  const ciTarget = operatorCockpitCiTargetFromBody(body);
  const dir = tenantOperatorBundleDir(workspaceRoot, options);
  const reportDir = join(dir, "reports");
  const importReportPath = join(reportDir, "ags-evidence-import.json");
  const reportPaths = {
    operatorStatus: join(reportDir, "operator-status.json"),
    operatorCockpitPlan: join(reportDir, "operator-cockpit-plan.json"),
    operatorCockpitNext: join(reportDir, "operator-cockpit-next.json"),
    operatorHandoffPacket: join(reportDir, "operator-handoff-packet.json"),
  };
  const requireExternalStaging = optionalBoolean(body.requireExternalStaging, "requireExternalStaging");
  const requireOperatorApprovals = optionalBoolean(body.requireOperatorApprovals, "requireOperatorApprovals");
  const requireAgentGitService = optionalBoolean(body.requireAgentGitService, "requireAgentGitService");
  const artifactDir = tenantOperatorCiArtifactImportDir(dir, body.artifactDir);
  const phase = optionalOperatorCiArtifactImportPhase(body.phase) ?? "pre-serve";
  const runId = optionalOperatorCiArtifactImportRunId(body.runId);
  const artifactImport = await importPlatformCiArtifactReports({
    dir,
    artifactDir,
    phase,
    allowedReports: platformOperatorAgsEvidenceAllowedReports(phase),
    ...(runId ? { runId } : {}),
    report: importReportPath,
  });
  await mkdir(reportDir, { recursive: true });
  await writeJsonFileAtomic(importReportPath, artifactImport);
  const operatorStatus = createPlatformOperatorStatus({
    dir,
    repoRoot: workspaceRoot,
    ...ciTarget,
    report: reportPaths.operatorStatus,
    requireExternalStaging,
    requireOperatorApprovals,
    requireAgentGitService,
  });
  const handoffPacket = createPlatformOperatorHandoffPacketFromStatus(operatorStatus, reportPaths.operatorHandoffPacket);
  await writeJsonFileAtomic(reportPaths.operatorStatus, operatorStatus);
  await writeJsonFileAtomic(reportPaths.operatorCockpitPlan, operatorStatus.cockpitPlan);
  await writeJsonFileAtomic(reportPaths.operatorCockpitNext, handoffPacket.cockpit);
  await writeJsonFileAtomic(reportPaths.operatorHandoffPacket, handoffPacket);
  const status = operatorImportStatusSummary(operatorStatus);
  const handoff = operatorImportHandoffSummary(handoffPacket);
  const ok = artifactImport.ok && status.ok && handoff.ok;
  const result = {
    schemaVersion: "platform-operator-ags-evidence-import/v1",
    ok,
    tokenFree: true,
    tenant,
    dir,
    artifactDir,
    phase,
    ...(runId ? { runId } : {}),
    importReportPath,
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    artifactImportOk: artifactImport.ok,
    status,
    handoff,
    artifactImport,
    cockpit: handoffPacket.cockpit,
  };
  await appendAuditEvent(tenant, "operator_ags_evidence_imported", compactObject({
    clientId,
    dir,
    artifactDir,
    phase,
    runId,
    importReportPath,
    ok,
    artifactImportOk: artifactImport.ok,
    importedReportCount: artifactImport.importedReports.length,
    missingReports: artifactImport.missingReports,
    invalidReports: artifactImport.invalidReports,
    hashMismatchedReports: artifactImport.hashMismatchedReports,
    unsafeReports: artifactImport.unsafeReports,
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    handoffOk: handoffPacket.ok,
    handoffPhase: handoffPacket.phase,
    statusOk: operatorStatus.ok,
    statusPhase: operatorStatus.phase,
    ...(Object.keys(ciTarget).length ? { githubTarget: ciTarget } : {}),
  }), access);
  writeJson(res, 200, result);
  return true;
}

async function handleSyncTenantOperatorAgsEvidence(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "operator" || segments[3] !== "ags-evidence-sync") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const body = await readTenantOperatorAgsEvidenceImportJson(req);
  const clientId = optionalClientId(body.clientId);
  const ciTarget = operatorCockpitCiTargetFromBody(body);
  const dir = tenantOperatorBundleDir(workspaceRoot, options);
  const reportDir = join(dir, "reports");
  const syncReportPath = join(reportDir, "ags-evidence-sync.json");
  const importReportPath = join(reportDir, "ags-evidence-import.json");
  const requireExternalStaging = optionalBoolean(body.requireExternalStaging, "requireExternalStaging");
  const requireOperatorApprovals = optionalBoolean(body.requireOperatorApprovals, "requireOperatorApprovals");
  const requireAgentGitService = optionalBoolean(body.requireAgentGitService, "requireAgentGitService");
  const phase = optionalOperatorCiArtifactImportPhase(body.phase) ?? "pre-serve";
  const runId = optionalOperatorCiArtifactImportRunId(body.runId);
  const result = await syncPlatformOperatorAgsEvidence({
    dir,
    repoRoot: workspaceRoot,
    ...ciTarget,
    phase,
    ...(runId ? { runId } : {}),
    importReport: importReportPath,
    report: syncReportPath,
    requireExternalStaging,
    requireOperatorApprovals,
    requireAgentGitService,
  });
  await mkdir(reportDir, { recursive: true });
  await writeJsonFileAtomic(syncReportPath, result);
  await appendAuditEvent(tenant, "operator_ags_evidence_synced", compactObject({
    clientId,
    dir,
    phase,
    runId: result.runId ?? runId,
    repo: result.repo,
    downloadDir: result.downloadDir,
    importReportPath,
    syncReportPath,
    ok: result.ok,
    artifactSyncOk: result.artifactSyncOk,
    artifactImportOk: result.artifactImportOk,
    importedReportCount: result.artifactImport?.importedReports.length ?? 0,
    missingReports: result.artifactImport?.missingReports,
    invalidReports: result.artifactImport?.invalidReports,
    hashMismatchedReports: result.artifactImport?.hashMismatchedReports,
    unsafeReports: result.artifactImport?.unsafeReports,
    handoffPacketPath: result.handoffPacketPath,
    reportPaths: result.reportPaths,
    handoffOk: result.handoff.ok,
    handoffPhase: result.handoff.phase,
    statusOk: result.status.ok,
    statusPhase: result.status.phase,
    ...(Object.keys(ciTarget).length ? { githubTarget: ciTarget } : {}),
  }), access);
  writeJson(res, 200, result);
  return true;
}

function operatorImportStatusSummary(status: PlatformOperatorStatusResult): {
  schemaVersion: PlatformOperatorStatusResult["schemaVersion"];
  ok: boolean;
  phase: PlatformOperatorStatusResult["phase"];
  productionCutoverReady: boolean;
  ciHandoffReady: boolean;
  missing: string[];
  blockingGroupCount: number;
} {
  return {
    schemaVersion: status.schemaVersion,
    ok: status.ok,
    phase: status.phase,
    productionCutoverReady: status.gates.productionCutoverReady,
    ciHandoffReady: status.gates.ciHandoffReady,
    missing: status.missing,
    blockingGroupCount: status.blockingGroups.length,
  };
}

function operatorImportHandoffSummary(handoff: PlatformOperatorHandoffPacketResult): {
  schemaVersion: PlatformOperatorHandoffPacketResult["schemaVersion"];
  ok: boolean;
  phase: PlatformOperatorHandoffPacketResult["phase"];
  blockingGroupIds: string[];
  nextActionCount: number;
} {
  return {
    schemaVersion: handoff.schemaVersion,
    ok: handoff.ok,
    phase: handoff.phase,
    blockingGroupIds: handoff.handoff.blockingGroupIds,
    nextActionCount: handoff.handoff.nextActions.length,
  };
}

async function handleRefreshTenantOperatorBundle(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "operator" || segments[3] !== "bundle-refresh") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const body = await readTenantOperatorBundleRefreshJson(req);
  const clientId = optionalClientId(body.clientId);
  const ciTarget = operatorCockpitCiTargetFromBody(body);
  const dir = tenantOperatorBundleDir(workspaceRoot, options);
  const reportDir = join(dir, "reports");
  const applyReportPath = join(reportDir, "staging-targets-apply.json");
  const reportPaths = {
    operatorStatus: join(reportDir, "operator-status.json"),
    operatorCockpitPlan: join(reportDir, "operator-cockpit-plan.json"),
    operatorCockpitNext: join(reportDir, "operator-cockpit-next.json"),
    operatorHandoffPacket: join(reportDir, "operator-handoff-packet.json"),
  };
  const requireExternalStaging = optionalBoolean(body.requireExternalStaging, "requireExternalStaging");
  const requireOperatorApprovals = optionalBoolean(body.requireOperatorApprovals, "requireOperatorApprovals");
  const requireAgentGitService = optionalBoolean(body.requireAgentGitService, "requireAgentGitService");
  const expectedApplyReportSha256 = optionalSha256Hex(body.expectedApplyReportSha256, "expectedApplyReportSha256");
  const applyReportSha256 = await optionalFileSha256(applyReportPath);
  if (expectedApplyReportSha256 && applyReportSha256 !== expectedApplyReportSha256) {
    writeJson(res, 409, {
      schemaVersion: "platform-operator-input-write-conflict/v1",
      ok: false,
      tokenFree: true,
      tenant,
      dir,
      inputPath: applyReportPath,
      expectedInputSha256: expectedApplyReportSha256,
      currentInputExists: applyReportSha256 !== undefined,
      ...(applyReportSha256 ? { currentInputSha256: applyReportSha256 } : {}),
      missing: ["inputSha256.mismatch"],
      nextActions: ["Refresh the operator cockpit, then rerun bundle refresh with the current staging-targets-apply report sha256."],
    });
    return true;
  }
  const applyReport = await readOperatorBundleRefreshApplyReport(applyReportPath, dir);
  const refresh = await refreshOperatorBundleFromRealPlan({
    dir,
    reportDir,
    applyReportPath,
    applyReportSha256,
    applyReport,
  });
  const operatorStatus = createPlatformOperatorStatus({
    dir,
    repoRoot: workspaceRoot,
    ...ciTarget,
    report: reportPaths.operatorStatus,
    requireExternalStaging,
    requireOperatorApprovals,
    requireAgentGitService,
  });
  const handoffPacket = createPlatformOperatorHandoffPacketFromStatus(operatorStatus, reportPaths.operatorHandoffPacket);
  await mkdir(reportDir, { recursive: true });
  await writeJsonFileAtomic(reportPaths.operatorStatus, operatorStatus);
  await writeJsonFileAtomic(reportPaths.operatorCockpitPlan, operatorStatus.cockpitPlan);
  await writeJsonFileAtomic(reportPaths.operatorCockpitNext, handoffPacket.cockpit);
  await writeJsonFileAtomic(reportPaths.operatorHandoffPacket, handoffPacket);
  const result = {
    schemaVersion: "platform-operator-bundle-refresh/v1",
    ok: true,
    tokenFree: true,
    tenant,
    dir,
    applyReportPath,
    ...(applyReportSha256 ? { applyReportSha256 } : {}),
    ...refresh,
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    cockpit: handoffPacket.cockpit,
  };
  await appendAuditEvent(tenant, "operator_bundle_refreshed", compactObject({
    clientId,
    dir,
    applyReportPath,
    applyReportSha256,
    sourceRealPlanPath: refresh.sourceRealPlanPath,
    sourceRealPlanSha256: refresh.sourceRealPlanSha256,
    planPath: refresh.planPath,
    planSha256: refresh.planSha256,
    manifestPath: refresh.manifestPath,
    manifestSha256: refresh.manifestSha256,
    updatedFiles: refresh.updatedFiles,
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    handoffOk: handoffPacket.ok,
    handoffPhase: handoffPacket.phase,
    ...(Object.keys(ciTarget).length ? { githubTarget: ciTarget } : {}),
  }), access);
  writeJson(res, 200, result);
  return true;
}

async function readOperatorBundleRefreshApplyReport(path: string, dir: string): Promise<Record<string, unknown> & { realPlanPath: string }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) throw badRequest("staging-targets-apply report is required before bundle refresh.");
    throw badRequest("staging-targets-apply report must be valid JSON.");
  }
  if (!isJsonRecord(value) || value.schemaVersion !== "platform-staging-targets-apply/v1") {
    throw badRequest("staging-targets-apply report must use schemaVersion platform-staging-targets-apply/v1.");
  }
  const missing = Array.isArray(value.missing) ? value.missing.filter((item): item is string => typeof item === "string") : [];
  const gates = isJsonRecord(value.gates) ? value.gates : {};
  if (value.ok !== true || value.tokenFree !== true || missing.length > 0 || gates.envCheckOk !== true || gates.realPlanWritten !== true || gates.realTargetsProofOk !== true) {
    throw badRequest("staging-targets-apply report must be ok before bundle refresh.");
  }
  const realPlanPath = optionalString(value.realPlanPath, "realPlanPath");
  if (!realPlanPath) throw badRequest("staging-targets-apply report must include realPlanPath.");
  const resolvedRealPlanPath = resolve(realPlanPath);
  if (!resolvedPathInside(resolve(dir), resolvedRealPlanPath)) {
    throw badRequest("realPlanPath must stay inside the operator bundle directory.");
  }
  return { ...value, realPlanPath: resolvedRealPlanPath };
}

async function refreshOperatorBundleFromRealPlan(options: {
  dir: string;
  reportDir: string;
  applyReportPath: string;
  applyReportSha256?: string;
  applyReport: Record<string, unknown> & { realPlanPath: string };
}): Promise<{
  sourceRealPlanPath: string;
  sourceRealPlanSha256: string;
  planPath: string;
  planSha256: string;
  manifestPath: string;
  manifestSha256: string;
  stagingTargetsPlanPath: string;
  stagingTargetsEnvCheckPath: string;
  updatedFiles: string[];
}> {
  const bundleDir = resolve(options.dir);
  const sourceRealPlanPath = options.applyReport.realPlanPath;
  const sourceRealPlanText = await readFile(sourceRealPlanPath, "utf8");
  const sourceRealPlan = parseOperatorBundleRefreshJsonRecord(sourceRealPlanText, "plan.real-targets.json");
  const sourceRealPlanSha256 = sha256Text(sourceRealPlanText);
  const planPath = join(bundleDir, "plan.json");
  const updatedFiles = ["plan.json"];
  await writeJsonFileAtomic(planPath, sourceRealPlan);
  const planSha256 = sha256Text(await readFile(planPath, "utf8"));
  const upstreamGuideUpdated = await refreshOperatorBundleUpstreamGuide(bundleDir, sourceRealPlan);
  if (upstreamGuideUpdated) updatedFiles.push("upstream-agent-git-service.json");
  const manifestPath = join(bundleDir, "manifest.json");
  const manifestSha256 = await refreshOperatorBundleManifest(bundleDir, manifestPath);
  updatedFiles.push("manifest.json");
  const stagingTargetsPlanPath = join(options.reportDir, "staging-targets-plan.json");
  await writeJsonFileAtomic(stagingTargetsPlanPath, sanitizedStagingTargetsPlan(bundleDir, stagingTargetsPlanPath));
  updatedFiles.push("reports/staging-targets-plan.json");
  const stagingTargetsEnvCheckPath = join(options.reportDir, "staging-targets-env-check.json");
  await writeJsonFileAtomic(stagingTargetsEnvCheckPath, sanitizedStagingTargetsEnvCheck(bundleDir, stagingTargetsEnvCheckPath));
  updatedFiles.push("reports/staging-targets-env-check.json");
  await writeJsonFileAtomic(options.applyReportPath, {
    ...options.applyReport,
    bundleRefresh: compactObject({
      tokenFree: true,
      sourceRealPlanPath,
      sourceRealPlanSha256,
      planPath,
      planSha256,
      manifestPath,
      manifestSha256,
      applyReportSha256: options.applyReportSha256,
    }),
    nextActions: [],
  });
  updatedFiles.push("reports/staging-targets-apply.json");
  if (await filterTargetPrerequisitesReport(join(options.reportDir, "staging-prerequisites.json"))) {
    updatedFiles.push("reports/staging-prerequisites.json");
  }
  return {
    sourceRealPlanPath,
    sourceRealPlanSha256,
    planPath,
    planSha256,
    manifestPath,
    manifestSha256,
    stagingTargetsPlanPath,
    stagingTargetsEnvCheckPath,
    updatedFiles,
  };
}

async function refreshOperatorBundleUpstreamGuide(dir: string, plan: Record<string, unknown>): Promise<boolean> {
  const guidePath = join(dir, "upstream-agent-git-service.json");
  const systems = isJsonRecord(plan.externalEnvironment) && isJsonRecord(plan.externalEnvironment.systems)
    ? plan.externalEnvironment.systems
    : {};
  const controlPlane = isJsonRecord(systems.controlPlane) ? systems.controlPlane : undefined;
  const agentGitServiceStaging = isJsonRecord(systems.agentGitServiceStaging) ? systems.agentGitServiceStaging : undefined;
  if (!controlPlane && !agentGitServiceStaging) return false;
  let guide: Record<string, unknown> = {
    schemaVersion: "upstream-agent-git-service-staging-guide/v1",
    tokenFree: true,
    upstream: {
      repository: "https://github.com/ngaut/agent-git-service",
      developmentBinary: "gh-server",
      apiBasePath: "/api/v3",
      metadataDatabaseEnv: "DB_DSN",
    },
    requiredServerEnv: [
      { name: "DB_DSN", purpose: "upstream agent-git-service metadata database DSN for gh-server" },
    ],
  };
  try {
    const existing = JSON.parse(await readFile(guidePath, "utf8")) as unknown;
    if (isJsonRecord(existing)) guide = existing;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await writeJsonFileAtomic(guidePath, {
    ...guide,
    schemaVersion: "upstream-agent-git-service-staging-guide/v1",
    tokenFree: true,
    targets: compactObject({
      controlPlane,
      agentGitServiceStaging,
    }),
  });
  return true;
}

async function refreshOperatorBundleManifest(dir: string, manifestPath: string): Promise<string> {
  let manifest: Record<string, unknown> = {
    schemaVersion: 1,
    tokenFree: true,
    source: "loom harness platform-cutover-plan",
  };
  try {
    const existing = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (isJsonRecord(existing)) manifest = existing;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const existingFiles = Array.isArray(manifest.files) ? manifest.files.filter((item): item is string => typeof item === "string") : [];
  const files = Array.from(new Set([
    ...existingFiles,
    ...[
      "plan.json",
      "env.md",
      "env.sh",
      "external-secrets.json",
      "github-actions-staging.yml",
      "commands.sh",
      "staging-ci.json",
    ].filter((file) => fileExists(join(dir, file))),
    ...(fileExists(join(dir, "upstream-agent-git-service.json")) ? ["upstream-agent-git-service.json"] : []),
  ]));
  const previousFileSha256 = isJsonRecord(manifest.fileSha256) ? manifest.fileSha256 : {};
  const fileSha256: Record<string, string> = {};
  for (const [file, sha] of Object.entries(previousFileSha256)) {
    if (typeof sha === "string") fileSha256[file] = sha;
  }
  for (const file of files) {
    const path = join(dir, file);
    if (fileExists(path)) fileSha256[file] = sha256Text(await readFile(path, "utf8"));
  }
  await writeJsonFileAtomic(manifestPath, {
    ...manifest,
    schemaVersion: manifest.schemaVersion ?? 1,
    tokenFree: true,
    files,
    fileSha256,
  });
  return sha256Text(await readFile(manifestPath, "utf8"));
}

function sanitizedStagingTargetsPlan(dir: string, reportPath: string): Record<string, unknown> {
  const inputTemplatePath = join(dir, "real-staging-targets.input.json");
  return {
    schemaVersion: "platform-staging-targets-plan/v1",
    ok: true,
    tokenFree: true,
    dir,
    reportPath,
    planPath: join(dir, "plan.json"),
    realPlanPath: join(dir, "plan.real-targets.json"),
    inputTemplatePath,
    inputTemplate: {
      schemaVersion: "platform-staging-targets-input/v1",
      targets: {
        modelGatewayBaseUrl: "",
        agentGitServiceBaseUrl: "",
        agentGitServiceIssue: "",
        agentGitServiceRepo: "",
        agentGitServiceNativeWriteAttachmentUrl: "",
      },
    },
    currentTargets: {
      modelGateway: { placeholder: false },
      controlPlane: { provider: "agent-git-service", placeholder: false },
      agentGitServiceStaging: {
        issuePlaceholder: false,
        repoPlaceholder: false,
        nativeWriteAttachmentUrlPlaceholder: false,
      },
    },
    placeholderTargets: [],
    requiredEnvNames: [],
    envCheckShellCommands: [],
    envValidationCommandArgs: [],
    envValidationShellCommand: "",
    applyCommandArgs: [],
    applyShellCommand: "",
    applyInputCommandArgs: [],
    applyInputShellCommand: "",
    planPatchJqFilter: "",
    planPatchCommandArgs: [],
    planPatchShellCommand: "",
    validatedPlanPatchShellCommand: "",
    realTargetsCheckCommandArgs: [],
    realTargetsCheckShellCommand: "",
    validatedRealTargetsShellCommand: "",
    bundleRefreshCommandArgs: [],
    prerequisitesCommandArgs: [],
    gates: {
      planReadable: true,
      replacementEnvNamesReady: true,
      planPatchReady: true,
    },
    missing: [],
    nextActions: [],
  };
}

function sanitizedStagingTargetsEnvCheck(dir: string, reportPath: string): Record<string, unknown> {
  return {
    schemaVersion: "platform-staging-targets-env-check/v1",
    ok: true,
    tokenFree: true,
    dir,
    reportPath,
    requiredEnvNames: [],
    checks: {},
    gates: {
      envNamesPresent: true,
      formatsOk: true,
      placeholdersAbsent: true,
    },
    missing: [],
    nextActions: [],
  };
}

async function filterTargetPrerequisitesReport(path: string): Promise<boolean> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  if (!isJsonRecord(value) || value.schemaVersion !== "platform-staging-prerequisites/v1") return false;
  const missing = Array.isArray(value.missing) ? value.missing.filter((item): item is string => typeof item === "string") : [];
  const nextActions = Array.isArray(value.nextActions) ? value.nextActions.filter((item): item is string => typeof item === "string") : [];
  const filteredMissing = missing.filter((item) => !item.startsWith("targets."));
  const filteredNextActions = nextActions.filter((item) => !/target replacement|staging target replacement/i.test(item));
  if (filteredMissing.length === missing.length && filteredNextActions.length === nextActions.length) return false;
  await writeJsonFileAtomic(path, {
    ...value,
    ok: filteredMissing.length === 0,
    missing: filteredMissing,
    nextActions: filteredNextActions,
  });
  return true;
}

function parseOperatorBundleRefreshJsonRecord(text: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    if (isJsonRecord(value)) return value;
  } catch (error) {
    throw badRequest(`${label} must be valid JSON.`);
  }
  throw badRequest(`${label} must be a JSON object.`);
}

function fileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function tenantOperatorBundleDir(workspaceRoot: string, options: HarnessServerOptions): string {
  return resolve(options.operatorBundleDir ?? join(workspaceRoot, "cutover-bundle"));
}

function optionalOperatorCockpitMaxSteps(value: unknown): number {
  if (value === undefined) return 1;
  const maxSteps = positiveIntValue(value, "maxSteps");
  if (maxSteps > 20) throw badRequest("maxSteps must be at most 20.");
  return maxSteps;
}

function operatorCockpitLoopLastExecution(result: Awaited<ReturnType<typeof runPlatformOperatorCockpitLoop>>) {
  const iterations = [...result.iterations].reverse();
  return iterations.find((iteration) => iteration.runner.mode === "executed" || iteration.runner.mode === "blocked")?.runner ??
    iterations[0]?.runner;
}

async function tenantOperatorCockpitNextCurrentStepId(path: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isJsonRecord(value) || value.schemaVersion !== "platform-operator-cockpit-next/v1") return undefined;
    return typeof value.currentStepId === "string" ? value.currentStepId : undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    return undefined;
  }
}

async function drainOperatorCockpitExecutionQueue(
  queueBackend: OperatorCockpitQueueBackend,
  queue: OperatorCockpitExecutionQueueItem[],
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
  setLast: (summary: OperatorCockpitQueuedExecutionSummary) => void,
): Promise<void> {
  const item = queue.find((entry) => entry.status === "queued");
  if (!item) return;
  if (!await queueBackend.itemExists(item)) {
    const index = queue.findIndex((entry) => entry.queueId === item.queueId);
    if (index >= 0) queue.splice(index, 1);
    return;
  }
  const executionStatus = readPlatformOperatorCockpitExecutionStatus({ dir: item.dir });
  if (executionStatus.state === "locked" || executionStatus.state === "invalid") return;
  const claim = await queueBackend.acquireClaim(item);
  if (!claim) return;

  item.status = "running";
  item.startedAt = new Date().toISOString();
  let result: Awaited<ReturnType<typeof runQueuedOperatorCockpitExecution>>;
  try {
    result = await runQueuedOperatorCockpitExecution(item, options);
  } catch (error) {
    await queueBackend.releaseClaim(item, claim);
    throw error;
  }
  if (result.blocked) {
    await queueBackend.releaseClaim(item, claim);
    item.status = "queued";
    item.startedAt = undefined;
    return;
  }
  const finishedAt = new Date().toISOString();
  await queueBackend.removeItem(item);
  await queueBackend.releaseClaim(item, claim);
  const index = queue.findIndex((entry) => entry.queueId === item.queueId);
  if (index >= 0) queue.splice(index, 1);
  const summary: OperatorCockpitQueuedExecutionSummary = {
    queueId: item.queueId,
    tenant: item.tenant,
    dir: item.dir,
    status: result.ok ? "executed" : "failed",
    enqueuedAt: item.enqueuedAt,
    startedAt: item.startedAt,
    finishedAt,
    ...(result.execution ? { execution: result.execution } : {}),
    ...(result.refreshed ? { refreshed: result.refreshed } : {}),
  };
  setLast(summary);
  await appendAuditEvent(item.tenant, "operator_cockpit_loop_executed", compactObject({
    clientId: item.clientId,
    queued: true,
    queueId: item.queueId,
    dir: item.dir,
    maxSteps: item.maxSteps,
    phase: result.execution?.phase,
    state: result.execution?.state,
    mode: result.execution?.mode,
    commandLabel: result.execution?.commandRef?.label,
    exitCode: result.execution?.execution?.exitCode,
    ok: result.ok,
    ...(Object.keys(item.ciTarget).length ? { githubTarget: item.ciTarget } : {}),
  }), item.access);
}

async function runQueuedOperatorCockpitExecution(
  item: OperatorCockpitExecutionQueueItem,
  options: HarnessServerOptions,
): Promise<{
  ok: boolean;
  blocked: boolean;
  execution?: Awaited<ReturnType<typeof runPlatformOperatorCockpitRunner>>;
  refreshed?: Awaited<ReturnType<typeof runPlatformOperatorCockpitLoop>>;
}> {
  const reportDir = join(item.dir, "reports");
  const executeReportPath = join(reportDir, "operator-cockpit-runner-execute.json");
  const loopReportPath = join(reportDir, "operator-cockpit-loop.json");
  const nextPath = join(reportDir, "operator-cockpit-next.json");
  await mkdir(reportDir, { recursive: true });
  if (item.maxSteps > 1) {
    const refreshed = await runPlatformOperatorCockpitLoop({
      dir: item.dir,
      repoRoot: options.workspaceRoot,
      ...item.ciTarget,
      execute: true,
      maxSteps: item.maxSteps,
      report: loopReportPath,
      requireExternalStaging: item.requireExternalStaging,
      requireOperatorApprovals: item.requireOperatorApprovals,
      requireAgentGitService: item.requireAgentGitService,
    });
    await writeJsonFileAtomic(loopReportPath, refreshed);
    const execution = operatorCockpitLoopLastExecution(refreshed);
    if (execution) await writeJsonFileAtomic(executeReportPath, execution);
    return {
      ok: refreshed.ok,
      blocked: execution?.mode === "blocked",
      ...(execution ? { execution } : {}),
      refreshed,
    };
  }

  const existingStepId = await tenantOperatorCockpitNextCurrentStepId(nextPath);
  const refreshedNext = createPlatformOperatorCockpitNext({
    dir: item.dir,
    repoRoot: options.workspaceRoot,
    ...item.ciTarget,
    requireExternalStaging: item.requireExternalStaging,
    requireOperatorApprovals: item.requireOperatorApprovals,
    requireAgentGitService: item.requireAgentGitService,
  });
  if (
    refreshedNext.state === "ready-to-run" &&
    refreshedNext.commandRef?.commandArgs.length &&
    (existingStepId === undefined || existingStepId === refreshedNext.currentStepId)
  ) {
    await writeJsonFileAtomic(nextPath, refreshedNext);
  }
  const execution = await runPlatformOperatorCockpitRunner({
    dir: item.dir,
    next: nextPath,
    execute: true,
    report: executeReportPath,
  });
  await writeJsonFileAtomic(executeReportPath, execution);
  if (execution.mode === "blocked") {
    return { ok: false, blocked: true, execution };
  }
  const refreshed = await runPlatformOperatorCockpitLoop({
    dir: item.dir,
    repoRoot: options.workspaceRoot,
    ...item.ciTarget,
    report: loopReportPath,
    requireExternalStaging: item.requireExternalStaging,
    requireOperatorApprovals: item.requireOperatorApprovals,
    requireAgentGitService: item.requireAgentGitService,
  });
  await writeJsonFileAtomic(loopReportPath, refreshed);
  return {
    ok: execution.ok,
    blocked: false,
    execution,
    refreshed,
  };
}

async function tenantOperatorGithubActionsTargetInputPath(dir: string): Promise<string> {
  const bundleDir = resolve(dir);
  const defaultPath = join(bundleDir, "github-actions-target.input.json");
  const preflightPath = join(bundleDir, "reports", "ci-handoff-preflight.json");
  let inputTemplatePath: string | undefined;
  try {
    const preflight = JSON.parse(await readFile(preflightPath, "utf8")) as unknown;
    if (!isJsonRecord(preflight) || preflight.schemaVersion !== "platform-ci-handoff-preflight/v1") {
      throw badRequest("ci-handoff-preflight report must use schemaVersion platform-ci-handoff-preflight/v1.");
    }
    inputTemplatePath = optionalOperatorGithubActionsTargetString(preflight.targetInputTemplatePath, "targetInputTemplatePath", 2000);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const inputPath = resolve(inputTemplatePath ?? defaultPath);
  if (!resolvedPathInside(bundleDir, inputPath)) {
    throw badRequest("GitHub Actions target input path must stay inside the operator bundle directory.");
  }
  return inputPath;
}

function tenantOperatorCiArtifactImportDir(dir: string, value: unknown): string {
  const bundleDir = resolve(dir);
  const artifactDir = resolve(bundleDir, operatorCiArtifactImportString(value, "artifactDir", 2000));
  if (!resolvedPathInside(bundleDir, artifactDir)) {
    throw badRequest("artifactDir must stay inside the operator bundle directory.");
  }
  return artifactDir;
}

function optionalOperatorCiArtifactImportPhase(value: unknown): "pre-serve" | "post-serve" | "all" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const phase = operatorCiArtifactImportString(value, "phase", 40);
  if (phase !== "pre-serve" && phase !== "post-serve" && phase !== "all") {
    throw badRequest("phase must be pre-serve, post-serve, or all.");
  }
  return phase;
}

function optionalOperatorCiArtifactImportRunId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const runId = operatorCiArtifactImportString(value, "runId", 120);
  if (!/^[A-Za-z0-9_.:-]+$/.test(runId)) throw badRequest("runId must be a safe single token.");
  return runId;
}

function operatorCiArtifactImportString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} is required.`);
  const text = value.trim();
  if (text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw badRequest(`${field} must be a single-line string at most ${maxLength} characters.`);
  }
  return text;
}

function tenantOperatorGithubActionsTargetInputFromBody(body: TenantOperatorGithubActionsTargetInputRequestBody): {
  schemaVersion: "platform-ci-target-input/v1";
  repo: string;
  ref: string;
} {
  if (body.schemaVersion !== "platform-ci-target-input/v1") {
    throw badRequest("schemaVersion must be platform-ci-target-input/v1.");
  }
  return {
    schemaVersion: "platform-ci-target-input/v1",
    repo: operatorGithubActionsTargetRepo(body.repo, "repo"),
    ref: operatorGithubActionsTargetRef(body.ref, "ref"),
  };
}

async function tenantOperatorRealStagingTargetInputPath(dir: string): Promise<string> {
  const bundleDir = resolve(dir);
  const planPath = join(bundleDir, "reports", "staging-targets-plan.json");
  let plan: unknown;
  try {
    plan = JSON.parse(await readFile(planPath, "utf8"));
  } catch (error) {
    if (isNotFound(error)) throw badRequest("staging-targets-plan report is required before writing real staging target input.");
    throw badRequest("staging-targets-plan report must be valid JSON.");
  }
  if (!isJsonRecord(plan) || plan.schemaVersion !== "platform-staging-targets-plan/v1") {
    throw badRequest("staging-targets-plan report must use schemaVersion platform-staging-targets-plan/v1.");
  }
  const inputTemplatePath = operatorRealStagingTargetString(plan.inputTemplatePath, "inputTemplatePath", 2000);
  const inputPath = resolve(inputTemplatePath);
  if (!resolvedPathInside(bundleDir, inputPath)) {
    throw badRequest("staging targets inputTemplatePath must stay inside the operator bundle directory.");
  }
  return inputPath;
}

function operatorGithubActionsTargetRepo(value: unknown, field: string): string {
  const text = operatorGithubActionsTargetString(value, field, 300);
  if (!/^([^/\s]+)\/([^/\s#]+)$/.test(text)) throw badRequest(`${field} must be owner/repo.`);
  if (operatorGithubActionsTargetPlaceholderRepo(text)) throw badRequest(`${field} must not be a placeholder repo.`);
  return text;
}

function operatorGithubActionsTargetRef(value: unknown, field: string): string {
  const text = operatorGithubActionsTargetString(value, field, 300);
  if (!/^[A-Za-z0-9._/-]+$/.test(text) || text.includes("..") || text.includes("//") || text.startsWith("/") || text.endsWith("/")) {
    throw badRequest(`${field} must be a branch or ref name.`);
  }
  if (["<branch>", "branch"].includes(text.toLowerCase())) throw badRequest(`${field} must not be a placeholder ref.`);
  return text;
}

function optionalOperatorGithubActionsTargetString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return operatorGithubActionsTargetString(value, field, maxLength);
}

function operatorGithubActionsTargetString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} is required.`);
  const text = value.trim();
  if (text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw badRequest(`${field} must be a single-line string at most ${maxLength} characters.`);
  }
  return text;
}

function operatorGithubActionsTargetPlaceholderRepo(value: string): boolean {
  return [
    "<owner/repo>",
    "org/repo",
    "owner/repo",
    "team/app",
  ].includes(value.trim().toLowerCase());
}

function tenantOperatorRealStagingTargetInputFromBody(body: TenantOperatorRealStagingTargetInputRequestBody): {
  schemaVersion: "platform-staging-targets-input/v1";
  targets: {
    modelGatewayBaseUrl: string;
    agentGitServiceBaseUrl: string;
    agentGitServiceIssue: string;
    agentGitServiceRepo: string;
    agentGitServiceNativeWriteAttachmentUrl: string;
  };
} {
  if (body.schemaVersion !== "platform-staging-targets-input/v1") {
    throw badRequest("schemaVersion must be platform-staging-targets-input/v1.");
  }
  if (!isJsonRecord(body.targets)) throw badRequest("targets must be an object.");
  return {
    schemaVersion: "platform-staging-targets-input/v1",
    targets: {
      modelGatewayBaseUrl: operatorRealStagingTargetUrl(body.targets.modelGatewayBaseUrl, "targets.modelGatewayBaseUrl"),
      agentGitServiceBaseUrl: operatorRealStagingTargetUrl(body.targets.agentGitServiceBaseUrl, "targets.agentGitServiceBaseUrl"),
      agentGitServiceIssue: operatorRealStagingTargetIssue(body.targets.agentGitServiceIssue, "targets.agentGitServiceIssue"),
      agentGitServiceRepo: operatorRealStagingTargetRepo(body.targets.agentGitServiceRepo, "targets.agentGitServiceRepo"),
      agentGitServiceNativeWriteAttachmentUrl: operatorRealStagingTargetUrl(
        body.targets.agentGitServiceNativeWriteAttachmentUrl,
        "targets.agentGitServiceNativeWriteAttachmentUrl",
      ),
    },
  };
}

function operatorRealStagingTargetUrl(value: unknown, field: string): string {
  const text = operatorRealStagingTargetString(value, field, 1000);
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid protocol");
  } catch {
    throw badRequest(`${field} must be an http or https URL.`);
  }
  if (operatorRealStagingTargetPlaceholderUrl(text)) throw badRequest(`${field} must not be a placeholder URL.`);
  return text;
}

function operatorRealStagingTargetIssue(value: unknown, field: string): string {
  const text = operatorRealStagingTargetString(value, field, 300);
  if (!/^([^/\s]+)\/([^#\s]+)#\d+$/.test(text)) throw badRequest(`${field} must be owner/repo#number.`);
  if (operatorRealStagingTargetPlaceholderIssue(text)) throw badRequest(`${field} must not be a placeholder issue.`);
  return text;
}

function operatorRealStagingTargetRepo(value: unknown, field: string): string {
  const text = operatorRealStagingTargetString(value, field, 300);
  if (!/^([^/\s]+)\/([^/\s#]+)$/.test(text)) throw badRequest(`${field} must be owner/repo.`);
  if (operatorRealStagingTargetPlaceholderRepo(text)) throw badRequest(`${field} must not be a placeholder repo.`);
  return text;
}

function operatorRealStagingTargetString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} is required.`);
  const text = value.trim();
  if (text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw badRequest(`${field} must be a single-line string at most ${maxLength} characters.`);
  }
  return text;
}

function operatorRealStagingTargetPlaceholderUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "example.com" ||
      hostname === "example.net" ||
      hostname === "example.org" ||
      hostname.endsWith(".example") ||
      hostname.endsWith(".example.com") ||
      hostname.endsWith(".example.net") ||
      hostname.endsWith(".example.org");
  } catch {
    return false;
  }
}

function operatorRealStagingTargetPlaceholderIssue(value: string): boolean {
  const match = /^([^/\s]+)\/([^#\s]+)#\d+$/.exec(value.trim());
  return match ? operatorRealStagingTargetPlaceholderRepo(`${match[1]}/${match[2]}`) : false;
}

function operatorRealStagingTargetPlaceholderRepo(value: string): boolean {
  return [
    "org/repo",
    "owner/repo",
    "team/app",
    "team/loom",
    "team/loom-smoke",
  ].includes(value.trim().toLowerCase());
}

function resolvedPathInside(root: string, path: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const rel = relative(resolvedRoot, resolvedPath);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}

function optionalQueryBoolean(url: URL, name: string): boolean | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  throw badRequest(`${name} must be a boolean query value.`);
}

function optionalQueryString(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value.trim() === "") return undefined;
  return value.trim();
}

function operatorCockpitCiTargetFromQuery(url: URL): { repo?: string; ref?: string } {
  return compactObject({
    repo: optionalOperatorCockpitRepo(optionalQueryString(url, "repo"), "repo"),
    ref: optionalOperatorCockpitRef(optionalQueryString(url, "ref"), "ref"),
  });
}

function operatorCockpitCiTargetFromBody(body: { repo?: unknown; ref?: unknown }): { repo?: string; ref?: string } {
  return compactObject({
    repo: optionalOperatorCockpitRepo(body.repo, "repo"),
    ref: optionalOperatorCockpitRef(body.ref, "ref"),
  });
}

function optionalOperatorCockpitRepo(value: unknown, field: string): string | undefined {
  const repo = optionalString(value, field)?.trim();
  if (!repo) return undefined;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw badRequest(`${field} must be formatted as owner/repo.`);
  }
  return repo;
}

function optionalOperatorCockpitRef(value: unknown, field: string): string | undefined {
  const ref = optionalString(value, field)?.trim();
  if (!ref) return undefined;
  if (ref.startsWith("-") || ref.includes("..") || /[\s\0]/.test(ref)) {
    throw badRequest(`${field} is not a safe git ref.`);
  }
  return ref;
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

  const existing = await readTenantPolicy(workspaceRoot, tenant);
  const policyChange = tenantPolicyReplacementChange(existing, policy);
  await writeTenantPolicy(workspaceRoot, tenant, policy);
  await appendAuditEvent(tenant, "tenant_policy_updated", compactObject({
    ...tenantPolicyAuditData(policy),
    policyChange,
  }), access);
  writeJson(res, 200, sanitizeTenantPolicy(policy));
  return true;
}

async function handleCreateTenantPolicyApiKey(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  if (segments[0] !== "tenants" || segments[2] !== "policy" || segments[3] !== "api-keys") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const body = tenantPolicyApiKeyCreateFromUnknown(await readTenantPolicyApiKeyCreateJson(req));
  const clientId = optionalClientId(body.clientId);
  const { apiKey, token } = tenantPolicyApiKeyFromCreateBody(body);
  const existing = await readTenantPolicy(workspaceRoot, tenant);
  const currentKeys = existing?.apiKeys ?? [];
  const duplicate = [...(options.tenantApiKeys?.[tenant] ?? []), ...currentKeys]
    .some((key) => tenantApiKeyMatches(key, token));
  if (duplicate) {
    throw badRequest("tenant API key token already exists.");
  }

  const policy = compactObject({
    ...(existing ?? { schemaVersion: 1 as const }),
    schemaVersion: 1 as const,
    apiKeys: [...currentKeys, apiKey],
  });
  await writeTenantPolicy(workspaceRoot, tenant, policy);
  await appendAuditEvent(tenant, "tenant_api_key_created", compactObject({
    actor: apiKey.actor,
    keyRole: apiKey.role,
    modelKeyEnv: apiKey.modelKeyEnv,
    createdApiKey: sanitizeTenantApiKey(apiKey),
    apiKeysBefore: sanitizeTenantApiKeys(currentKeys),
    apiKeysAfter: sanitizeTenantApiKeys(policy.apiKeys),
    apiKeyCount: policy.apiKeys?.length ?? 0,
    clientId,
  }), access);
  writeJson(res, 201, {
    apiKey: sanitizeTenantApiKey(apiKey),
    token,
    policy: sanitizeTenantPolicy(policy),
  });
  return true;
}

async function handleRevokeTenantPolicyApiKey(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return false;
  if (segments[0] !== "tenants" || segments[2] !== "policy" || segments[3] !== "api-keys" || segments[4] !== "revoke") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "admin");
  const body = tenantPolicyApiKeyRevokeFromUnknown(await readTenantPolicyApiKeyRevokeJson(req));
  const clientId = optionalClientId(body.clientId);
  const actor = tenantPolicyApiKeyActor(body.actor);
  const role = body.role === undefined ? undefined : tenantPolicyRole(body.role, "role");
  const existing = await readTenantPolicy(workspaceRoot, tenant);
  const currentKeys = existing?.apiKeys ?? [];
  const revokedApiKeys = currentKeys.filter((key) => key.actor === actor && (role === undefined || key.role === role));
  const apiKeys = currentKeys.filter((key) => key.actor !== actor || (role !== undefined && key.role !== role));
  const revoked = currentKeys.length - apiKeys.length;
  const policy = compactObject({
    ...(existing ?? { schemaVersion: 1 as const }),
    schemaVersion: 1 as const,
    apiKeys,
  });
  await writeTenantPolicy(workspaceRoot, tenant, policy);
  await appendAuditEvent(tenant, "tenant_api_key_revoked", compactObject({
    actor,
    keyRole: role,
    revoked,
    revokedApiKeys: sanitizeTenantApiKeys(revokedApiKeys),
    apiKeysBefore: sanitizeTenantApiKeys(currentKeys),
    apiKeysAfter: sanitizeTenantApiKeys(policy.apiKeys),
    apiKeyCount: policy.apiKeys?.length ?? 0,
    clientId,
  }), access);
  writeJson(res, 200, {
    revoked,
    policy: sanitizeTenantPolicy(policy),
  });
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
  const existing = await readTenantPolicy(workspaceRoot, tenant);
  const policy = mergeTenantPolicySettings(existing, body, options);
  const policyChange = tenantPolicySettingsChange(existing, policy, body);
  await writeTenantPolicy(workspaceRoot, tenant, policy);
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
    await streamTenantAuditEvents(res, workspaceRoot, tenant, seqAfter(url, req), projectFilter);
    return true;
  }

  writeJson(
    res,
    200,
    filterTenantAuditEvents(await readTenantAuditEvents(workspaceRoot, tenant), seqAfter(url), auditLimit(url), projectFilter),
  );
  return true;
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
    const context = await runWorkspaceContext(url, workspaceRoot, tenant, runId);
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
      await runWorkspaceContext(url, workspaceRoot, tenant, runId),
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
    const context = await runWorkspaceContext(url, workspaceRoot, tenant, runId);
    const runDir = join(workspaceRoot, tenant, context.project, ".loom", "runs", runId);
    const state = await readRunState(runDir);
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
      const withPullRequest = await attachWorkspacePullRequestToRunSummary(run.summary, run.runDir, request, result, reviewRequired, deploymentRequired, runEventContext(access, clientId));
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
  }));
  updated = { ...updated, eventCount: external.seq };

  if (reviewRequired && updated.status === "passed") {
    const review: ReviewGate = { required: true, status: "pending" };
    const reviewEvent = await appendRunEvent(runDir, "review_gate", compactObject({ ...review, ...eventContext }));
    updated = { ...updated, status: "review_required", review, eventCount: reviewEvent.seq };
  }
  if (deploymentRequired && !updated.deployment?.required && (updated.status === "passed" || updated.status === "review_required")) {
    const deployment: DeploymentGate = { required: true, status: "pending" };
    const deploymentEvent = await appendRunEvent(runDir, "deployment_gate", compactObject({ ...deployment, ...eventContext }));
    const status = updated.status === "review_required" ? "review_required" : "deployment_required";
    updated = { ...updated, status, deployment, eventCount: deploymentEvent.seq };
  }

  await writeRunSummary(updated);
  await writeRunStatus(runDir, updated);
  return updated;
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
    });
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
    });
  }
}

function selectAgentGitServiceHandoffWorkspace(
  workspaces: AgentGitServiceIssueWorkspace[],
  branch: string,
): AgentGitServiceIssueWorkspace | undefined {
  return workspaces.find((workspace) => workspace.branch === branch);
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

function workspacePullRequestRef(value: unknown, fallback: string | undefined, field: string, optional = false): string | undefined {
  const ref = (optionalString(value, field) ?? fallback)?.trim();
  if (!ref) {
    if (optional) return undefined;
    throw badRequest(`${field} is required.`);
  }
  try {
    return safeGitRef(ref, field);
  } catch {
    throw badRequest(`${field} is not a safe git ref.`);
  }
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

function markdownInlineCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
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
    const context = await runWorkspaceContext(url, workspaceRoot, tenant, runId);
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
    admissionHeartbeat = startWorkspaceSessionAdmissionClaimHeartbeat(options, sessionAdmission.handle);
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

function projectWorkspaceSessionRoot(workspaceRoot: string, tenant: string, project: string): string {
  return join(workspaceRoot, tenant, project, ".loom", "sessions");
}

function runWorkspaceSessionRoot(workspaceRoot: string, tenant: string, project: string, runId: string): string {
  return join(workspaceRoot, tenant, project, ".loom", "runs", runId, "sessions");
}

function projectWorkspaceCommandRoot(workspaceRoot: string, tenant: string, project: string): string {
  return join(workspaceRoot, tenant, project, ".loom", "commands");
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

async function workspaceSessionHasActiveAdmissionClaim(
  options: HarnessServerOptions,
  summary: WorkspaceSessionSummary,
): Promise<boolean> {
  const claims = await Promise.all([
    readWorkspaceSessionAdmissionClaim(workspaceSessionAdmissionClaimPath(options, summary)),
    readWorkspaceSessionAdmissionClaim(globalWorkspaceSessionAdmissionClaimPath(options, summary)),
  ]);
  return claims.some((claim) => workspaceSessionAdmissionClaimMatchesSummary(claim, summary));
}

function workspaceSessionAdmissionClaimMatchesSummary(
  claim: WorkspaceSessionAdmissionClaim | undefined,
  summary: WorkspaceSessionSummary,
): boolean {
  if (!claim || runAdmissionClaimIsStale(claim)) return false;
  return claim.sessionId === summary.sessionId
    && claim.tenant === summary.tenant
    && claim.project === summary.project
    && claim.route === summary.route
    && (claim.route === "project"
      ? summary.runId === undefined
      : claim.runId === summary.runId);
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

function optionalSessionEventString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalSessionEventNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function optionalSessionEventRole(value: unknown): boolean {
  return value === undefined || value === "admin" || value === "developer" || value === "viewer";
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
    await writeWorkspaceFile(req, res, await runWorkspaceContext(url, workspaceRoot, tenant, runId), { kind: "run", runId }, options, activeWorkspaces, appendAuditEvent, access, presence);
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
    await moveWorkspaceFile(req, res, await runWorkspaceContext(url, workspaceRoot, tenant, runId), { kind: "run", runId }, options, activeWorkspaces, appendAuditEvent, access, presence);
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
    await deleteWorkspaceFile(url, req, res, await runWorkspaceContext(url, workspaceRoot, tenant, runId), { kind: "run", runId }, options, activeWorkspaces, appendAuditEvent, access, presence);
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
    writeJson(res, 200, await workspaceInfo(await runWorkspaceContext(url, workspaceRoot, tenant, runId), { kind: "run", runId }, options));
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    throw error;
  }
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
    writeJson(res, 200, await workspaceDiff(await runWorkspaceContext(url, workspaceRoot, tenant, runId), options));
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
    await readWorkspaceFile(url, res, await runWorkspaceContext(url, workspaceRoot, tenant, runId), options);
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
    const { policy, policyChange } = await upsertTenantControlPlaneIdentity(workspaceRoot, tenant, controlPlaneIdentity);
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

async function upsertTenantControlPlaneIdentity(
  workspaceRoot: string,
  tenant: string,
  identity: TenantControlPlaneIdentity,
): Promise<{ policy: TenantPolicy; policyChange?: TenantPolicyChange }> {
  const existing = await readTenantPolicy(workspaceRoot, tenant);
  const current = existing?.controlPlaneIdentities ?? [];
  const controlPlaneIdentities: TenantControlPlaneIdentity[] = [];
  let replaced = false;
  for (const entry of current) {
    if (entry.provider === identity.provider && entry.externalActor === identity.externalActor) {
      if (!replaced) controlPlaneIdentities.push(identity);
      replaced = true;
    } else {
      controlPlaneIdentities.push(entry);
    }
  }
  if (!replaced) controlPlaneIdentities.push(identity);
  const policy = compactObject({
    ...(existing ?? { schemaVersion: 1 as const }),
    schemaVersion: 1 as const,
    controlPlaneIdentities,
  });
  const policyChange = tenantPolicyReplacementChange(existing, policy);
  if (policyChange) await writeTenantPolicy(workspaceRoot, tenant, policy);
  return { policy, policyChange };
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
  const tenantAuditEvents = await readTenantAuditEvents(workspaceRoot, tenant);
  const policyLimits = (await readTenantPolicy(workspaceRoot, tenant))?.limits;
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

async function tenantControlPlaneBackupManifest(
  workspaceRoot: string,
  tenant: string,
  options: HarnessServerOptions,
): Promise<TenantControlPlaneBackupManifest> {
  const policy = await readTenantPolicy(workspaceRoot, tenant);
  const auditEvents = await readTenantAuditEvents(workspaceRoot, tenant);
  const lastAudit = auditEvents[auditEvents.length - 1];
  const projectNames = await listTenantProjectNames(workspaceRoot, tenant);
  const tenantRoot = join(workspaceRoot, tenant);
  const projects = await Promise.all(projectNames.map(async (project) => ({
    project,
    summary: await readProjectSummary(tenantRoot, tenant, project, policy?.limits),
    runs: await tenantControlPlaneBackupRuns(workspaceRoot, tenant, project),
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
): Promise<TenantControlPlaneBackupRun[]> {
  try {
    const states = await readRunStatesForListing(join(workspaceRoot, tenant, project, ".loom", "runs"), tenant, project);
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
  writeJson(res, 200, await readProjectDetail(workspaceRoot, options, tenant, project, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, projectPresence, runPresence, await readTenantAuditEvents(workspaceRoot, tenant)));
  return true;
}

async function handleListVasLiteCases(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 6) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  const projectRoot = join(workspaceRoot, tenant, project);
  await requireVasLiteProject(workspaceRoot, tenant, project);
  const sourceDefaults = await readProjectSourceDefaults(join(workspaceRoot, tenant), project);
  const response: VasLiteCaseListResponse = {
    project,
    template: "vas-lite",
    cases: await listVasLiteCases(projectRoot, tenant, project, sourceDefaults),
  };
  writeJson(res, 200, response);
  return true;
}

async function handleListVasLiteReviewQueue(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 6) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "review-queue") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  const tenantRoot = join(workspaceRoot, tenant);
  const projectRoot = join(tenantRoot, project);
  await requireVasLiteProject(workspaceRoot, tenant, project, "vas-lite review queues require a vas-lite project template.");
  const sourceDefaults = await readProjectSourceDefaults(tenantRoot, project);
  const response: VasLiteReviewQueueResponse = {
    project,
    template: "vas-lite",
    cases: await listVasLiteReviewQueue(tenant, project, projectRoot, sourceDefaults),
  };
  writeJson(res, 200, response);
  return true;
}

async function handleListVasLiteLearnings(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 6) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "learnings") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  const projectRoot = join(workspaceRoot, tenant, project);
  await requireVasLiteProject(workspaceRoot, tenant, project, "vas-lite learnings require a vas-lite project template.");
  const response: VasLiteLearningListResponse = {
    project,
    template: "vas-lite",
    learnings: await listVasLiteLearnings(projectRoot),
  };
  writeJson(res, 200, response);
  return true;
}

async function handleReadVasLiteCaseArtifacts(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 8) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases" || segments[7] !== "artifacts") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  const caseId = requireSafeName(segments[6], "caseId");
  const projectRoot = join(workspaceRoot, tenant, project);
  await requireVasLiteProject(workspaceRoot, tenant, project, "vas-lite artifacts require a vas-lite project template.");
  await readVasLiteCase(projectRoot, caseId);
  const response: VasLiteCaseArtifactsResponse = await vasLiteCaseArtifacts(projectRoot, project, caseId);
  writeJson(res, 200, response);
  return true;
}

async function handleReadVasLiteCaseReviewPackage(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 8) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases" || segments[7] !== "review-package") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  const caseId = requireSafeName(segments[6], "caseId");
  const tenantRoot = join(workspaceRoot, tenant);
  const projectRoot = join(tenantRoot, project);
  await requireVasLiteProject(workspaceRoot, tenant, project, "vas-lite review packages require a vas-lite project template.");
  const record = await readVasLiteCase(projectRoot, caseId);
  const sourceDefaults = await readProjectSourceDefaults(tenantRoot, project);
  const auditTrail = vasLiteCaseTenantAuditTrail(await readTenantAuditEvents(workspaceRoot, tenant), project, caseId);
  const response = await vasLiteCaseReviewPackage(projectRoot, tenant, project, caseId, record, sourceDefaults, auditTrail);
  writeJson(res, 200, response);
  return true;
}

async function handleListVasLiteCaseRuns(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 8) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases" || segments[7] !== "runs") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  const caseId = requireSafeName(segments[6], "caseId");
  const projectRoot = join(workspaceRoot, tenant, project);
  await requireVasLiteProject(workspaceRoot, tenant, project, "vas-lite case runs require a vas-lite project template.");
  const record = await readVasLiteCase(projectRoot, caseId);
  const sourceDefaults = await readProjectSourceDefaults(join(workspaceRoot, tenant), project);
  const caseSummary = vasLiteCaseSummary(caseId, record, undefined, sourceDefaults);
  const response: VasLiteCaseRunListResponse = {
    project,
    template: "vas-lite",
    caseId,
    repo: caseSummary.repo,
    branch: caseSummary.branch,
    baseBranch: caseSummary.baseBranch,
    issue: caseSummary.issue,
    sourceDefaultFields: caseSummary.sourceDefaultFields,
    runs: await vasLiteCaseRunSummaries(projectRoot, tenant, project, caseId, record),
  };
  writeJson(res, 200, response);
  return true;
}

async function handleCreateVasLiteCase(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 6) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const project = requireSafeName(segments[3], "project");
  const body = await readVasCaseCreateJson(req);
  const caseId = requireSafeName(body.caseId, "caseId");
  const title = optionalString(body.title, "title");
  const source = vasLiteCaseSource(body.source);
  const clientId = optionalClientId(body.clientId);
  const projectRoot = join(workspaceRoot, tenant, project);
  await requireVasLiteProject(workspaceRoot, tenant, project);
  const projectSourceDefaults = await readProjectSourceDefaults(join(resolve(workspaceRoot), tenant), project);
  const repo = optionalSourceRepo(body.repo) ?? projectSourceDefaults.repo;
  const branch = optionalSourceGitRef(body.branch, "branch", projectSourceDefaults.branch);
  const baseBranch = optionalSourceGitRef(body.baseBranch, "baseBranch", projectSourceDefaults.baseBranch);
  const issue = optionalSourceIssue(body.issue, projectSourceDefaults.issue);

  const caseDir = join(projectRoot, "cases", caseId);
  const casePath = join(caseDir, "case.json");
  try {
    await readFile(casePath, "utf8");
    throw conflict(`vas-lite case already exists: ${caseId}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  await mkdir(join(caseDir, "frames"), { recursive: true });
  await mkdir(join(caseDir, "reconstruction"), { recursive: true });
  const record = vasLiteCaseRecord(caseId, title, source, { repo, branch, baseBranch, issue });
  await writeJsonFileAtomic(casePath, record);
  const summary = vasLiteCaseSummary(caseId, record);
  await appendAuditEvent(tenant, "vas_case_created", compactObject({
    project,
    caseId,
    repo,
    branch,
    baseBranch,
    issue,
    clientId,
  }), access);
  writeJson(res, 201, summary);
  return true;
}

async function handleReviewVasLiteCase(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 8) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases" || segments[7] !== "review") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const project = requireSafeName(segments[3], "project");
  const caseId = requireSafeName(segments[6], "caseId");
  const body = await readVasCaseReviewJson(req);
  const clientId = optionalClientId(body.clientId);
  const decision = vasLiteCaseReviewDecision(body.decision);
  const summary = await reviewVasLiteCase(
    workspaceRoot,
    options,
    tenant,
    project,
    caseId,
    decision,
    body,
    access,
    clientId,
    appendAuditEvent,
  );
  writeJson(res, 200, summary);
  return true;
}

async function handleClaimVasLiteCase(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 8) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases" || segments[7] !== "claim") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const project = requireSafeName(segments[3], "project");
  const caseId = requireSafeName(segments[6], "caseId");
  const body = await readVasCaseClaimJson(req);
  const clientId = optionalClientId(body.clientId);
  const action = vasLiteCaseClaimAction(body.action);
  const summary = await claimVasLiteCase(workspaceRoot, tenant, project, caseId, action, access, clientId, appendAuditEvent);
  writeJson(res, 200, summary);
  return true;
}

async function handleCreateVasLiteCaseReviewRun(
  url: URL,
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
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 8) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases" || segments[7] !== "review-runs") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const project = requireSafeName(segments[3], "project");
  const caseId = requireSafeName(segments[6], "caseId");
  const body = await readVasCaseReviewRunJson(req);
  const projectRoot = join(workspaceRoot, tenant, project);
  await requireVasLiteProject(workspaceRoot, tenant, project, "vas-lite review runs require a vas-lite project template.");
  const record = await readVasLiteCase(projectRoot, caseId);

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
      preset: VAS_LITE_REVIEW_PRESET,
      presetInput: { caseId },
      async: true,
      queue: true,
      script: body.script,
      agentCommand: body.agentCommand,
      model: body.model,
      modelProtocol: body.modelProtocol,
      repo: vasLiteCaseRunMetadataDefault(body.repo, record, "repo"),
      branch: vasLiteCaseRunMetadataDefault(body.branch, record, "branch"),
      baseBranch: vasLiteCaseRunMetadataDefault(body.baseBranch, record, "baseBranch"),
      issue: vasLiteCaseRunMetadataDefault(body.issue, record, "issue"),
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
  );
  writeJson(res, 202, status);
  return true;
}

async function reviewVasLiteCase(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenant: string,
  project: string,
  caseId: string,
  decision: VasCaseReviewDecision,
  body: VasCaseReviewRequestBody,
  access: TenantAccess | undefined,
  clientId: string | undefined,
  appendAuditEvent: TenantAuditAppender,
): Promise<VasLiteCaseSummary> {
  const runId = optionalSafeName(body.runId, "runId");
  const projectRoot = join(workspaceRoot, tenant, project);
  await requireVasLiteProject(workspaceRoot, tenant, project);
  if (runId) await requireVasLiteReviewRunForCase(projectRoot, caseId, runId);
  const effectiveBody = vasLiteCaseReviewBodyWithDraft(
    body,
    runId ? await readVasLiteReviewDraft(projectRoot, caseId) : undefined,
  );

  const reviewed = vasLiteCaseReviewedRecord(await readVasLiteCase(projectRoot, caseId), decision, effectiveBody, access, clientId, runId);
  await writeJsonFileAtomic(join(projectRoot, "cases", caseId, "case.json"), reviewed);
  if (decision === "approved") {
    const learnings = textArray(effectiveBody.learnings, "learnings");
    await appendVasLiteLearnedPatterns(projectRoot, caseId, learnings, access, clientId, runId);
    await ingestVasLiteLearningSignal(options, appendAuditEvent, tenant, project, caseId, reviewed, learnings, access, clientId, runId);
  }
  const summary = vasLiteCaseSummary(caseId, reviewed);
  await appendAuditEvent(tenant, "vas_case_reviewed", compactObject({
    project,
    caseId,
    decision,
    status: summary.status,
    runId,
    clientId,
  }), access);
  if (decision === "approved") {
    await projectVasLiteLearningsToAgentGitServiceWikiMemory(
      workspaceRoot,
      options,
      appendAuditEvent,
      tenant,
      project,
      caseId,
      reviewed,
      textArray(effectiveBody.learnings, "learnings"),
      access,
      clientId,
      runId,
    );
  }
  return summary;
}

async function ingestVasLiteLearningSignal(
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  caseId: string,
  record: Record<string, unknown>,
  learnings: string[],
  access: TenantAccess | undefined,
  clientId: string | undefined,
  runId: string | undefined,
): Promise<void> {
  if (!options.brainSignalIngest || learnings.length === 0) return;
  const reviews = recordArray(record.reviews, "reviews");
  const latestReview = reviews[reviews.length - 1] ?? {};
  const ts = stringField(latestReview, "reviewedAt") ?? new Date().toISOString();
  const issue = stringField(record, "issue");
  const summaryUrl = options.publicUrl && runId ? runUrl(options.publicUrl, tenant, project, runId) : undefined;
  const signal: RunSignal = compactObject({
    ts,
    project,
    runId,
    status: "reviewed",
    issue,
    issueUrl: issue ? controlPlaneIssueUrl(options, issue) : undefined,
    dashboardUrl: options.publicUrl && runId ? runDashboardUrl(options.publicUrl, tenant, project, runId) : undefined,
    summaryUrl,
    reviewSummaryUrl: summaryUrl ? runEvidenceUrl(summaryUrl, "review-summary") : undefined,
    handoffPackageUrl: summaryUrl ? runEvidenceUrl(summaryUrl, "handoff-package") : undefined,
    handoffFollowupsUrl: summaryUrl ? runEvidenceUrl(summaryUrl, "handoff-runs") : undefined,
    skills: ["vas-lite", "coding"],
    outcome: "pass" as const,
    notes: vasLiteLearningSignalNotes(caseId, learnings),
  });
  await options.brainSignalIngest(signal);
  await appendAuditEvent(tenant, "brain_signal_ingested", compactObject({
    source: "vas_learning",
    project,
    caseId,
    runId,
    status: "reviewed",
    issue: signal.issue,
    issueUrl: signal.issueUrl,
    dashboardUrl: signal.dashboardUrl,
    summaryUrl: signal.summaryUrl,
    reviewSummaryUrl: signal.reviewSummaryUrl,
    handoffPackageUrl: signal.handoffPackageUrl,
    handoffFollowupsUrl: signal.handoffFollowupsUrl,
    outcome: signal.outcome,
    learningCount: learnings.length,
    skillCount: signal.skills.length,
    clientId,
  }), access);
}

const AGENT_GIT_SERVICE_VAS_LEARNINGS_PAGE = "vas/learnings";

async function projectVasLiteLearningsToAgentGitServiceWikiMemory(
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  caseId: string,
  record: Record<string, unknown>,
  learnings: string[],
  access: TenantAccess | undefined,
  clientId: string | undefined,
  runId: string | undefined,
): Promise<void> {
  if (controlPlaneProviderName(options) !== "agent-git-service" || learnings.length === 0) return;
  const baseUrl = options.controlPlaneBaseUrl?.trim();
  const token = options.controlPlaneAdminToken?.trim();
  if (!baseUrl || !token) return;
  const repo = stringField(record, "repo") ?? (await readProjectSourceDefaults(join(workspaceRoot, tenant), project)).repo;
  if (!repo) return;
  const readWikiMemory = options.agentGitServiceReadWikiMemory ?? readAgentGitServiceWikiMemory;
  const updateWikiMemory = options.agentGitServiceUpdateWikiMemory ?? updateAgentGitServiceWikiMemory;
  try {
    const current = await readWikiMemory({
      baseUrl,
      token,
      repo,
      page: AGENT_GIT_SERVICE_VAS_LEARNINGS_PAGE,
    });
    const updated = await updateWikiMemory({
      baseUrl,
      token,
      repo,
      page: AGENT_GIT_SERVICE_VAS_LEARNINGS_PAGE,
      body: agentGitServiceVasLearningMemoryBody(current.body, caseId, learnings, access, clientId, runId),
      message: `Record Loom VAS learning for ${project}/${caseId}`,
    });
    await appendAuditEvent(tenant, "agent_git_service_wiki_memory_updated", compactObject({
      provider: "agent-git-service",
      project,
      caseId,
      repo,
      page: updated.page,
      sha: updated.sha,
      url: updated.url,
      learningCount: learnings.length,
      clientId,
    }), access);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendAuditEvent(tenant, "agent_git_service_wiki_memory_failed", compactObject({
      provider: "agent-git-service",
      project,
      caseId,
      repo,
      page: AGENT_GIT_SERVICE_VAS_LEARNINGS_PAGE,
      learningCount: learnings.length,
      error: message,
      clientId,
    }), access);
  }
}

function agentGitServiceVasLearningMemoryBody(
  currentBody: string,
  caseId: string,
  learnings: string[],
  access: TenantAccess | undefined,
  clientId: string | undefined,
  runId: string | undefined,
): string {
  const header = "## Loom VAS learnings";
  const normalized = currentBody.endsWith("\n") || currentBody.length === 0 ? currentBody : `${currentBody}\n`;
  const prefix = normalized.includes(header)
    ? ""
    : `${normalized.length ? "\n" : ""}${header}\n\n`;
  const metadata = [
    `case=${caseId}`,
    runId ? `run=${runId}` : "",
    access?.actor ? `reviewedBy=${access.actor}` : "",
    access?.role ? `role=${access.role}` : "",
    clientId ? `clientId=${clientId}` : "",
  ].filter(Boolean).join(" ");
  const lines = learnings.map((learning) => `- ${metadata} :: ${oneLineText(learning)}`);
  return normalized + prefix + lines.join("\n") + "\n";
}

function vasLiteLearningSignalNotes(caseId: string, learnings: string[]): string {
  const text = learnings.map(oneLineText).join("; ");
  const bounded = text.length > 220 ? `${text.slice(0, 217)}...` : text;
  return `VAS learning approved for case ${caseId}: ${bounded}`;
}

async function claimVasLiteCase(
  workspaceRoot: string,
  tenant: string,
  project: string,
  caseId: string,
  action: VasCaseClaimAction,
  access: TenantAccess | undefined,
  clientId: string | undefined,
  appendAuditEvent: TenantAuditAppender,
): Promise<VasLiteCaseSummary> {
  const tenantRoot = join(workspaceRoot, tenant);
  const projectRoot = join(tenantRoot, project);
  await requireVasLiteProject(workspaceRoot, tenant, project);
  const record = await readVasLiteCase(projectRoot, caseId);
  const previousClaim = record.claim;
  const next = { ...record };
  let claim: VasLiteCaseClaim | undefined;
  if (action === "claim") {
    claim = compactObject({
      actor: access?.actor,
      role: access?.role,
      clientId,
      claimedAt: new Date().toISOString(),
    });
    next.claim = claim;
  } else {
    delete next.claim;
  }
  await writeJsonFileAtomic(join(projectRoot, "cases", caseId, "case.json"), next);
  const sourceDefaults = await readProjectSourceDefaults(tenantRoot, project);
  const runLinks = await vasLiteCaseRunLinks(projectRoot, tenant, project);
  const summary = vasLiteCaseSummary(caseId, next, runLinks.get(caseId), sourceDefaults);
  await appendAuditEvent(tenant, "vas_case_claimed", compactObject({
    project,
    caseId,
    action: action === "claim" ? "claimed" : "released",
    claimedAt: claim?.claimedAt,
    clientId,
    previousClaim,
  }), access);
  return summary;
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
    const states = await readRunStatesForListing(runsRoot, tenant, project);
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
    const claim = await claimRunCreateRequestRecord(runRoot, runCreateRequestRecord);
    if (!claim.created) {
      writeJson(res, claim.replay.statusCode, claim.replay.body);
      return;
    }
    runCreateRequestRecord = claim.record;
    runCreateRequestRecordOwned = true;
  }
  const releaseRunCreateRequestRecord = async () => {
    if (runCreateRequestRecordOwned) await deleteRunCreateRequestRecord(runRoot, runCreateRequestRecord);
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
        const status = await queueAsyncRun({ queuedRuns, appendAuditEvent, run, admission: queuedAdmissionProjectActiveWorkspace(activeRunId), statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: initialIssueComments.events, snapshotBody, syncIssueComments, issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
      await writeRunCreateRequestRecord(runRoot, runCreateRequestRecord);
      writeJson(res, 202, status);
      return;
    }
    await releaseRunCreateRequestRecord();
    throw conflict(`tenant project already has an active run: ${activeRunId}`);
  }
	  const persistedRunId = await findBlockingPersistedRunningRun(options, runRoot);
  if (persistedRunId) {
    if (queueRequested) {
      const status = await queueAsyncRun({ queuedRuns, appendAuditEvent, run, admission: queuedAdmissionPersistedRunningRun(persistedRunId), statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: initialIssueComments.events, snapshotBody, syncIssueComments, issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
      await writeRunCreateRequestRecord(runRoot, runCreateRequestRecord);
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
      const status = await queueAsyncRun({ queuedRuns, appendAuditEvent, run, admission: queuedAdmissionTenantActiveRunLimit(tenantRunIds, tenantRunLimit), statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: initialIssueComments.events, snapshotBody, syncIssueComments, issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
      await writeRunCreateRequestRecord(runRoot, runCreateRequestRecord);
      writeJson(res, 202, status);
      return;
    }
    await releaseRunCreateRequestRecord();
    throw conflict("active run tenant limit reached");
  }

  const admissionClaim = await tryAcquireActiveRunAdmission(options, run, tenantRunLimit);
  if (!admissionClaim.ok) {
    if (queueRequested) {
      const status = await queueAsyncRun({ queuedRuns, appendAuditEvent, run, admission: admissionClaim.admission, statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: initialIssueComments.events, snapshotBody, syncIssueComments, issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
      await writeRunCreateRequestRecord(runRoot, runCreateRequestRecord);
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
      await appendInitialRunEvents(runDir, initialIssueComments.events);
      await writeQueuedRunSnapshot(runDir, snapshotBody, requester);
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
    await writeRunCreateRequestRecord(runRoot, runCreateRequestRecord);
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
  const stopAdmissionHeartbeat = startRunAdmissionClaimHeartbeat(options, admissionClaim.handle);
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await appendInitialRunEvents(runDir, initialIssueComments.events);
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
    await writeRunCreateRequestRecord(runRoot, runCreateRequestRecord);
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
      return queueAsyncRun({ queuedRuns, appendAuditEvent, run, admission: queuedAdmissionProjectActiveWorkspace(activeRunId), statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: runInitialEvents, snapshotBody, syncIssueComments, issue: runSource.issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
    }
    throw conflict(`tenant project already has an active run: ${activeRunId}`);
  }
	  const persistedRunId = await findBlockingPersistedRunningRun(options, runRoot);
  if (persistedRunId) {
    if (queueRequested) {
      return queueAsyncRun({ queuedRuns, appendAuditEvent, run, admission: queuedAdmissionPersistedRunningRun(persistedRunId), statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: runInitialEvents, snapshotBody, syncIssueComments, issue: runSource.issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
    }
    throw conflict(`tenant project already has an active run: ${persistedRunId}`);
  }
  const tenantRunLimit = await effectiveTenantActiveRunLimit(options, tenant);
  const tenantRunIds = tenantRunLimit !== undefined ? activeTenantRunIds(activeRunSlots, tenant) : [];
  if (tenantRunLimit !== undefined && tenantRunIds.length >= tenantRunLimit) {
    if (!queueRequested) throw conflict("active run tenant limit reached");
    return queueAsyncRun({ queuedRuns, appendAuditEvent, run, admission: queuedAdmissionTenantActiveRunLimit(tenantRunIds, tenantRunLimit), statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: runInitialEvents, snapshotBody, syncIssueComments, issue: runSource.issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
  }

  const admissionClaim = await tryAcquireActiveRunAdmission(options, run, tenantRunLimit);
  if (!admissionClaim.ok) {
    if (!queueRequested) throw admissionClaim.error;
    return queueAsyncRun({ queuedRuns, appendAuditEvent, run, admission: admissionClaim.admission, statusInput: { tenant, project, runId, goal, metadata, requester, runDir }, runDir, initialEvents: runInitialEvents, snapshotBody, syncIssueComments, issue: runSource.issue, issueUrl: metadata.issueUrl, initialIssueComments, preset, presetInput, projectRunPolicy: projectRunPolicy.evidence, projectContract, projectContractStatus, clientId, access });
  }
  let claimOwnedByRun = false;
  try {
    await mkdir(runDir, { recursive: true });
    await appendInitialRunEvents(runDir, runInitialEvents);
    await writeQueuedRunSnapshot(runDir, snapshotBody, requester);
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
  await appendInitialRunEvents(input.runDir, input.initialEvents);
  await writeQueuedRunSnapshot(input.runDir, input.snapshotBody, requester);
  await writeRunStatus(input.runDir, status);
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

function queuedAdmissionAuditData(admission: QueuedRunAdmission): Record<string, unknown> {
  return compactObject({
    blockedReason: admission.blockedReason,
    blockedByRunIds: admission.blockedByRunIds,
    limit: admission.limit,
    concurrency: admission.concurrency,
    activeTenantRunCount: admission.concurrency.activeTenantRunCount,
    tenantActiveRunLimit: admission.concurrency.tenantActiveRunLimit,
    projectActiveRunId: admission.concurrency.projectActiveRunId,
    persistedRunId: admission.concurrency.persistedRunId,
  });
}

async function appendInitialRunEvents(runDir: string, events: InitialRunEvent[]): Promise<void> {
  for (const event of events) {
    await appendRunEvent(runDir, event.type, event.data);
  }
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

async function requireVasLiteProject(workspaceRoot: string, tenant: string, project: string, message = "vas-lite cases require a vas-lite project template."): Promise<void> {
  const metadata = await requireProjectMetadata(workspaceRoot, tenant, project);
  if (metadata?.template !== "vas-lite") {
    throw badRequest(message);
  }
}

async function runSkillsForRequest(workspaceRoot: string, tenant: string, project: string, body: RunRequestBody): Promise<string[]> {
  if (body.skills !== undefined) return stringArray(body.skills, "skills");

  const metadata = await readProjectTemplateMetadata(join(workspaceRoot, tenant, project), { tenant, project });
  if (metadata) return projectMetadataDefaultSkills(metadata);
  return [];
}

function hasRequestValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function hasExplicitAgent(body: RunRequestBody): boolean {
  return body.script !== undefined || body.agentCommand !== undefined || body.model !== undefined;
}

function vasLiteReviewPresetInput(value: unknown): VasLiteReviewPresetInput {
  if (value === undefined || value === null || value === "") return { caseId: "bootstrap" };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("presetInput must be an object.");
  }
  const input = value as Record<string, unknown>;
  return {
    caseId: optionalSafeName(input.caseId, "presetInput.caseId") ?? "bootstrap",
  };
}

async function readVasLiteCase(projectRoot: string, caseId: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(join(projectRoot, "cases", caseId, "case.json"), "utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    throw badRequest(`vas-lite case ${caseId} must be an object.`);
  } catch (error) {
    if (isNotFound(error)) throw badRequest(`vas-lite case not found: ${caseId}.`);
    if (error instanceof SyntaxError) throw badRequest(`vas-lite case ${caseId} has invalid JSON.`);
    throw error;
  }
}

async function listVasLiteCases(projectRoot: string, tenant: string, project: string, sourceDefaults: ProjectSourceDefaultValues = {}): Promise<VasLiteCaseSummary[]> {
  let entries;
  try {
    entries = await readdir(join(projectRoot, "cases"), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const runLinks = await vasLiteCaseRunLinks(projectRoot, tenant, project);
  const cases = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isSafeDirectoryName(entry.name))
      .map(async (entry) => {
        const record = await readVasLiteCaseForScan(projectRoot, entry.name);
        return record ? vasLiteCaseSummary(entry.name, record, runLinks.get(entry.name), sourceDefaults) : undefined;
      }),
  );
  const readable = cases.filter((item): item is VasLiteCaseSummary => item !== undefined);
  readable.sort((a, b) => a.id.localeCompare(b.id));
  return readable;
}

async function listVasLiteReviewQueue(
  tenant: string,
  project: string,
  projectRoot: string,
  sourceDefaults: ProjectSourceDefaultValues = {},
): Promise<VasLiteReviewQueueItem[]> {
  const cases = await listVasLiteCases(projectRoot, tenant, project, sourceDefaults);
  return cases.flatMap((item) => {
    const reasons = vasLiteReviewQueueReasons(item);
    if (!reasons.length) return [];
    const basePath = `/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/vas/cases/${encodeURIComponent(item.id)}`;
    return [{
      ...item,
      reasons,
      links: {
        reviewPackage: `${basePath}/review-package`,
        runs: `${basePath}/runs`,
        artifacts: `${basePath}/artifacts`,
        review: `${basePath}/review`,
        reviewRuns: `${basePath}/review-runs`,
      },
    }];
  });
}

function vasLiteReviewQueueReasons(item: VasLiteCaseSummary): VasLiteReviewQueueReason[] {
  const reasons: VasLiteReviewQueueReason[] = [];
  if ((item.unreviewedRunCount ?? 0) > 0) reasons.push("unreviewed_run");
  if (item.status === "needs_review") reasons.push("needs_review");
  if (item.status === "needs_revision") reasons.push("needs_revision");
  return reasons;
}

async function vasLiteCaseRunLinks(projectRoot: string, tenant: string, project: string): Promise<Map<string, VasLiteCaseRunLink>> {
  const links = new Map<string, VasLiteCaseRunLink>();
  for (const { caseId, state } of await vasLiteRunStates(projectRoot, tenant, project)) {
    const current = links.get(caseId);
    if (current) {
      current.runCount += 1;
      current.runIds.push(state.runId);
      continue;
    }
    links.set(caseId, {
      runCount: 1,
      runIds: [state.runId],
      latestRunId: state.runId,
      latestRunStatus: state.status,
      latestRunStartedAt: startedAt(state),
    });
  }
  return links;
}

async function vasLiteRunStates(projectRoot: string, tenant: string, project: string): Promise<VasLiteRunState[]> {
  let states: ReadableRunState[];
  const runsRoot = join(projectRoot, ".loom", "runs");
  try {
    states = await readRunStatesForListing(runsRoot, tenant, project);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return states
    .flatMap((state) => {
      const caseId = vasLiteRunCaseId(state);
      return caseId ? [{ caseId, state }] : [];
    })
    .sort((a, b) => startedAt(b.state).localeCompare(startedAt(a.state)));
}

async function listVasLiteLearnings(projectRoot: string): Promise<VasLiteLearningSummary[]> {
  let entries;
  try {
    entries = await readdir(join(projectRoot, "cases"), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const cases = entries
    .filter((entry) => entry.isDirectory() && isSafeDirectoryName(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const learnings: VasLiteLearningSummary[] = [];
  for (const entry of cases) {
    const record = await readVasLiteCaseForScan(projectRoot, entry.name);
    if (record) learnings.push(...vasLiteLearningSummaries(entry.name, record));
  }
  return learnings;
}

async function readVasLiteCaseForScan(projectRoot: string, caseId: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await readVasLiteCase(projectRoot, caseId);
  } catch (error) {
    if (error instanceof Error && error.name === "BadRequest") return undefined;
    throw error;
  }
}

function vasLiteCaseSummary(
  caseId: string,
  record: Record<string, unknown>,
  runLink?: VasLiteCaseRunLink,
  sourceDefaults: ProjectSourceDefaultValues = {},
): VasLiteCaseSummary {
  const repo = stringField(record, "repo");
  const branch = stringField(record, "branch");
  const baseBranch = stringField(record, "baseBranch");
  const issue = stringField(record, "issue");
  const sourceDefaultFields = vasLiteCaseSourceDefaultFields(record, sourceDefaults);
  return compactObject({
    id: caseId,
    status: typeof record.status === "string" ? record.status : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
    source: record.source,
    repo: repo ?? sourceDefaults.repo,
    branch: branch ?? sourceDefaults.branch,
    baseBranch: baseBranch ?? sourceDefaults.baseBranch,
    issue: issue ?? sourceDefaults.issue,
    sourceDefaultFields: sourceDefaultFields.length ? sourceDefaultFields : undefined,
    path: `cases/${caseId}/case.json`,
    reportPath: `cases/${caseId}/reports/latest.md`,
    reviewCount: arrayCount(record.reviews),
    correctionCount: arrayCount(record.corrections),
    learningCount: arrayCount(record.learnings),
    runCount: runLink?.runCount,
    ...vasLiteCaseRunReviewCoverage(record, runLink),
    latestRunId: runLink?.latestRunId,
    latestRunStatus: runLink?.latestRunStatus,
    latestRunStartedAt: runLink?.latestRunStartedAt,
    claim: vasLiteCaseClaim(record.claim),
  });
}

function vasLiteCaseClaim(value: unknown): VasLiteCaseClaim | undefined {
  const data = recordData(value);
  const claimedAt = stringField(data, "claimedAt");
  if (!claimedAt) return undefined;
  return compactObject({
    actor: stringField(data, "actor"),
    role: tenantRoleField(data, "role"),
    clientId: stringField(data, "clientId"),
    claimedAt,
  });
}

function vasLiteCaseSourceDefaultFields(
  record: Record<string, unknown>,
  sourceDefaults: ProjectSourceDefaultValues,
): Array<"repo" | "branch" | "baseBranch" | "issue"> {
  const fields: Array<"repo" | "branch" | "baseBranch" | "issue"> = [];
  for (const field of ["repo", "branch", "baseBranch", "issue"] as const) {
    if (stringField(record, field) === undefined && sourceDefaults[field] !== undefined) fields.push(field);
  }
  return fields;
}

function vasLiteCaseRunReviewCoverage(
  record: Record<string, unknown>,
  runLink?: VasLiteCaseRunLink,
): Pick<VasLiteCaseSummary, "reviewedRunCount" | "unreviewedRunCount" | "latestRunReviewDecision" | "latestRunReviewedAt"> {
  if (!runLink) return {};
  const runIds = new Set(runLink.runIds);
  const reviews = [...vasLiteCaseRunReviewMap(record).entries()]
    .filter(([runId]) => runIds.has(runId))
    .map(([runId, review]) => ({ runId, ...review }));
  const reviewedRunIds = new Set(reviews.map((review) => review.runId));
  const latestRunReview = reviews
    .filter((review) => review.runId === runLink.latestRunId)
    .sort((a, b) => (b.reviewedAt ?? "").localeCompare(a.reviewedAt ?? ""))[0];
  return compactObject({
    reviewedRunCount: reviewedRunIds.size,
    unreviewedRunCount: Math.max(0, runLink.runCount - reviewedRunIds.size),
    latestRunReviewDecision: latestRunReview?.decision,
    latestRunReviewedAt: latestRunReview?.reviewedAt,
  });
}

function vasLiteRunCaseId(state: ReadableRunState): string | undefined {
  if (state.metadata?.runPreset !== VAS_LITE_REVIEW_PRESET) return undefined;
  const caseId = stringField(recordData(state.metadata.runPresetInput), "caseId")?.trim();
  return caseId || "bootstrap";
}

async function requireVasLiteReviewRunForCase(projectRoot: string, caseId: string, runId: string): Promise<void> {
  let state: ReadableRunState;
  try {
    state = await readRunState(join(projectRoot, ".loom", "runs", runId));
  } catch (error) {
    if (isNotFound(error)) throw badRequest(`runId not found for vas-lite review: ${runId}.`);
    throw error;
  }
  const runCaseId = vasLiteRunCaseId(state);
  if (runCaseId !== caseId) {
    throw badRequest(`runId must reference a vas-lite-review run for case ${caseId}.`);
  }
}

async function vasLiteCaseRunSummaries(projectRoot: string, tenant: string, project: string, caseId: string, record: Record<string, unknown>): Promise<VasLiteCaseRunSummary[]> {
  const reviews = vasLiteCaseRunReviewMap(record);
  return Promise.all(
    (await vasLiteRunStates(projectRoot, tenant, project))
      .filter((entry) => entry.caseId === caseId)
      .map(async ({ state }) => {
        const review = reviews.get(state.runId);
        const artifacts = await vasLiteRunArtifactEvidence(projectRoot, state.runId, caseId);
        const failureKind = isRunSummaryState(state) ? brainSignalFailureKind(state) : undefined;
        return compactObject({
          runId: state.runId,
          status: state.status,
          goal: state.goal,
          startedAt: startedAt(state),
          endedAt: "endedAt" in state ? state.endedAt : undefined,
          agentMode: state.metadata?.agentMode,
          model: state.metadata?.model,
          issue: state.metadata?.issue,
          issueUrl: state.metadata?.issueUrl,
          summaryUrl: state.metadata?.summaryUrl,
          reviewSummaryUrl: runEvidencePath(tenant, project, state.runId, "review-summary"),
          handoffPackageUrl: runEvidencePath(tenant, project, state.runId, "handoff-package"),
          pullRequestIndex: state.metadata?.pullRequestIndex,
          pullRequestUrl: state.metadata?.pullRequestUrl,
          reviewGateStatus: "review" in state ? state.review?.status : undefined,
          deploymentGateStatus: "deployment" in state ? state.deployment?.status : undefined,
          failureKind,
          reviewerFocus: failureKind ? reviewerFocusForFailureKind(failureKind) : undefined,
          error: "error" in state ? publicRunErrorSummary(state.error) : undefined,
          ...artifacts,
          runPresetInput: state.metadata?.runPresetInput,
          reviewStatus: review ? "reviewed" as const : "unreviewed" as const,
          reviewDecision: review?.decision,
          reviewedAt: review?.reviewedAt,
          reviewedBy: review?.actor,
          reviewedRole: review?.role,
          reviewedClientId: review?.clientId,
        });
      }),
  );
}

async function vasLiteRunArtifactEvidence(
  projectRoot: string,
  runId: string,
  caseId: string,
): Promise<Pick<VasLiteCaseRunSummary, "contextPath" | "reportPath" | "reviewDraftPath" | "contextWritten" | "reportWritten" | "reviewDraftWritten">> {
  const contextPath = vasLiteReviewContextPath(caseId);
  const reportPath = vasLiteReviewReportPath(caseId);
  const reviewDraftPath = vasLiteReviewDraftPath(caseId);
  const writtenPaths = await vasLiteRunWrittenFilePaths(join(projectRoot, ".loom", "runs", runId));
  return {
    contextPath,
    reportPath,
    reviewDraftPath,
    contextWritten: writtenPaths.has(contextPath),
    reportWritten: writtenPaths.has(reportPath),
    reviewDraftWritten: writtenPaths.has(reviewDraftPath),
  };
}

async function vasLiteRunWrittenFilePaths(runDir: string): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const event of await readRunEventsIfPresent(runDir)) {
    if (event.type !== "action") continue;
    const action = recordData(event.data);
    if (stringField(action, "toolName") !== "file.write") continue;
    const path = stringField(recordData(action.input), "path")?.trim();
    if (path) paths.add(normalizeVasLiteArtifactPath(path));
  }
  return paths;
}

function normalizeVasLiteArtifactPath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/"));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function vasLiteCaseRunReviewMap(record: Record<string, unknown>): Map<string, { decision?: VasCaseReviewDecision; reviewedAt?: string; actor?: string; role?: TenantRole; clientId?: string }> {
  const reviews = new Map<string, { decision?: VasCaseReviewDecision; reviewedAt?: string; actor?: string; role?: TenantRole; clientId?: string }>();
  for (const entry of recordArray(record.reviews, "reviews")) {
    const runId = stringField(entry, "runId");
    if (!runId) continue;
    const review = compactObject({
      decision: vasLiteCaseReviewDecisionField(entry, "decision"),
      reviewedAt: stringField(entry, "reviewedAt"),
      actor: stringField(entry, "actor"),
      role: tenantRoleField(entry, "role"),
      clientId: stringField(entry, "clientId"),
    });
    const previous = reviews.get(runId);
    if (!previous || (review.reviewedAt ?? "") >= (previous.reviewedAt ?? "")) {
      reviews.set(runId, review);
    }
  }
  return reviews;
}

function vasLiteLearningSummaries(caseId: string, record: Record<string, unknown>): VasLiteLearningSummary[] {
  return recordArray(record.learnings, "learnings").flatMap((entry) => {
    const text = stringField(entry, "text")?.trim();
    if (!text) return [];
    return [compactObject({
      caseId,
      text,
      source: stringField(entry, "source"),
      reviewDecision: vasLiteCaseReviewDecisionField(entry, "reviewDecision"),
      reviewedAt: stringField(entry, "reviewedAt"),
      actor: stringField(entry, "actor"),
      role: tenantRoleField(entry, "role"),
      clientId: stringField(entry, "clientId"),
      runId: stringField(entry, "runId"),
    })];
  });
}

function vasLiteReviewGuidance(record: Record<string, unknown>): VasLiteReviewGuidance {
  const reviews = latestVasLiteGuidanceItems(
    recordArray(record.reviews, "reviews").map(vasLiteReviewGuidanceReview),
  );
  const corrections = latestVasLiteGuidanceItems(
    recordArray(record.corrections, "corrections").flatMap(vasLiteReviewGuidanceText),
  );
  const learnings = latestVasLiteGuidanceItems(
    recordArray(record.learnings, "learnings").flatMap(vasLiteReviewGuidanceText),
  );
  return compactObject({
    reviewCount: arrayCount(record.reviews),
    correctionCount: arrayCount(record.corrections),
    learningCount: arrayCount(record.learnings),
    latestReview: reviews[0],
    recentReviews: reviews.length ? reviews : undefined,
    corrections: corrections.length ? corrections : undefined,
    learnings: learnings.length ? learnings : undefined,
  });
}

function vasLiteReviewGuidanceReview(entry: Record<string, unknown>): VasLiteReviewGuidanceReview {
  return compactObject({
    decision: vasLiteCaseReviewDecisionField(entry, "decision"),
    note: stringField(entry, "note"),
    reviewedAt: stringField(entry, "reviewedAt"),
    actor: stringField(entry, "actor"),
    role: tenantRoleField(entry, "role"),
    clientId: stringField(entry, "clientId"),
    runId: stringField(entry, "runId"),
  });
}

function vasLiteReviewGuidanceText(entry: Record<string, unknown>): VasLiteReviewGuidanceText[] {
  const text = stringField(entry, "text")?.trim();
  if (!text) return [];
  return [compactObject({
    text,
    source: stringField(entry, "source"),
    reviewDecision: vasLiteCaseReviewDecisionField(entry, "reviewDecision"),
    reviewedAt: stringField(entry, "reviewedAt"),
    actor: stringField(entry, "actor"),
    role: tenantRoleField(entry, "role"),
    clientId: stringField(entry, "clientId"),
    runId: stringField(entry, "runId"),
  })];
}

function latestVasLiteGuidanceItems<T>(items: T[]): T[] {
  return items.slice(-VAS_LITE_REVIEW_GUIDANCE_LIMIT).reverse();
}

async function vasLiteCaseArtifacts(projectRoot: string, project: string, caseId: string): Promise<VasLiteCaseArtifactsResponse> {
  const contextPath = vasLiteReviewContextPath(caseId);
  const reportPath = vasLiteReviewReportPath(caseId);
  const reviewDraftPath = vasLiteReviewDraftPath(caseId);
  return compactObject({
    project,
    template: "vas-lite" as const,
    caseId,
    contextPath,
    reportPath,
    reviewDraftPath,
    context: await readOptionalJsonObject(join(projectRoot, ...contextPath.split("/")), `${contextPath}`),
    report: await readOptionalTextFile(join(projectRoot, ...reportPath.split("/"))),
    reviewDraft: await readVasLiteReviewDraft(projectRoot, caseId),
  });
}

async function vasLiteCaseReviewPackage(
  projectRoot: string,
  tenant: string,
  project: string,
  caseId: string,
  record: Record<string, unknown>,
  sourceDefaults: ProjectSourceDefaultValues,
  auditTrail: TenantAuditEvent[],
): Promise<VasLiteCaseReviewPackageResponse> {
  const basePath = `/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/vas/cases/${encodeURIComponent(caseId)}`;
  const runLinks = await vasLiteCaseRunLinks(projectRoot, tenant, project);
  return {
    project,
    template: "vas-lite",
    caseId,
    case: vasLiteCaseSummary(caseId, record, runLinks.get(caseId), sourceDefaults),
    artifacts: await vasLiteCaseArtifacts(projectRoot, project, caseId),
    runs: await vasLiteCaseRunSummaries(projectRoot, tenant, project, caseId, record),
    reviews: recordArray(record.reviews, "reviews"),
    corrections: recordArray(record.corrections, "corrections"),
    learnings: vasLiteLearningSummaries(caseId, record),
    issueCommentSeeds: issueCommentSeedEvidence(auditTrail),
    auditTrail,
    links: {
      artifacts: `${basePath}/artifacts`,
      runs: `${basePath}/runs`,
      review: `${basePath}/review`,
      reviewRuns: `${basePath}/review-runs`,
    },
  };
}

async function readVasLiteReviewDraft(projectRoot: string, caseId: string): Promise<Record<string, unknown> | undefined> {
  const draftPath = vasLiteReviewDraftPath(caseId);
  const draft = await readOptionalJsonObject(join(projectRoot, ...draftPath.split("/")), draftPath);
  if (!draft) return undefined;
  const preset = stringField(draft, "preset");
  if (preset && preset !== VAS_LITE_REVIEW_PRESET) {
    throw badRequest(`${draftPath} preset must be ${VAS_LITE_REVIEW_PRESET}.`);
  }
  const draftCaseId = stringField(draft, "caseId")?.trim();
  if (draftCaseId && draftCaseId !== caseId) {
    throw badRequest(`${draftPath} caseId must match ${caseId}.`);
  }
  return draft;
}

function vasLiteCaseReviewBodyWithDraft(
  body: VasCaseReviewRequestBody,
  draft: Record<string, unknown> | undefined,
): VasCaseReviewRequestBody {
  if (!draft) return body;
  return {
    ...body,
    note: body.note === undefined ? draft.note : body.note,
    corrections: body.corrections === undefined ? draft.corrections : body.corrections,
    learnings: body.learnings === undefined ? draft.learnings : body.learnings,
  };
}

function vasLiteCaseRecord(
  caseId: string,
  title: string | undefined,
  source: Record<string, unknown>,
  metadata: Pick<VasLiteCaseSummary, "repo" | "branch" | "baseBranch" | "issue"> = {},
): Record<string, unknown> {
  return compactObject({
    id: caseId,
    title,
    status: "needs_review",
    source,
    repo: metadata.repo,
    branch: metadata.branch,
    baseBranch: metadata.baseBranch,
    issue: metadata.issue,
    artifacts: {
      frames: "frames/",
      reconstruction: "reconstruction/index.html",
    },
    states: [],
    events: [],
    beats: [],
    uncertainties: [],
    corrections: [],
    reviews: [],
    learnings: [],
  });
}

function vasLiteCaseRunMetadataDefault(value: unknown, record: Record<string, unknown>, key: "repo" | "branch" | "baseBranch" | "issue"): unknown {
  return hasRequestValue(value) ? value : stringField(record, key);
}

function vasLiteCaseReviewedRecord(
  record: Record<string, unknown>,
  decision: VasCaseReviewDecision,
  body: VasCaseReviewRequestBody,
  access: TenantAccess | undefined,
  clientId: string | undefined,
  runId: string | undefined,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const note = optionalString(body.note, "note");
  const corrections = textArray(body.corrections, "corrections");
  const learnings = textArray(body.learnings, "learnings");
  const context = compactObject({
    reviewedAt: now,
    actor: access?.actor,
    role: access?.role,
    clientId,
    runId,
    reviewDecision: decision,
  });
  const reviewEntry = compactObject({
    decision,
    note,
    reviewedAt: now,
    actor: access?.actor,
    role: access?.role,
    clientId,
    runId,
    corrections,
    learnings,
  });
  return {
    ...record,
    status: decision === "approved" ? "reviewed" : "needs_revision",
    reviews: [...recordArray(record.reviews, "reviews"), reviewEntry],
    corrections: [
      ...recordArray(record.corrections, "corrections"),
      ...corrections.map((text) => ({ ...context, text })),
    ],
    learnings: [
      ...recordArray(record.learnings, "learnings"),
      ...learnings.map((text) => ({ ...context, source: "review", text })),
    ],
  };
}

function vasLiteCaseSource(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return { kind: "placeholder", url: "", range: { start: 0, end: 0 } };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("source must be an object.");
  }
  const input = value as Record<string, unknown>;
  return {
    kind: optionalString(input.kind, "source.kind") ?? "placeholder",
    url: optionalString(input.url, "source.url") ?? "",
    range: vasLiteCaseSourceRange(input.range),
  };
}

function vasLiteCaseSourceRange(value: unknown): { start: number; end: number } {
  if (value === undefined || value === null) return { start: 0, end: 0 };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("source.range must be an object.");
  }
  const input = value as Record<string, unknown>;
  const start = nonNegativeNumberValue(input.start, "source.range.start");
  const end = nonNegativeNumberValue(input.end, "source.range.end");
  if (end < start) throw badRequest("source.range.end must be greater than or equal to source.range.start.");
  return { start, end };
}

function vasLiteCaseReviewDecision(value: unknown): VasCaseReviewDecision {
  if (value === "approved" || value === "changes_requested") return value;
  throw badRequest("decision must be approved or changes_requested.");
}

function vasLiteCaseClaimAction(value: unknown): VasCaseClaimAction {
  if (value === undefined || value === null || value === "" || value === "claim") return "claim";
  if (value === "release") return "release";
  throw badRequest("action must be claim or release.");
}

function vasLiteCaseReviewDecisionField(data: Record<string, unknown>, key: string): VasCaseReviewDecision | undefined {
  const value = data[key];
  return value === "approved" || value === "changes_requested" ? value : undefined;
}

function textArray(value: unknown, field: string): string[] {
  return stringArray(value, field).map((item) => item.trim()).filter(Boolean);
}

function recordArray(value: unknown, field: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
    throw badRequest(`${field} must be an array of objects.`);
  }
  return value as Record<string, unknown>[];
}

async function readOptionalJsonObject(path: string, field: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    throw badRequest(`${field} must be an object.`);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    if (error instanceof SyntaxError) throw badRequest(`${field} has invalid JSON.`);
    throw error;
  }
}

async function readOptionalTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

async function appendVasLiteLearnedPatterns(
  projectRoot: string,
  caseId: string,
  learnings: string[],
  access: TenantAccess | undefined,
  clientId: string | undefined,
  runId: string | undefined,
): Promise<void> {
  if (learnings.length === 0) return;
  const path = join(projectRoot, "vocabulary", "learned-patterns.md");
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const header = "## Review-sourced Learnings";
  const prefix = content.includes(header)
    ? (content.endsWith("\n") ? "" : "\n")
    : `${content.endsWith("\n") || !content ? "" : "\n"}\n${header}\n\n`;
  const metadata = [
    `case=${caseId}`,
    runId ? `run=${runId}` : "",
    access?.actor ? `reviewedBy=${access.actor}` : "",
    access?.role ? `role=${access.role}` : "",
    clientId ? `clientId=${clientId}` : "",
  ].filter(Boolean).join(" ");
  const lines = learnings.map((learning) => `- ${metadata} :: ${oneLineText(learning)}`);
  await mkdir(join(projectRoot, "vocabulary"), { recursive: true });
  await appendFile(path, prefix + lines.join("\n") + "\n", "utf8");
}

function oneLineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function vasLiteReviewGoal(caseId: string): string {
  return caseId === "bootstrap" ? VAS_LITE_REVIEW_GOAL : `Review VAS Lite case ${caseId}`;
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

function vasLiteReviewScript(
  input: VasLiteReviewPresetInput,
  caseRecord: Record<string, unknown>,
  priorLearnings: VasLiteLearningSummary[],
  reviewGuidance: VasLiteReviewGuidance,
): AgentStep[] {
  return [
    {
      message: "write VAS Lite review report",
      plan: "record the case review artifact and prior learnings for the VAS Lite loop",
      actions: [
        vasLiteReviewContextWriteAction(input, caseRecord, priorLearnings, reviewGuidance),
        {
          toolName: "file.write",
          input: {
            path: vasLiteReviewReportPath(input.caseId),
            content: vasLiteReviewReport(input.caseId, caseRecord, priorLearnings, reviewGuidance),
          },
        },
      ],
    },
    { message: "finish VAS Lite review preset", finish: true },
  ];
}

function vasLiteReviewContextStep(
  input: VasLiteReviewPresetInput,
  caseRecord: Record<string, unknown>,
  priorLearnings: VasLiteLearningSummary[],
  reviewGuidance: VasLiteReviewGuidance,
): AgentStep {
  return {
    message: "prepare VAS Lite review context",
    plan: "write structured VAS Lite context before the selected agent runs",
    actions: [vasLiteReviewContextWriteAction(input, caseRecord, priorLearnings, reviewGuidance)],
  };
}

function vasLiteReviewContextWriteAction(
  input: VasLiteReviewPresetInput,
  caseRecord: Record<string, unknown>,
  priorLearnings: VasLiteLearningSummary[],
  reviewGuidance: VasLiteReviewGuidance,
): NonNullable<AgentStep["actions"]>[number] {
  return {
    toolName: "file.write",
    input: {
      path: vasLiteReviewContextPath(input.caseId),
      content: JSON.stringify(vasLiteReviewContext(input, caseRecord, priorLearnings, reviewGuidance), null, 2) + "\n",
    },
  };
}

function vasLiteReviewReportPath(caseId: string): string {
  return VAS_LITE_REVIEW_REPORT_PATH.replace("bootstrap", caseId);
}

function vasLiteReviewContextPath(caseId: string): string {
  return VAS_LITE_REVIEW_CONTEXT_PATH.replace("bootstrap", caseId);
}

function vasLiteReviewDraftPath(caseId: string): string {
  return VAS_LITE_REVIEW_DRAFT_PATH.replace("bootstrap", caseId);
}

function vasLiteReviewContext(
  input: VasLiteReviewPresetInput,
  caseRecord: Record<string, unknown>,
  priorLearnings: VasLiteLearningSummary[],
  reviewGuidance: VasLiteReviewGuidance,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    preset: VAS_LITE_REVIEW_PRESET,
    loop: VAS_LITE_LOOP,
    caseId: input.caseId,
    case: caseRecord,
    priorLearningCount: priorLearnings.length,
    priorLearnings,
    reviewGuidance,
    reportPath: vasLiteReviewReportPath(input.caseId),
    reviewDraftPath: vasLiteReviewDraftPath(input.caseId),
    reviewChecklist: vasLiteReviewChecklist(input.caseId),
  };
}

function vasLiteReviewReport(
  caseId: string,
  caseRecord: Record<string, unknown>,
  priorLearnings: VasLiteLearningSummary[],
  reviewGuidance: VasLiteReviewGuidance,
): string {
  const source = vasLiteCaseSourceLabel(caseRecord);
  return [
    "# VAS Lite Review",
    "",
    "preset=vas-lite-review",
    `case=${caseId}`,
    source ? `source=${source}` : "",
    `loop=${VAS_LITE_LOOP}`,
    `reviewDraft=${vasLiteReviewDraftPath(caseId)}`,
    "",
    ...vasLiteReviewChecklist(caseId).map((item) => `- ${item}`),
    "",
    "## Prior Learnings",
    "",
    ...vasLitePriorLearningLines(priorLearnings),
    "",
    "## Current Case Review Guidance",
    "",
    ...vasLiteReviewGuidanceLines(reviewGuidance),
    "",
  ].filter((line) => line !== "").join("\n") + "\n";
}

function vasLiteReviewChecklist(caseId: string): string[] {
  return [
    `Review the ${caseId} case.`,
    "Replace placeholder evidence with a real clip.",
    "Keep unresolved ambiguity in uncertainties.",
    "Turn reviewed corrections into vocabulary updates.",
  ];
}

function vasLitePriorLearningLines(priorLearnings: VasLiteLearningSummary[]): string[] {
  if (!priorLearnings.length) return ["- No prior approved learnings."];
  return priorLearnings.map((learning) => `- case=${learning.caseId} :: ${oneLineText(learning.text)}`);
}

function vasLiteReviewGuidanceLines(reviewGuidance: VasLiteReviewGuidance): string[] {
  const lines = [
    `- reviews=${reviewGuidance.reviewCount} corrections=${reviewGuidance.correctionCount} learnings=${reviewGuidance.learningCount}`,
  ];
  if (!reviewGuidance.latestReview && !reviewGuidance.corrections?.length && !reviewGuidance.learnings?.length) {
    return [...lines, "- No current case review guidance."];
  }
  if (reviewGuidance.latestReview) {
    const metadata = vasLiteReviewGuidanceMetadata(reviewGuidance.latestReview);
    const note = reviewGuidance.latestReview.note ? ` :: ${oneLineText(reviewGuidance.latestReview.note)}` : "";
    lines.push(`- latest_review=${reviewGuidance.latestReview.decision ?? "unknown"}${metadata}${note}`);
  }
  for (const correction of reviewGuidance.corrections ?? []) {
    lines.push(`- correction${vasLiteReviewGuidanceMetadata(correction)} :: ${oneLineText(correction.text)}`);
  }
  for (const learning of reviewGuidance.learnings ?? []) {
    lines.push(`- case_learning${vasLiteReviewGuidanceMetadata(learning)} :: ${oneLineText(learning.text)}`);
  }
  return lines;
}

function vasLiteReviewGuidanceMetadata(entry: VasLiteReviewGuidanceReview | VasLiteReviewGuidanceText): string {
  const metadata = [
    entry.reviewedAt ? `reviewedAt=${entry.reviewedAt}` : "",
    entry.runId ? `run=${entry.runId}` : "",
    "reviewDecision" in entry && entry.reviewDecision ? `decision=${entry.reviewDecision}` : "",
    entry.actor ? `reviewedBy=${entry.actor}` : "",
    entry.role ? `role=${entry.role}` : "",
    entry.clientId ? `clientId=${entry.clientId}` : "",
  ].filter(Boolean).join(" ");
  return metadata ? ` (${metadata})` : "";
}

function vasLiteCaseSourceLabel(caseRecord: Record<string, unknown>): string | undefined {
  const source = caseRecord.source;
  if (typeof source !== "object" || source === null || Array.isArray(source)) return undefined;
  const data = source as Record<string, unknown>;
  if (typeof data.url === "string" && data.url.trim()) return data.url.trim();
  if (typeof data.kind === "string" && data.kind.trim()) return data.kind.trim();
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

    const queuePositions = queuedRunPositions(queuedRuns, run);
    queuedRuns.splice(index, 1);
    try {
      await enforceModelUsageTokenLimitsForRun(resolve(options.workspaceRoot), run);
      const status = await startAsyncRun(run, options, activeRuns, activeRunSlots, activeWorkspaces, scheduleQueuedRuns, appendAuditEvent, admissionClaim.handle);
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
      await failQueuedRun(run, error);
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
      await failQueuedStatus(state, error);
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
      await abandonRunningStatus(state, runDir, "auto-abandoned stale run lease", true);
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
  snapshot: QueuedRunSnapshot,
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
  snapshot: QueuedRunSnapshot,
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
    await writeRunStatus(run.runDir, status);
    let heartbeatStopped = false;
    const heartbeat = setInterval(() => {
      if (heartbeatStopped) return;
      status = refreshRunningRunLease(status, options);
      writtenStatus = status;
      void writeRunStatus(run.runDir, status).catch(() => undefined);
      void admissionClaim.refresh().catch(() => undefined);
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
      void readRunCancelRequest(run.runDir)
        .then(async (request) => {
          if (controlPollingStopped || !request || controller.signal.aborted) return;
          remoteCancelRequest = request;
          await deleteRunCancelRequest(run.runDir).catch(() => undefined);
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
        shouldPause: () => readRunPauseRequest(run.runDir),
      },
      signal: controller.signal,
    }).then(async (summary) => {
      stopHeartbeat();
      stopControlPolling();
      const reported = await finalizeRun(options, summary, run.pullRequest, appendAuditEvent);
      await writeRunStatus(run.runDir, reported);
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
      };
      await writeRunSummary(failed);
      await writeRunStatus(run.runDir, failed);
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
      await writeRunSummary(failed).catch(() => undefined);
      await writeRunStatus(run.runDir, failed).catch(() => undefined);
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
  const policyLimits = (await readTenantPolicy(resolve(options.workspaceRoot), run.tenant))?.limits;
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

async function failQueuedRun(run: QueuedRun, error: unknown): Promise<void> {
  await failQueuedStatus(run.status, error);
}

async function failQueuedStatus(status: QueuedRunStatus, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const event = await appendRunEvent(status.runDir, "error", { message });
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
  await writeRunSummary(failed);
  await writeRunStatus(status.runDir, failed);
}

async function abandonRunningStatus(
  state: RunningRunStatus,
  runDir: string,
  reason: string,
  stale: boolean,
): Promise<RunSummary> {
  await appendRunEvent(runDir, "cancel", compactObject({ reason, abandoned: true, stale: stale ? true : undefined }));
  const finish = await appendRunEvent(runDir, "finish", { status: "cancelled" });
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
  await writeRunSummary(abandoned);
  await writeRunStatus(runDir, abandoned);
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
  const state = await readRunState(runDir);
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
  const abandoned = await abandonRunningStatus(state, runDir, reason, staleOnly);
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
  const state = await readRunState(runDir);
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
    const cancelled = await cancelQueuedRun(runDir, tenant, project, runId, state, queuedRuns, reason);
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
      });
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
  runDir: string,
  tenant: string,
  project: string,
  runId: string,
  state: QueuedRunStatus,
  queuedRuns: QueuedRun[],
  reason: string,
): Promise<RunSummary> {
  const index = queuedRuns.findIndex((run) => run.tenant === tenant && run.project === project && run.runId === runId);
  if (index >= 0) {
    queuedRuns.splice(index, 1);
  }
  await appendRunEvent(runDir, "cancel", { reason, queued: true });
  const finish = await appendRunEvent(runDir, "finish", { status: "cancelled" });
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
  await writeRunSummary(cancelled);
  await writeRunStatus(runDir, cancelled);
  return cancelled;
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
  const state = await readRunState(runDir);
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

  const snapshot = await readQueuedRunSnapshot(runDir);
  const run = await harnessRunStartFromSnapshot(workspaceRoot, options, { ...state, tenant, project }, snapshot);
  const resumeRequester = runRequester(access, clientId);
  await enforceModelUsageTokenLimitsForRun(workspaceRoot, run);
  const admissionClaim = await tryAcquireActiveRunAdmission(options, run, tenantRunLimit);
  if (!admissionClaim.ok) throw admissionClaim.error;
  let claimOwnedByRun = false;
  await deleteRunPauseRequest(runDir);
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

  const summary = await readRunState(runDir);
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
    const reviewed = await writeReviewedSummary({ ...summary, status: "failed", review }, runDir, review, runEventContext(access, clientId));
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorMessage = `merge reporter failed: ${message}`;
      await recordRunError(summary, errorMessage);
      throw new Error(errorMessage);
    }
  }
  reviewed = await writeReviewedSummary(reviewed, runDir, review, runEventContext(access, clientId));
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

  const summary = await readRunState(runDir);
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
  }));
  const updated = { ...summary, review: updatedReview, eventCount: event.seq };
  await writeRunSummary(updated);
  await writeRunStatus(runDir, updated);
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
  const summary = await readRunState(runDir);
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
  const deployed = await writeDeploymentSummary({ ...summary, status: decision === "approved" ? "passed" : "failed", deployment }, runDir, deployment, runEventContext(access, clientId));
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
    const state = await readRunState(runDir);
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
    }));
    if (pauseRequested) {
      await writeRunPauseRequest(runDir, {
        reason: message,
        eventSeq: event.seq,
        ...context,
      });
    }

    if (state.status !== "running" && state.status !== "queued") {
      const observed: RunSummary = { ...state, eventCount: event.seq };
      await writeRunSummary(observed);
      await writeRunStatus(runDir, observed);
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
    const result = await syncIssueCommentsIntoRun(run.runDir, run.state, parsed.issue, [parsed.comment], syncContext);
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
  provider: string,
  author: string | undefined,
  actorPrefix: string,
): Promise<IssueCommentControlPlaneIdentity> {
  const externalActor = issueCommentActor(author, actorPrefix);
  const rawAuthor = author?.trim() || undefined;
  if (!externalActor) return {};
  const policy = await readTenantPolicy(resolve(workspaceRoot), tenant);
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
    const state = await readRunState(runDir);
    const issue = state.metadata?.issue;
    if (!issue) throw badRequest("run is not linked to an issue.");
    const body = await readIssueCommentSyncJson(req);
    const clientId = optionalClientId(body.clientId);
    const comments = await options.issueCommentReader(issue, { tenant, project, runId });
    const { events, skipped } = await syncIssueCommentsIntoRun(
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
    const sourceContext = await runWorkspaceContext(url, workspaceRoot, tenant, sourceRunId);
    const project = sourceContext.project;
    const sourceRunDir = join(workspaceRoot, tenant, project, ".loom", "runs", sourceRunId);
    const sourceState = await readRunState(sourceRunDir);
    const sourceEvents = await readRunEventsIfPresent(sourceRunDir);
    const sourceAuditTrail = runTenantAuditTrail(await readTenantAuditEvents(workspaceRoot, tenant), project, sourceRunId);
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
      const currentAuditTrail = runTenantAuditTrail(await readTenantAuditEvents(workspaceRoot, tenant), project, sourceRunId);
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
    const context = await runWorkspaceContext(url, workspaceRoot, tenant, runId);
    const state = await readRunState(join(workspaceRoot, tenant, context.project, ".loom", "runs", runId));
    const auditTrail = runTenantAuditTrail(await readTenantAuditEvents(workspaceRoot, tenant), context.project, runId);
    const events = await readRunEventsIfPresent(join(workspaceRoot, tenant, context.project, ".loom", "runs", runId));
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
    await readRunState(runDir);
  } catch (error) {
    if (isNotFound(error)) throw notFound("run not found");
    throw error;
  }
  return { tenant, project, runId, cwd: join(workspaceRoot, tenant, project), access };
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
    const context = await runWorkspaceContext(url, workspaceRoot, tenant, runId);
    const runDir = join(workspaceRoot, tenant, context.project, ".loom", "runs", runId);
    const state = await readRunState(runDir);
    const events = await readRunEventsIfPresent(runDir);
    const replay = runReplayFromEvents(state, events);
    const diff = await workspaceDiff(context, options);
    const auditTrail = runTenantAuditTrail(await readTenantAuditEvents(workspaceRoot, tenant), context.project, runId);
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
    const state = await readRunState(runDir);
    const replay = runReplayFromEvents(state, await readRunEventsIfPresent(runDir));
    const diff = await workspaceDiff(await runWorkspaceContext(url, workspaceRoot, tenant, runId), options);
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
      await readRunState(runDir);
      await streamEvents(res, runDir, seqAfter(url, req));
      return true;
    }

    if (segments[4] === "events") {
      await readRunState(runDir);
      writeJson(res, 200, filterEvents(await readRunEventsIfPresent(runDir), seqAfter(url)));
      return true;
    }

    if (segments[4] === "replay") {
      const state = await readRunState(runDir);
      writeJson(res, 200, runReplayFromEvents(state, await readRunEventsIfPresent(runDir)));
      return true;
    }

    const summary = await readRunState(runDir);
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
  const policyLimits = (await readTenantPolicy(workspaceRoot, tenant))?.limits;
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
  const tenantAuditEvents = await readTenantAuditEvents(workspaceRoot, tenant);
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

function workspaceSessionActivityAt(session: WorkspaceSessionSummary): string {
  return session.endedAt ?? session.lastActivityAt ?? session.startedAt;
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

async function readRunStatesForListing(runsRoot: string, tenant: string, project: string): Promise<ReadableRunState[]> {
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

function projectContractPatchFromReviewBody(body: ReviewRequestBody): ProjectContractPatch | undefined {
  if (body.contractPatch === undefined) return undefined;
  if (typeof body.contractPatch !== "object" || body.contractPatch === null || Array.isArray(body.contractPatch)) {
    throw badRequest("contractPatch must be an object.");
  }
  const patch = projectContractFromBody(body.contractPatch as ProjectContractRequestBody);
  if (!patch) throw badRequest("contractPatch must include objective, constraints, or successCriteria.");
  return patch;
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

function compactStringList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
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

function applyProjectContractStatusGate(body: RunRequestBody, status: ProjectContractStatusEvidence | undefined): RunRequestBody {
  if (status?.ok !== false || body.reviewRequired === true) return body;
  return { ...body, reviewRequired: true };
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

function runSourceFromBody(body: RunRequestBody, defaults: ProjectSourceDefaultValues): ProjectSourceDefaultValues {
  return compactObject({
    repo: optionalSourceRepo(body.repo) ?? defaults.repo,
    branch: optionalSourceGitRef(body.branch, "branch", defaults.branch),
    baseBranch: optionalSourceGitRef(body.baseBranch, "baseBranch", defaults.baseBranch),
    issue: optionalSourceIssue(body.issue, defaults.issue),
  });
}

function optionalSourceRepo(value: unknown, fallback?: string): string | undefined {
  const repo = (optionalString(value, "repo") ?? fallback)?.trim();
  if (!repo) return undefined;
  if (repo.includes("\0") || repo.startsWith("-")) {
    throw badRequest("repo is not safe.");
  }
  return repo;
}

function optionalSourceGitRef(value: unknown, field: "branch" | "baseBranch", fallback?: string): string | undefined {
  return workspacePullRequestRef(value, fallback, field, true);
}

function optionalSourceIssue(value: unknown, fallback?: string): string | undefined {
  const issue = (optionalString(value, "issue") ?? fallback)?.trim();
  if (!issue) return undefined;
  try {
    parseGiteaIssueRef(issue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw badRequest(message);
  }
  return issue;
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

async function readVasLiteProjectReadiness(
  projectRoot: string,
  tenant: string,
  project: string,
): Promise<Pick<ProjectSummary, "vasCaseCount" | "vasNeedsReviewCaseCount" | "vasReviewedRunCount" | "vasUnreviewedRunCount">> {
  const cases = await listVasLiteCases(projectRoot, tenant, project);
  return {
    vasCaseCount: cases.length,
    vasNeedsReviewCaseCount: cases.filter((item) => item.status !== "reviewed").length,
    vasReviewedRunCount: cases.reduce((total, item) => total + (item.reviewedRunCount ?? 0), 0),
    vasUnreviewedRunCount: cases.reduce((total, item) => total + (item.unreviewedRunCount ?? 0), 0),
  };
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

function projectWorkspaceContext(workspaceRoot: string, tenant: string, project: string, runId: string): HarnessWorkspaceContext {
  const cwd = join(workspaceRoot, tenant, project);
  return { tenant, project, runId, cwd };
}

async function runWorkspaceContext(
  url: URL,
  workspaceRoot: string,
  tenant: string,
  runId: string,
): Promise<HarnessWorkspaceContext> {
  const requestedProject = optionalSafeName(url.searchParams.get("project"), "project") ?? "default";
  const runDir = join(workspaceRoot, tenant, requestedProject, ".loom", "runs", runId);
  const state = await readRunState(runDir);
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

async function readRunState(runDir: string): Promise<RunSummary | RunningRunStatus | QueuedRunStatus> {
  try {
    const status = JSON.parse(await readFile(join(runDir, "status.json"), "utf8")) as RunSummary | RunningRunStatus | QueuedRunStatus;
    if (status.status === "running" || status.status === "queued") return status;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    return JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as RunSummary;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return JSON.parse(await readFile(join(runDir, "status.json"), "utf8")) as RunningRunStatus | QueuedRunStatus;
  }
}

async function writeRunPauseRequest(runDir: string, request: RunPauseRequest): Promise<void> {
  await writeJsonFileAtomic(join(runDir, RUN_PAUSE_REQUEST_FILE), {
    schemaVersion: 1,
    requestedAt: new Date().toISOString(),
    ...request,
  });
}

async function readRunPauseRequest(runDir: string): Promise<RunPauseRequest | undefined> {
  try {
    const data = JSON.parse(await readFile(join(runDir, RUN_PAUSE_REQUEST_FILE), "utf8")) as Record<string, unknown>;
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

async function deleteRunPauseRequest(runDir: string): Promise<void> {
  try {
    await unlink(join(runDir, RUN_PAUSE_REQUEST_FILE));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function writeRunCancelRequest(runDir: string, request: RunCancelRequest): Promise<void> {
  await writeJsonFileAtomic(join(runDir, RUN_CANCEL_REQUEST_FILE), {
    schemaVersion: 1,
    requestedAt: new Date().toISOString(),
    ...request,
  });
}

async function readRunCancelRequest(runDir: string): Promise<RunCancelRequest | undefined> {
  try {
    const data = JSON.parse(await readFile(join(runDir, RUN_CANCEL_REQUEST_FILE), "utf8")) as Record<string, unknown>;
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

async function deleteRunCancelRequest(runDir: string): Promise<void> {
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

async function writeReviewedSummary(summary: RunSummary, runDir: string, review: ReviewGate, context: RunEventContext = {}): Promise<RunSummary> {
  await appendRunEvent(runDir, "review_gate", compactObject({ ...review, ...context }));
  const finish = await appendRunEvent(runDir, "finish", compactObject({ status: summary.status, ...context }));
  const reviewed = { ...summary, eventCount: finish.seq };
  await writeRunSummary(reviewed);
  await writeRunStatus(runDir, reviewed);
  return reviewed;
}

async function writeDeploymentSummary(summary: RunSummary, runDir: string, deployment: DeploymentGate, context: RunEventContext = {}): Promise<RunSummary> {
  await appendRunEvent(runDir, "deployment_gate", compactObject({ ...deployment, ...context }));
  const finish = await appendRunEvent(runDir, "finish", compactObject({ status: summary.status, ...context }));
  const deployed = { ...summary, eventCount: finish.seq };
  await writeRunSummary(deployed);
  await writeRunStatus(runDir, deployed);
  return deployed;
}

function runEventContext(access: TenantAccess | undefined, clientId: string | undefined): RunEventContext {
  return compactObject({
    actor: access?.actor,
    role: access?.role,
    clientId,
  });
}

function compactReview(review: ReviewGate): ReviewGate {
  return Object.fromEntries(Object.entries(review).filter(([, value]) => value !== undefined)) as ReviewGate;
}

function compactDeployment(deployment: DeploymentGate): DeploymentGate {
  return Object.fromEntries(Object.entries(deployment).filter(([, value]) => value !== undefined)) as DeploymentGate;
}

function compactProjectSummary(project: ProjectSummary): ProjectSummary {
  return Object.fromEntries(Object.entries(project).filter(([, value]) => value !== undefined)) as ProjectSummary;
}

function compactProjectDetail(project: ProjectDetail): ProjectDetail {
  return Object.fromEntries(Object.entries(project).filter(([, value]) => value !== undefined)) as ProjectDetail;
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

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
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

function compactMetadata(metadata: RunMetadata): RunMetadata {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)) as RunMetadata;
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markRunError(summary, `issue reporter failed: ${message}`);
  }
}

async function finalizeRun(
  options: HarnessServerOptions,
  summary: RunSummary,
  pullRequestRequested: boolean,
  appendAuditEvent?: TenantAuditAppender,
): Promise<RunSummary> {
  const withPullRequest = await reportPullRequest(options, summary, pullRequestRequested);
  await writeRunSummary(withPullRequest);
  const withIssue = await reportIssue(options, withPullRequest);
  return reportBrainIngest(options, withIssue, appendAuditEvent);
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markRunError(summary, `pull request reporter failed: ${message}`);
  }
}

async function recordRunExternalEffect(summary: RunSummary, data: Record<string, unknown>): Promise<RunSummary> {
  const event = await appendRunEvent(summary.runDir, "external_effect", compactObject({
    ...data,
    requester: summary.requester,
  }));
  const observed: RunSummary = { ...summary, eventCount: event.seq };
  await writeRunSummary(observed);
  await writeRunStatus(summary.runDir, observed);
  return observed;
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markRunError(summary, `brain ingest failed: ${message}`);
  }
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

async function markRunError(summary: RunSummary, message: string): Promise<RunSummary> {
  const event = await recordRunError(summary, message);
  const failed: RunSummary = {
    ...summary,
    status: "error",
    endedAt: new Date().toISOString(),
    eventCount: event.seq,
    error: { message },
  };
  await writeRunSummary(failed);
  await writeRunStatus(summary.runDir, failed);
  return failed;
}

async function recordRunError(summary: RunSummary, message: string): Promise<HarnessEvent> {
  const event = await appendRunEvent(summary.runDir, "error", { message });
  const observed = { ...summary, eventCount: event.seq };
  await writeRunSummary(observed);
  await writeRunStatus(summary.runDir, observed);
  return event;
}

async function writeRunSummary(summary: RunSummary): Promise<void> {
  await writeJsonFileAtomic(join(summary.runDir, "summary.json"), summary);
}

async function writeRunStatus(runDir: string, status: RunningRunStatus | QueuedRunStatus | RunSummary): Promise<void> {
  await writeJsonFileAtomic(join(runDir, "status.json"), status);
}

async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tempPath, path);
}

async function writeQueuedRunSnapshot(runDir: string, request: RunRequestBody, requester?: RunRequester): Promise<void> {
  const snapshot: QueuedRunSnapshot = {
    schemaVersion: 1,
    request,
    requester,
  };
  await writeFile(join(runDir, QUEUED_RUN_REQUEST_FILE), JSON.stringify(snapshot, null, 2) + "\n", "utf8");
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
  waitForStateMs = 0,
): Promise<{ statusCode: number; body: Record<string, unknown> } | undefined> {
  let record: RunCreateRequestRecord | undefined;
  try {
    record = runCreateRequestRecordFromUnknown(
      JSON.parse(await readFile(runCreateRequestPath(runRoot, clientRequestId), "utf8")),
    );
  } catch (error) {
    if (isNotFound(error)) return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
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
        const state = await readRunState(record.runDir);
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
): Promise<
  | { created: true; record: RunCreateRequestRecord }
  | { created: false; replay: { statusCode: number; body: Record<string, unknown> } }
> {
  await mkdir(runCreateRequestDir(runRoot), { recursive: true });
  const path = runCreateRequestPath(runRoot, record.clientRequestId);
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
      RUN_CREATE_REQUEST_REPLAY_TIMEOUT_MS,
    );
    if (!replay) throw conflict("clientRequestId already belongs to a run request that is not readable.");
    return { created: false, replay };
  }
}

async function writeRunCreateRequestRecord(runRoot: string, record: RunCreateRequestRecord | undefined): Promise<void> {
  if (!record) return;
  await mkdir(runCreateRequestDir(runRoot), { recursive: true });
  await writeJsonFileAtomic(runCreateRequestPath(runRoot, record.clientRequestId), record);
}

async function deleteRunCreateRequestRecord(runRoot: string, record: RunCreateRequestRecord | undefined): Promise<void> {
  if (!record) return;
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

async function readQueuedRunSnapshot(runDir: string): Promise<QueuedRunSnapshot> {
  const snapshot = JSON.parse(await readFile(join(runDir, QUEUED_RUN_REQUEST_FILE), "utf8")) as QueuedRunSnapshot;
  if (snapshot.schemaVersion !== 1 || typeof snapshot.request !== "object" || snapshot.request === null) {
    throw badRequest("invalid queued run snapshot.");
  }
  return snapshot;
}

function seqAfter(url: URL, req?: IncomingMessage): number {
  const query = url.searchParams.get("after");
  const header = req?.headers["last-event-id"];
  const raw = header !== undefined ? header : query;
  if (Array.isArray(raw)) throw badRequest("after must be a non-negative integer.");
  if (raw === null || raw === "") return 0;
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw badRequest("after must be a non-negative integer.");
  }
  return parsed;
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

function filterEvents(events: HarnessEvent[], after: number): HarnessEvent[] {
  return events.filter((event) => event.seq > after);
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

function boundedDiagnosticText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function isSensitiveDiagnosticKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /(token|secret|password|authorization|cookie|apikey|accesskey|privatekey)/.test(normalized);
}

function runReviewVasEvidence(state: ReadableRunState, tenant?: string, project?: string): RunReviewVasEvidence | undefined {
  const caseId = vasLiteRunCaseId(state);
  const currentTenant = tenant ?? state.metadata?.tenant;
  const currentProject = project ?? state.metadata?.project;
  if (!caseId || !currentTenant || !currentProject) return undefined;
  const basePath = `/tenants/${encodeURIComponent(currentTenant)}/projects/${encodeURIComponent(currentProject)}/vas/cases/${encodeURIComponent(caseId)}`;
  return {
    preset: VAS_LITE_REVIEW_PRESET,
    caseId,
    links: {
      artifacts: `${basePath}/artifacts`,
      runs: `${basePath}/runs`,
      reviewPackage: `${basePath}/review-package`,
      reviewRuns: `${basePath}/review-runs`,
    },
  };
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

function isRunSummaryState(state: ReadableRunState): state is RunSummary {
  return "endedAt" in state && "verification" in state;
}

function runTenantAuditTrail(events: TenantAuditEvent[], project: string, runId: string): TenantAuditEvent[] {
  return events.filter((event) => {
    const data = recordData(event.data);
    return data.project === project && (data.runId === runId || data.followupRunId === runId);
  });
}

function vasLiteCaseTenantAuditTrail(events: TenantAuditEvent[], project: string, caseId: string): TenantAuditEvent[] {
  return events.filter((event) => {
    const data = recordData(event.data);
    if (data.project !== project) return false;
    if (data.caseId === caseId) return true;
    return recordData(data.presetInput).caseId === caseId;
  });
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

function latestAuditData(events: TenantAuditEvent[], type: TenantAuditEvent["type"]): Record<string, unknown> {
  const event = [...events].reverse().find((entry) => entry.type === type);
  return recordData(event?.data);
}

function latestRunExternalEffect(events: HarnessEvent[], kind: string): Record<string, unknown> {
  const event = [...events].reverse().find((entry) => {
    const data = recordData(entry.data);
    return entry.type === "external_effect" && data.kind === kind;
  });
  return recordData(event?.data);
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

function runEvidencePath(tenant: string, project: string, runId: string, child: "review-summary" | "handoff-package"): string {
  return `/tenants/${tenant}/runs/${runId}/${child}${runProjectQuery(project)}`;
}

function runProjectQuery(project: string): string {
  if (project === "default") return "";
  return `?project=${encodeURIComponent(project)}`;
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

function replayText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
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
  const pairs = Object.entries(details).map(([key, entry]) => `${key}=${replayDiagnosticValue(entry)}`);
  return pairs.length ? replayText(pairs.join(" ")) : undefined;
}

function replayDiagnosticValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? String(value);
}

function recordData(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

function tenantRoleField(data: Record<string, unknown>, key: string): TenantRole | undefined {
  const value = data[key];
  return value === "admin" || value === "developer" || value === "viewer" ? value : undefined;
}

function projectTemplateNameField(data: Record<string, unknown>, key: string): ProjectTemplateName | undefined {
  const value = data[key];
  return value === "empty" || value === "vas-lite" ? value : undefined;
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

function booleanField(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberField(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayField(data: Record<string, unknown>, key: string): string[] | undefined {
  const value = data[key];
  return Array.isArray(value) && value.length && value.every((item) => typeof item === "string") ? value : undefined;
}

	function stringArrayFieldAllowEmpty(data: Record<string, unknown>, key: string): string[] | undefined {
	  const value = data[key];
	  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
	}
	
function controlPlaneProviderNameField(data: Record<string, unknown>, key: string): ControlPlaneProviderCatalogName | undefined {
  const value = data[key];
  return typeof value === "string" && controlPlaneProviderCatalogEntry(value)
    ? value as ControlPlaneProviderCatalogName
    : undefined;
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

function compactReplayEntry(entry: RunReplayEntry): RunReplayEntry {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as RunReplayEntry;
}

async function streamTenantAuditEvents(
  res: ServerResponse,
  workspaceRoot: string,
  tenant: string,
  after: number,
  project?: string,
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
    const events = filterTenantAuditEvents(await readTenantAuditEvents(workspaceRoot, tenant), lastSeq, 500, project);
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

async function streamEvents(res: ServerResponse, runDir: string, after: number): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders();

  let lastSeq = after;
  const deadline = Date.now() + 60_000;

  while (!res.destroyed && Date.now() < deadline) {
    const allEvents = await readRunEventsIfPresent(runDir);
    const events = filterEvents(allEvents, lastSeq);
    for (const event of events) {
      lastSeq = Math.max(lastSeq, event.seq);
      res.write(`event: harness_event\n`);
      res.write(`id: ${event.seq}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const latestEvent = latestRunEvent(allEvents);
    const state = await readRunStateIfPresent(runDir);
    if (shouldCloseRunEventStream(state, latestEvent, lastSeq)) {
      res.end();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  res.end();
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

async function readRunEventsIfPresent(runDir: string): Promise<HarnessEvent[]> {
  try {
    return await readRunEvents(runDir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function readRunStateIfPresent(runDir: string): Promise<ReadableRunState | undefined> {
  try {
    return await readRunState(runDir);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function readRunStateForScan(runDir: string): Promise<ReadableRunState | undefined> {
  try {
    return await readRunState(runDir);
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
  const policy = await readTenantPolicy(resolve(options.workspaceRoot), tenant);
  const envName = access?.modelKeyEnv ?? policy?.modelKeyEnv ?? options.tenantModelKeyEnvs?.[tenant];
  if (!envName) return options.modelApiKey;
  const value = process.env[envName];
  if (!value) throw badRequest(`tenant model key env ${envName} is not set.`);
  return value;
}

async function readTenantPolicy(workspaceRoot: string, tenant: string): Promise<TenantPolicy | undefined> {
  try {
    return tenantPolicyFromUnknown(JSON.parse(await readFile(tenantPolicyPath(workspaceRoot, tenant), "utf8")));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeTenantPolicy(workspaceRoot: string, tenant: string, policy: TenantPolicy): Promise<void> {
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
    apiKeys: tenantPolicyApiKeys(input.apiKeys),
    controlPlaneIdentities: tenantPolicyControlPlaneIdentities(input.controlPlaneIdentities),
    modelKeyEnv: input.modelKeyEnv === undefined ? undefined : envNameValue(input.modelKeyEnv, "modelKeyEnv"),
    executorTemplateParameters: input.executorTemplateParameters === undefined
      ? undefined
      : tenantPolicyTemplateParameters(input.executorTemplateParameters),
    limits: tenantPolicyLimits(input.limits),
    allowedTools: input.allowedTools === undefined ? undefined : [...new Set(stringArray(input.allowedTools, "allowedTools"))],
  });
}

function tenantPolicyApiKeys(value: unknown): TenantApiKey[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw badRequest("apiKeys must be an array.");
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw badRequest(`apiKeys[${index}] must be an object.`);
    }
    const key = entry as Record<string, unknown>;
    const role = tenantPolicyRole(key.role, `apiKeys[${index}].role`);
    const token = key.token === undefined ? undefined : tenantPolicyApiToken(key.token);
    const tokenHash = key.tokenHash === undefined ? undefined : tenantPolicyApiTokenHash(key.tokenHash, `apiKeys[${index}].tokenHash`);
    if (!token && !tokenHash) {
      throw badRequest(`apiKeys[${index}].token or apiKeys[${index}].tokenHash is required.`);
    }
    return {
      tokenHash: tokenHash ?? hashTenantApiToken(token as string),
      actor: requireString(key.actor, `apiKeys[${index}].actor`),
      role,
      modelKeyEnv: key.modelKeyEnv === undefined ? undefined : envNameValue(key.modelKeyEnv, `apiKeys[${index}].modelKeyEnv`),
    };
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

function tenantPolicyApiKeyCreateFromUnknown(value: unknown): TenantPolicyApiKeyCreateRequestBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("tenant API key request must be an object.");
  }
  return value as TenantPolicyApiKeyCreateRequestBody;
}

function tenantPolicyApiKeyRevokeFromUnknown(value: unknown): TenantPolicyApiKeyRevokeRequestBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("tenant API key revoke request must be an object.");
  }
  return value as TenantPolicyApiKeyRevokeRequestBody;
}

function tenantPolicyApiKeyFromCreateBody(body: TenantPolicyApiKeyCreateRequestBody): { apiKey: TenantApiKey; token: string } {
  const token = body.token === undefined ? generateTenantApiToken() : tenantPolicyApiToken(body.token);
  return {
    token,
    apiKey: compactObject({
      tokenHash: hashTenantApiToken(token),
      actor: tenantPolicyApiKeyActor(body.actor),
      role: tenantPolicyRole(body.role, "role"),
      modelKeyEnv: body.modelKeyEnv === undefined ? undefined : envNameValue(body.modelKeyEnv, "modelKeyEnv"),
    }),
  };
}

function tenantPolicyApiKeyActor(value: unknown): string {
  const actor = requireString(value, "actor").trim();
  if (actor.length > 120 || /[\0\r\n]/.test(actor)) {
    throw badRequest("actor must be a single-line string at most 120 characters.");
  }
  return actor;
}

function tenantPolicyApiToken(value: unknown): string {
  const token = requireString(value, "token").trim();
  if (token.length > 512 || /[\0\r\n]/.test(token)) {
    throw badRequest("token must be a single-line string at most 512 characters.");
  }
  return token;
}

function tenantPolicyApiTokenHash(value: unknown, field: string): string {
  const hash = requireString(value, field).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
    throw badRequest(`${field} must be a sha256 token hash.`);
  }
  return hash;
}

function hashTenantApiToken(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function generateTenantApiToken(): string {
  return `loom_${randomBytes(24).toString("base64url")}`;
}

function sanitizeTenantApiKey(key: TenantApiKey): { actor: string; role: TenantRole; modelKeyEnv?: string } {
  return compactObject({ actor: key.actor, role: key.role, modelKeyEnv: key.modelKeyEnv });
}

function sanitizeTenantApiKeys(keys: TenantApiKey[] | undefined): Array<{ actor: string; role: TenantRole; modelKeyEnv?: string }> | undefined {
  const sanitized = keys?.map(sanitizeTenantApiKey) ?? [];
  return sanitized.length ? sanitized : undefined;
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

function tenantControlPlaneIdentityKey(identity: SanitizedTenantControlPlaneIdentity): string {
  return `${identity.provider}\0${identity.externalActor}\0${identity.actor}\0${identity.role}`;
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

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
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
  const policy = await readTenantPolicy(resolve(options.workspaceRoot), tenant);
  const tokens = options.tenantTokens ?? {};
  const apiKeys = options.tenantApiKeys ?? {};
  const hasGlobalAuth = Object.keys(tokens).length > 0 || Object.keys(apiKeys).length > 0;
  const hasTenantPolicyAuth = (policy?.apiKeys?.length ?? 0) > 0;
  if (!hasGlobalAuth && !hasTenantPolicyAuth) return undefined;

  const tenantApiKeys = [...(apiKeys[tenant] ?? []), ...(policy?.apiKeys ?? [])];
  const expected = tokens[tenant];
  if (!expected && tenantApiKeys.length === 0) {
    throw unauthorized(`unknown tenant: ${tenant}`);
  }

  const provided =
    bearerToken(req.headers.authorization) ??
    headerValue(req.headers["x-loom-tenant-token"]) ??
    streamQueryToken(url) ??
    undefined;
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

  if (!provided || !safeEqualString(provided, expected)) {
    throw unauthorized("invalid tenant token");
  }

  return undefined;
}

async function requireServerStatusAccess(
  req: IncomingMessage,
  workspaceRoot: string,
  options: HarnessServerOptions,
  url?: URL,
): Promise<TenantAccess | undefined> {
  const keys = await serverStatusAccessKeys(workspaceRoot, options);
  if (keys.length === 0) return undefined;

  const provided =
    bearerToken(req.headers.authorization) ??
    headerValue(req.headers["x-loom-tenant-token"]) ??
    streamQueryToken(url) ??
    undefined;
  const matches = keys
    .filter((key) => tenantApiKeyMatches(key, provided))
    .sort((a, b) => tenantRoleRank(b.role) - tenantRoleRank(a.role));
  const key = matches[0];
  if (!key) {
    throw unauthorized("invalid tenant token");
  }

  const access = { actor: key.actor, role: key.role };
  requireTenantRole(access, "admin");
  return access;
}

function streamQueryToken(url: URL | undefined): string | undefined {
  if (!url?.pathname.endsWith("/stream")) return undefined;
  return url.searchParams.get("token") ?? undefined;
}

function tenantApiKeyMatches(key: TenantApiKey, provided: string | undefined): boolean {
  if (!provided) return false;
  if (key.token && safeEqualString(provided, key.token)) return true;
  return Boolean(key.tokenHash && safeEqualString(hashTenantApiToken(provided), key.tokenHash));
}

function safeEqualString(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function serverStatusAccessKeys(workspaceRoot: string, options: HarnessServerOptions): Promise<TenantApiKey[]> {
  const legacyKeys = Object.entries(options.tenantTokens ?? {})
    .filter(([tenant]) => isSafeTenantDirectoryName(tenant))
    .map(([, token]) => ({
      token,
      actor: "legacy-token",
      role: "admin" as const,
    }));
  const configuredKeys = Object.entries(options.tenantApiKeys ?? {})
    .filter(([tenant]) => isSafeTenantDirectoryName(tenant))
    .flatMap(([, keys]) => keys);
  const policyKeys = await policyStatusAccessKeys(workspaceRoot);
  return [...legacyKeys, ...configuredKeys, ...policyKeys];
}

async function policyStatusAccessKeys(workspaceRoot: string): Promise<TenantApiKey[]> {
  let entries;
  try {
    entries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const keys: TenantApiKey[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeTenantDirectoryName(entry.name)) continue;
    const policy = await readTenantPolicy(workspaceRoot, entry.name);
    keys.push(...(policy?.apiKeys ?? []));
  }
  return keys;
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

function bearerToken(value: string | string[] | undefined): string | undefined {
  const header = headerValue(value);
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

async function readJson(req: IncomingMessage): Promise<RunRequestBody> {
  return readJsonBody<RunRequestBody>(req);
}

async function readReviewJson(req: IncomingMessage): Promise<ReviewRequestBody> {
  return readJsonBody<ReviewRequestBody>(req);
}

async function readReviewClaimJson(req: IncomingMessage): Promise<ReviewClaimRequestBody> {
  return readJsonBody<ReviewClaimRequestBody>(req);
}

async function readDeploymentJson(req: IncomingMessage): Promise<DeploymentRequestBody> {
  return readJsonBody<DeploymentRequestBody>(req);
}

async function readCancelJson(req: IncomingMessage): Promise<CancelRequestBody> {
  return readJsonBody<CancelRequestBody>(req);
}

async function readRunCommentJson(req: IncomingMessage): Promise<RunCommentRequestBody> {
  return readJsonBody<RunCommentRequestBody>(req);
}

async function readIssueCommentSyncJson(req: IncomingMessage): Promise<IssueCommentSyncRequestBody> {
  return readJsonBody<IssueCommentSyncRequestBody>(req);
}

async function readRunResumeJson(req: IncomingMessage): Promise<RunResumeRequestBody> {
  return readJsonBody<RunResumeRequestBody>(req);
}

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

async function readBrainSignalJson(req: IncomingMessage): Promise<BrainSignalRequestBody> {
  return readJsonBody<BrainSignalRequestBody>(req);
}

async function readVasCaseCreateJson(req: IncomingMessage): Promise<VasCaseCreateRequestBody> {
  return readJsonBody<VasCaseCreateRequestBody>(req);
}

async function readVasCaseReviewJson(req: IncomingMessage): Promise<VasCaseReviewRequestBody> {
  return readJsonBody<VasCaseReviewRequestBody>(req);
}

async function readVasCaseClaimJson(req: IncomingMessage): Promise<VasCaseClaimRequestBody> {
  return readJsonBody<VasCaseClaimRequestBody>(req);
}

async function readVasCaseReviewRunJson(req: IncomingMessage): Promise<VasCaseReviewRunRequestBody> {
  return readJsonBody<VasCaseReviewRunRequestBody>(req);
}

async function readPresenceJson(req: IncomingMessage): Promise<PresenceRequestBody> {
  return readJsonBody<PresenceRequestBody>(req);
}

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

async function readTenantPolicyJson(req: IncomingMessage): Promise<TenantPolicyRequestBody> {
  return readJsonBody<TenantPolicyRequestBody>(req);
}

async function readTenantPolicySettingsJson(req: IncomingMessage): Promise<TenantPolicySettingsRequestBody> {
  return readJsonBody<TenantPolicySettingsRequestBody>(req);
}

async function readTenantPolicyApiKeyCreateJson(req: IncomingMessage): Promise<TenantPolicyApiKeyCreateRequestBody> {
  return readJsonBody<TenantPolicyApiKeyCreateRequestBody>(req);
}

async function readTenantPolicyApiKeyRevokeJson(req: IncomingMessage): Promise<TenantPolicyApiKeyRevokeRequestBody> {
  return readJsonBody<TenantPolicyApiKeyRevokeRequestBody>(req);
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

async function readAgentGitServiceProjectProvisionJson(req: IncomingMessage): Promise<AgentGitServiceProjectProvisionRequestBody> {
  return readJsonBody<AgentGitServiceProjectProvisionRequestBody>(req);
}

async function readAgentGitServiceProvisioningPlanApplyJson(req: IncomingMessage): Promise<AgentGitServiceProvisioningPlanApplyRequestBody> {
  return readJsonBody<AgentGitServiceProvisioningPlanApplyRequestBody>(req);
}

async function readTenantOperatorCockpitLoopExecuteJson(req: IncomingMessage): Promise<TenantOperatorCockpitLoopExecuteRequestBody> {
  return readJsonBody<TenantOperatorCockpitLoopExecuteRequestBody>(req);
}

async function readTenantOperatorTargetInputTemplateJson(req: IncomingMessage): Promise<TenantOperatorTargetInputTemplateRequestBody> {
  return readJsonBody<TenantOperatorTargetInputTemplateRequestBody>(req);
}

async function readTenantOperatorRealStagingTargetInputJson(req: IncomingMessage): Promise<TenantOperatorRealStagingTargetInputRequestBody> {
  return readJsonBody<TenantOperatorRealStagingTargetInputRequestBody>(req);
}

async function readTenantOperatorRealStagingTargetsApplyJson(req: IncomingMessage): Promise<TenantOperatorRealStagingTargetsApplyRequestBody> {
  return readJsonBody<TenantOperatorRealStagingTargetsApplyRequestBody>(req);
}

async function readTenantOperatorBundleRefreshJson(req: IncomingMessage): Promise<TenantOperatorBundleRefreshRequestBody> {
  return readJsonBody<TenantOperatorBundleRefreshRequestBody>(req);
}

async function readTenantOperatorGithubActionsTargetInputJson(req: IncomingMessage): Promise<TenantOperatorGithubActionsTargetInputRequestBody> {
  return readJsonBody<TenantOperatorGithubActionsTargetInputRequestBody>(req);
}

async function readTenantOperatorCiArtifactImportJson(req: IncomingMessage): Promise<TenantOperatorCiArtifactImportRequestBody> {
  return readJsonBody<TenantOperatorCiArtifactImportRequestBody>(req);
}

async function readTenantOperatorAgsEvidenceImportJson(req: IncomingMessage): Promise<TenantOperatorAgsEvidenceImportRequestBody> {
  return readJsonBody<TenantOperatorAgsEvidenceImportRequestBody>(req);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const raw = await readRawBody(req);
  try {
    return JSON.parse(raw.toString("utf8") || "{}") as T;
  } catch {
    throw badRequest("invalid JSON body");
  }
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > HTTP_JSON_BODY_LIMIT_BYTES) throw payloadTooLarge("request body too large");
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function requireSafeName(value: unknown, field: string): string {
  const name = requireString(value, field);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw badRequest(`${field} must contain only letters, numbers, dot, underscore, or dash.`);
  }
  if (field === "project" && name === ".loom") {
    throw badRequest(`${field} is reserved.`);
  }
  return name;
}

function requireProjectName(value: unknown, field: string): string {
  const name = requireSafeName(value, field);
  if (name === ".loom") {
    throw badRequest(`${field} is reserved.`);
  }
  return name;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectTemplateName(value: unknown): ProjectTemplateName {
  if (value === undefined || value === null || value === "") return "empty";
  if (value === "empty" || value === "vas-lite") return value;
  throw badRequest("template must be empty or vas-lite.");
}

function runPresetName(value: unknown): RunPresetName | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === VAS_LITE_REVIEW_PRESET) return value;
  throw badRequest("preset must be vas-lite-review.");
}

function optionalSafeName(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireSafeName(value, field);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw badRequest(`${field} is required.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireString(value, field);
}

function optionalSha256Hex(value: unknown, field: string): string | undefined {
  const text = optionalString(value, field)?.trim().toLowerCase();
  if (!text) return undefined;
  if (!/^[a-f0-9]{64}$/.test(text)) throw badRequest(`${field} must be a lowercase sha256 hex string.`);
  return text;
}

async function optionalFileSha256(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(path, "utf8"), "utf8").digest("hex");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "boolean") throw badRequest(`${field} must be a boolean.`);
  return value;
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

function presenceClientId(value: unknown): string {
  const clientId = requireString(value, "clientId").trim();
  if (clientId.length > 120 || /[\0\r\n]/.test(clientId)) {
    throw badRequest("clientId must be a single-line string at most 120 characters.");
  }
  return clientId;
}

function optionalClientId(value: unknown): string | undefined {
  const clientId = optionalString(value, "clientId")?.trim();
  if (clientId === undefined) return undefined;
  if (clientId.length > 120 || /[\0\r\n]/.test(clientId)) {
    throw badRequest("clientId must be a single-line string at most 120 characters.");
  }
  return clientId;
}

function optionalClientRequestId(value: unknown): string | undefined {
  const clientRequestId = optionalString(value, "clientRequestId")?.trim();
  if (clientRequestId === undefined) return undefined;
  if (clientRequestId.length > 200 || /[\0\r\n]/.test(clientRequestId)) {
    throw badRequest("clientRequestId must be a single-line string at most 200 characters.");
  }
  return clientRequestId;
}

function runCommentMessage(value: unknown): string {
  const message = requireString(value, "message").trim();
  if (message.length > 4000 || /\0/.test(message)) {
    throw badRequest("message must be a string at most 4000 characters.");
  }
  return message;
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
  runDir: string,
  state: ReadableRunState,
  issue: string,
  comments: GiteaIssueComment[],
  context: IssueCommentSyncContext,
): Promise<IssueCommentSyncResult> {
  const existingEvents = await readRunEventsIfPresent(runDir);
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
    const event = await appendRunEvent(runDir, "user_message", prepared.data);
    syncedIds.add(prepared.id);
    events.push(event);
  }

  if (events.length && state.status !== "running" && state.status !== "queued") {
    const observed: RunSummary = { ...state, eventCount: events.at(-1)?.seq ?? ("eventCount" in state ? state.eventCount : existingEvents.length) };
    await writeRunSummary(observed);
    await writeRunStatus(runDir, observed);
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

async function linkedIssueVasCases(workspaceRoot: string, tenant: string, issue: string, project?: string): Promise<LinkedIssueVasCase[]> {
  const projects = project ? [project] : await listTenantProjectNames(workspaceRoot, tenant);
  const cases: LinkedIssueVasCase[] = [];
  for (const currentProject of projects) {
    const projectRoot = join(workspaceRoot, tenant, currentProject);
    const metadata = await readProjectTemplateMetadata(projectRoot, { tenant, project: currentProject });
    if (metadata?.template !== "vas-lite") continue;
    const sourceDefaults = await readProjectSourceDefaults(join(workspaceRoot, tenant), currentProject);
    let entries;
    try {
      entries = await readdir(join(projectRoot, "cases"), { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = await readVasLiteCase(projectRoot, entry.name);
      if ((stringField(record, "issue") ?? sourceDefaults.issue) !== issue) continue;
      cases.push({ project: currentProject, caseId: entry.name, record });
    }
  }
  cases.sort((a, b) => a.project.localeCompare(b.project) || a.caseId.localeCompare(b.caseId));
  return cases;
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
    });
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
      const sourceAuditTrail = runTenantAuditTrail(await readTenantAuditEvents(workspaceRoot, tenant), project, sourceRunId);
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

function linkedVasCaseIdsByProject(runs: LinkedIssueRun[], linkedCases: LinkedIssueVasCase[] = []): Map<string, Set<string>> {
  const caseIds = new Map<string, Set<string>>();
  for (const run of runs) {
    const caseId = vasLiteRunCaseId(run.state);
    if (!caseId) continue;
    const projectCases = caseIds.get(run.project) ?? new Set<string>();
    projectCases.add(caseId);
    caseIds.set(run.project, projectCases);
  }
  for (const entry of linkedCases) {
    const projectCases = caseIds.get(entry.project) ?? new Set<string>();
    projectCases.add(entry.caseId);
    caseIds.set(entry.project, projectCases);
  }
  return caseIds;
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
  const policy = await readTenantPolicy(resolve(workspaceRoot), tenant);
  const controlPlaneIdentity = policy?.controlPlaneIdentities?.find((identity) => identity.actor === fallbackActor);
  if (controlPlaneIdentity) {
    return { actor: controlPlaneIdentity.actor, role: controlPlaneIdentity.role };
  }
  const tenantApiKeys = [...(options.tenantApiKeys?.[tenant] ?? []), ...(policy?.apiKeys ?? [])];
  const matched = tenantApiKeys.find((key) => key.actor === fallbackActor || key.actor === login || key.actor === `gitea:${login}`);
  return { actor: fallbackActor, role: matched?.role ?? "viewer" };
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

function isProjectDirectoryName(name: string): boolean {
  try {
    requireProjectName(name, "project");
    return true;
  } catch {
    return false;
  }
}

function isSafeDirectoryName(name: string): boolean {
  try {
    requireSafeName(name, "name");
    return true;
  } catch {
    return false;
  }
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

function timingSafeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
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

function workspaceCommitMessage(value: unknown): string {
  const message = requireString(value, "message").trim();
  if (message.length > 200 || /[\0\r\n]/.test(message)) {
    throw badRequest("message must be a single-line string at most 200 characters.");
  }
  return message;
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

function envNameValue(value: unknown, field: string): string {
  const name = requireString(value, field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw badRequest(`${field} must be an environment variable name.`);
  }
  return name;
}

function optionalEnvNameValue(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const name = requireString(value, field).trim();
  return name ? envNameValue(name, field) : undefined;
}

const SECRET_BEARING_TEMPLATE_PARAMETER_PARTS = new Set(["token", "key", "secret", "password"]);

function templateParameterValue(value: string, field: string): string {
  const parameter = value.trim();
  const separator = parameter.indexOf("=");
  if (separator <= 0) {
    throw badRequest(`${field} must be formatted as name=value.`);
  }
  const name = parameter.slice(0, separator);
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw badRequest(`${field} name must contain only letters, numbers, dot, underscore, or dash.`);
  }
  if (hasSecretBearingNamePart(name, SECRET_BEARING_TEMPLATE_PARAMETER_PARTS)) {
    throw badRequest(`${field} name must not be secret-bearing.`);
  }
  if (parameter.includes("\0")) {
    throw badRequest(`${field} must not contain NUL bytes.`);
  }
  return parameter;
}

function hasSecretBearingNamePart(name: string, secretParts: Set<string>): boolean {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return parts.some((part) => secretParts.has(part));
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

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw badRequest(`${field} must be an array of strings.`);
  }
  return value;
}

function allowedToolSubset(value: unknown, serverAllowedTools: string[] | undefined): string[] {
  const serverTools = serverAllowedTools ?? [];
  if (value === undefined) return serverTools;
  const requested = stringArray(value, "allowedTools");
  const denied = requested.filter((tool) => !serverTools.includes(tool));
  if (denied.length) {
    throw badRequest(`allowedTools not permitted by server: ${denied.join(", ")}`);
  }
  return [...new Set(requested)];
}

function booleanFlag(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw badRequest(`${field} must be a boolean.`);
  }
  return value;
}

function positiveInt(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  return positiveIntValue(value, "maxIterations");
}

function positiveIntValue(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest(`${field} must be a positive integer.`);
  }
  return parsed;
}

function positiveNumberValue(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw badRequest(`${field} must be a positive number.`);
  }
  return parsed;
}

function nonNegativeNumberValue(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw badRequest(`${field} must be a non-negative number.`);
  }
  return parsed;
}

function dockerMemoryValue(value: unknown, field: string): string {
  const memory = requireString(value, field).trim();
  if (!/^[1-9][0-9]*[bkmgBKMG]?$/.test(memory)) {
    throw badRequest(`${field} must be a Docker memory size like 512m or 4g.`);
  }
  return memory;
}

function dockerNetworkValue(value: unknown, field: string): string {
  const network = requireString(value, field).trim();
  if (network === "host" || network === "bridge" || network.startsWith("container:")) {
    throw badRequest(`${field} is an unsafe Docker network mode.`);
  }
  if (network !== "none" && !/^[A-Za-z0-9_.-]+$/.test(network)) {
    throw badRequest(`${field} must be none or a named sandbox network.`);
  }
  return network;
}

function activeRunKey(tenant: string, project: string, runId: string): string {
  return `${tenant}\0${project}\0${runId}`;
}

function projectPresenceRootFromProjectRoot(projectRoot: string): string {
  return join(projectRoot, ".loom", "presence", "project");
}

function runPresenceRootFromProjectRoot(projectRoot: string, runId: string): string {
  return join(projectRoot, ".loom", "runs", runId, "presence");
}

function presenceFilePath(root: string, clientId: string): string {
  return join(root, `${createHash("sha256").update(clientId).digest("hex")}.json`);
}

async function persistPresenceEntry(root: string, entry: StoredRunPresenceEntry): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeJsonFileAtomic(presenceFilePath(root, entry.clientId), entry);
}

async function refreshProjectPresenceFromDisk(
  presence: RunPresenceRegistry,
  projectRoot: string,
  tenant: string,
  project: string,
): Promise<void> {
  await refreshPresenceDirectory(presence, projectPresenceRootFromProjectRoot(projectRoot), { tenant, project });
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

function projectPresenceKey(tenant: string, project: string, clientId: string): string {
  return `${tenant}\0${project}\0${clientId}`;
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

function publicRunPresenceEntry(entry: StoredRunPresenceEntry): RunPresenceEntry {
  const { expiresAtMs: _expiresAtMs, ...publicEntry } = entry;
  return publicEntry;
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

async function harnessConcurrencyAdmissionStatus(
  options: HarnessServerOptions,
  tenant?: string,
): Promise<HarnessConcurrencyAdmissionStatus> {
  const workspaceIsolation = runWorkspaceIsolation(options);
  const tenantActiveRunLimitValue = tenant === undefined
    ? tenantActiveRunLimit(options)
    : await effectiveTenantActiveRunLimit(options, tenant);
  const tenantWorkspaceSessionLimitValue = tenant === undefined
    ? tenantWorkspaceSessionLimit(options)
    : await effectiveTenantWorkspaceSessionLimit(options, tenant);
  return {
    schemaVersion: "loom-concurrency-admission/v1",
    runWorkspaceIsolation: workspaceIsolation,
    activeRun: {
      claimScope: workspaceIsolation === "run" ? "run" : "project",
      claimPattern: workspaceIsolation === "run"
        ? `<tenant>/<project>/.loom/runs/${RUN_ADMISSION_DIR}/<runId>.lock.json`
        : `<tenant>/<project>/.loom/runs/${RUN_ADMISSION_DIR}/${PROJECT_RUN_ADMISSION_LOCK_FILE}`,
      leaseTtlMs: runLeaseTtlMs(options),
      crossServer: true,
      staleClaimCleanup: true,
    },
    tenantActiveRuns: {
      enabled: tenantActiveRunLimitValue !== undefined,
      limit: tenantActiveRunLimitValue ?? null,
      claimPattern: `<tenant>/.loom/${TENANT_ADMISSION_DIR}/${TENANT_ACTIVE_RUN_ADMISSION_DIR}/<runId>.json`,
      mutexPattern: `<tenant>/.loom/${TENANT_ADMISSION_DIR}/${TENANT_ACTIVE_RUN_ADMISSION_LOCK_DIR}`,
      crossServer: true,
      staleClaimCleanup: true,
    },
    workspaceSessions: {
      globalLimit: workspaceSessionLimit(options),
      tenantLimit: tenantWorkspaceSessionLimitValue,
      globalClaimPattern: `.loom/${TENANT_ADMISSION_DIR}/${WORKSPACE_SESSION_ADMISSION_DIR}/<sessionId>.json`,
      tenantClaimPattern: `<tenant>/.loom/${TENANT_ADMISSION_DIR}/${TENANT_WORKSPACE_SESSION_ADMISSION_DIR}/<sessionId>.json`,
      mutexPattern: WORKSPACE_SESSION_ADMISSION_LOCK_DIR,
      crossServer: true,
      staleClaimCleanup: true,
    },
    queueing: {
      asyncRuns: true,
      persistedSnapshots: true,
      restartRecovery: true,
      blockedReasons: ["tenant_active_run_limit", "project_active_workspace", "persisted_running_run"],
    },
    operatorCockpitQueue: operatorCockpitQueueBackendStatus(options, tenant),
    runControl: {
      crossServer: true,
      requestFiles: [RUN_PAUSE_REQUEST_FILE, RUN_CANCEL_REQUEST_FILE],
      ownerLoopPollMs: RUN_CONTROL_POLL_INTERVAL_MS,
    },
    idempotency: runCreateIdempotencyStatus(),
  };
}

function operatorCockpitQueueBackendStatus(
  options: HarnessServerOptions,
  tenant?: string,
): HarnessConcurrencyAdmissionStatus["operatorCockpitQueue"] {
  const requestedBackend = options.operatorCockpitQueueBackend ?? "filesystem";
  const agentGitServiceCandidate = operatorCockpitQueueAgentGitServiceCandidateStatus(options, tenant);
  const activeBackend = activeOperatorCockpitQueueBackendName(options, tenant);
  const agsQueueConfig = operatorCockpitQueueAgentGitServiceStoreConfig(options);
  const queueItemPattern = `<operatorBundleDir>/.loom/${OPERATOR_COCKPIT_EXECUTION_QUEUE_DIR}/<queueId>.json`;
  const claimPattern = `<operatorBundleDir>/.loom/${OPERATOR_COCKPIT_EXECUTION_QUEUE_DIR}/<queueId>.claim.json`;
  return {
    backend: activeBackend,
    requestedBackend,
    activeBackend,
    ...(requestedBackend === "agent-git-service" && activeBackend !== "agent-git-service"
      ? {
          fallbackReason: !agentGitServiceCandidate.ready
            ? "agent-git-service-candidate-not-ready" as const
            : agsQueueConfig.state === "missing"
              ? "agent-git-service-queue-repo-missing" as const
              : "agent-git-service-queue-config-invalid" as const,
        }
      : {}),
    queueItemPattern,
    claimPattern,
    store: activeBackend === "agent-git-service" && agsQueueConfig.state === "ready"
      ? {
          kind: "agent-git-service-contents",
          repo: agsQueueConfig.repo,
          path: agsQueueConfig.path,
        }
      : {
          kind: "filesystem",
          queueItemPattern,
          claimPattern,
        },
    persistedSnapshots: true,
    restartRecovery: true,
    sharedBundleClaims: true,
    staleClaimCleanup: true,
    claimTtlMs: OPERATOR_COCKPIT_EXECUTION_QUEUE_CLAIM_TTL_MS,
    futureBackends: ["agent-git-service"],
    candidateBackends: {
      agentGitService: agentGitServiceCandidate,
    },
  };
}

function createOperatorCockpitQueueBackend(options: HarnessServerOptions): OperatorCockpitQueueBackend {
  if (activeOperatorCockpitQueueBackendName(options) === "agent-git-service") {
    return createAgentGitServiceOperatorCockpitQueueBackend({
      baseUrl: options.controlPlaneBaseUrl as string,
      token: operatorCockpitQueueAgentGitServiceToken(options) as string,
      repo: options.operatorCockpitQueueAgentGitServiceRepo as string,
      path: options.operatorCockpitQueueAgentGitServicePath,
    });
  }
  return createFilesystemOperatorCockpitQueueBackend();
}

function activeOperatorCockpitQueueBackendName(options: HarnessServerOptions, tenant?: string): OperatorCockpitQueueBackendName {
  if ((options.operatorCockpitQueueBackend ?? "filesystem") !== "agent-git-service") return "filesystem";
  const candidate = operatorCockpitQueueAgentGitServiceCandidateStatus(options, tenant);
  if (!candidate.ready) return "filesystem";
  if (operatorCockpitQueueAgentGitServiceStoreConfig(options).state !== "ready") return "filesystem";
  return "agent-git-service";
}

type OperatorCockpitQueueAgentGitServiceStoreConfig =
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "ready"; repo: string; path: string };

function operatorCockpitQueueAgentGitServiceStoreConfig(
  options: HarnessServerOptions,
): OperatorCockpitQueueAgentGitServiceStoreConfig {
  const repo = options.operatorCockpitQueueAgentGitServiceRepo?.trim();
  if (!repo) return { state: "missing" };
  try {
    return {
      state: "ready",
      repo: normalizeAgentGitServiceOperatorCockpitQueueRepo(repo),
      path: normalizeAgentGitServiceOperatorCockpitQueuePath(
        options.operatorCockpitQueueAgentGitServicePath ?? DEFAULT_AGENT_GIT_SERVICE_OPERATOR_COCKPIT_QUEUE_STORE_PATH,
      ),
    };
  } catch {
    return { state: "invalid" };
  }
}

function operatorCockpitQueueAgentGitServiceToken(options: HarnessServerOptions, tenant?: string): string | undefined {
  return (tenant ? options.controlPlaneTenantTokens?.[tenant]?.trim() : undefined)
    || options.controlPlaneAdminToken?.trim()
    || Object.values(options.controlPlaneTenantTokens ?? {}).find((token) => token.trim())?.trim();
}

function operatorCockpitQueueAgentGitServiceCandidateStatus(
  options: HarnessServerOptions,
  tenant?: string,
): HarnessConcurrencyAdmissionStatus["operatorCockpitQueue"]["candidateBackends"]["agentGitService"] {
  const provider = controlPlaneProviderName(options) === "agent-git-service";
  const baseUrl = Boolean(options.controlPlaneBaseUrl?.trim());
  const token = Boolean(operatorCockpitQueueAgentGitServiceToken(options, tenant));
  const missing: Array<"controlPlaneProvider" | "controlPlaneBaseUrl" | "controlPlaneToken"> = [];
  if (!provider) missing.push("controlPlaneProvider");
  if (!baseUrl) missing.push("controlPlaneBaseUrl");
  if (!token) missing.push("controlPlaneToken");
  return {
    backend: "agent-git-service",
    ready: missing.length === 0,
    configured: {
      provider,
      baseUrl,
      token,
    },
    missing,
  };
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

function activeWorkspaceKey(tenant: string, project: string, runId?: string): string {
  return runId === undefined ? `${tenant}\0${project}` : `${tenant}\0${project}\0${runId}`;
}

function badRequest(message: string): Error {
  const error = new Error(message);
  error.name = "BadRequest";
  return error;
}

function payloadTooLarge(message: string): Error {
  const error = new Error(message);
  error.name = "PayloadTooLarge";
  return error;
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}

function unauthorized(message: string): Error {
  const error = new Error(message);
  error.name = "Unauthorized";
  return error;
}

function forbidden(message: string): Error {
  const error = new Error(message);
  error.name = "Forbidden";
  return error;
}

function notFound(message: string): Error {
  const error = new Error(message);
  error.name = "NotFound";
  return error;
}

function statusForError(error: unknown): number {
  if (!(error instanceof Error)) return 500;
  if (error.name === "BadRequest") return 400;
  if (error.name === "PayloadTooLarge") return 413;
  if (error.name === "Conflict") return 409;
  if (error.name === "Unauthorized") return 401;
  if (error.name === "Forbidden") return 403;
  if (error.name === "NotFound") return 404;
  return 500;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2) + "\n");
}

function writeText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function writeHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization, x-loom-tenant-token, last-event-id");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function startedAt(state: RunSummary | RunningRunStatus | QueuedRunStatus): string {
  return "queuedAt" in state ? state.queuedAt : state.startedAt;
}
