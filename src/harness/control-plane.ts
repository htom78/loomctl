import type { RunSummary } from "./events.js";

export interface ControlPlaneIssueRef {
  owner: string;
  repo: string;
  index: number;
}

export interface ControlPlaneRepoRef {
  owner: string;
  repo: string;
}

export interface ControlPlanePullRequest {
  index: number;
  url?: string;
}

export interface ControlPlaneIssueComment {
  id: string;
  body: string;
  author?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateControlPlaneIssueCommentOptions {
  baseUrl: string;
  token: string;
  issue: string;
  summary: RunSummary;
}

export interface ListControlPlaneIssueCommentsOptions {
  baseUrl: string;
  token: string;
  issue: string;
  limit?: number;
}

export interface CreateControlPlanePullRequestOptions {
  baseUrl: string;
  token: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface MergeControlPlanePullRequestOptions {
  baseUrl: string;
  token: string;
  repo: string;
  index: number;
  method?: "merge" | "rebase" | "rebase-merge" | "squash";
  title?: string;
  message?: string;
  force?: boolean;
}

export interface ControlPlaneProviderRuntimeContract {
  provider: ControlPlaneProviderCatalogName;
  boundary: readonly ControlPlaneProviderBoundary[];
  apiBasePath: string;
  discoveryEndpoints: readonly string[];
  nativeCapabilities: readonly string[];
}

export interface ControlPlaneProvider {
  contract: ControlPlaneProviderRuntimeContract;
  issueUrl(baseUrl: string, issue: string): string;
  gitRemoteUrl(baseUrl: string, repo: string): string;
  listIssueComments(options: ListControlPlaneIssueCommentsOptions): Promise<ControlPlaneIssueComment[]>;
  createIssueComment(options: CreateControlPlaneIssueCommentOptions): Promise<void>;
  createPullRequest(options: CreateControlPlanePullRequestOptions): Promise<ControlPlanePullRequest>;
  mergePullRequest(options: MergeControlPlanePullRequestOptions): Promise<void>;
}

export const CONTROL_PLANE_PROVIDER_BOUNDARY = [
  "issue-comments",
  "signed-webhooks",
  "pull-requests",
  "merge",
  "review-gate-evidence",
  "issue-url",
  "repo-ref",
  "source-defaults",
  "git-transport",
  "workspace-branch-lease",
  "agent-identity",
  "backup-restore-migration",
] as const;

export type ControlPlaneProviderBoundary = typeof CONTROL_PLANE_PROVIDER_BOUNDARY[number];

export const DEFAULT_CONTROL_PLANE_PROVIDER = "gitea-forgejo" as const;

export const CONTROL_PLANE_PROVIDER_NAMES = [
  DEFAULT_CONTROL_PLANE_PROVIDER,
  "agent-git-service",
] as const;

export type ControlPlaneProviderCatalogName = typeof CONTROL_PLANE_PROVIDER_NAMES[number];

export interface ControlPlaneProviderAdoptionStage {
  name: string;
  state: "available" | "gated";
  evidence: string[];
}

export interface ControlPlaneProviderCatalogEntry {
  name: ControlPlaneProviderCatalogName;
  status: "default" | "candidate";
  enabledForServe: boolean;
  boundary: ControlPlaneProviderBoundary[];
  apiBasePath: string;
  discoveryEndpoints: string[];
  nativeCapabilities: string[];
  adoptionStages: ControlPlaneProviderAdoptionStage[];
  adapterModule?: string;
  blockedBy: string[];
}

export const CONTROL_PLANE_PROVIDER_CATALOG = {
  "gitea-forgejo": {
    name: "gitea-forgejo",
    status: "default",
    enabledForServe: true,
    boundary: [...CONTROL_PLANE_PROVIDER_BOUNDARY],
    apiBasePath: "/api/v1",
    discoveryEndpoints: ["/api/v1/version"],
    nativeCapabilities: [
      "gitea-rest-v1",
      "git-smart-http",
    ],
    adoptionStages: [
      {
        name: "default-control-plane",
        state: "available",
        evidence: [
          "issue-comment-sync",
          "pull-request-reporter",
          "signed-webhooks",
          "platform-readiness-smoke",
        ],
      },
    ],
    blockedBy: [],
  },
  "agent-git-service": {
    name: "agent-git-service",
    status: "candidate",
    enabledForServe: true,
    boundary: [...CONTROL_PLANE_PROVIDER_BOUNDARY],
    apiBasePath: "/api/v3",
    discoveryEndpoints: ["/api/v3", "/api/v3/meta", "/api/v3/rate_limit"],
    nativeCapabilities: [
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
    ],
    adoptionStages: [
      {
        name: "adapter-seed",
        state: "available",
        evidence: [
          "github-compatible-rest-v3",
          "issue-comments",
          "pull-requests",
          "merge",
          "git-smart-http",
          "signed-webhooks",
          "backup-restore-dry-run",
        ],
      },
      {
        name: "operator-provisioning",
        state: "available",
        evidence: [
          "agent-registration",
          "repo-access-grants",
          "token-free-receipt",
          "optional-secret-store",
          "tenant-control-plane-identity",
        ],
      },
      {
        name: "cutover-rehearsal",
        state: "available",
        evidence: [
          "project-agent-readiness-gate",
          "token-env-injection",
          "secret-free-receipt-get",
          "secret-free-smoke-output",
        ],
      },
      {
        name: "tenant-default-cutover",
        state: "gated",
        evidence: [
          "repeat-platform-readiness-smoke",
          "multi-user-run-controls",
          "isolated-run-workspaces",
          "issue-comment-handoff",
          "vas-review",
          "brain-feedback",
          "backup-restore-dry-run",
        ],
      },
    ],
    adapterModule: "./agent-git-service.js",
    blockedBy: [],
  },
} as const satisfies Record<ControlPlaneProviderCatalogName, ControlPlaneProviderCatalogEntry>;

export const SERVE_CONTROL_PLANE_PROVIDERS = CONTROL_PLANE_PROVIDER_NAMES.filter(
  (name) => CONTROL_PLANE_PROVIDER_CATALOG[name].enabledForServe,
);

export function controlPlaneProviderCatalogEntry(name: string): ControlPlaneProviderCatalogEntry | undefined {
  return isControlPlaneProviderCatalogName(name) ? CONTROL_PLANE_PROVIDER_CATALOG[name] : undefined;
}

function isControlPlaneProviderCatalogName(name: string): name is ControlPlaneProviderCatalogName {
  return (CONTROL_PLANE_PROVIDER_NAMES as readonly string[]).includes(name);
}
