import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type PlatformCiArtifactImportPhase = "pre-serve" | "post-serve" | "all";

export interface PlatformCiArtifactImportCliOptions {
  dir?: string;
  artifactDir?: string;
  phase?: string;
  runId?: string;
  allowedReports?: string[];
  report?: string;
}

export interface PlatformCiArtifactImportResult {
  schemaVersion: "platform-ci-artifact-import/v1";
  ok: boolean;
  tokenFree: true;
  provider: "github-actions";
  dir: string;
  artifactDir: string;
  sourceReportDir: string;
  reportDir: string;
  reportPath?: string;
  phase: PlatformCiArtifactImportPhase | string;
  expectedRunId?: string;
  stagingCi: {
    path: string;
    exists: boolean;
    ok: boolean;
    schemaVersion?: string;
    sha256?: string;
  };
  allowedReports: string[];
  importedReports: Array<{
    name: string;
    sourcePath: string;
    destinationPath: string;
    ok: boolean;
    schemaVersion?: string;
    sourceSha256?: string;
    destinationSha256?: string;
    semanticOk?: boolean;
  }>;
  missingReports: string[];
  invalidReports: string[];
  hashMismatchedReports: string[];
  unsafeReports: string[];
  gates: {
    stagingCiOk: boolean;
    allowedReportsOk: boolean;
    reportsPresent: boolean;
    reportsJsonOk: boolean;
    copiedSha256Ok: boolean;
  };
  missing: string[];
}

const AGENT_GIT_SERVICE_NATIVE_PROJECTION_CAPABILITY = "agent-git-service-native-projection";

export async function importPlatformCiArtifactReports(
  options: PlatformCiArtifactImportCliOptions = {},
): Promise<PlatformCiArtifactImportResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const artifactDir = resolve(options.artifactDir ?? process.cwd());
  const reportDir = join(dir, "reports");
  const reportPath = options.report ? resolve(options.report) : undefined;
  const phase = options.phase ?? "post-serve";
  const expectedRunId = options.runId ?? await readArtifactSyncRunId(join(reportDir, "ci-artifact-sync.json"), phase);
  const stagingCi = await readStagingCi(join(dir, "staging-ci.json"));
  const phaseReports = stagingCi.value ? phaseExpectedReports(stagingCi.value, phase) : [];
  const allowedReports = options.allowedReports
    ? unique(options.allowedReports).filter((name) => phaseReports.includes(name))
    : phaseReports;
  const unsafeReports = allowedReports.filter((name) => !isSafeReportRelativeName(name));
  const safeReports = allowedReports.filter(isSafeReportRelativeName);
  const sourceReportDir = resolveSourceReportDir(artifactDir);
  const importedReports: PlatformCiArtifactImportResult["importedReports"] = [];
  const missingReports: string[] = [];
  const invalidReports: string[] = [];
  const hashMismatchedReports: string[] = [];

  await mkdir(reportDir, { recursive: true });
  for (const name of safeReports) {
    const sourcePath = join(sourceReportDir, name);
    const destinationPath = join(reportDir, name);
    const imported = await importReport(name, sourcePath, destinationPath, phase, expectedRunId, stagingCi.value);
    importedReports.push(imported);
    if (!existsSync(sourcePath)) {
      missingReports.push(name);
    } else if (imported.semanticOk === false || (!imported.schemaVersion && !imported.sourceSha256)) {
      invalidReports.push(name);
    } else if (!imported.ok && imported.sourceSha256) {
      hashMismatchedReports.push(name);
    }
  }

  const gates = {
    stagingCiOk: stagingCi.ok,
    allowedReportsOk: isPlatformCiArtifactImportPhase(phase) && allowedReports.length > 0 && unsafeReports.length === 0,
    reportsPresent: missingReports.length === 0,
    reportsJsonOk: invalidReports.length === 0,
    copiedSha256Ok: hashMismatchedReports.length === 0,
  };
  const missing = [
    ...(gates.stagingCiOk ? [] : ["staging-ci.json"]),
    ...(isPlatformCiArtifactImportPhase(phase) ? [] : ["phase"]),
    ...unsafeReports.map((name) => `staging-ci.expectedReports.${name}`),
    ...missingReports.map((name) => `reports.${name}`),
    ...invalidReports.map((name) => `reports.${name}.json`),
    ...hashMismatchedReports.map((name) => `reports.${name}.sha256`),
  ];

  return {
    schemaVersion: "platform-ci-artifact-import/v1",
    ok: Object.values(gates).every(Boolean),
    tokenFree: true,
    provider: "github-actions",
    dir,
    artifactDir,
    sourceReportDir,
    reportDir,
    ...(reportPath ? { reportPath } : {}),
    phase,
    ...(expectedRunId ? { expectedRunId } : {}),
    stagingCi: {
      path: stagingCi.path,
      exists: stagingCi.exists,
      ok: stagingCi.ok,
      ...(stagingCi.schemaVersion ? { schemaVersion: stagingCi.schemaVersion } : {}),
      ...(stagingCi.sha256 ? { sha256: stagingCi.sha256 } : {}),
    },
    allowedReports,
    importedReports,
    missingReports,
    invalidReports,
    hashMismatchedReports,
    unsafeReports,
    gates,
    missing,
  };
}

async function importReport(
  name: string,
  sourcePath: string,
  destinationPath: string,
  phase: string,
  expectedRunId: string | undefined,
  stagingCi: Record<string, unknown> | undefined,
): Promise<PlatformCiArtifactImportResult["importedReports"][number]> {
  if (!existsSync(sourcePath)) {
    await removeDestinationReport(destinationPath);
    return { name, sourcePath, destinationPath, ok: false };
  }
  const text = await readFile(sourcePath, "utf8");
  const sourceSha256 = sha256Hex(text);
  let schemaVersion: string | undefined;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
    const record = objectRecord(value);
    schemaVersion = stringValue(record?.schemaVersion);
  } catch {
    await removeDestinationReport(destinationPath);
    return { name, sourcePath, destinationPath, ok: false };
  }
  if (!platformCiArtifactReportSemanticsOk(name, value, phase, expectedRunId, stagingCi)) {
    await removeDestinationReport(destinationPath);
    return { name, sourcePath, destinationPath, ok: false, ...(schemaVersion ? { schemaVersion } : {}), sourceSha256, semanticOk: false };
  }
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, text, "utf8");
  const destinationSha256 = sha256Hex(await readFile(destinationPath, "utf8"));
  const ok = destinationSha256 === sourceSha256;
  if (!ok) await removeDestinationReport(destinationPath);
  return {
    name,
    sourcePath,
    destinationPath,
    ok,
    ...(schemaVersion ? { schemaVersion } : {}),
    sourceSha256,
    destinationSha256,
  };
}

async function removeDestinationReport(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    const code = objectRecord(error)?.code;
    if (code !== "ENOENT") throw error;
  }
}

