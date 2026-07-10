import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import type {
  PlatformOperatorCockpitNextResult,
  PlatformOperatorStatusCockpitInputRef,
  PlatformOperatorStatusCommandRef,
} from "./platform-operator-status.js";

const PLATFORM_OPERATOR_COCKPIT_RUNNER_LEASE_TTL_MS = 30 * 60 * 1000;

export interface PlatformOperatorCockpitRunnerCliOptions {
  dir?: string;
  next?: string;
  execute?: boolean;
  report?: string;
}

export interface PlatformOperatorCockpitRunnerResult {
  schemaVersion: "platform-operator-cockpit-runner/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  nextPath: string;
  reportPath?: string;
  phase?: string;
  state?: string;
  mode: "needs-input" | "dry-run" | "executed" | "complete" | "invalid" | "blocked";
  pendingStepCount?: number;
  missingInputCount?: number;
  commandRefCount?: number;
  currentStepId?: string;
  currentBlockingGroupId?: string;
  currentStepMissingInputCount?: number;
  inputRefs?: PlatformOperatorStatusCockpitInputRef[];
  commandRef?: PlatformOperatorStatusCommandRef;
  execution?: {
    requested: boolean;
    exitCode?: number;
  };
  executionLease?: PlatformOperatorCockpitRunnerExecutionLease;
  missing: string[];
}

export interface PlatformOperatorCockpitRunnerExecutionLease {
  path: string;
  acquired: boolean;
  currentStepId?: string;
  currentBlockingGroupId?: string;
  owner?: string;
  acquiredAt?: string;
  expiresAt?: string;
  ttlMs?: number;
  recoveredStale?: boolean;
  stale?: PlatformOperatorCockpitRunnerStaleExecutionLease;
}

export interface PlatformOperatorCockpitRunnerStaleExecutionLease {
  owner?: string;
  commandLabel?: string;
  currentStepId?: string;
  currentBlockingGroupId?: string;
  acquiredAt?: string;
  expiresAt?: string;
  ttlMs?: number;
}

export interface PlatformOperatorCockpitExecutionStatusResult {
  schemaVersion: "platform-operator-cockpit-execution-status/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  state: "idle" | "locked" | "stale" | "invalid";
  lockPath: string;
  activeLease?: PlatformOperatorCockpitExecutionStatusLease;
  missing: string[];
}

export interface PlatformOperatorCockpitExecutionStatusLease extends PlatformOperatorCockpitRunnerStaleExecutionLease {
  path: string;
  stale: boolean;
}

export async function runPlatformOperatorCockpitRunner(
  options: PlatformOperatorCockpitRunnerCliOptions = {},
): Promise<PlatformOperatorCockpitRunnerResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const nextPath = resolve(options.next ?? join(dir, "reports", "operator-cockpit-next.json"));
  const reportPath = options.report ? resolve(options.report) : undefined;
  const loaded = loadPlatformOperatorCockpitNext(nextPath);
  if (!loaded.ok) {
    return runnerResult({
      ok: false,
      dir,
      nextPath,
      reportPath,
      mode: "invalid",
      missing: [loaded.missing],
    });
  }

  const next = loaded.value;
  const base = {
    dir,
    nextPath,
    reportPath,
    phase: next.phase,
    state: next.state,
    pendingStepCount: next.pendingStepCount,
    missingInputCount: next.missingInputCount,
    commandRefCount: next.commandRefCount,
    currentStepId: next.currentStepId,
    currentBlockingGroupId: next.currentBlockingGroupId,
    currentStepMissingInputCount: next.currentStepMissingInputCount,
  };

  if (next.state === "complete") {
    const existingExecuted = options.execute && reportPath
      ? loadPlatformOperatorCockpitRunnerExistingExecutedReport(reportPath, dir, nextPath)
      : undefined;
    if (existingExecuted) return existingExecuted;
    return runnerResult({
      ok: true,
      ...base,
      mode: "complete",
      missing: [],
    });
  }

  if (next.state === "needs-input") {
    return runnerResult({
      ok: false,
      ...base,
      mode: "needs-input",
      inputRefs: next.inputRefs ?? [],
      missing: ["inputRefs"],
    });
  }

  if (!next.commandRef || !Array.isArray(next.commandRef.commandArgs) || next.commandRef.commandArgs.length === 0) {
    return runnerResult({
      ok: false,
      ...base,
      mode: "invalid",
      missing: ["commandRef.commandArgs"],
    });
  }

  const commandPlaceholders = platformOperatorCockpitCommandPlaceholders(next.commandRef.commandArgs);
  if (commandPlaceholders.length > 0) {
    return runnerResult({
      ok: false,
      ...base,
      mode: "needs-input",
      commandRef: next.commandRef,
      execution: { requested: options.execute === true },
      missing: commandPlaceholders.map((placeholder) => `commandRef.placeholder.${placeholder.slice(1, -1)}`),
    });
  }

  if (!options.execute) {
    return runnerResult({
      ok: true,
      ...base,
      mode: "dry-run",
      commandRef: next.commandRef,
      execution: { requested: false },
      missing: [],
    });
  }

  const executionLease = acquirePlatformOperatorCockpitRunnerExecutionLease(dir, next.commandRef, next);
  if (!executionLease.acquired) {
    return runnerResult({
      ok: false,
      ...base,
      mode: "blocked",
      commandRef: next.commandRef,
      execution: { requested: true },
      executionLease,
      missing: ["executionLease"],
    });
  }
  try {
    const cwd = resolve(next.commandRef.cwd ?? dir);
    const executed = await execa(next.commandRef.commandArgs[0], next.commandRef.commandArgs.slice(1), {
      cwd,
      reject: false,
      stdio: "ignore",
    });
    const exitCode = executed.exitCode ?? 1;
    return runnerResult({
      ok: exitCode === 0,
      ...base,
      mode: "executed",
      commandRef: next.commandRef,
      execution: {
        requested: true,
        exitCode,
      },
      executionLease,
      missing: exitCode === 0 ? [] : ["execution.exitCode"],
    });
  } finally {
    releasePlatformOperatorCockpitRunnerExecutionLease(executionLease);
  }
}

