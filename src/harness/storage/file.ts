import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  StateConflictError,
  assertStateName,
  positiveTtlMs,
  type DocumentStore,
  type CapacityLeaseStore,
  type EventStore,
  type LeaseRecord,
  type LeaseStore,
  type PlatformStateBackend,
  type PutDocumentOptions,
  type QueueItem,
  type QueueStore,
  type StoredDocument,
  type StoredEvent,
} from "./contracts.js";

const FILE_LOCK_TIMEOUT_MS = 60_000;
const FILE_LOCK_RETRY_MS = 20;

export interface FileStateBackendOptions {
  rootDir: string;
}

export function createFileStateBackend(options: FileStateBackendOptions): PlatformStateBackend {
  const root = resolve(options.rootDir);
  return {
    kind: "file",
    documents: createFileDocumentStore(root),
    events: createFileEventStore(root),
    leases: createFileLeaseStore(root),
    capacityLeases: createFileCapacityLeaseStore(root),
    queues: createFileQueueStore(root),
    async close() {},
  };
}

export function createFileDocumentStore(rootDir: string): DocumentStore {
  const root = resolve(rootDir, "documents");
  return {
    async get<T>(namespace: string, key: string): Promise<StoredDocument<T> | undefined> {
      return readJsonIfPresent<StoredDocument<T>>(documentPath(root, namespace, key));
    },
    async put<T>(namespace: string, key: string, value: T, options: PutDocumentOptions = {}): Promise<StoredDocument<T>> {
      const path = documentPath(root, namespace, key);
      return withFileLock(rootDir, `document:${namespace}:${key}`, async () => {
        const current = await readJsonIfPresent<StoredDocument<T>>(path);
        assertExpectedVersion(current?.version, options.expectedVersion, namespace, key);
        const next: StoredDocument<T> = {
          namespace,
          key,
          version: (current?.version ?? 0) + 1,
          value,
          updatedAt: new Date().toISOString(),
        };
        await writeJsonAtomic(path, next);
        return next;
      });
    },
    async delete(namespace: string, key: string, options: PutDocumentOptions = {}): Promise<boolean> {
      const path = documentPath(root, namespace, key);
      return withFileLock(rootDir, `document:${namespace}:${key}`, async () => {
        const current = await readJsonIfPresent<StoredDocument>(path);
        if (!current) {
          assertExpectedVersion(undefined, options.expectedVersion, namespace, key);
          return false;
        }
        assertExpectedVersion(current.version, options.expectedVersion, namespace, key);
        await unlink(path);
        return true;
      });
    },
    async list<T>(namespace: string, prefix = ""): Promise<Array<StoredDocument<T>>> {
      assertStateName(namespace, "namespace");
      if (prefix) assertStateName(prefix, "prefix");
      const dir = join(root, encoded(namespace));
      const entries = await readDirectory(dir);
      const documents = await Promise.all(entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readJsonIfPresent<StoredDocument<T>>(join(dir, entry))));
      return documents
        .filter((entry): entry is StoredDocument<T> => Boolean(entry && entry.key.startsWith(prefix)))
        .sort((left, right) => left.key.localeCompare(right.key));
    },
  };
}

export function createFileEventStore(rootDir: string): EventStore {
  const root = resolve(rootDir, "events");
  return {
    async append<T>(stream: string, value: T): Promise<StoredEvent<T>> {
      const path = eventPath(root, stream);
      return withFileLock(rootDir, `event:${stream}`, async () => {
        const events = await readEventFile<T>(path, stream);
        const event: StoredEvent<T> = {
          stream,
          seq: (events.at(-1)?.seq ?? 0) + 1,
          ts: new Date().toISOString(),
          value,
        };
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, JSON.stringify(event) + "\n", "utf8");
        return event;
      });
    },
    async read<T>(stream: string, afterSeq = 0, limit = 10_000): Promise<Array<StoredEvent<T>>> {
      if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
      if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
      return (await readEventFile<T>(eventPath(root, stream), stream))
        .filter((event) => event.seq > afterSeq)
        .slice(0, limit);
    },
  };
}

