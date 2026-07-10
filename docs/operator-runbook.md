# Loom Platform Operator Runbook

This runbook is the shortest path from a fresh operator shell to a verified multi-user online sandbox with the first-party harness loop, optional AGS provider evidence, and a clear cutover gate.

## 0. Build The CLI

```bash
npm install
npm run build
npm link
```

Use `npx tsx src/index.ts ...` instead of `loom ...` when working directly from source without linking.

Before wiring external services, run the local platform rehearsal:

```bash
loom harness rehearsal --workspace-root /tmp/loom-rehearsal
loom harness rehearsal --workspace-root /tmp/loom-rehearsal-peer --peer-server
loom harness rehearsal --workspace-root /tmp/loom-rehearsal-ags --control-plane-provider agent-git-service
```

It starts a temporary local platform server, fake model gateway, Coder-shaped local executor, tenant keys, and control-plane reporter hooks, runs the read-only cutover report, and then runs the full `platform-readiness` smoke. The peer variant starts a second harness server against the same workspace root and requires cross-server active-run lease, pause, cancel, and idempotent-create evidence. The AGS variant also starts the shared contract-backed local `/api/v3` and provisions a stored project-agent token through the harness admin endpoint. Treat these as repeatable local proof before moving to real Coder/Gitea/LiteLLM/AGS infrastructure.

## 1. Required Operator Inputs

Set secrets in env vars, not command history:

```bash
export LOOM_ADMIN_TOKEN="..."
export LOOM_DEV_TOKEN="..."
export LOOM_VIEWER_TOKEN="..."
export LOOM_BOB_DEV_TOKEN="..."
export LOOM_MODEL_KEY="..."
export LOOM_GITEA_TOKEN="..."
export LOOM_GITEA_WEBHOOK_SECRET="..."
```

For AGS:

```bash
export LOOM_AGENT_GIT_SERVICE_URL="https://git.example/api/v3"
export LOOM_AGENT_GIT_SERVICE_TOKEN="..."
```

Pick stable paths:

```bash
export LOOM_WORKSPACE_ROOT="/var/lib/loom/workspaces"
export LOOM_SECRET_ROOT="/var/lib/loom/secrets/agent-git-service"
```

## 2. Preflight Before Serving

Run the exact `serve` shape through doctor first. Platform readiness requires run-scoped isolation, so Coder must have a worktree cwd template.

```bash
loom harness doctor \
  --workspace-root "$LOOM_WORKSPACE_ROOT" \
  --profile platform-readiness \
  --executor coder \
  --executor-workspace "loom-{tenant}" \
  --executor-remote-cwd "/home/dev/projects/{project}" \
  --executor-worktree-cwd "/home/dev/projects/{project}/.worktrees/{runId}" \
  --executor-ide-url "https://coder.example/@{tenant}/{project}/{runId}" \
  --executor-preview-url "https://preview.example/{tenant}/{project}/{runId}" \
  --model-base-url "https://litellm.example" \
  --model-key-env LOOM_MODEL_KEY \
  --tenant-key-env alice=LOOM_ADMIN_TOKEN:ops:admin \
  --tenant-key-env alice=LOOM_DEV_TOKEN:dev:developer \
  --tenant-key-env alice=LOOM_VIEWER_TOKEN:auditor:viewer \
  --tenant-key-env bob=LOOM_BOB_DEV_TOKEN:bob:developer \
  --control-plane-pr \
  --control-plane-comment-sync \
  --control-plane-webhook-secret-env LOOM_GITEA_WEBHOOK_SECRET \
  --control-plane-url "https://git.example" \
  --control-plane-token-env LOOM_GITEA_TOKEN \
  --tenant-control-plane-token-env alice=LOOM_GITEA_TOKEN \
  --ingest-brain \
  --allow-shell \
  --allow-tool git.pr
```

Do not serve until doctor returns `ok: true`. Important readiness fields:

- `readiness.ok: true`
- `checks.controlPlaneWorkspaceBranchLease.ok: true`
- `checks.runWorkspaceIsolation.ok: true`
- `checks.runCreateIdempotency.ok: true`
- no missing model, webhook, tenant role, executor, or control-plane env checks

## 3. External Probes

Doctor validates flag shape without contacting external systems. Before the
first serve against real infrastructure, run the individual probes:

```bash
loom harness model-preflight --model-base-url "https://litellm.example" --model-key-env LOOM_MODEL_KEY --model "your-model"
loom harness control-plane-preflight --control-plane-provider gitea-forgejo --control-plane-url "https://git.example" --control-plane-token-env LOOM_GITEA_TOKEN
loom harness control-plane-preflight --control-plane-provider agent-git-service --control-plane-url "$LOOM_AGENT_GIT_SERVICE_URL" --control-plane-token-env LOOM_AGENT_GIT_SERVICE_TOKEN
loom harness coder-preflight --workspace-root "$LOOM_WORKSPACE_ROOT" --tenant alice --project smoke-platform --executor-workspace "loom-{tenant}" --executor-remote-cwd "/home/dev/projects/{project}" --executor-worktree-cwd "/home/dev/projects/{project}/.worktrees/{runId}"
```

The model probe uses the same adapter as model-backed harness runs, the control-plane probe checks provider catalog discovery endpoints, and the Coder probe runs the same executor prepare/remote-command path used by `serve`.

## 4. Start The Platform Server

Use the same flags after doctor passes:

```bash
loom harness serve \
  --workspace-root "$LOOM_WORKSPACE_ROOT" \
  --host 0.0.0.0 \
  --port 8787 \
  --profile platform-readiness \
  --executor coder \
  --executor-workspace "loom-{tenant}" \
  --executor-remote-cwd "/home/dev/projects/{project}" \
  --executor-worktree-cwd "/home/dev/projects/{project}/.worktrees/{runId}" \
  --executor-ide-url "https://coder.example/@{tenant}/{project}/{runId}" \
  --executor-preview-url "https://preview.example/{tenant}/{project}/{runId}" \
  --model-base-url "https://litellm.example" \
  --model-key-env LOOM_MODEL_KEY \
  --tenant-key-env alice=LOOM_ADMIN_TOKEN:ops:admin \
  --tenant-key-env alice=LOOM_DEV_TOKEN:dev:developer \
  --tenant-key-env alice=LOOM_VIEWER_TOKEN:auditor:viewer \
  --tenant-key-env bob=LOOM_BOB_DEV_TOKEN:bob:developer \
  --control-plane-pr \
  --control-plane-comment-sync \
  --control-plane-webhook-secret-env LOOM_GITEA_WEBHOOK_SECRET \
  --control-plane-url "https://git.example" \
  --control-plane-token-env LOOM_GITEA_TOKEN \
  --tenant-control-plane-token-env alice=LOOM_GITEA_TOKEN \
  --ingest-brain \
  --allow-shell \
  --allow-tool git.pr \
  --max-tenant-active-runs 4 \
  --run-lease-ttl-ms 120000
```

If you expose the service outside loopback, do not use the local executor unless this is a deliberate single-user development instance.

Before the expensive smoke, ask the running server for a read-only cutover summary:

```bash
LOOM_CUTOVER_TOKEN="$LOOM_DEV_TOKEN" \
loom harness cutover-report \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --token-env LOOM_CUTOVER_TOKEN
```

For the AGS candidate path, include admin access so the report can read the token-free provisioning plan:

```bash
LOOM_CUTOVER_TOKEN="$LOOM_DEV_TOKEN" \
loom harness cutover-report \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --token-env LOOM_CUTOVER_TOKEN \
  --admin-token-env LOOM_ADMIN_TOKEN \
  --control-plane-provider agent-git-service
```

The report exits non-zero when server readiness, tenant readiness, provider match, golden path, vision lock, or AGS project-agent provisioning is incomplete. It recomputes required golden-path and vision-lock capabilities from the shared contract instead of trusting `ok: true` alone. Follow `nextActions` before running the full smoke. For AGS, CI/operator bots should prefer the token-free `agentGitServiceProvisioningPlanCommandArgs`, `agentGitServiceProvisioningPlanDryRunCommandArgs`, and `agentGitServiceProvisioningPlanApplyCommandArgs` fields over parsing human-readable text.

If you pass `--project`, `--isolation-tenant`, `--viewer-token-env`, `--admin-token-env`, and `--control-plane-webhook-secret-env`, the report also emits `smokeCommandArgs`: a token-free argv array for the exact `platform-readiness` smoke to run next.

