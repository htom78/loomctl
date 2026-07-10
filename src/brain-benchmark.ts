import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { HarnessStatus, RunSummary } from "./harness/events.js";

export const BRAIN_BENCHMARK_SCHEMA_VERSION = "loom-brain-ab-benchmark/v1" as const;
export const BRAIN_BENCHMARK_REPORT_SCHEMA_VERSION = "loom-brain-ab-report/v1" as const;

export interface BrainBenchmarkGateConfig {
  minCases: number;
  minPassRateDelta: number;
  maxOneSidedPValue: number;
  minEfficiencyPairs: number;
  maxCostIncreaseRatio: number;
  maxTokenIncreaseRatio: number;
  maxDurationIncreaseRatio: number;
  requireCost: boolean;
  requireTokens: boolean;
  requireDuration: boolean;
}

export interface BrainBenchmarkManifest {
  schemaVersion: typeof BRAIN_BENCHMARK_SCHEMA_VERSION;
  benchmarkId: string;
  skill: string;
  baselineRevision: string;
  candidateRevision: string;
  gate?: Partial<BrainBenchmarkGateConfig>;
  cases: BrainBenchmarkCaseInput[];
}

export interface BrainBenchmarkCaseInput {
  id: string;
  baselineSummary: string;
  candidateSummary: string;
}

export interface BrainBenchmarkOptions {
  gate?: Partial<BrainBenchmarkGateConfig>;
  requireSameModel?: boolean;
  now?: () => Date;
}

