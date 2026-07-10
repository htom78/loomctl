import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createPlatformOperatorHandoffPacketFromStatus } from "./platform-operator-handoff-packet.js";
import {
  createPlatformOperatorStatus,
  type PlatformOperatorCockpitNextResult,
  type PlatformOperatorStatusCliOptions,
} from "./platform-operator-status.js";
import { writePlatformStagingTargetsApply, type PlatformStagingTargetsApplyResult } from "./platform-staging-targets-apply.js";

export interface PlatformOperatorRealStagingTargetsApplyCliOptions extends PlatformOperatorStatusCliOptions {
  autoRefreshBundle?: boolean;
  expectedInputSha256?: string;
}

export interface PlatformOperatorRealStagingTargetsApplyResult {
  schemaVersion: "platform-operator-real-staging-targets-apply/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  reportPath?: string;
  inputPath: string;
  inputSha256?: string;
  applyReportPath: string;
  realPlanPath: string;
  realTargetsReportPath: string;
  stagingTargetsApply: PlatformStagingTargetsApplyResult;
  bundleRefresh?: PlatformOperatorBundleRefreshResult;
  handoffPacketPath: string;
  reportPaths: {
    operatorStatus: string;
    operatorCockpitPlan: string;
    operatorCockpitNext: string;
    operatorHandoffPacket: string;
  };
  cockpit: PlatformOperatorCockpitNextResult;
}

export interface PlatformOperatorBundleRefreshResult {
  schemaVersion: "platform-operator-bundle-refresh/v1";
  ok: true;
  tokenFree: true;
  dir: string;
  applyReportPath: string;
  applyReportSha256?: string;
  sourceRealPlanPath: string;
  sourceRealPlanSha256: string;
  planPath: string;
  planSha256: string;
  manifestPath: string;
  manifestSha256: string;
  stagingTargetsPlanPath: string;
  stagingTargetsEnvCheckPath: string;
  updatedFiles: string[];
  handoffPacketPath: string;
  reportPaths: PlatformOperatorRealStagingTargetsApplyResult["reportPaths"];
  cockpit: PlatformOperatorCockpitNextResult;
}

export async function applyPlatformOperatorRealStagingTargets(
  options: PlatformOperatorRealStagingTargetsApplyCliOptions = {},
): Promise<PlatformOperatorRealStagingTargetsApplyResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const reportPath = options.report ? resolve(options.report) : undefined;
  const reportDir = join(dir, "reports");
  const inputPath = platformOperatorRealStagingTargetsInputPath(dir);
  const inputSha256 = optionalFileSha256(inputPath);
  const expectedInputSha256 = optionalSha256(options.expectedInputSha256, "expectedInputSha256");
  if (expectedInputSha256 && inputSha256 !== expectedInputSha256) {
    throw new Error("expectedInputSha256 does not match the current real staging target input file.");
  }
  const applyReportPath = join(reportDir, "staging-targets-apply.json");
  const reportPaths = {
    operatorStatus: join(reportDir, "operator-status.json"),
    operatorCockpitPlan: join(reportDir, "operator-cockpit-plan.json"),
    operatorCockpitNext: join(reportDir, "operator-cockpit-next.json"),
    operatorHandoffPacket: join(reportDir, "operator-handoff-packet.json"),
  };
  const stagingTargetsApply = await writePlatformStagingTargetsApply({
    dir,
    input: inputPath,
    report: applyReportPath,
  });
  let bundleRefreshData: Omit<PlatformOperatorBundleRefreshResult, "schemaVersion" | "ok" | "tokenFree" | "dir" | "applyReportPath" | "applyReportSha256" | "handoffPacketPath" | "reportPaths" | "cockpit"> | undefined;
  let applyReportSha256: string | undefined;
  if (options.autoRefreshBundle && stagingTargetsApply.ok) {
    applyReportSha256 = optionalFileSha256(applyReportPath);
    bundleRefreshData = refreshOperatorBundleFromRealPlan({
      dir,
      reportDir,
      applyReportPath,
      applyReportSha256,
      applyReport: stagingTargetsApply,
    });
  }

  const {
    autoRefreshBundle: _autoRefreshBundle,
    expectedInputSha256: _expectedInputSha256,
    report: _report,
    ...statusOptions
  } = options;
  const operatorStatus = createPlatformOperatorStatus({
    ...statusOptions,
    dir,
    report: reportPaths.operatorStatus,
  });
  const handoffPacket = createPlatformOperatorHandoffPacketFromStatus(operatorStatus, reportPaths.operatorHandoffPacket);
  writeJsonFile(reportPaths.operatorStatus, operatorStatus);
  writeJsonFile(reportPaths.operatorCockpitPlan, operatorStatus.cockpitPlan);
  writeJsonFile(reportPaths.operatorCockpitNext, handoffPacket.cockpit);
  writeJsonFile(reportPaths.operatorHandoffPacket, handoffPacket);
  const bundleRefresh: PlatformOperatorBundleRefreshResult | undefined = bundleRefreshData
    ? {
      schemaVersion: "platform-operator-bundle-refresh/v1",
      ok: true,
      tokenFree: true,
      dir,
      applyReportPath,
      ...(applyReportSha256 ? { applyReportSha256 } : {}),
      ...bundleRefreshData,
      handoffPacketPath: reportPaths.operatorHandoffPacket,
      reportPaths,
      cockpit: handoffPacket.cockpit,
    }
    : undefined;

  return {
    schemaVersion: "platform-operator-real-staging-targets-apply/v1",
    ok: stagingTargetsApply.ok,
    tokenFree: true,
    dir,
    ...(reportPath ? { reportPath } : {}),
    inputPath,
    ...(inputSha256 ? { inputSha256 } : {}),
    applyReportPath,
    realPlanPath: stagingTargetsApply.realPlanPath,
    realTargetsReportPath: stagingTargetsApply.realTargetsReportPath,
    stagingTargetsApply,
    ...(bundleRefresh ? { bundleRefresh } : {}),
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    cockpit: handoffPacket.cockpit,
  };
}

