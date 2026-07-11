import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { createTenantAuditAppender, type TenantRole } from "../audit.js";
import { createAgentGitServiceIssueWorkspaceAttachment, listAgentGitServiceIssueWorkspaces, readAgentGitServiceWikiMemory, updateAgentGitServiceWikiMemory } from "../agent-git-service.js";
import { DASHBOARD_HTML } from "../dashboard.js";
import { WORKBENCH_HTML } from "../workbench.js";
import { type ModelAgentProtocol } from "../model-agent.js";
import { dispatchHarnessServerRoutes, type HarnessServerRouteCandidate } from "../server-routes.js";
import { createStateBackendHealthMonitor } from "../server-observability.js";
import { createOidcAuthenticator, type OidcAuthConfig, type OidcAuthenticator, type TenantApiKey } from "../server-auth.js";
import { createTenantApiKeyRouteHandlers } from "../server-api-keys.js";
import type { RunSummary } from "../events.js";
import { type ControlPlaneProviderCatalogName } from "../control-plane.js";
import { type GiteaIssueComment } from "../gitea.js";
import { type ProvisionAgentGitServiceProjectAgentOptions } from "../agent-git-service-provisioning.js";
import type { RunSignal } from "../../brain.js";
import { type WorkspaceExecutor } from "../executor.js";
import { type PlatformStateBackend } from "../storage/contracts.js";
import { runLeaseTtlMs } from "./admission.js";
import { RunCommentRequestBody, RunResumeRequestBody, PresenceRequestBody, QueuedRun, ActiveRun, ActiveRunSlot, QueueRecoveryAudit, StaleRunCleanupAudit, RunPresenceRegistry, DISTRIBUTED_RUN_QUEUE_POLL_MS, handleListRuns, handleCreateRun, drainQueuedRuns, recoverQueuedRuns, cleanupStaleRunningRuns, handleAbandonRun, handleCancelRun, handleResumeRun, handleCreateRunComment, handleUpdateRunPresence, handleListRunPresence, handleReadRun, shouldCloseRunEventStream, latestRunEvent, readRunEventsIfPresent, readRunStateIfPresent, createAgent } from "./runs.js";
import { RunWorkspaceIsolation, HarnessWorkspaceContext, WorkspaceFileWriteRequestBody, WorkspaceFileMoveRequestBody, WorkspaceCommandRequestBody, WorkspaceCommitRequestBody, WorkspacePullRequestRequestBody, WorkspaceSessionRequestBody, WorkspaceSessionInputRequestBody, WorkspaceClientRequestBody, ActiveWorkspaceSession, workspaceCommandTimeoutMs, workspaceSessionIdleTimeoutMs, handleRunWorkspaceCommand, handleRunScopedWorkspaceCommand, handleCreateWorkspaceCommit, handleCreateRunWorkspaceCommit, handleCreateWorkspacePullRequest, handleCreateRunWorkspacePullRequest, handleListWorkspaceCommands, handleListRunWorkspaceCommands, handleCreateWorkspaceSession, handleCreateRunWorkspaceSession, handleListWorkspaceSessions, handleListRunWorkspaceSessions, handleWriteWorkspaceSessionInput, handleStopWorkspaceSession, handleReadWorkspaceSessionEvents, clearWorkspaceSessionIdleTimer, handleWriteWorkspaceFile, handleWriteRunWorkspaceFile, handleDeleteWorkspaceFile, handleMoveWorkspaceFile, handleMoveRunWorkspaceFile, handleDeleteRunWorkspaceFile, handleReadRunWorkspaceInfo, handleReadRunWorkspaceDiff, handleReadWorkspaceFile, handleReadRunWorkspaceFile, handleListTenantWorkspaceUsageWarnings, runWorkspaceIsolation } from "./workspace.js";
import { ReviewRequestBody, ReviewClaimRequestBody, DeploymentRequestBody, IssueCommentSyncRequestBody, handleReviewRun, handleClaimRunReview, handleDeploymentRun, handleGiteaIssueCommentWebhook, handleSyncRunIssueComments, handleCreateRunHandoffFollowup, handleListRunHandoffFollowups, handleReadRunHandoffPackage, handleReadRunReviewSummary } from "./gates.js";
import { harnessServerStatus, publicUrl, requireSafeLocalExecutorOptions, serverHealth, serverReadiness, serverMetrics } from "./status.js";
import { VasCaseCreateRequestBody, VasCaseReviewRequestBody, VasCaseClaimRequestBody, VasCaseReviewRunRequestBody, handleListVasLiteCases, handleListVasLiteReviewQueue, handleListVasLiteLearnings, handleReadVasLiteCaseArtifacts, handleReadVasLiteCaseReviewPackage, handleListVasLiteCaseRuns, handleCreateVasLiteCase, handleReviewVasLiteCase, handleClaimVasLiteCase, handleCreateVasLiteCaseReviewRun } from "./vas.js";
import { AgentGitServiceProjectProvisionRequestBody, AgentGitServiceProvisioningPlanApplyRequestBody, ProjectCreateRequestBody, ProjectSourceDefaultsRequestBody, ProjectDefaultSkillsRequestBody, ProjectRunPolicyRequestBody, ProjectContractRequestBody, handleReadTenantAgentGitServiceProvisioningPlan, handleApplyTenantAgentGitServiceProvisioningPlan, handleReadProjectWorkspaceInfo, handleReadProjectWorkspaceDiff, handleCreateProject, handleProvisionAgentGitServiceProjectAgent, handleReadAgentGitServiceProjectProvisioningReceipt, handleUpdateProjectSourceDefaults, handleUpdateProjectDefaultSkills, handleUpdateProjectRunPolicy, handleUpdateProjectContract, handleListProjects, handleReadProject, handleUpdateProjectPresence, handleListProjectPresence } from "./projects.js";
import { TenantPolicy, TenantPolicyRequestBody, TenantPolicySettingsRequestBody, TenantPolicyEscalationRequestBody, TenantPolicyEscalationDecisionRequestBody, BrainSignalRequestBody, handleListTenantPolicyEscalations, handleCreateTenantPolicyEscalation, handleCreateBrainSignal, handleReadTenantBrainSignals, handleDecideTenantPolicyEscalation, handleReadTenantPolicy, handleReadTenantAccess, handleReadTenantStatus, handleReadTenantControlPlaneBackup, handleReadTenantControlPlaneCutoverReadiness, handleTenantControlPlaneRestoreDryRun, handleUpdateTenantPolicy, handleUpdateTenantPolicySettings, handleReadTenantAudit, handleListTenantModelUsageWarnings, readTenantPolicy, writeTenantPolicy, requireTenantAccess } from "./tenants.js";
import { CancelRequestBody, filterEvents, requireServerStatusAccess, requireSafeName, badRequest, payloadTooLarge, statusForError, writeJson, writeText, writeHtml, setCorsHeaders, startedAt } from "./shared.js";


