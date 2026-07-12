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
  "workspace-files-cas",
  "workspace-sessions-sse",
  "collaborator-presence",
  "vas-review",
  "brain-signals",
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

export interface WorkspaceRoute {
  tenant: string;
  project: string;
  runId?: string;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size?: number;
  updatedAt?: string;
}

export type WorkspaceFileResponse =
  | { path: string; kind: "directory"; entries: WorkspaceFileEntry[] }
  | { path: string; kind: "file"; size: number; updatedAt: string; content: string; previousPath?: string };

export interface WorkspaceCommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: true;
  stderrTruncated?: true;
}

export interface WorkspaceCommandSummary extends WorkspaceCommandResult {
  commandId: string;
  tenant: string;
  project: string;
  runId?: string;
  route: "project" | "run";
  actor?: string;
  role?: string;
  clientId?: string;
  startedAt: string;
  endedAt: string;
}

export interface WorkspaceSessionSummary {
  sessionId: string;
  tenant: string;
  project: string;
  runId?: string;
  route: "project" | "run";
  command: string;
  actor?: string;
  role?: string;
  clientId?: string;
  status: "running" | "exited" | "orphaned";
  startedAt: string;
  lastActivityAt: string;
  idleExpiresAt?: string;
  endedAt?: string;
  eventCount: number;
  exitCode?: number;
  signal?: string;
}

export interface WorkspaceSessionEvent {
  seq: number;
  ts: string;
  type: "start" | "input" | "stop" | "stdout" | "stderr" | "exit";
  data?: string;
  dataBytes?: number;
  dataTruncated?: true;
  actor?: string;
  role?: string;
  clientId?: string;
  exitCode?: number;
  signal?: string;
}

export interface PresenceEntry {
  tenant: string;
  project: string;
  runId?: string;
  clientId: string;
  label: string;
  focus?: string;
  actor?: string;
  role?: string;
  seenAt: string;
  expiresAt: string;
}

export interface BrainSignalEntry {
  seq: number;
  ts: string;
  source: "completed_run" | "workspace_signal" | "workspace_conflict" | "vas_learning";
  actor?: string;
  role?: string;
  clientId?: string;
  project?: string;
  caseId?: string;
  runId?: string;
  operation?: string;
  path?: string;
  expectedUpdatedAt?: string;
  observedUpdatedAt?: string;
  activeEditorCount?: number;
  status?: string;
  outcome?: string;
  failureKind?: string;
  modelTotalTokens?: number;
  modelCostUsd?: number;
  learningCount?: number;
  skillCount?: number;
  [key: string]: unknown;
}

export interface BrainSignalFeed {
  tenant: string;
  count: number;
  signals: BrainSignalEntry[];
}

export interface VasCaseClaim {
  actor?: string;
  role?: string;
  clientId?: string;
  claimedAt: string;
}

export interface VasCaseSummary {
  id: string;
  status?: string;
  title?: string;
  path: string;
  reportPath?: string;
  reviewCount?: number;
  correctionCount?: number;
  learningCount?: number;
  runCount?: number;
  reviewedRunCount?: number;
  unreviewedRunCount?: number;
  latestRunId?: string;
  latestRunStatus?: string;
  claim?: VasCaseClaim;
  [key: string]: unknown;
}

export interface VasReviewQueueItem extends VasCaseSummary {
  reasons: Array<"needs_review" | "needs_revision" | "unreviewed_run">;
  links: Record<string, string>;
}

export interface VasReviewQueue {
  project: string;
  template: "vas-lite";
  cases: VasReviewQueueItem[];
}

export interface VasLearning {
  caseId: string;
  text: string;
  source?: string;
  reviewDecision?: "approved" | "changes_requested";
  reviewedAt?: string;
  actor?: string;
  role?: string;
  clientId?: string;
  runId?: string;
}

export interface VasLearningList {
  project: string;
  template: "vas-lite";
  learnings: VasLearning[];
}

export interface VasCaseArtifacts {
  project: string;
  template: "vas-lite";
  caseId: string;
  contextPath: string;
  reportPath: string;
  reviewDraftPath: string;
  context?: Record<string, unknown>;
  report?: string;
  reviewDraft?: Record<string, unknown>;
}

export interface VasReviewPackage {
  project: string;
  template: "vas-lite";
  caseId: string;
  case: VasCaseSummary;
  artifacts: VasCaseArtifacts;
  runs: Array<Record<string, unknown> & { runId: string; status: string }>;
  reviews: Record<string, unknown>[];
  corrections: Record<string, unknown>[];
  learnings: VasLearning[];
  issueCommentSeeds: Record<string, unknown>[];
  auditTrail: Record<string, unknown>[];
  links: Record<string, string>;
}

