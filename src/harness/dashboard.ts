import { projectTemplateDefaultSkills } from "./project-templates.js";
import { HARNESS_VISION_LOCK, ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS } from "./profile-contract.js";

const ONLINE_SANDBOX_REQUIRED_TOOLS_TEXT = ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS.join("\n");
const VAS_LITE_PROJECT_DEFAULT_SKILLS_TEXT = projectTemplateDefaultSkills("vas-lite").join("\n");
const HARNESS_VISION_LOCK_TARGET_TEXT = HARNESS_VISION_LOCK.target;
const VAS_LITE_PROJECT_CONSTRAINTS_TEXT = [
  "Keep multi-user online sandbox collaboration visible in project evidence.",
  "Keep harness/loop evidence durable in .loom project state.",
  "Keep human review and deployment gates explicit.",
  "Keep VAS learning artifacts reviewable and durable.",
].join("\n");
const VAS_LITE_PROJECT_SUCCESS_TEXT = [
  "Runs inherit the project review preset without manual re-entry.",
  "Run metadata carries project policy and contract evidence.",
].join("\n");

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Loom Harness</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f8;
      --surface: #ffffff;
      --surface-2: #eef1f4;
      --text: #182027;
      --muted: #66717c;
      --line: #d8dde3;
      --accent: #176b57;
      --accent-2: #c9473f;
      --ok: #1c7c54;
      --warn: #9a6a00;
      --bad: #b42318;
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
      gap: 16px;
      height: 58px;
      padding: 0 18px;
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }
    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
      font-weight: 700;
    }
    .status-line {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      white-space: nowrap;
    }
    main {
      display: grid;
      grid-template-columns: minmax(280px, 360px) minmax(280px, 430px) minmax(360px, 1fr);
      gap: 1px;
      min-height: calc(100vh - 58px);
      background: var(--line);
    }
    section {
      min-width: 0;
      background: var(--surface);
      padding: 18px;
      overflow: auto;
    }
    section h2 {
      margin: 0 0 14px;
      font-size: 13px;
      line-height: 1.2;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 700;
    }
    label {
      display: block;
      margin: 12px 0 6px;
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
      min-height: 104px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
    }
    button {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: white;
      border-radius: 6px;
      min-height: 36px;
      padding: 0 12px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button.secondary {
      background: var(--surface);
      color: var(--accent);
    }
    button.danger {
      border-color: var(--bad);
      background: var(--bad);
    }
    button:disabled {
      cursor: not-allowed;
      opacity: .62;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .actions {
      display: flex;
      gap: 10px;
      margin-top: 14px;
    }
    .run-list, .project-list, .file-list, .command-list, .session-list {
      display: grid;
      gap: 8px;
    }
    .project-list, .command-list, .session-list {
      margin-top: 10px;
    }
    .workspace-panel {
      margin-top: 18px;
      border-top: 1px solid var(--line);
      padding-top: 16px;
    }
    .workspace-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }
    .workspace-heading h2 {
      margin: 0;
    }
    .heading-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .workspace-path {
      margin-bottom: 10px;
      overflow-wrap: anywhere;
    }
    .run-item, .project-item, .file-item, .command-item, .session-item {
      display: grid;
      gap: 6px;
      width: 100%;
      text-align: left;
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--text);
      border-radius: var(--radius);
      padding: 10px;
    }
    .run-item[aria-selected="true"] {
      border-color: var(--accent);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .project-item[aria-selected="true"] {
      border-color: var(--accent);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .project-select {
      justify-self: start;
      min-height: 0;
      border: 0;
      background: transparent;
      color: var(--text);
      padding: 0;
      text-align: left;
    }
    .project-select:hover {
      text-decoration: underline;
    }
    .project-queued-run {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .project-queued-run button,
    .project-queued-run a {
      min-height: 28px;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 12px;
      font-weight: 700;
    }
    .project-queued-run a {
      color: var(--accent);
    }
    .session-item[aria-selected="true"] {
      border-color: var(--accent);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .command-item[aria-selected="true"] {
      border-color: var(--accent);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .file-editor {
      margin-top: 10px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #fbfcfd;
      padding: 10px;
    }
    .file-editor[hidden] {
      display: none;
    }
    .file-editor textarea {
      min-height: 220px;
    }
    .command-panel {
      margin-top: 18px;
      border-top: 1px solid var(--line);
      padding-top: 16px;
    }
    .command-output {
      margin-top: 10px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #111820;
      color: #eef6f4;
      max-height: 240px;
      overflow: auto;
    }
    .command-output[hidden] {
      display: none;
    }
    .run-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
    }
    .meta, .summary-grid {
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
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 0 8px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .pill.passed { color: var(--ok); border-color: #b7d9ca; background: #eef8f3; }
    .pill.running, .pill.queued, .pill.review_required, .pill.deployment_required, .pill.paused { color: var(--warn); border-color: #ecd797; background: #fff8df; }
    .pill.failed, .pill.error, .pill.cancelled { color: var(--bad); border-color: #f1bbb6; background: #fff1ef; }
    .summary {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 12px;
      margin-bottom: 12px;
      background: #fbfcfd;
    }
    .summary h3 {
      margin: 0 0 10px;
      font-size: 15px;
      line-height: 1.3;
    }
    .review-panel, .deployment-panel {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 12px;
      margin-bottom: 12px;
      background: #fffaf0;
    }
    .run-control-panel {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 12px;
      margin-bottom: 12px;
      background: #f7f9fa;
    }
    .review-panel[hidden], .deployment-panel[hidden] {
      display: none;
    }
    .run-control-panel[hidden] {
      display: none;
    }
    .check-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }
    .check-row input {
      width: auto;
      min-height: auto;
      padding: 0;
    }
    .event-log {
      display: grid;
      gap: 8px;
    }
    .event {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      overflow: hidden;
      background: var(--surface);
    }
    .event-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      background: #f7f9fa;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
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
      margin-top: 12px;
      color: var(--accent-2);
      font-size: 12px;
      line-height: 1.45;
      min-height: 18px;
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
    @media (max-width: 1080px) {
      main {
        grid-template-columns: 1fr;
      }
      section {
        min-height: 320px;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>Loom Harness</h1>
    <div class="status-line">
      <span id="connection">idle</span>
      <button id="refresh" class="secondary" type="button">Refresh</button>
    </div>
  </header>
  <main>
    <section>
      <div class="workspace-heading">
        <h2>Server</h2>
        <div class="heading-actions">
          <button data-testid="load-status" id="load-status" class="secondary" type="button">Load Status</button>
          <button data-testid="load-audit" id="load-audit" class="secondary" type="button">Load Audit</button>
          <button data-testid="load-brain-signals" id="load-brain-signals" class="secondary" type="button">Load Brain</button>
          <button data-testid="load-policy" id="load-policy" class="secondary" type="button">Load Policy</button>
          <button data-testid="load-escalations" id="load-escalations" class="secondary" type="button">Load Escalations</button>
        </div>
      </div>
      <div id="harness-status" class="summary">
        <div class="empty">No status loaded.</div>
      </div>
      <div data-testid="brain-feed" id="brain-feed" class="summary">
        <div class="empty">No brain signals loaded.</div>
      </div>
      <div id="policy-settings-panel" class="run-control-panel">
        <h2>Policy Settings</h2>
        <label for="policy-model-key-env">Model key env</label>
        <input id="policy-model-key-env" name="policyModelKeyEnv" placeholder="LOOM_ALICE_MODEL_KEY" autocomplete="off" />
        <label for="policy-template-parameters">Coder template parameters, one name=value per line</label>
        <textarea id="policy-template-parameters" name="policyTemplateParameters" placeholder="auth_mode=subscription&#10;owner={tenant}"></textarea>
        <label for="policy-allowed-tools">Allowed tools, one per line</label>
        <textarea id="policy-allowed-tools" name="policyAllowedTools">${ONLINE_SANDBOX_REQUIRED_TOOLS_TEXT}</textarea>
        <div class="row">
          <div>
            <label for="policy-max-active-runs">Max active runs</label>
            <input id="policy-max-active-runs" name="policyMaxActiveRuns" placeholder="2" autocomplete="off" />
          </div>
          <div>
            <label for="policy-max-workspace-sessions">Max sessions</label>
            <input id="policy-max-workspace-sessions" name="policyMaxWorkspaceSessions" placeholder="4" autocomplete="off" />
          </div>
        </div>
        <label for="policy-max-workspace-bytes">Max workspace bytes</label>
        <input id="policy-max-workspace-bytes" name="policyMaxWorkspaceBytes" placeholder="104857600" autocomplete="off" />
        <label for="policy-workspace-byte-warning">Workspace byte warning</label>
        <input id="policy-workspace-byte-warning" name="policyWorkspaceByteWarning" placeholder="83886080" autocomplete="off" />
        <div class="row">
          <div>
            <label for="policy-executor-cpus">Executor CPUs</label>
            <input id="policy-executor-cpus" name="policyExecutorCpus" placeholder="1" autocomplete="off" />
          </div>
          <div>
            <label for="policy-executor-memory">Executor memory</label>
            <input id="policy-executor-memory" name="policyExecutorMemory" placeholder="2g" autocomplete="off" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="policy-executor-pids-limit">Executor pids</label>
            <input id="policy-executor-pids-limit" name="policyExecutorPidsLimit" placeholder="128" autocomplete="off" />
          </div>
          <div>
            <label for="policy-executor-network">Executor network</label>
            <input id="policy-executor-network" name="policyExecutorNetwork" placeholder="loom-egress" autocomplete="off" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="policy-model-project-token-warning">Project token warning</label>
            <input id="policy-model-project-token-warning" name="policyModelProjectTokenWarning" placeholder="100000" autocomplete="off" />
          </div>
          <div>
            <label for="policy-model-requester-token-warning">Requester token warning</label>
            <input id="policy-model-requester-token-warning" name="policyModelRequesterTokenWarning" placeholder="50000" autocomplete="off" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="policy-model-project-token-limit">Project token limit</label>
            <input id="policy-model-project-token-limit" name="policyModelProjectTokenLimit" placeholder="200000" autocomplete="off" />
          </div>
          <div>
            <label for="policy-model-requester-token-limit">Requester token limit</label>
            <input id="policy-model-requester-token-limit" name="policyModelRequesterTokenLimit" placeholder="100000" autocomplete="off" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="policy-model-project-cost-warning">Project cost warning</label>
            <input id="policy-model-project-cost-warning" name="policyModelProjectCostWarning" placeholder="25" autocomplete="off" />
          </div>
          <div>
            <label for="policy-model-requester-cost-warning">Requester cost warning</label>
            <input id="policy-model-requester-cost-warning" name="policyModelRequesterCostWarning" placeholder="10" autocomplete="off" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="policy-model-project-cost-limit">Project cost limit</label>
            <input id="policy-model-project-cost-limit" name="policyModelProjectCostLimit" placeholder="50" autocomplete="off" />
          </div>
          <div>
            <label for="policy-model-requester-cost-limit">Requester cost limit</label>
            <input id="policy-model-requester-cost-limit" name="policyModelRequesterCostLimit" placeholder="20" autocomplete="off" />
          </div>
        </div>
        <div class="actions">
          <button data-testid="save-policy-settings" id="save-policy-settings" type="button">Save Policy Settings</button>
        </div>
        <div id="policy-settings-error" class="error" role="status"></div>
        <h2>Policy Members</h2>
        <label for="policy-key-actor">Actor</label>
        <input id="policy-key-actor" name="policyKeyActor" placeholder="teammate" autocomplete="off" />
        <label for="policy-key-role">Role</label>
        <select id="policy-key-role" name="policyKeyRole">
          <option value="developer">developer</option>
          <option value="viewer">viewer</option>
          <option value="admin">admin</option>
        </select>
        <label for="policy-key-model-env">Model key env</label>
        <input id="policy-key-model-env" name="policyKeyModelEnv" placeholder="LOOM_TEAMMATE_MODEL_KEY" autocomplete="off" />
        <label for="policy-key-token">Token</label>
        <input id="policy-key-token" name="policyKeyToken" type="password" autocomplete="new-password" />
        <div class="actions">
          <button data-testid="create-policy-key" id="create-policy-key" class="secondary" type="button">Create Key</button>
          <button data-testid="revoke-policy-key" id="revoke-policy-key" class="danger" type="button">Revoke Key</button>
        </div>
        <div id="policy-key-output" class="summary" hidden></div>
        <div id="policy-key-error" class="error" role="status"></div>
        <h2>AGS Project Agent</h2>
        <label for="agent-git-service-provision-repo">Repository</label>
        <input id="agent-git-service-provision-repo" name="agentGitServiceProvisionRepo" placeholder="team/app" autocomplete="off" />
        <div class="row">
          <div>
            <label for="agent-git-service-provision-permission">Permission</label>
            <select id="agent-git-service-provision-permission" name="agentGitServiceProvisionPermission">
              <option value="write">write</option>
              <option value="read">read</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div>
            <label for="agent-git-service-provision-token-env">Token env</label>
            <input id="agent-git-service-provision-token-env" name="agentGitServiceProvisionTokenEnv" placeholder="LOOM_AGENT_TOKEN" autocomplete="off" />
          </div>
        </div>
        <label for="agent-git-service-provision-prefix">Agent login prefix</label>
        <input id="agent-git-service-provision-prefix" name="agentGitServiceProvisionPrefix" placeholder="loom-alice-proj-a" autocomplete="off" />
        <label for="agent-git-service-provision-default-repo">Default workspace repo</label>
        <input id="agent-git-service-provision-default-repo" name="agentGitServiceProvisionDefaultRepo" placeholder="proj-a" autocomplete="off" />
        <div class="row">
          <div>
            <label for="agent-git-service-provision-identity-actor">Identity actor</label>
            <input id="agent-git-service-provision-identity-actor" name="agentGitServiceProvisionIdentityActor" placeholder="alice-agent" autocomplete="off" />
          </div>
          <div>
            <label for="agent-git-service-provision-identity-role">Identity role</label>
            <select id="agent-git-service-provision-identity-role" name="agentGitServiceProvisionIdentityRole">
              <option value="">none</option>
              <option value="developer">developer</option>
              <option value="viewer">viewer</option>
              <option value="admin">admin</option>
            </select>
          </div>
        </div>
        <label class="check-row" for="agent-git-service-provision-force">
          <input id="agent-git-service-provision-force" name="agentGitServiceProvisionForce" type="checkbox" />
          Force reprovision
        </label>
        <label class="check-row" for="agent-git-service-provision-store-token">
          <input id="agent-git-service-provision-store-token" name="agentGitServiceProvisionStoreToken" type="checkbox" />
          Store token on server
        </label>
        <div class="actions">
          <button data-testid="provision-agent-git-service" id="provision-agent-git-service" class="secondary" type="button">Provision AGS Agent</button>
        </div>
        <div id="agent-git-service-provision-output" class="summary" hidden></div>
        <div id="agent-git-service-provision-error" class="error" role="status"></div>
        <h2>AGS Tenant Plan</h2>
        <label for="agent-git-service-provisioning-plan-projects">Projects</label>
        <input id="agent-git-service-provisioning-plan-projects" name="agentGitServiceProvisioningPlanProjects" placeholder="proj-a,proj-b" autocomplete="off" />
        <label class="check-row" for="agent-git-service-provisioning-plan-eligible-only">
          <input id="agent-git-service-provisioning-plan-eligible-only" name="agentGitServiceProvisioningPlanEligibleOnly" type="checkbox" />
          Eligible projects only
        </label>
        <div class="actions">
          <button data-testid="load-agent-git-service-provisioning-plan" id="load-agent-git-service-provisioning-plan" class="secondary" type="button">Load AGS Plan</button>
          <button data-testid="load-agent-git-service-cutover-readiness" id="load-agent-git-service-cutover-readiness" class="secondary" type="button">Load AGS Cutover</button>
          <button data-testid="dry-run-agent-git-service-provisioning-plan-apply" id="dry-run-agent-git-service-provisioning-plan-apply" class="secondary" type="button">Dry Run Apply</button>
          <button data-testid="apply-agent-git-service-provisioning-plan" id="apply-agent-git-service-provisioning-plan" type="button">Apply Plan</button>
        </div>
        <div id="agent-git-service-provisioning-plan" class="summary" hidden></div>
        <div id="agent-git-service-provisioning-plan-apply-output" class="summary" hidden></div>
        <div id="agent-git-service-cutover-readiness" class="summary" hidden></div>
        <div id="agent-git-service-provisioning-plan-error" class="error" role="status"></div>
      </div>
      <div id="escalation-panel" class="run-control-panel">
        <h2>Policy Escalation</h2>
        <label for="escalation-tools">Requested tools, one per line</label>
        <textarea id="escalation-tools" name="escalationTools">shell.exec</textarea>
        <div class="row">
          <div>
            <label for="escalation-max-workspace-sessions">Max sessions</label>
            <input id="escalation-max-workspace-sessions" name="escalationMaxWorkspaceSessions" placeholder="2" autocomplete="off" />
          </div>
          <div>
            <label for="escalation-max-active-runs">Max active runs</label>
            <input id="escalation-max-active-runs" name="escalationMaxActiveRuns" placeholder="2" autocomplete="off" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="escalation-max-workspace-bytes">Max workspace bytes</label>
            <input id="escalation-max-workspace-bytes" name="escalationMaxWorkspaceBytes" placeholder="104857600" autocomplete="off" />
          </div>
          <div>
            <label for="escalation-workspace-byte-warning">Workspace byte warning</label>
            <input id="escalation-workspace-byte-warning" name="escalationWorkspaceByteWarning" placeholder="83886080" autocomplete="off" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="escalation-model-project-token-warning">Project token warning</label>
            <input id="escalation-model-project-token-warning" name="escalationModelProjectTokenWarning" placeholder="100000" autocomplete="off" />
          </div>
          <div>
            <label for="escalation-model-requester-token-warning">Requester token warning</label>
            <input id="escalation-model-requester-token-warning" name="escalationModelRequesterTokenWarning" placeholder="50000" autocomplete="off" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="escalation-model-project-token-limit">Project token limit</label>
            <input id="escalation-model-project-token-limit" name="escalationModelProjectTokenLimit" placeholder="200000" autocomplete="off" />
          </div>
          <div>
            <label for="escalation-model-requester-token-limit">Requester token limit</label>
            <input id="escalation-model-requester-token-limit" name="escalationModelRequesterTokenLimit" placeholder="100000" autocomplete="off" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="escalation-model-project-cost-warning">Project cost warning</label>
            <input id="escalation-model-project-cost-warning" name="escalationModelProjectCostWarning" placeholder="25" autocomplete="off" />
          </div>
          <div>
            <label for="escalation-model-requester-cost-warning">Requester cost warning</label>
            <input id="escalation-model-requester-cost-warning" name="escalationModelRequesterCostWarning" placeholder="10" autocomplete="off" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="escalation-model-project-cost-limit">Project cost limit</label>
            <input id="escalation-model-project-cost-limit" name="escalationModelProjectCostLimit" placeholder="50" autocomplete="off" />
          </div>
          <div>
            <label for="escalation-model-requester-cost-limit">Requester cost limit</label>
            <input id="escalation-model-requester-cost-limit" name="escalationModelRequesterCostLimit" placeholder="20" autocomplete="off" />
          </div>
        </div>
        <label for="escalation-reason">Reason</label>
        <textarea id="escalation-reason" name="escalationReason">need an interactive sandbox shell</textarea>
        <div class="actions">
          <button data-testid="request-escalation" id="request-escalation" class="secondary" type="button">Request Escalation</button>
        </div>
        <div class="row">
          <div>
            <label for="escalation-decision-id">Escalation id</label>
            <input id="escalation-decision-id" name="escalationDecisionId" autocomplete="off" />
          </div>
          <div>
            <label for="escalation-decision">Decision</label>
            <select id="escalation-decision" name="escalationDecision">
              <option value="approved">Approve</option>
              <option value="rejected">Reject</option>
            </select>
          </div>
        </div>
        <label for="escalation-decision-note">Decision note</label>
        <textarea id="escalation-decision-note" name="escalationDecisionNote"></textarea>
        <div class="actions">
          <button data-testid="decide-escalation" id="decide-escalation" type="button">Decide Escalation</button>
        </div>
        <div id="escalation-error" class="error" role="status"></div>
      </div>
      <h2>Create Run</h2>
      <form id="run-form">
        <div class="row">
          <div>
            <label for="tenant">Tenant</label>
            <input id="tenant" name="tenant" value="alice" autocomplete="off" />
          </div>
          <div>
            <label for="project">Project</label>
            <input id="project" name="project" value="default" autocomplete="off" />
          </div>
        </div>
        <label for="tenant-token">Tenant token or API key</label>
        <input id="tenant-token" name="tenantToken" type="password" autocomplete="off" />
        <label for="project-template">Project template</label>
        <select id="project-template" name="projectTemplate">
          <option value="empty">Empty</option>
          <option value="vas-lite">VAS Lite</option>
        </select>
        <label for="project-repo">Project default repo</label>
        <input id="project-repo" name="projectRepo" placeholder="team/proj-a" autocomplete="off" />
        <div class="row">
          <div>
            <label for="project-branch">Project default branch</label>
            <input id="project-branch" name="projectBranch" placeholder="feature/issue-123" autocomplete="off" />
          </div>
          <div>
            <label for="project-base-branch">Project default base branch</label>
            <input id="project-base-branch" name="projectBaseBranch" placeholder="main" autocomplete="off" />
          </div>
        </div>
        <label for="project-issue">Project default issue</label>
        <input id="project-issue" name="projectIssue" placeholder="team/proj-a#123" autocomplete="off" />
        <label for="project-default-skills">Project default skills</label>
        <textarea id="project-default-skills" name="projectDefaultSkills" placeholder="vas-lite&#10;coding"></textarea>
        <label for="project-run-preset">Project default run preset</label>
        <select id="project-run-preset" name="projectRunPreset">
          <option value="">None</option>
          <option value="vas-lite-review">VAS Lite Review</option>
        </select>
        <label for="project-run-preset-case">Project default preset case</label>
        <input id="project-run-preset-case" name="projectRunPresetCase" value="bootstrap" autocomplete="off" />
        <label class="check-row" for="project-review-required">
          <input id="project-review-required" name="projectReviewRequired" type="checkbox" />
          Require review by default
        </label>
        <label class="check-row" for="project-deployment-required">
          <input id="project-deployment-required" name="projectDeploymentRequired" type="checkbox" />
          Require deployment approval by default
        </label>
        <label for="project-contract-objective">Project contract objective</label>
        <input id="project-contract-objective" name="projectContractObjective" placeholder="Preserve the online sandbox harness-loop goal" autocomplete="off" />
        <label for="project-contract-constraints">Project contract constraints</label>
        <textarea id="project-contract-constraints" name="projectContractConstraints" placeholder="Keep harness evidence durable&#10;Keep review gates explicit"></textarea>
        <label for="project-contract-success">Project contract success criteria</label>
        <textarea id="project-contract-success" name="projectContractSuccess" placeholder="Project summary exposes the contract&#10;Run metadata carries the contract"></textarea>
        <div class="actions">
          <button data-testid="load-projects" id="load-projects" class="secondary" type="button">Load Projects</button>
          <button data-testid="load-model-usage-warnings" id="load-model-usage-warnings" class="secondary" type="button">Load Model Warnings</button>
          <button data-testid="load-workspace-usage-warnings" id="load-workspace-usage-warnings" class="secondary" type="button">Load Workspace Warnings</button>
          <button data-testid="create-project" id="create-project" class="secondary" type="button">Create Project</button>
          <button data-testid="save-project-source-defaults" id="save-project-source-defaults" class="secondary" type="button">Save Defaults</button>
          <button data-testid="save-project-default-skills" id="save-project-default-skills" class="secondary" type="button">Save Skills</button>
          <button data-testid="save-project-run-policy" id="save-project-run-policy" class="secondary" type="button">Save Policy</button>
          <button data-testid="save-project-contract" id="save-project-contract" class="secondary" type="button">Save Contract</button>
        </div>
        <div id="project-list" class="project-list">
          <div class="empty">No projects loaded.</div>
        </div>
        <div id="project-concurrency-board" class="project-list">
          <div class="empty">No project concurrency loaded.</div>
        </div>
        <div id="model-usage-warnings" class="project-list">
          <div class="empty">No model usage warnings loaded.</div>
        </div>
        <div id="workspace-usage-warnings" class="project-list">
          <div class="empty">No workspace usage warnings loaded.</div>
        </div>
        <div class="actions">
          <button data-testid="load-vas-cases" id="load-vas-cases" class="secondary" type="button">Load VAS Cases</button>
          <button data-testid="load-vas-review-queue" id="load-vas-review-queue" class="secondary" type="button">Load Review Queue</button>
          <button data-testid="load-vas-learnings" id="load-vas-learnings" class="secondary" type="button">Load VAS Learnings</button>
          <button data-testid="load-vas-artifacts" id="load-vas-artifacts" class="secondary" type="button">Load VAS Artifacts</button>
          <button data-testid="load-vas-case-runs" id="load-vas-case-runs" class="secondary" type="button">Load VAS Case Runs</button>
          <button data-testid="load-vas-review-package" id="load-vas-review-package" class="secondary" type="button">Load Review Package</button>
          <button data-testid="start-vas-review-run" id="start-vas-review-run" class="secondary" type="button">Start VAS Review</button>
        </div>
        <label for="vas-review-run-reviewer">VAS review-run reviewer commands, one per line</label>
        <textarea id="vas-review-run-reviewer" name="vasReviewRunReviewer"></textarea>
        <div id="vas-case-list" class="project-list">
          <div class="empty">No VAS cases loaded.</div>
        </div>
        <div id="vas-review-queue" class="project-list">
          <div class="empty">No VAS review queue loaded.</div>
        </div>
        <div id="vas-learning-list" class="project-list">
          <div class="empty">No VAS learnings loaded.</div>
        </div>
        <div id="vas-case-run-list" class="project-list">
          <div class="empty">No VAS case runs loaded.</div>
        </div>
        <div id="vas-artifact-view" class="summary">
          <div class="empty">No VAS artifacts loaded.</div>
        </div>
        <div id="vas-review-package" class="summary">
          <div class="empty">No VAS review package loaded.</div>
        </div>
        <div class="row">
          <div>
            <label for="vas-case-id">VAS case id</label>
            <input id="vas-case-id" name="vasCaseId" placeholder="segment-001" autocomplete="off" />
          </div>
          <div>
            <label for="vas-case-source-url">VAS source URL</label>
            <input id="vas-case-source-url" name="vasCaseSourceUrl" placeholder="clip://segment-001" autocomplete="off" />
          </div>
        </div>
        <label for="vas-case-issue">VAS issue</label>
        <input id="vas-case-issue" name="vasCaseIssue" placeholder="team/proj-a#123" autocomplete="off" />
        <label for="vas-case-repo">VAS repo</label>
        <input id="vas-case-repo" name="vasCaseRepo" placeholder="team/proj-a" autocomplete="off" />
        <div class="row">
          <div>
            <label for="vas-case-branch">VAS branch</label>
            <input id="vas-case-branch" name="vasCaseBranch" placeholder="vas/segment-001" autocomplete="off" />
          </div>
          <div>
            <label for="vas-case-base-branch">VAS base branch</label>
            <input id="vas-case-base-branch" name="vasCaseBaseBranch" placeholder="main" autocomplete="off" />
          </div>
        </div>
        <div class="actions">
          <button data-testid="create-vas-case" id="create-vas-case" class="secondary" type="button">Create VAS Case</button>
          <button data-testid="claim-vas-case" id="claim-vas-case" class="secondary" type="button">Claim VAS Case</button>
          <button data-testid="release-vas-case" id="release-vas-case" class="secondary" type="button">Release Claim</button>
        </div>
        <div class="row">
          <div>
            <label for="vas-review-decision">VAS review decision</label>
            <select id="vas-review-decision" name="vasReviewDecision">
              <option value="approved">Approve</option>
              <option value="changes_requested">Request Changes</option>
            </select>
          </div>
          <div>
            <label for="vas-review-note">VAS review note</label>
            <input id="vas-review-note" name="vasReviewNote" placeholder="state sequence is trustworthy" autocomplete="off" />
          </div>
        </div>
        <label for="vas-review-corrections">VAS corrections, one per line</label>
        <textarea id="vas-review-corrections" name="vasReviewCorrections"></textarea>
        <label for="vas-review-learnings">VAS learnings, one per line</label>
        <textarea id="vas-review-learnings" name="vasReviewLearnings"></textarea>
        <div class="actions">
          <button data-testid="review-vas-case" id="review-vas-case" class="secondary" type="button">Review VAS Case</button>
        </div>
        <label for="project-presence-label">Presence name</label>
        <input id="project-presence-label" autocomplete="name" />
        <div data-testid="project-presence" id="project-presence" class="project-list">
          <div class="empty">No collaborators online.</div>
        </div>
        <div data-testid="project-activity" id="project-activity" class="event-log">
          <div class="empty">No project activity loaded.</div>
        </div>
        <label for="repo">Repo URL</label>
        <input id="repo" name="repo" placeholder="https://git.internal/team/proj-a.git" autocomplete="off" />
        <div class="row">
          <div>
            <label for="branch">Branch</label>
            <input id="branch" name="branch" placeholder="task/proj-a-123" autocomplete="off" />
          </div>
          <div>
            <label for="base-branch">Base branch</label>
            <input id="base-branch" name="baseBranch" placeholder="origin/main" autocomplete="off" />
          </div>
        </div>
        <label for="issue">Issue</label>
        <input id="issue" name="issue" placeholder="team/proj-a#123" autocomplete="off" />
        <label class="check-row" for="sync-issue-comments-on-create">
          <input id="sync-issue-comments-on-create" name="syncIssueCommentsOnCreate" type="checkbox" />
          Seed existing issue comments
        </label>
        <label class="check-row" for="pull-request">
          <input id="pull-request" name="pullRequest" type="checkbox" />
          Create review PR
        </label>
        <label class="check-row" for="review-required">
          <input id="review-required" name="reviewRequired" type="checkbox" />
          Require human review
        </label>
        <label class="check-row" for="deployment-required">
          <input id="deployment-required" name="deploymentRequired" type="checkbox" />
          Require deployment approval
        </label>
        <label for="goal">Goal</label>
        <textarea id="goal" name="goal">create hello.txt</textarea>
        <label for="run-preset">Run preset</label>
        <select id="run-preset" name="runPreset">
          <option value="">Custom</option>
          <option value="vas-lite-review">VAS Lite Review</option>
        </select>
        <label for="run-preset-case">Preset case</label>
        <input id="run-preset-case" name="runPresetCase" value="bootstrap" autocomplete="off" />
        <label for="agent-mode">Agent</label>
        <select id="agent-mode" name="agentMode">
          <option value="script">Scripted demo</option>
          <option value="model">Configured model</option>
        </select>
        <label for="model">Model</label>
        <input id="model" name="model" placeholder="kimi-k2.6" autocomplete="off" />
        <label for="model-protocol">Model protocol</label>
        <select id="model-protocol" name="modelProtocol">
          <option value="json">JSON AgentStep</option>
          <option value="tool-call">Tool call</option>
        </select>
        <label for="verify">Verification commands, one per line</label>
        <textarea id="verify" name="verify">test -f hello.txt</textarea>
        <label for="evaluate">Evaluator commands, one per line</label>
        <textarea id="evaluate" name="evaluate"></textarea>
        <label for="reviewer">Reviewer commands, one per line</label>
        <textarea id="reviewer" name="reviewer"></textarea>
        <label for="allowed-tools">Allowed tools, one per line</label>
        <textarea id="allowed-tools" name="allowedTools">${ONLINE_SANDBOX_REQUIRED_TOOLS_TEXT}</textarea>
        <label for="script">Scripted steps JSON</label>
        <textarea id="script" name="script">[
  {
    "message": "write hello.txt",
    "actions": [
      {
        "toolName": "file.write",
        "input": { "path": "hello.txt", "content": "hello from dashboard\\n" }
      }
    ]
  },
  { "message": "finish", "finish": true }
]</textarea>
        <div class="actions">
          <button data-testid="create-run" id="create-run" type="submit">Start Run</button>
          <button id="load-runs" class="secondary" type="button">Load Runs</button>
        </div>
        <div id="form-error" class="error" role="status"></div>
      </form>
    </section>
    <section>
      <h2>Runs</h2>
      <div id="run-list" class="run-list">
        <div class="empty">No runs loaded.</div>
      </div>
      <div class="workspace-panel">
        <div class="workspace-heading">
          <h2>Workspace</h2>
          <div class="heading-actions">
            <button data-testid="load-files" id="load-files" class="secondary" type="button">Load Files</button>
            <button data-testid="load-diff" id="load-diff" class="secondary" type="button">Load Diff</button>
          </div>
        </div>
        <div id="workspace-context" class="summary">
          <div class="empty">Workspace context not loaded.</div>
        </div>
        <pre id="workspace-diff" class="command-output" hidden></pre>
        <label for="workspace-commit-message">Commit message</label>
        <input id="workspace-commit-message" autocomplete="off" value="workspace checkpoint" />
        <div class="actions">
          <button data-testid="commit-workspace" id="commit-workspace" class="secondary" type="button">Commit</button>
        </div>
        <label for="workspace-pr-issue">PR issue</label>
        <input id="workspace-pr-issue" autocomplete="off" placeholder="owner/repo#42" />
        <label for="workspace-pr-branch">PR branch</label>
        <input id="workspace-pr-branch" autocomplete="off" placeholder="task/change" />
        <label for="workspace-pr-base">PR base branch</label>
        <input id="workspace-pr-base" autocomplete="off" placeholder="main" />
        <label class="checkbox">
          <input id="workspace-pr-review" type="checkbox" />
          Require review gate
        </label>
        <label class="checkbox">
          <input id="workspace-pr-deployment" type="checkbox" />
          Require deployment gate
        </label>
        <div class="actions">
          <button data-testid="handoff-pr" id="handoff-pr" class="secondary" type="button">Handoff PR</button>
          <button data-testid="request-pr-escalation" id="workspace-pr-escalation" class="secondary" type="button">Request git.pr</button>
        </div>
        <div id="workspace-path" class="meta workspace-path">/</div>
        <label for="workspace-new-file-path">New file path</label>
        <input id="workspace-new-file-path" autocomplete="off" placeholder="src/new-file.txt" />
        <div class="actions">
          <button data-testid="new-file" id="new-file" class="secondary" type="button">New File</button>
        </div>
        <div id="workspace-files" class="file-list">
          <div class="empty">No files loaded.</div>
        </div>
        <div id="workspace-file-editor" class="file-editor" hidden>
          <div id="workspace-file-name" class="meta workspace-path"></div>
          <textarea id="workspace-file-content" name="workspaceFileContent" spellcheck="false"></textarea>
          <div class="actions">
            <button data-testid="save-file" id="save-file" type="button">Save File</button>
            <button data-testid="move-file" id="move-file" class="secondary" type="button" disabled>Move File</button>
            <button data-testid="delete-file" id="delete-file" class="danger" type="button" disabled>Delete File</button>
            <button data-testid="reload-file" id="reload-file" class="secondary" type="button" disabled>Reload Latest</button>
          </div>
        </div>
        <div id="workspace-error" class="error" role="status"></div>
      </div>
      <div class="command-panel">
        <div class="workspace-heading">
          <h2>Command</h2>
          <div class="heading-actions">
            <button data-testid="load-commands" id="load-commands" class="secondary" type="button">Load Commands</button>
            <button data-testid="load-sessions" id="load-sessions" class="secondary" type="button">Load Sessions</button>
          </div>
        </div>
        <label for="workspace-command">Workspace command</label>
        <textarea id="workspace-command" name="workspaceCommand">pwd && ls</textarea>
        <div class="actions">
          <button data-testid="run-command" id="run-command" type="button">Run Command</button>
          <button data-testid="start-session" id="start-session" class="secondary" type="button">Start Session</button>
          <button data-testid="stop-session" id="stop-session" class="secondary" type="button" disabled>Stop Session</button>
        </div>
        <div id="workspace-commands" class="command-list">
          <div class="empty">No commands loaded.</div>
        </div>
        <div id="workspace-sessions" class="session-list">
          <div class="empty">No sessions loaded.</div>
        </div>
        <pre id="command-output" class="command-output" hidden></pre>
        <label for="terminal-input">Session input</label>
        <textarea id="terminal-input" name="terminalInput">pwd
</textarea>
        <div class="actions">
          <button data-testid="send-session-input" id="send-session-input" class="secondary" type="button" disabled>Send Input</button>
        </div>
        <pre id="terminal-output" class="command-output" hidden></pre>
        <div id="command-error" class="error" role="status"></div>
      </div>
    </section>
    <section>
      <h2>Run Detail</h2>
      <div id="summary" class="summary">
        <div class="empty">Select or create a run.</div>
      </div>
      <div id="run-control-panel" class="run-control-panel" hidden>
        <div class="actions">
          <button data-testid="resume-run" id="resume-run" type="button">Resume Run</button>
          <button data-testid="cancel-run" id="cancel-run" class="danger" type="button">Cancel Run</button>
          <button data-testid="abandon-run" id="abandon-run" class="secondary" type="button" hidden>Abandon Run</button>
        </div>
        <div id="cancel-error" class="error" role="status"></div>
      </div>
      <div id="review-panel" class="review-panel" hidden>
        <label for="review-note">Review note</label>
        <textarea id="review-note" name="reviewNote"></textarea>
        <label for="review-contract-objective">Contract patch objective</label>
        <input id="review-contract-objective" name="reviewContractObjective" autocomplete="off" />
        <label for="review-contract-constraints">Contract patch constraints</label>
        <textarea id="review-contract-constraints" name="reviewContractConstraints" placeholder="one constraint per line"></textarea>
        <label for="review-contract-success">Contract patch success criteria</label>
        <textarea id="review-contract-success" name="reviewContractSuccess" placeholder="one success criterion per line"></textarea>
        <label class="check-row" for="review-merge">
          <input id="review-merge" name="reviewMerge" type="checkbox" />
          Merge linked PR
        </label>
        <div class="actions">
          <button data-testid="review-claim" id="review-claim" class="secondary" type="button">Claim Review</button>
          <button data-testid="review-release-claim" id="review-release-claim" class="secondary" type="button">Release Claim</button>
          <button data-testid="review-approve" id="review-approve" type="button">Approve</button>
          <button data-testid="review-reject" id="review-reject" class="danger" type="button">Reject</button>
        </div>
        <div id="review-error" class="error" role="status"></div>
      </div>
      <div id="deployment-panel" class="deployment-panel" hidden>
        <label for="deployment-note">Deployment note</label>
        <textarea id="deployment-note" name="deploymentNote"></textarea>
        <div class="actions">
          <button data-testid="deployment-approve" id="deployment-approve" type="button">Approve Deploy</button>
          <button data-testid="deployment-reject" id="deployment-reject" class="danger" type="button">Reject Deploy</button>
        </div>
        <div id="deployment-error" class="error" role="status"></div>
      </div>
      <div class="actions">
        <button data-testid="load-replay" id="load-replay" class="secondary" type="button">Load Replay</button>
        <button data-testid="load-review-summary" id="load-review-summary" class="secondary" type="button">Load Review Summary</button>
        <button data-testid="load-handoff-package" id="load-handoff-package" class="secondary" type="button">Load Package</button>
        <button data-testid="load-handoff-followups" id="load-handoff-followups" class="secondary" type="button">Load Follow-Ups</button>
        <button data-testid="start-handoff-followup" id="start-handoff-followup" type="button">Start Follow-Up</button>
      </div>
      <label for="run-comment">Run comment</label>
      <input id="run-comment" autocomplete="off" />
      <label class="check-row" for="run-comment-pause">
        <input id="run-comment-pause" type="checkbox" />
        Pause after current step
      </label>
      <div class="actions">
        <button data-testid="send-run-comment" id="send-run-comment" class="secondary" type="button">Send Comment</button>
        <button data-testid="sync-issue-comments" id="sync-issue-comments" class="secondary" type="button">Sync Issue Comments</button>
      </div>
      <div id="handoff-package" class="summary">
        <div class="empty">No handoff package loaded.</div>
      </div>
      <div id="handoff-followups" class="summary">
        <div class="empty">No follow-up lineage loaded.</div>
      </div>
      <div id="review-summary" class="summary">
        <div class="empty">No review summary loaded.</div>
      </div>
      <div id="run-replay" class="event-log">
        <div class="empty">No replay loaded.</div>
      </div>
      <div id="event-log" class="event-log"></div>
    </section>
  </main>
  <script>
    const VAS_LITE_PROJECT_DEFAULT_SKILLS = ${JSON.stringify(VAS_LITE_PROJECT_DEFAULT_SKILLS_TEXT)};
    const HARNESS_VISION_LOCK_TARGET = ${JSON.stringify(HARNESS_VISION_LOCK_TARGET_TEXT)};
    const VAS_LITE_PROJECT_CONSTRAINTS = ${JSON.stringify(VAS_LITE_PROJECT_CONSTRAINTS_TEXT)};
    const VAS_LITE_PROJECT_SUCCESS = ${JSON.stringify(VAS_LITE_PROJECT_SUCCESS_TEXT)};
    const state = { clientId: dashboardClientId(), harnessStatus: null, globalReadiness: null, globalVisionLock: null, tenantAccess: null, tenantPolicy: null, tenantEscalations: [], pendingEscalationSource: null, auditEvents: [], brainSignals: [], auditStream: null, projects: [], modelUsageWarningProjects: [], workspaceUsageWarningProjects: [], vasCases: [], vasReviewQueue: [], vasLearnings: [], vasArtifacts: null, vasReviewPackage: null, vasCaseRuns: [], vasCaseRunSource: null, projectPresence: [], presenceFocus: "", runs: [], selected: null, requestedRunId: "", events: [], replay: null, reviewSummary: null, handoffPackage: null, handoffFollowups: null, evidenceRefresh: {}, stream: null, terminalSessionId: null, terminalStream: null, workspaceSessionEvents: [], selectedCommandId: null, workspaceInfo: null, workspaceDiff: null, workspacePath: "", workspaceEntries: [], workspaceFile: null, workspaceCommands: [], workspaceSessions: [] };
    const selectedReplayRefreshAuditTypes = new Set([
      "queued_run_recovered",
      "queued_run_recovery_failed",
      "run_started",
      "run_finished",
      "run_handoff_followup_created",
      "run_handoff_followup_denied",
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
    const projectRefreshAuditTypes = new Set([
      "project_created",
      "project_source_defaults_updated",
      "vas_case_created",
      "vas_case_claimed",
      "vas_case_reviewed",
      "run_created",
      "queued_run_recovered",
      "queued_run_recovery_failed",
      "run_started",
      "run_finished",
      "run_handoff_followup_created",
      "run_handoff_followup_denied",
      "run_comment_added",
      "run_issue_comments_synced",
      "run_resumed",
      "run_cancelled",
      "run_abandoned",
      "run_review_claimed",
      "review_decided",
      "deployment_decided",
      "stale_run_auto_abandoned",
      "project_default_skills_updated",
      "project_run_policy_updated",
      "project_contract_updated",
      "workspace_file_written",
      "workspace_file_moved",
      "workspace_file_deleted",
      "workspace_file_conflicted",
      "workspace_commit_created",
      "workspace_pull_request_created",
      "workspace_command_ran",
      "workspace_session_started",
      "workspace_session_stopped",
      "workspace_session_exited"
    ]);
    const form = document.getElementById("run-form");
    const loadStatusButton = document.getElementById("load-status");
    const loadAuditButton = document.getElementById("load-audit");
    const loadBrainSignalsButton = document.getElementById("load-brain-signals");
    const loadPolicyButton = document.getElementById("load-policy");
    const loadEscalationsButton = document.getElementById("load-escalations");
    const harnessStatus = document.getElementById("harness-status");
    const brainFeed = document.getElementById("brain-feed");
    const policyModelKeyEnvInput = document.getElementById("policy-model-key-env");
    const policyTemplateParametersInput = document.getElementById("policy-template-parameters");
    const policyAllowedToolsInput = document.getElementById("policy-allowed-tools");
    const policyMaxActiveRunsInput = document.getElementById("policy-max-active-runs");
    const policyMaxWorkspaceSessionsInput = document.getElementById("policy-max-workspace-sessions");
    const policyMaxWorkspaceBytesInput = document.getElementById("policy-max-workspace-bytes");
    const policyWorkspaceByteWarningInput = document.getElementById("policy-workspace-byte-warning");
    const policyExecutorCpusInput = document.getElementById("policy-executor-cpus");
    const policyExecutorMemoryInput = document.getElementById("policy-executor-memory");
    const policyExecutorPidsLimitInput = document.getElementById("policy-executor-pids-limit");
    const policyExecutorNetworkInput = document.getElementById("policy-executor-network");
    const policyModelProjectTokenWarningInput = document.getElementById("policy-model-project-token-warning");
    const policyModelRequesterTokenWarningInput = document.getElementById("policy-model-requester-token-warning");
    const policyModelProjectTokenLimitInput = document.getElementById("policy-model-project-token-limit");
    const policyModelRequesterTokenLimitInput = document.getElementById("policy-model-requester-token-limit");
    const policyModelProjectCostWarningInput = document.getElementById("policy-model-project-cost-warning");
    const policyModelRequesterCostWarningInput = document.getElementById("policy-model-requester-cost-warning");
    const policyModelProjectCostLimitInput = document.getElementById("policy-model-project-cost-limit");
    const policyModelRequesterCostLimitInput = document.getElementById("policy-model-requester-cost-limit");
    const savePolicySettingsButton = document.getElementById("save-policy-settings");
    const policySettingsError = document.getElementById("policy-settings-error");
    const policyKeyActorInput = document.getElementById("policy-key-actor");
    const policyKeyRoleInput = document.getElementById("policy-key-role");
    const policyKeyModelEnvInput = document.getElementById("policy-key-model-env");
    const policyKeyTokenInput = document.getElementById("policy-key-token");
    const createPolicyKeyButton = document.getElementById("create-policy-key");
    const revokePolicyKeyButton = document.getElementById("revoke-policy-key");
    const policyKeyOutput = document.getElementById("policy-key-output");
    const policyKeyError = document.getElementById("policy-key-error");
    const agentGitServiceProvisionRepoInput = document.getElementById("agent-git-service-provision-repo");
    const agentGitServiceProvisionPermissionInput = document.getElementById("agent-git-service-provision-permission");
    const agentGitServiceProvisionTokenEnvInput = document.getElementById("agent-git-service-provision-token-env");
    const agentGitServiceProvisionPrefixInput = document.getElementById("agent-git-service-provision-prefix");
    const agentGitServiceProvisionDefaultRepoInput = document.getElementById("agent-git-service-provision-default-repo");
    const agentGitServiceProvisionIdentityActorInput = document.getElementById("agent-git-service-provision-identity-actor");
    const agentGitServiceProvisionIdentityRoleInput = document.getElementById("agent-git-service-provision-identity-role");
    const agentGitServiceProvisionForceInput = document.getElementById("agent-git-service-provision-force");
    const agentGitServiceProvisionStoreTokenInput = document.getElementById("agent-git-service-provision-store-token");
    const provisionAgentGitServiceButton = document.getElementById("provision-agent-git-service");
    const agentGitServiceProvisionOutput = document.getElementById("agent-git-service-provision-output");
    const agentGitServiceProvisionError = document.getElementById("agent-git-service-provision-error");
    const loadAgentGitServiceProvisioningPlanButton = document.getElementById("load-agent-git-service-provisioning-plan");
    const loadAgentGitServiceCutoverReadinessButton = document.getElementById("load-agent-git-service-cutover-readiness");
    const dryRunAgentGitServiceProvisioningPlanApplyButton = document.getElementById("dry-run-agent-git-service-provisioning-plan-apply");
    const applyAgentGitServiceProvisioningPlanButton = document.getElementById("apply-agent-git-service-provisioning-plan");
    const agentGitServiceProvisioningPlanProjectsInput = document.getElementById("agent-git-service-provisioning-plan-projects");
    const agentGitServiceProvisioningPlanEligibleOnlyInput = document.getElementById("agent-git-service-provisioning-plan-eligible-only");
    const agentGitServiceProvisioningPlan = document.getElementById("agent-git-service-provisioning-plan");
    const agentGitServiceProvisioningPlanApplyOutput = document.getElementById("agent-git-service-provisioning-plan-apply-output");
    const agentGitServiceCutoverReadiness = document.getElementById("agent-git-service-cutover-readiness");
    const agentGitServiceProvisioningPlanError = document.getElementById("agent-git-service-provisioning-plan-error");
    const escalationToolsInput = document.getElementById("escalation-tools");
    const escalationMaxWorkspaceSessionsInput = document.getElementById("escalation-max-workspace-sessions");
    const escalationMaxActiveRunsInput = document.getElementById("escalation-max-active-runs");
    const escalationMaxWorkspaceBytesInput = document.getElementById("escalation-max-workspace-bytes");
    const escalationWorkspaceByteWarningInput = document.getElementById("escalation-workspace-byte-warning");
    const escalationModelProjectTokenWarningInput = document.getElementById("escalation-model-project-token-warning");
    const escalationModelRequesterTokenWarningInput = document.getElementById("escalation-model-requester-token-warning");
    const escalationModelProjectTokenLimitInput = document.getElementById("escalation-model-project-token-limit");
    const escalationModelRequesterTokenLimitInput = document.getElementById("escalation-model-requester-token-limit");
    const escalationModelProjectCostWarningInput = document.getElementById("escalation-model-project-cost-warning");
    const escalationModelRequesterCostWarningInput = document.getElementById("escalation-model-requester-cost-warning");
    const escalationModelProjectCostLimitInput = document.getElementById("escalation-model-project-cost-limit");
    const escalationModelRequesterCostLimitInput = document.getElementById("escalation-model-requester-cost-limit");
    const escalationReasonInput = document.getElementById("escalation-reason");
    const requestEscalationButton = document.getElementById("request-escalation");
    const escalationDecisionIdInput = document.getElementById("escalation-decision-id");
    const escalationDecisionInput = document.getElementById("escalation-decision");
    const escalationDecisionNoteInput = document.getElementById("escalation-decision-note");
    const decideEscalationButton = document.getElementById("decide-escalation");
    const escalationError = document.getElementById("escalation-error");
    const tenantInput = document.getElementById("tenant");
    const projectInput = document.getElementById("project");
    const projectTemplateInput = document.getElementById("project-template");
    const projectRepoInput = document.getElementById("project-repo");
    const projectBranchInput = document.getElementById("project-branch");
    const projectBaseBranchInput = document.getElementById("project-base-branch");
    const projectIssueInput = document.getElementById("project-issue");
    const projectDefaultSkillsInput = document.getElementById("project-default-skills");
    const projectRunPresetInput = document.getElementById("project-run-preset");
    const projectRunPresetCaseInput = document.getElementById("project-run-preset-case");
    const projectReviewRequiredInput = document.getElementById("project-review-required");
    const projectDeploymentRequiredInput = document.getElementById("project-deployment-required");
    const projectContractObjectiveInput = document.getElementById("project-contract-objective");
    const projectContractConstraintsInput = document.getElementById("project-contract-constraints");
    const projectContractSuccessInput = document.getElementById("project-contract-success");
    const loadModelUsageWarningsButton = document.getElementById("load-model-usage-warnings");
    const loadWorkspaceUsageWarningsButton = document.getElementById("load-workspace-usage-warnings");
    const loadVasCasesButton = document.getElementById("load-vas-cases");
    const loadVasReviewQueueButton = document.getElementById("load-vas-review-queue");
    const loadVasLearningsButton = document.getElementById("load-vas-learnings");
    const loadVasArtifactsButton = document.getElementById("load-vas-artifacts");
    const loadVasCaseRunsButton = document.getElementById("load-vas-case-runs");
    const loadVasReviewPackageButton = document.getElementById("load-vas-review-package");
    const startVasReviewRunButton = document.getElementById("start-vas-review-run");
    const createVasCaseButton = document.getElementById("create-vas-case");
    const claimVasCaseButton = document.getElementById("claim-vas-case");
    const releaseVasCaseButton = document.getElementById("release-vas-case");
    const reviewVasCaseButton = document.getElementById("review-vas-case");
    const vasCaseList = document.getElementById("vas-case-list");
    const vasReviewQueueList = document.getElementById("vas-review-queue");
    const vasLearningList = document.getElementById("vas-learning-list");
    const vasArtifactView = document.getElementById("vas-artifact-view");
    const vasReviewPackageView = document.getElementById("vas-review-package");
    const vasCaseRunList = document.getElementById("vas-case-run-list");
    const vasCaseIdInput = document.getElementById("vas-case-id");
    const vasCaseSourceUrlInput = document.getElementById("vas-case-source-url");
    const vasCaseIssueInput = document.getElementById("vas-case-issue");
    const vasCaseRepoInput = document.getElementById("vas-case-repo");
    const vasCaseBranchInput = document.getElementById("vas-case-branch");
    const vasCaseBaseBranchInput = document.getElementById("vas-case-base-branch");
    const vasReviewDecisionInput = document.getElementById("vas-review-decision");
    const vasReviewNoteInput = document.getElementById("vas-review-note");
    const vasReviewCorrectionsInput = document.getElementById("vas-review-corrections");
    const vasReviewLearningsInput = document.getElementById("vas-review-learnings");
    const vasReviewRunReviewerInput = document.getElementById("vas-review-run-reviewer");
    const tenantTokenInput = document.getElementById("tenant-token");
    const repoInput = document.getElementById("repo");
    const branchInput = document.getElementById("branch");
    const baseBranchInput = document.getElementById("base-branch");
    const issueInput = document.getElementById("issue");
    const syncIssueCommentsOnCreateInput = document.getElementById("sync-issue-comments-on-create");
    const pullRequestInput = document.getElementById("pull-request");
    const reviewRequiredInput = document.getElementById("review-required");
    const deploymentRequiredInput = document.getElementById("deployment-required");
    const goalInput = document.getElementById("goal");
    const runPresetInput = document.getElementById("run-preset");
    const runPresetCaseInput = document.getElementById("run-preset-case");
    const agentModeInput = document.getElementById("agent-mode");
    const modelInput = document.getElementById("model");
    const modelProtocolInput = document.getElementById("model-protocol");
    const verifyInput = document.getElementById("verify");
    const evaluateInput = document.getElementById("evaluate");
    const reviewerInput = document.getElementById("reviewer");
    const allowedToolsInput = document.getElementById("allowed-tools");
    const scriptInput = document.getElementById("script");
    const createRunButton = document.getElementById("create-run");
    const createProjectButton = document.getElementById("create-project");
    const saveProjectSourceDefaultsButton = document.getElementById("save-project-source-defaults");
    const saveProjectDefaultSkillsButton = document.getElementById("save-project-default-skills");
    const saveProjectRunPolicyButton = document.getElementById("save-project-run-policy");
    const saveProjectContractButton = document.getElementById("save-project-contract");
    const formError = document.getElementById("form-error");
    const projectList = document.getElementById("project-list");
    const projectConcurrencyBoard = document.getElementById("project-concurrency-board");
    const modelUsageWarningsList = document.getElementById("model-usage-warnings");
    const workspaceUsageWarningsList = document.getElementById("workspace-usage-warnings");
    const projectPresenceLabelInput = document.getElementById("project-presence-label");
    const projectPresence = document.getElementById("project-presence");
    const projectActivity = document.getElementById("project-activity");
    const runList = document.getElementById("run-list");
    const workspaceContext = document.getElementById("workspace-context");
    const workspaceDiff = document.getElementById("workspace-diff");
    const workspaceCommitMessageInput = document.getElementById("workspace-commit-message");
    const commitWorkspaceButton = document.getElementById("commit-workspace");
    const workspacePrIssueInput = document.getElementById("workspace-pr-issue");
    const workspacePrBranchInput = document.getElementById("workspace-pr-branch");
    const workspacePrBaseInput = document.getElementById("workspace-pr-base");
    const workspacePrReviewInput = document.getElementById("workspace-pr-review");
    const workspacePrDeploymentInput = document.getElementById("workspace-pr-deployment");
    const handoffPrButton = document.getElementById("handoff-pr");
    const workspacePrEscalationButton = document.getElementById("workspace-pr-escalation");
    const workspacePathEl = document.getElementById("workspace-path");
    const workspaceNewFilePathInput = document.getElementById("workspace-new-file-path");
    const workspaceFiles = document.getElementById("workspace-files");
    const workspaceFileEditor = document.getElementById("workspace-file-editor");
    const workspaceFileName = document.getElementById("workspace-file-name");
    const workspaceFileContent = document.getElementById("workspace-file-content");
    const newFileButton = document.getElementById("new-file");
    const saveFileButton = document.getElementById("save-file");
    const moveFileButton = document.getElementById("move-file");
    const deleteFileButton = document.getElementById("delete-file");
    const reloadFileButton = document.getElementById("reload-file");
    const workspaceError = document.getElementById("workspace-error");
    const workspaceCommandInput = document.getElementById("workspace-command");
    const runCommandButton = document.getElementById("run-command");
    const loadCommandsButton = document.getElementById("load-commands");
    const workspaceCommands = document.getElementById("workspace-commands");
    const loadSessionsButton = document.getElementById("load-sessions");
    const workspaceSessions = document.getElementById("workspace-sessions");
    const startSessionButton = document.getElementById("start-session");
    const stopSessionButton = document.getElementById("stop-session");
    const sendSessionInputButton = document.getElementById("send-session-input");
    const terminalInput = document.getElementById("terminal-input");
    const commandOutput = document.getElementById("command-output");
    const terminalOutput = document.getElementById("terminal-output");
    const commandError = document.getElementById("command-error");
    const summaryEl = document.getElementById("summary");
    const runControlPanel = document.getElementById("run-control-panel");
    const resumeRunButton = document.getElementById("resume-run");
    const cancelRunButton = document.getElementById("cancel-run");
    const abandonRunButton = document.getElementById("abandon-run");
    const cancelError = document.getElementById("cancel-error");
    const reviewPanel = document.getElementById("review-panel");
    const reviewNoteInput = document.getElementById("review-note");
    const reviewContractObjectiveInput = document.getElementById("review-contract-objective");
    const reviewContractConstraintsInput = document.getElementById("review-contract-constraints");
    const reviewContractSuccessInput = document.getElementById("review-contract-success");
    const reviewMergeInput = document.getElementById("review-merge");
    const reviewClaimButton = document.getElementById("review-claim");
    const reviewReleaseClaimButton = document.getElementById("review-release-claim");
    const reviewApproveButton = document.getElementById("review-approve");
    const reviewRejectButton = document.getElementById("review-reject");
    const reviewError = document.getElementById("review-error");
    const deploymentPanel = document.getElementById("deployment-panel");
    const deploymentNoteInput = document.getElementById("deployment-note");
    const deploymentApproveButton = document.getElementById("deployment-approve");
    const deploymentRejectButton = document.getElementById("deployment-reject");
    const deploymentError = document.getElementById("deployment-error");
    const loadReplayButton = document.getElementById("load-replay");
    const loadReviewSummaryButton = document.getElementById("load-review-summary");
    const loadHandoffPackageButton = document.getElementById("load-handoff-package");
    const loadHandoffFollowupsButton = document.getElementById("load-handoff-followups");
    const startHandoffFollowupButton = document.getElementById("start-handoff-followup");
    const runCommentInput = document.getElementById("run-comment");
    const runCommentPauseInput = document.getElementById("run-comment-pause");
    const sendRunCommentButton = document.getElementById("send-run-comment");
    const syncIssueCommentsButton = document.getElementById("sync-issue-comments");
    const handoffPackage = document.getElementById("handoff-package");
    const handoffFollowups = document.getElementById("handoff-followups");
    const reviewSummary = document.getElementById("review-summary");
    const runReplay = document.getElementById("run-replay");
    const eventLog = document.getElementById("event-log");
    const connection = document.getElementById("connection");

    applyDashboardQueryParams();
    scrubTokenFromBrowserUrl();
    document.getElementById("refresh").addEventListener("click", refreshDashboard);
    loadStatusButton.addEventListener("click", loadHarnessStatus);
    loadAuditButton.addEventListener("click", loadTenantAudit);
    loadBrainSignalsButton.addEventListener("click", loadBrainSignals);
    loadPolicyButton.addEventListener("click", loadTenantPolicy);
    savePolicySettingsButton.addEventListener("click", saveTenantPolicySettings);
    createPolicyKeyButton.addEventListener("click", createTenantPolicyKey);
    revokePolicyKeyButton.addEventListener("click", revokeTenantPolicyKey);
    provisionAgentGitServiceButton.addEventListener("click", provisionAgentGitServiceProjectAgent);
    loadAgentGitServiceProvisioningPlanButton.addEventListener("click", loadAgentGitServiceProvisioningPlan);
    loadAgentGitServiceCutoverReadinessButton.addEventListener("click", loadAgentGitServiceCutoverReadiness);
    dryRunAgentGitServiceProvisioningPlanApplyButton.addEventListener("click", () => applyAgentGitServiceProvisioningPlan(true));
    applyAgentGitServiceProvisioningPlanButton.addEventListener("click", () => applyAgentGitServiceProvisioningPlan(false));
    loadEscalationsButton.addEventListener("click", loadTenantEscalations);
    requestEscalationButton.addEventListener("click", requestTenantEscalation);
    decideEscalationButton.addEventListener("click", decideTenantEscalation);
    document.getElementById("load-projects").addEventListener("click", loadProjects);
    loadModelUsageWarningsButton.addEventListener("click", () => loadModelUsageWarnings());
    loadWorkspaceUsageWarningsButton.addEventListener("click", () => loadWorkspaceUsageWarnings());
    createProjectButton.addEventListener("click", createProject);
    projectTemplateInput.addEventListener("change", applyProjectTemplateDefaults);
    saveProjectSourceDefaultsButton.addEventListener("click", saveProjectSourceDefaults);
    saveProjectDefaultSkillsButton.addEventListener("click", saveProjectDefaultSkills);
    saveProjectRunPolicyButton.addEventListener("click", saveProjectRunPolicy);
    saveProjectContractButton.addEventListener("click", saveProjectContract);
    loadVasCasesButton.addEventListener("click", () => loadVasCases());
    loadVasReviewQueueButton.addEventListener("click", () => loadVasReviewQueue());
    loadVasLearningsButton.addEventListener("click", () => loadVasLearnings());
    loadVasArtifactsButton.addEventListener("click", () => loadVasArtifacts());
    loadVasCaseRunsButton.addEventListener("click", () => loadVasCaseRuns());
    loadVasReviewPackageButton.addEventListener("click", () => loadVasReviewPackage());
    startVasReviewRunButton.addEventListener("click", startVasReviewRun);
    createVasCaseButton.addEventListener("click", createVasCase);
    claimVasCaseButton.addEventListener("click", claimVasCase);
    releaseVasCaseButton.addEventListener("click", releaseVasCase);
    reviewVasCaseButton.addEventListener("click", reviewVasCase);
    document.getElementById("load-runs").addEventListener("click", loadRuns);
    document.getElementById("load-files").addEventListener("click", () => loadWorkspaceFiles(""));
    document.getElementById("load-diff").addEventListener("click", loadWorkspaceDiff);
    commitWorkspaceButton.addEventListener("click", commitWorkspaceChanges);
    handoffPrButton.addEventListener("click", handoffWorkspacePullRequest);
    workspacePrEscalationButton.addEventListener("click", requestWorkspacePrEscalation);
    newFileButton.addEventListener("click", newWorkspaceFile);
    saveFileButton.addEventListener("click", saveWorkspaceFile);
    moveFileButton.addEventListener("click", moveWorkspaceFile);
    deleteFileButton.addEventListener("click", deleteWorkspaceFile);
    reloadFileButton.addEventListener("click", reloadWorkspaceFile);
    runCommandButton.addEventListener("click", runWorkspaceCommand);
    loadCommandsButton.addEventListener("click", loadWorkspaceCommands);
    loadSessionsButton.addEventListener("click", loadWorkspaceSessions);
    startSessionButton.addEventListener("click", startWorkspaceSession);
    sendSessionInputButton.addEventListener("click", sendWorkspaceSessionInput);
    stopSessionButton.addEventListener("click", stopWorkspaceSession);
    resumeRunButton.addEventListener("click", resumeRun);
    cancelRunButton.addEventListener("click", cancelRun);
    abandonRunButton.addEventListener("click", abandonRun);
    harnessStatus.addEventListener("click", (event) => {
      const target = event.target.closest('[data-action="abandon-stale"]');
      if (!target) return;
      abandonStaleRun(target.dataset.project, target.dataset.runId);
    });
    reviewClaimButton.addEventListener("click", claimReview);
    reviewReleaseClaimButton.addEventListener("click", releaseReview);
    reviewApproveButton.addEventListener("click", () => reviewRun("approved"));
    reviewRejectButton.addEventListener("click", () => reviewRun("rejected"));
    deploymentApproveButton.addEventListener("click", () => deploymentRun("approved"));
    deploymentRejectButton.addEventListener("click", () => deploymentRun("rejected"));
    loadReplayButton.addEventListener("click", loadReplay);
    loadReviewSummaryButton.addEventListener("click", loadReviewSummary);
    loadHandoffPackageButton.addEventListener("click", loadHandoffPackage);
    loadHandoffFollowupsButton.addEventListener("click", loadHandoffFollowups);
    startHandoffFollowupButton.addEventListener("click", startHandoffFollowup);
    sendRunCommentButton.addEventListener("click", sendRunComment);
    syncIssueCommentsButton.addEventListener("click", syncIssueComments);
    form.addEventListener("submit", createRun);
    tenantTokenInput.addEventListener("change", refreshTenantAccess);
    tenantInput.addEventListener("change", () => {
      state.selected = null;
      state.requestedRunId = "";
      syncDashboardUrl();
      refreshTenantAccess();
    });
    projectInput.addEventListener("change", () => {
      state.selected = null;
      state.requestedRunId = "";
      syncDashboardUrl();
      refreshProjectPresence();
    });
    vasCaseIdInput.addEventListener("input", applyAccessControls);
    projectPresenceLabelInput.value = state.clientId;
    projectPresenceLabelInput.addEventListener("change", () => {
      void heartbeatProjectPresence();
    });
    applyAccessControls();
    refreshDashboard();
    setInterval(heartbeatProjectPresence, 15000);

    function tenant() { return tenantInput.value.trim() || "alice"; }
    function project() { return projectInput.value.trim() || "default"; }
    function currentProjectSummary() { return state.projects.find((item) => item.project === project()); }
    function selectedProjectDefinesDefaultSkills() {
      const summary = currentProjectSummary();
      return Boolean(summary && Object.prototype.hasOwnProperty.call(summary, "defaultSkills"));
    }
    function applyProjectTemplateDefaults() {
      if (projectTemplateInput.value !== "vas-lite") return;
      if (!projectDefaultSkillsInput.value.trim()) projectDefaultSkillsInput.value = VAS_LITE_PROJECT_DEFAULT_SKILLS;
      if (!projectRunPresetInput.value) projectRunPresetInput.value = "vas-lite-review";
      if (!projectRunPresetCaseInput.value.trim()) projectRunPresetCaseInput.value = "bootstrap";
      projectReviewRequiredInput.checked = true;
      if (!projectContractObjectiveInput.value.trim()) projectContractObjectiveInput.value = HARNESS_VISION_LOCK_TARGET;
      if (!projectContractConstraintsInput.value.trim()) projectContractConstraintsInput.value = VAS_LITE_PROJECT_CONSTRAINTS;
      if (!projectContractSuccessInput.value.trim()) projectContractSuccessInput.value = VAS_LITE_PROJECT_SUCCESS;
    }
    function applyDashboardQueryParams() {
      const params = new URLSearchParams(window.location.search);
      const requestedTenant = params.get("tenant");
      const requestedProject = params.get("project");
      const requestedToken = params.get("token");
      const requestedRunId = params.get("runId");
      if (requestedTenant) tenantInput.value = requestedTenant;
      if (requestedProject) projectInput.value = requestedProject;
      if (requestedToken) tenantTokenInput.value = requestedToken;
      if (requestedRunId) state.requestedRunId = requestedRunId;
    }
    function scrubTokenFromBrowserUrl() {
      const params = new URLSearchParams(window.location.search);
      if (!params.has("token")) return;
      params.delete("token");
      const text = params.toString();
      const nextUrl = \`\${window.location.pathname}\${text ? "?" + text : ""}\${window.location.hash || ""}\`;
      window.history.replaceState(null, "", nextUrl);
    }
    function syncDashboardUrl() {
      const params = new URLSearchParams(window.location.search);
      params.delete("token");
      params.set("tenant", tenant());
      params.set("project", project());
      if (state.selected && state.selected.runId) params.set("runId", state.selected.runId);
      else params.delete("runId");
      const text = params.toString();
      const nextUrl = \`\${window.location.pathname}\${text ? "?" + text : ""}\`;
      window.history.replaceState(null, "", nextUrl);
    }
    function queryString(extra = {}) {
      const params = new URLSearchParams();
      if (project() !== "default") params.set("project", project());
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
      }
      const text = params.toString();
      return text ? "?" + text : "";
    }
    function queryStringForProject(runProject, extra = {}) {
      const params = new URLSearchParams();
      const value = runProject || project();
      if (value !== "default") params.set("project", value);
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
      }
      const text = params.toString();
      return text ? "?" + text : "";
    }
    function authHeaders(base = {}) {
      const token = tenantTokenInput.value.trim();
      return token ? { ...base, authorization: \`Bearer \${token}\` } : base;
    }
    function issueCommentsSyncSummary(data) {
      const parts = [\`synced \${data.synced || 0} issue comments\`];
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
    function dashboardClientId() {
      const key = "loom-dashboard-client-id";
      const existing = window.localStorage.getItem(key);
      if (existing) return existing;
      const value = crypto.randomUUID ? crypto.randomUUID() : "dashboard-" + Date.now();
      window.localStorage.setItem(key, value);
      return value;
    }
    function accessUrl() { return \`/tenants/\${tenant()}/access\`; }
    function globalStatusUrl() { return "/status"; }
    function statusUrl() { return \`/tenants/\${tenant()}/status\`; }
    function projectsUrl() { return \`/tenants/\${tenant()}/projects\`; }
    function modelUsageWarningsUrl() { return \`/tenants/\${tenant()}/model-usage/warnings\`; }
    function workspaceUsageWarningsUrl() { return \`/tenants/\${tenant()}/workspace-usage/warnings\`; }
    function createProjectUrl() { return \`/tenants/\${tenant()}/projects\`; }
    function saveProjectSourceDefaultsUrl() { return \`/tenants/\${tenant()}/projects/\${project()}/source-defaults\`; }
    function saveProjectDefaultSkillsUrl() { return \`/tenants/\${tenant()}/projects/\${project()}/default-skills\`; }
    function saveProjectRunPolicyUrl() { return \`/tenants/\${tenant()}/projects/\${project()}/run-policy\`; }
    function saveProjectContractUrl() { return \`/tenants/\${tenant()}/projects/\${project()}/contract\`; }
    function vasCasesUrl() { return \`/tenants/\${tenant()}/projects/\${project()}/vas/cases\`; }
    function vasReviewQueueUrl() { return \`/tenants/\${tenant()}/projects/\${project()}/vas/review-queue\`; }
    function vasLearningsUrl() { return \`/tenants/\${tenant()}/projects/\${project()}/vas/learnings\`; }
    function vasCaseArtifactsUrl(caseId) { return \`/tenants/\${tenant()}/projects/\${project()}/vas/cases/\${encodeURIComponent(caseId)}/artifacts\`; }
    function vasCaseRunsUrl(caseId) { return \`/tenants/\${tenant()}/projects/\${project()}/vas/cases/\${encodeURIComponent(caseId)}/runs\`; }
    function vasCaseReviewPackageUrl(caseId) { return \`/tenants/\${tenant()}/projects/\${project()}/vas/cases/\${encodeURIComponent(caseId)}/review-package\`; }
    function vasCaseReviewUrl(caseId) { return \`/tenants/\${tenant()}/projects/\${project()}/vas/cases/\${encodeURIComponent(caseId)}/review\`; }
    function vasCaseReviewRunsUrl(caseId) { return \`/tenants/\${tenant()}/projects/\${project()}/vas/cases/\${encodeURIComponent(caseId)}/review-runs\`; }
    function vasCaseClaimUrl(caseId) { return \`/tenants/\${tenant()}/projects/\${project()}/vas/cases/\${encodeURIComponent(caseId)}/claim\`; }
    function projectPresenceUrl() { return \`/tenants/\${tenant()}/projects/\${project()}/presence\`; }
    function auditUrl(stream = false, after = 0) {
      const params = new URLSearchParams();
      if (after > 0) params.set("after", String(after));
      if (stream && tenantTokenInput.value.trim()) params.set("token", tenantTokenInput.value.trim());
      const text = params.toString();
      return \`/tenants/\${tenant()}/audit\${stream ? "/stream" : ""}\${text ? "?" + text : ""}\`;
    }
    function brainSignalsUrl() {
      const params = new URLSearchParams();
      params.set("project", project());
      params.set("limit", "20");
      const text = params.toString();
      return \`/tenants/\${tenant()}/brain/signals\${text ? "?" + text : ""}\`;
    }
    function policyUrl() { return \`/tenants/\${tenant()}/policy\`; }
    function policySettingsUrl() { return \`/tenants/\${tenant()}/policy/settings\`; }
    function policyApiKeysUrl() { return \`/tenants/\${tenant()}/policy/api-keys\`; }
    function policyApiKeyRevokeUrl() { return \`/tenants/\${tenant()}/policy/api-keys/revoke\`; }
    function agentGitServiceProvisionUrl() { return \`/tenants/\${tenant()}/projects/\${project()}/control-plane/agent-git-service/provision\`; }
    function agentGitServiceProvisioningPlanUrl() { return \`/tenants/\${tenant()}/control-plane/agent-git-service/provisioning-plan\`; }
    function agentGitServiceProvisioningPlanApplyUrl() { return \`/tenants/\${tenant()}/control-plane/agent-git-service/provisioning-plan/apply\`; }
    function agentGitServiceCutoverReadinessUrl() { return \`/tenants/\${tenant()}/control-plane/cutover-readiness?targetProvider=agent-git-service\`; }
    function escalationsUrl() { return \`/tenants/\${tenant()}/policy/escalations\`; }
    function escalationDecisionUrl(escalationId) { return \`/tenants/\${tenant()}/policy/escalations/\${encodeURIComponent(escalationId)}/decision\`; }
    function runsUrl() { return \`/tenants/\${tenant()}/runs\${queryString()}\`; }
    function workspaceInfoUrl() {
      if (state.selected && state.selected.runId) {
        const params = new URLSearchParams();
        const runProject = state.selected.metadata && state.selected.metadata.project ? state.selected.metadata.project : project();
        if (runProject !== "default") params.set("project", runProject);
        const text = params.toString();
        return \`/tenants/\${tenant()}/runs/\${state.selected.runId}/workspace\${text ? "?" + text : ""}\`;
      }
      return \`/tenants/\${tenant()}/projects/\${project()}/workspace\`;
    }
    function workspaceDiffUrl() {
      if (state.selected && state.selected.runId) {
        const params = new URLSearchParams();
        const runProject = state.selected.metadata && state.selected.metadata.project ? state.selected.metadata.project : project();
        if (runProject !== "default") params.set("project", runProject);
        const text = params.toString();
        return \`/tenants/\${tenant()}/runs/\${state.selected.runId}/diff\${text ? "?" + text : ""}\`;
      }
      return \`/tenants/\${tenant()}/projects/\${project()}/diff\`;
    }
    function workspaceCommitUrl() {
      if (state.selected && state.selected.runId) {
        const params = new URLSearchParams();
        const runProject = state.selected.metadata && state.selected.metadata.project ? state.selected.metadata.project : project();
        if (runProject !== "default") params.set("project", runProject);
        const text = params.toString();
        return \`/tenants/\${tenant()}/runs/\${state.selected.runId}/commits\${text ? "?" + text : ""}\`;
      }
      return \`/tenants/\${tenant()}/projects/\${project()}/commits\`;
    }
    function workspacePullRequestUrl() {
      if (state.selected && state.selected.runId) {
        const params = new URLSearchParams();
        const runProject = state.selected.metadata && state.selected.metadata.project ? state.selected.metadata.project : project();
        if (runProject !== "default") params.set("project", runProject);
        const text = params.toString();
        return \`/tenants/\${tenant()}/runs/\${state.selected.runId}/pull-requests\${text ? "?" + text : ""}\`;
      }
      return \`/tenants/\${tenant()}/projects/\${project()}/pull-requests\`;
    }
    function reviewSummaryUrl() {
      if (!state.selected) return "";
      const params = new URLSearchParams();
      const runProject = state.selected.metadata && state.selected.metadata.project ? state.selected.metadata.project : project();
      if (runProject !== "default") params.set("project", runProject);
      const text = params.toString();
      return \`/tenants/\${tenant()}/runs/\${state.selected.runId}/review-summary\${text ? "?" + text : ""}\`;
    }
    function handoffPackageUrl() {
      if (!state.selected) return "";
      const params = new URLSearchParams();
      const runProject = state.selected.metadata && state.selected.metadata.project ? state.selected.metadata.project : project();
      if (runProject !== "default") params.set("project", runProject);
      const text = params.toString();
      return \`/tenants/\${tenant()}/runs/\${state.selected.runId}/handoff-package\${text ? "?" + text : ""}\`;
    }
    function handoffFollowupUrl() {
      if (!state.selected) return "";
      const runProject = state.selected.metadata && state.selected.metadata.project ? state.selected.metadata.project : project();
      return \`/tenants/\${tenant()}/runs/\${state.selected.runId}/handoff-runs\${queryStringForProject(runProject)}\`;
    }
    function runCommentUrl() {
      if (!state.selected) return "";
      const runProject = state.selected.metadata && state.selected.metadata.project ? state.selected.metadata.project : project();
      return \`/tenants/\${tenant()}/runs/\${state.selected.runId}/comments\${queryStringForProject(runProject)}\`;
    }
    function projectRunCommentUrl(runProject, runId) {
      return \`/tenants/\${tenant()}/runs/\${runId}/comments\${queryStringForProject(runProject)}\`;
    }
    function issueCommentsSyncUrl() {
      if (!state.selected) return "";
      const runProject = state.selected.metadata && state.selected.metadata.project ? state.selected.metadata.project : project();
      return \`/tenants/\${tenant()}/runs/\${state.selected.runId}/issue-comments/sync\${queryStringForProject(runProject)}\`;
    }
    function workspaceFilesUrl(path = "") {
      const params = new URLSearchParams();
      if (path) params.set("path", path);
      const text = params.toString();
      if (state.selected && state.selected.runId) {
        const runProject = state.selected.metadata && state.selected.metadata.project ? state.selected.metadata.project : project();
        if (runProject !== "default") params.set("project", runProject);
        const runText = params.toString();
        return \`/tenants/\${tenant()}/runs/\${state.selected.runId}/files\${runText ? "?" + runText : ""}\`;
      }
      return \`/tenants/\${tenant()}/projects/\${project()}/files\${text ? "?" + text : ""}\`;
    }
    function workspaceFileMoveUrl() {
      if (state.selected && state.selected.runId) {
        const params = new URLSearchParams();
        const runProject = state.selected.metadata && state.selected.metadata.project ? state.selected.metadata.project : project();
        if (runProject !== "default") params.set("project", runProject);
        const text = params.toString();
        return \`/tenants/\${tenant()}/runs/\${state.selected.runId}/files/move\${text ? "?" + text : ""}\`;
      }
      return \`/tenants/\${tenant()}/projects/\${project()}/files/move\`;
    }
    function workspaceCommandsUrl() {
      if (state.selected && state.selected.runId) {
        const params = new URLSearchParams();
        const runProject = state.selected.metadata && state.selected.metadata.project ? state.selected.metadata.project : project();
        if (runProject !== "default") params.set("project", runProject);
        const text = params.toString();
        return \`/tenants/\${tenant()}/runs/\${state.selected.runId}/commands\${text ? "?" + text : ""}\`;
      }
      return \`/tenants/\${tenant()}/projects/\${project()}/commands\`;
    }
    function workspaceSessionsUrl() {
      if (state.selected && state.selected.runId) {
        const params = new URLSearchParams();
        const runProject = state.selected.metadata && state.selected.metadata.project ? state.selected.metadata.project : project();
        if (runProject !== "default") params.set("project", runProject);
        const text = params.toString();
        return \`/tenants/\${tenant()}/runs/\${state.selected.runId}/sessions\${text ? "?" + text : ""}\`;
      }
      return \`/tenants/\${tenant()}/projects/\${project()}/sessions\`;
    }
    function workspaceSessionActionUrl(action, stream = false, extra = {}) {
      const sessionId = state.terminalSessionId;
      const params = new URLSearchParams();
      if (state.selected && state.selected.runId) {
        const runProject = state.selected.metadata && state.selected.metadata.project ? state.selected.metadata.project : project();
        if (runProject !== "default") params.set("project", runProject);
      }
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
      }
      if (stream && tenantTokenInput.value.trim()) params.set("token", tenantTokenInput.value.trim());
      const text = params.toString();
      if (state.selected && state.selected.runId) {
        return \`/tenants/\${tenant()}/runs/\${state.selected.runId}/sessions/\${sessionId}/\${action}\${stream ? "/stream" : ""}\${text ? "?" + text : ""}\`;
      }
      return \`/tenants/\${tenant()}/projects/\${project()}/sessions/\${sessionId}/\${action}\${stream ? "/stream" : ""}\${text ? "?" + text : ""}\`;
    }
    function runUrl(runId) { return \`/tenants/\${tenant()}/runs/\${runId}\${queryString()}\`; }
    function cancelUrl(runId) { return \`/tenants/\${tenant()}/runs/\${runId}/cancel\${queryString()}\`; }
    function projectRunCancelUrl(runProject, runId) { return \`/tenants/\${tenant()}/runs/\${runId}/cancel\${queryStringForProject(runProject)}\`; }
    function resumeUrl(runId) { return \`/tenants/\${tenant()}/runs/\${runId}/resume\${queryString()}\`; }
    function abandonUrl(runId) { return \`/tenants/\${tenant()}/runs/\${runId}/abandon\${queryString()}\`; }
    function abandonStaleUrl(runId, runProject) { return \`/tenants/\${tenant()}/runs/\${runId}/abandon-stale\${queryStringForProject(runProject)}\`; }
    function reviewUrl(runId) { return \`/tenants/\${tenant()}/runs/\${runId}/review\${queryString()}\`; }
    function reviewClaimUrl(runId) { return \`/tenants/\${tenant()}/runs/\${runId}/review-claim\${queryString()}\`; }
    function deploymentUrl(runId) { return \`/tenants/\${tenant()}/runs/\${runId}/deployment\${queryString()}\`; }
    function replayUrl(runId) { return \`/tenants/\${tenant()}/runs/\${runId}/replay\${queryString()}\`; }
    function workbenchUrl(run) {
      const runProject = run.metadata && run.metadata.project ? run.metadata.project : project();
      return workbenchRunUrl(runProject, run.runId);
    }
    function workbenchRunUrl(runProject, runId) {
      const params = new URLSearchParams();
      params.set("tenant", tenant());
      params.set("project", runProject);
      params.set("runId", runId);
      return \`/workbench?\${params.toString()}\`;
    }
    function handoffSourcePackageUrl(metadata) {
      if (!(metadata && metadata.handoffSourceRunId)) return "";
      if (metadata.handoffSourceHandoffPackageUrl) return metadata.handoffSourceHandoffPackageUrl;
      const sourceProject = metadata.handoffSourceProject || project();
      return \`/tenants/\${tenant()}/runs/\${metadata.handoffSourceRunId}/handoff-package\${queryStringForProject(sourceProject)}\`;
    }
    function renderHandoffSourceLinks(metadata) {
      if (!(metadata && metadata.handoffSourceRunId)) return "";
      const sourceProject = metadata.handoffSourceProject || project();
      const packageUrl = handoffSourcePackageUrl(metadata);
      return \`
        <span>source \${escapeHtml(metadata.handoffSourceRunId)}</span>
        <a href="\${escapeAttr(workbenchRunUrl(sourceProject, metadata.handoffSourceRunId))}" target="_blank" rel="noreferrer">Source Workbench</a>
        \${packageUrl ? \`<a href="\${escapeAttr(packageUrl)}" target="_blank" rel="noreferrer">Source Package</a>\` : ""}
      \`;
    }
    function renderProjectRunPolicyEvidence(metadata) {
      const evidence = metadata && metadata.projectRunPolicy;
      if (!(evidence && Array.isArray(evidence.fields) && evidence.fields.length)) return "";
      const fields = new Set(evidence.fields);
      return \`
        \${fields.has("preset") && evidence.preset ? \`<span>policy preset \${escapeHtml(evidence.preset)}</span>\` : ""}
        \${fields.has("presetInput") && evidence.presetInput && evidence.presetInput.caseId ? \`<span>policy case \${escapeHtml(evidence.presetInput.caseId)}</span>\` : ""}
        \${fields.has("reviewRequired") ? '<span class="pill review_required">policy review</span>' : ""}
        \${fields.has("deploymentRequired") ? '<span class="pill deployment_required">policy deploy</span>' : ""}
      \`;
    }
    function renderProjectContractEvidence(metadata) {
      const contract = metadata && (metadata.projectContract || (metadata.metadata && metadata.metadata.projectContract));
      const contractStatus = metadata && (metadata.projectContractStatus || (metadata.metadata && metadata.metadata.projectContractStatus));
      if (!contract && !contractStatus) return "";
      const missing = contractStatus && Array.isArray(contractStatus.missing) && contractStatus.missing.length
        ? contractStatus.missing.join(", ")
        : "unknown";
      return \`
        \${contractStatus ? contractStatus.ok ? '<span class="pill passed">contract ready</span>' : \`<span class="pill failed">contract missing \${escapeHtml(missing)}</span>\` : ""}
        \${contract && contract.objective ? \`<span>contract \${escapeHtml(contract.objective)}</span>\` : ""}
        \${contract && Array.isArray(contract.constraints) && contract.constraints.length ? \`<span>\${escapeHtml(contract.constraints.length)} constraints</span>\` : ""}
        \${contract && Array.isArray(contract.successCriteria) && contract.successCriteria.length ? \`<span>\${escapeHtml(contract.successCriteria.length)} success criteria</span>\` : ""}
      \`;
    }
    function renderProjectContractStatus(project) {
      const contractStatus = project && project.contractStatus;
      if (!contractStatus) return "";
      if (contractStatus.ok) return '<span class="pill passed">contract ready</span>';
      const missing = Array.isArray(contractStatus.missing) && contractStatus.missing.length
        ? contractStatus.missing.join(", ")
        : "unknown";
      return \`<span class="pill failed">contract missing \${escapeHtml(missing)}</span>\`;
    }
    function eventsUrl(runId, after = 0) {
      return \`/tenants/\${tenant()}/runs/\${runId}/events\${queryString({ after })}\`;
    }
    function streamUrl(runId, after = 0) {
      return \`/tenants/\${tenant()}/runs/\${runId}/events/stream\${queryString({ after, token: tenantTokenInput.value.trim() })}\`;
    }

    async function createRun(event) {
      event.preventDefault();
      if (!canMutate()) {
        formError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      formError.textContent = "";
      createRunButton.disabled = true;
      try {
        const body = {
          async: true,
          tenant: tenant(),
          project: project()
        };
        body.preset = optionalValue(runPresetInput);
        if (body.preset) body.presetInput = { caseId: optionalValue(runPresetCaseInput) || "bootstrap" };
        if (!body.preset || goalInput.value.trim() !== "create hello.txt") body.goal = goalInput.value.trim();
        if (!body.preset || verifyInput.value.trim() !== "test -f hello.txt") body.verify = lines(verifyInput.value);
        if (!body.preset && !selectedProjectDefinesDefaultSkills()) body.skills = ["coding"];
        body.clientId = state.clientId;
        body.queue = true;
        body.evaluate = lines(evaluateInput.value);
        body.reviewer = lines(reviewerInput.value);
        body.allowedTools = lines(allowedToolsInput.value);
        body.repo = optionalValue(repoInput);
        body.branch = optionalValue(branchInput);
        body.baseBranch = optionalValue(baseBranchInput);
        body.issue = optionalValue(issueInput);
        body.syncIssueComments = syncIssueCommentsOnCreateInput.checked;
        body.pullRequest = pullRequestInput.checked;
        body.reviewRequired = reviewRequiredInput.checked;
        body.deploymentRequired = deploymentRequiredInput.checked;
        if (!body.preset && agentModeInput.value === "model") {
          body.model = modelInput.value.trim();
          body.modelProtocol = modelProtocolInput.value;
        } else if (!body.preset) {
          body.script = JSON.parse(scriptInput.value);
        }
        const response = await fetch("/runs", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "run creation failed");
        state.selected = data;
        await loadTenantAudit();
        await loadRuns();
        await selectRun(data.runId, true);
        await loadWorkspaceFiles("");
      } catch (error) {
        formError.textContent = error.message;
      } finally {
        createRunButton.disabled = !canMutate();
      }
    }

    async function refreshDashboard() {
      await loadTenantAccess();
      await loadHarnessStatus();
      await loadTenantAudit();
      await loadBrainSignals({ quiet: true });
      await loadProjects();
      await loadModelUsageWarnings(true);
      await loadWorkspaceUsageWarnings(true);
      await loadVasCases(true);
      await loadVasReviewQueue(true);
      await loadVasLearnings(true);
      await heartbeatProjectPresence();
      await loadProjectPresence();
      await loadRuns();
      if (state.requestedRunId) {
        await selectRun(state.requestedRunId);
        state.requestedRunId = "";
        return;
      }
      await loadWorkspaceInfo();
    }

    function refreshProjectPresence() {
      state.projectPresence = [];
      state.presenceFocus = "";
      state.vasCases = [];
      state.vasReviewQueue = [];
      state.vasLearnings = [];
      state.vasArtifacts = null;
      state.vasReviewPackage = null;
      state.vasCaseRuns = [];
      state.vasCaseRunSource = null;
      state.brainSignals = [];
      renderVasCases();
      renderVasReviewQueue();
      renderVasLearnings();
      renderVasArtifacts();
      renderVasReviewPackage();
      renderVasCaseRuns();
      renderBrainSignals();
      renderProjectPresence();
      renderProjectActivity();
      void heartbeatProjectPresence();
      void loadProjectPresence();
      void loadVasCases(true);
      void loadVasReviewQueue(true);
    }

    function refreshTenantAccess() {
      closeTenantAuditStream();
      state.tenantAccess = null;
      state.harnessStatus = null;
      state.globalReadiness = null;
      state.auditEvents = [];
      state.brainSignals = [];
      state.projectPresence = [];
      state.presenceFocus = "";
      state.modelUsageWarningProjects = [];
      state.workspaceUsageWarningProjects = [];
      state.vasCases = [];
      state.vasReviewQueue = [];
      state.vasLearnings = [];
      state.vasArtifacts = null;
      state.vasReviewPackage = null;
      state.vasCaseRuns = [];
      state.vasCaseRunSource = null;
      applyAccessControls();
      renderHarnessStatus();
      renderModelUsageWarnings();
      renderVasCases();
      renderVasReviewQueue();
      renderVasLearnings();
      renderVasArtifacts();
      renderVasReviewPackage();
      renderVasCaseRuns();
      renderBrainSignals();
      renderProjectPresence();
      renderProjectActivity();
      void refreshDashboard();
    }

    async function loadTenantAccess() {
      try {
        const response = await fetch(accessUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load tenant access");
        state.tenantAccess = data;
      } catch (error) {
        state.tenantAccess = null;
      } finally {
        applyAccessControls();
      }
    }

    async function loadHarnessStatus(options = {}) {
      const quiet = options.quiet === true;
      if (!quiet) connection.textContent = "loading status";
      try {
        const response = await fetch(statusUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load status");
        state.harnessStatus = data;
        await loadGlobalHarnessStatus();
        renderHarnessStatus();
        renderProjects();
        renderRuns();
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        if (!quiet) {
          connection.textContent = "error";
          state.harnessStatus = null;
          renderHarnessStatusError(error.message);
          renderProjects();
          renderRuns();
        }
      }
    }

    async function loadGlobalHarnessStatus() {
      try {
        const response = await fetch(globalStatusUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load global status");
        state.globalReadiness = data.readiness || null;
        state.globalVisionLock = data.visionLock || null;
      } catch (_error) {
        state.globalReadiness = null;
        state.globalVisionLock = null;
      }
    }

    async function loadTenantAudit() {
      connection.textContent = "loading audit";
      try {
        const response = await fetch(auditUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load tenant audit");
        state.auditEvents = Array.isArray(data) ? data : [];
        renderHarnessStatus();
        renderProjectActivity();
        startTenantAuditStream();
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        state.auditEvents = [];
        renderHarnessStatus();
        renderProjectActivity();
        closeTenantAuditStream();
      }
    }

    async function loadBrainSignals(options = {}) {
      const quiet = options.quiet === true;
      if (!quiet) connection.textContent = "loading brain";
      try {
        const response = await fetch(brainSignalsUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load brain signals");
        state.brainSignals = Array.isArray(data.signals) ? data.signals : [];
        renderBrainSignals();
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        state.brainSignals = [];
        renderBrainSignals(error.message || "failed to load brain signals");
        if (!quiet) connection.textContent = "error";
      }
    }

    function renderBrainSignals() {
      const message = arguments[0] || "No brain signals loaded.";
      const signals = Array.isArray(state.brainSignals) ? state.brainSignals : [];
      brainFeed.innerHTML = signals.length ? \`
        <div class="summary-grid">
          \${signals.slice(-12).reverse().map((signal) => \`<span>\${escapeHtml(formatBrainSignalEntry(signal))}</span>\`).join("")}
        </div>
      \` : \`<div class="empty">\${escapeHtml(message)}</div>\`;
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

    function startTenantAuditStream() {
      closeTenantAuditStream();
      const after = tenantAuditEventsAfter();
      state.auditStream = new EventSource(auditUrl(true, after));
      state.auditStream.addEventListener("tenant_audit", (message) => {
        const event = JSON.parse(message.data);
        handleTenantAuditEvent(event);
      });
    }

    function handleTenantAuditEvent(event) {
      if (isLoadedTenantAuditEvent(event)) return;
      state.auditEvents = state.auditEvents.concat(event).slice(-100);
      renderHarnessStatus();
      renderProjectActivity();
      refreshProjectsForAudit(event);
      refreshRunsForAudit(event);
      refreshWorkspaceListsForAudit(event);
      if (event.type === "brain_signal_ingested" && event.data && event.data.project === project()) {
        void loadBrainSignals({ quiet: true });
      }
    }

    function tenantAuditEventsAfter() {
      return state.auditEvents.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
    }

    function isLoadedTenantAuditEvent(event) {
      const seq = Number(event && event.seq);
      return Number.isFinite(seq) && state.auditEvents.some((entry) => Number(entry.seq) === seq);
    }

    function isCurrentProjectAuditEvent(event) {
      return event.data?.project === project();
    }

    function isLoadedHandoffFollowupAuditEvent(event) {
      if (!state.handoffFollowups || !Array.isArray(state.handoffFollowups.followupRuns)) return false;
      const data = event && event.data ? event.data : {};
      const auditRunId = data.followupRunId || data.runId;
      return Boolean(auditRunId && state.handoffFollowups.followupRuns.some((run) => run && run.runId === auditRunId));
    }

    function refreshRunsForAudit(event) {
      if (!isCurrentProjectAuditEvent(event)) return;
      if (!["run_created", "queued_run_recovered", "queued_run_recovery_failed", "run_started", "run_finished", "run_handoff_followup_created", "run_handoff_followup_denied", "run_comment_added", "run_issue_comments_synced", "run_resumed", "run_cancelled", "run_abandoned", "run_review_claimed", "review_decided", "deployment_decided", "stale_run_auto_abandoned", "workspace_pull_request_created"].includes(event.type)) return;
      void loadRuns({ quiet: true });
      void loadHarnessStatus({ quiet: true });
      if (event.type === "run_created" && event.data?.preset === "vas-lite-review") {
        void loadVasReviewQueue(true);
      }
      if (event.type === "run_created" && event.data?.presetInput?.caseId === vasCaseIdInput.value.trim()) {
        void loadVasArtifacts(true);
        void loadVasCaseRuns(true);
        void loadVasReviewPackage(true);
      }
      const selectedAuditRunId = event.data?.followupRunId === state.selected?.runId ? event.data.followupRunId : event.data?.runId;
      if (state.selected && selectedAuditRunId === state.selected.runId) {
        void refreshSelected(selectedAuditRunId);
        if (selectedReplayRefreshAuditTypes.has(event.type)) {
          void refreshSelectedEvents();
          if (state.replay) void loadReplay({ quiet: true });
          if (state.reviewSummary) void loadReviewSummary({ quiet: true });
        }
        if (state.handoffPackage) void loadHandoffPackage({ quiet: true });
      }
      if (state.handoffFollowups && (event.type === "run_handoff_followup_created" || event.type === "run_handoff_followup_denied" || isLoadedHandoffFollowupAuditEvent(event))) void loadHandoffFollowups({ quiet: true });
    }

    function refreshProjectsForAudit(event) {
      if (projectRefreshAuditTypes.has(event.type)) {
        void loadProjects({ quiet: true });
        void loadModelUsageWarnings(true);
        void loadWorkspaceUsageWarnings(true);
      }
      if (!isCurrentProjectAuditEvent(event)) return;
      if (event.type === "project_created") {
        void loadWorkspaceInfo();
        void loadWorkspaceFiles("");
        void loadVasCases(true);
        void loadVasReviewQueue(true);
        void loadVasLearnings(true);
      }
      if (event.type === "vas_case_created" || event.type === "vas_case_reviewed" || event.type === "vas_case_claimed") {
        void loadVasCases(true);
        void loadVasReviewQueue(true);
        if (event.type === "vas_case_reviewed") void loadVasLearnings(true);
        if ((event.type === "vas_case_reviewed" || event.type === "vas_case_claimed") && event.data?.caseId === vasCaseIdInput.value.trim()) {
          void loadVasCaseRuns(true);
          void loadVasReviewPackage(true);
        }
        void refreshWorkspaceDirectory(state.workspacePath, { quiet: true });
      }
    }

    function refreshWorkspaceListsForAudit(event) {
      if (!isCurrentProjectAuditEvent(event)) return;
      if (state.selected && state.selected.runId && event.data?.runId !== state.selected.runId) return;
      if (event.type === "workspace_file_written" || event.type === "workspace_file_moved" || event.type === "workspace_file_deleted" || event.type === "workspace_file_conflicted") refreshWorkspaceFilesForAudit(event);
      if (event.type === "workspace_commit_created") void loadWorkspaceDiff({ quiet: true });
      if (event.type === "workspace_pull_request_created") void loadWorkspaceDiff({ quiet: true });
      if (state.handoffPackage && (event.type === "workspace_commit_created" || event.type === "workspace_pull_request_created")) void loadHandoffPackage({ quiet: true });
      if (event.type === "workspace_command_ran") void loadWorkspaceCommands({ quiet: true });
      if (["workspace_session_started", "workspace_session_input_sent", "workspace_session_stopped", "workspace_session_exited"].includes(event.type)) void loadWorkspaceSessions({ quiet: true });
    }

    function refreshWorkspaceFilesForAudit(event) {
      void refreshWorkspaceDirectory(state.workspacePath);
      if (state.workspaceFile && (event.data?.path === state.workspaceFile.path || event.data?.fromPath === state.workspaceFile.path)) {
        reloadFileButton.disabled = event.type === "workspace_file_deleted";
        workspaceError.textContent = event.type === "workspace_file_deleted"
          ? \`\${event.data.path} deleted in another session.\`
          : event.type === "workspace_file_conflicted"
            ? \`\${event.data.path} conflict in another session. Reload latest to resolve.\`
          : event.type === "workspace_file_moved"
            ? \`\${event.data.fromPath || event.data.path} moved to \${event.data.path} in another session.\`
            : \`\${event.data.path} changed in another session. Reload latest to resolve.\`;
      }
    }

    function closeTenantAuditStream() {
      if (!state.auditStream) return;
      state.auditStream.close();
      state.auditStream = null;
    }

    async function loadTenantPolicy() {
      connection.textContent = "loading policy";
      try {
        const response = await fetch(policyUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load tenant policy");
        state.tenantPolicy = data;
        populateTenantPolicySettings(data);
        renderHarnessStatus();
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        state.tenantPolicy = { error: error.message };
        renderHarnessStatus();
      }
    }

    async function saveTenantPolicySettings() {
      if (!canAdmin()) {
        policySettingsError.textContent = "admin access is required";
        applyAccessControls();
        return;
      }
      policySettingsError.textContent = "";
      savePolicySettingsButton.disabled = true;
      try {
        const response = await fetch(policySettingsUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            modelKeyEnv: policyModelKeyEnvInput.value.trim(),
            executorTemplateParameters: lines(policyTemplateParametersInput.value),
            limits: policySettingsLimits(),
            allowedTools: nullableLines(policyAllowedToolsInput.value),
            clientId: state.clientId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "policy settings update failed");
        state.tenantPolicy = data;
        populateTenantPolicySettings(data);
        await loadTenantAudit();
        await loadProjects();
        await loadModelUsageWarnings(true);
        await loadWorkspaceUsageWarnings(true);
        renderHarnessStatus();
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        policySettingsError.textContent = error.message;
      } finally {
        savePolicySettingsButton.disabled = !canAdmin();
      }
    }

    async function createTenantPolicyKey() {
      if (!canAdmin()) {
        policyKeyError.textContent = "admin access is required";
        applyAccessControls();
        return;
      }
      policyKeyError.textContent = "";
      policyKeyOutput.hidden = true;
      createPolicyKeyButton.disabled = true;
      try {
        const body = {
          actor: policyKeyActorInput.value.trim(),
          role: policyKeyRoleInput.value,
          modelKeyEnv: optionalValue(policyKeyModelEnvInput),
          clientId: state.clientId
        };
        const token = optionalValue(policyKeyTokenInput);
        if (token) body.token = token;
        const response = await fetch(policyApiKeysUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "policy key creation failed");
        state.tenantPolicy = data.policy;
        policyKeyTokenInput.value = "";
        policyKeyOutput.hidden = false;
        policyKeyOutput.textContent = data.token ? \`created token \${data.token}\` : "created key";
        await loadTenantAudit();
        await loadHarnessStatus({ quiet: true });
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        policyKeyError.textContent = error.message;
      } finally {
        createPolicyKeyButton.disabled = !canAdmin();
      }
    }

    async function revokeTenantPolicyKey() {
      if (!canAdmin()) {
        policyKeyError.textContent = "admin access is required";
        applyAccessControls();
        return;
      }
      policyKeyError.textContent = "";
      policyKeyOutput.hidden = true;
      revokePolicyKeyButton.disabled = true;
      try {
        const response = await fetch(policyApiKeyRevokeUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            actor: policyKeyActorInput.value.trim(),
            role: policyKeyRoleInput.value,
            clientId: state.clientId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "policy key revoke failed");
        state.tenantPolicy = data.policy;
        policyKeyTokenInput.value = "";
        policyKeyOutput.hidden = false;
        policyKeyOutput.textContent = \`revoked \${data.revoked || 0} key(s)\`;
        await loadTenantAudit();
        await loadHarnessStatus({ quiet: true });
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        policyKeyError.textContent = error.message;
      } finally {
        revokePolicyKeyButton.disabled = !canAdmin();
      }
    }

    async function provisionAgentGitServiceProjectAgent() {
      if (!canAdmin()) {
        agentGitServiceProvisionError.textContent = "admin access is required";
        applyAccessControls();
        return;
      }
      agentGitServiceProvisionError.textContent = "";
      agentGitServiceProvisionOutput.hidden = true;
      provisionAgentGitServiceButton.disabled = true;
      try {
        const body = {
          repo: agentGitServiceProvisionRepoInput.value.trim(),
          permission: agentGitServiceProvisionPermissionInput.value,
          agentPrefixLogin: optionalValue(agentGitServiceProvisionPrefixInput),
          defaultRepoName: optionalValue(agentGitServiceProvisionDefaultRepoInput),
          tokenEnvName: optionalValue(agentGitServiceProvisionTokenEnvInput),
          storeAgentToken: agentGitServiceProvisionStoreTokenInput.checked || undefined,
          force: agentGitServiceProvisionForceInput.checked || undefined,
          clientId: state.clientId
        };
        const identityRole = optionalValue(agentGitServiceProvisionIdentityRoleInput);
        const identityActor = optionalValue(agentGitServiceProvisionIdentityActorInput);
        if (identityRole) {
          body.controlPlaneIdentity = { role: identityRole };
          if (identityActor) body.controlPlaneIdentity.actor = identityActor;
        }
        const response = await fetch(agentGitServiceProvisionUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "agent-git-service provisioning failed");
        agentGitServiceProvisionOutput.hidden = false;
        agentGitServiceProvisionOutput.textContent = formatAgentGitServiceProvisioningResult(data);
        await loadTenantPolicy();
        await loadTenantAudit();
        await loadHarnessStatus({ quiet: true });
        await loadProjects();
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        agentGitServiceProvisionError.textContent = error.message;
      } finally {
        provisionAgentGitServiceButton.disabled = !canAdmin();
      }
    }

    async function loadAgentGitServiceProvisioningPlan() {
      if (!canAdmin()) {
        agentGitServiceProvisioningPlanError.textContent = "admin access is required";
        applyAccessControls();
        return;
      }
      agentGitServiceProvisioningPlanError.textContent = "";
      agentGitServiceProvisioningPlan.hidden = true;
      loadAgentGitServiceProvisioningPlanButton.disabled = true;
      connection.textContent = "loading AGS plan";
      try {
        const response = await fetch(agentGitServiceProvisioningPlanUrl(), { headers: authHeaders() });
        const plan = await response.json();
        if (!response.ok) throw new Error(plan.error || "failed to load agent-git-service provisioning plan");
        renderAgentGitServiceProvisioningPlan(plan);
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        agentGitServiceProvisioningPlanError.textContent = error.message;
      } finally {
        loadAgentGitServiceProvisioningPlanButton.disabled = !canAdmin();
      }
    }

    async function loadAgentGitServiceCutoverReadiness() {
      if (!canAdmin()) {
        agentGitServiceProvisioningPlanError.textContent = "admin access is required";
        applyAccessControls();
        return;
      }
      agentGitServiceProvisioningPlanError.textContent = "";
      agentGitServiceCutoverReadiness.hidden = true;
      loadAgentGitServiceCutoverReadinessButton.disabled = true;
      connection.textContent = "loading AGS cutover readiness";
      try {
        const response = await fetch(agentGitServiceCutoverReadinessUrl(), { headers: authHeaders() });
        const readiness = await response.json();
        if (!response.ok) throw new Error(readiness.error || "failed to load agent-git-service cutover readiness");
        renderAgentGitServiceCutoverReadiness(readiness);
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        agentGitServiceProvisioningPlanError.textContent = error.message;
      } finally {
        loadAgentGitServiceCutoverReadinessButton.disabled = !canAdmin();
      }
    }

    async function applyAgentGitServiceProvisioningPlan(dryRun) {
      if (!canAdmin()) {
        agentGitServiceProvisioningPlanError.textContent = "admin access is required";
        applyAccessControls();
        return;
      }
      if (!dryRun && !window.confirm("Apply AGS provisioning plan for eligible projects?")) return;
      agentGitServiceProvisioningPlanError.textContent = "";
      agentGitServiceProvisioningPlanApplyOutput.hidden = true;
      dryRunAgentGitServiceProvisioningPlanApplyButton.disabled = true;
      applyAgentGitServiceProvisioningPlanButton.disabled = true;
      connection.textContent = dryRun ? "dry-running AGS plan" : "applying AGS plan";
      try {
        const body = {
          dryRun,
          eligibleOnly: agentGitServiceProvisioningPlanEligibleOnlyInput.checked,
          clientId: state.clientId
        };
        const projects = agentGitServiceProvisioningPlanApplyProjects();
        if (projects.length) body.projects = projects;
        const response = await fetch(agentGitServiceProvisioningPlanApplyUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "failed to apply agent-git-service provisioning plan");
        renderAgentGitServiceProvisioningPlanApplyResult(result);
        if (!dryRun) {
          await loadTenantAudit();
          await loadHarnessStatus({ quiet: true });
          await loadProjects();
          await loadAgentGitServiceProvisioningPlan();
        }
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        agentGitServiceProvisioningPlanError.textContent = error.message;
      } finally {
        dryRunAgentGitServiceProvisioningPlanApplyButton.disabled = !canAdmin();
        applyAgentGitServiceProvisioningPlanButton.disabled = !canAdmin();
      }
    }

    async function loadTenantEscalations() {
      connection.textContent = "loading escalations";
      try {
        const response = await fetch(escalationsUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load tenant escalations");
        state.tenantEscalations = data;
        renderHarnessStatus();
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        state.tenantEscalations = [{ error: error.message }];
        renderHarnessStatus();
      }
    }

    async function requestTenantEscalation() {
      escalationError.textContent = "";
      requestEscalationButton.disabled = true;
      try {
        const body = {
          requestedTools: lines(escalationToolsInput.value),
          reason: escalationReasonInput.value.trim(),
          clientId: state.clientId
        };
        const limits = escalationLimits();
        if (limits) body.limits = limits;
        if (state.pendingEscalationSource) body.source = state.pendingEscalationSource;
        const response = await fetch(escalationsUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "policy escalation request failed");
        state.pendingEscalationSource = null;
        escalationDecisionIdInput.value = data.id || "";
        await loadTenantAudit();
        await loadTenantEscalations();
      } catch (error) {
        escalationError.textContent = error.message;
      } finally {
        requestEscalationButton.disabled = !state.tenantAccess;
      }
    }

    async function decideTenantEscalation() {
      const escalationId = escalationDecisionIdInput.value.trim();
      if (!escalationId) {
        escalationError.textContent = "escalation id is required";
        return;
      }
      if (!canAdmin()) {
        escalationError.textContent = "admin access is required";
        applyAccessControls();
        return;
      }
      escalationError.textContent = "";
      decideEscalationButton.disabled = true;
      try {
        const response = await fetch(escalationDecisionUrl(escalationId), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            decision: escalationDecisionInput.value,
            note: escalationDecisionNoteInput.value.trim(),
            clientId: state.clientId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "policy escalation decision failed");
        await loadTenantAudit();
        await loadTenantPolicy();
        await loadTenantEscalations();
      } catch (error) {
        escalationError.textContent = error.message;
      } finally {
        decideEscalationButton.disabled = !canAdmin();
      }
    }

    async function loadProjects(options = {}) {
      const quiet = options.quiet === true;
      if (!quiet) connection.textContent = "loading projects";
      try {
        const response = await fetch(projectsUrl(), { headers: authHeaders() });
        if (!response.ok) throw new Error("failed to load projects");
        state.projects = sortProjectsByActivity(await response.json());
        renderProjects();
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        if (!quiet) {
          connection.textContent = "error";
          projectList.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
          projectConcurrencyBoard.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
        }
      }
    }

    async function loadModelUsageWarnings(quiet = false) {
      if (!quiet) connection.textContent = "loading model usage warnings";
      try {
        const response = await fetch(modelUsageWarningsUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load model usage warnings");
        state.modelUsageWarningProjects = sortProjectsByActivity(Array.isArray(data.projects) ? data.projects : []);
        renderModelUsageWarnings();
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        state.modelUsageWarningProjects = [];
        modelUsageWarningsList.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
        if (!quiet) connection.textContent = "error";
      }
    }

    async function loadWorkspaceUsageWarnings(quiet = false) {
      if (!quiet) connection.textContent = "loading workspace usage warnings";
      try {
        const response = await fetch(workspaceUsageWarningsUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load workspace usage warnings");
        state.workspaceUsageWarningProjects = sortProjectsByActivity(Array.isArray(data.projects) ? data.projects : []);
        renderWorkspaceUsageWarnings();
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        state.workspaceUsageWarningProjects = [];
        workspaceUsageWarningsList.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
        if (!quiet) connection.textContent = "error";
      }
    }

    async function createProject() {
      if (!canMutate()) {
        formError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      formError.textContent = "";
      createProjectButton.disabled = true;
      try {
        applyProjectTemplateDefaults();
        const body = {
          project: project(),
          template: projectTemplateInput.value,
          clientId: state.clientId
        };
        body.repo = optionalValue(projectRepoInput);
        body.branch = optionalValue(projectBranchInput);
        body.baseBranch = optionalValue(projectBaseBranchInput);
        body.issue = optionalValue(projectIssueInput);
        const defaultSkills = lines(projectDefaultSkillsInput.value);
        if (defaultSkills.length) body.defaultSkills = defaultSkills;
        body.preset = optionalValue(projectRunPresetInput);
        if (body.preset) body.presetInput = { caseId: optionalValue(projectRunPresetCaseInput) || "bootstrap" };
        body.reviewRequired = projectReviewRequiredInput.checked;
        body.deploymentRequired = projectDeploymentRequiredInput.checked;
        body.objective = optionalValue(projectContractObjectiveInput);
        const constraints = lines(projectContractConstraintsInput.value);
        if (constraints.length) body.constraints = constraints;
        const successCriteria = lines(projectContractSuccessInput.value);
        if (successCriteria.length) body.successCriteria = successCriteria;
        const response = await fetch(createProjectUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "project creation failed");
        await loadTenantAudit();
        await loadProjects();
        await selectProject(data.project);
      } catch (error) {
        formError.textContent = error.message;
      } finally {
        createProjectButton.disabled = !canMutate();
      }
    }

    async function saveProjectSourceDefaults() {
      if (!canMutate()) {
        formError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      formError.textContent = "";
      saveProjectSourceDefaultsButton.disabled = true;
      try {
        const body = { clientId: state.clientId };
        body.repo = optionalValue(projectRepoInput);
        body.branch = optionalValue(projectBranchInput);
        body.baseBranch = optionalValue(projectBaseBranchInput);
        body.issue = optionalValue(projectIssueInput);
        const response = await fetch(saveProjectSourceDefaultsUrl(), {
          method: "PUT",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "project defaults update failed");
        await loadTenantAudit();
        await loadProjects();
        await selectProject(data.project);
      } catch (error) {
        formError.textContent = error.message;
      } finally {
        saveProjectSourceDefaultsButton.disabled = !canMutate();
      }
    }

    async function saveProjectDefaultSkills() {
      if (!canMutate()) {
        formError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      formError.textContent = "";
      saveProjectDefaultSkillsButton.disabled = true;
      try {
        const body = { clientId: state.clientId };
        body.defaultSkills = lines(projectDefaultSkillsInput.value);
        const response = await fetch(saveProjectDefaultSkillsUrl(), {
          method: "PUT",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "project default skills update failed");
        await loadTenantAudit();
        await loadProjects();
        await selectProject(data.project);
      } catch (error) {
        formError.textContent = error.message;
      } finally {
        saveProjectDefaultSkillsButton.disabled = !canMutate();
      }
    }

    async function saveProjectRunPolicy() {
      if (!canMutate()) {
        formError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      formError.textContent = "";
      saveProjectRunPolicyButton.disabled = true;
      try {
        const body = { clientId: state.clientId };
        body.preset = optionalValue(projectRunPresetInput);
        if (body.preset) body.presetInput = { caseId: optionalValue(projectRunPresetCaseInput) || "bootstrap" };
        body.reviewRequired = projectReviewRequiredInput.checked;
        body.deploymentRequired = projectDeploymentRequiredInput.checked;
        const response = await fetch(saveProjectRunPolicyUrl(), {
          method: "PUT",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "project run policy update failed");
        await loadTenantAudit();
        await loadProjects();
        await selectProject(data.project);
      } catch (error) {
        formError.textContent = error.message;
      } finally {
        saveProjectRunPolicyButton.disabled = !canMutate();
      }
    }

    async function saveProjectContract() {
      if (!canMutate()) {
        formError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      formError.textContent = "";
      saveProjectContractButton.disabled = true;
      try {
        const body = { clientId: state.clientId };
        body.objective = optionalValue(projectContractObjectiveInput);
        body.constraints = lines(projectContractConstraintsInput.value);
        body.successCriteria = lines(projectContractSuccessInput.value);
        const response = await fetch(saveProjectContractUrl(), {
          method: "PUT",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "project contract update failed");
        await loadTenantAudit();
        await loadProjects();
        await selectProject(data.project);
      } catch (error) {
        formError.textContent = error.message;
      } finally {
        saveProjectContractButton.disabled = !canMutate();
      }
    }

    async function loadVasCases(quiet = false) {
      if (!quiet) connection.textContent = "loading vas cases";
      try {
        const response = await fetch(vasCasesUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load VAS cases");
        state.vasCases = Array.isArray(data.cases) ? data.cases : [];
        renderVasCases();
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        state.vasCases = [];
        vasCaseList.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
        if (!quiet) connection.textContent = "error";
      }
    }

    async function loadVasReviewQueue(quiet = false) {
      if (!quiet) connection.textContent = "loading vas review queue";
      try {
        const response = await fetch(vasReviewQueueUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load VAS review queue");
        state.vasReviewQueue = Array.isArray(data.cases) ? data.cases : [];
        renderVasReviewQueue();
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        state.vasReviewQueue = [];
        vasReviewQueueList.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
        if (!quiet) connection.textContent = "error";
      }
    }

    async function loadVasLearnings(quiet = false) {
      if (!quiet) connection.textContent = "loading vas learnings";
      try {
        const response = await fetch(vasLearningsUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load VAS learnings");
        state.vasLearnings = Array.isArray(data.learnings) ? data.learnings : [];
        renderVasLearnings();
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        state.vasLearnings = [];
        vasLearningList.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
        if (!quiet) connection.textContent = "error";
      }
    }

    async function loadVasArtifacts(quiet = false) {
      const caseId = vasCaseIdInput.value.trim();
      if (!caseId) {
        state.vasArtifacts = null;
        vasArtifactView.innerHTML = '<div class="empty">Select a VAS case first.</div>';
        return;
      }
      if (!quiet) connection.textContent = "loading vas artifacts";
      try {
        const response = await fetch(vasCaseArtifactsUrl(caseId), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load VAS artifacts");
        state.vasArtifacts = data;
        renderVasArtifacts();
        if (!quiet) applyVasReviewDraft(data.reviewDraft);
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        state.vasArtifacts = null;
        vasArtifactView.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
        if (!quiet) connection.textContent = "error";
      }
    }

    async function loadVasCaseRuns(quiet = false) {
      const caseId = vasCaseIdInput.value.trim();
      if (!caseId) {
        state.vasCaseRuns = [];
        state.vasCaseRunSource = null;
        vasCaseRunList.innerHTML = '<div class="empty">Select a VAS case first.</div>';
        return;
      }
      if (!quiet) connection.textContent = "loading vas case runs";
      try {
        const response = await fetch(vasCaseRunsUrl(caseId), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load VAS case runs");
        state.vasCaseRunSource = data;
        state.vasCaseRuns = Array.isArray(data.runs) ? data.runs : [];
        renderVasCaseRuns();
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        state.vasCaseRuns = [];
        state.vasCaseRunSource = null;
        vasCaseRunList.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
        if (!quiet) connection.textContent = "error";
      }
    }

    async function loadVasReviewPackage(quiet = false) {
      const caseId = vasCaseIdInput.value.trim();
      if (!caseId) {
        state.vasReviewPackage = null;
        vasReviewPackageView.innerHTML = '<div class="empty">Select a VAS case first.</div>';
        return;
      }
      if (!quiet) connection.textContent = "loading vas review package";
      try {
        const response = await fetch(vasCaseReviewPackageUrl(caseId), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load VAS review package");
        state.vasReviewPackage = data;
        renderVasReviewPackage();
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        state.vasReviewPackage = null;
        vasReviewPackageView.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
        if (!quiet) connection.textContent = "error";
      }
    }

    async function createVasCase() {
      if (!canMutate()) {
        formError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const caseId = vasCaseIdInput.value.trim();
      if (!caseId) {
        formError.textContent = "VAS case id is required";
        return;
      }
      formError.textContent = "";
      createVasCaseButton.disabled = true;
      try {
        const sourceUrl = vasCaseSourceUrlInput.value.trim();
        const body = {
          caseId,
          source: { kind: sourceUrl ? "video" : "placeholder", url: sourceUrl, range: { start: 0, end: 0 } },
          clientId: state.clientId
        };
        body.repo = optionalValue(vasCaseRepoInput);
        body.branch = optionalValue(vasCaseBranchInput);
        body.baseBranch = optionalValue(vasCaseBaseBranchInput);
        body.issue = optionalValue(vasCaseIssueInput);
        const response = await fetch(vasCasesUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "VAS case creation failed");
        runPresetInput.value = "vas-lite-review";
        runPresetCaseInput.value = data.id || caseId;
        await loadTenantAudit();
        await loadVasCases();
        await loadVasReviewQueue(true);
        await loadVasLearnings();
        await loadVasCaseRuns(true);
        await loadWorkspaceFiles("");
      } catch (error) {
        formError.textContent = error.message;
      } finally {
        createVasCaseButton.disabled = !canMutate();
      }
    }

    async function claimVasCase() {
      await updateVasCaseClaim("claim");
    }

    async function releaseVasCase() {
      await updateVasCaseClaim("release");
    }

    async function updateVasCaseClaim(action) {
      if (!canMutate()) {
        formError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const caseId = vasCaseIdInput.value.trim();
      if (!caseId) {
        formError.textContent = "VAS case id is required";
        return;
      }
      formError.textContent = "";
      claimVasCaseButton.disabled = true;
      releaseVasCaseButton.disabled = true;
      try {
        const response = await fetch(vasCaseClaimUrl(caseId), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ action, clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "VAS case claim update failed");
        await loadTenantAudit();
        await loadVasCases(true);
        await loadVasReviewQueue(true);
        await loadVasReviewPackage(true);
      } catch (error) {
        formError.textContent = error.message;
      } finally {
        applyAccessControls();
      }
    }

    async function reviewVasCase() {
      if (!canMutate()) {
        formError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const caseId = vasCaseIdInput.value.trim();
      if (!caseId) {
        formError.textContent = "VAS case id is required";
        return;
      }
      formError.textContent = "";
      reviewVasCaseButton.disabled = true;
      try {
        const response = await fetch(vasCaseReviewUrl(caseId), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(vasReviewPayload(caseId))
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "VAS case review failed");
        runPresetInput.value = "vas-lite-review";
        runPresetCaseInput.value = data.id || caseId;
        await loadTenantAudit();
        await loadVasCases();
        await loadVasReviewQueue(true);
        await loadVasLearnings();
        await loadVasReviewPackage(true);
        await loadWorkspaceFiles("");
      } catch (error) {
        formError.textContent = error.message;
      } finally {
        reviewVasCaseButton.disabled = !canMutate();
      }
    }

    async function startVasReviewRun() {
      if (!canMutate()) {
        formError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const caseId = vasCaseIdInput.value.trim();
      if (!caseId) {
        formError.textContent = "VAS case id is required";
        return;
      }
      formError.textContent = "";
      startVasReviewRunButton.disabled = true;
      try {
        const body = {
          clientId: state.clientId,
          allowedTools: lines(allowedToolsInput.value),
          repo: optionalValue(repoInput),
          branch: optionalValue(branchInput),
          baseBranch: optionalValue(baseBranchInput),
          issue: optionalValue(issueInput),
          syncIssueComments: syncIssueCommentsOnCreateInput.checked,
          pullRequest: pullRequestInput.checked,
          reviewRequired: reviewRequiredInput.checked,
          deploymentRequired: deploymentRequiredInput.checked,
          reviewer: lines(vasReviewRunReviewerInput.value)
        };
        if (agentModeInput.value === "model") {
          body.model = modelInput.value.trim();
          body.modelProtocol = modelProtocolInput.value;
        }
        const response = await fetch(vasCaseReviewRunsUrl(caseId), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "VAS review run creation failed");
        state.selected = data;
        runPresetInput.value = "vas-lite-review";
        runPresetCaseInput.value = caseId;
        await loadTenantAudit();
        await loadProjects();
        await loadRuns();
        await loadVasCases(true);
        await loadVasReviewQueue(true);
        await loadVasCaseRuns(true);
        await loadVasReviewPackage(true);
        await selectRun(data.runId, true);
        connection.textContent = \`started VAS review run \${data.runId}\`;
      } catch (error) {
        formError.textContent = error.message;
      } finally {
        startVasReviewRunButton.disabled = !canMutate() || !vasCaseIdInput.value.trim();
      }
    }

    function selectedVasCaseRunId(caseId) {
      const selected = state.selected;
      if (!selected || !selected.runId || !selected.metadata || selected.metadata.runPreset !== "vas-lite-review") return undefined;
      const presetInput = selected.metadata.runPresetInput || {};
      const selectedCaseId = presetInput.caseId || "bootstrap";
      return selectedCaseId === caseId ? selected.runId : undefined;
    }

    function vasReviewPayload(caseId) {
      const body = { decision: vasReviewDecisionInput.value, clientId: state.clientId };
      const note = vasReviewNoteInput.value.trim();
      const corrections = lines(vasReviewCorrectionsInput.value);
      const learnings = lines(vasReviewLearningsInput.value);
      const runId = selectedVasCaseRunId(caseId);
      if (note) body.note = note;
      if (corrections.length) body.corrections = corrections;
      if (learnings.length) body.learnings = learnings;
      if (runId) body.runId = runId;
      return body;
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

    async function heartbeatProjectPresence() {
      try {
        const response = await fetch(projectPresenceUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ clientId: state.clientId, label: projectPresenceLabelInput.value.trim() || state.clientId, focus: projectPresenceFocus() })
        });
        if (!response.ok) return;
        const entry = await response.json();
        state.projectPresence = state.projectPresence.filter((item) => item.clientId !== entry.clientId).concat(entry);
        renderProjectPresence();
        await loadProjectPresence();
        await loadProjects({ quiet: true });
      } catch (error) {
      }
    }

    async function loadProjectPresence() {
      try {
        const response = await fetch(projectPresenceUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load project presence");
        state.projectPresence = Array.isArray(data) ? data : [];
      } catch (error) {
        state.projectPresence = [];
      } finally {
        syncProjectPresenceRollup();
        renderProjects();
        renderWorkspaceFileContent();
        renderProjectPresence();
      }
    }

    function syncProjectPresenceRollup() {
      state.projects = state.projects.map((item) => item.project === project()
        ? {
            ...item,
            activeProjectCollaboratorCount: state.projectPresence.length,
            activeProjectCollaborators: state.projectPresence
          }
        : item);
    }

    async function loadRuns(options = {}) {
      const quiet = options.quiet === true;
      if (!quiet) connection.textContent = "loading runs";
      try {
        const response = await fetch(runsUrl(), { headers: authHeaders() });
        if (!response.ok) throw new Error("failed to load runs");
        state.runs = await response.json();
        renderRuns();
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        if (!quiet) {
          connection.textContent = "error";
          runList.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
        }
      }
    }

    async function openProjectRun(runProject, runId, loadingText) {
      if (!runProject || !runId) return;
      connection.textContent = loadingText;
      try {
        if (project() !== runProject) {
          await selectProject(runProject);
        } else {
          await loadRuns();
        }
        await selectRun(runId);
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        formError.textContent = error.message;
      }
    }

    async function openProjectQueuedRun(runProject, runId) {
      await openProjectRun(runProject, runId, "loading queued run");
    }

    async function openProjectGateRun(runProject, runId) {
      await openProjectRun(runProject, runId, "loading gate run");
    }

    async function openProjectActiveRun(runProject, runId) {
      await openProjectRun(runProject, runId, "loading active run");
    }

    async function openProjectRunCollaborator(projectName, runId) {
      await openProjectRun(projectName, runId, "loading collaborator run");
    }

    async function openProjectActiveWorkspaceSession(projectName, sessionId, runId) {
      if (!projectName || !sessionId) return;
      connection.textContent = "loading workspace session";
      try {
        if (project() !== projectName || (!runId && state.selected)) {
          await selectProject(projectName);
        }
        if (runId) {
          await loadRuns();
          await selectRun(runId);
        } else {
          await loadWorkspaceSessions();
        }
        await selectWorkspaceSession(sessionId);
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        commandError.textContent = error.message;
      }
    }

    async function openProjectLatestWorkspaceCommand(projectName, commandId, runId) {
      if (!projectName || !commandId) return;
      connection.textContent = "loading workspace command";
      try {
        if (project() !== projectName || (!runId && state.selected)) {
          await selectProject(projectName);
        }
        if (runId) {
          await loadRuns();
          await selectRun(runId);
        } else {
          await loadWorkspaceCommands();
        }
        selectWorkspaceCommand(commandId);
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        commandError.textContent = error.message;
      }
    }

    async function openProjectLatestWorkspaceSession(projectName, sessionId, runId) {
      await openProjectActiveWorkspaceSession(projectName, sessionId, runId);
    }

    async function openProjectLatestWorkspaceActivity(projectName, path, deleted) {
      if (!projectName || !path) return;
      connection.textContent = "loading workspace activity";
      try {
        if (project() !== projectName || state.selected) {
          await selectProject(projectName);
        }
        const targetPath = deleted === "true" ? parentPath(path) : path;
        await loadWorkspaceFiles(targetPath);
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        workspaceError.textContent = error.message;
      }
    }

    async function cancelProjectQueuedRun(runProject, runId) {
      if (!runProject || !runId) return;
      if (!canMutate()) {
        formError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      connection.textContent = "cancelling queued run";
      formError.textContent = "";
      try {
        const response = await fetch(projectRunCancelUrl(runProject, runId), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ reason: "cancelled from dashboard project queue", clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "cancel failed");
        await loadTenantAudit();
        await loadHarnessStatus();
        await loadProjects();
        if (project() === runProject) await loadRuns();
        if (state.selected && state.selected.runId === runId && project() === runProject) await selectRun(runId);
        connection.textContent = \`cancelled queued run \${runId}\`;
      } catch (error) {
        connection.textContent = "error";
        formError.textContent = error.message;
      }
    }

    async function cancelProjectActiveRun(runProject, runId) {
      if (!runProject || !runId) return;
      if (!canMutate()) {
        formError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      connection.textContent = "cancelling active run";
      formError.textContent = "";
      try {
        const response = await fetch(projectRunCancelUrl(runProject, runId), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ reason: "cancelled from dashboard project concurrency board", clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "cancel failed");
        await loadTenantAudit();
        await loadHarnessStatus();
        await loadProjects();
        if (project() === runProject) await loadRuns();
        if (state.selected && state.selected.runId === runId && project() === runProject) await selectRun(runId);
        connection.textContent = \`cancel requested active run \${runId}\`;
      } catch (error) {
        connection.textContent = "error";
        formError.textContent = error.message;
      }
    }

    async function pauseProjectActiveRun(runProject, runId) {
      if (!runProject || !runId) return;
      if (!state.tenantAccess) {
        formError.textContent = "tenant access is required";
        applyAccessControls();
        return;
      }
      connection.textContent = "requesting active run pause";
      formError.textContent = "";
      try {
        const response = await fetch(projectRunCommentUrl(runProject, runId), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ message: "Pause requested from dashboard project concurrency board.", pause: true, clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "pause request failed");
        await loadTenantAudit();
        await loadProjects();
        if (project() === runProject) await loadRuns();
        if (state.selected && state.selected.runId === runId && project() === runProject) {
          await refreshSelected(runId);
          if (state.replay) await loadReplay();
        }
        connection.textContent = \`pause requested active run \${runId}\`;
      } catch (error) {
        connection.textContent = "error";
        formError.textContent = error.message;
      }
    }

    async function openVasCaseRun(runId) {
      if (!runId) return;
      connection.textContent = "loading vas case run";
      try {
        await loadRuns();
        await selectRun(runId);
        connection.textContent = "ready";
      } catch (error) {
        connection.textContent = "error";
        formError.textContent = error.message;
      }
    }

    async function selectProject(name) {
      closeStream();
      resetTerminalSession();
      projectInput.value = name;
      state.selected = null;
      syncDashboardUrl();
      const selectedProject = state.projects.find((item) => item.project === name);
      if (selectedProject) {
        projectRepoInput.value = selectedProject.repo || "";
        projectBranchInput.value = selectedProject.branch || "";
        projectBaseBranchInput.value = selectedProject.baseBranch || "";
        projectIssueInput.value = selectedProject.issue || "";
        projectDefaultSkillsInput.value = Array.isArray(selectedProject.defaultSkills) ? selectedProject.defaultSkills.join("\\n") : "";
        const runPolicy = selectedProject.runPolicy || {};
        projectRunPresetInput.value = runPolicy.preset || "";
        projectRunPresetCaseInput.value = runPolicy.presetInput && runPolicy.presetInput.caseId ? runPolicy.presetInput.caseId : "bootstrap";
        projectReviewRequiredInput.checked = Boolean(runPolicy.reviewRequired);
        projectDeploymentRequiredInput.checked = Boolean(runPolicy.deploymentRequired);
        const contract = selectedProject.contract || {};
        projectContractObjectiveInput.value = contract.objective || "";
        projectContractConstraintsInput.value = Array.isArray(contract.constraints) ? contract.constraints.join("\\n") : "";
        projectContractSuccessInput.value = Array.isArray(contract.successCriteria) ? contract.successCriteria.join("\\n") : "";
        runPresetInput.value = runPolicy.preset || "";
        runPresetCaseInput.value = runPolicy.presetInput && runPolicy.presetInput.caseId ? runPolicy.presetInput.caseId : "bootstrap";
        reviewRequiredInput.checked = Boolean(runPolicy.reviewRequired);
        deploymentRequiredInput.checked = Boolean(runPolicy.deploymentRequired);
        repoInput.value = selectedProject.repo || "";
        branchInput.value = selectedProject.branch || "";
        baseBranchInput.value = selectedProject.baseBranch || "";
        issueInput.value = selectedProject.issue || "";
        prefillProjectWorkspacePullRequestFields(selectedProject);
      }
      state.events = [];
      state.replay = null;
      state.reviewSummary = null;
      state.handoffPackage = null;
      state.handoffFollowups = null;
      state.workspacePath = "";
      state.workspaceEntries = [];
      state.workspaceFile = null;
      state.workspaceInfo = null;
      state.workspaceDiff = null;
      state.workspaceCommands = [];
      state.selectedCommandId = null;
      state.workspaceSessions = [];
      state.projectPresence = [];
      state.vasCases = [];
      state.vasReviewQueue = [];
      state.vasLearnings = [];
      state.vasArtifacts = null;
      state.vasReviewPackage = null;
      state.vasCaseRuns = [];
      state.vasCaseRunSource = null;
      renderProjects();
      renderVasCases();
      renderVasReviewQueue();
      renderVasLearnings();
      renderVasArtifacts();
      renderVasReviewPackage();
      renderVasCaseRuns();
      renderProjectPresence();
      renderProjectActivity();
      renderSummary();
      renderEvents();
      renderReplay();
      renderReviewSummary();
      renderHandoffPackage();
      renderHandoffFollowups();
      renderWorkspaceInfo();
      renderWorkspaceDiff();
      renderWorkspaceCommands();
      renderWorkspaceSessions();
      await heartbeatProjectPresence();
      await loadProjectPresence();
      await loadVasCases(true);
      await loadVasReviewQueue(true);
      await loadVasLearnings(true);
      await loadRuns();
      await loadWorkspaceInfo();
      await loadWorkspaceFiles("");
      await loadWorkspaceCommands();
      await loadWorkspaceSessions();
    }

    async function loadWorkspaceFiles(path = state.workspacePath) {
      workspaceError.textContent = "";
      try {
        const response = await fetch(workspaceFilesUrl(path), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load workspace files");
        if (data.kind === "directory") {
          state.workspacePath = data.path;
          state.workspaceEntries = data.entries || [];
          state.workspaceFile = null;
          state.presenceFocus = data.path ? "dir:" + data.path : "project:" + project();
          renderWorkspaceFiles();
          void heartbeatProjectPresence();
          return;
        }
        state.workspaceFile = data;
        state.presenceFocus = "file:" + data.path;
        renderWorkspaceFileContent();
        void heartbeatProjectPresence();
      } catch (error) {
        workspaceError.textContent = error.message;
      } finally {
        applyAccessControls();
      }
    }

    async function loadWorkspaceInfo() {
      try {
        const response = await fetch(workspaceInfoUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load workspace context");
        state.workspaceInfo = data;
        prefillWorkspacePullRequestFields(data);
      } catch (error) {
        state.workspaceInfo = { error: error.message };
      } finally {
        renderWorkspaceInfo();
      }
    }

    async function loadWorkspaceDiff(options = {}) {
      const quiet = options.quiet === true;
      const shouldRender = !quiet || !workspaceDiff.hidden;
      if (!quiet) workspaceError.textContent = "";
      if (!quiet) {
        workspaceDiff.hidden = true;
        workspaceDiff.textContent = "";
      }
      try {
        const response = await fetch(workspaceDiffUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load workspace diff");
        state.workspaceDiff = data;
        if (shouldRender) renderWorkspaceDiff();
      } catch (error) {
        if (quiet) return;
        state.workspaceDiff = null;
        workspaceError.textContent = error.message;
      }
    }

    async function commitWorkspaceChanges() {
      if (!canMutate()) {
        workspaceError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const message = workspaceCommitMessageInput.value.trim();
      if (!message) {
        workspaceError.textContent = "commit message is required";
        return;
      }
      workspaceError.textContent = "";
      commitWorkspaceButton.disabled = true;
      try {
        const response = await fetch(workspaceCommitUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ message, clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to commit workspace changes");
        await loadTenantAudit();
        await loadWorkspaceDiff();
        workspaceError.textContent = data.commit ? "Committed " + data.commit : "Committed workspace changes";
      } catch (error) {
        workspaceError.textContent = error.message;
      } finally {
        commitWorkspaceButton.disabled = !canMutate();
      }
    }

    async function handoffWorkspacePullRequest() {
      if (!canMutate()) {
        workspaceError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const body = {
        clientId: state.clientId,
        reviewRequired: workspacePrReviewInput.checked,
        deploymentRequired: workspacePrDeploymentInput.checked
      };
      const issue = workspacePrIssueInput.value.trim();
      const branch = workspacePrBranchInput.value.trim();
      const baseBranch = workspacePrBaseInput.value.trim();
      if (issue) body.issue = issue;
      if (branch) body.branch = branch;
      if (baseBranch) body.baseBranch = baseBranch;
      workspaceError.textContent = "";
      handoffPrButton.disabled = true;
      try {
        const response = await fetch(workspacePullRequestUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to hand off workspace pull request");
        await loadTenantAudit();
        await loadRuns();
        if (state.selected && state.selected.runId) await refreshSelected(state.selected.runId);
        workspaceError.textContent = data.pullRequestUrl ? "PR " + data.pullRequestUrl : "PR handoff created";
      } catch (error) {
        workspaceError.textContent = error.message;
      } finally {
        handoffPrButton.disabled = !canMutate();
      }
    }

    async function requestWorkspacePrEscalation() {
      workspaceError.textContent = "";
      workspacePrEscalationButton.disabled = true;
      try {
        const response = await fetch(escalationsUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            requestedTools: ["git.pr"],
            reason: workspacePrEscalationReason(),
            source: {
              kind: "workspace_pr",
              project: project(),
              runId: state.selected && state.selected.runId ? state.selected.runId : undefined
            },
            clientId: state.clientId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "git.pr policy escalation request failed");
        escalationDecisionIdInput.value = data.id || "";
        await loadTenantAudit();
        await loadTenantEscalations();
        workspaceError.textContent = data.id ? "Requested git.pr escalation " + data.id : "Requested git.pr escalation";
      } catch (error) {
        workspaceError.textContent = error.message;
      } finally {
        workspacePrEscalationButton.disabled = !state.tenantAccess;
      }
    }

    function workspacePrEscalationReason() {
      if (state.selected && state.selected.runId) return "need workspace PR handoff for run " + state.selected.runId;
      return "need workspace PR handoff for project " + project();
    }

    async function refreshWorkspaceDirectory(path = state.workspacePath, options = {}) {
      const quiet = options.quiet === true;
      try {
        const response = await fetch(workspaceFilesUrl(path), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to refresh workspace files");
        if (data.kind !== "directory") return;
        state.workspacePath = data.path;
        state.workspaceEntries = data.entries || [];
        renderWorkspaceFiles();
      } catch (error) {
        if (!quiet) workspaceError.textContent = error.message;
      } finally {
        applyAccessControls();
      }
    }

    async function selectWorkspaceFile(path, kind) {
      if (kind === "directory") {
        await loadWorkspaceFiles(path);
        return;
      }
      await loadWorkspaceFiles(path);
    }

    function newWorkspaceFile() {
      if (!canMutate()) {
        workspaceError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const path = workspaceNewFilePathInput.value.trim();
      if (!path) {
        workspaceError.textContent = "new file path is required";
        return;
      }
      workspaceError.textContent = "";
      state.workspaceFile = { path, kind: "file", size: 0, content: "" };
      state.presenceFocus = "file:" + path;
      workspaceFileContent.value = "";
      renderWorkspaceFileContent();
      void heartbeatProjectPresence();
    }

    async function saveWorkspaceFile() {
      if (!state.workspaceFile) return;
      if (!canMutate()) {
        workspaceError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      workspaceError.textContent = "";
      saveFileButton.disabled = true;
      try {
        const response = await fetch(workspaceFilesUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ path: state.workspaceFile.path, content: workspaceFileContent.value, baseUpdatedAt: state.workspaceFile.updatedAt, clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) {
          if (response.status === 409 && state.workspaceFile) {
            reloadFileButton.disabled = false;
            workspaceError.textContent = formatWorkspaceFileConflict(data);
            return;
          }
          throw new Error(data.error || "failed to save workspace file");
        }
        state.workspaceFile = data;
        await loadTenantAudit();
        await loadWorkspaceFiles(parentPath(data.path));
        state.workspaceFile = data;
        renderWorkspaceFileContent();
      } catch (error) {
        workspaceError.textContent = error.message;
      } finally {
        saveFileButton.disabled = !canMutate();
      }
    }

    async function reloadWorkspaceFile() {
      if (!state.workspaceFile) return;
      workspaceError.textContent = "";
      reloadFileButton.disabled = true;
      await loadWorkspaceFiles(state.workspaceFile.path);
    }

    async function moveWorkspaceFile() {
      if (!state.workspaceFile) return;
      if (!canMutate()) {
        workspaceError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      if (!state.workspaceFile.updatedAt) return;
      const promptedPath = window.prompt("Move file to path", state.workspaceFile.path);
      const toPath = promptedPath ? promptedPath.trim() : "";
      if (!toPath || toPath === state.workspaceFile.path) return;
      workspaceError.textContent = "";
      moveFileButton.disabled = true;
      try {
        const response = await fetch(workspaceFileMoveUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ fromPath: state.workspaceFile.path, toPath, baseUpdatedAt: state.workspaceFile.updatedAt, clientId: state.clientId })
        });
        const data = await response.json();
        if (response.status === 409) throw new Error(formatWorkspaceFileConflict(data));
        if (!response.ok) throw new Error(data.error || "failed to move workspace file");
        state.workspaceFile = data;
        state.presenceFocus = "file:" + data.path;
        await loadTenantAudit();
        await loadWorkspaceFiles(parentPath(data.path));
        state.workspaceFile = data;
        renderWorkspaceFileContent();
        void heartbeatProjectPresence();
      } catch (error) {
        workspaceError.textContent = error.message;
      } finally {
        applyAccessControls();
      }
    }

    async function deleteWorkspaceFile() {
      if (!state.workspaceFile) return;
      if (!canMutate()) {
        workspaceError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      if (!state.workspaceFile.updatedAt) {
        state.workspaceFile = null;
        renderWorkspaceFileContent();
        return;
      }
      const path = state.workspaceFile.path;
      workspaceError.textContent = "";
      deleteFileButton.disabled = true;
      try {
        const response = await fetch(workspaceFilesUrl(path), {
          method: "DELETE",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ baseUpdatedAt: state.workspaceFile.updatedAt, clientId: state.clientId })
        });
        const data = await response.json();
        if (response.status === 409) throw new Error(formatWorkspaceFileConflict(data));
        if (!response.ok) throw new Error(data.error || "failed to delete workspace file");
        state.workspaceFile = null;
        await loadTenantAudit();
        await loadWorkspaceFiles(parentPath(path));
      } catch (error) {
        workspaceError.textContent = error.message;
      } finally {
        applyAccessControls();
      }
    }

    async function runWorkspaceCommand() {
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      commandError.textContent = "";
      commandOutput.hidden = true;
      commandOutput.textContent = "";
      const command = workspaceCommandInput.value.trim();
      if (!command) {
        commandError.textContent = "command is required";
        return;
      }
      runCommandButton.disabled = true;
      try {
        const response = await fetch(workspaceCommandsUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ command, clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "command failed");
        state.selectedCommandId = data.commandId;
        commandOutput.hidden = false;
        commandOutput.textContent = formatCommandResult(data);
        await loadTenantAudit();
        await loadWorkspaceCommands();
        await loadWorkspaceFiles(state.workspacePath);
      } catch (error) {
        commandError.textContent = error.message;
      } finally {
        runCommandButton.disabled = !canMutate();
      }
    }

    async function loadWorkspaceCommands(options = {}) {
      const quiet = options.quiet === true;
      if (!quiet) commandError.textContent = "";
      try {
        const response = await fetch(workspaceCommandsUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load workspace commands");
        state.workspaceCommands = data;
        renderWorkspaceCommands();
      } catch (error) {
        if (quiet) return;
        commandError.textContent = error.message;
      } finally {
        applyAccessControls();
      }
    }

    function selectWorkspaceCommand(commandId) {
      commandError.textContent = "";
      state.selectedCommandId = commandId;
      state.presenceFocus = commandId ? "command:" + commandId : "";
      const command = selectedWorkspaceCommand();
      renderWorkspaceCommands();
      if (!command) return;
      commandOutput.hidden = false;
      commandOutput.textContent = formatCommandResult(command);
      void heartbeatProjectPresence();
    }

    async function loadWorkspaceSessions(options = {}) {
      const quiet = options.quiet === true;
      if (!quiet) commandError.textContent = "";
      try {
        const response = await fetch(workspaceSessionsUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load workspace sessions");
        state.workspaceSessions = data;
        renderWorkspaceSessions();
      } catch (error) {
        if (quiet) return;
        commandError.textContent = error.message;
      } finally {
        applyAccessControls();
      }
    }

    async function selectWorkspaceSession(sessionId) {
      commandError.textContent = "";
      closeTerminalStream();
      state.terminalSessionId = sessionId;
      state.workspaceSessionEvents = [];
      state.presenceFocus = sessionId ? "session:" + sessionId : "";
      void heartbeatProjectPresence();
      terminalOutput.hidden = false;
      terminalOutput.textContent = "";
      const session = selectedWorkspaceSession();
      setTerminalControls(Boolean(session && session.status === "running"));
      renderWorkspaceSessions();
      try {
        await loadWorkspaceSessionEvents();
        if (session && session.status === "running") startTerminalStream(workspaceSessionEventsAfter());
      } catch (error) {
        commandError.textContent = error.message;
        setTerminalControls(false);
      }
    }

    async function loadWorkspaceSessionEvents() {
      if (!state.terminalSessionId) {
        state.workspaceSessionEvents = [];
        return [];
      }
      const response = await fetch(workspaceSessionActionUrl("events"), { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "failed to load session transcript");
      state.workspaceSessionEvents = Array.isArray(data) ? data : [];
      terminalOutput.textContent = "";
      for (const event of state.workspaceSessionEvents) renderTerminalEvent(event);
      return state.workspaceSessionEvents;
    }

    async function startWorkspaceSession() {
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      commandError.textContent = "";
      resetTerminalSession();
      terminalOutput.hidden = false;
      terminalOutput.textContent = "";
      startSessionButton.disabled = true;
      try {
        const response = await fetch(workspaceSessionsUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ command: workspaceCommandInput.value.trim() || "sh", clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to start session");
        state.terminalSessionId = data.sessionId;
        state.presenceFocus = "session:" + data.sessionId;
        void heartbeatProjectPresence();
        await loadTenantAudit();
        await loadWorkspaceSessions();
        await loadWorkspaceSessionEvents();
        setTerminalControls(true);
        startTerminalStream(workspaceSessionEventsAfter());
      } catch (error) {
        commandError.textContent = error.message;
        setTerminalControls(false);
      }
    }

    async function sendWorkspaceSessionInput() {
      if (!state.terminalSessionId) return;
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      commandError.textContent = "";
      sendSessionInputButton.disabled = true;
      try {
        const response = await fetch(workspaceSessionActionUrl("input"), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ input: terminalInput.value, clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to send input");
      } catch (error) {
        commandError.textContent = error.message;
      } finally {
        sendSessionInputButton.disabled = !canMutate() || !isSelectedWorkspaceSessionRunning();
      }
    }

    async function stopWorkspaceSession() {
      if (!state.terminalSessionId) return;
      if (!canMutate()) {
        commandError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      commandError.textContent = "";
      stopSessionButton.disabled = true;
      try {
        const response = await fetch(workspaceSessionActionUrl("stop"), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to stop session");
        await loadTenantAudit();
      } catch (error) {
        commandError.textContent = error.message;
        stopSessionButton.disabled = !canMutate();
      }
    }

    function startTerminalStream(after = workspaceSessionEventsAfter()) {
      if (!state.terminalSessionId) return;
      if (state.terminalStream) state.terminalStream.close();
      const stream = new EventSource(workspaceSessionActionUrl("events", true, { after }));
      state.terminalStream = stream;
      stream.addEventListener("workspace_session", async (message) => {
        const event = JSON.parse(message.data);
        if (isLoadedWorkspaceSessionEvent(event)) return;
        state.workspaceSessionEvents = state.workspaceSessionEvents.concat(event);
        renderTerminalEvent(event);
        if (event.type === "exit") {
          stream.close();
          if (state.terminalStream === stream) state.terminalStream = null;
          await loadWorkspaceSessions();
          setTerminalControls(false);
        }
      });
    }

    function workspaceSessionEventsAfter() {
      return state.workspaceSessionEvents.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
    }

    function isLoadedWorkspaceSessionEvent(event) {
      const seq = Number(event && event.seq);
      return Number.isFinite(seq) && state.workspaceSessionEvents.some((entry) => Number(entry.seq) === seq);
    }

    function renderTerminalEvent(event) {
      terminalOutput.hidden = false;
      if (event.type === "start") {
        terminalOutput.textContent += \`$ \${event.data || ""}\\n\`;
      } else if (event.type === "input") {
        terminalOutput.textContent += formatWorkspaceSessionInput(event);
      } else if (event.type === "stop") {
        terminalOutput.textContent += formatWorkspaceSessionStop(event);
      } else if (event.type === "stdout" || event.type === "stderr") {
        terminalOutput.textContent += event.data || "";
      } else if (event.type === "exit") {
        terminalOutput.textContent += \`\\n[exit \${event.exitCode}]\\n\`;
      }
      terminalOutput.scrollTop = terminalOutput.scrollHeight;
    }

    function formatWorkspaceSessionInput(event) {
      const actor = [
        event.actor || event.clientId,
        event.role,
        event.actor && event.clientId ? event.clientId : ""
      ].filter(Boolean).join(" ");
      const bytes = event.dataBytes !== undefined ? event.dataBytes + " bytes" : "input";
      return "\\n[input " + bytes + (actor ? " by " + actor : "") + "]\\n";
    }

    function formatWorkspaceSessionStop(event) {
      const actor = [
        event.actor || event.clientId,
        event.role,
        event.actor && event.clientId ? event.clientId : ""
      ].filter(Boolean).join(" ");
      return "\\n[stop" + (actor ? " by " + actor : "") + "]\\n";
    }

    async function selectRun(runId, follow = false) {
      closeStream();
      resetTerminalSession();
      const response = await fetch(runUrl(runId), { headers: authHeaders() });
      if (!response.ok) throw new Error("failed to load run");
      state.selected = await response.json();
      syncDashboardUrl();
      state.presenceFocus = "run:" + state.selected.runId;
      const eventResponse = await fetch(eventsUrl(runId), { headers: authHeaders() });
      const data = eventResponse.ok ? await eventResponse.json() : [];
      state.events = Array.isArray(data) ? data : [];
      state.replay = null;
      state.reviewSummary = null;
      state.handoffPackage = null;
      state.handoffFollowups = null;
      state.workspaceCommands = [];
      state.selectedCommandId = null;
      state.workspaceSessions = [];
      state.workspaceInfo = null;
      state.workspaceDiff = null;
      prefillWorkspacePullRequestFields(state.selected.metadata || {});
      renderRuns();
      renderVasCaseRuns();
      renderSummary();
      renderEvents();
      renderReplay();
      renderReviewSummary();
      renderHandoffPackage();
      renderHandoffFollowups();
      renderWorkspaceInfo();
      renderWorkspaceDiff();
      renderWorkspaceCommands();
      renderWorkspaceSessions();
      await loadWorkspaceInfo();
      await loadWorkspaceCommands();
      await loadWorkspaceSessions();
      await heartbeatProjectPresence();
      if (follow || state.selected.status === "running") startStream(runId);
    }

    function prefillWorkspacePullRequestFields(metadata) {
      if (!workspacePrIssueInput.value.trim() && metadata.issue) workspacePrIssueInput.value = metadata.issue;
      if (!workspacePrBranchInput.value.trim() && metadata.branch) workspacePrBranchInput.value = metadata.branch;
      if (!workspacePrBaseInput.value.trim() && metadata.baseBranch) workspacePrBaseInput.value = metadata.baseBranch;
    }

    function prefillProjectWorkspacePullRequestFields(projectSummary) {
      workspacePrIssueInput.value = projectSummary.issue || "";
      workspacePrBranchInput.value = projectSummary.branch || "";
      workspacePrBaseInput.value = projectSummary.baseBranch || "";
    }

    async function loadReplay(options = {}) {
      if (!state.selected) return;
      const quiet = options.quiet === true;
      const previousCheckpoint = state.replay && state.replay.checkpoint;
      if (!quiet) connection.textContent = "loading replay";
      if (!quiet) loadReplayButton.disabled = true;
      try {
        const response = await fetch(replayUrl(state.selected.runId), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load replay");
        state.replay = data;
        rememberEvidenceRefresh("replay", "replay", previousCheckpoint, data.checkpoint, quiet);
        renderReplay();
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        if (quiet) {
          rememberEvidenceRefreshFailure("replay", "replay", state.replay && state.replay.checkpoint, error);
          renderReplay();
          return;
        }
        if (!quiet) connection.textContent = "error";
        runReplay.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
      } finally {
        if (!quiet) loadReplayButton.disabled = false;
      }
    }

    async function loadReviewSummary(options = {}) {
      if (!state.selected) return;
      const quiet = options.quiet === true;
      const previousCheckpoint = state.reviewSummary && state.reviewSummary.checkpoint;
      if (!quiet) connection.textContent = "loading review summary";
      if (!quiet) loadReviewSummaryButton.disabled = true;
      try {
        const response = await fetch(reviewSummaryUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load review summary");
        state.reviewSummary = data;
        rememberEvidenceRefresh("reviewSummary", "review summary", previousCheckpoint, data.checkpoint, quiet);
        state.workspaceDiff = data.diff || null;
        renderReviewSummary();
        renderWorkspaceDiff();
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        if (quiet) {
          rememberEvidenceRefreshFailure("reviewSummary", "review summary", state.reviewSummary && state.reviewSummary.checkpoint, error);
          renderReviewSummary();
          return;
        }
        state.reviewSummary = null;
        if (!quiet) connection.textContent = "error";
        reviewSummary.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
      } finally {
        if (!quiet) loadReviewSummaryButton.disabled = !state.selected;
      }
    }

    async function loadHandoffPackage(options = {}) {
      if (!state.selected) return;
      const quiet = options.quiet === true;
      const previousCheckpoint = state.handoffPackage && state.handoffPackage.checkpoint;
      if (!quiet) connection.textContent = "loading package";
      if (!quiet) loadHandoffPackageButton.disabled = true;
      try {
        const response = await fetch(handoffPackageUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load handoff package");
        state.handoffPackage = data;
        rememberEvidenceRefresh("handoffPackage", "handoff package", previousCheckpoint, data.checkpoint, quiet);
        state.reviewSummary = data.reviewSummary || null;
        state.workspaceInfo = data.workspace || null;
        state.workspaceDiff = data.reviewSummary && data.reviewSummary.diff ? data.reviewSummary.diff : null;
        if (state.workspaceInfo) prefillWorkspacePullRequestFields(state.workspaceInfo);
        renderHandoffPackage();
        renderReviewSummary();
        renderWorkspaceInfo();
        renderWorkspaceDiff();
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        if (quiet) {
          rememberEvidenceRefreshFailure("handoffPackage", "handoff package", state.handoffPackage && state.handoffPackage.checkpoint, error);
          renderHandoffPackage();
          return;
        }
        state.handoffPackage = null;
        if (!quiet) connection.textContent = "error";
        handoffPackage.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
      } finally {
        if (!quiet) loadHandoffPackageButton.disabled = !state.selected;
      }
    }

    async function loadHandoffFollowups(options = {}) {
      if (!state.selected) return;
      const quiet = options.quiet === true;
      const previousCheckpoint = state.handoffFollowups && state.handoffFollowups.checkpoint;
      if (!quiet) connection.textContent = "loading follow-ups";
      if (!quiet) loadHandoffFollowupsButton.disabled = true;
      try {
        const response = await fetch(handoffFollowupUrl(), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to load follow-up lineage");
        state.handoffFollowups = data;
        rememberEvidenceRefresh("handoffFollowups", "follow-up lineage", previousCheckpoint, data.checkpoint, quiet);
        renderHandoffFollowups(data);
        if (!quiet) connection.textContent = "ready";
      } catch (error) {
        if (quiet) {
          rememberEvidenceRefreshFailure("handoffFollowups", "follow-up lineage", state.handoffFollowups && state.handoffFollowups.checkpoint, error);
          renderHandoffFollowups();
          return;
        }
        state.handoffFollowups = null;
        if (!quiet) connection.textContent = "error";
        handoffFollowups.innerHTML = \`<div class="empty">\${escapeHtml(error.message)}</div>\`;
      } finally {
        if (!quiet) loadHandoffFollowupsButton.disabled = !state.selected;
      }
    }

    async function startHandoffFollowup() {
      if (!state.selected) return;
      if (!canMutate()) {
        connection.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      connection.textContent = "starting follow-up";
      startHandoffFollowupButton.disabled = true;
      try {
        if (!await ensureHandoffPackageCheckpoint()) return;
        const response = await fetch(handoffFollowupUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(handoffFollowupBodyFromForm())
        });
        const data = await response.json();
        if (response.status === 409 && data.currentCheckpoint) {
          await loadHandoffPackage({ quiet: true });
          throw new Error("handoff checkpoint changed; refreshed package, retry follow-up");
        }
        if (!response.ok) throw new Error(data.error || "follow-up run creation failed");
        await loadTenantAudit();
        await loadRuns();
        await selectRun(data.runId, true);
        connection.textContent = \`started follow-up \${data.runId}\`;
      } catch (error) {
        connection.textContent = "error";
        formError.textContent = error.message;
      } finally {
        startHandoffFollowupButton.disabled = !canMutate() || !state.selected;
      }
    }

    async function ensureHandoffPackageCheckpoint() {
      if (checkpointVersion(state.handoffPackage && state.handoffPackage.checkpoint)) return true;
      await loadHandoffPackage({ quiet: true });
      if (checkpointVersion(state.handoffPackage && state.handoffPackage.checkpoint)) return true;
      throw new Error("load handoff package before starting follow-up");
    }

    function handoffFollowupBodyFromForm() {
      const body = { queue: true, clientId: state.clientId };
      body.sourceCheckpointVersion = checkpointVersion(state.handoffPackage && state.handoffPackage.checkpoint);
      if (!body.sourceCheckpointVersion) delete body.sourceCheckpointVersion;
      const preset = optionalValue(runPresetInput);
      if (preset) {
        body.preset = preset;
        body.presetInput = { caseId: optionalValue(runPresetCaseInput) || "bootstrap" };
      }
      if (goalInput.value.trim() && goalInput.value.trim() !== "create hello.txt") body.goal = goalInput.value.trim();
      if (verifyInput.value.trim() && verifyInput.value.trim() !== "test -f hello.txt") body.verify = lines(verifyInput.value);
      body.evaluate = lines(evaluateInput.value);
      body.reviewer = lines(reviewerInput.value);
      body.allowedTools = lines(allowedToolsInput.value);
      body.repo = optionalValue(repoInput);
      body.branch = optionalValue(branchInput);
      body.baseBranch = optionalValue(baseBranchInput);
      body.issue = optionalValue(issueInput);
      body.syncIssueComments = syncIssueCommentsOnCreateInput.checked;
      body.pullRequest = pullRequestInput.checked;
      body.reviewRequired = reviewRequiredInput.checked;
      body.deploymentRequired = deploymentRequiredInput.checked;
      if (!body.preset && agentModeInput.value === "model") {
        body.model = modelInput.value.trim();
        body.modelProtocol = modelProtocolInput.value;
      } else if (!body.preset) {
        body.script = JSON.parse(scriptInput.value);
      }
      return body;
    }

    async function sendRunComment() {
      if (!state.selected) return;
      if (!runCommentInput.value.trim()) {
        connection.textContent = "comment is required";
        return;
      }
      connection.textContent = "sending comment";
      sendRunCommentButton.disabled = true;
      try {
        const response = await fetch(runCommentUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ message: runCommentInput.value.trim(), pause: runCommentPauseInput.checked, clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to send run comment");
        runCommentInput.value = "";
        runCommentPauseInput.checked = false;
        await refreshSelected(state.selected.runId);
        await refreshSelectedEvents();
        await loadTenantAudit();
        if (state.replay) await loadReplay();
        if (state.reviewSummary) await loadReviewSummary();
        if (state.handoffPackage) await loadHandoffPackage();
        connection.textContent = "comment sent";
      } catch (error) {
        connection.textContent = error.message;
      } finally {
        sendRunCommentButton.disabled = !state.selected || !state.tenantAccess;
      }
    }

    async function syncIssueComments() {
      if (!state.selected) return;
      connection.textContent = "syncing issue comments";
      syncIssueCommentsButton.disabled = true;
      try {
        const response = await fetch(issueCommentsSyncUrl(), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed to sync issue comments");
        await refreshSelected(state.selected.runId);
        await refreshSelectedEvents();
        await loadTenantAudit();
        await loadProjects();
        await loadRuns();
        await loadVasCases(true);
        if (state.replay) await loadReplay();
        if (state.reviewSummary) await loadReviewSummary();
        if (state.handoffPackage) await loadHandoffPackage();
        connection.textContent = issueCommentsSyncSummary(data);
      } catch (error) {
        connection.textContent = error.message;
      } finally {
        syncIssueCommentsButton.disabled = !state.selected || !state.tenantAccess || !state.selected.metadata || !state.selected.metadata.issue;
      }
    }

    async function claimReview() {
      await updateReviewClaim("claim");
    }

    async function releaseReview() {
      await updateReviewClaim("release");
    }

    async function updateReviewClaim(action) {
      if (!state.selected) return;
      if (!canMutate()) {
        reviewError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      const hadReplay = Boolean(state.replay);
      const hadReviewSummary = Boolean(state.reviewSummary);
      const hadHandoffPackage = Boolean(state.handoffPackage);
      reviewError.textContent = "";
      reviewClaimButton.disabled = true;
      reviewReleaseClaimButton.disabled = true;
      try {
        const response = await fetch(reviewClaimUrl(state.selected.runId), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ action, clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "review claim update failed");
        await loadTenantAudit();
        await selectRun(data.runId);
        await loadRuns();
        if (hadReplay) await loadReplay();
        if (hadReviewSummary) await loadReviewSummary();
        if (hadHandoffPackage) await loadHandoffPackage();
      } catch (error) {
        reviewError.textContent = error.message;
      } finally {
        renderReviewPanel();
      }
    }

    async function reviewRun(decision) {
      if (!state.selected) return;
      if (!canMutate()) {
        reviewError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      reviewError.textContent = "";
      setReviewDisabled(true);
      try {
        const body = {
          decision,
          note: reviewNoteInput.value.trim(),
          merge: decision === "approved" && reviewMergeInput.checked,
          clientId: state.clientId
        };
        const contractPatch = reviewContractPatchFromForm();
        if (contractPatch) body.contractPatch = contractPatch;
        const response = await fetch(reviewUrl(state.selected.runId), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "review decision failed");
        reviewNoteInput.value = "";
        clearReviewContractPatchForm();
        reviewMergeInput.checked = false;
        await loadTenantAudit();
        await selectRun(data.runId);
        await loadRuns();
      } catch (error) {
        reviewError.textContent = error.message;
      } finally {
        setReviewDisabled(!canMutate());
      }
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
      if (!state.selected) return;
      if (!canAdmin()) {
        deploymentError.textContent = "admin access is required";
        applyAccessControls();
        return;
      }
      deploymentError.textContent = "";
      setDeploymentDisabled(true);
      try {
        const response = await fetch(deploymentUrl(state.selected.runId), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            decision,
            note: deploymentNoteInput.value.trim(),
            clientId: state.clientId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "deployment decision failed");
        deploymentNoteInput.value = "";
        await loadTenantAudit();
        await selectRun(data.runId);
        await loadRuns();
      } catch (error) {
        deploymentError.textContent = error.message;
      } finally {
        setDeploymentDisabled(!canAdmin());
      }
    }

    async function cancelRun() {
      if (!isCancellableRun(state.selected)) return;
      if (!canMutate()) {
        cancelError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      cancelError.textContent = "";
      cancelRunButton.disabled = true;
      try {
        const response = await fetch(cancelUrl(state.selected.runId), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ reason: "cancelled from dashboard", clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "cancel failed");
        await loadTenantAudit();
        await selectRun(data.runId);
        await loadRuns();
      } catch (error) {
        cancelError.textContent = error.message;
        if (/not running in this server process/.test(error.message)) {
          abandonRunButton.hidden = false;
          cancelError.textContent = "Cancel unavailable in this server process. Use abandon to mark the orphaned run cancelled.";
        }
      } finally {
        cancelRunButton.disabled = !canMutate();
      }
    }

    async function resumeRun() {
      if (!state.selected || state.selected.status !== "paused") return;
      if (!canMutate()) {
        cancelError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      cancelError.textContent = "";
      resumeRunButton.disabled = true;
      try {
        const response = await fetch(resumeUrl(state.selected.runId), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "resume failed");
        await loadTenantAudit();
        await loadHarnessStatus();
        await selectRun(data.runId);
        await loadRuns();
      } catch (error) {
        cancelError.textContent = error.message;
      } finally {
        resumeRunButton.disabled = !canMutate();
      }
    }

    async function abandonRun() {
      if (!state.selected || state.selected.status !== "running") return;
      if (!canMutate()) {
        cancelError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      cancelError.textContent = "";
      abandonRunButton.disabled = true;
      try {
        const response = await fetch(abandonUrl(state.selected.runId), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ reason: "abandoned from dashboard", clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "abandon failed");
        await loadTenantAudit();
        await selectRun(data.runId);
        await loadRuns();
      } catch (error) {
        cancelError.textContent = error.message;
      } finally {
        abandonRunButton.disabled = !canMutate();
      }
    }

    async function abandonStaleRun(runProject, runId) {
      if (!runId) return;
      if (!canMutate()) {
        cancelError.textContent = "viewer access is read-only";
        applyAccessControls();
        return;
      }
      cancelError.textContent = "";
      try {
        const response = await fetch(abandonStaleUrl(runId, runProject), {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ reason: "stale lease cleanup from dashboard", clientId: state.clientId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "abandon stale failed");
        await loadTenantAudit();
        await loadHarnessStatus();
        await loadRuns();
        if (state.selected && state.selected.runId === data.runId) {
          await selectRun(data.runId);
        }
      } catch (error) {
        cancelError.textContent = error.message;
      }
    }

    function startStream(runId) {
      closeStream();
      connection.textContent = "streaming";
      const after = runEventsAfter();
      const stream = new EventSource(streamUrl(runId, after));
      state.stream = stream;
      stream.addEventListener("harness_event", async (message) => {
        const event = JSON.parse(message.data);
        if (isLoadedRunEvent(event)) return;
        state.events = state.events.concat(event);
        renderEvents();
        if (state.replay) await loadReplay({ quiet: true });
        if (event.type === "finish") {
          stream.close();
          if (state.stream === stream) state.stream = null;
          await refreshSelected(runId);
          await loadRuns();
          if (state.reviewSummary) await loadReviewSummary({ quiet: true });
          if (state.handoffPackage) await loadHandoffPackage({ quiet: true });
        }
      });
    }

    function runEventsAfter() {
      return state.events.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
    }

    function isLoadedRunEvent(event) {
      const seq = Number(event && event.seq);
      return Number.isFinite(seq) && state.events.some((entry) => Number(entry.seq) === seq);
    }

    async function refreshSelected(runId) {
      const response = await fetch(runUrl(runId), { headers: authHeaders() });
      if (response.ok) {
        state.selected = await response.json();
        renderSummary();
      }
    }

    async function refreshSelectedEvents() {
      if (!state.selected) return;
      const eventResponse = await fetch(eventsUrl(state.selected.runId), { headers: authHeaders() });
      const data = eventResponse.ok ? await eventResponse.json() : state.events;
      state.events = Array.isArray(data) ? data : state.events;
      renderEvents();
    }

    function closeStream() {
      if (state.stream) state.stream.close();
      state.stream = null;
    }

    function closeTerminalStream() {
      if (state.terminalStream) state.terminalStream.close();
      state.terminalStream = null;
    }

    function resetTerminalSession() {
      closeTerminalStream();
      state.terminalSessionId = null;
      state.workspaceSessionEvents = [];
      terminalOutput.hidden = true;
      terminalOutput.textContent = "";
      setTerminalControls(false);
    }

    function selectedWorkspaceSession() {
      return state.workspaceSessions.find((session) => session.sessionId === state.terminalSessionId);
    }

    function isSelectedWorkspaceSessionRunning() {
      const session = selectedWorkspaceSession();
      return Boolean(session && session.status === "running");
    }

    function isCancellableRun(run) {
      return Boolean(run && (run.status === "running" || run.status === "queued"));
    }

    function accessRole() {
      return state.tenantAccess && state.tenantAccess.role ? state.tenantAccess.role : "viewer";
    }

    function canMutate() {
      const role = accessRole();
      return role === "admin" || role === "developer";
    }

    function canAdmin() {
      return accessRole() === "admin";
    }

    function setTerminalControls(running) {
      startSessionButton.disabled = !canMutate() || running;
      sendSessionInputButton.disabled = !canMutate() || !running;
      stopSessionButton.disabled = !canMutate() || !running;
    }

    function selectedWorkspaceCommand() {
      return state.workspaceCommands.find((command) => command.commandId === state.selectedCommandId);
    }

    function currentTenantResources(status) {
      const resources = status.resources || {};
      const tenants = Array.isArray(resources.tenants) ? resources.tenants : [];
      return tenants.find((entry) => entry.tenant === tenant()) || {
        tenant: status.tenant || tenant(),
        activeRuns: resources.activeRuns || 0,
        queuedRuns: resources.queuedRuns || 0,
        activeWorkspaceSessions: resources.activeWorkspaceSessions || 0,
        activeWorkspaceSessionDetails: Array.isArray(resources.activeWorkspaceSessionDetails) ? resources.activeWorkspaceSessionDetails : []
      };
    }

    function currentTenantQueuedRuns(status) {
      const resources = status.resources || {};
      const queuedRuns = Array.isArray(resources.queuedRunDetails) ? resources.queuedRunDetails : [];
      return status.tenant ? queuedRuns : queuedRuns.filter((run) => run.tenant === tenant());
    }

    function queuedRunDetailForRun(run) {
      const status = state.harnessStatus || {};
      const resources = status.resources || {};
      const queuedRuns = Array.isArray(resources.queuedRunDetails) ? resources.queuedRunDetails : [];
      const runTenant = run.metadata && run.metadata.tenant ? run.metadata.tenant : tenant();
      const runProject = run.metadata && run.metadata.project ? run.metadata.project : project();
      return queuedRuns.find((entry) =>
        entry.runId === run.runId &&
        (!entry.tenant || entry.tenant === runTenant) &&
        (!entry.project || entry.project === runProject)
      );
    }

    function formatRunQueueMeta(run) {
      const detail = queuedRunDetailForRun(run);
      if (detail && detail.blockedReason) return "blocked: " + formatQueuedRunBlocker(detail);
      if (detail) return "queue: " + formatQueuedRunBlocker(detail);
      if (run.status === "queued" && run.queuedAt) return "queued " + run.queuedAt;
      if (run.status === "queued") return "queued";
      return "";
    }

    function currentTenantOrphanedRunningRuns(status) {
      const resources = status.resources || {};
      const runs = Array.isArray(resources.orphanedRunningRunDetails) ? resources.orphanedRunningRunDetails : [];
      return status.tenant ? runs : runs.filter((run) => run.tenant === tenant());
    }

    function currentTenantQueueRecoveryErrors(status) {
      const resources = status.resources || {};
      const queueRecovery = resources.queueRecovery || {};
      const errors = Array.isArray(queueRecovery.errors) ? queueRecovery.errors : [];
      return errors.filter((error) => !error.tenant || error.tenant === tenant());
    }

    function formatQueueRecovery(queueRecovery) {
      return \`queue recovery \${queueRecovery.status || "unknown"}: \${queueRecovery.recoveredQueuedRuns || 0} recovered / \${queueRecovery.failedQueuedRuns || 0} failed\`;
    }

    function formatStaleRunCleanup(staleRunCleanup) {
      return \`stale cleanup \${staleRunCleanup.status || "unknown"}: \${staleRunCleanup.abandonedStaleRuns || 0} abandoned / \${staleRunCleanup.skippedRunningRuns || 0} skipped\`;
    }

    function formatProfileReadiness(readiness, label = "profile readiness") {
      if (!readiness) return \`\${label} not reported\`;
      const profile = readiness.profile || "unprofiled";
      if (readiness.ok === true) return \`\${label} \${profile}: ready\`;
      const missing = Array.isArray(readiness.missing) && readiness.missing.length
        ? readiness.missing.join(", ")
        : "unknown";
      return \`\${label} \${profile}: missing \${missing}\`;
    }

    function formatAgentGitServiceProjectAgentsReadiness(check) {
      if (!check || typeof check !== "object") return "agentGitServiceProjectAgents: unknown";
      const state = check.ok ? "ready" : "missing";
      const provider = check.provider ? " provider " + check.provider : "";
      const projectCount = Number.isFinite(check.projectCount) ? check.projectCount : undefined;
      const provisionedProjectCount = Number.isFinite(check.provisionedProjectCount) ? check.provisionedProjectCount : undefined;
      const secretStoredProjectCount = Number.isFinite(check.secretStoredProjectCount) ? check.secretStoredProjectCount : undefined;
      const counts = [
        provisionedProjectCount !== undefined && projectCount !== undefined
          ? "provisioned " + provisionedProjectCount + "/" + projectCount
          : "",
        secretStoredProjectCount !== undefined && projectCount !== undefined
          ? "secrets " + secretStoredProjectCount + "/" + projectCount
          : "",
        check.secretRootConfigured === false ? "secret root not configured" : "",
      ].filter(Boolean).join(", ");
      const missingProjects = Array.isArray(check.missingProjects) && check.missingProjects.length
        ? " missing receipt " + check.missingProjects.join(", ")
        : "";
      const missingSecretProjects = Array.isArray(check.missingSecretProjects) && check.missingSecretProjects.length
        ? " missing secret " + check.missingSecretProjects.join(", ")
        : "";
      return \`agentGitServiceProjectAgents: \${state}\${provider}\${counts ? " " + counts : ""}\${missingProjects}\${missingSecretProjects}\`;
    }

    function renderProjectControlPlane(project) {
      const text = formatProjectControlPlane(project);
      if (!text) return "";
      const agent = project && project.controlPlane && project.controlPlane.agentGitServiceProjectAgent;
      const stateClass = agent && agent.ready ? "passed" : "queued";
      return \`<span class="pill \${stateClass}">\${escapeHtml(text)}</span>\`;
    }

	    function formatProjectControlPlane(project) {
	      const controlPlane = project && project.controlPlane;
	      if (!controlPlane || controlPlane.provider !== "agent-git-service") return "";
	      const agent = controlPlane.agentGitServiceProjectAgent;
	      if (!agent) return "agent project unknown";
      const state = agent.ready ? "ready" : agent.receiptPresent ? "missing secret" : "missing receipt";
      return [
        \`agent project \${state}\`,
        agent.agentLogin ? \`agent \${agent.agentLogin}\` : "",
        agent.repo ? \`repo \${agent.repo}\` : "",
	        agent.tokenEnvName ? \`token env \${agent.tokenEnvName}\` : ""
	      ].filter(Boolean).join(", ");
	    }

	    function renderProjectConcurrency(project) {
	      const text = formatProjectConcurrency(project);
	      if (!text) return "";
	      const state = project.concurrency.state;
	      const stateClass = state === "contended" ? "failed" : state === "queued" ? "queued" : "running";
	      return \`<span class="pill \${stateClass}">\${escapeHtml(text)}</span>\`;
	    }

	    function formatProjectConcurrency(project) {
	      const concurrency = project && project.concurrency;
	      if (!concurrency || !concurrency.state) return "";
	      const parts = [\`concurrency \${concurrency.state}\`];
	      if (concurrency.runningRunId) parts.push(\`run \${concurrency.runningRunId}\`);
	      if (concurrency.queuedRunCount > 0) parts.push(\`\${concurrency.queuedRunCount} queued\`);
	      if (concurrency.activeWorkspaceSessions > 0) {
	        parts.push(\`\${concurrency.activeWorkspaceSessions} session\${concurrency.activeWorkspaceSessions === 1 ? "" : "s"}\`);
	      }
	      if (concurrency.activeProjectCollaboratorCount > 0) {
	        parts.push(\`\${concurrency.activeProjectCollaboratorCount} project collaborator\${concurrency.activeProjectCollaboratorCount === 1 ? "" : "s"}\`);
	      }
	      if (concurrency.activeRunCollaboratorCount > 0) {
	        parts.push(\`\${concurrency.activeRunCollaboratorCount} run collaborator\${concurrency.activeRunCollaboratorCount === 1 ? "" : "s"}\`);
	      }
	      if (concurrency.workspaceConflictCount > 0) {
	        const latest = concurrency.latestWorkspaceConflict || {};
	        parts.push(\`\${concurrency.workspaceConflictCount} conflict\${concurrency.workspaceConflictCount === 1 ? "" : "s"}\`);
	        if (latest.path) parts.push(\`latest \${latest.path}\`);
	      }
	      return parts.join(", ");
	    }

	    function formatProfileReadinessCheck(name, check) {
	      if (!check || typeof check !== "object") return \`\${name}: unknown\`;
	      if (name === "agentGitServiceProjectAgents") return formatAgentGitServiceProjectAgentsReadiness(check);
      const state = check.ok ? "ready" : "missing";
      const required = check.required ? "required" : "optional";
      const missingTools = Array.isArray(check.missingTools) && check.missingTools.length
        ? " missing tools " + check.missingTools.join(", ")
        : "";
      const executorKind = check.executorKind ? " executor " + check.executorKind : "";
      return \`\${name}: \${state} \${required}\${missingTools}\${executorKind}\`;
    }

    function renderProfileReadiness(readiness, label = "profile readiness") {
      if (!readiness) return \`<span>\${escapeHtml(label)} not reported</span>\`;
      const checks = readiness.checks && typeof readiness.checks === "object"
        ? Object.entries(readiness.checks)
        : [];
      const missing = Array.isArray(readiness.missing) ? readiness.missing : [];
      return [
        \`<span class="pill \${readiness.ok ? "passed" : "failed"}">\${escapeHtml(formatProfileReadiness(readiness, label))}</span>\`,
        missing.length ? \`<span>missing readiness \${escapeHtml(missing.join(", "))}</span>\` : "",
        ...checks.map(([name, check]) => \`<span>\${escapeHtml(formatProfileReadinessCheck(name, check))}</span>\`),
      ].filter(Boolean).join("");
    }

    function formatProfileGoldenPath(readiness, label = "golden path") {
      const goldenPath = readiness && readiness.goldenPath;
      if (!goldenPath || typeof goldenPath !== "object") return \`\${label} not reported\`;
      if (goldenPath.required === false) return \`\${label} not required\`;
      const profile = readiness.profile || "profile";
      if (goldenPath.ok === true) return \`\${label} \${profile}: ready\`;
      const missing = Array.isArray(goldenPath.missingCapabilities) && goldenPath.missingCapabilities.length
        ? goldenPath.missingCapabilities.join(", ")
        : "unknown";
      return \`\${label} \${profile}: missing \${missing}\`;
    }

    function renderProfileGoldenPath(readiness) {
      const goldenPath = readiness && readiness.goldenPath;
      if (!goldenPath || typeof goldenPath !== "object") return "";
      const capabilities = Array.isArray(goldenPath.capabilities) ? goldenPath.capabilities : [];
      return [
        \`<span class="pill \${goldenPath.ok ? "passed" : "failed"}">\${escapeHtml(formatProfileGoldenPath(readiness))}</span>\`,
        capabilities.length ? \`<span>golden path capabilities \${escapeHtml(capabilities.length)}</span>\` : "",
      ].filter(Boolean).join("");
    }

    function formatVisionLock(visionLock) {
      if (!visionLock || typeof visionLock !== "object") return "";
      const target = visionLock.target || "larger platform target";
      const capabilities = Array.isArray(visionLock.capabilities) ? visionLock.capabilities.length : 0;
      const scope = visionLock.mvpIsScopeReduction === false ? "MVP is not scope reduction" : "MVP scope unknown";
      return \`vision lock: \${target}; \${scope}; \${capabilities} capabilities\`;
    }

    function formatControlPlane(controlPlane) {
      if (!controlPlane || typeof controlPlane !== "object") return "";
      const provider = controlPlane.provider || "unknown";
      const boundary = Array.isArray(controlPlane.boundary) ? controlPlane.boundary : [];
      return \`control plane \${provider}\${boundary.length ? ": " + boundary.join(", ") : ""}\`;
    }

    function formatOrphanedRunningRun(run) {
      const lease = run.stale ? "lease expired" : "lease active";
      return \`\${run.project}/\${run.runId}: \${lease}\`;
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

    function currentTenantActiveWorkspaceSessionDetails(status) {
      const resources = status.resources || {};
      const tenantResources = currentTenantResources(status);
      if (Array.isArray(tenantResources.activeWorkspaceSessionDetails)) return tenantResources.activeWorkspaceSessionDetails;
      const sessions = Array.isArray(resources.activeWorkspaceSessionDetails) ? resources.activeWorkspaceSessionDetails : [];
      return status.tenant ? sessions : sessions.filter((session) => session.tenant === tenant());
    }

    function formatStatusWorkspaceSession(session) {
      const route = session.route === "run" && session.runId ? \`run \${session.runId}\` : "project";
      const owner = session.actor || session.clientId || "system";
      const lifecycle = workspaceSessionLifecycleMeta(session);
      return [
        \`\${session.project}/\${session.sessionId}\`,
        route,
        session.command || "",
        \`by \${owner}\`,
        lifecycle
      ].filter(Boolean).join(" / ");
    }

    function formatTenantAuditEvent(event) {
      const data = event.data || {};
      const target = [data.project, data.runId || data.sessionId || data.commandId].filter(Boolean).join("/");
      const modelUsage = data.modelUsage ? " model " + formatModelUsage(data.modelUsage) : "";
      const modelWarnings = Array.isArray(data.modelUsageWarnings) && data.modelUsageWarnings.length
        ? " model warnings " + data.modelUsageWarnings.map(formatProjectModelUsageWarning).join("; ")
        : "";
      const details = formatTenantAuditDetails(event.type, data);
      return \`#\${event.seq} \${event.type}\${target ? " " + target : ""}\${modelUsage}\${modelWarnings}\${details ? " " + details : ""}\`;
    }

    function formatTenantAuditDetails(type, data) {
      const parts = [];
      if (type === "tenant_api_key_created" && data.createdApiKey) {
        parts.push("created key " + formatTenantAuditApiKey(data.createdApiKey));
      }
      if (type === "tenant_api_key_revoked" && Array.isArray(data.revokedApiKeys) && data.revokedApiKeys.length) {
        parts.push("revoked keys " + data.revokedApiKeys.map(formatTenantAuditApiKey).join(", "));
      }
      const keyChange = formatTenantAuditKeyChange(data);
      if (keyChange) parts.push(keyChange);
      const policyChange = formatPolicyChange(data.policyChange);
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
      const workspaceFileConflict = type === "workspace_file_conflicted" ? formatWorkspaceFileConflictAudit(data) : "";
      if (workspaceFileConflict) parts.push(workspaceFileConflict);
      if (data.clientId) parts.push("client " + data.clientId);
      return parts.length ? "(" + parts.join("; ") + ")" : "";
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

    function formatWorkspaceFileConflictAudit(data) {
      return [
        data.operation ? "operation=" + data.operation : "",
        data.path ? "path=" + data.path : "",
        data.expectedUpdatedAt ? "expected=" + data.expectedUpdatedAt : "",
        data.observedUpdatedAt ? "observed=" + data.observedUpdatedAt : "",
        data.observedKind ? "kind=" + data.observedKind : "",
        data.activeEditorCount !== undefined ? "activeEditors=" + data.activeEditorCount : ""
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

    function formatTenantAuditApiKey(key) {
      if (!key || typeof key !== "object") return "unknown";
      return \`\${key.actor || "unknown"}:\${key.role || "role"}\${key.modelKeyEnv ? "@" + key.modelKeyEnv : ""}\`;
    }

    function formatTenantAuditKeyChange(data) {
      const before = Array.isArray(data.apiKeysBefore) ? data.apiKeysBefore.length : 0;
      const after = Array.isArray(data.apiKeysAfter) ? data.apiKeysAfter.length : 0;
      if (!before && !after) return "";
      return \`members \${before}->\${after}\`;
    }

    function formatTenantPolicy(policy) {
      if (!policy) return "tenant policy not loaded";
      if (policy.error) return \`tenant policy error: \${policy.error}\`;
      const keys = Array.isArray(policy.apiKeys) && policy.apiKeys.length
        ? policy.apiKeys.map((key) => \`\${key.actor}:\${key.role}\${key.modelKeyEnv ? "@" + key.modelKeyEnv : ""}\`).join(", ")
        : "no policy keys";
      const limits = policy.limits || {};
      const limitParts = [
        limits.maxActiveRuns ? \`runs \${limits.maxActiveRuns}\` : "",
        limits.maxWorkspaceSessions ? \`sessions \${limits.maxWorkspaceSessions}\` : "",
        limits.maxWorkspaceBytes ? \`workspace bytes \${limits.maxWorkspaceBytes}\` : "",
        limits.workspaceByteWarning ? \`workspace bytes warn \${limits.workspaceByteWarning}\` : "",
        limits.modelProjectTotalTokenWarning ? \`project tokens warn \${limits.modelProjectTotalTokenWarning}\` : "",
        limits.modelRequesterTotalTokenWarning ? \`requester tokens warn \${limits.modelRequesterTotalTokenWarning}\` : "",
        limits.modelProjectTotalTokenLimit ? \`project tokens limit \${limits.modelProjectTotalTokenLimit}\` : "",
        limits.modelRequesterTotalTokenLimit ? \`requester tokens limit \${limits.modelRequesterTotalTokenLimit}\` : "",
        limits.modelProjectCostUsdWarning ? \`project cost warn \${formatModelCostUsd(limits.modelProjectCostUsdWarning)}\` : "",
        limits.modelRequesterCostUsdWarning ? \`requester cost warn \${formatModelCostUsd(limits.modelRequesterCostUsdWarning)}\` : "",
        limits.modelProjectCostUsdLimit ? \`project cost limit \${formatModelCostUsd(limits.modelProjectCostUsdLimit)}\` : "",
        limits.modelRequesterCostUsdLimit ? \`requester cost limit \${formatModelCostUsd(limits.modelRequesterCostUsdLimit)}\` : ""
      ].filter(Boolean).join(", ") || "server caps";
      const tools = Array.isArray(policy.allowedTools) ? (policy.allowedTools.join(", ") || "no tools") : "server tools";
      const model = policy.modelKeyEnv ? \`model key \${policy.modelKeyEnv}\` : "server model key";
      const coderParams = Array.isArray(policy.executorTemplateParameters)
        ? (policy.executorTemplateParameters.join(", ") || "no coder params")
        : "server coder params";
      return \`policy keys \${keys}; \${model}; coder params \${coderParams}; caps \${limitParts}; tools \${tools}\`;
    }

    function formatAgentGitServiceProvisioningResult(data) {
      const receipt = data && data.receipt ? data.receipt : {};
      return [
        \`receipt \${data.receiptPath || ".loom/control-plane/agent-git-service/provisioning.json"}\`,
        receipt.agentLogin ? \`agent \${receipt.agentLogin}\` : "",
        receipt.repo ? \`repo \${receipt.repo}\` : "",
        receipt.permission ? \`permission \${receipt.permission}\` : "",
        receipt.grantStatus ? \`grant \${receipt.grantStatus}\` : "",
        receipt.tokenEnvName ? \`token env \${receipt.tokenEnvName}\` : "",
        data.agentTokenSecret && data.agentTokenSecret.secretRef ? \`secret \${data.agentTokenSecret.secretRef}\` : "",
        data.agentToken ? \`agentToken \${data.agentToken}\` : ""
      ].filter(Boolean).join("\\n");
    }

    function renderAgentGitServiceProvisioningPlan(plan) {
      const projects = Array.isArray(plan.projects) ? plan.projects : [];
      const commands = projects
        .filter((project) => Array.isArray(project.provisionCommandArgs) && project.provisionCommandArgs.length)
        .map((project) => \`\${project.project}: \${project.provisionCommandArgs.join(" ")}\`);
      agentGitServiceProvisioningPlan.innerHTML = \`
        <h3>AGS provisioning plan: \${escapeHtml(plan.tenant || tenant())}</h3>
        <div class="meta">
          <span class="pill \${plan.readyProjectCount === plan.projectCount ? "passed" : "queued"}">\${escapeHtml(plan.readyProjectCount || 0)}/\${escapeHtml(plan.projectCount || 0)} ready</span>
          <span>\${escapeHtml(plan.provisionedProjectCount || 0)} provisioned</span>
          <span>\${escapeHtml(plan.secretStoredProjectCount || 0)} secrets stored</span>
          <span>\${escapeHtml(plan.repoConfiguredProjectCount || 0)} repos configured</span>
          <span>secret root \${escapeHtml(plan.secretRootConfigured ? "configured" : "missing")}</span>
        </div>
        \${projects.length ? \`<div class="list">\${projects.map(renderAgentGitServiceProvisioningPlanProject).join("")}</div>\` : '<div class="empty">No projects registered.</div>'}
        \${commands.length ? \`<h4>Provision commands</h4><pre>\${escapeHtml(commands.join("\\n"))}</pre>\` : ""}
      \`;
      agentGitServiceProvisioningPlan.hidden = false;
    }

    function renderAgentGitServiceCutoverReadiness(readiness) {
      const checks = readiness && readiness.checks ? readiness.checks : {};
      const projectAgents = checks.agentGitServiceProjectAgents;
      agentGitServiceCutoverReadiness.innerHTML = \`
        <h3>AGS cutover readiness: \${escapeHtml(readiness.stage || "tenant-default-cutover")}</h3>
        <div class="meta">
          <span class="pill \${readiness.ok ? "passed" : "queued"}">\${escapeHtml(readiness.ok ? "ready" : "gated")}</span>
          <span>target \${escapeHtml(readiness.targetProvider || "agent-git-service")}</span>
          <span>\${escapeHtml(formatAgentGitServiceProjectAgentsReadiness(projectAgents))}</span>
        </div>
        <pre>\${escapeHtml(JSON.stringify(readiness, null, 2))}</pre>
      \`;
      agentGitServiceCutoverReadiness.hidden = false;
    }

    function renderAgentGitServiceProvisioningPlanProject(project) {
      const missing = Array.isArray(project.missing) ? project.missing : [];
      const provisionCommandArgs = Array.isArray(project.provisionCommandArgs) ? project.provisionCommandArgs : [];
      return \`
        <div class="run-item">
          <span class="run-title">\${escapeHtml(project.project || "unknown")}</span>
          <div class="meta">
            <span class="pill \${project.ready ? "passed" : "queued"}">\${escapeHtml(project.ready ? "ready" : "needs provisioning")}</span>
            \${project.repo ? \`<span>\${escapeHtml(project.repo)}</span>\` : '<span>repo missing</span>'}
            <span>token env \${escapeHtml(project.tokenEnvName || "missing")}</span>
            \${project.agentLogin ? \`<span>agent \${escapeHtml(project.agentLogin)}</span>\` : ""}
            \${project.grantStatus ? \`<span>grant \${escapeHtml(project.grantStatus)}</span>\` : ""}
            \${missing.length ? \`<span>missing \${escapeHtml(missing.join(", "))}</span>\` : '<span>complete</span>'}
          </div>
          \${provisionCommandArgs.length ? \`<pre>\${escapeHtml(provisionCommandArgs.join(" "))}</pre>\` : ""}
        </div>
      \`;
    }

    function renderAgentGitServiceProvisioningPlanApplyResult(result) {
      const projects = Array.isArray(result.projects) ? result.projects : [];
      agentGitServiceProvisioningPlanApplyOutput.innerHTML = \`
        <h3>AGS provisioning \${escapeHtml(result.dryRun ? "dry run" : "apply")}: \${escapeHtml(result.tenant || tenant())}</h3>
        <div class="meta">
          <span class="pill \${result.failedProjectCount ? "failed" : result.dryRun ? "queued" : "passed"}">\${escapeHtml(result.dryRun ? "dry run" : "applied")}</span>
          <span>\${escapeHtml(result.eligibleProjectCount || 0)} eligible</span>
          <span>\${escapeHtml(result.wouldProvisionProjectCount || 0)} would provision</span>
          <span>\${escapeHtml(result.provisionedProjectCount || 0)} provisioned</span>
          <span>\${escapeHtml(result.skippedProjectCount || 0)} skipped</span>
          <span>\${escapeHtml(result.failedProjectCount || 0)} failed</span>
          <span>\${escapeHtml(result.eligibleOnly ? "eligible only" : "all selected")}</span>
          <span>token \${escapeHtml(result.tokenMaterial || "stored-only")}</span>
        </div>
        \${projects.length ? \`<div class="list">\${projects.map(renderAgentGitServiceProvisioningPlanApplyProject).join("")}</div>\` : '<div class="empty">No projects returned.</div>'}
        <pre>\${escapeHtml(JSON.stringify(result, null, 2))}</pre>
      \`;
      agentGitServiceProvisioningPlanApplyOutput.hidden = false;
    }

    function renderAgentGitServiceProvisioningPlanApplyProject(project) {
      const stateClass = project.status === "failed" ? "failed" : project.status === "skipped" || project.status === "would-provision" ? "queued" : "passed";
      const secret = project.agentTokenSecret && project.agentTokenSecret.secretRef ? \`secret \${project.agentTokenSecret.secretRef}\` : "";
      return \`
        <div class="run-item">
          <span class="run-title">\${escapeHtml(project.project || "unknown")}</span>
          <div class="meta">
            <span class="pill \${stateClass}">\${escapeHtml(project.status || "unknown")}</span>
            \${project.reason ? \`<span>\${escapeHtml(project.reason)}</span>\` : ""}
            \${project.repo ? \`<span>\${escapeHtml(project.repo)}</span>\` : ""}
            \${project.tokenEnvName ? \`<span>token env \${escapeHtml(project.tokenEnvName)}</span>\` : ""}
            \${secret ? \`<span>\${escapeHtml(secret)}</span>\` : ""}
            \${project.error ? \`<span>\${escapeHtml(project.error)}</span>\` : ""}
          </div>
        </div>
      \`;
    }

    function agentGitServiceProvisioningPlanApplyProjects() {
      return agentGitServiceProvisioningPlanProjectsInput.value.split(",").map((item) => item.trim()).filter(Boolean);
    }

    function formatTenantEscalation(escalation) {
      if (escalation.error) return \`escalation error: \${escalation.error}\`;
      const tools = Array.isArray(escalation.requestedTools) && escalation.requestedTools.length
        ? escalation.requestedTools.join(", ")
        : "no tools";
      const limits = escalation.limits || {};
      const limitParts = [
        limits.maxActiveRuns ? \`runs \${limits.maxActiveRuns}\` : "",
        limits.maxWorkspaceSessions ? \`sessions \${limits.maxWorkspaceSessions}\` : "",
        limits.maxWorkspaceBytes ? \`workspace bytes \${limits.maxWorkspaceBytes}\` : "",
        limits.workspaceByteWarning ? \`workspace bytes warn \${limits.workspaceByteWarning}\` : "",
        limits.modelProjectTotalTokenWarning ? \`project tokens warn \${limits.modelProjectTotalTokenWarning}\` : "",
        limits.modelRequesterTotalTokenWarning ? \`requester tokens warn \${limits.modelRequesterTotalTokenWarning}\` : "",
        limits.modelProjectTotalTokenLimit ? \`project tokens limit \${limits.modelProjectTotalTokenLimit}\` : "",
        limits.modelRequesterTotalTokenLimit ? \`requester tokens limit \${limits.modelRequesterTotalTokenLimit}\` : "",
        limits.modelProjectCostUsdWarning ? \`project cost warn \${formatModelCostUsd(limits.modelProjectCostUsdWarning)}\` : "",
        limits.modelRequesterCostUsdWarning ? \`requester cost warn \${formatModelCostUsd(limits.modelRequesterCostUsdWarning)}\` : "",
        limits.modelProjectCostUsdLimit ? \`project cost limit \${formatModelCostUsd(limits.modelProjectCostUsdLimit)}\` : "",
        limits.modelRequesterCostUsdLimit ? \`requester cost limit \${formatModelCostUsd(limits.modelRequesterCostUsdLimit)}\` : ""
      ].filter(Boolean).join(", ") || "no limits";
      const source = formatEscalationSource(escalation.source);
      const policyChange = formatEscalationPolicyChange(escalation.policyChange);
      return \`\${escalation.status || "unknown"} \${escalation.id || "unknown"}: \${tools}; \${limitParts}\${source ? "; " + source : ""}\${policyChange ? "; " + policyChange : ""}\`;
    }

    function formatEscalationSource(source) {
      if (!source) return "";
      const parts = [
        source.kind ? \`source \${source.kind}\` : "",
        source.project ? \`project \${source.project}\` : "",
        source.runId ? \`run \${source.runId}\` : "",
        source.detail || ""
      ].filter(Boolean);
      return parts.join(" ");
    }

    function formatEscalationPolicyChange(policyChange) {
      return formatPolicyChange(policyChange);
    }

    function formatPolicyChange(policyChange) {
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

    function renderHarnessStatus() {
      const status = state.harnessStatus;
      if (!status) {
        renderHarnessStatusError("No status loaded.");
        return;
      }
      const limits = status.limits || {};
      const resources = status.resources || {};
      const tenantResources = currentTenantResources(status);
      const tenantQueuedRuns = currentTenantQueuedRuns(status);
      const tenantOrphanedRuns = currentTenantOrphanedRunningRuns(status);
      const tenantActiveSessions = currentTenantActiveWorkspaceSessionDetails(status);
      const queueRecovery = resources.queueRecovery || {};
      const staleRunCleanup = resources.staleRunCleanup || {};
      const auditEvents = Array.isArray(state.auditEvents) ? state.auditEvents : [];
      const tenantEscalations = Array.isArray(state.tenantEscalations) ? state.tenantEscalations : [];
      const tenantRecoveryErrors = currentTenantQueueRecoveryErrors(status);
      const tenantQueueLabel = (tenantResources.queuedRuns || 0) > 0 ? "tenant queue backlog" : "tenant queue idle";
      const globalStatus = !status.tenant;
      const readiness = status.readiness || state.globalReadiness;
      const readinessLabel = status.readiness ? "tenant profile readiness" : "global profile readiness";
      const visionLock = status.visionLock || state.globalVisionLock;
      const controlPlane = status.server && status.server.controlPlane;
      const policy = status.policy || {};
      harnessStatus.innerHTML = renderAccessSummary() + \`
        <div class="summary-grid">
          \${globalStatus ? \`<span>\${escapeHtml(resources.activeRuns || 0)} active runs</span>\` : '<span>tenant-scoped status</span>'}
          \${globalStatus ? \`<span>\${escapeHtml(resources.queuedRuns || 0)} queued runs</span>\` : ""}
          <span>tenant \${escapeHtml(tenantResources.tenant)}: \${escapeHtml(tenantResources.activeRuns || 0)} active / \${escapeHtml(tenantResources.queuedRuns || 0)} queued / \${escapeHtml(tenantResources.activeWorkspaceSessions || 0)} sessions</span>
          <span class="pill \${(tenantResources.queuedRuns || 0) > 0 ? "queued" : "passed"}">\${tenantQueueLabel}</span>
          <span>\${escapeHtml(globalStatus ? resources.activeWorkspaceSessions || 0 : tenantResources.activeWorkspaceSessions || 0)} / \${escapeHtml(limits.maxWorkspaceSessions || 0)} sessions</span>
          <span>tenant cap \${escapeHtml(limits.maxTenantWorkspaceSessions || 0)} sessions</span>
          <span>tenant run cap \${escapeHtml(limits.maxTenantActiveRuns ?? "none")}</span>
          \${globalStatus ? \`<span>\${escapeHtml(formatQueueRecovery(queueRecovery))}</span>\` : ""}
          \${globalStatus ? \`<span>\${escapeHtml(formatStaleRunCleanup(staleRunCleanup))}</span>\` : ""}
          <span>run lease \${escapeHtml(formatMs(limits.runLeaseTtlMs || 0))}</span>
          <span>command \${escapeHtml(formatMs(limits.workspaceCommandTimeoutMs || 0))}</span>
          <span>idle \${escapeHtml(formatMs(limits.workspaceSessionIdleTimeoutMs || 0))}</span>
          <span>output \${escapeHtml(formatBytes(limits.workspaceOutputBytes || 0))}</span>
          <span>input \${escapeHtml(formatBytes(limits.workspaceSessionInputBytes || 0))}</span>
          \${globalStatus ? \`<span>\${escapeHtml((policy.allowedTools || []).join(", ") || "no tools")}</span>\` : ""}
          \${controlPlane ? \`<span>\${escapeHtml(formatControlPlane(controlPlane))}</span>\` : ""}
          \${readiness ? renderProfileReadiness(readiness, readinessLabel) : ""}
          \${readiness ? renderProfileGoldenPath(readiness) : ""}
          \${visionLock ? \`<span>\${escapeHtml(formatVisionLock(visionLock))}</span>\` : ""}
          <span>\${escapeHtml(formatTenantPolicy(state.tenantPolicy))}</span>
          \${tenantEscalations.length ? tenantEscalations.slice(-8).map((escalation) => \`<span>escalation \${escapeHtml(formatTenantEscalation(escalation))}</span>\`).join("") : '<span>tenant escalations not loaded</span>'}
          \${auditEvents.length ? auditEvents.slice(-8).map((event) => \`<span>audit \${escapeHtml(formatTenantAuditEvent(event))}</span>\`).join("") : '<span>tenant audit not loaded</span>'}
          \${tenantRecoveryErrors.map((error) => \`<span>failed recovery \${escapeHtml(error.project || "unknown")}/\${escapeHtml(error.runId || "unknown")}: \${escapeHtml(error.message || "unknown error")}</span>\`).join("")}
          \${tenantActiveSessions.map((session) => \`<span>active session \${escapeHtml(formatStatusWorkspaceSession(session))}</span>\`).join("")}
          \${tenantOrphanedRuns.map((run) => \`<span>orphaned running \${escapeHtml(formatOrphanedRunningRun(run))} \${run.stale ? \`<button class="secondary" type="button" data-action="abandon-stale" data-project="\${escapeAttr(run.project)}" data-run-id="\${escapeAttr(run.runId)}">Abandon stale</button>\` : ""}</span>\`).join("")}
          \${tenantQueuedRuns.map((run) => \`<span>queued \${escapeHtml(run.project)}/\${escapeHtml(run.runId)}: \${escapeHtml(formatQueuedRunBlocker(run))}</span>\`).join("")}
        </div>
      \`;
    }

    function renderHarnessStatusError(message) {
      harnessStatus.innerHTML = renderAccessSummary() + \`<div class="empty">\${escapeHtml(message)}</div>\`;
    }

    function renderAccessSummary() {
      const access = state.tenantAccess || {};
      return \`
        <div class="summary-grid">
          <span>access \${escapeHtml(access.actor || "unknown")}:\${escapeHtml(access.role || "unknown")}</span>
        </div>
      \`;
    }

    function renderProjects() {
      if (!state.projects.length) {
        projectList.innerHTML = '<div class="empty">No projects for this tenant.</div>';
        projectConcurrencyBoard.innerHTML = '<div class="empty">No project concurrency pressure.</div>';
        return;
      }
      projectList.innerHTML = state.projects.map((project) => \`
        <article class="project-item" aria-selected="\${project.project === projectInput.value.trim()}">
          <button class="project-select run-title" type="button" data-project="\${escapeAttr(project.project)}">\${escapeHtml(project.project)}</button>
          <span class="meta">
            \${project.template ? \`<span class="pill">\${escapeHtml(project.template)}</span>\` : ""}
            \${project.repo ? \`<span>\${escapeHtml(project.repo)}</span>\` : ""}
            \${project.branch ? \`<span>branch \${escapeHtml(project.branch)}</span>\` : ""}
            \${project.baseBranch ? \`<span>base \${escapeHtml(project.baseBranch)}</span>\` : ""}
            \${project.issue ? \`<span class="pill">\${escapeHtml(project.issue)}</span>\` : ""}
            \${Array.isArray(project.defaultSkills) ? \`<span>skills \${escapeHtml(project.defaultSkills.join(", ") || "none")}</span>\` : ""}
            \${project.runPolicy && project.runPolicy.preset ? \`<span>policy \${escapeHtml(project.runPolicy.preset)}</span>\` : ""}
            \${project.runPolicy && project.runPolicy.presetInput && project.runPolicy.presetInput.caseId ? \`<span>case \${escapeHtml(project.runPolicy.presetInput.caseId)}</span>\` : ""}
            \${project.runPolicy && project.runPolicy.reviewRequired ? '<span class="pill review_required">default review</span>' : ""}
            \${project.runPolicy && project.runPolicy.deploymentRequired ? '<span class="pill deployment_required">default deploy</span>' : ""}
            \${project.contract && project.contract.objective ? \`<span>contract \${escapeHtml(project.contract.objective)}</span>\` : ""}
            \${project.contract && Array.isArray(project.contract.constraints) ? \`<span>\${escapeHtml(project.contract.constraints.length)} constraints</span>\` : ""}
	            \${project.contract && Array.isArray(project.contract.successCriteria) ? \`<span>\${escapeHtml(project.contract.successCriteria.length)} success criteria</span>\` : ""}
	            \${renderProjectContractStatus(project)}
	            \${renderProjectControlPlane(project)}
	            \${renderProjectAgentGitServicePlanAction(project)}
	            \${renderProjectConcurrency(project)}
	            \${project.latestStatus ? \`<span class="pill \${escapeAttr(project.latestStatus)}">\${escapeHtml(project.latestStatus)}</span>\` : ""}
            <span>\${escapeHtml(project.runCount)} runs</span>
            \${project.modelUsage ? \`<span>model \${escapeHtml(formatProjectModelUsage(project.modelUsage))}</span>\` : ""}
            \${project.workspaceBytes !== undefined ? \`<span>workspace \${escapeHtml(formatProjectWorkspaceUsage(project))}</span>\` : ""}
            \${project.activityAt ? \`<span>active \${escapeHtml(project.activityAt)}</span>\` : ""}
            \${project.activeWorkspaceSessions > 0 ? \`<span class="pill running">\${escapeHtml(project.activeWorkspaceSessions)} sessions online</span>\` : ""}
            \${project.activeProjectCollaboratorCount > 0 ? \`<span class="pill running">\${escapeHtml(project.activeProjectCollaboratorCount)} collaborators online</span>\` : ""}
            \${project.activeRunCollaboratorCount > 0 ? \`<span class="pill running">\${escapeHtml(project.activeRunCollaboratorCount)} run collaborators online</span>\` : ""}
            \${project.vasCaseCount !== undefined ? \`<span>\${escapeHtml(project.vasCaseCount)} VAS cases</span>\` : ""}
            \${project.vasNeedsReviewCaseCount > 0 ? \`<span class="pill queued">\${escapeHtml(project.vasNeedsReviewCaseCount)} VAS case review</span>\` : ""}
            \${project.vasUnreviewedRunCount > 0 ? \`<span class="pill queued">\${escapeHtml(project.vasUnreviewedRunCount)} VAS unreviewed run</span>\` : ""}
            \${project.vasReviewedRunCount > 0 ? \`<span>\${escapeHtml(project.vasReviewedRunCount)} VAS reviewed runs</span>\` : ""}
            \${project.queuedRunCount > 0 ? \`<span class="pill queued">\${escapeHtml(project.queuedRunCount)} queued</span>\` : ""}
            \${Array.isArray(project.queuedRunIds) && project.queuedRunIds.length ? \`<span>queued \${escapeHtml(project.queuedRunIds.join(", "))}</span>\` : ""}
            \${project.reviewRequiredRunCount > 0 ? \`<span class="pill review_required">\${escapeHtml(project.reviewRequiredRunCount)} review</span>\` : ""}
            \${project.deploymentRequiredRunCount > 0 ? \`<span class="pill deployment_required">\${escapeHtml(project.deploymentRequiredRunCount)} deploy</span>\` : ""}
            \${project.runningRunId ? \`<span>running \${escapeHtml(project.runningRunId)}</span>\` : ""}
          </span>
          \${renderProjectCollaborators(project)}
          \${renderProjectRunCollaborators(project)}
          \${renderProjectModelUsageByRequester(project)}
          \${renderProjectModelUsageWarnings(project)}
          \${renderProjectWorkspaceByteWarnings(project)}
          \${renderProjectActiveWorkspaceSessions(project)}
          \${renderProjectLatestWorkspaceCommand(project)}
          \${renderProjectLatestWorkspaceSession(project)}
          \${renderProjectLatestWorkspaceActivity(project)}
          \${renderProjectWorkspaceConflicts(project)}
          \${renderProjectLatestControlActivity(project)}
          \${renderProjectHumanGateRuns(project)}
          \${renderProjectQueuedRuns(project)}
        </article>
      \`).join("");
      renderProjectConcurrencyBoard();
      bindProjectActionButtons(projectList);
      bindProjectActionButtons(projectConcurrencyBoard);
    }

    function renderProjectConcurrencyBoard() {
      const projects = projectConcurrencyBoardProjects();
      if (!projects.length) {
        projectConcurrencyBoard.innerHTML = '<div class="empty">No project concurrency pressure.</div>';
        return;
      }
      projectConcurrencyBoard.innerHTML = \`
        <div class="summary">
          <h3>Project Concurrency</h3>
          <div class="meta">
            <span class="pill \${projects.some((project) => project.concurrency && project.concurrency.state === "contended") ? "failed" : "queued"}">\${escapeHtml(projects.length)} active</span>
            <span>\${escapeHtml(projects.filter((project) => project.concurrency && project.concurrency.state === "contended").length)} contended</span>
            <span>\${escapeHtml(projects.filter((project) => project.concurrency && project.concurrency.state === "queued").length)} queued</span>
            <span>\${escapeHtml(projects.filter((project) => project.concurrency && project.concurrency.state === "active").length)} active work</span>
          </div>
        </div>
        \${projects.map(renderProjectConcurrencyBoardProject).join("")}
      \`;
    }

    function projectConcurrencyBoardProjects() {
      return state.projects
        .filter((project) => project && project.concurrency && project.concurrency.state)
        .sort((a, b) => projectConcurrencyRank(a) - projectConcurrencyRank(b) || String(a.project).localeCompare(String(b.project)));
    }

    function projectConcurrencyRank(project) {
      const state = project.concurrency && project.concurrency.state;
      if (state === "contended") return 0;
      if (state === "queued") return 1;
      return 2;
    }

    function renderProjectConcurrencyBoardProject(project) {
      const concurrency = project.concurrency || {};
      const stateClass = concurrency.state === "contended" ? "failed" : concurrency.state === "queued" ? "queued" : "running";
      return \`
        <article class="project-item" aria-selected="\${project.project === projectInput.value.trim()}">
          <button class="project-select run-title" type="button" data-project-concurrency-project="\${escapeAttr(project.project)}">\${escapeHtml(project.project)}</button>
          <span class="meta">
            <span class="pill \${stateClass}">\${escapeHtml(concurrency.state || "active")}</span>
            \${renderProjectConcurrency(project)}
            \${project.runningRunId ? \`<span>running \${escapeHtml(project.runningRunId)}</span>\` : ""}
            \${project.queuedRunCount > 0 ? \`<span>\${escapeHtml(project.queuedRunCount)} queued</span>\` : ""}
            \${project.activeWorkspaceSessions > 0 ? \`<span>\${escapeHtml(project.activeWorkspaceSessions)} sessions</span>\` : ""}
            \${project.workspaceConflictCount > 0 ? \`<span>\${escapeHtml(formatProjectWorkspaceConflict(project))}</span>\` : ""}
          </span>
          \${renderProjectConcurrencyActiveRuns(concurrency)}
          \${renderProjectRunSlotEscalation(project)}
          \${renderProjectActiveWorkspaceSessions(project)}
          \${renderProjectRunCollaborators(project)}
          \${renderProjectWorkspaceConflicts(project)}
          \${renderProjectQueuedRuns(project)}
        </article>
      \`;
    }

    function renderProjectConcurrencyActiveRuns(concurrency) {
      const runs = Array.isArray(concurrency.activeRunDetails) ? concurrency.activeRunDetails : [];
      if (!runs.length) return "";
      return \`
        <span class="project-queued-run">
          \${runs.map((run) => \`
            <span>active run \${escapeHtml(run.runId || "unknown")} lease \${escapeHtml(run.workspaceLeaseScope || "project")} \${escapeHtml(run.workspaceLeaseKey || "unknown")}</span>
            <button class="secondary" type="button" data-project-active-run-project="\${escapeAttr(run.project || "")}" data-project-active-run-id="\${escapeAttr(run.runId || "")}">Open</button>
            <button class="secondary" type="button" data-project-active-run-pause-project="\${escapeAttr(run.project || "")}" data-project-active-run-pause-id="\${escapeAttr(run.runId || "")}" \${state.tenantAccess ? "" : "disabled"}>Pause</button>
            <button class="danger" type="button" data-project-active-run-cancel-project="\${escapeAttr(run.project || "")}" data-project-active-run-cancel-id="\${escapeAttr(run.runId || "")}" \${canMutate() ? "" : "disabled"}>Cancel</button>
          \`).join("")}
        </span>
      \`;
    }

    function renderProjectRunSlotEscalation(project) {
      const pressure = projectRunSlotPressure(project);
      if (!pressure) return "";
      return \`
        <span class="project-queued-run">
          <button class="secondary" type="button" data-project-run-slot-escalate="\${escapeAttr(project.project)}" \${state.tenantAccess ? "" : "disabled"}>Request run slots</button>
          <span>\${escapeHtml(pressure.detail)}</span>
        </span>
      \`;
    }

    function renderProjectAgentGitServicePlanAction(project) {
      if (!projectNeedsAgentGitServicePlan(project)) return "";
      return \`<button class="secondary" type="button" data-project-agent-git-service-plan="\${escapeAttr(project.project)}" \${canAdmin() ? "" : "disabled"}>Stage AGS plan</button>\`;
    }

    function projectNeedsAgentGitServicePlan(project) {
      const controlPlane = project && project.controlPlane;
      if (!controlPlane || controlPlane.provider !== "agent-git-service") return false;
      const agent = controlPlane.agentGitServiceProjectAgent;
      if (!agent || agent.ready || agent.secretRootConfigured === false) return false;
      return Boolean(agent.receiptPresent || agent.repo || project.repo);
    }

    function prefillAgentGitServiceProvisioningPlanProject(projectName) {
      const project = state.projects.find((entry) => entry.project === projectName);
      if (!projectNeedsAgentGitServicePlan(project)) return;
      agentGitServiceProvisioningPlanProjectsInput.value = projectName;
      agentGitServiceProvisioningPlanEligibleOnlyInput.checked = true;
      connection.textContent = "AGS provisioning plan prefilled";
    }

    function projectRunSlotPressure(project) {
      const runs = projectQueuedRuns(project);
      const tenantCapRun = runs.find((run) => run.blockedReason === "tenant_active_run_limit");
      if (tenantCapRun) return { run: tenantCapRun, runs, detail: formatQueuedRunBlocker(tenantCapRun) };
      const queuedCount = Math.max(project.queuedRunCount || 0, runs.length);
      const hasOtherBlocker = runs.some((run) => run.blockedReason && run.blockedReason !== "tenant_active_run_limit");
      if (queuedCount > 0 && !hasOtherBlocker && project.concurrency && project.concurrency.state === "queued") {
        return { run: null, runs, detail: \`\${queuedCount} queued\` };
      }
      return null;
    }

    function prefillRunSlotEscalation(projectName) {
      const project = state.projects.find((entry) => entry.project === projectName);
      if (!project) return;
      const pressure = projectRunSlotPressure(project);
      if (!pressure) return;
      const currentLimit = currentMaxActiveRunsLimit(pressure.runs);
      const nextLimit = suggestedPolicyLimit(projectRunSlotPressureActual(project, pressure.runs), currentLimit);
      escalationToolsInput.value = "";
      resetEscalationLimitInputs();
      escalationMaxActiveRunsInput.value = String(nextLimit);
      const source = {
        kind: "run_slot_pressure",
        project: project.project,
        detail: pressure.detail
      };
      if (pressure.run && pressure.run.runId) source.runId = pressure.run.runId;
      state.pendingEscalationSource = source;
      escalationReasonInput.value = \`project \${project.project} has queued run-slot pressure (\${pressure.detail}); request a higher active run cap\`;
      connection.textContent = "run slot escalation prefilled";
    }

    function currentMaxActiveRunsLimit(runs) {
      const policyLimits = state.tenantPolicy && state.tenantPolicy.limits ? state.tenantPolicy.limits : {};
      const policyLimit = Number(policyLimits.maxActiveRuns || 0);
      if (Number.isFinite(policyLimit) && policyLimit > 0) return policyLimit;
      for (const run of runs) {
        const runLimit = Number(run.limit || 0);
        if (Number.isFinite(runLimit) && runLimit > 0) return runLimit;
      }
      return 0;
    }

    function projectRunSlotPressureActual(project, runs) {
      const queuedCount = Math.max(project.queuedRunCount || 0, runs.length);
      const activeRunDetails = project.concurrency && Array.isArray(project.concurrency.activeRunDetails)
        ? project.concurrency.activeRunDetails.length
        : 0;
      const activeCount = Math.max(project.activeRunCount || 0, activeRunDetails, project.runningRunId ? 1 : 0);
      return activeCount + queuedCount;
    }

    function bindProjectActionButtons(root) {
      for (const item of root.querySelectorAll("[data-project]")) {
        item.addEventListener("click", () => selectProject(item.dataset.project));
      }
      for (const item of root.querySelectorAll("[data-project-concurrency-project]")) {
        item.addEventListener("click", () => selectProject(item.dataset.projectConcurrencyProject));
      }
      for (const item of root.querySelectorAll("[data-project-queued-run-id]")) {
        item.addEventListener("click", () => openProjectQueuedRun(item.dataset.projectQueuedRunProject, item.dataset.projectQueuedRunId));
      }
      for (const item of root.querySelectorAll("[data-project-gate-run-id]")) {
        item.addEventListener("click", () => openProjectGateRun(item.dataset.projectGateRunProject, item.dataset.projectGateRunId));
      }
      for (const item of root.querySelectorAll("[data-project-active-run-id]")) {
        item.addEventListener("click", () => openProjectActiveRun(item.dataset.projectActiveRunProject, item.dataset.projectActiveRunId));
      }
      for (const item of root.querySelectorAll("[data-project-active-run-pause-id]")) {
        item.addEventListener("click", () => pauseProjectActiveRun(item.dataset.projectActiveRunPauseProject, item.dataset.projectActiveRunPauseId));
      }
      for (const item of root.querySelectorAll("[data-project-active-run-cancel-id]")) {
        item.addEventListener("click", () => cancelProjectActiveRun(item.dataset.projectActiveRunCancelProject, item.dataset.projectActiveRunCancelId));
      }
      for (const item of root.querySelectorAll("[data-project-run-slot-escalate]")) {
        item.addEventListener("click", () => prefillRunSlotEscalation(item.dataset.projectRunSlotEscalate));
      }
      for (const item of root.querySelectorAll("[data-project-agent-git-service-plan]")) {
        item.addEventListener("click", () => prefillAgentGitServiceProvisioningPlanProject(item.dataset.projectAgentGitServicePlan));
      }
      for (const item of root.querySelectorAll("[data-project-active-run-collaborator-run-id]")) {
        item.addEventListener("click", () => openProjectRunCollaborator(item.dataset.projectActiveRunCollaboratorProject, item.dataset.projectActiveRunCollaboratorRunId));
      }
      for (const item of root.querySelectorAll("[data-project-active-session-id]")) {
        item.addEventListener("click", () => openProjectActiveWorkspaceSession(item.dataset.projectActiveSessionProject, item.dataset.projectActiveSessionId, item.dataset.projectActiveSessionRunId));
      }
      for (const item of root.querySelectorAll("[data-project-latest-command-id]")) {
        item.addEventListener("click", () => openProjectLatestWorkspaceCommand(item.dataset.projectLatestCommandProject, item.dataset.projectLatestCommandId, item.dataset.projectLatestCommandRunId));
      }
      for (const item of root.querySelectorAll("[data-project-latest-session-id]")) {
        item.addEventListener("click", () => openProjectLatestWorkspaceSession(item.dataset.projectLatestSessionProject, item.dataset.projectLatestSessionId, item.dataset.projectLatestSessionRunId));
      }
      for (const item of root.querySelectorAll("[data-project-latest-activity-path]")) {
        item.addEventListener("click", () => openProjectLatestWorkspaceActivity(item.dataset.projectLatestActivityProject, item.dataset.projectLatestActivityPath, item.dataset.projectLatestActivityDeleted));
      }
      for (const item of root.querySelectorAll("[data-project-queued-cancel-id]")) {
        item.addEventListener("click", () => cancelProjectQueuedRun(item.dataset.projectQueuedCancelProject, item.dataset.projectQueuedCancelId));
      }
    }

    function renderModelUsageWarnings() {
      if (!state.modelUsageWarningProjects.length) {
        modelUsageWarningsList.innerHTML = '<div class="empty">No model usage warnings.</div>';
        return;
      }
      modelUsageWarningsList.innerHTML = state.modelUsageWarningProjects.map((project) => \`
        <div class="project-item">
          <button class="project-select run-title" type="button" data-model-warning-project="\${escapeAttr(project.project)}">\${escapeHtml(project.project)}</button>
          <span class="meta">
            \${project.latestStatus ? \`<span class="pill \${escapeAttr(project.latestStatus)}">\${escapeHtml(project.latestStatus)}</span>\` : ""}
            \${project.modelUsage ? \`<span>model \${escapeHtml(formatProjectModelUsage(project.modelUsage))}</span>\` : ""}
            \${project.activityAt ? \`<span>active \${escapeHtml(project.activityAt)}</span>\` : ""}
          </span>
          \${renderProjectModelUsageByRequester(project)}
          \${renderProjectModelUsageWarnings(project)}
          <span class="project-queued-run">
            <button class="secondary" type="button" data-model-warning-escalate="\${escapeAttr(project.project)}">Request model budget</button>
          </span>
        </div>
      \`).join("");
      for (const item of modelUsageWarningsList.querySelectorAll("[data-model-warning-project]")) {
        item.addEventListener("click", () => selectProject(item.dataset.modelWarningProject));
      }
      for (const item of modelUsageWarningsList.querySelectorAll("[data-model-warning-escalate]")) {
        item.addEventListener("click", () => prefillModelBudgetEscalation(item.dataset.modelWarningEscalate));
      }
    }

    function renderWorkspaceUsageWarnings() {
      if (!state.workspaceUsageWarningProjects.length) {
        workspaceUsageWarningsList.innerHTML = '<div class="empty">No workspace usage warnings.</div>';
        return;
      }
      workspaceUsageWarningsList.innerHTML = state.workspaceUsageWarningProjects.map((project) => \`
        <div class="project-item">
          <button class="project-select run-title" type="button" data-workspace-warning-project="\${escapeAttr(project.project)}">\${escapeHtml(project.project)}</button>
          <span class="meta">
            \${project.latestStatus ? \`<span class="pill \${escapeAttr(project.latestStatus)}">\${escapeHtml(project.latestStatus)}</span>\` : ""}
            \${project.workspaceBytes !== undefined ? \`<span>workspace \${escapeHtml(formatProjectWorkspaceUsage(project))}</span>\` : ""}
            \${project.activityAt ? \`<span>active \${escapeHtml(project.activityAt)}</span>\` : ""}
          </span>
          \${renderProjectWorkspaceByteWarnings(project)}
          <span class="project-queued-run">
            <button class="secondary" type="button" data-workspace-warning-escalate="\${escapeAttr(project.project)}">Request workspace quota</button>
          </span>
        </div>
      \`).join("");
      for (const item of workspaceUsageWarningsList.querySelectorAll("[data-workspace-warning-project]")) {
        item.addEventListener("click", () => selectProject(item.dataset.workspaceWarningProject));
      }
      for (const item of workspaceUsageWarningsList.querySelectorAll("[data-workspace-warning-escalate]")) {
        item.addEventListener("click", () => prefillWorkspaceQuotaEscalation(item.dataset.workspaceWarningEscalate));
      }
    }

    function projectQueuedRuns(project) {
      const ids = Array.isArray(project.queuedRunIds) ? project.queuedRunIds : [];
      const inlineDetails = Array.isArray(project.queuedRuns) ? project.queuedRuns : [];
      const details = inlineDetails.concat(currentTenantQueuedRuns(state.harnessStatus || {}).filter((run) => run.project === project.project));
      const byId = new Map(details.map((run) => [run.runId, run]));
      const runs = ids.map((runId) => byId.get(runId) || { tenant: tenant(), project: project.project, runId });
      for (const detail of details) {
        if (!ids.includes(detail.runId)) runs.push(detail);
      }
      return runs;
    }

    function projectHumanGateRuns(project) {
      const runs = [];
      const seen = new Set();
      const addRun = (run, kind, label) => {
        const runId = typeof run === "string" ? run : run && run.runId;
        if (!runId || seen.has(\`\${kind}:\${runId}\`)) return;
        seen.add(\`\${kind}:\${runId}\`);
        runs.push({ ...(typeof run === "object" && run ? run : {}), project: project.project, runId, kind, label });
      };
      const addRuns = (details, ids, kind, label) => {
        if (Array.isArray(details)) {
          for (const run of details) addRun(run, kind, label);
        }
        if (!Array.isArray(ids)) return;
        for (const runId of ids) addRun(runId, kind, label);
      };
      addRuns(project.reviewRequiredRuns, project.reviewRequiredRunIds, "review_required", "review");
      addRuns(project.deploymentRequiredRuns, project.deploymentRequiredRunIds, "deployment_required", "deploy");
      return runs;
    }

    function renderProjectCollaborators(project) {
      const collaborators = Array.isArray(project.activeProjectCollaborators) ? project.activeProjectCollaborators : [];
      if (!collaborators.length) return "";
      return \`
        <span class="meta">
          \${collaborators.map((entry) => \`<span class="pill running">\${escapeHtml(formatProjectCollaborator(entry))}</span>\`).join("")}
        </span>
      \`;
    }

    function formatProjectCollaborator(entry) {
      const owner = entry.label || entry.actor || entry.clientId || "unknown";
      return entry.focus ? \`\${owner}: \${entry.focus}\` : owner;
    }

    function renderProjectRunCollaborators(project) {
      const collaborators = Array.isArray(project.activeRunCollaborators) ? project.activeRunCollaborators : [];
      if (!collaborators.length) return "";
      return collaborators.map((entry) => {
        const runProject = entry.project || project.project;
        const runId = entry.runId || "";
        return \`
          <div class="project-queued-run">
            <span class="pill running">collaborator</span>
            <span>\${escapeHtml(formatProjectRunCollaborator(entry))}</span>
            \${runId ? \`<button class="secondary" type="button" data-project-active-run-collaborator-project="\${escapeAttr(runProject)}" data-project-active-run-collaborator-run-id="\${escapeAttr(runId)}">Open</button>\` : ""}
          </div>
        \`;
      }).join("");
    }

    function formatProjectRunCollaborator(entry) {
      const owner = entry.label || entry.actor || entry.clientId || "unknown";
      const run = entry.runId ? \`run \${entry.runId}\` : "run";
      return entry.focus ? \`\${run} \${owner}: \${entry.focus}\` : \`\${run} \${owner}\`;
    }

    function renderProjectModelUsageByRequester(project) {
      const entries = Array.isArray(project.modelUsageByRequester) ? project.modelUsageByRequester : [];
      if (!entries.length) return "";
      return \`
        <span class="meta">
          \${entries.slice(0, 3).map((entry) => \`<span>model by \${escapeHtml(formatRunRequester(entry.requester))} \${escapeHtml(formatProjectModelUsage(entry))}</span>\`).join("")}
        </span>
      \`;
    }

    function formatProjectModelUsage(data) {
      return [
        data.runCount !== undefined ? data.runCount + (data.runCount === 1 ? " run" : " runs") : "",
        formatModelUsage(data)
      ].filter(Boolean).join(" ");
    }

    function renderProjectModelUsageWarnings(project) {
      const warnings = Array.isArray(project.modelUsageWarnings) ? project.modelUsageWarnings : [];
      if (!warnings.length) return "";
      return \`
        <span class="meta">
          \${warnings.map((warning) => \`<span class="pill queued">model usage warning \${escapeHtml(formatProjectModelUsageWarning(warning))}</span>\`).join("")}
        </span>
      \`;
    }

    function formatProjectModelUsageWarning(warning) {
      const owner = warning.requester ? " by " + formatRunRequester(warning.requester) : "";
      if (warning.kind === "project_cost_usd" || warning.kind === "requester_cost_usd") {
        const kind = warning.kind === "requester_cost_usd" ? "requester cost" : "project cost";
        return \`\${kind}\${owner} \${formatModelCostUsd(warning.actual)} > \${formatModelCostUsd(warning.threshold)}\`;
      }
      const kind = warning.kind === "requester_total_tokens" ? "requester total" : "project total";
      return \`\${kind}\${owner} \${warning.actual} > \${warning.threshold}\`;
    }

    function prefillModelBudgetEscalation(projectName) {
      const project = state.modelUsageWarningProjects.find((entry) => entry.project === projectName)
        || state.projects.find((entry) => entry.project === projectName);
      if (!project) return;
      const warnings = Array.isArray(project.modelUsageWarnings) ? project.modelUsageWarnings : [];
      const policyLimits = state.tenantPolicy && state.tenantPolicy.limits ? state.tenantPolicy.limits : {};
      const projectActual = Math.max(
        project.modelUsage && project.modelUsage.totalTokens ? project.modelUsage.totalTokens : 0,
        ...warnings.filter((warning) => warning.kind === "project_total_tokens").map((warning) => warning.actual || 0)
      );
      const requesterActual = Math.max(
        0,
        ...warnings.filter((warning) => warning.kind === "requester_total_tokens").map((warning) => warning.actual || 0)
      );
      const projectCostActual = Math.max(
        project.modelUsage && project.modelUsage.costUsd ? project.modelUsage.costUsd : 0,
        ...warnings.filter((warning) => warning.kind === "project_cost_usd").map((warning) => warning.actual || 0)
      );
      const requesterCostActual = Math.max(
        0,
        ...warnings.filter((warning) => warning.kind === "requester_cost_usd").map((warning) => warning.actual || 0)
      );
      resetEscalationLimitInputs();
      escalationToolsInput.value = "";
      if (projectActual > 0 || warnings.some((warning) => warning.kind === "project_total_tokens")) {
        const nextLimit = suggestedPolicyLimit(projectActual, policyLimits.modelProjectTotalTokenLimit || 0);
        escalationModelProjectTokenLimitInput.value = String(nextLimit);
        escalationModelProjectTokenWarningInput.value = String(suggestedWarningThreshold(nextLimit));
      }
      if (requesterActual > 0 || warnings.some((warning) => warning.kind === "requester_total_tokens")) {
        const nextLimit = suggestedPolicyLimit(requesterActual, policyLimits.modelRequesterTotalTokenLimit || 0);
        escalationModelRequesterTokenLimitInput.value = String(nextLimit);
        escalationModelRequesterTokenWarningInput.value = String(suggestedWarningThreshold(nextLimit));
      }
      if (projectCostActual > 0 || warnings.some((warning) => warning.kind === "project_cost_usd")) {
        const nextLimit = suggestedCostLimit(projectCostActual, policyLimits.modelProjectCostUsdLimit || 0);
        escalationModelProjectCostLimitInput.value = String(nextLimit);
        escalationModelProjectCostWarningInput.value = String(suggestedCostWarningThreshold(nextLimit));
      }
      if (requesterCostActual > 0 || warnings.some((warning) => warning.kind === "requester_cost_usd")) {
        const nextLimit = suggestedCostLimit(requesterCostActual, policyLimits.modelRequesterCostUsdLimit || 0);
        escalationModelRequesterCostLimitInput.value = String(nextLimit);
        escalationModelRequesterCostWarningInput.value = String(suggestedCostWarningThreshold(nextLimit));
      }
      state.pendingEscalationSource = {
        kind: "model_usage_warning",
        project: project.project,
        detail: warnings.map(formatProjectModelUsageWarning).join("; ")
      };
      escalationReasonInput.value = \`model usage for \${project.project} is \${formatProjectModelUsage(project.modelUsage || { runCount: 0, requestCount: 0 })}; request a higher model budget before model-backed runs are blocked\`;
      connection.textContent = "model budget escalation prefilled";
    }

    function formatProjectWorkspaceUsage(project) {
      const parts = [formatBytes(project.workspaceBytes || 0)];
      if (project.workspaceByteLimit !== undefined) parts.push("limit " + formatBytes(project.workspaceByteLimit));
      if (project.workspaceByteWarningThreshold !== undefined) parts.push("warn " + formatBytes(project.workspaceByteWarningThreshold));
      return parts.join(" / ");
    }

    function renderProjectWorkspaceByteWarnings(project) {
      const warnings = Array.isArray(project.workspaceByteWarnings) ? project.workspaceByteWarnings : [];
      if (!warnings.length) return "";
      return \`
        <span class="meta">
          \${warnings.map((warning) => \`<span class="pill queued">workspace usage warning \${escapeHtml(formatProjectWorkspaceByteWarning(warning))}</span>\`).join("")}
        </span>
      \`;
    }

    function formatProjectWorkspaceByteWarning(warning) {
      const kind = warning.kind === "workspace_byte_limit" ? "limit" : "usage";
      return \`\${kind} \${formatBytes(warning.actual)} > \${formatBytes(warning.threshold)}\`;
    }

    function prefillWorkspaceQuotaEscalation(projectName) {
      const project = state.workspaceUsageWarningProjects.find((entry) => entry.project === projectName)
        || state.projects.find((entry) => entry.project === projectName);
      if (!project) return;
      const actual = project.workspaceBytes || Math.max(0, ...((project.workspaceByteWarnings || []).map((warning) => warning.actual || 0)));
      const currentLimit = project.workspaceByteLimit || 0;
      const nextLimit = suggestedPolicyLimit(actual, currentLimit);
      escalationToolsInput.value = "";
      resetEscalationLimitInputs();
      escalationMaxWorkspaceBytesInput.value = String(nextLimit);
      escalationWorkspaceByteWarningInput.value = String(suggestedWarningThreshold(nextLimit));
      state.pendingEscalationSource = {
        kind: "workspace_usage_warning",
        project: project.project,
        detail: (project.workspaceByteWarnings || []).map(formatProjectWorkspaceByteWarning).join("; ")
      };
      escalationReasonInput.value = \`workspace \${project.project} is using \${formatBytes(actual)}; request a higher workspace byte cap before writes, commands, or sessions are blocked\`;
      connection.textContent = "workspace quota escalation prefilled";
    }

    function resetEscalationLimitInputs() {
      escalationMaxWorkspaceSessionsInput.value = "";
      escalationMaxActiveRunsInput.value = "";
      escalationMaxWorkspaceBytesInput.value = "";
      escalationWorkspaceByteWarningInput.value = "";
      escalationModelProjectTokenWarningInput.value = "";
      escalationModelRequesterTokenWarningInput.value = "";
      escalationModelProjectTokenLimitInput.value = "";
      escalationModelRequesterTokenLimitInput.value = "";
      escalationModelProjectCostWarningInput.value = "";
      escalationModelRequesterCostWarningInput.value = "";
      escalationModelProjectCostLimitInput.value = "";
      escalationModelRequesterCostLimitInput.value = "";
    }

    function suggestedPolicyLimit(actual, currentLimit) {
      const basis = Math.max(actual || 0, currentLimit || 0, 1);
      return Math.max((actual || 0) + 1, currentLimit ? currentLimit * 2 : basis * 2, 1);
    }

    function suggestedWarningThreshold(limit) {
      return limit > 1 ? Math.max(1, Math.min(limit - 1, Math.floor(limit * 0.8))) : 1;
    }

    function suggestedCostLimit(actual, currentLimit) {
      const basis = Math.max(actual || 0, currentLimit || 0, 0.001);
      return roundedCost(Math.max((actual || 0) + 0.001, currentLimit ? currentLimit * 2 : basis * 2));
    }

    function suggestedCostWarningThreshold(limit) {
      return roundedCost(Math.max(0.001, limit * 0.8));
    }

    function roundedCost(value) {
      return Math.round(value * 1_000_000) / 1_000_000;
    }

    function renderProjectActiveWorkspaceSessions(project) {
      const sessions = Array.isArray(project.activeWorkspaceSessionDetails) ? project.activeWorkspaceSessionDetails : [];
      if (!sessions.length) return "";
      return sessions.map((session) => \`
        <div class="project-queued-run">
          <span class="pill running">session</span>
          <span>\${escapeHtml(formatProjectActiveWorkspaceSession(session))}</span>
          <button class="secondary" type="button" data-project-active-session-project="\${escapeAttr(project.project)}" data-project-active-session-id="\${escapeAttr(session.sessionId)}" data-project-active-session-run-id="\${escapeAttr(session.runId || "")}">Open</button>
        </div>
      \`).join("");
    }

    function formatProjectActiveWorkspaceSession(session) {
      const owner = session.actor || session.clientId || "system";
      const route = session.route === "run" && session.runId ? \`run \${session.runId}\` : "project";
      const lifecycle = workspaceSessionLifecycleMeta(session);
      return [\`\${route}: \${session.command || session.sessionId} by \${owner}\`, lifecycle].filter(Boolean).join(" / ");
    }

    function renderProjectLatestWorkspaceCommand(project) {
      const command = project.latestWorkspaceCommand;
      if (!command) return "";
      const statusClass = command.exitCode === 0 ? "passed" : "failed";
      return \`
        <span class="meta">
          <span class="pill \${statusClass}">last cmd</span>
          <span>\${escapeHtml(formatProjectLatestWorkspaceCommand(command))}</span>
          <button class="secondary" type="button" data-project-latest-command-project="\${escapeAttr(project.project)}" data-project-latest-command-id="\${escapeAttr(command.commandId)}" data-project-latest-command-run-id="\${escapeAttr(command.runId || "")}">Open</button>
        </span>
      \`;
    }

    function formatProjectLatestWorkspaceCommand(command) {
      const owner = command.actor || command.clientId || "system";
      const status = typeof command.exitCode === "number" ? \`exit \${command.exitCode}\` : "exited";
      return \`\${command.command || command.commandId}: \${status} by \${owner}\`;
    }

    function renderProjectLatestWorkspaceSession(project) {
      const session = project.latestWorkspaceSession;
      if (!session) return "";
      const statusClass = session.status === "exited" && session.exitCode === 0 ? "passed" : "running";
      return \`
        <span class="meta">
          <span class="pill \${statusClass}">last session</span>
          <span>\${escapeHtml(formatProjectLatestWorkspaceSession(session))}</span>
          <button class="secondary" type="button" data-project-latest-session-project="\${escapeAttr(project.project)}" data-project-latest-session-id="\${escapeAttr(session.sessionId)}" data-project-latest-session-run-id="\${escapeAttr(session.runId || "")}">Open</button>
        </span>
      \`;
    }

    function formatProjectLatestWorkspaceSession(session) {
      const owner = session.actor || session.clientId || "system";
      const status = typeof session.exitCode === "number" ? \`exit \${session.exitCode}\` : session.status || "running";
      const lifecycle = workspaceSessionLifecycleMeta(session);
      return [\`\${session.command || session.sessionId}: \${status} by \${owner}\`, lifecycle].filter(Boolean).join(" / ");
    }

    function renderProjectLatestWorkspaceActivity(project) {
      const activity = project.latestWorkspaceActivity;
      if (!activity) return "";
      const path = activity.path || "";
      const deleted = activity.type === "workspace_file_deleted";
      return \`
        <span class="meta">
          <span class="pill">workspace</span>
          <span>\${escapeHtml(formatProjectLatestWorkspaceActivity(activity))}</span>
          \${path ? \`<button class="secondary" type="button" data-project-latest-activity-project="\${escapeAttr(project.project)}" data-project-latest-activity-path="\${escapeHtml(path)}" data-project-latest-activity-deleted="\${deleted ? "true" : "false"}">Open</button>\` : ""}
        </span>
      \`;
    }

    function formatProjectLatestWorkspaceActivity(activity) {
      const owner = activity.actor || activity.clientId || "system";
      if (activity.type === "workspace_file_moved") {
        return \`moved \${activity.fromPath || "file"} to \${activity.path || "file"} by \${owner}\`;
      }
      if (activity.type === "workspace_file_deleted") {
        return \`deleted \${activity.path || "file"} by \${owner}\`;
      }
      if (activity.type === "workspace_file_written") {
        return \`wrote \${activity.path || "file"} by \${owner}\`;
      }
      if (activity.type === "workspace_file_conflicted") {
        return \`conflict \${activity.operation || "edit"} \${activity.path || "file"} by \${owner}\`;
      }
      if (activity.type === "workspace_commit_created") {
        return \`commit \${activity.commit || activity.message || "checkpoint"} by \${owner}\`;
      }
      if (activity.type === "workspace_pull_request_created") {
        return \`PR \${activity.pullRequestUrl || activity.pullRequestIndex || activity.branch || "handoff"} by \${owner}\`;
      }
      return \`\${activity.type || "workspace"} by \${owner}\`;
    }

    function renderProjectWorkspaceConflicts(project) {
      if (!(project.workspaceConflictCount > 0)) return "";
      return \`
        <span class="meta">
          <span class="pill">conflicts</span>
          <span>\${escapeHtml(formatProjectWorkspaceConflict(project))}</span>
        </span>
      \`;
    }

    function formatProjectWorkspaceConflict(project) {
      const count = project.workspaceConflictCount || 0;
      const latest = project.latestWorkspaceConflict || {};
      const owner = latest.actor || latest.clientId || "system";
      const activeEditors = latest.activeEditorCount !== undefined
        ? \`, \${latest.activeEditorCount} active editor\${latest.activeEditorCount === 1 ? "" : "s"}\`
        : "";
      return \`\${count} recent conflict\${count === 1 ? "" : "s"}; latest \${latest.operation || "edit"} \${latest.path || "workspace"} by \${owner}\${activeEditors}\`;
    }

    function renderProjectLatestControlActivity(project) {
      const activity = project.latestControlActivity;
      if (!activity) return "";
      return \`
        <span class="meta">
          <span class="pill">control</span>
          <span>\${escapeHtml(formatProjectLatestControlActivity(activity))}</span>
        </span>
      \`;
    }

    function formatProjectLatestControlActivity(activity) {
      const owner = activity.actor || activity.clientId || "system";
      const run = activity.runId ? \` \${activity.runId}\` : "";
      if (activity.type === "project_created") {
        const template = activity.template ? \` \${activity.template}\` : "";
        return \`project\${template} created by \${owner}\`;
      }
      if (activity.type === "project_source_defaults_updated") {
        const target = activity.cleared ? "cleared" : "updated";
        const source = activity.repo || activity.issue || activity.branch || "source defaults";
        return \`project source defaults \${target}: \${source} by \${owner}\`;
      }
      if (activity.type === "project_default_skills_updated") {
        const target = activity.cleared ? "cleared" : "updated";
        const count = Array.isArray(activity.defaultSkills) ? \` \${activity.defaultSkills.length} skill\${activity.defaultSkills.length === 1 ? "" : "s"}\` : "";
        return \`project default skills \${target}\${count} by \${owner}\`;
      }
      if (activity.type === "project_run_policy_updated") {
        const target = activity.cleared ? "cleared" : "updated";
        const preset = activity.runPolicy && activity.runPolicy.preset ? \`: \${activity.runPolicy.preset}\` : "";
        return \`project run policy \${target}\${preset} by \${owner}\`;
      }
      if (activity.type === "project_contract_updated") {
        const target = activity.cleared ? "cleared" : "updated";
        const source = activity.source ? \` from \${activity.source}\` : "";
        return \`project contract \${target}\${source}\${run} by \${owner}\`;
      }
      if (activity.type === "vas_case_created") {
        return \`VAS case \${activity.caseId || "case"} created by \${owner}\`;
      }
      if (activity.type === "vas_case_claimed") {
        const previousClaim = activity.previousClaim ? \` from \${formatVasCaseClaim(activity.previousClaim)}\` : "";
        return \`VAS case \${activity.caseId || "case"} \${activity.action || "claim"} by \${owner}\${previousClaim}\`;
      }
      if (activity.type === "vas_case_reviewed") {
        return \`VAS case \${activity.caseId || "case"} \${activity.decision || activity.status || "reviewed"} by \${owner}\`;
      }
      if (activity.type === "run_comment_added") {
        return \`comment\${run}: \${activity.message || "message"} by \${owner}\`;
      }
      if (activity.type === "run_issue_comments_synced") {
        const count = typeof activity.synced === "number" ? activity.synced : 0;
        const command = activity.deployed ? "deployment" : activity.runReviewed ? "review" : activity.resumed ? "resume" : activity.pauseRequested ? "pause" : "issue sync";
        return \`\${command}\${run}: \${count} comments by \${owner}\`;
      }
      if (activity.type === "run_resumed") {
        return \`resumed\${run} by \${owner}\`;
      }
      if (activity.type === "run_cancelled") {
        return \`cancelled\${run}: \${activity.reason || activity.status || "cancelled"} by \${owner}\`;
      }
      if (activity.type === "run_abandoned") {
        return \`abandoned\${run}: \${activity.reason || activity.status || "abandoned"} by \${owner}\`;
      }
      if (activity.type === "run_review_claimed") {
        const previousClaim = activity.previousClaim ? \` from \${formatRunReviewClaim(activity.previousClaim)}\` : "";
        return \`review \${activity.action || "claim"}\${run} by \${owner}\${previousClaim}\`;
      }
      if (activity.type === "review_decided") {
        return \`review \${activity.decision || activity.status || "decided"}\${run} by \${owner}\`;
      }
      if (activity.type === "deployment_decided") {
        return \`deployment \${activity.decision || activity.status || "decided"}\${run} by \${owner}\`;
      }
      if (activity.type === "run_handoff_followup_created") {
        return \`follow-up \${activity.followupRunId || activity.goal || "run"} from\${run || " run"} by \${owner}\`;
      }
      if (activity.type === "run_handoff_followup_denied") {
        return \`follow-up denied from\${run || " run"}: \${activity.reason || "checkpoint changed"} by \${owner}\`;
      }
      if (activity.type === "tenant_control_plane_restore_dry_run") {
        const target = activity.targetProvider ? \` to \${activity.targetProvider}\` : "";
        const cutover = activity.cutoverReady === undefined ? "" : activity.cutoverReady ? ", cutover ready" : ", cutover blocked";
        const missingProjects = Array.isArray(activity.agentGitServiceProjectAgentsMissingProjects) && activity.agentGitServiceProjectAgentsMissingProjects.length
          ? \`, missing project agents: \${activity.agentGitServiceProjectAgentsMissingProjects.join(", ")}\`
          : "";
        return \`restore dry-run\${target}\${cutover}\${missingProjects} by \${owner}\`;
      }
      return \`\${activity.type || "control"}\${run} by \${owner}\`;
    }

    function renderProjectHumanGateRuns(project) {
      const gates = projectHumanGateRuns(project);
      if (!gates.length) return "";
      return gates.map((gate) => {
        const gateProject = gate.project || project.project;
        const runId = gate.runId || "";
        return \`
          <div class="project-queued-run">
            <span class="pill \${escapeAttr(gate.kind)}">\${escapeHtml(gate.label)}</span>
            <button class="project-select" type="button" data-project-gate-run-project="\${escapeAttr(gateProject)}" data-project-gate-run-id="\${escapeAttr(runId)}">\${escapeHtml(runId)}</button>
            <span>\${escapeHtml(formatProjectHumanGateRun(gate))}</span>
            <a data-testid="project-gate-workbench" href="\${escapeAttr(workbenchRunUrl(gateProject, runId))}" target="_blank" rel="noreferrer">Workbench</a>
          </div>
        \`;
      }).join("");
    }

    function formatProjectHumanGateRun(gate) {
      const parts = [];
      if (gate.goal) parts.push(gate.goal);
      if (gate.claim) {
        parts.push(\`claimed by \${gate.claim.actor || gate.claim.clientId || "reviewer"}\`);
      }
      if (gate.deploymentStatus) parts.push(\`deployment \${gate.deploymentStatus}\`);
      if (gate.reviewStatus && !gate.claim) parts.push(\`review \${gate.reviewStatus}\`);
      if (gate.issue) parts.push(gate.issue);
      return parts.join(" · ") || gate.status || "pending";
    }

    function renderProjectQueuedRuns(project) {
      const runs = projectQueuedRuns(project);
      if (!runs.length) return "";
      return runs.map((run) => {
        const runProject = run.project || project.project;
        const runId = run.runId || "";
        return \`
          <div class="project-queued-run">
            <span class="pill queued">queued</span>
            <button class="project-select" type="button" data-project-queued-run-project="\${escapeAttr(runProject)}" data-project-queued-run-id="\${escapeAttr(runId)}">\${escapeHtml(runId)}</button>
            <span>\${escapeHtml(formatQueuedRunBlocker(run))}</span>
            \${run.queuedAt ? \`<span>\${escapeHtml(run.queuedAt)}</span>\` : ""}
            <a data-testid="project-queued-workbench" href="\${escapeAttr(workbenchRunUrl(runProject, runId))}" target="_blank" rel="noreferrer">Workbench</a>
            <button data-testid="project-queued-cancel" class="danger" type="button" data-project-queued-cancel-project="\${escapeAttr(runProject)}" data-project-queued-cancel-id="\${escapeAttr(runId)}" \${canMutate() ? "" : "disabled"}>Cancel</button>
          </div>
        \`;
      }).join("");
    }

    function sortProjectsByActivity(projects) {
      if (!Array.isArray(projects)) return [];
      return projects.slice().sort((a, b) => {
        const activity = projectActivityAt(b).localeCompare(projectActivityAt(a));
        return activity || String(a.project || "").localeCompare(String(b.project || ""));
      });
    }

    function projectActivityAt(project) {
      return project.activityAt || project.latestStartedAt || "";
    }

    function renderVasCases() {
      if (!state.vasCases.length) {
        vasCaseList.innerHTML = '<div class="empty">No VAS cases loaded.</div>';
        return;
      }
      vasCaseList.innerHTML = state.vasCases.map((item) => \`
        <button class="project-item" type="button" data-vas-case="\${escapeAttr(item.id)}">
          <span class="run-title">\${escapeHtml(item.title || item.id)}</span>
          <span class="meta">
            \${item.status ? \`<span class="pill \${escapeAttr(item.status)}">\${escapeHtml(item.status)}</span>\` : ""}
            <span>\${escapeHtml(item.id)}</span>
            \${item.reviewCount !== undefined ? \`<span>\${escapeHtml(item.reviewCount)} reviews</span>\` : ""}
            \${item.learningCount !== undefined ? \`<span>\${escapeHtml(item.learningCount)} learnings</span>\` : ""}
            \${item.reviewedRunCount !== undefined ? \`<span>\${escapeHtml(item.reviewedRunCount)}/\${escapeHtml(item.runCount || 0)} reviewed runs</span>\` : ""}
            \${item.unreviewedRunCount > 0 ? \`<span class="pill queued">\${escapeHtml(item.unreviewedRunCount)} unreviewed</span>\` : ""}
            \${!item.unreviewedRunCount && item.latestRunReviewDecision ? \`<span class="pill \${escapeAttr(item.latestRunReviewDecision)}">review \${escapeHtml(item.latestRunReviewDecision)}</span>\` : ""}
            \${item.latestRunId ? \`<span class="pill \${escapeAttr(item.latestRunStatus || "")}">run \${escapeHtml(item.latestRunStatus || "unknown")}</span>\` : ""}
            \${item.latestRunId ? \`<span>\${escapeHtml(item.latestRunId)}</span>\` : ""}
            \${item.claim ? \`<span class="pill queued">claimed by \${escapeHtml(formatVasCaseClaim(item.claim))}</span>\` : ""}
            \${item.issue ? \`<span>\${escapeHtml(item.issue)}</span>\` : ""}
            \${item.branch ? \`<span>\${escapeHtml(item.branch)}</span>\` : ""}
            \${item.sourceDefaultFields && item.sourceDefaultFields.length ? \`<span class="pill" title="\${escapeAttr(formatVasCaseSourceDefaultFields(item.sourceDefaultFields))}">project defaults</span>\` : ""}
            \${item.source ? \`<span>\${escapeHtml(formatVasCaseSource(item.source))}</span>\` : ""}
          </span>
        </button>
      \`).join("");
      for (const item of vasCaseList.querySelectorAll(".project-item")) {
        item.addEventListener("click", () => selectVasCase(item.dataset.vasCase));
      }
    }

    function renderVasReviewQueue() {
      if (!state.vasReviewQueue.length) {
        vasReviewQueueList.innerHTML = '<div class="empty">No VAS cases need review.</div>';
        return;
      }
      vasReviewQueueList.innerHTML = state.vasReviewQueue.map((item) => \`
        <button class="project-item" type="button" data-vas-queue-case-id="\${escapeAttr(item.id)}">
          <span class="run-title">\${escapeHtml(item.title || item.id)}</span>
          <span class="meta">
            \${Array.isArray(item.reasons) ? item.reasons.map((reason) => \`<span class="pill \${escapeAttr(reason)}">\${escapeHtml(formatVasReviewQueueReason(reason))}</span>\`).join("") : ""}
            \${item.status ? \`<span class="pill \${escapeAttr(item.status)}">\${escapeHtml(item.status)}</span>\` : ""}
            <span>\${escapeHtml(item.id)}</span>
            \${item.unreviewedRunCount !== undefined ? \`<span>\${escapeHtml(item.unreviewedRunCount)} unreviewed runs</span>\` : ""}
            \${item.reviewedRunCount !== undefined ? \`<span>\${escapeHtml(item.reviewedRunCount)} reviewed runs</span>\` : ""}
            \${item.latestRunStatus ? \`<span class="pill \${escapeAttr(item.latestRunStatus)}">\${escapeHtml(item.latestRunStatus)}</span>\` : ""}
            \${item.latestRunId ? \`<span>\${escapeHtml(item.latestRunId)}</span>\` : ""}
            \${item.claim ? \`<span class="pill queued">claimed by \${escapeHtml(formatVasCaseClaim(item.claim))}</span>\` : ""}
            \${item.issue ? \`<span>\${escapeHtml(item.issue)}</span>\` : ""}
          </span>
        </button>
      \`).join("");
      for (const item of vasReviewQueueList.querySelectorAll("[data-vas-queue-case-id]")) {
        item.addEventListener("click", () => openVasReviewQueueCase(item.dataset.vasQueueCaseId));
      }
    }

    function renderVasLearnings() {
      if (!state.vasLearnings.length) {
        vasLearningList.innerHTML = '<div class="empty">No VAS learnings loaded.</div>';
        return;
      }
      vasLearningList.innerHTML = state.vasLearnings.map((item) => \`
        <div class="project-item">
          <span class="run-title">\${escapeHtml(item.text || "")}</span>
          <span class="meta">
            <span>case \${escapeHtml(item.caseId || "unknown")}</span>
            \${item.reviewDecision ? \`<span class="pill \${escapeAttr(item.reviewDecision)}">\${escapeHtml(item.reviewDecision)}</span>\` : ""}
            \${item.source ? \`<span>\${escapeHtml(item.source)}</span>\` : ""}
            \${item.actor ? \`<span>\${escapeHtml(item.actor)}</span>\` : ""}
            \${item.clientId ? \`<span>\${escapeHtml(item.clientId)}</span>\` : ""}
            \${item.reviewedAt ? \`<span>\${escapeHtml(item.reviewedAt)}</span>\` : ""}
          </span>
        </div>
      \`).join("");
    }

    function renderVasArtifacts() {
      if (!state.vasArtifacts) {
        vasArtifactView.innerHTML = '<div class="empty">No VAS artifacts loaded.</div>';
        return;
      }
      const artifacts = state.vasArtifacts;
      vasArtifactView.innerHTML = \`
        <h3>VAS Artifacts: \${escapeHtml(artifacts.caseId || "unknown")}</h3>
        <div class="summary-grid">
          <span>\${escapeHtml(artifacts.contextPath || "context missing")}</span>
          <span>\${escapeHtml(artifacts.reportPath || "report missing")}</span>
          <span>\${escapeHtml(artifacts.reviewDraftPath || "review draft missing")}</span>
        </div>
        \${renderVasReviewGuidance(artifacts.context && artifacts.context.reviewGuidance)}
        <h3>Context</h3>
        <pre>\${escapeHtml(artifacts.context ? JSON.stringify(artifacts.context, null, 2) : "No context artifact.")}</pre>
        <h3>Report</h3>
        <pre>\${escapeHtml(artifacts.report || "No report artifact.")}</pre>
        <h3>Review Draft</h3>
        <pre>\${escapeHtml(artifacts.reviewDraft ? JSON.stringify(artifacts.reviewDraft, null, 2) : "No review draft artifact.")}</pre>
      \`;
    }

    function renderVasReviewPackage(data = state.vasReviewPackage) {
      if (!data) {
        vasReviewPackageView.innerHTML = '<div class="empty">No VAS review package loaded.</div>';
        return;
      }
      const caseSummary = data.case || {};
      const links = data.links || {};
      vasReviewPackageView.innerHTML = \`
        <h3>VAS Review Package: \${escapeHtml(data.caseId || "unknown")}</h3>
        <div class="summary-grid">
          \${caseSummary.status ? \`<span class="pill \${escapeAttr(caseSummary.status)}">\${escapeHtml(caseSummary.status)}</span>\` : ""}
          \${caseSummary.reviewCount !== undefined ? \`<span>\${escapeHtml(caseSummary.reviewCount)} reviews</span>\` : ""}
          \${caseSummary.correctionCount !== undefined ? \`<span>\${escapeHtml(caseSummary.correctionCount)} corrections</span>\` : ""}
          \${caseSummary.learningCount !== undefined ? \`<span>\${escapeHtml(caseSummary.learningCount)} learnings</span>\` : ""}
          \${Array.isArray(data.runs) ? \`<span>\${escapeHtml(data.runs.length)} runs</span>\` : ""}
          \${Array.isArray(data.issueCommentSeeds) ? \`<span>\${escapeHtml(data.issueCommentSeeds.length)} issue seeds</span>\` : ""}
          \${Array.isArray(data.auditTrail) ? \`<span>\${escapeHtml(data.auditTrail.length)} audit events</span>\` : ""}
          \${caseSummary.claim ? \`<span class="pill queued">claimed by \${escapeHtml(formatVasCaseClaim(caseSummary.claim))}</span>\` : ""}
          \${links.artifacts ? \`<a href="\${escapeAttr(links.artifacts)}" target="_blank" rel="noreferrer">Artifacts</a>\` : ""}
          \${links.runs ? \`<a href="\${escapeAttr(links.runs)}" target="_blank" rel="noreferrer">Runs</a>\` : ""}
          \${links.reviewRuns ? \`<a href="\${escapeAttr(links.reviewRuns)}" target="_blank" rel="noreferrer">Review Runs</a>\` : ""}
        </div>
        \${renderVasReviewGuidance(data.artifacts && data.artifacts.context && data.artifacts.context.reviewGuidance)}
        <h3>Package</h3>
        <pre>\${escapeHtml(JSON.stringify(data, null, 2))}</pre>
      \`;
    }

    function renderVasReviewGuidance(guidance) {
      if (!guidance || typeof guidance !== "object") return "";
      return \`
        <h3>Review Guidance</h3>
        <div class="summary-grid">
          <span>\${escapeHtml(guidance.reviewCount || 0)} reviews</span>
          <span>\${escapeHtml(guidance.correctionCount || 0)} corrections</span>
          <span>\${escapeHtml(guidance.learningCount || 0)} learnings</span>
        </div>
        \${renderVasLatestReviewGuidance(guidance.latestReview)}
        \${renderVasGuidanceTextList("Corrections", guidance.corrections)}
        \${renderVasGuidanceTextList("Case Learnings", guidance.learnings)}
      \`;
    }

    function renderVasLatestReviewGuidance(review) {
      if (!review || typeof review !== "object") {
        return '<div class="empty">No current case review guidance.</div>';
      }
      return \`
        <div class="meta">
          <span class="pill \${escapeAttr(review.decision || "unknown")}">latest review \${escapeHtml(review.decision || "unknown")}</span>
          \${review.note ? \`<span>\${escapeHtml(review.note)}</span>\` : ""}
          \${review.runId ? \`<span>\${escapeHtml(review.runId)}</span>\` : ""}
          \${review.actor ? \`<span>\${escapeHtml(review.actor)}</span>\` : ""}
          \${review.clientId ? \`<span>\${escapeHtml(review.clientId)}</span>\` : ""}
          \${review.reviewedAt ? \`<span>\${escapeHtml(review.reviewedAt)}</span>\` : ""}
        </div>
      \`;
    }

    function renderVasGuidanceTextList(title, entries) {
      if (!Array.isArray(entries) || !entries.length) return "";
      return \`
        <h4>\${escapeHtml(title)}</h4>
        <ul>
          \${entries.map((entry) => \`<li>\${escapeHtml(formatVasGuidanceText(entry))}</li>\`).join("")}
        </ul>
      \`;
    }

    function formatVasGuidanceText(entry) {
      if (!entry || typeof entry !== "object") return "";
      return [
        entry.text || "",
        entry.reviewDecision ? \`decision=\${entry.reviewDecision}\` : "",
        entry.runId ? \`run=\${entry.runId}\` : "",
        entry.actor ? \`reviewedBy=\${entry.actor}\` : "",
        entry.clientId ? \`clientId=\${entry.clientId}\` : "",
        entry.reviewedAt ? \`reviewedAt=\${entry.reviewedAt}\` : ""
      ].filter(Boolean).join(" / ");
    }

    function renderVasCaseRuns() {
      const sourceHtml = renderVasCaseRunSource(state.vasCaseRunSource);
      if (!state.vasCaseRuns.length) {
        vasCaseRunList.innerHTML = sourceHtml + '<div class="empty">No VAS case runs loaded.</div>';
        return;
      }
      vasCaseRunList.innerHTML = sourceHtml + state.vasCaseRuns.map((run) => \`
        <button class="run-item" type="button" data-vas-run-id="\${escapeAttr(run.runId)}" aria-selected="\${state.selected && state.selected.runId === run.runId}">
          <span class="run-title">\${escapeHtml(run.goal || run.runId)}</span>
          <span class="meta">
            <span class="pill \${escapeAttr(run.status || "")}">\${escapeHtml(run.status || "unknown")}</span>
            <span class="pill \${escapeAttr(run.reviewDecision || run.reviewStatus || "unreviewed")}">\${escapeHtml(run.reviewDecision || run.reviewStatus || "unreviewed")}</span>
            \${run.failureKind ? \`<span class="pill failed" title="\${escapeAttr(formatVasRunFailure(run))}">failure \${escapeHtml(run.failureKind)}</span>\` : ""}
            \${run.reviewGateStatus ? \`<span class="pill \${escapeAttr(run.reviewGateStatus)}">review \${escapeHtml(run.reviewGateStatus)}</span>\` : ""}
            \${run.deploymentGateStatus ? \`<span class="pill \${escapeAttr(run.deploymentGateStatus)}">deployment \${escapeHtml(run.deploymentGateStatus)}</span>\` : ""}
            \${run.pullRequestIndex ? \`<span>PR #\${escapeHtml(run.pullRequestIndex)}</span>\` : ""}
            \${run.contextWritten ? \`<span class="pill passed" title="\${escapeAttr(run.contextPath || "")}">context</span>\` : ""}
            \${run.reportWritten ? \`<span class="pill passed" title="\${escapeAttr(run.reportPath || "")}">report</span>\` : ""}
            \${run.reviewDraftWritten ? \`<span class="pill passed" title="\${escapeAttr(run.reviewDraftPath || "")}">draft</span>\` : ""}
            <span>\${escapeHtml(run.runId)}</span>
            \${run.agentMode ? \`<span>\${escapeHtml(run.agentMode)}</span>\` : ""}
            \${run.repo ? \`<span>\${escapeHtml(run.repo)}</span>\` : ""}
            \${run.branch ? \`<span>\${escapeHtml(run.branch)}</span>\` : ""}
            \${run.baseBranch ? \`<span>base \${escapeHtml(run.baseBranch)}</span>\` : ""}
            \${run.issueUrl ? \`<a href="\${escapeAttr(run.issueUrl)}" target="_blank" rel="noreferrer">Issue</a>\` : run.issue ? \`<span>\${escapeHtml(run.issue)}</span>\` : ""}
            \${run.pullRequestUrl ? \`<a href="\${escapeAttr(run.pullRequestUrl)}" target="_blank" rel="noreferrer">PR</a>\` : ""}
            \${run.summaryUrl ? \`<a href="\${escapeAttr(run.summaryUrl)}" target="_blank" rel="noreferrer">Summary</a>\` : ""}
            \${run.reviewSummaryUrl ? \`<a href="\${escapeAttr(run.reviewSummaryUrl)}" target="_blank" rel="noreferrer">Review</a>\` : ""}
            \${run.handoffPackageUrl ? \`<a href="\${escapeAttr(run.handoffPackageUrl)}" target="_blank" rel="noreferrer">Package</a>\` : ""}
            \${run.startedAt ? \`<span>\${escapeHtml(run.startedAt)}</span>\` : ""}
            \${run.reviewedAt ? \`<span>\${escapeHtml(run.reviewedAt)}</span>\` : ""}
          </span>
        </button>
      \`).join("");
      for (const item of vasCaseRunList.querySelectorAll(".run-item")) {
        item.addEventListener("click", () => openVasCaseRun(item.dataset.vasRunId));
      }
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

    function selectVasCase(caseId) {
      if (!caseId) return;
      vasCaseIdInput.value = caseId;
      runPresetInput.value = "vas-lite-review";
      runPresetCaseInput.value = caseId;
      const selected = state.vasCases.find((item) => item.id === caseId);
      if (selected && selected.source && selected.source.url) vasCaseSourceUrlInput.value = selected.source.url;
      if (selected) {
        vasCaseRepoInput.value = selected.repo || "";
        vasCaseBranchInput.value = selected.branch || "";
        vasCaseBaseBranchInput.value = selected.baseBranch || "";
        vasCaseIssueInput.value = selected.issue || "";
        repoInput.value = selected.repo || "";
        branchInput.value = selected.branch || "";
        baseBranchInput.value = selected.baseBranch || "";
        issueInput.value = selected.issue || "";
      }
      if (selected && selected.latestRunId) void openVasCaseRun(selected.latestRunId);
      state.vasArtifacts = null;
      state.vasReviewPackage = null;
      state.vasCaseRuns = [];
      state.vasCaseRunSource = null;
      renderVasCases();
      renderVasArtifacts();
      renderVasReviewPackage();
      renderVasCaseRuns();
      applyAccessControls();
      void loadVasCaseRuns(true);
    }

    async function openVasReviewQueueCase(caseId) {
      if (!caseId) return;
      selectVasCase(caseId);
      await loadVasReviewPackage(true);
      await loadVasCaseRuns(true);
      await loadVasArtifacts(true);
    }

    function formatVasCaseClaim(claim) {
      if (!claim || typeof claim !== "object") return "unknown";
      const owner = claim.actor || claim.clientId || "unknown";
      return claim.claimedAt ? \`\${owner} \${claim.claimedAt}\` : owner;
    }

    function formatVasReviewQueueReason(reason) {
      if (reason === "unreviewed_run") return "unreviewed run";
      if (reason === "needs_review") return "needs review";
      if (reason === "needs_revision") return "needs revision";
      return reason || "review needed";
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

    function formatVasCaseSource(source) {
      if (!source || typeof source !== "object") return "";
      if (source.url) return source.url;
      return source.kind || "";
    }

    function formatVasCaseSourceDefaultFields(sourceDefaultFields) {
      if (!Array.isArray(sourceDefaultFields) || !sourceDefaultFields.length) return "";
      return "from project defaults: " + sourceDefaultFields.join(", ");
    }

    function renderProjectPresence() {
      if (!state.projectPresence.length) {
        projectPresence.innerHTML = '<div class="empty">No collaborators online.</div>';
        return;
      }
      projectPresence.innerHTML = state.projectPresence.map((entry) => \`
        <div class="project-item">
          <span class="run-title">\${escapeHtml(entry.label || entry.clientId)}</span>
          <span class="meta">
            <span>\${escapeHtml(entry.actor || entry.clientId)}</span>
            \${entry.role ? \`<span>\${escapeHtml(entry.role)}</span>\` : ""}
            \${entry.focus ? \`<span>\${escapeHtml(entry.focus)}</span>\` : ""}
            \${entry.seenAt ? \`<span>\${escapeHtml(entry.seenAt)}</span>\` : ""}
          </span>
        </div>
      \`).join("");
    }

    function projectPresenceFocus() {
      if (state.presenceFocus) return state.presenceFocus;
      if (state.workspaceFile && state.workspaceFile.path) return "file:" + state.workspaceFile.path;
      if (state.terminalSessionId) return "session:" + state.terminalSessionId;
      if (state.selectedCommandId) return "command:" + state.selectedCommandId;
      if (state.selected && state.selected.runId) return "run:" + state.selected.runId;
      if (state.workspacePath) return "dir:" + state.workspacePath;
      return "project:" + project();
    }

    function formatProjectActivityEvent(event) {
      const actor = event.actor || event.role || "system";
      return \`\${actor} \${formatTenantAuditEvent(event)}\`;
    }

    function renderProjectActivity() {
      const events = (Array.isArray(state.auditEvents) ? state.auditEvents : [])
        .filter((event) => event.data?.project === project())
        .slice(-8)
        .reverse();
      if (!events.length) {
        projectActivity.innerHTML = '<div class="empty">No project activity loaded.</div>';
        return;
      }
      projectActivity.innerHTML = events.map((event) => \`
        <article class="event">
          <div class="event-head">
            <span>\${escapeHtml(formatProjectActivityEvent(event))}</span>
            <span>\${escapeHtml(event.ts || "")}</span>
          </div>
          <pre>\${escapeHtml(JSON.stringify(event.data || {}, null, 2))}</pre>
        </article>
      \`).join("");
    }

    function renderRuns() {
      if (!state.runs.length) {
        runList.innerHTML = '<div class="empty">No runs for this tenant/project.</div>';
        return;
      }
      runList.innerHTML = state.runs.map((run) => {
        const queueMeta = formatRunQueueMeta(run);
        return \`
          <button class="run-item" type="button" aria-selected="\${state.selected && state.selected.runId === run.runId}" data-run-id="\${escapeAttr(run.runId)}">
            <span class="run-title">\${escapeHtml(run.goal)}</span>
            <span class="meta">
              <span class="pill \${escapeAttr(run.status)}">\${escapeHtml(run.status)}</span>
              <span>\${escapeHtml(run.runId)}</span>
              \${queueMeta ? \`<span class="pill queued">\${escapeHtml(queueMeta)}</span>\` : ""}
              \${run.requester ? \`<span>by \${escapeHtml(formatRunRequester(run.requester))}</span>\` : ""}
              \${run.metadata && run.metadata.repo ? \`<span>\${escapeHtml(run.metadata.repo)}</span>\` : ""}
              \${run.metadata && run.metadata.branch ? \`<span>\${escapeHtml(run.metadata.branch)}</span>\` : ""}
              \${run.metadata && run.metadata.baseBranch ? \`<span>base \${escapeHtml(run.metadata.baseBranch)}</span>\` : ""}
              \${run.metadata && run.metadata.issueUrl ? \`<a href="\${escapeAttr(run.metadata.issueUrl)}" target="_blank" rel="noreferrer">Issue</a>\` : run.metadata && run.metadata.issue ? \`<span>\${escapeHtml(run.metadata.issue)}</span>\` : ""}
              \${renderHandoffSourceLinks(run.metadata)}
              \${renderProjectRunPolicyEvidence(run.metadata)}
              \${renderProjectContractEvidence(run.metadata)}
            </span>
          </button>
        \`;
      }).join("");
      for (const item of runList.querySelectorAll(".run-item")) {
        item.addEventListener("click", () => selectRun(item.dataset.runId));
      }
    }

    function renderWorkspaceFiles() {
      workspacePathEl.textContent = "/" + state.workspacePath;
      const parent = state.workspacePath ? \`
        <button class="file-item" type="button" data-file-path="\${escapeHtml(parentPath(state.workspacePath))}" data-file-kind="directory">
          <span class="run-title">..</span>
          <span class="meta">parent directory</span>
        </button>
      \` : "";
      const entries = state.workspaceEntries.map((entry) => \`
        <button class="file-item" type="button" data-file-path="\${escapeHtml(entry.path)}" data-file-kind="\${escapeHtml(entry.kind)}">
          <span class="run-title">\${escapeHtml(entry.name)}</span>
          <span class="meta">
            <span>\${escapeHtml(entry.kind)}</span>
            \${entry.kind === "file" ? \`<span>\${escapeHtml(formatBytes(entry.size || 0))}</span>\` : ""}
          </span>
        </button>
      \`).join("");
      workspaceFiles.innerHTML = parent + entries || '<div class="empty">No files in this directory.</div>';
      for (const item of workspaceFiles.querySelectorAll(".file-item")) {
        item.addEventListener("click", () => selectWorkspaceFile(item.dataset.filePath, item.dataset.fileKind));
      }
      renderWorkspaceFileContent();
    }

    function renderWorkspaceInfo() {
      const data = state.workspaceInfo;
      if (!data) {
        workspaceContext.innerHTML = '<div class="empty">Workspace context not loaded.</div>';
        return;
      }
      if (data.error) {
        workspaceContext.innerHTML = \`<div class="empty">\${escapeHtml(data.error)}</div>\`;
        return;
      }
      const executorKind = data.executor && data.executor.kind ? data.executor.kind : data.route || "workspace";
      const executorTarget = data.executor && data.executor.remoteCwd
        ? data.executor.remoteCwd
        : data.executor && data.executor.containerCwd
          ? data.executor.containerCwd
          : data.cwd || "";
      workspaceContext.innerHTML = \`
        <div class="summary-grid">
          <span class="pill">\${escapeHtml(executorKind)}</span>
          <span>\${escapeHtml(data.route || "project")}</span>
          \${executorTarget ? \`<span>\${escapeHtml(executorTarget)}</span>\` : ""}
          \${data.branch ? \`<span>\${escapeHtml(data.branch)}</span>\` : ""}
          \${data.issue ? \`<span>\${escapeHtml(data.issue)}</span>\` : ""}
          \${data.executor && data.executor.ideUrl ? \`<a href="\${escapeAttr(data.executor.ideUrl)}" target="_blank" rel="noreferrer">Open IDE</a>\` : ""}
          \${data.executor && data.executor.previewUrl ? \`<a href="\${escapeAttr(data.executor.previewUrl)}" target="_blank" rel="noreferrer">Open Preview</a>\` : ""}
        </div>
        <pre>\${escapeHtml(formatWorkspaceInfo(data))}</pre>
      \`;
    }

    function renderWorkspaceDiff() {
      const data = state.workspaceDiff;
      if (!data) {
        workspaceDiff.hidden = true;
        workspaceDiff.textContent = "";
        return;
      }
      workspaceDiff.hidden = false;
      workspaceDiff.textContent = formatCommandResult(data);
    }

    function formatWorkspaceInfo(data) {
      return [
        data.route ? "route=" + data.route : "",
        data.runId ? "runId=" + data.runId : "",
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

    function renderWorkspaceFileContent() {
      if (!state.workspaceFile) {
        workspaceFileEditor.hidden = true;
        workspaceFileName.textContent = "";
        workspaceFileContent.value = "";
        reloadFileButton.disabled = true;
        return;
      }
      workspaceFileEditor.hidden = false;
      const collaborators = workspaceFileCollaborators();
      const collaboratorText = collaborators.length ? " - also editing: " + collaborators.join(", ") : "";
      const fileMeta = state.workspaceFile.updatedAt ? formatBytes(state.workspaceFile.size || 0) : "new file";
      workspaceFileName.textContent = state.workspaceFile.path + " - " + fileMeta + collaboratorText;
      workspaceFileContent.value = state.workspaceFile.content;
      reloadFileButton.disabled = !state.workspaceFile.updatedAt;
      applyAccessControls();
    }

    function workspaceFileCollaborators() {
      if (!state.workspaceFile) return [];
      return state.projectPresence
        .filter((entry) => entry.clientId !== state.clientId)
        .filter((entry) => entry.focus === "file:" + state.workspaceFile.path)
        .map((entry) => entry.label || entry.actor || entry.clientId);
    }

    function formatWorkspaceFileConflict(data) {
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

    function renderWorkspaceCommands() {
      if (!state.workspaceCommands.length) {
        workspaceCommands.innerHTML = '<div class="empty">No commands loaded.</div>';
        return;
      }
      workspaceCommands.innerHTML = state.workspaceCommands.map((command) => \`
        <button class="command-item" type="button" aria-selected="\${state.selectedCommandId === command.commandId}" data-command-id="\${escapeAttr(command.commandId)}">
          <span class="run-title">\${escapeHtml(command.command || command.commandId)}</span>
          <span class="meta">
            <span class="pill \${command.exitCode === 0 ? "passed" : "failed"}">exit \${escapeHtml(command.exitCode)}</span>
            <span>\${escapeHtml(command.commandId)}</span>
            \${workspaceCommandMeta(command) ? \`<span>\${escapeHtml(workspaceCommandMeta(command))}</span>\` : ""}
            \${command.endedAt ? \`<span>\${escapeHtml(command.endedAt)}</span>\` : ""}
          </span>
        </button>
      \`).join("");
      for (const item of workspaceCommands.querySelectorAll(".command-item")) {
        item.addEventListener("click", () => selectWorkspaceCommand(item.dataset.commandId));
      }
    }

    function renderWorkspaceSessions() {
      if (!state.workspaceSessions.length) {
        workspaceSessions.innerHTML = '<div class="empty">No sessions loaded.</div>';
        return;
      }
      workspaceSessions.innerHTML = state.workspaceSessions.map((session) => \`
        <button class="session-item" type="button" aria-selected="\${state.terminalSessionId === session.sessionId}" data-session-id="\${escapeAttr(session.sessionId)}">
          <span class="run-title">\${escapeHtml(session.command || session.sessionId)}</span>
          <span class="meta">
            <span class="pill \${escapeAttr(session.status)}">\${escapeHtml(session.status)}</span>
            <span>\${escapeHtml(session.sessionId)}</span>
            \${workspaceSessionMeta(session) ? \`<span>\${escapeHtml(workspaceSessionMeta(session))}</span>\` : ""}
            \${workspaceSessionLifecycleMeta(session) ? \`<span>\${escapeHtml(workspaceSessionLifecycleMeta(session))}</span>\` : ""}
            \${session.eventCount !== undefined ? \`<span>\${escapeHtml(session.eventCount)} events</span>\` : ""}
            \${session.exitCode !== undefined ? \`<span>exit \${escapeHtml(session.exitCode)}</span>\` : ""}
          </span>
        </button>
      \`).join("");
      for (const item of workspaceSessions.querySelectorAll(".session-item")) {
        item.addEventListener("click", () => selectWorkspaceSession(item.dataset.sessionId));
      }
    }

    function workspaceCommandMeta(command) {
      return [
        command.actor || command.clientId,
        command.role,
        command.actor && command.clientId ? command.clientId : ""
      ].filter(Boolean).join(" ");
    }

    function workspaceSessionMeta(session) {
      return [
        session.actor || session.clientId,
        session.role,
        session.actor && session.clientId ? session.clientId : "",
        session.startedAt || ""
      ].filter(Boolean).join(" ");
    }

    function workspaceSessionLifecycleMeta(session) {
      return [
        session.lastActivityAt ? \`last \${session.lastActivityAt}\` : "",
        session.idleExpiresAt ? \`idle until \${session.idleExpiresAt}\` : "",
        session.endedAt ? \`ended \${session.endedAt}\` : ""
      ].filter(Boolean).join(" ");
    }

    function renderSummary() {
      const run = state.selected;
      if (!run) {
        summaryEl.innerHTML = '<div class="empty">Select or create a run.</div>';
        renderRunControlPanel();
        renderReviewPanel();
        renderDeploymentPanel();
        renderReplay();
        renderReviewSummary();
        return;
      }
      summaryEl.innerHTML = \`
        <h3>\${escapeHtml(run.goal)}</h3>
        <div class="summary-grid">
          <span class="pill \${escapeAttr(run.status)}">\${escapeHtml(run.status)}</span>
          <span>run \${escapeHtml(run.runId)}</span>
          \${run.requester ? \`<span>by \${escapeHtml(formatRunRequester(run.requester))}</span>\` : ""}
          <span>\${escapeHtml((run.skills || []).join(", ") || "no skills")}</span>
          <span>\${escapeHtml(run.startedAt || "")}</span>
          \${run.review ? \`<span>review \${escapeHtml(run.review.status)}</span>\` : ""}
          \${run.review && run.review.claim ? \`<span>claimed by \${escapeHtml(formatRunReviewClaim(run.review.claim))}</span>\` : ""}
          \${run.deployment ? \`<span>deployment \${escapeHtml(run.deployment.status)}</span>\` : ""}
          \${run.metadata && run.metadata.repo ? \`<span>\${escapeHtml(run.metadata.repo)}</span>\` : ""}
          \${run.metadata && run.metadata.branch ? \`<span>\${escapeHtml(run.metadata.branch)}</span>\` : ""}
          \${run.metadata && run.metadata.baseBranch ? \`<span>base \${escapeHtml(run.metadata.baseBranch)}</span>\` : ""}
          \${run.metadata && run.metadata.issueUrl ? \`<a href="\${escapeAttr(run.metadata.issueUrl)}" target="_blank" rel="noreferrer">Issue</a>\` : run.metadata && run.metadata.issue ? \`<span>\${escapeHtml(run.metadata.issue)}</span>\` : ""}
          \${run.metadata && run.metadata.pullRequestUrl ? \`<a href="\${escapeAttr(run.metadata.pullRequestUrl)}" target="_blank" rel="noreferrer">PR</a>\` : ""}
          \${renderHandoffSourceLinks(run.metadata)}
          \${renderProjectRunPolicyEvidence(run.metadata)}
          \${renderProjectContractEvidence(run.metadata)}
          <a href="\${escapeAttr(workbenchUrl(run))}" target="_blank" rel="noreferrer">Workbench</a>
        </div>
        \${runErrorSummary(run)}
      \`;
      renderRunControlPanel();
      renderReviewPanel();
      renderDeploymentPanel();
      renderReviewSummary();
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

    function renderRunControlPanel() {
      const run = state.selected;
      const cancellable = isCancellableRun(run);
      const resumable = Boolean(run && run.status === "paused");
      runControlPanel.hidden = !cancellable && !resumable;
      resumeRunButton.hidden = !resumable;
      resumeRunButton.disabled = !canMutate() || !resumable;
      cancelRunButton.hidden = !cancellable;
      cancelRunButton.disabled = !canMutate() || !cancellable;
      if (!cancellable) {
        abandonRunButton.hidden = true;
        if (!resumable) cancelError.textContent = "";
      }
    }

    function renderReviewPanel() {
      const run = state.selected;
      const pending = Boolean(run && run.status === "review_required" && run.review && run.review.status === "pending");
      reviewPanel.hidden = !pending;
      reviewClaimButton.disabled = !canMutate() || !pending;
      reviewReleaseClaimButton.disabled = !canMutate() || !pending || !(run && run.review && run.review.claim);
      reviewApproveButton.disabled = !canMutate() || !pending;
      reviewRejectButton.disabled = !canMutate() || !pending;
      reviewNoteInput.disabled = !canMutate() || !pending;
      reviewContractObjectiveInput.disabled = !canMutate() || !pending;
      reviewContractConstraintsInput.disabled = !canMutate() || !pending;
      reviewContractSuccessInput.disabled = !canMutate() || !pending;
      reviewMergeInput.disabled = !canMutate() || !(pending && run.metadata && run.metadata.pullRequestIndex);
      if (!pending) reviewError.textContent = "";
    }

    function renderDeploymentPanel() {
      const run = state.selected;
      const pending = Boolean(run && run.status === "deployment_required" && run.deployment && run.deployment.status === "pending");
      deploymentPanel.hidden = !pending;
      deploymentApproveButton.disabled = !canAdmin() || !pending;
      deploymentRejectButton.disabled = !canAdmin() || !pending;
      deploymentNoteInput.disabled = !canAdmin() || !pending;
      if (!pending) deploymentError.textContent = "";
    }

    function setReviewDisabled(disabled) {
      reviewClaimButton.disabled = disabled;
      reviewReleaseClaimButton.disabled = disabled;
      reviewApproveButton.disabled = disabled;
      reviewRejectButton.disabled = disabled;
      reviewNoteInput.disabled = disabled;
      reviewContractObjectiveInput.disabled = disabled;
      reviewContractConstraintsInput.disabled = disabled;
      reviewContractSuccessInput.disabled = disabled;
      reviewMergeInput.disabled = disabled || !(state.selected && state.selected.metadata && state.selected.metadata.pullRequestIndex);
    }

    function setDeploymentDisabled(disabled) {
      deploymentApproveButton.disabled = disabled;
      deploymentRejectButton.disabled = disabled;
      deploymentNoteInput.disabled = disabled;
    }

    function applyAccessControls() {
      createRunButton.disabled = !canMutate();
      createProjectButton.disabled = !canMutate();
      saveProjectSourceDefaultsButton.disabled = !canMutate();
      saveProjectDefaultSkillsButton.disabled = !canMutate();
      saveProjectRunPolicyButton.disabled = !canMutate();
      saveProjectContractButton.disabled = !canMutate();
      createVasCaseButton.disabled = !canMutate();
      claimVasCaseButton.disabled = !canMutate() || !vasCaseIdInput.value.trim();
      releaseVasCaseButton.disabled = !canMutate() || !vasCaseIdInput.value.trim();
      reviewVasCaseButton.disabled = !canMutate();
      startVasReviewRunButton.disabled = !canMutate() || !vasCaseIdInput.value.trim();
      vasReviewRunReviewerInput.readOnly = !canMutate() || !vasCaseIdInput.value.trim();
      loadVasReviewPackageButton.disabled = !vasCaseIdInput.value.trim();
      savePolicySettingsButton.disabled = !canAdmin();
      for (const input of policySettingsInputs()) {
        if ("readOnly" in input) input.readOnly = !canAdmin();
        if ("disabled" in input && input.tagName === "SELECT") input.disabled = !canAdmin();
      }
      for (const input of policyMemberInputs()) {
        if ("readOnly" in input) input.readOnly = !canAdmin();
        if ("disabled" in input && input.tagName === "SELECT") input.disabled = !canAdmin();
      }
      createPolicyKeyButton.disabled = !canAdmin();
      revokePolicyKeyButton.disabled = !canAdmin();
      for (const input of agentGitServiceProvisionInputs()) {
        if ("readOnly" in input) input.readOnly = !canAdmin();
        if ("disabled" in input && (input.tagName === "SELECT" || input.type === "checkbox")) input.disabled = !canAdmin();
      }
      provisionAgentGitServiceButton.disabled = !canAdmin();
      loadAgentGitServiceProvisioningPlanButton.disabled = !canAdmin();
      loadAgentGitServiceCutoverReadinessButton.disabled = !canAdmin();
      dryRunAgentGitServiceProvisioningPlanApplyButton.disabled = !canAdmin();
      applyAgentGitServiceProvisioningPlanButton.disabled = !canAdmin();
      agentGitServiceProvisioningPlanProjectsInput.readOnly = !canAdmin();
      requestEscalationButton.disabled = !state.tenantAccess;
      decideEscalationButton.disabled = !canAdmin();
      escalationDecisionInput.disabled = !canAdmin();
      escalationDecisionNoteInput.disabled = !canAdmin();
      workspaceFileContent.readOnly = !canMutate();
      workspaceCommitMessageInput.readOnly = !canMutate();
      commitWorkspaceButton.disabled = !canMutate();
      workspacePrIssueInput.readOnly = !canMutate();
      workspacePrBranchInput.readOnly = !canMutate();
      workspacePrBaseInput.readOnly = !canMutate();
      workspacePrReviewInput.disabled = !canMutate();
      workspacePrDeploymentInput.disabled = !canMutate();
      handoffPrButton.disabled = !canMutate();
      workspacePrEscalationButton.disabled = !state.tenantAccess;
      resumeRunButton.disabled = !canMutate() || !state.selected || state.selected.status !== "paused";
      runCommentPauseInput.disabled = !state.selected || !state.tenantAccess;
      sendRunCommentButton.disabled = !state.selected || !state.tenantAccess;
      syncIssueCommentsButton.disabled = !state.selected || !state.tenantAccess || !state.selected.metadata || !state.selected.metadata.issue;
      loadHandoffFollowupsButton.disabled = !state.selected;
      startHandoffFollowupButton.disabled = !canMutate() || !state.selected;
      newFileButton.disabled = !canMutate();
      saveFileButton.disabled = !canMutate() || !state.workspaceFile;
      moveFileButton.disabled = !canMutate() || !state.workspaceFile || !state.workspaceFile.updatedAt;
      deleteFileButton.disabled = !canMutate() || !state.workspaceFile || !state.workspaceFile.updatedAt;
      reloadFileButton.disabled = !state.workspaceFile || !state.workspaceFile.updatedAt;
      runCommandButton.disabled = !canMutate();
      setTerminalControls(isSelectedWorkspaceSessionRunning());
      renderRunControlPanel();
      renderReviewPanel();
      renderDeploymentPanel();
    }

    function renderEvents() {
      if (!state.events.length) {
        eventLog.innerHTML = '<div class="empty">No events yet.</div>';
        return;
      }
      eventLog.innerHTML = state.events.map((event) => \`
        <article class="event">
          <div class="event-head">
            <span>#\${event.seq} \${escapeHtml(event.type)}</span>
            <span>\${escapeHtml(event.ts)}</span>
          </div>
          <pre>\${escapeHtml(JSON.stringify(event.data, null, 2))}</pre>
        </article>
      \`).join("");
    }

    function renderReplay() {
      loadReplayButton.disabled = !state.selected;
      const replay = state.replay;
      if (!state.selected) {
        runReplay.innerHTML = '<div class="empty">Select or create a run.</div>';
        return;
      }
      if (!replay || !Array.isArray(replay.timeline)) {
        runReplay.innerHTML = '<div class="empty">No replay loaded.</div>';
        return;
      }
      const replayEvidence = [
        replay.checkpoint ? \`<span>checkpoint \${escapeHtml(formatCheckpointVersion(replay.checkpoint))}</span>\` : "",
        renderEvidenceRefresh("replay")
      ].filter(Boolean).join("");
      const replayMeta = replayEvidence ? \`<div class="summary-grid">\${replayEvidence}</div>\` : "";
      if (!replay.timeline.length) {
        runReplay.innerHTML = replayMeta + '<div class="empty">Replay has no timeline entries.</div>';
        return;
      }
      runReplay.innerHTML = replayMeta + replay.timeline.map((entry) => \`
        <article class="event">
          <div class="event-head">
            <span>#\${escapeHtml(entry.seq)} \${escapeHtml(entry.title || entry.type)}</span>
            <span>\${escapeHtml(replayEntryMeta(entry))}</span>
          </div>
          <pre>\${escapeHtml(replayEntryDetail(entry))}</pre>
        </article>
      \`).join("");
    }

    function renderReviewSummary() {
      loadReviewSummaryButton.disabled = !state.selected;
      const data = state.reviewSummary;
      if (!state.selected) {
        reviewSummary.innerHTML = '<div class="empty">Select or create a run.</div>';
        return;
      }
      if (!data) {
        reviewSummary.innerHTML = '<div class="empty">No review summary loaded.</div>';
        return;
      }
      reviewSummary.innerHTML = \`
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
          \${renderProjectContractEvidence(data)}
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

    function renderHandoffPackage() {
      loadHandoffPackageButton.disabled = !state.selected;
      const data = state.handoffPackage;
      if (!state.selected) {
        handoffPackage.innerHTML = '<div class="empty">Select or create a run.</div>';
        return;
      }
      if (!data) {
        handoffPackage.innerHTML = '<div class="empty">No handoff package loaded.</div>';
        return;
      }
      const handoff = data.handoff || {};
      const links = data.links || {};
      handoffPackage.innerHTML = \`
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
          \${renderProjectContractEvidence(data.reviewSummary)}
          \${data.checkpoint ? \`<span>checkpoint \${escapeHtml(formatCheckpointVersion(data.checkpoint))}</span>\` : ""}
          \${renderEvidenceRefresh("handoffPackage")}
        </div>
        \${renderHandoffFollowupRuns(data.followupRuns)}
        <pre>\${escapeHtml(formatHandoffPackage(data))}</pre>
      \`;
    }

    function renderHandoffFollowups(data = state.handoffFollowups) {
      loadHandoffFollowupsButton.disabled = !state.selected;
      if (!state.selected) {
        handoffFollowups.innerHTML = '<div class="empty">Select or create a run.</div>';
        return;
      }
      if (!data) {
        handoffFollowups.innerHTML = '<div class="empty">No follow-up lineage loaded.</div>';
        return;
      }
      const source = data.source || {};
      const sourceLinks = source.links || {};
      handoffFollowups.innerHTML = \`
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

    function renderHandoffFollowupRuns(runs) {
      if (!Array.isArray(runs) || !runs.length) return "";
      return \`<div data-testid="handoff-followup-runs" class="event-log">\${runs.map(renderHandoffFollowupRun).join("")}</div>\`;
    }

    function renderHandoffFollowupRun(run) {
      const links = run.links || {};
      const controlPlaneProvider = run.controlPlaneProvider || "";
      const commentId = run.controlPlaneCommentId || run.giteaCommentId || "";
      const commentUrl = run.controlPlaneCommentUrl || run.giteaCommentUrl || "";
      return \`
        <article class="event">
          <div class="event-head">
            <span>\${escapeHtml(run.runId || "follow-up run")}</span>
            <span>\${escapeHtml(run.createdAt || "")}</span>
          </div>
          <div class="summary-grid">
            \${run.status ? \`<span class="pill \${escapeAttr(run.status)}">\${escapeHtml(run.status)}</span>\` : ""}
            \${run.goal ? \`<span>\${escapeHtml(run.goal)}</span>\` : ""}
            \${run.actor ? \`<span>actor \${escapeHtml(run.actor)}</span>\` : ""}
            \${run.role ? \`<span>role \${escapeHtml(run.role)}</span>\` : ""}
            \${run.clientId ? \`<span>client \${escapeHtml(run.clientId)}</span>\` : ""}
            \${controlPlaneProvider ? \`<span>control \${escapeHtml(controlPlaneProvider)}</span>\` : ""}
            \${commentId ? \`<span>comment \${escapeHtml(commentId)}</span>\` : ""}
            \${commentUrl ? \`<a href="\${escapeAttr(commentUrl)}" target="_blank" rel="noreferrer">Issue Comment</a>\` : ""}
            \${links.workbench ? \`<a href="\${escapeAttr(links.workbench)}" target="_blank" rel="noreferrer">Workbench</a>\` : ""}
            \${links.handoffPackage ? \`<a href="\${escapeAttr(links.handoffPackage)}" target="_blank" rel="noreferrer">Package</a>\` : ""}
          </div>
        </article>
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
        entry.actionCount !== undefined ? "actions=" + entry.actionCount : "",
        entry.finishRequested !== undefined ? "finishRequested=" + entry.finishRequested : "",
        entry.phase ? "phase=" + entry.phase : "",
        entry.runReviewContractPatch ? "contractPatch:\\n" + formatProjectContract(entry.runReviewContractPatch) : "",
        entry.contractPatch ? "contractPatch:\\n" + formatProjectContract(entry.contractPatch) : ""
      ].filter(Boolean).join("\\n") || entry.type;
    }

    function lines(value) {
      return value.split("\\n").map((line) => line.trim()).filter(Boolean);
    }

    function nullableLines(value) {
      const entries = lines(value);
      return entries.length ? entries : null;
    }

    function optionalValue(input) {
      return input.value.trim() || undefined;
    }

    function escalationLimits() {
      const limits = {};
      const maxWorkspaceSessions = optionalPositiveInteger(escalationMaxWorkspaceSessionsInput);
      const maxActiveRuns = optionalPositiveInteger(escalationMaxActiveRunsInput);
      const maxWorkspaceBytes = optionalPositiveInteger(escalationMaxWorkspaceBytesInput);
      const workspaceByteWarning = optionalPositiveInteger(escalationWorkspaceByteWarningInput);
      const modelProjectTotalTokenWarning = optionalPositiveInteger(escalationModelProjectTokenWarningInput);
      const modelRequesterTotalTokenWarning = optionalPositiveInteger(escalationModelRequesterTokenWarningInput);
      const modelProjectTotalTokenLimit = optionalPositiveInteger(escalationModelProjectTokenLimitInput);
      const modelRequesterTotalTokenLimit = optionalPositiveInteger(escalationModelRequesterTokenLimitInput);
      const modelProjectCostUsdWarning = optionalPositiveNumber(escalationModelProjectCostWarningInput);
      const modelRequesterCostUsdWarning = optionalPositiveNumber(escalationModelRequesterCostWarningInput);
      const modelProjectCostUsdLimit = optionalPositiveNumber(escalationModelProjectCostLimitInput);
      const modelRequesterCostUsdLimit = optionalPositiveNumber(escalationModelRequesterCostLimitInput);
      if (maxWorkspaceSessions !== undefined) limits.maxWorkspaceSessions = maxWorkspaceSessions;
      if (maxActiveRuns !== undefined) limits.maxActiveRuns = maxActiveRuns;
      if (maxWorkspaceBytes !== undefined) limits.maxWorkspaceBytes = maxWorkspaceBytes;
      if (workspaceByteWarning !== undefined) limits.workspaceByteWarning = workspaceByteWarning;
      if (modelProjectTotalTokenWarning !== undefined) limits.modelProjectTotalTokenWarning = modelProjectTotalTokenWarning;
      if (modelRequesterTotalTokenWarning !== undefined) limits.modelRequesterTotalTokenWarning = modelRequesterTotalTokenWarning;
      if (modelProjectTotalTokenLimit !== undefined) limits.modelProjectTotalTokenLimit = modelProjectTotalTokenLimit;
      if (modelRequesterTotalTokenLimit !== undefined) limits.modelRequesterTotalTokenLimit = modelRequesterTotalTokenLimit;
      if (modelProjectCostUsdWarning !== undefined) limits.modelProjectCostUsdWarning = modelProjectCostUsdWarning;
      if (modelRequesterCostUsdWarning !== undefined) limits.modelRequesterCostUsdWarning = modelRequesterCostUsdWarning;
      if (modelProjectCostUsdLimit !== undefined) limits.modelProjectCostUsdLimit = modelProjectCostUsdLimit;
      if (modelRequesterCostUsdLimit !== undefined) limits.modelRequesterCostUsdLimit = modelRequesterCostUsdLimit;
      return Object.keys(limits).length ? limits : undefined;
    }

    function policySettingsLimits() {
      const limits = {};
      const maxActiveRuns = optionalPositiveInteger(policyMaxActiveRunsInput);
      const maxWorkspaceSessions = optionalPositiveInteger(policyMaxWorkspaceSessionsInput);
      const maxWorkspaceBytes = optionalPositiveInteger(policyMaxWorkspaceBytesInput);
      const workspaceByteWarning = optionalPositiveInteger(policyWorkspaceByteWarningInput);
      const executorCpus = optionalPositiveNumber(policyExecutorCpusInput);
      const executorMemory = optionalValue(policyExecutorMemoryInput);
      const executorPidsLimit = optionalPositiveInteger(policyExecutorPidsLimitInput);
      const executorNetwork = optionalValue(policyExecutorNetworkInput);
      const modelProjectTotalTokenWarning = optionalPositiveInteger(policyModelProjectTokenWarningInput);
      const modelRequesterTotalTokenWarning = optionalPositiveInteger(policyModelRequesterTokenWarningInput);
      const modelProjectTotalTokenLimit = optionalPositiveInteger(policyModelProjectTokenLimitInput);
      const modelRequesterTotalTokenLimit = optionalPositiveInteger(policyModelRequesterTokenLimitInput);
      const modelProjectCostUsdWarning = optionalPositiveNumber(policyModelProjectCostWarningInput);
      const modelRequesterCostUsdWarning = optionalPositiveNumber(policyModelRequesterCostWarningInput);
      const modelProjectCostUsdLimit = optionalPositiveNumber(policyModelProjectCostLimitInput);
      const modelRequesterCostUsdLimit = optionalPositiveNumber(policyModelRequesterCostLimitInput);
      if (maxActiveRuns !== undefined) limits.maxActiveRuns = maxActiveRuns;
      if (maxWorkspaceSessions !== undefined) limits.maxWorkspaceSessions = maxWorkspaceSessions;
      if (maxWorkspaceBytes !== undefined) limits.maxWorkspaceBytes = maxWorkspaceBytes;
      if (workspaceByteWarning !== undefined) limits.workspaceByteWarning = workspaceByteWarning;
      if (executorCpus !== undefined) limits.executorCpus = executorCpus;
      if (executorMemory !== undefined) limits.executorMemory = executorMemory;
      if (executorPidsLimit !== undefined) limits.executorPidsLimit = executorPidsLimit;
      if (executorNetwork !== undefined) limits.executorNetwork = executorNetwork;
      if (modelProjectTotalTokenWarning !== undefined) limits.modelProjectTotalTokenWarning = modelProjectTotalTokenWarning;
      if (modelRequesterTotalTokenWarning !== undefined) limits.modelRequesterTotalTokenWarning = modelRequesterTotalTokenWarning;
      if (modelProjectTotalTokenLimit !== undefined) limits.modelProjectTotalTokenLimit = modelProjectTotalTokenLimit;
      if (modelRequesterTotalTokenLimit !== undefined) limits.modelRequesterTotalTokenLimit = modelRequesterTotalTokenLimit;
      if (modelProjectCostUsdWarning !== undefined) limits.modelProjectCostUsdWarning = modelProjectCostUsdWarning;
      if (modelRequesterCostUsdWarning !== undefined) limits.modelRequesterCostUsdWarning = modelRequesterCostUsdWarning;
      if (modelProjectCostUsdLimit !== undefined) limits.modelProjectCostUsdLimit = modelProjectCostUsdLimit;
      if (modelRequesterCostUsdLimit !== undefined) limits.modelRequesterCostUsdLimit = modelRequesterCostUsdLimit;
      return limits;
    }

    function populateTenantPolicySettings(policy) {
      if (!policy || policy.error) return;
      const limits = policy.limits || {};
      policyModelKeyEnvInput.value = policy.modelKeyEnv || "";
      policyTemplateParametersInput.value = Array.isArray(policy.executorTemplateParameters) ? policy.executorTemplateParameters.join("\\n") : "";
      policyAllowedToolsInput.value = Array.isArray(policy.allowedTools) ? policy.allowedTools.join("\\n") : "";
      policyMaxActiveRunsInput.value = limits.maxActiveRuns || "";
      policyMaxWorkspaceSessionsInput.value = limits.maxWorkspaceSessions || "";
      policyMaxWorkspaceBytesInput.value = limits.maxWorkspaceBytes || "";
      policyWorkspaceByteWarningInput.value = limits.workspaceByteWarning || "";
      policyExecutorCpusInput.value = limits.executorCpus || "";
      policyExecutorMemoryInput.value = limits.executorMemory || "";
      policyExecutorPidsLimitInput.value = limits.executorPidsLimit || "";
      policyExecutorNetworkInput.value = limits.executorNetwork || "";
      policyModelProjectTokenWarningInput.value = limits.modelProjectTotalTokenWarning || "";
      policyModelRequesterTokenWarningInput.value = limits.modelRequesterTotalTokenWarning || "";
      policyModelProjectTokenLimitInput.value = limits.modelProjectTotalTokenLimit || "";
      policyModelRequesterTokenLimitInput.value = limits.modelRequesterTotalTokenLimit || "";
      policyModelProjectCostWarningInput.value = limits.modelProjectCostUsdWarning || "";
      policyModelRequesterCostWarningInput.value = limits.modelRequesterCostUsdWarning || "";
      policyModelProjectCostLimitInput.value = limits.modelProjectCostUsdLimit || "";
      policyModelRequesterCostLimitInput.value = limits.modelRequesterCostUsdLimit || "";
    }

    function policySettingsInputs() {
      return [
        policyModelKeyEnvInput,
        policyTemplateParametersInput,
        policyAllowedToolsInput,
        policyMaxActiveRunsInput,
        policyMaxWorkspaceSessionsInput,
        policyMaxWorkspaceBytesInput,
        policyWorkspaceByteWarningInput,
        policyExecutorCpusInput,
        policyExecutorMemoryInput,
        policyExecutorPidsLimitInput,
        policyExecutorNetworkInput,
        policyModelProjectTokenWarningInput,
        policyModelRequesterTokenWarningInput,
        policyModelProjectTokenLimitInput,
        policyModelRequesterTokenLimitInput,
        policyModelProjectCostWarningInput,
        policyModelRequesterCostWarningInput,
        policyModelProjectCostLimitInput,
        policyModelRequesterCostLimitInput
      ];
    }

    function policyMemberInputs() {
      return [
        policyKeyActorInput,
        policyKeyRoleInput,
        policyKeyModelEnvInput,
        policyKeyTokenInput
      ];
    }

    function agentGitServiceProvisionInputs() {
      return [
        agentGitServiceProvisionRepoInput,
        agentGitServiceProvisionPermissionInput,
        agentGitServiceProvisionTokenEnvInput,
        agentGitServiceProvisionPrefixInput,
        agentGitServiceProvisionDefaultRepoInput,
        agentGitServiceProvisionIdentityActorInput,
        agentGitServiceProvisionIdentityRoleInput,
        agentGitServiceProvisionForceInput
      ];
    }

    function optionalPositiveInteger(input) {
      const value = input.value.trim();
      if (!value) return undefined;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(\`\${input.name || input.id} must be a positive integer\`);
      return parsed;
    }

    function optionalPositiveNumber(input) {
      const value = input.value.trim();
      if (!value) return undefined;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(\`\${input.name || input.id} must be a positive number\`);
      return parsed;
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

    function formatMs(ms) {
      if (ms >= 60000) return Math.round(ms / 60000) + " min";
      if (ms >= 1000) return Math.round(ms / 1000) + " s";
      return ms + " ms";
    }

    function formatCommandResult(result) {
      return [
        "$ " + result.command,
        "exitCode=" + result.exitCode,
        result.stdout ? "stdout:\\n" + result.stdout : "",
        result.stderr ? "stderr:\\n" + result.stderr : ""
      ].filter(Boolean).join("\\n");
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