function platformOperatorRealStagingTargetsInputPath(dir: string): string {
  const bundleDir = resolve(dir);
  const planPath = join(bundleDir, "reports", "staging-targets-plan.json");
  const plan = parseJsonObject(readFileSync(planPath, "utf8"), "staging-targets-plan report");
  if (plan.schemaVersion !== "platform-staging-targets-plan/v1") {
    throw new Error("staging-targets-plan report must use schemaVersion platform-staging-targets-plan/v1.");
  }
  const inputTemplatePath = requiredString(plan.inputTemplatePath, "inputTemplatePath", 2000);
  const inputPath = resolve(inputTemplatePath);
  if (!pathInside(bundleDir, inputPath)) {
    throw new Error("staging targets inputTemplatePath must stay inside the operator bundle directory.");
  }
  return inputPath;
}

function refreshOperatorBundleFromRealPlan(options: {
  dir: string;
  reportDir: string;
  applyReportPath: string;
  applyReportSha256?: string;
  applyReport: PlatformStagingTargetsApplyResult;
}): Omit<PlatformOperatorBundleRefreshResult, "schemaVersion" | "ok" | "tokenFree" | "dir" | "applyReportPath" | "applyReportSha256" | "handoffPacketPath" | "reportPaths" | "cockpit"> {
  if (!options.applyReport.ok || options.applyReport.missing.length > 0 || options.applyReport.gates.envCheckOk !== true || options.applyReport.gates.realPlanWritten !== true || options.applyReport.gates.realTargetsProofOk !== true) {
    throw new Error("staging-targets-apply report must be ok before bundle refresh.");
  }
  const bundleDir = resolve(options.dir);
  const sourceRealPlanPath = resolve(options.applyReport.realPlanPath);
  if (!pathInside(bundleDir, sourceRealPlanPath)) {
    throw new Error("realPlanPath must stay inside the operator bundle directory.");
  }
  const sourceRealPlanText = readFileSync(sourceRealPlanPath, "utf8");
  const sourceRealPlan = parseJsonObject(sourceRealPlanText, "plan.real-targets.json");
  const sourceRealPlanSha256 = sha256Hex(sourceRealPlanText);
  const planPath = join(bundleDir, "plan.json");
  const updatedFiles = ["plan.json"];
  writeJsonFile(planPath, sourceRealPlan);
  const planSha256 = sha256Hex(readFileSync(planPath, "utf8"));
  if (refreshOperatorBundleUpstreamGuide(bundleDir, sourceRealPlan)) updatedFiles.push("upstream-agent-git-service.json");
  const manifestPath = join(bundleDir, "manifest.json");
  const manifestSha256 = refreshOperatorBundleManifest(bundleDir, manifestPath);
  updatedFiles.push("manifest.json");
  const stagingTargetsPlanPath = join(options.reportDir, "staging-targets-plan.json");
  writeJsonFile(stagingTargetsPlanPath, sanitizedStagingTargetsPlan(bundleDir, stagingTargetsPlanPath));
  updatedFiles.push("reports/staging-targets-plan.json");
  const stagingTargetsEnvCheckPath = join(options.reportDir, "staging-targets-env-check.json");
  writeJsonFile(stagingTargetsEnvCheckPath, sanitizedStagingTargetsEnvCheck(bundleDir, stagingTargetsEnvCheckPath));
  updatedFiles.push("reports/staging-targets-env-check.json");
  writeJsonFile(options.applyReportPath, {
    ...options.applyReport,
    bundleRefresh: compactObject({
      tokenFree: true,
      sourceRealPlanPath,
      sourceRealPlanSha256,
      planPath,
      planSha256,
      manifestPath,
      manifestSha256,
      applyReportSha256: options.applyReportSha256,
    }),
    nextActions: [],
  });
  updatedFiles.push("reports/staging-targets-apply.json");
  if (filterTargetPrerequisitesReport(join(options.reportDir, "staging-prerequisites.json"))) {
    updatedFiles.push("reports/staging-prerequisites.json");
  }
  return {
    sourceRealPlanPath,
    sourceRealPlanSha256,
    planPath,
    planSha256,
    manifestPath,
    manifestSha256,
    stagingTargetsPlanPath,
    stagingTargetsEnvCheckPath,
    updatedFiles,
  };
}

