import { type Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type QueuedRunBlockedReason, type QueuedRunConcurrencySummary, type RunningRunStatus } from "../run-state.js";
import { HarnessRunStart, RunCreateIdempotencyStatus, RUN_PAUSE_REQUEST_FILE, RUN_CANCEL_REQUEST_FILE, RUN_CONTROL_POLL_INTERVAL_MS, tenantActiveRunLimit, effectiveTenantActiveRunLimit, tenantRunCapacityScope, activeTenantRunCount, queuedRunConcurrencySummary, runCreateIdempotencyStatus } from "./runs.js";
import { RunWorkspaceIsolation, HarnessWorkspaceContext, ActiveWorkspaceSession, WorkspaceSessionSummary, workspaceSessionLimit, tenantWorkspaceSessionLimit, effectiveTenantWorkspaceSessionLimit, runWorkspacesAreIsolated, runWorkspaceIsolation } from "./workspace.js";
import { HarnessServerOptions } from "./types.js";
import { delay, compactObject, writeJsonFileAtomic, isSafeDirectoryName, conflict, isNotFound, isAlreadyExists } from "./shared.js";


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
  runControl: {
    crossServer: true;
    requestFiles: [typeof RUN_PAUSE_REQUEST_FILE, typeof RUN_CANCEL_REQUEST_FILE];
    ownerLoopPollMs: typeof RUN_CONTROL_POLL_INTERVAL_MS;
  };
  idempotency: RunCreateIdempotencyStatus;
}

interface QueuedRunAdmission {
  blockedReason: QueuedRunBlockedReason;
  concurrency: QueuedRunConcurrencySummary;
  blockedByRunIds?: string[];
  limit?: number;
}
const DEFAULT_RUN_LEASE_TTL_MS = 120_000;
const RUN_ADMISSION_DIR = ".admission";
const PROJECT_RUN_ADMISSION_LOCK_FILE = "project.lock.json";
const TENANT_ADMISSION_DIR = "admission";
const TENANT_ACTIVE_RUN_ADMISSION_DIR = "active-runs";
const TENANT_ACTIVE_RUN_ADMISSION_LOCK_DIR = "active-runs.lock";
const WORKSPACE_SESSION_ADMISSION_DIR = "workspace-sessions";
const WORKSPACE_SESSION_ADMISSION_LOCK_DIR = "workspace-sessions.lock";
const TENANT_WORKSPACE_SESSION_ADMISSION_DIR = WORKSPACE_SESSION_ADMISSION_DIR;
const TENANT_WORKSPACE_SESSION_ADMISSION_LOCK_DIR = WORKSPACE_SESSION_ADMISSION_LOCK_DIR;

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
  if (options.stateBackend) {
    const claim = runAdmissionClaimFor(run, options);
    const key = runAdmissionBackendKey(claim);
    const owner = runAdmissionBackendOwner(run.runId);
    const lease = await options.stateBackend.leases.acquire(key, owner, runLeaseTtlMs(options), claim);
    if (!lease) {
      const blocking = await options.stateBackend.leases.get<RunAdmissionClaim>(key);
      return { ok: false, runId: blocking?.value.runId ?? "unknown" };
    }
    return {
      ok: true,
      handle: {
        claim,
        refresh: async () => {
          const refreshed = await options.stateBackend?.leases.refresh(key, owner, runLeaseTtlMs(options));
          if (!refreshed) throw new Error(`run admission lease lost: ${claim.runId}`);
        },
        release: async () => {
          await options.stateBackend?.leases.release(key, owner);
        },
      },
    };
  }
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

function runAdmissionBackendKey(claim: RunAdmissionClaim): string {
  return claim.scope === "run"
    ? `run-admission:${claim.tenant}:${claim.project}:${claim.runId}`
    : `run-admission:${claim.tenant}:${claim.project}`;
}

