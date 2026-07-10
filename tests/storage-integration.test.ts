import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { createClient } from "redis";
import test from "node:test";

import { createPostgresRedisStateBackend } from "../src/harness/storage/index.js";
import { createHarnessHttpServer } from "../src/harness/server.js";

const postgresUrl = process.env.LOOM_TEST_POSTGRES_URL;
const redisUrl = process.env.LOOM_TEST_REDIS_URL;

test("PostgreSQL and Redis backend satisfies durable state contracts", {
  skip: !postgresUrl || !redisUrl ? "LOOM_TEST_POSTGRES_URL and LOOM_TEST_REDIS_URL are required" : false,
}, async () => {
  const suffix = `${Date.now()}_${process.pid}`;
  const schema = `loom_test_${suffix}`;
  const prefix = `loom-test-${suffix}`;
  const backend = await createPostgresRedisStateBackend({
    postgres: { connectionString: postgresUrl, schema },
    redis: { url: redisUrl!, prefix },
  });

  try {
    const document = await backend.documents.put("policy", "alice", { maxRuns: 2 }, { expectedVersion: 0 });
    assert.equal(document.version, 1);
    assert.deepEqual((await backend.documents.get("policy", "alice"))?.value, { maxRuns: 2 });

    await Promise.all(Array.from({ length: 30 }, (_, index) => backend.events.append("tenant-audit:alice", { index })));
    const events = await backend.events.read<{ index: number }>("tenant-audit:alice");
    assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 30 }, (_, index) => index + 1));

    assert.equal((await backend.leases.acquire("run:alice:one", "server-a", 5_000, { runId: "one" }))?.owner, "server-a");
    assert.equal(await backend.leases.acquire("run:alice:one", "server-b", 5_000, { runId: "one" }), undefined);
    assert.equal(await backend.leases.release("run:alice:one", "server-a"), true);

    const capacity = await Promise.all([
      backend.capacityLeases.acquire("tenant:alice:runs", "one", "server-a", 1, 5_000, { runId: "one" }),
      backend.capacityLeases.acquire("tenant:alice:runs", "two", "server-b", 1, 5_000, { runId: "two" }),
    ]);
    assert.equal(capacity.filter((result) => result.lease).length, 1);

    const owned = await backend.capacityLeases.acquire("tenant:alice:owned", "one", "server-a", 1, 5_000, { runId: "one" });
    assert.ok(owned.lease);
    assert.equal((await backend.capacityLeases.acquire("tenant:alice:owned", "one", "server-b", 1, 5_000, { runId: "one" })).lease, undefined);

    await backend.queues.enqueue("runs:alice", "one", { goal: "first" });
    const claimed = await backend.queues.claim<{ goal: string }>("runs:alice", "one", "server-a", 5_000);
    assert.equal(claimed?.id, "one");
    assert.equal(await backend.queues.acknowledge("runs:alice", "one", "server-a"), true);

    await backend.queues.enqueue("runs:alice", "empty-array", []);
    const claimedArray = await backend.queues.claim<unknown[]>("runs:alice", "empty-array", "server-a", 5_000);
    assert.deepEqual(claimedArray?.value, []);
    assert.equal(await backend.queues.acknowledge("runs:alice", "empty-array", "server-a"), true);
  } finally {
    await backend.close();
    const pool = new Pool({ connectionString: postgresUrl });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    const redis = createClient({ url: redisUrl! });
    await redis.connect();
    const keys: string[] = [];
    for await (const batch of redis.scanIterator({ MATCH: `${prefix}:*`, COUNT: 200 })) keys.push(...batch.map(String));
    if (keys.length) await redis.del(keys);
    await redis.quit();
  }
});

