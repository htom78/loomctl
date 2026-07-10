import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  installPlatformCiHandoff,
  type PlatformCiHandoffInstallResult,
} from "./platform-ci-handoff-install.js";
import {
  checkPlatformCiHandoffPreflight,
  type PlatformCiHandoffPreflightResult,
} from "./platform-ci-handoff-preflight.js";
import {
  syncPlatformCiArtifactReports,
  type PlatformCiArtifactSyncResult,
} from "./platform-ci-artifact-sync.js";
import type { PlatformCiArtifactImportResult } from "./platform-ci-artifact-import.js";
import {
  dispatchPlatformCiWorkflow,
  type PlatformCiWorkflowDispatchResult,
} from "./platform-ci-workflow-dispatch.js";
import {
  waitForPlatformCiWorkflow,
  type PlatformCiWorkflowWaitResult,
} from "./platform-ci-workflow-wait.js";
import {
  createPlatformOperatorStatus,
  type PlatformOperatorStatusResult,
} from "./platform-operator-status.js";

export interface PlatformCiHandoffRunCliOptions {
  dir?: string;
  repoRoot?: string;
  phase?: string;
  workflow?: string;
  loomBin?: string;
  bundleDir?: string;
  nodeVersion?: string;
  bootstrapSourceTree?: string | boolean;
  ref?: string;
  intervalSeconds?: string | number;
  artifactName?: string;
  downloadDir?: string;
  ghBin?: string;
  preflight?: boolean;
  repo?: string;
  target?: string;
  resume?: boolean;
  requireExternalStaging?: boolean;
  requireOperatorApprovals?: boolean;
  requireAgentGitService?: boolean;
  report?: string;
}

export interface PlatformCiHandoffRunResult {
  schemaVersion: "platform-ci-handoff-run/v1";
  ok: boolean;
  tokenFree: true;
  provider: "github-actions";
  dir: string;
  reportPath?: string;
  phase: string;
  resume: boolean;
  preflightEnabled: boolean;
  reused: {
    workflowDispatch: boolean;
    workflowWait: boolean;
  };
  reports: {
    preflight: string;
    workflowInstall: string;
    workflowDispatch: string;
    workflowWait: string;
    artifactSync: string;
    artifactImport: string;
    operatorStatus: string;
  };
  preflight?: PlatformCiHandoffPreflightResult;
  workflowInstall?: PlatformCiHandoffInstallResult;
  workflowDispatch?: PlatformCiWorkflowDispatchResult;
  workflowWait?: PlatformCiWorkflowWaitResult;
  artifactSync?: PlatformCiArtifactSyncResult;
  artifactImport?: PlatformCiArtifactImportResult;
  operatorStatus?: PlatformOperatorStatusResult;
  gates: {
    preflightOk?: boolean;
    installOk: boolean;
    dispatchOk: boolean;
    waitOk: boolean;
    artifactSyncOk: boolean;
    artifactDownloadOk?: boolean;
    artifactImportOk?: boolean;
    operatorStatusWritten: boolean;
  };
  missing: string[];
}