## 5. Run The Platform Readiness Smoke

```bash
LOOM_SMOKE_TOKEN="$LOOM_DEV_TOKEN" \
LOOM_SMOKE_VIEWER_TOKEN="$LOOM_VIEWER_TOKEN" \
LOOM_SMOKE_ADMIN_TOKEN="$LOOM_ADMIN_TOKEN" \
LOOM_SMOKE_WEBHOOK_SECRET="$LOOM_GITEA_WEBHOOK_SECRET" \
loom harness smoke \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --project smoke-platform \
  --template vas-lite \
  --token-env LOOM_SMOKE_TOKEN \
  --viewer-token-env LOOM_SMOKE_VIEWER_TOKEN \
  --admin-token-env LOOM_SMOKE_ADMIN_TOKEN \
  --isolation-tenant bob \
  --profile platform-readiness \
  --control-plane-webhook-secret-env LOOM_SMOKE_WEBHOOK_SECRET
```

Required smoke evidence:

- `onlineSandboxGoldenPathChecked: true`
- `onlineSandboxGoldenPathCapabilities` includes `multi-agent-concurrency`
- `multiAgentConcurrencyChecked: true`
- `serverRunWorkspaceIsolation: "run"` and `tenantRunWorkspaceIsolation: "run"`
- `controlPlaneWorkspaceBranchLeaseChecked: true`
- `runScopedPullRequestDuringActiveRunChecked: true`
- `runScopedFileWriteDuringActiveRunChecked: true`
- `activeRunLeaseChecked: true`
- `metricsLowCardinalityChecked: true`
- `healthProbesSensitiveFieldsAbsent: true`
- `backupRestoreDryRunChecked: true`
- `vasReviewLearningRecorded: true`
- `controlPlaneCommentsWebhookChecked: true`

For two server instances sharing the same workspace root, start a second server on another port and add `--peer-url http://127.0.0.1:<peerPort>`. Then also require:

- `crossServerActiveRunLeaseChecked: true`
- `crossServerPauseChecked: true`
- `crossServerCancelChecked: true`
- `crossServerIdempotentCreateChecked: true`
- `multiAgentConcurrencyCrossServerChecked: true`

## 6. AGS Candidate Provider Path

Start or doctor the server with AGS provider flags:

```bash
loom harness doctor \
  --workspace-root "$LOOM_WORKSPACE_ROOT" \
  --profile platform-readiness \
  --executor coder \
  --executor-workspace "loom-{tenant}" \
  --executor-remote-cwd "/home/dev/projects/{project}" \
  --executor-worktree-cwd "/home/dev/projects/{project}/.worktrees/{runId}" \
  --model-base-url "https://litellm.example" \
  --model-key-env LOOM_MODEL_KEY \
  --tenant-key-env alice=LOOM_ADMIN_TOKEN:ops:admin \
  --tenant-key-env alice=LOOM_DEV_TOKEN:dev:developer \
  --tenant-key-env alice=LOOM_VIEWER_TOKEN:auditor:viewer \
  --tenant-key-env bob=LOOM_BOB_DEV_TOKEN:bob:developer \
  --control-plane-provider agent-git-service \
  --control-plane-pr \
  --control-plane-comment-sync \
  --control-plane-webhook-secret-env LOOM_GITEA_WEBHOOK_SECRET \
  --control-plane-url "$LOOM_AGENT_GIT_SERVICE_URL" \
  --control-plane-token-env LOOM_AGENT_GIT_SERVICE_TOKEN \
  --tenant-control-plane-token-env alice=LOOM_AGENT_GIT_SERVICE_TOKEN \
  --agent-git-service-token-secret-root "$LOOM_SECRET_ROOT" \
  --ingest-brain \
  --allow-shell \
  --allow-tool git.pr
```

Before cutover, provision project agents through the harness, not manually. If `cutover-report` emitted the AGS provisioning argv fields, execute those exact arrays; the commands below are the equivalent manual form:

First compare the real upstream candidate against the local contract baseline:

```bash
loom harness agent-git-service-compat-rehearsal \
  --candidate-url "$LOOM_AGENT_GIT_SERVICE_URL" \
  --candidate-token-env LOOM_AGENT_GIT_SERVICE_TOKEN \
  --out ags-compat

jq -e '.ok == true and .tokenFree == true' ags-compat/manifest.json
jq -e '.ok == true and .tokenFree == true' ags-compat/compare.json
```

Do not run mutating AGS provisioning until this read-only comparison passes.

```bash
loom harness agent-git-service-provisioning-plan \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --admin-token-env LOOM_ADMIN_TOKEN

loom harness apply-agent-git-service-provisioning-plan \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --admin-token-env LOOM_ADMIN_TOKEN \
  --dry-run

loom harness apply-agent-git-service-provisioning-plan \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --admin-token-env LOOM_ADMIN_TOKEN \
  --eligible-only
```

Then run smoke with AGS:

```bash
loom harness smoke \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --project smoke-platform-ags \
  --template vas-lite \
  --token-env LOOM_SMOKE_TOKEN \
  --viewer-token-env LOOM_SMOKE_VIEWER_TOKEN \
  --admin-token-env LOOM_SMOKE_ADMIN_TOKEN \
  --isolation-tenant bob \
  --profile platform-readiness \
  --control-plane-provider agent-git-service \
  --control-plane-webhook-secret-env LOOM_SMOKE_WEBHOOK_SECRET
```

Required AGS-specific evidence:

- `serverControlPlaneProvider: "agent-git-service"`
- `agentGitServiceProjectAgentsOk: true`
- `agentGitServiceCutoverChecked: true`
- `agentGitServiceCutoverReceiptSecretAbsent: true`
- `agentGitServiceCutoverWorkspaceTokenChecked: true`
- `agentGitServiceNativeProjectionChecked: true`
- `agentGitServiceHandoffWorkspaceAttachmentChecked: true`
- `agentGitServiceWikiMemoryChecked: true`
- `serverControlPlaneDiscoveryTokenMode: "admin" | "tenant-scoped"` with `serverControlPlaneDiscoveryMissingTenants: []`
- `tenantControlPlaneDiscoveryTokenMode: "admin" | "tenant-scoped"` with `tenantControlPlaneDiscoveryMissingTenants: []`
- `onlineSandboxGoldenPathCapabilities` includes `agent-git-service-cutover`
- `onlineSandboxGoldenPathCapabilities` includes `agent-git-service-native-projection`

## 7. Cutover Decision

Do not switch a tenant to AGS unless all are true:

- Gitea/Forgejo `platform-readiness` passes.
- AGS `platform-readiness` passes.
- The tenant backup/restore dry run passes in both directions.
- Every project has an AGS provisioning receipt and stored project-agent token.
- No smoke, status, backup, or audit output contains token material.
- Multi-agent concurrency evidence passes with run-scoped isolation.
- Human gates, VAS learning, issue-comment sync, signed webhooks, handoff packages, and brain ingest still pass.

AGS remains a provider projection. The first-party run log, tenant audit, review/deployment gates, VAS local learning file, and handoff package stay authoritative.

## 8. Routine Operations

Check service health:

```bash
curl -s http://127.0.0.1:8787/healthz
curl -s http://127.0.0.1:8787/readyz
curl -s http://127.0.0.1:8787/metrics -H "authorization: Bearer $LOOM_ADMIN_TOKEN"
curl -s http://127.0.0.1:8787/status -H "authorization: Bearer $LOOM_ADMIN_TOKEN"
```

Watch tenant audit:

```bash
curl -N http://127.0.0.1:8787/tenants/alice/audit/stream \
  -H "authorization: Bearer $LOOM_DEV_TOKEN"
```

Handle stuck runs:

- Prefer `POST /tenants/:tenant/runs/:runId/cancel`.
- Use `abandon-stale` only for lease-expired orphaned runs.
- Do not manually edit `.loom/runs/<runId>/summary.json` except for disaster recovery with a separate written note.

## 9. Rollback

Rollback AGS by restarting with the default provider:

```bash
loom harness serve ... \
  --control-plane-provider gitea-forgejo \
  --control-plane-url "https://git.example" \
  --control-plane-token-env LOOM_GITEA_TOKEN
```

Keep AGS receipts and server-side project-agent tokens until the tenant has passed Gitea/Forgejo `platform-readiness` again and no active runs depend on AGS remotes.
