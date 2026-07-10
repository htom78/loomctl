import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { execa } from "execa";
import { CONTROL_PLANE_PROVIDER_BOUNDARY, CONTROL_PLANE_PROVIDER_CATALOG } from "../src/harness/control-plane.js";
import { createLocalExecutor } from "../src/harness/executor.js";
import { HARNESS_VISION_LOCK, ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES, ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS } from "../src/harness/profile-contract.js";
import { createHarnessHttpServer } from "../src/harness/server.js";
import { startAgentGitServiceContractServer } from "./support/agent-git-service-contract.js";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const ONLINE_SANDBOX_PROFILE_SMOKE_TIMEOUT_MS = 60_000;

async function tempDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${name}-`));
}

function onlineSandboxTools(): string[] {
  return [...ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS];
}

function onlineSandboxServerRecord(): Record<string, unknown> {
  return {
    profile: "online-sandbox",
    runWorkspaceIsolation: "project",
    concurrencyAdmission: concurrencyAdmissionFixture(),
    controlPlane: expectedControlPlane(),
  };
}

function concurrencyAdmissionFixture(mode: "project" | "run" = "project"): Record<string, unknown> {
  return {
    schemaVersion: "loom-concurrency-admission/v1",
    runWorkspaceIsolation: mode,
    activeRun: {
      claimScope: mode,
      claimPattern: mode === "run"
        ? "<tenant>/<project>/.loom/runs/.admission/<runId>.lock.json"
        : "<tenant>/<project>/.loom/runs/.admission/project.lock.json",
      leaseTtlMs: 120_000,
      crossServer: true,
      staleClaimCleanup: true,
    },
    tenantActiveRuns: {
      enabled: true,
      limit: 4,
      claimPattern: "<tenant>/.loom/admission/active-runs/<runId>.json",
      mutexPattern: "<tenant>/.loom/admission/active-runs.lock",
      crossServer: true,
      staleClaimCleanup: true,
    },
    workspaceSessions: {
      globalLimit: 32,
      tenantLimit: 32,
      globalClaimPattern: ".loom/admission/workspace-sessions/<sessionId>.json",
      tenantClaimPattern: "<tenant>/.loom/admission/workspace-sessions/<sessionId>.json",
      mutexPattern: "workspace-sessions.lock",
      crossServer: true,
      staleClaimCleanup: true,
    },
    queueing: {
      asyncRuns: true,
      persistedSnapshots: true,
      restartRecovery: true,
      blockedReasons: ["tenant_active_run_limit", "project_active_workspace", "persisted_running_run"],
    },
    runControl: {
      crossServer: true,
      requestFiles: ["pause-request.json", "cancel-request.json"],
      ownerLoopPollMs: 250,
    },
    idempotency: {
      clientRequestId: true,
      sharedRunStore: true,
      crossServerReplay: true,
      simultaneousCreateReplay: true,
      conflictOnRequestMismatch: true,
    },
  };
}

function expectedControlPlane(provider: keyof typeof CONTROL_PLANE_PROVIDER_CATALOG = "gitea-forgejo"): Record<string, unknown> {
  const entry = CONTROL_PLANE_PROVIDER_CATALOG[provider];
  return {
    provider,
    boundary: [...CONTROL_PLANE_PROVIDER_BOUNDARY],
    apiBasePath: entry.apiBasePath,
    discoveryEndpoints: [...entry.discoveryEndpoints],
    nativeCapabilities: [...entry.nativeCapabilities],
    adoptionStages: entry.adoptionStages.map((stage) => ({ ...stage, evidence: [...stage.evidence] })),
  };
}

function agentGitServiceProbeReportFixture(baseUrl: string): Record<string, unknown> {
  const apiBaseUrl = baseUrl.replace(/\/+$/, "");
  return {
    schemaVersion: "agent-git-service-contract-probe/v1",
    provider: "agent-git-service",
    apiBasePath: "/api/v3",
    readOnly: true,
    authorizationScheme: "Bearer",
    checkedAt: "2026-07-01T00:00:00.000Z",
    baseUrl: apiBaseUrl,
    endpoints: [
      { endpoint: "/api/v3", url: apiBaseUrl, ok: true, status: 200 },
      { endpoint: "/api/v3/meta", url: `${apiBaseUrl}/meta`, ok: true, status: 200 },
      { endpoint: "/api/v3/rate_limit", url: `${apiBaseUrl}/rate_limit`, ok: true, status: 200 },
    ],
    ok: true,
    missingEndpoints: [],
    nativeCapabilities: [...CONTROL_PLANE_PROVIDER_CATALOG["agent-git-service"].nativeCapabilities],
    requestsTokenFree: true,
  };
}

function modelPreflightFixture(baseUrl = "https://litellm.example/v1"): Record<string, unknown> {
  return {
    ok: true,
    baseUrl,
    checks: {
      apiKey: { ok: true, required: true },
      chatCompletion: { ok: true, required: true },
      agentStep: { ok: true, required: true },
      modelUsage: { ok: true, required: true },
    },
    modelUsage: {
      model: "platform-model",
      promptTokens: 8,
      completionTokens: 4,
      totalTokens: 12,
      costUsd: 0.001,
    },
  };
}

function coderPreflightFixture(): Record<string, unknown> {
  return {
    ok: true,
    executor: { kind: "coder" },
    checks: {
      configuration: { ok: true, required: true },
      prepare: { ok: true, required: true },
      remoteCommand: { ok: true, required: true, output: "loom-coder-preflight-ok" },
      browserUrls: {
        ok: true,
        required: true,
        ideUrl: "https://coder.example/@alice/vas",
        previewUrl: "https://preview.example/vas",
      },
    },
  };
}

function visionLockCapabilities(): string[] {
  return [...HARNESS_VISION_LOCK.capabilities];
}

function onlineSandboxServerStatus(overrides: {
  server?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  readiness?: Record<string, unknown>;
  visionLock?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    server: { ...onlineSandboxServerRecord(), ...(overrides.server ?? {}) },
    policy: overrides.policy ?? { allowedTools: onlineSandboxTools() },
    readiness: overrides.readiness ?? onlineSandboxReadiness(),
    visionLock: overrides.visionLock ?? {
      target: HARNESS_VISION_LOCK.target,
      mvpIsScopeReduction: false,
      capabilities: visionLockCapabilities(),
    },
  };
}

function onlineSandboxTenantStatus(overrides: {
  server?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  readiness?: Record<string, unknown>;
  visionLock?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    server: {
      runWorkspaceIsolation: "project",
      concurrencyAdmission: concurrencyAdmissionFixture(),
      controlPlane: expectedControlPlane(),
      ...(overrides.server ?? {}),
    },
    policy: overrides.policy ?? { allowedTools: onlineSandboxTools() },
    readiness: overrides.readiness ?? onlineSandboxReadiness(),
    visionLock: overrides.visionLock ?? {
      target: HARNESS_VISION_LOCK.target,
      mvpIsScopeReduction: false,
      capabilities: visionLockCapabilities(),
    },
  };
}

function onlineSandboxReadiness(): Record<string, unknown> {
  return {
    profile: "online-sandbox",
    ok: true,
    missing: [],
    goldenPath: {
      required: true,
      ok: true,
      capabilities: onlineSandboxGoldenPathCapabilities(),
      missingCapabilities: [],
    },
  };
}

async function writeProjectMetadata(workspaceRoot: string, tenant: string, project: string): Promise<void> {
  await mkdir(join(workspaceRoot, tenant, project, ".loom"), { recursive: true });
  await writeFile(
    join(workspaceRoot, tenant, project, ".loom", "project.json"),
    JSON.stringify({
      schemaVersion: 1,
      template: "empty",
      tenant,
      project,
      createdAt: "2026-06-30T00:00:00.000Z",
    }, null, 2) + "\n",
    "utf8",
  );
}

function onlineSandboxGoldenPathCapabilities(): string[] {
  return [...ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES];
}

function onlineSandboxGoldenPathCapabilitiesWithAgentGitServiceNativeProjection(): string[] {
  return [...onlineSandboxGoldenPathCapabilities(), "agent-git-service-native-projection"];
}

function smokeProbeResponse(path: string): Record<string, unknown> {
  if (path === "/readyz") {
    return {
      ready: true,
      startedAt: "2026-06-30T00:00:00.000Z",
      uptimeMs: 0,
      checks: {
        queueRecovery: "completed",
        staleRunCleanup: "disabled",
      },
    };
  }
  return {
    ok: true,
    startedAt: "2026-06-30T00:00:00.000Z",
    uptimeMs: 0,
  };
}

function smokeMetricsResponse(): string {
  return [
    "# HELP loom_harness_ready Whether the harness server readiness probe is ready.",
    "# TYPE loom_harness_ready gauge",
    "loom_harness_ready 1",
    "# HELP loom_harness_active_runs Active harness runs.",
    "# TYPE loom_harness_active_runs gauge",
    "loom_harness_active_runs 0",
    "# HELP loom_harness_queued_runs Queued harness runs.",
    "# TYPE loom_harness_queued_runs gauge",
    "loom_harness_queued_runs 0",
    "# HELP loom_harness_active_workspace_sessions Active workspace sessions.",
    "# TYPE loom_harness_active_workspace_sessions gauge",
    "loom_harness_active_workspace_sessions 0",
    "# HELP loom_harness_orphaned_running_runs Orphaned persisted running runs.",
    "# TYPE loom_harness_orphaned_running_runs gauge",
    "loom_harness_orphaned_running_runs 0",
    "# HELP loom_harness_review_required_runs Runs currently waiting for human review.",
    "# TYPE loom_harness_review_required_runs gauge",
    "loom_harness_review_required_runs 0",
    "# HELP loom_harness_deployment_required_runs Runs currently waiting for deployment approval.",
    "# TYPE loom_harness_deployment_required_runs gauge",
    "loom_harness_deployment_required_runs 0",
    "# HELP loom_harness_model_usage_warning_projects Tenant projects currently above model usage warning thresholds.",
    "# TYPE loom_harness_model_usage_warning_projects gauge",
    "loom_harness_model_usage_warning_projects 0",
    "# HELP loom_harness_workspace_usage_warning_projects Tenant projects currently above workspace usage warning thresholds.",
    "# TYPE loom_harness_workspace_usage_warning_projects gauge",
    "loom_harness_workspace_usage_warning_projects 0",
    "# HELP loom_harness_queue_recovery_completed Whether queue recovery completed.",
    "# TYPE loom_harness_queue_recovery_completed gauge",
    "loom_harness_queue_recovery_completed 1",
    "# HELP loom_harness_stale_run_cleanup_ready Whether stale run cleanup is ready.",
    "# TYPE loom_harness_stale_run_cleanup_ready gauge",
    "loom_harness_stale_run_cleanup_ready 1",
  ].join("\n") + "\n";
}

function tenantRoleKeys(): Record<string, Array<{ token: string; actor: string; role: "admin" | "developer" | "viewer" }>> {
  return {
    alice: [
      { token: "admin-key", actor: "ops", role: "admin" },
      { token: "dev-key", actor: "eno", role: "developer" },
      { token: "viewer-key", actor: "auditor", role: "viewer" },
    ],
  };
}

async function runOnlineSandboxProfileSmokeAgainstStatus(
  serverStatus: Record<string, unknown>,
  tenantStatus: Record<string, unknown> = onlineSandboxTenantStatus(),
): Promise<{ exitCode: number | undefined; stderr: string; stdout: string }> {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.end(JSON.stringify(smokeProbeResponse(req.url)));
      return;
    }
    if (req.url === "/metrics") {
      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.end(smokeMetricsResponse());
      return;
    }
    if (req.url === "/status") {
      res.end(JSON.stringify(serverStatus));
      return;
    }
    if (req.url === "/tenants/alice/status") {
      res.end(JSON.stringify(tenantStatus));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    return await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-profile-schema",
        "--template",
        "vas-lite",
        "--isolation-tenant",
        "bob",
        "--profile",
        "online-sandbox",
      ],
      {
	        cwd: process.cwd(),
	        env: process.env,
	        reject: false,
	        timeout: ONLINE_SANDBOX_PROFILE_SMOKE_TIMEOUT_MS,
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function runAuthRolesSmokeAgainstViewerStatus(
  viewerStatus: Record<string, unknown>,
): Promise<{ exitCode: number | undefined; stderr: string; stdout: string }> {
  const runId = "smoke-run";
  const viewerCommentText = "loom smoke viewer comment is durable";
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    const isViewer = auth === "Bearer viewer-key";
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.end(JSON.stringify(smokeProbeResponse(req.url)));
      return;
    }
    if (req.url === "/metrics") {
      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.end(smokeMetricsResponse());
      return;
    }
    if (req.method === "POST" && req.url === "/tenants/alice/projects") {
      res.statusCode = 201;
      res.end(JSON.stringify({ project: "smoke-auth-vision-lock" }));
      return;
    }
    if (req.method === "POST" && req.url === "/runs") {
      if (isViewer) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "viewer cannot create runs" }));
        return;
      }
      res.statusCode = 201;
      res.end(JSON.stringify({ runId, status: "passed" }));
      return;
    }
    if (req.method === "GET" && req.url === `/tenants/alice/runs/${runId}?project=smoke-auth-vision-lock`) {
      res.end(JSON.stringify({ status: "passed" }));
      return;
    }
    if (req.method === "GET" && req.url === `/tenants/alice/runs/${runId}/events?project=smoke-auth-vision-lock`) {
      res.end(JSON.stringify([{ type: "finish" }]));
      return;
    }
    if (req.method === "GET" && req.url === "/tenants/alice/projects/smoke-auth-vision-lock/files?path=loom-smoke.txt") {
      res.end(JSON.stringify({ kind: "file", content: "loom smoke ok\n" }));
      return;
    }
    if (req.method === "POST" && req.url === "/tenants/alice/projects/smoke-auth-vision-lock/files") {
      res.statusCode = isViewer ? 403 : 200;
      res.end(JSON.stringify(isViewer ? { error: "viewer cannot write files" } : { ok: true }));
      return;
    }
    if (req.method === "GET" && req.url === "/tenants/alice/projects/smoke-auth-vision-lock/workspace") {
      res.end(JSON.stringify({ route: "project", executor: { kind: "local" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/tenants/alice/access") {
      res.end(JSON.stringify(isViewer ? { actor: "auditor", role: "viewer" } : { actor: "eno", role: "developer" }));
      return;
    }
    if (req.method === "GET" && req.url === "/tenants/alice/status") {
      res.end(JSON.stringify(viewerStatus));
      return;
    }
    if (req.method === "POST" && req.url === `/tenants/alice/runs/${runId}/comments?project=smoke-auth-vision-lock`) {
      res.statusCode = 201;
      res.end(JSON.stringify({ seq: 1, data: { actor: "auditor", role: "viewer", content: viewerCommentText } }));
      return;
    }
    if (req.method === "GET" && req.url === `/tenants/alice/runs/${runId}/replay?project=smoke-auth-vision-lock`) {
      res.end(JSON.stringify({
        timeline: [{ seq: 1, type: "user_message", role: "viewer", title: viewerCommentText, detail: viewerCommentText }],
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    return await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-auth-vision-lock",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--viewer-token-env",
        "LOOM_TEST_VIEWER_TOKEN",
        "--check-auth-roles",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOOM_TEST_TENANT_TOKEN: "dev-key",
          LOOM_TEST_VIEWER_TOKEN: "viewer-key",
	        },
	        reject: false,
	        timeout: 25_000,
	      },
	    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("loom harness run executes a scripted loop and writes run artifacts", async () => {
  const cwd = await tempDir("loom-cli");
  const scriptPath = join(cwd, "script.json");
  await writeFile(
    scriptPath,
    JSON.stringify([
      {
        message: "write cli artifact",
        actions: [
          {
            toolName: "file.write",
            input: { path: "cli.txt", content: "cli-ok\n" },
          },
        ],
      },
      { message: "finish", finish: true },
    ]),
    "utf8",
  );

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "run",
      "create cli.txt",
      "--cwd",
      cwd,
      "--script",
      scriptPath,
      "--verify",
      "test -f cli.txt",
      "--skill",
      "coding",
    ],
    { cwd: process.cwd(), reject: false, timeout: 5000 },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /passed/);
  assert.equal(await readFile(join(cwd, "cli.txt"), "utf8"), "cli-ok\n");

  const runs = await readdir(join(cwd, ".loom", "runs"));
  assert.equal(runs.length, 1);
  const summary = JSON.parse(await readFile(join(cwd, ".loom", "runs", runs[0], "summary.json"), "utf8"));
  assert.equal(summary.status, "passed");
  assert.deepEqual(summary.skills, ["coding"]);
});

test("loom goal forwards skills into native goal context", async () => {
  const root = await tempDir("loom-cli-native-goal-skills");
  const workspaceRoot = join(root, "workspace");
  const projectRoot = join(workspaceRoot, "proj-a");
  const fakeBin = join(root, "bin");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await execa("git", ["init"], { cwd: projectRoot });
  await execa("git", ["config", "user.email", "loom@example.test"], { cwd: projectRoot });
  await execa("git", ["config", "user.name", "Loom Test"], { cwd: projectRoot });
  await writeFile(join(projectRoot, "README.md"), "# app\n", "utf8");
  await execa("git", ["add", "README.md"], { cwd: projectRoot });
  await execa("git", ["commit", "-m", "initial"], { cwd: projectRoot });
  await execa("git", ["branch", "-M", "main"], { cwd: projectRoot });
  await writeFile(join(root, "loom.config.json"), JSON.stringify({
    workspaceRoot,
    engine: "codex",
    gatewayUrl: "http://gateway.internal:4000",
    gatewayKeyEnv: "LOOM_GATEWAY_KEY",
    models: { default: "kimi-k2.6" },
  }, null, 2), "utf8");
  await writeFile(join(fakeBin, "codex"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await chmod(join(fakeBin, "codex"), 0o755);

  const result = await execa(
    "npx",
    [
      "--prefix",
      process.cwd(),
      "tsx",
      join(process.cwd(), "src/index.ts"),
      "goal",
      "tests pass",
      "--project",
      "proj-a",
      "--worktree",
      "task-7",
      "--skill",
      "coding",
      "--skill",
      "vas-lite",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        LOOM_GATEWAY_KEY: "dev-virtual-key",
      },
      reject: false,
      timeout: 10_000,
    },
  );

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const contextPath = join(projectRoot, ".wt", "task-7", ".loom", "native-goal.json");
  const context = JSON.parse(await readFile(contextPath, "utf8"));
  assert.deepEqual(context.skills, ["coding", "vas-lite"]);
  assert.equal(JSON.stringify(context).includes("dev-virtual-key"), false);
});

test("loom harness run ingests structured brain signals", async () => {
  const root = await tempDir("loom-cli-brain-signal");
  const workspace = join(root, "work");
  const skillsRepo = join(root, "skills");
  const scriptPath = join(root, "script.json");
  await writeFile(join(root, "loom.config.json"), JSON.stringify({ skillsRepo }, null, 2), "utf8");
  await writeFile(scriptPath, JSON.stringify([{ message: "finish", finish: true }]), "utf8");

  const result = await execa(
    "npx",
    [
      "--prefix",
      process.cwd(),
      "tsx",
      join(process.cwd(), "src/index.ts"),
      "harness",
      "run",
      "record structured brain signal",
      "--cwd",
      workspace,
      "--script",
      scriptPath,
      "--issue",
      "team/app#42",
      "--gitea-url",
      "https://git.example",
      "--public-url",
      "https://loom.example",
      "--ingest-brain",
      "--skill",
      "coding",
    ],
    { cwd: root, reject: false },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  const signal = JSON.parse(await readFile(join(skillsRepo, ".brain", "signals.jsonl"), "utf8"));
  assert.equal(signal.runId, summary.runId);
  assert.equal(signal.status, "passed");
  assert.equal(signal.runDir, summary.runDir);
  assert.equal(signal.issue, "team/app#42");
  assert.equal(signal.issueUrl, "https://git.example/team/app/issues/42");
  assert.equal(signal.dashboardUrl, `https://loom.example/?tenant=local&project=work&runId=${summary.runId}`);
  assert.equal(signal.summaryUrl, `https://loom.example/tenants/local/runs/${summary.runId}?project=work`);
  assert.equal(signal.reviewSummaryUrl, `https://loom.example/tenants/local/runs/${summary.runId}/review-summary?project=work`);
  assert.equal(signal.handoffPackageUrl, `https://loom.example/tenants/local/runs/${summary.runId}/handoff-package?project=work`);
  assert.equal(signal.handoffFollowupsUrl, `https://loom.example/tenants/local/runs/${summary.runId}/handoff-runs?project=work`);
  assert.equal(signal.outcome, "pass");
});

test("loom harness run includes reviewer evidence in brain signal notes", async () => {
  const root = await tempDir("loom-cli-brain-reviewer-note");
  const workspace = join(root, "work");
  const skillsRepo = join(root, "skills");
  const scriptPath = join(root, "script.json");
  await writeFile(join(root, "loom.config.json"), JSON.stringify({ skillsRepo }, null, 2), "utf8");
  await writeFile(scriptPath, JSON.stringify([{ message: "finish", finish: true }]), "utf8");

  const result = await execa(
    "npx",
    [
      "--prefix",
      process.cwd(),
      "tsx",
      join(process.cwd(), "src/index.ts"),
      "harness",
      "run",
      "record reviewer signal note",
      "--cwd",
      workspace,
      "--script",
      scriptPath,
      "--reviewer",
      "printf reviewer-evidence; exit 9",
      "--ingest-brain",
      "--skill",
      "coding",
    ],
    { cwd: root, reject: false },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "passed");
  assert.equal(summary.reviewer.ok, false);
  const signal = JSON.parse(await readFile(join(skillsRepo, ".brain", "signals.jsonl"), "utf8"));
  assert.equal(signal.runId, summary.runId);
  assert.equal(signal.outcome, "pass");
  assert.match(signal.notes, /reviewer flagged exit 9/);
  assert.match(signal.notes, /printf reviewer-evidence; exit 9/);
});

test("loom harness run ingests evaluator failure notes for brain proposals", async () => {
  const root = await tempDir("loom-cli-brain-evaluation-note");
  const workspace = join(root, "work");
  const skillsRepo = join(root, "skills");
  const scriptPath = join(root, "script.json");
  await writeFile(join(root, "loom.config.json"), JSON.stringify({ skillsRepo }, null, 2), "utf8");
  await writeFile(scriptPath, JSON.stringify([{ message: "finish", finish: true }]), "utf8");

  const result = await execa(
    "npx",
    [
      "--prefix",
      process.cwd(),
      "tsx",
      join(process.cwd(), "src/index.ts"),
      "harness",
      "run",
      "record evaluator failure signal",
      "--cwd",
      workspace,
      "--script",
      scriptPath,
      "--verify",
      "true",
      "--evaluate",
      "printf evaluator-note >&2; exit 7",
      "--ingest-brain",
      "--skill",
      "coding",
    ],
    { cwd: root, reject: false },
  );

  assert.equal(result.exitCode, 1);
  const summary = JSON.parse(result.stdout);
  const signal = JSON.parse(await readFile(join(skillsRepo, ".brain", "signals.jsonl"), "utf8"));
  assert.equal(signal.runId, summary.runId);
  assert.equal(signal.status, "failed");
  assert.equal(signal.outcome, "fail");
  assert.equal(signal.failureKind, "evaluation");
  assert.match(signal.notes, /evaluation failed exit 7/);
  assert.match(signal.notes, /printf evaluator-note >&2; exit 7/);
});

test("loom harness run ingests verification failure notes for brain proposals", async () => {
  const root = await tempDir("loom-cli-brain-verification-note");
  const workspace = join(root, "work");
  const skillsRepo = join(root, "skills");
  const scriptPath = join(root, "script.json");
  await writeFile(join(root, "loom.config.json"), JSON.stringify({ skillsRepo }, null, 2), "utf8");
  await writeFile(scriptPath, JSON.stringify([{ message: "finish", finish: true }]), "utf8");

  const result = await execa(
    "npx",
    [
      "--prefix",
      process.cwd(),
      "tsx",
      join(process.cwd(), "src/index.ts"),
      "harness",
      "run",
      "record verification failure signal",
      "--cwd",
      workspace,
      "--script",
      scriptPath,
      "--verify",
      "printf verification-note >&2; exit 5",
      "--ingest-brain",
      "--skill",
      "coding",
    ],
    { cwd: root, reject: false },
  );

  assert.equal(result.exitCode, 1);
  const summary = JSON.parse(result.stdout);
  const signal = JSON.parse(await readFile(join(skillsRepo, ".brain", "signals.jsonl"), "utf8"));
  assert.equal(signal.runId, summary.runId);
  assert.equal(signal.status, "failed");
  assert.equal(signal.outcome, "fail");
  assert.equal(signal.failureKind, "verification");
  assert.match(signal.notes, /verification failed exit 5/);
  assert.match(signal.notes, /printf verification-note >&2; exit 5/);
});

test("loom harness run ingests reporter error notes for brain proposals", async () => {
  const root = await tempDir("loom-cli-brain-reporter-note");
  const workspace = join(root, "work");
  const skillsRepo = join(root, "skills");
  const scriptPath = join(root, "script.json");
  await writeFile(join(root, "loom.config.json"), JSON.stringify({ skillsRepo }, null, 2), "utf8");
  await writeFile(scriptPath, JSON.stringify([{ message: "finish", finish: true }]), "utf8");
  const giteaServer = createServer(async (req, res) => {
    assert.equal(req.url, "/api/v1/repos/team/app/issues/42/comments");
    assert.equal(req.headers.authorization, "token cli-token");
    await readBody(req);
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("issue tracker unavailable");
  });
  await new Promise<void>((resolve) => giteaServer.listen(0, "127.0.0.1", resolve));
  const address = giteaServer.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "--prefix",
        process.cwd(),
        "tsx",
        join(process.cwd(), "src/index.ts"),
        "harness",
        "run",
        "record reporter failure signal",
        "--cwd",
        workspace,
        "--script",
        scriptPath,
        "--issue",
        "team/app#42",
        "--gitea-comment",
        "--gitea-url",
        `http://127.0.0.1:${address.port}`,
        "--gitea-token-env",
        "LOOM_TEST_GITEA_TOKEN",
        "--ingest-brain",
        "--skill",
        "coding",
      ],
      {
        cwd: root,
        env: { ...process.env, LOOM_TEST_GITEA_TOKEN: "cli-token" },
        reject: false,
      },
    );

    assert.equal(result.exitCode, 1);
    const summary = JSON.parse(result.stdout);
    const signal = JSON.parse(await readFile(join(skillsRepo, ".brain", "signals.jsonl"), "utf8"));
    assert.equal(signal.runId, summary.runId);
    assert.equal(signal.status, "error");
    assert.equal(signal.outcome, "fail");
    assert.equal(signal.failureKind, "reporter");
    assert.match(signal.notes, /error issue reporter failed: Gitea issue comment failed with 502: issue tracker unavailable/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      giteaServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness run ingests model protocol diagnostics for brain proposals", async () => {
  const root = await tempDir("loom-cli-brain-model-diagnostic-note");
  const workspace = join(root, "work");
  const skillsRepo = join(root, "skills");
  await writeFile(join(root, "loom.config.json"), JSON.stringify({ skillsRepo }, null, 2), "utf8");
  let calls = 0;
  const modelServer = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer cli-key");
    await readBody(req);
    calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "not json" } }] }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "--prefix",
        process.cwd(),
        "tsx",
        join(process.cwd(), "src/index.ts"),
        "harness",
        "run",
        "record model protocol diagnostic signal",
        "--cwd",
        workspace,
        "--model",
        "test-model",
        "--model-base-url",
        `http://127.0.0.1:${address.port}`,
        "--model-key-env",
        "LOOM_TEST_MODEL_KEY",
        "--ingest-brain",
        "--skill",
        "coding",
      ],
      {
        cwd: root,
        env: { ...process.env, LOOM_TEST_MODEL_KEY: "cli-key" },
        reject: false,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(calls, 2);
    const summary = JSON.parse(result.stdout);
    const signal = JSON.parse(await readFile(join(skillsRepo, ".brain", "signals.jsonl"), "utf8"));
    assert.equal(signal.runId, summary.runId);
    assert.equal(signal.status, "error");
    assert.equal(signal.failureKind, "agent");
    assert.match(signal.notes, /errorKind model_agent_protocol/);
    assert.match(signal.notes, /responseExcerpt=not json/);
    assert.equal(JSON.stringify(signal).includes("cli-key"), false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      modelServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness run includes model usage in brain signals", async () => {
  const root = await tempDir("loom-cli-brain-model-usage");
  const workspace = join(root, "work");
  const skillsRepo = join(root, "skills");
  await writeFile(join(root, "loom.config.json"), JSON.stringify({ skillsRepo }, null, 2), "utf8");
  let calls = 0;
  const modelServer = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer cli-key");
    await readBody(req);
    calls += 1;
    const step =
      calls === 1
        ? {
            message: "write model usage artifact",
            actions: [
              {
                toolName: "file.write",
                input: { path: "usage.txt", content: "usage-ok\n" },
              },
            ],
          }
        : { message: "finish", finish: true };
    res.writeHead(200, {
      "content-type": "application/json",
      "x-litellm-response-cost": calls === 1 ? "0.001" : "0.0005",
    });
    res.end(JSON.stringify({
      model: "gateway-model",
      usage: {
        prompt_tokens: calls === 1 ? 20 : 7,
        completion_tokens: calls === 1 ? 8 : 3,
        total_tokens: calls === 1 ? 28 : 10,
      },
      choices: [{ message: { content: JSON.stringify(step) } }],
    }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "--prefix",
        process.cwd(),
        "tsx",
        join(process.cwd(), "src/index.ts"),
        "harness",
        "run",
        "record model usage signal",
        "--cwd",
        workspace,
        "--model",
        "test-model",
        "--model-base-url",
        `http://127.0.0.1:${address.port}`,
        "--model-key-env",
        "LOOM_TEST_MODEL_KEY",
        "--verify",
        "test -f usage.txt",
        "--ingest-brain",
        "--skill",
        "coding",
      ],
      {
        cwd: root,
        env: { ...process.env, LOOM_TEST_MODEL_KEY: "cli-key" },
        reject: false,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(calls, 2);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.modelUsage, {
      requestCount: 2,
      promptTokens: 27,
      completionTokens: 11,
      totalTokens: 38,
      costUsd: 0.0015,
    });
    const signal = JSON.parse(await readFile(join(skillsRepo, ".brain", "signals.jsonl"), "utf8"));
    assert.equal(signal.runId, summary.runId);
    assert.equal(signal.modelRequestCount, 2);
    assert.equal(signal.modelPromptTokens, 27);
    assert.equal(signal.modelCompletionTokens, 11);
    assert.equal(signal.modelTotalTokens, 38);
    assert.equal(signal.modelCostUsd, 0.0015);
    assert.equal(JSON.stringify(signal).includes("cli-key"), false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      modelServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness run ingests handoff gate evidence notes for brain proposals", async () => {
  const root = await tempDir("loom-cli-brain-handoff-note");
  const workspace = join(root, "work");
  const skillsRepo = join(root, "skills");
  const scriptPath = join(root, "script.json");
  await writeFile(join(root, "loom.config.json"), JSON.stringify({ skillsRepo }, null, 2), "utf8");
  await writeFile(scriptPath, JSON.stringify([{ message: "finish", finish: true }]), "utf8");
  const giteaServer = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "token cli-token");
    if (req.url === "/api/v1/repos/team/app/pulls") {
      await readBody(req);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ index: 9, html_url: "https://git.example/team/app/pulls/9" }));
      return;
    }
    assert.equal(req.url, "/api/v1/repos/team/app/issues/42/comments");
    await readBody(req);
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("issue tracker unavailable");
  });
  await new Promise<void>((resolve) => giteaServer.listen(0, "127.0.0.1", resolve));
  const address = giteaServer.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "--prefix",
        process.cwd(),
        "tsx",
        join(process.cwd(), "src/index.ts"),
        "harness",
        "run",
        "record handoff evidence signal",
        "--cwd",
        workspace,
        "--script",
        scriptPath,
        "--issue",
        "team/app#42",
        "--branch",
        "task/42",
        "--require-review",
        "--gitea-pr",
        "--gitea-comment",
        "--gitea-url",
        `http://127.0.0.1:${address.port}`,
        "--gitea-token-env",
        "LOOM_TEST_GITEA_TOKEN",
        "--ingest-brain",
        "--skill",
        "coding",
      ],
      {
        cwd: root,
        env: { ...process.env, LOOM_TEST_GITEA_TOKEN: "cli-token" },
        reject: false,
      },
    );

    assert.equal(result.exitCode, 1);
    const summary = JSON.parse(result.stdout);
    const signal = JSON.parse(await readFile(join(skillsRepo, ".brain", "signals.jsonl"), "utf8"));
    assert.equal(signal.runId, summary.runId);
    assert.equal(signal.status, "error");
    assert.equal(signal.outcome, "fail");
    assert.match(signal.notes, /error issue reporter failed/);
    assert.match(signal.notes, /review pending/);
    assert.match(signal.notes, /pullRequest https:\/\/git\.example\/team\/app\/pulls\/9/);
    assert.match(signal.notes, /branch task\/42/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      giteaServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness run fails when evaluator commands fail", async () => {
  const cwd = await tempDir("loom-cli-evaluation-fail");
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify([{ message: "finish", finish: true }]), "utf8");

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "run",
      "evaluate before accepting",
      "--cwd",
      cwd,
      "--script",
      scriptPath,
      "--verify",
      "true",
      "--evaluate",
      "printf cli-evaluator-failed >&2; exit 7",
    ],
    { cwd: process.cwd(), reject: false, timeout: 5000 },
  );

  assert.equal(result.exitCode, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "failed");
  assert.equal(summary.verification.ok, true);
  assert.equal(summary.evaluation.ok, false);
  assert.equal(summary.evaluation.exitCode, 7);
});

