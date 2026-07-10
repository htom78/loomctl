import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, resolve, join } from "node:path";
import { execa } from "execa";

const PLATFORM_CI_HANDOFF_PREFLIGHT_DEFAULT_WORKFLOW = "github-actions-staging.yml";
const PLATFORM_CI_HANDOFF_PREFLIGHT_REPO_FIELDS = "nameWithOwner,url,viewerPermission,defaultBranchRef";

export interface PlatformCiHandoffPreflightCliOptions {
  dir?: string;
  repoRoot?: string;
  workflow?: string;
  repo?: string;
  ref?: string;
  target?: string;
  ghBin?: string;
  report?: string;
}

export interface PlatformCiHandoffPreflightResult {
  schemaVersion: "platform-ci-handoff-preflight/v1";
  ok: boolean;
  tokenFree: true;
  provider: "github-actions";
  dir: string;
  reportPath?: string;
  workflow: string;
  repo?: string;
  ref?: string;
  targetInputSource: "cli" | "target-file";
  targetInputPath?: string;
  targetInputSha256?: string;
  targetInputTemplatePath: string;
  targetInputTemplate: PlatformCiTargetInputTemplate;
  local: {
    bundleDir: PlatformCiHandoffPreflightLocalRef;
    workflow: PlatformCiHandoffPreflightLocalRef;
    externalSecrets: PlatformCiHandoffPreflightLocalRef;
    stagingCi: PlatformCiHandoffPreflightLocalRef;
  };
  workflowInstall?: {
    repoRoot: string;
    destinationPath: string;
    installed: PlatformCiHandoffPreflightInstalledWorkflowRef;
    installCommandArgs: string[];
  };
  secrets: {
    requiredEnvNames: string[];
    presentRequiredEnvNames: string[];
    missingRequiredEnvNames: string[];
    setMissingRequiredCommandArgs: string[][];
  };
  repository?: {
    nameWithOwner?: string;
    url?: string;
    viewerPermission?: string;
    defaultBranch?: string;
  };
  repoDiscoveryCommandArgs: string[];
  repoDiscoveryCwd: string;
  repoDiscoveryFields: {
    repo: "nameWithOwner";
    ref: "defaultBranchRef.name";
  };
  gh: {
    auth: PlatformCiHandoffPreflightCommandRef;
    repo: PlatformCiHandoffPreflightCommandRef;
    workflow: PlatformCiHandoffPreflightCommandRef;
    secrets: PlatformCiHandoffPreflightCommandRef;
  };
  gates: {
    bundleDirOk: boolean;
    localWorkflowOk: boolean;
    externalSecretsOk: boolean;
    stagingCiOk: boolean;
    ghCliOk?: boolean;
    ghAuthOk: boolean;
    repoOk: boolean;
    workflowVisible: boolean;
    githubSecretsListOk: boolean;
    requiredSecretsPresent: boolean;
    localWorkflowInstallOk?: boolean;
  };
  missing: string[];
  nextActions: string[];
}

interface PlatformCiHandoffPreflightLocalRef {
  path: string;
  exists: boolean;
}

interface PlatformCiHandoffPreflightInstalledWorkflowRef extends PlatformCiHandoffPreflightLocalRef {
  sha256?: string;
  matchesBundle: boolean;
}

interface PlatformCiHandoffPreflightCommandRef {
  commandArgs: string[];
  exitCode?: number;
  succeeded: boolean;
}

interface PlatformCiTargetInputTemplate {
  schemaVersion: "platform-ci-target-input/v1";
  repo: "<owner/repo>";
  ref: "<branch>";
}

