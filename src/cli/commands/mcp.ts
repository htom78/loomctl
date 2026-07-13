import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { basename, join } from "node:path";
import { z } from "zod";

import { createCommandAgent, createScriptedAgent, type HarnessAgent } from "../../harness/agents.js";
import { makeRunId, runHarness } from "../../harness/loop.js";
import { createOpenAiCompatibleAgent } from "../../harness/model-agent.js";
import { cfg } from "../lib/context.js";
import { parseModelProtocolFlag } from "../lib/flags.js";
import { runMetadata } from "./harness-run.js";

// Expose the harness kernel as an MCP stdio server so other agents can call the
// verified run loop as a tool. Model config is set once on the server; the `run`
// tool takes a goal and runs the loop locally, auditing to .loom/runs. This is
// the single-user kernel over MCP — not the multi-tenant serve surface.
//
//   loom mcp --model gpt-5 --model-base-url https://... --model-key-env LOOM_KEY
export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("run the harness kernel as an MCP stdio server exposing a 'run' tool")
    .option("--cwd <path>", "default workspace directory for runs", process.cwd())
    .option("--model <name>", "default OpenAI-compatible model for runs")
    .option("--model-base-url <url>", "OpenAI-compatible base URL", cfg.gatewayUrl)
    .option("--model-key-env <name>", "env var containing the model API key", cfg.gatewayKeyEnv)
    .option("--model-protocol <protocol>", "model agent protocol: json|tool-call", "json")
    .action(
      async (opts: { cwd: string; model?: string; modelBaseUrl: string; modelKeyEnv: string; modelProtocol: string }) => {
        const protocol = parseModelProtocolFlag(opts.modelProtocol, "--model-protocol");
        const server = new McpServer({ name: "loom", version: "0.1.0" });

        server.registerTool(
          "run",
          {
            title: "Run harness loop",
            description:
              "Run the auditable harness loop on a goal in a local workspace. Returns the run summary; the verification gate decides success. Provide --model on the server or a `model` here, or a `script` path for a scripted agent.",
            inputSchema: {
              goal: z.string().describe("the verifiable outcome to pursue"),
              cwd: z.string().optional().describe("workspace directory (defaults to the server --cwd)"),
              verify: z.array(z.string()).optional().describe("verification commands; the run fails if any fail"),
              model: z.string().optional().describe("OpenAI-compatible model name (overrides the server default)"),
              script: z.string().optional().describe("path to scripted agent steps JSON (for testing without a model)"),
              agentCommand: z.string().optional().describe("external agent command reading JSON on stdin, returning one AgentStep JSON"),
              maxIterations: z.number().int().positive().optional().describe("maximum loop iterations (default 20)"),
              requireReview: z.boolean().optional().describe("hold a passing run at review_required for a human"),
            },
          },
          async (args) => {
            const cwd = args.cwd ?? opts.cwd;
            const model = args.model ?? opts.model;
            let agent: HarnessAgent;
            if (args.script) agent = await createScriptedAgent(args.script);
            else if (args.agentCommand) agent = createCommandAgent(args.agentCommand, cwd);
            else if (model)
              agent = createOpenAiCompatibleAgent({ baseUrl: opts.modelBaseUrl, model, protocol, apiKey: process.env[opts.modelKeyEnv] });
            else
              return {
                isError: true,
                content: [{ type: "text", text: "No agent: pass `model` (or start the server with --model), or a `script`/`agentCommand`." }],
              };

            const runId = makeRunId();
            const project = basename(cwd);
            const summary = await runHarness({
              runId,
              goal: args.goal,
              cwd,
              runRoot: join(cwd, ".loom", "runs"),
              verifyCommands: args.verify ?? [],
              agent,
              metadata: runMetadata({ tenant: "local", project, agentMode: args.script ? "script" : args.agentCommand ? "command" : "model", model: model ?? undefined }),
              reviewRequired: args.requireReview ?? false,
              maxIterations: args.maxIterations ?? 20,
              // ponytail: local executor only, same as `loom run`. Add docker/coder when host isolation is asked for.
            });

            const failed = summary.status === "failed" || summary.status === "error";
            return { isError: failed, content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
          },
        );

        await server.connect(new StdioServerTransport());
      },
    );
}
