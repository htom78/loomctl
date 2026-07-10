import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { projectCloneTarget, withLoomStopHook, workspaceCreateArgs } from "../src/commands.js";
import type { LoomConfig } from "../src/config.js";

function config(overrides: Partial<LoomConfig> = {}): LoomConfig {
  return {
    gatewayUrl: "http://gateway.internal:4000",
    gatewayKeyEnv: "LOOM_GATEWAY_KEY",
    giteaUrl: "http://git.internal:3000",
    workspaceRoot: "/home/dev/projects",
    skillsRepo: "/home/dev/projects/_skills",
    engine: "claude",
    models: { default: "kimi-k2.6" },
    runtime: "runsc",
    resources: { cpus: 2, memory: "4g" },
    network: "loom-net",
    workspaceImage: "loom/workspace:test",
    idleStopMinutes: 60,
    defaultAuthMode: "gateway",
    ...overrides,
  };
}

test("workspaceCreateArgs builds a hardened gateway workspace", () => {
  assert.deepEqual(workspaceCreateArgs(config(), "alice", { gatewayKey: "dev-key" }), [
    "run",
    "-d",
    "--name",
    "loom-alice",
    "--restart",
    "unless-stopped",
    "-v",
    "loom-home-alice:/home/dev",
    "-w",
    "/home/dev/projects",
    "--cpus",
    "2",
    "--memory",
    "4g",
    "--pids-limit",
    "256",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    "loom-net",
    "--runtime",
    "runsc",
    "-e",
    "ANTHROPIC_BASE_URL=http://gateway.internal:4000",
    "-e",
    "ANTHROPIC_AUTH_TOKEN=dev-key",
    "-e",
    "LOOM_AUTH_MODE=gateway",
    "loom/workspace:test",
    "sleep",
    "infinity",
  ]);

  for (const name of ["", "../alice", "-alice", ".alice", "alice bob"]) {
    assert.throws(() => workspaceCreateArgs(config(), name), /tenant name|workspace name/);
  }
});

test("workspaceCreateArgs does not inject model credentials in subscription mode", () => {
  const args = workspaceCreateArgs(config({ defaultAuthMode: "subscription" }), "alice", { gatewayKey: "dev-key" });

  assert.ok(!args.some((arg) => arg.startsWith("ANTHROPIC_BASE_URL=")));
  assert.ok(!args.some((arg) => arg.startsWith("ANTHROPIC_AUTH_TOKEN=")));
  assert.ok(args.includes("LOOM_AUTH_MODE=subscription"));
});

test("projectCloneTarget derives a safe project directory from a repo", () => {
  assert.deepEqual(projectCloneTarget(config(), "http://git.internal/team/proj-a.git"), {
    repo: "http://git.internal/team/proj-a.git",
    name: "proj-a",
    dest: join("/home/dev/projects", "proj-a"),
  });

  for (const repo of ["", "--upload-pack=evil", "http://git/team/-bad.git", "http://git/team/a b.git", "http://git/team/.git"]) {
    assert.throws(() => projectCloneTarget(config(), repo), /project repo|project name/);
  }
});

test("withLoomStopHook preserves existing Stop hooks and is idempotent", () => {
  const settings = {
    theme: "dark",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "existing-stop-hook" }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "existing-pre-hook" }] }],
    },
  };

  const once = withLoomStopHook(settings);
  const twice = withLoomStopHook(once);

  assert.deepEqual(twice, {
    theme: "dark",
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: "existing-stop-hook" }] },
        { hooks: [{ type: "command", command: "loom-stop-hook" }] },
      ],
      PreToolUse: [{ hooks: [{ type: "command", command: "existing-pre-hook" }] }],
    },
  });
});
