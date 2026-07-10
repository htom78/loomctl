import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { type Dirent } from "node:fs";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { type TenantAuditAppender, type TenantAuditEvent } from "../audit.js";
import { type RunRequester } from "../loop.js";
import { tenantApiKeyMatches, type TenantApiKey } from "../server-auth.js";
import { type QueuedRunStatus, type RunningRunStatus } from "../run-state.js";
import type { HarnessEvent, RunMetadata, RunSummary } from "../events.js";
import { parseGiteaIssueRef } from "../gitea.js";
import { RunRequestBody, RunReplayEntry, publicRunRequester, runEvidenceUrl, recordRunExternalEffect, markRunError, runRequesterSummaryField, runAgentMetadata } from "./runs.js";
import { workspacePullRequestRef } from "./workspace.js";
import { controlPlaneProviderName } from "./status.js";
import { projectModelUsageRequesterKey, projectModelUsageRequesterLabel, readProjectSummary, projectContractPatchField } from "./projects.js";
import { TenantAccess, brainSignalAuditData, tenantRoleField, readTenantPolicy, tenantPolicyFromUnknown, isSafeTenantDirectoryName, requireTenantRole, tenantRoleRank } from "./tenants.js";
import { HarnessServerOptions, readJsonBody } from "./http.js";


interface CancelRequestBody {
  reason?: unknown;
  clientId?: unknown;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enforceModelUsageTokenLimitsForBody(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenant: string,
  project: string,
  body: RunRequestBody,
  requester: RunRequester | undefined,
): Promise<void> {
  if (runAgentMetadata(body, options).agentMode !== "model") return;
  await enforceModelUsageTokenLimits(workspaceRoot, options, tenant, project, requester);
}

async function enforceModelUsageTokenLimits(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenant: string,
  project: string,
  requester: RunRequester | undefined,
): Promise<void> {
  const policyLimits = (await readTenantPolicy(workspaceRoot, tenant, options))?.limits;
  const projectTokenLimit = policyLimits?.modelProjectTotalTokenLimit;
  const requesterTokenLimit = policyLimits?.modelRequesterTotalTokenLimit;
  const projectCostLimit = policyLimits?.modelProjectCostUsdLimit;
  const requesterCostLimit = policyLimits?.modelRequesterCostUsdLimit;
  if (
    projectTokenLimit === undefined &&
    requesterTokenLimit === undefined &&
    projectCostLimit === undefined &&
    requesterCostLimit === undefined
  ) return;

  const summary = await readProjectSummary(join(workspaceRoot, tenant), tenant, project, policyLimits);
  const projectTokens = summary.modelUsage?.totalTokens ?? 0;
  if (projectTokenLimit !== undefined && projectTokens >= projectTokenLimit) {
    throw conflict(`project model token limit exceeded: ${projectTokens} >= ${projectTokenLimit}`);
  }
  const projectCostUsd = summary.modelUsage?.costUsd ?? 0;
  if (projectCostLimit !== undefined && projectCostUsd >= projectCostLimit) {
    throw conflict(`project model cost limit exceeded: ${projectCostUsd} >= ${projectCostLimit}`);
  }

  if (requesterTokenLimit === undefined && requesterCostLimit === undefined) return;
  const publicRequester = publicRunRequester(requester) ?? {};
  const requesterKey = projectModelUsageRequesterKey(publicRequester);
  const requesterUsage = (summary.modelUsageByRequester ?? [])
    .find((entry) => projectModelUsageRequesterKey(entry.requester) === requesterKey);
  const requesterTokens = requesterUsage?.totalTokens ?? 0;
  if (requesterTokenLimit !== undefined && requesterTokens >= requesterTokenLimit) {
    throw conflict(`requester model token limit exceeded for ${projectModelUsageRequesterLabel(publicRequester)}: ${requesterTokens} >= ${requesterTokenLimit}`);
  }
  const requesterCostUsd = requesterUsage?.costUsd ?? 0;
  if (requesterCostLimit !== undefined && requesterCostUsd >= requesterCostLimit) {
    throw conflict(`requester model cost limit exceeded for ${projectModelUsageRequesterLabel(publicRequester)}: ${requesterCostUsd} >= ${requesterCostLimit}`);
  }
}

function markdownInlineCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function optionalSessionEventString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalSessionEventNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function optionalSessionEventRole(value: unknown): boolean {
  return value === undefined || value === "admin" || value === "developer" || value === "viewer";
}

function hasRequestValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function hasExplicitAgent(body: RunRequestBody): boolean {
  return body.script !== undefined || body.agentCommand !== undefined || body.model !== undefined;
}

function textArray(value: unknown, field: string): string[] {
  return stringArray(value, field).map((item) => item.trim()).filter(Boolean);
}

function recordArray(value: unknown, field: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
    throw badRequest(`${field} must be an array of objects.`);
  }
  return value as Record<string, unknown>[];
}

