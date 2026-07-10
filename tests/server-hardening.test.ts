import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { unsafeLocalExecutorReasons } from "../src/cli/commands/harness-serve.js";
import { createHarnessHttpServer } from "../src/harness/server.js";

async function tempDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${name}-`));
}

test("HTTP rate limit returns 429 after the burst is exhausted and keeps health probes exempt", async () => {
  const workspaceRoot = await tempDir("loom-rate-limit");
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    rateLimitRps: 1,
    rateLimitBurst: 3,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await fetch(`${baseUrl}/status`);
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    assert.deepEqual(statuses.slice(0, 3).filter((status) => status !== 429), statuses.slice(0, 3));
    assert.equal(statuses[3], 429);
    assert.equal(statuses[4], 429);

    const limited = await fetch(`${baseUrl}/status`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "1");
    await limited.arrayBuffer();

    // /healthz and /readyz stay reachable for probes while the client is limited
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    await health.arrayBuffer();
    const ready = await fetch(`${baseUrl}/readyz`);
    assert.notEqual(ready.status, 429);
    await ready.arrayBuffer();

    // tokens refill over time (1 rps)
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const refilled = await fetch(`${baseUrl}/status`);
    assert.notEqual(refilled.status, 429);
    await refilled.arrayBuffer();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("rate limiting can be disabled with rateLimitRps: 0", async () => {
  const workspaceRoot = await tempDir("loom-rate-limit-off");
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    rateLimitRps: 0,
    rateLimitBurst: 1,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    for (let i = 0; i < 10; i += 1) {
      const response = await fetch(`${baseUrl}/status`);
      assert.notEqual(response.status, 429);
      await response.arrayBuffer();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("--allow-unsafe-local-executor no longer bypasses the non-loopback local executor refusal", async () => {
  const workspaceRoot = await tempDir("loom-unsafe-local");
  const base = {
    executor: "local",
    workspaceRoot,
    allowShell: true,
    allowTool: [] as string[],
    allowUnsafeLocalExecutor: true,
  };

  // loopback escape hatch keeps working for single-user development
  assert.deepEqual(unsafeLocalExecutorReasons({ ...base, host: "127.0.0.1" }), []);
  assert.deepEqual(unsafeLocalExecutorReasons({ ...base, host: "localhost" }), []);

  // non-loopback local executor is refused even with the flag set
  const refused = unsafeLocalExecutorReasons({ ...base, host: "0.0.0.0" });
  assert.equal(refused.length, 1);
  assert.match(refused[0], /not loopback/);
  assert.match(refused[0], /--allow-unsafe-local-executor only applies to loopback hosts/);

  // without the flag the original reasons still apply
  const original = unsafeLocalExecutorReasons({ ...base, host: "0.0.0.0", allowUnsafeLocalExecutor: false });
  assert.ok(original.some((reason) => reason.includes("not loopback")));
  assert.ok(original.some((reason) => reason.includes("shell.exec is allowed")));
});