export async function runPlatformCiHandoff(
  options: PlatformCiHandoffRunCliOptions = {},
): Promise<PlatformCiHandoffRunResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const reportPath = options.report ? resolve(options.report) : undefined;
  const phase = options.phase ?? "post-serve";
  const resume = options.resume === true;
  const preflightEnabled = options.preflight === true;
  const reused = {
    workflowDispatch: false,
    workflowWait: false,
  };
  const reportDir = join(dir, "reports");
  const handoffRunReport = join(reportDir, "ci-handoff-run.json");
  const reports = {
    preflight: join(reportDir, "ci-handoff-preflight.json"),
    workflowInstall: join(reportDir, "ci-handoff-install.json"),
    workflowDispatch: join(reportDir, "ci-workflow-dispatch.json"),
    workflowWait: join(reportDir, "ci-workflow-wait.json"),
    artifactSync: join(reportDir, "ci-artifact-sync.json"),
    artifactImport: join(reportDir, "ci-artifact-import.json"),
    operatorStatus: join(reportDir, "operator-status.json"),
  };

  let workflowInstall = preflightEnabled && options.repoRoot
    ? await installPlatformCiHandoff({
      dir,
      repoRoot: options.repoRoot,
      report: reports.workflowInstall,
    })
    : undefined;
  if (workflowInstall) await writeJson(reports.workflowInstall, workflowInstall);
  if (workflowInstall && !workflowInstall.ok) {
    return handoffRunResult({
      dir,
      reportPath,
      phase,
      resume,
      preflightEnabled,
      reused,
      reports,
      workflowInstall,
      gates: {
        ...(preflightEnabled ? { preflightOk: false } : {}),
        installOk: false,
        dispatchOk: false,
        waitOk: false,
        artifactSyncOk: false,
        operatorStatusWritten: false,
      },
    });
  }

  const preflight = preflightEnabled
    ? await checkPlatformCiHandoffPreflight({
      dir,
      repoRoot: options.repoRoot,
      workflow: options.workflow,
      repo: options.repo,
      ref: options.ref,
      target: options.target,
      ghBin: options.ghBin,
      report: reports.preflight,
    })
    : undefined;
  if (preflight) await writeJson(reports.preflight, preflight);
  if (preflight && !preflight.ok) {
    const operatorStatus = createOperatorStatus(dir, reports.operatorStatus, options);
    await writeJson(reports.operatorStatus, operatorStatus);
    return handoffRunResult({
      dir,
      reportPath,
      phase,
      resume,
      preflightEnabled,
      reused,
      reports,
      preflight,
      ...(workflowInstall ? { workflowInstall } : {}),
      operatorStatus,
      gates: {
        preflightOk: false,
        installOk: workflowInstall?.ok === true,
        dispatchOk: false,
        waitOk: false,
        artifactSyncOk: false,
        operatorStatusWritten: true,
      },
    });
  }
  const githubTarget = platformCiHandoffRunGithubTarget(options, preflight);

  workflowInstall ??= await installPlatformCiHandoff({
    dir,
    repoRoot: options.repoRoot,
    report: reports.workflowInstall,
  });
  await writeJson(reports.workflowInstall, workflowInstall);
  if (!workflowInstall.ok) {
    return handoffRunResult({
      dir,
      reportPath,
      phase,
      resume,
      preflightEnabled,
      reused,
      reports,
      preflight,
      workflowInstall,
      gates: {
        ...(preflightEnabled ? { preflightOk: true } : {}),
        installOk: false,
        dispatchOk: false,
        waitOk: false,
        artifactSyncOk: false,
        operatorStatusWritten: false,
      },
    });
  }

  let workflowDispatch = resume
    ? await readWorkflowDispatchReport(reports.workflowDispatch, phase, githubTarget)
    : undefined;
  reused.workflowDispatch = workflowDispatch !== undefined;
  if (!workflowDispatch) {
    workflowDispatch = await dispatchPlatformCiWorkflow({
      dir,
      phase,
      workflow: options.workflow,
      loomBin: options.loomBin,
      bundleDir: options.bundleDir,
      nodeVersion: options.nodeVersion,
      bootstrapSourceTree: options.bootstrapSourceTree,
      repo: githubTarget.repo,
      ref: githubTarget.ref,
      ghBin: options.ghBin,
      report: reports.workflowDispatch,
    });
    await writeJson(reports.workflowDispatch, workflowDispatch);
  }
  if (!workflowDispatch.ok) {
    const operatorStatus = createOperatorStatus(dir, reports.operatorStatus, options);
    await writeJson(reports.operatorStatus, operatorStatus);
    return handoffRunResult({
      dir,
      reportPath,
      phase,
      resume,
      preflightEnabled,
      reused,
      reports,
      preflight,
      workflowInstall,
      workflowDispatch,
      operatorStatus,
      gates: {
        ...(preflightEnabled ? { preflightOk: true } : {}),
        installOk: true,
        dispatchOk: false,
        waitOk: false,
        artifactSyncOk: false,
        operatorStatusWritten: true,
      },
    });
  }

  let workflowWait = resume
    ? await readWorkflowWaitReport(reports.workflowWait, phase, workflowDispatch.run?.id, githubTarget)
    : undefined;
  reused.workflowWait = workflowWait !== undefined;
  if (!workflowWait) {
    workflowWait = await waitForPlatformCiWorkflow({
      dir,
      runId: workflowDispatch.run?.id,
      repo: githubTarget.repo,
      phase,
      intervalSeconds: options.intervalSeconds,
      ghBin: options.ghBin,
      report: reports.workflowWait,
    });
    await writeJson(reports.workflowWait, workflowWait);
  }
  if (!workflowWait.ok) {
    const operatorStatus = createOperatorStatus(dir, reports.operatorStatus, options);
    await writeJson(reports.operatorStatus, operatorStatus);
    return handoffRunResult({
      dir,
      reportPath,
      phase,
      resume,
      preflightEnabled,
      reused,
      reports,
      preflight,
      workflowInstall,
      workflowDispatch,
      workflowWait,
      operatorStatus,
      gates: {
        ...(preflightEnabled ? { preflightOk: true } : {}),
        installOk: true,
        dispatchOk: true,
        waitOk: false,
        artifactSyncOk: false,
        operatorStatusWritten: true,
      },
    });
  }

  const artifactSync = await syncPlatformCiArtifactReports({
    dir,
    runId: workflowDispatch.run?.id ?? workflowWait.runId,
    repo: githubTarget.repo,
    phase,
    artifactName: options.artifactName,
    downloadDir: options.downloadDir,
    importReport: reports.artifactImport,
    ghBin: options.ghBin,
    report: reports.artifactSync,
  });
  await writeJson(reports.artifactSync, artifactSync);
  const commonGates = {
    ...(preflightEnabled ? { preflightOk: true } : {}),
    installOk: true,
    dispatchOk: true,
    waitOk: true,
    artifactSyncOk: artifactSync.ok,
    artifactDownloadOk: artifactSync.gates.ghDownloadOk,
    artifactImportOk: artifactSync.gates.artifactImportOk,
  };
  const commonResult = {
    dir,
    reportPath,
    phase,
    resume,
    preflightEnabled,
    reused,
    reports,
    preflight,
    workflowInstall,
    workflowDispatch,
    workflowWait,
    artifactSync,
    ...(artifactSync.artifactImport ? { artifactImport: artifactSync.artifactImport } : {}),
  };
  await writeJson(handoffRunReport, handoffRunResult({
    ...commonResult,
    gates: {
      ...commonGates,
      operatorStatusWritten: false,
    },
  }));
  const statusSeed = createOperatorStatus(dir, reports.operatorStatus, options);
  await writeJson(handoffRunReport, handoffRunResult({
    ...commonResult,
    operatorStatus: statusSeed,
    gates: {
      ...commonGates,
      operatorStatusWritten: true,
    },
  }));
  const operatorStatus = createOperatorStatus(dir, reports.operatorStatus, options);
  await writeJson(reports.operatorStatus, operatorStatus);
  const result = handoffRunResult({
    ...commonResult,
    operatorStatus,
    gates: {
      ...commonGates,
      operatorStatusWritten: true,
    },
  });
  await writeJson(handoffRunReport, result);
  return result;
}

