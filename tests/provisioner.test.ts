import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { LoomConfig } from "../src/config.js";
import * as provisioner from "../src/provisioner.js";

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
    workspaceImage: "loom/workspace:latest",
    idleStopMinutes: 60,
    defaultAuthMode: "gateway",
    ...overrides,
  };
}

test("loomd provisioner builds a hardened per-tenant container", () => {
  const createWorkspaceRunArgs = (provisioner as any).createWorkspaceRunArgs;
  assert.equal(typeof createWorkspaceRunArgs, "function");

  const args = createWorkspaceRunArgs(config(), {
    user: "alice",
    authMode: "gateway",
    gatewayKey: "alice-key",
  });

  assert.deepEqual(args, [
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
    "ANTHROPIC_AUTH_TOKEN=alice-key",
    "-e",
    "LOOM_AUTH_MODE=gateway",
    "loom/workspace:latest",
    "sleep",
    "infinity",
  ]);
});

test("loomd provisioner rejects unsafe Docker network modes", () => {
  const createWorkspaceRunArgs = (provisioner as any).createWorkspaceRunArgs;
  assert.equal(typeof createWorkspaceRunArgs, "function");

  for (const network of ["host", "bridge", "container:other"]) {
    assert.throws(
      () => createWorkspaceRunArgs(config({ network }), { user: "alice", authMode: "subscription" }),
      /unsafe docker network mode/,
    );
  }
});

test("loomd provisioner rejects unsafe tenant names", () => {
  const createWorkspaceRunArgs = (provisioner as any).createWorkspaceRunArgs;
  assert.equal(typeof createWorkspaceRunArgs, "function");

  for (const user of ["", "../alice", "alice/bob", "-alice", ".alice", "alice bob"]) {
    assert.throws(
      () => createWorkspaceRunArgs(config(), { user, authMode: "subscription" }),
      /tenant name/,
    );
    assert.throws(
      () => provisioner.beginTenantSession(user),
      /tenant name/,
    );
  }
});

test("loomd idle GC keeps tenants with active sessions running", async () => {
  await withStateDir(async () => {
    const session = provisioner.beginTenantSession("alice", {
      now: () => new Date("2026-06-26T00:00:00.000Z"),
      pid: 111,
    });
    const stopped: string[] = [];

    const result = await provisioner.stopIdleTenants(
      config({ idleStopMinutes: 30 }),
      [{ name: "alice" }],
      {
        now: () => new Date("2026-06-26T01:00:00.000Z"),
        containerExists: async () => true,
        stopTenant: async (user) => {
          stopped.push(user);
        },
        isPidAlive: () => true,
      },
    );

    assert.deepEqual(result, []);
    assert.deepEqual(stopped, []);
    assert.equal(provisioner.readTenantActivity("alice", { isPidAlive: () => true }).activeSessions, 1);
    provisioner.endTenantSession("alice", session.id, {
      now: () => new Date("2026-06-26T01:00:00.000Z"),
    });
  });
});

test("loomd idle GC stops tenants idle past the configured timeout", async () => {
  await withStateDir(async () => {
    const session = provisioner.beginTenantSession("alice", {
      now: () => new Date("2026-06-26T00:00:00.000Z"),
      pid: 111,
    });
    provisioner.endTenantSession("alice", session.id, {
      now: () => new Date("2026-06-26T00:05:00.000Z"),
    });
    const stopped: string[] = [];

    const early = await provisioner.stopIdleTenants(
      config({ idleStopMinutes: 60 }),
      [{ name: "alice" }],
      {
        now: () => new Date("2026-06-26T01:04:00.000Z"),
        containerExists: async () => true,
        stopTenant: async (user) => {
          stopped.push(user);
        },
      },
    );
    assert.deepEqual(early, []);

    const result = await provisioner.stopIdleTenants(
      config({ idleStopMinutes: 60 }),
      [{ name: "alice" }],
      {
        now: () => new Date("2026-06-26T01:06:00.000Z"),
        containerExists: async () => true,
        stopTenant: async (user) => {
          stopped.push(user);
        },
      },
    );

    assert.deepEqual(result, ["alice"]);
    assert.deepEqual(stopped, ["alice"]);
  });
});

