import { appendFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { execa } from "execa";
import { reviewerFocusForFailureKind } from "./brain-evidence.js";
import type { LoomConfig } from "./config.js";

/** One run's outcome, emitted by the Claude Code Stop hook. */
export interface RunSignal {
  ts: string;
  project: string;
  runId?: string;
  runDir?: string;
  status?: string;
  issue?: string;
  issueUrl?: string;
  dashboardUrl?: string;
  summaryUrl?: string;
  reviewSummaryUrl?: string;
  handoffPackageUrl?: string;
  handoffFollowupsUrl?: string;
  /** Skills active during the run. */
  skills: string[];
  /** From tests / reviewer sub-agent / human gate. */
  outcome: "pass" | "fail";
  /** Machine-readable failure bucket for scoring recurring failure modes. */
  failureKind?: string;
  modelRequestCount?: number;
  modelPromptTokens?: number;
  modelCompletionTokens?: number;
  modelTotalTokens?: number;
  modelCostUsd?: number;
  notes?: string;
}

export interface SkillEval {
  runs: number;
  pass: number;
  rate: number;
  failureKinds?: Record<string, number>;
}

export interface BrainProposal {
  skill: string;
  branch: string;
  runs: number;
  pass: number;
  rate: number;
  notePath: string;
  pullRequestTitle: string;
  pullRequestBody: string;
}

export interface BrainProposeOptions {
  threshold?: number;
  minRuns?: number;
  pushRemote?: string;
  publish?: (proposal: BrainProposal) => Promise<void | { index?: number; url?: string }>;
}

export interface BrainGitSyncOptions {
  remote?: string;
  branch?: string;
}

interface SkillEvalWithLatest extends SkillEval {
  latestTs: string;
  failureExamples: RunSignal[];
  failureKinds: Record<string, number>;
}

const brainDir = (c: LoomConfig) => join(c.skillsRepo, ".brain");
const signalsPath = (c: LoomConfig) => join(brainDir(c), "signals.jsonl");
const signalsRepoPath = ".brain/signals.jsonl";
const evalsPath = (c: LoomConfig) => join(brainDir(c), "skill_evals.json");
const evalsRepoPath = ".brain/skill_evals.json";

/** Append a run signal. Git-backed JSONL — the brain's memory lives in the repo, not a cloud. */
export function ingest(cfg: LoomConfig, sig: RunSignal): void {
  const p = signalsPath(cfg);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(sig) + "\n", "utf8");
}

/** Aggregate signals → per-skill success rate (the skill_evals). */
export function score(cfg: LoomConfig): Record<string, SkillEval> {
  const publicEvals = scoreData(cfg);
  mkdirSync(dirname(evalsPath(cfg)), { recursive: true });
  writeFileSync(evalsPath(cfg), JSON.stringify(publicEvals, null, 2), "utf8");
  return publicEvals;
}

export async function syncSkillsRepo(cfg: LoomConfig, options: BrainGitSyncOptions = {}): Promise<void> {
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? "main";
  await git(cfg, ["fetch", remote, "--prune"]);
  await cleanGeneratedEvals(cfg);
  await git(cfg, ["pull", "--ff-only", remote, branch]);
}

function scoreData(cfg: LoomConfig): Record<string, SkillEval> {
  const acc = skillEvals(readSignals(cfg));
  return Object.fromEntries(
    Object.entries(acc).map(([skill, evals]) => {
      const publicEval: SkillEval = { runs: evals.runs, pass: evals.pass, rate: evals.rate };
      if (Object.keys(evals.failureKinds).length) publicEval.failureKinds = evals.failureKinds;
      return [skill, publicEval];
    }),
  );
}

async function cleanGeneratedEvals(cfg: LoomConfig): Promise<void> {
  const p = evalsPath(cfg);
  if (!existsSync(p)) return;
  const status = await execa("git", ["status", "--porcelain", "--", evalsRepoPath], {
    cwd: cfg.skillsRepo,
    reject: false,
  });
  if (!status.stdout.trim()) return;
  if (readFileSync(p, "utf8") !== JSON.stringify(scoreData(cfg), null, 2)) return;
  const tracked = await execa("git", ["ls-files", "--error-unmatch", evalsRepoPath], {
    cwd: cfg.skillsRepo,
    reject: false,
  });
  if (tracked.exitCode === 0) {
    await git(cfg, ["restore", "--", evalsRepoPath]);
    return;
  }
  unlinkSync(p);
}

function readSignals(cfg: LoomConfig): RunSignal[] {
  const p = signalsPath(cfg);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RunSignal);
}

