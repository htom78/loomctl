import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { type TenantAuditEvent } from "../audit.js";
import { type QueuedRunStatus, type RunningRunStatus } from "../run-state.js";
import type { HarnessEvent, RunMetadata, RunSummary } from "../events.js";
import { parseGiteaIssueRef } from "../gitea.js";
import { safeGitRef } from "../git-ref.js";
import { HTTP_JSON_BODY_LIMIT_BYTES } from "./types.js";


interface CancelRequestBody {
  reason?: unknown;
  clientId?: unknown;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function workspacePullRequestRef(value: unknown, fallback: string | undefined, field: string, optional = false): string | undefined {
  const ref = (optionalString(value, field) ?? fallback)?.trim();
  if (!ref) {
    if (optional) return undefined;
    throw badRequest(`${field} is required.`);
  }
  try {
    return safeGitRef(ref, field);
  } catch {
    throw badRequest(`${field} is not a safe git ref.`);
  }
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

function replayText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
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

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
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

export { CancelRequestBody, delay, markdownInlineCode, optionalSessionEventString, optionalSessionEventNumber, optionalSessionEventRole, hasRequestValue, textArray, recordArray, readOptionalJsonObject, readOptionalTextFile, arrayCount, oneLineText, compactStringList, optionalSourceRepo, optionalSourceGitRef, optionalSourceIssue, workspacePullRequestRef, compactObject, compactMetadata, writeJsonFileAtomic, seqAfter, filterEvents, boundedDiagnosticText, isSensitiveDiagnosticKey, latestAuditData, replayText, recordData, stringField, booleanField, numberField, stringArrayField, stringArrayFieldAllowEmpty, arraysEqual, streamQueryToken, safeEqualString, bearerToken, headerValue, requireSafeName, optionalSafeName, requireString, optionalString, optionalBoolean, optionalClientId, optionalClientRequestId, isSafeDirectoryName, timingSafeHexEqual, envNameValue, optionalEnvNameValue, templateParameterValue, stringArray, allowedToolSubset, booleanFlag, positiveInt, positiveIntValue, positiveNumberValue, nonNegativeNumberValue, dockerMemoryValue, dockerNetworkValue, badRequest, payloadTooLarge, conflict, unauthorized, forbidden, notFound, statusForError, writeJson, writeText, writeHtml, setCorsHeaders, isNotFound, isAlreadyExists, startedAt, readJsonBody, readRawBody };
