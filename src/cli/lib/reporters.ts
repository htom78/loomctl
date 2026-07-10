import { brainFailureKindForSummary } from "../../brain-evidence.js";
import { type RunSignal } from "../../brain.js";
import { parseAgentGitServiceIssueRef } from "../../harness/agent-git-service.js";
import { controlPlaneProviderAdapter } from "../../harness/control-plane-registry.js";
import { type ControlPlaneProvider } from "../../harness/control-plane.js";
import { type RunSummary } from "../../harness/events.js";
import { formatRunRequesterSummary, parseGiteaIssueRef } from "../../harness/gitea.js";
import { type ControlPlaneProviderName } from "../../harness/server.js";
import { cfg } from "./context.js";
import { AGENT_GIT_SERVICE_URL_ENV, compactObject, DEFAULT_AGENT_GIT_SERVICE_TOKEN_ENV, DEFAULT_GITEA_TOKEN_ENV, type HarnessServeCliOptions } from "./flags.js";
import { join, resolve } from "node:path";

export function controlPlaneBaseUrl(options: HarnessServeCliOptions, provider: ControlPlaneProviderName): string {
  if (options.controlPlaneUrl) return options.controlPlaneUrl;
  if (provider === "agent-git-service" && options.giteaUrl === cfg.giteaUrl) {
    return process.env[AGENT_GIT_SERVICE_URL_ENV]?.trim() || options.giteaUrl;
  }
  return options.giteaUrl;
}

export function controlPlaneTokenEnv(options: HarnessServeCliOptions, provider: ControlPlaneProviderName): string {
  if (options.controlPlaneTokenEnv) return options.controlPlaneTokenEnv;
  if (provider === "agent-git-service" && options.giteaTokenEnv === DEFAULT_GITEA_TOKEN_ENV) {
    return DEFAULT_AGENT_GIT_SERVICE_TOKEN_ENV;
  }
  return options.giteaTokenEnv;
}

export interface IssueReporterOptions {
  controlPlaneProvider?: ControlPlaneProviderName;
  controlPlanePr?: boolean;
  controlPlaneMerge?: boolean;
  controlPlaneComment?: boolean;
  controlPlaneCommentSync?: boolean;
  giteaComment: boolean;
  giteaCommentSync?: boolean;
  giteaPr?: boolean;
  giteaMerge?: boolean;
  giteaUrl: string;
  giteaTokenEnv: string;
  tenantGiteaTokenEnvs?: Record<string, string>;
}

export interface PullRequestReporterResult {
  index?: number;
  url?: string;
}

export type ControlPlaneReporterFeature = "comment" | "comment-sync" | "pr" | "merge";

export function validateControlPlaneTokenEnvs(options: IssueReporterOptions, flag: string): void {
  for (const [tenant, envName] of missingTenantGiteaTokenEnvEntries(options)) {
    console.error(`${flag} requires tenant ${tenant} ${controlPlaneTokenLabel(options)} env ${envName} to be set.`);
    process.exit(2);
  }
  if (!Object.keys(options.tenantGiteaTokenEnvs ?? {}).length && missingSharedGiteaTokenEnvName(options)) {
    console.error(`${controlPlaneTokenEnvFlag(options)} ${options.giteaTokenEnv} is required when ${flag} is used.`);
    process.exit(2);
  }
}

export function controlPlaneReporterFlag(options: IssueReporterOptions, feature: ControlPlaneReporterFeature): string {
  switch (feature) {
    case "comment":
      return options.controlPlaneComment ? "--control-plane-comment" : "--gitea-comment";
    case "comment-sync":
      return options.controlPlaneCommentSync ? "--control-plane-comment-sync" : "--gitea-comment-sync";
    case "pr":
      return options.controlPlanePr ? "--control-plane-pr" : "--gitea-pr";
    case "merge":
      return options.controlPlaneMerge ? "--control-plane-merge" : "--gitea-merge";
  }
}

export function controlPlaneTokenEnvFlag(options: IssueReporterOptions): string {
  return usesProviderNeutralControlPlaneTokenWording(options) ? "--control-plane-token-env" : "--gitea-token-env";
}