export interface VasReviewInput {
  decision: "approved" | "changes_requested";
  note?: string;
  corrections?: string[];
  learnings?: string[];
  runId?: string;
  clientId?: string;
}

export interface CreateVasCaseInput {
  caseId: string;
  title?: string;
  source?: unknown;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  issue?: string;
  clientId?: string;
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

  async createProject(tenant: string, project: string, template?: string): Promise<ProjectSummary> {
    return this.request(`/tenants/${segment(tenant)}/projects`, {
      method: "POST",
      body: JSON.stringify({ project, template }),
    });
  }

  async workspaceFiles(route: WorkspaceRoute, path = ""): Promise<WorkspaceFileResponse> {
    return this.request(this.workspacePath(route, "files", { path }));
  }

  async writeWorkspaceFile(route: WorkspaceRoute, path: string, content: string, baseUpdatedAt?: string, clientId?: string): Promise<WorkspaceFileResponse> {
    return this.request(this.workspacePath(route, "files"), {
      method: "POST",
      body: JSON.stringify({ path, content, baseUpdatedAt, clientId }),
    });
  }

  async moveWorkspaceFile(route: WorkspaceRoute, fromPath: string, toPath: string, baseUpdatedAt?: string, clientId?: string): Promise<WorkspaceFileResponse> {
    return this.request(this.workspacePath(route, "files/move"), {
      method: "POST",
      body: JSON.stringify({ fromPath, toPath, baseUpdatedAt, clientId }),
    });
  }

  async deleteWorkspaceFile(route: WorkspaceRoute, path: string, baseUpdatedAt?: string, clientId?: string): Promise<void> {
    await this.request(this.workspacePath(route, "files", { path }), {
      method: "DELETE",
      body: JSON.stringify({ baseUpdatedAt, clientId }),
    });
  }

  async workspaceDiff(route: WorkspaceRoute): Promise<WorkspaceCommandResult> {
    return this.request(this.workspacePath(route, "diff"));
  }

  async workspaceCommands(route: WorkspaceRoute): Promise<WorkspaceCommandSummary[]> {
    return this.request(this.workspacePath(route, "commands"));
  }

  async runWorkspaceCommand(route: WorkspaceRoute, command: string, clientId?: string, timeoutMs?: number): Promise<WorkspaceCommandSummary> {
    return this.request(this.workspacePath(route, "commands"), {
      method: "POST",
      body: JSON.stringify({ command, timeoutMs, clientId }),
    });
  }

  async workspaceSessions(route: WorkspaceRoute): Promise<WorkspaceSessionSummary[]> {
    return this.request(this.workspacePath(route, "sessions"));
  }

  async createWorkspaceSession(route: WorkspaceRoute, command: string, clientId?: string): Promise<WorkspaceSessionSummary> {
    return this.request(this.workspacePath(route, "sessions"), {
      method: "POST",
      body: JSON.stringify({ command, clientId }),
    });
  }

  async workspaceSessionEvents(route: WorkspaceRoute, sessionId: string, after = 0): Promise<WorkspaceSessionEvent[]> {
    return this.request(this.workspacePath(route, `sessions/${segment(sessionId)}/events`, { after }));
  }

  async sendWorkspaceSessionInput(route: WorkspaceRoute, sessionId: string, input: string, clientId?: string): Promise<{ sessionId: string; accepted: true }> {
    return this.request(this.workspacePath(route, `sessions/${segment(sessionId)}/input`), {
      method: "POST",
      body: JSON.stringify({ input, clientId }),
    });
  }

  async stopWorkspaceSession(route: WorkspaceRoute, sessionId: string, clientId?: string): Promise<{ sessionId: string; status: string }> {
    return this.request(this.workspacePath(route, `sessions/${segment(sessionId)}/stop`), {
      method: "POST",
      body: JSON.stringify({ clientId }),
    });
  }

  async watchWorkspaceSession(route: WorkspaceRoute, sessionId: string, options: Omit<WatchRunEventsOptions, "onEvent"> & { onEvent(event: WorkspaceSessionEvent): void | Promise<void> }): Promise<number> {
    return this.watchSequencedStream(
      (after) => this.workspaceSessionStream(route, sessionId, after, options.signal),
      options,
    );
  }

