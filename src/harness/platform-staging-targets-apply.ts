import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { createPlatformStagingTargetsEnvCheck } from "./platform-staging-targets-plan.js";

type PlatformStagingTargetClassification = "external" | "rehearsal" | "missing";
type PlatformStagingTargetsInputFieldName =
  | "modelGatewayBaseUrl"
  | "agentGitServiceBaseUrl"
  | "agentGitServiceIssue"
  | "agentGitServiceRepo"
  | "agentGitServiceNativeWriteAttachmentUrl";

const PLATFORM_STAGING_TARGET_INPUT_FIELD_NAMES: PlatformStagingTargetsInputFieldName[] = [
  "modelGatewayBaseUrl",
  "agentGitServiceBaseUrl",
  "agentGitServiceIssue",
  "agentGitServiceRepo",
  "agentGitServiceNativeWriteAttachmentUrl",
];

export interface PlatformStagingTargetsApplyOptions {
  dir: string;
  plan?: string;
  input?: string;
  report?: string;
}

export interface PlatformStagingTargetsApplyResult {
  schemaVersion: "platform-staging-targets-apply/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  reportPath?: string;
  planPath: string;
  realPlanPath: string;
  inputSource: "environment" | "input-file";
  inputPath?: string;
  inputSha256?: string;
  inputProof?: PlatformStagingTargetsInputProof;
  envCheckReportPath: string;
  realTargetsReportPath: string;
  requiredEnvNames: string[];
  realPlanSha256?: string;
  realTargetsReportSha256?: string;
  gates: {
    envCheckOk: boolean;
    realPlanWritten: boolean;
    realTargetsProofOk: boolean;
  };
  missing: string[];
  nextActions: string[];
}

export interface PlatformStagingTargetsInputProof {
  schemaVersion: "platform-staging-targets-input-proof/v1";
  tokenFree: true;
  inputPath: string;
  inputSha256: string;
  byteLength: number;
  fieldNames: string[];
  gates: {
    schemaVersionOk: boolean;
    requiredFieldsPresent: boolean;
    formatsOk: boolean;
    placeholdersAbsent: boolean;
  };
  missing: string[];
}

interface PlatformStagingTargetsResult {
  schemaVersion: "platform-staging-targets/v1";
  ok: boolean;
  tokenFree: true;
  reportPath?: string;
  planPath: string;
  requireExternal: boolean;
  mode: "external-staging" | "rehearsal";
  targets: {
    modelGateway: {
      baseUrl?: string;
      classification: PlatformStagingTargetClassification;
    };
    executor: {
      kind?: string;
      classification: PlatformStagingTargetClassification;
    };
    controlPlane: {
      provider?: string;
      baseUrl?: string;
      classification: PlatformStagingTargetClassification;
    };
    agentGitServiceStaging?: Record<string, unknown>;
  };
  gates: {
    modelGatewayExternal: boolean;
    coderExecutor: boolean;
    agentGitServiceExternal: boolean;
    externalStagingReady: boolean;
  };
  placeholderTargets: string[];
  missing: string[];
}

