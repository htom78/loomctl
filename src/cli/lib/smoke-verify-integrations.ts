import { type ProjectTemplateName } from "../../harness/project-templates.js";
import { type ControlPlaneProviderName } from "../../harness/server.js";
import { isRecord } from "./flags.js";
import { runUrl } from "./reporters.js";
import { requireSmokeStringArray } from "./smoke-verify-platform.js";
import { verifySmokePresence, verifySmokeRunCommentReplay } from "./smoke-verify-runs.js";
import { arrayFieldFromResponse, booleanFieldFromResponse, type HarnessSmokeAgentGitServiceCutoverResult, type HarnessSmokeAgentGitServiceHandoffAttachmentResult, type HarnessSmokeAgentGitServiceWikiMemoryResult, type HarnessSmokeBrainSignalResult, type HarnessSmokeCliOptions, type HarnessSmokeCoderResult, type HarnessSmokeGiteaCommentsResult, type HarnessSmokeGiteaPrResult, type HarnessSmokeOnlineResult, type HarnessSmokeProjectContractResult, type HarnessSmokeSourceDefaults, type HarnessSmokeSourceDefaultsResult, type HarnessSmokeVasBrainLearningResult, type HarnessSmokeVasResult, type HarnessSmokeVasReviewGateResult, hmacSha256, numberFieldFromResponse, optionalStringFieldFromResponse, recordFieldFromResponse, SMOKE_REQUIRED_PROJECT_CONTRACT_MARKERS, SMOKE_SOURCE_DEFAULTS, SMOKE_VAS_LITE_CONTRACT, SMOKE_VAS_LITE_DEFAULT_SKILLS, SMOKE_VAS_LITE_RUN_POLICY, smokeCheckError, smokeControlPlaneWebhookSecret, smokeJson, smokeText, stringFieldFromResponse } from "./smoke.js";
import { join } from "node:path";

export function verifySmokeExpectedControlPlaneProvider(
  expected: ControlPlaneProviderName | undefined,
  actual: string | undefined,
  scope: string,
  details: Record<string, unknown>,
): void {
  if (!expected || actual === undefined) return;
  if (actual !== expected) {
    throw smokeCheckError(
      "SMOKE_CONTROL_PLANE_PROVIDER_MISMATCH",
      `smoke ${scope} control-plane provider did not match ${expected}`,
      { ...details, scope, expected, actual: actual ?? null },
    );
  }
}

export async function verifySmokeProjectContract(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
  template: ProjectTemplateName,
): Promise<HarnessSmokeProjectContractResult> {
  const response = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}`,
    { headers },
    [200],
    "GET smoke project summary",
  );
  const responseTemplate = stringFieldFromResponse(response.body, "template", "smoke project summary");
  if (responseTemplate !== template) {
    throw new Error(`smoke project summary template was ${JSON.stringify(responseTemplate)}`);
  }
  const contractStatus = recordFieldFromResponse(response.body, "contractStatus", "smoke project summary");
  const projectContractOk = booleanFieldFromResponse(contractStatus, "ok", "smoke project contractStatus");
  const missingValues = arrayFieldFromResponse(contractStatus, "missing", "smoke project contractStatus");
  const projectContractMissing = requireSmokeStringArray(
    missingValues,
    "smoke project contractStatus missing must be strings",
    "SMOKE_PROJECT_CONTRACT_INVALID",
    { scope: "project", tenant, project, template, field: "contractStatus.missing" },
  );
  if (!projectContractOk) {
    throw smokeCheckError(
      "SMOKE_PROJECT_CONTRACT_DRIFT",
      `project ${tenant}/${project} contract drift: ${projectContractMissing.join(", ")}`,
      { scope: "project", tenant, project, template, missing: projectContractMissing },
    );
  }
  const projectDefaultSkills = requireSmokeStringArray(
    arrayFieldFromResponse(response.body, "defaultSkills", "smoke project summary"),
    "smoke project summary defaultSkills must be strings",
    "SMOKE_PROJECT_GOLDEN_DEFAULTS_INVALID",
    { scope: "project", tenant, project, template, field: "defaultSkills" },
  );
  const runPolicy = recordFieldFromResponse(response.body, "runPolicy", "smoke project summary");
  const preset = stringFieldFromResponse(runPolicy, "preset", "smoke project runPolicy");
  const presetInput = recordFieldFromResponse(runPolicy, "presetInput", "smoke project runPolicy");
  const caseId = stringFieldFromResponse(presetInput, "caseId", "smoke project runPolicy presetInput");
  const reviewRequired = booleanFieldFromResponse(runPolicy, "reviewRequired", "smoke project runPolicy");
  const contract = recordFieldFromResponse(response.body, "contract", "smoke project summary");
  const projectContractObjective = stringFieldFromResponse(contract, "objective", "smoke project contract");
  const missingGoldenDefaults = [
    JSON.stringify(projectDefaultSkills) === JSON.stringify(SMOKE_VAS_LITE_DEFAULT_SKILLS) ? undefined : "defaultSkills",
    preset === SMOKE_VAS_LITE_RUN_POLICY.preset ? undefined : "runPolicy.preset",
    caseId === SMOKE_VAS_LITE_RUN_POLICY.presetInput.caseId ? undefined : "runPolicy.presetInput.caseId",
    reviewRequired === SMOKE_VAS_LITE_RUN_POLICY.reviewRequired ? undefined : "runPolicy.reviewRequired",
    projectContractObjective === SMOKE_VAS_LITE_CONTRACT.objective ? undefined : "contract.objective",
  ].filter((field): field is string => Boolean(field));
  if (missingGoldenDefaults.length) {
    throw smokeCheckError(
      "SMOKE_PROJECT_GOLDEN_DEFAULTS_DRIFT",
      `project ${tenant}/${project} golden defaults drift: ${missingGoldenDefaults.join(", ")}`,
      { scope: "project", tenant, project, template, missing: missingGoldenDefaults },
    );
  }
  return {
    projectContractChecked: true,
    projectContractOk: true,
    projectContractMissing,
    projectGoldenDefaultsChecked: true,
    projectDefaultSkills,
    projectRunPolicy: {
      preset: "vas-lite-review",
      presetInput: { caseId: "bootstrap" },
      reviewRequired: true,
    },
    projectContractObjective,
  };
}

export function verifySmokeProjectContractSnapshot(
  source: unknown,
  contractField: string,
  statusField: string,
  label: string,
): void {
  const contract = recordFieldFromResponse(source, contractField, label);
  const objective = stringFieldFromResponse(contract, "objective", `${label} ${contractField}`);
  const constraints = requireSmokeStringArray(
    arrayFieldFromResponse(contract, "constraints", `${label} ${contractField}`),
    `${label} ${contractField}.constraints must be strings`,
    "SMOKE_HANDOFF_CONTRACT_INVALID",
    { scope: "handoff", field: `${contractField}.constraints` },
  );
  const successCriteria = requireSmokeStringArray(
    arrayFieldFromResponse(contract, "successCriteria", `${label} ${contractField}`),
    `${label} ${contractField}.successCriteria must be strings`,
    "SMOKE_HANDOFF_CONTRACT_INVALID",
    { scope: "handoff", field: `${contractField}.successCriteria` },
  );
  const text = [objective, ...constraints, ...successCriteria].join("\n").toLowerCase();
  const missingMarkers = SMOKE_REQUIRED_PROJECT_CONTRACT_MARKERS
    .filter((marker) => !marker.terms.every((term) => text.includes(term)))
    .map((marker) => marker.id);
  if (missingMarkers.length) {
    throw smokeCheckError(
      "SMOKE_HANDOFF_CONTRACT_DRIFT",
      `${label} project contract missing markers: ${missingMarkers.join(", ")}`,
      { scope: "handoff", field: contractField, missingMarkers },
    );
  }

  const contractStatus = recordFieldFromResponse(source, statusField, label);
  const ok = booleanFieldFromResponse(contractStatus, "ok", `${label} ${statusField}`);
  const missing = requireSmokeStringArray(
    arrayFieldFromResponse(contractStatus, "missing", `${label} ${statusField}`),
    `${label} ${statusField}.missing must be strings`,
    "SMOKE_HANDOFF_CONTRACT_INVALID",
    { scope: "handoff", field: `${statusField}.missing` },
  );
  if (!ok || missing.length) {
    throw smokeCheckError(
      "SMOKE_HANDOFF_CONTRACT_DRIFT",
      `${label} project contractStatus drift: ${missing.join(", ") || "not ok"}`,
      { scope: "handoff", field: statusField, missing },
    );
  }
}

export function verifySmokeContractPatchEvidence(
  source: unknown,
  field: string,
  expected: { objective: string; constraints: string[]; successCriteria: string[] },
  label: string,
): void {
  const patch = recordFieldFromResponse(source, field, label);
  const objective = stringFieldFromResponse(patch, "objective", `${label} ${field}`);
  const constraints = requireSmokeStringArray(
    arrayFieldFromResponse(patch, "constraints", `${label} ${field}`),
    `${label} ${field}.constraints must be strings`,
    "SMOKE_HANDOFF_CONTRACT_PATCH_INVALID",
    { scope: "handoff", field: `${field}.constraints` },
  );
  const successCriteria = requireSmokeStringArray(
    arrayFieldFromResponse(patch, "successCriteria", `${label} ${field}`),
    `${label} ${field}.successCriteria must be strings`,
    "SMOKE_HANDOFF_CONTRACT_PATCH_INVALID",
    { scope: "handoff", field: `${field}.successCriteria` },
  );
  if (
    objective !== expected.objective ||
    JSON.stringify(constraints) !== JSON.stringify(expected.constraints) ||
    JSON.stringify(successCriteria) !== JSON.stringify(expected.successCriteria)
  ) {
    throw smokeCheckError(
      "SMOKE_HANDOFF_CONTRACT_PATCH_MISMATCH",
      `${label} ${field} did not match the approved contract patch`,
      { scope: "handoff", field },
    );
  }
}

export async function verifySmokeGiteaPr(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
): Promise<HarnessSmokeGiteaPrResult> {
  const giteaPrIssue = "team/smoke#17";
  const giteaPrBranch = "loom/smoke-pr";
  const giteaPrBaseBranch = "main";
  const runResponse = await smokeJson(
    `${url}/runs`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        tenant,
        project,
        repo: "https://git.example/team/smoke.git",
        branch: giteaPrBranch,
        baseBranch: giteaPrBaseBranch,
        issue: giteaPrIssue,
        pullRequest: true,
        reviewRequired: true,
        goal: "create a smoke pull request run",
        script: [
          {
            message: "write PR smoke artifact",
            actions: [
              {
                toolName: "file.write",
                input: { path: "loom-pr-smoke.txt", content: "loom pr smoke ok\n" },
              },
            ],
          },
          { message: "finish PR smoke", finish: true },
        ],
        verify: ["test -f loom-pr-smoke.txt"],
        skills: ["smoke", "coding"],
        requester: { clientId: "loom-smoke-gitea-pr" },
      }),
    },
    [201],
    "POST smoke Gitea pull request run",
  );

  const giteaPrRunId = stringFieldFromResponse(runResponse.body, "runId", "smoke Gitea pull request run");
  const giteaPrRunStatus = stringFieldFromResponse(runResponse.body, "status", "smoke Gitea pull request run");
  if (giteaPrRunStatus !== "review_required") {
    throw new Error(`smoke Gitea pull request run finished with status ${giteaPrRunStatus}`);
  }
  const metadata = recordFieldFromResponse(runResponse.body, "metadata", "smoke Gitea pull request run");
  const issue = stringFieldFromResponse(metadata, "issue", "smoke Gitea pull request metadata");
  const issueUrl = optionalStringFieldFromResponse(metadata, "issueUrl");
  const branch = stringFieldFromResponse(metadata, "branch", "smoke Gitea pull request metadata");
  const baseBranch = stringFieldFromResponse(metadata, "baseBranch", "smoke Gitea pull request metadata");
  const giteaPrIndex = numberFieldFromResponse(metadata, "pullRequestIndex", "smoke Gitea pull request metadata");
  const giteaPrUrl = stringFieldFromResponse(metadata, "pullRequestUrl", "smoke Gitea pull request metadata");
  if (issue !== giteaPrIssue || branch !== giteaPrBranch || baseBranch !== giteaPrBaseBranch) {
    throw new Error("smoke Gitea pull request metadata did not preserve issue/branch/baseBranch");
  }

  const events = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(giteaPrRunId)}/events?project=${encodeURIComponent(project)}`,
    { headers },
    [200],
    "GET smoke Gitea pull request events",
  );
  const externalEffect = Array.isArray(events.body) ? events.body.find((event) => {
    if (!isRecord(event) || event.type !== "external_effect") return false;
    const data = event.data;
    return isRecord(data) &&
      data.kind === "pull_request" &&
      data.pullRequestIndex === giteaPrIndex &&
      data.pullRequestUrl === giteaPrUrl &&
      data.requester !== undefined;
  }) : undefined;
  if (!isRecord(externalEffect) || !isRecord(externalEffect.data)) {
    throw new Error("smoke Gitea pull request external effect was not recorded");
  }
  const controlPlanePrProvider = stringFieldFromResponse(externalEffect.data, "controlPlaneProvider", "smoke control-plane pull request external effect");
  const controlPlanePrIssueUrl = optionalStringFieldFromResponse(externalEffect.data, "issueUrl") ?? issueUrl;

  return {
    controlPlanePrChecked: true,
    controlPlanePrProvider,
    controlPlanePrRunId: giteaPrRunId,
    controlPlanePrRunStatus: "review_required",
    controlPlanePrIssue: issue,
    controlPlanePrIssueUrl,
    controlPlanePrBranch: branch,
    controlPlanePrBaseBranch: baseBranch,
    controlPlanePrIndex: giteaPrIndex,
    controlPlanePrUrl: giteaPrUrl,
    controlPlanePrExternalEffectChecked: true,
    giteaPrChecked: true,
    giteaPrRunId,
    giteaPrRunStatus: "review_required",
    giteaPrIssue: issue,
    giteaPrBranch: branch,
    giteaPrBaseBranch: baseBranch,
    giteaPrIndex,
    giteaPrUrl,
    giteaPrExternalEffectChecked: true,
  };
}

