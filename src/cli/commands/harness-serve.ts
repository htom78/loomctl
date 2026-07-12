import { ingest, type RunSignal } from "../../brain.js";
import { startAgentGitServiceContractServer } from "../../harness/agent-git-service-contract-server.js";
import { agentGitServiceProjectProvisioningReceiptPath } from "../../harness/agent-git-service-provisioning.js";
import { controlPlaneProviderAdapter } from "../../harness/control-plane-registry.js";
import { CONTROL_PLANE_PROVIDER_BOUNDARY, type ControlPlaneIssueComment, type ControlPlaneProvider, type ControlPlaneProviderAdoptionStage, controlPlaneProviderCatalogEntry } from "../../harness/control-plane.js";
import { type RunSummary } from "../../harness/events.js";
import { createLocalExecutor, type WorkspaceExecutor } from "../../harness/executor.js";
import { formatRunRequesterSummary } from "../../harness/gitea.js";
import { HARNESS_VISION_LOCK, ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES, ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS } from "../../harness/profile-contract.js";
import { type ControlPlaneAgentIdentityConfig, type ControlPlaneProviderName, createHarnessHttpServer, type HarnessWorkspaceContext, type IssueCommentReaderContext, type OidcAuthConfig, type TenantApiKey, type WorkspacePullRequestRequest } from "../../harness/server.js";
import { assertTenantName } from "../../tenant.js";
import { cfg } from "../lib/context.js";
import { type HarnessCutoverReport, readHarnessCutoverReportViaHarness } from "../lib/cutover-report.js";
import { type ExecutorCliOptions, executorConfigurationIssues, executorFactoryFromOptions, executorHomeRootFromOptions } from "../lib/executor.js";
import { collect, CONTROL_PLANE_PROVIDER_HELP, DEFAULT_GITEA_TOKEN_ENV, type HarnessOnlineProfileName, type HarnessServeCliOptions, isEnvName, isProjectDirectoryNameForDoctor, isRecord, parseControlPlaneProviderFlag, parseModelProtocolFlag, parseOnlineProfileFlag, parsePositiveIntFlag, parseSafeNameFlag, parseTenantFlagName, writeJsonReportIfRequested } from "../lib/flags.js";
import { controlPlaneBaseUrl, controlPlaneReporterFlag, controlPlaneTokenEnv, giteaTokenForTenant, issueReporterControlPlaneProvider, type IssueReporterOptions, maybeIssueReporter, maybePullRequestReporter, missingSharedGiteaTokenEnvName, missingTenantGiteaTokenEnvEntries, parseIssueRefForControlPlane, prBaseBranch, type PullRequestReporterResult, runSignalFromSummary, validateControlPlaneTokenEnvs } from "../lib/reporters.js";
import { type HarnessSmokeCliOptions, type HarnessSmokeResult, runHarnessSmoke, smokeHeaders, smokeJson, smokeProjectCreateBody } from "../lib/smoke.js";
import { createStateBackendFromCliOptions, parseStateBackendFlag, stateBackendFlagIssues } from "../state-backend.js";
import { Command } from "commander";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function registerHarnessRehearsalCommand(harness: Command): void {
harness
  .command("rehearsal")
  .description("run a self-contained local platform-readiness rehearsal")
  .option("--workspace-root <path>", "workspace root for rehearsal artifacts; defaults to a temp dir")
  .option("--host <host>", "loopback host for the temporary servers", "127.0.0.1")
  .option("--tenant <tenant>", "tenant to exercise", "alice")
  .option("--isolation-tenant <tenant>", "second tenant used to prove isolation", "bob")
  .option("--project <project>", "project to create or reuse", "rehearsal-platform")
  .option("--control-plane-provider <provider>", CONTROL_PLANE_PROVIDER_HELP, "gitea-forgejo")
  .option("--peer-server", "start a second local harness server sharing the same workspace root", false)
  .action(async (opts: HarnessRehearsalCliOptions) => {
    try {
      const result = await runHarnessRehearsal(opts);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
}

export function registerHarnessSmokeCommand(harness: Command): void {
harness
  .command("smoke")
  .description("smoke-test a running harness HTTP control plane with a tiny project/run round trip")
  .option("--url <url>", "harness server base URL", "http://127.0.0.1:8787")
  .option("--peer-url <url>", "optional second harness server base URL used for cross-server run-control and idempotent-create smoke")
  .option("--tenant <tenant>", "tenant to exercise", "alice")
  .option("--project <project>", "project to create or reuse", "smoke")
  .option("--template <template>", "project template: empty|vas-lite", "vas-lite")
  .option("--token <token>", "tenant API token; prefer --token-env for shared shells")
  .option("--token-env <name>", "env var containing the tenant API token")
  .option("--viewer-token <token>", "viewer tenant API token used by --check-auth-roles; prefer --viewer-token-env")
  .option("--viewer-token-env <name>", "env var containing the viewer tenant API token")
  .option("--admin-token <token>", "admin tenant API token used by --check-gates; prefer --admin-token-env")
  .option("--admin-token-env <name>", "env var containing the admin tenant API token")
  .option("--isolation-tenant <tenant>", "tenant that must reject this smoke token; required by --profile")
  .option("--profile <profile>", "named smoke profile: online-sandbox|platform-readiness")
  .option("--control-plane-provider <provider>", CONTROL_PLANE_PROVIDER_HELP)
  .option("--control-plane-webhook-secret-env <name>", "env var containing the control-plane webhook secret for signed issue-comment webhook smoke")
  .option("--gitea-webhook-secret-env <name>", "env var containing the Gitea/Forgejo webhook secret for signed issue-comment webhook smoke")
  .option("--check-command", "also verify the workspace command endpoint; requires shell.exec")
  .option("--check-session", "also verify the persistent workspace session endpoint; requires shell.exec")
  .option("--check-vas", "also verify vas-lite project endpoints; requires --template vas-lite")
  .option("--check-online", "also verify dashboard/workbench HTML, readiness labels, and collaborator presence endpoints")
  .option("--check-auth-roles", "also verify developer/viewer tenant API key boundaries; requires --viewer-token or --viewer-token-env")
  .option("--check-gates", "also verify review and deployment human gates; requires --admin-token or --admin-token-env")
  .option("--check-escalations", "also verify tenant policy escalation requests and admin decisions; requires --admin-token or --admin-token-env")
  .option("--check-handoff", "also verify review summary and handoff package evidence endpoints; requires git.diff")
  .option("--check-run-controls", "also verify async run pause/resume/cancel controls; requires shell.exec")
  .option("--check-file-collab", "also verify stale workspace file conflicts include same-file collaborator evidence")
  .option("--check-brain", "also verify tenant brain signal ingest and feed; requires --ingest-brain on the server")
  .option("--check-model", "also verify a model-backed run through the configured OpenAI-compatible gateway")
  .option("--check-control-plane-pr", "also verify control-plane pull request creation through a review-gated run")
  .option("--check-control-plane-comments", "also verify control-plane issue comment sync can drive a review-gated run")
  .option("--check-gitea-pr", "also verify Gitea/Forgejo pull request creation through a review-gated run")
  .option("--check-gitea-comments", "also verify Gitea/Forgejo issue comment sync can drive a review-gated run")
  .option("--check-backup", "also verify the tenant control-plane backup/migration manifest and restore dry-run; requires --admin-token or --admin-token-env")
  .option("--check-metrics", "also verify the low-cardinality metrics endpoint without exposing tenant/project/run labels")
  .option("--check-agent-git-service-cutover", "also verify an AGS provisioning receipt and stored project-agent token reach workspace commands without exposing token material; requires shell.exec")
  .option("--check-coder", "also verify Coder-style workspace context and browser IDE/preview links")
  .option("--report <path>", "write the token-free smoke JSON to this path")
  .action(async (opts: HarnessSmokeCliOptions) => {
    try {
      const result = await runHarnessSmoke(opts);
      await writeJsonReportIfRequested(opts.report, result);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status === "passed" ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
}

export function registerHarnessServeCommands(harness: Command): void {
harness
  .command("doctor")
  .description("preflight-check harness serve options before starting an online sandbox")
  .option("--workspace-root <path>", "tenant workspace root", process.cwd())
  .option("--host <host>", "listen host", "127.0.0.1")
  .option("--port <port>", "listen port", "8787")
  .option("--profile <profile>", "named serve profile: online-sandbox|platform-readiness")
  .option("--model-base-url <url>", "OpenAI-compatible base URL", cfg.gatewayUrl)
  .option("--model-key-env <name>", "env var containing the model API key", cfg.gatewayKeyEnv)
  .option("--default-model <name>", "default OpenAI-compatible model", cfg.models.default)
  .option("--model-protocol <protocol>", "default model agent protocol: json|tool-call", "json")
  .option("--executor <kind>", "workspace executor: local|docker|coder", "local")
  .option("--executor-image <image>", "Docker image when --executor docker is used")
  .option("--executor-network <mode>", "Docker network mode for --executor docker")
  .option("--executor-cpus <count>", "Docker CPU limit, or Coder cpus template parameter")
  .option("--executor-memory <size>", "Docker memory limit, or Coder memory_gb template parameter")
  .option("--executor-pids-limit <count>", "Docker pids limit, or Coder pids_limit template parameter")
  .option("--executor-home-root <path>", "persistent Docker home root; mounts <path>/<tenant> at /home/dev")
  .option("--executor-workspace <name>", "Coder workspace name or template when --executor coder is used")
  .option("--executor-remote-cwd <path>", "remote cwd or template for --executor coder", "/home/dev/projects/{project}")
  .option("--executor-worktree-cwd <path>", "remote run worktree cwd template for --executor coder")
  .option("--executor-template <name>", "Coder template to create missing tenant workspaces")
  .option("--executor-template-param <name=value>", "Coder template parameter for missing workspace creation; repeatable", collect, [] as string[])
  .option("--executor-ide-url <url>", "browser IDE URL template for --executor coder")
  .option("--executor-preview-url <url>", "browser preview URL template for apps running in --executor coder")
  .option("--base-branch <name>", "default base git branch used when HTTP body.branch creates a branch", "origin/main")
  .option("--public-url <url>", "public harness server URL used in run metadata links")
  .option("--operator-bundle-dir <path>", "operator cockpit bundle directory; defaults to <workspace-root>/cutover-bundle")
  .option("--state-backend <backend>", "durable state backend: file|postgres-redis", "file")
  .option("--state-postgres-url-env <name>", "env var containing the PostgreSQL connection URL", "LOOM_POSTGRES_URL")
  .option("--state-postgres-schema <name>", "PostgreSQL schema for Loom state", "loom")
  .option("--state-redis-url-env <name>", "env var containing the Redis connection URL", "LOOM_REDIS_URL")
  .option("--state-redis-prefix <prefix>", "Redis key prefix for Loom coordination", "loom")
  .option("--state-probe-interval-ms <ms>", "state dependency probe interval in milliseconds", "5000")
  .option("--state-probe-timeout-ms <ms>", "state dependency probe timeout in milliseconds", "2000")
  .option("--state-probe-max-staleness-ms <ms>", "maximum state dependency probe age in milliseconds", "15000")
  .option("--control-plane-provider <provider>", CONTROL_PLANE_PROVIDER_HELP, "gitea-forgejo")
  .option("--control-plane-pr", "enable control-plane PR creation for HTTP body.pullRequest", false)
  .option("--control-plane-merge", "enable control-plane merge for approved review requests with merge=true", false)
  .option("--control-plane-comment", "post final run summaries with body.issue to control-plane comments", false)
  .option("--control-plane-comment-sync", "allow linked control-plane issue comments to sync into run logs", false)
  .option("--control-plane-webhook-secret-env <name>", "env var containing the control-plane webhook secret for issue-comment webhooks")
  .option("--control-plane-url <url>", "control-plane base URL; agent-git-service also reads LOOM_AGENT_GIT_SERVICE_URL")
  .option("--control-plane-token-env <name>", "env var containing the control-plane token; agent-git-service defaults to LOOM_AGENT_GIT_SERVICE_TOKEN")
  .option("--tenant-control-plane-token-env <tenant=env>", "tenant control-plane token env var; repeatable", collect, [] as string[])
  .option("--agent-git-service-token-secret-root <path>", "directory for provisioned agent-git-service project agent tokens")
  .option("--gitea-pr", "enable Gitea/Forgejo PR creation for HTTP body.pullRequest", false)
  .option("--gitea-merge", "enable Gitea/Forgejo merge for approved review requests with merge=true", false)
  .option("--gitea-comment", "post final run summaries with body.issue to Gitea/Forgejo comments", false)
  .option("--gitea-comment-sync", "allow linked Gitea/Forgejo issue comments to sync into run logs", false)
  .option("--gitea-webhook-secret-env <name>", "env var containing the Gitea/Forgejo webhook secret for issue-comment webhooks")
  .option("--gitea-url <url>", "Gitea/Forgejo base URL", cfg.giteaUrl)
  .option("--gitea-token-env <name>", "env var containing the Gitea/Forgejo token", DEFAULT_GITEA_TOKEN_ENV)
  .option("--tenant-gitea-token-env <tenant=env>", "tenant Gitea/Forgejo token env var; repeatable", collect, [] as string[])
  .option("--ingest-brain", "append completed HTTP run outcomes to the git-backed brain", false)
  .option("--allow-shell", "allow shell.exec actions over HTTP", false)
  .option("--allow-unsafe-local-executor", "allow non-isolated local executor for single-user HTTP development only", false)
  .option("--allow-tool <name>", "allowed HTTP tool; repeatable", collect, [] as string[])
  .option("--tenant-token <tenant=token>", "tenant API token; repeatable", collect, [] as string[])
  .option("--tenant-key <tenant=token:actor:role>", "tenant API key with actor and role; role is admin|developer|viewer; repeatable", collect, [] as string[])
  .option("--tenant-key-env <tenant=env:actor:role>", "tenant API key env var with actor and role; role is admin|developer|viewer; repeatable", collect, [] as string[])
  .option("--oidc-issuer <url>", "OIDC issuer URL for tenant SSO")
  .option("--oidc-audience <audience>", "required OIDC token audience")
  .option("--oidc-jwks-url <url>", "OIDC JWKS URL; defaults to issuer discovery")
  .option("--oidc-tenant-claim <name>", "OIDC claim containing tenant membership", "loom_tenant")
  .option("--oidc-actor-claim <name>", "OIDC claim containing the audit actor", "preferred_username")
  .option("--oidc-role-claim <name>", "OIDC claim containing admin|developer|viewer", "loom_role")
  .option("--oidc-clock-tolerance-seconds <seconds>", "OIDC token clock tolerance", "30")
  .option("--oidc-request-timeout-ms <ms>", "OIDC discovery and JWKS timeout", "3000")
  .option("--oidc-allow-insecure-http", "allow HTTP OIDC endpoints for local development only", false)
  .option("--tenant-model-key <tenant=env>", "tenant model API key env var; repeatable", collect, [] as string[])
  .option("--workspace-command-timeout-ms <ms>", "maximum one-shot workspace command timeout in milliseconds", "120000")
  .option("--max-workspace-sessions <count>", "maximum active workspace terminal sessions", "32")
  .option("--max-tenant-workspace-sessions <count>", "maximum active workspace terminal sessions per tenant")
  .option("--max-tenant-active-runs <count>", "maximum active harness runs per tenant")
  .option("--workspace-session-idle-timeout-ms <ms>", "workspace terminal idle timeout in milliseconds", "1800000")
  .option("--run-lease-ttl-ms <ms>", "running harness run lease TTL in milliseconds", "120000")
  .option("--auto-abandon-stale-runs", "auto-abandon lease-expired orphaned running runs on startup", false)
  .action((opts: HarnessServeCliOptions) => {
    const result = runHarnessDoctor(opts);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  });
harness
  .command("serve")
  .description("serve the harness HTTP control plane for online sandbox runs")
  .option("--workspace-root <path>", "tenant workspace root", process.cwd())
  .option("--host <host>", "listen host", "127.0.0.1")
  .option("--port <port>", "listen port", "8787")
  .option("--profile <profile>", "named serve profile: online-sandbox|platform-readiness")
  .option("--model-base-url <url>", "OpenAI-compatible base URL", cfg.gatewayUrl)
  .option("--model-key-env <name>", "env var containing the model API key", cfg.gatewayKeyEnv)
  .option("--default-model <name>", "default OpenAI-compatible model", cfg.models.default)
  .option("--model-protocol <protocol>", "default model agent protocol: json|tool-call", "json")
  .option("--executor <kind>", "workspace executor: local|docker|coder", "local")
  .option("--executor-image <image>", "Docker image when --executor docker is used")
  .option("--executor-network <mode>", "Docker network mode for --executor docker")
  .option("--executor-cpus <count>", "Docker CPU limit, or Coder cpus template parameter")
  .option("--executor-memory <size>", "Docker memory limit, or Coder memory_gb template parameter")
  .option("--executor-pids-limit <count>", "Docker pids limit, or Coder pids_limit template parameter")
  .option("--executor-home-root <path>", "persistent Docker home root; mounts <path>/<tenant> at /home/dev")
  .option("--executor-workspace <name>", "Coder workspace name or template when --executor coder is used")
  .option("--executor-remote-cwd <path>", "remote cwd or template for --executor coder", "/home/dev/projects/{project}")
  .option("--executor-worktree-cwd <path>", "remote run worktree cwd template for --executor coder")
  .option("--executor-template <name>", "Coder template to create missing tenant workspaces")
  .option("--executor-template-param <name=value>", "Coder template parameter for missing workspace creation; repeatable", collect, [] as string[])
  .option("--executor-ide-url <url>", "browser IDE URL template for --executor coder")
  .option("--executor-preview-url <url>", "browser preview URL template for apps running in --executor coder")
  .option("--base-branch <name>", "default base git branch used when HTTP body.branch creates a branch", "origin/main")
  .option("--public-url <url>", "public harness server URL used in run metadata links")
  .option("--operator-bundle-dir <path>", "operator cockpit bundle directory; defaults to <workspace-root>/cutover-bundle")
  .option("--state-backend <backend>", "durable state backend: file|postgres-redis", "file")
  .option("--state-postgres-url-env <name>", "env var containing the PostgreSQL connection URL", "LOOM_POSTGRES_URL")
  .option("--state-postgres-schema <name>", "PostgreSQL schema for Loom state", "loom")
  .option("--state-redis-url-env <name>", "env var containing the Redis connection URL", "LOOM_REDIS_URL")
  .option("--state-redis-prefix <prefix>", "Redis key prefix for Loom coordination", "loom")
  .option("--state-probe-interval-ms <ms>", "state dependency probe interval in milliseconds", "5000")
  .option("--state-probe-timeout-ms <ms>", "state dependency probe timeout in milliseconds", "2000")
  .option("--state-probe-max-staleness-ms <ms>", "maximum state dependency probe age in milliseconds", "15000")
  .option("--control-plane-provider <provider>", CONTROL_PLANE_PROVIDER_HELP, "gitea-forgejo")
  .option("--control-plane-pr", "enable control-plane PR creation for HTTP body.pullRequest", false)
  .option("--control-plane-merge", "enable control-plane merge for approved review requests with merge=true", false)
  .option("--control-plane-comment", "post final run summaries with body.issue to control-plane comments", false)
  .option("--control-plane-comment-sync", "allow linked control-plane issue comments to sync into run logs", false)
  .option("--control-plane-webhook-secret-env <name>", "env var containing the control-plane webhook secret for issue-comment webhooks")
  .option("--control-plane-url <url>", "control-plane base URL; agent-git-service also reads LOOM_AGENT_GIT_SERVICE_URL")
  .option("--control-plane-token-env <name>", "env var containing the control-plane token; agent-git-service defaults to LOOM_AGENT_GIT_SERVICE_TOKEN")
  .option("--tenant-control-plane-token-env <tenant=env>", "tenant control-plane token env var; repeatable", collect, [] as string[])
  .option("--agent-git-service-token-secret-root <path>", "directory for provisioned agent-git-service project agent tokens")
  .option("--gitea-pr", "enable Gitea/Forgejo PR creation for HTTP body.pullRequest", false)
  .option("--gitea-merge", "enable Gitea/Forgejo merge for approved review requests with merge=true", false)
  .option("--gitea-comment", "post final run summaries with body.issue to Gitea/Forgejo comments", false)
  .option("--gitea-comment-sync", "allow linked Gitea/Forgejo issue comments to sync into run logs", false)
  .option("--gitea-webhook-secret-env <name>", "env var containing the Gitea/Forgejo webhook secret for issue-comment webhooks")
  .option("--gitea-url <url>", "Gitea/Forgejo base URL", cfg.giteaUrl)
  .option("--gitea-token-env <name>", "env var containing the Gitea/Forgejo token", DEFAULT_GITEA_TOKEN_ENV)
  .option("--tenant-gitea-token-env <tenant=env>", "tenant Gitea/Forgejo token env var; repeatable", collect, [] as string[])
  .option("--ingest-brain", "append completed HTTP run outcomes to the git-backed brain", false)
  .option("--allow-shell", "allow shell.exec actions over HTTP", false)
  .option("--allow-unsafe-local-executor", "allow non-isolated local executor for single-user HTTP development only", false)
  .option("--allow-tool <name>", "allowed HTTP tool; repeatable", collect, [] as string[])
  .option("--tenant-token <tenant=token>", "tenant API token; repeatable", collect, [] as string[])
  .option("--tenant-key <tenant=token:actor:role>", "tenant API key with actor and role; role is admin|developer|viewer; repeatable", collect, [] as string[])
  .option("--tenant-key-env <tenant=env:actor:role>", "tenant API key env var with actor and role; role is admin|developer|viewer; repeatable", collect, [] as string[])
  .option("--oidc-issuer <url>", "OIDC issuer URL for tenant SSO")
  .option("--oidc-audience <audience>", "required OIDC token audience")
  .option("--oidc-jwks-url <url>", "OIDC JWKS URL; defaults to issuer discovery")
  .option("--oidc-tenant-claim <name>", "OIDC claim containing tenant membership", "loom_tenant")
  .option("--oidc-actor-claim <name>", "OIDC claim containing the audit actor", "preferred_username")
  .option("--oidc-role-claim <name>", "OIDC claim containing admin|developer|viewer", "loom_role")
  .option("--oidc-clock-tolerance-seconds <seconds>", "OIDC token clock tolerance", "30")
  .option("--oidc-request-timeout-ms <ms>", "OIDC discovery and JWKS timeout", "3000")
  .option("--oidc-allow-insecure-http", "allow HTTP OIDC endpoints for local development only", false)
  .option("--tenant-model-key <tenant=env>", "tenant model API key env var; repeatable", collect, [] as string[])
  .option("--workspace-command-timeout-ms <ms>", "maximum one-shot workspace command timeout in milliseconds", "120000")
  .option("--max-workspace-sessions <count>", "maximum active workspace terminal sessions", "32")
  .option("--max-tenant-workspace-sessions <count>", "maximum active workspace terminal sessions per tenant")
  .option("--max-tenant-active-runs <count>", "maximum active harness runs per tenant")
  .option("--workspace-session-idle-timeout-ms <ms>", "workspace terminal idle timeout in milliseconds", "1800000")
  .option("--run-lease-ttl-ms <ms>", "running harness run lease TTL in milliseconds", "120000")
  .option("--auto-abandon-stale-runs", "auto-abandon lease-expired orphaned running runs on startup", false)
  .option("--rate-limit-rps <count>", "sustained HTTP requests per second per client IP; 0 disables", "200")
  .option("--rate-limit-burst <count>", "HTTP request burst per client IP", "500")
  .option("--rate-limit-trusted-proxy-hops <count>", "trusted reverse-proxy hops; when >0, rate-limit by the client's X-Forwarded-For hop instead of the socket peer", "0")
  .action(async (opts: HarnessServeCliOptions) => {
    requireServeFlagValidation(opts);
    const port = Number(opts.port);
    const workspaceCommandTimeoutMs = parsePositiveIntFlag(opts.workspaceCommandTimeoutMs, "--workspace-command-timeout-ms");
    const maxWorkspaceSessions = parsePositiveIntFlag(opts.maxWorkspaceSessions, "--max-workspace-sessions");
    const maxTenantWorkspaceSessions = opts.maxTenantWorkspaceSessions === undefined
      ? maxWorkspaceSessions
      : parsePositiveIntFlag(opts.maxTenantWorkspaceSessions, "--max-tenant-workspace-sessions");
    const maxTenantActiveRuns = opts.maxTenantActiveRuns === undefined
      ? undefined
      : parsePositiveIntFlag(opts.maxTenantActiveRuns, "--max-tenant-active-runs");
    const workspaceSessionIdleTimeoutMs = parsePositiveIntFlag(opts.workspaceSessionIdleTimeoutMs, "--workspace-session-idle-timeout-ms");
    const runLeaseTtlMs = parsePositiveIntFlag(opts.runLeaseTtlMs, "--run-lease-ttl-ms");
    const rateLimitRps = opts.rateLimitRps === "0" ? 0 : parsePositiveIntFlag(opts.rateLimitRps ?? "200", "--rate-limit-rps");
    const rateLimitBurst = parsePositiveIntFlag(opts.rateLimitBurst ?? "500", "--rate-limit-burst");
    const rateLimitTrustedProxyHops = opts.rateLimitTrustedProxyHops === undefined || opts.rateLimitTrustedProxyHops === "0"
      ? 0
      : parsePositiveIntFlag(opts.rateLimitTrustedProxyHops, "--rate-limit-trusted-proxy-hops");
    const stateDependencyProbeIntervalMs = parsePositiveIntFlag(opts.stateProbeIntervalMs ?? "5000", "--state-probe-interval-ms");
    const stateDependencyProbeTimeoutMs = parsePositiveIntFlag(opts.stateProbeTimeoutMs ?? "2000", "--state-probe-timeout-ms");
    const stateDependencyProbeMaxStalenessMs = parsePositiveIntFlag(opts.stateProbeMaxStalenessMs ?? "15000", "--state-probe-max-staleness-ms");
    const modelProtocol = parseModelProtocolFlag(opts.modelProtocol, "--model-protocol");
    const controlPlaneProvider = parseControlPlaneProviderFlag(opts.controlPlaneProvider, "--control-plane-provider");
    const serveOptions = serveOptionsWithProfile(opts);
    const allowedTools = allowedHttpTools(serveOptions.allowTool, serveOptions.allowShell);
    const executorHomeRoot = executorHomeRootFromOptions(serveOptions);
    const operatorBundleDir = operatorBundleDirFromServeOptions(serveOptions);
    requireSafeServeExecutor(serveOptions);
    const stateBackend = await createStateBackendFromCliOptions(serveOptions);

    try {
      const createExecutor = executorFactoryFromOptions(serveOptions);
      const issueReporterOptions = {
        ...serveOptions,
        controlPlaneProvider,
        tenantGiteaTokenEnvs: parseTenantGiteaTokenEnvs(serveOptions.tenantGiteaTokenEnv ?? []),
      };
      const server = createHarnessHttpServer({
      workspaceRoot: serveOptions.workspaceRoot,
      profile: serveOptions.profile,
      controlPlaneProvider,
      operatorBundleDir,
      executorKind: serveOptions.executor,
      executorHomeRoot,
      modelBaseUrl: serveOptions.modelBaseUrl,
      modelApiKey: process.env[serveOptions.modelKeyEnv],
      modelProtocol,
      defaultModel: serveOptions.defaultModel,
      allowedTools,
      tenantTokens: parseTenantTokens(serveOptions.tenantToken ?? []),
      tenantApiKeys: parseTenantApiKeysFromServeOptions(serveOptions),
      oidcAuth: oidcAuthFromServeOptions(serveOptions),
      controlPlaneAgentIdentity: controlPlaneAgentIdentityFromGiteaTokens(issueReporterOptions),
      tenantModelKeyEnvs: parseTenantModelKeyEnvs(serveOptions.tenantModelKey ?? []),
      createExecutor,
      runWorkspaceIsolation: serveOptions.executor === "coder" && serveOptions.executorWorktreeCwd ? "run" : "project",
      allowUnsafeLocalExecutor: serveOptions.allowUnsafeLocalExecutor,
      issueReporter: maybeIssueReporter(issueReporterOptions),
      issueCommentReader: maybeIssueCommentReader(issueReporterOptions),
      giteaWebhookSecret: maybeGiteaWebhookSecret(serveOptions.giteaWebhookSecretEnv),
      controlPlaneBaseUrl: issueReporterOptions.giteaUrl,
      controlPlaneAdminToken: process.env[issueReporterOptions.giteaTokenEnv],
      controlPlaneTenantTokens: controlPlaneTenantTokensFromEnv(issueReporterOptions.tenantGiteaTokenEnvs),
      agentGitServiceTokenSecretRoot: serveOptions.agentGitServiceTokenSecretRoot,
      pullRequestReporter: maybePullRequestReporter(issueReporterOptions),
      workspacePullRequestReporter: maybeWorkspacePullRequestReporter(issueReporterOptions),
      mergeReporter: maybeMergeReporter(issueReporterOptions),
      brainIngest: serveOptions.ingestBrain
        ? (summary: RunSummary) => ingest(cfg, runSignalFromSummary(summary, summary.metadata?.project ?? "unknown"))
        : undefined,
      brainSignalIngest: serveOptions.ingestBrain
        ? (signal: RunSignal) => ingest(cfg, signal)
        : undefined,
      publicUrl: serveOptions.publicUrl,
      issueBaseUrl: serveOptions.giteaUrl,
      workspaceCommandTimeoutMs,
      maxWorkspaceSessions,
      maxTenantWorkspaceSessions,
      maxTenantActiveRuns,
      workspaceSessionIdleTimeoutMs,
      runLeaseTtlMs,
      rateLimitRps,
      rateLimitBurst,
      rateLimitTrustedProxyHops,
      autoAbandonStaleRuns: serveOptions.autoAbandonStaleRuns,
      stateBackend,
      stateDependencyProbeIntervalMs,
      stateDependencyProbeTimeoutMs,
      stateDependencyProbeMaxStalenessMs,
      });
      server.once("close", () => {
        void stateBackend?.close().catch(() => undefined);
      });
      await new Promise<void>((resolve) => server.listen(port, serveOptions.host, resolve));

      // Graceful shutdown: on SIGTERM/SIGINT (docker stop, k8s eviction, Ctrl-C)
      // stop accepting connections and let in-flight requests finish, then the
      // server's close handler aborts active runs, releases workspace sessions
      // and admission claims, and shuts the state backend down cleanly instead
      // of the process being hard-killed mid-run.
      let shuttingDown = false;
      const gracefulShutdown = (signal: NodeJS.Signals) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.error(`loom harness: received ${signal}, draining and shutting down`);
        server.closeIdleConnections?.();
        server.close(() => process.exit(0));
        // Backstops: force-drop lingering connections, then hard-exit, so a stuck
        // connection or run cannot block shutdown forever.
        setTimeout(() => server.closeAllConnections?.(), 10_000).unref();
        setTimeout(() => process.exit(0), 20_000).unref();
      };
      process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
      process.once("SIGINT", () => gracefulShutdown("SIGINT"));

      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      console.log(
      JSON.stringify(
        {
          url: `http://${serveOptions.host}:${actualPort}`,
          workspaceRoot: serveOptions.workspaceRoot,
          operatorBundleDir,
          profile: serveOptions.profile,
          controlPlaneProvider,
          allowedTools,
          endpoints: [
            "POST /runs",
            "GET /healthz",
            "GET /readyz",
            "GET /metrics",
            "GET /status",
            "GET /workbench",
            "GET /tenants/:tenant/access",
            "GET /tenants/:tenant/status",
            "GET /tenants/:tenant/brain/signals",
            "POST /tenants/:tenant/brain/signals",
            "GET /tenants/:tenant/policy",
            "PUT /tenants/:tenant/policy",
            "POST /tenants/:tenant/policy/settings",
            "POST /tenants/:tenant/policy/api-keys",
            "POST /tenants/:tenant/policy/api-keys/revoke",
            "GET /tenants/:tenant/policy/escalations",
            "POST /tenants/:tenant/policy/escalations",
            "POST /tenants/:tenant/policy/escalations/:escalationId/decision",
            "GET /tenants/:tenant/audit",
            "GET /tenants/:tenant/audit/stream",
            "GET /tenants/:tenant/model-usage/warnings",
            "GET /tenants/:tenant/workspace-usage/warnings",
            "GET /tenants/:tenant/projects",
            "POST /tenants/:tenant/projects",
            "GET /tenants/:tenant/projects/:project",
            "POST /tenants/:tenant/projects/:project/control-plane/agent-git-service/provision",
            "PUT /tenants/:tenant/projects/:project/source-defaults",
            "PUT /tenants/:tenant/projects/:project/default-skills",
            "PUT /tenants/:tenant/projects/:project/run-policy",
            "PUT /tenants/:tenant/projects/:project/contract",
            "GET /tenants/:tenant/projects/:project/workspace",
            "GET /tenants/:tenant/projects/:project/diff",
            "GET /tenants/:tenant/projects/:project/files",
            "POST /tenants/:tenant/projects/:project/files",
            "POST /tenants/:tenant/projects/:project/files/move",
            "DELETE /tenants/:tenant/projects/:project/files",
            "POST /tenants/:tenant/projects/:project/commits",
            "POST /tenants/:tenant/projects/:project/pull-requests",
            "POST /tenants/:tenant/projects/:project/commands",
            "GET /tenants/:tenant/projects/:project/commands",
            "POST /tenants/:tenant/projects/:project/sessions",
            "GET /tenants/:tenant/projects/:project/sessions",
            "GET /tenants/:tenant/projects/:project/sessions/:sessionId/events",
            "GET /tenants/:tenant/projects/:project/sessions/:sessionId/events/stream",
            "POST /tenants/:tenant/projects/:project/sessions/:sessionId/input",
            "POST /tenants/:tenant/projects/:project/sessions/:sessionId/stop",
            "GET /tenants/:tenant/projects/:project/presence",
            "POST /tenants/:tenant/projects/:project/presence",
            "GET /tenants/:tenant/projects/:project/vas/review-queue",
            "GET /tenants/:tenant/projects/:project/vas/learnings",
            "GET /tenants/:tenant/projects/:project/vas/cases",
            "POST /tenants/:tenant/projects/:project/vas/cases",
            "GET /tenants/:tenant/projects/:project/vas/cases/:caseId/artifacts",
            "GET /tenants/:tenant/projects/:project/vas/cases/:caseId/review-package",
            "GET /tenants/:tenant/projects/:project/vas/cases/:caseId/review-runs",
            "POST /tenants/:tenant/projects/:project/vas/cases/:caseId/review-runs",
            "POST /tenants/:tenant/projects/:project/vas/cases/:caseId/claim",
            "POST /tenants/:tenant/projects/:project/vas/cases/:caseId/review",
            "GET /tenants/:tenant/runs",
            "GET /tenants/:tenant/runs/:runId",
            "GET /tenants/:tenant/runs/:runId/workspace",
            "GET /tenants/:tenant/runs/:runId/diff",
            "GET /tenants/:tenant/runs/:runId/files",
            "POST /tenants/:tenant/runs/:runId/files",
            "POST /tenants/:tenant/runs/:runId/files/move",
            "DELETE /tenants/:tenant/runs/:runId/files",
            "POST /tenants/:tenant/runs/:runId/commits",
            "POST /tenants/:tenant/runs/:runId/pull-requests",
            "POST /tenants/:tenant/runs/:runId/commands",
            "GET /tenants/:tenant/runs/:runId/commands",
            "POST /tenants/:tenant/runs/:runId/sessions",
            "GET /tenants/:tenant/runs/:runId/sessions",
            "GET /tenants/:tenant/runs/:runId/sessions/:sessionId/events",
            "GET /tenants/:tenant/runs/:runId/sessions/:sessionId/events/stream",
            "POST /tenants/:tenant/runs/:runId/sessions/:sessionId/input",
            "POST /tenants/:tenant/runs/:runId/sessions/:sessionId/stop",
            "GET /tenants/:tenant/runs/:runId/events",
            "GET /tenants/:tenant/runs/:runId/events/stream",
            "GET /tenants/:tenant/runs/:runId/replay",
            "GET /tenants/:tenant/runs/:runId/review-summary",
            "GET /tenants/:tenant/runs/:runId/handoff-package",
            "GET /tenants/:tenant/runs/:runId/handoff-runs",
            "POST /tenants/:tenant/runs/:runId/handoff-runs",
            "GET /tenants/:tenant/runs/:runId/presence",
            "POST /tenants/:tenant/runs/:runId/presence",
            "POST /tenants/:tenant/runs/:runId/comments",
            "POST /tenants/:tenant/runs/:runId/issue-comments/sync",
            "POST /tenants/:tenant/webhooks/gitea/issue-comments",
            "POST /tenants/:tenant/webhooks/control-plane/issue-comments",
            "POST /tenants/:tenant/runs/:runId/cancel",
            "POST /tenants/:tenant/runs/:runId/resume",
            "POST /tenants/:tenant/runs/:runId/review-claim",
            "POST /tenants/:tenant/runs/:runId/review",
            "POST /tenants/:tenant/runs/:runId/deployment",
            "POST /tenants/:tenant/runs/:runId/abandon",
            "POST /tenants/:tenant/runs/:runId/abandon-stale",
          ],
        },
        null,
        2,
      ),
      );
    } catch (error) {
      await stateBackend?.close().catch(() => undefined);
      throw error;
    }
  });
}

export const CONTROL_PLANE_GIT_TRANSPORT_SAMPLE_REPO = "team/smoke";

export interface HarnessRehearsalCliOptions {
  workspaceRoot?: string;
  host: string;
  tenant: string;
  isolationTenant: string;
  project: string;
  controlPlaneProvider: string;
  peerServer?: boolean;
}

export interface HarnessRehearsalResult {
  ok: true;
  profile: "platform-readiness";
  controlPlaneProvider: ControlPlaneProviderName;
  workspaceRoot: string;
  url: string;
  peerUrl?: string;
  tenant: string;
  isolationTenant: string;
  project: string;
  modelCalls: number;
  pullRequestCount: number;
  workspacePullRequestCount: number;
  brainRunIngestCount: number;
  brainSignalCount: number;
  agentGitServiceChecked?: boolean;
  agentGitServiceWorkspaceAttachmentCount?: number;
  agentGitServiceWikiMemoryUpdateCount?: number;
  cutoverReport: HarnessCutoverReport;
  smoke: HarnessSmokeResult;
}

export type HarnessServeProfileName = HarnessOnlineProfileName;

export type ResolvedHarnessServeCliOptions = Omit<HarnessServeCliOptions, "profile"> & { profile?: HarnessServeProfileName };

export interface HarnessDoctorResult {
  ok: boolean;
  profile?: HarnessServeProfileName;
  visionLock: typeof HARNESS_VISION_LOCK;
  controlPlane: HarnessDoctorControlPlane;
  goldenPath: HarnessDoctorGoldenPath;
  missing: string[];
  checks: Record<string, HarnessDoctorCheck>;
  recommendedFlags: string[];
}

export interface HarnessDoctorControlPlane {
  provider: ControlPlaneProviderName;
  boundary: string[];
  apiBasePath?: string;
  discoveryEndpoints: string[];
  nativeCapabilities: string[];
  adoptionStages: ControlPlaneProviderAdoptionStage[];
}

export interface HarnessDoctorGoldenPath {
  required: boolean;
  ok: boolean;
  capabilities: string[];
  missingCapabilities: string[];
}

export interface HarnessDoctorCheck {
  required: boolean;
  ok: boolean;
  [key: string]: unknown;
}

export interface RunCreateIdempotencyStatus {
  clientRequestId: true;
  sharedRunStore: true;
  crossServerReplay: true;
  simultaneousCreateReplay: true;
  conflictOnRequestMismatch: true;
}

export function serveOptionsWithProfile(options: HarnessServeCliOptions): ResolvedHarnessServeCliOptions {
  const normalized = controlPlaneServeOptions(options);
  const profile = parseServeProfileFlag(normalized.profile);
  if (!profile) return { ...normalized, profile };
  return { ...normalized, profile, allowShell: true };
}

export function controlPlaneServeOptions(options: HarnessServeCliOptions): HarnessServeCliOptions {
  const provider = parseControlPlaneProviderFlag(options.controlPlaneProvider, "--control-plane-provider");
  return {
    ...options,
    giteaPr: options.giteaPr || options.controlPlanePr === true,
    giteaMerge: options.giteaMerge || options.controlPlaneMerge === true,
    giteaComment: options.giteaComment || options.controlPlaneComment === true,
    giteaCommentSync: options.giteaCommentSync || options.controlPlaneCommentSync === true,
    giteaWebhookSecretEnv: options.controlPlaneWebhookSecretEnv ?? options.giteaWebhookSecretEnv,
    giteaUrl: controlPlaneBaseUrl(options, provider),
    giteaTokenEnv: controlPlaneTokenEnv(options, provider),
    tenantGiteaTokenEnv: [
      ...(options.tenantGiteaTokenEnv ?? []),
      ...(options.tenantControlPlaneTokenEnv ?? []),
    ],
  };
}

export const REHEARSAL_WEBHOOK_SECRET_ENV = "LOOM_REHEARSAL_WEBHOOK_SECRET";

export const REHEARSAL_MODEL_KEY_ENV = "LOOM_REHEARSAL_MODEL_KEY";

export const REHEARSAL_ADMIN_TOKEN_ENV = "LOOM_REHEARSAL_ADMIN_TOKEN";

export const REHEARSAL_DEV_TOKEN_ENV = "LOOM_REHEARSAL_DEV_TOKEN";

export const REHEARSAL_VIEWER_TOKEN_ENV = "LOOM_REHEARSAL_VIEWER_TOKEN";

export const REHEARSAL_ISOLATION_TOKEN_ENV = "LOOM_REHEARSAL_ISOLATION_TOKEN";

export const REHEARSAL_AGENT_GIT_SERVICE_ADMIN_TOKEN_ENV = "LOOM_REHEARSAL_AGENT_GIT_SERVICE_ADMIN_TOKEN";

export const REHEARSAL_WEBHOOK_SECRET = "rehearsal-webhook-secret";

export const REHEARSAL_ADMIN_TOKEN = "rehearsal-admin-token";

export const REHEARSAL_DEV_TOKEN = "rehearsal-dev-token";

export const REHEARSAL_VIEWER_TOKEN = "rehearsal-viewer-token";

export const REHEARSAL_ISOLATION_TOKEN = "rehearsal-isolation-token";

export const REHEARSAL_AGENT_GIT_SERVICE_ADMIN_TOKEN = "rehearsal-ags-admin-token";

export async function runHarnessRehearsal(options: HarnessRehearsalCliOptions): Promise<HarnessRehearsalResult> {
  const tenant = parseSafeNameFlag(options.tenant, "--tenant");
  const isolationTenant = parseSafeNameFlag(options.isolationTenant, "--isolation-tenant");
  const project = parseSafeNameFlag(options.project, "--project");
  const controlPlaneProvider = parseControlPlaneProviderFlag(options.controlPlaneProvider, "--control-plane-provider");
  if (tenant === isolationTenant) throw new Error("--isolation-tenant must be different from --tenant");
  const workspaceRoot = options.workspaceRoot
    ? resolve(options.workspaceRoot)
    : await mkdtemp(join(tmpdir(), "loom-rehearsal-"));
  const agentGitServiceTokenSecretRoot = controlPlaneProvider === "agent-git-service"
    ? await mkdtemp(join(tmpdir(), "loom-rehearsal-ags-secrets-"))
    : undefined;

  const modelServer = createRehearsalModelServer();
  const modelAddress = await listenEphemeralServer(modelServer.server, options.host);
  const agentGitService = controlPlaneProvider === "agent-git-service"
    ? await startAgentGitServiceContractServer({
      host: options.host,
      workspace: {
        id: "ws-rehearsal",
        agentLogin: "loom-agent-1",
        status: "active",
      },
      wikiMemory: {
        page: "vas/learnings",
        body: "Existing AGS rehearsal memory\n",
        sha: "abc123",
      },
    })
    : undefined;
  const agentGitServiceApiBaseUrl = agentGitService?.baseUrl;
  let harnessServer: Server | undefined;
  let peerHarnessServer: Server | undefined;
  const fakeCoderBinDir = await mkdtemp(join(tmpdir(), "loom-rehearsal-bin-"));
  await writeRehearsalCoderBinary(fakeCoderBinDir);
  const previousEnv = setTemporaryEnv({
    [REHEARSAL_WEBHOOK_SECRET_ENV]: REHEARSAL_WEBHOOK_SECRET,
    [REHEARSAL_MODEL_KEY_ENV]: "rehearsal-model-key",
    [REHEARSAL_ADMIN_TOKEN_ENV]: REHEARSAL_ADMIN_TOKEN,
    [REHEARSAL_DEV_TOKEN_ENV]: REHEARSAL_DEV_TOKEN,
    [REHEARSAL_VIEWER_TOKEN_ENV]: REHEARSAL_VIEWER_TOKEN,
    [REHEARSAL_ISOLATION_TOKEN_ENV]: REHEARSAL_ISOLATION_TOKEN,
    [REHEARSAL_AGENT_GIT_SERVICE_ADMIN_TOKEN_ENV]: REHEARSAL_AGENT_GIT_SERVICE_ADMIN_TOKEN,
    PATH: `${fakeCoderBinDir}:${process.env.PATH ?? ""}`,
  });

  try {
    const pullRequests: Array<{ index?: number; url?: string }> = [];
    const workspacePullRequests: Array<{ runId?: string; branch?: string; index?: number; url?: string }> = [];
    const brainRuns: RunSummary[] = [];
    const brainSignals: RunSignal[] = [];
    const createRehearsalServer = () => createHarnessHttpServer({
      workspaceRoot,
      profile: "platform-readiness",
      controlPlaneProvider,
      controlPlaneBaseUrl: agentGitServiceApiBaseUrl,
      controlPlaneAdminToken: agentGitService ? REHEARSAL_AGENT_GIT_SERVICE_ADMIN_TOKEN : undefined,
      agentGitServiceTokenSecretRoot,
      agentGitServiceCreateAgent: agentGitService
        ? async () => ({
          login: "loom-agent-1",
          token: "project-agent-token",
          repoFullName: "agents/loom-agent-1",
        })
        : undefined,
      agentGitServiceGrantRepoAccess: agentGitService
        ? async (grant) => ({
          repo: grant.repo,
          agentLogin: grant.agentLogin,
          permission: grant.permission,
          status: "granted",
        })
        : undefined,
      executorKind: "coder",
      runWorkspaceIsolation: "run",
      allowedTools: [...ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS, "git.pr"],
      modelBaseUrl: modelAddress.url,
      modelApiKey: "rehearsal-model-key",
      defaultModel: "rehearsal-model",
      publicUrl: "https://loom.rehearsal.local",
      issueBaseUrl: agentGitServiceApiBaseUrl ?? "https://git.example",
      brainIngest: (summary) => {
        brainRuns.push(summary);
      },
      brainSignalIngest: (signal) => {
        brainSignals.push(signal);
      },
      pullRequestReporter: async () => {
        const result = { index: 23, url: "https://git.example/team/smoke/pulls/23" };
        pullRequests.push(result);
        return result;
      },
      workspacePullRequestReporter: async (request) => {
        if (agentGitService) {
          agentGitService.setWorkspace({
            id: "ws-rehearsal",
            agentLogin: "loom-agent-1",
            branch: request.branch,
            status: "active",
          });
        }
        const result = {
          runId: request.runId,
          branch: request.branch,
          index: 24,
          url: "https://git.example/team/smoke/pulls/24",
        };
        workspacePullRequests.push(result);
        return result;
      },
      mergeReporter: async () => undefined,
      giteaWebhookSecret: REHEARSAL_WEBHOOK_SECRET,
      controlPlaneAgentIdentity: {
        mode: "tenant-scoped",
        tenants: [tenant, isolationTenant],
      },
      issueCommentReader: async () => [
        {
          id: "902",
          body: "/loom approve\nApproved from the local platform rehearsal issue comment.",
          author: "eno",
          url: "https://git.example/team/smoke-comments/issues/17#comment-902",
          createdAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      tenantApiKeys: {
        [tenant]: [
          { token: REHEARSAL_ADMIN_TOKEN, actor: "ops", role: "admin" },
          { token: REHEARSAL_DEV_TOKEN, actor: "eno", role: "developer" },
          { token: REHEARSAL_VIEWER_TOKEN, actor: "auditor", role: "viewer" },
        ],
        [isolationTenant]: [
          { token: REHEARSAL_ISOLATION_TOKEN, actor: isolationTenant, role: "developer" },
        ],
      },
      createExecutor: (cwd, context) => rehearsalCoderExecutor(cwd, context),
    });
    harnessServer = createRehearsalServer();
    const harnessAddress = await listenEphemeralServer(harnessServer, options.host);
    peerHarnessServer = options.peerServer ? createRehearsalServer() : undefined;
    const peerHarnessAddress = peerHarnessServer
      ? await listenEphemeralServer(peerHarnessServer, options.host)
      : undefined;
    if (controlPlaneProvider === "agent-git-service") {
      await prepareAgentGitServiceRehearsalProject(harnessAddress.url, tenant, project);
    }
    const cutoverReport = await readHarnessCutoverReportViaHarness({
      url: harnessAddress.url,
      tenant,
      token: REHEARSAL_DEV_TOKEN,
      adminToken: REHEARSAL_ADMIN_TOKEN,
      controlPlaneProvider,
    });
    if (!cutoverReport.ok) {
      throw new Error(`rehearsal cutover report failed: ${cutoverReport.missing.join(", ") || "unknown"}`);
    }
    const smoke = await runHarnessSmoke({
      url: harnessAddress.url,
      peerUrl: peerHarnessAddress?.url,
      tenant,
      project,
      template: "vas-lite",
      token: REHEARSAL_DEV_TOKEN,
      viewerToken: REHEARSAL_VIEWER_TOKEN,
      adminToken: REHEARSAL_ADMIN_TOKEN,
      isolationTenant,
      profile: "platform-readiness",
      controlPlaneProvider,
      controlPlaneWebhookSecretEnv: REHEARSAL_WEBHOOK_SECRET_ENV,
    });
    return {
      ok: true,
      profile: "platform-readiness",
      controlPlaneProvider,
      workspaceRoot,
      url: harnessAddress.url,
      ...(peerHarnessAddress ? { peerUrl: peerHarnessAddress.url } : {}),
      tenant,
      isolationTenant,
      project,
      modelCalls: modelServer.modelCalls(),
      pullRequestCount: pullRequests.length,
      workspacePullRequestCount: workspacePullRequests.length,
      brainRunIngestCount: brainRuns.length,
      brainSignalCount: brainSignals.length,
      ...(agentGitService ? {
        agentGitServiceChecked: true,
        agentGitServiceWorkspaceAttachmentCount: agentGitService.requests.filter((request) =>
          request.method === "POST" &&
          request.path === "/api/v3/repos/team/loom-smoke/issues/17/workspaces/ws-rehearsal/attachments"
        ).length,
        agentGitServiceWikiMemoryUpdateCount: agentGitService.requests.filter((request) =>
          request.method === "PUT" &&
          request.path === "/api/v3/repos/team/loom-smoke/wiki/memory/vas%2Flearnings"
        ).length,
      } : {}),
      cutoverReport,
      smoke,
    };
  } finally {
    restoreTemporaryEnv(previousEnv);
    if (harnessServer) await closeHttpServer(harnessServer);
    if (peerHarnessServer) await closeHttpServer(peerHarnessServer);
    if (agentGitService) await agentGitService.close();
    await closeHttpServer(modelServer.server);
  }
}

export function rehearsalCoderExecutor(cwd: string, context: HarnessWorkspaceContext): WorkspaceExecutor {
  const executor = createLocalExecutor({ cwd });
  return {
    ...executor,
    describeWorkspace() {
      return {
        kind: "coder",
        workspace: `${context.tenant}-${context.project}-${context.runId}`,
        cwd,
        ideUrl: `https://coder.rehearsal.local/${context.tenant}/${context.project}/${context.runId}/ide`,
        previewUrl: `https://coder.rehearsal.local/${context.tenant}/${context.project}/${context.runId}/preview`,
      };
    },
  };
}

export async function writeRehearsalCoderBinary(binDir: string): Promise<void> {
  mkdirSync(binDir, { recursive: true });
  const coderPath = join(binDir, "coder");
  await writeFile(
    coderPath,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'show') process.exit(1);",
      "if (args[0] === 'ssh' && args.some((arg) => String(arg).includes('loom-coder-preflight-ok'))) {",
      "  console.log('loom-coder-preflight-ok');",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(coderPath, 0o755);
}

export function setTemporaryEnv(values: Record<string, string>): Record<string, string | undefined> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return previous;
}

export function restoreTemporaryEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function createRehearsalModelServer(): { server: Server; modelCalls: () => number } {
  let calls = 0;
  let smokeCalls = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const body = await readIncomingMessageBody(req);
    calls += 1;
    const preflight = body.includes("loom model preflight");
    if (!preflight) smokeCalls += 1;
    const step = preflight
      ? { message: "rehearsal model preflight ok", finish: true }
      : smokeCalls === 1
      ? {
        message: "write rehearsal model artifact",
        actions: [
          {
            toolName: "file.write",
            input: { path: "loom-model-smoke.txt", content: "loom model smoke ok\n" },
          },
        ],
      }
      : { message: "finish rehearsal model smoke", finish: true };
    res.writeHead(200, {
      "content-type": "application/json",
      "x-litellm-response-cost": calls === 1 ? "0.001" : "0.0005",
    });
    res.end(JSON.stringify({
      id: `chatcmpl-rehearsal-${calls}`,
      model: "rehearsal-model",
      usage: {
        prompt_tokens: calls === 1 ? 20 : 8,
        completion_tokens: calls === 1 ? 10 : 4,
        total_tokens: calls === 1 ? 30 : 12,
      },
      choices: [{ message: { content: JSON.stringify(step) } }],
    }));
  });
  return { server, modelCalls: () => calls };
}

export async function prepareAgentGitServiceRehearsalProject(url: string, tenant: string, project: string): Promise<void> {
  const headers = { ...smokeHeaders(REHEARSAL_DEV_TOKEN), "content-type": "application/json" };
  await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(smokeProjectCreateBody(project, "vas-lite")),
    },
    [200, 201, 409],
    "POST rehearsal AGS project",
  );
  await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/control-plane/agent-git-service/provision`,
    {
      method: "POST",
      headers: { ...smokeHeaders(REHEARSAL_ADMIN_TOKEN), "content-type": "application/json" },
      body: JSON.stringify({
        repo: "team/loom-smoke",
        tokenEnvName: "LOOM_REHEARSAL_AGS_PROJECT_TOKEN",
        storeAgentToken: true,
        clientId: "loom-rehearsal",
      }),
    },
    [201, 409],
    "POST rehearsal AGS project-agent provision",
  );
}

export async function listenEphemeralServer(server: Server, host: string): Promise<{ url: string; port: number }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("temporary server did not return an address");
  return { url: `http://${host}:${address.port}`, port: address.port };
}

export async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export async function readIncomingMessageBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function operatorBundleDirFromServeOptions(options: Pick<HarnessServeCliOptions, "workspaceRoot" | "operatorBundleDir">): string {
  return resolve(options.operatorBundleDir?.trim() || join(options.workspaceRoot, "cutover-bundle"));
}

export function runHarnessDoctor(options: HarnessServeCliOptions): HarnessDoctorResult {
  const serveOptions = serveOptionsWithProfile(options);
  parseModelProtocolFlag(serveOptions.modelProtocol, "--model-protocol");
  const controlPlaneProvider = parseControlPlaneProviderFlag(serveOptions.controlPlaneProvider, "--control-plane-provider");

  const profile = serveOptions.profile;
  const onlineRequired = profile === "online-sandbox" || profile === "platform-readiness";
  const platformRequired = profile === "platform-readiness";
  const allowedTools = allowedHttpTools(serveOptions.allowTool, serveOptions.allowShell);
  const cliTenantApiKeys = parseTenantApiKeysFromServeOptions(serveOptions);
  const policyTenantApiKeys = readPolicyTenantApiKeysForDoctor(serveOptions.workspaceRoot);
  const tenantApiKeys = mergeTenantApiKeysForDoctor(cliTenantApiKeys, policyTenantApiKeys);
  parseTenantTokens(serveOptions.tenantToken ?? []);
  const cliTenantModelKeyEnvs = parseTenantModelKeyEnvs(serveOptions.tenantModelKey ?? []);
  const policyTenantModelKeyEnvs = readPolicyTenantModelKeyEnvsForDoctor(serveOptions.workspaceRoot);
  const tenantModelKeyEnvs = { ...cliTenantModelKeyEnvs, ...policyTenantModelKeyEnvs };
  const tenantGiteaTokenEnvs = parseTenantGiteaTokenEnvs(serveOptions.tenantGiteaTokenEnv ?? []);
  const giteaTokenReadiness = giteaTokenEnvReadiness(serveOptions.giteaTokenEnv, tenantGiteaTokenEnvs);
  const controlPlaneEnvValidation = controlPlaneEnvValidationDoctorCheck({ ...serveOptions, controlPlaneProvider, tenantGiteaTokenEnvs });
  const policyKeyCount = Object.values(policyTenantApiKeys).reduce((total, keys) => total + keys.length, 0);
  const oidcConfigured = Boolean(serveOptions.oidcIssuer?.trim() && serveOptions.oidcAudience?.trim());
  const tenantAuth = tenantAuthDoctorReadiness(tenantApiKeys, policyKeyCount, oidcConfigured);
  const tenantNames = Object.keys(tenantApiKeys).sort((a, b) => a.localeCompare(b));
  const modelReadiness = modelDoctorReadiness(serveOptions, tenantNames, tenantModelKeyEnvs, tenantApiKeys);
  const missingOnlineSandboxTools = ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS.filter((tool) => !allowedTools.includes(tool));
  const sandboxExecutorOk = serveOptions.executor === "docker" || serveOptions.executor === "coder";
  const persistentHomeOk = serveOptions.executor === "coder" || Boolean(serveOptions.executorHomeRoot?.trim());
  const runWorkspaceIsolationMode = serveOptions.executor === "coder" && serveOptions.executorWorktreeCwd?.trim() ? "run" : "project";
  const runCreateIdempotency = runCreateIdempotencyStatus();
  const coderExecutorOk = serveOptions.executor === "coder" && Boolean(serveOptions.executorWorkspace?.trim());
  const signedWebhookOk = Boolean(serveOptions.giteaWebhookSecretEnv && process.env[serveOptions.giteaWebhookSecretEnv]);
  const tenantScopedAgentIdentityOk = Object.keys(tenantGiteaTokenEnvs).length > 0 && giteaTokenReadiness.ok;
  const gitPrAllowed = allowedTools.includes("git.pr");
  const controlPlaneGitTransportEvidence = controlPlaneGitTransportDoctorEvidence(controlPlaneProvider, serveOptions.giteaUrl);
  const agentGitServiceProjectAgents = agentGitServiceProjectAgentsDoctorReadiness(
    serveOptions.workspaceRoot,
    controlPlaneProvider,
    serveOptions.agentGitServiceTokenSecretRoot,
  );
  const operatorBundleDir = operatorBundleDirFromServeOptions(serveOptions);
  const stateBackend = stateBackendDoctorCheck(serveOptions);
  const localExecutorSafetyReasons = unsafeLocalExecutorReasons(serveOptions, policyKeyCount > 0);
  const checks: Record<string, HarnessDoctorCheck> = {
    serveFlagValidation: serveFlagValidationDoctorCheck(serveOptions),
    operatorCockpitBundle: {
      required: false,
      ok: true,
      bundleDir: operatorBundleDir,
      source: serveOptions.operatorBundleDir?.trim() ? "flag" : "default",
    },
    stateBackend,
    identityProvider: compactDoctorCheck({
      required: false,
      ok: oidcFlagIssues(serveOptions).filter(Boolean).length === 0,
      configured: oidcConfigured,
      mode: oidcConfigured ? (serveOptions.oidcJwksUrl ? "explicit-jwks" : "discovery") : "api-key",
      issuer: oidcConfigured ? serveOptions.oidcIssuer : undefined,
      audience: oidcConfigured ? serveOptions.oidcAudience : undefined,
    }),
    controlPlaneEnvValidation,
    executorConfiguration: executorConfigurationDoctorCheck(serveOptions),
    localExecutorSafety: compactDoctorCheck({
      required: true,
      ok: localExecutorSafetyReasons.length === 0,
      executorKind: serveOptions.executor,
      allowUnsafeLocalExecutor: Boolean(serveOptions.allowUnsafeLocalExecutor),
      reasons: localExecutorSafetyReasons.length ? localExecutorSafetyReasons : undefined,
    }),
    onlineSandboxTools: {
      required: onlineRequired,
      ok: missingOnlineSandboxTools.length === 0,
      missingTools: missingOnlineSandboxTools,
    },
    sandboxExecutor: {
      required: onlineRequired,
      ok: sandboxExecutorOk,
      executorKind: serveOptions.executor,
    },
    persistentHome: compactDoctorCheck({
      required: onlineRequired,
      ok: persistentHomeOk,
      executorKind: serveOptions.executor,
      homeRoot: serveOptions.executorHomeRoot?.trim() || undefined,
    }),
    tenantAuth: {
      required: onlineRequired,
      ok: tenantAuth.ok,
      roles: tenantAuth.roles,
      missingRoles: tenantAuth.missingRoles,
      policyKeyCount: tenantAuth.policyKeyCount,
      oidc: tenantAuth.oidc || undefined,
    },
    model: compactDoctorCheck({
      required: platformRequired,
      ...modelReadiness,
      keyEnv: serveOptions.modelKeyEnv,
    }),
    controlPlanePullRequest: {
      required: platformRequired,
      ok: serveOptions.giteaPr && giteaTokenReadiness.ok,
      provider: controlPlaneProvider,
      tokenMode: giteaTokenReadiness.mode,
    },
    controlPlaneMerge: {
      required: platformRequired,
      ok: serveOptions.giteaMerge && giteaTokenReadiness.ok,
      provider: controlPlaneProvider,
      tokenMode: giteaTokenReadiness.mode,
    },
    controlPlaneIssueComments: {
      required: platformRequired,
      ok: Boolean(serveOptions.giteaCommentSync) && giteaTokenReadiness.ok,
      provider: controlPlaneProvider,
      tokenMode: giteaTokenReadiness.mode,
    },
    controlPlaneIssueUrl: {
      required: platformRequired,
      ok: Boolean(serveOptions.giteaUrl?.trim()),
      provider: controlPlaneProvider,
    },
    controlPlaneSignedWebhooks: {
      required: platformRequired,
      ok: signedWebhookOk,
      provider: controlPlaneProvider,
      secretEnv: serveOptions.giteaWebhookSecretEnv ?? null,
      secretSet: signedWebhookOk,
    },
    controlPlaneGitTransport: compactDoctorCheck({
      required: platformRequired,
      ok: serveOptions.giteaPr && gitPrAllowed && giteaTokenReadiness.ok && Boolean(controlPlaneGitTransportEvidence.sampleRemoteUrl),
      provider: controlPlaneProvider,
      gitPrAllowed,
      tokenMode: giteaTokenReadiness.mode,
      ...controlPlaneGitTransportEvidence,
    }),
    controlPlaneWorkspaceBranchLease: {
      required: platformRequired,
      ok: runWorkspaceIsolationMode === "run" && serveOptions.giteaPr && gitPrAllowed,
      provider: controlPlaneProvider,
      runWorkspaceIsolation: runWorkspaceIsolationMode,
      branchDerivation: "run-suffixed",
      activeRunLeaseEvidence: true,
    },
    controlPlaneAgentIdentity: {
      required: platformRequired,
      ok: tenantScopedAgentIdentityOk,
      provider: controlPlaneProvider,
      mode: Object.keys(tenantGiteaTokenEnvs).length > 0 ? "tenant-scoped" : giteaTokenReadiness.mode,
      tenantCount: Object.keys(tenantGiteaTokenEnvs).length,
      missingEnvNames: giteaTokenReadiness.missingEnvNames,
    },
    agentGitServiceProjectAgents: {
      required: platformRequired && controlPlaneProvider === "agent-git-service",
      ...agentGitServiceProjectAgents,
    },
    controlPlaneBackupRestoreMigration: {
      required: platformRequired,
      ok: true,
      provider: controlPlaneProvider,
      format: "tenant-control-plane-backup-v1",
    },
    brainSignalIngest: {
      required: platformRequired,
      ok: Boolean(serveOptions.ingestBrain),
    },
    coderExecutor: {
      required: platformRequired,
      ok: coderExecutorOk,
      executorKind: serveOptions.executor,
      workspaceConfigured: Boolean(serveOptions.executorWorkspace?.trim()),
    },
    runWorkspaceIsolation: {
      required: platformRequired,
      ok: runWorkspaceIsolationMode === "run",
      mode: runWorkspaceIsolationMode,
    },
    runCreateIdempotency: {
      required: onlineRequired,
      ok: true,
      ...runCreateIdempotency,
    },
  };
  const missing = Object.entries(checks)
    .filter(([, check]) => check.required && !check.ok)
    .map(([name]) => name);
  const goldenPath: HarnessDoctorGoldenPath = {
    required: onlineRequired,
    ok: !onlineRequired || missing.length === 0,
    capabilities: [...ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES],
    missingCapabilities: onlineRequired && missing.length > 0 ? ["profile-readiness"] : [],
  };
  return {
    ok: missing.length === 0,
    profile,
    visionLock: HARNESS_VISION_LOCK,
    controlPlane: doctorControlPlaneStatus(controlPlaneProvider),
    goldenPath,
    missing,
    checks,
    recommendedFlags: recommendedDoctorFlags(missing),
  };
}

export function stateBackendDoctorCheck(options: HarnessServeCliOptions): HarnessDoctorCheck {
  const invalidFlags = stateBackendFlagIssues(options);
  if (invalidFlags.length) {
    return {
      required: true,
      ok: false,
      kind: options.stateBackend ?? "file",
      invalidFlags,
    };
  }
  const kind = parseStateBackendFlag(options.stateBackend);
  if (kind === "file") {
    return { required: true, ok: true, kind, distributed: false };
  }
  const postgresUrlEnv = options.statePostgresUrlEnv ?? "LOOM_POSTGRES_URL";
  const redisUrlEnv = options.stateRedisUrlEnv ?? "LOOM_REDIS_URL";
  const missingEnvNames = [postgresUrlEnv, redisUrlEnv].filter((name) => !process.env[name]);
  return {
    required: true,
    ok: missingEnvNames.length === 0,
    kind,
    distributed: true,
    postgresUrlEnv,
    postgresUrlSet: Boolean(process.env[postgresUrlEnv]),
    postgresSchema: options.statePostgresSchema ?? "loom",
    redisUrlEnv,
    redisUrlSet: Boolean(process.env[redisUrlEnv]),
    redisPrefix: options.stateRedisPrefix ?? "loom",
    missingEnvNames,
  };
}

export function doctorControlPlaneStatus(provider: ControlPlaneProviderName): HarnessDoctorControlPlane {
  const catalogEntry = controlPlaneProviderCatalogEntry(provider);
  return {
    provider,
    boundary: [...CONTROL_PLANE_PROVIDER_BOUNDARY],
    apiBasePath: catalogEntry?.apiBasePath,
    discoveryEndpoints: [...(catalogEntry?.discoveryEndpoints ?? [])],
    nativeCapabilities: [...(catalogEntry?.nativeCapabilities ?? [])],
    adoptionStages: (catalogEntry?.adoptionStages ?? []).map((stage) => ({ ...stage, evidence: [...stage.evidence] })),
  };
}

export function tenantAuthDoctorReadiness(keys: Record<string, TenantApiKey[]>, policyKeyCount: number, oidc = false): {
  ok: boolean;
  roles: Record<"admin" | "developer" | "viewer", boolean>;
  missingRoles: Array<"admin" | "developer" | "viewer">;
  policyKeyCount: number;
  oidc: boolean;
} {
  const roles = {
    admin: false,
    developer: false,
    viewer: false,
  };
  for (const key of Object.values(keys).flat()) {
    roles[key.role] = true;
  }
  if (oidc) {
    roles.admin = true;
    roles.developer = true;
    roles.viewer = true;
  }
  const missingRoles = (["admin", "developer", "viewer"] as const).filter((role) => !roles[role]);
  return { ok: missingRoles.length === 0, roles, missingRoles, policyKeyCount, oidc };
}

export function readPolicyTenantApiKeysForDoctor(workspaceRoot: string): Record<string, TenantApiKey[]> {
  const root = resolve(workspaceRoot);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return {};
    throw error;
  }

  const keys: Record<string, TenantApiKey[]> = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeTenantDirectoryNameForDoctor(entry.name)) continue;
    let raw;
    try {
      raw = readFileSync(join(root, entry.name, ".loom", "policy.json"), "utf8");
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    const apiKeys = tenantPolicyApiKeysForDoctor(JSON.parse(raw));
    if (apiKeys.length) keys[entry.name] = apiKeys;
  }
  return keys;
}

