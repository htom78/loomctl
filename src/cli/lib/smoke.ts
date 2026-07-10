import { SERVE_CONTROL_PLANE_PROVIDERS } from "../../harness/control-plane.js";
import { HARNESS_VISION_LOCK, HARNESS_VISION_LOCK_TARGET_MARKERS, ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES } from "../../harness/profile-contract.js";
import { projectTemplateDefaultSkills, type ProjectTemplateName } from "../../harness/project-templates.js";
import { type ControlPlaneProviderName } from "../../harness/server.js";
import { boundedErrorText, cliTokenValue, type HarnessOnlineProfileName, isRecord, normalizeHttpBaseUrl, parseControlPlaneProviderFlag, parseJsonResponse, parseOnlineProfileFlag, parseProjectTemplateFlag, parseSafeNameFlag } from "./flags.js";
import { verifySmokeAgentGitServiceCutover, verifySmokeBrainSignal, verifySmokeCoderWorkspace, verifySmokeExpectedControlPlaneProvider, verifySmokeGiteaComments, verifySmokeGiteaPr, verifySmokeOnlineSurfaces, verifySmokeProjectContract, verifySmokeProjectSourceDefaults, verifySmokeRunSourceDefaults, verifySmokeVasBrainLearning, verifySmokeVasLiteProject } from "./smoke-verify-integrations.js";
import { verifySmokeAuthRoles, verifySmokeBackupManifest, verifySmokeGates, verifySmokeHealthProbes, verifySmokeMetrics, verifySmokeOnlineSandboxGoldenPath, verifySmokePolicyEscalation, verifySmokeServerProfile, verifySmokeTenantIsolation, verifySmokeTenantProfileTools, verifySmokeWarningMetrics } from "./smoke-verify-platform.js";
import { verifySmokeFileCollab, verifySmokeHandoffEvidence, verifySmokeModelRun, verifySmokeRunControls, verifySmokeWorkspaceCommand, verifySmokeWorkspaceSession } from "./smoke-verify-runs.js";
import { createHmac } from "node:crypto";
import { join, resolve } from "node:path";

export interface HarnessSmokeCliOptions {
  url: string;
  peerUrl?: string;
  tenant: string;
  project: string;
  template: string;
  token?: string;
  tokenEnv?: string;
  viewerToken?: string;
  viewerTokenEnv?: string;
  adminToken?: string;
  adminTokenEnv?: string;
  isolationTenant?: string;
  profile?: string;
  controlPlaneProvider?: string;
  controlPlaneWebhookSecretEnv?: string;
  giteaWebhookSecretEnv?: string;
  checkCommand?: boolean;
  checkSession?: boolean;
  checkVas?: boolean;
  checkOnline?: boolean;
  checkAuthRoles?: boolean;
  checkGates?: boolean;
  checkEscalations?: boolean;
  checkHandoff?: boolean;
  checkRunControls?: boolean;
  checkFileCollab?: boolean;
  checkBrain?: boolean;
  checkModel?: boolean;
  checkControlPlanePr?: boolean;
  checkControlPlaneComments?: boolean;
  checkGiteaPr?: boolean;
  checkGiteaComments?: boolean;
  checkBackup?: boolean;
  checkMetrics?: boolean;
  checkAgentGitServiceCutover?: boolean;
  checkCoder?: boolean;
  report?: string;
}

export interface HarnessSmokeMetricsResult {
  metricsChecked: true;
  metricsReady: boolean;
  metricsNames: string[];
  metricsActiveRuns: number;
  metricsQueuedRuns: number;
  metricsActiveWorkspaceSessions: number;
  metricsOrphanedRunningRuns: number;
  metricsReviewRequiredRuns: number;
  metricsDeploymentRequiredRuns: number;
  metricsModelUsageWarningProjects: number;
  metricsWorkspaceUsageWarningProjects: number;
  metricsLowCardinalityChecked: true;
  metricsSensitiveLabelsAbsent: true;
}

