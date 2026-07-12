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
const phase2Project = `workbench-${suffix}`;
const controlProject = `control-${suffix}`;

const report = {
  schemaVersion: "loom-two-instance-staging/v1",
  startedAt: new Date().toISOString(),
  projects: { holderProject, capacityProject, recoveredProject, phase2Project, controlProject },
  checks: {},
};

let firstMayBeStopped = false;
try {
  await waitForReady(firstUrl, aliceAdmin);
  await waitForReady(secondUrl, aliceAdmin);
  report.checks.readiness = true;

  await json(firstUrl, "/tenants/alice/projects", {
    method: "POST",
    token: aliceAdmin,
    body: { project: phase2Project },
  });
  const original = await json(firstUrl, `/tenants/alice/projects/${phase2Project}/files`, {
    method: "POST",
    token: aliceAdmin,
    body: { path: "shared.txt", content: "version one\n", clientId: "editor-a" },
  });
  await json(firstUrl, `/tenants/alice/projects/${phase2Project}/presence`, {
    method: "POST",
    token: aliceAdmin,
    body: { clientId: "editor-a", label: "Editor A", focus: "file:shared.txt" },
  });
  await sleep(10);
  const current = await json(firstUrl, `/tenants/alice/projects/${phase2Project}/files`, {
    method: "POST",
    token: aliceAdmin,
    body: { path: "shared.txt", content: "version two\n", baseUpdatedAt: original.body.updatedAt, clientId: "editor-a" },
  });
  assert.notEqual(current.body.updatedAt, original.body.updatedAt);
  const conflict = await json(secondUrl, `/tenants/alice/projects/${phase2Project}/files`, {
    method: "POST",
    token: aliceAdmin,
    expected: [409],
    body: { path: "shared.txt", content: "stale edit\n", baseUpdatedAt: original.body.updatedAt, clientId: "editor-b" },
  });
  assert.ok(conflict.body.activeEditors.some((entry) => entry.clientId === "editor-a"));
  const presence = await json(secondUrl, `/tenants/alice/projects/${phase2Project}/presence`, { token: aliceAdmin });
  assert.ok(presence.body.some((entry) => entry.clientId === "editor-a" && entry.focus === "file:shared.txt"));
  report.checks.crossInstanceFileConflict = true;
  report.checks.crossInstancePresence = true;

  const terminal = await json(firstUrl, `/tenants/alice/projects/${phase2Project}/sessions`, {
    method: "POST",
    token: aliceAdmin,
    body: { command: "sh -lc 'printf phase2-first; sleep 1; printf phase2-second'", clientId: "terminal-a" },
  });
  const terminalEvents = await waitForSessionExit(secondUrl, aliceAdmin, phase2Project, terminal.body.sessionId);
  const firstTerminalSeq = terminalEvents.find((event) => event.type === "stdout")?.seq ?? 0;
  assert.ok(firstTerminalSeq > 0);
  const resumedEvents = await sse(secondUrl, `/tenants/alice/projects/${phase2Project}/sessions/${terminal.body.sessionId}/events/stream?after=${firstTerminalSeq}`, aliceAdmin);
  assert.ok(resumedEvents.length > 0);
  assert.ok(resumedEvents.every((event) => event.seq > firstTerminalSeq));
  assert.equal(new Set(resumedEvents.map((event) => event.seq)).size, resumedEvents.length);
  assert.ok(resumedEvents.some((event) => event.type === "exit"));
  report.checks.crossInstanceTerminalReconnect = true;

  const controlled = await startRunWhenCapacityAvailable(firstUrl, {
    async: true,
    tenant: "alice",
    project: controlProject,
    goal: "cancel from peer server",
    script: [
      { message: "hold", actions: [{ toolName: "shell.exec", input: { command: "sleep 30" } }] },
      { message: "finish", finish: true },
    ],
    verify: [],
  });
  const cancel = await json(secondUrl, `/tenants/alice/runs/${controlled.body.runId}/cancel?project=${controlProject}`, {
    method: "POST",
    token: aliceAdmin,
    expected: [202],
    body: { reason: "phase 2 peer control", clientId: "desktop-b" },
  });
  assert.equal(cancel.body.cancelRequested, true);
  await waitForRunStatus(secondUrl, aliceAdmin, "alice", controlProject, String(controlled.body.runId), "cancelled");
  report.checks.crossServerRunControl = true;

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

async function waitForSessionExit(baseUrl, token, project, sessionId) {
  const path = `/tenants/alice/projects/${project}/sessions/${sessionId}/events`;
  const deadline = Date.now() + 30_000;
  let events = [];
  while (Date.now() < deadline) {
    const result = await json(baseUrl, path, { token, expected: [200, 404] });
    if (result.status === 200) {
      events = result.body;
      if (events.some((event) => event.type === "exit")) return events;
    }
    await sleep(200);
  }
  throw new Error(`workspace session ${sessionId} did not exit: ${JSON.stringify(events)}`);
}

async function sse(baseUrl, path, token) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const text = await response.text();
  return text.split(/\r?\n\r?\n/).map((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    return data ? JSON.parse(data) : undefined;
  }).filter(Boolean);
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
