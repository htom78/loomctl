import { HARNESS_VISION_LOCK, ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES } from "../../harness/profile-contract.js";
import { type ControlPlaneProviderName } from "../../harness/server.js";
import { cliTokenValue, isRecord, normalizeHttpBaseUrl, parseControlPlaneProviderFlag, parseEnvNameFlag, parseProjectTemplateFlag, parseSafeNameFlag, stringsOnly } from "./flags.js";
import { SMOKE_CONCURRENCY_ADMISSION_BLOCKED_REASONS, SMOKE_CONCURRENCY_ADMISSION_SCHEMA_VERSION, smokeHeaders, smokeJson } from "./smoke.js";

export interface HarnessCutoverReportCliOptions {
  url: string;
  tenant: string;
  token?: string;
  tokenEnv?: string;
  adminToken?: string;
  adminTokenEnv?: string;
  controlPlaneProvider?: string;
  project?: string;
  template?: string;
  isolationTenant?: string;
  viewerTokenEnv?: string;
  controlPlaneWebhookSecretEnv?: string;
  report?: string;
}

export interface HarnessCutoverReport {
  ok: boolean;
  tenant: string;
  controlPlaneProvider?: string;
  expectedControlPlaneProvider?: ControlPlaneProviderName;
  providerMatchesExpected?: boolean;
  serverProfile?: string;
  serverReadinessOk: boolean;
  serverReadinessMissing: string[];
  serverGoldenPathOk?: boolean;
  serverGoldenPathMissingCapabilities: string[];
  serverVisionLockOk: boolean;
  serverVisionLockTarget?: string;
  serverVisionLockMvpIsScopeReduction?: boolean;
  serverVisionLockMissingCapabilities: string[];
  serverConcurrencyAdmissionOk?: boolean;
  serverConcurrencyAdmissionSchemaVersion?: string;
  serverConcurrencyAdmissionRunWorkspaceIsolation?: string;
  serverConcurrencyAdmissionActiveRunClaimScope?: string;
  serverConcurrencyAdmissionQueueBlockedReasons?: string[];
  serverConcurrencyAdmissionRunControlCrossServer?: boolean;
  serverConcurrencyAdmissionMissing?: string[];
  serverControlPlaneDiscoveryOk?: boolean;
  serverControlPlaneDiscoveryTokenMode?: string;
  serverControlPlaneDiscoveryTenantCount?: number;
  serverControlPlaneDiscoveryTenantOkCount?: number;
  serverControlPlaneDiscoveryMissingTenants?: string[];
  tenantReadinessProfile?: string;
  tenantReadinessOk: boolean;
  tenantReadinessMissing: string[];
  tenantGoldenPathOk?: boolean;
  tenantGoldenPathMissingCapabilities: string[];
  tenantVisionLockOk: boolean;
  tenantVisionLockTarget?: string;
  tenantVisionLockMvpIsScopeReduction?: boolean;
  tenantVisionLockMissingCapabilities: string[];
  tenantConcurrencyAdmissionOk?: boolean;
  tenantConcurrencyAdmissionSchemaVersion?: string;
  tenantConcurrencyAdmissionRunWorkspaceIsolation?: string;
  tenantConcurrencyAdmissionActiveRunClaimScope?: string;
  tenantConcurrencyAdmissionQueueBlockedReasons?: string[];
  tenantConcurrencyAdmissionRunControlCrossServer?: boolean;
  tenantConcurrencyAdmissionMissing?: string[];
  tenantControlPlaneDiscoveryOk?: boolean;
  tenantControlPlaneDiscoveryTokenMode?: string;
  tenantControlPlaneDiscoveryTenantCount?: number;
  tenantControlPlaneDiscoveryTenantOkCount?: number;
  tenantControlPlaneDiscoveryMissingTenants?: string[];
  missing: string[];
  nextActions: string[];
  agentGitServiceProvisioningCommandsReady?: boolean;
  agentGitServiceProvisioningCommandsMissingInputs?: string[];
  agentGitServiceProvisioningPlanCommandArgs?: string[];
  agentGitServiceProvisioningPlanDryRunCommandArgs?: string[];
  agentGitServiceProvisioningPlanApplyCommandArgs?: string[];
  smokeCommandReady: boolean;
  smokeCommandMissingInputs: string[];
  smokeCommandArgs?: string[];
  agentGitService?: HarnessCutoverAgentGitServiceReport;
}