test("loom harness run records reviewer command evidence", async () => {
  const cwd = await tempDir("loom-cli-reviewer");
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify([{ message: "finish", finish: true }]), "utf8");

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "run",
      "prepare reviewer evidence",
      "--cwd",
      cwd,
      "--script",
      scriptPath,
      "--verify",
      "true",
      "--reviewer",
      "printf cli-reviewer-note",
      "--require-review",
    ],
    { cwd: process.cwd(), reject: false, timeout: 5000 },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "review_required");
  assert.equal(summary.reviewer.ok, true);
  assert.deepEqual(summary.reviewer.commands, ["printf cli-reviewer-note"]);
  assert.match(summary.reviewer.output, /cli-reviewer-note/);
});

test("loom harness run can require deployment approval", async () => {
  const cwd = await tempDir("loom-cli-deployment");
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify([{ message: "finish", finish: true }]), "utf8");

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "run",
      "hold for production deployment",
      "--cwd",
      cwd,
      "--script",
      scriptPath,
      "--verify",
      "true",
      "--require-deployment",
    ],
    { cwd: process.cwd(), reject: false, timeout: 5000 },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const { summary, events } = await readOnlyRun(cwd);
  assert.equal(summary.status, "deployment_required");
  assert.deepEqual(summary.deployment, { required: true, status: "pending" });
  assert.ok(events.some((event) =>
    event.type === "deployment_gate" &&
    event.data.required === true &&
    event.data.status === "pending"
  ));
});

test("loom harness serve exposes workspace session limit options", async () => {
  const result = await execa(
    "npx",
    ["tsx", "src/index.ts", "harness", "serve", "--help"],
    { cwd: process.cwd(), reject: false, maxBuffer: 20_000 },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /--workspace-command-timeout-ms/);
  assert.match(result.stdout, /--max-workspace-sessions/);
  assert.match(result.stdout, /--max-tenant-workspace-sessions/);
  assert.match(result.stdout, /--max-tenant-active-runs/);
  assert.match(result.stdout, /--workspace-session-idle-timeout-ms/);
  assert.match(result.stdout, /--run-lease-ttl-ms/);
  assert.match(result.stdout, /--state-probe-interval-ms/);
  assert.match(result.stdout, /--state-probe-timeout-ms/);
  assert.match(result.stdout, /--state-probe-max-staleness-ms/);
  assert.match(result.stdout, /--oidc-issuer/);
  assert.match(result.stdout, /--oidc-audience/);
  assert.match(result.stdout, /--oidc-jwks-url/);
  assert.match(result.stdout, /--oidc-allow-insecure-http/);
  assert.match(result.stdout, /--auto-abandon-stale-runs/);
  assert.match(result.stdout, /--executor-cpus/);
  assert.match(result.stdout, /--executor-memory/);
  assert.match(result.stdout, /--executor-pids-limit/);
  assert.match(result.stdout, /--executor-home-root/);
  assert.match(result.stdout, /--ingest-brain/);
  assert.match(result.stdout, /--control-plane-provider/);
  assert.match(result.stdout, /--control-plane-pr/);
  assert.match(result.stdout, /--control-plane-comment-sync/);
  assert.match(result.stdout, /--control-plane-webhook-secret-env/);
  assert.match(result.stdout, /--tenant-control-plane-token-env/);
  assert.match(result.stdout, /--agent-git-service-token-secret-root/);
  assert.match(result.stdout, /--gitea-webhook-secret-env/);
  assert.match(result.stdout, /--tenant-key/);
  assert.match(result.stdout, /--tenant-key-env/);
  assert.match(result.stdout, /--tenant-model-key/);
  assert.match(result.stdout, /--allow-unsafe-local-executor/);
});

test("loom harness serve accepts agent-git-service as a serve-enabled candidate provider", async () => {
  const workspaceRoot = await tempDir("loom-cli-serve-agent-git-service-provider");
  const secretRoot = await tempDir("loom-cli-serve-agent-git-service-secrets");
  const result = await execa(
    process.execPath,
    [
      "dist/index.js",
      "harness",
      "serve",
      "--workspace-root",
      workspaceRoot,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--control-plane-provider",
      "agent-git-service",
      "--agent-git-service-token-secret-root",
      secretRoot,
    ],
    { cwd: process.cwd(), reject: false, timeout: 5000 },
  );

  assert.doesNotMatch(result.stderr, /serve-enabled providers/);
  assert.match(result.stdout, /"controlPlaneProvider": "agent-git-service"/);
});

test("loom harness serve reports missing agent-git-service shared token with provider-neutral flags", async () => {
  const workspaceRoot = await tempDir("loom-cli-serve-agent-git-service-missing-shared-token");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "serve",
      "--workspace-root",
      workspaceRoot,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--control-plane-provider",
      "agent-git-service",
      "--control-plane-pr",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, LOOM_AGENT_GIT_SERVICE_TOKEN: "" },
      reject: false,
      timeout: 5000,
    },
  );

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--control-plane-token-env LOOM_AGENT_GIT_SERVICE_TOKEN is required when --control-plane-pr is used/);
  assert.doesNotMatch(result.stderr, /--gitea-pr/);
  assert.doesNotMatch(result.stderr, /Gitea token/);
});

test("loom harness serve reports missing agent-git-service tenant token with provider-neutral flags", async () => {
  const workspaceRoot = await tempDir("loom-cli-serve-agent-git-service-missing-tenant-token");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "serve",
      "--workspace-root",
      workspaceRoot,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--control-plane-provider",
      "agent-git-service",
      "--control-plane-comment-sync",
      "--tenant-control-plane-token-env",
      "alice=LOOM_TEST_MISSING_AGENT_GIT_SERVICE_TOKEN",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, LOOM_TEST_MISSING_AGENT_GIT_SERVICE_TOKEN: "" },
      reject: false,
      timeout: 5000,
    },
  );

  assert.equal(result.exitCode, 2);
  assert.match(
    result.stderr,
    /--control-plane-comment-sync requires tenant alice control-plane token env LOOM_TEST_MISSING_AGENT_GIT_SERVICE_TOKEN to be set/,
  );
  assert.doesNotMatch(result.stderr, /--gitea-comment-sync/);
  assert.doesNotMatch(result.stderr, /Gitea token/);
});

test("loom harness provision-agent-git-service posts an admin provisioning request without leaking the admin token", async () => {
  let receivedPath = "";
  let receivedAuthorization = "";
  let receivedBody: unknown;
  const server = createServer(async (req, res) => {
    receivedPath = req.url ?? "";
    receivedAuthorization = String(req.headers.authorization ?? "");
    receivedBody = JSON.parse(await readBody(req));
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({
      receiptPath: ".loom/control-plane/agent-git-service/provisioning.json",
      receipt: {
        provider: "agent-git-service",
        project: "proj-a",
        repo: "team/app",
        agentLogin: "loom-agent-1",
        agentRepoFullName: "loom-agent-1/proj-a",
        permission: "admin",
        grantStatus: "granted",
        tokenEnvName: "LOOM_ALICE_PROJ_A_AGENT_TOKEN",
        tokenMaterial: "returned-only",
      },
      agentTokenSecret: {
        stored: true,
        tokenEnvName: "LOOM_ALICE_PROJ_A_AGENT_TOKEN",
        secretRef: "alice/proj-a/LOOM_ALICE_PROJ_A_AGENT_TOKEN",
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "provision-agent-git-service",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "proj-a",
        "--admin-token-env",
        "LOOM_TEST_HARNESS_ADMIN_TOKEN",
        "--repo",
        "team/app",
        "--permission",
        "admin",
        "--agent-prefix-login",
        "loom-alice-proj-a",
        "--default-repo-name",
        "proj-a",
        "--token-env-name",
        "LOOM_ALICE_PROJ_A_AGENT_TOKEN",
        "--identity-actor",
        "alice-agent",
        "--identity-role",
        "developer",
        "--store-agent-token",
        "--client-id",
        "cli-admin",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_HARNESS_ADMIN_TOKEN: "admin-secret" },
        reject: false,
        timeout: 5000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(receivedPath, "/tenants/alice/projects/proj-a/control-plane/agent-git-service/provision");
    assert.equal(receivedAuthorization, "Bearer admin-secret");
    assert.deepEqual(receivedBody, {
      repo: "team/app",
      permission: "admin",
      agentPrefixLogin: "loom-alice-proj-a",
      defaultRepoName: "proj-a",
      tokenEnvName: "LOOM_ALICE_PROJ_A_AGENT_TOKEN",
      controlPlaneIdentity: { actor: "alice-agent", role: "developer" },
      storeAgentToken: true,
      clientId: "cli-admin",
    });
    const body = JSON.parse(result.stdout);
    assert.equal("agentToken" in body, false);
    assert.equal(body.agentTokenSecret.secretRef, "alice/proj-a/LOOM_ALICE_PROJ_A_AGENT_TOKEN");
    assert.equal(body.receipt.agentLogin, "loom-agent-1");
    assert.equal(result.stdout.includes("admin-secret"), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness agent-git-service-provisioning-plan reads the tenant operator plan without leaking the admin token", async () => {
  let receivedMethod = "";
  let receivedPath = "";
  let receivedAuthorization = "";
  const server = createServer(async (req, res) => {
    receivedMethod = req.method ?? "";
    receivedPath = req.url ?? "";
    receivedAuthorization = String(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      schemaVersion: 1,
      tenant: "alice",
      provider: "agent-git-service",
      projectCount: 1,
      readyProjectCount: 0,
      provisionedProjectCount: 0,
      secretRootConfigured: true,
      secretStoredProjectCount: 0,
      missingProjectCount: 1,
      missingSecretProjectCount: 0,
      repoConfiguredProjectCount: 1,
      projects: [
        {
          project: "proj-a",
          ready: false,
          receiptPresent: false,
          secretRootConfigured: true,
          secretStored: false,
          repoConfigured: true,
          repo: "team/proj-a",
          permission: "write",
          tokenEnvName: "LOOM_ALICE_PROJ_A_AGENT_TOKEN",
          missing: ["receipt"],
          provisionCommandArgs: [
            "loom",
            "harness",
            "provision-agent-git-service",
            "--tenant",
            "alice",
            "--project",
            "proj-a",
            "--repo",
            "team/proj-a",
            "--token-env-name",
            "LOOM_ALICE_PROJ_A_AGENT_TOKEN",
            "--permission",
            "write",
            "--store-agent-token",
          ],
        },
      ],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "agent-git-service-provisioning-plan",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--admin-token-env",
        "LOOM_TEST_HARNESS_ADMIN_TOKEN",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_HARNESS_ADMIN_TOKEN: "admin-secret" },
        reject: false,
        timeout: 5000,
      },
    );

    if (result.exitCode !== 0) {
      assert.fail(result.stderr || result.stdout);
    }
    assert.equal(receivedMethod, "GET");
    assert.equal(receivedPath, "/tenants/alice/control-plane/agent-git-service/provisioning-plan");
    assert.equal(receivedAuthorization, "Bearer admin-secret");
    const body = JSON.parse(result.stdout);
    assert.equal(body.provider, "agent-git-service");
    assert.equal(body.projects[0].provisionCommandArgs[2], "provision-agent-git-service");
    assert.equal(result.stdout.includes("admin-secret"), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness apply-agent-git-service-provisioning-plan applies the tenant operator plan without leaking the admin token", async () => {
  let receivedMethod = "";
  let receivedPath = "";
  let receivedAuthorization = "";
  let receivedBody: any;
  const server = createServer(async (req, res) => {
    receivedMethod = req.method ?? "";
    receivedPath = req.url ?? "";
    receivedAuthorization = String(req.headers.authorization ?? "");
    receivedBody = JSON.parse(await readBody(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      schemaVersion: 1,
      tenant: "alice",
      provider: "agent-git-service",
      dryRun: true,
      tokenMaterial: "stored-only",
      projectCount: 2,
      eligibleProjectCount: 2,
      wouldProvisionProjectCount: 2,
      provisionedProjectCount: 0,
      skippedProjectCount: 0,
      failedProjectCount: 0,
      projects: [
        { project: "proj-a", status: "would-provision", repo: "team/proj-a" },
        { project: "proj-b", status: "would-provision", repo: "team/proj-b" },
      ],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "apply-agent-git-service-provisioning-plan",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--admin-token-env",
        "LOOM_TEST_HARNESS_ADMIN_TOKEN",
        "--projects",
        "proj-a,proj-b",
        "--dry-run",
        "--eligible-only",
        "--client-id",
        "cli-apply",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_HARNESS_ADMIN_TOKEN: "admin-secret" },
        reject: false,
        timeout: 5000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(receivedMethod, "POST");
    assert.equal(receivedPath, "/tenants/alice/control-plane/agent-git-service/provisioning-plan/apply");
    assert.equal(receivedAuthorization, "Bearer admin-secret");
    assert.deepEqual(receivedBody, {
      projects: ["proj-a", "proj-b"],
      dryRun: true,
      eligibleOnly: true,
      clientId: "cli-apply",
    });
    const body = JSON.parse(result.stdout);
    assert.equal(body.tokenMaterial, "stored-only");
    assert.equal(body.projects[0].status, "would-provision");
    assert.equal(result.stdout.includes("admin-secret"), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness cutover-report blocks agent-git-service cutover until project agents are ready", async () => {
  const requestedPaths: string[] = [];
  const authorizations: string[] = [];
  const server = createServer(async (req, res) => {
    requestedPaths.push(req.url ?? "");
    authorizations.push(String(req.headers.authorization ?? ""));
    res.setHeader("content-type", "application/json");
    if (req.url === "/status") {
      res.end(JSON.stringify({
        server: {
          profile: "platform-readiness",
          controlPlane: expectedControlPlane("agent-git-service"),
          runWorkspaceIsolation: "run",
          concurrencyAdmission: concurrencyAdmissionFixture("run"),
        },
        readiness: {
          profile: "platform-readiness",
          ok: true,
          missing: [],
          goldenPath: {
            required: true,
            ok: true,
            capabilities: onlineSandboxGoldenPathCapabilities(),
            missingCapabilities: [],
          },
        },
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: false,
          capabilities: visionLockCapabilities(),
        },
      }));
      return;
    }
    if (req.url === "/tenants/alice/status") {
      res.end(JSON.stringify({
        server: {
          controlPlane: expectedControlPlane("agent-git-service"),
          runWorkspaceIsolation: "run",
          concurrencyAdmission: concurrencyAdmissionFixture("run"),
        },
        readiness: {
          profile: "platform-readiness",
          ok: true,
          missing: [],
          goldenPath: {
            required: true,
            ok: true,
            capabilities: onlineSandboxGoldenPathCapabilities(),
            missingCapabilities: [],
          },
        },
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: false,
          capabilities: visionLockCapabilities(),
        },
      }));
      return;
    }
    if (req.url === "/tenants/alice/control-plane/agent-git-service/provisioning-plan") {
      res.end(JSON.stringify({
        schemaVersion: 1,
        tenant: "alice",
        provider: "agent-git-service",
        projectCount: 1,
        readyProjectCount: 0,
        missingProjectCount: 1,
        missingSecretProjectCount: 0,
        projects: [
          {
            project: "proj-a",
            ready: false,
            missing: ["receipt"],
            provisionCommandArgs: [
              "loom",
              "harness",
              "provision-agent-git-service",
              "--tenant",
              "alice",
              "--project",
              "proj-a",
              "--repo",
              "team/proj-a",
              "--store-agent-token",
            ],
          },
        ],
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "cutover-report",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--admin-token-env",
        "LOOM_TEST_HARNESS_ADMIN_TOKEN",
        "--control-plane-provider",
        "agent-git-service",
        "--project",
        "proj-a",
        "--isolation-tenant",
        "bob",
        "--viewer-token-env",
        "LOOM_TEST_VIEWER_TOKEN",
        "--control-plane-webhook-secret-env",
        "LOOM_TEST_WEBHOOK_SECRET",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOOM_TEST_TENANT_TOKEN: "dev-secret",
          LOOM_TEST_HARNESS_ADMIN_TOKEN: "admin-secret",
          LOOM_TEST_VIEWER_TOKEN: "viewer-secret",
          LOOM_TEST_WEBHOOK_SECRET: "actual-secret-value",
        },
        reject: false,
        timeout: 5000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.deepEqual(requestedPaths, [
      "/status",
      "/tenants/alice/status",
      "/tenants/alice/control-plane/agent-git-service/provisioning-plan",
    ]);
    assert.deepEqual(authorizations, ["Bearer admin-secret", "Bearer dev-secret", "Bearer admin-secret"]);
    assert.equal(result.stdout.includes("admin-secret"), false);
    assert.equal(result.stdout.includes("dev-secret"), false);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.tenant, "alice");
    assert.equal(body.controlPlaneProvider, "agent-git-service");
    assert.deepEqual(body.missing, ["agentGitServiceProjectAgents"]);
    assert.deepEqual(body.nextActions, [
      "loom harness apply-agent-git-service-provisioning-plan --url <harness-url> --tenant alice --admin-token-env LOOM_TEST_HARNESS_ADMIN_TOKEN --dry-run",
      "loom harness apply-agent-git-service-provisioning-plan --url <harness-url> --tenant alice --admin-token-env LOOM_TEST_HARNESS_ADMIN_TOKEN",
      "loom harness smoke --profile platform-readiness --control-plane-provider agent-git-service",
    ]);
    assert.equal(body.agentGitServiceProvisioningCommandsReady, true);
    assert.deepEqual(body.agentGitServiceProvisioningCommandsMissingInputs, []);
    assert.deepEqual(body.agentGitServiceProvisioningPlanCommandArgs, [
      "loom",
      "harness",
      "agent-git-service-provisioning-plan",
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--tenant",
      "alice",
      "--admin-token-env",
      "LOOM_TEST_HARNESS_ADMIN_TOKEN",
    ]);
    assert.deepEqual(body.agentGitServiceProvisioningPlanDryRunCommandArgs, [
      "loom",
      "harness",
      "apply-agent-git-service-provisioning-plan",
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--tenant",
      "alice",
      "--admin-token-env",
      "LOOM_TEST_HARNESS_ADMIN_TOKEN",
      "--dry-run",
    ]);
    assert.deepEqual(body.agentGitServiceProvisioningPlanApplyCommandArgs, [
      "loom",
      "harness",
      "apply-agent-git-service-provisioning-plan",
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--tenant",
      "alice",
      "--admin-token-env",
      "LOOM_TEST_HARNESS_ADMIN_TOKEN",
    ]);
    assert.equal(body.serverReadinessOk, true);
    assert.equal(body.tenantReadinessOk, true);
    assert.deepEqual(body.agentGitService.missingProjects, ["proj-a"]);
    assert.deepEqual(body.agentGitService.projectMissing, { "proj-a": ["receipt"] });
    assert.deepEqual(body.agentGitService.provisionCommandArgsByProject, {
      "proj-a": [
        "loom",
        "harness",
        "provision-agent-git-service",
        "--tenant",
        "alice",
        "--project",
        "proj-a",
        "--repo",
        "team/proj-a",
        "--store-agent-token",
      ],
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness cutover-report blocks vision lock and golden-path scope drift", async () => {
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/status") {
      res.end(JSON.stringify({
        server: {
          profile: "platform-readiness",
          controlPlane: expectedControlPlane(),
          runWorkspaceIsolation: "run",
          concurrencyAdmission: concurrencyAdmissionFixture("run"),
        },
        readiness: {
          profile: "platform-readiness",
          ok: true,
          missing: [],
          goldenPath: {
            required: true,
            ok: true,
            capabilities: onlineSandboxGoldenPathCapabilities().filter((capability) => capability !== "human-gates"),
            missingCapabilities: [],
          },
        },
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: true,
          capabilities: visionLockCapabilities(),
        },
      }));
      return;
    }
    if (req.url === "/tenants/alice/status") {
      res.end(JSON.stringify({
        server: {
          controlPlane: expectedControlPlane(),
          runWorkspaceIsolation: "run",
          concurrencyAdmission: concurrencyAdmissionFixture("run"),
        },
        readiness: {
          profile: "platform-readiness",
          ok: true,
          missing: [],
          goldenPath: {
            required: true,
            ok: true,
            capabilities: onlineSandboxGoldenPathCapabilities().filter((capability) => capability !== "vas-lite-learning"),
            missingCapabilities: [],
          },
        },
        visionLock: {
          target: "single-user local harness",
          mvpIsScopeReduction: false,
          capabilities: visionLockCapabilities().filter((capability) => capability !== "brain-skill-evolution"),
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "cutover-report",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOOM_TEST_TENANT_TOKEN: "dev-secret",
        },
        reject: false,
        timeout: 5000,
      },
    );

    assert.equal(result.exitCode, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, false);
    assert.deepEqual(body.missing, ["serverGoldenPath", "tenantGoldenPath", "serverVisionLock", "tenantVisionLock"]);
    assert.equal(body.serverVisionLockOk, false);
    assert.equal(body.serverVisionLockMvpIsScopeReduction, true);
    assert.deepEqual(body.serverGoldenPathMissingCapabilities, ["human-gates"]);
    assert.equal(body.tenantVisionLockOk, false);
    assert.equal(body.tenantVisionLockTarget, "single-user local harness");
    assert.deepEqual(body.tenantVisionLockMissingCapabilities, ["brain-skill-evolution"]);
    assert.deepEqual(body.tenantGoldenPathMissingCapabilities, ["vas-lite-learning"]);
    assert.deepEqual(body.nextActions, [
      "loom harness doctor --profile platform-readiness",
      "loom harness smoke --profile platform-readiness",
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness cutover-report passes when platform and agent-git-service readiness are complete", async () => {
  const reportRoot = await tempDir("loom-cli-cutover-report-file");
  const reportPath = join(reportRoot, "cutover-report.json");
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/status") {
      res.end(JSON.stringify({
        server: {
          profile: "platform-readiness",
          controlPlane: expectedControlPlane("agent-git-service"),
          runWorkspaceIsolation: "run",
          concurrencyAdmission: concurrencyAdmissionFixture("run"),
        },
        readiness: {
          profile: "platform-readiness",
          ok: true,
          missing: [],
          checks: {
            controlPlaneDiscovery: {
              required: true,
              ok: true,
              provider: "agent-git-service",
              baseUrlConfigured: true,
              endpointCount: 6,
              okEndpointCount: 6,
              missingEndpoints: [],
              tokenMode: "tenant-scoped",
              tenantCount: 2,
              tenantOkCount: 2,
              missingTenants: [],
            },
          },
          goldenPath: {
            required: true,
            ok: true,
            capabilities: onlineSandboxGoldenPathCapabilities(),
            missingCapabilities: [],
          },
        },
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: false,
          capabilities: visionLockCapabilities(),
        },
      }));
      return;
    }
    if (req.url === "/tenants/alice/status") {
      res.end(JSON.stringify({
        server: {
          controlPlane: expectedControlPlane("agent-git-service"),
          runWorkspaceIsolation: "run",
          concurrencyAdmission: concurrencyAdmissionFixture("run"),
        },
        readiness: {
          profile: "platform-readiness",
          ok: true,
          missing: [],
          checks: {
            controlPlaneDiscovery: {
              required: true,
              ok: true,
              provider: "agent-git-service",
              baseUrlConfigured: true,
              endpointCount: 3,
              okEndpointCount: 3,
              missingEndpoints: [],
              tokenMode: "tenant-scoped",
              tenantCount: 1,
              tenantOkCount: 1,
              missingTenants: [],
            },
          },
          goldenPath: {
            required: true,
            ok: true,
            capabilities: onlineSandboxGoldenPathCapabilities(),
            missingCapabilities: [],
          },
        },
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: false,
          capabilities: visionLockCapabilities(),
        },
      }));
      return;
    }
    if (req.url === "/tenants/alice/control-plane/agent-git-service/provisioning-plan") {
      res.end(JSON.stringify({
        schemaVersion: 1,
        tenant: "alice",
        provider: "agent-git-service",
        projectCount: 1,
        readyProjectCount: 1,
        missingProjectCount: 0,
        missingSecretProjectCount: 0,
        projects: [{ project: "proj-a", ready: true, missing: [] }],
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "cutover-report",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--admin-token-env",
        "LOOM_TEST_HARNESS_ADMIN_TOKEN",
        "--control-plane-provider",
        "agent-git-service",
        "--project",
        "proj-a",
        "--isolation-tenant",
        "bob",
        "--viewer-token-env",
        "LOOM_TEST_VIEWER_TOKEN",
        "--control-plane-webhook-secret-env",
        "LOOM_TEST_WEBHOOK_SECRET",
        "--report",
        reportPath,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOOM_TEST_TENANT_TOKEN: "dev-secret",
          LOOM_TEST_HARNESS_ADMIN_TOKEN: "admin-secret",
          LOOM_TEST_VIEWER_TOKEN: "viewer-secret",
          LOOM_TEST_WEBHOOK_SECRET: "webhook-secret",
        },
        reject: false,
        timeout: 5000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), body);
    assert.deepEqual(body.missing, []);
    assert.deepEqual(body.nextActions, []);
    assert.equal(body.serverConcurrencyAdmissionOk, true);
    assert.equal(body.serverConcurrencyAdmissionSchemaVersion, "loom-concurrency-admission/v1");
    assert.equal(body.serverConcurrencyAdmissionRunWorkspaceIsolation, "run");
    assert.equal(body.serverConcurrencyAdmissionActiveRunClaimScope, "run");
    assert.deepEqual(body.serverConcurrencyAdmissionMissing, []);
    assert.equal(body.serverControlPlaneDiscoveryOk, true);
    assert.equal(body.serverControlPlaneDiscoveryTokenMode, "tenant-scoped");
    assert.equal(body.serverControlPlaneDiscoveryTenantCount, 2);
    assert.equal(body.serverControlPlaneDiscoveryTenantOkCount, 2);
    assert.deepEqual(body.serverControlPlaneDiscoveryMissingTenants, []);
    assert.equal(body.tenantConcurrencyAdmissionOk, true);
    assert.equal(body.tenantConcurrencyAdmissionSchemaVersion, "loom-concurrency-admission/v1");
    assert.equal(body.tenantConcurrencyAdmissionRunWorkspaceIsolation, "run");
    assert.equal(body.tenantConcurrencyAdmissionActiveRunClaimScope, "run");
    assert.deepEqual(body.tenantConcurrencyAdmissionMissing, []);
    assert.equal(body.tenantControlPlaneDiscoveryOk, true);
    assert.equal(body.tenantControlPlaneDiscoveryTokenMode, "tenant-scoped");
    assert.equal(body.tenantControlPlaneDiscoveryTenantCount, 1);
    assert.equal(body.tenantControlPlaneDiscoveryTenantOkCount, 1);
    assert.deepEqual(body.tenantControlPlaneDiscoveryMissingTenants, []);
    assert.equal(body.smokeCommandReady, true);
    assert.deepEqual(body.smokeCommandMissingInputs, []);
    assert.deepEqual(body.smokeCommandArgs, [
      "loom",
      "harness",
      "smoke",
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--tenant",
      "alice",
      "--project",
      "proj-a",
      "--template",
      "vas-lite",
      "--token-env",
      "LOOM_TEST_TENANT_TOKEN",
      "--viewer-token-env",
      "LOOM_TEST_VIEWER_TOKEN",
      "--admin-token-env",
      "LOOM_TEST_HARNESS_ADMIN_TOKEN",
      "--isolation-tenant",
      "bob",
      "--profile",
      "platform-readiness",
      "--control-plane-provider",
      "agent-git-service",
      "--control-plane-webhook-secret-env",
      "LOOM_TEST_WEBHOOK_SECRET",
      "--report",
      "reports/smoke.json",
    ]);
    assert.equal(result.stdout.includes("actual-secret-value"), false);
    assert.equal(body.agentGitService.readyProjectCount, 1);
    assert.deepEqual(body.agentGitService.missingProjects, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness doctor reports platform readiness gaps before serving", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-platform-gaps");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "doctor",
      "--workspace-root",
      workspaceRoot,
      "--profile",
      "platform-readiness",
      "--model-base-url",
      "https://model.example",
      "--model-key-env",
      "LOOM_TEST_MISSING_MODEL_KEY",
    ],
    { cwd: process.cwd(), reject: false, timeout: 5000 },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.profile, "platform-readiness");
  assert.deepEqual(body.visionLock, HARNESS_VISION_LOCK);
  assert.deepEqual(body.controlPlane, expectedControlPlane());
  assert.deepEqual(body.goldenPath, {
    required: true,
    ok: false,
    capabilities: onlineSandboxGoldenPathCapabilities(),
    missingCapabilities: ["profile-readiness"],
  });
  assert.ok(body.missing.includes("sandboxExecutor"));
  assert.ok(body.missing.includes("tenantAuth"));
  assert.ok(body.missing.includes("model"));
  assert.ok(body.missing.includes("controlPlanePullRequest"));
  assert.ok(body.missing.includes("controlPlaneGitTransport"));
  assert.ok(body.missing.includes("controlPlaneAgentIdentity"));
  assert.ok(body.missing.includes("brainSignalIngest"));
  assert.ok(body.missing.includes("coderExecutor"));
  assert.ok(body.missing.includes("runWorkspaceIsolation"));
  assert.deepEqual(body.checks.runWorkspaceIsolation, {
    required: true,
    ok: false,
    mode: "project",
  });
  assert.ok(body.recommendedFlags.includes("--executor coder"));
  assert.ok(body.recommendedFlags.includes("--executor-worktree-cwd <path-template>"));
  assert.ok(body.recommendedFlags.includes("--tenant-control-plane-token-env <tenant=env>"));
});

test("loom harness doctor accepts a complete agent-git-service platform readiness configuration", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-platform-ok");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "doctor",
      "--workspace-root",
      workspaceRoot,
      "--profile",
      "platform-readiness",
      "--control-plane-provider",
      "agent-git-service",
      "--control-plane-url",
      "https://git.example/api/v3",
      "--executor",
      "coder",
      "--executor-workspace",
      "alice-dev",
      "--executor-worktree-cwd",
      "/home/dev/worktrees/{tenant}/{project}/{runId}",
      "--model-base-url",
      "https://model.example",
      "--model-key-env",
      "LOOM_TEST_MODEL_KEY",
      "--tenant-key",
      "alice=admin-key:ops:admin",
      "--tenant-key",
      "alice=dev-key:eno:developer",
      "--tenant-key",
      "alice=viewer-key:auditor:viewer",
      "--allow-tool",
      "git.pr",
      "--control-plane-pr",
      "--control-plane-merge",
      "--control-plane-comment-sync",
      "--control-plane-webhook-secret-env",
      "LOOM_TEST_WEBHOOK_SECRET",
      "--tenant-control-plane-token-env",
      "alice=LOOM_TEST_AGENT_GIT_SERVICE_TOKEN",
      "--ingest-brain",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOOM_TEST_MODEL_KEY: "model-key",
        LOOM_TEST_WEBHOOK_SECRET: "webhook-secret",
        LOOM_TEST_AGENT_GIT_SERVICE_TOKEN: "agent-git-service-token",
      },
      reject: false,
      timeout: 5000,
    },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.includes("agent-git-service-token"), false);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.profile, "platform-readiness");
  assert.deepEqual(body.visionLock, HARNESS_VISION_LOCK);
  assert.deepEqual(body.controlPlane, expectedControlPlane("agent-git-service"));
  assert.deepEqual(body.goldenPath, {
    required: true,
    ok: true,
    capabilities: onlineSandboxGoldenPathCapabilities(),
    missingCapabilities: [],
  });
  assert.deepEqual(body.missing, []);
  assert.equal(body.checks.coderExecutor.ok, true);
  assert.deepEqual(body.checks.runWorkspaceIsolation, {
    required: true,
    ok: true,
    mode: "run",
  });
  assert.deepEqual(body.checks.controlPlaneWorkspaceBranchLease, {
    required: true,
    ok: true,
    provider: "agent-git-service",
    runWorkspaceIsolation: "run",
    branchDerivation: "run-suffixed",
    activeRunLeaseEvidence: true,
  });
  assert.deepEqual(body.checks.runCreateIdempotency, {
    required: true,
    ok: true,
    clientRequestId: true,
    sharedRunStore: true,
    crossServerReplay: true,
    simultaneousCreateReplay: true,
    conflictOnRequestMismatch: true,
  });
  assert.equal(body.checks.controlPlaneGitTransport.sampleRepo, "team/smoke");
  assert.equal(body.checks.controlPlaneGitTransport.sampleRemoteUrl, "https://git.example/team/smoke.git");
  assert.equal(body.checks.controlPlaneEnvValidation.tokenMode, "tenant-scoped");
  assert.deepEqual(body.checks.controlPlaneEnvValidation.tenantTokenEnvNames, ["LOOM_TEST_AGENT_GIT_SERVICE_TOKEN"]);
  assert.equal(body.checks.controlPlaneAgentIdentity.mode, "tenant-scoped");
  assert.deepEqual(body.recommendedFlags, []);
});

test("loom harness doctor accepts tenant API key env names without leaking token values", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-tenant-key-env-ok");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "doctor",
      "--workspace-root",
      workspaceRoot,
      "--profile",
      "platform-readiness",
      "--executor",
      "coder",
      "--executor-workspace",
      "alice-dev",
      "--executor-worktree-cwd",
      "/home/dev/worktrees/{tenant}/{project}/{runId}",
      "--model-base-url",
      "https://model.example",
      "--model-key-env",
      "LOOM_TEST_MODEL_KEY",
      "--tenant-key-env",
      "alice=LOOM_TEST_ADMIN_TENANT_KEY:ops:admin",
      "--tenant-key-env",
      "alice=LOOM_TEST_DEV_TENANT_KEY:eno:developer",
      "--tenant-key-env",
      "alice=LOOM_TEST_VIEWER_TENANT_KEY:auditor:viewer",
      "--allow-tool",
      "git.pr",
      "--control-plane-pr",
      "--control-plane-merge",
      "--control-plane-comment-sync",
      "--control-plane-webhook-secret-env",
      "LOOM_TEST_WEBHOOK_SECRET",
      "--tenant-control-plane-token-env",
      "alice=LOOM_TEST_GITEA_TOKEN",
      "--ingest-brain",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOOM_TEST_MODEL_KEY: "model-key",
        LOOM_TEST_ADMIN_TENANT_KEY: "admin-env-token",
        LOOM_TEST_DEV_TENANT_KEY: "dev-env-token",
        LOOM_TEST_VIEWER_TENANT_KEY: "viewer-env-token",
        LOOM_TEST_WEBHOOK_SECRET: "webhook-secret",
        LOOM_TEST_GITEA_TOKEN: "gitea-token",
      },
      reject: false,
      timeout: 5000,
    },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.includes("admin-env-token"), false);
  assert.equal(result.stdout.includes("dev-env-token"), false);
  assert.equal(result.stdout.includes("viewer-env-token"), false);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.deepEqual(body.checks.tenantAuth.roles, {
    admin: true,
    developer: true,
    viewer: true,
  });
  assert.deepEqual(body.checks.tenantAuth.missingRoles, []);
});

test("loom harness doctor gates agent-git-service cutover on project agent provisioning", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-agent-git-service-project-agent");
  const secretRoot = await tempDir("loom-cli-doctor-agent-git-service-secrets");
  await writeProjectMetadata(workspaceRoot, "alice", "proj-a");

  const args = [
    "tsx",
    "src/index.ts",
    "harness",
    "doctor",
    "--workspace-root",
    workspaceRoot,
    "--profile",
    "platform-readiness",
    "--control-plane-provider",
    "agent-git-service",
    "--control-plane-url",
    "https://git.example/api/v3",
    "--executor",
    "coder",
    "--executor-workspace",
    "alice-dev",
    "--executor-worktree-cwd",
    "/home/dev/worktrees/{tenant}/{project}/{runId}",
    "--model-base-url",
    "https://model.example",
    "--model-key-env",
    "LOOM_TEST_MODEL_KEY",
    "--tenant-key",
    "alice=admin-key:ops:admin",
    "--tenant-key",
    "alice=dev-key:eno:developer",
    "--tenant-key",
    "alice=viewer-key:auditor:viewer",
    "--allow-tool",
    "git.pr",
    "--control-plane-pr",
    "--control-plane-merge",
    "--control-plane-comment-sync",
    "--control-plane-webhook-secret-env",
    "LOOM_TEST_WEBHOOK_SECRET",
    "--tenant-control-plane-token-env",
    "alice=LOOM_TEST_AGENT_GIT_SERVICE_TOKEN",
    "--agent-git-service-token-secret-root",
    secretRoot,
    "--ingest-brain",
  ];
  const env = {
    ...process.env,
    LOOM_TEST_MODEL_KEY: "model-key",
    LOOM_TEST_WEBHOOK_SECRET: "webhook-secret",
    LOOM_TEST_AGENT_GIT_SERVICE_TOKEN: "tenant-control-plane-token",
  };

  const missingResult = await execa("npx", args, { cwd: process.cwd(), env, reject: false, timeout: 5000 });
  assert.equal(missingResult.exitCode, 1);
  assert.equal(missingResult.stdout.includes("tenant-control-plane-token"), false);
  const missingBody = JSON.parse(missingResult.stdout);
  assert.equal(missingBody.ok, false);
  assert.deepEqual(missingBody.missing, ["agentGitServiceProjectAgents"]);
  assert.deepEqual(missingBody.checks.agentGitServiceProjectAgents, {
    required: true,
    ok: false,
    provider: "agent-git-service",
    tenantCount: 1,
    projectCount: 1,
    provisionedProjectCount: 0,
    secretRootConfigured: true,
    secretStoredProjectCount: 0,
    missingProjects: ["alice/proj-a"],
    missingSecretProjects: [],
  });

  await mkdir(join(workspaceRoot, "alice", "proj-a", ".loom", "control-plane", "agent-git-service"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "alice", "proj-a", ".loom", "control-plane", "agent-git-service", "provisioning.json"),
    JSON.stringify({
      schemaVersion: 1,
      provider: "agent-git-service",
      tenant: "alice",
      project: "proj-a",
      baseUrl: "https://git.example/api/v3",
      repo: "team/proj-a",
      agentLogin: "loom-agent-1",
      agentRepoFullName: "agents/loom-agent-1",
      permission: "write",
      grantStatus: "granted",
      tokenEnvName: "LOOM_ALICE_PROJ_A_AGENT_TOKEN",
      tokenMaterial: "returned-only",
      provisionedAt: "2026-06-30T00:00:00.000Z",
    }, null, 2) + "\n",
    "utf8",
  );
  await mkdir(join(secretRoot, "alice", "proj-a"), { recursive: true });
  await writeFile(join(secretRoot, "alice", "proj-a", "LOOM_ALICE_PROJ_A_AGENT_TOKEN"), "project-agent-token\n", "utf8");
  await chmod(join(secretRoot, "alice", "proj-a", "LOOM_ALICE_PROJ_A_AGENT_TOKEN"), 0o600);

  const readyResult = await execa("npx", args, { cwd: process.cwd(), env, reject: false, timeout: 5000 });
  assert.equal(readyResult.exitCode, 0, readyResult.stderr);
  assert.equal(readyResult.stdout.includes("project-agent-token"), false);
  const readyBody = JSON.parse(readyResult.stdout);
  assert.equal(readyBody.ok, true);
  assert.deepEqual(readyBody.missing, []);
  assert.deepEqual(readyBody.checks.agentGitServiceProjectAgents, {
    required: true,
    ok: true,
    provider: "agent-git-service",
    tenantCount: 1,
    projectCount: 1,
    provisionedProjectCount: 1,
    secretRootConfigured: true,
    secretStoredProjectCount: 1,
    missingProjects: [],
    missingSecretProjects: [],
  });
});

test("loom harness doctor uses agent-git-service default URL and token env aliases", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-agent-git-service-default-envs");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "doctor",
      "--workspace-root",
      workspaceRoot,
      "--control-plane-provider",
      "agent-git-service",
      "--control-plane-pr",
      "--control-plane-comment-sync",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOOM_AGENT_GIT_SERVICE_URL: "https://ags.example/api/v3",
        LOOM_AGENT_GIT_SERVICE_TOKEN: "ags-token",
      },
      reject: false,
      timeout: 5000,
    },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes("ags-token"), false);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.deepEqual(body.missing, []);
  assert.equal(body.controlPlane.provider, "agent-git-service");
  assert.equal(body.checks.controlPlaneEnvValidation.ok, true);
  assert.deepEqual(body.checks.controlPlaneEnvValidation.enabledFlags, [
    "--control-plane-pr",
    "--control-plane-comment-sync",
  ]);
  assert.deepEqual(body.checks.controlPlaneEnvValidation.tokenEnv, "LOOM_AGENT_GIT_SERVICE_TOKEN");
  assert.equal(body.checks.controlPlaneGitTransport.provider, "agent-git-service");
  assert.equal(body.checks.controlPlaneGitTransport.sampleRepo, "team/smoke");
  assert.equal(body.checks.controlPlaneGitTransport.sampleRemoteUrl, "https://ags.example/team/smoke.git");
});

