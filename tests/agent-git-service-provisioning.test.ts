import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  agentGitServiceProjectProvisioningReceiptPath,
  provisionAgentGitServiceProjectAgent,
  readAgentGitServiceProjectProvisioningReceipt,
} from "../src/harness/agent-git-service-provisioning.js";

test("provisionAgentGitServiceProjectAgent registers an AGS agent, grants repo access, and stores only non-secret receipt data", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "loom-ags-provision-"));
  await mkdir(join(workspaceRoot, "alice", "lesson-vas"), { recursive: true });
  const calls: string[] = [];

  const result = await provisionAgentGitServiceProjectAgent({
    workspaceRoot,
    tenant: "alice",
    project: "lesson-vas",
    baseUrl: "https://git.example/api/v3",
    adminToken: "admin-secret",
    repo: "team/app",
    agentPrefixLogin: "loom-alice-lesson-vas",
    defaultRepoName: "lesson-vas",
    permission: "write",
    tokenEnvName: "LOOM_ALICE_LESSON_VAS_AGENT_GIT_SERVICE_TOKEN",
    now: () => new Date("2026-06-30T00:00:00.000Z"),
    createAgent: async (options) => {
      calls.push("create");
      assert.deepEqual(options, {
        baseUrl: "https://git.example/api/v3",
        prefixLogin: "loom-alice-lesson-vas",
        defaultRepoName: "lesson-vas",
      });
      return {
        login: "loom-agent-1",
        token: "agent-secret",
        repoFullName: "loom-agent-1/lesson-vas",
      };
    },
    grantRepoAccess: async (options) => {
      calls.push("grant");
      assert.deepEqual(options, {
        baseUrl: "https://git.example/api/v3",
        token: "admin-secret",
        repo: "team/app",
        agentLogin: "loom-agent-1",
        permission: "write",
      });
      return {
        repo: "team/app",
        agentLogin: "loom-agent-1",
        permission: "write",
        status: "invited",
        invitationId: "501",
        url: "https://git.example/team/app/invitations/501",
      };
    },
  });

  assert.deepEqual(calls, ["create", "grant"]);
  assert.equal(result.agentToken, "agent-secret");
  assert.equal(
    result.receiptPath,
    join(workspaceRoot, "alice", "lesson-vas", ".loom", "control-plane", "agent-git-service", "provisioning.json"),
  );
  assert.deepEqual(result.receipt, {
    schemaVersion: 1,
    provider: "agent-git-service",
    tenant: "alice",
    project: "lesson-vas",
    baseUrl: "https://git.example/api/v3",
    repo: "team/app",
    agentLogin: "loom-agent-1",
    agentRepoFullName: "loom-agent-1/lesson-vas",
    permission: "write",
    grantStatus: "invited",
    grantInvitationId: "501",
    grantUrl: "https://git.example/team/app/invitations/501",
    tokenEnvName: "LOOM_ALICE_LESSON_VAS_AGENT_GIT_SERVICE_TOKEN",
    tokenMaterial: "returned-only",
    provisionedAt: "2026-06-30T00:00:00.000Z",
  });

  const raw = await readFile(result.receiptPath, "utf8");
  assert.equal(raw.includes("agent-secret"), false);
  assert.equal(raw.includes("admin-secret"), false);
  assert.equal(raw.includes("tokenHash"), false);
  assert.deepEqual(JSON.parse(raw), result.receipt);
  assert.deepEqual(
    await readAgentGitServiceProjectProvisioningReceipt(workspaceRoot, "alice", "lesson-vas"),
    result.receipt,
  );
});

test("provisionAgentGitServiceProjectAgent accepts direct grants without invitation metadata", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "loom-ags-provision-direct-"));
  await mkdir(join(workspaceRoot, "alice", "proj-a"), { recursive: true });

  const result = await provisionAgentGitServiceProjectAgent({
    workspaceRoot,
    tenant: "alice",
    project: "proj-a",
    baseUrl: "https://git.example",
    adminToken: "admin-secret",
    repo: "team/app",
    tokenEnvName: "LOOM_ALICE_PROJ_A_AGENT_TOKEN",
    now: () => new Date("2026-06-30T01:00:00.000Z"),
    createAgent: async () => ({
      login: "loom-agent-2",
      token: "agent-secret",
      repoFullName: "loom-agent-2/proj-a",
    }),
    grantRepoAccess: async () => ({
      repo: "team/app",
      agentLogin: "loom-agent-2",
      permission: "write",
      status: "granted",
    }),
  });

  assert.deepEqual(result.receipt, {
    schemaVersion: 1,
    provider: "agent-git-service",
    tenant: "alice",
    project: "proj-a",
    baseUrl: "https://git.example",
    repo: "team/app",
    agentLogin: "loom-agent-2",
    agentRepoFullName: "loom-agent-2/proj-a",
    permission: "write",
    grantStatus: "granted",
    tokenEnvName: "LOOM_ALICE_PROJ_A_AGENT_TOKEN",
    tokenMaterial: "returned-only",
    provisionedAt: "2026-06-30T01:00:00.000Z",
  });
});

test("provisionAgentGitServiceProjectAgent rejects unsafe tenant or project names before calling AGS", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "loom-ags-provision-unsafe-"));
  let called = false;
  const createAgent = async () => {
    called = true;
    return { login: "agent", token: "agent-secret", repoFullName: "agent/workspace" };
  };

  await assert.rejects(
    () => provisionAgentGitServiceProjectAgent({
      workspaceRoot,
      tenant: "../alice",
      project: "proj-a",
      baseUrl: "https://git.example",
      adminToken: "admin-secret",
      repo: "team/app",
      tokenEnvName: "LOOM_AGENT_TOKEN",
      createAgent,
    }),
    /tenant must contain only letters, numbers, dot, underscore, or dash/,
  );
  assert.equal(called, false);

  await assert.rejects(
    () => provisionAgentGitServiceProjectAgent({
      workspaceRoot,
      tenant: "alice",
      project: ".loom",
      baseUrl: "https://git.example",
      adminToken: "admin-secret",
      repo: "team/app",
      tokenEnvName: "LOOM_AGENT_TOKEN",
      createAgent,
    }),
    /project is reserved/,
  );
  assert.equal(called, false);
});

test("agentGitServiceProjectProvisioningReceiptPath rejects unsafe names", () => {
  assert.throws(
    () => agentGitServiceProjectProvisioningReceiptPath("/tmp/work", "alice", "../proj"),
    /project must contain only letters, numbers, dot, underscore, or dash/,
  );
});
