export interface StoredDocument<T = unknown> {
  namespace: string;
  key: string;
  version: number;
  value: T;
  updatedAt: string;
}

export interface PutDocumentOptions {
  expectedVersion?: number;
}

export interface DocumentStore {
  get<T = unknown>(namespace: string, key: string): Promise<StoredDocument<T> | undefined>;
  put<T = unknown>(namespace: string, key: string, value: T, options?: PutDocumentOptions): Promise<StoredDocument<T>>;
  delete(namespace: string, key: string, options?: PutDocumentOptions): Promise<boolean>;
  list<T = unknown>(namespace: string, prefix?: string): Promise<Array<StoredDocument<T>>>;
}

export interface StoredEvent<T = unknown> {
  stream: string;
  seq: number;
  ts: string;
  value: T;
}

export interface EventStore {
  append<T = unknown>(stream: string, value: T): Promise<StoredEvent<T>>;
  read<T = unknown>(stream: string, afterSeq?: number, limit?: number): Promise<Array<StoredEvent<T>>>;
}

export interface LeaseRecord<T = unknown> {
  key: string;
  owner: string;
  acquiredAt: string;
  expiresAt: string;
  value: T;
}

export interface LeaseStore {
  acquire<T = unknown>(key: string, owner: string, ttlMs: number, value: T): Promise<LeaseRecord<T> | undefined>;
  refresh<T = unknown>(key: string, owner: string, ttlMs: number): Promise<LeaseRecord<T> | undefined>;
  release(key: string, owner: string): Promise<boolean>;
  get<T = unknown>(key: string): Promise<LeaseRecord<T> | undefined>;
  list<T = unknown>(prefix?: string): Promise<Array<LeaseRecord<T>>>;
}

export interface CapacityLeaseResult<T = unknown> {
  lease?: LeaseRecord<T>;
  active: Array<LeaseRecord<T>>;
  limit: number;
}

export interface CapacityLeaseStore {
  acquire<T = unknown>(scope: string, key: string, owner: string, limit: number, ttlMs: number, value: T): Promise<CapacityLeaseResult<T>>;
  refresh<T = unknown>(scope: string, key: string, owner: string, ttlMs: number): Promise<LeaseRecord<T> | undefined>;
  release(scope: string, key: string, owner: string): Promise<boolean>;
  list<T = unknown>(scope: string): Promise<Array<LeaseRecord<T>>>;
}

export interface QueueClaim {
  owner: string;
  claimedAt: string;
  expiresAt: string;
}

export interface QueueItem<T = unknown> {
  queue: string;
  id: string;
  enqueuedAt: string;
  value: T;
  claim?: QueueClaim;
}

export interface QueueStore {
  enqueue<T = unknown>(queue: string, id: string, value: T): Promise<QueueItem<T>>;
  claim<T = unknown>(queue: string, id: string, owner: string, ttlMs: number): Promise<QueueItem<T> | undefined>;
  claimNext<T = unknown>(queue: string, owner: string, ttlMs: number): Promise<QueueItem<T> | undefined>;
  release(queue: string, id: string, owner: string): Promise<boolean>;
  acknowledge(queue: string, id: string, owner: string): Promise<boolean>;
  list<T = unknown>(queue: string): Promise<Array<QueueItem<T>>>;
}

export interface PlatformStateBackend {
  kind: string;
  documents: DocumentStore;
  events: EventStore;
  leases: LeaseStore;
  capacityLeases: CapacityLeaseStore;
  queues: QueueStore;
  close(): Promise<void>;
}

export class StateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateConflictError";
  }
}

export function assertStateName(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(value) || value.includes("..")) {
    throw new Error(`${label} must be a safe non-empty state identifier`);
  }
  return value;
}

export function positiveTtlMs(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 7 * 24 * 60 * 60 * 1000) {
    throw new Error("ttlMs must be an integer between 1 and 604800000");
  }
  return value;
}
