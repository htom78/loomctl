import { LoomApiError } from "@loom/api";

export interface CacheHit<T> {
  value: T;
  storedAt: string;
}

interface CacheEntry {
  key: string;
  storedAt: number;
  value: unknown;
}

interface CacheDocument {
  version: 1;
  entries: CacheEntry[];
}

export interface CacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "loom.desktop.metadata.v1";
const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|api.?key|private.?key)/i;

export class BoundedMetadataCache {
  constructor(
    private readonly storage: CacheStorage,
    private readonly maxBytes = 256 * 1024,
    private readonly maxEntries = 40,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
  ) {}

  get<T>(key: string, now = Date.now()): CacheHit<T> | undefined {
    const entry = this.read().entries.find((item) => item.key === key);
    if (!entry || now - entry.storedAt > this.ttlMs) return undefined;
    return { value: entry.value as T, storedAt: new Date(entry.storedAt).toISOString() };
  }

  set(key: string, value: unknown, now = Date.now()): boolean {
    if (!key.trim() || containsSensitiveData(value)) return false;
    const current = this.read().entries.filter((entry) => entry.key !== key);
    current.push({ key, storedAt: now, value });
    current.sort((left, right) => right.storedAt - left.storedAt);
    const entries = current.slice(0, this.maxEntries);
    while (entries.length) {
      const document: CacheDocument = { version: 1, entries };
      const encoded = JSON.stringify(document);
      if (new TextEncoder().encode(encoded).byteLength <= this.maxBytes) {
        this.storage.setItem(STORAGE_KEY, encoded);
        return true;
      }
      entries.pop();
    }
    return false;
  }

  remove(key: string): void {
    const entries = this.read().entries.filter((entry) => entry.key !== key);
    this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries } satisfies CacheDocument));
  }

  private read(): CacheDocument {
    try {
      const value: unknown = JSON.parse(this.storage.getItem(STORAGE_KEY) ?? "null");
      if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) return { version: 1, entries: [] };
      const entries = value.entries.filter(isCacheEntry).filter((entry) => !containsSensitiveData(entry.value));
      return { version: 1, entries };
    } catch {
      return { version: 1, entries: [] };
    }
  }
}

class MemoryCacheStorage implements CacheStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const defaultStorage: CacheStorage = typeof localStorage === "undefined" ? new MemoryCacheStorage() : localStorage;
export const metadataCache = new BoundedMetadataCache(defaultStorage);

export function cacheKey(profileId: string, tenant: string, resource: string): string {
  return `${profileId}:${tenant}:${resource}`;
}

export function isOfflineError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof LoomApiError && error.status >= 500;
}

function containsSensitiveData(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsSensitiveData(item, depth + 1));
  return Object.entries(value).some(([key, nested]) => SENSITIVE_KEY.test(key) || containsSensitiveData(nested, depth + 1));
}

function isCacheEntry(value: unknown): value is CacheEntry {
  return isRecord(value) && typeof value.key === "string" && typeof value.storedAt === "number" && "value" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
