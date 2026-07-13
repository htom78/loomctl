import { Command } from "commander";
import { basename, join } from "node:path";

import type { HarnessEvent } from "../../harness/events.js";
import { makeRunId, runHarness } from "../../harness/loop.js";
import { buildAgent } from "../lib/agent-from-options.js";
import { cfg } from "../lib/context.js";
import { formatEvent } from "../lib/event-format.js";
import { collect, parseModelProtocolFlag } from "../lib/flags.js";
import { finalizeSummary, runMetadata } from "./harness-run.js";

// Full-screen terminal monitor for a single-user run. Renders a live dashboard
// (header / scrolling events / footer) over raw ANSI — no framework, keeping the
// kernel CLI lean. Falls back to line streaming when stdout is not a TTY (pipes,
// CI), so the command is always usable.
const ALT_ON = "\x1b[?1049h\x1b[?25l";
const ALT_OFF = "\x1b[?25h\x1b[?1049l";
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

interface TuiOptions {
  cwd: string;
  runRoot?: string;
  model?: string;
  modelBaseUrl: string;
  modelKeyEnv: string;
  modelProtocol: string;
  script?: string;
  agentCommand?: string;
  verify: string[];
  skill: string[];
  maxIterations: string;
  requireReview: boolean;
}

function clip(text: string, width: number): string {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  return stripped.length > width ? `${stripped.slice(0, width - 1)}…` : stripped;
}

export function registerTuiCommand(program: Command): void {
  program
    .command("tui <goal>")
    .description("run the harness loop with a full-screen live terminal monitor (single-user)")
    .option("--cwd <path>", "workspace directory", process.cwd())
    .option("--run-root <path>", "run artifact root; defaults to <cwd>/.loom/runs")
    .option("--model <name>", "OpenAI-compatible model name")
    .option("--model-base-url <url>", "OpenAI-compatible base URL", cfg.gatewayUrl)
    .option("--model-key-env <name>", "env var containing the model API key", cfg.gatewayKeyEnv)
    .option("--model-protocol <protocol>", "model agent protocol: json|tool-call", "json")
    .option("--script <path>", "scripted agent steps JSON (for testing without a model)")
    .option("--agent-command <command>", "external agent command reading JSON on stdin")
    .option("--verify <command>", "verification command; repeatable", collect, [] as string[])
    .option("--skill <name>", "skill active in this run; repeatable", collect, [] as string[])
    .option("--max-iterations <n>", "maximum loop iterations", "20")
    .option("--require-review", "hold successful verification at review_required until a human reviews it", false)
    .action(async (goal: string, opts: TuiOptions) => {
      const protocol = parseModelProtocolFlag(opts.modelProtocol, "--model-protocol");
      const agent = await buildAgent({
        script: opts.script,
        agentCommand: opts.agentCommand,
        model: opts.model,
        modelBaseUrl: opts.modelBaseUrl,
        modelKeyEnv: opts.modelKeyEnv,
        protocol,
        cwd: opts.cwd,
      });
      if (!agent) {
        console.error("Either --model, --script, or --agent-command is required.");
        process.exit(2);
      }

      const runId = makeRunId();
      const project = basename(opts.cwd);
      const isTty = Boolean(process.stdout.isTTY);
      const events: HarnessEvent[] = [];

      const runOptions = {
        runId,
        goal,
        cwd: opts.cwd,
        runRoot: opts.runRoot ?? join(opts.cwd, ".loom", "runs"),
        verifyCommands: opts.verify,
        agent,
        skills: opts.skill,
        metadata: runMetadata({ tenant: "local", project, agentMode: opts.script ? "script" : opts.agentCommand ? "command" : "model", model: opts.model }),
        reviewRequired: opts.requireReview,
        maxIterations: Number(opts.maxIterations),
      };

      // Non-TTY: stream events to stderr and print the summary to stdout, matching
      // `loom run --watch`. Nothing to draw a full screen onto.
      if (!isTty) {
        const summary = await finalizeSummary(
          await runHarness({ ...runOptions, onEvent: (event) => process.stderr.write(`${formatEvent(event)}\n`) }),
          undefined,
          undefined,
        );
        console.log(JSON.stringify(summary, null, 2));
        process.exit(summary.status === "failed" || summary.status === "error" ? 1 : 0);
      }

      const started = Date.now();
      const restore = () => process.stdout.write(ALT_OFF);
      const render = () => {
        const cols = process.stdout.columns ?? 80;
        const rows = process.stdout.rows ?? 24;
        const iterations = events.filter((e) => e.type === "assistant_message").length;
        const lastVerify = [...events].reverse().find((e) => e.type === "verification");
        const verify = lastVerify ? (((lastVerify.data as { ok?: boolean }).ok) ? green("passed") : red("failed")) : dim("pending");
        const finish = [...events].reverse().find((e) => e.type === "finish");
        const status = finish ? String((finish.data as { status?: string }).status ?? "done") : "running";
        const elapsed = Math.round((Date.now() - started) / 1000);

        const bodyRows = rows - 4;
        const shown = events.slice(-bodyRows).map((e) => clip(formatEvent(e), cols));
        const lines = [
          clip(`LOOM  ${goal}`, cols),
          dim("─".repeat(cols)),
          ...shown,
          ...Array(Math.max(0, bodyRows - shown.length)).fill(""),
          dim("─".repeat(cols)),
          clip(`status: ${status}   iterations: ${iterations}   verify: ${verify}   ${elapsed}s   ${dim("ctrl-c to quit")}`, cols),
        ];
        process.stdout.write("\x1b[H" + lines.map((l) => `${l}\x1b[K`).join("\n") + "\x1b[J");
      };

      process.stdout.write(ALT_ON);
      const ticker = setInterval(render, 1000);
      const onSigint = () => { clearInterval(ticker); restore(); process.exit(130); };
      process.once("SIGINT", onSigint);
      render();

      try {
        const summary = await finalizeSummary(
          await runHarness({ ...runOptions, onEvent: (event) => { events.push(event); render(); } }),
          undefined,
          undefined,
        );
        clearInterval(ticker);
        render();
        restore();
        console.log(JSON.stringify(summary, null, 2));
        process.exit(summary.status === "failed" || summary.status === "error" ? 1 : 0);
      } catch (error) {
        clearInterval(ticker);
        restore();
        throw error;
      }
    });
}
