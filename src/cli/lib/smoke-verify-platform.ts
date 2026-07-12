import { CONTROL_PLANE_PROVIDER_BOUNDARY, type ControlPlaneProviderAdoptionStage, controlPlaneProviderCatalogEntry, SERVE_CONTROL_PLANE_PROVIDERS } from "../../harness/control-plane.js";
import { ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS } from "../../harness/profile-contract.js";
import { type ControlPlaneProviderName } from "../../harness/server.js";
import { isRecord, isServeControlPlaneProvider } from "./flags.js";

import { verifySmokeExpectedControlPlaneProvider } from "./smoke-verify-integrations.js";
import { arrayFieldFromResponse, backupMigrationTargetProviderFor, booleanFieldFromResponse, type HarnessSmokeAuthRolesResult, type HarnessSmokeBackupManifestResult, type HarnessSmokeCliOptions, type HarnessSmokeGateResult, type HarnessSmokeHealthProbeResult, type HarnessSmokeMetricsResult, type HarnessSmokeModelResult, type HarnessSmokeOnlineSandboxGoldenPathResult, type HarnessSmokePolicyEscalationResult, type HarnessSmokeProfileName, type HarnessSmokeWarningMetricsResult, numberFieldFromResponse, recordFieldFromResponse, SMOKE_CONCURRENCY_ADMISSION_BLOCKED_REASONS, SMOKE_CONCURRENCY_ADMISSION_SCHEMA_VERSION, SMOKE_HEALTH_PROBE_FORBIDDEN_FIELDS, SMOKE_ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES, SMOKE_REQUIRED_VISION_LOCK_CAPABILITIES, SMOKE_REQUIRED_VISION_LOCK_TARGET_MARKERS, smokeAdminToken, smokeCheckError, smokeHeaders, smokeJson, smokeText, smokeToken, smokeViewerToken, stringFieldFromResponse, waitForReadyz } from "./smoke.js";

export async function verifySmokeWarningMetrics(
  url: string,
  adminHeaders: Record<string, string>,
  developerHeaders: Record<string, string>,
  options: HarnessSmokeCliOptions,
  tenant: string,
  project: string,
  modelResult: HarnessSmokeModelResult,
): Promise<HarnessSmokeWarningMetricsResult> {
  const limits: Record<string, number> = { workspaceByteWarning: 1 };
  if (modelResult.modelRunUsageTotalTokens > 1) {
    limits.modelProjectTotalTokenWarning = modelResult.modelRunUsageTotalTokens - 1;
  } else if (modelResult.modelRunUsageCostUsd !== undefined && modelResult.modelRunUsageCostUsd > 0) {
    limits.modelProjectCostUsdWarning = modelResult.modelRunUsageCostUsd / 2;
  } else {
    throw smokeCheckError(
      "SMOKE_WARNING_METRICS_MODEL_USAGE_TOO_LOW",
      "smoke model usage was too low to force a model warning metric with positive warning thresholds",
      { scope: "metrics", tenant, project, modelRunId: modelResult.modelRunId },
    );
  }

  await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/policy/settings`,
    {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        limits,
        clientId: "loom-smoke-warning-metrics",
      }),
    },
    [200],
    "POST smoke warning metrics policy",
  );

  const metrics = await verifySmokeMetrics(url, adminHeaders, options, tenant, project);
  const missingNames = [
    metrics.metricsModelUsageWarningProjects < 1 ? "loom_harness_model_usage_warning_projects" : undefined,
    metrics.metricsWorkspaceUsageWarningProjects < 1 ? "loom_harness_workspace_usage_warning_projects" : undefined,
  ].filter((name): name is string => Boolean(name));
  if (missingNames.length) {
    throw smokeCheckError(
      "SMOKE_WARNING_METRICS_MISSING",
      "smoke metrics did not reflect model/workspace warning pressure after lowering warning thresholds",
      {
        scope: "metrics",
        tenant,
        project,
        missingNames,
        modelUsageWarningProjects: metrics.metricsModelUsageWarningProjects,
        workspaceUsageWarningProjects: metrics.metricsWorkspaceUsageWarningProjects,
      },
    );
  }

  const modelWarningQueueResponse = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/model-usage/warnings`,
    { headers: adminHeaders },
    [200],
    "GET smoke model usage warning queue",
  );
  const modelWarningProjects = arrayFieldFromResponse(modelWarningQueueResponse.body, "projects", "smoke model usage warning queue");
  const modelWarningProject = modelWarningProjects.find((entry) =>
    isRecord(entry) &&
    entry.project === project &&
    Array.isArray(entry.modelUsageWarnings) &&
    entry.modelUsageWarnings.length > 0
  );
  if (!isRecord(modelWarningProject)) {
    throw smokeCheckError(
      "SMOKE_WARNING_QUEUE_MISSING",
      "smoke model usage warning queue did not include the project after lowering warning thresholds",
      { scope: "metrics", queue: "model_usage", tenant, project, projectCount: modelWarningProjects.length },
    );
  }
  const modelWarningQueueWarningCount = arrayFieldFromResponse(
    modelWarningProject,
    "modelUsageWarnings",
    "smoke model usage warning queue project",
  ).length;

  const workspaceWarningQueueResponse = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/workspace-usage/warnings`,
    { headers: adminHeaders },
    [200],
    "GET smoke workspace usage warning queue",
  );
  const workspaceWarningProjects = arrayFieldFromResponse(workspaceWarningQueueResponse.body, "projects", "smoke workspace usage warning queue");
  const workspaceWarningProject = workspaceWarningProjects.find((entry) =>
    isRecord(entry) &&
    entry.project === project &&
    Array.isArray(entry.workspaceByteWarnings) &&
    entry.workspaceByteWarnings.length > 0
  );
  if (!isRecord(workspaceWarningProject)) {
    throw smokeCheckError(
      "SMOKE_WARNING_QUEUE_MISSING",
      "smoke workspace usage warning queue did not include the project after lowering warning thresholds",
      { scope: "metrics", queue: "workspace_usage", tenant, project, projectCount: workspaceWarningProjects.length },
    );
  }
  const workspaceWarningQueueWarningCount = arrayFieldFromResponse(
    workspaceWarningProject,
    "workspaceByteWarnings",
    "smoke workspace usage warning queue project",
  ).length;

  const modelWarningEscalation = await requestSmokeWarningEscalation(
    url,
    developerHeaders,
    tenant,
    project,
    "model_usage_warning",
    "loom-smoke-model-warning-escalation",
    {
      modelProjectTotalTokenLimit: Math.max(modelResult.modelRunUsageTotalTokens + 1000, 1000),
    },
    "loom smoke validates model warning budget escalation",
  );
  const workspaceWarningEscalation = await requestSmokeWarningEscalation(
    url,
    developerHeaders,
    tenant,
    project,
    "workspace_usage_warning",
    "loom-smoke-workspace-warning-escalation",
    {
      maxWorkspaceBytes: 1_048_576,
      workspaceByteWarning: 524_288,
    },
    "loom smoke validates workspace warning quota escalation",
  );

  const escalationsResponse = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/policy/escalations`,
    { headers: developerHeaders },
    [200],
    "GET smoke warning policy escalations",
  );
  if (!Array.isArray(escalationsResponse.body)) throw new Error("smoke warning policy escalations response was not an array");
  for (const expected of [modelWarningEscalation, workspaceWarningEscalation]) {
    const listed = escalationsResponse.body.find((item) => isRecord(item) && item.id === expected.id);
    if (!isRecord(listed) || !isRecord(listed.source) || listed.source.kind !== expected.sourceKind || listed.source.project !== project) {
      throw smokeCheckError(
        "SMOKE_WARNING_ESCALATION_MISSING",
        "smoke warning escalation list did not preserve the warning source",
        { scope: "metrics", tenant, project, escalationId: expected.id, sourceKind: expected.sourceKind },
      );
    }
  }

  const auditResponse = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/audit`,
    { headers: developerHeaders },
    [200],
    "GET smoke warning escalation audit",
  );
  const auditEvents = auditResponse.body;
  if (!Array.isArray(auditEvents)) throw new Error("smoke warning escalation audit response was not an array");
  const warningAuditChecked = [modelWarningEscalation, workspaceWarningEscalation].every((expected) =>
    auditEvents.some((event) =>
      isRecord(event) &&
      event.type === "tenant_policy_escalation_requested" &&
      isRecord(event.data) &&
      event.data.escalationId === expected.id &&
      event.data.clientId === expected.clientId &&
      isRecord(event.data.source) &&
      event.data.source.kind === expected.sourceKind &&
      event.data.source.project === project
    )
  );
  if (!warningAuditChecked) {
    throw smokeCheckError(
      "SMOKE_WARNING_ESCALATION_AUDIT_MISSING",
      "smoke audit did not include warning-sourced escalation requests",
      {
        scope: "metrics",
        tenant,
        project,
        escalationIds: [modelWarningEscalation.id, workspaceWarningEscalation.id],
      },
    );
  }

  return {
    modelWarningMetricsChecked: true,
    modelWarningMetricsModelUsageWarningProjects: metrics.metricsModelUsageWarningProjects,
    modelWarningQueueChecked: true,
    modelWarningQueueProject: project,
    modelWarningQueueWarningCount,
    modelWarningEscalationChecked: true,
    modelWarningEscalationId: modelWarningEscalation.id,
    modelWarningEscalationSourceKind: "model_usage_warning",
    workspaceWarningMetricsChecked: true,
    workspaceWarningMetricsWorkspaceUsageWarningProjects: metrics.metricsWorkspaceUsageWarningProjects,
    workspaceWarningQueueChecked: true,
    workspaceWarningQueueProject: project,
    workspaceWarningQueueWarningCount,
    workspaceWarningEscalationChecked: true,
    workspaceWarningEscalationId: workspaceWarningEscalation.id,
    workspaceWarningEscalationSourceKind: "workspace_usage_warning",
    warningEscalationAuditChecked: true,
  };
}

export async function requestSmokeWarningEscalation(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
  sourceKind: "model_usage_warning" | "workspace_usage_warning",
  clientId: string,
  limits: Record<string, number>,
  detail: string,
): Promise<{ id: string; sourceKind: "model_usage_warning" | "workspace_usage_warning"; clientId: string }> {
  const response = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/policy/escalations`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        limits,
        source: { kind: sourceKind, project, detail },
        reason: detail,
        clientId,
      }),
    },
    [201],
    `POST smoke ${sourceKind} policy escalation`,
  );
  const id = stringFieldFromResponse(response.body, "id", `smoke ${sourceKind} policy escalation`);
  const status = stringFieldFromResponse(response.body, "status", `smoke ${sourceKind} policy escalation`);
  if (status !== "pending") throw new Error(`smoke ${sourceKind} policy escalation status was ${JSON.stringify(status)}`);
  const source = recordFieldFromResponse(response.body, "source", `smoke ${sourceKind} policy escalation`);
  const actualSourceKind = stringFieldFromResponse(source, "kind", `smoke ${sourceKind} policy escalation source`);
  const sourceProject = stringFieldFromResponse(source, "project", `smoke ${sourceKind} policy escalation source`);
  if (actualSourceKind !== sourceKind || sourceProject !== project) {
    throw smokeCheckError(
      "SMOKE_WARNING_ESCALATION_SOURCE_MISMATCH",
      "smoke warning policy escalation did not preserve the requested warning source",
      { scope: "metrics", tenant, project, sourceKind, actualSourceKind, sourceProject },
    );
  }
  return { id, sourceKind, clientId };
}