test("loomd idle GC prunes stale session markers before stopping idle tenants", async () => {
  await withStateDir(async () => {
    provisioner.beginTenantSession("alice", {
      now: () => new Date("2026-06-26T00:00:00.000Z"),
      pid: 111,
    });
    const stopped: string[] = [];

    const result = await provisioner.stopIdleTenants(
      config({ idleStopMinutes: 60 }),
      [{ name: "alice" }],
      {
        now: () => new Date("2026-06-26T02:00:00.000Z"),
        containerExists: async () => true,
        stopTenant: async (user) => {
          stopped.push(user);
        },
        isPidAlive: () => false,
      },
    );

    const activity = provisioner.readTenantActivity("alice", { isPidAlive: () => false });
    assert.equal(activity.activeSessions, 0);
    assert.equal(activity.lastActiveAt, "2026-06-26T00:00:00.000Z");
    assert.deepEqual(result, ["alice"]);
    assert.deepEqual(stopped, ["alice"]);
  });
});

test("loomd ps status rows include container and tenant activity", async () => {
  await withStateDir(async () => {
    provisioner.beginTenantSession("alice", {
      now: () => new Date("2026-06-26T00:00:00.000Z"),
      pid: 111,
    });
    const bobSession = provisioner.beginTenantSession("bob", {
      now: () => new Date("2026-06-26T00:05:00.000Z"),
      pid: 222,
    });
    provisioner.endTenantSession("bob", bobSession.id, {
      now: () => new Date("2026-06-26T00:10:00.000Z"),
    });

    const rows = await provisioner.listTenantWorkspaceStatuses(
      [{ name: "alice" }, { name: "bob" }, { name: "carol" }],
      {
        now: () => new Date("2026-06-26T00:40:00.000Z"),
        isPidAlive: (pid) => pid === 111,
        dockerContainers: async () => [
          { name: "loom-alice", status: "Up 40 minutes", runningFor: "40 minutes" },
          { name: "loom-bob", status: "Exited (0)", runningFor: "35 minutes" },
        ],
      },
    );

    assert.deepEqual(rows, [
      {
        user: "alice",
        container: "loom-alice",
        status: "Up 40 minutes",
        runningFor: "40 minutes",
        activeSessions: 1,
        lastActiveAt: undefined,
        idleForMs: undefined,
      },
      {
        user: "bob",
        container: "loom-bob",
        status: "Exited (0)",
        runningFor: "35 minutes",
        activeSessions: 0,
        lastActiveAt: "2026-06-26T00:10:00.000Z",
        idleForMs: 1_800_000,
      },
      {
        user: "carol",
        container: "loom-carol",
        status: "missing",
        runningFor: "-",
        activeSessions: 0,
        lastActiveAt: undefined,
        idleForMs: undefined,
      },
    ]);

    const table = provisioner.formatTenantWorkspaceStatuses(rows);
    assert.match(table, /USER\tCONTAINER\tSTATUS\tRUNNING_FOR\tACTIVE_SESSIONS\tLAST_ACTIVE\tIDLE_FOR/);
    assert.match(table, /alice\tloom-alice\tUp 40 minutes\t40 minutes\t1\t-\t-/);
    assert.match(table, /bob\tloom-bob\tExited \(0\)\t35 minutes\t0\t2026-06-26T00:10:00.000Z\t30m/);
    assert.match(table, /carol\tloom-carol\tmissing\t-\t0\t-\t-/);
  });
});

async function withStateDir(fn: () => Promise<void>): Promise<void> {
  const previous = process.env.LOOM_STATE_DIR;
  process.env.LOOM_STATE_DIR = mkdtempSync(join(tmpdir(), "loomd-state-"));
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.LOOM_STATE_DIR;
    else process.env.LOOM_STATE_DIR = previous;
  }
}