export interface HarnessCutoverAgentGitServiceReport {
  checked: boolean;
  ready: boolean;
  projectCount: number;
  readyProjectCount: number;
  missingProjectCount: number;
  missingSecretProjectCount: number;
  missingProjects: string[];
  projectMissing: Record<string, string[]>;
  provisionCommandArgsByProject: Record<string, string[]>;
}

export async function readHarnessCutoverReportViaHarness(options: HarnessCutoverReportCliOptions): Promise<HarnessCutoverReport> {
  const baseUrl = normalizeHttpBaseUrl(options.url, "--url");
  const tenant = parseSafeNameFlag(options.tenant, "--tenant");
  const expectedProvider = options.controlPlaneProvider === undefined
    ? undefined
    : parseControlPlaneProviderFlag(options.controlPlaneProvider, "--control-plane-provider");
  const tenantToken = cliTokenValue(options.token, options.tokenEnv, "--token-env");
  const adminToken = cliTokenValue(options.adminToken, options.adminTokenEnv, "--admin-token-env");
  const serverStatus = await smokeJson(
    `${baseUrl}/status`,
    { headers: smokeHeaders(adminToken ?? tenantToken) },
    [200],
    "cutover report server status",
  );
  const tenantStatus = await smokeJson(
    `${baseUrl}/tenants/${encodeURIComponent(tenant)}/status`,
    { headers: smokeHeaders(tenantToken ?? adminToken) },
    [200],
    "cutover report tenant status",
  );
  const serverReadiness = cutoverReadinessFromStatus(serverStatus.body);
  const tenantReadiness = cutoverReadinessFromStatus(tenantStatus.body);
  const serverVisionLock = cutoverVisionLockFromStatus(serverStatus.body);
  const tenantVisionLock = cutoverVisionLockFromStatus(tenantStatus.body);
  const serverConcurrencyAdmission = cutoverConcurrencyAdmissionFromStatus(serverStatus.body);
  const tenantConcurrencyAdmission = cutoverConcurrencyAdmissionFromStatus(tenantStatus.body);
  const serverControlPlaneDiscovery = cutoverControlPlaneDiscoveryFromStatus(serverStatus.body);
  const tenantControlPlaneDiscovery = cutoverControlPlaneDiscoveryFromStatus(tenantStatus.body);
  const serverProvider = cutoverControlPlaneProviderFromStatus(serverStatus.body);
  const tenantProvider = cutoverControlPlaneProviderFromStatus(tenantStatus.body);
  const provider = tenantProvider ?? serverProvider ?? expectedProvider;
  const missing = new Set<string>();

  if (!serverReadiness.ok) missing.add("serverReadiness");
  if (!tenantReadiness.ok) missing.add("tenantReadiness");
  if (serverReadiness.goldenPathOk === false || serverReadiness.goldenPathMissingCapabilities.length) missing.add("serverGoldenPath");
  if (tenantReadiness.goldenPathOk === false || tenantReadiness.goldenPathMissingCapabilities.length) missing.add("tenantGoldenPath");
  if (!serverVisionLock.ok) missing.add("serverVisionLock");
  if (!tenantVisionLock.ok) missing.add("tenantVisionLock");
  if (!serverConcurrencyAdmission.ok) missing.add("serverConcurrencyAdmission");
  if (!tenantConcurrencyAdmission.ok) missing.add("tenantConcurrencyAdmission");
  if (expectedProvider && provider !== expectedProvider) missing.add("controlPlaneProvider");

  let agentGitService: HarnessCutoverAgentGitServiceReport | undefined;
  if ((expectedProvider ?? provider) === "agent-git-service") {
    if (!adminToken) {
      missing.add("agentGitServiceProvisioningPlan");
      agentGitService = emptyCutoverAgentGitServiceReport(false);
    } else {
      const plan = await smokeJson(
        `${baseUrl}/tenants/${encodeURIComponent(tenant)}/control-plane/agent-git-service/provisioning-plan`,
        { headers: { authorization: `Bearer ${adminToken}` } },
        [200],
        "cutover report agent-git-service provisioning plan",
      );
      agentGitService = cutoverAgentGitServiceReportFromPlan(plan.body);
      if (!agentGitService.ready) missing.add("agentGitServiceProjectAgents");
    }
  }

  const missingList = [...missing];
  const agentGitServiceProvisioningCommands = (expectedProvider ?? provider) === "agent-git-service"
    ? cutoverAgentGitServiceProvisioningCommands(options, { baseUrl, tenant })
    : undefined;
  const smokeCommand = cutoverSmokeCommand(options, {
    baseUrl,
    tenant,
    provider: expectedProvider ?? provider,
  });
  return {
    ok: missingList.length === 0,
    tenant,
    controlPlaneProvider: provider,
    expectedControlPlaneProvider: expectedProvider,
    providerMatchesExpected: expectedProvider === undefined ? undefined : provider === expectedProvider,
    serverProfile: cutoverServerProfileFromStatus(serverStatus.body),
    serverReadinessOk: serverReadiness.ok,
    serverReadinessMissing: serverReadiness.missing,
    serverGoldenPathOk: serverReadiness.goldenPathOk,
    serverGoldenPathMissingCapabilities: serverReadiness.goldenPathMissingCapabilities,
    serverVisionLockOk: serverVisionLock.ok,
    serverVisionLockTarget: serverVisionLock.target,
    serverVisionLockMvpIsScopeReduction: serverVisionLock.mvpIsScopeReduction,
    serverVisionLockMissingCapabilities: serverVisionLock.missingCapabilities,
    serverConcurrencyAdmissionOk: serverConcurrencyAdmission.ok,
    serverConcurrencyAdmissionSchemaVersion: serverConcurrencyAdmission.schemaVersion,
    serverConcurrencyAdmissionRunWorkspaceIsolation: serverConcurrencyAdmission.runWorkspaceIsolation,
    serverConcurrencyAdmissionActiveRunClaimScope: serverConcurrencyAdmission.activeRunClaimScope,
    serverConcurrencyAdmissionQueueBlockedReasons: serverConcurrencyAdmission.queueBlockedReasons,
    serverConcurrencyAdmissionRunControlCrossServer: serverConcurrencyAdmission.runControlCrossServer,
    serverConcurrencyAdmissionMissing: serverConcurrencyAdmission.missing,
    serverControlPlaneDiscoveryOk: serverControlPlaneDiscovery.ok,
    serverControlPlaneDiscoveryTokenMode: serverControlPlaneDiscovery.tokenMode,
    serverControlPlaneDiscoveryTenantCount: serverControlPlaneDiscovery.tenantCount,
    serverControlPlaneDiscoveryTenantOkCount: serverControlPlaneDiscovery.tenantOkCount,
    serverControlPlaneDiscoveryMissingTenants: serverControlPlaneDiscovery.missingTenants,
    tenantReadinessProfile: tenantReadiness.profile,
    tenantReadinessOk: tenantReadiness.ok,
    tenantReadinessMissing: tenantReadiness.missing,
    tenantGoldenPathOk: tenantReadiness.goldenPathOk,
    tenantGoldenPathMissingCapabilities: tenantReadiness.goldenPathMissingCapabilities,
    tenantVisionLockOk: tenantVisionLock.ok,
    tenantVisionLockTarget: tenantVisionLock.target,
    tenantVisionLockMvpIsScopeReduction: tenantVisionLock.mvpIsScopeReduction,
    tenantVisionLockMissingCapabilities: tenantVisionLock.missingCapabilities,
    tenantConcurrencyAdmissionOk: tenantConcurrencyAdmission.ok,
    tenantConcurrencyAdmissionSchemaVersion: tenantConcurrencyAdmission.schemaVersion,
    tenantConcurrencyAdmissionRunWorkspaceIsolation: tenantConcurrencyAdmission.runWorkspaceIsolation,
    tenantConcurrencyAdmissionActiveRunClaimScope: tenantConcurrencyAdmission.activeRunClaimScope,
    tenantConcurrencyAdmissionQueueBlockedReasons: tenantConcurrencyAdmission.queueBlockedReasons,
    tenantConcurrencyAdmissionRunControlCrossServer: tenantConcurrencyAdmission.runControlCrossServer,
    tenantConcurrencyAdmissionMissing: tenantConcurrencyAdmission.missing,
    tenantControlPlaneDiscoveryOk: tenantControlPlaneDiscovery.ok,
    tenantControlPlaneDiscoveryTokenMode: tenantControlPlaneDiscovery.tokenMode,
    tenantControlPlaneDiscoveryTenantCount: tenantControlPlaneDiscovery.tenantCount,
    tenantControlPlaneDiscoveryTenantOkCount: tenantControlPlaneDiscovery.tenantOkCount,
    tenantControlPlaneDiscoveryMissingTenants: tenantControlPlaneDiscovery.missingTenants,
    missing: missingList,
    nextActions: cutoverReportNextActions({
      tenant,
      adminTokenEnv: options.adminTokenEnv,
      missing: missingList,
      agentGitServiceChecked: agentGitService?.checked ?? false,
      agentGitServiceReady: agentGitService?.ready ?? false,
      provider: expectedProvider ?? provider,
    }),
    ...(agentGitServiceProvisioningCommands
      ? {
          agentGitServiceProvisioningCommandsReady: agentGitServiceProvisioningCommands.ready,
          agentGitServiceProvisioningCommandsMissingInputs: agentGitServiceProvisioningCommands.missingInputs,
        }
      : {}),
    ...(agentGitServiceProvisioningCommands?.planArgs
      ? { agentGitServiceProvisioningPlanCommandArgs: agentGitServiceProvisioningCommands.planArgs }
      : {}),
    ...(agentGitServiceProvisioningCommands?.dryRunArgs
      ? { agentGitServiceProvisioningPlanDryRunCommandArgs: agentGitServiceProvisioningCommands.dryRunArgs }
      : {}),
    ...(agentGitServiceProvisioningCommands?.applyArgs
      ? { agentGitServiceProvisioningPlanApplyCommandArgs: agentGitServiceProvisioningCommands.applyArgs }
      : {}),
    smokeCommandReady: smokeCommand.ready,
    smokeCommandMissingInputs: smokeCommand.missingInputs,
    ...(smokeCommand.args ? { smokeCommandArgs: smokeCommand.args } : {}),
    agentGitService,
  };
}

