import { resolve } from "node:path";
import { execa } from "execa";

const PLATFORM_CI_WORKFLOW_DISPATCH_DEFAULT_WORKFLOW = "github-actions-staging.yml";

export interface PlatformCiWorkflowDispatchCliOptions {
  dir?: string;
  phase?: string;
  workflow?: string;
  loomBin?: string;
  bundleDir?: string;
  nodeVersion?: string;
  bootstrapSourceTree?: string | boolean;
  repo?: string;
  ref?: string;
  ghBin?: string;
  report?: string;
}

export interface PlatformCiWorkflowDispatchResult {
  schemaVersion: "platform-ci-workflow-dispatch/v1";
  ok: boolean;
  tokenFree: true;
  provider: "github-actions";
  dir: string;
  reportPath?: string;
  workflow: string;
  repo?: string;
  phase: string;
  ref?: string;
  inputs: {
    phase: string;
    loom_bin: string;
    bundle_dir: string;
    node_version: string;
    bootstrap_source_tree: "true" | "false";
  };
  gh: {
    listBefore: PlatformCiWorkflowDispatchCommandRef;
    dispatch: PlatformCiWorkflowDispatchCommandRef;
    listAfter: PlatformCiWorkflowDispatchCommandRef;
  };
  run?: PlatformCiWorkflowDispatchRunRef;
  gates: {
    listBeforeOk: boolean;
    dispatchOk: boolean;
    listAfterOk: boolean;
    runIdentified: boolean;
  };
  missing: string[];
}

interface PlatformCiWorkflowDispatchCommandRef {
  commandArgs: string[];
  exitCode?: number;
  succeeded: boolean;
}

interface PlatformCiWorkflowDispatchRunRef {
  id: string;
  url?: string;
  status?: string;
  conclusion?: string;
  event?: string;
  workflowName?: string;
}

interface PlatformCiWorkflowDispatchGhRun {
  databaseId?: number | string;
  url?: string;
  status?: string;
  conclusion?: string | null;
  event?: string;
  workflowName?: string;
}

export async function dispatchPlatformCiWorkflow(
  options: PlatformCiWorkflowDispatchCliOptions = {},
): Promise<PlatformCiWorkflowDispatchResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const reportPath = options.report ? resolve(options.report) : undefined;
  const workflow = options.workflow ?? PLATFORM_CI_WORKFLOW_DISPATCH_DEFAULT_WORKFLOW;
  const phase = options.phase ?? "pre-serve";
  const inputs = {
    phase,
    loom_bin: options.loomBin ?? "loom",
    bundle_dir: options.bundleDir ?? "cutover-bundle",
    node_version: options.nodeVersion ?? "22",
    bootstrap_source_tree: booleanInput(options.bootstrapSourceTree, true),
  } satisfies PlatformCiWorkflowDispatchResult["inputs"];
  const ghBin = options.ghBin ?? "gh";
  const listCommandArgs = workflowDispatchListCommandArgs(ghBin, workflow, options.repo, options.ref);
  const dispatchCommandArgs = workflowDispatchCommandArgs(ghBin, workflow, inputs, options.repo, options.ref);

  const listBefore = await runGhJson(listCommandArgs);
  if (listBefore.exitCode !== 0) {
    return workflowDispatchResult({
      dir,
      reportPath,
      workflow,
      ...(options.repo ? { repo: options.repo } : {}),
      phase,
      ref: options.ref,
      inputs,
      gh: {
        listBefore: commandRef(listCommandArgs, listBefore.exitCode),
        dispatch: commandRef(dispatchCommandArgs),
        listAfter: commandRef(listCommandArgs),
      },
      gates: {
        listBeforeOk: false,
        dispatchOk: false,
        listAfterOk: false,
        runIdentified: false,
      },
    });
  }

  const dispatch = await execa(ghBin, dispatchCommandArgs.slice(1), { reject: false });
  if (dispatch.exitCode !== 0) {
    return workflowDispatchResult({
      dir,
      reportPath,
      workflow,
      ...(options.repo ? { repo: options.repo } : {}),
      phase,
      ref: options.ref,
      inputs,
      gh: {
        listBefore: commandRef(listCommandArgs, listBefore.exitCode),
        dispatch: commandRef(dispatchCommandArgs, dispatch.exitCode),
        listAfter: commandRef(listCommandArgs),
      },
      gates: {
        listBeforeOk: true,
        dispatchOk: false,
        listAfterOk: false,
        runIdentified: false,
      },
    });
  }

  const listAfter = await runGhJson(listCommandArgs);
  const run = listAfter.exitCode === 0 ? identifyNewWorkflowRun(listBefore.runs, listAfter.runs) : undefined;
  return workflowDispatchResult({
    dir,
    reportPath,
    workflow,
    ...(options.repo ? { repo: options.repo } : {}),
    phase,
    ref: options.ref,
    inputs,
    gh: {
      listBefore: commandRef(listCommandArgs, listBefore.exitCode),
      dispatch: commandRef(dispatchCommandArgs, dispatch.exitCode),
      listAfter: commandRef(listCommandArgs, listAfter.exitCode),
    },
    ...(run ? { run } : {}),
    gates: {
      listBeforeOk: true,
      dispatchOk: true,
      listAfterOk: listAfter.exitCode === 0,
      runIdentified: run !== undefined,
    },
  });
}