test("loom harness doctor accepts tenant-scoped platform model keys", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-platform-tenant-model-key-ok");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "doctor",
      "--workspace-root",
      workspaceRoot,
      "--profile",
      "platform-readiness",
      "--executor",
      "coder",
      "--executor-workspace",
      "alice-dev",
      "--executor-worktree-cwd",
      "/home/dev/worktrees/{tenant}/{project}/{runId}",
      "--model-base-url",
      "https://model.example",
      "--model-key-env",
      "LOOM_TEST_MISSING_GLOBAL_MODEL_KEY",
      "--tenant-model-key",
      "alice=LOOM_TEST_ALICE_MODEL_KEY",
      "--tenant-key",
      "alice=admin-key:ops:admin",
      "--tenant-key",
      "alice=dev-key:eno:developer",
      "--tenant-key",
      "alice=viewer-key:auditor:viewer",
      "--allow-tool",
      "git.pr",
      "--gitea-pr",
      "--gitea-merge",
      "--gitea-comment-sync",
      "--gitea-webhook-secret-env",
      "LOOM_TEST_WEBHOOK_SECRET",
      "--tenant-gitea-token-env",
      "alice=LOOM_TEST_GITEA_TOKEN",
      "--ingest-brain",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOOM_TEST_MISSING_GLOBAL_MODEL_KEY: "",
        LOOM_TEST_ALICE_MODEL_KEY: "alice-model-key",
        LOOM_TEST_WEBHOOK_SECRET: "webhook-secret",
        LOOM_TEST_GITEA_TOKEN: "gitea-token",
      },
      reject: false,
      timeout: 5000,
    },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.includes("alice-model-key"), false);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.deepEqual(body.missing, []);
  assert.deepEqual(body.checks.model, {
    required: true,
    ok: true,
    baseUrlConfigured: true,
    keyEnv: "LOOM_TEST_MISSING_GLOBAL_MODEL_KEY",
    keySet: false,
    keyConfigured: true,
    keyMode: "tenant-scoped",
    tenantCount: 1,
    missingTenantCount: 0,
  });
  assert.deepEqual(body.recommendedFlags, []);
});

test("loom harness doctor accepts policy API-key scoped platform model keys", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-platform-policy-key-model-ok");
  await mkdir(join(workspaceRoot, "alice", ".loom"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "alice", ".loom", "policy.json"),
    JSON.stringify({
      schemaVersion: 1,
      apiKeys: [
        { token: "policy-admin-key", actor: "ops", role: "admin", modelKeyEnv: "LOOM_TEST_OPS_MODEL_KEY" },
        { token: "policy-dev-key", actor: "eno", role: "developer", modelKeyEnv: "LOOM_TEST_DEV_MODEL_KEY" },
        { token: "policy-viewer-key", actor: "auditor", role: "viewer", modelKeyEnv: "LOOM_TEST_VIEWER_MODEL_KEY" },
      ],
    }, null, 2) + "\n",
    "utf8",
  );

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "doctor",
      "--workspace-root",
      workspaceRoot,
      "--profile",
      "platform-readiness",
      "--executor",
      "coder",
      "--executor-workspace",
      "alice-dev",
      "--executor-worktree-cwd",
      "/home/dev/worktrees/{tenant}/{project}/{runId}",
      "--model-base-url",
      "https://model.example",
      "--model-key-env",
      "LOOM_TEST_MISSING_GLOBAL_MODEL_KEY",
      "--allow-tool",
      "git.pr",
      "--gitea-pr",
      "--gitea-merge",
      "--gitea-comment-sync",
      "--gitea-webhook-secret-env",
      "LOOM_TEST_WEBHOOK_SECRET",
      "--tenant-gitea-token-env",
      "alice=LOOM_TEST_GITEA_TOKEN",
      "--ingest-brain",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOOM_TEST_MISSING_GLOBAL_MODEL_KEY: "",
        LOOM_TEST_OPS_MODEL_KEY: "ops-model-key",
        LOOM_TEST_DEV_MODEL_KEY: "dev-model-key",
        LOOM_TEST_VIEWER_MODEL_KEY: "viewer-model-key",
        LOOM_TEST_WEBHOOK_SECRET: "webhook-secret",
        LOOM_TEST_GITEA_TOKEN: "gitea-token",
      },
      reject: false,
      timeout: 5000,
    },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.includes("ops-model-key"), false);
  assert.equal(result.stdout.includes("dev-model-key"), false);
  assert.equal(result.stdout.includes("viewer-model-key"), false);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.deepEqual(body.missing, []);
  assert.deepEqual(body.checks.model, {
    required: true,
    ok: true,
    baseUrlConfigured: true,
    keyEnv: "LOOM_TEST_MISSING_GLOBAL_MODEL_KEY",
    keySet: false,
    keyConfigured: true,
    keyMode: "policy-key-scoped",
    tenantCount: 1,
    missingTenantCount: 0,
  });
  assert.deepEqual(body.recommendedFlags, []);
});

test("loom harness doctor counts policy-backed tenant roles", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-policy-auth");
  await mkdir(join(workspaceRoot, "alice", ".loom"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "alice", ".loom", "policy.json"),
    JSON.stringify({
      schemaVersion: 1,
      apiKeys: [
        { token: "policy-admin-secret", actor: "ops", role: "admin" },
        { token: "policy-dev-secret", actor: "eno", role: "developer" },
        { token: "policy-viewer-secret", actor: "auditor", role: "viewer" },
      ],
    }),
    "utf8",
  );

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "doctor",
      "--workspace-root",
      workspaceRoot,
      "--profile",
      "online-sandbox",
      "--executor",
      "docker",
      "--executor-image",
      "loom-workspace:dev",
      "--executor-home-root",
      join(workspaceRoot, ".homes"),
    ],
    { cwd: process.cwd(), reject: false, timeout: 5000 },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes("policy-admin-secret"), false);
  assert.equal(result.stdout.includes("policy-dev-secret"), false);
  assert.equal(result.stdout.includes("policy-viewer-secret"), false);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.deepEqual(body.missing, []);
  assert.deepEqual(body.checks.tenantAuth, {
    required: true,
    ok: true,
    roles: { admin: true, developer: true, viewer: true },
    missingRoles: [],
    policyKeyCount: 3,
  });
});

test("loom harness doctor reports docker executor configuration gaps before serving", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-docker-executor-config");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "doctor",
      "--workspace-root",
      workspaceRoot,
      "--profile",
      "online-sandbox",
      "--executor",
      "docker",
      "--executor-home-root",
      join(workspaceRoot, ".homes"),
      "--tenant-key",
      "alice=admin-key:ops:admin",
      "--tenant-key",
      "alice=dev-key:eno:developer",
      "--tenant-key",
      "alice=viewer-key:auditor:viewer",
    ],
    { cwd: process.cwd(), reject: false, timeout: 5000 },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.ok(body.missing.includes("executorConfiguration"));
  assert.deepEqual(body.checks.executorConfiguration, {
    required: true,
    ok: false,
    executorKind: "docker",
    imageConfigured: false,
    missingFlags: ["--executor-image"],
  });
  assert.ok(body.recommendedFlags.includes("--executor-image <image>"));
});

test("loom harness doctor reports invalid serve numeric flags before serving", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-invalid-serve-flags");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "doctor",
      "--workspace-root",
      workspaceRoot,
      "--port",
      "70000",
      "--workspace-command-timeout-ms",
      "0",
      "--state-probe-timeout-ms",
      "0",
      "--state-probe-max-staleness-ms",
      "300001",
      "--executor",
      "docker",
      "--executor-image",
      "loom-workspace:dev",
      "--executor-cpus",
      "0",
      "--executor-pids-limit",
      "0",
    ],
    { cwd: process.cwd(), reject: false, timeout: 5000 },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.ok(body.missing.includes("serveFlagValidation"));
  assert.deepEqual(body.checks.serveFlagValidation, {
    required: true,
    ok: false,
    invalidFlags: [
      { flag: "--port", message: "--port must be an integer between 0 and 65535" },
      { flag: "--workspace-command-timeout-ms", message: "--workspace-command-timeout-ms must be a positive integer." },
      { flag: "--state-probe-timeout-ms", message: "--state-probe-timeout-ms must be an integer between 1 and 300000." },
      { flag: "--state-probe-max-staleness-ms", message: "--state-probe-max-staleness-ms must be an integer between 1 and 300000." },
      { flag: "--executor-cpus", message: "--executor-cpus must be a positive number." },
      { flag: "--executor-pids-limit", message: "--executor-pids-limit must be a positive integer." },
    ],
  });
});

test("loom harness doctor validates OIDC SSO configuration without contacting the provider", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-invalid-oidc");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "doctor",
      "--workspace-root",
      workspaceRoot,
      "--executor",
      "docker",
      "--executor-image",
      "loom-workspace:dev",
      "--oidc-issuer",
      "http://identity.example.test",
      "--oidc-jwks-url",
      "https://user:secret@identity.example.test/jwks",
      "--oidc-clock-tolerance-seconds",
      "301",
      "--oidc-request-timeout-ms",
      "99",
    ],
    { cwd: process.cwd(), reject: false, timeout: 5000 },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.deepEqual(body.checks.serveFlagValidation.invalidFlags, [
    { flag: "--oidc-issuer", message: "--oidc-issuer must be an absolute HTTPS URL without credentials or a fragment." },
    { flag: "--oidc-audience", message: "--oidc-audience is required when OIDC is configured." },
    { flag: "--oidc-jwks-url", message: "--oidc-jwks-url must be an absolute HTTPS URL without credentials or a fragment." },
    { flag: "--oidc-clock-tolerance-seconds", message: "--oidc-clock-tolerance-seconds must be an integer between 0 and 300." },
    { flag: "--oidc-request-timeout-ms", message: "--oidc-request-timeout-ms must be an integer between 100 and 30000." },
  ]);
  assert.equal(body.checks.identityProvider.configured, false);
  assert.equal(JSON.stringify(body).includes("user:secret"), false);
});

test("loom harness doctor accepts OIDC as the online sandbox tenant identity source", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-oidc-ready");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "doctor",
      "--workspace-root",
      workspaceRoot,
      "--profile",
      "online-sandbox",
      "--executor",
      "docker",
      "--executor-image",
      "loom-workspace:dev",
      "--executor-home-root",
      join(workspaceRoot, ".homes"),
      "--oidc-issuer",
      "https://identity.example.test",
      "--oidc-audience",
      "loom-harness",
    ],
    { cwd: process.cwd(), reject: false, timeout: 5000 },
  );

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.checks.identityProvider.configured, true);
  assert.equal(body.checks.identityProvider.mode, "discovery");
  assert.equal(body.checks.tenantAuth.ok, true);
  assert.equal(body.checks.tenantAuth.oidc, true);
  assert.deepEqual(body.checks.tenantAuth.missingRoles, []);
});

test("loom harness doctor reports missing distributed state envs without leaking values", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-state-backend-env");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "doctor",
      "--workspace-root",
      workspaceRoot,
      "--state-backend",
      "postgres-redis",
      "--state-postgres-url-env",
      "LOOM_TEST_MISSING_POSTGRES_URL",
      "--state-redis-url-env",
      "LOOM_TEST_MISSING_REDIS_URL",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOOM_TEST_MISSING_POSTGRES_URL: "",
        LOOM_TEST_MISSING_REDIS_URL: "",
      },
      reject: false,
      timeout: 5000,
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.ok(body.missing.includes("stateBackend"));
  assert.deepEqual(body.checks.stateBackend, {
    required: true,
    ok: false,
    kind: "postgres-redis",
    distributed: true,
    postgresUrlEnv: "LOOM_TEST_MISSING_POSTGRES_URL",
    postgresUrlSet: false,
    postgresSchema: "loom",
    redisUrlEnv: "LOOM_TEST_MISSING_REDIS_URL",
    redisUrlSet: false,
    redisPrefix: "loom",
    missingEnvNames: ["LOOM_TEST_MISSING_POSTGRES_URL", "LOOM_TEST_MISSING_REDIS_URL"],
  });
  assert.ok(body.recommendedFlags.includes("--state-postgres-url-env <env>"));
  assert.ok(body.recommendedFlags.includes("--state-redis-url-env <env>"));
});

test("loom harness doctor reports control-plane env gaps before serving", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-control-plane-env");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "doctor",
      "--workspace-root",
      workspaceRoot,
      "--gitea-pr",
      "--gitea-comment",
      "--gitea-comment-sync",
      "--gitea-merge",
      "--gitea-webhook-secret-env",
      "LOOM_TEST_MISSING_WEBHOOK_SECRET",
      "--gitea-token-env",
      "LOOM_TEST_MISSING_GITEA_TOKEN",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOOM_TEST_MISSING_GITEA_TOKEN: "",
        LOOM_TEST_MISSING_WEBHOOK_SECRET: "",
      },
      reject: false,
      timeout: 5000,
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.ok(body.missing.includes("controlPlaneEnvValidation"));
  assert.deepEqual(body.checks.controlPlaneEnvValidation, {
    required: true,
    ok: false,
    enabledFlags: ["--gitea-pr", "--gitea-comment", "--gitea-comment-sync", "--gitea-merge", "--gitea-webhook-secret-env"],
    missingEnvNames: ["LOOM_TEST_MISSING_GITEA_TOKEN", "LOOM_TEST_MISSING_WEBHOOK_SECRET"],
  });
  assert.ok(body.recommendedFlags.includes("--control-plane-token-env <env>"));
  assert.ok(body.recommendedFlags.includes("--control-plane-webhook-secret-env <env>"));
});

test("loom harness doctor reports policy-backed local executor safety gaps before serving", async () => {
  const workspaceRoot = await tempDir("loom-cli-doctor-policy-auth-local-executor");
  await mkdir(join(workspaceRoot, "alice", ".loom"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "alice", ".loom", "policy.json"),
    JSON.stringify({
      schemaVersion: 1,
      apiKeys: [{ token: "policy-dev-secret", actor: "eno", role: "developer" }],
    }),
    "utf8",
  );

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "doctor",
      "--workspace-root",
      workspaceRoot,
    ],
    { cwd: process.cwd(), reject: false, timeout: 5000 },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /policy-dev-secret/);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.ok(body.missing.includes("localExecutorSafety"));
  assert.deepEqual(body.checks.localExecutorSafety, {
    required: true,
    ok: false,
    executorKind: "local",
    allowUnsafeLocalExecutor: false,
    reasons: ["tenant authentication is configured"],
  });
  assert.ok(body.recommendedFlags.includes("--executor docker|coder"));
});