export function cutoverAgentGitServiceProvisioningCommands(
  options: HarnessCutoverReportCliOptions,
  context: { baseUrl: string; tenant: string },
): {
  ready: boolean;
  missingInputs: string[];
  planArgs?: string[];
  dryRunArgs?: string[];
  applyArgs?: string[];
} {
  const adminTokenEnv = options.adminTokenEnv === undefined
    ? undefined
    : parseEnvNameFlag(options.adminTokenEnv, "--admin-token-env");
  if (!adminTokenEnv) return { ready: false, missingInputs: ["adminTokenEnv"] };

  const baseArgs = [
    "--url",
    context.baseUrl,
    "--tenant",
    context.tenant,
    "--admin-token-env",
    adminTokenEnv,
  ];
  return {
    ready: true,
    missingInputs: [],
    planArgs: [
      "loom",
      "harness",
      "agent-git-service-provisioning-plan",
      ...baseArgs,
    ],
    dryRunArgs: [
      "loom",
      "harness",
      "apply-agent-git-service-provisioning-plan",
      ...baseArgs,
      "--dry-run",
    ],
    applyArgs: [
      "loom",
      "harness",
      "apply-agent-git-service-provisioning-plan",
      ...baseArgs,
    ],
  };
}

export function cutoverReadinessFromStatus(value: unknown): {
  profile?: string;
  ok: boolean;
  missing: string[];
  goldenPathOk?: boolean;
  goldenPathMissingCapabilities: string[];
} {
  const readiness = isRecord(value) && isRecord(value.readiness) ? value.readiness : undefined;
  const goldenPath = readiness && isRecord(readiness.goldenPath) ? readiness.goldenPath : undefined;
  const goldenPathCapabilities = goldenPath && Array.isArray(goldenPath.capabilities)
    ? stringsOnly(goldenPath.capabilities)
    : [];
  const reportedGoldenPathMissing = goldenPath && Array.isArray(goldenPath.missingCapabilities)
    ? stringsOnly(goldenPath.missingCapabilities)
    : [];
  const missingRequiredGoldenPathCapabilities = ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES.filter(
    (capability) => !goldenPathCapabilities.includes(capability),
  );
  const goldenPathRequired = goldenPath && typeof goldenPath.required === "boolean" ? goldenPath.required : undefined;
  const goldenPathOk = goldenPath && typeof goldenPath.ok === "boolean" ? goldenPath.ok : undefined;
  return {
    profile: readiness && typeof readiness.profile === "string" ? readiness.profile : undefined,
    ok: readiness && typeof readiness.ok === "boolean" ? readiness.ok : false,
    missing: readiness && Array.isArray(readiness.missing) ? stringsOnly(readiness.missing) : ["readiness"],
    goldenPathOk,
    goldenPathMissingCapabilities: Array.from(new Set([
      ...missingRequiredGoldenPathCapabilities,
      ...reportedGoldenPathMissing,
      ...(goldenPathRequired === false ? ["profile-readiness"] : []),
      ...(goldenPathOk === false && !missingRequiredGoldenPathCapabilities.length && !reportedGoldenPathMissing.length
        ? ["profile-readiness"]
        : []),
    ])),
  };
}

