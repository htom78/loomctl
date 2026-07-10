import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createPlatformOperatorStatus,
  type PlatformOperatorCockpitNextResult,
  type PlatformOperatorStatusCliOptions,
  type PlatformOperatorStatusResult,
} from "./platform-operator-status.js";
import {
  runPlatformOperatorCockpitRunner,
  type PlatformOperatorCockpitRunnerResult,
} from "./platform-operator-cockpit-runner.js";
import { createPlatformOperatorHandoffPacketFromStatus } from "./platform-operator-handoff-packet.js";

export interface PlatformOperatorCockpitLoopCliOptions extends PlatformOperatorStatusCliOptions {
  execute?: boolean;
  maxSteps?: string | number;
}

export interface PlatformOperatorCockpitLoopResult {
  schemaVersion: "platform-operator-cockpit-loop/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  reportPath?: string;
  execute: boolean;
  maxSteps: number;
  iterations: PlatformOperatorCockpitLoopIteration[];
  final: {
    ok: boolean;
    phase?: string;
    state?: string;
    mode?: PlatformOperatorCockpitRunnerResult["mode"];
  };
  missing: string[];
}

export interface PlatformOperatorCockpitLoopIteration {
  index: number;
  statusPath: string;
  cockpitPlanPath: string;
  cockpitNextPath: string;
  handoffPacketPath: string;
  runnerPath: string;
  status: PlatformOperatorCockpitLoopStatusSummary;
  phase: PlatformOperatorStatusResult["phase"];
  state: PlatformOperatorCockpitNextResult["state"];
  runner: PlatformOperatorCockpitRunnerResult;
}

export interface PlatformOperatorCockpitLoopStatusSummary {
  schemaVersion: PlatformOperatorStatusResult["schemaVersion"];
  ok: boolean;
  tokenFree: true;
  phase: PlatformOperatorStatusResult["phase"];
  gates: PlatformOperatorStatusResult["gates"];
  ciHandoff: Pick<PlatformOperatorStatusResult["ciHandoff"], "provider" | "ready" | "githubTarget">;
  agentGitService: PlatformOperatorStatusResult["agentGitService"];
  blockingGroups: PlatformOperatorStatusResult["blockingGroups"];
  missing: string[];
  nextActions: string[];
}

export async function runPlatformOperatorCockpitLoop(
  options: PlatformOperatorCockpitLoopCliOptions = {},
): Promise<PlatformOperatorCockpitLoopResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const reportDir = join(dir, "reports");
  const reportPath = options.report ? resolve(options.report) : undefined;
  const execute = options.execute === true;
  const maxSteps = parseMaxSteps(options.maxSteps);
  const iterations: PlatformOperatorCockpitLoopIteration[] = [];

  for (let index = 0; index < maxSteps; index += 1) {
    const statusPath = join(reportDir, "operator-status.json");
    const cockpitPlanPath = join(reportDir, "operator-cockpit-plan.json");
    const cockpitNextPath = join(reportDir, "operator-cockpit-next.json");
    const handoffPacketPath = join(reportDir, "operator-handoff-packet.json");
    const runnerPath = join(reportDir, "operator-cockpit-runner.json");
    const status = createPlatformOperatorStatus({
      ...statusOptions(options),
      dir,
      report: statusPath,
    });
    const cockpitNext = cockpitNextFromStatus(status);
    const handoffPacket = createPlatformOperatorHandoffPacketFromStatus(status, handoffPacketPath);
    await writeJson(statusPath, status);
    await writeJson(cockpitPlanPath, status.cockpitPlan);
    await writeJson(cockpitNextPath, cockpitNext);
    await writeJson(handoffPacketPath, handoffPacket);
    const runner = await runPlatformOperatorCockpitRunner({
      dir,
      next: cockpitNextPath,
      execute,
      report: runnerPath,
    });
    await writeJson(runnerPath, runner);
    iterations.push({
      index,
      statusPath,
      cockpitPlanPath,
      cockpitNextPath,
      handoffPacketPath,
      runnerPath,
      status: cockpitLoopStatusSummary(status),
      phase: status.phase,
      state: cockpitNext.state,
      runner,
    });

    if (!execute || runner.mode !== "executed" || !runner.ok) break;
  }

  const last = iterations[iterations.length - 1];
  const final = {
    ok: last?.runner.ok ?? false,
    ...(last?.phase ? { phase: last.phase } : {}),
    ...(last?.state ? { state: last.state } : {}),
    ...(last?.runner.mode ? { mode: last.runner.mode } : {}),
  };
  return {
    schemaVersion: "platform-operator-cockpit-loop/v1",
    ok: final.ok,
    tokenFree: true,
    dir,
    ...(reportPath ? { reportPath } : {}),
    execute,
    maxSteps,
    iterations,
    final,
    missing: last?.runner.missing ?? ["iterations"],
  };
}

function cockpitLoopStatusSummary(status: PlatformOperatorStatusResult): PlatformOperatorCockpitLoopStatusSummary {
  return {
    schemaVersion: status.schemaVersion,
    ok: status.ok,
    tokenFree: true,
    phase: status.phase,
    gates: status.gates,
    ciHandoff: {
      provider: status.ciHandoff.provider,
      ready: status.ciHandoff.ready,
      githubTarget: status.ciHandoff.githubTarget,
    },
    agentGitService: status.agentGitService,
    blockingGroups: status.blockingGroups,
    missing: status.missing,
    nextActions: status.nextActions,
  };
}

function statusOptions(options: PlatformOperatorCockpitLoopCliOptions): PlatformOperatorStatusCliOptions {
  return {
    ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
    ...(options.repo ? { repo: options.repo } : {}),
    ...(options.ref ? { ref: options.ref } : {}),
    requireExternalStaging: options.requireExternalStaging,
    requireOperatorApprovals: options.requireOperatorApprovals,
    requireAgentGitService: options.requireAgentGitService,
  };
}

function cockpitNextFromStatus(status: PlatformOperatorStatusResult): PlatformOperatorCockpitNextResult {
  const execution = status.cockpitPlan.execution;
  return {
    schemaVersion: "platform-operator-cockpit-next/v1",
    tokenFree: true,
    phase: status.cockpitPlan.phase,
    state: execution.state,
    pendingStepCount: execution.pendingStepCount,
    missingInputCount: execution.missingInputCount,
    commandRefCount: execution.commandRefCount,
    ...(execution.currentStepId ? { currentStepId: execution.currentStepId } : {}),
    ...(execution.currentBlockingGroupId ? { currentBlockingGroupId: execution.currentBlockingGroupId } : {}),
    ...(execution.currentStepMissingInputCount !== undefined
      ? { currentStepMissingInputCount: execution.currentStepMissingInputCount }
      : {}),
    ...(execution.nextInputRefs?.length ? { inputRefs: execution.nextInputRefs } : {}),
    ...(execution.nextCommandRef ? { commandRef: execution.nextCommandRef } : {}),
  };
}

function parseMaxSteps(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "1", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(Math.floor(parsed), 20);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
