import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface PlatformOperatorApprovalsCliOptions {
  dir: string;
  stagingCi?: string;
  report?: string;
}

interface PlatformOperatorApprovalsStagingCiManifest {
  schemaVersion: "platform-staging-ci/v1";
  tokenFree: true;
  commands: {
    preServe: string;
    postServe: string;
    all: string;
  };
  requiredEnv: unknown[];
  externalTargets: Record<string, unknown>;
  expectedReports: {
    preServe: unknown[];
    postServe: unknown[];
  };
  operatorApprovals: Array<{
    stageId: string;
    executionMode: string;
    gateId: string;
    evidence: string;
    report: string;
    command: string;
    requires?: string[];
  }>;
  checks: {
    preServe: unknown[];
    postServe: unknown[];
  };
}

export interface PlatformOperatorApprovalsResult {
  schemaVersion: "platform-operator-approvals/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  reportPath?: string;
  stagingCiPath: string;
  reportDir: string;
  missingReports: string[];
  failedReports: string[];
  missingGateReports: string[];
  stageMismatchReports: string[];
  missingRequirementReports: string[];
  approvals: Array<{
    stageId: string;
    gateId: string;
    evidence: string;
    report: string;
    command: string;
    requires: string[];
    reportPath: string;
    exists: boolean;
    ok?: boolean;
    approvedGateIds?: string[];
    selectedStageOk?: boolean;
    executedStageOk?: boolean;
    satisfiedRequirements?: string[];
    missingRequirements?: string[];
    status: "missing" | "failed" | "gate-missing" | "stage-mismatch" | "requirements-missing" | "approved";
  }>;
  gates: {
    stagingCiOk: boolean;
    allReportsPresent: boolean;
    allReportsOk: boolean;
    allGatesApproved: boolean;
    allStagesExecuted: boolean;
    allRequirementsSatisfied: boolean;
  };
  nextActions: string[];
}

export function createPlatformOperatorApprovals(
  options: PlatformOperatorApprovalsCliOptions,
): PlatformOperatorApprovalsResult {
  const dir = resolve(options.dir);
  const stagingCiPath = resolve(options.stagingCi ?? join(dir, "staging-ci.json"));
  const reportDir = join(dir, "reports");
  const stagingCi = readJsonFile(stagingCiPath);
  const stagingCiOk = isPlatformOperatorApprovalsStagingCiManifest(stagingCi);
  const approvalEntries = stagingCiOk ? stagingCi.operatorApprovals : [];
  const approvals = approvalEntries.map((approval) => {
    const reportName = platformOperatorApprovalReportName(approval.report);
    const reportPath = join(reportDir, reportName);
    const report = readJsonFile(reportPath);
    const exists = report !== undefined;
    const ok = isRecord(report) ? report.ok === true : undefined;
    const approvedGateIds = isRecord(report) && Array.isArray(report.approvedGateIds)
      ? stringsOnly(report.approvedGateIds)
      : undefined;
    const gateApproved = approvedGateIds?.includes(approval.gateId) === true;
    const selectedStageOk = isRecord(report) && ok === true
      ? platformCutoverRunReportSelectedStage(report, approval.stageId)
      : undefined;
    const executedStageOk = isRecord(report) && ok === true
      ? platformCutoverRunReportExecutedStage(report, approval.stageId)
      : undefined;
    const requires = Array.isArray(approval.requires) ? stringsOnly(approval.requires) : [];
    const satisfiedRequirements = isRecord(report) && Array.isArray(report.satisfiedRequirements)
      ? stringsOnly(report.satisfiedRequirements)
      : undefined;
    const missingRequirements = exists && ok === true
      ? requires.filter((requirement) => !satisfiedRequirements?.includes(requirement))
      : undefined;
    const status: PlatformOperatorApprovalsResult["approvals"][number]["status"] = !exists
      ? "missing"
      : ok !== true
      ? "failed"
      : !gateApproved
        ? "gate-missing"
        : selectedStageOk !== true || executedStageOk !== true
          ? "stage-mismatch"
          : missingRequirements && missingRequirements.length > 0
            ? "requirements-missing"
            : "approved";
    return {
      stageId: approval.stageId,
      gateId: approval.gateId,
      evidence: approval.evidence,
      report: approval.report,
      command: approval.command,
      requires,
      reportPath,
      exists,
      ...(ok === undefined ? {} : { ok }),
      ...(approvedGateIds ? { approvedGateIds } : {}),
      ...(selectedStageOk === undefined ? {} : { selectedStageOk }),
      ...(executedStageOk === undefined ? {} : { executedStageOk }),
      ...(satisfiedRequirements ? { satisfiedRequirements } : {}),
      ...(missingRequirements ? { missingRequirements } : {}),
      status,
    };
  });
  const missingReports = approvals
    .filter((approval) => !approval.exists)
    .map((approval) => platformOperatorApprovalReportName(approval.report));
  const failedReports = approvals
    .filter((approval) => approval.exists && approval.ok !== true)
    .map((approval) => platformOperatorApprovalReportName(approval.report));
  const missingGateReports = approvals
    .filter((approval) => approval.exists && approval.ok === true && approval.status === "gate-missing")
    .map((approval) => platformOperatorApprovalReportName(approval.report));
  const stageMismatchReports = approvals
    .filter((approval) => approval.exists && approval.ok === true && approval.status === "stage-mismatch")
    .map((approval) => platformOperatorApprovalReportName(approval.report));
  const missingRequirementReports = approvals
    .filter((approval) => approval.exists && approval.ok === true && approval.status === "requirements-missing")
    .map((approval) => platformOperatorApprovalReportName(approval.report));
  const gates: PlatformOperatorApprovalsResult["gates"] = {
    stagingCiOk,
    allReportsPresent: stagingCiOk && missingReports.length === 0,
    allReportsOk: stagingCiOk && missingReports.length === 0 && failedReports.length === 0,
    allGatesApproved: stagingCiOk && missingReports.length === 0 && failedReports.length === 0 && missingGateReports.length === 0,
    allStagesExecuted: stagingCiOk &&
      missingReports.length === 0 &&
      failedReports.length === 0 &&
      missingGateReports.length === 0 &&
      stageMismatchReports.length === 0,
    allRequirementsSatisfied: stagingCiOk &&
      missingReports.length === 0 &&
      failedReports.length === 0 &&
      missingGateReports.length === 0 &&
      missingRequirementReports.length === 0,
  };
  const nextActions = Array.from(new Set(
    approvals
      .filter((approval) => approval.status !== "approved")
      .map((approval) => approval.command),
  ));
  const reportPath = options.report ? resolve(options.report) : undefined;
  return {
    schemaVersion: "platform-operator-approvals/v1",
    ok: gates.stagingCiOk &&
      gates.allReportsPresent &&
      gates.allReportsOk &&
      gates.allGatesApproved &&
      gates.allStagesExecuted &&
      gates.allRequirementsSatisfied,
    tokenFree: true,
    dir,
    ...(reportPath ? { reportPath } : {}),
    stagingCiPath,
    reportDir,
    missingReports,
    failedReports,
    missingGateReports,
    stageMismatchReports,
    missingRequirementReports,
    approvals,
    gates,
    nextActions,
  };
}