async function readOptionalJsonObject(path: string, field: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    throw badRequest(`${field} must be an object.`);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    if (error instanceof SyntaxError) throw badRequest(`${field} has invalid JSON.`);
    throw error;
  }
}

async function readOptionalTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function oneLineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compactStringList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function optionalSourceRepo(value: unknown, fallback?: string): string | undefined {
  const repo = (optionalString(value, "repo") ?? fallback)?.trim();
  if (!repo) return undefined;
  if (repo.includes("\0") || repo.startsWith("-")) {
    throw badRequest("repo is not safe.");
  }
  return repo;
}

function optionalSourceGitRef(value: unknown, field: "branch" | "baseBranch", fallback?: string): string | undefined {
  return workspacePullRequestRef(value, fallback, field, true);
}

function optionalSourceIssue(value: unknown, fallback?: string): string | undefined {
  const issue = (optionalString(value, "issue") ?? fallback)?.trim();
  if (!issue) return undefined;
  try {
    parseGiteaIssueRef(issue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw badRequest(message);
  }
  return issue;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function compactMetadata(metadata: RunMetadata): RunMetadata {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)) as RunMetadata;
}

async function reportIssue(options: HarnessServerOptions, summary: RunSummary): Promise<RunSummary> {
  if (summary.status === "cancelled" || summary.status === "paused") return summary;
  if (!summary.metadata?.issue || !options.issueReporter) return summary;
  try {
    await options.issueReporter(summary);
    return recordRunExternalEffect(summary, {
      kind: "issue_comment",
      controlPlaneProvider: controlPlaneProviderName(options),
      issue: summary.metadata.issue,
      issueUrl: summary.metadata.issueUrl,
      dashboardUrl: summary.metadata.dashboardUrl,
      summaryUrl: summary.metadata.summaryUrl,
      reviewSummaryUrl: summary.metadata.summaryUrl ? runEvidenceUrl(summary.metadata.summaryUrl, "review-summary") : undefined,
      handoffPackageUrl: summary.metadata.summaryUrl ? runEvidenceUrl(summary.metadata.summaryUrl, "handoff-package") : undefined,
      handoffFollowupsUrl: summary.metadata.summaryUrl ? runEvidenceUrl(summary.metadata.summaryUrl, "handoff-runs") : undefined,
    }, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markRunError(summary, `issue reporter failed: ${message}`, options);
  }
}

async function reportPullRequest(
  options: HarnessServerOptions,
  summary: RunSummary,
  pullRequestRequested: boolean,
): Promise<RunSummary> {
  if (!pullRequestRequested || !options.pullRequestReporter) return summary;
  if (summary.status !== "passed" && summary.status !== "review_required" && summary.status !== "deployment_required") return summary;
  try {
    const result = await options.pullRequestReporter(summary);
    const withPullRequest = result ? {
      ...summary,
      metadata: {
        ...summary.metadata,
        pullRequestIndex: result.index,
        pullRequestUrl: result.url,
      },
    } : summary;
    return recordRunExternalEffect(withPullRequest, {
      kind: "pull_request",
      controlPlaneProvider: controlPlaneProviderName(options),
      issue: withPullRequest.metadata?.issue,
      issueUrl: withPullRequest.metadata?.issueUrl,
      branch: withPullRequest.metadata?.branch,
      baseBranch: withPullRequest.metadata?.baseBranch,
      pullRequestIndex: withPullRequest.metadata?.pullRequestIndex,
      pullRequestUrl: withPullRequest.metadata?.pullRequestUrl,
      dashboardUrl: withPullRequest.metadata?.dashboardUrl,
      summaryUrl: withPullRequest.metadata?.summaryUrl,
      reviewSummaryUrl: withPullRequest.metadata?.summaryUrl ? runEvidenceUrl(withPullRequest.metadata.summaryUrl, "review-summary") : undefined,
      handoffPackageUrl: withPullRequest.metadata?.summaryUrl ? runEvidenceUrl(withPullRequest.metadata.summaryUrl, "handoff-package") : undefined,
      handoffFollowupsUrl: withPullRequest.metadata?.summaryUrl ? runEvidenceUrl(withPullRequest.metadata.summaryUrl, "handoff-runs") : undefined,
    }, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markRunError(summary, `pull request reporter failed: ${message}`, options);
  }
}

async function reportBrainIngest(
  options: HarnessServerOptions,
  summary: RunSummary,
  appendAuditEvent?: TenantAuditAppender,
): Promise<RunSummary> {
  if (!options.brainIngest || summary.status === "cancelled" || summary.status === "paused") return summary;
  try {
    await options.brainIngest(summary);
    const data = brainSignalAuditData(summary);
    if (appendAuditEvent && summary.metadata?.tenant) {
      await appendAuditEvent(summary.metadata.tenant, "brain_signal_ingested", data);
    }
    return recordRunExternalEffect(summary, {
      kind: "brain_ingest",
      ...data,
      skills: summary.skills,
    }, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markRunError(summary, `brain ingest failed: ${message}`, options);
  }
}

async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tempPath, path);
}

function seqAfter(url: URL, req?: IncomingMessage): number {
  const query = url.searchParams.get("after");
  const header = req?.headers["last-event-id"];
  const raw = header !== undefined ? header : query;
  if (Array.isArray(raw)) throw badRequest("after must be a non-negative integer.");
  if (raw === null || raw === "") return 0;
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw badRequest("after must be a non-negative integer.");
  }
  return parsed;
}