export async function verifySmokeGiteaComments(
  url: string,
  headers: Record<string, string>,
  options: HarnessSmokeCliOptions,
  tenant: string,
  project: string,
): Promise<HarnessSmokeGiteaCommentsResult> {
  const giteaCommentsIssue = "team/smoke-comments#17";
  const projectQuery = `project=${encodeURIComponent(project)}`;
  const runResponse = await smokeJson(
    `${url}/runs`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        tenant,
        project,
        issue: giteaCommentsIssue,
        reviewRequired: true,
        goal: "create a smoke issue comment controlled run",
        script: [{ message: "finish Gitea issue comment smoke", finish: true }],
        verify: [],
        skills: ["smoke", "coding"],
        requester: { clientId: "loom-smoke-gitea-comments" },
      }),
    },
    [201],
    "POST smoke Gitea issue comment run",
  );

  const giteaCommentsRunId = stringFieldFromResponse(runResponse.body, "runId", "smoke Gitea issue comment run");
  const initialStatus = stringFieldFromResponse(runResponse.body, "status", "smoke Gitea issue comment run");
  if (initialStatus !== "review_required") {
    throw new Error(`smoke Gitea issue comment run finished with status ${initialStatus}`);
  }

  const runUrl = `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(giteaCommentsRunId)}`;
  const sync = await smokeJson(
    `${runUrl}/issue-comments/sync?${projectQuery}`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ clientId: "loom-smoke-gitea-comments-sync" }),
    },
    [201],
    "POST smoke Gitea issue comment sync",
  );
  const syncIssue = stringFieldFromResponse(sync.body, "issue", "smoke Gitea issue comment sync");
  const syncIssueUrl = optionalStringFieldFromResponse(sync.body, "issueUrl");
  const giteaCommentsSynced = numberFieldFromResponse(sync.body, "synced", "smoke Gitea issue comment sync");
  const giteaCommentsRunReviewRequested = numberFieldFromResponse(sync.body, "runReviewRequested", "smoke Gitea issue comment sync");
  const giteaCommentsRunReviewed = numberFieldFromResponse(sync.body, "runReviewed", "smoke Gitea issue comment sync");
  if (
    syncIssue !== giteaCommentsIssue ||
    giteaCommentsSynced !== 1 ||
    giteaCommentsRunReviewRequested !== 1 ||
    giteaCommentsRunReviewed !== 1
  ) {
    throw new Error("smoke Gitea issue comment sync did not drive the review gate");
  }

  const summary = await smokeJson(`${runUrl}?${projectQuery}`, { headers }, [200], "GET smoke Gitea issue comment run");
  const giteaCommentsRunStatus = stringFieldFromResponse(summary.body, "status", "smoke Gitea issue comment run");
  if (giteaCommentsRunStatus !== "passed") {
    throw new Error(`smoke Gitea issue comment run status was ${JSON.stringify(giteaCommentsRunStatus)}`);
  }
  const review = recordFieldFromResponse(summary.body, "review", "smoke Gitea issue comment run");
  const reviewStatus = stringFieldFromResponse(review, "status", "smoke Gitea issue comment run review");
  if (reviewStatus !== "approved") throw new Error("smoke Gitea issue comment review was not approved");

  const replay = await smokeJson(`${runUrl}/replay?${projectQuery}`, { headers }, [200], "GET smoke Gitea issue comment replay");
  const timeline = arrayFieldFromResponse(replay.body, "timeline", "smoke Gitea issue comment replay");
  if (!timeline.some((entry) =>
    isRecord(entry) &&
    entry.type === "user_message" &&
    typeof entry.actor === "string" &&
    entry.actor.endsWith(":eno") &&
    typeof entry.title === "string" &&
    entry.title.includes("/loom approve")
  )) {
    throw new Error("smoke Gitea issue comment replay did not include the synced approval comment");
  }

  const audit = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/audit?${projectQuery}`,
    { headers },
    [200],
    "GET smoke Gitea issue comment audit",
  );
  const auditEvent = Array.isArray(audit.body) ? audit.body.find((event) => {
    if (!isRecord(event) || event.type !== "run_issue_comments_synced") return false;
    const data = event.data;
    return isRecord(data) &&
      data.project === project &&
      data.runId === giteaCommentsRunId &&
      data.issue === giteaCommentsIssue &&
      data.synced === 1 &&
      data.runReviewRequested === 1 &&
      data.runReviewed === 1;
  }) : undefined;
  if (!isRecord(auditEvent) || !isRecord(auditEvent.data)) {
    throw new Error("smoke Gitea issue comment audit did not include review sync evidence");
  }
  const controlPlaneCommentsProvider = stringFieldFromResponse(auditEvent.data, "controlPlaneProvider", "smoke control-plane issue comment audit");
  const controlPlaneCommentsIssueUrl = optionalStringFieldFromResponse(auditEvent.data, "issueUrl") ?? syncIssueUrl;
  const webhookSecret = smokeControlPlaneWebhookSecret(options);
  const webhookResult = webhookSecret
    ? await verifySmokeControlPlaneCommentsWebhook(url, headers, webhookSecret, tenant, project)
    : undefined;

  return {
    controlPlaneCommentsChecked: true,
    controlPlaneCommentsProvider,
    controlPlaneCommentsRunId: giteaCommentsRunId,
    controlPlaneCommentsIssue: syncIssue,
    controlPlaneCommentsIssueUrl,
    controlPlaneCommentsSynced: 1,
    controlPlaneCommentsRunReviewRequested: 1,
    controlPlaneCommentsRunReviewed: 1,
    controlPlaneCommentsRunStatus: "passed",
    controlPlaneCommentsReplayChecked: true,
    controlPlaneCommentsAuditChecked: true,
    ...(webhookResult ?? {}),
    giteaCommentsChecked: true,
    giteaCommentsRunId,
    giteaCommentsIssue: syncIssue,
    giteaCommentsSynced: 1,
    giteaCommentsRunReviewRequested: 1,
    giteaCommentsRunReviewed: 1,
    giteaCommentsRunStatus: "passed",
    giteaCommentsReplayChecked: true,
    giteaCommentsAuditChecked: true,
  };
}

export async function verifySmokeControlPlaneCommentsWebhook(
  url: string,
  headers: Record<string, string>,
  webhookSecret: string,
  tenant: string,
  project: string,
): Promise<Pick<
  HarnessSmokeGiteaCommentsResult,
  | "controlPlaneCommentsWebhookChecked"
  | "controlPlaneCommentsWebhookProvider"
  | "controlPlaneCommentsWebhookRunId"
  | "controlPlaneCommentsWebhookIssue"
  | "controlPlaneCommentsWebhookIssueUrl"
  | "controlPlaneCommentsWebhookSynced"
  | "controlPlaneCommentsWebhookRunReviewRequested"
  | "controlPlaneCommentsWebhookRunReviewed"
  | "controlPlaneCommentsWebhookRunStatus"
  | "controlPlaneCommentsWebhookAuditChecked"
>> {
  const webhookIssue = "team/smoke-webhook-comments#18";
  const projectQuery = `project=${encodeURIComponent(project)}`;
  const runResponse = await smokeJson(
    `${url}/runs`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        tenant,
        project,
        issue: webhookIssue,
        reviewRequired: true,
        goal: "create a signed webhook controlled smoke run",
        script: [{ message: "finish control-plane webhook smoke", finish: true }],
        verify: [],
        skills: ["smoke", "coding"],
        requester: { clientId: "loom-smoke-control-plane-webhook" },
      }),
    },
    [201],
    "POST smoke control-plane issue comment webhook run",
  );
  const webhookRunId = stringFieldFromResponse(runResponse.body, "runId", "smoke control-plane webhook run");
  const initialStatus = stringFieldFromResponse(runResponse.body, "status", "smoke control-plane webhook run");
  if (initialStatus !== "review_required") {
    throw new Error(`smoke control-plane webhook run finished with status ${initialStatus}`);
  }

  const deliveryId = "loom-smoke-control-plane-webhook";
  const payload = JSON.stringify({
    action: "created",
    repository: { full_name: "team/smoke-webhook-comments" },
    issue: { number: 18 },
    comment: {
      id: 903,
      body: "/loom approve\nApproved from the signed smoke webhook.",
      html_url: "https://git.example/team/smoke-webhook-comments/issues/18#comment-903",
      user: { login: "eno" },
      created_at: "2026-06-30T12:00:00.000Z",
    },
  });
  const webhook = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/webhooks/control-plane/issue-comments?${projectQuery}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": `sha256=${hmacSha256(webhookSecret, payload)}`,
      },
      body: payload,
    },
    [202],
    "POST smoke control-plane issue comment webhook",
  );
  const webhookIssueResponse = stringFieldFromResponse(webhook.body, "issue", "smoke control-plane issue comment webhook");
  const webhookSynced = numberFieldFromResponse(webhook.body, "synced", "smoke control-plane issue comment webhook");
  const webhookRunReviewRequested = numberFieldFromResponse(webhook.body, "runReviewRequested", "smoke control-plane issue comment webhook");
  const webhookRunReviewed = numberFieldFromResponse(webhook.body, "runReviewed", "smoke control-plane issue comment webhook");
  if (
    webhookIssueResponse !== webhookIssue ||
    webhookSynced !== 1 ||
    webhookRunReviewRequested !== 1 ||
    webhookRunReviewed !== 1
  ) {
    throw new Error("smoke control-plane issue comment webhook did not drive the review gate");
  }
  const matchedRuns = arrayFieldFromResponse(webhook.body, "matchedRuns", "smoke control-plane issue comment webhook");
  if (!matchedRuns.some((entry) =>
    isRecord(entry) &&
    entry.project === project &&
    entry.runId === webhookRunId &&
    entry.synced === 1 &&
    entry.runReviewRequested === 1 &&
    entry.runReviewed === 1
  )) {
    throw new Error("smoke control-plane issue comment webhook did not report the matched run");
  }

  const runUrl = `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(webhookRunId)}`;
  const summary = await smokeJson(`${runUrl}?${projectQuery}`, { headers }, [200], "GET smoke control-plane webhook run");
  const webhookRunStatus = stringFieldFromResponse(summary.body, "status", "smoke control-plane webhook run");
  if (webhookRunStatus !== "passed") {
    throw new Error(`smoke control-plane webhook run status was ${JSON.stringify(webhookRunStatus)}`);
  }

  const audit = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/audit?${projectQuery}`,
    { headers },
    [200],
    "GET smoke control-plane webhook audit",
  );
  const auditEvent = Array.isArray(audit.body) ? audit.body.find((event) => {
    if (!isRecord(event) || event.type !== "run_issue_comments_synced") return false;
    const data = event.data;
    return isRecord(data) &&
      data.project === project &&
      data.runId === webhookRunId &&
      data.issue === webhookIssue &&
      data.deliveryId === deliveryId &&
      data.synced === 1 &&
      data.runReviewRequested === 1 &&
      data.runReviewed === 1;
  }) : undefined;
  if (!isRecord(auditEvent) || !isRecord(auditEvent.data)) {
    throw new Error("smoke control-plane webhook audit did not include review evidence");
  }
  const webhookProvider = stringFieldFromResponse(auditEvent.data, "controlPlaneProvider", "smoke control-plane webhook audit");
  const webhookIssueUrl = optionalStringFieldFromResponse(auditEvent.data, "issueUrl");

  return {
    controlPlaneCommentsWebhookChecked: true,
    controlPlaneCommentsWebhookProvider: webhookProvider,
    controlPlaneCommentsWebhookRunId: webhookRunId,
    controlPlaneCommentsWebhookIssue: webhookIssueResponse,
    controlPlaneCommentsWebhookIssueUrl: webhookIssueUrl,
    controlPlaneCommentsWebhookSynced: 1,
    controlPlaneCommentsWebhookRunReviewRequested: 1,
    controlPlaneCommentsWebhookRunReviewed: 1,
    controlPlaneCommentsWebhookRunStatus: "passed",
    controlPlaneCommentsWebhookAuditChecked: true,
  };
}

