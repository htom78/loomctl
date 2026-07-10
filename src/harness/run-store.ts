import { appendFile, mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { HarnessEvent, HarnessEventType, RunSummary } from "./events.js";
import type { DocumentStore, EventStore } from "./storage/contracts.js";

export interface CreateRunStoreOptions {
  rootDir: string;
  runId: string;
  goal: string;
  eventStore?: EventStore;
  documentStore?: DocumentStore;
}

export interface RunStore {
  runId: string;
  goal: string;
  runDir: string;
  eventsPath: string;
  eventStore?: EventStore;
  append<T>(type: HarnessEventType, data: T): Promise<HarnessEvent<T>>;
  writeSummary(summary: RunSummary): Promise<void>;
  count(): number;
}

const appendQueues = new Map<string, Promise<void>>();
const EVENT_APPEND_LOCK_TIMEOUT_MS = 60_000;
const EVENT_APPEND_LOCK_RETRY_MS = 25;

export async function createRunStore(options: CreateRunStoreOptions): Promise<RunStore> {
  const runDir = join(options.rootDir, options.runId);
  const eventsPath = join(runDir, "events.jsonl");
  await mkdir(runDir, { recursive: true });

  let seq = 0;

  return {
    runId: options.runId,
    goal: options.goal,
    runDir,
    eventsPath,
    eventStore: options.eventStore,
    async append<T>(type: HarnessEventType, data: T): Promise<HarnessEvent<T>> {
      const event = await appendEvent(eventsPath, options.runId, type, data, options.eventStore);
      seq = event.seq;
      return event;
    },
    async writeSummary(summary: RunSummary): Promise<void> {
      await options.documentStore?.put("run-summary", options.runId, summary);
      await writeFile(join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
    },
    count(): number {
      return seq;
    },
  };
}

export async function readRunEvents(runDir: string, eventStore?: EventStore): Promise<HarnessEvent[]> {
  if (eventStore) return readRunEventsFromStore(eventStore, basename(runDir));
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return parseRunEvents(raw, basename(runDir));
}

export async function appendRunEvent<T>(runDir: string, type: HarnessEventType, data: T, eventStore?: EventStore): Promise<HarnessEvent<T>> {
  const eventsPath = join(runDir, "events.jsonl");
  return appendEvent(eventsPath, basename(runDir) || "unknown", type, data, eventStore);
}

async function readRunEventsIfPresent(runDir: string): Promise<HarnessEvent[]> {
  try {
    return await readRunEvents(runDir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function appendEvent<T>(
  eventsPath: string,
  fallbackRunId: string,
  type: HarnessEventType,
  data: T,
  eventStore?: EventStore,
): Promise<HarnessEvent<T>> {
  let observed: HarnessEvent<T> | undefined;
  const previous = appendQueues.get(eventsPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const release = await acquireEventAppendLock(eventsPath);
    try {
      const event = eventStore
        ? await appendRunEventToStore(eventStore, fallbackRunId, type, data)
        : await nextFileRunEvent(eventsPath, fallbackRunId, type, data);
      await appendFile(eventsPath, JSON.stringify(event) + "\n", "utf8");
      observed = event;
    } finally {
      await release();
    }
  });
  appendQueues.set(eventsPath, next.then(() => undefined, () => undefined));
  await next;
  return observed as HarnessEvent<T>;
}

async function nextFileRunEvent<T>(
  eventsPath: string,
  fallbackRunId: string,
  type: HarnessEventType,
  data: T,
): Promise<HarnessEvent<T>> {
  const events = await readRunEventsFromPathIfPresent(eventsPath);
  return {
    runId: events[0]?.runId ?? fallbackRunId,
    seq: events.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1,
    ts: new Date().toISOString(),
    type,
    data,
  };
}

async function appendRunEventToStore<T>(
  store: EventStore,
  runId: string,
  type: HarnessEventType,
  data: T,
): Promise<HarnessEvent<T>> {
  const stored = await store.append(runEventStream(runId), { runId, type, data });
  return { runId, seq: stored.seq, ts: stored.ts, type, data };
}

async function readRunEventsFromStore(store: EventStore, runId: string): Promise<HarnessEvent[]> {
  const stored = await store.read<Record<string, unknown>>(runEventStream(runId));
  return stored.flatMap((entry) => {
    const value = entry.value;
    const event = {
      runId,
      seq: entry.seq,
      ts: entry.ts,
      type: value.type,
      data: value.data,
    };
    return isHarnessEvent(event, runId) ? [event] : [];
  });
}

function runEventStream(runId: string): string {
  return `run-events:${runId}`;
}

async function acquireEventAppendLock(eventsPath: string): Promise<() => Promise<void>> {
  const lockPath = `${eventsPath}.lock`;
  const startedAt = Date.now();
  await mkdir(dirname(eventsPath), { recursive: true });

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n", "utf8");
      await handle.close();
      return async () => {
        try {
          await unlink(lockPath);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await removeStaleEventAppendLock(lockPath);
      if (Date.now() - startedAt >= EVENT_APPEND_LOCK_TIMEOUT_MS) {
        throw new Error(`timed out acquiring run event append lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, EVENT_APPEND_LOCK_RETRY_MS));
    }
  }
}

async function removeStaleEventAppendLock(lockPath: string): Promise<void> {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs < EVENT_APPEND_LOCK_TIMEOUT_MS) return;
    await unlink(lockPath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function readRunEventsFromPathIfPresent(eventsPath: string): Promise<HarnessEvent[]> {
  try {
    const raw = await readFile(eventsPath, "utf8");
    return parseRunEvents(raw, basename(dirname(eventsPath)));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

const harnessEventTypes = new Set<string>([
  "user_message",
  "run_metadata",
  "run_policy",
  "workspace_prepare",
  "agent_retry",
  "model_usage",
  "assistant_message",
  "action",
  "observation",
  "verification",
  "evaluation",
  "reviewer",
  "review_gate",
  "review_claim",
  "deployment_gate",
  "resume",
  "pause",
  "external_effect",
  "cancel",
  "finish",
  "error",
]);

function parseRunEvents(raw: string, runId: string): HarnessEvent[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const event = parseRunEventLine(line, runId);
      return event ? [event] : [];
    });
}

function parseRunEventLine(line: string, runId: string): HarnessEvent | undefined {
  try {
    const event = JSON.parse(line) as unknown;
    if (!isHarnessEvent(event, runId)) return undefined;
    return event;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isHarnessEvent(value: unknown, runId: string): value is HarnessEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.runId === runId
    && typeof event.seq === "number"
    && Number.isInteger(event.seq)
    && event.seq > 0
    && typeof event.ts === "string"
    && typeof event.type === "string"
    && harnessEventTypes.has(event.type)
    && "data" in event;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
