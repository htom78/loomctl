import { createCoderExecutor } from "../../harness/coder-executor.js";
import { createDockerExecutor } from "../../harness/docker-executor.js";
import { type WorkspaceExecutor } from "../../harness/executor.js";
import { type HarnessWorkspaceContext } from "../../harness/server.js";
import { assertTenantName } from "../../tenant.js";
import { parsePositiveIntFlag, parsePositiveNumberFlag } from "./flags.js";
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface ExecutorConfigurationIssue {
  flag: string;
  message: string;
}

export function executorConfigurationIssues(options: Pick<ExecutorCliOptions, "executor" | "executorImage" | "executorWorkspace">): ExecutorConfigurationIssue[] {
  if (options.executor === "local") return [];
  if (options.executor === "docker") {
    return options.executorImage?.trim()
      ? []
      : [{ flag: "--executor-image", message: "--executor-image is required when --executor docker is used." }];
  }
  if (options.executor === "coder") {
    return options.executorWorkspace?.trim()
      ? []
      : [{ flag: "--executor-workspace", message: "--executor-workspace is required when --executor coder is used." }];
  }
  return [{ flag: "--executor", message: "--executor must be one of: local, docker, coder" }];
}

export function requireExecutorConfiguration(options: Pick<ExecutorCliOptions, "executor" | "executorImage" | "executorWorkspace">): void {
  const [issue] = executorConfigurationIssues(options);
  if (!issue) return;
  console.error(issue.message);
  process.exit(2);
}

export interface ExecutorCliOptions {
  executor: string;
  executorImage?: string;
  executorNetwork?: string;
  executorCpus?: string;
  executorMemory?: string;
  executorPidsLimit?: string;
  executorHomeRoot?: string;
  executorWorkspace?: string;
  executorRemoteCwd: string;
  executorWorktreeCwd?: string;
  executorTemplate?: string;
  executorTemplateParam?: string[];
  executorIdeUrl?: string;
  executorPreviewUrl?: string;
  branch?: string;
  baseBranch: string;
}

export function executorFactoryFromOptions(options: ExecutorCliOptions): ((cwd: string, context: HarnessWorkspaceContext) => WorkspaceExecutor) | undefined {
  requireExecutorConfiguration(options);
  if (options.executor === "local") {
    return undefined;
  }

  if (options.executor === "docker") {
    const image = options.executorImage as string;
    const network = options.executorNetwork;
    const cpus = options.executorCpus === undefined
      ? undefined
      : parsePositiveNumberFlag(options.executorCpus, "--executor-cpus");
    const memory = options.executorMemory?.trim() || undefined;
    const pidsLimit = options.executorPidsLimit === undefined
      ? undefined
      : parsePositiveIntFlag(options.executorPidsLimit, "--executor-pids-limit");
    const homeRoot = executorHomeRootFromOptions(options);
    return (cwd: string, context: HarnessWorkspaceContext) => createDockerExecutor({
      cwd,
      home: homeRoot ? dockerHomePath(homeRoot, context) : undefined,
      image,
      network: context.executorLimits?.network ?? network,
      cpus: context.executorLimits?.cpus ?? cpus,
      memory: context.executorLimits?.memory ?? memory,
      pidsLimit: context.executorLimits?.pidsLimit ?? pidsLimit,
    });
  }

  if (options.executor === "coder") {
    const workspaceTemplate = options.executorWorkspace as string;
    const repoCwdTemplate = options.executorRemoteCwd;
    const worktreeCwdTemplate = options.executorWorktreeCwd;
    const ideUrlTemplate = options.executorIdeUrl;
    const previewUrlTemplate = options.executorPreviewUrl;
    const templateParameterTemplates = options.executorTemplateParam ?? [];
    const cpus = options.executorCpus === undefined
      ? undefined
      : parsePositiveNumberFlag(options.executorCpus, "--executor-cpus");
    const memory = options.executorMemory?.trim() || undefined;
    const pidsLimit = options.executorPidsLimit === undefined
      ? undefined
      : parsePositiveIntFlag(options.executorPidsLimit, "--executor-pids-limit");
    return (_cwd: string, context: HarnessWorkspaceContext) =>
      createCoderExecutor({
        workspace: renderExecutorTemplate(workspaceTemplate, context),
        remoteCwd: renderExecutorTemplate(worktreeCwdTemplate ?? repoCwdTemplate, context),
        repoCwd: worktreeCwdTemplate ? renderExecutorTemplate(repoCwdTemplate, context) : undefined,
        template: options.executorTemplate,
        templateParameters: [
          ...templateParameterTemplates,
          ...(context.executorTemplateParameters ?? []),
        ].map((parameter) => renderExecutorTemplate(parameter, context)),
        templateResourceLimits: {
          cpus: context.executorLimits?.cpus ?? cpus,
          memory: context.executorLimits?.memory ?? memory,
          pidsLimit: context.executorLimits?.pidsLimit ?? pidsLimit,
        },
        ideUrl: ideUrlTemplate ? renderExecutorTemplate(ideUrlTemplate, context) : undefined,
        previewUrl: previewUrlTemplate ? renderExecutorTemplate(previewUrlTemplate, context) : undefined,
        repo: context.repo,
        branch: context.branch,
        baseBranch: context.baseBranch ?? options.baseBranch,
      });
  }

  console.error("--executor must be one of: local, docker, coder");
  process.exit(2);
}

export function dockerHomePath(homeRoot: string, context: HarnessWorkspaceContext): string {
  const home = join(homeRoot, assertTenantName(context.tenant));
  mkdirSync(home, { recursive: true });
  return home;
}

export function executorHomeRootFromOptions(options: Pick<ExecutorCliOptions, "executorHomeRoot">): string | undefined {
  return options.executorHomeRoot?.trim() ? resolve(options.executorHomeRoot.trim()) : undefined;
}

export function renderExecutorTemplate(template: string, context: HarnessWorkspaceContext): string {
  const rendered = template
    .replaceAll("{tenant}", context.tenant)
    .replaceAll("{project}", context.project)
    .replaceAll("{runId}", context.runId)
    .replaceAll("{cwdBase}", basename(context.cwd));
  if (/\{[^}]+\}/.test(rendered)) {
    console.error(`unresolved executor template value: ${template}`);
    process.exit(2);
  }
  return rendered;
}