test("loom harness smoke verifies an authenticated HTTP service", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-http");
  const reportPath = join(workspaceRoot, "smoke-report.json");
  const executorHomeRoot = join(workspaceRoot, ".homes");
  const server = createHarnessHttpServer({
    workspaceRoot,
    profile: "online-sandbox",
    executorKind: "docker",
    executorHomeRoot,
    allowUnsafeLocalExecutor: true,
    allowedTools: onlineSandboxTools(),
    tenantApiKeys: {
      alice: [
        { token: "admin-key", actor: "ops", role: "admin" },
        { token: "dev-key", actor: "eno", role: "developer" },
        { token: "viewer-key", actor: "auditor", role: "viewer" },
      ],
      bob: [{ token: "bob-key", actor: "bob", role: "developer" }],
    },
    createExecutor: (cwd, context) => {
      const executor = createLocalExecutor({ cwd });
      return {
        ...executor,
        describeWorkspace(): Record<string, string> {
          return {
            kind: "docker",
            cwd,
            containerCwd: "/workspace",
            home: join(executorHomeRoot, context.tenant),
            containerHome: "/home/dev",
          };
        },
      };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-vas",
        "--template",
        "vas-lite",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--viewer-token-env",
        "LOOM_TEST_VIEWER_TOKEN",
        "--admin-token-env",
        "LOOM_TEST_ADMIN_TOKEN",
        "--isolation-tenant",
        "bob",
        "--profile",
        "online-sandbox",
        "--report",
        reportPath,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_TENANT_TOKEN: "dev-key", LOOM_TEST_VIEWER_TOKEN: "viewer-key", LOOM_TEST_ADMIN_TOKEN: "admin-key" },
        reject: false,
        timeout: ONLINE_SANDBOX_PROFILE_SMOKE_TIMEOUT_MS,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), body);
    assert.equal(body.tenant, "alice");
    assert.equal(body.project, "smoke-vas");
    assert.equal(body.profile, "online-sandbox");
    assert.equal(body.serverProfile, "online-sandbox");
    assert.equal(body.onlineSandboxGoldenPathChecked, true);
    assert.equal(body.onlineSandboxGoldenPathProfile, "online-sandbox");
    assert.ok(body.onlineSandboxGoldenPathCapabilities.includes("multi-user-isolation"));
    assert.ok(body.onlineSandboxGoldenPathCapabilities.includes("auditable-harness-loop"));
    assert.ok(body.onlineSandboxGoldenPathCapabilities.includes("vas-lite-learning"));
    assert.ok(body.onlineSandboxGoldenPathCapabilities.includes("handoff-followup"));
    assert.equal(body.serverProfileChecked, true);
    assert.deepEqual(body.serverAllowedTools, onlineSandboxTools());
    assert.equal(body.serverAllowedToolsChecked, true);
    assert.equal(body.serverReadinessChecked, true);
    assert.equal(body.serverReadinessOk, true);
    assert.deepEqual(body.serverReadinessMissing, []);
    assert.equal(body.serverGoldenPathChecked, true);
    assert.equal(body.serverGoldenPathOk, true);
    assert.deepEqual(body.serverGoldenPathMissingCapabilities, []);
    assert.ok(body.serverGoldenPathCapabilities.includes("multi-user-isolation"));
    assert.ok(body.serverGoldenPathCapabilities.includes("auditable-harness-loop"));
    assert.equal(body.serverControlPlaneChecked, true);
    assert.equal(body.serverControlPlaneProvider, "gitea-forgejo");
    assert.deepEqual(body.serverControlPlaneBoundary, [...CONTROL_PLANE_PROVIDER_BOUNDARY]);
    assert.equal(body.serverControlPlaneApiBasePath, "/api/v1");
    assert.deepEqual(body.serverControlPlaneDiscoveryEndpoints, ["/api/v1/version"]);
    assert.ok(body.serverControlPlaneNativeCapabilities.includes("git-smart-http"));
    assert.deepEqual(body.serverControlPlaneAdoptionStages, ["default-control-plane"]);
    assert.deepEqual(body.serverControlPlaneGatedAdoptionStages, []);
    assert.equal(body.serverControlPlaneTenantDefaultCutoverGated, false);
    assert.equal(body.visionLockChecked, true);
    assert.equal(body.visionLockTarget, HARNESS_VISION_LOCK.target);
    assert.equal(body.visionLockMvpIsScopeReduction, false);
    assert.ok(body.visionLockCapabilities.includes("multi-user-tenants"));
    assert.ok(body.visionLockCapabilities.includes("event-sourced-harness-loop"));
    assert.ok(body.visionLockCapabilities.includes("brain-skill-evolution"));
    assert.deepEqual(body.tenantAllowedTools, onlineSandboxTools());
    assert.equal(body.tenantAllowedToolsChecked, true);
    assert.equal(body.tenantReadinessChecked, true);
    assert.equal(body.tenantReadinessProfile, "online-sandbox");
    assert.equal(body.tenantReadinessOk, true);
    assert.deepEqual(body.tenantReadinessMissing, []);
    assert.equal(body.tenantGoldenPathChecked, true);
    assert.equal(body.tenantGoldenPathOk, true);
    assert.deepEqual(body.tenantGoldenPathMissingCapabilities, []);
    assert.ok(body.tenantGoldenPathCapabilities.includes("multi-user-isolation"));
    assert.ok(body.tenantGoldenPathCapabilities.includes("auditable-harness-loop"));
    assert.equal(body.tenantControlPlaneChecked, true);
    assert.equal(body.tenantControlPlaneProvider, "gitea-forgejo");
    assert.deepEqual(body.tenantControlPlaneBoundary, [...CONTROL_PLANE_PROVIDER_BOUNDARY]);
    assert.deepEqual(body.tenantControlPlaneAdoptionStages, ["default-control-plane"]);
    assert.deepEqual(body.tenantControlPlaneGatedAdoptionStages, []);
    assert.equal(body.tenantControlPlaneTenantDefaultCutoverGated, false);
    assert.equal(body.tenantVisionLockChecked, true);
    assert.equal(body.tenantVisionLockTarget, HARNESS_VISION_LOCK.target);
    assert.equal(body.tenantVisionLockMvpIsScopeReduction, false);
    assert.ok(body.tenantVisionLockCapabilities.includes("multi-user-tenants"));
    assert.ok(body.tenantVisionLockCapabilities.includes("event-sourced-harness-loop"));
    assert.ok(body.tenantVisionLockCapabilities.includes("brain-skill-evolution"));
    assert.equal(body.projectContractChecked, true);
    assert.equal(body.projectContractOk, true);
    assert.deepEqual(body.projectContractMissing, []);
    assert.equal(body.projectGoldenDefaultsChecked, true);
    assert.deepEqual(body.projectDefaultSkills, ["vas-lite", "coding"]);
    assert.deepEqual(body.projectRunPolicy, {
      preset: "vas-lite-review",
      presetInput: { caseId: "bootstrap" },
      reviewRequired: true,
    });
    assert.equal(body.projectContractObjective, HARNESS_VISION_LOCK.target);
    assert.equal(body.status, "passed");
    assert.equal(body.projectCreated, true);
    assert.equal(body.workspaceArtifactPath, "loom-smoke.txt");
    assert.equal(body.workspaceArtifactRead, true);
    assert.equal(body.workspaceArtifactContent, "loom smoke ok\n");
    assert.equal(body.workspaceContextRead, true);
    assert.equal(body.workspaceContextKind, "docker");
    assert.equal(body.workspaceCommandRun, true);
    assert.equal(body.workspaceCommand, "printf loom-command-ok");
    assert.equal(body.workspaceCommandStdout, "loom-command-ok");
    assert.equal(body.workspaceCommandExitCode, 0);
    assert.equal(body.workspaceSessionRun, true);
    assert.match(body.workspaceSessionId, /^[0-9a-f-]{36}$/);
    assert.equal(body.workspaceSessionCommand, "sh");
    assert.equal(body.workspaceSessionInputAccepted, true);
    assert.equal(body.workspaceSessionOutput, "loom-session-ok");
    assert.equal(body.workspaceSessionExitCode, 0);
    assert.equal(body.vasReadinessChecked, true);
    assert.equal(body.vasTemplate, "vas-lite");
    assert.equal(body.vasBootstrapCaseId, "bootstrap");
    assert.equal(body.vasBootstrapCaseFound, true);
    assert.equal(body.vasBootstrapCaseStatus, "needs_review");
    assert.equal(body.vasReviewQueueRead, true);
    assert.equal(body.vasReviewQueueCaseCount, 1);
    assert.equal(body.vasReviewPackageRead, true);
    assert.equal(body.vasReviewPackageCaseId, "bootstrap");
    assert.equal(body.vasReviewRunExecuted, true);
    assert.match(body.vasReviewRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.equal(body.vasReviewRunStatus, "passed");
    assert.equal(body.vasReviewRunPreset, "vas-lite-review");
    assert.equal(body.vasReviewRunCaseId, "bootstrap");
    assert.equal(body.vasReviewArtifactsRead, true);
    assert.equal(body.vasReviewReportPath, "cases/bootstrap/reports/latest.md");
    assert.equal(body.vasReviewContextPath, "cases/bootstrap/reports/context.json");
    assert.equal(body.vasReviewContextCaseId, "bootstrap");
    assert.equal(body.vasReviewGateChecked, true);
    assert.equal(body.vasReviewGateCaseId, "loom-smoke-gate");
    assert.match(body.vasReviewGateRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.equal(body.vasReviewGateRunStatus, "review_required");
    assert.equal(body.vasReviewGateDecision, "approved");
    assert.equal(body.vasReviewGateCaseStatus, "reviewed");
    assert.equal(body.vasReviewLearningRecorded, true);
    assert.equal(body.vasReviewLearningText, "Loom smoke review gates preserve approved learning updates");
    assert.equal(body.vasReviewLearnedPatternsRead, true);
    assert.equal(body.onlineSurfacesChecked, true);
    assert.equal(body.dashboardHtmlRead, true);
    assert.equal(body.dashboardReadinessLabelsChecked, true);
    assert.equal(body.dashboardTenantReadinessLabel, "tenant profile readiness");
    assert.equal(body.dashboardGlobalReadinessLabel, "global profile readiness");
    assert.equal(body.dashboardBrainFeedChecked, true);
    assert.equal(body.dashboardTokenScrubChecked, true);
    assert.equal(body.workbenchHtmlRead, true);
    assert.equal(body.workbenchBrainFeedChecked, true);
    assert.equal(body.workbenchTokenScrubChecked, true);
    assert.equal(body.projectPresenceChecked, true);
    assert.equal(body.projectPresenceCollaboratorCount, 2);
    assert.equal(body.runPresenceChecked, true);
    assert.equal(body.runPresenceCollaboratorCount, 2);
    assert.equal(body.onlineRunCommentAdded, true);
    assert.equal(body.onlineRunCommentReplayChecked, true);
    assert.equal(body.onlineRunCommentText, "loom smoke online steering is durable");
    assert.equal(body.fileCollabChecked, true);
    assert.equal(body.fileCollabPath, "loom-collab.txt");
    assert.equal(body.fileCollabBaseRead, true);
    assert.equal(body.fileCollabActiveEditorClientId, "loom-smoke-collab-b");
    assert.equal(body.fileCollabActiveEditorLabel, "Loom Smoke Collab B");
    assert.equal(body.fileCollabStaleSaveDenied, true);
    assert.equal(body.fileCollabStaleMoveDenied, true);
    assert.equal(body.fileCollabStaleDeleteDenied, true);
    assert.equal(body.fileCollabReloadedContent, "fresh edit\n");
    assert.equal(body.fileCollabAuditChecked, true);
    assert.equal(body.runFileCollabChecked, true);
    assert.match(body.runFileCollabRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.equal(body.runFileCollabPath, "loom-run-collab.txt");
    assert.equal(body.runFileCollabActiveEditorClientId, "loom-smoke-run-collab-b");
    assert.equal(body.runFileCollabActiveEditorLabel, "Loom Smoke Run Collab B");
    assert.equal(body.runFileCollabStaleSaveDenied, true);
    assert.equal(body.runFileCollabStaleMoveDenied, true);
    assert.equal(body.runFileCollabStaleDeleteDenied, true);
    assert.equal(body.runFileCollabReloadedContent, "run fresh edit\n");
    assert.equal(body.runFileCollabAuditChecked, true);
    assert.equal(body.authRolesChecked, true);
    assert.equal(body.developerAccessActor, "eno");
    assert.equal(body.developerAccessRole, "developer");
    assert.equal(body.viewerAccessActor, "auditor");
    assert.equal(body.viewerAccessRole, "viewer");
    assert.equal(body.viewerTenantReadinessChecked, true);
    assert.equal(body.viewerTenantReadinessProfile, "online-sandbox");
    assert.equal(body.viewerTenantReadinessOk, true);
    assert.deepEqual(body.viewerTenantReadinessMissing, []);
    assert.equal(body.viewerTenantGoldenPathChecked, true);
    assert.equal(body.viewerTenantGoldenPathOk, true);
    assert.deepEqual(body.viewerTenantGoldenPathMissingCapabilities, []);
    assert.ok(body.viewerTenantGoldenPathCapabilities.includes("multi-user-isolation"));
    assert.ok(body.viewerTenantGoldenPathCapabilities.includes("auditable-harness-loop"));
    assert.equal(body.viewerTenantVisionLockChecked, true);
    assert.equal(body.viewerTenantVisionLockTarget, HARNESS_VISION_LOCK.target);
    assert.equal(body.viewerTenantVisionLockMvpIsScopeReduction, false);
    assert.ok(body.viewerTenantVisionLockCapabilities.includes("human-gated-side-effects"));
    assert.equal(body.viewerCreateRunDenied, true);
    assert.equal(body.viewerWorkspaceWriteDenied, true);
    assert.equal(body.viewerRunCommentAdded, true);
    assert.equal(body.viewerRunCommentReplayChecked, true);
    assert.equal(body.gatesChecked, true);
    assert.match(body.gateRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.equal(body.reviewGateChecked, true);
    assert.equal(body.reviewGateRunStatus, "review_required");
    assert.equal(body.reviewGateDecision, "approved");
    assert.equal(body.reviewGateDecidedRole, "developer");
    assert.equal(body.deploymentGateChecked, true);
    assert.equal(body.deploymentGateDeveloperDenied, true);
    assert.equal(body.deploymentGateRunStatus, "deployment_required");
    assert.equal(body.deploymentGateDecision, "approved");
    assert.equal(body.deploymentGateDecidedRole, "admin");
    assert.equal(body.gateRunFinalStatus, "passed");
    assert.equal(body.policyEscalationChecked, true);
    assert.match(body.policyEscalationId, /^[0-9a-f-]{36}$/);
    assert.equal(body.policyEscalationStatus, "approved");
    assert.equal(body.policyEscalationRequestedTool, "shell.exec");
    assert.equal(body.policyEscalationSourceKind, "workspace_pr");
    assert.equal(body.policyEscalationDeveloperDecisionDenied, true);
    assert.equal(body.policyEscalationDecidedRole, "admin");
    assert.equal(body.policyEscalationToolAdded, true);
    assert.equal(body.policyEscalationLimitChanged, true);
    assert.equal(body.policyEscalationAuditChecked, true);
    assert.equal(body.handoffEvidenceChecked, true);
    assert.equal(body.reviewSummaryRead, true);
    assert.equal(body.reviewSummaryRunId, body.runId);
    assert.equal(body.reviewSummaryStatus, "passed");
    assert.equal(body.reviewSummaryTimelineChecked, true);
    assert.equal(body.reviewSummaryContractEvidenceChecked, true);
    assert.equal(body.handoffPackageRead, true);
    assert.equal(body.handoffPackageRunId, body.runId);
    assert.equal(body.handoffPackageReviewSummaryChecked, true);
    assert.equal(body.handoffPackageContractEvidenceChecked, true);
    assert.equal(body.handoffPackageAuditTrailChecked, true);
    assert.equal(body.handoffPackageLinksChecked, true);
    assert.equal(body.handoffFollowupCreated, true);
    assert.match(body.handoffFollowupRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.equal(body.handoffFollowupRunStatus, "passed");
    assert.equal(body.handoffFollowupSourceRunId, body.runId);
    assert.equal(body.handoffFollowupSourceContractEvidenceChecked, true);
    assert.equal(body.handoffFollowupListChecked, true);
    assert.equal(body.handoffFollowupCount, 1);
    assert.equal(body.handoffContractPatchEvidenceChecked, true);
    assert.match(body.handoffContractPatchRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.equal(body.handoffContractPatchReviewSummaryChecked, true);
    assert.equal(body.handoffContractPatchGateTrailChecked, true);
    assert.equal(body.handoffContractPatchReplayChecked, true);
    assert.equal(body.runControlsChecked, true);
    assert.equal(body.pauseResumeChecked, true);
    assert.match(body.pauseResumeRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.equal(body.activeRunLeaseChecked, true);
    assert.equal(body.activeRunLeaseRunId, body.pauseResumeRunId);
    assert.equal(body.activeRunLeaseScope, "project");
    assert.equal(body.activeRunLeaseKey, "alice/smoke-vas");
    assert.equal(body.pauseRequested, true);
    assert.equal(body.pauseRequestRole, "viewer");
    assert.equal(body.pausedRunStatus, "paused");
    assert.equal(body.resumeRequested, true);
    assert.equal(body.resumeRequestRole, "developer");
    assert.equal(body.resumedRunStatus, "passed");
    assert.equal(body.pauseResumeTraceContent, "firstsecond");
    assert.equal(body.cancelChecked, true);
    assert.match(body.cancelRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.equal(body.cancelRunStatus, "cancelled");
    assert.equal(body.cancelReplayChecked, true);
    assert.equal(body.runControlAuditChecked, true);
    assert.equal(body.isolationTenant, "bob");
    assert.equal(body.isolationPassed, true);
    assert.match(body.summaryUrl, /\/tenants\/alice\/runs\/.+\?project=smoke-vas/);
    assert.match(body.eventsUrl, /\/tenants\/alice\/runs\/.+\/events\?project=smoke-vas/);
    assert.match(body.dashboardUrl, /\/\?tenant=alice&project=smoke-vas&runId=/);

    assert.equal(await readFile(join(workspaceRoot, "alice", "smoke-vas", "loom-smoke.txt"), "utf8"), "loom smoke ok\n");
    assert.equal(await readFile(join(workspaceRoot, "alice", "smoke-vas", "loom-collab.txt"), "utf8"), "fresh edit\n");
    assert.match(await readFile(join(workspaceRoot, "alice", "smoke-vas", "cases", "bootstrap", "reports", "latest.md"), "utf8"), /VAS Lite Review/);
    assert.match(await readFile(join(workspaceRoot, "alice", "smoke-vas", "vocabulary", "learned-patterns.md"), "utf8"), /Loom smoke review gates preserve approved learning updates/);
    const project = JSON.parse(await readFile(join(workspaceRoot, "alice", "smoke-vas", ".loom", "project.json"), "utf8"));
    assert.equal(project.template, "vas-lite");
    assert.deepEqual(project.defaultSkills, ["vas-lite", "coding"]);
    assert.deepEqual(project.runPolicy, {
      preset: "vas-lite-review",
      presetInput: { caseId: "bootstrap" },
      reviewRequired: true,
    });
    assert.match(project.contract.objective, /multi-user online sandbox development platform/);
    assert.match(project.contract.objective, /harness loop/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("loom harness smoke verifies run controls through a peer server", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-peer-run-controls");
  const options = {
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    allowedTools: onlineSandboxTools(),
    tenantApiKeys: tenantRoleKeys(),
  };
  const firstServer = createHarnessHttpServer(options);
  const secondServer = createHarnessHttpServer(options);
  await new Promise<void>((resolve) => firstServer.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => secondServer.listen(0, "127.0.0.1", resolve));
  const firstAddress = firstServer.address();
  const secondAddress = secondServer.address();
  assert.equal(typeof firstAddress, "object");
  assert.equal(typeof secondAddress, "object");
  assert.ok(firstAddress);
  assert.ok(secondAddress);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${firstAddress.port}`,
        "--peer-url",
        `http://127.0.0.1:${secondAddress.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-peer-controls",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--viewer-token-env",
        "LOOM_TEST_VIEWER_TOKEN",
        "--check-run-controls",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_TENANT_TOKEN: "dev-key", LOOM_TEST_VIEWER_TOKEN: "viewer-key" },
        reject: false,
        timeout: 45_000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.runControlsChecked, true);
    assert.equal(body.runControlsPeerUrl, `http://127.0.0.1:${secondAddress.port}`);
    assert.equal(body.activeRunLeaseChecked, true);
    assert.equal(body.activeRunLeaseRunId, body.pauseResumeRunId);
    assert.equal(body.activeRunLeaseScope, "project");
    assert.equal(body.activeRunLeaseKey, "alice/smoke-peer-controls");
    assert.equal(body.crossServerActiveRunLeaseChecked, true);
    assert.equal(body.crossServerActiveRunLeaseRunId, body.pauseResumeRunId);
    assert.equal(body.crossServerActiveRunLeaseScope, "project");
    assert.equal(body.crossServerActiveRunLeaseKey, "alice/smoke-peer-controls");
    assert.equal(body.crossServerPauseChecked, true);
    assert.equal(body.crossServerPauseRequested, true);
    assert.equal(body.crossServerPauseRunStatus, "paused");
    assert.equal(body.crossServerCancelChecked, true);
    assert.equal(body.crossServerCancelRequested, true);
    assert.equal(body.crossServerCancelRunStatus, "cancelled");
    assert.equal(body.crossServerIdempotentCreateChecked, true);
    assert.match(body.crossServerIdempotentCreateRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.equal(body.crossServerIdempotentCreateReplayChecked, true);
    assert.equal(body.crossServerIdempotentCreateRunStatus, "cancelled");
  } finally {
    await new Promise<void>((resolve) => firstServer.close(() => resolve()));
    await new Promise<void>((resolve) => secondServer.close(() => resolve()));
  }
});

test("loom harness smoke pause control keeps a durable pause window", async () => {
  const source = await readFile(join(process.cwd(), "src/index.ts"), "utf8");
  assert.match(source, /process\.env\.LOOM_RUN_DIR/);
  assert.match(source, /pause-request\.json/);
  assert.doesNotMatch(source, /setTimeout\(\(\)=>process\.stdout\.write\('slept'\),\d+\)/);
  const pauseTimeout = source.match(/const SMOKE_RUN_CONTROL_PAUSE_TIMEOUT_MS = (\d+)_000;/);
  assert.ok(pauseTimeout);
  assert.ok(Number(pauseTimeout[1]) >= 90);
  assert.match(source, /SMOKE_RUN_CONTROL_PAUSE_TIMEOUT_MS/);
  assert.match(source, /"smoke pause\/resume run",\n\s+SMOKE_RUN_CONTROL_PAUSE_TIMEOUT_MS,\n\s+\)/);
});

test("loom harness smoke online sandbox profile drift diagnostics keep full-suite CLI startup headroom", async () => {
  const source = await readFile(join(process.cwd(), "tests/cli-harness.test.ts"), "utf8");
  const timeoutConstant = source.match(/const ONLINE_SANDBOX_PROFILE_SMOKE_TIMEOUT_MS = (\d+)_000;/);
  assert.ok(timeoutConstant);
  assert.ok(Number(timeoutConstant[1]) >= 60);
  const helperStart = source.indexOf("async function runOnlineSandboxProfileSmokeAgainstStatus");
  const helperEnd = source.indexOf("async function runAuthRolesSmokeAgainstViewerStatus", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helperSource = source.slice(helperStart, helperEnd);
  assert.match(helperSource, /timeout: ONLINE_SANDBOX_PROFILE_SMOKE_TIMEOUT_MS/);
  const authenticatedStart = source.indexOf('test("loom harness smoke verifies an authenticated HTTP service"');
  const authenticatedEnd = source.indexOf('test("loom harness smoke verifies run controls through a peer server"', authenticatedStart);
  assert.notEqual(authenticatedStart, -1);
  assert.notEqual(authenticatedEnd, -1);
  const authenticatedSource = source.slice(authenticatedStart, authenticatedEnd);
  assert.match(authenticatedSource, /timeout: ONLINE_SANDBOX_PROFILE_SMOKE_TIMEOUT_MS/);
});

test("loom harness smoke online sandbox profile requires an isolation tenant", async () => {
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "smoke",
      "--url",
      "http://127.0.0.1:9",
      "--tenant",
      "alice",
      "--project",
      "smoke-missing-isolation",
      "--template",
      "vas-lite",
      "--profile",
      "online-sandbox",
    ],
    { cwd: process.cwd(), env: process.env, reject: false, timeout: 10_000 },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /SMOKE_PROFILE_ISOLATION_TENANT_MISSING/);
  assert.match(result.stderr, /--profile online-sandbox requires --isolation-tenant/);
  assert.match(result.stderr, /"requiredFlag":"--isolation-tenant"/);
});

test("loom harness smoke reports missing dashboard readiness labels with diagnostics", async () => {
  const runId = "2026-06-29T00:00:00.000Z-deadbeef";
  const project = "smoke-dashboard-diagnostics";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><title>Loom Harness</title><div id=\"project-presence\"></div>");
      return;
    }

    res.setHeader("content-type", "application/json");
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      res.end(JSON.stringify(smokeProbeResponse(url.pathname)));
      return;
    }
    if (url.pathname === "/metrics") {
      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.end(smokeMetricsResponse());
      return;
    }
    if (req.method === "POST" && url.pathname === "/tenants/alice/projects") {
      res.statusCode = 201;
      res.end(JSON.stringify({ project, template: "empty" }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/runs") {
      res.statusCode = 201;
      res.end(JSON.stringify({ runId, status: "passed" }));
      return;
    }
    if (req.method === "GET" && url.pathname === `/tenants/alice/runs/${encodeURIComponent(runId)}`) {
      res.end(JSON.stringify({ status: "passed" }));
      return;
    }
    if (req.method === "GET" && url.pathname === `/tenants/alice/runs/${encodeURIComponent(runId)}/events`) {
      res.end(JSON.stringify([{ type: "finish" }]));
      return;
    }
    if (req.method === "GET" && url.pathname === `/tenants/alice/projects/${project}/files`) {
      res.end(JSON.stringify({ kind: "file", content: "loom smoke ok\n" }));
      return;
    }
    if (req.method === "GET" && url.pathname === `/tenants/alice/projects/${project}/workspace`) {
      res.end(JSON.stringify({ route: "project", executor: { kind: "local" } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        project,
        "--template",
        "empty",
        "--check-online",
      ],
      { cwd: process.cwd(), reject: false, timeout: 10_000 },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_ONLINE_READINESS_LABELS_MISSING/);
    assert.match(result.stderr, /"surface":"dashboard"/);
    assert.match(result.stderr, /"missingLabels":\["tenant profile readiness","global profile readiness"\]/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke rejects vas-lite project contract drift with diagnostics", async () => {
  const runId = "2026-06-29T00:00:00.000Z-deadbeef";
  const project = "smoke-contract-drift";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      res.end(JSON.stringify(smokeProbeResponse(url.pathname)));
      return;
    }
    if (url.pathname === "/metrics") {
      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.end(smokeMetricsResponse());
      return;
    }
    if (req.method === "POST" && url.pathname === "/tenants/alice/projects") {
      res.statusCode = 201;
      res.end(JSON.stringify({ project, template: "vas-lite" }));
      return;
    }
    if (req.method === "GET" && url.pathname === `/tenants/alice/projects/${project}`) {
      res.end(JSON.stringify({
        project,
        template: "vas-lite",
        contractStatus: { ok: false, missing: ["harness-loop", "human-gates"] },
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/runs") {
      res.statusCode = 201;
      res.end(JSON.stringify({ runId, status: "passed" }));
      return;
    }
    if (req.method === "GET" && url.pathname === `/tenants/alice/runs/${encodeURIComponent(runId)}`) {
      res.end(JSON.stringify({ status: "passed" }));
      return;
    }
    if (req.method === "GET" && url.pathname === `/tenants/alice/runs/${encodeURIComponent(runId)}/events`) {
      res.end(JSON.stringify([{ type: "finish" }]));
      return;
    }
    if (req.method === "GET" && url.pathname === `/tenants/alice/projects/${project}/files`) {
      res.end(JSON.stringify({ kind: "file", content: "loom smoke ok\n" }));
      return;
    }
    if (req.method === "GET" && url.pathname === `/tenants/alice/projects/${project}/workspace`) {
      res.end(JSON.stringify({ route: "project", executor: { kind: "local" } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        project,
        "--template",
        "vas-lite",
      ],
      { cwd: process.cwd(), reject: false, timeout: 10_000 },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_PROJECT_CONTRACT_DRIFT/);
    assert.match(result.stderr, /"template":"vas-lite"/);
    assert.match(result.stderr, /"missing":\["harness-loop","human-gates"\]/);
    assert.match(result.stderr, /project alice\/smoke-contract-drift contract drift/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke can verify tenant brain signal ingest", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-brain-signal");
  const completedRunSignals: any[] = [];
  const nativeSignals: any[] = [];
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    brainIngest: async (summary: any) => {
      completedRunSignals.push(summary);
    },
    brainSignalIngest: async (signal: any) => {
      nativeSignals.push(signal);
    },
    tenantApiKeys: {
      alice: [{ token: "dev-key", actor: "eno", role: "developer" }],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-brain",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--check-brain",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_TENANT_TOKEN: "dev-key" },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.brainSignalChecked, true);
    assert.equal(body.brainSignalRunId, body.runId);
    assert.equal(body.brainSignalOutcome, "pass");
    assert.equal(body.brainSignalSkillCount, 2);
    assert.equal(body.brainSignalAuditChecked, true);
    assert.equal(body.brainRunIngestChecked, true);
    assert.equal(body.brainRunIngestRunId, body.runId);
    assert.equal(body.brainRunIngestOutcome, "pass");
    assert.equal(body.brainRunIngestExternalEffectChecked, true);
    assert.equal(body.brainRunIngestAuditChecked, true);
    assert.equal(body.brainSignalFeedChecked, true);
    assert.equal(body.brainSignalFeedCount, 2);
    assert.equal(body.brainSignalFeedRunIngestChecked, true);
    assert.equal(body.brainSignalFeedWorkspaceSignalChecked, true);
    assert.equal(completedRunSignals.length, 1);
    assert.equal(completedRunSignals[0].runId, body.runId);
    assert.equal(completedRunSignals[0].status, "passed");
    assert.deepEqual(completedRunSignals[0].skills, ["smoke", "coding"]);
    assert.equal(nativeSignals.length, 1);
    assert.equal(nativeSignals[0].project, "smoke-brain");
    assert.equal(nativeSignals[0].runId, body.runId);
    assert.equal(nativeSignals[0].status, "passed");
    assert.deepEqual(nativeSignals[0].skills, ["smoke", "coding"]);
    assert.equal(nativeSignals[0].outcome, "pass");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke brain check rejects servers without brain ingest", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-brain-unconfigured");
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    tenantApiKeys: {
      alice: [{ token: "dev-key", actor: "eno", role: "developer" }],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-brain-unconfigured",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--check-brain",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_TENANT_TOKEN: "dev-key" },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_BRAIN_RUN_INGEST_MISSING/);
    assert.match(result.stderr, /brain run ingest external effect was not recorded/);
    assert.match(result.stderr, /"scope":"brain"/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke can verify model-backed run readiness", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-model");
  let calls = 0;
  const modelServer = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer server-key");
    await readBody(req);
    calls += 1;
    const step =
      calls === 1
        ? {
            message: "write model smoke artifact",
            actions: [
              {
                toolName: "file.write",
                input: { path: "loom-model-smoke.txt", content: "loom model smoke ok\n" },
              },
            ],
          }
        : { message: "finish model smoke", finish: true };
    res.writeHead(200, {
      "content-type": "application/json",
      "x-litellm-response-cost": calls === 1 ? "0.0012" : "0.0003",
    });
    res.end(JSON.stringify({
      id: `chatcmpl-smoke-${calls}`,
      model: "gateway-model",
      usage: {
        prompt_tokens: calls === 1 ? 20 : 8,
        completion_tokens: calls === 1 ? 10 : 4,
        total_tokens: calls === 1 ? 30 : 12,
      },
      choices: [{ message: { content: JSON.stringify(step) } }],
    }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelAddress = modelServer.address();
  assert.equal(typeof modelAddress, "object");
  assert.ok(modelAddress);

  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    modelBaseUrl: `http://127.0.0.1:${modelAddress.port}`,
    modelApiKey: "server-key",
    defaultModel: "smoke-default-model",
    tenantApiKeys: {
      alice: [{ token: "dev-key", actor: "eno", role: "developer" }],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-model",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--check-model",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_TENANT_TOKEN: "dev-key" },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.includes("server-key"), false);
    const body = JSON.parse(result.stdout);
    assert.equal(body.modelRunChecked, true);
    assert.match(body.modelRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.equal(body.modelRunStatus, "passed");
    assert.equal(body.modelRunModel, "smoke-default-model");
    assert.equal(body.modelRunArtifactPath, "loom-model-smoke.txt");
    assert.equal(body.modelRunArtifactRead, true);
    assert.equal(body.modelRunArtifactContent, "loom model smoke ok\n");
    assert.equal(body.modelRunUsageRequestCount, 2);
    assert.equal(body.modelRunUsageTotalTokens, 42);
    assert.equal(body.modelRunUsageCostUsd, 0.0015);
    assert.equal(body.modelRunReplayChecked, true);
    assert.equal(calls, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      modelServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness smoke can verify Gitea pull request readiness", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-gitea-pr");
  const pullRequests: Array<{ issue?: string; branch?: string; baseBranch?: string; status?: string }> = [];
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    publicUrl: "https://loom.example",
    issueBaseUrl: "https://git.example",
    pullRequestReporter: async (summary: { metadata?: { issue?: string; branch?: string; baseBranch?: string }; status?: string }) => {
      pullRequests.push({
        issue: summary.metadata?.issue,
        branch: summary.metadata?.branch,
        baseBranch: summary.metadata?.baseBranch,
        status: summary.status,
      });
      return { index: 17, url: "https://git.example/team/smoke/pulls/17" };
    },
    tenantApiKeys: {
      alice: [{ token: "dev-key", actor: "eno", role: "developer" }],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-gitea-pr",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--check-gitea-pr",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_TENANT_TOKEN: "dev-key" },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.giteaPrChecked, true);
    assert.match(body.giteaPrRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.equal(body.giteaPrRunStatus, "review_required");
    assert.equal(body.giteaPrIssue, "team/smoke#17");
    assert.equal(body.giteaPrBranch, "loom/smoke-pr");
    assert.equal(body.giteaPrBaseBranch, "main");
    assert.equal(body.giteaPrIndex, 17);
    assert.equal(body.giteaPrUrl, "https://git.example/team/smoke/pulls/17");
    assert.equal(body.giteaPrExternalEffectChecked, true);
    assert.deepEqual(pullRequests, [
      {
        issue: "team/smoke#17",
        branch: "loom/smoke-pr",
        baseBranch: "main",
        status: "review_required",
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke reports provider-neutral pull request readiness for agent-git-service", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-agent-git-service-pr");
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    controlPlaneProvider: "agent-git-service",
    publicUrl: "https://loom.example",
    issueBaseUrl: "https://git.example/api/v3",
    pullRequestReporter: async () => ({ index: 17, url: "https://git.example/team/smoke/pulls/17" }),
    tenantApiKeys: {
      alice: [{ token: "dev-key", actor: "eno", role: "developer" }],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-agent-git-service-pr",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--control-plane-provider",
        "agent-git-service",
        "--check-control-plane-pr",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_TENANT_TOKEN: "dev-key" },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.controlPlanePrChecked, true);
    assert.equal(body.controlPlanePrProvider, "agent-git-service");
    assert.equal(body.controlPlanePrIssue, "team/smoke#17");
    assert.equal(body.controlPlanePrIssueUrl, "https://git.example/team/smoke/issues/17");
    assert.equal(body.controlPlanePrUrl, "https://git.example/team/smoke/pulls/17");
    assert.equal(body.giteaPrChecked, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke rejects mismatched expected control-plane provider evidence", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-control-plane-provider-mismatch");
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    issueBaseUrl: "https://git.example",
    pullRequestReporter: async () => ({ index: 17, url: "https://git.example/team/smoke/pulls/17" }),
    tenantApiKeys: {
      alice: [{ token: "dev-key", actor: "eno", role: "developer" }],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-control-plane-provider-mismatch",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--control-plane-provider",
        "agent-git-service",
        "--check-control-plane-pr",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_TENANT_TOKEN: "dev-key" },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_CONTROL_PLANE_PROVIDER_MISMATCH/);
    assert.match(result.stderr, /"expected":"agent-git-service"/);
    assert.match(result.stderr, /"actual":"gitea-forgejo"/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke can verify Gitea issue comment readiness", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-gitea-comments");
  const requestedIssues: string[] = [];
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    issueBaseUrl: "https://git.example",
    issueCommentReader: async (issue: string) => {
      requestedIssues.push(issue);
      return [
        {
          id: "901",
          body: "/loom approve\nApproved from the smoke issue comment.",
          author: "eno",
          url: "https://git.example/team/smoke-comments/issues/17#comment-901",
          createdAt: "2026-06-29T10:00:00.000Z",
        },
      ];
    },
    tenantApiKeys: {
      alice: [{ token: "dev-key", actor: "eno", role: "developer" }],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-gitea-comments",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--check-gitea-comments",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_TENANT_TOKEN: "dev-key" },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.giteaCommentsChecked, true);
    assert.match(body.giteaCommentsRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.equal(body.giteaCommentsIssue, "team/smoke-comments#17");
    assert.equal(body.giteaCommentsSynced, 1);
    assert.equal(body.giteaCommentsRunReviewRequested, 1);
    assert.equal(body.giteaCommentsRunReviewed, 1);
    assert.equal(body.giteaCommentsRunStatus, "passed");
    assert.equal(body.giteaCommentsReplayChecked, true);
    assert.equal(body.giteaCommentsAuditChecked, true);
    assert.deepEqual(requestedIssues, ["team/smoke-comments#17"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke reports provider-neutral issue comment readiness for agent-git-service", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-agent-git-service-comments");
  const webhookSecret = "smoke-webhook-secret";
  const requestedIssues: string[] = [];
  await mkdir(join(workspaceRoot, "alice", ".loom"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "alice", ".loom", "policy.json"),
    JSON.stringify({
      schemaVersion: 1,
      controlPlaneIdentities: [
        {
          provider: "agent-git-service",
          externalActor: "octo-agent",
          actor: "eno",
          role: "developer",
        },
      ],
    }),
    "utf8",
  );
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    controlPlaneProvider: "agent-git-service",
    issueBaseUrl: "https://git.example/api/v3",
    giteaWebhookSecret: webhookSecret,
    issueCommentReader: async (issue: string) => {
      requestedIssues.push(issue);
      return [
        {
          id: "901",
          body: "/loom approve\nApproved from the smoke issue comment.",
          author: "eno",
          url: "https://git.example/team/smoke-comments/issues/17#comment-901",
          createdAt: "2026-06-29T10:00:00.000Z",
        },
      ];
    },
    tenantApiKeys: {
      alice: [{ token: "dev-key", actor: "eno", role: "developer" }],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-agent-git-service-comments",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--control-plane-provider",
        "agent-git-service",
        "--control-plane-webhook-secret-env",
        "LOOM_TEST_CONTROL_PLANE_WEBHOOK_SECRET",
        "--check-control-plane-comments",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOOM_TEST_TENANT_TOKEN: "dev-key",
          LOOM_TEST_CONTROL_PLANE_WEBHOOK_SECRET: webhookSecret,
        },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.controlPlaneCommentsChecked, true);
    assert.equal(body.controlPlaneCommentsProvider, "agent-git-service");
    assert.equal(body.controlPlaneCommentsIssue, "team/smoke-comments#17");
    assert.equal(body.controlPlaneCommentsIssueUrl, "https://git.example/team/smoke-comments/issues/17");
    assert.equal(body.controlPlaneCommentsRunStatus, "passed");
    assert.equal(body.controlPlaneCommentsWebhookChecked, true);
    assert.equal(body.controlPlaneCommentsWebhookProvider, "agent-git-service");
    assert.equal(body.controlPlaneCommentsWebhookIssue, "team/smoke-webhook-comments#18");
    assert.equal(body.controlPlaneCommentsWebhookRunStatus, "passed");
    assert.equal(body.controlPlaneCommentsWebhookSynced, 1);
    assert.equal(body.controlPlaneCommentsWebhookRunReviewRequested, 1);
    assert.equal(body.controlPlaneCommentsWebhookRunReviewed, 1);
    assert.equal(body.controlPlaneCommentsWebhookAuditChecked, true);
    assert.equal(body.giteaCommentsChecked, true);
    assert.deepEqual(requestedIssues, ["team/smoke-comments#17"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke verifies backup migration dry-run from agent-git-service provider", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-agent-git-service-backup");
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    controlPlaneProvider: "agent-git-service",
    tenantApiKeys: {
      alice: [
        { token: "admin-key", actor: "ops", role: "admin" },
        { token: "dev-key", actor: "eno", role: "developer" },
      ],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-agent-git-service-backup",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--admin-token-env",
        "LOOM_TEST_ADMIN_TOKEN",
        "--control-plane-provider",
        "agent-git-service",
        "--check-backup",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOOM_TEST_TENANT_TOKEN: "dev-key",
          LOOM_TEST_ADMIN_TOKEN: "admin-key",
        },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.backupManifestChecked, true);
    assert.deepEqual(body.backupManifestControlPlaneBoundary, [...CONTROL_PLANE_PROVIDER_BOUNDARY]);
    assert.equal(body.backupRestoreDryRunChecked, true);
    assert.equal(body.backupRestoreDryRunSourceProvider, "agent-git-service");
    assert.equal(body.backupRestoreDryRunTargetProvider, "gitea-forgejo");
    assert.deepEqual(body.backupRestoreDryRunProjectNames, ["smoke-agent-git-service-backup"]);
    assert.equal(body.backupRestoreDryRunAuditChecked, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke can rehearse agent-git-service cutover secret injection", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-agent-git-service-cutover");
  const secretRoot = await tempDir("loom-cli-smoke-agent-git-service-cutover-secrets");
  await writeProjectMetadata(workspaceRoot, "alice", "smoke-agent-git-service-cutover");
  await mkdir(join(workspaceRoot, "alice", "smoke-agent-git-service-cutover", ".loom", "control-plane", "agent-git-service"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "alice", "smoke-agent-git-service-cutover", ".loom", "control-plane", "agent-git-service", "provisioning.json"),
    JSON.stringify({
      schemaVersion: 1,
      provider: "agent-git-service",
      tenant: "alice",
      project: "smoke-agent-git-service-cutover",
      baseUrl: "https://git.example/api/v3",
      repo: "team/app",
      agentLogin: "loom-agent-1",
      agentRepoFullName: "agents/loom-agent-1",
      permission: "write",
      grantStatus: "granted",
      tokenEnvName: "LOOM_ALICE_SMOKE_AGENT_TOKEN",
      tokenMaterial: "returned-only",
      provisionedAt: "2026-06-30T00:00:00.000Z",
    }, null, 2) + "\n",
    "utf8",
  );
  await mkdir(join(secretRoot, "alice", "smoke-agent-git-service-cutover"), { recursive: true });
  await writeFile(join(secretRoot, "alice", "smoke-agent-git-service-cutover", "LOOM_ALICE_SMOKE_AGENT_TOKEN"), "project-agent-token\n", "utf8");
  await chmod(join(secretRoot, "alice", "smoke-agent-git-service-cutover", "LOOM_ALICE_SMOKE_AGENT_TOKEN"), 0o600);

  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    allowedTools: ["file.read", "file.write", "shell.exec", "git.diff", "verify.run"],
    controlPlaneProvider: "agent-git-service",
    agentGitServiceTokenSecretRoot: secretRoot,
    tenantApiKeys: {
      alice: [{ token: "dev-key", actor: "eno", role: "developer" }],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-agent-git-service-cutover",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--control-plane-provider",
        "agent-git-service",
        "--check-agent-git-service-cutover",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOOM_TEST_TENANT_TOKEN: "dev-key",
        },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.includes("project-agent-token"), false);
    const body = JSON.parse(result.stdout);
    assert.equal(body.agentGitServiceCutoverChecked, true);
    assert.equal(body.agentGitServiceCutoverProvider, "agent-git-service");
    assert.equal(body.agentGitServiceCutoverReceiptChecked, true);
    assert.equal(body.agentGitServiceCutoverReceiptSecretAbsent, true);
    assert.equal(body.agentGitServiceCutoverTokenEnvName, "LOOM_ALICE_SMOKE_AGENT_TOKEN");
    assert.equal(body.agentGitServiceCutoverWorkspaceTokenChecked, true);
    assert.equal(body.agentGitServiceCutoverCommandStdout, "agent-git-service-cutover-token-ok");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke platform readiness enables agent-git-service cutover rehearsal", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-platform-agent-git-service-cutover");
  const secretRoot = await tempDir("loom-cli-smoke-platform-agent-git-service-cutover-secrets");
  let modelCalls = 0;
  const modelServer = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer server-key");
    await readBody(req);
    modelCalls += 1;
    const step =
      modelCalls === 1
        ? {
            message: "write model smoke artifact",
            actions: [
              {
                toolName: "file.write",
                input: { path: "loom-model-smoke.txt", content: "loom model smoke ok\n" },
              },
            ],
          }
        : { message: "finish model smoke", finish: true };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `chatcmpl-platform-ags-${modelCalls}`,
      model: "gateway-model",
      usage: {
        prompt_tokens: modelCalls === 1 ? 20 : 8,
        completion_tokens: modelCalls === 1 ? 10 : 4,
        total_tokens: modelCalls === 1 ? 30 : 12,
      },
      choices: [{ message: { content: JSON.stringify(step) } }],
    }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelAddress = modelServer.address();
  assert.equal(typeof modelAddress, "object");
  assert.ok(modelAddress);
  const agentGitService = await startAgentGitServiceContractServer({
    workspace: {
      id: "ws-smoke",
      agentLogin: "loom-agent-1",
      status: "active",
    },
    wikiMemory: {
      page: "vas/learnings",
      body: "Existing AGS smoke memory\n",
      sha: "abc123",
    },
  });
  const controlPlaneBaseUrl = agentGitService.baseUrl;

  const server = createHarnessHttpServer({
    workspaceRoot,
    profile: "platform-readiness",
    controlPlaneProvider: "agent-git-service",
    controlPlaneBaseUrl,
    controlPlaneAdminToken: "admin-token",
    agentGitServiceTokenSecretRoot: secretRoot,
    agentGitServiceCreateAgent: async () => ({
      login: "loom-agent-1",
      token: "project-agent-token",
      repoFullName: "agents/loom-agent-1",
    }),
    agentGitServiceGrantRepoAccess: async (options: any) => ({
      repo: options.repo,
      agentLogin: options.agentLogin,
      permission: options.permission,
      status: "granted",
    }),
    executorKind: "coder",
    runWorkspaceIsolation: "run",
    allowedTools: [...onlineSandboxTools(), "git.pr"],
    modelBaseUrl: `http://127.0.0.1:${modelAddress.port}`,
    modelApiKey: "server-key",
    defaultModel: "smoke-default-model",
    publicUrl: "https://loom.example",
    issueBaseUrl: controlPlaneBaseUrl,
    brainSignalIngest: () => undefined,
    brainIngest: () => undefined,
    pullRequestReporter: async () => ({ index: 23, url: "https://git.example/team/smoke/pulls/23" }),
    workspacePullRequestReporter: async (request: any) => {
      agentGitService.setWorkspace({
        id: "ws-smoke",
        agentLogin: "loom-agent-1",
        branch: request.branch,
        status: "active",
      });
      return { index: 24, url: "https://git.example/team/smoke/pulls/24" };
    },
    mergeReporter: async () => undefined,
    giteaWebhookSecret: "webhook-secret",
    controlPlaneAgentIdentity: {
      mode: "tenant-scoped",
      tenants: ["alice", "bob"],
    },
    issueCommentReader: async () => [
      {
        id: "902",
        body: "/loom approve\nApproved from the AGS platform readiness issue comment.",
        author: "eno",
        url: "https://git.example/team/smoke-comments/issues/17#comment-902",
        createdAt: "2026-06-29T10:05:00.000Z",
      },
    ],
    tenantApiKeys: {
      alice: [
        { token: "admin-key", actor: "ops", role: "admin" },
        { token: "dev-key", actor: "eno", role: "developer" },
        { token: "viewer-key", actor: "auditor", role: "viewer" },
      ],
      bob: [{ token: "bob-key", actor: "bob", role: "developer" }],
    },
    createExecutor: (cwd, context) => {
      const executor = createLocalExecutor({ cwd });
      return {
        ...executor,
        describeWorkspace(): Record<string, string> {
          return {
            kind: "coder",
            workspace: `${context.tenant}-${context.project}-${context.runId}`,
            cwd,
            ideUrl: `https://coder.example/${context.tenant}/${context.project}/${context.runId}/ide`,
            previewUrl: `https://coder.example/${context.tenant}/${context.project}/${context.runId}/preview`,
          };
        },
      };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const createProject = await fetch(`${baseUrl}/tenants/alice/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dev-key" },
      body: JSON.stringify({
        project: "smoke-platform-ags",
        template: "vas-lite",
        defaultSkills: ["vas-lite", "coding"],
        preset: "vas-lite-review",
        presetInput: { caseId: "bootstrap" },
        reviewRequired: true,
        objective: HARNESS_VISION_LOCK.target,
        constraints: [
          "Keep harness/loop evidence durable in .loom project state.",
          "Keep human review and deployment gates explicit for side effects.",
          "Keep sandbox work file-backed so runs can resume, inspect, and audit it.",
          "Promote VAS corrections into durable learning updates only after review.",
        ],
        successCriteria: [
          "Tenant projects and runs are operable through the HTTP control plane and Dashboard.",
          "Runs record project contract, policy, events, verification, and gate decisions.",
          "VAS-lite cases can move from evidence to review to learning updates.",
        ],
      }),
    });
    assert.equal(createProject.status, 201);
    const provision = await fetch(`${baseUrl}/tenants/alice/projects/smoke-platform-ags/control-plane/agent-git-service/provision`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-key" },
      body: JSON.stringify({
        repo: "team/app",
        tokenEnvName: "LOOM_ALICE_SMOKE_PLATFORM_AGS_TOKEN",
        storeAgentToken: true,
      }),
    });
    assert.equal(provision.status, 201);
    assert.equal(JSON.stringify(await provision.json()).includes("project-agent-token"), false);

    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        baseUrl,
        "--tenant",
        "alice",
        "--project",
        "smoke-platform-ags",
        "--template",
        "vas-lite",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--viewer-token-env",
        "LOOM_TEST_VIEWER_TOKEN",
        "--admin-token-env",
        "LOOM_TEST_ADMIN_TOKEN",
        "--isolation-tenant",
        "bob",
        "--profile",
        "platform-readiness",
        "--control-plane-provider",
        "agent-git-service",
        "--control-plane-webhook-secret-env",
        "LOOM_TEST_CONTROL_PLANE_WEBHOOK_SECRET",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOOM_TEST_TENANT_TOKEN: "dev-key",
          LOOM_TEST_VIEWER_TOKEN: "viewer-key",
          LOOM_TEST_ADMIN_TOKEN: "admin-key",
          LOOM_TEST_CONTROL_PLANE_WEBHOOK_SECRET: "webhook-secret",
        },
        reject: false,
        timeout: 90_000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.includes("project-agent-token"), false);
    const body = JSON.parse(result.stdout);
    assert.equal(body.profile, "platform-readiness");
    assert.equal(body.serverControlPlaneProvider, "agent-git-service");
    assert.ok(body.serverControlPlaneAdoptionStages.includes("tenant-default-cutover"));
    assert.ok(body.serverControlPlaneGatedAdoptionStages.includes("tenant-default-cutover"));
    assert.equal(body.serverControlPlaneTenantDefaultCutoverGated, true);
    assert.equal(body.serverControlPlaneDiscoveryChecked, true);
    assert.equal(body.serverControlPlaneDiscoveryProvider, "agent-git-service");
    assert.equal(body.serverControlPlaneDiscoveryOk, true);
    assert.equal(body.serverControlPlaneDiscoveryEndpointCount, 3);
    assert.equal(body.serverControlPlaneDiscoveryOkEndpointCount, 3);
    assert.deepEqual(body.serverControlPlaneDiscoveryMissingEndpoints, []);
    assert.equal(body.serverControlPlaneDiscoveryTokenMode, "admin");
    assert.equal(body.serverControlPlaneDiscoveryTenantCount, 0);
    assert.equal(body.serverControlPlaneDiscoveryTenantOkCount, 0);
    assert.deepEqual(body.serverControlPlaneDiscoveryMissingTenants, []);
    assert.equal(body.tenantControlPlaneProvider, "agent-git-service");
    assert.ok(body.tenantControlPlaneAdoptionStages.includes("tenant-default-cutover"));
    assert.ok(body.tenantControlPlaneGatedAdoptionStages.includes("tenant-default-cutover"));
    assert.equal(body.tenantControlPlaneTenantDefaultCutoverGated, true);
    assert.equal(body.tenantControlPlaneDiscoveryChecked, true);
    assert.equal(body.tenantControlPlaneDiscoveryProvider, "agent-git-service");
    assert.equal(body.tenantControlPlaneDiscoveryOk, true);
    assert.equal(body.tenantControlPlaneDiscoveryEndpointCount, 3);
    assert.equal(body.tenantControlPlaneDiscoveryOkEndpointCount, 3);
    assert.deepEqual(body.tenantControlPlaneDiscoveryMissingEndpoints, []);
    assert.equal(body.tenantControlPlaneDiscoveryTokenMode, "admin");
    assert.equal(body.tenantControlPlaneDiscoveryTenantCount, 0);
    assert.equal(body.tenantControlPlaneDiscoveryTenantOkCount, 0);
    assert.deepEqual(body.tenantControlPlaneDiscoveryMissingTenants, []);
    assert.ok(body.onlineSandboxGoldenPathCapabilities.includes("agent-git-service-cutover"));
    assert.ok(body.onlineSandboxGoldenPathCapabilities.includes("agent-git-service-native-projection"));
    assert.equal(body.agentGitServiceProjectAgentsOk, true);
    assert.equal(body.agentGitServiceCutoverChecked, true);
    assert.equal(body.agentGitServiceCutoverProvider, "agent-git-service");
    assert.equal(body.agentGitServiceCutoverReceiptSecretAbsent, true);
    assert.equal(body.agentGitServiceCutoverTokenEnvName, "LOOM_ALICE_SMOKE_PLATFORM_AGS_TOKEN");
    assert.equal(body.agentGitServiceCutoverWorkspaceTokenChecked, true);
    assert.equal(body.agentGitServiceCutoverCommandStdout, "agent-git-service-cutover-token-ok");
    assert.equal(body.agentGitServiceNativeProjectionChecked, true);
    assert.equal(body.agentGitServiceHandoffWorkspaceAttachmentChecked, true);
    assert.equal(body.agentGitServiceHandoffWorkspaceAttachmentWorkspaceId, "ws-smoke");
    assert.equal(body.agentGitServiceHandoffWorkspaceAttachmentId, "1");
    assert.equal(
      body.agentGitServiceHandoffWorkspaceAttachmentUrl,
      `${agentGitService.webBaseUrl}/team/loom-smoke/issues/17/workspaces/ws-smoke/attachments/1`,
    );
    assert.match(body.agentGitServiceHandoffPackageUrl, /https:\/\/loom\.example\/tenants\/alice\/runs\/.+\/handoff-package\?project=smoke-platform-ags/);
    const agentGitServiceWorkspaceAttachments = agentGitService.requests.filter((request) =>
      request.method === "POST" &&
      request.path === "/api/v3/repos/team/loom-smoke/issues/17/workspaces/ws-smoke/attachments"
    );
    assert.equal(agentGitServiceWorkspaceAttachments.length, 1);
    assert.equal(agentGitServiceWorkspaceAttachments[0]?.authorization, "Bearer admin-token");
    assert.deepEqual(agentGitServiceWorkspaceAttachments[0]?.json, {
      name: `Loom handoff package ${body.runScopedPullRequestDuringActiveRunId}`,
      url: body.agentGitServiceHandoffPackageUrl,
      content_type: "application/json",
    });
    assert.equal(body.agentGitServiceWikiMemoryChecked, true);
    assert.equal(body.agentGitServiceWikiMemoryPage, "vas/learnings");
    assert.equal(body.agentGitServiceWikiMemorySha, "sha-after");
    assert.equal(body.agentGitServiceWikiMemoryUrl, `${agentGitService.webBaseUrl}/team/loom-smoke/wiki/vas/learnings`);
    assert.equal(body.agentGitServiceWikiMemoryLearningCount, 1);
    const agentGitServiceWikiMemoryUpdates = agentGitService.requests.filter((request) =>
      request.method === "PUT" &&
      request.path === "/api/v3/repos/team/loom-smoke/wiki/memory/vas%2Flearnings"
    );
    assert.equal(agentGitServiceWikiMemoryUpdates.length, 1);
    assert.equal(agentGitServiceWikiMemoryUpdates[0]?.authorization, "Bearer admin-token");
    assert.match(String(agentGitServiceWikiMemoryUpdates[0]?.json?.body ?? ""), /Loom smoke review gates preserve approved learning updates/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await agentGitService.close();
    await new Promise<void>((resolve, reject) =>
      modelServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness smoke rejects mismatched expected control-plane provider in backup evidence", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-backup-provider-mismatch");
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    tenantApiKeys: {
      alice: [
        { token: "admin-key", actor: "ops", role: "admin" },
        { token: "dev-key", actor: "eno", role: "developer" },
      ],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-backup-provider-mismatch",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--admin-token-env",
        "LOOM_TEST_ADMIN_TOKEN",
        "--control-plane-provider",
        "agent-git-service",
        "--check-backup",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOOM_TEST_TENANT_TOKEN: "dev-key",
          LOOM_TEST_ADMIN_TOKEN: "admin-key",
        },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_CONTROL_PLANE_PROVIDER_MISMATCH/);
    assert.match(result.stderr, /"scope":"control-plane-backup"/);
    assert.match(result.stderr, /"expected":"agent-git-service"/);
    assert.match(result.stderr, /"actual":"gitea-forgejo"/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke can verify Coder workspace readiness", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-coder");
  const files = new Map<string, string>();
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    tenantApiKeys: {
      alice: [{ token: "dev-key", actor: "eno", role: "developer" }],
    },
    createExecutor: (cwd, context) => ({
      async inspectPath(path: string): Promise<any> {
        if (files.has(path)) {
          return {
            path,
            kind: "file",
            size: files.get(path)?.length ?? 0,
            updatedAt: "2026-06-28T00:00:00.000Z",
          };
        }
        return { path, kind: "missing" };
      },
      async readFile(path: string): Promise<string> {
        return files.get(path) ?? "";
      },
      async writeFile(path: string, content: string): Promise<void> {
        files.set(path, content);
      },
      async runCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        if (command === "test -f loom-smoke.txt") {
          return { stdout: "", stderr: "", exitCode: files.has("loom-smoke.txt") ? 0 : 1 };
        }
        return { stdout: "", stderr: `unexpected command: ${command}`, exitCode: 1 };
      },
      describeWorkspace(): Record<string, string> {
        return {
          kind: "coder",
          workspace: `${context.tenant}-${context.project}-${context.runId}`,
          cwd,
          ideUrl: `https://coder.example/${context.tenant}/${context.project}/${context.runId}/ide`,
          previewUrl: `https://coder.example/${context.tenant}/${context.project}/${context.runId}/preview`,
        };
      },
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-coder",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--check-coder",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_TENANT_TOKEN: "dev-key" },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.coderChecked, true);
    assert.equal(body.coderProjectWorkspaceChecked, true);
    assert.equal(body.coderRunWorkspaceChecked, true);
    assert.equal(body.coderProjectExecutorKind, "coder");
    assert.equal(body.coderRunExecutorKind, "coder");
    assert.equal(body.coderProjectWorkspace, "alice-smoke-coder-workspace-info");
    assert.equal(body.coderRunWorkspace, `alice-smoke-coder-${body.runId}`);
    assert.equal(body.coderProjectIdeUrl, "https://coder.example/alice/smoke-coder/workspace-info/ide");
    assert.equal(body.coderRunIdeUrl, `https://coder.example/alice/smoke-coder/${body.runId}/ide`);
    assert.equal(body.coderProjectPreviewUrl, "https://coder.example/alice/smoke-coder/workspace-info/preview");
    assert.equal(body.coderRunPreviewUrl, `https://coder.example/alice/smoke-coder/${body.runId}/preview`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke auth roles reports missing viewer token with diagnostics", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-auth-roles-missing-viewer");
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    allowedTools: onlineSandboxTools(),
    tenantApiKeys: tenantRoleKeys(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-auth-missing-viewer",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--check-auth-roles",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_TENANT_TOKEN: "dev-key" },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_AUTH_VIEWER_TOKEN_MISSING/);
    assert.match(result.stderr, /"scope":"auth-roles"/);
    assert.match(result.stderr, /"tenant":"alice"/);
    assert.match(result.stderr, /--check-auth-roles requires --viewer-token or --viewer-token-env/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke auth roles reports viewer role mismatches with diagnostics", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-auth-roles-viewer-mismatch");
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    allowedTools: onlineSandboxTools(),
    tenantApiKeys: tenantRoleKeys(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-auth-viewer-mismatch",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--viewer-token-env",
        "LOOM_TEST_VIEWER_TOKEN",
        "--check-auth-roles",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOOM_TEST_TENANT_TOKEN: "dev-key",
          LOOM_TEST_VIEWER_TOKEN: "dev-key",
        },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_AUTH_VIEWER_ROLE_MISMATCH/);
    assert.match(result.stderr, /"scope":"auth-roles"/);
    assert.match(result.stderr, /"tenant":"alice"/);
    assert.match(result.stderr, /"expectedRole":"viewer"/);
    assert.match(result.stderr, /"actualRole":"developer"/);
    assert.match(result.stderr, /smoke viewer token reported role "developer"/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke auth roles reports viewer tenant readiness gaps with diagnostics", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-auth-roles-viewer-readiness");
  const server = createHarnessHttpServer({
    workspaceRoot,
    profile: "online-sandbox",
    allowUnsafeLocalExecutor: true,
    allowedTools: onlineSandboxTools(),
    tenantApiKeys: tenantRoleKeys(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-auth-viewer-readiness",
        "--template",
        "empty",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--viewer-token-env",
        "LOOM_TEST_VIEWER_TOKEN",
        "--check-auth-roles",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOOM_TEST_TENANT_TOKEN: "dev-key",
          LOOM_TEST_VIEWER_TOKEN: "viewer-key",
        },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_AUTH_VIEWER_READINESS_MISSING/);
    assert.match(result.stderr, /"scope":"auth-roles"/);
    assert.match(result.stderr, /"tenant":"alice"/);
    assert.match(result.stderr, /"profile":"online-sandbox"/);
    assert.match(result.stderr, /"missing":\["sandboxExecutor","persistentHome"\]/);
    assert.match(result.stderr, /smoke viewer tenant status missing readiness: sandboxExecutor, persistentHome/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke auth roles reports viewer tenant vision lock drift with diagnostics", async () => {
  const cases = [
    {
      status: {
        readiness: onlineSandboxReadiness(),
        visionLock: {
          target: "single-user scratchpad",
          mvpIsScopeReduction: false,
          capabilities: visionLockCapabilities(),
        },
      },
      code: /SMOKE_AUTH_VIEWER_VISION_LOCK_TARGET_MISMATCH/,
      detail: /"actualTarget":"single-user scratchpad"/,
      message: /smoke viewer tenant status reported an unexpected vision lock target/,
    },
    {
      status: {
        readiness: onlineSandboxReadiness(),
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: true,
          capabilities: visionLockCapabilities(),
        },
      },
      code: /SMOKE_AUTH_VIEWER_VISION_LOCK_SCOPE_REDUCTION/,
      detail: /"mvpIsScopeReduction":true/,
      message: /smoke viewer tenant status reported MVP as a scope reduction/,
    },
    {
      status: {
        readiness: onlineSandboxReadiness(),
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: false,
          capabilities: visionLockCapabilities().filter((capability) => capability !== "human-gated-side-effects"),
        },
      },
      code: /SMOKE_AUTH_VIEWER_VISION_LOCK_CAPABILITIES_MISSING/,
      detail: /"missingCapabilities":\["human-gated-side-effects"\]/,
      message: /smoke viewer tenant status missing vision lock capabilities: human-gated-side-effects/,
    },
  ];

  for (const driftCase of cases) {
    const result = await runAuthRolesSmokeAgainstViewerStatus(driftCase.status);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, driftCase.code);
    assert.match(result.stderr, /"scope":"auth-roles"/);
    assert.match(result.stderr, /"tenant":"alice"/);
    assert.match(result.stderr, driftCase.detail);
    assert.match(result.stderr, driftCase.message);
  }
});

test("loom harness smoke auth roles reports viewer tenant golden path drift with diagnostics", async () => {
  const cases = [
    {
      status: {
        readiness: { profile: "online-sandbox", ok: true, missing: [] },
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: false,
          capabilities: visionLockCapabilities(),
        },
      },
      code: /SMOKE_AUTH_VIEWER_GOLDEN_PATH_MISSING/,
      detail: /"missing":\["readiness\.goldenPath"\]/,
      message: /smoke viewer tenant status did not report readiness golden path/,
    },
    {
      status: {
        readiness: {
          profile: "online-sandbox",
          ok: true,
          missing: [],
          goldenPath: {
            required: true,
            ok: false,
            capabilities: onlineSandboxGoldenPathCapabilities().filter((capability) => capability !== "workspace-collaboration"),
            missingCapabilities: ["workspace-collaboration"],
          },
        },
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: false,
          capabilities: visionLockCapabilities(),
        },
      },
      code: /SMOKE_AUTH_VIEWER_GOLDEN_PATH_MISSING/,
      detail: /"missingCapabilities":\["workspace-collaboration"\]/,
      message: /smoke viewer tenant status missing golden path capabilities: workspace-collaboration/,
    },
  ];

  for (const driftCase of cases) {
    const result = await runAuthRolesSmokeAgainstViewerStatus(driftCase.status);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, driftCase.code);
    assert.match(result.stderr, /"scope":"auth-roles"/);
    assert.match(result.stderr, /"tenant":"alice"/);
    assert.match(result.stderr, driftCase.detail);
    assert.match(result.stderr, driftCase.message);
  }
});

test("loom harness smoke platform readiness profile enables external checks", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-platform-profile");
  let modelCalls = 0;
  const modelServer = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer server-key");
    await readBody(req);
    modelCalls += 1;
    const step =
      modelCalls === 1
        ? {
            message: "write model smoke artifact",
            actions: [
              {
                toolName: "file.write",
                input: { path: "loom-model-smoke.txt", content: "loom model smoke ok\n" },
              },
            ],
          }
        : { message: "finish model smoke", finish: true };
    res.writeHead(200, {
      "content-type": "application/json",
      "x-litellm-response-cost": modelCalls === 1 ? "0.001" : "0.0005",
    });
    res.end(JSON.stringify({
      id: `chatcmpl-platform-${modelCalls}`,
      model: "gateway-model",
      usage: {
        prompt_tokens: modelCalls === 1 ? 20 : 8,
        completion_tokens: modelCalls === 1 ? 10 : 4,
        total_tokens: modelCalls === 1 ? 30 : 12,
      },
      choices: [{ message: { content: JSON.stringify(step) } }],
    }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelAddress = modelServer.address();
  assert.equal(typeof modelAddress, "object");
  assert.ok(modelAddress);

  const pullRequests: Array<{ issue?: string; branch?: string; baseBranch?: string; status?: string }> = [];
  const workspacePullRequests: Array<{ runId?: string; branch?: string; commit?: string; push?: boolean }> = [];
  const requestedIssues: string[] = [];
  const completedRunSignals: unknown[] = [];
  const brainSignals: unknown[] = [];
  const server = createHarnessHttpServer({
    workspaceRoot,
    profile: "platform-readiness",
    executorKind: "coder",
    runWorkspaceIsolation: "run",
    allowedTools: [...onlineSandboxTools(), "git.pr"],
    modelBaseUrl: `http://127.0.0.1:${modelAddress.port}`,
    modelApiKey: "server-key",
    defaultModel: "smoke-default-model",
    publicUrl: "https://loom.example",
    issueBaseUrl: "https://git.example",
    brainSignalIngest: (signal) => {
      brainSignals.push(signal);
    },
    brainIngest: (summary) => {
      completedRunSignals.push(summary);
    },
    pullRequestReporter: async (summary: { metadata?: { issue?: string; branch?: string; baseBranch?: string }; status?: string }) => {
      pullRequests.push({
        issue: summary.metadata?.issue,
        branch: summary.metadata?.branch,
        baseBranch: summary.metadata?.baseBranch,
        status: summary.status,
      });
      return { index: 23, url: "https://git.example/team/smoke/pulls/23" };
    },
    workspacePullRequestReporter: async (request: { runId?: string; branch?: string; commit?: string; push?: boolean }) => {
      workspacePullRequests.push({
        runId: request.runId,
        branch: request.branch,
        commit: request.commit,
        push: request.push,
      });
      return { index: 24, url: "https://git.example/team/smoke/pulls/24" };
    },
    mergeReporter: async () => undefined,
    giteaWebhookSecret: "webhook-secret",
    controlPlaneAgentIdentity: {
      mode: "tenant-scoped",
      tenants: ["alice", "bob"],
    },
    issueCommentReader: async (issue: string) => {
      requestedIssues.push(issue);
      return [
        {
          id: "902",
          body: "/loom approve\nApproved from the platform readiness issue comment.",
          author: "eno",
          url: "https://git.example/team/smoke-comments/issues/17#comment-902",
          createdAt: "2026-06-29T10:05:00.000Z",
        },
      ];
    },
    tenantApiKeys: {
      alice: [
        { token: "admin-key", actor: "ops", role: "admin" },
        { token: "dev-key", actor: "eno", role: "developer" },
        { token: "viewer-key", actor: "auditor", role: "viewer" },
      ],
      bob: [{ token: "bob-key", actor: "bob", role: "developer" }],
    },
    createExecutor: (cwd, context) => {
      const executor = createLocalExecutor({ cwd });
      return {
        ...executor,
        describeWorkspace(): Record<string, string> {
          return {
            kind: "coder",
            workspace: `${context.tenant}-${context.project}-${context.runId}`,
            cwd,
            ideUrl: `https://coder.example/${context.tenant}/${context.project}/${context.runId}/ide`,
            previewUrl: `https://coder.example/${context.tenant}/${context.project}/${context.runId}/preview`,
          };
        },
      };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-platform",
        "--template",
        "vas-lite",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--viewer-token-env",
        "LOOM_TEST_VIEWER_TOKEN",
        "--admin-token-env",
        "LOOM_TEST_ADMIN_TOKEN",
        "--isolation-tenant",
        "bob",
        "--profile",
        "platform-readiness",
        "--control-plane-webhook-secret-env",
        "LOOM_TEST_CONTROL_PLANE_WEBHOOK_SECRET",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOOM_TEST_TENANT_TOKEN: "dev-key",
          LOOM_TEST_VIEWER_TOKEN: "viewer-key",
          LOOM_TEST_ADMIN_TOKEN: "admin-key",
          LOOM_TEST_CONTROL_PLANE_WEBHOOK_SECRET: "webhook-secret",
        },
        reject: false,
        timeout: 360_000,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.includes("server-key"), false);
    const body = JSON.parse(result.stdout);
    assert.equal(body.profile, "platform-readiness");
    assert.equal(body.serverProfile, "platform-readiness");
    assert.equal(body.onlineSandboxGoldenPathChecked, true);
    assert.equal(body.onlineSandboxGoldenPathProfile, "platform-readiness");
    assert.ok(body.onlineSandboxGoldenPathCapabilities.includes("multi-user-isolation"));
    assert.ok(body.onlineSandboxGoldenPathCapabilities.includes("auditable-harness-loop"));
    assert.ok(body.onlineSandboxGoldenPathCapabilities.includes("vas-lite-learning"));
    assert.ok(body.onlineSandboxGoldenPathCapabilities.includes("handoff-followup"));
    assert.ok(body.onlineSandboxGoldenPathCapabilities.includes("multi-agent-concurrency"));
    assert.equal(body.onlineSandboxGoldenPathCapabilities.includes("agent-git-service-cutover"), false);
    assert.equal(body.serverReadinessChecked, true);
    assert.equal(body.serverReadinessOk, true);
    assert.deepEqual(body.serverReadinessMissing, []);
    assert.equal(body.healthProbesChecked, true);
    assert.equal(body.healthzOk, true);
    assert.equal(body.readyzReady, true);
    assert.equal(body.healthProbesSensitiveFieldsAbsent, true);
    assert.equal(body.metricsChecked, true);
    assert.equal(body.metricsReady, true);
    assert.equal(body.metricsLowCardinalityChecked, true);
    assert.equal(body.metricsSensitiveLabelsAbsent, true);
    assert.ok(body.metricsNames.includes("loom_harness_ready"));
    assert.ok(body.metricsNames.includes("loom_harness_active_runs"));
    assert.ok(body.metricsNames.includes("loom_harness_review_required_runs"));
    assert.ok(body.metricsNames.includes("loom_harness_deployment_required_runs"));
    assert.ok(body.metricsNames.includes("loom_harness_model_usage_warning_projects"));
    assert.ok(body.metricsNames.includes("loom_harness_workspace_usage_warning_projects"));
    assert.equal(body.serverRunWorkspaceIsolation, "run");
    assert.equal(body.tenantRunWorkspaceIsolation, "run");
    assert.equal(body.serverConcurrencyAdmissionChecked, true);
    assert.equal(body.serverConcurrencyAdmissionSchemaVersion, "loom-concurrency-admission/v1");
    assert.equal(body.serverConcurrencyAdmissionRunWorkspaceIsolation, "run");
    assert.equal(body.serverConcurrencyAdmissionActiveRunClaimScope, "run");
    assert.deepEqual(body.serverConcurrencyAdmissionQueueBlockedReasons, ["tenant_active_run_limit", "project_active_workspace", "persisted_running_run"]);
    assert.equal(body.serverConcurrencyAdmissionRunControlCrossServer, true);
    assert.equal(body.tenantConcurrencyAdmissionChecked, true);
    assert.equal(body.tenantConcurrencyAdmissionSchemaVersion, "loom-concurrency-admission/v1");
    assert.equal(body.tenantConcurrencyAdmissionRunWorkspaceIsolation, "run");
    assert.equal(body.tenantConcurrencyAdmissionActiveRunClaimScope, "run");
    assert.equal(body.controlPlaneWorkspaceBranchLeaseChecked, true);
    assert.equal(body.controlPlaneWorkspaceBranchLeaseProvider, "gitea-forgejo");
    assert.equal(body.controlPlaneWorkspaceBranchLeaseIsolation, "run");
    assert.equal(body.controlPlaneWorkspaceBranchLeaseBranchDerivation, "run-suffixed");
    assert.equal(body.controlPlaneWorkspaceBranchLeaseActiveRunLeaseEvidence, true);
    assert.equal(body.visionLockChecked, true);
    assert.equal(body.visionLockMvpIsScopeReduction, false);
    assert.ok(body.visionLockCapabilities.includes("isolated-persistent-sandboxes"));
    assert.ok(body.visionLockCapabilities.includes("human-gated-side-effects"));
    assert.equal(body.workspaceCommandRun, true);
    assert.equal(body.workspaceSessionRun, true);
    assert.equal(body.vasReadinessChecked, true);
    assert.equal(body.onlineSurfacesChecked, true);
    assert.equal(body.dashboardAgentGitServiceProvisioningChecked, true);
    assert.equal(body.authRolesChecked, true);
    assert.equal(body.gatesChecked, true);
    assert.equal(body.reviewGateMetricsChecked, true);
    assert.ok(body.reviewGateMetricsReviewRequiredRuns >= 1);
    assert.equal(body.deploymentGateMetricsChecked, true);
    assert.ok(body.deploymentGateMetricsDeploymentRequiredRuns >= 1);
    assert.equal(body.policyEscalationChecked, true);
    assert.equal(body.sourceDefaultsChecked, true);
    assert.equal(body.sourceDefaultsRepo, "https://git.example/team/loom-smoke.git");
    assert.equal(body.sourceDefaultsBranch, "loom/smoke-source-defaults");
    assert.equal(body.sourceDefaultsBaseBranch, "origin/main");
    assert.equal(body.sourceDefaultsIssue, "team/loom-smoke#17");
    assert.equal(body.sourceDefaultsIssueUrl, "https://git.example/team/loom-smoke/issues/17");
    assert.equal(body.handoffEvidenceChecked, true);
    assert.equal(body.handoffSourceDefaultsChecked, true);
    assert.equal(body.handoffFollowupSourceDefaultsChecked, true);
    assert.equal(body.handoffFollowupRepo, "https://git.example/team/loom-smoke.git");
    assert.equal(body.handoffFollowupBranch, "loom/smoke-source-defaults");
    assert.equal(body.handoffFollowupBaseBranch, "origin/main");
    assert.equal(body.handoffFollowupIssue, "team/loom-smoke#17");
    assert.equal(body.handoffFollowupIssueUrl, "https://git.example/team/loom-smoke/issues/17");
    assert.equal(body.runScopedPullRequestDuringActiveRunChecked, true);
    assert.match(body.runScopedPullRequestDuringActiveRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.equal(body.runScopedPullRequestDuringActiveRunBranch, `${body.sourceDefaultsBranch}/${body.runScopedPullRequestDuringActiveRunId}`);
    assert.equal(body.runScopedFileWriteDuringActiveRunChecked, true);
    assert.match(body.runScopedFileWriteDuringActiveRunBlockedRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.notEqual(body.runScopedFileWriteDuringActiveRunBlockedRunId, body.runScopedPullRequestDuringActiveRunId);
    assert.equal(body.runScopedFileWriteDuringActiveRunAllowedRunId, body.runScopedPullRequestDuringActiveRunId);
    assert.equal(body.runScopedFileWriteDuringActiveRunPath, "loom-smoke-run-scoped-file.txt");
    assert.equal(body.runScopedFileWriteDuringActiveRunDenied, true);
    assert.equal(body.runControlsChecked, true);
    assert.equal(body.activeRunLeaseChecked, true);
    assert.equal(body.activeRunLeaseRunId, body.pauseResumeRunId);
    assert.equal(body.activeRunLeaseScope, "run");
    assert.equal(body.activeRunLeaseKey, `alice/smoke-platform/${body.pauseResumeRunId}`);
    assert.equal(body.multiAgentConcurrencyChecked, true);
    assert.equal(body.multiAgentConcurrencyIsolation, "run");
    assert.equal(body.multiAgentConcurrencyActiveRunLeaseChecked, true);
    assert.equal(body.multiAgentConcurrencyRunScopedFileWriteChecked, true);
    assert.equal(body.multiAgentConcurrencyRunScopedPrHandoffChecked, true);
    assert.equal(body.multiAgentConcurrencyBranch, body.runScopedPullRequestDuringActiveRunBranch);
    assert.equal(body.modelRunChecked, true);
    assert.equal(body.modelWarningMetricsChecked, true);
    assert.ok(body.modelWarningMetricsModelUsageWarningProjects >= 1);
    assert.equal(body.modelWarningQueueChecked, true);
    assert.equal(body.modelWarningQueueProject, "smoke-platform");
    assert.ok(body.modelWarningQueueWarningCount >= 1);
    assert.equal(body.modelWarningEscalationChecked, true);
    assert.equal(body.modelWarningEscalationSourceKind, "model_usage_warning");
    assert.equal(body.workspaceWarningMetricsChecked, true);
    assert.ok(body.workspaceWarningMetricsWorkspaceUsageWarningProjects >= 1);
    assert.equal(body.workspaceWarningQueueChecked, true);
    assert.equal(body.workspaceWarningQueueProject, "smoke-platform");
    assert.ok(body.workspaceWarningQueueWarningCount >= 1);
    assert.equal(body.workspaceWarningEscalationChecked, true);
    assert.equal(body.workspaceWarningEscalationSourceKind, "workspace_usage_warning");
    assert.equal(body.warningEscalationAuditChecked, true);
    assert.equal(body.giteaPrChecked, true);
    assert.equal(body.giteaCommentsChecked, true);
    assert.equal(body.giteaCommentsRunStatus, "passed");
    assert.equal(body.giteaCommentsRunReviewed, 1);
    assert.equal(body.controlPlaneCommentsWebhookChecked, true);
    assert.equal(body.controlPlaneCommentsWebhookRunStatus, "passed");
    assert.equal(body.controlPlaneCommentsWebhookSynced, 1);
    assert.equal(body.controlPlaneCommentsWebhookRunReviewed, 1);
    assert.equal(body.backupManifestChecked, true);
    assert.equal(body.backupManifestTenant, "alice");
    assert.equal(body.backupManifestProjectCount, 1);
    assert.ok(body.backupManifestRunCount >= 1);
    assert.ok(body.backupManifestAuditEventCount >= 1);
    assert.deepEqual(body.backupManifestControlPlaneBoundary, [...CONTROL_PLANE_PROVIDER_BOUNDARY]);
    assert.equal(body.backupManifestSecretScrubbed, true);
    assert.equal(body.backupRestoreDryRunChecked, true);
    assert.equal(body.backupRestoreDryRunValid, true);
    assert.equal(body.backupRestoreDryRunApplied, false);
    assert.equal(body.backupRestoreDryRunSourceProvider, "gitea-forgejo");
    assert.equal(body.backupRestoreDryRunTargetProvider, "agent-git-service");
    assert.equal(body.backupRestoreDryRunProjectCount, 1);
    assert.deepEqual(body.backupRestoreDryRunProjectNames, ["smoke-platform"]);
    assert.ok(body.backupRestoreDryRunRunCount >= 1);
    assert.equal(body.backupRestoreDryRunCutoverReady, false);
    assert.equal(body.backupRestoreDryRunCutoverStage, "tenant-default-cutover");
    assert.equal(body.backupRestoreDryRunCutoverTargetProvider, "agent-git-service");
    assert.equal(body.backupRestoreDryRunAgentGitServiceProjectAgentsOk, false);
    assert.equal(body.backupRestoreDryRunAgentGitServiceProjectAgentsProjectCount, 1);
    assert.equal(body.backupRestoreDryRunAgentGitServiceProjectAgentsProvisionedProjectCount, 0);
    assert.equal(body.backupRestoreDryRunAgentGitServiceProjectAgentsSecretRootConfigured, false);
    assert.deepEqual(body.backupRestoreDryRunAgentGitServiceProjectAgentsMissingProjects, ["alice/smoke-platform"]);
    assert.equal(body.backupRestoreDryRunAuditChecked, true);
    assert.equal(body.coderChecked, true);
    assert.equal(body.brainSignalChecked, true);
    assert.equal(body.brainRunIngestChecked, true);
    assert.equal(body.brainSignalFeedChecked, true);
    assert.ok(body.brainSignalFeedCount >= 2);
    assert.equal(body.vasBrainLearningChecked, true);
    assert.equal(body.vasBrainLearningSource, "vas_learning");
    assert.equal(body.vasBrainLearningCaseId, "loom-smoke-gate");
    assert.match(body.vasBrainLearningRunId, /^\d{4}-\d{2}-\d{2}T.+Z-[0-9a-f]{8}$/);
    assert.equal(body.vasBrainLearningCount, 1);
    assert.equal(body.vasBrainLearningSkillCount, 2);
    assert.equal(body.vasBrainLearningFeedChecked, true);
    assert.equal(body.isolationTenant, "bob");
    assert.equal(body.isolationPassed, true);
    assert.equal(body.coderProjectExecutorKind, "coder");
    assert.equal(body.coderRunExecutorKind, "coder");
    assert.equal(modelCalls, 2);
    assert.equal(pullRequests.length, 1);
    assert.equal(workspacePullRequests.length, 1);
    assert.equal(workspacePullRequests[0]?.runId, body.runScopedPullRequestDuringActiveRunId);
    assert.equal(workspacePullRequests[0]?.branch, body.runScopedPullRequestDuringActiveRunBranch);
    assert.equal(workspacePullRequests[0]?.push, false);
    assert.deepEqual(requestedIssues, ["team/smoke-comments#17"]);
    assert.ok(completedRunSignals.length >= 1);
    assert.equal(brainSignals.length, 2);
    assert.ok(brainSignals.some((signal) => {
      if (signal === null || typeof signal !== "object") return false;
      const record = signal as Record<string, unknown>;
      return record.project === "smoke-platform" &&
        record.runId === body.vasBrainLearningRunId &&
        record.status === "reviewed" &&
        record.outcome === "pass" &&
        Array.isArray(record.skills) &&
        record.skills.length === 2 &&
        typeof record.notes === "string" &&
        record.notes.includes("VAS learning approved for case loom-smoke-gate");
    }));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      modelServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness rehearsal runs a self-contained platform readiness smoke", async () => {
  const workspaceRoot = await tempDir("loom-cli-rehearsal-platform");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "rehearsal",
      "--workspace-root",
      workspaceRoot,
      "--project",
      "rehearsal-platform",
    ],
    {
      cwd: process.cwd(),
      reject: false,
      timeout: 75_000,
    },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.includes("rehearsal-model-key"), false);
  assert.equal(result.stdout.includes("rehearsal-webhook-secret"), false);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.profile, "platform-readiness");
  assert.equal(body.workspaceRoot, workspaceRoot);
  assert.equal(body.tenant, "alice");
  assert.equal(body.isolationTenant, "bob");
  assert.equal(body.project, "rehearsal-platform");
  assert.equal(body.modelCalls, 2);
  assert.equal(body.pullRequestCount, 1);
  assert.equal(body.workspacePullRequestCount, 1);
  assert.ok(body.brainRunIngestCount >= 1);
  assert.equal(body.brainSignalCount, 2);
  assert.equal(body.cutoverReport.ok, true);
  assert.deepEqual(body.cutoverReport.missing, []);
  assert.equal(body.cutoverReport.serverReadinessOk, true);
  assert.equal(body.cutoverReport.tenantReadinessOk, true);
  assert.equal(body.cutoverReport.serverVisionLockOk, true);
  assert.equal(body.cutoverReport.tenantVisionLockOk, true);
  assert.equal(body.cutoverReport.serverGoldenPathOk, true);
  assert.equal(body.cutoverReport.tenantGoldenPathOk, true);
  assert.equal(body.smoke.status, "passed");
  assert.equal(body.smoke.onlineSandboxGoldenPathChecked, true);
  assert.ok(body.smoke.onlineSandboxGoldenPathCapabilities.includes("multi-agent-concurrency"));
  assert.equal(body.smoke.serverReadinessOk, true);
  assert.equal(body.smoke.tenantReadinessOk, true);
  assert.equal(body.smoke.serverRunWorkspaceIsolation, "run");
  assert.equal(body.smoke.tenantRunWorkspaceIsolation, "run");
  assert.equal(body.smoke.workspaceContextKind, "coder");
  assert.equal(body.smoke.multiAgentConcurrencyChecked, true);
  assert.equal(body.smoke.modelRunChecked, true);
  assert.equal(body.smoke.backupRestoreDryRunChecked, true);
  assert.equal(body.smoke.controlPlaneCommentsWebhookChecked, true);
  assert.equal(body.smoke.coderChecked, true);
  assert.equal(body.smoke.isolationPassed, true);
});

test("loom harness rehearsal can prove cross-server concurrency", async () => {
  const workspaceRoot = await tempDir("loom-cli-rehearsal-platform-peer");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "rehearsal",
      "--workspace-root",
      workspaceRoot,
      "--project",
      "rehearsal-platform-peer",
      "--peer-server",
    ],
    {
      cwd: process.cwd(),
      reject: false,
      timeout: 180_000,
    },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.match(body.peerUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(body.smoke.peerUrl, body.peerUrl);
  assert.equal(body.smoke.runControlsChecked, true);
  assert.equal(body.smoke.crossServerActiveRunLeaseChecked, true);
  assert.equal(body.smoke.crossServerPauseChecked, true);
  assert.equal(body.smoke.crossServerCancelChecked, true);
  assert.equal(body.smoke.crossServerIdempotentCreateChecked, true);
  assert.equal(body.smoke.multiAgentConcurrencyChecked, true);
  assert.equal(body.smoke.multiAgentConcurrencyCrossServerChecked, true);
  assert.equal(body.smoke.multiAgentConcurrencyCrossServerIdempotencyChecked, true);
});

test("loom harness smoke platform readiness profile rejects missing integrations before running checks", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-platform-profile-missing");
  const server = createHarnessHttpServer({
    workspaceRoot,
    profile: "platform-readiness",
    allowUnsafeLocalExecutor: true,
    allowedTools: onlineSandboxTools(),
    tenantApiKeys: {
      alice: [
        { token: "admin-key", actor: "ops", role: "admin" },
        { token: "dev-key", actor: "eno", role: "developer" },
        { token: "viewer-key", actor: "auditor", role: "viewer" },
      ],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-platform-missing",
        "--template",
        "vas-lite",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--viewer-token-env",
        "LOOM_TEST_VIEWER_TOKEN",
        "--admin-token-env",
        "LOOM_TEST_ADMIN_TOKEN",
        "--isolation-tenant",
        "bob",
        "--profile",
        "platform-readiness",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOOM_TEST_TENANT_TOKEN: "dev-key",
          LOOM_TEST_VIEWER_TOKEN: "viewer-key",
          LOOM_TEST_ADMIN_TOKEN: "admin-key",
        },
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_SERVER_READINESS_MISSING/);
    assert.match(result.stderr, /"scope":"server"/);
    assert.match(result.stderr, /"profile":"platform-readiness"/);
    assert.match(result.stderr, /server profile platform-readiness missing readiness/);
    assert.match(result.stderr, /model/);
    assert.match(result.stderr, /controlPlanePullRequest/);
    assert.match(result.stderr, /controlPlaneMerge/);
    assert.match(result.stderr, /controlPlaneIssueComments/);
    assert.match(result.stderr, /controlPlaneIssueUrl/);
    assert.match(result.stderr, /controlPlaneSignedWebhooks/);
    assert.match(result.stderr, /controlPlaneGitTransport/);
    assert.match(result.stderr, /controlPlaneAgentIdentity/);
    assert.match(result.stderr, /brainSignalIngest/);
    assert.match(result.stderr, /coderExecutor/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke reports agent-git-service project-agent readiness diagnostics", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.end(JSON.stringify(smokeProbeResponse(req.url)));
      return;
    }
    if (req.url === "/metrics") {
      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.end(smokeMetricsResponse());
      return;
    }
    if (req.url === "/status") {
      res.end(JSON.stringify({
        server: {
          profile: "platform-readiness",
          runWorkspaceIsolation: "run",
          controlPlane: expectedControlPlane("agent-git-service"),
        },
        policy: { allowedTools: onlineSandboxTools() },
        readiness: {
          profile: "platform-readiness",
          ok: false,
          missing: ["agentGitServiceProjectAgents"],
          checks: {
            agentGitServiceProjectAgents: {
              required: true,
              ok: false,
              provider: "agent-git-service",
              tenantCount: 1,
              projectCount: 2,
              provisionedProjectCount: 1,
              secretRootConfigured: true,
              secretStoredProjectCount: 0,
              missingProjects: ["alice/proj-a"],
              missingSecretProjects: ["alice/proj-b"],
            },
          },
        },
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: false,
          capabilities: visionLockCapabilities(),
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-ags-project-agents",
        "--template",
        "empty",
        "--isolation-tenant",
        "bob",
        "--profile",
        "platform-readiness",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_SERVER_READINESS_MISSING/);
    assert.match(result.stderr, /"missing":\["agentGitServiceProjectAgents"\]/);
    assert.match(result.stderr, /"agentGitServiceProjectAgentsMissingProjects":\["alice\/proj-a"\]/);
    assert.match(result.stderr, /"agentGitServiceProjectAgentsMissingSecretProjects":\["alice\/proj-b"\]/);
    assert.match(result.stderr, /server profile platform-readiness missing readiness: agentGitServiceProjectAgents/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke online sandbox profile rejects a server without that profile", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-profile-mismatch");
  const server = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    allowedTools: onlineSandboxTools(),
    tenantApiKeys: {
      alice: [
        { token: "admin-key", actor: "ops", role: "admin" },
        { token: "dev-key", actor: "eno", role: "developer" },
        { token: "viewer-key", actor: "auditor", role: "viewer" },
      ],
      bob: [{ token: "bob-key", actor: "bob", role: "developer" }],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-mismatch",
        "--template",
        "vas-lite",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--viewer-token-env",
        "LOOM_TEST_VIEWER_TOKEN",
        "--admin-token-env",
        "LOOM_TEST_ADMIN_TOKEN",
        "--isolation-tenant",
        "bob",
        "--profile",
        "online-sandbox",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_TENANT_TOKEN: "dev-key", LOOM_TEST_VIEWER_TOKEN: "viewer-key", LOOM_TEST_ADMIN_TOKEN: "admin-key" },
        reject: false,
        timeout: 15_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_SERVER_PROFILE_MISMATCH/);
    assert.match(result.stderr, /"expectedProfile":"online-sandbox"/);
    assert.match(result.stderr, /server profile/);
    assert.match(result.stderr, /online-sandbox/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke online sandbox profile rejects missing server tools", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-profile-tool-mismatch");
  const server = createHarnessHttpServer({
    workspaceRoot,
    profile: "online-sandbox",
    allowUnsafeLocalExecutor: true,
    allowedTools: ["file.read", "file.write", "git.diff", "git.commit", "verify.run"],
    tenantApiKeys: {
      alice: [
        { token: "admin-key", actor: "ops", role: "admin" },
        { token: "dev-key", actor: "eno", role: "developer" },
        { token: "viewer-key", actor: "auditor", role: "viewer" },
      ],
      bob: [{ token: "bob-key", actor: "bob", role: "developer" }],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-tool-mismatch",
        "--template",
        "vas-lite",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--viewer-token-env",
        "LOOM_TEST_VIEWER_TOKEN",
        "--admin-token-env",
        "LOOM_TEST_ADMIN_TOKEN",
        "--isolation-tenant",
        "bob",
        "--profile",
        "online-sandbox",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_TENANT_TOKEN: "dev-key", LOOM_TEST_VIEWER_TOKEN: "viewer-key", LOOM_TEST_ADMIN_TOKEN: "admin-key" },
        reject: false,
        timeout: 15_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_SERVER_TOOLS_MISSING/);
    assert.match(result.stderr, /"scope":"server"/);
    assert.match(result.stderr, /"profile":"online-sandbox"/);
    assert.match(result.stderr, /"missingTools":\["shell\.exec"\]/);
    assert.match(result.stderr, /server profile online-sandbox/);
    assert.match(result.stderr, /missing required tools: shell\.exec/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke online sandbox profile rejects missing vision lock capabilities", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.end(JSON.stringify(smokeProbeResponse(req.url)));
      return;
    }
    if (req.url === "/metrics") {
      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.end(smokeMetricsResponse());
      return;
    }
    if (req.url === "/status") {
      res.end(JSON.stringify({
        server: onlineSandboxServerRecord(),
        policy: { allowedTools: onlineSandboxTools() },
        readiness: onlineSandboxReadiness(),
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: false,
          capabilities: [
            "multi-user-tenants",
            "isolated-persistent-sandboxes",
            "browser-control-plane",
            "gitea-forgejo-truth-layer",
            "litellm-model-gateway",
            "event-sourced-harness-loop",
            "verification-gated-finish",
            "brain-skill-evolution",
          ],
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-missing-vision-lock",
        "--template",
        "vas-lite",
        "--isolation-tenant",
        "bob",
        "--profile",
        "online-sandbox",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_VISION_LOCK_CAPABILITIES_MISSING/);
    assert.match(result.stderr, /"scope":"server"/);
    assert.match(result.stderr, /"profile":"online-sandbox"/);
    assert.match(result.stderr, /"missingCapabilities":\["human-gated-side-effects"\]/);
    assert.match(result.stderr, /missing vision lock capabilities: human-gated-side-effects/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke online sandbox profile rejects unexpected vision lock targets", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.end(JSON.stringify(smokeProbeResponse(req.url)));
      return;
    }
    if (req.url === "/metrics") {
      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.end(smokeMetricsResponse());
      return;
    }
    if (req.url === "/status") {
      res.end(JSON.stringify({
        server: onlineSandboxServerRecord(),
        policy: { allowedTools: onlineSandboxTools() },
        readiness: onlineSandboxReadiness(),
        visionLock: {
          target: "single-user scratchpad",
          mvpIsScopeReduction: false,
          capabilities: [
            "multi-user-tenants",
            "isolated-persistent-sandboxes",
            "browser-control-plane",
            "gitea-forgejo-truth-layer",
            "litellm-model-gateway",
            "event-sourced-harness-loop",
            "verification-gated-finish",
            "brain-skill-evolution",
            "human-gated-side-effects",
          ],
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-unexpected-vision-lock-target",
        "--template",
        "vas-lite",
        "--isolation-tenant",
        "bob",
        "--profile",
        "online-sandbox",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_VISION_LOCK_TARGET_MISMATCH/);
    assert.match(result.stderr, /"scope":"server"/);
    assert.match(result.stderr, /"profile":"online-sandbox"/);
    assert.match(result.stderr, /"actualTarget":"single-user scratchpad"/);
    assert.match(result.stderr, /reported an unexpected vision lock target/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke online sandbox profile rejects MVP scope reductions", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.end(JSON.stringify(smokeProbeResponse(req.url)));
      return;
    }
    if (req.url === "/metrics") {
      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.end(smokeMetricsResponse());
      return;
    }
    if (req.url === "/status") {
      res.end(JSON.stringify({
        server: onlineSandboxServerRecord(),
        policy: { allowedTools: onlineSandboxTools() },
        readiness: onlineSandboxReadiness(),
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: true,
          capabilities: [
            "multi-user-tenants",
            "isolated-persistent-sandboxes",
            "browser-control-plane",
            "gitea-forgejo-truth-layer",
            "litellm-model-gateway",
            "event-sourced-harness-loop",
            "verification-gated-finish",
            "brain-skill-evolution",
            "human-gated-side-effects",
          ],
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-vision-lock-scope-reduction",
        "--template",
        "vas-lite",
        "--isolation-tenant",
        "bob",
        "--profile",
        "online-sandbox",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_VISION_LOCK_SCOPE_REDUCTION/);
    assert.match(result.stderr, /"scope":"server"/);
    assert.match(result.stderr, /"profile":"online-sandbox"/);
    assert.match(result.stderr, /"mvpIsScopeReduction":true/);
    assert.match(result.stderr, /reported MVP as a scope reduction/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke online sandbox profile reports invalid server profile schema arrays", async () => {
  const cases = [
    {
      status: onlineSandboxServerStatus({ policy: { allowedTools: ["file.read", 42, "file.write", "shell.exec", "git.diff", "git.commit", "verify.run"] } }),
      code: /SMOKE_SERVER_TOOLS_INVALID/,
      field: /"field":"policy\.allowedTools"/,
      message: /server status policy allowedTools must be strings/,
    },
    {
      status: onlineSandboxServerStatus({ readiness: { profile: "online-sandbox", ok: false, missing: ["tenantAuth", 42] } }),
      code: /SMOKE_SERVER_READINESS_INVALID/,
      field: /"field":"readiness\.missing"/,
      message: /server status readiness missing must be strings/,
    },
    {
      status: onlineSandboxServerStatus({
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: false,
          capabilities: ["multi-user-tenants", 42, ...visionLockCapabilities().slice(1)],
        },
      }),
      code: /SMOKE_VISION_LOCK_CAPABILITIES_INVALID/,
      field: /"field":"visionLock\.capabilities"/,
      message: /server status visionLock capabilities must be strings/,
    },
  ];

  for (const schemaCase of cases) {
    const result = await runOnlineSandboxProfileSmokeAgainstStatus(schemaCase.status);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, schemaCase.code);
    assert.match(result.stderr, /"scope":"server"/);
    assert.match(result.stderr, /"profile":"online-sandbox"/);
    assert.match(result.stderr, schemaCase.field);
    assert.match(result.stderr, /"invalidItems":\[\{"index":1,"type":"number"\}/);
    assert.match(result.stderr, schemaCase.message);
  }
});

test("loom harness smoke online sandbox profile reports invalid tenant profile schema arrays", async () => {
  const cases = [
    {
      tenantStatus: onlineSandboxTenantStatus({ policy: { allowedTools: ["file.read", 42, "file.write", "shell.exec", "git.diff", "git.commit", "verify.run"] } }),
      code: /SMOKE_TENANT_TOOLS_INVALID/,
      field: /"field":"policy\.allowedTools"/,
      message: /tenant status policy allowedTools must be strings/,
    },
    {
      tenantStatus: onlineSandboxTenantStatus({ readiness: { profile: "online-sandbox", ok: false, missing: ["tenantAuth", 42] } }),
      code: /SMOKE_TENANT_READINESS_INVALID/,
      field: /"field":"readiness\.missing"/,
      message: /tenant status readiness missing must be strings/,
    },
    {
      tenantStatus: onlineSandboxTenantStatus({
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: false,
          capabilities: ["multi-user-tenants", 42, ...visionLockCapabilities().slice(1)],
        },
      }),
      code: /SMOKE_TENANT_VISION_LOCK_CAPABILITIES_INVALID/,
      field: /"field":"visionLock\.capabilities"/,
      message: /tenant status visionLock capabilities must be strings/,
    },
  ];

  for (const schemaCase of cases) {
    const result = await runOnlineSandboxProfileSmokeAgainstStatus(onlineSandboxServerStatus(), schemaCase.tenantStatus);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, schemaCase.code);
    assert.match(result.stderr, /"scope":"tenant"/);
    assert.match(result.stderr, /"tenant":"alice"/);
    assert.match(result.stderr, /"profile":"online-sandbox"/);
    assert.match(result.stderr, schemaCase.field);
    assert.match(result.stderr, /"invalidItems":\[\{"index":1,"type":"number"\}/);
    assert.match(result.stderr, schemaCase.message);
  }
});

test("loom harness smoke online sandbox profile rejects unknown control-plane providers", async () => {
  const result = await runOnlineSandboxProfileSmokeAgainstStatus(onlineSandboxServerStatus({
    server: {
      profile: "online-sandbox",
      controlPlane: {
        provider: "unknown-provider",
        boundary: [...CONTROL_PLANE_PROVIDER_BOUNDARY],
      },
    },
  }));

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /SMOKE_CONTROL_PLANE_PROVIDER_UNSUPPORTED/);
  assert.match(result.stderr, /"scope":"server"/);
  assert.match(result.stderr, /"provider":"unknown-provider"/);
  assert.doesNotMatch(result.stderr, /candidateStatus/);
  assert.match(result.stderr, /unsupported control-plane provider unknown-provider/);
});

test("loom harness smoke online sandbox profile accepts agent-git-service control-plane provider status", async () => {
  const result = await runOnlineSandboxProfileSmokeAgainstStatus(
    onlineSandboxServerStatus({
      server: {
        profile: "online-sandbox",
        controlPlane: expectedControlPlane("agent-git-service"),
      },
    }),
    {
      server: {
        runWorkspaceIsolation: "project",
        concurrencyAdmission: concurrencyAdmissionFixture(),
        controlPlane: expectedControlPlane("agent-git-service"),
      },
      policy: { allowedTools: onlineSandboxTools() },
      readiness: onlineSandboxReadiness(),
    },
  );

  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.stderr, /SMOKE_CONTROL_PLANE_PROVIDER_UNSUPPORTED/);
  assert.match(result.stderr, /SMOKE_TENANT_VISION_LOCK_MISSING/);
  assert.match(result.stderr, /"scope":"tenant"/);
});

test("loom harness smoke online sandbox profile rejects tenant control-plane provider drift", async () => {
  const result = await runOnlineSandboxProfileSmokeAgainstStatus(
    onlineSandboxServerStatus({
      server: {
        profile: "online-sandbox",
        controlPlane: expectedControlPlane("agent-git-service"),
      },
    }),
    onlineSandboxTenantStatus({
      server: {
        runWorkspaceIsolation: "project",
        controlPlane: expectedControlPlane("gitea-forgejo"),
      },
    }),
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /SMOKE_TENANT_CONTROL_PLANE_PROVIDER_MISMATCH/);
  assert.match(result.stderr, /"serverProvider":"agent-git-service"/);
  assert.match(result.stderr, /"tenantProvider":"gitea-forgejo"/);
});

test("loom harness smoke online sandbox profile reports tenant vision lock drift with diagnostics", async () => {
  const cases = [
    {
      tenantStatus: {
        server: {
          runWorkspaceIsolation: "project",
          concurrencyAdmission: concurrencyAdmissionFixture(),
          controlPlane: expectedControlPlane(),
        },
        policy: { allowedTools: onlineSandboxTools() },
        readiness: onlineSandboxReadiness(),
      },
      code: /SMOKE_TENANT_VISION_LOCK_MISSING/,
      detail: /"missing":\["visionLock"\]/,
      message: /tenant status did not include visionLock/,
    },
    {
      tenantStatus: onlineSandboxTenantStatus({
        visionLock: {
          target: "single-user scratchpad",
          mvpIsScopeReduction: false,
          capabilities: visionLockCapabilities(),
        },
      }),
      code: /SMOKE_TENANT_VISION_LOCK_TARGET_MISMATCH/,
      detail: /"actualTarget":"single-user scratchpad"/,
      message: /tenant alice profile online-sandbox reported an unexpected vision lock target/,
    },
    {
      tenantStatus: onlineSandboxTenantStatus({
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: true,
          capabilities: visionLockCapabilities(),
        },
      }),
      code: /SMOKE_TENANT_VISION_LOCK_SCOPE_REDUCTION/,
      detail: /"mvpIsScopeReduction":true/,
      message: /tenant alice profile online-sandbox reported MVP as a scope reduction/,
    },
    {
      tenantStatus: onlineSandboxTenantStatus({
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: false,
          capabilities: visionLockCapabilities().filter((capability) => capability !== "human-gated-side-effects"),
        },
      }),
      code: /SMOKE_TENANT_VISION_LOCK_CAPABILITIES_MISSING/,
      detail: /"missingCapabilities":\["human-gated-side-effects"\]/,
      message: /tenant alice profile online-sandbox missing vision lock capabilities: human-gated-side-effects/,
    },
  ];

  for (const driftCase of cases) {
    const result = await runOnlineSandboxProfileSmokeAgainstStatus(onlineSandboxServerStatus(), driftCase.tenantStatus);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, driftCase.code);
    assert.match(result.stderr, /"scope":"tenant"/);
    assert.match(result.stderr, /"tenant":"alice"/);
    assert.match(result.stderr, /"profile":"online-sandbox"/);
    assert.match(result.stderr, driftCase.detail);
    assert.match(result.stderr, driftCase.message);
  }
});

test("loom harness smoke online sandbox profile reports golden path drift with diagnostics", async () => {
  const cases = [
    {
      serverStatus: onlineSandboxServerStatus({
        readiness: { profile: "online-sandbox", ok: true, missing: [] },
      }),
      tenantStatus: onlineSandboxTenantStatus(),
      code: /SMOKE_SERVER_GOLDEN_PATH_MISSING/,
      scope: /"scope":"server"/,
      detail: /"missing":\["readiness\.goldenPath"\]/,
      message: /server profile online-sandbox did not report readiness golden path/,
    },
    {
      serverStatus: onlineSandboxServerStatus({
        readiness: {
          profile: "online-sandbox",
          ok: true,
          missing: [],
          goldenPath: {
            required: true,
            ok: false,
            capabilities: onlineSandboxGoldenPathCapabilities().filter((capability) => capability !== "handoff-followup"),
            missingCapabilities: ["handoff-followup"],
          },
        },
      }),
      tenantStatus: onlineSandboxTenantStatus(),
      code: /SMOKE_SERVER_GOLDEN_PATH_MISSING/,
      scope: /"scope":"server"/,
      detail: /"missingCapabilities":\["handoff-followup"\]/,
      message: /server profile online-sandbox missing golden path capabilities: handoff-followup/,
    },
    {
      serverStatus: onlineSandboxServerStatus(),
      tenantStatus: onlineSandboxTenantStatus({
        readiness: {
          profile: "online-sandbox",
          ok: true,
          missing: [],
          goldenPath: {
            required: true,
            ok: false,
            capabilities: onlineSandboxGoldenPathCapabilities().filter((capability) => capability !== "multi-user-isolation"),
            missingCapabilities: ["multi-user-isolation"],
          },
        },
      }),
      code: /SMOKE_TENANT_GOLDEN_PATH_MISSING/,
      scope: /"scope":"tenant"/,
      detail: /"missingCapabilities":\["multi-user-isolation"\]/,
      message: /tenant alice profile online-sandbox missing golden path capabilities: multi-user-isolation/,
    },
  ];

  for (const driftCase of cases) {
    const result = await runOnlineSandboxProfileSmokeAgainstStatus(driftCase.serverStatus, driftCase.tenantStatus);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, driftCase.code);
    assert.match(result.stderr, driftCase.scope);
    assert.match(result.stderr, /"profile":"online-sandbox"/);
    assert.match(result.stderr, driftCase.detail);
    assert.match(result.stderr, driftCase.message);
  }
});

test("loom harness smoke online sandbox profile rejects missing tenant auth", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-profile-missing-auth");
  const executorHomeRoot = join(workspaceRoot, ".homes");
  const server = createHarnessHttpServer({
    workspaceRoot,
    profile: "online-sandbox",
    executorKind: "docker",
    executorHomeRoot,
    allowUnsafeLocalExecutor: true,
    allowedTools: onlineSandboxTools(),
    createExecutor: (cwd, context) => {
      const executor = createLocalExecutor({ cwd });
      return {
        ...executor,
        describeWorkspace(): Record<string, string> {
          return {
            kind: "docker",
            cwd,
            containerCwd: "/workspace",
            home: join(executorHomeRoot, context.tenant),
            containerHome: "/home/dev",
          };
        },
      };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-missing-auth",
        "--template",
        "vas-lite",
        "--isolation-tenant",
        "bob",
        "--profile",
        "online-sandbox",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        reject: false,
        timeout: 15_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /server profile online-sandbox missing readiness/);
    assert.match(result.stderr, /tenantAuth/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke online sandbox profile rejects incomplete tenant roles", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-profile-incomplete-auth-roles");
  const executorHomeRoot = join(workspaceRoot, ".homes");
  const server = createHarnessHttpServer({
    workspaceRoot,
    profile: "online-sandbox",
    executorKind: "docker",
    executorHomeRoot,
    allowUnsafeLocalExecutor: true,
    allowedTools: onlineSandboxTools(),
    tenantApiKeys: {
      alice: [{ token: "admin-key", actor: "ops", role: "admin" }],
    },
    createExecutor: (cwd, context) => {
      const executor = createLocalExecutor({ cwd });
      return {
        ...executor,
        describeWorkspace(): Record<string, string> {
          return {
            kind: "docker",
            cwd,
            containerCwd: "/workspace",
            home: join(executorHomeRoot, context.tenant),
            containerHome: "/home/dev",
          };
        },
      };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-incomplete-auth-roles",
        "--template",
        "vas-lite",
        "--admin-token-env",
        "LOOM_TEST_ADMIN_TOKEN",
        "--isolation-tenant",
        "bob",
        "--profile",
        "online-sandbox",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_ADMIN_TOKEN: "admin-key" },
        reject: false,
        timeout: 15_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /server profile online-sandbox missing readiness/);
    assert.match(result.stderr, /tenantAuth/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke online sandbox profile rejects missing tenant tools", async () => {
  const workspaceRoot = await tempDir("loom-cli-smoke-profile-tenant-tool-mismatch");
  await mkdir(join(workspaceRoot, "alice", ".loom"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "alice", ".loom", "policy.json"),
    JSON.stringify({
      schemaVersion: 1,
      allowedTools: ["file.read", "file.write", "git.diff", "git.commit", "verify.run"],
    }),
    "utf8",
  );
  const server = createHarnessHttpServer({
    workspaceRoot,
    profile: "online-sandbox",
    executorKind: "docker",
    executorHomeRoot: join(workspaceRoot, ".homes"),
    allowUnsafeLocalExecutor: true,
    allowedTools: onlineSandboxTools(),
    tenantApiKeys: {
      alice: [
        { token: "admin-key", actor: "ops", role: "admin" },
        { token: "dev-key", actor: "eno", role: "developer" },
        { token: "viewer-key", actor: "auditor", role: "viewer" },
      ],
      bob: [{ token: "bob-key", actor: "bob", role: "developer" }],
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-tenant-tool-mismatch",
        "--template",
        "vas-lite",
        "--token-env",
        "LOOM_TEST_TENANT_TOKEN",
        "--viewer-token-env",
        "LOOM_TEST_VIEWER_TOKEN",
        "--admin-token-env",
        "LOOM_TEST_ADMIN_TOKEN",
        "--isolation-tenant",
        "bob",
        "--profile",
        "online-sandbox",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_TENANT_TOKEN: "dev-key", LOOM_TEST_VIEWER_TOKEN: "viewer-key", LOOM_TEST_ADMIN_TOKEN: "admin-key" },
        reject: false,
        timeout: 15_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_TENANT_TOOLS_MISSING/);
    assert.match(result.stderr, /"scope":"tenant"/);
    assert.match(result.stderr, /"tenant":"alice"/);
    assert.match(result.stderr, /"missingTools":\["shell\.exec"\]/);
    assert.match(result.stderr, /tenant alice profile online-sandbox/);
    assert.match(result.stderr, /missing required tools: shell\.exec/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness smoke online sandbox profile rejects missing tenant readiness", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.end(JSON.stringify(smokeProbeResponse(req.url)));
      return;
    }
    if (req.url === "/metrics") {
      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.end(smokeMetricsResponse());
      return;
    }
    if (req.url === "/status") {
      res.end(JSON.stringify({
        server: onlineSandboxServerRecord(),
        policy: { allowedTools: onlineSandboxTools() },
        readiness: onlineSandboxReadiness(),
        visionLock: {
          target: HARNESS_VISION_LOCK.target,
          mvpIsScopeReduction: false,
          capabilities: [
            "multi-user-tenants",
            "isolated-persistent-sandboxes",
            "browser-control-plane",
            "gitea-forgejo-truth-layer",
            "litellm-model-gateway",
            "event-sourced-harness-loop",
            "verification-gated-finish",
            "brain-skill-evolution",
            "human-gated-side-effects",
          ],
        },
      }));
      return;
    }
    if (req.url === "/tenants/alice/status") {
      res.end(JSON.stringify({
        server: {
          runWorkspaceIsolation: "project",
          concurrencyAdmission: concurrencyAdmissionFixture(),
          controlPlane: expectedControlPlane(),
        },
        policy: { allowedTools: onlineSandboxTools() },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "smoke",
        "--url",
        `http://127.0.0.1:${address.port}`,
        "--tenant",
        "alice",
        "--project",
        "smoke-missing-tenant-readiness",
        "--template",
        "vas-lite",
        "--isolation-tenant",
        "bob",
        "--profile",
        "online-sandbox",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        reject: false,
        timeout: 10_000,
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /SMOKE_TENANT_READINESS_MISSING/);
    assert.match(result.stderr, /"scope":"tenant"/);
    assert.match(result.stderr, /"tenant":"alice"/);
    assert.match(result.stderr, /tenant status did not include readiness/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loom harness serve rejects authenticated local executor without unsafe opt-in", async () => {
  const workspaceRoot = await tempDir("loom-cli-serve-auth-local-executor");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "serve",
      "--workspace-root",
      workspaceRoot,
      "--tenant-key",
      "alice=dev-secret:eno:developer",
    ],
    { cwd: process.cwd(), reject: false },
  );

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--executor local is not isolated/);
  assert.match(result.stderr, /--allow-unsafe-local-executor/);
});

test("loom harness serve rejects policy-backed tenant auth with local executor without unsafe opt-in", async () => {
  const workspaceRoot = await tempDir("loom-cli-serve-policy-auth-local-executor");
  await mkdir(join(workspaceRoot, "alice", ".loom"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "alice", ".loom", "policy.json"),
    JSON.stringify({
      schemaVersion: 1,
      apiKeys: [{ token: "policy-dev-secret", actor: "eno", role: "developer" }],
    }),
    "utf8",
  );

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "serve",
      "--workspace-root",
      workspaceRoot,
    ],
    { cwd: process.cwd(), reject: false, timeout: 3000 },
  );

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--executor local is not isolated/);
  assert.match(result.stderr, /tenant authentication is configured/);
  assert.doesNotMatch(result.stderr, /policy-dev-secret/);
  assert.match(result.stderr, /--allow-unsafe-local-executor/);
});

test("loom harness serve online sandbox profile exposes the required tool allowlist", async () => {
  const workspaceRoot = await tempDir("loom-cli-serve-online-sandbox-profile");
  const result = await execa(
    process.execPath,
    [
      "dist/index.js",
      "harness",
      "serve",
      "--workspace-root",
      workspaceRoot,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--profile",
      "online-sandbox",
      "--allow-unsafe-local-executor",
    ],
    { cwd: process.cwd(), reject: false, timeout: 5000 },
  );

  const body = JSON.parse(result.stdout);
  assert.equal(body.profile, "online-sandbox");
  assert.deepEqual(body.allowedTools, ["file.read", "file.write", "git.diff", "git.commit", "verify.run", "shell.exec"]);
});

test("loom harness serve online sandbox profile keeps the local executor safety guard", async () => {
  const workspaceRoot = await tempDir("loom-cli-serve-online-sandbox-profile-local-guard");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "serve",
      "--workspace-root",
      workspaceRoot,
      "--profile",
      "online-sandbox",
      "--tenant-key",
      "alice=dev-secret:eno:developer",
    ],
    { cwd: process.cwd(), reject: false },
  );

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--executor local is not isolated/);
  assert.match(result.stderr, /shell\.exec is allowed/);
  assert.match(result.stderr, /--allow-unsafe-local-executor/);
});

test("loom harness serve rejects unsafe tenant names in CLI auth flags", async () => {
  for (const [flag, value] of [
    ["--tenant-token", "../alice=secret"],
    ["--tenant-key", "-alice=secret:eno:developer"],
    ["--tenant-model-key", "alice/dev=LOOM_ALICE_MODEL_KEY"],
  ]) {
    const workspaceRoot = await tempDir("loom-cli-serve-unsafe-tenant-flag");
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "serve",
        "--workspace-root",
        workspaceRoot,
        "--executor",
        "docker",
        "--executor-image",
        "loom-workspace:dev",
        flag,
        value,
      ],
      { cwd: process.cwd(), reject: false },
    );

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /tenant name must match/);
  }
});

test("loom harness serve rejects externally bound local executor without unsafe opt-in", async () => {
  const workspaceRoot = await tempDir("loom-cli-serve-public-local-executor");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "serve",
      "--workspace-root",
      workspaceRoot,
      "--host",
      "0.0.0.0",
    ],
    { cwd: process.cwd(), reject: false },
  );

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--executor local is not isolated/);
  assert.match(result.stderr, /--allow-unsafe-local-executor/);
});

test("loom harness serve lists the status endpoint", async () => {
  const workspaceRoot = await tempDir("loom-cli-serve-status");
  const result = await execa(
    process.execPath,
    ["dist/index.js", "harness", "serve", "--workspace-root", workspaceRoot, "--host", "127.0.0.1", "--port", "0"],
    { cwd: process.cwd(), reject: false, timeout: 5000 },
  );

  assert.match(result.stdout, /"GET \/status"/);
  assert.match(result.stdout, /"GET \/healthz"/);
  assert.match(result.stdout, /"GET \/readyz"/);
  assert.match(result.stdout, /"GET \/metrics"/);
  assert.match(result.stdout, /"GET \/workbench"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/access"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/status"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/brain\/signals"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/policy"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/policy\/settings"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/policy\/api-keys"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/policy\/api-keys\/revoke"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/policy\/escalations"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/audit"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/model-usage\/warnings"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/workspace-usage\/warnings"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/projects"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/projects\/:project"/);
  assert.match(result.stdout, /"PUT \/tenants\/:tenant\/projects\/:project\/source-defaults"/);
  assert.match(result.stdout, /"PUT \/tenants\/:tenant\/projects\/:project\/default-skills"/);
  assert.match(result.stdout, /"PUT \/tenants\/:tenant\/projects\/:project\/run-policy"/);
  assert.match(result.stdout, /"PUT \/tenants\/:tenant\/projects\/:project\/contract"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/projects\/:project\/workspace"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/projects\/:project\/diff"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/projects\/:project\/presence"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/projects\/:project\/presence"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/projects\/:project\/vas\/cases"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/projects\/:project\/vas\/cases"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/projects\/:project\/vas\/review-queue"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/projects\/:project\/vas\/learnings"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/runs\/:runId\/replay"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/runs\/:runId\/workspace"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/runs\/:runId\/diff"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/runs\/:runId\/handoff-runs"/);
  assert.match(result.stdout, /"GET \/tenants\/:tenant\/runs\/:runId\/presence"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/runs\/:runId\/presence"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/runs\/:runId\/comments"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/runs\/:runId\/issue-comments\/sync"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/webhooks\/gitea\/issue-comments"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/webhooks\/control-plane\/issue-comments"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/runs\/:runId\/resume"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/runs\/:runId\/review-claim"/);
  assert.match(result.stdout, /"POST \/tenants\/:tenant\/runs\/:runId\/deployment"/);
});

test("loom harness serve uses tenant-scoped Gitea token envs", async () => {
  const workspaceRoot = await tempDir("loom-cli-tenant-gitea-token");
  const port = await freePort();
  const authorizations: string[] = [];
  const giteaServer = createServer(async (req, res) => {
    assert.match(req.url ?? "", /^\/api\/v1\/repos\/team\/app\/issues\/[12]\/comments$/);
    authorizations.push(req.headers.authorization ?? "");
    await readBody(req);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => giteaServer.listen(0, "127.0.0.1", resolve));
  const address = giteaServer.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  const server = execa(
    process.execPath,
    [
      "dist/index.js",
      "harness",
      "serve",
      "--workspace-root",
      workspaceRoot,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--allow-unsafe-local-executor",
      "--tenant-key",
      "alice=alice-key:alice-dev:developer",
      "--tenant-key",
      "bob=bob-key:bob-dev:developer",
      "--gitea-comment",
      "--gitea-url",
      `http://127.0.0.1:${address.port}`,
      "--tenant-gitea-token-env",
      "alice=LOOM_ALICE_GITEA_TOKEN",
      "--tenant-gitea-token-env",
      "bob=LOOM_BOB_GITEA_TOKEN",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOOM_ALICE_GITEA_TOKEN: "alice-forge-token",
        LOOM_BOB_GITEA_TOKEN: "bob-forge-token",
      },
      reject: false,
    },
  );

  try {
    await waitForStdout(server, /"url":/);
    for (const [tenant, token, issue] of [["alice", "alice-key", "team/app#1"], ["bob", "bob-key", "team/app#2"]] as const) {
      const response = await fetch(`http://127.0.0.1:${port}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          tenant,
          project: "proj-a",
          issue,
          goal: `post ${tenant} issue comment`,
          script: [{ message: "finish", finish: true }],
          verify: [],
          skills: ["coding"],
        }),
      });
      assert.equal(response.status, 201);
      assert.equal((await response.json()).status, "passed");
    }

    assert.deepEqual(authorizations, ["token alice-forge-token", "token bob-forge-token"]);
    const statusResponse = await fetch(`http://127.0.0.1:${port}/tenants/alice/status`, {
      headers: { authorization: "Bearer alice-key" },
    });
    assert.equal(statusResponse.status, 200);
    const statusBody = await statusResponse.json();
    assert.deepEqual(statusBody.readiness.checks.controlPlaneAgentIdentity, {
      required: false,
      ok: true,
      provider: "gitea-forgejo",
      mode: "tenant-scoped",
      tenantCount: 1,
      missingTenantCount: 0,
    });
  } finally {
    server.kill("SIGTERM");
    await server.catch(() => undefined);
    await new Promise<void>((resolve, reject) =>
      giteaServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom Stop hook can post brain signals to a central ingest endpoint", async () => {
  const cwd = await tempDir("loom-stop-hook-http");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(join(cwd, ".claude", "active-skills"), "coding\nvas-lite\n", "utf8");
  const received: any[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/tenants/alice/brain/signals");
    assert.equal(req.headers.authorization, "Bearer dev-key");
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ ingested: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa("bash", [join(process.cwd(), "hooks/loom-stop-hook.sh")], {
      cwd,
      input: "{}",
      env: {
        ...process.env,
        LOOM_BRAIN_INGEST_URL: `http://127.0.0.1:${address.port}/tenants/alice/brain/signals`,
        LOOM_BRAIN_INGEST_TOKEN: "dev-key",
        LOOM_BRAIN_CLIENT_ID: "coder-stop-hook",
        LOOM_RUN_ID: "native-run-7",
        LOOM_RUN_DIR: "/home/dev/projects/app/.loom/native-run-7",
        LOOM_STATUS: "failed",
        LOOM_ISSUE: "team/app#42",
        LOOM_ISSUE_URL: "https://git.example/team/app/issues/42",
        LOOM_DASHBOARD_URL: "https://loom.example/?tenant=alice&project=app&runId=native-run-7",
        LOOM_SUMMARY_URL: "https://loom.example/tenants/alice/runs/native-run-7?project=app",
        LOOM_REVIEW_SUMMARY_URL: "https://loom.example/tenants/alice/runs/native-run-7/review-summary?project=app",
        LOOM_HANDOFF_PACKAGE_URL: "https://loom.example/tenants/alice/runs/native-run-7/handoff-package?project=app",
        LOOM_HANDOFF_FOLLOWUPS_URL: "https://loom.example/tenants/alice/runs/native-run-7/handoff-runs?project=app",
        LOOM_FAILURE_KIND: "verification",
        LOOM_MODEL_REQUEST_COUNT: "2",
        LOOM_MODEL_PROMPT_TOKENS: "31",
        LOOM_MODEL_COMPLETION_TOKENS: "16",
        LOOM_MODEL_TOTAL_TOKENS: "47",
        LOOM_MODEL_COST_USD: "0.0047",
        LOOM_BRAIN_NOTES: "native reviewer found verification failure",
      },
      reject: false,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(received.length, 1);
    assert.equal(received[0].project, basename(cwd));
    assert.deepEqual(received[0].skills, ["coding", "vas-lite"]);
    assert.equal(received[0].outcome, "fail");
    assert.equal(received[0].clientId, "coder-stop-hook");
    assert.equal(received[0].runId, "native-run-7");
    assert.equal(received[0].runDir, "/home/dev/projects/app/.loom/native-run-7");
    assert.equal(received[0].status, "failed");
    assert.equal(received[0].issue, "team/app#42");
    assert.equal(received[0].issueUrl, "https://git.example/team/app/issues/42");
    assert.equal(received[0].dashboardUrl, "https://loom.example/?tenant=alice&project=app&runId=native-run-7");
    assert.equal(received[0].summaryUrl, "https://loom.example/tenants/alice/runs/native-run-7?project=app");
    assert.equal(received[0].reviewSummaryUrl, "https://loom.example/tenants/alice/runs/native-run-7/review-summary?project=app");
    assert.equal(received[0].handoffPackageUrl, "https://loom.example/tenants/alice/runs/native-run-7/handoff-package?project=app");
    assert.equal(received[0].handoffFollowupsUrl, "https://loom.example/tenants/alice/runs/native-run-7/handoff-runs?project=app");
    assert.equal(received[0].failureKind, "verification");
    assert.equal(received[0].modelRequestCount, 2);
    assert.equal(received[0].modelPromptTokens, 31);
    assert.equal(received[0].modelCompletionTokens, 16);
    assert.equal(received[0].modelTotalTokens, 47);
    assert.equal(received[0].modelCostUsd, 0.0047);
    assert.equal(received[0].notes, "native reviewer found verification failure");
    assert.match(received[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom Stop hook reads native goal context defaults", async () => {
  const cwd = await tempDir("loom-stop-hook-native-context");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await mkdir(join(cwd, ".loom"), { recursive: true });
  const contextPath = join(cwd, ".loom", "native-goal.json");
  await writeFile(contextPath, JSON.stringify({
    schemaVersion: 1,
    project: "proj-a",
    runId: "native-run-1",
    worktree: "task-123",
    cwd,
    skills: ["coding", "vas-lite"],
    issue: "team/proj-a#42",
    issueUrl: "https://git.example/team/proj-a/issues/42",
    condition: "tests pass",
    status: "running",
  }, null, 2), "utf8");

  const received: any[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/tenants/alice/brain/signals");
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ ingested: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa("bash", [join(process.cwd(), "hooks/loom-stop-hook.sh")], {
      cwd,
      input: "{}",
      env: {
        ...process.env,
        LOOM_BRAIN_INGEST_URL: `http://127.0.0.1:${address.port}/tenants/alice/brain/signals`,
        LOOM_NATIVE_GOAL_CONTEXT: contextPath,
        LOOM_RUN_DIR: "",
        LOOM_ISSUE: "",
        LOOM_ISSUE_URL: "",
      },
      reject: false,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(received.length, 1);
    assert.equal(received[0].project, "proj-a");
    assert.deepEqual(received[0].skills, ["coding", "vas-lite"]);
    assert.equal(received[0].runId, "native-run-1");
    assert.equal(received[0].runDir, cwd);
    assert.equal(received[0].issue, "team/proj-a#42");
    assert.equal(received[0].issueUrl, "https://git.example/team/proj-a/issues/42");
    assert.equal(received[0].outcome, "fail");
    assert.equal(received[0].status, "failed");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom brain propose exposes Gitea PR options", async () => {
  const result = await execa(
    "npx",
    ["tsx", "src/index.ts", "brain", "propose", "--help"],
    { cwd: process.cwd(), reject: false },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /--gitea-pr/);
  assert.match(result.stdout, /--gitea-repo/);
  assert.match(result.stdout, /--gitea-base/);
});

test("loomd serve exposes Gitea PR brain options", async () => {
  const result = await execa(
    "npx",
    ["tsx", "src/loomd.ts", "serve", "--help"],
    { cwd: process.cwd(), reject: false },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /--threshold/);
  assert.match(result.stdout, /--min-runs/);
  assert.match(result.stdout, /--gitea-pr/);
  assert.match(result.stdout, /--gitea-repo/);
  assert.match(result.stdout, /--gitea-base/);
  assert.match(result.stdout, /--git-sync/);
  assert.match(result.stdout, /--no-idle-gc/);
});

test("loom harness run can use an OpenAI-compatible model agent", async () => {
  const cwd = await tempDir("loom-cli-model");
  let calls = 0;
  const modelServer = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer cli-key");
    await readBody(req);
    calls += 1;
    const step =
      calls === 1
        ? {
            message: "write model artifact",
            actions: [
              {
                toolName: "file.write",
                input: { path: "model-cli.txt", content: "model-cli-ok\n" },
              },
            ],
          }
        : { message: "finish", finish: true };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(step) } }] }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "run",
        "create model-cli.txt",
        "--cwd",
        cwd,
        "--model",
        "test-model",
        "--model-base-url",
        `http://127.0.0.1:${address.port}`,
        "--model-key-env",
        "LOOM_TEST_MODEL_KEY",
        "--verify",
        "test -f model-cli.txt",
        "--skill",
        "coding",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_MODEL_KEY: "cli-key" },
        reject: false,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(calls, 2);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.metadata.agentMode, "model");
    assert.equal(summary.metadata.model, "test-model");
    assert.equal(JSON.stringify(summary).includes("cli-key"), false);
    assert.equal(await readFile(join(cwd, "model-cli.txt"), "utf8"), "model-cli-ok\n");
  } finally {
    await new Promise<void>((resolve, reject) =>
      modelServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness run records pull request reporter failures as run errors", async () => {
  const cwd = await tempDir("loom-cli-pr-failure");
  const scriptPath = await writeFinishScript(cwd);
  const giteaServer = createServer(async (req, res) => {
    assert.equal(req.url, "/api/v1/repos/team/app/pulls");
    assert.equal(req.headers.authorization, "token cli-token");
    await readBody(req);
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("forge unavailable");
  });
  await new Promise<void>((resolve) => giteaServer.listen(0, "127.0.0.1", resolve));
  const address = giteaServer.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "run",
        "record PR reporter failure",
        "--cwd",
        cwd,
        "--script",
        scriptPath,
        "--issue",
        "team/app#42",
        "--branch",
        "task/42",
        "--gitea-pr",
        "--gitea-url",
        `http://127.0.0.1:${address.port}`,
        "--gitea-token-env",
        "LOOM_TEST_GITEA_TOKEN",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_GITEA_TOKEN: "cli-token" },
        reject: false,
      },
    );

    assert.equal(result.exitCode, 1);
    const { summary, events } = await readOnlyRun(cwd);
    assert.equal(summary.status, "error");
    assert.equal(summary.metadata.issue, "team/app#42");
    assert.equal(summary.metadata.issueUrl, `http://127.0.0.1:${address.port}/team/app/issues/42`);
    assert.ok(events.some((event) => event.type === "error" && /pull request reporter failed: Gitea pull request failed with 503: forge unavailable/.test(event.data.message)));
  } finally {
    await new Promise<void>((resolve, reject) =>
      giteaServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness run records pull request external effects", async () => {
  const cwd = await tempDir("loom-cli-pr-effect");
  const scriptPath = await writeFinishScript(cwd);
  let pullRequestBody = "";
  const giteaServer = createServer(async (req, res) => {
    assert.equal(req.url, "/api/v1/repos/team/app/pulls");
    assert.equal(req.headers.authorization, "token cli-token");
    pullRequestBody = JSON.parse(await readBody(req)).body;
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ index: 9, html_url: "https://git.example/team/app/pulls/9" }));
  });
  await new Promise<void>((resolve) => giteaServer.listen(0, "127.0.0.1", resolve));
  const address = giteaServer.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "run",
        "record PR external effect",
        "--cwd",
        cwd,
        "--script",
        scriptPath,
        "--issue",
        "team/app#42",
        "--branch",
        "task/42",
        "--require-review",
        "--verify",
        "true",
        "--evaluate",
        "true",
        "--public-url",
        "https://loom.example",
        "--gitea-pr",
        "--gitea-url",
        `http://127.0.0.1:${address.port}`,
        "--gitea-token-env",
        "LOOM_TEST_GITEA_TOKEN",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_GITEA_TOKEN: "cli-token" },
        reject: false,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const { summary, events } = await readOnlyRun(cwd);
    assert.equal(summary.status, "review_required");
    assert.equal(summary.metadata.issueUrl, `http://127.0.0.1:${address.port}/team/app/issues/42`);
    assert.equal(summary.metadata.dashboardUrl, `https://loom.example/?tenant=local&project=${basename(cwd)}&runId=${summary.runId}`);
    assert.equal(summary.metadata.summaryUrl, `https://loom.example/tenants/local/runs/${summary.runId}?project=${basename(cwd)}`);
    assert.equal(summary.metadata.pullRequestIndex, 9);
    assert.equal(summary.metadata.pullRequestUrl, "https://git.example/team/app/pulls/9");
    assert.match(pullRequestBody, new RegExp(`Dashboard: https://loom\\.example/\\?tenant=local&project=${basename(cwd)}&runId=${summary.runId}`));
    assert.match(pullRequestBody, new RegExp(`Summary: https://loom\\.example/tenants/local/runs/${summary.runId}\\?project=${basename(cwd)}`));
    assert.match(pullRequestBody, new RegExp(`Review summary: https://loom\\.example/tenants/local/runs/${summary.runId}/review-summary\\?project=${basename(cwd)}`));
    assert.match(pullRequestBody, new RegExp(`Handoff package: https://loom\\.example/tenants/local/runs/${summary.runId}/handoff-package\\?project=${basename(cwd)}`));
    assert.match(pullRequestBody, new RegExp(`Follow-up runs: https://loom\\.example/tenants/local/runs/${summary.runId}/handoff-runs\\?project=${basename(cwd)}`));
    assert.match(pullRequestBody, /Verification: passed \(exit 0\)/);
    assert.match(pullRequestBody, /Verification commands: `true`/);
    assert.match(pullRequestBody, /Evaluation: passed \(exit 0\)/);
    assert.match(pullRequestBody, /Evaluation commands: `true`/);
    assert.match(pullRequestBody, /Human review is required before merge/);
    assert.ok(events.some((event) =>
      event.type === "external_effect" &&
      event.data.kind === "pull_request" &&
      event.data.issueUrl === `http://127.0.0.1:${address.port}/team/app/issues/42` &&
      event.data.dashboardUrl === `https://loom.example/?tenant=local&project=${basename(cwd)}&runId=${summary.runId}` &&
      event.data.summaryUrl === `https://loom.example/tenants/local/runs/${summary.runId}?project=${basename(cwd)}` &&
      event.data.reviewSummaryUrl === `https://loom.example/tenants/local/runs/${summary.runId}/review-summary?project=${basename(cwd)}` &&
      event.data.handoffPackageUrl === `https://loom.example/tenants/local/runs/${summary.runId}/handoff-package?project=${basename(cwd)}` &&
      event.data.handoffFollowupsUrl === `https://loom.example/tenants/local/runs/${summary.runId}/handoff-runs?project=${basename(cwd)}` &&
      event.data.pullRequestIndex === 9 &&
      event.data.pullRequestUrl === "https://git.example/team/app/pulls/9",
    ));
  } finally {
    await new Promise<void>((resolve, reject) =>
      giteaServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness run records pull requests for deployment-gated runs", async () => {
  const cwd = await tempDir("loom-cli-pr-deployment");
  const scriptPath = await writeFinishScript(cwd);
  let pullRequestBody = "";
  const giteaServer = createServer(async (req, res) => {
    assert.equal(req.url, "/api/v1/repos/team/app/pulls");
    assert.equal(req.headers.authorization, "token cli-token");
    pullRequestBody = JSON.parse(await readBody(req)).body;
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ index: 11, html_url: "https://git.example/team/app/pulls/11" }));
  });
  await new Promise<void>((resolve) => giteaServer.listen(0, "127.0.0.1", resolve));
  const address = giteaServer.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "run",
        "record deployment PR external effect",
        "--cwd",
        cwd,
        "--script",
        scriptPath,
        "--issue",
        "team/app#42",
        "--branch",
        "task/42",
        "--require-deployment",
        "--verify",
        "true",
        "--gitea-pr",
        "--gitea-url",
        `http://127.0.0.1:${address.port}`,
        "--gitea-token-env",
        "LOOM_TEST_GITEA_TOKEN",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_GITEA_TOKEN: "cli-token" },
        reject: false,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const { summary, events } = await readOnlyRun(cwd);
    assert.equal(summary.status, "deployment_required");
    assert.equal(summary.metadata.pullRequestIndex, 11);
    assert.equal(summary.metadata.pullRequestUrl, "https://git.example/team/app/pulls/11");
    assert.match(pullRequestBody, /Status: deployment_required/);
    assert.match(pullRequestBody, /Deployment approval is required before production/);
    assert.ok(events.some((event) =>
      event.type === "external_effect" &&
      event.data.kind === "pull_request" &&
      event.data.pullRequestIndex === 11 &&
      event.data.pullRequestUrl === "https://git.example/team/app/pulls/11"
    ));
  } finally {
    await new Promise<void>((resolve, reject) =>
      giteaServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness run rejects unsafe pull request refs before starting", async () => {
  const branchCwd = await tempDir("loom-cli-unsafe-pr-branch");
  const branchScript = await writeFinishScript(branchCwd);
  const branchResult = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "run",
      "reject unsafe PR branch",
      "--cwd",
      branchCwd,
      "--script",
      branchScript,
      "--issue",
      "team/app#42",
      "--branch",
      "task..bad",
      "--gitea-pr",
      "--gitea-url",
      "http://127.0.0.1:1",
      "--gitea-token-env",
      "LOOM_TEST_GITEA_TOKEN",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, LOOM_TEST_GITEA_TOKEN: "cli-token" },
      reject: false,
    },
  );
  assert.equal(branchResult.exitCode, 2);
  assert.match(branchResult.stderr, /--branch is not a safe git ref/);
  await assert.rejects(() => readdir(join(branchCwd, ".loom")), /ENOENT/);

  const baseCwd = await tempDir("loom-cli-unsafe-pr-base");
  const baseScript = await writeFinishScript(baseCwd);
  const baseResult = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "run",
      "reject unsafe PR base",
      "--cwd",
      baseCwd,
      "--script",
      baseScript,
      "--issue",
      "team/app#42",
      "--branch",
      "task/42",
      "--base-branch",
      "origin//main",
      "--gitea-pr",
      "--gitea-url",
      "http://127.0.0.1:1",
      "--gitea-token-env",
      "LOOM_TEST_GITEA_TOKEN",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, LOOM_TEST_GITEA_TOKEN: "cli-token" },
      reject: false,
    },
  );
  assert.equal(baseResult.exitCode, 2);
  assert.match(baseResult.stderr, /--base-branch is not a safe git ref/);
  await assert.rejects(() => readdir(join(baseCwd, ".loom")), /ENOENT/);
});

