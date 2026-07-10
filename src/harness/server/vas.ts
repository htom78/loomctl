import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { join, posix, resolve } from "node:path";
import { type AgentStep } from "../agents.js";
import { readTenantAuditEvents, type TenantAuditAppender, type TenantAuditEvent, type TenantRole } from "../audit.js";
import { readAgentGitServiceWikiMemory, updateAgentGitServiceWikiMemory } from "../agent-git-service.js";
import { type ReadableRunState } from "../run-state.js";
import type { DeploymentGate, ReviewGate, RunMetadata, RunSummary } from "../events.js";
import { readProjectTemplateMetadata } from "../project-templates.js";
import type { RunSignal } from "../../brain.js";
import { reviewerFocusForFailureKind } from "../../brain-evidence.js";
import { RunPresetName, LinkedIssueRun, QueuedRun, ActiveRun, ActiveRunSlot, createAsyncRunFromBody, readRunStatesForListing, readRunState, runUrl, runDashboardUrl, runEvidenceUrl, publicRunErrorSummary, isRunSummaryState, runEvidencePath, readRunEventsIfPresent } from "./runs.js";
import { IssueCommentSeedEvidence, issueCommentSeedEvidence, reviewDecision } from "./gates.js";
import { controlPlaneProviderName, controlPlaneIssueUrl, publicUrl } from "./status.js";
import { ProjectSummary, AGENT_GIT_SERVICE_VAS_LEARNINGS_PAGE, requireProjectMetadata, ProjectSourceDefaultValues, readProjectSourceDefaults, listTenantProjectNames } from "./projects.js";
import { TenantAccess, brainSignalFailureKind, tenantRoleField, requireTenantAccess } from "./tenants.js";
import { HarnessServerOptions, readVasCaseCreateJson, readVasCaseReviewJson, readVasCaseClaimJson, readVasCaseReviewRunJson } from "./http.js";
import { hasRequestValue, textArray, recordArray, readOptionalJsonObject, readOptionalTextFile, arrayCount, oneLineText, optionalSourceRepo, optionalSourceGitRef, optionalSourceIssue, compactObject, writeJsonFileAtomic, recordData, stringField, requireSafeName, optionalSafeName, optionalString, optionalClientId, isSafeDirectoryName, nonNegativeNumberValue, badRequest, conflict, writeJson, isNotFound, startedAt } from "./shared.js";


interface VasLiteReviewPresetInput {
  caseId: string;
  priorLearningCount?: number;
  reviewCount?: number;
  correctionCount?: number;
  caseLearningCount?: number;
}

interface VasCaseCreateRequestBody {
  caseId?: unknown;
  title?: unknown;
  source?: unknown;
  repo?: unknown;
  branch?: unknown;
  baseBranch?: unknown;
  issue?: unknown;
  clientId?: unknown;
}

interface VasCaseReviewRequestBody {
  decision?: unknown;
  note?: unknown;
  corrections?: unknown;
  learnings?: unknown;
  runId?: unknown;
  clientId?: unknown;
}

interface VasCaseClaimRequestBody {
  action?: unknown;
  clientId?: unknown;
}

interface VasCaseReviewRunRequestBody {
  script?: unknown;
  agentCommand?: unknown;
  model?: unknown;
  modelProtocol?: unknown;
  repo?: unknown;
  branch?: unknown;
  baseBranch?: unknown;
  issue?: unknown;
  pullRequest?: unknown;
  reviewRequired?: unknown;
  deploymentRequired?: unknown;
  syncIssueComments?: unknown;
  verify?: unknown;
  evaluate?: unknown;
  reviewer?: unknown;
  skills?: unknown;
  allowedTools?: unknown;
  maxIterations?: unknown;
  clientId?: unknown;
}

type VasCaseReviewDecision = "approved" | "changes_requested";
type VasCaseClaimAction = "claim" | "release";

interface VasLiteCaseClaim {
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  claimedAt: string;
}

interface VasLiteCaseSummary {
  id: string;
  status?: string;
  title?: string;
  source?: unknown;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  issue?: string;
  sourceDefaultFields?: Array<"repo" | "branch" | "baseBranch" | "issue">;
  path: string;
  reportPath?: string;
  reviewCount?: number;
  correctionCount?: number;
  learningCount?: number;
  runCount?: number;
  reviewedRunCount?: number;
  unreviewedRunCount?: number;
  latestRunId?: string;
  latestRunStatus?: ReadableRunState["status"];
  latestRunStartedAt?: string;
  latestRunReviewDecision?: VasCaseReviewDecision;
  latestRunReviewedAt?: string;
  claim?: VasLiteCaseClaim;
}

interface VasLiteCaseListResponse {
  project: string;
  template: "vas-lite";
  cases: VasLiteCaseSummary[];
}

type VasLiteReviewQueueReason = "needs_review" | "needs_revision" | "unreviewed_run";

interface VasLiteReviewQueueItem extends VasLiteCaseSummary {
  reasons: VasLiteReviewQueueReason[];
  links: {
    reviewPackage: string;
    runs: string;
    artifacts: string;
    review: string;
    reviewRuns: string;
  };
}

interface VasLiteReviewQueueResponse {
  project: string;
  template: "vas-lite";
  cases: VasLiteReviewQueueItem[];
}

interface VasLiteCaseRunLink {
  runCount: number;
  runIds: string[];
  latestRunId?: string;
  latestRunStatus?: ReadableRunState["status"];
  latestRunStartedAt?: string;
}

interface VasLiteLearningSummary {
  caseId: string;
  text: string;
  source?: string;
  reviewDecision?: VasCaseReviewDecision;
  reviewedAt?: string;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  runId?: string;
}

interface VasLiteReviewGuidanceReview {
  decision?: VasCaseReviewDecision;
  note?: string;
  reviewedAt?: string;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  runId?: string;
}

interface VasLiteReviewGuidanceText {
  text: string;
  source?: string;
  reviewDecision?: VasCaseReviewDecision;
  reviewedAt?: string;
  actor?: string;
  role?: TenantRole;
  clientId?: string;
  runId?: string;
}

interface VasLiteReviewGuidance {
  reviewCount: number;
  correctionCount: number;
  learningCount: number;
  latestReview?: VasLiteReviewGuidanceReview;
  recentReviews?: VasLiteReviewGuidanceReview[];
  corrections?: VasLiteReviewGuidanceText[];
  learnings?: VasLiteReviewGuidanceText[];
}

interface VasLiteLearningListResponse {
  project: string;
  template: "vas-lite";
  learnings: VasLiteLearningSummary[];
}

interface VasLiteCaseArtifactsResponse {
  project: string;
  template: "vas-lite";
  caseId: string;
  contextPath: string;
  reportPath: string;
  reviewDraftPath: string;
  context?: Record<string, unknown>;
  report?: string;
  reviewDraft?: Record<string, unknown>;
}

interface VasLiteCaseReviewPackageResponse {
  project: string;
  template: "vas-lite";
  caseId: string;
  case: VasLiteCaseSummary;
  artifacts: VasLiteCaseArtifactsResponse;
  runs: VasLiteCaseRunSummary[];
  reviews: Record<string, unknown>[];
  corrections: Record<string, unknown>[];
  learnings: VasLiteLearningSummary[];
  issueCommentSeeds: IssueCommentSeedEvidence[];
  auditTrail: TenantAuditEvent[];
  links: {
    artifacts: string;
    runs: string;
    review: string;
    reviewRuns: string;
  };
}

interface VasLiteCaseRunSummary {
  runId: string;
  status: ReadableRunState["status"];
  goal: string;
  startedAt: string;
  endedAt?: string;
  agentMode?: RunMetadata["agentMode"];
  model?: string;
  issue?: string;
  issueUrl?: string;
  summaryUrl?: string;
  reviewSummaryUrl?: string;
  handoffPackageUrl?: string;
  pullRequestIndex?: number;
  pullRequestUrl?: string;
  reviewGateStatus?: ReviewGate["status"];
  deploymentGateStatus?: DeploymentGate["status"];
  failureKind?: string;
  reviewerFocus?: string;
  error?: RunSummary["error"];
  contextPath?: string;
  reportPath?: string;
  reviewDraftPath?: string;
  contextWritten?: boolean;
  reportWritten?: boolean;
  reviewDraftWritten?: boolean;
  runPresetInput?: Record<string, unknown>;
  reviewStatus?: "reviewed" | "unreviewed";
  reviewDecision?: VasCaseReviewDecision;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewedRole?: TenantRole;
  reviewedClientId?: string;
}

