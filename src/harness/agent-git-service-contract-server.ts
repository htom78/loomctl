import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface AgentGitServiceContractRequest {
  method: string;
  path: string;
  query: string;
  authorization?: string;
  accept?: string;
  body: string;
  json?: Record<string, unknown>;
}

export interface AgentGitServiceContractWorkspace {
  id: string;
  agentLogin?: string;
  branch?: string;
  status?: string;
  updatedAt?: string;
}

export interface AgentGitServiceContractWikiMemory {
  page: string;
  body: string;
  sha?: string;
}

export interface StartAgentGitServiceContractServerOptions {
  host?: string;
  workspace?: AgentGitServiceContractWorkspace;
  wikiMemory?: AgentGitServiceContractWikiMemory;
}

export interface AgentGitServiceContractServer {
  baseUrl: string;
  webBaseUrl: string;
  requests: AgentGitServiceContractRequest[];
  setWorkspace(workspace: AgentGitServiceContractWorkspace | undefined): void;
  close(): Promise<void>;
}

interface ContractState {
  agentCount: number;
  attachmentCount: number;
  contentCount: number;
  comments: Array<Record<string, unknown>>;
  contents: Map<string, { content: string; sha: string }>;
  pullRequests: Array<Record<string, unknown>>;
  workspace?: AgentGitServiceContractWorkspace;
  wikiMemory?: AgentGitServiceContractWikiMemory;
}

export async function startAgentGitServiceContractServer(
  options: StartAgentGitServiceContractServerOptions = {},
): Promise<AgentGitServiceContractServer> {
  const requests: AgentGitServiceContractRequest[] = [];
  const state: ContractState = {
    agentCount: 0,
    attachmentCount: 0,
    contentCount: 0,
    comments: [],
    contents: new Map(),
    pullRequests: [],
    workspace: options.workspace,
    wikiMemory: options.wikiMemory,
  };

  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const json = parseJsonObject(body);
    requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.search,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      body,
      ...(json ? { json } : {}),
    });

    await routeAgentGitServiceContractRequest(req.method ?? "GET", url, json, state, res);
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("agent-git-service contract server did not start");
  const webBaseUrl = `http://${host}:${address.port}`;
  return {
    baseUrl: `${webBaseUrl}/api/v3`,
    webBaseUrl,
    requests,
    setWorkspace: (workspace) => {
      state.workspace = workspace;
    },
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  };
}