export interface HarnessSmokeResult {
  ok: true;
  url: string;
  peerUrl?: string;
  tenant: string;
  project: string;
  template: ProjectTemplateName;
  profile?: HarnessSmokeProfileName;
  serverProfile?: HarnessSmokeProfileName;
  serverProfileChecked?: boolean;
  serverAllowedTools?: string[];
  serverAllowedToolsChecked?: boolean;
  serverReadinessChecked?: boolean;
  serverReadinessOk?: boolean;
  serverReadinessMissing?: string[];
  serverGoldenPathChecked?: boolean;
  serverGoldenPathOk?: boolean;
  serverGoldenPathCapabilities?: string[];
  serverGoldenPathMissingCapabilities?: string[];
  healthProbesChecked?: boolean;
  healthzChecked?: boolean;
  healthzOk?: boolean;
  healthzStartedAt?: string;
  healthzUptimeMs?: number;
  readyzChecked?: boolean;
  readyzReady?: boolean;
  readyzStartedAt?: string;
  readyzUptimeMs?: number;
  readyzCheckNames?: string[];
  healthProbesSensitiveFieldsAbsent?: boolean;
  metricsChecked?: boolean;
  metricsReady?: boolean;
  metricsNames?: string[];
  metricsActiveRuns?: number;
  metricsQueuedRuns?: number;
  metricsActiveWorkspaceSessions?: number;
  metricsOrphanedRunningRuns?: number;
  metricsReviewRequiredRuns?: number;
  metricsDeploymentRequiredRuns?: number;
  metricsModelUsageWarningProjects?: number;
  metricsWorkspaceUsageWarningProjects?: number;
  metricsLowCardinalityChecked?: boolean;
  metricsSensitiveLabelsAbsent?: boolean;
  serverRunWorkspaceIsolation?: string;
  serverConcurrencyAdmissionChecked?: boolean;
  serverConcurrencyAdmissionSchemaVersion?: string;
  serverConcurrencyAdmissionRunWorkspaceIsolation?: string;
  serverConcurrencyAdmissionActiveRunClaimScope?: string;
  serverConcurrencyAdmissionQueueBlockedReasons?: string[];
  serverConcurrencyAdmissionRunControlCrossServer?: boolean;
  serverControlPlaneChecked?: boolean;
  serverControlPlaneProvider?: string;
  serverControlPlaneBoundary?: string[];
  serverControlPlaneApiBasePath?: string;
  serverControlPlaneDiscoveryEndpoints?: string[];
  serverControlPlaneNativeCapabilities?: string[];
  serverControlPlaneAdoptionStages?: string[];
  serverControlPlaneGatedAdoptionStages?: string[];
  serverControlPlaneTenantDefaultCutoverGated?: boolean;
  serverControlPlaneDiscoveryChecked?: boolean;
  serverControlPlaneDiscoveryProvider?: string;
  serverControlPlaneDiscoveryOk?: boolean;
  serverControlPlaneDiscoveryBaseUrlConfigured?: boolean;
  serverControlPlaneDiscoveryEndpointCount?: number;
  serverControlPlaneDiscoveryOkEndpointCount?: number;
  serverControlPlaneDiscoveryMissingEndpoints?: string[];
  serverControlPlaneDiscoveryTokenMode?: string;
  serverControlPlaneDiscoveryTenantCount?: number;
  serverControlPlaneDiscoveryTenantOkCount?: number;
  serverControlPlaneDiscoveryMissingTenants?: string[];
  controlPlaneWorkspaceBranchLeaseChecked?: boolean;
  controlPlaneWorkspaceBranchLeaseProvider?: string;
  controlPlaneWorkspaceBranchLeaseIsolation?: string;
  controlPlaneWorkspaceBranchLeaseBranchDerivation?: string;
  controlPlaneWorkspaceBranchLeaseActiveRunLeaseEvidence?: boolean;
  agentGitServiceProjectAgentsChecked?: boolean;
  agentGitServiceProjectAgentsProvider?: string;
  agentGitServiceProjectAgentsOk?: boolean;
  agentGitServiceProjectAgentsTenantCount?: number;
  agentGitServiceProjectAgentsProjectCount?: number;
  agentGitServiceProjectAgentsProvisionedProjectCount?: number;
  agentGitServiceProjectAgentsSecretRootConfigured?: boolean;
  agentGitServiceProjectAgentsSecretStoredProjectCount?: number;
  agentGitServiceProjectAgentsMissingProjects?: string[];
  agentGitServiceProjectAgentsMissingSecretProjects?: string[];
  visionLockChecked?: boolean;
  visionLockTarget?: string;
  visionLockMvpIsScopeReduction?: boolean;
  visionLockCapabilities?: string[];
  viewerTenantReadinessChecked?: boolean;
  viewerTenantReadinessProfile?: string;
  viewerTenantReadinessOk?: boolean;
  viewerTenantReadinessMissing?: string[];
  viewerTenantGoldenPathChecked?: boolean;
  viewerTenantGoldenPathOk?: boolean;
  viewerTenantGoldenPathCapabilities?: string[];
  viewerTenantGoldenPathMissingCapabilities?: string[];
  viewerTenantVisionLockChecked?: boolean;
  viewerTenantVisionLockTarget?: string;
  viewerTenantVisionLockMvpIsScopeReduction?: boolean;
  viewerTenantVisionLockCapabilities?: string[];
  tenantAllowedTools?: string[];
  tenantAllowedToolsChecked?: boolean;
  tenantReadinessChecked?: boolean;
  tenantReadinessProfile?: string;
  tenantReadinessOk?: boolean;
  tenantReadinessMissing?: string[];
  tenantGoldenPathChecked?: boolean;
  tenantGoldenPathOk?: boolean;
  tenantGoldenPathCapabilities?: string[];
  tenantGoldenPathMissingCapabilities?: string[];
  tenantRunWorkspaceIsolation?: string;
  tenantConcurrencyAdmissionChecked?: boolean;
  tenantConcurrencyAdmissionSchemaVersion?: string;
  tenantConcurrencyAdmissionRunWorkspaceIsolation?: string;
  tenantConcurrencyAdmissionActiveRunClaimScope?: string;
  tenantConcurrencyAdmissionQueueBlockedReasons?: string[];
  tenantConcurrencyAdmissionRunControlCrossServer?: boolean;
  tenantControlPlaneChecked?: boolean;
  tenantControlPlaneProvider?: string;
  tenantControlPlaneBoundary?: string[];
  tenantControlPlaneAdoptionStages?: string[];
  tenantControlPlaneGatedAdoptionStages?: string[];
  tenantControlPlaneTenantDefaultCutoverGated?: boolean;
  tenantControlPlaneDiscoveryChecked?: boolean;
  tenantControlPlaneDiscoveryProvider?: string;
  tenantControlPlaneDiscoveryOk?: boolean;
  tenantControlPlaneDiscoveryBaseUrlConfigured?: boolean;
  tenantControlPlaneDiscoveryEndpointCount?: number;
  tenantControlPlaneDiscoveryOkEndpointCount?: number;
  tenantControlPlaneDiscoveryMissingEndpoints?: string[];
  tenantControlPlaneDiscoveryTokenMode?: string;
  tenantControlPlaneDiscoveryTenantCount?: number;
  tenantControlPlaneDiscoveryTenantOkCount?: number;
  tenantControlPlaneDiscoveryMissingTenants?: string[];
  tenantVisionLockChecked?: boolean;
  tenantVisionLockTarget?: string;
  tenantVisionLockMvpIsScopeReduction?: boolean;
  tenantVisionLockCapabilities?: string[];
  onlineSandboxGoldenPathChecked?: boolean;
  onlineSandboxGoldenPathProfile?: HarnessSmokeProfileName;
  onlineSandboxGoldenPathCapabilities?: string[];
  projectContractChecked?: boolean;
  projectContractOk?: boolean;
  projectContractMissing?: string[];
  projectGoldenDefaultsChecked?: boolean;
  projectDefaultSkills?: string[];
  projectRunPolicy?: HarnessSmokeProjectRunPolicy;
  projectContractObjective?: string;
  projectCreated: boolean;
  runId: string;
  status: string;
  workspaceArtifactPath: string;
  workspaceArtifactRead: boolean;
  workspaceArtifactContent: string;
  workspaceContextRead: boolean;
  workspaceContextKind: string;
  workspaceCommandRun?: boolean;
  workspaceCommand?: string;
  workspaceCommandStdout?: string;
  workspaceCommandExitCode?: number;
  workspaceSessionRun?: boolean;
  workspaceSessionId?: string;
  workspaceSessionCommand?: string;
  workspaceSessionInputAccepted?: boolean;
  workspaceSessionOutput?: string;
  workspaceSessionExitCode?: number;
  vasReadinessChecked?: boolean;
  vasTemplate?: "vas-lite";
  vasBootstrapCaseId?: "bootstrap";
  vasBootstrapCaseFound?: boolean;
  vasBootstrapCaseStatus?: string;
  vasReviewQueueRead?: boolean;
  vasReviewQueueCaseCount?: number;
  vasReviewPackageRead?: boolean;
  vasReviewPackageCaseId?: "bootstrap";
  vasReviewRunExecuted?: boolean;
  vasReviewRunId?: string;
  vasReviewRunStatus?: string;
  vasReviewRunPreset?: "vas-lite-review";
  vasReviewRunCaseId?: "bootstrap";
  vasReviewArtifactsRead?: boolean;
  vasReviewReportPath?: string;
  vasReviewContextPath?: string;
  vasReviewContextCaseId?: "bootstrap";
  vasReviewGateChecked?: boolean;
  vasReviewGateCaseId?: string;
  vasReviewGateRunId?: string;
  vasReviewGateRunStatus?: "review_required";
  vasReviewGateDecision?: "approved";
  vasReviewGateCaseStatus?: "reviewed";
  vasReviewLearningRecorded?: boolean;
  vasReviewLearningText?: string;
  vasReviewLearnedPatternsRead?: boolean;
  vasBrainLearningChecked?: boolean;
  vasBrainLearningSource?: "vas_learning";
  vasBrainLearningCaseId?: string;
  vasBrainLearningRunId?: string;
  vasBrainLearningCount?: number;
  vasBrainLearningSkillCount?: number;
  vasBrainLearningFeedChecked?: boolean;
  onlineSurfacesChecked?: boolean;
  dashboardHtmlRead?: boolean;
  dashboardReadinessLabelsChecked?: boolean;
  dashboardTenantReadinessLabel?: string;
  dashboardGlobalReadinessLabel?: string;
  dashboardBrainFeedChecked?: boolean;
  dashboardTokenScrubChecked?: boolean;
  dashboardAgentGitServiceProvisioningChecked?: boolean;
  dashboardProjectConcurrencyChecked?: boolean;
  workbenchHtmlRead?: boolean;
  workbenchBrainFeedChecked?: boolean;
  workbenchTokenScrubChecked?: boolean;
  projectPresenceChecked?: boolean;
  projectPresenceCollaboratorCount?: number;
  runPresenceChecked?: boolean;
  runPresenceCollaboratorCount?: number;
  onlineRunCommentAdded?: boolean;
  onlineRunCommentReplayChecked?: boolean;
  onlineRunCommentText?: string;
  fileCollabChecked?: boolean;
  fileCollabPath?: string;
  fileCollabBaseRead?: boolean;
  fileCollabActiveEditorClientId?: string;
  fileCollabActiveEditorLabel?: string;
  fileCollabStaleSaveDenied?: boolean;
  fileCollabStaleMoveDenied?: boolean;
  fileCollabStaleDeleteDenied?: boolean;
  fileCollabReloadedContent?: string;
  fileCollabAuditChecked?: boolean;
  runFileCollabChecked?: boolean;
  runFileCollabRunId?: string;
  runFileCollabPath?: string;
  runFileCollabActiveEditorClientId?: string;
  runFileCollabActiveEditorLabel?: string;
  runFileCollabStaleSaveDenied?: boolean;
  runFileCollabStaleMoveDenied?: boolean;
  runFileCollabStaleDeleteDenied?: boolean;
  runFileCollabReloadedContent?: string;
  runFileCollabAuditChecked?: boolean;
  authRolesChecked?: boolean;
  developerAccessActor?: string;
  developerAccessRole?: string;
  viewerAccessActor?: string;
  viewerAccessRole?: "viewer";
  viewerCreateRunDenied?: boolean;
  viewerWorkspaceWriteDenied?: boolean;
  viewerRunCommentAdded?: boolean;
  viewerRunCommentReplayChecked?: boolean;
  gatesChecked?: boolean;
  gateRunId?: string;
  reviewGateChecked?: boolean;
  reviewGateRunStatus?: "review_required";
  reviewGateDecision?: "approved";
  reviewGateDecidedRole?: "developer";
  reviewGateMetricsChecked?: boolean;
  reviewGateMetricsReviewRequiredRuns?: number;
  deploymentGateChecked?: boolean;
  deploymentGateDeveloperDenied?: boolean;
  deploymentGateRunStatus?: "deployment_required";
  deploymentGateDecision?: "approved";
  deploymentGateDecidedRole?: "admin";
  deploymentGateMetricsChecked?: boolean;
  deploymentGateMetricsDeploymentRequiredRuns?: number;
  gateRunFinalStatus?: "passed";
  modelWarningMetricsChecked?: boolean;
  modelWarningMetricsModelUsageWarningProjects?: number;
  modelWarningQueueChecked?: boolean;
  modelWarningQueueProject?: string;
  modelWarningQueueWarningCount?: number;
  modelWarningEscalationChecked?: boolean;
  modelWarningEscalationId?: string;
  modelWarningEscalationSourceKind?: "model_usage_warning";
  workspaceWarningMetricsChecked?: boolean;
  workspaceWarningMetricsWorkspaceUsageWarningProjects?: number;
  workspaceWarningQueueChecked?: boolean;
  workspaceWarningQueueProject?: string;
  workspaceWarningQueueWarningCount?: number;
  workspaceWarningEscalationChecked?: boolean;
  workspaceWarningEscalationId?: string;
  workspaceWarningEscalationSourceKind?: "workspace_usage_warning";
  warningEscalationAuditChecked?: boolean;
  policyEscalationChecked?: boolean;
  policyEscalationId?: string;
  policyEscalationStatus?: "approved";
  policyEscalationRequestedTool?: "shell.exec";
  policyEscalationSourceKind?: "workspace_pr";
  policyEscalationDeveloperDecisionDenied?: boolean;
  policyEscalationDecidedRole?: "admin";
  policyEscalationToolAdded?: boolean;
  policyEscalationLimitChanged?: boolean;
  policyEscalationAuditChecked?: boolean;
  sourceDefaultsChecked?: boolean;
  sourceDefaultsRepo?: string;
  sourceDefaultsBranch?: string;
  sourceDefaultsBaseBranch?: string;
  sourceDefaultsIssue?: string;
  sourceDefaultsIssueUrl?: string;
  handoffEvidenceChecked?: boolean;
  reviewSummaryRead?: boolean;
  reviewSummaryRunId?: string;
  reviewSummaryStatus?: string;
  reviewSummaryTimelineChecked?: boolean;
  reviewSummaryContractEvidenceChecked?: boolean;
  handoffPackageRead?: boolean;
  handoffPackageRunId?: string;
  handoffPackageReviewSummaryChecked?: boolean;
  handoffPackageContractEvidenceChecked?: boolean;
  handoffPackageAuditTrailChecked?: boolean;
  handoffPackageLinksChecked?: boolean;
  handoffFollowupCreated?: boolean;
  handoffFollowupRunId?: string;
  handoffFollowupRunStatus?: string;
  handoffFollowupSourceRunId?: string;
  handoffFollowupSourceContractEvidenceChecked?: boolean;
  handoffSourceDefaultsChecked?: boolean;
  handoffFollowupSourceDefaultsChecked?: boolean;
  handoffFollowupRepo?: string;
  handoffFollowupBranch?: string;
  handoffFollowupBaseBranch?: string;
  handoffFollowupIssue?: string;
  handoffFollowupIssueUrl?: string;
  runScopedPullRequestDuringActiveRunChecked?: boolean;
  runScopedPullRequestDuringActiveRunId?: string;
  runScopedPullRequestDuringActiveRunBranch?: string;
  runScopedPullRequestDuringActiveRunCommit?: string;
  runScopedPullRequestDuringActiveRunPush?: boolean;
  runScopedPullRequestDuringActiveRunIndex?: number;
  runScopedPullRequestDuringActiveRunUrl?: string;
  runScopedFileWriteDuringActiveRunChecked?: boolean;
  runScopedFileWriteDuringActiveRunBlockedRunId?: string;
  runScopedFileWriteDuringActiveRunAllowedRunId?: string;
  runScopedFileWriteDuringActiveRunPath?: string;
  runScopedFileWriteDuringActiveRunDenied?: boolean;
  multiAgentConcurrencyChecked?: boolean;
  multiAgentConcurrencyIsolation?: "run";
  multiAgentConcurrencyActiveRunLeaseChecked?: boolean;
  multiAgentConcurrencyRunScopedFileWriteChecked?: boolean;
  multiAgentConcurrencyRunScopedPrHandoffChecked?: boolean;
  multiAgentConcurrencyBranch?: string;
  multiAgentConcurrencyCrossServerChecked?: boolean;
  multiAgentConcurrencyCrossServerIdempotencyChecked?: boolean;
  handoffFollowupListChecked?: boolean;
  handoffFollowupCount?: number;
  handoffContractPatchEvidenceChecked?: boolean;
  handoffContractPatchRunId?: string;
  handoffContractPatchReviewSummaryChecked?: boolean;
  handoffContractPatchGateTrailChecked?: boolean;
  handoffContractPatchReplayChecked?: boolean;
  runControlsChecked?: boolean;
  pauseResumeChecked?: boolean;
  pauseResumeRunId?: string;
  activeRunLeaseChecked?: boolean;
  activeRunLeaseRunId?: string;
  activeRunLeaseScope?: string;
  activeRunLeaseKey?: string;
  pauseRequested?: boolean;
  pauseRequestRole?: string;
  pausedRunStatus?: string;
  resumeRequested?: boolean;
  resumeRequestRole?: string;
  resumedRunStatus?: string;
  pauseResumeTraceContent?: string;
  cancelChecked?: boolean;
  cancelRunId?: string;
  cancelRunStatus?: string;
  cancelReplayChecked?: boolean;
  runControlsPeerUrl?: string;
  crossServerPauseChecked?: boolean;
  crossServerActiveRunLeaseChecked?: boolean;
  crossServerActiveRunLeaseRunId?: string;
  crossServerActiveRunLeaseScope?: string;
  crossServerActiveRunLeaseKey?: string;
  crossServerPauseRunId?: string;
  crossServerPauseRequested?: boolean;
  crossServerPauseRunStatus?: string;
  crossServerCancelChecked?: boolean;
  crossServerCancelRunId?: string;
  crossServerCancelRequested?: boolean;
  crossServerCancelRunStatus?: string;
  runControlAuditChecked?: boolean;
  brainSignalChecked?: boolean;
  brainSignalRunId?: string;
  brainSignalOutcome?: "pass";
  brainSignalSkillCount?: number;
  brainSignalAuditChecked?: boolean;
  brainRunIngestChecked?: boolean;
  brainRunIngestRunId?: string;
  brainRunIngestOutcome?: "pass";
  brainRunIngestExternalEffectChecked?: boolean;
  brainRunIngestAuditChecked?: boolean;
  brainSignalFeedChecked?: boolean;
  brainSignalFeedCount?: number;
  brainSignalFeedRunIngestChecked?: boolean;
  brainSignalFeedWorkspaceSignalChecked?: boolean;
  modelRunChecked?: boolean;
  modelRunId?: string;
  modelRunStatus?: "passed";
  modelRunModel?: string;
  modelRunArtifactPath?: string;
  modelRunArtifactRead?: boolean;
  modelRunArtifactContent?: string;
  modelRunUsageRequestCount?: number;
  modelRunUsageTotalTokens?: number;
  modelRunUsageCostUsd?: number;
  modelRunReplayChecked?: boolean;
  controlPlanePrChecked?: boolean;
  controlPlanePrProvider?: string;
  controlPlanePrRunId?: string;
  controlPlanePrRunStatus?: "review_required";
  controlPlanePrIssue?: string;
  controlPlanePrIssueUrl?: string;
  controlPlanePrBranch?: string;
  controlPlanePrBaseBranch?: string;
  controlPlanePrIndex?: number;
  controlPlanePrUrl?: string;
  controlPlanePrExternalEffectChecked?: boolean;
  giteaPrChecked?: boolean;
  giteaPrRunId?: string;
  giteaPrRunStatus?: "review_required";
  giteaPrIssue?: string;
  giteaPrBranch?: string;
  giteaPrBaseBranch?: string;
  giteaPrIndex?: number;
  giteaPrUrl?: string;
  giteaPrExternalEffectChecked?: boolean;
  controlPlaneCommentsChecked?: boolean;
  controlPlaneCommentsProvider?: string;
  controlPlaneCommentsRunId?: string;
  controlPlaneCommentsIssue?: string;
  controlPlaneCommentsIssueUrl?: string;
  controlPlaneCommentsSynced?: number;
  controlPlaneCommentsRunReviewRequested?: number;
  controlPlaneCommentsRunReviewed?: number;
  controlPlaneCommentsRunStatus?: "passed";
  controlPlaneCommentsReplayChecked?: boolean;
  controlPlaneCommentsAuditChecked?: boolean;
  controlPlaneCommentsWebhookChecked?: boolean;
  controlPlaneCommentsWebhookProvider?: string;
  controlPlaneCommentsWebhookRunId?: string;
  controlPlaneCommentsWebhookIssue?: string;
  controlPlaneCommentsWebhookIssueUrl?: string;
  controlPlaneCommentsWebhookSynced?: number;
  controlPlaneCommentsWebhookRunReviewRequested?: number;
  controlPlaneCommentsWebhookRunReviewed?: number;
  controlPlaneCommentsWebhookRunStatus?: "passed";
  controlPlaneCommentsWebhookAuditChecked?: boolean;
  giteaCommentsChecked?: boolean;
  giteaCommentsRunId?: string;
  giteaCommentsIssue?: string;
  giteaCommentsSynced?: number;
  giteaCommentsRunReviewRequested?: number;
  giteaCommentsRunReviewed?: number;
  giteaCommentsRunStatus?: "passed";
  giteaCommentsReplayChecked?: boolean;
  giteaCommentsAuditChecked?: boolean;
  backupManifestChecked?: boolean;
  backupManifestTenant?: string;
  backupManifestProjectCount?: number;
  backupManifestRunCount?: number;
  backupManifestAuditEventCount?: number;
  backupManifestControlPlaneBoundary?: string[];
  backupManifestSecretScrubbed?: boolean;
  backupRestoreDryRunChecked?: boolean;
  backupRestoreDryRunValid?: boolean;
  backupRestoreDryRunApplied?: boolean;
  backupRestoreDryRunSourceProvider?: string;
  backupRestoreDryRunTargetProvider?: string;
  backupRestoreDryRunProjectCount?: number;
  backupRestoreDryRunProjectNames?: string[];
  backupRestoreDryRunRunCount?: number;
  backupRestoreDryRunAuditChecked?: boolean;
  backupRestoreDryRunCutoverReady?: boolean;
  backupRestoreDryRunCutoverStage?: string;
  backupRestoreDryRunCutoverTargetProvider?: string;
  backupRestoreDryRunAgentGitServiceProjectAgentsOk?: boolean;
  backupRestoreDryRunAgentGitServiceProjectAgentsProjectCount?: number;
  backupRestoreDryRunAgentGitServiceProjectAgentsProvisionedProjectCount?: number;
  backupRestoreDryRunAgentGitServiceProjectAgentsSecretRootConfigured?: boolean;
  backupRestoreDryRunAgentGitServiceProjectAgentsSecretStoredProjectCount?: number;
  backupRestoreDryRunAgentGitServiceProjectAgentsMissingProjects?: string[];
  backupRestoreDryRunAgentGitServiceProjectAgentsMissingSecretProjects?: string[];
  agentGitServiceCutoverChecked?: boolean;
  agentGitServiceCutoverProvider?: string;
  agentGitServiceCutoverReceiptChecked?: boolean;
  agentGitServiceCutoverReceiptSecretAbsent?: boolean;
  agentGitServiceCutoverAgentLogin?: string;
  agentGitServiceCutoverTokenEnvName?: string;
  agentGitServiceCutoverWorkspaceTokenChecked?: boolean;
  agentGitServiceCutoverCommandExitCode?: number;
  agentGitServiceCutoverCommandStdout?: string;
  agentGitServiceNativeProjectionChecked?: boolean;
  agentGitServiceHandoffWorkspaceAttachmentChecked?: boolean;
  agentGitServiceHandoffWorkspaceAttachmentWorkspaceId?: string;
  agentGitServiceHandoffWorkspaceAttachmentId?: string;
  agentGitServiceHandoffWorkspaceAttachmentUrl?: string;
  agentGitServiceHandoffPackageUrl?: string;
  agentGitServiceHandoffFollowupsUrl?: string;
  agentGitServiceWikiMemoryChecked?: boolean;
  agentGitServiceWikiMemoryPage?: string;
  agentGitServiceWikiMemorySha?: string;
  agentGitServiceWikiMemoryUrl?: string;
  agentGitServiceWikiMemoryLearningCount?: number;
  coderChecked?: boolean;
  coderProjectWorkspaceChecked?: boolean;
  coderRunWorkspaceChecked?: boolean;
  coderProjectExecutorKind?: "coder";
  coderRunExecutorKind?: "coder";
  coderProjectWorkspace?: string;
  coderRunWorkspace?: string;
  coderProjectIdeUrl?: string;
  coderRunIdeUrl?: string;
  coderProjectPreviewUrl?: string;
  coderRunPreviewUrl?: string;
  isolationTenant?: string;
  isolationPassed?: boolean;
  dashboardUrl: string;
  summaryUrl: string;
  eventsUrl: string;
}

