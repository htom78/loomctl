import type { IncomingMessage, ServerResponse } from "node:http";

import type { TenantAuditActor, TenantAuditAppender, TenantRole } from "./audit.js";
import {
  generateTenantApiKeyId,
  generateTenantApiToken,
  hashTenantApiToken,
  sanitizeTenantApiKey,
  sanitizeTenantApiKeys,
  tenantApiKeyIsActive,
  tenantApiKeyMatches,
  type TenantApiKey,
} from "./server-auth.js";

export interface TenantApiKeyPolicy {
  schemaVersion: 1;
  apiKeys?: TenantApiKey[];
}

export interface TenantApiKeyRouteDependencies<TPolicy extends TenantApiKeyPolicy> {
  requireTenant(value: string): string;
  requireAdmin(req: IncomingMessage, tenant: string, url: URL): Promise<TenantAuditActor | undefined>;
  readPolicy(tenant: string): Promise<TPolicy | undefined>;
  writePolicy(tenant: string, policy: TPolicy): Promise<void>;
  configuredKeys(tenant: string): TenantApiKey[];
  readBody(req: IncomingMessage): Promise<unknown>;
  appendAuditEvent: TenantAuditAppender;
}

export interface TenantApiKeyRouteHandlers {
  create(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  rotate(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  revoke(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

interface ApiKeyCreateBody {
  actor?: unknown;
  role?: unknown;
  modelKeyEnv?: unknown;
  token?: unknown;
  expiresAt?: unknown;
  clientId?: unknown;
}

interface ApiKeyRotateBody {
  keyId?: unknown;
  actor?: unknown;
  role?: unknown;
  token?: unknown;
  expiresAt?: unknown;
  overlapSeconds?: unknown;
  clientId?: unknown;
}

interface ApiKeyRevokeBody {
  keyId?: unknown;
  actor?: unknown;
  role?: unknown;
  clientId?: unknown;
}

export function createTenantApiKeyRouteHandlers<TPolicy extends TenantApiKeyPolicy>(
  dependencies: TenantApiKeyRouteDependencies<TPolicy>,
): TenantApiKeyRouteHandlers {
  return {
    create: (url, req, res) => handleCreate(url, req, res, dependencies),
    rotate: (url, req, res) => handleRotate(url, req, res, dependencies),
    revoke: (url, req, res) => handleRevoke(url, req, res, dependencies),
  };
}

export function parseTenantPolicyApiKeys(value: unknown): TenantApiKey[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw routeError("BadRequest", "apiKeys must be an array.");
  const apiKeys = value.map((entry, index) => {
    if (!isRecord(entry)) throw routeError("BadRequest", `apiKeys[${index}] must be an object.`);
    const role = apiKeyRole(entry.role, `apiKeys[${index}].role`);
    const token = entry.token === undefined ? undefined : apiToken(entry.token);
    const tokenHash = entry.tokenHash === undefined ? undefined : apiTokenHash(entry.tokenHash, `apiKeys[${index}].tokenHash`);
    if (!token && !tokenHash) {
      throw routeError("BadRequest", `apiKeys[${index}].token or apiKeys[${index}].tokenHash is required.`);
    }
    const id = entry.id === undefined ? undefined : apiKeyId(entry.id, `apiKeys[${index}].id`);
    const createdAt = entry.createdAt === undefined ? undefined : apiKeyTimestamp(entry.createdAt, `apiKeys[${index}].createdAt`);
    const notBefore = entry.notBefore === undefined ? undefined : apiKeyTimestamp(entry.notBefore, `apiKeys[${index}].notBefore`);
    const expiresAt = entry.expiresAt === undefined ? undefined : apiKeyTimestamp(entry.expiresAt, `apiKeys[${index}].expiresAt`);
    const rotatedFromId = entry.rotatedFromId === undefined
      ? undefined
      : apiKeyId(entry.rotatedFromId, `apiKeys[${index}].rotatedFromId`);
    if (notBefore && expiresAt && Date.parse(notBefore) >= Date.parse(expiresAt)) {
      throw routeError("BadRequest", `apiKeys[${index}].expiresAt must be later than notBefore.`);
    }
    return compactObject({
      id,
      tokenHash: tokenHash ?? hashTenantApiToken(token as string),
      actor: apiKeyActor(entry.actor),
      role,
      modelKeyEnv: entry.modelKeyEnv === undefined ? undefined : environmentName(entry.modelKeyEnv, `apiKeys[${index}].modelKeyEnv`),
      createdAt,
      notBefore,
      expiresAt,
      rotatedFromId,
    }) as TenantApiKey;
  });
  const ids = apiKeys.flatMap((key) => key.id ? [key.id] : []);
  if (new Set(ids).size !== ids.length) throw routeError("BadRequest", "apiKeys ids must be unique.");
  return apiKeys;
}

async function handleCreate<TPolicy extends TenantApiKeyPolicy>(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  dependencies: TenantApiKeyRouteDependencies<TPolicy>,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "tenants" || segments[2] !== "policy" || segments[3] !== "api-keys") return false;
  const tenant = dependencies.requireTenant(segments[1]);
  const access = await dependencies.requireAdmin(req, tenant, url);
  const body = requestObject(await dependencies.readBody(req), "tenant API key request") as ApiKeyCreateBody;
  const clientId = optionalClientId(body.clientId);
  const { apiKey, token } = apiKeyFromCreateBody(body);
  const existing = await dependencies.readPolicy(tenant);
  const currentKeys = existing?.apiKeys ?? [];
  if ([...dependencies.configuredKeys(tenant), ...currentKeys].some((key) => tenantApiKeyMatches(key, token))) {
    throw routeError("BadRequest", "tenant API key token already exists.");
  }
  const policy = policyWithKeys(existing, [...currentKeys, apiKey]);
  await dependencies.writePolicy(tenant, policy);
  await dependencies.appendAuditEvent(tenant, "tenant_api_key_created", compactObject({
    actor: apiKey.actor,
    keyRole: apiKey.role,
    modelKeyEnv: apiKey.modelKeyEnv,
    createdApiKey: sanitizeTenantApiKey(apiKey),
    apiKeysBefore: sanitizeTenantApiKeys(currentKeys),
    apiKeysAfter: sanitizeTenantApiKeys(policy.apiKeys),
    apiKeyCount: policy.apiKeys?.length ?? 0,
    clientId,
  }), access);
  writeJson(res, 201, { apiKey: sanitizeTenantApiKey(apiKey), token, policy: sanitizePolicyKeys(policy) });
  return true;
}

async function handleRotate<TPolicy extends TenantApiKeyPolicy>(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  dependencies: TenantApiKeyRouteDependencies<TPolicy>,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    segments.length !== 5 ||
    segments[0] !== "tenants" ||
    segments[2] !== "policy" ||
    segments[3] !== "api-keys" ||
    segments[4] !== "rotate"
  ) return false;
  const tenant = dependencies.requireTenant(segments[1]);
  const access = await dependencies.requireAdmin(req, tenant, url);
  const body = requestObject(await dependencies.readBody(req), "tenant API key rotate request") as ApiKeyRotateBody;
  const clientId = optionalClientId(body.clientId);
  const keyId = body.keyId === undefined ? undefined : apiKeyId(body.keyId, "keyId");
  const actor = body.actor === undefined ? undefined : apiKeyActor(body.actor);
  if (!keyId && !actor) throw routeError("BadRequest", "keyId or actor is required.");
  const role = body.role === undefined ? undefined : apiKeyRole(body.role, "role");
  const overlapSeconds = apiKeyOverlapSeconds(body.overlapSeconds);
  const existing = await dependencies.readPolicy(tenant);
  const currentKeys = existing?.apiKeys ?? [];
  const candidates = currentKeys.filter((key) => tenantApiKeyIsActive(key) && (keyId
    ? key.id === keyId
    : key.actor === actor && (role === undefined || key.role === role)));
  if (candidates.length === 0) throw routeError("NotFound", "active tenant API key not found");
  if (candidates.length > 1) {
    throw routeError("Conflict", "tenant API key selector matches more than one active key; use keyId");
  }
  const current = candidates[0];
  const now = Date.now();
  const currentId = current.id ?? generateTenantApiKeyId();
  const overlapExpiryMs = now + overlapSeconds * 1_000;
  const currentExpiryMs = current.expiresAt ? Date.parse(current.expiresAt) : Number.POSITIVE_INFINITY;
  const expiresAt = new Date(Math.min(overlapExpiryMs, currentExpiryMs)).toISOString();
  const expiringKey: TenantApiKey = { ...current, id: currentId, expiresAt };
  const { apiKey, token } = apiKeyFromCreateBody({
    actor: current.actor,
    role: current.role,
    modelKeyEnv: current.modelKeyEnv,
    token: body.token,
    expiresAt: body.expiresAt,
  }, { now, rotatedFromId: currentId });
  if ([...dependencies.configuredKeys(tenant), ...currentKeys].some((key) => tenantApiKeyMatches(key, token))) {
    throw routeError("BadRequest", "tenant API key token already exists.");
  }
  const apiKeys = currentKeys.map((key) => key === current ? expiringKey : key).concat(apiKey);
  const policy = policyWithKeys(existing, apiKeys);
  await dependencies.writePolicy(tenant, policy);
  await dependencies.appendAuditEvent(tenant, "tenant_api_key_rotated", compactObject({
    actor: current.actor,
    keyRole: current.role,
    previousKeyId: currentId,
    newKeyId: apiKey.id,
    overlapSeconds,
    previousKeyExpiresAt: expiresAt,
    previousApiKey: sanitizeTenantApiKey(expiringKey),
    createdApiKey: sanitizeTenantApiKey(apiKey),
    apiKeyCount: policy.apiKeys?.length ?? 0,
    clientId,
  }), access);
  writeJson(res, 201, {
    previousApiKey: sanitizeTenantApiKey(expiringKey),
    apiKey: sanitizeTenantApiKey(apiKey),
    token,
    overlapSeconds,
    policy: sanitizePolicyKeys(policy),
  });
  return true;
}

async function handleRevoke<TPolicy extends TenantApiKeyPolicy>(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  dependencies: TenantApiKeyRouteDependencies<TPolicy>,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    segments.length !== 5 ||
    segments[0] !== "tenants" ||
    segments[2] !== "policy" ||
    segments[3] !== "api-keys" ||
    segments[4] !== "revoke"
  ) return false;
  const tenant = dependencies.requireTenant(segments[1]);
  const access = await dependencies.requireAdmin(req, tenant, url);
  const body = requestObject(await dependencies.readBody(req), "tenant API key revoke request") as ApiKeyRevokeBody;
  const clientId = optionalClientId(body.clientId);
  const keyId = body.keyId === undefined ? undefined : apiKeyId(body.keyId, "keyId");
  const actor = body.actor === undefined ? undefined : apiKeyActor(body.actor);
  if (!keyId && !actor) throw routeError("BadRequest", "keyId or actor is required.");
  const role = body.role === undefined ? undefined : apiKeyRole(body.role, "role");
  const existing = await dependencies.readPolicy(tenant);
  const currentKeys = existing?.apiKeys ?? [];
  const matches = (key: TenantApiKey): boolean => keyId
    ? key.id === keyId
    : key.actor === actor && (role === undefined || key.role === role);
  const revokedApiKeys = currentKeys.filter(matches);
  const apiKeys = currentKeys.filter((key) => !matches(key));
  const policy = policyWithKeys(existing, apiKeys);
  await dependencies.writePolicy(tenant, policy);
  await dependencies.appendAuditEvent(tenant, "tenant_api_key_revoked", compactObject({
    actor: actor ?? revokedApiKeys[0]?.actor,
    keyId,
    keyRole: role,
    revoked: revokedApiKeys.length,
    revokedApiKeys: sanitizeTenantApiKeys(revokedApiKeys),
    apiKeysBefore: sanitizeTenantApiKeys(currentKeys),
    apiKeysAfter: sanitizeTenantApiKeys(policy.apiKeys),
    apiKeyCount: policy.apiKeys?.length ?? 0,
    clientId,
  }), access);
  writeJson(res, 200, { revoked: revokedApiKeys.length, policy: sanitizePolicyKeys(policy) });
  return true;
}

function apiKeyFromCreateBody(
  body: ApiKeyCreateBody,
  options: { now?: number; rotatedFromId?: string } = {},
): { apiKey: TenantApiKey; token: string } {
  const now = options.now ?? Date.now();
  const token = body.token === undefined ? generateTenantApiToken() : apiToken(body.token);
  const expiresAt = body.expiresAt === undefined ? undefined : apiKeyTimestamp(body.expiresAt, "expiresAt");
  if (expiresAt && Date.parse(expiresAt) <= now) throw routeError("BadRequest", "expiresAt must be in the future.");
  return {
    token,
    apiKey: compactObject({
      id: generateTenantApiKeyId(),
      tokenHash: hashTenantApiToken(token),
      actor: apiKeyActor(body.actor),
      role: apiKeyRole(body.role, "role"),
      modelKeyEnv: body.modelKeyEnv === undefined ? undefined : environmentName(body.modelKeyEnv, "modelKeyEnv"),
      createdAt: new Date(now).toISOString(),
      expiresAt,
      rotatedFromId: options.rotatedFromId,
    }) as TenantApiKey,
  };
}

function policyWithKeys<TPolicy extends TenantApiKeyPolicy>(policy: TPolicy | undefined, apiKeys: TenantApiKey[]): TPolicy {
  return {
    ...(policy ?? { schemaVersion: 1 }),
    schemaVersion: 1,
    apiKeys,
  } as TPolicy;
}

function sanitizePolicyKeys<TPolicy extends TenantApiKeyPolicy>(policy: TPolicy): TPolicy & { apiKeys?: ReturnType<typeof sanitizeTenantApiKeys> } {
  return {
    ...policy,
    apiKeys: policy.apiKeys?.map((key) => sanitizeTenantApiKey(key)),
  };
}

function requestObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw routeError("BadRequest", `${label} must be an object.`);
  return value;
}

