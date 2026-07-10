import {
  CONTROL_PLANE_PROVIDER_CATALOG,
  type ControlPlaneIssueComment,
  type ControlPlaneIssueRef,
  type ControlPlaneProvider,
  type ControlPlanePullRequest,
  type ControlPlaneRepoRef,
  type CreateControlPlaneIssueCommentOptions,
  type CreateControlPlanePullRequestOptions,
  type ListControlPlaneIssueCommentsOptions,
  type MergeControlPlanePullRequestOptions,
} from "./control-plane.js";
import { formatControlPlaneRunComment } from "./gitea.js";

export type AgentGitServiceIssueRef = ControlPlaneIssueRef;

export type AgentGitServiceRepoRef = ControlPlaneRepoRef;

export type AgentGitServicePullRequest = ControlPlanePullRequest;

export type AgentGitServiceIssueComment = ControlPlaneIssueComment;

export interface CreateAgentGitServiceIssueCommentOptions extends CreateControlPlaneIssueCommentOptions {}

export interface ListAgentGitServiceIssueCommentsOptions extends ListControlPlaneIssueCommentsOptions {}

export interface CreateAgentGitServicePullRequestOptions extends CreateControlPlanePullRequestOptions {}

export interface MergeAgentGitServicePullRequestOptions extends MergeControlPlanePullRequestOptions {}

export type AgentGitServiceRepoPermission = "read" | "write" | "admin";

export interface AgentGitServiceAgentRegistration {
  login: string;
  token: string;
  repoFullName: string;
}

export interface CreateAgentGitServiceAgentOptions {
  baseUrl: string;
  prefixLogin: string;
  defaultRepoName: string;
}

export interface AgentGitServiceRepoAccessGrant {
  repo: string;
  agentLogin: string;
  permission: AgentGitServiceRepoPermission;
  status: "granted" | "invited";
  invitationId?: string;
  url?: string;
}

export interface GrantAgentGitServiceRepoAccessOptions {
  baseUrl: string;
  token: string;
  repo: string;
  agentLogin: string;
  permission: AgentGitServiceRepoPermission;
}

export interface AgentGitServiceIssueWorkspace {
  id: string;
  agentLogin?: string;
  branch?: string;
  status?: string;
  url?: string;
  updatedAt?: string;
}

export interface ListAgentGitServiceIssueWorkspacesOptions {
  baseUrl: string;
  token: string;
  issue: string;
  limit?: number;
}

export interface AgentGitServiceIssueWorkspaceAttachment {
  id: string;
  url?: string;
}

export interface CreateAgentGitServiceIssueWorkspaceAttachmentOptions {
  baseUrl: string;
  token: string;
  issue: string;
  workspaceId: string;
  name: string;
  url: string;
  contentType?: string;
}

export interface AgentGitServiceWikiMemoryPage {
  page: string;
  body: string;
  sha?: string;
  url?: string;
  updatedAt?: string;
}

export interface ReadAgentGitServiceWikiMemoryOptions {
  baseUrl: string;
  token: string;
  repo: string;
  page: string;
}

export interface UpdateAgentGitServiceWikiMemoryOptions extends ReadAgentGitServiceWikiMemoryOptions {
  body: string;
  message?: string;
}

export const AGENT_GIT_SERVICE_DISCOVERY_ENDPOINTS = ["/api/v3", "/api/v3/meta", "/api/v3/rate_limit"] as const;

export const AGENT_GIT_SERVICE_NATIVE_CAPABILITIES = [
  "github-compatible-rest-v3",
  "graphql-v4-partial",
  "git-smart-http",
  "agent-identities",
  "agent-default-workspaces",
  "direct-agent-permissions",
  "human-agent-binding",
  "switch-sessions",
  "issue-workspace-presence",
  "issue-workspace-attachments",
  "wiki-memory",
  "local-token-api",
  "local-rate-limit-policy",
] as const;

