import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execa } from "execa";

import * as brain from "../src/brain.js";
import { ingest, propose } from "../src/brain.js";
import type { LoomConfig } from "../src/config.js";

async function tempDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${name}-`));
}

async function initSkillsRepo(): Promise<string> {
  const repo = await tempDir("loom-brain-repo");
  await execa("git", ["init"], { cwd: repo });
  await execa("git", ["config", "user.email", "loom@example.test"], { cwd: repo });
  await execa("git", ["config", "user.name", "Loom Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "# skills\n", "utf8");
  await execa("git", ["add", "README.md"], { cwd: repo });
  await execa("git", ["commit", "-m", "initial"], { cwd: repo });
  await execa("git", ["branch", "-M", "main"], { cwd: repo });
  return repo;
}

async function initSharedSkillsRepos(): Promise<{ writer: string; central: string }> {
  const writer = await initSkillsRepo();
  const remote = await tempDir("loom-brain-remote");
  await execa("git", ["init", "--bare"], { cwd: remote });
  await execa("git", ["remote", "add", "origin", remote], { cwd: writer });
  await execa("git", ["push", "-u", "origin", "main"], { cwd: writer });
  const central = await tempDir("loom-brain-central");
  await execa("git", ["clone", remote, central]);
  await execa("git", ["config", "user.email", "loom@example.test"], { cwd: central });
  await execa("git", ["config", "user.name", "Loom Test"], { cwd: central });
  return { writer, central };
}

function config(skillsRepo: string): LoomConfig {
  return {
    gatewayUrl: "http://gateway.internal:4000",
    gatewayKeyEnv: "LOOM_GATEWAY_KEY",
    giteaUrl: "http://git.internal:3000",
    workspaceRoot: "/home/dev/projects",
    skillsRepo,
    engine: "claude",
    models: { default: "kimi-k2.6" },
    runtime: "runsc",
    resources: { cpus: 2, memory: "4g" },
    network: "loom-net",
    workspaceImage: "loom/workspace:latest",
    idleStopMinutes: 60,
    defaultAuthMode: "gateway",
  };
}

test("brain propose can publish weak-skill branches through a review hook", async () => {
  const skillsRepo = await initSkillsRepo();
  const cfg = config(skillsRepo);
  for (let index = 0; index < 5; index += 1) {
    ingest(cfg, {
      ts: `2026-06-26T00:0${index}:00.000Z`,
      project: "proj-a",
      runId: `run-${index}`,
      runDir: `/tmp/loom-runs/run-${index}`,
      status: "failed",
      issue: "team/app#42",
      issueUrl: `https://git.example/team/app/issues/${42 + index}`,
      dashboardUrl: `https://loom.example/?tenant=alice&project=proj-a&runId=run-${index}`,
      summaryUrl: `https://loom.example/tenants/alice/runs/run-${index}?project=proj-a`,
      reviewSummaryUrl: index === 4 ? "https://review.example/custom/review/run-4" : undefined,
      handoffPackageUrl: index === 4 ? "https://review.example/custom/handoff/run-4" : undefined,
      handoffFollowupsUrl: index === 4 ? "https://review.example/custom/followups/run-4" : undefined,
      modelRequestCount: index === 4 ? 2 : undefined,
      modelPromptTokens: index === 4 ? 31 : undefined,
      modelCompletionTokens: index === 4 ? 16 : undefined,
      modelTotalTokens: index === 4 ? 47 : undefined,
      modelCostUsd: index === 4 ? 0.0047 : undefined,
      skills: ["coding"],
      outcome: "fail",
      failureKind: index === 4 ? "evaluation" : "verification",
      notes: `failure ${index}`,
    });
  }
  const proposals: any[] = [];

  const opened = await (propose as any)(cfg, {
    threshold: 0.6,
    minRuns: 5,
    publish: async (proposal: any) => {
      proposals.push(proposal);
      return { index: 9, url: "https://git.example/team/_skills/pulls/9" };
    },
  });

  assert.deepEqual(opened, ["brain/improve-coding-2026-06-26T00-04-00-000Z"]);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].skill, "coding");
  assert.equal(proposals[0].branch, "brain/improve-coding-2026-06-26T00-04-00-000Z");
  assert.equal(proposals[0].pullRequestTitle, "Improve coding skill from Loom brain signals");
  assert.match(proposals[0].pullRequestBody, /近 5 次运行成功率 0%/);
  assert.match(proposals[0].pullRequestBody, /失败归因/);
  assert.match(proposals[0].pullRequestBody, /verification: 4/);
  assert.match(proposals[0].pullRequestBody, /evaluation: 1/);
  assert.match(proposals[0].pullRequestBody, /审查焦点/);
  assert.match(proposals[0].pullRequestBody, /verification: 先检查确定性验证命令、fixture 和失败 notes/);
  assert.match(proposals[0].pullRequestBody, /evaluation: 先核对 evaluator 标准、预期产物和反例边界/);
  assert.match(proposals[0].pullRequestBody, /失败样本/);
  assert.match(proposals[0].pullRequestBody, /run-4/);
  assert.match(proposals[0].pullRequestBody, /https:\/\/git\.example\/team\/app\/issues\/46/);
  assert.match(proposals[0].pullRequestBody, /dashboard https:\/\/loom\.example\/\?tenant=alice&project=proj-a&runId=run-4/);
  assert.match(proposals[0].pullRequestBody, /https:\/\/loom\.example\/tenants\/alice\/runs\/run-4\?project=proj-a/);
  assert.match(proposals[0].pullRequestBody, /reviewSummary https:\/\/review\.example\/custom\/review\/run-4/);
  assert.match(proposals[0].pullRequestBody, /handoffPackage https:\/\/review\.example\/custom\/handoff\/run-4/);
  assert.match(proposals[0].pullRequestBody, /followupRuns https:\/\/review\.example\/custom\/followups\/run-4/);
  assert.match(proposals[0].pullRequestBody, /modelUsage requests=2 prompt=31 completion=16 total=47 costUsd=0\.0047/);
  assert.match(proposals[0].pullRequestBody, /晋级门槛/);
  assert.match(proposals[0].pullRequestBody, /loom brain benchmark --input <manifest> --report <report>/);
  assert.match(proposals[0].pullRequestBody, /reviewSummary https:\/\/loom\.example\/tenants\/alice\/runs\/run-3\/review-summary\?project=proj-a/);
  assert.match(proposals[0].pullRequestBody, /handoffPackage https:\/\/loom\.example\/tenants\/alice\/runs\/run-3\/handoff-package\?project=proj-a/);
  assert.match(proposals[0].pullRequestBody, /followupRuns https:\/\/loom\.example\/tenants\/alice\/runs\/run-3\/handoff-runs\?project=proj-a/);
  assert.match(proposals[0].pullRequestBody, /failure 4/);
});