function platformCiArtifactReportSemanticsOk(
  name: string,
  value: unknown,
  phase: string,
  expectedRunId: string | undefined,
  stagingCi: Record<string, unknown> | undefined,
): boolean {
  if (name === "ci-run-proof.json") return platformCiArtifactRunProofSemanticsOk(value, phase, expectedRunId);
  if (name === "bundle-verify.json") return platformCiArtifactBundleVerifySemanticsOk(value);
  if (name === "staging-prerequisites.json") return platformCiArtifactStagingPrerequisitesSemanticsOk(value);
  if (name === "staging-run.json") return platformCiArtifactStagingRunSemanticsOk(value);
  if (name === "external-staging-audit.json") return platformCiArtifactExternalStagingAuditSemanticsOk(value);
  if (name === "staging-targets.json") return platformCiArtifactStagingTargetsSemanticsOk(value);
  if (name === "platform-preflight.json") return platformCiArtifactPlatformPreflightSemanticsOk(value);
  if (name === "staging-evidence.json") return platformCiArtifactStagingEvidenceSemanticsOk(value);
  if (name === "staging-verdict.json") return platformCiArtifactStagingVerdictSemanticsOk(value);
  if (name === "serve-ready.json") return platformCiArtifactServeReadySemanticsOk(value);
  if (name === "cutover-report.json") return platformCiArtifactCutoverReportSemanticsOk(value, stagingCi);
  if (name === "smoke.json") return platformCiArtifactSmokeSemanticsOk(value, stagingCi);
  if (name === "concurrency-audit.json") return platformCiArtifactConcurrencyAuditSemanticsOk(value);
  if (name === "operator-artifacts.json") return platformCiArtifactOperatorArtifactsSemanticsOk(value);
  if (name === "operator-approvals.json") return platformCiArtifactOperatorApprovalsSemanticsOk(value, stagingCi);
  if (name === "staging-proof.json") return platformCiArtifactStagingProofSemanticsOk(value);
  if (name === "goal-audit.json") return platformCiArtifactGoalAuditSemanticsOk(value);
  if (name === "operator-cockpit-plan.json") return platformCiArtifactOperatorCockpitPlanSemanticsOk(value, phase);
  if (name === "operator-cockpit-next.json") return platformCiArtifactOperatorCockpitNextSemanticsOk(value, phase);
  if (name === "operator-handoff-packet.json") return platformCiArtifactOperatorHandoffPacketSemanticsOk(value);
  if (name === "upstream-agent-git-service-server-env-plan.json") return platformCiArtifactUpstreamAgentGitServiceServerEnvPlanSemanticsOk(value);
  if (name === "upstream-agent-git-service-handoff.json") return platformCiArtifactUpstreamAgentGitServiceHandoffSemanticsOk(value);
  if (name === "agent-git-service-staging-readiness.json") return platformCiArtifactAgentGitServiceStagingReadinessSemanticsOk(value, stagingCi);
  if (name === "agent-git-service-compat/manifest.json") return platformCiArtifactAgentGitServiceCompatManifestSemanticsOk(value, stagingCi);
  if (name === "agent-git-service-compat/baseline.json" || name === "agent-git-service-compat/candidate.json") return platformCiArtifactAgentGitServiceCompatProbeSemanticsOk(name, value, stagingCi);
  if (name === "agent-git-service-compat/compare.json") return platformCiArtifactAgentGitServiceCompatComparisonSemanticsOk(value, stagingCi);
  if (name === "agent-git-service-native-write-check.json") return platformCiArtifactAgentGitServiceNativeWriteSemanticsOk(value, stagingCi);
  if (platformCiArtifactCutoverEnvReportName(name)) return platformCiArtifactCutoverEnvSemanticsOk(name, value);
  if (platformCiArtifactCutoverRunReportName(name)) return platformCiArtifactCutoverRunSemanticsOk(name, value);
  if (name !== "operator-cockpit-runner-execute.json") return false;
  const record = objectRecord(value);
  const execution = objectRecord(record?.execution);
  const executionLease = objectRecord(record?.executionLease);
  const missing = stringArray(record?.missing);
  return record?.schemaVersion === "platform-operator-cockpit-runner/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    record.mode === "executed" &&
    missing !== undefined &&
    missing.length === 0 &&
    execution?.requested === true &&
    execution.exitCode === 0 &&
    executionLease?.acquired === true &&
    typeof record.currentStepId === "string" &&
    typeof record.currentBlockingGroupId === "string" &&
    executionLease.currentStepId === record.currentStepId &&
    executionLease.currentBlockingGroupId === record.currentBlockingGroupId;
}

function platformCiArtifactRunProofSemanticsOk(value: unknown, phase: string, expectedRunId: string | undefined): boolean {
  const record = objectRecord(value);
  const github = objectRecord(record?.github);
  const gates = objectRecord(record?.gates);
  return record?.schemaVersion === "platform-ci-run-proof/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    record.provider === "github-actions" &&
    record.phase === phase &&
    record.status === "success" &&
    (expectedRunId === undefined || github?.runId === expectedRunId) &&
    gates?.githubActionsEnvironment === true &&
    gates.runIdentityOk === true &&
    gates.phaseOk === true &&
    gates.statusOk === true &&
    gates.workflowOk === true &&
    gates.installedWorkflowOk === true &&
    gates.installReportOk === true;
}

function platformCiArtifactBundleVerifySemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const missingFiles = stringArray(record?.missingFiles);
  const manifestFileMismatches = stringArray(record?.manifestFileMismatches);
  const manifestHashMissingFiles = stringArray(record?.manifestHashMissingFiles);
  const manifestStageIdMismatches = stringArray(record?.manifestStageIdMismatches);
  const stagingCiExpectedReportMissing = stringArray(record?.stagingCiExpectedReportMissing);
  const stagingCiOperatorApprovalMismatches = stringArray(record?.stagingCiOperatorApprovalMismatches);
  const stagingCiCheckMissing = stringArray(record?.stagingCiCheckMissing);
  const agentGitServiceCompatTargetMismatches = stringArray(record?.agentGitServiceCompatTargetMismatches);
  const upstreamAgentGitServiceHandoffMismatches = stringArray(record?.upstreamAgentGitServiceHandoffMismatches);
  const hashMismatchedFiles = stringArray(record?.hashMismatchedFiles);
  const stagingCiStrictCommandMissing = stringArray(record?.stagingCiStrictCommandMissing);
  const commandsShStrictCheckMissing = stringArray(record?.commandsShStrictCheckMissing);
  const forbiddenValueHitFiles = stringArray(record?.forbiddenValueHitFiles);
  return record?.ok === true &&
    record.tokenFree === true &&
    record.manifestTokenFree === true &&
    missingFiles !== undefined &&
    missingFiles.length === 0 &&
    manifestFileMismatches !== undefined &&
    manifestFileMismatches.length === 0 &&
    manifestHashMissingFiles !== undefined &&
    manifestHashMissingFiles.length === 0 &&
    manifestStageIdMismatches !== undefined &&
    manifestStageIdMismatches.length === 0 &&
    stagingCiExpectedReportMissing !== undefined &&
    stagingCiExpectedReportMissing.length === 0 &&
    stagingCiOperatorApprovalMismatches !== undefined &&
    stagingCiOperatorApprovalMismatches.length === 0 &&
    stagingCiCheckMissing !== undefined &&
    stagingCiCheckMissing.length === 0 &&
    agentGitServiceCompatTargetMismatches !== undefined &&
    agentGitServiceCompatTargetMismatches.length === 0 &&
    upstreamAgentGitServiceHandoffMismatches !== undefined &&
    upstreamAgentGitServiceHandoffMismatches.length === 0 &&
    hashMismatchedFiles !== undefined &&
    hashMismatchedFiles.length === 0 &&
    stagingCiStrictCommandMissing !== undefined &&
    stagingCiStrictCommandMissing.length === 0 &&
    commandsShStrictCheckMissing !== undefined &&
    commandsShStrictCheckMissing.length === 0 &&
    forbiddenValueHitFiles !== undefined &&
    forbiddenValueHitFiles.length === 0;
}

function platformCiArtifactStagingRunSemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  const reports = objectRecord(record?.reports);
  const missing = stringArray(record?.missing);
  const forbiddenValueHitReports = stringArray(record?.forbiddenValueHitReports);
  return record?.schemaVersion === "platform-staging-run/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    record.phase === "pre-serve" &&
    missing !== undefined &&
    missing.length === 0 &&
    forbiddenValueHitReports !== undefined &&
    forbiddenValueHitReports.length === 0 &&
    gates?.bundleVerifyOk === true &&
    gates.environmentOk === true &&
    gates.preServeStagesOk === true &&
    (record.requireExternalStaging !== true || gates.externalStagingReady === true) &&
    gates.stagingEvidenceOk === true &&
    gates.stagingVerdictReady === true &&
    gates.readyForServe === true &&
    platformCiArtifactReportRefOk(reports?.bundleVerify) &&
    platformCiArtifactReportRefListOk(reports?.stageEnv) &&
    platformCiArtifactReportRefListOk(reports?.stageRuns) &&
    platformCiArtifactReportRefOk(reports?.stagingTargets) &&
    platformCiArtifactReportRefOk(reports?.stagingEvidence) &&
    platformCiArtifactReportRefOk(reports?.stagingVerdict);
}

function platformCiArtifactStagingPrerequisitesSemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  const missing = stringArray(record?.missing);
  return record?.schemaVersion === "platform-staging-prerequisites/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    missing !== undefined &&
    missing.length === 0 &&
    gates?.bundleOk === true &&
    gates.strictCommandsOk === true &&
    gates.environmentOk === true &&
    gates.toolingOk === true &&
    gates.externalTargetsReady === true &&
    gates.upstreamAgentGitServiceOk === true;
}

function platformCiArtifactExternalStagingAuditSemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  const missing = stringArray(record?.missing);
  return record?.schemaVersion === "platform-external-staging-audit/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    missing !== undefined &&
    missing.length === 0 &&
    gates?.bundleOk === true &&
    gates.environmentOk === true &&
    gates.externalTargetsReady === true &&
    gates.stagingPrerequisitesOk === true &&
    gates.preServeEvidenceOk === true &&
    gates.stagingRunReady === true &&
    gates.stagingVerdictReady === true;
}

function platformCiArtifactStagingTargetsSemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  const targets = objectRecord(record?.targets);
  const modelGateway = objectRecord(targets?.modelGateway);
  const executor = objectRecord(targets?.executor);
  const controlPlane = objectRecord(targets?.controlPlane);
  const agentGitServiceStaging = objectRecord(targets?.agentGitServiceStaging);
  const missing = stringArray(record?.missing);
  const placeholderTargets = stringArray(record?.placeholderTargets);
  return record?.schemaVersion === "platform-staging-targets/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    record.mode === "external-staging" &&
    missing !== undefined &&
    missing.length === 0 &&
    placeholderTargets !== undefined &&
    placeholderTargets.length === 0 &&
    gates?.modelGatewayExternal === true &&
    gates.coderExecutor === true &&
    gates.agentGitServiceExternal === true &&
    gates.externalStagingReady === true &&
    modelGateway?.classification === "external" &&
    platformCiArtifactHttpUrlString(modelGateway.baseUrl) &&
    executor?.kind === "coder" &&
    executor.classification === "external" &&
    controlPlane?.provider === "agent-git-service" &&
    controlPlane.classification === "external" &&
    platformCiArtifactHttpUrlString(controlPlane.baseUrl) &&
    platformCiArtifactIssueRefString(agentGitServiceStaging?.issue) &&
    platformCiArtifactRepoRefString(agentGitServiceStaging?.repo) &&
    platformCiArtifactNonEmptyString(agentGitServiceStaging?.wikiPage);
}

function platformCiArtifactPlatformPreflightSemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  const model = objectRecord(record?.model);
  const modelChecks = objectRecord(model?.checks);
  const modelUsageCheck = objectRecord(modelChecks?.modelUsage);
  const modelUsage = objectRecord(model?.modelUsage);
  const coder = objectRecord(record?.coder);
  const coderChecks = objectRecord(coder?.checks);
  const coderPrepare = objectRecord(coderChecks?.prepare);
  const coderRemoteCommand = objectRecord(coderChecks?.remoteCommand);
  const coderBrowserUrls = objectRecord(coderChecks?.browserUrls);
  return record?.schemaVersion === "platform-preflight/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    Array.isArray(record.missing) &&
    record.missing.length === 0 &&
    gates?.doctor === true &&
    gates.model === true &&
    gates.controlPlane === true &&
    gates.coder === true &&
    record.nextCommandsReady === true &&
    modelUsageCheck?.ok === true &&
    platformCiArtifactNonNegativeNumber(modelUsage?.totalTokens, modelUsage?.costUsd) &&
    coderPrepare?.ok === true &&
    coderRemoteCommand?.ok === true &&
    coderBrowserUrls?.ok === true;
}

function platformCiArtifactStagingEvidenceSemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  const missing = stringArray(record?.missing);
  const forbiddenValueHitReports = stringArray(record?.forbiddenValueHitReports);
  return record?.schemaVersion === "platform-staging-evidence/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    missing !== undefined &&
    missing.length === 0 &&
    forbiddenValueHitReports !== undefined &&
    forbiddenValueHitReports.length === 0 &&
    gates?.doctorPreflightOk === true &&
    gates.modelGatewayReady === true &&
    gates.controlPlaneReady === true &&
    gates.coderReady === true &&
    gates.externalStagingReady === true &&
    gates.agentGitServiceStagingReady === true &&
    gates.agentGitServiceCompatOk === true &&
    gates.preServeEvidenceOk === true;
}

function platformCiArtifactStagingVerdictSemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  return record?.schemaVersion === "platform-staging-verdict/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    record.decision === "ready-for-serve" &&
    sha256String(record.evidenceSha256);
}

function platformCiArtifactServeReadySemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const missing = stringArray(record?.missing);
  return record?.schemaVersion === "platform-serve-ready/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    missing !== undefined &&
    missing.length === 0;
}

function platformCiArtifactCutoverReportSemanticsOk(value: unknown, stagingCi: Record<string, unknown> | undefined): boolean {
  const record = objectRecord(value);
  const requiresAgentGitService = platformCiArtifactCutoverRequiresAgentGitService(record) ||
    platformCiArtifactStagingCiReportCheckRequires(stagingCi, "cutover-report.json", [
      "agentGitService.checked",
      "agentGitService.ready",
    ]);
  return record?.ok === true &&
    platformCiArtifactCutoverAgentGitServiceOk(record, requiresAgentGitService) &&
    (requiresAgentGitService
      ? platformCiArtifactControlPlaneDiscoveryOk(record, "server") &&
        platformCiArtifactControlPlaneDiscoveryOk(record, "tenant")
      : platformCiArtifactOptionalControlPlaneDiscoveryOk(record, "server") &&
        platformCiArtifactOptionalControlPlaneDiscoveryOk(record, "tenant"));
}

function platformCiArtifactSmokeSemanticsOk(value: unknown, stagingCi: Record<string, unknown> | undefined): boolean {
  const record = objectRecord(value);
  const requiresAgentGitService = platformCiArtifactSmokeRequiresAgentGitService(record) ||
    platformCiArtifactStagingCiReportCheckRequires(stagingCi, "smoke.json", [
      "agentGitServiceCutoverChecked",
      "agentGitServiceCutoverWorkspaceTokenChecked",
      "agentGitServiceNativeProjectionChecked",
      "agent-git-service-native-projection",
    ]);
  return record?.ok === true &&
    record.status === "passed" &&
    record.multiAgentConcurrencyChecked === true &&
    platformCiArtifactSmokeAgentGitServiceOk(record, requiresAgentGitService) &&
    (requiresAgentGitService
      ? platformCiArtifactControlPlaneDiscoveryOk(record, "server") &&
        platformCiArtifactControlPlaneDiscoveryOk(record, "tenant")
      : platformCiArtifactOptionalControlPlaneDiscoveryOk(record, "server") &&
        platformCiArtifactOptionalControlPlaneDiscoveryOk(record, "tenant"));
}

function platformCiArtifactConcurrencyAuditSemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  return record?.schemaVersion === "platform-concurrency-audit/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    Array.isArray(record.missing) &&
    record.missing.length === 0 &&
    gates?.cutoverConcurrencyOk === true &&
    gates.smokeConcurrencyOk === true &&
    gates.runScopedWorkspaces === true &&
    gates.workspaceBranchLeaseOk === true &&
    gates.multiAgentSmokeOk === true &&
    gates.agentGitServiceCutoverOk === true &&
    gates.agentGitServiceNativeProjectionOk === true;
}

function platformCiArtifactOperatorArtifactsSemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  const requiredReports = stringArray(record?.requiredReports);
  const missingReports = stringArray(record?.missingReports);
  const forbiddenValueHitReports = stringArray(record?.forbiddenValueHitReports);
  const hashMismatchedReports = stringArray(record?.hashMismatchedReports);
  const stageAnchorMismatchedReports = stringArray(record?.stageAnchorMismatchedReports);
  const preServeEvidenceMissing = stringArray(record?.preServeEvidenceMissing);
  const postServeEvidenceMissing = stringArray(record?.postServeEvidenceMissing);
  const reports = Array.isArray(record?.reports) ? record.reports : undefined;
  return record?.schemaVersion === "platform-cutover-artifacts/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    requiredReports !== undefined &&
    requiredReports.length > 0 &&
    missingReports !== undefined &&
    missingReports.length === 0 &&
    forbiddenValueHitReports !== undefined &&
    forbiddenValueHitReports.length === 0 &&
    hashMismatchedReports !== undefined &&
    hashMismatchedReports.length === 0 &&
    stageAnchorMismatchedReports !== undefined &&
    stageAnchorMismatchedReports.length === 0 &&
    preServeEvidenceMissing !== undefined &&
    preServeEvidenceMissing.length === 0 &&
    postServeEvidenceMissing !== undefined &&
    postServeEvidenceMissing.length === 0 &&
    reports !== undefined &&
    requiredReports.every((name) => platformCiArtifactOperatorArtifactReportOk(reports, name)) &&
    gates?.postServeEvidenceOk === true &&
    (record.requireExternalStaging !== true || gates.externalStagingReady === true) &&
    (record.requireOperatorApprovals !== true || gates.operatorApprovalsOk === true);
}

