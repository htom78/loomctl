import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface PlatformGoalAuditCliOptions {
  dir?: string;
  report?: string;
  requireExternalStaging?: boolean;
  requireOperatorApprovals?: boolean;
  requireAgentGitService?: boolean;
}

export interface PlatformGoalAuditResult {
  schemaVersion: "platform-goal-audit/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  reportDir: string;
  reportPath?: string;
  requireExternalStaging: boolean;
  requireOperatorApprovals: boolean;
  requireAgentGitService: boolean;
  target: {
    name: "multi-user-online-sandbox-harness-loop";
    mvpIsScopeReduction: false;
    requiredEvidence: string[];
  };
  gates: {
    visionLockOk: boolean;
    localMvpOk: boolean;
    onlineSandboxOk: boolean;
    concurrencyAuditOk: boolean;
    ciRunProofOk: boolean;
    ciRunProofAnchorOk: boolean;
    ciRunProofStagingProofAnchorOk: boolean;
    ciRunProofHandoffOk: boolean;
    stagingPrerequisitesOk: boolean;
    stagingPrerequisitesProofAnchorOk: boolean;
    stagingRunOk: boolean;
    stagingRunProofAnchorOk: boolean;
    externalStagingAuditOk: boolean;
    externalStagingAuditProofAnchorOk: boolean;
    operatorArtifactsProofAnchorOk: boolean;
    operatorArtifactsPreServeReportsAnchorOk: boolean;
    operatorArtifactsCoreReportsAnchorOk: boolean;
    operatorArtifactsStrictModeOk: boolean;
    operatorCockpitRunnerExecuteOk: boolean;
    operatorCockpitRunnerProofAnchorOk: boolean;
    operatorApprovalsProofAnchorOk: boolean;
    externalStagingOk: boolean;
    operatorApprovalsOk: boolean;
    strictProofOk: boolean;
    agentGitServiceProviderOk: boolean;
    agentGitServiceUpstreamOk: boolean;
    productionCutoverReady: boolean;
  };
  reports: Record<string, PlatformGoalAuditReportRef>;
  missing: string[];
  nextActions: string[];
}

export interface PlatformGoalAuditReportRef {
  name: string;
  path: string;
  exists: boolean;
  ok?: boolean;
  schemaVersion?: string;
}

interface LoadedReport extends PlatformGoalAuditReportRef {
  value?: unknown;
  sha256?: string;
}

const REQUIRED_GOAL_EVIDENCE = [
  "vision-lock",
  "online-sandbox-smoke",
  "run-scoped-workspaces",
  "multi-agent-concurrency",
  "ci-run-proof",
  "external-staging-prerequisites",
  "external-staging-proof",
  "operator-approval-proof",
  "operator-cockpit-execution-lease",
  "agent-git-service-provider-adapter",
  "upstream-agent-git-service-staging-proof",
];
const AGENT_GIT_SERVICE_NATIVE_PROJECTION_CAPABILITY = "agent-git-service-native-projection";

export function createPlatformGoalAudit(options: PlatformGoalAuditCliOptions = {}): PlatformGoalAuditResult {
  const dir = resolve(options.dir ?? process.cwd());
  const reportDir = resolve(join(dir, "reports"));
  const requireExternalStaging = options.requireExternalStaging === true;
  const requireOperatorApprovals = options.requireOperatorApprovals === true;
  const requireAgentGitService = options.requireAgentGitService === true;
  const reports = platformGoalAuditReports(reportDir);
  const gates = platformGoalAuditGates({
    reports,
    requireExternalStaging,
    requireOperatorApprovals,
    requireAgentGitService,
  });
  const missing = platformGoalAuditMissing({
    reports,
    gates,
    requireExternalStaging,
    requireOperatorApprovals,
    requireAgentGitService,
  });
  return {
    schemaVersion: "platform-goal-audit/v1",
    ok: missing.length === 0,
    tokenFree: true,
    dir,
    reportDir,
    reportPath: options.report ? resolve(options.report) : undefined,
    requireExternalStaging,
    requireOperatorApprovals,
    requireAgentGitService,
    target: {
      name: "multi-user-online-sandbox-harness-loop",
      mvpIsScopeReduction: false,
      requiredEvidence: REQUIRED_GOAL_EVIDENCE,
    },
    gates,
    reports: platformGoalAuditReportRefs(reports),
    missing,
    nextActions: platformGoalAuditNextActions(missing),
  };
}

