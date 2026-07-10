import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { RunMetadata, RunRequesterSummary, RunSummary } from "./events.js";
import type { DocumentStore } from "./storage/contracts.js";

export interface RunningRunStatus {
  runId: string;
  tenant: string;
  project: string;
  goal: string;
  status: "running";
  skills: string[];
  metadata?: RunMetadata;
  requester?: RunRequesterSummary;
  startedAt: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  runDir: string;
}

export interface QueuedRunConcurrencySummary {
  state: "blocked" | "ready";
  blockedReason: QueuedRunBlockedReason;
  blockedByRunIds?: string[];
  activeTenantRunCount?: number;
  tenantActiveRunLimit?: number;
  projectActiveRunId?: string;
  persistedRunId?: string;
}

export type QueuedRunBlockedReason = "tenant_active_run_limit" | "project_active_workspace" | "persisted_running_run" | "ready";

export interface QueuedRunStatus {
  runId: string;
  tenant: string;
  project: string;
  goal: string;
  status: "queued";
  skills: string[];
  metadata?: RunMetadata;
  requester?: RunRequesterSummary;
  queuedAt: string;
  tenantQueuePosition?: number;
  projectQueuePosition?: number;
  blockedReason?: QueuedRunBlockedReason;
  blockedByRunIds?: string[];
  limit?: number;
  concurrency?: QueuedRunConcurrencySummary;
  runDir: string;
}

export interface QueuedRunSnapshot<TRequest = unknown, TRequester = unknown> {
  schemaVersion: 1;
  request: TRequest;
  requester?: TRequester;
}

export type ReadableRunState = RunSummary | RunningRunStatus | QueuedRunStatus;

const QUEUED_RUN_REQUEST_FILE = "queued-request.json";
const RUN_STATUS_NAMESPACE = "run-status";
const RUN_SUMMARY_NAMESPACE = "run-summary";
const RUN_QUEUE_REQUEST_NAMESPACE = "run-queue-request";

export async function readRunState(runDir: string, documents?: DocumentStore): Promise<ReadableRunState> {
  const runId = runStateKey(runDir);
  const storedStatus = await documents?.get<ReadableRunState>(RUN_STATUS_NAMESPACE, runId);
  if (storedStatus) return storedStatus.value;

  try {
    const status = JSON.parse(await readFile(join(runDir, "status.json"), "utf8")) as ReadableRunState;
    if (status.status === "running" || status.status === "queued") return status;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    const storedSummary = await documents?.get<RunSummary>(RUN_SUMMARY_NAMESPACE, runId);
    if (storedSummary) return storedSummary.value;
    return JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as RunSummary;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return JSON.parse(await readFile(join(runDir, "status.json"), "utf8")) as RunningRunStatus | QueuedRunStatus;
  }
}

export async function readRunStateIfPresent(runDir: string, documents?: DocumentStore): Promise<ReadableRunState | undefined> {
  try {
    return await readRunState(runDir, documents);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function writeRunSummary(summary: RunSummary, documents?: DocumentStore): Promise<void> {
  await documents?.put(RUN_SUMMARY_NAMESPACE, summary.runId, summary);
  await writeJsonFileAtomic(join(summary.runDir, "summary.json"), summary);
}

export async function writeRunStatus(runDir: string, status: ReadableRunState, documents?: DocumentStore): Promise<void> {
  await documents?.put(RUN_STATUS_NAMESPACE, status.runId, status);
  await writeJsonFileAtomic(join(runDir, "status.json"), status);
}

export async function writeQueuedRunSnapshot<TRequest, TRequester>(
  runDir: string,
  snapshot: QueuedRunSnapshot<TRequest, TRequester>,
  documents?: DocumentStore,
): Promise<void> {
  await documents?.put(RUN_QUEUE_REQUEST_NAMESPACE, runStateKey(runDir), snapshot);
  await writeJsonFileAtomic(join(runDir, QUEUED_RUN_REQUEST_FILE), snapshot);
}

export async function readQueuedRunSnapshot<TRequest, TRequester>(
  runDir: string,
  documents?: DocumentStore,
): Promise<QueuedRunSnapshot<TRequest, TRequester>> {
  const stored = await documents?.get<QueuedRunSnapshot<TRequest, TRequester>>(RUN_QUEUE_REQUEST_NAMESPACE, runStateKey(runDir));
  if (stored) return stored.value;
  return JSON.parse(await readFile(join(runDir, QUEUED_RUN_REQUEST_FILE), "utf8")) as QueuedRunSnapshot<TRequest, TRequester>;
}

export async function listStoredRunStates(documents: DocumentStore, tenant?: string): Promise<ReadableRunState[]> {
  const stored = await documents.list<ReadableRunState>(RUN_STATUS_NAMESPACE);
  return stored
    .map((document) => document.value)
    .filter((state) => !tenant || runStateTenant(state) === tenant)
    .sort((left, right) => runStateStartedAt(right).localeCompare(runStateStartedAt(left)));
}

function runStateKey(runDir: string): string {
  const runId = basename(runDir);
  if (!runId) throw new Error("run directory must end with a run id");
  return runId;
}

function runStateTenant(state: ReadableRunState): string | undefined {
  if ("tenant" in state && typeof state.tenant === "string") return state.tenant;
  return state.metadata?.tenant;
}

function runStateStartedAt(state: ReadableRunState): string {
  if ("queuedAt" in state) return state.queuedAt;
  return state.startedAt;
}

async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tempPath, path);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
