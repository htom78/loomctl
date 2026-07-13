import { createCommandAgent, createScriptedAgent } from "../../harness/agents.js";
import { makeRunId, runHarness } from "../../harness/loop.js";
import { createOpenAiCompatibleAgent } from "../../harness/model-agent.js";
import { cfg } from "../lib/context.js";
import { formatEvent } from "../lib/event-format.js";
import { collect, parseModelProtocolFlag } from "../lib/flags.js";
import { finalizeSummary, runMetadata } from "./harness-run.js";
import { Command } from "commander";
import { basename, join } from "node:path";

// Top-level single-user front door to the harness kernel (runHarness). The
// kernel is already tenant-agnostic — this command surfaces it without the
// multi-tenant serve/control-plane/coder surface. Runs locally in the current
// directory, audits to .loom/runs, and gates on the same verification loop.
//
//   loom run "make the tests pass" --model gpt-5 --verify "npm test"
//
// For multi-tenant / control-plane runs use `loom harness run` instead.
export function registerRunCommand(program: Command): void {
  program
    .command("run <goal>")
    .description("run the auditable harness loop locally in the current directory (single-user)")
    .option("--cwd <path>", "workspace directory", process.cwd())
    .option("--run-root <path>", "run artifact root; defaults to <cwd>/.loom/runs")
    .option("--model <name>", "OpenAI-compatible model name")
    .option("--model-base-url <url>", "OpenAI-compatible base URL", cfg.gatewayUrl)
    .option("--model-key-env <name>", "env var containing the model API key", cfg.gatewayKeyEnv)
    .option("--model-protocol <protocol>", "model agent protocol: json|tool-call", "json")
    .option("--script <path>", "scripted agent steps JSON (for testing without a model)")
    .option("--agent-command <command>", "external agent command reading JSON on stdin, returning one AgentStep JSON")
    .option("--verify <command>", "verification command; repeatable", collect, [] as string[])
    .option("--evaluate <command>", "independent evaluator command after verification; repeatable", collect, [] as string[])
    .option("--reviewer <command>", "non-gating reviewer command; repeatable", collect, [] as string[])
    .option("--skill <name>", "skill active in this run; repeatable", collect, [] as string[])
    .option("--max-iterations <n>", "maximum loop iterations", "20")
    .option("--require-review", "hold successful verification at review_required until a human reviews it", false)
    .option("--watch", "stream run events live to stderr as the loop runs", false)
    .action(
      async (
        goal: string,
        opts: {
          cwd: string;
          runRoot?: string;
          model?: string;
          modelBaseUrl: string;
          modelKeyEnv: string;
          modelProtocol: string;
          script?: string;
          agentCommand?: string;
          verify: string[];
          evaluate: string[];
          reviewer: string[];
          skill: string[];
          maxIterations: string;
          requireReview: boolean;
          watch: boolean;
        },
      ) => {
        if (!opts.script && !opts.agentCommand && !opts.model) {
          console.error("Either --model, --script, or --agent-command is required.");
          process.exit(2);
        }
        const modelProtocol = parseModelProtocolFlag(opts.modelProtocol, "--model-protocol");
        const runId = makeRunId();
        const project = basename(opts.cwd);
        const agentMode = opts.script ? "script" : opts.agentCommand ? "command" : "model";
        const agent = opts.script
          ? await createScriptedAgent(opts.script)
          : opts.agentCommand
            ? createCommandAgent(opts.agentCommand, opts.cwd)
            : createOpenAiCompatibleAgent({
                baseUrl: opts.modelBaseUrl,
                model: opts.model as string,
                protocol: modelProtocol,
                apiKey: process.env[opts.modelKeyEnv],
              });
        const summary = await runHarness({
          runId,
          goal,
          cwd: opts.cwd,
          runRoot: opts.runRoot ?? join(opts.cwd, ".loom", "runs"),
          verifyCommands: opts.verify,
          evaluationCommands: opts.evaluate,
          reviewerCommands: opts.reviewer,
          agent,
          skills: opts.skill,
          metadata: runMetadata({
            tenant: "local",
            project,
            agentMode,
            model: agentMode === "model" ? opts.model : undefined,
            modelProtocol: agentMode === "model" && modelProtocol !== "json" ? modelProtocol : undefined,
          }),
          reviewRequired: opts.requireReview,
          maxIterations: Number(opts.maxIterations),
          // Live monitor: stream events to stderr, keeping stdout the clean JSON summary.
          onEvent: opts.watch ? (event) => process.stderr.write(`${formatEvent(event)}\n`) : undefined,
          // ponytail: local executor only — a single-user run acts on the user's
          // own cwd. Add --executor docker when host isolation is actually asked for.
        });
        const reported = await finalizeSummary(summary, undefined, undefined);
        console.log(JSON.stringify(reported, null, 2));
        process.exit(reported.status === "failed" || reported.status === "error" ? 1 : 0);
      },
    );
}
