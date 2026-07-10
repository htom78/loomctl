import { ingest } from "../../brain.js";
import { createCommandAgent, createScriptedAgent } from "../../harness/agents.js";
import { type RunMetadata, type RunSummary } from "../../harness/events.js";
import { giteaIssueUrl } from "../../harness/gitea.js";
import { makeRunId, runHarness } from "../../harness/loop.js";
import { createOpenAiCompatibleAgent } from "../../harness/model-agent.js";
import { appendRunEvent } from "../../harness/run-store.js";
import { cfg } from "../lib/context.js";
import { executorFactoryFromOptions } from "../lib/executor.js";
import { cliGitRef, cliIssueRef, collect, compactObject, optionalCliRepo, parseModelProtocolFlag } from "../lib/flags.js";
import { maybeIssueReporter, maybePullRequestReporter, type PullRequestReporterResult, runSignalEvidenceUrl, runSignalFromSummary, runUrl } from "../lib/reporters.js";
import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export function registerHarnessRunCommand(harness: Command): void {
harness
  .command("run <goal>")
  .description("run the OpenHands-lite event loop with tool execution and verification gate")
  .option("--cwd <path>", "workspace directory", process.cwd())
  .option("--run-root <path>", "run artifact root; defaults to <cwd>/.loom/runs")
  .option("--script <path>", "scripted agent steps JSON")
  .option("--agent-command <command>", "external agent command that reads JSON on stdin and returns one AgentStep JSON")
  .option("--model <name>", "OpenAI-compatible model name routed through LiteLLM")
  .option("--model-base-url <url>", "OpenAI-compatible base URL", cfg.gatewayUrl)
  .option("--model-key-env <name>", "env var containing the model API key", cfg.gatewayKeyEnv)
  .option("--model-protocol <protocol>", "model agent protocol: json|tool-call", "json")
  .option("--executor <kind>", "workspace executor: local|docker|coder", "local")
  .option("--executor-image <image>", "Docker image when --executor docker is used")
  .option("--executor-network <mode>", "Docker network mode for --executor docker")
  .option("--executor-cpus <count>", "Docker CPU limit, or Coder cpus template parameter")
  .option("--executor-memory <size>", "Docker memory limit, or Coder memory_gb template parameter")
  .option("--executor-pids-limit <count>", "Docker pids limit, or Coder pids_limit template parameter")
  .option("--executor-home-root <path>", "persistent Docker home root; mounts <path>/<tenant> at /home/dev")
  .option("--executor-workspace <name>", "Coder workspace name or template when --executor coder is used")
  .option("--executor-remote-cwd <path>", "remote cwd or template for --executor coder", "/home/dev/projects/{project}")
  .option("--executor-worktree-cwd <path>", "remote run worktree cwd template for --executor coder")
  .option("--executor-template <name>", "Coder template to create a missing workspace")
  .option("--executor-template-param <name=value>", "Coder template parameter for missing workspace creation; repeatable", collect, [] as string[])
  .option("--executor-ide-url <url>", "browser IDE URL template for --executor coder")
  .option("--executor-preview-url <url>", "browser preview URL template for apps running in --executor coder")
  .option("--repo <url>", "repository URL to sync before the run")
  .option("--branch <name>", "git branch to check out after syncing --repo")
  .option("--base-branch <name>", "base git branch used when creating --branch", "origin/main")
  .option("--public-url <url>", "public harness server URL used in run metadata links")
  .option("--issue <owner/repo#number>", "Gitea/Forgejo issue to link in run metadata")
  .option("--require-review", "hold successful verification at review_required until a human reviews it", false)
  .option("--require-deployment", "hold successful verification at deployment_required until an admin approves deployment", false)
  .option("--gitea-pr", "create a Gitea/Forgejo pull request for --issue and --branch", false)
  .option("--gitea-comment", "post the final run summary to --issue as a Gitea/Forgejo comment", false)
  .option("--gitea-url <url>", "Gitea/Forgejo base URL", cfg.giteaUrl)
  .option("--gitea-token-env <name>", "env var containing the Gitea/Forgejo token", "LOOM_GITEA_TOKEN")
  .option("--verify <command>", "verification command; repeatable", collect, [] as string[])
  .option("--evaluate <command>", "independent evaluator command after verification; repeatable", collect, [] as string[])
  .option("--reviewer <command>", "non-gating reviewer command after verification/evaluation; repeatable", collect, [] as string[])
  .option("--skill <name>", "skill active in this run; repeatable", collect, [] as string[])
  .option("--max-iterations <n>", "maximum loop iterations", "20")
  .option("--ingest-brain", "append this run outcome to the git-backed brain", false)
  .action(
    async (
      goal: string,
      opts: {
        cwd: string;
        runRoot?: string;
        script?: string;
        agentCommand?: string;
        model?: string;
        modelBaseUrl: string;
        modelKeyEnv: string;
        modelProtocol: string;
        executor: string;
        executorImage?: string;
        executorNetwork?: string;
        executorCpus?: string;
        executorMemory?: string;
        executorPidsLimit?: string;
        executorWorkspace?: string;
        executorRemoteCwd: string;
        executorWorktreeCwd?: string;
        executorTemplate?: string;
        executorTemplateParam: string[];
        executorIdeUrl?: string;
        executorPreviewUrl?: string;
        repo?: string;
        branch?: string;
        baseBranch: string;
        publicUrl?: string;
        issue?: string;
        requireReview: boolean;
        requireDeployment: boolean;
        giteaPr: boolean;
        giteaComment: boolean;
        giteaUrl: string;
        giteaTokenEnv: string;
        verify: string[];
        evaluate: string[];
        reviewer: string[];
        skill: string[];
        maxIterations: string;
        ingestBrain: boolean;
      },
    ) => {
      if (!opts.script && !opts.agentCommand && !opts.model) {
        console.error("Either --script, --agent-command, or --model is required for harness run.");
        process.exit(2);
      }
      if (opts.giteaPr && (!opts.issue || !opts.branch)) {
        console.error("--gitea-pr requires --issue and --branch.");
        process.exit(2);
      }

      const source = parseHarnessRunSourceOptions(opts);
      const createExecutor = executorFactoryFromOptions(opts);
      const runId = makeRunId();
      const project = basename(opts.cwd);
      const agentMode = opts.script ? "script" : opts.agentCommand ? "command" : "model";
      const modelProtocol = parseModelProtocolFlag(opts.modelProtocol, "--model-protocol");
      const metadata = runMetadata({
        tenant: "local",
        project,
        repo: source.repo,
        branch: source.branch,
        baseBranch: source.baseBranch,
        issue: source.issue,
        issueUrl: source.issue ? giteaIssueUrl(opts.giteaUrl, source.issue) : undefined,
        dashboardUrl: opts.publicUrl ? runDashboardUrl(opts.publicUrl, "local", project, runId) : undefined,
        summaryUrl: opts.publicUrl ? runUrl(opts.publicUrl, "local", project, runId) : undefined,
        agentMode,
        model: agentMode === "model" ? opts.model : undefined,
        modelProtocol: agentMode === "model" && modelProtocol !== "json" ? modelProtocol : undefined,
      });
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
        metadata,
        reviewRequired: opts.requireReview,
        deploymentRequired: opts.requireDeployment,
        maxIterations: Number(opts.maxIterations),
        executor: createExecutor?.(opts.cwd, {
          tenant: "local",
          project,
          runId,
          cwd: opts.cwd,
          repo: source.repo,
          branch: source.branch,
          baseBranch: source.baseBranch,
        }),
      });
      const reported = await finalizeSummary(summary, maybePullRequestReporter(opts), maybeIssueReporter(opts));

      if (opts.ingestBrain) {
        ingest(cfg, runSignalFromSummary(reported, basename(opts.cwd)));
      }

      console.log(JSON.stringify(reported, null, 2));
      process.exit(reported.status === "failed" || reported.status === "error" ? 1 : 0);
    },
  );
}