interface VasLiteCaseRunListResponse {
  project: string;
  template: "vas-lite";
  caseId: string;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  issue?: string;
  sourceDefaultFields?: Array<"repo" | "branch" | "baseBranch" | "issue">;
  runs: VasLiteCaseRunSummary[];
}

interface VasLiteRunState {
  caseId: string;
  state: ReadableRunState;
}

interface LinkedIssueVasCase {
  project: string;
  caseId: string;
  record: Record<string, unknown>;
}

interface RunReviewVasEvidence {
  preset: RunPresetName;
  caseId: string;
  links: {
    artifacts: string;
    runs: string;
    reviewPackage: string;
    reviewRuns: string;
  };
}
const VAS_LITE_REVIEW_PRESET: RunPresetName = "vas-lite-review";
const VAS_LITE_LOOP = "ingest -> evidence -> prediction -> reconstruction -> review -> learning update";
const VAS_LITE_REVIEW_GOAL = "Review VAS Lite bootstrap case";
const VAS_LITE_REVIEW_REPORT_PATH = "cases/bootstrap/reports/latest.md";
const VAS_LITE_REVIEW_CONTEXT_PATH = "cases/bootstrap/reports/context.json";
const VAS_LITE_REVIEW_DRAFT_PATH = "cases/bootstrap/reports/review-draft.json";
const VAS_LITE_REVIEW_VERIFY_COMMANDS = ["node src/loop.js status"];
const VAS_LITE_REVIEW_GUIDANCE_LIMIT = 5;

async function handleListVasLiteCases(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 6) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  const projectRoot = join(workspaceRoot, tenant, project);
  await requireVasLiteProject(workspaceRoot, tenant, project);
  const sourceDefaults = await readProjectSourceDefaults(join(workspaceRoot, tenant), project);
  const response: VasLiteCaseListResponse = {
    project,
    template: "vas-lite",
    cases: await listVasLiteCases(projectRoot, tenant, project, sourceDefaults),
  };
  writeJson(res, 200, response);
  return true;
}

async function handleListVasLiteReviewQueue(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 6) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "review-queue") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  const tenantRoot = join(workspaceRoot, tenant);
  const projectRoot = join(tenantRoot, project);
  await requireVasLiteProject(workspaceRoot, tenant, project, "vas-lite review queues require a vas-lite project template.");
  const sourceDefaults = await readProjectSourceDefaults(tenantRoot, project);
  const response: VasLiteReviewQueueResponse = {
    project,
    template: "vas-lite",
    cases: await listVasLiteReviewQueue(tenant, project, projectRoot, sourceDefaults),
  };
  writeJson(res, 200, response);
  return true;
}

async function handleListVasLiteLearnings(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 6) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "learnings") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  const projectRoot = join(workspaceRoot, tenant, project);
  await requireVasLiteProject(workspaceRoot, tenant, project, "vas-lite learnings require a vas-lite project template.");
  const response: VasLiteLearningListResponse = {
    project,
    template: "vas-lite",
    learnings: await listVasLiteLearnings(projectRoot),
  };
  writeJson(res, 200, response);
  return true;
}

async function handleReadVasLiteCaseArtifacts(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 8) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases" || segments[7] !== "artifacts") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  const caseId = requireSafeName(segments[6], "caseId");
  const projectRoot = join(workspaceRoot, tenant, project);
  await requireVasLiteProject(workspaceRoot, tenant, project, "vas-lite artifacts require a vas-lite project template.");
  await readVasLiteCase(projectRoot, caseId);
  const response: VasLiteCaseArtifactsResponse = await vasLiteCaseArtifacts(projectRoot, project, caseId);
  writeJson(res, 200, response);
  return true;
}

async function handleReadVasLiteCaseReviewPackage(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 8) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases" || segments[7] !== "review-package") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  const caseId = requireSafeName(segments[6], "caseId");
  const tenantRoot = join(workspaceRoot, tenant);
  const projectRoot = join(tenantRoot, project);
  await requireVasLiteProject(workspaceRoot, tenant, project, "vas-lite review packages require a vas-lite project template.");
  const record = await readVasLiteCase(projectRoot, caseId);
  const sourceDefaults = await readProjectSourceDefaults(tenantRoot, project);
  const auditTrail = vasLiteCaseTenantAuditTrail(await readTenantAuditEvents(workspaceRoot, tenant, options.stateBackend?.events), project, caseId);
  const response = await vasLiteCaseReviewPackage(projectRoot, tenant, project, caseId, record, sourceDefaults, auditTrail);
  writeJson(res, 200, response);
  return true;
}

async function handleListVasLiteCaseRuns(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 8) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases" || segments[7] !== "runs") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  await requireTenantAccess(req, tenant, options, url);
  const project = requireSafeName(segments[3], "project");
  const caseId = requireSafeName(segments[6], "caseId");
  const projectRoot = join(workspaceRoot, tenant, project);
  await requireVasLiteProject(workspaceRoot, tenant, project, "vas-lite case runs require a vas-lite project template.");
  const record = await readVasLiteCase(projectRoot, caseId);
  const sourceDefaults = await readProjectSourceDefaults(join(workspaceRoot, tenant), project);
  const caseSummary = vasLiteCaseSummary(caseId, record, undefined, sourceDefaults);
  const response: VasLiteCaseRunListResponse = {
    project,
    template: "vas-lite",
    caseId,
    repo: caseSummary.repo,
    branch: caseSummary.branch,
    baseBranch: caseSummary.baseBranch,
    issue: caseSummary.issue,
    sourceDefaultFields: caseSummary.sourceDefaultFields,
    runs: await vasLiteCaseRunSummaries(projectRoot, tenant, project, caseId, record),
  };
  writeJson(res, 200, response);
  return true;
}

