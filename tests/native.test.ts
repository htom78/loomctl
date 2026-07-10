import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execa } from "execa";

import type { LoomConfig } from "../src/config.js";
import { runGoal } from "../src/native.js";

async function tempDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${name}-`));
}

function config(workspaceRoot: string, overrides: Partial<LoomConfig> = {}): LoomConfig {
  return {
    gatewayUrl: "http://gateway.internal:4000",
    gatewayKeyEnv: "LOOM_GATEWAY_KEY",
    giteaUrl: "http://git.internal:3000",
    workspaceRoot,
    skillsRepo: join(workspaceRoot, "_skills"),
    engine: "codex",
    models: { default: "kimi-k2.6", reasoning: "glm-5.1" },
    runtime: "runsc",
    resources: { cpus: 2, memory: "4g" },
    network: "loom-net",
    workspaceImage: "loom/workspace:latest",
    idleStopMinutes: 60,
    defaultAuthMode: "gateway",
    ...overrides,
  };
}

async function initProjectRepo(workspaceRoot: string, project: string): Promise<string> {
  const projectRoot = join(workspaceRoot, project);
  await mkdir(projectRoot, { recursive: true });
  await execa("git", ["init"], { cwd: projectRoot });
  await execa("git", ["config", "user.email", "loom@example.test"], { cwd: projectRoot });
  await execa("git", ["config", "user.name", "Loom Test"], { cwd: projectRoot });
  await writeFile(join(projectRoot, "README.md"), "# app\n", "utf8");
  await execa("git", ["add", "README.md"], { cwd: projectRoot });
  await execa("git", ["commit", "-m", "initial"], { cwd: projectRoot });
  await execa("git", ["branch", "-M", "main"], { cwd: projectRoot });
  return projectRoot;
}

async function installFakeNativeCli(binDir: string, name: string, capturePath: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, name);
  await writeFile(
    binPath,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  env: {
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    token: process.env.ANTHROPIC_AUTH_TOKEN,
    model: process.env.ANTHROPIC_MODEL,
    context: process.env.LOOM_NATIVE_GOAL_CONTEXT,
    runId: process.env.LOOM_RUN_ID,
    runDir: process.env.LOOM_RUN_DIR,
    issue: process.env.LOOM_NATIVE_GOAL_ISSUE,
    issueUrl: process.env.LOOM_NATIVE_GOAL_ISSUE_URL,
    hookIssue: process.env.LOOM_ISSUE,
    hookIssueUrl: process.env.LOOM_ISSUE_URL,
    skills: process.env.LOOM_NATIVE_GOAL_SKILLS,
    hookSkills: process.env.LOOM_SKILLS
  }
}));
`,
    "utf8",
  );
  await chmod(binPath, 0o755);
}

test("native goal prepares an isolated git worktree before launching the native CLI", async () => {
  const workspaceRoot = await tempDir("loom-native-goal");
  const projectRoot = await initProjectRepo(workspaceRoot, "proj-a");
  const binDir = await tempDir("loom-native-bin");
  const capturePath = join(workspaceRoot, "capture.json");
  await installFakeNativeCli(binDir, "codex", capturePath);

  const oldPath = process.env.PATH;
  const oldGatewayKey = process.env.LOOM_GATEWAY_KEY;
  process.env.PATH = `${binDir}:${oldPath ?? ""}`;
  process.env.LOOM_GATEWAY_KEY = "dev-virtual-key";
  try {
    const code = await runGoal(config(workspaceRoot), {
      project: "proj-a",
      worktree: "task/123",
      condition: "tests pass",
      modelTier: "reasoning",
      skills: ["coding", "vas-lite"],
    });
    assert.equal(code, 0);
  } finally {
    process.env.PATH = oldPath;
    if (oldGatewayKey === undefined) {
      delete process.env.LOOM_GATEWAY_KEY;
    } else {
      process.env.LOOM_GATEWAY_KEY = oldGatewayKey;
    }
  }

  const logicalCwd = join(projectRoot, ".wt", "task-123");
  const expectedCwd = await realpath(logicalCwd);
  const expectedContextPath = join(logicalCwd, ".loom", "native-goal.json");
  const captured = JSON.parse(await readFile(capturePath, "utf8"));
  assert.equal(captured.cwd, expectedCwd);
  assert.deepEqual(captured.argv, ["goal", "tests pass"]);
  assert.equal(captured.env.baseUrl, "http://gateway.internal:4000");
  assert.equal(captured.env.token, "dev-virtual-key");
  assert.equal(captured.env.model, "glm-5.1");
  assert.equal(captured.env.context, expectedContextPath);
  assert.match(captured.env.runId, /^native-\d{4}-\d{2}-\d{2}T/);
  assert.equal(captured.env.runDir, logicalCwd);
  assert.equal(captured.env.skills, "coding\nvas-lite");
  assert.equal(captured.env.hookSkills, "coding\nvas-lite");

  const branch = await execa("git", ["branch", "--show-current"], { cwd: expectedCwd });
  assert.equal(branch.stdout, "loom/task-123");

  const context = JSON.parse(await readFile(expectedContextPath, "utf8"));
  assert.equal(context.project, "proj-a");
  assert.equal(context.runId, captured.env.runId);
  assert.equal(context.worktree, "task-123");
  assert.equal(context.branch, "loom/task-123");
  assert.equal(context.cwd, logicalCwd);
  assert.equal(context.engine, "codex");
  assert.equal(context.condition, "tests pass");
  assert.equal(context.modelTier, "reasoning");
  assert.equal(context.model, "glm-5.1");
  assert.deepEqual(context.skills, ["coding", "vas-lite"]);
  assert.equal(context.sessionMode, "cold_start");
  assert.equal(context.attempt, 1);
  assert.equal(context.status, "passed");
  assert.equal(context.exitCode, 0);
  assert.equal(JSON.stringify(context).includes("dev-virtual-key"), false);
});

