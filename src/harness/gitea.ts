import { brainFailureKindForSummary, reviewerFocusForFailureKind } from "../brain-evidence.js";
import {
  CONTROL_PLANE_PROVIDER_CATALOG,
  type ControlPlaneIssueComment,
  type ControlPlaneIssueRef,
  type ControlPlaneProvider,
  type ControlPlanePullRequest,
  type ControlPlaneRepoRef,
  type CreateControlPlaneIssueCommentOptions,
  type CreateControlPlanePullRequestOptions,
  type ListControlPlaneIssueCommentsOptions,
  type MergeControlPlanePullRequestOptions,
} from "./control-plane.js";
import type { RunRequesterSummary, RunSummary } from "./events.js";

export type GiteaIssueRef = ControlPlaneIssueRef;

export type GiteaRepoRef = ControlPlaneRepoRef;

export type GiteaPullRequest = ControlPlanePullRequest;

export type GiteaIssueComment = ControlPlaneIssueComment;

export interface CreateGiteaIssueCommentOptions extends CreateControlPlaneIssueCommentOptions {}

export interface ListGiteaIssueCommentsOptions extends ListControlPlaneIssueCommentsOptions {}

export interface CreateGiteaPullRequestOptions extends CreateControlPlanePullRequestOptions {}

export interface MergeGiteaPullRequestOptions extends MergeControlPlanePullRequestOptions {}