function apiKeyActor(value: unknown): string {
  const actor = requiredString(value, "actor").trim();
  if (actor.length > 120 || /[\0\r\n]/.test(actor)) {
    throw routeError("BadRequest", "actor must be a single-line string at most 120 characters.");
  }
  return actor;
}

function apiKeyRole(value: unknown, field: string): TenantRole {
  if (value !== "admin" && value !== "developer" && value !== "viewer") {
    throw routeError("BadRequest", `${field} must be admin, developer, or viewer.`);
  }
  return value;
}

function apiToken(value: unknown): string {
  const token = requiredString(value, "token").trim();
  if (token.length > 512 || /[\0\r\n]/.test(token)) {
    throw routeError("BadRequest", "token must be a single-line string at most 512 characters.");
  }
  return token;
}

function apiTokenHash(value: unknown, field: string): string {
  const hash = requiredString(value, field).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw routeError("BadRequest", `${field} must be a sha256 token hash.`);
  return hash;
}

function apiKeyId(value: unknown, field: string): string {
  const id = requiredString(value, field).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) {
    throw routeError("BadRequest", `${field} must be a safe identifier.`);
  }
  return id;
}

function apiKeyTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field).trim();
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) throw routeError("BadRequest", `${field} must be an ISO 8601 timestamp.`);
  return new Date(parsed).toISOString();
}

function apiKeyOverlapSeconds(value: unknown): number {
  if (value === undefined) return 3_600;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 604_800) {
    throw routeError("BadRequest", "overlapSeconds must be an integer between 0 and 604800.");
  }
  return seconds;
}

function environmentName(value: unknown, field: string): string {
  const name = requiredString(value, field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw routeError("BadRequest", `${field} must be an environment variable name.`);
  }
  return name;
}

function optionalClientId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const clientId = requiredString(value, "clientId").trim();
  if (clientId.length > 120 || /[\0\r\n]/.test(clientId)) {
    throw routeError("BadRequest", "clientId must be a single-line string at most 120 characters.");
  }
  return clientId;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw routeError("BadRequest", `${field} is required.`);
  return value;
}

function routeError(name: "BadRequest" | "Conflict" | "NotFound", message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
