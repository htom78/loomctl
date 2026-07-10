import {
  AGENT_GIT_SERVICE_DISCOVERY_ENDPOINTS,
  AGENT_GIT_SERVICE_NATIVE_CAPABILITIES,
} from "./agent-git-service.js";

export interface ProbeAgentGitServiceContractOptions {
  baseUrl: string;
  token?: string;
  endpoints?: readonly string[];
  timeoutMs?: number;
}

export interface AgentGitServiceContractProbeEndpointResult {
  endpoint: string;
  url: string;
  ok: boolean;
  status?: number;
  semanticOk?: boolean;
  semanticErrors?: string[];
  error?: string;
}

export interface AgentGitServiceContractProbeResult {
  schemaVersion: "agent-git-service-contract-probe/v1";
  provider: "agent-git-service";
  apiBasePath: "/api/v3";
  readOnly: true;
  authorizationScheme: "Bearer";
  checkedAt: string;
  baseUrl: string;
  endpoints: AgentGitServiceContractProbeEndpointResult[];
  ok: boolean;
  missingEndpoints: string[];
  invalidEndpoints: string[];
  nativeCapabilities: string[];
  requestsTokenFree: true;
}

export interface CompareAgentGitServiceContractReportsOptions {
  baseline: AgentGitServiceContractProbeResult;
  candidate: AgentGitServiceContractProbeResult;
}

export interface AgentGitServiceContractEndpointMismatch {
  endpoint: string;
  baselineOk: boolean;
  candidateOk: boolean;
  baselineStatus?: number;
  candidateStatus?: number;
}

export interface AgentGitServiceContractReportSummary {
  schemaVersion: string;
  baseUrl: string;
  checkedAt: string;
  endpointCount: number;
  missingEndpoints: string[];
  invalidEndpoints: string[];
}

export interface AgentGitServiceContractComparisonResult {
  schemaVersion: "agent-git-service-contract-comparison/v1";
  ok: boolean;
  tokenFree: true;
  baseline: AgentGitServiceContractReportSummary;
  candidate: AgentGitServiceContractReportSummary;
  endpointMismatches: AgentGitServiceContractEndpointMismatch[];
  nativeCapabilities: {
    missing: string[];
    added: string[];
  };
  errors: string[];
}

const AGENT_GIT_SERVICE_API_BASE_PATH = "/api/v3";
const AGENT_GIT_SERVICE_CONTRACT_PROBE_SCHEMA_VERSION = "agent-git-service-contract-probe/v1";
const AGENT_GIT_SERVICE_CONTRACT_COMPARISON_SCHEMA_VERSION = "agent-git-service-contract-comparison/v1";

export async function probeAgentGitServiceContract(
  options: ProbeAgentGitServiceContractOptions,
): Promise<AgentGitServiceContractProbeResult> {
  const endpoints = [...(options.endpoints ?? AGENT_GIT_SERVICE_DISCOVERY_ENDPOINTS)];
  const results = await Promise.all(endpoints.map((endpoint) => probeAgentGitServiceEndpoint(options, endpoint)));
  const missingEndpoints = results.filter((result) => result.status === undefined || !isHttpOkStatus(result.status)).map((result) => result.endpoint);
  const invalidEndpoints = results.filter((result) => result.semanticOk === false).map((result) => result.endpoint);

  return {
    schemaVersion: AGENT_GIT_SERVICE_CONTRACT_PROBE_SCHEMA_VERSION,
    provider: "agent-git-service",
    apiBasePath: AGENT_GIT_SERVICE_API_BASE_PATH,
    readOnly: true,
    authorizationScheme: "Bearer",
    checkedAt: new Date().toISOString(),
    baseUrl: tokenFreeUrl(normalizedAgentGitServiceApiBaseUrl(options.baseUrl)),
    endpoints: results,
    ok: missingEndpoints.length === 0 && invalidEndpoints.length === 0,
    missingEndpoints,
    invalidEndpoints,
    nativeCapabilities: [...AGENT_GIT_SERVICE_NATIVE_CAPABILITIES],
    requestsTokenFree: true,
  };
}

export function compareAgentGitServiceContractReports(
  options: CompareAgentGitServiceContractReportsOptions,
): AgentGitServiceContractComparisonResult {
  const endpointMismatches = compareAgentGitServiceEndpoints(options.baseline, options.candidate);
  const nativeCapabilities = compareStringSets(options.baseline.nativeCapabilities, options.candidate.nativeCapabilities);
  const errors = [
    ...agentGitServiceReportCompatibilityErrors("baseline", options.baseline),
    ...agentGitServiceReportCompatibilityErrors("candidate", options.candidate),
    ...endpointMismatches.map((mismatch) => `endpoint ${mismatch.endpoint} drifted`),
    ...nativeCapabilities.missing.map((capability) => `candidate missing native capability ${capability}`),
  ];

  return {
    schemaVersion: AGENT_GIT_SERVICE_CONTRACT_COMPARISON_SCHEMA_VERSION,
    ok: errors.length === 0,
    tokenFree: true,
    baseline: agentGitServiceReportSummary(options.baseline),
    candidate: agentGitServiceReportSummary(options.candidate),
    endpointMismatches,
    nativeCapabilities,
    errors,
  };
}