export function createFileLeaseStore(rootDir: string): LeaseStore {
  const root = resolve(rootDir, "leases");
  return {
    async acquire<T>(key: string, owner: string, ttlMs: number, value: T): Promise<LeaseRecord<T> | undefined> {
      const path = leasePath(root, key);
      positiveTtlMs(ttlMs);
      assertStateName(owner, "lease owner");
      return withFileLock(rootDir, `lease:${key}`, async () => {
        const current = await readJsonIfPresent<LeaseRecord<T>>(path);
        if (current && !leaseExpired(current)) return undefined;
        const acquiredAt = new Date().toISOString();
        const lease: LeaseRecord<T> = {
          key,
          owner,
          acquiredAt,
          expiresAt: new Date(Date.parse(acquiredAt) + ttlMs).toISOString(),
          value,
        };
        await writeJsonAtomic(path, lease);
        return lease;
      });
    },
    async refresh<T>(key: string, owner: string, ttlMs: number): Promise<LeaseRecord<T> | undefined> {
      const path = leasePath(root, key);
      positiveTtlMs(ttlMs);
      return withFileLock(rootDir, `lease:${key}`, async () => {
        const current = await readJsonIfPresent<LeaseRecord<T>>(path);
        if (!current || current.owner !== owner || leaseExpired(current)) return undefined;
        const next = { ...current, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
        await writeJsonAtomic(path, next);
        return next;
      });
    },
    async release(key: string, owner: string): Promise<boolean> {
      const path = leasePath(root, key);
      return withFileLock(rootDir, `lease:${key}`, async () => {
        const current = await readJsonIfPresent<LeaseRecord>(path);
        if (!current || current.owner !== owner) return false;
        await unlink(path).catch((error) => {
          if (!isNotFound(error)) throw error;
        });
        return true;
      });
    },
    async get<T>(key: string): Promise<LeaseRecord<T> | undefined> {
      const current = await readJsonIfPresent<LeaseRecord<T>>(leasePath(root, key));
      return current && !leaseExpired(current) ? current : undefined;
    },
    async list<T>(prefix = ""): Promise<Array<LeaseRecord<T>>> {
      if (prefix) assertStateName(prefix, "lease prefix");
      const entries = await readDirectory(root);
      const leases = await Promise.all(entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readJsonIfPresent<LeaseRecord<T>>(join(root, entry))));
      return leases
        .filter((entry): entry is LeaseRecord<T> => Boolean(entry && !leaseExpired(entry) && entry.key.startsWith(prefix)))
        .sort((left, right) => left.key.localeCompare(right.key));
    },
  };
}

