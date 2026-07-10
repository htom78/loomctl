import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createPlatformOperatorHandoffPacketFromStatus } from "./platform-operator-handoff-packet.js";
import {
  createPlatformOperatorStatus,
  type PlatformOperatorCockpitNextResult,
  type PlatformOperatorStatusCliOptions,
  type PlatformOperatorStatusCockpitInputRef,
  type PlatformOperatorStatusTargetInputFileSummary,
} from "./platform-operator-status.js";

export interface PlatformOperatorRealStagingTargetInputCliOptions extends PlatformOperatorStatusCliOptions {
  input?: string;
}

export interface PlatformOperatorRealStagingTargetInputResult {
  schemaVersion: "platform-operator-target-input-write/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  reportPath?: string;
  inputPath?: string;
  inputSha256?: string;
  byteLength?: number;
  fieldNames: string[];
  inputFile?: PlatformOperatorStatusTargetInputFileSummary;
  handoffPacketPath?: string;
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

type PlatformStagingTargetsInput = {
  schemaVersion: "platform-staging-targets-input/v1";
  targets: {
    modelGatewayBaseUrl: string;
    agentGitServiceBaseUrl: string;
    agentGitServiceIssue: string;
    agentGitServiceRepo: string;
    agentGitServiceNativeWriteAttachmentUrl: string;
  };
};

export function writePlatformOperatorRealStagingTargetInput(
  options: PlatformOperatorRealStagingTargetInputCliOptions = {},
): PlatformOperatorRealStagingTargetInputResult {
  const dir = resolve(options.dir ?? process.cwd());
  const reportDir = join(dir, "reports");
  const reportPath = options.report ? resolve(options.report) : undefined;
  const reportPaths = {
    operatorStatus: join(reportDir, "operator-status.json"),
    operatorCockpitPlan: join(reportDir, "operator-cockpit-plan.json"),
    operatorCockpitNext: join(reportDir, "operator-cockpit-next.json"),
    operatorHandoffPacket: join(reportDir, "operator-handoff-packet.json"),
  };
  const initialStatus = createPlatformOperatorStatus({ ...options, dir });
  const inputRef = platformOperatorRealStagingTargetInputRef(initialStatus.cockpitPlan.execution.nextInputRefs) ??
    initialStatus.blockingGroups
      .flatMap((group) => group.targetInputRefs ?? [])
      .find((ref) => ref.inputTemplatePath);
  if (!inputRef?.inputTemplatePath) {
    return {
      schemaVersion: "platform-operator-target-input-write/v1",
      ok: false,
      tokenFree: true,
      dir,
      ...(reportPath ? { reportPath } : {}),
      fieldNames: [],
      reportPaths,
      missing: ["targetInputTemplate"],
      nextActions: ["Run platform-staging-targets-plan so the operator status contains a real staging target input path."],
    };
  }

  const inputPath = resolve(inputRef.inputTemplatePath);
  if (!pathInside(dir, inputPath)) {
    throw new Error("staging targets inputTemplatePath must stay inside the operator bundle directory.");
  }
  const input = platformOperatorRealStagingTargetInput(options.input);
  const inputText = `${JSON.stringify(input, null, 2)}\n`;
  mkdirSync(dirname(inputPath), { recursive: true });
  writeFileSync(inputPath, inputText, "utf8");

  const { input: _input, report: _report, ...statusOptions } = options;
  const operatorStatus = createPlatformOperatorStatus({
    ...statusOptions,
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
  const inputSha256 = sha256Hex(inputText);
  return {
    schemaVersion: "platform-operator-target-input-write/v1",
    ok: true,
    tokenFree: true,
    dir,
    ...(reportPath ? { reportPath } : {}),
    inputPath,
    inputSha256,
    byteLength: Buffer.byteLength(inputText, "utf8"),
    fieldNames: Object.keys(input.targets),
    ...(refreshedInputFile ? { inputFile: refreshedInputFile } : {}),
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    cockpit: handoffPacket.cockpit,
    missing: refreshedInputFile?.ok === true ? [] : refreshedInputFile?.missing ?? [],
    nextActions: refreshedInputFile?.ok === true
      ? ["Run platform-operator-cockpit-runner --execute to apply the ready real staging target input."]
      : ["Fix input file values, then rerun platform-operator-real-staging-target-input."],
  };
}

function platformOperatorRealStagingTargetInputRef(
  refs: PlatformOperatorStatusCockpitInputRef[] | undefined,
): Extract<PlatformOperatorStatusCockpitInputRef, { kind: "target-input-file" }> | undefined {
  return refs?.find((ref): ref is Extract<PlatformOperatorStatusCockpitInputRef, { kind: "target-input-file" }> =>
    ref.kind === "target-input-file" && Boolean(ref.inputTemplatePath)
  );
}

function platformOperatorRealStagingTargetInput(path: string | undefined): PlatformStagingTargetsInput {
  if (!path) throw new Error("input is required.");
  const text = readFileSync(resolve(path), "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("input must be a JSON object.");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "platform-staging-targets-input/v1") {
    throw new Error("input must use schemaVersion platform-staging-targets-input/v1.");
  }
  const targets = record.targets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) throw new Error("input.targets must be an object.");
  const targetRecord = targets as Record<string, unknown>;
  return {
    schemaVersion: "platform-staging-targets-input/v1",
    targets: {
      modelGatewayBaseUrl: operatorRealStagingTargetUrl(targetRecord.modelGatewayBaseUrl, "targets.modelGatewayBaseUrl"),
      agentGitServiceBaseUrl: operatorRealStagingTargetUrl(targetRecord.agentGitServiceBaseUrl, "targets.agentGitServiceBaseUrl"),
      agentGitServiceIssue: operatorRealStagingTargetIssue(targetRecord.agentGitServiceIssue, "targets.agentGitServiceIssue"),
      agentGitServiceRepo: operatorRealStagingTargetRepo(targetRecord.agentGitServiceRepo, "targets.agentGitServiceRepo"),
      agentGitServiceNativeWriteAttachmentUrl: operatorRealStagingTargetUrl(
        targetRecord.agentGitServiceNativeWriteAttachmentUrl,
        "targets.agentGitServiceNativeWriteAttachmentUrl",
      ),
    },
  };
}

function operatorRealStagingTargetUrl(value: unknown, field: string): string {
  const text = operatorRealStagingTargetString(value, field, 1000);
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid protocol");
  } catch {
    throw new Error(`${field} must be an http or https URL.`);
  }
  if (operatorRealStagingTargetPlaceholderUrl(text)) throw new Error(`${field} must not be a placeholder URL.`);
  return text;
}

function operatorRealStagingTargetIssue(value: unknown, field: string): string {
  const text = operatorRealStagingTargetString(value, field, 300);
  if (!/^([^/\s]+)\/([^#\s]+)#\d+$/.test(text)) throw new Error(`${field} must be owner/repo#number.`);
  if (operatorRealStagingTargetPlaceholderIssue(text)) throw new Error(`${field} must not be a placeholder issue.`);
  return text;
}

function operatorRealStagingTargetRepo(value: unknown, field: string): string {
  const text = operatorRealStagingTargetString(value, field, 300);
  if (!/^([^/\s]+)\/([^/\s#]+)$/.test(text)) throw new Error(`${field} must be owner/repo.`);
  if (operatorRealStagingTargetPlaceholderRepo(text)) throw new Error(`${field} must not be a placeholder repo.`);
  return text;
}

function operatorRealStagingTargetString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  const text = value.trim();
  if (text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw new Error(`${field} must be a single-line string at most ${maxLength} characters.`);
  }
  return text;
}

function operatorRealStagingTargetPlaceholderUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "example.com" ||
      hostname === "example.net" ||
      hostname === "example.org" ||
      hostname.endsWith(".example") ||
      hostname.endsWith(".example.com") ||
      hostname.endsWith(".example.net") ||
      hostname.endsWith(".example.org");
  } catch {
    return false;
  }
}

function operatorRealStagingTargetPlaceholderIssue(value: string): boolean {
  const match = /^([^/\s]+)\/([^#\s]+)#\d+$/.exec(value.trim());
  return match ? operatorRealStagingTargetPlaceholderRepo(`${match[1]}/${match[2]}`) : false;
}

function operatorRealStagingTargetPlaceholderRepo(value: string): boolean {
  return [
    "org/repo",
    "owner/repo",
    "team/app",
    "team/loom",
    "team/loom-smoke",
  ].includes(value.trim().toLowerCase());
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && rel !== "..");
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
