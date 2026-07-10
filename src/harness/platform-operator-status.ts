import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createPlatformGoalAudit, type PlatformGoalAuditCliOptions, type PlatformGoalAuditResult } from "./platform-goal-audit.js";

const PLATFORM_OPERATOR_STATUS_GITHUB_ACTIONS_CONCURRENCY_GROUP = "loom-strict-staging-${{ github.ref }}-${{ inputs.phase }}";
const PLATFORM_OPERATOR_STATUS_DEFAULT_BUNDLE_DIR = "cutover-bundle";
const PLATFORM_OPERATOR_STATUS_GITHUB_ACTIONS_INSTALL_DIR = ".github/workflows";

export interface PlatformOperatorStatusCliOptions extends PlatformGoalAuditCliOptions {
  repoRoot?: string;
  repo?: string;
  ref?: string;
}

export interface PlatformOperatorStatusResult {
  schemaVersion: "platform-operator-status/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  reportDir: string;
  reportPath?: string;
  requireExternalStaging: boolean;
  requireOperatorApprovals: boolean;
  requireAgentGitService: boolean;
  phase: "prepare-pre-serve" | "ready-for-serve" | "run-post-serve-proof" | "production-cutover-ready";
  gates: {
    ciHandoffReady: boolean;
    preServeReady: boolean;
    readyForServe: boolean;
    serveReachable: boolean;
    postServeProofReady: boolean;
    productionCutoverReady: boolean;
  };
  commands: {
    preServe?: string;
    manualServe?: string;
    postServe?: string;
    all?: string;
  };
  ciHandoff: PlatformOperatorStatusCiHandoff;
  reports: Record<string, PlatformOperatorStatusReportRef>;
  goalAudit: {
    ok: boolean;
    gates: PlatformGoalAuditResult["gates"];
    missing: string[];
    nextActions: string[];
  };
  agentGitService: PlatformOperatorStatusAgentGitServiceSummary;
  cockpitPlan: PlatformOperatorStatusCockpitPlan;
  blockingGroups: PlatformOperatorStatusBlockingGroup[];
  missing: string[];
  nextCommand?: string;
  nextActions: string[];
}

export interface PlatformOperatorStatusAgentGitServiceSummary {
  provider: "agent-git-service";
  required: boolean;
  ok: boolean;
  tokenFree: true;
  reports: {
    serverEnvPlan: PlatformOperatorStatusReportRef;
    upstreamHandoff: PlatformOperatorStatusReportRef;
    stagingReadiness: PlatformOperatorStatusReportRef;
    nativeWriteCheck: PlatformOperatorStatusReportRef;
    compat: {
      manifest: PlatformOperatorStatusReportRef;
      baseline: PlatformOperatorStatusReportRef;
      candidate: PlatformOperatorStatusReportRef;
      comparison: PlatformOperatorStatusReportRef;
    };
  };
  gates: {
    serverEnvPlanOk: boolean;
    upstreamHandoffOk: boolean;
    stagingReadinessOk: boolean;
    nativeWriteCheckOk: boolean;
    compatOk: boolean;
  };
  nativeWriteCheckRequired: boolean;
  missing: string[];
  nextActions: string[];
}

export interface PlatformOperatorStatusBlockingGroup {
  id: string;
  ok: boolean;
  missing: string[];
  nextActions: string[];
  commandRefs?: PlatformOperatorStatusCommandRef[];
  envRefs?: PlatformOperatorStatusEnvRef[];
  secretRefs?: PlatformOperatorStatusSecretRef[];
  githubTargetRefs?: PlatformOperatorStatusGithubTargetRef[];
  serverEnvRefs?: PlatformOperatorStatusServerEnvRef[];
  targetEnvRefs?: PlatformOperatorStatusTargetEnvRef[];
  targetInputRefs?: PlatformOperatorStatusTargetInputRef[];
}

export interface PlatformOperatorStatusCommandRef {
  label: string;
  command: string;
  commandArgs: string[];
  cwd?: string;
}

export interface PlatformOperatorStatusEnvRef {
  name: string;
  required: true;
  present: false;
  requiredFor: string[];
  uses: PlatformOperatorStatusEnvUseRef[];
  envCheckShellCommand?: string;
}

export interface PlatformOperatorStatusEnvUseRef {
  sourceFlag?: string;
  purpose?: string;
  tenant?: string;
  actor?: string;
  role?: string;
}

export interface PlatformOperatorStatusSecretRef {
  name: string;
  provider: "github-actions";
  required: true;
  present: boolean;
  envCheckShellCommand?: string;
  setCommandArgs?: string[];
}

export interface PlatformOperatorStatusGithubTargetRef {
  name: "repo" | "ref";
  target: "github.repository" | "github.ref";
  required: true;
  present: boolean;
  discoveryField?: string;
  inputHint: string;
  inputTemplatePath?: string;
  inputTemplate?: {
    schemaVersion?: string;
    repo?: string;
    ref?: string;
  };
}

export interface PlatformOperatorStatusServerEnvRef {
  name: string;
  provider: "agent-git-service";
  required: true;
  present: boolean;
  envCheckShellCommand?: string;
}

export interface PlatformOperatorStatusTargetEnvRef {
  name: string;
  target: string;
  required: true;
  present: boolean;
  placeholderTarget?: string;
  envCheckShellCommand?: string;
}

export interface PlatformOperatorStatusTargetInputRef {
  name: string;
  target: "external-staging-targets";
  required: true;
  present: boolean;
  inputTemplatePath: string;
  inputTemplate?: Record<string, unknown>;
  inputFile?: PlatformOperatorStatusTargetInputFileSummary;
  applyInputCommandArgs?: string[];
}

export interface PlatformOperatorStatusTargetInputFileSummary {
  exists: boolean;
  ok: boolean;
  sha256?: string;
  gates: {
    schemaVersionOk: boolean;
    requiredFieldsPresent: boolean;
    formatsOk: boolean;
    placeholdersAbsent: boolean;
  };
  missing: string[];
}

export interface PlatformOperatorStatusCockpitPlan {
  schemaVersion: "platform-operator-cockpit-plan/v1";
  tokenFree: true;
  phase: PlatformOperatorStatusResult["phase"];
  execution: PlatformOperatorStatusCockpitExecution;
  steps: PlatformOperatorStatusCockpitStep[];
}

export interface PlatformOperatorStatusCockpitExecution {
  state: "needs-input" | "ready-to-run" | "complete";
  pendingStepCount: number;
  missingInputCount: number;
  commandRefCount: number;
  currentStepId?: PlatformOperatorStatusCockpitStep["id"];
  currentBlockingGroupId?: string;
  currentStepMissingInputCount?: number;
  nextInputRefs?: PlatformOperatorStatusCockpitInputRef[];
  nextCommandRef?: PlatformOperatorStatusCommandRef;
}

export interface PlatformOperatorCockpitNextResult {
  schemaVersion: "platform-operator-cockpit-next/v1";
  tokenFree: true;
  phase: PlatformOperatorStatusResult["phase"];
  state: PlatformOperatorStatusCockpitExecution["state"];
  pendingStepCount: number;
  missingInputCount: number;
  commandRefCount: number;
  currentStepId?: PlatformOperatorStatusCockpitStep["id"];
  currentBlockingGroupId?: string;
  currentStepMissingInputCount?: number;
  inputRefs?: PlatformOperatorStatusCockpitInputRef[];
  commandRef?: PlatformOperatorStatusCommandRef;
}

export interface PlatformOperatorStatusCockpitStep {
  id: "real-staging-targets" | "upstream-agent-git-service" | "operator-env" | "github-actions" | "pre-serve-evidence" | "post-serve-proof";
  blockingGroupId: string;
  inputRefs?: PlatformOperatorStatusCockpitInputRef[];
  commandRefs?: PlatformOperatorStatusCommandRef[];
}

export type PlatformOperatorStatusCockpitInputRef =
  | ({ kind: "target-env" } & PlatformOperatorStatusTargetEnvRef)
  | ({ kind: "target-input-file" } & PlatformOperatorStatusTargetInputRef)
  | ({ kind: "server-env" } & PlatformOperatorStatusServerEnvRef)
  | ({ kind: "operator-env"; required: true; present: false } & PlatformOperatorStatusEnvRef)
  | ({ kind: "github-target" } & PlatformOperatorStatusGithubTargetRef)
  | ({ kind: "github-secret" } & PlatformOperatorStatusSecretRef);

export interface PlatformOperatorStatusCiHandoff {
  provider: "github-actions";
  ready: boolean;
  githubTarget: {
    repo?: string;
    ref?: string;
  };
  githubActions: Omit<PlatformOperatorStatusFileRef, "name"> & {
    fileName: string;
    name?: string;
    concurrency: {
      ok: boolean;
      group?: string;
      cancelInProgress?: boolean;
    };
  };
  externalSecrets: PlatformOperatorStatusFileRef & {
    schemaVersion?: string;
    tokenFree?: boolean;
    providerHint?: string;
    requiredEnvNames: string[];
  };
  workflowDispatchInputs: {
    phase: "pre-serve" | "post-serve" | "all";
    loom_bin: "loom";
    bundle_dir: "cutover-bundle";
    node_version: "22";
    bootstrap_source_tree: true;
  };
  workflowInstall: {
    sourcePath: string;
    destinationPath: string;
    installed: {
      path: string;
      exists: boolean;
      sha256?: string;
      matchesBundle: boolean;
    };
    report: PlatformOperatorStatusReportRef & {
      sourceSha256?: string;
      destinationPath?: string;
      destinationSha256?: string;
      matchesBundle: boolean;
    };
    command: string;
    installCommand: string;
    installCommandArgs: string[];
    commandSteps: Array<{
      command: string;
      commandArgs: string[];
    }>;
  };
  preflight: {
    report: PlatformOperatorStatusReportRef & {
      repository?: string;
      workflow?: string;
      requiredSecretEnvNames?: string[];
      presentRequiredSecretEnvNames?: string[];
      missingRequiredSecretEnvNames?: string[];
      setMissingRequiredSecretCommandArgs?: string[][];
      repo?: string;
      ref?: string;
      targetInputSource?: string;
      targetInputPath?: string;
      targetInputSha256?: string;
      targetInputTemplatePath?: string;
      targetInputTemplate?: {
        schemaVersion?: string;
        repo?: string;
        ref?: string;
      };
      repoDiscoveryCommandArgs?: string[];
      repoDiscoveryCwd?: string;
      repoDiscoveryFields?: {
        repo?: string;
        ref?: string;
      };
      missing?: string[];
      nextActions?: string[];
    };
    command: string;
    commandArgs: string[];
  };
  handoffRun: {
    report: PlatformOperatorStatusReportRef & {
      phase?: string;
      runId?: string;
    };
    command: string;
    commandArgs: string[];
  };
  workflowRun: {
    report: PlatformOperatorStatusReportRef & {
      provider?: string;
      phase?: string;
      status?: string;
      runId?: string;
      expectedRunId?: string;
      runUrl?: string;
      workflowSha256?: string;
      installedWorkflowSha256?: string;
      installReportSha256?: string;
      matchesHandoff: boolean;
    };
    command: string;
    commandArgs: string[];
  };
  workflowDispatch: {
    report: PlatformOperatorStatusReportRef & {
      phase?: string;
      workflow?: string;
      runId?: string;
      runUrl?: string;
    };
    command: string;
    commandArgs: string[];
  };
  workflowWait: {
    report: PlatformOperatorStatusReportRef & {
      phase?: string;
      runId?: string;
      runUrl?: string;
      status?: string;
      conclusion?: string;
    };
    command: string;
    commandArgs: string[];
  };
  artifactImport: {
    report: PlatformOperatorStatusReportRef & {
      phase?: string;
      expectedRunId?: string;
      sourceReportDir?: string;
      importedReportCount: number;
      missingReports: string[];
    };
    command: string;
    commandArgs: string[];
  };
  artifactSync: {
    report: PlatformOperatorStatusReportRef & {
      phase?: string;
      runId?: string;
      artifactName?: string;
    };
    command: string;
    commandArgs: string[];
  };
  workflowDispatchCommand: string;
  workflowDispatchCommandArgs: string[];
}

export interface PlatformOperatorStatusFileRef {
  name: string;
  path: string;
  exists: boolean;
  sha256?: string;
}

export interface PlatformOperatorStatusReportRef {
  name: string;
  path: string;
  exists: boolean;
  ok?: boolean;
  schemaVersion?: string;
  sha256?: string;
}

interface LoadedOperatorStatusReport extends PlatformOperatorStatusReportRef {
  value?: unknown;
}

interface LoadedOperatorStatusText extends PlatformOperatorStatusFileRef {
  text?: string;
}

export function createPlatformOperatorStatus(options: PlatformOperatorStatusCliOptions = {}): PlatformOperatorStatusResult {
  const dir = resolve(options.dir ?? process.cwd());
  const reportDir = resolve(join(dir, "reports"));
  const bundleParent = dirname(dir);
  const detectedRepoRoot = platformOperatorStatusGitRepoRoot(bundleParent);
  const defaultRepoRoot = detectedRepoRoot ?? bundleParent;
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot);
  const repoRootArg = options.repoRoot || (detectedRepoRoot && resolve(detectedRepoRoot) !== resolve(bundleParent))
    ? repoRoot
    : undefined;
  const requireExternalStaging = options.requireExternalStaging === true;
  const requireOperatorApprovals = options.requireOperatorApprovals === true;
  const requireAgentGitService = options.requireAgentGitService === true;
  const explicitGithubTarget = platformOperatorStatusExplicitGithubTarget(options);
  const reports = platformOperatorStatusReports(dir, reportDir);
  const stagingCi = platformOperatorStatusRecord(reports.stagingCi.value);
  const plan = platformOperatorStatusRecord(reports.plan.value);
  const commands = platformOperatorStatusCommands(dir, stagingCi, plan);
  const goalAudit = createPlatformGoalAudit({
    dir,
    requireExternalStaging,
    requireOperatorApprovals,
    requireAgentGitService,
  });
  const preliminaryCiHandoff = platformOperatorStatusCiHandoff(
    dir,
    repoRoot,
    repoRootArg,
    requireExternalStaging,
    "pre-serve",
    reports.ciHandoffInstall,
    reports.ciHandoffPreflight,
    reports.ciHandoffRun,
    reports.ciRunProof,
    reports.ciWorkflowDispatch,
    reports.ciWorkflowWait,
    reports.ciArtifactImport,
    reports.ciArtifactSync,
    explicitGithubTarget,
  );
  const preliminaryGates = platformOperatorStatusGates(reports, goalAudit.gates.productionCutoverReady, preliminaryCiHandoff.ready);
  const phase = platformOperatorStatusPhase(preliminaryGates);
  const workflowPhase = platformOperatorStatusWorkflowDispatchPhase(phase);
  const ciHandoff = workflowPhase === "pre-serve"
    ? preliminaryCiHandoff
    : platformOperatorStatusCiHandoff(
      dir,
      repoRoot,
      repoRootArg,
      requireExternalStaging,
      workflowPhase,
      reports.ciHandoffInstall,
      reports.ciHandoffPreflight,
      reports.ciHandoffRun,
      reports.ciRunProof,
      reports.ciWorkflowDispatch,
      reports.ciWorkflowWait,
      reports.ciArtifactImport,
      reports.ciArtifactSync,
      explicitGithubTarget,
    );
  const gates = platformOperatorStatusGates(reports, goalAudit.gates.productionCutoverReady, ciHandoff.ready);
  const agentGitService = platformOperatorStatusAgentGitServiceSummary(dir, reports, requireAgentGitService, plan, stagingCi);
  const missing = platformOperatorStatusMissing({
    reports,
    gates,
    ciHandoff,
    goalAuditMissing: goalAudit.missing,
    requireExternalStaging,
  });
  platformOperatorStatusSetWorkflowDispatchPhase(ciHandoff, platformOperatorStatusWorkflowDispatchPhase(phase), repoRootArg);
  const blockingGroups = platformOperatorStatusBlockingGroups(dir, repoRootArg, plan, reports, ciHandoff, commands, agentGitService, goalAudit, {
    gates,
    requireExternalStaging,
    requireOperatorApprovals,
    requireAgentGitService,
  });
  return {
    schemaVersion: "platform-operator-status/v1",
    ok: gates.productionCutoverReady && ciHandoff.ready,
    tokenFree: true,
    dir,
    reportDir,
    reportPath: options.report ? resolve(options.report) : undefined,
    requireExternalStaging,
    requireOperatorApprovals,
    requireAgentGitService,
    phase,
    gates,
    commands,
    ciHandoff,
    reports: platformOperatorStatusReportRefs(reports),
    goalAudit: {
      ok: goalAudit.ok,
      gates: goalAudit.gates,
      missing: goalAudit.missing,
      nextActions: goalAudit.nextActions,
    },
    agentGitService,
    cockpitPlan: platformOperatorStatusCockpitPlan(phase, blockingGroups),
    blockingGroups,
    missing,
    nextCommand: platformOperatorStatusNextCommand(phase, commands),
    nextActions: platformOperatorStatusNextActions(phase, commands, ciHandoff, reports),
  };
}

export function createPlatformOperatorCockpitNext(
  options: PlatformOperatorStatusCliOptions = {},
): PlatformOperatorCockpitNextResult {
  return platformOperatorCockpitNextFromPlan(createPlatformOperatorStatus(options).cockpitPlan);
}

function platformOperatorCockpitNextFromPlan(
  plan: PlatformOperatorStatusCockpitPlan,
): PlatformOperatorCockpitNextResult {
  const execution = plan.execution;
  return {
    schemaVersion: "platform-operator-cockpit-next/v1",
    tokenFree: true,
    phase: plan.phase,
    state: execution.state,
    pendingStepCount: execution.pendingStepCount,
    missingInputCount: execution.missingInputCount,
    commandRefCount: execution.commandRefCount,
    ...(execution.currentStepId ? { currentStepId: execution.currentStepId } : {}),
    ...(execution.currentBlockingGroupId ? { currentBlockingGroupId: execution.currentBlockingGroupId } : {}),
    ...(execution.currentStepMissingInputCount !== undefined
      ? { currentStepMissingInputCount: execution.currentStepMissingInputCount }
      : {}),
    ...(execution.nextInputRefs?.length ? { inputRefs: execution.nextInputRefs } : {}),
    ...(execution.nextCommandRef ? { commandRef: execution.nextCommandRef } : {}),
  };
}