export type HarnessSmokeProfileName = HarnessOnlineProfileName;

export type ResolvedHarnessSmokeCliOptions = Omit<HarnessSmokeCliOptions, "profile"> & { profile?: HarnessSmokeProfileName };

export interface HarnessSmokeProjectRunPolicy {
  preset: "vas-lite-review";
  presetInput: { caseId: "bootstrap" };
  reviewRequired: true;
}

export interface HarnessSmokeHealthProbeResult {
  healthProbesChecked: true;
  healthzChecked: true;
  healthzOk: true;
  healthzStartedAt: string;
  healthzUptimeMs: number;
  readyzChecked: true;
  readyzReady: true;
  readyzStartedAt: string;
  readyzUptimeMs: number;
  readyzCheckNames: string[];
  healthProbesSensitiveFieldsAbsent: true;
}

export const SMOKE_REQUIRED_VISION_LOCK_TARGET_MARKERS = HARNESS_VISION_LOCK_TARGET_MARKERS;

export const SMOKE_REQUIRED_PROJECT_CONTRACT_MARKERS = [
  { id: "multi-user", terms: ["multi-user"] },
  { id: "online-sandbox", terms: ["online", "sandbox"] },
  { id: "harness-loop", terms: ["harness", "loop"] },
  { id: "human-gates", terms: ["review", "deployment", "gate"] },
  { id: "durable-evidence", terms: ["evidence", "durable"] },
  { id: "vas-learning", terms: ["vas", "learning"] },
];

export const SMOKE_REQUIRED_VISION_LOCK_CAPABILITIES = HARNESS_VISION_LOCK.capabilities;

export const SMOKE_ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES = ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES;

export const SMOKE_AGENT_GIT_SERVICE_CUTOVER_CAPABILITY = "agent-git-service-cutover";

export const SMOKE_AGENT_GIT_SERVICE_NATIVE_PROJECTION_CAPABILITY = "agent-git-service-native-projection";

export const SMOKE_MULTI_AGENT_CONCURRENCY_CAPABILITY = "multi-agent-concurrency";

export const SMOKE_CONCURRENCY_ADMISSION_SCHEMA_VERSION = "loom-concurrency-admission/v1";

export const SMOKE_CONCURRENCY_ADMISSION_BLOCKED_REASONS = ["tenant_active_run_limit", "project_active_workspace", "persisted_running_run"];

export const SMOKE_HEALTH_PROBE_FORBIDDEN_FIELDS = ["resources", "policy", "workspaceRoot", "tenants"];

export const SMOKE_POLL_TIMEOUT_MS = 15_000;

export const SMOKE_RUN_CONTROL_PAUSE_TIMEOUT_MS = 90_000;

export const SMOKE_RUN_CONTROL_RESUME_TIMEOUT_MS = 45_000;

export const SMOKE_RUN_CONTROL_PAUSE_COMMAND = [
  "printf first > loom-control.txt",
  "node -e \"const fs=require('fs');const path=require('path');const runDir=process.env.LOOM_RUN_DIR;if(!runDir){process.stderr.write('LOOM_RUN_DIR missing');process.exit(2);}const request=path.join(runDir,'pause-request.json');const deadline=Date.now()+60000;(function wait(){if(fs.existsSync(request)){process.stdout.write('pause-request-seen');return;}if(Date.now()>deadline){process.stderr.write('pause request not observed');process.exit(2);}setTimeout(wait,100);})();\"",
].join("; ");

export const SMOKE_VAS_LITE_DEFAULT_SKILLS = projectTemplateDefaultSkills("vas-lite");

export const SMOKE_VAS_LITE_RUN_POLICY: HarnessSmokeProjectRunPolicy = {
  preset: "vas-lite-review",
  presetInput: { caseId: "bootstrap" },
  reviewRequired: true,
};

export const SMOKE_VAS_LITE_CONTRACT = {
  objective: HARNESS_VISION_LOCK.target,
  constraints: [
    "Keep harness/loop evidence durable in .loom project state.",
    "Keep human review and deployment gates explicit for side effects.",
    "Keep sandbox work file-backed so runs can resume, inspect, and audit it.",
    "Promote VAS corrections into durable learning updates only after review.",
  ],
  successCriteria: [
    "Tenant projects and runs are operable through the HTTP control plane and Dashboard.",
    "Runs record project contract, policy, events, verification, and gate decisions.",
    "VAS-lite cases can move from evidence to review to learning updates.",
  ],
};

