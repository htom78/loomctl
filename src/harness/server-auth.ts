import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import type { TenantRole } from "./audit.js";

export interface TenantApiKey {
  id?: string;
  token?: string;
  tokenHash?: string;
  actor: string;
  role: TenantRole;
  modelKeyEnv?: string;
  createdAt?: string;
  notBefore?: string;
  expiresAt?: string;
  rotatedFromId?: string;
}

export interface SanitizedTenantApiKey {
  id?: string;
  actor: string;
  role: TenantRole;
  modelKeyEnv?: string;
  createdAt?: string;
  notBefore?: string;
  expiresAt?: string;
  rotatedFromId?: string;
  active?: boolean;
}

export interface OidcAuthConfig {
  issuer: string;
  audience: string | string[];
  jwksUrl?: string;
  tenantClaim?: string;
  actorClaim?: string;
  roleClaim?: string;
  algorithms?: string[];
  clockToleranceSeconds?: number;
  requestTimeoutMs?: number;
  refreshIntervalMs?: number;
  allowInsecureHttp?: boolean;
  now?: () => number;
}

export interface OidcAccess {
  tenant: string;
  actor: string;
  role: TenantRole;
  subject: string;
}

export type OidcHealthFailureKind = "discovery" | "jwks" | "unavailable";

export interface OidcHealthSnapshot {
  schemaVersion: "oidc-health/v1";
  enabled: true;
  ready: boolean;
  issuer: string;
  audience: string[];
  discoveryUrl?: string;
  jwksUrl?: string;
  tenantClaim: string;
  actorClaim: string;
  roleClaim: string;
  checkedAt?: string;
  failureCount: number;
  failureKind?: OidcHealthFailureKind;
}

export interface OidcAuthenticator {
  authenticate(token: string, expectedTenant?: string): Promise<OidcAccess>;
  ensureReady(): Promise<OidcHealthSnapshot>;
  snapshot(): OidcHealthSnapshot;
}

interface ResolvedOidcProvider {
  jwks: ReturnType<typeof createRemoteJWKSet>;
  jwksUrl: string;
}

const DEFAULT_OIDC_ALGORITHMS = ["RS256", "PS256", "ES256", "EdDSA"];
const DEFAULT_OIDC_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_OIDC_CLOCK_TOLERANCE_SECONDS = 30;
const DEFAULT_OIDC_REFRESH_INTERVAL_MS = 60_000;

export function createOidcAuthenticator(config: OidcAuthConfig): OidcAuthenticator {
  const normalized = normalizeOidcConfig(config);
  let resolved: ResolvedOidcProvider | undefined;
  let initializing: Promise<ResolvedOidcProvider> | undefined;
  let checkedAt: string | undefined;
  let checkedAtMs: number | undefined;
  let failureCount = 0;
  let failureKind: OidcHealthFailureKind | undefined;

  const snapshot = (): OidcHealthSnapshot => ({
    schemaVersion: "oidc-health/v1",
    enabled: true,
    ready: resolved !== undefined && failureKind === undefined,
    issuer: normalized.issuer,
    audience: normalized.audience,
    discoveryUrl: normalized.discoveryUrl,
    jwksUrl: resolved?.jwksUrl ?? normalized.jwksUrl,
    tenantClaim: normalized.tenantClaim,
    actorClaim: normalized.actorClaim,
    roleClaim: normalized.roleClaim,
    checkedAt,
    failureCount,
    failureKind,
  });

  const initialize = async (): Promise<ResolvedOidcProvider> => {
    if (resolved) return resolved;
    if (initializing) return initializing;
    initializing = resolveOidcProvider(normalized).then((provider) => {
      resolved = provider;
      checkedAtMs = normalized.now();
      checkedAt = new Date(checkedAtMs).toISOString();
      failureKind = undefined;
      return provider;
    }).catch((error) => {
      checkedAtMs = normalized.now();
      checkedAt = new Date(checkedAtMs).toISOString();
      failureCount += 1;
      failureKind = oidcFailureKind(error);
      throw error;
    }).finally(() => {
      initializing = undefined;
    });
    return initializing;
  };

  const ensureFresh = async (): Promise<void> => {
    const provider = await initialize();
    if (checkedAtMs !== undefined && normalized.now() - checkedAtMs < normalized.refreshIntervalMs) return;
    try {
      await provider.jwks.reload();
      if (!provider.jwks.jwks()?.keys.length) throw new Error("empty JWKS");
      checkedAtMs = normalized.now();
      checkedAt = new Date(checkedAtMs).toISOString();
      failureKind = undefined;
    } catch {
      checkedAtMs = normalized.now();
      checkedAt = new Date(checkedAtMs).toISOString();
      failureCount += 1;
      failureKind = "jwks";
    }
  };

  return {
    async authenticate(token, expectedTenant) {
      try {
        const provider = await initialize();
        const { payload } = await jwtVerify(token, provider.jwks, {
          issuer: normalized.issuer,
          audience: normalized.audience,
          algorithms: normalized.algorithms,
          clockTolerance: normalized.clockToleranceSeconds,
          requiredClaims: ["exp", "sub"],
        });
        return oidcAccessFromPayload(payload, normalized, expectedTenant);
      } catch {
        throw new OidcAuthenticationError();
      }
    },
    async ensureReady() {
      try {
        await ensureFresh();
      } catch {
        // The health snapshot intentionally omits provider and network errors.
      }
      return snapshot();
    },
    snapshot,
  };
}