function platformOperatorStatusReports(dir: string, reportDir: string): Record<string, LoadedOperatorStatusReport> {
  return {
    plan: loadPlatformOperatorStatusJson(dir, "plan.json"),
    stagingCi: loadPlatformOperatorStatusJson(dir, "staging-ci.json"),
    bundleVerify: loadPlatformOperatorStatusJson(reportDir, "bundle-verify.json"),
    externalStagingAudit: loadPlatformOperatorStatusJson(reportDir, "external-staging-audit.json"),
    stagingPrerequisites: loadPlatformOperatorStatusJson(reportDir, "staging-prerequisites.json"),
    stagingTargetsPlan: loadPlatformOperatorStatusJson(reportDir, "staging-targets-plan.json"),
    stagingTargetsEnvCheck: loadPlatformOperatorStatusJson(reportDir, "staging-targets-env-check.json"),
    stagingTargetsApply: loadPlatformOperatorStatusJson(reportDir, "staging-targets-apply.json"),
    upstreamAgentGitServiceServerEnvPlan: loadPlatformOperatorStatusJson(reportDir, "upstream-agent-git-service-server-env-plan.json"),
    upstreamAgentGitServiceHandoff: loadPlatformOperatorStatusJson(reportDir, "upstream-agent-git-service-handoff.json"),
    agentGitServiceStagingReadiness: loadPlatformOperatorStatusJson(reportDir, "agent-git-service-staging-readiness.json"),
    agentGitServiceNativeWriteCheck: loadPlatformOperatorStatusJson(reportDir, "agent-git-service-native-write-check.json"),
    agentGitServiceCompatManifest: loadPlatformOperatorStatusJson(reportDir, "agent-git-service-compat/manifest.json"),
    agentGitServiceCompatBaseline: loadPlatformOperatorStatusJson(reportDir, "agent-git-service-compat/baseline.json"),
    agentGitServiceCompatCandidate: loadPlatformOperatorStatusJson(reportDir, "agent-git-service-compat/candidate.json"),
    agentGitServiceCompatComparison: loadPlatformOperatorStatusJson(reportDir, "agent-git-service-compat/compare.json"),
    agsEvidenceImport: loadPlatformOperatorStatusJson(reportDir, "ags-evidence-import.json"),
    stagingRun: loadPlatformOperatorStatusJson(reportDir, "staging-run.json"),
    stagingTargets: loadPlatformOperatorStatusJson(reportDir, "staging-targets.json"),
    stagingEvidence: loadPlatformOperatorStatusJson(reportDir, "staging-evidence.json"),
    stagingVerdict: loadPlatformOperatorStatusJson(reportDir, "staging-verdict.json"),
    serveReady: loadPlatformOperatorStatusJson(reportDir, "serve-ready.json"),
    operatorArtifacts: loadPlatformOperatorStatusJson(reportDir, "operator-artifacts.json"),
    stagingProof: loadPlatformOperatorStatusJson(reportDir, "staging-proof.json"),
    goalAudit: loadPlatformOperatorStatusJson(reportDir, "goal-audit.json"),
    operatorCockpitRunnerExecute: loadPlatformOperatorStatusJson(reportDir, "operator-cockpit-runner-execute.json"),
    ciHandoffInstall: loadPlatformOperatorStatusJson(reportDir, "ci-handoff-install.json"),
    ciHandoffPreflight: loadPlatformOperatorStatusJson(reportDir, "ci-handoff-preflight.json"),
    ciWorkflowPublishPlan: loadPlatformOperatorStatusJson(reportDir, "ci-workflow-publish-plan.json"),
    ciSecretsPlan: loadPlatformOperatorStatusJson(reportDir, "ci-secrets-plan.json"),
    ciHandoffRun: loadPlatformOperatorStatusJson(reportDir, "ci-handoff-run.json"),
    ciRunProof: loadPlatformOperatorStatusJson(reportDir, "ci-run-proof.json"),
    ciWorkflowDispatch: loadPlatformOperatorStatusJson(reportDir, "ci-workflow-dispatch.json"),
    ciWorkflowWait: loadPlatformOperatorStatusJson(reportDir, "ci-workflow-wait.json"),
    ciArtifactImport: loadPlatformOperatorStatusJson(reportDir, "ci-artifact-import.json"),
    ciArtifactSync: loadPlatformOperatorStatusJson(reportDir, "ci-artifact-sync.json"),
  };
}

function loadPlatformOperatorStatusJson(dir: string, name: string): LoadedOperatorStatusReport {
  const path = join(dir, name);
  if (!existsSync(path)) return { name, path, exists: false };
  try {
    const text = readFileSync(path, "utf8");
    const value = JSON.parse(text) as unknown;
    const record = platformOperatorStatusRecord(value);
    return {
      name,
      path,
      exists: true,
      ok: platformOperatorStatusLoadedReportOk(name, record),
      schemaVersion: typeof record?.schemaVersion === "string" ? record.schemaVersion : undefined,
      sha256: sha256Hex(text),
      value,
    };
  } catch {
    return { name, path, exists: true, ok: false };
  }
}

function platformOperatorStatusLoadedReportOk(name: string, record: Record<string, unknown> | undefined): boolean {
  if (!record) return false;
  if (name === "staging-ci.json") return platformOperatorStatusStagingCiManifestOk(record);
  return record.ok === true || record.status === "passed";
}

function platformOperatorStatusStagingCiManifestOk(record: Record<string, unknown>): boolean {
  const commands = platformOperatorStatusRecord(record.commands);
  const expectedReports = platformOperatorStatusRecord(record.expectedReports);
  const checks = platformOperatorStatusRecord(record.checks);
  return record.schemaVersion === "platform-staging-ci/v1" &&
    record.tokenFree === true &&
    typeof commands?.preServe === "string" &&
    typeof commands.postServe === "string" &&
    typeof commands.all === "string" &&
    Array.isArray(record.requiredEnv) &&
    platformOperatorStatusRecord(record.externalTargets) !== undefined &&
    Array.isArray(expectedReports?.preServe) &&
    Array.isArray(expectedReports.postServe) &&
    Array.isArray(record.operatorApprovals) &&
    Array.isArray(checks?.preServe) &&
    Array.isArray(checks.postServe);
}

function platformOperatorStatusCommands(
  dir: string,
  stagingCi: Record<string, unknown> | undefined,
  plan: Record<string, unknown> | undefined,
): PlatformOperatorStatusResult["commands"] {
  const commands = platformOperatorStatusRecord(stagingCi?.commands);
  return {
    preServe: platformOperatorStatusString(commands?.preServe),
    manualServe: platformOperatorStatusManualServeCommand(dir, plan),
    postServe: platformOperatorStatusString(commands?.postServe),
    all: platformOperatorStatusString(commands?.all),
  };
}

function platformOperatorStatusManualServeCommand(dir: string, plan: Record<string, unknown> | undefined): string | undefined {
  const stages = Array.isArray(plan?.stages) ? plan.stages : [];
  const serve = stages
    .map((stage) => platformOperatorStatusRecord(stage))
    .find((stage) => stage?.id === "serve");
  const args = Array.isArray(serve?.commandArgs)
    ? serve.commandArgs.filter((arg): arg is string => typeof arg === "string")
    : [];
  if (args.length > 0) return platformOperatorStatusShellCommand(platformOperatorStatusLoomCommandArgs(dir, args));
  const command = platformOperatorStatusString(serve?.command);
  return command ? platformOperatorStatusLoomCommandString(dir, command) : undefined;
}

function platformOperatorStatusGates(
  reports: Record<string, LoadedOperatorStatusReport>,
  productionCutoverReady: boolean,
  ciHandoffReady: boolean,
): PlatformOperatorStatusResult["gates"] {
  const externalStagingAudit = platformOperatorStatusRecord(reports.externalStagingAudit.value);
  const stagingVerdict = platformOperatorStatusRecord(reports.stagingVerdict.value);
  const serveReady = platformOperatorStatusRecord(reports.serveReady.value);
  const operatorArtifacts = platformOperatorStatusRecord(reports.operatorArtifacts.value);
  const stagingProof = platformOperatorStatusRecord(reports.stagingProof.value);
  const preServeReady = externalStagingAudit?.schemaVersion === "platform-external-staging-audit/v1" &&
    externalStagingAudit.ok === true &&
    externalStagingAudit.tokenFree === true &&
    platformOperatorStatusArray(externalStagingAudit.missing).length === 0 &&
    platformOperatorStatusGate(externalStagingAudit, "bundleOk") &&
    platformOperatorStatusGate(externalStagingAudit, "environmentOk") &&
    platformOperatorStatusGate(externalStagingAudit, "externalTargetsReady") &&
    platformOperatorStatusGate(externalStagingAudit, "stagingPrerequisitesOk") &&
    platformOperatorStatusGate(externalStagingAudit, "preServeEvidenceOk") &&
    platformOperatorStatusGate(externalStagingAudit, "stagingRunReady") &&
    platformOperatorStatusGate(externalStagingAudit, "stagingVerdictReady");
  const readyForServe = preServeReady &&
    stagingVerdict?.schemaVersion === "platform-staging-verdict/v1" &&
    stagingVerdict.ok === true &&
    stagingVerdict.tokenFree === true &&
    stagingVerdict.decision === "ready-for-serve" &&
    platformOperatorStatusArray(stagingVerdict.missing).length === 0 &&
    platformOperatorStatusArray(stagingVerdict.failedGates).length === 0;
  const serveReachable = serveReady?.schemaVersion === "platform-serve-ready/v1" &&
    serveReady.ok === true &&
    serveReady.tokenFree === true;
  const postServeProofReady = operatorArtifacts?.schemaVersion === "platform-cutover-artifacts/v1" &&
    operatorArtifacts.ok === true &&
    operatorArtifacts.tokenFree === true &&
    stagingProof?.schemaVersion === "platform-staging-proof/v1" &&
    stagingProof.ok === true &&
    stagingProof.tokenFree === true;
  return {
    ciHandoffReady,
    preServeReady,
    readyForServe,
    serveReachable,
    postServeProofReady,
    productionCutoverReady,
  };
}

function platformOperatorStatusPhase(
  gates: PlatformOperatorStatusResult["gates"],
): PlatformOperatorStatusResult["phase"] {
  if (gates.productionCutoverReady) return "production-cutover-ready";
  if (!gates.preServeReady) return "prepare-pre-serve";
  if (gates.readyForServe && !gates.serveReachable) return "ready-for-serve";
  return "run-post-serve-proof";
}

function platformOperatorStatusMissing(options: {
  reports: Record<string, LoadedOperatorStatusReport>;
  gates: PlatformOperatorStatusResult["gates"];
  ciHandoff: PlatformOperatorStatusCiHandoff;
  goalAuditMissing: string[];
  requireExternalStaging: boolean;
}): string[] {
  return [...new Set([
    ...(options.ciHandoff.githubActions.exists ? [] : ["ciHandoff.githubActions"]),
    ...(options.ciHandoff.githubActions.exists && !options.ciHandoff.githubActions.concurrency.ok ? ["ciHandoff.githubActions.concurrency"] : []),
    ...(options.ciHandoff.githubActions.exists && !options.ciHandoff.workflowInstall.installed.matchesBundle ? ["ciHandoff.workflowInstall.installed"] : []),
    ...(options.ciHandoff.githubActions.exists && !options.ciHandoff.workflowInstall.report.matchesBundle ? ["ciHandoff.workflowInstall.report"] : []),
    ...(options.requireExternalStaging && options.ciHandoff.githubActions.exists && !options.ciHandoff.workflowRun.report.matchesHandoff ? ["ciHandoff.workflowRun.report"] : []),
    ...(options.ciHandoff.externalSecrets.exists ? [] : ["ciHandoff.externalSecrets"]),
    ...(options.reports.stagingCi.exists ? [] : ["reports.stagingCi"]),
    ...(options.reports.plan.exists ? [] : ["reports.plan"]),
    ...(options.gates.preServeReady ? [] : ["reports.externalStagingAudit"]),
    ...(options.gates.preServeReady && !options.gates.readyForServe ? ["reports.stagingVerdict"] : []),
    ...(options.gates.readyForServe && !options.gates.serveReachable ? ["reports.serveReady"] : []),
    ...options.goalAuditMissing,
  ])];
}

function platformOperatorStatusNextCommand(
  phase: PlatformOperatorStatusResult["phase"],
  commands: PlatformOperatorStatusResult["commands"],
): string | undefined {
  if (phase === "prepare-pre-serve") return commands.preServe;
  if (phase === "ready-for-serve" && commands.manualServe) return `Start manual serve: ${commands.manualServe}`;
  if (phase === "run-post-serve-proof") return commands.postServe ?? commands.all;
  return undefined;
}

function platformOperatorStatusNextActions(
  phase: PlatformOperatorStatusResult["phase"],
  commands: PlatformOperatorStatusResult["commands"],
  ciHandoff: PlatformOperatorStatusCiHandoff,
  reports: Record<string, LoadedOperatorStatusReport>,
): string[] {
  if (phase === "production-cutover-ready") {
    return ciHandoff.ready ? [] : platformOperatorStatusCiHandoffNextActions(ciHandoff, reports);
  }
  if (phase === "prepare-pre-serve") {
    return Array.from(new Set([
      ...platformOperatorStatusExternalStagingAuditNextActions(reports.externalStagingAudit, commands.preServe),
      ...platformOperatorStatusBundleVerifyNextActions(reports.bundleVerify, reports.plan.path),
      ...platformOperatorStatusExternalHelperPlanNextActions(reports),
      ...platformOperatorStatusPreServeEvidenceNextActions(reports, commands.preServe),
      "Run strict external pre-serve staging, then rerun platform-operator-status.",
      ...(commands.preServe ? [commands.preServe] : []),
      ...platformOperatorStatusCiHandoffNextActions(ciHandoff, reports),
    ]));
  }
  if (phase === "ready-for-serve") {
    return [
      ...(commands.manualServe ? [`Start manual serve: ${commands.manualServe}`] : ["Start the manual long-running serve stage from the operator bundle."]),
      ...(commands.postServe ? [`After serve is reachable, run ${commands.postServe}`] : ["After serve is reachable, run the strict post-serve bundle command."]),
      ...platformOperatorStatusCiHandoffNextActions(ciHandoff, reports),
    ];
  }
  return [
    "Run strict post-serve proof, then rerun platform-operator-status.",
    ...(commands.postServe ? [commands.postServe] : []),
    ...platformOperatorStatusCiHandoffNextActions(ciHandoff, reports),
  ];
}

function platformOperatorStatusExternalStagingAuditNextActions(
  report: LoadedOperatorStatusReport,
  preServeCommand: string | undefined,
): string[] {
  const value = platformOperatorStatusRecord(report.value);
  if (value?.schemaVersion !== "platform-external-staging-audit/v1") return [];
  return platformOperatorStatusArray(value.nextActions)
    .filter((action) => action !== preServeCommand);
}

function platformOperatorStatusBundleVerifyNextActions(
  report: LoadedOperatorStatusReport,
  planPath: string,
): string[] {
  if (!report.exists || report.ok === true) return [];
  const dir = resolve(dirname(planPath));
  return [`Bundle verify: Repair or regenerate the operator bundle, then run: loom harness platform-cutover-bundle-verify --dir ${dir}`];
}

function platformOperatorStatusExternalHelperPlanNextActions(
  reports: Record<string, LoadedOperatorStatusReport>,
): string[] {
  return [
    ...platformOperatorStatusReportNextActions(
      reports.stagingPrerequisites,
      "platform-staging-prerequisites/v1",
      "Staging prerequisites",
    ),
    ...platformOperatorStatusReportNextActions(
      reports.stagingTargetsPlan,
      "platform-staging-targets-plan/v1",
      "Staging targets plan",
    ),
    ...platformOperatorStatusReportNextActions(
      reports.stagingTargetsEnvCheck,
      "platform-staging-targets-env-check/v1",
      "Staging targets env check",
    ),
    ...platformOperatorStatusReportNextActions(
      reports.stagingTargetsApply,
      "platform-staging-targets-apply/v1",
      "Staging targets apply",
    ),
    ...platformOperatorStatusReportNextActions(
      reports.upstreamAgentGitServiceServerEnvPlan,
      "upstream-agent-git-service-server-env-plan/v1",
      "Upstream AGS server env plan",
    ),
  ];
}

function platformOperatorStatusPreServeEvidenceNextActions(
  reports: Record<string, LoadedOperatorStatusReport>,
  preServeCommand: string | undefined,
): string[] {
  const missingReports = platformOperatorStatusMissingPreServeEvidenceReports(reports);
  if (missingReports.length === 0) return [];
  const command = preServeCommand ? `run ${preServeCommand}` : "run the strict pre-serve bundle command";
  return [`Pre-serve evidence reports missing: ${command} to generate ${platformOperatorStatusFormatList(missingReports)}, then rerun platform-operator-status.`];
}

function platformOperatorStatusReportNextActions(
  report: LoadedOperatorStatusReport | undefined,
  schemaVersion: string,
  label: string,
): string[] {
  const value = platformOperatorStatusRecord(report?.value);
  if (value?.schemaVersion !== schemaVersion) return [];
  return platformOperatorStatusArray(value.nextActions).map((action) => `${label}: ${action}`);
}

function platformOperatorStatusAgentGitServiceSummary(
  dir: string,
  reports: Record<string, LoadedOperatorStatusReport>,
  required: boolean,
  plan: Record<string, unknown> | undefined,
  stagingCi: Record<string, unknown> | undefined,
): PlatformOperatorStatusAgentGitServiceSummary {
  const nativeWriteCheckRequired = required && platformOperatorStatusAgentGitServiceNativeWriteCheckRequired(plan, stagingCi);
  const gates = {
    serverEnvPlanOk: platformOperatorStatusAgentGitServiceServerEnvPlanOk(reports.upstreamAgentGitServiceServerEnvPlan),
    upstreamHandoffOk: platformOperatorStatusReportOk(reports.upstreamAgentGitServiceHandoff, "upstream-agent-git-service-handoff/v1"),
    stagingReadinessOk: platformOperatorStatusAgentGitServiceStagingReadinessOk(reports.agentGitServiceStagingReadiness),
    nativeWriteCheckOk: !nativeWriteCheckRequired || platformOperatorStatusAgentGitServiceNativeWriteCheckOk(reports.agentGitServiceNativeWriteCheck),
    compatOk: platformOperatorStatusAgentGitServiceCompatOk(reports),
  };
  const missing = required
    ? [
        ...(gates.serverEnvPlanOk ? [] : ["agentGitService.serverEnvPlan"]),
        ...(gates.upstreamHandoffOk ? [] : ["agentGitService.upstreamHandoff"]),
        ...(gates.stagingReadinessOk ? [] : ["agentGitService.stagingReadiness"]),
        ...(gates.nativeWriteCheckOk ? [] : ["agentGitService.nativeWriteCheck"]),
        ...(gates.compatOk ? [] : ["agentGitService.compat"]),
      ]
    : [];
  return {
    provider: "agent-git-service",
    required,
    ok: missing.length === 0,
    tokenFree: true,
    reports: {
      serverEnvPlan: platformOperatorStatusReportRef(reports.upstreamAgentGitServiceServerEnvPlan),
      upstreamHandoff: platformOperatorStatusReportRef(reports.upstreamAgentGitServiceHandoff),
      stagingReadiness: platformOperatorStatusReportRef(reports.agentGitServiceStagingReadiness),
      nativeWriteCheck: platformOperatorStatusReportRef(reports.agentGitServiceNativeWriteCheck),
      compat: {
        manifest: platformOperatorStatusReportRef(reports.agentGitServiceCompatManifest),
        baseline: platformOperatorStatusReportRef(reports.agentGitServiceCompatBaseline),
        candidate: platformOperatorStatusReportRef(reports.agentGitServiceCompatCandidate),
        comparison: platformOperatorStatusReportRef(reports.agentGitServiceCompatComparison),
      },
    },
    gates,
    nativeWriteCheckRequired,
    missing,
    nextActions: required ? platformOperatorStatusAgentGitServiceNextActions(dir, reports, gates) : [],
  };
}