export async function verifySmokeAgentGitServiceCutover(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
): Promise<HarnessSmokeAgentGitServiceCutoverResult> {
  const receiptResponse = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/control-plane/agent-git-service/provision`,
    { headers },
    [200],
    "GET smoke agent-git-service provisioning receipt",
  );
  const receipt = recordFieldFromResponse(receiptResponse.body, "receipt", "smoke agent-git-service provisioning receipt");
  const provider = stringFieldFromResponse(receipt, "provider", "smoke agent-git-service provisioning receipt");
  if (provider !== "agent-git-service") {
    throw smokeCheckError(
      "SMOKE_AGENT_GIT_SERVICE_CUTOVER_PROVIDER_DRIFT",
      "smoke agent-git-service cutover receipt did not report the AGS provider",
      { scope: "agent-git-service-cutover", tenant, project, provider },
    );
  }
  const receiptTenant = stringFieldFromResponse(receipt, "tenant", "smoke agent-git-service provisioning receipt");
  const receiptProject = stringFieldFromResponse(receipt, "project", "smoke agent-git-service provisioning receipt");
  if (receiptTenant !== tenant || receiptProject !== project) {
    throw smokeCheckError(
      "SMOKE_AGENT_GIT_SERVICE_CUTOVER_RECEIPT_DRIFT",
      "smoke agent-git-service cutover receipt did not match the requested tenant/project",
      { scope: "agent-git-service-cutover", tenant, project, receiptTenant, receiptProject },
    );
  }
  const agentLogin = stringFieldFromResponse(receipt, "agentLogin", "smoke agent-git-service provisioning receipt");
  const tokenEnvName = stringFieldFromResponse(receipt, "tokenEnvName", "smoke agent-git-service provisioning receipt");
  if (!isSafeSmokeEnvName(tokenEnvName)) {
    throw smokeCheckError(
      "SMOKE_AGENT_GIT_SERVICE_CUTOVER_TOKEN_ENV_UNSAFE",
      "smoke agent-git-service cutover receipt tokenEnvName is not shell-safe",
      { scope: "agent-git-service-cutover", tenant, project, tokenEnvName },
    );
  }
  const receiptSerialized = JSON.stringify(receiptResponse.body);
  if (receiptSerialized.includes("agentToken") || receiptSerialized.includes("sha256:")) {
    throw smokeCheckError(
      "SMOKE_AGENT_GIT_SERVICE_CUTOVER_SECRET_LEAK",
      "smoke agent-git-service cutover receipt included token material",
      { scope: "agent-git-service-cutover", tenant, project },
    );
  }
  const marker = "agent-git-service-cutover-token-ok";
  const command = `if [ -n "$${tokenEnvName}" ]; then printf ${marker}; else exit 1; fi`;
  const commandResponse = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/commands`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ command, clientId: "loom-smoke-agent-git-service-cutover" }),
    },
    [200],
    "POST smoke agent-git-service cutover workspace command",
  );
  const commandExitCode = numberFieldFromResponse(commandResponse.body, "exitCode", "smoke agent-git-service cutover command");
  const commandStdout = stringFieldFromResponse(commandResponse.body, "stdout", "smoke agent-git-service cutover command");
  if (commandExitCode !== 0 || commandStdout !== marker) {
    throw smokeCheckError(
      "SMOKE_AGENT_GIT_SERVICE_CUTOVER_TOKEN_UNAVAILABLE",
      "smoke agent-git-service cutover workspace command could not see the stored project-agent token env",
      { scope: "agent-git-service-cutover", tenant, project, tokenEnvName, exitCode: commandExitCode, stdout: commandStdout },
    );
  }
  return {
    agentGitServiceCutoverChecked: true,
    agentGitServiceCutoverProvider: "agent-git-service",
    agentGitServiceCutoverReceiptChecked: true,
    agentGitServiceCutoverReceiptSecretAbsent: true,
    agentGitServiceCutoverAgentLogin: agentLogin,
    agentGitServiceCutoverTokenEnvName: tokenEnvName,
    agentGitServiceCutoverWorkspaceTokenChecked: true,
    agentGitServiceCutoverCommandExitCode: 0,
    agentGitServiceCutoverCommandStdout: marker,
  };
}

