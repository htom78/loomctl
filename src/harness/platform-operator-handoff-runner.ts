import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import type { PlatformOperatorHandoffCommandRef, PlatformOperatorHandoffPacketResult } from "./platform-operator-handoff-packet.js";

const PLATFORM_OPERATOR_HANDOFF_RUNNER_LEASE_TTL_MS = 30 * 60 * 1000;

export interface PlatformOperatorHandoffRunnerCliOptions {
  dir?: string;
  packet?: string;
  blockingGroup?: string;
  label?: string;
  step?: string;
  execute?: boolean;
  report?: string;
}

export interface PlatformOperatorHandoffRunnerResult {
  schemaVersion: "platform-operator-handoff-runner/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  packetPath: string;
  reportPath?: string;
  phase?: string;
  selector: {
    blockingGroupId?: string;
    label?: string;
    stepId?: string;
  };
  mode: "dry-run" | "executed" | "invalid" | "blocked";
  commandRef?: PlatformOperatorHandoffCommandRef;
  execution?: {
    requested: boolean;
    exitCode?: number;
  };
  executionLease?: PlatformOperatorHandoffRunnerExecutionLease;
  missing: string[];
}

export interface PlatformOperatorHandoffRunnerExecutionLease {
  path: string;
  acquired: boolean;
  stepId?: string;
  blockingGroupId?: string;
  owner?: string;
  acquiredAt?: string;
  expiresAt?: string;
  ttlMs?: number;
  recoveredStale?: boolean;
  stale?: PlatformOperatorHandoffRunnerStaleExecutionLease;
}

export interface PlatformOperatorHandoffRunnerStaleExecutionLease {
  owner?: string;
  commandLabel?: string;
  stepId?: string;
  blockingGroupId?: string;
  acquiredAt?: string;
  expiresAt?: string;
  ttlMs?: number;
}

export async function runPlatformOperatorHandoffRunner(
  options: PlatformOperatorHandoffRunnerCliOptions = {},
): Promise<PlatformOperatorHandoffRunnerResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const packetPath = resolve(options.packet ?? join(dir, "reports", "operator-handoff-packet.json"));
  const reportPath = options.report ? resolve(options.report) : undefined;
  const selector = handoffRunnerSelector(options);
  const missingSelector = handoffRunnerMissingSelector(selector);
  if (missingSelector.length > 0) {
    return handoffRunnerResult({
      ok: false,
      dir,
      packetPath,
      reportPath,
      selector,
      mode: "invalid",
      missing: missingSelector,
    });
  }

  const loaded = loadPlatformOperatorHandoffPacket(packetPath);
  if (!loaded.ok) {
    return handoffRunnerResult({
      ok: false,
      dir,
      packetPath,
      reportPath,
      selector,
      mode: "invalid",
      missing: [loaded.missing],
    });
  }

  const commandRef = selectPlatformOperatorHandoffCommandRef(loaded.value, selector);
  if (!commandRef) {
    return handoffRunnerResult({
      ok: false,
      dir,
      packetPath,
      reportPath,
      phase: loaded.value.phase,
      selector,
      mode: "invalid",
      missing: ["commandRef"],
    });
  }
  if (!Array.isArray(commandRef.commandArgs) || commandRef.commandArgs.length === 0) {
    return handoffRunnerResult({
      ok: false,
      dir,
      packetPath,
      reportPath,
      phase: loaded.value.phase,
      selector,
      mode: "invalid",
      commandRef,
      missing: ["commandRef.commandArgs"],
    });
  }

  if (!options.execute) {
    return handoffRunnerResult({
      ok: true,
      dir,
      packetPath,
      reportPath,
      phase: loaded.value.phase,
      selector,
      mode: "dry-run",
      commandRef,
      execution: { requested: false },
      missing: [],
    });
  }

  const executionLease = acquirePlatformOperatorHandoffRunnerExecutionLease(dir, commandRef);
  if (!executionLease.acquired) {
    return handoffRunnerResult({
      ok: false,
      dir,
      packetPath,
      reportPath,
      phase: loaded.value.phase,
      selector,
      mode: "blocked",
      commandRef,
      execution: { requested: true },
      executionLease,
      missing: ["executionLease"],
    });
  }
  try {
    const cwd = resolve(commandRef.cwd ?? dir);
    const executed = await execa(commandRef.commandArgs[0], commandRef.commandArgs.slice(1), {
      cwd,
      reject: false,
      stdio: "ignore",
    });
    const exitCode = executed.exitCode ?? 1;
    return handoffRunnerResult({
      ok: exitCode === 0,
      dir,
      packetPath,
      reportPath,
      phase: loaded.value.phase,
      selector,
      mode: "executed",
      commandRef,
      execution: {
        requested: true,
        exitCode,
      },
      executionLease,
      missing: exitCode === 0 ? [] : ["execution.exitCode"],
    });
  } finally {
    releasePlatformOperatorHandoffRunnerExecutionLease(executionLease);
  }
}

function handoffRunnerResult(
  value: Omit<PlatformOperatorHandoffRunnerResult, "schemaVersion" | "tokenFree">,
): PlatformOperatorHandoffRunnerResult {
  return {
    schemaVersion: "platform-operator-handoff-runner/v1",
    tokenFree: true,
    ...value,
  };
}

function handoffRunnerSelector(
  options: PlatformOperatorHandoffRunnerCliOptions,
): PlatformOperatorHandoffRunnerResult["selector"] {
  return {
    ...(options.blockingGroup ? { blockingGroupId: options.blockingGroup } : {}),
    ...(options.label ? { label: options.label } : {}),
    ...(options.step ? { stepId: options.step } : {}),
  };
}