function platformOperatorCockpitCommandPlaceholders(commandArgs: string[]): string[] {
  return Array.from(new Set(commandArgs.flatMap((arg) => arg.match(/<[^<>]+>/g) ?? [])));
}

export function readPlatformOperatorCockpitExecutionStatus(
  options: { dir?: string } = {},
): PlatformOperatorCockpitExecutionStatusResult {
  const dir = resolve(options.dir ?? process.cwd());
  const lockPath = join(dir, ".loom", "operator-cockpit-runner.lock");
  if (!existsSync(lockPath)) {
    return cockpitExecutionStatusResult({
      ok: true,
      dir,
      state: "idle",
      lockPath,
      missing: [],
    });
  }
  const record = readPlatformOperatorCockpitExecutionLock(lockPath);
  if (!record) {
    return cockpitExecutionStatusResult({
      ok: false,
      dir,
      state: "invalid",
      lockPath,
      missing: ["executionLease.schema"],
    });
  }
  const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : undefined;
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  const stale = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
  return cockpitExecutionStatusResult({
    ok: false,
    dir,
    state: stale ? "stale" : "locked",
    lockPath,
    activeLease: {
      path: lockPath,
      stale,
      ...(typeof record.owner === "string" ? { owner: record.owner } : {}),
      ...(typeof record.commandLabel === "string" ? { commandLabel: record.commandLabel } : {}),
      ...(typeof record.currentStepId === "string" ? { currentStepId: record.currentStepId } : {}),
      ...(typeof record.currentBlockingGroupId === "string" ? { currentBlockingGroupId: record.currentBlockingGroupId } : {}),
      ...(typeof record.acquiredAt === "string" ? { acquiredAt: record.acquiredAt } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(typeof record.ttlMs === "number" ? { ttlMs: record.ttlMs } : {}),
    },
    missing: [stale ? "executionLease.stale" : "executionLease.active"],
  });
}

function runnerResult(
  value: Omit<PlatformOperatorCockpitRunnerResult, "schemaVersion" | "tokenFree">,
): PlatformOperatorCockpitRunnerResult {
  return {
    schemaVersion: "platform-operator-cockpit-runner/v1",
    tokenFree: true,
    ...value,
  };
}

function cockpitExecutionStatusResult(
  value: Omit<PlatformOperatorCockpitExecutionStatusResult, "schemaVersion" | "tokenFree">,
): PlatformOperatorCockpitExecutionStatusResult {
  return {
    schemaVersion: "platform-operator-cockpit-execution-status/v1",
    tokenFree: true,
    ...value,
  };
}

function loadPlatformOperatorCockpitNext(path: string): { ok: true; value: PlatformOperatorCockpitNextResult } | { ok: false; missing: string } {
  if (!existsSync(path)) return { ok: false, missing: "operator-cockpit-next.json" };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isPlatformOperatorCockpitNextResult(value)) return { ok: false, missing: "operator-cockpit-next.schema" };
    return { ok: true, value };
  } catch {
    return { ok: false, missing: "operator-cockpit-next.json" };
  }
}

function loadPlatformOperatorCockpitRunnerExistingExecutedReport(
  path: string,
  dir: string,
  nextPath: string,
): PlatformOperatorCockpitRunnerResult | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isPlatformOperatorCockpitRunnerExecutedResult(value)) return undefined;
    if (value.dir !== dir || value.nextPath !== nextPath || value.reportPath !== path) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function isPlatformOperatorCockpitRunnerExecutedResult(value: unknown): value is PlatformOperatorCockpitRunnerResult {
  if (!isRecord(value)) return false;
  const execution = isRecord(value.execution) ? value.execution : undefined;
  const executionLease = isRecord(value.executionLease) ? value.executionLease : undefined;
  return value.schemaVersion === "platform-operator-cockpit-runner/v1" &&
    value.tokenFree === true &&
    value.ok === true &&
    value.mode === "executed" &&
    Array.isArray(value.missing) &&
    value.missing.length === 0 &&
    execution?.requested === true &&
    execution.exitCode === 0 &&
    executionLease?.acquired === true &&
    typeof value.dir === "string" &&
    typeof value.nextPath === "string" &&
    typeof value.reportPath === "string";
}

