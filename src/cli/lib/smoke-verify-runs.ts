import { isRecord } from "./flags.js";

import { verifySmokeAgentGitServiceHandoffWorkspaceAttachment, verifySmokeContractPatchEvidence, verifySmokeProjectContractSnapshot, verifySmokeSourceDefaultsMetadata } from "./smoke-verify-integrations.js";
import { arrayFieldFromResponse, booleanFieldFromResponse, type HarnessSmokeCliOptions, type HarnessSmokeFileCollabResult, type HarnessSmokeHandoffResult, type HarnessSmokeModelResult, type HarnessSmokeOnlineResult, type HarnessSmokePresenceExpectation, type HarnessSmokeRunControlsResult, type HarnessSmokeSourceDefaultsResult, type HarnessSmokeWorkspaceCommandResult, type HarnessSmokeWorkspaceSessionResult, numberFieldFromResponse, recordFieldFromResponse, sleep, SMOKE_POLL_TIMEOUT_MS, SMOKE_RUN_CONTROL_PAUSE_COMMAND, SMOKE_RUN_CONTROL_PAUSE_TIMEOUT_MS, SMOKE_RUN_CONTROL_RESUME_TIMEOUT_MS, type SmokeActiveRunLeaseEvidence, smokeCheckError, smokeHeaders, smokeJson, smokeUngatedRunDefaults, smokeViewerToken, stringFieldFromResponse } from "./smoke.js";

export async function verifySmokeModelRun(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
): Promise<HarnessSmokeModelResult> {
  const modelRunArtifactPath = "loom-model-smoke.txt";
  const modelRunArtifactContent = "loom model smoke ok\n";
  const runResponse = await smokeJson(
    `${url}/runs`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        tenant,
        project,
        ...smokeUngatedRunDefaults(),
        goal: `create ${modelRunArtifactPath} with the configured model gateway`,
        verify: [`test -f ${modelRunArtifactPath}`],
        skills: ["smoke", "coding"],
        requester: { clientId: "loom-smoke-model" },
      }),
    },
    [201],
    "POST smoke model run",
  );

  const modelRunId = stringFieldFromResponse(runResponse.body, "runId", "smoke model run");
  const status = stringFieldFromResponse(runResponse.body, "status", "smoke model run");
  if (status !== "passed") throw new Error(`smoke model run finished with status ${status}`);
  const metadata = recordFieldFromResponse(runResponse.body, "metadata", "smoke model run");
  const agentMode = stringFieldFromResponse(metadata, "agentMode", "smoke model run metadata");
  if (agentMode !== "model") throw new Error(`smoke model run used agent mode ${JSON.stringify(agentMode)}`);
  const modelRunModel = stringFieldFromResponse(metadata, "model", "smoke model run metadata");
  const modelUsage = recordFieldFromResponse(runResponse.body, "modelUsage", "smoke model run");
  const modelRunUsageRequestCount = numberFieldFromResponse(modelUsage, "requestCount", "smoke model run modelUsage");
  const modelRunUsageTotalTokens = numberFieldFromResponse(modelUsage, "totalTokens", "smoke model run modelUsage");
  const modelRunUsageCostUsd = typeof modelUsage.costUsd === "number" ? modelUsage.costUsd : undefined;
  if (modelRunUsageRequestCount < 1 || modelRunUsageTotalTokens < 1) {
    throw new Error("smoke model run did not record model usage");
  }

  const artifact = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/files?path=${encodeURIComponent(modelRunArtifactPath)}`,
    { headers },
    [200],
    "GET smoke model artifact",
  );
  const artifactKind = stringFieldFromResponse(artifact.body, "kind", "smoke model artifact");
  if (artifactKind !== "file") throw new Error(`smoke model artifact kind was ${JSON.stringify(artifactKind)}`);
  const loadedContent = stringFieldFromResponse(artifact.body, "content", "smoke model artifact");
  if (loadedContent !== modelRunArtifactContent) {
    throw new Error(`smoke model artifact content was ${JSON.stringify(loadedContent)}`);
  }

  const replay = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(modelRunId)}/replay?project=${encodeURIComponent(project)}`,
    { headers },
    [200],
    "GET smoke model replay",
  );
  const timeline = arrayFieldFromResponse(replay.body, "timeline", "smoke model replay");
  if (!timeline.some((entry) => isRecord(entry) && entry.type === "model_usage")) {
    throw new Error("smoke model replay did not include model usage");
  }

  return {
    modelRunChecked: true,
    modelRunId,
    modelRunStatus: "passed",
    modelRunModel,
    modelRunArtifactPath,
    modelRunArtifactRead: true,
    modelRunArtifactContent: loadedContent,
    modelRunUsageRequestCount,
    modelRunUsageTotalTokens,
    modelRunUsageCostUsd,
    modelRunReplayChecked: true,
  };
}

export async function verifySmokeWorkspaceSession(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
): Promise<HarnessSmokeWorkspaceSessionResult> {
  const command = "sh";
  const output = "loom-session-ok";
  const createResponse = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/sessions`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ command, clientId: "loom-smoke" }),
    },
    [201],
    "POST smoke workspace session",
  );
  const sessionId = stringFieldFromResponse(createResponse.body, "sessionId", "smoke workspace session");
  const sessionCommand = stringFieldFromResponse(createResponse.body, "command", "smoke workspace session");
  if (sessionCommand !== command) {
    throw new Error(`smoke workspace session command did not match: ${JSON.stringify(sessionCommand)}`);
  }

  const sessionBaseUrl = `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}`;
  const inputResponse = await smokeJson(
    `${sessionBaseUrl}/input`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ input: `printf ${output}\nexit\n`, clientId: "loom-smoke" }),
    },
    [200],
    "POST smoke workspace session input",
  );
  const inputAccepted = booleanFieldFromResponse(inputResponse.body, "accepted", "smoke workspace session input");
  if (!inputAccepted) throw new Error("smoke workspace session input was not accepted");

  try {
    const events = await waitForSmokeWorkspaceSessionEvents(`${sessionBaseUrl}/events`, headers, output);
    const stdout = events.find((event) =>
      isRecord(event) && event.type === "stdout" && typeof event.data === "string" && event.data.includes(output)
    );
    const exit = events.find((event) => isRecord(event) && event.type === "exit" && typeof event.exitCode === "number");
    if (!stdout || !isRecord(stdout) || typeof stdout.data !== "string") {
      throw new Error("smoke workspace session did not include expected stdout");
    }
    if (!exit || !isRecord(exit) || typeof exit.exitCode !== "number") {
      throw new Error("smoke workspace session did not include an exit event");
    }
    if (exit.exitCode !== 0) {
      throw new Error(`smoke workspace session exited with ${exit.exitCode}`);
    }
    return {
      workspaceSessionRun: true,
      workspaceSessionId: sessionId,
      workspaceSessionCommand: command,
      workspaceSessionInputAccepted: true,
      workspaceSessionOutput: output,
      workspaceSessionExitCode: exit.exitCode,
    };
  } catch (error) {
    await smokeJson(
      `${sessionBaseUrl}/stop`,
      { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ clientId: "loom-smoke" }) },
      [200, 400, 404],
      "POST smoke workspace session stop",
    ).catch(() => undefined);
    throw error;
  }
}

export async function verifySmokeWorkspaceCommand(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
): Promise<HarnessSmokeWorkspaceCommandResult> {
  const command = "printf loom-command-ok";
  const response = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/commands`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ command, clientId: "loom-smoke" }),
    },
    [200],
    "POST smoke workspace command",
  );
  const stdout = stringFieldFromResponse(response.body, "stdout", "smoke workspace command");
  const exitCode = numberFieldFromResponse(response.body, "exitCode", "smoke workspace command");
  if (stdout !== "loom-command-ok") {
    throw new Error(`smoke workspace command stdout did not match: ${JSON.stringify(stdout)}`);
  }
  if (exitCode !== 0) {
    throw new Error(`smoke workspace command exited with ${exitCode}`);
  }
  return {
    workspaceCommandRun: true,
    workspaceCommand: command,
    workspaceCommandStdout: stdout,
    workspaceCommandExitCode: exitCode,
  };
}