export function parseHarnessRunSourceOptions(options: { repo?: string; branch?: string; baseBranch: string; issue?: string }): { repo?: string; branch?: string; baseBranch: string; issue?: string } {
  return {
    repo: optionalCliRepo(options.repo),
    branch: options.branch ? cliGitRef(options.branch, "--branch") : undefined,
    baseBranch: cliGitRef(options.baseBranch, "--base-branch"),
    issue: options.issue ? cliIssueRef(options.issue, "--issue") : undefined,
  };
}

export async function finalizeSummary(
  summary: RunSummary,
  pullRequestReporter: ((summary: RunSummary) => Promise<PullRequestReporterResult | void>) | undefined,
  issueReporter: ((summary: RunSummary) => Promise<void>) | undefined,
): Promise<RunSummary> {
  const withPullRequest = await reportPullRequest(pullRequestReporter, summary);
  await writeSummary(withPullRequest);
  return reportIssue(issueReporter, withPullRequest);
}

export async function reportPullRequest(
  reporter: ((summary: RunSummary) => Promise<PullRequestReporterResult | void>) | undefined,
  summary: RunSummary,
): Promise<RunSummary> {
  if (!reporter) return summary;
  if (summary.status !== "passed" && summary.status !== "review_required" && summary.status !== "deployment_required") return summary;
  try {
    const result = await reporter(summary);
    const withPullRequest = result ? {
      ...summary,
      metadata: {
        ...summary.metadata,
        pullRequestIndex: result.index,
        pullRequestUrl: result.url,
      },
    } : summary;
    return recordExternalEffect(withPullRequest, {
      kind: "pull_request",
      issue: withPullRequest.metadata?.issue,
      issueUrl: withPullRequest.metadata?.issueUrl,
      branch: withPullRequest.metadata?.branch,
      baseBranch: withPullRequest.metadata?.baseBranch,
      pullRequestIndex: withPullRequest.metadata?.pullRequestIndex,
      pullRequestUrl: withPullRequest.metadata?.pullRequestUrl,
      dashboardUrl: withPullRequest.metadata?.dashboardUrl,
      summaryUrl: withPullRequest.metadata?.summaryUrl,
      reviewSummaryUrl: withPullRequest.metadata?.summaryUrl ? runSignalEvidenceUrl(withPullRequest.metadata.summaryUrl, "review-summary") : undefined,
      handoffPackageUrl: withPullRequest.metadata?.summaryUrl ? runSignalEvidenceUrl(withPullRequest.metadata.summaryUrl, "handoff-package") : undefined,
      handoffFollowupsUrl: withPullRequest.metadata?.summaryUrl ? runSignalEvidenceUrl(withPullRequest.metadata.summaryUrl, "handoff-runs") : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markRunError(summary, `pull request reporter failed: ${message}`);
  }
}

export async function reportIssue(reporter: ((summary: RunSummary) => Promise<void>) | undefined, summary: RunSummary): Promise<RunSummary> {
  if (summary.status === "cancelled" || summary.status === "paused") return summary;
  if (!summary.metadata?.issue || !reporter) return summary;
  try {
    await reporter(summary);
    return recordExternalEffect(summary, {
      kind: "issue_comment",
      issue: summary.metadata.issue,
      issueUrl: summary.metadata.issueUrl,
      dashboardUrl: summary.metadata.dashboardUrl,
      summaryUrl: summary.metadata.summaryUrl,
      reviewSummaryUrl: summary.metadata.summaryUrl ? runSignalEvidenceUrl(summary.metadata.summaryUrl, "review-summary") : undefined,
      handoffPackageUrl: summary.metadata.summaryUrl ? runSignalEvidenceUrl(summary.metadata.summaryUrl, "handoff-package") : undefined,
      handoffFollowupsUrl: summary.metadata.summaryUrl ? runSignalEvidenceUrl(summary.metadata.summaryUrl, "handoff-runs") : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markRunError(summary, `issue reporter failed: ${message}`);
  }
}

export async function recordExternalEffect(summary: RunSummary, data: Record<string, unknown>): Promise<RunSummary> {
  const event = await appendRunEvent(summary.runDir, "external_effect", compactObject({
    ...data,
    requester: summary.requester,
  }));
  const observed: RunSummary = { ...summary, eventCount: event.seq };
  await writeSummary(observed);
  return observed;
}

export async function markRunError(summary: RunSummary, message: string): Promise<RunSummary> {
  const event = await appendRunEvent(summary.runDir, "error", { message });
  const failed: RunSummary = {
    ...summary,
    status: "error",
    endedAt: new Date().toISOString(),
    eventCount: event.seq,
    error: { message },
  };
  await writeSummary(failed);
  return failed;
}

export async function writeSummary(summary: RunSummary): Promise<void> {
  await writeFile(join(summary.runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
}

export function runDashboardUrl(publicUrl: string, tenant: string, project: string, runId: string): string {
  const base = publicUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ tenant, project, runId });
  return `${base}/?${params.toString()}`;
}

export function runMetadata(metadata: RunMetadata): RunMetadata | undefined {
  const compact = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)) as RunMetadata;
  return Object.keys(compact).length > 0 ? compact : undefined;
}