function filterEvents(events: HarnessEvent[], after: number): HarnessEvent[] {
  return events.filter((event) => event.seq > after);
}

function boundedDiagnosticText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function isSensitiveDiagnosticKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /(token|secret|password|authorization|cookie|apikey|accesskey|privatekey)/.test(normalized);
}

function latestAuditData(events: TenantAuditEvent[], type: TenantAuditEvent["type"]): Record<string, unknown> {
  const event = [...events].reverse().find((entry) => entry.type === type);
  return recordData(event?.data);
}

function replayEntryFromEvent(event: HarnessEvent): RunReplayEntry {
  const data = recordData(event.data);
  return compactReplayEntry({
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    title: replayTitle(event, data),
    detail: replayDetail(data),
    requester: runRequesterSummaryField(data, "requester"),
    actor: stringField(data, "actor"),
    role: tenantRoleField(data, "role"),
    clientId: stringField(data, "clientId"),
    toolName: stringField(data, "toolName"),
    actionId: stringField(data, "actionId") ?? stringField(data, "id"),
    ok: booleanField(data, "ok"),
    status: stringField(data, "status"),
    iteration: numberField(data, "iteration"),
    actionCount: numberField(data, "actionCount"),
    finishRequested: booleanField(data, "finishRequested"),
    phase: stringField(data, "phase"),
    plan: stringField(data, "plan"),
    contractPatch: projectContractPatchField(data, "contractPatch"),
    runReviewContractPatch: projectContractPatchField(data, "runReviewContractPatch"),
  });
}