function platformCiArtifactOperatorArtifactReportOk(reports: unknown[], name: string): boolean {
  return reports.some((value) => {
    const report = objectRecord(value);
    return report?.name === name &&
      report.exists === true &&
      report.ok === true &&
      sha256String(report.sha256);
  });
}

function platformCiArtifactOperatorApprovalsSemanticsOk(value: unknown, stagingCi: Record<string, unknown> | undefined): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  const missingReports = stringArray(record?.missingReports);
  const failedReports = stringArray(record?.failedReports);
  const missingGateReports = stringArray(record?.missingGateReports);
  const stageMismatchReports = stringArray(record?.stageMismatchReports);
  const missingRequirementReports = stringArray(record?.missingRequirementReports);
  const nextActions = stringArray(record?.nextActions);
  const approvals = Array.isArray(record?.approvals) ? record.approvals : undefined;
  const expectedApprovals = Array.isArray(stagingCi?.operatorApprovals) ? stagingCi.operatorApprovals : undefined;
  return record?.schemaVersion === "platform-operator-approvals/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    missingReports !== undefined &&
    missingReports.length === 0 &&
    failedReports !== undefined &&
    failedReports.length === 0 &&
    missingGateReports !== undefined &&
    missingGateReports.length === 0 &&
    stageMismatchReports !== undefined &&
    stageMismatchReports.length === 0 &&
    missingRequirementReports !== undefined &&
    missingRequirementReports.length === 0 &&
    nextActions !== undefined &&
    nextActions.length === 0 &&
    approvals !== undefined &&
    expectedApprovals !== undefined &&
    approvals.length === expectedApprovals.length &&
    approvals.every(platformCiArtifactOperatorApprovalOk) &&
    expectedApprovals.every((expected) => platformCiArtifactExpectedOperatorApprovalOk(expected, approvals)) &&
    gates?.stagingCiOk === true &&
    gates.allReportsPresent === true &&
    gates.allReportsOk === true &&
    gates.allGatesApproved === true &&
    gates.allStagesExecuted === true &&
    gates.allRequirementsSatisfied === true;
}

function platformCiArtifactExpectedOperatorApprovalOk(expected: unknown, approvals: unknown[]): boolean {
  const expectedApproval = objectRecord(expected);
  const expectedRequires = stringArray(expectedApproval?.requires) ?? [];
  return approvals.some((value) => {
    const approval = objectRecord(value);
    const requires = stringArray(approval?.requires);
    return typeof expectedApproval?.stageId === "string" &&
      typeof expectedApproval.gateId === "string" &&
      typeof expectedApproval.evidence === "string" &&
      typeof expectedApproval.report === "string" &&
      typeof expectedApproval.command === "string" &&
      requires !== undefined &&
      approval?.stageId === expectedApproval.stageId &&
      approval.gateId === expectedApproval.gateId &&
      approval.evidence === expectedApproval.evidence &&
      approval.report === expectedApproval.report &&
      approval.command === expectedApproval.command &&
      expectedRequires.length === requires.length &&
      expectedRequires.every((requirement) => requires.includes(requirement));
  });
}

function platformCiArtifactOperatorApprovalOk(value: unknown): boolean {
  const approval = objectRecord(value);
  const requires = stringArray(approval?.requires);
  const approvedGateIds = stringArray(approval?.approvedGateIds);
  const satisfiedRequirements = stringArray(approval?.satisfiedRequirements);
  const missingRequirements = stringArray(approval?.missingRequirements);
  return typeof approval?.stageId === "string" &&
    typeof approval.gateId === "string" &&
    typeof approval.evidence === "string" &&
    typeof approval.report === "string" &&
    typeof approval.command === "string" &&
    typeof approval.reportPath === "string" &&
    approval.exists === true &&
    approval.ok === true &&
    approval.selectedStageOk === true &&
    approval.executedStageOk === true &&
    approval.status === "approved" &&
    requires !== undefined &&
    approvedGateIds !== undefined &&
    approvedGateIds.includes(approval.gateId) &&
    satisfiedRequirements !== undefined &&
    missingRequirements !== undefined &&
    missingRequirements.length === 0 &&
    requires.every((requirement) => satisfiedRequirements.includes(requirement));
}

function platformCiArtifactStagingProofSemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  const requiredReports = stringArray(record?.requiredReports);
  const missing = stringArray(record?.missing);
  const missingReports = stringArray(record?.missingReports);
  const forbiddenValueHitReports = stringArray(record?.forbiddenValueHitReports);
  const reports = objectRecord(record?.reports);
  return record?.schemaVersion === "platform-staging-proof/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    requiredReports !== undefined &&
    requiredReports.length > 0 &&
    missing !== undefined &&
    missing.length === 0 &&
    missingReports !== undefined &&
    missingReports.length === 0 &&
    forbiddenValueHitReports !== undefined &&
    forbiddenValueHitReports.length === 0 &&
    reports !== undefined &&
    requiredReports.every((name) => platformCiArtifactStagingProofRequiredReportOk(reports, name)) &&
    gates?.operatorArtifactsOk === true &&
    gates.postServeEvidenceOk === true &&
    (record.requireExternalStaging !== true || gates.externalStagingReady === true) &&
    (record.requireOperatorApprovals !== true || gates.operatorApprovalsOk === true);
}

function platformCiArtifactStagingProofRequiredReportOk(reports: Record<string, unknown>, name: string): boolean {
  const direct = platformCiArtifactStagingProofDirectReportRef(reports, name);
  if (direct !== undefined) return platformCiArtifactReportRefOk(direct);
  const stagingCiExpectedReports = Array.isArray(reports.stagingCiExpectedReports) ? reports.stagingCiExpectedReports : [];
  if (stagingCiExpectedReports.some((value) => platformCiArtifactNamedReportRefOk(value, name))) return true;
  const operatorApprovalRuns = Array.isArray(reports.operatorApprovalRuns) ? reports.operatorApprovalRuns : [];
  if (operatorApprovalRuns.some((value) => platformCiArtifactNamedReportRefOk(value, name))) return true;
  return platformCiArtifactStagingProofAgentGitServiceCompatReportOk(reports, name);
}

function platformCiArtifactStagingProofDirectReportRef(reports: Record<string, unknown>, name: string): unknown {
  if (name === "staging-targets.json") return reports.stagingTargets;
  if (name === "staging-evidence.json") return reports.stagingEvidence;
  if (name === "staging-verdict.json") return reports.stagingVerdict;
  if (name === "staging-run.json") return reports.stagingRun;
  if (name === "external-staging-audit.json") return reports.externalStagingAudit;
  if (name === "serve-ready.json") return reports.serveReady;
  if (name === "operator-artifacts.json") return reports.operatorArtifacts;
  if (name === "operator-approvals.json") return reports.operatorApprovals;
  if (name === "platform-preflight.json") return reports.platformPreflight;
  return undefined;
}

function platformCiArtifactStagingProofAgentGitServiceCompatReportOk(reports: Record<string, unknown>, name: string): boolean {
  const compat = objectRecord(reports.agentGitServiceCompat);
  if (name === "agent-git-service-compat/manifest.json") return platformCiArtifactReportRefOk(compat?.manifest);
  if (name === "agent-git-service-compat/baseline.json") return platformCiArtifactReportRefOk(compat?.baseline);
  if (name === "agent-git-service-compat/candidate.json") return platformCiArtifactReportRefOk(compat?.candidate);
  if (name === "agent-git-service-compat/compare.json") return platformCiArtifactReportRefOk(compat?.comparison);
  return false;
}

function platformCiArtifactNamedReportRefOk(value: unknown, name: string): boolean {
  const record = objectRecord(value);
  return record?.name === name && platformCiArtifactReportRefOk(record);
}