export async function verifySmokeRunCommentReplay(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
  runId: string,
): Promise<Pick<HarnessSmokeOnlineResult, "onlineRunCommentAdded" | "onlineRunCommentReplayChecked" | "onlineRunCommentText">> {
  const onlineRunCommentText = "loom smoke online steering is durable";
  const clientId = "loom-smoke-workbench-a";
  const runUrl = `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(runId)}`;
  const projectQuery = `project=${encodeURIComponent(project)}`;
  const commentResponse = await smokeJson(
    `${runUrl}/comments?${projectQuery}`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ message: onlineRunCommentText, clientId }),
    },
    [201],
    "POST smoke run comment",
  );
  const commentType = stringFieldFromResponse(commentResponse.body, "type", "smoke run comment");
  if (commentType !== "user_message") throw new Error(`smoke run comment wrote ${JSON.stringify(commentType)}`);
  const commentSeq = numberFieldFromResponse(commentResponse.body, "seq", "smoke run comment");
  const commentData = recordFieldFromResponse(commentResponse.body, "data", "smoke run comment");
  const commentKind = stringFieldFromResponse(commentData, "kind", "smoke run comment data");
  const commentContent = stringFieldFromResponse(commentData, "content", "smoke run comment data");
  const commentClientId = stringFieldFromResponse(commentData, "clientId", "smoke run comment data");
  if (commentKind !== "comment" || commentContent !== onlineRunCommentText || commentClientId !== clientId) {
    throw new Error("smoke run comment did not preserve the expected collaborative steering payload");
  }

  const replayResponse = await smokeJson(`${runUrl}/replay?${projectQuery}`, { headers }, [200], "GET smoke run replay");
  const timeline = arrayFieldFromResponse(replayResponse.body, "timeline", "smoke run replay");
  const replayEntry = timeline.find((entry) => isRecord(entry) && entry.seq === commentSeq && entry.type === "user_message");
  if (!isRecord(replayEntry)) throw new Error("smoke run replay did not include the run comment");
  const replayTitle = stringFieldFromResponse(replayEntry, "title", "smoke run replay comment");
  const replayDetail = stringFieldFromResponse(replayEntry, "detail", "smoke run replay comment");
  if (!replayTitle.includes(onlineRunCommentText) || !replayDetail.includes(onlineRunCommentText)) {
    throw new Error("smoke run replay did not preserve the run comment details");
  }

  return {
    onlineRunCommentAdded: true,
    onlineRunCommentReplayChecked: true,
    onlineRunCommentText,
  };
}

export async function verifySmokeFileCollab(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
): Promise<HarnessSmokeFileCollabResult> {
  const runFileCollabResult = await verifySmokeRunFileCollab(url, headers, tenant, project);
  const fileCollabPath = "loom-collab.txt";
  const staleClientId = "loom-smoke-collab-a";
  const activeEditorClientId = "loom-smoke-collab-b";
  const activeEditorLabel = "Loom Smoke Collab B";
  const freshContent = "fresh edit\n";
  const filesUrl = `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/files`;
  const fileUrl = `${filesUrl}?path=${encodeURIComponent(fileCollabPath)}`;

  await smokeJson(
    filesUrl,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ path: fileCollabPath, content: "base edit\n", clientId: staleClientId }),
    },
    [200],
    "POST smoke collab base file",
  );

  const loaded = await smokeJson(fileUrl, { headers }, [200], "GET smoke collab base file");
  const loadedKind = stringFieldFromResponse(loaded.body, "kind", "smoke collab base file");
  if (loadedKind !== "file") throw new Error(`smoke collab base path was ${JSON.stringify(loadedKind)}`);
  const baseUpdatedAt = stringFieldFromResponse(loaded.body, "updatedAt", "smoke collab base file");

  await verifySmokePresence(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/presence`,
    headers,
    [{ clientId: activeEditorClientId, label: activeEditorLabel, focus: `file:${fileCollabPath}` }],
    "file collab presence",
  );

  let freshUpdatedAt = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(attempt === 0 ? 25 : 1100);
    const fresh = await smokeJson(
      filesUrl,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ path: fileCollabPath, content: freshContent, clientId: activeEditorClientId }),
      },
      [200],
      "POST smoke collab fresh file",
    );
    freshUpdatedAt = stringFieldFromResponse(fresh.body, "updatedAt", "smoke collab fresh file");
    if (freshUpdatedAt !== baseUpdatedAt) break;
  }
  if (freshUpdatedAt === baseUpdatedAt) {
    throw new Error("smoke collab fresh save did not advance updatedAt for stale guard");
  }

  const staleSave = await smokeJson(
    filesUrl,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        path: fileCollabPath,
        content: "stale overwrite\n",
        baseUpdatedAt,
        clientId: staleClientId,
      }),
    },
    [409],
    "POST smoke collab stale save",
  );
  requireSmokeFileConflictEditor(staleSave.body, "smoke collab stale save", {
    clientId: activeEditorClientId,
    label: activeEditorLabel,
    focus: `file:${fileCollabPath}`,
  });

  const staleMove = await smokeJson(
    `${filesUrl}/move`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        fromPath: fileCollabPath,
        toPath: "loom-collab-moved.txt",
        baseUpdatedAt,
        clientId: staleClientId,
      }),
    },
    [409],
    "POST smoke collab stale move",
  );
  requireSmokeFileConflictEditor(staleMove.body, "smoke collab stale move", {
    clientId: activeEditorClientId,
    label: activeEditorLabel,
    focus: `file:${fileCollabPath}`,
  });

  const staleDelete = await smokeJson(
    fileUrl,
    {
      method: "DELETE",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        baseUpdatedAt,
        clientId: staleClientId,
      }),
    },
    [409],
    "DELETE smoke collab stale delete",
  );
  requireSmokeFileConflictEditor(staleDelete.body, "smoke collab stale delete", {
    clientId: activeEditorClientId,
    label: activeEditorLabel,
    focus: `file:${fileCollabPath}`,
  });

  const latest = await smokeJson(fileUrl, { headers }, [200], "GET smoke collab latest file");
  const fileCollabReloadedContent = stringFieldFromResponse(latest.body, "content", "smoke collab latest file");
  if (fileCollabReloadedContent !== freshContent) {
    throw new Error(`smoke collab latest file was ${JSON.stringify(fileCollabReloadedContent)}`);
  }

  const audit = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/audit?project=${encodeURIComponent(project)}`,
    { headers },
    [200],
    "GET smoke collab audit",
  );
  if (!Array.isArray(audit.body)) throw new Error("smoke collab audit response was not an array");
  const sawFreshWrite = audit.body.some((event) =>
    isRecord(event) &&
    event.type === "workspace_file_written" &&
    isRecord(event.data) &&
    event.data.project === project &&
    event.data.path === fileCollabPath &&
    event.data.clientId === activeEditorClientId
  );
  if (!sawFreshWrite) throw new Error("smoke collab audit did not include the fresh workspace file write");

  return {
    fileCollabChecked: true,
    fileCollabPath,
    fileCollabBaseRead: true,
    fileCollabActiveEditorClientId: activeEditorClientId,
    fileCollabActiveEditorLabel: activeEditorLabel,
    fileCollabStaleSaveDenied: true,
    fileCollabStaleMoveDenied: true,
    fileCollabStaleDeleteDenied: true,
    fileCollabReloadedContent,
    fileCollabAuditChecked: true,
    ...runFileCollabResult,
  };
}

export async function verifySmokeRunFileCollab(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
): Promise<Pick<
  HarnessSmokeFileCollabResult,
  | "runFileCollabChecked"
  | "runFileCollabRunId"
  | "runFileCollabPath"
  | "runFileCollabActiveEditorClientId"
  | "runFileCollabActiveEditorLabel"
  | "runFileCollabStaleSaveDenied"
  | "runFileCollabStaleMoveDenied"
  | "runFileCollabStaleDeleteDenied"
  | "runFileCollabReloadedContent"
  | "runFileCollabAuditChecked"