export async function checkPlatformCiHandoffPreflight(
  options: PlatformCiHandoffPreflightCliOptions = {},
): Promise<PlatformCiHandoffPreflightResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : undefined;
  const reportPath = options.report ? resolve(options.report) : undefined;
  const workflow = options.workflow ?? PLATFORM_CI_HANDOFF_PREFLIGHT_DEFAULT_WORKFLOW;
  const ghBin = options.ghBin ?? "gh";
  const targetInput = options.target ? readCiTargetInput(resolve(options.target)) : undefined;
  const targetRepo = options.repo ?? targetInput?.repo;
  const targetRef = options.ref ?? targetInput?.ref;
  const targetInputTemplatePath = join(dir, "github-actions-target.input.json");
  const local = {
    bundleDir: localRef(dir),
    workflow: localRef(join(dir, workflow)),
    externalSecrets: localRef(join(dir, "external-secrets.json")),
    stagingCi: localRef(join(dir, "staging-ci.json")),
  };
  const workflowInstall = repoRoot ? localWorkflowInstall(dir, repoRoot, workflow) : undefined;
  const externalSecrets = readExternalSecrets(local.externalSecrets.path);
  const authCommandArgs = [ghBin, "auth", "status"];
  const repoCommandArgs = repoViewCommandArgs(ghBin, targetRepo);
  const repoDiscoveryCommandArgs = repoTargetDiscoveryCommandArgs(ghBin, targetRepo);
  const workflowCommandArgs = workflowViewCommandArgs(ghBin, workflow, targetRepo, targetRef);
  const secretsCommandArgs = secretsListCommandArgs(ghBin, targetRepo);
  const repoDiscoveryCwd = repoRoot && existsSync(repoRoot) ? repoRoot : dirname(dir);
  const ghCwd = existsSync(repoDiscoveryCwd) ? repoDiscoveryCwd : undefined;
  const ghCliOk = executableCommand(ghBin);

  const auth = ghCliOk
    ? await execa(ghBin, authCommandArgs.slice(1), { reject: false, ...(ghCwd ? { cwd: ghCwd } : {}) })
    : { exitCode: 127 };
  const repoView = auth.exitCode === 0 ? await runRepoView(repoCommandArgs, ghCwd) : { exitCode: undefined, repository: undefined };
  const workflowView = repoView.exitCode === 0
    ? await execa(ghBin, workflowCommandArgs.slice(1), { reject: false, ...(ghCwd ? { cwd: ghCwd } : {}) })
    : { exitCode: undefined };
  const secretsList = repoView.exitCode === 0 && externalSecrets.ok
    ? await runSecretsList(secretsCommandArgs, externalSecrets.requiredEnvNames, ghCwd)
    : {
      exitCode: undefined,
      presentRequiredEnvNames: [] as string[],
      missingRequiredEnvNames: externalSecrets.requiredEnvNames,
    };

  return preflightResult({
    dir,
    reportPath,
    workflow,
    ...(targetRepo ? { repo: targetRepo } : {}),
    ...(targetRef ? { ref: targetRef } : {}),
    targetInputSource: targetInput ? "target-file" : "cli",
    ...(targetInput?.path ? { targetInputPath: targetInput.path } : {}),
    ...(targetInput?.sha256 ? { targetInputSha256: targetInput.sha256 } : {}),
    targetInputTemplatePath,
    targetInputTemplate: platformCiTargetInputTemplate(),
    local,
    ...(workflowInstall ? { workflowInstall } : {}),
    secrets: {
      requiredEnvNames: externalSecrets.requiredEnvNames,
      presentRequiredEnvNames: secretsList.presentRequiredEnvNames,
      missingRequiredEnvNames: secretsList.missingRequiredEnvNames,
      setMissingRequiredCommandArgs: secretsList.missingRequiredEnvNames.map((name) =>
        secretSetCommandArgs(ghBin, name, targetRepo ?? repoView.repository?.nameWithOwner)
      ),
    },
    ...(repoView.repository ? { repository: repoView.repository } : {}),
    repoDiscoveryCommandArgs,
    repoDiscoveryCwd,
    repoDiscoveryFields: {
      repo: "nameWithOwner",
      ref: "defaultBranchRef.name",
    },
    gh: {
      auth: commandRef(authCommandArgs, auth.exitCode ?? 1),
      repo: commandRef(repoCommandArgs, repoView.exitCode),
      workflow: commandRef(workflowCommandArgs, workflowView.exitCode),
      secrets: commandRef(secretsCommandArgs, secretsList.exitCode),
    },
    gates: {
      bundleDirOk: local.bundleDir.exists,
      localWorkflowOk: local.workflow.exists,
      externalSecretsOk: externalSecrets.ok,
      stagingCiOk: local.stagingCi.exists,
      ...(ghCliOk ? {} : { ghCliOk: false }),
      ghAuthOk: auth.exitCode === 0,
      repoOk: repoView.exitCode === 0,
      workflowVisible: workflowView.exitCode === 0,
      githubSecretsListOk: externalSecrets.requiredEnvNames.length === 0 || secretsList.exitCode === 0,
      requiredSecretsPresent: externalSecrets.requiredEnvNames.length === 0 || secretsList.missingRequiredEnvNames.length === 0,
      ...(workflowInstall ? { localWorkflowInstallOk: workflowInstall.installed.matchesBundle } : {}),
    },
  });
}