function workflowDispatchListCommandArgs(
  ghBin: string,
  workflow: string,
  repo: string | undefined,
  ref: string | undefined,
): string[] {
  return [
    ghBin,
    "run",
    "list",
    "--workflow",
    workflow,
    ...(repo ? ["--repo", repo] : []),
    ...(ref ? ["--branch", ref] : []),
    "--event",
    "workflow_dispatch",
    "--json",
    "databaseId,url,status,conclusion,event,workflowName",
    "--limit",
    "20",
  ];
}

function workflowDispatchCommandArgs(
  ghBin: string,
  workflow: string,
  inputs: PlatformCiWorkflowDispatchResult["inputs"],
  repo: string | undefined,
  ref: string | undefined,
): string[] {
  return [
    ghBin,
    "workflow",
    "run",
    workflow,
    ...(repo ? ["--repo", repo] : []),
    "--field",
    `phase=${inputs.phase}`,
    "--field",
    `loom_bin=${inputs.loom_bin}`,
    "--field",
    `bundle_dir=${inputs.bundle_dir}`,
    "--field",
    `node_version=${inputs.node_version}`,
    "--field",
    `bootstrap_source_tree=${inputs.bootstrap_source_tree}`,
    ...(ref ? ["--ref", ref] : []),
  ];
}

async function runGhJson(commandArgs: string[]): Promise<{ exitCode: number; runs: PlatformCiWorkflowDispatchGhRun[] }> {
  const result = await execa(commandArgs[0] ?? "gh", commandArgs.slice(1), { reject: false });
  const exitCode = result.exitCode ?? 1;
  if (exitCode !== 0) return { exitCode, runs: [] };
  try {
    const value = JSON.parse(result.stdout) as unknown;
    return {
      exitCode,
      runs: Array.isArray(value) ? value.filter(isWorkflowRunRecord) : [],
    };
  } catch {
    return { exitCode: 1, runs: [] };
  }
}

function identifyNewWorkflowRun(
  before: PlatformCiWorkflowDispatchGhRun[],
  after: PlatformCiWorkflowDispatchGhRun[],
): PlatformCiWorkflowDispatchRunRef | undefined {
  const beforeIds = new Set(before.map(workflowRunId).filter((id): id is string => id !== undefined));
  const run = after.find((item) => {
    const id = workflowRunId(item);
    return id !== undefined && !beforeIds.has(id);
  });
  const id = run ? workflowRunId(run) : undefined;
  if (!run || !id) return undefined;
  return {
    id,
    ...(run.url ? { url: run.url } : {}),
    ...(run.status ? { status: run.status } : {}),
    ...(run.conclusion ? { conclusion: run.conclusion } : {}),
    ...(run.event ? { event: run.event } : {}),
    ...(run.workflowName ? { workflowName: run.workflowName } : {}),
  };
}

function workflowRunId(run: PlatformCiWorkflowDispatchGhRun): string | undefined {
  if (typeof run.databaseId === "number") return String(run.databaseId);
  return typeof run.databaseId === "string" && run.databaseId.trim() ? run.databaseId : undefined;
}

function commandRef(commandArgs: string[], exitCode?: number): PlatformCiWorkflowDispatchCommandRef {
  return {
    commandArgs,
    ...(exitCode !== undefined ? { exitCode } : {}),
    succeeded: exitCode === 0,
  };
}

function workflowDispatchResult(
  value: Omit<PlatformCiWorkflowDispatchResult, "schemaVersion" | "ok" | "tokenFree" | "provider" | "missing">,
): PlatformCiWorkflowDispatchResult {
  const missing = [
    ...(value.gates.listBeforeOk ? [] : ["github.workflowRuns.before"]),
    ...(value.gates.dispatchOk ? [] : ["github.workflowDispatch"]),
    ...(value.gates.listAfterOk ? [] : ["github.workflowRuns.after"]),
    ...(value.gates.runIdentified ? [] : ["github.runId"]),
  ];
  return {
    schemaVersion: "platform-ci-workflow-dispatch/v1",
    ok: Object.values(value.gates).every(Boolean),
    tokenFree: true,
    provider: "github-actions",
    ...value,
    missing,
  };
}

function booleanInput(value: string | boolean | undefined, fallback: boolean): "true" | "false" {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === "true" || value === "1") return "true";
  if (value === "false" || value === "0") return "false";
  return fallback ? "true" : "false";
}

function isWorkflowRunRecord(value: unknown): value is PlatformCiWorkflowDispatchGhRun {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
