import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { TenantAuditActor } from "./audit.js";
import { assertTenantName } from "../tenant.js";

export const OPERATOR_COCKPIT_EXECUTION_QUEUE_DIR = "operator-cockpit-queue";
export const OPERATOR_COCKPIT_EXECUTION_QUEUE_ITEM_SCHEMA_VERSION = "platform-operator-cockpit-loop-queue-item/v1";
export const OPERATOR_COCKPIT_EXECUTION_QUEUE_CLAIM_SCHEMA_VERSION = "platform-operator-cockpit-loop-queue-claim/v1";
export const OPERATOR_COCKPIT_EXECUTION_QUEUE_CLAIM_TTL_MS = 30 * 60 * 1000;
const AGENT_GIT_SERVICE_OPERATOR_COCKPIT_QUEUE_STORE_SCHEMA_VERSION = "platform-operator-cockpit-loop-ags-queue-store/v1";
export const DEFAULT_AGENT_GIT_SERVICE_OPERATOR_COCKPIT_QUEUE_STORE_PATH = ".loom/operator-cockpit-queue/store.json";

export type OperatorCockpitQueueAccess = TenantAuditActor & { modelKeyEnv?: string };

export interface OperatorCockpitExecutionQueueItem {
  queueId: string;
  tenant: string;
  dir: string;
  enqueuedAt: string;
  startedAt?: string;
  status: "queued" | "running";
  clientId?: string;
  access?: OperatorCockpitQueueAccess;
  ciTarget: { repo?: string; ref?: string };
  maxSteps: number;
  requireExternalStaging?: boolean;
  requireOperatorApprovals?: boolean;
  requireAgentGitService?: boolean;
}

export interface OperatorCockpitExecutionQueueClaim {
  schemaVersion: typeof OPERATOR_COCKPIT_EXECUTION_QUEUE_CLAIM_SCHEMA_VERSION;
  tokenFree: true;
  queueId: string;
  tenant: string;
  dir: string;
  owner: string;
  claimedAt: string;
  expiresAt: string;
  ttlMs: number;
}

export interface OperatorCockpitExecutionQueueSummary {
  queueId: string;
  status: OperatorCockpitExecutionQueueItem["status"];
  queuePosition: number;
  enqueuedAt: string;
  startedAt?: string;
  clientId?: string;
  maxSteps: number;
  githubTarget?: { repo?: string; ref?: string };
  claim?: {
    tokenFree: true;
    owner: string;
    claimedAt: string;
    expiresAt: string;
    ttlMs: number;
  };
}

export interface OperatorCockpitQueueBackend {
  persist(item: OperatorCockpitExecutionQueueItem): Promise<void>;
  itemExists(item: OperatorCockpitExecutionQueueItem): Promise<boolean>;
  removeItem(item: OperatorCockpitExecutionQueueItem): Promise<void>;
  acquireClaim(item: OperatorCockpitExecutionQueueItem): Promise<OperatorCockpitExecutionQueueClaim | undefined>;
  releaseClaim(item: OperatorCockpitExecutionQueueItem, claim: OperatorCockpitExecutionQueueClaim): Promise<void>;
  recover(dir: string): Promise<OperatorCockpitExecutionQueueItem[]>;
  snapshot(queue: OperatorCockpitExecutionQueueItem[], tenant: string, dir: string): Promise<OperatorCockpitExecutionQueueSummary[]>;
  position(queue: OperatorCockpitExecutionQueueItem[], item: OperatorCockpitExecutionQueueItem): number;
}

export interface AgentGitServiceOperatorCockpitQueueBackendOptions {
  baseUrl: string;
  token: string;
  repo: string;
  path?: string;
}

export function normalizeAgentGitServiceOperatorCockpitQueueRepo(value: string): string {
  const repo = value.trim();
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(repo);
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === ".." || match[1].length > 100 || match[2].length > 100) {
    throw new Error("agent-git-service queue repo must be formatted as a safe owner/repo value");
  }
  return repo;
}

export function normalizeAgentGitServiceOperatorCockpitQueuePath(value?: string): string {
  const path = value?.trim() || DEFAULT_AGENT_GIT_SERVICE_OPERATOR_COCKPIT_QUEUE_STORE_PATH;
  const segments = path.split("/");
  if (
    path.length > 1024 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment))
  ) {
    throw new Error("agent-git-service queue path must be a safe relative slash-separated path");
  }
  return path;
}