export function isSafeSmokeEnvName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export async function verifySmokeCoderWorkspace(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
  runId: string,
  projectWorkspaceContext: unknown,
): Promise<HarnessSmokeCoderResult> {
  const projectContext = coderWorkspaceContextFromResponse(
    projectWorkspaceContext,
    "smoke Coder project workspace",
    "project",
  );
  const runWorkspace = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(runId)}/workspace?project=${encodeURIComponent(project)}`,
    { headers },
    [200],
    "GET smoke Coder run workspace",
  );
  const runContext = coderWorkspaceContextFromResponse(
    runWorkspace.body,
    "smoke Coder run workspace",
    "run",
    runId,
  );

  return {
    coderChecked: true,
    coderProjectWorkspaceChecked: true,
    coderRunWorkspaceChecked: true,
    coderProjectExecutorKind: "coder",
    coderRunExecutorKind: "coder",
    coderProjectWorkspace: projectContext.workspace,
    coderRunWorkspace: runContext.workspace,
    coderProjectIdeUrl: projectContext.ideUrl,
    coderRunIdeUrl: runContext.ideUrl,
    coderProjectPreviewUrl: projectContext.previewUrl,
    coderRunPreviewUrl: runContext.previewUrl,
  };
}

export function coderWorkspaceContextFromResponse(
  value: unknown,
  label: string,
  route: "project" | "run",
  runId?: string,
): { workspace: string; ideUrl: string; previewUrl: string } {
  if (!isRecord(value) || value.route !== route) {
    throw new Error(`${label} did not describe the ${route} route`);
  }
  if (route === "run") {
    const responseRunId = stringFieldFromResponse(value, "runId", label);
    if (responseRunId !== runId) throw new Error(`${label} runId did not match ${runId}`);
  }
  const executor = recordFieldFromResponse(value, "executor", label);
  const kind = stringFieldFromResponse(executor, "kind", `${label} executor`);
  if (kind !== "coder") throw new Error(`${label} executor kind was ${JSON.stringify(kind)}`);
  return {
    workspace: stringFieldFromResponse(executor, "workspace", `${label} executor`),
    ideUrl: stringFieldFromResponse(executor, "ideUrl", `${label} executor`),
    previewUrl: stringFieldFromResponse(executor, "previewUrl", `${label} executor`),
  };
}

export async function verifySmokeBrainSignal(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
  runId: string,
  dashboardUrl: string,
  summaryUrl: string,
): Promise<HarnessSmokeBrainSignalResult> {
  const encodedTenant = encodeURIComponent(tenant);
  const encodedProject = encodeURIComponent(project);
  const encodedRunId = encodeURIComponent(runId);
  const runEvents = await smokeJson(
    `${url}/tenants/${encodedTenant}/runs/${encodedRunId}/events?project=${encodedProject}`,
    { headers },
    [200],
    "GET brain run ingest events",
  );
  if (!Array.isArray(runEvents.body) || !runEvents.body.some((event) => {
    if (!isRecord(event) || event.type !== "external_effect") return false;
    const data = event.data;
    return isRecord(data) &&
      data.kind === "brain_ingest" &&
      data.project === project &&
      data.runId === runId &&
      data.status === "passed" &&
      data.outcome === "pass" &&
      data.skillCount === 2;
  })) {
    throw smokeCheckError(
      "SMOKE_BRAIN_RUN_INGEST_MISSING",
      "brain run ingest external effect was not recorded",
      { scope: "brain", tenant, project, runId },
    );
  }

  const response = await smokeJson(
    `${url}/tenants/${encodedTenant}/brain/signals`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        project,
        runId,
        status: "passed",
        dashboardUrl,
        summaryUrl,
        reviewSummaryUrl: `${url}/tenants/${encodedTenant}/runs/${encodedRunId}/review-summary?project=${encodedProject}`,
        handoffPackageUrl: `${url}/tenants/${encodedTenant}/runs/${encodedRunId}/handoff-package?project=${encodedProject}`,
        handoffFollowupsUrl: `${url}/tenants/${encodedTenant}/runs/${encodedRunId}/handoff-runs?project=${encodedProject}`,
        skills: ["smoke", "coding"],
        outcome: "pass",
        notes: "loom smoke brain readiness",
        clientId: "loom-smoke",
      }),
    },
    [202],
    "POST brain signal",
  );
  if (booleanFieldFromResponse(response.body, "ingested", "brain signal response") !== true) {
    throw new Error("brain signal response did not confirm ingest");
  }
  const responseRunId = stringFieldFromResponse(response.body, "runId", "brain signal response");
  if (responseRunId !== runId) throw new Error(`brain signal response runId ${responseRunId} did not match ${runId}`);
  const outcome = stringFieldFromResponse(response.body, "outcome", "brain signal response");
  if (outcome !== "pass") throw new Error(`brain signal response outcome was ${outcome}`);
  const skills = arrayFieldFromResponse(response.body, "skills", "brain signal response");

  const audit = await smokeJson(
    `${url}/tenants/${encodedTenant}/audit?project=${encodedProject}`,
    { headers },
    [200],
    "GET brain signal audit",
  );
  if (!Array.isArray(audit.body) || !audit.body.some((event) => {
    if (!isRecord(event) || event.type !== "brain_signal_ingested") return false;
    const data = event.data;
    return isRecord(data) &&
      data.project === project &&
      data.runId === runId &&
      data.outcome === "pass" &&
      data.skillCount === skills.length &&
      data.clientId === "loom-smoke";
  })) {
    throw new Error("brain signal audit event was not recorded");
  }
  if (!audit.body.some((event) => {
    if (!isRecord(event) || event.type !== "brain_signal_ingested") return false;
    const data = event.data;
    return isRecord(data) &&
      data.project === project &&
      data.runId === runId &&
      data.status === "passed" &&
      data.outcome === "pass" &&
      data.skillCount === 2 &&
      data.clientId === undefined;
  })) {
    throw smokeCheckError(
      "SMOKE_BRAIN_RUN_INGEST_MISSING",
      "brain run ingest audit event was not recorded",
      { scope: "brain", tenant, project, runId },
    );
  }

  const feed = await smokeJson(
    `${url}/tenants/${encodedTenant}/brain/signals?project=${encodedProject}`,
    { headers },
    [200],
    "GET brain signal feed",
  );
  const feedCount = numberFieldFromResponse(feed.body, "count", "brain signal feed");
  const feedSignals = arrayFieldFromResponse(feed.body, "signals", "brain signal feed");
  const feedHasRunIngest = feedSignals.some((signal) =>
    isRecord(signal) &&
    signal.source === "completed_run" &&
    signal.project === project &&
    signal.runId === runId &&
    signal.status === "passed" &&
    signal.outcome === "pass" &&
    signal.skillCount === 2
  );
  const feedHasWorkspaceSignal = feedSignals.some((signal) =>
    isRecord(signal) &&
    signal.source === "workspace_signal" &&
    signal.project === project &&
    signal.runId === runId &&
    signal.outcome === "pass" &&
    signal.skillCount === skills.length &&
    signal.clientId === "loom-smoke"
  );
  if (!feedHasRunIngest || !feedHasWorkspaceSignal) {
    throw smokeCheckError(
      "SMOKE_BRAIN_SIGNAL_FEED_MISSING",
      "brain signal feed did not include completed-run and workspace signal evidence",
      { scope: "brain", tenant, project, runId, feedCount, feedHasRunIngest, feedHasWorkspaceSignal },
    );
  }

  return {
    brainSignalChecked: true,
    brainSignalRunId: runId,
    brainSignalOutcome: "pass",
    brainSignalSkillCount: skills.length,
    brainSignalAuditChecked: true,
    brainRunIngestChecked: true,
    brainRunIngestRunId: runId,
    brainRunIngestOutcome: "pass",
    brainRunIngestExternalEffectChecked: true,
    brainRunIngestAuditChecked: true,
    brainSignalFeedChecked: true,
    brainSignalFeedCount: feedCount,
    brainSignalFeedRunIngestChecked: true,
    brainSignalFeedWorkspaceSignalChecked: true,
  };
}

export async function verifySmokeVasBrainLearning(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
  caseId: string,
  runId: string,
): Promise<HarnessSmokeVasBrainLearningResult> {
  const feed = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/brain/signals?project=${encodeURIComponent(project)}`,
    { headers },
    [200],
    "GET VAS brain learning feed",
  );
  const feedCount = numberFieldFromResponse(feed.body, "count", "VAS brain learning feed");
  const signals = arrayFieldFromResponse(feed.body, "signals", "VAS brain learning feed");
  const signal = signals.find((item) =>
    isRecord(item) &&
    item.source === "vas_learning" &&
    item.project === project &&
    item.caseId === caseId &&
    item.runId === runId
  );
  if (!isRecord(signal)) {
    throw smokeCheckError(
      "SMOKE_VAS_BRAIN_LEARNING_MISSING",
      "brain signal feed did not include approved VAS learning evidence",
      { scope: "vas", tenant, project, caseId, runId, feedCount },
    );
  }
  const learningCount = numberFieldFromResponse(signal, "learningCount", "VAS brain learning signal");
  const skillCount = numberFieldFromResponse(signal, "skillCount", "VAS brain learning signal");
  if (learningCount < 1 || skillCount < 1) {
    throw smokeCheckError(
      "SMOKE_VAS_BRAIN_LEARNING_INVALID",
      "approved VAS learning brain signal did not include learning and skill counts",
      { scope: "vas", tenant, project, caseId, runId, learningCount, skillCount },
    );
  }

  return {
    vasBrainLearningChecked: true,
    vasBrainLearningSource: "vas_learning",
    vasBrainLearningCaseId: caseId,
    vasBrainLearningRunId: runId,
    vasBrainLearningCount: learningCount,
    vasBrainLearningSkillCount: skillCount,
    vasBrainLearningFeedChecked: true,
  };
}

