export const OPERATOR_COCKPIT_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Loom Operator Cockpit</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f8;
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
    h1 { margin: 0; font-size: 18px; line-height: 1.2; }
    main {
      display: grid;
      grid-template-columns: minmax(260px, 340px) minmax(320px, 1fr) minmax(320px, 460px);
      min-height: calc(100vh - 58px);
      gap: 1px;
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
    input, select {
      width: 100%;
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      color: var(--text);
      background: #fff;
      font: inherit;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 36px;
      border: 1px solid var(--accent);
      border-radius: 6px;
      padding: 0 12px;
      background: var(--accent);
      color: #fff;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button.secondary { background: var(--surface); color: var(--accent); }
    button.danger { border-color: var(--bad); background: var(--bad); }
    button:disabled { cursor: not-allowed; opacity: .62; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .check-row {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      color: var(--muted);
    }
    .check-row input { width: auto; min-height: auto; }
    .summary, .panel, pre {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #fbfcfd;
    }
    .summary, .panel { padding: 12px; margin-bottom: 12px; }
    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
      font-size: 13px;
      font-weight: 800;
    }
    .meta {
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
    .pill.ok { color: var(--ok); }
    .pill.warn { color: var(--warn); }
    .pill.bad { color: var(--bad); }
    .input-list { display: grid; gap: 10px; }
    .input-item {
      display: grid;
      gap: 8px;
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }
    .input-item:first-child { border-top: 0; padding-top: 0; }
    .target-input-form {
      display: grid;
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
    }
    .kv {
      display: grid;
      grid-template-columns: 88px minmax(0, 1fr);
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .kv strong { color: var(--text); font-weight: 750; }
    .copy-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 8px;
    }
    .copy-row button { min-height: 30px; padding: 0 10px; font-size: 12px; }
    pre {
      min-height: 150px;
      max-height: 360px;
      margin: 0;
      padding: 10px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: #111820;
      color: #eef6f4;
    }
    pre.compact-pre { min-height: auto; max-height: 150px; margin-top: 8px; }
    .error { min-height: 18px; margin-top: 10px; color: var(--bad); font-weight: 700; }
    @media (max-width: 980px) {
      main { grid-template-columns: 1fr; }
      section { min-height: auto; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Loom Operator Cockpit</h1>
    <div class="meta"><span id="operator-cockpit-connection" class="pill">idle</span></div>
  </header>
  <main>
    <section>
      <h2>Connection</h2>
      <label for="operator-cockpit-tenant">Tenant</label>
      <input id="operator-cockpit-tenant" data-testid="operator-cockpit-tenant" autocomplete="off" />
      <label for="operator-cockpit-token">API token</label>
      <input id="operator-cockpit-token" data-testid="operator-cockpit-token" type="password" autocomplete="off" />
      <label for="operator-cockpit-client-id">Client ID</label>
      <input id="operator-cockpit-client-id" data-testid="operator-cockpit-client-id" autocomplete="off" />
      <label for="operator-cockpit-repo">GitHub repo</label>
      <input id="operator-cockpit-repo" data-testid="operator-cockpit-repo" autocomplete="off" />
      <label for="operator-cockpit-ref">GitHub ref</label>
      <input id="operator-cockpit-ref" data-testid="operator-cockpit-ref" autocomplete="off" />
      <label for="operator-cockpit-artifact-dir">CI artifact dir</label>
      <input id="operator-cockpit-artifact-dir" data-testid="operator-cockpit-artifact-dir" autocomplete="off" />
      <label for="operator-cockpit-artifact-phase">CI artifact phase</label>
      <select id="operator-cockpit-artifact-phase" data-testid="operator-cockpit-artifact-phase">
        <option value="pre-serve">pre-serve</option>
        <option value="post-serve">post-serve</option>
        <option value="all">all</option>
      </select>
      <label for="operator-cockpit-artifact-run-id">CI run ID</label>
      <input id="operator-cockpit-artifact-run-id" data-testid="operator-cockpit-artifact-run-id" autocomplete="off" />
      <label for="operator-cockpit-max-steps">Max steps</label>
      <input id="operator-cockpit-max-steps" data-testid="operator-cockpit-max-steps" type="number" min="1" max="20" step="1" />
      <label class="check-row">
        <input id="operator-cockpit-require-external" type="checkbox" checked />
        External staging
      </label>
      <label class="check-row">
        <input id="operator-cockpit-require-approvals" type="checkbox" checked />
        Operator approvals
      </label>
      <label class="check-row">
        <input id="operator-cockpit-require-ags" type="checkbox" checked />
        Agent Git Service
      </label>
      <div class="actions">
        <button id="operator-cockpit-refresh" data-testid="operator-cockpit-refresh">Refresh</button>
        <button id="operator-cockpit-save-ci-target" data-testid="operator-cockpit-save-ci-target" class="secondary">Save CI target</button>
        <button id="operator-cockpit-seed-target-template" data-testid="operator-cockpit-seed-target-template" class="secondary">Seed target template</button>
        <button id="operator-cockpit-export-handoff" data-testid="operator-cockpit-export-handoff" class="secondary">Export handoff</button>
        <button id="operator-cockpit-export-approvals" data-testid="operator-cockpit-export-approvals" class="secondary">Export approvals</button>
        <button id="operator-cockpit-sync-ags-evidence" data-testid="operator-cockpit-sync-ags-evidence" class="secondary">Sync AGS evidence</button>
        <button id="operator-cockpit-import-ags-evidence" data-testid="operator-cockpit-import-ags-evidence" class="secondary">Import AGS evidence</button>
        <button id="operator-cockpit-import-ci-artifact" data-testid="operator-cockpit-import-ci-artifact" class="secondary">Import CI artifact</button>
        <button id="operator-cockpit-execute" data-testid="operator-cockpit-execute" class="danger" disabled>Execute</button>
      </div>
      <label class="check-row">
        <input id="operator-cockpit-confirm" data-testid="operator-cockpit-confirm" type="checkbox" />
        Confirm current command
      </label>
      <div id="operator-cockpit-error" class="error"></div>
    </section>
    <section>
      <h2>Current Action</h2>
      <div id="operator-cockpit-summary" class="summary">No report loaded.</div>
      <div id="operator-cockpit-execution-status" class="panel" data-testid="operator-cockpit-execution-status"></div>
      <div id="operator-cockpit-agent-git-service" class="panel" data-testid="operator-cockpit-agent-git-service"></div>
      <div id="operator-cockpit-blocking-groups" class="panel" data-testid="operator-cockpit-blocking-groups"></div>
      <div id="operator-cockpit-inputs" class="panel" data-testid="operator-cockpit-input-checklist"></div>
      <div id="operator-cockpit-command" class="panel"></div>
    </section>
    <section>
      <h2>Report</h2>
      <pre id="operator-cockpit-report">{}</pre>
    </section>
  </main>
  <script>
    const params = new URLSearchParams(window.location.search);
    const tenantInput = document.getElementById("operator-cockpit-tenant");
    const tokenInput = document.getElementById("operator-cockpit-token");
    const clientIdInput = document.getElementById("operator-cockpit-client-id");
    const repoInput = document.getElementById("operator-cockpit-repo");
    const refInput = document.getElementById("operator-cockpit-ref");
    const artifactDirInput = document.getElementById("operator-cockpit-artifact-dir");
    const artifactPhaseInput = document.getElementById("operator-cockpit-artifact-phase");
    const artifactRunIdInput = document.getElementById("operator-cockpit-artifact-run-id");
    const maxStepsInput = document.getElementById("operator-cockpit-max-steps");
    const requireExternalInput = document.getElementById("operator-cockpit-require-external");
    const requireApprovalsInput = document.getElementById("operator-cockpit-require-approvals");
    const requireAgsInput = document.getElementById("operator-cockpit-require-ags");
    const refreshButton = document.getElementById("operator-cockpit-refresh");
    const saveCiTargetButton = document.getElementById("operator-cockpit-save-ci-target");
    const seedTargetTemplateButton = document.getElementById("operator-cockpit-seed-target-template");
    const exportHandoffButton = document.getElementById("operator-cockpit-export-handoff");
    const exportApprovalsButton = document.getElementById("operator-cockpit-export-approvals");
    const syncAgsEvidenceButton = document.getElementById("operator-cockpit-sync-ags-evidence");
    const importAgsEvidenceButton = document.getElementById("operator-cockpit-import-ags-evidence");
    const importCiArtifactButton = document.getElementById("operator-cockpit-import-ci-artifact");
    const executeButton = document.getElementById("operator-cockpit-execute");
    const confirmInput = document.getElementById("operator-cockpit-confirm");
    const connection = document.getElementById("operator-cockpit-connection");
    const errorBox = document.getElementById("operator-cockpit-error");
    const summary = document.getElementById("operator-cockpit-summary");
    const executionStatus = document.getElementById("operator-cockpit-execution-status");
    const agentGitService = document.getElementById("operator-cockpit-agent-git-service");
    const blockingGroups = document.getElementById("operator-cockpit-blocking-groups");
    const inputs = document.getElementById("operator-cockpit-inputs");
    const command = document.getElementById("operator-cockpit-command");
    const report = document.getElementById("operator-cockpit-report");
    let state = { report: undefined };
    let artifactPhaseDirty = Boolean(params.get("artifactPhase"));

    tenantInput.value = params.get("tenant") || "alice";
    tokenInput.value = params.get("token") || "";
    clientIdInput.value = params.get("clientId") || "operator-cockpit";
    repoInput.value = params.get("repo") || "";
    refInput.value = params.get("ref") || "";
    artifactDirInput.value = params.get("artifactDir") || "";
    artifactPhaseInput.value = params.get("artifactPhase") || operatorCockpitDefaultArtifactPhase({});
    artifactRunIdInput.value = params.get("runId") || "";
    maxStepsInput.value = params.get("maxSteps") || "1";
    scrubTokenFromBrowserUrl();

    function scrubTokenFromBrowserUrl() {
      if (!params.has("token")) return;
      params.delete("token");
      const next = params.toString();
      const url = next ? window.location.pathname + "?" + next : window.location.pathname;
      window.history.replaceState({}, "", url);
    }

    function operatorCockpitEndpoint() {
      const tenant = tenantInput.value.trim();
      if (!tenant) throw new Error("Tenant is required.");
      return \`/tenants/\${encodeURIComponent(tenant)}/operator/cockpit-loop\`;
    }

    function operatorCockpitExecutionStatusEndpoint() {
      const tenant = tenantInput.value.trim();
      if (!tenant) throw new Error("Tenant is required.");
      return \`/tenants/\${encodeURIComponent(tenant)}/operator/cockpit-execution-status\`;
    }

    function operatorCockpitHandoffPacketEndpoint() {
      const tenant = tenantInput.value.trim();
      if (!tenant) throw new Error("Tenant is required.");
      return \`/tenants/\${encodeURIComponent(tenant)}/operator/handoff-packet\`;
    }

    function operatorCockpitApprovalsEndpoint() {
      const tenant = tenantInput.value.trim();
      if (!tenant) throw new Error("Tenant is required.");
      return \`/tenants/\${encodeURIComponent(tenant)}/operator/approvals\`;
    }

    function operatorCockpitTargetInputEndpoint() {
      const tenant = tenantInput.value.trim();
      if (!tenant) throw new Error("Tenant is required.");
      return \`/tenants/\${encodeURIComponent(tenant)}/operator/real-staging-target-input\`;
    }

    function operatorCockpitRealStagingTargetsApplyEndpoint() {
      const tenant = tenantInput.value.trim();
      if (!tenant) throw new Error("Tenant is required.");
      return \`/tenants/\${encodeURIComponent(tenant)}/operator/real-staging-targets-apply\`;
    }

    function operatorCockpitBundleRefreshEndpoint() {
      const tenant = tenantInput.value.trim();
      if (!tenant) throw new Error("Tenant is required.");
      return \`/tenants/\${encodeURIComponent(tenant)}/operator/bundle-refresh\`;
    }

    function operatorCockpitTargetInputTemplateEndpoint() {
      const tenant = tenantInput.value.trim();
      if (!tenant) throw new Error("Tenant is required.");
      return \`/tenants/\${encodeURIComponent(tenant)}/operator/target-input-template\`;
    }

    function operatorCockpitGithubTargetInputEndpoint() {
      const tenant = tenantInput.value.trim();
      if (!tenant) throw new Error("Tenant is required.");
      return \`/tenants/\${encodeURIComponent(tenant)}/operator/github-actions-target-input\`;
    }

    function operatorCockpitCiArtifactImportEndpoint() {
      const tenant = tenantInput.value.trim();
      if (!tenant) throw new Error("Tenant is required.");
      return \`/tenants/\${encodeURIComponent(tenant)}/operator/ci-artifact-import\`;
    }

    function operatorCockpitAgsEvidenceSyncEndpoint() {
      const tenant = tenantInput.value.trim();
      if (!tenant) throw new Error("Tenant is required.");
      return \`/tenants/\${encodeURIComponent(tenant)}/operator/ags-evidence-sync\`;
    }

    function operatorCockpitAgsEvidenceImportEndpoint() {
      const tenant = tenantInput.value.trim();
      if (!tenant) throw new Error("Tenant is required.");
      return \`/tenants/\${encodeURIComponent(tenant)}/operator/ags-evidence-import\`;
    }

    function operatorCockpitTarget() {
      return {
        repo: repoInput.value.trim(),
        ref: refInput.value.trim(),
      };
    }

    function operatorCockpitMaxSteps() {
      const parsed = Number.parseInt(maxStepsInput.value || "1", 10);
      if (!Number.isFinite(parsed) || parsed < 1) return 1;
      return Math.min(parsed, 20);
    }

    function operatorCockpitQuery() {
      const query = new URLSearchParams();
      const target = operatorCockpitTarget();
      if (requireExternalInput.checked) query.set("requireExternalStaging", "1");
      if (requireApprovalsInput.checked) query.set("requireOperatorApprovals", "1");
      if (requireAgsInput.checked) query.set("requireAgentGitService", "1");
      if (target.repo) query.set("repo", target.repo);
      if (target.ref) query.set("ref", target.ref);
      const value = query.toString();
      return value ? "?" + value : "";
    }

    function operatorCockpitHandoffPacketQuery() {
      const query = new URLSearchParams(operatorCockpitQuery().replace(/^\\?/, ""));
      const clientId = clientIdInput.value.trim();
      if (clientId) query.set("clientId", clientId);
      const value = query.toString();
      return value ? "?" + value : "";
    }

    function operatorCockpitApprovalsQuery() {
      const query = new URLSearchParams();
      const clientId = clientIdInput.value.trim();
      if (clientId) query.set("clientId", clientId);
      const value = query.toString();
      return value ? "?" + value : "";
    }

    function authHeaders(json = false) {
      const headers = {};
      const token = tokenInput.value.trim();
      if (token) headers.Authorization = \`Bearer \${token}\`;
      if (json) headers["content-type"] = "application/json";
      return headers;
    }

    async function readJsonResponse(response) {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || \`HTTP \${response.status}\`);
      return data;
    }

    async function refreshCockpit() {
      setBusy(true, "refreshing");
      try {
        const response = await fetch(operatorCockpitEndpoint() + operatorCockpitQuery(), {
          headers: authHeaders(),
        });
        renderReport(await readJsonResponse(response));
        await refreshExecutionStatus();
        errorBox.textContent = "";
        connection.textContent = "loaded";
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
        connection.textContent = "error";
      } finally {
        setBusy(false);
      }
    }

    async function refreshExecutionStatus() {
      const response = await fetch(operatorCockpitExecutionStatusEndpoint(), {
        headers: authHeaders(),
      });
      const data = await readJsonResponse(response);
      renderExecutionStatus(data);
      return data;
    }

    async function exportHandoffPacket() {
      setBusy(true, "exporting handoff");
      try {
        const response = await fetch(operatorCockpitHandoffPacketEndpoint() + operatorCockpitHandoffPacketQuery(), {
          headers: authHeaders(),
        });
        const data = await readJsonResponse(response);
        renderReport(data);
        report.textContent = JSON.stringify(data, null, 2);
        errorBox.textContent = "";
        connection.textContent = "handoff exported";
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
        connection.textContent = "error";
      } finally {
        setBusy(false);
      }
    }

    async function exportOperatorApprovals() {
      setBusy(true, "exporting approvals");
      try {
        const response = await fetch(operatorCockpitApprovalsEndpoint() + operatorCockpitApprovalsQuery(), {
          headers: authHeaders(),
        });
        const data = await readJsonResponse(response);
        renderReport(data);
        report.textContent = JSON.stringify(data, null, 2);
        errorBox.textContent = "";
        connection.textContent = "approvals exported";
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
        connection.textContent = "error";
      } finally {
        setBusy(false);
      }
    }

    async function importCiArtifact() {
      setBusy(true, "importing artifact");
      try {
        const target = operatorCockpitTarget();
        const response = await fetch(operatorCockpitCiArtifactImportEndpoint(), {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({
            artifactDir: artifactDirInput.value.trim(),
            phase: artifactPhaseInput.value,
            runId: artifactRunIdInput.value.trim() || undefined,
            requireExternalStaging: requireExternalInput.checked,
            requireOperatorApprovals: requireApprovalsInput.checked,
            requireAgentGitService: requireAgsInput.checked,
            repo: target.repo || undefined,
            ref: target.ref || undefined,
            clientId: clientIdInput.value.trim() || undefined,
          }),
        });
        const data = await readJsonResponse(response);
        renderReport(data);
        errorBox.textContent = "";
        connection.textContent = "artifact imported";
        await refreshCockpit();
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
        connection.textContent = "error";
      } finally {
        setBusy(false);
      }
    }

    async function syncAgsEvidence() {
      setBusy(true, "syncing AGS evidence");
      try {
        const target = operatorCockpitTarget();
        const response = await fetch(operatorCockpitAgsEvidenceSyncEndpoint(), {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({
            phase: artifactPhaseInput.value,
            runId: artifactRunIdInput.value.trim() || undefined,
            requireExternalStaging: requireExternalInput.checked,
            requireOperatorApprovals: requireApprovalsInput.checked,
            requireAgentGitService: requireAgsInput.checked,
            repo: target.repo || undefined,
            ref: target.ref || undefined,
            clientId: clientIdInput.value.trim() || undefined,
          }),
        });
        const data = await readJsonResponse(response);
        renderReport(data);
        errorBox.textContent = "";
        connection.textContent = "AGS evidence synced";
        await refreshCockpit();
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
        connection.textContent = "error";
      } finally {
        setBusy(false);
      }
    }

    async function importAgsEvidence() {
      setBusy(true, "importing AGS evidence");
      try {
        const target = operatorCockpitTarget();
        const response = await fetch(operatorCockpitAgsEvidenceImportEndpoint(), {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({
            artifactDir: artifactDirInput.value.trim(),
            phase: artifactPhaseInput.value,
            runId: artifactRunIdInput.value.trim() || undefined,
            requireExternalStaging: requireExternalInput.checked,
            requireOperatorApprovals: requireApprovalsInput.checked,
            requireAgentGitService: requireAgsInput.checked,
            repo: target.repo || undefined,
            ref: target.ref || undefined,
            clientId: clientIdInput.value.trim() || undefined,
          }),
        });
        const data = await readJsonResponse(response);
        renderReport(data);
        errorBox.textContent = "";
        connection.textContent = "AGS evidence imported";
        await refreshCockpit();
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
        connection.textContent = "error";
      } finally {
        setBusy(false);
      }
    }

    async function executeCurrentCommand() {
      setBusy(true, "executing");
      try {
        const target = operatorCockpitTarget();
        const response = await fetch(operatorCockpitEndpoint(), {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({
            execute: true,
            confirm: "execute-current-cockpit-command",
            queue: true,
            requireExternalStaging: requireExternalInput.checked,
            requireOperatorApprovals: requireApprovalsInput.checked,
            requireAgentGitService: requireAgsInput.checked,
            repo: target.repo || undefined,
            ref: target.ref || undefined,
            maxSteps: operatorCockpitMaxSteps(),
            clientId: clientIdInput.value.trim() || undefined,
          }),
        });
        const data = await readJsonResponse(response);
        renderReport(data.refreshed || data);
        report.textContent = JSON.stringify(data, null, 2);
        confirmInput.checked = false;
        errorBox.textContent = "";
        connection.textContent = data.status === "queued" ? "queued" : "executed";
        await refreshExecutionStatus();
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
        connection.textContent = "error";
      } finally {
        setBusy(false);
      }
    }

    async function seedTargetInputTemplate() {
      setBusy(true, "seeding template");
      try {
        const target = operatorCockpitTarget();
        const response = await fetch(operatorCockpitTargetInputTemplateEndpoint(), {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({
            requireExternalStaging: requireExternalInput.checked,
            requireOperatorApprovals: requireApprovalsInput.checked,
            requireAgentGitService: requireAgsInput.checked,
            repo: target.repo || undefined,
            ref: target.ref || undefined,
            clientId: clientIdInput.value.trim() || undefined,
          }),
        });
        const data = await readJsonResponse(response);
        renderReport(data);
        errorBox.textContent = "";
        connection.textContent = "template seeded";
        await refreshCockpit();
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
        connection.textContent = "error";
      } finally {
        setBusy(false);
      }
    }

    async function saveTargetInput(form) {
      setBusy(true, "saving input");
      try {
        const response = await fetch(operatorCockpitTargetInputEndpoint(), {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify(targetInputBodyFromForm(form)),
        });
        const data = await readJsonResponse(response);
        clearTargetInputForm(form);
        renderReport(data);
        errorBox.textContent = "";
        connection.textContent = "input saved";
        await refreshCockpit();
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
        connection.textContent = "error";
      } finally {
        setBusy(false);
      }
    }

    async function applyTargetInput(form) {
      setBusy(true, "applying input");
      try {
        const saveResponse = await fetch(operatorCockpitTargetInputEndpoint(), {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify(targetInputBodyFromForm(form)),
        });
        const saved = await readJsonResponse(saveResponse);
        const target = operatorCockpitTarget();
        const response = await fetch(operatorCockpitRealStagingTargetsApplyEndpoint(), {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({
            expectedInputSha256: saved.inputSha256,
            autoRefreshBundle: true,
            requireExternalStaging: requireExternalInput.checked,
            requireOperatorApprovals: requireApprovalsInput.checked,
            requireAgentGitService: requireAgsInput.checked,
            repo: target.repo || undefined,
            ref: target.ref || undefined,
            clientId: clientIdInput.value.trim() || undefined,
          }),
        });
        const data = await readJsonResponse(response);
        clearTargetInputForm(form);
        renderReport(data);
        errorBox.textContent = "";
        connection.textContent = "input applied";
        await refreshCockpit();
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
        connection.textContent = "error";
      } finally {
        setBusy(false);
      }
    }

    async function refreshBundleFromTargetInput(form) {
      setBusy(true, "refreshing bundle");
      try {
        const target = operatorCockpitTarget();
        const response = await fetch(operatorCockpitBundleRefreshEndpoint(), {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({
            expectedApplyReportSha256: currentStagingTargetsApplySha256(),
            requireExternalStaging: requireExternalInput.checked,
            requireOperatorApprovals: requireApprovalsInput.checked,
            requireAgentGitService: requireAgsInput.checked,
            repo: target.repo || undefined,
            ref: target.ref || undefined,
            clientId: clientIdInput.value.trim() || undefined,
          }),
        });
        const data = await readJsonResponse(response);
        renderReport(data);
        errorBox.textContent = "";
        connection.textContent = "bundle refreshed";
        await refreshCockpit();
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
        connection.textContent = "error";
      } finally {
        setBusy(false);
      }
    }

    function targetInputBodyFromForm(form) {
      const targets = {};
      for (const input of form.querySelectorAll("[data-target-input-field]")) {
        targets[input.getAttribute("data-target-input-field")] = input.value.trim();
      }
      const target = operatorCockpitTarget();
      return {
        schemaVersion: "platform-staging-targets-input/v1",
        targets,
        expectedInputSha256: form.getAttribute("data-target-input-sha256") || undefined,
        requireExternalStaging: requireExternalInput.checked,
        requireOperatorApprovals: requireApprovalsInput.checked,
        requireAgentGitService: requireAgsInput.checked,
        repo: target.repo || undefined,
        ref: target.ref || undefined,
        clientId: clientIdInput.value.trim() || undefined,
      };
    }

    function clearTargetInputForm(form) {
      for (const input of form.querySelectorAll("[data-target-input-field]")) {
        input.value = "";
      }
    }

    function clearGithubTargetInputForm(form) {
      for (const input of form.querySelectorAll("[data-github-target-field]")) {
        input.value = "";
      }
    }

    async function saveGithubTargetInput(form) {
      setBusy(true, "saving CI target");
      try {
        const target = {};
        for (const input of form.querySelectorAll("[data-github-target-field]")) {
          target[input.getAttribute("data-github-target-field")] = input.value.trim();
        }
        const response = await fetch(operatorCockpitGithubTargetInputEndpoint(), {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({
            schemaVersion: "platform-ci-target-input/v1",
            repo: target.repo,
            ref: target.ref,
            expectedInputSha256: form.getAttribute("data-github-target-input-sha256") || undefined,
            requireExternalStaging: requireExternalInput.checked,
            requireOperatorApprovals: requireApprovalsInput.checked,
            requireAgentGitService: requireAgsInput.checked,
            clientId: clientIdInput.value.trim() || undefined,
          }),
        });
        const data = await readJsonResponse(response);
        if (data.githubTarget) {
          repoInput.value = data.githubTarget.repo || repoInput.value;
          refInput.value = data.githubTarget.ref || refInput.value;
        }
        clearGithubTargetInputForm(form);
        renderReport(data);
        errorBox.textContent = "";
        connection.textContent = "CI target saved";
        await refreshCockpit();
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
        connection.textContent = "error";
      } finally {
        setBusy(false);
      }
    }

    async function saveGithubTargetFromHeader() {
      setBusy(true, "saving CI target");
      try {
        const target = operatorCockpitTarget();
        const response = await fetch(operatorCockpitGithubTargetInputEndpoint(), {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({
            schemaVersion: "platform-ci-target-input/v1",
            repo: target.repo,
            ref: target.ref,
            expectedInputSha256: currentGithubTargetInputSha256(),
            requireExternalStaging: requireExternalInput.checked,
            requireOperatorApprovals: requireApprovalsInput.checked,
            requireAgentGitService: requireAgsInput.checked,
            clientId: clientIdInput.value.trim() || undefined,
          }),
        });
        const data = await readJsonResponse(response);
        if (data.githubTarget) {
          repoInput.value = data.githubTarget.repo || repoInput.value;
          refInput.value = data.githubTarget.ref || refInput.value;
        }
        renderReport(data);
        errorBox.textContent = "";
        connection.textContent = "CI target saved";
        await refreshCockpit();
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
        connection.textContent = "error";
      } finally {
        setBusy(false);
      }
    }

    function currentGithubTargetInputSha256() {
      const data = state.report || {};
      const status = (data.iterations && data.iterations.at(-1) && data.iterations.at(-1).status) || data.status || {};
      const preflightReport = status.ciHandoff && status.ciHandoff.preflight && status.ciHandoff.preflight.report;
      return preflightReport && preflightReport.targetInputSha256 ? String(preflightReport.targetInputSha256) : undefined;
    }

    function currentStagingTargetsApplySha256() {
      const data = state.report || {};
      const status = (data.iterations && data.iterations.at(-1) && data.iterations.at(-1).status) || data.status || {};
      const applyReport = status.reports && status.reports.stagingTargetsApply;
      return applyReport && applyReport.sha256 ? String(applyReport.sha256) : undefined;
    }

    function operatorCockpitDefaultArtifactPhase(data, status = {}, handoffPacket) {
      const final = data.final || {};
      const phase = status.phase || handoffPacket?.phase || final.phase || data.phase || "";
      if (phase === "prepare-pre-serve" || phase === "pre-serve") return "pre-serve";
      if (phase === "ready-for-serve" || phase === "run-post-serve-proof" || phase === "production-cutover-ready" || phase === "post-serve") return "post-serve";
      return "pre-serve";
    }

    function syncArtifactPhaseFromStatus(data, status, handoffPacket) {
      if (artifactPhaseDirty) return;
      artifactPhaseInput.value = operatorCockpitDefaultArtifactPhase(data, status, handoffPacket);
    }

    function renderReport(data) {
      state.report = data;
      const handoffPacket = data.schemaVersion === "platform-operator-handoff-packet/v1" ? data : undefined;
      const operatorApprovals = data.schemaVersion === "platform-operator-approvals/v1" ? data : undefined;
      const final = data.final || {};
      const runner = (data.iterations && data.iterations.at(-1) && data.iterations.at(-1).runner) || data.execution || data.cockpit || handoffPacket?.cockpit || {};
      const status = (data.iterations && data.iterations.at(-1) && data.iterations.at(-1).status) || data.status || {};
      syncArtifactPhaseFromStatus(data, status, handoffPacket);
      const commandDefaultCwd = operatorCockpitCommandDefaultCwd(data, status, handoffPacket);
      const ciHandoff = status.ciHandoff || (handoffPacket
        ? {
            githubTarget: handoffPacket.githubActions && handoffPacket.githubActions.target,
            ready: handoffPacket.githubActions && handoffPacket.githubActions.ready,
          }
        : undefined);
      summary.innerHTML = [
        pill(operatorApprovals ? "operator approvals" : final.phase || data.phase || "unknown"),
        pill(operatorApprovals ? String(operatorApprovals.approvals.length) + " approvals" : final.state || data.state || runner.state || "unknown"),
        pill(final.mode || (handoffPacket ? "handoff" : operatorApprovals ? "approvals" : "loop")),
        pill(data.ok ? "ok" : "blocked", data.ok ? "ok" : "bad"),
        renderCiHandoff(ciHandoff),
      ].join(" ");
      agentGitService.innerHTML = renderAgentGitService(status.agentGitService || handoffPacket?.agentGitService);
      blockingGroups.innerHTML = renderBlockingGroups(status.blockingGroups || handoffPacket?.blockingGroups || [], commandDefaultCwd);
      inputs.innerHTML = renderInputs(runner.inputRefs || handoffPacket?.handoff?.inputRefs || []);
      command.innerHTML = renderCommand(runner.commandRef, commandDefaultCwd);
      report.textContent = JSON.stringify(data, null, 2);
      refreshExecuteState();
    }

    function renderExecutionStatus(value) {
      if (!value || value.schemaVersion !== "platform-operator-cockpit-execution-status/v1") {
        executionStatus.innerHTML = "";
        return;
      }
      const lease = value.activeLease || {};
      const coordination = value.coordination || {};
      const store = coordination.store || {};
      const tone = value.state === "idle" ? "ok" : value.state === "stale" ? "warn" : "bad";
      const details = [
        pill(value.state || "unknown", tone),
        coordination.activeBackend ? pill("queue " + coordination.activeBackend, coordination.fallbackReason ? "warn" : "ok") : "",
        coordination.fallbackReason ? pill(coordination.fallbackReason, "warn") : "",
        lease.commandLabel ? pill(lease.commandLabel) : "",
        lease.currentStepId ? pill("step " + lease.currentStepId) : "",
        lease.currentBlockingGroupId ? pill("group " + lease.currentBlockingGroupId) : "",
        lease.owner ? pill(lease.owner) : "",
        lease.expiresAt ? pill("expires " + lease.expiresAt) : "",
      ].filter(Boolean).join(" ");
      executionStatus.innerHTML = [
        \`<div class="section-title"><span>Execution</span>\${pill(value.ok ? "available" : "busy", value.ok ? "ok" : tone)}</div>\`,
        \`<div class="meta">\${details}</div>\`,
        renderInputDetail("Queue repo", store.repo),
        renderInputDetail("Queue path", store.path),
      ].join("");
    }

    function operatorCockpitCommandDefaultCwd(data, status, handoffPacket) {
      return status.dir || handoffPacket?.dir || data.dir || "";
    }

    function renderCiHandoff(value) {
      const githubTarget = value && value.githubTarget ? value.githubTarget : {};
      const repo = githubTarget.repo || "";
      const ref = githubTarget.ref || "";
      if (!repo && !ref) return pill("ci target unset", "bad");
      return pill(["ci", repo, ref].filter(Boolean).join(" "), value && value.ready ? "ok" : "warn");
    }

    function renderInputs(refs) {
      if (!refs.length) return '<div class="meta">No missing inputs.</div>';
      const exports = refs.map(renderInputExportCommand).filter(Boolean).join("\\n");
      const checks = refs.map(renderInputCheckCommand).filter(Boolean).join("\\n");
      return [
        \`<div class="section-title"><span>Missing inputs</span>\${pill(String(refs.length), "bad")}</div>\`,
        exports
          ? \`<div class="copy-row"><strong>Shell exports</strong><button class="secondary" type="button" data-copy-value="\${escapeAttr(exports)}">Copy exports</button></div><pre class="compact-pre">\${escapeHtml(exports)}</pre>\`
          : "",
        checks
          ? \`<div class="copy-row"><strong>Shell checks</strong><button class="secondary" type="button" data-copy-value="\${escapeAttr(checks)}">Copy checks</button></div><pre class="compact-pre">\${escapeHtml(checks)}</pre>\`
          : "",
        \`<div class="input-list">\${refs.map(renderInputRef).join("")}</div>\`,
      ].join("");
    }

    function renderInputRef(ref) {
      const name = ref.name || ref.kind || "input";
      const status = ref.present === true ? "present" : ref.present === false ? "missing" : "";
      const exportCommand = renderInputExportCommand(ref);
      const checkCommand = renderInputCheckCommand(ref);
      const applyCommand = Array.isArray(ref.applyInputCommandArgs) ? renderCommandArgsText(ref.applyInputCommandArgs) : "";
      const secretSetCommand = renderGithubSecretSetCommand(ref);
      return [
        '<div class="input-item">',
        \`<div><strong>\${escapeHtml(name)}</strong></div>\`,
        \`<div class="meta">\${pill(ref.kind || "input")}\${ref.required === false ? pill("optional") : pill("required", "bad")}\${status ? pill(status, status === "present" ? "ok" : "bad") : ""}</div>\`,
        renderInputDetail("Target", ref.target),
        renderInputDetail("Input", ref.inputHint),
        renderInputDetail("Input file", ref.inputTemplatePath),
        renderTargetInputFileSummary(ref),
        renderInputDetail("Discovery", ref.discoveryField),
        renderInputDetail("Used by", ref.requiredFor),
        renderInputDetail("Placeholder", ref.placeholderTarget),
        ref.inputTemplate
          ? renderCopyBlock("Template", JSON.stringify(ref.inputTemplate, null, 2), "operator-cockpit-copy-input-template")
          : "",
        renderTargetInputForm(ref),
        renderGithubTargetInputForm(ref),
        exportCommand
          ? renderCopyBlock("Export", exportCommand, "operator-cockpit-copy-input-export")
          : "",
        applyCommand
          ? renderCopyBlock("Apply", applyCommand, "operator-cockpit-copy-input-apply")
          : "",
        secretSetCommand
          ? renderCopyBlock("Set secret", secretSetCommand, "operator-cockpit-copy-input-secret-set")
          : "",
        checkCommand
          ? renderCopyBlock("Check", checkCommand, "operator-cockpit-copy-input-check")
          : "",
        "</div>",
      ].join("");
    }

    function renderTargetInputFileSummary(ref) {
      const inputFile = ref && ref.inputFile && typeof ref.inputFile === "object" ? ref.inputFile : null;
      if (!inputFile) return "";
      const gates = inputFile.gates && typeof inputFile.gates === "object" ? inputFile.gates : {};
      const missing = Array.isArray(inputFile.missing) ? inputFile.missing : [];
      const gateRows = [
        ["schema", gates.schemaVersionOk],
        ["fields", gates.requiredFieldsPresent],
        ["formats", gates.formatsOk],
        ["placeholders", gates.placeholdersAbsent],
      ];
      return [
        '<div class="input-file-summary">',
        '<div class="meta">Input file check ' + pill(inputFile.ok === true ? "valid" : "invalid", inputFile.ok === true ? "ok" : "bad") + '</div>',
        renderInputDetail("Input sha256", inputFile.sha256),
        '<div class="meta">' + gateRows.map((row) => {
          const ok = row[1] === true;
          return pill(row[0] + " " + (ok ? "ok" : "missing"), ok ? "ok" : "bad");
        }).join("") + '</div>',
        renderInputDetail("Input missing", missing),
        "</div>",
      ].join("");
    }

    function renderTargetInputForm(ref, renderedInputForms) {
      if (ref.kind !== "target-input-file") return "";
      const fields = ref.inputTemplate && ref.inputTemplate.targets && typeof ref.inputTemplate.targets === "object"
        ? Object.keys(ref.inputTemplate.targets)
        : [];
      if (!fields.length) return "";
      const formKey = "target-input-file:" + (ref.inputTemplatePath || ref.name || ref.target || "");
      if (renderedInputForms && renderedInputForms.has(formKey)) return "";
      if (renderedInputForms) renderedInputForms.add(formKey);
      const inputSha256 = ref.inputFile && ref.inputFile.sha256 ? String(ref.inputFile.sha256) : "";
      return [
        \`<div class="target-input-form" data-target-input-form data-target-input-sha256="\${escapeAttr(inputSha256)}">\`,
        fields.map((field) => [
          \`<label for="operator-cockpit-target-input-\${escapeAttr(field)}">\${escapeHtml(field)}</label>\`,
          \`<input id="operator-cockpit-target-input-\${escapeAttr(field)}" data-target-input-field="\${escapeAttr(field)}" autocomplete="off" />\`,
        ].join("")).join(""),
        '<button type="button" data-testid="operator-cockpit-target-input-save" data-target-input-save="true">Save input file</button>',
        '<button type="button" class="secondary" data-testid="operator-cockpit-target-input-apply" data-target-input-apply="true">Apply input file</button>',
        '<button type="button" class="secondary" data-testid="operator-cockpit-bundle-refresh" data-target-input-bundle-refresh="true">Refresh bundle</button>',
        "</div>",
      ].join("");
    }

    function renderGithubTargetInputForm(ref, renderedInputForms) {
      if (ref.kind !== "github-target") return "";
      const template = ref.inputTemplate && typeof ref.inputTemplate === "object" ? ref.inputTemplate : {};
      const fields = ["repo", "ref"].filter((field) => field in template);
      if (!fields.length) return "";
      const formKey = "github-target:" + (ref.inputTemplatePath || "github-actions-target");
      if (renderedInputForms && renderedInputForms.has(formKey)) return "";
      if (renderedInputForms) renderedInputForms.add(formKey);
      const current = operatorCockpitTarget();
      const targetInputSha256 = currentGithubTargetInputSha256() || "";
      return [
        \`<div class="target-input-form" data-github-target-input-form data-github-target-input-sha256="\${escapeAttr(targetInputSha256)}">\`,
        fields.map((field) => [
          \`<label for="operator-cockpit-github-target-\${escapeAttr(field)}">\${escapeHtml(field)}</label>\`,
          \`<input id="operator-cockpit-github-target-\${escapeAttr(field)}" data-github-target-field="\${escapeAttr(field)}" value="\${escapeAttr(current[field] || "")}" autocomplete="off" />\`,
        ].join("")).join(""),
        '<button type="button" data-testid="operator-cockpit-github-target-input-save" data-github-target-input-save="true">Save CI target</button>',
        "</div>",
      ].join("");
    }

    function renderCommand(ref, defaultCwd = "") {
      if (!ref) return '<div class="meta">No command ready.</div>';
      const cwd = ref.cwd || defaultCwd || "";
      const commandText = renderCommandText(ref, defaultCwd);
      return [
        '<div class="copy-row">',
        \`<strong>\${escapeHtml(ref.label || "command")}</strong>\`,
        \`<button class="secondary" type="button" data-testid="operator-cockpit-copy-command" data-copy-value="\${escapeAttr(commandText)}">Copy command</button>\`,
        "</div>",
        renderInputDetail("Cwd", cwd),
        \`<pre>\${escapeHtml(commandText)}</pre>\`,
      ].join("");
    }

    function renderCommandText(ref, defaultCwd = "") {
      const commandText = ref.command || renderCommandArgsText(ref.commandArgs || []);
      const cwd = ref.cwd || defaultCwd || "";
      if (!cwd) return commandText;
      return "cd " + shellQuoteForCommandCopy(cwd) + "\\n" + commandText;
    }

    function renderCommandArgsText(args) {
      return args.map(shellQuoteForCommandCopy).join(" ");
    }

    function shellQuoteForCommandCopy(value) {
      return "'" + String(value).replace(/'/g, "'\\\\''") + "'";
    }

    function renderBlockingGroups(groups, defaultCwd = "") {
      if (!groups.length) return '<div class="meta">No blocking groups.</div>';
      return [
        \`<div class="section-title"><span>Blocking groups</span>\${pill(String(groups.length), "bad")}</div>\`,
        '<div class="input-list">',
        groups.map((group) => renderBlockingGroup(group, defaultCwd)).join(""),
        "</div>",
      ].join("");
    }

    function renderAgentGitService(value) {
      if (!value) return '<div class="meta">No AGS summary.</div>';
      const gates = value.gates || {};
      const missing = Array.isArray(value.missing) ? value.missing : [];
      const nextActions = Array.isArray(value.nextActions) ? value.nextActions : [];
      const nativeWrite = value.nativeWriteCheckRequired
        ? pill("native write " + gateText(gates.nativeWriteCheckOk), gates.nativeWriteCheckOk ? "ok" : "bad")
        : "";
      return [
        \`<div class="section-title"><span>Agent Git Service</span>\${pill(value.ok ? "ok" : "blocked", value.ok ? "ok" : "bad")}</div>\`,
        \`<div class="meta">\${pill(value.required ? "required" : "optional")}\${pill("server env " + gateText(gates.serverEnvPlanOk), gates.serverEnvPlanOk ? "ok" : "bad")}\${pill("handoff " + gateText(gates.upstreamHandoffOk), gates.upstreamHandoffOk ? "ok" : "bad")}\${pill("readiness " + gateText(gates.stagingReadinessOk), gates.stagingReadinessOk ? "ok" : "bad")}\${nativeWrite}\${pill("compat " + gateText(gates.compatOk), gates.compatOk ? "ok" : "bad")}</div>\`,
        missing.length ? \`<div class="kv"><span>Missing</span><strong>\${escapeHtml(missing.join(", "))}</strong></div>\` : "",
        nextActions.length ? \`<ul>\${nextActions.map((action) => \`<li>\${escapeHtml(action)}</li>\`).join("")}</ul>\` : "",
      ].join("");
    }

    function gateText(value) {
      return value ? "ok" : "blocked";
    }

    function renderBlockingGroup(group, defaultCwd = "") {
      const actionCount = Array.isArray(group.nextActions) ? group.nextActions.length : 0;
      const commandRefs = Array.isArray(group.commandRefs) ? group.commandRefs : [];
      const commandTexts = commandRefs.map((ref) => renderCommandText(ref, defaultCwd));
      return [
        '<div class="input-item">',
        \`<div><strong>\${escapeHtml(group.id || "group")}</strong></div>\`,
        \`<div class="meta">\${pill(group.ok ? "ok" : "blocked", group.ok ? "ok" : "bad")}\${actionCount ? pill(String(actionCount) + " actions") : ""}\${commandRefs.length ? pill(String(commandRefs.length) + " commands") : ""}</div>\`,
        actionCount ? \`<ul>\${group.nextActions.map((action) => \`<li>\${escapeHtml(action)}</li>\`).join("")}</ul>\` : "",
        renderBlockingGroupRefs(group),
        commandRefs.length > 1 ? renderCopyBlock("All commands", commandTexts.join("\\n"), "operator-cockpit-copy-group-commands") : "",
        commandRefs.length ? commandRefs.map((ref, index) => renderCopyBlock(ref.label || "Command", commandTexts[index], "operator-cockpit-copy-group-command")).join("") : "",
        "</div>",
      ].join("");
    }

    function renderBlockingGroupRefs(group) {
      const refs = [
        ...(group.envRefs || []).map((ref) => ({ kind: "operator-env", ...ref })),
        ...(group.serverEnvRefs || []).map((ref) => ({ kind: "server-env", ...ref })),
        ...(group.targetEnvRefs || []).map((ref) => ({ kind: "target-env", ...ref })),
        ...(group.targetInputRefs || []).map((ref) => ({ kind: "target-input-file", ...ref })),
        ...(group.githubTargetRefs || []).map((ref) => ({ kind: "github-target", ...ref })),
        ...(group.secretRefs || []).map((ref) => ({ kind: "github-secret", ...ref })),
      ];
      if (!refs.length) return "";
      const refCommands = refs.map(renderBlockingRefCommand).filter(Boolean);
      const refChecks = refs.map(renderInputCheckCommand).filter(Boolean);
      const renderedInputForms = new Set();
      return [
        '<div class="input-list operator-cockpit-blocking-ref-list">',
        refCommands.length > 1 ? renderCopyBlock("All inputs", refCommands.join("\\n"), "operator-cockpit-copy-blocking-ref-commands") : "",
        refChecks.length > 1 ? renderCopyBlock("All checks", refChecks.join("\\n"), "operator-cockpit-copy-blocking-ref-checks") : "",
        refs.map((ref) => renderBlockingGroupRef(ref, renderedInputForms)).join(""),
        "</div>",
      ].join("");
    }

    function renderBlockingGroupRef(ref, renderedInputForms) {
      const name = ref.name || ref.kind || "ref";
      const status = ref.present === true ? "present" : ref.present === false ? "missing" : "";
      const commandText = renderBlockingRefCommand(ref);
      const checkCommand = renderInputCheckCommand(ref);
      return [
        '<div class="input-item">',
        \`<div><strong>\${escapeHtml(name)}</strong></div>\`,
        \`<div class="meta">\${pill(ref.kind || "ref")}\${ref.required === false ? pill("optional") : pill("required", "bad")}\${status ? pill(status, status === "present" ? "ok" : "bad") : ""}</div>\`,
        renderInputDetail("Provider", ref.provider),
        renderInputDetail("Target", ref.target),
        renderInputDetail("Input", ref.inputHint),
        renderInputDetail("Input file", ref.inputTemplatePath),
        renderTargetInputFileSummary(ref),
        renderInputDetail("Discovery", ref.discoveryField),
        renderInputDetail("Used by", ref.requiredFor),
        renderInputDetail("Placeholder", ref.placeholderTarget),
        ref.inputTemplate
          ? renderCopyBlock("Template", JSON.stringify(ref.inputTemplate, null, 2), "operator-cockpit-copy-blocking-ref-template")
          : "",
        renderTargetInputForm(ref, renderedInputForms),
        renderGithubTargetInputForm(ref, renderedInputForms),
        commandText
          ? renderCopyBlock("Command", commandText, "operator-cockpit-copy-blocking-ref-command")
          : "",
        checkCommand
          ? renderCopyBlock("Check", checkCommand, "operator-cockpit-copy-blocking-ref-check")
          : "",
        "</div>",
      ].join("");
    }

    function renderBlockingRefCommand(ref) {
      const secretSetCommand = renderGithubSecretSetCommand(ref);
      if (secretSetCommand) return secretSetCommand;
      if (Array.isArray(ref.setCommandArgs)) return renderCommandArgsText(ref.setCommandArgs);
      if (Array.isArray(ref.applyInputCommandArgs)) return renderCommandArgsText(ref.applyInputCommandArgs);
      const exportCommand = renderInputExportCommand(ref);
      if (exportCommand) return exportCommand;
      return ref.envCheckShellCommand || "";
    }

    function renderGithubSecretSetCommand(ref) {
      const name = String(ref.name || "").trim();
      if (ref.kind !== "github-secret" || !Array.isArray(ref.setCommandArgs) || !isShellEnvName(name)) return "";
      return "printf '%s' \\"" + "$" + "{" + name + ":?missing " + name + "}" + "\\" | " + renderCommandArgsText(ref.setCommandArgs);
    }

    function renderInputExportCommand(ref) {
      const name = String(ref.name || "").trim();
      if (!isShellEnvName(name)) return "";
      if (!["target-env", "env", "server-env", "secret", "operator-env", "github-secret"].includes(ref.kind)) return "";
      return \`export \${name}='<value>'\`;
    }

    function renderInputCheckCommand(ref) {
      return ref.envCheckShellCommand || "";
    }

    function isShellEnvName(name) {
      return Boolean(name) && /^[_A-Za-z][_A-Za-z0-9]*$/.test(name);
    }

    function renderInputDetail(label, value) {
      const formatted = formatInputValue(value);
      if (!formatted) return "";
      return \`<div class="kv"><span>\${escapeHtml(label)}</span><strong>\${escapeHtml(formatted)}</strong></div>\`;
    }

    function renderCopyBlock(label, value, testId) {
      return [
        '<div>',
        \`<div class="copy-row"><strong>\${escapeHtml(label)}</strong><button class="secondary" type="button" data-testid="\${escapeAttr(testId)}" data-copy-value="\${escapeAttr(value)}">Copy</button></div>\`,
        \`<pre class="compact-pre">\${escapeHtml(value)}</pre>\`,
        "</div>",
      ].join("");
    }

    function formatInputValue(value) {
      if (Array.isArray(value)) return value.filter(Boolean).join(", ");
      if (value === true || value === false) return String(value);
      if (value === null || value === undefined) return "";
      return String(value);
    }

    async function copyText(value) {
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        errorBox.textContent = "";
        connection.textContent = "copied";
      } catch (error) {
        errorBox.textContent = error instanceof Error ? error.message : String(error);
        connection.textContent = "copy failed";
      }
    }

    function refreshExecuteState() {
      const runner = state.report && state.report.iterations && state.report.iterations.at(-1) && state.report.iterations.at(-1).runner;
      executeButton.disabled = !(runner && runner.mode === "dry-run" && runner.commandRef && confirmInput.checked);
    }

    function setBusy(busy, text) {
      refreshButton.disabled = busy;
      saveCiTargetButton.disabled = busy;
      seedTargetTemplateButton.disabled = busy;
      exportHandoffButton.disabled = busy;
      exportApprovalsButton.disabled = busy;
      importCiArtifactButton.disabled = busy;
      syncAgsEvidenceButton.disabled = busy;
      importAgsEvidenceButton.disabled = busy;
      for (const button of document.querySelectorAll("[data-target-input-save], [data-target-input-apply], [data-target-input-bundle-refresh], [data-github-target-input-save]")) {
        button.disabled = busy;
      }
      executeButton.disabled = busy || executeButton.disabled;
      if (text) connection.textContent = text;
      if (!busy) refreshExecuteState();
    }

    function pill(text, tone = "warn") {
      return \`<span class="pill \${tone}">\${escapeHtml(text)}</span>\`;
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value);
    }

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const githubTargetSaveButton = target.closest("[data-github-target-input-save]");
      if (githubTargetSaveButton) {
        const form = githubTargetSaveButton.closest("[data-github-target-input-form]");
        if (form) void saveGithubTargetInput(form);
        return;
      }
      const bundleRefreshButton = target.closest("[data-target-input-bundle-refresh]");
      if (bundleRefreshButton) {
        const form = bundleRefreshButton.closest("[data-target-input-form]");
        if (form) void refreshBundleFromTargetInput(form);
        return;
      }
      const applyButton = target.closest("[data-target-input-apply]");
      if (applyButton) {
        const form = applyButton.closest("[data-target-input-form]");
        if (form) void applyTargetInput(form);
        return;
      }
      const saveButton = target.closest("[data-target-input-save]");
      if (saveButton) {
        const form = saveButton.closest("[data-target-input-form]");
        if (form) void saveTargetInput(form);
        return;
      }
      const button = target.closest("[data-copy-value]");
      if (!button) return;
      void copyText(button.getAttribute("data-copy-value") || "");
    });
    refreshButton.addEventListener("click", () => void refreshCockpit());
    saveCiTargetButton.addEventListener("click", () => void saveGithubTargetFromHeader());
    seedTargetTemplateButton.addEventListener("click", () => void seedTargetInputTemplate());
    exportHandoffButton.addEventListener("click", () => void exportHandoffPacket());
    exportApprovalsButton.addEventListener("click", () => void exportOperatorApprovals());
    syncAgsEvidenceButton.addEventListener("click", () => void syncAgsEvidence());
    importAgsEvidenceButton.addEventListener("click", () => void importAgsEvidence());
    importCiArtifactButton.addEventListener("click", () => void importCiArtifact());
    executeButton.addEventListener("click", () => void executeCurrentCommand());
    confirmInput.addEventListener("change", refreshExecuteState);
    artifactPhaseInput.addEventListener("change", () => { artifactPhaseDirty = true; });
    if (params.get("autoload") !== "0") void refreshCockpit();
  </script>
</body>
</html>`;