function platformCiArtifactOperatorHandoffPacketSemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const status = objectRecord(record?.status);
  const statusGates = objectRecord(status?.gates);
  const cockpit = objectRecord(record?.cockpit);
  const handoff = objectRecord(record?.handoff);
  const githubActions = objectRecord(record?.githubActions);
  const evidence = objectRecord(record?.evidence);
  const statusMissing = stringArray(status?.missing);
  const handoffBlockingGroupIds = stringArray(handoff?.blockingGroupIds);
  return record?.schemaVersion === "platform-operator-handoff-packet/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    record.phase === "production-cutover-ready" &&
    status?.schemaVersion === "platform-operator-status/v1" &&
    status.ok === true &&
    status.phase === "production-cutover-ready" &&
    statusMissing !== undefined &&
    statusMissing.length === 0 &&
    statusGates?.productionCutoverReady === true &&
    statusGates.ciHandoffReady === true &&
    cockpit?.schemaVersion === "platform-operator-cockpit-next/v1" &&
    cockpit.tokenFree === true &&
    cockpit.phase === "production-cutover-ready" &&
    cockpit.state === "complete" &&
    cockpit.pendingStepCount === 0 &&
    cockpit.missingInputCount === 0 &&
    cockpit.commandRefCount === 0 &&
    handoff !== undefined &&
    handoffBlockingGroupIds !== undefined &&
    handoffBlockingGroupIds.length === 0 &&
    handoff.missingInputCount === 0 &&
    handoff.commandRefCount === 0 &&
    Array.isArray(handoff.inputRefs) &&
    handoff.inputRefs.length === 0 &&
    Array.isArray(handoff.commandRefs) &&
    handoff.commandRefs.length === 0 &&
    Array.isArray(handoff.nextActions) &&
    handoff.nextActions.length === 0 &&
    Array.isArray(record.blockingGroups) &&
    record.blockingGroups.length === 0 &&
    Array.isArray(githubActions?.workflowDispatchCommandArgs) &&
    objectRecord(evidence?.reports) !== undefined;
}

function platformCiArtifactOperatorCockpitNextSemanticsOk(value: unknown, phase: string): boolean {
  const record = objectRecord(value);
  const state = record?.state;
  const shapeOk = record?.schemaVersion === "platform-operator-cockpit-next/v1" &&
    record.tokenFree === true &&
    (state === "needs-input" || state === "ready-to-run" || state === "complete") &&
    typeof record.pendingStepCount === "number" &&
    typeof record.missingInputCount === "number" &&
    typeof record.commandRefCount === "number" &&
    platformCiArtifactCockpitCurrentRefOk(state, record) &&
    (state !== "needs-input" || Array.isArray(record.inputRefs)) &&
    (state !== "ready-to-run" || objectRecord(record.commandRef) !== undefined);
  if (!shapeOk) return false;
  if (phase !== "post-serve") return true;
  return state === "complete" &&
    record.phase === "production-cutover-ready" &&
    record.pendingStepCount === 0 &&
    record.missingInputCount === 0 &&
    record.commandRefCount === 0;
}

function platformCiArtifactOperatorCockpitPlanSemanticsOk(value: unknown, phase: string): boolean {
  const record = objectRecord(value);
  const execution = objectRecord(record?.execution);
  const state = execution?.state;
  const shapeOk = record?.schemaVersion === "platform-operator-cockpit-plan/v1" &&
    record.tokenFree === true &&
    Array.isArray(record.steps) &&
    execution !== undefined &&
    (state === "needs-input" || state === "ready-to-run" || state === "complete") &&
    typeof execution.pendingStepCount === "number" &&
    typeof execution.missingInputCount === "number" &&
    typeof execution.commandRefCount === "number" &&
    platformCiArtifactCockpitCurrentRefOk(state, execution) &&
    platformCiArtifactCockpitPlanCurrentStepOk(record.steps, execution) &&
    (state !== "needs-input" || Array.isArray(execution.nextInputRefs)) &&
    (state !== "ready-to-run" || objectRecord(execution.nextCommandRef) !== undefined);
  if (!shapeOk) return false;
  if (phase !== "post-serve") return true;
  return state === "complete" &&
    record.phase === "production-cutover-ready" &&
    execution.pendingStepCount === 0 &&
    execution.missingInputCount === 0 &&
    execution.commandRefCount === 0;
}

function platformCiArtifactCockpitCurrentRefOk(state: unknown, record: Record<string, unknown>): boolean {
  return state === "complete" || (
    typeof record.currentStepId === "string" &&
    typeof record.currentBlockingGroupId === "string"
  );
}

function platformCiArtifactCockpitPlanCurrentStepOk(steps: unknown, execution: Record<string, unknown>): boolean {
  if (execution.state === "complete") return true;
  return Array.isArray(steps) && steps.some((value) => {
    const step = objectRecord(value);
    return step !== undefined &&
      step.id === execution.currentStepId &&
      step.blockingGroupId === execution.currentBlockingGroupId;
  });
}

function platformCiArtifactGoalAuditSemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  const missing = stringArray(record?.missing);
  const reports = objectRecord(record?.reports);
  return record?.schemaVersion === "platform-goal-audit/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    record.requireExternalStaging === true &&
    record.requireOperatorApprovals === true &&
    missing !== undefined &&
    missing.length === 0 &&
    platformCiArtifactGoalAuditTargetOk(record.target) &&
    reports !== undefined &&
    platformCiArtifactGoalAuditReportsOk(reports, record.requireAgentGitService === true) &&
    gates?.localMvpOk === true &&
    gates.concurrencyAuditOk === true &&
    gates.ciRunProofOk === true &&
    gates.ciRunProofAnchorOk === true &&
    gates.ciRunProofStagingProofAnchorOk === true &&
    gates.ciRunProofHandoffOk === true &&
    gates.stagingPrerequisitesOk === true &&
    gates.stagingPrerequisitesProofAnchorOk === true &&
    gates.stagingRunOk === true &&
    gates.stagingRunProofAnchorOk === true &&
    gates.externalStagingAuditOk === true &&
    gates.externalStagingAuditProofAnchorOk === true &&
    gates.operatorArtifactsProofAnchorOk === true &&
    gates.operatorArtifactsPreServeReportsAnchorOk === true &&
    gates.operatorArtifactsCoreReportsAnchorOk === true &&
    gates.operatorArtifactsStrictModeOk === true &&
    gates.operatorApprovalsProofAnchorOk === true &&
    gates.operatorCockpitRunnerExecuteOk === true &&
    gates.operatorCockpitRunnerProofAnchorOk === true &&
    (record.requireAgentGitService !== true || (
      gates.agentGitServiceProviderOk === true &&
      gates.agentGitServiceUpstreamOk === true
    )) &&
    gates.productionCutoverReady === true;
}

function platformCiArtifactGoalAuditTargetOk(value: unknown): boolean {
  const target = objectRecord(value);
  const requiredEvidence = stringArray(target?.requiredEvidence);
  return target?.name === "multi-user-online-sandbox-harness-loop" &&
    target.mvpIsScopeReduction === false &&
    requiredEvidence !== undefined &&
    [
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
    ].every((name) => requiredEvidence.includes(name));
}