export function cutoverVisionLockFromStatus(value: unknown): {
  ok: boolean;
  target?: string;
  mvpIsScopeReduction?: boolean;
  missingCapabilities: string[];
} {
  const visionLock = isRecord(value) && isRecord(value.visionLock) ? value.visionLock : undefined;
  const target = visionLock && typeof visionLock.target === "string" ? visionLock.target : undefined;
  const mvpIsScopeReduction = visionLock && typeof visionLock.mvpIsScopeReduction === "boolean"
    ? visionLock.mvpIsScopeReduction
    : undefined;
  const capabilities = visionLock && Array.isArray(visionLock.capabilities) ? stringsOnly(visionLock.capabilities) : [];
  const missingCapabilities = HARNESS_VISION_LOCK.capabilities.filter((capability) => !capabilities.includes(capability));
  return {
    ok: target === HARNESS_VISION_LOCK.target && mvpIsScopeReduction === false && missingCapabilities.length === 0,
    target,
    mvpIsScopeReduction,
    missingCapabilities,
  };
}

export function cutoverConcurrencyAdmissionFromStatus(value: unknown): {
  ok: boolean;
  schemaVersion?: string;
  runWorkspaceIsolation?: string;
  activeRunClaimScope?: string;
  queueBlockedReasons: string[];
  runControlCrossServer?: boolean;
  missing: string[];
} {
  const server = isRecord(value) && isRecord(value.server) ? value.server : undefined;
  const admission = server && isRecord(server.concurrencyAdmission) ? server.concurrencyAdmission : undefined;
  if (!admission) {
    return {
      ok: false,
      queueBlockedReasons: [],
      missing: ["concurrencyAdmission"],
    };
  }

  const missing: string[] = [];
  const schemaVersion = typeof admission.schemaVersion === "string" ? admission.schemaVersion : undefined;
  if (schemaVersion !== SMOKE_CONCURRENCY_ADMISSION_SCHEMA_VERSION) missing.push("schemaVersion");

  const statusRunWorkspaceIsolation = server && typeof server.runWorkspaceIsolation === "string"
    ? server.runWorkspaceIsolation
    : undefined;
  const runWorkspaceIsolation = typeof admission.runWorkspaceIsolation === "string"
    ? admission.runWorkspaceIsolation
    : undefined;
  if (runWorkspaceIsolation !== "project" && runWorkspaceIsolation !== "run") {
    missing.push("runWorkspaceIsolation");
  } else if (statusRunWorkspaceIsolation && runWorkspaceIsolation !== statusRunWorkspaceIsolation) {
    missing.push("runWorkspaceIsolation");
  }

  const activeRun = isRecord(admission.activeRun) ? admission.activeRun : undefined;
  const activeRunClaimScope = activeRun && typeof activeRun.claimScope === "string"
    ? activeRun.claimScope
    : undefined;
  if (runWorkspaceIsolation === "project" || runWorkspaceIsolation === "run") {
    if (activeRunClaimScope !== runWorkspaceIsolation) missing.push("activeRun.claimScope");
  } else if (activeRunClaimScope !== "project" && activeRunClaimScope !== "run") {
    missing.push("activeRun.claimScope");
  }

  const queueing = isRecord(admission.queueing) ? admission.queueing : undefined;
  const queueBlockedReasons = queueing && Array.isArray(queueing.blockedReasons)
    ? stringsOnly(queueing.blockedReasons)
    : [];
  const missingBlockedReasons = SMOKE_CONCURRENCY_ADMISSION_BLOCKED_REASONS.filter((reason) =>
    !queueBlockedReasons.includes(reason)
  );
  if (missingBlockedReasons.length) missing.push("queueing.blockedReasons");

  const runControl = isRecord(admission.runControl) ? admission.runControl : undefined;
  const runControlCrossServer = runControl && typeof runControl.crossServer === "boolean"
    ? runControl.crossServer
    : undefined;
  if (runControlCrossServer !== true) missing.push("runControl.crossServer");

  return {
    ok: missing.length === 0,
    schemaVersion,
    runWorkspaceIsolation,
    activeRunClaimScope,
    queueBlockedReasons,
    runControlCrossServer,
    missing,
  };
}

