import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";

const PLATFORM_CI_WORKFLOW_WAIT_VIEW_JSON_FIELDS = "databaseId,url,status,conclusion,event,workflowName";

export interface PlatformCiWorkflowWaitCliOptions {
  dir?: string;
  runId?: string;
  repo?: string;
  phase?: string;
  intervalSeconds?: string | number;
  ghBin?: string;
  report?: string;
}

export interface PlatformCiWorkflowWaitResult {
  schemaVersion: "platform-ci-workflow-wait/v1";
  ok: boolean;
  tokenFree: true;
  provider: "github-actions";
  dir: string;
  reportPath?: string;
  runId?: string;
  repo?: string;
  phase: string;
  gh: {
    watch: PlatformCiWorkflowWaitCommandRef;
    view: PlatformCiWorkflowWaitCommandRef;
  };
  run?: PlatformCiWorkflowWaitRunRef;
  gates: {
    runIdOk: boolean;
    ghWatchOk: boolean;
    ghViewOk: boolean;
    runSucceeded: boolean;
  };
  missing: string[];
}

interface PlatformCiWorkflowWaitCommandRef {
  commandArgs: string[];
  exitCode?: number;
  succeeded: boolean;
}

interface PlatformCiWorkflowWaitRunRef {
  id: string;
  url?: string;
  status?: string;
  conclusion?: string;
  event?: string;
  workflowName?: string;
}

interface PlatformCiWorkflowWaitDispatchRef {
  runId?: string;
  repo?: string;
  phase?: string;
}

interface PlatformCiWorkflowWaitGhRun {
  databaseId?: number | string;
  url?: string;
  status?: string;
  conclusion?: string | null;
  event?: string;
  workflowName?: string;
}

export async function waitForPlatformCiWorkflow(
  options: PlatformCiWorkflowWaitCliOptions = {},
): Promise<PlatformCiWorkflowWaitResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const reportPath = options.report ? resolve(options.report) : undefined;
  const dispatch = await readWorkflowDispatch(join(dir, "reports", "ci-workflow-dispatch.json"));
  const runId = options.runId ?? dispatch.runId;
  const repo = options.repo ?? dispatch.repo;
  const phase = options.phase ?? dispatch.phase ?? "post-serve";
  const intervalSeconds = normalizeIntervalSeconds(options.intervalSeconds);
  const ghBin = options.ghBin ?? "gh";
  const watchCommandArgs = workflowWaitCommandArgs(ghBin, runId, repo, intervalSeconds);
  const viewCommandArgs = workflowViewCommandArgs(ghBin, runId, repo);

  if (!runId) {
    return workflowWaitResult({
      dir,
      reportPath,
      ...(repo ? { repo } : {}),
      phase,
      gh: {
        watch: commandRef(watchCommandArgs),
        view: commandRef(viewCommandArgs),
      },
      gates: {
        runIdOk: false,
        ghWatchOk: false,
        ghViewOk: false,
        runSucceeded: false,
      },
    });
  }

  const watch = await execa(ghBin, watchCommandArgs.slice(1), { reject: false });
  const watchExitCode = watch.exitCode ?? 1;
  const view = await runGhRunView(viewCommandArgs);
  return workflowWaitResult({
    dir,
    reportPath,
    runId,
    ...(repo ? { repo } : {}),
    phase,
    gh: {
      watch: commandRef(watchCommandArgs, watchExitCode),
      view: commandRef(viewCommandArgs, view.exitCode),
    },
    ...(view.run ? { run: view.run } : {}),
    gates: {
      runIdOk: true,
      ghWatchOk: watchExitCode === 0,
      ghViewOk: view.exitCode === 0,
      runSucceeded: view.run?.conclusion === "success",
    },
  });
}

function workflowWaitCommandArgs(
  ghBin: string,
  runId: string | undefined,
  repo: string | undefined,
  intervalSeconds: number,
): string[] {
  return [
    ghBin,
    "run",
    "watch",
    runId ?? "",
    ...(repo ? ["--repo", repo] : []),
    "--exit-status",
    "--interval",
    String(intervalSeconds),
  ];
}

function workflowViewCommandArgs(ghBin: string, runId: string | undefined, repo: string | undefined): string[] {
  return [
    ghBin,
    "run",
    "view",
    runId ?? "",
    ...(repo ? ["--repo", repo] : []),
    "--json",
    PLATFORM_CI_WORKFLOW_WAIT_VIEW_JSON_FIELDS,
  ];
}

async function runGhRunView(commandArgs: string[]): Promise<{ exitCode: number; run?: PlatformCiWorkflowWaitRunRef }> {
  const result = await execa(commandArgs[0] ?? "gh", commandArgs.slice(1), { reject: false });
  const exitCode = result.exitCode ?? 1;
  if (exitCode !== 0) return { exitCode };
  try {
    const value = JSON.parse(result.stdout) as unknown;
    const run = ghRunRef(value);
    return {
      exitCode: run ? exitCode : 1,
      ...(run ? { run } : {}),
    };
  } catch {
    return { exitCode: 1 };
  }
}

function ghRunRef(value: unknown): PlatformCiWorkflowWaitRunRef | undefined {
  if (!isGhRun(value)) return undefined;
  const id = workflowRunId(value);
  if (!id) return undefined;
  return {
    id,
    ...(value.url ? { url: value.url } : {}),
    ...(value.status ? { status: value.status } : {}),
    ...(value.conclusion ? { conclusion: value.conclusion } : {}),
    ...(value.event ? { event: value.event } : {}),
    ...(value.workflowName ? { workflowName: value.workflowName } : {}),
  };
}

function workflowRunId(run: PlatformCiWorkflowWaitGhRun): string | undefined {
  if (typeof run.databaseId === "number") return String(run.databaseId);
  return typeof run.databaseId === "string" && run.databaseId.trim() ? run.databaseId : undefined;
}

function commandRef(commandArgs: string[], exitCode?: number): PlatformCiWorkflowWaitCommandRef {
  return {
    commandArgs,
    ...(exitCode !== undefined ? { exitCode } : {}),
    succeeded: exitCode === 0,
  };
}

function workflowWaitResult(
  value: Omit<PlatformCiWorkflowWaitResult, "schemaVersion" | "ok" | "tokenFree" | "provider" | "missing">,
): PlatformCiWorkflowWaitResult {
  const missing = [
    ...(value.gates.runIdOk ? [] : ["github.runId"]),
    ...(value.gates.ghWatchOk ? [] : ["github.workflowRunWait"]),
    ...(value.gates.ghViewOk ? [] : ["github.workflowRunView"]),
    ...(value.gates.runSucceeded ? [] : ["github.workflowRunSuccess"]),
  ];
  return {
    schemaVersion: "platform-ci-workflow-wait/v1",
    ok: Object.values(value.gates).every(Boolean),
    tokenFree: true,
    provider: "github-actions",
    ...value,
    missing,
  };
}

async function readWorkflowDispatch(path: string): Promise<PlatformCiWorkflowWaitDispatchRef> {
  if (!existsSync(path)) return {};
  try {
    const text = await readFile(path, "utf8");
    const value = JSON.parse(text) as unknown;
    const record = objectRecord(value);
    const run = objectRecord(record?.run);
    return {
      runId: stringValue(run?.id),
      repo: stringValue(record?.repo),
      phase: stringValue(record?.phase),
    };
  } catch {
    return {};
  }
}

function normalizeIntervalSeconds(value: string | number | undefined): number {
  const numberValue = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : 10;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isGhRun(value: unknown): value is PlatformCiWorkflowWaitGhRun {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
