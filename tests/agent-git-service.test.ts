import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";

import {
  AGENT_GIT_SERVICE_DISCOVERY_ENDPOINTS,
  AGENT_GIT_SERVICE_NATIVE_CAPABILITIES,
  agentGitServiceControlPlaneProvider,
  agentGitServiceDiscoveryUrls,
  agentGitServiceGitRemoteUrl,
  agentGitServiceIssueUrl,
  createAgentGitServiceIssueWorkspaceAttachment,
  createAgentGitServiceAgent,
  createAgentGitServiceIssueComment,
  createAgentGitServicePullRequest,
  grantAgentGitServiceRepoAccess,
  listAgentGitServiceIssueWorkspaces,
  listAgentGitServiceIssueComments,
  mergeAgentGitServicePullRequest,
  parseAgentGitServiceIssueRef,
  parseAgentGitServiceRepoRef,
  readAgentGitServiceWikiMemory,
  updateAgentGitServiceWikiMemory,
} from "../src/harness/agent-git-service.js";
import type { ControlPlaneProvider } from "../src/harness/control-plane.js";
import type { RunSummary } from "../src/harness/events.js";
import { startAgentGitServiceContractServer } from "./support/agent-git-service-contract.js";

test("parseAgentGitServiceIssueRef parses owner/repo issue references", () => {
  assert.deepEqual(parseAgentGitServiceIssueRef("team/app#42"), {
    owner: "team",
    repo: "app",
    index: 42,
  });
  assert.throws(() => parseAgentGitServiceIssueRef("team/app"), /issue/);
  assert.throws(() => parseAgentGitServiceIssueRef("team/app#0"), /issue/);
});

test("parseAgentGitServiceRepoRef parses owner/repo references", () => {
  assert.deepEqual(parseAgentGitServiceRepoRef("team/app"), {
    owner: "team",
    repo: "app",
  });
  assert.deepEqual(parseAgentGitServiceRepoRef("https://git.example/team/app.git"), {
    owner: "team",
    repo: "app",
  });
  assert.throws(() => parseAgentGitServiceRepoRef("team/app#42"), /repo/);
});

test("agentGitServiceIssueUrl keeps browser links outside the REST API path", () => {
  assert.equal(
    agentGitServiceIssueUrl("https://git.example/api/v3", "team/app#42"),
    "https://git.example/team/app/issues/42",
  );
});

test("agentGitServiceControlPlaneProvider exposes Git Smart HTTP remote URLs", () => {
  const provider: ControlPlaneProvider = agentGitServiceControlPlaneProvider;
  assert.equal(
    provider.gitRemoteUrl("https://git.example/api/v3", "team/app"),
    agentGitServiceGitRemoteUrl("https://git.example/api/v3", "team/app"),
  );
  assert.equal(
    provider.gitRemoteUrl("https://git.example/agents/api/v3", "team/app"),
    "https://git.example/agents/team/app.git",
  );
});

test("agentGitServiceDiscoveryUrls exposes stable API probes and native extension capabilities", () => {
  assert.deepEqual(AGENT_GIT_SERVICE_DISCOVERY_ENDPOINTS, ["/api/v3", "/api/v3/meta", "/api/v3/rate_limit"]);
  assert.ok(AGENT_GIT_SERVICE_NATIVE_CAPABILITIES.includes("agent-identities"));
  assert.ok(AGENT_GIT_SERVICE_NATIVE_CAPABILITIES.includes("agent-default-workspaces"));
  assert.ok(AGENT_GIT_SERVICE_NATIVE_CAPABILITIES.includes("wiki-memory"));
  assert.deepEqual(agentGitServiceDiscoveryUrls("https://git.example/agents/api/v3"), {
    apiRoot: "https://git.example/agents/api/v3",
    meta: "https://git.example/agents/api/v3/meta",
    rateLimit: "https://git.example/agents/api/v3/rate_limit",
  });
});