export function readPolicyTenantModelKeyEnvsForDoctor(workspaceRoot: string): Record<string, string> {
  const root = resolve(workspaceRoot);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return {};
    throw error;
  }

  const envs: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeTenantDirectoryNameForDoctor(entry.name)) continue;
    let raw;
    try {
      raw = readFileSync(join(root, entry.name, ".loom", "policy.json"), "utf8");
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    const envName = tenantPolicyModelKeyEnvForDoctor(JSON.parse(raw));
    if (envName) envs[entry.name] = envName;
  }
  return envs;
}

export function agentGitServiceProjectAgentsDoctorReadiness(
  workspaceRoot: string,
  provider: ControlPlaneProviderName,
  secretRoot: string | undefined,
): {
  ok: boolean;
  provider: ControlPlaneProviderName;
  tenantCount: number;
  projectCount: number;
  provisionedProjectCount: number;
  secretRootConfigured: boolean;
  secretStoredProjectCount: number;
  missingProjects: string[];
  missingSecretProjects: string[];
} {
  if (provider !== "agent-git-service") {
    return {
      ok: true,
      provider,
      tenantCount: 0,
      projectCount: 0,
      provisionedProjectCount: 0,
      secretRootConfigured: false,
      secretStoredProjectCount: 0,
      missingProjects: [],
      missingSecretProjects: [],
    };
  }

  const projects = listDoctorProjects(workspaceRoot);
  const tenants = new Set(projects.map((project) => project.tenant));
  const secretRootConfigured = Boolean(secretRoot?.trim());
  const missingProjects: string[] = [];
  const missingSecretProjects: string[] = [];
  let provisionedProjectCount = 0;
  let secretStoredProjectCount = 0;

  for (const project of projects) {
    const receipt = readAgentGitServiceProjectProvisioningReceiptForDoctor(workspaceRoot, project.tenant, project.project);
    if (!receipt) {
      missingProjects.push(project.ref);
      continue;
    }
    provisionedProjectCount += 1;
    const secret = secretRootConfigured
      ? readAgentGitServiceAgentTokenSecretForDoctor(secretRoot as string, project.tenant, project.project, receipt.tokenEnvName)
      : undefined;
    if (secret === undefined) {
      missingSecretProjects.push(project.ref);
    } else {
      secretStoredProjectCount += 1;
    }
  }

  return {
    ok: missingProjects.length === 0 && missingSecretProjects.length === 0,
    provider,
    tenantCount: tenants.size,
    projectCount: projects.length,
    provisionedProjectCount,
    secretRootConfigured,
    secretStoredProjectCount,
    missingProjects,
    missingSecretProjects,
  };
}