export async function verifySmokeBackupManifest(
  url: string,
  options: HarnessSmokeCliOptions,
  tenant: string,
  project: string,
  expectedControlPlaneProvider?: ControlPlaneProviderName,
): Promise<HarnessSmokeBackupManifestResult> {
  const adminToken = smokeAdminToken(options);
  if (!adminToken) throw new Error("--check-backup requires --admin-token or --admin-token-env");
  const backup = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/control-plane/backup`,
    { headers: smokeHeaders(adminToken) },
    [200],
    "GET smoke control-plane backup manifest",
  );
  const schemaVersion = numberFieldFromResponse(backup.body, "schemaVersion", "smoke backup manifest");
  if (schemaVersion !== 1) throw new Error(`smoke backup manifest schemaVersion was ${schemaVersion}`);
  const backupManifestTenant = stringFieldFromResponse(backup.body, "tenant", "smoke backup manifest");
  if (backupManifestTenant !== tenant) {
    throw new Error(`smoke backup manifest tenant was ${JSON.stringify(backupManifestTenant)}`);
  }
  stringFieldFromResponse(backup.body, "generatedAt", "smoke backup manifest");
  const controlPlane = recordFieldFromResponse(backup.body, "controlPlane", "smoke backup manifest");
  const provider = stringFieldFromResponse(controlPlane, "provider", "smoke backup manifest controlPlane");
  if (!isServeControlPlaneProvider(provider)) {
    throw smokeCheckError(
      "SMOKE_BACKUP_MANIFEST_INVALID",
      "smoke backup manifest provider was not a serve-enabled control-plane provider",
      { scope: "backup", tenant, provider },
    );
  }
  verifySmokeExpectedControlPlaneProvider(
    expectedControlPlaneProvider,
    provider,
    "control-plane-backup",
    { tenant, project },
  );
  const backupMigrationTargetProvider = backupMigrationTargetProviderFor(provider);
  const boundary = requireSmokeStringArray(
    arrayFieldFromResponse(controlPlane, "boundary", "smoke backup manifest controlPlane"),
    "smoke backup manifest controlPlane.boundary must be strings",
    "SMOKE_BACKUP_MANIFEST_INVALID",
    { scope: "backup", tenant, field: "controlPlane.boundary" },
  );
  const missingBoundary = CONTROL_PLANE_PROVIDER_BOUNDARY.filter((capability) => !boundary.includes(capability));
  if (missingBoundary.length) {
    throw smokeCheckError(
      "SMOKE_BACKUP_MANIFEST_DRIFT",
      "smoke backup manifest did not expose the complete control-plane provider boundary",
      { scope: "backup", tenant, missing: missingBoundary },
    );
  }
  const projects = arrayFieldFromResponse(backup.body, "projects", "smoke backup manifest");
  const projectEntry = projects.find((entry) => isRecord(entry) && entry.project === project);
  if (!isRecord(projectEntry)) {
    throw smokeCheckError(
      "SMOKE_BACKUP_MANIFEST_DRIFT",
      `smoke backup manifest did not include project ${project}`,
      { scope: "backup", tenant, project },
    );
  }
  const runs = arrayFieldFromResponse(projectEntry, "runs", "smoke backup manifest project");
  if (!runs.some((entry) => isRecord(entry) && typeof entry.runId === "string")) {
    throw smokeCheckError(
      "SMOKE_BACKUP_MANIFEST_DRIFT",
      `smoke backup manifest project ${project} did not include run evidence`,
      { scope: "backup", tenant, project },
    );
  }
  const audit = recordFieldFromResponse(backup.body, "audit", "smoke backup manifest");
  const backupManifestAuditEventCount = numberFieldFromResponse(audit, "eventCount", "smoke backup manifest audit");
  if (backupManifestAuditEventCount < 1) {
    throw smokeCheckError(
      "SMOKE_BACKUP_MANIFEST_DRIFT",
      "smoke backup manifest did not include an audit checkpoint",
      { scope: "backup", tenant },
    );
  }
  const serialized = JSON.stringify(backup.body);
  const knownSmokeTokens = [smokeToken(options), smokeViewerToken(options), adminToken]
    .filter((token): token is string => Boolean(token));
  const leaked = knownSmokeTokens.filter((token) => serialized.includes(token));
  if (leaked.length > 0 || serialized.includes("sha256:")) {
    throw smokeCheckError(
      "SMOKE_BACKUP_MANIFEST_SECRET_LEAK",
      "smoke backup manifest included a token or token hash",
      { scope: "backup", tenant },
    );
  }
  const restoreDryRun = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/control-plane/restore-dry-run?targetProvider=${encodeURIComponent(backupMigrationTargetProvider)}`,
    {
      method: "POST",
      headers: {
        ...smokeHeaders(adminToken),
        "content-type": "application/json",
      },
      body: JSON.stringify(backup.body),
    },
    [200],
    "POST smoke control-plane restore dry run",
  );
  const backupRestoreDryRunValid = booleanFieldFromResponse(restoreDryRun.body, "valid", "smoke restore dry run");
  const backupRestoreDryRunApplied = booleanFieldFromResponse(restoreDryRun.body, "applied", "smoke restore dry run");
  const backupRestoreDryRunProvider = stringFieldFromResponse(restoreDryRun.body, "provider", "smoke restore dry run");
  const backupRestoreDryRunSourceProvider = stringFieldFromResponse(restoreDryRun.body, "sourceProvider", "smoke restore dry run");
  const backupRestoreDryRunTargetProvider = stringFieldFromResponse(restoreDryRun.body, "targetProvider", "smoke restore dry run");
  if (!backupRestoreDryRunValid || backupRestoreDryRunApplied) {
    throw smokeCheckError(
      "SMOKE_BACKUP_RESTORE_DRY_RUN_DRIFT",
      "smoke restore dry run did not report a valid non-mutating migration check",
      { scope: "backup", tenant, valid: backupRestoreDryRunValid, applied: backupRestoreDryRunApplied },
    );
  }
  if (
    backupRestoreDryRunProvider !== backupMigrationTargetProvider ||
    backupRestoreDryRunSourceProvider !== provider ||
    backupRestoreDryRunTargetProvider !== backupMigrationTargetProvider
  ) {
    throw smokeCheckError(
      "SMOKE_BACKUP_RESTORE_DRY_RUN_PROVIDER_DRIFT",
      "smoke restore dry run did not report the expected source and target providers",
      {
        scope: "backup",
        tenant,
        sourceProvider: backupRestoreDryRunSourceProvider,
        targetProvider: backupRestoreDryRunTargetProvider,
        provider: backupRestoreDryRunProvider,
      },
    );
  }
  const dryRunProjects = recordFieldFromResponse(restoreDryRun.body, "projects", "smoke restore dry run");
  const backupRestoreDryRunProjectCount = numberFieldFromResponse(dryRunProjects, "expected", "smoke restore dry run projects");
  const backupRestoreDryRunProjectNames = requireSmokeStringArray(
    arrayFieldFromResponse(dryRunProjects, "names", "smoke restore dry run projects"),
    "smoke restore dry run projects.names must be strings",
    "SMOKE_BACKUP_RESTORE_DRY_RUN_INVALID",
    { scope: "backup", tenant, field: "projects.names" },
  );
  if (!backupRestoreDryRunProjectNames.includes(project)) {
    throw smokeCheckError(
      "SMOKE_BACKUP_RESTORE_DRY_RUN_DRIFT",
      "smoke restore dry run project names did not include the smoke project",
      { scope: "backup", tenant, project, names: backupRestoreDryRunProjectNames },
    );
  }
  const dryRunMissing = requireSmokeStringArray(
    arrayFieldFromResponse(dryRunProjects, "missing", "smoke restore dry run projects"),
    "smoke restore dry run projects.missing must be strings",
    "SMOKE_BACKUP_RESTORE_DRY_RUN_INVALID",
    { scope: "backup", tenant, field: "projects.missing" },
  );
  const dryRunExtra = requireSmokeStringArray(
    arrayFieldFromResponse(dryRunProjects, "extra", "smoke restore dry run projects"),
    "smoke restore dry run projects.extra must be strings",
    "SMOKE_BACKUP_RESTORE_DRY_RUN_INVALID",
    { scope: "backup", tenant, field: "projects.extra" },
  );
  if (dryRunMissing.length || dryRunExtra.length) {
    throw smokeCheckError(
      "SMOKE_BACKUP_RESTORE_DRY_RUN_DRIFT",
      "smoke restore dry run found project drift in the just-exported manifest",
      { scope: "backup", tenant, missing: dryRunMissing, extra: dryRunExtra },
    );
  }
  const dryRunRuns = recordFieldFromResponse(restoreDryRun.body, "runs", "smoke restore dry run");
  const backupRestoreDryRunRunCount = numberFieldFromResponse(dryRunRuns, "expected", "smoke restore dry run runs");
  const dryRunSecretScrubbed = booleanFieldFromResponse(restoreDryRun.body, "secretScrubbed", "smoke restore dry run");
  if (!dryRunSecretScrubbed) {
    throw smokeCheckError(
      "SMOKE_BACKUP_RESTORE_DRY_RUN_SECRET_LEAK",
      "smoke restore dry run did not confirm secret scrubbing",
      { scope: "backup", tenant },
    );
  }
  const backupRestoreDryRunCutover = smokeBackupRestoreDryRunCutoverReadiness(
    restoreDryRun.body,
    backupMigrationTargetProvider,
    tenant,
  );
  const dryRunAudit = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/audit?after=${encodeURIComponent(String(backupManifestAuditEventCount))}`,
    { headers: smokeHeaders(adminToken) },
    [200],
    "GET smoke restore dry run audit",
  );
  const dryRunAuditEvents = Array.isArray(dryRunAudit.body) ? dryRunAudit.body : [];
  const dryRunAuditEvent = dryRunAuditEvents.find((entry) => {
    if (!isRecord(entry) || entry.type !== "tenant_control_plane_restore_dry_run") return false;
    const data = entry.data;
    return isRecord(data) &&
      data.provider === backupMigrationTargetProvider &&
      data.sourceProvider === provider &&
      data.targetProvider === backupMigrationTargetProvider &&
      data.format === "tenant-control-plane-backup-v1" &&
      data.projectCount === backupRestoreDryRunProjectCount &&
      Array.isArray(data.projects) &&
      data.projects.every((item) => typeof item === "string") &&
      data.projects.includes(project) &&
      data.runCount === backupRestoreDryRunRunCount &&
      data.secretScrubbed === true &&
      (backupRestoreDryRunCutover.backupRestoreDryRunCutoverReady === undefined ||
        data.cutoverReady === backupRestoreDryRunCutover.backupRestoreDryRunCutoverReady);
  });
  if (!dryRunAuditEvent) {
    throw smokeCheckError(
      "SMOKE_BACKUP_RESTORE_DRY_RUN_AUDIT_MISSING",
      "smoke restore dry run audit did not include migration validation evidence",
      { scope: "backup", tenant },
    );
  }
  const dryRunAuditSerialized = JSON.stringify(dryRunAuditEvent);
  if (knownSmokeTokens.some((token) => dryRunAuditSerialized.includes(token)) || dryRunAuditSerialized.includes("sha256:")) {
    throw smokeCheckError(
      "SMOKE_BACKUP_RESTORE_DRY_RUN_SECRET_LEAK",
      "smoke restore dry run audit included a token or token hash",
      { scope: "backup", tenant },
    );
  }

  return {
    backupManifestChecked: true,
    backupManifestTenant,
    backupManifestProjectCount: projects.length,
    backupManifestRunCount: runs.length,
    backupManifestAuditEventCount,
    backupManifestControlPlaneBoundary: boundary,
    backupManifestSecretScrubbed: true,
    backupRestoreDryRunChecked: true,
    backupRestoreDryRunValid: true,
    backupRestoreDryRunApplied: false,
    backupRestoreDryRunSourceProvider,
    backupRestoreDryRunTargetProvider,
    backupRestoreDryRunProjectCount,
    backupRestoreDryRunProjectNames,
    backupRestoreDryRunRunCount,
    backupRestoreDryRunAuditChecked: true,
    ...backupRestoreDryRunCutover,
  };
}

export function smokeBackupRestoreDryRunCutoverReadiness(
  body: unknown,
  targetProvider: ControlPlaneProviderName,
  tenant: string,
): Partial<HarnessSmokeBackupManifestResult> {
  if (targetProvider !== "agent-git-service") return {};
  const cutover = recordFieldFromResponse(body, "cutoverReadiness", "smoke restore dry run");
  const stage = stringFieldFromResponse(cutover, "stage", "smoke restore dry run cutoverReadiness");
  const cutoverTargetProvider = stringFieldFromResponse(cutover, "targetProvider", "smoke restore dry run cutoverReadiness");
  const ready = booleanFieldFromResponse(cutover, "ok", "smoke restore dry run cutoverReadiness");
  if (stage !== "tenant-default-cutover" || cutoverTargetProvider !== targetProvider) {
    throw smokeCheckError(
      "SMOKE_BACKUP_RESTORE_DRY_RUN_CUTOVER_DRIFT",
      "smoke restore dry run did not report the expected AGS cutover stage",
      { scope: "backup", tenant, stage, targetProvider: cutoverTargetProvider },
    );
  }
  const checks = recordFieldFromResponse(cutover, "checks", "smoke restore dry run cutoverReadiness");
  const projectAgents = recordFieldFromResponse(checks, "agentGitServiceProjectAgents", "smoke restore dry run cutoverReadiness checks");
  return {
    backupRestoreDryRunCutoverReady: ready,
    backupRestoreDryRunCutoverStage: stage,
    backupRestoreDryRunCutoverTargetProvider: cutoverTargetProvider,
    backupRestoreDryRunAgentGitServiceProjectAgentsOk: booleanFieldFromResponse(projectAgents, "ok", "smoke restore dry run agentGitServiceProjectAgents"),
    backupRestoreDryRunAgentGitServiceProjectAgentsProjectCount: numberFieldFromResponse(projectAgents, "projectCount", "smoke restore dry run agentGitServiceProjectAgents"),
    backupRestoreDryRunAgentGitServiceProjectAgentsProvisionedProjectCount: numberFieldFromResponse(projectAgents, "provisionedProjectCount", "smoke restore dry run agentGitServiceProjectAgents"),
    backupRestoreDryRunAgentGitServiceProjectAgentsSecretRootConfigured: booleanFieldFromResponse(projectAgents, "secretRootConfigured", "smoke restore dry run agentGitServiceProjectAgents"),
    backupRestoreDryRunAgentGitServiceProjectAgentsSecretStoredProjectCount: numberFieldFromResponse(projectAgents, "secretStoredProjectCount", "smoke restore dry run agentGitServiceProjectAgents"),
    backupRestoreDryRunAgentGitServiceProjectAgentsMissingProjects: requireSmokeStringArray(
      arrayFieldFromResponse(projectAgents, "missingProjects", "smoke restore dry run agentGitServiceProjectAgents"),
      "smoke restore dry run agentGitServiceProjectAgents missingProjects must be strings",
      "SMOKE_BACKUP_RESTORE_DRY_RUN_CUTOVER_INVALID",
      { scope: "backup", tenant, field: "cutoverReadiness.checks.agentGitServiceProjectAgents.missingProjects" },
    ),
    backupRestoreDryRunAgentGitServiceProjectAgentsMissingSecretProjects: requireSmokeStringArray(
      arrayFieldFromResponse(projectAgents, "missingSecretProjects", "smoke restore dry run agentGitServiceProjectAgents"),
      "smoke restore dry run agentGitServiceProjectAgents missingSecretProjects must be strings",
      "SMOKE_BACKUP_RESTORE_DRY_RUN_CUTOVER_INVALID",
      { scope: "backup", tenant, field: "cutoverReadiness.checks.agentGitServiceProjectAgents.missingSecretProjects" },
    ),
  };
}

export async function verifySmokeAuthRoles(
  url: string,
  developerHeaders: Record<string, string>,
  options: HarnessSmokeCliOptions,
  tenant: string,
  project: string,
  runId: string,
): Promise<HarnessSmokeAuthRolesResult> {
  const viewerToken = smokeViewerToken(options);
  if (!viewerToken) {
    throw smokeCheckError(
      "SMOKE_AUTH_VIEWER_TOKEN_MISSING",
      "--check-auth-roles requires --viewer-token or --viewer-token-env",
      { scope: "auth-roles", tenant, required: ["--viewer-token", "--viewer-token-env"] },
    );
  }
  const viewerHeaders = smokeHeaders(viewerToken);

  const developerAccess = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/access`,
    { headers: developerHeaders },
    [200],
    "GET smoke developer access",
  );
  const developerAccessActor = stringFieldFromResponse(developerAccess.body, "actor", "smoke developer access");
  const developerRole = stringFieldFromResponse(developerAccess.body, "role", "smoke developer access");
  if (developerRole !== "developer" && developerRole !== "admin") {
    throw new Error(`smoke developer token reported role ${JSON.stringify(developerRole)}`);
  }
  const developerAccessRole: "developer" | "admin" = developerRole;

  const viewerAccess = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/access`,
    { headers: viewerHeaders },
    [200],
    "GET smoke viewer access",
  );
  const viewerAccessActor = stringFieldFromResponse(viewerAccess.body, "actor", "smoke viewer access");
  const viewerAccessRole = stringFieldFromResponse(viewerAccess.body, "role", "smoke viewer access");
  if (viewerAccessRole !== "viewer") {
    throw smokeCheckError(
      "SMOKE_AUTH_VIEWER_ROLE_MISMATCH",
      `smoke viewer token reported role ${JSON.stringify(viewerAccessRole)}`,
      {
        scope: "auth-roles",
        tenant,
        expectedRole: "viewer",
        actualRole: viewerAccessRole,
      },
    );
  }

  const viewerTenantStatus = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/status`,
    { headers: viewerHeaders },
    [200],
    "GET smoke viewer tenant status",
  );
  const viewerReadiness = recordFieldFromResponse(viewerTenantStatus.body, "readiness", "smoke viewer tenant status");
  const viewerTenantReadinessProfile = typeof viewerReadiness.profile === "string" ? viewerReadiness.profile : undefined;
  const viewerTenantReadinessOk = booleanFieldFromResponse(viewerReadiness, "ok", "smoke viewer tenant status readiness");
  const viewerTenantReadinessMissing = arrayFieldFromResponse(viewerReadiness, "missing", "smoke viewer tenant status readiness");
  if (!viewerTenantReadinessMissing.every((item): item is string => typeof item === "string")) {
    throw new Error("smoke viewer tenant status readiness missing must be strings");
  }
  if (!viewerTenantReadinessOk) {
    throw smokeCheckError(
      "SMOKE_AUTH_VIEWER_READINESS_MISSING",
      `smoke viewer tenant status missing readiness: ${viewerTenantReadinessMissing.join(", ")}`,
      {
        scope: "auth-roles",
        tenant,
        profile: viewerTenantReadinessProfile ?? null,
        missing: viewerTenantReadinessMissing,
      },
    );
  }
  const viewerGoldenPath = verifySmokeStatusGoldenPath("auth-roles", viewerTenantReadinessProfile, viewerReadiness, tenant);
  const viewerVisionLock = recordFieldFromResponse(viewerTenantStatus.body, "visionLock", "smoke viewer tenant status");
  const viewerTenantVisionLockTarget = stringFieldFromResponse(viewerVisionLock, "target", "smoke viewer tenant status visionLock");
  const missingViewerTargetMarkers = SMOKE_REQUIRED_VISION_LOCK_TARGET_MARKERS
    .filter((marker) => !viewerTenantVisionLockTarget.includes(marker));
  if (missingViewerTargetMarkers.length) {
    throw smokeCheckError(
      "SMOKE_AUTH_VIEWER_VISION_LOCK_TARGET_MISMATCH",
      "smoke viewer tenant status reported an unexpected vision lock target",
      {
        scope: "auth-roles",
        tenant,
        actualTarget: viewerTenantVisionLockTarget,
        missingTargetMarkers: missingViewerTargetMarkers,
        requiredTargetMarkers: SMOKE_REQUIRED_VISION_LOCK_TARGET_MARKERS,
      },
    );
  }
  const viewerTenantVisionLockMvpIsScopeReduction = booleanFieldFromResponse(viewerVisionLock, "mvpIsScopeReduction", "smoke viewer tenant status visionLock");
  if (viewerTenantVisionLockMvpIsScopeReduction !== false) {
    throw smokeCheckError(
      "SMOKE_AUTH_VIEWER_VISION_LOCK_SCOPE_REDUCTION",
      "smoke viewer tenant status reported MVP as a scope reduction",
      {
        scope: "auth-roles",
        tenant,
        mvpIsScopeReduction: viewerTenantVisionLockMvpIsScopeReduction,
      },
    );
  }
  const viewerTenantVisionLockCapabilities = arrayFieldFromResponse(viewerVisionLock, "capabilities", "smoke viewer tenant status visionLock");
  if (!viewerTenantVisionLockCapabilities.every((capability): capability is string => typeof capability === "string")) {
    throw new Error("smoke viewer tenant status visionLock capabilities must be strings");
  }
  const missingViewerVisionCapabilities = SMOKE_REQUIRED_VISION_LOCK_CAPABILITIES
    .filter((capability) => !viewerTenantVisionLockCapabilities.includes(capability));
  if (missingViewerVisionCapabilities.length) {
    throw smokeCheckError(
      "SMOKE_AUTH_VIEWER_VISION_LOCK_CAPABILITIES_MISSING",
      `smoke viewer tenant status missing vision lock capabilities: ${missingViewerVisionCapabilities.join(", ")}`,
      {
        scope: "auth-roles",
        tenant,
        missingCapabilities: missingViewerVisionCapabilities,
        requiredCapabilities: SMOKE_REQUIRED_VISION_LOCK_CAPABILITIES,
      },
    );
  }

  await smokeJson(
    `${url}/runs`,
    {
      method: "POST",
      headers: { ...viewerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        tenant,
        project,
        goal: "viewer must not create smoke runs",
        script: [{ message: "finish", finish: true }],
        requester: { clientId: "loom-smoke-viewer" },
      }),
    },
    [403],
    "POST smoke viewer run create denial",
  );
  await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/files`,
    {
      method: "POST",
      headers: { ...viewerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ path: "viewer-denied.txt", content: "denied\n", clientId: "loom-smoke-viewer" }),
    },
    [403],
    "POST smoke viewer workspace write denial",
  );

  const viewerCommentText = "loom smoke viewer comment is durable";
  const runUrl = `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(runId)}`;
  const projectQuery = `project=${encodeURIComponent(project)}`;
  const commentResponse = await smokeJson(
    `${runUrl}/comments?${projectQuery}`,
    {
      method: "POST",
      headers: { ...viewerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ message: viewerCommentText, clientId: "loom-smoke-viewer" }),
    },
    [201],
    "POST smoke viewer run comment",
  );
  const commentSeq = numberFieldFromResponse(commentResponse.body, "seq", "smoke viewer run comment");
  const commentData = recordFieldFromResponse(commentResponse.body, "data", "smoke viewer run comment");
  const commentActor = stringFieldFromResponse(commentData, "actor", "smoke viewer run comment data");
  const commentRole = stringFieldFromResponse(commentData, "role", "smoke viewer run comment data");
  const commentContent = stringFieldFromResponse(commentData, "content", "smoke viewer run comment data");
  if (commentActor !== viewerAccessActor || commentRole !== "viewer" || commentContent !== viewerCommentText) {
    throw new Error("smoke viewer run comment did not preserve actor/role/content");
  }

  const replayResponse = await smokeJson(
    `${runUrl}/replay?${projectQuery}`,
    { headers: viewerHeaders },
    [200],
    "GET smoke viewer run replay",
  );
  const timeline = arrayFieldFromResponse(replayResponse.body, "timeline", "smoke viewer run replay");
  const replayEntry = timeline.find((entry) =>
    isRecord(entry) &&
    entry.seq === commentSeq &&
    entry.type === "user_message" &&
    entry.role === "viewer"
  );
  if (!isRecord(replayEntry)) throw new Error("smoke viewer run replay did not include the viewer comment");
  const replayTitle = stringFieldFromResponse(replayEntry, "title", "smoke viewer replay comment");
  const replayDetail = stringFieldFromResponse(replayEntry, "detail", "smoke viewer replay comment");
  if (!replayTitle.includes(viewerCommentText) || !replayDetail.includes(viewerCommentText)) {
    throw new Error("smoke viewer run replay did not preserve the viewer comment details");
  }

  return {
    authRolesChecked: true,
    developerAccessActor,
    developerAccessRole,
    viewerAccessActor,
    viewerAccessRole: "viewer",
    viewerTenantReadinessChecked: true,
    viewerTenantReadinessProfile,
    viewerTenantReadinessOk,
    viewerTenantReadinessMissing,
    viewerTenantGoldenPathChecked: true,
    viewerTenantGoldenPathOk: viewerGoldenPath.ok,
    viewerTenantGoldenPathCapabilities: viewerGoldenPath.capabilities,
    viewerTenantGoldenPathMissingCapabilities: viewerGoldenPath.missingCapabilities,
    viewerTenantVisionLockChecked: true,
    viewerTenantVisionLockTarget,
    viewerTenantVisionLockMvpIsScopeReduction,
    viewerTenantVisionLockCapabilities,
    viewerCreateRunDenied: true,
    viewerWorkspaceWriteDenied: true,
    viewerRunCommentAdded: true,
    viewerRunCommentReplayChecked: true,
  };
}

export async function verifySmokeGates(
  url: string,
  developerHeaders: Record<string, string>,
  options: HarnessSmokeCliOptions,
  tenant: string,
  project: string,
): Promise<HarnessSmokeGateResult> {
  const adminToken = smokeAdminToken(options);
  if (!adminToken) throw new Error("--check-gates requires --admin-token or --admin-token-env");
  const adminHeaders = smokeHeaders(adminToken);
  const adminAccess = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/access`,
    { headers: adminHeaders },
    [200],
    "GET smoke admin access",
  );
  const adminRole = stringFieldFromResponse(adminAccess.body, "role", "smoke admin access");
  if (adminRole !== "admin") throw new Error(`smoke admin token reported role ${JSON.stringify(adminRole)}`);

  const gateRunResponse = await smokeJson(
    `${url}/runs`,
    {
      method: "POST",
      headers: { ...developerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        tenant,
        project,
        goal: "loom smoke review and deployment gates",
        script: [{ message: "finish", finish: true }],
        verify: [],
        skills: ["smoke", "coding"],
        reviewRequired: true,
        deploymentRequired: true,
        requester: { clientId: "loom-smoke-gates" },
      }),
    },
    [201],
    "POST smoke gated run",
  );
  const gateRunId = stringFieldFromResponse(gateRunResponse.body, "runId", "smoke gated run");
  const reviewGateRunStatus = stringFieldFromResponse(gateRunResponse.body, "status", "smoke gated run");
  if (reviewGateRunStatus !== "review_required") {
    throw new Error(`smoke gated run finished with status ${JSON.stringify(reviewGateRunStatus)}`);
  }
  const initialReview = recordFieldFromResponse(gateRunResponse.body, "review", "smoke gated run");
  const initialReviewStatus = stringFieldFromResponse(initialReview, "status", "smoke gated run review");
  if (initialReviewStatus !== "pending") throw new Error("smoke gated run did not open review gate");
  const initialDeployment = recordFieldFromResponse(gateRunResponse.body, "deployment", "smoke gated run");
  const initialDeploymentStatus = stringFieldFromResponse(initialDeployment, "status", "smoke gated run deployment");
  if (initialDeploymentStatus !== "pending") throw new Error("smoke gated run did not preserve deployment gate");

  const reviewGateMetrics = options.checkMetrics
    ? await verifySmokeMetrics(url, adminHeaders, options, tenant, project)
    : undefined;
  if (reviewGateMetrics && reviewGateMetrics.metricsReviewRequiredRuns < 1) {
    throw smokeCheckError(
      "SMOKE_GATE_METRICS_MISSING",
      "smoke metrics did not expose the pending review gate backlog",
      { scope: "metrics", metric: "loom_harness_review_required_runs", actual: reviewGateMetrics.metricsReviewRequiredRuns },
    );
  }

  const gateRunUrl = `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(gateRunId)}`;
  const projectQuery = `project=${encodeURIComponent(project)}`;
  const reviewResponse = await smokeJson(
    `${gateRunUrl}/review?${projectQuery}`,
    {
      method: "POST",
      headers: { ...developerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved", note: "loom smoke review approved", clientId: "loom-smoke-review" }),
    },
    [200],
    "POST smoke review gate",
  );
  const deploymentGateRunStatus = stringFieldFromResponse(reviewResponse.body, "status", "smoke reviewed gated run");
  if (deploymentGateRunStatus !== "deployment_required") {
    throw new Error(`smoke reviewed gated run finished with status ${JSON.stringify(deploymentGateRunStatus)}`);
  }
  const reviewed = recordFieldFromResponse(reviewResponse.body, "review", "smoke reviewed gated run");
  const reviewDecision = stringFieldFromResponse(reviewed, "status", "smoke reviewed gated run review");
  if (reviewDecision !== "approved") throw new Error("smoke review gate was not approved");

  const deploymentGateMetrics = options.checkMetrics
    ? await verifySmokeMetrics(url, adminHeaders, options, tenant, project)
    : undefined;
  if (deploymentGateMetrics && deploymentGateMetrics.metricsDeploymentRequiredRuns < 1) {
    throw smokeCheckError(
      "SMOKE_GATE_METRICS_MISSING",
      "smoke metrics did not expose the pending deployment gate backlog",
      { scope: "metrics", metric: "loom_harness_deployment_required_runs", actual: deploymentGateMetrics.metricsDeploymentRequiredRuns },
    );
  }

  await smokeJson(
    `${gateRunUrl}/deployment?${projectQuery}`,
    {
      method: "POST",
      headers: { ...developerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved", note: "developer cannot deploy", clientId: "loom-smoke-dev-deploy" }),
    },
    [403],
    "POST smoke developer deployment denial",
  );

  const deploymentResponse = await smokeJson(
    `${gateRunUrl}/deployment?${projectQuery}`,
    {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved", note: "loom smoke deployment approved", clientId: "loom-smoke-deploy" }),
    },
    [200],
    "POST smoke deployment gate",
  );
  const gateRunFinalStatus = stringFieldFromResponse(deploymentResponse.body, "status", "smoke deployed gated run");
  if (gateRunFinalStatus !== "passed") throw new Error(`smoke deployed gated run finished with status ${gateRunFinalStatus}`);
  const deployment = recordFieldFromResponse(deploymentResponse.body, "deployment", "smoke deployed gated run");
  const deploymentDecision = stringFieldFromResponse(deployment, "status", "smoke deployed gated run deployment");
  if (deploymentDecision !== "approved") throw new Error("smoke deployment gate was not approved");

  const eventsResponse = await smokeJson(`${gateRunUrl}/events?${projectQuery}`, { headers: developerHeaders }, [200], "GET smoke gated run events");
  if (!Array.isArray(eventsResponse.body)) throw new Error("smoke gated run events response was not an array");
  const reviewEvent = eventsResponse.body.find((event) =>
    isRecord(event) &&
    event.type === "review_gate" &&
    isRecord(event.data) &&
    event.data.status === "approved"
  );
  const deploymentEvent = eventsResponse.body.find((event) =>
    isRecord(event) &&
    event.type === "deployment_gate" &&
    isRecord(event.data) &&
    event.data.status === "approved"
  );
  if (!isRecord(reviewEvent) || !isRecord(reviewEvent.data) || reviewEvent.data.role !== "developer") {
    throw new Error("smoke gated run events did not include the developer review decision");
  }
  if (!isRecord(deploymentEvent) || !isRecord(deploymentEvent.data) || deploymentEvent.data.role !== "admin") {
    throw new Error("smoke gated run events did not include the admin deployment decision");
  }

  return {
    gatesChecked: true,
    gateRunId,
    reviewGateChecked: true,
    reviewGateRunStatus: "review_required",
    reviewGateDecision: "approved",
    reviewGateDecidedRole: "developer",
    reviewGateMetricsChecked: reviewGateMetrics ? true : undefined,
    reviewGateMetricsReviewRequiredRuns: reviewGateMetrics?.metricsReviewRequiredRuns,
    deploymentGateChecked: true,
    deploymentGateDeveloperDenied: true,
    deploymentGateRunStatus: "deployment_required",
    deploymentGateDecision: "approved",
    deploymentGateDecidedRole: "admin",
    deploymentGateMetricsChecked: deploymentGateMetrics ? true : undefined,
    deploymentGateMetricsDeploymentRequiredRuns: deploymentGateMetrics?.metricsDeploymentRequiredRuns,
    gateRunFinalStatus: "passed",
  };
}

export async function verifySmokePolicyEscalation(
  url: string,
  developerHeaders: Record<string, string>,
  options: HarnessSmokeCliOptions,
  tenant: string,
  project: string,
): Promise<HarnessSmokePolicyEscalationResult> {
  const adminToken = smokeAdminToken(options);
  if (!adminToken) throw new Error("--check-escalations requires --admin-token or --admin-token-env");
  const adminHeaders = smokeHeaders(adminToken);
  const requestedTool = "shell.exec";
  const workspaceByteWarning = 12_345_678;
  const escalationResponse = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/policy/escalations`,
    {
      method: "POST",
      headers: { ...developerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        requestedTools: [requestedTool],
        limits: { workspaceByteWarning },
        source: {
          kind: "workspace_pr",
          project,
          detail: "loom smoke validates admin-approved policy escalation",
        },
        reason: "loom smoke needs a temporary shell permission path",
        clientId: "loom-smoke-escalation",
      }),
    },
    [201],
    "POST smoke policy escalation",
  );
  const policyEscalationId = stringFieldFromResponse(escalationResponse.body, "id", "smoke policy escalation");
  const escalationStatus = stringFieldFromResponse(escalationResponse.body, "status", "smoke policy escalation");
  if (escalationStatus !== "pending") throw new Error(`smoke policy escalation status was ${JSON.stringify(escalationStatus)}`);
  const requestedTools = arrayFieldFromResponse(escalationResponse.body, "requestedTools", "smoke policy escalation");
  if (!requestedTools.includes(requestedTool)) throw new Error("smoke policy escalation did not request shell.exec");
  const source = recordFieldFromResponse(escalationResponse.body, "source", "smoke policy escalation");
  const sourceKind = stringFieldFromResponse(source, "kind", "smoke policy escalation source");
  if (sourceKind !== "workspace_pr") throw new Error(`smoke policy escalation source was ${JSON.stringify(sourceKind)}`);

  const listedResponse = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/policy/escalations`,
    { headers: developerHeaders },
    [200],
    "GET smoke policy escalations",
  );
  if (!Array.isArray(listedResponse.body) || !listedResponse.body.some((item) => isRecord(item) && item.id === policyEscalationId)) {
    throw new Error("smoke policy escalation list did not include the requested escalation");
  }

  await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/policy/escalations/${encodeURIComponent(policyEscalationId)}/decision`,
    {
      method: "POST",
      headers: { ...developerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved", note: "developer cannot approve escalation", clientId: "loom-smoke-dev-escalation" }),
    },
    [403],
    "POST smoke developer escalation decision denial",
  );

  const decisionResponse = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/policy/escalations/${encodeURIComponent(policyEscalationId)}/decision`,
    {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved", note: "loom smoke approved escalation", clientId: "loom-smoke-admin-escalation" }),
    },
    [200],
    "POST smoke admin escalation decision",
  );
  const policyEscalationStatus = stringFieldFromResponse(decisionResponse.body, "status", "smoke admin escalation decision");
  if (policyEscalationStatus !== "approved") throw new Error(`smoke admin escalation status was ${JSON.stringify(policyEscalationStatus)}`);
  const policyEscalationDecidedRole = stringFieldFromResponse(decisionResponse.body, "decidedRole", "smoke admin escalation decision");
  if (policyEscalationDecidedRole !== "admin") throw new Error(`smoke admin escalation decidedRole was ${JSON.stringify(policyEscalationDecidedRole)}`);
  const policyChange = recordFieldFromResponse(decisionResponse.body, "policyChange", "smoke admin escalation decision");
  const allowedToolsChange = recordFieldFromResponse(policyChange, "allowedTools", "smoke admin escalation policy change");
  const addedTools = arrayFieldFromResponse(allowedToolsChange, "added", "smoke admin escalation allowedTools change");
  if (!addedTools.includes(requestedTool)) throw new Error("smoke admin escalation did not add shell.exec");
  const limitsChange = recordFieldFromResponse(policyChange, "limits", "smoke admin escalation policy change");
  const changedLimits = arrayFieldFromResponse(limitsChange, "changed", "smoke admin escalation limits change");
  if (!changedLimits.includes("workspaceByteWarning")) throw new Error("smoke admin escalation did not change workspaceByteWarning");

  const policyResponse = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/policy`,
    { headers: developerHeaders },
    [200],
    "GET smoke policy after escalation",
  );
  const policyAllowedTools = arrayFieldFromResponse(policyResponse.body, "allowedTools", "smoke policy after escalation");
  if (!policyAllowedTools.includes(requestedTool)) throw new Error("smoke policy did not include shell.exec after escalation");
  const policyLimits = recordFieldFromResponse(policyResponse.body, "limits", "smoke policy after escalation");
  const policyWorkspaceByteWarning = numberFieldFromResponse(policyLimits, "workspaceByteWarning", "smoke policy limits after escalation");
  if (policyWorkspaceByteWarning !== workspaceByteWarning) {
    throw new Error(`smoke policy workspaceByteWarning was ${policyWorkspaceByteWarning}`);
  }

  const auditResponse = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/audit`,
    { headers: developerHeaders },
    [200],
    "GET smoke audit after escalation",
  );
  if (!Array.isArray(auditResponse.body)) throw new Error("smoke audit response was not an array");
  const requested = auditResponse.body.some((event) =>
    isRecord(event) &&
    event.type === "tenant_policy_escalation_requested" &&
    isRecord(event.data) &&
    event.data.escalationId === policyEscalationId &&
    event.data.clientId === "loom-smoke-escalation"
  );
  const decided = auditResponse.body.some((event) =>
    isRecord(event) &&
    event.type === "tenant_policy_escalation_decided" &&
    isRecord(event.data) &&
    event.data.escalationId === policyEscalationId &&
    event.data.decision === "approved" &&
    event.data.clientId === "loom-smoke-admin-escalation"
  );
  const updated = auditResponse.body.some((event) =>
    isRecord(event) &&
    event.type === "tenant_policy_updated" &&
    isRecord(event.data) &&
    event.data.escalationId === policyEscalationId
  );
  if (!requested || !decided || !updated) throw new Error("smoke audit did not include the full policy escalation trail");

  return {
    policyEscalationChecked: true,
    policyEscalationId,
    policyEscalationStatus: "approved",
    policyEscalationRequestedTool: "shell.exec",
    policyEscalationSourceKind: "workspace_pr",
    policyEscalationDeveloperDecisionDenied: true,
    policyEscalationDecidedRole: "admin",
    policyEscalationToolAdded: true,
    policyEscalationLimitChanged: true,
    policyEscalationAuditChecked: true,
  };
}

