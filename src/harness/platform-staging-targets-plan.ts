import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REAL_TARGET_ENV_NAMES = [
  "LOOM_REAL_MODEL_BASE_URL",
  "LOOM_REAL_AGS_BASE_URL",
  "LOOM_REAL_AGS_ISSUE",
  "LOOM_REAL_AGS_REPO",
  "LOOM_REAL_AGS_NATIVE_WRITE_ATTACHMENT_URL",
] as const;

const REAL_TARGET_JQ_FILTER = [
  ".externalEnvironment.systems.modelGateway.baseUrl = env.LOOM_REAL_MODEL_BASE_URL",
  ".externalEnvironment.systems.controlPlane.baseUrl = env.LOOM_REAL_AGS_BASE_URL",
  ".externalEnvironment.systems.agentGitServiceStaging.issue = env.LOOM_REAL_AGS_ISSUE",
  ".externalEnvironment.systems.agentGitServiceStaging.repo = env.LOOM_REAL_AGS_REPO",
  ".externalEnvironment.systems.agentGitServiceStaging.nativeWriteAttachmentUrl = env.LOOM_REAL_AGS_NATIVE_WRITE_ATTACHMENT_URL",
].join(" | ");

export interface PlatformStagingTargetsPlanCliOptions {
  dir?: string;
  plan?: string;
  report?: string;
}

export interface PlatformStagingTargetsEnvCheckCliOptions {
  dir?: string;
  report?: string;
}

export interface PlatformStagingTargetsPlanResult {
  schemaVersion: "platform-staging-targets-plan/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  reportPath?: string;
  planPath: string;
  realPlanPath: string;
  inputTemplatePath: string;
  inputTemplate: PlatformStagingTargetsInputTemplate;
  currentTargets: {
    modelGateway: UrlTargetSummary;
    controlPlane: UrlTargetSummary & {
      provider?: string;
    };
    agentGitServiceStaging: {
      issue?: string;
      repo?: string;
      wikiPage?: string;
      nativeWriteAttachmentUrl?: string;
      issuePlaceholder: boolean;
      repoPlaceholder: boolean;
      nativeWriteAttachmentUrlPlaceholder: boolean;
    };
  };
  placeholderTargets: string[];
  requiredEnvNames: string[];
  envCheckShellCommands: string[];
  envValidationCommandArgs: string[];
  envValidationShellCommand: string;
  applyCommandArgs: string[];
  applyShellCommand: string;
  applyInputCommandArgs: string[];
  applyInputShellCommand: string;
  planPatchJqFilter: string;
  planPatchCommandArgs: string[];
  planPatchShellCommand: string;
  validatedPlanPatchShellCommand: string;
  realTargetsCheckCommandArgs: string[];
  realTargetsCheckShellCommand: string;
  validatedRealTargetsShellCommand: string;
  bundleRefreshCommandArgs: string[];
  prerequisitesCommandArgs: string[];
  gates: {
    planReadable: boolean;
    replacementEnvNamesReady: boolean;
    planPatchReady: boolean;
  };
  missing: string[];
  nextActions: string[];
}

interface UrlTargetSummary {
  baseUrl?: string;
  placeholder: boolean;
}

interface PlatformStagingTargetsInputTemplate {
  schemaVersion: "platform-staging-targets-input/v1";
  targets: {
    modelGatewayBaseUrl: "";
    agentGitServiceBaseUrl: "";
    agentGitServiceIssue: "";
    agentGitServiceRepo: "";
    agentGitServiceNativeWriteAttachmentUrl: "";
  };
}

interface ReplacementEnvCheck {
  envName: string;
  present: boolean;
  formatOk: boolean;
  placeholder: boolean;
}

export interface PlatformStagingTargetsEnvCheckResult {
  schemaVersion: "platform-staging-targets-env-check/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  reportPath?: string;
  requiredEnvNames: string[];
  checks: {
    modelGatewayBaseUrl: ReplacementEnvCheck;
    agentGitServiceBaseUrl: ReplacementEnvCheck;
    agentGitServiceStagingIssue: ReplacementEnvCheck;
    agentGitServiceStagingRepo: ReplacementEnvCheck;
    agentGitServiceNativeWriteAttachmentUrl: ReplacementEnvCheck;
  };
  gates: {
    envNamesPresent: boolean;
    formatsOk: boolean;
    placeholdersAbsent: boolean;
  };
  missing: string[];
  nextActions: string[];
}

