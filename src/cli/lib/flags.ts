import { controlPlaneProviderCatalogEntry, SERVE_CONTROL_PLANE_PROVIDERS } from "../../harness/control-plane.js";
import { safeGitRef } from "../../harness/git-ref.js";
import { parseGiteaIssueRef } from "../../harness/gitea.js";
import { type ModelAgentProtocol } from "../../harness/model-agent.js";
import { type ProjectTemplateName } from "../../harness/project-templates.js";
import { type ControlPlaneProviderName } from "../../harness/server.js";
import { assertTenantName } from "../../tenant.js";
import { cfg } from "./context.js";
import { controlPlaneTokenEnv } from "./reporters.js";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const CONTROL_PLANE_PROVIDER_HELP = `control-plane provider: ${SERVE_CONTROL_PLANE_PROVIDERS.join("|")}`;

export const DEFAULT_GITEA_TOKEN_ENV = "LOOM_GITEA_TOKEN";

export const AGENT_GIT_SERVICE_URL_ENV = "LOOM_AGENT_GIT_SERVICE_URL";

export const DEFAULT_AGENT_GIT_SERVICE_TOKEN_ENV = "LOOM_AGENT_GIT_SERVICE_TOKEN";

export interface HarnessServeCliOptions {
  workspaceRoot: string;
  host: string;
  port: string;
  profile?: string;
  modelBaseUrl: string;
  modelKeyEnv: string;
  defaultModel: string;
  modelProtocol: string;
  executor: string;
  executorImage?: string;
  executorNetwork?: string;
  executorCpus?: string;
  executorMemory?: string;
  executorPidsLimit?: string;
  executorHomeRoot?: string;
  executorWorkspace?: string;
  executorRemoteCwd: string;
  executorWorktreeCwd?: string;
  executorTemplate?: string;
  executorTemplateParam: string[];
  executorIdeUrl?: string;
  executorPreviewUrl?: string;
  baseBranch: string;
  publicUrl?: string;
  operatorBundleDir?: string;
  stateBackend?: string;
  statePostgresUrlEnv?: string;
  statePostgresSchema?: string;
  stateRedisUrlEnv?: string;
  stateRedisPrefix?: string;
  stateProbeIntervalMs?: string;
  stateProbeTimeoutMs?: string;
  stateProbeMaxStalenessMs?: string;
  controlPlaneProvider: string;
  controlPlanePr?: boolean;
  controlPlaneMerge?: boolean;
  controlPlaneComment?: boolean;
  controlPlaneCommentSync?: boolean;
  controlPlaneWebhookSecretEnv?: string;
  controlPlaneUrl?: string;
  controlPlaneTokenEnv?: string;
  tenantControlPlaneTokenEnv?: string[];
  agentGitServiceTokenSecretRoot?: string;
  giteaPr: boolean;
  giteaMerge: boolean;
  giteaComment: boolean;
  giteaCommentSync: boolean;
  giteaWebhookSecretEnv?: string;
  giteaUrl: string;
  giteaTokenEnv: string;
  tenantGiteaTokenEnv?: string[];
  ingestBrain: boolean;
  allowShell: boolean;
  allowUnsafeLocalExecutor: boolean;
  allowTool: string[];
  tenantToken?: string[];
  tenantKey?: string[];
  tenantKeyEnv?: string[];
  oidcIssuer?: string;
  oidcAudience?: string;
  oidcJwksUrl?: string;
  oidcTenantClaim?: string;
  oidcActorClaim?: string;
  oidcRoleClaim?: string;
  oidcClockToleranceSeconds?: string;
  oidcRequestTimeoutMs?: string;
  oidcAllowInsecureHttp?: boolean;
  tenantModelKey?: string[];
  workspaceCommandTimeoutMs: string;
  maxWorkspaceSessions: string;
  maxTenantWorkspaceSessions?: string;
  maxTenantActiveRuns?: string;
  workspaceSessionIdleTimeoutMs: string;
  runLeaseTtlMs: string;
  autoAbandonStaleRuns: boolean;
  rateLimitRps?: string;
  rateLimitBurst?: string;
  rateLimitTrustedProxyHops?: string;
}

export interface HarnessControlPlanePreflightCliOptions {
  controlPlaneProvider: string;
  controlPlaneUrl?: string;
  controlPlaneTokenEnv?: string;
  report?: string;
}

export type HarnessOnlineProfileName = "online-sandbox" | "platform-readiness";

