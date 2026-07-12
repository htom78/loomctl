export const LOOM_API_VERSION = "v1" as const;

export const LOOM_CLIENT_CAPABILITIES = [
  "tenant-status",
  "project-list",
  "run-list",
  "run-create-idempotent",
  "run-events-sse",
  "run-replay",
  "run-comments",
  "run-control",
  "human-gates",
  "workspace-links",
] as const;

export type LoomClientCapability = typeof LOOM_CLIENT_CAPABILITIES[number];
export type RunStatus = "queued" | "running" | "paused" | "review_required" | "deployment_required" | "passed" | "failed" | "error" | "cancelled";

export interface LoomApiContract {
  version: string;
  capabilities: string[];
}

export interface TenantStatus {
  tenant: string;
  api: LoomApiContract;
  server: {
    startedAt: string;
    uptimeMs: number;
    runWorkspaceIsolation: "project" | "run";
    controlPlane?: { provider?: string };
  };
  readiness: {
    profile?: string;
    ok: boolean;
    missing: string[];
  };
  resources: {
    activeRuns: number;
    queuedRuns: number;
    activeWorkspaceSessions: number;
  };
  policy: { allowedTools: string[] };
}

export interface ProjectSummary {
  tenant?: string;
  project: string;
  latestRun?: RunSummary;
  runningRun?: RunSummary;
  queuedRuns?: RunSummary[];
  sourceDefaults?: {
    repo?: string;
    branch?: string;
    baseBranch?: string;
    issue?: string;
  };
  workspace?: {
    kind?: string;
    ideUrl?: string;
    previewUrl?: string;
  };
  [key: string]: unknown;
}

export interface RunSummary {
  tenant?: string;
  project?: string;
  runId: string;
  goal?: string;
  status: RunStatus | string;
  startedAt?: string;
  endedAt?: string;
  error?: { message?: string; kind?: string };
  metadata?: {
    dashboardUrl?: string;
    summaryUrl?: string;
    issueUrl?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface HarnessEvent {
  seq: number;
  at?: string;
  type: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkspaceInfo {
  tenant: string;
  project: string;
  runId?: string;
  route: "project" | "run";
  cwd: string;
  executor?: {
    kind: string;
    ideUrl?: string;
    previewUrl?: string;
    [key: string]: string | number | boolean | undefined;
  };
  [key: string]: unknown;
}

export interface CreateRunInput {
  tenant: string;
  project: string;
  goal: string;
  clientRequestId: string;
  script?: Array<Record<string, unknown>>;
  async?: boolean;
  queue?: boolean;
  model?: string;
  modelProtocol?: "json" | "tool-call";
  verify?: string[];
  skills?: string[];
  reviewRequired?: boolean;
  deploymentRequired?: boolean;
  allowedTools?: string[];
}

export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
}

export interface WatchRunEventsOptions {
  after?: number;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  signal?: AbortSignal;
  onEvent(event: HarnessEvent): void | Promise<void>;
  onReconnect?(after: number): void;
}

export class LoomApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "LoomApiError";
  }
}

export class LoomCapabilityError extends Error {
  constructor(readonly missing: string[]) {
    super(`Loom server is missing required capabilities: ${missing.join(", ")}`);
    this.name = "LoomCapabilityError";
  }
}

export interface LoomClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