test("listAgentGitServiceIssueWorkspaces reads AGS issue workspace presence", async () => {
  const ags = await startAgentGitServiceContractServer({
    workspace: {
      id: "ws-1",
      agentLogin: "loom-agent-1",
      branch: "loom/run-1",
      status: "active",
      updatedAt: "2026-07-01T10:05:00Z",
    },
  });

  let workspaces;
  try {
    workspaces = await listAgentGitServiceIssueWorkspaces({
      baseUrl: ags.baseUrl,
      token: "secret-token",
      issue: "team/app#42",
      limit: 50,
    });
  } finally {
    await ags.close();
  }

  assert.equal(ags.requests[0]?.path, "/api/v3/repos/team/app/issues/42/workspaces");
  assert.equal(ags.requests[0]?.query, "?per_page=50");
  assert.equal(ags.requests[0]?.authorization, "Bearer secret-token");
  assert.equal(ags.requests[0]?.accept, "application/vnd.github+json");
  assert.deepEqual(workspaces, [
    {
      id: "ws-1",
      agentLogin: "loom-agent-1",
      branch: "loom/run-1",
      status: "active",
      url: `${ags.webBaseUrl}/team/app/issues/42/workspaces/ws-1`,
      updatedAt: "2026-07-01T10:05:00Z",
    },
  ]);
});