export async function verifySmokeOnlineSurfaces(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
  runId: string,
): Promise<HarnessSmokeOnlineResult> {
  const params = new URLSearchParams({ tenant, project, runId });
  const dashboard = await smokeText(`${url}/?${params.toString()}`, { headers }, [200], "GET smoke dashboard HTML");
  if (!dashboard.text.includes("<title>Loom Harness</title>") || !dashboard.text.includes("project-presence")) {
    throw new Error("smoke dashboard HTML did not include the expected online project surface");
  }
  const dashboardTenantReadinessLabel = "tenant profile readiness";
  const dashboardGlobalReadinessLabel = "global profile readiness";
  const expectedReadinessLabels = [dashboardTenantReadinessLabel, dashboardGlobalReadinessLabel];
  const missingReadinessLabels = expectedReadinessLabels.filter((label) => !dashboard.text.includes(label));
  if (missingReadinessLabels.length) {
    throw smokeCheckError(
      "SMOKE_ONLINE_READINESS_LABELS_MISSING",
      "smoke dashboard HTML did not include the expected readiness source labels",
      {
        surface: "dashboard",
        expectedLabels: expectedReadinessLabels,
        missingLabels: missingReadinessLabels,
      },
    );
  }
  verifySmokeOnlineBrainSurface(
    "dashboard",
    dashboard.text,
    [
      'data-testid="load-brain-signals"',
      'id="brain-feed"',
      "/tenants/${tenant()}/brain/signals",
    ],
  );
  verifySmokeOnlineTokenScrubSurface("dashboard", dashboard.text);
  verifySmokeDashboardAgentGitServiceProvisioningSurface(dashboard.text);
  verifySmokeDashboardProjectConcurrencySurface(dashboard.text);

  const workbench = await smokeText(`${url}/workbench?${params.toString()}`, { headers }, [200], "GET smoke workbench HTML");
  if (!workbench.text.includes("<title>Loom Workbench</title>") || !workbench.text.includes("workbench-presence")) {
    throw new Error("smoke workbench HTML did not include the expected online run surface");
  }
  verifySmokeOnlineBrainSurface(
    "workbench",
    workbench.text,
    [
      'data-testid="workbench-load-brain-signals"',
      'id="workbench-brain-feed"',
      "/tenants/${tenant}/brain/signals",
    ],
  );
  verifySmokeOnlineTokenScrubSurface("workbench", workbench.text);

  const projectPresenceCollaboratorCount = await verifySmokePresence(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/presence`,
    headers,
    [
      { clientId: "loom-smoke-dashboard-a", label: "Loom Smoke Dashboard A", focus: "file:loom-smoke.txt" },
      { clientId: "loom-smoke-dashboard-b", label: "Loom Smoke Dashboard B", focus: `run:${runId}` },
    ],
    "project presence",
  );
  const runPresenceCollaboratorCount = await verifySmokePresence(
    `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(runId)}/presence?project=${encodeURIComponent(project)}`,
    headers,
    [
      { clientId: "loom-smoke-workbench-a", label: "Loom Smoke Workbench A", focus: `run:${runId}` },
      { clientId: "loom-smoke-workbench-b", label: "Loom Smoke Workbench B", focus: "vas:bootstrap" },
    ],
    "run presence",
  );
  const runCommentResult = await verifySmokeRunCommentReplay(url, headers, tenant, project, runId);

  return {
    onlineSurfacesChecked: true,
    dashboardHtmlRead: true,
    dashboardReadinessLabelsChecked: true,
    dashboardTenantReadinessLabel,
    dashboardGlobalReadinessLabel,
    dashboardBrainFeedChecked: true,
    dashboardTokenScrubChecked: true,
    dashboardAgentGitServiceProvisioningChecked: true,
    dashboardProjectConcurrencyChecked: true,
    workbenchHtmlRead: true,
    workbenchBrainFeedChecked: true,
    workbenchTokenScrubChecked: true,
    projectPresenceChecked: true,
    projectPresenceCollaboratorCount,
    runPresenceChecked: true,
    runPresenceCollaboratorCount,
    ...runCommentResult,
  };
}

export function verifySmokeDashboardAgentGitServiceProvisioningSurface(html: string): void {
  const markers = [
    'id="agent-git-service-provision-repo"',
    'id="agent-git-service-provision-permission"',
    'id="agent-git-service-provision-token-env"',
    'id="agent-git-service-provision-identity-actor"',
    'id="agent-git-service-provision-identity-role"',
    'id="agent-git-service-provision-store-token"',
    'data-testid="provision-agent-git-service"',
    "function agentGitServiceProvisionUrl()",
    'data-testid="load-agent-git-service-provisioning-plan"',
    'data-testid="load-agent-git-service-cutover-readiness"',
    'data-testid="dry-run-agent-git-service-provisioning-plan-apply"',
    'data-testid="apply-agent-git-service-provisioning-plan"',
    'id="agent-git-service-provisioning-plan-projects"',
    'id="agent-git-service-provisioning-plan-eligible-only"',
    'id="agent-git-service-provisioning-plan"',
    'id="agent-git-service-provisioning-plan-apply-output"',
    'id="agent-git-service-cutover-readiness"',
    "function agentGitServiceProvisioningPlanUrl()",
    "function agentGitServiceProvisioningPlanApplyUrl()",
    "function agentGitServiceCutoverReadinessUrl()",
    "function loadAgentGitServiceCutoverReadiness()",
    "function renderAgentGitServiceCutoverReadiness(readiness)",
    "function applyAgentGitServiceProvisioningPlan(dryRun)",
    "eligibleOnly: agentGitServiceProvisioningPlanEligibleOnlyInput.checked",
    "function renderAgentGitServiceProvisioningPlan(plan)",
    "function renderAgentGitServiceProvisioningPlanApplyResult(result)",
    "function renderProjectAgentGitServicePlanAction(project)",
    "function prefillAgentGitServiceProvisioningPlanProject(projectName)",
    "data-project-agent-git-service-plan",
    "agentGitServiceProvisioningPlanEligibleOnlyInput.checked = true",
  ];
  const missingMarkers = markers.filter((marker) => !html.includes(marker));
  if (missingMarkers.length) {
    throw smokeCheckError(
      "SMOKE_ONLINE_AGENT_GIT_SERVICE_UI_MISSING",
      "smoke dashboard HTML did not include the expected AGS project-agent provisioning UI",
      { surface: "dashboard", missingMarkers },
    );
  }
}

export function verifySmokeDashboardProjectConcurrencySurface(html: string): void {
  const markers = [
    'id="project-concurrency-board"',
    "function renderProjectConcurrencyBoard()",
    "function projectConcurrencyBoardProjects()",
    "function renderProjectConcurrencyBoardProject(project)",
    "function renderProjectConcurrencyActiveRuns(concurrency)",
    "function renderProjectRunSlotEscalation(project)",
    "function prefillRunSlotEscalation(projectName)",
    "function openProjectActiveRun(runProject, runId)",
    "function pauseProjectActiveRun(runProject, runId)",
    "function cancelProjectActiveRun(runProject, runId)",
    "function projectRunCommentUrl(runProject, runId)",
    "function bindProjectActionButtons(root)",
    "data-project-concurrency-project",
    "data-project-active-run-id",
    "data-project-active-run-pause-id",
    "data-project-active-run-cancel-id",
    "data-project-run-slot-escalate",
    "No project concurrency pressure",
  ];
  const missingMarkers = markers.filter((marker) => !html.includes(marker));
  if (missingMarkers.length) {
    throw smokeCheckError(
      "SMOKE_ONLINE_PROJECT_CONCURRENCY_UI_MISSING",
      "smoke dashboard HTML did not include the expected project concurrency operator UI",
      { surface: "dashboard", missingMarkers },
    );
  }
}

export function verifySmokeOnlineBrainSurface(surface: "dashboard" | "workbench", html: string, markers: string[]): void {
  const missingMarkers = markers.filter((marker) => !html.includes(marker));
  if (missingMarkers.length) {
    throw smokeCheckError(
      "SMOKE_ONLINE_BRAIN_UI_MISSING",
      `smoke ${surface} HTML did not include the expected brain signal feed UI`,
      { surface, missingMarkers },
    );
  }
}

export function verifySmokeOnlineTokenScrubSurface(surface: "dashboard" | "workbench", html: string): void {
  const markers = [
    "function scrubTokenFromBrowserUrl()",
    "scrubTokenFromBrowserUrl()",
    'params.delete("token")',
  ];
  const missingMarkers = markers.filter((marker) => !html.includes(marker));
  if (missingMarkers.length) {
    throw smokeCheckError(
      "SMOKE_ONLINE_TOKEN_SCRUB_MISSING",
      `smoke ${surface} HTML did not include the expected one-shot token scrub UI`,
      { surface, missingMarkers },
    );
  }
}

export async function verifySmokeProjectSourceDefaults(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
): Promise<HarnessSmokeSourceDefaults> {
  await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/source-defaults`,
    {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        ...SMOKE_SOURCE_DEFAULTS,
        clientId: "loom-smoke-source-defaults",
      }),
    },
    [200],
    "PUT smoke project source defaults",
  );

  const projectSummary = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}`,
    { headers },
    [200],
    "GET smoke project source defaults",
  );
  const repo = stringFieldFromResponse(projectSummary.body, "repo", "smoke project source defaults");
  const branch = stringFieldFromResponse(projectSummary.body, "branch", "smoke project source defaults");
  const baseBranch = stringFieldFromResponse(projectSummary.body, "baseBranch", "smoke project source defaults");
  const issue = stringFieldFromResponse(projectSummary.body, "issue", "smoke project source defaults");
  if (
    repo !== SMOKE_SOURCE_DEFAULTS.repo ||
    branch !== SMOKE_SOURCE_DEFAULTS.branch ||
    baseBranch !== SMOKE_SOURCE_DEFAULTS.baseBranch ||
    issue !== SMOKE_SOURCE_DEFAULTS.issue
  ) {
    throw smokeCheckError(
      "SMOKE_SOURCE_DEFAULTS_DRIFT",
      `project ${tenant}/${project} source defaults did not round-trip`,
      {
        scope: "source-defaults",
        tenant,
        project,
        expected: SMOKE_SOURCE_DEFAULTS,
        actual: { repo, branch, baseBranch, issue },
      },
    );
  }

  return { repo, branch, baseBranch, issue };
}

export function verifySmokeRunSourceDefaults(source: unknown, expected: HarnessSmokeSourceDefaults): HarnessSmokeSourceDefaultsResult {
  const metadata = recordFieldFromResponse(source, "metadata", "smoke source-defaulted run");
  const repo = stringFieldFromResponse(metadata, "repo", "smoke source-defaulted run metadata");
  const branch = stringFieldFromResponse(metadata, "branch", "smoke source-defaulted run metadata");
  const baseBranch = stringFieldFromResponse(metadata, "baseBranch", "smoke source-defaulted run metadata");
  const issue = stringFieldFromResponse(metadata, "issue", "smoke source-defaulted run metadata");
  const issueUrl = typeof metadata.issueUrl === "string" ? metadata.issueUrl : undefined;
  if (repo !== expected.repo || branch !== expected.branch || baseBranch !== expected.baseBranch || issue !== expected.issue) {
    throw smokeCheckError(
      "SMOKE_SOURCE_DEFAULTS_RUN_DRIFT",
      "smoke run did not inherit project source defaults",
      {
        scope: "source-defaults",
        expected,
        actual: { repo, branch, baseBranch, issue },
      },
    );
  }
  return {
    sourceDefaultsChecked: true,
    sourceDefaultsRepo: repo,
    sourceDefaultsBranch: branch,
    sourceDefaultsBaseBranch: baseBranch,
    sourceDefaultsIssue: issue,
    sourceDefaultsIssueUrl: issueUrl,
  };
}

export function verifySmokeSourceDefaultsMetadata(
  source: unknown,
  expected: HarnessSmokeSourceDefaultsResult,
  label: string,
): HarnessSmokeSourceDefaults & { issueUrl?: string } {
  const repo = stringFieldFromResponse(source, "repo", label);
  const branch = stringFieldFromResponse(source, "branch", label);
  const baseBranch = stringFieldFromResponse(source, "baseBranch", label);
  const issue = stringFieldFromResponse(source, "issue", label);
  const issueUrl = typeof (source as Record<string, unknown>).issueUrl === "string"
    ? (source as Record<string, string>).issueUrl
    : undefined;
  if (
    repo !== expected.sourceDefaultsRepo ||
    branch !== expected.sourceDefaultsBranch ||
    baseBranch !== expected.sourceDefaultsBaseBranch ||
    issue !== expected.sourceDefaultsIssue ||
    (expected.sourceDefaultsIssueUrl !== undefined && issueUrl !== expected.sourceDefaultsIssueUrl)
  ) {
    throw smokeCheckError(
      "SMOKE_SOURCE_DEFAULTS_HANDOFF_DRIFT",
      `${label} did not preserve source defaults`,
      {
        scope: "handoff",
        expected: {
          repo: expected.sourceDefaultsRepo,
          branch: expected.sourceDefaultsBranch,
          baseBranch: expected.sourceDefaultsBaseBranch,
          issue: expected.sourceDefaultsIssue,
          issueUrl: expected.sourceDefaultsIssueUrl,
        },
        actual: { repo, branch, baseBranch, issue, issueUrl },
      },
    );
  }
  return { repo, branch, baseBranch, issue, issueUrl };
}

export async function verifySmokeAgentGitServiceHandoffWorkspaceAttachment(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
  runId: string,
): Promise<HarnessSmokeAgentGitServiceHandoffAttachmentResult | undefined> {
  const events = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(runId)}/events?project=${encodeURIComponent(project)}`,
    { headers },
    [200],
    "GET smoke AGS handoff attachment events",
  );
  if (!Array.isArray(events.body)) throw new Error("smoke AGS handoff attachment events response was not an array");
  const event = events.body.find((item) => {
    if (!isRecord(item) || item.type !== "external_effect") return false;
    const data = item.data;
    return isRecord(data) &&
      data.kind === "agent_git_service_workspace_attachment" &&
      data.controlPlaneProvider === "agent-git-service";
  });
  if (!isRecord(event) || !isRecord(event.data)) return undefined;
  const attachmentUrl = optionalStringFieldFromResponse(event.data, "attachmentUrl");
  const handoffFollowupsUrl = optionalStringFieldFromResponse(event.data, "handoffFollowupsUrl");
  return {
    agentGitServiceHandoffWorkspaceAttachmentChecked: true,
    agentGitServiceHandoffWorkspaceAttachmentWorkspaceId: stringFieldFromResponse(event.data, "workspaceId", "smoke AGS handoff attachment event"),
    agentGitServiceHandoffWorkspaceAttachmentId: stringFieldFromResponse(event.data, "attachmentId", "smoke AGS handoff attachment event"),
    agentGitServiceHandoffPackageUrl: stringFieldFromResponse(event.data, "handoffPackageUrl", "smoke AGS handoff attachment event"),
    ...(attachmentUrl ? { agentGitServiceHandoffWorkspaceAttachmentUrl: attachmentUrl } : {}),
    ...(handoffFollowupsUrl ? { agentGitServiceHandoffFollowupsUrl: handoffFollowupsUrl } : {}),
  };
}