function repoViewCommandArgs(ghBin: string, repo: string | undefined): string[] {
  return [
    ghBin,
    "repo",
    "view",
    ...(repo ? [repo] : []),
    "--json",
    PLATFORM_CI_HANDOFF_PREFLIGHT_REPO_FIELDS,
  ];
}

function repoTargetDiscoveryCommandArgs(ghBin: string, repo: string | undefined): string[] {
  return [
    ghBin,
    "repo",
    "view",
    ...(repo ? [repo] : []),
    "--json",
    "nameWithOwner,defaultBranchRef",
  ];
}

function workflowViewCommandArgs(
  ghBin: string,
  workflow: string,
  repo: string | undefined,
  ref: string | undefined,
): string[] {
  return [
    ghBin,
    "workflow",
    "view",
    workflow,
    ...(repo ? ["--repo", repo] : []),
    ...(ref ? ["--ref", ref] : []),
  ];
}

function secretsListCommandArgs(ghBin: string, repo: string | undefined): string[] {
  return [
    ghBin,
    "secret",
    "list",
    "--app",
    "actions",
    ...(repo ? ["--repo", repo] : []),
    "--json",
    "name",
  ];
}

function secretSetCommandArgs(ghBin: string, name: string, repo: string | undefined): string[] {
  return [
    ghBin,
    "secret",
    "set",
    name,
    "--app",
    "actions",
    ...(repo ? ["--repo", repo] : []),
  ];
}

async function runRepoView(
  commandArgs: string[],
  cwd: string | undefined,
): Promise<{ exitCode?: number; repository?: PlatformCiHandoffPreflightResult["repository"] }> {
  const result = await execa(commandArgs[0] ?? "gh", commandArgs.slice(1), { reject: false, ...(cwd ? { cwd } : {}) });
  const exitCode = result.exitCode ?? 1;
  if (exitCode !== 0) return { exitCode };
  try {
    const value = JSON.parse(result.stdout) as unknown;
    const record = objectRecord(value);
    const defaultBranchRef = objectRecord(record?.defaultBranchRef);
    return {
      exitCode,
      repository: {
        ...(stringValue(record?.nameWithOwner) ? { nameWithOwner: stringValue(record?.nameWithOwner) } : {}),
        ...(stringValue(record?.url) ? { url: stringValue(record?.url) } : {}),
        ...(stringValue(record?.viewerPermission) ? { viewerPermission: stringValue(record?.viewerPermission) } : {}),
        ...(stringValue(defaultBranchRef?.name) ? { defaultBranch: stringValue(defaultBranchRef?.name) } : {}),
      },
    };
  } catch {
    return { exitCode: 1 };
  }
}