export const SMOKE_SOURCE_DEFAULTS = {
  repo: "https://git.example/team/loom-smoke.git",
  branch: "loom/smoke-source-defaults",
  baseBranch: "origin/main",
  issue: "team/loom-smoke#17",
};

export interface HarnessSmokeAgentGitServiceHandoffAttachmentResult {
  agentGitServiceHandoffWorkspaceAttachmentChecked: true;
  agentGitServiceHandoffWorkspaceAttachmentWorkspaceId: string;
  agentGitServiceHandoffWorkspaceAttachmentId: string;
  agentGitServiceHandoffWorkspaceAttachmentUrl?: string;
  agentGitServiceHandoffPackageUrl: string;
  agentGitServiceHandoffFollowupsUrl?: string;
}

export interface HarnessSmokeAgentGitServiceWikiMemoryResult {
  agentGitServiceWikiMemoryChecked: true;
  agentGitServiceWikiMemoryPage: string;
  agentGitServiceWikiMemorySha?: string;
  agentGitServiceWikiMemoryUrl?: string;
  agentGitServiceWikiMemoryLearningCount: number;
}

export interface HarnessSmokeMultiAgentConcurrencyResult {
  multiAgentConcurrencyChecked: true;
  multiAgentConcurrencyIsolation: "run";
  multiAgentConcurrencyActiveRunLeaseChecked: true;
  multiAgentConcurrencyRunScopedFileWriteChecked: true;
  multiAgentConcurrencyRunScopedPrHandoffChecked: true;
  multiAgentConcurrencyBranch: string;
  multiAgentConcurrencyCrossServerChecked?: true;
  multiAgentConcurrencyCrossServerIdempotencyChecked?: true;
}

export interface HarnessSmokeOnlineSandboxGoldenPathResult {
  onlineSandboxGoldenPathChecked: true;
  onlineSandboxGoldenPathProfile: HarnessSmokeProfileName;
  onlineSandboxGoldenPathCapabilities: string[];
}

export interface HarnessSmokeWorkspaceCommandResult {
  workspaceCommandRun: true;
  workspaceCommand: string;
  workspaceCommandStdout: string;
  workspaceCommandExitCode: number;
}

export interface HarnessSmokeWorkspaceSessionResult {
  workspaceSessionRun: true;
  workspaceSessionId: string;
  workspaceSessionCommand: string;
  workspaceSessionInputAccepted: true;
  workspaceSessionOutput: string;
  workspaceSessionExitCode: number;
}

export interface HarnessSmokeProjectContractResult {
  projectContractChecked: true;
  projectContractOk: true;
  projectContractMissing: string[];
  projectGoldenDefaultsChecked: true;
  projectDefaultSkills: string[];
  projectRunPolicy: HarnessSmokeProjectRunPolicy;
  projectContractObjective: string;
}

export interface HarnessSmokeVasResult {
  vasReadinessChecked: true;
  vasTemplate: "vas-lite";
  vasBootstrapCaseId: "bootstrap";
  vasBootstrapCaseFound: true;
  vasBootstrapCaseStatus: string;
  vasReviewQueueRead: true;
  vasReviewQueueCaseCount: number;
  vasReviewPackageRead: true;
  vasReviewPackageCaseId: "bootstrap";
  vasReviewRunExecuted: true;
  vasReviewRunId: string;
  vasReviewRunStatus: "passed";
  vasReviewRunPreset: "vas-lite-review";
  vasReviewRunCaseId: "bootstrap";
  vasReviewArtifactsRead: true;
  vasReviewReportPath: string;
  vasReviewContextPath: string;
  vasReviewContextCaseId: "bootstrap";
  vasReviewGateChecked: true;
  vasReviewGateCaseId: string;
  vasReviewGateRunId: string;
  vasReviewGateRunStatus: "review_required";
  vasReviewGateDecision: "approved";
  vasReviewGateCaseStatus: "reviewed";
  vasReviewLearningRecorded: true;
  vasReviewLearningText: string;
  vasReviewLearnedPatternsRead: true;
  agentGitServiceWikiMemoryChecked?: true;
  agentGitServiceWikiMemoryPage?: string;
  agentGitServiceWikiMemorySha?: string;
  agentGitServiceWikiMemoryUrl?: string;
  agentGitServiceWikiMemoryLearningCount?: number;
}

export interface HarnessSmokeVasReviewGateResult {
  vasReviewGateChecked: true;
  vasReviewGateCaseId: string;
  vasReviewGateRunId: string;
  vasReviewGateRunStatus: "review_required";
  vasReviewGateDecision: "approved";
  vasReviewGateCaseStatus: "reviewed";
  vasReviewLearningRecorded: true;
  vasReviewLearningText: string;
  vasReviewLearnedPatternsRead: true;
  agentGitServiceWikiMemoryChecked?: true;
  agentGitServiceWikiMemoryPage?: string;
  agentGitServiceWikiMemorySha?: string;
  agentGitServiceWikiMemoryUrl?: string;
  agentGitServiceWikiMemoryLearningCount?: number;
}

export interface HarnessSmokeVasBrainLearningResult {
  vasBrainLearningChecked: true;
  vasBrainLearningSource: "vas_learning";
  vasBrainLearningCaseId: string;
  vasBrainLearningRunId: string;
  vasBrainLearningCount: number;
  vasBrainLearningSkillCount: number;
  vasBrainLearningFeedChecked: true;
}

export interface HarnessSmokeOnlineResult {
  onlineSurfacesChecked: true;
  dashboardHtmlRead: true;
  dashboardReadinessLabelsChecked: true;
  dashboardTenantReadinessLabel: string;
  dashboardGlobalReadinessLabel: string;
  dashboardBrainFeedChecked: true;
  dashboardTokenScrubChecked: true;
  dashboardAgentGitServiceProvisioningChecked: true;
  dashboardProjectConcurrencyChecked: true;
  workbenchHtmlRead: true;
  workbenchBrainFeedChecked: true;
  workbenchTokenScrubChecked: true;
  projectPresenceChecked: true;
  projectPresenceCollaboratorCount: number;
  runPresenceChecked: true;
  runPresenceCollaboratorCount: number;
  onlineRunCommentAdded: true;
  onlineRunCommentReplayChecked: true;
  onlineRunCommentText: string;
}

export interface HarnessSmokeFileCollabResult {
  fileCollabChecked: true;
  fileCollabPath: string;
  fileCollabBaseRead: true;
  fileCollabActiveEditorClientId: string;
  fileCollabActiveEditorLabel: string;
  fileCollabStaleSaveDenied: true;
  fileCollabStaleMoveDenied: true;
  fileCollabStaleDeleteDenied: true;
  fileCollabReloadedContent: string;
  fileCollabAuditChecked: true;
  runFileCollabChecked: true;
  runFileCollabRunId: string;
  runFileCollabPath: string;
  runFileCollabActiveEditorClientId: string;
  runFileCollabActiveEditorLabel: string;
  runFileCollabStaleSaveDenied: true;
  runFileCollabStaleMoveDenied: true;
  runFileCollabStaleDeleteDenied: true;
  runFileCollabReloadedContent: string;
  runFileCollabAuditChecked: true;
}

export interface HarnessSmokeAuthRolesResult {
  authRolesChecked: true;
  developerAccessActor: string;
  developerAccessRole: "developer" | "admin";
  viewerAccessActor: string;
  viewerAccessRole: "viewer";
  viewerTenantReadinessChecked: true;
  viewerTenantReadinessProfile?: string;
  viewerTenantReadinessOk: boolean;
  viewerTenantReadinessMissing: string[];
  viewerTenantGoldenPathChecked: true;
  viewerTenantGoldenPathOk: boolean;
  viewerTenantGoldenPathCapabilities: string[];
  viewerTenantGoldenPathMissingCapabilities: string[];
  viewerTenantVisionLockChecked: true;
  viewerTenantVisionLockTarget: string;
  viewerTenantVisionLockMvpIsScopeReduction: boolean;
  viewerTenantVisionLockCapabilities: string[];
  viewerCreateRunDenied: true;
  viewerWorkspaceWriteDenied: true;
  viewerRunCommentAdded: true;
  viewerRunCommentReplayChecked: true;
}

export interface HarnessSmokeGateResult {
  gatesChecked: true;
  gateRunId: string;
  reviewGateChecked: true;
  reviewGateRunStatus: "review_required";
  reviewGateDecision: "approved";
  reviewGateDecidedRole: "developer";
  reviewGateMetricsChecked?: true;
  reviewGateMetricsReviewRequiredRuns?: number;
  deploymentGateChecked: true;
  deploymentGateDeveloperDenied: true;
  deploymentGateRunStatus: "deployment_required";
  deploymentGateDecision: "approved";
  deploymentGateDecidedRole: "admin";
  deploymentGateMetricsChecked?: true;
  deploymentGateMetricsDeploymentRequiredRuns?: number;
  gateRunFinalStatus: "passed";
}

export interface HarnessSmokePolicyEscalationResult {
  policyEscalationChecked: true;
  policyEscalationId: string;
  policyEscalationStatus: "approved";
  policyEscalationRequestedTool: "shell.exec";
  policyEscalationSourceKind: "workspace_pr";
  policyEscalationDeveloperDecisionDenied: true;
  policyEscalationDecidedRole: "admin";
  policyEscalationToolAdded: true;
  policyEscalationLimitChanged: true;
  policyEscalationAuditChecked: true;
}

export interface HarnessSmokeWarningMetricsResult {
  modelWarningMetricsChecked: true;
  modelWarningMetricsModelUsageWarningProjects: number;
  modelWarningQueueChecked: true;
  modelWarningQueueProject: string;
  modelWarningQueueWarningCount: number;
  modelWarningEscalationChecked: true;
  modelWarningEscalationId: string;
  modelWarningEscalationSourceKind: "model_usage_warning";
  workspaceWarningMetricsChecked: true;
  workspaceWarningMetricsWorkspaceUsageWarningProjects: number;
  workspaceWarningQueueChecked: true;
  workspaceWarningQueueProject: string;
  workspaceWarningQueueWarningCount: number;
  workspaceWarningEscalationChecked: true;
  workspaceWarningEscalationId: string;
  workspaceWarningEscalationSourceKind: "workspace_usage_warning";
  warningEscalationAuditChecked: true;
}

export interface HarnessSmokeSourceDefaults {
  repo: string;
  branch: string;
  baseBranch: string;
  issue: string;
}

export interface HarnessSmokeSourceDefaultsResult {
  sourceDefaultsChecked: true;
  sourceDefaultsRepo: string;
  sourceDefaultsBranch: string;
  sourceDefaultsBaseBranch: string;
  sourceDefaultsIssue: string;
  sourceDefaultsIssueUrl?: string;
}

