import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PLATFORM_CI_WORKFLOW_PUBLISH_DEFAULT_WORKFLOW = "github-actions-staging.yml";

export interface PlatformCiWorkflowPublishPlanCliOptions {
  dir?: string;
  repoRoot?: string;
  workflow?: string;
  repo?: string;
  ref?: string;
  report?: string;
}

export interface PlatformCiWorkflowPublishPlanResult {
  schemaVersion: "platform-ci-workflow-publish-plan/v1";
  ok: boolean;
  tokenFree: true;
  provider: "github-actions";
  dir: string;
  repoRoot: string;
  reportPath?: string;
  repo?: string;
  ref?: string;
  workflow: string;
  workflowInstall: {
    destinationPath: string;
    source: LocalTextRef;
    installed: LocalInstalledWorkflowRef;
  };
  installCommandArgs: string[];
  gitStatusCommandArgs: string[];
  gitAddCommandArgs: string[];
  gitCommitCommandArgs: string[];
  gitPushCommandArgs: string[];
  repoDiscoveryCommandArgs: string[];
  repoDiscoveryCwd: string;
  repoDiscoveryFields: {
    repo: "nameWithOwner";
    ref: "defaultBranchRef.name";
  };
  workflowVerifyCommandArgs: string[];
  preflightCommandArgs: string[];
  gates: {
    bundleWorkflowOk: boolean;
    localWorkflowInstallOk: boolean;
    gitPublishCommandReady: boolean;
    workflowVerifyCommandReady: boolean;
  };
  missing: string[];
  nextActions: string[];
}

interface LocalTextRef {
  path: string;
  exists: boolean;
  sha256?: string;
}

interface LocalInstalledWorkflowRef extends LocalTextRef {
  matchesBundle: boolean;
}

export function createPlatformCiWorkflowPublishPlan(
  options: PlatformCiWorkflowPublishPlanCliOptions = {},
): PlatformCiWorkflowPublishPlanResult {
  const dir = resolve(options.dir ?? process.cwd());
  const repoRoot = resolve(options.repoRoot ?? dirname(dir));
  const reportPath = options.report ? resolve(options.report) : undefined;
  const workflow = options.workflow ?? PLATFORM_CI_WORKFLOW_PUBLISH_DEFAULT_WORKFLOW;
  const source = localTextRef(join(dir, workflow));
  const destinationPath = `.github/workflows/${workflow}`;
  const installed = localTextRef(join(repoRoot, destinationPath));
  const installedWorkflow = {
    ...installed,
    matchesBundle: source.sha256 !== undefined && source.sha256 === installed.sha256,
  };
  const installCommandArgs = [
    "loom",
    "harness",
    "platform-ci-handoff-install",
    "--dir",
    dir,
    "--repo-root",
    repoRoot,
    "--report",
    join(dir, "reports", "ci-handoff-install.json"),
  ];
  const gitStatusCommandArgs = ["git", "status", "--short", destinationPath];
  const gitAddCommandArgs = ["git", "add", destinationPath];
  const gitCommitCommandArgs = ["git", "commit", "-m", "ci: publish Loom staging workflow", "--", destinationPath];
  const gitPushCommandArgs = options.ref ? ["git", "push", "origin", `HEAD:${options.ref}`] : [];
  const repoDiscoveryCommandArgs = ["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"];
  const workflowVerifyCommandArgs = [
    "gh",
    "workflow",
    "view",
    workflow,
    ...(options.repo ? ["--repo", options.repo] : []),
    ...(options.ref ? ["--ref", options.ref] : []),
  ];
  const preflightCommandArgs = [
    "loom",
    "harness",
    "platform-ci-handoff-preflight",
    "--dir",
    dir,
    "--repo-root",
    repoRoot,
    ...(options.repo ? ["--repo", options.repo] : []),
    ...(options.ref ? ["--ref", options.ref] : []),
    "--report",
    join(dir, "reports", "ci-handoff-preflight.json"),
  ];
  const gates = {
    bundleWorkflowOk: source.exists,
    localWorkflowInstallOk: installedWorkflow.matchesBundle,
    gitPublishCommandReady: installedWorkflow.matchesBundle && options.ref !== undefined,
    workflowVerifyCommandReady: options.repo !== undefined && options.ref !== undefined,
  };
  const missing = [
    ...(gates.bundleWorkflowOk ? [] : ["bundle.githubActionsWorkflow"]),
    ...(gates.localWorkflowInstallOk ? [] : ["local.workflowInstall"]),
    ...(gates.gitPublishCommandReady ? [] : ["github.ref"]),
    ...(gates.workflowVerifyCommandReady ? [] : ["github.repository"]),
  ];
  return {
    schemaVersion: "platform-ci-workflow-publish-plan/v1",
    ok: missing.length === 0,
    tokenFree: true,
    provider: "github-actions",
    dir,
    repoRoot,
    ...(reportPath ? { reportPath } : {}),
    ...(options.repo ? { repo: options.repo } : {}),
    ...(options.ref ? { ref: options.ref } : {}),
    workflow,
    workflowInstall: {
      destinationPath,
      source,
      installed: installedWorkflow,
    },
    installCommandArgs,
    gitStatusCommandArgs,
    gitAddCommandArgs,
    gitCommitCommandArgs,
    gitPushCommandArgs,
    repoDiscoveryCommandArgs,
    repoDiscoveryCwd: repoRoot,
    repoDiscoveryFields: {
      repo: "nameWithOwner",
      ref: "defaultBranchRef.name",
    },
    workflowVerifyCommandArgs,
    preflightCommandArgs,
    gates,
    missing,
    nextActions: workflowPublishPlanNextActions(missing),
  };
}

function workflowPublishPlanNextActions(missing: string[]): string[] {
  if (missing.includes("bundle.githubActionsWorkflow")) {
    return ["Regenerate the cutover bundle so github-actions-staging.yml exists, then rerun platform-ci-workflow-publish-plan."];
  }
  if (missing.includes("local.workflowInstall")) {
    return ["Run installCommandArgs, then rerun platform-ci-workflow-publish-plan."];
  }
  if (missing.includes("github.ref") || missing.includes("github.repository")) {
    return ["Run repoDiscoveryCommandArgs from repoDiscoveryCwd, then rerun platform-ci-workflow-publish-plan with --repo <nameWithOwner> and --ref <defaultBranchRef.name>."];
  }
  return ["Run installCommandArgs if the installed workflow is stale, run gitStatusCommandArgs/gitAddCommandArgs/gitCommitCommandArgs/gitPushCommandArgs, run workflowVerifyCommandArgs, then rerun preflightCommandArgs."];
}

function localTextRef(path: string): LocalTextRef {
  if (!existsSync(path)) return { path, exists: false };
  const text = readFileSync(path, "utf8");
  return {
    path,
    exists: true,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}