function platformCiArtifactGoalAuditReportsOk(reports: Record<string, unknown>, requireAgentGitService: boolean): boolean {
  return [
    platformCiArtifactGoalAuditReportRefOk(reports.cutoverReport, "cutover-report.json"),
    platformCiArtifactGoalAuditReportRefOk(reports.smoke, "smoke.json"),
    platformCiArtifactGoalAuditReportRefOk(reports.concurrencyAudit, "concurrency-audit.json", "platform-concurrency-audit/v1"),
    platformCiArtifactGoalAuditReportRefOk(reports.ciRunProof, "ci-run-proof.json", "platform-ci-run-proof/v1"),
    platformCiArtifactGoalAuditReportRefOk(reports.stagingPrerequisites, "staging-prerequisites.json", "platform-staging-prerequisites/v1"),
    platformCiArtifactGoalAuditReportRefOk(reports.stagingRun, "staging-run.json", "platform-staging-run/v1"),
    platformCiArtifactGoalAuditReportRefOk(reports.externalStagingAudit, "external-staging-audit.json", "platform-external-staging-audit/v1"),
    platformCiArtifactGoalAuditReportRefOk(reports.operatorApprovals, "operator-approvals.json", "platform-operator-approvals/v1"),
    platformCiArtifactGoalAuditReportRefOk(reports.operatorCockpitRunnerExecute, "operator-cockpit-runner-execute.json", "platform-operator-cockpit-runner/v1"),
    platformCiArtifactGoalAuditReportRefOk(reports.operatorArtifacts, "operator-artifacts.json", "platform-cutover-artifacts/v1"),
    platformCiArtifactGoalAuditReportRefOk(reports.stagingProof, "staging-proof.json", "platform-staging-proof/v1"),
    !requireAgentGitService ||
      platformCiArtifactGoalAuditReportRefOk(reports.upstreamAgentGitServiceServerEnvPlan, "upstream-agent-git-service-server-env-plan.json", "upstream-agent-git-service-server-env-plan/v1"),
    !requireAgentGitService ||
      platformCiArtifactGoalAuditReportRefOk(reports.upstreamAgentGitServiceHandoff, "upstream-agent-git-service-handoff.json", "upstream-agent-git-service-handoff/v1"),
    !requireAgentGitService ||
      platformCiArtifactGoalAuditReportRefOk(reports.agentGitServiceStagingReadiness, "agent-git-service-staging-readiness.json", "agent-git-service-staging-readiness/v1"),
    !requireAgentGitService ||
      platformCiArtifactGoalAuditReportRefOk(reports.agentGitServiceCompatManifest, "agent-git-service-compat/manifest.json", "agent-git-service-compat-rehearsal/v1", false),
    !requireAgentGitService ||
      platformCiArtifactGoalAuditReportRefOk(reports.agentGitServiceCompatBaseline, "agent-git-service-compat/baseline.json", "agent-git-service-contract-probe/v1"),
    !requireAgentGitService ||
      platformCiArtifactGoalAuditReportRefOk(reports.agentGitServiceCompatCandidate, "agent-git-service-compat/candidate.json", "agent-git-service-contract-probe/v1"),
    !requireAgentGitService ||
      platformCiArtifactGoalAuditReportRefOk(reports.agentGitServiceCompatComparison, "agent-git-service-compat/compare.json", "agent-git-service-contract-comparison/v1"),
  ].every(Boolean);
}

function platformCiArtifactGoalAuditReportRefOk(value: unknown, name: string, schemaVersion?: string, requireOk = true): boolean {
  const report = objectRecord(value);
  return report?.name === name &&
    typeof report.path === "string" &&
    report.exists === true &&
    (!requireOk || report.ok === true) &&
    (schemaVersion === undefined || report.schemaVersion === schemaVersion);
}

function platformCiArtifactCutoverAgentGitServiceOk(record: Record<string, unknown> | undefined, requiresAgentGitService = platformCiArtifactCutoverRequiresAgentGitService(record)): boolean {
  if (!record) return false;
  if (!requiresAgentGitService) return true;
  const agentGitService = objectRecord(record.agentGitService);
  return agentGitService?.checked === true && agentGitService.ready === true;
}

function platformCiArtifactSmokeAgentGitServiceOk(record: Record<string, unknown> | undefined, requiresAgentGitService = platformCiArtifactSmokeRequiresAgentGitService(record)): boolean {
  if (!record) return false;
  if (!requiresAgentGitService) return true;
  const capabilities = stringArray(record.onlineSandboxGoldenPathCapabilities);
  return record.agentGitServiceCutoverChecked === true &&
    record.agentGitServiceCutoverWorkspaceTokenChecked === true &&
    record.agentGitServiceNativeProjectionChecked === true &&
    capabilities !== undefined &&
    capabilities.includes(AGENT_GIT_SERVICE_NATIVE_PROJECTION_CAPABILITY) &&
    (!("agentGitServiceCutoverReceiptSecretAbsent" in record) || record.agentGitServiceCutoverReceiptSecretAbsent === true);
}

function platformCiArtifactCutoverRequiresAgentGitService(record: Record<string, unknown> | undefined): boolean {
  return record?.controlPlaneProvider === "agent-git-service" || Boolean(record && "agentGitService" in record);
}

function platformCiArtifactSmokeRequiresAgentGitService(record: Record<string, unknown> | undefined): boolean {
  return record?.serverControlPlaneProvider === "agent-git-service" ||
    record?.tenantControlPlaneProvider === "agent-git-service" ||
    record?.controlPlaneWorkspaceBranchLeaseProvider === "agent-git-service" ||
    Boolean(record && (
      "agentGitServiceCutoverChecked" in record ||
      "agentGitServiceCutoverWorkspaceTokenChecked" in record ||
      "agentGitServiceNativeProjectionChecked" in record ||
      "agentGitServiceCutoverReceiptSecretAbsent" in record
    ));
}

function platformCiArtifactStagingCiReportCheckRequires(
  stagingCi: Record<string, unknown> | undefined,
  reportName: string,
  markers: string[],
): boolean {
  const checks = objectRecord(stagingCi?.checks);
  const allChecks = [
    ...(stringArray(checks?.preServe) ?? []),
    ...(stringArray(checks?.postServe) ?? []),
  ];
  return allChecks.some((check) =>
    check.includes(reportName) && markers.some((marker) => check.includes(marker))
  );
}

function platformCiArtifactControlPlaneDiscoveryOk(record: Record<string, unknown> | undefined, prefix: "server" | "tenant"): boolean {
  if (!record) return false;
  const okKey = `${prefix}ControlPlaneDiscoveryOk`;
  const tokenModeKey = `${prefix}ControlPlaneDiscoveryTokenMode`;
  const missingTenantsKey = `${prefix}ControlPlaneDiscoveryMissingTenants`;
  return record[okKey] === true &&
    platformCiArtifactControlPlaneDiscoveryTokenModeOk(record[tokenModeKey]) &&
    Array.isArray(record[missingTenantsKey]) &&
    record[missingTenantsKey].length === 0;
}

function platformCiArtifactOptionalControlPlaneDiscoveryOk(record: Record<string, unknown> | undefined, prefix: "server" | "tenant"): boolean {
  if (!record) return false;
  const okKey = `${prefix}ControlPlaneDiscoveryOk`;
  const tokenModeKey = `${prefix}ControlPlaneDiscoveryTokenMode`;
  const missingTenantsKey = `${prefix}ControlPlaneDiscoveryMissingTenants`;
  const hasDiscovery = okKey in record || tokenModeKey in record || missingTenantsKey in record;
  if (!hasDiscovery) return true;
  return platformCiArtifactControlPlaneDiscoveryOk(record, prefix);
}

function platformCiArtifactControlPlaneDiscoveryTokenModeOk(value: unknown): boolean {
  return value === "admin" || value === "tenant-scoped";
}

function platformCiArtifactAgentGitServiceStagingReadinessSemanticsOk(value: unknown, stagingCi: Record<string, unknown> | undefined): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  const serverReadiness = objectRecord(record?.serverReadiness);
  const wikiMemory = objectRecord(record?.wikiMemory);
  const missing = stringArray(record?.missing);
  const target = platformCiArtifactAgentGitServiceStagingTarget(stagingCi);
  return record?.schemaVersion === "agent-git-service-staging-readiness/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    record.provider === "agent-git-service" &&
    missing !== undefined &&
    missing.length === 0 &&
    gates?.token === true &&
    gates.serverReadiness === true &&
    gates.discovery === true &&
    gates.issueWorkspaces === true &&
    gates.issueComments === true &&
    gates.wikiMemory === true &&
    serverReadiness?.ok === true &&
    serverReadiness.status === "ready" &&
    platformCiArtifactAgentGitServiceStagingReadinessTargetOk(record, wikiMemory, target);
}

function platformCiArtifactAgentGitServiceStagingReadinessTargetOk(
  record: Record<string, unknown>,
  wikiMemory: Record<string, unknown> | undefined,
  target: {
    baseUrl?: string;
    issue: string;
    repo: string;
    wikiPage: string;
  } | undefined,
): boolean {
  if (!target) return true;
  const reportBaseUrl = stringValue(record.baseUrl);
  return (
    (!target.baseUrl || (reportBaseUrl !== undefined && platformCiArtifactSameAgentGitServiceBaseUrl(reportBaseUrl, target.baseUrl))) &&
    record.issue === target.issue &&
    record.repo === target.repo &&
    wikiMemory?.page === target.wikiPage
  );
}