export function listDoctorProjects(workspaceRoot: string): Array<{ tenant: string; project: string; ref: string }> {
  const root = resolve(workspaceRoot);
  let tenantEntries;
  try {
    tenantEntries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const projects: Array<{ tenant: string; project: string; ref: string }> = [];
  for (const tenantEntry of tenantEntries) {
    if (!tenantEntry.isDirectory() || !isSafeTenantDirectoryNameForDoctor(tenantEntry.name)) continue;
    let projectEntries;
    try {
      projectEntries = readdirSync(join(root, tenantEntry.name), { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory() || !isProjectDirectoryNameForDoctor(projectEntry.name)) continue;
      if (!projectMetadataMatchesForDoctor(join(root, tenantEntry.name, projectEntry.name), tenantEntry.name, projectEntry.name)) continue;
      projects.push({
        tenant: tenantEntry.name,
        project: projectEntry.name,
        ref: `${tenantEntry.name}/${projectEntry.name}`,
      });
    }
  }
  return projects.sort((a, b) => a.ref.localeCompare(b.ref));
}

export function projectMetadataMatchesForDoctor(projectRoot: string, tenant: string, project: string): boolean {
  let value;
  try {
    value = JSON.parse(readFileSync(join(projectRoot, ".loom", "project.json"), "utf8"));
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return false;
    throw error;
  }
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    (value.template === "empty" || value.template === "vas-lite") &&
    value.tenant === tenant &&
    value.project === project &&
    typeof value.createdAt === "string"
  );
}

export function readAgentGitServiceProjectProvisioningReceiptForDoctor(
  workspaceRoot: string,
  tenant: string,
  project: string,
): { tokenEnvName: string } | undefined {
  let value;
  try {
    value = JSON.parse(readFileSync(agentGitServiceProjectProvisioningReceiptPath(workspaceRoot, tenant, project), "utf8"));
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== 1 || value.provider !== "agent-git-service") return undefined;
  if (value.tenant !== tenant || value.project !== project) return undefined;
  if (typeof value.baseUrl !== "string" || typeof value.repo !== "string") return undefined;
  if (typeof value.agentLogin !== "string" || typeof value.agentRepoFullName !== "string") return undefined;
  if (value.permission !== "read" && value.permission !== "write" && value.permission !== "admin") return undefined;
  if (value.grantStatus !== "granted" && value.grantStatus !== "invited") return undefined;
  if (typeof value.tokenEnvName !== "string" || !isEnvName(value.tokenEnvName)) return undefined;
  if (value.tokenMaterial !== "returned-only" || typeof value.provisionedAt !== "string") return undefined;
  return { tokenEnvName: value.tokenEnvName };
}

export function readAgentGitServiceAgentTokenSecretForDoctor(
  secretRoot: string,
  tenant: string,
  project: string,
  tokenEnvName: string,
): string | undefined {
  const secretRootPath = resolve(secretRoot);
  const secretPath = resolve(secretRootPath, tenant, project, tokenEnvName);
  if (!secretPath.startsWith(`${secretRootPath}/`)) return undefined;
  try {
    const token = readFileSync(secretPath, "utf8").replace(/\r?\n$/, "");
    return token || undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export function mergeTenantApiKeysForDoctor(
  first: Record<string, TenantApiKey[]>,
  second: Record<string, TenantApiKey[]>,
): Record<string, TenantApiKey[]> {
  const merged: Record<string, TenantApiKey[]> = {};
  for (const [tenant, keys] of Object.entries(first)) merged[tenant] = [...keys];
  for (const [tenant, keys] of Object.entries(second)) {
    merged[tenant] = [...(merged[tenant] ?? []), ...keys];
  }
  return merged;
}

export function tenantPolicyModelKeyEnvForDoctor(value: unknown): string | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.modelKeyEnv !== "string") return undefined;
  return isEnvName(value.modelKeyEnv) ? value.modelKeyEnv : undefined;
}

export function tenantPolicyApiKeysForDoctor(value: unknown): TenantApiKey[] {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.apiKeys)) return [];
  return value.apiKeys.flatMap((entry): TenantApiKey[] => {
    if (!isRecord(entry)) return [];
    if (typeof entry.actor !== "string") return [];
    if (entry.role !== "admin" && entry.role !== "developer" && entry.role !== "viewer") return [];
    if (typeof entry.token !== "string" && typeof entry.tokenHash !== "string") return [];
    if (typeof entry.notBefore === "string" && Date.parse(entry.notBefore) > Date.now()) return [];
    if (typeof entry.expiresAt === "string" && Date.parse(entry.expiresAt) <= Date.now()) return [];
    const modelKeyEnv = typeof entry.modelKeyEnv === "string" && isEnvName(entry.modelKeyEnv)
      ? entry.modelKeyEnv
      : undefined;
    return [{
      actor: entry.actor,
      role: entry.role,
      ...(modelKeyEnv ? { modelKeyEnv } : {}),
    }];
  });
}