export async function verifySmokeTenantIsolation(
  url: string,
  headers: Record<string, string>,
  isolationTenant: string,
): Promise<true> {
  const response = await smokeJson(
    `${url}/tenants/${encodeURIComponent(isolationTenant)}/status`,
    { headers },
    [401, 403],
    "GET isolation tenant status",
  );
  if (response.status === 401 || response.status === 403) return true;
  throw new Error(`isolation tenant ${isolationTenant} was readable with the smoke token`);
}

export function verifySmokeOnlineSandboxGoldenPath(
  profile: HarnessSmokeProfileName,
  checks: Record<string, boolean>,
  extraCapabilities: string[] = [],
): HarnessSmokeOnlineSandboxGoldenPathResult {
  const requiredCapabilities = [...SMOKE_ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES, ...extraCapabilities];
  const missingCapabilities = requiredCapabilities.filter((capability) => !checks[capability]);
  if (missingCapabilities.length) {
    throw smokeCheckError(
      "SMOKE_ONLINE_SANDBOX_GOLDEN_PATH_MISSING",
      `smoke profile ${profile} did not complete the online sandbox golden path`,
      {
        profile,
        missingCapabilities,
        requiredCapabilities,
      },
    );
  }
  return {
    onlineSandboxGoldenPathChecked: true,
    onlineSandboxGoldenPathProfile: profile,
    onlineSandboxGoldenPathCapabilities: requiredCapabilities,
  };
}

