import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";

import {
  createGiteaIssueComment,
  createGiteaPullRequest,
  giteaControlPlaneProvider,
  giteaGitRemoteUrl,
  giteaIssueUrl,
  listGiteaIssueComments,
  mergeGiteaPullRequest,
  parseGiteaIssueRef,
  parseGiteaRepoRef,
} from "../src/harness/gitea.js";
import type { ControlPlaneProvider } from "../src/harness/control-plane.js";
import type { RunSummary } from "../src/harness/events.js";

test("parseGiteaIssueRef parses owner/repo issue references", () => {
  assert.deepEqual(parseGiteaIssueRef("team/app#42"), {
    owner: "team",
    repo: "app",
    index: 42,
  });
  assert.throws(() => parseGiteaIssueRef("team/app"), /issue/);
  assert.throws(() => parseGiteaIssueRef("team/app#0"), /issue/);
});

test("parseGiteaRepoRef parses owner/repo references", () => {
  assert.deepEqual(parseGiteaRepoRef("team/app"), {
    owner: "team",
    repo: "app",
  });
  assert.throws(() => parseGiteaRepoRef("team/app#42"), /repo/);
});

test("createGiteaIssueComment posts a run summary to the issue comments API", async () => {
  let request: { url?: string; authorization?: string; body?: string } = {};
  const server = createServer(async (req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
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
    await createGiteaIssueComment({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret-token",
      issue: "team/app#42",
      summary: summaryFixture({
        issue: "team/app#42",
        branch: "task/42",
        dashboardUrl: "https://loom.example/?tenant=alice&project=default&runId=run-1",
        summaryUrl: "https://loom.example/tenants/alice/runs/run-1?project=default",
        pullRequestIndex: 9,
        pullRequestUrl: "https://git.example/team/app/pulls/9",
      }, {
        evaluation: {
          ok: true,
          output: "$ npm run review\nexitCode=0",
          exitCode: 0,
          commands: ["npm run review"],
        },
        reviewer: {
          ok: true,
          output: "$ npm run reviewer\nexitCode=0",
          exitCode: 0,
          commands: ["npm run reviewer"],
        },
        review: { required: true, status: "approved", note: "review ok" },
        deployment: { required: true, status: "pending" },
        requester: { actor: "dev-user", role: "developer", clientId: "dash-dev" },
        modelUsage: {
          requestCount: 2,
          promptTokens: 28,
          completionTokens: 14,
          totalTokens: 42,
        },
      }),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  assert.equal(request.url, "/api/v1/repos/team/app/issues/42/comments");
  assert.equal(request.authorization, "token secret-token");
  const payload = JSON.parse(request.body ?? "{}");
  assert.match(payload.body, /Loom harness run/);
  assert.match(payload.body, /run-1/);
  assert.match(payload.body, /task\/42/);
  assert.match(payload.body, /Requester: dev-user developer dash-dev/);
  assert.match(payload.body, /Dashboard: https:\/\/loom\.example\/\?tenant=alice&project=default&runId=run-1/);
  assert.match(payload.body, /https:\/\/loom\.example\/tenants\/alice\/runs\/run-1\?project=default/);
  assert.match(payload.body, /Review summary: https:\/\/loom\.example\/tenants\/alice\/runs\/run-1\/review-summary\?project=default/);
  assert.match(payload.body, /Handoff package: https:\/\/loom\.example\/tenants\/alice\/runs\/run-1\/handoff-package\?project=default/);
  assert.match(payload.body, /Follow-up runs: https:\/\/loom\.example\/tenants\/alice\/runs\/run-1\/handoff-runs\?project=default/);
  assert.match(payload.body, /https:\/\/git\.example\/team\/app\/pulls\/9/);
  assert.match(payload.body, /Verification commands: `npm test`/);
  assert.match(payload.body, /Evaluation commands: `npm run review`/);
  assert.match(payload.body, /Reviewer commands: `npm run reviewer`/);
  assert.match(payload.body, /Model usage: 2 requests, prompt 28, completion 14, total 42/);
  assert.match(payload.body, /Review: approved/);
  assert.match(payload.body, /Deployment: pending/);
});

test("createGiteaIssueComment includes brain failure evidence for failed runs", async () => {
  let request: { body?: string } = {};
  const server = createServer(async (req, res) => {
    request = { body: await readBody(req) };
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: 1002 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    await createGiteaIssueComment({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret-token",
      issue: "team/app#42",
      summary: summaryFixture({ issue: "team/app#42" }, {
        status: "failed",
        verification: {
          ok: false,
          output: "verifier rejected",
          exitCode: 5,
          commands: ["npm test"],
        },
      }),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  const payload = JSON.parse(request.body ?? "{}");
  assert.match(payload.body, /Brain failure: verification/);
  assert.match(payload.body, /Reviewer focus: 先检查确定性验证命令、fixture 和失败 notes/);
});

test("createGiteaIssueComment includes model protocol diagnostics for failed runs", async () => {
  let request: { body?: string } = {};
  const server = createServer(async (req, res) => {
    request = { body: await readBody(req) };
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: 1002 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    await createGiteaIssueComment({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret-token",
      issue: "team/app#42",
      summary: summaryFixture({ issue: "team/app#42" }, {
        status: "error",
        error: {
          message: "model agent response failed protocol validation",
          phase: "agent_next",
          kind: "model_agent_protocol",
          details: {
            model: "test-model",
            status: 200,
            responseExcerpt: "not json",
            apiKey: "secret-value",
            raw: { ignored: true },
          },
        },
      }),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  const payload = JSON.parse(request.body ?? "{}");
  assert.match(payload.body, /Brain failure: agent/);
  assert.match(payload.body, /Error kind: `model_agent_protocol`/);
  assert.match(payload.body, /Error details: `model=test-model`, `status=200`, `responseExcerpt=not json`/);
  assert.doesNotMatch(payload.body, /secret-value/);
  assert.doesNotMatch(payload.body, /ignored/);
});

test("createGiteaIssueComment includes VAS review commands for vas-lite review runs", async () => {
  let request: { body?: string } = {};
  const server = createServer(async (req, res) => {
    request = { body: await readBody(req) };
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: 1002 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    await createGiteaIssueComment({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret-token",
      issue: "team/app#42",
      summary: summaryFixture({
        issue: "team/app#42",
        summaryUrl: "https://loom.example/tenants/alice/runs/run-1?project=lesson-vas",
        runPreset: "vas-lite-review",
        runPresetInput: { caseId: "segment-001", priorLearningCount: 2 },
      }, {
        goal: "Review VAS Lite case segment-001",
        skills: ["vas-lite", "coding"],
      }),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  const payload = JSON.parse(request.body ?? "{}");
  assert.match(payload.body, /VAS Lite review controls/);
  assert.match(payload.body, /Case: `segment-001`/);
  assert.match(payload.body, /\/loom approve-vas/);
  assert.match(payload.body, /\/loom request-vas-changes/);
  assert.match(payload.body, /\/loom claim-vas segment-001/);
  assert.match(payload.body, /\/loom release-vas-claim segment-001/);
  assert.match(payload.body, /\/loom run-vas-review segment-001/);
});

test("createGiteaIssueComment includes run review commands for pending review-gated runs", async () => {
  let request: { body?: string } = {};
  const server = createServer(async (req, res) => {
    request = { body: await readBody(req) };
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: 1003 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    await createGiteaIssueComment({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret-token",
      issue: "team/app#42",
      summary: summaryFixture({
        issue: "team/app#42",
        summaryUrl: "https://loom.example/tenants/alice/runs/run-1?project=proj-a",
        pullRequestUrl: "https://git.example/team/app/pulls/9",
      }, {
        status: "review_required",
        review: { required: true, status: "pending" },
      }),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  const payload = JSON.parse(request.body ?? "{}");
  assert.match(payload.body, /Run review controls/);
  assert.match(payload.body, /\/loom approve/);
  assert.match(payload.body, /\/loom request-changes/);
  assert.match(payload.body, /loom-contract-patch/);
  assert.match(payload.body, /\/loom claim-review/);
  assert.match(payload.body, /\/loom release-review-claim/);
});

test("createGiteaIssueComment includes deployment commands for pending deployment-gated runs", async () => {
  let request: { body?: string } = {};
  const server = createServer(async (req, res) => {
    request = { body: await readBody(req) };
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: 1004 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    await createGiteaIssueComment({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret-token",
      issue: "team/app#42",
      summary: summaryFixture({
        issue: "team/app#42",
        summaryUrl: "https://loom.example/tenants/alice/runs/run-1?project=prod",
      }, {
        status: "deployment_required",
        deployment: { required: true, status: "pending" },
      }),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  const payload = JSON.parse(request.body ?? "{}");
  assert.match(payload.body, /Deployment controls/);
  assert.match(payload.body, /\/loom approve-deploy/);
  assert.match(payload.body, /\/loom reject-deploy/);
});

test("listGiteaIssueComments reads issue comments from the Gitea API", async () => {
  let request: { url?: string; authorization?: string } = {};
  const server = createServer((req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([
      {
        id: 101,
        body: "Please add the acceptance note.",
        html_url: "https://git.example/team/app/issues/42#comment-101",
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
    comments = await listGiteaIssueComments({
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

  assert.equal(request.url, "/api/v1/repos/team/app/issues/42/comments?limit=100");
  assert.equal(request.authorization, "token secret-token");
  assert.deepEqual(comments, [
    {
      id: "101",
      body: "Please add the acceptance note.",
      author: "teammate",
      url: "https://git.example/team/app/issues/42#comment-101",
      createdAt: "2026-06-26T10:00:00Z",
      updatedAt: "2026-06-26T10:05:00Z",
    },
  ]);
});

test("createGiteaPullRequest posts a reviewable PR proposal", async () => {
  let request: { url?: string; authorization?: string; body?: string } = {};
  const server = createServer(async (req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
      body: await readBody(req),
    };
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ index: 7, html_url: "https://git.example/team/app/pulls/7" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  let pullRequest: { index: number; url?: string };
  try {
    pullRequest = await createGiteaPullRequest({
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

  assert.equal(request.url, "/api/v1/repos/team/app/pulls");
  assert.equal(request.authorization, "token secret-token");
  assert.deepEqual(JSON.parse(request.body ?? "{}"), {
    title: "Loom run run-1",
    body: "Review this harness proposal.",
    head: "task/42",
    base: "main",
  });
  assert.deepEqual(pullRequest, { index: 7, url: "https://git.example/team/app/pulls/7" });
});

test("giteaControlPlaneProvider exposes the Gitea control-plane implementation", async () => {
  const provider: ControlPlaneProvider = giteaControlPlaneProvider;
  assert.equal(
    provider.issueUrl("https://git.example", "team/app#42"),
    giteaIssueUrl("https://git.example", "team/app#42"),
  );
  assert.equal(
    provider.gitRemoteUrl("https://git.example/api/v1", "team/app"),
    giteaGitRemoteUrl("https://git.example/api/v1", "team/app"),
  );
  assert.equal(provider.gitRemoteUrl("https://git.example/api/v1", "team/app"), "https://git.example/team/app.git");

  let request: { url?: string; authorization?: string; body?: string } = {};
  const server = createServer(async (req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
      body: await readBody(req),
    };
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ number: 8, url: "https://git.example/api/v1/repos/team/app/pulls/8" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  let pullRequest;
  try {
    pullRequest = await provider.createPullRequest({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "provider-token",
      repo: "team/app",
      head: "task/provider",
      base: "main",
      title: "Provider PR",
      body: "Review through the provider boundary.",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  assert.equal(request.url, "/api/v1/repos/team/app/pulls");
  assert.equal(request.authorization, "token provider-token");
  assert.deepEqual(JSON.parse(request.body ?? "{}"), {
    title: "Provider PR",
    body: "Review through the provider boundary.",
    head: "task/provider",
    base: "main",
  });
  assert.deepEqual(pullRequest, { index: 8, url: "https://git.example/api/v1/repos/team/app/pulls/8" });
});

test("mergeGiteaPullRequest posts an explicit merge request", async () => {
  let request: { url?: string; authorization?: string; body?: string } = {};
  const server = createServer(async (req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
      body: await readBody(req),
    };
    res.writeHead(200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    await mergeGiteaPullRequest({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "secret-token",
      repo: "team/app",
      index: 7,
      method: "merge",
      title: "Merge Loom run run-1",
      message: "Approved by Alice.",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  assert.equal(request.url, "/api/v1/repos/team/app/pulls/7/merge");
  assert.equal(request.authorization, "token secret-token");
  assert.deepEqual(JSON.parse(request.body ?? "{}"), {
    Do: "merge",
    MergeTitleField: "Merge Loom run run-1",
    MergeMessageField: "Approved by Alice.",
  });
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
