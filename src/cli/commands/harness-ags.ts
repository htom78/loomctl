import { type AgentGitServiceContractComparisonResult, type AgentGitServiceContractProbeResult, compareAgentGitServiceContractReports, probeAgentGitServiceContract } from "../../harness/agent-git-service-contract-probe.js";
import { startAgentGitServiceContractServer } from "../../harness/agent-git-service-contract-server.js";
import { agentGitServiceGitRemoteUrl, agentGitServiceIssueUrl, createAgentGitServiceIssueComment, createAgentGitServiceIssueWorkspaceAttachment, listAgentGitServiceIssueComments, listAgentGitServiceIssueWorkspaces, parseAgentGitServiceIssueRef, parseAgentGitServiceRepoRef, readAgentGitServiceWikiMemory, updateAgentGitServiceWikiMemory } from "../../harness/agent-git-service.js";
import { createUpstreamAgentGitServiceServerEnvPlan, type UpstreamAgentGitServiceServerEnvPlanCliOptions } from "../../harness/upstream-agent-git-service-server-env-plan.js";
import { cliTokenValue, collect, compactObject, controlPlanePreflightBaseUrl, controlPlanePreflightDiscoveryEndpointUrl, controlPlanePreflightTokenEnv, DEFAULT_AGENT_GIT_SERVICE_TOKEN_ENV, isEnvName, isRecord, normalizeHttpBaseUrl, parseEnvNameFlag, parseSafeNameFlag, preflightErrorMessage, stringsOnly, writeJsonReportIfRequested } from "../lib/flags.js";