function platformCiHandoffRunGithubTarget(
  options: PlatformCiHandoffRunCliOptions,
  preflight: PlatformCiHandoffPreflightResult | undefined,
): { repo?: string; ref?: string } {
  const repo = options.repo ?? preflight?.repo ?? preflight?.repository?.nameWithOwner;
  const ref = options.ref ?? preflight?.ref ?? preflight?.repository?.defaultBranch;
  return {
    ...(repo ? { repo } : {}),
    ...(ref ? { ref } : {}),
  };
}

function createOperatorStatus(
  dir: string,
  report: string,
  options: PlatformCiHandoffRunCliOptions,
): PlatformOperatorStatusResult {
  return createPlatformOperatorStatus({
    dir,
    repoRoot: options.repoRoot,
    requireExternalStaging: options.requireExternalStaging,
    requireOperatorApprovals: options.requireOperatorApprovals,
    requireAgentGitService: options.requireAgentGitService,
    report,
  });
}

async function readWorkflowDispatchReport(
  path: string,
  phase: string,
  githubTarget: { repo?: string; ref?: string },
): Promise<PlatformCiWorkflowDispatchResult | undefined> {
  const value = await readJson(path);
  if (!value) return undefined;
  const record = objectRecord(value);
  const run = objectRecord(record?.run);
  if (
    record?.schemaVersion !== "platform-ci-workflow-dispatch/v1" ||
    record.ok !== true ||
    record.tokenFree !== true ||
    record.provider !== "github-actions" ||
    record.phase !== phase ||
    (githubTarget.repo !== undefined && record.repo !== githubTarget.repo) ||
    (githubTarget.ref !== undefined && record.ref !== githubTarget.ref) ||
    typeof run?.id !== "string" ||
    !run.id
  ) {
    return undefined;
  }
  return value as PlatformCiWorkflowDispatchResult;
}