function platformGoalAuditReports(reportDir: string): Record<string, LoadedReport> {
  return {
    cutoverReport: loadPlatformGoalAuditReport(reportDir, "cutover-report.json"),
    smoke: loadPlatformGoalAuditReport(reportDir, "smoke.json"),
    concurrencyAudit: loadPlatformGoalAuditReport(reportDir, "concurrency-audit.json"),
    ciRunProof: loadPlatformGoalAuditReport(reportDir, "ci-run-proof.json"),
    ciWorkflowDispatch: loadPlatformGoalAuditReport(reportDir, "ci-workflow-dispatch.json"),
    ciWorkflowWait: loadPlatformGoalAuditReport(reportDir, "ci-workflow-wait.json"),
    stagingPrerequisites: loadPlatformGoalAuditReport(reportDir, "staging-prerequisites.json"),
    stagingRun: loadPlatformGoalAuditReport(reportDir, "staging-run.json"),
    externalStagingAudit: loadPlatformGoalAuditReport(reportDir, "external-staging-audit.json"),
    operatorApprovals: loadPlatformGoalAuditReport(reportDir, "operator-approvals.json"),
    operatorCockpitRunnerExecute: loadPlatformGoalAuditReport(reportDir, "operator-cockpit-runner-execute.json"),
    operatorArtifacts: loadPlatformGoalAuditReport(reportDir, "operator-artifacts.json"),
    stagingProof: loadPlatformGoalAuditReport(reportDir, "staging-proof.json"),
    upstreamAgentGitServiceServerEnvPlan: loadPlatformGoalAuditReport(reportDir, "upstream-agent-git-service-server-env-plan.json"),
    upstreamAgentGitServiceHandoff: loadPlatformGoalAuditReport(reportDir, "upstream-agent-git-service-handoff.json"),
    agentGitServiceStagingReadiness: loadPlatformGoalAuditReport(reportDir, "agent-git-service-staging-readiness.json"),
    agentGitServiceNativeWriteCheck: loadPlatformGoalAuditReport(reportDir, "agent-git-service-native-write-check.json"),
    agentGitServiceCompatManifest: loadPlatformGoalAuditReport(reportDir, "agent-git-service-compat/manifest.json"),
    agentGitServiceCompatBaseline: loadPlatformGoalAuditReport(reportDir, "agent-git-service-compat/baseline.json"),
    agentGitServiceCompatCandidate: loadPlatformGoalAuditReport(reportDir, "agent-git-service-compat/candidate.json"),
    agentGitServiceCompatComparison: loadPlatformGoalAuditReport(reportDir, "agent-git-service-compat/compare.json"),
  };
}

function loadPlatformGoalAuditReport(reportDir: string, name: string): LoadedReport {
  const path = join(reportDir, name);
  if (!existsSync(path)) return { name, path, exists: false };
  try {
    const text = readFileSync(path, "utf8");
    const value = JSON.parse(text) as unknown;
    const record = platformGoalAuditRecord(value);
    return {
      name,
      path,
      exists: true,
      sha256: sha256Hex(text),
      ok: record?.ok === true || record?.status === "passed",
      schemaVersion: typeof record?.schemaVersion === "string" ? record.schemaVersion : undefined,
      value,
    };
  } catch {
    return { name, path, exists: true, ok: false };
  }
}