function refreshOperatorBundleUpstreamGuide(dir: string, plan: Record<string, unknown>): boolean {
  const guidePath = join(dir, "upstream-agent-git-service.json");
  const systems = objectRecord(objectRecord(plan.externalEnvironment)?.systems) ?? {};
  const controlPlane = objectRecord(systems.controlPlane);
  const agentGitServiceStaging = objectRecord(systems.agentGitServiceStaging);
  if (!controlPlane && !agentGitServiceStaging) return false;
  let guide: Record<string, unknown> = {
    schemaVersion: "upstream-agent-git-service-staging-guide/v1",
    tokenFree: true,
    upstream: {
      repository: "https://github.com/ngaut/agent-git-service",
      developmentBinary: "gh-server",
      apiBasePath: "/api/v3",
      metadataDatabaseEnv: "DB_DSN",
    },
    requiredServerEnv: [
      { name: "DB_DSN", purpose: "upstream agent-git-service metadata database DSN for gh-server" },
    ],
  };
  if (existsSync(guidePath)) guide = parseJsonObject(readFileSync(guidePath, "utf8"), "upstream-agent-git-service.json");
  writeJsonFile(guidePath, {
    ...guide,
    schemaVersion: "upstream-agent-git-service-staging-guide/v1",
    tokenFree: true,
    targets: compactObject({
      controlPlane,
      agentGitServiceStaging,
    }),
  });
  return true;
}

function refreshOperatorBundleManifest(dir: string, manifestPath: string): string {
  let manifest: Record<string, unknown> = {
    schemaVersion: 1,
    tokenFree: true,
    source: "loom harness platform-cutover-plan",
  };
  if (existsSync(manifestPath)) manifest = parseJsonObject(readFileSync(manifestPath, "utf8"), "manifest.json");
  const existingFiles = stringArray(manifest.files);
  const files = Array.from(new Set([
    ...existingFiles,
    ...[
      "plan.json",
      "env.md",
      "env.sh",
      "external-secrets.json",
      "github-actions-staging.yml",
      "commands.sh",
      "staging-ci.json",
    ].filter((file) => existsSync(join(dir, file))),
    ...(existsSync(join(dir, "upstream-agent-git-service.json")) ? ["upstream-agent-git-service.json"] : []),
  ]));
  const previousFileSha256 = objectRecord(manifest.fileSha256) ?? {};
  const fileSha256: Record<string, string> = {};
  for (const [file, sha] of Object.entries(previousFileSha256)) {
    if (typeof sha === "string") fileSha256[file] = sha;
  }
  for (const file of files) {
    const path = join(dir, file);
    if (existsSync(path)) fileSha256[file] = sha256Hex(readFileSync(path, "utf8"));
  }
  writeJsonFile(manifestPath, {
    ...manifest,
    schemaVersion: manifest.schemaVersion ?? 1,
    tokenFree: true,
    files,
    fileSha256,
  });
  return sha256Hex(readFileSync(manifestPath, "utf8"));
}

