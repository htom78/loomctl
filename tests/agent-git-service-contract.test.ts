import assert from "node:assert/strict";
import test from "node:test";

import {
  agentGitServiceDiscoveryUrls,
  createAgentGitServiceAgent,
  createAgentGitServiceIssueComment,
  createAgentGitServiceIssueWorkspaceAttachment,
  createAgentGitServicePullRequest,
  grantAgentGitServiceRepoAccess,
  listAgentGitServiceIssueComments,
  listAgentGitServiceIssueWorkspaces,
  mergeAgentGitServicePullRequest,
  readAgentGitServiceWikiMemory,
  updateAgentGitServiceWikiMemory,
} from "../src/harness/agent-git-service.js";
import type { RunSummary } from "../src/harness/events.js";
import { startAgentGitServiceContractServer } from "./support/agent-git-service-contract.js";

test("agent-git-service contract server exercises the adapter's AGS REST surface", async () => {
  const ags = await startAgentGitServiceContractServer({
    workspace: {
      id: "ws-contract",
      agentLogin: "loom-agent-contract",
      branch: "loom/run-contract",
      status: "active",
    },
    wikiMemory: {
      page: "vas/learnings",
      body: "prior learning",
      sha: "sha-before",
    },
  });

  try {
    const discovery = agentGitServiceDiscoveryUrls(ags.baseUrl);
    assert.equal((await fetch(discovery.apiRoot)).status, 200);
    assert.equal((await fetch(discovery.meta)).status, 200);
    assert.equal((await fetch(discovery.rateLimit)).status, 200);

    const agent = await createAgentGitServiceAgent({
      baseUrl: ags.baseUrl,
      prefixLogin: "loom-agent",
      defaultRepoName: "workspace",
    });
    assert.equal(agent.login, "loom-agent-1");
    assert.equal(agent.token, "contract-agent-token-1");
    assert.equal(agent.repoFullName, "loom-agent-1/workspace");

    const grant = await grantAgentGitServiceRepoAccess({
      baseUrl: ags.baseUrl,
      token: "admin-token",
      repo: "team/app",
      agentLogin: agent.login,
      permission: "write",
    });
    assert.equal(grant.status, "invited");
    assert.equal(grant.permission, "write");

    await createAgentGitServiceIssueComment({
      baseUrl: ags.baseUrl,
      token: "project-token",
      issue: "team/app#42",
      summary: summaryFixture(),
    });
    const comments = await listAgentGitServiceIssueComments({
      baseUrl: ags.baseUrl,
      token: "project-token",
      issue: "team/app#42",
      limit: 50,
    });
    assert.equal(comments.length, 1);
    assert.match(comments[0]?.body ?? "", /Loom harness run/);

    const pullRequest = await createAgentGitServicePullRequest({
      baseUrl: ags.baseUrl,
      token: "project-token",
      repo: "team/app",
      head: "loom/run-contract",
      base: "main",
      title: "Loom run run-contract",
      body: "Review this run.",
    });
    assert.deepEqual(pullRequest, {
      index: 1,
      url: `${ags.webBaseUrl}/team/app/pull/1`,
    });
    await mergeAgentGitServicePullRequest({
      baseUrl: ags.baseUrl,
      token: "project-token",
      repo: "team/app",
      index: pullRequest.index,
      method: "rebase-merge",
      title: "Merge Loom run run-contract",
      message: "Approved.",
    });

    const workspaces = await listAgentGitServiceIssueWorkspaces({
      baseUrl: ags.baseUrl,
      token: "project-token",
      issue: "team/app#42",
      limit: 100,
    });
    assert.deepEqual(workspaces, [
      {
        id: "ws-contract",
        agentLogin: "loom-agent-contract",
        branch: "loom/run-contract",
        status: "active",
        url: `${ags.webBaseUrl}/team/app/issues/42/workspaces/ws-contract`,
      },
    ]);
    ags.setWorkspace({
      id: "ws-contract",
      agentLogin: "loom-agent-contract",
      branch: "loom/run-updated",
      status: "active",
    });
    const updatedWorkspaces = await listAgentGitServiceIssueWorkspaces({
      baseUrl: ags.baseUrl,
      token: "project-token",
      issue: "team/app#42",
      limit: 100,
    });
    assert.equal(updatedWorkspaces[0]?.branch, "loom/run-updated");
    const attachment = await createAgentGitServiceIssueWorkspaceAttachment({
      baseUrl: ags.baseUrl,
      token: "project-token",
      issue: "team/app#42",
      workspaceId: "ws-contract",
      name: "handoff",
      url: "https://loom.example/runs/run-contract/handoff-package",
      contentType: "application/json",
    });
    assert.equal(attachment.url, `${ags.webBaseUrl}/team/app/issues/42/workspaces/ws-contract/attachments/1`);

    const before = await readAgentGitServiceWikiMemory({
      baseUrl: ags.baseUrl,
      token: "project-token",
      repo: "team/app",
      page: "vas/learnings",
    });
    assert.equal(before.body, "prior learning");
    const after = await updateAgentGitServiceWikiMemory({
      baseUrl: ags.baseUrl,
      token: "project-token",
      repo: "team/app",
      page: "vas/learnings",
      body: "prior learning\nnext learning",
      message: "Record learning",
    });
    assert.equal(after.body, "prior learning\nnext learning");

    assert.ok(ags.requests.some((request) =>
      request.method === "PUT" &&
      request.path === "/api/v3/repos/team/app/pulls/1/merge" &&
      request.json?.merge_method === "rebase"
    ));
    assert.equal(ags.requests.some((request) => request.body.includes("admin-token")), false);
    assert.equal(ags.requests.some((request) => request.body.includes("project-token")), false);
  } finally {
    await ags.close();
  }
});

function summaryFixture(): RunSummary {
  return {
    runId: "run-contract",
    goal: "contract test",
    status: "passed",
    skills: ["coding"],
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:01:00.000Z",
    eventCount: 3,
    runDir: "/tmp/loom/run-contract",
    verification: {
      ok: true,
      output: "$ npm test\nexitCode=0",
      exitCode: 0,
      commands: ["npm test"],
    },
    metadata: {
      issue: "team/app#42",
      branch: "loom/run-contract",
      summaryUrl: "https://loom.example/runs/run-contract?project=app",
    },
  };
}