>> {
  const runFileCollabPath = "loom-run-collab.txt";
  const staleClientId = "loom-smoke-run-collab-a";
  const activeEditorClientId = "loom-smoke-run-collab-b";
  const activeEditorLabel = "Loom Smoke Run Collab B";
  const freshContent = "run fresh edit\n";
  const projectQuery = `project=${encodeURIComponent(project)}`;

  const runResponse = await smokeJson(
    `${url}/runs`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        tenant,
        project,
        ...smokeUngatedRunDefaults(),
        goal: "loom smoke run workspace file collaboration",
        script: [
          {
            message: "write run collab base",
            actions: [
              {
                toolName: "file.write",
                input: { path: runFileCollabPath, content: "run base edit\n" },
              },
            ],
          },
          { message: "finish run collab smoke", finish: true },
        ],
        verify: [`test -f ${runFileCollabPath}`],
        skills: ["smoke", "coding"],
        requester: { clientId: staleClientId },
      }),
    },
    [201],
    "POST smoke run collab run",
  );
  const runFileCollabRunId = stringFieldFromResponse(runResponse.body, "runId", "smoke run collab run");
  const runStatus = stringFieldFromResponse(runResponse.body, "status", "smoke run collab run");
  if (runStatus !== "passed") throw new Error(`smoke run collab run finished with status ${runStatus}`);

  const runUrl = `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(runFileCollabRunId)}`;
  const filesUrl = `${runUrl}/files?${projectQuery}`;
  const fileUrl = `${filesUrl}&path=${encodeURIComponent(runFileCollabPath)}`;
  const loaded = await smokeJson(fileUrl, { headers }, [200], "GET smoke run collab base file");
  const loadedKind = stringFieldFromResponse(loaded.body, "kind", "smoke run collab base file");
  if (loadedKind !== "file") throw new Error(`smoke run collab base path was ${JSON.stringify(loadedKind)}`);
  const baseUpdatedAt = stringFieldFromResponse(loaded.body, "updatedAt", "smoke run collab base file");

  await verifySmokePresence(
    `${runUrl}/presence?${projectQuery}`,
    headers,
    [{ clientId: activeEditorClientId, label: activeEditorLabel, focus: `file:${runFileCollabPath}` }],
    "run file collab presence",
  );

  let freshUpdatedAt = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(attempt === 0 ? 25 : 1100);
    const fresh = await smokeJson(
      filesUrl,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ path: runFileCollabPath, content: freshContent, clientId: activeEditorClientId }),
      },
      [200],
      "POST smoke run collab fresh file",
    );
    freshUpdatedAt = stringFieldFromResponse(fresh.body, "updatedAt", "smoke run collab fresh file");
    if (freshUpdatedAt !== baseUpdatedAt) break;
  }
  if (freshUpdatedAt === baseUpdatedAt) {
    throw new Error("smoke run collab fresh save did not advance updatedAt for stale guard");
  }

  const staleSave = await smokeJson(
    filesUrl,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        path: runFileCollabPath,
        content: "run stale overwrite\n",
        baseUpdatedAt,
        clientId: staleClientId,
      }),
    },
    [409],
    "POST smoke run collab stale save",
  );
  requireSmokeFileConflictEditor(staleSave.body, "smoke run collab stale save", {
    runId: runFileCollabRunId,
    clientId: activeEditorClientId,
    label: activeEditorLabel,
    focus: `file:${runFileCollabPath}`,
  });

  const staleMove = await smokeJson(
    `${runUrl}/files/move?${projectQuery}`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        fromPath: runFileCollabPath,
        toPath: "loom-run-collab-moved.txt",
        baseUpdatedAt,
        clientId: staleClientId,
      }),
    },
    [409],
    "POST smoke run collab stale move",
  );
  requireSmokeFileConflictEditor(staleMove.body, "smoke run collab stale move", {
    runId: runFileCollabRunId,
    clientId: activeEditorClientId,
    label: activeEditorLabel,
    focus: `file:${runFileCollabPath}`,
  });

  const staleDelete = await smokeJson(
    fileUrl,
    {
      method: "DELETE",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        baseUpdatedAt,
        clientId: staleClientId,
      }),
    },
    [409],
    "DELETE smoke run collab stale delete",
  );
  requireSmokeFileConflictEditor(staleDelete.body, "smoke run collab stale delete", {
    runId: runFileCollabRunId,
    clientId: activeEditorClientId,
    label: activeEditorLabel,
    focus: `file:${runFileCollabPath}`,
  });

  const latest = await smokeJson(fileUrl, { headers }, [200], "GET smoke run collab latest file");
  const runFileCollabReloadedContent = stringFieldFromResponse(latest.body, "content", "smoke run collab latest file");
  if (runFileCollabReloadedContent !== freshContent) {
    throw new Error(`smoke run collab latest file was ${JSON.stringify(runFileCollabReloadedContent)}`);
  }

  const audit = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/audit?${projectQuery}`,
    { headers },
    [200],
    "GET smoke run collab audit",
  );
  if (!Array.isArray(audit.body)) throw new Error("smoke run collab audit response was not an array");
  const sawFreshWrite = audit.body.some((event) =>
    isRecord(event) &&
    event.type === "workspace_file_written" &&
    isRecord(event.data) &&
    event.data.project === project &&
    event.data.runId === runFileCollabRunId &&
    event.data.path === runFileCollabPath &&
    event.data.clientId === activeEditorClientId
  );
  if (!sawFreshWrite) throw new Error("smoke run collab audit did not include the fresh run workspace file write");

  return {
    runFileCollabChecked: true,
    runFileCollabRunId,
    runFileCollabPath,
    runFileCollabActiveEditorClientId: activeEditorClientId,
    runFileCollabActiveEditorLabel: activeEditorLabel,
    runFileCollabStaleSaveDenied: true,
    runFileCollabStaleMoveDenied: true,
    runFileCollabStaleDeleteDenied: true,
    runFileCollabReloadedContent,
    runFileCollabAuditChecked: true,
  };
}

export function requireSmokeFileConflictEditor(
  body: unknown,
  label: string,
  expected: { runId?: string; clientId: string; label: string; focus: string },
): void {
  const activeEditors = arrayFieldFromResponse(body, "activeEditors", label);
  const activeEditor = activeEditors.find((entry) =>
    isRecord(entry) &&
    (expected.runId === undefined || entry.runId === expected.runId) &&
    entry.clientId === expected.clientId &&
    entry.label === expected.label &&
    entry.focus === expected.focus
  );
  if (!isRecord(activeEditor)) {
    throw new Error(`${label} did not include the active same-file editor`);
  }
}

export async function verifySmokeRunScopedPullRequestDuringActiveRun(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
  runId: string,
  sourceDefaults: HarnessSmokeSourceDefaultsResult,
): Promise<{
  runScopedPullRequestDuringActiveRunChecked: true;
  runScopedPullRequestDuringActiveRunId: string;
  runScopedPullRequestDuringActiveRunBranch: string;
  runScopedPullRequestDuringActiveRunCommit: string;
  runScopedPullRequestDuringActiveRunPush: false;
  runScopedPullRequestDuringActiveRunIndex?: number;
  runScopedPullRequestDuringActiveRunUrl?: string;
  runScopedFileWriteDuringActiveRunChecked: true;
  runScopedFileWriteDuringActiveRunBlockedRunId: string;
  runScopedFileWriteDuringActiveRunAllowedRunId: string;
  runScopedFileWriteDuringActiveRunPath: string;
  runScopedFileWriteDuringActiveRunDenied: true;
  agentGitServiceHandoffWorkspaceAttachmentChecked?: true;
  agentGitServiceHandoffWorkspaceAttachmentWorkspaceId?: string;
  agentGitServiceHandoffWorkspaceAttachmentId?: string;
  agentGitServiceHandoffWorkspaceAttachmentUrl?: string;
  agentGitServiceHandoffPackageUrl?: string;
  agentGitServiceHandoffFollowupsUrl?: string;
}> {
  const encodedTenant = encodeURIComponent(tenant);
  const encodedProject = encodeURIComponent(project);
  let activeRunId: string | undefined;

  try {
    const activeRun = await smokeJson(
      `${url}/runs`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          async: true,
          tenant,
          project,
          ...smokeUngatedRunDefaults(),
          goal: "loom smoke holds an isolated workspace during run-scoped PR handoff",
          allowedTools: ["shell.exec", "verify.run"],
          script: [
            {
              message: "hold an active isolated workspace",
              actions: [
                {
                  toolName: "shell.exec",
                  input: { command: "sleep 15; printf active > loom-smoke-active-run.txt" },
                },
              ],
            },
            { message: "finish active workspace holder", finish: true },
          ],
          verify: ["test -f loom-smoke-active-run.txt"],
          skills: ["smoke", "coding"],
          requester: { clientId: "loom-smoke-run-scoped-pr-active" },
        }),
      },
      [202],
      "POST smoke active run for run-scoped PR handoff",
    );
    activeRunId = stringFieldFromResponse(activeRun.body, "runId", "smoke active run");
    const activeStatus = stringFieldFromResponse(activeRun.body, "status", "smoke active run");
    if (activeStatus !== "running") {
      throw new Error(`smoke active run status was ${JSON.stringify(activeStatus)}`);
    }

    const fileWritePath = "loom-smoke-run-scoped-file.txt";
    const blockedWrite = await smokeJson(
      `${url}/tenants/${encodedTenant}/runs/${encodeURIComponent(activeRunId)}/files?project=${encodedProject}`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          path: fileWritePath,
          content: "this write must not land while the active run owns the workspace\n",
          clientId: "loom-smoke-run-scoped-file-blocked",
        }),
      },
      [409],
      "POST smoke active run workspace file write",
    );
    const blockedError = stringFieldFromResponse(blockedWrite.body, "error", "smoke active run workspace file write");
    if (!blockedError.includes(activeRunId)) {
      throw smokeCheckError(
        "SMOKE_RUN_SCOPED_FILE_LOCK_MISMATCH",
        "active run file write conflict did not identify the active run",
        { scope: "handoff", tenant, project, activeRunId, error: blockedError },
      );
    }

    const allowedWrite = await smokeJson(
      `${url}/tenants/${encodedTenant}/runs/${encodeURIComponent(runId)}/files?project=${encodedProject}`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          path: fileWritePath,
          content: "run-scoped file write allowed while another isolated run is active\n",
          clientId: "loom-smoke-run-scoped-file-allowed",
        }),
      },
      [200],
      "POST smoke completed run workspace file write during active run",
    );
    const allowedPath = stringFieldFromResponse(allowedWrite.body, "path", "smoke completed run workspace file write");
    if (allowedPath !== fileWritePath) {
      throw smokeCheckError(
        "SMOKE_RUN_SCOPED_FILE_WRITE_PATH_DRIFT",
        "completed run file write during another active run wrote an unexpected path",
        { scope: "handoff", tenant, project, runId, expectedPath: fileWritePath, actualPath: allowedPath },
      );
    }

    const commit = "loomsmoke";
    const created = await smokeJson(
      `${url}/tenants/${encodedTenant}/runs/${encodeURIComponent(runId)}/pull-requests?project=${encodedProject}`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          title: "Smoke run-scoped handoff while another run is active",
          commit,
          push: false,
          clientId: "loom-smoke-run-scoped-pr",
        }),
      },
      [201],
      "POST smoke run-scoped PR during active run",
    );
    const responseRunId = stringFieldFromResponse(created.body, "runId", "smoke run-scoped PR");
    if (responseRunId !== runId) throw new Error("smoke run-scoped PR targeted the wrong run");
    const branch = stringFieldFromResponse(created.body, "branch", "smoke run-scoped PR");
    const expectedBranch = `${sourceDefaults.sourceDefaultsBranch}/${runId}`;
    if (branch !== expectedBranch) {
      throw smokeCheckError(
        "SMOKE_RUN_SCOPED_PR_BRANCH_DRIFT",
        "run-scoped PR during another active run did not derive a run-unique branch",
        { scope: "handoff", tenant, project, runId, expectedBranch, actualBranch: branch },
      );
    }
    const responseCommit = stringFieldFromResponse(created.body, "commit", "smoke run-scoped PR");
    if (responseCommit !== commit) throw new Error("smoke run-scoped PR commit did not round-trip");
    const push = booleanFieldFromResponse(created.body, "push", "smoke run-scoped PR");
    if (push !== false) throw new Error("smoke run-scoped PR push flag did not round-trip");
    const pullRequestIndex = isRecord(created.body) && typeof created.body.pullRequestIndex === "number"
      ? created.body.pullRequestIndex
      : undefined;
    const pullRequestUrl = isRecord(created.body) && typeof created.body.pullRequestUrl === "string"
      ? created.body.pullRequestUrl
      : undefined;
    const agentGitServiceHandoffAttachment = await verifySmokeAgentGitServiceHandoffWorkspaceAttachment(
      url,
      headers,
      tenant,
      project,
      runId,
    );

    return {
      runScopedPullRequestDuringActiveRunChecked: true,
      runScopedPullRequestDuringActiveRunId: runId,
      runScopedPullRequestDuringActiveRunBranch: branch,
      runScopedPullRequestDuringActiveRunCommit: responseCommit,
      runScopedPullRequestDuringActiveRunPush: false,
      runScopedPullRequestDuringActiveRunIndex: pullRequestIndex,
      runScopedPullRequestDuringActiveRunUrl: pullRequestUrl,
      runScopedFileWriteDuringActiveRunChecked: true,
      runScopedFileWriteDuringActiveRunBlockedRunId: activeRunId,
      runScopedFileWriteDuringActiveRunAllowedRunId: runId,
      runScopedFileWriteDuringActiveRunPath: allowedPath,
      runScopedFileWriteDuringActiveRunDenied: true,
      ...(agentGitServiceHandoffAttachment ?? {}),
    };
  } finally {
    if (activeRunId) {
      await smokeJson(
        `${url}/tenants/${encodedTenant}/runs/${encodeURIComponent(activeRunId)}/cancel?project=${encodedProject}`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            reason: "release smoke active isolated workspace",
            clientId: "loom-smoke-run-scoped-pr-cleanup",
          }),
        },
        [200, 400, 404],
        "POST smoke active run cleanup",
      ).catch(() => undefined);
    }
  }
}

export async function verifySmokeHandoffEvidence(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
  runId: string,
  sourceDefaults: HarnessSmokeSourceDefaultsResult | undefined,
  checkRunScopedPullRequestDuringActiveRun = false,
): Promise<HarnessSmokeHandoffResult> {
  if (!sourceDefaults) throw new Error("smoke handoff source defaults were not verified");
  const runUrl = `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(runId)}`;
  const projectQuery = `project=${encodeURIComponent(project)}`;
  const reviewSummary = await smokeJson(
    `${runUrl}/review-summary?${projectQuery}`,
    { headers },
    [200],
    "GET smoke review summary",
  );
  const reviewSummaryRunId = stringFieldFromResponse(reviewSummary.body, "runId", "smoke review summary");
  const reviewSummaryStatus = stringFieldFromResponse(reviewSummary.body, "status", "smoke review summary");
  if (reviewSummaryRunId !== runId) {
    throw new Error(`smoke review summary runId did not match: ${JSON.stringify(reviewSummaryRunId)}`);
  }
  if (reviewSummaryStatus !== "passed") {
    throw new Error(`smoke review summary status was ${JSON.stringify(reviewSummaryStatus)}`);
  }
  const reviewSummaryTimeline = arrayFieldFromResponse(reviewSummary.body, "timeline", "smoke review summary");
  if (!reviewSummaryTimeline.some((entry) => isRecord(entry) && entry.type === "finish")) {
    throw new Error("smoke review summary timeline did not include the finish event");
  }
  verifySmokeProjectContractSnapshot(
    reviewSummary.body,
    "projectContract",
    "projectContractStatus",
    "smoke review summary",
  );
  const reviewMetadata = recordFieldFromResponse(reviewSummary.body, "metadata", "smoke review summary");
  verifySmokeSourceDefaultsMetadata(reviewMetadata, sourceDefaults, "smoke review summary metadata");

  const handoffPackage = await smokeJson(
    `${runUrl}/handoff-package?${projectQuery}`,
    { headers },
    [200],
    "GET smoke handoff package",
  );
  const checkpoint = recordFieldFromResponse(handoffPackage.body, "checkpoint", "smoke handoff package");
  const sourceCheckpointVersion = stringFieldFromResponse(checkpoint, "version", "smoke handoff package checkpoint");
  const handoffPackageRunId = stringFieldFromResponse(handoffPackage.body, "runId", "smoke handoff package");
  if (handoffPackageRunId !== runId) {
    throw new Error(`smoke handoff package runId did not match: ${JSON.stringify(handoffPackageRunId)}`);
  }
  const handoffReviewSummary = recordFieldFromResponse(handoffPackage.body, "reviewSummary", "smoke handoff package");
  const handoffReviewSummaryRunId = stringFieldFromResponse(handoffReviewSummary, "runId", "smoke handoff package review summary");
  const handoffReviewSummaryStatus = stringFieldFromResponse(handoffReviewSummary, "status", "smoke handoff package review summary");
  if (handoffReviewSummaryRunId !== runId || handoffReviewSummaryStatus !== reviewSummaryStatus) {
    throw new Error("smoke handoff package did not embed the matching review summary");
  }
  const handoffReviewMetadata = recordFieldFromResponse(handoffReviewSummary, "metadata", "smoke handoff package review summary");
  verifySmokeSourceDefaultsMetadata(handoffReviewMetadata, sourceDefaults, "smoke handoff package review summary metadata");
  verifySmokeProjectContractSnapshot(
    handoffReviewSummary,
    "projectContract",
    "projectContractStatus",
    "smoke handoff package review summary",
  );
  const auditTrail = arrayFieldFromResponse(handoffPackage.body, "auditTrail", "smoke handoff package");
  if (!auditTrail.some((event) =>
    isRecord(event) &&
    event.type === "run_created" &&
    isRecord(event.data) &&
    event.data.runId === runId
  )) {
    throw new Error("smoke handoff package audit trail did not include run_created");
  }
  const links = recordFieldFromResponse(handoffPackage.body, "links", "smoke handoff package");
  const reviewSummaryLink = stringFieldFromResponse(links, "reviewSummary", "smoke handoff package links");
  const replayLink = stringFieldFromResponse(links, "replay", "smoke handoff package links");
  const workbenchLink = stringFieldFromResponse(links, "workbench", "smoke handoff package links");
  if (
    !reviewSummaryLink.includes(`/tenants/${tenant}/runs/${runId}/review-summary`) ||
    !replayLink.includes(`/tenants/${tenant}/runs/${runId}/replay`) ||
    !workbenchLink.includes(`runId=${encodeURIComponent(runId)}`)
  ) {
    throw new Error("smoke handoff package links did not point at the run evidence");
  }
  const handoffWorkspace = recordFieldFromResponse(handoffPackage.body, "workspace", "smoke handoff package");
  const handoffWorkspaceRepo = stringFieldFromResponse(handoffWorkspace, "repo", "smoke handoff package workspace");
  const handoffWorkspaceBranch = stringFieldFromResponse(handoffWorkspace, "branch", "smoke handoff package workspace");
  const handoff = recordFieldFromResponse(handoffPackage.body, "handoff", "smoke handoff package");
  const handoffIssue = stringFieldFromResponse(handoff, "issue", "smoke handoff package handoff");
  const handoffBranch = stringFieldFromResponse(handoff, "branch", "smoke handoff package handoff");
  const handoffBaseBranch = stringFieldFromResponse(handoff, "baseBranch", "smoke handoff package handoff");
  const handoffIssueUrl = typeof handoff.issueUrl === "string" ? handoff.issueUrl : undefined;
  if (
    handoffWorkspaceRepo !== sourceDefaults.sourceDefaultsRepo ||
    handoffWorkspaceBranch !== sourceDefaults.sourceDefaultsBranch ||
    handoffIssue !== sourceDefaults.sourceDefaultsIssue ||
    handoffBranch !== sourceDefaults.sourceDefaultsBranch ||
    handoffBaseBranch !== sourceDefaults.sourceDefaultsBaseBranch ||
    (sourceDefaults.sourceDefaultsIssueUrl !== undefined && handoffIssueUrl !== sourceDefaults.sourceDefaultsIssueUrl)
  ) {
    throw smokeCheckError(
      "SMOKE_SOURCE_DEFAULTS_HANDOFF_DRIFT",
      "smoke handoff package did not preserve source defaults",
      {
        scope: "handoff",
        expected: sourceDefaults,
        actual: {
          workspaceRepo: handoffWorkspaceRepo,
          workspaceBranch: handoffWorkspaceBranch,
          issue: handoffIssue,
          branch: handoffBranch,
          baseBranch: handoffBaseBranch,
          issueUrl: handoffIssueUrl,
        },
      },
    );
  }

  const followup = await smokeJson(
    `${runUrl}/handoff-runs?${projectQuery}`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        goal: "loom smoke continues from handoff package",
        ...smokeUngatedRunDefaults(),
        script: [{ message: "finish smoke handoff follow-up", finish: true }],
        verify: [],
        skills: ["smoke", "coding"],
        clientId: "loom-smoke-handoff-followup",
        sourceCheckpointVersion,
      }),
    },
    [202],
    "POST smoke handoff follow-up run",
  );
  const handoffFollowupRunId = stringFieldFromResponse(followup.body, "runId", "smoke handoff follow-up run");
  if (handoffFollowupRunId === runId) throw new Error("smoke handoff follow-up reused the source runId");
  const finishedFollowup = await waitForSmokeRunStatus(
    `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(handoffFollowupRunId)}?${projectQuery}`,
    headers,
    "passed",
    "smoke handoff follow-up run",
  );
  stringFieldFromResponse(finishedFollowup.body, "status", "smoke handoff follow-up run");
  const followupMetadata = recordFieldFromResponse(finishedFollowup.body, "metadata", "smoke handoff follow-up run");
  const handoffFollowupSourceRunId = stringFieldFromResponse(followupMetadata, "handoffSourceRunId", "smoke handoff follow-up metadata");
  if (handoffFollowupSourceRunId !== runId) {
    throw new Error("smoke handoff follow-up metadata did not point at the source run");
  }
  verifySmokeProjectContractSnapshot(
    followupMetadata,
    "handoffSourceProjectContract",
    "handoffSourceProjectContractStatus",
    "smoke handoff follow-up metadata",
  );
  const handoffFollowupSourceDefaults = verifySmokeSourceDefaultsMetadata(
    followupMetadata,
    sourceDefaults,
    "smoke handoff follow-up metadata",
  );

  const lineage = await smokeJson(
    `${runUrl}/handoff-runs?${projectQuery}`,
    { headers },
    [200],
    "GET smoke handoff follow-up runs",
  );
  const followupRuns = arrayFieldFromResponse(lineage.body, "followupRuns", "smoke handoff follow-up runs");
  if (!followupRuns.some((item) => isRecord(item) && item.runId === handoffFollowupRunId)) {
    throw new Error("smoke handoff follow-up list did not include the created run");
  }
  const lineageCheckpoint = recordFieldFromResponse(lineage.body, "checkpoint", "smoke handoff follow-up runs");
  const lineageFollowups = recordFieldFromResponse(lineageCheckpoint, "followups", "smoke handoff follow-up checkpoint");
  const handoffFollowupCount = numberFieldFromResponse(lineageFollowups, "count", "smoke handoff follow-up checkpoint");
  if (handoffFollowupCount !== 1) {
    throw new Error(`smoke handoff follow-up count was ${handoffFollowupCount}`);
  }
  const runScopedPullRequestDuringActiveRun = checkRunScopedPullRequestDuringActiveRun
    ? await verifySmokeRunScopedPullRequestDuringActiveRun(
      url,
      headers,
      tenant,
      project,
      runId,
      sourceDefaults,
    )
    : undefined;

  const contractPatch = {
    objective: "Preserve the multi-user online sandbox development platform with an auditable harness loop.",
    constraints: [
      "Keep review and deployment gate evidence durable in smoke handoff checks.",
      "Keep VAS learning evidence visible when the MVP evolves.",
    ],
    successCriteria: [
      "Smoke verifies contract patches in review summaries, handoff packages, and replay.",
    ],
  };
  const patchRun = await smokeJson(
    `${url}/runs`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        tenant,
        project,
        goal: "loom smoke records contract patch handoff evidence",
        reviewRequired: true,
        script: [{ message: "finish smoke contract patch run", finish: true }],
        verify: [],
        skills: ["smoke", "coding"],
        requester: { clientId: "loom-smoke-contract-patch" },
      }),
    },
    [201],
    "POST smoke contract patch run",
  );
  const handoffContractPatchRunId = stringFieldFromResponse(patchRun.body, "runId", "smoke contract patch run");
  const patchRunStatus = stringFieldFromResponse(patchRun.body, "status", "smoke contract patch run");
  if (patchRunStatus !== "review_required") {
    throw new Error(`smoke contract patch run status was ${JSON.stringify(patchRunStatus)}`);
  }
  const patchRunUrl = `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(handoffContractPatchRunId)}`;
  const patchReview = await smokeJson(
    `${patchRunUrl}/review?${projectQuery}`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        decision: "approved",
        note: "loom smoke records contract patch evidence",
        contractPatch,
        clientId: "loom-smoke-contract-patch-review",
      }),
    },
    [200],
    "POST smoke contract patch review",
  );
  const patchReviewStatus = stringFieldFromResponse(patchReview.body, "status", "smoke contract patch review");
  if (patchReviewStatus !== "passed") {
    throw new Error(`smoke contract patch review status was ${JSON.stringify(patchReviewStatus)}`);
  }

  const patchReviewSummary = await smokeJson(
    `${patchRunUrl}/review-summary?${projectQuery}`,
    { headers },
    [200],
    "GET smoke contract patch review summary",
  );
  const patchReviewSummaryReview = recordFieldFromResponse(patchReviewSummary.body, "review", "smoke contract patch review summary");
  verifySmokeContractPatchEvidence(
    patchReviewSummaryReview,
    "contractPatch",
    contractPatch,
    "smoke contract patch review summary",
  );

  const patchHandoffPackage = await smokeJson(
    `${patchRunUrl}/handoff-package?${projectQuery}`,
    { headers },
    [200],
    "GET smoke contract patch handoff package",
  );
  const patchGateTrail = arrayFieldFromResponse(patchHandoffPackage.body, "gateTrail", "smoke contract patch handoff package");
  const patchGateTrailEntry = patchGateTrail.find((entry): entry is Record<string, unknown> =>
    isRecord(entry) &&
    entry.gate === "review" &&
    entry.status === "approved"
  );
  if (!patchGateTrailEntry) throw new Error("smoke contract patch handoff package did not include an approved review gate");
  verifySmokeContractPatchEvidence(
    patchGateTrailEntry,
    "contractPatch",
    contractPatch,
    "smoke contract patch handoff package gate trail",
  );

  const patchReplay = await smokeJson(
    `${patchRunUrl}/replay?${projectQuery}`,
    { headers },
    [200],
    "GET smoke contract patch replay",
  );
  const patchReplayTimeline = arrayFieldFromResponse(patchReplay.body, "timeline", "smoke contract patch replay");
  const patchReplayEntry = patchReplayTimeline.find((entry): entry is Record<string, unknown> =>
    isRecord(entry) &&
    entry.type === "review_gate" &&
    entry.status === "approved"
  );
  if (!patchReplayEntry) throw new Error("smoke contract patch replay did not include an approved review gate");
  verifySmokeContractPatchEvidence(
    patchReplayEntry,
    "contractPatch",
    contractPatch,
    "smoke contract patch replay",
  );

  return {
    handoffEvidenceChecked: true,
    reviewSummaryRead: true,
    reviewSummaryRunId,
    reviewSummaryStatus: "passed",
    reviewSummaryTimelineChecked: true,
    reviewSummaryContractEvidenceChecked: true,
    handoffPackageRead: true,
    handoffPackageRunId,
    handoffPackageReviewSummaryChecked: true,
    handoffPackageContractEvidenceChecked: true,
    handoffPackageAuditTrailChecked: true,
    handoffPackageLinksChecked: true,
    handoffFollowupCreated: true,
    handoffFollowupRunId,
    handoffFollowupRunStatus: "passed",
    handoffFollowupSourceRunId,
    handoffFollowupSourceContractEvidenceChecked: true,
    handoffSourceDefaultsChecked: true,
    handoffFollowupSourceDefaultsChecked: true,
    handoffFollowupRepo: handoffFollowupSourceDefaults.repo,
    handoffFollowupBranch: handoffFollowupSourceDefaults.branch,
    handoffFollowupBaseBranch: handoffFollowupSourceDefaults.baseBranch,
    handoffFollowupIssue: handoffFollowupSourceDefaults.issue,
    handoffFollowupIssueUrl: handoffFollowupSourceDefaults.issueUrl,
    ...(runScopedPullRequestDuringActiveRun ?? {}),
    handoffFollowupListChecked: true,
    handoffFollowupCount: 1,
    handoffContractPatchEvidenceChecked: true,
    handoffContractPatchRunId,
    handoffContractPatchReviewSummaryChecked: true,
    handoffContractPatchGateTrailChecked: true,
    handoffContractPatchReplayChecked: true,
  };
}

export async function verifySmokeActiveRunLease(
  url: string,
  headers: Record<string, string>,
  tenant: string,
  project: string,
  runId: string,
  label: string,
): Promise<SmokeActiveRunLeaseEvidence> {
  const response = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/status`,
    { headers },
    [200],
    `GET ${label} tenant status`,
  );
  const server = recordFieldFromResponse(response.body, "server", `${label} tenant status`);
  const isolation = server.runWorkspaceIsolation;
  if (isolation !== "project" && isolation !== "run") {
    throw smokeCheckError(
      "SMOKE_ACTIVE_RUN_LEASE_ISOLATION_INVALID",
      `${label} tenant status server.runWorkspaceIsolation must be project or run`,
      { scope: "tenant", tenant, project, runId, actual: isolation ?? null },
    );
  }
  const resources = recordFieldFromResponse(response.body, "resources", `${label} tenant status`);
  const activeRunDetails = Array.isArray(resources.activeRunDetails) ? resources.activeRunDetails : [];
  const activeRun = activeRunDetails.find((entry) =>
    isRecord(entry) &&
    entry.tenant === tenant &&
    entry.project === project &&
    entry.runId === runId
  );
  if (!isRecord(activeRun)) {
    const activeRuns = activeRunDetails.filter(isRecord).map((entry) => ({
      tenant: typeof entry.tenant === "string" ? entry.tenant : null,
      project: typeof entry.project === "string" ? entry.project : null,
      runId: typeof entry.runId === "string" ? entry.runId : null,
      workspaceLeaseScope: typeof entry.workspaceLeaseScope === "string" ? entry.workspaceLeaseScope : null,
      workspaceLeaseKey: typeof entry.workspaceLeaseKey === "string" ? entry.workspaceLeaseKey : null,
    }));
    throw smokeCheckError(
      "SMOKE_ACTIVE_RUN_LEASE_MISSING",
      `${label} did not report the pause/resume active run lease`,
      { scope: "tenant", tenant, project, runId, activeRuns },
    );
  }
  const leaseScope = stringFieldFromResponse(activeRun, "workspaceLeaseScope", label);
  if (leaseScope !== "project" && leaseScope !== "run") {
    throw smokeCheckError(
      "SMOKE_ACTIVE_RUN_LEASE_SCOPE_INVALID",
      `${label} reported an invalid workspaceLeaseScope`,
      { scope: "tenant", tenant, project, runId, actual: leaseScope },
    );
  }
  if (leaseScope !== isolation) {
    throw smokeCheckError(
      "SMOKE_ACTIVE_RUN_LEASE_SCOPE_MISMATCH",
      `${label} workspaceLeaseScope did not match tenant runWorkspaceIsolation`,
      { scope: "tenant", tenant, project, runId, expected: isolation, actual: leaseScope },
    );
  }
  const leaseKey = stringFieldFromResponse(activeRun, "workspaceLeaseKey", label);
  const expectedKey = leaseScope === "run" ? `${tenant}/${project}/${runId}` : `${tenant}/${project}`;
  if (leaseKey !== expectedKey) {
    throw smokeCheckError(
      "SMOKE_ACTIVE_RUN_LEASE_KEY_MISMATCH",
      `${label} reported an unexpected workspaceLeaseKey`,
      { scope: "tenant", tenant, project, runId, expected: expectedKey, actual: leaseKey },
    );
  }
  return { runId, scope: leaseScope, key: leaseKey };
}

