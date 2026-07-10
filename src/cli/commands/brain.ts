import { ingest, propose, type RunSignal, score } from "../../brain.js";
import { controlPlaneProviderAdapter } from "../../harness/control-plane-registry.js";
import { registerBrainBenchmarkCommand } from "../brain-benchmark.js";
import { cfg } from "../lib/context.js";
import { parsePositiveIntFlag, parsePositiveNumberFlag } from "../lib/flags.js";
import { pullRequestBody } from "../lib/reporters.js";
import { Command } from "commander";
import { join, resolve } from "node:path";

export function registerBrainCommands(program: Command): void {
const brain = program.command("brain").description("skill-evolution brain (git-backed)");
brain
  .command("ingest")
  .description("record a run signal (JSON on stdin)")
  .action(async () => {
    const raw = await readStdin();
    ingest(cfg, JSON.parse(raw) as RunSignal);
  });
brain
  .command("score")
  .description("aggregate signals → per-skill success rate")
  .action(() => console.log(JSON.stringify(score(cfg), null, 2)));
brain
  .command("propose")
  .option("--threshold <n>", "min success rate", "0.6")
  .option("--min-runs <n>", "minimum runs before proposing", "5")
  .option("--gitea-pr", "push proposal branches and open Gitea/Forgejo PRs", false)
  .option("--gitea-repo <owner/repo>", "skills repository for Gitea/Forgejo PRs")
  .option("--gitea-base <branch>", "base branch for Gitea/Forgejo PRs", "main")
  .option("--git-remote <name>", "git remote used when --gitea-pr pushes proposal branches", "origin")
  .option("--gitea-url <url>", "Gitea/Forgejo base URL", cfg.giteaUrl)
  .option("--gitea-token-env <name>", "env var containing the Gitea/Forgejo token", "LOOM_GITEA_TOKEN")
  .description("open git-backed improvement PRs for weak skills")
  .action(async (o: { threshold: string; minRuns: string; giteaPr: boolean; giteaRepo?: string; giteaBase: string; gitRemote: string; giteaUrl: string; giteaTokenEnv: string }) => {
    const threshold = parsePositiveNumberFlag(o.threshold, "--threshold");
    const minRuns = parsePositiveIntFlag(o.minRuns, "--min-runs");
    const pullRequests: Array<{ branch: string; index?: number; url?: string }> = [];
    if (o.giteaPr && !o.giteaRepo?.trim()) {
      console.error("--gitea-pr requires --gitea-repo.");
      process.exit(2);
    }
    const token = o.giteaPr ? process.env[o.giteaTokenEnv] : undefined;
    if (o.giteaPr && !token) {
      console.error(`--gitea-token-env ${o.giteaTokenEnv} is required when --gitea-pr is used.`);
      process.exit(2);
    }
    const proposalPrProvider = controlPlaneProviderAdapter("gitea-forgejo");
    if (!proposalPrProvider) throw new Error("unsupported control-plane provider: gitea-forgejo");
    const branches = await propose(cfg, {
      threshold,
      minRuns,
      pushRemote: o.giteaPr ? o.gitRemote : undefined,
      publish: o.giteaPr
        ? async (proposal) => {
            const pullRequest = await proposalPrProvider.createPullRequest({
              baseUrl: o.giteaUrl,
              token: token as string,
              repo: o.giteaRepo as string,
              head: proposal.branch,
              base: o.giteaBase,
              title: proposal.pullRequestTitle,
              body: proposal.pullRequestBody,
            });
            pullRequests.push({ branch: proposal.branch, ...pullRequest });
            return pullRequest;
          }
        : undefined,
    });
    if (!branches.length) {
      console.log("No weak skills past threshold.");
      return;
    }
    if (pullRequests.length) {
      console.log(`Opened:\n${pullRequests.map((pr) => `${pr.branch}${pr.url ? ` -> ${pr.url}` : ""}`).join("\n")}`);
      return;
    }
    console.log(`Opened:\n${branches.join("\n")}`);
  });
registerBrainBenchmarkCommand(brain);
}

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}