function platformOperatorStatusAgentGitServiceNativeWriteCheckRequired(
  plan: Record<string, unknown> | undefined,
  stagingCi: Record<string, unknown> | undefined,
): boolean {
  const stages = Array.isArray(plan?.stages) ? plan.stages : [];
  const expectedReports = platformOperatorStatusRecord(stagingCi?.expectedReports);
  const postServeReports = platformOperatorStatusArray(expectedReports?.postServe);
  const operatorApprovals = Array.isArray(stagingCi?.operatorApprovals) ? stagingCi.operatorApprovals : [];
  return stages
    .map((stage) => platformOperatorStatusRecord(stage))
    .some((stage) => stage?.id === "agent-git-service-native-write-check") ||
    postServeReports.includes("agent-git-service-native-write-check.json") ||
    operatorApprovals
      .map((approval) => platformOperatorStatusRecord(approval))
      .some((approval) => approval?.stageId === "agent-git-service-native-write-check");
}

function platformOperatorStatusAgentGitServiceServerEnvPlanOk(report: LoadedOperatorStatusReport | undefined): boolean {
  const value = platformOperatorStatusRecord(report?.value);
  return platformOperatorStatusReportOk(report, "upstream-agent-git-service-server-env-plan/v1") &&
    value?.provider === "agent-git-service";
}

function platformOperatorStatusAgentGitServiceStagingReadinessOk(report: LoadedOperatorStatusReport | undefined): boolean {
  const value = platformOperatorStatusRecord(report?.value);
  return platformOperatorStatusReportOk(report, "agent-git-service-staging-readiness/v1") &&
    value?.provider === "agent-git-service";
}

function platformOperatorStatusAgentGitServiceNativeWriteCheckOk(report: LoadedOperatorStatusReport | undefined): boolean {
  const value = platformOperatorStatusRecord(report?.value);
  return platformOperatorStatusReportOk(report, "agent-git-service-native-write-check/v1") &&
    value?.provider === "agent-git-service" &&
    value.approved === true &&
    platformOperatorStatusGate(value, "token") &&
    platformOperatorStatusGate(value, "approved") &&
    platformOperatorStatusGate(value, "issueComment") &&
    platformOperatorStatusGate(value, "workspaceAttachment") &&
    platformOperatorStatusGate(value, "wikiMemory");
}

function platformOperatorStatusAgentGitServiceCompatOk(reports: Record<string, LoadedOperatorStatusReport>): boolean {
  const manifest = platformOperatorStatusRecord(reports.agentGitServiceCompatManifest.value);
  return reports.agentGitServiceCompatManifest.exists &&
    manifest?.schemaVersion === "agent-git-service-compat-rehearsal/v1" &&
    manifest.tokenFree === true &&
    manifest.comparisonOk === true &&
    platformOperatorStatusAgentGitServiceProbeOk(reports.agentGitServiceCompatBaseline) &&
    platformOperatorStatusAgentGitServiceProbeOk(reports.agentGitServiceCompatCandidate) &&
    platformOperatorStatusReportOk(reports.agentGitServiceCompatComparison, "agent-git-service-contract-comparison/v1");
}

function platformOperatorStatusAgentGitServiceProbeOk(report: LoadedOperatorStatusReport | undefined): boolean {
  const value = platformOperatorStatusRecord(report?.value);
  return report?.exists === true &&
    value?.schemaVersion === "agent-git-service-contract-probe/v1" &&
    value.ok === true &&
    value?.provider === "agent-git-service" &&
    value.requestsTokenFree === true &&
    platformOperatorStatusArray(value.missingEndpoints).length === 0;
}

function platformOperatorStatusReportOk(report: LoadedOperatorStatusReport | undefined, schemaVersion: string): boolean {
  const value = platformOperatorStatusRecord(report?.value);
  return report?.exists === true &&
    value?.schemaVersion === schemaVersion &&
    value.ok === true &&
    value.tokenFree === true &&
    platformOperatorStatusArray(value.missing).length === 0;
}

function platformOperatorStatusStagingTargetsApplyOk(report: LoadedOperatorStatusReport | undefined): boolean {
  const value = platformOperatorStatusRecord(report?.value);
  return platformOperatorStatusReportOk(report, "platform-staging-targets-apply/v1") &&
    platformOperatorStatusGate(value, "envCheckOk") &&
    platformOperatorStatusGate(value, "realPlanWritten") &&
    platformOperatorStatusGate(value, "realTargetsProofOk");
}

function platformOperatorStatusOperatorCockpitRunnerExecuteOk(report: LoadedOperatorStatusReport | undefined): boolean {
  const value = platformOperatorStatusRecord(report?.value);
  const execution = platformOperatorStatusRecord(value?.execution);
  const executionLease = platformOperatorStatusRecord(value?.executionLease);
  return report?.exists === true &&
    value?.schemaVersion === "platform-operator-cockpit-runner/v1" &&
    value.ok === true &&
    value.tokenFree === true &&
    value.mode === "executed" &&
    platformOperatorStatusArray(value.missing).length === 0 &&
    execution?.requested === true &&
    execution.exitCode === 0 &&
    executionLease?.acquired === true;
}

function platformOperatorStatusAgentGitServiceNextActions(
  dir: string,
  reports: Record<string, LoadedOperatorStatusReport>,
  gates: PlatformOperatorStatusAgentGitServiceSummary["gates"],
): string[] {
  return Array.from(new Set([
    ...(!gates.serverEnvPlanOk
      ? platformOperatorStatusReportNextActions(
          reports.upstreamAgentGitServiceServerEnvPlan,
          "upstream-agent-git-service-server-env-plan/v1",
          "Upstream AGS server env plan",
        )
      : []),
    ...(!gates.upstreamHandoffOk
      ? [`Run upstream AGS handoff: ${platformOperatorStatusShellCommand([
          platformOperatorStatusLoomCommand(dir),
          "harness",
          "upstream-agent-git-service-handoff",
          "--dir",
          dir,
          "--plan",
          join(dir, "plan.json"),
          "--report",
          join(dir, "reports", "upstream-agent-git-service-handoff.json"),
        ])}`]
      : []),
    ...(!gates.stagingReadinessOk
      ? ["Run AGS staging readiness from the operator bundle, then rerun platform-operator-status."]
      : []),
    ...(!gates.nativeWriteCheckOk
      ? ["Run AGS native write check from the operator bundle, then rerun platform-operator-status."]
      : []),
    ...(!gates.compatOk
      ? ["Run AGS compat rehearsal from the operator bundle, then rerun platform-operator-status."]
      : []),
  ]));
}

function platformOperatorStatusAgentGitServiceCommandRefs(
  dir: string,
  repoRootArg: string | undefined,
  plan: Record<string, unknown> | undefined,
  agentGitService: PlatformOperatorStatusAgentGitServiceSummary,
  ciHandoff: PlatformOperatorStatusCiHandoff,
  options: {
    requireExternalStaging: boolean;
    requireOperatorApprovals: boolean;
    requireAgentGitService: boolean;
  },
): PlatformOperatorStatusCommandRef[] {
  if (!agentGitService.required) return [];
  return platformOperatorStatusUniqueCommandRefs([
    ...(agentGitService.ok
      ? []
      : [
          platformOperatorStatusAgentGitServiceEvidenceSyncCommandRef(dir, "pre-serve", repoRootArg, ciHandoff, options),
          platformOperatorStatusAgentGitServiceEvidenceImportCommandRef(dir, "pre-serve", repoRootArg, ciHandoff.githubTarget, options),
        ]),
    ...(agentGitService.gates.upstreamHandoffOk ? [] : [platformOperatorStatusAgentGitServiceHandoffCommandRef(dir)]),
    ...(agentGitService.gates.stagingReadinessOk
      ? []
      : [platformOperatorStatusPlanStageCommandRef(dir, plan, "agent-git-service-staging-readiness")]),
    ...(agentGitService.gates.compatOk
      ? []
      : [platformOperatorStatusPlanStageCommandRef(dir, plan, "agent-git-service-compat-rehearsal")]),
  ]);
}

function platformOperatorStatusAgentGitServiceEvidenceSyncCommandRef(
  dir: string,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  repoRootArg: string | undefined,
  ciHandoff: PlatformOperatorStatusCiHandoff,
  options: {
    requireExternalStaging: boolean;
    requireOperatorApprovals: boolean;
    requireAgentGitService: boolean;
  },
): PlatformOperatorStatusCommandRef | undefined {
  return platformOperatorStatusCommandRef("ags-evidence-sync", [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-operator-ags-evidence-sync",
    "--dir",
    dir,
    ...platformOperatorStatusGithubRepoArgs(ciHandoff.githubTarget),
    "--run-id",
    platformOperatorStatusCiHandoffRunId(ciHandoff) ?? "<github-run-id>",
    "--phase",
    phase,
    ...(repoRootArg ? ["--repo-root", repoRootArg] : []),
    ...platformOperatorStatusGithubRefArgs(ciHandoff.githubTarget),
    ...(options.requireExternalStaging ? ["--require-external-staging"] : []),
    ...(options.requireOperatorApprovals ? ["--require-operator-approvals"] : []),
    ...(options.requireAgentGitService ? ["--require-agent-git-service"] : []),
    "--report",
    join(dir, "reports", "ags-evidence-sync.json"),
  ]);
}

function platformOperatorStatusAgentGitServiceEvidenceImportCommandRef(
  dir: string,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  repoRootArg: string | undefined,
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
  options: {
    requireExternalStaging: boolean;
    requireOperatorApprovals: boolean;
    requireAgentGitService: boolean;
  },
): PlatformOperatorStatusCommandRef | undefined {
  return platformOperatorStatusCommandRef("ags-evidence-import", [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-operator-ags-evidence-import",
    "--dir",
    dir,
    "--artifact-dir",
    "<downloaded-ags-artifact-dir>",
    "--phase",
    phase,
    ...(repoRootArg ? ["--repo-root", repoRootArg] : []),
    ...platformOperatorStatusGithubTargetArgs(githubTarget),
    ...(options.requireExternalStaging ? ["--require-external-staging"] : []),
    ...(options.requireOperatorApprovals ? ["--require-operator-approvals"] : []),
    ...(options.requireAgentGitService ? ["--require-agent-git-service"] : []),
    "--report",
    join(dir, "reports", "ags-evidence-import.json"),
  ]);
}

function platformOperatorStatusAgentGitServiceHandoffCommandRef(
  dir: string,
): PlatformOperatorStatusCommandRef | undefined {
  return platformOperatorStatusCommandRef("upstream-agent-git-service-handoff", [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "upstream-agent-git-service-handoff",
    "--dir",
    dir,
    "--plan",
    join(dir, "plan.json"),
    "--report",
    join(dir, "reports", "upstream-agent-git-service-handoff.json"),
  ]);
}

function platformOperatorStatusPlanStageCommandRef(
  dir: string,
  plan: Record<string, unknown> | undefined,
  stageId: string,
): PlatformOperatorStatusCommandRef | undefined {
  const stages = Array.isArray(plan?.stages) ? plan.stages : [];
  const stage = stages
    .map((item) => platformOperatorStatusRecord(item))
    .find((item) => item?.id === stageId);
  const commandArgs = platformOperatorStatusLoomCommandArgs(dir, platformOperatorStatusCommandArgs(stage?.commandArgs));
  return platformOperatorStatusCommandRef(stageId, commandArgs);
}

function platformOperatorStatusBlockingGroups(
  dir: string,
  repoRootArg: string | undefined,
  plan: Record<string, unknown> | undefined,
  reports: Record<string, LoadedOperatorStatusReport>,
  ciHandoff: PlatformOperatorStatusCiHandoff,
  commands: PlatformOperatorStatusResult["commands"],
  agentGitService: PlatformOperatorStatusAgentGitServiceSummary,
  goalAudit: PlatformGoalAuditResult,
  options: {
    gates: PlatformOperatorStatusResult["gates"];
    requireExternalStaging: boolean;
    requireOperatorApprovals: boolean;
    requireAgentGitService: boolean;
  },
): PlatformOperatorStatusBlockingGroup[] {
  const stagingPrerequisites = platformOperatorStatusRecord(reports.stagingPrerequisites.value);
  const prerequisitesMissing = platformOperatorStatusArray(stagingPrerequisites?.missing);
  const operatorEnvMissing = prerequisitesMissing.filter((item) => item.startsWith("environment."));
  const toolingMissing = prerequisitesMissing.filter((item) => item.startsWith("tooling."));
  const upstreamAgentGitServiceMissing = prerequisitesMissing.filter((item) => item.startsWith("upstreamAgentGitService."));
  const agentGitServiceMissing = [
    ...upstreamAgentGitServiceMissing,
    ...(agentGitService.required ? agentGitService.missing : []),
  ];
  const targetPlan = platformOperatorStatusRecord(reports.stagingTargetsPlan.value);
  const targetsEnvCheck = platformOperatorStatusRecord(reports.stagingTargetsEnvCheck.value);
  const targetsApplyOk = platformOperatorStatusStagingTargetsApplyOk(reports.stagingTargetsApply);
  const targetInputRefs = platformOperatorStatusTargetInputRefs(dir, targetPlan, repoRootArg, ciHandoff.githubTarget, options);
  const ciPreflight = platformOperatorStatusRecord(reports.ciHandoffPreflight.value);
  const groups = [
    platformOperatorStatusLocalMvpBlockingGroup(dir, plan, goalAudit, options.requireAgentGitService),
    platformOperatorStatusBlockingGroup(
      "operator-env",
      operatorEnvMissing,
      platformOperatorStatusFilterReportNextActions(reports.stagingPrerequisites, "platform-staging-prerequisites/v1", "Staging prerequisites", [
        "env vars",
        "required env",
      ]),
      [],
      platformOperatorStatusEnvRefs(stagingPrerequisites, operatorEnvMissing.map((item) => item.slice("environment.".length))),
    ),
    platformOperatorStatusBlockingGroup(
      "tooling",
      toolingMissing,
      toolingMissing.length > 0
        ? platformOperatorStatusFilterReportNextActions(reports.stagingPrerequisites, "platform-staging-prerequisites/v1", "Staging prerequisites", [
            "LOOM_BIN",
            "tool",
            "wrapper",
          ])
        : [],
    ),
    platformOperatorStatusBlockingGroup(
      "external-targets",
      [
        ...prerequisitesMissing.filter((item) => item.startsWith("targets.")),
        ...platformOperatorStatusArray(targetPlan?.placeholderTargets),
        ...platformOperatorStatusArray(targetsEnvCheck?.missing),
      ],
      [
        ...platformOperatorStatusFilterReportNextActions(reports.stagingPrerequisites, "platform-staging-prerequisites/v1", "Staging prerequisites", [
          "target",
          "replacement",
        ]),
        ...platformOperatorStatusReportNextActions(reports.stagingTargetsPlan, "platform-staging-targets-plan/v1", "Staging targets plan"),
        ...platformOperatorStatusReportNextActions(reports.stagingTargetsEnvCheck, "platform-staging-targets-env-check/v1", "Staging targets env check"),
        ...platformOperatorStatusReportNextActions(reports.stagingTargetsApply, "platform-staging-targets-apply/v1", "Staging targets apply"),
      ],
      platformOperatorStatusExternalTargetCommandRefs(targetPlan, targetInputRefs, targetsApplyOk),
      [],
      [],
      [],
      platformOperatorStatusTargetEnvRefs(targetPlan, targetsEnvCheck),
      [],
      targetInputRefs,
    ),
    platformOperatorStatusBlockingGroup(
      "upstream-agent-git-service",
      agentGitServiceMissing,
      [
        ...platformOperatorStatusFilterReportNextActions(reports.stagingPrerequisites, "platform-staging-prerequisites/v1", "Staging prerequisites", [
          "upstream",
          "gh-server",
          "server env",
        ]),
        ...(upstreamAgentGitServiceMissing.length > 0 || reports.upstreamAgentGitServiceServerEnvPlan.ok === false
          ? platformOperatorStatusReportNextActions(reports.upstreamAgentGitServiceServerEnvPlan, "upstream-agent-git-service-server-env-plan/v1", "Upstream AGS server env plan")
          : []),
        ...agentGitService.nextActions,
      ],
      [
        ...platformOperatorStatusReportCommandRefs(platformOperatorStatusRecord(reports.upstreamAgentGitServiceServerEnvPlan.value), [
          ["upstream-agent-git-service-start", "serverStartCommandArgs"],
          ["upstream-agent-git-service-readyz", "readinessProbeCommandArgs"],
        ]),
        ...platformOperatorStatusAgentGitServiceCommandRefs(dir, repoRootArg, plan, agentGitService, ciHandoff, options),
      ],
      [],
      [],
      platformOperatorStatusAgentGitServiceServerEnvRefs(
        platformOperatorStatusRecord(reports.upstreamAgentGitServiceServerEnvPlan.value),
        upstreamAgentGitServiceMissing,
      ),
      [],
    ),
    platformOperatorStatusBlockingGroup(
      "pre-serve-evidence",
      platformOperatorStatusMissingPreServeEvidenceReports(reports),
      platformOperatorStatusPreServeEvidenceNextActions(reports, commands.preServe),
      [
        platformOperatorStatusShellCommandRef("strict-pre-serve", commands.preServe),
      ],
    ),
    platformOperatorStatusBlockingGroup(
      "github-actions",
      [
        ...platformOperatorStatusArray(ciPreflight?.missing),
        ...(ciHandoff.workflowRun.report.matchesHandoff ? [] : ["ciHandoff.workflowRun.report"]),
      ],
      [
        ...(ciHandoff.preflight.report.nextActions ?? []).map((action) => `CI handoff preflight: ${action}`),
        ...(ciHandoff.workflowRun.report.matchesHandoff ? [] : [`Record CI run proof from GitHub Actions: ${ciHandoff.workflowRun.command}`]),
      ],
      [
        platformOperatorStatusPreflightRepoDiscoveryCommandRef(ciHandoff.preflight.report),
        platformOperatorStatusCommandRef("ci-handoff-preflight", ciHandoff.preflight.commandArgs),
        platformOperatorStatusCommandRef("ci-run-proof", ciHandoff.workflowRun.commandArgs),
        platformOperatorStatusCommandRef("ci-handoff-run", ciHandoff.handoffRun.commandArgs),
        platformOperatorStatusCommandRef("ci-workflow-dispatch", ciHandoff.workflowDispatch.commandArgs),
        platformOperatorStatusCommandRef("ci-workflow-wait", ciHandoff.workflowWait.commandArgs),
        platformOperatorStatusCommandRef("ci-artifact-sync", ciHandoff.artifactSync.commandArgs),
        platformOperatorStatusCommandRef("ci-artifact-import", ciHandoff.artifactImport.commandArgs),
      ],
      [],
      platformOperatorStatusGithubActionsSecretRefs(ciHandoff.preflight.report, ciHandoff.githubTarget),
      [],
      [],
      platformOperatorStatusGithubTargetRefs(ciHandoff),
    ),
  ];
  const activeGroups = options.gates.preServeReady
    ? groups.filter((group) => !platformOperatorStatusPreServeBlockingGroupId(group.id))
    : groups;
  const postServeProof = platformOperatorStatusPostServeProofBlockingGroup(
    dir,
    repoRootArg,
    plan,
    reports,
    ciHandoff,
    agentGitService,
    goalAudit,
    options,
  );
  if (postServeProof) activeGroups.push(postServeProof);
  return activeGroups.filter((group) => !group.ok || group.nextActions.length > 0);
}

