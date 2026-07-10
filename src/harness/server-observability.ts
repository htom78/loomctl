import type { PlatformStateBackend } from "./storage/contracts.js";

export type StateDependencyName = "metadata" | "coordination";
export type StateDependencyFailureKind = "pending" | "timeout" | "unavailable" | "stale";

export interface StateDependencyHealth {
  name: StateDependencyName;
  backend: "filesystem" | "postgresql" | "redis";
  ok: boolean;
  checkedAt?: string;
  latencyMs?: number;
  probeCount: number;
  failureCount: number;
  consecutiveFailures: number;
  failureKind?: StateDependencyFailureKind;
}

export interface StateBackendHealthSnapshot {
  schemaVersion: "state-backend-health/v1";
  ok: boolean;
  pending: boolean;
  stale: boolean;
  checkedAt?: string;
  probeIntervalMs: number;
  probeTimeoutMs: number;
  maxStalenessMs: number;
  dependencies: StateDependencyHealth[];
}

export interface StateBackendHealthMonitorOptions {
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  maxStalenessMs?: number;
  now?: () => number;
}

export interface StateBackendHealthMonitor {
  start(): void;
  stop(): void;
  probeNow(): Promise<StateBackendHealthSnapshot>;
  ensureFresh(): Promise<StateBackendHealthSnapshot>;
  snapshot(): StateBackendHealthSnapshot;
}

export interface PrometheusMetric {
  name: string;
  help: string;
  value: number;
  type?: "gauge" | "counter";
}

const DEFAULT_PROBE_INTERVAL_MS = 5_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_STALENESS_MS = 15_000;
const HEALTH_NAMESPACE = "system-health";
const HEALTH_KEY = "readiness";
const HEALTH_LEASE_KEY = "system-health/readiness";

export function createStateBackendHealthMonitor(
  backend: PlatformStateBackend,
  options: StateBackendHealthMonitorOptions = {},
): StateBackendHealthMonitor {
  const now = options.now ?? Date.now;
  const probeIntervalMs = positiveDuration(options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS, "probeIntervalMs");
  const probeTimeoutMs = positiveDuration(options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, "probeTimeoutMs");
  const maxStalenessMs = positiveDuration(options.maxStalenessMs ?? DEFAULT_MAX_STALENESS_MS, "maxStalenessMs");
  let dependencies = initialDependencies(backend.kind);
  let checkedAtMs: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<StateBackendHealthSnapshot> | undefined;

  const snapshot = (): StateBackendHealthSnapshot => {
    const pending = checkedAtMs === undefined;
    const stale = checkedAtMs !== undefined && now() - checkedAtMs > maxStalenessMs;
    const observedDependencies = stale
      ? dependencies.map((dependency) => ({ ...dependency, ok: false, failureKind: "stale" as const }))
      : dependencies.map((dependency) => ({ ...dependency }));
    return {
      schemaVersion: "state-backend-health/v1",
      ok: !pending && !stale && observedDependencies.every((dependency) => dependency.ok),
      pending,
      stale,
      checkedAt: checkedAtMs === undefined ? undefined : new Date(checkedAtMs).toISOString(),
      probeIntervalMs,
      probeTimeoutMs,
      maxStalenessMs,
      dependencies: observedDependencies,
    };
  };

  const probeNow = async (): Promise<StateBackendHealthSnapshot> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const results = await Promise.all([
        probeDependency(dependencies[0], () => backend.documents.get(HEALTH_NAMESPACE, HEALTH_KEY), probeTimeoutMs, now),
        probeDependency(dependencies[1], () => backend.leases.get(HEALTH_LEASE_KEY), probeTimeoutMs, now),
      ]);
      dependencies = results;
      checkedAtMs = now();
      return snapshot();
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    start() {
      if (timer) return;
      void probeNow();
      timer = setInterval(() => void probeNow(), probeIntervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    probeNow,
    async ensureFresh() {
      const current = snapshot();
      if (current.pending || current.stale || checkedAtMs === undefined || now() - checkedAtMs >= probeIntervalMs) {
        return probeNow();
      }
      return current;
    },
    snapshot,
  };
}

export function formatPrometheusMetrics(metrics: PrometheusMetric[]): string {
  const lines: string[] = [];
  for (const metric of metrics) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type ?? "gauge"}`);
    lines.push(`${metric.name} ${finiteMetricValue(metric.value)}`);
  }
  return `${lines.join("\n")}\n`;
}

function initialDependencies(kind: string): StateDependencyHealth[] {
  const distributed = kind === "postgres-redis";
  return [
    pendingDependency("metadata", distributed ? "postgresql" : "filesystem"),
    pendingDependency("coordination", distributed ? "redis" : "filesystem"),
  ];
}

function pendingDependency(name: StateDependencyName, backend: StateDependencyHealth["backend"]): StateDependencyHealth {
  return {
    name,
    backend,
    ok: false,
    probeCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    failureKind: "pending",
  };
}

async function probeDependency(
  previous: StateDependencyHealth,
  operation: () => Promise<unknown>,
  timeoutMs: number,
  now: () => number,
): Promise<StateDependencyHealth> {
  const startedAt = now();
  try {
    await withTimeout(operation(), timeoutMs);
    const checkedAt = now();
    return {
      ...previous,
      ok: true,
      checkedAt: new Date(checkedAt).toISOString(),
      latencyMs: Math.max(0, checkedAt - startedAt),
      probeCount: previous.probeCount + 1,
      consecutiveFailures: 0,
      failureKind: undefined,
    };
  } catch (error) {
    const checkedAt = now();
    return {
      ...previous,
      ok: false,
      checkedAt: new Date(checkedAt).toISOString(),
      latencyMs: Math.max(0, checkedAt - startedAt),
      probeCount: previous.probeCount + 1,
      failureCount: previous.failureCount + 1,
      consecutiveFailures: previous.consecutiveFailures + 1,
      failureKind: error instanceof ProbeTimeoutError ? "timeout" : "unavailable",
    };
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class ProbeTimeoutError extends Error {}

function positiveDuration(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 300_000) {
    throw new Error(`${label} must be an integer between 1 and 300000`);
  }
  return value;
}

function finiteMetricValue(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