test("loom harness run records issue reporter failures as run errors", async () => {
  const cwd = await tempDir("loom-cli-issue-failure");
  const scriptPath = await writeFinishScript(cwd);
  const giteaServer = createServer(async (req, res) => {
    assert.equal(req.url, "/api/v1/repos/team/app/issues/42/comments");
    assert.equal(req.headers.authorization, "token cli-token");
    await readBody(req);
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("issue tracker unavailable");
  });
  await new Promise<void>((resolve) => giteaServer.listen(0, "127.0.0.1", resolve));
  const address = giteaServer.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "run",
        "record issue reporter failure",
        "--cwd",
        cwd,
        "--script",
        scriptPath,
        "--issue",
        "team/app#42",
        "--gitea-comment",
        "--gitea-url",
        `http://127.0.0.1:${address.port}`,
        "--gitea-token-env",
        "LOOM_TEST_GITEA_TOKEN",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_GITEA_TOKEN: "cli-token" },
        reject: false,
      },
    );

    assert.equal(result.exitCode, 1);
    const { summary, events } = await readOnlyRun(cwd);
    assert.equal(summary.status, "error");
    assert.equal(summary.metadata.issue, "team/app#42");
    assert.equal(summary.metadata.issueUrl, `http://127.0.0.1:${address.port}/team/app/issues/42`);
    assert.ok(events.some((event) => event.type === "error" && /issue reporter failed: Gitea issue comment failed with 502: issue tracker unavailable/.test(event.data.message)));
  } finally {
    await new Promise<void>((resolve, reject) =>
      giteaServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness run rejects docker executor without an image", async () => {
  const cwd = await tempDir("loom-cli-docker");
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify([{ message: "finish", finish: true }]), "utf8");

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "run",
      "try docker",
      "--cwd",
      cwd,
      "--script",
      scriptPath,
      "--executor",
      "docker",
    ],
    { cwd: process.cwd(), reject: false },
  );

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--executor-image is required/);
});

