import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { execa } from "execa";

test("brain benchmark CLI writes promotion evidence and gates its exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-cli-brain-benchmark-"));
  await writeJson(join(root, "baseline.json"), summary("baseline", false, 1_000, 100, 1));
  await writeJson(join(root, "candidate.json"), summary("candidate", true, 900, 90, 0.9));
  const manifestPath = join(root, "manifest.json");
  await writeJson(manifestPath, {
    schemaVersion: "loom-brain-ab-benchmark/v1",
    benchmarkId: "cli-proof",
    skill: "coding",
    baselineRevision: "base",
    candidateRevision: "candidate",
    cases: [{ id: "case-1", baselineSummary: "baseline.json", candidateSummary: "candidate.json" }],
  });

  const promotedReportPath = join(root, "promoted.json");
  const promoted = await execa("npx", [
    "tsx",
    "src/index.ts",
    "brain",
    "benchmark",
    "--input",
    manifestPath,
    "--report",
    promotedReportPath,
    "--min-cases",
    "1",
    "--max-p-value",
    "0.5",
    "--min-efficiency-pairs",
    "1",
  ], { cwd: process.cwd(), reject: false });
  assert.equal(promoted.exitCode, 0, promoted.stderr);
  const promotedReport = JSON.parse(await readFile(promotedReportPath, "utf8"));
  assert.equal(promotedReport.schemaVersion, "loom-brain-ab-report/v1");
  assert.equal(promotedReport.decision, "promote");
  assert.equal(promotedReport.ok, true);
  assert.match(promotedReport.manifest.sha256, /^sha256:/);

  const heldReportPath = join(root, "held.json");
  const held = await execa("npx", [
    "tsx",
    "src/index.ts",
    "brain",
    "benchmark",
    "--input",
    manifestPath,
    "--report",
    heldReportPath,
    "--min-cases",
    "1",
    "--max-p-value",
    "0.05",
    "--min-efficiency-pairs",
    "1",
  ], { cwd: process.cwd(), reject: false });
  assert.equal(held.exitCode, 1);
  const heldReport = JSON.parse(await readFile(heldReportPath, "utf8"));
  assert.equal(heldReport.decision, "hold");
  assert.deepEqual(heldReport.failedGates, ["significance"]);
});

test("brain benchmark CLI documents paired evidence and regression controls", async () => {
  const result = await execa("npx", ["tsx", "src/index.ts", "brain", "benchmark", "--help"], {
    cwd: process.cwd(),
    reject: false,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /--input <path>/);
  assert.match(result.stdout, /--report <path>/);
  assert.match(result.stdout, /--max-p-value <ratio>/);
  assert.match(result.stdout, /--max-cost-increase-ratio <ratio>/);
  assert.match(result.stdout, /--allow-different-models/);
});

function summary(
  runId: string,
  passed: boolean,
  durationMs: number,
  totalTokens: number,
  costUsd: number,
): Record<string, unknown> {
  const startedAt = "2026-07-10T00:00:00.000Z";
  return {
    runId,
    goal: "Implement the same benchmark task",
    status: passed ? "passed" : "failed",
    skills: ["coding"],
    metadata: { agentMode: "model", model: "test-model", modelProtocol: "tool-call" },
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(),
    eventCount: 4,
    runDir: `/runs/${runId}`,
    verification: {
      ok: passed,
      output: passed ? "ok" : "failed",
      exitCode: passed ? 0 : 1,
      commands: ["npm test"],
    },
    modelUsage: { requestCount: 1, totalTokens, costUsd },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
