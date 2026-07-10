import { readFile } from "node:fs/promises";
import { execa } from "execa";

import type { HarnessEvent, ToolAction } from "./events.js";

export type AgentEmittedEventType = "agent_retry" | "model_usage";

export interface AgentStepInput {
  goal: string;
  events: HarnessEvent[];
  emitEvent?: (type: AgentEmittedEventType, data: Record<string, unknown>) => Promise<void>;
}

export interface AgentStep {
  message: string;
  plan?: string;
  actions?: ToolAction[];
  finish?: boolean;
}

export interface HarnessAgent {
  next(input: AgentStepInput): Promise<AgentStep>;
}

export interface ScriptedAgentOptions {
  assistantEventOffset?: number;
}

export async function createScriptedAgent(path: string): Promise<HarnessAgent> {
  const raw = await readFile(path, "utf8");
  const steps = JSON.parse(raw) as AgentStep[];
  return createScriptedAgentFromSteps(steps);
}

export function createScriptedAgentFromSteps(steps: AgentStep[], options: ScriptedAgentOptions = {}): HarnessAgent {
  let index = 0;

  return {
    async next(input: AgentStepInput): Promise<AgentStep> {
      const emitted = Math.max(0, assistantMessageCount(input.events) - (options.assistantEventOffset ?? 0));
      index = Math.max(index, Math.min(emitted, steps.length));
      const step = steps[index];
      index += 1;
      if (!step) {
        return { message: "script exhausted", finish: true };
      }
      return normalizeAgentStep(step);
    },
  };
}

export function createAgentWithSetupSteps(setupSteps: AgentStep[], agent: HarnessAgent): HarnessAgent {
  let index = 0;

  return {
    async next(input: AgentStepInput): Promise<AgentStep> {
      index = Math.max(index, Math.min(assistantMessageCount(input.events), setupSteps.length));
      const step = setupSteps[index];
      index += 1;
      if (step) return normalizeAgentStep(step);
      return agent.next(input);
    },
  };
}

function assistantMessageCount(events: HarnessEvent[]): number {
  return events.filter((event) => event.type === "assistant_message").length;
}

export function createCommandAgent(command: string, cwd: string): HarnessAgent {
  return {
    async next(input: AgentStepInput): Promise<AgentStep> {
      const child = execa("sh", ["-lc", command], {
        cwd,
        input: JSON.stringify(input),
        reject: false,
      });
      const result = await child;
      if ((result.exitCode ?? 1) !== 0) {
        throw new Error(result.stderr || `agent command failed: ${command}`);
      }
      return normalizeAgentStep(JSON.parse(result.stdout));
    },
  };
}

export function normalizeAgentStep(value: unknown): AgentStep {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error("AgentStep must be an object");
  }
  const message = optionalString(value.message, "message") ?? "";
  const plan = optionalString(value.plan, "plan");
  const actions = normalizeActions(value.actions);
  const finish = optionalBoolean(value.finish, "finish") ?? false;
  return plan === undefined
    ? { message, actions, finish }
    : { message, plan, actions, finish };
}

function normalizeActions(value: unknown): ToolAction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("AgentStep actions must be an array");
  }
  return value.map((action, index) => normalizeAction(action, index));
}

function normalizeAction(value: unknown, index: number): ToolAction {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`AgentStep actions[${index}] must be an object`);
  }
  const toolName = value.toolName;
  if (typeof toolName !== "string" || !toolName.trim()) {
    throw new Error(`AgentStep actions[${index}].toolName must be a non-empty string`);
  }
  const input = value.input;
  if (!isRecord(input) || Array.isArray(input)) {
    throw new Error(`AgentStep actions[${index}].input must be an object`);
  }
  const id = optionalString(value.id, `actions[${index}].id`);
  return id === undefined ? { toolName, input } : { id, toolName, input };
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`AgentStep ${field} must be a string`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`AgentStep ${field} must be a boolean`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