function replayTitle(event: HarnessEvent, data: Record<string, unknown>): string {
  if (event.type === "user_message") return `User: ${replayText(data.content) ?? replayText(data.goal) ?? "message"}`;
  if (event.type === "assistant_message") {
    const iteration = numberField(data, "iteration");
    return iteration === undefined ? "Assistant message" : `Assistant message ${iteration}`;
  }
  if (event.type === "action") return `Tool action: ${stringField(data, "toolName") ?? "unknown"}`;
  if (event.type === "observation") {
    const toolName = stringField(data, "toolName") ?? "unknown";
    return `Observation: ${toolName} ${booleanField(data, "ok") === false ? "failed" : "passed"}`;
  }
  if (event.type === "verification") return `Verification ${booleanField(data, "ok") === false ? "failed" : "passed"}`;
  if (event.type === "evaluation") return `Evaluation ${booleanField(data, "ok") === false ? "failed" : "passed"}`;
  if (event.type === "reviewer") return `Reviewer ${booleanField(data, "ok") === false ? "flagged" : "passed"}`;
  if (event.type === "finish") return `Finish: ${stringField(data, "status") ?? "unknown"}`;
  if (event.type === "workspace_prepare") return `Workspace prepare: ${stringField(data, "status") ?? "unknown"}`;
  if (event.type === "review_gate") return `Review: ${stringField(data, "status") ?? "unknown"}`;
  if (event.type === "review_claim") return `Review claim: ${stringField(data, "action") ?? "unknown"}`;
  if (event.type === "deployment_gate") return `Deployment: ${stringField(data, "status") ?? "unknown"}`;
  if (event.type === "external_effect") return `External effect: ${stringField(data, "kind") ?? "unknown"}`;
  if (event.type === "agent_retry") return `Agent retry: ${stringField(data, "kind") ?? "unknown"}`;
  if (event.type === "model_usage") return `Model usage: ${stringField(data, "model") ?? stringField(data, "responseModel") ?? "unknown"}`;
  if (event.type === "run_metadata") return "Run metadata";
  if (event.type === "run_policy") return "Run policy";
  if (event.type === "resume") return "Resume";
  if (event.type === "pause") return "Pause";
  if (event.type === "cancel") return "Cancel";
  if (event.type === "error") return "Error";
  return event.type;
}

function replayDetail(data: Record<string, unknown>): string | undefined {
  const detail =
    replayText(data.content) ??
    replayText(data.message) ??
    replayText(data.output) ??
    replayText(data.error) ??
    replayText(data.reason) ??
    replayText(data.note) ??
    undefined;
  const plan = replayText(data.plan);
  const retry = replayRetryDetail(data);
  const modelUsage = replayModelUsageDetail(data);
  const diagnostics = replayDiagnosticDetail(data);
  const lines = [
    detail,
    plan ? `plan: ${plan}` : undefined,
    retry,
    modelUsage,
    diagnostics,
  ].filter((line): line is string => Boolean(line));
  if (lines.length) return lines.join("\n");
  return Object.keys(data).length ? replayText(JSON.stringify(data)) : undefined;
}

