import { createCommandAgent, createScriptedAgent, type HarnessAgent } from "../../harness/agents.js";
import { createOpenAiCompatibleAgent } from "../../harness/model-agent.js";

type ModelProtocol = Parameters<typeof createOpenAiCompatibleAgent>[0]["protocol"];

export interface AgentSourceOptions {
  script?: string;
  agentCommand?: string;
  model?: string;
  modelBaseUrl: string;
  modelKeyEnv: string;
  protocol: ModelProtocol;
  cwd: string;
}

// Build the run agent from CLI options, shared by `loom run`, `loom mcp`, and
// `loom tui`. Returns undefined when no source is given so each caller can report
// the "no agent" case in its own idiom (exit code, MCP error, TUI message).
export async function buildAgent(opts: AgentSourceOptions): Promise<HarnessAgent | undefined> {
  if (opts.script) return createScriptedAgent(opts.script);
  if (opts.agentCommand) return createCommandAgent(opts.agentCommand, opts.cwd);
  if (opts.model)
    return createOpenAiCompatibleAgent({ baseUrl: opts.modelBaseUrl, model: opts.model, protocol: opts.protocol, apiKey: process.env[opts.modelKeyEnv] });
  return undefined;
}