export async function writePlatformStagingTargetsApply(
  options: PlatformStagingTargetsApplyOptions,
): Promise<PlatformStagingTargetsApplyResult> {
  const dir = resolve(options.dir);
  const reportPath = options.report ? resolve(options.report) : undefined;
  const planPath = resolve(options.plan ?? join(dir, "plan.json"));
  const input = options.input ? platformStagingTargetsInput(resolve(options.input)) : undefined;
  const realPlanPath = join(dir, "plan.real-targets.json");
  const reportDir = join(dir, "reports");
  const envCheckReportPath = join(reportDir, "staging-targets-env-check.json");
  const realTargetsReportPath = join(reportDir, "real-staging-targets.json");
  mkdirSync(reportDir, { recursive: true });

  return withPlatformStagingReplacementEnv(input?.env, async () => {
    const envCheck = createPlatformStagingTargetsEnvCheck({ dir, report: envCheckReportPath });
    writeJsonFile(envCheckReportPath, envCheck);
    const requiredEnvNames = envCheck.requiredEnvNames;
    const missing = [
      ...envCheck.missing,
      ...(input ? input.proof.missing.map((item) => `input.${item}`) : []),
    ];
    let realPlanSha256: string | undefined;
    let realTargetsReportSha256: string | undefined;
    let realTargetsProofOk = false;

    if (envCheck.ok) {
      const realPlanText = `${JSON.stringify(platformStagingRealTargetsPlan(planPath), null, 2)}\n`;
      writeFileSync(realPlanPath, realPlanText, "utf8");
      realPlanSha256 = sha256Hex(realPlanText);
      const realTargets = writePlatformStagingTargets({
        plan: realPlanPath,
        requireExternal: true,
        report: realTargetsReportPath,
      });
      realTargetsProofOk = realTargets.ok;
      const realTargetsReportText = readFileSync(realTargetsReportPath, "utf8");
      realTargetsReportSha256 = sha256Hex(realTargetsReportText);
      missing.push(...realTargets.missing.map((item) => `realTargets.${item}`));
    }

    const gates = {
      envCheckOk: envCheck.ok,
      realPlanWritten: realPlanSha256 !== undefined,
      realTargetsProofOk,
    };
    const result: PlatformStagingTargetsApplyResult = {
      schemaVersion: "platform-staging-targets-apply/v1",
      ok: missing.length === 0 && gates.envCheckOk && gates.realPlanWritten && gates.realTargetsProofOk,
      tokenFree: true,
      dir,
      ...(reportPath ? { reportPath } : {}),
      planPath,
      realPlanPath,
      inputSource: input ? "input-file" : "environment",
      ...(input ? { inputPath: input.path, inputSha256: input.sha256, inputProof: input.proof } : {}),
      envCheckReportPath,
      realTargetsReportPath,
      requiredEnvNames,
      ...(realPlanSha256 ? { realPlanSha256 } : {}),
      ...(realTargetsReportSha256 ? { realTargetsReportSha256 } : {}),
      gates,
      missing,
      nextActions: platformStagingTargetsApplyNextActions(missing, input ? "input-file" : "environment"),
    };
    if (reportPath) writeJsonFile(reportPath, result);
    return result;
  });
}

