import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createPlatformOperatorHandoffPacketFromStatus } from "./platform-operator-handoff-packet.js";
import {
  createPlatformOperatorStatus,
  type PlatformOperatorCockpitNextResult,
  type PlatformOperatorStatusCliOptions,
} from "./platform-operator-status.js";

export interface PlatformOperatorGithubActionsTargetInputCliOptions extends PlatformOperatorStatusCliOptions {
  repo: string;
  ref: string;
}

export interface PlatformOperatorGithubActionsTargetInputResult {
  schemaVersion: "platform-operator-github-actions-target-input-write/v1";
  ok: true;
  tokenFree: true;
  dir: string;
  reportPath?: string;
  inputPath: string;
  inputSha256: string;
  byteLength: number;
  fieldNames: string[];
  handoffPacketPath: string;
  reportPaths: {
    operatorStatus: string;
    operatorCockpitPlan: string;
    operatorCockpitNext: string;
    operatorHandoffPacket: string;
  };
  githubTarget: {
    repo: string;
    ref: string;
  };
  cockpit: PlatformOperatorCockpitNextResult;
}

export function writePlatformOperatorGithubActionsTargetInput(
  options: PlatformOperatorGithubActionsTargetInputCliOptions,
): PlatformOperatorGithubActionsTargetInputResult {
  const dir = resolve(options.dir ?? process.cwd());
  const { repo: _repo, ref: _ref, ...statusOptions } = options;
  const reportPath = options.report ? resolve(options.report) : undefined;
  const reportDir = join(dir, "reports");
  const inputPath = platformOperatorGithubActionsTargetInputPath(dir);
  const reportPaths = {
    operatorStatus: join(reportDir, "operator-status.json"),
    operatorCockpitPlan: join(reportDir, "operator-cockpit-plan.json"),
    operatorCockpitNext: join(reportDir, "operator-cockpit-next.json"),
    operatorHandoffPacket: join(reportDir, "operator-handoff-packet.json"),
  };
  const input = {
    schemaVersion: "platform-ci-target-input/v1" as const,
    repo: platformOperatorGithubActionsTargetRepo(options.repo, "repo"),
    ref: platformOperatorGithubActionsTargetRef(options.ref, "ref"),
  };
  const inputText = `${JSON.stringify(input, null, 2)}\n`;
  mkdirSync(dirname(inputPath), { recursive: true });
  writeFileSync(inputPath, inputText, "utf8");

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

  return {
    schemaVersion: "platform-operator-github-actions-target-input-write/v1",
    ok: true,
    tokenFree: true,
    dir,
    ...(reportPath ? { reportPath } : {}),
    inputPath,
    inputSha256: sha256Hex(inputText),
    byteLength: Buffer.byteLength(inputText, "utf8"),
    fieldNames: ["repo", "ref"],
    handoffPacketPath: reportPaths.operatorHandoffPacket,
    reportPaths,
    githubTarget: {
      repo: input.repo,
      ref: input.ref,
    },
    cockpit: handoffPacket.cockpit,
  };
}

function platformOperatorGithubActionsTargetInputPath(dir: string): string {
  const bundleDir = resolve(dir);
  const defaultPath = join(bundleDir, "github-actions-target.input.json");
  const preflightPath = join(bundleDir, "reports", "ci-handoff-preflight.json");
  let inputTemplatePath: string | undefined;
  if (existsSync(preflightPath)) {
    const preflight = parseJsonObject(readFileSync(preflightPath, "utf8"), "ci-handoff-preflight report");
    if (preflight.schemaVersion !== "platform-ci-handoff-preflight/v1") {
      throw new Error("ci-handoff-preflight report must use schemaVersion platform-ci-handoff-preflight/v1.");
    }
    inputTemplatePath = optionalSingleLineString(preflight.targetInputTemplatePath, "targetInputTemplatePath", 2000);
  }
  const inputPath = resolve(inputTemplatePath ?? defaultPath);
  if (!pathInside(bundleDir, inputPath)) {
    throw new Error("GitHub Actions target input path must stay inside the operator bundle directory.");
  }
  return inputPath;
}

function platformOperatorGithubActionsTargetRepo(value: unknown, field: string): string {
  const text = requiredSingleLineString(value, field, 300);
  if (!/^([^/\s]+)\/([^/\s#]+)$/.test(text)) throw new Error(`${field} must be owner/repo.`);
  if (platformOperatorGithubActionsTargetPlaceholderRepo(text)) throw new Error(`${field} must not be a placeholder repo.`);
  return text;
}

function platformOperatorGithubActionsTargetRef(value: unknown, field: string): string {
  const text = requiredSingleLineString(value, field, 300);
  if (!/^[A-Za-z0-9._/-]+$/.test(text) || text.includes("..") || text.includes("//") || text.startsWith("/") || text.endsWith("/")) {
    throw new Error(`${field} must be a branch or ref name.`);
  }
  if (["<branch>", "branch"].includes(text.toLowerCase())) throw new Error(`${field} must not be a placeholder ref.`);
  return text;
}

function platformOperatorGithubActionsTargetPlaceholderRepo(value: string): boolean {
  return [
    "<owner/repo>",
    "owner/repo",
    "org/repo",
  ].includes(value.trim().toLowerCase());
}

function optionalSingleLineString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredSingleLineString(value, field, maxLength);
}

function requiredSingleLineString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  const text = value.trim();
  if (text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw new Error(`${field} must be a single-line string at most ${maxLength} characters.`);
  }
  return text;
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
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