function platformOperatorStatusLocalMvpBlockingGroup(
  dir: string,
  plan: Record<string, unknown> | undefined,
  goalAudit: PlatformGoalAuditResult,
  requireAgentGitService: boolean,
): PlatformOperatorStatusBlockingGroup {
  const localMvpMissing = platformOperatorStatusLocalMvpMissingRefs(goalAudit.missing);
  return platformOperatorStatusBlockingGroup(
    "local-mvp",
    localMvpMissing,
    localMvpMissing.length > 0
      ? goalAudit.nextActions
          .filter((action) => action.includes("cutover-report") || action.includes("smoke --profile platform-readiness") || action.includes("platform-concurrency-audit"))
          .map((action) => `Goal audit: ${action}`)
      : [],
    platformOperatorStatusLocalMvpCommandRefs(dir, plan, localMvpMissing, requireAgentGitService),
  );
}

function platformOperatorStatusLocalMvpMissingRefs(missing: string[]): string[] {
  const localMvpRefs = new Set([
    "reports.cutoverReport",
    "reports.smoke",
    "reports.concurrencyAudit",
    "visionLock",
    "onlineSandbox",
    "concurrencyAudit",
  ]);
  return missing.filter((item) => localMvpRefs.has(item));
}

function platformOperatorStatusLocalMvpCommandRefs(
  dir: string,
  plan: Record<string, unknown> | undefined,
  missing: string[],
  requireAgentGitService: boolean,
): PlatformOperatorStatusCommandRef[] {
  const commandRefs: Array<PlatformOperatorStatusCommandRef | undefined> = [
    platformOperatorStatusLocalMvpCutoverSmokeCommandRef(dir, plan, missing),
  ];
  if (missing.includes("reports.concurrencyAudit") || missing.includes("concurrencyAudit")) {
    commandRefs.push(platformOperatorStatusCommandRef("platform-concurrency-audit", [
      platformOperatorStatusLoomCommand(dir),
      "harness",
      "platform-concurrency-audit",
      "--cutover-report",
      join(dir, "reports", "cutover-report.json"),
      "--smoke-report",
      join(dir, "reports", "smoke.json"),
      ...(requireAgentGitService ? ["--require-agent-git-service"] : []),
      "--report",
      join(dir, "reports", "concurrency-audit.json"),
    ]));
  }
  return commandRefs.filter((ref): ref is PlatformOperatorStatusCommandRef => ref !== undefined);
}

function platformOperatorStatusLocalMvpCutoverSmokeCommandRef(
  dir: string,
  plan: Record<string, unknown> | undefined,
  missing: string[],
): PlatformOperatorStatusCommandRef | undefined {
  const needsCutoverSmoke = missing.some((item) =>
    item === "reports.cutoverReport" ||
    item === "reports.smoke" ||
    item === "visionLock" ||
    item === "onlineSandbox"
  );
  if (!needsCutoverSmoke || !platformOperatorStatusPlanHasStages(plan, ["cutover-report", "smoke"])) return undefined;
  return platformOperatorStatusCommandRef("platform-cutover-run-cutover-smoke", [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-cutover-run",
    "--plan",
    join(dir, "plan.json"),
    "--stage",
    "cutover-report",
    "--stage",
    "smoke",
    "--satisfy",
    "serve-running",
    "--check-env",
    "--report",
    join(dir, "reports", "safe-run.json"),
  ]);
}

function platformOperatorStatusPlanHasStages(
  plan: Record<string, unknown> | undefined,
  stageIds: string[],
): boolean {
  const presentStageIds = new Set((Array.isArray(plan?.stages) ? plan.stages : [])
    .map((stage) => platformOperatorStatusString(platformOperatorStatusRecord(stage)?.id))
    .filter((id): id is string => id !== undefined));
  return stageIds.every((stageId) => presentStageIds.has(stageId));
}

function platformOperatorStatusPreServeBlockingGroupId(id: string): boolean {
  return id === "operator-env" ||
    id === "tooling" ||
    id === "external-targets" ||
    id === "upstream-agent-git-service" ||
    id === "pre-serve-evidence";
}

function platformOperatorStatusPostServeProofBlockingGroup(
  dir: string,
  repoRootArg: string | undefined,
  plan: Record<string, unknown> | undefined,
  reports: Record<string, LoadedOperatorStatusReport>,
  ciHandoff: PlatformOperatorStatusCiHandoff,
  agentGitService: PlatformOperatorStatusAgentGitServiceSummary,
  goalAudit: PlatformGoalAuditResult,
  options: {
    gates: PlatformOperatorStatusResult["gates"];
    requireExternalStaging: boolean;
    requireOperatorApprovals: boolean;
    requireAgentGitService: boolean;
  },
): PlatformOperatorStatusBlockingGroup | undefined {
  if (!options.gates.readyForServe || !options.gates.serveReachable) return undefined;
  const operatorArtifactsOk = platformOperatorStatusReportOk(reports.operatorArtifacts, "platform-cutover-artifacts/v1");
  const stagingProofOk = platformOperatorStatusReportOk(reports.stagingProof, "platform-staging-proof/v1");
  const operatorCockpitRunnerExecuteOk = platformOperatorStatusOperatorCockpitRunnerExecuteOk(reports.operatorCockpitRunnerExecute);
  const goalAuditReportOk = platformOperatorStatusReportOk(reports.goalAudit, "platform-goal-audit/v1");
  const goalAuditMissing = platformOperatorStatusGoalAuditMissingRefs(goalAudit.missing);
  const goalAuditOk = goalAuditReportOk && goalAuditMissing.length === 0;
  const agentGitServiceNativeWriteCheckOk = agentGitService.gates.nativeWriteCheckOk;
  const missing = [
    ...(agentGitServiceNativeWriteCheckOk ? [] : ["reports.agentGitServiceNativeWriteCheck"]),
    ...(operatorArtifactsOk ? [] : ["reports.operatorArtifacts"]),
    ...(stagingProofOk ? [] : ["reports.stagingProof"]),
    ...(operatorCockpitRunnerExecuteOk ? [] : ["reports.operatorCockpitRunnerExecute"]),
    ...(goalAuditReportOk ? [] : ["reports.goalAudit"]),
    ...goalAuditMissing,
  ];
  return platformOperatorStatusBlockingGroup(
    "post-serve-proof",
    missing,
    missing.length > 0 ? ["Run the current post-serve proof command through platform-operator-cockpit-runner, then rerun platform-operator-status."] : [],
    platformOperatorStatusPostServeProofCommandRefs(dir, repoRootArg, plan, ciHandoff, options, {
      agentGitServiceNativeWriteCheckOk,
      operatorArtifactsOk,
      stagingProofOk,
      operatorCockpitRunnerExecuteOk,
      goalAuditOk,
    }, goalAudit.missing),
  );
}

function platformOperatorStatusGoalAuditMissingRefs(missing: string[]): string[] {
  return Array.from(new Set(missing.map((item) => `goalAudit.${item}`)));
}

function platformOperatorStatusPostServeProofCommandRefs(
  dir: string,
  repoRootArg: string | undefined,
  plan: Record<string, unknown> | undefined,
  ciHandoff: PlatformOperatorStatusCiHandoff,
  options: {
    requireExternalStaging: boolean;
    requireOperatorApprovals: boolean;
    requireAgentGitService: boolean;
  },
  gates: {
    agentGitServiceNativeWriteCheckOk: boolean;
    operatorArtifactsOk: boolean;
    stagingProofOk: boolean;
    operatorCockpitRunnerExecuteOk: boolean;
    goalAuditOk: boolean;
  },
  goalAuditMissing: string[],
): PlatformOperatorStatusCommandRef[] {
  if (!gates.operatorArtifactsOk || !gates.operatorCockpitRunnerExecuteOk) {
    return [
	      ...(!gates.agentGitServiceNativeWriteCheckOk
	        ? [
	            platformOperatorStatusPlanStageCommandRef(dir, plan, "agent-git-service-native-write-check"),
	            platformOperatorStatusAgentGitServiceEvidenceSyncCommandRef(dir, "post-serve", repoRootArg, ciHandoff, options),
	            platformOperatorStatusAgentGitServiceEvidenceImportCommandRef(dir, "post-serve", repoRootArg, ciHandoff.githubTarget, options),
	          ]
	        : []),
      platformOperatorStatusPostServeOperatorArtifactsCommandRef(dir, ciHandoff, options),
    ].filter((ref): ref is PlatformOperatorStatusCommandRef => ref !== undefined);
  }
  if (!gates.stagingProofOk) {
    return [
      platformOperatorStatusPostServeStagingProofCommandRef(dir, ciHandoff, options),
    ].filter((ref): ref is PlatformOperatorStatusCommandRef => ref !== undefined);
  }
  if (!gates.goalAuditOk) {
    return [
      ...(platformOperatorStatusGoalAuditNeedsCiHandoff(goalAuditMissing)
        ? [
            platformOperatorStatusCommandRef("ci-handoff-run", ciHandoff.handoffRun.commandArgs),
            platformOperatorStatusCommandRef("ci-artifact-sync", ciHandoff.artifactSync.commandArgs),
            platformOperatorStatusCommandRef("ci-artifact-import", ciHandoff.artifactImport.commandArgs),
          ]
        : []),
      ...(platformOperatorStatusGoalAuditNeedsStagingProof(goalAuditMissing)
        ? [platformOperatorStatusPostServeStagingProofCommandRef(dir, ciHandoff, options)]
        : []),
      platformOperatorStatusPostServeGoalAuditCommandRef(dir, options),
    ].filter((ref): ref is PlatformOperatorStatusCommandRef => ref !== undefined);
  }
  return [];
}

function platformOperatorStatusGoalAuditNeedsCiHandoff(missing: string[]): boolean {
  const ciHandoffRepairRefs = new Set([
    "reports.ciRunProof",
    "ciRunProof",
    "ciRunProofHandoff",
  ]);
  return missing.some((item) => ciHandoffRepairRefs.has(item));
}

function platformOperatorStatusGoalAuditNeedsStagingProof(missing: string[]): boolean {
  const stagingProofRepairRefs = new Set([
    "ciRunProofStagingProofAnchor",
    "stagingPrerequisitesProofAnchor",
    "stagingRunProofAnchor",
    "externalStagingAuditProofAnchor",
    "operatorArtifactsProofAnchor",
    "operatorApprovalsProofAnchor",
    "externalStaging",
    "strictProof",
  ]);
  return missing.some((item) => stagingProofRepairRefs.has(item));
}

function platformOperatorStatusPostServeOperatorArtifactsCommandRef(
  dir: string,
  ciHandoff: PlatformOperatorStatusCiHandoff,
  options: {
    requireExternalStaging: boolean;
    requireOperatorApprovals: boolean;
  },
): PlatformOperatorStatusCommandRef | undefined {
  return platformOperatorStatusCommandRef("operator-artifacts", [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-cutover-artifacts-verify",
    "--dir",
    dir,
    "--plan",
    join(dir, "plan.json"),
    "--report",
    join(dir, "reports", "operator-artifacts.json"),
    "--staging-evidence-report",
    join(dir, "reports", "staging-evidence.json"),
    ...(options.requireExternalStaging ? ["--require-external-staging"] : []),
    ...(options.requireOperatorApprovals ? ["--require-operator-approvals"] : []),
    ...platformOperatorStatusForbidEnvArgs(ciHandoff),
  ]);
}

function platformOperatorStatusPostServeStagingProofCommandRef(
  dir: string,
  ciHandoff: PlatformOperatorStatusCiHandoff,
  options: {
    requireExternalStaging: boolean;
    requireOperatorApprovals: boolean;
  },
): PlatformOperatorStatusCommandRef | undefined {
  return platformOperatorStatusCommandRef("staging-proof", [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-staging-proof",
    "--dir",
    dir,
    "--plan",
    join(dir, "plan.json"),
    "--report",
    join(dir, "reports", "staging-proof.json"),
    ...(options.requireExternalStaging ? ["--require-external-staging"] : []),
    ...(options.requireOperatorApprovals ? ["--require-operator-approvals"] : []),
    ...platformOperatorStatusForbidEnvArgs(ciHandoff),
  ]);
}

function platformOperatorStatusPostServeGoalAuditCommandRef(
  dir: string,
  options: {
    requireExternalStaging: boolean;
    requireOperatorApprovals: boolean;
    requireAgentGitService: boolean;
  },
): PlatformOperatorStatusCommandRef | undefined {
  return platformOperatorStatusCommandRef("goal-audit", [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-goal-audit",
    "--dir",
    dir,
    "--report",
    join(dir, "reports", "goal-audit.json"),
    ...(options.requireAgentGitService ? ["--require-agent-git-service"] : []),
    ...(options.requireExternalStaging ? ["--require-external-staging"] : []),
    ...(options.requireOperatorApprovals ? ["--require-operator-approvals"] : []),
  ]);
}

function platformOperatorStatusForbidEnvArgs(ciHandoff: PlatformOperatorStatusCiHandoff): string[] {
  return Array.from(new Set(ciHandoff.externalSecrets.requiredEnvNames))
    .flatMap((name) => ["--forbid-env", name]);
}

function platformOperatorStatusCockpitPlan(
  phase: PlatformOperatorStatusResult["phase"],
  groups: PlatformOperatorStatusBlockingGroup[],
): PlatformOperatorStatusCockpitPlan {
  const steps = [
    platformOperatorStatusCockpitStep("real-staging-targets", "external-targets", groups),
    platformOperatorStatusCockpitStep("upstream-agent-git-service", "upstream-agent-git-service", groups),
    platformOperatorStatusCockpitStep("operator-env", "operator-env", groups),
    platformOperatorStatusCockpitStep("github-actions", "github-actions", groups),
    platformOperatorStatusCockpitStep("pre-serve-evidence", "pre-serve-evidence", groups),
    platformOperatorStatusCockpitStep("post-serve-proof", "post-serve-proof", groups),
  ].filter((step): step is PlatformOperatorStatusCockpitStep => step !== undefined);
  return {
    schemaVersion: "platform-operator-cockpit-plan/v1",
    tokenFree: true,
    phase,
    execution: platformOperatorStatusCockpitExecution(steps),
    steps,
  };
}

function platformOperatorStatusCockpitExecution(
  steps: PlatformOperatorStatusCockpitStep[],
): PlatformOperatorStatusCockpitExecution {
  const missingInputCount = steps.reduce(
    (count, step) => count + platformOperatorStatusCockpitMissingInputCount(step) + platformOperatorStatusCockpitCommandInputCount(step),
    0,
  );
  const commandRefCount = steps.reduce((count, step) => count + (step.commandRefs?.length ?? 0), 0);
  const currentStep = steps[0];
  if (!currentStep) {
    return {
      state: "complete",
      pendingStepCount: 0,
      missingInputCount: 0,
      commandRefCount: 0,
    };
  }
  const nextCommandRef = platformOperatorStatusCockpitRunnableCommandRef(currentStep);
  const currentStepMissingInputCount = platformOperatorStatusCockpitMissingInputCount(currentStep) +
    platformOperatorStatusCockpitCommandInputCount(currentStep);
  const currentStepMissingInputRefs = platformOperatorStatusCockpitMissingInputRefs(currentStep);
  return {
    state: currentStepMissingInputCount > 0 ? "needs-input" : "ready-to-run",
    pendingStepCount: steps.length,
    missingInputCount,
    commandRefCount,
    currentStepId: currentStep.id,
    currentBlockingGroupId: currentStep.blockingGroupId,
    currentStepMissingInputCount,
    ...(currentStepMissingInputRefs.length > 0 ? { nextInputRefs: currentStepMissingInputRefs } : {}),
    ...(currentStepMissingInputCount === 0 && nextCommandRef
      ? { nextCommandRef }
      : {}),
  };
}

function platformOperatorStatusCockpitRunnableCommandRef(
  step: PlatformOperatorStatusCockpitStep,
): PlatformOperatorStatusCommandRef | undefined {
  return step.commandRefs?.find((ref) => !ref.commandArgs.some(platformOperatorStatusCommandArgumentHasPlaceholder));
}

function platformOperatorStatusCockpitCommandInputCount(step: PlatformOperatorStatusCockpitStep): number {
  return (step.commandRefs?.length ?? 0) > 0 && !platformOperatorStatusCockpitRunnableCommandRef(step) ? 1 : 0;
}

function platformOperatorStatusCommandArgumentHasPlaceholder(value: string): boolean {
  return /<[^<>]+>/.test(value);
}

function platformOperatorStatusCockpitMissingInputCount(step: PlatformOperatorStatusCockpitStep): number {
  return platformOperatorStatusCockpitMissingInputRefs(step).length;
}

function platformOperatorStatusCockpitMissingInputRefs(
  step: PlatformOperatorStatusCockpitStep,
): PlatformOperatorStatusCockpitInputRef[] {
  const missingRefs = (step.inputRefs ?? []).filter((ref) => ref.present === false);
  const missingTargetInputRefs = missingRefs.filter((ref) => ref.kind === "target-input-file");
  return missingTargetInputRefs.length > 0 ? missingTargetInputRefs : missingRefs;
}