export async function verifySmokeServerProfile(
  url: string,
  profile: HarnessSmokeProfileName,
  headers: Record<string, string>,
): Promise<{
  profile: HarnessSmokeProfileName;
  allowedTools: string[];
  readinessOk: boolean;
  readinessMissing: string[];
  goldenPathOk: boolean;
  goldenPathCapabilities: string[];
  goldenPathMissingCapabilities: string[];
  runWorkspaceIsolation: string;
  controlPlaneProvider: string;
  controlPlaneBoundary: string[];
  controlPlaneApiBasePath?: string;
  controlPlaneDiscoveryEndpoints: string[];
  controlPlaneNativeCapabilities: string[];
  controlPlaneAdoptionStages: string[];
  controlPlaneGatedAdoptionStages: string[];
  controlPlaneTenantDefaultCutoverGated: boolean;
  concurrencyAdmissionChecked: true;
  concurrencyAdmissionSchemaVersion: string;
  concurrencyAdmissionRunWorkspaceIsolation: string;
  concurrencyAdmissionActiveRunClaimScope: string;
  concurrencyAdmissionQueueBlockedReasons: string[];
  concurrencyAdmissionRunControlCrossServer: boolean;
  controlPlaneDiscoveryChecked?: true;
  controlPlaneDiscoveryProvider?: string;
  controlPlaneDiscoveryOk?: boolean;
  controlPlaneDiscoveryBaseUrlConfigured?: boolean;
  controlPlaneDiscoveryEndpointCount?: number;
  controlPlaneDiscoveryOkEndpointCount?: number;
  controlPlaneDiscoveryMissingEndpoints?: string[];
  controlPlaneDiscoveryTokenMode?: string;
  controlPlaneDiscoveryTenantCount?: number;
  controlPlaneDiscoveryTenantOkCount?: number;
  controlPlaneDiscoveryMissingTenants?: string[];
  controlPlaneWorkspaceBranchLeaseChecked?: true;
  controlPlaneWorkspaceBranchLeaseProvider?: string;
  controlPlaneWorkspaceBranchLeaseIsolation?: string;
  controlPlaneWorkspaceBranchLeaseBranchDerivation?: string;
  controlPlaneWorkspaceBranchLeaseActiveRunLeaseEvidence?: boolean;
  agentGitServiceProjectAgentsChecked?: true;
  agentGitServiceProjectAgentsProvider?: string;
  agentGitServiceProjectAgentsOk?: boolean;
  agentGitServiceProjectAgentsTenantCount?: number;
  agentGitServiceProjectAgentsProjectCount?: number;
  agentGitServiceProjectAgentsProvisionedProjectCount?: number;
  agentGitServiceProjectAgentsSecretRootConfigured?: boolean;
  agentGitServiceProjectAgentsSecretStoredProjectCount?: number;
  agentGitServiceProjectAgentsMissingProjects?: string[];
  agentGitServiceProjectAgentsMissingSecretProjects?: string[];
  visionLockTarget: string;
  visionLockMvpIsScopeReduction: boolean;
  visionLockCapabilities: string[];
}> {
  const response = await smokeJson(`${url}/status`, { headers }, [200], "GET server status");
  const server = recordFieldFromResponse(response.body, "server", "server status");
  const actual = typeof server.profile === "string" ? server.profile : undefined;
  if (actual !== profile) {
    throw smokeCheckError(
      "SMOKE_SERVER_PROFILE_MISMATCH",
      `server profile ${actual ?? "<unset>"} does not match requested smoke profile ${profile}`,
      { scope: "server", expectedProfile: profile, actualProfile: actual ?? null },
    );
  }
  const policy = recordFieldFromResponse(response.body, "policy", "server status");
  const allowedTools = requireSmokeStringArray(
    arrayFieldFromResponse(policy, "allowedTools", "server status policy"),
    "server status policy allowedTools must be strings",
    "SMOKE_SERVER_TOOLS_INVALID",
    { scope: "server", profile, field: "policy.allowedTools" },
  );
  requireOnlineSandboxTools(`server profile ${profile}`, allowedTools, "SMOKE_SERVER_TOOLS_MISSING", {
    scope: "server",
    profile,
  });
  const readiness = recordFieldFromResponse(response.body, "readiness", "server status");
  const readinessProfile = typeof readiness.profile === "string" ? readiness.profile : undefined;
  if (readinessProfile !== profile) {
    throw smokeCheckError(
      "SMOKE_SERVER_READINESS_PROFILE_MISMATCH",
      `server readiness profile ${readinessProfile ?? "<unset>"} does not match requested smoke profile ${profile}`,
      { scope: "server", expectedProfile: profile, actualProfile: readinessProfile ?? null },
    );
  }
  const readinessOk = booleanFieldFromResponse(readiness, "ok", "server status readiness");
  const readinessMissing = requireSmokeStringArray(
    arrayFieldFromResponse(readiness, "missing", "server status readiness"),
    "server status readiness missing must be strings",
    "SMOKE_SERVER_READINESS_INVALID",
    { scope: "server", profile, field: "readiness.missing" },
  );
  const agentGitServiceProjectAgents = smokeAgentGitServiceProjectAgentsStatus(readiness);
  const controlPlaneDiscovery = smokeControlPlaneDiscoveryStatus(readiness, "server", profile);
  if (!readinessOk) {
    throw smokeCheckError(
      "SMOKE_SERVER_READINESS_MISSING",
      `server profile ${profile} missing readiness: ${readinessMissing.join(", ")}`,
      { scope: "server", profile, missing: readinessMissing, ...(agentGitServiceProjectAgents ?? {}), ...(controlPlaneDiscovery ?? {}) },
    );
  }
  const goldenPath = verifySmokeStatusGoldenPath("server", profile, readiness);
  const controlPlane = verifySmokeControlPlaneStatus(profile, server);
  const controlPlaneAdoptionStages = controlPlane.adoptionStages.map((stage) => stage.name);
  const controlPlaneGatedAdoptionStages = controlPlane.adoptionStages
    .filter((stage) => stage.state === "gated")
    .map((stage) => stage.name);
  const runWorkspaceIsolation = runWorkspaceIsolationFieldFromResponse(
    server,
    "server",
    profile,
    "server status",
  );
  const concurrencyAdmission = smokeConcurrencyAdmissionStatus(
    server,
    "server",
    profile,
    runWorkspaceIsolation,
  );
  if (profile === "platform-readiness" && runWorkspaceIsolation !== "run") {
    throw smokeCheckError(
      "SMOKE_SERVER_RUN_WORKSPACE_ISOLATION_REQUIRED",
      `server profile ${profile} requires run workspace isolation`,
      { scope: "server", profile, expected: "run", actual: runWorkspaceIsolation },
    );
  }
  const workspaceBranchLease = profile === "platform-readiness"
    ? verifySmokeControlPlaneWorkspaceBranchLeaseStatus(profile, readiness)
    : undefined;
  const visionLock = recordFieldFromResponse(response.body, "visionLock", "server status");
  const visionLockTarget = stringFieldFromResponse(visionLock, "target", "server status visionLock");
  const missingTargetMarkers = SMOKE_REQUIRED_VISION_LOCK_TARGET_MARKERS.filter((marker) => !visionLockTarget.includes(marker));
  if (missingTargetMarkers.length) {
    throw smokeCheckError(
      "SMOKE_VISION_LOCK_TARGET_MISMATCH",
      `server profile ${profile} reported an unexpected vision lock target`,
      {
        scope: "server",
        profile,
        actualTarget: visionLockTarget,
        missingTargetMarkers,
        requiredTargetMarkers: SMOKE_REQUIRED_VISION_LOCK_TARGET_MARKERS,
      },
    );
  }
  const visionLockMvpIsScopeReduction = booleanFieldFromResponse(visionLock, "mvpIsScopeReduction", "server status visionLock");
  if (visionLockMvpIsScopeReduction !== false) {
    throw smokeCheckError(
      "SMOKE_VISION_LOCK_SCOPE_REDUCTION",
      `server profile ${profile} reported MVP as a scope reduction`,
      {
        scope: "server",
        profile,
        mvpIsScopeReduction: visionLockMvpIsScopeReduction,
      },
    );
  }
  const visionLockCapabilities = arrayFieldFromResponse(visionLock, "capabilities", "server status visionLock");
  const visionLockCapabilityNames = requireSmokeStringArray(
    visionLockCapabilities,
    "server status visionLock capabilities must be strings",
    "SMOKE_VISION_LOCK_CAPABILITIES_INVALID",
    { scope: "server", profile, field: "visionLock.capabilities" },
  );
  const missingVisionCapabilities = SMOKE_REQUIRED_VISION_LOCK_CAPABILITIES.filter((capability) => !visionLockCapabilityNames.includes(capability));
  if (missingVisionCapabilities.length) {
    throw smokeCheckError(
      "SMOKE_VISION_LOCK_CAPABILITIES_MISSING",
      `server profile ${profile} missing vision lock capabilities: ${missingVisionCapabilities.join(", ")}`,
      {
        scope: "server",
        profile,
        missingCapabilities: missingVisionCapabilities,
        requiredCapabilities: SMOKE_REQUIRED_VISION_LOCK_CAPABILITIES,
      },
    );
  }
  return {
    profile,
    allowedTools,
    readinessOk,
    readinessMissing,
    goldenPathOk: goldenPath.ok,
    goldenPathCapabilities: goldenPath.capabilities,
    goldenPathMissingCapabilities: goldenPath.missingCapabilities,
    runWorkspaceIsolation,
    controlPlaneProvider: controlPlane.provider,
    controlPlaneBoundary: controlPlane.boundary,
    controlPlaneApiBasePath: controlPlane.apiBasePath,
    controlPlaneDiscoveryEndpoints: controlPlane.discoveryEndpoints,
    controlPlaneNativeCapabilities: controlPlane.nativeCapabilities,
    controlPlaneAdoptionStages,
    controlPlaneGatedAdoptionStages,
    controlPlaneTenantDefaultCutoverGated: controlPlane.adoptionStages.some((stage) =>
      stage.name === "tenant-default-cutover" && stage.state === "gated"
    ),
    ...concurrencyAdmission,
    ...(controlPlaneDiscovery ?? {}),
    controlPlaneWorkspaceBranchLeaseChecked: workspaceBranchLease ? true : undefined,
    controlPlaneWorkspaceBranchLeaseProvider: workspaceBranchLease?.provider,
    controlPlaneWorkspaceBranchLeaseIsolation: workspaceBranchLease?.runWorkspaceIsolation,
    controlPlaneWorkspaceBranchLeaseBranchDerivation: workspaceBranchLease?.branchDerivation,
    controlPlaneWorkspaceBranchLeaseActiveRunLeaseEvidence: workspaceBranchLease?.activeRunLeaseEvidence,
    ...(agentGitServiceProjectAgents ?? {}),
    visionLockTarget,
    visionLockMvpIsScopeReduction,
    visionLockCapabilities: visionLockCapabilityNames,
  };
}