function replayText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function replayDiagnosticDetail(data: Record<string, unknown>): string | undefined {
  const kind = replayText(data.kind);
  const details = replayDiagnosticDetails(data.details);
  const lines = [
    kind ? `kind=${kind}` : undefined,
    details ? `details=${details}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return lines.length ? lines.join("\n") : undefined;
}

function replayModelUsageDetail(data: Record<string, unknown>): string | undefined {
  const lines = [
    stringField(data, "requestId") ? `requestId=${stringField(data, "requestId")}` : undefined,
    stringField(data, "responseModel") ? `responseModel=${stringField(data, "responseModel")}` : undefined,
    numberField(data, "promptTokens") === undefined ? undefined : `promptTokens=${numberField(data, "promptTokens")}`,
    numberField(data, "completionTokens") === undefined ? undefined : `completionTokens=${numberField(data, "completionTokens")}`,
    numberField(data, "totalTokens") === undefined ? undefined : `totalTokens=${numberField(data, "totalTokens")}`,
    numberField(data, "costUsd") === undefined ? undefined : `costUsd=${numberField(data, "costUsd")}`,
    numberField(data, "attempt") === undefined ? undefined : `attempt=${numberField(data, "attempt")}`,
  ].filter((line): line is string => Boolean(line));
  return lines.length ? lines.join("\n") : undefined;
}

function replayRetryDetail(data: Record<string, unknown>): string | undefined {
  const attempt = numberField(data, "attempt");
  const nextAttempt = numberField(data, "nextAttempt");
  const lines = [
    attempt === undefined ? undefined : `attempt=${attempt}`,
    nextAttempt === undefined ? undefined : `nextAttempt=${nextAttempt}`,
  ].filter((line): line is string => Boolean(line));
  return lines.length ? lines.join("\n") : undefined;
}

function replayDiagnosticDetails(value: unknown): string | undefined {
  const details = recordData(value);
  const pairs = Object.entries(details).map(([key, entry]) => `${key}=${replayDiagnosticValue(entry)}`);
  return pairs.length ? replayText(pairs.join(" ")) : undefined;
}

function replayDiagnosticValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? String(value);
}

function recordData(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

function booleanField(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberField(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayField(data: Record<string, unknown>, key: string): string[] | undefined {
  const value = data[key];
  return Array.isArray(value) && value.length && value.every((item) => typeof item === "string") ? value : undefined;
}

	function stringArrayFieldAllowEmpty(data: Record<string, unknown>, key: string): string[] | undefined {
	  const value = data[key];
	  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
	}

function compactReplayEntry(entry: RunReplayEntry): RunReplayEntry {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as RunReplayEntry;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

async function requireServerStatusAccess(
  req: IncomingMessage,
  workspaceRoot: string,
  options: HarnessServerOptions,
  url?: URL,
): Promise<TenantAccess | undefined> {
  const keys = await serverStatusAccessKeys(workspaceRoot, options);
  const oidc = options.oidcAuthenticator;
  if (keys.length === 0 && !oidc) return undefined;

  const headerCredential =
    bearerToken(req.headers.authorization) ??
    headerValue(req.headers["x-loom-tenant-token"]);
  const provided = headerCredential ?? streamQueryToken(url);
  const matches = keys
    .filter((key) => tenantApiKeyMatches(key, provided))
    .sort((a, b) => tenantRoleRank(b.role) - tenantRoleRank(a.role));
  const key = matches[0];
  if (key) {
    const access = { actor: key.actor, role: key.role };
    requireTenantRole(access, "admin");
    return access;
  }

  if (oidc && headerCredential) {
    let identity;
    try {
      identity = await oidc.authenticate(headerCredential);
    } catch {
      throw unauthorized("invalid tenant token");
    }
    const access = { actor: identity.actor, role: identity.role };
    requireTenantRole(access, "admin");
    return access;
  }

  throw unauthorized("invalid tenant token");
}

function streamQueryToken(url: URL | undefined): string | undefined {
  if (!url?.pathname.endsWith("/stream")) return undefined;
  return url.searchParams.get("token") ?? undefined;
}

function safeEqualString(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function serverStatusAccessKeys(workspaceRoot: string, options: HarnessServerOptions): Promise<TenantApiKey[]> {
  const legacyKeys = Object.entries(options.tenantTokens ?? {})
    .filter(([tenant]) => isSafeTenantDirectoryName(tenant))
    .map(([, token]) => ({
      token,
      actor: "legacy-token",
      role: "admin" as const,
    }));
  const configuredKeys = Object.entries(options.tenantApiKeys ?? {})
    .filter(([tenant]) => isSafeTenantDirectoryName(tenant))
    .flatMap(([, keys]) => keys);
  const policyKeys = await policyStatusAccessKeys(workspaceRoot, options);
  return [...legacyKeys, ...configuredKeys, ...policyKeys];
}

async function policyStatusAccessKeys(workspaceRoot: string, options: HarnessServerOptions): Promise<TenantApiKey[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) entries = [];
    else throw error;
  }

  const keys: TenantApiKey[] = [];
  const storedTenants = new Set<string>();
  for (const document of await options.stateBackend?.documents.list<unknown>("tenant-policy") ?? []) {
    if (!isSafeTenantDirectoryName(document.key)) continue;
    storedTenants.add(document.key);
    keys.push(...(tenantPolicyFromUnknown(document.value).apiKeys ?? []));
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeTenantDirectoryName(entry.name)) continue;
    if (storedTenants.has(entry.name)) continue;
    const policy = await readTenantPolicy(workspaceRoot, entry.name, options);
    keys.push(...(policy?.apiKeys ?? []));
  }
  return keys;
}

function bearerToken(value: string | string[] | undefined): string | undefined {
  const header = headerValue(value);
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

async function readJson(req: IncomingMessage): Promise<RunRequestBody> {
  return readJsonBody<RunRequestBody>(req);
}

function requireSafeName(value: unknown, field: string): string {
  const name = requireString(value, field);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw badRequest(`${field} must contain only letters, numbers, dot, underscore, or dash.`);
  }
  if (field === "project" && name === ".loom") {
    throw badRequest(`${field} is reserved.`);
  }
  return name;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalSafeName(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireSafeName(value, field);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw badRequest(`${field} is required.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireString(value, field);
}

function optionalSha256Hex(value: unknown, field: string): string | undefined {
  const text = optionalString(value, field)?.trim().toLowerCase();
  if (!text) return undefined;
  if (!/^[a-f0-9]{64}$/.test(text)) throw badRequest(`${field} must be a lowercase sha256 hex string.`);
  return text;
}

async function optionalFileSha256(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(path, "utf8"), "utf8").digest("hex");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "boolean") throw badRequest(`${field} must be a boolean.`);
  return value;
}

