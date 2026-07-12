import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LOOM_API_VERSION,
  LOOM_CLIENT_CAPABILITIES,
  LoomCapabilityError,
  LoomClient,
  parseSseStream,
  type TenantStatus,
} from "../packages/loom-api/src/index.js";
import { createHarnessHttpServer } from "../src/harness/server.js";
import { LOOM_API_CAPABILITIES } from "../src/harness/server/status.js";

const tenantStatus: TenantStatus = {
  tenant: "alice",
  api: { version: LOOM_API_VERSION, capabilities: [...LOOM_CLIENT_CAPABILITIES] },
  server: { startedAt: "2026-07-12T00:00:00.000Z", uptimeMs: 1, runWorkspaceIsolation: "run" },
  readiness: { ok: true, missing: [] },
  resources: { activeRuns: 0, queuedRuns: 0, activeWorkspaceSessions: 0 },
  policy: { allowedTools: [] },
};

test("Loom API client and server advertise the same contract", () => {
  assert.equal(LOOM_API_VERSION, "v1");
  assert.deepEqual([...LOOM_CLIENT_CAPABILITIES], [...LOOM_API_CAPABILITIES]);
});

test("LoomClient authenticates with a header and never puts the token in the URL", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const client = new LoomClient({
    baseUrl: "https://loom.example.test/",
    token: "top-secret-token",
    fetch: async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json(tenantStatus);
    },
  });

  await client.tenantStatus("alice");

  assert.equal(requests[0].url, "https://loom.example.test/tenants/alice/status");
  assert.equal(requests[0].headers.get("authorization"), "Bearer top-secret-token");
  assert.equal(requests[0].headers.get("content-type"), null);
  assert.doesNotMatch(requests[0].url, /top-secret-token/);
});

test("LoomClient rejects a server missing a required capability", async () => {
  const client = new LoomClient({
    baseUrl: "https://loom.example.test",
    token: "secret",
    fetch: async () => Response.json({ ...tenantStatus, api: { version: "v1", capabilities: ["tenant-status"] } }),
  });

  await assert.rejects(
    client.negotiate("alice", ["run-events-sse"]),
    (error) => error instanceof LoomCapabilityError && error.missing[0] === "run-events-sse",
  );
});

test("parseSseStream handles chunk boundaries and multiline data", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("id: 7\r\nevent: harness\r\ndata: {\"seq\":7,\r"));
      controller.enqueue(encoder.encode("\ndata: \"type\":\"finish\"}\r\n\r\n"));
      controller.close();
    },
  });

  const messages = [];
  for await (const message of parseSseStream(stream)) messages.push(message);

  assert.deepEqual(messages, [{ id: "7", event: "harness", data: "{\"seq\":7,\n\"type\":\"finish\"}" }]);
});

test("watchRunEvents reconnects after the last sequence and suppresses duplicates", async () => {
  const requests: string[] = [];
  const streams = [
    "id: 1\ndata: {\"seq\":1,\"type\":\"start\"}\n\nid: 2\ndata: {\"seq\":2,\"type\":\"action\"}\n\n",
    "id: 2\ndata: {\"seq\":2,\"type\":\"action\"}\n\nid: 3\ndata: {\"seq\":3,\"type\":\"finish\"}\n\n",
  ];
  const client = new LoomClient({
    baseUrl: "https://loom.example.test",
    token: "secret",
    fetch: async (input) => {
      requests.push(String(input));
      const body = streams.shift();
      assert.ok(body);
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const controller = new AbortController();
  const events: number[] = [];

  const after = await client.watchRunEvents("alice", "alpha", "run-1", {
    signal: controller.signal,
    reconnectDelayMs: 0,
    onEvent(event) {
      events.push(event.seq);
      if (event.seq === 3) controller.abort();
    },
  });

  assert.equal(after, 3);
  assert.deepEqual(events, [1, 2, 3]);
  assert.match(requests[0], /after=0$/);
  assert.match(requests[1], /after=2$/);
});

test("LoomClient creates a real run and consumes its authenticated SSE timeline", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "loom-api-client-"));
  const server = createHarnessHttpServer({
    allowUnsafeLocalExecutor: true,
    workspaceRoot,
    tenantTokens: { alice: "client-secret" },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const client = new LoomClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: "client-secret" });
    const status = await client.negotiate("alice");
    assert.equal(status.api.version, "v1");

    const createInput = {
      tenant: "alice",
      project: "desktop-alpha",
      goal: "prove the desktop API path",
      clientRequestId: "desktop-alpha-integration",
      script: [{ message: "finish from SDK", finish: true }],
      verify: [],
    };
    const created = await client.createRun(createInput);
    const duplicate = await client.createRun(createInput);
    assert.equal(duplicate.runId, created.runId);

    const events: number[] = [];
    await client.watchRunEvents("alice", "desktop-alpha", created.runId, {
      reconnect: false,
      onEvent: (event) => events.push(event.seq),
    });
    const summary = await client.run("alice", "desktop-alpha", created.runId);
    const projects = await client.projects("alice");
    const runs = await client.runs("alice", "desktop-alpha");

    assert.equal(summary.status, "passed");
    assert.ok(projects.some((project) => project.project === "desktop-alpha"));
    assert.ok(runs.some((run) => run.runId === created.runId));
    assert.ok(events.length >= 2);
    assert.deepEqual(events, [...events].sort((left, right) => left - right));
    assert.equal(new Set(events).size, events.length);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