test("brain score records failure kinds for weak skill analysis", async () => {
  const skillsRepo = await initSkillsRepo();
  const cfg = config(skillsRepo);
  ingest(cfg, {
    ts: "2026-06-26T00:00:00.000Z",
    project: "proj-a",
    skills: ["coding"],
    outcome: "pass",
  });
  ingest(cfg, {
    ts: "2026-06-26T00:01:00.000Z",
    project: "proj-a",
    skills: ["coding"],
    outcome: "fail",
    failureKind: "verification",
  });
  ingest(cfg, {
    ts: "2026-06-26T00:02:00.000Z",
    project: "proj-a",
    skills: ["coding"],
    outcome: "fail",
    notes: "harness run run-2: evaluation failed exit 7",
  });
  ingest(cfg, {
    ts: "2026-06-26T00:03:00.000Z",
    project: "proj-a",
    skills: ["coding"],
    outcome: "fail",
    notes: "harness run run-3: error pull request reporter failed: unavailable",
  });

  const scored = brain.score(cfg);

  assert.deepEqual(scored.coding, {
    runs: 4,
    pass: 1,
    rate: 0.25,
    failureKinds: {
      verification: 1,
      evaluation: 1,
      reporter: 1,
    },
  });
});

test("brain score infers workspace prepare failures from legacy notes", async () => {
  const skillsRepo = await initSkillsRepo();
  const cfg = config(skillsRepo);
  ingest(cfg, {
    ts: "2026-06-26T00:00:00.000Z",
    project: "proj-a",
    skills: ["coding"],
    outcome: "fail",
    status: "failed",
    notes: "harness run run-1: workspace_prepare failed while syncing worktree",
  });

  const scored = brain.score(cfg);

  assert.deepEqual(scored.coding.failureKinds, {
    "workspace-prepare": 1,
  });
});

