import { createClient, type RedisClientType } from "redis";

import {
  StateConflictError,
  assertStateName,
  positiveTtlMs,
  type LeaseRecord,
  type LeaseStore,
  type CapacityLeaseResult,
  type CapacityLeaseStore,
  type QueueClaim,
  type QueueItem,
  type QueueStore,
} from "./contracts.js";

export interface RedisCoordinationOptions {
  url: string;
  prefix?: string;
  client?: RedisClientType;
}

export interface RedisCoordinationStore {
  kind: "redis";
  client: RedisClientType;
  leases: LeaseStore;
  capacityLeases: CapacityLeaseStore;
  queues: QueueStore;
  close(): Promise<void>;
}

export async function createRedisCoordinationStore(options: RedisCoordinationOptions): Promise<RedisCoordinationStore> {
  const client = options.client ?? createClient({ url: options.url });
  const ownsClient = !options.client;
  if (!client.isOpen) await client.connect();
  const prefix = redisPrefix(options.prefix ?? "loom");
  return {
    kind: "redis",
    client,
    leases: createRedisLeaseStore(client, prefix),
    capacityLeases: createRedisCapacityLeaseStore(client, prefix),
    queues: createRedisQueueStore(client, prefix),
    close: async () => {
      if (ownsClient && client.isOpen) await client.quit();
    },
  };
}

export function createRedisCapacityLeaseStore(client: RedisClientType, prefix = "loom"): CapacityLeaseStore {
  const safePrefix = redisPrefix(prefix);
  return {
    async acquire<T>(scope: string, key: string, owner: string, limit: number, ttlMs: number, value: T): Promise<CapacityLeaseResult<T>> {
      validateCapacityLease(scope, key, owner, limit, ttlMs);
      const now = Date.now();
      const acquiredAt = new Date(now).toISOString();
      const lease: LeaseRecord<T> = {
        key,
        owner,
        acquiredAt,
        expiresAt: new Date(now + ttlMs).toISOString(),
        value,
      };
      const result = await evalRedis(client, ACQUIRE_CAPACITY_LEASE_SCRIPT, [
        capacityScopeRedisKey(safePrefix, scope),
        capacityLeaseRedisKey(safePrefix, scope, key),
      ], [String(now), String(now + ttlMs), String(ttlMs), String(limit), JSON.stringify(lease)]);
      return parseCapacityLeaseResult<T>(result, limit);
    },
    async refresh<T>(scope: string, key: string, owner: string, ttlMs: number): Promise<LeaseRecord<T> | undefined> {
      validateCapacityLease(scope, key, owner, 1, ttlMs);
      const now = Date.now();
      const result = await evalRedis(client, REFRESH_CAPACITY_LEASE_SCRIPT, [
        capacityScopeRedisKey(safePrefix, scope),
        capacityLeaseRedisKey(safePrefix, scope, key),
      ], [owner, String(now + ttlMs), String(ttlMs), new Date(now + ttlMs).toISOString()]);
      return typeof result === "string" && result ? JSON.parse(result) as LeaseRecord<T> : undefined;
    },
    async release(scope: string, key: string, owner: string): Promise<boolean> {
      validateCapacityLease(scope, key, owner, 1, 1);
      return Number(await evalRedis(client, RELEASE_CAPACITY_LEASE_SCRIPT, [
        capacityScopeRedisKey(safePrefix, scope),
        capacityLeaseRedisKey(safePrefix, scope, key),
      ], [owner])) === 1;
    },
    async list<T>(scope: string): Promise<Array<LeaseRecord<T>>> {
      assertStateName(scope, "capacity scope");
      const result = await evalRedis(client, LIST_CAPACITY_LEASES_SCRIPT, [capacityScopeRedisKey(safePrefix, scope)], [String(Date.now())]);
      return typeof result === "string" && result ? JSON.parse(result) as Array<LeaseRecord<T>> : [];
    },
  };
}