function platformCiArtifactAgentGitServiceStagingTarget(stagingCi: Record<string, unknown> | undefined): {
  baseUrl?: string;
  issue: string;
  repo: string;
  wikiPage: string;
} | undefined {
  const externalTargets = objectRecord(stagingCi?.externalTargets);
  const controlPlane = objectRecord(externalTargets?.controlPlane);
  const agentGitServiceStaging = objectRecord(externalTargets?.agentGitServiceStaging);
  const issue = stringValue(agentGitServiceStaging?.issue);
  const repo = stringValue(agentGitServiceStaging?.repo);
  const wikiPage = stringValue(agentGitServiceStaging?.wikiPage);
  if (!issue || !repo || !wikiPage) return undefined;
  return {
    ...(stringValue(controlPlane?.baseUrl) ? { baseUrl: stringValue(controlPlane?.baseUrl) } : {}),
    issue,
    repo,
    wikiPage,
  };
}

function platformCiArtifactUpstreamAgentGitServiceServerEnvPlanSemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  const missing = stringArray(record?.missing);
  return record?.schemaVersion === "upstream-agent-git-service-server-env-plan/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    record.provider === "agent-git-service" &&
    missing !== undefined &&
    missing.length === 0 &&
    gates?.guideOk === true &&
    gates.requiredServerEnvNamesPresent === true &&
    gates.serverStartCommandReady === true &&
    gates.readinessProbeReady === true;
}

function platformCiArtifactUpstreamAgentGitServiceHandoffSemanticsOk(value: unknown): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  const missing = stringArray(record?.missing);
  return record?.schemaVersion === "upstream-agent-git-service-handoff/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    missing !== undefined &&
    missing.length === 0 &&
    gates?.guideOk === true &&
    gates.requiredServerEnvOk === true &&
    gates.requiredLoomEnvOk === true &&
    gates.operatorChecklistOk === true;
}

function platformCiArtifactAgentGitServiceCompatManifestSemanticsOk(value: unknown, stagingCi: Record<string, unknown> | undefined): boolean {
  const record = objectRecord(value);
  const artifacts = objectRecord(record?.artifacts);
  const artifactSha256 = objectRecord(record?.artifactSha256);
  const targetBaseUrl = platformCiArtifactAgentGitServiceControlPlaneBaseUrl(stagingCi);
  const candidateBaseUrl = stringValue(record?.candidateBaseUrl);
  return record?.schemaVersion === "agent-git-service-compat-rehearsal/v1" &&
    record.tokenFree === true &&
    record.comparisonOk === true &&
    stringValue(record.candidateMode) !== undefined &&
    stringValue(record.baselineBaseUrl) !== undefined &&
    candidateBaseUrl !== undefined &&
    (targetBaseUrl === undefined || platformCiArtifactSameAgentGitServiceBaseUrl(candidateBaseUrl, targetBaseUrl)) &&
    stringValue(artifacts?.baseline) !== undefined &&
    stringValue(artifacts?.candidate) !== undefined &&
    stringValue(artifacts?.comparison) !== undefined &&
    sha256String(artifactSha256?.baseline) &&
    sha256String(artifactSha256?.candidate) &&
    sha256String(artifactSha256?.comparison);
}

function platformCiArtifactAgentGitServiceControlPlaneBaseUrl(stagingCi: Record<string, unknown> | undefined): string | undefined {
  const externalTargets = objectRecord(stagingCi?.externalTargets);
  const controlPlane = objectRecord(externalTargets?.controlPlane);
  return stringValue(controlPlane?.baseUrl);
}

function platformCiArtifactAgentGitServiceCompatProbeSemanticsOk(name: string, value: unknown, stagingCi: Record<string, unknown> | undefined): boolean {
  const record = objectRecord(value);
  const targetBaseUrl = name === "agent-git-service-compat/candidate.json"
    ? platformCiArtifactAgentGitServiceControlPlaneBaseUrl(stagingCi)
    : undefined;
  const baseUrl = stringValue(record?.baseUrl);
  return record?.schemaVersion === "agent-git-service-contract-probe/v1" &&
    record.ok === true &&
    record.requestsTokenFree === true &&
    record.provider === "agent-git-service" &&
    record.apiBasePath === "/api/v3" &&
    record.readOnly === true &&
    record.authorizationScheme === "Bearer" &&
    (targetBaseUrl === undefined || (baseUrl !== undefined && platformCiArtifactSameAgentGitServiceBaseUrl(baseUrl, targetBaseUrl)));
}

function platformCiArtifactAgentGitServiceCompatComparisonSemanticsOk(value: unknown, stagingCi: Record<string, unknown> | undefined): boolean {
  const record = objectRecord(value);
  const targetBaseUrl = platformCiArtifactAgentGitServiceControlPlaneBaseUrl(stagingCi);
  const candidate = objectRecord(record?.candidate);
  const candidateBaseUrl = stringValue(candidate?.baseUrl);
  return record?.schemaVersion === "agent-git-service-contract-comparison/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    (targetBaseUrl === undefined || (candidateBaseUrl !== undefined && platformCiArtifactSameAgentGitServiceBaseUrl(candidateBaseUrl, targetBaseUrl)));
}

function platformCiArtifactAgentGitServiceNativeWriteSemanticsOk(value: unknown, stagingCi: Record<string, unknown> | undefined): boolean {
  const record = objectRecord(value);
  const gates = objectRecord(record?.gates);
  const missing = stringArray(record?.missing);
  const workspaceAttachment = objectRecord(record?.workspaceAttachment);
  const wikiMemory = objectRecord(record?.wikiMemory);
  const target = platformCiArtifactAgentGitServiceNativeWriteTarget(stagingCi);
  return record?.schemaVersion === "agent-git-service-native-write-check/v1" &&
    record.ok === true &&
    record.tokenFree === true &&
    record.provider === "agent-git-service" &&
    record.approved === true &&
    missing !== undefined &&
    missing.length === 0 &&
    gates?.token === true &&
    gates.approved === true &&
    gates.issueComment === true &&
    gates.workspaceAttachment === true &&
    gates.wikiMemory === true &&
    platformCiArtifactAgentGitServiceNativeWriteTargetOk(record, workspaceAttachment, wikiMemory, target);
}

function platformCiArtifactAgentGitServiceNativeWriteTargetOk(
  record: Record<string, unknown>,
  workspaceAttachment: Record<string, unknown> | undefined,
  wikiMemory: Record<string, unknown> | undefined,
  target: {
    baseUrl?: string;
    issue: string;
    repo: string;
    wikiPage: string;
    nativeWriteWorkspaceId?: string;
    nativeWriteAttachmentUrl?: string;
    nativeWriteWikiNoteSha256?: string;
  } | undefined,
): boolean {
  if (!target) return true;
  const reportBaseUrl = stringValue(record.baseUrl);
  return (
    (!target.baseUrl || (reportBaseUrl !== undefined && platformCiArtifactSameAgentGitServiceBaseUrl(reportBaseUrl, target.baseUrl))) &&
    record.issue === target.issue &&
    record.repo === target.repo &&
    record.wikiPage === target.wikiPage &&
    wikiMemory?.page === target.wikiPage &&
    (!target.nativeWriteWorkspaceId || workspaceAttachment?.workspaceId === target.nativeWriteWorkspaceId) &&
    (!target.nativeWriteAttachmentUrl || record.attachmentUrl === target.nativeWriteAttachmentUrl) &&
    (!target.nativeWriteWikiNoteSha256 || wikiMemory?.noteSha256 === target.nativeWriteWikiNoteSha256)
  );
}

function platformCiArtifactAgentGitServiceNativeWriteTarget(stagingCi: Record<string, unknown> | undefined): {
  baseUrl?: string;
  issue: string;
  repo: string;
  wikiPage: string;
  nativeWriteWorkspaceId?: string;
  nativeWriteAttachmentUrl?: string;
  nativeWriteWikiNoteSha256?: string;
} | undefined {
  const externalTargets = objectRecord(stagingCi?.externalTargets);
  const controlPlane = objectRecord(externalTargets?.controlPlane);
  const agentGitServiceStaging = objectRecord(externalTargets?.agentGitServiceStaging);
  const issue = stringValue(agentGitServiceStaging?.issue);
  const repo = stringValue(agentGitServiceStaging?.repo);
  const wikiPage = stringValue(agentGitServiceStaging?.wikiPage);
  if (!issue || !repo || !wikiPage) return undefined;
  const nativeWriteWikiNote = stringValue(agentGitServiceStaging?.nativeWriteWikiNote);
  const nativeWriteWikiNoteSha256 = stringValue(agentGitServiceStaging?.nativeWriteWikiNoteSha256) ??
    (nativeWriteWikiNote ? sha256Hex(nativeWriteWikiNote) : undefined);
  return {
    ...(stringValue(controlPlane?.baseUrl) ? { baseUrl: stringValue(controlPlane?.baseUrl) } : {}),
    issue,
    repo,
    wikiPage,
    ...(stringValue(agentGitServiceStaging?.nativeWriteWorkspaceId)
      ? { nativeWriteWorkspaceId: stringValue(agentGitServiceStaging?.nativeWriteWorkspaceId) }
      : {}),
    ...(stringValue(agentGitServiceStaging?.nativeWriteAttachmentUrl)
      ? { nativeWriteAttachmentUrl: stringValue(agentGitServiceStaging?.nativeWriteAttachmentUrl) }
      : {}),
    ...(nativeWriteWikiNoteSha256 ? { nativeWriteWikiNoteSha256 } : {}),
  };
}