export function createFileCapacityLeaseStore(rootDir: string): CapacityLeaseStore {
  const root = resolve(rootDir, "capacity-leases");
  return {
    async acquire<T>(scope: string, key: string, owner: string, limit: number, ttlMs: number, value: T) {
      validateCapacityLease(scope, key, owner, limit, ttlMs);
      return withFileLock(rootDir, `capacity:${scope}`, async () => {
        const active = await activeCapacityLeases<T>(root, scope);
        const existing = active.find((lease) => lease.key === key);
        if (existing) return { lease: existing.owner === owner ? existing : undefined, active, limit };
        if (active.length >= limit) return { active, limit };
        const acquiredAt = new Date().toISOString();
        const lease: LeaseRecord<T> = {
          key,
          owner,
          acquiredAt,
          expiresAt: new Date(Date.parse(acquiredAt) + ttlMs).toISOString(),
          value,
        };
        await writeJsonAtomic(capacityLeasePath(root, scope, key), lease);
        return { lease, active: [...active, lease], limit };
      });
    },
    async refresh<T>(scope: string, key: string, owner: string, ttlMs: number): Promise<LeaseRecord<T> | undefined> {
      validateCapacityLease(scope, key, owner, 1, ttlMs);
      return withFileLock(rootDir, `capacity:${scope}`, async () => {
        const path = capacityLeasePath(root, scope, key);
        const current = await readJsonIfPresent<LeaseRecord<T>>(path);
        if (!current || current.owner !== owner || leaseExpired(current)) return undefined;
        const next = { ...current, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
        await writeJsonAtomic(path, next);
        return next;
      });
    },
    async release(scope: string, key: string, owner: string): Promise<boolean> {
      validateCapacityLease(scope, key, owner, 1, 1);
      return withFileLock(rootDir, `capacity:${scope}`, async () => {
        const path = capacityLeasePath(root, scope, key);
        const current = await readJsonIfPresent<LeaseRecord>(path);
        if (!current || current.owner !== owner) return false;
        await unlink(path).catch((error) => {
          if (!isNotFound(error)) throw error;
        });
        return true;
      });
    },
    async list<T>(scope: string): Promise<Array<LeaseRecord<T>>> {
      assertStateName(scope, "capacity scope");
      return withFileLock(rootDir, `capacity:${scope}`, () => activeCapacityLeases<T>(root, scope));
    },
  };
}

export function createFileQueueStore(rootDir: string): QueueStore {
  const root = resolve(rootDir, "queues");
  return {
    async enqueue<T>(queue: string, id: string, value: T): Promise<QueueItem<T>> {
      return mutateQueue<T, QueueItem<T>>(rootDir, root, queue, (items) => {
        if (items.some((item) => item.id === id)) throw new StateConflictError(`queue item already exists: ${queue}/${id}`);
        const item: QueueItem<T> = { queue, id, enqueuedAt: new Date().toISOString(), value };
        items.push(item);
        return { items, result: item };
      });
    },
    async claim<T>(queue: string, id: string, owner: string, ttlMs: number): Promise<QueueItem<T> | undefined> {
      positiveTtlMs(ttlMs);
      assertStateName(queue, "queue");
      assertStateName(id, "queue item id");
      assertStateName(owner, "queue owner");
      return mutateQueue<T, QueueItem<T> | undefined>(rootDir, root, queue, (items) => {
        const item = items.find((entry) => entry.id === id);
        const now = Date.now();
        if (!item || item.claim && Date.parse(item.claim.expiresAt) > now) return { items, result: undefined };
        const claimedAt = new Date(now).toISOString();
        item.claim = { owner, claimedAt, expiresAt: new Date(now + ttlMs).toISOString() };
        return { items, result: item };
      });
    },
    async claimNext<T>(queue: string, owner: string, ttlMs: number): Promise<QueueItem<T> | undefined> {
      positiveTtlMs(ttlMs);
      assertStateName(owner, "queue owner");
      return mutateQueue<T, QueueItem<T> | undefined>(rootDir, root, queue, (items) => {
        const now = Date.now();
        for (const item of items) {
          if (item.claim && Date.parse(item.claim.expiresAt) > now) continue;
          const claimedAt = new Date(now).toISOString();
          item.claim = { owner, claimedAt, expiresAt: new Date(now + ttlMs).toISOString() };
          return { items, result: item };
        }
        return { items, result: undefined };
      });
    },
    async release<T>(queue: string, id: string, owner: string): Promise<boolean> {
      return mutateQueue<T, boolean>(rootDir, root, queue, (items) => {
        const item = items.find((entry) => entry.id === id);
        if (!item?.claim || item.claim.owner !== owner) return { items, result: false };
        delete item.claim;
        return { items, result: true };
      });
    },
    async acknowledge<T>(queue: string, id: string, owner: string): Promise<boolean> {
      return mutateQueue<T, boolean>(rootDir, root, queue, (items) => {
        const index = items.findIndex((entry) => entry.id === id && entry.claim?.owner === owner);
        if (index < 0) return { items, result: false };
        items.splice(index, 1);
        return { items, result: true };
      });
    },
    async list<T>(queue: string): Promise<Array<QueueItem<T>>> {
      return readJsonIfPresent<Array<QueueItem<T>>>(queuePath(root, queue)).then((items) => items ?? []);
    },
  };
}

async function mutateQueue<T, R>(
  stateRoot: string,
  queueRoot: string,
  queue: string,
  mutate: (items: Array<QueueItem<T>>) => { items: Array<QueueItem<T>>; result: R },
): Promise<R> {
  const path = queuePath(queueRoot, queue);
  return withFileLock(stateRoot, `queue:${queue}`, async () => {
    const current = await readJsonIfPresent<Array<QueueItem<T>>>(path) ?? [];
    const { items, result } = mutate(current);
    await writeJsonAtomic(path, items);
    return result;
  });
}

function documentPath(root: string, namespace: string, key: string): string {
  return join(root, encoded(assertStateName(namespace, "namespace")), `${encoded(assertStateName(key, "document key"))}.json`);
}

function eventPath(root: string, stream: string): string {
  return join(root, `${encoded(assertStateName(stream, "event stream"))}.jsonl`);
}

function leasePath(root: string, key: string): string {
  return join(root, `${encoded(assertStateName(key, "lease key"))}.json`);
}

function capacityLeasePath(root: string, scope: string, key: string): string {
  return join(root, encoded(assertStateName(scope, "capacity scope")), `${encoded(assertStateName(key, "capacity key"))}.json`);
}

function queuePath(root: string, queue: string): string {
  return join(root, `${encoded(assertStateName(queue, "queue"))}.json`);
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

async function readEventFile<T>(path: string, stream: string): Promise<Array<StoredEvent<T>>> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const event = JSON.parse(line) as StoredEvent<T>;
          return event.stream === stream && Number.isInteger(event.seq) && event.seq > 0 ? [event] : [];
        } catch (error) {
          if (error instanceof SyntaxError) return [];
          throw error;
        }
      });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temp, path);
}

