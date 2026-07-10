import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAgentGitServiceOperatorCockpitQueueBackend,
  normalizeAgentGitServiceOperatorCockpitQueuePath,
  normalizeAgentGitServiceOperatorCockpitQueueRepo,
  type OperatorCockpitExecutionQueueItem,
} from "../src/harness/operator-cockpit-queue-backend.js";
import { startAgentGitServiceContractServer } from "./support/agent-git-service-contract.js";

async function tempDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${name}-`));
}

test("agent-git-service operator cockpit queue backend validates repo and contents path", () => {
  assert.equal(normalizeAgentGitServiceOperatorCockpitQueueRepo(" team/loom-ops "), "team/loom-ops");
  assert.equal(normalizeAgentGitServiceOperatorCockpitQueuePath(undefined), ".loom/operator-cockpit-queue/store.json");
  assert.equal(normalizeAgentGitServiceOperatorCockpitQueuePath("ops/queue.json"), "ops/queue.json");
  assert.throws(() => normalizeAgentGitServiceOperatorCockpitQueueRepo("team/../loom-ops"), /safe owner\/repo/);
  assert.throws(() => normalizeAgentGitServiceOperatorCockpitQueuePath("../store.json"), /safe relative/);
  assert.throws(() => normalizeAgentGitServiceOperatorCockpitQueuePath("/store.json"), /safe relative/);
});

test("agent-git-service operator cockpit queue backend persists, claims, snapshots, and removes queue items", async () => {
  const agentGitService = await startAgentGitServiceContractServer();
  const dir = await tempDir("loom-ags-operator-cockpit-queue-backend");
  const backend = createAgentGitServiceOperatorCockpitQueueBackend({
    baseUrl: agentGitService.baseUrl,
    token: "admin-token",
    repo: "team/loom-ops",
    path: ".loom/operator-cockpit-queue/store.json",
  });
  const item: OperatorCockpitExecutionQueueItem = {
    queueId: "ags-queue-001",
    tenant: "alice",
    dir,
    enqueuedAt: "2026-07-10T00:00:00.000Z",
    status: "queued",
    clientId: "cockpit-ui",
    ciTarget: { repo: "team/app", ref: "main" },
    maxSteps: 1,
    requireExternalStaging: true,
    requireOperatorApprovals: true,
    requireAgentGitService: true,
  };

  try {
    await backend.persist(item);
    assert.equal(await backend.itemExists(item), true);
    assert.deepEqual(await backend.recover(dir), [{ ...item, access: { actor: "system", role: "admin" } }]);

    const claim = await backend.acquireClaim(item);
    assert.ok(claim);
    assert.equal(claim.tokenFree, true);
    assert.equal(claim.queueId, item.queueId);
    assert.equal(claim.tenant, item.tenant);
    assert.equal(claim.dir, item.dir);
    assert.equal(await backend.acquireClaim(item), undefined);

    const snapshot = await backend.snapshot([item], "alice", dir);
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]?.queueId, item.queueId);
    assert.equal(snapshot[0]?.githubTarget?.repo, "team/app");
    assert.equal(snapshot[0]?.claim?.owner, claim.owner);

    await backend.releaseClaim(item, claim);
    assert.equal((await backend.snapshot([item], "alice", dir))[0]?.claim, undefined);
    await backend.removeItem(item);
    assert.equal(await backend.itemExists(item), false);
  } finally {
    await agentGitService.close();
  }
});