test("loom harness run rejects coder executor without a workspace", async () => {
  const cwd = await tempDir("loom-cli-coder");
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify([{ message: "finish", finish: true }]), "utf8");

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "run",
      "try coder",
      "--cwd",
      cwd,
      "--script",
      scriptPath,
      "--executor",
      "coder",
    ],
    { cwd: process.cwd(), reject: false },
  );

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--executor-workspace is required/);
});

test("loom harness coder-preflight probes Coder prepare and remote command readiness", async () => {
  const root = await tempDir("loom-cli-coder-preflight");
  const binDir = join(root, "bin");
  const logPath = join(root, "coder-args.jsonl");
  await mkdir(binDir, { recursive: true });
  const coderPath = join(binDir, "coder");
  await writeFile(
    coderPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.LOOM_FAKE_CODER_LOG, JSON.stringify(args) + '\\n');",
      "if (args[0] === 'show') process.exit(1);",
      "if (args[0] === 'ssh' && String(args[5] || '').includes('loom-coder-preflight')) {",
      "  console.log('loom-coder-preflight-ok');",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(coderPath, 0o755);

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "coder-preflight",
      "--workspace-root",
      root,
      "--tenant",
      "alice",
      "--project",
      "proj-a",
      "--executor-workspace",
      "loom-{tenant}",
      "--executor-remote-cwd",
      "/home/dev/projects/{project}",
      "--executor-worktree-cwd",
      "/home/dev/projects/{project}/.worktrees/{runId}",
      "--executor-template",
      "loom",
      "--executor-template-param",
      "tenant={tenant}",
      "--executor-template-param",
      "project={project}",
      "--executor-cpus",
      "0.5",
      "--executor-memory",
      "512m",
      "--executor-pids-limit",
      "64",
      "--executor-ide-url",
      "https://coder.example/@{tenant}/{project}/{runId}",
      "--executor-preview-url",
      "https://preview.example/{tenant}/{project}/{runId}",
      "--repo",
      "https://git.example/team/app.git",
      "--branch",
      "task/{runId}",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        LOOM_FAKE_CODER_LOG: logPath,
        LOOM_CODER_PREFLIGHT_SECRET: "super-secret",
      },
      reject: false,
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.includes("super-secret"), false);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.tenant, "alice");
  assert.equal(body.project, "proj-a");
  assert.match(body.runId, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(body.missing, []);
  assert.equal(body.checks.prepare.ok, true);
  assert.equal(body.checks.remoteCommand.ok, true);
  assert.equal(body.checks.remoteCommand.output, "loom-coder-preflight-ok");
  assert.equal(body.checks.browserUrls.ok, true);
  assert.deepEqual(body.executor, {
    kind: "coder",
    workspace: "loom-alice",
    remoteCwd: `/home/dev/projects/proj-a/.worktrees/${body.runId}`,
    repoCwd: "/home/dev/projects/proj-a",
    branch: `task/${body.runId}`,
    baseBranch: "origin/main",
    ideUrl: `https://coder.example/@alice/proj-a/${body.runId}`,
    previewUrl: `https://preview.example/alice/proj-a/${body.runId}`,
  });

  const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls[0], ["show", "loom-alice"]);
  assert.deepEqual(calls[1], [
    "create",
    "--template",
    "loom",
    "--yes",
    "--use-parameter-defaults",
    "--parameter",
    "tenant=alice",
    "--parameter",
    "project=proj-a",
    "--parameter",
    "cpus=0.5",
    "--parameter",
    "memory_gb=0.5",
    "--parameter",
    "pids_limit=64",
    "loom-alice",
  ]);
  assert.deepEqual(calls[2], ["start", "--yes", "loom-alice"]);
  assert.match(calls.at(-1)?.[5] ?? "", /printf loom-coder-preflight-ok/);
});

