import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PLATFORM_CI_RUN_WORKFLOW_FILE = "github-actions-staging.yml";
const PLATFORM_CI_RUN_INSTALL_REPORT = "ci-handoff-install.json";
const PLATFORM_CI_RUN_WORKFLOW_INSTALL_DIR = ".github/workflows";

export type PlatformCiRunProofPhase = "pre-serve" | "post-serve" | "all";

export interface PlatformCiRunProofCliOptions {
  dir?: string;
  repoRoot?: string;
  phase?: string;
  status?: string;
  report?: string;
}

export interface PlatformCiRunProofResult {
  schemaVersion: "platform-ci-run-proof/v1";
  ok: boolean;
  tokenFree: true;
  provider: "github-actions";
  dir: string;
  repoRoot: string;
  reportPath?: string;
  phase: PlatformCiRunProofPhase | string;
  status: string;
  workflow: {
    path: string;
    exists: boolean;
    name?: string;
    sha256?: string;
  };
  installedWorkflow: {
    path: string;
    exists: boolean;
    sha256?: string;
    matchesBundle: boolean;
  };
  installReport: {
    path: string;
    exists: boolean;
    ok?: boolean;
    schemaVersion?: string;
    sha256?: string;
    sourceSha256?: string;
    destinationSha256?: string;
  };
  github: {
    githubActions: boolean;
    workflow?: string;
    workflowRef?: string;
    runId?: string;
    runAttempt?: string;
    runUrl?: string;
    serverUrl?: string;
    repository?: string;
    sha?: string;
    ref?: string;
  };
  gates: {
    githubActionsEnvironment: boolean;
    runIdentityOk: boolean;
    phaseOk: boolean;
    statusOk: boolean;
    workflowOk: boolean;
    installedWorkflowOk: boolean;
    installReportOk: boolean;
  };
  missing: string[];
}

export function createPlatformCiRunProof(
  options: PlatformCiRunProofCliOptions = {},
): PlatformCiRunProofResult {
  const dir = resolve(options.dir ?? process.cwd());
  const repoRoot = resolve(options.repoRoot ?? dirname(dir));
  const reportPath = options.report ? resolve(options.report) : undefined;
  const phase = options.phase ?? process.env.LOOM_CUTOVER_PHASE ?? "pre-serve";
  const status = options.status ?? "success";
  const workflow = readWorkflow(join(dir, PLATFORM_CI_RUN_WORKFLOW_FILE));
  const installedWorkflow = readInstalledWorkflow(
    join(repoRoot, PLATFORM_CI_RUN_WORKFLOW_INSTALL_DIR, PLATFORM_CI_RUN_WORKFLOW_FILE),
    workflow.sha256,
  );
  const installReport = readInstallReport(join(dir, "reports", PLATFORM_CI_RUN_INSTALL_REPORT));
  const github = readGithubActionsEnvironment();
  const gates = {
    githubActionsEnvironment: github.githubActions,
    runIdentityOk: Boolean(github.runId && github.repository && github.serverUrl),
    phaseOk: phase === "pre-serve" || phase === "post-serve" || phase === "all",
    statusOk: status === "success",
    workflowOk: workflow.exists && Boolean(workflow.sha256),
    installedWorkflowOk: installedWorkflow.matchesBundle,
    installReportOk: !installReport.exists || (
      installReport.ok === true &&
      installReport.schemaVersion === "platform-ci-handoff-install/v1" &&
      installReport.sourceSha256 === workflow.sha256 &&
      installReport.destinationSha256 === workflow.sha256
    ),
  };
  const missing = [
    ...(gates.githubActionsEnvironment ? [] : ["github.githubActions"]),
    ...(gates.runIdentityOk ? [] : ["github.runIdentity"]),
    ...(gates.phaseOk ? [] : ["phase"]),
    ...(gates.statusOk ? [] : ["status"]),
    ...(gates.workflowOk ? [] : ["workflow"]),
    ...(gates.installedWorkflowOk ? [] : ["installedWorkflow"]),
    ...(gates.installReportOk ? [] : ["installReport"]),
  ];
  return {
    schemaVersion: "platform-ci-run-proof/v1",
    ok: missing.length === 0,
    tokenFree: true,
    provider: "github-actions",
    dir,
    repoRoot,
    ...(reportPath ? { reportPath } : {}),
    phase,
    status,
    workflow,
    installedWorkflow,
    installReport,
    github,
    gates,
    missing,
  };
}

function readInstalledWorkflow(
  path: string,
  bundleSha256: string | undefined,
): PlatformCiRunProofResult["installedWorkflow"] {
  if (!existsSync(path)) return { path, exists: false, matchesBundle: false };
  const text = readFileSync(path, "utf8");
  const sha256 = sha256Hex(text);
  return {
    path,
    exists: true,
    sha256,
    matchesBundle: bundleSha256 !== undefined && sha256 === bundleSha256,
  };
}

function readWorkflow(path: string): PlatformCiRunProofResult["workflow"] {
  if (!existsSync(path)) return { path, exists: false };
  const text = readFileSync(path, "utf8");
  return {
    path,
    exists: true,
    name: workflowName(text),
    sha256: sha256Hex(text),
  };
}

function readInstallReport(path: string): PlatformCiRunProofResult["installReport"] {
  if (!existsSync(path)) return { path, exists: false };
  try {
    const text = readFileSync(path, "utf8");
    const value = JSON.parse(text) as unknown;
    const record = objectRecord(value);
    const source = objectRecord(record?.source);
    const destination = objectRecord(record?.destination);
    return {
      path,
      exists: true,
      ok: record?.ok === true,
      schemaVersion: stringValue(record?.schemaVersion),
      sha256: sha256Hex(text),
      sourceSha256: stringValue(source?.sha256),
      destinationSha256: stringValue(destination?.sha256),
    };
  } catch {
    return { path, exists: true, ok: false };
  }
}

function readGithubActionsEnvironment(): PlatformCiRunProofResult["github"] {
  const serverUrl = trimTrailingSlash(process.env.GITHUB_SERVER_URL);
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return {
    githubActions: process.env.GITHUB_ACTIONS === "true",
    ...(process.env.GITHUB_WORKFLOW ? { workflow: process.env.GITHUB_WORKFLOW } : {}),
    ...(process.env.GITHUB_WORKFLOW_REF ? { workflowRef: process.env.GITHUB_WORKFLOW_REF } : {}),
    ...(runId ? { runId } : {}),
    ...(process.env.GITHUB_RUN_ATTEMPT ? { runAttempt: process.env.GITHUB_RUN_ATTEMPT } : {}),
    ...(serverUrl ? { serverUrl } : {}),
    ...(repository ? { repository } : {}),
    ...(process.env.GITHUB_SHA ? { sha: process.env.GITHUB_SHA } : {}),
    ...(process.env.GITHUB_REF ? { ref: process.env.GITHUB_REF } : {}),
    ...(serverUrl && repository && runId ? { runUrl: `${serverUrl}/${repository}/actions/runs/${runId}` } : {}),
  };
}

function workflowName(text: string): string | undefined {
  const match = /^name:\s*(.+)\s*$/m.exec(text);
  return match?.[1]?.replace(/^["']|["']$/g, "");
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  return value?.replace(/\/+$/, "");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