export function createPlatformStagingTargetsPlan(
  options: PlatformStagingTargetsPlanCliOptions = {},
): PlatformStagingTargetsPlanResult {
  const dir = resolve(options.dir ?? process.cwd());
  const reportPath = options.report ? resolve(options.report) : undefined;
  const planPath = resolve(options.plan ?? join(dir, "plan.json"));
  const realPlanPath = join(dir, "plan.real-targets.json");
  const inputTemplatePath = join(dir, "real-staging-targets.input.json");
  const plan = readPlan(planPath);
  const targets = currentTargets(plan.value);
  const placeholderTargets = platformStagingPlaceholderTargets(targets);
  const requiredEnvNames = plan.ok && placeholderTargets.length > 0 ? [...REAL_TARGET_ENV_NAMES] : [];
  const envCheckShellCommands = requiredEnvNames.map((name) => `: "\${${name}:?missing ${name}}"`);
  const loomCommand = platformStagingTargetsPlanLoomCommand(dir);
  const envValidationCommandArgs = [
    loomCommand,
    "harness",
    "platform-staging-targets-env-check",
    "--dir",
    dir,
    "--report",
    join(dir, "reports", "staging-targets-env-check.json"),
  ];
  const applyCommandArgs = [
    loomCommand,
    "harness",
    "platform-staging-targets-apply",
    "--dir",
    dir,
    "--report",
    join(dir, "reports", "staging-targets-apply.json"),
  ];
  const applyInputCommandArgs = [
    loomCommand,
    "harness",
    "platform-staging-targets-apply",
    "--dir",
    dir,
    "--input",
    inputTemplatePath,
    "--report",
    join(dir, "reports", "staging-targets-apply.json"),
  ];
  const inputTemplate = platformStagingTargetsInputTemplate();
  const planPatchCommandArgs = ["jq", REAL_TARGET_JQ_FILTER, planPath];
  const planPatchShellCommand = [
    ...envCheckShellCommands,
    `${shellJoin(planPatchCommandArgs)} > ${shellQuote(realPlanPath)}`,
  ].join(" && ");
  const envValidationShellCommand = shellJoin(envValidationCommandArgs);
  const applyShellCommand = shellJoin(applyCommandArgs);
  const applyInputShellCommand = shellJoin(applyInputCommandArgs);
  const realTargetsCheckCommandArgs = [
    loomCommand,
    "harness",
    "platform-staging-targets",
    "--plan",
    realPlanPath,
    "--require-external",
    "--report",
    join(dir, "reports", "real-staging-targets.json"),
  ];
  const realTargetsCheckShellCommand = shellJoin(realTargetsCheckCommandArgs);
  const validatedPlanPatchShellCommand = `${envValidationShellCommand} && ${planPatchShellCommand}`;
  const bundleRefreshCommandArgs = [
    loomCommand,
    "harness",
    "platform-cutover-bundle",
    "--plan",
    realPlanPath,
    "--out",
    dir,
  ];
  const prerequisitesCommandArgs = [
    loomCommand,
    "harness",
    "platform-staging-prerequisites",
    "--dir",
    dir,
    "--require-agent-git-service",
    "--report",
    join(dir, "reports", "staging-prerequisites.json"),
  ];
  const gates = {
    planReadable: plan.ok,
    replacementEnvNamesReady: !plan.ok || placeholderTargets.length === 0 || requiredEnvNames.length > 0,
    planPatchReady: !plan.ok || placeholderTargets.length === 0 || planPatchCommandArgs.length > 0,
  };
  const missing = [
    ...(gates.planReadable ? [] : ["plan.readable"]),
    ...(gates.replacementEnvNamesReady ? [] : ["replacementEnvNames"]),
    ...(gates.planPatchReady ? [] : ["planPatch"]),
  ];
  return {
    schemaVersion: "platform-staging-targets-plan/v1",
    ok: missing.length === 0,
    tokenFree: true,
    dir,
    ...(reportPath ? { reportPath } : {}),
    planPath,
    realPlanPath,
    inputTemplatePath,
    inputTemplate,
    currentTargets: targets,
    placeholderTargets,
    requiredEnvNames,
    envCheckShellCommands,
    envValidationCommandArgs,
    envValidationShellCommand,
    applyCommandArgs,
    applyShellCommand,
    applyInputCommandArgs,
    applyInputShellCommand,
    planPatchJqFilter: REAL_TARGET_JQ_FILTER,
    planPatchCommandArgs,
    planPatchShellCommand,
    validatedPlanPatchShellCommand,
    realTargetsCheckCommandArgs,
    realTargetsCheckShellCommand,
    validatedRealTargetsShellCommand: `${validatedPlanPatchShellCommand} && ${realTargetsCheckShellCommand}`,
    bundleRefreshCommandArgs,
    prerequisitesCommandArgs,
    gates,
    missing,
    nextActions: stagingTargetsPlanNextActions(plan.ok, placeholderTargets.length),
  };
}

