import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { importPlatformCiArtifactReports, type PlatformCiArtifactImportPhase, type PlatformCiArtifactImportResult } from "./platform-ci-artifact-import.js";
import { createPlatformOperatorHandoffPacketFromStatus, type PlatformOperatorHandoffPacketResult } from "./platform-operator-handoff-packet.js";
import {
  createPlatformOperatorStatus,
  type PlatformOperatorCockpitNextResult,
  type PlatformOperatorStatusCliOptions,
  type PlatformOperatorStatusResult,
} from "./platform-operator-status.js";

const PLATFORM_OPERATOR_AGS_EVIDENCE_PRE_SERVE_REPORTS = [
  "upstream-agent-git-service-server-env-plan.json",
  "upstream-agent-git-service-handoff.json",
  "agent-git-service-staging-readiness.json",
  "agent-git-service-compat/manifest.json",
  "agent-git-service-compat/baseline.json",
  "agent-git-service-compat/candidate.json",
  "agent-git-service-compat/compare.json",
];

const PLATFORM_OPERATOR_AGS_EVIDENCE_POST_SERVE_REPORTS = [
  "agent-git-service-native-write-check.json",
];

export interface PlatformOperatorAgsEvidenceImportCliOptions extends PlatformOperatorStatusCliOptions {
  artifactDir?: string;
  phase?: string;
  runId?: string;
}

export interface PlatformOperatorAgsEvidenceImportResult {
  schemaVersion: "platform-operator-ags-evidence-import/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  artifactDir: string;
  phase: PlatformCiArtifactImportPhase;
  runId?: string;
  reportPath?: string;
  importReportPath: string;
  handoffPacketPath: string;
  reportPaths: {
    operatorStatus: string;
    operatorCockpitPlan: string;
    operatorCockpitNext: string;
    operatorHandoffPacket: string;
  };
  artifactImportOk: boolean;
  status: PlatformOperatorAgsEvidenceImportStatusSummary;
  handoff: PlatformOperatorAgsEvidenceImportHandoffSummary;
  artifactImport: PlatformCiArtifactImportResult;
  cockpit: PlatformOperatorCockpitNextResult;
}

export interface PlatformOperatorAgsEvidenceImportStatusSummary {
  schemaVersion: PlatformOperatorStatusResult["schemaVersion"];
  ok: boolean;
  phase: PlatformOperatorStatusResult["phase"];
  productionCutoverReady: boolean;
  ciHandoffReady: boolean;
  missing: string[];
  blockingGroupCount: number;
}

export interface PlatformOperatorAgsEvidenceImportHandoffSummary {
  schemaVersion: PlatformOperatorHandoffPacketResult["schemaVersion"];
  ok: boolean;
  phase: PlatformOperatorHandoffPacketResult["phase"];
  blockingGroupIds: string[];
  nextActionCount: number;
}

export async function importPlatformOperatorAgsEvidence(
  options: PlatformOperatorAgsEvidenceImportCliOptions = {},
): Promise<PlatformOperatorAgsEvidenceImportResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const reportPath = options.report ? resolve(options.report) : undefined;
  const reportDir = join(dir, "reports");
  const artifactDir = platformOperatorAgsEvidenceArtifactDir(dir, options.artifactDir);
  const phase = platformOperatorAgsEvidencePhase(options.phase);
  const runId = platformOperatorAgsEvidenceRunId(options.runId);
  const importReportPath = join(reportDir, "ags-evidence-import.json");
  const reportPaths = {
    operatorStatus: join(reportDir, "operator-status.json"),
    operatorCockpitPlan: join(reportDir, "operator-cockpit-plan.json"),
    operatorCockpitNext: join(reportDir, "operator-cockpit-next.json"),
    operatorHandoffPacket: join(reportDir, "operator-handoff-packet.json"),
  };
  const artifactImport = await importPlatformCiArtifactReports({
    dir,
    artifactDir,
    phase,
    allowedReports: platformOperatorAgsEvidenceAllowedReports(phase),
    ...(runId ? { runId } : {}),
    report: importReportPath,
  });
  await writeJsonFile(importReportPath, artifactImport);

  const {
    artifactDir: _artifactDir,
    phase: _phase,
    runId: _runId,
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
    schemaVersion: "platform-operator-ags-evidence-import/v1",
    ok: artifactImport.ok && status.ok && handoff.ok,
    tokenFree: true,
    dir,
    artifactDir,
    phase,
    ...(runId ? { runId } : {}),
    ...(reportPath ? { reportPath } : {}),
    importReportPath,
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    artifactImportOk: artifactImport.ok,
    status,
    handoff,
    artifactImport,
    cockpit: handoffPacket.cockpit,
  };
}

export function platformOperatorAgsEvidenceImportStatusSummary(
  status: PlatformOperatorStatusResult,
): PlatformOperatorAgsEvidenceImportStatusSummary {
  return {
    schemaVersion: status.schemaVersion,
    ok: status.ok,
    phase: status.phase,
    productionCutoverReady: status.gates.productionCutoverReady,
    ciHandoffReady: status.gates.ciHandoffReady,
    missing: status.missing,
    blockingGroupCount: status.blockingGroups.length,
  };
}

export function platformOperatorAgsEvidenceImportHandoffSummary(
  handoff: PlatformOperatorHandoffPacketResult,
): PlatformOperatorAgsEvidenceImportHandoffSummary {
  return {
    schemaVersion: handoff.schemaVersion,
    ok: handoff.ok,
    phase: handoff.phase,
    blockingGroupIds: handoff.handoff.blockingGroupIds,
    nextActionCount: handoff.handoff.nextActions.length,
  };
}

export function platformOperatorAgsEvidenceAllowedReports(phase: PlatformCiArtifactImportPhase): string[] {
  if (phase === "pre-serve") return PLATFORM_OPERATOR_AGS_EVIDENCE_PRE_SERVE_REPORTS;
  if (phase === "post-serve") return PLATFORM_OPERATOR_AGS_EVIDENCE_POST_SERVE_REPORTS;
  return [
    ...PLATFORM_OPERATOR_AGS_EVIDENCE_PRE_SERVE_REPORTS,
    ...PLATFORM_OPERATOR_AGS_EVIDENCE_POST_SERVE_REPORTS,
  ];
}

function platformOperatorAgsEvidenceArtifactDir(dir: string, value: unknown): string {
  const bundleDir = resolve(dir);
  const text = platformOperatorAgsEvidenceString(value, "artifactDir", 2000);
  const artifactDir = resolve(isAbsolute(text) ? text : join(bundleDir, text));
  if (!pathInside(bundleDir, artifactDir)) {
    throw new Error("artifactDir must stay inside the operator bundle directory.");
  }
  return artifactDir;
}

function platformOperatorAgsEvidencePhase(value: unknown): PlatformCiArtifactImportPhase {
  if (value === undefined || value === null || value === "") return "pre-serve";
  const phase = platformOperatorAgsEvidenceString(value, "phase", 40);
  if (phase !== "pre-serve" && phase !== "post-serve" && phase !== "all") {
    throw new Error("phase must be pre-serve, post-serve, or all.");
  }
  return phase;
}

function platformOperatorAgsEvidenceRunId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const runId = platformOperatorAgsEvidenceString(value, "runId", 120);
  if (!/^[A-Za-z0-9_.:-]+$/.test(runId)) throw new Error("runId must be a safe single token.");
  return runId;
}

function platformOperatorAgsEvidenceString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  const text = value.trim();
  if (text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw new Error(`${field} must be a single-line string at most ${maxLength} characters.`);
  }
  return text;
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && rel !== "..");
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
