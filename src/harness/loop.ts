import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { HarnessAgent } from "./agents.js";
import type { EvaluationResult, HarnessEvent, HarnessStatus, ReviewerResult, RunMetadata, RunModelUsageSummary, RunRequesterSummary, RunSummary, ToolAction, VerificationResult } from "./events.js";
import { createLocalExecutor, type WorkspaceExecutor } from "./executor.js";
import { createRunStore, readRunEvents } from "./run-store.js";
import { createToolRuntime, effectiveAllowedTools, runVerification } from "./tools.js";
import type { PlatformStateBackend } from "./storage/contracts.js";
import { scrubSecretText } from "./redact.js";

export interface RunHarnessOptions {
  goal: string;
  cwd: string;
  runRoot?: string;
  runId?: string;
  verifyCommands: string[];
  evaluationCommands?: string[];
  reviewerCommands?: string[];
  agent: HarnessAgent;
  skills?: string[];
  metadata?: RunMetadata;
  reviewRequired?: boolean;
  deploymentRequired?: boolean;
  maxIterations?: number;
  timeoutMs?: number;
  allowedTools?: string[];
  executor?: WorkspaceExecutor;
  signal?: AbortSignal;
  requester?: RunRequester;
  resumeRequester?: RunRequester;
  control?: RunControl;
  resume?: boolean;
  startedAt?: string;
  stateBackend?: PlatformStateBackend;
}

export interface RunRequester {
  actor?: string;
  role?: string;
  clientId?: string;
  modelKeyEnv?: string;
}

export interface RunControl {
  shouldPause?(events: HarnessEvent[]): Promise<RunPauseRequest | undefined> | RunPauseRequest | undefined;
}

export interface RunPauseRequest {
  reason?: string;
  actor?: string;
  role?: string;
  clientId?: string;
  eventSeq?: number;
}

export interface RunHarnessResult extends RunSummary {}