function skillEvals(signals: RunSignal[]): Record<string, SkillEvalWithLatest> {
  const acc: Record<string, SkillEvalWithLatest> = {};
  for (const signal of signals) {
    for (const skill of signal.skills) {
      const e = (acc[skill] ??= { runs: 0, pass: 0, rate: 0, latestTs: signal.ts, failureExamples: [], failureKinds: {} });
      e.runs++;
      if (signal.outcome === "pass") e.pass++;
      if (signal.outcome === "fail") {
        e.failureExamples.push(signal);
        const kind = failureKindForSignal(signal);
        e.failureKinds[kind] = (e.failureKinds[kind] ?? 0) + 1;
      }
      e.rate = e.pass / e.runs;
      if (signal.ts > e.latestTs) e.latestTs = signal.ts;
    }
  }
  return acc;
}

/**
 * For skills below `threshold` (with enough runs), open a git-backed improvement proposal.
 * The brain PROPOSES; a human + a reviewer sub-agent DISPOSE. Nothing auto-merges.
 */
export async function propose(
  cfg: LoomConfig,
  thresholdOrOptions: number | BrainProposeOptions = 0.6,
  minRunsArg = 5,
): Promise<string[]> {
  const options = typeof thresholdOrOptions === "number"
    ? { threshold: thresholdOrOptions, minRuns: minRunsArg }
    : thresholdOrOptions;
  const threshold = options.threshold ?? 0.6;
  const minRuns = options.minRuns ?? 5;
  const evals = skillEvals(readSignals(cfg));
  score(cfg);
  const weak = Object.entries(evals).filter(([, e]) => e.runs >= minRuns && e.rate < threshold);
  const opened: string[] = [];
  for (const [skill, e] of weak) {
    const skillPath = skillSlug(skill);
    const branch = `brain/improve-${skillPath}-${branchTimestamp(e.latestTs)}`;
    if (await branchExists(cfg, branch)) continue;
    const notePath = join(cfg.skillsRepo, skillPath, "IMPROVE.md");
    const body = proposalBody(skill, e, threshold);
    const proposal: BrainProposal = {
      skill,
      branch,
      runs: e.runs,
      pass: e.pass,
      rate: e.rate,
      notePath,
      pullRequestTitle: `Improve ${skill} skill from Loom brain signals`,
      pullRequestBody: body,
    };
    let checkedOut = false;
    try {
      await git(cfg, ["checkout", "-b", branch]);
      checkedOut = true;
      mkdirSync(dirname(notePath), { recursive: true });
      writeFileSync(notePath, body, "utf8");
      const proposalPaths = [signalsRepoPath, evalsRepoPath, repoPath(cfg, notePath)];
      await git(cfg, ["add", "--", ...proposalPaths]);
      await git(cfg, [
        "commit",
        "--only",
        "-m",
        `brain: propose improvement for '${skill}' (rate ${(e.rate * 100).toFixed(0)}%)`,
        "--",
        ...proposalPaths,
      ]);
      if (options.pushRemote) {
        await git(cfg, ["push", options.pushRemote, branch]);
      }
      await options.publish?.(proposal);
      opened.push(branch);
    } finally {
      if (checkedOut) await git(cfg, ["checkout", "-"]);
    }
  }
  return opened;
}

function proposalBody(skill: string, e: SkillEvalWithLatest, threshold: number): string {
  return (
      `# 改进提议: ${skill}\n\n` +
      `近 ${e.runs} 次运行成功率 ${(e.rate * 100).toFixed(0)}%（低于阈值 ${(threshold * 100).toFixed(0)}%）。\n\n` +
      failureKindsSection(e.failureKinds) +
      reviewerFocusSection(e.failureKinds) +
      failureExamplesSection(e.failureExamples) +
      `请审阅该技能的 SKILL.md，补足让它反复失败的缺口（约定 / 边界条件 / 反例）。\n\n` +
      `## 晋级门槛\n\n` +
      `合并前必须用相同目标、模型和验证命令生成成对 harness summary，运行 ` +
      `\`loom brain benchmark --input <manifest> --report <report>\`，且报告 decision 必须为 ` +
      `\`promote\`。\n\n` +
      `— 由 \`loom brain\` 自动开具；需人工 + reviewer sub-agent 审核，**不自动合并**。\n`
  );
}

function sortedFailureKindEntries(failureKinds: Record<string, number>): [string, number][] {
  return Object.entries(failureKinds).sort(([leftKind, leftCount], [rightKind, rightCount]) =>
    rightCount - leftCount || leftKind.localeCompare(rightKind)
  );
}

function failureKindsSection(failureKinds: Record<string, number>): string {
  const entries = sortedFailureKindEntries(failureKinds);
  if (!entries.length) return "";
  return `## 失败归因\n\n${entries.map(([kind, count]) => `- ${kind}: ${count}`).join("\n")}\n\n`;
}

function reviewerFocusSection(failureKinds: Record<string, number>): string {
  const entries = sortedFailureKindEntries(failureKinds);
  if (!entries.length) return "";
  return `## 审查焦点\n\n${entries.map(([kind]) => `- ${kind}: ${reviewerFocusForFailureKind(kind)}`).join("\n")}\n\n`;
}