function platformCiArtifactSameAgentGitServiceBaseUrl(left: string, right: string): boolean {
  return platformCiArtifactNormalizeAgentGitServiceBaseUrl(left) ===
    platformCiArtifactNormalizeAgentGitServiceBaseUrl(right);
}

function platformCiArtifactNormalizeAgentGitServiceBaseUrl(value: string): string {
  return value.replace(/\/+$/, "").replace(/\/api\/v3$/, "");
}

function platformCiArtifactCutoverRunReportName(name: string): boolean {
  return name === "safe-run.json" ||
    (/^[A-Za-z0-9_.-]+-run\.json$/.test(name) &&
      name !== "staging-run.json" &&
      name !== "ci-handoff-run.json");
}

function platformCiArtifactCutoverEnvReportName(name: string): boolean {
  return /^[A-Za-z0-9_.-]+-env\.json$/.test(name);
}

function platformCiArtifactCutoverEnvSemanticsOk(name: string, value: unknown): boolean {
  const record = objectRecord(value);
  const checkedStageIds = stringArray(record?.checkedStageIds);
  const checkedVariableNames = stringArray(record?.checkedVariableNames);
  const present = Array.isArray(record?.present) ? record.present : undefined;
  const missing = Array.isArray(record?.missing) ? record.missing : undefined;
  const expectedStageId = platformCiArtifactCutoverEnvExpectedStageId(name);
  return record?.ok === true &&
    record.tokenFree === true &&
    checkedStageIds !== undefined &&
    checkedVariableNames !== undefined &&
    present !== undefined &&
    missing !== undefined &&
    missing.length === 0 &&
    checkedStageIds.includes(expectedStageId);
}

function platformCiArtifactCutoverEnvExpectedStageId(name: string): string {
  const suffix = "-env.json";
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

function platformCiArtifactCutoverRunSemanticsOk(name: string, value: unknown): boolean {
  const record = objectRecord(value);
  const selectedStageIds = stringArray(record?.selectedStageIds);
  const approvedGateIds = stringArray(record?.approvedGateIds);
  const satisfiedRequirements = stringArray(record?.satisfiedRequirements);
  const executed = Array.isArray(record?.executed) ? record.executed : undefined;
  const skipped = Array.isArray(record?.skipped) ? record.skipped : undefined;
  const failed = Array.isArray(record?.failed) ? record.failed : undefined;
  const expectedStageId = platformCiArtifactCutoverRunExpectedStageId(name);
  return record?.ok === true &&
    selectedStageIds !== undefined &&
    selectedStageIds.length > 0 &&
    approvedGateIds !== undefined &&
    satisfiedRequirements !== undefined &&
    executed !== undefined &&
    executed.length > 0 &&
    skipped !== undefined &&
    failed !== undefined &&
    failed.length === 0 &&
    skipped.every(platformCiArtifactCutoverRunSkippedStageOk) &&
    platformCiArtifactCutoverRunEnvironmentOk(record.environment) &&
    (expectedStageId === undefined
      ? selectedStageIds.every((stageId) => platformCiArtifactCutoverRunExecutedStageOk(executed, stageId))
      : selectedStageIds.includes(expectedStageId) && platformCiArtifactCutoverRunExecutedStageOk(executed, expectedStageId));
}

function platformCiArtifactCutoverRunExpectedStageId(name: string): string | undefined {
  if (name === "safe-run.json") return undefined;
  const suffix = "-run.json";
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : undefined;
}

function platformCiArtifactCutoverRunExecutedStageOk(executed: unknown[], stageId: string): boolean {
  return executed.some((entry) => {
    const stage = objectRecord(entry);
    return stage?.id === stageId &&
      stage.ok === true &&
      stage.exitCode === 0;
  });
}

function platformCiArtifactCutoverRunSkippedStageOk(value: unknown): boolean {
  const stage = objectRecord(value);
  return stage?.blocking !== true;
}

function platformCiArtifactCutoverRunEnvironmentOk(value: unknown): boolean {
  if (value === undefined) return true;
  const environment = objectRecord(value);
  return environment?.ok === true &&
    environment.tokenFree === true &&
    Array.isArray(environment.missing) &&
    environment.missing.length === 0;
}

async function readArtifactSyncRunId(path: string, phase: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const text = await readFile(path, "utf8");
    const value = JSON.parse(text) as unknown;
    const record = objectRecord(value);
    if (
      record?.schemaVersion !== "platform-ci-artifact-sync/v1" ||
      record.ok !== true ||
      record.tokenFree !== true ||
      record.provider !== "github-actions" ||
      record.phase !== phase
    ) {
      return undefined;
    }
    return stringValue(record.runId);
  } catch {
    return undefined;
  }
}

async function readStagingCi(path: string): Promise<{
  path: string;
  exists: boolean;
  ok: boolean;
  schemaVersion?: string;
  sha256?: string;
  value?: Record<string, unknown>;
}> {
  if (!existsSync(path)) return { path, exists: false, ok: false };
  try {
    const text = await readFile(path, "utf8");
    const value = JSON.parse(text) as unknown;
    const record = objectRecord(value);
    const expectedReports = objectRecord(record?.expectedReports);
    const ok = record?.schemaVersion === "platform-staging-ci/v1" &&
      record.tokenFree === true &&
      Array.isArray(expectedReports?.preServe) &&
      Array.isArray(expectedReports.postServe);
    return {
      path,
      exists: true,
      ok,
      schemaVersion: stringValue(record?.schemaVersion),
      sha256: sha256Hex(text),
      ...(record ? { value: record } : {}),
    };
  } catch {
    return { path, exists: true, ok: false };
  }
}

function phaseExpectedReports(value: Record<string, unknown>, phase: string): string[] {
  const expectedReports = objectRecord(value.expectedReports);
  const preServe = stringsOnly(expectedReports?.preServe);
  const postServe = stringsOnly(expectedReports?.postServe);
  if (phase === "pre-serve") return unique(preServe);
  if (phase === "post-serve") return unique(postServe);
  if (phase === "all") return unique([...preServe, ...postServe]);
  return [];
}

function resolveSourceReportDir(artifactDir: string): string {
  const nestedReports = join(artifactDir, "reports");
  return existsSync(nestedReports) ? nestedReports : artifactDir;
}

function isPlatformCiArtifactImportPhase(value: string): value is PlatformCiArtifactImportPhase {
  return value === "pre-serve" || value === "post-serve" || value === "all";
}

function isSafeReportRelativeName(value: string): boolean {
  return !value.startsWith("/") &&
    value.split("/").every((segment) => /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== "." && segment !== "..");
}

function stringsOnly(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = stringsOnly(value);
  return values.length === value.length ? values : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function platformCiArtifactReportRefListOk(value: unknown): boolean {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every(platformCiArtifactReportRefOk);
}

function platformCiArtifactReportRefOk(value: unknown): boolean {
  const record = objectRecord(value);
  return record?.ok === true && sha256String(record.sha256);
}

function platformCiArtifactNonNegativeNumber(...values: unknown[]): boolean {
  return values.some((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function platformCiArtifactNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function platformCiArtifactHttpUrlString(value: unknown): boolean {
  return typeof value === "string" && /^https?:\/\/\S+/.test(value);
}

function platformCiArtifactIssueRefString(value: unknown): boolean {
  return typeof value === "string" && /^[^/\s]+\/[^#\s]+#[0-9]+$/.test(value);
}

function platformCiArtifactRepoRefString(value: unknown): boolean {
  return typeof value === "string" && /^[^/\s]+\/[^/\s]+$/.test(value);
}

function sha256String(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
