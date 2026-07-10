import { readdirSync, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type TenantRole } from "../audit.js";
import { formatPrometheusMetrics, type StateBackendHealthSnapshot } from "../server-observability.js";
import { tenantApiKeyIsActive, type OidcHealthSnapshot } from "../server-auth.js";
import { type QueuedRunBlockedReason, type QueuedRunConcurrencySummary } from "../run-state.js";
import { CONTROL_PLANE_PROVIDER_BOUNDARY, controlPlaneProviderCatalogEntry, type ControlPlaneProvider, type ControlPlaneProviderAdoptionStage, type ControlPlaneProviderBoundary, type ControlPlaneProviderCatalogName } from "../control-plane.js";
import { controlPlaneProviderAdapter as resolveControlPlaneProviderAdapter } from "../control-plane-registry.js";
import { HARNESS_VISION_LOCK as SHARED_HARNESS_VISION_LOCK, ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES, ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS } from "../profile-contract.js";
import { PROCESS_SESSION_STOP_GRACE_MS } from "../executor.js";
import { HarnessConcurrencyAdmissionStatus, runLeaseTtlMs, runningRunIsStale, activeTenantRunAdmissionClaimIds, persistedRunningRunHasActiveAdmissionClaim, queuedAdmissionTenantActiveRunLimit, queuedAdmissionProjectActiveWorkspace, queuedAdmissionPersistedRunningRun, queuedAdmissionReady, harnessConcurrencyAdmissionStatus } from "./admission.js";
import { QueuedRun, ActiveRunSlot, RunCreateIdempotencyStatus, QueueRecoveryAudit, StaleRunCleanupAudit, tenantActiveRunLimit, effectiveTenantActiveRunLimit, activeTenantRunIds, queuedTenantRunCount, queuedRunPositions, isSafePersistedRunState, listPersistedRunDirs, findBlockingPersistedRunningRun, readRunStateForScan, activeRunKey, runCreateIdempotencyStatus } from "./runs.js";
import { RunWorkspaceIsolation, ActiveWorkspaceSession, WorkspaceSessionSummary, WORKSPACE_FILE_READ_LIMIT_BYTES, WORKSPACE_FILE_WRITE_LIMIT_BYTES, WORKSPACE_OUTPUT_LIMIT_BYTES, WORKSPACE_SESSION_INPUT_LIMIT_BYTES, DEFAULT_MAX_WORKSPACE_SESSIONS, workspaceSessionLimit, tenantWorkspaceSessionLimit, effectiveTenantWorkspaceSessionLimit, workspaceCommandTimeoutMs, workspaceSessionIdleTimeoutMs, activeWorkspaceSessionDetails, statusActiveWorkspaceSessionDetails, listWorkspaceTenantNames, activeRunWorkspaceKey, activeRunWorkspaceLeaseKey, runWorkspaceIsolation } from "./workspace.js";
import { agentGitServiceProjectAgentsReadiness, readProjectSummary, listTenantProjectNames } from "./projects.js";
import { TenantControlPlaneIdentity, TenantPolicy, TenantPolicyChange, TenantHarnessServerStatus, effectiveTenantAllowedTools, readTenantPolicySync, readTenantPolicy, writeTenantPolicy, tenantPolicyFromUnknown, tenantPolicyReplacementChange, isSafeTenantDirectoryName } from "./tenants.js";
import { HarnessServerOptions, ControlPlaneProviderName, ControlPlaneAgentIdentityMode, HTTP_JSON_BODY_LIMIT_BYTES } from "./http.js";
import { compactObject, policyStatusAccessKeys, isNotFound, startedAt } from "./shared.js";


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

interface SanitizedTenantControlPlaneIdentity {
  provider: string;
  externalActor: string;
  actor: string;
  role: TenantRole;
}

interface ActiveRunResourceStatus extends ActiveRunSlot {
  workspaceLeaseScope: RunWorkspaceIsolation;
  workspaceLeaseKey: string;
}