function platformGoalAuditGates(options: {
  reports: Record<string, LoadedReport>;
  requireExternalStaging: boolean;
  requireOperatorApprovals: boolean;
  requireAgentGitService: boolean;
}): PlatformGoalAuditResult["gates"] {
  const cutover = platformGoalAuditRecord(options.reports.cutoverReport.value);
  const smoke = platformGoalAuditRecord(options.reports.smoke.value);
  const concurrencyAudit = platformGoalAuditRecord(options.reports.concurrencyAudit.value);
  const ciRunProof = platformGoalAuditRecord(options.reports.ciRunProof.value);
  const ciWorkflowDispatch = platformGoalAuditRecord(options.reports.ciWorkflowDispatch.value);
  const ciWorkflowWait = platformGoalAuditRecord(options.reports.ciWorkflowWait.value);
  const stagingPrerequisites = platformGoalAuditRecord(options.reports.stagingPrerequisites.value);
  const stagingRun = platformGoalAuditRecord(options.reports.stagingRun.value);
  const externalStagingAudit = platformGoalAuditRecord(options.reports.externalStagingAudit.value);
  const operatorApprovals = platformGoalAuditRecord(options.reports.operatorApprovals.value);
  const operatorCockpitRunnerExecute = platformGoalAuditRecord(options.reports.operatorCockpitRunnerExecute.value);
  const operatorArtifacts = platformGoalAuditRecord(options.reports.operatorArtifacts.value);
  const stagingProof = platformGoalAuditRecord(options.reports.stagingProof.value);
  const visionLockOk = cutover?.ok === true &&
    cutover.serverVisionLockOk === true &&
    cutover.tenantVisionLockOk === true &&
    cutover.serverVisionLockMvpIsScopeReduction === false &&
    cutover.tenantVisionLockMvpIsScopeReduction === false;
  const onlineSandboxCapabilities = platformGoalAuditArray(smoke?.onlineSandboxGoldenPathCapabilities);
  const onlineSandboxAgentGitServiceNativeProjectionOk = options.requireAgentGitService
    ? smoke?.agentGitServiceNativeProjectionChecked === true &&
      onlineSandboxCapabilities.includes(AGENT_GIT_SERVICE_NATIVE_PROJECTION_CAPABILITY)
    : smoke?.agentGitServiceNativeProjectionChecked !== false;
  const onlineSandboxOk = smoke?.ok === true &&
    smoke.status === "passed" &&
    onlineSandboxCapabilities.includes("multi-user-isolation") &&
    onlineSandboxCapabilities.includes("auditable-harness-loop") &&
    onlineSandboxAgentGitServiceNativeProjectionOk;
  const concurrencyAuditOk = concurrencyAudit?.schemaVersion === "platform-concurrency-audit/v1" &&
    concurrencyAudit.ok === true &&
    concurrencyAudit.tokenFree === true &&
    platformGoalAuditArray(concurrencyAudit.missing).length === 0 &&
    platformGoalAuditGate(concurrencyAudit, "cutoverConcurrencyOk") &&
    platformGoalAuditGate(concurrencyAudit, "smokeConcurrencyOk") &&
    platformGoalAuditGate(concurrencyAudit, "runScopedWorkspaces") &&
    platformGoalAuditGate(concurrencyAudit, "workspaceBranchLeaseOk") &&
    platformGoalAuditGate(concurrencyAudit, "multiAgentSmokeOk") &&
    (!options.requireAgentGitService || (
      platformGoalAuditGate(concurrencyAudit, "agentGitServiceCutoverOk") &&
      platformGoalAuditGate(concurrencyAudit, "agentGitServiceNativeProjectionOk")
    ));
  const stagingPrerequisitesOk = !options.requireExternalStaging || (
    stagingPrerequisites?.schemaVersion === "platform-staging-prerequisites/v1" &&
    stagingPrerequisites.ok === true &&
    stagingPrerequisites.tokenFree === true &&
    platformGoalAuditArray(stagingPrerequisites.missing).length === 0 &&
    platformGoalAuditGate(stagingPrerequisites, "bundleOk") &&
    platformGoalAuditGate(stagingPrerequisites, "strictCommandsOk") &&
    platformGoalAuditGate(stagingPrerequisites, "environmentOk") &&
    platformGoalAuditGate(stagingPrerequisites, "toolingOk") &&
    platformGoalAuditGate(stagingPrerequisites, "externalTargetsReady") &&
    (!options.requireAgentGitService || platformGoalAuditGate(stagingPrerequisites, "upstreamAgentGitServiceOk"))
  );
  const stagingPrerequisitesProofAnchorOk = !options.requireExternalStaging || (
    stagingPrerequisitesOk &&
    platformGoalAuditStagingProofReportSha256(stagingProof, "staging-prerequisites.json") ===
      options.reports.stagingPrerequisites.sha256
  );
  const stagingRunOk = !options.requireExternalStaging || (
    stagingRun?.schemaVersion === "platform-staging-run/v1" &&
    stagingRun.ok === true &&
    stagingRun.tokenFree === true &&
    stagingRun.phase === "pre-serve" &&
    stagingRun.requireExternalStaging === true &&
    platformGoalAuditArray(stagingRun.missing).length === 0 &&
    platformGoalAuditArray(stagingRun.forbiddenValueHitReports).length === 0 &&
    platformGoalAuditGate(stagingRun, "readyForServe")
  );
  const stagingRunProofAnchorOk = !options.requireExternalStaging || (
    stagingRunOk &&
    platformGoalAuditStagingProofReportObjectSha256(stagingProof, "stagingRun") ===
      options.reports.stagingRun.sha256
  );
  const externalStagingAuditOk = !options.requireExternalStaging || (
    externalStagingAudit?.schemaVersion === "platform-external-staging-audit/v1" &&
    externalStagingAudit.ok === true &&
    externalStagingAudit.tokenFree === true &&
    platformGoalAuditArray(externalStagingAudit.missing).length === 0 &&
    platformGoalAuditGate(externalStagingAudit, "bundleOk") &&
    platformGoalAuditGate(externalStagingAudit, "environmentOk") &&
    platformGoalAuditGate(externalStagingAudit, "externalTargetsReady") &&
    platformGoalAuditGate(externalStagingAudit, "stagingPrerequisitesOk") &&
    platformGoalAuditGate(externalStagingAudit, "preServeEvidenceOk") &&
    platformGoalAuditGate(externalStagingAudit, "stagingRunReady") &&
    platformGoalAuditGate(externalStagingAudit, "stagingVerdictReady")
  );
  const externalStagingAuditProofAnchorOk = !options.requireExternalStaging || (
    externalStagingAuditOk &&
    platformGoalAuditStagingProofReportObjectSha256(stagingProof, "externalStagingAudit") ===
      options.reports.externalStagingAudit.sha256
  );
  const operatorArtifactsProofAnchorOk = !options.requireExternalStaging || (
    operatorArtifacts?.ok === true &&
    platformGoalAuditStagingProofReportObjectSha256(stagingProof, "operatorArtifacts") ===
      options.reports.operatorArtifacts.sha256
  );
  const operatorArtifactsPreServeReportsAnchorOk = !options.requireExternalStaging || (
    operatorArtifacts?.ok === true &&
    platformGoalAuditOperatorArtifactsReportSha256(operatorArtifacts, "staging-prerequisites.json") ===
      options.reports.stagingPrerequisites.sha256 &&
    platformGoalAuditOperatorArtifactsReportSha256(operatorArtifacts, "staging-run.json") ===
      options.reports.stagingRun.sha256 &&
    platformGoalAuditOperatorArtifactsReportSha256(operatorArtifacts, "external-staging-audit.json") ===
      options.reports.externalStagingAudit.sha256
  );
  const operatorArtifactsCoreReportsAnchorOk = !options.requireExternalStaging || (
    operatorArtifacts?.ok === true &&
    platformGoalAuditOperatorArtifactsReportSha256(operatorArtifacts, "cutover-report.json") ===
      options.reports.cutoverReport.sha256 &&
    platformGoalAuditOperatorArtifactsReportSha256(operatorArtifacts, "smoke.json") ===
      options.reports.smoke.sha256 &&
    platformGoalAuditOperatorArtifactsReportSha256(operatorArtifacts, "concurrency-audit.json") ===
      options.reports.concurrencyAudit.sha256
  );
  const ciRunProofOk = ciRunProof?.schemaVersion === "platform-ci-run-proof/v1" &&
    ciRunProof.ok === true &&
    ciRunProof.tokenFree === true &&
    ciRunProof.provider === "github-actions" &&
    ciRunProof.phase === "post-serve" &&
    ciRunProof.status === "success" &&
    platformGoalAuditGate(ciRunProof, "githubActionsEnvironment") &&
    platformGoalAuditGate(ciRunProof, "runIdentityOk") &&
    platformGoalAuditGate(ciRunProof, "phaseOk") &&
    platformGoalAuditGate(ciRunProof, "statusOk") &&
    platformGoalAuditGate(ciRunProof, "workflowOk") &&
    platformGoalAuditGate(ciRunProof, "installedWorkflowOk") &&
    platformGoalAuditGate(ciRunProof, "installReportOk") &&
    platformGoalAuditCiRunProofUrlOk(ciRunProof);
  const ciRunProofAnchorOk = ciRunProofOk &&
    platformGoalAuditOperatorArtifactsReportSha256(operatorArtifacts, "ci-run-proof.json") ===
      options.reports.ciRunProof.sha256;
  const ciRunProofStagingProofAnchorOk = !options.requireExternalStaging || (
    ciRunProofOk &&
    platformGoalAuditStagingProofReportSha256(stagingProof, "ci-run-proof.json") ===
      options.reports.ciRunProof.sha256
  );
  const ciRunProofHandoffOk = ciRunProofOk && platformGoalAuditCiRunProofHandoffOk({
    ciRunProof,
    ciWorkflowDispatch,
    ciWorkflowDispatchExists: options.reports.ciWorkflowDispatch.exists,
    ciWorkflowWait,
    ciWorkflowWaitExists: options.reports.ciWorkflowWait.exists,
  });
  const operatorArtifactsStrictModeOk = !(options.requireExternalStaging || options.requireOperatorApprovals) || (
    operatorArtifacts?.schemaVersion === "platform-cutover-artifacts/v1" &&
    operatorArtifacts.ok === true &&
    operatorArtifacts.tokenFree === true &&
    (!options.requireExternalStaging || operatorArtifacts.requireExternalStaging === true) &&
    (!options.requireOperatorApprovals || operatorArtifacts.requireOperatorApprovals === true) &&
    (!options.requireExternalStaging || operatorArtifacts.requireOperatorCockpitRunnerExecute === true) &&
    platformGoalAuditArray(operatorArtifacts.missingReports).length === 0 &&
    platformGoalAuditArray(operatorArtifacts.forbiddenValueHitReports).length === 0 &&
    platformGoalAuditArray(operatorArtifacts.hashMismatchedReports).length === 0 &&
    platformGoalAuditArray(operatorArtifacts.stageAnchorMismatchedReports).length === 0 &&
    platformGoalAuditArray(operatorArtifacts.preServeEvidenceMissing).length === 0 &&
    platformGoalAuditArray(operatorArtifacts.postServeEvidenceMissing).length === 0 &&
    platformGoalAuditGate(operatorArtifacts, "preServeEvidenceOk") &&
    platformGoalAuditGate(operatorArtifacts, "postServeEvidenceOk") &&
    (!options.requireExternalStaging || platformGoalAuditGate(operatorArtifacts, "externalStagingReady")) &&
    (!options.requireOperatorApprovals || platformGoalAuditGate(operatorArtifacts, "operatorApprovalsOk"))
  );
  const externalStagingOk = !options.requireExternalStaging || (
    stagingProof?.schemaVersion === "platform-staging-proof/v1" &&
    stagingProof.ok === true &&
    stagingProof.tokenFree === true &&
    stagingProof.requireExternalStaging === true &&
    platformGoalAuditGate(stagingProof, "externalStagingReady") &&
    platformGoalAuditGate(stagingProof, "preServeEvidenceOk") &&
    platformGoalAuditGate(stagingProof, "postServeEvidenceOk")
  );
  const operatorApprovalsOk = !options.requireOperatorApprovals || (
    operatorApprovals?.schemaVersion === "platform-operator-approvals/v1" &&
    operatorApprovals.ok === true &&
    operatorApprovals.tokenFree === true &&
    platformGoalAuditGate(operatorApprovals, "allReportsPresent") &&
    platformGoalAuditGate(operatorApprovals, "allReportsOk") &&
    platformGoalAuditGate(operatorApprovals, "allGatesApproved") &&
    platformGoalAuditGate(operatorApprovals, "allStagesExecuted") &&
    platformGoalAuditGate(operatorApprovals, "allRequirementsSatisfied")
  );
  const operatorApprovalsProofAnchorOk = !options.requireOperatorApprovals || (
    operatorApprovalsOk &&
    platformGoalAuditStagingProofReportObjectSha256(stagingProof, "operatorApprovals") ===
      options.reports.operatorApprovals.sha256
  );
  const operatorCockpitRunnerExecuteOk = operatorCockpitRunnerExecute?.schemaVersion === "platform-operator-cockpit-runner/v1" &&
    operatorCockpitRunnerExecute.ok === true &&
    operatorCockpitRunnerExecute.tokenFree === true &&
    operatorCockpitRunnerExecute.mode === "executed" &&
    platformGoalAuditArray(operatorCockpitRunnerExecute.missing).length === 0 &&
    platformGoalAuditRecord(operatorCockpitRunnerExecute.execution)?.requested === true &&
    platformGoalAuditRecord(operatorCockpitRunnerExecute.execution)?.exitCode === 0 &&
    platformGoalAuditRecord(operatorCockpitRunnerExecute.executionLease)?.acquired === true;
  const operatorCockpitRunnerProofAnchorOk = operatorCockpitRunnerExecuteOk &&
    platformGoalAuditOperatorArtifactsReportSha256(operatorArtifacts, "operator-cockpit-runner-execute.json") ===
      options.reports.operatorCockpitRunnerExecute.sha256;
  const strictProofOk = stagingProof?.schemaVersion === "platform-staging-proof/v1" &&
    stagingProof.ok === true &&
    stagingProof.tokenFree === true &&
    (!options.requireExternalStaging || stagingProof.requireExternalStaging === true) &&
    (!options.requireOperatorApprovals || stagingProof.requireOperatorApprovals === true) &&
    platformGoalAuditArray(stagingProof.missing).length === 0 &&
    platformGoalAuditArray(stagingProof.missingReports).length === 0 &&
    platformGoalAuditArray(stagingProof.forbiddenValueHitReports).length === 0 &&
    platformGoalAuditGate(stagingProof, "operatorArtifactsOk") &&
    platformGoalAuditGate(stagingProof, "postServeEvidenceOk") &&
    (!options.requireOperatorApprovals || platformGoalAuditGate(stagingProof, "operatorApprovalsOk"));
  const agentGitServiceProviderOk = !options.requireAgentGitService || (
    platformGoalAuditString(cutover?.controlPlaneProvider) === "agent-git-service" &&
    platformGoalAuditString(smoke?.serverControlPlaneProvider) === "agent-git-service" &&
    platformGoalAuditString(smoke?.tenantControlPlaneProvider) === "agent-git-service" &&
    smoke?.agentGitServiceCutoverChecked === true &&
    smoke?.agentGitServiceCutoverWorkspaceTokenChecked === true &&
    smoke?.agentGitServiceNativeProjectionChecked === true &&
    platformGoalAuditGate(concurrencyAudit, "agentGitServiceCutoverOk") &&
    platformGoalAuditGate(concurrencyAudit, "agentGitServiceNativeProjectionOk")
  );
  const agentGitServiceUpstreamOk = !(options.requireAgentGitService && options.requireExternalStaging) ||
    platformGoalAuditAgentGitServiceUpstreamOk(options.reports, operatorArtifacts);
  const localMvpOk = visionLockOk && onlineSandboxOk && concurrencyAuditOk;
  const productionCutoverReady = localMvpOk &&
    ciRunProofOk &&
    ciRunProofAnchorOk &&
    ciRunProofStagingProofAnchorOk &&
    ciRunProofHandoffOk &&
    stagingPrerequisitesOk &&
    stagingPrerequisitesProofAnchorOk &&
    stagingRunOk &&
    stagingRunProofAnchorOk &&
    externalStagingAuditOk &&
    externalStagingAuditProofAnchorOk &&
    operatorArtifactsProofAnchorOk &&
    operatorArtifactsPreServeReportsAnchorOk &&
    operatorArtifactsCoreReportsAnchorOk &&
    operatorArtifactsStrictModeOk &&
    externalStagingOk &&
    operatorApprovalsOk &&
    operatorApprovalsProofAnchorOk &&
    operatorCockpitRunnerExecuteOk &&
    operatorCockpitRunnerProofAnchorOk &&
    strictProofOk &&
    agentGitServiceProviderOk &&
    agentGitServiceUpstreamOk &&
    operatorArtifacts?.ok === true &&
    platformGoalAuditGate(operatorArtifacts, "postServeEvidenceOk");
  return {
    visionLockOk,
    localMvpOk,
    onlineSandboxOk,
    concurrencyAuditOk,
    ciRunProofOk,
    ciRunProofAnchorOk,
    ciRunProofStagingProofAnchorOk,
    ciRunProofHandoffOk,
    stagingPrerequisitesOk,
    stagingPrerequisitesProofAnchorOk,
    stagingRunOk,
    stagingRunProofAnchorOk,
    externalStagingAuditOk,
    externalStagingAuditProofAnchorOk,
    operatorArtifactsProofAnchorOk,
    operatorArtifactsPreServeReportsAnchorOk,
    operatorArtifactsCoreReportsAnchorOk,
    operatorArtifactsStrictModeOk,
    operatorCockpitRunnerExecuteOk,
    operatorCockpitRunnerProofAnchorOk,
    operatorApprovalsProofAnchorOk,
    externalStagingOk,
    operatorApprovalsOk,
    strictProofOk,
    agentGitServiceProviderOk,
    agentGitServiceUpstreamOk,
    productionCutoverReady,
  };
}