async function probeAgentGitServiceEndpoint(
  options: ProbeAgentGitServiceContractOptions,
  endpoint: string,
): Promise<AgentGitServiceContractProbeEndpointResult> {
  const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const url = agentGitServiceProbeUrl(options.baseUrl, normalizedEndpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000);
  try {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
    };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    const semanticErrors = response.ok ? await agentGitServiceEndpointSemanticErrors(normalizedEndpoint, response) : [];
    const semanticOk = response.ok ? semanticErrors.length === 0 : undefined;
    return {
      endpoint: normalizedEndpoint,
      url: tokenFreeUrl(url),
      ok: response.ok && semanticErrors.length === 0,
      status: response.status,
      ...(semanticOk !== undefined ? { semanticOk } : {}),
      ...(semanticErrors.length ? { semanticErrors } : {}),
    };
  } catch (error) {
    return {
      endpoint: normalizedEndpoint,
      url: tokenFreeUrl(url),
      ok: false,
      error: tokenFreeErrorMessage(error, [options.token]),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function compareAgentGitServiceEndpoints(
  baseline: AgentGitServiceContractProbeResult,
  candidate: AgentGitServiceContractProbeResult,
): AgentGitServiceContractEndpointMismatch[] {
  const candidateByEndpoint = new Map(candidate.endpoints.map((endpoint) => [endpoint.endpoint, endpoint]));
  const mismatches: AgentGitServiceContractEndpointMismatch[] = [];
  for (const baselineEndpoint of baseline.endpoints) {
    const candidateEndpoint = candidateByEndpoint.get(baselineEndpoint.endpoint);
    if (!candidateEndpoint) {
      mismatches.push({
        endpoint: baselineEndpoint.endpoint,
        baselineOk: baselineEndpoint.ok,
        candidateOk: false,
        baselineStatus: baselineEndpoint.status,
      });
      continue;
    }
    if (baselineEndpoint.ok === candidateEndpoint.ok && baselineEndpoint.status === candidateEndpoint.status) {
      continue;
    }
    mismatches.push({
      endpoint: baselineEndpoint.endpoint,
      baselineOk: baselineEndpoint.ok,
      candidateOk: candidateEndpoint.ok,
      baselineStatus: baselineEndpoint.status,
      candidateStatus: candidateEndpoint.status,
    });
  }
  return mismatches;
}

function compareStringSets(baseline: readonly string[], candidate: readonly string[]): { missing: string[]; added: string[] } {
  const baselineSet = new Set(baseline);
  const candidateSet = new Set(candidate);
  return {
    missing: [...baselineSet].filter((item) => !candidateSet.has(item)).sort(),
    added: [...candidateSet].filter((item) => !baselineSet.has(item)).sort(),
  };
}

function agentGitServiceReportCompatibilityErrors(
  label: "baseline" | "candidate",
  report: AgentGitServiceContractProbeResult,
): string[] {
  return [
    report.schemaVersion === AGENT_GIT_SERVICE_CONTRACT_PROBE_SCHEMA_VERSION
      ? undefined
      : `${label} schemaVersion is ${report.schemaVersion}`,
    report.provider === "agent-git-service" ? undefined : `${label} provider is ${report.provider}`,
    report.apiBasePath === AGENT_GIT_SERVICE_API_BASE_PATH ? undefined : `${label} apiBasePath is ${report.apiBasePath}`,
    report.readOnly === true ? undefined : `${label} report is not read-only`,
    report.authorizationScheme === "Bearer" ? undefined : `${label} authorizationScheme is ${report.authorizationScheme}`,
    report.requestsTokenFree === true ? undefined : `${label} report is not token-free`,
  ].filter((item): item is string => Boolean(item));
}

function agentGitServiceReportSummary(report: AgentGitServiceContractProbeResult): AgentGitServiceContractReportSummary {
  return {
    schemaVersion: report.schemaVersion,
    baseUrl: report.baseUrl,
    checkedAt: report.checkedAt,
    endpointCount: report.endpoints.length,
    missingEndpoints: [...report.missingEndpoints],
    invalidEndpoints: [...(report.invalidEndpoints ?? [])],
  };
}

async function agentGitServiceEndpointSemanticErrors(endpoint: string, response: Response): Promise<string[]> {
  const body = await response.json().catch(() => undefined);
  const record = isRecord(body) ? body : undefined;
  if (!record) return ["response.jsonObject"];
  if (endpoint.endsWith("/rate_limit")) {
    return isRecord(record.resources) ? [] : ["rateLimit.resources"];
  }
  if (endpoint.endsWith("/meta")) {
    return hasAnyField(record, ["installed_version", "verifiable_password_authentication", "hooks", "git", "packages", "pages"])
      ? []
      : ["meta.discoveryFields"];
  }
  return hasAnyField(record, ["version", "current_user_url", "repository_url", "user_url", "organization_url"])
    ? []
    : ["apiRoot.discoveryFields"];
}

function hasAnyField(record: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.some((field) => record[field] !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function normalizedAgentGitServiceApiBaseUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = basePath.endsWith(AGENT_GIT_SERVICE_API_BASE_PATH)
    ? basePath
    : `${basePath}${AGENT_GIT_SERVICE_API_BASE_PATH}`;
  url.search = "";
  url.hash = "";
  return url;
}

function agentGitServiceProbeUrl(baseUrl: string, endpoint: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const rootPath = basePath.endsWith(AGENT_GIT_SERVICE_API_BASE_PATH)
    ? basePath.slice(0, -AGENT_GIT_SERVICE_API_BASE_PATH.length).replace(/\/+$/, "")
    : basePath;
  url.pathname = `${rootPath}${endpoint}`;
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url;
}

function tokenFreeUrl(url: URL): string {
  const safe = new URL(url);
  safe.username = "";
  safe.password = "";
  return safe.toString();
}

function tokenFreeErrorMessage(error: unknown, secrets: Array<string | undefined>): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message;
}
