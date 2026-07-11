import type { TenantRole } from "../audit.js";
import type { createAgentGitServiceIssueWorkspaceAttachment, listAgentGitServiceIssueWorkspaces, readAgentGitServiceWikiMemory, updateAgentGitServiceWikiMemory } from "../agent-git-service.js";
import type { ModelAgentProtocol } from "../model-agent.js";
import type { OidcAuthConfig, OidcAuthenticator, TenantApiKey } from "../server-auth.js";
import type { RunSummary } from "../events.js";
import type { ControlPlaneProviderCatalogName } from "../control-plane.js";
import type { GiteaIssueComment } from "../gitea.js";
import type { ProvisionAgentGitServiceProjectAgentOptions } from "../agent-git-service-provisioning.js";
import type { RunSignal } from "../../brain.js";
import type { WorkspaceExecutor } from "../executor.js";
import type { PlatformStateBackend } from "../storage/contracts.js";

export const HTTP_JSON_BODY_LIMIT_BYTES = 1_000_000;

export interface TenantExecutorLimits {
  cpus?: number;
  memory?: string;
  pidsLimit?: number;
  network?: string;
}

export type RunWorkspaceIsolation = "project" | "run";

export interface HarnessWorkspaceContext {
  tenant: string;
  project: string;
  runId: string;
  cwd: string;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  issue?: string;
  executorLimits?: TenantExecutorLimits;
  executorTemplateParameters?: string[];
}

export interface PullRequestReporterResult {
  index?: number;
  url?: string;
}

export interface WorkspacePullRequestRequest {
  tenant: string;
  project: string;
  runId?: string;
  issue: string;
  issueUrl?: string;
  branch: string;
  baseBranch?: string;
  title: string;
  body: string;
  commit?: string;
  push: boolean;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
}

export interface IssueCommentReaderContext {
  tenant: string;
  project: string;
  runId?: string;
}

export type ControlPlaneProviderName = ControlPlaneProviderCatalogName;
export type ControlPlaneAgentIdentityMode = "shared" | "tenant-scoped";

export interface ControlPlaneAgentIdentityConfig {
  mode: ControlPlaneAgentIdentityMode;
  tenants?: string[];
}

export interface HarnessServerOptions {
  workspaceRoot: string;
  profile?: string;
  controlPlaneProvider?: ControlPlaneProviderName;
  executorKind?: string;
  executorHomeRoot?: string;
  defaultMaxIterations?: number;
  modelBaseUrl?: string;
  modelApiKey?: string;
  modelProtocol?: ModelAgentProtocol;
  tenantModelKeyEnvs?: Record<string, string>;
  defaultModel?: string;
  allowedTools?: string[];
  tenantTokens?: Record<string, string>;
  tenantApiKeys?: Record<string, TenantApiKey[]>;
  oidcAuth?: OidcAuthConfig;
  oidcAuthenticator?: OidcAuthenticator;
  controlPlaneAgentIdentity?: ControlPlaneAgentIdentityConfig;
  createExecutor?: (cwd: string, context: HarnessWorkspaceContext) => WorkspaceExecutor;
  runWorkspaceIsolation?: RunWorkspaceIsolation;
  allowUnsafeLocalExecutor?: boolean;
  issueReporter?: (summary: RunSummary) => Promise<void>;
  pullRequestReporter?: (summary: RunSummary) => Promise<PullRequestReporterResult | void>;
  workspacePullRequestReporter?: (request: WorkspacePullRequestRequest) => Promise<PullRequestReporterResult | void>;
  mergeReporter?: (summary: RunSummary, note?: string) => Promise<void>;
  issueCommentReader?: (issue: string, context: IssueCommentReaderContext) => Promise<GiteaIssueComment[]>;
  giteaWebhookSecret?: string;
  brainIngest?: (summary: RunSummary) => Promise<void> | void;
  brainSignalIngest?: (signal: RunSignal) => Promise<void> | void;
  publicUrl?: string;
  issueBaseUrl?: string;
  workspaceCommandTimeoutMs?: number;
  maxWorkspaceSessions?: number;
  maxTenantWorkspaceSessions?: number;
  maxTenantActiveRuns?: number;
  workspaceSessionIdleTimeoutMs?: number;
  runLeaseTtlMs?: number;
  autoAbandonStaleRuns?: boolean;
  rateLimitRps?: number;
  rateLimitBurst?: number;
  rateLimitTrustedProxyHops?: number;
  controlPlaneBaseUrl?: string;
  controlPlaneAdminToken?: string;
  controlPlaneTenantTokens?: Record<string, string>;
  operatorBundleDir?: string;
  agentGitServiceCreateAgent?: ProvisionAgentGitServiceProjectAgentOptions["createAgent"];
  agentGitServiceGrantRepoAccess?: ProvisionAgentGitServiceProjectAgentOptions["grantRepoAccess"];
  agentGitServiceListIssueWorkspaces?: typeof listAgentGitServiceIssueWorkspaces;
  agentGitServiceCreateIssueWorkspaceAttachment?: typeof createAgentGitServiceIssueWorkspaceAttachment;
  agentGitServiceReadWikiMemory?: typeof readAgentGitServiceWikiMemory;
  agentGitServiceUpdateWikiMemory?: typeof updateAgentGitServiceWikiMemory;
  agentGitServiceTokenSecretRoot?: string;
  stateBackend?: PlatformStateBackend;
  instanceId?: string;
  stateDependencyProbeIntervalMs?: number;
  stateDependencyProbeTimeoutMs?: number;
  stateDependencyProbeMaxStalenessMs?: number;
}