  async presence(route: WorkspaceRoute): Promise<PresenceEntry[]> {
    return this.request(this.workspacePath(route, "presence"));
  }

  async updatePresence(route: WorkspaceRoute, clientId: string, label: string, focus?: string): Promise<PresenceEntry> {
    return this.request(this.workspacePath(route, "presence"), {
      method: "POST",
      body: JSON.stringify({ clientId, label, focus }),
    });
  }

  async brainSignals(tenant: string, project?: string, runId?: string, after = 0, limit = 200): Promise<BrainSignalFeed> {
    return this.request(this.pathWithQuery(`/tenants/${segment(tenant)}/brain/signals`, { project, runId, after, limit }));
  }

  async vasReviewQueue(tenant: string, project: string): Promise<VasReviewQueue> {
    return this.request(this.vasPath(tenant, project, "review-queue"));
  }

  async createVasCase(tenant: string, project: string, input: CreateVasCaseInput): Promise<VasCaseSummary> {
    return this.request(this.vasPath(tenant, project, "cases"), {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async vasLearnings(tenant: string, project: string): Promise<VasLearningList> {
    return this.request(this.vasPath(tenant, project, "learnings"));
  }

  async vasCaseArtifacts(tenant: string, project: string, caseId: string): Promise<VasCaseArtifacts> {
    return this.request(this.vasPath(tenant, project, `cases/${segment(caseId)}/artifacts`));
  }

  async vasReviewPackage(tenant: string, project: string, caseId: string): Promise<VasReviewPackage> {
    return this.request(this.vasPath(tenant, project, `cases/${segment(caseId)}/review-package`));
  }

  async claimVasCase(tenant: string, project: string, caseId: string, action: "claim" | "release", clientId?: string): Promise<VasCaseSummary> {
    return this.request(this.vasPath(tenant, project, `cases/${segment(caseId)}/claim`), {
      method: "POST",
      body: JSON.stringify({ action, clientId }),
    });
  }

  async reviewVasCase(tenant: string, project: string, caseId: string, input: VasReviewInput): Promise<VasCaseSummary> {
    return this.request(this.vasPath(tenant, project, `cases/${segment(caseId)}/review`), {
      method: "POST",
      body: JSON.stringify(input),
    });
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
    return this.watchSequencedStream(
      (after) => this.events(tenant, project, runId, after, options.signal),
      options,
    );
  }

  private async watchSequencedStream<T extends { seq: number; type: string }>(
    open: (after: number) => Promise<Response>,
    options: Omit<WatchRunEventsOptions, "onEvent"> & { onEvent(event: T): void | Promise<void> },
  ): Promise<number> {
    let after = options.after ?? 0;
    const reconnect = options.reconnect ?? true;
    do {
      const response = await open(after);
      if (!response.body) throw new LoomApiError("Loom event stream has no body", response.status);
      for await (const message of parseSseStream(response.body, options.signal)) {
        if (!message.data) continue;
        const event = parseSequencedEvent<T>(message);
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

  private async workspaceSessionStream(route: WorkspaceRoute, sessionId: string, after: number, signal?: AbortSignal): Promise<Response> {
    return this.fetchChecked(`${this.baseUrl}${this.workspacePath(route, `sessions/${segment(sessionId)}/events/stream`, { after })}`, {
      headers: this.headers(),
      signal,
    });
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

  private workspacePath(route: WorkspaceRoute, leaf: string, query: Record<string, string | number | undefined> = {}): string {
    const root = route.runId
      ? `/tenants/${segment(route.tenant)}/runs/${segment(route.runId)}`
      : `/tenants/${segment(route.tenant)}/projects/${segment(route.project)}`;
    return this.pathWithQuery(`${root}/${leaf}`, route.runId ? { project: route.project, ...query } : query);
  }

  private vasPath(tenant: string, project: string, leaf: string): string {
    return `/tenants/${segment(tenant)}/projects/${segment(project)}/vas/${leaf}`;
  }

  private pathWithQuery(path: string, query: Record<string, string | number | undefined>): string {
    const values = Object.entries(query).filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== "");
    if (!values.length) return path;
    const search = new URLSearchParams(values.map(([key, value]) => [key, String(value)]));
    return `${path}?${search.toString()}`;
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

function parseSequencedEvent<T extends { seq: number; type: string }>(message: SseMessage): T {
  const value: unknown = JSON.parse(message.data);
  if (!isRecord(value) || typeof value.seq !== "number" || typeof value.type !== "string") {
    throw new Error("Invalid Loom harness event");
  }
  return value as T;
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