test("two harness servers coordinate admission, queue recovery, and audit", {
  skip: !postgresUrl || !redisUrl ? "LOOM_TEST_POSTGRES_URL and LOOM_TEST_REDIS_URL are required" : false,
}, async () => {
  const suffix = `${Date.now()}_${process.pid}`;
  const schema = `loom_http_${suffix}`;
  const prefix = `loom-http-${suffix}`;
  const workspaceRoot = await mkdtemp(join(tmpdir(), "loom-state-http-"));
  const [backendA, backendB] = await Promise.all([
    createPostgresRedisStateBackend({ postgres: { connectionString: postgresUrl, schema }, redis: { url: redisUrl!, prefix } }),
    createPostgresRedisStateBackend({ postgres: { connectionString: postgresUrl, schema }, redis: { url: redisUrl!, prefix } }),
  ]);
  const first = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    allowedTools: ["file.read", "file.write", "shell.exec", "git.diff", "verify.run"],
    maxTenantActiveRuns: 1,
    stateBackend: backendA,
  });
  const second = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    allowedTools: ["file.read", "file.write", "shell.exec", "git.diff", "verify.run"],
    maxTenantActiveRuns: 1,
    stateBackend: backendB,
  });
  await Promise.all([
    new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => second.listen(0, "127.0.0.1", resolve)),
  ]);
  const firstAddress = first.address();
  const secondAddress = second.address();
  assert.equal(typeof firstAddress, "object");
  assert.equal(typeof secondAddress, "object");
  const firstUrl = `http://127.0.0.1:${firstAddress!.port}`;
  const secondUrl = `http://127.0.0.1:${secondAddress!.port}`;

  try {
    const status = await (await fetch(`${secondUrl}/status`)).json();
    const { health, ...stateBackendTopology } = status.server.stateBackend;
    assert.deepEqual(stateBackendTopology, {
      kind: "postgres-redis",
      metadata: "postgresql",
      coordination: "redis",
      distributed: true,
    });
    assert.equal(health.schemaVersion, "state-backend-health/v1");
    assert.equal(health.ok, true);
    assert.deepEqual(health.dependencies.map((dependency: any) => [dependency.name, dependency.backend, dependency.ok]), [
      ["metadata", "postgresql", true],
      ["coordination", "redis", true],
    ]);

    const readyResponse = await fetch(`${secondUrl}/readyz`);
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json();
    assert.equal(ready.ready, true);
    assert.equal(ready.checks.stateBackend, "ready");

    const metrics = await (await fetch(`${secondUrl}/metrics`)).text();
    assert.match(metrics, /^loom_harness_state_backend_ready 1$/m);
    assert.match(metrics, /^loom_harness_metadata_dependency_up 1$/m);
    assert.match(metrics, /^loom_harness_coordination_dependency_up 1$/m);

    const started = await fetch(`${firstUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        async: true,
        tenant: "alice",
        project: "proj-a",
        goal: "hold distributed lease",
        script: [
          { message: "hold", actions: [{ toolName: "shell.exec", input: { command: "sleep 5" } }] },
          { message: "finish", finish: true },
        ],
        verify: [],
      }),
    });
    assert.equal(started.status, 202);
    const running = await started.json();

    const blocked = await fetch(`${secondUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenant: "alice",
        project: "proj-b",
        goal: "must respect tenant capacity",
        script: [{ message: "finish", finish: true }],
        verify: [],
      }),
    });
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json()).error, new RegExp(running.runId));

    const audit = await (await fetch(`${secondUrl}/tenants/alice/audit`)).json();
    assert.ok(audit.some((event: { type: string; data?: { runId?: string } }) => event.type === "run_created" && event.data?.runId === running.runId));

    const queuedResponse = await fetch(`${firstUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        async: true,
        queue: true,
        tenant: "alice",
        project: "proj-b",
        goal: "recover through shared queue",
        script: [{ message: "finish", finish: true }],
        verify: [],
      }),
    });
    assert.equal(queuedResponse.status, 202);
    const queued = await queuedResponse.json();
    assert.equal(queued.status, "queued");

    const observedQueued = await (await fetch(`${secondUrl}/tenants/alice/runs/${queued.runId}?project=proj-b`)).json();
    assert.equal(observedQueued.status, "queued");

    await new Promise<void>((resolve) => first.close(() => resolve()));
    const recovered = await waitForRunStatus(secondUrl, "alice", "proj-b", queued.runId, "passed").catch(async (error) => {
      const diagnostics = {
        capacity: await backendB.capacityLeases.list("tenant-runs:alice"),
        leases: await backendB.leases.list("run-admission:alice"),
        queue: await backendB.queues.list("harness-runs"),
        server: await (await fetch(`${secondUrl}/status`)).json(),
      };
      throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostics: ${JSON.stringify(diagnostics)}`);
    });
    assert.equal(recovered.status, "passed");
    assert.ok((await backendB.queues.list("harness-runs")).every((item) => item.id !== queued.runId));
  } finally {
    await Promise.all([
      closeServer(first),
      new Promise<void>((resolve) => second.close(() => resolve())),
    ]);
    await Promise.all([backendA.close(), backendB.close()]);
    const pool = new Pool({ connectionString: postgresUrl });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    const redis = createClient({ url: redisUrl! });
    await redis.connect();
    const keys: string[] = [];
    for await (const batch of redis.scanIterator({ MATCH: `${prefix}:*`, COUNT: 200 })) keys.push(...batch.map(String));
    if (keys.length) await redis.del(keys);
    await redis.quit();
  }
});

async function waitForRunStatus(
  baseUrl: string,
  tenant: string,
  project: string,
  runId: string,
  expected: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/tenants/${tenant}/runs/${runId}?project=${project}`);
    if (response.ok) {
      last = await response.json() as Record<string, unknown>;
      if (last.status === expected) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`run ${runId} did not reach ${expected}; last state: ${JSON.stringify(last)}`);
}

async function closeServer(server: ReturnType<typeof createHarnessHttpServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
