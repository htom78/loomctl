#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { addUser, getUser, listUsers, type UserRecord } from "./users.js";
import { ensureUp, enter, stop, ps, stopIdleTenants } from "./provisioner.js";
import { score, propose, syncSkillsRepo } from "./brain.js";
import { controlPlaneProviderAdapter } from "./harness/control-plane-registry.js";

const cfg = loadConfig();
const program = new Command();

program
  .name("loomd")
  .description(
    "Multi-tenant control plane on the VPS: auth + provisioning + lifecycle + brain host.\n" +
      "It does NOT orchestrate loops (native /goal runs inside each tenant container)\n" +
      "and does NOT coordinate the matrix (that emerges via the shared Gitea board).",
  )
  .version("0.1.0");

// --- tenants ---
const user = program.command("user").description("manage tenants");
user
  .command("add <name>")
  .option("--auth <mode>", "gateway | subscription", cfg.defaultAuthMode)
  .option("--key-env <env>", "gateway mode: env var holding this tenant's virtual key")
  .description("register a tenant (auth=subscription means they bring their OWN seat)")
  .action((name: string, o: { auth: string; keyEnv?: string }) => {
    const rec: UserRecord = {
      name,
      authMode: o.auth === "subscription" ? "subscription" : "gateway",
      gatewayKeyEnv: o.keyEnv,
    };
    addUser(rec);
    console.log(`added tenant ${name} (auth=${rec.authMode})`);
  });
user.command("ls").description("list tenants").action(() => {
  for (const u of listUsers()) console.log(`${u.name}\t${u.authMode}`);
});

// --- entry (called by the SSH ForceCommand after the gateway authenticated `name`) ---
program
  .command("enter <name>")
  .description("ensure the tenant workspace is up, then exec a shell into it")
  .action(async (name: string) => {
    const rec = getUser(name);
    if (!rec) {
      console.error(`unknown tenant: ${name}`);
      process.exit(1);
    }
    const gatewayKey =
      rec.authMode === "gateway" && rec.gatewayKeyEnv ? process.env[rec.gatewayKeyEnv] : undefined;
    await ensureUp(cfg, { user: name, authMode: rec.authMode, gatewayKey });
    const code = await enter(name);
    process.exit(code);
  });

// --- lifecycle ---
program.command("ps").description("list tenant workspaces").action(() => ps(listUsers()));
program.command("stop <name>").description("stop a tenant workspace (volume persists)").action((n: string) => stop(n));

// --- background duties ---
program
  .command("serve")
  .description("daemon loop: periodic brain score/propose + idle tenant cleanup")
  .option("--interval <min>", "minutes", "30")
  .option("--no-idle-gc", "disable idle tenant container cleanup")
  .option("--threshold <n>", "min success rate for brain proposals", "0.6")
  .option("--min-runs <n>", "minimum runs before proposing", "5")
  .option("--gitea-pr", "push proposal branches and open Gitea/Forgejo PRs", false)
  .option("--gitea-repo <owner/repo>", "skills repository for Gitea/Forgejo PRs")
  .option("--gitea-base <branch>", "base branch for Gitea/Forgejo PRs", "main")
  .option("--git-remote <name>", "git remote used when --gitea-pr pushes proposal branches", "origin")
  .option("--git-sync", "fetch/prune and fast-forward pull the skills repo before each brain tick", false)
  .option("--gitea-url <url>", "Gitea/Forgejo base URL", cfg.giteaUrl)
  .option("--gitea-token-env <name>", "env var containing the Gitea/Forgejo token", "LOOM_GITEA_TOKEN")
  .action(async (o: ServeOptions) => {
    const interval = parsePositiveNumberFlag(o.interval, "--interval");
    const threshold = parsePositiveNumberFlag(o.threshold, "--threshold");
    const minRuns = parsePositiveIntFlag(o.minRuns, "--min-runs");
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

    const ms = interval * 60_000;
    console.log(
      `loomd serve: brain every ${o.interval}m; idle GC ${
        o.idleGc ? `after ${cfg.idleStopMinutes}m` : "disabled"
      }`,
    );
    let ticking = false;
    const tick = async () => {
      if (ticking) return;
      ticking = true;
      try {
        if (o.gitSync) await syncSkillsRepo(cfg, { remote: o.gitRemote, branch: o.giteaBase });
        score(cfg);
        const pullRequests: Array<{ branch: string; index?: number; url?: string }> = [];
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
        if (pullRequests.length) {
          console.log(`brain: opened ${pullRequests.length} skill-improvement PRs`);
        } else if (branches.length) {
          console.log(`brain: opened ${branches.length} skill-improvement branches`);
        }
      } catch (e) {
        console.error("brain tick failed:", e);
      }
      if (o.idleGc) {
        try {
          await stopIdleTenants(cfg, listUsers(), { log: (message) => console.log(message) });
        } catch (e) {
          console.error("idle GC failed:", e);
        }
      }
      ticking = false;
    };
    await tick();
    setInterval(tick, ms);
  });

program.parseAsync();

interface ServeOptions {
  interval: string;
  idleGc: boolean;
  threshold: string;
  minRuns: string;
  giteaPr: boolean;
  giteaRepo?: string;
  giteaBase: string;
  gitRemote: string;
  gitSync: boolean;
  giteaUrl: string;
  giteaTokenEnv: string;
}

function parsePositiveIntFlag(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`${flag} must be a positive integer.`);
    process.exit(2);
  }
  return parsed;
}

function parsePositiveNumberFlag(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`${flag} must be a positive number.`);
    process.exit(2);
  }
  return parsed;
}