export function createRedisLeaseStore(client: RedisClientType, prefix = "loom"): LeaseStore {
  const safePrefix = redisPrefix(prefix);
  return {
    async acquire<T>(key: string, owner: string, ttlMs: number, value: T): Promise<LeaseRecord<T> | undefined> {
      positiveTtlMs(ttlMs);
      validateLease(key, owner);
      const acquiredAt = new Date().toISOString();
      const lease: LeaseRecord<T> = {
        key,
        owner,
        acquiredAt,
        expiresAt: new Date(Date.parse(acquiredAt) + ttlMs).toISOString(),
        value,
      };
      const result = await client.sendCommand(["SET", leaseRedisKey(safePrefix, key), JSON.stringify(lease), "PX", String(ttlMs), "NX"]);
      return String(result) === "OK" ? lease : undefined;
    },
    async refresh<T>(key: string, owner: string, ttlMs: number): Promise<LeaseRecord<T> | undefined> {
      positiveTtlMs(ttlMs);
      validateLease(key, owner);
      const result = await evalRedis(client, REFRESH_LEASE_SCRIPT, [leaseRedisKey(safePrefix, key)], [
        owner,
        String(ttlMs),
        new Date(Date.now() + ttlMs).toISOString(),
      ]);
      return typeof result === "string" && result ? JSON.parse(result) as LeaseRecord<T> : undefined;
    },
    async release(key: string, owner: string): Promise<boolean> {
      validateLease(key, owner);
      return Number(await evalRedis(client, RELEASE_LEASE_SCRIPT, [leaseRedisKey(safePrefix, key)], [owner])) === 1;
    },
    async get<T>(key: string): Promise<LeaseRecord<T> | undefined> {
      assertStateName(key, "lease key");
      const raw = await client.sendCommand(["GET", leaseRedisKey(safePrefix, key)]);
      return typeof raw === "string" ? JSON.parse(raw) as LeaseRecord<T> : undefined;
    },
    async list<T>(prefixValue = ""): Promise<Array<LeaseRecord<T>>> {
      if (prefixValue) assertStateName(prefixValue, "lease prefix");
      const keys = await scanKeys(client, `${safePrefix}:lease:*`);
      if (!keys.length) return [];
      const values = await Promise.all(keys.map((key) => client.sendCommand(["GET", key])));
      return values
        .flatMap((raw) => typeof raw === "string" ? [JSON.parse(raw) as LeaseRecord<T>] : [])
        .filter((lease) => lease.key.startsWith(prefixValue))
        .sort((left, right) => left.key.localeCompare(right.key));
    },
  };
}

export function createRedisQueueStore(client: RedisClientType, prefix = "loom"): QueueStore {
  const safePrefix = redisPrefix(prefix);
  return {
    async enqueue<T>(queue: string, id: string, value: T): Promise<QueueItem<T>> {
      validateQueue(queue, id);
      const item: QueueItem<T> = { queue, id, enqueuedAt: new Date().toISOString(), value };
      const result = await evalRedis(client, ENQUEUE_SCRIPT, queueRedisKeys(safePrefix, queue), [id, JSON.stringify(item)]);
      if (Number(result) !== 1) throw new StateConflictError(`queue item already exists: ${queue}/${id}`);
      return item;
    },
    async claim<T>(queue: string, id: string, owner: string, ttlMs: number): Promise<QueueItem<T> | undefined> {
      validateQueue(queue, id);
      assertStateName(owner, "queue owner");
      positiveTtlMs(ttlMs);
      const now = Date.now();
      const claim = redisQueueClaim(owner, now, ttlMs);
      const result = await evalRedis(client, CLAIM_QUEUE_SCRIPT, queueRedisKeys(safePrefix, queue), [
        id,
        JSON.stringify(claim),
        String(now),
      ]);
      return parseClaimedQueueItem<T>(result);
    },
    async claimNext<T>(queue: string, owner: string, ttlMs: number): Promise<QueueItem<T> | undefined> {
      assertStateName(queue, "queue");
      assertStateName(owner, "queue owner");
      positiveTtlMs(ttlMs);
      const now = Date.now();
      const claim = redisQueueClaim(owner, now, ttlMs);
      const result = await evalRedis(client, CLAIM_NEXT_SCRIPT, queueRedisKeys(safePrefix, queue), [
        JSON.stringify(claim),
        String(now),
      ]);
      return parseClaimedQueueItem<T>(result);
    },
    async release(queue: string, id: string, owner: string): Promise<boolean> {
      validateQueue(queue, id);
      assertStateName(owner, "queue owner");
      return Number(await evalRedis(client, RELEASE_QUEUE_SCRIPT, queueRedisKeys(safePrefix, queue), [id, owner])) === 1;
    },
    async acknowledge(queue: string, id: string, owner: string): Promise<boolean> {
      validateQueue(queue, id);
      assertStateName(owner, "queue owner");
      return Number(await evalRedis(client, ACK_QUEUE_SCRIPT, queueRedisKeys(safePrefix, queue), [id, owner])) === 1;
    },
    async list<T>(queue: string): Promise<Array<QueueItem<T>>> {
      assertStateName(queue, "queue");
      const [orderKey, itemsKey, claimsKey] = queueRedisKeys(safePrefix, queue);
      const idsRaw = await client.sendCommand(["ZRANGE", orderKey, "0", "-1"]);
      const ids = Array.isArray(idsRaw) ? idsRaw.map(String) : [];
      if (!ids.length) return [];
      const [itemsRaw, claimsRaw] = await Promise.all([
        client.sendCommand(["HMGET", itemsKey, ...ids]),
        client.sendCommand(["HMGET", claimsKey, ...ids]),
      ]);
      const items = Array.isArray(itemsRaw) ? itemsRaw : [];
      const claims = Array.isArray(claimsRaw) ? claimsRaw : [];
      return ids.flatMap((id, index) => parseListedQueueItem<T>(id, items[index], claims[index]));
    },
  };
}