async function withFileLock<T>(rootDir: string, key: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(resolve(rootDir, ".locks"), `${createHash("sha256").update(key).digest("hex")}.lock`);
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const lockStat = await stat(lockPath).catch((statError) => isNotFound(statError) ? undefined : Promise.reject(statError));
      if (lockStat && lockStat.mtimeMs + FILE_LOCK_TIMEOUT_MS <= Date.now()) {
        await unlink(lockPath).catch((unlinkError) => {
          if (!isNotFound(unlinkError)) throw unlinkError;
        });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out acquiring state lock: ${key}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, FILE_LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    await unlink(lockPath).catch((error) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

function assertExpectedVersion(current: number | undefined, expected: number | undefined, namespace: string, key: string): void {
  if (expected === undefined) return;
  if ((current ?? 0) !== expected) {
    throw new StateConflictError(`document version conflict: ${namespace}/${key}; expected ${expected}, observed ${current ?? 0}`);
  }
}

function leaseExpired(lease: Pick<LeaseRecord, "expiresAt">): boolean {
  const expiresAt = Date.parse(lease.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

async function activeCapacityLeases<T>(root: string, scope: string): Promise<Array<LeaseRecord<T>>> {
  const dir = join(root, encoded(assertStateName(scope, "capacity scope")));
  const entries = await readDirectory(dir);
  const active: Array<LeaseRecord<T>> = [];
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    const path = join(dir, entry);
    const lease = await readJsonIfPresent<LeaseRecord<T>>(path);
    if (!lease || leaseExpired(lease)) {
      await unlink(path).catch((error) => {
        if (!isNotFound(error)) throw error;
      });
      continue;
    }
    active.push(lease);
  }
  return active.sort((left, right) => left.key.localeCompare(right.key));
}

function validateCapacityLease(scope: string, key: string, owner: string, limit: number, ttlMs: number): void {
  assertStateName(scope, "capacity scope");
  assertStateName(key, "capacity key");
  assertStateName(owner, "capacity owner");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new Error("capacity limit must be between 1 and 100000");
  positiveTtlMs(ttlMs);
}

async function readDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