export function controlPlaneTokenLabel(options: IssueReporterOptions): string {
  return usesProviderNeutralControlPlaneTokenWording(options) ? "control-plane token" : "Gitea token";
}

export function usesProviderNeutralControlPlaneTokenWording(options: IssueReporterOptions): boolean {
  return Boolean(
    options.controlPlaneProvider === "agent-git-service" ||
    options.controlPlanePr ||
    options.controlPlaneMerge ||
    options.controlPlaneComment ||
    options.controlPlaneCommentSync,
  );
}

export function missingTenantGiteaTokenEnvEntries(options: IssueReporterOptions): Array<[string, string]> {
  return Object.entries(options.tenantGiteaTokenEnvs ?? {}).filter(([, envName]) => !process.env[envName]);
}

export function missingSharedGiteaTokenEnvName(options: IssueReporterOptions): string | undefined {
  if (Object.keys(options.tenantGiteaTokenEnvs ?? {}).length > 0) return undefined;
  return process.env[options.giteaTokenEnv] ? undefined : options.giteaTokenEnv;
}

export function giteaTokenForTenant(options: IssueReporterOptions, tenant: string | undefined, flag: string): string {
  const tenantEnv = tenant ? options.tenantGiteaTokenEnvs?.[tenant] : undefined;
  const envName = tenantEnv ?? options.giteaTokenEnv;
  const token = process.env[envName];
  if (!token) {
    throw new Error(`${flag} requires ${tenantEnv ? `tenant ${tenant} ${controlPlaneTokenLabel(options)} env ${envName}` : `${controlPlaneTokenEnvFlag(options)} ${envName}`} to be set.`);
  }
  return token;
}

export function issueReporterControlPlaneProvider(options: IssueReporterOptions): ControlPlaneProvider {
  const providerName = options.controlPlaneProvider ?? "gitea-forgejo";
  const provider = controlPlaneProviderAdapter(providerName);
  if (!provider) throw new Error(`unsupported control-plane provider: ${providerName}`);
  return provider;
}

export function parseIssueRefForControlPlane(options: IssueReporterOptions, issue: string): { owner: string; repo: string; index: number } {
  return (options.controlPlaneProvider ?? "gitea-forgejo") === "agent-git-service"
    ? parseAgentGitServiceIssueRef(issue)
    : parseGiteaIssueRef(issue);
}

export function maybeIssueReporter(options: IssueReporterOptions): ((summary: RunSummary) => Promise<void>) | undefined {
  if (!options.giteaComment) return undefined;
  const flag = controlPlaneReporterFlag(options, "comment");
  validateControlPlaneTokenEnvs(options, flag);
  const provider = issueReporterControlPlaneProvider(options);
  return (summary: RunSummary) => {
    if (!summary.metadata?.issue) return Promise.resolve();
    return provider.createIssueComment({
      baseUrl: options.giteaUrl,
      token: giteaTokenForTenant(options, summary.metadata.tenant, flag),
      issue: summary.metadata.issue,
      summary,
    });
  };
}

export function maybePullRequestReporter(options: IssueReporterOptions): ((summary: RunSummary) => Promise<PullRequestReporterResult | void>) | undefined {
  if (!options.giteaPr) return undefined;
  const flag = controlPlaneReporterFlag(options, "pr");
  validateControlPlaneTokenEnvs(options, flag);
  const provider = issueReporterControlPlaneProvider(options);
  return async (summary: RunSummary) => {
    if (!summary.metadata?.issue || !summary.metadata.branch) return undefined;
    const issue = parseIssueRefForControlPlane(options, summary.metadata.issue);
    const pullRequest = await provider.createPullRequest({
      baseUrl: options.giteaUrl,
      token: giteaTokenForTenant(options, summary.metadata.tenant, flag),
      repo: `${issue.owner}/${issue.repo}`,
      head: summary.metadata.branch,
      base: prBaseBranch(summary.metadata.baseBranch),
      title: `Loom run ${summary.runId}: ${summary.goal}`,
      body: pullRequestBody(summary),
    });
    return { index: pullRequest.index, url: pullRequest.url };
  };
}