async function handleCreateVasLiteCase(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 6) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const project = requireSafeName(segments[3], "project");
  const body = await readVasCaseCreateJson(req);
  const caseId = requireSafeName(body.caseId, "caseId");
  const title = optionalString(body.title, "title");
  const source = vasLiteCaseSource(body.source);
  const clientId = optionalClientId(body.clientId);
  const projectRoot = join(workspaceRoot, tenant, project);
  await requireVasLiteProject(workspaceRoot, tenant, project);
  const projectSourceDefaults = await readProjectSourceDefaults(join(resolve(workspaceRoot), tenant), project);
  const repo = optionalSourceRepo(body.repo) ?? projectSourceDefaults.repo;
  const branch = optionalSourceGitRef(body.branch, "branch", projectSourceDefaults.branch);
  const baseBranch = optionalSourceGitRef(body.baseBranch, "baseBranch", projectSourceDefaults.baseBranch);
  const issue = optionalSourceIssue(body.issue, projectSourceDefaults.issue);

  const caseDir = join(projectRoot, "cases", caseId);
  const casePath = join(caseDir, "case.json");
  try {
    await readFile(casePath, "utf8");
    throw conflict(`vas-lite case already exists: ${caseId}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  await mkdir(join(caseDir, "frames"), { recursive: true });
  await mkdir(join(caseDir, "reconstruction"), { recursive: true });
  const record = vasLiteCaseRecord(caseId, title, source, { repo, branch, baseBranch, issue });
  await writeJsonFileAtomic(casePath, record);
  const summary = vasLiteCaseSummary(caseId, record);
  await appendAuditEvent(tenant, "vas_case_created", compactObject({
    project,
    caseId,
    repo,
    branch,
    baseBranch,
    issue,
    clientId,
  }), access);
  writeJson(res, 201, summary);
  return true;
}

async function handleReviewVasLiteCase(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 8) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases" || segments[7] !== "review") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const project = requireSafeName(segments[3], "project");
  const caseId = requireSafeName(segments[6], "caseId");
  const body = await readVasCaseReviewJson(req);
  const clientId = optionalClientId(body.clientId);
  const decision = vasLiteCaseReviewDecision(body.decision);
  const summary = await reviewVasLiteCase(
    workspaceRoot,
    options,
    tenant,
    project,
    caseId,
    decision,
    body,
    access,
    clientId,
    appendAuditEvent,
  );
  writeJson(res, 200, summary);
  return true;
}

async function handleClaimVasLiteCase(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 8) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases" || segments[7] !== "claim") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const project = requireSafeName(segments[3], "project");
  const caseId = requireSafeName(segments[6], "caseId");
  const body = await readVasCaseClaimJson(req);
  const clientId = optionalClientId(body.clientId);
  const action = vasLiteCaseClaimAction(body.action);
  const summary = await claimVasLiteCase(workspaceRoot, tenant, project, caseId, action, access, clientId, appendAuditEvent);
  writeJson(res, 200, summary);
  return true;
}

async function handleCreateVasLiteCaseReviewRun(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  options: HarnessServerOptions,
  activeRuns: Map<string, ActiveRun>,
  activeRunSlots: Map<string, ActiveRunSlot>,
  activeWorkspaces: Map<string, string>,
  queuedRuns: QueuedRun[],
  scheduleQueuedRuns: () => void,
  appendAuditEvent: TenantAuditAppender,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 8) return false;
  if (segments[0] !== "tenants" || segments[2] !== "projects" || segments[4] !== "vas" || segments[5] !== "cases" || segments[7] !== "review-runs") return false;

  const tenant = requireSafeName(segments[1], "tenant");
  const access = await requireTenantAccess(req, tenant, options, url, "developer");
  const project = requireSafeName(segments[3], "project");
  const caseId = requireSafeName(segments[6], "caseId");
  const body = await readVasCaseReviewRunJson(req);
  const projectRoot = join(workspaceRoot, tenant, project);
  await requireVasLiteProject(workspaceRoot, tenant, project, "vas-lite review runs require a vas-lite project template.");
  const record = await readVasLiteCase(projectRoot, caseId);

  const status = await createAsyncRunFromBody(
    workspaceRoot,
    options,
    activeRuns,
    activeRunSlots,
    activeWorkspaces,
    queuedRuns,
    scheduleQueuedRuns,
    appendAuditEvent,
    compactObject({
      tenant,
      project,
      preset: VAS_LITE_REVIEW_PRESET,
      presetInput: { caseId },
      async: true,
      queue: true,
      script: body.script,
      agentCommand: body.agentCommand,
      model: body.model,
      modelProtocol: body.modelProtocol,
      repo: vasLiteCaseRunMetadataDefault(body.repo, record, "repo"),
      branch: vasLiteCaseRunMetadataDefault(body.branch, record, "branch"),
      baseBranch: vasLiteCaseRunMetadataDefault(body.baseBranch, record, "baseBranch"),
      issue: vasLiteCaseRunMetadataDefault(body.issue, record, "issue"),
      pullRequest: body.pullRequest,
      reviewRequired: body.reviewRequired,
      deploymentRequired: body.deploymentRequired,
      syncIssueComments: body.syncIssueComments,
      verify: body.verify,
      evaluate: body.evaluate,
      reviewer: body.reviewer,
      skills: body.skills,
      allowedTools: body.allowedTools,
      maxIterations: body.maxIterations,
      clientId: body.clientId,
    }),
    access,
  );
  writeJson(res, 202, status);
  return true;
}

async function reviewVasLiteCase(
  workspaceRoot: string,
  options: HarnessServerOptions,
  tenant: string,
  project: string,
  caseId: string,
  decision: VasCaseReviewDecision,
  body: VasCaseReviewRequestBody,
  access: TenantAccess | undefined,
  clientId: string | undefined,
  appendAuditEvent: TenantAuditAppender,
): Promise<VasLiteCaseSummary> {
  const runId = optionalSafeName(body.runId, "runId");
  const projectRoot = join(workspaceRoot, tenant, project);
  await requireVasLiteProject(workspaceRoot, tenant, project);
  if (runId) await requireVasLiteReviewRunForCase(projectRoot, caseId, runId);
  const effectiveBody = vasLiteCaseReviewBodyWithDraft(
    body,
    runId ? await readVasLiteReviewDraft(projectRoot, caseId) : undefined,
  );

  const reviewed = vasLiteCaseReviewedRecord(await readVasLiteCase(projectRoot, caseId), decision, effectiveBody, access, clientId, runId);
  await writeJsonFileAtomic(join(projectRoot, "cases", caseId, "case.json"), reviewed);
  if (decision === "approved") {
    const learnings = textArray(effectiveBody.learnings, "learnings");
    await appendVasLiteLearnedPatterns(projectRoot, caseId, learnings, access, clientId, runId);
    await ingestVasLiteLearningSignal(options, appendAuditEvent, tenant, project, caseId, reviewed, learnings, access, clientId, runId);
  }
  const summary = vasLiteCaseSummary(caseId, reviewed);
  await appendAuditEvent(tenant, "vas_case_reviewed", compactObject({
    project,
    caseId,
    decision,
    status: summary.status,
    runId,
    clientId,
  }), access);
  if (decision === "approved") {
    await projectVasLiteLearningsToAgentGitServiceWikiMemory(
      workspaceRoot,
      options,
      appendAuditEvent,
      tenant,
      project,
      caseId,
      reviewed,
      textArray(effectiveBody.learnings, "learnings"),
      access,
      clientId,
      runId,
    );
  }
  return summary;
}

async function ingestVasLiteLearningSignal(
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  caseId: string,
  record: Record<string, unknown>,
  learnings: string[],
  access: TenantAccess | undefined,
  clientId: string | undefined,
  runId: string | undefined,
): Promise<void> {
  if (!options.brainSignalIngest || learnings.length === 0) return;
  const reviews = recordArray(record.reviews, "reviews");
  const latestReview = reviews[reviews.length - 1] ?? {};
  const ts = stringField(latestReview, "reviewedAt") ?? new Date().toISOString();
  const issue = stringField(record, "issue");
  const summaryUrl = options.publicUrl && runId ? runUrl(options.publicUrl, tenant, project, runId) : undefined;
  const signal: RunSignal = compactObject({
    ts,
    project,
    runId,
    status: "reviewed",
    issue,
    issueUrl: issue ? controlPlaneIssueUrl(options, issue) : undefined,
    dashboardUrl: options.publicUrl && runId ? runDashboardUrl(options.publicUrl, tenant, project, runId) : undefined,
    summaryUrl,
    reviewSummaryUrl: summaryUrl ? runEvidenceUrl(summaryUrl, "review-summary") : undefined,
    handoffPackageUrl: summaryUrl ? runEvidenceUrl(summaryUrl, "handoff-package") : undefined,
    handoffFollowupsUrl: summaryUrl ? runEvidenceUrl(summaryUrl, "handoff-runs") : undefined,
    skills: ["vas-lite", "coding"],
    outcome: "pass" as const,
    notes: vasLiteLearningSignalNotes(caseId, learnings),
  });
  await options.brainSignalIngest(signal);
  await appendAuditEvent(tenant, "brain_signal_ingested", compactObject({
    source: "vas_learning",
    project,
    caseId,
    runId,
    status: "reviewed",
    issue: signal.issue,
    issueUrl: signal.issueUrl,
    dashboardUrl: signal.dashboardUrl,
    summaryUrl: signal.summaryUrl,
    reviewSummaryUrl: signal.reviewSummaryUrl,
    handoffPackageUrl: signal.handoffPackageUrl,
    handoffFollowupsUrl: signal.handoffFollowupsUrl,
    outcome: signal.outcome,
    learningCount: learnings.length,
    skillCount: signal.skills.length,
    clientId,
  }), access);
}

async function projectVasLiteLearningsToAgentGitServiceWikiMemory(
  workspaceRoot: string,
  options: HarnessServerOptions,
  appendAuditEvent: TenantAuditAppender,
  tenant: string,
  project: string,
  caseId: string,
  record: Record<string, unknown>,
  learnings: string[],
  access: TenantAccess | undefined,
  clientId: string | undefined,
  runId: string | undefined,
): Promise<void> {
  if (controlPlaneProviderName(options) !== "agent-git-service" || learnings.length === 0) return;
  const baseUrl = options.controlPlaneBaseUrl?.trim();
  const token = options.controlPlaneAdminToken?.trim();
  if (!baseUrl || !token) return;
  const repo = stringField(record, "repo") ?? (await readProjectSourceDefaults(join(workspaceRoot, tenant), project)).repo;
  if (!repo) return;
  const readWikiMemory = options.agentGitServiceReadWikiMemory ?? readAgentGitServiceWikiMemory;
  const updateWikiMemory = options.agentGitServiceUpdateWikiMemory ?? updateAgentGitServiceWikiMemory;
  try {
    const current = await readWikiMemory({
      baseUrl,
      token,
      repo,
      page: AGENT_GIT_SERVICE_VAS_LEARNINGS_PAGE,
    });
    const updated = await updateWikiMemory({
      baseUrl,
      token,
      repo,
      page: AGENT_GIT_SERVICE_VAS_LEARNINGS_PAGE,
      body: agentGitServiceVasLearningMemoryBody(current.body, caseId, learnings, access, clientId, runId),
      message: `Record Loom VAS learning for ${project}/${caseId}`,
    });
    await appendAuditEvent(tenant, "agent_git_service_wiki_memory_updated", compactObject({
      provider: "agent-git-service",
      project,
      caseId,
      repo,
      page: updated.page,
      sha: updated.sha,
      url: updated.url,
      learningCount: learnings.length,
      clientId,
    }), access);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendAuditEvent(tenant, "agent_git_service_wiki_memory_failed", compactObject({
      provider: "agent-git-service",
      project,
      caseId,
      repo,
      page: AGENT_GIT_SERVICE_VAS_LEARNINGS_PAGE,
      learningCount: learnings.length,
      error: message,
      clientId,
    }), access);
  }
}

function agentGitServiceVasLearningMemoryBody(
  currentBody: string,
  caseId: string,
  learnings: string[],
  access: TenantAccess | undefined,
  clientId: string | undefined,
  runId: string | undefined,
): string {
  const header = "## Loom VAS learnings";
  const normalized = currentBody.endsWith("\n") || currentBody.length === 0 ? currentBody : `${currentBody}\n`;
  const prefix = normalized.includes(header)
    ? ""
    : `${normalized.length ? "\n" : ""}${header}\n\n`;
  const metadata = [
    `case=${caseId}`,
    runId ? `run=${runId}` : "",
    access?.actor ? `reviewedBy=${access.actor}` : "",
    access?.role ? `role=${access.role}` : "",
    clientId ? `clientId=${clientId}` : "",
  ].filter(Boolean).join(" ");
  const lines = learnings.map((learning) => `- ${metadata} :: ${oneLineText(learning)}`);
  return normalized + prefix + lines.join("\n") + "\n";
}

function vasLiteLearningSignalNotes(caseId: string, learnings: string[]): string {
  const text = learnings.map(oneLineText).join("; ");
  const bounded = text.length > 220 ? `${text.slice(0, 217)}...` : text;
  return `VAS learning approved for case ${caseId}: ${bounded}`;
}

async function claimVasLiteCase(
  workspaceRoot: string,
  tenant: string,
  project: string,
  caseId: string,
  action: VasCaseClaimAction,
  access: TenantAccess | undefined,
  clientId: string | undefined,
  appendAuditEvent: TenantAuditAppender,
): Promise<VasLiteCaseSummary> {
  const tenantRoot = join(workspaceRoot, tenant);
  const projectRoot = join(tenantRoot, project);
  await requireVasLiteProject(workspaceRoot, tenant, project);
  const record = await readVasLiteCase(projectRoot, caseId);
  const previousClaim = record.claim;
  const next = { ...record };
  let claim: VasLiteCaseClaim | undefined;
  if (action === "claim") {
    claim = compactObject({
      actor: access?.actor,
      role: access?.role,
      clientId,
      claimedAt: new Date().toISOString(),
    });
    next.claim = claim;
  } else {
    delete next.claim;
  }
  await writeJsonFileAtomic(join(projectRoot, "cases", caseId, "case.json"), next);
  const sourceDefaults = await readProjectSourceDefaults(tenantRoot, project);
  const runLinks = await vasLiteCaseRunLinks(projectRoot, tenant, project);
  const summary = vasLiteCaseSummary(caseId, next, runLinks.get(caseId), sourceDefaults);
  await appendAuditEvent(tenant, "vas_case_claimed", compactObject({
    project,
    caseId,
    action: action === "claim" ? "claimed" : "released",
    claimedAt: claim?.claimedAt,
    clientId,
    previousClaim,
  }), access);
  return summary;
}

async function requireVasLiteProject(workspaceRoot: string, tenant: string, project: string, message = "vas-lite cases require a vas-lite project template."): Promise<void> {
  const metadata = await requireProjectMetadata(workspaceRoot, tenant, project);
  if (metadata?.template !== "vas-lite") {
    throw badRequest(message);
  }
}

function vasLiteReviewPresetInput(value: unknown): VasLiteReviewPresetInput {
  if (value === undefined || value === null || value === "") return { caseId: "bootstrap" };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("presetInput must be an object.");
  }
  const input = value as Record<string, unknown>;
  return {
    caseId: optionalSafeName(input.caseId, "presetInput.caseId") ?? "bootstrap",
  };
}

async function readVasLiteCase(projectRoot: string, caseId: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(join(projectRoot, "cases", caseId, "case.json"), "utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    throw badRequest(`vas-lite case ${caseId} must be an object.`);
  } catch (error) {
    if (isNotFound(error)) throw badRequest(`vas-lite case not found: ${caseId}.`);
    if (error instanceof SyntaxError) throw badRequest(`vas-lite case ${caseId} has invalid JSON.`);
    throw error;
  }
}

async function listVasLiteCases(projectRoot: string, tenant: string, project: string, sourceDefaults: ProjectSourceDefaultValues = {}): Promise<VasLiteCaseSummary[]> {
  let entries;
  try {
    entries = await readdir(join(projectRoot, "cases"), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const runLinks = await vasLiteCaseRunLinks(projectRoot, tenant, project);
  const cases = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isSafeDirectoryName(entry.name))
      .map(async (entry) => {
        const record = await readVasLiteCaseForScan(projectRoot, entry.name);
        return record ? vasLiteCaseSummary(entry.name, record, runLinks.get(entry.name), sourceDefaults) : undefined;
      }),
  );
  const readable = cases.filter((item): item is VasLiteCaseSummary => item !== undefined);
  readable.sort((a, b) => a.id.localeCompare(b.id));
  return readable;
}

async function listVasLiteReviewQueue(
  tenant: string,
  project: string,
  projectRoot: string,
  sourceDefaults: ProjectSourceDefaultValues = {},
): Promise<VasLiteReviewQueueItem[]> {
  const cases = await listVasLiteCases(projectRoot, tenant, project, sourceDefaults);
  return cases.flatMap((item) => {
    const reasons = vasLiteReviewQueueReasons(item);
    if (!reasons.length) return [];
    const basePath = `/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/vas/cases/${encodeURIComponent(item.id)}`;
    return [{
      ...item,
      reasons,
      links: {
        reviewPackage: `${basePath}/review-package`,
        runs: `${basePath}/runs`,
        artifacts: `${basePath}/artifacts`,
        review: `${basePath}/review`,
        reviewRuns: `${basePath}/review-runs`,
      },
    }];
  });
}

function vasLiteReviewQueueReasons(item: VasLiteCaseSummary): VasLiteReviewQueueReason[] {
  const reasons: VasLiteReviewQueueReason[] = [];
  if ((item.unreviewedRunCount ?? 0) > 0) reasons.push("unreviewed_run");
  if (item.status === "needs_review") reasons.push("needs_review");
  if (item.status === "needs_revision") reasons.push("needs_revision");
  return reasons;
}

async function vasLiteCaseRunLinks(projectRoot: string, tenant: string, project: string): Promise<Map<string, VasLiteCaseRunLink>> {
  const links = new Map<string, VasLiteCaseRunLink>();
  for (const { caseId, state } of await vasLiteRunStates(projectRoot, tenant, project)) {
    const current = links.get(caseId);
    if (current) {
      current.runCount += 1;
      current.runIds.push(state.runId);
      continue;
    }
    links.set(caseId, {
      runCount: 1,
      runIds: [state.runId],
      latestRunId: state.runId,
      latestRunStatus: state.status,
      latestRunStartedAt: startedAt(state),
    });
  }
  return links;
}

async function vasLiteRunStates(projectRoot: string, tenant: string, project: string): Promise<VasLiteRunState[]> {
  let states: ReadableRunState[];
  const runsRoot = join(projectRoot, ".loom", "runs");
  try {
    states = await readRunStatesForListing(runsRoot, tenant, project);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return states
    .flatMap((state) => {
      const caseId = vasLiteRunCaseId(state);
      return caseId ? [{ caseId, state }] : [];
    })
    .sort((a, b) => startedAt(b.state).localeCompare(startedAt(a.state)));
}

async function listVasLiteLearnings(projectRoot: string): Promise<VasLiteLearningSummary[]> {
  let entries;
  try {
    entries = await readdir(join(projectRoot, "cases"), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const cases = entries
    .filter((entry) => entry.isDirectory() && isSafeDirectoryName(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const learnings: VasLiteLearningSummary[] = [];
  for (const entry of cases) {
    const record = await readVasLiteCaseForScan(projectRoot, entry.name);
    if (record) learnings.push(...vasLiteLearningSummaries(entry.name, record));
  }
  return learnings;
}

async function readVasLiteCaseForScan(projectRoot: string, caseId: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await readVasLiteCase(projectRoot, caseId);
  } catch (error) {
    if (error instanceof Error && error.name === "BadRequest") return undefined;
    throw error;
  }
}

function vasLiteCaseSummary(
  caseId: string,
  record: Record<string, unknown>,
  runLink?: VasLiteCaseRunLink,
  sourceDefaults: ProjectSourceDefaultValues = {},
): VasLiteCaseSummary {
  const repo = stringField(record, "repo");
  const branch = stringField(record, "branch");
  const baseBranch = stringField(record, "baseBranch");
  const issue = stringField(record, "issue");
  const sourceDefaultFields = vasLiteCaseSourceDefaultFields(record, sourceDefaults);
  return compactObject({
    id: caseId,
    status: typeof record.status === "string" ? record.status : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
    source: record.source,
    repo: repo ?? sourceDefaults.repo,
    branch: branch ?? sourceDefaults.branch,
    baseBranch: baseBranch ?? sourceDefaults.baseBranch,
    issue: issue ?? sourceDefaults.issue,
    sourceDefaultFields: sourceDefaultFields.length ? sourceDefaultFields : undefined,
    path: `cases/${caseId}/case.json`,
    reportPath: `cases/${caseId}/reports/latest.md`,
    reviewCount: arrayCount(record.reviews),
    correctionCount: arrayCount(record.corrections),
    learningCount: arrayCount(record.learnings),
    runCount: runLink?.runCount,
    ...vasLiteCaseRunReviewCoverage(record, runLink),
    latestRunId: runLink?.latestRunId,
    latestRunStatus: runLink?.latestRunStatus,
    latestRunStartedAt: runLink?.latestRunStartedAt,
    claim: vasLiteCaseClaim(record.claim),
  });
}

function vasLiteCaseClaim(value: unknown): VasLiteCaseClaim | undefined {
  const data = recordData(value);
  const claimedAt = stringField(data, "claimedAt");
  if (!claimedAt) return undefined;
  return compactObject({
    actor: stringField(data, "actor"),
    role: tenantRoleField(data, "role"),
    clientId: stringField(data, "clientId"),
    claimedAt,
  });
}

function vasLiteCaseSourceDefaultFields(
  record: Record<string, unknown>,
  sourceDefaults: ProjectSourceDefaultValues,
): Array<"repo" | "branch" | "baseBranch" | "issue"> {
  const fields: Array<"repo" | "branch" | "baseBranch" | "issue"> = [];
  for (const field of ["repo", "branch", "baseBranch", "issue"] as const) {
    if (stringField(record, field) === undefined && sourceDefaults[field] !== undefined) fields.push(field);
  }
  return fields;
}

function vasLiteCaseRunReviewCoverage(
  record: Record<string, unknown>,
  runLink?: VasLiteCaseRunLink,
): Pick<VasLiteCaseSummary, "reviewedRunCount" | "unreviewedRunCount" | "latestRunReviewDecision" | "latestRunReviewedAt"> {
  if (!runLink) return {};
  const runIds = new Set(runLink.runIds);
  const reviews = [...vasLiteCaseRunReviewMap(record).entries()]
    .filter(([runId]) => runIds.has(runId))
    .map(([runId, review]) => ({ runId, ...review }));
  const reviewedRunIds = new Set(reviews.map((review) => review.runId));
  const latestRunReview = reviews
    .filter((review) => review.runId === runLink.latestRunId)
    .sort((a, b) => (b.reviewedAt ?? "").localeCompare(a.reviewedAt ?? ""))[0];
  return compactObject({
    reviewedRunCount: reviewedRunIds.size,
    unreviewedRunCount: Math.max(0, runLink.runCount - reviewedRunIds.size),
    latestRunReviewDecision: latestRunReview?.decision,
    latestRunReviewedAt: latestRunReview?.reviewedAt,
  });
}

function vasLiteRunCaseId(state: ReadableRunState): string | undefined {
  if (state.metadata?.runPreset !== VAS_LITE_REVIEW_PRESET) return undefined;
  const caseId = stringField(recordData(state.metadata.runPresetInput), "caseId")?.trim();
  return caseId || "bootstrap";
}

async function requireVasLiteReviewRunForCase(projectRoot: string, caseId: string, runId: string): Promise<void> {
  let state: ReadableRunState;
  try {
    state = await readRunState(join(projectRoot, ".loom", "runs", runId));
  } catch (error) {
    if (isNotFound(error)) throw badRequest(`runId not found for vas-lite review: ${runId}.`);
    throw error;
  }
  const runCaseId = vasLiteRunCaseId(state);
  if (runCaseId !== caseId) {
    throw badRequest(`runId must reference a vas-lite-review run for case ${caseId}.`);
  }
}

async function vasLiteCaseRunSummaries(projectRoot: string, tenant: string, project: string, caseId: string, record: Record<string, unknown>): Promise<VasLiteCaseRunSummary[]> {
  const reviews = vasLiteCaseRunReviewMap(record);
  return Promise.all(
    (await vasLiteRunStates(projectRoot, tenant, project))
      .filter((entry) => entry.caseId === caseId)
      .map(async ({ state }) => {
        const review = reviews.get(state.runId);
        const artifacts = await vasLiteRunArtifactEvidence(projectRoot, state.runId, caseId);
        const failureKind = isRunSummaryState(state) ? brainSignalFailureKind(state) : undefined;
        return compactObject({
          runId: state.runId,
          status: state.status,
          goal: state.goal,
          startedAt: startedAt(state),
          endedAt: "endedAt" in state ? state.endedAt : undefined,
          agentMode: state.metadata?.agentMode,
          model: state.metadata?.model,
          issue: state.metadata?.issue,
          issueUrl: state.metadata?.issueUrl,
          summaryUrl: state.metadata?.summaryUrl,
          reviewSummaryUrl: runEvidencePath(tenant, project, state.runId, "review-summary"),
          handoffPackageUrl: runEvidencePath(tenant, project, state.runId, "handoff-package"),
          pullRequestIndex: state.metadata?.pullRequestIndex,
          pullRequestUrl: state.metadata?.pullRequestUrl,
          reviewGateStatus: "review" in state ? state.review?.status : undefined,
          deploymentGateStatus: "deployment" in state ? state.deployment?.status : undefined,
          failureKind,
          reviewerFocus: failureKind ? reviewerFocusForFailureKind(failureKind) : undefined,
          error: "error" in state ? publicRunErrorSummary(state.error) : undefined,
          ...artifacts,
          runPresetInput: state.metadata?.runPresetInput,
          reviewStatus: review ? "reviewed" as const : "unreviewed" as const,
          reviewDecision: review?.decision,
          reviewedAt: review?.reviewedAt,
          reviewedBy: review?.actor,
          reviewedRole: review?.role,
          reviewedClientId: review?.clientId,
        });
      }),
  );
}

async function vasLiteRunArtifactEvidence(
  projectRoot: string,
  runId: string,
  caseId: string,
): Promise<Pick<VasLiteCaseRunSummary, "contextPath" | "reportPath" | "reviewDraftPath" | "contextWritten" | "reportWritten" | "reviewDraftWritten">> {
  const contextPath = vasLiteReviewContextPath(caseId);
  const reportPath = vasLiteReviewReportPath(caseId);
  const reviewDraftPath = vasLiteReviewDraftPath(caseId);
  const writtenPaths = await vasLiteRunWrittenFilePaths(join(projectRoot, ".loom", "runs", runId));
  return {
    contextPath,
    reportPath,
    reviewDraftPath,
    contextWritten: writtenPaths.has(contextPath),
    reportWritten: writtenPaths.has(reportPath),
    reviewDraftWritten: writtenPaths.has(reviewDraftPath),
  };
}

async function vasLiteRunWrittenFilePaths(runDir: string): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const event of await readRunEventsIfPresent(runDir)) {
    if (event.type !== "action") continue;
    const action = recordData(event.data);
    if (stringField(action, "toolName") !== "file.write") continue;
    const path = stringField(recordData(action.input), "path")?.trim();
    if (path) paths.add(normalizeVasLiteArtifactPath(path));
  }
  return paths;
}

function normalizeVasLiteArtifactPath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/"));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function vasLiteCaseRunReviewMap(record: Record<string, unknown>): Map<string, { decision?: VasCaseReviewDecision; reviewedAt?: string; actor?: string; role?: TenantRole; clientId?: string }> {
  const reviews = new Map<string, { decision?: VasCaseReviewDecision; reviewedAt?: string; actor?: string; role?: TenantRole; clientId?: string }>();
  for (const entry of recordArray(record.reviews, "reviews")) {
    const runId = stringField(entry, "runId");
    if (!runId) continue;
    const review = compactObject({
      decision: vasLiteCaseReviewDecisionField(entry, "decision"),
      reviewedAt: stringField(entry, "reviewedAt"),
      actor: stringField(entry, "actor"),
      role: tenantRoleField(entry, "role"),
      clientId: stringField(entry, "clientId"),
    });
    const previous = reviews.get(runId);
    if (!previous || (review.reviewedAt ?? "") >= (previous.reviewedAt ?? "")) {
      reviews.set(runId, review);
    }
  }
  return reviews;
}

function vasLiteLearningSummaries(caseId: string, record: Record<string, unknown>): VasLiteLearningSummary[] {
  return recordArray(record.learnings, "learnings").flatMap((entry) => {
    const text = stringField(entry, "text")?.trim();
    if (!text) return [];
    return [compactObject({
      caseId,
      text,
      source: stringField(entry, "source"),
      reviewDecision: vasLiteCaseReviewDecisionField(entry, "reviewDecision"),
      reviewedAt: stringField(entry, "reviewedAt"),
      actor: stringField(entry, "actor"),
      role: tenantRoleField(entry, "role"),
      clientId: stringField(entry, "clientId"),
      runId: stringField(entry, "runId"),
    })];
  });
}

function vasLiteReviewGuidance(record: Record<string, unknown>): VasLiteReviewGuidance {
  const reviews = latestVasLiteGuidanceItems(
    recordArray(record.reviews, "reviews").map(vasLiteReviewGuidanceReview),
  );
  const corrections = latestVasLiteGuidanceItems(
    recordArray(record.corrections, "corrections").flatMap(vasLiteReviewGuidanceText),
  );
  const learnings = latestVasLiteGuidanceItems(
    recordArray(record.learnings, "learnings").flatMap(vasLiteReviewGuidanceText),
  );
  return compactObject({
    reviewCount: arrayCount(record.reviews),
    correctionCount: arrayCount(record.corrections),
    learningCount: arrayCount(record.learnings),
    latestReview: reviews[0],
    recentReviews: reviews.length ? reviews : undefined,
    corrections: corrections.length ? corrections : undefined,
    learnings: learnings.length ? learnings : undefined,
  });
}

function vasLiteReviewGuidanceReview(entry: Record<string, unknown>): VasLiteReviewGuidanceReview {
  return compactObject({
    decision: vasLiteCaseReviewDecisionField(entry, "decision"),
    note: stringField(entry, "note"),
    reviewedAt: stringField(entry, "reviewedAt"),
    actor: stringField(entry, "actor"),
    role: tenantRoleField(entry, "role"),
    clientId: stringField(entry, "clientId"),
    runId: stringField(entry, "runId"),
  });
}

function vasLiteReviewGuidanceText(entry: Record<string, unknown>): VasLiteReviewGuidanceText[] {
  const text = stringField(entry, "text")?.trim();
  if (!text) return [];
  return [compactObject({
    text,
    source: stringField(entry, "source"),
    reviewDecision: vasLiteCaseReviewDecisionField(entry, "reviewDecision"),
    reviewedAt: stringField(entry, "reviewedAt"),
    actor: stringField(entry, "actor"),
    role: tenantRoleField(entry, "role"),
    clientId: stringField(entry, "clientId"),
    runId: stringField(entry, "runId"),
  })];
}

function latestVasLiteGuidanceItems<T>(items: T[]): T[] {
  return items.slice(-VAS_LITE_REVIEW_GUIDANCE_LIMIT).reverse();
}

async function vasLiteCaseArtifacts(projectRoot: string, project: string, caseId: string): Promise<VasLiteCaseArtifactsResponse> {
  const contextPath = vasLiteReviewContextPath(caseId);
  const reportPath = vasLiteReviewReportPath(caseId);
  const reviewDraftPath = vasLiteReviewDraftPath(caseId);
  return compactObject({
    project,
    template: "vas-lite" as const,
    caseId,
    contextPath,
    reportPath,
    reviewDraftPath,
    context: await readOptionalJsonObject(join(projectRoot, ...contextPath.split("/")), `${contextPath}`),
    report: await readOptionalTextFile(join(projectRoot, ...reportPath.split("/"))),
    reviewDraft: await readVasLiteReviewDraft(projectRoot, caseId),
  });
}

async function vasLiteCaseReviewPackage(
  projectRoot: string,
  tenant: string,
  project: string,
  caseId: string,
  record: Record<string, unknown>,
  sourceDefaults: ProjectSourceDefaultValues,
  auditTrail: TenantAuditEvent[],
): Promise<VasLiteCaseReviewPackageResponse> {
  const basePath = `/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/vas/cases/${encodeURIComponent(caseId)}`;
  const runLinks = await vasLiteCaseRunLinks(projectRoot, tenant, project);
  return {
    project,
    template: "vas-lite",
    caseId,
    case: vasLiteCaseSummary(caseId, record, runLinks.get(caseId), sourceDefaults),
    artifacts: await vasLiteCaseArtifacts(projectRoot, project, caseId),
    runs: await vasLiteCaseRunSummaries(projectRoot, tenant, project, caseId, record),
    reviews: recordArray(record.reviews, "reviews"),
    corrections: recordArray(record.corrections, "corrections"),
    learnings: vasLiteLearningSummaries(caseId, record),
    issueCommentSeeds: issueCommentSeedEvidence(auditTrail),
    auditTrail,
    links: {
      artifacts: `${basePath}/artifacts`,
      runs: `${basePath}/runs`,
      review: `${basePath}/review`,
      reviewRuns: `${basePath}/review-runs`,
    },
  };
}

async function readVasLiteReviewDraft(projectRoot: string, caseId: string): Promise<Record<string, unknown> | undefined> {
  const draftPath = vasLiteReviewDraftPath(caseId);
  const draft = await readOptionalJsonObject(join(projectRoot, ...draftPath.split("/")), draftPath);
  if (!draft) return undefined;
  const preset = stringField(draft, "preset");
  if (preset && preset !== VAS_LITE_REVIEW_PRESET) {
    throw badRequest(`${draftPath} preset must be ${VAS_LITE_REVIEW_PRESET}.`);
  }
  const draftCaseId = stringField(draft, "caseId")?.trim();
  if (draftCaseId && draftCaseId !== caseId) {
    throw badRequest(`${draftPath} caseId must match ${caseId}.`);
  }
  return draft;
}

function vasLiteCaseReviewBodyWithDraft(
  body: VasCaseReviewRequestBody,
  draft: Record<string, unknown> | undefined,
): VasCaseReviewRequestBody {
  if (!draft) return body;
  return {
    ...body,
    note: body.note === undefined ? draft.note : body.note,
    corrections: body.corrections === undefined ? draft.corrections : body.corrections,
    learnings: body.learnings === undefined ? draft.learnings : body.learnings,
  };
}

function vasLiteCaseRecord(
  caseId: string,
  title: string | undefined,
  source: Record<string, unknown>,
  metadata: Pick<VasLiteCaseSummary, "repo" | "branch" | "baseBranch" | "issue"> = {},
): Record<string, unknown> {
  return compactObject({
    id: caseId,
    title,
    status: "needs_review",
    source,
    repo: metadata.repo,
    branch: metadata.branch,
    baseBranch: metadata.baseBranch,
    issue: metadata.issue,
    artifacts: {
      frames: "frames/",
      reconstruction: "reconstruction/index.html",
    },
    states: [],
    events: [],
    beats: [],
    uncertainties: [],
    corrections: [],
    reviews: [],
    learnings: [],
  });
}

function vasLiteCaseRunMetadataDefault(value: unknown, record: Record<string, unknown>, key: "repo" | "branch" | "baseBranch" | "issue"): unknown {
  return hasRequestValue(value) ? value : stringField(record, key);
}

function vasLiteCaseReviewedRecord(
  record: Record<string, unknown>,
  decision: VasCaseReviewDecision,
  body: VasCaseReviewRequestBody,
  access: TenantAccess | undefined,
  clientId: string | undefined,
  runId: string | undefined,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const note = optionalString(body.note, "note");
  const corrections = textArray(body.corrections, "corrections");
  const learnings = textArray(body.learnings, "learnings");
  const context = compactObject({
    reviewedAt: now,
    actor: access?.actor,
    role: access?.role,
    clientId,
    runId,
    reviewDecision: decision,
  });
  const reviewEntry = compactObject({
    decision,
    note,
    reviewedAt: now,
    actor: access?.actor,
    role: access?.role,
    clientId,
    runId,
    corrections,
    learnings,
  });
  return {
    ...record,
    status: decision === "approved" ? "reviewed" : "needs_revision",
    reviews: [...recordArray(record.reviews, "reviews"), reviewEntry],
    corrections: [
      ...recordArray(record.corrections, "corrections"),
      ...corrections.map((text) => ({ ...context, text })),
    ],
    learnings: [
      ...recordArray(record.learnings, "learnings"),
      ...learnings.map((text) => ({ ...context, source: "review", text })),
    ],
  };
}

function vasLiteCaseSource(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return { kind: "placeholder", url: "", range: { start: 0, end: 0 } };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("source must be an object.");
  }
  const input = value as Record<string, unknown>;
  return {
    kind: optionalString(input.kind, "source.kind") ?? "placeholder",
    url: optionalString(input.url, "source.url") ?? "",
    range: vasLiteCaseSourceRange(input.range),
  };
}

function vasLiteCaseSourceRange(value: unknown): { start: number; end: number } {
  if (value === undefined || value === null) return { start: 0, end: 0 };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("source.range must be an object.");
  }
  const input = value as Record<string, unknown>;
  const start = nonNegativeNumberValue(input.start, "source.range.start");
  const end = nonNegativeNumberValue(input.end, "source.range.end");
  if (end < start) throw badRequest("source.range.end must be greater than or equal to source.range.start.");
  return { start, end };
}

function vasLiteCaseReviewDecision(value: unknown): VasCaseReviewDecision {
  if (value === "approved" || value === "changes_requested") return value;
  throw badRequest("decision must be approved or changes_requested.");
}

function vasLiteCaseClaimAction(value: unknown): VasCaseClaimAction {
  if (value === undefined || value === null || value === "" || value === "claim") return "claim";
  if (value === "release") return "release";
  throw badRequest("action must be claim or release.");
}

function vasLiteCaseReviewDecisionField(data: Record<string, unknown>, key: string): VasCaseReviewDecision | undefined {
  const value = data[key];
  return value === "approved" || value === "changes_requested" ? value : undefined;
}

async function appendVasLiteLearnedPatterns(
  projectRoot: string,
  caseId: string,
  learnings: string[],
  access: TenantAccess | undefined,
  clientId: string | undefined,
  runId: string | undefined,
): Promise<void> {
  if (learnings.length === 0) return;
  const path = join(projectRoot, "vocabulary", "learned-patterns.md");
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const header = "## Review-sourced Learnings";
  const prefix = content.includes(header)
    ? (content.endsWith("\n") ? "" : "\n")
    : `${content.endsWith("\n") || !content ? "" : "\n"}\n${header}\n\n`;
  const metadata = [
    `case=${caseId}`,
    runId ? `run=${runId}` : "",
    access?.actor ? `reviewedBy=${access.actor}` : "",
    access?.role ? `role=${access.role}` : "",
    clientId ? `clientId=${clientId}` : "",
  ].filter(Boolean).join(" ");
  const lines = learnings.map((learning) => `- ${metadata} :: ${oneLineText(learning)}`);
  await mkdir(join(projectRoot, "vocabulary"), { recursive: true });
  await appendFile(path, prefix + lines.join("\n") + "\n", "utf8");
}

function vasLiteReviewGoal(caseId: string): string {
  return caseId === "bootstrap" ? VAS_LITE_REVIEW_GOAL : `Review VAS Lite case ${caseId}`;
}

function vasLiteReviewScript(
  input: VasLiteReviewPresetInput,
  caseRecord: Record<string, unknown>,
  priorLearnings: VasLiteLearningSummary[],
  reviewGuidance: VasLiteReviewGuidance,
): AgentStep[] {
  return [
    {
      message: "write VAS Lite review report",
      plan: "record the case review artifact and prior learnings for the VAS Lite loop",
      actions: [
        vasLiteReviewContextWriteAction(input, caseRecord, priorLearnings, reviewGuidance),
        {
          toolName: "file.write",
          input: {
            path: vasLiteReviewReportPath(input.caseId),
            content: vasLiteReviewReport(input.caseId, caseRecord, priorLearnings, reviewGuidance),
          },
        },
      ],
    },
    { message: "finish VAS Lite review preset", finish: true },
  ];
}

function vasLiteReviewContextStep(
  input: VasLiteReviewPresetInput,
  caseRecord: Record<string, unknown>,
  priorLearnings: VasLiteLearningSummary[],
  reviewGuidance: VasLiteReviewGuidance,
): AgentStep {
  return {
    message: "prepare VAS Lite review context",
    plan: "write structured VAS Lite context before the selected agent runs",
    actions: [vasLiteReviewContextWriteAction(input, caseRecord, priorLearnings, reviewGuidance)],
  };
}

function vasLiteReviewContextWriteAction(
  input: VasLiteReviewPresetInput,
  caseRecord: Record<string, unknown>,
  priorLearnings: VasLiteLearningSummary[],
  reviewGuidance: VasLiteReviewGuidance,
): NonNullable<AgentStep["actions"]>[number] {
  return {
    toolName: "file.write",
    input: {
      path: vasLiteReviewContextPath(input.caseId),
      content: JSON.stringify(vasLiteReviewContext(input, caseRecord, priorLearnings, reviewGuidance), null, 2) + "\n",
    },
  };
}

function vasLiteReviewReportPath(caseId: string): string {
  return VAS_LITE_REVIEW_REPORT_PATH.replace("bootstrap", caseId);
}

function vasLiteReviewContextPath(caseId: string): string {
  return VAS_LITE_REVIEW_CONTEXT_PATH.replace("bootstrap", caseId);
}

function vasLiteReviewDraftPath(caseId: string): string {
  return VAS_LITE_REVIEW_DRAFT_PATH.replace("bootstrap", caseId);
}

function vasLiteReviewContext(
  input: VasLiteReviewPresetInput,
  caseRecord: Record<string, unknown>,
  priorLearnings: VasLiteLearningSummary[],
  reviewGuidance: VasLiteReviewGuidance,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    preset: VAS_LITE_REVIEW_PRESET,
    loop: VAS_LITE_LOOP,
    caseId: input.caseId,
    case: caseRecord,
    priorLearningCount: priorLearnings.length,
    priorLearnings,
    reviewGuidance,
    reportPath: vasLiteReviewReportPath(input.caseId),
    reviewDraftPath: vasLiteReviewDraftPath(input.caseId),
    reviewChecklist: vasLiteReviewChecklist(input.caseId),
  };
}

function vasLiteReviewReport(
  caseId: string,
  caseRecord: Record<string, unknown>,
  priorLearnings: VasLiteLearningSummary[],
  reviewGuidance: VasLiteReviewGuidance,
): string {
  const source = vasLiteCaseSourceLabel(caseRecord);
  return [
    "# VAS Lite Review",
    "",
    "preset=vas-lite-review",
    `case=${caseId}`,
    source ? `source=${source}` : "",
    `loop=${VAS_LITE_LOOP}`,
    `reviewDraft=${vasLiteReviewDraftPath(caseId)}`,
    "",
    ...vasLiteReviewChecklist(caseId).map((item) => `- ${item}`),
    "",
    "## Prior Learnings",
    "",
    ...vasLitePriorLearningLines(priorLearnings),
    "",
    "## Current Case Review Guidance",
    "",
    ...vasLiteReviewGuidanceLines(reviewGuidance),
    "",
  ].filter((line) => line !== "").join("\n") + "\n";
}

function vasLiteReviewChecklist(caseId: string): string[] {
  return [
    `Review the ${caseId} case.`,
    "Replace placeholder evidence with a real clip.",
    "Keep unresolved ambiguity in uncertainties.",
    "Turn reviewed corrections into vocabulary updates.",
  ];
}

function vasLitePriorLearningLines(priorLearnings: VasLiteLearningSummary[]): string[] {
  if (!priorLearnings.length) return ["- No prior approved learnings."];
  return priorLearnings.map((learning) => `- case=${learning.caseId} :: ${oneLineText(learning.text)}`);
}

function vasLiteReviewGuidanceLines(reviewGuidance: VasLiteReviewGuidance): string[] {
  const lines = [
    `- reviews=${reviewGuidance.reviewCount} corrections=${reviewGuidance.correctionCount} learnings=${reviewGuidance.learningCount}`,
  ];
  if (!reviewGuidance.latestReview && !reviewGuidance.corrections?.length && !reviewGuidance.learnings?.length) {
    return [...lines, "- No current case review guidance."];
  }
  if (reviewGuidance.latestReview) {
    const metadata = vasLiteReviewGuidanceMetadata(reviewGuidance.latestReview);
    const note = reviewGuidance.latestReview.note ? ` :: ${oneLineText(reviewGuidance.latestReview.note)}` : "";
    lines.push(`- latest_review=${reviewGuidance.latestReview.decision ?? "unknown"}${metadata}${note}`);
  }
  for (const correction of reviewGuidance.corrections ?? []) {
    lines.push(`- correction${vasLiteReviewGuidanceMetadata(correction)} :: ${oneLineText(correction.text)}`);
  }
  for (const learning of reviewGuidance.learnings ?? []) {
    lines.push(`- case_learning${vasLiteReviewGuidanceMetadata(learning)} :: ${oneLineText(learning.text)}`);
  }
  return lines;
}

function vasLiteReviewGuidanceMetadata(entry: VasLiteReviewGuidanceReview | VasLiteReviewGuidanceText): string {
  const metadata = [
    entry.reviewedAt ? `reviewedAt=${entry.reviewedAt}` : "",
    entry.runId ? `run=${entry.runId}` : "",
    "reviewDecision" in entry && entry.reviewDecision ? `decision=${entry.reviewDecision}` : "",
    entry.actor ? `reviewedBy=${entry.actor}` : "",
    entry.role ? `role=${entry.role}` : "",
    entry.clientId ? `clientId=${entry.clientId}` : "",
  ].filter(Boolean).join(" ");
  return metadata ? ` (${metadata})` : "";
}

function vasLiteCaseSourceLabel(caseRecord: Record<string, unknown>): string | undefined {
  const source = caseRecord.source;
  if (typeof source !== "object" || source === null || Array.isArray(source)) return undefined;
  const data = source as Record<string, unknown>;
  if (typeof data.url === "string" && data.url.trim()) return data.url.trim();
  if (typeof data.kind === "string" && data.kind.trim()) return data.kind.trim();
  return undefined;
}

async function readVasLiteProjectReadiness(
  projectRoot: string,
  tenant: string,
  project: string,
): Promise<Pick<ProjectSummary, "vasCaseCount" | "vasNeedsReviewCaseCount" | "vasReviewedRunCount" | "vasUnreviewedRunCount">> {
  const cases = await listVasLiteCases(projectRoot, tenant, project);
  return {
    vasCaseCount: cases.length,
    vasNeedsReviewCaseCount: cases.filter((item) => item.status !== "reviewed").length,
    vasReviewedRunCount: cases.reduce((total, item) => total + (item.reviewedRunCount ?? 0), 0),
    vasUnreviewedRunCount: cases.reduce((total, item) => total + (item.unreviewedRunCount ?? 0), 0),
  };
}

function runReviewVasEvidence(state: ReadableRunState, tenant?: string, project?: string): RunReviewVasEvidence | undefined {
  const caseId = vasLiteRunCaseId(state);
  const currentTenant = tenant ?? state.metadata?.tenant;
  const currentProject = project ?? state.metadata?.project;
  if (!caseId || !currentTenant || !currentProject) return undefined;
  const basePath = `/tenants/${encodeURIComponent(currentTenant)}/projects/${encodeURIComponent(currentProject)}/vas/cases/${encodeURIComponent(caseId)}`;
  return {
    preset: VAS_LITE_REVIEW_PRESET,
    caseId,
    links: {
      artifacts: `${basePath}/artifacts`,
      runs: `${basePath}/runs`,
      reviewPackage: `${basePath}/review-package`,
      reviewRuns: `${basePath}/review-runs`,
    },
  };
}

function vasLiteCaseTenantAuditTrail(events: TenantAuditEvent[], project: string, caseId: string): TenantAuditEvent[] {
  return events.filter((event) => {
    const data = recordData(event.data);
    if (data.project !== project) return false;
    if (data.caseId === caseId) return true;
    return recordData(data.presetInput).caseId === caseId;
  });
}

async function linkedIssueVasCases(workspaceRoot: string, tenant: string, issue: string, project?: string): Promise<LinkedIssueVasCase[]> {
  const projects = project ? [project] : await listTenantProjectNames(workspaceRoot, tenant);
  const cases: LinkedIssueVasCase[] = [];
  for (const currentProject of projects) {
    const projectRoot = join(workspaceRoot, tenant, currentProject);
    const metadata = await readProjectTemplateMetadata(projectRoot, { tenant, project: currentProject });
    if (metadata?.template !== "vas-lite") continue;
    const sourceDefaults = await readProjectSourceDefaults(join(workspaceRoot, tenant), currentProject);
    let entries;
    try {
      entries = await readdir(join(projectRoot, "cases"), { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = await readVasLiteCase(projectRoot, entry.name);
      if ((stringField(record, "issue") ?? sourceDefaults.issue) !== issue) continue;
      cases.push({ project: currentProject, caseId: entry.name, record });
    }
  }
  cases.sort((a, b) => a.project.localeCompare(b.project) || a.caseId.localeCompare(b.caseId));
  return cases;
}

function linkedVasCaseIdsByProject(runs: LinkedIssueRun[], linkedCases: LinkedIssueVasCase[] = []): Map<string, Set<string>> {
  const caseIds = new Map<string, Set<string>>();
  for (const run of runs) {
    const caseId = vasLiteRunCaseId(run.state);
    if (!caseId) continue;
    const projectCases = caseIds.get(run.project) ?? new Set<string>();
    projectCases.add(caseId);
    caseIds.set(run.project, projectCases);
  }
  for (const entry of linkedCases) {
    const projectCases = caseIds.get(entry.project) ?? new Set<string>();
    projectCases.add(entry.caseId);
    caseIds.set(entry.project, projectCases);
  }
  return caseIds;
}

export { VasLiteReviewPresetInput, VasCaseCreateRequestBody, VasCaseReviewRequestBody, VasCaseClaimRequestBody, VasCaseReviewRunRequestBody, VasCaseReviewDecision, VasCaseClaimAction, RunReviewVasEvidence, VAS_LITE_REVIEW_PRESET, VAS_LITE_REVIEW_VERIFY_COMMANDS, handleListVasLiteCases, handleListVasLiteReviewQueue, handleListVasLiteLearnings, handleReadVasLiteCaseArtifacts, handleReadVasLiteCaseReviewPackage, handleListVasLiteCaseRuns, handleCreateVasLiteCase, handleReviewVasLiteCase, handleClaimVasLiteCase, handleCreateVasLiteCaseReviewRun, reviewVasLiteCase, claimVasLiteCase, requireVasLiteProject, vasLiteReviewPresetInput, readVasLiteCase, listVasLiteLearnings, vasLiteRunCaseId, vasLiteReviewGuidance, vasLiteCaseClaimAction, vasLiteCaseReviewDecisionField, vasLiteReviewGoal, vasLiteReviewScript, vasLiteReviewContextStep, readVasLiteProjectReadiness, runReviewVasEvidence, linkedIssueVasCases, linkedVasCaseIdsByProject };