export function cutoverControlPlaneDiscoveryFromStatus(value: unknown): {
  ok?: boolean;
  tokenMode?: string;
  tenantCount?: number;
  tenantOkCount?: number;
  missingTenants?: string[];
} {
  const readiness = isRecord(value) && isRecord(value.readiness) ? value.readiness : undefined;
  const checks = readiness && isRecord(readiness.checks) ? readiness.checks : undefined;
  const discovery = checks && isRecord(checks.controlPlaneDiscovery) ? checks.controlPlaneDiscovery : undefined;
  if (!discovery) return {};
  return {
    ok: typeof discovery.ok === "boolean" ? discovery.ok : undefined,
    tokenMode: typeof discovery.tokenMode === "string" ? discovery.tokenMode : undefined,
    tenantCount: typeof discovery.tenantCount === "number" ? discovery.tenantCount : undefined,
    tenantOkCount: typeof discovery.tenantOkCount === "number" ? discovery.tenantOkCount : undefined,
    missingTenants: Array.isArray(discovery.missingTenants) ? stringsOnly(discovery.missingTenants) : undefined,
  };
}

export function cutoverServerProfileFromStatus(value: unknown): string | undefined {
  const server = isRecord(value) && isRecord(value.server) ? value.server : undefined;
  return server && typeof server.profile === "string" ? server.profile : undefined;
}

