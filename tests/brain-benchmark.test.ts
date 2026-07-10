import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runBrainBenchmark } from "../src/brain-benchmark.js";
import type { RunSummary } from "../src/harness/events.js";

interface FixtureCase {
  baselinePassed: boolean;
  candidatePassed: boolean;
  baselineModel?: string;
  candidateModel?: string;
}

test("brain benchmark promotes a significant paired improvement without efficiency regressions", async () => {
  const fixture = await writeFixture(
    Array.from({ length: 10 }, (_, index) => ({
      baselinePassed: index < 5,
      candidatePassed: true,
    })),
  );

  const report = await runBrainBenchmark(fixture.manifestPath, {
    now: () => new Date("2026-07-10T10:00:00.000Z"),
  });

  assert.equal(report.generatedAt, "2026-07-10T10:00:00.000Z");
  assert.equal(report.decision, "promote");
  assert.equal(report.ok, true);
  assert.deepEqual(report.failedGates, []);
  assert.deepEqual(report.paired, {
    wins: 5,
    losses: 0,
    passTies: 5,
    failTies: 0,
    discordant: 5,
    oneSidedPValue: 0.03125,
  });
  assert.equal(report.variants.baseline.passRate, 0.5);
  assert.equal(report.variants.candidate.passRate, 1);
  assert.equal(report.efficiency.cost.relativeChange, -0.1);
  assert.equal(report.efficiency.tokens.relativeChange, -0.1);
  assert.equal(report.efficiency.duration.relativeChange, -0.1);
  assert.equal(report.gates.significance.ok, true);
  assert.match(report.manifest.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.ok(report.cases.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.goalSha256)));
  assert.ok(report.cases.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.baseline.sha256)));
});

test("brain benchmark holds a plausible gain until paired evidence is significant", async () => {
  const fixture = await writeFixture(
    Array.from({ length: 10 }, (_, index) => ({
      baselinePassed: index < 8,
      candidatePassed: index < 9,
    })),
  );

  const report = await runBrainBenchmark(fixture.manifestPath);

  assert.equal(report.variants.baseline.passRate, 0.8);
  assert.equal(report.variants.candidate.passRate, 0.9);
  assert.equal(report.paired.wins, 1);
  assert.equal(report.paired.losses, 0);
  assert.equal(report.paired.oneSidedPValue, 0.5);
  assert.deepEqual(report.failedGates, ["significance"]);
  assert.equal(report.decision, "hold");
  assert.equal(report.ok, false);
});

test("brain benchmark rejects a candidate that regresses paired task success", async () => {
  const fixture = await writeFixture(
    Array.from({ length: 10 }, (_, index) => ({
      baselinePassed: true,
      candidatePassed: index < 9,
    })),
  );

  const report = await runBrainBenchmark(fixture.manifestPath);

  assert.equal(report.paired.wins, 0);
  assert.equal(report.paired.losses, 1);
  assert.ok(report.failedGates.includes("passRateImprovement"));
  assert.ok(report.failedGates.includes("pairedDirection"));
  assert.equal(report.decision, "reject");
  assert.equal(report.ok, false);
});

test("brain benchmark rejects confounded model pairs unless explicitly allowed", async () => {
  const fixture = await writeFixture([{
    baselinePassed: false,
    candidatePassed: true,
    baselineModel: "baseline-model",
    candidateModel: "candidate-model",
  }]);

  await assert.rejects(
    () => runBrainBenchmark(fixture.manifestPath),
    /model identities differ/,
  );

  const report = await runBrainBenchmark(fixture.manifestPath, {
    requireSameModel: false,
    gate: {
      minCases: 1,
      maxOneSidedPValue: 0.5,
      minEfficiencyPairs: 1,
    },
  });
  assert.equal(report.decision, "promote");
});

test("brain benchmark prevents summary reuse from inflating sample size", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-brain-benchmark-reuse-"));
  const baselinePath = join(root, "baseline.json");
  const candidatePath = join(root, "candidate.json");
  await writeJson(baselinePath, summary("baseline", "same goal", false));
  await writeJson(candidatePath, summary("candidate", "same goal", true));
  const manifestPath = join(root, "manifest.json");
  await writeJson(manifestPath, {
    schemaVersion: "loom-brain-ab-benchmark/v1",
    benchmarkId: "reuse-proof",
    skill: "coding",
    baselineRevision: "base",
    candidateRevision: "candidate",
    cases: [
      { id: "case-1", baselineSummary: "baseline.json", candidateSummary: "candidate.json" },
      { id: "case-2", baselineSummary: "baseline.json", candidateSummary: "candidate.json" },
    ],
  });

  await assert.rejects(
    () => runBrainBenchmark(manifestPath),
    /summary is reused across cases/,
  );
});

test("brain benchmark rejects pairs that changed the verification gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-brain-benchmark-gate-"));
  const baseline = summary("baseline", "same goal", false);
  const candidate = summary("candidate", "same goal", true);
  candidate.verification = {
    ok: true,
    output: "ok",
    exitCode: 0,
    commands: ["npm run easier-test"],
  };
  await writeJson(join(root, "baseline.json"), baseline);
  await writeJson(join(root, "candidate.json"), candidate);
  const manifestPath = join(root, "manifest.json");
  await writeJson(manifestPath, {
    schemaVersion: "loom-brain-ab-benchmark/v1",
    benchmarkId: "gate-proof",
    skill: "coding",
    baselineRevision: "base",
    candidateRevision: "candidate",
    cases: [{ id: "case-1", baselineSummary: "baseline.json", candidateSummary: "candidate.json" }],
  });

  await assert.rejects(
    () => runBrainBenchmark(manifestPath),
    /verification gate identities differ/,
  );
});

async function writeFixture(cases: FixtureCase[]): Promise<{ manifestPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "loom-brain-benchmark-"));
  const manifestCases = [];
  for (let index = 0; index < cases.length; index += 1) {
    const fixture = cases[index];
    const baselineName = `case-${index}-baseline.json`;
    const candidateName = `case-${index}-candidate.json`;
    const goal = `Implement benchmark case ${index}`;
    await writeJson(join(root, baselineName), summary(
      `baseline-${index}`,
      goal,
      fixture.baselinePassed,
      fixture.baselineModel,
      1_000,
      100,
      1,
    ));
    await writeJson(join(root, candidateName), summary(
      `candidate-${index}`,
      goal,
      fixture.candidatePassed,
      fixture.candidateModel,
      900,
      90,
      0.9,
    ));
    manifestCases.push({
      id: `case-${index}`,
      baselineSummary: baselineName,
      candidateSummary: candidateName,
    });
  }
  const manifestPath = join(root, "manifest.json");
  await writeJson(manifestPath, {
    schemaVersion: "loom-brain-ab-benchmark/v1",
    benchmarkId: "coding-candidate",
    skill: "coding",
    baselineRevision: "skills-base",
    candidateRevision: "skills-candidate",
    cases: manifestCases,
  });
  return { manifestPath };
}

function summary(
  runId: string,
  goal: string,
  passed: boolean,
  model = "test-model",
  durationMs = 1_000,
  totalTokens = 100,
  costUsd = 1,
): RunSummary {
  const startedAt = "2026-07-10T00:00:00.000Z";
  return {
    runId,
    goal,
    status: passed ? "passed" : "failed",
    skills: ["coding"],
    metadata: { agentMode: "model", model, modelProtocol: "tool-call" },
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
    modelUsage: {
      requestCount: 1,
      totalTokens,
      costUsd,
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