export interface ModelDoctorReadiness {
  ok: boolean;
  baseUrlConfigured: boolean;
  keySet: boolean;
  keyConfigured: boolean;
  keyMode: "none" | "server" | "tenant-scoped" | "policy-key-scoped" | "mixed";
  tenantCount: number;
  missingTenantCount: number;
  missingEnvNames?: string[];
}

export function modelDoctorReadiness(
  options: Pick<ResolvedHarnessServeCliOptions, "modelBaseUrl" | "modelKeyEnv">,
  tenantNames: string[],
  tenantModelKeyEnvs: Record<string, string>,
  tenantApiKeys: Record<string, TenantApiKey[]>,
): ModelDoctorReadiness {
  const serverKeySet = Boolean(process.env[options.modelKeyEnv]);
  let serverCoveredTenantCount = 0;
  let scopedTenantCount = 0;
  let policyKeyScopedTenantCount = 0;
  let missingTenantCount = 0;
  const missingEnvNames: string[] = [];

  for (const tenant of tenantNames) {
    const coverage = tenantModelKeyCoverageForDoctor(tenantModelKeyEnvs[tenant], tenantApiKeys[tenant] ?? [], serverKeySet);
    if (coverage.serverCovered) serverCoveredTenantCount += 1;
    if (coverage.tenantScoped) scopedTenantCount += 1;
    if (coverage.policyKeyScoped) policyKeyScopedTenantCount += 1;
    if (!coverage.ok) {
      missingTenantCount += 1;
      missingEnvNames.push(...coverage.missingEnvNames);
    }
  }

  const scopedCoverageCount = scopedTenantCount + policyKeyScopedTenantCount;
  const keyConfigured = serverKeySet || (tenantNames.length > 0 && missingTenantCount === 0 && scopedCoverageCount > 0);
  return {
    ok: Boolean(options.modelBaseUrl?.trim()) && keyConfigured && missingTenantCount === 0,
    baseUrlConfigured: Boolean(options.modelBaseUrl?.trim()),
    keySet: serverKeySet,
    keyConfigured,
    keyMode: modelKeyModeForDoctor(serverKeySet, scopedTenantCount, policyKeyScopedTenantCount, serverCoveredTenantCount),
    tenantCount: tenantNames.length,
    missingTenantCount,
    missingEnvNames: missingEnvNames.length ? [...new Set(missingEnvNames)] : undefined,
  };
}