export async function verifySmokeVasLiteProject(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
  template: ProjectTemplateName,
): Promise<HarnessSmokeVasResult> {
  if (template !== "vas-lite") throw new Error("--check-vas requires --template vas-lite");
  const vasBaseUrl = `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/vas`;
  const casesResponse = await smokeJson(`${vasBaseUrl}/cases`, { headers }, [200], "GET smoke VAS cases");
  const vasTemplate = stringFieldFromResponse(casesResponse.body, "template", "smoke VAS cases");
  if (vasTemplate !== "vas-lite") throw new Error(`smoke VAS cases reported template ${JSON.stringify(vasTemplate)}`);
  const cases = arrayFieldFromResponse(casesResponse.body, "cases", "smoke VAS cases");
  const bootstrap = cases.find((item) => isRecord(item) && item.id === "bootstrap");
  if (!isRecord(bootstrap)) throw new Error("smoke VAS cases did not include bootstrap");
  const bootstrapStatus = stringFieldFromResponse(bootstrap, "status", "smoke VAS bootstrap case");

  const queueResponse = await smokeJson(`${vasBaseUrl}/review-queue`, { headers }, [200], "GET smoke VAS review queue");
  const queueTemplate = stringFieldFromResponse(queueResponse.body, "template", "smoke VAS review queue");
  if (queueTemplate !== "vas-lite") throw new Error(`smoke VAS review queue reported template ${JSON.stringify(queueTemplate)}`);
  const queueCases = arrayFieldFromResponse(queueResponse.body, "cases", "smoke VAS review queue");
  if (!queueCases.some((item) => isRecord(item) && item.id === "bootstrap")) {
    throw new Error("smoke VAS review queue did not include bootstrap");
  }

  const reviewPackageResponse = await smokeJson(`${vasBaseUrl}/cases/bootstrap/review-package`, { headers }, [200], "GET smoke VAS review package");
  const reviewPackageTemplate = stringFieldFromResponse(reviewPackageResponse.body, "template", "smoke VAS review package");
  if (reviewPackageTemplate !== "vas-lite") throw new Error(`smoke VAS review package reported template ${JSON.stringify(reviewPackageTemplate)}`);
  const reviewPackageCaseId = stringFieldFromResponse(reviewPackageResponse.body, "caseId", "smoke VAS review package");
  if (reviewPackageCaseId !== "bootstrap") {
    throw new Error(`smoke VAS review package reported case ${JSON.stringify(reviewPackageCaseId)}`);
  }

  const reviewRunResponse = await smokeJson(
    `${url}/runs`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        tenant,
        project,
        preset: "vas-lite-review",
        presetInput: { caseId: "bootstrap" },
        reviewRequired: false,
        requester: { clientId: "loom-smoke" },
      }),
    },
    [201],
    "POST smoke VAS review run",
  );
  const reviewRunId = stringFieldFromResponse(reviewRunResponse.body, "runId", "smoke VAS review run");
  const reviewRunStatus = stringFieldFromResponse(reviewRunResponse.body, "status", "smoke VAS review run");
  if (reviewRunStatus !== "passed") throw new Error(`smoke VAS review run finished with status ${reviewRunStatus}`);
  const reviewRunMetadata = recordFieldFromResponse(reviewRunResponse.body, "metadata", "smoke VAS review run");
  const reviewRunPreset = stringFieldFromResponse(reviewRunMetadata, "runPreset", "smoke VAS review run metadata");
  if (reviewRunPreset !== "vas-lite-review") {
    throw new Error(`smoke VAS review run reported preset ${JSON.stringify(reviewRunPreset)}`);
  }
  const reviewRunPresetInput = recordFieldFromResponse(reviewRunMetadata, "runPresetInput", "smoke VAS review run metadata");
  const reviewRunCaseId = stringFieldFromResponse(reviewRunPresetInput, "caseId", "smoke VAS review run preset input");
  if (reviewRunCaseId !== "bootstrap") {
    throw new Error(`smoke VAS review run reported case ${JSON.stringify(reviewRunCaseId)}`);
  }

  const artifactsResponse = await smokeJson(`${vasBaseUrl}/cases/bootstrap/artifacts`, { headers }, [200], "GET smoke VAS artifacts");
  const artifactsTemplate = stringFieldFromResponse(artifactsResponse.body, "template", "smoke VAS artifacts");
  if (artifactsTemplate !== "vas-lite") throw new Error(`smoke VAS artifacts reported template ${JSON.stringify(artifactsTemplate)}`);
  const artifactsCaseId = stringFieldFromResponse(artifactsResponse.body, "caseId", "smoke VAS artifacts");
  if (artifactsCaseId !== "bootstrap") throw new Error(`smoke VAS artifacts reported case ${JSON.stringify(artifactsCaseId)}`);
  const reportPath = stringFieldFromResponse(artifactsResponse.body, "reportPath", "smoke VAS artifacts");
  const contextPath = stringFieldFromResponse(artifactsResponse.body, "contextPath", "smoke VAS artifacts");
  const report = stringFieldFromResponse(artifactsResponse.body, "report", "smoke VAS artifacts");
  if (!report.includes("VAS Lite Review") || !report.includes("preset=vas-lite-review")) {
    throw new Error("smoke VAS report did not include review preset evidence");
  }
  const context = recordFieldFromResponse(artifactsResponse.body, "context", "smoke VAS artifacts");
  const contextCaseId = stringFieldFromResponse(context, "caseId", "smoke VAS artifacts context");
  if (contextCaseId !== "bootstrap") throw new Error(`smoke VAS context reported case ${JSON.stringify(contextCaseId)}`);
  const reviewGateResult = await verifySmokeVasReviewGate(url, headers, tenant, project);

  return {
    vasReadinessChecked: true,
    vasTemplate: "vas-lite",
    vasBootstrapCaseId: "bootstrap",
    vasBootstrapCaseFound: true,
    vasBootstrapCaseStatus: bootstrapStatus,
    vasReviewQueueRead: true,
    vasReviewQueueCaseCount: queueCases.length,
    vasReviewPackageRead: true,
    vasReviewPackageCaseId: "bootstrap",
    vasReviewRunExecuted: true,
    vasReviewRunId: reviewRunId,
    vasReviewRunStatus: "passed",
    vasReviewRunPreset: "vas-lite-review",
    vasReviewRunCaseId: "bootstrap",
    vasReviewArtifactsRead: true,
    vasReviewReportPath: reportPath,
    vasReviewContextPath: contextPath,
    vasReviewContextCaseId: "bootstrap",
    ...reviewGateResult,
  };
}