const REFRESH_LEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local lease = cjson.decode(raw)
if lease.owner ~= ARGV[1] then return '' end
lease.expiresAt = ARGV[3]
local encoded = cjson.encode(lease)
redis.call('SET', KEYS[1], encoded, 'PX', ARGV[2], 'XX')
return encoded
`;

const ACQUIRE_CAPACITY_LEASE_SCRIPT = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, leaseKey in ipairs(expired) do redis.call('DEL', leaseKey) end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local existing = redis.call('GET', KEYS[2])
if existing then
  local requested = cjson.decode(ARGV[5])
  local current = cjson.decode(existing)
  local activeKeys = redis.call('ZRANGE', KEYS[1], 0, -1)
  local active = {}
  for _, leaseKey in ipairs(activeKeys) do
    local raw = redis.call('GET', leaseKey)
    if raw then table.insert(active, cjson.decode(raw)) end
  end
  if current.owner == requested.owner then
    return cjson.encode({ lease = current, active = active })
  end
  return cjson.encode({ active = active })
end
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[4]) then
  local activeKeys = redis.call('ZRANGE', KEYS[1], 0, -1)
  local active = {}
  for _, leaseKey in ipairs(activeKeys) do
    local raw = redis.call('GET', leaseKey)
    if raw then table.insert(active, cjson.decode(raw)) end
  end
  return cjson.encode({ active = active })
end
redis.call('SET', KEYS[2], ARGV[5], 'PX', ARGV[3], 'NX')
redis.call('ZADD', KEYS[1], ARGV[2], KEYS[2])
local activeKeys = redis.call('ZRANGE', KEYS[1], 0, -1)
local active = {}
for _, leaseKey in ipairs(activeKeys) do
  local raw = redis.call('GET', leaseKey)
  if raw then table.insert(active, cjson.decode(raw)) end
end
return cjson.encode({ lease = cjson.decode(ARGV[5]), active = active })
`;

const CLAIM_QUEUE_SCRIPT = `
local item = redis.call('HGET', KEYS[2], ARGV[1])
if not item then return {} end
local rawClaim = redis.call('HGET', KEYS[3], ARGV[1])
if rawClaim then
  local claim = cjson.decode(rawClaim)
  if tonumber(claim.expiresAtMs or 0) > tonumber(ARGV[3]) then return {} end
end
redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])
return { item, ARGV[2] }
`;

const REFRESH_CAPACITY_LEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[2])
if not raw then return '' end
local lease = cjson.decode(raw)
if lease.owner ~= ARGV[1] then return '' end
lease.expiresAt = ARGV[4]
local encoded = cjson.encode(lease)
redis.call('SET', KEYS[2], encoded, 'PX', ARGV[3], 'XX')
redis.call('ZADD', KEYS[1], ARGV[2], KEYS[2])
return encoded
`;

const RELEASE_CAPACITY_LEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[2])
if not raw then
  redis.call('ZREM', KEYS[1], KEYS[2])
  return 0
end
local lease = cjson.decode(raw)
if lease.owner ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[1], KEYS[2])
return 1
`;

const LIST_CAPACITY_LEASES_SCRIPT = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, leaseKey in ipairs(expired) do redis.call('DEL', leaseKey) end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local activeKeys = redis.call('ZRANGE', KEYS[1], 0, -1)
local active = {}
for _, leaseKey in ipairs(activeKeys) do
  local raw = redis.call('GET', leaseKey)
  if raw then table.insert(active, cjson.decode(raw)) end
end
return cjson.encode(active)
`;

const RELEASE_LEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local lease = cjson.decode(raw)
if lease.owner ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

const ENQUEUE_SCRIPT = `
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then return 0 end
local sequence = redis.call('INCR', KEYS[4])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[1], sequence, ARGV[1])
return 1
`;

const CLAIM_NEXT_SCRIPT = `
local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
for _, id in ipairs(ids) do
  local item = redis.call('HGET', KEYS[2], id)
  local rawClaim = redis.call('HGET', KEYS[3], id)
  local available = not rawClaim
  if rawClaim then
    local claim = cjson.decode(rawClaim)
    available = tonumber(claim.expiresAtMs or 0) <= tonumber(ARGV[2])
  end
  if item and available then
    redis.call('HSET', KEYS[3], id, ARGV[1])
    return { item, ARGV[1] }
  end
