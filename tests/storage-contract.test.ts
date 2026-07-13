import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTenantAuditAppender, readTenantAuditEvents } from "../src/harness/audit.js";
import { createHarnessHttpServer } from "../src/harness/server.js";
import { StateConflictError } from "../src/harness/storage/contracts.js";
import { createFileStateBackend } from "../src/harness/storage/file.js";

async function stateBackend() {
  const rootDir = await mkdtemp(join(tmpdir(), "loom-state-contract-"));
  return { rootDir, backend: createFileStateBackend({ rootDir }) };
}

test("file document store supports versioned compare-and-swap", async () => {
  const { backend } = await stateBackend();
  const created = await backend.documents.put("tenant-policy", "alice", { limit: 1 }, { expectedVersion: 0 });
  assert.equal(created.version, 1);

  const updated = await backend.documents.put("tenant-policy", "alice", { limit: 2 }, { expectedVersion: 1 });
  assert.equal(updated.version, 2);
  assert.deepEqual((await backend.documents.get("tenant-policy", "alice"))?.value, { limit: 2 });

  await assert.rejects(
    () => backend.documents.put("tenant-policy", "alice", { limit: 3 }, { expectedVersion: 1 }),
    StateConflictError,
  );
});

test("file event store preserves one sequence under concurrent appends", async () => {
  const { backend } = await stateBackend();
  await Promise.all(Array.from({ length: 50 }, (_, index) => backend.events.append("run:one", { index })));
  const events = await backend.events.read<{ index: number }>("run:one");
  assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 50 }, (_, index) => index + 1));
  assert.deepEqual(events.map((event) => event.value.index).sort((a, b) => a - b), Array.from({ length: 50 }, (_, index) => index));
});

test("file lease store enforces ownership and expiry", async () => {
  const { backend } = await stateBackend();
  const acquired = await backend.leases.acquire("run:alice:one", "server-a", 25, { runId: "one" });
  assert.equal(acquired?.owner, "server-a");
  assert.equal(await backend.leases.acquire("run:alice:one", "server-b", 25, { runId: "one" }), undefined);
  assert.equal(await backend.leases.release("run:alice:one", "server-b"), false);

  await new Promise((resolve) => setTimeout(resolve, 35));
  const recovered = await backend.leases.acquire("run:alice:one", "server-b", 25, { runId: "one" });
  assert.equal(recovered?.owner, "server-b");
  assert.equal(await backend.leases.release("run:alice:one", "server-b"), true);
});

test("file capacity leases enforce an atomic scope limit", async () => {
  const { backend } = await stateBackend();
  const [first, second] = await Promise.all([
    backend.capacityLeases.acquire("tenant:alice:runs", "one", "server-a", 1, 50, { runId: "one" }),
    backend.capacityLeases.acquire("tenant:alice:runs", "two", "server-b", 1, 50, { runId: "two" }),
  ]);
  assert.equal([first.lease, second.lease].filter(Boolean).length, 1);
  assert.equal((await backend.capacityLeases.list("tenant:alice:runs")).length, 1);

  const winner = first.lease ? { key: "one", owner: "server-a" } : { key: "two", owner: "server-b" };
  assert.equal(await backend.capacityLeases.release("tenant:alice:runs", winner.key, winner.owner), true);
  assert.equal((await backend.capacityLeases.list("tenant:alice:runs")).length, 0);
});

test("capacity lease cannot be inherited by a different owner", async () => {
  const { backend } = await stateBackend();
  assert.ok((await backend.capacityLeases.acquire("tenant:alice:runs", "one", "server-a", 1, 50, { runId: "one" })).lease);
  assert.equal((await backend.capacityLeases.acquire("tenant:alice:runs", "one", "server-b", 1, 50, { runId: "one" })).lease, undefined);
});

test("file queue store supports claim, release, expiry recovery, and acknowledge", async () => {
  const { backend } = await stateBackend();
  await backend.queues.enqueue("runs:alice", "one", { goal: "first" });
  await backend.queues.enqueue("runs:alice", "two", { goal: "second" });

  // Ownership semantics — a long TTL so the interleaved file I/O below can never
  // expire the lease mid-test (a 25ms TTL flaked here under CI load).
  const first = await backend.queues.claim<{ goal: string }>("runs:alice", "one", "server-a", 5_000);
  assert.equal(first?.id, "one");
  assert.equal(await backend.queues.claim("runs:alice", "one", "server-b", 5_000), undefined);
  assert.equal(await backend.queues.release("runs:alice", "one", "server-b"), false);
  assert.equal(await backend.queues.acknowledge("runs:alice", "one", "server-a"), true);

  // Expiry recovery — short TTL, then sleep well past it so timer jitter on CI
  // still leaves a wide margin before the re-claim.
  const second = await backend.queues.claimNext<{ goal: string }>("runs:alice", "server-a", 25);
  assert.equal(second?.id, "two");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await backend.queues.claimNext("runs:alice", "server-b", 25))?.id, "two");
  assert.equal(await backend.queues.acknowledge("runs:alice", "two", "server-b"), true);
  assert.deepEqual(await backend.queues.list("runs:alice"), []);
});

test("tenant audit can use the shared event store contract", async () => {
  const { rootDir, backend } = await stateBackend();
  const append = createTenantAuditAppender(rootDir, backend.events);
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    append("alice", "brain_signal_ingested", { index }, { actor: "ops", role: "admin" }),
  ));

  const events = await readTenantAuditEvents(rootDir, "alice", backend.events);
  assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.ok(events.every((event) => event.actor === "ops" && event.role === "admin"));
});

test("harness aborts an active run when its admission heartbeat is lost", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "loom-state-heartbeat-"));
  const backend = createFileStateBackend({ rootDir: join(rootDir, "state") });
  backend.leases.refresh = async <T>() => undefined;
  const server = createHarnessHttpServer({
    workspaceRoot: join(rootDir, "workspaces"),
    allowUnsafeLocalExecutor: true,
    allowedTools: ["shell.exec", "verify.run"],
    runLeaseTtlMs: 60,
    stateBackend: backend,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address!.port}`;

  try {
    const started = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        async: true,
        tenant: "alice",
        project: "heartbeat",
        goal: "stop after lease loss",
        script: [
          { message: "hold", actions: [{ toolName: "shell.exec", input: { command: "sleep 5" } }] },
          { message: "finish", finish: true },
        ],
        verify: [],
      }),
    });
    assert.equal(started.status, 202);
    const runId = String((await started.json()).runId);
    // Generous headroom (~300x the 60ms lease TTL): lease-loss abort should fire
    // well within this. A failure here now signals a real abort bug, not CI load.
    await waitForRunStatus(baseUrl, "alice", "heartbeat", runId, "cancelled", 20_000);
    const events = await backend.events.read<Record<string, unknown>>(`run-events:${runId}`);
    const cancel = events.find((event) => event.value.type === "cancel");
    const cancelData = cancel?.value.data as { reason?: string } | undefined;
    assert.match(String(cancelData?.reason), /run admission heartbeat failed/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await backend.close();
  }
});

async function waitForRunStatus(
  baseUrl: string,
  tenant: string,
  project: string,
  runId: string,
  expected: string,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/tenants/${tenant}/runs/${runId}?project=${project}`);
    if (response.ok) {
      last = await response.json() as Record<string, unknown>;
      if (last.status === expected) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`run ${runId} did not reach ${expected}; last state: ${JSON.stringify(last)}`);
}
