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

test("rate limiting keys by X-Forwarded-For client hop only when trusted proxy hops are declared", async () => {
  const workspaceRoot = await tempDir("loom-rate-limit-proxy");
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    rateLimitRps: 1,
    rateLimitBurst: 2,
    rateLimitTrustedProxyHops: 1,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // With one trusted proxy, the proxy appends the real client IP as the
    // RIGHTMOST X-Forwarded-For entry. The key is hops[len - trustedHops], i.e.
    // that rightmost entry, so two clients get separate buckets.
    const drain = async (xff: string) => {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const r = await fetch(`${baseUrl}/status`, { headers: { "x-forwarded-for": xff } });
        statuses.push(r.status);
        await r.arrayBuffer();
      }
      return statuses;
    };

    // Client A (proxy-appended real IP 10.0.0.1) drains its burst -> throttled.
    assert.equal((await drain("10.0.0.1")).includes(429), true, "client A should be throttled after its own burst");

    // Client B (different real IP) has its own bucket -> not throttled.
    const b = await fetch(`${baseUrl}/status`, { headers: { "x-forwarded-for": "10.0.0.2" } });
    assert.notEqual(b.status, 429);
    await b.arrayBuffer();

    // A spoofed left segment with the SAME proxy-appended real IP keys to A's
    // already-drained bucket, not a fresh one -> throttled. This proves the
    // client-controlled left of XFF cannot be used to mint new buckets.
    const spoof = await fetch(`${baseUrl}/status`, { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } });
    assert.equal(spoof.status, 429, "spoofed left segment must not bypass the limiter");
    await spoof.arrayBuffer();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("X-Forwarded-For is ignored for rate limiting when no trusted proxy hops are declared", async () => {
  const workspaceRoot = await tempDir("loom-rate-limit-no-proxy-trust");
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    rateLimitRps: 1,
    rateLimitBurst: 2,
    // rateLimitTrustedProxyHops defaults to 0 -> trust nobody, key on socket peer
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // A spoofed, ever-changing XFF must NOT mint a fresh bucket per request; all
    // requests share the socket-peer bucket and get throttled after the burst.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await fetch(`${baseUrl}/status`, { headers: { "x-forwarded-for": `10.0.0.${i}` } });
      statuses.push(r.status);
      await r.arrayBuffer();
    }
    assert.equal(statuses.includes(429), true, "spoofed XFF must not bypass the socket-peer bucket");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("--allow-unsafe-local-executor refuses the cross-tenant shell.exec RCE even on loopback", async () => {
  const base = {
    executor: "local",
    workspaceRoot: await tempDir("loom-unsafe-local-multitenant"),
    allowShell: false,
    allowTool: [] as string[],
    allowUnsafeLocalExecutor: true,
    host: "127.0.0.1",
  };

  // genuine single-user local dev: loopback, no tenant auth -> allowed
  assert.deepEqual(unsafeLocalExecutorReasons({ ...base }, false), []);

  // multi-tenant without shell.exec: per-run path-guarded file ops only -> allowed
  assert.deepEqual(unsafeLocalExecutorReasons({ ...base, tenantKey: ["alice=ENV:ops:admin"] }, false), []);
  assert.deepEqual(unsafeLocalExecutorReasons({ ...base, oidcIssuer: "https://idp.example" }, false), []);
  assert.deepEqual(unsafeLocalExecutorReasons({ ...base }, true), []);

  // multi-tenant + shell.exec on the local executor is a cross-tenant RCE -> refused
  const shellPlusTenantKey = unsafeLocalExecutorReasons(
    { ...base, allowShell: true, tenantKey: ["alice=ENV:ops:admin"] },
    false,
  );
  assert.ok(shellPlusTenantKey.some((r) => r.includes("cross-tenant RCE")));

  const shellPlusPolicyAuth = unsafeLocalExecutorReasons({ ...base, allowShell: true }, true);
  assert.ok(shellPlusPolicyAuth.some((r) => r.includes("cross-tenant RCE")));

  // shell.exec via --allow-tool, with tenant auth -> refused
  const toolShellPlusOidc = unsafeLocalExecutorReasons(
    { ...base, allowTool: ["shell.exec"], oidcIssuer: "https://idp.example" },
    false,
  );
  assert.ok(toolShellPlusOidc.some((r) => r.includes("cross-tenant RCE")));

  // single-user (no tenant auth) with shell.exec stays allowed on loopback
  assert.deepEqual(unsafeLocalExecutorReasons({ ...base, allowShell: true }, false), []);
});

test("OPTIONS preflight is subject to rate limiting (not a bypass)", async () => {
  const workspaceRoot = await tempDir("loom-rate-limit-options");
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    rateLimitRps: 1,
    rateLimitBurst: 2,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`${baseUrl}/runs`, { method: "OPTIONS" });
      statuses.push(r.status);
      await r.arrayBuffer();
    }
    // First OPTIONS within burst succeeds (204); once the bucket drains they 429.
    assert.equal(statuses[0], 204);
    assert.equal(statuses.includes(429), true, "OPTIONS flood must be throttled, not exempt");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("policy api-key endpoint rejects weak caller-supplied tokens", async () => {
  const workspaceRoot = await tempDir("loom-weak-api-token");
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    tenantApiKeys: {
      alice: [{ token: "operator-admin-key", actor: "ops", role: "admin" }],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const weak = await fetch(`${baseUrl}/tenants/alice/policy/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer operator-admin-key" },
      body: JSON.stringify({ actor: "temp", role: "viewer", token: "a" }),
    });
    assert.equal(weak.status, 400);
    await weak.arrayBuffer();

    const strong = await fetch(`${baseUrl}/tenants/alice/policy/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer operator-admin-key" },
      body: JSON.stringify({ actor: "temp", role: "viewer", token: "a-sufficiently-long-custom-token-value" }),
    });
    assert.equal(strong.status, 201);
    await strong.arrayBuffer();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