export function parseGiteaIssueRef(value: string): GiteaIssueRef {
  const match = value.trim().match(/^([^/\s#]+)\/([^/\s#]+)#([1-9]\d*)$/);
  if (!match) {
    throw new Error(`issue must be formatted as owner/repo#number: ${value}`);
  }
  return {
    owner: match[1],
    repo: match[2],
    index: Number(match[3]),
  };
}

export function parseGiteaRepoRef(value: string): GiteaRepoRef {
  const match = value.trim().match(/^([^/\s#]+)\/([^/\s#]+)$/);
  if (!match) {
    throw new Error(`repo must be formatted as owner/repo: ${value}`);
  }
  return {
    owner: match[1],
    repo: match[2],
  };
}

export function giteaIssueUrl(baseUrl: string, value: string): string {
  const issue = parseGiteaIssueRef(value);
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.index}`;
}

export function giteaGitRemoteUrl(baseUrl: string, value: string): string {
  const repo = parseGiteaRepoRef(value);
  const base = baseUrl.replace(/\/api\/v1\/?$/, "").replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}.git`;
}

export async function listGiteaIssueComments(options: ListGiteaIssueCommentsOptions): Promise<GiteaIssueComment[]> {
  const issue = parseGiteaIssueRef(options.issue);
  const url = new URL(
    `/api/v1/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.index}/comments`,
    normalizedBaseUrl(options.baseUrl),
  );
  if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
  const response = await fetch(url, {
    headers: {
      authorization: `token ${options.token}`,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Gitea issue comments failed with ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("Gitea issue comments response was not an array");
  }
  return body.map(giteaIssueCommentFromResponse);
}

export async function createGiteaIssueComment(options: CreateGiteaIssueCommentOptions): Promise<void> {
  const issue = parseGiteaIssueRef(options.issue);
  const url = new URL(
    `/api/v1/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.index}/comments`,
    normalizedBaseUrl(options.baseUrl),
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `token ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ body: formatControlPlaneRunComment(options.summary) }),
  });

  if (!response.ok) {
    throw new Error(`Gitea issue comment failed with ${response.status}: ${await response.text()}`);
  }
}

export async function createGiteaPullRequest(options: CreateGiteaPullRequestOptions): Promise<GiteaPullRequest> {
  const repo = parseGiteaRepoRef(options.repo);
  const response = await fetch(
    new URL(
      `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls`,
      normalizedBaseUrl(options.baseUrl),
    ),
    {
      method: "POST",
      headers: {
        authorization: `token ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: options.title,
        body: options.body,
        head: options.head,
        base: options.base,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gitea pull request failed with ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as { index?: unknown; number?: unknown; html_url?: unknown; url?: unknown };
  const index = typeof body.index === "number" ? body.index : typeof body.number === "number" ? body.number : undefined;
  if (index === undefined) {
    throw new Error("Gitea pull request response did not include an index");
  }
  const url = typeof body.html_url === "string" ? body.html_url : typeof body.url === "string" ? body.url : undefined;
  return { index, url };
}

export async function mergeGiteaPullRequest(options: MergeGiteaPullRequestOptions): Promise<void> {
  const repo = parseGiteaRepoRef(options.repo);
  const response = await fetch(
    new URL(
      `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${options.index}/merge`,
      normalizedBaseUrl(options.baseUrl),
    ),
    {
      method: "POST",
      headers: {
        authorization: `token ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        Do: options.method ?? "merge",
        MergeTitleField: options.title,
        MergeMessageField: options.message,
        force_merge: options.force,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gitea pull request merge failed with ${response.status}: ${await response.text()}`);
  }
}

export const giteaControlPlaneProvider: ControlPlaneProvider = {
  contract: {
    provider: "gitea-forgejo",
    boundary: CONTROL_PLANE_PROVIDER_CATALOG["gitea-forgejo"].boundary,
    apiBasePath: CONTROL_PLANE_PROVIDER_CATALOG["gitea-forgejo"].apiBasePath,
    discoveryEndpoints: CONTROL_PLANE_PROVIDER_CATALOG["gitea-forgejo"].discoveryEndpoints,
    nativeCapabilities: CONTROL_PLANE_PROVIDER_CATALOG["gitea-forgejo"].nativeCapabilities,
  },
  issueUrl: giteaIssueUrl,
  gitRemoteUrl: giteaGitRemoteUrl,
  listIssueComments: listGiteaIssueComments,
  createIssueComment: createGiteaIssueComment,
  createPullRequest: createGiteaPullRequest,
  mergePullRequest: mergeGiteaPullRequest,
};

export function formatRunRequesterSummary(requester: RunRequesterSummary | undefined): string | undefined {
  if (!requester) return undefined;
  const value = [
    requester.actor || requester.clientId || "unknown",
    requester.role,
    requester.actor && requester.clientId ? requester.clientId : undefined,
  ].filter(Boolean).join(" ");
  return value || undefined;
}

export function formatControlPlaneRunComment(summary: RunSummary): string {
  const requester = formatRunRequesterSummary(summary.requester);
  const lines = [
    `<!-- loom-run:${summary.runId} -->`,
    `### Loom harness run: ${summary.status}`,
    "",
    `- Run: \`${summary.runId}\``,
    `- Goal: ${summary.goal}`,
    requester ? `- Requester: ${requester}` : "",
    `- Skills: ${summary.skills.length ? summary.skills.map((skill) => `\`${skill}\``).join(", ") : "none"}`,
  ].filter(Boolean);

  if (summary.metadata?.branch) lines.push(`- Branch: \`${summary.metadata.branch}\``);
  if (summary.metadata?.dashboardUrl) lines.push(`- Dashboard: ${summary.metadata.dashboardUrl}`);
  if (summary.metadata?.summaryUrl) {
    lines.push(`- Summary: ${summary.metadata.summaryUrl}`);
    const reviewSummaryUrl = runEvidenceUrl(summary.metadata.summaryUrl, "review-summary");
    const handoffPackageUrl = runEvidenceUrl(summary.metadata.summaryUrl, "handoff-package");
    const handoffFollowupsUrl = runEvidenceUrl(summary.metadata.summaryUrl, "handoff-runs");
    if (reviewSummaryUrl) lines.push(`- Review summary: ${reviewSummaryUrl}`);
    if (handoffPackageUrl) lines.push(`- Handoff package: ${handoffPackageUrl}`);
    if (handoffFollowupsUrl) lines.push(`- Follow-up runs: ${handoffFollowupsUrl}`);
  } else {
    lines.push(`- Run dir: \`${summary.runDir}\``);
  }
  if (summary.metadata?.pullRequestUrl) lines.push(`- Pull request: ${summary.metadata.pullRequestUrl}`);
  else if (summary.metadata?.pullRequestIndex) lines.push(`- Pull request: #${summary.metadata.pullRequestIndex}`);
  if (summary.verification) {
    lines.push(`- Verification: ${summary.verification.ok ? "passed" : "failed"} (exit ${summary.verification.exitCode})`);
    if (summary.verification.commands.length) {
      lines.push(`- Verification commands: ${summary.verification.commands.map(inlineCode).join(", ")}`);
    }
  }
  if (summary.evaluation) {
    lines.push(`- Evaluation: ${summary.evaluation.ok ? "passed" : "failed"} (exit ${summary.evaluation.exitCode})`);
    if (summary.evaluation.commands.length) {
      lines.push(`- Evaluation commands: ${summary.evaluation.commands.map(inlineCode).join(", ")}`);
    }
  }
  if (summary.reviewer) {
    lines.push(`- Reviewer: ${summary.reviewer.ok ? "passed" : "flagged"} (exit ${summary.reviewer.exitCode})`);
    if (summary.reviewer.commands.length) {
      lines.push(`- Reviewer commands: ${summary.reviewer.commands.map(inlineCode).join(", ")}`);
    }
  }
  lines.push(...runModelUsageLines(summary));
  const failureKind = brainFailureKindForSummary(summary);
  if (failureKind) {
    lines.push(`- Brain failure: ${failureKind}`);
    lines.push(`- Reviewer focus: ${reviewerFocusForFailureKind(failureKind)}`);
  }
  lines.push(...runErrorDiagnosticLines(summary.error));
  if (summary.review?.required) lines.push(`- Review: ${summary.review.status}`);
  if (summary.deployment?.required) lines.push(`- Deployment: ${summary.deployment.status}`);
  lines.push(...runReviewControlLines(summary));
  lines.push(...deploymentControlLines(summary));
  lines.push(...vasLiteReviewControlLines(summary));

  return `${lines.join("\n")}\n`;
}

function runModelUsageLines(summary: RunSummary): string[] {
  const usage = summary.modelUsage;
  if (!usage) return [];
  const parts = [
    `${usage.requestCount} ${usage.requestCount === 1 ? "request" : "requests"}`,
    usage.promptTokens === undefined ? undefined : `prompt ${usage.promptTokens}`,
    usage.completionTokens === undefined ? undefined : `completion ${usage.completionTokens}`,
    usage.totalTokens === undefined ? undefined : `total ${usage.totalTokens}`,
    usage.costUsd === undefined ? undefined : `cost ${formatModelCostUsd(usage.costUsd)}`,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? [`- Model usage: ${parts.join(", ")}`] : [];
}

function formatModelCostUsd(value: number): string {
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${value.toFixed(2)}`;
}

function runErrorDiagnosticLines(error: RunSummary["error"] | undefined): string[] {
  if (!error) return [];
  const lines = [];
  if (error.kind) lines.push(`- Error kind: ${inlineCode(error.kind)}`);
  const details = runErrorDetailParts(error.details);
  if (details.length) lines.push(`- Error details: ${details.map(inlineCode).join(", ")}`);
  return lines;
}

function runErrorDetailParts(details: Record<string, unknown> | undefined): string[] {
  if (!details) return [];
  return Object.entries(details).flatMap(([key, value]) => {
    if (isSensitiveDiagnosticKey(key)) return [];
    const detailValue = runErrorDetailValue(value);
    const detailKey = boundedDiagnosticText(key, 40).replace(/\s+/g, "_");
    return detailKey && detailValue ? [`${detailKey}=${detailValue}`] : [];
  });
}

function runErrorDetailValue(value: unknown): string | undefined {
  if (typeof value === "string") return boundedDiagnosticText(value, 160);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function boundedDiagnosticText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function isSensitiveDiagnosticKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /(token|secret|password|authorization|cookie|apikey|accesskey|privatekey)/.test(normalized);
}

function runReviewControlLines(summary: RunSummary): string[] {
  if (!summary.review?.required || summary.review.status !== "pending") return [];
  const lines = [
    "",
    "#### Run review controls",
    "",
    "- Approve run: `/loom approve`",
    "- Request changes: `/loom request-changes`",
    "- Optional contract repair: add a fenced `loom-contract-patch` JSON block with `objective`, `constraints`, and `successCriteria`.",
    "- Claim review: `/loom claim-review`",
    "- Release claim: `/loom release-review-claim`",
  ];
  if (summary.review.claim) {
    const owner = summary.review.claim.actor || summary.review.claim.clientId || "unknown";
    lines.push(`- Current claim: ${inlineCode(summary.review.claim.claimedAt ? `${owner} ${summary.review.claim.claimedAt}` : owner)}`);
  }
  return lines;
}

function deploymentControlLines(summary: RunSummary): string[] {
  if (!summary.deployment?.required || summary.deployment.status !== "pending") return [];
  return [
    "",
    "#### Deployment controls",
    "",
    "- Approve deployment: `/loom approve-deploy`",
    "- Reject deployment: `/loom reject-deploy`",
  ];
}

function vasLiteReviewControlLines(summary: RunSummary): string[] {
  if (summary.metadata?.runPreset !== "vas-lite-review") return [];
  const input = summary.metadata.runPresetInput;
  const caseId = typeof input?.caseId === "string" && input.caseId.trim() ? input.caseId.trim() : "bootstrap";
  return [
    "",
    "#### VAS Lite review controls",
    "",
    `- Case: ${inlineCode(caseId)}`,
    "- Approve draft: `/loom approve-vas`",
    "- Request changes: `/loom request-vas-changes`",
    `- Claim case: ${inlineCode(`/loom claim-vas ${caseId}`)}`,
    `- Release claim: ${inlineCode(`/loom release-vas-claim ${caseId}`)}`,
    `- Start another review run: ${inlineCode(`/loom run-vas-review ${caseId}`)}`,
  ];
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function runEvidenceUrl(summaryUrl: string, child: "review-summary" | "handoff-package" | "handoff-runs"): string | undefined {
  try {
    const url = new URL(summaryUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${child}`;
    return url.toString();
  } catch {
    return undefined;
  }
}

function giteaIssueCommentFromResponse(value: unknown): GiteaIssueComment {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const user = typeof record.user === "object" && record.user !== null && !Array.isArray(record.user) ? record.user as Record<string, unknown> : {};
  return {
    id: String(record.id ?? ""),
    body: typeof record.body === "string" ? record.body : "",
    author: typeof user.login === "string" ? user.login : undefined,
    url: typeof record.html_url === "string" ? record.html_url : typeof record.url === "string" ? record.url : undefined,
    createdAt: typeof record.created_at === "string" ? record.created_at : undefined,
    updatedAt: typeof record.updated_at === "string" ? record.updated_at : undefined,
  };
}

function normalizedBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