export async function verifySmokeTenantProfileTools(
  url: string,
  tenant: string,
  profile: HarnessSmokeProfileName,
  headers: Record<string, string>,
): Promise<{
  allowedTools: string[];
  readinessProfile: HarnessSmokeProfileName;
  readinessOk: boolean;
  readinessMissing: string[];
  goldenPathOk: boolean;
  goldenPathCapabilities: string[];
  goldenPathMissingCapabilities: string[];
  runWorkspaceIsolation?: string;
  controlPlaneProvider: string;
  controlPlaneBoundary: string[];
  controlPlaneAdoptionStages: string[];
  controlPlaneGatedAdoptionStages: string[];
  controlPlaneTenantDefaultCutoverGated: boolean;
  concurrencyAdmissionChecked: true;
  concurrencyAdmissionSchemaVersion: string;
  concurrencyAdmissionRunWorkspaceIsolation: string;
  concurrencyAdmissionActiveRunClaimScope: string;
  concurrencyAdmissionQueueBlockedReasons: string[];
  concurrencyAdmissionRunControlCrossServer: boolean;
  controlPlaneDiscoveryChecked?: true;
  controlPlaneDiscoveryProvider?: string;
  controlPlaneDiscoveryOk?: boolean;
  controlPlaneDiscoveryBaseUrlConfigured?: boolean;
  controlPlaneDiscoveryEndpointCount?: number;
  controlPlaneDiscoveryOkEndpointCount?: number;
  controlPlaneDiscoveryMissingEndpoints?: string[];
  controlPlaneDiscoveryTokenMode?: string;
  controlPlaneDiscoveryTenantCount?: number;
  controlPlaneDiscoveryTenantOkCount?: number;
  controlPlaneDiscoveryMissingTenants?: string[];
  visionLockTarget: string;
  visionLockMvpIsScopeReduction: boolean;
  visionLockCapabilities: string[];
}> {
  const response = await smokeJson(`${url}/tenants/${encodeURIComponent(tenant)}/status`, { headers }, [200], "GET tenant status");
  const policy = recordFieldFromResponse(response.body, "policy", "tenant status");
  const allowedTools = requireSmokeStringArray(
    arrayFieldFromResponse(policy, "allowedTools", "tenant status policy"),
    "tenant status policy allowedTools must be strings",
    "SMOKE_TENANT_TOOLS_INVALID",
    { scope: "tenant", tenant, profile, field: "policy.allowedTools" },
  );
  requireOnlineSandboxTools(`tenant ${tenant} profile ${profile}`, allowedTools, "SMOKE_TENANT_TOOLS_MISSING", {
    scope: "tenant",
    tenant,
    profile,
  });
  if (!isRecord(response.body) || !isRecord(response.body.readiness)) {
    throw smokeCheckError(
      "SMOKE_TENANT_READINESS_MISSING",
      "tenant status did not include readiness",
      { scope: "tenant", tenant, profile, missing: ["readiness"] },
    );
  }
  const readiness = response.body.readiness;
  const readinessProfile = typeof readiness.profile === "string" ? readiness.profile : undefined;
  if (readinessProfile !== profile) {
    throw smokeCheckError(
      "SMOKE_TENANT_READINESS_PROFILE_MISMATCH",
      `tenant ${tenant} readiness profile ${readinessProfile ?? "<unset>"} does not match requested smoke profile ${profile}`,
      { scope: "tenant", tenant, expectedProfile: profile, actualProfile: readinessProfile ?? null },
    );
  }
  const readinessOk = booleanFieldFromResponse(readiness, "ok", "tenant status readiness");
  const readinessMissing = requireSmokeStringArray(
    arrayFieldFromResponse(readiness, "missing", "tenant status readiness"),
    "tenant status readiness missing must be strings",
    "SMOKE_TENANT_READINESS_INVALID",
    { scope: "tenant", tenant, profile, field: "readiness.missing" },
  );
  const controlPlaneDiscovery = smokeControlPlaneDiscoveryStatus(readiness, "tenant", profile, tenant);
  if (!readinessOk) {
    throw smokeCheckError(
      "SMOKE_TENANT_READINESS_MISSING",
      `tenant ${tenant} profile ${profile} missing readiness: ${readinessMissing.join(", ")}`,
      { scope: "tenant", tenant, profile, missing: readinessMissing, ...(controlPlaneDiscovery ?? {}) },
    );
  }
  const goldenPath = verifySmokeStatusGoldenPath("tenant", profile, readiness, tenant);
  const tenantServer = isRecord(response.body.server) ? response.body.server : undefined;
  if (!tenantServer) {
    throw smokeCheckError(
      "SMOKE_TENANT_SERVER_MISSING",
      "tenant status did not include server metadata",
      { scope: "tenant", tenant, profile, missing: ["server"] },
    );
  }
  const controlPlane = verifySmokeControlPlaneStatus(profile, tenantServer, "tenant", tenant);
  const controlPlaneAdoptionStages = controlPlane.adoptionStages.map((stage) => stage.name);
  const controlPlaneGatedAdoptionStages = controlPlane.adoptionStages
    .filter((stage) => stage.state === "gated")
    .map((stage) => stage.name);
  const runWorkspaceIsolation = tenantServer
    ? runWorkspaceIsolationFieldFromResponse(
      tenantServer,
      "tenant",
      profile,
      "tenant status",
      tenant,
    )
    : undefined;
  const concurrencyAdmission = smokeConcurrencyAdmissionStatus(
    tenantServer,
    "tenant",
    profile,
    runWorkspaceIsolation,
    tenant,
  );
  if (profile === "platform-readiness" && runWorkspaceIsolation !== "run") {
    throw smokeCheckError(
      "SMOKE_TENANT_RUN_WORKSPACE_ISOLATION_REQUIRED",
      `tenant ${tenant} profile ${profile} requires run workspace isolation`,
      { scope: "tenant", tenant, profile, expected: "run", actual: runWorkspaceIsolation ?? null },
    );
  }
  if (!isRecord(response.body) || !isRecord(response.body.visionLock)) {
    throw smokeCheckError(
      "SMOKE_TENANT_VISION_LOCK_MISSING",
      "tenant status did not include visionLock",
      { scope: "tenant", tenant, profile, missing: ["visionLock"] },
    );
  }
  const visionLock = response.body.visionLock;
  const visionLockTarget = stringFieldFromResponse(visionLock, "target", "tenant status visionLock");
  const missingTargetMarkers = SMOKE_REQUIRED_VISION_LOCK_TARGET_MARKERS.filter((marker) => !visionLockTarget.includes(marker));
  if (missingTargetMarkers.length) {
    throw smokeCheckError(
      "SMOKE_TENANT_VISION_LOCK_TARGET_MISMATCH",
      `tenant ${tenant} profile ${profile} reported an unexpected vision lock target`,
      {
        scope: "tenant",
        tenant,
        profile,
        actualTarget: visionLockTarget,
        missingTargetMarkers,
        requiredTargetMarkers: SMOKE_REQUIRED_VISION_LOCK_TARGET_MARKERS,
      },
    );
  }
  const visionLockMvpIsScopeReduction = booleanFieldFromResponse(visionLock, "mvpIsScopeReduction", "tenant status visionLock");
  if (visionLockMvpIsScopeReduction !== false) {
    throw smokeCheckError(
      "SMOKE_TENANT_VISION_LOCK_SCOPE_REDUCTION",
      `tenant ${tenant} profile ${profile} reported MVP as a scope reduction`,
      {
        scope: "tenant",
        tenant,
        profile,
        mvpIsScopeReduction: visionLockMvpIsScopeReduction,
      },
    );
  }
  const visionLockCapabilityNames = requireSmokeStringArray(
    arrayFieldFromResponse(visionLock, "capabilities", "tenant status visionLock"),
    "tenant status visionLock capabilities must be strings",
    "SMOKE_TENANT_VISION_LOCK_CAPABILITIES_INVALID",
    { scope: "tenant", tenant, profile, field: "visionLock.capabilities" },
  );
  const missingVisionCapabilities = SMOKE_REQUIRED_VISION_LOCK_CAPABILITIES.filter((capability) => !visionLockCapabilityNames.includes(capability));
  if (missingVisionCapabilities.length) {
    throw smokeCheckError(
      "SMOKE_TENANT_VISION_LOCK_CAPABILITIES_MISSING",
      `tenant ${tenant} profile ${profile} missing vision lock capabilities: ${missingVisionCapabilities.join(", ")}`,
      {
        scope: "tenant",
        tenant,
        profile,
        missingCapabilities: missingVisionCapabilities,
        requiredCapabilities: SMOKE_REQUIRED_VISION_LOCK_CAPABILITIES,
      },
    );
  }
  return {
    allowedTools,
    readinessProfile,
    readinessOk,
    readinessMissing,
    goldenPathOk: goldenPath.ok,
    goldenPathCapabilities: goldenPath.capabilities,
    goldenPathMissingCapabilities: goldenPath.missingCapabilities,
    runWorkspaceIsolation,
    controlPlaneProvider: controlPlane.provider,
    controlPlaneBoundary: controlPlane.boundary,
    controlPlaneAdoptionStages,
    controlPlaneGatedAdoptionStages,
    controlPlaneTenantDefaultCutoverGated: controlPlane.adoptionStages.some((stage) =>
      stage.name === "tenant-default-cutover" && stage.state === "gated"
    ),
    ...concurrencyAdmission,
    ...(controlPlaneDiscovery ?? {}),
    visionLockTarget,
    visionLockMvpIsScopeReduction,
    visionLockCapabilities: visionLockCapabilityNames,
  };
}

