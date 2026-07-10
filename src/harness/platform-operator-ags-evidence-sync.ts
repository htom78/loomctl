import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { syncPlatformCiArtifactReports, type PlatformCiArtifactSyncResult } from "./platform-ci-artifact-sync.js";
import { type PlatformCiArtifactImportPhase, type PlatformCiArtifactImportResult } from "./platform-ci-artifact-import.js";
import { createPlatformOperatorHandoffPacketFromStatus } from "./platform-operator-handoff-packet.js";
import {
  platformOperatorAgsEvidenceAllowedReports,
  platformOperatorAgsEvidenceImportHandoffSummary,
  platformOperatorAgsEvidenceImportStatusSummary,
  type PlatformOperatorAgsEvidenceImportHandoffSummary,
  type PlatformOperatorAgsEvidenceImportStatusSummary,
} from "./platform-operator-ags-evidence-import.js";
import {
  createPlatformOperatorStatus,
  type PlatformOperatorCockpitNextResult,
  type PlatformOperatorStatusCliOptions,
} from "./platform-operator-status.js";

export interface PlatformOperatorAgsEvidenceSyncCliOptions extends PlatformOperatorStatusCliOptions {
  runId?: string;
  phase?: string;
  artifactName?: string;
  downloadDir?: string;
  importReport?: string;
  ghBin?: string;
}

export interface PlatformOperatorAgsEvidenceSyncResult {
  schemaVersion: "platform-operator-ags-evidence-sync/v1";
  ok: boolean;
  tokenFree: true;
  provider: "github-actions";
  dir: string;
  reportPath?: string;
  runId?: string;
  repo?: string;
  phase: PlatformCiArtifactImportPhase;
  artifactName: string;
  downloadDir: string;
  importReportPath: string;
  handoffPacketPath: string;
  reportPaths: {
    operatorStatus: string;
    operatorCockpitPlan: string;
    operatorCockpitNext: string;
    operatorHandoffPacket: string;
  };
  artifactSyncOk: boolean;
  artifactImportOk: boolean;
  status: PlatformOperatorAgsEvidenceImportStatusSummary;
  handoff: PlatformOperatorAgsEvidenceImportHandoffSummary;
  artifactSync: PlatformCiArtifactSyncResult;
  artifactImport?: PlatformCiArtifactImportResult;
  cockpit: PlatformOperatorCockpitNextResult;
}

export async function syncPlatformOperatorAgsEvidence(
  options: PlatformOperatorAgsEvidenceSyncCliOptions = {},
): Promise<PlatformOperatorAgsEvidenceSyncResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const reportPath = options.report ? resolve(options.report) : undefined;
  const reportDir = join(dir, "reports");
  const phase = platformOperatorAgsEvidenceSyncPhase(options.phase);
  const importReportPath = resolve(options.importReport ?? join(reportDir, "ags-evidence-import.json"));
  const reportPaths = {
    operatorStatus: join(reportDir, "operator-status.json"),
    operatorCockpitPlan: join(reportDir, "operator-cockpit-plan.json"),
    operatorCockpitNext: join(reportDir, "operator-cockpit-next.json"),
    operatorHandoffPacket: join(reportDir, "operator-handoff-packet.json"),
  };
  const artifactSync = await syncPlatformCiArtifactReports({
    dir,
    runId: options.runId,
    repo: options.repo,
    phase,
    artifactName: options.artifactName,
    downloadDir: options.downloadDir,
    importReport: importReportPath,
    ghBin: options.ghBin,
    allowedReports: platformOperatorAgsEvidenceAllowedReports(phase),
  });

  const {
    runId: _runId,
    phase: _phase,
    artifactName: _artifactName,
    downloadDir: _downloadDir,
    importReport: _importReport,
    ghBin: _ghBin,
    report: _report,
    ...statusOptions
  } = options;
  const operatorStatus = createPlatformOperatorStatus({
    ...statusOptions,
    dir,
    report: reportPaths.operatorStatus,
  });
  const handoffPacket = createPlatformOperatorHandoffPacketFromStatus(operatorStatus, reportPaths.operatorHandoffPacket);
  await writeJsonFile(reportPaths.operatorStatus, operatorStatus);
  await writeJsonFile(reportPaths.operatorCockpitPlan, operatorStatus.cockpitPlan);
  await writeJsonFile(reportPaths.operatorCockpitNext, handoffPacket.cockpit);
  await writeJsonFile(reportPaths.operatorHandoffPacket, handoffPacket);

  const status = platformOperatorAgsEvidenceImportStatusSummary(operatorStatus);
  const handoff = platformOperatorAgsEvidenceImportHandoffSummary(handoffPacket);
  return {
    schemaVersion: "platform-operator-ags-evidence-sync/v1",
    ok: artifactSync.ok && status.ok && handoff.ok,
    tokenFree: true,
    provider: "github-actions",
    dir,
    ...(reportPath ? { reportPath } : {}),
    ...(artifactSync.runId ? { runId: artifactSync.runId } : {}),
    ...(artifactSync.repo ? { repo: artifactSync.repo } : {}),
    phase,
    artifactName: artifactSync.artifactName,
    downloadDir: artifactSync.downloadDir,
    importReportPath,
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    artifactSyncOk: artifactSync.ok,
    artifactImportOk: artifactSync.gates.artifactImportOk,
    status,
    handoff,
    artifactSync,
    ...(artifactSync.artifactImport ? { artifactImport: artifactSync.artifactImport } : {}),
    cockpit: handoffPacket.cockpit,
  };
}

function platformOperatorAgsEvidenceSyncPhase(value: unknown): PlatformCiArtifactImportPhase {
  if (value === undefined || value === null || value === "") return "pre-serve";
  if (value !== "pre-serve" && value !== "post-serve" && value !== "all") {
    throw new Error("phase must be pre-serve, post-serve, or all.");
  }
  return value;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
