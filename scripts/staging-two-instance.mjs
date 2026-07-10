import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compose = resolve(root, "deploy/staging/compose.yml");
const firstUrl = process.env.LOOM_STAGING_A_URL ?? "http://127.0.0.1:8787";
const secondUrl = process.env.LOOM_STAGING_B_URL ?? "http://127.0.0.1:8788";
const aliceAdmin = process.env.LOOM_STAGING_ALICE_ADMIN_TOKEN ?? "local-alice-admin";
const aliceViewer = process.env.LOOM_STAGING_ALICE_VIEWER_TOKEN ?? "local-alice-viewer";
const bobAdmin = process.env.LOOM_STAGING_BOB_ADMIN_TOKEN ?? "local-bob-admin";
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const holderProject = `lease-${suffix}`;
const capacityProject = `capacity-${suffix}`;
const recoveredProject = `recovered-${suffix}`;

const report = {
  schemaVersion: "loom-two-instance-staging/v1",
  startedAt: new Date().toISOString(),
  projects: { holderProject, capacityProject, recoveredProject },
  checks: {},
};

let firstMayBeStopped = false;
try {
  await waitForReady(firstUrl, aliceAdmin);
  await waitForReady(secondUrl, aliceAdmin);
  report.checks.readiness = true;

  const first = await startRunWhenCapacityAvailable(firstUrl, {
    async: true,
    tenant: "alice",
    project: holderProject,
    goal: "hold distributed capacity",
    script: [
      { message: "hold", actions: [{ toolName: "shell.exec", input: { command: "sleep 30" } }] },
      { message: "finish", finish: true },
    ],
    verify: [],
  });
  assert.equal(first.status, 202);

  const blocked = await json(secondUrl, "/runs", {
    method: "POST",
    token: aliceAdmin,
    expected: [409],
    body: {
      tenant: "alice",
      project: capacityProject,
      goal: "must be blocked",
      script: [{ message: "finish", finish: true }],
      verify: [],
    },
  });
  assert.match(String(blocked.body.error), new RegExp(String(first.body.runId)));
  report.checks.atomicTenantCapacity = true;

  const queued = await json(firstUrl, "/runs", {
    method: "POST",
    token: aliceAdmin,
    body: {
      async: true,
      queue: true,
      tenant: "alice",
      project: recoveredProject,
      goal: "complete after owner shutdown",
      script: [{ message: "finish", finish: true }],
      verify: [],
    },
  });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.status, "queued");

  firstMayBeStopped = true;
  execFileSync("docker", ["compose", "-f", compose, "stop", "harness-a"], { stdio: "inherit" });
  const recovered = await waitForRunStatus(secondUrl, aliceAdmin, "alice", recoveredProject, String(queued.body.runId), "passed");
  assert.equal(recovered.status, "passed");
  report.checks.ownerFailureRecovery = true;

  const noToken = await json(secondUrl, "/tenants/alice/runs", { expected: [401] });
  assert.equal(noToken.status, 401);
  const crossTenant = await json(secondUrl, "/tenants/bob/runs", { token: aliceAdmin, expected: [401] });
  assert.equal(crossTenant.status, 401);
  const viewerMutation = await json(secondUrl, "/tenants/alice/policy/settings", {
    method: "POST",
    token: aliceViewer,
    expected: [403],
    body: { allowedTools: ["file.read"] },
  });
  assert.equal(viewerMutation.status, 403);
  const bobVisible = await json(secondUrl, "/tenants/bob/runs", { token: bobAdmin });
  assert.ok(Array.isArray(bobVisible.body));
  report.checks.tenantIsolation = true;

  const loadStartedAt = Date.now();
  const load = await Promise.all(Array.from({ length: 100 }, () => json(secondUrl, "/status", { token: aliceAdmin })));
  assert.ok(load.every((result) => result.status === 200));
  report.checks.concurrentStatusReads = { requests: load.length, durationMs: Date.now() - loadStartedAt };

  const audit = await json(secondUrl, "/tenants/alice/audit", { token: aliceAdmin });
  assert.ok(Array.isArray(audit.body));
  assert.ok(audit.body.some((event) => event?.type === "run_created" && event?.data?.runId === queued.body.runId));
  report.checks.crossInstanceAudit = true;

  report.endedAt = new Date().toISOString();
  report.ok = true;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  if (firstMayBeStopped) {
    execFileSync("docker", ["compose", "-f", compose, "up", "-d", "harness-a"], { stdio: "inherit" });
  }
}

async function startRunWhenCapacityAvailable(baseUrl, body) {
  const deadline = Date.now() + 10_000;
  let last;
  while (Date.now() < deadline) {
    const result = await json(baseUrl, "/runs", { method: "POST", token: aliceAdmin, expected: [202, 409], body });
    if (result.status === 202) return result;
    last = result.body;
    await sleep(250);
  }
  throw new Error(`distributed capacity did not become available: ${JSON.stringify(last)}`);
}

async function waitForReady(baseUrl, token) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const result = await json(baseUrl, "/readyz", { token, expected: [200, 503] });
      if (result.status === 200 && result.body.ready === true) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`${baseUrl} did not become ready`);
}

async function waitForRunStatus(baseUrl, token, tenant, project, runId, expected) {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await json(baseUrl, `/tenants/${tenant}/runs/${runId}?project=${project}`, { token, expected: [200, 404] });
      last = result.body;
      if (result.status === 200 && result.body.status === expected) return result.body;
    } catch (error) {
      last = { transientError: error instanceof Error ? error.message : String(error) };
    }
    await sleep(200);
  }
  throw new Error(`run ${runId} did not reach ${expected}: ${JSON.stringify(last)}`);
}

async function json(baseUrl, path, options = {}) {
  const headers = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  const expected = options.expected ?? [200, 201, 202];
  assert.ok(expected.includes(response.status), `${path} returned ${response.status}: ${text}`);
  return { status: response.status, body };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