function runAdmissionBackendOwner(runId: string): string {
  return `run:${runId}`;
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
  if (current?.runId !== claim.runId) throw new Error(`run admission lease lost: ${claim.runId}`);
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
  if (options.stateBackend) {
    const claim = tenantRunAdmissionClaimFor(run, limit, options);
    const scope = tenantRunCapacityScope(run.tenant);
    const owner = runAdmissionBackendOwner(run.runId);
    const result = await options.stateBackend.capacityLeases.acquire(scope, run.runId, owner, limit, runLeaseTtlMs(options), claim);
    if (!result.lease) {
      return {
        ok: false,
        runIds: result.active.map((lease) => (lease.value as TenantRunAdmissionClaim).runId).sort((a, b) => a.localeCompare(b)),
        limit,
      };
    }
    return {
      ok: true,
      handle: {
        claim,
        refresh: async () => {
          const refreshed = await options.stateBackend?.capacityLeases.refresh(scope, run.runId, owner, runLeaseTtlMs(options));
          if (!refreshed) throw new Error(`tenant run capacity lease lost: ${claim.runId}`);
        },
        release: async () => {
          await options.stateBackend?.capacityLeases.release(scope, run.runId, owner);
        },
      },
    };
  }
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
  if (options.stateBackend) {
    const leases = await options.stateBackend.capacityLeases.list<TenantRunAdmissionClaim>(tenantRunCapacityScope(tenant));
    return leases.map((lease) => lease.value.runId).sort((a, b) => a.localeCompare(b));
  }
  const root = tenantRunAdmissionRoot(options, tenant);
  let entries: Dirent[];
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
  if (current?.runId !== claim.runId) throw new Error(`tenant run capacity lease lost: ${claim.runId}`);
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
  if (options.stateBackend) {
    return acquireWorkspaceSessionCapacityLease(options, "workspace-sessions:global", context, route, sessionId, limit);
  }
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
  if (options.stateBackend) {
    return acquireWorkspaceSessionCapacityLease(options, `workspace-sessions:tenant:${context.tenant}`, context, route, sessionId, limit);
  }
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

async function acquireWorkspaceSessionCapacityLease(
  options: HarnessServerOptions,
  scope: string,
  context: Pick<HarnessWorkspaceContext, "tenant" | "project">,
  route: ActiveWorkspaceSession["route"],
  sessionId: string,
  limit: number,
): Promise<WorkspaceSessionAdmissionClaimResult> {
  const backend = options.stateBackend;
  if (!backend) throw new Error("state backend is required for capacity lease acquisition");
  const claim = workspaceSessionAdmissionClaimFor(context, route, sessionId, limit, options);
  const owner = `session:${sessionId}`;
  const result = await backend.capacityLeases.acquire(scope, sessionId, owner, limit, runLeaseTtlMs(options), claim);
  if (!result.lease) {
    return {
      ok: false,
      sessionIds: result.active.map((lease) => (lease.value as WorkspaceSessionAdmissionClaim).sessionId).sort((a, b) => a.localeCompare(b)),
      limit,
    };
  }
  return {
    ok: true,
    handle: {
      claim,
      refresh: async () => {
        const refreshed = await backend.capacityLeases.refresh(scope, sessionId, owner, runLeaseTtlMs(options));
        if (!refreshed) throw new Error(`workspace session capacity lease lost: ${sessionId}`);
      },
      release: async () => {
        await backend.capacityLeases.release(scope, sessionId, owner);
      },
    },
  };
}

async function activeWorkspaceSessionAdmissionClaimIds(
  options: HarnessServerOptions,
  root: string,
  includeClaim: (claim: WorkspaceSessionAdmissionClaim) => boolean = () => true,
): Promise<string[]> {
  let entries: Dirent[];
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
  if (current?.sessionId !== claim.sessionId) throw new Error(`workspace session admission lease lost: ${claim.sessionId}`);
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

function startWorkspaceSessionAdmissionClaimHeartbeat(
  options: HarnessServerOptions,
  claim: WorkspaceSessionAdmissionClaimHandle,
  onFailure: (error: unknown) => void,
): () => void {
  return startAdmissionClaimHeartbeat(options, () => claim.refresh(), onFailure);
}

function startRunAdmissionClaimHeartbeat(
  options: HarnessServerOptions,
  claim: RunAdmissionClaimHandle,
  onFailure: (error: unknown) => void,
): () => void {
  return startAdmissionClaimHeartbeat(options, () => claim.refresh(), onFailure);
}

function startAdmissionClaimHeartbeat(
  options: HarnessServerOptions,
  refresh: () => Promise<void>,
  onFailure: (error: unknown) => void,
): () => void {
  let stopped = false;
  let refreshing = false;
  let heartbeat: ReturnType<typeof setInterval>;
  const stop = () => {
    stopped = true;
    clearInterval(heartbeat);
  };
  heartbeat = setInterval(() => {
    if (stopped || refreshing) return;
    refreshing = true;
    void refresh()
      .catch((error) => {
        stop();
        onFailure(error);
      })
      .finally(() => {
        refreshing = false;
      });
  }, runHeartbeatIntervalMs(options));
  heartbeat.unref?.();
  return stop;
}

function runAdmissionHeartbeatError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`run admission heartbeat failed: ${message}`);
}