export function tenantModelKeyCoverageForDoctor(
  tenantModelKeyEnv: string | undefined,
  tenantApiKeys: TenantApiKey[],
  serverKeySet: boolean,
): {
  ok: boolean;
  serverCovered: boolean;
  tenantScoped: boolean;
  policyKeyScoped: boolean;
  missingEnvNames: string[];
} {
  const explicitKeyEnvNames = tenantApiKeys.flatMap((key) => key.modelKeyEnv ? [key.modelKeyEnv] : []);
  const fallbackConsumerCount = tenantApiKeys.filter((key) => !key.modelKeyEnv).length;
  const missingEnvNames = explicitKeyEnvNames.filter((envName) => !process.env[envName]);
  let serverCovered = false;
  let tenantScoped = false;
  const policyKeyScoped = explicitKeyEnvNames.length > 0 && missingEnvNames.length === 0;

  if (fallbackConsumerCount > 0) {
    if (tenantModelKeyEnv) {
      if (process.env[tenantModelKeyEnv]) {
        tenantScoped = true;
      } else {
        missingEnvNames.push(tenantModelKeyEnv);
      }
    } else if (serverKeySet) {
      serverCovered = true;
    } else {
      return { ok: false, serverCovered, tenantScoped, policyKeyScoped, missingEnvNames };
    }
  }

  return { ok: missingEnvNames.length === 0, serverCovered, tenantScoped, policyKeyScoped, missingEnvNames };
}