function platformGoalAuditMissing(options: {
  reports: Record<string, LoadedReport>;
  gates: PlatformGoalAuditResult["gates"];
  requireExternalStaging: boolean;
  requireOperatorApprovals: boolean;
  requireAgentGitService: boolean;
}): string[] {
  return [
    ...(options.reports.cutoverReport.exists ? [] : ["reports.cutoverReport"]),
    ...(options.reports.smoke.exists ? [] : ["reports.smoke"]),
    ...(options.reports.concurrencyAudit.exists ? [] : ["reports.concurrencyAudit"]),
    ...(options.reports.ciRunProof.exists ? [] : ["reports.ciRunProof"]),
    ...(options.gates.visionLockOk ? [] : ["visionLock"]),
    ...(options.gates.onlineSandboxOk ? [] : ["onlineSandbox"]),
    ...(options.gates.concurrencyAuditOk ? [] : ["concurrencyAudit"]),
    ...(options.gates.ciRunProofOk ? [] : ["ciRunProof"]),
    ...(options.gates.ciRunProofAnchorOk ? [] : ["ciRunProofAnchor"]),
    ...(options.gates.ciRunProofStagingProofAnchorOk ? [] : ["ciRunProofStagingProofAnchor"]),
    ...(options.gates.ciRunProofHandoffOk ? [] : ["ciRunProofHandoff"]),
    ...(options.requireExternalStaging && !options.reports.stagingPrerequisites.exists ? ["reports.stagingPrerequisites"] : []),
    ...(options.requireExternalStaging && !options.gates.stagingPrerequisitesOk ? ["stagingPrerequisites"] : []),
    ...(options.requireExternalStaging && !options.gates.stagingPrerequisitesProofAnchorOk ? ["stagingPrerequisitesProofAnchor"] : []),
    ...(options.requireExternalStaging && !options.reports.stagingRun.exists ? ["reports.stagingRun"] : []),
    ...(options.requireExternalStaging && !options.gates.stagingRunOk ? ["stagingRun"] : []),
    ...(options.requireExternalStaging && !options.gates.stagingRunProofAnchorOk ? ["stagingRunProofAnchor"] : []),
    ...(options.requireExternalStaging && !options.reports.externalStagingAudit.exists ? ["reports.externalStagingAudit"] : []),
    ...(options.requireExternalStaging && !options.gates.externalStagingAuditOk ? ["externalStagingAudit"] : []),
    ...(options.requireExternalStaging && !options.gates.externalStagingAuditProofAnchorOk ? ["externalStagingAuditProofAnchor"] : []),
    ...(options.requireExternalStaging && !options.gates.operatorArtifactsProofAnchorOk ? ["operatorArtifactsProofAnchor"] : []),
    ...(options.requireExternalStaging && !options.gates.operatorArtifactsPreServeReportsAnchorOk ? ["operatorArtifactsPreServeReportsAnchor"] : []),
    ...(options.requireExternalStaging && !options.gates.operatorArtifactsCoreReportsAnchorOk ? ["operatorArtifactsCoreReportsAnchor"] : []),
    ...((options.requireExternalStaging || options.requireOperatorApprovals) && !options.gates.operatorArtifactsStrictModeOk ? ["operatorArtifactsStrictMode"] : []),
    ...(options.requireExternalStaging && !options.reports.stagingProof.exists ? ["reports.stagingProof"] : []),
    ...(options.requireExternalStaging && !options.gates.externalStagingOk ? ["externalStaging"] : []),
    ...(options.requireOperatorApprovals && !options.reports.operatorApprovals.exists ? ["reports.operatorApprovals"] : []),
    ...(options.requireOperatorApprovals && !options.gates.operatorApprovalsOk ? ["operatorApprovals"] : []),
    ...(options.requireOperatorApprovals && !options.gates.operatorApprovalsProofAnchorOk ? ["operatorApprovalsProofAnchor"] : []),
    ...(options.reports.operatorCockpitRunnerExecute.exists ? [] : ["reports.operatorCockpitRunnerExecute"]),
    ...(options.gates.operatorCockpitRunnerExecuteOk ? [] : ["operatorCockpitRunnerExecute"]),
    ...(options.gates.operatorCockpitRunnerProofAnchorOk ? [] : ["operatorCockpitRunnerProofAnchor"]),
    ...(options.gates.strictProofOk ? [] : ["strictProof"]),
    ...(options.requireAgentGitService && !options.gates.agentGitServiceProviderOk ? ["agentGitServiceProvider"] : []),
    ...(options.requireAgentGitService && options.requireExternalStaging && !options.gates.agentGitServiceUpstreamOk ? ["agentGitServiceUpstream"] : []),
    ...(options.gates.productionCutoverReady ? [] : ["productionCutoverReady"]),
  ];
}