function sanitizedStagingTargetsPlan(dir: string, reportPath: string): Record<string, unknown> {
  const inputTemplatePath = join(dir, "real-staging-targets.input.json");
  return {
    schemaVersion: "platform-staging-targets-plan/v1",
    ok: true,
    tokenFree: true,
    dir,
    reportPath,
    planPath: join(dir, "plan.json"),
    realPlanPath: join(dir, "plan.real-targets.json"),
    inputTemplatePath,
    inputTemplate: {
      schemaVersion: "platform-staging-targets-input/v1",
      targets: {
        modelGatewayBaseUrl: "",
        agentGitServiceBaseUrl: "",
        agentGitServiceIssue: "",
        agentGitServiceRepo: "",
        agentGitServiceNativeWriteAttachmentUrl: "",
      },
    },
    currentTargets: {
      modelGateway: { placeholder: false },
      controlPlane: { provider: "agent-git-service", placeholder: false },
      agentGitServiceStaging: {
        issuePlaceholder: false,
        repoPlaceholder: false,
        nativeWriteAttachmentUrlPlaceholder: false,
      },
    },
    placeholderTargets: [],
    requiredEnvNames: [],
    envCheckShellCommands: [],
    envValidationCommandArgs: [],
    envValidationShellCommand: "",
    applyCommandArgs: [],
    applyShellCommand: "",
    applyInputCommandArgs: [],
    applyInputShellCommand: "",
    planPatchJqFilter: "",
    planPatchCommandArgs: [],
    planPatchShellCommand: "",
    validatedPlanPatchShellCommand: "",
    realTargetsCheckCommandArgs: [],
    realTargetsCheckShellCommand: "",
    validatedRealTargetsShellCommand: "",
    bundleRefreshCommandArgs: [],
    prerequisitesCommandArgs: [],
    gates: {
      planReadable: true,
      replacementEnvNamesReady: true,
      planPatchReady: true,
    },
    missing: [],
    nextActions: [],
  };
}

function sanitizedStagingTargetsEnvCheck(dir: string, reportPath: string): Record<string, unknown> {
  return {
    schemaVersion: "platform-staging-targets-env-check/v1",
    ok: true,
    tokenFree: true,
    dir,
    reportPath,
    requiredEnvNames: [],
    checks: {},
    gates: {
      envNamesPresent: true,
      formatsOk: true,
      placeholdersAbsent: true,
    },
    missing: [],
    nextActions: [],
  };
}

function filterTargetPrerequisitesReport(path: string): boolean {
  if (!existsSync(path)) return false;
  const value = parseJsonObject(readFileSync(path, "utf8"), "staging-prerequisites.json");
  if (value.schemaVersion !== "platform-staging-prerequisites/v1") return false;
  const missing = stringArray(value.missing);
  const nextActions = stringArray(value.nextActions);
  const filteredMissing = missing.filter((item) => !item.startsWith("targets."));
  const filteredNextActions = nextActions.filter((item) => !/target replacement|staging target replacement/i.test(item));
  if (filteredMissing.length === missing.length && filteredNextActions.length === nextActions.length) return false;
  writeJsonFile(path, {
    ...value,
    ok: filteredMissing.length === 0,
    missing: filteredMissing,
    nextActions: filteredNextActions,
  });
  return true;
}

function optionalSha256(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = requiredString(value, field, 120);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${field} must be a sha256 hex string.`);
  return text;
}

function optionalFileSha256(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return sha256Hex(readFileSync(path, "utf8"));
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  const text = value.trim();
  if (text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw new Error(`${field} must be a single-line string at most ${maxLength} characters.`);
  }
  return text;
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${label} must be valid JSON.`);
  }
  throw new Error(`${label} must be a JSON object.`);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
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