export function createFilesystemOperatorCockpitQueueBackend(): OperatorCockpitQueueBackend {
  return {
    persist: persistOperatorCockpitExecutionQueueItem,
    itemExists: operatorCockpitExecutionQueueItemFileExists,
    removeItem: removeOperatorCockpitExecutionQueueItem,
    acquireClaim: acquireOperatorCockpitExecutionQueueClaim,
    releaseClaim: releaseOperatorCockpitExecutionQueueClaim,
    recover: async (dir) => recoverOperatorCockpitExecutionQueue(dir),
    snapshot: async (queue, tenant, dir) => operatorCockpitExecutionQueueSnapshot(queue, tenant, dir),
    position: operatorCockpitExecutionQueuePosition,
  };
}

export function createAgentGitServiceOperatorCockpitQueueBackend(
  options: AgentGitServiceOperatorCockpitQueueBackendOptions,
): OperatorCockpitQueueBackend {
  const storeOptions = {
    ...options,
    repo: normalizeAgentGitServiceOperatorCockpitQueueRepo(options.repo),
    path: normalizeAgentGitServiceOperatorCockpitQueuePath(options.path),
  };
  return {
    persist: (item) => updateAgentGitServiceOperatorCockpitQueueStore(storeOptions, (store) => {
      const items = store.items.filter((existing) => !sameOperatorCockpitQueueRecord(existing, item));
      items.push(operatorCockpitExecutionQueueItemToStoredRecord(item));
      return { ...store, items };
    }).then(() => undefined),
    itemExists: async (item) => {
      const { store } = await readAgentGitServiceOperatorCockpitQueueStore(storeOptions);
      return store.items.some((existing) => sameOperatorCockpitQueueRecord(existing, item));
    },
    removeItem: (item) => updateAgentGitServiceOperatorCockpitQueueStore(storeOptions, (store) => ({
      ...store,
      items: store.items.filter((existing) => !sameOperatorCockpitQueueRecord(existing, item)),
      claims: store.claims.filter((claim) => !sameOperatorCockpitQueueItem(claim, item)),
    })).then(() => undefined),
    acquireClaim: (item) => updateAgentGitServiceOperatorCockpitQueueStore(storeOptions, (store) => {
      const now = Date.now();
      const claims = store.claims.filter((claim) => !sameOperatorCockpitQueueItem(claim, item) || Date.parse(claim.expiresAt) > now);
      if (claims.some((claim) => sameOperatorCockpitQueueItem(claim, item))) return { store: { ...store, claims }, result: undefined };
      if (!store.items.some((existing) => sameOperatorCockpitQueueRecord(existing, item))) return { store: { ...store, claims }, result: undefined };
      const claim = createOperatorCockpitExecutionQueueClaim(item);
      return { store: { ...store, claims: [...claims, claim] }, result: claim };
    }),
    releaseClaim: (item, claim) => updateAgentGitServiceOperatorCockpitQueueStore(storeOptions, (store) => ({
      ...store,
      claims: store.claims.filter((existing) => !(sameOperatorCockpitQueueItem(existing, item) && existing.owner === claim.owner)),
    })).then(() => undefined),
    recover: async (dir) => {
      const { store } = await readAgentGitServiceOperatorCockpitQueueStore(storeOptions);
      const expectedDir = resolve(dir);
      return store.items
        .map((item) => operatorCockpitExecutionQueueItemFromStoredRecord(item, expectedDir))
        .filter((item): item is OperatorCockpitExecutionQueueItem => Boolean(item));
    },
    snapshot: async (queue, tenant, dir) => {
      const { store } = await readAgentGitServiceOperatorCockpitQueueStore(storeOptions);
      return operatorCockpitExecutionQueueSnapshotFromClaims(queue, tenant, dir, store.claims);
    },
    position: operatorCockpitExecutionQueuePosition,
  };
}

export function operatorCockpitExecutionQueuePosition(queue: OperatorCockpitExecutionQueueItem[], item: OperatorCockpitExecutionQueueItem): number {
  return queue.filter((entry) => entry.tenant === item.tenant && entry.dir === item.dir).findIndex((entry) => entry.queueId === item.queueId) + 1;
}