function handoffRunnerMissingSelector(selector: PlatformOperatorHandoffRunnerResult["selector"]): string[] {
  return [
    ...(selector.blockingGroupId ? [] : ["selector.blockingGroupId"]),
    ...(selector.label ? [] : ["selector.label"]),
  ];
}

function loadPlatformOperatorHandoffPacket(
  path: string,
): { ok: true; value: PlatformOperatorHandoffPacketResult } | { ok: false; missing: string } {
  if (!existsSync(path)) return { ok: false, missing: "operator-handoff-packet.json" };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isPlatformOperatorHandoffPacketResult(value)) return { ok: false, missing: "operator-handoff-packet.schema" };
    return { ok: true, value };
  } catch {
    return { ok: false, missing: "operator-handoff-packet.json" };
  }
}

function isPlatformOperatorHandoffPacketResult(value: unknown): value is PlatformOperatorHandoffPacketResult {
  const record = isRecord(value) ? value : undefined;
  const handoff = isRecord(record?.handoff) ? record.handoff : undefined;
  return record?.schemaVersion === "platform-operator-handoff-packet/v1" &&
    record.tokenFree === true &&
    typeof record.phase === "string" &&
    Array.isArray(handoff?.commandRefs);
}

function selectPlatformOperatorHandoffCommandRef(
  packet: PlatformOperatorHandoffPacketResult,
  selector: PlatformOperatorHandoffRunnerResult["selector"],
): PlatformOperatorHandoffCommandRef | undefined {
  return packet.handoff.commandRefs.find((ref) =>
    ref.blockingGroupId === selector.blockingGroupId &&
    ref.label === selector.label &&
    (!selector.stepId || ref.stepId === selector.stepId)
  );
}

function acquirePlatformOperatorHandoffRunnerExecutionLease(
  dir: string,
  commandRef: PlatformOperatorHandoffCommandRef,
): PlatformOperatorHandoffRunnerExecutionLease {
  const path = join(dir, ".loom", "operator-handoff-runner.lock");
  mkdirSync(dirname(path), { recursive: true });
  const acquired = writePlatformOperatorHandoffRunnerExecutionLease(path, commandRef);
  if (acquired) return acquired;
  const stale = stalePlatformOperatorHandoffRunnerExecutionLease(path);
  if (!stale) return { path, acquired: false };
  rmSync(path, { force: true });
  return writePlatformOperatorHandoffRunnerExecutionLease(path, commandRef, stale) ?? { path, acquired: false };
}

function writePlatformOperatorHandoffRunnerExecutionLease(
  path: string,
  commandRef: PlatformOperatorHandoffCommandRef,
  stale?: PlatformOperatorHandoffRunnerStaleExecutionLease,
): PlatformOperatorHandoffRunnerExecutionLease | undefined {
  let fd: number | undefined;
  try {
    const acquiredAt = new Date();
    const expiresAt = new Date(acquiredAt.getTime() + PLATFORM_OPERATOR_HANDOFF_RUNNER_LEASE_TTL_MS);
    const owner = `operator-handoff-runner:${process.pid}`;
    fd = openSync(path, "wx");
    writeFileSync(fd, `${JSON.stringify({
      schemaVersion: "platform-operator-handoff-runner-lock/v1",
      tokenFree: true,
      owner,
      commandLabel: commandRef.label,
      stepId: commandRef.stepId,
      blockingGroupId: commandRef.blockingGroupId,
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ttlMs: PLATFORM_OPERATOR_HANDOFF_RUNNER_LEASE_TTL_MS,
    }, null, 2)}\n`, "utf8");
    closeSync(fd);
    fd = undefined;
    return {
      path,
      acquired: true,
      stepId: commandRef.stepId,
      blockingGroupId: commandRef.blockingGroupId,
      owner,
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ttlMs: PLATFORM_OPERATOR_HANDOFF_RUNNER_LEASE_TTL_MS,
      ...(stale ? { recoveredStale: true, stale } : {}),
    };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (isNodeError(error) && error.code === "EEXIST") return undefined;
    throw error;
  }
}

function stalePlatformOperatorHandoffRunnerExecutionLease(
  path: string,
): PlatformOperatorHandoffRunnerStaleExecutionLease | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  const record = isRecord(value) ? value : undefined;
  if (record?.schemaVersion !== "platform-operator-handoff-runner-lock/v1" || record.tokenFree !== true) return undefined;
  const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : undefined;
  if (!expiresAt) return undefined;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs > Date.now()) return undefined;
  return {
    ...(typeof record.owner === "string" ? { owner: record.owner } : {}),
    ...(typeof record.commandLabel === "string" ? { commandLabel: record.commandLabel } : {}),
    ...(typeof record.stepId === "string" ? { stepId: record.stepId } : {}),
    ...(typeof record.blockingGroupId === "string" ? { blockingGroupId: record.blockingGroupId } : {}),
    ...(typeof record.acquiredAt === "string" ? { acquiredAt: record.acquiredAt } : {}),
    expiresAt,
    ...(typeof record.ttlMs === "number" ? { ttlMs: record.ttlMs } : {}),
  };
}

function releasePlatformOperatorHandoffRunnerExecutionLease(
  executionLease: PlatformOperatorHandoffRunnerExecutionLease,
): void {
  if (executionLease.acquired) rmSync(executionLease.path, { force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