export function smokeConcurrencyAdmissionStatus(
  server: Record<string, unknown>,
  scope: "server" | "tenant",
  profile: string | undefined,
  expectedRunWorkspaceIsolation: string | undefined,
  tenant?: string,
): {
  concurrencyAdmissionChecked: true;
  concurrencyAdmissionSchemaVersion: string;
  concurrencyAdmissionRunWorkspaceIsolation: string;
  concurrencyAdmissionActiveRunClaimScope: string;
  concurrencyAdmissionQueueBlockedReasons: string[];
  concurrencyAdmissionRunControlCrossServer: boolean;
} {
  const label = scope === "tenant" ? `tenant ${tenant} status` : "server status";
  const details = tenant ? { scope, tenant, profile } : { scope, profile };
  const admission = recordFieldFromResponse(server, "concurrencyAdmission", label);
  const schemaVersion = stringFieldFromResponse(admission, "schemaVersion", `${label} concurrencyAdmission`);
  if (schemaVersion !== SMOKE_CONCURRENCY_ADMISSION_SCHEMA_VERSION) {
    throw smokeCheckError(
      scope === "tenant" ? "SMOKE_TENANT_CONCURRENCY_ADMISSION_SCHEMA_MISMATCH" : "SMOKE_SERVER_CONCURRENCY_ADMISSION_SCHEMA_MISMATCH",
      `${label} reported an unexpected concurrencyAdmission schemaVersion`,
      { ...details, expected: SMOKE_CONCURRENCY_ADMISSION_SCHEMA_VERSION, actual: schemaVersion },
    );
  }
  const runWorkspaceIsolation = stringFieldFromResponse(admission, "runWorkspaceIsolation", `${label} concurrencyAdmission`);
  if (runWorkspaceIsolation !== "project" && runWorkspaceIsolation !== "run") {
    throw smokeCheckError(
      scope === "tenant" ? "SMOKE_TENANT_CONCURRENCY_ADMISSION_ISOLATION_INVALID" : "SMOKE_SERVER_CONCURRENCY_ADMISSION_ISOLATION_INVALID",
      `${label} reported an invalid concurrencyAdmission runWorkspaceIsolation`,
      { ...details, actual: runWorkspaceIsolation },
    );
  }
  if (expectedRunWorkspaceIsolation !== undefined && runWorkspaceIsolation !== expectedRunWorkspaceIsolation) {
    throw smokeCheckError(
      scope === "tenant" ? "SMOKE_TENANT_CONCURRENCY_ADMISSION_ISOLATION_MISMATCH" : "SMOKE_SERVER_CONCURRENCY_ADMISSION_ISOLATION_MISMATCH",
      `${label} concurrencyAdmission runWorkspaceIsolation did not match server.runWorkspaceIsolation`,
      { ...details, expected: expectedRunWorkspaceIsolation, actual: runWorkspaceIsolation },
    );
  }
  const activeRun = recordFieldFromResponse(admission, "activeRun", `${label} concurrencyAdmission`);
  const activeRunClaimScope = stringFieldFromResponse(activeRun, "claimScope", `${label} concurrencyAdmission activeRun`);
  if (activeRunClaimScope !== runWorkspaceIsolation) {
    throw smokeCheckError(
      scope === "tenant" ? "SMOKE_TENANT_CONCURRENCY_ADMISSION_CLAIM_SCOPE_MISMATCH" : "SMOKE_SERVER_CONCURRENCY_ADMISSION_CLAIM_SCOPE_MISMATCH",
      `${label} concurrencyAdmission activeRun claimScope did not match runWorkspaceIsolation`,
      { ...details, expected: runWorkspaceIsolation, actual: activeRunClaimScope },
    );
  }
  const queueing = recordFieldFromResponse(admission, "queueing", `${label} concurrencyAdmission`);
  const blockedReasons = requireSmokeStringArray(
    arrayFieldFromResponse(queueing, "blockedReasons", `${label} concurrencyAdmission queueing`),
    `${label} concurrencyAdmission queueing blockedReasons must be strings`,
    scope === "tenant" ? "SMOKE_TENANT_CONCURRENCY_ADMISSION_BLOCKERS_INVALID" : "SMOKE_SERVER_CONCURRENCY_ADMISSION_BLOCKERS_INVALID",
    { ...details, field: "server.concurrencyAdmission.queueing.blockedReasons" },
  );
  const missingBlockedReasons = SMOKE_CONCURRENCY_ADMISSION_BLOCKED_REASONS.filter((reason) => !blockedReasons.includes(reason));
  if (missingBlockedReasons.length) {
    throw smokeCheckError(
      scope === "tenant" ? "SMOKE_TENANT_CONCURRENCY_ADMISSION_BLOCKERS_MISSING" : "SMOKE_SERVER_CONCURRENCY_ADMISSION_BLOCKERS_MISSING",
      `${label} concurrencyAdmission missing queued-run blockers: ${missingBlockedReasons.join(", ")}`,
      { ...details, missingBlockedReasons, blockedReasons },
    );
  }
  const runControl = recordFieldFromResponse(admission, "runControl", `${label} concurrencyAdmission`);
  const runControlCrossServer = booleanFieldFromResponse(runControl, "crossServer", `${label} concurrencyAdmission runControl`);
  if (!runControlCrossServer) {
    throw smokeCheckError(
      scope === "tenant" ? "SMOKE_TENANT_CONCURRENCY_ADMISSION_RUN_CONTROL_NOT_CROSS_SERVER" : "SMOKE_SERVER_CONCURRENCY_ADMISSION_RUN_CONTROL_NOT_CROSS_SERVER",
      `${label} concurrencyAdmission runControl must be cross-server`,
      { ...details },
    );
  }
  return {
    concurrencyAdmissionChecked: true,
    concurrencyAdmissionSchemaVersion: schemaVersion,
    concurrencyAdmissionRunWorkspaceIsolation: runWorkspaceIsolation,
    concurrencyAdmissionActiveRunClaimScope: activeRunClaimScope,
    concurrencyAdmissionQueueBlockedReasons: blockedReasons,
    concurrencyAdmissionRunControlCrossServer: runControlCrossServer,
  };
}