function isPlatformOperatorCockpitNextResult(value: unknown): value is PlatformOperatorCockpitNextResult {
  if (!isRecord(value)) return false;
  return value.schemaVersion === "platform-operator-cockpit-next/v1" &&
    value.tokenFree === true &&
    (value.state === "needs-input" || value.state === "ready-to-run" || value.state === "complete") &&
    typeof value.phase === "string" &&
    typeof value.pendingStepCount === "number" &&
    typeof value.missingInputCount === "number" &&
    typeof value.commandRefCount === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function acquirePlatformOperatorCockpitRunnerExecutionLease(
  dir: string,
  commandRef: PlatformOperatorStatusCommandRef,
  next: PlatformOperatorCockpitNextResult,
): PlatformOperatorCockpitRunnerExecutionLease {
  const path = join(dir, ".loom", "operator-cockpit-runner.lock");
  mkdirSync(dirname(path), { recursive: true });
  const acquired = writePlatformOperatorCockpitRunnerExecutionLease(path, commandRef, next);
  if (acquired) return acquired;
  const stale = stalePlatformOperatorCockpitRunnerExecutionLease(path);
  if (!stale) return { path, acquired: false };
  rmSync(path, { force: true });
  return writePlatformOperatorCockpitRunnerExecutionLease(path, commandRef, next, stale) ?? { path, acquired: false };
}

function writePlatformOperatorCockpitRunnerExecutionLease(
  path: string,
  commandRef: PlatformOperatorStatusCommandRef,
  next: PlatformOperatorCockpitNextResult,
  stale?: PlatformOperatorCockpitRunnerStaleExecutionLease,
): PlatformOperatorCockpitRunnerExecutionLease | undefined {
  let fd: number | undefined;
  try {
    const acquiredAt = new Date();
    const expiresAt = new Date(acquiredAt.getTime() + PLATFORM_OPERATOR_COCKPIT_RUNNER_LEASE_TTL_MS);
    const owner = `operator-cockpit-runner:${process.pid}`;
    fd = openSync(path, "wx");
    writeFileSync(fd, `${JSON.stringify({
      schemaVersion: "platform-operator-cockpit-runner-lock/v1",
      tokenFree: true,
      owner,
      commandLabel: commandRef.label,
      ...(next.currentStepId ? { currentStepId: next.currentStepId } : {}),
      ...(next.currentBlockingGroupId ? { currentBlockingGroupId: next.currentBlockingGroupId } : {}),
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ttlMs: PLATFORM_OPERATOR_COCKPIT_RUNNER_LEASE_TTL_MS,
    }, null, 2)}\n`, "utf8");
    closeSync(fd);
    fd = undefined;
    return {
      path,
      acquired: true,
      ...(next.currentStepId ? { currentStepId: next.currentStepId } : {}),
      ...(next.currentBlockingGroupId ? { currentBlockingGroupId: next.currentBlockingGroupId } : {}),
      owner,
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ttlMs: PLATFORM_OPERATOR_COCKPIT_RUNNER_LEASE_TTL_MS,
      ...(stale ? { recoveredStale: true, stale } : {}),
    };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (isNodeError(error) && error.code === "EEXIST") return undefined;
    throw error;
  }
}

function stalePlatformOperatorCockpitRunnerExecutionLease(
  path: string,
): PlatformOperatorCockpitRunnerStaleExecutionLease | undefined {
  const record = readPlatformOperatorCockpitExecutionLock(path);
  if (!record) return undefined;
  const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : undefined;
  if (!expiresAt) return undefined;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs > Date.now()) return undefined;
  return {
    ...(typeof record.owner === "string" ? { owner: record.owner } : {}),
    ...(typeof record.commandLabel === "string" ? { commandLabel: record.commandLabel } : {}),
    ...(typeof record.currentStepId === "string" ? { currentStepId: record.currentStepId } : {}),
    ...(typeof record.currentBlockingGroupId === "string" ? { currentBlockingGroupId: record.currentBlockingGroupId } : {}),
    ...(typeof record.acquiredAt === "string" ? { acquiredAt: record.acquiredAt } : {}),
    expiresAt,
    ...(typeof record.ttlMs === "number" ? { ttlMs: record.ttlMs } : {}),
  };
}

function readPlatformOperatorCockpitExecutionLock(path: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  const record = isRecord(value) ? value : undefined;
  if (record?.schemaVersion !== "platform-operator-cockpit-runner-lock/v1" || record.tokenFree !== true) return undefined;
  return record;
}

function releasePlatformOperatorCockpitRunnerExecutionLease(
  executionLease: PlatformOperatorCockpitRunnerExecutionLease,
): void {
  if (executionLease.acquired) rmSync(executionLease.path, { force: true });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