async function persistedRunningRunHasActiveAdmissionClaim(
  options: HarnessServerOptions,
  runDir: string,
  state: RunningRunStatus,
): Promise<boolean> {
  if (options.stateBackend) {
    const expected = runAdmissionClaimFor(state, options);
    const lease = await options.stateBackend.leases.get<RunAdmissionClaim>(runAdmissionBackendKey(expected));
    const claim = lease?.value;
    return claim?.tenant === state.tenant
      && claim.project === state.project
      && claim.runId === state.runId
      && !runAdmissionClaimIsStale(claim);
  }
  const claim = await readRunAdmissionClaim(runAdmissionLockPath(options, {
    runRoot: dirname(runDir),
    runId: state.runId,
  }));
  return claim?.tenant === state.tenant
    && claim.project === state.project
    && claim.runId === state.runId
    && !runAdmissionClaimIsStale(claim);
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

async function workspaceSessionHasActiveAdmissionClaim(
  options: HarnessServerOptions,
  summary: WorkspaceSessionSummary,
): Promise<boolean> {
  if (options.stateBackend) {
    const scopes = ["workspace-sessions:global", `workspace-sessions:tenant:${summary.tenant}`];
    const claims = (await Promise.all(scopes.map((scope) => options.stateBackend?.capacityLeases.list<WorkspaceSessionAdmissionClaim>(scope) ?? []))).flat();
    return claims.some((lease) => workspaceSessionAdmissionClaimMatchesSummary(lease.value, summary));
  }
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
    runControl: {
      crossServer: true,
      requestFiles: [RUN_PAUSE_REQUEST_FILE, RUN_CANCEL_REQUEST_FILE],
      ownerLoopPollMs: RUN_CONTROL_POLL_INTERVAL_MS,
    },
    idempotency: runCreateIdempotencyStatus(),
  };
}

export { RunAdmissionClaimHandle, WorkspaceSessionAdmissionClaimHandle, HarnessConcurrencyAdmissionStatus, QueuedRunAdmission, runLeaseTtlMs, runHeartbeatIntervalMs, runningRunStatusWithLease, refreshRunningRunLease, runningRunIsStale, activeTenantRunAdmissionClaimIds, tryAcquireActiveRunAdmission, tryAcquireWorkspaceSessionAdmissionClaims, startWorkspaceSessionAdmissionClaimHeartbeat, startRunAdmissionClaimHeartbeat, runAdmissionHeartbeatError, persistedRunningRunHasActiveAdmissionClaim, queuedAdmissionTenantActiveRunLimit, queuedAdmissionProjectActiveWorkspace, queuedAdmissionPersistedRunningRun, queuedAdmissionReady, workspaceSessionHasActiveAdmissionClaim, queuedAdmissionAuditData, harnessConcurrencyAdmissionStatus };
