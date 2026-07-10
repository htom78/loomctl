import { type AgentGitServiceContractProbeResult, probeAgentGitServiceContract } from "../../harness/agent-git-service-contract-probe.js";
import { type AgentStep } from "../../harness/agents.js";
import { type ControlPlaneProviderAdoptionStage, controlPlaneProviderCatalogEntry } from "../../harness/control-plane.js";
import { type WorkspaceDescription, type WorkspaceExecutor } from "../../harness/executor.js";
import { makeRunId } from "../../harness/loop.js";
import { createOpenAiCompatibleAgent, type ModelAgentProtocol } from "../../harness/model-agent.js";
import { type ControlPlaneProviderName, type HarnessWorkspaceContext } from "../../harness/server.js";
import { cfg } from "../lib/context.js";
import { type HarnessCutoverReportCliOptions, readHarnessCutoverReportViaHarness } from "../lib/cutover-report.js";
import { executorFactoryFromOptions, renderExecutorTemplate } from "../lib/executor.js";
import { cliGitRef, collect, compactObject, CONTROL_PLANE_PROVIDER_HELP, controlPlanePreflightBaseUrl, controlPlanePreflightDiscoveryEndpointUrl, controlPlanePreflightTokenEnv, type HarnessControlPlanePreflightCliOptions, isProjectDirectoryNameForDoctor, isRecord, normalizeHttpBaseUrl, optionalCliRepo, parseControlPlaneProviderFlag, parseEnvNameFlag, parseModelProtocolFlag, parseTenantFlagName, preflightErrorMessage, writeJsonReportIfRequested } from "../lib/flags.js";
import { Command } from "commander";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export function registerHarnessPreflightCommands(harness: Command): void {
harness
  .command("coder-preflight")
  .description("probe a real Coder workspace path before running the full platform smoke")
  .option("--workspace-root <path>", "tenant workspace root used for template context", process.cwd())
  .requiredOption("--tenant <tenant>", "tenant used to render executor templates")
  .requiredOption("--project <project>", "project used to render executor templates")
  .requiredOption("--executor-workspace <name>", "Coder workspace name or template")
  .option("--executor-remote-cwd <path>", "remote project cwd template", "/home/dev/projects/{project}")
  .option("--executor-worktree-cwd <path>", "remote run worktree cwd template")
  .option("--executor-template <name>", "Coder template to create missing tenant workspaces")
  .option("--executor-template-param <name=value>", "Coder template parameter for missing workspace creation; repeatable", collect, [] as string[])
  .option("--executor-cpus <count>", "Coder cpus template parameter")
  .option("--executor-memory <size>", "Coder memory_gb template parameter")
  .option("--executor-pids-limit <count>", "Coder pids_limit template parameter")
  .option("--executor-ide-url <url>", "browser IDE URL template")
  .option("--executor-preview-url <url>", "browser preview URL template")
  .option("--repo <url>", "repository URL to sync during prepare")
  .option("--branch <name>", "git branch template to check out after syncing --repo")
  .option("--base-branch <name>", "base git branch used when creating --branch", "origin/main")
  .action(async (opts: HarnessCoderPreflightCliOptions) => {
    const result = await runHarnessCoderPreflight(opts);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  });
harness
  .command("model-preflight")
  .description("probe a LiteLLM/OpenAI-compatible model gateway before running the full platform smoke")
  .option("--model-base-url <url>", "OpenAI-compatible base URL", cfg.gatewayUrl)
  .option("--model <name>", "OpenAI-compatible model name", cfg.models.default)
  .option("--model-key-env <name>", "env var containing the model API key", cfg.gatewayKeyEnv)
  .option("--model-protocol <protocol>", "model agent protocol: json|tool-call", "json")
  .action(async (opts: HarnessModelPreflightCliOptions) => {
    const result = await runHarnessModelPreflight(opts);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  });
harness
  .command("control-plane-preflight")
  .description("probe a Gitea/Forgejo or agent-git-service control-plane provider before running the full platform smoke")
  .option("--control-plane-provider <provider>", CONTROL_PLANE_PROVIDER_HELP, "gitea-forgejo")
  .option("--control-plane-url <url>", "control-plane base URL; agent-git-service also reads LOOM_AGENT_GIT_SERVICE_URL")
  .option("--control-plane-token-env <name>", "env var containing the control-plane token; agent-git-service defaults to LOOM_AGENT_GIT_SERVICE_TOKEN")
  .option("--report <path>", "write the token-free control-plane preflight JSON to this path")
  .action(async (opts: HarnessControlPlanePreflightCliOptions) => {
    const result = await runHarnessControlPlanePreflight(opts);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  });
}

