import type { RunSummary } from "./harness/events.js";

export function brainFailureKindForSummary(summary: RunSummary): string | undefined {
  if (summary.evaluation && !summary.evaluation.ok) return "evaluation";
  if (summary.verification && !summary.verification.ok) return "verification";
  if (summary.status === "cancelled") return "cancelled";
  if (!summary.error && summary.status !== "failed" && summary.status !== "error") return undefined;
  const message = summary.error?.message.toLowerCase() ?? "";
  const phase = summary.error?.phase;
  if (/\breporter failed\b|issue reporter|pull request reporter|merge reporter/.test(message)) return "reporter";
  if (phase?.startsWith("agent")) return "agent";
  if (phase?.startsWith("tool")) return "tool";
  if (phase === "workspace_prepare") return "workspace-prepare";
  if (summary.status === "failed") return "failed";
  return "error";
}

export function reviewerFocusForFailureKind(kind: string): string {
  if (kind === "verification") return "先检查确定性验证命令、fixture 和失败 notes 是否覆盖真实失败。";
  if (kind === "evaluation") return "先核对 evaluator 标准、预期产物和反例边界是否写清。";
  if (kind === "reporter") return "先检查 Gitea/PR/comment reporter 配置、凭证和重试语义。";
  if (kind === "agent") return "先收紧 agent 执行前的计划、工具使用约束和失败恢复指引。";
  if (kind === "tool") return "先澄清允许工具、工具输入和 sandbox policy 假设。";
  if (kind === "workspace-prepare") return "先检查 repo sync、branch/worktree 准备和 executor 启动前置条件。";
  if (kind === "cancelled") return "先确认取消原因是人工中断、超时还是流程噪音,再决定是否改技能。";
  return "先从链接的 run 证据确认可复现缺口,再改 SKILL.md。";
}
