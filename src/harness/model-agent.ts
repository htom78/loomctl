import { normalizeAgentStep, type AgentStep, type AgentStepInput, type HarnessAgent } from "./agents.js";
import { SUPPORTED_ACTION_TOOLS } from "./tools.js";

export type ModelAgentProtocol = "json" | "tool-call";

export interface OpenAiCompatibleAgentOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  protocol?: ModelAgentProtocol;
  timeoutMs?: number;
  maxProtocolRepairAttempts?: number;
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  response_cost?: number | string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number | string;
  };
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ChatToolCall[];
    };
  }>;
}

interface ChatToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

type ModelAgentErrorKind = "model_request_failed" | "model_agent_protocol";

const MODEL_RESPONSE_EXCERPT_LIMIT = 2_000;

class ModelAgentError extends Error {
  readonly kind: ModelAgentErrorKind;
  readonly details: Record<string, unknown>;

  constructor(message: string, kind: ModelAgentErrorKind, details: Record<string, unknown>, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ModelAgentError";
    this.kind = kind;
    this.details = details;
  }
}

export function createOpenAiCompatibleAgent(options: OpenAiCompatibleAgentOptions): HarnessAgent {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxProtocolRepairAttempts = options.maxProtocolRepairAttempts ?? 1;

  return {
    async next(input: AgentStepInput): Promise<AgentStep> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let attempt = 1;
        const allowedTools = modelActionTools(input);
        let messages = initialMessages(input, options.protocol ?? "json", allowedTools);
        while (true) {
          try {
            return await requestAgentStep(baseUrl, options, messages, allowedTools, controller.signal, input.emitEvent, attempt);
          } catch (error) {
            if (!isRepairableProtocolError(error) || attempt > maxProtocolRepairAttempts) {
              throw error;
            }
            await input.emitEvent?.("agent_retry", retryEventData(error, options.model, attempt, attempt + 1));
            attempt += 1;
            messages = repairMessages(input, error, options.protocol ?? "json", allowedTools);
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

async function requestAgentStep(
  baseUrl: string,
  options: OpenAiCompatibleAgentOptions,
  messages: ChatMessage[],
  allowedTools: string[],
  signal: AbortSignal,
  emitEvent: AgentStepInput["emitEvent"],
  attempt: number,
): Promise<AgentStep> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: requestHeaders(options.apiKey),
    signal,
    body: JSON.stringify({
      model: options.model,
      temperature: 0,
      messages,
      ...protocolRequestOptions(options.protocol ?? "json", allowedTools),
    }),
  });
  const responseText = await response.text();

  if (!response.ok) {
    const responseExcerpt = boundedExcerpt(responseText);
    throw new ModelAgentError(
      `model request failed: HTTP ${response.status}${responseExcerpt ? ` ${responseExcerpt}` : ""}`,
      "model_request_failed",
      compactObject({ model: options.model, status: response.status, responseExcerpt: responseExcerpt || undefined }),
    );
  }

  let data: ChatCompletionResponse;
  try {
    data = JSON.parse(responseText) as ChatCompletionResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelAgentError(
      `model response envelope was not valid JSON: ${message}`,
      "model_agent_protocol",
      { model: options.model, responseExcerpt: boundedExcerpt(responseText) },
      error,
    );
  }
  await emitModelUsage(emitEvent, options.model, data, response.headers, attempt);

  const message = data.choices?.[0]?.message;
  const toolCallStep = parseAgentStepToolCalls(message?.tool_calls, options.model, options.protocol ?? "json", responseText);
  if (toolCallStep) return toolCallStep;

  const content = typeof message?.content === "string" ? message.content : undefined;
  if (!content) {
    throw new ModelAgentError(
      "model response did not include choices[0].message.content or agent_step tool call",
      "model_agent_protocol",
      compactObject({ model: options.model, responseExcerpt: boundedExcerpt(responseText) }),
    );
  }
  return parseAgentStep(content, options.model);
}

async function emitModelUsage(
  emitEvent: AgentStepInput["emitEvent"],
  model: string,
  data: ChatCompletionResponse,
  headers: Headers,
  attempt: number,
): Promise<void> {
  const costUsd = modelCostUsd(data, headers);
  if (!emitEvent || (!data.usage && costUsd === undefined)) return;
  await emitEvent("model_usage", compactObject({
    model,
    responseModel: boundedScalar(data.model),
    requestId: boundedScalar(data.id),
    promptTokens: finiteNumber(data.usage?.prompt_tokens),
    completionTokens: finiteNumber(data.usage?.completion_tokens),
    totalTokens: finiteNumber(data.usage?.total_tokens),
    costUsd,
    attempt,
  }));
}

function modelCostUsd(data: ChatCompletionResponse, headers: Headers): number | undefined {
  return nonNegativeFiniteNumber(headers.get("x-litellm-response-cost")) ??
    nonNegativeFiniteNumber(data.response_cost) ??
    nonNegativeFiniteNumber(data.usage?.cost);
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : undefined;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) return undefined;
  return number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedScalar(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function requestHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function protocolRequestOptions(protocol: ModelAgentProtocol, allowedTools: string[]): Record<string, unknown> {
  if (protocol === "tool-call") {
    return {
      tools: [agentStepTool(allowedTools)],
      tool_choice: { type: "function", function: { name: "agent_step" } },
    };
  }
  return { response_format: { type: "json_object" } };
}

function agentStepTool(allowedTools: string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    message: { type: "string" },
    plan: { type: "string" },
    finish: { type: "boolean" },
  };
  if (allowedTools.length) {
    properties.actions = {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          toolName: {
            type: "string",
            enum: allowedTools,
          },
          input: {
            type: "object",
            additionalProperties: true,
          },
        },
        required: ["toolName", "input"],
      },
    };
  }
  return {
    type: "function",
    function: {
      name: "agent_step",
      description: "Return the next harness AgentStep.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties,
        required: ["message"],
      },
    },
  };
}

