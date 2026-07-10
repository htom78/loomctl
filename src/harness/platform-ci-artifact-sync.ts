import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import {
  importPlatformCiArtifactReports,
  type PlatformCiArtifactImportResult,
} from "./platform-ci-artifact-import.js";

const PLATFORM_CI_ARTIFACT_SYNC_DEFAULT_ARTIFACT_NAME = "loom-staging-reports";

export interface PlatformCiArtifactSyncCliOptions {
  dir?: string;
  runId?: string;
  repo?: string;
  phase?: string;
  artifactName?: string;
  downloadDir?: string;
  importReport?: string;
  ghBin?: string;
  allowedReports?: string[];
  report?: string;
}

export interface PlatformCiArtifactSyncResult {
  schemaVersion: "platform-ci-artifact-sync/v1";
  ok: boolean;
  tokenFree: true;
  provider: "github-actions";
  dir: string;
  reportPath?: string;
  runId?: string;
  repo?: string;
  phase: string;
  artifactName: string;
  downloadDir: string;
  importReportPath: string;
  gh: {
    commandArgs: string[];
    exitCode?: number;
    succeeded: boolean;
  };
  artifactImport?: PlatformCiArtifactImportResult;
  gates: {
    runIdOk: boolean;
    ghDownloadOk: boolean;
    artifactImportOk: boolean;
  };
  missing: string[];
}

export async function syncPlatformCiArtifactReports(
  options: PlatformCiArtifactSyncCliOptions = {},
): Promise<PlatformCiArtifactSyncResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const reportPath = options.report ? resolve(options.report) : undefined;
  const context = await readRunContext(dir);
  const runId = options.runId ?? context.runId;
  const repo = options.repo ?? context.repo;
  const phase = options.phase ?? context.phase ?? "post-serve";
  const artifactName = options.artifactName ?? PLATFORM_CI_ARTIFACT_SYNC_DEFAULT_ARTIFACT_NAME;
  const downloadDir = resolve(options.downloadDir ?? join(dir, ".ci-artifacts", `${phase}-${runId ?? "unknown"}`));
  const importReportPath = resolve(options.importReport ?? join(dir, "reports", "ci-artifact-import.json"));
  const ghBin = options.ghBin ?? "gh";
  const ghCommandArgs = [
    ghBin,
    "run",
    "download",
    runId ?? "",
    ...(repo ? ["--repo", repo] : []),
    "--name",
    artifactName,
    "--dir",
    downloadDir,
  ];

  if (!runId) {
    return result({
      dir,
      reportPath,
      ...(repo ? { repo } : {}),
      phase,
      artifactName,
      downloadDir,
      importReportPath,
      gh: {
        commandArgs: ghCommandArgs,
        succeeded: false,
      },
      gates: {
        runIdOk: false,
        ghDownloadOk: false,
        artifactImportOk: false,
      },
    });
  }

  await mkdir(downloadDir, { recursive: true });
  const gh = await execa(ghBin, ghCommandArgs.slice(1), {
    reject: false,
  });
  let artifactImport: PlatformCiArtifactImportResult | undefined;
  if (gh.exitCode === 0) {
    artifactImport = await importPlatformCiArtifactReports({
      dir,
    artifactDir: downloadDir,
    phase,
    runId,
    ...(options.allowedReports ? { allowedReports: options.allowedReports } : {}),
    report: importReportPath,
  });
    await writeJson(importReportPath, artifactImport);
  }
  return result({
    dir,
    reportPath,
    runId,
    ...(repo ? { repo } : {}),
    phase,
    artifactName,
    downloadDir,
    importReportPath,
    gh: {
      commandArgs: ghCommandArgs,
      exitCode: gh.exitCode,
      succeeded: gh.exitCode === 0,
    },
    ...(artifactImport ? { artifactImport } : {}),
    gates: {
      runIdOk: true,
      ghDownloadOk: gh.exitCode === 0,
      artifactImportOk: artifactImport?.ok === true,
    },
  });
}

function result(options: Omit<PlatformCiArtifactSyncResult, "schemaVersion" | "ok" | "tokenFree" | "provider" | "missing">): PlatformCiArtifactSyncResult {
  const missing = [
    ...(options.gates.runIdOk ? [] : ["github.runId"]),
    ...(options.gates.ghDownloadOk ? [] : ["github.artifactDownload"]),
    ...(options.gates.artifactImportOk ? [] : ["ciArtifactImport"]),
  ];
  return {
    schemaVersion: "platform-ci-artifact-sync/v1",
    ok: Object.values(options.gates).every(Boolean),
    tokenFree: true,
    provider: "github-actions",
    ...options,
    missing,
  };
}

async function readRunContext(dir: string): Promise<{ runId?: string; repo?: string; phase?: string }> {
  const reportDir = join(dir, "reports");
  const workflowWait = await readWorkflowWait(join(reportDir, "ci-workflow-wait.json"));
  const workflowDispatch = await readWorkflowDispatch(join(reportDir, "ci-workflow-dispatch.json"));
  const proof = await readRunProof(join(reportDir, "ci-run-proof.json"));
  return {
    runId: workflowWait.runId ?? workflowDispatch.runId ?? proof.runId,
    repo: workflowWait.repo ?? workflowDispatch.repo ?? proof.repo,
    phase: workflowWait.phase ?? workflowDispatch.phase ?? proof.phase,
  };
}

async function readWorkflowWait(path: string): Promise<{ runId?: string; repo?: string; phase?: string }> {
  const record = await readReportRecord(path);
  if (
    record?.schemaVersion !== "platform-ci-workflow-wait/v1" ||
    record.ok !== true ||
    record.tokenFree !== true ||
    record.provider !== "github-actions"
  ) {
    return {};
  }
  const run = objectRecord(record.run);
  return {
    runId: stringValue(record.runId) ?? stringValue(run?.id),
    repo: stringValue(record.repo),
    phase: stringValue(record.phase),
  };
}

async function readWorkflowDispatch(path: string): Promise<{ runId?: string; repo?: string; phase?: string }> {
  const record = await readReportRecord(path);
  if (
    record?.schemaVersion !== "platform-ci-workflow-dispatch/v1" ||
    record.ok !== true ||
    record.tokenFree !== true ||
    record.provider !== "github-actions"
  ) {
    return {};
  }
  const run = objectRecord(record.run);
  return {
    runId: stringValue(run?.id),
    repo: stringValue(record.repo),
    phase: stringValue(record.phase),
  };
}

async function readRunProof(path: string): Promise<{ runId?: string; repo?: string; phase?: string }> {
  const record = await readReportRecord(path);
  if (!record) return {};
  const github = objectRecord(record.github);
  return {
    runId: stringValue(github?.runId),
    repo: stringValue(github?.repository),
    phase: stringValue(record.phase),
  };
}

async function readReportRecord(path: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(path)) return {};
  try {
    const text = await readFile(path, "utf8");
    const value = JSON.parse(text) as unknown;
    return objectRecord(value);
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