test("brain propose does not commit unrelated skills repo changes", async () => {
  const skillsRepo = await initSkillsRepo();
  const cfg = config(skillsRepo);
  await writeFile(join(skillsRepo, "README.md"), "# skills\nhuman edit\n", "utf8");
  await writeFile(join(skillsRepo, "human-notes.md"), "keep this out of brain proposals\n", "utf8");
  for (let index = 0; index < 5; index += 1) {
    ingest(cfg, {
      ts: `2026-06-26T00:0${index}:00.000Z`,
      project: "proj-a",
      skills: ["coding"],
      outcome: "fail",
    });
  }

  const opened = await (propose as any)(cfg, { threshold: 0.6, minRuns: 5 });

  assert.deepEqual(opened, ["brain/improve-coding-2026-06-26T00-04-00-000Z"]);
  const committedFiles = await execa("git", ["show", "--name-only", "--format=", opened[0]], { cwd: skillsRepo });
  assert.deepEqual(committedFiles.stdout.split("\n").filter(Boolean).sort(), [
    ".brain/signals.jsonl",
    ".brain/skill_evals.json",
    "coding/IMPROVE.md",
  ]);
  const status = await execa("git", ["status", "--short"], { cwd: skillsRepo });
  assert.match(status.stdout, / M README\.md/);
  assert.match(status.stdout, /\?\? human-notes\.md/);
});

test("brain propose skips already-opened weak-skill branches", async () => {
  const skillsRepo = await initSkillsRepo();
  const cfg = config(skillsRepo);
  for (let index = 0; index < 5; index += 1) {
    ingest(cfg, {
      ts: `2026-06-26T00:0${index}:00.000Z`,
      project: "proj-a",
      skills: ["coding"],
      outcome: "fail",
      notes: `failure ${index}`,
    });
  }
  await execa("git", ["add", ".brain/signals.jsonl"], { cwd: skillsRepo });
  await execa("git", ["commit", "-m", "brain: ingest signals"], { cwd: skillsRepo });
  const proposals: any[] = [];
  const options = {
    threshold: 0.6,
    minRuns: 5,
    publish: async (proposal: any) => {
      proposals.push(proposal);
    },
  };

  assert.deepEqual(await (propose as any)(cfg, options), ["brain/improve-coding-2026-06-26T00-04-00-000Z"]);
  assert.deepEqual(await (propose as any)(cfg, options), []);
  assert.equal(proposals.length, 1);
});

test("brain propose skips weak-skill branches that already exist on a tracked remote", async () => {
  const skillsRepo = await initSkillsRepo();
  const cfg = config(skillsRepo);
  for (let index = 0; index < 5; index += 1) {
    ingest(cfg, {
      ts: `2026-06-26T00:0${index}:00.000Z`,
      project: "proj-a",
      skills: ["coding"],
      outcome: "fail",
      notes: `failure ${index}`,
    });
  }
  await execa("git", ["add", ".brain/signals.jsonl"], { cwd: skillsRepo });
  await execa("git", ["commit", "-m", "brain: ingest signals"], { cwd: skillsRepo });
  await execa("git", ["update-ref", "refs/remotes/origin/brain/improve-coding-2026-06-26T00-04-00-000Z", "HEAD"], {
    cwd: skillsRepo,
  });
  const proposals: any[] = [];

  const opened = await (propose as any)(cfg, {
    threshold: 0.6,
    minRuns: 5,
    publish: async (proposal: any) => {
      proposals.push(proposal);
    },
  });

  assert.deepEqual(opened, []);
  assert.equal(proposals.length, 0);
  const branch = await execa("git", ["branch", "--show-current"], { cwd: skillsRepo });
  assert.equal(branch.stdout, "main");
});