export async function verifySmokeVasReviewGate(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
): Promise<HarnessSmokeVasReviewGateResult> {
  const caseId = "loom-smoke-gate";
  const learningText = "Loom smoke review gates preserve approved learning updates";
  const vasBaseUrl = `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/vas`;
  await smokeJson(
    `${vasBaseUrl}/cases`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        caseId,
        title: "Loom smoke review gate",
        source: { kind: "manual", url: "loom://smoke-review-gate", range: { start: 0, end: 1 } },
        clientId: "loom-smoke",
      }),
    },
    [201, 409],
    "POST smoke VAS review gate case",
  );

  const gateRunResponse = await smokeJson(
    `${url}/runs`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        tenant,
        project,
        preset: "vas-lite-review",
        presetInput: { caseId },
        reviewRequired: true,
        requester: { clientId: "loom-smoke" },
      }),
    },
    [201],
    "POST smoke VAS review-gated run",
  );
  const gateRunId = stringFieldFromResponse(gateRunResponse.body, "runId", "smoke VAS review-gated run");
  const gateRunStatus = stringFieldFromResponse(gateRunResponse.body, "status", "smoke VAS review-gated run");
  if (gateRunStatus !== "review_required") {
    throw new Error(`smoke VAS review-gated run finished with status ${gateRunStatus}`);
  }
  const gateReview = recordFieldFromResponse(gateRunResponse.body, "review", "smoke VAS review-gated run");
  const gateReviewStatus = stringFieldFromResponse(gateReview, "status", "smoke VAS review-gated run review");
  if (gateReviewStatus !== "pending") {
    throw new Error(`smoke VAS review-gated run review status was ${JSON.stringify(gateReviewStatus)}`);
  }

  const reviewResponse = await smokeJson(
    `${vasBaseUrl}/cases/${encodeURIComponent(caseId)}/review`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        decision: "approved",
        note: "loom smoke approved the review gate",
        corrections: ["Keep review-gated VAS runs behind human approval"],
        learnings: [learningText],
        runId: gateRunId,
        clientId: "loom-smoke",
      }),
    },
    [200],
    "POST smoke VAS case review",
  );
  const reviewedCaseId = stringFieldFromResponse(reviewResponse.body, "id", "smoke VAS case review");
  if (reviewedCaseId !== caseId) throw new Error(`smoke VAS case review reported case ${JSON.stringify(reviewedCaseId)}`);
  const reviewedStatus = stringFieldFromResponse(reviewResponse.body, "status", "smoke VAS case review");
  if (reviewedStatus !== "reviewed") throw new Error(`smoke VAS case review status was ${JSON.stringify(reviewedStatus)}`);

  const learningsResponse = await smokeJson(`${vasBaseUrl}/learnings`, { headers }, [200], "GET smoke VAS learnings");
  const learnings = arrayFieldFromResponse(learningsResponse.body, "learnings", "smoke VAS learnings");
  const learningRecorded = learnings.some((item) =>
    isRecord(item) &&
    item.caseId === caseId &&
    item.text === learningText &&
    item.reviewDecision === "approved" &&
    item.runId === gateRunId
  );
  if (!learningRecorded) throw new Error("smoke VAS learnings did not include the approved review learning");

  const learnedPatterns = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/files?path=${encodeURIComponent("vocabulary/learned-patterns.md")}`,
    { headers },
    [200],
    "GET smoke VAS learned patterns",
  );
  const learnedPatternsContent = stringFieldFromResponse(learnedPatterns.body, "content", "smoke VAS learned patterns");
  if (!learnedPatternsContent.includes(learningText) || !learnedPatternsContent.includes(`run=${gateRunId}`)) {
    throw new Error("smoke VAS learned patterns did not include the approved review learning");
  }
  const agentGitServiceWikiMemory = await verifySmokeAgentGitServiceWikiMemoryProjection(
    url,
    headers,
    tenant,
    project,
    caseId,
  );

  return {
    vasReviewGateChecked: true,
    vasReviewGateCaseId: caseId,
    vasReviewGateRunId: gateRunId,
    vasReviewGateRunStatus: "review_required",
    vasReviewGateDecision: "approved",
    vasReviewGateCaseStatus: "reviewed",
    vasReviewLearningRecorded: true,
    vasReviewLearningText: learningText,
    vasReviewLearnedPatternsRead: true,
    ...(agentGitServiceWikiMemory ?? {}),
  };
}

export async function verifySmokeAgentGitServiceWikiMemoryProjection(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
  caseId: string,
): Promise<HarnessSmokeAgentGitServiceWikiMemoryResult | undefined> {
  const audit = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/audit?project=${encodeURIComponent(project)}`,
    { headers },
    [200],
    "GET smoke AGS wiki memory audit",
  );
  if (!Array.isArray(audit.body)) throw new Error("smoke AGS wiki memory audit response was not an array");
  const event = audit.body.find((item) => {
    if (!isRecord(item) || item.type !== "agent_git_service_wiki_memory_updated") return false;
    const data = item.data;
    return isRecord(data) &&
      data.provider === "agent-git-service" &&
      data.project === project &&
      data.caseId === caseId;
  });
  if (!isRecord(event) || !isRecord(event.data)) return undefined;
  const sha = optionalStringFieldFromResponse(event.data, "sha");
  const memoryUrl = optionalStringFieldFromResponse(event.data, "url");
  return {
    agentGitServiceWikiMemoryChecked: true,
    agentGitServiceWikiMemoryPage: stringFieldFromResponse(event.data, "page", "smoke AGS wiki memory audit"),
    agentGitServiceWikiMemoryLearningCount: numberFieldFromResponse(event.data, "learningCount", "smoke AGS wiki memory audit"),
    ...(sha ? { agentGitServiceWikiMemorySha: sha } : {}),
    ...(memoryUrl ? { agentGitServiceWikiMemoryUrl: memoryUrl } : {}),
  };
}