function platformGoalAuditNextActions(missing: string[]): string[] {
  const actions: string[] = [];
  if (missing.some((item) => item === "reports.cutoverReport" || item === "reports.smoke" || item === "visionLock" || item === "onlineSandbox")) {
    actions.push("Run loom harness cutover-report and loom harness smoke --profile platform-readiness, then rerun platform-goal-audit.");
  }
  if (missing.includes("concurrencyAudit") || missing.includes("reports.concurrencyAudit")) {
    actions.push("Run loom harness platform-concurrency-audit after cutover and smoke reports are current.");
  }
  if (missing.includes("ciRunProof") || missing.includes("ciRunProofAnchor") || missing.includes("ciRunProofStagingProofAnchor") ||
    missing.includes("ciRunProofHandoff") || missing.includes("reports.ciRunProof")) {
    actions.push("Run or import the matching post-serve GitHub Actions proof, rerun final artifact verification, then rerun platform-goal-audit.");
  }
  if (missing.includes("stagingPrerequisites") || missing.includes("reports.stagingPrerequisites") ||
    missing.includes("stagingPrerequisitesProofAnchor") ||
    missing.includes("stagingRun") ||
    missing.includes("reports.stagingRun") ||
    missing.includes("stagingRunProofAnchor") ||
    missing.includes("externalStagingAudit") ||
    missing.includes("reports.externalStagingAudit") ||
    missing.includes("externalStagingAuditProofAnchor") ||
    missing.includes("operatorArtifactsProofAnchor") ||
    missing.includes("operatorArtifactsPreServeReportsAnchor") ||
    missing.includes("operatorArtifactsCoreReportsAnchor") ||
    missing.includes("operatorArtifactsStrictMode") ||
    missing.includes("operatorApprovalsProofAnchor") ||
    missing.includes("externalStaging") || missing.includes("reports.stagingProof") || missing.includes("strictProof")) {
    actions.push("Run LOOM_REQUIRE_EXTERNAL_STAGING=1 LOOM_REQUIRE_OPERATOR_APPROVALS=1 pre-serve and post-serve bundle commands, then rerun platform-goal-audit.");
  }
  if (missing.includes("operatorApprovals") || missing.includes("reports.operatorApprovals")) {
    actions.push("Run the generated approval-required stages and loom harness platform-operator-approvals.");
  }
  if (missing.includes("operatorCockpitRunnerExecute") ||
    missing.includes("operatorCockpitRunnerProofAnchor") ||
    missing.includes("reports.operatorCockpitRunnerExecute")) {
    actions.push("Execute the current operator cockpit command through platform-operator-cockpit-runner --execute or the confirmed cockpit POST, rerun final artifact verification, then rerun platform-goal-audit.");
  }
  if (missing.includes("agentGitServiceProvider")) {
    actions.push("Finish the agent-git-service provider staging path before tenant cutover.");
  }
  if (missing.includes("agentGitServiceUpstream")) {
    actions.push("Run upstream AGS handoff, staging readiness, native write, and compat rehearsal reports; rerun final artifact verification, then rerun platform-goal-audit.");
  }
  return [...new Set(actions)];
}