export function verifySmokeStatusGoldenPath(
  scope: "server" | "tenant" | "auth-roles",
  profile: string | undefined,
  readiness: Record<string, unknown>,
  tenant?: string,
): { ok: boolean; capabilities: string[]; missingCapabilities: string[] } {
  const detailsBase = scope === "auth-roles"
    ? { scope, tenant, profile: profile ?? null }
    : tenant
      ? { scope, tenant, profile }
      : { scope, profile };
  const codePrefix = scope === "server"
    ? "SMOKE_SERVER_GOLDEN_PATH"
    : scope === "tenant"
      ? "SMOKE_TENANT_GOLDEN_PATH"
      : "SMOKE_AUTH_VIEWER_GOLDEN_PATH";
  const label = scope === "auth-roles"
    ? "smoke viewer tenant status"
    : tenant
      ? `tenant ${tenant} profile ${profile}`
      : `server profile ${profile}`;
  if (!isRecord(readiness.goldenPath)) {
    throw smokeCheckError(
      `${codePrefix}_MISSING`,
      `${label} did not report readiness golden path`,
      { ...detailsBase, missing: ["readiness.goldenPath"] },
    );
  }
  const goldenPath = readiness.goldenPath;
  const required = booleanFieldFromResponse(goldenPath, "required", "readiness goldenPath");
  const ok = booleanFieldFromResponse(goldenPath, "ok", "readiness goldenPath");
  const capabilities = requireSmokeStringArray(
    arrayFieldFromResponse(goldenPath, "capabilities", "readiness goldenPath"),
    "readiness goldenPath capabilities must be strings",
    `${codePrefix}_INVALID`,
    { ...detailsBase, field: "readiness.goldenPath.capabilities" },
  );
  const reportedMissingCapabilities = requireSmokeStringArray(
    arrayFieldFromResponse(goldenPath, "missingCapabilities", "readiness goldenPath"),
    "readiness goldenPath missingCapabilities must be strings",
    `${codePrefix}_INVALID`,
    { ...detailsBase, field: "readiness.goldenPath.missingCapabilities" },
  );
  const missingRequiredCapabilities = SMOKE_ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES.filter(
    (capability) => !capabilities.includes(capability),
  );
  const missingCapabilities = Array.from(new Set([
    ...missingRequiredCapabilities,
    ...reportedMissingCapabilities,
    ...(required ? [] : ["profile-readiness"]),
    ...(ok || missingRequiredCapabilities.length || reportedMissingCapabilities.length ? [] : ["profile-readiness"]),
  ]));
  if (!required || !ok || missingCapabilities.length) {
    throw smokeCheckError(
      `${codePrefix}_MISSING`,
      `${label} missing golden path capabilities: ${missingCapabilities.join(", ") || "profile-readiness"}`,
      {
        ...detailsBase,
        required,
        ok,
        missingCapabilities: missingCapabilities.length ? missingCapabilities : ["profile-readiness"],
        requiredCapabilities: SMOKE_ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES,
      },
    );
  }
  return { ok, capabilities, missingCapabilities };
}

export function verifySmokeControlPlaneWorkspaceBranchLeaseStatus(
  profile: HarnessSmokeProfileName,
  readiness: Record<string, unknown>,
): {
  provider: string;
  runWorkspaceIsolation: string;
  branchDerivation: string;
  activeRunLeaseEvidence: boolean;
} {
  const checks = recordFieldFromResponse(readiness, "checks", "server status readiness");
  const check = recordFieldFromResponse(checks, "controlPlaneWorkspaceBranchLease", "server status readiness checks");
  const required = booleanFieldFromResponse(check, "required", "server status controlPlaneWorkspaceBranchLease");
  const ok = booleanFieldFromResponse(check, "ok", "server status controlPlaneWorkspaceBranchLease");
  const provider = stringFieldFromResponse(check, "provider", "server status controlPlaneWorkspaceBranchLease");
  const runWorkspaceIsolation = stringFieldFromResponse(check, "runWorkspaceIsolation", "server status controlPlaneWorkspaceBranchLease");
  const branchDerivation = stringFieldFromResponse(check, "branchDerivation", "server status controlPlaneWorkspaceBranchLease");
  const activeRunLeaseEvidence = booleanFieldFromResponse(check, "activeRunLeaseEvidence", "server status controlPlaneWorkspaceBranchLease");
  const invalid = [
    required ? undefined : "required",
    ok ? undefined : "ok",
    runWorkspaceIsolation === "run" ? undefined : "runWorkspaceIsolation",
    branchDerivation === "run-suffixed" ? undefined : "branchDerivation",
    activeRunLeaseEvidence ? undefined : "activeRunLeaseEvidence",
  ].filter((field): field is string => Boolean(field));
  if (invalid.length) {
    throw smokeCheckError(
      "SMOKE_CONTROL_PLANE_WORKSPACE_BRANCH_LEASE_MISSING",
      `server profile ${profile} missing control-plane workspace branch lease readiness`,
      {
        scope: "server",
        profile,
        provider,
        invalid,
        runWorkspaceIsolation,
        branchDerivation,
        activeRunLeaseEvidence,
      },
    );
  }
  return { provider, runWorkspaceIsolation, branchDerivation, activeRunLeaseEvidence };
}

export function smokeAgentGitServiceProjectAgentsStatus(readiness: Record<string, unknown>): {
  agentGitServiceProjectAgentsChecked: true;
  agentGitServiceProjectAgentsProvider: string;
  agentGitServiceProjectAgentsOk: boolean;
  agentGitServiceProjectAgentsTenantCount: number;
  agentGitServiceProjectAgentsProjectCount: number;
  agentGitServiceProjectAgentsProvisionedProjectCount: number;
  agentGitServiceProjectAgentsSecretRootConfigured: boolean;
  agentGitServiceProjectAgentsSecretStoredProjectCount: number;
  agentGitServiceProjectAgentsMissingProjects: string[];
  agentGitServiceProjectAgentsMissingSecretProjects: string[];
} | undefined {
  if (!isRecord(readiness.checks) || !isRecord(readiness.checks.agentGitServiceProjectAgents)) return undefined;
  const check = readiness.checks.agentGitServiceProjectAgents;
  return {
    agentGitServiceProjectAgentsChecked: true,
    agentGitServiceProjectAgentsProvider: stringFieldFromResponse(check, "provider", "server status agentGitServiceProjectAgents"),
    agentGitServiceProjectAgentsOk: booleanFieldFromResponse(check, "ok", "server status agentGitServiceProjectAgents"),
    agentGitServiceProjectAgentsTenantCount: numberFieldFromResponse(check, "tenantCount", "server status agentGitServiceProjectAgents"),
    agentGitServiceProjectAgentsProjectCount: numberFieldFromResponse(check, "projectCount", "server status agentGitServiceProjectAgents"),
    agentGitServiceProjectAgentsProvisionedProjectCount: numberFieldFromResponse(check, "provisionedProjectCount", "server status agentGitServiceProjectAgents"),
    agentGitServiceProjectAgentsSecretRootConfigured: booleanFieldFromResponse(check, "secretRootConfigured", "server status agentGitServiceProjectAgents"),
    agentGitServiceProjectAgentsSecretStoredProjectCount: numberFieldFromResponse(check, "secretStoredProjectCount", "server status agentGitServiceProjectAgents"),
    agentGitServiceProjectAgentsMissingProjects: requireSmokeStringArray(
      arrayFieldFromResponse(check, "missingProjects", "server status agentGitServiceProjectAgents"),
      "server status agentGitServiceProjectAgents missingProjects must be strings",
      "SMOKE_AGENT_GIT_SERVICE_PROJECT_AGENTS_INVALID",
      { scope: "server", field: "readiness.checks.agentGitServiceProjectAgents.missingProjects" },
    ),
    agentGitServiceProjectAgentsMissingSecretProjects: requireSmokeStringArray(
      arrayFieldFromResponse(check, "missingSecretProjects", "server status agentGitServiceProjectAgents"),
      "server status agentGitServiceProjectAgents missingSecretProjects must be strings",
      "SMOKE_AGENT_GIT_SERVICE_PROJECT_AGENTS_INVALID",
      { scope: "server", field: "readiness.checks.agentGitServiceProjectAgents.missingSecretProjects" },
    ),
  };
}

export function smokeControlPlaneDiscoveryStatus(
  readiness: Record<string, unknown>,
  scope: "server" | "tenant",
  profile: HarnessSmokeProfileName,
  tenant?: string,
): {
  controlPlaneDiscoveryChecked: true;
  controlPlaneDiscoveryProvider: string;
  controlPlaneDiscoveryOk: boolean;
  controlPlaneDiscoveryBaseUrlConfigured: boolean;
  controlPlaneDiscoveryEndpointCount: number;
  controlPlaneDiscoveryOkEndpointCount: number;
  controlPlaneDiscoveryMissingEndpoints: string[];
  controlPlaneDiscoveryTokenMode?: string;
  controlPlaneDiscoveryTenantCount?: number;
  controlPlaneDiscoveryTenantOkCount?: number;
  controlPlaneDiscoveryMissingTenants?: string[];
} | undefined {
  if (!isRecord(readiness.checks) || !isRecord(readiness.checks.controlPlaneDiscovery)) return undefined;
  const check = readiness.checks.controlPlaneDiscovery;
  const detailBase = scope === "server" ? { scope, profile } : { scope, tenant, profile };
  const tokenMode = typeof check.tokenMode === "string" ? check.tokenMode : undefined;
  const tenantCount = typeof check.tenantCount === "number" ? check.tenantCount : undefined;
  const tenantOkCount = typeof check.tenantOkCount === "number" ? check.tenantOkCount : undefined;
  const missingTenants = Array.isArray(check.missingTenants)
    ? requireSmokeStringArray(
      check.missingTenants,
      `${scope} status controlPlaneDiscovery missingTenants must be strings`,
      scope === "server" ? "SMOKE_CONTROL_PLANE_DISCOVERY_INVALID" : "SMOKE_TENANT_CONTROL_PLANE_DISCOVERY_INVALID",
      { ...detailBase, field: "readiness.checks.controlPlaneDiscovery.missingTenants" },
    )
    : undefined;
  return {
    controlPlaneDiscoveryChecked: true,
    controlPlaneDiscoveryProvider: stringFieldFromResponse(check, "provider", `${scope} status controlPlaneDiscovery`),
    controlPlaneDiscoveryOk: booleanFieldFromResponse(check, "ok", `${scope} status controlPlaneDiscovery`),
    controlPlaneDiscoveryBaseUrlConfigured: booleanFieldFromResponse(check, "baseUrlConfigured", `${scope} status controlPlaneDiscovery`),
    controlPlaneDiscoveryEndpointCount: numberFieldFromResponse(check, "endpointCount", `${scope} status controlPlaneDiscovery`),
    controlPlaneDiscoveryOkEndpointCount: numberFieldFromResponse(check, "okEndpointCount", `${scope} status controlPlaneDiscovery`),
    controlPlaneDiscoveryMissingEndpoints: requireSmokeStringArray(
      arrayFieldFromResponse(check, "missingEndpoints", `${scope} status controlPlaneDiscovery`),
      `${scope} status controlPlaneDiscovery missingEndpoints must be strings`,
      scope === "server" ? "SMOKE_CONTROL_PLANE_DISCOVERY_INVALID" : "SMOKE_TENANT_CONTROL_PLANE_DISCOVERY_INVALID",
      { ...detailBase, field: "readiness.checks.controlPlaneDiscovery.missingEndpoints" },
    ),
    ...(tokenMode ? { controlPlaneDiscoveryTokenMode: tokenMode } : {}),
    ...(tenantCount !== undefined ? { controlPlaneDiscoveryTenantCount: tenantCount } : {}),
    ...(tenantOkCount !== undefined ? { controlPlaneDiscoveryTenantOkCount: tenantOkCount } : {}),
    ...(missingTenants ? { controlPlaneDiscoveryMissingTenants: missingTenants } : {}),
  };
}

export function runWorkspaceIsolationFieldFromResponse(
  server: Record<string, unknown>,
  scope: "server" | "tenant",
  profile: HarnessSmokeProfileName,
  label: string,
  tenant?: string,
): "project" | "run" {
  const value = server.runWorkspaceIsolation;
  if (value === "project" || value === "run") return value;
  const codePrefix = scope === "server" ? "SMOKE_SERVER" : "SMOKE_TENANT";
  const details = scope === "server"
    ? { scope, profile, field: "server.runWorkspaceIsolation", actual: value ?? null }
    : { scope, tenant, profile, field: "server.runWorkspaceIsolation", actual: value ?? null };
  throw smokeCheckError(
    `${codePrefix}_RUN_WORKSPACE_ISOLATION_INVALID`,
    `${label} server.runWorkspaceIsolation must be project or run`,
    details,
  );
}