function operatorCockpitExecutionQueueDir(dir: string): string {
  return join(resolve(dir), ".loom", OPERATOR_COCKPIT_EXECUTION_QUEUE_DIR);
}

function operatorCockpitExecutionQueueItemPath(item: Pick<OperatorCockpitExecutionQueueItem, "dir" | "queueId">): string {
  return join(operatorCockpitExecutionQueueDir(item.dir), `${item.queueId}.json`);
}

function operatorCockpitExecutionQueueClaimPath(item: Pick<OperatorCockpitExecutionQueueItem, "dir" | "queueId">): string {
  return join(operatorCockpitExecutionQueueDir(item.dir), `${item.queueId}.claim.json`);
}

async function persistOperatorCockpitExecutionQueueItem(item: OperatorCockpitExecutionQueueItem): Promise<void> {
  await mkdir(operatorCockpitExecutionQueueDir(item.dir), { recursive: true });
  await writeJsonFileAtomic(operatorCockpitExecutionQueueItemPath(item), compactObject({
    schemaVersion: OPERATOR_COCKPIT_EXECUTION_QUEUE_ITEM_SCHEMA_VERSION,
    tokenFree: true,
    queueId: item.queueId,
    tenant: item.tenant,
    dir: item.dir,
    enqueuedAt: item.enqueuedAt,
    status: "queued",
    clientId: item.clientId,
    ciTarget: item.ciTarget,
    maxSteps: item.maxSteps,
    requireExternalStaging: item.requireExternalStaging,
    requireOperatorApprovals: item.requireOperatorApprovals,
    requireAgentGitService: item.requireAgentGitService,
  }));
}