function initialMessages(input: AgentStepInput, protocol: ModelAgentProtocol, allowedTools: string[]): ChatMessage[] {
  return [
    {
      role: "system",
      content: systemPrompt(protocol, allowedTools),
    },
    {
      role: "user",
      content: JSON.stringify({
        goal: input.goal,
        events: input.events,
      }),
    },
  ];
}

function repairMessages(input: AgentStepInput, error: ModelAgentError, protocol: ModelAgentProtocol, allowedTools: string[]): ChatMessage[] {
  return [
    ...initialMessages(input, protocol, allowedTools),
    {
      role: "user",
      content: repairPrompt(error, protocol),
    },
  ];
}

function repairPrompt(error: ModelAgentError, protocol: ModelAgentProtocol): string {
  return [
    "The previous model response could not be used by the harness.",
    `Error: ${error.message}`,
    `Details: ${JSON.stringify(error.details)}`,
    protocol === "tool-call"
      ? "Call the agent_step tool with one valid AgentStep."
      : "Return exactly one valid JSON AgentStep and no prose.",
  ].join("\n");
}

function retryEventData(error: ModelAgentError, model: string, attempt: number, nextAttempt: number): Record<string, unknown> {
  return compactObject({
    reason: error.message,
    kind: error.kind,
    model,
    attempt,
    nextAttempt,
    details: error.details,
  });
}

function isRepairableProtocolError(error: unknown): error is ModelAgentError {
  return error instanceof ModelAgentError && error.kind === "model_agent_protocol";
}

function systemPrompt(protocol: ModelAgentProtocol, allowedTools: string[]): string {
  const toolNames = allowedTools.length ? allowedTools.join("|") : "no tools currently allowed";
  const lines = [
    "You are a coding harness agent.",
    "The JSON AgentStep shape is:",
    `{"message":"string","plan":"short execution plan or rationale","actions":[{"toolName":"${toolNames}","input":{}}],"finish":false}`,
    "Use plan to explain the next move in one short sentence; it will be recorded for replay and audit.",
    "Use finish=true only when the requested goal is ready for harness verification.",
  ];
  if (protocol === "tool-call") {
    lines.splice(1, 0, "Call the agent_step tool exactly once and do not add prose.");
  } else {
    lines.splice(1, 0, "Return exactly one JSON AgentStep and no prose.");
  }
  return lines.join("\n");
}

function modelActionTools(input: AgentStepInput): string[] {
  const policyTools = latestRunPolicyTools(input.events);
  if (!policyTools) return [...SUPPORTED_ACTION_TOOLS];
  const policy = new Set(policyTools);
  return SUPPORTED_ACTION_TOOLS.filter((tool) => policy.has(tool));
}

function latestRunPolicyTools(events: AgentStepInput["events"]): string[] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "run_policy") continue;
    const data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const allowedTools = (data as Record<string, unknown>).allowedTools;
    if (!Array.isArray(allowedTools)) return undefined;
    return allowedTools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0);
  }
  return undefined;
}

function parseAgentStepToolCalls(
  toolCalls: ChatToolCall[] | undefined,
  model: string,
  protocol: ModelAgentProtocol,
  responseText: string,
): AgentStep | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const agentStepCalls = toolCalls.filter((call) => call.type === "function" && call.function?.name === "agent_step");
  if (agentStepCalls.length === 0) {
    if (protocol === "tool-call") {
      throw new ModelAgentError(
        "model tool_calls did not include agent_step",
        "model_agent_protocol",
        { model, responseExcerpt: boundedExcerpt(responseText) },
      );
    }
    return undefined;
  }
  if (agentStepCalls.length > 1) {
    throw new ModelAgentError(
      "model response included multiple agent_step tool calls",
      "model_agent_protocol",
      { model, responseExcerpt: boundedExcerpt(responseText) },
    );
  }
  const args = agentStepCalls[0].function?.arguments;
  if (typeof args !== "string" || !args.trim()) {
    throw new ModelAgentError(
      "agent_step tool call did not include string arguments",
      "model_agent_protocol",
      { model, responseExcerpt: boundedExcerpt(responseText) },
    );
  }
  return parseAgentStep(args, model);
}

function parseAgentStep(content: string, model: string): AgentStep {
  const json = stripJsonFence(content.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelAgentError(
      `model response was not valid JSON: ${message}`,
      "model_agent_protocol",
      { model, responseExcerpt: boundedExcerpt(content) },
      error,
    );
  }

  try {
    return normalizeAgentStep(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelAgentError(
      `model response was not a valid AgentStep: ${message}`,
      "model_agent_protocol",
      { model, responseExcerpt: boundedExcerpt(content) },
      error,
    );
  }
}

function stripJsonFence(content: string): string {
  const match = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : content;
}

function boundedExcerpt(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= MODEL_RESPONSE_EXCERPT_LIMIT) return normalized;
  return `${normalized.slice(0, MODEL_RESPONSE_EXCERPT_LIMIT)}...`;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