export function modelKeyModeForDoctor(
  serverKeySet: boolean,
  scopedTenantCount: number,
  policyKeyScopedTenantCount: number,
  serverCoveredTenantCount: number,
): "none" | "server" | "tenant-scoped" | "policy-key-scoped" | "mixed" {
  const activeModes = [
    serverCoveredTenantCount > 0 || (serverKeySet && scopedTenantCount === 0 && policyKeyScopedTenantCount === 0)
      ? "server"
      : undefined,
    scopedTenantCount > 0 ? "tenant-scoped" : undefined,
    policyKeyScopedTenantCount > 0 ? "policy-key-scoped" : undefined,
  ].filter(Boolean);
  if (activeModes.length > 1) return "mixed";
  if (activeModes.length === 1) return activeModes[0] as "server" | "tenant-scoped" | "policy-key-scoped";
  return "none";
}

export function isSafeTenantDirectoryNameForDoctor(name: string): boolean {
  try {
    assertTenantName(name);
    return true;
  } catch {
    return false;
  }
}

export function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function giteaTokenEnvReadiness(giteaTokenEnv: string, tenantGiteaTokenEnvs: Record<string, string>): {
  ok: boolean;
  mode: "none" | "shared" | "tenant-scoped";
  missingEnvNames: string[];
} {
  const tenantEnvNames = Object.values(tenantGiteaTokenEnvs);
  if (tenantEnvNames.length) {
    const missingEnvNames = tenantEnvNames.filter((envName) => !process.env[envName]);
    return {
      ok: missingEnvNames.length === 0,
      mode: "tenant-scoped",
      missingEnvNames,
    };
  }
  if (process.env[giteaTokenEnv]) return { ok: true, mode: "shared", missingEnvNames: [] };
  return { ok: false, mode: "none", missingEnvNames: [giteaTokenEnv] };
}