function platformOperatorStatusCockpitStep(
  id: PlatformOperatorStatusCockpitStep["id"],
  blockingGroupId: string,
  groups: PlatformOperatorStatusBlockingGroup[],
): PlatformOperatorStatusCockpitStep | undefined {
  const group = groups.find((candidate) => candidate.id === blockingGroupId);
  if (!group) return undefined;
  const inputRefs = platformOperatorStatusCockpitInputRefs(group);
  return {
    id,
    blockingGroupId,
    ...(inputRefs.length ? { inputRefs } : {}),
    ...(group.commandRefs?.length ? { commandRefs: group.commandRefs } : {}),
  };
}

function platformOperatorStatusCockpitInputRefs(
  group: PlatformOperatorStatusBlockingGroup,
): PlatformOperatorStatusCockpitInputRef[] {
  const targetInputRefs = group.targetInputRefs ?? [];
  const targetInputFilePresent = targetInputRefs.some((ref) => ref.present === true);
  return [
    ...targetInputRefs.map((ref) => ({ kind: "target-input-file" as const, ...ref })),
    ...(targetInputFilePresent ? [] : (group.targetEnvRefs ?? []).map((ref) => ({ kind: "target-env" as const, ...ref }))),
    ...(group.serverEnvRefs ?? []).map((ref) => ({ kind: "server-env" as const, ...ref })),
    ...(group.envRefs ?? []).map((ref) => ({
      kind: "operator-env" as const,
      ...ref,
    })),
    ...(group.githubTargetRefs ?? []).map((ref) => ({ kind: "github-target" as const, ...ref })),
    ...(group.secretRefs ?? []).map((ref) => ({ kind: "github-secret" as const, ...ref })),
  ];
}

function platformOperatorStatusBlockingGroup(
  id: string,
  missing: string[],
  nextActions: string[],
  commandRefs: Array<PlatformOperatorStatusCommandRef | undefined> = [],
  envRefs: PlatformOperatorStatusEnvRef[] = [],
  secretRefs: PlatformOperatorStatusSecretRef[] = [],
  serverEnvRefs: PlatformOperatorStatusServerEnvRef[] = [],
  targetEnvRefs: PlatformOperatorStatusTargetEnvRef[] = [],
  githubTargetRefs: PlatformOperatorStatusGithubTargetRef[] = [],
  targetInputRefs: PlatformOperatorStatusTargetInputRef[] = [],
): PlatformOperatorStatusBlockingGroup {
  const uniqueMissing = Array.from(new Set(missing));
  const uniqueNextActions = Array.from(new Set(nextActions));
  const uniqueCommandRefs = platformOperatorStatusUniqueCommandRefs(commandRefs);
  const uniqueEnvRefs = platformOperatorStatusUniqueEnvRefs(envRefs);
  const uniqueSecretRefs = platformOperatorStatusUniqueSecretRefs(secretRefs);
  const uniqueGithubTargetRefs = platformOperatorStatusUniqueGithubTargetRefs(githubTargetRefs);
  const uniqueServerEnvRefs = platformOperatorStatusUniqueServerEnvRefs(serverEnvRefs);
  const uniqueTargetEnvRefs = platformOperatorStatusUniqueTargetEnvRefs(targetEnvRefs);
  const uniqueTargetInputRefs = platformOperatorStatusUniqueTargetInputRefs(targetInputRefs);
  return {
    id,
    ok: uniqueMissing.length === 0,
    missing: uniqueMissing,
    nextActions: uniqueNextActions,
    ...(uniqueCommandRefs.length ? { commandRefs: uniqueCommandRefs } : {}),
    ...(uniqueEnvRefs.length ? { envRefs: uniqueEnvRefs } : {}),
    ...(uniqueSecretRefs.length ? { secretRefs: uniqueSecretRefs } : {}),
    ...(uniqueGithubTargetRefs.length ? { githubTargetRefs: uniqueGithubTargetRefs } : {}),
    ...(uniqueServerEnvRefs.length ? { serverEnvRefs: uniqueServerEnvRefs } : {}),
    ...(uniqueTargetEnvRefs.length ? { targetEnvRefs: uniqueTargetEnvRefs } : {}),
    ...(uniqueTargetInputRefs.length ? { targetInputRefs: uniqueTargetInputRefs } : {}),
  };
}

function platformOperatorStatusExternalTargetCommandRefs(
  targetPlan: Record<string, unknown> | undefined,
  targetInputRefs: PlatformOperatorStatusTargetInputRef[],
  targetsApplyOk: boolean,
): PlatformOperatorStatusCommandRef[] {
  const inputFileReady = targetInputRefs.some((ref) => ref.present === true);
  const operatorApplyInputCommandRef = platformOperatorStatusTargetInputApplyCommandRef(targetInputRefs);
  const targetInputAwareCommandFields: Array<[string, string]> = [
    ["staging-targets-env-check", "envValidationCommandArgs"],
    ["staging-targets-apply", "applyCommandArgs"],
    ["real-staging-targets-check", "realTargetsCheckCommandArgs"],
    ["bundle-refresh", "bundleRefreshCommandArgs"],
    ["staging-prerequisites", "prerequisitesCommandArgs"],
  ];
  const commandFields: Array<[string, string]> = targetsApplyOk
    ? [
      ["bundle-refresh", "bundleRefreshCommandArgs"],
      ["staging-prerequisites", "prerequisitesCommandArgs"],
    ]
    : targetInputRefs.length > 0
    ? targetInputAwareCommandFields
    : inputFileReady
    ? [
      ["staging-targets-apply-input", "applyInputCommandArgs"],
      ["staging-targets-env-check", "envValidationCommandArgs"],
      ["staging-targets-apply", "applyCommandArgs"],
      ["real-staging-targets-check", "realTargetsCheckCommandArgs"],
      ["bundle-refresh", "bundleRefreshCommandArgs"],
      ["staging-prerequisites", "prerequisitesCommandArgs"],
    ]
    : [
      ["staging-targets-env-check", "envValidationCommandArgs"],
      ["staging-targets-apply", "applyCommandArgs"],
      ["staging-targets-apply-input", "applyInputCommandArgs"],
      ["real-staging-targets-check", "realTargetsCheckCommandArgs"],
      ["bundle-refresh", "bundleRefreshCommandArgs"],
      ["staging-prerequisites", "prerequisitesCommandArgs"],
    ];
  return platformOperatorStatusUniqueCommandRefs([
    ...(targetsApplyOk || targetInputRefs.length === 0 ? [] : [operatorApplyInputCommandRef]),
    ...platformOperatorStatusReportCommandRefs(targetPlan, commandFields),
  ]);
}

function platformOperatorStatusTargetInputRefs(
  dir: string,
  targetPlan: Record<string, unknown> | undefined,
  repoRootArg: string | undefined,
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
  options: {
    requireExternalStaging: boolean;
    requireOperatorApprovals: boolean;
    requireAgentGitService: boolean;
  },
): PlatformOperatorStatusTargetInputRef[] {
  const inputTemplatePath = platformOperatorStatusString(targetPlan?.inputTemplatePath);
  if (!inputTemplatePath) return [];
  const inputTemplate = platformOperatorStatusRecord(targetPlan?.inputTemplate);
  const inputFile = platformOperatorStatusTargetInputFile(inputTemplatePath);
  const applyInputCommandArgs = platformOperatorStatusRealStagingTargetsApplyCommandArgs(
    dir,
    repoRootArg,
    githubTarget,
    options,
    inputFile?.sha256,
  );
  return [{
    name: basename(inputTemplatePath),
    target: "external-staging-targets",
    required: true,
    present: inputFile?.ok === true,
    inputTemplatePath,
    ...(inputTemplate ? { inputTemplate } : {}),
    ...(inputFile ? { inputFile } : {}),
    ...(applyInputCommandArgs.length ? { applyInputCommandArgs } : {}),
  }];
}

function platformOperatorStatusTargetInputApplyCommandRef(
  targetInputRefs: PlatformOperatorStatusTargetInputRef[],
): PlatformOperatorStatusCommandRef | undefined {
  const applyInputCommandArgs = targetInputRefs.find((ref) => (ref.applyInputCommandArgs?.length ?? 0) > 0)?.applyInputCommandArgs ?? [];
  return platformOperatorStatusCommandRef("operator-real-staging-targets-apply", applyInputCommandArgs);
}

function platformOperatorStatusRealStagingTargetsApplyCommandArgs(
  dir: string,
  repoRootArg: string | undefined,
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
  options: {
    requireExternalStaging: boolean;
    requireOperatorApprovals: boolean;
    requireAgentGitService: boolean;
  },
  expectedInputSha256: string | undefined,
): string[] {
  return [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-operator-real-staging-targets-apply",
    "--dir",
    dir,
    ...(repoRootArg ? ["--repo-root", repoRootArg] : []),
    ...platformOperatorStatusGithubTargetArgs(githubTarget),
    ...(expectedInputSha256 ? ["--expected-input-sha256", expectedInputSha256] : []),
    ...(options.requireExternalStaging ? ["--require-external-staging"] : []),
    ...(options.requireOperatorApprovals ? ["--require-operator-approvals"] : []),
    ...(options.requireAgentGitService ? ["--require-agent-git-service"] : []),
    "--auto-refresh-bundle",
    "--report",
    join(dir, "reports", "operator-real-staging-targets-apply.json"),
  ];
}