function platformGoalAuditReportRefs(reports: Record<string, LoadedReport>): Record<string, PlatformGoalAuditReportRef> {
  return Object.fromEntries(Object.entries(reports).map(([key, report]) => [
    key,
    {
      name: report.name,
      path: report.path,
      exists: report.exists,
      ok: report.ok,
      schemaVersion: report.schemaVersion,
    },
  ]));
}

function platformGoalAuditRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function platformGoalAuditGate(value: Record<string, unknown> | undefined, gate: string): boolean {
  const gates = platformGoalAuditRecord(value?.gates);
  return gates?.[gate] === true;
}

function platformGoalAuditArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function platformGoalAuditString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function platformGoalAuditCiRunProofUrlOk(value: Record<string, unknown>): boolean {
  const github = platformGoalAuditRecord(value.github);
  return typeof github?.runUrl === "string" && /^https:\/\//.test(github.runUrl);
}

function platformGoalAuditCiRunProofHandoffOk(options: {
  ciRunProof: Record<string, unknown> | undefined;
  ciWorkflowDispatch: Record<string, unknown> | undefined;
  ciWorkflowDispatchExists: boolean;
  ciWorkflowWait: Record<string, unknown> | undefined;
  ciWorkflowWaitExists: boolean;
}): boolean {
  if (!options.ciWorkflowWaitExists && !options.ciWorkflowDispatchExists) return true;
  const github = platformGoalAuditRecord(options.ciRunProof?.github);
  const proofRunId = platformGoalAuditString(github?.runId);
  if (proofRunId === undefined) return false;
  if (options.ciWorkflowWaitExists) {
    const run = platformGoalAuditRecord(options.ciWorkflowWait?.run);
    return options.ciWorkflowWait?.schemaVersion === "platform-ci-workflow-wait/v1" &&
      options.ciWorkflowWait.ok === true &&
      options.ciWorkflowWait.tokenFree === true &&
      options.ciWorkflowWait.provider === "github-actions" &&
      options.ciWorkflowWait.phase === "post-serve" &&
      platformGoalAuditString(options.ciWorkflowWait.runId) === proofRunId &&
      platformGoalAuditString(run?.id) === proofRunId &&
      platformGoalAuditGate(options.ciWorkflowWait, "runIdOk") &&
      platformGoalAuditGate(options.ciWorkflowWait, "runSucceeded") &&
      platformGoalAuditArray(options.ciWorkflowWait.missing).length === 0;
  }
  const run = platformGoalAuditRecord(options.ciWorkflowDispatch?.run);
  return options.ciWorkflowDispatch?.schemaVersion === "platform-ci-workflow-dispatch/v1" &&
    options.ciWorkflowDispatch.ok === true &&
    options.ciWorkflowDispatch.tokenFree === true &&
    options.ciWorkflowDispatch.provider === "github-actions" &&
    options.ciWorkflowDispatch.phase === "post-serve" &&
    platformGoalAuditString(run?.id) === proofRunId &&
    platformGoalAuditGate(options.ciWorkflowDispatch, "runIdentified") &&
    platformGoalAuditArray(options.ciWorkflowDispatch.missing).length === 0;
}