export function tenantApiKeyMatches(key: TenantApiKey, provided: string | undefined, now = Date.now()): boolean {
  if (!provided || !tenantApiKeyIsActive(key, now)) return false;
  if (key.token && safeEqualString(provided, key.token)) return true;
  return Boolean(key.tokenHash && safeEqualString(hashTenantApiToken(provided), key.tokenHash));
}

export function tenantApiKeyIsActive(key: TenantApiKey, now = Date.now()): boolean {
  const notBefore = key.notBefore === undefined ? undefined : Date.parse(key.notBefore);
  const expiresAt = key.expiresAt === undefined ? undefined : Date.parse(key.expiresAt);
  if (notBefore !== undefined && (!Number.isFinite(notBefore) || now < notBefore)) return false;
  if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || now >= expiresAt)) return false;
  return true;
}

export function hashTenantApiToken(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

export function generateTenantApiToken(): string {
  return `loom_${randomBytes(24).toString("base64url")}`;
}

export function generateTenantApiKeyId(): string {
  return `key_${randomBytes(12).toString("base64url")}`;
}

export function sanitizeTenantApiKey(key: TenantApiKey, now = Date.now()): SanitizedTenantApiKey {
  const hasLifecycle = Boolean(key.id || key.createdAt || key.notBefore || key.expiresAt || key.rotatedFromId);
  return compactObject({
    id: key.id,
    actor: key.actor,
    role: key.role,
    modelKeyEnv: key.modelKeyEnv,
    createdAt: key.createdAt,
    notBefore: key.notBefore,
    expiresAt: key.expiresAt,
    rotatedFromId: key.rotatedFromId,
    active: hasLifecycle ? tenantApiKeyIsActive(key, now) : undefined,
  }) as SanitizedTenantApiKey;
}

export function sanitizeTenantApiKeys(keys: TenantApiKey[] | undefined): SanitizedTenantApiKey[] | undefined {
  const sanitized = keys?.map((key) => sanitizeTenantApiKey(key)) ?? [];
  return sanitized.length ? sanitized : undefined;
}

export class OidcAuthenticationError extends Error {
  constructor() {
    super("invalid OIDC token");
  }
}

interface NormalizedOidcConfig {
  issuer: string;
  audience: string[];
  jwksUrl?: string;
  discoveryUrl?: string;
  tenantClaim: string;
  actorClaim: string;
  roleClaim: string;
  algorithms: string[];
  clockToleranceSeconds: number;
  requestTimeoutMs: number;
  refreshIntervalMs: number;
  allowInsecureHttp: boolean;
  now: () => number;
}

function normalizeOidcConfig(config: OidcAuthConfig): NormalizedOidcConfig {
  const issuer = endpointUrl(config.issuer, "OIDC issuer", Boolean(config.allowInsecureHttp)).toString().replace(/\/$/, "");
  const audience = (Array.isArray(config.audience) ? config.audience : [config.audience])
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (audience.length === 0) throw new Error("OIDC audience is required");
  const jwksUrl = config.jwksUrl
    ? endpointUrl(config.jwksUrl, "OIDC JWKS URL", Boolean(config.allowInsecureHttp)).toString()
    : undefined;
  const discoveryUrl = jwksUrl ? undefined : `${issuer}/.well-known/openid-configuration`;
  const algorithms = config.algorithms?.map((entry) => entry.trim()).filter(Boolean) ?? DEFAULT_OIDC_ALGORITHMS;
  if (algorithms.length === 0 || algorithms.includes("none") || algorithms.some((algorithm) => algorithm.startsWith("HS"))) {
    throw new Error("OIDC algorithms must contain asymmetric signing algorithms");
  }
  return {
    issuer,
    audience,
    jwksUrl,
    discoveryUrl,
    tenantClaim: claimName(config.tenantClaim ?? "loom_tenant", "OIDC tenant claim"),
    actorClaim: claimName(config.actorClaim ?? "preferred_username", "OIDC actor claim"),
    roleClaim: claimName(config.roleClaim ?? "loom_role", "OIDC role claim"),
    algorithms,
    clockToleranceSeconds: boundedInteger(config.clockToleranceSeconds ?? DEFAULT_OIDC_CLOCK_TOLERANCE_SECONDS, 0, 300, "OIDC clock tolerance"),
    requestTimeoutMs: boundedInteger(config.requestTimeoutMs ?? DEFAULT_OIDC_REQUEST_TIMEOUT_MS, 100, 30_000, "OIDC request timeout"),
    refreshIntervalMs: boundedInteger(config.refreshIntervalMs ?? DEFAULT_OIDC_REFRESH_INTERVAL_MS, 1_000, 3_600_000, "OIDC refresh interval"),
    allowInsecureHttp: Boolean(config.allowInsecureHttp),
    now: config.now ?? Date.now,
  };
}

async function resolveOidcProvider(config: NormalizedOidcConfig): Promise<ResolvedOidcProvider> {
  let jwksUrl = config.jwksUrl;
  if (!jwksUrl) {
    let discovery: unknown;
    try {
      discovery = await fetchJson(config.discoveryUrl as string, config.requestTimeoutMs);
    } catch {
      throw new OidcProviderError("discovery");
    }
    if (!isRecord(discovery) || discovery.issuer !== config.issuer || typeof discovery.jwks_uri !== "string") {
      throw new OidcProviderError("discovery");
    }
    try {
      jwksUrl = endpointUrl(discovery.jwks_uri, "OIDC discovery jwks_uri", config.allowInsecureHttp).toString();
    } catch {
      throw new OidcProviderError("discovery");
    }
  }

  const jwks = createRemoteJWKSet(new URL(jwksUrl), {
    timeoutDuration: config.requestTimeoutMs,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });
  try {
    await jwks.reload();
    if (!jwks.jwks()?.keys.length) throw new Error("empty JWKS");
  } catch {
    throw new OidcProviderError("jwks");
  }
  return { jwks, jwksUrl };
}

function oidcAccessFromPayload(
  payload: JWTPayload,
  config: NormalizedOidcConfig,
  expectedTenant?: string,
): OidcAccess {
  const tenants = claimStrings(payload[config.tenantClaim]);
  const tenant = expectedTenant ?? (tenants.length === 1 ? tenants[0] : undefined);
  if (!tenant || !tenants.includes(tenant)) throw new OidcAuthenticationError();
  const role = payload[config.roleClaim];
  if (role !== "admin" && role !== "developer" && role !== "viewer") throw new OidcAuthenticationError();
  const actorValue = payload[config.actorClaim] ?? payload.sub;
  if (typeof actorValue !== "string" || !actorValue.trim() || actorValue.length > 160 || /[\0\r\n]/.test(actorValue)) {
    throw new OidcAuthenticationError();
  }
  return {
    tenant,
    actor: actorValue.trim(),
    role,
    subject: payload.sub as string,
  };
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`OIDC endpoint returned ${response.status}`);
  return response.json();
}

function endpointUrl(value: string, label: string, allowInsecureHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (url.username || url.password || url.hash) throw new Error(`${label} must not include credentials or a fragment`);
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    throw new Error(`${label} must use HTTPS`);
  }
  return url;
}

function claimName(value: string, label: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(name)) throw new Error(`${label} is invalid`);
  return name;
}

function claimStrings(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim());
}

function safeEqualString(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function oidcFailureKind(error: unknown): OidcHealthFailureKind {
  return error instanceof OidcProviderError ? error.kind : "unavailable";
}

class OidcProviderError extends Error {
  constructor(readonly kind: "discovery" | "jwks") {
    super(`OIDC ${kind} failed`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