export async function writeJsonReportIfRequested(reportPath: string | undefined, value: unknown): Promise<void> {
  if (!reportPath) return;
  const resolved = resolve(reportPath);
  mkdirSync(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function controlPlanePreflightBaseUrl(
  options: HarnessControlPlanePreflightCliOptions,
  provider: ControlPlaneProviderName,
): string | undefined {
  if (options.controlPlaneUrl?.trim()) return normalizeHttpBaseUrl(options.controlPlaneUrl, "--control-plane-url");
  if (provider === "agent-git-service") {
    const url = process.env[AGENT_GIT_SERVICE_URL_ENV]?.trim();
    return url ? normalizeHttpBaseUrl(url, AGENT_GIT_SERVICE_URL_ENV) : undefined;
  }
  return normalizeHttpBaseUrl(cfg.giteaUrl, "--control-plane-url");
}

export function controlPlanePreflightTokenEnv(
  options: HarnessControlPlanePreflightCliOptions,
  provider: ControlPlaneProviderName,
): string {
  if (options.controlPlaneTokenEnv?.trim()) {
    return parseEnvNameFlag(options.controlPlaneTokenEnv, "--control-plane-token-env");
  }
  return provider === "agent-git-service" ? DEFAULT_AGENT_GIT_SERVICE_TOKEN_ENV : DEFAULT_GITEA_TOKEN_ENV;
}

export function controlPlanePreflightDiscoveryEndpointUrl(baseUrl: string, apiBasePath: string, endpoint: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const rootPath = basePath.endsWith(apiBasePath)
    ? basePath.slice(0, -apiBasePath.length).replace(/\/+$/, "")
    : basePath;
  url.pathname = `${rootPath}${endpoint}`;
  url.search = "";
  url.hash = "";
  return url;
}

export function preflightErrorMessage(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter((value) => value.length > 0)) {
    message = message.split(secret).join("[redacted]");
  }
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

export function isProjectDirectoryNameForDoctor(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== ".." && name !== ".loom";
}

export function isEnvName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function parseEnvNameFlag(value: string, flag: string): string {
  const name = value.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  console.error(`${flag} must be an environment variable name`);
  process.exit(2);
}

export function stringsOnly(values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string");
}

export function cliTokenValue(token: string | undefined, tokenEnv: string | undefined, tokenEnvFlag: string): string | undefined {
  if (tokenEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
      throw new Error(`${tokenEnvFlag} must be an environment variable name`);
    }
    const value = process.env[tokenEnv];
    if (!value) throw new Error(`${tokenEnvFlag} ${tokenEnv} is not set`);
    return value;
  }
  return token;
}

export function parseJsonResponse(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON response: ${boundedErrorText(text)}`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeHttpBaseUrl(value: string, flag: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    console.error(`${flag} must be an http or https URL.`);
    process.exit(2);
  }
}

export function parseProjectTemplateFlag(value: string, flag: string): ProjectTemplateName {
  if (value === "empty" || value === "vas-lite") return value;
  console.error(`${flag} must be one of: empty, vas-lite.`);
  process.exit(2);
}

export function parseOnlineProfileFlag(value: string | undefined, flag: string): HarnessOnlineProfileName | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "online-sandbox" || value === "platform-readiness") return value;
  console.error(`${flag} must be one of: online-sandbox, platform-readiness.`);
  process.exit(2);
}

export function parseControlPlaneProviderFlag(value: string, flag: string): ControlPlaneProviderName {
  const provider = value.trim();
  if (isServeControlPlaneProvider(provider)) return provider;
  const supported = SERVE_CONTROL_PLANE_PROVIDERS.join(", ");
  const catalogEntry = controlPlaneProviderCatalogEntry(provider);
  if (catalogEntry) {
    console.error(
      `${flag} serve-enabled providers: ${supported}. ${provider} is a ${catalogEntry.status} control-plane provider blocked by: ${catalogEntry.blockedBy.join(", ")}.`,
    );
  } else {
    console.error(`${flag} serve-enabled providers: ${supported}. Unknown control-plane provider: ${provider}.`);
  }
  process.exit(2);
}

export function isServeControlPlaneProvider(value: string): value is ControlPlaneProviderName {
  return (SERVE_CONTROL_PLANE_PROVIDERS as readonly string[]).includes(value);
}

export function parseSafeNameFlag(value: string, flag: string): string {
  const name = value.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name)) return name;
  console.error(`${flag} must match [A-Za-z0-9][A-Za-z0-9_.-]{0,62}`);
  process.exit(2);
}

export function boundedErrorText(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "<empty>";
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

export function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

export function parseTenantFlagName(value: string): string {
  try {
    return assertTenantName(value);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "tenant name is not safe");
    process.exit(2);
  }
}

export function parseModelProtocolFlag(value: string, flag: string): ModelAgentProtocol {
  if (value === "json" || value === "tool-call") return value;
  console.error(`${flag} must be one of: json, tool-call.`);
  process.exit(2);
}

export function parsePositiveIntFlag(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`${flag} must be a positive integer.`);
    process.exit(2);
  }
  return parsed;
}

export function parsePositiveNumberFlag(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`${flag} must be a positive number.`);
    process.exit(2);
  }
  return parsed;
}

export function optionalCliRepo(value: string | undefined): string | undefined {
  const repo = value?.trim();
  if (!repo) return undefined;
  if (repo.includes("\0") || repo.startsWith("-")) {
    console.error("--repo is not safe.");
    process.exit(2);
  }
  return repo;
}

export function cliGitRef(value: string, flag: string): string {
  try {
    return safeGitRef(value, flag);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(2);
  }
}

export function cliIssueRef(value: string, flag: string): string {
  const issue = value.trim();
  try {
    parseGiteaIssueRef(issue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${flag} ${message}`);
    process.exit(2);
  }
  return issue;
}

export function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
