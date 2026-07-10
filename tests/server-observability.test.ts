import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createStateBackendHealthMonitor,
  formatPrometheusMetrics,
} from "../src/harness/server-observability.js";
import { createHarnessHttpServer } from "../src/harness/server.js";
import type { PlatformStateBackend } from "../src/harness/storage/contracts.js";

test("state backend health monitor probes metadata and coordination without exposing errors", async () => {
  let now = Date.parse("2026-07-10T00:00:00.000Z");
  const backend = fakeBackend();
  const monitor = createStateBackendHealthMonitor(backend, {
    probeIntervalMs: 100,
    probeTimeoutMs: 50,
    maxStalenessMs: 500,
    now: () => now,
  });

  const first = await monitor.probeNow();
  assert.equal(first.ok, true);
  assert.equal(first.pending, false);
  assert.equal(first.stale, false);
  assert.deepEqual(first.dependencies.map((dependency) => ({
    name: dependency.name,
    backend: dependency.backend,
    ok: dependency.ok,
    probeCount: dependency.probeCount,
    failureCount: dependency.failureCount,
  })), [
    { name: "metadata", backend: "postgresql", ok: true, probeCount: 1, failureCount: 0 },
    { name: "coordination", backend: "redis", ok: true, probeCount: 1, failureCount: 0 },
  ]);

  now += 501;
  const stale = monitor.snapshot();
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.dependencies.map((dependency) => dependency.failureKind), ["stale", "stale"]);
});

test("state backend health monitor records failures and recovery", async () => {
  let failMetadata = true;
  const backend = fakeBackend({
    async metadataGet() {
      if (failMetadata) throw new Error("postgres://secret-host/private-database");
      return undefined;
    },
  });
  const monitor = createStateBackendHealthMonitor(backend, {
    probeIntervalMs: 100,
    probeTimeoutMs: 50,
    maxStalenessMs: 500,
  });

  const failed = await monitor.probeNow();
  assert.equal(failed.ok, false);
  assert.equal(failed.dependencies[0].failureKind, "unavailable");
  assert.equal(failed.dependencies[0].failureCount, 1);
  assert.equal(JSON.stringify(failed).includes("secret-host"), false);

  failMetadata = false;
  const recovered = await monitor.probeNow();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.dependencies[0].failureCount, 1);
  assert.equal(recovered.dependencies[0].consecutiveFailures, 0);
  assert.equal(recovered.dependencies[0].failureKind, undefined);
});

test("state backend health monitor enforces dependency probe timeouts", async () => {
  const backend = fakeBackend({
    metadataGet: () => new Promise<undefined>(() => {}),
  });
  const monitor = createStateBackendHealthMonitor(backend, {
    probeIntervalMs: 100,
    probeTimeoutMs: 10,
    maxStalenessMs: 500,
  });

  const failed = await monitor.probeNow();
  assert.equal(failed.ok, false);
  assert.equal(failed.dependencies[0].failureKind, "timeout");
  assert.equal(failed.dependencies[0].failureCount, 1);
});

test("Prometheus formatter preserves metric types and finite values", () => {
  const text = formatPrometheusMetrics([
    { name: "loom_test_ready", help: "Readiness.", value: 1 },
    { name: "loom_test_failures_total", help: "Failures.", value: Number.NaN, type: "counter" },
  ]);
  assert.match(text, /# TYPE loom_test_ready gauge/);
  assert.match(text, /^loom_test_ready 1$/m);
  assert.match(text, /# TYPE loom_test_failures_total counter/);
  assert.match(text, /^loom_test_failures_total 0$/m);
});

test("Prometheus alert rules reference the exported harness metrics", async () => {
  const rules = await readFile(new URL("../deploy/observability/loom-alerts.yml", import.meta.url), "utf8");
  const exportedMetrics = [
    "loom_harness_ready",
    "loom_harness_state_backend_ready",
    "loom_harness_oidc_ready",
    "loom_harness_metadata_dependency_up",
    "loom_harness_coordination_dependency_up",
    "loom_harness_queue_oldest_age_seconds",
    "loom_harness_tenant_run_capacity_utilization",
    "loom_harness_workspace_session_capacity_utilization",
    "loom_harness_expired_run_leases",
    "loom_harness_queue_recovery_failures",
    "loom_harness_metadata_dependency_probe_failures_total",
    "loom_harness_coordination_dependency_probe_failures_total",
  ];
  for (const metric of exportedMetrics) assert.match(rules, new RegExp(`\\b${metric}\\b`));
  assert.equal((rules.match(/runbook: docs\/slo\.md#alerts/g) ?? []).length, 12);
});

test("HTTP readiness fails closed when a state dependency probe fails", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "loom-observability-"));
  const backend = fakeBackend({
    async metadataGet() {
      throw new Error("postgres://secret-host/private-database");
    },
  });
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    stateBackend: backend,
    stateDependencyProbeIntervalMs: 10,
    stateDependencyProbeTimeoutMs: 50,
    stateDependencyProbeMaxStalenessMs: 100,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    let readiness: any;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`${baseUrl}/readyz`);
      readiness = await response.json();
      if (readiness.checks.queueRecovery === "completed") {
        assert.equal(response.status, 503);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(readiness.ready, false);
    assert.equal(readiness.checks.stateBackend, "unavailable");
    assert.equal(readiness.stateBackend.dependencies[0].failureKind, "unavailable");
    assert.equal(JSON.stringify(readiness).includes("secret-host"), false);

    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    assert.match(metrics, /^loom_harness_state_backend_ready 0$/m);
    assert.match(metrics, /^loom_harness_metadata_dependency_up 0$/m);
    assert.match(metrics, /^loom_harness_metadata_dependency_probe_failures_total [1-9]\d*$/m);
    assert.equal(metrics.includes("secret-host"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await backend.close();
  }
});

function fakeBackend(options: { metadataGet?: () => Promise<undefined> } = {}): PlatformStateBackend {
  return {
    kind: "postgres-redis",
    documents: {
      get: options.metadataGet ?? (async () => undefined),
      async put(namespace, key, value) {
        return { namespace, key, value, version: 1, updatedAt: new Date().toISOString() };
      },
      async delete() {
        return false;
      },
      async list() {
        return [];
      },
    },
    events: {
      async append(stream, value) {
        return { stream, value, seq: 1, ts: new Date().toISOString() };
      },
      async read() {
        return [];
      },
    },
    leases: {
      async acquire() {
        return undefined;
      },
      async refresh() {
        return undefined;
      },
      async release() {
        return false;
      },
      async get() {
        return undefined;
      },
      async list() {
        return [];
      },
    },
    capacityLeases: {
      async acquire(_scope, _key, _owner, limit) {
        return { active: [], limit };
      },
      async refresh() {
        return undefined;
      },
      async release() {
        return false;
      },
      async list() {
        return [];
      },
    },
    queues: {
      async enqueue(queue, id, value) {
        return { queue, id, value, enqueuedAt: new Date().toISOString() };
      },
      async claim() {
        return undefined;
      },
      async claimNext() {
        return undefined;
      },
      async release() {
        return false;
      },
      async acknowledge() {
        return false;
      },
      async list() {
        return [];
      },
    },
    async close() {},
  };
}