export function cutoverControlPlaneProviderFromStatus(value: unknown): string | undefined {
  const server = isRecord(value) && isRecord(value.server) ? value.server : undefined;
  const controlPlane = server && isRecord(server.controlPlane) ? server.controlPlane : undefined;
  return controlPlane && typeof controlPlane.provider === "string" ? controlPlane.provider : undefined;
}

export function emptyCutoverAgentGitServiceReport(checked: boolean): HarnessCutoverAgentGitServiceReport {
  return {
    checked,
    ready: false,
    projectCount: 0,
    readyProjectCount: 0,
    missingProjectCount: 0,
    missingSecretProjectCount: 0,
    missingProjects: [],
    projectMissing: {},
    provisionCommandArgsByProject: {},
  };
}

export function cutoverAgentGitServiceReportFromPlan(value: unknown): HarnessCutoverAgentGitServiceReport {
  const plan = isRecord(value) ? value : {};
  const projects = Array.isArray(plan.projects) ? plan.projects.filter(isRecord) : [];
  const projectMissing: Record<string, string[]> = {};
  const provisionCommandArgsByProject: Record<string, string[]> = {};
  const missingProjects: string[] = [];
  for (const project of projects) {
    if (typeof project.project !== "string") continue;
    const missing = Array.isArray(project.missing) ? stringsOnly(project.missing) : [];
    if (project.ready !== true) {
      missingProjects.push(project.project);
      projectMissing[project.project] = missing;
    }
    if (Array.isArray(project.provisionCommandArgs)) {
      provisionCommandArgsByProject[project.project] = stringsOnly(project.provisionCommandArgs);
    }
  }
  const missingProjectCount = cutoverNumberField(plan, "missingProjectCount", missingProjects.length);
  const missingSecretProjectCount = cutoverNumberField(plan, "missingSecretProjectCount", 0);
  return {
    checked: true,
    ready: missingProjects.length === 0 && missingProjectCount === 0 && missingSecretProjectCount === 0,
    projectCount: cutoverNumberField(plan, "projectCount", projects.length),
    readyProjectCount: cutoverNumberField(plan, "readyProjectCount", projects.length - missingProjects.length),
    missingProjectCount,
    missingSecretProjectCount,
    missingProjects,
    projectMissing,
    provisionCommandArgsByProject,
  };
}

