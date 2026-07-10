import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Command } from "commander";

import { runBrainBenchmark, type BrainBenchmarkGateConfig } from "../brain-benchmark.js";

interface BrainBenchmarkCliOptions {
  input: string;
  report: string;
  minCases?: string;
  minPassRateDelta?: string;
  maxPValue?: string;
  minEfficiencyPairs?: string;
  maxCostIncreaseRatio?: string;
  maxTokenIncreaseRatio?: string;
  maxDurationIncreaseRatio?: string;
  requireCost: boolean;
  requireTokens: boolean;
  requireDuration: boolean;
  allowDifferentModels: boolean;
}

export function registerBrainBenchmarkCommand(brain: Command): void {
  brain
    .command("benchmark")
    .description("evaluate paired baseline/candidate harness summaries and gate skill promotion")
    .requiredOption("--input <path>", "loom-brain-ab-benchmark/v1 manifest")
    .requiredOption("--report <path>", "write the hash-anchored benchmark report")
    .option("--min-cases <n>", "override the minimum paired case count")
    .option("--min-pass-rate-delta <ratio>", "override the required candidate pass-rate gain")
    .option("--max-p-value <ratio>", "override the exact one-sided paired-test p-value")
    .option("--min-efficiency-pairs <n>", "override paired samples required for efficiency gates")
    .option("--max-cost-increase-ratio <ratio>", "override allowed mean cost increase")
    .option("--max-token-increase-ratio <ratio>", "override allowed mean token increase")
    .option("--max-duration-increase-ratio <ratio>", "override allowed mean duration increase")
    .option("--require-cost", "fail when paired cost evidence is insufficient", false)
    .option("--require-tokens", "fail when paired token evidence is insufficient", false)
    .option("--require-duration", "fail when paired duration evidence is insufficient", false)
    .option("--allow-different-models", "permit different agent/model/protocol identities in a pair", false)
    .action(async (options: BrainBenchmarkCliOptions) => {
      try {
        const result = await runBrainBenchmark(options.input, {
          gate: gateOverrides(options),
          requireSameModel: !options.allowDifferentModels,
        });
        await mkdir(dirname(options.report), { recursive: true });
        await writeFile(options.report, `${JSON.stringify(result, null, 2)}\n`, "utf8");
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.ok ? 0 : 1;
      } catch (error) {
        console.error(boundedError(error));
        process.exitCode = 1;
      }
    });
}

function gateOverrides(options: BrainBenchmarkCliOptions): Partial<BrainBenchmarkGateConfig> {
  return compactObject({
    minCases: optionalNumber(options.minCases),
    minPassRateDelta: optionalNumber(options.minPassRateDelta),
    maxOneSidedPValue: optionalNumber(options.maxPValue),
    minEfficiencyPairs: optionalNumber(options.minEfficiencyPairs),
    maxCostIncreaseRatio: optionalNumber(options.maxCostIncreaseRatio),
    maxTokenIncreaseRatio: optionalNumber(options.maxTokenIncreaseRatio),
    maxDurationIncreaseRatio: optionalNumber(options.maxDurationIncreaseRatio),
    requireCost: options.requireCost ? true : undefined,
    requireTokens: options.requireTokens ? true : undefined,
    requireDuration: options.requireDuration ? true : undefined,
  });
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`benchmark gate override must be numeric: ${value}`);
  return parsed;
}

function boundedError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
