import { accessSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import {
  createPlatformOperatorStatus,
  type PlatformOperatorCockpitNextResult,
  type PlatformOperatorStatusBlockingGroup,
  type PlatformOperatorStatusCliOptions,
  type PlatformOperatorStatusCockpitInputRef,
  type PlatformOperatorStatusCockpitStep,
  type PlatformOperatorStatusCommandRef,
  type PlatformOperatorStatusGithubTargetRef,
  type PlatformOperatorStatusResult,
  type PlatformOperatorStatusSecretRef,
} from "./platform-operator-status.js";

export interface PlatformOperatorHandoffPacketCliOptions extends PlatformOperatorStatusCliOptions {}

export interface PlatformOperatorHandoffPacketResult {
  schemaVersion: "platform-operator-handoff-packet/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  reportDir: string;
  reportPath?: string;
  phase: PlatformOperatorStatusResult["phase"];
  requiredProof: {
    requireExternalStaging: boolean;
    requireOperatorApprovals: boolean;
    requireAgentGitService: boolean;
  };
  status: {
    schemaVersion: PlatformOperatorStatusResult["schemaVersion"];
    ok: boolean;
    phase: PlatformOperatorStatusResult["phase"];
    missing: string[];
    gates: PlatformOperatorStatusResult["gates"];
  };
  cockpit: PlatformOperatorCockpitNextResult;
  githubActions: {
    provider: PlatformOperatorStatusResult["ciHandoff"]["provider"];
    ready: boolean;
    target: PlatformOperatorStatusResult["ciHandoff"]["githubTarget"];
    targetRefs: PlatformOperatorStatusGithubTargetRef[];
    secretRefs: PlatformOperatorStatusSecretRef[];
    workflowDispatchInputs: PlatformOperatorStatusResult["ciHandoff"]["workflowDispatchInputs"];
    workflowDispatchCommandArgs: string[];
  };
  agentGitService: PlatformOperatorStatusResult["agentGitService"];
  handoff: {
    blockingGroupIds: string[];
    missingInputCount: number;
    commandRefCount: number;
    inputRefs: PlatformOperatorStatusCockpitInputRef[];
    commandRefs: PlatformOperatorHandoffCommandRef[];
    nextActions: string[];
  };
  blockingGroups: PlatformOperatorStatusBlockingGroup[];
  evidence: {
    reports: PlatformOperatorStatusResult["reports"];
  };
}

export interface PlatformOperatorHandoffCommandRef extends PlatformOperatorStatusCommandRef {
  stepId: PlatformOperatorStatusCockpitStep["id"] | string;
  blockingGroupId: string;
  runnerCommandArgs: string[];
  runnerExecuteCommandArgs: string[];
}

export function createPlatformOperatorHandoffPacket(
  options: PlatformOperatorHandoffPacketCliOptions = {},
): PlatformOperatorHandoffPacketResult {
  const status = createPlatformOperatorStatus(options);
  const reportPath = options.report ? resolve(options.report) : undefined;
  return createPlatformOperatorHandoffPacketFromStatus(status, reportPath);
}

export function createPlatformOperatorHandoffPacketFromStatus(
  status: PlatformOperatorStatusResult,
  reportPath?: string,
): PlatformOperatorHandoffPacketResult {
  const githubGroup = status.blockingGroups.find((group) => group.id === "github-actions");
  const cockpit = cockpitNextFromStatus(status);
  const commandRefs = handoffCommandRefs(status);
  return {
    schemaVersion: "platform-operator-handoff-packet/v1",
    ok: status.ok,
    tokenFree: true,
    dir: status.dir,
    reportDir: status.reportDir,
    ...(reportPath ? { reportPath } : {}),
    phase: status.phase,
    requiredProof: {
      requireExternalStaging: status.requireExternalStaging,
      requireOperatorApprovals: status.requireOperatorApprovals,
      requireAgentGitService: status.requireAgentGitService,
    },
    status: {
      schemaVersion: status.schemaVersion,
      ok: status.ok,
      phase: status.phase,
      missing: status.missing,
      gates: status.gates,
    },
    cockpit,
    githubActions: {
      provider: status.ciHandoff.provider,
      ready: status.ciHandoff.ready,
      target: status.ciHandoff.githubTarget,
      targetRefs: githubGroup?.githubTargetRefs ?? [],
      secretRefs: githubGroup?.secretRefs ?? [],
      workflowDispatchInputs: status.ciHandoff.workflowDispatchInputs,
      workflowDispatchCommandArgs: status.ciHandoff.workflowDispatchCommandArgs,
    },
    agentGitService: status.agentGitService,
    handoff: {
      blockingGroupIds: handoffBlockingGroupIds(status),
      missingInputCount: status.cockpitPlan.execution.missingInputCount,
      commandRefCount: commandRefs.length,
      inputRefs: handoffInputRefs(status),
      commandRefs,
      nextActions: status.nextActions,
    },
    blockingGroups: status.blockingGroups,
    evidence: {
      reports: status.reports,
    },
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

function handoffInputRefs(status: PlatformOperatorStatusResult): PlatformOperatorStatusCockpitInputRef[] {
  return status.cockpitPlan.steps.flatMap((step) => step.inputRefs ?? []).filter((ref) => ref.present === false);
}

function handoffCommandRefs(status: PlatformOperatorStatusResult): PlatformOperatorHandoffCommandRef[] {
  return status.blockingGroups.flatMap((group) =>
    (group.commandRefs ?? []).map((ref) => handoffCommandRef(status, group.id, ref)),
  );
}

function handoffCommandRef(
  status: PlatformOperatorStatusResult,
  blockingGroupId: string,
  ref: PlatformOperatorStatusCommandRef,
): PlatformOperatorHandoffCommandRef {
  const stepId = status.cockpitPlan.steps.find((step) => step.blockingGroupId === blockingGroupId)?.id ?? blockingGroupId;
  return {
    stepId,
    blockingGroupId,
    ...ref,
    runnerCommandArgs: handoffRunnerCommandArgs(status, blockingGroupId, ref.label, stepId, false),
    runnerExecuteCommandArgs: handoffRunnerCommandArgs(status, blockingGroupId, ref.label, stepId, true),
  };
}

function handoffRunnerCommandArgs(
  status: PlatformOperatorStatusResult,
  blockingGroupId: string,
  label: string,
  stepId: string,
  execute: boolean,
): string[] {
  return [
    handoffLoomCommand(status.dir),
    "harness",
    "platform-operator-handoff-runner",
    "--dir",
    status.dir,
    "--blocking-group",
    blockingGroupId,
    "--label",
    label,
    "--step",
    stepId,
    ...(execute ? ["--execute"] : []),
    "--report",
    join(
      status.reportDir,
      `operator-handoff-runner-${handoffRunnerReportNamePart(blockingGroupId)}-${handoffRunnerReportNamePart(label)}${execute ? "-execute" : ""}.json`,
    ),
  ];
}

function handoffRunnerReportNamePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "command";
}

function handoffLoomCommand(dir: string): string {
  const explicit = process.env.LOOM_BIN?.trim();
  if (explicit) return explicit;
  const wrapperPath = join(dir, "loom-wrapper");
  return handoffExecutableFile(wrapperPath) ? wrapperPath : "loom";
}

function handoffExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function handoffBlockingGroupIds(status: PlatformOperatorStatusResult): string[] {
  return status.blockingGroups.map((group) => group.id);
}