export async function verifySmokeRunControls(
  url: string,
  developerHeaders: Record<string, string>,
  options: HarnessSmokeCliOptions,
  tenant: string,
  project: string,
  peerUrl?: string,
): Promise<HarnessSmokeRunControlsResult> {
  const projectQuery = `project=${encodeURIComponent(project)}`;
  const controlUrl = peerUrl ?? url;
  const crossServerControls = peerUrl !== undefined;
  const viewerToken = smokeViewerToken(options);
  const pauseHeaders = viewerToken ? smokeHeaders(viewerToken) : developerHeaders;

  const pauseRunResponse = await smokeJson(
    `${url}/runs`,
    {
      method: "POST",
      headers: { ...developerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        async: true,
        tenant,
        project,
        ...smokeUngatedRunDefaults(),
        goal: "loom smoke pause and resume controls",
        allowedTools: ["shell.exec", "verify.run"],
        script: [
          {
            message: "write first control trace",
            actions: [
              {
                toolName: "shell.exec",
                input: { command: SMOKE_RUN_CONTROL_PAUSE_COMMAND },
              },
            ],
          },
          {
            message: "write second control trace",
            actions: [
              {
                toolName: "shell.exec",
                input: { command: "printf second >> loom-control.txt; node -e \"setTimeout(()=>process.stdout.write('second'),3000)\"" },
              },
            ],
          },
          { message: "finish smoke run controls", finish: true },
        ],
        verify: ["test \"$(cat loom-control.txt)\" = firstsecond"],
        skills: ["smoke", "coding"],
        clientId: "loom-smoke-controls",
      }),
    },
    [202],
    "POST smoke pause/resume run",
  );
  const pauseResumeRunId = stringFieldFromResponse(pauseRunResponse.body, "runId", "smoke pause/resume run");
  const pauseRunUrl = `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(pauseResumeRunId)}`;
  const pauseControlRunUrl = `${controlUrl}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(pauseResumeRunId)}`;
  const pauseEventsUrl = `${pauseRunUrl}/events?${projectQuery}`;
  await waitForSmokeRunEvent(
    pauseEventsUrl,
    developerHeaders,
    (event) => isRecord(event) && event.type === "action",
    "smoke pause/resume run action",
  );
  const [activeRunLease, crossServerActiveRunLease] = await Promise.all([
    verifySmokeActiveRunLease(url, developerHeaders, tenant, project, pauseResumeRunId, "smoke active run lease"),
    peerUrl
      ? verifySmokeActiveRunLease(peerUrl, developerHeaders, tenant, project, pauseResumeRunId, "smoke peer active run lease")
      : Promise.resolve(undefined),
  ]);

  const pauseResponse = await smokeJson(
    `${pauseControlRunUrl}/comments?${projectQuery}`,
    {
      method: "POST",
      headers: { ...pauseHeaders, "content-type": "application/json" },
      body: JSON.stringify({ message: "Pause for loom smoke review.", pause: true, clientId: "loom-smoke-pause" }),
    },
    [201],
    "POST smoke pause request",
  );
  const pauseData = recordFieldFromResponse(pauseResponse.body, "data", "smoke pause request");
  const pauseRequested = booleanFieldFromResponse(pauseData, "pauseRequested", "smoke pause request");
  if (!pauseRequested) throw new Error("smoke pause request did not record pauseRequested");
  const pauseRequestRole = typeof pauseData.role === "string" ? pauseData.role : "anonymous";

  const paused = await waitForSmokeRunStatus(
    `${pauseRunUrl}?${projectQuery}`,
    developerHeaders,
    "paused",
    "smoke pause/resume run",
    SMOKE_RUN_CONTROL_PAUSE_TIMEOUT_MS,
  );
  const pausedRunStatus = stringFieldFromResponse(paused.body, "status", "smoke paused run");
  if (pausedRunStatus !== "paused") throw new Error(`smoke paused run status was ${pausedRunStatus}`);

  const resumeResponse = await smokeJson(
    `${pauseRunUrl}/resume?${projectQuery}`,
    {
      method: "POST",
      headers: { ...developerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ clientId: "loom-smoke-resume" }),
    },
    [202],
    "POST smoke resume request",
  );
  const resumedStatus = stringFieldFromResponse(resumeResponse.body, "status", "smoke resume request");
  if (resumedStatus !== "running") throw new Error(`smoke resume request returned ${resumedStatus}`);

  const resumed = await waitForSmokeRunStatus(
    `${pauseRunUrl}?${projectQuery}`,
    developerHeaders,
    "passed",
    "smoke resumed run",
    SMOKE_RUN_CONTROL_RESUME_TIMEOUT_MS,
  );
  stringFieldFromResponse(resumed.body, "status", "smoke resumed run");
  const pauseEvents = await smokeJson(pauseEventsUrl, { headers: developerHeaders }, [200], "GET smoke pause/resume events");
  const pauseEventBody = Array.isArray(pauseEvents.body) ? pauseEvents.body : [];
  const resumeEvent = pauseEventBody.find((event) =>
    isRecord(event) &&
    event.type === "resume" &&
    isRecord(event.data) &&
    event.data.clientId === "loom-smoke-resume"
  );
  if (!isRecord(resumeEvent) || !isRecord(resumeEvent.data)) {
    throw new Error("smoke pause/resume events did not include resume");
  }
  const resumeRequestRole = typeof resumeEvent.data.role === "string" ? resumeEvent.data.role : "developer";
  if (!pauseEventBody.some((event) => isRecord(event) && event.type === "pause")) {
    throw new Error("smoke pause/resume events did not include pause");
  }

  const trace = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/projects/${encodeURIComponent(project)}/files?path=${encodeURIComponent("loom-control.txt")}`,
    { headers: developerHeaders },
    [200],
    "GET smoke pause/resume trace",
  );
  const pauseResumeTraceContent = stringFieldFromResponse(trace.body, "content", "smoke pause/resume trace");
  if (pauseResumeTraceContent !== "firstsecond") {
    throw new Error(`smoke pause/resume trace was ${JSON.stringify(pauseResumeTraceContent)}`);
  }

  let crossServerIdempotentCreateRunId: string | undefined;
  let crossServerIdempotentCreateClientRequestId: string | undefined;
  let crossServerIdempotentCreateReplayChecked: true | undefined;
  let crossServerIdempotentCreateRunStatus: "cancelled" | undefined;
  if (peerUrl) {
    crossServerIdempotentCreateClientRequestId = `loom-smoke-idempotent-${Date.now()}`;
    const idempotentPayload = {
      async: true,
      tenant,
      project,
      ...smokeUngatedRunDefaults(),
      clientRequestId: crossServerIdempotentCreateClientRequestId,
      goal: "loom smoke cross-server idempotent create",
      allowedTools: ["shell.exec", "verify.run"],
      script: [
        {
          message: "hold idempotent smoke run",
          actions: [
            {
              toolName: "shell.exec",
              input: { command: "node -e \"setTimeout(()=>process.stdout.write('idempotent'),10000)\"" },
            },
          ],
        },
        { message: "finish idempotent smoke run", finish: true },
      ],
      verify: [],
      skills: ["smoke", "coding"],
      clientId: "loom-smoke-idempotent-create",
    };
    const [primaryCreate, peerCreate] = await Promise.all([
      smokeJson(
        `${url}/runs`,
        {
          method: "POST",
          headers: { ...developerHeaders, "content-type": "application/json" },
          body: JSON.stringify(idempotentPayload),
        },
        [202],
        "POST smoke idempotent create primary",
      ),
      smokeJson(
        `${peerUrl}/runs`,
        {
          method: "POST",
          headers: { ...developerHeaders, "content-type": "application/json" },
          body: JSON.stringify(idempotentPayload),
        },
        [202],
        "POST smoke idempotent create peer",
      ),
    ]);
    const primaryRunId = stringFieldFromResponse(primaryCreate.body, "runId", "smoke idempotent create primary");
    const peerRunId = stringFieldFromResponse(peerCreate.body, "runId", "smoke idempotent create peer");
    const primaryStatus = stringFieldFromResponse(primaryCreate.body, "status", "smoke idempotent create primary");
    const peerStatus = stringFieldFromResponse(peerCreate.body, "status", "smoke idempotent create peer");
    if (primaryRunId !== peerRunId) throw new Error("smoke idempotent create returned different run ids across servers");
    if (primaryStatus !== "running" || peerStatus !== "running") {
      throw new Error(`smoke idempotent create statuses were ${primaryStatus}/${peerStatus}`);
    }
    const primaryReplay = isRecord(primaryCreate.body) && primaryCreate.body.idempotentReplay === true;
    const peerReplay = isRecord(peerCreate.body) && peerCreate.body.idempotentReplay === true;
    if (!primaryReplay && !peerReplay) throw new Error("smoke idempotent create did not report an idempotent replay");
    crossServerIdempotentCreateRunId = primaryRunId;
    crossServerIdempotentCreateReplayChecked = true;
    const idempotentRunUrl = `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(crossServerIdempotentCreateRunId)}`;
    await smokeJson(
      `${peerUrl}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(crossServerIdempotentCreateRunId)}/cancel?${projectQuery}`,
      {
        method: "POST",
        headers: { ...developerHeaders, "content-type": "application/json" },
        body: JSON.stringify({ reason: "loom smoke idempotent cleanup", clientId: "loom-smoke-idempotent-cancel" }),
      },
      [200, 202],
      "POST smoke idempotent create cleanup",
    );
    await waitForSmokeRunStatus(`${idempotentRunUrl}?${projectQuery}`, developerHeaders, "cancelled", "smoke idempotent create cleanup");
    crossServerIdempotentCreateRunStatus = "cancelled";
  }

  const cancelRunResponse = await smokeJson(
    `${url}/runs`,
    {
      method: "POST",
      headers: { ...developerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        async: true,
        tenant,
        project,
        ...smokeUngatedRunDefaults(),
        goal: "loom smoke cancel control",
        allowedTools: ["shell.exec", "verify.run"],
        script: [
          {
            message: "start cancellable control action",
            actions: [
              {
                toolName: "shell.exec",
                input: { command: "node -e \"setTimeout(()=>process.stdout.write('late'),5000)\"" },
              },
            ],
          },
          { message: "finish cancelled run", finish: true },
        ],
        verify: [],
        skills: ["smoke", "coding"],
        clientId: "loom-smoke-cancel-run",
      }),
    },
    [202],
    "POST smoke cancellable run",
  );
  const cancelRunId = stringFieldFromResponse(cancelRunResponse.body, "runId", "smoke cancellable run");
  const cancelRunUrl = `${url}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(cancelRunId)}`;
  const cancelControlRunUrl = `${controlUrl}/tenants/${encodeURIComponent(tenant)}/runs/${encodeURIComponent(cancelRunId)}`;
  const cancelEventsUrl = `${cancelRunUrl}/events?${projectQuery}`;
  await waitForSmokeRunEvent(
    cancelEventsUrl,
    developerHeaders,
    (event) => isRecord(event) && event.type === "action",
    "smoke cancellable run action",
  );
  const cancelResponse = await smokeJson(
    `${cancelControlRunUrl}/cancel?${projectQuery}`,
    {
      method: "POST",
      headers: { ...developerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ reason: "loom smoke cancel", clientId: "loom-smoke-cancel" }),
    },
    peerUrl ? [200, 202] : [200],
    "POST smoke cancel run",
  );
  const cancelResponseStatus = stringFieldFromResponse(cancelResponse.body, "status", "smoke cancel run");
  const crossServerCancelRequested = peerUrl
    ? booleanFieldFromResponse(cancelResponse.body, "cancelRequested", "smoke peer cancel run")
    : undefined;
  if (peerUrl && !crossServerCancelRequested) throw new Error("smoke peer cancel run did not record cancelRequested");
  if (!peerUrl && cancelResponseStatus !== "cancelled") throw new Error(`smoke cancel run returned ${cancelResponseStatus}`);
  await waitForSmokeRunStatus(`${cancelRunUrl}?${projectQuery}`, developerHeaders, "cancelled", "smoke cancelled run");
  const cancelRunStatus = "cancelled";
  const replay = await smokeJson(`${cancelRunUrl}/replay?${projectQuery}`, { headers: developerHeaders }, [200], "GET smoke cancelled run replay");
  const replayTimeline = arrayFieldFromResponse(replay.body, "timeline", "smoke cancelled run replay");
  if (!replayTimeline.some((entry) => isRecord(entry) && entry.type === "cancel")) {
    throw new Error("smoke cancelled run replay did not include cancel");
  }

  const audit = await smokeJson(
    `${url}/tenants/${encodeURIComponent(tenant)}/audit?${projectQuery}`,
    { headers: developerHeaders },
    [200],
    "GET smoke run control audit",
  );
  const auditBody = Array.isArray(audit.body) ? audit.body : [];
  const sawResumeAudit = auditBody.some((event) =>
    isRecord(event) &&
    event.type === "run_resumed" &&
    isRecord(event.data) &&
    event.data.runId === pauseResumeRunId
  );
  const sawCancelAudit = auditBody.some((event) =>
    isRecord(event) &&
    event.type === "run_cancelled" &&
    isRecord(event.data) &&
    event.data.runId === cancelRunId
  );
  if (!sawResumeAudit || !sawCancelAudit) {
    throw new Error("smoke run control audit did not include resume and cancel events");
  }

  return {
    runControlsChecked: true,
    pauseResumeChecked: true,
    pauseResumeRunId,
    activeRunLeaseChecked: true,
    activeRunLeaseRunId: activeRunLease.runId,
    activeRunLeaseScope: activeRunLease.scope,
    activeRunLeaseKey: activeRunLease.key,
    pauseRequested: true,
    pauseRequestRole,
    pausedRunStatus: "paused",
    resumeRequested: true,
    resumeRequestRole: resumeRequestRole === "admin" ? "admin" : "developer",
    resumedRunStatus: "passed",
    pauseResumeTraceContent,
    cancelChecked: true,
    cancelRunId,
    cancelRunStatus: "cancelled",
    cancelReplayChecked: true,
    runControlsPeerUrl: peerUrl,
    crossServerPauseChecked: crossServerControls ? true : undefined,
    crossServerActiveRunLeaseChecked: crossServerActiveRunLease ? true : undefined,
    crossServerActiveRunLeaseRunId: crossServerActiveRunLease?.runId,
    crossServerActiveRunLeaseScope: crossServerActiveRunLease?.scope,
    crossServerActiveRunLeaseKey: crossServerActiveRunLease?.key,
    crossServerPauseRunId: crossServerControls ? pauseResumeRunId : undefined,
    crossServerPauseRequested: crossServerControls ? true : undefined,
    crossServerPauseRunStatus: crossServerControls ? "paused" : undefined,
    crossServerCancelChecked: crossServerControls ? true : undefined,
    crossServerCancelRunId: crossServerControls ? cancelRunId : undefined,
    crossServerCancelRequested: crossServerControls ? true : undefined,
    crossServerCancelRunStatus: crossServerControls ? cancelRunStatus : undefined,
    crossServerIdempotentCreateChecked: crossServerControls ? true : undefined,
    crossServerIdempotentCreateRunId,
    crossServerIdempotentCreateClientRequestId,
    crossServerIdempotentCreateReplayChecked,
    crossServerIdempotentCreateRunStatus,
    runControlAuditChecked: true,
  };
}

export async function verifySmokePresence(
  presenceUrl: string,
  headers: Record<string, string>,
  expected: HarnessSmokePresenceExpectation[],
  label: string,
): Promise<number> {
  for (const entry of expected) {
    const response = await smokeJson(
      presenceUrl,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(entry),
      },
      [200],
      `POST smoke ${label}`,
    );
    const clientId = stringFieldFromResponse(response.body, "clientId", `smoke ${label}`);
    const responseLabel = stringFieldFromResponse(response.body, "label", `smoke ${label}`);
    const focus = stringFieldFromResponse(response.body, "focus", `smoke ${label}`);
    if (clientId !== entry.clientId || responseLabel !== entry.label || focus !== entry.focus) {
      throw new Error(`smoke ${label} heartbeat did not echo the expected collaborator`);
    }
  }

  const response = await smokeJson(presenceUrl, { headers }, [200], `GET smoke ${label}`);
  if (!Array.isArray(response.body)) throw new Error(`smoke ${label} response was not an array`);
  const entries: unknown[] = response.body;
  const collaboratorCount = expected.filter((entry) =>
    entries.some((item) =>
      isRecord(item) &&
      item.clientId === entry.clientId &&
      item.label === entry.label &&
      item.focus === entry.focus
    )
  ).length;
  if (collaboratorCount !== expected.length) {
    throw new Error(`smoke ${label} did not include all heartbeat collaborators`);
  }
  return collaboratorCount;
}

export async function waitForSmokeWorkspaceSessionEvents(
  eventsUrl: string,
  headers: Record<string, string>,
  output: string,
): Promise<unknown[]> {
  const deadline = Date.now() + SMOKE_POLL_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await smokeJson(eventsUrl, { headers }, [200], "GET smoke workspace session events");
      if (!Array.isArray(response.body)) {
        throw new Error("smoke workspace session events response was not an array");
      }
      const sawOutput = response.body.some((event) =>
        isRecord(event) && event.type === "stdout" && typeof event.data === "string" && event.data.includes(output)
      );
      const sawExit = response.body.some((event) => isRecord(event) && event.type === "exit" && event.exitCode === 0);
      if (sawOutput && sawExit) return response.body;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(lastError || "smoke workspace session did not produce output and exit before timeout");
}

export async function waitForSmokeRunStatus(
  runUrl: string,
  headers: Record<string, string>,
  expectedStatus: string,
  label: string,
  timeoutMs = SMOKE_POLL_TIMEOUT_MS,
): Promise<{ body: unknown }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await smokeJson(runUrl, { headers }, [200], `GET ${label}`);
      const status = stringFieldFromResponse(response.body, "status", label);
      if (status === expectedStatus) return { body: response.body };
      lastStatus = status;
      if (status === "failed" || status === "error" || status === "cancelled") {
        throw new Error(`${label} finished with status ${status}`);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(lastError || `${label} did not reach ${expectedStatus} before timeout; last status ${lastStatus || "<unknown>"}`);
}

export async function waitForSmokeRunEvent(
  eventsUrl: string,
  headers: Record<string, string>,
  predicate: (event: unknown) => boolean,
  label: string,
): Promise<unknown[]> {
  const deadline = Date.now() + SMOKE_POLL_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await smokeJson(eventsUrl, { headers }, [200], `GET ${label} events`);
      if (!Array.isArray(response.body)) throw new Error(`${label} events response was not an array`);
      if (response.body.some(predicate)) return response.body;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(lastError || `${label} event did not appear before timeout`);
}