interface HarnessVisionLock {
  target: string;
  mvpIsScopeReduction: boolean;
  capabilities: string[];
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
    stateBackend: HarnessStateBackendStatus;
    identity?: HarnessIdentityStatus;
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
      oidc?: boolean;
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

interface HarnessStateBackendStatus {
  kind: string;
  metadata: "filesystem" | "postgresql";
  coordination: "filesystem" | "redis";
  distributed: boolean;
  health?: StateBackendHealthSnapshot;
}

interface HarnessIdentityStatus {
  oidc?: OidcHealthSnapshot;
}

interface TenantResourceStatus {
  tenant: string;
  activeRuns: number;
  queuedRuns: number;
  activeWorkspaceSessions: number;
  activeWorkspaceSessionDetails?: WorkspaceSessionSummary[];
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
const CONTROL_PLANE_GIT_TRANSPORT_SAMPLE_REPO = "team/smoke";
const ONLINE_SANDBOX_REQUIRED_TENANT_ROLES: TenantRole[] = ["admin", "developer", "viewer"];
const HARNESS_VISION_LOCK: HarnessVisionLock = {
  ...SHARED_HARNESS_VISION_LOCK,
  capabilities: [...SHARED_HARNESS_VISION_LOCK.capabilities],
};

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
  stateBackendHealth?: StateBackendHealthSnapshot,
  oidcHealth?: OidcHealthSnapshot,
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
      stateBackend: harnessStateBackendStatus(options, stateBackendHealth),
      identity: oidcHealth ? { oidc: oidcHealth } : undefined,
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

function harnessStateBackendStatus(options: HarnessServerOptions, health?: StateBackendHealthSnapshot): HarnessStateBackendStatus {
  if (options.stateBackend?.kind === "postgres-redis") {
    return {
      kind: "postgres-redis",
      metadata: "postgresql",
      coordination: "redis",
      distributed: true,
      health,
    };
  }
  return {
    kind: options.stateBackend?.kind ?? "file",
    metadata: "filesystem",
    coordination: "filesystem",
    distributed: false,
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
      stateBackend: harnessStateBackendStatus(options),
      identity: options.oidcAuthenticator ? { oidc: await options.oidcAuthenticator.ensureReady() } : undefined,
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
    Boolean(options.oidcAuth || options.oidcAuthenticator) ||
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
  const policy = await readTenantPolicy(workspaceRoot, tenant, options);
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
  for (const tenant of await policyStatusAccessTenantNames(workspaceRoot, options)) {
    tenants.add(tenant);
  }
  return [...tenants].sort((a, b) => a.localeCompare(b));
}

async function policyStatusAccessTenantNames(workspaceRoot: string, options: HarnessServerOptions): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) entries = [];
    else throw error;
  }

