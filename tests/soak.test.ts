import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { createHarnessHttpServer } from "../src/harness/server.js";

// C2 production-readiness soak/load gate. Off by default so it never slows the
// unit suite; the operator flips it on before declaring an instance ready:
//
//   LOOM_SOAK=1 SOAK_DURATION_MS=120000 SOAK_CONCURRENCY=32 \
//     node --expose-gc --import tsx --test tests/soak.test.ts
//
// It hammers a live in-process server with a mixed, authenticated request load
// and fails if the loop degrades: any 5xx, any cross-tenant read, or unbounded
// memory growth. --expose-gc makes the leak canary meaningful; without it the
// RSS bound still catches a gross leak.
const SOAK = process.env.LOOM_SOAK === "1";
const DURATION_MS = Number(process.env.SOAK_DURATION_MS ?? 5_000);
const CONCURRENCY = Number(process.env.SOAK_CONCURRENCY ?? 16);
const ALICE_KEY = "alice-operator-key-aaaaaaaaaaaa";
const BOB_KEY = "bob-operator-key-bbbbbbbbbbbbbb";

interface Probe {
  path: string;
  headers: Record<string, string>;
  // A status counts as an isolation break when a tenant reads another's scope.
  violation?: (status: number) => boolean;
}

test(
  "harness serve stays stable and tenant-isolated under sustained concurrent load",
  { skip: SOAK ? false : "set LOOM_SOAK=1 to run the soak/load gate" },
  async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "loom-soak-"));
    const server = createHarnessHttpServer({
      workspaceRoot,
      allowUnsafeLocalExecutor: true,
      rateLimitRps: 0, // the load generator must not be throttled by the limiter under test
      tenantApiKeys: {
        alice: [{ token: ALICE_KEY, actor: "ops", role: "admin" }],
        bob: [{ token: BOB_KEY, actor: "ops", role: "admin" }],
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const mix: Probe[] = [
      { path: "/healthz", headers: {} },
      { path: "/tenants/alice/access", headers: { authorization: `Bearer ${ALICE_KEY}` } },
      { path: "/tenants/alice/access", headers: {} }, // unauthenticated -> must be 401, never 5xx
      // alice's key reaching into bob's scope: any 200 is a cross-tenant leak (the C1 guarantee).
      { path: "/tenants/bob/access", headers: { authorization: `Bearer ${ALICE_KEY}` }, violation: (s) => s === 200 },
    ];

    const stats = { total: 0, status5xx: 0, transportErrors: 0, isolationViolations: 0, maxLatencyMs: 0 };
    const statusHist = new Map<number, number>();
    const bump = (status: number) => statusHist.set(status, (statusHist.get(status) ?? 0) + 1);

    // Warm one request so the baseline RSS excludes lazy first-hit allocation.
    await fetch(`${baseUrl}/healthz`).then((r) => r.arrayBuffer());
    if (globalThis.gc) globalThis.gc();
    const rssBaseline = process.memoryUsage().rss;
    const deadline = Date.now() + DURATION_MS;

    async function worker(): Promise<void> {
      while (Date.now() < deadline) {
        const probe = mix[Math.floor(Math.random() * mix.length)];
        const started = performance.now();
        let status = 0;
        try {
          const res = await fetch(`${baseUrl}${probe.path}`, { headers: probe.headers });
          status = res.status;
          await res.arrayBuffer();
        } catch {
          stats.transportErrors += 1;
          continue;
        }
        stats.total += 1;
        stats.maxLatencyMs = Math.max(stats.maxLatencyMs, performance.now() - started);
        bump(status);
        if (status >= 500) stats.status5xx += 1;
        if (probe.violation?.(status)) stats.isolationViolations += 1;
      }
    }

    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      if (globalThis.gc) globalThis.gc();
      const rssGrowth = process.memoryUsage().rss - rssBaseline;

      console.log(
        JSON.stringify(
          {
            durationMs: DURATION_MS,
            concurrency: CONCURRENCY,
            ...stats,
            rps: Math.round((stats.total / DURATION_MS) * 1000),
            rssGrowthMb: Number((rssGrowth / 1e6).toFixed(1)),
            statusHist: Object.fromEntries([...statusHist].sort()),
          },
          null,
          2,
        ),
      );

      assert.ok(stats.total > 0, "generated zero requests");
      assert.equal(stats.transportErrors, 0, `${stats.transportErrors} requests failed at the transport layer`);
      assert.equal(stats.status5xx, 0, `saw ${stats.status5xx} 5xx responses under load`);
      assert.equal(
        stats.isolationViolations,
        0,
        `tenant isolation broke ${stats.isolationViolations} times under load (alice read bob's scope)`,
      );
      // ponytail: coarse runaway guard, not a precise leak detector. The load
      // generator runs in THIS process, so RSS also holds undici's per-request
      // client churn — ~4KB/req of transient buffers at multi-thousand rps. The
      // real stability signals above (0 5xx, 0 isolation breaks, throughput) are
      // the gate; this only trips on unbounded growth. For a true leak hunt, run
      // SOAK_DURATION_MS=120000+ with --expose-gc and watch rssGrowthMb plateau.
      assert.ok(rssGrowth < 512_000_000, `RSS grew ${(rssGrowth / 1e6).toFixed(1)}MB under load — possible runaway leak`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