function failureExamplesSection(signals: RunSignal[]): string {
  const examples = [...signals].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 3);
  if (!examples.length) return "";
  return `## 失败样本\n\n${examples.map(formatFailureExample).join("\n")}\n\n`;
}

function formatFailureExample(signal: RunSignal): string {
  const issue = signal.issueUrl ?? signal.issue;
  const dashboard = signal.dashboardUrl;
  const summary = signal.summaryUrl ?? signal.runDir;
  const reviewSummary = signal.reviewSummaryUrl ?? (signal.summaryUrl ? runEvidenceUrl(signal.summaryUrl, "review-summary") : undefined);
  const handoffPackage = signal.handoffPackageUrl ?? (signal.summaryUrl ? runEvidenceUrl(signal.summaryUrl, "handoff-package") : undefined);
  const followupRuns = signal.handoffFollowupsUrl ?? (signal.summaryUrl ? runEvidenceUrl(signal.summaryUrl, "handoff-runs") : undefined);
  const parts = [
    signal.ts,
    signal.runId ? `run ${oneLine(signal.runId)}` : undefined,
    signal.status ? `status ${oneLine(signal.status)}` : undefined,
    signal.outcome === "fail" ? `failureKind ${failureKindForSignal(signal)}` : undefined,
    issue ? `issue ${oneLine(issue)}` : undefined,
    dashboard ? `dashboard ${oneLine(dashboard)}` : undefined,
    summary ? `summary ${oneLine(summary)}` : undefined,
    reviewSummary ? `reviewSummary ${oneLine(reviewSummary)}` : undefined,
    handoffPackage ? `handoffPackage ${oneLine(handoffPackage)}` : undefined,
    followupRuns ? `followupRuns ${oneLine(followupRuns)}` : undefined,
    modelUsageText(signal),
    signal.notes ? `notes ${oneLine(signal.notes)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return `- ${parts.join(" · ")}`;
}

function modelUsageText(signal: RunSignal): string | undefined {
  const parts = [
    signal.modelRequestCount !== undefined ? `requests=${signal.modelRequestCount}` : undefined,
    signal.modelPromptTokens !== undefined ? `prompt=${signal.modelPromptTokens}` : undefined,
    signal.modelCompletionTokens !== undefined ? `completion=${signal.modelCompletionTokens}` : undefined,
    signal.modelTotalTokens !== undefined ? `total=${signal.modelTotalTokens}` : undefined,
    signal.modelCostUsd !== undefined ? `costUsd=${signal.modelCostUsd}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? `modelUsage ${parts.join(" ")}` : undefined;
}

function failureKindForSignal(signal: RunSignal): string {
  return normalizeFailureKind(signal.failureKind) ?? inferFailureKind(signal);
}

function normalizeFailureKind(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[^0-9a-z_.:-]+/g, "-").replace(/^-|-$/g, "");
  return normalized || undefined;
}

function inferFailureKind(signal: RunSignal): string {
  const status = signal.status?.toLowerCase();
  const notes = signal.notes?.toLowerCase() ?? "";
  if (/\bevaluation failed\b/.test(notes)) return "evaluation";
  if (/\bverification failed\b/.test(notes)) return "verification";
  if (/\breporter failed\b|issue reporter|pull request reporter|merge reporter/.test(notes)) return "reporter";
  if (/\bworkspace[_ -]?prepare\b/.test(notes)) return "workspace-prepare";
  if (/\bagent\b/.test(notes)) return "agent";
  if (/\btool\b/.test(notes)) return "tool";
  if (status === "cancelled" || /\bcancelled\b/.test(notes)) return "cancelled";
  if (status === "error") return "error";
  if (status === "failed") return "failed";
  return "unknown";
}

function runEvidenceUrl(summaryUrl: string, child: "review-summary" | "handoff-package" | "handoff-runs"): string | undefined {
  try {
    const url = new URL(summaryUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${child}`;
    return url.toString();
  } catch {
    return undefined;
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function branchTimestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-|-$/g, "");
}

function skillSlug(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "skill";
}

function repoPath(cfg: LoomConfig, path: string): string {
  return relative(cfg.skillsRepo, path);
}

async function git(cfg: LoomConfig, args: string[]): Promise<void> {
  await execa("git", args, { cwd: cfg.skillsRepo, stdio: "inherit" });
}

async function branchExists(cfg: LoomConfig, branch: string): Promise<boolean> {
  const result = await execa("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: cfg.skillsRepo,
    reject: false,
  });
  if (result.exitCode === 0) return true;
  const remotes = await execa("git", ["for-each-ref", "--format=%(refname)", "refs/remotes"], {
    cwd: cfg.skillsRepo,
    reject: false,
  });
  if (remotes.exitCode !== 0) return false;
  return remotes.stdout.split("\n").some((ref) => ref.endsWith(`/${branch}`));
}