export function compactDoctorCheck(check: HarnessDoctorCheck): HarnessDoctorCheck {
  return Object.fromEntries(Object.entries(check).filter(([, value]) => value !== undefined)) as HarnessDoctorCheck;
}

export function runCreateIdempotencyStatus(): RunCreateIdempotencyStatus {
  return {
    clientRequestId: true,
    sharedRunStore: true,
    crossServerReplay: true,
    simultaneousCreateReplay: true,
    conflictOnRequestMismatch: true,
  };
}

export function recommendedDoctorFlags(missing: string[]): string[] {
  const flags: Record<string, string[]> = {
    onlineSandboxTools: ["--allow-shell"],
    sandboxExecutor: ["--executor docker|coder"],
    persistentHome: ["--executor-home-root <path>", "--executor coder"],
    tenantAuth: ["--tenant-key-env <tenant=env:actor:role>", "--tenant-key <tenant=token:actor:role>"],
    model: ["--model-base-url <url> --model-key-env <env>", "--tenant-model-key <tenant=env>"],
    controlPlanePullRequest: ["--control-plane-pr"],
    controlPlaneMerge: ["--control-plane-merge"],
    controlPlaneIssueComments: ["--control-plane-comment-sync"],
    controlPlaneIssueUrl: ["--control-plane-url <url>"],
    controlPlaneSignedWebhooks: ["--control-plane-webhook-secret-env <env>"],
    controlPlaneGitTransport: ["--allow-tool git.pr"],
    controlPlaneWorkspaceBranchLease: ["--executor-worktree-cwd <path-template>", "--allow-tool git.pr", "--control-plane-pr"],
    controlPlaneAgentIdentity: ["--tenant-control-plane-token-env <tenant=env>"],
    agentGitServiceProjectAgents: ["loom harness provision-agent-git-service --store-agent-token"],
    brainSignalIngest: ["--ingest-brain"],
    coderExecutor: ["--executor coder"],
    runWorkspaceIsolation: ["--executor-worktree-cwd <path-template>"],
    localExecutorSafety: ["--executor docker|coder", "--allow-unsafe-local-executor"],
    executorConfiguration: ["--executor-image <image>", "--executor-workspace <name>", "--executor local|docker|coder"],
    controlPlaneEnvValidation: ["--control-plane-token-env <env>", "--tenant-control-plane-token-env <tenant=env>", "--control-plane-webhook-secret-env <env>"],
    stateBackend: ["--state-postgres-url-env <env>", "--state-redis-url-env <env>"],
  };
  return Array.from(new Set(missing.flatMap((name) => flags[name] ?? [])));
}

export function parseServeProfileFlag(value: string | undefined): HarnessServeProfileName | undefined {
  return parseOnlineProfileFlag(value, "--profile");
}

export function allowedHttpTools(extraTools: string[], allowShell: boolean): string[] {
  const tools = new Set(["file.read", "file.write", "git.diff", "git.commit", "verify.run", ...extraTools]);
  if (allowShell) tools.add("shell.exec");
  return [...tools];
}

export function serveFlagValidationDoctorCheck(options: HarnessServeCliOptions): HarnessDoctorCheck {
  const issues = serveFlagValidationIssues(options);
  return compactDoctorCheck({
    required: true,
    ok: issues.length === 0,
    invalidFlags: issues.length ? issues : undefined,
  });
}

export interface ServeFlagValidationIssue {
  flag: string;
  message: string;
}

export function requireServeFlagValidation(options: HarnessServeCliOptions): void {
  const [issue] = serveFlagValidationIssues(options);
  if (!issue) return;
  console.error(issue.message);
  process.exit(2);
}

export function serveFlagValidationIssues(options: HarnessServeCliOptions): ServeFlagValidationIssue[] {
  const issues = [
    portFlagIssue(options.port),
    positiveIntFlagIssue(options.workspaceCommandTimeoutMs, "--workspace-command-timeout-ms"),
    positiveIntFlagIssue(options.maxWorkspaceSessions, "--max-workspace-sessions"),
    options.maxTenantWorkspaceSessions === undefined
      ? undefined
      : positiveIntFlagIssue(options.maxTenantWorkspaceSessions, "--max-tenant-workspace-sessions"),
    options.maxTenantActiveRuns === undefined
      ? undefined
      : positiveIntFlagIssue(options.maxTenantActiveRuns, "--max-tenant-active-runs"),
    positiveIntFlagIssue(options.workspaceSessionIdleTimeoutMs, "--workspace-session-idle-timeout-ms"),
    positiveIntFlagIssue(options.runLeaseTtlMs, "--run-lease-ttl-ms"),
    options.stateProbeIntervalMs === undefined ? undefined : boundedPositiveIntFlagIssue(options.stateProbeIntervalMs, "--state-probe-interval-ms", 300_000),
    options.stateProbeTimeoutMs === undefined ? undefined : boundedPositiveIntFlagIssue(options.stateProbeTimeoutMs, "--state-probe-timeout-ms", 300_000),
    options.stateProbeMaxStalenessMs === undefined ? undefined : boundedPositiveIntFlagIssue(options.stateProbeMaxStalenessMs, "--state-probe-max-staleness-ms", 300_000),
    ...oidcFlagIssues(options),
    ...stateBackendFlagIssues(options),
  ];
  if (options.executor === "docker" || options.executor === "coder") {
    issues.push(
      options.executorCpus === undefined ? undefined : positiveNumberFlagIssue(options.executorCpus, "--executor-cpus"),
      options.executorPidsLimit === undefined ? undefined : positiveIntFlagIssue(options.executorPidsLimit, "--executor-pids-limit"),
    );
  }
  return issues.filter((issue): issue is ServeFlagValidationIssue => Boolean(issue));
}

export function portFlagIssue(value: string): ServeFlagValidationIssue | undefined {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535) return undefined;
  return { flag: "--port", message: "--port must be an integer between 0 and 65535" };
}

export function positiveIntFlagIssue(value: string, flag: string): ServeFlagValidationIssue | undefined {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1) return undefined;
  return { flag, message: `${flag} must be a positive integer.` };
}

export function boundedPositiveIntFlagIssue(value: string, flag: string, maximum: number): ServeFlagValidationIssue | undefined {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum) return undefined;
  return { flag, message: `${flag} must be an integer between 1 and ${maximum}.` };
}

export function oidcFlagIssues(options: HarnessServeCliOptions): Array<ServeFlagValidationIssue | undefined> {
  const enabled = Boolean(options.oidcIssuer || options.oidcAudience || options.oidcJwksUrl);
  if (!enabled) return [];
  return [
    options.oidcIssuer?.trim()
      ? oidcUrlFlagIssue(options.oidcIssuer, "--oidc-issuer", Boolean(options.oidcAllowInsecureHttp))
      : { flag: "--oidc-issuer", message: "--oidc-issuer is required when OIDC is configured." },
    options.oidcAudience?.trim()
      ? undefined
      : { flag: "--oidc-audience", message: "--oidc-audience is required when OIDC is configured." },
    options.oidcJwksUrl === undefined
      ? undefined
      : oidcUrlFlagIssue(options.oidcJwksUrl, "--oidc-jwks-url", Boolean(options.oidcAllowInsecureHttp)),
    oidcClaimFlagIssue(options.oidcTenantClaim ?? "loom_tenant", "--oidc-tenant-claim"),
    oidcClaimFlagIssue(options.oidcActorClaim ?? "preferred_username", "--oidc-actor-claim"),
    oidcClaimFlagIssue(options.oidcRoleClaim ?? "loom_role", "--oidc-role-claim"),
    boundedIntegerFlagIssue(options.oidcClockToleranceSeconds ?? "30", "--oidc-clock-tolerance-seconds", 0, 300),
    boundedIntegerFlagIssue(options.oidcRequestTimeoutMs ?? "3000", "--oidc-request-timeout-ms", 100, 30_000),
  ];
}

export function oidcUrlFlagIssue(value: string, flag: string, allowInsecureHttp: boolean): ServeFlagValidationIssue | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) throw new Error("unsafe URL");
    if (url.protocol === "https:" || (allowInsecureHttp && url.protocol === "http:")) return undefined;
  } catch {
    // Report the same operator-facing validation below.
  }
  return { flag, message: `${flag} must be an absolute HTTPS URL without credentials or a fragment.` };
}

export function oidcClaimFlagIssue(value: string, flag: string): ServeFlagValidationIssue | undefined {
  if (/^[A-Za-z0-9_.:-]{1,120}$/.test(value.trim())) return undefined;
  return { flag, message: `${flag} must be a valid claim name.` };
}

export function boundedIntegerFlagIssue(
  value: string,
  flag: string,
  minimum: number,
  maximum: number,
): ServeFlagValidationIssue | undefined {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum) return undefined;
  return { flag, message: `${flag} must be an integer between ${minimum} and ${maximum}.` };
}

export function positiveNumberFlagIssue(value: string, flag: string): ServeFlagValidationIssue | undefined {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return undefined;
  return { flag, message: `${flag} must be a positive number.` };
}

export interface ServeExecutorSafetyOptions {
  executor: string;
  workspaceRoot: string;
  host: string;
  allowShell: boolean;
  allowTool: string[];
  allowUnsafeLocalExecutor: boolean;
  tenantToken?: string[];
  tenantKey?: string[];
  tenantKeyEnv?: string[];
  oidcIssuer?: string;
}

export function requireSafeServeExecutor(options: ServeExecutorSafetyOptions): void {
  const reasons = unsafeLocalExecutorReasons(options);
  if (!reasons.length) return;
  console.error(
    `--executor local is not isolated for shared HTTP use (${reasons.join("; ")}). ` +
      "Use --executor docker, --executor coder, or pass --allow-unsafe-local-executor for single-user local development.",
  );
  process.exit(2);
}

export function unsafeLocalExecutorReasons(options: ServeExecutorSafetyOptions, policyTenantAuthConfigured?: boolean): string[] {
  if (options.executor !== "local") return [];
  const hasPolicyTenantAuth = policyTenantAuthConfigured ??
    Object.values(readPolicyTenantApiKeysForDoctor(options.workspaceRoot)).some((keys) => keys.length > 0);
  const tenantAuthConfigured = Boolean(
    options.tenantToken?.length || options.tenantKey?.length || options.tenantKeyEnv?.length || options.oidcIssuer || hasPolicyTenantAuth,
  );
  if (options.allowUnsafeLocalExecutor) {
    // Escape hatch, but not a blank cheque. It never applies to a non-loopback
    // host. On loopback it still refuses the one combination that is a
    // cross-tenant RCE: multiple tenants plus shell.exec share one host and one
    // process user with no sandbox. (A loopback bind can still be reverse-proxied
    // to the internet, so "loopback" is not proof of single-user.) Multi-tenant
    // without shell.exec is limited to per-run path-guarded workspace file ops
    // and stays allowed for a trusted single-box deployment.
    const shellEnabled = options.allowShell || options.allowTool.includes("shell.exec");
    return [
      !isLoopbackHost(options.host)
        ? `host ${options.host} is not loopback and --allow-unsafe-local-executor only applies to loopback hosts`
        : undefined,
      tenantAuthConfigured && shellEnabled
        ? "shell.exec with tenant authentication is a cross-tenant RCE on the local executor; use --executor docker|coder"
        : undefined,
    ].filter((reason): reason is string => Boolean(reason));
  }
  return [
    !isLoopbackHost(options.host) ? `host ${options.host} is not loopback` : undefined,
    options.allowShell || options.allowTool.includes("shell.exec") ? "shell.exec is allowed" : undefined,
    tenantAuthConfigured ? "tenant authentication is configured" : undefined,
  ].filter((reason): reason is string => Boolean(reason));
}

export function executorConfigurationDoctorCheck(options: Pick<ExecutorCliOptions, "executor" | "executorImage" | "executorWorkspace">): HarnessDoctorCheck {
  const issues = executorConfigurationIssues(options);
  return compactDoctorCheck({
    required: true,
    ok: issues.length === 0,
    executorKind: options.executor,
    imageConfigured: options.executor === "docker" ? Boolean(options.executorImage?.trim()) : undefined,
    workspaceConfigured: options.executor === "coder" ? Boolean(options.executorWorkspace?.trim()) : undefined,
    missingFlags: issues.length ? issues.map((issue) => issue.flag) : undefined,
  });
}

export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === "localhost" || value === "::1" || value === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(value);
}

export function parseTenantTokens(values: string[]): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0 || index === value.length - 1) {
      console.error("--tenant-token must be formatted as tenant=token");
      process.exit(2);
    }
    tokens[parseTenantFlagName(value.slice(0, index))] = value.slice(index + 1);
  }
  return tokens;
}