export interface HarnessSmokeHandoffResult {
  handoffEvidenceChecked: true;
  reviewSummaryRead: true;
  reviewSummaryRunId: string;
  reviewSummaryStatus: "passed";
  reviewSummaryTimelineChecked: true;
  reviewSummaryContractEvidenceChecked: true;
  handoffPackageRead: true;
  handoffPackageRunId: string;
  handoffPackageReviewSummaryChecked: true;
  handoffPackageContractEvidenceChecked: true;
  handoffPackageAuditTrailChecked: true;
  handoffPackageLinksChecked: true;
  handoffFollowupCreated: true;
  handoffFollowupRunId: string;
  handoffFollowupRunStatus: "passed";
  handoffFollowupSourceRunId: string;
  handoffFollowupSourceContractEvidenceChecked: true;
  handoffSourceDefaultsChecked: true;
  handoffFollowupSourceDefaultsChecked: true;
  handoffFollowupRepo: string;
  handoffFollowupBranch: string;
  handoffFollowupBaseBranch: string;
  handoffFollowupIssue: string;
  handoffFollowupIssueUrl?: string;
  runScopedPullRequestDuringActiveRunChecked?: true;
  runScopedPullRequestDuringActiveRunId?: string;
  runScopedPullRequestDuringActiveRunBranch?: string;
  runScopedPullRequestDuringActiveRunCommit?: string;
  runScopedPullRequestDuringActiveRunPush?: false;
  runScopedPullRequestDuringActiveRunIndex?: number;
  runScopedPullRequestDuringActiveRunUrl?: string;
  runScopedFileWriteDuringActiveRunChecked?: true;
  runScopedFileWriteDuringActiveRunBlockedRunId?: string;
  runScopedFileWriteDuringActiveRunAllowedRunId?: string;
  runScopedFileWriteDuringActiveRunPath?: string;
  runScopedFileWriteDuringActiveRunDenied?: true;
  agentGitServiceHandoffWorkspaceAttachmentChecked?: true;
  agentGitServiceHandoffWorkspaceAttachmentWorkspaceId?: string;
  agentGitServiceHandoffWorkspaceAttachmentId?: string;
  agentGitServiceHandoffWorkspaceAttachmentUrl?: string;
  agentGitServiceHandoffPackageUrl?: string;
  agentGitServiceHandoffFollowupsUrl?: string;
  handoffFollowupListChecked: true;
  handoffFollowupCount: 1;
  handoffContractPatchEvidenceChecked: true;
  handoffContractPatchRunId: string;
  handoffContractPatchReviewSummaryChecked: true;
  handoffContractPatchGateTrailChecked: true;
  handoffContractPatchReplayChecked: true;
}

export interface HarnessSmokeRunControlsResult {
  runControlsChecked: true;
  pauseResumeChecked: true;
  pauseResumeRunId: string;
  activeRunLeaseChecked: true;
  activeRunLeaseRunId: string;
  activeRunLeaseScope: "project" | "run";
  activeRunLeaseKey: string;
  pauseRequested: true;
  pauseRequestRole: string;
  pausedRunStatus: "paused";
  resumeRequested: true;
  resumeRequestRole: "developer" | "admin";
  resumedRunStatus: "passed";
  pauseResumeTraceContent: string;
  cancelChecked: true;
  cancelRunId: string;
  cancelRunStatus: "cancelled";
  cancelReplayChecked: true;
  runControlsPeerUrl?: string;
  crossServerPauseChecked?: true;
  crossServerActiveRunLeaseChecked?: true;
  crossServerActiveRunLeaseRunId?: string;
  crossServerActiveRunLeaseScope?: "project" | "run";
  crossServerActiveRunLeaseKey?: string;
  crossServerPauseRunId?: string;
  crossServerPauseRequested?: true;
  crossServerPauseRunStatus?: "paused";
  crossServerCancelChecked?: true;
  crossServerCancelRunId?: string;
  crossServerCancelRequested?: true;
  crossServerCancelRunStatus?: "cancelled";
  crossServerIdempotentCreateChecked?: true;
  crossServerIdempotentCreateRunId?: string;
  crossServerIdempotentCreateClientRequestId?: string;
  crossServerIdempotentCreateReplayChecked?: true;
  crossServerIdempotentCreateRunStatus?: "cancelled";
  runControlAuditChecked: true;
}

export interface HarnessSmokeBrainSignalResult {
  brainSignalChecked: true;
  brainSignalRunId: string;
  brainSignalOutcome: "pass";
  brainSignalSkillCount: number;
  brainSignalAuditChecked: true;
  brainRunIngestChecked: true;
  brainRunIngestRunId: string;
  brainRunIngestOutcome: "pass";
  brainRunIngestExternalEffectChecked: true;
  brainRunIngestAuditChecked: true;
  brainSignalFeedChecked: true;
  brainSignalFeedCount: number;
  brainSignalFeedRunIngestChecked: true;
  brainSignalFeedWorkspaceSignalChecked: true;
}

export interface SmokeActiveRunLeaseEvidence {
  runId: string;
  scope: "project" | "run";
  key: string;
}

export interface HarnessSmokeModelResult {
  modelRunChecked: true;
  modelRunId: string;
  modelRunStatus: "passed";
  modelRunModel: string;
  modelRunArtifactPath: string;
  modelRunArtifactRead: true;
  modelRunArtifactContent: string;
  modelRunUsageRequestCount: number;
  modelRunUsageTotalTokens: number;
  modelRunUsageCostUsd?: number;
  modelRunReplayChecked: true;
}

export interface HarnessSmokeGiteaPrResult {
  controlPlanePrChecked: true;
  controlPlanePrProvider: string;
  controlPlanePrRunId: string;
  controlPlanePrRunStatus: "review_required";
  controlPlanePrIssue: string;
  controlPlanePrIssueUrl?: string;
  controlPlanePrBranch: string;
  controlPlanePrBaseBranch: string;
  controlPlanePrIndex: number;
  controlPlanePrUrl: string;
  controlPlanePrExternalEffectChecked: true;
  giteaPrChecked: true;
  giteaPrRunId: string;
  giteaPrRunStatus: "review_required";
  giteaPrIssue: string;
  giteaPrBranch: string;
  giteaPrBaseBranch: string;
  giteaPrIndex: number;
  giteaPrUrl: string;
  giteaPrExternalEffectChecked: true;
}

export interface HarnessSmokeGiteaCommentsResult {
  controlPlaneCommentsChecked: true;
  controlPlaneCommentsProvider: string;
  controlPlaneCommentsRunId: string;
  controlPlaneCommentsIssue: string;
  controlPlaneCommentsIssueUrl?: string;
  controlPlaneCommentsSynced: 1;
  controlPlaneCommentsRunReviewRequested: 1;
  controlPlaneCommentsRunReviewed: 1;
  controlPlaneCommentsRunStatus: "passed";
  controlPlaneCommentsReplayChecked: true;
  controlPlaneCommentsAuditChecked: true;
  controlPlaneCommentsWebhookChecked?: true;
  controlPlaneCommentsWebhookProvider?: string;
  controlPlaneCommentsWebhookRunId?: string;
  controlPlaneCommentsWebhookIssue?: string;
  controlPlaneCommentsWebhookIssueUrl?: string;
  controlPlaneCommentsWebhookSynced?: 1;
  controlPlaneCommentsWebhookRunReviewRequested?: 1;
  controlPlaneCommentsWebhookRunReviewed?: 1;
  controlPlaneCommentsWebhookRunStatus?: "passed";
  controlPlaneCommentsWebhookAuditChecked?: true;
  giteaCommentsChecked: true;
  giteaCommentsRunId: string;
  giteaCommentsIssue: string;
  giteaCommentsSynced: 1;
  giteaCommentsRunReviewRequested: 1;
  giteaCommentsRunReviewed: 1;
  giteaCommentsRunStatus: "passed";
  giteaCommentsReplayChecked: true;
  giteaCommentsAuditChecked: true;
}

export interface HarnessSmokeBackupManifestResult {
  backupManifestChecked: true;
  backupManifestTenant: string;
  backupManifestProjectCount: number;
  backupManifestRunCount: number;
  backupManifestAuditEventCount: number;
  backupManifestControlPlaneBoundary: string[];
  backupManifestSecretScrubbed: true;
  backupRestoreDryRunChecked: true;
  backupRestoreDryRunValid: true;
  backupRestoreDryRunApplied: false;
  backupRestoreDryRunSourceProvider: string;
  backupRestoreDryRunTargetProvider: string;
  backupRestoreDryRunProjectCount: number;
  backupRestoreDryRunProjectNames: string[];
  backupRestoreDryRunRunCount: number;
  backupRestoreDryRunAuditChecked: true;
  backupRestoreDryRunCutoverReady?: boolean;
  backupRestoreDryRunCutoverStage?: string;
  backupRestoreDryRunCutoverTargetProvider?: string;
  backupRestoreDryRunAgentGitServiceProjectAgentsOk?: boolean;
  backupRestoreDryRunAgentGitServiceProjectAgentsProjectCount?: number;
  backupRestoreDryRunAgentGitServiceProjectAgentsProvisionedProjectCount?: number;
  backupRestoreDryRunAgentGitServiceProjectAgentsSecretRootConfigured?: boolean;
  backupRestoreDryRunAgentGitServiceProjectAgentsSecretStoredProjectCount?: number;
  backupRestoreDryRunAgentGitServiceProjectAgentsMissingProjects?: string[];
  backupRestoreDryRunAgentGitServiceProjectAgentsMissingSecretProjects?: string[];
}

export interface HarnessSmokeAgentGitServiceCutoverResult {
  agentGitServiceCutoverChecked: true;
  agentGitServiceCutoverProvider: "agent-git-service";
  agentGitServiceCutoverReceiptChecked: true;
  agentGitServiceCutoverReceiptSecretAbsent: true;
  agentGitServiceCutoverAgentLogin: string;
  agentGitServiceCutoverTokenEnvName: string;
  agentGitServiceCutoverWorkspaceTokenChecked: true;
  agentGitServiceCutoverCommandExitCode: 0;
  agentGitServiceCutoverCommandStdout: "agent-git-service-cutover-token-ok";
}

export interface HarnessSmokeCoderResult {
  coderChecked: true;
  coderProjectWorkspaceChecked: true;
  coderRunWorkspaceChecked: true;
  coderProjectExecutorKind: "coder";
  coderRunExecutorKind: "coder";
  coderProjectWorkspace: string;
  coderRunWorkspace: string;
  coderProjectIdeUrl: string;
  coderRunIdeUrl: string;
  coderProjectPreviewUrl: string;
  coderRunPreviewUrl: string;
}

export interface HarnessSmokePresenceExpectation {
  clientId: string;
  label: string;
  focus: string;
}

export function smokeOptionsWithProfile(options: HarnessSmokeCliOptions): ResolvedHarnessSmokeCliOptions {
  const profile = parseSmokeProfileFlag(options.profile);
  if (!profile) return { ...options, profile };
  const controlPlaneProvider = parseControlPlaneProviderFlag(options.controlPlaneProvider ?? "gitea-forgejo", "--control-plane-provider");
  const onlineChecks = {
    ...options,
    profile,
    checkCommand: true,
    checkSession: true,
    checkVas: true,
    checkOnline: true,
    checkFileCollab: true,
    checkAuthRoles: true,
    checkGates: true,
    checkEscalations: true,
    checkHandoff: true,
    checkRunControls: true,
    checkMetrics: true,
  };
  if (profile === "online-sandbox") return onlineChecks;
  return {
    ...onlineChecks,
    checkBrain: true,
    checkModel: true,
    checkControlPlanePr: true,
    checkControlPlaneComments: true,
    checkBackup: true,
    checkAgentGitServiceCutover: options.checkAgentGitServiceCutover === true || controlPlaneProvider === "agent-git-service",
    checkCoder: true,
  };
}

export function checkControlPlanePr(options: Pick<HarnessSmokeCliOptions, "checkControlPlanePr" | "checkGiteaPr">): boolean {
  return options.checkControlPlanePr === true || options.checkGiteaPr === true;
}