export async function runHarness(options: RunHarnessOptions): Promise<RunHarnessResult> {
  const runId = options.runId ?? makeRunId();
  const runRoot = options.runRoot ?? join(options.cwd, ".loom", "runs");
  const startedAt = options.startedAt ?? new Date().toISOString();
  const store = await createRunStore({
    rootDir: runRoot,
    runId,
    goal: options.goal,
    eventStore: options.stateBackend?.events,
    documentStore: options.stateBackend?.documents,
  });
  const executor = options.executor ?? createLocalExecutor({ cwd: options.cwd });
  const allowedTools = effectiveAllowedTools(options.allowedTools);
  const runExecutionEnv = {
    LOOM_RUN_ID: runId,
    LOOM_RUN_ROOT: runRoot,
    LOOM_RUN_DIR: store.runDir,
  };
  const runtime = createToolRuntime({
    cwd: options.cwd,
    verifyCommands: options.verifyCommands,
    timeoutMs: options.timeoutMs,
    allowedTools,
    executor,
    executionEnv: runExecutionEnv,
    signal: options.signal,
  });
  const events: HarnessEvent[] = [];
  const maxIterations = options.maxIterations ?? 20;
  const skills = options.skills ?? [];
  let verification: VerificationResult | null = null;
  let evaluation: EvaluationResult | null = null;
  let reviewer: ReviewerResult | null = null;
  let currentPhase: string | undefined;
  let currentIteration: number | undefined;

  if (options.resume) {
    events.push(...await readRunEvents(store.runDir, options.stateBackend?.events));
    const resumeRequester = options.resumeRequester ?? options.requester;
    events.push(await store.append("resume", compactObject({
      actor: resumeRequester?.actor,
      role: resumeRequester?.role,
      clientId: resumeRequester?.clientId,
    })));
  } else {
    events.push(await store.append("user_message", userMessageData(options.goal, options.requester)));
    if (options.metadata) {
      events.push(await store.append("run_metadata", options.metadata));
    }
    events.push(await store.append("run_policy", { allowedTools }));
  }
  const iterationOffset = assistantMessageCount(events);

  try {
    throwIfAborted(options.signal);
    if (executor.prepare) {
      currentPhase = "workspace_prepare";
      currentIteration = undefined;
      events.push(await store.append("workspace_prepare", { status: "started" }));
      await executor.prepare();
      events.push(await store.append("workspace_prepare", { status: "passed" }));
    }

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      currentIteration = iteration;
      currentPhase = "agent_next";
      throwIfAborted(options.signal);
      events.splice(0, events.length, ...(await readRunEvents(store.runDir, options.stateBackend?.events)));
      const pauseRequest = await options.control?.shouldPause?.(events);
      if (pauseRequest) {
        currentPhase = "paused";
        events.push(await store.append("pause", compactObject({
          reason: pauseRequest.reason ?? "run paused",
          actor: pauseRequest.actor,
          role: pauseRequest.role,
          clientId: pauseRequest.clientId,
          eventSeq: pauseRequest.eventSeq,
        })));
        events.push(await store.append("finish", { status: "paused" }));
        return writeAndReturnSummary(store, {
          runId,
          goal: options.goal,
          status: "paused",
          skills,
          metadata: options.metadata,
          startedAt,
          endedAt: new Date().toISOString(),
          eventCount: store.count(),
          runDir: store.runDir,
          verification,
          evaluation,
          reviewer,
        });
      }
      const step = await options.agent.next({
        goal: options.goal,
        events,
        emitEvent: async (type, data) => {
          events.push(await store.append(type, data));
        },
      });
      const actions = step.actions ?? [];
      events.push(
        await store.append("assistant_message", compactObject({
          content: step.message,
          plan: step.plan,
          iteration: iterationOffset + iteration,
          actionCount: actions.length,
          finishRequested: Boolean(step.finish),
        })),
      );

      for (const action of actions) {
        currentPhase = "tool_action";
        throwIfAborted(options.signal);
        const actionWithId = ensureActionId(action);
        events.push(await store.append("action", actionWithId));
        currentPhase = "tool_observation";
        const observation = await runtime.execute(actionWithId);
        events.push(await store.append("observation", observation));
      }

      if (step.finish) {
        currentPhase = "verification";
        throwIfAborted(options.signal);
        verification = await runVerification(executor, options.verifyCommands, undefined, options.timeoutMs, options.signal, { env: runExecutionEnv });
        events.push(await store.append("verification", verification));

        if (verification.ok && options.evaluationCommands?.length) {
          currentPhase = "evaluation";
          throwIfAborted(options.signal);
          evaluation = await runVerification(executor, options.evaluationCommands, undefined, options.timeoutMs, options.signal, { env: runExecutionEnv });
          events.push(await store.append("evaluation", evaluation));
        }

        const gateOk = verification.ok && (evaluation?.ok ?? true);
        if (gateOk && options.reviewerCommands?.length) {
          currentPhase = "reviewer";
          throwIfAborted(options.signal);
          reviewer = await runVerification(executor, options.reviewerCommands, undefined, options.timeoutMs, options.signal, { env: runExecutionEnv });
          events.push(await store.append("reviewer", reviewer));
        }
        const review = gateOk && options.reviewRequired ? { required: true, status: "pending" as const } : undefined;
        const deployment = gateOk && options.deploymentRequired ? { required: true, status: "pending" as const } : undefined;
        if (review) {
          events.push(await store.append("review_gate", review));
        }
        if (deployment) {
          events.push(await store.append("deployment_gate", deployment));
        }
        const status: HarnessStatus = gateOk
          ? (review ? "review_required" : deployment ? "deployment_required" : "passed")
          : "failed";
        events.push(await store.append("finish", { status }));
        return writeAndReturnSummary(store, {
          runId,
          goal: options.goal,
          status,
          skills,
          metadata: options.metadata,
          review,
          deployment,
          startedAt,
          endedAt: new Date().toISOString(),
          eventCount: store.count(),
          runDir: store.runDir,
          verification,
          evaluation,
          reviewer,
        });
      }
    }

    currentPhase = "max_iterations";
    currentIteration = undefined;
    const maxIterationError = {
      message: `maximum iterations reached (${maxIterations})`,
      phase: currentPhase,
    };
    events.push(
      await store.append("error", maxIterationError),
    );
    events.push(await store.append("finish", { status: "failed" }));
    return writeAndReturnSummary(store, {
      runId,
      goal: options.goal,
      status: "failed",
      skills,
      metadata: options.metadata,
      startedAt,
      endedAt: new Date().toISOString(),
      eventCount: store.count(),
      runDir: store.runDir,
      verification,
      evaluation,
      reviewer,
      error: maxIterationError,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isCancelled(options.signal, error)) {
      events.push(await store.append("cancel", compactObject({ reason: message, phase: currentPhase, iteration: currentIteration })));
      events.push(await store.append("finish", { status: "cancelled" }));
      return writeAndReturnSummary(store, {
        runId,
        goal: options.goal,
        status: "cancelled",
        skills,
        metadata: options.metadata,
        startedAt,
        endedAt: new Date().toISOString(),
        eventCount: store.count(),
        runDir: store.runDir,
        verification,
        evaluation,
        reviewer,
      });
    }
    const runError = runErrorSummary(error, message, currentPhase, currentIteration);
    events.push(await store.append("error", runError));
    events.push(await store.append("finish", { status: "error" }));
    return writeAndReturnSummary(store, {
      runId,
      goal: options.goal,
      status: "error",
      skills,
      metadata: options.metadata,
      startedAt,
      endedAt: new Date().toISOString(),
      eventCount: store.count(),
      runDir: store.runDir,
      verification,
      evaluation,
      reviewer,
      error: runError,
    });
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(typeof reason === "string" && reason.trim() ? reason : "run cancelled");
}

function isCancelled(signal: AbortSignal | undefined, error: unknown): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function ensureActionId(action: ToolAction): ToolAction & { id: string } {
  return {
    ...action,
    id: action.id ?? `act-${randomUUID()}`,
  };
}

async function writeAndReturnSummary(
  store: Awaited<ReturnType<typeof createRunStore>>,
  summary: RunSummary,
): Promise<RunHarnessResult> {
  const events = await readRunEvents(store.runDir, store.eventStore);
  const requester = summary.requester ?? requesterSummaryFromEvents(events);
  const modelUsage = summary.modelUsage ?? modelUsageSummaryFromEvents(events);
  const observed = compactObject({ ...summary, requester, modelUsage });
  await store.writeSummary(observed);
  return observed;
}

function userMessageData(content: string, requester?: RunRequester): Record<string, unknown> {
  return compactObject({
    content,
    actor: requester?.actor,
    role: requester?.role,
    clientId: requester?.clientId,
  });
}

function requesterSummaryFromEvents(events: HarnessEvent[]): RunRequesterSummary | undefined {
  const event = events.find((entry) => entry.type === "user_message");
  if (!event || typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) return undefined;
  const data = event.data as Record<string, unknown>;
  const requester = compactObject({
    actor: typeof data.actor === "string" ? data.actor : undefined,
    role: typeof data.role === "string" ? data.role : undefined,
    clientId: typeof data.clientId === "string" ? data.clientId : undefined,
  });
  return Object.keys(requester).length ? requester : undefined;
}

function modelUsageSummaryFromEvents(events: HarnessEvent[]): RunModelUsageSummary | undefined {
  let requestCount = 0;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let totalTokens: number | undefined;
  let costUsd: number | undefined;
  for (const event of events) {
    if (event.type !== "model_usage" || !isRecord(event.data) || Array.isArray(event.data)) continue;
    requestCount += 1;
    promptTokens = addOptionalNumber(promptTokens, event.data.promptTokens);
    completionTokens = addOptionalNumber(completionTokens, event.data.completionTokens);
    totalTokens = addOptionalNumber(totalTokens, event.data.totalTokens);
    costUsd = addOptionalCostUsd(costUsd, event.data.costUsd);
  }
  if (!requestCount) return undefined;
  return compactObject({ requestCount, promptTokens, completionTokens, totalTokens, costUsd });
}

function addOptionalNumber(total: number | undefined, value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return total;
  return (total ?? 0) + value;
}

function addOptionalCostUsd(total: number | undefined, value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return total;
  return Math.round(((total ?? 0) + value) * 1_000_000_000_000) / 1_000_000_000_000;
}

function assistantMessageCount(events: HarnessEvent[]): number {
  return events.filter((event) => event.type === "assistant_message").length;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function runErrorSummary(error: unknown, message: string, phase?: string, iteration?: number) {
  const diagnostic = diagnosticFields(error);
  return compactObject({
    // Scrub secrets an upstream failure may have echoed into the free-text
    // message before it persists; it surfaces to viewers through the run
    // summary, replay, and /events endpoints. Structured `details` are left to
    // their producer (e.g. the model agent already bounds and redacts its own
    // response excerpt) and are key-name filtered on read.
    message: scrubSecretText(message),
    phase,
    iteration,
    kind: diagnostic.kind,
    details: diagnostic.details,
  });
}

function diagnosticFields(error: unknown): { kind?: string; details?: Record<string, unknown> } {
  if (!isRecord(error)) return {};
  const kind = typeof error.kind === "string" && error.kind.trim() ? error.kind : undefined;
  const details = isRecord(error.details) && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : undefined;
  return { kind, details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function makeRunId(): string {
  return `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
}