test("native goal records linked issue metadata without secrets", async () => {
  const workspaceRoot = await tempDir("loom-native-goal-issue");
  const projectRoot = await initProjectRepo(workspaceRoot, "proj-a");
  const binDir = await tempDir("loom-native-bin-issue");
  const capturePath = join(workspaceRoot, "capture.json");
  await installFakeNativeCli(binDir, "codex", capturePath);

  const oldPath = process.env.PATH;
  const oldGatewayKey = process.env.LOOM_GATEWAY_KEY;
  process.env.PATH = `${binDir}:${oldPath ?? ""}`;
  process.env.LOOM_GATEWAY_KEY = "dev-virtual-key";
  try {
    assert.equal(await runGoal(config(workspaceRoot), {
      project: "proj-a",
      worktree: "task-42",
      condition: "tests pass",
      issue: "team/proj-a#42",
    }), 0);
  } finally {
    process.env.PATH = oldPath;
    if (oldGatewayKey === undefined) {
      delete process.env.LOOM_GATEWAY_KEY;
    } else {
      process.env.LOOM_GATEWAY_KEY = oldGatewayKey;
    }
  }

  const expectedContextPath = join(projectRoot, ".wt", "task-42", ".loom", "native-goal.json");
  const captured = JSON.parse(await readFile(capturePath, "utf8"));
  assert.match(captured.env.runId, /^native-\d{4}-\d{2}-\d{2}T/);
  assert.equal(captured.env.runDir, join(projectRoot, ".wt", "task-42"));
  assert.equal(captured.env.issue, "team/proj-a#42");
  assert.equal(captured.env.issueUrl, "http://git.internal:3000/team/proj-a/issues/42");
  assert.equal(captured.env.hookIssue, "team/proj-a#42");
  assert.equal(captured.env.hookIssueUrl, "http://git.internal:3000/team/proj-a/issues/42");
  assert.equal(captured.env.context, expectedContextPath);

  const context = JSON.parse(await readFile(expectedContextPath, "utf8"));
  assert.equal(context.runId, captured.env.runId);
  assert.equal(context.issue, "team/proj-a#42");
  assert.equal(context.issueUrl, "http://git.internal:3000/team/proj-a/issues/42");
  assert.equal(JSON.stringify(context).includes("dev-virtual-key"), false);
});

test("native goal records cwd-based resume intent for existing worktrees", async () => {
  const workspaceRoot = await tempDir("loom-native-goal-resume");
  const projectRoot = await initProjectRepo(workspaceRoot, "proj-a");
  const binDir = await tempDir("loom-native-bin-resume");
  const capturePath = join(workspaceRoot, "capture.json");
  await installFakeNativeCli(binDir, "codex", capturePath);

  const oldPath = process.env.PATH;
  const oldGatewayKey = process.env.LOOM_GATEWAY_KEY;
  process.env.PATH = `${binDir}:${oldPath ?? ""}`;
  process.env.LOOM_GATEWAY_KEY = "dev-virtual-key";
  try {
    assert.equal(await runGoal(config(workspaceRoot), {
      project: "proj-a",
      worktree: "task-456",
      condition: "first pass",
    }), 0);
    assert.equal(await runGoal(config(workspaceRoot), {
      project: "proj-a",
      worktree: "task-456",
      condition: "second pass",
    }), 0);
  } finally {
    process.env.PATH = oldPath;
    if (oldGatewayKey === undefined) {
      delete process.env.LOOM_GATEWAY_KEY;
    } else {
      process.env.LOOM_GATEWAY_KEY = oldGatewayKey;
    }
  }

  const expectedCwd = await realpath(join(projectRoot, ".wt", "task-456"));
  const context = JSON.parse(await readFile(join(expectedCwd, ".loom", "native-goal.json"), "utf8"));
  assert.equal(context.sessionMode, "resume_by_cwd");
  assert.equal(context.attempt, 2);
  assert.equal(context.condition, "second pass");
  assert.equal(context.status, "passed");
  assert.equal(context.exitCode, 0);
  assert.match(context.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(context.endedAt, /^\d{4}-\d{2}-\d{2}T/);

  const captured = JSON.parse(await readFile(capturePath, "utf8"));
  assert.equal(captured.cwd, expectedCwd);
  assert.deepEqual(captured.argv, ["goal", "second pass"]);
  assert.equal(captured.env.runId, context.runId);
  assert.equal(captured.env.runDir, join(projectRoot, ".wt", "task-456"));
});

test("native goal rejects unsafe project names before spawning the native CLI", async () => {
  const workspaceRoot = await tempDir("loom-native-unsafe-project");

  await assert.rejects(
    () => runGoal(config(workspaceRoot), {
      project: "../outside",
      worktree: "task-123",
      condition: "tests pass",
    }),
    /project name/,
  );
});

test("native goal rejects invalid issue refs before spawning the native CLI", async () => {
  const workspaceRoot = await tempDir("loom-native-unsafe-issue");

  await assert.rejects(
    () => runGoal(config(workspaceRoot), {
      project: "proj-a",
      worktree: "task-123",
      condition: "tests pass",
      issue: "team/proj-a",
    }),
    /issue must be formatted/,
  );
});

test("native goal rejects worktree ids that would create unsafe git refs", async () => {
  const workspaceRoot = await tempDir("loom-native-unsafe-worktree");
  await mkdir(join(workspaceRoot, "proj-a"), { recursive: true });

  await assert.rejects(
    () => runGoal(config(workspaceRoot), {
      project: "proj-a",
      worktree: "task..bad",
      condition: "tests pass",
    }),
    /worktree.*safe git ref/,
  );
});