const DEFAULT_RATE_LIMIT_RPS = 200;
const DEFAULT_RATE_LIMIT_BURST = 500;
const RATE_LIMIT_MAX_BUCKETS = 10_000;

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
const HTTP_JSON_BODY_LIMIT_BYTES = 1_000_000;

export function createHarnessHttpServer(options: HarnessServerOptions): Server {
  const workspaceRoot = resolve(options.workspaceRoot);
  const allowedTools = options.allowedTools ?? ["file.read", "file.write", "git.diff", "git.commit", "verify.run"];
  requireSafeLocalExecutorOptions({ ...options, workspaceRoot }, allowedTools);
  const activeRuns = new Map<string, ActiveRun>();
  const activeRunSlots = new Map<string, ActiveRunSlot>();
  const activeWorkspaces = new Map<string, string>();
  const activeSessions = new Map<string, ActiveWorkspaceSession>();
  const runPresence: RunPresenceRegistry = new Map();
  const projectPresence: RunPresenceRegistry = new Map();
  const queuedRuns: QueuedRun[] = [];
  const oidcAuthenticator = options.oidcAuthenticator ?? (options.oidcAuth ? createOidcAuthenticator(options.oidcAuth) : undefined);
  const serverOptions = { ...options, workspaceRoot, allowedTools, instanceId: options.instanceId ?? randomUUID(), oidcAuthenticator };
  const stateBackendHealth = serverOptions.stateBackend
    ? createStateBackendHealthMonitor(serverOptions.stateBackend, {
        probeIntervalMs: serverOptions.stateDependencyProbeIntervalMs,
        probeTimeoutMs: serverOptions.stateDependencyProbeTimeoutMs,
        maxStalenessMs: serverOptions.stateDependencyProbeMaxStalenessMs,
      })
    : undefined;
  stateBackendHealth?.start();
  void oidcAuthenticator?.ensureReady();
  const startedAt = new Date().toISOString();
  const appendAuditEvent = createTenantAuditAppender(workspaceRoot, options.stateBackend?.events);
  const tenantApiKeyRoutes = createTenantApiKeyRouteHandlers<TenantPolicy>({
    requireTenant: (value) => requireSafeName(value, "tenant"),
    requireAdmin: (req, tenant, url) => requireTenantAccess(req, tenant, serverOptions, url, "admin"),
    readPolicy: (tenant) => readTenantPolicy(workspaceRoot, tenant, serverOptions),
    writePolicy: (tenant, policy) => writeTenantPolicy(workspaceRoot, tenant, policy, serverOptions),
    configuredKeys: (tenant) => serverOptions.tenantApiKeys?.[tenant] ?? [],
    readBody: (req) => readJsonBody<unknown>(req),
    appendAuditEvent,
  });
  let closing = false;
  const queueRecovery: QueueRecoveryAudit = {
    status: "pending",
    scannedQueuedRuns: 0,
    recoveredQueuedRuns: 0,
    failedQueuedRuns: 0,
    errors: [],
    startedAt: new Date().toISOString(),
  };
  const staleRunCleanup: StaleRunCleanupAudit = serverOptions.autoAbandonStaleRuns
    ? {
        status: "pending",
        scannedRunningRuns: 0,
        abandonedStaleRuns: 0,
        skippedRunningRuns: 0,
        errors: [],
        startedAt: new Date().toISOString(),
      }
    : {
        status: "disabled",
        scannedRunningRuns: 0,
        abandonedStaleRuns: 0,
        skippedRunningRuns: 0,
        errors: [],
  };
  let drainingQueuedRuns = false;
  let queuedRunDrainRequested = false;
  const scheduleQueuedRuns = () => {
    if (closing) return;
    queuedRunDrainRequested = true;
    if (drainingQueuedRuns) return;
    drainingQueuedRuns = true;
    void (async () => {
      try {
        while (queuedRunDrainRequested) {
          queuedRunDrainRequested = false;
          await drainQueuedRuns(serverOptions, activeRuns, activeRunSlots, activeWorkspaces, queuedRuns, scheduleQueuedRuns, appendAuditEvent);
        }
      } finally {
        drainingQueuedRuns = false;
        if (queuedRunDrainRequested) scheduleQueuedRuns();
      }
    })();
  };
  const distributedQueuePoll = serverOptions.stateBackend
    ? setInterval(scheduleQueuedRuns, DISTRIBUTED_RUN_QUEUE_POLL_MS)
    : undefined;
  distributedQueuePoll?.unref?.();
  const runStaleCleanup = async (): Promise<void> => {
    if (!serverOptions.autoAbandonStaleRuns) return;
    try {
      await cleanupStaleRunningRuns(workspaceRoot, serverOptions, staleRunCleanup, appendAuditEvent);
      staleRunCleanup.status = "completed";
      staleRunCleanup.endedAt = new Date().toISOString();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      staleRunCleanup.status = "error";
      staleRunCleanup.endedAt = new Date().toISOString();
      staleRunCleanup.message = message;
      staleRunCleanup.errors.push({ message });
    }
  };
  void runStaleCleanup().then(() => recoverQueuedRuns(workspaceRoot, serverOptions, queuedRuns, queueRecovery, appendAuditEvent)).then(() => {
    queueRecovery.status = "completed";
    queueRecovery.endedAt = new Date().toISOString();
    if (queuedRuns.length > 0) scheduleQueuedRuns();
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    queueRecovery.status = "error";
    queueRecovery.endedAt = new Date().toISOString();
    queueRecovery.message = message;
    queueRecovery.errors.push({ message });
  });

  const rateLimitRps = serverOptions.rateLimitRps ?? DEFAULT_RATE_LIMIT_RPS;
  const rateLimitBurst = serverOptions.rateLimitBurst ?? DEFAULT_RATE_LIMIT_BURST;
  // Number of trusted reverse-proxy hops. 0 (default) = trust nobody: key on the
  // socket peer. X-Forwarded-For is client-controllable, so it is only consulted
  // when the operator declares how many trusted proxies sit in front; we then key
  // on the hop just before the trusted ones, i.e. the real remote client.
  const rateLimitTrustedProxyHops = Math.max(0, Math.trunc(serverOptions.rateLimitTrustedProxyHops ?? 0));
  const rateLimitBuckets = new Map<string, { tokens: number; refilledAt: number }>();
  const rateLimitClientKey = (req: IncomingMessage): string => {
    const socketAddress = req.socket.remoteAddress ?? "unknown";
    if (rateLimitTrustedProxyHops === 0) return socketAddress;
    const header = req.headers["x-forwarded-for"];
    const raw = Array.isArray(header) ? header.join(",") : header;
    const hops = (raw ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
    // Each trusted proxy appends exactly one entry on the right; the outermost
    // trusted proxy appended the real client's address. With N trusted hops that
    // entry is at index (len - N). Anything further left is client-supplied and
    // spoofable, so it is never used. If there are fewer entries than trusted
    // hops (misconfig or a client that skipped a proxy), fall back to the socket
    // peer rather than trusting a spoofable entry.
    const index = hops.length - rateLimitTrustedProxyHops;
    return index >= 0 && hops[index] ? hops[index] : socketAddress;
  };
  const takeRateLimitToken = (clientKey: string): boolean => {
    if (rateLimitRps <= 0) return true;
    const now = Date.now();
    // ponytail: lazy sweep instead of a timer; bounded by client-IP cardinality
    if (rateLimitBuckets.size > RATE_LIMIT_MAX_BUCKETS) {
      for (const [key, bucket] of rateLimitBuckets) {
        if (bucket.tokens >= rateLimitBurst && now - bucket.refilledAt > 60_000) rateLimitBuckets.delete(key);
      }
      // Hard cap: if idle-sweep freed nothing (e.g. a spray of many distinct low-rate
      // sources), evict the least-recently-refilled bucket so the map cannot grow
      // unbounded into an OOM. ponytail: O(n) scan, only runs while over the cap.
      while (rateLimitBuckets.size > RATE_LIMIT_MAX_BUCKETS) {
        let oldestKey: string | undefined;
        let oldestAt = Infinity;
        for (const [key, bucket] of rateLimitBuckets) {
          if (bucket.refilledAt < oldestAt) { oldestAt = bucket.refilledAt; oldestKey = key; }
        }
        if (oldestKey === undefined) break;
        rateLimitBuckets.delete(oldestKey);
      }
    }
    const bucket = rateLimitBuckets.get(clientKey) ?? { tokens: rateLimitBurst, refilledAt: now };
    bucket.tokens = Math.min(rateLimitBurst, bucket.tokens + ((now - bucket.refilledAt) / 1000) * rateLimitRps);
    bucket.refilledAt = now;
    if (bucket.tokens < 1) {
      rateLimitBuckets.set(clientKey, bucket);
      return false;
    }
    bucket.tokens -= 1;
    rateLimitBuckets.set(clientKey, bucket);
    return true;
  };

  const server = createServer(async (req, res) => {
    setCorsHeaders(res);

    // Rate-limit before dispatching anything, including OPTIONS preflight, so a
    // preflight flood cannot bypass the limiter. Health/readiness probes stay exempt.
    const requestPath = (req.url ?? "/").split("?")[0];
    if (requestPath !== "/healthz" && requestPath !== "/readyz" && !takeRateLimitToken(rateLimitClientKey(req))) {
      res.setHeader("retry-after", "1");
      writeJson(res, 429, { error: "too many requests" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
        writeHtml(res, 200, DASHBOARD_HTML);
        return;
      }

      if (req.method === "GET" && url.pathname === "/workbench") {
        writeHtml(res, 200, WORKBENCH_HTML);
        return;
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        writeJson(res, 200, serverHealth(startedAt));
        return;
      }

      if (req.method === "GET" && url.pathname === "/readyz") {
        const readiness = serverReadiness(
          startedAt,
          queueRecovery,
          staleRunCleanup,
          await stateBackendHealth?.ensureFresh(),
          await oidcAuthenticator?.ensureReady(),
        );
        writeJson(res, readiness.ready ? 200 : 503, readiness);
        return;
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        await requireServerStatusAccess(req, serverOptions, url);
        writeText(res, 200, await serverMetrics(
          workspaceRoot,
          serverOptions,
          startedAt,
          activeRunSlots,
          queuedRuns,
          activeSessions,
          queueRecovery,
          staleRunCleanup,
          await stateBackendHealth?.ensureFresh(),
          await oidcAuthenticator?.ensureReady(),
        ));
        return;
      }

      if (req.method === "GET" && url.pathname === "/status") {
        await requireServerStatusAccess(req, serverOptions, url);
        writeJson(res, 200, await harnessServerStatus(workspaceRoot, serverOptions, startedAt, allowedTools, activeRunSlots, activeWorkspaces, queuedRuns, activeSessions, queueRecovery, staleRunCleanup, await stateBackendHealth?.ensureFresh(), await oidcAuthenticator?.ensureReady()));
        return;
      }

      if (req.method === "POST" && url.pathname === "/runs") {
        await handleCreateRun(req, res, workspaceRoot, serverOptions, activeRuns, activeRunSlots, activeWorkspaces, queuedRuns, scheduleQueuedRuns, appendAuditEvent);
        return;
      }

      if (req.method === "POST") {
        const routes: HarnessServerRouteCandidate[] = [
          { domain: "control-plane", name: "issue-comment-webhook", handle: () => handleGiteaIssueCommentWebhook(url, req, res, workspaceRoot, serverOptions, activeRuns, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, scheduleQueuedRuns, appendAuditEvent) },
          { domain: "policy", name: "brain-signal-create", handle: () => handleCreateBrainSignal(url, req, res, serverOptions, appendAuditEvent) },
          { domain: "policy", name: "api-key-rotate", handle: () => tenantApiKeyRoutes.rotate(url, req, res) },
          { domain: "policy", name: "api-key-revoke", handle: () => tenantApiKeyRoutes.revoke(url, req, res) },
          { domain: "policy", name: "api-key-create", handle: () => tenantApiKeyRoutes.create(url, req, res) },
          { domain: "policy", name: "settings-update", handle: () => handleUpdateTenantPolicySettings(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "control-plane", name: "restore-dry-run", handle: () => handleTenantControlPlaneRestoreDryRun(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "control-plane", name: "ags-provisioning-plan-apply", handle: () => handleApplyTenantAgentGitServiceProvisioningPlan(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "policy", name: "escalation-decide", handle: () => handleDecideTenantPolicyEscalation(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "policy", name: "escalation-create", handle: () => handleCreateTenantPolicyEscalation(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "workspace", name: "project-create", handle: () => handleCreateProject(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "control-plane", name: "ags-project-agent-provision", handle: () => handleProvisionAgentGitServiceProjectAgent(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "vas", name: "case-create", handle: () => handleCreateVasLiteCase(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "vas", name: "case-review", handle: () => handleReviewVasLiteCase(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "vas", name: "case-claim", handle: () => handleClaimVasLiteCase(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "vas", name: "review-run-create", handle: () => handleCreateVasLiteCaseReviewRun(url, req, res, workspaceRoot, serverOptions, activeRuns, activeRunSlots, activeWorkspaces, queuedRuns, scheduleQueuedRuns, appendAuditEvent) },
          { domain: "workspace", name: "session-stop", handle: () => handleStopWorkspaceSession(url, req, res, serverOptions, activeSessions, appendAuditEvent) },
          { domain: "workspace", name: "session-input", handle: () => handleWriteWorkspaceSessionInput(url, req, res, serverOptions, activeSessions, appendAuditEvent) },
          { domain: "workspace", name: "run-session-create", handle: () => handleCreateRunWorkspaceSession(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, activeSessions, appendAuditEvent) },
          { domain: "workspace", name: "project-session-create", handle: () => handleCreateWorkspaceSession(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, activeSessions, appendAuditEvent) },
          { domain: "workspace", name: "run-file-write", handle: () => handleWriteRunWorkspaceFile(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent, runPresence) },
          { domain: "workspace", name: "run-file-move", handle: () => handleMoveRunWorkspaceFile(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent, runPresence) },
          { domain: "workspace", name: "run-commit", handle: () => handleCreateRunWorkspaceCommit(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent) },
          { domain: "workspace", name: "run-pull-request", handle: () => handleCreateRunWorkspacePullRequest(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent) },
          { domain: "workspace", name: "run-command", handle: () => handleRunScopedWorkspaceCommand(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent) },
          { domain: "runs", name: "handoff-followup", handle: () => handleCreateRunHandoffFollowup(url, req, res, workspaceRoot, serverOptions, activeRuns, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, scheduleQueuedRuns, appendAuditEvent) },
          { domain: "workspace", name: "project-command", handle: () => handleRunWorkspaceCommand(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent) },
          { domain: "workspace", name: "project-file-write", handle: () => handleWriteWorkspaceFile(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent, projectPresence) },
          { domain: "workspace", name: "project-file-move", handle: () => handleMoveWorkspaceFile(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent, projectPresence) },
          { domain: "workspace", name: "project-commit", handle: () => handleCreateWorkspaceCommit(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent) },
          { domain: "workspace", name: "project-pull-request", handle: () => handleCreateWorkspacePullRequest(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent) },
          { domain: "workspace", name: "project-presence-update", handle: () => handleUpdateProjectPresence(url, req, res, workspaceRoot, serverOptions, projectPresence) },
          { domain: "runs", name: "abandon", handle: () => handleAbandonRun(url, req, res, workspaceRoot, serverOptions, activeRuns, activeWorkspaces, appendAuditEvent) },
          { domain: "runs", name: "cancel", handle: () => handleCancelRun(url, req, res, workspaceRoot, serverOptions, activeRuns, queuedRuns, scheduleQueuedRuns, appendAuditEvent) },
          { domain: "runs", name: "resume", handle: () => handleResumeRun(url, req, res, workspaceRoot, serverOptions, activeRuns, activeRunSlots, activeWorkspaces, scheduleQueuedRuns, appendAuditEvent) },
          { domain: "runs", name: "review-claim", handle: () => handleClaimRunReview(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "runs", name: "review", handle: () => handleReviewRun(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "runs", name: "deployment", handle: () => handleDeploymentRun(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "runs", name: "issue-comments-sync", handle: () => handleSyncRunIssueComments(url, req, res, workspaceRoot, serverOptions, activeRuns, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, scheduleQueuedRuns, appendAuditEvent) },
          { domain: "runs", name: "comment", handle: () => handleCreateRunComment(url, req, res, workspaceRoot, serverOptions, activeRuns, appendAuditEvent) },
          { domain: "runs", name: "presence-update", handle: () => handleUpdateRunPresence(url, req, res, workspaceRoot, serverOptions, runPresence) },
        ];
        if (await dispatchHarnessServerRoutes(routes)) return;
      }

      if (req.method === "PUT") {
        if (await dispatchHarnessServerRoutes([
          { domain: "policy", name: "project-run-policy", handle: () => handleUpdateProjectRunPolicy(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "policy", name: "project-contract", handle: () => handleUpdateProjectContract(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "policy", name: "project-default-skills", handle: () => handleUpdateProjectDefaultSkills(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "control-plane", name: "project-source-defaults", handle: () => handleUpdateProjectSourceDefaults(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
          { domain: "policy", name: "tenant-policy", handle: () => handleUpdateTenantPolicy(url, req, res, workspaceRoot, serverOptions, appendAuditEvent) },
        ])) return;
      }

      if (req.method === "DELETE") {
        if (await dispatchHarnessServerRoutes([
          { domain: "workspace", name: "run-file-delete", handle: () => handleDeleteRunWorkspaceFile(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent, runPresence) },
          { domain: "workspace", name: "project-file-delete", handle: () => handleDeleteWorkspaceFile(url, req, res, workspaceRoot, serverOptions, activeWorkspaces, appendAuditEvent, projectPresence) },
        ])) return;
      }

      if (req.method === "GET") {
        const routes: HarnessServerRouteCandidate[] = [
          { domain: "policy", name: "tenant-access", handle: () => handleReadTenantAccess(url, req, res, serverOptions) },
          { domain: "policy", name: "tenant-status", handle: () => handleReadTenantStatus(url, req, res, workspaceRoot, serverOptions, allowedTools, startedAt, activeRunSlots, activeWorkspaces, queuedRuns, activeSessions) },
          { domain: "control-plane", name: "backup", handle: () => handleReadTenantControlPlaneBackup(url, req, res, workspaceRoot, serverOptions) },
          { domain: "control-plane", name: "cutover-readiness", handle: () => handleReadTenantControlPlaneCutoverReadiness(url, req, res, workspaceRoot, serverOptions) },
          { domain: "control-plane", name: "ags-provisioning-plan", handle: () => handleReadTenantAgentGitServiceProvisioningPlan(url, req, res, workspaceRoot, serverOptions) },
          { domain: "policy", name: "escalations", handle: () => handleListTenantPolicyEscalations(url, req, res, workspaceRoot, serverOptions) },
          { domain: "policy", name: "tenant-policy", handle: () => handleReadTenantPolicy(url, req, res, workspaceRoot, serverOptions) },
          { domain: "policy", name: "audit", handle: () => handleReadTenantAudit(url, req, res, workspaceRoot, serverOptions) },
          { domain: "policy", name: "brain-signals", handle: () => handleReadTenantBrainSignals(url, req, res, workspaceRoot, serverOptions) },
          { domain: "workspace", name: "run-commands", handle: () => handleListRunWorkspaceCommands(url, req, res, workspaceRoot, serverOptions) },
          { domain: "workspace", name: "project-commands", handle: () => handleListWorkspaceCommands(url, req, res, workspaceRoot, serverOptions) },
          { domain: "control-plane", name: "ags-provisioning-receipt", handle: () => handleReadAgentGitServiceProjectProvisioningReceipt(url, req, res, workspaceRoot, serverOptions) },
          { domain: "workspace", name: "run-sessions", handle: () => handleListRunWorkspaceSessions(url, req, res, workspaceRoot, serverOptions, activeSessions) },
          { domain: "workspace", name: "project-sessions", handle: () => handleListWorkspaceSessions(url, req, res, workspaceRoot, serverOptions, activeSessions) },
          { domain: "workspace", name: "project-presence", handle: () => handleListProjectPresence(url, req, res, workspaceRoot, serverOptions, projectPresence) },
          { domain: "vas", name: "review-queue", handle: () => handleListVasLiteReviewQueue(url, req, res, workspaceRoot, serverOptions) },
          { domain: "vas", name: "learnings", handle: () => handleListVasLiteLearnings(url, req, res, workspaceRoot, serverOptions) },
          { domain: "vas", name: "case-review-package", handle: () => handleReadVasLiteCaseReviewPackage(url, req, res, workspaceRoot, serverOptions) },
          { domain: "vas", name: "case-runs", handle: () => handleListVasLiteCaseRuns(url, req, res, workspaceRoot, serverOptions) },
          { domain: "vas", name: "case-artifacts", handle: () => handleReadVasLiteCaseArtifacts(url, req, res, workspaceRoot, serverOptions) },
          { domain: "vas", name: "cases", handle: () => handleListVasLiteCases(url, req, res, workspaceRoot, serverOptions) },
          { domain: "workspace", name: "session-events", handle: () => handleReadWorkspaceSessionEvents(url, req, res, serverOptions, activeSessions) },
          { domain: "runs", name: "handoff-followups", handle: () => handleListRunHandoffFollowups(url, req, res, workspaceRoot, serverOptions) },
          { domain: "runs", name: "handoff-package", handle: () => handleReadRunHandoffPackage(url, req, res, workspaceRoot, serverOptions, activeSessions) },
          { domain: "runs", name: "review-summary", handle: () => handleReadRunReviewSummary(url, req, res, workspaceRoot, serverOptions) },
          { domain: "workspace", name: "run-diff", handle: () => handleReadRunWorkspaceDiff(url, req, res, workspaceRoot, serverOptions) },
          { domain: "workspace", name: "project-diff", handle: () => handleReadProjectWorkspaceDiff(url, req, res, workspaceRoot, serverOptions) },
          { domain: "workspace", name: "run-info", handle: () => handleReadRunWorkspaceInfo(url, req, res, workspaceRoot, serverOptions) },
          { domain: "workspace", name: "project-info", handle: () => handleReadProjectWorkspaceInfo(url, req, res, workspaceRoot, serverOptions) },
          { domain: "workspace", name: "run-file", handle: () => handleReadRunWorkspaceFile(url, req, res, workspaceRoot, serverOptions) },
          { domain: "workspace", name: "project-file", handle: () => handleReadWorkspaceFile(url, req, res, workspaceRoot, serverOptions) },
          { domain: "workspace", name: "project", handle: () => handleReadProject(url, req, res, workspaceRoot, serverOptions, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, projectPresence, runPresence) },
          { domain: "workspace", name: "projects", handle: () => handleListProjects(url, req, res, workspaceRoot, serverOptions, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, projectPresence, runPresence) },
          { domain: "policy", name: "model-usage-warnings", handle: () => handleListTenantModelUsageWarnings(url, req, res, workspaceRoot, serverOptions, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, projectPresence, runPresence) },
          { domain: "policy", name: "workspace-usage-warnings", handle: () => handleListTenantWorkspaceUsageWarnings(url, req, res, workspaceRoot, serverOptions, activeRunSlots, activeWorkspaces, activeSessions, queuedRuns, projectPresence, runPresence) },
          { domain: "runs", name: "list", handle: () => handleListRuns(url, req, res, workspaceRoot, serverOptions, activeRunSlots, activeWorkspaces, queuedRuns) },
          { domain: "runs", name: "presence", handle: () => handleListRunPresence(url, req, res, workspaceRoot, serverOptions, runPresence) },
          { domain: "runs", name: "read", handle: () => handleReadRun(url, req, res, workspaceRoot, serverOptions, activeRunSlots, activeWorkspaces, queuedRuns) },
        ];
        if (await dispatchHarnessServerRoutes(routes)) return;
      }

      writeJson(res, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(res, statusForError(error), { error: message });
    }
  });
  server.once("close", () => {
    closing = true;
    stateBackendHealth?.stop();
    if (distributedQueuePoll) clearInterval(distributedQueuePoll);
    queuedRunDrainRequested = false;
    queuedRuns.splice(0);
    for (const active of activeRuns.values()) {
      active.controller.abort(new Error("harness server closed"));
    }
    for (const session of activeSessions.values()) {
      clearWorkspaceSessionIdleTimer(session);
      for (const cleanup of session.cleanup) cleanup();
      session.admissionHeartbeat();
      void session.admissionClaim.release().catch(() => undefined);
      void session.session.stop().catch(() => undefined);
      activeWorkspaces.delete(session.workspaceKey);
    }
    activeSessions.clear();
  });
  return server;
}

async function streamEvents(res: ServerResponse, runDir: string, after: number, options: HarnessServerOptions): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders();

  let lastSeq = after;
  const deadline = Date.now() + 60_000;

  while (!res.destroyed && Date.now() < deadline) {
    const allEvents = await readRunEventsIfPresent(runDir, options);
    const events = filterEvents(allEvents, lastSeq);
    for (const event of events) {
      lastSeq = Math.max(lastSeq, event.seq);
      res.write(`event: harness_event\n`);
      res.write(`id: ${event.seq}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const latestEvent = latestRunEvent(allEvents);
    const state = await readRunStateIfPresent(runDir, options);
    if (shouldCloseRunEventStream(state, latestEvent, lastSeq)) {
      res.end();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  res.end();
}

async function readReviewJson(req: IncomingMessage): Promise<ReviewRequestBody> {
  return readJsonBody<ReviewRequestBody>(req);
}

async function readReviewClaimJson(req: IncomingMessage): Promise<ReviewClaimRequestBody> {
  return readJsonBody<ReviewClaimRequestBody>(req);
}

async function readDeploymentJson(req: IncomingMessage): Promise<DeploymentRequestBody> {
  return readJsonBody<DeploymentRequestBody>(req);
}

async function readCancelJson(req: IncomingMessage): Promise<CancelRequestBody> {
  return readJsonBody<CancelRequestBody>(req);
}

async function readRunCommentJson(req: IncomingMessage): Promise<RunCommentRequestBody> {
  return readJsonBody<RunCommentRequestBody>(req);
}

async function readIssueCommentSyncJson(req: IncomingMessage): Promise<IssueCommentSyncRequestBody> {
  return readJsonBody<IssueCommentSyncRequestBody>(req);
}

async function readRunResumeJson(req: IncomingMessage): Promise<RunResumeRequestBody> {
  return readJsonBody<RunResumeRequestBody>(req);
}

async function readProjectCreateJson(req: IncomingMessage): Promise<ProjectCreateRequestBody> {
  return readJsonBody<ProjectCreateRequestBody>(req);
}

async function readProjectSourceDefaultsJson(req: IncomingMessage): Promise<ProjectSourceDefaultsRequestBody> {
  return readJsonBody<ProjectSourceDefaultsRequestBody>(req);
}

async function readProjectDefaultSkillsJson(req: IncomingMessage): Promise<ProjectDefaultSkillsRequestBody> {
  return readJsonBody<ProjectDefaultSkillsRequestBody>(req);
}

async function readProjectRunPolicyJson(req: IncomingMessage): Promise<ProjectRunPolicyRequestBody> {
  return readJsonBody<ProjectRunPolicyRequestBody>(req);
}

async function readProjectContractJson(req: IncomingMessage): Promise<ProjectContractRequestBody> {
  return readJsonBody<ProjectContractRequestBody>(req);
}

async function readBrainSignalJson(req: IncomingMessage): Promise<BrainSignalRequestBody> {
  return readJsonBody<BrainSignalRequestBody>(req);
}

async function readVasCaseCreateJson(req: IncomingMessage): Promise<VasCaseCreateRequestBody> {
  return readJsonBody<VasCaseCreateRequestBody>(req);
}

async function readVasCaseReviewJson(req: IncomingMessage): Promise<VasCaseReviewRequestBody> {
  return readJsonBody<VasCaseReviewRequestBody>(req);
}

async function readVasCaseClaimJson(req: IncomingMessage): Promise<VasCaseClaimRequestBody> {
  return readJsonBody<VasCaseClaimRequestBody>(req);
}

async function readVasCaseReviewRunJson(req: IncomingMessage): Promise<VasCaseReviewRunRequestBody> {
  return readJsonBody<VasCaseReviewRunRequestBody>(req);
}

async function readPresenceJson(req: IncomingMessage): Promise<PresenceRequestBody> {
  return readJsonBody<PresenceRequestBody>(req);
}

async function readWorkspaceFileJson(req: IncomingMessage): Promise<WorkspaceFileWriteRequestBody> {
  return readJsonBody<WorkspaceFileWriteRequestBody>(req);
}

async function readWorkspaceFileMoveJson(req: IncomingMessage): Promise<WorkspaceFileMoveRequestBody> {
  return readJsonBody<WorkspaceFileMoveRequestBody>(req);
}

async function readWorkspaceCommandJson(req: IncomingMessage): Promise<WorkspaceCommandRequestBody> {
  return readJsonBody<WorkspaceCommandRequestBody>(req);
}

async function readWorkspaceCommitJson(req: IncomingMessage): Promise<WorkspaceCommitRequestBody> {
  return readJsonBody<WorkspaceCommitRequestBody>(req);
}

async function readWorkspacePullRequestJson(req: IncomingMessage): Promise<WorkspacePullRequestRequestBody> {
  return readJsonBody<WorkspacePullRequestRequestBody>(req);
}

async function readWorkspaceSessionJson(req: IncomingMessage): Promise<WorkspaceSessionRequestBody> {
  return readJsonBody<WorkspaceSessionRequestBody>(req);
}

async function readWorkspaceSessionInputJson(req: IncomingMessage): Promise<WorkspaceSessionInputRequestBody> {
  return readJsonBody<WorkspaceSessionInputRequestBody>(req);
}

async function readWorkspaceClientJson(req: IncomingMessage): Promise<WorkspaceClientRequestBody> {
  return readJsonBody<WorkspaceClientRequestBody>(req);
}

async function readTenantPolicyJson(req: IncomingMessage): Promise<TenantPolicyRequestBody> {
  return readJsonBody<TenantPolicyRequestBody>(req);
}

async function readTenantPolicySettingsJson(req: IncomingMessage): Promise<TenantPolicySettingsRequestBody> {
  return readJsonBody<TenantPolicySettingsRequestBody>(req);
}

async function readTenantPolicyEscalationJson(req: IncomingMessage): Promise<TenantPolicyEscalationRequestBody> {
  return readJsonBody<TenantPolicyEscalationRequestBody>(req);
}

async function readTenantPolicyEscalationDecisionJson(req: IncomingMessage): Promise<TenantPolicyEscalationDecisionRequestBody> {
  return readJsonBody<TenantPolicyEscalationDecisionRequestBody>(req);
}

async function readTenantControlPlaneBackupManifestJson(req: IncomingMessage): Promise<unknown> {
  return readJsonBody<unknown>(req);
}

async function readAgentGitServiceProjectProvisionJson(req: IncomingMessage): Promise<AgentGitServiceProjectProvisionRequestBody> {
  return readJsonBody<AgentGitServiceProjectProvisionRequestBody>(req);
}

async function readAgentGitServiceProvisioningPlanApplyJson(req: IncomingMessage): Promise<AgentGitServiceProvisioningPlanApplyRequestBody> {
  return readJsonBody<AgentGitServiceProvisioningPlanApplyRequestBody>(req);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const raw = await readRawBody(req);
  try {
    return JSON.parse(raw.toString("utf8") || "{}") as T;
  } catch {
    throw badRequest("invalid JSON body");
  }
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > HTTP_JSON_BODY_LIMIT_BYTES) throw payloadTooLarge("request body too large");
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

export { HTTP_JSON_BODY_LIMIT_BYTES, streamEvents, readReviewJson, readReviewClaimJson, readDeploymentJson, readCancelJson, readRunCommentJson, readIssueCommentSyncJson, readRunResumeJson, readProjectCreateJson, readProjectSourceDefaultsJson, readProjectDefaultSkillsJson, readProjectRunPolicyJson, readProjectContractJson, readBrainSignalJson, readVasCaseCreateJson, readVasCaseReviewJson, readVasCaseClaimJson, readVasCaseReviewRunJson, readPresenceJson, readWorkspaceFileJson, readWorkspaceFileMoveJson, readWorkspaceCommandJson, readWorkspaceCommitJson, readWorkspacePullRequestJson, readWorkspaceSessionJson, readWorkspaceSessionInputJson, readWorkspaceClientJson, readTenantPolicyJson, readTenantPolicySettingsJson, readTenantPolicyEscalationJson, readTenantPolicyEscalationDecisionJson, readTenantControlPlaneBackupManifestJson, readAgentGitServiceProjectProvisionJson, readAgentGitServiceProvisioningPlanApplyJson, readJsonBody, readRawBody };