export function checkControlPlaneComments(options: Pick<HarnessSmokeCliOptions, "checkControlPlaneComments" | "checkGiteaComments">): boolean {
  return options.checkControlPlaneComments === true || options.checkGiteaComments === true;
}

export function smokeProjectCreateBody(project: string, template: ProjectTemplateName): Record<string, unknown> {
  return {
    project,
    template,
    ...smokeProjectGoldenDefaults(template),
    clientId: "loom-smoke",
  };
}

export function smokeProjectGoldenDefaults(template: ProjectTemplateName): Record<string, unknown> {
  if (template !== "vas-lite") return {};
  return {
    defaultSkills: [...SMOKE_VAS_LITE_DEFAULT_SKILLS],
    preset: SMOKE_VAS_LITE_RUN_POLICY.preset,
    presetInput: { ...SMOKE_VAS_LITE_RUN_POLICY.presetInput },
    reviewRequired: SMOKE_VAS_LITE_RUN_POLICY.reviewRequired,
    objective: SMOKE_VAS_LITE_CONTRACT.objective,
    constraints: [...SMOKE_VAS_LITE_CONTRACT.constraints],
    successCriteria: [...SMOKE_VAS_LITE_CONTRACT.successCriteria],
  };
}

export function smokeUngatedRunDefaults(): Record<string, unknown> {
  return {
    preset: null,
    reviewRequired: false,
  };
}