function platformGoalAuditAgentGitServiceUpstreamOk(
  reports: Record<string, LoadedReport>,
  operatorArtifacts: Record<string, unknown> | undefined,
): boolean {
  const nativeWriteRequired = reports.agentGitServiceNativeWriteCheck.exists ||
    platformGoalAuditOperatorArtifactsReportSha256(operatorArtifacts, "agent-git-service-native-write-check.json") !== undefined;
  return platformGoalAuditAgentGitServiceServerEnvPlanOk(reports.upstreamAgentGitServiceServerEnvPlan) &&
    platformGoalAuditAgentGitServiceHandoffOk(reports.upstreamAgentGitServiceHandoff) &&
    platformGoalAuditAgentGitServiceStagingReadinessOk(reports.agentGitServiceStagingReadiness) &&
    (!nativeWriteRequired || platformGoalAuditAgentGitServiceNativeWriteCheckOk(reports.agentGitServiceNativeWriteCheck)) &&
    platformGoalAuditAgentGitServiceCompatOk(reports) &&
    [
      "upstream-agent-git-service-handoff.json",
      "agent-git-service-staging-readiness.json",
      "agent-git-service-compat/manifest.json",
      "agent-git-service-compat/baseline.json",
      "agent-git-service-compat/candidate.json",
      "agent-git-service-compat/compare.json",
      ...(nativeWriteRequired ? ["agent-git-service-native-write-check.json"] : []),
    ].every((name) => platformGoalAuditOperatorArtifactsReportSha256(operatorArtifacts, name) === reports[platformGoalAuditReportKeyForName(name)]?.sha256);
}

function platformGoalAuditAgentGitServiceServerEnvPlanOk(report: LoadedReport | undefined): boolean {
  const value = platformGoalAuditRecord(report?.value);
  return platformGoalAuditReportOk(report, "upstream-agent-git-service-server-env-plan/v1") &&
    value?.provider === "agent-git-service" &&
    platformGoalAuditGate(value, "guideOk") &&
    platformGoalAuditGate(value, "requiredServerEnvNamesPresent") &&
    platformGoalAuditGate(value, "serverStartCommandReady") &&
    platformGoalAuditGate(value, "readinessProbeReady");
}

function platformGoalAuditAgentGitServiceHandoffOk(report: LoadedReport | undefined): boolean {
  const value = platformGoalAuditRecord(report?.value);
  return platformGoalAuditReportOk(report, "upstream-agent-git-service-handoff/v1") &&
    platformGoalAuditGate(value, "guideOk") &&
    platformGoalAuditGate(value, "requiredServerEnvOk") &&
    platformGoalAuditGate(value, "requiredLoomEnvOk") &&
    platformGoalAuditGate(value, "operatorChecklistOk");
}