async function routeAgentGitServiceContractRequest(
  method: string,
  url: URL,
  json: Record<string, unknown> | undefined,
  state: ContractState,
  res: ServerResponse,
): Promise<void> {
  const path = url.pathname;
  if (method === "GET" && path === "/readyz") {
    writeJson(res, 200, {
      status: "ready",
      version: "contract",
      checks: {
        main_db: { status: "ok" },
      },
    });
    return;
  }
  if (method === "GET" && path === "/api/v3") {
    writeJson(res, 200, { version: "agent-git-service-contract" });
    return;
  }
  if (method === "GET" && path === "/api/v3/meta") {
    writeJson(res, 200, {
      installed_version: "contract",
      verifiable_password_authentication: false,
    });
    return;
  }
  if (method === "GET" && path === "/api/v3/rate_limit") {
    writeJson(res, 200, {
      resources: {
        core: {
          limit: 5000,
          remaining: 4999,
        },
      },
    });
    return;
  }
  if (method === "POST" && path === "/api/v3/agents") {
    state.agentCount += 1;
    const prefix = stringField(json, "prefix_login") ?? "agent";
    const repo = stringField(json, "default_repo_name") ?? "workspace";
    const login = `${prefix}-${state.agentCount}`;
    writeJson(res, 201, {
      login,
      token: `contract-agent-token-${state.agentCount}`,
      repo_full_name: `${login}/${repo}`,
    });
    return;
  }

  const collaborator = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)$/);
  if (method === "PUT" && collaborator) {
    const [, owner, repo, agentLogin] = collaborator.map(decodeURIComponent);
    const permission = stringField(json, "permission") ?? "read";
    writeJson(res, 201, {
      id: state.agentCount + 500,
      permissions: permission,
      html_url: `${webBaseUrlFor(url)}/${owner}/${repo}/collaborators/${agentLogin}`,
    });
    return;
  }

  const issueComments = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/comments$/);
  if (issueComments) {
    const [, owner, repo, issueNumber] = issueComments.map(decodeURIComponent);
    if (method === "GET") {
      writeJson(res, 200, state.comments);
      return;
    }
    if (method === "POST") {
      const id = state.comments.length + 1;
      const comment = {
        id,
        body: stringField(json, "body") ?? "",
        html_url: `${webBaseUrlFor(url)}/${owner}/${repo}/issues/${issueNumber}#issuecomment-${id}`,
        user: { login: "loom-contract" },
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      };
      state.comments.push(comment);
      writeJson(res, 201, comment);
      return;
    }
  }

  const pulls = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/);
  if (method === "POST" && pulls) {
    const [, owner, repo] = pulls.map(decodeURIComponent);
    const number = state.pullRequests.length + 1;
    const pullRequest = {
      number,
      title: stringField(json, "title") ?? "",
      body: stringField(json, "body") ?? "",
      head: stringField(json, "head") ?? "",
      base: stringField(json, "base") ?? "",
      html_url: `${webBaseUrlFor(url)}/${owner}/${repo}/pull/${number}`,
    };
    state.pullRequests.push(pullRequest);
    writeJson(res, 201, pullRequest);
    return;
  }

  const merge = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/([1-9]\d*)\/merge$/);
  if (method === "PUT" && merge) {
    writeJson(res, 200, { merged: true });
    return;
  }

  const contents = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
  if (contents) {
    const [, owner, repo, contentPath] = contents.map(decodeURIComponent);
    const key = `${owner}/${repo}/${contentPath}`;
    if (method === "GET") {
      const content = state.contents.get(key);
      if (!content) {
        writeJson(res, 404, { message: "not found" });
        return;
      }
      writeJson(res, 200, {
        type: "file",
        name: contentPath.split("/").pop() ?? contentPath,
        path: contentPath,
        sha: content.sha,
        encoding: "base64",
        content: content.content,
        url: `${webBaseUrlFor(url)}/api/v3/repos/${owner}/${repo}/contents/${contentPath}`,
        html_url: `${webBaseUrlFor(url)}/${owner}/${repo}/blob/main/${contentPath}`,
      });
      return;
    }
    if (method === "PUT") {
      const existing = state.contents.get(key);
      const requestSha = stringField(json, "sha");
      if (existing && requestSha !== existing.sha) {
        writeJson(res, 409, { message: "sha mismatch" });
        return;
      }
      if (!existing && requestSha) {
        writeJson(res, 409, { message: "sha mismatch" });
        return;
      }
      const content = stringField(json, "content");
      if (!content) {
        writeJson(res, 422, { message: "content is required" });
        return;
      }
      state.contentCount += 1;
      const sha = `content-sha-${state.contentCount}`;
      state.contents.set(key, { content, sha });
      writeJson(res, existing ? 200 : 201, {
        content: {
          name: contentPath.split("/").pop() ?? contentPath,
          path: contentPath,
          sha,
        },
        commit: {
          sha: `commit-sha-${state.contentCount}`,
          message: stringField(json, "message") ?? "",
        },
      });
      return;
    }
  }

  const workspaces = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/workspaces$/);
  if (method === "GET" && workspaces) {
    const [, owner, repo, issueNumber] = workspaces.map(decodeURIComponent);
    writeJson(res, 200, state.workspace
      ? [{
          id: state.workspace.id,
          agent_login: state.workspace.agentLogin,
          branch: state.workspace.branch,
          status: state.workspace.status,
          updated_at: state.workspace.updatedAt,
          html_url: `${webBaseUrlFor(url)}/${owner}/${repo}/issues/${issueNumber}/workspaces/${state.workspace.id}`,
        }]
      : []);
    return;
  }

  const attachments = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/workspaces\/([^/]+)\/attachments$/);
  if (method === "POST" && attachments) {
    const [, owner, repo, issueNumber, workspaceId] = attachments.map(decodeURIComponent);
    state.attachmentCount += 1;
    writeJson(res, 201, {
      id: state.attachmentCount,
      html_url: `${webBaseUrlFor(url)}/${owner}/${repo}/issues/${issueNumber}/workspaces/${workspaceId}/attachments/${state.attachmentCount}`,
    });
    return;
  }

  const wikiMemory = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/wiki\/memory\/(.+)$/);
  if (wikiMemory) {
    const [, owner, repo, page] = wikiMemory.map(decodeURIComponent);
    if (method === "GET") {
      const memory = state.wikiMemory ?? { page, body: "" };
      writeJson(res, 200, {
        page: memory.page,
        body: memory.body,
        sha: memory.sha,
      });
      return;
    }
    if (method === "PUT") {
      state.wikiMemory = {
        page,
        body: stringField(json, "body") ?? "",
        sha: "sha-after",
      };
      writeJson(res, 200, {
        page,
        body: state.wikiMemory.body,
        sha: state.wikiMemory.sha,
        html_url: `${webBaseUrlFor(url)}/${owner}/${repo}/wiki/${page.split("/").map(encodeURIComponent).join("/")}`,
        updated_at: "2026-07-01T00:01:00Z",
      });
      return;
    }
  }

  writeJson(res, 404, { error: `unexpected AGS contract request ${method} ${path}` });
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown> | Array<Record<string, unknown>>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function webBaseUrlFor(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function parseJsonObject(body: string): Record<string, unknown> | undefined {
  if (!body.trim()) return undefined;
  const value = JSON.parse(body) as unknown;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