export function verifySmokeControlPlaneStatus(
  profile: HarnessSmokeProfileName,
  server: Record<string, unknown>,
  scope: "server" | "tenant" = "server",
  tenant?: string,
): { provider: string; boundary: string[]; apiBasePath?: string; discoveryEndpoints: string[]; nativeCapabilities: string[]; adoptionStages: ControlPlaneProviderAdoptionStage[] } {
  const label = scope === "server" ? "server status controlPlane" : "tenant status controlPlane";
  const detailBase = scope === "server"
    ? { scope, profile }
    : { scope, tenant, profile };
  const codePrefix = scope === "server" ? "SMOKE_CONTROL_PLANE" : "SMOKE_TENANT_CONTROL_PLANE";
  const controlPlane = recordFieldFromResponse(server, "controlPlane", `${scope} status server`);
  const provider = stringFieldFromResponse(controlPlane, "provider", label);
  const providerCatalogEntry = controlPlaneProviderCatalogEntry(provider);
  if (!providerCatalogEntry?.enabledForServe) {
    const details: Record<string, unknown> = {
      ...detailBase,
      provider,
      supportedProviders: [...SERVE_CONTROL_PLANE_PROVIDERS],
    };
    if (providerCatalogEntry) {
      details.candidateStatus = providerCatalogEntry.status;
      details.candidateBlockedBy = providerCatalogEntry.blockedBy;
    }
    throw smokeCheckError(
      `${codePrefix}_PROVIDER_UNSUPPORTED`,
      `${scope === "server" ? "server" : `tenant ${tenant}`} profile ${profile} reported unsupported control-plane provider ${provider}`,
      details,
    );
  }
  const boundary = requireSmokeStringArray(
    arrayFieldFromResponse(controlPlane, "boundary", label),
    `${label} boundary must be strings`,
    `${codePrefix}_BOUNDARY_INVALID`,
    { ...detailBase, field: "server.controlPlane.boundary" },
  );
  const missingBoundary = CONTROL_PLANE_PROVIDER_BOUNDARY.filter((capability) => !boundary.includes(capability));
  if (missingBoundary.length) {
    throw smokeCheckError(
      `${codePrefix}_BOUNDARY_MISSING`,
      `${scope === "server" ? "server" : `tenant ${tenant}`} profile ${profile} missing control-plane boundary: ${missingBoundary.join(", ")}`,
      {
        ...detailBase,
        missingBoundary,
        requiredBoundary: CONTROL_PLANE_PROVIDER_BOUNDARY,
      },
    );
  }
  const apiBasePath = typeof controlPlane.apiBasePath === "string" ? controlPlane.apiBasePath : undefined;
  const discoveryEndpoints = requireSmokeStringArray(
    arrayFieldFromResponse(controlPlane, "discoveryEndpoints", label),
    `${label} discoveryEndpoints must be strings`,
    `${codePrefix}_DISCOVERY_ENDPOINTS_INVALID`,
    { ...detailBase, field: "server.controlPlane.discoveryEndpoints" },
  );
  const nativeCapabilities = requireSmokeStringArray(
    arrayFieldFromResponse(controlPlane, "nativeCapabilities", label),
    `${label} nativeCapabilities must be strings`,
    `${codePrefix}_NATIVE_CAPABILITIES_INVALID`,
    { ...detailBase, field: "server.controlPlane.nativeCapabilities" },
  );
  const adoptionStages = requireSmokeAdoptionStages(
    arrayFieldFromResponse(controlPlane, "adoptionStages", label),
    `${label} adoptionStages`,
    `${codePrefix}_ADOPTION_STAGES_INVALID`,
    { ...detailBase, field: "server.controlPlane.adoptionStages" },
  );
  const expectedDiscovery = providerCatalogEntry.discoveryEndpoints;
  const missingDiscovery = expectedDiscovery.filter((endpoint) => !discoveryEndpoints.includes(endpoint));
  const expectedNativeCapabilities = providerCatalogEntry.nativeCapabilities;
  const missingNativeCapabilities = expectedNativeCapabilities.filter((capability) => !nativeCapabilities.includes(capability));
  const missingAdoptionStages = providerCatalogEntry.adoptionStages
    .filter((expected) => !adoptionStages.some((actual) =>
      actual.name === expected.name &&
      actual.state === expected.state &&
      expected.evidence.every((item) => actual.evidence.includes(item))
    ))
    .map((stage) => stage.name);
  if (apiBasePath !== providerCatalogEntry.apiBasePath || missingDiscovery.length || missingNativeCapabilities.length || missingAdoptionStages.length) {
    throw smokeCheckError(
      `${codePrefix}_PROVIDER_CAPABILITIES_MISSING`,
      `${scope === "server" ? "server" : `tenant ${tenant}`} profile ${profile} missing control-plane provider capability evidence`,
      {
        ...detailBase,
        provider,
        apiBasePath: apiBasePath ?? null,
        expectedApiBasePath: providerCatalogEntry.apiBasePath,
        missingDiscovery,
        missingNativeCapabilities,
        missingAdoptionStages,
      },
    );
  }
  return { provider, boundary, apiBasePath, discoveryEndpoints, nativeCapabilities, adoptionStages };
}

export function requireOnlineSandboxTools(
  label: string,
  allowedTools: string[],
  code: string,
  details: Record<string, unknown>,
): void {
  const missingTools = ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS.filter((tool) => !allowedTools.includes(tool));
  if (missingTools.length) {
    throw smokeCheckError(code, `${label} missing required tools: ${missingTools.join(", ")}`, {
      ...details,
      missingTools,
      requiredTools: ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS,
    });
  }
}

export function requireSmokeStringArray(
  values: unknown[],
  message: string,
  code: string,
  details: Record<string, unknown>,
): string[] {
  const invalidItems = values.flatMap((value, index) =>
    typeof value === "string" ? [] : [{ index, type: smokeValueType(value) }]
  );
  if (invalidItems.length) {
    throw smokeCheckError(code, message, { ...details, invalidItems });
  }
  return values as string[];
}

export function requireSmokeAdoptionStages(
  values: unknown[],
  label: string,
  code: string,
  details: Record<string, unknown>,
): ControlPlaneProviderAdoptionStage[] {
  const stages: ControlPlaneProviderAdoptionStage[] = [];
  const invalidItems: Array<Record<string, unknown>> = [];
  values.forEach((value, index) => {
    if (!isRecord(value)) {
      invalidItems.push({ index, type: smokeValueType(value) });
      return;
    }
    const name = value.name;
    const state = value.state;
    const evidence = value.evidence;
    const evidenceInvalid = !Array.isArray(evidence) || evidence.some((item) => typeof item !== "string");
    if (
      typeof name !== "string" ||
      (state !== "available" && state !== "gated") ||
      evidenceInvalid
    ) {
      invalidItems.push({
        index,
        nameType: smokeValueType(name),
        state,
        evidenceType: smokeValueType(evidence),
      });
      return;
    }
    stages.push({ name, state, evidence: [...evidence] as string[] });
  });
  if (invalidItems.length) {
    throw smokeCheckError(code, `${label} must contain stage objects with name, state, and evidence strings`, {
      ...details,
      invalidItems,
    });
  }
  return stages;
}

export function smokeValueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

export async function verifySmokeHealthProbes(
  url: string,
  headers: Record<string, string>,
  labelPrefix = "",
): Promise<HarnessSmokeHealthProbeResult> {
  const healthz = await smokeJson(`${url}/healthz`, { headers }, [200], `GET ${labelPrefix}/healthz`);
  assertSmokeHealthProbeHasNoSensitiveFields(healthz.body, `${labelPrefix}healthz`);
  const healthzOk = booleanFieldFromResponse(healthz.body, "ok", `${labelPrefix}healthz`);
  const healthzStartedAt = stringFieldFromResponse(healthz.body, "startedAt", `${labelPrefix}healthz`);
  const healthzUptimeMs = numberFieldFromResponse(healthz.body, "uptimeMs", `${labelPrefix}healthz`);
  if (!healthzOk || healthzUptimeMs < 0) {
    throw smokeCheckError(
      "SMOKE_HEALTH_PROBE_INVALID",
      `${labelPrefix}healthz did not report a healthy non-negative uptime`,
      { scope: "health-probes", probe: `${labelPrefix}healthz`, ok: healthzOk, uptimeMs: healthzUptimeMs },
    );
  }

  const readyzBody = await waitForReadyz(url, headers, labelPrefix);
  assertSmokeHealthProbeHasNoSensitiveFields(readyzBody, `${labelPrefix}readyz`);
  const readyzReady = booleanFieldFromResponse(readyzBody, "ready", `${labelPrefix}readyz`);
  const readyzStartedAt = stringFieldFromResponse(readyzBody, "startedAt", `${labelPrefix}readyz`);
  const readyzUptimeMs = numberFieldFromResponse(readyzBody, "uptimeMs", `${labelPrefix}readyz`);
  const readyzChecks = recordFieldFromResponse(readyzBody, "checks", `${labelPrefix}readyz`);
  if (!readyzReady || readyzUptimeMs < 0) {
    throw smokeCheckError(
      "SMOKE_HEALTH_PROBE_INVALID",
      `${labelPrefix}readyz did not report ready with a non-negative uptime`,
      { scope: "health-probes", probe: `${labelPrefix}readyz`, ready: readyzReady, uptimeMs: readyzUptimeMs },
    );
  }

  return {
    healthProbesChecked: true,
    healthzChecked: true,
    healthzOk: true,
    healthzStartedAt,
    healthzUptimeMs,
    readyzChecked: true,
    readyzReady: true,
    readyzStartedAt,
    readyzUptimeMs,
    readyzCheckNames: Object.keys(readyzChecks).sort(),
    healthProbesSensitiveFieldsAbsent: true,
  };
}

export async function verifySmokeMetrics(
  url: string,
  headers: Record<string, string>,
  options: HarnessSmokeCliOptions,
  tenant: string,
  project: string,
): Promise<HarnessSmokeMetricsResult> {
  const response = await smokeText(`${url}/metrics`, { headers }, [200], "GET /metrics");
  const metrics = parseSmokeMetrics(response.text);
  const requiredNames = [
    "loom_harness_ready",
    "loom_harness_active_runs",
    "loom_harness_queued_runs",
    "loom_harness_active_workspace_sessions",
    "loom_harness_orphaned_running_runs",
    "loom_harness_review_required_runs",
    "loom_harness_deployment_required_runs",
    "loom_harness_model_usage_warning_projects",
    "loom_harness_workspace_usage_warning_projects",
    "loom_harness_queue_recovery_completed",
    "loom_harness_stale_run_cleanup_ready",
  ];
  const missingNames = requiredNames.filter((name) => !metrics.has(name));
  if (missingNames.length) {
    throw smokeCheckError(
      "SMOKE_METRICS_MISSING",
      "smoke metrics did not include the required low-cardinality gauges",
      { scope: "metrics", missingNames },
    );
  }

  const sensitiveTerms = [
    tenant,
    project,
    smokeToken(options),
    smokeViewerToken(options),
    smokeAdminToken(options),
  ].filter((term): term is string => Boolean(term));
  const leakedTerms = sensitiveTerms.filter((term) => response.text.includes(term));
  if (leakedTerms.length) {
    throw smokeCheckError(
      "SMOKE_METRICS_SENSITIVE_LABELS",
      "smoke metrics exposed tenant, project, or token material",
      { scope: "metrics", leakedTermCount: leakedTerms.length },
    );
  }

  return {
    metricsChecked: true,
    metricsReady: metrics.get("loom_harness_ready") === 1,
    metricsNames: [...metrics.keys()].sort(),
    metricsActiveRuns: requiredSmokeMetric(metrics, "loom_harness_active_runs"),
    metricsQueuedRuns: requiredSmokeMetric(metrics, "loom_harness_queued_runs"),
    metricsActiveWorkspaceSessions: requiredSmokeMetric(metrics, "loom_harness_active_workspace_sessions"),
    metricsOrphanedRunningRuns: requiredSmokeMetric(metrics, "loom_harness_orphaned_running_runs"),
    metricsReviewRequiredRuns: requiredSmokeMetric(metrics, "loom_harness_review_required_runs"),
    metricsDeploymentRequiredRuns: requiredSmokeMetric(metrics, "loom_harness_deployment_required_runs"),
    metricsModelUsageWarningProjects: requiredSmokeMetric(metrics, "loom_harness_model_usage_warning_projects"),
    metricsWorkspaceUsageWarningProjects: requiredSmokeMetric(metrics, "loom_harness_workspace_usage_warning_projects"),
    metricsLowCardinalityChecked: true,
    metricsSensitiveLabelsAbsent: true,
  };
}

export function parseSmokeMetrics(text: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const labelledSamples: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.includes("{")) {
      labelledSamples.push(trimmed.slice(0, 120));
      continue;
    }
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)\s+(-?(?:\d+|\d*\.\d+))$/.exec(trimmed);
    if (!match) {
      throw smokeCheckError(
        "SMOKE_METRICS_INVALID",
        "smoke metrics included a sample that was not a simple numeric gauge",
        { scope: "metrics", line: trimmed.slice(0, 120) },
      );
    }
    metrics.set(match[1], Number(match[2]));
  }
  if (labelledSamples.length) {
    throw smokeCheckError(
      "SMOKE_METRICS_HIGH_CARDINALITY",
      "smoke metrics included labelled samples; metrics must stay low-cardinality",
      { scope: "metrics", labelledSamples: labelledSamples.slice(0, 5) },
    );
  }
  return metrics;
}

export function requiredSmokeMetric(metrics: Map<string, number>, name: string): number {
  const value = metrics.get(name);
  if (value === undefined) {
    throw smokeCheckError("SMOKE_METRICS_MISSING", "smoke metrics did not include a required gauge", { scope: "metrics", name });
  }
  return value;
}

export function assertSmokeHealthProbeHasNoSensitiveFields(value: unknown, probe: string): void {
  const forbiddenFields = smokeHealthProbeForbiddenFieldPaths(value);
  if (forbiddenFields.length) {
    throw smokeCheckError(
      "SMOKE_HEALTH_PROBE_SENSITIVE_FIELDS",
      `${probe} exposed fields reserved for authenticated status APIs`,
      { scope: "health-probes", probe, forbiddenFields: forbiddenFields.slice(0, 10) },
    );
  }
}

export function smokeHealthProbeForbiddenFieldPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => smokeHealthProbeForbiddenFieldPaths(item, `${path}[${index}]`));
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = `${path}.${key}`;
    if (SMOKE_HEALTH_PROBE_FORBIDDEN_FIELDS.includes(key)) return [childPath];
    return smokeHealthProbeForbiddenFieldPaths(child, childPath);
  });
}