test("loom harness model-preflight probes OpenAI-compatible gateway readiness", async () => {
  let authHeader = "";
  let requestBody: any;
  const modelServer = createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    authHeader = req.headers.authorization ?? "";
    requestBody = JSON.parse(await readBody(req));
    res.writeHead(200, {
      "content-type": "application/json",
      "x-litellm-response-cost": "0.0025",
    });
    res.end(JSON.stringify({
      id: "chatcmpl-preflight",
      model: "gateway-model",
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
      choices: [
        {
          message: {
            content: JSON.stringify({
              message: "model preflight ok",
              plan: "return a valid finish step",
              finish: true,
            }),
          },
        },
      ],
    }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelAddress = modelServer.address();
  assert.equal(typeof modelAddress, "object");
  assert.ok(modelAddress);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "model-preflight",
        "--model-base-url",
        `http://127.0.0.1:${modelAddress.port}`,
        "--model",
        "preflight-model",
        "--model-key-env",
        "LOOM_TEST_MODEL_KEY",
        "--model-protocol",
        "json",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_MODEL_KEY: "actual-model-secret" },
        reject: false,
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes("actual-model-secret"), false);
    assert.equal(authHeader, "Bearer actual-model-secret");
    assert.equal(requestBody.model, "preflight-model");
    assert.equal(requestBody.response_format.type, "json_object");
    assert.match(requestBody.messages[1].content, /loom model preflight/);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.model, "preflight-model");
    assert.equal(body.protocol, "json");
    assert.equal(body.keyEnv, "LOOM_TEST_MODEL_KEY");
    assert.deepEqual(body.missing, []);
    assert.equal(body.checks.apiKey.ok, true);
    assert.equal(body.checks.chatCompletion.ok, true);
    assert.equal(body.checks.agentStep.ok, true);
    assert.equal(body.agentStep.message, "model preflight ok");
    assert.equal(body.agentStep.finish, true);
    assert.deepEqual(body.modelUsage, {
      model: "preflight-model",
      responseModel: "gateway-model",
      requestId: "chatcmpl-preflight",
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      costUsd: 0.0025,
      attempt: 1,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      modelServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness control-plane-preflight probes provider discovery endpoints", async () => {
  const seen: Array<{ path: string; authorization: string }> = [];
  const controlPlaneServer = createServer(async (req, res) => {
    seen.push({ path: req.url ?? "", authorization: req.headers.authorization ?? "" });
    if (req.url === "/api/v3" || req.url === "/api/v3/meta" || req.url === "/api/v3/rate_limit") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/api/v3"
        ? { version: "agent-git-service-test" }
        : req.url === "/api/v3/meta"
          ? { installed_version: "agent-git-service-test" }
          : { resources: { core: { limit: 5000, remaining: 4999 } } }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => controlPlaneServer.listen(0, "127.0.0.1", resolve));
  const address = controlPlaneServer.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const root = await tempDir("loom-cli-control-plane-preflight");
  const reportPath = join(root, "reports", "ags-control-plane-preflight.json");

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "control-plane-preflight",
        "--control-plane-provider",
        "agent-git-service",
        "--control-plane-url",
        `http://127.0.0.1:${address.port}`,
        "--control-plane-token-env",
        "LOOM_TEST_AGS_TOKEN",
        "--report",
        reportPath,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_AGS_TOKEN: "actual-ags-secret" },
        reject: false,
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes("actual-ags-secret"), false);
    assert.deepEqual(seen, [
      { path: "/api/v3", authorization: "Bearer actual-ags-secret" },
      { path: "/api/v3/meta", authorization: "Bearer actual-ags-secret" },
      { path: "/api/v3/rate_limit", authorization: "Bearer actual-ags-secret" },
    ]);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.provider, "agent-git-service");
    assert.equal(body.baseUrl, `http://127.0.0.1:${address.port}`);
    assert.equal(body.tokenEnv, "LOOM_TEST_AGS_TOKEN");
    assert.equal(body.tokenFree, true);
    assert.equal(body.reportPath, reportPath);
    assert.equal(body.compatibilityReport.schemaVersion, "agent-git-service-contract-probe/v1");
    assert.equal(body.compatibilityReport.readOnly, true);
    assert.equal(body.compatibilityReport.authorizationScheme, "Bearer");
    assert.equal(body.compatibilityReport.requestsTokenFree, true);
    assert.deepEqual(body.compatibilityReport.missingEndpoints, []);
    assert.deepEqual(body.compatibilityReport.invalidEndpoints, []);
    assert.deepEqual(body.missing, []);
    assert.deepEqual(body.discoveryEndpoints, ["/api/v3", "/api/v3/meta", "/api/v3/rate_limit"]);
    assert.equal(body.checks.token.ok, true);
    assert.equal(body.checks.discovery.ok, true);
    assert.equal(body.discoveryResults.length, 3);
    assert.deepEqual(body.discoveryResults.map((item: any) => item.endpoint), ["/api/v3", "/api/v3/meta", "/api/v3/rate_limit"]);
    assert.deepEqual(body.discoveryResults.map((item: any) => item.status), [200, 200, 200]);
    const report = await readFile(reportPath, "utf8");
    assert.equal(report.includes("actual-ags-secret"), false);
    assert.deepEqual(JSON.parse(report), body);
  } finally {
    await new Promise<void>((resolve, reject) =>
      controlPlaneServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness agent-git-service-compat-compare reports drift between preflight artifacts", async () => {
  const root = await tempDir("loom-cli-ags-compat-compare");
  const baselinePath = join(root, "baseline.json");
  const candidatePath = join(root, "candidate.json");
  const reportPath = join(root, "reports", "compare.json");
  const baselineProbe = agentGitServiceProbeReportFixture("http://contract.example/api/v3");
  const candidateProbe = {
    ...agentGitServiceProbeReportFixture("https://upstream.example/api/v3"),
    endpoints: baselineProbe.endpoints.map((endpoint: any) =>
      endpoint.endpoint === "/api/v3/meta"
        ? { ...endpoint, url: "https://upstream.example/api/v3/meta", ok: false, status: 404 }
        : { ...endpoint, url: endpoint.url.replace("http://contract.example", "https://upstream.example") },
    ),
    missingEndpoints: ["/api/v3/meta"],
    nativeCapabilities: baselineProbe.nativeCapabilities.filter((capability: string) => capability !== "wiki-memory"),
  };
  await writeFile(baselinePath, JSON.stringify({ tokenFree: true, compatibilityReport: baselineProbe }, null, 2), "utf8");
  await writeFile(candidatePath, JSON.stringify({ tokenFree: true, compatibilityReport: candidateProbe }, null, 2), "utf8");

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "agent-git-service-compat-compare",
      "--baseline",
      baselinePath,
      "--candidate",
      candidatePath,
      "--report",
      reportPath,
    ],
    { cwd: process.cwd(), reject: false },
  );

  assert.equal(result.exitCode, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.schemaVersion, "agent-git-service-contract-comparison/v1");
  assert.equal(body.tokenFree, true);
  assert.equal(body.baseline.baseUrl, "http://contract.example/api/v3");
  assert.deepEqual(body.baseline.invalidEndpoints, []);
  assert.equal(body.candidate.baseUrl, "https://upstream.example/api/v3");
  assert.deepEqual(body.candidate.invalidEndpoints, []);
  assert.deepEqual(body.endpointMismatches.map((mismatch: any) => mismatch.endpoint), ["/api/v3/meta"]);
  assert.deepEqual(body.nativeCapabilities.missing, ["wiki-memory"]);
  assert.equal(result.stdout.includes("actual-ags-secret"), false);
  assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), body);
});