function optionalClientId(value: unknown): string | undefined {
  const clientId = optionalString(value, "clientId")?.trim();
  if (clientId === undefined) return undefined;
  if (clientId.length > 120 || /[\0\r\n]/.test(clientId)) {
    throw badRequest("clientId must be a single-line string at most 120 characters.");
  }
  return clientId;
}

function optionalClientRequestId(value: unknown): string | undefined {
  const clientRequestId = optionalString(value, "clientRequestId")?.trim();
  if (clientRequestId === undefined) return undefined;
  if (clientRequestId.length > 200 || /[\0\r\n]/.test(clientRequestId)) {
    throw badRequest("clientRequestId must be a single-line string at most 200 characters.");
  }
  return clientRequestId;
}

function isSafeDirectoryName(name: string): boolean {
  try {
    requireSafeName(name, "name");
    return true;
  } catch {
    return false;
  }
}

function timingSafeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function envNameValue(value: unknown, field: string): string {
  const name = requireString(value, field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw badRequest(`${field} must be an environment variable name.`);
  }
  return name;
}

function optionalEnvNameValue(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const name = requireString(value, field).trim();
  return name ? envNameValue(name, field) : undefined;
}

const SECRET_BEARING_TEMPLATE_PARAMETER_PARTS = new Set(["token", "key", "secret", "password"]);

function templateParameterValue(value: string, field: string): string {
  const parameter = value.trim();
  const separator = parameter.indexOf("=");
  if (separator <= 0) {
    throw badRequest(`${field} must be formatted as name=value.`);
  }
  const name = parameter.slice(0, separator);
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw badRequest(`${field} name must contain only letters, numbers, dot, underscore, or dash.`);
  }
  if (hasSecretBearingNamePart(name, SECRET_BEARING_TEMPLATE_PARAMETER_PARTS)) {
    throw badRequest(`${field} name must not be secret-bearing.`);
  }
  if (parameter.includes("\0")) {
    throw badRequest(`${field} must not contain NUL bytes.`);
  }
  return parameter;
}

function hasSecretBearingNamePart(name: string, secretParts: Set<string>): boolean {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return parts.some((part) => secretParts.has(part));
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw badRequest(`${field} must be an array of strings.`);
  }
  return value;
}

function allowedToolSubset(value: unknown, serverAllowedTools: string[] | undefined): string[] {
  const serverTools = serverAllowedTools ?? [];
  if (value === undefined) return serverTools;
  const requested = stringArray(value, "allowedTools");
  const denied = requested.filter((tool) => !serverTools.includes(tool));
  if (denied.length) {
    throw badRequest(`allowedTools not permitted by server: ${denied.join(", ")}`);
  }
  return [...new Set(requested)];
}