async function runSecretsList(
  commandArgs: string[],
  requiredEnvNames: string[],
  cwd: string | undefined,
): Promise<{ exitCode?: number; presentRequiredEnvNames: string[]; missingRequiredEnvNames: string[] }> {
  const result = await execa(commandArgs[0] ?? "gh", commandArgs.slice(1), { reject: false, ...(cwd ? { cwd } : {}) });
  const exitCode = result.exitCode ?? 1;
  if (exitCode !== 0) return { exitCode, presentRequiredEnvNames: [], missingRequiredEnvNames: requiredEnvNames };
  try {
    const listedNames = new Set(JSON.parse(result.stdout)
      .filter((item: unknown) => typeof objectRecord(item)?.name === "string")
      .map((item: unknown) => objectRecord(item)?.name as string));
    const presentRequiredEnvNames = requiredEnvNames.filter((name) => listedNames.has(name));
    const missingRequiredEnvNames = requiredEnvNames.filter((name) => !listedNames.has(name));
    return {
      exitCode,
      presentRequiredEnvNames,
      missingRequiredEnvNames,
    };
  } catch {
    return { exitCode: 1, presentRequiredEnvNames: [], missingRequiredEnvNames: requiredEnvNames };
  }
}

function preflightResult(
  value: Omit<PlatformCiHandoffPreflightResult, "schemaVersion" | "ok" | "tokenFree" | "provider" | "missing" | "nextActions">,
): PlatformCiHandoffPreflightResult {
  const ghCliMissing = value.gates.ghCliOk === false;
  const missing = [
    ...(value.gates.bundleDirOk ? [] : ["bundle.dir"]),
    ...(value.gates.localWorkflowOk ? [] : ["bundle.githubActionsWorkflow"]),
    ...(value.gates.externalSecretsOk ? [] : ["bundle.externalSecrets"]),
    ...(value.gates.stagingCiOk ? [] : ["bundle.stagingCi"]),
    ...(ghCliMissing ? ["github.cli"] : []),
    ...(ghCliMissing || value.gates.ghAuthOk ? [] : ["github.auth"]),
    ...(ghCliMissing || value.gates.repoOk ? [] : ["github.repository"]),
    ...(ghCliMissing || value.gates.workflowVisible ? [] : ["github.workflow"]),
    ...(ghCliMissing || value.gates.githubSecretsListOk ? [] : ["github.secrets"]),
    ...(ghCliMissing || value.gates.requiredSecretsPresent ? [] : ["github.secrets.requiredEnv"]),
    ...(value.gates.localWorkflowInstallOk === false ? ["local.workflowInstall"] : []),
  ];
  return {
    schemaVersion: "platform-ci-handoff-preflight/v1",
    ok: Object.values(value.gates).every(Boolean),
    tokenFree: true,
    provider: "github-actions",
    ...value,
    missing,
    nextActions: preflightNextActions(value, missing),
  };
}