export class LoomClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: LoomClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token.trim();
    if (!this.token) throw new Error("Loom API token is required");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async tenantStatus(tenant: string): Promise<TenantStatus> {
    return this.request(`/tenants/${segment(tenant)}/status`);
  }

  async negotiate(tenant: string, required: readonly string[] = LOOM_CLIENT_CAPABILITIES): Promise<TenantStatus> {
    const status = await this.tenantStatus(tenant);
    if (status.api?.version !== LOOM_API_VERSION) {
      throw new LoomApiError(`Unsupported Loom API version: ${status.api?.version ?? "missing"}`, 426, status.api);
    }
    const available = new Set(status.api.capabilities);
    const missing = required.filter((capability) => !available.has(capability));
    if (missing.length) throw new LoomCapabilityError(missing);
    return status;
  }

  async projects(tenant: string): Promise<ProjectSummary[]> {
    return this.request(`/tenants/${segment(tenant)}/projects`);
  }

  async runs(tenant: string, project: string): Promise<RunSummary[]> {
    return this.request(`/tenants/${segment(tenant)}/runs?project=${segment(project)}`);
  }

  async run(tenant: string, project: string, runId: string): Promise<RunSummary> {
    return this.request(`/tenants/${segment(tenant)}/runs/${segment(runId)}?project=${segment(project)}`);
  }

  async workspace(tenant: string, project: string, runId: string): Promise<WorkspaceInfo> {
    return this.request(`/tenants/${segment(tenant)}/runs/${segment(runId)}/workspace?project=${segment(project)}`);
  }

  async createRun(input: CreateRunInput): Promise<RunSummary> {
    return this.request("/runs", {
      method: "POST",
      body: JSON.stringify({ async: true, queue: true, ...input }),
    });
  }

  async comment(tenant: string, project: string, runId: string, message: string, clientId?: string): Promise<unknown> {
    return this.runAction(tenant, project, runId, "comments", { message, clientId });
  }

  async pause(tenant: string, project: string, runId: string, reason: string, clientId?: string): Promise<unknown> {
    return this.runAction(tenant, project, runId, "comments", { message: reason, pause: true, clientId });
  }

  async cancel(tenant: string, project: string, runId: string, reason?: string, clientId?: string): Promise<RunSummary> {
    return this.runAction(tenant, project, runId, "cancel", { reason, clientId });
  }

  async resume(tenant: string, project: string, runId: string, clientId?: string): Promise<RunSummary> {
    return this.runAction(tenant, project, runId, "resume", { clientId });
  }

  async review(tenant: string, project: string, runId: string, decision: "approved" | "rejected", clientId?: string): Promise<RunSummary> {
    return this.runAction(tenant, project, runId, "review", { decision, clientId });
  }

  async deployment(tenant: string, project: string, runId: string, decision: "approved" | "rejected", clientId?: string): Promise<RunSummary> {
    return this.runAction(tenant, project, runId, "deployment", { decision, clientId });
  }

  async events(tenant: string, project: string, runId: string, after = 0, signal?: AbortSignal): Promise<Response> {
    return this.fetchChecked(this.url(`/tenants/${segment(tenant)}/runs/${segment(runId)}/events/stream`, { project, after }), {
      headers: this.headers(),
      signal,
    });
  }

  async watchRunEvents(tenant: string, project: string, runId: string, options: WatchRunEventsOptions): Promise<number> {
    let after = options.after ?? 0;
    const reconnect = options.reconnect ?? true;
    do {
      const response = await this.events(tenant, project, runId, after, options.signal);
      if (!response.body) throw new LoomApiError("Loom event stream has no body", response.status);
      for await (const message of parseSseStream(response.body, options.signal)) {
        if (!message.data) continue;
        const event = parseHarnessEvent(message);
        if (event.seq <= after) continue;
        after = event.seq;
        await options.onEvent(event);
      }
      if (!reconnect || options.signal?.aborted) break;
      options.onReconnect?.(after);
      await abortableDelay(options.reconnectDelayMs ?? 500, options.signal);
    } while (!options.signal?.aborted);
    return after;
  }

  private async runAction<T>(tenant: string, project: string, runId: string, action: string, body: Record<string, unknown>): Promise<T> {
    return this.request(`/tenants/${segment(tenant)}/runs/${segment(runId)}/${action}?project=${segment(project)}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchChecked(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init.headers, init.body !== undefined),
    });
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private async fetchChecked(url: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(url, init);
    if (response.ok) return response;
    const body = await response.json().catch(() => undefined);
    const message = isRecord(body) && typeof body.error === "string" ? body.error : `Loom API request failed (${response.status})`;
    throw new LoomApiError(message, response.status, body);
  }

  private headers(input?: HeadersInit, json = false): Headers {
    const headers = new Headers(input);
    headers.set("authorization", `Bearer ${this.token}`);
    if (json && !headers.has("content-type")) headers.set("content-type", "application/json");
    return headers;
  }

  private url(path: string, query: Record<string, string | number>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return url.toString();
  }
}

export async function* parseSseStream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const message = parseSseBlock(block);
        if (message) yield message;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    const trailing = parseSseBlock(buffer);
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): SseMessage | undefined {
  if (!block.trim()) return undefined;
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { id, event, data: data.join("\n") } : undefined;
}

function parseHarnessEvent(message: SseMessage): HarnessEvent {
  const value: unknown = JSON.parse(message.data);
  if (!isRecord(value) || typeof value.seq !== "number" || typeof value.type !== "string") {
    throw new Error("Invalid Loom harness event");
  }
  return value as unknown as HarnessEvent;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Loom server URL must use http or https");
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function segment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Loom path value is required");
  return encodeURIComponent(trimmed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