function isPlatformOperatorApprovalsStagingCiManifest(value: unknown): value is PlatformOperatorApprovalsStagingCiManifest {
  if (!isRecord(value) || value.schemaVersion !== "platform-staging-ci/v1" || value.tokenFree !== true) {
    return false;
  }
  const commands = isRecord(value.commands) ? value.commands : undefined;
  const expectedReports = isRecord(value.expectedReports) ? value.expectedReports : undefined;
  const checks = isRecord(value.checks) ? value.checks : undefined;
  if (
    typeof commands?.preServe !== "string" ||
    typeof commands.postServe !== "string" ||
    typeof commands.all !== "string" ||
    !Array.isArray(value.requiredEnv) ||
    !isRecord(value.externalTargets) ||
    !Array.isArray(expectedReports?.preServe) ||
    !Array.isArray(expectedReports.postServe) ||
    !Array.isArray(checks?.preServe) ||
    !Array.isArray(checks.postServe)
  ) {
    return false;
  }
  if (!Array.isArray(value.operatorApprovals)) return false;
  return value.operatorApprovals.every((approval) =>
    isRecord(approval) &&
    typeof approval.stageId === "string" &&
    typeof approval.gateId === "string" &&
    typeof approval.evidence === "string" &&
    typeof approval.report === "string" &&
    typeof approval.command === "string" &&
    (approval.requires === undefined || (Array.isArray(approval.requires) && approval.requires.every((item) => typeof item === "string")))
  );
}

function platformOperatorApprovalReportName(report: string): string {
  const normalized = report.replace(/\\/g, "/");
  return normalized.startsWith("reports/") ? normalized.slice("reports/".length) : normalized;
}

function platformCutoverRunReportSelectedStage(report: Record<string, unknown>, stageId: string): boolean {
  const selectedStageIds = Array.isArray(report.selectedStageIds) ? stringsOnly(report.selectedStageIds) : [];
  return selectedStageIds.includes(stageId);
}

function platformCutoverRunReportExecutedStage(report: Record<string, unknown>, stageId: string): boolean {
  const executed = Array.isArray(report.executed) ? report.executed : [];
  return executed.some((item) => isRecord(item) && item.id === stageId && item.ok === true);
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function stringsOnly(values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