function preflightNextActions(
  value: Omit<PlatformCiHandoffPreflightResult, "schemaVersion" | "ok" | "tokenFree" | "provider" | "missing" | "nextActions">,
  missing: string[],
): string[] {
  const actions: string[] = [];
  if (missing.includes("bundle.dir")) {
    actions.push(`Create or select the cutover bundle directory ${value.dir}, then rerun platform-ci-handoff-preflight.`);
  }
  if (missing.includes("bundle.githubActionsWorkflow")) {
    actions.push(`Regenerate the cutover bundle so ${value.local.workflow.path} exists, then rerun platform-ci-handoff-preflight.`);
  }
  if (missing.includes("bundle.stagingCi")) {
    actions.push(`Regenerate the cutover bundle so ${value.local.stagingCi.path} exists, then rerun platform-ci-handoff-preflight.`);
  }
  if (missing.includes("bundle.externalSecrets")) {
    actions.push(`Regenerate the cutover bundle so ${value.local.externalSecrets.path} is a token-free platform-external-secrets/v1 manifest, then rerun platform-ci-handoff-preflight.`);
  }
  if (missing.includes("local.workflowInstall") && value.workflowInstall) {
    actions.push(`Install workflow: ${shellCommand(value.workflowInstall.installCommandArgs)}`);
  }
  if (missing.includes("github.cli")) {
    actions.push(`Install GitHub CLI or pass --gh-bin ${shellQuote(value.gh.auth.commandArgs[0] ?? "gh")}, then rerun platform-ci-handoff-preflight.`);
  }
  if (missing.includes("github.auth")) {
    actions.push("Run gh auth login or refresh GitHub CLI credentials, then rerun platform-ci-handoff-preflight.");
  }
  if (missing.includes("github.repository")) {
    actions.push(repoDiscoveryNextAction(value));
  }
  if (missing.includes("github.workflow")) {
    const destination = preflightWorkflowDestination(value);
    actions.push(preflightWorkflowPublishAction(value, destination));
  }
  if (missing.includes("github.secrets")) {
    actions.push("Confirm GitHub Actions repository secrets can be listed with gh secret list --app actions, then rerun platform-ci-handoff-preflight.");
  }
  if (missing.includes("github.secrets.requiredEnv") && value.secrets.missingRequiredEnvNames.length) {
    actions.push(`Run secrets plan: ${shellCommand(secretsPlanCommandArgs(value))}; run its secretSetShellCommands, then rerun platform-ci-handoff-preflight.`);
  }
  return actions;
}

function repoDiscoveryNextAction(
  value: Omit<PlatformCiHandoffPreflightResult, "schemaVersion" | "ok" | "tokenFree" | "provider" | "missing" | "nextActions">,
): string {
  if (value.repo) {
    return `Confirm GitHub repository access with ${shellCommand(value.repoDiscoveryCommandArgs)} from repoDiscoveryCwd, then rerun platform-ci-handoff-preflight.`;
  }
  return "Run repoDiscoveryCommandArgs from repoDiscoveryCwd, then rerun platform-ci-handoff-preflight with --repo <nameWithOwner> and --ref <defaultBranchRef.name>.";
}

function secretsPlanCommandArgs(
  value: Omit<PlatformCiHandoffPreflightResult, "schemaVersion" | "ok" | "tokenFree" | "provider" | "missing" | "nextActions">,
): string[] {
  const repo = value.repo ?? value.repository?.nameWithOwner;
  return [
    preflightLoomCommand(value.dir),
    "harness",
    "platform-ci-secrets-plan",
    "--dir",
    value.dir,
    ...(repo ? ["--repo", repo] : []),
    "--report",
    join(value.dir, "reports", "ci-secrets-plan.json"),
  ];
}

function preflightWorkflowDestination(
  value: Omit<PlatformCiHandoffPreflightResult, "schemaVersion" | "ok" | "tokenFree" | "provider" | "missing" | "nextActions">,
): string {
  const repo = value.repo ?? value.repository?.nameWithOwner;
  const ref = value.ref ?? value.repository?.defaultBranch;
  if (repo && ref) return `${repo} ${ref}`;
  if (repo) return repo;
  if (ref) return ref;
  return "the target repository branch";
}

function preflightWorkflowPublishAction(
  value: Omit<PlatformCiHandoffPreflightResult, "schemaVersion" | "ok" | "tokenFree" | "provider" | "missing" | "nextActions">,
  _destination: string,
): string {
  return `Run workflow publish plan: ${shellCommand(workflowPublishPlanCommandArgs(value))}; run its git publish commands, then rerun platform-ci-handoff-preflight.`;
}

function workflowPublishPlanCommandArgs(
  value: Omit<PlatformCiHandoffPreflightResult, "schemaVersion" | "ok" | "tokenFree" | "provider" | "missing" | "nextActions">,
): string[] {
  const repo = value.repo ?? value.repository?.nameWithOwner;
  const ref = value.ref ?? value.repository?.defaultBranch;
  const repoRoot = value.workflowInstall?.repoRoot ?? dirname(value.dir);
  return [
    preflightLoomCommand(value.dir),
    "harness",
    "platform-ci-workflow-publish-plan",
    "--dir",
    value.dir,
    "--repo-root",
    repoRoot,
    ...(repo ? ["--repo", repo] : []),
    ...(ref ? ["--ref", ref] : []),
    "--report",
    join(value.dir, "reports", "ci-workflow-publish-plan.json"),
  ];
}