export function parseAgentGitServiceIssueRef(value: string): AgentGitServiceIssueRef {
  const match = value.trim().match(/^([^/\s#]+)\/([^/\s#]+)#([1-9]\d*)$/);
  if (!match) {
    throw new Error(`issue must be formatted as owner/repo#number: ${value}`);
  }
  return {
    owner: match[1],
    repo: match[2],
    index: Number(match[3]),
  };
}

export function parseAgentGitServiceRepoRef(value: string): AgentGitServiceRepoRef {
  const match = agentGitServiceRepoRefValue(value).match(/^([^/\s#]+)\/([^/\s#]+)$/);
  if (!match) {
    throw new Error(`repo must be formatted as owner/repo: ${value}`);
  }
  return {
    owner: match[1],
    repo: match[2],
  };
}

function agentGitServiceRepoRefValue(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    if (parts.length === 2) return `${parts[0]}/${stripGitSuffix(parts[1])}`;
    if (parts.length === 5 && parts[0] === "api" && parts[1] === "v3" && parts[2] === "repos") {
      return `${parts[3]}/${stripGitSuffix(parts[4])}`;
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

export function agentGitServiceIssueUrl(baseUrl: string, value: string): string {
  const issue = parseAgentGitServiceIssueRef(value);
  const url = normalizedWebBaseUrl(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.index}`;
  return url.toString();
}

export function agentGitServiceGitRemoteUrl(baseUrl: string, value: string): string {
  const repo = parseAgentGitServiceRepoRef(value);
  const url = normalizedWebBaseUrl(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}.git`;
  return url.toString();
}

export function agentGitServiceDiscoveryUrls(baseUrl: string): { apiRoot: string; meta: string; rateLimit: string } {
  return {
    apiRoot: agentGitServiceApiUrl(baseUrl, "").toString(),
    meta: agentGitServiceApiUrl(baseUrl, "/meta").toString(),
    rateLimit: agentGitServiceApiUrl(baseUrl, "/rate_limit").toString(),
  };
}

export async function createAgentGitServiceAgent(
  options: CreateAgentGitServiceAgentOptions,
): Promise<AgentGitServiceAgentRegistration> {
  const response = await fetch(agentGitServiceApiUrl(options.baseUrl, "/agents"), {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      prefix_login: options.prefixLogin,
      default_repo_name: options.defaultRepoName,
    }),
  });

  if (!response.ok) {
    throw new Error(`agent-git-service agent registration failed with ${response.status}: ${await response.text()}`);
  }

  return agentGitServiceAgentRegistrationFromResponse(await response.json());
}

export async function grantAgentGitServiceRepoAccess(
  options: GrantAgentGitServiceRepoAccessOptions,
): Promise<AgentGitServiceRepoAccessGrant> {
  const repo = parseAgentGitServiceRepoRef(options.repo);
  const response = await fetch(
    agentGitServiceApiUrl(
      options.baseUrl,
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/collaborators/${encodeURIComponent(options.agentLogin)}`,
    ),
    {
      method: "PUT",
      headers: {
        ...agentGitServiceHeaders(options.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({ permission: options.permission }),
    },
  );

  if (!response.ok) {
    throw new Error(`agent-git-service repo access grant failed with ${response.status}: ${await response.text()}`);
  }
  if (response.status === 204) {
    return {
      repo: options.repo,
      agentLogin: options.agentLogin,
      permission: options.permission,
      status: "granted",
    };
  }

  return agentGitServiceRepoAccessGrantFromResponse(options, await response.json());
}

export async function listAgentGitServiceIssueWorkspaces(
  options: ListAgentGitServiceIssueWorkspacesOptions,
): Promise<AgentGitServiceIssueWorkspace[]> {
  const issue = parseAgentGitServiceIssueRef(options.issue);
  const url = agentGitServiceApiUrl(
    options.baseUrl,
    `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.index}/workspaces`,
  );
  if (options.limit !== undefined) url.searchParams.set("per_page", String(options.limit));
  const response = await fetch(url, {
    headers: agentGitServiceHeaders(options.token),
  });

  if (!response.ok) {
    throw new Error(`agent-git-service issue workspaces failed with ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("agent-git-service issue workspaces response was not an array");
  }
  return body.map(agentGitServiceIssueWorkspaceFromResponse);
}

export async function createAgentGitServiceIssueWorkspaceAttachment(
  options: CreateAgentGitServiceIssueWorkspaceAttachmentOptions,
): Promise<AgentGitServiceIssueWorkspaceAttachment> {
  const issue = parseAgentGitServiceIssueRef(options.issue);
  const response = await fetch(
    agentGitServiceApiUrl(
      options.baseUrl,
      `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.index}/workspaces/${encodeURIComponent(options.workspaceId)}/attachments`,
    ),
    {
      method: "POST",
      headers: {
        ...agentGitServiceHeaders(options.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: options.name,
        url: options.url,
        content_type: options.contentType,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`agent-git-service issue workspace attachment failed with ${response.status}: ${await response.text()}`);
  }

  return agentGitServiceIssueWorkspaceAttachmentFromResponse(await response.json());
}

export async function readAgentGitServiceWikiMemory(
  options: ReadAgentGitServiceWikiMemoryOptions,
): Promise<AgentGitServiceWikiMemoryPage> {
  const repo = parseAgentGitServiceRepoRef(options.repo);
  const response = await fetch(
    agentGitServiceApiUrl(
      options.baseUrl,
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/wiki/memory/${encodeURIComponent(options.page)}`,
    ),
    {
      headers: agentGitServiceHeaders(options.token),
    },
  );

  if (!response.ok) {
    throw new Error(`agent-git-service wiki memory read failed with ${response.status}: ${await response.text()}`);
  }

  return agentGitServiceWikiMemoryPageFromResponse(await response.json(), options.page);
}

export async function updateAgentGitServiceWikiMemory(
  options: UpdateAgentGitServiceWikiMemoryOptions,
): Promise<AgentGitServiceWikiMemoryPage> {
  const repo = parseAgentGitServiceRepoRef(options.repo);
  const response = await fetch(
    agentGitServiceApiUrl(
      options.baseUrl,
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/wiki/memory/${encodeURIComponent(options.page)}`,
    ),
    {
      method: "PUT",
      headers: {
        ...agentGitServiceHeaders(options.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: options.body,
        message: options.message,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`agent-git-service wiki memory update failed with ${response.status}: ${await response.text()}`);
  }

  return agentGitServiceWikiMemoryPageFromResponse(await response.json(), options.page);
}

export async function listAgentGitServiceIssueComments(
  options: ListAgentGitServiceIssueCommentsOptions,
): Promise<AgentGitServiceIssueComment[]> {
  const issue = parseAgentGitServiceIssueRef(options.issue);
  const url = agentGitServiceApiUrl(
    options.baseUrl,
    `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.index}/comments`,
  );
  if (options.limit !== undefined) url.searchParams.set("per_page", String(options.limit));
  const response = await fetch(url, {
    headers: agentGitServiceHeaders(options.token),
  });

  if (!response.ok) {
    throw new Error(`agent-git-service issue comments failed with ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("agent-git-service issue comments response was not an array");
  }
  return body.map(agentGitServiceIssueCommentFromResponse);
}

export async function createAgentGitServiceIssueComment(options: CreateAgentGitServiceIssueCommentOptions): Promise<void> {
  const issue = parseAgentGitServiceIssueRef(options.issue);
  const response = await fetch(
    agentGitServiceApiUrl(
      options.baseUrl,
      `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.index}/comments`,
    ),
    {
      method: "POST",
      headers: {
        ...agentGitServiceHeaders(options.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: formatControlPlaneRunComment(options.summary) }),
    },
  );

  if (!response.ok) {
    throw new Error(`agent-git-service issue comment failed with ${response.status}: ${await response.text()}`);
  }
}

export async function createAgentGitServicePullRequest(
  options: CreateAgentGitServicePullRequestOptions,
): Promise<AgentGitServicePullRequest> {
  const repo = parseAgentGitServiceRepoRef(options.repo);
  const response = await fetch(
    agentGitServiceApiUrl(
      options.baseUrl,
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls`,
    ),
    {
      method: "POST",
      headers: {
        ...agentGitServiceHeaders(options.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: options.title,
        body: options.body,
        head: options.head,
        base: options.base,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`agent-git-service pull request failed with ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as { number?: unknown; html_url?: unknown; url?: unknown };
  if (typeof body.number !== "number") {
    throw new Error("agent-git-service pull request response did not include a number");
  }
  const url = typeof body.html_url === "string" ? body.html_url : typeof body.url === "string" ? body.url : undefined;
  return { index: body.number, url };
}

export async function mergeAgentGitServicePullRequest(options: MergeAgentGitServicePullRequestOptions): Promise<void> {
  const repo = parseAgentGitServiceRepoRef(options.repo);
  const response = await fetch(
    agentGitServiceApiUrl(
      options.baseUrl,
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${options.index}/merge`,
    ),
    {
      method: "PUT",
      headers: {
        ...agentGitServiceHeaders(options.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        commit_title: options.title,
        commit_message: options.message,
        merge_method: agentGitServiceMergeMethod(options.method),
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`agent-git-service pull request merge failed with ${response.status}: ${await response.text()}`);
  }
}

export const agentGitServiceControlPlaneProvider: ControlPlaneProvider = {
  contract: {
    provider: "agent-git-service",
    boundary: CONTROL_PLANE_PROVIDER_CATALOG["agent-git-service"].boundary,
    apiBasePath: CONTROL_PLANE_PROVIDER_CATALOG["agent-git-service"].apiBasePath,
    discoveryEndpoints: CONTROL_PLANE_PROVIDER_CATALOG["agent-git-service"].discoveryEndpoints,
    nativeCapabilities: CONTROL_PLANE_PROVIDER_CATALOG["agent-git-service"].nativeCapabilities,
  },
  issueUrl: agentGitServiceIssueUrl,
  gitRemoteUrl: agentGitServiceGitRemoteUrl,
  listIssueComments: listAgentGitServiceIssueComments,
  createIssueComment: createAgentGitServiceIssueComment,
  createPullRequest: createAgentGitServicePullRequest,
  mergePullRequest: mergeAgentGitServicePullRequest,
};

function agentGitServiceApiUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const apiPath = basePath.endsWith("/api/v3") ? basePath : `${basePath}/api/v3`;
  url.pathname = `${apiPath}${path}`;
  url.search = "";
  url.hash = "";
  return url;
}

function normalizedWebBaseUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/api\/v3\/?$/, "").replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function agentGitServiceHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
  };
}

function agentGitServiceAgentRegistrationFromResponse(value: unknown): AgentGitServiceAgentRegistration {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (typeof record.login !== "string" || typeof record.token !== "string" || typeof record.repo_full_name !== "string") {
    throw new Error("agent-git-service agent registration response was missing login, token, or repo_full_name");
  }
  return {
    login: record.login,
    token: record.token,
    repoFullName: record.repo_full_name,
  };
}

function agentGitServiceRepoAccessGrantFromResponse(
  options: GrantAgentGitServiceRepoAccessOptions,
  value: unknown,
): AgentGitServiceRepoAccessGrant {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const permission = record.permissions === "read" || record.permissions === "write" || record.permissions === "admin"
    ? record.permissions
    : options.permission;
  const id = record.id === undefined ? undefined : String(record.id);
  const url = typeof record.html_url === "string" ? record.html_url : typeof record.url === "string" ? record.url : undefined;
  return {
    repo: options.repo,
    agentLogin: options.agentLogin,
    permission,
    status: "invited",
    invitationId: id,
    url,
  };
}

function agentGitServiceIssueWorkspaceFromResponse(value: unknown): AgentGitServiceIssueWorkspace {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const agent = record.agent && typeof record.agent === "object" ? record.agent as Record<string, unknown> : undefined;
  const agentLogin = typeof record.agent_login === "string" ? record.agent_login : typeof agent?.login === "string" ? agent.login : undefined;
  const status = typeof record.status === "string" ? record.status : typeof record.state === "string" ? record.state : undefined;
  const url = typeof record.html_url === "string" ? record.html_url : typeof record.url === "string" ? record.url : undefined;
  return {
    id: String(record.id ?? ""),
    ...(agentLogin ? { agentLogin } : {}),
    ...(typeof record.branch === "string" ? { branch: record.branch } : {}),
    ...(status ? { status } : {}),
    ...(url ? { url } : {}),
    ...(typeof record.updated_at === "string" ? { updatedAt: record.updated_at } : {}),
  };
}

function agentGitServiceIssueWorkspaceAttachmentFromResponse(value: unknown): AgentGitServiceIssueWorkspaceAttachment {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const url = typeof record.html_url === "string" ? record.html_url : typeof record.url === "string" ? record.url : undefined;
  return {
    id: String(record.id ?? ""),
    ...(url ? { url } : {}),
  };
}

function agentGitServiceWikiMemoryPageFromResponse(value: unknown, fallbackPage: string): AgentGitServiceWikiMemoryPage {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const url = typeof record.html_url === "string" ? record.html_url : typeof record.url === "string" ? record.url : undefined;
  return {
    page: typeof record.page === "string" ? record.page : fallbackPage,
    body: typeof record.body === "string" ? record.body : "",
    ...(typeof record.sha === "string" ? { sha: record.sha } : {}),
    ...(url ? { url } : {}),
    ...(typeof record.updated_at === "string" ? { updatedAt: record.updated_at } : {}),
  };
}

function agentGitServiceIssueCommentFromResponse(value: unknown): AgentGitServiceIssueComment {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const user = record.user && typeof record.user === "object" ? record.user as Record<string, unknown> : undefined;
  return {
    id: String(record.id ?? ""),
    body: typeof record.body === "string" ? record.body : "",
    author: typeof user?.login === "string" ? user.login : undefined,
    url: typeof record.html_url === "string" ? record.html_url : typeof record.url === "string" ? record.url : undefined,
    createdAt: typeof record.created_at === "string" ? record.created_at : undefined,
    updatedAt: typeof record.updated_at === "string" ? record.updated_at : undefined,
  };
}

function agentGitServiceMergeMethod(method: MergeAgentGitServicePullRequestOptions["method"]): "merge" | "rebase" | "squash" {
  if (method === "squash") return "squash";
  if (method === "rebase" || method === "rebase-merge") return "rebase";
  return "merge";
}