async function operatorCockpitExecutionQueueItemFileExists(item: OperatorCockpitExecutionQueueItem): Promise<boolean> {
  try {
    const itemStat = await stat(operatorCockpitExecutionQueueItemPath(item));
    return itemStat.isFile();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function removeOperatorCockpitExecutionQueueItem(item: OperatorCockpitExecutionQueueItem): Promise<void> {
  try {
    await unlink(operatorCockpitExecutionQueueItemPath(item));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function acquireOperatorCockpitExecutionQueueClaim(item: OperatorCockpitExecutionQueueItem): Promise<OperatorCockpitExecutionQueueClaim | undefined> {
  await mkdir(operatorCockpitExecutionQueueDir(item.dir), { recursive: true });
  const claim = createOperatorCockpitExecutionQueueClaim(item);
  const path = operatorCockpitExecutionQueueClaimPath(item);
  try {
    const file = await open(path, "wx");
    try {
      await file.writeFile(JSON.stringify(claim, null, 2) + "\n", "utf8");
    } finally {
      await file.close();
    }
    return claim;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    if (await removeStaleOperatorCockpitExecutionQueueClaim(path)) {
      return acquireOperatorCockpitExecutionQueueClaim(item);
    }
    return undefined;
  }
}

function createOperatorCockpitExecutionQueueClaim(item: OperatorCockpitExecutionQueueItem): OperatorCockpitExecutionQueueClaim {
  const claimedAtMs = Date.now();
  return {
    schemaVersion: OPERATOR_COCKPIT_EXECUTION_QUEUE_CLAIM_SCHEMA_VERSION,
    tokenFree: true,
    queueId: item.queueId,
    tenant: item.tenant,
    dir: item.dir,
    owner: `operator-cockpit-queue:${process.pid}:${randomUUID()}`,
    claimedAt: new Date(claimedAtMs).toISOString(),
    expiresAt: new Date(claimedAtMs + OPERATOR_COCKPIT_EXECUTION_QUEUE_CLAIM_TTL_MS).toISOString(),
    ttlMs: OPERATOR_COCKPIT_EXECUTION_QUEUE_CLAIM_TTL_MS,
  };
}

async function releaseOperatorCockpitExecutionQueueClaim(item: OperatorCockpitExecutionQueueItem, claim: OperatorCockpitExecutionQueueClaim): Promise<void> {
  const path = operatorCockpitExecutionQueueClaimPath(item);
  const current = await readOperatorCockpitExecutionQueueClaim(path);
  if (current?.owner !== claim.owner) return;
  await unlink(path).catch((error) => {
    if (!isNotFound(error)) throw error;
  });
}

async function removeStaleOperatorCockpitExecutionQueueClaim(path: string): Promise<boolean> {
  const claim = await readOperatorCockpitExecutionQueueClaim(path);
  if (claim && Date.parse(claim.expiresAt) > Date.now()) return false;
  await unlink(path).catch((error) => {
    if (!isNotFound(error)) throw error;
  });
  return true;
}

async function readOperatorCockpitExecutionQueueClaim(path: string): Promise<OperatorCockpitExecutionQueueClaim | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return operatorCockpitExecutionQueueClaimFromRecord(value);
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function readOperatorCockpitExecutionQueueClaimSync(path: string): OperatorCockpitExecutionQueueClaim | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return operatorCockpitExecutionQueueClaimFromRecord(value);
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function operatorCockpitExecutionQueueClaimFromRecord(value: unknown): OperatorCockpitExecutionQueueClaim | undefined {
  if (!isJsonRecord(value)) return undefined;
  if (value.schemaVersion !== OPERATOR_COCKPIT_EXECUTION_QUEUE_CLAIM_SCHEMA_VERSION) return undefined;
  if (value.tokenFree !== true) return undefined;
  const queueId = stringField(value, "queueId");
  const tenant = stringField(value, "tenant");
  const dir = stringField(value, "dir");
  const owner = stringField(value, "owner");
  const claimedAt = stringField(value, "claimedAt");
  const expiresAt = stringField(value, "expiresAt");
  if (!queueId || !tenant || !dir || !owner || !claimedAt || !expiresAt) return undefined;
  if (!Number.isInteger(value.ttlMs) || (value.ttlMs as number) <= 0) return undefined;
  return {
    schemaVersion: OPERATOR_COCKPIT_EXECUTION_QUEUE_CLAIM_SCHEMA_VERSION,
    tokenFree: true,
    queueId,
    tenant,
    dir,
    owner,
    claimedAt,
    expiresAt,
    ttlMs: value.ttlMs as number,
  };
}

function recoverOperatorCockpitExecutionQueue(dir: string): OperatorCockpitExecutionQueueItem[] {
  const bundleDir = resolve(dir);
  const queue: OperatorCockpitExecutionQueueItem[] = [];
  let entries;
  try {
    entries = readdirSync(operatorCockpitExecutionQueueDir(bundleDir), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return queue;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const value = JSON.parse(readFileSync(join(operatorCockpitExecutionQueueDir(bundleDir), entry.name), "utf8")) as unknown;
      const item = operatorCockpitExecutionQueueItemFromRecord(value, bundleDir, entry.name);
      if (!item) continue;
      if (queue.some((existing) => existing.queueId === item.queueId && existing.tenant === item.tenant && existing.dir === item.dir)) continue;
      queue.push(item);
    } catch (error) {
      if (!isNotFound(error) && !(error instanceof SyntaxError)) throw error;
    }
  }
  return queue;
}

function operatorCockpitExecutionQueueItemFromRecord(
  value: unknown,
  expectedDir: string,
  fileName: string,
): OperatorCockpitExecutionQueueItem | undefined {
  if (!isJsonRecord(value)) return undefined;
  const queueId = stringField(value, "queueId");
  if (!queueId || fileName !== `${queueId}.json`) return undefined;
  return operatorCockpitExecutionQueueItemFromStoredRecord(value, expectedDir);
}

function operatorCockpitExecutionQueueItemFromStoredRecord(
  value: unknown,
  expectedDir: string,
): OperatorCockpitExecutionQueueItem | undefined {
  if (!isJsonRecord(value)) return undefined;
  if (value.schemaVersion !== OPERATOR_COCKPIT_EXECUTION_QUEUE_ITEM_SCHEMA_VERSION) return undefined;
  if (value.tokenFree !== true) return undefined;
  const queueId = stringField(value, "queueId");
  if (!queueId || !isSafeDirectoryName(queueId)) return undefined;
  const tenant = stringField(value, "tenant");
  if (!tenant || !isSafeTenantDirectoryName(tenant)) return undefined;
  const dir = stringField(value, "dir");
  if (!dir || resolve(dir) !== expectedDir) return undefined;
  const enqueuedAt = stringField(value, "enqueuedAt");
  if (!enqueuedAt) return undefined;
  const status = stringField(value, "status");
  if (status !== "queued" && status !== "running") return undefined;
  if (!Number.isInteger(value.maxSteps) || (value.maxSteps as number) < 1 || (value.maxSteps as number) > 20) return undefined;
  const ciTarget = operatorCockpitCiTargetFromStoredValue(value.ciTarget);
  if (!ciTarget) return undefined;
  const clientId = optionalStoredClientId(value.clientId);
  if (value.clientId !== undefined && clientId === undefined) return undefined;
  const optionalBooleans = operatorCockpitStoredOptionalBooleans(value, [
    "requireExternalStaging",
    "requireOperatorApprovals",
    "requireAgentGitService",
  ]);
  if (!optionalBooleans) return undefined;
  return compactObject({
    queueId,
    tenant,
    dir: expectedDir,
    enqueuedAt,
    status: "queued" as const,
    clientId,
    access: { actor: "system", role: "admin" as const },
    ciTarget,
    maxSteps: value.maxSteps as number,
    requireExternalStaging: optionalBooleans.requireExternalStaging,
    requireOperatorApprovals: optionalBooleans.requireOperatorApprovals,
    requireAgentGitService: optionalBooleans.requireAgentGitService,
  });
}

function operatorCockpitExecutionQueueItemToStoredRecord(item: OperatorCockpitExecutionQueueItem): Record<string, unknown> {
  return compactObject({
    schemaVersion: OPERATOR_COCKPIT_EXECUTION_QUEUE_ITEM_SCHEMA_VERSION,
    tokenFree: true,
    queueId: item.queueId,
    tenant: item.tenant,
    dir: item.dir,
    enqueuedAt: item.enqueuedAt,
    status: "queued",
    clientId: item.clientId,
    ciTarget: item.ciTarget,
    maxSteps: item.maxSteps,
    requireExternalStaging: item.requireExternalStaging,
    requireOperatorApprovals: item.requireOperatorApprovals,
    requireAgentGitService: item.requireAgentGitService,
  });
}

function operatorCockpitCiTargetFromStoredValue(value: unknown): { repo?: string; ref?: string } | undefined {
  if (value === undefined) return {};
  if (!isJsonRecord(value)) return undefined;
  const repo = optionalStoredOperatorCockpitRepo(value.repo);
  const ref = optionalStoredOperatorCockpitRef(value.ref);
  if (value.repo !== undefined && repo === undefined) return undefined;
  if (value.ref !== undefined && ref === undefined) return undefined;
  return compactObject({ repo, ref });
}

function optionalStoredOperatorCockpitRepo(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return undefined;
  const repo = value.trim();
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : undefined;
}

function optionalStoredOperatorCockpitRef(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return undefined;
  const ref = value.trim();
  if (!ref || ref.startsWith("-") || ref.includes("..") || /[\s\0]/.test(ref)) return undefined;
  return ref;
}

function operatorCockpitStoredOptionalBooleans(
  value: Record<string, unknown>,
  keys: Array<"requireExternalStaging" | "requireOperatorApprovals" | "requireAgentGitService">,
): Record<(typeof keys)[number], boolean | undefined> | undefined {
  const result: Record<string, boolean | undefined> = {};
  for (const key of keys) {
    if (value[key] === undefined) {
      result[key] = undefined;
      continue;
    }
    if (typeof value[key] !== "boolean") return undefined;
    result[key] = value[key];
  }
  return result as Record<(typeof keys)[number], boolean | undefined>;
}

function operatorCockpitExecutionQueueSnapshot(
  queue: OperatorCockpitExecutionQueueItem[],
  tenant: string,
  dir: string,
): OperatorCockpitExecutionQueueSummary[] {
  const claims = queue
    .map((item) => readOperatorCockpitExecutionQueueClaimSync(operatorCockpitExecutionQueueClaimPath(item)))
    .filter((claim): claim is OperatorCockpitExecutionQueueClaim => Boolean(claim));
  return operatorCockpitExecutionQueueSnapshotFromClaims(queue, tenant, dir, claims);
}

function operatorCockpitExecutionQueueSnapshotFromClaims(
  queue: OperatorCockpitExecutionQueueItem[],
  tenant: string,
  dir: string,
  claims: OperatorCockpitExecutionQueueClaim[],
): OperatorCockpitExecutionQueueSummary[] {
  return queue
    .filter((item) => item.tenant === tenant && item.dir === dir)
    .map((item, index) => {
      const claim = claims.find((entry) => sameOperatorCockpitQueueItem(entry, item));
      return compactObject({
        queueId: item.queueId,
        status: item.status,
        queuePosition: index + 1,
        enqueuedAt: item.enqueuedAt,
        startedAt: item.startedAt,
        clientId: item.clientId,
        maxSteps: item.maxSteps,
        ...(Object.keys(item.ciTarget).length ? { githubTarget: item.ciTarget } : {}),
        ...(claim ? {
          claim: {
            tokenFree: true as const,
            owner: claim.owner,
            claimedAt: claim.claimedAt,
            expiresAt: claim.expiresAt,
            ttlMs: claim.ttlMs,
          },
        } : {}),
      });
    });
}

interface AgentGitServiceOperatorCockpitQueueStore {
  schemaVersion: typeof AGENT_GIT_SERVICE_OPERATOR_COCKPIT_QUEUE_STORE_SCHEMA_VERSION;
  tokenFree: true;
  updatedAt: string;
  items: Record<string, unknown>[];
  claims: OperatorCockpitExecutionQueueClaim[];
}

interface AgentGitServiceOperatorCockpitQueueStoreRead {
  store: AgentGitServiceOperatorCockpitQueueStore;
  sha?: string;
}

type AgentGitServiceOperatorCockpitQueueStoreMutation<T> =
  | AgentGitServiceOperatorCockpitQueueStore
  | { store: AgentGitServiceOperatorCockpitQueueStore; result: T };

async function updateAgentGitServiceOperatorCockpitQueueStore<T = void>(
  options: Required<AgentGitServiceOperatorCockpitQueueBackendOptions>,
  mutate: (store: AgentGitServiceOperatorCockpitQueueStore) => AgentGitServiceOperatorCockpitQueueStoreMutation<T>,
): Promise<T> {
  let lastConflict: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readAgentGitServiceOperatorCockpitQueueStore(options);
    const mutation = mutate(current.store);
    const store = "store" in mutation ? mutation.store : mutation;
    const result = "store" in mutation ? mutation.result : undefined;
    try {
      await writeAgentGitServiceOperatorCockpitQueueStore(options, {
        ...store,
        updatedAt: new Date().toISOString(),
      }, current.sha);
      return result as T;
    } catch (error) {
      if (!(error instanceof AgentGitServiceQueueStoreConflict)) throw error;
      lastConflict = error;
    }
  }
  throw lastConflict instanceof Error ? lastConflict : new Error("agent-git-service queue store update conflicted");
}

async function readAgentGitServiceOperatorCockpitQueueStore(
  options: Required<AgentGitServiceOperatorCockpitQueueBackendOptions>,
): Promise<AgentGitServiceOperatorCockpitQueueStoreRead> {
  const response = await fetch(agentGitServiceContentsUrl(options), {
    headers: agentGitServiceHeaders(options.token),
  });
  if (response.status === 404) return { store: emptyAgentGitServiceOperatorCockpitQueueStore() };
  if (!response.ok) {
    throw new Error(`agent-git-service cockpit queue store read failed with ${response.status}: ${await response.text()}`);
  }
  const body = await response.json() as Record<string, unknown>;
  const content = typeof body.content === "string" ? body.content : "";
  const decoded = Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
  const store = agentGitServiceOperatorCockpitQueueStoreFromJson(decoded);
  const sha = typeof body.sha === "string" ? body.sha : undefined;
  return { store, sha };
}

async function writeAgentGitServiceOperatorCockpitQueueStore(
  options: Required<AgentGitServiceOperatorCockpitQueueBackendOptions>,
  store: AgentGitServiceOperatorCockpitQueueStore,
  sha: string | undefined,
): Promise<void> {
  const response = await fetch(agentGitServiceContentsUrl(options), {
    method: "PUT",
    headers: {
      ...agentGitServiceHeaders(options.token),
      "content-type": "application/json",
    },
    body: JSON.stringify(compactObject({
      message: "Update Loom operator cockpit queue store",
      content: Buffer.from(JSON.stringify(store, null, 2) + "\n", "utf8").toString("base64"),
      sha,
    })),
  });
  if (response.status === 409 || response.status === 422) {
    throw new AgentGitServiceQueueStoreConflict(await response.text());
  }
  if (!response.ok) {
    throw new Error(`agent-git-service cockpit queue store update failed with ${response.status}: ${await response.text()}`);
  }
}

function agentGitServiceOperatorCockpitQueueStoreFromJson(text: string): AgentGitServiceOperatorCockpitQueueStore {
  try {
    const value = JSON.parse(text) as unknown;
    if (!isJsonRecord(value)) return emptyAgentGitServiceOperatorCockpitQueueStore();
    if (value.schemaVersion !== AGENT_GIT_SERVICE_OPERATOR_COCKPIT_QUEUE_STORE_SCHEMA_VERSION) return emptyAgentGitServiceOperatorCockpitQueueStore();
    if (value.tokenFree !== true) return emptyAgentGitServiceOperatorCockpitQueueStore();
    const items = Array.isArray(value.items) ? value.items.filter(isJsonRecord) : [];
    const claims = Array.isArray(value.claims)
      ? value.claims.map(operatorCockpitExecutionQueueClaimFromRecord).filter((claim): claim is OperatorCockpitExecutionQueueClaim => Boolean(claim))
      : [];
    return {
      schemaVersion: AGENT_GIT_SERVICE_OPERATOR_COCKPIT_QUEUE_STORE_SCHEMA_VERSION,
      tokenFree: true,
      updatedAt: stringField(value, "updatedAt") ?? new Date(0).toISOString(),
      items,
      claims,
    };
  } catch {
    return emptyAgentGitServiceOperatorCockpitQueueStore();
  }
}

function emptyAgentGitServiceOperatorCockpitQueueStore(): AgentGitServiceOperatorCockpitQueueStore {
  return {
    schemaVersion: AGENT_GIT_SERVICE_OPERATOR_COCKPIT_QUEUE_STORE_SCHEMA_VERSION,
    tokenFree: true,
    updatedAt: new Date(0).toISOString(),
    items: [],
    claims: [],
  };
}

function sameOperatorCockpitQueueItem(
  left: Pick<OperatorCockpitExecutionQueueItem, "queueId" | "tenant" | "dir">,
  right: Pick<OperatorCockpitExecutionQueueItem, "queueId" | "tenant" | "dir">,
): boolean {
  return left.queueId === right.queueId && left.tenant === right.tenant && resolve(left.dir) === resolve(right.dir);
}

function sameOperatorCockpitQueueRecord(
  left: Record<string, unknown>,
  right: Pick<OperatorCockpitExecutionQueueItem, "queueId" | "tenant" | "dir">,
): boolean {
  const queueId = stringField(left, "queueId");
  const tenant = stringField(left, "tenant");
  const dir = stringField(left, "dir");
  return queueId === right.queueId && tenant === right.tenant && typeof dir === "string" && resolve(dir) === resolve(right.dir);
}

function agentGitServiceContentsUrl(options: Required<AgentGitServiceOperatorCockpitQueueBackendOptions>): URL {
  const repo = parseRepoRef(options.repo);
  const url = new URL(options.baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const apiPath = basePath.endsWith("/api/v3") ? basePath : `${basePath}/api/v3`;
  const encodedPath = options.path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  url.pathname = `${apiPath}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${encodedPath}`;
  url.search = "";
  url.hash = "";
  return url;
}

function parseRepoRef(value: string): { owner: string; repo: string } {
  const [owner, repo] = normalizeAgentGitServiceOperatorCockpitQueueRepo(value).split("/");
  return { owner, repo };
}

function agentGitServiceHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
  };
}

class AgentGitServiceQueueStoreConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGitServiceQueueStoreConflict";
  }
}

async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tempPath, path);
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

function optionalStoredClientId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return undefined;
  const clientId = value.trim();
  if (clientId.length > 120 || /[\0\r\n]/.test(clientId)) return undefined;
  return clientId;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeTenantDirectoryName(name: string): boolean {
  try {
    assertTenantName(name);
    return true;
  } catch {
    return false;
  }
}

function isSafeDirectoryName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