export async function runHarnessSmoke(options: HarnessSmokeCliOptions): Promise<HarnessSmokeResult> {
  const smokeOptions = smokeOptionsWithProfile(options);
  const url = normalizeHttpBaseUrl(smokeOptions.url, "--url");
  const peerUrl = smokeOptions.peerUrl ? normalizeHttpBaseUrl(smokeOptions.peerUrl, "--peer-url") : undefined;
  const tenant = parseSafeNameFlag(smokeOptions.tenant, "--tenant");
  const project = parseSafeNameFlag(smokeOptions.project, "--project");
  const template = parseProjectTemplateFlag(smokeOptions.template, "--template");
  const expectedControlPlaneProvider = smokeOptions.controlPlaneProvider
    ? parseControlPlaneProviderFlag(smokeOptions.controlPlaneProvider, "--control-plane-provider")
    : undefined;
  const isolationTenant = smokeOptions.isolationTenant
    ? parseSafeNameFlag(smokeOptions.isolationTenant, "--isolation-tenant")
    : undefined;
  if (smokeOptions.profile && !isolationTenant) {
    throw smokeCheckError(
      "SMOKE_PROFILE_ISOLATION_TENANT_MISSING",
      `--profile ${smokeOptions.profile} requires --isolation-tenant so the smoke run proves cross-tenant isolation`,
      { profile: smokeOptions.profile, requiredFlag: "--isolation-tenant" },
    );
  }
  if (isolationTenant === tenant) throw new Error("--isolation-tenant must be different from --tenant");
  const token = smokeToken(smokeOptions);
  const headers = smokeHeaders(token);

  const healthProbeResult = await verifySmokeHealthProbes(url, headers);
  if (peerUrl) {
    await verifySmokeHealthProbes(peerUrl, headers, "peer ");
  }
  const metricsResult = smokeOptions.checkMetrics
    ? await verifySmokeMetrics(url, smokeHeaders(smokeAdminToken(smokeOptions) ?? token), smokeOptions, tenant, project)
    : undefined;
  const serverProfileResult = smokeOptions.profile
    ? await verifySmokeServerProfile(url, smokeOptions.profile, smokeHeaders(smokeAdminToken(smokeOptions) ?? token))
    : undefined;
  if (serverProfileResult) {
    verifySmokeExpectedControlPlaneProvider(
      expectedControlPlaneProvider,
      serverProfileResult.controlPlaneProvider,
      "server-status",
      { tenant, project, profile: smokeOptions.profile },
    );
  }
  const tenantProfileResult = smokeOptions.profile
    ? await verifySmokeTenantProfileTools(url, tenant, smokeOptions.profile, headers)
    : undefined;
  if (
    smokeOptions.profile &&
    serverProfileResult?.controlPlaneProvider &&
    tenantProfileResult?.controlPlaneProvider &&
    serverProfileResult.controlPlaneProvider !== tenantProfileResult.controlPlaneProvider
  ) {
    throw smokeCheckError(
      "SMOKE_TENANT_CONTROL_PLANE_PROVIDER_MISMATCH",
      `tenant ${tenant} profile ${smokeOptions.profile} reported control-plane provider ${tenantProfileResult.controlPlaneProvider} but server reported ${serverProfileResult.controlPlaneProvider}`,
      {
        scope: "tenant",
        tenant,
        profile: smokeOptions.profile,
        serverProvider: serverProfileResult.controlPlaneProvider,
        tenantProvider: tenantProfileResult.controlPlaneProvider,
      },
    );
  }

  const projectResponse = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(smokeProjectCreateBody(project, template)),
    },
    [200, 201, 409],
    "POST project",
  );
  const projectCreated = projectResponse.status !== 409;
  const projectContractResult = template === "vas-lite"
    ? await verifySmokeProjectContract(url, headers, tenant, project, template)
    : undefined;
  const sourceDefaults = smokeOptions.checkHandoff
    ? await verifySmokeProjectSourceDefaults(url, headers, tenant, project)
    : undefined;

  const runResponse = await smokeJson(
    `${url}/runs`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        tenant,
        project,
        ...smokeUngatedRunDefaults(),
        goal: "loom harness smoke",
        script: [
          {
            message: "write smoke artifact",
            actions: [
              {
                toolName: "file.write",
                input: { path: "loom-smoke.txt", content: "loom smoke ok\n" },
              },
            ],
          },
          { message: "finish", finish: true },
        ],
        verify: ["test -f loom-smoke.txt"],
        skills: ["smoke", "coding"],
        requester: { clientId: "loom-smoke" },
      }),
    },
    [201],
    "POST /runs",
  );
  const runId = stringFieldFromResponse(runResponse.body, "runId", "run response");
  const status = stringFieldFromResponse(runResponse.body, "status", "run response");
  if (status !== "passed") throw new Error(`smoke run finished with status ${status}`);

  const summaryUrl = `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(runId)}?project=${encodeURIComponent(project)}`;
  const eventsUrl = `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(runId)}/events?project=${encodeURIComponent(project)}`;
  const summary = await smokeJson(summaryUrl, { headers }, [200], "GET run summary");
  const events = await smokeJson(eventsUrl, { headers }, [200], "GET run events");
  const summaryStatus = stringFieldFromResponse(summary.body, "status", "run summary");
  if (summaryStatus !== "passed") throw new Error(`smoke summary status is ${summaryStatus}`);
  if (!Array.isArray(events.body) || !events.body.some((event) => isRecord(event) && event.type === "finish")) {
    throw new Error("smoke events did not include a finish event");
  }
  const sourceDefaultsResult = sourceDefaults
    ? verifySmokeRunSourceDefaults(summary.body, sourceDefaults)
    : undefined;
  const workspaceArtifactPath = "loom-smoke.txt";
  const workspaceArtifact = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/files?path=${encodeURIComponent(workspaceArtifactPath)}`,
    { headers },
    [200],
    "GET smoke workspace artifact",
  );
  if (!isRecord(workspaceArtifact.body) || workspaceArtifact.body.kind !== "file") {
    throw new Error("smoke workspace artifact was not readable as a file");
  }
  const workspaceArtifactContent = stringFieldFromResponse(workspaceArtifact.body, "content", "smoke workspace artifact");
  if (workspaceArtifactContent !== "loom smoke ok\n") {
    throw new Error("smoke workspace artifact content did not match the run output");
  }
  const workspaceContext = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/workspace`,
    { headers },
    [200],
    "GET smoke workspace context",
  );
  const workspaceContextKind = workspaceContextKindFromResponse(workspaceContext.body);
  const workspaceCommandResult = smokeOptions.checkCommand
    ? await verifySmokeWorkspaceCommand(url, headers, tenant, project)
    : undefined;
  const workspaceSessionResult = smokeOptions.checkSession
    ? await verifySmokeWorkspaceSession(url, headers, tenant, project)
    : undefined;
  const vasResult = smokeOptions.checkVas
    ? await verifySmokeVasLiteProject(url, headers, tenant, project, template)
    : undefined;
  const onlineResult = smokeOptions.checkOnline
    ? await verifySmokeOnlineSurfaces(url, headers, tenant, project, runId)
    : undefined;
  const fileCollabResult = smokeOptions.checkFileCollab
    ? await verifySmokeFileCollab(url, headers, tenant, project)
    : undefined;
  const authRolesResult = smokeOptions.checkAuthRoles
    ? await verifySmokeAuthRoles(url, headers, smokeOptions, tenant, project, runId)
    : undefined;
  const gateResult = smokeOptions.checkGates
    ? await verifySmokeGates(url, headers, smokeOptions, tenant, project)
    : undefined;
  const escalationResult = smokeOptions.checkEscalations
    ? await verifySmokePolicyEscalation(url, headers, smokeOptions, tenant, project)
    : undefined;
  const handoffResult = smokeOptions.checkHandoff
    ? await verifySmokeHandoffEvidence(url, headers, tenant, project, runId, sourceDefaultsResult, smokeOptions.profile === "platform-readiness")
    : undefined;
  const runControlsResult = smokeOptions.checkRunControls
    ? await verifySmokeRunControls(url, headers, smokeOptions, tenant, project, peerUrl)
    : undefined;
  const dashboardUrl = `${url}/?${new URLSearchParams({ tenant, project, runId }).toString()}`;
  const brainSignalResult = smokeOptions.checkBrain
    ? await verifySmokeBrainSignal(url, headers, tenant, project, runId, dashboardUrl, summaryUrl)
    : undefined;
  const vasBrainLearningResult = smokeOptions.checkBrain && vasResult?.vasReviewLearningRecorded === true
    ? await verifySmokeVasBrainLearning(
      url,
      headers,
      tenant,
      project,
      vasResult.vasReviewGateCaseId,
      vasResult.vasReviewGateRunId,
    )
    : undefined;
  const modelResult = smokeOptions.checkModel
    ? await verifySmokeModelRun(url, headers, tenant, project)
    : undefined;
  const warningMetricsAdminToken = smokeAdminToken(smokeOptions);
  const warningMetricsResult = smokeOptions.checkMetrics && modelResult && warningMetricsAdminToken
    ? await verifySmokeWarningMetrics(url, smokeHeaders(warningMetricsAdminToken), headers, smokeOptions, tenant, project, modelResult)
    : undefined;
  const giteaPrResult = checkControlPlanePr(smokeOptions)
    ? await verifySmokeGiteaPr(url, headers, tenant, project)
    : undefined;
  verifySmokeExpectedControlPlaneProvider(
    expectedControlPlaneProvider,
    giteaPrResult?.controlPlanePrProvider,
    "control-plane-pr",
    { tenant, project },
  );
  const giteaCommentsResult = checkControlPlaneComments(smokeOptions)
    ? await verifySmokeGiteaComments(url, headers, smokeOptions, tenant, project)
    : undefined;
  verifySmokeExpectedControlPlaneProvider(
    expectedControlPlaneProvider,
    giteaCommentsResult?.controlPlaneCommentsProvider,
    "control-plane-comments",
    { tenant, project },
  );
  verifySmokeExpectedControlPlaneProvider(
    expectedControlPlaneProvider,
    giteaCommentsResult?.controlPlaneCommentsWebhookProvider,
    "control-plane-comments-webhook",
    { tenant, project },
  );
  const backupManifestResult = smokeOptions.checkBackup
    ? await verifySmokeBackupManifest(url, smokeOptions, tenant, project, expectedControlPlaneProvider)
    : undefined;
  const agentGitServiceCutoverResult = smokeOptions.checkAgentGitServiceCutover
    ? await verifySmokeAgentGitServiceCutover(url, headers, tenant, project)
    : undefined;
  const coderResult = smokeOptions.checkCoder
    ? await verifySmokeCoderWorkspace(url, headers, tenant, project, runId, workspaceContext.body)
    : undefined;
  const isolationPassed = isolationTenant
    ? await verifySmokeTenantIsolation(url, headers, isolationTenant)
    : undefined;
  const agentGitServiceNativeProjectionChecked =
    handoffResult?.agentGitServiceHandoffWorkspaceAttachmentChecked === true &&
    vasResult?.agentGitServiceWikiMemoryChecked === true;
  const multiAgentConcurrencyResult = smokeMultiAgentConcurrencyResult(
    serverProfileResult,
    tenantProfileResult,
    handoffResult,
    runControlsResult,
    peerUrl,
  );
  const goldenPathExtraCapabilities = [
    ...(multiAgentConcurrencyResult ? [SMOKE_MULTI_AGENT_CONCURRENCY_CAPABILITY] : []),
    ...(agentGitServiceCutoverResult ? [SMOKE_AGENT_GIT_SERVICE_CUTOVER_CAPABILITY] : []),
    ...(agentGitServiceNativeProjectionChecked ? [SMOKE_AGENT_GIT_SERVICE_NATIVE_PROJECTION_CAPABILITY] : []),
  ];
  const onlineSandboxGoldenPathResult = smokeOptions.profile
    ? verifySmokeOnlineSandboxGoldenPath(smokeOptions.profile, {
      "profile-readiness": serverProfileResult?.readinessOk === true && tenantProfileResult?.readinessOk === true,
      "project-contract-vision-lock": projectContractResult?.projectContractOk === true,
      "multi-user-isolation": isolationPassed === true,
      "role-based-auth": authRolesResult?.authRolesChecked === true && authRolesResult?.viewerCreateRunDenied === true && authRolesResult?.viewerWorkspaceWriteDenied === true,
      "isolated-persistent-workspace": workspaceContextKind === "docker" || workspaceContextKind === "coder",
      "auditable-harness-loop": summaryStatus === "passed",
      "workspace-command": workspaceCommandResult?.workspaceCommandRun === true,
      "workspace-session": workspaceSessionResult?.workspaceSessionRun === true,
      "online-surfaces": onlineResult?.onlineSurfacesChecked === true,
      "workspace-collaboration": fileCollabResult?.fileCollabChecked === true && fileCollabResult?.runFileCollabChecked === true,
      "vas-lite-learning": template === "vas-lite" &&
        vasResult?.vasReviewLearningRecorded === true &&
        vasResult.vasReviewLearnedPatternsRead === true &&
        (!smokeOptions.checkBrain || vasBrainLearningResult?.vasBrainLearningChecked === true),
      "human-gates": gateResult?.reviewGateChecked === true && gateResult?.deploymentGateChecked === true,
      "policy-escalation": escalationResult?.policyEscalationChecked === true && escalationResult?.policyEscalationAuditChecked === true,
      "handoff-followup": handoffResult?.handoffFollowupCreated === true && handoffResult?.handoffFollowupListChecked === true,
      [SMOKE_MULTI_AGENT_CONCURRENCY_CAPABILITY]: multiAgentConcurrencyResult?.multiAgentConcurrencyChecked === true,
      [SMOKE_AGENT_GIT_SERVICE_CUTOVER_CAPABILITY]: agentGitServiceCutoverResult?.agentGitServiceCutoverWorkspaceTokenChecked === true,
      [SMOKE_AGENT_GIT_SERVICE_NATIVE_PROJECTION_CAPABILITY]: agentGitServiceNativeProjectionChecked,
      "run-controls": runControlsResult?.pauseResumeChecked === true &&
        runControlsResult?.activeRunLeaseChecked === true &&
        runControlsResult?.cancelChecked === true &&
        (!peerUrl || (
          runControlsResult.crossServerActiveRunLeaseChecked === true &&
          runControlsResult.crossServerPauseChecked === true &&
          runControlsResult.crossServerCancelChecked === true &&
          runControlsResult.crossServerIdempotentCreateChecked === true
        )),
    }, goldenPathExtraCapabilities)
    : undefined;

  return {
    ok: true,
    url,
    peerUrl,
    tenant,
    project,
    template,
    profile: smokeOptions.profile,
    serverProfile: serverProfileResult?.profile,
    serverProfileChecked: serverProfileResult !== undefined,
    serverAllowedTools: serverProfileResult?.allowedTools,
    serverAllowedToolsChecked: serverProfileResult !== undefined,
    serverReadinessChecked: serverProfileResult !== undefined,
    serverReadinessOk: serverProfileResult?.readinessOk,
    serverReadinessMissing: serverProfileResult?.readinessMissing,
    serverGoldenPathChecked: serverProfileResult !== undefined,
    serverGoldenPathOk: serverProfileResult?.goldenPathOk,
    serverGoldenPathCapabilities: serverProfileResult?.goldenPathCapabilities,
    serverGoldenPathMissingCapabilities: serverProfileResult?.goldenPathMissingCapabilities,
    ...healthProbeResult,
    ...(metricsResult ?? {}),
    serverRunWorkspaceIsolation: serverProfileResult?.runWorkspaceIsolation,
    serverConcurrencyAdmissionChecked: serverProfileResult?.concurrencyAdmissionChecked,
    serverConcurrencyAdmissionSchemaVersion: serverProfileResult?.concurrencyAdmissionSchemaVersion,
    serverConcurrencyAdmissionRunWorkspaceIsolation: serverProfileResult?.concurrencyAdmissionRunWorkspaceIsolation,
    serverConcurrencyAdmissionActiveRunClaimScope: serverProfileResult?.concurrencyAdmissionActiveRunClaimScope,
    serverConcurrencyAdmissionQueueBlockedReasons: serverProfileResult?.concurrencyAdmissionQueueBlockedReasons,
    serverConcurrencyAdmissionRunControlCrossServer: serverProfileResult?.concurrencyAdmissionRunControlCrossServer,
    serverControlPlaneChecked: serverProfileResult !== undefined,
    serverControlPlaneProvider: serverProfileResult?.controlPlaneProvider,
    serverControlPlaneBoundary: serverProfileResult?.controlPlaneBoundary,
    serverControlPlaneApiBasePath: serverProfileResult?.controlPlaneApiBasePath,
    serverControlPlaneDiscoveryEndpoints: serverProfileResult?.controlPlaneDiscoveryEndpoints,
    serverControlPlaneNativeCapabilities: serverProfileResult?.controlPlaneNativeCapabilities,
    serverControlPlaneAdoptionStages: serverProfileResult?.controlPlaneAdoptionStages,
    serverControlPlaneGatedAdoptionStages: serverProfileResult?.controlPlaneGatedAdoptionStages,
    serverControlPlaneTenantDefaultCutoverGated: serverProfileResult?.controlPlaneTenantDefaultCutoverGated,
    serverControlPlaneDiscoveryChecked: serverProfileResult?.controlPlaneDiscoveryChecked,
    serverControlPlaneDiscoveryProvider: serverProfileResult?.controlPlaneDiscoveryProvider,
    serverControlPlaneDiscoveryOk: serverProfileResult?.controlPlaneDiscoveryOk,
    serverControlPlaneDiscoveryBaseUrlConfigured: serverProfileResult?.controlPlaneDiscoveryBaseUrlConfigured,
    serverControlPlaneDiscoveryEndpointCount: serverProfileResult?.controlPlaneDiscoveryEndpointCount,
    serverControlPlaneDiscoveryOkEndpointCount: serverProfileResult?.controlPlaneDiscoveryOkEndpointCount,
    serverControlPlaneDiscoveryMissingEndpoints: serverProfileResult?.controlPlaneDiscoveryMissingEndpoints,
    serverControlPlaneDiscoveryTokenMode: serverProfileResult?.controlPlaneDiscoveryTokenMode,
    serverControlPlaneDiscoveryTenantCount: serverProfileResult?.controlPlaneDiscoveryTenantCount,
    serverControlPlaneDiscoveryTenantOkCount: serverProfileResult?.controlPlaneDiscoveryTenantOkCount,
    serverControlPlaneDiscoveryMissingTenants: serverProfileResult?.controlPlaneDiscoveryMissingTenants,
    controlPlaneWorkspaceBranchLeaseChecked: serverProfileResult?.controlPlaneWorkspaceBranchLeaseChecked,
    controlPlaneWorkspaceBranchLeaseProvider: serverProfileResult?.controlPlaneWorkspaceBranchLeaseProvider,
    controlPlaneWorkspaceBranchLeaseIsolation: serverProfileResult?.controlPlaneWorkspaceBranchLeaseIsolation,
    controlPlaneWorkspaceBranchLeaseBranchDerivation: serverProfileResult?.controlPlaneWorkspaceBranchLeaseBranchDerivation,
    controlPlaneWorkspaceBranchLeaseActiveRunLeaseEvidence: serverProfileResult?.controlPlaneWorkspaceBranchLeaseActiveRunLeaseEvidence,
    agentGitServiceProjectAgentsChecked: serverProfileResult?.agentGitServiceProjectAgentsChecked,
    agentGitServiceProjectAgentsProvider: serverProfileResult?.agentGitServiceProjectAgentsProvider,
    agentGitServiceProjectAgentsOk: serverProfileResult?.agentGitServiceProjectAgentsOk,
    agentGitServiceProjectAgentsTenantCount: serverProfileResult?.agentGitServiceProjectAgentsTenantCount,
    agentGitServiceProjectAgentsProjectCount: serverProfileResult?.agentGitServiceProjectAgentsProjectCount,
    agentGitServiceProjectAgentsProvisionedProjectCount: serverProfileResult?.agentGitServiceProjectAgentsProvisionedProjectCount,
    agentGitServiceProjectAgentsSecretRootConfigured: serverProfileResult?.agentGitServiceProjectAgentsSecretRootConfigured,
    agentGitServiceProjectAgentsSecretStoredProjectCount: serverProfileResult?.agentGitServiceProjectAgentsSecretStoredProjectCount,
    agentGitServiceProjectAgentsMissingProjects: serverProfileResult?.agentGitServiceProjectAgentsMissingProjects,
    agentGitServiceProjectAgentsMissingSecretProjects: serverProfileResult?.agentGitServiceProjectAgentsMissingSecretProjects,
    visionLockChecked: serverProfileResult !== undefined,
    visionLockTarget: serverProfileResult?.visionLockTarget,
    visionLockMvpIsScopeReduction: serverProfileResult?.visionLockMvpIsScopeReduction,
    visionLockCapabilities: serverProfileResult?.visionLockCapabilities,
    tenantAllowedTools: tenantProfileResult?.allowedTools,
    tenantAllowedToolsChecked: tenantProfileResult !== undefined,
    tenantReadinessChecked: tenantProfileResult !== undefined,
    tenantReadinessProfile: tenantProfileResult?.readinessProfile,
    tenantReadinessOk: tenantProfileResult?.readinessOk,
    tenantReadinessMissing: tenantProfileResult?.readinessMissing,
    tenantGoldenPathChecked: tenantProfileResult !== undefined,
    tenantGoldenPathOk: tenantProfileResult?.goldenPathOk,
    tenantGoldenPathCapabilities: tenantProfileResult?.goldenPathCapabilities,
    tenantGoldenPathMissingCapabilities: tenantProfileResult?.goldenPathMissingCapabilities,
    tenantRunWorkspaceIsolation: tenantProfileResult?.runWorkspaceIsolation,
    tenantConcurrencyAdmissionChecked: tenantProfileResult?.concurrencyAdmissionChecked,
    tenantConcurrencyAdmissionSchemaVersion: tenantProfileResult?.concurrencyAdmissionSchemaVersion,
    tenantConcurrencyAdmissionRunWorkspaceIsolation: tenantProfileResult?.concurrencyAdmissionRunWorkspaceIsolation,
    tenantConcurrencyAdmissionActiveRunClaimScope: tenantProfileResult?.concurrencyAdmissionActiveRunClaimScope,
    tenantConcurrencyAdmissionQueueBlockedReasons: tenantProfileResult?.concurrencyAdmissionQueueBlockedReasons,
    tenantConcurrencyAdmissionRunControlCrossServer: tenantProfileResult?.concurrencyAdmissionRunControlCrossServer,
    tenantControlPlaneChecked: tenantProfileResult !== undefined,
    tenantControlPlaneProvider: tenantProfileResult?.controlPlaneProvider,
    tenantControlPlaneBoundary: tenantProfileResult?.controlPlaneBoundary,
    tenantControlPlaneAdoptionStages: tenantProfileResult?.controlPlaneAdoptionStages,
    tenantControlPlaneGatedAdoptionStages: tenantProfileResult?.controlPlaneGatedAdoptionStages,
    tenantControlPlaneTenantDefaultCutoverGated: tenantProfileResult?.controlPlaneTenantDefaultCutoverGated,
    tenantControlPlaneDiscoveryChecked: tenantProfileResult?.controlPlaneDiscoveryChecked,
    tenantControlPlaneDiscoveryProvider: tenantProfileResult?.controlPlaneDiscoveryProvider,
    tenantControlPlaneDiscoveryOk: tenantProfileResult?.controlPlaneDiscoveryOk,
    tenantControlPlaneDiscoveryBaseUrlConfigured: tenantProfileResult?.controlPlaneDiscoveryBaseUrlConfigured,
    tenantControlPlaneDiscoveryEndpointCount: tenantProfileResult?.controlPlaneDiscoveryEndpointCount,
    tenantControlPlaneDiscoveryOkEndpointCount: tenantProfileResult?.controlPlaneDiscoveryOkEndpointCount,
    tenantControlPlaneDiscoveryMissingEndpoints: tenantProfileResult?.controlPlaneDiscoveryMissingEndpoints,
    tenantControlPlaneDiscoveryTokenMode: tenantProfileResult?.controlPlaneDiscoveryTokenMode,
    tenantControlPlaneDiscoveryTenantCount: tenantProfileResult?.controlPlaneDiscoveryTenantCount,
    tenantControlPlaneDiscoveryTenantOkCount: tenantProfileResult?.controlPlaneDiscoveryTenantOkCount,
    tenantControlPlaneDiscoveryMissingTenants: tenantProfileResult?.controlPlaneDiscoveryMissingTenants,
    tenantVisionLockChecked: tenantProfileResult !== undefined,
    tenantVisionLockTarget: tenantProfileResult?.visionLockTarget,
    tenantVisionLockMvpIsScopeReduction: tenantProfileResult?.visionLockMvpIsScopeReduction,
    tenantVisionLockCapabilities: tenantProfileResult?.visionLockCapabilities,
    ...(onlineSandboxGoldenPathResult ?? {}),
    ...(projectContractResult ?? {}),
    projectCreated,
    runId,
    status: summaryStatus,
    workspaceArtifactPath,
    workspaceArtifactRead: true,
    workspaceArtifactContent,
    workspaceContextRead: true,
    workspaceContextKind,
    ...(workspaceCommandResult ?? {}),
    ...(workspaceSessionResult ?? {}),
    ...(vasResult ?? {}),
    ...(onlineResult ?? {}),
    ...(fileCollabResult ?? {}),
    ...(authRolesResult ?? {}),
    ...(gateResult ?? {}),
    ...(escalationResult ?? {}),
    ...(sourceDefaultsResult ?? {}),
    ...(handoffResult ?? {}),
    ...(runControlsResult ?? {}),
    ...(multiAgentConcurrencyResult ?? {}),
    ...(brainSignalResult ?? {}),
    ...(vasBrainLearningResult ?? {}),
    ...(modelResult ?? {}),
    ...(warningMetricsResult ?? {}),
    ...(giteaPrResult ?? {}),
    ...(giteaCommentsResult ?? {}),
    ...(backupManifestResult ?? {}),
    ...(agentGitServiceCutoverResult ?? {}),
    agentGitServiceNativeProjectionChecked: agentGitServiceNativeProjectionChecked || undefined,
    ...(coderResult ?? {}),
    isolationTenant,
    isolationPassed,
    dashboardUrl,
    summaryUrl,
    eventsUrl,
  };
}

