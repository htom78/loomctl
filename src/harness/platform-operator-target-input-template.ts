import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createPlatformOperatorHandoffPacketFromStatus } from "./platform-operator-handoff-packet.js";
import {
  createPlatformOperatorStatus,
  type PlatformOperatorCockpitNextResult,
  type PlatformOperatorStatusCliOptions,
  type PlatformOperatorStatusCockpitInputRef,
  type PlatformOperatorStatusTargetInputFileSummary,
} from "./platform-operator-status.js";

export interface PlatformOperatorTargetInputTemplateCliOptions extends PlatformOperatorStatusCliOptions {
  overwrite?: boolean;
}

export interface PlatformOperatorTargetInputTemplateResult {
  schemaVersion: "platform-operator-target-input-template/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  reportPath?: string;
  inputPath?: string;
  inputSha256?: string;
  byteLength?: number;
  fieldNames: string[];
  written: boolean;
  existed: boolean;
  overwritten: boolean;
  inputFile?: PlatformOperatorStatusTargetInputFileSummary;
  reportPaths: {
    operatorStatus: string;
    operatorCockpitPlan: string;
    operatorCockpitNext: string;
    operatorHandoffPacket: string;
  };
  cockpit?: PlatformOperatorCockpitNextResult;
  missing: string[];
  nextActions: string[];
}

export function writePlatformOperatorTargetInputTemplate(
  options: PlatformOperatorTargetInputTemplateCliOptions = {},
): PlatformOperatorTargetInputTemplateResult {
  const dir = resolve(options.dir ?? process.cwd());
  const reportDir = join(dir, "reports");
  const reportPaths = {
    operatorStatus: join(reportDir, "operator-status.json"),
    operatorCockpitPlan: join(reportDir, "operator-cockpit-plan.json"),
    operatorCockpitNext: join(reportDir, "operator-cockpit-next.json"),
    operatorHandoffPacket: join(reportDir, "operator-handoff-packet.json"),
  };
  const initialStatus = createPlatformOperatorStatus({ ...options, dir });
  const inputRef = platformOperatorTargetInputTemplateRef(initialStatus.cockpitPlan.execution.nextInputRefs) ??
    initialStatus.blockingGroups
      .flatMap((group) => group.targetInputRefs ?? [])
      .find((ref) => ref.inputTemplatePath && ref.inputTemplate);
  const reportPath = options.report ? resolve(options.report) : undefined;
  if (!inputRef?.inputTemplatePath || !inputRef.inputTemplate) {
    return {
      schemaVersion: "platform-operator-target-input-template/v1",
      ok: false,
      tokenFree: true,
      dir,
      ...(reportPath ? { reportPath } : {}),
      fieldNames: [],
      written: false,
      existed: false,
      overwritten: false,
      reportPaths,
      missing: ["targetInputTemplate"],
      nextActions: ["Run platform-staging-targets-plan so the operator status contains a target input template."],
    };
  }

  const inputPath = resolve(inputRef.inputTemplatePath);
  const existed = existsSync(inputPath);
  const shouldWrite = !existed || options.overwrite === true;
  if (shouldWrite) {
    mkdirSync(dirname(inputPath), { recursive: true });
    writeFileSync(inputPath, `${JSON.stringify(inputRef.inputTemplate, null, 2)}\n`, "utf8");
  }

  const inputText = readFileSync(inputPath, "utf8");
  const operatorStatus = createPlatformOperatorStatus({
    ...options,
    dir,
    report: reportPaths.operatorStatus,
  });
  const handoffPacket = createPlatformOperatorHandoffPacketFromStatus(operatorStatus, reportPaths.operatorHandoffPacket);
  mkdirSync(reportDir, { recursive: true });
  writeJsonFile(reportPaths.operatorStatus, operatorStatus);
  writeJsonFile(reportPaths.operatorCockpitPlan, operatorStatus.cockpitPlan);
  writeJsonFile(reportPaths.operatorCockpitNext, handoffPacket.cockpit);
  writeJsonFile(reportPaths.operatorHandoffPacket, handoffPacket);
  const refreshedInputFile = handoffPacket.blockingGroups
    .flatMap((group) => group.targetInputRefs ?? [])
    .find((ref) => resolve(ref.inputTemplatePath) === inputPath)
    ?.inputFile;
  const fieldNames = platformOperatorTargetInputTemplateFieldNames(inputRef.inputTemplate);
  const missing = refreshedInputFile?.ok === true ? [] : refreshedInputFile?.missing ?? [];
  return {
    schemaVersion: "platform-operator-target-input-template/v1",
    ok: true,
    tokenFree: true,
    dir,
    ...(reportPath ? { reportPath } : {}),
    inputPath,
    inputSha256: sha256Hex(inputText),
    byteLength: Buffer.byteLength(inputText, "utf8"),
    fieldNames,
    written: shouldWrite,
    existed,
    overwritten: existed && shouldWrite,
    ...(refreshedInputFile ? { inputFile: refreshedInputFile } : {}),
    reportPaths,
    cockpit: handoffPacket.cockpit,
    missing,
    nextActions: platformOperatorTargetInputTemplateNextActions(refreshedInputFile?.ok === true),
  };
}

function platformOperatorTargetInputTemplateRef(
  refs: PlatformOperatorStatusCockpitInputRef[] | undefined,
): Extract<PlatformOperatorStatusCockpitInputRef, { kind: "target-input-file" }> | undefined {
  return refs?.find((ref): ref is Extract<PlatformOperatorStatusCockpitInputRef, { kind: "target-input-file" }> =>
    ref.kind === "target-input-file" && Boolean(ref.inputTemplatePath && ref.inputTemplate)
  );
}

function platformOperatorTargetInputTemplateFieldNames(template: Record<string, unknown>): string[] {
  const targets = template.targets;
  return targets && typeof targets === "object" && !Array.isArray(targets)
    ? Object.keys(targets)
    : [];
}

function platformOperatorTargetInputTemplateNextActions(inputReady: boolean): string[] {
  if (inputReady) {
    return ["Run platform-operator-cockpit-runner --execute to apply the ready real staging target input."];
  }
  return ["Edit inputPath with real non-placeholder values, then rerun platform-operator-status or platform-operator-cockpit-runner."];
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