function platformStagingTargetsPlanLoomCommand(dir: string): string {
  const explicit = process.env.LOOM_BIN?.trim();
  if (explicit) return explicit;
  const wrapperPath = join(dir, "loom-wrapper");
  return executableFile(wrapperPath) ? wrapperPath : "loom";
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function platformStagingTargetsInputTemplate(): PlatformStagingTargetsInputTemplate {
  return {
    schemaVersion: "platform-staging-targets-input/v1",
    targets: {
      modelGatewayBaseUrl: "",
      agentGitServiceBaseUrl: "",
      agentGitServiceIssue: "",
      agentGitServiceRepo: "",
      agentGitServiceNativeWriteAttachmentUrl: "",
    },
  };
}

export function createPlatformStagingTargetsEnvCheck(
  options: PlatformStagingTargetsEnvCheckCliOptions = {},
): PlatformStagingTargetsEnvCheckResult {
  const dir = resolve(options.dir ?? process.cwd());
  const reportPath = options.report ? resolve(options.report) : undefined;
  const checks = {
    modelGatewayBaseUrl: replacementUrlEnvCheck("LOOM_REAL_MODEL_BASE_URL"),
    agentGitServiceBaseUrl: replacementUrlEnvCheck("LOOM_REAL_AGS_BASE_URL"),
    agentGitServiceStagingIssue: replacementIssueEnvCheck("LOOM_REAL_AGS_ISSUE"),
    agentGitServiceStagingRepo: replacementRepoEnvCheck("LOOM_REAL_AGS_REPO"),
    agentGitServiceNativeWriteAttachmentUrl: replacementUrlEnvCheck("LOOM_REAL_AGS_NATIVE_WRITE_ATTACHMENT_URL"),
  };
  const allChecks = Object.values(checks);
  const gates = {
    envNamesPresent: allChecks.every((check) => check.present),
    formatsOk: allChecks.every((check) => check.formatOk),
    placeholdersAbsent: allChecks.every((check) => !check.placeholder),
  };
  const missing = replacementEnvCheckMissing(allChecks);
  return {
    schemaVersion: "platform-staging-targets-env-check/v1",
    ok: missing.length === 0,
    tokenFree: true,
    dir,
    ...(reportPath ? { reportPath } : {}),
    requiredEnvNames: [...REAL_TARGET_ENV_NAMES],
    checks,
    gates,
    missing,
    nextActions: stagingTargetsEnvCheckNextActions(missing),
  };
}

function readPlan(path: string): { ok: boolean; value?: Record<string, unknown> } {
  if (!existsSync(path)) return { ok: false };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return { ok: isRecord(value), value: isRecord(value) ? value : undefined };
  } catch {
    return { ok: false };
  }
}

function currentTargets(plan: Record<string, unknown> | undefined): PlatformStagingTargetsPlanResult["currentTargets"] {
  const externalEnvironment = isRecord(plan?.externalEnvironment) ? plan.externalEnvironment : {};
  const systems = isRecord(externalEnvironment.systems) ? externalEnvironment.systems : {};
  const modelGateway = isRecord(systems.modelGateway) ? systems.modelGateway : {};
  const controlPlane = isRecord(systems.controlPlane) ? systems.controlPlane : {};
  const agentGitServiceStaging = isRecord(systems.agentGitServiceStaging) ? systems.agentGitServiceStaging : {};
  const modelGatewayBaseUrl = stringValue(modelGateway.baseUrl);
  const controlPlaneBaseUrl = stringValue(controlPlane.baseUrl);
  const nativeWriteAttachmentUrl = stringValue(agentGitServiceStaging.nativeWriteAttachmentUrl);
  const issue = stringValue(agentGitServiceStaging.issue);
  const repo = stringValue(agentGitServiceStaging.repo);
  return {
    modelGateway: {
      ...(modelGatewayBaseUrl ? { baseUrl: modelGatewayBaseUrl } : {}),
      placeholder: placeholderUrl(modelGatewayBaseUrl),
    },
    controlPlane: {
      ...(stringValue(controlPlane.provider) ? { provider: stringValue(controlPlane.provider) } : {}),
      ...(controlPlaneBaseUrl ? { baseUrl: controlPlaneBaseUrl } : {}),
      placeholder: placeholderUrl(controlPlaneBaseUrl),
    },
    agentGitServiceStaging: {
      ...(issue ? { issue } : {}),
      ...(repo ? { repo } : {}),
      ...(stringValue(agentGitServiceStaging.wikiPage) ? { wikiPage: stringValue(agentGitServiceStaging.wikiPage) } : {}),
      ...(nativeWriteAttachmentUrl ? { nativeWriteAttachmentUrl } : {}),
      issuePlaceholder: placeholderIssue(issue),
      repoPlaceholder: placeholderRepo(repo),
      nativeWriteAttachmentUrlPlaceholder: placeholderUrl(nativeWriteAttachmentUrl),
    },
  };
}