end
return {}
`;

const RELEASE_QUEUE_SCRIPT = `
local rawClaim = redis.call('HGET', KEYS[3], ARGV[1])
if not rawClaim then return 0 end
local claim = cjson.decode(rawClaim)
if claim.owner ~= ARGV[2] then return 0 end
return redis.call('HDEL', KEYS[3], ARGV[1])
`;

const ACK_QUEUE_SCRIPT = `
local rawClaim = redis.call('HGET', KEYS[3], ARGV[1])
if not rawClaim then return 0 end
local claim = cjson.decode(rawClaim)
if claim.owner ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`;

interface RedisQueueClaim extends QueueClaim {
  expiresAtMs: number;
}

function redisQueueClaim(owner: string, now: number, ttlMs: number): RedisQueueClaim {
  return {
    owner,
    claimedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    expiresAtMs: now + ttlMs,
  };
}

function parseClaimedQueueItem<T>(value: unknown): QueueItem<T> | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  return parseQueueItem<T>(value[0], value[1]);
}

function parseListedQueueItem<T>(id: string, itemValue: unknown, claimValue: unknown): Array<QueueItem<T>> {
  const item = parseQueueItem<T>(itemValue, claimValue);
  return item?.id === id ? [item] : [];
}

function parseQueueItem<T>(itemValue: unknown, claimValue: unknown): QueueItem<T> | undefined {
  if (typeof itemValue !== "string") return undefined;
  const item = JSON.parse(itemValue) as QueueItem<T>;
  if (typeof claimValue !== "string") return item;
  const claim = JSON.parse(claimValue) as RedisQueueClaim;
  if (!Number.isFinite(claim.expiresAtMs) || claim.expiresAtMs <= Date.now()) return item;
  item.claim = { owner: claim.owner, claimedAt: claim.claimedAt, expiresAt: claim.expiresAt };
  return item;
}

async function evalRedis(client: RedisClientType, script: string, keys: string[], args: string[]): Promise<unknown> {
  return client.sendCommand(["EVAL", script, String(keys.length), ...keys, ...args]);
}

async function scanKeys(client: RedisClientType, pattern: string): Promise<string[]> {
  let cursor = "0";
  const keys: string[] = [];
  do {
    const response = await client.sendCommand(["SCAN", cursor, "MATCH", pattern, "COUNT", "200"]);
    if (!Array.isArray(response) || response.length !== 2) break;
    cursor = String(response[0]);
    if (Array.isArray(response[1])) keys.push(...response[1].map(String));
  } while (cursor !== "0");
  return keys;
}

function leaseRedisKey(prefix: string, key: string): string {
  return `${prefix}:lease:${encodeURIComponent(assertStateName(key, "lease key"))}`;
}

function queueRedisKeys(prefix: string, queue: string): [string, string, string, string] {
  const key = `${prefix}:queue:${encodeURIComponent(assertStateName(queue, "queue"))}`;
  return [`${key}:order`, `${key}:items`, `${key}:claims`, `${key}:sequence`];
}

function capacityScopeRedisKey(prefix: string, scope: string): string {
  return `${prefix}:capacity:${encodeURIComponent(assertStateName(scope, "capacity scope"))}`;
}

function capacityLeaseRedisKey(prefix: string, scope: string, key: string): string {
  return `${prefix}:capacity-lease:${encodeURIComponent(assertStateName(scope, "capacity scope"))}:${encodeURIComponent(assertStateName(key, "capacity key"))}`;
}

function validateLease(key: string, owner: string): void {
  assertStateName(key, "lease key");
  assertStateName(owner, "lease owner");
}

function validateQueue(queue: string, id: string): void {
  assertStateName(queue, "queue");
  assertStateName(id, "queue item id");
}

function validateCapacityLease(scope: string, key: string, owner: string, limit: number, ttlMs: number): void {
  assertStateName(scope, "capacity scope");
  assertStateName(key, "capacity key");
  assertStateName(owner, "capacity owner");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new Error("capacity limit must be between 1 and 100000");
  positiveTtlMs(ttlMs);
}

function parseCapacityLeaseResult<T>(value: unknown, limit: number): CapacityLeaseResult<T> {
  if (typeof value !== "string" || !value) return { active: [], limit };
  const parsed = JSON.parse(value) as { lease?: LeaseRecord<T>; active?: Array<LeaseRecord<T>> };
  return {
    ...(parsed.lease ? { lease: parsed.lease } : {}),
    active: Array.isArray(parsed.active) ? parsed.active : [],
    limit,
  };
}

function redisPrefix(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)) throw new Error("Redis prefix must be a safe identifier");
  return value;
}