function preflightLoomCommand(dir: string): string {
  const explicit = process.env.LOOM_BIN?.trim();
  if (explicit) return explicit;
  const wrapperPath = join(dir, "loom-wrapper");
  return executableFile(wrapperPath) ? wrapperPath : "loom";
}

function executableCommand(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) return executableFile(resolve(command));
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => executableFile(join(dir, command)));
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function shellCommand(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function commandRef(commandArgs: string[], exitCode?: number): PlatformCiHandoffPreflightCommandRef {
  return {
    commandArgs,
    ...(exitCode !== undefined ? { exitCode } : {}),
    succeeded: exitCode === 0,
  };
}

function localRef(path: string): PlatformCiHandoffPreflightLocalRef {
  return {
    path,
    exists: existsSync(path),
  };
}

function localWorkflowInstall(
  dir: string,
  repoRoot: string,
  workflow: string,
): NonNullable<PlatformCiHandoffPreflightResult["workflowInstall"]> {
  const source = localTextRef(join(dir, workflow));
  const installed = localTextRef(join(repoRoot, ".github", "workflows", workflow));
  return {
    repoRoot,
    destinationPath: `.github/workflows/${workflow}`,
    installed: {
      path: installed.path,
      exists: installed.exists,
      ...(installed.sha256 ? { sha256: installed.sha256 } : {}),
      matchesBundle: source.sha256 !== undefined && installed.sha256 === source.sha256,
    },
    installCommandArgs: [
      preflightLoomCommand(dir),
      "harness",
      "platform-ci-handoff-install",
      "--dir",
      dir,
      "--repo-root",
      repoRoot,
      "--report",
      join(dir, "reports", "ci-handoff-install.json"),
    ],
  };
}

function localTextRef(path: string): PlatformCiHandoffPreflightLocalRef & { sha256?: string } {
  if (!existsSync(path)) return { path, exists: false };
  const text = readFileSync(path, "utf8");
  return {
    path,
    exists: true,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

function platformCiTargetInputTemplate(): PlatformCiTargetInputTemplate {
  return {
    schemaVersion: "platform-ci-target-input/v1",
    repo: "<owner/repo>",
    ref: "<branch>",
  };
}

function readCiTargetInput(path: string): { path: string; sha256: string; repo?: string; ref?: string } {
  const text = readFileSync(path, "utf8");
  const value = JSON.parse(text) as unknown;
  const record = objectRecord(value);
  if (record?.schemaVersion !== "platform-ci-target-input/v1") {
    throw new Error(`Invalid GitHub Actions target input ${path}: expected schemaVersion platform-ci-target-input/v1`);
  }
  const repo = stringValue(record.repo);
  const ref = stringValue(record.ref);
  if (!repo && !ref) {
    throw new Error(`Invalid GitHub Actions target input ${path}: expected repo or ref`);
  }
  return {
    path,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    ...(repo ? { repo } : {}),
    ...(ref ? { ref } : {}),
  };
}

function readExternalSecrets(path: string): { ok: boolean; requiredEnvNames: string[] } {
  if (!existsSync(path)) return { ok: false, requiredEnvNames: [] };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const record = objectRecord(value);
    if (record?.schemaVersion !== "platform-external-secrets/v1" || record.tokenFree !== true || !Array.isArray(record.requiredEnv)) {
      return { ok: false, requiredEnvNames: [] };
    }
    return {
      ok: true,
      requiredEnvNames: Array.from(new Set(record.requiredEnv
        .map((item) => stringValue(objectRecord(item)?.name))
        .filter((name): name is string => name !== undefined)))
        .sort(),
    };
  } catch {
    return { ok: false, requiredEnvNames: [] };
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