function platformStagingPlaceholderTargets(targets: PlatformStagingTargetsPlanResult["currentTargets"]): string[] {
  return [
    ...(targets.modelGateway.placeholder ? ["targets.modelGateway.placeholder"] : []),
    ...(targets.controlPlane.placeholder ? ["targets.controlPlane.placeholder"] : []),
    ...(targets.agentGitServiceStaging.issuePlaceholder ? ["targets.agentGitServiceStaging.issue.placeholder"] : []),
    ...(targets.agentGitServiceStaging.repoPlaceholder ? ["targets.agentGitServiceStaging.repo.placeholder"] : []),
    ...(targets.agentGitServiceStaging.nativeWriteAttachmentUrlPlaceholder
      ? ["targets.agentGitServiceStaging.nativeWriteAttachmentUrl.placeholder"]
      : []),
  ];
}

function placeholderUrl(value: string | undefined): boolean {
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

function placeholderIssue(value: string | undefined): boolean {
  if (!value) return false;
  const match = /^([^/\s]+)\/([^#\s]+)#\d+$/.exec(value.trim());
  return match ? placeholderRepo(`${match[1]}/${match[2]}`) : false;
}

function placeholderRepo(value: string | undefined): boolean {
  if (!value) return false;
  return [
    "org/repo",
    "owner/repo",
    "team/app",
    "team/loom",
    "team/loom-smoke",
  ].includes(value.trim().toLowerCase());
}

function replacementUrlEnvCheck(envName: string): ReplacementEnvCheck {
  const value = stringValue(process.env[envName]);
  const present = value !== undefined;
  return {
    envName,
    present,
    formatOk: present && validHttpUrl(value),
    placeholder: placeholderUrl(value),
  };
}

function replacementIssueEnvCheck(envName: string): ReplacementEnvCheck {
  const value = stringValue(process.env[envName]);
  const present = value !== undefined;
  return {
    envName,
    present,
    formatOk: present && validIssueRef(value),
    placeholder: placeholderIssue(value),
  };
}

function replacementRepoEnvCheck(envName: string): ReplacementEnvCheck {
  const value = stringValue(process.env[envName]);
  const present = value !== undefined;
  return {
    envName,
    present,
    formatOk: present && validRepoRef(value),
    placeholder: placeholderRepo(value),
  };
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

function replacementEnvCheckMissing(checks: ReplacementEnvCheck[]): string[] {
  return [
    ...checks.filter((check) => !check.present).map((check) => `env.${check.envName}`),
    ...checks.filter((check) => check.present && !check.formatOk).map((check) => `format.${check.envName}`),
    ...checks.filter((check) => check.present && check.placeholder).map((check) => `placeholder.${check.envName}`),
  ];
}

function stagingTargetsEnvCheckNextActions(missing: string[]): string[] {
  if (missing.length === 0) {
    return ["Replacement env names are present, correctly shaped, and non-placeholder; run planPatchShellCommand from platform-staging-targets-plan."];
  }
  return [
    "Export all requiredEnvNames with real non-placeholder values, then rerun platform-staging-targets-env-check.",
  ];
}

function stagingTargetsPlanNextActions(planReadable: boolean, placeholderTargetCount: number): string[] {
  if (!planReadable) {
    return ["Regenerate the cutover bundle so plan.json exists and is readable, then rerun platform-staging-targets-plan."];
  }
  if (placeholderTargetCount === 0) {
    return ["No placeholder staging targets detected; rerun platform-staging-prerequisites and platform-external-staging-audit."];
  }
  return [
    "Export requiredEnvNames or write inputTemplatePath from inputTemplate with real non-placeholder LiteLLM, Coder, AGS, issue, repo, and evidence targets.",
    "Run applyCommandArgs or applyInputCommandArgs to validate inputs, write plan.real-targets.json, and prove real targets are strict external.",
    "Run bundleRefreshCommandArgs, then rerun prerequisitesCommandArgs and platform-external-staging-audit.",
  ];
}

function shellJoin(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