test("loom harness agent-git-service-compat-rehearsal writes token-free local artifacts", async () => {
  const root = await tempDir("loom-cli-ags-compat-rehearsal");
  const outDir = join(root, "ags-compat");

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "agent-git-service-compat-rehearsal",
      "--out",
      outDir,
    ],
    { cwd: process.cwd(), reject: false },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.includes("contract-rehearsal-token"), false);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.tokenFree, true);
  assert.equal(body.schemaVersion, "agent-git-service-compat-rehearsal/v1");
  assert.equal(body.candidateMode, "contract");
  assert.equal(body.outDir, outDir);
  assert.equal(body.baselineReportPath, join(outDir, "baseline.json"));
  assert.equal(body.candidateReportPath, join(outDir, "candidate.json"));
  assert.equal(body.comparisonReportPath, join(outDir, "compare.json"));
  assert.equal(body.manifestPath, join(outDir, "manifest.json"));
  assert.equal(body.comparison.ok, true);

  const baseline = JSON.parse(await readFile(body.baselineReportPath, "utf8"));
  const candidate = JSON.parse(await readFile(body.candidateReportPath, "utf8"));
  const comparison = JSON.parse(await readFile(body.comparisonReportPath, "utf8"));
  const manifest = JSON.parse(await readFile(body.manifestPath, "utf8"));
  assert.equal(baseline.schemaVersion, "agent-git-service-contract-probe/v1");
  assert.equal(candidate.schemaVersion, "agent-git-service-contract-probe/v1");
  assert.equal(comparison.schemaVersion, "agent-git-service-contract-comparison/v1");
  assert.equal(manifest.schemaVersion, "agent-git-service-compat-rehearsal/v1");
  assert.equal(manifest.tokenFree, true);
  assert.equal(manifest.candidateMode, "contract");
  assert.deepEqual(manifest.artifacts, {
    baseline: "baseline.json",
    candidate: "candidate.json",
    comparison: "compare.json",
  });
  assert.deepEqual(manifest.artifactSha256, {
    baseline: sha256Hex(await readFile(body.baselineReportPath, "utf8")),
    candidate: sha256Hex(await readFile(body.candidateReportPath, "utf8")),
    comparison: sha256Hex(await readFile(body.comparisonReportPath, "utf8")),
  });
  for (const artifact of [baseline, candidate, comparison, manifest]) {
    assert.equal(JSON.stringify(artifact).includes("contract-rehearsal-token"), false);
  }
});

test("loom harness agent-git-service-compat-rehearsal probes an upstream candidate without leaking its token", async () => {
  const root = await tempDir("loom-cli-ags-compat-rehearsal-upstream");
  const outDir = join(root, "ags-compat");
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    seen.push(req.headers.authorization ?? "");
    if (req.url === "/api/v3") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "upstream-contract" }));
      return;
    }
    if (req.url === "/api/v3/meta") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ installed_version: "upstream-contract" }));
      return;
    }
    if (req.url === "/api/v3/rate_limit") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ resources: { core: { limit: 5000, remaining: 4999 } } }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "agent-git-service-compat-rehearsal",
        "--candidate-url",
        `http://127.0.0.1:${address.port}`,
        "--candidate-token-env",
        "LOOM_TEST_UPSTREAM_AGS_TOKEN",
        "--out",
        outDir,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_UPSTREAM_AGS_TOKEN: "upstream-secret-token" },
        reject: false,
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes("upstream-secret-token"), false);
    assert.deepEqual(seen, [
      "Bearer upstream-secret-token",
      "Bearer upstream-secret-token",
      "Bearer upstream-secret-token",
    ]);
    const body = JSON.parse(result.stdout);
    assert.equal(body.candidateMode, "upstream");
    assert.equal(body.comparison.ok, true);
    const candidate = JSON.parse(await readFile(body.candidateReportPath, "utf8"));
    assert.equal(candidate.baseUrl, `http://127.0.0.1:${address.port}/api/v3`);
    assert.equal(JSON.stringify(candidate).includes("upstream-secret-token"), false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("loom harness agent-git-service-staging-readiness probes AGS native surfaces without leaking its token", async () => {
  const root = await tempDir("loom-cli-ags-staging-readiness");
  const reportPath = join(root, "reports", "agent-git-service-staging.json");
  const ags = await startAgentGitServiceContractServer({
    workspace: {
      id: "ws-staging",
      agentLogin: "loom-agent",
      branch: "task/staging",
      status: "ready",
      updatedAt: "2026-07-01T00:00:00Z",
    },
    wikiMemory: {
      page: "vas/learnings",
      body: "prior staging learning",
      sha: "sha-before",
    },
  });

  try {
    const blocked = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "agent-git-service-native-write-check",
        "--control-plane-url",
        ags.baseUrl,
        "--control-plane-token-env",
        "LOOM_TEST_UPSTREAM_AGS_TOKEN",
        "--issue",
        "team/loom-smoke#17",
        "--repo",
        "team/loom-smoke",
        "--workspace-id",
        "ws-staging",
        "--attachment-url",
        "https://loom.example/handoff/run-1",
        "--wiki-page",
        "vas/learnings",
        "--wiki-note",
        "native write staging marker",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_UPSTREAM_AGS_TOKEN: "native-write-secret-token" },
        reject: false,
      },
    );
    assert.equal(blocked.exitCode, 1);
    assert.equal(blocked.stdout.includes("native-write-secret-token"), false);
    assert.deepEqual(JSON.parse(blocked.stdout).missing, ["approve-mutating"]);
    assert.deepEqual(ags.requests, []);

    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "agent-git-service-staging-readiness",
        "--control-plane-url",
        ags.baseUrl,
        "--control-plane-token-env",
        "LOOM_TEST_UPSTREAM_AGS_TOKEN",
        "--issue",
        "team/loom-smoke#17",
        "--repo",
        "team/loom-smoke",
        "--wiki-page",
        "vas/learnings",
        "--report",
        reportPath,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_UPSTREAM_AGS_TOKEN: "staging-secret-token" },
        reject: false,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.includes("staging-secret-token"), false);
    const body = JSON.parse(result.stdout);
    assert.equal(body.schemaVersion, "agent-git-service-staging-readiness/v1");
    assert.equal(body.ok, true);
    assert.equal(body.tokenFree, true);
    assert.equal(body.provider, "agent-git-service");
    assert.equal(body.baseUrl, ags.baseUrl);
    assert.equal(body.tokenEnv, "LOOM_TEST_UPSTREAM_AGS_TOKEN");
    assert.equal(body.issue, "team/loom-smoke#17");
    assert.equal(body.repo, "team/loom-smoke");
    assert.equal(body.reportPath, reportPath);
    assert.deepEqual(body.missing, []);
    assert.deepEqual(body.gates, {
      token: true,
      serverReadiness: true,
      discovery: true,
      issueWorkspaces: true,
      issueComments: true,
      wikiMemory: true,
    });
    assert.deepEqual(body.serverReadiness, {
      ok: true,
      url: `${ags.webBaseUrl}/readyz`,
      httpStatus: 200,
      status: "ready",
      version: "contract",
      checkNames: ["main_db"],
    });
    assert.equal(body.discovery.ok, true);
    assert.equal(body.issueWorkspaces.ok, true);
    assert.equal(body.issueWorkspaces.count, 1);
    assert.deepEqual(body.issueWorkspaces.ids, ["ws-staging"]);
    assert.equal(body.issueComments.ok, true);
    assert.equal(body.issueComments.count, 0);
    assert.equal(body.wikiMemory.ok, true);
    assert.equal(body.wikiMemory.page, "vas/learnings");
    assert.equal(body.wikiMemory.sha, "sha-before");
    assert.equal(body.wikiMemory.bodyBytes, "prior staging learning".length);
    assert.equal(body.issueUrl, `${ags.webBaseUrl}/team/loom-smoke/issues/17`);
    assert.equal(body.gitRemoteUrl, `${ags.webBaseUrl}/team/loom-smoke.git`);
    const report = await readFile(reportPath, "utf8");
    assert.equal(report.includes("staging-secret-token"), false);
    assert.deepEqual(JSON.parse(report), body);

    const actualRequests = ags.requests.map((request) => [request.method, request.path, request.query, request.authorization]);
    const expectedRequests = [
      ["GET", "/readyz", "", undefined],
      ["GET", "/api/v3", "", "Bearer staging-secret-token"],
      ["GET", "/api/v3/meta", "", "Bearer staging-secret-token"],
      ["GET", "/api/v3/rate_limit", "", "Bearer staging-secret-token"],
      ["GET", "/api/v3/repos/team/loom-smoke/issues/17/workspaces", "?per_page=5", "Bearer staging-secret-token"],
      ["GET", "/api/v3/repos/team/loom-smoke/issues/17/comments", "?per_page=5", "Bearer staging-secret-token"],
      ["GET", "/api/v3/repos/team/loom-smoke/wiki/memory/vas%2Flearnings", "", "Bearer staging-secret-token"],
    ];
    actualRequests.sort((left, right) => String(left[1]).localeCompare(String(right[1])));
    expectedRequests.sort((left, right) => String(left[1]).localeCompare(String(right[1])));
    assert.deepEqual(actualRequests, expectedRequests);
  } finally {
    await ags.close();
  }
});

test("loom harness agent-git-service-native-write-check verifies approved AGS write surfaces without leaking its token", async () => {
  const root = await tempDir("loom-cli-ags-native-write-check");
  const reportPath = join(root, "reports", "agent-git-service-native-write.json");
  const ags = await startAgentGitServiceContractServer({
    workspace: {
      id: "ws-staging",
      agentLogin: "loom-agent",
      branch: "task/staging",
      status: "ready",
      updatedAt: "2026-07-01T00:00:00Z",
    },
    wikiMemory: {
      page: "vas/learnings",
      body: "prior staging learning",
      sha: "sha-before",
    },
  });

  try {
    const result = await execa(
      "npx",
      [
        "tsx",
        "src/index.ts",
        "harness",
        "agent-git-service-native-write-check",
        "--control-plane-url",
        ags.baseUrl,
        "--control-plane-token-env",
        "LOOM_TEST_UPSTREAM_AGS_TOKEN",
        "--issue",
        "team/loom-smoke#17",
        "--repo",
        "team/loom-smoke",
        "--workspace-id",
        "ws-staging",
        "--attachment-url",
        "https://loom.example/handoff/run-1",
        "--wiki-page",
        "vas/learnings",
        "--wiki-note",
        "native write staging marker",
        "--approve-mutating",
        "--report",
        reportPath,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LOOM_TEST_UPSTREAM_AGS_TOKEN: "native-write-secret-token" },
        reject: false,
      },
    );

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.includes("native-write-secret-token"), false);
    const body = JSON.parse(result.stdout);
    assert.equal(body.schemaVersion, "agent-git-service-native-write-check/v1");
    assert.equal(body.ok, true);
    assert.equal(body.tokenFree, true);
    assert.equal(body.provider, "agent-git-service");
    assert.equal(body.baseUrl, ags.baseUrl);
    assert.equal(body.tokenEnv, "LOOM_TEST_UPSTREAM_AGS_TOKEN");
    assert.equal(body.issue, "team/loom-smoke#17");
    assert.equal(body.repo, "team/loom-smoke");
    assert.equal(body.attachmentUrl, "https://loom.example/handoff/run-1");
    assert.equal(body.reportPath, reportPath);
    assert.deepEqual(body.missing, []);
    assert.deepEqual(body.gates, {
      token: true,
      approved: true,
      issueComment: true,
      workspaceAttachment: true,
      wikiMemory: true,
    });
    assert.equal(body.issueComment.ok, true);
    assert.equal(body.workspaceAttachment.ok, true);
    assert.equal(body.workspaceAttachment.workspaceId, "ws-staging");
    assert.equal(body.workspaceAttachment.attachmentId, "1");
    assert.equal(body.workspaceAttachment.url, `${ags.webBaseUrl}/team/loom-smoke/issues/17/workspaces/ws-staging/attachments/1`);
    assert.equal(body.wikiMemory.ok, true);
    assert.equal(body.wikiMemory.page, "vas/learnings");
    assert.equal(body.wikiMemory.sha, "sha-after");
    assert.ok(body.wikiMemory.bodyBytes > "prior staging learning".length);
    const report = await readFile(reportPath, "utf8");
    assert.equal(report.includes("native-write-secret-token"), false);
    assert.deepEqual(JSON.parse(report), body);

    assert.deepEqual(
      ags.requests.map((request) => [request.method, request.path, request.authorization]),
      [
        ["POST", "/api/v3/repos/team/loom-smoke/issues/17/comments", "Bearer native-write-secret-token"],
        ["POST", "/api/v3/repos/team/loom-smoke/issues/17/workspaces/ws-staging/attachments", "Bearer native-write-secret-token"],
        ["GET", "/api/v3/repos/team/loom-smoke/wiki/memory/vas%2Flearnings", "Bearer native-write-secret-token"],
        ["PUT", "/api/v3/repos/team/loom-smoke/wiki/memory/vas%2Flearnings", "Bearer native-write-secret-token"],
      ],
    );
    const commentPayload = ags.requests[0].json;
    assert.equal(typeof commentPayload?.body, "string");
    assert.match(String(commentPayload?.body), /native write check/);
    const wikiPayload = ags.requests[3].json;
    assert.equal(typeof wikiPayload?.body, "string");
    assert.match(String(wikiPayload?.body), /native write staging marker/);
  } finally {
    await ags.close();
  }
});

function cutoverRunnerStage(
  id: string,
  executionMode: string,
  approvalRequired: boolean,
  marker: string,
  gateId?: string,
  requires?: string[],
  reportBody?: Record<string, unknown>,
): Record<string, unknown> {
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `fs.appendFileSync(process.env.LOOM_CUTOVER_RUN_LOG, ${JSON.stringify(`${marker}\n`)});`,
    ...(reportBody
      ? [
          "const reportIndex = process.argv.indexOf('--report');",
          "if (reportIndex >= 0 && process.argv[reportIndex + 1]) {",
          "  const reportPath = process.argv[reportIndex + 1];",
          "  fs.mkdirSync(path.dirname(reportPath), { recursive: true });",
          `  fs.writeFileSync(reportPath, JSON.stringify(${JSON.stringify(reportBody)}, null, 2) + '\\n');`,
          "}",
        ]
      : []),
  ].join(" ");
  return {
    id,
    command: `loom harness ${id}`,
    commandArgs: [
      process.execPath,
      "-e",
      script,
      ...(reportBody ? ["--", "--report", `reports/${id}.json`] : []),
    ],
    executionMode,
    approvalRequired,
    tokenFree: true,
    ...(gateId
      ? {
          operatorGate: {
            id: gateId,
            evidence: gateId === "ags-approval" ? "review dry-run output" : "server reachable",
          },
        }
      : {}),
    ...(requires ? { requires } : {}),
  };
}

function cutoverCompatRunnerStage(
  marker: string,
  options: { candidateMode?: "contract" | "upstream"; candidateBaseUrl?: string } = {},
): Record<string, unknown> {
  const candidateMode = options.candidateMode ?? "contract";
  const candidateBaseUrl = options.candidateBaseUrl ?? "http://127.0.0.1/api/v3";
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const crypto = require('node:crypto');",
    `fs.appendFileSync(process.env.LOOM_CUTOVER_RUN_LOG, ${JSON.stringify(`${marker}\n`)});`,
    "const out = path.join(process.cwd(), 'reports', 'agent-git-service-compat');",
    "fs.mkdirSync(out, { recursive: true });",
    "const hash = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');",
    "const baseline = JSON.stringify({ schemaVersion: 'agent-git-service-contract-probe/v1', ok: true, requestsTokenFree: true }, null, 2);",
    "const candidate = JSON.stringify({ schemaVersion: 'agent-git-service-contract-probe/v1', ok: true, requestsTokenFree: true }, null, 2);",
    "const comparison = JSON.stringify({ schemaVersion: 'agent-git-service-contract-comparison/v1', ok: true, tokenFree: true }, null, 2);",
    "fs.writeFileSync(path.join(out, 'baseline.json'), baseline);",
    "fs.writeFileSync(path.join(out, 'candidate.json'), candidate);",
    "fs.writeFileSync(path.join(out, 'compare.json'), comparison);",
    `fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ schemaVersion: 'agent-git-service-compat-rehearsal/v1', tokenFree: true, generatedAt: '2026-07-01T00:00:00.000Z', candidateMode: ${JSON.stringify(candidateMode)}, comparisonOk: true, baselineBaseUrl: 'http://127.0.0.1/api/v3', candidateBaseUrl: ${JSON.stringify(candidateBaseUrl)}, artifacts: { baseline: 'baseline.json', candidate: 'candidate.json', comparison: 'compare.json' }, artifactSha256: { baseline: hash(baseline), candidate: hash(candidate), comparison: hash(comparison) } }, null, 2));`,
  ].join(" ");
  return {
    id: "agent-git-service-compat-rehearsal",
    command: "loom harness agent-git-service-compat-rehearsal",
    commandArgs: [process.execPath, "-e", script],
    executionMode: "read-only",
    approvalRequired: false,
    tokenFree: true,
  };
}

test("loom harness run mounts Docker persistent home root", async () => {
  const root = await tempDir("loom-cli-docker-home");
  const cwd = join(root, "work");
  const homeRoot = join(root, "homes");
  const binDir = join(root, "bin");
  const logPath = join(root, "docker-args.jsonl");
  await mkdir(cwd, { recursive: true });
  await mkdir(binDir, { recursive: true });
  const scriptPath = await writeFinishScript(cwd);
  const dockerPath = join(binDir, "docker");
  await writeFile(
    dockerPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.appendFileSync(process.env.LOOM_FAKE_DOCKER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(dockerPath, 0o755);

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "run",
      "verify docker home",
      "--cwd",
      cwd,
      "--script",
      scriptPath,
      "--verify",
      "printf docker-home",
      "--executor",
      "docker",
      "--executor-image",
      "loom-workspace:test",
      "--executor-home-root",
      homeRoot,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOOM_FAKE_DOCKER_LOG: logPath,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      reject: false,
    },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const runArgs = calls.find((args) => args.includes("run"));
  assert.ok(runArgs);
  assert.ok(runArgs.includes(`type=bind,source=${join(homeRoot, "local")},target=/home/dev`));
  assert.ok(runArgs.includes("HOME=/home/dev"));
  assert.deepEqual(await readdir(homeRoot), ["local"]);
});

test("loom harness run passes Coder template parameters when creating workspaces", async () => {
  const root = await tempDir("loom-cli-coder-params");
  const cwd = join(root, "proj-a");
  const binDir = join(root, "bin");
  const logPath = join(root, "coder-args.jsonl");
  await mkdir(cwd, { recursive: true });
  const scriptPath = await writeFinishScript(cwd);
  const coderPath = join(binDir, "coder");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    coderPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.appendFileSync(process.env.LOOM_FAKE_CODER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
      "process.exit(process.argv[2] === 'show' ? 1 : 0);",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(coderPath, 0o755);

  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "run",
      "prepare coder workspace",
      "--cwd",
      cwd,
      "--script",
      scriptPath,
      "--executor",
      "coder",
      "--executor-workspace",
      "loom-{tenant}",
      "--executor-template",
      "loom",
      "--executor-template-param",
      "auth_mode=subscription",
      "--executor-cpus",
      "0.5",
      "--executor-memory",
      "512m",
      "--executor-pids-limit",
      "64",
      "--executor-template-param",
      "owner={tenant}",
      "--executor-template-param",
      "project={project}",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOOM_FAKE_CODER_LOG: logPath,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      reject: false,
    },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls[1], [
    "create",
    "--template",
    "loom",
    "--yes",
    "--use-parameter-defaults",
    "--parameter",
    "auth_mode=subscription",
    "--parameter",
    "owner=local",
    "--parameter",
    "project=proj-a",
    "--parameter",
    "cpus=0.5",
    "--parameter",
    "memory_gb=0.5",
    "--parameter",
    "pids_limit=64",
    "loom-local",
  ]);
});

test("loom harness serve passes tenant policy Coder template parameters when creating workspaces", async () => {
  const root = await tempDir("loom-cli-coder-policy-params");
  const workspaceRoot = join(root, "workspaces");
  const binDir = join(root, "bin");
  const logPath = join(root, "coder-args.jsonl");
  const coderPath = join(binDir, "coder");
  await mkdir(join(workspaceRoot, "alice", ".loom"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(workspaceRoot, "alice", ".loom", "policy.json"),
    JSON.stringify({
      schemaVersion: 1,
      executorTemplateParameters: ["auth_mode=subscription", "owner={tenant}"],
      limits: { executorCpus: 0.5, executorMemory: "512m", executorPidsLimit: 64 },
    }),
    "utf8",
  );
  await writeFile(
    coderPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.appendFileSync(process.env.LOOM_FAKE_CODER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
      "process.exit(process.argv[2] === 'show' ? 1 : 0);",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(coderPath, 0o755);

  const port = await freePort();
  const server = execa(
    process.execPath,
    [
      "dist/index.js",
      "harness",
      "serve",
      "--workspace-root",
      workspaceRoot,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--executor",
      "coder",
      "--executor-workspace",
      "loom-{tenant}",
      "--executor-template",
      "loom",
      "--executor-template-param",
      "auth_mode=gateway",
      "--executor-remote-cwd",
      "/home/dev/projects/{project}",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOOM_FAKE_CODER_LOG: logPath,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      reject: false,
    },
  );

  try {
    await waitForStdout(server, /"url":/);
    const response = await fetch(`http://127.0.0.1:${port}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenant: "alice",
        project: "proj-a",
        goal: "prepare coder policy workspace",
        script: [{ message: "finish", finish: true }],
        skills: ["coding"],
      }),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).status, "passed");

    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls[1], [
      "create",
      "--template",
      "loom",
      "--yes",
      "--use-parameter-defaults",
      "--parameter",
      "auth_mode=subscription",
      "--parameter",
      "owner=alice",
      "--parameter",
      "cpus=0.5",
      "--parameter",
      "memory_gb=0.5",
      "--parameter",
      "pids_limit=64",
      "loom-alice",
    ]);
  } finally {
    server.kill("SIGTERM");
    await server.catch(() => undefined);
  }
});


async function writeFinishScript(cwd: string): Promise<string> {
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify([{ message: "finish", finish: true }]), "utf8");
  return scriptPath;
}

async function readOnlyRun(cwd: string): Promise<{ summary: any; events: any[] }> {
  const runs = await readdir(join(cwd, ".loom", "runs"));
  assert.equal(runs.length, 1);
  const runDir = join(cwd, ".loom", "runs", runs[0]);
  const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8"));
  const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { summary, events };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForStdout(process: any, pattern: RegExp, timeoutMs = 5000): Promise<void> {
  let buffer = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), timeoutMs);
    process.stdout?.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (pattern.test(buffer)) {
        clearTimeout(timer);
        resolve();
      }
    });
    process.once?.("exit", (code: number) => {
      clearTimeout(timer);
      reject(new Error(`process exited before ${pattern}: ${code}`));
    });
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