async function readWorkflowWaitReport(
  path: string,
  phase: string,
  runId: string | undefined,
  githubTarget: { repo?: string },
): Promise<PlatformCiWorkflowWaitResult | undefined> {
  const value = await readJson(path);
  if (!value) return undefined;
  const record = objectRecord(value);
  const run = objectRecord(record?.run);
  const reportRunId = typeof record?.runId === "string" ? record.runId : run?.id;
  if (
    record?.schemaVersion !== "platform-ci-workflow-wait/v1" ||
    record.ok !== true ||
    record.tokenFree !== true ||
    record.provider !== "github-actions" ||
    record.phase !== phase ||
    (githubTarget.repo !== undefined && record.repo !== githubTarget.repo) ||
    typeof reportRunId !== "string" ||
    !reportRunId ||
    (runId !== undefined && reportRunId !== runId)
  ) {
    return undefined;
  }
  return value as PlatformCiWorkflowWaitResult;
}

function handoffRunResult(
  value: Omit<PlatformCiHandoffRunResult, "schemaVersion" | "ok" | "tokenFree" | "provider" | "missing">,
): PlatformCiHandoffRunResult {
  const artifactDetailsPresent = value.gates.artifactDownloadOk !== undefined || value.gates.artifactImportOk !== undefined;
  const missing = [
    ...(value.gates.preflightOk === false ? ["ciHandoff.preflight"] : []),
    ...(value.gates.installOk ? [] : ["ciHandoff.workflowInstall"]),
    ...(value.gates.dispatchOk ? [] : ["ciHandoff.workflowDispatch"]),
    ...(value.gates.waitOk ? [] : ["ciHandoff.workflowWait"]),
    ...(value.gates.artifactSyncOk || artifactDetailsPresent ? [] : ["ciHandoff.artifactSync"]),
    ...(value.gates.artifactDownloadOk === false ? ["ciHandoff.artifactDownload"] : []),
    ...(value.gates.artifactDownloadOk !== false && value.gates.artifactImportOk === false ? ["ciHandoff.artifactImport"] : []),
    ...(value.gates.operatorStatusWritten ? [] : ["operatorStatus"]),
  ];
  return {
    schemaVersion: "platform-ci-handoff-run/v1",
    ok: Object.values(value.gates).every(Boolean),
    tokenFree: true,
    provider: "github-actions",
    ...value,
    missing,
  };
}

async function readJson(path: string): Promise<unknown | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