function platformGoalAuditAgentGitServiceStagingReadinessOk(report: LoadedReport | undefined): boolean {
  const value = platformGoalAuditRecord(report?.value);
  const serverReadiness = platformGoalAuditRecord(value?.serverReadiness);
  return platformGoalAuditReportOk(report, "agent-git-service-staging-readiness/v1") &&
    value?.provider === "agent-git-service" &&
    platformGoalAuditGate(value, "token") &&
    platformGoalAuditGate(value, "serverReadiness") &&
    platformGoalAuditGate(value, "discovery") &&
    platformGoalAuditGate(value, "issueWorkspaces") &&
    platformGoalAuditGate(value, "issueComments") &&
    platformGoalAuditGate(value, "wikiMemory") &&
    serverReadiness?.ok === true &&
    serverReadiness.status === "ready";
}

function platformGoalAuditAgentGitServiceNativeWriteCheckOk(report: LoadedReport | undefined): boolean {
  const value = platformGoalAuditRecord(report?.value);
  return platformGoalAuditReportOk(report, "agent-git-service-native-write-check/v1") &&
    value?.provider === "agent-git-service" &&
    value.approved === true &&
    platformGoalAuditGate(value, "token") &&
    platformGoalAuditGate(value, "approved") &&
    platformGoalAuditGate(value, "issueComment") &&
    platformGoalAuditGate(value, "workspaceAttachment") &&
    platformGoalAuditGate(value, "wikiMemory");
}

function platformGoalAuditAgentGitServiceCompatOk(reports: Record<string, LoadedReport>): boolean {
  const manifest = platformGoalAuditRecord(reports.agentGitServiceCompatManifest.value);
  return reports.agentGitServiceCompatManifest.exists &&
    manifest?.schemaVersion === "agent-git-service-compat-rehearsal/v1" &&
    manifest.tokenFree === true &&
    manifest.comparisonOk === true &&
    platformGoalAuditAgentGitServiceProbeOk(reports.agentGitServiceCompatBaseline) &&
    platformGoalAuditAgentGitServiceProbeOk(reports.agentGitServiceCompatCandidate) &&
    platformGoalAuditReportOk(reports.agentGitServiceCompatComparison, "agent-git-service-contract-comparison/v1");
}

function platformGoalAuditAgentGitServiceProbeOk(report: LoadedReport | undefined): boolean {
  const value = platformGoalAuditRecord(report?.value);
  return report?.exists === true &&
    value?.schemaVersion === "agent-git-service-contract-probe/v1" &&
    value.ok === true &&
    (value.provider === undefined || value.provider === "agent-git-service") &&
    value.requestsTokenFree === true &&
    platformGoalAuditArray(value.missingEndpoints).length === 0;
}

function platformGoalAuditReportOk(report: LoadedReport | undefined, schemaVersion: string): boolean {
  const value = platformGoalAuditRecord(report?.value);
  return report?.exists === true &&
    value?.schemaVersion === schemaVersion &&
    value.ok === true &&
    value.tokenFree === true &&
    platformGoalAuditArray(value.missing).length === 0;
}

function platformGoalAuditReportKeyForName(name: string): string {
  switch (name) {
    case "upstream-agent-git-service-server-env-plan.json":
      return "upstreamAgentGitServiceServerEnvPlan";
    case "upstream-agent-git-service-handoff.json":
      return "upstreamAgentGitServiceHandoff";
    case "agent-git-service-staging-readiness.json":
      return "agentGitServiceStagingReadiness";
    case "agent-git-service-native-write-check.json":
      return "agentGitServiceNativeWriteCheck";
    case "agent-git-service-compat/manifest.json":
      return "agentGitServiceCompatManifest";
    case "agent-git-service-compat/baseline.json":
      return "agentGitServiceCompatBaseline";
    case "agent-git-service-compat/candidate.json":
      return "agentGitServiceCompatCandidate";
    case "agent-git-service-compat/compare.json":
      return "agentGitServiceCompatComparison";
    default:
      return "";
  }
}

function platformGoalAuditStagingProofReportSha256(
  stagingProof: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const reports = platformGoalAuditRecord(stagingProof?.reports);
  const expectedReports = Array.isArray(reports?.stagingCiExpectedReports)
    ? reports.stagingCiExpectedReports
    : [];
  const match = expectedReports.find((item) =>
    platformGoalAuditRecord(item)?.name === name
  );
  const record = platformGoalAuditRecord(match);
  return typeof record?.sha256 === "string" && /^[a-f0-9]{64}$/.test(record.sha256)
    ? record.sha256
    : undefined;
}

function platformGoalAuditStagingProofReportObjectSha256(
  stagingProof: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const reports = platformGoalAuditRecord(stagingProof?.reports);
  const record = platformGoalAuditRecord(reports?.[key]);
  return typeof record?.sha256 === "string" && /^[a-f0-9]{64}$/.test(record.sha256)
    ? record.sha256
    : undefined;
}

function platformGoalAuditOperatorArtifactsReportSha256(
  operatorArtifacts: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const reports = Array.isArray(operatorArtifacts?.reports) ? operatorArtifacts.reports : [];
  const match = reports.find((item) =>
    platformGoalAuditRecord(item)?.name === name
  );
  const record = platformGoalAuditRecord(match);
  return record?.ok === true && typeof record.sha256 === "string" && /^[a-f0-9]{64}$/.test(record.sha256)
    ? record.sha256
    : undefined;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
