import { hooksInstall, projectAdd, workspaceCreate } from "../../commands.js";
import { runGoal } from "../../native.js";
import { cfg } from "../lib/context.js";
import { cliIssueRef, collect } from "../lib/flags.js";
import { Command } from "commander";

export function registerWorkspaceProjectGoalCommands(program: Command): void {
const ws = program.command("workspace").description("per-dev persistent workspace");
ws.command("create <name>").description("create a workspace container + persistent volume").action(
  (n: string) => workspaceCreate(cfg, n),
);
const pj = program.command("project").description("projects inside a workspace");
pj.command("add <repo>").description("clone a Gitea repo into the workspace").action(
  (r: string) => projectAdd(cfg, r),
);
program
  .command("goal <condition>")
  .description("run a NATIVE /goal in a project worktree (the loop is delegated, not reimplemented)")
  .requiredOption("-p, --project <name>")
  .option("-w, --worktree <id>", "task worktree id", "main")
  .option("-t, --tier <tier>", "model tier: default|reasoning|cheap", "default")
  .option("--issue <owner/repo#number>", "Gitea/Forgejo issue to link in native goal context")
  .option("--skill <name>", "skill active in this native goal run; repeatable", collect, [] as string[])
  .action(async (condition: string, opts: { project: string; worktree: string; tier: string; issue?: string; skill: string[] }) => {
    const code = await runGoal(cfg, {
      condition,
      project: opts.project,
      worktree: opts.worktree,
      issue: opts.issue ? cliIssueRef(opts.issue, "--issue") : undefined,
      skills: opts.skill,
      modelTier: opts.tier as "default" | "reasoning" | "cheap",
    });
    process.exit(code);
  });
}

export function registerHooksInstallCommand(program: Command): void {
program
  .command("hooks-install")
  .description("install the Claude Code Stop hook → brain")
  .action(() => hooksInstall());
}