export function smokeMultiAgentConcurrencyResult(
  serverProfile: { runWorkspaceIsolation?: string } | undefined,
  tenantProfile: { runWorkspaceIsolation?: string } | undefined,
  handoffResult: HarnessSmokeHandoffResult | undefined,
  runControlsResult: HarnessSmokeRunControlsResult | undefined,
  peerUrl?: string,
): HarnessSmokeMultiAgentConcurrencyResult | undefined {
  if (serverProfile?.runWorkspaceIsolation !== "run" || tenantProfile?.runWorkspaceIsolation !== "run") return undefined;
  if (
    handoffResult?.runScopedFileWriteDuringActiveRunChecked !== true ||
    handoffResult.runScopedFileWriteDuringActiveRunDenied !== true ||
    handoffResult.runScopedPullRequestDuringActiveRunChecked !== true ||
    !handoffResult.runScopedPullRequestDuringActiveRunBranch ||
    runControlsResult?.activeRunLeaseChecked !== true ||
    runControlsResult.activeRunLeaseScope !== "run"
  ) {
    return undefined;
  }
  if (peerUrl && (
    runControlsResult.crossServerActiveRunLeaseChecked !== true ||
    runControlsResult.crossServerIdempotentCreateChecked !== true
  )) {
    return undefined;
  }
  return {
    multiAgentConcurrencyChecked: true,
    multiAgentConcurrencyIsolation: "run",
    multiAgentConcurrencyActiveRunLeaseChecked: true,
    multiAgentConcurrencyRunScopedFileWriteChecked: true,
    multiAgentConcurrencyRunScopedPrHandoffChecked: true,
    multiAgentConcurrencyBranch: handoffResult.runScopedPullRequestDuringActiveRunBranch,
    ...(peerUrl ? {
      multiAgentConcurrencyCrossServerChecked: true,
      multiAgentConcurrencyCrossServerIdempotencyChecked: true,
    } : {}),
  };
}

export async function waitForReadyz(url: string, headers: Record<string, string>, labelPrefix = ""): Promise<unknown> {
  const deadline = Date.now() + SMOKE_POLL_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const readyz = await smokeJson(`${url}/readyz`, { headers }, [200], `GET ${labelPrefix}/readyz`);
      return readyz.body;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(100);
    }
  }
  throw new Error(lastError || `GET ${labelPrefix}/readyz did not become ready`);
}

export function smokeToken(options: HarnessSmokeCliOptions): string | undefined {
  return smokeTokenValue(options.token, options.tokenEnv, "--token-env");
}

export function smokeViewerToken(options: HarnessSmokeCliOptions): string | undefined {
  return smokeTokenValue(options.viewerToken, options.viewerTokenEnv, "--viewer-token-env");
}

export function smokeAdminToken(options: HarnessSmokeCliOptions): string | undefined {
  return smokeTokenValue(options.adminToken, options.adminTokenEnv, "--admin-token-env");
}

export function smokeControlPlaneWebhookSecret(options: HarnessSmokeCliOptions): string | undefined {
  const envName = options.controlPlaneWebhookSecretEnv ?? options.giteaWebhookSecretEnv;
  if (!envName) return undefined;
  const flag = options.controlPlaneWebhookSecretEnv ? "--control-plane-webhook-secret-env" : "--gitea-webhook-secret-env";
  return smokeTokenValue(undefined, envName, flag);
}

export function smokeTokenValue(token: string | undefined, tokenEnv: string | undefined, tokenEnvFlag: string): string | undefined {
  return cliTokenValue(token, tokenEnv, tokenEnvFlag);
}

export function smokeHeaders(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function hmacSha256(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function smokeJson(
  url: string,
  init: RequestInit,
  expectedStatuses: number[],
  label: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? parseJsonResponse(text, label) : {};
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${label} failed with ${response.status}: ${boundedErrorText(text)}`);
  }
  return { status: response.status, body };
}

export async function smokeText(
  url: string,
  init: RequestInit,
  expectedStatuses: number[],
  label: string,
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${label} failed with ${response.status}: ${boundedErrorText(text)}`);
  }
  return { status: response.status, text };
}

export function stringFieldFromResponse(value: unknown, field: string, label: string): string {
  if (isRecord(value) && typeof value[field] === "string") return value[field];
  throw new Error(`${label} did not include ${field}`);
}

export function optionalStringFieldFromResponse(value: unknown, field: string): string | undefined {
  if (isRecord(value) && typeof value[field] === "string") return value[field];
  return undefined;
}

export function numberFieldFromResponse(value: unknown, field: string, label: string): number {
  if (isRecord(value) && typeof value[field] === "number") return value[field];
  throw new Error(`${label} did not include ${field}`);
}

export function booleanFieldFromResponse(value: unknown, field: string, label: string): boolean {
  if (isRecord(value) && typeof value[field] === "boolean") return value[field];
  throw new Error(`${label} did not include ${field}`);
}

export function arrayFieldFromResponse(value: unknown, field: string, label: string): unknown[] {
  if (isRecord(value) && Array.isArray(value[field])) return value[field];
  throw new Error(`${label} did not include ${field}`);
}

export function recordFieldFromResponse(value: unknown, field: string, label: string): Record<string, unknown> {
  if (isRecord(value) && isRecord(value[field])) return value[field];
  throw new Error(`${label} did not include ${field}`);
}

export function workspaceContextKindFromResponse(value: unknown): string {
  if (!isRecord(value) || value.route !== "project") {
    throw new Error("smoke workspace context did not describe the project route");
  }
  const executor = value.executor;
  if (isRecord(executor) && typeof executor.kind === "string") return executor.kind;
  throw new Error("smoke workspace context did not include executor.kind");
}

export function parseSmokeProfileFlag(value: string | undefined): HarnessSmokeProfileName | undefined {
  return parseOnlineProfileFlag(value, "--profile");
}

export function backupMigrationTargetProviderFor(sourceProvider: ControlPlaneProviderName): ControlPlaneProviderName {
  return SERVE_CONTROL_PLANE_PROVIDERS.find((provider) => provider !== sourceProvider) ?? sourceProvider;
}

export function smokeCheckError(code: string, message: string, details: Record<string, unknown>): Error {
  return new Error(`${code}: ${message}; details=${JSON.stringify(details)}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