export function cutoverNumberField(value: Record<string, unknown>, field: string, fallback: number): number {
  return typeof value[field] === "number" ? value[field] : fallback;
}

export function cutoverReportNextActions(options: {
  tenant: string;
  adminTokenEnv?: string;
  missing: string[];
  agentGitServiceChecked: boolean;
  agentGitServiceReady: boolean;
  provider?: string;
}): string[] {
  const actions: string[] = [];
  if (options.missing.some((item) =>
    item === "serverReadiness" ||
    item === "tenantReadiness" ||
    item === "serverGoldenPath" ||
    item === "tenantGoldenPath" ||
    item === "serverVisionLock" ||
    item === "tenantVisionLock" ||
    item === "serverConcurrencyAdmission" ||
    item === "tenantConcurrencyAdmission"
  )) {
    actions.push("loom harness doctor --profile platform-readiness");
  }
  if (options.provider === "agent-git-service" && (!options.agentGitServiceChecked || !options.agentGitServiceReady)) {
    const adminTokenEnv = options.adminTokenEnv ?? "<admin-token-env>";
    actions.push(
      `loom harness apply-agent-git-service-provisioning-plan --url <harness-url> --tenant ${options.tenant} --admin-token-env ${adminTokenEnv} --dry-run`,
    );
    actions.push(
      `loom harness apply-agent-git-service-provisioning-plan --url <harness-url> --tenant ${options.tenant} --admin-token-env ${adminTokenEnv}`,
    );
    actions.push("loom harness smoke --profile platform-readiness --control-plane-provider agent-git-service");
  } else if (options.missing.length > 0) {
    actions.push("loom harness smoke --profile platform-readiness");
  }
  return actions;
}

export function cutoverSmokeCommand(
  options: HarnessCutoverReportCliOptions,
  context: { baseUrl: string; tenant: string; provider?: string },
): { ready: boolean; missingInputs: string[]; args?: string[] } {
  const missingInputs: string[] = [];
  const project = options.project === undefined ? undefined : parseSafeNameFlag(options.project, "--project");
  const isolationTenant = options.isolationTenant === undefined
    ? undefined
    : parseSafeNameFlag(options.isolationTenant, "--isolation-tenant");
  const template = parseProjectTemplateFlag(options.template ?? "vas-lite", "--template");
  const tokenEnv = options.tokenEnv === undefined
    ? undefined
    : parseEnvNameFlag(options.tokenEnv, "--token-env");
  const viewerTokenEnv = options.viewerTokenEnv === undefined
    ? undefined
    : parseEnvNameFlag(options.viewerTokenEnv, "--viewer-token-env");
  const adminTokenEnv = options.adminTokenEnv === undefined
    ? undefined
    : parseEnvNameFlag(options.adminTokenEnv, "--admin-token-env");
  const webhookSecretEnv = options.controlPlaneWebhookSecretEnv === undefined
    ? undefined
    : parseEnvNameFlag(options.controlPlaneWebhookSecretEnv, "--control-plane-webhook-secret-env");

  if (!project) missingInputs.push("project");
  if (!isolationTenant) missingInputs.push("isolationTenant");
  if (!tokenEnv) missingInputs.push("tokenEnv");
  if (!viewerTokenEnv) missingInputs.push("viewerTokenEnv");
  if (!adminTokenEnv) missingInputs.push("adminTokenEnv");
  if (!webhookSecretEnv) missingInputs.push("controlPlaneWebhookSecretEnv");
  if (missingInputs.length) return { ready: false, missingInputs };

  const args = [
    "loom",
    "harness",
    "smoke",
    "--url",
    context.baseUrl,
    "--tenant",
    context.tenant,
    "--project",
    project as string,
    "--template",
    template,
    "--token-env",
    tokenEnv as string,
    "--viewer-token-env",
    viewerTokenEnv as string,
    "--admin-token-env",
    adminTokenEnv as string,
    "--isolation-tenant",
    isolationTenant as string,
    "--profile",
    "platform-readiness",
  ];
  if (context.provider) {
    args.push("--control-plane-provider", context.provider);
  }
  args.push("--control-plane-webhook-secret-env", webhookSecretEnv as string);
  args.push("--report", "reports/smoke.json");
  return { ready: true, missingInputs: [], args };
}