function platformStagingTargetsInput(path: string): {
  path: string;
  sha256: string;
  proof: PlatformStagingTargetsInputProof;
  env: Record<string, string>;
} {
  const text = readFileSync(path, "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new Error("platform staging targets input must be a JSON object.");
  if (parsed.schemaVersion !== "platform-staging-targets-input/v1") {
    throw new Error("platform staging targets input must use schemaVersion platform-staging-targets-input/v1.");
  }
  const targets = isRecord(parsed.targets) ? parsed.targets : {};
  const sha256 = sha256Hex(text);
  return {
    path,
    sha256,
    proof: platformStagingTargetsInputProof(path, text, sha256, targets),
    env: {
      LOOM_REAL_MODEL_BASE_URL: nonEmptyString(targets.modelGatewayBaseUrl) ?? "",
      LOOM_REAL_AGS_BASE_URL: nonEmptyString(targets.agentGitServiceBaseUrl) ?? "",
      LOOM_REAL_AGS_ISSUE: nonEmptyString(targets.agentGitServiceIssue) ?? "",
      LOOM_REAL_AGS_REPO: nonEmptyString(targets.agentGitServiceRepo) ?? "",
      LOOM_REAL_AGS_NATIVE_WRITE_ATTACHMENT_URL: nonEmptyString(targets.agentGitServiceNativeWriteAttachmentUrl) ?? "",
    },
  };
}

function platformStagingTargetsInputProof(
  inputPath: string,
  text: string,
  inputSha256: string,
  targets: Record<string, unknown>,
): PlatformStagingTargetsInputProof {
  const checks = {
    modelGatewayBaseUrl: targetUrlInputCheck(targets.modelGatewayBaseUrl),
    agentGitServiceBaseUrl: targetUrlInputCheck(targets.agentGitServiceBaseUrl),
    agentGitServiceIssue: targetIssueInputCheck(targets.agentGitServiceIssue),
    agentGitServiceRepo: targetRepoInputCheck(targets.agentGitServiceRepo),
    agentGitServiceNativeWriteAttachmentUrl: targetUrlInputCheck(targets.agentGitServiceNativeWriteAttachmentUrl),
  };
  const entries = PLATFORM_STAGING_TARGET_INPUT_FIELD_NAMES.map((fieldName) => [fieldName, checks[fieldName]] as const);
  const gates = {
    schemaVersionOk: true,
    requiredFieldsPresent: entries.every(([, check]) => check.present),
    formatsOk: entries.every(([, check]) => check.formatOk),
    placeholdersAbsent: entries.every(([, check]) => !check.placeholder),
  };
  const missing = [
    ...entries.filter(([, check]) => !check.present).map(([fieldName]) => `targets.${fieldName}`),
    ...entries.filter(([, check]) => check.present && !check.formatOk).map(([fieldName]) => `formats.${fieldName}`),
    ...entries.filter(([, check]) => check.present && check.placeholder).map(([fieldName]) => `placeholders.${fieldName}`),
  ];
  return {
    schemaVersion: "platform-staging-targets-input-proof/v1",
    tokenFree: true,
    inputPath,
    inputSha256,
    byteLength: Buffer.byteLength(text, "utf8"),
    fieldNames: PLATFORM_STAGING_TARGET_INPUT_FIELD_NAMES.filter((fieldName) =>
      Object.prototype.hasOwnProperty.call(targets, fieldName)
    ),
    gates,
    missing,
  };
}

function targetUrlInputCheck(value: unknown): { present: boolean; formatOk: boolean; placeholder: boolean } {
  const text = nonEmptyString(value);
  return {
    present: text !== undefined,
    formatOk: validHttpUrl(text),
    placeholder: platformStagingPlaceholderUrl(text),
  };
}

function targetIssueInputCheck(value: unknown): { present: boolean; formatOk: boolean; placeholder: boolean } {
  const text = nonEmptyString(value);
  return {
    present: text !== undefined,
    formatOk: validIssueRef(text),
    placeholder: platformStagingPlaceholderIssue(text),
  };
}

function targetRepoInputCheck(value: unknown): { present: boolean; formatOk: boolean; placeholder: boolean } {
  const text = nonEmptyString(value);
  return {
    present: text !== undefined,
    formatOk: validRepoRef(text),
    placeholder: platformStagingPlaceholderRepo(text),
  };
}

async function withPlatformStagingReplacementEnv<T>(
  env: Record<string, string> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!env) return fn();
  const previous = new Map(Object.keys(env).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(env)) process.env[name] = value;
    return await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function platformStagingRealTargetsPlan(planPath: string): Record<string, unknown> {
  const plan = parseJsonObject(readFileSync(planPath, "utf8"), "platform cutover plan");
  const externalEnvironment = isRecord(plan.externalEnvironment) ? { ...plan.externalEnvironment } : {};
  const systems = isRecord(externalEnvironment.systems) ? { ...externalEnvironment.systems } : {};
  const modelGateway = isRecord(systems.modelGateway) ? { ...systems.modelGateway } : {};
  const controlPlane = isRecord(systems.controlPlane) ? { ...systems.controlPlane } : {};
  const agentGitServiceStaging = isRecord(systems.agentGitServiceStaging) ? { ...systems.agentGitServiceStaging } : {};
  modelGateway.baseUrl = process.env.LOOM_REAL_MODEL_BASE_URL;
  controlPlane.baseUrl = process.env.LOOM_REAL_AGS_BASE_URL;
  agentGitServiceStaging.issue = process.env.LOOM_REAL_AGS_ISSUE;
  agentGitServiceStaging.repo = process.env.LOOM_REAL_AGS_REPO;
  agentGitServiceStaging.nativeWriteAttachmentUrl = process.env.LOOM_REAL_AGS_NATIVE_WRITE_ATTACHMENT_URL;
  return {
    ...plan,
    externalEnvironment: {
      ...externalEnvironment,
      systems: {
        ...systems,
        modelGateway,
        controlPlane,
        agentGitServiceStaging,
      },
    },
  };
}

function writePlatformStagingTargets(options: {
  plan: string;
  requireExternal?: boolean;
  report?: string;
}): PlatformStagingTargetsResult {
  const planPath = resolve(options.plan);
  const plan = parseJsonObject(readFileSync(planPath, "utf8"), "platform cutover plan");
  const externalEnvironment = isRecord(plan.externalEnvironment) ? plan.externalEnvironment : {};
  const systems = isRecord(externalEnvironment.systems) ? externalEnvironment.systems : {};
  const modelGateway = isRecord(systems.modelGateway) ? systems.modelGateway : {};
  const executor = isRecord(systems.executor) ? systems.executor : {};
  const controlPlane = isRecord(systems.controlPlane) ? systems.controlPlane : {};
  const agentGitServiceStaging = isRecord(systems.agentGitServiceStaging) ? systems.agentGitServiceStaging : {};
  const modelGatewayBaseUrl = nonEmptyString(modelGateway.baseUrl);
  const executorKind = nonEmptyString(executor.kind);
  const controlPlaneProvider = nonEmptyString(controlPlane.provider);
  const controlPlaneBaseUrl = nonEmptyString(controlPlane.baseUrl);
  const modelGatewayClassification = platformStagingUrlClassification(modelGatewayBaseUrl);
  const executorClassification = executorKind === undefined
    ? "missing"
    : executorKind === "coder" ? "external" : "rehearsal";
  const controlPlaneClassification = platformStagingControlPlaneClassification(controlPlaneProvider, controlPlaneBaseUrl);
  const requireExternal = options.requireExternal === true;
  const placeholderTargets = platformStagingPlaceholderTargets({
    modelGatewayBaseUrl,
    controlPlaneBaseUrl,
    agentGitServiceStaging,
  });
  const gates = {
    modelGatewayExternal: modelGatewayClassification === "external",
    coderExecutor: executorKind === "coder",
    agentGitServiceExternal: controlPlaneProvider === "agent-git-service" && controlPlaneClassification === "external",
    externalStagingReady: false,
  };
  gates.externalStagingReady = gates.modelGatewayExternal &&
    gates.coderExecutor &&
    gates.agentGitServiceExternal &&
    (!requireExternal || placeholderTargets.length === 0);
  const missing = [
    ...(requireExternal && !gates.modelGatewayExternal ? ["targets.modelGateway.external"] : []),
    ...(requireExternal && !gates.coderExecutor ? ["targets.executor.coder"] : []),
    ...(requireExternal && !gates.agentGitServiceExternal ? ["targets.controlPlane.agentGitServiceExternal"] : []),
    ...(requireExternal ? placeholderTargets : []),
  ];
  const result: PlatformStagingTargetsResult = {
    schemaVersion: "platform-staging-targets/v1",
    ok: missing.length === 0,
    tokenFree: true,
    ...(options.report ? { reportPath: resolve(options.report) } : {}),
    planPath,
    requireExternal,
    mode: gates.externalStagingReady ? "external-staging" : "rehearsal",
    targets: {
      modelGateway: {
        ...(modelGatewayBaseUrl ? { baseUrl: modelGatewayBaseUrl } : {}),
        classification: modelGatewayClassification,
      },
      executor: {
        ...(executorKind ? { kind: executorKind } : {}),
        classification: executorClassification,
      },
      controlPlane: {
        ...(controlPlaneProvider ? { provider: controlPlaneProvider } : {}),
        ...(controlPlaneBaseUrl ? { baseUrl: controlPlaneBaseUrl } : {}),
        classification: controlPlaneClassification,
      },
      ...(Object.keys(agentGitServiceStaging).length ? { agentGitServiceStaging } : {}),
    },
    gates,
    placeholderTargets,
    missing,
  };
  if (options.report) writeJsonFile(resolve(options.report), result);
  return result;
}

function platformStagingControlPlaneClassification(
  provider: string | undefined,
  baseUrl: string | undefined,
): PlatformStagingTargetClassification {
  if (provider === undefined) return "missing";
  if (provider !== "agent-git-service") return "rehearsal";
  return platformStagingUrlClassification(baseUrl);
}

function platformStagingPlaceholderTargets(options: {
  modelGatewayBaseUrl?: string;
  controlPlaneBaseUrl?: string;
  agentGitServiceStaging?: Record<string, unknown>;
}): string[] {
  const issue = nonEmptyString(options.agentGitServiceStaging?.issue);
  const repo = nonEmptyString(options.agentGitServiceStaging?.repo);
  const nativeWriteAttachmentUrl = nonEmptyString(options.agentGitServiceStaging?.nativeWriteAttachmentUrl);
  return [
    ...(platformStagingPlaceholderUrl(options.modelGatewayBaseUrl) ? ["targets.modelGateway.placeholder"] : []),
    ...(platformStagingPlaceholderUrl(options.controlPlaneBaseUrl) ? ["targets.controlPlane.placeholder"] : []),
    ...(platformStagingPlaceholderIssue(issue) ? ["targets.agentGitServiceStaging.issue.placeholder"] : []),
    ...(platformStagingPlaceholderRepo(repo) ? ["targets.agentGitServiceStaging.repo.placeholder"] : []),
    ...(platformStagingPlaceholderUrl(nativeWriteAttachmentUrl)
      ? ["targets.agentGitServiceStaging.nativeWriteAttachmentUrl.placeholder"]
      : []),
  ];
}

function platformStagingTargetsApplyNextActions(missing: string[], inputSource: "environment" | "input-file"): string[] {
  if (missing.length === 0) {
    return [
      "Run bundleRefreshCommandArgs from platform-staging-targets-plan, then rerun platform-staging-prerequisites and platform-external-staging-audit.",
    ];
  }
  if (inputSource === "input-file" && missing.some((item) => item.startsWith("input."))) {
    return ["Repair the staging targets input file with real non-placeholder target values, then rerun platform-staging-targets-apply."];
  }
  if (missing.some((item) => item.startsWith("env.") || item.startsWith("format.") || item.startsWith("placeholder."))) {
    return ["Export all requiredEnvNames with real non-placeholder values, then rerun platform-staging-targets-apply."];
  }
  return ["Repair plan.real-targets.json or the replacement env names, then rerun platform-staging-targets-apply."];
}

function platformStagingUrlClassification(value: string | undefined): PlatformStagingTargetClassification {
  if (!value) return "missing";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "missing";
    return platformStagingLocalHostname(url.hostname) ? "rehearsal" : "external";
  } catch {
    return "missing";
  }
}

function platformStagingLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" ||
    host === "0.0.0.0" ||
    host === "127.0.0.1" ||
    host.startsWith("127.") ||
    host === "::1" ||
    host === "[::1]";
}

function platformStagingPlaceholderUrl(value: string | undefined): boolean {
  if (!value) return false;
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

function platformStagingPlaceholderIssue(value: string | undefined): boolean {
  if (!value) return false;
  const match = /^([^/\s]+)\/([^#\s]+)#\d+$/.exec(value.trim());
  return match ? platformStagingPlaceholderRepo(`${match[1]}/${match[2]}`) : false;
}

function platformStagingPlaceholderRepo(value: string | undefined): boolean {
  if (!value) return false;
  return [
    "org/repo",
    "owner/repo",
    "team/app",
    "team/loom",
    "team/loom-smoke",
  ].includes(value.trim().toLowerCase());
}

function validHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validIssueRef(value: string | undefined): boolean {
  return value ? /^([^/\s]+)\/([^#\s]+)#\d+$/.test(value.trim()) : false;
}

function validRepoRef(value: string | undefined): boolean {
  return value ? /^([^/\s]+)\/([^/\s#]+)$/.test(value.trim()) : false;
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must be JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