function booleanFlag(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw badRequest(`${field} must be a boolean.`);
  }
  return value;
}

function positiveInt(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  return positiveIntValue(value, "maxIterations");
}

function positiveIntValue(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest(`${field} must be a positive integer.`);
  }
  return parsed;
}

function positiveNumberValue(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw badRequest(`${field} must be a positive number.`);
  }
  return parsed;
}

function nonNegativeNumberValue(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw badRequest(`${field} must be a non-negative number.`);
  }
  return parsed;
}

function dockerMemoryValue(value: unknown, field: string): string {
  const memory = requireString(value, field).trim();
  if (!/^[1-9][0-9]*[bkmgBKMG]?$/.test(memory)) {
    throw badRequest(`${field} must be a Docker memory size like 512m or 4g.`);
  }
  return memory;
}

function dockerNetworkValue(value: unknown, field: string): string {
  const network = requireString(value, field).trim();
  if (network === "host" || network === "bridge" || network.startsWith("container:")) {
    throw badRequest(`${field} is an unsafe Docker network mode.`);
  }
  if (network !== "none" && !/^[A-Za-z0-9_.-]+$/.test(network)) {
    throw badRequest(`${field} must be none or a named sandbox network.`);
  }
  return network;
}

function badRequest(message: string): Error {
  const error = new Error(message);
  error.name = "BadRequest";
  return error;
}

function payloadTooLarge(message: string): Error {
  const error = new Error(message);
  error.name = "PayloadTooLarge";
  return error;
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}

function unauthorized(message: string): Error {
  const error = new Error(message);
  error.name = "Unauthorized";
  return error;
}

function forbidden(message: string): Error {
  const error = new Error(message);
  error.name = "Forbidden";
  return error;
}

function notFound(message: string): Error {
  const error = new Error(message);
  error.name = "NotFound";
  return error;
}

function statusForError(error: unknown): number {
  if (!(error instanceof Error)) return 500;
  if (error.name === "BadRequest") return 400;
  if (error.name === "PayloadTooLarge") return 413;
  if (error.name === "Conflict") return 409;
  if (error.name === "Unauthorized") return 401;
  if (error.name === "Forbidden") return 403;
  if (error.name === "NotFound") return 404;
  return 500;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2) + "\n");
}

function writeText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function writeHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization, x-loom-tenant-token, last-event-id");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function startedAt(state: RunSummary | RunningRunStatus | QueuedRunStatus): string {
  return "queuedAt" in state ? state.queuedAt : state.startedAt;
}

export { CancelRequestBody, delay, enforceModelUsageTokenLimitsForBody, enforceModelUsageTokenLimits, markdownInlineCode, optionalSessionEventString, optionalSessionEventNumber, optionalSessionEventRole, hasRequestValue, hasExplicitAgent, textArray, recordArray, readOptionalJsonObject, readOptionalTextFile, arrayCount, oneLineText, compactStringList, optionalSourceRepo, optionalSourceGitRef, optionalSourceIssue, compactObject, compactMetadata, reportIssue, reportPullRequest, reportBrainIngest, writeJsonFileAtomic, seqAfter, filterEvents, boundedDiagnosticText, isSensitiveDiagnosticKey, latestAuditData, replayEntryFromEvent, replayText, recordData, stringField, booleanField, numberField, stringArrayField, stringArrayFieldAllowEmpty, arraysEqual, requireServerStatusAccess, streamQueryToken, safeEqualString, policyStatusAccessKeys, bearerToken, headerValue, readJson, requireSafeName, optionalSafeName, requireString, optionalString, optionalBoolean, optionalClientId, optionalClientRequestId, isSafeDirectoryName, timingSafeHexEqual, envNameValue, optionalEnvNameValue, templateParameterValue, stringArray, allowedToolSubset, booleanFlag, positiveInt, positiveIntValue, positiveNumberValue, nonNegativeNumberValue, dockerMemoryValue, dockerNetworkValue, badRequest, payloadTooLarge, conflict, unauthorized, forbidden, notFound, statusForError, writeJson, writeText, writeHtml, setCorsHeaders, isNotFound, isAlreadyExists, startedAt };