export function registerHarnessCutoverReportCommand(harness: Command): void {
harness
  .command("cutover-report")
  .description("read a running harness server and summarize platform/AGS cutover readiness")
  .option("--url <url>", "harness server base URL", "http://127.0.0.1:8787")
  .requiredOption("--tenant <tenant>", "tenant to inspect")
  .option("--token <token>", "tenant API token; prefer --token-env for shared shells")
  .option("--token-env <name>", "env var containing the tenant API token")
  .option("--admin-token <token>", "tenant admin API token for admin-only readiness surfaces; prefer --admin-token-env")
  .option("--admin-token-env <name>", "env var containing the tenant admin API token")
  .option("--control-plane-provider <provider>", CONTROL_PLANE_PROVIDER_HELP)
  .option("--project <project>", "project used to generate machine-readable platform-readiness smoke args")
  .option("--template <template>", "project template used to generate machine-readable smoke args", "vas-lite")
  .option("--isolation-tenant <tenant>", "second tenant used to generate machine-readable smoke args")
  .option("--viewer-token-env <name>", "env var containing the viewer token used by generated smoke args")
  .option("--control-plane-webhook-secret-env <name>", "env var containing the control-plane webhook secret used by generated smoke args")
  .option("--report <path>", "write the token-free cutover report JSON to this path")
  .action(async (opts: HarnessCutoverReportCliOptions) => {
    try {
      const result = await readHarnessCutoverReportViaHarness(opts);
      await writeJsonReportIfRequested(opts.report, result);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
}

export interface HarnessCoderPreflightCliOptions {
  workspaceRoot: string;
  tenant: string;
  project: string;
  executorWorkspace: string;
  executorRemoteCwd: string;
  executorWorktreeCwd?: string;
  executorTemplate?: string;
  executorTemplateParam: string[];
  executorCpus?: string;
  executorMemory?: string;
  executorPidsLimit?: string;
  executorIdeUrl?: string;
  executorPreviewUrl?: string;
  repo?: string;
  branch?: string;
  baseBranch: string;
}

export interface HarnessCoderPreflightResult {
  ok: boolean;
  tenant: string;
  project: string;
  runId: string;
  executor?: WorkspaceDescription;
  checks: {
    configuration: HarnessCoderPreflightCheck;
    prepare: HarnessCoderPreflightCheck;
    remoteCommand: HarnessCoderPreflightCheck;
    browserUrls: HarnessCoderPreflightCheck & {
      ideUrl?: string;
      previewUrl?: string;
    };
  };
  missing: string[];
}

export interface HarnessCoderPreflightCheck {
  ok: boolean;
  required: true;
  error?: string;
  output?: string;
  missing?: string[];
}

export interface HarnessModelPreflightCliOptions {
  modelBaseUrl: string;
  model: string;
  modelKeyEnv: string;
  modelProtocol: string;
}

export interface HarnessModelPreflightResult {
  ok: boolean;
  baseUrl: string;
  model: string;
  protocol: ModelAgentProtocol;
  keyEnv: string;
  checks: {
    apiKey: HarnessModelPreflightCheck;
    chatCompletion: HarnessModelPreflightCheck;
    agentStep: HarnessModelPreflightCheck;
    modelUsage: HarnessModelPreflightCheck;
  };
  missing: string[];
  agentStep?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
}

export interface HarnessModelPreflightCheck {
  ok: boolean;
  required: true;
  error?: string;
}

export interface HarnessControlPlanePreflightResult {
  ok: boolean;
  tokenFree: true;
  reportPath?: string;
  provider: ControlPlaneProviderName;
  baseUrl?: string;
  tokenEnv: string;
  apiBasePath: string;
  boundary: string[];
  discoveryEndpoints: string[];
  nativeCapabilities: string[];
  adoptionStages: ControlPlaneProviderAdoptionStage[];
  compatibilityReport?: AgentGitServiceContractProbeResult;
  checks: {
    token: HarnessControlPlanePreflightCheck;
    discovery: HarnessControlPlanePreflightCheck;
  };
  discoveryResults: HarnessControlPlaneDiscoveryResult[];
  missing: string[];
}

export interface HarnessControlPlanePreflightCheck {
  ok: boolean;
  required: true;
  error?: string;
}

export interface HarnessControlPlaneDiscoveryResult {
  endpoint: string;
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export async function runHarnessCoderPreflight(options: HarnessCoderPreflightCliOptions): Promise<HarnessCoderPreflightResult> {
  const tenant = parseTenantFlagName(options.tenant);
  const project = parseProjectFlagName(options.project, "--project");
  const runId = makeRunId();
  const workspaceRoot = resolve(options.workspaceRoot);
  const cwd = join(workspaceRoot, tenant, project);
  const contextForBranch: HarnessWorkspaceContext = {
    tenant,
    project,
    runId,
    cwd,
  };
  const repo = optionalCliRepo(options.repo);
  const branch = options.branch
    ? cliGitRef(renderExecutorTemplate(options.branch, contextForBranch), "--branch")
    : undefined;
  const baseBranch = cliGitRef(options.baseBranch, "--base-branch");
  const context: HarnessWorkspaceContext = {
    ...contextForBranch,
    repo,
    branch,
    baseBranch,
  };
  const missing: string[] = [];
  let executor: WorkspaceExecutor | undefined;
  let executorDescription: WorkspaceDescription | undefined;
  const checks: HarnessCoderPreflightResult["checks"] = {
    configuration: { ok: false, required: true },
    prepare: { ok: false, required: true },
    remoteCommand: { ok: false, required: true },
    browserUrls: { ok: false, required: true },
  };

  try {
    const createExecutor = executorFactoryFromOptions({
      executor: "coder",
      executorWorkspace: options.executorWorkspace,
      executorRemoteCwd: options.executorRemoteCwd,
      executorWorktreeCwd: options.executorWorktreeCwd,
      executorTemplate: options.executorTemplate,
      executorTemplateParam: options.executorTemplateParam,
      executorCpus: options.executorCpus,
      executorMemory: options.executorMemory,
      executorPidsLimit: options.executorPidsLimit,
      executorIdeUrl: options.executorIdeUrl,
      executorPreviewUrl: options.executorPreviewUrl,
      branch,
      baseBranch,
    });
    executor = createExecutor?.(cwd, context);
    executorDescription = executor?.describeWorkspace?.();
    checks.configuration = { ok: Boolean(executor && executorDescription?.kind === "coder"), required: true };
  } catch (error) {
    checks.configuration = { ok: false, required: true, error: preflightErrorMessage(error) };
  }
  if (!checks.configuration.ok || !executor) {
    missing.push("coder-executor-configuration");
    return { ok: false, tenant, project, runId, executor: executorDescription, checks, missing };
  }

  try {
    await executor.prepare?.();
    checks.prepare = { ok: true, required: true };
  } catch (error) {
    checks.prepare = { ok: false, required: true, error: preflightErrorMessage(error) };
    missing.push("coder-workspace-prepare");
  }

  const browserUrlMissing = [
    executorDescription?.ideUrl ? undefined : "coder-browser-ide-url",
    executorDescription?.previewUrl ? undefined : "coder-browser-preview-url",
  ].filter((item): item is string => Boolean(item));
  checks.browserUrls = {
    ok: browserUrlMissing.length === 0,
    required: true,
    ideUrl: typeof executorDescription?.ideUrl === "string" ? executorDescription.ideUrl : undefined,
    previewUrl: typeof executorDescription?.previewUrl === "string" ? executorDescription.previewUrl : undefined,
    missing: browserUrlMissing.length ? browserUrlMissing : undefined,
  };
  missing.push(...browserUrlMissing);

  if (checks.prepare.ok) {
    try {
      const command = await executor.runCommand("printf loom-coder-preflight-ok", 120_000);
      const output = command.stdout.trim();
      if (command.exitCode === 0 && output === "loom-coder-preflight-ok") {
        checks.remoteCommand = { ok: true, required: true, output };
      } else {
        checks.remoteCommand = {
          ok: false,
          required: true,
          output,
          error: preflightCommandFailure(command),
        };
        missing.push("coder-remote-command");
      }
    } catch (error) {
      checks.remoteCommand = { ok: false, required: true, error: preflightErrorMessage(error) };
      missing.push("coder-remote-command");
    }
  } else {
    checks.remoteCommand = {
      ok: false,
      required: true,
      error: "skipped because Coder workspace prepare failed",
    };
    missing.push("coder-remote-command");
  }

  return {
    ok: missing.length === 0,
    tenant,
    project,
    runId,
    executor: executorDescription,
    checks,
    missing,
  };
}

export async function runHarnessModelPreflight(options: HarnessModelPreflightCliOptions): Promise<HarnessModelPreflightResult> {
  const baseUrl = normalizeHttpBaseUrl(options.modelBaseUrl, "--model-base-url");
  const model = parseModelNameFlag(options.model, "--model");
  const protocol = parseModelProtocolFlag(options.modelProtocol, "--model-protocol");
  const keyEnv = parseEnvNameFlag(options.modelKeyEnv, "--model-key-env");
  const apiKey = process.env[keyEnv];
  const missing: string[] = [];
  const checks: HarnessModelPreflightResult["checks"] = {
    apiKey: { ok: Boolean(apiKey), required: true },
    chatCompletion: { ok: false, required: true },
    agentStep: { ok: false, required: true },
    modelUsage: { ok: false, required: true },
  };
  let agentStep: Record<string, unknown> | undefined;
  let modelUsage: Record<string, unknown> | undefined;

  if (!apiKey) {
    missing.push("model-api-key");
    checks.chatCompletion = { ok: false, required: true, error: `skipped because ${keyEnv} is not set` };
    checks.agentStep = { ok: false, required: true, error: `skipped because ${keyEnv} is not set` };
    checks.modelUsage = { ok: false, required: true, error: `skipped because ${keyEnv} is not set` };
    return { ok: false, baseUrl, model, protocol, keyEnv, checks, missing };
  }

  const usageEvents: Record<string, unknown>[] = [];
  try {
    const agent = createOpenAiCompatibleAgent({
      baseUrl,
      model,
      protocol,
      apiKey,
      maxProtocolRepairAttempts: 0,
    });
    const step = await agent.next({
      goal: "loom model preflight",
      events: [
        {
          runId: makeRunId(),
          seq: 1,
          ts: new Date().toISOString(),
          type: "run_policy",
          data: { allowedTools: ["file.read", "file.write", "verify.run"] },
        },
      ],
      emitEvent: async (type, data) => {
        if (type === "model_usage") usageEvents.push(data);
      },
    });
    checks.chatCompletion = { ok: true, required: true };
    checks.agentStep = { ok: true, required: true };
    agentStep = modelPreflightAgentStep(step);
  } catch (error) {
    const message = preflightErrorMessage(error, [apiKey]);
    const kind = isRecord(error) && typeof error.kind === "string" ? error.kind : undefined;
    if (kind === "model_agent_protocol") {
      checks.chatCompletion = { ok: true, required: true };
      checks.agentStep = { ok: false, required: true, error: message };
      missing.push("model-agent-step");
    } else {
      checks.chatCompletion = { ok: false, required: true, error: message };
      checks.agentStep = { ok: false, required: true, error: "skipped because chat completion failed" };
      missing.push("model-chat-completion");
      missing.push("model-agent-step");
    }
  }

  modelUsage = usageEvents[0];
  if (modelUsage) {
    checks.modelUsage = { ok: true, required: true };
  } else {
    checks.modelUsage = { ok: false, required: true, error: "model response did not include usage or LiteLLM cost evidence" };
    missing.push("model-usage");
  }

  return {
    ok: missing.length === 0,
    baseUrl,
    model,
    protocol,
    keyEnv,
    checks,
    missing,
    agentStep,
    modelUsage,
  };
}

export function modelPreflightAgentStep(step: AgentStep): Record<string, unknown> {
  return compactObject({
    message: step.message,
    plan: step.plan,
    finish: step.finish,
    actionCount: step.actions?.length,
    actionTools: step.actions?.map((action) => action.toolName),
  });
}

export async function runHarnessControlPlanePreflight(
  options: HarnessControlPlanePreflightCliOptions,
): Promise<HarnessControlPlanePreflightResult> {
  const provider = parseControlPlaneProviderFlag(options.controlPlaneProvider, "--control-plane-provider");
  const catalogEntry = controlPlaneProviderCatalogEntry(provider);
  if (!catalogEntry) {
    console.error(`unknown control-plane provider: ${provider}`);
    process.exit(2);
  }
  const baseUrl = controlPlanePreflightBaseUrl(options, provider);
  const tokenEnv = controlPlanePreflightTokenEnv(options, provider);
  const token = process.env[tokenEnv];
  const missing = [
    baseUrl ? undefined : "control-plane-url",
    token ? undefined : "control-plane-token",
  ].filter((item): item is string => Boolean(item));
  const checks: HarnessControlPlanePreflightResult["checks"] = {
    token: {
      ok: Boolean(token),
      required: true,
      error: token ? undefined : `${tokenEnv} is not set`,
    },
    discovery: {
      ok: false,
      required: true,
      error: baseUrl ? undefined : "control-plane URL is not configured",
    },
  };
  let discoveryResults: HarnessControlPlaneDiscoveryResult[] = [];
  let compatibilityReport: AgentGitServiceContractProbeResult | undefined;
  if (baseUrl && token) {
    if (provider === "agent-git-service") {
      const probe = await probeAgentGitServiceContract({
        baseUrl,
        token,
        endpoints: catalogEntry.discoveryEndpoints,
      });
      compatibilityReport = probe;
      discoveryResults = probe.endpoints;
    } else {
      discoveryResults = await Promise.all(catalogEntry.discoveryEndpoints.map((endpoint) =>
        probeControlPlanePreflightDiscoveryEndpoint(provider, baseUrl, catalogEntry.apiBasePath, endpoint, token),
      ));
    }
    const failed = discoveryResults.filter((result) => !result.ok);
    checks.discovery = {
      ok: failed.length === 0,
      required: true,
      error: failed.length ? `failed discovery endpoints: ${failed.map((result) => result.endpoint).join(", ")}` : undefined,
    };
    if (failed.length) missing.push("control-plane-discovery");
  }

  const result: HarnessControlPlanePreflightResult = {
    ok: missing.length === 0,
    tokenFree: true,
    ...(options.report ? { reportPath: resolve(options.report) } : {}),
    provider,
    baseUrl,
    tokenEnv,
    apiBasePath: catalogEntry.apiBasePath,
    boundary: [...catalogEntry.boundary],
    discoveryEndpoints: [...catalogEntry.discoveryEndpoints],
    nativeCapabilities: [...catalogEntry.nativeCapabilities],
    adoptionStages: catalogEntry.adoptionStages.map((stage) => ({ ...stage, evidence: [...stage.evidence] })),
    ...(compatibilityReport ? { compatibilityReport } : {}),
    checks,
    discoveryResults,
    missing,
  };
  if (options.report) {
    const reportPath = resolve(options.report);
    mkdirSync(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}

export async function probeControlPlanePreflightDiscoveryEndpoint(
  provider: ControlPlaneProviderName,
  baseUrl: string,
  apiBasePath: string,
  endpoint: string,
  token: string,
): Promise<HarnessControlPlaneDiscoveryResult> {
  const url = controlPlanePreflightDiscoveryEndpointUrl(baseUrl, apiBasePath, endpoint);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: controlPlanePreflightAuthorizationHeader(provider, token),
      },
    });
    return {
      endpoint,
      url: url.toString(),
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    return {
      endpoint,
      url: url.toString(),
      ok: false,
      error: preflightErrorMessage(error, [token]),
    };
  }
}

export function controlPlanePreflightAuthorizationHeader(provider: ControlPlaneProviderName, token: string): string {
  return provider === "agent-git-service" ? `Bearer ${token}` : `token ${token}`;
}

export function preflightCommandFailure(result: { stdout: string; stderr: string; exitCode: number }): string {
  const detail = (result.stderr || result.stdout).trim();
  return detail || `remote command failed with exit code ${result.exitCode}`;
}

export function parseProjectFlagName(value: string, flag: string): string {
  const project = value.trim();
  if (!isProjectDirectoryNameForDoctor(project)) {
    console.error(`${flag} must contain only letters, numbers, dot, underscore, or dash, and must not be reserved.`);
    process.exit(2);
  }
  return project;
}

export function parseModelNameFlag(value: string, flag: string): string {
  const model = value.trim();
  if (!model || model.includes("\0") || model.length > 200) {
    console.error(`${flag} must be a non-empty model name.`);
    process.exit(2);
  }
  return model;
}