export interface BrainBenchmarkRunEvidence {
  path: string;
  sha256: string;
  runId: string;
  status: HarnessStatus;
  passed: boolean;
  durationMs: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface BrainBenchmarkCaseResult {
  id: string;
  goalSha256: string;
  baseline: BrainBenchmarkRunEvidence;
  candidate: BrainBenchmarkRunEvidence;
  outcome: "win" | "loss" | "pass-tie" | "fail-tie";
}

export interface BrainBenchmarkVariantMetrics {
  runs: number;
  passed: number;
  passRate: number;
  meanDurationMs: number;
  meanTotalTokens?: number;
  meanCostUsd?: number;
}

export interface BrainBenchmarkMetricComparison {
  sampleSize: number;
  baselineMean?: number;
  candidateMean?: number;
  relativeChange?: number | null;
}

export interface BrainBenchmarkGateEvidence {
  ok: boolean;
  applicable: boolean;
  actual: number | null;
  threshold: number;
  sampleSize?: number;
  reason?: string;
}

export interface BrainBenchmarkReport {
  schemaVersion: typeof BRAIN_BENCHMARK_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  benchmarkId: string;
  skill: string;
  baselineRevision: string;
  candidateRevision: string;
  manifest: {
    path: string;
    sha256: string;
  };
  gateConfig: BrainBenchmarkGateConfig;
  cases: BrainBenchmarkCaseResult[];
  variants: {
    baseline: BrainBenchmarkVariantMetrics;
    candidate: BrainBenchmarkVariantMetrics;
  };
  paired: {
    wins: number;
    losses: number;
    passTies: number;
    failTies: number;
    discordant: number;
    oneSidedPValue: number;
  };
  efficiency: {
    cost: BrainBenchmarkMetricComparison;
    tokens: BrainBenchmarkMetricComparison;
    duration: BrainBenchmarkMetricComparison;
  };
  gates: {
    sampleSize: BrainBenchmarkGateEvidence;
    passRateImprovement: BrainBenchmarkGateEvidence;
    pairedDirection: BrainBenchmarkGateEvidence;
    significance: BrainBenchmarkGateEvidence;
    costRegression: BrainBenchmarkGateEvidence;
    tokenRegression: BrainBenchmarkGateEvidence;
    durationRegression: BrainBenchmarkGateEvidence;
  };
  failedGates: string[];
  decision: "promote" | "hold" | "reject";
  ok: boolean;
}

interface LoadedSummary {
  inputPath: string;
  absolutePath: string;
  sha256: string;
  summary: RunSummary;
}

const DEFAULT_GATE_CONFIG: BrainBenchmarkGateConfig = {
  minCases: 10,
  minPassRateDelta: 0.05,
  maxOneSidedPValue: 0.05,
  minEfficiencyPairs: 3,
  maxCostIncreaseRatio: 0.1,
  maxTokenIncreaseRatio: 0.1,
  maxDurationIncreaseRatio: 0.2,
  requireCost: false,
  requireTokens: false,
  requireDuration: true,
};

const SUCCESS_STATUSES = new Set<HarnessStatus>(["passed", "review_required", "deployment_required"]);
const HARNESS_STATUSES = new Set<HarnessStatus>([
  "passed",
  "failed",
  "error",
  "review_required",
  "deployment_required",
  "paused",
  "cancelled",
]);

export async function runBrainBenchmark(
  manifestPath: string,
  options: BrainBenchmarkOptions = {},
): Promise<BrainBenchmarkReport> {
  const absoluteManifestPath = resolve(manifestPath);
  const manifestBytes = await readFile(absoluteManifestPath);
  const manifest = parseBrainBenchmarkManifest(JSON.parse(manifestBytes.toString("utf8")));
  const gateConfig = parseGateConfig({
    ...DEFAULT_GATE_CONFIG,
    ...manifest.gate,
    ...options.gate,
  });
  if (manifest.baselineRevision === manifest.candidateRevision) {
    throw new Error("baselineRevision and candidateRevision must differ");
  }

  const manifestDir = dirname(absoluteManifestPath);
  const seenCaseIds = new Set<string>();
  const seenSummaryPaths = new Set<string>();
  const cases: BrainBenchmarkCaseResult[] = [];
  for (const input of manifest.cases) {
    if (seenCaseIds.has(input.id)) throw new Error(`duplicate benchmark case id: ${input.id}`);
    seenCaseIds.add(input.id);
    const baseline = await loadSummary(input.baselineSummary, manifestDir);
    const candidate = await loadSummary(input.candidateSummary, manifestDir);
    for (const evidence of [baseline, candidate]) {
      if (seenSummaryPaths.has(evidence.absolutePath)) {
        throw new Error(`benchmark summary is reused across cases: ${evidence.inputPath}`);
      }
      seenSummaryPaths.add(evidence.absolutePath);
      requireSummarySkill(evidence, manifest.skill, input.id);
    }
    if (baseline.absolutePath === candidate.absolutePath) {
      throw new Error(`benchmark case ${input.id} must use different baseline and candidate summaries`);
    }
    if (baseline.summary.goal !== candidate.summary.goal) {
      throw new Error(`benchmark case ${input.id} baseline and candidate goals differ`);
    }
    if (options.requireSameModel !== false && modelIdentity(baseline.summary) !== modelIdentity(candidate.summary)) {
      throw new Error(`benchmark case ${input.id} baseline and candidate model identities differ`);
    }
    if (gateIdentity(baseline.summary) !== gateIdentity(candidate.summary)) {
      throw new Error(`benchmark case ${input.id} baseline and candidate verification gate identities differ`);
    }
    cases.push(caseResult(input.id, baseline, candidate));
  }
  if (!cases.length) throw new Error("benchmark cases must not be empty");

  const baselineEvidence = cases.map((entry) => entry.baseline);
  const candidateEvidence = cases.map((entry) => entry.candidate);
  const baselineMetrics = variantMetrics(baselineEvidence);
  const candidateMetrics = variantMetrics(candidateEvidence);
  const wins = cases.filter((entry) => entry.outcome === "win").length;
  const losses = cases.filter((entry) => entry.outcome === "loss").length;
  const passTies = cases.filter((entry) => entry.outcome === "pass-tie").length;
  const failTies = cases.filter((entry) => entry.outcome === "fail-tie").length;
  const discordant = wins + losses;
  const oneSidedPValue = roundMetric(exactBinomialUpperTail(wins, discordant));
  const passRateDelta = roundMetric(candidateMetrics.passRate - baselineMetrics.passRate);
  const efficiency = {
    cost: compareMetric(cases, "costUsd"),
    tokens: compareMetric(cases, "totalTokens"),
    duration: compareMetric(cases, "durationMs"),
  };
  const gates = {
    sampleSize: minimumGate(cases.length, gateConfig.minCases),
    passRateImprovement: minimumGate(passRateDelta, gateConfig.minPassRateDelta),
    pairedDirection: minimumGate(wins - losses, 1),
    significance: maximumGate(oneSidedPValue, gateConfig.maxOneSidedPValue),
    costRegression: efficiencyGate(
      efficiency.cost,
      gateConfig.maxCostIncreaseRatio,
      gateConfig.requireCost,
      gateConfig.minEfficiencyPairs,
    ),
    tokenRegression: efficiencyGate(
      efficiency.tokens,
      gateConfig.maxTokenIncreaseRatio,
      gateConfig.requireTokens,
      gateConfig.minEfficiencyPairs,
    ),
    durationRegression: efficiencyGate(
      efficiency.duration,
      gateConfig.maxDurationIncreaseRatio,
      gateConfig.requireDuration,
      gateConfig.minEfficiencyPairs,
    ),
  };
  const failedGates = Object.entries(gates).filter(([, evidence]) => !evidence.ok).map(([name]) => name);
  const hardRegression = passRateDelta < 0 || wins < losses || [
    gates.costRegression,
    gates.tokenRegression,
    gates.durationRegression,
  ].some((gate) => gate.applicable && !gate.ok && gate.reason === "regression");
  const decision = failedGates.length === 0 ? "promote" : hardRegression ? "reject" : "hold";

  return {
    schemaVersion: BRAIN_BENCHMARK_REPORT_SCHEMA_VERSION,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    benchmarkId: manifest.benchmarkId,
    skill: manifest.skill,
    baselineRevision: manifest.baselineRevision,
    candidateRevision: manifest.candidateRevision,
    manifest: {
      path: manifestPath,
      sha256: sha256(manifestBytes),
    },
    gateConfig,
    cases,
    variants: {
      baseline: baselineMetrics,
      candidate: candidateMetrics,
    },
    paired: {
      wins,
      losses,
      passTies,
      failTies,
      discordant,
      oneSidedPValue,
    },
    efficiency,
    gates,
    failedGates,
    decision,
    ok: decision === "promote",
  };
}

export function parseBrainBenchmarkManifest(value: unknown): BrainBenchmarkManifest {
  if (!isRecord(value)) throw new Error("brain benchmark manifest must be an object");
  if (value.schemaVersion !== BRAIN_BENCHMARK_SCHEMA_VERSION) {
    throw new Error(`brain benchmark schemaVersion must be ${BRAIN_BENCHMARK_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.cases)) throw new Error("brain benchmark cases must be an array");
  return {
    schemaVersion: BRAIN_BENCHMARK_SCHEMA_VERSION,
    benchmarkId: safeIdentifier(value.benchmarkId, "benchmarkId"),
    skill: boundedLine(value.skill, "skill", 200),
    baselineRevision: boundedLine(value.baselineRevision, "baselineRevision", 200),
    candidateRevision: boundedLine(value.candidateRevision, "candidateRevision", 200),
    gate: value.gate === undefined ? undefined : parsePartialGateConfig(value.gate),
    cases: value.cases.map((entry, index) => parseCaseInput(entry, index)),
  };
}

function parseCaseInput(value: unknown, index: number): BrainBenchmarkCaseInput {
  if (!isRecord(value)) throw new Error(`cases[${index}] must be an object`);
  return {
    id: safeIdentifier(value.id, `cases[${index}].id`),
    baselineSummary: boundedLine(value.baselineSummary, `cases[${index}].baselineSummary`, 4096),
    candidateSummary: boundedLine(value.candidateSummary, `cases[${index}].candidateSummary`, 4096),
  };
}

async function loadSummary(inputPath: string, manifestDir: string): Promise<LoadedSummary> {
  const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(manifestDir, inputPath);
  const bytes = await readFile(absolutePath);
  return {
    inputPath,
    absolutePath,
    sha256: sha256(bytes),
    summary: parseRunSummary(JSON.parse(bytes.toString("utf8")), inputPath),
  };
}

function parseRunSummary(value: unknown, path: string): RunSummary {
  if (!isRecord(value)) throw new Error(`benchmark summary must be an object: ${path}`);
  if (typeof value.runId !== "string" || !value.runId.trim()) throw new Error(`benchmark summary runId is required: ${path}`);
  if (typeof value.goal !== "string" || !value.goal.trim()) throw new Error(`benchmark summary goal is required: ${path}`);
  if (!HARNESS_STATUSES.has(value.status as HarnessStatus)) throw new Error(`benchmark summary status is invalid: ${path}`);
  if (!Array.isArray(value.skills) || value.skills.some((skill) => typeof skill !== "string")) {
    throw new Error(`benchmark summary skills must be a string array: ${path}`);
  }
  for (const field of ["startedAt", "endedAt"] as const) {
    if (typeof value[field] !== "string" || !Number.isFinite(Date.parse(value[field] as string))) {
      throw new Error(`benchmark summary ${field} is invalid: ${path}`);
    }
  }
  if (value.verification !== null && !resultShape(value.verification)) {
    throw new Error(`benchmark summary verification is invalid: ${path}`);
  }
  if (value.evaluation !== undefined && value.evaluation !== null && !resultShape(value.evaluation)) {
    throw new Error(`benchmark summary evaluation is invalid: ${path}`);
  }
  if (value.reviewer !== undefined && value.reviewer !== null && !resultShape(value.reviewer)) {
    throw new Error(`benchmark summary reviewer is invalid: ${path}`);
  }
  return value as unknown as RunSummary;
}

function requireSummarySkill(evidence: LoadedSummary, skill: string, caseId: string): void {
  if (!evidence.summary.skills.includes(skill)) {
    throw new Error(`benchmark case ${caseId} summary ${evidence.inputPath} does not include skill ${skill}`);
  }
}

function caseResult(id: string, baseline: LoadedSummary, candidate: LoadedSummary): BrainBenchmarkCaseResult {
  const baselineEvidence = runEvidence(baseline);
  const candidateEvidence = runEvidence(candidate);
  const outcome = candidateEvidence.passed && !baselineEvidence.passed
    ? "win"
    : baselineEvidence.passed && !candidateEvidence.passed
      ? "loss"
      : baselineEvidence.passed
        ? "pass-tie"
        : "fail-tie";
  return {
    id,
    goalSha256: sha256(Buffer.from(baseline.summary.goal, "utf8")),
    baseline: baselineEvidence,
    candidate: candidateEvidence,
    outcome,
  };
}

function runEvidence(loaded: LoadedSummary): BrainBenchmarkRunEvidence {
  const startedAt = Date.parse(loaded.summary.startedAt);
  const endedAt = Date.parse(loaded.summary.endedAt);
  if (endedAt < startedAt) throw new Error(`benchmark summary endedAt precedes startedAt: ${loaded.inputPath}`);
  const totalTokens = summaryTotalTokens(loaded.summary);
  const costUsd = optionalNonNegativeNumber(loaded.summary.modelUsage?.costUsd, "modelUsage.costUsd", loaded.inputPath);
  return compactObject({
    path: loaded.inputPath,
    sha256: loaded.sha256,
    runId: loaded.summary.runId,
    status: loaded.summary.status,
    passed: summaryPassed(loaded.summary),
    durationMs: endedAt - startedAt,
    totalTokens,
    costUsd,
  }) as BrainBenchmarkRunEvidence;
}

function summaryPassed(summary: RunSummary): boolean {
  return SUCCESS_STATUSES.has(summary.status) &&
    summary.verification?.ok === true &&
    summary.evaluation?.ok !== false &&
    summary.reviewer?.ok !== false &&
    summary.review?.status !== "rejected" &&
    summary.deployment?.status !== "rejected";
}

function summaryTotalTokens(summary: RunSummary): number | undefined {
  const usage = summary.modelUsage;
  if (!usage) return undefined;
  if (usage.totalTokens !== undefined) return optionalNonNegativeNumber(usage.totalTokens, "modelUsage.totalTokens", summary.runId);
  if (usage.promptTokens === undefined && usage.completionTokens === undefined) return undefined;
  const prompt = optionalNonNegativeNumber(usage.promptTokens ?? 0, "modelUsage.promptTokens", summary.runId) ?? 0;
  const completion = optionalNonNegativeNumber(usage.completionTokens ?? 0, "modelUsage.completionTokens", summary.runId) ?? 0;
  return prompt + completion;
}

function variantMetrics(evidence: BrainBenchmarkRunEvidence[]): BrainBenchmarkVariantMetrics {
  return compactObject({
    runs: evidence.length,
    passed: evidence.filter((entry) => entry.passed).length,
    passRate: roundMetric(evidence.filter((entry) => entry.passed).length / evidence.length),
    meanDurationMs: roundMetric(mean(evidence.map((entry) => entry.durationMs))),
    meanTotalTokens: optionalMean(evidence.map((entry) => entry.totalTokens)),
    meanCostUsd: optionalMean(evidence.map((entry) => entry.costUsd)),
  }) as BrainBenchmarkVariantMetrics;
}

function compareMetric(
  cases: BrainBenchmarkCaseResult[],
  field: "costUsd" | "totalTokens" | "durationMs",
): BrainBenchmarkMetricComparison {
  const pairs = cases.flatMap((entry) => {
    const baseline = entry.baseline[field];
    const candidate = entry.candidate[field];
    return typeof baseline === "number" && typeof candidate === "number" ? [{ baseline, candidate }] : [];
  });
  if (!pairs.length) return { sampleSize: 0 };
  const baselineMean = roundMetric(mean(pairs.map((entry) => entry.baseline)));
  const candidateMean = roundMetric(mean(pairs.map((entry) => entry.candidate)));
  return {
    sampleSize: pairs.length,
    baselineMean,
    candidateMean,
    relativeChange: relativeChange(baselineMean, candidateMean),
  };
}

function efficiencyGate(
  comparison: BrainBenchmarkMetricComparison,
  threshold: number,
  required: boolean,
  minPairs: number,
): BrainBenchmarkGateEvidence {
  if (comparison.sampleSize < minPairs) {
    return {
      ok: !required,
      applicable: false,
      actual: comparison.relativeChange ?? null,
      threshold,
      sampleSize: comparison.sampleSize,
      reason: required ? "insufficient-evidence" : "not-applicable",
    };
  }
  const actual = comparison.relativeChange ?? null;
  return {
    ok: actual !== null && actual <= threshold,
    applicable: true,
    actual,
    threshold,
    sampleSize: comparison.sampleSize,
    reason: actual === null || actual > threshold ? "regression" : undefined,
  };
}

function minimumGate(actual: number, threshold: number): BrainBenchmarkGateEvidence {
  return { ok: actual >= threshold, applicable: true, actual, threshold };
}

function maximumGate(actual: number, threshold: number): BrainBenchmarkGateEvidence {
  return { ok: actual <= threshold, applicable: true, actual, threshold };
}

function exactBinomialUpperTail(successes: number, trials: number): number {
  if (trials === 0 || successes <= 0) return 1;
  if (successes > trials) return 0;
  const logFactorials = [0];
  for (let index = 1; index <= trials; index += 1) {
    logFactorials[index] = logFactorials[index - 1] + Math.log(index);
  }
  const logs: number[] = [];
  for (let success = successes; success <= trials; success += 1) {
    logs.push(
      logFactorials[trials] - logFactorials[success] - logFactorials[trials - success] - trials * Math.log(2),
    );
  }
  const maxLog = Math.max(...logs);
  return Math.min(1, Math.exp(maxLog) * logs.reduce((total, value) => total + Math.exp(value - maxLog), 0));
}

function modelIdentity(summary: RunSummary): string {
  return JSON.stringify({
    agentMode: summary.metadata?.agentMode ?? null,
    model: summary.metadata?.model ?? null,
    modelProtocol: summary.metadata?.modelProtocol ?? "json",
  });
}

function gateIdentity(summary: RunSummary): string {
  return JSON.stringify({
    verificationCommands: summary.verification?.commands ?? null,
    evaluationCommands: summary.evaluation?.commands ?? null,
    reviewerCommands: summary.reviewer?.commands ?? null,
    reviewRequired: summary.review?.required ?? false,
    deploymentRequired: summary.deployment?.required ?? false,
  });
}

function parsePartialGateConfig(value: unknown): Partial<BrainBenchmarkGateConfig> {
  if (!isRecord(value)) throw new Error("brain benchmark gate must be an object");
  return compactObject({
    minCases: optionalInteger(value.minCases, "gate.minCases", 1, 100_000),
    minPassRateDelta: optionalRatio(value.minPassRateDelta, "gate.minPassRateDelta", 0, 1),
    maxOneSidedPValue: optionalRatio(value.maxOneSidedPValue, "gate.maxOneSidedPValue", 0, 1),
    minEfficiencyPairs: optionalInteger(value.minEfficiencyPairs, "gate.minEfficiencyPairs", 1, 100_000),
    maxCostIncreaseRatio: optionalRatio(value.maxCostIncreaseRatio, "gate.maxCostIncreaseRatio", -1, 100),
    maxTokenIncreaseRatio: optionalRatio(value.maxTokenIncreaseRatio, "gate.maxTokenIncreaseRatio", -1, 100),
    maxDurationIncreaseRatio: optionalRatio(value.maxDurationIncreaseRatio, "gate.maxDurationIncreaseRatio", -1, 100),
    requireCost: optionalBoolean(value.requireCost, "gate.requireCost"),
    requireTokens: optionalBoolean(value.requireTokens, "gate.requireTokens"),
    requireDuration: optionalBoolean(value.requireDuration, "gate.requireDuration"),
  });
}

function parseGateConfig(value: BrainBenchmarkGateConfig): BrainBenchmarkGateConfig {
  return {
    minCases: requiredInteger(value.minCases, "gate.minCases", 1, 100_000),
    minPassRateDelta: requiredRatio(value.minPassRateDelta, "gate.minPassRateDelta", 0, 1),
    maxOneSidedPValue: requiredRatio(value.maxOneSidedPValue, "gate.maxOneSidedPValue", 0, 1),
    minEfficiencyPairs: requiredInteger(value.minEfficiencyPairs, "gate.minEfficiencyPairs", 1, 100_000),
    maxCostIncreaseRatio: requiredRatio(value.maxCostIncreaseRatio, "gate.maxCostIncreaseRatio", -1, 100),
    maxTokenIncreaseRatio: requiredRatio(value.maxTokenIncreaseRatio, "gate.maxTokenIncreaseRatio", -1, 100),
    maxDurationIncreaseRatio: requiredRatio(value.maxDurationIncreaseRatio, "gate.maxDurationIncreaseRatio", -1, 100),
    requireCost: requiredBoolean(value.requireCost, "gate.requireCost"),
    requireTokens: requiredBoolean(value.requireTokens, "gate.requireTokens"),
    requireDuration: requiredBoolean(value.requireDuration, "gate.requireDuration"),
  };
}

function safeIdentifier(value: unknown, field: string): string {
  const identifier = boundedLine(value, field, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier)) throw new Error(`${field} must be a safe identifier`);
  return identifier;
}

function boundedLine(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const line = value.trim();
  if (line.length > maxLength || /[\0\r\n]/.test(line)) throw new Error(`${field} must be a single-line string at most ${maxLength} characters`);
  return line;
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  return value === undefined ? undefined : requiredInteger(value, field, min, max);
}

function requiredInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalRatio(value: unknown, field: string, min: number, max: number): number | undefined {
  return value === undefined ? undefined : requiredRatio(value, field, min, max);
}

function requiredRatio(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  return value === undefined ? undefined : requiredBoolean(value, field);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function optionalNonNegativeNumber(value: unknown, field: string, source: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`benchmark summary ${field} must be a non-negative number: ${source}`);
  }
  return value;
}

function resultShape(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.ok === "boolean" &&
    Array.isArray(value.commands) &&
    value.commands.every((command) => typeof command === "string");
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function optionalMean(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? roundMetric(mean(present)) : undefined;
}

function relativeChange(baseline: number, candidate: number): number | null {
  if (baseline === 0) return candidate === 0 ? 0 : null;
  return roundMetric(candidate / baseline - 1);
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