import { smokeJson } from "../lib/smoke.js";
import { Command } from "commander";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export function registerHarnessAgentGitServiceProvisioningCommands(harness: Command): void {
harness
  .command("provision-agent-git-service")
  .description("call the harness admin API to provision an agent-git-service project agent")
  .option("--url <url>", "harness server base URL", "http://127.0.0.1:8787")
  .requiredOption("--tenant <tenant>", "tenant that owns the project")
  .requiredOption("--project <project>", "project to provision")
  .requiredOption("--repo <owner/repo>", "agent-git-service repository to grant")
  .option("--admin-token <token>", "tenant admin API token; prefer --admin-token-env for shared shells")
  .option("--admin-token-env <name>", "env var containing the tenant admin API token")
  .option("--permission <permission>", "repo permission: read|write|admin")
  .option("--agent-prefix-login <name>", "agent login prefix sent to AGS")
  .option("--default-repo-name <name>", "default AGS workspace repository name")
  .option("--token-env-name <name>", "non-secret env name where operators will store the returned agent token")
  .option("--identity-actor <actor>", "tenant actor to map the new AGS agent login to")
  .option("--identity-role <role>", "tenant role for the mapped AGS agent login: viewer|developer|admin")
  .option("--store-agent-token", "ask the harness server to store the generated agent token in its configured secret root", false)
  .option("--force", "re-provision even when a receipt already exists", false)
  .option("--client-id <id>", "client id for audit evidence", "cli")
  .action(async (opts: HarnessAgentGitServiceProvisionCliOptions) => {
    try {
      const result = await provisionAgentGitServiceProjectAgentViaHarness(opts);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
harness
  .command("agent-git-service-provisioning-plan")
  .description("read the tenant agent-git-service provisioning plan from the harness admin API")
  .option("--url <url>", "harness server base URL", "http://127.0.0.1:8787")
  .requiredOption("--tenant <tenant>", "tenant to inspect")
  .option("--admin-token <token>", "tenant admin API token; prefer --admin-token-env for shared shells")
  .option("--admin-token-env <name>", "env var containing the tenant admin API token")
  .action(async (opts: HarnessAgentGitServiceProvisioningPlanCliOptions) => {
    try {
      const result = await readAgentGitServiceProvisioningPlanViaHarness(opts);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
harness
  .command("apply-agent-git-service-provisioning-plan")
  .description("apply the tenant agent-git-service provisioning plan through the harness admin API")
  .option("--url <url>", "harness server base URL", "http://127.0.0.1:8787")
  .requiredOption("--tenant <tenant>", "tenant to apply")
  .option("--admin-token <token>", "tenant admin API token; prefer --admin-token-env for shared shells")
  .option("--admin-token-env <name>", "env var containing the tenant admin API token")
  .option("--projects <projects>", "comma-separated project names to apply; defaults to every eligible project")
  .option("--eligible-only", "send only plan-eligible projects instead of including ready/skipped projects in the result", false)
  .option("--dry-run", "show projects that would be provisioned without calling AGS", false)
  .option("--client-id <id>", "client id for audit evidence", "cli")
  .action(async (opts: HarnessAgentGitServiceProvisioningPlanApplyCliOptions) => {
    try {
      const result = await applyAgentGitServiceProvisioningPlanViaHarness(opts);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
}

export function registerHarnessAgentGitServiceCompatCommands(harness: Command): void {
harness
  .command("agent-git-service-compat-compare")
  .description("compare two token-free agent-git-service compatibility reports")
  .requiredOption("--baseline <path>", "baseline AGS compatibility report, usually from the contract fixture")
  .requiredOption("--candidate <path>", "candidate AGS compatibility report, usually from an upstream AGS preflight")
  .option("--report <path>", "write the token-free comparison JSON to this path")
  .action(async (opts: HarnessAgentGitServiceCompatCompareCliOptions) => {
    const result = await runHarnessAgentGitServiceCompatCompare(opts);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  });
harness
  .command("agent-git-service-compat-rehearsal")
  .description("generate token-free AGS contract baseline, candidate, and comparison artifacts")
  .option("--candidate-url <url>", "upstream AGS API base URL; omitted reuses the local contract fixture as candidate")
  .option("--candidate-token-env <name>", "env var containing the upstream AGS token", DEFAULT_AGENT_GIT_SERVICE_TOKEN_ENV)
  .option("--out <dir>", "directory for token-free compatibility artifacts", ".loom/agent-git-service-compat")
  .option("--host <host>", "local contract fixture listen host", "127.0.0.1")
  .action(async (opts: HarnessAgentGitServiceCompatRehearsalCliOptions) => {
    const result = await runHarnessAgentGitServiceCompatRehearsal(opts);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  });
harness
  .command("agent-git-service-staging-readiness")
  .description("probe read-only AGS staging surfaces before operator cutover")
  .option("--control-plane-url <url>", "agent-git-service base URL; defaults to LOOM_AGENT_GIT_SERVICE_URL")
  .option("--control-plane-token-env <name>", "env var containing the AGS token", DEFAULT_AGENT_GIT_SERVICE_TOKEN_ENV)
  .option("--issue <owner/repo#number>", "AGS staging issue used for workspace/comment readiness", DEFAULT_AGENT_GIT_SERVICE_STAGING_ISSUE)
  .option("--repo <owner/repo>", "AGS repo used for wiki/git URL readiness; defaults to the issue repo")
  .option("--wiki-page <page>", "AGS wiki memory page to read", "vas/learnings")
  .option("--report <path>", "write the token-free AGS staging readiness JSON to this path")
  .action(async (opts: HarnessAgentGitServiceStagingReadinessCliOptions) => {
    const result = await runHarnessAgentGitServiceStagingReadiness(opts);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  });
harness
  .command("agent-git-service-native-write-check")
  .description("verify approved AGS native write surfaces and write a token-free report")
  .option("--control-plane-url <url>", "agent-git-service base URL; defaults to LOOM_AGENT_GIT_SERVICE_URL")
  .option("--control-plane-token-env <name>", "env var containing the AGS token", DEFAULT_AGENT_GIT_SERVICE_TOKEN_ENV)
  .option("--issue <owner/repo#number>", "AGS staging issue used for the issue comment and workspace attachment", DEFAULT_AGENT_GIT_SERVICE_STAGING_ISSUE)
  .option("--repo <owner/repo>", "AGS repo used for wiki memory; defaults to the issue repo")
  .option("--workspace-id <id>", "AGS issue workspace id; omitted uses the first listed workspace")
  .option("--attachment-url <url>", "public handoff or evidence URL to attach to the AGS issue workspace")
  .option("--wiki-page <page>", "AGS wiki memory page to update", "vas/learnings")
  .option("--wiki-note <text>", "short staging note appended to wiki memory", "loom AGS native write check")
  .option("--approve-mutating", "required acknowledgement that this command writes to AGS")
  .option("--report <path>", "write the token-free AGS native write JSON to this path")
  .action(async (opts: HarnessAgentGitServiceNativeWriteCheckCliOptions) => {
    const result = await runHarnessAgentGitServiceNativeWriteCheck(opts);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  });
harness
  .command("upstream-agent-git-service-handoff")
  .description("write a token-free upstream AGS operator handoff readiness report")
  .requiredOption("--dir <dir>", "operator bundle directory")
  .option("--plan <path>", "platform-cutover-plan JSON file; defaults to <dir>/plan.json")
  .option("--forbid <value>", "secret or forbidden value that must not appear in upstream handoff files; repeatable", collect, [] as string[])
  .option("--forbid-env <name>", "env var whose value must not appear in upstream handoff files; repeatable", collect, [] as string[])
  .option("--report <path>", "write the token-free upstream AGS handoff JSON to this path")
  .action((opts: HarnessUpstreamAgentGitServiceHandoffCliOptions) => {
    try {
      const result = writeHarnessUpstreamAgentGitServiceHandoff(opts);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
harness
  .command("upstream-agent-git-service-server-env-plan")
  .description("emit token-free commands for upstream AGS server env setup")
  .requiredOption("--dir <dir>", "operator bundle directory")
  .option("--report <path>", "write the token-free upstream AGS server env plan to a JSON file")
  .action(async (opts: UpstreamAgentGitServiceServerEnvPlanCliOptions) => {
    try {
      const result = createUpstreamAgentGitServiceServerEnvPlan(opts);
      await writeJsonReportIfRequested(opts.report, result);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
}

export const DEFAULT_AGENT_GIT_SERVICE_STAGING_ISSUE = "team/loom-smoke#17";

export interface HarnessAgentGitServiceCompatCompareCliOptions {
  baseline: string;
  candidate: string;
  report?: string;
}

export interface HarnessAgentGitServiceCompatRehearsalCliOptions {
  candidateUrl?: string;
  candidateTokenEnv: string;
  out: string;
  host: string;
}

export interface HarnessAgentGitServiceStagingReadinessCliOptions {
  controlPlaneUrl?: string;
  controlPlaneTokenEnv?: string;
  issue: string;
  repo?: string;
  wikiPage: string;
  report?: string;
}

export interface HarnessAgentGitServiceNativeWriteCheckCliOptions {
  controlPlaneUrl?: string;
  controlPlaneTokenEnv?: string;
  issue: string;
  repo?: string;
  workspaceId?: string;
  attachmentUrl?: string;
  wikiPage: string;
  wikiNote: string;
  approveMutating?: boolean;
  report?: string;
}

export type HarnessAgentGitServiceCompatCompareResult = AgentGitServiceContractComparisonResult & {
  reportPath?: string;
};

export interface HarnessAgentGitServiceCompatRehearsalResult {
  schemaVersion: "agent-git-service-compat-rehearsal/v1";
  ok: boolean;
  tokenFree: true;
  candidateMode: "contract" | "upstream";
  outDir: string;
  baselineReportPath: string;
  candidateReportPath: string;
  comparisonReportPath: string;
  manifestPath: string;
  comparison: AgentGitServiceContractComparisonResult;
}

export interface HarnessAgentGitServiceCompatRehearsalManifest {
  schemaVersion: "agent-git-service-compat-rehearsal/v1";
  tokenFree: true;
  generatedAt: string;
  candidateMode: "contract" | "upstream";
  artifacts: {
    baseline: string;
    candidate: string;
    comparison: string;
  };
  artifactSha256: {
    baseline: string;
    candidate: string;
    comparison: string;
  };
  comparisonOk: boolean;
  baselineBaseUrl: string;
  candidateBaseUrl: string;
}

export interface HarnessAgentGitServiceStagingReadinessResult {
  schemaVersion: "agent-git-service-staging-readiness/v1";
  ok: boolean;
  tokenFree: true;
  provider: "agent-git-service";
  reportPath?: string;
  baseUrl?: string;
  tokenEnv: string;
  issue: string;
  repo: string;
  issueUrl?: string;
  gitRemoteUrl?: string;
  serverReadiness: HarnessAgentGitServiceServerReadiness;
  discovery?: AgentGitServiceContractProbeResult;
  issueWorkspaces: HarnessAgentGitServiceReadinessCollection;
  issueComments: HarnessAgentGitServiceReadinessCollection;
  wikiMemory: HarnessAgentGitServiceReadinessWikiMemory;
  gates: {
    token: boolean;
    serverReadiness: boolean;
    discovery: boolean;
    issueWorkspaces: boolean;
    issueComments: boolean;
    wikiMemory: boolean;
  };
  missing: string[];
}

export interface HarnessAgentGitServiceNativeWriteCheckResult {
  schemaVersion: "agent-git-service-native-write-check/v1";
  ok: boolean;
  tokenFree: true;
  provider: "agent-git-service";
  reportPath?: string;
  baseUrl?: string;
  tokenEnv: string;
  issue: string;
  repo: string;
  attachmentUrl?: string;
  wikiPage: string;
  approved: boolean;
  issueComment: HarnessAgentGitServiceWriteCheck;
  workspaceAttachment: HarnessAgentGitServiceWorkspaceAttachmentCheck;
  wikiMemory: HarnessAgentGitServiceWikiMemoryWriteCheck;
  gates: {
    token: boolean;
    approved: boolean;
    issueComment: boolean;
    workspaceAttachment: boolean;
    wikiMemory: boolean;
  };
  missing: string[];
}

export interface HarnessAgentGitServiceReadinessCollection {
  ok: boolean;
  count: number;
  ids: string[];
  error?: string;
}

export interface HarnessAgentGitServiceReadinessWikiMemory {
  ok: boolean;
  page: string;
  bodyBytes?: number;
  sha?: string;
  error?: string;
}

export interface HarnessAgentGitServiceServerReadiness {
  ok: boolean;
  url?: string;
  httpStatus?: number;
  status?: string;
  version?: string;
  checkNames: string[];
  error?: string;
}

export interface HarnessAgentGitServiceWriteCheck {
  ok: boolean;
  error?: string;
}

export interface HarnessAgentGitServiceWorkspaceAttachmentCheck extends HarnessAgentGitServiceWriteCheck {
  workspaceId?: string;
  attachmentId?: string;
  url?: string;
}

export interface HarnessAgentGitServiceWikiMemoryWriteCheck extends HarnessAgentGitServiceWriteCheck {
  page: string;
  bodyBytes?: number;
  sha?: string;
  noteSha256?: string;
}

export interface HarnessPlatformCutoverEnvironmentVariable {
  name: string;
  requiredFor: string[];
  uses: HarnessPlatformCutoverEnvironmentVariableUse[];
}

export interface HarnessPlatformCutoverEnvironmentVariableUse {
  sourceFlag: string;
  purpose: string;
  tenant?: string;
  actor?: string;
  role?: "admin" | "developer" | "viewer";
}

export interface HarnessPlatformCutoverPlanStage {
  id: string;
  command: string;
  commandArgs?: string[];
  executionMode: "read-only" | "long-running" | "dry-run" | "mutating" | "verification";
  approvalRequired: boolean;
  tokenFree: boolean;
  requires?: string[];
  operatorGate?: {
    id: string;
    evidence: string;
  };
}

export interface HarnessUpstreamAgentGitServiceHandoffCliOptions {
  dir: string;
  plan?: string;
  forbid?: string[];
  forbidEnv?: string[];
  report?: string;
}

export interface HarnessUpstreamAgentGitServiceOperatorChecklistItem {
  id: string;
  phase: "upstream-server" | "loom-env" | "pre-serve" | "serve" | "post-serve";
  action?: string;
  command?: string;
  requiresEnv?: string[];
  evidence: string;
}

export interface HarnessUpstreamAgentGitServiceHandoffResult {
  schemaVersion: "upstream-agent-git-service-handoff/v1";
  ok: boolean;
  tokenFree: true;
  dir: string;
  planPath: string;
  reportPath?: string;
  guidePath: string;
  guideSha256?: string;
  handoffMismatches: string[];
  requiredServerEnv: Array<{ name: string; present: boolean }>;
  requiredLoomEnv: Array<{ name: string; present: boolean }>;
  operatorChecklist: Array<{
    id: string;
    phase: string;
    ready: boolean;
    evidence: string;
  }>;
  gates: {
    guideOk: boolean;
    requiredServerEnvOk: boolean;
    requiredLoomEnvOk: boolean;
    operatorChecklistOk: boolean;
    secretScanOk: boolean;
  };
  forbiddenValueHitFiles: string[];
  missing: string[];
  nextActions: string[];
}

export interface HarnessAgentGitServiceProvisionCliOptions {
  url: string;
  tenant: string;
  project: string;
  repo: string;
  adminToken?: string;
  adminTokenEnv?: string;
  permission?: string;
  agentPrefixLogin?: string;
  defaultRepoName?: string;
  tokenEnvName?: string;
  identityActor?: string;
  identityRole?: string;
  storeAgentToken?: boolean;
  force?: boolean;
  clientId?: string;
}

export interface HarnessAgentGitServiceProvisioningPlanCliOptions {
  url: string;
  tenant: string;
  adminToken?: string;
  adminTokenEnv?: string;
}

export interface HarnessAgentGitServiceProvisioningPlanApplyCliOptions {
  url: string;
  tenant: string;
  adminToken?: string;
  adminTokenEnv?: string;
  projects?: string;
  eligibleOnly?: boolean;
  dryRun?: boolean;
  clientId?: string;
}

export async function runHarnessAgentGitServiceCompatCompare(
  options: HarnessAgentGitServiceCompatCompareCliOptions,
): Promise<HarnessAgentGitServiceCompatCompareResult> {
  const comparison = compareAgentGitServiceContractReports({
    baseline: readAgentGitServiceContractProbeReport(options.baseline, "baseline"),
    candidate: readAgentGitServiceContractProbeReport(options.candidate, "candidate"),
  });
  const result: HarnessAgentGitServiceCompatCompareResult = {
    ...comparison,
    ...(options.report ? { reportPath: resolve(options.report) } : {}),
  };
  if (options.report) {
    const reportPath = resolve(options.report);
    mkdirSync(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}

export async function runHarnessAgentGitServiceCompatRehearsal(
  options: HarnessAgentGitServiceCompatRehearsalCliOptions,
): Promise<HarnessAgentGitServiceCompatRehearsalResult> {
  const outDir = resolve(options.out);
  const baselineReportPath = join(outDir, "baseline.json");
  const candidateReportPath = join(outDir, "candidate.json");
  const comparisonReportPath = join(outDir, "compare.json");
  const manifestPath = join(outDir, "manifest.json");
  const candidateMode: "contract" | "upstream" = options.candidateUrl?.trim() ? "upstream" : "contract";
  const contract = await startAgentGitServiceContractServer({ host: options.host });
  try {
    const baseline = await probeAgentGitServiceContract({
      baseUrl: contract.baseUrl,
      token: "contract-rehearsal-token",
    });
    const candidate = candidateMode === "upstream"
      ? await probeAgentGitServiceContract({
          baseUrl: normalizeHttpBaseUrl(options.candidateUrl as string, "--candidate-url"),
          token: agentGitServiceCompatRehearsalCandidateToken(options),
        })
      : await probeAgentGitServiceContract({
          baseUrl: contract.baseUrl,
          token: "contract-rehearsal-token",
    });
    const comparison = compareAgentGitServiceContractReports({ baseline, candidate });
    const baselineReportText = `${JSON.stringify(baseline, null, 2)}\n`;
    const candidateReportText = `${JSON.stringify(candidate, null, 2)}\n`;
    const comparisonReportText = `${JSON.stringify(comparison, null, 2)}\n`;
    const manifest: HarnessAgentGitServiceCompatRehearsalManifest = {
      schemaVersion: "agent-git-service-compat-rehearsal/v1",
      tokenFree: true,
      generatedAt: new Date().toISOString(),
      candidateMode,
      artifacts: {
        baseline: "baseline.json",
        candidate: "candidate.json",
        comparison: "compare.json",
      },
      artifactSha256: {
        baseline: sha256Hex(baselineReportText),
        candidate: sha256Hex(candidateReportText),
        comparison: sha256Hex(comparisonReportText),
      },
      comparisonOk: comparison.ok,
      baselineBaseUrl: baseline.baseUrl,
      candidateBaseUrl: candidate.baseUrl,
    };
    mkdirSync(outDir, { recursive: true });
    await writeFile(baselineReportPath, baselineReportText, "utf8");
    await writeFile(candidateReportPath, candidateReportText, "utf8");
    await writeFile(comparisonReportPath, comparisonReportText, "utf8");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return {
      schemaVersion: "agent-git-service-compat-rehearsal/v1",
      ok: comparison.ok,
      tokenFree: true,
      candidateMode,
      outDir,
      baselineReportPath,
      candidateReportPath,
      comparisonReportPath,
      manifestPath,
      comparison,
    };
  } finally {
    await contract.close();
  }
}

export async function runHarnessAgentGitServiceStagingReadiness(
  options: HarnessAgentGitServiceStagingReadinessCliOptions,
): Promise<HarnessAgentGitServiceStagingReadinessResult> {
  const baseUrl = controlPlanePreflightBaseUrl({
    controlPlaneProvider: "agent-git-service",
    controlPlaneUrl: options.controlPlaneUrl,
    controlPlaneTokenEnv: options.controlPlaneTokenEnv,
  }, "agent-git-service");
  const tokenEnv = controlPlanePreflightTokenEnv({
    controlPlaneProvider: "agent-git-service",
    controlPlaneUrl: options.controlPlaneUrl,
    controlPlaneTokenEnv: options.controlPlaneTokenEnv,
  }, "agent-git-service");
  const token = process.env[tokenEnv];
  const issue = parseAgentGitServiceStagingIssueFlag(options.issue);
  const repo = parseAgentGitServiceStagingRepoFlag(
    options.repo ?? `${issue.owner}/${issue.repo}`,
    "--repo",
  );
  const issueRef = `${issue.owner}/${issue.repo}#${issue.index}`;
  const repoRef = `${repo.owner}/${repo.repo}`;
  const wikiPage = parseAgentGitServiceWikiPageFlag(options.wikiPage);
  const missing = [
    baseUrl ? undefined : "control-plane-url",
    token ? undefined : "control-plane-token",
  ].filter((item): item is string => Boolean(item));

  let discovery: AgentGitServiceContractProbeResult | undefined;
  let issueWorkspaces: HarnessAgentGitServiceReadinessCollection = { ok: false, count: 0, ids: [] };
  let issueComments: HarnessAgentGitServiceReadinessCollection = { ok: false, count: 0, ids: [] };
  let wikiMemory: HarnessAgentGitServiceReadinessWikiMemory = { ok: false, page: wikiPage };
  let serverReadiness: HarnessAgentGitServiceServerReadiness = { ok: false, checkNames: [] };
  let issueUrl: string | undefined;
  let gitRemoteUrl: string | undefined;

  if (baseUrl) {
    issueUrl = agentGitServiceIssueUrl(baseUrl, issueRef);
    gitRemoteUrl = agentGitServiceGitRemoteUrl(baseUrl, repoRef);
    serverReadiness = await readAgentGitServiceServerReadiness(baseUrl);
    if (!serverReadiness.ok) missing.push("agent-git-service-server-readiness");
  }

  if (baseUrl && token) {
    discovery = await probeAgentGitServiceContract({ baseUrl, token });
    if (!discovery.ok) missing.push("agent-git-service-discovery");

    const [workspaces, comments, memory] = await Promise.all([
      readAgentGitServiceStagingIssueWorkspaces(baseUrl, token, issueRef),
      readAgentGitServiceStagingIssueComments(baseUrl, token, issueRef),
      readAgentGitServiceStagingWikiMemory(baseUrl, token, repoRef, wikiPage),
    ]);
    issueWorkspaces = workspaces;
    issueComments = comments;
    wikiMemory = memory;
    if (!issueWorkspaces.ok) missing.push("agent-git-service-issue-workspaces");
    if (!issueComments.ok) missing.push("agent-git-service-issue-comments");
    if (!wikiMemory.ok) missing.push("agent-git-service-wiki-memory");
  }

  const gates = {
    token: Boolean(token),
    serverReadiness: serverReadiness.ok,
    discovery: discovery?.ok === true,
    issueWorkspaces: issueWorkspaces.ok,
    issueComments: issueComments.ok,
    wikiMemory: wikiMemory.ok,
  };
  const result: HarnessAgentGitServiceStagingReadinessResult = {
    schemaVersion: "agent-git-service-staging-readiness/v1",
    ok: Object.values(gates).every(Boolean) && missing.length === 0,
    tokenFree: true,
    provider: "agent-git-service",
    ...(options.report ? { reportPath: resolve(options.report) } : {}),
    baseUrl,
    tokenEnv,
    issue: issueRef,
    repo: repoRef,
    ...(issueUrl ? { issueUrl } : {}),
    ...(gitRemoteUrl ? { gitRemoteUrl } : {}),
    serverReadiness,
    ...(discovery ? { discovery } : {}),
    issueWorkspaces,
    issueComments,
    wikiMemory,
    gates,
    missing,
  };
  if (options.report) {
    const reportPath = resolve(options.report);
    mkdirSync(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}

export async function readAgentGitServiceStagingIssueWorkspaces(
  baseUrl: string,
  token: string,
  issue: string,
): Promise<HarnessAgentGitServiceReadinessCollection> {
  try {
    const workspaces = await listAgentGitServiceIssueWorkspaces({ baseUrl, token, issue, limit: 5 });
    return {
      ok: true,
      count: workspaces.length,
      ids: workspaces.map((workspace) => workspace.id),
    };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      ids: [],
      error: preflightErrorMessage(error, [token]),
    };
  }
}

export async function readAgentGitServiceServerReadiness(baseUrl: string): Promise<HarnessAgentGitServiceServerReadiness> {
  const url = controlPlanePreflightDiscoveryEndpointUrl(baseUrl, "/api/v3", "/readyz");
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const text = await response.text();
    const body = text ? JSON.parse(text) as unknown : {};
    const record = isRecord(body) ? body : {};
    const checks = isRecord(record.checks) ? record.checks : {};
    const status = typeof record.status === "string" ? record.status : undefined;
    return {
      ok: response.ok && status === "ready",
      url: url.toString(),
      httpStatus: response.status,
      ...(status ? { status } : {}),
      ...(typeof record.version === "string" ? { version: record.version } : {}),
      checkNames: Object.keys(checks).sort(),
    };
  } catch (error) {
    return {
      ok: false,
      url: url.toString(),
      checkNames: [],
      error: preflightErrorMessage(error),
    };
  }
}

export async function readAgentGitServiceStagingIssueComments(
  baseUrl: string,
  token: string,
  issue: string,
): Promise<HarnessAgentGitServiceReadinessCollection> {
  try {
    const comments = await listAgentGitServiceIssueComments({ baseUrl, token, issue, limit: 5 });
    return {
      ok: true,
      count: comments.length,
      ids: comments.map((comment) => comment.id),
    };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      ids: [],
      error: preflightErrorMessage(error, [token]),
    };
  }
}

export async function readAgentGitServiceStagingWikiMemory(
  baseUrl: string,
  token: string,
  repo: string,
  page: string,
): Promise<HarnessAgentGitServiceReadinessWikiMemory> {
  try {
    const memory = await readAgentGitServiceWikiMemory({ baseUrl, token, repo, page });
    return {
      ok: true,
      page: memory.page,
      bodyBytes: Buffer.byteLength(memory.body, "utf8"),
      ...(memory.sha ? { sha: memory.sha } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      page,
      error: preflightErrorMessage(error, [token]),
    };
  }
}

export async function runHarnessAgentGitServiceNativeWriteCheck(
  options: HarnessAgentGitServiceNativeWriteCheckCliOptions,
): Promise<HarnessAgentGitServiceNativeWriteCheckResult> {
  const baseUrl = controlPlanePreflightBaseUrl({
    controlPlaneProvider: "agent-git-service",
    controlPlaneUrl: options.controlPlaneUrl,
    controlPlaneTokenEnv: options.controlPlaneTokenEnv,
  }, "agent-git-service");
  const tokenEnv = controlPlanePreflightTokenEnv({
    controlPlaneProvider: "agent-git-service",
    controlPlaneUrl: options.controlPlaneUrl,
    controlPlaneTokenEnv: options.controlPlaneTokenEnv,
  }, "agent-git-service");
  const token = process.env[tokenEnv];
  const approved = options.approveMutating === true;
  const issue = parseAgentGitServiceStagingIssueFlag(options.issue);
  const repo = parseAgentGitServiceStagingRepoFlag(options.repo ?? `${issue.owner}/${issue.repo}`, "--repo");
  const issueRef = `${issue.owner}/${issue.repo}#${issue.index}`;
  const repoRef = `${repo.owner}/${repo.repo}`;
  const wikiPage = parseAgentGitServiceWikiPageFlag(options.wikiPage);
  const wikiNote = parseAgentGitServiceWikiNoteFlag(options.wikiNote);
  const workspaceId = options.workspaceId
    ? parseAgentGitServiceWorkspaceIdFlag(options.workspaceId)
    : undefined;
  const attachmentUrl = options.attachmentUrl
    ? normalizeHttpBaseUrl(options.attachmentUrl, "--attachment-url")
    : undefined;
  const missing = [
    baseUrl ? undefined : "control-plane-url",
    token ? undefined : "control-plane-token",
    approved ? undefined : "approve-mutating",
    attachmentUrl ? undefined : "attachment-url",
  ].filter((item): item is string => Boolean(item));

  let issueComment: HarnessAgentGitServiceWriteCheck = { ok: false };
  let workspaceAttachment: HarnessAgentGitServiceWorkspaceAttachmentCheck = { ok: false };
  let wikiMemory: HarnessAgentGitServiceWikiMemoryWriteCheck = { ok: false, page: wikiPage };

  if (baseUrl && token && approved && attachmentUrl) {
    issueComment = await writeAgentGitServiceNativeIssueComment(baseUrl, token, issueRef, repoRef, attachmentUrl);
    workspaceAttachment = await writeAgentGitServiceNativeWorkspaceAttachment(
      baseUrl,
      token,
      issueRef,
      workspaceId,
      attachmentUrl,
    );
    wikiMemory = await writeAgentGitServiceNativeWikiMemory(baseUrl, token, repoRef, wikiPage, wikiNote);
    if (!issueComment.ok) missing.push("agent-git-service-issue-comment-write");
    if (!workspaceAttachment.ok) missing.push("agent-git-service-workspace-attachment-write");
    if (!wikiMemory.ok) missing.push("agent-git-service-wiki-memory-write");
  }

  const gates = {
    token: Boolean(token),
    approved,
    issueComment: issueComment.ok,
    workspaceAttachment: workspaceAttachment.ok,
    wikiMemory: wikiMemory.ok,
  };
  const reportPath = options.report ? resolve(options.report) : undefined;
  const result: HarnessAgentGitServiceNativeWriteCheckResult = {
    schemaVersion: "agent-git-service-native-write-check/v1",
    ok: Object.values(gates).every(Boolean) && missing.length === 0,
    tokenFree: true,
    provider: "agent-git-service",
    ...(reportPath ? { reportPath } : {}),
    baseUrl,
    tokenEnv,
    issue: issueRef,
    repo: repoRef,
    ...(attachmentUrl ? { attachmentUrl } : {}),
    wikiPage,
    approved,
    issueComment,
    workspaceAttachment,
    wikiMemory,
    gates,
    missing: Array.from(new Set(missing)),
  };
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}

export async function writeAgentGitServiceNativeIssueComment(
  baseUrl: string,
  token: string,
  issue: string,
  repo: string,
  attachmentUrl: string,
): Promise<HarnessAgentGitServiceWriteCheck> {
  try {
    await createAgentGitServiceIssueComment({
      baseUrl,
      token,
      issue,
      summary: {
        runId: "agent-git-service-native-write-check",
        goal: `native write check for ${issue}`,
        status: "passed",
        skills: [],
        metadata: {
          issue,
          repo,
          summaryUrl: attachmentUrl,
        },
        requester: {
          actor: "operator",
          role: "admin",
        },
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        eventCount: 0,
        runDir: "agent-git-service-native-write-check",
        verification: null,
      },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: preflightErrorMessage(error, [token]) };
  }
}

export async function writeAgentGitServiceNativeWorkspaceAttachment(
  baseUrl: string,
  token: string,
  issue: string,
  workspaceId: string | undefined,
  attachmentUrl: string,
): Promise<HarnessAgentGitServiceWorkspaceAttachmentCheck> {
  try {
    const selectedWorkspaceId = workspaceId ?? await firstAgentGitServiceWorkspaceId(baseUrl, token, issue);
    const attachment = await createAgentGitServiceIssueWorkspaceAttachment({
      baseUrl,
      token,
      issue,
      workspaceId: selectedWorkspaceId,
      name: "loom-native-write-check",
      url: attachmentUrl,
      contentType: "text/html",
    });
    return {
      ok: true,
      workspaceId: selectedWorkspaceId,
      attachmentId: attachment.id,
      ...(attachment.url ? { url: attachment.url } : {}),
    };
  } catch (error) {
    return { ok: false, error: preflightErrorMessage(error, [token]) };
  }
}

export async function firstAgentGitServiceWorkspaceId(baseUrl: string, token: string, issue: string): Promise<string> {
  const workspaces = await listAgentGitServiceIssueWorkspaces({ baseUrl, token, issue, limit: 1 });
  const workspace = workspaces[0];
  if (!workspace) throw new Error("agent-git-service issue had no workspaces to attach evidence to");
  return workspace.id;
}

export async function writeAgentGitServiceNativeWikiMemory(
  baseUrl: string,
  token: string,
  repo: string,
  page: string,
  note: string,
): Promise<HarnessAgentGitServiceWikiMemoryWriteCheck> {
  try {
    const memory = await readAgentGitServiceWikiMemory({ baseUrl, token, repo, page });
    const body = appendAgentGitServiceNativeWriteNote(memory.body, note);
    const updated = await updateAgentGitServiceWikiMemory({
      baseUrl,
      token,
      repo,
      page,
      body,
      message: "loom native write check",
    });
    return {
      ok: true,
      page: updated.page,
      bodyBytes: Buffer.byteLength(updated.body, "utf8"),
      ...(updated.sha ? { sha: updated.sha } : {}),
      noteSha256: sha256Hex(note),
    };
  } catch (error) {
    return { ok: false, page, error: preflightErrorMessage(error, [token]) };
  }
}

export function appendAgentGitServiceNativeWriteNote(body: string, note: string): string {
  const prefix = body.trimEnd();
  const section = [
    "<!-- loom-agent-git-service-native-write-check -->",
    note,
  ].join("\n");
  return `${prefix ? `${prefix}\n\n` : ""}${section}\n`;
}

export function agentGitServiceCompatRehearsalCandidateToken(options: HarnessAgentGitServiceCompatRehearsalCliOptions): string | undefined {
  const tokenEnv = parseEnvNameFlag(options.candidateTokenEnv, "--candidate-token-env");
  const token = process.env[tokenEnv];
  if (!token) {
    throw new Error(`--candidate-token-env ${tokenEnv} is required when --candidate-url is used`);
  }
  return token;
}

export function readAgentGitServiceContractProbeReport(path: string, label: string): AgentGitServiceContractProbeResult {
  const resolvedPath = resolve(path);
  const value = JSON.parse(readFileSync(resolvedPath, "utf8")) as unknown;
  const report = isRecord(value) && isRecord(value.compatibilityReport) ? value.compatibilityReport : value;
  if (!isAgentGitServiceContractProbeReport(report)) {
    throw new Error(`${label} did not include an agent-git-service compatibilityReport`);
  }
  return report;
}

export function isAgentGitServiceContractProbeReport(value: unknown): value is AgentGitServiceContractProbeResult {
  return (
    isRecord(value) &&
    value.schemaVersion === "agent-git-service-contract-probe/v1" &&
    value.provider === "agent-git-service" &&
    value.apiBasePath === "/api/v3" &&
    value.readOnly === true &&
    value.authorizationScheme === "Bearer" &&
    typeof value.checkedAt === "string" &&
    typeof value.baseUrl === "string" &&
    Array.isArray(value.endpoints) &&
    value.endpoints.every(isAgentGitServiceContractProbeEndpoint) &&
    typeof value.ok === "boolean" &&
    Array.isArray(value.missingEndpoints) &&
    value.missingEndpoints.every((endpoint) => typeof endpoint === "string") &&
    Array.isArray(value.nativeCapabilities) &&
    value.nativeCapabilities.every((capability) => typeof capability === "string") &&
    value.requestsTokenFree === true
  );
}

export function isAgentGitServiceContractProbeEndpoint(value: unknown): value is AgentGitServiceContractProbeResult["endpoints"][number] {
  return (
    isRecord(value) &&
    typeof value.endpoint === "string" &&
    typeof value.url === "string" &&
    typeof value.ok === "boolean" &&
    (value.status === undefined || typeof value.status === "number") &&
    (value.error === undefined || typeof value.error === "string")
  );
}

export function platformCutoverBundleUsesAgentGitService(stages: HarnessPlatformCutoverPlanStage[]): boolean {
  return stages.some((stage) => stage.id.startsWith("agent-git-service-"));
}

export function platformCutoverBundleUpstreamAgentGitServiceOperatorChecklist(
  requiredVariables: HarnessPlatformCutoverEnvironmentVariable[],
): HarnessUpstreamAgentGitServiceOperatorChecklistItem[] {
  return [
    {
      id: "start-upstream-gh-server",
      phase: "upstream-server",
      action: "Start upstream gh-server with DB_DSN configured outside Loom.",
      requiresEnv: ["DB_DSN"],
      evidence: "external AGS /readyz is reachable and reports ready",
    },
    {
      id: "set-loom-control-plane-secrets",
      phase: "loom-env",
      action: "Populate Loom control-plane, tenant, and model env names from CI secrets.",
      requiresEnv: Array.from(new Set(requiredVariables.map((variable) => variable.name))),
      evidence: "platform-staging-prerequisites reports required env names present",
    },
    {
      id: "run-strict-pre-serve",
      phase: "pre-serve",
      command: "LOOM_REQUIRE_EXTERNAL_STAGING=1 LOOM_REQUIRE_OPERATOR_APPROVALS=1 LOOM_RUN_STAGING_CI_CHECKS=1 LOOM_CUTOVER_PHASE=pre-serve ./commands.sh",
      evidence: "staging-prerequisites, staging-run, staging-evidence, staging-verdict, and external-staging-audit reports pass",
    },
    {
      id: "start-loom-serve",
      phase: "serve",
      command: "loom harness serve",
      evidence: "serve-ready report proves /healthz, /readyz, and /status",
    },
    {
      id: "run-approved-ags-post-serve",
      phase: "post-serve",
      command: "LOOM_REQUIRE_EXTERNAL_STAGING=1 LOOM_REQUIRE_OPERATOR_APPROVALS=1 LOOM_RUN_STAGING_CI_CHECKS=1 LOOM_CUTOVER_PHASE=post-serve ./commands.sh",
      evidence: "operator-approvals, native write, operator-artifacts, staging-proof, and goal-audit pass",
    },
  ];
}

export function platformCutoverBundleUpstreamAgentGitServiceHandoffMismatches(
  text: string | undefined,
  plan: Record<string, unknown> | undefined,
  stages: HarnessPlatformCutoverPlanStage[],
  requiredVariables: HarnessPlatformCutoverEnvironmentVariable[],
): string[] {
  if (!platformCutoverBundleUsesAgentGitService(stages)) return [];
  if (text === undefined) return ["upstream-agent-git-service.json"];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return ["upstream-agent-git-service.json"];
  }
  if (!isRecord(value)) return ["upstream-agent-git-service.json"];
  const mismatches: string[] = [];
  const upstream = isRecord(value.upstream) ? value.upstream : undefined;
  if (value.schemaVersion !== "upstream-agent-git-service-staging-guide/v1") {
    mismatches.push("upstream-agent-git-service.schemaVersion");
  }
  if (value.tokenFree !== true) {
    mismatches.push("upstream-agent-git-service.tokenFree");
  }
  if (upstream?.repository !== "https://github.com/ngaut/agent-git-service") {
    mismatches.push("upstream-agent-git-service.upstream.repository");
  }
  if (upstream?.developmentBinary !== "gh-server") {
    mismatches.push("upstream-agent-git-service.upstream.developmentBinary");
  }
  if (upstream?.apiBasePath !== "/api/v3") {
    mismatches.push("upstream-agent-git-service.upstream.apiBasePath");
  }
  if (upstream?.metadataDatabaseEnv !== "DB_DSN") {
    mismatches.push("upstream-agent-git-service.upstream.metadataDatabaseEnv");
  }
  const requiredServerEnv = Array.isArray(value.requiredServerEnv)
    ? value.requiredServerEnv.filter(isRecord)
    : [];
  if (!requiredServerEnv.some((item) => item.name === "DB_DSN")) {
    mismatches.push("upstream-agent-git-service.requiredServerEnv.DB_DSN");
  }
  const requiredLoomEnv = Array.isArray(value.requiredLoomEnv) ? stringsOnly(value.requiredLoomEnv) : [];
  for (const envName of Array.from(new Set(requiredVariables.map((variable) => variable.name)))) {
    if (!requiredLoomEnv.includes(envName)) {
      mismatches.push(`upstream-agent-git-service.requiredLoomEnv.${envName}`);
    }
  }
  const targets = isRecord(value.targets) ? value.targets : undefined;
  const guideControlPlane = targets && isRecord(targets.controlPlane) ? targets.controlPlane : undefined;
  const guideAgentGitServiceStaging = targets && isRecord(targets.agentGitServiceStaging)
    ? targets.agentGitServiceStaging
    : undefined;
  const expectedTargets = plan ? platformCutoverBundleExternalTargets(plan) : {};
  const expectedControlPlane = isRecord(expectedTargets.controlPlane) ? expectedTargets.controlPlane : undefined;
  if (expectedControlPlane?.provider === "agent-git-service") {
    if (guideControlPlane?.provider !== "agent-git-service") {
      mismatches.push("upstream-agent-git-service.targets.controlPlane.provider");
    }
    const guideBaseUrl = nonEmptyString(guideControlPlane?.baseUrl);
    const expectedBaseUrl = nonEmptyString(expectedControlPlane.baseUrl);
    if (!guideBaseUrl || !expectedBaseUrl || !platformCutoverSameAgentGitServiceApiBaseUrl(guideBaseUrl, expectedBaseUrl)) {
      mismatches.push("upstream-agent-git-service.targets.controlPlane.baseUrl");
    }
    if (guideControlPlane?.tokenEnv !== expectedControlPlane.tokenEnv) {
      mismatches.push("upstream-agent-git-service.targets.controlPlane.tokenEnv");
    }
    if (JSON.stringify(guideControlPlane?.tenantTokenEnvNames ?? []) !== JSON.stringify(expectedControlPlane.tenantTokenEnvNames ?? [])) {
      mismatches.push("upstream-agent-git-service.targets.controlPlane.tenantTokenEnvNames");
    }
  }
  const expectedAgentGitServiceStaging = isRecord(expectedTargets.agentGitServiceStaging)
    ? expectedTargets.agentGitServiceStaging
    : undefined;
  if (
    expectedAgentGitServiceStaging &&
    JSON.stringify(guideAgentGitServiceStaging ?? {}) !== JSON.stringify(expectedAgentGitServiceStaging)
  ) {
    mismatches.push("upstream-agent-git-service.targets.agentGitServiceStaging");
  }
  if (!Array.isArray(value.operatorOrder) || stringsOnly(value.operatorOrder).length === 0) {
    mismatches.push("upstream-agent-git-service.operatorOrder");
  }
  mismatches.push(...platformCutoverBundleUpstreamAgentGitServiceChecklistMismatches(value, requiredVariables));
  return mismatches;
}

export function platformCutoverBundleUpstreamAgentGitServiceChecklistMismatches(
  value: Record<string, unknown>,
  requiredVariables: HarnessPlatformCutoverEnvironmentVariable[],
): string[] {
  if (!Array.isArray(value.operatorChecklist)) return ["upstream-agent-git-service.operatorChecklist"];
  const actual = value.operatorChecklist.filter(isRecord);
  const expected = platformCutoverBundleUpstreamAgentGitServiceOperatorChecklist(requiredVariables);
  return expected.flatMap((expectedItem) => {
    const actualItem = actual.find((item) => item.id === expectedItem.id);
    if (!actualItem) return [`upstream-agent-git-service.operatorChecklist.${expectedItem.id}`];
    const expectedRequiresEnv = expectedItem.requiresEnv ?? [];
    const actualRequiresEnv = Array.isArray(actualItem.requiresEnv) ? stringsOnly(actualItem.requiresEnv) : [];
    const mismatch =
      actualItem.phase !== expectedItem.phase ||
      actualItem.action !== expectedItem.action ||
      actualItem.command !== expectedItem.command ||
      actualItem.evidence !== expectedItem.evidence ||
      JSON.stringify(actualRequiresEnv) !== JSON.stringify(expectedRequiresEnv);
    return mismatch ? [`upstream-agent-git-service.operatorChecklist.${expectedItem.id}`] : [];
  });
}

export function platformCutoverBundleExternalTargets(plan: Record<string, unknown>): Record<string, unknown> {
  const externalEnvironment = isRecord(plan.externalEnvironment) ? plan.externalEnvironment : {};
  const systems = isRecord(externalEnvironment.systems) ? externalEnvironment.systems : {};
  return platformCutoverBundleRedactSystemSecrets(systems) as Record<string, unknown>;
}

export function platformCutoverBundleRedactSystemSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => platformCutoverBundleRedactSystemSecrets(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !platformCutoverBundleSystemSecretKey(key))
      .map(([key, item]) => [key, platformCutoverBundleRedactSystemSecrets(item)]),
  );
}

export function platformCutoverBundleSystemSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "token" ||
    normalized === "apikey" ||
    normalized === "api_key" ||
    normalized.includes("secret") ||
    normalized.includes("password");
}

export function platformBundleLoomCommand(dir: string): string {
  const explicit = process.env.LOOM_BIN?.trim();
  if (explicit) return explicit;
  const wrapperPath = join(dir, "loom-wrapper");
  return executableFile(wrapperPath) ? wrapperPath : "loom";
}

export function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function writeHarnessUpstreamAgentGitServiceHandoff(
  options: HarnessUpstreamAgentGitServiceHandoffCliOptions,
): HarnessUpstreamAgentGitServiceHandoffResult {
  const dir = resolve(options.dir);
  const planPath = resolve(options.plan ?? join(dir, "plan.json"));
  const planText = readFileSync(planPath, "utf8");
  const plan = parseHarnessPlatformCutoverPlanObject(planText);
  const stages = parseHarnessPlatformCutoverPlanStages(planText);
  const requiredVariables = parseHarnessPlatformCutoverRequiredVariables(planText);
  const guidePath = join(dir, "upstream-agent-git-service.json");
  const guideText = readBundleFileIfPresent(dir, "upstream-agent-git-service.json");
  const guide = platformStagingPrerequisitesUpstreamAgentGitServiceGuide(guideText);
  const handoffMismatches = platformCutoverBundleUpstreamAgentGitServiceHandoffMismatches(
    guideText,
    plan,
    stages,
    requiredVariables,
  );
  const requiredServerEnv = platformStagingPrerequisitesRequiredServerEnvNames(guide).map((name) => ({
    name,
    present: Boolean(process.env[name]?.trim()),
  }));
  const requiredLoomEnv = platformStagingPrerequisitesRequiredLoomEnvNames(guide, requiredVariables).map((name) => ({
    name,
    present: Boolean(process.env[name]?.trim()),
  }));
  const checklistMismatchIds = new Set(
    handoffMismatches
      .filter((mismatch) => mismatch.startsWith("upstream-agent-git-service.operatorChecklist."))
      .map((mismatch) => mismatch.slice("upstream-agent-git-service.operatorChecklist.".length)),
  );
  const expectedChecklist = platformCutoverBundleUpstreamAgentGitServiceOperatorChecklist(requiredVariables);
  const operatorChecklist = expectedChecklist.map((item) => ({
    id: item.id,
    phase: item.phase,
    ready: !checklistMismatchIds.has(item.id) &&
      (item.requiresEnv ?? []).every((name) => Boolean(process.env[name]?.trim())),
    evidence: item.evidence,
  }));
  const forbiddenValues = [
    ...(options.forbid ?? []),
    ...platformCutoverBundleForbiddenEnvValues(options.forbidEnv ?? []),
  ].filter((value) => value.length > 0);
  const forbiddenValueHitFiles = guideText && forbiddenValues.some((value) => guideText.includes(value))
    ? ["upstream-agent-git-service.json"]
    : [];
  const gates = {
    guideOk: guideText !== undefined && handoffMismatches.length === 0,
    requiredServerEnvOk: requiredServerEnv.every((variable) => variable.present),
    requiredLoomEnvOk: requiredLoomEnv.every((variable) => variable.present),
    operatorChecklistOk: expectedChecklist.length > 0 && checklistMismatchIds.size === 0,
    secretScanOk: forbiddenValueHitFiles.length === 0,
  };
  const missing = Array.from(new Set([
    ...handoffMismatches.map(platformStagingPrerequisitesUpstreamMismatchLabel),
    ...requiredServerEnv
      .filter((variable) => !variable.present)
      .map((variable) => `upstreamAgentGitService.requiredServerEnv.${variable.name}`),
    ...requiredLoomEnv
      .filter((variable) => !variable.present)
      .map((variable) => `upstreamAgentGitService.requiredLoomEnv.${variable.name}`),
    ...forbiddenValueHitFiles.map((file) => `forbiddenValue.${file}`),
  ]));
  const result: HarnessUpstreamAgentGitServiceHandoffResult = {
    schemaVersion: "upstream-agent-git-service-handoff/v1",
    ok: Object.values(gates).every(Boolean) && missing.length === 0,
    tokenFree: true,
    dir,
    planPath,
    ...(options.report ? { reportPath: resolve(options.report) } : {}),
    guidePath,
    ...(guideText ? { guideSha256: sha256Hex(guideText) } : {}),
    handoffMismatches,
    requiredServerEnv,
    requiredLoomEnv,
    operatorChecklist,
    gates,
    forbiddenValueHitFiles,
    missing,
    nextActions: upstreamAgentGitServiceHandoffNextActions({ dir, requiredServerEnv, requiredLoomEnv, handoffMismatches }),
  };
  if (options.report) {
    const reportPath = resolve(options.report);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}

export function upstreamAgentGitServiceHandoffNextActions(options: {
  dir: string;
  requiredServerEnv: Array<{ name: string; present: boolean }>;
  requiredLoomEnv: Array<{ name: string; present: boolean }>;
  handoffMismatches: string[];
}): string[] {
  const actions: string[] = [];
  if (options.handoffMismatches.length > 0) {
    actions.push(`Regenerate or restore upstream-agent-git-service.json from the current bundle: ${options.dir}`);
  }
  const missingServerEnv = options.requiredServerEnv
    .filter((variable) => !variable.present)
    .map((variable) => variable.name);
  if (missingServerEnv.length > 0) {
    actions.push(upstreamAgentGitServiceServerEnvPlanAction(options.dir, "upstream-agent-git-service-handoff"));
  }
  const missingLoomEnv = options.requiredLoomEnv
    .filter((variable) => !variable.present)
    .map((variable) => variable.name);
  if (missingLoomEnv.length > 0) {
    actions.push(`Populate Loom staging env names from CI secrets: ${missingLoomEnv.join(", ")}`);
  }
  return Array.from(new Set(actions));
}

export function platformStagingPrerequisitesUpstreamAgentGitServiceGuide(
  text: string | undefined,
): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function platformStagingPrerequisitesRequiredServerEnvNames(guide: Record<string, unknown> | undefined): string[] {
  const requiredServerEnv = Array.isArray(guide?.requiredServerEnv)
    ? guide.requiredServerEnv.filter(isRecord)
    : [];
  const names = requiredServerEnv
    .map((item) => nonEmptyString(item.name))
    .filter((name): name is string => name !== undefined);
  return Array.from(new Set(names.length > 0 ? names : ["DB_DSN"]));
}

export function platformStagingPrerequisitesRequiredLoomEnvNames(
  guide: Record<string, unknown> | undefined,
  requiredVariables: HarnessPlatformCutoverEnvironmentVariable[],
): string[] {
  if (Array.isArray(guide?.requiredLoomEnv)) {
    return Array.from(new Set(stringsOnly(guide.requiredLoomEnv)));
  }
  return Array.from(new Set(requiredVariables.map((variable) => variable.name)));
}

export function platformStagingPrerequisitesUpstreamMismatchLabel(mismatch: string): string {
  if (mismatch === "upstream-agent-git-service.json") return "upstreamAgentGitService.guide";
  return mismatch.replace(/^upstream-agent-git-service\./, "upstreamAgentGitService.");
}

export function upstreamAgentGitServiceServerEnvPlanAction(dir: string, rerunCommand: string, loomCommand = platformBundleLoomCommand(dir)): string {
  const command = shellCommand([
    loomCommand,
    "harness",
    "upstream-agent-git-service-server-env-plan",
    "--dir",
    dir,
    "--report",
    join(dir, "reports", "upstream-agent-git-service-server-env-plan.json"),
  ]);
  return `Run upstream server env plan: ${command}; start gh-server with serverStartShellCommand, then rerun ${rerunCommand}.`;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function platformCutoverSameAgentGitServiceApiBaseUrl(left: string, right: string): boolean {
  const normalizedLeft = platformCutoverComparableAgentGitServiceApiBaseUrl(left);
  const normalizedRight = platformCutoverComparableAgentGitServiceApiBaseUrl(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function platformCutoverComparableAgentGitServiceApiBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = basePath.endsWith("/api/v3") ? basePath : `${basePath}/api/v3`;
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export function readBundleFileIfPresent(dir: string, file: string): string | undefined {
  if (!isSafeBundleFileName(file)) return undefined;
  try {
    return readFileSync(join(dir, file), "utf8");
  } catch {
    return undefined;
  }
}

export function platformCutoverBundleForbiddenEnvValues(envNames: string[]): string[] {
  return Array.from(new Set(envNames.map((envName) => parseEnvNameFlag(envName, "--forbid-env"))))
    .map((envName) => process.env[envName] ?? "")
    .filter((value) => value.length > 0);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function isSafeBundleFileName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

export function parseHarnessPlatformCutoverPlanObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`platform cutover plan must be JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error("platform cutover plan must be an object.");
  return value;
}

export function parseHarnessPlatformCutoverPlanStages(text: string): HarnessPlatformCutoverPlanStage[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`platform cutover plan must be JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value) || !Array.isArray(value.stages)) {
    throw new Error("platform cutover plan must include a stages array.");
  }
  return value.stages.map((stage, index) => parseHarnessPlatformCutoverPlanStage(stage, index));
}

export function parseHarnessPlatformCutoverRequiredVariables(text: string): HarnessPlatformCutoverEnvironmentVariable[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`platform cutover plan must be JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value) || !isRecord(value.externalEnvironment) || !Array.isArray(value.externalEnvironment.requiredVariables)) {
    throw new Error("platform cutover plan must include externalEnvironment.requiredVariables.");
  }
  return value.externalEnvironment.requiredVariables.map((variable, index) =>
    parseHarnessPlatformCutoverRequiredVariable(variable, index)
  );
}

export function parseHarnessPlatformCutoverRequiredVariable(
  value: unknown,
  index: number,
): HarnessPlatformCutoverEnvironmentVariable {
  if (!isRecord(value)) throw new Error(`platform cutover required variable ${index} must be an object.`);
  if (typeof value.name !== "string" || !isEnvName(value.name)) {
    throw new Error(`platform cutover required variable ${index} must include a valid name.`);
  }
  const name = value.name;
  if (!Array.isArray(value.requiredFor)) {
    throw new Error(`platform cutover required variable ${name} requiredFor must be an array.`);
  }
  const requiredFor = value.requiredFor.map((stageId, stageIndex) => {
    if (typeof stageId === "string" && stageId.length > 0) return stageId;
    throw new Error(`platform cutover required variable ${name} requiredFor[${stageIndex}] must be a non-empty string.`);
  });
  if (!Array.isArray(value.uses)) {
    throw new Error(`platform cutover required variable ${name} uses must be an array.`);
  }
  const uses = value.uses.map((use, useIndex) =>
    parseHarnessPlatformCutoverRequiredVariableUse(use, name, useIndex)
  );
  return { name, requiredFor, uses };
}

export function parseHarnessPlatformCutoverRequiredVariableUse(
  value: unknown,
  envName: string,
  index: number,
): HarnessPlatformCutoverEnvironmentVariableUse {
  if (!isRecord(value)) throw new Error(`platform cutover required variable ${envName} uses[${index}] must be an object.`);
  if (typeof value.sourceFlag !== "string" || !value.sourceFlag) {
    throw new Error(`platform cutover required variable ${envName} uses[${index}].sourceFlag is required.`);
  }
  if (typeof value.purpose !== "string" || !value.purpose) {
    throw new Error(`platform cutover required variable ${envName} uses[${index}].purpose is required.`);
  }
  const role = value.role === undefined
    ? undefined
    : parseTenantRoleFlag(String(value.role), `externalEnvironment.requiredVariables.${envName}.uses[${index}].role`);
  return compactObject({
    sourceFlag: value.sourceFlag,
    purpose: value.purpose,
    tenant: typeof value.tenant === "string" ? value.tenant : undefined,
    actor: typeof value.actor === "string" ? value.actor : undefined,
    role,
  });
}

export function shellCommand(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

export function shellQuote(value: string): string {
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\[@\]\}$/.test(value)) return `"${value}"`;
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function parseHarnessPlatformCutoverPlanStage(value: unknown, index: number): HarnessPlatformCutoverPlanStage {
  if (!isRecord(value)) throw new Error(`platform cutover stage ${index} must be an object.`);
  const id = stringFromPlanStage(value, "id", index);
  const command = stringFromPlanStage(value, "command", index);
  const executionMode = stringFromPlanStage(value, "executionMode", index);
  if (!isPlatformCutoverExecutionMode(executionMode)) {
    throw new Error(`platform cutover stage ${id} has unsupported executionMode ${executionMode}.`);
  }
  const commandArgs = Array.isArray(value.commandArgs)
    ? value.commandArgs.map((item, argIndex) => {
        if (typeof item === "string") return item;
        throw new Error(`platform cutover stage ${id} commandArgs[${argIndex}] must be a string.`);
      })
    : undefined;
  const approvalRequired = value.approvalRequired === true;
  const tokenFree = value.tokenFree === true;
  const requires = value.requires === undefined
    ? undefined
    : parseHarnessPlatformCutoverPlanStringArray(value.requires, id, "requires");
  const operatorGate = value.operatorGate === undefined
    ? undefined
    : parseHarnessPlatformCutoverOperatorGate(value.operatorGate, id);
  return {
    id,
    command,
    ...(commandArgs ? { commandArgs } : {}),
    executionMode,
    approvalRequired,
    tokenFree,
    ...(requires ? { requires } : {}),
    ...(operatorGate ? { operatorGate } : {}),
  };
}

export function parseHarnessPlatformCutoverPlanStringArray(value: unknown, stageId: string, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`platform cutover stage ${stageId} ${field} must be an array.`);
  return value.map((item, index) => {
    if (typeof item === "string" && item.length > 0) return item;
    throw new Error(`platform cutover stage ${stageId} ${field}[${index}] must be a non-empty string.`);
  });
}

export function stringFromPlanStage(value: Record<string, unknown>, field: string, index: number): string {
  if (typeof value[field] === "string" && value[field].length > 0) return value[field];
  throw new Error(`platform cutover stage ${index} must include ${field}.`);
}

export function isPlatformCutoverExecutionMode(value: string): value is HarnessPlatformCutoverPlanStage["executionMode"] {
  return value === "read-only" ||
    value === "long-running" ||
    value === "dry-run" ||
    value === "mutating" ||
    value === "verification";
}

export function parseHarnessPlatformCutoverOperatorGate(value: unknown, stageId: string): HarnessPlatformCutoverPlanStage["operatorGate"] {
  if (!isRecord(value)) throw new Error(`platform cutover stage ${stageId} operatorGate must be an object.`);
  if (typeof value.id !== "string" || !value.id) {
    throw new Error(`platform cutover stage ${stageId} operatorGate.id is required.`);
  }
  if (typeof value.evidence !== "string" || !value.evidence) {
    throw new Error(`platform cutover stage ${stageId} operatorGate.evidence is required.`);
  }
  return { id: value.id, evidence: value.evidence };
}

export async function provisionAgentGitServiceProjectAgentViaHarness(options: HarnessAgentGitServiceProvisionCliOptions): Promise<unknown> {
  const tenant = parseSafeNameFlag(options.tenant, "--tenant");
  const project = parseSafeNameFlag(options.project, "--project");
  const token = cliTokenValue(options.adminToken, options.adminTokenEnv, "--admin-token-env");
  if (!token) throw new Error("--admin-token or --admin-token-env is required.");
  const response = await smokeJson(
    harnessApiUrl(options.url, `/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/control-plane/agent-git-service/provision`),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(agentGitServiceProvisionCliBody(options)),
    },
    [201],
    "agent-git-service provisioning",
  );
  return response.body;
}

export async function readAgentGitServiceProvisioningPlanViaHarness(options: HarnessAgentGitServiceProvisioningPlanCliOptions): Promise<unknown> {
  const tenant = parseSafeNameFlag(options.tenant, "--tenant");
  const token = cliTokenValue(options.adminToken, options.adminTokenEnv, "--admin-token-env");
  if (!token) throw new Error("--admin-token or --admin-token-env is required.");
  const response = await smokeJson(
    harnessApiUrl(options.url, `/tenants/${encodeURIComponent(tenant)}/control-plane/agent-git-service/provisioning-plan`),
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
    [200],
    "agent-git-service provisioning plan",
  );
  return response.body;
}

export async function applyAgentGitServiceProvisioningPlanViaHarness(options: HarnessAgentGitServiceProvisioningPlanApplyCliOptions): Promise<unknown> {
  const tenant = parseSafeNameFlag(options.tenant, "--tenant");
  const token = cliTokenValue(options.adminToken, options.adminTokenEnv, "--admin-token-env");
  if (!token) throw new Error("--admin-token or --admin-token-env is required.");
  const response = await smokeJson(
    harnessApiUrl(options.url, `/tenants/${encodeURIComponent(tenant)}/control-plane/agent-git-service/provisioning-plan/apply`),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(agentGitServiceProvisioningPlanApplyCliBody(options)),
    },
    [200],
    "agent-git-service provisioning plan apply",
  );
  return response.body;
}

export function harnessApiUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function agentGitServiceProvisionCliBody(options: HarnessAgentGitServiceProvisionCliOptions): Record<string, unknown> {
  const identityRole = options.identityRole === undefined ? undefined : parseTenantRoleFlag(options.identityRole, "--identity-role");
  if (options.identityActor !== undefined && identityRole === undefined) {
    throw new Error("--identity-actor requires --identity-role.");
  }
  return compactObject({
    repo: options.repo,
    permission: options.permission === undefined ? undefined : parseAgentGitServicePermissionFlag(options.permission, "--permission"),
    agentPrefixLogin: options.agentPrefixLogin === undefined ? undefined : parseSafeNameFlag(options.agentPrefixLogin, "--agent-prefix-login"),
    defaultRepoName: options.defaultRepoName === undefined ? undefined : parseSafeNameFlag(options.defaultRepoName, "--default-repo-name"),
    tokenEnvName: options.tokenEnvName,
    controlPlaneIdentity: identityRole === undefined
      ? undefined
      : compactObject({
          actor: options.identityActor,
          role: identityRole,
        }),
    storeAgentToken: options.storeAgentToken ? true : undefined,
    force: options.force ? true : undefined,
    clientId: options.clientId,
  });
}

export function agentGitServiceProvisioningPlanApplyCliBody(options: HarnessAgentGitServiceProvisioningPlanApplyCliOptions): Record<string, unknown> {
  return compactObject({
    projects: options.projects === undefined ? undefined : parseSafeNameCsvFlag(options.projects, "--projects"),
    dryRun: options.dryRun ? true : undefined,
    eligibleOnly: options.eligibleOnly ? true : undefined,
    clientId: options.clientId,
  });
}

export function parseAgentGitServicePermissionFlag(value: string, flag: string): "read" | "write" | "admin" {
  if (value === "read" || value === "write" || value === "admin") return value;
  console.error(`${flag} must be one of: read, write, admin.`);
  process.exit(2);
}

export function parseTenantRoleFlag(value: string, flag: string): "viewer" | "developer" | "admin" {
  if (value === "viewer" || value === "developer" || value === "admin") return value;
  console.error(`${flag} must be one of: viewer, developer, admin.`);
  process.exit(2);
}

export function parseSafeNameCsvFlag(value: string, flag: string): string[] {
  const names = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!names.length) {
    console.error(`${flag} must include at least one project name.`);
    process.exit(2);
  }
  return names.map((name) => parseSafeNameFlag(name, flag));
}

export function parseAgentGitServiceStagingIssueFlag(value: string): ReturnType<typeof parseAgentGitServiceIssueRef> {
  const issue = value.trim();
  try {
    return parseAgentGitServiceIssueRef(issue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`--issue ${message}`);
    process.exit(2);
  }
}

export function parseAgentGitServiceStagingRepoFlag(
  value: string,
  flag: string,
): ReturnType<typeof parseAgentGitServiceRepoRef> {
  const repo = value.trim();
  try {
    return parseAgentGitServiceRepoRef(repo);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${flag} ${message}`);
    process.exit(2);
  }
}

export function parseAgentGitServiceWikiPageFlag(value: string): string {
  const page = value.trim();
  if (!page || page.includes("\0") || page.startsWith("/") || page.split("/").some((part) => part === "." || part === "..")) {
    console.error("--wiki-page must be a non-empty relative wiki page path.");
    process.exit(2);
  }
  return page;
}

export function parseAgentGitServiceWorkspaceIdFlag(value: string): string {
  const workspaceId = value.trim();
  if (!workspaceId || workspaceId.includes("\0") || workspaceId.length > 200) {
    console.error("--workspace-id must be a non-empty AGS workspace id.");
    process.exit(2);
  }
  return workspaceId;
}

export function parseAgentGitServiceWikiNoteFlag(value: string): string {
  const note = value.trim();
  if (!note || note.includes("\0") || note.length > 1000) {
    console.error("--wiki-note must be non-empty text up to 1000 characters.");
    process.exit(2);
  }
  return note;
}