test("createAgentGitServiceIssueWorkspaceAttachment posts AGS workspace evidence links", async () => {
  let request: { url?: string; authorization?: string; accept?: string; body?: string } = {};
  const server = createServer(async (req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      body: await readBody(req),
    };
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: 99,
      html_url: "https://git.example/team/app/issues/42/workspaces/ws-1/attachments/99",
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  let attachment;
  try {
    attachment = await createAgentGitServiceIssueWorkspaceAttachment({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret-token",
      issue: "team/app#42",
      workspaceId: "ws-1",
      name: "loom run run-1 handoff",
      url: "https://loom.example/tenants/alice/runs/run-1/handoff-package?project=default",
      contentType: "application/json",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  assert.equal(request.url, "/api/v3/repos/team/app/issues/42/workspaces/ws-1/attachments");
  assert.equal(request.authorization, "Bearer secret-token");
  assert.equal(request.accept, "application/vnd.github+json");
  assert.deepEqual(JSON.parse(request.body ?? "{}"), {
    name: "loom run run-1 handoff",
    url: "https://loom.example/tenants/alice/runs/run-1/handoff-package?project=default",
    content_type: "application/json",
  });
  assert.deepEqual(attachment, {
    id: "99",
    url: "https://git.example/team/app/issues/42/workspaces/ws-1/attachments/99",
  });
});

test("agent-git-service wiki memory helpers read and update repo memory pages", async () => {
  const requests: Array<{ method?: string; url?: string; authorization?: string; accept?: string; body?: string }> = [];
  const server = createServer(async (req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      body: await readBody(req),
    });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "GET") {
      res.end(JSON.stringify({
        page: "vas/learnings",
        body: "prior learning",
        sha: "abc123",
        updated_at: "2026-07-01T10:00:00Z",
      }));
      return;
    }
    res.end(JSON.stringify({
      page: "vas/learnings",
      body: "next learning",
      sha: "def456",
      html_url: "https://git.example/team/app/wiki/vas/learnings",
      updated_at: "2026-07-01T10:10:00Z",
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  let before;
  let after;
  try {
    before = await readAgentGitServiceWikiMemory({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret-token",
      repo: "team/app",
      page: "vas/learnings",
    });
    after = await updateAgentGitServiceWikiMemory({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret-token",
      repo: "team/app",
      page: "vas/learnings",
      body: "next learning",
      message: "Record VAS learning from run-1",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.url, "/api/v3/repos/team/app/wiki/memory/vas%2Flearnings");
  assert.equal(requests[0]?.authorization, "Bearer secret-token");
  assert.equal(requests[0]?.accept, "application/vnd.github+json");
  assert.equal(requests[1]?.method, "PUT");
  assert.equal(requests[1]?.url, "/api/v3/repos/team/app/wiki/memory/vas%2Flearnings");
  assert.deepEqual(JSON.parse(requests[1]?.body ?? "{}"), {
    body: "next learning",
    message: "Record VAS learning from run-1",
  });
  assert.deepEqual(before, {
    page: "vas/learnings",
    body: "prior learning",
    sha: "abc123",
    updatedAt: "2026-07-01T10:00:00Z",
  });
  assert.deepEqual(after, {
    page: "vas/learnings",
    body: "next learning",
    sha: "def456",
    url: "https://git.example/team/app/wiki/vas/learnings",
    updatedAt: "2026-07-01T10:10:00Z",
  });
});

test("createAgentGitServiceAgent registers a first-class AGS agent with a default workspace", async () => {
  let request: { url?: string; authorization?: string; accept?: string; body?: string } = {};
  const server = createServer(async (req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      body: await readBody(req),
    };
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({
      login: "loom-agent-1",
      token: "agent-token",
      repo_full_name: "loom-agent-1/workspace",
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  let agent;
  try {
    agent = await createAgentGitServiceAgent({
      baseUrl: `http://127.0.0.1:${address.port}/api/v3`,
      prefixLogin: "loom-agent",
      defaultRepoName: "workspace",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  assert.equal(request.url, "/api/v3/agents");
  assert.equal(request.authorization, undefined);
  assert.equal(request.accept, "application/vnd.github+json");
  assert.deepEqual(JSON.parse(request.body ?? "{}"), {
    prefix_login: "loom-agent",
    default_repo_name: "workspace",
  });
  assert.deepEqual(agent, {
    login: "loom-agent-1",
    token: "agent-token",
    repoFullName: "loom-agent-1/workspace",
  });
});

test("grantAgentGitServiceRepoAccess grants an AGS agent repository permission through collaborator API", async () => {
  let request: { url?: string; authorization?: string; accept?: string; body?: string } = {};
  const server = createServer(async (req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      body: await readBody(req),
    };
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: 501,
      permissions: "write",
      html_url: "https://git.example/team/app/invitations",
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  let grant;
  try {
    grant = await grantAgentGitServiceRepoAccess({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "admin-token",
      repo: "team/app",
      agentLogin: "loom-agent-1",
      permission: "write",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  assert.equal(request.url, "/api/v3/repos/team/app/collaborators/loom-agent-1");
  assert.equal(request.authorization, "Bearer admin-token");
  assert.equal(request.accept, "application/vnd.github+json");
  assert.deepEqual(JSON.parse(request.body ?? "{}"), { permission: "write" });
  assert.deepEqual(grant, {
    repo: "team/app",
    agentLogin: "loom-agent-1",
    permission: "write",
    status: "invited",
    invitationId: "501",
    url: "https://git.example/team/app/invitations",
  });
});

test("grantAgentGitServiceRepoAccess accepts existing collaborator direct grants", async () => {
  let request: { url?: string; authorization?: string; body?: string } = {};
  const server = createServer(async (req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
      body: await readBody(req),
    };
    res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  let grant;
  try {
    grant = await grantAgentGitServiceRepoAccess({
      baseUrl: `http://127.0.0.1:${address.port}/api/v3`,
      token: "admin-token",
      repo: "team/app",
      agentLogin: "loom-agent-1",
      permission: "admin",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  assert.equal(request.url, "/api/v3/repos/team/app/collaborators/loom-agent-1");
  assert.equal(request.authorization, "Bearer admin-token");
  assert.deepEqual(JSON.parse(request.body ?? "{}"), { permission: "admin" });
  assert.deepEqual(grant, {
    repo: "team/app",
    agentLogin: "loom-agent-1",
    permission: "admin",
    status: "granted",
  });
});

test("createAgentGitServiceIssueComment posts a run summary to the GitHub-compatible comments API", async () => {
  let request: { url?: string; authorization?: string; accept?: string; body?: string } = {};
  const server = createServer(async (req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      body: await readBody(req),
    };
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: 1001 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    await createAgentGitServiceIssueComment({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret-token",
      issue: "team/app#42",
      summary: summaryFixture({
        issue: "team/app#42",
        branch: "task/42",
        summaryUrl: "https://loom.example/tenants/alice/runs/run-1?project=default",
      }),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  assert.equal(request.url, "/api/v3/repos/team/app/issues/42/comments");
  assert.equal(request.authorization, "Bearer secret-token");
  assert.equal(request.accept, "application/vnd.github+json");
  const payload = JSON.parse(request.body ?? "{}");
  assert.match(payload.body, /Loom harness run/);
  assert.match(payload.body, /run-1/);
  assert.match(payload.body, /Review summary: https:\/\/loom\.example\/tenants\/alice\/runs\/run-1\/review-summary\?project=default/);
});

test("listAgentGitServiceIssueComments reads GitHub-compatible issue comments", async () => {
  let request: { url?: string; authorization?: string; accept?: string } = {};
  const server = createServer((req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([
      {
        id: 101,
        body: "Please add the acceptance note.",
        html_url: "https://git.example/team/app/issues/42#issuecomment-101",
        user: { login: "teammate" },
        created_at: "2026-06-26T10:00:00Z",
        updated_at: "2026-06-26T10:05:00Z",
      },
    ]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  let comments;
  try {
    comments = await listAgentGitServiceIssueComments({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret-token",
      issue: "team/app#42",
      limit: 100,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  assert.equal(request.url, "/api/v3/repos/team/app/issues/42/comments?per_page=100");
  assert.equal(request.authorization, "Bearer secret-token");
  assert.equal(request.accept, "application/vnd.github+json");
  assert.deepEqual(comments, [
    {
      id: "101",
      body: "Please add the acceptance note.",
      author: "teammate",
      url: "https://git.example/team/app/issues/42#issuecomment-101",
      createdAt: "2026-06-26T10:00:00Z",
      updatedAt: "2026-06-26T10:05:00Z",
    },
  ]);
});

test("createAgentGitServicePullRequest posts a GitHub-compatible PR proposal", async () => {
  let request: { url?: string; authorization?: string; accept?: string; body?: string } = {};
  const server = createServer(async (req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      body: await readBody(req),
    };
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ number: 7, html_url: "https://git.example/team/app/pull/7" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  let pullRequest: { index: number; url?: string };
  try {
    pullRequest = await createAgentGitServicePullRequest({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret-token",
      repo: "team/app",
      head: "task/42",
      base: "main",
      title: "Loom run run-1",
      body: "Review this harness proposal.",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  assert.equal(request.url, "/api/v3/repos/team/app/pulls");
  assert.equal(request.authorization, "Bearer secret-token");
  assert.equal(request.accept, "application/vnd.github+json");
  assert.deepEqual(JSON.parse(request.body ?? "{}"), {
    title: "Loom run run-1",
    body: "Review this harness proposal.",
    head: "task/42",
    base: "main",
  });
  assert.deepEqual(pullRequest, { index: 7, url: "https://git.example/team/app/pull/7" });
});

test("mergeAgentGitServicePullRequest posts a GitHub-compatible merge request", async () => {
  let request: { url?: string; authorization?: string; accept?: string; body?: string } = {};
  const server = createServer(async (req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      body: await readBody(req),
    };
    res.writeHead(200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    await mergeAgentGitServicePullRequest({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret-token",
      repo: "team/app",
      index: 7,
      method: "rebase-merge",
      title: "Merge Loom run run-1",
      message: "Approved by Alice.",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  assert.equal(request.url, "/api/v3/repos/team/app/pulls/7/merge");
  assert.equal(request.authorization, "Bearer secret-token");
  assert.equal(request.accept, "application/vnd.github+json");
  assert.deepEqual(JSON.parse(request.body ?? "{}"), {
    commit_title: "Merge Loom run run-1",
    commit_message: "Approved by Alice.",
    merge_method: "rebase",
  });
});

test("agentGitServiceControlPlaneProvider exposes the GitHub-compatible control-plane implementation", async () => {
  const provider: ControlPlaneProvider = agentGitServiceControlPlaneProvider;
  assert.equal(
    provider.issueUrl("https://git.example/api/v3", "team/app#42"),
    agentGitServiceIssueUrl("https://git.example/api/v3", "team/app#42"),
  );
});

function summaryFixture(metadata: RunSummary["metadata"], overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    goal: "fix issue 42",
    status: "passed",
    skills: ["coding"],
    startedAt: "2026-06-26T00:00:00.000Z",
    endedAt: "2026-06-26T00:01:00.000Z",
    eventCount: 7,
    runDir: "/tmp/loom/run-1",
    verification: {
      ok: true,
      output: "$ npm test\nexitCode=0",
      exitCode: 0,
      commands: ["npm test"],
    },
    metadata,
    ...overrides,
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