function platformOperatorStatusTargetInputFile(path: string): PlatformOperatorStatusTargetInputFileSummary {
  if (!existsSync(path)) {
    return {
      exists: false,
      ok: false,
      gates: {
        schemaVersionOk: false,
        requiredFieldsPresent: false,
        formatsOk: false,
        placeholdersAbsent: false,
      },
      missing: ["inputFile"],
    };
  }
  try {
    const text = readFileSync(path, "utf8");
    const value = platformOperatorStatusRecord(JSON.parse(text) as unknown);
    const targets = platformOperatorStatusRecord(value?.targets);
    const fields = {
      modelGatewayBaseUrl: platformOperatorStatusString(targets?.modelGatewayBaseUrl)?.trim() ?? "",
      agentGitServiceBaseUrl: platformOperatorStatusString(targets?.agentGitServiceBaseUrl)?.trim() ?? "",
      agentGitServiceIssue: platformOperatorStatusString(targets?.agentGitServiceIssue)?.trim() ?? "",
      agentGitServiceRepo: platformOperatorStatusString(targets?.agentGitServiceRepo)?.trim() ?? "",
      agentGitServiceNativeWriteAttachmentUrl: platformOperatorStatusString(targets?.agentGitServiceNativeWriteAttachmentUrl)?.trim() ?? "",
    };
    const missingRequired = Object.entries(fields)
      .filter(([, value]) => value === "")
      .map(([name]) => `targets.${name}`);
    const formatChecks = {
      modelGatewayBaseUrl: platformOperatorStatusTargetInputUrlOk(fields.modelGatewayBaseUrl),
      agentGitServiceBaseUrl: platformOperatorStatusTargetInputUrlOk(fields.agentGitServiceBaseUrl),
      agentGitServiceIssue: /^([^/\s]+)\/([^#\s]+)#\d+$/.test(fields.agentGitServiceIssue),
      agentGitServiceRepo: /^([^/\s]+)\/([^/\s#]+)$/.test(fields.agentGitServiceRepo),
      agentGitServiceNativeWriteAttachmentUrl: platformOperatorStatusTargetInputUrlOk(fields.agentGitServiceNativeWriteAttachmentUrl),
    };
    const missingFormats = Object.entries(formatChecks)
      .filter(([, ok]) => !ok)
      .map(([name]) => `formats.${name}`);
    const placeholderChecks = {
      modelGatewayBaseUrl: !platformOperatorStatusTargetInputPlaceholderUrl(fields.modelGatewayBaseUrl),
      agentGitServiceBaseUrl: !platformOperatorStatusTargetInputPlaceholderUrl(fields.agentGitServiceBaseUrl),
      agentGitServiceIssue: !platformOperatorStatusTargetInputPlaceholderIssue(fields.agentGitServiceIssue),
      agentGitServiceRepo: !platformOperatorStatusTargetInputPlaceholderRepo(fields.agentGitServiceRepo),
      agentGitServiceNativeWriteAttachmentUrl: !platformOperatorStatusTargetInputPlaceholderUrl(fields.agentGitServiceNativeWriteAttachmentUrl),
    };
    const missingPlaceholders = Object.entries(placeholderChecks)
      .filter(([, ok]) => !ok)
      .map(([name]) => `placeholders.${name}`);
    const gates = {
      schemaVersionOk: value?.schemaVersion === "platform-staging-targets-input/v1",
      requiredFieldsPresent: missingRequired.length === 0,
      formatsOk: missingFormats.length === 0,
      placeholdersAbsent: missingPlaceholders.length === 0,
    };
    const missing = [
      ...(gates.schemaVersionOk ? [] : ["schemaVersion"]),
      ...missingRequired,
      ...missingFormats,
      ...missingPlaceholders,
    ];
    return {
      exists: true,
      ok: missing.length === 0,
      sha256: sha256Hex(text),
      gates,
      missing,
    };
  } catch {
    return {
      exists: true,
      ok: false,
      gates: {
        schemaVersionOk: false,
        requiredFieldsPresent: false,
        formatsOk: false,
        placeholdersAbsent: false,
      },
      missing: ["inputFile.json"],
    };
  }
}

function platformOperatorStatusTargetInputUrlOk(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function platformOperatorStatusTargetInputPlaceholderUrl(value: string): boolean {
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

function platformOperatorStatusTargetInputPlaceholderIssue(value: string): boolean {
  const match = /^([^/\s]+)\/([^#\s]+)#\d+$/.exec(value.trim());
  return match ? platformOperatorStatusTargetInputPlaceholderRepo(`${match[1]}/${match[2]}`) : false;
}

function platformOperatorStatusTargetInputPlaceholderRepo(value: string): boolean {
  return [
    "org/repo",
    "owner/repo",
    "team/app",
    "team/loom",
    "team/loom-smoke",
  ].includes(value.trim().toLowerCase());
}

function platformOperatorStatusTargetEnvRefs(
  targetPlan: Record<string, unknown> | undefined,
  targetsEnvCheck: Record<string, unknown> | undefined,
): PlatformOperatorStatusTargetEnvRef[] {
  const missingNames = new Set(platformOperatorStatusArray(targetsEnvCheck?.missing)
    .filter((item) => item.startsWith("env."))
    .map((item) => item.slice("env.".length)));
  const placeholderTargets = new Set(platformOperatorStatusArray(targetPlan?.placeholderTargets));
  const envCheckShellCommands = platformOperatorStatusArray(targetPlan?.envCheckShellCommands);
  return platformOperatorStatusArray(targetPlan?.requiredEnvNames)
    .map((name) => platformOperatorStatusTargetEnvRef(name, missingNames, placeholderTargets, envCheckShellCommands))
    .filter((ref): ref is PlatformOperatorStatusTargetEnvRef => ref !== undefined);
}

function platformOperatorStatusTargetEnvRef(
  name: string,
  missingNames: Set<string>,
  placeholderTargets: Set<string>,
  envCheckShellCommands: string[],
): PlatformOperatorStatusTargetEnvRef | undefined {
  const target = platformOperatorStatusReplacementTarget(name);
  if (!target) return undefined;
  const placeholderTarget = platformOperatorStatusReplacementPlaceholderTarget(name);
  return {
    name,
    target,
    required: true,
    present: !missingNames.has(name),
    ...(placeholderTarget && placeholderTargets.has(placeholderTarget) ? { placeholderTarget } : {}),
    ...(platformOperatorStatusEnvCheckShellCommand(name, envCheckShellCommands)
      ? { envCheckShellCommand: platformOperatorStatusEnvCheckShellCommand(name, envCheckShellCommands) }
      : {}),
  };
}

function platformOperatorStatusReplacementTarget(name: string): string | undefined {
  return {
    LOOM_REAL_MODEL_BASE_URL: "modelGateway.baseUrl",
    LOOM_REAL_AGS_BASE_URL: "controlPlane.baseUrl",
    LOOM_REAL_AGS_ISSUE: "agentGitServiceStaging.issue",
    LOOM_REAL_AGS_REPO: "agentGitServiceStaging.repo",
    LOOM_REAL_AGS_NATIVE_WRITE_ATTACHMENT_URL: "agentGitServiceStaging.nativeWriteAttachmentUrl",
  }[name];
}

function platformOperatorStatusReplacementPlaceholderTarget(name: string): string | undefined {
  return {
    LOOM_REAL_MODEL_BASE_URL: "targets.modelGateway.placeholder",
    LOOM_REAL_AGS_BASE_URL: "targets.controlPlane.placeholder",
    LOOM_REAL_AGS_ISSUE: "targets.agentGitServiceStaging.issue.placeholder",
    LOOM_REAL_AGS_REPO: "targets.agentGitServiceStaging.repo.placeholder",
    LOOM_REAL_AGS_NATIVE_WRITE_ATTACHMENT_URL: "targets.agentGitServiceStaging.nativeWriteAttachmentUrl.placeholder",
  }[name];
}

function platformOperatorStatusAgentGitServiceServerEnvRefs(
  serverEnvPlan: Record<string, unknown> | undefined,
  upstreamMissing: string[],
): PlatformOperatorStatusServerEnvRef[] {
  const missingNames = new Set(upstreamMissing
    .filter((item) => item.startsWith("upstreamAgentGitService.requiredServerEnv."))
    .map((item) => item.slice("upstreamAgentGitService.requiredServerEnv.".length)));
  const requiredNames = platformOperatorStatusArray(serverEnvPlan?.requiredServerEnvNames);
  const names = requiredNames.length > 0 ? requiredNames : [...missingNames];
  const envCheckShellCommands = platformOperatorStatusArray(serverEnvPlan?.envCheckShellCommands);
  return names.map((name) => ({
    name,
    provider: "agent-git-service" as const,
    required: true as const,
    present: !missingNames.has(name),
    ...(platformOperatorStatusEnvCheckShellCommand(name, envCheckShellCommands)
      ? { envCheckShellCommand: platformOperatorStatusEnvCheckShellCommand(name, envCheckShellCommands) }
      : {}),
  }));
}

function platformOperatorStatusEnvCheckShellCommand(name: string, commands: string[]): string | undefined {
  return commands.find((command) => command.includes(`\${${name}:?`) || command.includes(`missing ${name}`));
}

function platformOperatorStatusGithubActionsSecretRefs(
  preflight: PlatformOperatorStatusCiHandoff["preflight"]["report"],
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
): PlatformOperatorStatusSecretRef[] {
  const present = new Set(preflight.presentRequiredSecretEnvNames ?? []);
  const missing = new Set(preflight.missingRequiredSecretEnvNames ?? []);
  const setCommandArgsByName = new Map<string, string[]>();
  for (const commandArgs of preflight.setMissingRequiredSecretCommandArgs ?? []) {
    const name = platformOperatorStatusGithubSecretSetName(commandArgs);
    if (name) setCommandArgsByName.set(name, platformOperatorStatusGithubSecretSetCommandArgs(commandArgs, githubTarget));
  }
  return (preflight.requiredSecretEnvNames ?? []).map((name) => ({
    name,
    provider: "github-actions" as const,
    required: true as const,
    present: present.has(name) || !missing.has(name),
    ...(missing.has(name) && platformOperatorStatusShellEnvName(name) ? { envCheckShellCommand: platformOperatorStatusShellEnvCheckCommand(name) } : {}),
    ...(setCommandArgsByName.has(name) ? { setCommandArgs: setCommandArgsByName.get(name) } : {}),
  }));
}

function platformOperatorStatusGithubTargetRefs(
  ciHandoff: PlatformOperatorStatusCiHandoff,
): PlatformOperatorStatusGithubTargetRef[] {
  const missing = new Set(ciHandoff.preflight.report.missing ?? []);
  const fields = ciHandoff.preflight.report.repoDiscoveryFields ?? {};
  const inputTemplate = platformOperatorStatusGithubTargetInputTemplate(ciHandoff.preflight.report);
  const includeRepo = Boolean(ciHandoff.githubTarget.repo || missing.has("github.repository") || fields.repo);
  const includeRef = Boolean(ciHandoff.githubTarget.ref || missing.has("github.ref") || fields.ref);
  return [
    ...(includeRepo ? [{
      name: "repo" as const,
      target: "github.repository" as const,
      required: true as const,
      present: Boolean(ciHandoff.githubTarget.repo),
      ...(fields.repo ? { discoveryField: fields.repo } : {}),
      inputHint: "--repo <owner/repo>",
      ...inputTemplate,
    }] : []),
    ...(includeRef ? [{
      name: "ref" as const,
      target: "github.ref" as const,
      required: true as const,
      present: Boolean(ciHandoff.githubTarget.ref),
      ...(fields.ref ? { discoveryField: fields.ref } : {}),
      inputHint: "--ref <branch>",
      ...inputTemplate,
    }] : []),
  ];
}

function platformOperatorStatusGithubTargetInputTemplate(
  preflight: PlatformOperatorStatusCiHandoff["preflight"]["report"],
): Pick<PlatformOperatorStatusGithubTargetRef, "inputTemplatePath" | "inputTemplate"> {
  return {
    ...(preflight.targetInputTemplatePath ? { inputTemplatePath: preflight.targetInputTemplatePath } : {}),
    ...(preflight.targetInputTemplate ? { inputTemplate: preflight.targetInputTemplate } : {}),
  };
}

function platformOperatorStatusPreflightRepoDiscoveryCommandRef(
  preflight: PlatformOperatorStatusCiHandoff["preflight"]["report"],
): PlatformOperatorStatusCommandRef | undefined {
  return platformOperatorStatusCommandRef(
    "ci-repo-discovery",
    preflight.repoDiscoveryCommandArgs ?? [],
    preflight.repoDiscoveryCwd,
  );
}

function platformOperatorStatusGithubSecretSetName(commandArgs: string[]): string | undefined {
  const secretIndex = commandArgs.findIndex((arg, index) =>
    index > 0 && commandArgs[index - 1] === "secret" && arg === "set"
  );
  const name = secretIndex >= 0 ? commandArgs[secretIndex + 1] : undefined;
  return name && !name.startsWith("-") ? name : undefined;
}

function platformOperatorStatusGithubSecretSetCommandArgs(
  commandArgs: string[],
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
): string[] {
  if (!githubTarget.repo || commandArgs.includes("--repo")) return commandArgs;
  return [...commandArgs, "--repo", githubTarget.repo];
}

function platformOperatorStatusEnvRefs(
  stagingPrerequisites: Record<string, unknown> | undefined,
  names: string[],
): PlatformOperatorStatusEnvRef[] {
  const nameSet = new Set(names);
  const env = platformOperatorStatusRecord(stagingPrerequisites?.env);
  const missing = Array.isArray(env?.missing) ? env.missing : [];
  return missing
    .map(platformOperatorStatusEnvRef)
    .filter((ref): ref is PlatformOperatorStatusEnvRef => ref !== undefined && nameSet.has(ref.name));
}

function platformOperatorStatusEnvRef(value: unknown): PlatformOperatorStatusEnvRef | undefined {
  const record = platformOperatorStatusRecord(value);
  const name = platformOperatorStatusString(record?.name);
  if (!name) return undefined;
  const uses = Array.isArray(record?.uses)
    ? record.uses.map(platformOperatorStatusEnvUseRef).filter((use): use is PlatformOperatorStatusEnvUseRef => use !== undefined)
    : [];
  return {
    name,
    required: true as const,
    present: false as const,
    requiredFor: platformOperatorStatusArray(record?.requiredFor),
    uses,
    ...(platformOperatorStatusShellEnvName(name) ? { envCheckShellCommand: platformOperatorStatusShellEnvCheckCommand(name) } : {}),
  };
}

function platformOperatorStatusShellEnvName(name: string): boolean {
  return /^[_A-Za-z][_A-Za-z0-9]*$/.test(name);
}

function platformOperatorStatusShellEnvCheckCommand(name: string): string {
  return `: "\${${name}:?missing ${name}}"`;
}

function platformOperatorStatusEnvUseRef(value: unknown): PlatformOperatorStatusEnvUseRef | undefined {
  const record = platformOperatorStatusRecord(value);
  if (!record) return undefined;
  const ref: PlatformOperatorStatusEnvUseRef = {
    ...(platformOperatorStatusString(record.sourceFlag) ? { sourceFlag: platformOperatorStatusString(record.sourceFlag) } : {}),
    ...(platformOperatorStatusString(record.purpose) ? { purpose: platformOperatorStatusString(record.purpose) } : {}),
    ...(platformOperatorStatusString(record.tenant) ? { tenant: platformOperatorStatusString(record.tenant) } : {}),
    ...(platformOperatorStatusString(record.actor) ? { actor: platformOperatorStatusString(record.actor) } : {}),
    ...(platformOperatorStatusString(record.role) ? { role: platformOperatorStatusString(record.role) } : {}),
  };
  return Object.keys(ref).length > 0 ? ref : undefined;
}

function platformOperatorStatusUniqueEnvRefs(envRefs: PlatformOperatorStatusEnvRef[]): PlatformOperatorStatusEnvRef[] {
  const seen = new Set<string>();
  const unique = [];
  for (const ref of envRefs) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    unique.push(ref);
  }
  return unique;
}

function platformOperatorStatusUniqueSecretRefs(secretRefs: PlatformOperatorStatusSecretRef[]): PlatformOperatorStatusSecretRef[] {
  const seen = new Set<string>();
  const unique = [];
  for (const ref of secretRefs) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    unique.push(ref);
  }
  return unique;
}

function platformOperatorStatusUniqueGithubTargetRefs(githubTargetRefs: PlatformOperatorStatusGithubTargetRef[]): PlatformOperatorStatusGithubTargetRef[] {
  const seen = new Set<string>();
  const unique = [];
  for (const ref of githubTargetRefs) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    unique.push(ref);
  }
  return unique;
}

function platformOperatorStatusUniqueServerEnvRefs(serverEnvRefs: PlatformOperatorStatusServerEnvRef[]): PlatformOperatorStatusServerEnvRef[] {
  const seen = new Set<string>();
  const unique = [];
  for (const ref of serverEnvRefs) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    unique.push(ref);
  }
  return unique;
}

function platformOperatorStatusUniqueTargetEnvRefs(targetEnvRefs: PlatformOperatorStatusTargetEnvRef[]): PlatformOperatorStatusTargetEnvRef[] {
  const seen = new Set<string>();
  const unique = [];
  for (const ref of targetEnvRefs) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    unique.push(ref);
  }
  return unique;
}

function platformOperatorStatusUniqueTargetInputRefs(targetInputRefs: PlatformOperatorStatusTargetInputRef[]): PlatformOperatorStatusTargetInputRef[] {
  const seen = new Set<string>();
  const unique = [];
  for (const ref of targetInputRefs) {
    if (seen.has(ref.inputTemplatePath)) continue;
    seen.add(ref.inputTemplatePath);
    unique.push(ref);
  }
  return unique;
}

function platformOperatorStatusReportCommandRefs(
  report: Record<string, unknown> | undefined,
  specs: Array<[label: string, key: string]>,
): PlatformOperatorStatusCommandRef[] {
  return specs
    .map(([label, key]) => platformOperatorStatusCommandRef(label, platformOperatorStatusCommandArgs(report?.[key])))
    .filter((ref): ref is PlatformOperatorStatusCommandRef => ref !== undefined);
}

function platformOperatorStatusCommandRef(
  label: string,
  commandArgs: string[],
  cwd?: string,
): PlatformOperatorStatusCommandRef | undefined {
  return commandArgs.length > 0
    ? {
        label,
        command: platformOperatorStatusShellCommand(commandArgs),
        commandArgs,
        ...(cwd ? { cwd } : {}),
      }
    : undefined;
}

function platformOperatorStatusShellCommandRef(
  label: string,
  command: string | undefined,
): PlatformOperatorStatusCommandRef | undefined {
  return command
    ? {
        label,
        command,
        commandArgs: ["sh", "-lc", command],
      }
    : undefined;
}

function platformOperatorStatusCommandArgs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((arg): arg is string => typeof arg === "string") : [];
}

function platformOperatorStatusCommandFlagValue(commandArgs: string[], flag: string): string | undefined {
  const index = commandArgs.indexOf(flag);
  const value = index >= 0 ? commandArgs[index + 1] : undefined;
  return value && !value.startsWith("-") ? value : undefined;
}

function platformOperatorStatusUniqueCommandRefs(
  commandRefs: Array<PlatformOperatorStatusCommandRef | undefined>,
): PlatformOperatorStatusCommandRef[] {
  const seen = new Set<string>();
  const unique = [];
  for (const ref of commandRefs) {
    if (!ref) continue;
    const key = `${ref.label}\0${JSON.stringify(ref.commandArgs)}\0${ref.cwd ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

function platformOperatorStatusFilterReportNextActions(
  report: LoadedOperatorStatusReport | undefined,
  schemaVersion: string,
  label: string,
  patterns: string[],
): string[] {
  return platformOperatorStatusReportNextActions(report, schemaVersion, label)
    .filter((action) => patterns.some((pattern) => action.toLowerCase().includes(pattern.toLowerCase())));
}

function platformOperatorStatusMissingPreServeEvidenceReports(
  reports: Record<string, LoadedOperatorStatusReport>,
): string[] {
  return [
    reports.stagingRun,
    reports.stagingTargets,
    reports.stagingEvidence,
  ]
    .filter((report) => !report.exists)
    .map((report) => report.name);
}

function platformOperatorStatusExplicitGithubTarget(
  options: PlatformOperatorStatusCliOptions,
): PlatformOperatorStatusCiHandoff["githubTarget"] {
  return {
    ...(options.repo ? { repo: options.repo } : {}),
    ...(options.ref ? { ref: options.ref } : {}),
  };
}

function platformOperatorStatusGitRepoRoot(cwd: string): string | undefined {
  try {
    const output = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output ? resolve(output) : undefined;
  } catch {
    return undefined;
  }
}

function platformOperatorStatusCiHandoff(
  dir: string,
  repoRoot: string,
  repoRootArg: string | undefined,
  requireExternalStaging: boolean,
  workflowPhase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  installReport: LoadedOperatorStatusReport,
  preflightReport: LoadedOperatorStatusReport,
  handoffRunReport: LoadedOperatorStatusReport,
  runProof: LoadedOperatorStatusReport,
  workflowDispatchReport: LoadedOperatorStatusReport,
  workflowWaitReport: LoadedOperatorStatusReport,
  artifactImportReport: LoadedOperatorStatusReport,
  artifactSyncReport: LoadedOperatorStatusReport,
  explicitGithubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
): PlatformOperatorStatusCiHandoff {
  const githubActions = loadPlatformOperatorStatusText(dir, "github-actions-staging.yml");
  const externalSecrets = loadPlatformOperatorStatusJson(dir, "external-secrets.json");
  const externalSecretsRecord = platformOperatorStatusRecord(externalSecrets.value);
  const requiredEnvNames = platformOperatorStatusRequiredEnvNames(externalSecretsRecord?.requiredEnv);
  const externalSecretsTokenFree = externalSecretsRecord?.tokenFree === true;
  const concurrency = platformOperatorStatusWorkflowConcurrency(githubActions.text);
  const workflowDispatchInputs: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"] = {
    phase: workflowPhase,
    loom_bin: "loom",
    bundle_dir: PLATFORM_OPERATOR_STATUS_DEFAULT_BUNDLE_DIR,
    node_version: "22",
    bootstrap_source_tree: true,
  };
  const workflowInstall = platformOperatorStatusWorkflowInstall(
    dir,
    repoRoot,
    repoRootArg,
    workflowDispatchInputs.bundle_dir,
    githubActions.name,
    githubActions.sha256,
    installReport,
  );
  const handoffPreflightReport = platformOperatorStatusHandoffPreflightReport(preflightReport, dir);
  const githubTarget = platformOperatorStatusGithubTarget(handoffPreflightReport, explicitGithubTarget);
  const preflight = platformOperatorStatusHandoffPreflight(
    dir,
    repoRootArg,
    handoffPreflightReport,
    githubTarget,
    explicitGithubTarget,
  );
  const githubTargetInputPath = platformOperatorStatusGithubTargetCommandInputPath(preflight.report, explicitGithubTarget);
  const handoffRun = platformOperatorStatusHandoffRun(
    dir,
    repoRootArg,
    workflowDispatchInputs.phase,
    handoffRunReport,
    githubTarget,
    githubTargetInputPath,
  );
  const workflowDispatch = platformOperatorStatusWorkflowDispatch(
    dir,
    workflowDispatchInputs.phase,
    workflowDispatchReport,
    githubTarget,
  );
  const runProofRunId = platformOperatorStatusWorkflowRunReportRunId(runProof);
  const workflowWait = platformOperatorStatusWorkflowWait(
    dir,
    workflowDispatchInputs.phase,
    workflowDispatch.report.runId ?? runProofRunId,
    workflowWaitReport,
    githubTarget,
  );
  const expectedWorkflowRunId = workflowWait.report.runId ?? workflowDispatch.report.runId;
  const workflowRun = platformOperatorStatusWorkflowRun(
    dir,
    repoRootArg,
    workflowDispatchInputs.phase,
    githubActions.sha256,
    runProof,
    expectedWorkflowRunId,
  );
  const expectedArtifactRunId = workflowWait.report.runId ?? workflowDispatch.report.runId ?? workflowRun.report.runId;
  const artifactImport = platformOperatorStatusArtifactImport(
    dir,
    workflowDispatchInputs.phase,
    expectedArtifactRunId,
    artifactImportReport,
  );
  const artifactSync = platformOperatorStatusArtifactSync(
    dir,
    workflowDispatchInputs.phase,
    expectedArtifactRunId,
    artifactSyncReport,
    githubTarget,
  );
  const baseReady = githubActions.exists &&
    concurrency.ok &&
    workflowInstall.installed.matchesBundle &&
    workflowInstall.report.matchesBundle &&
    externalSecrets.exists &&
    externalSecretsTokenFree;
  return {
    provider: "github-actions",
    ready: baseReady && (!requireExternalStaging || workflowRun.report.matchesHandoff),
    githubTarget,
    githubActions: {
      fileName: githubActions.name,
      name: githubActions.text ? platformOperatorStatusWorkflowName(githubActions.text) : undefined,
      path: githubActions.path,
      exists: githubActions.exists,
      sha256: githubActions.sha256,
      concurrency,
    },
    externalSecrets: {
      name: externalSecrets.name,
      path: externalSecrets.path,
      exists: externalSecrets.exists,
      sha256: externalSecrets.sha256,
      schemaVersion: externalSecrets.schemaVersion,
      tokenFree: externalSecretsTokenFree,
      providerHint: platformOperatorStatusString(externalSecretsRecord?.providerHint),
      requiredEnvNames,
    },
    workflowDispatchInputs,
    workflowInstall,
    preflight,
    handoffRun,
    workflowRun,
    workflowDispatch,
    workflowWait,
    artifactImport,
    artifactSync,
    workflowDispatchCommand: "",
    workflowDispatchCommandArgs: [],
  };
}

function platformOperatorStatusWorkflowInstall(
  dir: string,
  repoRoot: string,
  repoRootArg: string | undefined,
  bundleDir: string,
  workflowFileName: string,
  bundleSha256: string | undefined,
  installReport: LoadedOperatorStatusReport,
): PlatformOperatorStatusCiHandoff["workflowInstall"] {
  const sourcePath = `${bundleDir}/${workflowFileName}`;
  const destinationPath = `${PLATFORM_OPERATOR_STATUS_GITHUB_ACTIONS_INSTALL_DIR}/${workflowFileName}`;
  const installedPath = resolve(repoRoot, destinationPath);
  const installed = platformOperatorStatusInstalledWorkflow(installedPath, bundleSha256);
  const installReportPath = join(dir, "reports", "ci-handoff-install.json");
  const report = platformOperatorStatusWorkflowInstallReport(installReport, installedPath, installed.sha256, bundleSha256);
  const installCommandArgs = [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-ci-handoff-install",
    "--dir",
    dir,
    ...(repoRootArg ? ["--repo-root", repoRootArg] : []),
    "--report",
    installReportPath,
  ];
  const commandSteps = [
    {
      command: `mkdir -p ${PLATFORM_OPERATOR_STATUS_GITHUB_ACTIONS_INSTALL_DIR}`,
      commandArgs: ["mkdir", "-p", PLATFORM_OPERATOR_STATUS_GITHUB_ACTIONS_INSTALL_DIR],
    },
    {
      command: `cp ${sourcePath} ${destinationPath}`,
      commandArgs: ["cp", sourcePath, destinationPath],
    },
  ];
  return {
    sourcePath,
    destinationPath,
    installed,
    report,
    command: commandSteps.map((step) => step.command).join(" && "),
    installCommand: platformOperatorStatusShellCommand(installCommandArgs),
    installCommandArgs,
    commandSteps,
  };
}

function platformOperatorStatusInstalledWorkflow(
  path: string,
  bundleSha256: string | undefined,
): PlatformOperatorStatusCiHandoff["workflowInstall"]["installed"] {
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      matchesBundle: false,
    };
  }
  const sha256 = sha256Hex(readFileSync(path, "utf8"));
  return {
    path,
    exists: true,
    sha256,
    matchesBundle: bundleSha256 !== undefined && sha256 === bundleSha256,
  };
}

function platformOperatorStatusWorkflowInstallReport(
  report: LoadedOperatorStatusReport,
  installedPath: string,
  installedSha256: string | undefined,
  bundleSha256: string | undefined,
): PlatformOperatorStatusCiHandoff["workflowInstall"]["report"] {
  const value = platformOperatorStatusRecord(report.value);
  const source = platformOperatorStatusRecord(value?.source);
  const destination = platformOperatorStatusRecord(value?.destination);
  const sourceSha256 = platformOperatorStatusString(source?.sha256);
  const destinationPath = platformOperatorStatusString(destination?.path);
  const destinationSha256 = platformOperatorStatusString(destination?.sha256);
  const matchesBundle = report.exists &&
    value?.schemaVersion === "platform-ci-handoff-install/v1" &&
    value.ok === true &&
    value.tokenFree === true &&
    sourceSha256 === bundleSha256 &&
    platformOperatorStatusSamePath(destinationPath, installedPath) &&
    destinationSha256 === bundleSha256 &&
    destinationSha256 === installedSha256 &&
    destination?.matchesBundle === true;
  return {
    name: report.name,
    path: report.path,
    exists: report.exists,
    ...(report.ok !== undefined ? { ok: report.ok } : {}),
    ...(report.schemaVersion ? { schemaVersion: report.schemaVersion } : {}),
    ...(report.sha256 ? { sha256: report.sha256 } : {}),
    ...(sourceSha256 ? { sourceSha256 } : {}),
    ...(destinationPath ? { destinationPath } : {}),
    ...(destinationSha256 ? { destinationSha256 } : {}),
    matchesBundle,
  };
}

function platformOperatorStatusHandoffPreflight(
  dir: string,
  repoRootArg: string | undefined,
  preflightReport: PlatformOperatorStatusCiHandoff["preflight"]["report"],
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
  explicitGithubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
): PlatformOperatorStatusCiHandoff["preflight"] {
  const reportPath = join(dir, "reports", "ci-handoff-preflight.json");
  const targetInputPath = platformOperatorStatusGithubTargetCommandInputPath(preflightReport, explicitGithubTarget);
  const commandArgs = platformOperatorStatusHandoffPreflightCommandArgs(dir, repoRootArg, reportPath, githubTarget, targetInputPath);
  return {
    report: preflightReport,
    command: platformOperatorStatusShellCommand(commandArgs),
    commandArgs,
  };
}

function platformOperatorStatusHandoffPreflightCommandArgs(
  dir: string,
  repoRootArg: string | undefined,
  reportPath: string,
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
  targetInputPath: string | undefined,
): string[] {
  return [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-ci-handoff-preflight",
    "--dir",
    dir,
    ...(repoRootArg ? ["--repo-root", repoRootArg] : []),
    ...platformOperatorStatusGithubTargetCommandArgs(githubTarget, targetInputPath),
    "--report",
    reportPath,
  ];
}

function platformOperatorStatusHandoffPreflightReport(
  report: LoadedOperatorStatusReport,
  dir: string,
): PlatformOperatorStatusCiHandoff["preflight"]["report"] {
  const value = platformOperatorStatusRecord(report.value);
  const repository = platformOperatorStatusRecord(value?.repository);
  const repositoryName = platformOperatorStatusString(repository?.nameWithOwner);
  const workflow = platformOperatorStatusString(value?.workflow);
  const secrets = platformOperatorStatusRecord(value?.secrets);
  const requiredSecretEnvNames = platformOperatorStatusArray(secrets?.requiredEnvNames);
  const presentRequiredSecretEnvNames = platformOperatorStatusArray(secrets?.presentRequiredEnvNames);
  const missingRequiredSecretEnvNames = platformOperatorStatusArray(secrets?.missingRequiredEnvNames);
  const setMissingRequiredSecretCommandArgs = platformOperatorStatusStringArrayArray(secrets?.setMissingRequiredCommandArgs);
  const targetInputSource = platformOperatorStatusString(value?.targetInputSource);
  const targetInputPath = platformOperatorStatusString(value?.targetInputPath);
  const targetInputSha256 = platformOperatorStatusString(value?.targetInputSha256);
  const defaultTargetInputPath = join(dir, "github-actions-target.input.json");
  const targetInputTemplatePath = platformOperatorStatusString(value?.targetInputTemplatePath) ?? (existsSync(defaultTargetInputPath) ? defaultTargetInputPath : undefined);
  const targetInputTemplate = platformOperatorStatusTargetInputTemplate(value?.targetInputTemplate);
  const savedTargetInput = platformOperatorStatusGithubTargetInputFile(targetInputTemplatePath);
  const reportRepo = platformOperatorStatusString(value?.repo);
  const reportRef = platformOperatorStatusString(value?.ref) ?? platformOperatorStatusString(repository?.defaultBranch);
  const repo = savedTargetInput?.repo ?? reportRepo;
  const ref = savedTargetInput?.ref ?? reportRef;
  const repoDiscoveryCommandArgs = platformOperatorStatusCommandArgs(value?.repoDiscoveryCommandArgs);
  const repoDiscoveryCwd = platformOperatorStatusString(value?.repoDiscoveryCwd);
  const repoDiscoveryFields = platformOperatorStatusRepoDiscoveryFields(value?.repoDiscoveryFields);
  const missing = platformOperatorStatusArray(value?.missing).filter((item) =>
    !((repo && item === "github.repository") || (ref && item === "github.ref"))
  );
  const nextActions = platformOperatorStatusArray(value?.nextActions);
  return {
    name: report.name,
    path: report.path,
    exists: report.exists,
    ...(report.ok !== undefined ? { ok: report.ok } : {}),
    ...(report.schemaVersion ? { schemaVersion: report.schemaVersion } : {}),
    ...(report.sha256 ? { sha256: report.sha256 } : {}),
    ...(repositoryName ? { repository: repositoryName } : {}),
    ...(workflow ? { workflow } : {}),
    ...(requiredSecretEnvNames.length ? { requiredSecretEnvNames } : {}),
    ...(presentRequiredSecretEnvNames.length ? { presentRequiredSecretEnvNames } : {}),
    ...(missingRequiredSecretEnvNames.length ? { missingRequiredSecretEnvNames } : {}),
    ...(setMissingRequiredSecretCommandArgs.length ? { setMissingRequiredSecretCommandArgs } : {}),
    ...(repo ? { repo } : {}),
    ...(ref ? { ref } : {}),
    ...(savedTargetInput ? { targetInputSource: "target-file" } : targetInputSource ? { targetInputSource } : {}),
    ...(savedTargetInput?.path ? { targetInputPath: savedTargetInput.path } : targetInputPath ? { targetInputPath } : {}),
    ...(savedTargetInput?.sha256 ? { targetInputSha256: savedTargetInput.sha256 } : targetInputSha256 ? { targetInputSha256 } : {}),
    ...(targetInputTemplatePath ? { targetInputTemplatePath } : {}),
    ...(targetInputTemplate ? { targetInputTemplate } : {}),
    ...(repoDiscoveryCommandArgs.length ? { repoDiscoveryCommandArgs } : {}),
    ...(repoDiscoveryCwd ? { repoDiscoveryCwd } : {}),
    ...(repoDiscoveryFields ? { repoDiscoveryFields } : {}),
    ...(missing.length ? { missing } : {}),
    ...(nextActions.length ? { nextActions } : {}),
  };
}

function platformOperatorStatusGithubTargetInputFile(path: string | undefined): { path: string; sha256: string; repo?: string; ref?: string } | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf8");
    const value = platformOperatorStatusRecord(JSON.parse(text) as unknown);
    if (value?.schemaVersion !== "platform-ci-target-input/v1") return undefined;
    const repo = platformOperatorStatusString(value.repo);
    const ref = platformOperatorStatusString(value.ref);
    if (!repo && !ref) return undefined;
    return {
      path,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      ...(repo ? { repo } : {}),
      ...(ref ? { ref } : {}),
    };
  } catch {
    return undefined;
  }
}

function platformOperatorStatusTargetInputTemplate(value: unknown): { schemaVersion?: string; repo?: string; ref?: string } | undefined {
  const template = platformOperatorStatusRecord(value);
  const schemaVersion = platformOperatorStatusString(template?.schemaVersion);
  const repo = platformOperatorStatusString(template?.repo);
  const ref = platformOperatorStatusString(template?.ref);
  if (!schemaVersion && !repo && !ref) return undefined;
  return {
    ...(schemaVersion ? { schemaVersion } : {}),
    ...(repo ? { repo } : {}),
    ...(ref ? { ref } : {}),
  };
}

function platformOperatorStatusRepoDiscoveryFields(value: unknown): { repo?: string; ref?: string } | undefined {
  const fields = platformOperatorStatusRecord(value);
  const repo = platformOperatorStatusString(fields?.repo);
  const ref = platformOperatorStatusString(fields?.ref);
  if (!repo && !ref) return undefined;
  return {
    ...(repo ? { repo } : {}),
    ...(ref ? { ref } : {}),
  };
}

function platformOperatorStatusGithubTarget(
  preflight: PlatformOperatorStatusCiHandoff["preflight"]["report"],
  explicitTarget: PlatformOperatorStatusCiHandoff["githubTarget"] = {},
): PlatformOperatorStatusCiHandoff["githubTarget"] {
  const repo = explicitTarget.repo ?? preflight.repo ?? preflight.repository;
  const ref = explicitTarget.ref ?? preflight.ref;
  return {
    ...(repo ? { repo } : {}),
    ...(ref ? { ref } : {}),
  };
}

function platformOperatorStatusGithubTargetArgs(
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
): string[] {
  return [
    ...platformOperatorStatusGithubRepoArgs(githubTarget),
    ...platformOperatorStatusGithubRefArgs(githubTarget),
  ];
}

function platformOperatorStatusGithubTargetCommandArgs(
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
  targetInputPath: string | undefined,
): string[] {
  return targetInputPath ? ["--target", targetInputPath] : platformOperatorStatusGithubTargetArgs(githubTarget);
}

function platformOperatorStatusGithubTargetCommandInputPath(
  preflight: PlatformOperatorStatusCiHandoff["preflight"]["report"],
  explicitGithubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
): string | undefined {
  if (explicitGithubTarget.repo || explicitGithubTarget.ref) return undefined;
  return preflight.targetInputPath;
}

function platformOperatorStatusGithubRepoArgs(
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
): string[] {
  return githubTarget.repo ? ["--repo", githubTarget.repo] : [];
}

function platformOperatorStatusGithubRefArgs(
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
): string[] {
  return githubTarget.ref ? ["--ref", githubTarget.ref] : [];
}

function platformOperatorStatusHandoffRun(
  dir: string,
  repoRootArg: string | undefined,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  report: LoadedOperatorStatusReport,
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
  targetInputPath: string | undefined,
): PlatformOperatorStatusCiHandoff["handoffRun"] {
  const reportPath = join(dir, "reports", "ci-handoff-run.json");
  const commandArgs = platformOperatorStatusHandoffRunCommandArgs(dir, repoRootArg, phase, reportPath, githubTarget, targetInputPath);
  return {
    report: platformOperatorStatusHandoffRunReport(report),
    command: platformOperatorStatusShellCommand(commandArgs),
    commandArgs,
  };
}

function platformOperatorStatusHandoffRunCommandArgs(
  dir: string,
  repoRootArg: string | undefined,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  reportPath: string,
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
  targetInputPath: string | undefined,
): string[] {
  return [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-ci-handoff-run",
    "--dir",
    dir,
    ...(repoRootArg ? ["--repo-root", repoRootArg] : []),
    ...platformOperatorStatusGithubTargetCommandArgs(githubTarget, targetInputPath),
    "--phase",
    phase,
    "--preflight",
    "--report",
    reportPath,
  ];
}

function platformOperatorStatusHandoffRunReport(
  report: LoadedOperatorStatusReport,
): PlatformOperatorStatusCiHandoff["handoffRun"]["report"] {
  const value = platformOperatorStatusRecord(report.value);
  const dispatch = platformOperatorStatusRecord(value?.workflowDispatch);
  const run = platformOperatorStatusRecord(dispatch?.run);
  const phase = platformOperatorStatusString(value?.phase);
  const runId = platformOperatorStatusString(run?.id);
  return {
    name: report.name,
    path: report.path,
    exists: report.exists,
    ...(report.ok !== undefined ? { ok: report.ok } : {}),
    ...(report.schemaVersion ? { schemaVersion: report.schemaVersion } : {}),
    ...(report.sha256 ? { sha256: report.sha256 } : {}),
    ...(phase ? { phase } : {}),
    ...(runId ? { runId } : {}),
  };
}

function platformOperatorStatusWorkflowRun(
  dir: string,
  repoRootArg: string | undefined,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  workflowSha256: string | undefined,
  runProof: LoadedOperatorStatusReport,
  expectedRunId: string | undefined,
): PlatformOperatorStatusCiHandoff["workflowRun"] {
  const reportPath = join(dir, "reports", "ci-run-proof.json");
  const commandArgs = platformOperatorStatusWorkflowRunCommandArgs(dir, repoRootArg, phase, reportPath);
  return {
    report: platformOperatorStatusWorkflowRunReport(runProof, workflowSha256, phase, expectedRunId),
    command: platformOperatorStatusShellCommand(commandArgs),
    commandArgs,
  };
}

function platformOperatorStatusWorkflowRunCommandArgs(
  dir: string,
  repoRootArg: string | undefined,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  reportPath: string,
): string[] {
  return [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-ci-run-proof",
    "--dir",
    dir,
    ...(repoRootArg ? ["--repo-root", repoRootArg] : []),
    "--phase",
    phase,
    "--status",
    "success",
    "--report",
    reportPath,
  ];
}

function platformOperatorStatusWorkflowRunReport(
  report: LoadedOperatorStatusReport,
  workflowSha256: string | undefined,
  expectedPhase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  expectedRunId: string | undefined,
): PlatformOperatorStatusCiHandoff["workflowRun"]["report"] {
  const value = platformOperatorStatusRecord(report.value);
  const workflow = platformOperatorStatusRecord(value?.workflow);
  const installedWorkflow = platformOperatorStatusRecord(value?.installedWorkflow);
  const install = platformOperatorStatusRecord(value?.installReport);
  const github = platformOperatorStatusRecord(value?.github);
  const gates = platformOperatorStatusRecord(value?.gates);
  const provider = platformOperatorStatusString(value?.provider);
  const phase = platformOperatorStatusString(value?.phase);
  const status = platformOperatorStatusString(value?.status);
  const runId = platformOperatorStatusString(github?.runId);
  const runUrl = platformOperatorStatusString(github?.runUrl);
  const runWorkflowSha256 = platformOperatorStatusString(workflow?.sha256);
  const installedWorkflowSha256 = platformOperatorStatusString(installedWorkflow?.sha256);
  const installReportSha256 = platformOperatorStatusString(install?.sha256);
  const runIdMatches = expectedRunId === undefined || runId === expectedRunId;
  const installReportMatchesWhenPresent = install?.exists !== true || (
    install?.ok === true &&
    platformOperatorStatusString(install?.sourceSha256) === workflowSha256 &&
    platformOperatorStatusString(install?.destinationSha256) === workflowSha256
  );
  const matchesHandoff = report.exists &&
    value?.schemaVersion === "platform-ci-run-proof/v1" &&
    value.ok === true &&
    value.tokenFree === true &&
    provider === "github-actions" &&
    phase === expectedPhase &&
    status === "success" &&
    github?.githubActions === true &&
    runIdMatches &&
    runWorkflowSha256 === workflowSha256 &&
    installedWorkflowSha256 === workflowSha256 &&
    installedWorkflow?.matchesBundle === true &&
    gates?.installedWorkflowOk === true &&
    gates.installReportOk === true &&
    installReportMatchesWhenPresent;
  return {
    name: report.name,
    path: report.path,
    exists: report.exists,
    ...(report.ok !== undefined ? { ok: report.ok } : {}),
    ...(report.schemaVersion ? { schemaVersion: report.schemaVersion } : {}),
    ...(report.sha256 ? { sha256: report.sha256 } : {}),
    ...(provider ? { provider } : {}),
    ...(phase ? { phase } : {}),
    ...(status ? { status } : {}),
    ...(runId ? { runId } : {}),
    ...(expectedRunId ? { expectedRunId } : {}),
    ...(runUrl ? { runUrl } : {}),
    ...(runWorkflowSha256 ? { workflowSha256: runWorkflowSha256 } : {}),
    ...(installedWorkflowSha256 ? { installedWorkflowSha256 } : {}),
    ...(installReportSha256 ? { installReportSha256 } : {}),
    matchesHandoff,
  };
}

function platformOperatorStatusWorkflowRunReportRunId(report: LoadedOperatorStatusReport): string | undefined {
  const value = platformOperatorStatusRecord(report.value);
  const github = platformOperatorStatusRecord(value?.github);
  return platformOperatorStatusString(github?.runId);
}

function platformOperatorStatusWorkflowDispatch(
  dir: string,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  report: LoadedOperatorStatusReport,
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
): PlatformOperatorStatusCiHandoff["workflowDispatch"] {
  const reportPath = join(dir, "reports", "ci-workflow-dispatch.json");
  const commandArgs = platformOperatorStatusWorkflowDispatchReportCommandArgs(dir, phase, reportPath, githubTarget);
  return {
    report: platformOperatorStatusWorkflowDispatchReport(report),
    command: platformOperatorStatusShellCommand(commandArgs),
    commandArgs,
  };
}

function platformOperatorStatusWorkflowDispatchReportCommandArgs(
  dir: string,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  reportPath: string,
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
): string[] {
  return [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-ci-workflow-dispatch",
    "--dir",
    dir,
    ...platformOperatorStatusGithubTargetArgs(githubTarget),
    "--phase",
    phase,
    "--report",
    reportPath,
  ];
}

function platformOperatorStatusWorkflowDispatchReport(
  report: LoadedOperatorStatusReport,
): PlatformOperatorStatusCiHandoff["workflowDispatch"]["report"] {
  const value = platformOperatorStatusRecord(report.value);
  const run = platformOperatorStatusRecord(value?.run);
  const phase = platformOperatorStatusString(value?.phase);
  const workflow = platformOperatorStatusString(value?.workflow);
  const runId = platformOperatorStatusString(run?.id);
  const runUrl = platformOperatorStatusString(run?.url);
  return {
    name: report.name,
    path: report.path,
    exists: report.exists,
    ...(report.ok !== undefined ? { ok: report.ok } : {}),
    ...(report.schemaVersion ? { schemaVersion: report.schemaVersion } : {}),
    ...(report.sha256 ? { sha256: report.sha256 } : {}),
    ...(phase ? { phase } : {}),
    ...(workflow ? { workflow } : {}),
    ...(runId ? { runId } : {}),
    ...(runUrl ? { runUrl } : {}),
  };
}

function platformOperatorStatusWorkflowWait(
  dir: string,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  runId: string | undefined,
  report: LoadedOperatorStatusReport,
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
): PlatformOperatorStatusCiHandoff["workflowWait"] {
  const reportPath = join(dir, "reports", "ci-workflow-wait.json");
  const commandArgs = platformOperatorStatusWorkflowWaitCommandArgs(dir, phase, reportPath, runId, githubTarget);
  return {
    report: platformOperatorStatusWorkflowWaitReport(report),
    command: platformOperatorStatusShellCommand(commandArgs),
    commandArgs,
  };
}

function platformOperatorStatusWorkflowWaitCommandArgs(
  dir: string,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  reportPath: string,
  runId: string | undefined,
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
): string[] {
  return [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-ci-workflow-wait",
    "--dir",
    dir,
    ...platformOperatorStatusGithubRepoArgs(githubTarget),
    "--run-id",
    runId ?? "<github-run-id>",
    "--phase",
    phase,
    "--report",
    reportPath,
  ];
}

function platformOperatorStatusWorkflowWaitReport(
  report: LoadedOperatorStatusReport,
): PlatformOperatorStatusCiHandoff["workflowWait"]["report"] {
  const value = platformOperatorStatusRecord(report.value);
  const run = platformOperatorStatusRecord(value?.run);
  const runId = platformOperatorStatusString(value?.runId) ?? platformOperatorStatusString(run?.id);
  const phase = platformOperatorStatusString(value?.phase);
  const runUrl = platformOperatorStatusString(run?.url);
  const status = platformOperatorStatusString(run?.status);
  const conclusion = platformOperatorStatusString(run?.conclusion);
  return {
    name: report.name,
    path: report.path,
    exists: report.exists,
    ...(report.ok !== undefined ? { ok: report.ok } : {}),
    ...(report.schemaVersion ? { schemaVersion: report.schemaVersion } : {}),
    ...(report.sha256 ? { sha256: report.sha256 } : {}),
    ...(phase ? { phase } : {}),
    ...(runId ? { runId } : {}),
    ...(runUrl ? { runUrl } : {}),
    ...(status ? { status } : {}),
    ...(conclusion ? { conclusion } : {}),
  };
}

function platformOperatorStatusArtifactImport(
  dir: string,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  runId: string | undefined,
  report: LoadedOperatorStatusReport,
): PlatformOperatorStatusCiHandoff["artifactImport"] {
  const reportPath = join(dir, "reports", "ci-artifact-import.json");
  const commandArgs = platformOperatorStatusArtifactImportCommandArgs(dir, phase, reportPath, runId);
  return {
    report: platformOperatorStatusArtifactImportReport(report),
    command: platformOperatorStatusShellCommand(commandArgs),
    commandArgs,
  };
}

function platformOperatorStatusArtifactImportCommandArgs(
  dir: string,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  reportPath: string,
  runId: string | undefined,
): string[] {
  return [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-ci-artifact-import",
    "--dir",
    dir,
    "--artifact-dir",
    "<downloaded-artifact-dir>",
    "--phase",
    phase,
    ...(runId ? ["--run-id", runId] : []),
    "--report",
    reportPath,
  ];
}

function platformOperatorStatusArtifactImportReport(
  report: LoadedOperatorStatusReport,
): PlatformOperatorStatusCiHandoff["artifactImport"]["report"] {
  const value = platformOperatorStatusRecord(report.value);
  const importedReports = Array.isArray(value?.importedReports) ? value.importedReports : [];
  const missingReports = platformOperatorStatusArray(value?.missingReports);
  const phase = platformOperatorStatusString(value?.phase);
  const expectedRunId = platformOperatorStatusString(value?.expectedRunId);
  const sourceReportDir = platformOperatorStatusString(value?.sourceReportDir);
  return {
    name: report.name,
    path: report.path,
    exists: report.exists,
    ...(report.ok !== undefined ? { ok: report.ok } : {}),
    ...(report.schemaVersion ? { schemaVersion: report.schemaVersion } : {}),
    ...(report.sha256 ? { sha256: report.sha256 } : {}),
    ...(phase ? { phase } : {}),
    ...(expectedRunId ? { expectedRunId } : {}),
    ...(sourceReportDir ? { sourceReportDir } : {}),
    importedReportCount: importedReports.length,
    missingReports,
  };
}

function platformOperatorStatusArtifactSync(
  dir: string,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  runId: string | undefined,
  report: LoadedOperatorStatusReport,
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
): PlatformOperatorStatusCiHandoff["artifactSync"] {
  const reportPath = join(dir, "reports", "ci-artifact-sync.json");
  const commandArgs = platformOperatorStatusArtifactSyncCommandArgs(dir, phase, reportPath, runId, githubTarget);
  return {
    report: platformOperatorStatusArtifactSyncReport(report),
    command: platformOperatorStatusShellCommand(commandArgs),
    commandArgs,
  };
}

function platformOperatorStatusArtifactSyncCommandArgs(
  dir: string,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  reportPath: string,
  runId: string | undefined,
  githubTarget: PlatformOperatorStatusCiHandoff["githubTarget"],
): string[] {
  return [
    platformOperatorStatusLoomCommand(dir),
    "harness",
    "platform-ci-artifact-sync",
    "--dir",
    dir,
    ...platformOperatorStatusGithubRepoArgs(githubTarget),
    "--run-id",
    runId ?? "<github-run-id>",
    "--phase",
    phase,
    "--report",
    reportPath,
  ];
}

function platformOperatorStatusCiHandoffRunId(ciHandoff: PlatformOperatorStatusCiHandoff): string | undefined {
  return ciHandoff.workflowWait.report.runId ?? ciHandoff.workflowDispatch.report.runId ?? ciHandoff.workflowRun.report.runId;
}

function platformOperatorStatusArtifactSyncReport(
  report: LoadedOperatorStatusReport,
): PlatformOperatorStatusCiHandoff["artifactSync"]["report"] {
  const value = platformOperatorStatusRecord(report.value);
  const runId = platformOperatorStatusString(value?.runId);
  const phase = platformOperatorStatusString(value?.phase);
  const artifactName = platformOperatorStatusString(value?.artifactName);
  return {
    name: report.name,
    path: report.path,
    exists: report.exists,
    ...(report.ok !== undefined ? { ok: report.ok } : {}),
    ...(report.schemaVersion ? { schemaVersion: report.schemaVersion } : {}),
    ...(report.sha256 ? { sha256: report.sha256 } : {}),
    ...(runId ? { runId } : {}),
    ...(phase ? { phase } : {}),
    ...(artifactName ? { artifactName } : {}),
  };
}

function loadPlatformOperatorStatusText(dir: string, name: string): LoadedOperatorStatusText {
  const path = join(dir, name);
  if (!existsSync(path)) return { name, path, exists: false };
  const text = readFileSync(path, "utf8");
  return {
    name,
    path,
    exists: true,
    sha256: sha256Hex(text),
    text,
  };
}

function platformOperatorStatusWorkflowName(text: string): string | undefined {
  const match = /^name:\s*(.+)\s*$/m.exec(text);
  return match?.[1]?.replace(/^["']|["']$/g, "");
}

function platformOperatorStatusWorkflowConcurrency(text: string | undefined): PlatformOperatorStatusCiHandoff["githubActions"]["concurrency"] {
  if (!text) return { ok: false };
  const block = /^concurrency:\n((?:  .+\n?)+)/m.exec(text)?.[1] ?? "";
  const group = /^  group:\s*(.+)\s*$/m.exec(block)?.[1];
  const cancelInProgressText = /^  cancel-in-progress:\s*(true|false)\s*$/m.exec(block)?.[1];
  const cancelInProgress = cancelInProgressText === undefined ? undefined : cancelInProgressText === "true";
  return {
    ok: group === PLATFORM_OPERATOR_STATUS_GITHUB_ACTIONS_CONCURRENCY_GROUP && cancelInProgress === false,
    group,
    cancelInProgress,
  };
}

function platformOperatorStatusRequiredEnvNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => platformOperatorStatusRecord(item)?.name)
    .filter((name): name is string => typeof name === "string")))
    .sort();
}

function platformOperatorStatusWorkflowDispatchPhase(
  phase: PlatformOperatorStatusResult["phase"],
): PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"] {
  if (phase === "prepare-pre-serve") return "pre-serve";
  return "post-serve";
}

function platformOperatorStatusSetWorkflowDispatchPhase(
  ciHandoff: PlatformOperatorStatusCiHandoff,
  phase: PlatformOperatorStatusCiHandoff["workflowDispatchInputs"]["phase"],
  repoRootArg: string | undefined,
): void {
  ciHandoff.workflowDispatchInputs.phase = phase;
  ciHandoff.workflowDispatchCommandArgs = platformOperatorStatusWorkflowDispatchCommandArgs(ciHandoff);
  ciHandoff.workflowDispatchCommand = ciHandoff.workflowDispatchCommandArgs.join(" ");
  ciHandoff.workflowRun.commandArgs = platformOperatorStatusWorkflowRunCommandArgs(
    resolve(dirname(ciHandoff.workflowRun.report.path), ".."),
    repoRootArg,
    phase,
    ciHandoff.workflowRun.report.path,
  );
  ciHandoff.workflowRun.command = platformOperatorStatusShellCommand(ciHandoff.workflowRun.commandArgs);
  ciHandoff.handoffRun.commandArgs = platformOperatorStatusHandoffRunCommandArgs(
    resolve(dirname(ciHandoff.handoffRun.report.path), ".."),
    repoRootArg,
    phase,
    ciHandoff.handoffRun.report.path,
    ciHandoff.githubTarget,
    platformOperatorStatusCommandFlagValue(ciHandoff.preflight.commandArgs, "--target"),
  );
  ciHandoff.handoffRun.command = platformOperatorStatusShellCommand(ciHandoff.handoffRun.commandArgs);
  ciHandoff.workflowDispatch.commandArgs = platformOperatorStatusWorkflowDispatchReportCommandArgs(
    resolve(dirname(ciHandoff.workflowDispatch.report.path), ".."),
    phase,
    ciHandoff.workflowDispatch.report.path,
    ciHandoff.githubTarget,
  );
  ciHandoff.workflowDispatch.command = platformOperatorStatusShellCommand(ciHandoff.workflowDispatch.commandArgs);
  ciHandoff.workflowWait.commandArgs = platformOperatorStatusWorkflowWaitCommandArgs(
    resolve(dirname(ciHandoff.workflowWait.report.path), ".."),
    phase,
    ciHandoff.workflowWait.report.path,
    ciHandoff.workflowDispatch.report.runId ?? ciHandoff.workflowRun.report.runId,
    ciHandoff.githubTarget,
  );
  ciHandoff.workflowWait.command = platformOperatorStatusShellCommand(ciHandoff.workflowWait.commandArgs);
  ciHandoff.artifactImport.commandArgs = platformOperatorStatusArtifactImportCommandArgs(
    resolve(dirname(ciHandoff.artifactImport.report.path), ".."),
    phase,
    ciHandoff.artifactImport.report.path,
    ciHandoff.workflowWait.report.runId ?? ciHandoff.workflowDispatch.report.runId ?? ciHandoff.workflowRun.report.runId,
  );
  ciHandoff.artifactImport.command = platformOperatorStatusShellCommand(ciHandoff.artifactImport.commandArgs);
  ciHandoff.artifactSync.commandArgs = platformOperatorStatusArtifactSyncCommandArgs(
    resolve(dirname(ciHandoff.artifactSync.report.path), ".."),
    phase,
    ciHandoff.artifactSync.report.path,
    ciHandoff.workflowWait.report.runId ?? ciHandoff.workflowDispatch.report.runId ?? ciHandoff.workflowRun.report.runId,
    ciHandoff.githubTarget,
  );
  ciHandoff.artifactSync.command = platformOperatorStatusShellCommand(ciHandoff.artifactSync.commandArgs);
}

function platformOperatorStatusWorkflowDispatchCommandArgs(
  ciHandoff: PlatformOperatorStatusCiHandoff,
): string[] {
  const inputs = ciHandoff.workflowDispatchInputs;
  return [
    "gh",
    "workflow",
    "run",
    ciHandoff.githubActions.fileName,
    ...platformOperatorStatusGithubRepoArgs(ciHandoff.githubTarget),
    "--field",
    `phase=${inputs.phase}`,
    "--field",
    `loom_bin=${inputs.loom_bin}`,
    "--field",
    `bundle_dir=${inputs.bundle_dir}`,
    "--field",
    `node_version=${inputs.node_version}`,
    "--field",
    `bootstrap_source_tree=${inputs.bootstrap_source_tree}`,
    ...platformOperatorStatusGithubRefArgs(ciHandoff.githubTarget),
  ];
}

function platformOperatorStatusCiHandoffNextActions(
  ciHandoff: PlatformOperatorStatusCiHandoff,
  reports: Record<string, LoadedOperatorStatusReport>,
): string[] {
  const actions = [];
  if (ciHandoff.githubActions.exists && !ciHandoff.workflowRun.report.matchesHandoff && ciHandoff.preflight.report.ok !== true) {
    actions.push(`Check CI handoff preflight: ${ciHandoff.preflight.command}`);
  }
  for (const action of ciHandoff.preflight.report.nextActions ?? []) {
    actions.push(`CI handoff preflight: ${action}`);
  }
  for (const action of platformOperatorStatusWorkflowPublishPlanNextActions(reports.ciWorkflowPublishPlan)) {
    actions.push(`CI workflow publish plan: ${action}`);
  }
  for (const action of platformOperatorStatusCiSecretsPlanNextActions(reports.ciSecretsPlan)) {
    actions.push(`CI secrets plan: ${action}`);
  }
  if (ciHandoff.githubActions.exists && (!ciHandoff.workflowInstall.installed.matchesBundle || !ciHandoff.workflowInstall.report.matchesBundle)) {
    actions.push(`Install workflow: ${ciHandoff.workflowInstall.installCommand}`);
  }
  if (ciHandoff.githubActions.exists && !ciHandoff.workflowRun.report.matchesHandoff) {
    actions.push(`Record CI run proof from GitHub Actions: ${ciHandoff.workflowRun.command}`);
    actions.push(`Run CI handoff: ${ciHandoff.handoffRun.command}`);
    actions.push(`Dispatch CI workflow: ${ciHandoff.workflowDispatch.command}`);
    actions.push(`Wait for CI workflow: ${ciHandoff.workflowWait.command}`);
    actions.push(`Download and import CI reports: ${ciHandoff.artifactSync.command}`);
    actions.push(`Import downloaded CI reports: ${ciHandoff.artifactImport.command}`);
  }
  if (ciHandoff.githubActions.exists && ciHandoff.githubActions.concurrency.ok && ciHandoff.externalSecrets.exists && ciHandoff.externalSecrets.tokenFree === true) {
    actions.push(
      `Run: ${ciHandoff.workflowDispatchCommand}`,
      `Run GitHub Actions workflow ${ciHandoff.githubActions.fileName} with workflow_dispatch phase=${ciHandoff.workflowDispatchInputs.phase}, bundle_dir=${ciHandoff.workflowDispatchInputs.bundle_dir}, node_version=${ciHandoff.workflowDispatchInputs.node_version}, and bootstrap_source_tree=true when using this checkout.`,
    );
  }
  return actions;
}

function platformOperatorStatusWorkflowPublishPlanNextActions(
  report: LoadedOperatorStatusReport | undefined,
): string[] {
  const value = platformOperatorStatusRecord(report?.value);
  if (value?.schemaVersion !== "platform-ci-workflow-publish-plan/v1" || value.ok === true) return [];
  return platformOperatorStatusArray(value.nextActions);
}

function platformOperatorStatusCiSecretsPlanNextActions(
  report: LoadedOperatorStatusReport | undefined,
): string[] {
  const value = platformOperatorStatusRecord(report?.value);
  if (value?.schemaVersion !== "platform-ci-secrets-plan/v1") return [];
  return platformOperatorStatusArray(value.nextActions);
}

function platformOperatorStatusReportRefs(
  reports: Record<string, LoadedOperatorStatusReport>,
): Record<string, PlatformOperatorStatusReportRef> {
  return Object.fromEntries(Object.entries(reports).map(([key, report]) => [
    key,
    platformOperatorStatusReportRef(report),
  ]));
}

function platformOperatorStatusReportRef(report: LoadedOperatorStatusReport): PlatformOperatorStatusReportRef {
  return {
    name: report.name,
    path: report.path,
    exists: report.exists,
    ok: report.ok,
    schemaVersion: report.schemaVersion,
    sha256: report.sha256,
  };
}

function platformOperatorStatusRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function platformOperatorStatusGate(value: Record<string, unknown> | undefined, gate: string): boolean {
  const gates = platformOperatorStatusRecord(value?.gates);
  return gates?.[gate] === true;
}

function platformOperatorStatusArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function platformOperatorStatusFormatList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function platformOperatorStatusStringArrayArray(value: unknown): string[][] {
  return Array.isArray(value)
    ? value
      .filter((item): item is string[] => Array.isArray(item) && item.every((entry) => typeof entry === "string"))
      .map((item) => [...item])
    : [];
}

function platformOperatorStatusString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function platformOperatorStatusSamePath(left: string | undefined, right: string): boolean {
  if (!left) return false;
  if (resolve(left) === resolve(right)) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function platformOperatorStatusShellCommand(args: string[]): string {
  return args.map(platformOperatorStatusShellQuote).join(" ");
}

function platformOperatorStatusLoomCommand(dir: string): string {
  const explicit = process.env.LOOM_BIN?.trim();
  if (explicit) return explicit;
  const wrapperPath = join(dir, "loom-wrapper");
  return platformOperatorStatusExecutableFile(wrapperPath) ? wrapperPath : "loom";
}

function platformOperatorStatusLoomCommandArgs(dir: string, args: string[]): string[] {
  return args[0] === "loom" ? [platformOperatorStatusLoomCommand(dir), ...args.slice(1)] : args;
}

function platformOperatorStatusLoomCommandString(dir: string, command: string): string {
  if (!command.startsWith("loom ")) return command;
  return platformOperatorStatusShellCommand([platformOperatorStatusLoomCommand(dir), ...command.slice("loom ".length).split(" ")]);
}

function platformOperatorStatusExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function platformOperatorStatusShellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
