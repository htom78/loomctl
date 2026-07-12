export type AuthMode = "token" | "oidc";
export type UpdateChannel = "stable" | "beta";

export interface Profile {
  id: string;
  name: string;
  baseUrl: string;
  tenant: string;
  authMode: AuthMode;
  caPem?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcAudience?: string;
  oidcScopes?: string;
  crashReporting?: boolean;
  crashEndpoint?: string;
}

export interface DesktopPreferences {
  updateChannel: UpdateChannel;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PROFILE_KEY = "loom.desktop.profiles.v2";
const LEGACY_PROFILE_KEY = "loom.desktop.profiles.v1";
const PREFERENCES_KEY = "loom.desktop.preferences.v1";

export function readProfiles(storage: KeyValueStorage = localStorage): Profile[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(PROFILE_KEY) ?? storage.getItem(LEGACY_PROFILE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.map(parseProfile).filter((value): value is Profile => Boolean(value)) : [];
  } catch {
    return [];
  }
}

export function writeProfiles(profiles: Profile[], storage: KeyValueStorage = localStorage): void {
  storage.setItem(PROFILE_KEY, JSON.stringify(profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    tenant: profile.tenant,
    authMode: profile.authMode,
    caPem: profile.caPem || undefined,
    oidcIssuer: profile.oidcIssuer || undefined,
    oidcClientId: profile.oidcClientId || undefined,
    oidcAudience: profile.oidcAudience || undefined,
    oidcScopes: profile.oidcScopes || undefined,
    crashReporting: profile.crashReporting || undefined,
    crashEndpoint: profile.crashEndpoint || undefined,
  }))));
}

export function readPreferences(storage: KeyValueStorage = localStorage): DesktopPreferences {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(PREFERENCES_KEY) ?? "null");
    return isRecord(parsed) && (parsed.updateChannel === "stable" || parsed.updateChannel === "beta")
      ? { updateChannel: parsed.updateChannel }
      : { updateChannel: "stable" };
  } catch {
    return { updateChannel: "stable" };
  }
}

export function writePreferences(preferences: DesktopPreferences, storage: KeyValueStorage = localStorage): void {
  storage.setItem(PREFERENCES_KEY, JSON.stringify({ updateChannel: preferences.updateChannel }));
}

function parseProfile(value: unknown): Profile | undefined {
  if (!isRecord(value)) return undefined;
  const id = boundedString(value.id, 128);
  const name = boundedString(value.name, 128);
  const baseUrl = boundedString(value.baseUrl, 2048);
  const tenant = boundedString(value.tenant, 128);
  if (!id || !name || !baseUrl || !tenant) return undefined;
  return {
    id,
    name,
    baseUrl,
    tenant,
    authMode: value.authMode === "oidc" ? "oidc" : "token",
    caPem: boundedString(value.caPem, 256 * 1024),
    oidcIssuer: boundedString(value.oidcIssuer, 2048),
    oidcClientId: boundedString(value.oidcClientId, 256),
    oidcAudience: boundedString(value.oidcAudience, 256),
    oidcScopes: boundedString(value.oidcScopes, 1024),
    crashReporting: value.crashReporting === true,
    crashEndpoint: boundedString(value.crashEndpoint, 2048),
  };
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