test("brain propose restores the previous branch when publishing fails", async () => {
  const skillsRepo = await initSkillsRepo();
  const cfg = config(skillsRepo);
  for (let index = 0; index < 5; index += 1) {
    ingest(cfg, {
      ts: `2026-06-26T00:0${index}:00.000Z`,
      project: "proj-a",
      skills: ["coding"],
      outcome: "fail",
      notes: `failure ${index}`,
    });
  }

  await assert.rejects(
    () => (propose as any)(cfg, {
      threshold: 0.6,
      minRuns: 5,
      publish: async () => {
        throw new Error("publish failed");
      },
    }),
    /publish failed/,
  );
  const branch = await execa("git", ["branch", "--show-current"], { cwd: skillsRepo });
  assert.equal(branch.stdout, "main");
});

test("brain propose uses safe branch names and note paths for skill identifiers", async () => {
  const skillsRepo = await initSkillsRepo();
  const cfg = config(skillsRepo);
  const skill = "../build-web-apps:frontend testing";
  for (let index = 0; index < 5; index += 1) {
    ingest(cfg, {
      ts: `2026-06-26T00:0${index}:00.000Z`,
      project: "proj-a",
      skills: [skill],
      outcome: "fail",
    });
  }
  const proposals: any[] = [];

  const opened = await (propose as any)(cfg, {
    threshold: 0.6,
    minRuns: 5,
    publish: async (proposal: any) => {
      proposals.push(proposal);
    },
  });

  assert.deepEqual(opened, ["brain/improve-build-web-apps-frontend-testing-2026-06-26T00-04-00-000Z"]);
  assert.equal(proposals[0].skill, skill);
  assert.equal(proposals[0].notePath, join(skillsRepo, "build-web-apps-frontend-testing", "IMPROVE.md"));
});

test("brain git sync pulls shared skill signals before proposing", async () => {
  const { writer, central } = await initSharedSkillsRepos();
  const writerCfg = config(writer);
  const centralCfg = config(central);
  for (let index = 0; index < 5; index += 1) {
    ingest(writerCfg, {
      ts: `2026-06-26T00:0${index}:00.000Z`,
      project: "proj-a",
      skills: ["coding"],
      outcome: "fail",
    });
  }
  await execa("git", ["add", ".brain/signals.jsonl"], { cwd: writer });
  await execa("git", ["commit", "-m", "brain: ingest shared signals"], { cwd: writer });
  await execa("git", ["push", "origin", "main"], { cwd: writer });

  await (brain as any).syncSkillsRepo(centralCfg, { remote: "origin", branch: "main" });
  const opened = await (propose as any)(centralCfg, { threshold: 0.6, minRuns: 5 });

  assert.deepEqual(opened, ["brain/improve-coding-2026-06-26T00-04-00-000Z"]);
});

test("brain git sync removes generated local evals before fast-forwarding shared evals", async () => {
  const { writer, central } = await initSharedSkillsRepos();
  const writerCfg = config(writer);
  const centralCfg = config(central);
  brain.score(centralCfg);
  brain.score(writerCfg);
  await execa("git", ["add", ".brain/skill_evals.json"], { cwd: writer });
  await execa("git", ["commit", "-m", "brain: publish evals"], { cwd: writer });
  await execa("git", ["push", "origin", "main"], { cwd: writer });

  await (brain as any).syncSkillsRepo(centralCfg, { remote: "origin", branch: "main" });

  const status = await execa("git", ["status", "--short"], { cwd: central });
  assert.equal(status.stdout, "");
});