  const tenants = new Set<string>();
  for (const document of await options.stateBackend?.documents.list<unknown>("tenant-policy") ?? []) {
    if (isSafeTenantDirectoryName(document.key) && tenantPolicyFromUnknown(document.value).apiKeys?.length) tenants.add(document.key);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeTenantDirectoryName(entry.name)) continue;
    if ((await readTenantPolicy(workspaceRoot, entry.name, options))?.apiKeys?.length) tenants.add(entry.name);
  }
  return [...tenants].sort((left, right) => left.localeCompare(right));
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
    ? (await readTenantPolicy(workspaceRoot, tenantScope, options))?.apiKeys ?? []
    : await policyStatusAccessKeys(workspaceRoot, options);
  for (const key of [...configuredKeys, ...policyKeys].filter((entry) => tenantApiKeyIsActive(entry))) {
    roles[key.role] = true;
  }
  const oidc = Boolean(options.oidcAuth || options.oidcAuthenticator);
  if (oidc) {
    roles.admin = true;
    roles.developer = true;
    roles.viewer = true;
  }
  const missingRoles = ONLINE_SANDBOX_REQUIRED_TENANT_ROLES.filter((role) => !roles[role]);
  return {
    ok: missingRoles.length === 0,
    roles,
    missingRoles,
    legacyTokens: tenantScope
      ? Boolean(options.tenantTokens?.[tenantScope])
      : Object.keys(options.tenantTokens ?? {}).length > 0,
    oidc: oidc || undefined,
  };
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
  stateBackendHealth?: StateBackendHealthSnapshot,
  oidcHealth?: OidcHealthSnapshot,
): {
  ready: boolean;
  startedAt: string;
  uptimeMs: number;
  checks: { queueRecovery: string; staleRunCleanup: string; stateBackend?: string; oidc?: string };
  stateBackend?: StateBackendHealthSnapshot;
  oidc?: OidcHealthSnapshot;
} {
  const checks: { queueRecovery: string; staleRunCleanup: string; stateBackend?: string; oidc?: string } = {
    queueRecovery: queueRecovery.status,
    staleRunCleanup: staleRunCleanup.status,
  };
  if (stateBackendHealth) {
    checks.stateBackend = stateBackendHealth.ok
      ? "ready"
      : stateBackendHealth.pending
        ? "pending"
        : stateBackendHealth.stale
          ? "stale"
          : "unavailable";
  }
  if (oidcHealth) checks.oidc = oidcHealth.ready ? "ready" : oidcHealth.failureKind ?? "pending";
  return {
    ready: checks.queueRecovery === "completed" &&
      (checks.staleRunCleanup === "completed" || checks.staleRunCleanup === "disabled") &&
      (stateBackendHealth?.ok ?? true) &&
      (oidcHealth?.ready ?? true),
    startedAt,
    uptimeMs: Math.max(0, Date.now() - Date.parse(startedAt)),
    checks,
    stateBackend: stateBackendHealth,
    oidc: oidcHealth,
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
  stateBackendHealth?: StateBackendHealthSnapshot,
  oidcHealth?: OidcHealthSnapshot,
): Promise<string> {
  const readiness = serverReadiness(startedAt, queueRecovery, staleRunCleanup, stateBackendHealth, oidcHealth);
  const activeRunDetails = await statusActiveRunDetails(workspaceRoot, options, activeRunSlots);
  const activeSessionDetails = await statusActiveWorkspaceSessionDetails(workspaceRoot, options, activeSessions);
  const orphanedRuns = await orphanedRunningRunResourceStatuses(workspaceRoot, activeRunDetails);
  const operationalBacklog = await metricsOperationalBacklog(workspaceRoot, options);
  const metadataHealth = stateBackendHealth?.dependencies.find((dependency) => dependency.name === "metadata");
  const coordinationHealth = stateBackendHealth?.dependencies.find((dependency) => dependency.name === "coordination");
  const oldestQueuedAt = queuedRuns.reduce<number | undefined>((oldest, run) => {
    const queuedAt = Date.parse(run.status.queuedAt);
    if (!Number.isFinite(queuedAt)) return oldest;
    return oldest === undefined ? queuedAt : Math.min(oldest, queuedAt);
  }, undefined);
  const queueOldestAgeSeconds = oldestQueuedAt === undefined ? 0 : Math.max(0, (Date.now() - oldestQueuedAt) / 1_000);
  const tenantRunLimit = options.maxTenantActiveRuns;
  const activeRunCapacityUtilization = tenantRunLimit && tenantRunLimit > 0
    ? Math.max(0, ...tenantResourceStatuses(activeRunDetails, queuedRuns, activeSessionDetails)
      .map((tenant) => tenant.activeRuns / tenantRunLimit))
    : 0;
  const sessionLimit = options.maxWorkspaceSessions ?? DEFAULT_MAX_WORKSPACE_SESSIONS;
  const sessionCapacityUtilization = sessionLimit > 0 ? activeSessionDetails.length / sessionLimit : 0;
  return formatPrometheusMetrics([
    { name: "loom_harness_ready", help: "Whether the harness server readiness probe is ready.", value: readiness.ready ? 1 : 0 },
    { name: "loom_harness_active_runs", help: "Active harness runs across the shared workspace root.", value: activeRunDetails.length },
    { name: "loom_harness_queued_runs", help: "Queued harness runs held in this server queue.", value: queuedRuns.length },
    { name: "loom_harness_queue_oldest_age_seconds", help: "Age of the oldest queued run in seconds.", value: queueOldestAgeSeconds },
    { name: "loom_harness_active_workspace_sessions", help: "Active workspace terminal sessions across the shared workspace root.", value: activeSessionDetails.length },
    { name: "loom_harness_orphaned_running_runs", help: "Persisted running runs without a live admission claim.", value: orphanedRuns.length },
    { name: "loom_harness_expired_run_leases", help: "Persisted running runs whose admission lease has expired.", value: orphanedRuns.filter((run) => run.stale).length },
    { name: "loom_harness_review_required_runs", help: "Runs currently waiting for human review.", value: operationalBacklog.reviewRequiredRuns },
    { name: "loom_harness_deployment_required_runs", help: "Runs currently waiting for deployment approval.", value: operationalBacklog.deploymentRequiredRuns },
    { name: "loom_harness_model_usage_warning_projects", help: "Tenant projects currently above model usage warning thresholds.", value: operationalBacklog.modelUsageWarningProjects },
    { name: "loom_harness_workspace_usage_warning_projects", help: "Tenant projects currently above workspace usage warning thresholds.", value: operationalBacklog.workspaceUsageWarningProjects },
    { name: "loom_harness_queue_recovery_completed", help: "Whether startup queued-run recovery completed.", value: queueRecovery.status === "completed" ? 1 : 0 },
    { name: "loom_harness_queue_recovery_failures", help: "Queued runs that failed startup recovery.", value: queueRecovery.failedQueuedRuns },
    { name: "loom_harness_stale_run_cleanup_ready", help: "Whether stale-run cleanup is completed or disabled.", value: staleRunCleanup.status === "completed" || staleRunCleanup.status === "disabled" ? 1 : 0 },
    { name: "loom_harness_tenant_run_capacity_utilization", help: "Highest tenant active-run capacity utilization ratio.", value: activeRunCapacityUtilization },
    { name: "loom_harness_workspace_session_capacity_utilization", help: "Global workspace-session capacity utilization ratio.", value: sessionCapacityUtilization },
    { name: "loom_harness_state_backend_ready", help: "Whether all configured state backend dependencies are healthy.", value: (stateBackendHealth?.ok ?? true) ? 1 : 0 },
    { name: "loom_harness_oidc_ready", help: "Whether the configured OIDC discovery and JWKS endpoints are ready.", value: (oidcHealth?.ready ?? true) ? 1 : 0 },
    { name: "loom_harness_metadata_dependency_up", help: "Whether the metadata dependency probe succeeds.", value: metadataHealth?.ok === false ? 0 : 1 },
    { name: "loom_harness_metadata_dependency_probe_latency_ms", help: "Latest metadata dependency probe latency in milliseconds.", value: metadataHealth?.latencyMs ?? 0 },
    { name: "loom_harness_metadata_dependency_probe_failures_total", help: "Metadata dependency probe failures since server start.", value: metadataHealth?.failureCount ?? 0, type: "counter" },
    { name: "loom_harness_coordination_dependency_up", help: "Whether the coordination dependency probe succeeds.", value: coordinationHealth?.ok === false ? 0 : 1 },
    { name: "loom_harness_coordination_dependency_probe_latency_ms", help: "Latest coordination dependency probe latency in milliseconds.", value: coordinationHealth?.latencyMs ?? 0 },
    { name: "loom_harness_coordination_dependency_probe_failures_total", help: "Coordination dependency probe failures since server start.", value: coordinationHealth?.failureCount ?? 0, type: "counter" },
  ]);
}

interface MetricsOperationalBacklog {
  reviewRequiredRuns: number;
  deploymentRequiredRuns: number;
  modelUsageWarningProjects: number;
  workspaceUsageWarningProjects: number;
}

async function metricsOperationalBacklog(workspaceRoot: string, options: HarnessServerOptions): Promise<MetricsOperationalBacklog> {
  const backlog: MetricsOperationalBacklog = {
    reviewRequiredRuns: 0,
    deploymentRequiredRuns: 0,
    modelUsageWarningProjects: 0,
    workspaceUsageWarningProjects: 0,
  };

  for (const tenant of await listWorkspaceTenantNames(workspaceRoot)) {
    const tenantRoot = join(workspaceRoot, tenant);
    const policyLimits = (await readTenantPolicy(workspaceRoot, tenant, options))?.limits;
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

async function upsertTenantControlPlaneIdentity(
  workspaceRoot: string,
  tenant: string,
  identity: TenantControlPlaneIdentity,
  options: HarnessServerOptions,
): Promise<{ policy: TenantPolicy; policyChange?: TenantPolicyChange }> {
  const existing = await readTenantPolicy(workspaceRoot, tenant, options);
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
  if (policyChange) await writeTenantPolicy(workspaceRoot, tenant, policy, options);
  return { policy, policyChange };
}
	
function controlPlaneProviderNameField(data: Record<string, unknown>, key: string): ControlPlaneProviderCatalogName | undefined {
  const value = data[key];
  return typeof value === "string" && controlPlaneProviderCatalogEntry(value)
    ? value as ControlPlaneProviderCatalogName
    : undefined;
}

function tenantControlPlaneIdentityKey(identity: SanitizedTenantControlPlaneIdentity): string {
  return `${identity.provider}\0${identity.externalActor}\0${identity.actor}\0${identity.role}`;
}

export { HarnessControlPlaneStatus, SanitizedTenantControlPlaneIdentity, ActiveRunResourceStatus, HarnessVisionLock, HarnessServerStatus, HarnessProfileReadiness, HarnessStateBackendStatus, HarnessIdentityStatus, QueuedRunResourceStatus, OrphanedRunningRunResourceStatus, activeRunResourceStatuses, statusActiveRunDetails, queuedRunResourceStatus, harnessServerStatus, harnessTenantServerStatus, harnessControlPlaneStatus, controlPlaneProviderName, controlPlaneIssueUrl, publicControlPlaneBaseUrl, publicUrl, requireSafeLocalExecutorOptions, serverHealth, serverReadiness, serverMetrics, upsertTenantControlPlaneIdentity, controlPlaneProviderNameField, tenantControlPlaneIdentityKey };