export function parseTenantApiKeys(values: string[]): Record<string, TenantApiKey[]> {
  const keys: Record<string, TenantApiKey[]> = {};
  for (const value of values) {
    const tenantSeparator = value.indexOf("=");
    if (tenantSeparator <= 0 || tenantSeparator === value.length - 1) {
      console.error("--tenant-key must be formatted as tenant=token:actor:role");
      process.exit(2);
    }
    const tenant = parseTenantFlagName(value.slice(0, tenantSeparator));
    const spec = value.slice(tenantSeparator + 1);
    const parts = spec.split(":");
    if (parts.length !== 3 || parts.some((part) => !part.trim())) {
      console.error("--tenant-key must be formatted as tenant=token:actor:role");
      process.exit(2);
    }
    const [token, actor, role] = parts;
    if (role !== "admin" && role !== "developer" && role !== "viewer") {
      console.error("--tenant-key role must be one of: admin, developer, viewer");
      process.exit(2);
    }
    keys[tenant] = [...(keys[tenant] ?? []), { token, actor, role }];
  }
  return keys;
}

export function parseTenantApiKeysFromServeOptions(options: Pick<HarnessServeCliOptions, "tenantKey" | "tenantKeyEnv">): Record<string, TenantApiKey[]> {
  return mergeTenantApiKeysForDoctor(
    parseTenantApiKeys(options.tenantKey ?? []),
    parseTenantApiKeyEnvs(options.tenantKeyEnv ?? []),
  );
}

export function oidcAuthFromServeOptions(options: Pick<
  HarnessServeCliOptions,
  | "oidcIssuer"
  | "oidcAudience"
  | "oidcJwksUrl"
  | "oidcTenantClaim"
  | "oidcActorClaim"
  | "oidcRoleClaim"
  | "oidcClockToleranceSeconds"
  | "oidcRequestTimeoutMs"
  | "oidcAllowInsecureHttp"
>): OidcAuthConfig | undefined {
  if (!options.oidcIssuer && !options.oidcAudience) return undefined;
  if (!options.oidcIssuer || !options.oidcAudience) {
    console.error("--oidc-issuer and --oidc-audience must be configured together");
    process.exit(2);
  }
  return {
    issuer: options.oidcIssuer,
    audience: options.oidcAudience,
    jwksUrl: options.oidcJwksUrl,
    tenantClaim: options.oidcTenantClaim,
    actorClaim: options.oidcActorClaim,
    roleClaim: options.oidcRoleClaim,
    clockToleranceSeconds: Number(options.oidcClockToleranceSeconds ?? "30"),
    requestTimeoutMs: Number(options.oidcRequestTimeoutMs ?? "3000"),
    allowInsecureHttp: Boolean(options.oidcAllowInsecureHttp),
  };
}

export function parseTenantApiKeyEnvs(values: string[]): Record<string, TenantApiKey[]> {
  const keys: Record<string, TenantApiKey[]> = {};
  for (const value of values) {
    const tenantSeparator = value.indexOf("=");
    if (tenantSeparator <= 0 || tenantSeparator === value.length - 1) {
      console.error("--tenant-key-env must be formatted as tenant=env:actor:role");
      process.exit(2);
    }
    const tenant = parseTenantFlagName(value.slice(0, tenantSeparator));
    const spec = value.slice(tenantSeparator + 1);
    const parts = spec.split(":");
    if (parts.length !== 3 || parts.some((part) => !part.trim())) {
      console.error("--tenant-key-env must be formatted as tenant=env:actor:role");
      process.exit(2);
    }
    const [envName, actor, role] = parts;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      console.error("--tenant-key-env env must be an environment variable name");
      process.exit(2);
    }
    if (role !== "admin" && role !== "developer" && role !== "viewer") {
      console.error("--tenant-key-env role must be one of: admin, developer, viewer");
      process.exit(2);
    }
    const token = process.env[envName];
    if (token?.trim()) {
      keys[tenant] = [...(keys[tenant] ?? []), { token, actor, role }];
    }
  }
  return keys;
}

export function parseTenantModelKeyEnvs(values: string[]): Record<string, string> {
  const envs: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0 || index === value.length - 1) {
      console.error("--tenant-model-key must be formatted as tenant=env");
      process.exit(2);
    }
    const envName = value.slice(index + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      console.error("--tenant-model-key env must be an environment variable name");
      process.exit(2);
    }
    envs[parseTenantFlagName(value.slice(0, index))] = envName;
  }
  return envs;
}

export function parseTenantGiteaTokenEnvs(values: string[]): Record<string, string> {
  const envs: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0 || index === value.length - 1) {
      console.error("--tenant-gitea-token-env must be formatted as tenant=env");
      process.exit(2);
    }
    const envName = value.slice(index + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      console.error("--tenant-gitea-token-env env must be an environment variable name");
      process.exit(2);
    }
    envs[parseTenantFlagName(value.slice(0, index))] = envName;
  }
  return envs;
}

export interface ControlPlaneEnvValidationOptions extends IssueReporterOptions {
  controlPlaneWebhookSecretEnv?: string;
  giteaWebhookSecretEnv?: string;
}

export function controlPlaneEnvValidationDoctorCheck(options: ControlPlaneEnvValidationOptions): HarnessDoctorCheck {
  const enabledFlags = controlPlaneEnvValidationFlags(options);
  const missingEnvNames = controlPlaneMissingEnvNames(options);
  const tokenEvidence = controlPlaneTokenEnvEvidence(options);
  return compactDoctorCheck({
    required: true,
    ok: missingEnvNames.length === 0,
    enabledFlags: enabledFlags.length ? enabledFlags : undefined,
    tokenMode: missingEnvNames.length === 0 ? tokenEvidence.mode : undefined,
    tokenEnv: missingEnvNames.length === 0 ? tokenEvidence.tokenEnv : undefined,
    tenantTokenEnvNames: missingEnvNames.length === 0 ? tokenEvidence.tenantTokenEnvNames : undefined,
    missingEnvNames: missingEnvNames.length ? missingEnvNames : undefined,
  });
}

export function controlPlaneTokenEnvEvidence(options: IssueReporterOptions): {
  mode?: "shared" | "tenant-scoped";
  tokenEnv?: string;
  tenantTokenEnvNames?: string[];
} {
  if (!requiresGiteaToken(options)) return {};
  const tenantTokenEnvNames = Object.values(options.tenantGiteaTokenEnvs ?? {}).sort((a, b) => a.localeCompare(b));
  if (tenantTokenEnvNames.length > 0) {
    return {
      mode: "tenant-scoped",
      tenantTokenEnvNames,
    };
  }
  return {
    mode: "shared",
    tokenEnv: options.giteaTokenEnv,
  };
}

export function controlPlaneEnvValidationFlags(options: ControlPlaneEnvValidationOptions): string[] {
  return [
    options.controlPlanePr ? "--control-plane-pr" : options.giteaPr ? "--gitea-pr" : undefined,
    options.controlPlaneComment ? "--control-plane-comment" : options.giteaComment ? "--gitea-comment" : undefined,
    options.controlPlaneCommentSync ? "--control-plane-comment-sync" : options.giteaCommentSync ? "--gitea-comment-sync" : undefined,
    options.controlPlaneMerge ? "--control-plane-merge" : options.giteaMerge ? "--gitea-merge" : undefined,
    options.controlPlaneWebhookSecretEnv ? "--control-plane-webhook-secret-env" : options.giteaWebhookSecretEnv ? "--gitea-webhook-secret-env" : undefined,
  ].filter((flag): flag is string => Boolean(flag));
}

export function controlPlaneMissingEnvNames(options: ControlPlaneEnvValidationOptions): string[] {
  const missing = [
    ...missingGiteaTokenEnvNames(options),
    missingGiteaWebhookSecretEnvName(options.giteaWebhookSecretEnv),
  ].filter((envName): envName is string => Boolean(envName));
  return [...new Set(missing)];
}

export function missingGiteaTokenEnvNames(options: IssueReporterOptions): string[] {
  if (!requiresGiteaToken(options)) return [];
  const tenantMissing = missingTenantGiteaTokenEnvEntries(options).map(([, envName]) => envName);
  if (tenantMissing.length) return tenantMissing;
  const sharedMissing = missingSharedGiteaTokenEnvName(options);
  return sharedMissing ? [sharedMissing] : [];
}

export function requiresGiteaToken(options: IssueReporterOptions): boolean {
  return Boolean(options.giteaPr || options.giteaComment || options.giteaCommentSync || options.giteaMerge);
}

export function missingGiteaWebhookSecretEnvName(envName?: string): string | undefined {
  if (!envName) return undefined;
  return process.env[envName] ? undefined : envName;
}

export function controlPlaneAgentIdentityFromGiteaTokens(options: IssueReporterOptions): ControlPlaneAgentIdentityConfig | undefined {
  const tenants = Object.keys(options.tenantGiteaTokenEnvs ?? {}).sort((a, b) => a.localeCompare(b));
  if (tenants.length > 0) return { mode: "tenant-scoped", tenants };
  if (process.env[options.giteaTokenEnv]) return { mode: "shared" };
  return undefined;
}

export function controlPlaneTenantTokensFromEnv(envs: Record<string, string> | undefined): Record<string, string> | undefined {
  const tokens = Object.fromEntries(
    Object.entries(envs ?? {}).flatMap(([tenant, envName]) => {
      const token = process.env[envName];
      return token ? [[tenant, token]] : [];
    }),
  );
  return Object.keys(tokens).length ? tokens : undefined;
}

export function controlPlaneGitTransportDoctorEvidence(provider: ControlPlaneProviderName, baseUrl: string): { sampleRepo?: string; sampleRemoteUrl?: string } {
  if (!baseUrl.trim()) return {};
  try {
    return {
      sampleRepo: CONTROL_PLANE_GIT_TRANSPORT_SAMPLE_REPO,
      sampleRemoteUrl: serveControlPlaneProviderAdapter(provider).gitRemoteUrl(baseUrl, CONTROL_PLANE_GIT_TRANSPORT_SAMPLE_REPO),
    };
  } catch {
    return { sampleRepo: CONTROL_PLANE_GIT_TRANSPORT_SAMPLE_REPO };
  }
}

export function serveControlPlaneProviderAdapter(provider: ControlPlaneProviderName): ControlPlaneProvider {
  const adapter = controlPlaneProviderAdapter(provider);
  if (!adapter) throw new Error(`unsupported control-plane provider: ${provider}`);
  return adapter;
}

export function maybeIssueCommentReader(options: IssueReporterOptions): ((issue: string, context: IssueCommentReaderContext) => Promise<ControlPlaneIssueComment[]>) | undefined {
  if (!options.giteaCommentSync) return undefined;
  const flag = controlPlaneReporterFlag(options, "comment-sync");
  validateControlPlaneTokenEnvs(options, flag);
  const provider = issueReporterControlPlaneProvider(options);
  return (issue: string, context: IssueCommentReaderContext) => provider.listIssueComments({
    baseUrl: options.giteaUrl,
    token: giteaTokenForTenant(options, context.tenant, flag),
    issue,
    limit: 100,
  });
}

export function maybeGiteaWebhookSecret(envName?: string): string | undefined {
  if (!envName) return undefined;
  if (missingGiteaWebhookSecretEnvName(envName)) {
    console.error(`--gitea-webhook-secret-env ${envName} is set but the env var is empty.`);
    process.exit(2);
  }
  return process.env[envName];
}

export function maybeWorkspacePullRequestReporter(options: IssueReporterOptions): ((request: WorkspacePullRequestRequest) => Promise<PullRequestReporterResult | void>) | undefined {
  if (!options.giteaPr) return undefined;
  const flag = controlPlaneReporterFlag(options, "pr");
  validateControlPlaneTokenEnvs(options, flag);
  const provider = issueReporterControlPlaneProvider(options);
  return async (request: WorkspacePullRequestRequest) => {
    const issue = parseIssueRefForControlPlane(options, request.issue);
    const pullRequest = await provider.createPullRequest({
      baseUrl: options.giteaUrl,
      token: giteaTokenForTenant(options, request.tenant, flag),
      repo: `${issue.owner}/${issue.repo}`,
      head: request.branch,
      base: prBaseBranch(request.baseBranch),
      title: request.title,
      body: request.body || workspacePullRequestBody(request),
    });
    return { index: pullRequest.index, url: pullRequest.url };
  };
}

export function maybeMergeReporter(options: IssueReporterOptions): ((summary: RunSummary, note?: string) => Promise<void>) | undefined {
  if (!options.giteaMerge) return undefined;
  const flag = controlPlaneReporterFlag(options, "merge");
  validateControlPlaneTokenEnvs(options, flag);
  const provider = issueReporterControlPlaneProvider(options);
  return async (summary: RunSummary, note?: string) => {
    if (!summary.metadata?.issue || !summary.metadata.pullRequestIndex) return;
    const issue = parseIssueRefForControlPlane(options, summary.metadata.issue);
    await provider.mergePullRequest({
      baseUrl: options.giteaUrl,
      token: giteaTokenForTenant(options, summary.metadata.tenant, flag),
      repo: `${issue.owner}/${issue.repo}`,
      index: summary.metadata.pullRequestIndex,
      method: "merge",
      title: `Merge Loom run ${summary.runId}`,
      message: note ?? `Approved Loom run ${summary.runId}.`,
    });
  };
}

export function workspacePullRequestBody(request: WorkspacePullRequestRequest): string {
  const requester = formatRunRequesterSummary({
    actor: request.actor,
    role: request.role,
    clientId: request.clientId,
  });
  const lines = [
    "Created by Loom workspace handoff.",
    "",
    `Project: ${request.tenant}/${request.project}`,
    requester ? `Requester: ${requester}` : "",
    request.runId ? `Run: ${request.runId}` : "",
    `Branch: ${request.branch}`,
    request.baseBranch ? `Base: ${request.baseBranch}` : "",
    request.commit ? `Commit: ${request.commit}` : "",
    request.issueUrl ? `Issue: ${request.issueUrl}` : `Issue: ${request.issue}`,
  ];
  return `${lines.filter(Boolean).join("\n")}\n`;
}