export function prBaseBranch(baseBranch?: string): string {
  return (baseBranch ?? "origin/main").replace(/^origin\//, "");
}

export function runUrl(publicUrl: string, tenant: string, project: string, runId: string): string {
  const base = publicUrl.replace(/\/+$/, "");
  return `${base}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(runId)}?project=${encodeURIComponent(project)}`;
}

export function pullRequestBody(summary: RunSummary): string {
  const requester = formatRunRequesterSummary(summary.requester);
  const lines = [
    `Created by Loom harness run ${summary.runId}.`,
    "",
    `Status: ${summary.status}`,
  ];
  if (requester) lines.push(`Requester: ${requester}`);
  if (summary.metadata?.dashboardUrl) {
    lines.push(`Dashboard: ${summary.metadata.dashboardUrl}`);
  }
  if (summary.metadata?.summaryUrl) {
    lines.push(`Summary: ${summary.metadata.summaryUrl}`);
    const reviewSummaryUrl = runSignalEvidenceUrl(summary.metadata.summaryUrl, "review-summary");
    const handoffPackageUrl = runSignalEvidenceUrl(summary.metadata.summaryUrl, "handoff-package");
    const handoffFollowupsUrl = runSignalEvidenceUrl(summary.metadata.summaryUrl, "handoff-runs");
    if (reviewSummaryUrl) lines.push(`Review summary: ${reviewSummaryUrl}`);
    if (handoffPackageUrl) lines.push(`Handoff package: ${handoffPackageUrl}`);
    if (handoffFollowupsUrl) lines.push(`Follow-up runs: ${handoffFollowupsUrl}`);
  }
  if (summary.metadata?.issueUrl) lines.push(`Issue: ${summary.metadata.issueUrl}`);
  else if (summary.metadata?.issue) lines.push(`Issue: ${summary.metadata.issue}`);
  if (summary.verification) {
    lines.push(`Verification: ${summary.verification.ok ? "passed" : "failed"} (exit ${summary.verification.exitCode})`);
    if (summary.verification.commands.length) {
      lines.push(`Verification commands: ${summary.verification.commands.map(inlineCode).join(", ")}`);
    }
  }
  if (summary.evaluation) {
    lines.push(`Evaluation: ${summary.evaluation.ok ? "passed" : "failed"} (exit ${summary.evaluation.exitCode})`);
    if (summary.evaluation.commands.length) {
      lines.push(`Evaluation commands: ${summary.evaluation.commands.map(inlineCode).join(", ")}`);
    }
  }
  if (summary.reviewer) {
    lines.push(`Reviewer: ${summary.reviewer.ok ? "passed" : "flagged"} (exit ${summary.reviewer.exitCode})`);
    if (summary.reviewer.commands.length) {
      lines.push(`Reviewer commands: ${summary.reviewer.commands.map(inlineCode).join(", ")}`);
    }
  }
  if (summary.review?.required) lines.push("Human review is required before merge.");
  if (summary.deployment?.required) lines.push("Deployment approval is required before production.");
  return `${lines.join("\n")}\n`;
}

export function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

export function runSignalFromSummary(summary: RunSummary, fallbackProject: string): RunSignal {
  return compactObject({
    ts: summary.endedAt,
    project: summary.metadata?.project ?? fallbackProject,
    runId: summary.runId,
    runDir: summary.runDir,
    status: summary.status,
    issue: summary.metadata?.issue,
    issueUrl: summary.metadata?.issueUrl,
    dashboardUrl: summary.metadata?.dashboardUrl,
    summaryUrl: summary.metadata?.summaryUrl,
    reviewSummaryUrl: summary.metadata?.summaryUrl ? runSignalEvidenceUrl(summary.metadata.summaryUrl, "review-summary") : undefined,
    handoffPackageUrl: summary.metadata?.summaryUrl ? runSignalEvidenceUrl(summary.metadata.summaryUrl, "handoff-package") : undefined,
    handoffFollowupsUrl: summary.metadata?.summaryUrl ? runSignalEvidenceUrl(summary.metadata.summaryUrl, "handoff-runs") : undefined,
    modelRequestCount: summary.modelUsage?.requestCount,
    modelPromptTokens: summary.modelUsage?.promptTokens,
    modelCompletionTokens: summary.modelUsage?.completionTokens,
    modelTotalTokens: summary.modelUsage?.totalTokens,
    modelCostUsd: summary.modelUsage?.costUsd,
    skills: summary.skills,
    outcome: summary.status === "failed" || summary.status === "error" ? "fail" as const : "pass" as const,
    failureKind: brainSignalFailureKind(summary),
    notes: brainSignalNotes(summary),
  });
}

export function runSignalEvidenceUrl(summaryUrl: string, child: "review-summary" | "handoff-package" | "handoff-runs"): string | undefined {
  try {
    const url = new URL(summaryUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${child}`;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function brainSignalNotes(summary: RunSummary): string {
  const failure = failedGateNote("evaluation", summary.evaluation) ?? failedGateNote("verification", summary.verification);
  const suffix = brainSignalNoteSuffix(summary);
  if (failure) return `harness run ${summary.runId}: ${failure}; ${suffix}`;
  if (summary.error?.message) return `harness run ${summary.runId}: error ${summary.error.message}${brainSignalErrorDiagnostics(summary.error)}; ${suffix}`;
  if (summary.status === "error" || summary.status === "failed" || summary.status === "cancelled") {
    return `harness run ${summary.runId}: status ${summary.status}; ${suffix}`;
  }
  const evidence = brainSignalHandoffEvidence(summary);
  return evidence ? `harness run ${summary.runId}: ${evidence}; ${summary.runDir}` : `harness run ${summary.runId}: ${summary.runDir}`;
}

export function brainSignalFailureKind(summary: RunSummary): string | undefined {
  return brainFailureKindForSummary(summary);
}

export function failedGateNote(name: string, result: RunSummary["verification"] | RunSummary["evaluation"]): string | undefined {
  if (!result || result.ok) return undefined;
  const commands = result.commands.length ? `: ${result.commands.join("; ")}` : "";
  return `${name} failed exit ${result.exitCode}${commands}`;
}

export function brainSignalErrorDiagnostics(error: NonNullable<RunSummary["error"]>): string {
  const parts = [
    error.kind ? `errorKind ${error.kind}` : undefined,
    ...brainSignalErrorDetailParts(error.details),
  ].filter((part): part is string => Boolean(part));
  return parts.length ? `; ${parts.join("; ")}` : "";
}

export function brainSignalErrorDetailParts(details: Record<string, unknown> | undefined): string[] {
  if (!details) return [];
  return Object.entries(details).flatMap(([key, value]) => {
    const text = brainSignalDetailValue(value);
    return text ? [`${key}=${text}`] : [];
  });
}

export function brainSignalDetailValue(value: unknown): string | undefined {
  if (typeof value === "string") return boundedBrainSignalText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function boundedBrainSignalText(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export function brainSignalNoteSuffix(summary: RunSummary): string {
  return [brainSignalHandoffEvidence(summary), summary.runDir].filter(Boolean).join("; ");
}

export function brainSignalHandoffEvidence(summary: RunSummary): string | undefined {
  const metadata = summary.metadata;
  const parts = [
    reviewerNote(summary.reviewer),
    summary.review?.required ? `review ${summary.review.status}` : undefined,
    summary.deployment?.required ? `deployment ${summary.deployment.status}` : undefined,
    metadata?.pullRequestUrl ? `pullRequest ${metadata.pullRequestUrl}` : undefined,
    metadata?.pullRequestIndex !== undefined && !metadata?.pullRequestUrl ? `pullRequest #${metadata.pullRequestIndex}` : undefined,
    metadata?.branch ? `branch ${metadata.branch}` : undefined,
    metadata?.baseBranch ? `base ${metadata.baseBranch}` : undefined,
    metadata?.issueUrl ? `issue ${metadata.issueUrl}` : metadata?.issue ? `issue ${metadata.issue}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join("; ") : undefined;
}

export function reviewerNote(result: RunSummary["reviewer"]): string | undefined {
  if (!result) return undefined;
  const commands = result.commands.length ? `: ${result.commands.join("; ")}` : "";
  return `reviewer ${result.ok ? "passed" : "flagged"} exit ${result.exitCode}${commands}`;
}
