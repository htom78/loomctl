export const WORKBENCH_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Loom Workbench</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f6f7;
      --surface: #ffffff;
      --surface-2: #eef2f0;
      --text: #172126;
      --muted: #617079;
      --line: #d9dee2;
      --accent: #126755;
      --bad: #b42318;
      --ok: #1c7c54;
      --warn: #9a6a00;
      --radius: 8px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      letter-spacing: 0;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 58px;
      padding: 10px 18px;
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }
    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
    }
    main {
      display: grid;
      grid-template-columns: minmax(260px, 340px) minmax(320px, 1fr) minmax(320px, 480px);
      gap: 1px;
      min-height: calc(100vh - 58px);
      background: var(--line);
    }
    section {
      min-width: 0;
      background: var(--surface);
      padding: 16px;
      overflow: auto;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 13px;
      line-height: 1.2;
      text-transform: uppercase;
      color: var(--muted);
    }
    label {
      display: block;
      margin: 10px 0 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      font: inherit;
      min-height: 36px;
      padding: 8px 10px;
    }
    textarea {
      min-height: 120px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
    }
    button, a.button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--accent);
      background: var(--accent);
      color: white;
      border-radius: 6px;
      min-height: 36px;
      padding: 0 12px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
    }
    button.secondary, a.button.secondary {
      background: var(--surface);
      color: var(--accent);
    }
    button.danger { border-color: var(--bad); background: var(--bad); }
    button:disabled { cursor: not-allowed; opacity: .62; }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .check-row {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      color: var(--muted);
    }
    .check-row input {
      width: auto;
      min-height: auto;
    }
    .summary, .file-editor, .output, .list {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #fbfcfd;
    }
    .summary {
      padding: 12px;
      margin-bottom: 12px;
    }
    .summary-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0 8px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .pill.passed { color: var(--ok); }
    .pill.running, .pill.queued, .pill.review_required, .pill.deployment_required, .pill.paused { color: var(--warn); }
    .pill.failed, .pill.error, .pill.cancelled { color: var(--bad); }
    .list {
      display: grid;
      gap: 8px;
      padding: 10px;
      min-height: 80px;
    }
    .item {
      width: 100%;
      text-align: left;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      color: var(--text);
      padding: 10px;
    }
    .item-title {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
    }
    .file-editor {
      margin-top: 10px;
      padding: 10px;
    }
    .file-editor[hidden], .output[hidden] { display: none; }
    .output {
      margin-top: 10px;
      max-height: 260px;
      overflow: auto;
      background: #111820;
      color: #eef6f4;
    }
    pre {
      margin: 0;
      padding: 10px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
    }
    .empty {
      border: 1px dashed var(--line);
      border-radius: var(--radius);
      color: var(--muted);
      padding: 18px;
      text-align: center;
    }
    .error {
      min-height: 18px;
      margin-top: 10px;
      color: var(--bad);
      font-size: 12px;
      line-height: 1.45;
    }
    .error-summary {
      display: grid;
      gap: 4px;
      margin-top: 10px;
      border: 1px solid #f1bbb6;
      border-radius: var(--radius);
      background: #fff1ef;
      color: var(--bad);
      padding: 10px;
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    @media (max-width: 1100px) {
      main { grid-template-columns: 1fr; }
      section { min-height: 300px; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Loom Workbench</h1>
      <div id="workbench-context" class="summary-grid"></div>
    </div>
    <div class="actions">
      <button data-testid="workbench-refresh" id="workbench-refresh" class="secondary" type="button">Refresh</button>
      <a id="open-dashboard" class="button secondary" href="/">Dashboard</a>
    </div>
  </header>
  <main>
    <section>
      <h2>Run</h2>
      <div id="workbench-run" class="summary">
        <div class="empty">No run loaded.</div>
      </div>
      <label for="workbench-run-comment">Run comment</label>
      <input id="workbench-run-comment" autocomplete="off" />
      <label class="check-row" for="workbench-run-comment-pause">
        <input id="workbench-run-comment-pause" type="checkbox" />
        Pause after current step
      </label>
      <div class="actions">
        <button data-testid="workbench-send-run-comment" id="workbench-send-run-comment" class="secondary" type="button">Send Comment</button>
        <button data-testid="workbench-sync-issue-comments" id="workbench-sync-issue-comments" class="secondary" type="button">Sync Issue Comments</button>
        <button data-testid="workbench-cancel-run" id="workbench-cancel-run" class="danger" type="button">Cancel Run</button>
        <button data-testid="workbench-abandon-run" id="workbench-abandon-run" class="secondary" type="button" hidden>Abandon Run</button>
        <button data-testid="workbench-resume-run" id="workbench-resume-run" type="button">Resume Run</button>
      </div>
      <h2>Workspace</h2>
      <div id="workbench-workspace" class="summary">
        <div class="empty">Workspace context not loaded.</div>
      </div>
      <div class="actions">
        <button data-testid="workbench-load-diff" id="workbench-load-diff" class="secondary" type="button">Load Diff</button>
      </div>
      <pre id="workbench-diff" class="output" hidden></pre>
      <label for="workbench-commit-message">Commit message</label>
      <input id="workbench-commit-message" autocomplete="off" value="run checkpoint" />
      <div class="actions">
        <button data-testid="workbench-commit-workspace" id="workbench-commit-workspace" class="secondary" type="button">Commit</button>
      </div>
      <label for="workbench-pr-issue">PR issue</label>
      <input id="workbench-pr-issue" autocomplete="off" placeholder="owner/repo#42" />
      <label for="workbench-pr-branch">PR branch</label>
      <input id="workbench-pr-branch" autocomplete="off" placeholder="task/change" />
      <label for="workbench-pr-base">PR base branch</label>
      <input id="workbench-pr-base" autocomplete="off" placeholder="main" />
      <label class="checkbox">
        <input id="workbench-pr-review" type="checkbox" />
        Require review gate
      </label>
      <label class="checkbox">
        <input id="workbench-pr-deployment" type="checkbox" />
        Require deployment gate
      </label>
      <div class="actions">
        <button data-testid="workbench-handoff-pr" id="workbench-handoff-pr" class="secondary" type="button">Handoff PR</button>
        <button data-testid="workbench-request-pr-escalation" id="workbench-pr-escalation" class="secondary" type="button">Request git.pr</button>
      </div>
      <label for="workbench-presence-label">Presence name</label>
      <input id="workbench-presence-label" autocomplete="name" />
      <div data-testid="workbench-presence" id="workbench-presence" class="list">
        <div class="empty">No collaborators online.</div>
      </div>
      <label for="workbench-handoff-followup-goal">Follow-up goal</label>
      <input id="workbench-handoff-followup-goal" autocomplete="off" placeholder="continue from this handoff" />
      <label for="workbench-handoff-followup-note">Follow-up note</label>
      <textarea id="workbench-handoff-followup-note" placeholder="reviewer note for the next run"></textarea>
      <div class="actions">
        <button data-testid="workbench-load-replay" id="workbench-load-replay" class="secondary" type="button">Load Replay</button>
        <button data-testid="workbench-load-review-summary" id="workbench-load-review-summary" class="secondary" type="button">Load Review Summary</button>
        <button data-testid="workbench-load-handoff-package" id="workbench-load-handoff-package" class="secondary" type="button">Load Package</button>
        <button data-testid="workbench-load-handoff-followups" id="workbench-load-handoff-followups" class="secondary" type="button">Load Follow-Ups</button>
        <button data-testid="workbench-start-handoff-followup" id="workbench-start-handoff-followup" type="button">Start Follow-Up</button>
        <button data-testid="workbench-claim-review" id="workbench-claim-review" class="secondary" type="button">Claim Review</button>
        <button data-testid="workbench-release-review-claim" id="workbench-release-review-claim" class="secondary" type="button">Release Claim</button>
      </div>
      <label for="workbench-review-note">Review note</label>
      <textarea id="workbench-review-note"></textarea>
      <label for="workbench-review-contract-objective">Contract patch objective</label>
      <input id="workbench-review-contract-objective" autocomplete="off" />
      <label for="workbench-review-contract-constraints">Contract patch constraints</label>
      <textarea id="workbench-review-contract-constraints" placeholder="one constraint per line"></textarea>
      <label for="workbench-review-contract-success">Contract patch success criteria</label>
      <textarea id="workbench-review-contract-success" placeholder="one success criterion per line"></textarea>
      <label class="check-row" for="workbench-review-merge">
        <input id="workbench-review-merge" type="checkbox" />
        Merge linked PR
      </label>
      <div class="actions">
        <button data-testid="workbench-review-approve" id="workbench-review-approve" type="button">Approve</button>
        <button data-testid="workbench-review-reject" id="workbench-review-reject" class="danger" type="button">Reject</button>
      </div>
      <label for="workbench-deployment-note">Deployment note</label>
      <textarea id="workbench-deployment-note"></textarea>
      <div class="actions">
        <button data-testid="workbench-deployment-approve" id="workbench-deployment-approve" type="button">Approve Deploy</button>
        <button data-testid="workbench-deployment-reject" id="workbench-deployment-reject" class="danger" type="button">Reject Deploy</button>
      </div>
      <div id="workbench-handoff-package" class="summary">
        <div class="empty">No handoff package loaded.</div>
      </div>
      <div id="workbench-handoff-followups" class="summary">
        <div class="empty">No follow-up lineage loaded.</div>
      </div>
      <div id="workbench-review-summary" class="summary">
        <div class="empty">No review summary loaded.</div>
      </div>
      <h2>VAS Review</h2>
      <div class="actions">
        <button data-testid="workbench-load-vas-artifacts" id="workbench-load-vas-artifacts" class="secondary" type="button">Load VAS Artifacts</button>
        <button data-testid="workbench-load-vas-case-runs" id="workbench-load-vas-case-runs" class="secondary" type="button">Load VAS Runs</button>
        <button data-testid="workbench-load-vas-review-package" id="workbench-load-vas-review-package" class="secondary" type="button">Load Review Package</button>
        <button data-testid="workbench-claim-vas-case" id="workbench-claim-vas-case" class="secondary" type="button">Claim VAS Case</button>
        <button data-testid="workbench-release-vas-case" id="workbench-release-vas-case" class="secondary" type="button">Release Claim</button>
        <button data-testid="workbench-start-vas-review-run" id="workbench-start-vas-review-run" class="secondary" type="button">Start VAS Review</button>
      </div>
      <label class="check-row" for="workbench-sync-vas-review-issue-comments">
        <input id="workbench-sync-vas-review-issue-comments" type="checkbox" />
        Seed issue comments
      </label>
      <label for="workbench-vas-review-run-reviewer">VAS review-run reviewer commands, one per line</label>
      <textarea id="workbench-vas-review-run-reviewer"></textarea>
      <div id="workbench-vas-artifacts" class="summary">
        <div class="empty">No VAS artifacts loaded.</div>
      </div>
      <div id="workbench-vas-case-runs" class="list">
        <div class="empty">No VAS case runs loaded.</div>
      </div>
      <div id="workbench-vas-review-package" class="summary">
        <div class="empty">No VAS review package loaded.</div>
      </div>
      <label for="workbench-vas-review-decision">VAS review decision</label>
      <select id="workbench-vas-review-decision">
        <option value="approved">Approve</option>
        <option value="changes_requested">Request Changes</option>
      </select>
      <label for="workbench-vas-review-note">VAS review note</label>
      <input id="workbench-vas-review-note" autocomplete="off" />
      <label for="workbench-vas-review-corrections">VAS corrections, one per line</label>
      <textarea id="workbench-vas-review-corrections"></textarea>
      <label for="workbench-vas-review-learnings">VAS learnings, one per line</label>
      <textarea id="workbench-vas-review-learnings"></textarea>
      <div class="actions">
        <button data-testid="workbench-review-vas-case" id="workbench-review-vas-case" class="secondary" type="button">Review VAS Case</button>
      </div>
      <div id="workbench-replay" class="list">
        <div class="empty">No replay loaded.</div>
      </div>
      <h2>Brain</h2>
      <div class="actions">
        <button data-testid="workbench-load-brain-signals" id="workbench-load-brain-signals" class="secondary" type="button">Load Brain</button>
      </div>
      <div data-testid="workbench-brain-feed" id="workbench-brain-feed" class="list">
        <div class="empty">No brain signals loaded.</div>
      </div>
      <h2>Audit</h2>
      <div data-testid="workbench-audit" id="workbench-audit" class="list">
        <div class="empty">No audit events loaded.</div>
      </div>
    </section>
    <section>
      <h2>Files</h2>
      <label for="workbench-path">Path</label>
      <input id="workbench-path" autocomplete="off" />
      <div class="actions">
        <button id="workbench-load-files" class="secondary" type="button">Load Files</button>
        <button data-testid="workbench-new-file" id="workbench-new-file" class="secondary" type="button">New File</button>
        <button id="workbench-save-file" type="button" disabled>Save File</button>
        <button data-testid="workbench-move-file" id="workbench-move-file" class="secondary" type="button" disabled>Move File</button>
        <button data-testid="workbench-delete-file" id="workbench-delete-file" class="danger" type="button" disabled>Delete File</button>
        <button data-testid="workbench-reload-file" id="workbench-reload-file" class="secondary" type="button" disabled>Reload Latest</button>
      </div>
      <div id="workbench-files" class="list">
        <div class="empty">No files loaded.</div>
      </div>
      <div id="workbench-file-editor" class="file-editor" hidden>
        <div id="workbench-file-name" class="meta"></div>
        <textarea id="workbench-file-content"></textarea>
      </div>
      <div id="workbench-file-error" class="error" role="status"></div>
    </section>
    <section>
      <h2>Command</h2>
      <label for="workbench-command">Workspace command</label>
      <textarea id="workbench-command">pwd && ls</textarea>
      <div class="actions">
        <button data-testid="workbench-run-command" id="workbench-run-command" type="button">Run Command</button>
        <button id="workbench-load-commands" class="secondary" type="button">Load History</button>
      </div>
      <div id="workbench-commands" class="list">
        <div class="empty">No commands loaded.</div>
      </div>
      <pre id="workbench-command-output" class="output" hidden></pre>
      <h2>Terminal</h2>
      <label for="workbench-session-command">Session command</label>
      <input id="workbench-session-command" value="sh" autocomplete="off" />
      <div class="actions">
        <button data-testid="workbench-start-session" id="workbench-start-session" class="secondary" type="button">Start Session</button>
        <button id="workbench-load-sessions" class="secondary" type="button">Load Sessions</button>
        <button id="workbench-stop-session" class="danger" type="button" disabled>Stop Session</button>
      </div>
      <div id="workbench-sessions" class="list">
        <div class="empty">No sessions loaded.</div>
      </div>
      <label for="workbench-session-input">Session input</label>
      <textarea id="workbench-session-input">pwd
</textarea>
      <div class="actions">
        <button data-testid="workbench-send-session-input" id="workbench-send-session-input" class="secondary" type="button" disabled>Send Input</button>
      </div>
      <pre id="workbench-terminal-output" class="output" hidden></pre>
      <div id="workbench-command-error" class="error" role="status"></div>
    </section>
  </main>
  <script>
    const params = new URLSearchParams(window.location.search);
    const tenant = params.get("tenant") || "alice";
    const project = params.get("project") || "default";
    const runId = params.get("runId") || "";
    const token = params.get("token") || "";
    scrubTokenFromBrowserUrl();
    const state = { run: null, harnessStatus: null, workspaceInfo: null, workspaceDiff: null, replay: null, reviewSummary: null, handoffPackage: null, handoffFollowups: null, evidenceRefresh: {}, vasArtifacts: null, vasReviewPackage: null, vasCaseRuns: [], vasCaseRunSource: null, currentPath: "", currentFile: null, commands: [], currentCommandId: "", presence: [], presenceFocus: "", auditEvents: [], brainSignals: [], runEvents: [], sessionEvents: [], clientId: workbenchClientId(), accessActor: "", accessRole: "viewer", accessAuthenticated: false, currentSessionId: "", runStream: null, terminalStream: null, auditStream: null };
    const replayRefreshAuditTypes = new Set([
      "queued_run_recovered",
      "queued_run_recovery_failed",
      "run_started",
      "run_finished",
      "run_comment_added",
      "run_issue_comments_synced",
      "run_resumed",
      "run_cancelled",
      "run_abandoned",
      "run_review_claimed",
      "review_decided",
      "deployment_decided",
      "stale_run_auto_abandoned",
      "workspace_pull_request_created"
    ]);
    const reviewSummaryRefreshAuditTypes = new Set([
      "queued_run_recovered",
      "queued_run_recovery_failed",
      "run_started",
      "run_finished",
      "run_comment_added",
      "run_issue_comments_synced",
      "run_resumed",
      "run_cancelled",
      "run_abandoned",
      "run_review_claimed",
      "review_decided",
      "deployment_decided",
      "stale_run_auto_abandoned",
      "workspace_file_written",
      "workspace_file_moved",
      "workspace_file_deleted",
      "workspace_file_conflicted",
      "workspace_commit_created",
      "workspace_pull_request_created"
    ]);
    const handoffPackageRefreshAuditTypes = new Set([
      "run_handoff_followup_created",
      "run_handoff_followup_denied",
      ...reviewSummaryRefreshAuditTypes,
      "workspace_command_ran",
      "workspace_session_started",
      "workspace_session_input_sent",
      "workspace_session_stopped",
      "workspace_session_exited"
    ]);

    const contextEl = document.getElementById("workbench-context");
    const openDashboardLink = document.getElementById("open-dashboard");
    const runEl = document.getElementById("workbench-run");
    const runCommentInput = document.getElementById("workbench-run-comment");
    const runCommentPauseInput = document.getElementById("workbench-run-comment-pause");
    const sendRunCommentButton = document.getElementById("workbench-send-run-comment");
    const syncIssueCommentsButton = document.getElementById("workbench-sync-issue-comments");
    const cancelRunButton = document.getElementById("workbench-cancel-run");
    const abandonRunButton = document.getElementById("workbench-abandon-run");
    const resumeRunButton = document.getElementById("workbench-resume-run");
    const workspaceEl = document.getElementById("workbench-workspace");
    const diffEl = document.getElementById("workbench-diff");
    const commitMessageInput = document.getElementById("workbench-commit-message");
    const commitWorkspaceButton = document.getElementById("workbench-commit-workspace");
    const prIssueInput = document.getElementById("workbench-pr-issue");
    const prBranchInput = document.getElementById("workbench-pr-branch");
    const prBaseInput = document.getElementById("workbench-pr-base");
    const prReviewInput = document.getElementById("workbench-pr-review");
    const prDeploymentInput = document.getElementById("workbench-pr-deployment");
    const handoffPrButton = document.getElementById("workbench-handoff-pr");
    const requestPrEscalationButton = document.getElementById("workbench-pr-escalation");
    const presenceLabelInput = document.getElementById("workbench-presence-label");
    const presenceEl = document.getElementById("workbench-presence");
    const handoffPackageEl = document.getElementById("workbench-handoff-package");
    const handoffFollowupsEl = document.getElementById("workbench-handoff-followups");
    const handoffFollowupGoalInput = document.getElementById("workbench-handoff-followup-goal");
    const handoffFollowupNoteInput = document.getElementById("workbench-handoff-followup-note");
    const loadHandoffFollowupsButton = document.getElementById("workbench-load-handoff-followups");
    const startHandoffFollowupButton = document.getElementById("workbench-start-handoff-followup");
    const reviewSummaryEl = document.getElementById("workbench-review-summary");
    const claimReviewButton = document.getElementById("workbench-claim-review");
    const releaseReviewClaimButton = document.getElementById("workbench-release-review-claim");
    const reviewNoteInput = document.getElementById("workbench-review-note");
    const reviewContractObjectiveInput = document.getElementById("workbench-review-contract-objective");
    const reviewContractConstraintsInput = document.getElementById("workbench-review-contract-constraints");
    const reviewContractSuccessInput = document.getElementById("workbench-review-contract-success");
    const reviewMergeInput = document.getElementById("workbench-review-merge");
    const reviewApproveButton = document.getElementById("workbench-review-approve");
    const reviewRejectButton = document.getElementById("workbench-review-reject");
    const deploymentNoteInput = document.getElementById("workbench-deployment-note");
    const deploymentApproveButton = document.getElementById("workbench-deployment-approve");
    const deploymentRejectButton = document.getElementById("workbench-deployment-reject");
    const vasArtifactsEl = document.getElementById("workbench-vas-artifacts");
    const vasCaseRunsEl = document.getElementById("workbench-vas-case-runs");
    const vasReviewPackageEl = document.getElementById("workbench-vas-review-package");
    const vasReviewDecisionInput = document.getElementById("workbench-vas-review-decision");
    const vasReviewNoteInput = document.getElementById("workbench-vas-review-note");
    const vasReviewCorrectionsInput = document.getElementById("workbench-vas-review-corrections");
    const vasReviewLearningsInput = document.getElementById("workbench-vas-review-learnings");
    const loadVasArtifactsButton = document.getElementById("workbench-load-vas-artifacts");
    const loadVasCaseRunsButton = document.getElementById("workbench-load-vas-case-runs");
    const loadVasReviewPackageButton = document.getElementById("workbench-load-vas-review-package");
    const claimVasCaseButton = document.getElementById("workbench-claim-vas-case");
    const releaseVasCaseButton = document.getElementById("workbench-release-vas-case");
    const startVasReviewRunButton = document.getElementById("workbench-start-vas-review-run");
    const syncVasReviewIssueCommentsInput = document.getElementById("workbench-sync-vas-review-issue-comments");
    const vasReviewRunReviewerInput = document.getElementById("workbench-vas-review-run-reviewer");
    const reviewVasCaseButton = document.getElementById("workbench-review-vas-case");
    const replayEl = document.getElementById("workbench-replay");
    const brainFeedEl = document.getElementById("workbench-brain-feed");
    const auditEl = document.getElementById("workbench-audit");
    const filesEl = document.getElementById("workbench-files");
    const pathInput = document.getElementById("workbench-path");
    const fileEditor = document.getElementById("workbench-file-editor");
    const fileName = document.getElementById("workbench-file-name");
    const fileContent = document.getElementById("workbench-file-content");
    const newFileButton = document.getElementById("workbench-new-file");
    const saveFileButton = document.getElementById("workbench-save-file");
    const moveFileButton = document.getElementById("workbench-move-file");
    const deleteFileButton = document.getElementById("workbench-delete-file");
    const reloadFileButton = document.getElementById("workbench-reload-file");
    const fileError = document.getElementById("workbench-file-error");
    const commandInput = document.getElementById("workbench-command");
    const commandOutput = document.getElementById("workbench-command-output");
    const commandList = document.getElementById("workbench-commands");
    const runCommandButton = document.getElementById("workbench-run-command");
    const sessionCommandInput = document.getElementById("workbench-session-command");
    const sessionList = document.getElementById("workbench-sessions");
    const sessionInput = document.getElementById("workbench-session-input");
    const startSessionButton = document.getElementById("workbench-start-session");
    const sendSessionInputButton = document.getElementById("workbench-send-session-input");
    const stopSessionButton = document.getElementById("workbench-stop-session");
    const terminalOutput = document.getElementById("workbench-terminal-output");
    const commandError = document.getElementById("workbench-command-error");

    document.getElementById("workbench-refresh").addEventListener("click", refreshWorkbench);
    sendRunCommentButton.addEventListener("click", sendRunComment);
    syncIssueCommentsButton.addEventListener("click", syncIssueComments);
    cancelRunButton.addEventListener("click", cancelRun);
    abandonRunButton.addEventListener("click", abandonRun);
    resumeRunButton.addEventListener("click", resumeRun);
    document.getElementById("workbench-load-replay").addEventListener("click", loadReplay);
    document.getElementById("workbench-load-brain-signals").addEventListener("click", loadBrainSignals);
    document.getElementById("workbench-load-review-summary").addEventListener("click", loadReviewSummary);
    document.getElementById("workbench-load-handoff-package").addEventListener("click", loadHandoffPackage);
    loadHandoffFollowupsButton.addEventListener("click", loadHandoffFollowups);
    startHandoffFollowupButton.addEventListener("click", startHandoffFollowup);
    claimReviewButton.addEventListener("click", claimReview);
    releaseReviewClaimButton.addEventListener("click", releaseReview);
    reviewApproveButton.addEventListener("click", () => reviewRun("approved"));
    reviewRejectButton.addEventListener("click", () => reviewRun("rejected"));
    deploymentApproveButton.addEventListener("click", () => deploymentRun("approved"));
    deploymentRejectButton.addEventListener("click", () => deploymentRun("rejected"));
    loadVasArtifactsButton.addEventListener("click", loadVasArtifacts);
    loadVasCaseRunsButton.addEventListener("click", loadVasCaseRuns);
    loadVasReviewPackageButton.addEventListener("click", loadVasReviewPackage);
    claimVasCaseButton.addEventListener("click", claimVasCase);
    releaseVasCaseButton.addEventListener("click", releaseVasCase);
    startVasReviewRunButton.addEventListener("click", startVasReviewRun);
    reviewVasCaseButton.addEventListener("click", reviewVasCase);
    document.getElementById("workbench-load-diff").addEventListener("click", loadDiff);
    commitWorkspaceButton.addEventListener("click", commitWorkspaceChanges);
    handoffPrButton.addEventListener("click", handoffPullRequest);
    requestPrEscalationButton.addEventListener("click", requestPrEscalation);
    document.getElementById("workbench-load-files").addEventListener("click", () => loadFiles(pathInput.value.trim()));
    newFileButton.addEventListener("click", newFile);
    document.getElementById("workbench-save-file").addEventListener("click", saveFile);
    moveFileButton.addEventListener("click", moveFile);
    deleteFileButton.addEventListener("click", deleteFile);
    document.getElementById("workbench-reload-file").addEventListener("click", reloadLatestFile);
    runCommandButton.addEventListener("click", runCommand);
    document.getElementById("workbench-load-commands").addEventListener("click", loadCommands);
    startSessionButton.addEventListener("click", startSession);
    document.getElementById("workbench-load-sessions").addEventListener("click", loadSessions);
    document.getElementById("workbench-stop-session").addEventListener("click", stopSession);
    document.getElementById("workbench-send-session-input").addEventListener("click", sendSessionInput);

    renderWorkbenchContext();
    openDashboardLink.href = dashboardUrl();
    presenceLabelInput.value = state.clientId;
    presenceLabelInput.addEventListener("change", () => {
      void heartbeatPresence();
    });
    applyAccessControls();
    setInterval(heartbeatPresence, 15000);
    refreshWorkbench();

    function queryString(extra = {}) {
      const query = new URLSearchParams();
      if (project !== "default") query.set("project", project);
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
      }
      const text = query.toString();
      return text ? "?" + text : "";
    }

    function authHeaders(base = {}) {
      return token ? { ...base, authorization: \`Bearer \${token}\` } : base;
    }

    function issueCommentsSyncSummary(data) {
      const parts = [\`Synced \${data.synced || 0} issue comments\`];
      if (data.pauseRequested) parts.push(\`pause requested \${data.pauseRequested}\`);
      if (data.resumeRequested || data.resumed || data.resumeDenied) {
        parts.push(\`resume \${data.resumed || 0}/\${data.resumeRequested || 0}\`);
      }
      if (data.resumeDenied) parts.push(\`resume denied \${data.resumeDenied}\`);
      if (data.deploymentRequested || data.deployed || data.deploymentDenied) {
        parts.push(\`deployment \${data.deployed || 0}/\${data.deploymentRequested || 0}\`);
      }
      if (data.deploymentDenied) parts.push(\`deployment denied \${data.deploymentDenied}\`);
      if (data.vasReviewRequested || data.vasReviewed || data.vasReviewDenied) {
        parts.push(\`VAS review \${data.vasReviewed || 0}/\${data.vasReviewRequested || 0}\`);
      }
      if (data.vasReviewDenied) parts.push(\`VAS review denied \${data.vasReviewDenied}\`);
      if (data.vasRunRequested || data.vasRunStarted || data.vasRunDenied) {
        parts.push(\`VAS runs \${data.vasRunStarted || 0}/\${data.vasRunRequested || 0}\`);
      }
      if (data.vasRunDenied) parts.push(\`VAS run denied \${data.vasRunDenied}\`);
      if (Array.isArray(data.startedVasRuns) && data.startedVasRuns.length) {
        parts.push(\`started \${data.startedVasRuns.map((run) => run.runId).filter(Boolean).join(", ")}\`);
      }
      if (data.handoffFollowupRequested || data.handoffFollowupStarted || data.handoffFollowupDenied) {
        parts.push(\`handoff follow-up \${data.handoffFollowupStarted || 0}/\${data.handoffFollowupRequested || 0}\`);
      }
      if (data.handoffFollowupDenied) parts.push(\`handoff follow-up denied \${data.handoffFollowupDenied}\`);
      if (Array.isArray(data.startedHandoffFollowups) && data.startedHandoffFollowups.length) {
        parts.push(\`started follow-up \${data.startedHandoffFollowups.map((run) => {
          const commentId = run.controlPlaneCommentId || run.giteaCommentId;
          return [
            run.runId,
            run.controlPlaneProvider ? "controlPlane=" + run.controlPlaneProvider : "",
            commentId ? "comment=" + commentId : ""
          ].filter(Boolean).join(" ");
        }).filter(Boolean).join(", ")}\`);
      }
      return parts.join("; ");
    }

    function renderWorkbenchContext() {
      const controlPlane = state.harnessStatus && state.harnessStatus.server
        ? state.harnessStatus.server.controlPlane
        : null;
      contextEl.innerHTML = [
        \`<span>tenant \${escapeHtml(tenant)}</span>\`,
        \`<span>project \${escapeHtml(project)}</span>\`,
        \`<span>run \${escapeHtml(runId || "missing")}</span>\`,
        state.accessActor ? \`<span>actor \${escapeHtml(state.accessActor)}</span>\` : "",
        state.accessRole ? \`<span>role \${escapeHtml(state.accessRole)}</span>\` : "",
        controlPlane ? \`<span>\${escapeHtml(formatControlPlane(controlPlane))}</span>\` : "",
        \`<span>auth \${state.accessAuthenticated ? "key" : "open"}</span>\`
      ].filter(Boolean).join("");
    }

    function formatControlPlane(controlPlane) {
      if (!controlPlane || typeof controlPlane !== "object") return "";
      const provider = controlPlane.provider || "unknown";
      const boundary = Array.isArray(controlPlane.boundary) ? controlPlane.boundary : [];
      return \`control plane \${provider}\${boundary.length ? ": " + boundary.join(", ") : ""}\`;
    }

    function accessUrl() { return \`/tenants/\${tenant}/access\`; }
    function statusUrl() { return \`/tenants/\${tenant}/status\`; }
    function runUrl() { return \`/tenants/\${tenant}/runs/\${runId}\${queryString()}\`; }
    function runEventsUrl(stream = false, after = 0) {
      const streamAuth = stream && token ? { token } : {};
      return \`/tenants/\${tenant}/runs/\${runId}/events\${stream ? "/stream" : ""}\${queryString({ after, ...streamAuth })}\`;
    }
    function workspaceUrl() { return \`/tenants/\${tenant}/runs/\${runId}/workspace\${queryString()}\`; }
    function diffUrl() { return \`/tenants/\${tenant}/runs/\${runId}/diff\${queryString()}\`; }
    function commitUrl() { return \`/tenants/\${tenant}/runs/\${runId}/commits\${queryString()}\`; }
    function pullRequestUrl() { return \`/tenants/\${tenant}/runs/\${runId}/pull-requests\${queryString()}\`; }
    function reviewSummaryUrl() { return \`/tenants/\${tenant}/runs/\${runId}/review-summary\${queryString()}\`; }
    function reviewUrl() { return \`/tenants/\${tenant}/runs/\${runId}/review\${queryString()}\`; }
    function reviewClaimUrl() { return \`/tenants/\${tenant}/runs/\${runId}/review-claim\${queryString()}\`; }
    function deploymentUrl() { return \`/tenants/\${tenant}/runs/\${runId}/deployment\${queryString()}\`; }
    function handoffPackageUrl() { return \`/tenants/\${tenant}/runs/\${runId}/handoff-package\${queryString()}\`; }
    function handoffFollowupUrl() { return \`/tenants/\${tenant}/runs/\${runId}/handoff-runs\${queryString()}\`; }
    function replayUrl() { return \`/tenants/\${tenant}/runs/\${runId}/replay\${queryString()}\`; }
    function commentsUrl() { return \`/tenants/\${tenant}/runs/\${runId}/comments\${queryString()}\`; }
    function issueCommentsSyncUrl() { return \`/tenants/\${tenant}/runs/\${runId}/issue-comments/sync\${queryString()}\`; }
    function cancelUrl() { return \`/tenants/\${tenant}/runs/\${runId}/cancel\${queryString()}\`; }
    function abandonUrl() { return \`/tenants/\${tenant}/runs/\${runId}/abandon\${queryString()}\`; }
    function resumeUrl() { return \`/tenants/\${tenant}/runs/\${runId}/resume\${queryString()}\`; }
    function escalationsUrl() { return \`/tenants/\${tenant}/policy/escalations\`; }
    function vasCaseArtifactsUrl(caseId) { return \`/tenants/\${tenant}/projects/\${project}/vas/cases/\${encodeURIComponent(caseId)}/artifacts\`; }
    function vasCaseRunsUrl(caseId) { return \`/tenants/\${tenant}/projects/\${project}/vas/cases/\${encodeURIComponent(caseId)}/runs\`; }
    function vasCaseReviewPackageUrl(caseId) { return \`/tenants/\${tenant}/projects/\${project}/vas/cases/\${encodeURIComponent(caseId)}/review-package\`; }
    function vasCaseClaimUrl(caseId) { return \`/tenants/\${tenant}/projects/\${project}/vas/cases/\${encodeURIComponent(caseId)}/claim\`; }
    function vasCaseReviewUrl(caseId) { return \`/tenants/\${tenant}/projects/\${project}/vas/cases/\${encodeURIComponent(caseId)}/review\`; }
    function vasCaseReviewRunsUrl(caseId) { return \`/tenants/\${tenant}/projects/\${project}/vas/cases/\${encodeURIComponent(caseId)}/review-runs\`; }
    function workbenchRunUrl(nextRunId) {
      const params = new URLSearchParams({ tenant, project, runId: nextRunId });
      return \`/workbench?\${params.toString()}\`;
    }
    function handoffSourcePackageUrl(metadata) {
      if (!(metadata && metadata.handoffSourceRunId)) return "";
      if (metadata.handoffSourceHandoffPackageUrl) return metadata.handoffSourceHandoffPackageUrl;
      const sourceProject = metadata.handoffSourceProject || project;
      return \`/tenants/\${tenant}/runs/\${metadata.handoffSourceRunId}/handoff-package\${queryString({ project: sourceProject })}\`;
    }
    function renderHandoffSourceLinks(metadata) {
      if (!(metadata && metadata.handoffSourceRunId)) return "";
      const sourceProject = metadata.handoffSourceProject || project;
      const params = new URLSearchParams({ tenant, project: sourceProject, runId: metadata.handoffSourceRunId });
      const packageUrl = handoffSourcePackageUrl(metadata);
      return \`
        <span>source \${escapeHtml(metadata.handoffSourceRunId)}</span>
        <a href="/workbench?\${escapeAttr(params.toString())}" target="_blank" rel="noreferrer">Source Workbench</a>
        \${packageUrl ? \`<a href="\${escapeAttr(packageUrl)}" target="_blank" rel="noreferrer">Source Package</a>\` : ""}
      \`;
    }
    function renderProjectContractStatusEvidence(metadata) {
      const contractStatus = metadata && (metadata.projectContractStatus || (metadata.metadata && metadata.metadata.projectContractStatus));
      if (!contractStatus) return "";
      if (contractStatus.ok) return '<span class="pill passed">contract ready</span>';
      const missing = Array.isArray(contractStatus.missing) && contractStatus.missing.length
        ? contractStatus.missing.join(", ")
        : "unknown";
      return \`<span class="pill failed">contract missing \${escapeHtml(missing)}</span>\`;
    }
    function dashboardUrl() {
      const params = new URLSearchParams({ tenant, project });
      if (runId) params.set("runId", runId);
      return \`/?\${params.toString()}\`;
    }
    function auditUrl(stream = false, after = 0) {
      const query = new URLSearchParams();
      query.set("project", project);
      if (after > 0) query.set("after", String(after));
      if (stream && token) query.set("token", token);
      const text = query.toString();
      return \`/tenants/\${tenant}/audit\${stream ? "/stream" : ""}\${text ? "?" + text : ""}\`;
    }
    function brainSignalsUrl() {
      return \`/tenants/\${tenant}/brain/signals\${queryString({ runId })}\`;
    }
    function presenceUrl() { return \`/tenants/\${tenant}/runs/\${runId}/presence\${queryString()}\`; }
    function filesUrl(path = "") { return \`/tenants/\${tenant}/runs/\${runId}/files\${queryString({ path })}\`; }
    function moveFileUrl() { return \`/tenants/\${tenant}/runs/\${runId}/files/move\${queryString()}\`; }
    function commandsUrl() { return \`/tenants/\${tenant}/runs/\${runId}/commands\${queryString()}\`; }
    function sessionsUrl() { return \`/tenants/\${tenant}/runs/\${runId}/sessions\${queryString()}\`; }
    function sessionActionUrl(action, stream = false, extra = {}) {
      const streamAuth = stream && token ? { token } : {};
      return \`/tenants/\${tenant}/runs/\${runId}/sessions/\${state.currentSessionId}/\${action}\${stream ? "/stream" : ""}\${queryString({ ...streamAuth, ...extra })}\`;
    }

    async function refreshWorkbench() {
      await loadTenantAccess();
      if (!runId) {
        runEl.innerHTML = '<div class="empty">Missing runId in the URL.</div>';
        return;
      }
      await loadRun();
      await loadRunEvents();
      if (shouldStreamWorkbenchRun(state.run)) startRunStream();
      else closeRunStream();
      await loadVasCaseRuns();
      await loadWorkspaceInfo();
      await heartbeatPresence();
      await loadAudit();
      await loadBrainSignals({ quiet: true });
      startAuditStream();
      await loadFiles(state.currentPath);
      await loadCommands();
      await loadSessions();
    }

    async function loadTenantAccess() {
      try {
        const response = await fetch(accessUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load tenant access");
        state.accessActor = data.actor || "";
        state.accessRole = data.role || "viewer";
        state.accessAuthenticated = Boolean(data.authenticated);
      } catch (error) {
        state.accessActor = "";
        state.accessRole = "viewer";
        state.accessAuthenticated = false;
      } finally {
        renderWorkbenchContext();
        applyAccessControls();
      }
    }

    async function loadStatus(options = {}) {
      const quiet = options.quiet === true;
      try {
        const response = await fetch(statusUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load status");
        state.harnessStatus = data;
        renderWorkbenchContext();
      } catch (error) {
        if (!quiet) {
          state.harnessStatus = null;
          renderWorkbenchContext();
        }
      }
    }

    function queuedRunDetailForRun(run) {
      const status = state.harnessStatus || {};
      const resources = status.resources || {};
      const queuedRuns = Array.isArray(resources.queuedRunDetails) ? resources.queuedRunDetails : [];
      const runTenant = run.metadata && run.metadata.tenant ? run.metadata.tenant : tenant;
      const runProject = run.metadata && run.metadata.project ? run.metadata.project : project;
      return queuedRuns.find((entry) =>
        entry.runId === run.runId &&
        (!entry.tenant || entry.tenant === runTenant) &&
        (!entry.project || entry.project === runProject)
      );
    }

    function formatQueuedRunBlocker(run) {
      const blockedBy = Array.isArray(run.blockedByRunIds) && run.blockedByRunIds.length ? " by " + run.blockedByRunIds.join(", ") : "";
      const position = formatQueuedRunPosition(run);
      if (run.blockedReason === "tenant_active_run_limit") return \`\${position}tenant run cap \${run.limit || "full"}\${blockedBy}\`;
      if (run.blockedReason === "project_active_workspace") return \`\${position}project active\${blockedBy}\`;
      if (run.blockedReason === "persisted_running_run") return \`\${position}persisted running run\${blockedBy}\`;
      return \`\${position}ready\`;
    }

    function formatQueuedRunPosition(run) {
      const parts = [];
      if (run.projectQueuePosition !== undefined) parts.push("project #" + run.projectQueuePosition);
      if (run.tenantQueuePosition !== undefined) parts.push("tenant #" + run.tenantQueuePosition);
      return parts.length ? parts.join(" / ") + ": " : "";
    }

    function formatRunQueueMeta(run) {
      const detail = queuedRunDetailForRun(run);
      if (detail && detail.blockedReason) return "blocked: " + formatQueuedRunBlocker(detail);
      if (detail) return "queue: " + formatQueuedRunBlocker(detail);
      if (run.status === "queued" && run.queuedAt) return "queued " + run.queuedAt;
      if (run.status === "queued") return "queued";
      return "";
    }

    async function loadRun(options = {}) {
      const quiet = options.quiet === true;
      await loadStatus({ quiet });
      let data;
      try {
        const response = await fetch(runUrl(), { headers: authHeaders() });
        data = await response.json();
        if (!response.ok && quiet) return;
        if (!response.ok) throw new Error(data.error || "failed to load run");
      } catch (error) {
        if (quiet) return;
        throw error;
      }
      state.run = data;
      abandonRunButton.hidden = true;
      const queueMeta = formatRunQueueMeta(data);
      prefillPullRequestFields(data.metadata || {});
      runEl.innerHTML = \`
        <div class="summary-grid">
          <span class="pill \${escapeAttr(data.status)}">\${escapeHtml(data.status)}</span>
          \${queueMeta ? \`<span class="pill queued">\${escapeHtml(queueMeta)}</span>\` : ""}
          <span>\${escapeHtml(data.goal || "")}</span>
          \${data.requester ? \`<span>by \${escapeHtml(formatRunRequester(data.requester))}</span>\` : ""}
          <span>\${escapeHtml(data.startedAt || "")}</span>
          \${data.metadata && data.metadata.repo ? \`<span>\${escapeHtml(data.metadata.repo)}</span>\` : ""}
          \${data.metadata && data.metadata.branch ? \`<span>\${escapeHtml(data.metadata.branch)}</span>\` : ""}
          \${data.metadata && data.metadata.baseBranch ? \`<span>base \${escapeHtml(data.metadata.baseBranch)}</span>\` : ""}
          \${data.review && data.review.status ? \`<span>review \${escapeHtml(data.review.status)}</span>\` : ""}
          \${data.review && data.review.claim ? \`<span>claimed by \${escapeHtml(formatRunReviewClaim(data.review.claim))}</span>\` : ""}
          \${data.metadata && data.metadata.issueUrl ? \`<a href="\${escapeAttr(data.metadata.issueUrl)}" target="_blank" rel="noreferrer">Issue</a>\` : data.metadata && data.metadata.issue ? \`<span>\${escapeHtml(data.metadata.issue)}</span>\` : ""}
          \${data.metadata && data.metadata.pullRequestUrl ? \`<a href="\${escapeAttr(data.metadata.pullRequestUrl)}" target="_blank" rel="noreferrer">PR</a>\` : ""}
          \${renderHandoffSourceLinks(data.metadata)}
          \${renderProjectContractStatusEvidence(data.metadata)}
        </div>
        \${runErrorSummary(data)}
      \`;
    }

    async function loadRunEvents() {
      const response = await fetch(runEventsUrl(), { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) return;
      state.runEvents = Array.isArray(data) ? data : [];
    }

    function startRunStream() {
      if (!runId) return;
      closeRunStream();
      const after = workbenchRunEventsAfter();
      const stream = new EventSource(runEventsUrl(true, after));
      state.runStream = stream;
      stream.addEventListener("harness_event", async (message) => {
        const event = JSON.parse(message.data);
        if (isLoadedWorkbenchRunEvent(event)) return;
        state.runEvents = state.runEvents.concat(event);
        try {
          await loadReplay({ quiet: true });
          if (event.type === "finish") {
            stream.close();
            if (state.runStream === stream) state.runStream = null;
            await loadRun({ quiet: true });
            if (state.reviewSummary && !state.handoffPackage) await loadReviewSummary({ quiet: true, updatePresence: false });
            if (state.handoffPackage) await loadHandoffPackage({ quiet: true, updatePresence: false });
          }
        } catch (error) {
          commandError.textContent = error.message || "failed to refresh run replay";
        }
      });
    }

    function closeRunStream() {
      if (state.runStream) state.runStream.close();
      state.runStream = null;
    }

    function shouldStreamWorkbenchRun(run) {
      return Boolean(run && (run.status === "running" || run.status === "queued"));
    }

    function workbenchRunEventsAfter() {
      return state.runEvents.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
    }

    function isLoadedWorkbenchRunEvent(event) {
      const seq = Number(event && event.seq);
      return Number.isFinite(seq) && state.runEvents.some((entry) => Number(entry.seq) === seq);
    }

    async function sendRunComment() {
      if (!runId) return;
      if (!runCommentInput.value.trim()) {
        commandError.textContent = "comment is required";
        return;
      }
      commandError.textContent = "";
      sendRunCommentButton.disabled = true;
      const response = await fetch(commentsUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: runCommentInput.value.trim(), pause: runCommentPauseInput.checked, clientId: state.clientId })
      });
      const data = await response.json();
      if (!response.ok) {
        commandError.textContent = data.error || "failed to send run comment";
        applyAccessControls();
        return;
      }
      runCommentInput.value = "";
      runCommentPauseInput.checked = false;
      await loadRun();
      await loadReplay();
      await loadAudit();
      commandError.textContent = "Comment sent";
      applyAccessControls();
    }

    async function syncIssueComments() {
      if (!runId) return;
      commandError.textContent = "";
      syncIssueCommentsButton.disabled = true;
      const response = await fetch(issueCommentsSyncUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ clientId: state.clientId })
      });
      const data = await response.json();
      if (!response.ok) {
        commandError.textContent = data.error || "failed to sync issue comments";
        applyAccessControls();
        return;
      }
      await loadRun();
      await loadReplay();
      await loadAudit();
      commandError.textContent = issueCommentsSyncSummary(data);
      applyAccessControls();
    }

    async function cancelRun() {
      if (!runId || !isCancellableRun(state.run)) return;
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      commandError.textContent = "";
      cancelRunButton.disabled = true;
      const response = await fetch(cancelUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ reason: "cancelled from workbench", clientId: state.clientId })
      });
      const data = await response.json();
      if (!response.ok) {
        const message = data.error || "failed to cancel run";
        commandError.textContent = message;
        if (/not running in this server process/.test(message)) {
          abandonRunButton.hidden = false;
          commandError.textContent = "Cancel unavailable in this server process. Use abandon to mark the orphaned run cancelled.";
        }
        applyAccessControls();
        return;
      }
      state.run = data;
      await loadRun();
      await loadReplay();
      await loadAudit();
      commandError.textContent = "Run cancelled";
      applyAccessControls();
    }

    async function abandonRun() {
      if (!runId || !state.run || state.run.status !== "running") return;
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      commandError.textContent = "";
      abandonRunButton.disabled = true;
      const response = await fetch(abandonUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ reason: "abandoned from workbench", clientId: state.clientId })
      });
      const data = await response.json();
      if (!response.ok) {
        commandError.textContent = data.error || "failed to abandon run";
        applyAccessControls();
        return;
      }
      state.run = data;
      abandonRunButton.hidden = true;
      await loadRun();
      await loadReplay();
      await loadAudit();
      commandError.textContent = "Run abandoned";
      applyAccessControls();
    }

    async function resumeRun() {
      if (!runId || !state.run || state.run.status !== "paused") return;
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      commandError.textContent = "";
      resumeRunButton.disabled = true;
      const response = await fetch(resumeUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ clientId: state.clientId })
      });
      const data = await response.json();
      if (!response.ok) {
        commandError.textContent = data.error || "failed to resume run";
        applyAccessControls();
        return;
      }
      await loadRun();
      await loadReplay();
      await loadAudit();
      commandError.textContent = "Run resumed";
      applyAccessControls();
    }

    function prefillPullRequestFields(metadata) {
      if (!prIssueInput.value.trim() && metadata.issue) prIssueInput.value = metadata.issue;
      if (!prBranchInput.value.trim() && metadata.branch) prBranchInput.value = metadata.branch;
      if (!prBaseInput.value.trim() && metadata.baseBranch) prBaseInput.value = metadata.baseBranch;
    }

    async function loadWorkspaceInfo() {
      const response = await fetch(workspaceUrl(), { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) {
        workspaceEl.innerHTML = \`<div class="empty">\${escapeHtml(data.error || "Workspace context unavailable.")}</div>\`;
        return;
      }
      state.workspaceInfo = data;
      prefillPullRequestFields(data);
      renderWorkspaceInfo(data);
    }

    async function loadDiff(options = {}) {
      const quiet = options.quiet === true;
      const shouldRender = !quiet || !diffEl.hidden;
      if (!quiet) commandError.textContent = "";
      if (!quiet) {
        diffEl.hidden = true;
        diffEl.textContent = "";
      }
      const response = await fetch(diffUrl(), { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) {
        if (quiet) return;
        commandError.textContent = data.error || "failed to load diff";
        return;
      }
      state.workspaceDiff = data;
      if (shouldRender) {
        diffEl.hidden = false;
        diffEl.textContent = formatCommandResult(data);
      }
    }

    async function commitWorkspaceChanges() {
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const message = commitMessageInput.value.trim();
      if (!message) {
        commandError.textContent = "commit message is required";
        return;
      }
      commandError.textContent = "";
      commitWorkspaceButton.disabled = true;
      const response = await fetch(commitUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message, clientId: state.clientId })
      });
      const data = await response.json();
      if (!response.ok) {
        commandError.textContent = data.error || "failed to commit workspace changes";
        applyAccessControls();
        return;
      }
      await loadAudit();
      await loadDiff();
      commandError.textContent = data.commit ? "Committed " + data.commit : "Committed workspace changes";
      applyAccessControls();
    }

    async function handoffPullRequest() {
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const body = {
        clientId: state.clientId,
        reviewRequired: prReviewInput.checked,
        deploymentRequired: prDeploymentInput.checked
      };
      const issue = prIssueInput.value.trim();
      const branch = prBranchInput.value.trim();
      const baseBranch = prBaseInput.value.trim();
      if (issue) body.issue = issue;
      if (branch) body.branch = branch;
      if (baseBranch) body.baseBranch = baseBranch;
      commandError.textContent = "";
      handoffPrButton.disabled = true;
      const response = await fetch(pullRequestUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) {
        commandError.textContent = data.error || "failed to hand off pull request";
        applyAccessControls();
        return;
      }
      await loadRun();
      await loadAudit();
      await loadDiff();
      commandError.textContent = data.pullRequestUrl ? "PR " + data.pullRequestUrl : "PR handoff created";
      applyAccessControls();
    }

    async function requestPrEscalation() {
      commandError.textContent = "";
      requestPrEscalationButton.disabled = true;
      const response = await fetch(escalationsUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          requestedTools: ["git.pr"],
          reason: prEscalationReason(),
          clientId: state.clientId
        })
      });
      const data = await response.json();
      if (!response.ok) {
        commandError.textContent = data.error || "git.pr policy escalation request failed";
        applyAccessControls();
        return;
      }
      await loadAudit();
      commandError.textContent = data.id ? "Requested git.pr escalation " + data.id : "Requested git.pr escalation";
      applyAccessControls();
    }

    function prEscalationReason() {
      return "need workspace PR handoff for run " + runId;
    }

    async function loadReviewSummary(options = {}) {
      const quiet = options.quiet === true;
      const previousCheckpoint = state.reviewSummary && state.reviewSummary.checkpoint;
      if (!quiet) commandError.textContent = "";
      try {
        const response = await fetch(reviewSummaryUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) {
          if (quiet) {
            rememberEvidenceRefreshFailure("reviewSummary", "review summary", state.reviewSummary && state.reviewSummary.checkpoint, new Error(data.error || "failed to load review summary"));
            renderReviewSummary();
            return;
          }
          state.reviewSummary = null;
          reviewSummaryEl.innerHTML = \`<div class="empty">\${escapeHtml(data.error || "failed to load review summary")}</div>\`;
          return;
        }
        state.reviewSummary = data;
        rememberEvidenceRefresh("reviewSummary", "review summary", previousCheckpoint, data.checkpoint, quiet);
        state.workspaceDiff = data.diff || null;
        if (options.updatePresence !== false) {
          state.presenceFocus = "review-summary";
          void heartbeatPresence();
        }
        renderReviewSummary(data);
        if (state.workspaceDiff) {
          diffEl.hidden = false;
          diffEl.textContent = formatCommandResult(state.workspaceDiff);
        }
      } catch (error) {
        if (quiet) {
          rememberEvidenceRefreshFailure("reviewSummary", "review summary", state.reviewSummary && state.reviewSummary.checkpoint, error);
          renderReviewSummary();
          return;
        }
        state.reviewSummary = null;
        reviewSummaryEl.innerHTML = \`<div class="empty">\${escapeHtml(error.message || "failed to load review summary")}</div>\`;
      }
    }

    async function loadHandoffPackage(options = {}) {
      const quiet = options.quiet === true;
      const previousCheckpoint = state.handoffPackage && state.handoffPackage.checkpoint;
      if (!quiet) commandError.textContent = "";
      try {
        const response = await fetch(handoffPackageUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) {
          if (quiet) {
            rememberEvidenceRefreshFailure("handoffPackage", "handoff package", state.handoffPackage && state.handoffPackage.checkpoint, new Error(data.error || "failed to load handoff package"));
            renderHandoffPackage();
            return;
          }
          state.handoffPackage = null;
          handoffPackageEl.innerHTML = \`<div class="empty">\${escapeHtml(data.error || "failed to load handoff package")}</div>\`;
          return;
        }
        state.handoffPackage = data;
        rememberEvidenceRefresh("handoffPackage", "handoff package", previousCheckpoint, data.checkpoint, quiet);
        state.reviewSummary = data.reviewSummary || null;
        state.workspaceInfo = data.workspace || null;
        state.workspaceDiff = data.reviewSummary && data.reviewSummary.diff ? data.reviewSummary.diff : null;
        if (options.updatePresence !== false) {
          state.presenceFocus = "handoff-package";
          void heartbeatPresence();
        }
        renderHandoffPackage(data);
        if (state.reviewSummary) renderReviewSummary(state.reviewSummary);
        if (state.workspaceInfo) {
          prefillPullRequestFields(state.workspaceInfo);
          renderWorkspaceInfo(state.workspaceInfo);
        }
        if (state.workspaceDiff) {
          diffEl.hidden = false;
          diffEl.textContent = formatCommandResult(state.workspaceDiff);
        }
      } catch (error) {
        if (quiet) {
          rememberEvidenceRefreshFailure("handoffPackage", "handoff package", state.handoffPackage && state.handoffPackage.checkpoint, error);
          renderHandoffPackage();
          return;
        }
        state.handoffPackage = null;
        handoffPackageEl.innerHTML = \`<div class="empty">\${escapeHtml(error.message || "failed to load handoff package")}</div>\`;
      }
    }

    async function loadHandoffFollowups(options = {}) {
      const quiet = options.quiet === true;
      const previousCheckpoint = state.handoffFollowups && state.handoffFollowups.checkpoint;
      if (!quiet) commandError.textContent = "";
      try {
        const response = await fetch(handoffFollowupUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) {
          if (quiet) {
            rememberEvidenceRefreshFailure("handoffFollowups", "follow-up lineage", state.handoffFollowups && state.handoffFollowups.checkpoint, new Error(data.error || "failed to load follow-up lineage"));
            renderHandoffFollowups();
            return;
          }
          state.handoffFollowups = null;
          handoffFollowupsEl.innerHTML = \`<div class="empty">\${escapeHtml(data.error || "failed to load follow-up lineage")}</div>\`;
          return;
        }
        state.handoffFollowups = data;
        rememberEvidenceRefresh("handoffFollowups", "follow-up lineage", previousCheckpoint, data.checkpoint, quiet);
        if (options.updatePresence !== false) {
          state.presenceFocus = "handoff-followups";
          void heartbeatPresence();
        }
        renderHandoffFollowups(data);
      } catch (error) {
        if (quiet) {
          rememberEvidenceRefreshFailure("handoffFollowups", "follow-up lineage", state.handoffFollowups && state.handoffFollowups.checkpoint, error);
          renderHandoffFollowups();
          return;
        }
        state.handoffFollowups = null;
        handoffFollowupsEl.innerHTML = \`<div class="empty">\${escapeHtml(error.message || "failed to load follow-up lineage")}</div>\`;
      }
    }

    async function startHandoffFollowup() {
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      commandError.textContent = "";
      startHandoffFollowupButton.disabled = true;
      if (!await ensureHandoffPackageCheckpoint()) return;
      const response = await fetch(handoffFollowupUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(handoffFollowupBodyFromForm())
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409 && data.currentCheckpoint) {
          await loadHandoffPackage({ quiet: true, updatePresence: false });
          commandError.textContent = "handoff checkpoint changed; refreshed package, retry follow-up";
          applyAccessControls();
          return;
        }
        commandError.textContent = data.error || "follow-up run creation failed";
        applyAccessControls();
        return;
      }
      commandError.textContent = "Started follow-up " + data.runId;
      window.location.href = workbenchRunUrl(data.runId);
    }

    async function ensureHandoffPackageCheckpoint() {
      if (checkpointVersion(state.handoffPackage && state.handoffPackage.checkpoint)) return true;
      await loadHandoffPackage({ quiet: true, updatePresence: false });
      if (checkpointVersion(state.handoffPackage && state.handoffPackage.checkpoint)) return true;
      commandError.textContent = "load handoff package before starting follow-up";
      applyAccessControls();
      return false;
    }

    function handoffFollowupBodyFromForm() {
      const body = { queue: true, clientId: state.clientId };
      body.sourceCheckpointVersion = checkpointVersion(state.handoffPackage && state.handoffPackage.checkpoint);
      if (!body.sourceCheckpointVersion) delete body.sourceCheckpointVersion;
      if (handoffFollowupGoalInput.value.trim()) body.goal = handoffFollowupGoalInput.value.trim();
      if (handoffFollowupNoteInput.value.trim()) body.note = handoffFollowupNoteInput.value.trim();
      return body;
    }

    async function claimReview() {
      await updateReviewClaim("claim");
    }

    async function releaseReview() {
      await updateReviewClaim("release");
    }

    async function updateReviewClaim(action) {
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const hadReviewSummary = Boolean(state.reviewSummary);
      const hadHandoffPackage = Boolean(state.handoffPackage);
      commandError.textContent = "";
      claimReviewButton.disabled = true;
      releaseReviewClaimButton.disabled = true;
      const response = await fetch(reviewClaimUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ action, clientId: state.clientId })
      });
      const data = await response.json();
      if (!response.ok) {
        commandError.textContent = data.error || "review claim update failed";
        applyAccessControls();
        return;
      }
      state.run = data;
      await loadRun();
      await loadAudit();
      if (hadReviewSummary) await loadReviewSummary();
      if (hadHandoffPackage) await loadHandoffPackage();
      commandError.textContent = action === "release" ? "review claim released" : "review claimed";
      applyAccessControls();
    }

    async function reviewRun(decision) {
      if (!state.run || state.run.status !== "review_required") return;
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const hadReviewSummary = Boolean(state.reviewSummary);
      const hadHandoffPackage = Boolean(state.handoffPackage);
      commandError.textContent = "";
      reviewApproveButton.disabled = true;
      reviewRejectButton.disabled = true;
      const body = {
        decision,
        note: reviewNoteInput.value.trim(),
        merge: decision === "approved" && reviewMergeInput.checked,
        clientId: state.clientId
      };
      const contractPatch = reviewContractPatchFromForm();
      if (contractPatch) body.contractPatch = contractPatch;
      const response = await fetch(reviewUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) {
        commandError.textContent = data.error || "review decision failed";
        applyAccessControls();
        return;
      }
      state.run = data;
      reviewNoteInput.value = "";
      clearReviewContractPatchForm();
      reviewMergeInput.checked = false;
      await loadRun();
      await loadAudit();
      if (hadReviewSummary) await loadReviewSummary();
      if (hadHandoffPackage) await loadHandoffPackage();
      commandError.textContent = decision === "approved" ? "review approved" : "review rejected";
      applyAccessControls();
    }

    function reviewContractPatchFromForm() {
      const patch = {};
      const objective = reviewContractObjectiveInput.value.trim();
      const constraints = lines(reviewContractConstraintsInput.value);
      const successCriteria = lines(reviewContractSuccessInput.value);
      if (objective) patch.objective = objective;
      if (constraints.length) patch.constraints = constraints;
      if (successCriteria.length) patch.successCriteria = successCriteria;
      return Object.keys(patch).length ? patch : null;
    }

    function clearReviewContractPatchForm() {
      reviewContractObjectiveInput.value = "";
      reviewContractConstraintsInput.value = "";
      reviewContractSuccessInput.value = "";
    }

    async function deploymentRun(decision) {
      if (!state.run || state.run.status !== "deployment_required") return;
      if (!canAdmin()) {
        commandError.textContent = "admin access is required";
        applyAccessControls();
        return;
      }
      const hadReviewSummary = Boolean(state.reviewSummary);
      const hadHandoffPackage = Boolean(state.handoffPackage);
      commandError.textContent = "";
      deploymentApproveButton.disabled = true;
      deploymentRejectButton.disabled = true;
      const response = await fetch(deploymentUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          decision,
          note: deploymentNoteInput.value.trim(),
          clientId: state.clientId
        })
      });
      const data = await response.json();
      if (!response.ok) {
        commandError.textContent = data.error || "deployment decision failed";
        applyAccessControls();
        return;
      }
      state.run = data;
      deploymentNoteInput.value = "";
      await loadRun();
      await loadAudit();
      if (hadReviewSummary) await loadReviewSummary();
      if (hadHandoffPackage) await loadHandoffPackage();
      commandError.textContent = decision === "approved" ? "deployment approved" : "deployment rejected";
      applyAccessControls();
    }

    async function loadVasArtifacts(options = {}) {
      const quiet = options.quiet === true;
      if (!quiet) commandError.textContent = "";
      const caseId = vasCaseId();
      if (!caseId) {
        if (quiet) return;
        state.vasArtifacts = null;
        vasArtifactsEl.innerHTML = '<div class="empty">This run is not linked to a VAS Lite case.</div>';
        applyAccessControls();
        return;
      }
      const response = await fetch(vasCaseArtifactsUrl(caseId), { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) {
        if (quiet) return;
        state.vasArtifacts = null;
        vasArtifactsEl.innerHTML = \`<div class="empty">\${escapeHtml(data.error || "failed to load VAS artifacts")}</div>\`;
        applyAccessControls();
        return;
      }
      state.vasArtifacts = data;
      if (options.updatePresence !== false) focusVasCase(caseId);
      renderVasArtifacts(data);
      if (options.updatePresence !== false) applyVasReviewDraft(data.reviewDraft);
      applyAccessControls();
    }

    async function loadVasCaseRuns(options = {}) {
      const quiet = options.quiet === true;
      if (!quiet) commandError.textContent = "";
      const caseId = vasCaseId();
      if (!caseId) {
        if (quiet) return;
        state.vasCaseRuns = [];
        state.vasCaseRunSource = null;
        vasCaseRunsEl.innerHTML = '<div class="empty">This run is not linked to a VAS Lite case.</div>';
        applyAccessControls();
        return;
      }
      const response = await fetch(vasCaseRunsUrl(caseId), { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) {
        if (quiet) return;
        state.vasCaseRuns = [];
        state.vasCaseRunSource = null;
        vasCaseRunsEl.innerHTML = \`<div class="empty">\${escapeHtml(data.error || "failed to load VAS case runs")}</div>\`;
        applyAccessControls();
        return;
      }
      state.vasCaseRunSource = data;
      state.vasCaseRuns = Array.isArray(data.runs) ? data.runs : [];
      if (options.updatePresence !== false) focusVasCase(caseId);
      renderVasCaseRuns();
      applyAccessControls();
    }

    async function loadVasReviewPackage(options = {}) {
      const quiet = options.quiet === true;
      if (!quiet) commandError.textContent = "";
      const caseId = vasCaseId();
      if (!caseId) {
        if (quiet) return;
        state.vasReviewPackage = null;
        vasReviewPackageEl.innerHTML = '<div class="empty">This run is not linked to a VAS Lite case.</div>';
        applyAccessControls();
        return;
      }
      const response = await fetch(vasCaseReviewPackageUrl(caseId), { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) {
        if (quiet) return;
        state.vasReviewPackage = null;
        vasReviewPackageEl.innerHTML = \`<div class="empty">\${escapeHtml(data.error || "failed to load VAS review package")}</div>\`;
        applyAccessControls();
        return;
      }
      state.vasReviewPackage = data;
      if (options.updatePresence !== false) focusVasCase(caseId);
      renderVasReviewPackage(data);
      applyAccessControls();
    }

    async function claimVasCase() {
      await updateVasCaseClaim("claim");
    }

    async function releaseVasCase() {
      await updateVasCaseClaim("release");
    }

    async function updateVasCaseClaim(action) {
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const caseId = vasCaseId();
      if (!caseId) {
        commandError.textContent = "this run is not linked to a VAS Lite case";
        return;
      }
      commandError.textContent = "";
      claimVasCaseButton.disabled = true;
      releaseVasCaseButton.disabled = true;
      const response = await fetch(vasCaseClaimUrl(caseId), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ action, clientId: state.clientId })
      });
      const data = await response.json();
      if (!response.ok) {
        commandError.textContent = data.error || "VAS case claim update failed";
        applyAccessControls();
        return;
      }
      await loadAudit();
      await loadVasCaseRuns();
      await loadVasReviewPackage();
      commandError.textContent = action === "release" ? "VAS case claim released" : "VAS case claimed";
      applyAccessControls();
    }

    async function reviewVasCase() {
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const caseId = vasCaseId();
      if (!caseId) {
        commandError.textContent = "this run is not linked to a VAS Lite case";
        return;
      }
      commandError.textContent = "";
      reviewVasCaseButton.disabled = true;
      const response = await fetch(vasCaseReviewUrl(caseId), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(workbenchVasReviewPayload())
      });
      const data = await response.json();
      if (!response.ok) {
        commandError.textContent = data.error || "VAS case review failed";
        applyAccessControls();
        return;
      }
      await loadVasArtifacts();
      await loadVasCaseRuns();
      await loadVasReviewPackage();
      await loadAudit();
      commandError.textContent = "VAS case reviewed";
      applyAccessControls();
    }

    async function startVasReviewRun() {
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const caseId = vasCaseId();
      if (!caseId) {
        commandError.textContent = "this run is not linked to a VAS Lite case";
        return;
      }
      commandError.textContent = "";
      startVasReviewRunButton.disabled = true;
      const metadata = state.run && state.run.metadata ? state.run.metadata : {};
      const response = await fetch(vasCaseReviewRunsUrl(caseId), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          clientId: state.clientId,
          repo: metadata.repo,
          branch: metadata.branch,
          baseBranch: metadata.baseBranch,
          issue: metadata.issue,
          model: metadata.model,
          modelProtocol: metadata.modelProtocol,
          syncIssueComments: syncVasReviewIssueCommentsInput.checked,
          reviewer: lines(vasReviewRunReviewerInput.value),
          pullRequest: Boolean(metadata.pullRequestIndex || metadata.pullRequestUrl),
          reviewRequired: Boolean(state.run && state.run.review && state.run.review.required),
          deploymentRequired: Boolean(state.run && state.run.deployment && state.run.deployment.required)
        })
      });
      const data = await response.json();
      if (!response.ok) {
        commandError.textContent = data.error || "VAS review run creation failed";
        applyAccessControls();
        return;
      }
      await loadAudit();
      await loadVasCaseRuns();
      await loadVasReviewPackage();
      const nextWorkbenchUrl = workbenchRunUrl(data.runId);
      commandError.innerHTML = \`Started VAS review run \${escapeHtml(data.runId)} <a href="\${escapeAttr(nextWorkbenchUrl)}" target="_blank" rel="noreferrer">Open Workbench</a>\`;
      applyAccessControls();
    }

    function workbenchVasReviewPayload() {
      const body = { decision: vasReviewDecisionInput.value, runId, clientId: state.clientId };
      const note = vasReviewNoteInput.value.trim();
      const corrections = lines(vasReviewCorrectionsInput.value);
      const learnings = lines(vasReviewLearningsInput.value);
      if (note) body.note = note;
      if (corrections.length) body.corrections = corrections;
      if (learnings.length) body.learnings = learnings;
      return body;
    }

    function vasCaseId() {
      const metadata = state.run && state.run.metadata ? state.run.metadata : {};
      if (metadata.runPreset !== "vas-lite-review") return "";
      const input = metadata.runPresetInput || {};
      return input.caseId || "bootstrap";
    }

    function focusVasCase(caseId) {
      state.presenceFocus = "vas:" + caseId;
      void heartbeatPresence();
    }

    function renderVasArtifacts(artifacts = state.vasArtifacts) {
      if (!artifacts) {
        vasArtifactsEl.innerHTML = '<div class="empty">No VAS artifacts loaded.</div>';
        return;
      }
      vasArtifactsEl.innerHTML = \`
        <div class="summary-grid">
          <span>case \${escapeHtml(artifacts.caseId || "unknown")}</span>
          <span>\${escapeHtml(artifacts.contextPath || "context missing")}</span>
          <span>\${escapeHtml(artifacts.reportPath || "report missing")}</span>
          <span>\${escapeHtml(artifacts.reviewDraftPath || "review draft missing")}</span>
        </div>
        <h3>Review Draft</h3>
        <pre>\${escapeHtml(artifacts.reviewDraft ? JSON.stringify(artifacts.reviewDraft, null, 2) : "No review draft artifact.")}</pre>
        <h3>Report</h3>
        <pre>\${escapeHtml(artifacts.report || "No report artifact.")}</pre>
      \`;
    }

    function renderVasReviewPackage(data = state.vasReviewPackage) {
      if (!data) {
        vasReviewPackageEl.innerHTML = '<div class="empty">No VAS review package loaded.</div>';
        return;
      }
      const caseSummary = data.case || {};
      const links = data.links || {};
      vasReviewPackageEl.innerHTML = \`
        <div class="summary-grid">
          <span>case \${escapeHtml(data.caseId || "unknown")}</span>
          \${caseSummary.status ? \`<span class="pill \${escapeAttr(caseSummary.status)}">\${escapeHtml(caseSummary.status)}</span>\` : ""}
          \${caseSummary.reviewCount !== undefined ? \`<span>\${escapeHtml(caseSummary.reviewCount)} reviews</span>\` : ""}
          \${caseSummary.correctionCount !== undefined ? \`<span>\${escapeHtml(caseSummary.correctionCount)} corrections</span>\` : ""}
          \${caseSummary.learningCount !== undefined ? \`<span>\${escapeHtml(caseSummary.learningCount)} learnings</span>\` : ""}
          \${caseSummary.claim ? \`<span class="pill queued">claimed by \${escapeHtml(formatVasCaseClaim(caseSummary.claim))}</span>\` : ""}
          \${Array.isArray(data.runs) ? \`<span>\${escapeHtml(data.runs.length)} runs</span>\` : ""}
          \${Array.isArray(data.issueCommentSeeds) ? \`<span>\${escapeHtml(data.issueCommentSeeds.length)} issue seeds</span>\` : ""}
          \${Array.isArray(data.auditTrail) ? \`<span>\${escapeHtml(data.auditTrail.length)} audit events</span>\` : ""}
          \${links.artifacts ? \`<a href="\${escapeAttr(links.artifacts)}" target="_blank" rel="noreferrer">Artifacts</a>\` : ""}
          \${links.runs ? \`<a href="\${escapeAttr(links.runs)}" target="_blank" rel="noreferrer">Runs</a>\` : ""}
          \${links.reviewRuns ? \`<a href="\${escapeAttr(links.reviewRuns)}" target="_blank" rel="noreferrer">Review Runs</a>\` : ""}
        </div>
        <pre>\${escapeHtml(JSON.stringify(data, null, 2))}</pre>
      \`;
    }

    function formatVasCaseClaim(claim) {
      if (!claim || typeof claim !== "object") return "unknown";
      const owner = claim.actor || claim.clientId || "unknown";
      return claim.claimedAt ? \`\${owner} \${claim.claimedAt}\` : owner;
    }

    function formatRunReviewClaim(claim) {
      if (!claim || typeof claim !== "object") return "unknown";
      const owner = claim.actor || claim.clientId || "unknown";
      return claim.claimedAt ? \`\${owner} \${claim.claimedAt}\` : owner;
    }

    function formatRunRequester(requester) {
      if (!requester || typeof requester !== "object") return "unknown";
      return [
        requester.actor || requester.clientId || "unknown",
        requester.role,
        requester.actor && requester.clientId ? requester.clientId : ""
      ].filter(Boolean).join(" ");
    }

    function renderVasCaseRuns(runs = state.vasCaseRuns) {
      const sourceHtml = renderVasCaseRunSource(state.vasCaseRunSource);
      if (!Array.isArray(runs) || !runs.length) {
        vasCaseRunsEl.innerHTML = sourceHtml + '<div class="empty">No VAS case runs loaded.</div>';
        return;
      }
      vasCaseRunsEl.innerHTML = sourceHtml + runs.map((run) => \`
        <div class="item">
          <span class="item-title">\${escapeHtml(run.goal || run.runId)}</span>
          <span class="meta">
            <span class="pill \${escapeAttr(run.status || "unknown")}">\${escapeHtml(run.status || "unknown")}</span>
            <span class="pill \${escapeAttr(run.reviewDecision || run.reviewStatus || "unreviewed")}">\${escapeHtml(run.reviewDecision || run.reviewStatus || "unreviewed")}</span>
            \${run.failureKind ? \`<span class="pill failed" title="\${escapeAttr(formatVasRunFailure(run))}">failure \${escapeHtml(run.failureKind)}</span>\` : ""}
            \${run.reviewGateStatus ? \`<span class="pill \${escapeAttr(run.reviewGateStatus)}">review \${escapeHtml(run.reviewGateStatus)}</span>\` : ""}
            \${run.deploymentGateStatus ? \`<span class="pill \${escapeAttr(run.deploymentGateStatus)}">deployment \${escapeHtml(run.deploymentGateStatus)}</span>\` : ""}
            \${run.contextWritten ? \`<span class="pill passed" title="\${escapeAttr(run.contextPath || "")}">context</span>\` : ""}
            \${run.reportWritten ? \`<span class="pill passed" title="\${escapeAttr(run.reportPath || "")}">report</span>\` : ""}
            \${run.reviewDraftWritten ? \`<span class="pill passed" title="\${escapeAttr(run.reviewDraftPath || "")}">draft</span>\` : ""}
            <span>\${escapeHtml(run.runId || "")}</span>
            \${run.agentMode ? \`<span>\${escapeHtml(run.agentMode)}</span>\` : ""}
            \${run.startedAt ? \`<span>\${escapeHtml(run.startedAt)}</span>\` : ""}
            \${run.reviewedAt ? \`<span>\${escapeHtml(run.reviewedAt)}</span>\` : ""}
            \${run.repo ? \`<span>\${escapeHtml(run.repo)}</span>\` : ""}
            \${run.branch ? \`<span>\${escapeHtml(run.branch)}</span>\` : ""}
            \${run.baseBranch ? \`<span>base \${escapeHtml(run.baseBranch)}</span>\` : ""}
            \${run.issueUrl ? \`<a href="\${escapeAttr(run.issueUrl)}" target="_blank" rel="noreferrer">Issue</a>\` : run.issue ? \`<span>\${escapeHtml(run.issue)}</span>\` : ""}
            \${run.pullRequestUrl ? \`<a href="\${escapeAttr(run.pullRequestUrl)}" target="_blank" rel="noreferrer">PR</a>\` : ""}
            \${run.summaryUrl ? \`<a href="\${escapeAttr(run.summaryUrl)}" target="_blank" rel="noreferrer">Summary</a>\` : ""}
            \${run.reviewSummaryUrl ? \`<a href="\${escapeAttr(run.reviewSummaryUrl)}" target="_blank" rel="noreferrer">Review</a>\` : ""}
            \${run.handoffPackageUrl ? \`<a href="\${escapeAttr(run.handoffPackageUrl)}" target="_blank" rel="noreferrer">Package</a>\` : ""}
            \${run.runId ? \`<a href="\${escapeAttr(workbenchRunUrl(run.runId))}" target="_blank" rel="noreferrer">Workbench</a>\` : ""}
          </span>
        </div>
      \`).join("");
    }

    function formatVasRunFailure(run) {
      const error = run.error || {};
      return [
        run.failureKind ? "failureKind=" + run.failureKind : "",
        run.reviewerFocus ? "focus=" + run.reviewerFocus : "",
        error.message ? "error=" + error.message : "",
        error.phase ? "phase=" + error.phase : "",
        error.kind ? "kind=" + error.kind : "",
        error.details ? "details=" + JSON.stringify(error.details) : ""
      ].filter(Boolean).join(" / ");
    }

    function renderVasCaseRunSource(source) {
      if (!source || typeof source !== "object") return "";
      const parts = [
        source.caseId ? \`<span>case \${escapeHtml(source.caseId)}</span>\` : "",
        source.repo ? \`<span>\${escapeHtml(source.repo)}</span>\` : "",
        source.branch ? \`<span>\${escapeHtml(source.branch)}</span>\` : "",
        source.baseBranch ? \`<span>base \${escapeHtml(source.baseBranch)}</span>\` : "",
        source.issue ? \`<span>\${escapeHtml(source.issue)}</span>\` : "",
        source.sourceDefaultFields && source.sourceDefaultFields.length ? \`<span class="pill" title="\${escapeAttr(formatVasCaseRunSourceDefaultFields(source.sourceDefaultFields))}">project defaults</span>\` : ""
      ].filter(Boolean).join("");
      return parts ? \`<div class="summary-grid">\${parts}</div>\` : "";
    }

    function formatVasCaseRunSourceDefaultFields(sourceDefaultFields) {
      if (!Array.isArray(sourceDefaultFields) || !sourceDefaultFields.length) return "";
      return "from project defaults: " + sourceDefaultFields.join(", ");
    }

    function applyVasReviewDraft(draft) {
      if (!draft || typeof draft !== "object") return;
      if (!vasReviewNoteInput.value.trim() && typeof draft.note === "string") {
        vasReviewNoteInput.value = draft.note;
      }
      if (!vasReviewCorrectionsInput.value.trim() && Array.isArray(draft.corrections)) {
        vasReviewCorrectionsInput.value = draft.corrections.filter((item) => typeof item === "string" && item.trim()).join("\\n");
      }
      if (!vasReviewLearningsInput.value.trim() && Array.isArray(draft.learnings)) {
        vasReviewLearningsInput.value = draft.learnings.filter((item) => typeof item === "string" && item.trim()).join("\\n");
      }
    }

    function renderWorkspaceInfo(data) {
      const executorKind = data.executor && data.executor.kind ? data.executor.kind : data.route || "workspace";
      const executorTarget = data.executor && data.executor.remoteCwd
        ? data.executor.remoteCwd
        : data.executor && data.executor.containerCwd
          ? data.executor.containerCwd
          : data.cwd || "";
      workspaceEl.innerHTML = \`
        <div class="summary-grid">
          <span class="pill">\${escapeHtml(executorKind)}</span>
          <span>\${escapeHtml(data.route || "run")}</span>
          \${executorTarget ? \`<span>\${escapeHtml(executorTarget)}</span>\` : ""}
          \${data.branch ? \`<span>\${escapeHtml(data.branch)}</span>\` : ""}
          \${data.issue ? \`<span>\${escapeHtml(data.issue)}</span>\` : ""}
          \${data.executor && data.executor.ideUrl ? \`<a href="\${escapeAttr(data.executor.ideUrl)}" target="_blank" rel="noreferrer">Open IDE</a>\` : ""}
          \${data.executor && data.executor.previewUrl ? \`<a href="\${escapeAttr(data.executor.previewUrl)}" target="_blank" rel="noreferrer">Open Preview</a>\` : ""}
        </div>
        <pre>\${escapeHtml(formatWorkspaceInfo(data))}</pre>
      \`;
    }

    function formatWorkspaceInfo(data) {
      return [
        data.route ? "route=" + data.route : "",
        data.cwd ? "cwd=" + data.cwd : "",
        data.repo ? "repo=" + data.repo : "",
        data.branch ? "branch=" + data.branch : "",
        data.baseBranch ? "baseBranch=" + data.baseBranch : "",
        data.issue ? "issue=" + data.issue : "",
        data.executor && data.executor.kind ? "executor=" + data.executor.kind : "",
        data.executor && data.executor.workspace ? "workspace=" + data.executor.workspace : "",
        data.executor && data.executor.remoteCwd ? "remoteCwd=" + data.executor.remoteCwd : "",
        data.executor && data.executor.ideUrl ? "ideUrl=" + data.executor.ideUrl : "",
        data.executor && data.executor.previewUrl ? "previewUrl=" + data.executor.previewUrl : "",
        data.executor && data.executor.containerCwd ? "containerCwd=" + data.executor.containerCwd : "",
        data.executor && data.executor.image ? "image=" + data.executor.image : "",
        data.executor && data.executor.network ? "network=" + data.executor.network : "",
        data.workspaceBytes !== undefined ? "workspaceBytes=" + data.workspaceBytes : "",
        data.workspaceByteLimit !== undefined ? "workspaceByteLimit=" + data.workspaceByteLimit : "",
        data.executorLimits ? "limits=" + JSON.stringify(data.executorLimits) : "",
        data.executorTemplateParameters ? "templateParameters=" + JSON.stringify(data.executorTemplateParameters) : ""
      ].filter(Boolean).join("\\n") || "workspace context unavailable";
    }

    function runErrorSummary(run) {
      if (!(run.error && run.error.message)) return "";
      const details = runErrorDetails(run.error);
      return \`
        <div class="error-summary">
          <strong>\${escapeHtml(run.error.message)}</strong>
          \${details ? \`<span>\${details}</span>\` : ""}
        </div>
      \`;
    }

    function runErrorDetails(error) {
      return [
        error.phase ? \`phase \${escapeHtml(error.phase)}\` : "",
        error.iteration !== undefined ? \`iteration \${escapeHtml(error.iteration)}\` : "",
        error.kind ? \`kind \${escapeHtml(error.kind)}\` : "",
        ...runErrorDetailParts(error.details)
      ].filter(Boolean).join(" / ");
    }

    function runErrorDetailParts(details) {
      if (!details || typeof details !== "object" || Array.isArray(details)) return [];
      return Object.entries(details).flatMap(([key, value]) => {
        if (isSensitiveDiagnosticKey(key)) return [];
        const detailValue = runErrorDetailValue(value);
        const detailKey = boundedDiagnosticText(key, 40).replace(/\\s+/g, "_");
        return detailKey && detailValue ? [\`\${escapeHtml(detailKey)}=\${escapeHtml(detailValue)}\`] : [];
      });
    }

    function runErrorDetailValue(value) {
      if (typeof value === "string") return boundedDiagnosticText(value, 160);
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return "";
    }

    function boundedDiagnosticText(value, maxLength) {
      const text = String(value).replace(/\\s+/g, " ").trim();
      return text.length > maxLength ? text.slice(0, maxLength - 3) + "..." : text;
    }

    function isSensitiveDiagnosticKey(key) {
      const normalized = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
      return /(token|secret|password|authorization|cookie|apikey|accesskey|privatekey)/.test(normalized);
    }

    async function heartbeatPresence() {
      if (!runId) return;
      const response = await fetch(presenceUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ clientId: state.clientId, label: presenceLabelInput.value.trim() || state.clientId, focus: presenceFocus() })
      });
      if (response.ok) {
        const entry = await response.json();
        if (entry.actor) state.accessActor = entry.actor;
        if (entry.role) state.accessRole = entry.role;
        renderWorkbenchContext();
        applyAccessControls();
        await loadPresence();
      }
    }

    async function loadPresence() {
      const response = await fetch(presenceUrl(), { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) return;
      state.presence = Array.isArray(data) ? data : [];
      presenceEl.innerHTML = state.presence.length ? state.presence.map((entry) => \`
        <div class="item">
          <span class="item-title">\${escapeHtml(entry.label || entry.clientId)}</span>
          <span class="meta">\${escapeHtml([entry.actor || entry.clientId, entry.role, entry.focus, "seen " + (entry.seenAt || "")].filter(Boolean).join(" "))}</span>
        </div>
      \`).join("") : '<div class="empty">No collaborators online.</div>';
      renderCurrentFileMeta();
    }

    function presenceFocus() {
      if (state.presenceFocus) return state.presenceFocus;
      if (state.currentFile && state.currentFile.path) return "file:" + state.currentFile.path;
      if (state.currentSessionId) return "session:" + state.currentSessionId;
      if (state.currentCommandId) return "command:" + state.currentCommandId;
      if (state.currentPath) return "dir:" + state.currentPath;
      return "run:" + runId;
    }

    async function loadReplay(options = {}) {
      const quiet = options.quiet === true;
      const previousCheckpoint = state.replay && state.replay.checkpoint;
      try {
        const response = await fetch(replayUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) {
          const message = data.error || "failed to load replay";
          if (quiet) {
            rememberEvidenceRefreshFailure("replay", "replay", state.replay && state.replay.checkpoint, new Error(message));
            renderReplay();
            return;
          }
          replayEl.innerHTML = \`<div class="empty">\${escapeHtml(message)}</div>\`;
          commandError.textContent = message;
          throw new Error(message);
        }
        state.replay = data;
        rememberEvidenceRefresh("replay", "replay", previousCheckpoint, data.checkpoint, quiet);
        renderReplay(data);
      } catch (error) {
        if (quiet) {
          rememberEvidenceRefreshFailure("replay", "replay", state.replay && state.replay.checkpoint, error);
          renderReplay();
          return;
        }
        const message = error.message || "failed to load replay";
        replayEl.innerHTML = \`<div class="empty">\${escapeHtml(message)}</div>\`;
        commandError.textContent = message;
        throw new Error(message);
      }
    }

    function renderReplay(data = state.replay) {
      if (!data) {
        replayEl.innerHTML = '<div class="empty">No replay loaded.</div>';
        return;
      }
      const replayEvidence = [
        data.checkpoint ? \`<span>checkpoint \${escapeHtml(formatCheckpointVersion(data.checkpoint))}</span>\` : "",
        renderEvidenceRefresh("replay")
      ].filter(Boolean).join("");
      const replayMeta = replayEvidence ? \`<div class="summary-grid">\${replayEvidence}</div>\` : "";
      const timeline = Array.isArray(data.timeline) ? data.timeline : [];
      replayEl.innerHTML = replayMeta + (timeline.length ? timeline.map((entry) => \`
        <div class="item">
          <span class="item-title">#\${escapeHtml(entry.seq)} \${escapeHtml(entry.title || entry.type)}</span>
          <span class="meta">\${escapeHtml(replayEntryMeta(entry))}</span>
          <pre>\${escapeHtml(replayEntryDetail(entry))}</pre>
        </div>
      \`).join("") : '<div class="empty">Replay has no entries.</div>');
    }

    function renderReviewSummary(data = state.reviewSummary) {
      if (!data) {
        reviewSummaryEl.innerHTML = '<div class="empty">No review summary loaded.</div>';
        return;
      }
      reviewSummaryEl.innerHTML = \`
        <div class="summary-grid">
          <span class="pill \${escapeAttr(data.status || "unknown")}">\${escapeHtml(data.status || "unknown")}</span>
          \${data.requester ? \`<span>by \${escapeHtml(formatRunRequester(data.requester))}</span>\` : ""}
          <span>review \${escapeHtml(data.review && data.review.status ? data.review.status : "none")}</span>
          \${data.review && data.review.claim ? \`<span>claimed by \${escapeHtml(formatRunReviewClaim(data.review.claim))}</span>\` : ""}
          \${data.review && data.review.contractPatch ? \`<span>contract patch \${escapeHtml(data.review.contractPatch.objective || "proposed")}</span>\` : ""}
          <span>deployment \${escapeHtml(data.deployment && data.deployment.status ? data.deployment.status : "none")}</span>
          <span>verification \${escapeHtml(formatGate(data.verification))}</span>
          <span>evaluation \${escapeHtml(formatGate(data.evaluation))}</span>
          <span>reviewer \${escapeHtml(formatGate(data.reviewer))}</span>
          \${data.brain ? \`<span>brain \${escapeHtml(formatBrainEvidence(data.brain))}</span>\` : ""}
          \${data.modelUsage ? \`<span>model \${escapeHtml(formatModelUsage(data.modelUsage))}</span>\` : ""}
          \${renderProjectContractStatusEvidence(data)}
          \${renderReviewVasLinks(data)}
          \${data.diff ? \`<span>diff exit \${escapeHtml(data.diff.exitCode)}</span>\` : ""}
          \${data.checkpoint ? \`<span>checkpoint \${escapeHtml(formatCheckpointVersion(data.checkpoint))}</span>\` : ""}
          \${renderEvidenceRefresh("reviewSummary")}
        </div>
        <pre>\${escapeHtml(formatReviewSummary(data))}</pre>
      \`;
    }

    function renderReviewVasLinks(data) {
      const vas = data && data.vas ? data.vas : null;
      if (!vas || !vas.caseId) return "";
      const links = vas.links || {};
      return [
        \`<span>VAS Case \${escapeHtml(vas.caseId)}</span>\`,
        links.artifacts ? \`<a href="\${escapeAttr(links.artifacts)}" target="_blank" rel="noreferrer">Artifacts</a>\` : "",
        links.runs ? \`<a href="\${escapeAttr(links.runs)}" target="_blank" rel="noreferrer">Runs</a>\` : "",
        links.reviewPackage ? \`<a href="\${escapeAttr(links.reviewPackage)}" target="_blank" rel="noreferrer">Review Package</a>\` : "",
        links.reviewRuns ? \`<a href="\${escapeAttr(links.reviewRuns)}" target="_blank" rel="noreferrer">Review Runs</a>\` : ""
      ].filter(Boolean).join("");
    }

    function renderHandoffPackage(data = state.handoffPackage) {
      if (!data) {
        handoffPackageEl.innerHTML = '<div class="empty">No handoff package loaded.</div>';
        return;
      }
      const handoff = data.handoff || {};
      const links = data.links || {};
      handoffPackageEl.innerHTML = \`
        <div class="summary-grid">
          <span class="pill \${escapeAttr(data.reviewSummary && data.reviewSummary.status ? data.reviewSummary.status : "unknown")}">\${escapeHtml(data.reviewSummary && data.reviewSummary.status ? data.reviewSummary.status : "unknown")}</span>
          \${handoff.commit ? \`<span>commit \${escapeHtml(handoff.commit)}</span>\` : ""}
          \${handoff.pullRequestUrl ? \`<a href="\${escapeAttr(handoff.pullRequestUrl)}" target="_blank" rel="noreferrer">PR</a>\` : ""}
          \${links.workbench ? \`<a href="\${escapeAttr(links.workbench)}" target="_blank" rel="noreferrer">Workbench</a>\` : ""}
          <span>commands \${escapeHtml(Array.isArray(data.commands) ? data.commands.length : 0)}</span>
          <span>sessions \${escapeHtml(Array.isArray(data.sessions) ? data.sessions.length : 0)}</span>
          <span>gates \${escapeHtml(Array.isArray(data.gateTrail) ? data.gateTrail.length : 0)}</span>
          <span>messages \${escapeHtml(Array.isArray(data.messages) ? data.messages.length : 0)}</span>
          <span>effects \${escapeHtml(Array.isArray(data.externalEffects) ? data.externalEffects.length : 0)}</span>
          <span>audit \${escapeHtml(Array.isArray(data.auditTrail) ? data.auditTrail.length : 0)}</span>
          \${renderProjectContractStatusEvidence(data.reviewSummary)}
          \${data.checkpoint ? \`<span>checkpoint \${escapeHtml(formatCheckpointVersion(data.checkpoint))}</span>\` : ""}
          \${renderEvidenceRefresh("handoffPackage")}
        </div>
        \${renderHandoffChangedFiles(data.reviewSummary && data.reviewSummary.changedFiles, data.reviewSummary && data.reviewSummary.diff)}
        \${renderHandoffCommands(data.commands)}
        \${renderHandoffSessions(data.sessions)}
        \${renderHandoffFollowupRuns(data.followupRuns)}
        <pre>\${escapeHtml(formatHandoffPackage(data))}</pre>
      \`;
      for (const item of handoffPackageEl.querySelectorAll("[data-handoff-file-path]")) {
        item.addEventListener("click", () => { void openHandoffFile(item.dataset.handoffFilePath, item.dataset.handoffFileDeleted); });
      }
      for (const item of handoffPackageEl.querySelectorAll("[data-handoff-command-id]")) {
        item.addEventListener("click", () => { void openHandoffCommand(item.dataset.handoffCommandId); });
      }
      for (const item of handoffPackageEl.querySelectorAll("[data-handoff-session-id]")) {
        item.addEventListener("click", () => { void openHandoffSession(item.dataset.handoffSessionId); });
      }
    }

    function renderHandoffFollowups(data = state.handoffFollowups) {
      if (!data) {
        handoffFollowupsEl.innerHTML = '<div class="empty">No follow-up lineage loaded.</div>';
        return;
      }
      const source = data.source || {};
      const sourceLinks = source.links || {};
      handoffFollowupsEl.innerHTML = \`
        <div class="summary-grid">
          <span>source \${escapeHtml(source.runId || data.runId || "")}</span>
          \${source.status ? \`<span class="pill \${escapeAttr(source.status)}">\${escapeHtml(source.status)}</span>\` : ""}
          \${source.goal ? \`<span>\${escapeHtml(source.goal)}</span>\` : ""}
          \${sourceLinks.workbench ? \`<a href="\${escapeAttr(sourceLinks.workbench)}" target="_blank" rel="noreferrer">Source Workbench</a>\` : ""}
          \${sourceLinks.handoffPackage ? \`<a href="\${escapeAttr(sourceLinks.handoffPackage)}" target="_blank" rel="noreferrer">Source Package</a>\` : ""}
          \${data.checkpoint ? \`<span>checkpoint \${escapeHtml(formatCheckpointVersion(data.checkpoint))}</span>\` : ""}
          \${renderEvidenceRefresh("handoffFollowups")}
        </div>
        \${renderHandoffFollowupRuns(data.followupRuns)}
        <pre>\${escapeHtml(formatHandoffFollowups(data))}</pre>
      \`;
    }

    function renderHandoffChangedFiles(changedFiles, diff) {
      const files = Array.isArray(changedFiles) && changedFiles.length ? changedFiles : parseDiffChangedFiles(diff);
      if (!files.length) return "";
      return \`<div data-testid="workbench-handoff-changed-files" class="list">\${files.map(renderHandoffChangedFile).join("")}</div>\`;
    }

    function renderHandoffChangedFile(file) {
      const status = file.status || (file.deleted ? "deleted" : "modified");
      const deleted = file.deleted === true || status === "deleted";
      return \`
        <button class="item" type="button" data-handoff-file-path="\${escapeHtml(file.path)}" data-handoff-file-deleted="\${escapeAttr(String(deleted))}">
          <span class="item-title">\${escapeHtml(file.path)}</span>
          <span class="meta">\${escapeHtml(["Open file", status, file.previousPath ? "from " + file.previousPath : ""].filter(Boolean).join(" "))}</span>
        </button>
      \`;
    }

    function parseDiffChangedFiles(diff) {
      const stdout = diff && typeof diff.stdout === "string" ? diff.stdout : "";
      const files = [];
      const byPath = new Map();
      let current = null;
      for (const line of stdout.split("\\n")) {
        const args = parseDiffGitLine(line);
        if (args) {
          const path = gitDiffPath(args[1], "b/") || gitDiffPath(args[0], "a/");
          current = path ? upsertDiffChangedFile(files, byPath, path) : null;
          continue;
        }
        if (current && line.startsWith("deleted file mode")) {
          current.deleted = true;
          current.status = "deleted";
        }
      }
      return files;
    }

    function parseDiffGitLine(line) {
      if (!line.startsWith("diff --git ")) return null;
      const args = splitDiffArgs(line.slice("diff --git ".length));
      return args.length >= 2 ? args.slice(0, 2) : null;
    }

    function splitDiffArgs(text) {
      const args = [];
      let index = 0;
      while (index < text.length) {
        while (text[index] === " ") index += 1;
        if (index >= text.length) break;
        if (text[index] === '"') {
          let end = index + 1;
          while (end < text.length) {
            if (text[end] === "\\\\" && end + 1 < text.length) {
              end += 2;
              continue;
            }
            if (text[end] === '"') break;
            end += 1;
          }
          args.push(text.slice(index, Math.min(end + 1, text.length)));
          index = end + 1;
          continue;
        }
        let end = index;
        while (end < text.length && text[end] !== " ") end += 1;
        args.push(text.slice(index, end));
        index = end;
      }
      return args;
    }

    function gitDiffPath(value, prefix) {
      const path = unquoteGitPath(value);
      if (!path || path === "/dev/null") return "";
      return path.startsWith(prefix) ? path.slice(prefix.length) : "";
    }

    function unquoteGitPath(value) {
      const text = String(value || "").trim();
      if (!text.startsWith('"')) return text;
      try {
        return JSON.parse(text);
      } catch (error) {
        return text.slice(1, -1);
      }
    }

    function upsertDiffChangedFile(files, byPath, path) {
      const existing = byPath.get(path);
      if (existing) return existing;
      const entry = { path, status: "modified", deleted: false };
      byPath.set(path, entry);
      files.push(entry);
      return entry;
    }

    async function openHandoffFile(path, deleted) {
      if (!path) return;
      const targetPath = deleted === "true" ? parentPath(path) : path;
      await loadFiles(targetPath);
    }

    function renderHandoffCommands(commands) {
      if (!Array.isArray(commands) || !commands.length) return "";
      return \`<div data-testid="workbench-handoff-commands" class="list">\${commands.map(renderHandoffCommand).join("")}</div>\`;
    }

    function renderHandoffCommand(command) {
      const commandId = command.commandId || "";
      return \`
        <button class="item" type="button" data-handoff-command-id="\${escapeAttr(commandId)}" \${commandId ? "" : "disabled"}>
          <span class="item-title">\${escapeHtml(command.command || commandId || "workspace command")}</span>
          <span class="meta">\${escapeHtml(["Open command", commandId ? "#" + commandId : "", command.exitCode !== undefined ? "exit " + command.exitCode : "", commandMeta(command), command.endedAt || ""].filter(Boolean).join(" "))}</span>
        </button>
      \`;
    }

    function renderHandoffSessions(sessions) {
      if (!Array.isArray(sessions) || !sessions.length) return "";
      return \`<div data-testid="workbench-handoff-sessions" class="list">\${sessions.map(renderHandoffSession).join("")}</div>\`;
    }

    function renderHandoffSession(session) {
      const sessionId = session.sessionId || "";
      return \`
        <button class="item" type="button" data-handoff-session-id="\${escapeAttr(sessionId)}" \${sessionId ? "" : "disabled"}>
          <span class="item-title">\${escapeHtml(session.command || sessionId || "workspace session")}</span>
          <span class="meta">\${escapeHtml(["Open session", sessionId ? "#" + sessionId : "", session.status || "", sessionMeta(session), (session.eventCount || 0) + " events"].filter(Boolean).join(" "))}</span>
        </button>
      \`;
    }

    function renderHandoffFollowupRuns(runs) {
      if (!Array.isArray(runs) || !runs.length) return "";
      return \`<div data-testid="workbench-handoff-followup-runs" class="list">\${runs.map(renderHandoffFollowupRun).join("")}</div>\`;
    }

    function renderHandoffFollowupRun(run) {
      const links = run.links || {};
      const controlPlaneProvider = run.controlPlaneProvider || "";
      const commentId = run.controlPlaneCommentId || run.giteaCommentId || "";
      const commentUrl = run.controlPlaneCommentUrl || run.giteaCommentUrl || "";
      return \`
        <div class="item">
          <span class="item-title">\${escapeHtml(run.runId || "follow-up run")}</span>
          <div class="meta">
            \${run.status ? \`<span class="pill \${escapeAttr(run.status)}">\${escapeHtml(run.status)}</span>\` : ""}
            \${run.goal ? \`<span>\${escapeHtml(run.goal)}</span>\` : ""}
            \${run.actor ? \`<span>actor \${escapeHtml(run.actor)}</span>\` : ""}
            \${run.role ? \`<span>role \${escapeHtml(run.role)}</span>\` : ""}
            \${run.clientId ? \`<span>client \${escapeHtml(run.clientId)}</span>\` : ""}
            \${controlPlaneProvider ? \`<span>control \${escapeHtml(controlPlaneProvider)}</span>\` : ""}
            \${commentId ? \`<span>comment \${escapeHtml(commentId)}</span>\` : ""}
            \${commentUrl ? \`<a href="\${escapeAttr(commentUrl)}" target="_blank" rel="noreferrer">Issue Comment</a>\` : ""}
          </div>
          <div class="actions">
            \${links.workbench ? \`<a href="\${escapeAttr(links.workbench)}" target="_blank" rel="noreferrer">Workbench</a>\` : ""}
            \${links.handoffPackage ? \`<a href="\${escapeAttr(links.handoffPackage)}" target="_blank" rel="noreferrer">Package</a>\` : ""}
          </div>
        </div>
      \`;
    }

    function checkpointVersion(checkpoint) {
      return checkpoint && checkpoint.version ? checkpoint.version : "";
    }

    function checkpointRefreshMessage(label, previousCheckpoint, nextCheckpoint) {
      const previous = checkpointVersion(previousCheckpoint);
      const next = checkpointVersion(nextCheckpoint);
      if (!previous || !next || previous === next) return "";
      return label + " refreshed " + previous + " -> " + next;
    }

    function checkpointRefreshFailureMessage(label, checkpoint, error) {
      const version = checkpointVersion(checkpoint);
      const kept = version ? "checkpoint " + version : "loaded evidence";
      const reason = error && error.message ? ": " + error.message : "";
      return label + " refresh failed; kept " + kept + reason;
    }

    function rememberEvidenceRefresh(key, label, previousCheckpoint, nextCheckpoint, quiet) {
      if (!quiet) {
        delete state.evidenceRefresh[key];
        return;
      }
      const message = checkpointRefreshMessage(label, previousCheckpoint, nextCheckpoint);
      if (message) state.evidenceRefresh[key] = message;
      else delete state.evidenceRefresh[key];
    }

    function rememberEvidenceRefreshFailure(key, label, checkpoint, error) {
      state.evidenceRefresh[key] = checkpointRefreshFailureMessage(label, checkpoint, error);
    }

    function renderEvidenceRefresh(key) {
      const message = state.evidenceRefresh[key];
      return message ? \`<span>\${escapeHtml(message)}</span>\` : "";
    }

    function formatCheckpointVersion(checkpoint) {
      return checkpointVersion(checkpoint) || "unknown";
    }

    function formatHandoffFollowups(data) {
      const source = data.source || {};
      const sourceLinks = source.links || {};
      const followupRuns = Array.isArray(data.followupRuns)
        ? data.followupRuns.map(formatHandoffFollowupRun).join("\\n")
        : "";
      return [
        "runId=" + (data.runId || ""),
        "project=" + (data.project || ""),
        source.runId ? "sourceRun=" + source.runId : "",
        source.status ? "sourceStatus=" + source.status : "",
        source.goal ? "sourceGoal=" + source.goal : "",
        data.checkpoint ? "checkpoint=" + formatCheckpointVersion(data.checkpoint) : "",
        sourceLinks.run ? "source=" + sourceLinks.run : "",
        sourceLinks.replay ? "sourceReplay=" + sourceLinks.replay : "",
        sourceLinks.handoffPackage ? "sourceHandoffPackage=" + sourceLinks.handoffPackage : "",
        followupRuns ? "followupRuns:\\n" + followupRuns : ""
      ].filter(Boolean).join("\\n");
    }

    function formatHandoffPackage(data) {
      const handoff = data.handoff || {};
      const workspace = data.workspace || {};
      const links = data.links || {};
      const commands = Array.isArray(data.commands)
        ? data.commands.map((command) => [
          command.commandId ? "#" + command.commandId : "#",
          command.route ? "route=" + command.route : "",
          command.runId ? "run=" + command.runId : "",
          command.exitCode !== undefined ? "exit=" + command.exitCode : "exit=?",
          command.clientId ? "client=" + command.clientId : "",
          command.command || ""
        ].filter(Boolean).join(" ")).join("\\n")
        : "";
      const sessions = Array.isArray(data.sessions)
        ? data.sessions.map((session) => [
          session.sessionId ? "#" + session.sessionId : "#",
          session.route ? "route=" + session.route : "",
          session.runId ? "run=" + session.runId : "",
          session.status ? "status=" + session.status : "status=unknown",
          session.exitCode !== undefined ? "exit=" + session.exitCode : "",
          session.clientId ? "client=" + session.clientId : "",
          session.command || ""
        ].filter(Boolean).join(" ")).join("\\n")
        : "";
      const auditTrail = Array.isArray(data.auditTrail)
        ? data.auditTrail.map((event) => \`#\${event.seq} \${event.type} \${JSON.stringify(event.data || {})}\`).join("\\n")
        : "";
      const gateTrail = Array.isArray(data.gateTrail)
        ? data.gateTrail.map(formatHandoffGateTrail).join("\\n")
        : "";
      const issueCommentSeeds = Array.isArray(data.issueCommentSeeds)
        ? data.issueCommentSeeds.map(formatIssueCommentSeed).join("\\n")
        : "";
      const messages = Array.isArray(data.messages)
        ? data.messages.map(formatHandoffMessage).join("\\n")
        : "";
      const externalEffects = Array.isArray(data.externalEffects)
        ? data.externalEffects.map(formatExternalEffect).join("\\n")
        : "";
      const followupRuns = Array.isArray(data.followupRuns)
        ? data.followupRuns.map(formatHandoffFollowupRun).join("\\n")
        : "";
      return [
        "runId=" + (data.runId || ""),
        "project=" + (data.project || ""),
        "generatedAt=" + (data.generatedAt || ""),
        data.checkpoint ? "checkpoint=" + formatCheckpointVersion(data.checkpoint) : "",
        handoff.issue ? "issue=" + handoff.issue : "",
        handoff.issueUrl ? "issueUrl=" + handoff.issueUrl : "",
        handoff.branch ? "branch=" + handoff.branch : "",
        handoff.baseBranch ? "baseBranch=" + handoff.baseBranch : "",
        handoff.commit ? "commit=" + handoff.commit : "",
        handoff.pullRequestUrl ? "pullRequest=" + handoff.pullRequestUrl : "",
        handoff.reviewRequired !== undefined ? "reviewRequired=" + handoff.reviewRequired : "",
        handoff.deploymentRequired !== undefined ? "deploymentRequired=" + handoff.deploymentRequired : "",
        workspace.cwd ? "workspace=" + workspace.cwd : "",
        workspace.executor && workspace.executor.kind ? "executor=" + workspace.executor.kind : "",
        links.reviewSummary ? "reviewSummary=" + links.reviewSummary : "",
        links.replay ? "replay=" + links.replay : "",
        links.followupRuns ? "followupRuns=" + links.followupRuns : "",
        links.diff ? "diff=" + links.diff : "",
        gateTrail ? "gateTrail:\\n" + gateTrail : "",
        messages ? "messages:\\n" + messages : "",
        issueCommentSeeds ? "issueCommentSeeds:\\n" + issueCommentSeeds : "",
        externalEffects ? "externalEffects:\\n" + externalEffects : "",
        followupRuns ? "followupRuns:\\n" + followupRuns : "",
        commands ? "commands:\\n" + commands : "",
        sessions ? "sessions:\\n" + sessions : "",
        auditTrail ? "audit:\\n" + auditTrail : "",
        data.reviewSummary ? "reviewSummary:\\n" + formatReviewSummary(data.reviewSummary) : ""
      ].filter(Boolean).join("\\n");
    }

    function formatHandoffGateTrail(entry) {
      return [
        entry.seq ? "#" + entry.seq : "#",
        entry.gate || "gate",
        entry.status || "unknown",
        entry.clientId ? "client=" + entry.clientId : "",
        entry.actor ? "actor=" + entry.actor : "",
        entry.role ? "role=" + entry.role : "",
        entry.note ? "note=" + entry.note : "",
        entry.contractPatch ? "contractPatch=" + formatProjectContractInline(entry.contractPatch) : "",
      ].filter(Boolean).join(" ");
    }

    function formatHandoffMessage(entry) {
      const commentId = entry.controlPlaneCommentId || entry.giteaCommentId;
      const commentUrl = entry.controlPlaneCommentUrl || entry.giteaCommentUrl;
      return [
        entry.seq ? "#" + entry.seq : "#",
        entry.kind || "message",
        entry.source ? "source=" + entry.source : "",
        entry.actor ? "actor=" + entry.actor : "",
        entry.role ? "role=" + entry.role : "",
        entry.clientId ? "client=" + entry.clientId : "",
        entry.issue ? "issue=" + entry.issue : "",
        entry.sourceRunId ? "sourceRun=" + entry.sourceRunId : "",
        entry.sourceProject ? "sourceProject=" + entry.sourceProject : "",
        entry.sourceStatus ? "sourceStatus=" + entry.sourceStatus : "",
        entry.sourceCheckpointVersion ? "sourceCheckpoint=" + entry.sourceCheckpointVersion : "",
        entry.sourceProjectContractStatus ? "sourceContractStatus=" + formatProjectContractStatus(entry.sourceProjectContractStatus) : "",
        entry.sourceIssue ? "sourceIssue=" + entry.sourceIssue : "",
        entry.sourceBranch ? "sourceBranch=" + entry.sourceBranch : "",
        entry.sourceBaseBranch ? "sourceBase=" + entry.sourceBaseBranch : "",
        entry.sourcePullRequestUrl ? "sourcePR=" + entry.sourcePullRequestUrl : "",
        entry.sourceChangedFileCount !== undefined ? "sourceChangedFiles=" + entry.sourceChangedFileCount : "",
        entry.sourceCommandCount !== undefined ? "sourceCommands=" + entry.sourceCommandCount : "",
        entry.sourceSessionCount !== undefined ? "sourceSessions=" + entry.sourceSessionCount : "",
        entry.controlPlaneProvider ? "controlPlane=" + entry.controlPlaneProvider : "",
        commentId ? "comment=" + commentId : "",
        commentUrl ? "commentUrl=" + commentUrl : "",
        entry.syncedByActor ? "syncedBy=" + entry.syncedByActor : "",
        entry.pauseRequested ? "pause=true" : "",
        entry.resumeRequested ? "resume=true" : "",
        entry.runReviewRequested ? "review=" + (entry.runReviewDecision || "requested") : "",
        entry.runReviewContractPatch ? "contractPatch=" + formatProjectContractInline(entry.runReviewContractPatch) : "",
        entry.runReviewClaimRequested ? "claim=" + (entry.runReviewClaimAction || "requested") : "",
        entry.deploymentRequested ? "deployment=" + (entry.deploymentDecision || "requested") : "",
        entry.vasReviewRequested ? "vasReview=" + (entry.vasReviewDecision || "requested") : "",
        entry.vasRunRequested ? "vasRun=" + (entry.vasRunCaseId || "requested") : "",
        entry.vasClaimRequested ? "vasClaim=" + (entry.vasClaimAction || "requested") : "",
        entry.sourceMessageCount !== undefined ? "sourceMessages=" + entry.sourceMessageCount : "",
        entry.sourceGateCount !== undefined ? "sourceGates=" + entry.sourceGateCount : "",
        entry.sourceExternalEffectCount !== undefined ? "sourceEffects=" + entry.sourceExternalEffectCount : "",
        entry.content ? "message=" + entry.content : ""
      ].filter(Boolean).join(" ");
    }

    function formatHandoffFollowupRun(run) {
      const links = run.links || {};
      const commentId = run.controlPlaneCommentId || run.giteaCommentId;
      const commentUrl = run.controlPlaneCommentUrl || run.giteaCommentUrl;
      return [
        run.runId ? "run=" + run.runId : "",
        run.status ? "status=" + run.status : "",
        run.goal ? "goal=" + run.goal : "",
        run.createdAt ? "createdAt=" + run.createdAt : "",
        run.actor ? "actor=" + run.actor : "",
        run.role ? "role=" + run.role : "",
        run.clientId ? "client=" + run.clientId : "",
        run.sourceCheckpointVersion ? "sourceCheckpoint=" + run.sourceCheckpointVersion : "",
        run.sourceProjectContractStatus ? "sourceContractStatus=" + formatProjectContractStatus(run.sourceProjectContractStatus) : "",
        run.controlPlaneProvider ? "controlPlane=" + run.controlPlaneProvider : "",
        commentId ? "comment=" + commentId : "",
        commentUrl ? "commentUrl=" + commentUrl : "",
        links.workbench ? "workbench=" + links.workbench : "",
        links.handoffPackage ? "handoffPackage=" + links.handoffPackage : ""
      ].filter(Boolean).join(" ");
    }

    function formatExternalEffect(entry) {
      return [
        entry.seq ? "#" + entry.seq : "#",
        entry.kind || "external_effect",
        entry.clientId ? "client=" + entry.clientId : "",
        entry.requester ? "requester=" + formatRunRequester(entry.requester) : "",
        entry.issue ? "issue=" + entry.issue : "",
        entry.branch ? "branch=" + entry.branch : "",
        entry.baseBranch ? "base=" + entry.baseBranch : "",
        entry.commit ? "commit=" + entry.commit : "",
        entry.pullRequestIndex !== undefined ? "pr=" + entry.pullRequestIndex : "",
        entry.pullRequestUrl ? "url=" + entry.pullRequestUrl : "",
        entry.status ? "status=" + entry.status : "",
        entry.outcome ? "outcome=" + entry.outcome : "",
        entry.failureKind ? "failure=" + entry.failureKind : "",
        entry.reviewerStatus ? "reviewer=" + entry.reviewerStatus : "",
        entry.reviewerExitCode !== undefined ? "reviewerExit=" + entry.reviewerExitCode : "",
        Array.isArray(entry.reviewerCommands) && entry.reviewerCommands.length ? "reviewerCommands=" + entry.reviewerCommands.join(", ") : ""
      ].filter(Boolean).join(" ");
    }

    function formatIssueCommentSeed(seed) {
      const commentId = seed.controlPlaneCommentId || seed.giteaCommentId;
      const commentUrl = seed.controlPlaneCommentUrl || seed.giteaCommentUrl;
      return [
        seed.runId ? "run=" + seed.runId : "",
        seed.issue ? "issue=" + seed.issue : "",
        seed.synced !== undefined ? "synced=" + seed.synced : "",
        seed.skippedDuplicate !== undefined ? "dup=" + seed.skippedDuplicate : "",
        seed.skippedLoom !== undefined ? "loom=" + seed.skippedLoom : "",
        seed.skippedEmpty !== undefined ? "empty=" + seed.skippedEmpty : "",
        seed.handoffFollowupRequested !== undefined ? "handoffFollowupRequested=" + seed.handoffFollowupRequested : "",
        seed.handoffFollowupStarted !== undefined ? "handoffFollowupStarted=" + seed.handoffFollowupStarted : "",
        seed.handoffFollowupDenied !== undefined ? "handoffFollowupDenied=" + seed.handoffFollowupDenied : "",
        seed.handoffFollowupRunId ? "handoffFollowupRun=" + seed.handoffFollowupRunId : "",
        seed.sourceCheckpointVersion ? "sourceCheckpoint=" + seed.sourceCheckpointVersion : "",
        seed.controlPlaneProvider ? "controlPlane=" + seed.controlPlaneProvider : "",
        commentId ? "comment=" + commentId : "",
        commentUrl ? "commentUrl=" + commentUrl : "",
        seed.clientId ? "client=" + seed.clientId : "",
        seed.actor ? "actor=" + seed.actor : ""
      ].filter(Boolean).join(" ");
    }

    function formatProjectContractStatus(status) {
      if (!status) return "";
      const missing = Array.isArray(status.missing) && status.missing.length ? " missing=" + status.missing.join(",") : "";
      return (status.ok ? "ready" : "missing") + missing;
    }

    function formatProjectContract(contract) {
      if (!contract) return "";
      return [
        contract.objective ? "objective=" + contract.objective : "",
        Array.isArray(contract.constraints) && contract.constraints.length ? "constraints:\\n" + contract.constraints.map((entry) => "- " + entry).join("\\n") : "",
        Array.isArray(contract.successCriteria) && contract.successCriteria.length ? "successCriteria:\\n" + contract.successCriteria.map((entry) => "- " + entry).join("\\n") : ""
      ].filter(Boolean).join("\\n");
    }

    function formatProjectContractInline(contract) {
      if (!contract) return "";
      return [
        contract.objective ? "objective=" + contract.objective : "",
        Array.isArray(contract.constraints) && contract.constraints.length ? "constraints=" + contract.constraints.join("; ") : "",
        Array.isArray(contract.successCriteria) && contract.successCriteria.length ? "successCriteria=" + contract.successCriteria.join("; ") : ""
      ].filter(Boolean).join(" ");
    }

    function formatReviewSummary(data) {
      const metadata = data.metadata || {};
      const projectContract = data.projectContract || metadata.projectContract;
      const projectContractStatus = data.projectContractStatus || metadata.projectContractStatus;
      const review = data.review ? [data.review.status, data.review.decidedBy, data.review.decidedAt].filter(Boolean).join(" ") : "none";
      const reviewClaim = data.review && data.review.claim ? "claimedBy=" + formatRunReviewClaim(data.review.claim) : "";
      const deployment = data.deployment ? [data.deployment.status, data.deployment.decidedBy, data.deployment.decidedAt].filter(Boolean).join(" ") : "none";
      const timeline = Array.isArray(data.timeline)
        ? data.timeline.slice(-8).map((entry) => \`#\${entry.seq} \${entry.title || entry.type}\`).join("\\n")
        : "";
      return [
        "runId=" + (data.runId || ""),
        "goal=" + (data.goal || ""),
        "status=" + (data.status || ""),
        data.requester ? "requester=" + formatRunRequester(data.requester) : "",
        "review=" + review,
        reviewClaim,
        data.review && data.review.contractPatch ? "contractPatch:\\n" + formatProjectContract(data.review.contractPatch) : "",
        "deployment=" + deployment,
        "verification=" + formatGate(data.verification),
        "evaluation=" + formatGate(data.evaluation),
        "reviewer=" + formatGate(data.reviewer),
        data.brain ? "brain=" + formatBrainEvidence(data.brain) : "",
        data.modelUsage ? "modelUsage=" + formatModelUsage(data.modelUsage) : "",
        data.vas ? "vas:\\n" + formatReviewVas(data.vas) : "",
        metadata.tenant ? "tenant=" + metadata.tenant : "",
        metadata.project ? "project=" + metadata.project : "",
        metadata.repo ? "repo=" + metadata.repo : "",
        metadata.branch ? "branch=" + metadata.branch : "",
        metadata.baseBranch ? "baseBranch=" + metadata.baseBranch : "",
        metadata.issue ? "issue=" + metadata.issue : "",
        projectContract && projectContract.objective ? "contract=" + projectContract.objective : "",
        projectContractStatus ? "contractStatus=" + formatProjectContractStatus(projectContractStatus) : "",
        metadata.handoffSourceRunId ? "handoffSourceRunId=" + metadata.handoffSourceRunId : "",
        metadata.handoffSourceProject ? "handoffSourceProject=" + metadata.handoffSourceProject : "",
        metadata.handoffSourceStatus ? "handoffSourceStatus=" + metadata.handoffSourceStatus : "",
        metadata.handoffSourceControlPlaneProvider ? "handoffSourceControlPlaneProvider=" + metadata.handoffSourceControlPlaneProvider : "",
        metadata.handoffSourceControlPlaneCommentId ? "handoffSourceControlPlaneCommentId=" + metadata.handoffSourceControlPlaneCommentId : "",
        metadata.handoffSourceControlPlaneCommentUrl ? "handoffSourceControlPlaneCommentUrl=" + metadata.handoffSourceControlPlaneCommentUrl : "",
        metadata.handoffSourceGiteaCommentId ? "handoffSourceGiteaCommentId=" + metadata.handoffSourceGiteaCommentId : "",
        metadata.handoffSourceGiteaCommentUrl ? "handoffSourceGiteaCommentUrl=" + metadata.handoffSourceGiteaCommentUrl : "",
        data.diff ? "diff:\\n" + formatCommandResult(data.diff) : "",
        timeline ? "timeline:\\n" + timeline : ""
      ].filter(Boolean).join("\\n");
    }

    function formatReviewVas(data) {
      const links = data.links || {};
      return [
        data.preset ? "preset=" + data.preset : "",
        data.caseId ? "case=" + data.caseId : "",
        links.artifacts ? "artifacts=" + links.artifacts : "",
        links.runs ? "runs=" + links.runs : "",
        links.reviewPackage ? "reviewPackage=" + links.reviewPackage : "",
        links.reviewRuns ? "reviewRuns=" + links.reviewRuns : ""
      ].filter(Boolean).join("\\n");
    }

    function formatModelUsage(data) {
      return [
        data.requestCount !== undefined ? data.requestCount + (data.requestCount === 1 ? " request" : " requests") : "",
        data.promptTokens !== undefined ? "prompt=" + data.promptTokens : "",
        data.completionTokens !== undefined ? "completion=" + data.completionTokens : "",
        data.totalTokens !== undefined ? "total=" + data.totalTokens : "",
        data.costUsd !== undefined ? "cost=" + formatModelCostUsd(data.costUsd) : ""
      ].filter(Boolean).join(" ");
    }

    function formatModelCostUsd(value) {
      const cost = Number(value);
      if (!Number.isFinite(cost)) return String(value);
      if (cost === 0) return "$0";
      if (Math.abs(cost) < 0.01) return "$" + cost.toFixed(6).replace(/0+$/, "").replace(/\\.$/, "");
      return "$" + cost.toFixed(2);
    }

    function formatBrainEvidence(data) {
      return [
        data.outcome || "",
        data.failureKind ? "kind=" + data.failureKind : "",
        data.reviewerFocus ? "focus=" + data.reviewerFocus : ""
      ].filter(Boolean).join(" ");
    }

    function formatGate(result) {
      if (!result) return "not run";
      const status = result.ok === true ? "passed" : result.ok === false ? "failed" : "unknown";
      const exit = result.exitCode !== undefined ? " exit=" + result.exitCode : "";
      const commands = Array.isArray(result.commands) && result.commands.length ? " commands=" + result.commands.join(", ") : "";
      return status + exit + commands;
    }

    function replayEntryMeta(entry) {
      return [
        entry.actor || entry.clientId,
        entry.requester ? "by " + formatRunRequester(entry.requester) : "",
        entry.role,
        entry.actionCount !== undefined ? "actions=" + entry.actionCount : "",
        entry.finishRequested !== undefined ? "finishRequested=" + entry.finishRequested : "",
        entry.phase ? "phase=" + entry.phase : "",
        entry.ts || ""
      ].filter(Boolean).join(" ");
    }

    function replayEntryDetail(entry) {
      return [
        entry.detail || "",
        entry.toolName ? "tool=" + entry.toolName : "",
        entry.actionId ? "action=" + entry.actionId : "",
        entry.status ? "status=" + entry.status : "",
        entry.ok !== undefined ? "ok=" + entry.ok : "",
        entry.iteration !== undefined ? "iteration=" + entry.iteration : "",
        entry.plan ? "plan=" + entry.plan : "",
        entry.runReviewContractPatch ? "contractPatch:\\n" + formatProjectContract(entry.runReviewContractPatch) : "",
        entry.contractPatch ? "contractPatch:\\n" + formatProjectContract(entry.contractPatch) : ""
      ].filter(Boolean).join("\\n") || entry.type;
    }

    async function loadAudit() {
      const response = await fetch(auditUrl(false), { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) return;
      state.auditEvents = Array.isArray(data) ? data.filter(isWorkbenchAuditEvent) : [];
      renderAuditEvents();
    }

    async function loadBrainSignals(options = {}) {
      const quiet = options.quiet === true;
      try {
        const response = await fetch(brainSignalsUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load brain signals");
        state.brainSignals = Array.isArray(data.signals) ? data.signals : [];
        renderBrainSignals();
      } catch (error) {
        if (!quiet) {
          state.brainSignals = [];
          renderBrainSignals(error.message || "failed to load brain signals");
        }
      }
    }

    function renderBrainSignals() {
      const message = arguments[0] || "No brain signals loaded.";
      const signals = Array.isArray(state.brainSignals) ? state.brainSignals : [];
      brainFeedEl.innerHTML = signals.length ? signals.slice(-10).reverse().map((signal) => \`
        <div class="item">
          <span class="item-title">\${escapeHtml(formatBrainSignalEntry(signal))}</span>
          <span class="meta">\${escapeHtml(signal.ts || "")}</span>
        </div>
      \`).join("") : \`<div class="empty">\${escapeHtml(message)}</div>\`;
    }

    function formatBrainSignalEntry(signal) {
      const evidence = formatBrainSignalEvidence(signal);
      const modelUsage = formatBrainSignalModelUsage(signal);
      return [
        signal.source || "signal",
        signal.project ? "project " + signal.project : "",
        signal.runId ? "run " + signal.runId : "",
        evidence,
        modelUsage ? "model " + modelUsage : "",
        signal.clientId ? "client " + signal.clientId : ""
      ].filter(Boolean).join(" - ");
    }

    function startAuditStream() {
      if (state.auditStream) state.auditStream.close();
      const after = workbenchAuditEventsAfter();
      state.auditStream = new EventSource(auditUrl(true, after));
      state.auditStream.addEventListener("tenant_audit", (message) => {
        const event = JSON.parse(message.data);
        handleWorkbenchAuditEvent(event);
      });
    }

    function handleWorkbenchAuditEvent(event) {
      if (!isWorkbenchAuditEvent(event)) return;
      if (isLoadedWorkbenchAuditEvent(event)) return;
      state.auditEvents = state.auditEvents.concat(event).slice(-30);
      renderAuditEvents();
      if (event.type === "brain_signal_ingested") {
        void loadBrainSignals({ quiet: true });
      }
      refreshWorkbenchForAudit(event);
    }

    function workbenchAuditEventsAfter() {
      return state.auditEvents.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
    }

    function isLoadedWorkbenchAuditEvent(event) {
      const seq = Number(event && event.seq);
      return Number.isFinite(seq) && state.auditEvents.some((entry) => Number(entry.seq) === seq);
    }

    function refreshWorkbenchForAudit(event) {
      if (isWorkbenchVasCaseAuditEvent(event && event.data ? event.data : {})) {
        if (event.type === "vas_case_reviewed") void loadVasArtifacts({ quiet: true, updatePresence: false });
        if (event.type === "vas_case_reviewed" || event.type === "vas_case_claimed") {
          void loadVasCaseRuns({ quiet: true, updatePresence: false });
          void loadVasReviewPackage({ quiet: true, updatePresence: false });
        }
        if (event.type === "vas_case_reviewed" || event.type === "vas_case_claimed") return;
        void loadVasCaseRuns({ quiet: true, updatePresence: false });
        void loadVasReviewPackage({ quiet: true, updatePresence: false });
      }
      const currentRunAudit = isCurrentRunAuditEvent(event);
      const loadedHandoffFollowupAudit = isLoadedHandoffFollowupAuditEvent(event);
      if (!currentRunAudit && !loadedHandoffFollowupAudit) return;
      if (currentRunAudit && ["run_created", "queued_run_recovered", "queued_run_recovery_failed", "run_started", "run_finished", "run_handoff_followup_created", "run_handoff_followup_denied", "run_comment_added", "run_issue_comments_synced", "run_resumed", "run_cancelled", "run_abandoned", "run_review_claimed", "review_decided", "deployment_decided", "stale_run_auto_abandoned", "workspace_pull_request_created"].includes(event.type)) void loadRun({ quiet: true });
      if (currentRunAudit && event.type === "vas_case_reviewed") {
        void loadVasArtifacts({ quiet: true, updatePresence: false });
        void loadVasCaseRuns({ quiet: true, updatePresence: false });
        void loadVasReviewPackage({ quiet: true, updatePresence: false });
      }
      if (currentRunAudit && replayRefreshAuditTypes.has(event.type)) {
        void loadReplay({ quiet: true });
      }
      if (currentRunAudit && (event.type === "workspace_file_written" || event.type === "workspace_file_moved" || event.type === "workspace_file_deleted" || event.type === "workspace_file_conflicted")) refreshFilesForAudit(event);
      if (currentRunAudit && event.type === "workspace_commit_created") void loadDiff({ quiet: true });
      if (currentRunAudit && event.type === "workspace_pull_request_created") void loadDiff({ quiet: true });
      if (currentRunAudit && state.reviewSummary && !state.handoffPackage && reviewSummaryRefreshAuditTypes.has(event.type)) void loadReviewSummary({ quiet: true, updatePresence: false });
      if (currentRunAudit && state.handoffPackage && handoffPackageRefreshAuditTypes.has(event.type)) void loadHandoffPackage({ quiet: true, updatePresence: false });
      if (state.handoffFollowups && (event.type === "run_handoff_followup_created" || event.type === "run_handoff_followup_denied" || loadedHandoffFollowupAudit)) void loadHandoffFollowups({ quiet: true, updatePresence: false });
      if (currentRunAudit && event.type === "workspace_command_ran") void loadCommands({ quiet: true });
      if (currentRunAudit && ["workspace_session_started", "workspace_session_input_sent", "workspace_session_stopped", "workspace_session_exited"].includes(event.type)) {
        void loadSessions({ quiet: true });
        if (state.currentSessionId && event.data?.sessionId === state.currentSessionId) void loadSessionEvents();
      }
    }

    function refreshFilesForAudit(event) {
      const directoryPath = state.currentFile ? parentPath(state.currentFile.path) : state.currentPath;
      void refreshDirectoryForAudit(directoryPath);
      if (state.currentFile && (event.data?.path === state.currentFile.path || event.data?.fromPath === state.currentFile.path)) {
        reloadFileButton.disabled = event.type === "workspace_file_deleted";
        fileError.textContent = event.type === "workspace_file_deleted"
          ? \`\${event.data.path} deleted in another session.\`
          : event.type === "workspace_file_conflicted"
            ? \`\${event.data.path} conflict in another session. Reload latest to resolve.\`
          : event.type === "workspace_file_moved"
            ? \`\${event.data.fromPath || event.data.path} moved to \${event.data.path} in another session.\`
            : \`\${event.data.path} changed in another session. Reload latest to resolve.\`;
      }
    }

    function renderAuditEvents() {
      const events = state.auditEvents.slice(-10).reverse();
      auditEl.innerHTML = events.length ? events.map((event) => \`
        <div class="item">
          <span class="item-title">\${escapeHtml(formatWorkbenchAuditEvent(event))}</span>
          <span class="meta">\${escapeHtml(event.ts || "")}</span>
        </div>
      \`).join("") : '<div class="empty">No audit events for this run.</div>';
    }

    function isWorkbenchAuditEvent(event) {
      const data = event && event.data ? event.data : {};
      return data.runId === runId || data.followupRunId === runId || isLoadedHandoffFollowupAuditEvent(event) || isWorkbenchVasCaseAuditEvent(data) || (!data.runId && data.project === project);
    }

    function isWorkbenchVasCaseAuditEvent(data) {
      return data.project === project && (data.caseId === vasCaseId() || (data.preset === "vas-lite-review" && data.presetInput?.caseId === vasCaseId()));
    }

    function isCurrentRunAuditEvent(event) {
      return event && event.data && (event.data.runId === runId || event.data.followupRunId === runId);
    }

    function isLoadedHandoffFollowupAuditEvent(event) {
      if (!state.handoffFollowups || !Array.isArray(state.handoffFollowups.followupRuns)) return false;
      const data = event && event.data ? event.data : {};
      const auditRunId = data.followupRunId || data.runId;
      return Boolean(auditRunId && state.handoffFollowups.followupRuns.some((run) => run && run.runId === auditRunId));
    }

    function formatWorkbenchAuditEvent(event) {
      const data = event && event.data ? event.data : {};
      const actor = event.actor || data.clientId || "system";
      const target = data.path || data.command || data.sessionId || data.runId || data.escalationId || "";
      const details = formatWorkbenchAuditDetails(event.type, data);
      return [actor, event.type || "audit", target, details].filter(Boolean).join(" - ");
    }

    function formatWorkbenchAuditDetails(type, data) {
      const parts = [];
      if (type === "tenant_api_key_created" && data.createdApiKey) {
        parts.push("created key " + formatWorkbenchAuditApiKey(data.createdApiKey));
      }
      if (type === "tenant_api_key_revoked" && Array.isArray(data.revokedApiKeys) && data.revokedApiKeys.length) {
        parts.push("revoked keys " + data.revokedApiKeys.map(formatWorkbenchAuditApiKey).join(", "));
      }
      const keyChange = formatWorkbenchAuditKeyChange(data);
      if (keyChange) parts.push(keyChange);
      const policyChange = formatWorkbenchPolicyChange(data.policyChange);
      if (policyChange) parts.push(policyChange);
      const brainSignalEvidence = formatBrainSignalEvidence(data);
      if (brainSignalEvidence) parts.push(brainSignalEvidence);
      const brainSignalModelUsage = formatBrainSignalModelUsage(data);
      if (brainSignalModelUsage) parts.push("model " + brainSignalModelUsage);
      const queuedAuditEvidence = ["run_created", "run_started", "run_cancelled"].includes(type) && data.queued ? formatQueuedAuditEvidence(data) : "";
      if (queuedAuditEvidence) parts.push(queuedAuditEvidence);
      const previousClaim = type === "run_review_claimed" && data.previousClaim ? "previousClaim=" + formatRunReviewClaim(data.previousClaim) : "";
      if (previousClaim) parts.push(previousClaim);
      const previousVasClaim = type === "vas_case_claimed" && data.previousClaim ? "previousClaim=" + formatVasCaseClaim(data.previousClaim) : "";
      if (previousVasClaim) parts.push(previousVasClaim);
      return parts.join("; ");
    }

    function formatQueuedAuditEvidence(data) {
      return [
        data.projectQueuePosition !== undefined ? "projectQueue=#" + data.projectQueuePosition : "",
        data.tenantQueuePosition !== undefined ? "tenantQueue=#" + data.tenantQueuePosition : "",
        data.blockedReason ? "blocked=" + data.blockedReason : "",
        Array.isArray(data.blockedByRunIds) && data.blockedByRunIds.length ? "blockedBy=" + data.blockedByRunIds.join(",") : "",
        data.limit !== undefined ? "limit=" + data.limit : "",
        data.activeTenantRunCount !== undefined ? "activeTenantRuns=" + data.activeTenantRunCount : "",
        data.tenantActiveRunLimit !== undefined ? "tenantRunLimit=" + data.tenantActiveRunLimit : "",
        data.projectActiveRunId ? "projectActiveRun=" + data.projectActiveRunId : "",
        data.persistedRunId ? "persistedRun=" + data.persistedRunId : ""
      ].filter(Boolean).join(" ");
    }

    function formatBrainSignalEvidence(data) {
      return [
        data.outcome ? "outcome=" + data.outcome : "",
        data.failureKind ? "failure=" + data.failureKind : "",
        data.caseId ? "case=" + data.caseId : "",
        data.operation ? "operation=" + data.operation : "",
        data.path ? "path=" + data.path : "",
        data.activeEditorCount !== undefined ? "activeEditors=" + data.activeEditorCount : "",
        data.learningCount !== undefined ? "learnings=" + data.learningCount : "",
        data.skillCount !== undefined ? "skills=" + data.skillCount : ""
      ].filter(Boolean).join(" ");
    }

    function formatBrainSignalModelUsage(data) {
      return formatModelUsage({
        requestCount: data.modelRequestCount !== undefined ? data.modelRequestCount : undefined,
        promptTokens: data.modelPromptTokens !== undefined ? data.modelPromptTokens : undefined,
        completionTokens: data.modelCompletionTokens !== undefined ? data.modelCompletionTokens : undefined,
        totalTokens: data.modelTotalTokens !== undefined ? data.modelTotalTokens : undefined,
        costUsd: data.modelCostUsd !== undefined ? data.modelCostUsd : undefined
      });
    }

    function formatWorkbenchAuditApiKey(key) {
      if (!key || typeof key !== "object") return "unknown";
      return \`\${key.actor || "unknown"}:\${key.role || "role"}\${key.modelKeyEnv ? "@" + key.modelKeyEnv : ""}\`;
    }

    function formatWorkbenchAuditKeyChange(data) {
      const before = Array.isArray(data.apiKeysBefore) ? data.apiKeysBefore.length : 0;
      const after = Array.isArray(data.apiKeysAfter) ? data.apiKeysAfter.length : 0;
      if (!before && !after) return "";
      return \`members \${before}->\${after}\`;
    }

    function formatWorkbenchPolicyChange(policyChange) {
      if (!policyChange) return "";
      const parts = [];
      const modelChange = policyChange.modelKeyEnv || {};
      if (modelChange.before !== undefined || modelChange.after !== undefined) {
        parts.push(\`model key \${modelChange.before || "server"}->\${modelChange.after || "server"}\`);
      }
      const paramsChange = policyChange.executorTemplateParameters || {};
      if (Array.isArray(paramsChange.added) && paramsChange.added.length) {
        parts.push("adds params " + paramsChange.added.join(", "));
      }
      if (Array.isArray(paramsChange.removed) && paramsChange.removed.length) {
        parts.push("removes params " + paramsChange.removed.join(", "));
      }
      const toolChange = policyChange.allowedTools || {};
      if (Array.isArray(toolChange.added) && toolChange.added.length) {
        parts.push("adds tools " + toolChange.added.join(", "));
      }
      if (Array.isArray(toolChange.removed) && toolChange.removed.length) {
        parts.push("removes tools " + toolChange.removed.join(", "));
      }
      const limitChange = policyChange.limits || {};
      if (Array.isArray(limitChange.changed) && limitChange.changed.length) {
        parts.push("changes limits " + limitChange.changed.join(", "));
      }
      return parts.join("; ");
    }

    async function refreshDirectoryForAudit(path = state.currentPath) {
      const response = await fetch(filesUrl(path), { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok || data.kind !== "directory") return;
      const directoryPath = data.path || "";
      if (!state.currentFile) {
        state.currentPath = directoryPath;
        pathInput.value = state.currentPath;
      }
      renderFileEntries(directoryPath, Array.isArray(data.entries) ? data.entries : []);
      applyAccessControls();
    }

    function renderFileEntries(path, entries) {
      const parent = path ? [{ name: "..", path: parentPath(path), kind: "directory" }] : [];
      filesEl.innerHTML = parent.concat(entries).map((entry) => \`
        <button class="item" type="button" data-path="\${escapeHtml(entry.path)}" data-kind="\${escapeHtml(entry.kind)}">
          <span class="item-title">\${escapeHtml(entry.name || entry.path)}</span>
          <span class="meta">\${escapeHtml(entry.kind || "")}</span>
        </button>
      \`).join("") || '<div class="empty">No files in this directory.</div>';
      for (const item of filesEl.querySelectorAll(".item")) {
        item.addEventListener("click", () => loadFiles(item.dataset.path || ""));
      }
    }

    async function loadFiles(path = "") {
      fileError.textContent = "";
      const response = await fetch(filesUrl(path), { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) {
        fileError.textContent = data.error || "failed to load files";
        return;
      }
      if (data.kind === "file") {
        state.currentPath = data.path;
        state.currentFile = data;
        state.presenceFocus = "file:" + data.path;
        pathInput.value = data.path;
        fileEditor.hidden = false;
        renderCurrentFileMeta();
        fileContent.value = data.content || "";
        saveFileButton.disabled = false;
        reloadFileButton.disabled = false;
        applyAccessControls();
        void heartbeatPresence();
        return;
      }
      state.currentPath = data.path || "";
      state.currentFile = null;
      state.presenceFocus = state.currentPath ? "dir:" + state.currentPath : "run:" + runId;
      pathInput.value = state.currentPath;
      fileEditor.hidden = true;
      saveFileButton.disabled = true;
      reloadFileButton.disabled = true;
      applyAccessControls();
      const entries = Array.isArray(data.entries) ? data.entries : [];
      renderFileEntries(state.currentPath, entries);
      void heartbeatPresence();
    }

    function renderCurrentFileMeta() {
      if (!state.currentFile) {
        fileName.textContent = "";
        return;
      }
      const collaborators = fileCollaborators();
      const collaboratorText = collaborators.length ? " - also editing: " + collaborators.join(", ") : "";
      const fileMeta = state.currentFile.updatedAt ? formatBytes(state.currentFile.size || 0) : "new file";
      fileName.textContent = state.currentFile.path + " - " + fileMeta + collaboratorText;
    }

    function fileCollaborators() {
      if (!state.currentFile) return [];
      return state.presence
        .filter((entry) => entry.clientId !== state.clientId)
        .filter((entry) => entry.focus === "file:" + state.currentFile.path)
        .map((entry) => entry.label || entry.actor || entry.clientId);
    }

    function formatFileConflict(data) {
      const message = (data && data.error) || "workspace file changed since it was loaded.";
      const activeEditors = formatActiveEditors(data && data.activeEditors);
      return message + " Reload latest to resolve." + (activeEditors ? " Active editors: " + activeEditors + "." : "");
    }

    function formatActiveEditors(entries) {
      if (!Array.isArray(entries)) return "";
      return entries
        .map((entry) => entry && (entry.label || entry.actor || entry.clientId))
        .filter(Boolean)
        .join(", ");
    }

    function newFile() {
      if (!canMutate()) {
        fileError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const path = pathInput.value.trim();
      if (!path) {
        fileError.textContent = "path is required to create a file";
        return;
      }
      fileError.textContent = "";
      state.currentPath = path;
      state.currentFile = { path, kind: "file", size: 0, content: "" };
      state.presenceFocus = "file:" + path;
      fileEditor.hidden = false;
      renderCurrentFileMeta();
      fileContent.value = "";
      saveFileButton.disabled = false;
      reloadFileButton.disabled = true;
      applyAccessControls();
      void heartbeatPresence();
    }

    async function saveFile() {
      if (!state.currentFile) return;
      if (!canMutate()) {
        fileError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      fileError.textContent = "";
      const response = await fetch(filesUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ path: state.currentFile.path, content: fileContent.value, baseUpdatedAt: state.currentFile.updatedAt, clientId: state.clientId })
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409 && state.currentFile) {
          reloadFileButton.disabled = false;
          fileError.textContent = formatFileConflict(data);
          return;
        }
        fileError.textContent = data.error || "failed to save file";
        return;
      }
      await loadFiles(data.path || state.currentFile.path);
    }

    async function reloadLatestFile() {
      if (!state.currentFile) return;
      fileError.textContent = "";
      await loadFiles(state.currentFile.path);
    }

    async function moveFile() {
      if (!state.currentFile) return;
      if (!canMutate()) {
        fileError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      if (!state.currentFile.updatedAt) return;
      const promptedPath = window.prompt("Move file to path", state.currentFile.path);
      const toPath = promptedPath ? promptedPath.trim() : "";
      if (!toPath || toPath === state.currentFile.path) return;
      fileError.textContent = "";
      moveFileButton.disabled = true;
      const response = await fetch(moveFileUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ fromPath: state.currentFile.path, toPath, baseUpdatedAt: state.currentFile.updatedAt, clientId: state.clientId })
      });
      const data = await response.json();
      if (!response.ok) {
        fileError.textContent = response.status === 409 ? formatFileConflict(data) : data.error || "failed to move file";
        applyAccessControls();
        return;
      }
      state.currentFile = data;
      state.presenceFocus = "file:" + data.path;
      await loadFiles(data.path);
      void heartbeatPresence();
    }

    async function deleteFile() {
      if (!state.currentFile) return;
      if (!canMutate()) {
        fileError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      if (!state.currentFile.updatedAt) {
        state.currentFile = null;
        fileEditor.hidden = true;
        applyAccessControls();
        return;
      }
      const path = state.currentFile.path;
      fileError.textContent = "";
      deleteFileButton.disabled = true;
      const response = await fetch(filesUrl(path), {
        method: "DELETE",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ baseUpdatedAt: state.currentFile.updatedAt, clientId: state.clientId })
      });
      const data = await response.json();
      if (!response.ok) {
        fileError.textContent = response.status === 409 ? formatFileConflict(data) : data.error || "failed to delete file";
        applyAccessControls();
        return;
      }
      state.currentFile = null;
      await loadFiles(parentPath(path));
    }

    async function runCommand() {
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      commandError.textContent = "";
      const response = await fetch(commandsUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ command: commandInput.value, clientId: state.clientId })
      });
      const data = await response.json();
      commandOutput.hidden = false;
      commandOutput.textContent = formatCommandResult(data);
      if (!response.ok) {
        commandError.textContent = data.error || "command failed";
        return;
      }
      state.currentCommandId = data.commandId || "";
      state.presenceFocus = state.currentCommandId ? "command:" + state.currentCommandId : "command";
      void heartbeatPresence();
      await loadCommands();
    }

    async function loadCommands(options = {}) {
      const quiet = options.quiet === true;
      if (!quiet) commandError.textContent = "";
      const response = await fetch(commandsUrl(), { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) {
        if (quiet) return;
        commandError.textContent = data.error || "failed to load commands";
        return;
      }
      state.commands = Array.isArray(data) ? data : [];
      commandList.innerHTML = state.commands.length ? state.commands.map((command, index) => \`
        <button class="item" type="button" data-command-index="\${index}">
          <span class="item-title">\${escapeHtml(command.command || command.commandId)}</span>
          <span class="meta">\${escapeHtml(["exit " + command.exitCode, commandMeta(command), command.endedAt || ""].filter(Boolean).join(" "))}</span>
        </button>
      \`).join("") : '<div class="empty">No commands loaded.</div>';
      for (const item of commandList.querySelectorAll(".item")) {
        item.addEventListener("click", () => {
          const command = state.commands[Number(item.dataset.commandIndex)];
          selectCommand(command && command.commandId ? command.commandId : "", command);
        });
      }
    }

    function selectCommand(commandId, fallbackCommand = null) {
      const command = state.commands.find((entry) => entry.commandId === commandId) || fallbackCommand;
      state.currentCommandId = command && command.commandId ? command.commandId : commandId || "";
      state.presenceFocus = state.currentCommandId ? "command:" + state.currentCommandId : "";
      commandOutput.hidden = false;
      commandOutput.textContent = command ? formatCommandResult(command) : "";
      void heartbeatPresence();
    }

    async function openHandoffCommand(commandId) {
      if (!commandId) return;
      const packageCommand = findHandoffCommand(commandId);
      if (!state.commands.some((command) => command.commandId === commandId)) {
        await loadCommands({ quiet: true });
      }
      selectCommand(commandId, packageCommand);
    }

    function findHandoffCommand(commandId) {
      const commands = state.handoffPackage && Array.isArray(state.handoffPackage.commands) ? state.handoffPackage.commands : [];
      return commands.find((command) => command.commandId === commandId) || null;
    }

    async function startSession() {
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      commandError.textContent = "";
      const response = await fetch(sessionsUrl(), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ command: sessionCommandInput.value.trim() || "sh", clientId: state.clientId })
      });
      const data = await response.json();
      if (!response.ok) {
        commandError.textContent = data.error || "failed to start session";
        return;
      }
      state.currentSessionId = data.sessionId;
      state.presenceFocus = "session:" + data.sessionId;
      terminalOutput.hidden = false;
      terminalOutput.textContent = \`$ \${data.command || ""}\\n\`;
      sendSessionInputButton.disabled = false;
      stopSessionButton.disabled = false;
      applyAccessControls();
      void heartbeatPresence();
      await loadSessions();
      await loadSessionEvents();
      startTerminalStream();
    }

    async function loadSessions(options = {}) {
      const quiet = options.quiet === true;
      if (!quiet) commandError.textContent = "";
      const response = await fetch(sessionsUrl(), { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) {
        if (quiet) return;
        commandError.textContent = data.error || "failed to load sessions";
        return;
      }
      sessionList.innerHTML = data.length ? data.map((session) => \`
        <button class="item" type="button" data-session-id="\${escapeAttr(session.sessionId)}">
          <span class="item-title">\${escapeHtml(session.command || session.sessionId)}</span>
          <span class="meta">\${escapeHtml([session.status || "", sessionMeta(session), (session.eventCount || 0) + " events"].filter(Boolean).join(" "))}</span>
        </button>
      \`).join("") : '<div class="empty">No sessions loaded.</div>';
      for (const item of sessionList.querySelectorAll(".item")) {
        item.addEventListener("click", () => selectSession(item.dataset.sessionId));
      }
    }

    function commandMeta(command) {
      return [
        command.actor || command.clientId,
        command.role,
        command.actor && command.clientId ? command.clientId : ""
      ].filter(Boolean).join(" ");
    }

    function sessionMeta(session) {
      return [
        session.actor || session.clientId,
        session.role,
        session.actor && session.clientId ? session.clientId : "",
        session.startedAt || ""
      ].filter(Boolean).join(" ");
    }

    async function selectSession(sessionId) {
      state.currentSessionId = sessionId || "";
      state.presenceFocus = sessionId ? "session:" + sessionId : "";
      applyAccessControls();
      void heartbeatPresence();
      await loadSessionEvents();
      startTerminalStream();
    }

    async function openHandoffSession(sessionId) {
      if (!sessionId) return;
      await loadSessions({ quiet: true });
      await selectSession(sessionId);
    }

    async function loadSessionEvents() {
      if (!state.currentSessionId) return;
      const response = await fetch(sessionActionUrl("events"), { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) return;
      state.sessionEvents = Array.isArray(data) ? data : [];
      terminalOutput.hidden = false;
      terminalOutput.textContent = state.sessionEvents.map(formatSessionEvent).join("");
    }

    async function sendSessionInput() {
      if (!state.currentSessionId) return;
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const response = await fetch(sessionActionUrl("input"), {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ input: sessionInput.value, clientId: state.clientId })
      });
      if (response.ok) await loadSessionEvents();
    }

    async function stopSession() {
      if (!state.currentSessionId) return;
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      await fetch(sessionActionUrl("stop"), { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ clientId: state.clientId }) });
      sendSessionInputButton.disabled = true;
      stopSessionButton.disabled = true;
      await loadSessions();
      await loadSessionEvents();
    }

    function startTerminalStream() {
      if (!state.currentSessionId) return;
      if (state.terminalStream) state.terminalStream.close();
      const after = sessionEventsAfter();
      const stream = new EventSource(sessionActionUrl("events", true, { after }));
      state.terminalStream = stream;
      stream.addEventListener("workspace_session", (message) => {
        const event = JSON.parse(message.data);
        if (isLoadedSessionEvent(event)) return;
        state.sessionEvents = state.sessionEvents.concat(event);
        terminalOutput.hidden = false;
        terminalOutput.textContent += formatSessionEvent(event);
        terminalOutput.scrollTop = terminalOutput.scrollHeight;
        if (event.type === "exit") {
          stream.close();
          if (state.terminalStream === stream) state.terminalStream = null;
          void loadSessions({ quiet: true });
          applyAccessControls();
        }
      });
    }

    function isLoadedSessionEvent(event) {
      const seq = Number(event && event.seq);
      return Number.isFinite(seq) && state.sessionEvents.some((entry) => Number(entry.seq) === seq);
    }

    function sessionEventsAfter() {
      return state.sessionEvents.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
    }

    function canMutate() {
      const role = accessRole();
      return role === "admin" || role === "developer";
    }

    function isCancellableRun(run) {
      return Boolean(run && (run.status === "running" || run.status === "queued"));
    }

    function canAdmin() {
      return accessRole() === "admin";
    }

    function accessRole() {
      return state.accessRole || "viewer";
    }

    function applyAccessControls() {
      const readonly = !canMutate();
      runCommentInput.readOnly = !runId;
      runCommentPauseInput.disabled = !runId;
      sendRunCommentButton.disabled = !runId;
      syncIssueCommentsButton.disabled = !runId || !state.run || !state.run.metadata || !state.run.metadata.issue;
      cancelRunButton.disabled = readonly || !isCancellableRun(state.run);
      abandonRunButton.disabled = readonly || !state.run || state.run.status !== "running";
      resumeRunButton.disabled = readonly || !state.run || state.run.status !== "paused";
      handoffFollowupGoalInput.readOnly = readonly || !runId;
      handoffFollowupNoteInput.readOnly = readonly || !runId;
      startHandoffFollowupButton.disabled = readonly || !runId;
      claimReviewButton.disabled = readonly || !state.run || state.run.status !== "review_required" || !state.run.review || state.run.review.status !== "pending";
      releaseReviewClaimButton.disabled = readonly || !state.run || state.run.status !== "review_required" || !state.run.review || state.run.review.status !== "pending" || !state.run.review.claim;
      reviewApproveButton.disabled = readonly || !state.run || state.run.status !== "review_required" || !state.run.review || state.run.review.status !== "pending";
      reviewRejectButton.disabled = readonly || !state.run || state.run.status !== "review_required" || !state.run.review || state.run.review.status !== "pending";
      reviewNoteInput.readOnly = readonly || !state.run || state.run.status !== "review_required" || !state.run.review || state.run.review.status !== "pending";
      reviewContractObjectiveInput.readOnly = readonly || !state.run || state.run.status !== "review_required" || !state.run.review || state.run.review.status !== "pending";
      reviewContractConstraintsInput.readOnly = readonly || !state.run || state.run.status !== "review_required" || !state.run.review || state.run.review.status !== "pending";
      reviewContractSuccessInput.readOnly = readonly || !state.run || state.run.status !== "review_required" || !state.run.review || state.run.review.status !== "pending";
      reviewMergeInput.disabled = readonly || !state.run || state.run.status !== "review_required" || !state.run.review || state.run.review.status !== "pending" || !state.run.metadata || !state.run.metadata.pullRequestIndex;
      deploymentApproveButton.disabled = !canAdmin() || !state.run || state.run.status !== "deployment_required" || !state.run.deployment || state.run.deployment.status !== "pending";
      deploymentRejectButton.disabled = !canAdmin() || !state.run || state.run.status !== "deployment_required" || !state.run.deployment || state.run.deployment.status !== "pending";
      deploymentNoteInput.readOnly = !canAdmin() || !state.run || state.run.status !== "deployment_required" || !state.run.deployment || state.run.deployment.status !== "pending";
      loadVasArtifactsButton.disabled = !vasCaseId();
      loadVasCaseRunsButton.disabled = !vasCaseId();
      loadVasReviewPackageButton.disabled = !vasCaseId();
      claimVasCaseButton.disabled = readonly || !vasCaseId();
      releaseVasCaseButton.disabled = readonly || !vasCaseId();
      startVasReviewRunButton.disabled = readonly || !vasCaseId();
      vasReviewRunReviewerInput.readOnly = readonly || !vasCaseId();
      vasReviewDecisionInput.disabled = readonly || !vasCaseId();
      vasReviewNoteInput.readOnly = readonly || !vasCaseId();
      vasReviewCorrectionsInput.readOnly = readonly || !vasCaseId();
      vasReviewLearningsInput.readOnly = readonly || !vasCaseId();
      reviewVasCaseButton.disabled = readonly || !vasCaseId();
      fileContent.readOnly = readonly;
      commandInput.readOnly = readonly;
      sessionCommandInput.readOnly = readonly;
      sessionInput.readOnly = readonly;
      commitMessageInput.readOnly = readonly;
      commitWorkspaceButton.disabled = readonly;
      prIssueInput.readOnly = readonly;
      prBranchInput.readOnly = readonly;
      prBaseInput.readOnly = readonly;
      prReviewInput.disabled = readonly;
      prDeploymentInput.disabled = readonly;
      handoffPrButton.disabled = readonly;
      requestPrEscalationButton.disabled = !runId;
      newFileButton.disabled = readonly;
      saveFileButton.disabled = readonly || !state.currentFile;
      moveFileButton.disabled = readonly || !state.currentFile || !state.currentFile.updatedAt;
      deleteFileButton.disabled = readonly || !state.currentFile || !state.currentFile.updatedAt;
      reloadFileButton.disabled = !state.currentFile || !state.currentFile.updatedAt;
      runCommandButton.disabled = readonly;
      startSessionButton.disabled = readonly;
      sendSessionInputButton.disabled = readonly || !state.currentSessionId;
      stopSessionButton.disabled = readonly || !state.currentSessionId;
    }

    function formatSessionEvent(event) {
      if (event.type === "start") return "$ " + (event.data || "") + "\\n";
      if (event.type === "input") return formatSessionInput(event);
      if (event.type === "stop") return formatSessionStop(event);
      if (event.type === "stdout" || event.type === "stderr") return event.data || "";
      if (event.type === "exit") return "\\n[exit " + event.exitCode + "]\\n";
      return "";
    }

    function formatSessionInput(event) {
      const actor = [
        event.actor || event.clientId,
        event.role,
        event.actor && event.clientId ? event.clientId : ""
      ].filter(Boolean).join(" ");
      const bytes = event.dataBytes !== undefined ? event.dataBytes + " bytes" : "input";
      return "\\n[input " + bytes + (actor ? " by " + actor : "") + "]\\n";
    }

    function formatSessionStop(event) {
      const actor = [
        event.actor || event.clientId,
        event.role,
        event.actor && event.clientId ? event.clientId : ""
      ].filter(Boolean).join(" ");
      return "\\n[stop" + (actor ? " by " + actor : "") + "]\\n";
    }

    function formatCommandResult(result) {
      return [
        "$ " + (result.command || ""),
        result.exitCode !== undefined ? "exitCode=" + result.exitCode : "",
        result.stdout ? "stdout:\\n" + result.stdout : "",
        result.stderr ? "stderr:\\n" + result.stderr : "",
        result.error ? "error:\\n" + result.error : ""
      ].filter(Boolean).join("\\n");
    }

    function lines(value) {
      return value.split("\\n").map((line) => line.trim()).filter(Boolean);
    }

    function workbenchClientId() {
      const key = "loom-workbench-client-id";
      const existing = sessionStorage.getItem(key);
      if (existing) return existing;
      const id = "wb-" + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
      sessionStorage.setItem(key, id);
      return id;
    }

    function scrubTokenFromBrowserUrl() {
      const params = new URLSearchParams(window.location.search);
      if (!params.has("token")) return;
      params.delete("token");
      const text = params.toString();
      const nextUrl = \`\${window.location.pathname}\${text ? "?" + text : ""}\${window.location.hash || ""}\`;
      window.history.replaceState(null, "", nextUrl);
    }

    function parentPath(path) {
      const parts = path.split("/").filter(Boolean);
      parts.pop();
      return parts.join("/");
    }

    function formatBytes(size) {
      if (size < 1024) return size + " B";
      return Math.round(size / 1024) + " KB";
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/\\s+/g, "-");
    }
  </script>
</body>
</html>`;
