# loomctl

Operator CLI and HTTP control plane for a multi-user online sandbox development
platform with a first-party harness/loop.

It now has two loop paths:

1. **First-party harness/loop** - `loom harness run` is the OpenHands-lite MVP: event log, tool runtime, agent adapter, and verification-gated finish.
2. **Native adapter** - `loom goal` still delegates to Claude Code / Codex `/goal` when you want the old thin mode.

The larger platform shape remains the same:

1. **Multi-user online sandbox dev** - per-dev persistent workspaces, projects, and tenant isolation.
2. **Shared control plane** - Gitea/Forgejo board + central LiteLLM gateway.
3. **Skill-evolution brain** - capture run signals, score skills, and open git-backed improvement PRs.

## Vision lock

The MVP is not the target shrink-wrapped. It is the first slice of our own harness/loop.

Keep these goals alive after the MVP works:

- multi-user tenants with isolated persistent sandboxes;
- web/API control plane for online development sessions;
- Coder/Gitea/LiteLLM integration;
- `ngaut/agent-git-service` remains a candidate shared-control-plane provider in `VISION.md`; Gitea/Forgejo stays the default, while `--control-plane-provider agent-git-service` is now serve/smoke-enabled with adapter, registry-based provider selection, runtime contract metadata matching the provider catalog, `LOOM_AGENT_GIT_SERVICE_URL`/`LOOM_AGENT_GIT_SERVICE_TOKEN` defaults, Git remote, signed webhook identity, backup migration dry-run evidence, and cataloged `/api/v3` discovery plus native agent capability evidence;
- event-sourced run history that humans can inspect and replay;
- verification as a hard gate, not a model claim;
- brain loop that turns run failures into skill/process improvements.

## Map to v3

| v3 piece | here |
|---|---|
| first-party loop | `loom harness run` |
| HTTP control plane | `loom harness serve` |
| native loop adapter | `loom goal` -> native `/goal`; `hooks-install` |
| control plane / board | Gitea/Forgejo (config: `giteaUrl`) |
| central billing | LiteLLM (config: `gatewayUrl` + per-dev `LOOM_GATEWAY_KEY`) |
| persistent multi-project workspace | `loom workspace create`, `loom project add` |
| execution boundary | `src/harness/executor.ts` local `WorkspaceExecutor`; `src/harness/docker-executor.ts` Docker runner; `src/harness/coder-executor.ts` Coder SSH runner |
| **skill-evolution brain** | `loom brain ingest / score / propose` ← the real code |

## Quickstart

```bash
npm install
npm run build            # → dist/
npm link                 # exposes `loom`
```

Run the first-party harness with a scripted agent:

```bash
mkdir -p /tmp/loom-demo
cat > /tmp/loom-script.json <<'JSON'
[
  {
    "message": "write hello.txt",
    "actions": [
      {
        "toolName": "file.write",
        "input": { "path": "hello.txt", "content": "hello\n" }
      }
    ]
  },
  { "message": "finish", "finish": true }
]
JSON

loom harness run "create hello.txt" \
  --cwd /tmp/loom-demo \
  --script /tmp/loom-script.json \
  --verify "test -f hello.txt" \
  --evaluate "test -s hello.txt" \
  --reviewer "printf 'reviewer: inspect the diff before merge'" \
  --skill coding
```

For local configuration, copy `loom.config.example.json` to `loom.config.json`
and adjust the deployment-specific values. Keep credentials in environment
variables or an external secret store; local configuration and generated
operator reports are intentionally ignored by Git.

Artifacts are written under:

- `.loom/runs/<runId>/events.jsonl`
- `.loom/runs/<runId>/summary.json`

Each run begins with a `user_message` event for the requested goal and records the effective tool policy as `run_policy`. Event appends use an atomic lock file in addition to the in-process queue, so multiple `loom` server processes sharing a workspace preserve one monotonic sequence per run; stale append locks are recoverable. Agent/adapter failures are recorded with their loop phase and iteration in both `error` events and `summary.error`; diagnostic agent errors can also include `kind` and bounded `details` such as a model response excerpt. Agent adapters may emit bounded `agent_retry` events before the final assistant step, so repair attempts stay visible in replay and handoff evidence. Optional evaluator commands run after verification and before review/deployment gates; failed evaluation records an `evaluation` event and fails the run before any human gate is opened. Optional reviewer commands run only after verification/evaluation pass, record non-gating `reviewer` evidence in events and `summary.reviewer`, and never replace the human review gate. HTTP-created user messages and gate decisions also include the authenticated `actor`/`role` and caller `clientId` when available; run summaries, review summaries, handoff packages, run lists, issue comments, and default PR bodies expose that public requester identity without model-routing secret envs, so the per-run log remains useful even outside the tenant audit feed. Failed-run Gitea/Forgejo issue comments also include non-secret error kind/details for external review.
Model-backed CLI and HTTP runs record non-secret `metadata.agentMode`, `metadata.model`, non-default `metadata.modelProtocol`, per-request `model_usage` events, aggregate `summary.modelUsage` token counts, and LiteLLM-style response cost when available for replay, audit, and billing handoff; API keys and key values are never written to summaries.

Serve the harness over HTTP:

```bash
loom harness serve --workspace-root /tmp/loom-workspaces --port 8787
```

The default local executor is for loopback, single-user development. For shared or externally reachable HTTP service, choose Docker or Coder; `loom harness serve` rejects authenticated, non-loopback, or shell-enabled local executor use unless you explicitly pass `--allow-unsafe-local-executor`. Tenant auth includes CLI keys/tokens and existing policy-backed `apiKeys` on disk.

For the MVP online sandbox, start an isolated executor with `--profile online-sandbox`; it expands the server allowlist to `file.read`, `file.write`, `git.diff`, `git.commit`, `verify.run`, and `shell.exec`, reports that profile and server allowlist through `GET /status`, exposes each tenant's effective allowlist plus non-sensitive `readiness`, `readiness.goldenPath`, and `visionLock` through `GET /tenants/:tenant/status`, and keeps the local executor safety guard. Its readiness is stricter than the safety guard: `GET /status` and tenant status only report `readiness.ok: true` and `readiness.goldenPath.ok: true` when role-based tenant keys cover `admin`, `developer`, and `viewer`, and execution is Docker with `--executor-home-root` or Coder, so online sandboxes have authenticated tenants, isolated execution, and per-tenant persistent home state. Tenant status scopes tenant/project-enumerating readiness checks, including model-key coverage, tenant auth roles, control-plane agent identity, AGS discovery using that tenant's control-plane token when configured, and AGS project-agent receipts/secrets, to the requested tenant; global status remains the cross-tenant operator view and, when no global AGS admin token is configured, aggregates tenant-scoped AGS discovery evidence with token-free `tokenMode`, tenant counts, and missing tenant lists. For the full Coder/control-plane/LiteLLM/brain path, use `--profile platform-readiness`; it keeps the same sandbox allowlist contract, requires model routing with a base URL plus either a server-wide or tenant-scoped API key, requires signed issue-comment webhook configuration alongside issue comment sync, requires control-plane issue URL configuration for evidence links, requires workspace Git transport/PR handoff via `git.pr` plus a workspace PR reporter, exposes provider-derived `controlPlaneGitTransport.sampleRemoteUrl` evidence, requires workspace branch lease readiness for run-scoped worktrees and run-suffixed PR branch derivation, requires tenant-scoped control-plane agent identity such as `--tenant-control-plane-token-env`, exposes machine-readable `readiness`, `readiness.goldenPath`, `server.runCreateIdempotency`, `server.concurrencyAdmission`, and `visionLock` checklists in `GET /status`, and makes smoke run the external readiness checks too.

Before starting a shared service, run `loom harness doctor` with the same `serve` flags. It does not start the server or contact external systems; it counts CLI `--tenant-key-env`/`--tenant-key` entries and policy-backed tenant `apiKeys` toward role readiness without echoing token material, reports the same port/numeric flag validation, executor configuration, local-executor safety, run-create idempotency, workspace-branch lease readiness, and control-plane token/webhook env gates that `serve` enforces, returns JSON with `ok`, `missing`, per-check details, `recommendedFlags`, `visionLock`, `controlPlane.boundary`, `controlPlane.apiBasePath`, `controlPlane.discoveryEndpoints`, `controlPlane.nativeCapabilities`, `controlPlane.adoptionStages`, profile `goldenPath`, and the same provider-derived Git transport sample remote evidence as status readiness, and exits non-zero when a requested profile is incomplete or the requested `serve` flags would be refused.

For operator or CI handoff, `loom harness platform-cutover-plan` accepts the same `platform-preflight` shape and emits a read-only, token-free JSON plan with `commandOrder`, stage metadata, `externalEnvironment` system/env-var inventory, generated argv, and AGS compatibility/provisioning commands when `--control-plane-provider agent-git-service` is selected. Pass `--out plan.json --bundle-out cutover-bundle` to write the plan and operator bundle in one token-free command. Real AGS staging bundles can set the generated read/write probe target with `--agent-git-service-staging-issue`, `--agent-git-service-staging-repo`, `--agent-git-service-staging-wiki-page`, `--agent-git-service-native-write-workspace-id`, `--agent-git-service-native-write-attachment-url`, and `--agent-git-service-native-write-wiki-note` instead of relying on the default smoke issue; the resolved target is also archived as `externalEnvironment.systems.agentGitServiceStaging`. If an imported hand-written plan has AGS readiness or native-write argv but no `agentGitServiceStaging` system entry, `platform-cutover-bundle` derives the same token-free target from that argv before writing bundle `plan.json` and `staging-ci.json`; pre-serve checks require native write target fields only when the native write stage is present. The plan labels every stage with `executionMode`, `requires`, and `approvalRequired`, so automation can run read-only/dry-run/verification stages only after their external evidence is satisfied while keeping `serve`, AGS apply, and the AGS native write check behind explicit operator approval. `externalEnvironment.requiredVariables` lists only env var names, uses, and required stages for LiteLLM, Coder/control-plane integration, tenant auth, and AGS/Gitea tokens; it never includes secret values.

`--bundle-out` and `loom harness platform-cutover-bundle --plan plan.json --out cutover-bundle` both export the token-free plan, manifest, env checklist markdown, sourceable `env.sh` shell template, `external-secrets.json` CI secret-store manifest, `github-actions-staging.yml` workflow template, executable command script, and `staging-ci.json`. The CI handoff manifest uses schema `platform-staging-ci/v1` and records strict pre/post serve commands, required env names, external target inventory, expected reports, jq checks, and `operatorApprovals` for approval-required mutating stages without secret values; its post-serve checks now include `platform-concurrency-audit/v1`, `platform-ci-run-proof/v1`, `platform-goal-audit/v1`, and the final `platform-operator-status/v1`, so run-scoped workspace leases, run-suffixed branch leases, multi-agent smoke proof, AGS project-agent token injection, strict external staging, GitHub Actions run evidence, operator approvals, and the original multi-user online sandbox target are archived as machine gates. In post-serve mode `commands.sh` writes `serve-ready`, cutover/smoke, `concurrency-audit`, GitHub Actions `ci-run-proof` when running inside Actions, operator artifacts, staging proof, `goal-audit`, and `operator-status`; final verification requires the concurrency audit and CI run proof reports to be `ok` and hash-anchors them through `operator-artifacts.json` / `staging-proof.json`, then `goal-audit` verifies the full cutover target and `operator-status` records `production-cutover-ready` after those proofs exist.
For AGS staging readiness, those gates now include upstream `/readyz` `serverReadiness` in addition to discovery, issue workspace, issue comment, and wiki memory checks.
`manifestFileMismatches` rejects manifests whose `files` list no longer contains the full operator payload in order, so payload files cannot be omitted from hash/secret scanning.
`manifestHashMissingFiles` rejects manifests that list payload files without a corresponding `fileSha256` entry.
For AGS bundles, the payload also includes `upstream-agent-git-service.json` (`upstream-agent-git-service-staging-guide/v1`), a token-free handoff that records the upstream repo, `gh-server` binary, `/api/v3` base path, `DB_DSN` server env name, Loom env names, staged AGS issue/repo/wiki/write target, and a structured upstream/Loom/pre-serve/serve/post-serve `operatorChecklist`; the manifest hashes it and bundle verification scans it like the rest of the operator payload. `loom harness upstream-agent-git-service-handoff --dir cutover-bundle --report cutover-bundle/reports/upstream-agent-git-service-handoff.json` turns that guide into a token-free `upstream-agent-git-service-handoff/v1` report with guide, server env, Loom env, checklist, and secret-scan gates.
`platform-cutover-bundle-verify` also reports `upstreamAgentGitServiceHandoffMismatches` when that handoff no longer matches the current plan's AGS control-plane URL, token env names, staged target, or required upstream `DB_DSN` metadata.
Before real external staging, `loom harness platform-staging-prerequisites --dir cutover-bundle --require-agent-git-service --report cutover-bundle/reports/staging-prerequisites.json` can be run manually as a token-free operator-shell gate. Strict external `commands.sh` first writes `reports/upstream-agent-git-service-handoff.json`, then runs the prerequisites gate before pre-serve stages, writes `reports/staging-prerequisites.json`, and has strict artifact/proof checks hash-anchor both reports. The reports check bundle integrity, strict commands, required env-name presence, `LOOM_BIN`, `jq`, external targets, and the upstream AGS handoff/server env names without printing secret values.

`staging-ci.json.operatorApprovals[]` also carries each approval stage's `requires`; `platform-operator-approvals` reports missing requirement proof through `missingRequirementReports`, per-approval `missingRequirements`, and `gates.allRequirementsSatisfied`.
Generated approval commands start with `"${LOOM_BIN:-loom}"`, so CI jobs can reuse the same executable path or command-name override as `commands.sh`; source-tree execution should use a small executable wrapper script rather than a multi-word `LOOM_BIN` value.

Strict staging proof also cross-checks each approval summary entry against `staging-ci.json.operatorApprovals[]` for stage id, gate id, evidence, command, selected stage evidence, `executed` stage evidence with `ok: true`, and required `requires`, so a hand-written summary cannot drop a change-window requirement or reuse a failed or wrong-stage run report while keeping the same report name.
It also compares `operator-artifacts.json` report hashes against the current report files, including approval run reports from `staging-ci.json.operatorApprovals[]` even if `expectedReports` was hand-edited, so an old operator artifact cannot anchor a changed preflight, AGS compatibility report, native-write proof, or approval summary by name alone.
It also rejects any present required report whose `ok` flag is not true, and rechecks the `platform-staging-run/v1` report refs against current report sha256 values before accepting the proof.
Generated post-serve jq checks also require strict final artifacts: `operator-artifacts.json` must record `requireExternalStaging: true`, and `staging-proof.json` must record both `requireExternalStaging: true` and `requireOperatorApprovals: true`, be token-free, have empty `missing`/`missingReports`/`forbiddenValueHitReports`, pass operator artifact/post-serve/approval gates, and include hash-anchored `reports.stagingCiExpectedReports`.
`platform-cutover-bundle-verify` reports `stagingCiStrictCommandMissing` and fails if `staging-ci.json.commands.{preServe,postServe,all}` drop the strict external/approval/JQ-check envs or `./commands.sh`, even when `manifest.json` hashes were updated to match the edited handoff.
It also reports `commandsShStrictCheckMissing` if `commands.sh` drops the strict env defaults, the early `jq` prerequisite gate, jq-check runner, pre/post CI check calls, or strict artifact/proof arguments.
`manifestStageIdMismatches` rejects manifests whose `stageIds` no longer match the current `plan.json` stage order.
`stagingCiExpectedReportMissing` rejects `staging-ci.json.expectedReports` that omit reports implied by the current plan's pre/post stages.
`stagingCiOperatorApprovalMismatches` rejects `operatorApprovals[]` entries that no longer match approval-required mutating stages, including gate id, command, report path, and `requires`.
`stagingCiCheckMissing` rejects `staging-ci.json.checks` that omit generated pre/post serve jq gates for the current plan.
`agentGitServiceCompatTargetMismatches` rejects AGS plans whose compat stage `--candidate-url` points at a different AGS control-plane target than `externalEnvironment.systems.controlPlane.baseUrl`.
Strict external AGS compat also rejects `agent-git-service-compat/manifest.json` when `candidateBaseUrl` does not match the staged AGS control-plane target after `/api/v3` normalization, so a different upstream service cannot satisfy this cutover gate.
Pre-serve staging evidence also rejects `agent-git-service-staging-readiness.json` when its upstream `serverReadiness` is not ready or its `baseUrl` no longer matches `staging-targets.json.targets.controlPlane.baseUrl`.
Final artifact verification also rejects `agent-git-service-native-write-check.json` when its approved write `baseUrl` no longer matches the staged AGS control-plane target.
When `agentGitServiceStaging.nativeWriteAttachmentUrl` is present, final artifact verification also requires `agent-git-service-native-write-check.json.attachmentUrl` to match that declared evidence URL. When `nativeWriteWikiNote` is present, `staging-targets.json` records its sha256 and the native-write report must include the same `wikiMemory.noteSha256`.
Strict approval verification also requires each approval run report to list the expected stage in `selectedStageIds` and include the same stage in `executed` with `ok: true`; `platform-operator-approvals/v1` exposes mismatches as `stageMismatchReports` and `gates.allStagesExecuted`.

The bundle also includes token-free `env.sh`, `external-secrets.json`, and `github-actions-staging.yml`: `env.sh` exports the declared env names without values, `external-secrets.json` records the same required env inventory, `ci-secret-store` provider hint, and source command for CI secret injection, and `github-actions-staging.yml` maps those env names to GitHub Actions `secrets.<NAME>` while running the strict pre/post/all bundle commands. The workflow exposes `loom_bin`, defaulting to `loom`, `bundle_dir`, defaulting to `cutover-bundle`, and `node_version`, defaulting to `22`; it uses `bundle_dir` for the bundle working directory and uploaded report path. When `bootstrap_source_tree` is true it uses `actions/setup-node`, runs `npm ci`, builds the checkout, writes `loom-wrapper`, and points `LOOM_BIN` at that wrapper. It also sets a workflow concurrency group of `loom-strict-staging-${{ github.ref }}-${{ inputs.phase }}` with `cancel-in-progress: false`, so duplicate staging clicks for the same ref and phase queue instead of overwriting reports. Before the real handoff, run `loom harness platform-ci-handoff-preflight --dir cutover-bundle --repo <owner/repo> --ref <branch> --report cutover-bundle/reports/ci-handoff-preflight.json` to check the local bundle files, `external-secrets.json`, `gh auth status`, `gh repo view`, `gh workflow view`, and `gh secret list --app actions` without storing command output; if the configured GitHub CLI is missing it reports only `github.cli` before downstream auth/repo/secret probes. The report records required/present/missing required env names plus token-free `gh secret set` command args for missing required names, never secret values or unrelated repository secret names. When `github.workflow` is missing, copy/install the workflow, commit it, and push it to the target ref before dispatching; when `github.secrets.requiredEnv` is missing, create those GitHub Actions repository secrets before dispatching. Run `loom harness platform-ci-handoff-run --dir cutover-bundle --repo <owner/repo> --ref <branch> --phase post-serve --preflight --report cutover-bundle/reports/ci-handoff-run.json` to preflight, install `.github/workflows/github-actions-staging.yml`, dispatch the workflow, wait for it, sync the `loom-staging-reports` artifact, import allowed reports, and write a final operator status snapshot without storing `gh` output. The one-command flow and the fallback `platform-ci-workflow-dispatch`, `platform-ci-workflow-wait`, and `platform-ci-artifact-sync` commands carry the same `--repo`; dispatch and preflight also carry `--ref`, so checking, dispatching, waiting, and artifact download target the same repository. If `--ref` is omitted, a successful preflight lets `platform-ci-handoff-run` use the repository default branch from `gh repo view` for dispatch, run listing, waiting, and artifact sync. Workflow dispatch run-id discovery filters `gh run list` to `workflow_dispatch` and the target ref, reducing false matches in busy repositories. If a later step fails after dispatch or wait, rerun the same command with `--resume` to reuse matching successful `ci-workflow-dispatch.json` and `ci-workflow-wait.json` instead of creating another GitHub Actions run; resume reuse is accepted only when the saved dispatch/wait reports match the current phase and GitHub target repo/ref. The same flow is still available as separate audited steps: `platform-ci-handoff-preflight` writes `ci-handoff-preflight.json`, `platform-ci-handoff-install` writes `ci-handoff-install.json`, `platform-ci-workflow-dispatch` writes `ci-workflow-dispatch.json`, `platform-ci-workflow-wait` writes `ci-workflow-wait.json`, and `platform-ci-artifact-sync` writes `ci-artifact-sync.json` plus `ci-artifact-import.json`. In GitHub Actions, `commands.sh` records token-free `reports/ci-run-proof.json` with the run id, run URL, phase, bundle workflow sha256, and installed checkout workflow sha256; an install report inside the checkout is optional, but if present it must match. If the artifact was already downloaded, use `loom harness platform-ci-artifact-import --dir cutover-bundle --artifact-dir <downloaded-artifact-dir> --phase post-serve --report cutover-bundle/reports/ci-artifact-import.json` as the offline fallback; it imports from either the artifact root or a nested `reports/` directory and ignores extra files. Operator status and final strict `ciHandoffReady` require the local install report plus the CI run proof to match the bundle template and the workflow currently installed on disk. `manifest.json`, bundle verification, and report hash checks cover all three files and `staging-ci.json` like the other payload files. Post-serve runs also write token-free `reports/serve-ready.json`, and final artifact verification requires `gates.serveReadyOk` before accepting cutover/smoke evidence.

Before starting a real external pre-serve run, `loom harness platform-external-staging-audit --dir cutover-bundle --report reports/external-staging-audit.json` gives a token-free gap list across bundle integrity, required env-name presence, external target classification, `staging-prerequisites.json`, strict pre-serve evidence, `staging-run.json`, and the serve-start verdict. Strict external `commands.sh` writes it automatically after `staging-run`; final artifacts, staging proof, and goal audit hash-anchor it so the operator-readable pre-serve audit cannot be skipped or replaced by an old file.
At any point in the handoff, `loom harness platform-operator-status --dir cutover-bundle --require-external-staging --require-operator-approvals --require-agent-git-service --report cutover-bundle/reports/operator-status.json` writes a token-free `platform-operator-status/v1` rollup. It reads `staging-ci.json`, `plan.json`, the current reports, `github-actions-staging.yml`, `external-secrets.json`, and the live `platform-goal-audit` result to classify the bundle as `prepare-pre-serve`, `ready-for-serve`, `run-post-serve-proof`, or `production-cutover-ready`, then prints the next strict pre-serve, manual serve, post-serve command, CI handoff preflight command, CI handoff-run command, CI workflow install command, audited workflow dispatch/wait commands, artifact sync/import commands, and GitHub Actions `workflow_dispatch` phase without weakening the final goal gate. On checkouts without a GitHub remote, or when overriding stale preflight target discovery, pass `--repo <owner/repo> --ref <branch>` directly to `platform-operator-status`, `platform-operator-cockpit-plan`, `platform-operator-cockpit-next`, or `platform-operator-cockpit-loop`; the browser cockpit exposes the same values as optional `repo`/`ref` inputs and the HTTP refresh/execute endpoints accept them through query/body fields. The explicit target propagates into CI preflight, handoff-run, workflow dispatch/wait, artifact sync, and copyable `gh workflow run` command refs. Its `ciHandoff` block records the workflow file, sha256, required secret env names, workflow concurrency guard, `bundle_dir=cutover-bundle`, `workflowInstall` source/destination plus command steps and `platform-ci-handoff-install` command args for `.github/workflows/github-actions-staging.yml`, installed workflow path/existence/sha256 and `matchesBundle`, install-report path/sha256 and `matchesBundle`, `preflight` including any preflight `missing`, `nextActions`, and required secret env summary, `handoffRun`, `workflowRun` proof path/run URL/sha256 and `matchesHandoff`, `workflowDispatch`, `workflowWait`, `artifactSync`, and `artifactImport` report/command fields, `node_version=22`, `bootstrap_source_tree=true`, and both raw `workflowDispatchCommandArgs` plus copyable `workflowDispatchCommand` for `gh workflow run` without secret values. Strict post-serve `commands.sh` now writes this report after `goal-audit` and runs a jq check requiring `phase: "production-cutover-ready"` plus `gates.ciHandoffReady`, which now stays red until the installed workflow, `ci-handoff-install.json`, and `ci-run-proof.json` all match the bundle template.

For a CI job that should stop before the manual long-running server, run `LOOM_CUTOVER_PHASE=pre-serve ./commands.sh`; add `LOOM_REQUIRE_EXTERNAL_STAGING=1` when this is a real external staging job, and `LOOM_REQUIRE_OPERATOR_APPROVALS=1` when mutating approval proof should be enforced. Strict external pre-serve exits after writing `reports/staging-prerequisites.json`, `reports/staging-run.json`, `reports/staging-targets.json`, `reports/staging-evidence.json`, `reports/staging-verdict.json`, and `reports/external-staging-audit.json`. The verdict uses schema `platform-staging-verdict/v1`, reports `decision: "ready-for-serve"` only when all pre-serve gates are green, and emits token-free `nextActions` when blocked. After the operator starts `serve`, run `LOOM_CUTOVER_PHASE=post-serve ./commands.sh` to skip the already-approved pre-serve probes, write `reports/serve-ready.json` from `/healthz`, `/readyz`, and `/status`, then run post-serve cutover/smoke, final artifact verification, and `reports/staging-proof.json`. The proof uses schema `platform-staging-proof/v1` to collate staging targets, platform preflight, staging evidence, verdict, staging-run, external staging audit, serve-ready, operator approvals, and operator artifacts; strict mode passes `--require-external-staging` and `--require-operator-approvals` so local rehearsal and missing human approval cannot masquerade as production-ready staging. Strict proof checks both `operator-artifacts.gates.operatorApprovalsOk` and the current `operator-approvals.json` status, reads `staging-ci.json.operatorApprovals[]` as the independent expected-approval list, treats `staging-ci.json.expectedReports` as additional proof inputs recorded under `reports.stagingCiExpectedReports`, requires external preflight subreports to match real LiteLLM/Coder/AGS targets, includes current AGS compat artifacts in `requiredReports`, and requires `operator-artifacts.json` to anchor the prerequisites report, external audit, core proof inputs, AGS compat reports, staging-ci expected reports, plus every expected approval run report after being generated with `requireOperatorApprovals: true`. The final `platform-cutover-artifacts-verify` path also requires and secret-scans the pre-serve files plus `serve-ready.json`, and it fails when the verdict's `evidenceSha256` no longer matches `staging-evidence.json`. Omit the variables, or set `LOOM_CUTOVER_PHASE=all`, to rerun the full flow.

After doctor passes and before `serve`, run `loom harness platform-preflight` with the same serve shape plus a tenant/project/repo and token env names. It aggregates doctor, `model-preflight`, `control-plane-preflight`, and `coder-preflight` into one token-free `platform-preflight/v1` JSON gate with `gates`, `missing`, subreports, `nextCommandsReady`, and generated `cutoverReportCommandArgs`/`smokeCommandArgs` for CI handoff; pass `--report reports/platform-preflight.json` when it is part of a cutover bundle so the final artifact verifier can enforce the same pre-serve gate. Use the individual probes only for focused troubleshooting: the model probe uses the same adapter as model-backed runs, the control-plane probe checks provider catalog discovery endpoints, and the Coder probe exercises template rendering, optional workspace creation, `coder start`, repo/worktree prepare, a remote `coder ssh` probe, and browser IDE/preview URL evidence. Strict pre-serve verification also rejects reports that pass top-level gates but omit `model.checks.modelUsage`, numeric usage/cost evidence, or Coder `prepare`, `remoteCommand`, and `browserUrls` check evidence. `loom harness control-plane-preflight --control-plane-provider agent-git-service --report ags-preflight.json` persists that token-free AGS compatibility result for CI artifacts or upstream `ngaut/agent-git-service` comparison without storing token values; for AGS it includes a stable `compatibilityReport.schemaVersion` (`agent-git-service-contract-probe/v1`) plus read-only/Bearer metadata for later diffing. `loom harness agent-git-service-staging-readiness --control-plane-url <upstream-ags-url> --control-plane-token-env <env> --issue <owner/repo#number> --repo <owner/repo> --report ags-staging.json` checks unauthenticated upstream `/readyz` `serverReadiness`, then reads discovery, issue workspaces, issue comments, and wiki memory into a token-free report without creating PRs or comments. After `serve` is running and an operator approves side effects, `loom harness agent-git-service-native-write-check --control-plane-url <upstream-ags-url> --control-plane-token-env <env> --issue <owner/repo#number> --repo <owner/repo> --workspace-id <workspace-id> --attachment-url <public-evidence-url> --approve-mutating --report ags-native-write.json` verifies issue comment, workspace attachment, and wiki-memory write paths without printing token values. After recording a contract-baseline report and an upstream candidate report, run `loom harness agent-git-service-compat-compare --baseline ags-contract.json --candidate ags-upstream.json --report ags-compare.json`; it exits non-zero on endpoint or native-capability drift while still writing a token-free comparison artifact. For a one-command rehearsal, `loom harness agent-git-service-compat-rehearsal --out ags-compat` generates local contract baseline/candidate/compare artifacts; add `--candidate-url <upstream-ags-url> --candidate-token-env <env>` to compare the local contract baseline against a real upstream candidate without echoing the token.

After `serve` is running, `loom harness cutover-report --url <server> --tenant <tenant> --token-env <env>` reads server and tenant readiness as a read-only operator summary before the expensive smoke. It recomputes required golden-path and vision-lock capabilities from the shared contract instead of trusting `ok: true` alone, and it validates `server.concurrencyAdmission` for the server and tenant views so active-run leases, tenant caps, queue blockers, and cross-server run control remain visible before cutover. With `--control-plane-provider agent-git-service --admin-token-env <env>`, it also reads the admin-only AGS provisioning plan and exits non-zero until project-agent receipts/secrets are ready; output contains `missing`, `nextActions`, token-free per-project plan evidence, and structured AGS provisioning plan/apply argv fields for CI. When given the smoke inputs (`--project`, `--isolation-tenant`, viewer/admin/webhook env names), it also emits `smokeCommandArgs` for CI or operator scripts.

After cutover and smoke reports exist, `loom harness platform-concurrency-audit --cutover-report reports/cutover-report.json --smoke-report reports/smoke.json --require-agent-git-service --report reports/concurrency-audit.json` produces a token-free `platform-concurrency-audit/v1` gate for multi-user/multi-agent readiness. It requires run-scoped workspace leases, run-suffixed branch lease evidence, multi-agent smoke proof, and AGS project-agent token injection before an AGS-backed concurrent sandbox rollout is considered ready. After final artifacts and staging proof exist, `loom harness platform-goal-audit --dir cutover-bundle --require-external-staging --require-operator-approvals --require-agent-git-service --report cutover-bundle/reports/goal-audit.json` produces a token-free `platform-goal-audit/v1` report that stays red until the local MVP proof, current strict staging prerequisites, current strict `staging-run.json`, current `external-staging-audit.json`, staging proof hash anchoring for those pre-serve reports plus current operator artifacts, approvals, and CI proof, strict-mode operator artifacts, operator-artifacts hash anchoring for the current pre-serve reports and current cutover/smoke/concurrency/CI/cockpit-runner execute reports, CI proof run-id matching any audited post-serve workflow dispatch/wait report, strict external staging, human approval proof, AGS provider evidence, and production cutover gate are all true; bundle post-serve scripts run it automatically and then write `operator-status.json` as the final operator-readable rollup.

For the shortest operational path from preflight to smoke, AGS onboarding, and cutover decision, use [docs/operator-runbook.md](docs/operator-runbook.md).

Before wiring real Coder/Gitea/LiteLLM instances, `loom harness rehearsal` starts an in-process local platform server, fake model gateway, Coder-shaped local executor, tenant keys, reporter hooks, runs the read-only cutover report, and then runs the full `platform-readiness` smoke. It is the fastest repeatable proof that the multi-user sandbox, VAS-lite learning, human gates, run-scoped concurrency, metrics/probes, backup dry-run, and control-plane comment/PR surfaces still compose. Add `--peer-server` to start a second harness server sharing the same workspace root and require cross-server active-run lease, pause, cancel, and idempotent-create evidence. Add `--control-plane-provider agent-git-service` to exercise the local AGS candidate path too; that rehearsal spins up the shared contract-backed local AGS `/api/v3` server, provisions a stored project-agent token through the harness admin endpoint, generates a `platform-cutover-plan`, exports and verifies a token-free operator bundle under `.loom/operator-cutover-bundle`, runs the safe stages from the exported bundle plan including AGS compat and staging readiness, writes rehearsal bundle/run/platform-preflight/AGS staging/staging-targets/cutover/smoke reports under `.loom/operator-cutover-bundle/reports/`, explicitly approves both AGS mutating gates, writes `reports/operator-approvals.json`, runs strict final `platform-cutover-artifacts-verify` to produce `reports/operator-artifacts.json`, writes `reports/staging-proof.json`, emits a token-free `operatorArtifactSummary` (`loom-operator-artifacts/v1`) with report hashes plus explicit doctor/model/control-plane/Coder preflight gates, `preServeEvidenceOk`, `operatorApprovalsOk`, `operatorArtifactsVerifyOk`, and `agentGitServiceStagingReady` coverage, and requires AGS cutover plus native handoff/wiki-memory projection evidence without printing token material.

Smoke-test a running server:

```bash
loom harness smoke \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --project smoke \
  --template vas-lite
```

For authenticated tenants, prefer an env var:

```bash
LOOM_SMOKE_TOKEN=dev-secret LOOM_SMOKE_VIEWER_TOKEN=read-secret LOOM_SMOKE_ADMIN_TOKEN=admin-secret loom harness smoke \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --project smoke \
  --token-env LOOM_SMOKE_TOKEN \
  --viewer-token-env LOOM_SMOKE_VIEWER_TOKEN \
  --admin-token-env LOOM_SMOKE_ADMIN_TOKEN \
  --isolation-tenant bob \
  --profile online-sandbox
```

The smoke command creates or reuses the project, checks `vas-lite` project `contractStatus` before the run when `--template vas-lite` is used, runs a tiny scripted harness run, reads back the summary/events, verifies the run artifact through the workspace file API, verifies the project workspace context/executor kind, verifies that the same token cannot read `--isolation-tenant` when supplied, optionally verifies the one-shot workspace command endpoint with `--check-command`, optionally verifies a persistent workspace session with `--check-session`, optionally verifies the `vas-lite` bootstrap case, review queue, review package, a real `vas-lite-review` preset run, generated report/context artifacts, a review-required VAS run, case approval, project learnings, and learned-patterns persistence with `--check-vas`, optionally verifies Dashboard/Workbench HTML, dashboard tenant/global readiness labels, Dashboard AGS provisioning controls, Dashboard project concurrency controls, project/run collaborator presence, and durable run comment replay with `--check-online`, optionally verifies stale project and run workspace file save/move/delete conflicts plus active same-file editor evidence with `--check-file-collab`, optionally verifies developer/viewer role boundaries and viewer-readable tenant `readiness`/`readiness.goldenPath`/`visionLock` with `--check-auth-roles` and `--viewer-token-env`, optionally verifies review and admin-only deployment gates with `--check-gates` and `--admin-token-env`, optionally verifies admin-approved policy escalation with `--check-escalations` and `--admin-token-env`, optionally sets project source defaults, verifies the source run and handoff follow-up inherit them, verifies review-summary/handoff-package contract evidence, starts a handoff follow-up run, and verifies approved contract patches in review summary, handoff gate trail, and replay with `--check-handoff`, optionally verifies control-plane PR creation through a review-gated run with `--check-control-plane-pr`, optionally verifies control-plane issue comment sync can approve a review-gated run with `--check-control-plane-comments`, and when `--control-plane-webhook-secret-env` or `--gitea-webhook-secret-env` is supplied also signs a control-plane webhook that approves a second review-gated run, optionally verifies the admin-only tenant control-plane backup/migration manifest and restore dry-run with `--check-backup`, optionally verifies low-cardinality Prometheus metrics with `--check-metrics`, optionally verifies Coder workspace context plus browser IDE/preview links with `--check-coder`, optionally verifies async pause/resume/cancel controls plus active-run workspace lease scope/key evidence with `--check-run-controls` and, when `--peer-url` is supplied, also verifies the peer can see the same active-run lease, sends pause/cancel requests through that peer instance, and posts simultaneous `clientRequestId` run creates through both instances to prove owner-loop cross-server delivery plus idempotent replay, and prints dashboard, summary, and event URLs without echoing the token. `--profile online-sandbox` requires `--isolation-tenant`, first requires `GET /status` to report the same server profile, required server allowlist, role-based tenant auth covering `admin`/`developer`/`viewer`, a Docker/Coder sandbox executor, persistent home state (`--executor-home-root` for Docker), `readiness.ok: true`, `readiness.goldenPath.ok: true`, and complete `readiness.goldenPath` plus `visionLock` capability sets, then requires `GET /tenants/:tenant/status` to report the tenant's effective required allowlist, matching `readiness.ok: true`, matching `readiness.goldenPath.ok: true`, and the same complete `visionLock` target/capability set before enabling all of those online sandbox checks (`--check-command`, `--check-session`, `--check-vas`, `--check-online`, `--check-file-collab`, `--check-auth-roles`, `--check-gates`, `--check-escalations`, `--check-handoff`, `--check-run-controls`, and `--check-metrics`). `--profile platform-readiness` requires `--isolation-tenant`, enables the same checks plus `--check-brain`, `--check-model`, `--check-control-plane-pr`, `--check-control-plane-comments`, `--check-backup`, and `--check-coder`; its status readiness requires the online sandbox executor/home/role-auth checks, model base URL plus a configured global, tenant, or policy model key env, PR reporting, control-plane issue URL evidence links, workspace Git transport/PR handoff, tenant-scoped control-plane agent identity, issue comment sync, signed webhook configuration, brain ingest, `executorKind: "coder"`, and the same `readiness.goldenPath`/`visionLock` guard. Pass the same webhook secret env to smoke so platform-readiness actively exercises signed webhook push, not only server readiness. Successful profile smoke output includes server/tenant/viewer golden-path fields plus `healthProbesChecked`, `readyzReady`, `healthProbesSensitiveFieldsAbsent`, `metricsChecked`, `metricsReady`, `metricsLowCardinalityChecked`, `metricsSensitiveLabelsAbsent`, `dashboardAgentGitServiceProvisioningChecked`, `dashboardProjectConcurrencyChecked`, `onlineSandboxGoldenPathChecked`, `onlineSandboxGoldenPathProfile`, `onlineSandboxGoldenPathCapabilities`, `sourceDefaultsChecked`, `handoffFollowupSourceDefaultsChecked`, `runScopedFileWriteDuringActiveRunChecked`, `activeRunLeaseChecked`, `activeRunLeaseScope`, `activeRunLeaseKey`, `controlPlaneCommentsWebhookChecked`, `backupManifestChecked`, and `backupRestoreDryRunChecked` so CI can assert the multi-user isolation, online workspace, harness-loop, source-default handoff, signed control-plane push, backup/migration manifest, anonymous health probe, low-cardinality metrics, VAS learning, human-gate, AGS project-agent operator entrypoint, project-concurrency operator entrypoint, and run-control path as one contract. `--check-command`, `--check-session`, and `--check-run-controls` require the effective allowlist to include `shell.exec`; `--check-handoff` requires `git.diff`; use them only against isolated sandboxes started with `--allow-shell` or an equivalent explicit allowlist. `--check-vas` requires `--template vas-lite`.
Profile smoke also validates provider catalog `adoptionStages` on both server and tenant status, emits `serverControlPlaneApiBasePath`, `serverControlPlaneDiscoveryEndpoints`, `serverControlPlaneNativeCapabilities`, `serverControlPlaneAdoptionStages`, `serverControlPlaneGatedAdoptionStages`, `serverControlPlaneTenantDefaultCutoverGated`, `serverControlPlaneDiscovery*`, including token-free discovery `tokenMode` and tenant aggregate counts, `tenantControlPlaneProvider`, `tenantControlPlaneAdoptionStages`, `tenantControlPlaneGatedAdoptionStages`, `tenantControlPlaneTenantDefaultCutoverGated`, `tenantControlPlaneDiscovery*`, `controlPlaneWorkspaceBranchLeaseChecked`, `controlPlaneWorkspaceBranchLeaseProvider`, `controlPlaneWorkspaceBranchLeaseIsolation`, `controlPlaneWorkspaceBranchLeaseBranchDerivation`, and `controlPlaneWorkspaceBranchLeaseActiveRunLeaseEvidence`, and fails with `SMOKE_TENANT_CONTROL_PLANE_PROVIDER_MISMATCH` if tenant-visible provider evidence drifts from server status. CI and `cutover-report` can assert the provider-neutral workspace branch lease seam, runtime AGS discovery probe, AGS native capability seam, tenant-visible gated AGS adoption path, provider consistency, and tenant-scoped AGS cutover readiness without binding to Gitea naming or leaking another tenant's missing project-agent state.
Metrics smoke also emits `metricsReviewRequiredRuns`, `metricsDeploymentRequiredRuns`, `metricsModelUsageWarningProjects`, and `metricsWorkspaceUsageWarningProjects` so CI can watch gate backlog and resource-warning pressure without tenant/project/run labels. When `--check-gates` runs with metrics enabled, smoke also records `reviewGateMetricsChecked` and `deploymentGateMetricsChecked` after observing the review/deployment gates while they are still pending. When `--check-model` runs with metrics enabled and an admin token is available, smoke lowers warning thresholds after the model run and records `modelWarningMetricsChecked`, `modelWarningQueueChecked`, `workspaceWarningMetricsChecked`, and `workspaceWarningQueueChecked` after `/metrics` and the tenant warning queues report non-zero warning pressure. It also records `modelWarningEscalationChecked`, `workspaceWarningEscalationChecked`, and `warningEscalationAuditChecked` after creating warning-sourced policy escalation requests from those queues.
When `--check-backup` runs, successful smoke output also includes `backupRestoreDryRunAuditChecked` after reading the tenant audit evidence for the restore dry-run; when the dry-run target is `agent-git-service`, it also emits `backupRestoreDryRunCutoverReady` plus `backupRestoreDryRunAgentGitServiceProjectAgents*` receipt/secret readiness fields.

`platform-readiness` also requires run-scoped workspace isolation: server and tenant status must expose `server.runWorkspaceIsolation: "run"` and `readiness.checks.runWorkspaceIsolation.ok: true`, and `readiness.checks.controlPlaneWorkspaceBranchLease.ok` must prove the provider-neutral branch lease seam is present. Successful profile smoke output includes `serverRunWorkspaceIsolation` and `tenantRunWorkspaceIsolation` so CI can catch accidental fallback to project-level locking, plus `runScopedFileWriteDuringActiveRunChecked` to prove same-run file writes are blocked while other isolated runs can still edit, and `runScopedPullRequestDuringActiveRunChecked` with derived branch evidence so CI catches regressions where one completed run's PR handoff is blocked by another active isolated run or reuses a shared default branch.
Multi-agent concurrency smoke update, 2026-07-01: platform-readiness now also emits `multiAgentConcurrencyChecked` when those scattered lease/file/PR checks compose into the intended concurrency contract. The result includes `multiAgentConcurrencyIsolation`, `multiAgentConcurrencyActiveRunLeaseChecked`, `multiAgentConcurrencyRunScopedFileWriteChecked`, `multiAgentConcurrencyRunScopedPrHandoffChecked`, and `multiAgentConcurrencyBranch`, and adds `multi-agent-concurrency` to `onlineSandboxGoldenPathCapabilities`; when smoke runs against a `--peer-url`, the same aggregate requires cross-server active-run lease and `clientRequestId` replay evidence too.
`loom harness doctor --profile platform-readiness` checks the same preconditions before `serve`: valid port, timeout, session/run limit, and executor resource flags; executor-required flags such as Docker `--executor-image` or Coder `--executor-workspace`; Coder executor/worktree mode; model key env; CLI env-name or policy-backed role-based tenant keys; control-plane PR/comment/webhook/merge flags; `git.pr`; workspace-branch lease evidence; tenant-scoped control-plane token envs; webhook secret env; and brain ingest. Missing envs and configured control-plane token readiness are reported by name only, without token or secret values; `checks.controlPlaneEnvValidation` includes `tokenMode`, shared `tokenEnv`, or tenant-scoped `tenantTokenEnvNames` for CI assertions, and `checks.controlPlaneWorkspaceBranchLease` records provider, run isolation, run-suffixed branch derivation, and active-run lease evidence. Its JSON also includes the shared `visionLock`, provider-neutral `controlPlane.boundary`, provider catalog `apiBasePath`/`discoveryEndpoints`/`nativeCapabilities`/`adoptionStages`, and the online-sandbox `goldenPath`, so CI can assert that preflight is still guarding the long-term multi-user harness-loop target and future provider-adapter boundary.

When `--check-online` fails because dashboard readiness labels are missing, stderr includes `SMOKE_ONLINE_READINESS_LABELS_MISSING` plus JSON `details` with the expected and missing labels. The same check keeps the brain feed visible in the online surfaces and keeps query-token login one-shot; missing Dashboard or Workbench brain feed markers emit `SMOKE_ONLINE_BRAIN_UI_MISSING`, and missing token-scrub markers emit `SMOKE_ONLINE_TOKEN_SCRUB_MISSING`.
Profile readiness failures use the same format: server profile mismatches emit `SMOKE_SERVER_PROFILE_MISMATCH`, server readiness gaps emit `SMOKE_SERVER_READINESS_MISSING`, tenant readiness gaps emit `SMOKE_TENANT_READINESS_MISSING`, and readiness profile mismatches include `*_READINESS_PROFILE_MISMATCH`.
Platform run-isolation failures emit `SMOKE_SERVER_RUN_WORKSPACE_ISOLATION_REQUIRED` or `SMOKE_TENANT_RUN_WORKSPACE_ISOLATION_REQUIRED`; invalid status values emit `*_RUN_WORKSPACE_ISOLATION_INVALID`.
Profile golden-path failures emit `SMOKE_PROFILE_ISOLATION_TENANT_MISSING` when `--profile` lacks `--isolation-tenant`, `SMOKE_SERVER_GOLDEN_PATH_MISSING` or `SMOKE_TENANT_GOLDEN_PATH_MISSING` when status `readiness.goldenPath` is absent or incomplete, `SMOKE_SERVER_GOLDEN_PATH_INVALID` or `SMOKE_TENANT_GOLDEN_PATH_INVALID` when its arrays are malformed, and `SMOKE_ONLINE_SANDBOX_GOLDEN_PATH_MISSING` when one of the required profile capabilities was not exercised.
Profile tool allowlist failures emit `SMOKE_SERVER_TOOLS_MISSING` or `SMOKE_TENANT_TOOLS_MISSING` with JSON `details.missingTools` and `details.requiredTools`.
Invalid profile arrays emit `SMOKE_SERVER_TOOLS_INVALID`, `SMOKE_TENANT_TOOLS_INVALID`, `SMOKE_SERVER_READINESS_INVALID`, `SMOKE_TENANT_READINESS_INVALID`, `SMOKE_VISION_LOCK_CAPABILITIES_INVALID`, or `SMOKE_TENANT_VISION_LOCK_CAPABILITIES_INVALID` with JSON `details.field` and `details.invalidItems`.
Vision lock drift emits `SMOKE_VISION_LOCK_TARGET_MISMATCH`, `SMOKE_VISION_LOCK_SCOPE_REDUCTION`, or `SMOKE_VISION_LOCK_CAPABILITIES_MISSING` for server status, and `SMOKE_TENANT_VISION_LOCK_MISSING`, `SMOKE_TENANT_VISION_LOCK_TARGET_MISMATCH`, `SMOKE_TENANT_VISION_LOCK_SCOPE_REDUCTION`, or `SMOKE_TENANT_VISION_LOCK_CAPABILITIES_MISSING` for tenant status, with JSON details such as `actualTarget`, `mvpIsScopeReduction`, or `missingCapabilities`, keeping the long-term multi-user online sandbox target visible in smoke automation.
Project contract drift for `vas-lite` smoke runs emits `SMOKE_PROJECT_CONTRACT_DRIFT`; invalid `contractStatus.missing` arrays emit `SMOKE_PROJECT_CONTRACT_INVALID`.
Handoff contract evidence drift emits `SMOKE_HANDOFF_CONTRACT_DRIFT`; invalid handoff contract or contract-patch arrays emit `SMOKE_HANDOFF_CONTRACT_INVALID` or `SMOKE_HANDOFF_CONTRACT_PATCH_INVALID`.
Brain readiness drift emits `SMOKE_BRAIN_RUN_INGEST_MISSING` when completed-run ingest did not record run external-effect or audit evidence, and `SMOKE_BRAIN_SIGNAL_FEED_MISSING` when the tenant brain feed cannot show both completed-run and workspace signal evidence.
Auth role smoke failures emit `SMOKE_AUTH_VIEWER_TOKEN_MISSING` when `--check-auth-roles` lacks a viewer token, `SMOKE_AUTH_VIEWER_ROLE_MISMATCH` when the supplied viewer token reports a non-viewer role, `SMOKE_AUTH_VIEWER_READINESS_MISSING` when the viewer-readable tenant status reports missing readiness, `SMOKE_AUTH_VIEWER_GOLDEN_PATH_MISSING` or `SMOKE_AUTH_VIEWER_GOLDEN_PATH_INVALID` when viewer-readable `readiness.goldenPath` is absent, incomplete, or malformed, `SMOKE_AUTH_VIEWER_VISION_LOCK_TARGET_MISMATCH` when the viewer-readable vision target drifts, `SMOKE_AUTH_VIEWER_VISION_LOCK_SCOPE_REDUCTION` when it reports the MVP as a scope reduction, and `SMOKE_AUTH_VIEWER_VISION_LOCK_CAPABILITIES_MISSING` when required vision capabilities are absent.

`--check-brain` is the explicit M3/brain-readiness check: it verifies the smoke run itself produced completed-run `brain_ingest` external-effect and tenant audit evidence, posts a Stop-hook-style `RunSignal` to `POST /tenants/:tenant/brain/signals`, verifies the response and tenant audit event, then reads `GET /tenants/:tenant/brain/signals?project=<project>` to prove the tenant has a viewer-readable brain feed containing both sources. It requires the server to be started with `--ingest-brain`.

`--check-model` is the explicit LiteLLM/OpenAI-compatible model-readiness check: it starts a model-backed run through the server's configured default model, verifies the generated artifact, confirms model usage accounting, and checks replay contains `model_usage`. It requires the server to be started with `--model-base-url` plus a model/API key configuration.

`--check-control-plane-pr` is the explicit provider-neutral PR-readiness check: it starts a review-gated run with `pullRequest: true`, verifies the created PR metadata, confirms the run events contain the `pull_request` external effect, and emits provider-neutral `controlPlanePr*` smoke fields. Pass `--control-plane-provider <provider>` to make smoke fail with `SMOKE_CONTROL_PLANE_PROVIDER_MISMATCH` if the observed PR evidence comes from a different provider. It requires the server to be started with the provider's PR reporter enabled through `--control-plane-pr`; `--gitea-pr` remains accepted as a compatibility alias for the default Gitea/Forgejo provider. `--check-gitea-pr` remains accepted as a compatibility alias.

`--check-control-plane-comments` is the explicit provider-neutral issue-comment control-plane check: it starts a review-gated issue-linked run, syncs issue comments, verifies a `/loom approve` comment drives the review gate to `passed`, and confirms replay plus audit evidence through provider-neutral `controlPlaneComments*` smoke fields. If `--control-plane-webhook-secret-env` or `--gitea-webhook-secret-env` is supplied to smoke, it also starts a second review-gated run and posts a signed `POST /tenants/:tenant/webhooks/control-plane/issue-comments` payload without a provider query override, verifying webhook-driven review, audit evidence, and `controlPlaneCommentsWebhook*` fields. Pass `--control-plane-provider <provider>` to require the observed issue-comment audit evidence to match that provider too. Platform readiness requires signed issue-comment webhook configuration and should pass the same secret env to smoke, so shared control-plane comments are proven through durable push as well as smoke-triggered sync. It requires the server to be started with issue-comment sync enabled through `--control-plane-comment-sync`; the older `--gitea-webhook-secret-env` and `--gitea-comment-sync` flags remain accepted as compatibility aliases for the default Gitea/Forgejo provider. `--check-gitea-comments` remains accepted as a compatibility alias.

`--check-backup` verifies the admin-only tenant control-plane backup/migration manifest and restore dry-run. It reads `GET /tenants/:tenant/control-plane/backup`, checks the provider-neutral boundary covers the complete control-plane boundary, confirms the project/run/audit checkpoints are present, posts the same manifest to `POST /tenants/:tenant/control-plane/restore-dry-run?targetProvider=<other-serve-provider>`, confirms the dry-run is valid and non-mutating, verifies source/target provider evidence plus the restore dry-run audit event, and fails if known smoke tokens or token hashes appear in the JSON. Pass `--control-plane-provider <provider>` to require the backup manifest source provider to match the expected provider. The target provider is chosen as the other serve-enabled provider, so default Gitea/Forgejo smoke dry-runs toward `agent-git-service`, while `--control-plane-provider agent-git-service` smoke dry-runs back toward `gitea-forgejo`; AGS-target dry-runs also return non-secret `cutoverReadiness.stage: "tenant-default-cutover"` with per-project receipt/secret readiness. It requires `--admin-token` or `--admin-token-env`.

`--check-agent-git-service-cutover` rehearses the AGS project-agent cutover after provisioning. It reads the token-free provisioning receipt, validates the AGS provider and tenant/project refs, then runs a workspace command that only checks whether the receipt's `tokenEnvName` is present in the executor environment. Successful output includes `agentGitServiceCutover*` fields, `agentGitServiceCutoverReceiptSecretAbsent: true`, and a fixed `agent-git-service-cutover-token-ok` marker, never the stored token. `--profile platform-readiness --control-plane-provider agent-git-service` enables this rehearsal automatically and appends `agent-git-service-cutover` to `onlineSandboxGoldenPathCapabilities` in the smoke result.

`--check-coder` is the explicit Coder workspace-readiness check: it verifies both project and run workspace contexts report `executor.kind: "coder"` and expose browser IDE plus preview URLs. It requires the server to be started with `--executor coder`, `--executor-workspace`, and `--executor-ide-url`/`--executor-preview-url`.

Open the dashboard at:

```text
http://127.0.0.1:8787/
```

Dashboard URLs can also prefill a tenant/project or selected run, for example `http://127.0.0.1:8787/?tenant=alice&project=default` or `http://127.0.0.1:8787/?tenant=alice&project=default&runId=<runId>`. A `token` query parameter is accepted for browser-only flows where entering the API key is awkward; Dashboard and Workbench import it, scrub it from the browser URL, and generate navigation links without it.

The dashboard can create empty tenant projects or seed `vas-lite` project skeletons, attach project-level repo/branch/baseBranch/issue defaults, default skills, default run policy, and project contract goals for later runs, show project-level VAS readiness and contract health, model usage warning queues with token/cost budget escalation prefill, workspace usage warning queues with workspace quota escalation prefill, online collaborator focus, active project/run session details plus latest project/run command/session and workspace-change summaries with project-card Open actions, and queued backlog controls, sort projects by latest workspace/run activity, show online terminal session counts, list/create/review VAS cases, load the project-level VAS review queue and case review packages, claim/release VAS review queue work as a visible reviewer signal, start selected VAS case review runs, start local/model-backed or preset-backed runs, set per-run allowed tools, add verification/evaluator commands, attach repo/branch/issue metadata, request PR creation, require human review, require deployment approval, cancel running/queued runs, resume paused runs, claim/release pending run reviews, approve/reject review-gated runs, approve/reject deployment-gated runs, open a run workbench, load a readable run replay, stream selected run events with seq dedupe and browser-native reconnects, send run comments into replay/audit, sync linked Gitea/Forgejo issue comments into replay/audit while surfacing pause/resume/run-review/VAS/handoff-follow-up command outcomes, optionally request a running run to pause after its current step, load review summaries, handoff packages, and lightweight source-to-follow-up lineage, start handoff follow-up runs from selected packages, and request/admin-decide tenant policy escalations. It also shows the current actor/role, run requester identity, heartbeat-refreshed named project collaborators with current focus and project-list online rollups, heartbeat-refreshed run workbench collaborators rolled up onto project cards with Open actions, same-file editing hints in the file editor, current-project activity, source Workbench/package links and audit-refreshed child status for handoff follow-up runs in the run list, summary, and loaded lineage, server limits, profile readiness and golden path readiness, plus global/current-tenant resource and queue health status, per-run queued tenant/project positions and blocked reasons in the run list, per-project queued run ids with Workbench and Cancel actions, per-project review/deploy backlog run ids/goals/claims with Workbench actions, selected project/run workspace executor context and bounded git diff, subscribes to the current tenant audit feed with readable policy/member change summaries and seq-based event dedupe, loads policy and escalation requests, saves model token/cost warning/hard-limit and workspace byte warning/hard-limit settings, creates/browses/edits/moves/deletes workspace files with stale-write recovery, commits workspace checkpoints, hands off workspace PRs using run metadata or project source defaults, requests `git.pr` escalation for PR handoff, runs allowed workspace commands, reopens command history, reopens persistent terminal session transcripts with transcript-resuming SSE output, surfaces `summary.error` in the selected run summary, and quietly refreshes project summaries/backlogs plus model/workspace warning, VAS, run, diff, current-directory file, command, and session views without clearing active workspace errors or overwriting active VAS review drafts when matching project audit events arrive. `viewer` keys get read-only dashboard controls except run comments, issue comment sync, run pause requests, and escalation requests; deployment and policy decisions stay admin-only.

When a selected run receives matching tenant audit events for gate/control changes, PR handoff, comments, issue sync, or follow-up lineage, the dashboard refreshes that run's event list, replay, loaded review summary, loaded handoff package, and loaded follow-up lineage, including child follow-up status changes, quietly so another user's action does not leave the timeline stale and transient refresh failures do not drop already-loaded replay or lineage.

When the selected run event stream receives new `harness_event` entries, an already-open replay panel refreshes quietly; on `finish`, loaded review summary and handoff package panels refresh quietly too.

Run-scoped workspace PR handoffs can also attach review and deployment gates after a run has already passed.

The Dashboard Server panel can load the current project's brain signal feed, and it quietly refreshes that feed when matching brain ingest audit events arrive.

Open a focused run workbench directly:

```text
http://127.0.0.1:8787/workbench?tenant=alice&project=default&runId=<runId>
```

The focused workbench has a run-scoped brain panel, so reviewers can see the completed-run and workspace-signal evidence for that run without digging through the full tenant audit stream.

The workbench is a run-scoped online sandbox surface for summary, requester identity, current actor/role/auth mode, queued-run tenant/project positions and blocked reasons, `summary.error`, review summary, handoff package with changed-file, command, and session Open actions, lightweight source-to-follow-up lineage loading with source Workbench/package links and audit-refreshed status on child runs, handoff follow-up run starts, run review claim/release, run review approve/reject, admin deployment approve/reject, VAS Lite review draft artifacts, case review packages, case claim/release, case review, case run history with PR/gate/artifact evidence, and follow-up review-run starts for `vas-lite-review` runs, visible workspace/executor context and bounded git diff, browser IDE links when exposed by the executor, short-TTL collaborator presence with current focus for files, review summaries, handoff packages, VAS cases, commands, and sessions, same-file editing hints, replay entries with assistant plan/detail text, seq-deduped live run events that quietly keep replay fresh for running/queued runs and refresh run summary plus loaded review summary/handoff package panels on finish, run comments, linked issue comment sync with command outcome feedback, pause requests, running/queued run cancel, orphaned-run abandon fallback after restart, resume, seq-deduped live audit that includes already-loaded follow-up child events, refreshes loaded follow-up lineage without treating child workspace activity as source-run activity, and triggers matching quiet current-run summary/replay/review-summary/handoff-package/VAS/diff/file/command/session plus handoff-followup refreshes without clearing active command errors or replacing already-loaded replay, review summary/handoff package panels, or loaded follow-up lineage on transient failures, version-checked file create/browse/edit/move/delete with reload-latest conflict recovery, command history, one-shot commands, persistent terminal sessions with transcript-resuming SSE output, a context-preserving Dashboard link, and PR handoff-specific `git.pr` escalation requests. It loads the current tenant role before enabling mutable controls and uses the same tenant auth, executor boundaries, and `shell.exec` policy as the HTTP API; `viewer` keys can add run comments, sync linked issue comments, request run pause, and request escalations, while `developer` and `admin` keys can cancel/resume/abandon runs, claim/release pending run reviews, approve/reject review gates, claim/release and review VAS cases, start VAS review runs, save/move/delete files, run commands, and drive terminal sessions. Deployment and policy decisions stay admin-only.

Workbench PR handoff controls include review/deployment gate toggles.

For multi-user/online use, require role-based tenant API keys:

```bash
loom harness serve \
  --workspace-root /tmp/loom-workspaces \
  --port 8787 \
  --profile online-sandbox \
  --executor docker \
  --executor-image loom-workspace:dev \
  --executor-network none \
  --executor-home-root /var/lib/loom-homes \
  --tenant-model-key alice=LOOM_ALICE_MODEL_KEY \
  --tenant-key-env alice=LOOM_ALICE_ADMIN_TOKEN:ops:admin \
  --tenant-key-env alice=LOOM_ALICE_DEV_TOKEN:eno:developer \
  --tenant-key-env alice=LOOM_ALICE_VIEWER_TOKEN:auditor:viewer
```

Enter the API key in the dashboard, or send it with API calls:

```bash
curl -s http://127.0.0.1:8787/tenants/alice/runs \
  -H 'authorization: Bearer dev-secret'
```

`--tenant-token alice=dev-secret` is still supported for compatibility and behaves like an admin token without a named actor. Prefer `--tenant-key-env tenant=ENV:actor:role` for shared services; `--tenant-key tenant=token:actor:role` remains available for local or generated shells. Roles are `admin`, `developer`, or `viewer`.

`online-sandbox` and `platform-readiness` count CLI bootstrap `--tenant-key-env`/`--tenant-key` entries and policy-backed `apiKeys` toward the required `admin`/`developer`/`viewer` readiness roles. Legacy `--tenant-token` values keep working for compatibility, but do not make the shared sandbox profiles ready.

Tenant policy can also live at `<workspace-root>/<tenant>/.loom/policy.json`, or be updated by an admin:

```bash
curl -s -X PUT http://127.0.0.1:8787/tenants/alice/policy \
  -H 'authorization: Bearer admin-secret' \
  -H 'content-type: application/json' \
  -d '{
    "schemaVersion": 1,
    "apiKeys": [
      { "token": "dev-secret", "actor": "eno", "role": "developer", "modelKeyEnv": "LOOM_ENO_MODEL_KEY" },
      { "token": "read-secret", "actor": "auditor", "role": "viewer" }
    ],
    "modelKeyEnv": "LOOM_ALICE_MODEL_KEY",
    "executorTemplateParameters": ["auth_mode=subscription", "owner={tenant}"],
    "limits": {
      "maxActiveRuns": 2,
      "maxWorkspaceSessions": 4,
      "maxWorkspaceBytes": 104857600,
      "workspaceByteWarning": 83886080,
      "executorCpus": 1,
      "executorMemory": "2g",
      "executorPidsLimit": 128,
      "executorNetwork": "loom-egress",
      "modelProjectTotalTokenWarning": 100000,
      "modelRequesterTotalTokenWarning": 50000,
      "modelProjectTotalTokenLimit": 200000,
      "modelRequesterTotalTokenLimit": 100000,
      "modelProjectCostUsdWarning": 25,
      "modelRequesterCostUsdWarning": 10,
      "modelProjectCostUsdLimit": 50,
      "modelRequesterCostUsdLimit": 20
    },
    "allowedTools": ["file.read", "file.write", "git.diff", "git.commit", "verify.run"]
  }'
```

`GET /tenants/alice/policy` returns the same policy without token values. Tenant policy keys are accepted alongside CLI keys, and tenant policy limits/allowed tools override the server defaults for that tenant. Executor limits are passed into the executor context so Docker-backed tenants can get per-tenant CPU, memory, pids, and named-network caps; Coder-backed tenants map CPU, memory, and pids limits into `cpus`, `memory_gb`, and `pids_limit` workspace parameters when missing workspaces are created. Model token/cost warning limits emit project-summary model usage warnings and feed `GET /tenants/:tenant/model-usage/warnings` without blocking runs; model token/cost hard limits reject model-backed run creation, queued-run starts, and resumes once the current project/requester aggregate is at or above the cap. `limits.workspaceByteWarning` emits project-summary workspace usage warnings and feeds `GET /tenants/:tenant/workspace-usage/warnings` without blocking work. `limits.maxWorkspaceBytes` caps non-`.loom` workspace file content for HTTP file writes and rejects workspace commands/sessions once the workspace is already at or above the cap; true filesystem quotas should still be enforced by Docker/Coder for untrusted shell workloads. Tenant policy `executorTemplateParameters` are non-secret Coder creation parameters, merged after CLI defaults and before resource-limit overrides. Tenant policy `controlPlaneIdentities` maps signed control-plane comment authors by `{ provider, externalActor }` to tenant-scoped `{ actor, role }` identities; mapped comments keep `controlPlaneExternalActor` evidence while review, deployment, VAS, and handoff commands use the mapped tenant role. Full policy replacement records non-secret `policyChange` before/after evidence for `modelKeyEnv`, `executorTemplateParameters`, `controlPlaneIdentities`, `allowedTools`, and `limits`; policy settings updates preserve `apiKeys` and `controlPlaneIdentities` while recording settings-only changes.

For Dashboard-style edits that must preserve existing API key tokens, update only non-secret settings:

```bash
curl -s -X POST http://127.0.0.1:8787/tenants/alice/policy/settings \
  -H 'authorization: Bearer admin-secret' \
  -H 'content-type: application/json' \
  -d '{
    "modelKeyEnv": "LOOM_ALICE_MODEL_KEY",
    "executorTemplateParameters": ["auth_mode=subscription", "owner={tenant}"],
    "limits": {
      "maxActiveRuns": 2,
      "maxWorkspaceSessions": 4,
      "maxWorkspaceBytes": 104857600,
      "workspaceByteWarning": 83886080,
      "executorCpus": 1,
      "modelProjectTotalTokenWarning": 100000,
      "modelRequesterTotalTokenWarning": 50000,
      "modelProjectTotalTokenLimit": 200000,
      "modelRequesterTotalTokenLimit": 100000,
      "modelProjectCostUsdWarning": 25,
      "modelRequesterCostUsdWarning": 10,
      "modelProjectCostUsdLimit": 50,
      "modelRequesterCostUsdLimit": 20
    },
    "allowedTools": ["file.read", "file.write", "git.diff", "verify.run"],
    "clientId": "dashboard-tab"
  }'
```

`POST /tenants/alice/policy/settings` preserves existing `apiKeys`, can clear `modelKeyEnv` with an empty string, and can clear the tenant `allowedTools` override with `allowedTools: null` so the tenant inherits the server allowlist again.

To add or revoke tenant users without round-tripping existing token values through the browser:

```bash
curl -s -X POST http://127.0.0.1:8787/tenants/alice/policy/api-keys \
  -H 'authorization: Bearer admin-secret' \
  -H 'content-type: application/json' \
  -d '{ "actor": "teammate", "role": "developer", "modelKeyEnv": "LOOM_TEAMMATE_MODEL_KEY", "clientId": "dashboard-tab" }'

curl -s -X POST http://127.0.0.1:8787/tenants/alice/policy/api-keys/revoke \
  -H 'authorization: Bearer admin-secret' \
  -H 'content-type: application/json' \
  -d '{ "actor": "teammate", "role": "developer", "clientId": "dashboard-tab" }'
```

The create endpoint returns the new token once as `token`, stores only a `tokenHash` in policy, and never includes other token values in the response or tenant audit. Supplying `"token": "..."` is optional; omit it to generate a `loom_...` token. Supplying `"modelKeyEnv": "ENV_NAME"` binds model-backed runs created with that API key to `process.env[ENV_NAME]`. Plaintext `token` entries in older policy files remain accepted and are rewritten as hashes on the next policy write. CLI-provided `--tenant-key-env`/`--tenant-key` bootstrap keys remain server configuration, not policy keys.

`modelKeyEnv` stores the environment variable name for a LiteLLM/OpenAI-compatible key, not the key value. Model-backed HTTP runs use the authenticated API key's `modelKeyEnv` first, then the tenant policy `modelKeyEnv`, then `--tenant-model-key tenant=ENV_NAME`, and finally the server-wide `--model-key-env`. This lets one shared tenant route different users through separate LiteLLM virtual keys while responses and audit logs expose only env names.
Platform readiness accepts the server-wide model key, tenant-scoped model envs, or policy API-key scoped model envs that cover the configured tenants; status and doctor expose `keyMode` (`server`, `tenant-scoped`, `policy-key-scoped`, or `mixed`), tenant counts, and missing env names, never key values.

Developers can request a policy escalation without directly changing policy; only admins can approve it:

```bash
curl -s -X POST http://127.0.0.1:8787/tenants/alice/policy/escalations \
  -H 'authorization: Bearer dev-secret' \
  -H 'content-type: application/json' \
  -d '{
    "requestedTools": ["shell.exec"],
    "limits": {
      "maxWorkspaceSessions": 4,
      "maxWorkspaceBytes": 209715200,
      "workspaceByteWarning": 167772160,
      "modelProjectTotalTokenWarning": 200000,
      "modelRequesterTotalTokenWarning": 100000,
      "modelProjectTotalTokenLimit": 400000,
      "modelRequesterTotalTokenLimit": 200000,
      "modelProjectCostUsdWarning": 50,
      "modelRequesterCostUsdWarning": 25,
      "modelProjectCostUsdLimit": 100,
      "modelRequesterCostUsdLimit": 50,
      "executorCpus": 1,
      "executorMemory": "2g"
    },
    "source": { "kind": "workspace_usage_warning", "project": "proj-a", "detail": "workspace_byte_limit" },
    "reason": "need a temporary interactive sandbox shell"
  }'

curl -s -X POST http://127.0.0.1:8787/tenants/alice/policy/escalations/<escalationId>/decision \
  -H 'authorization: Bearer admin-secret' \
  -H 'content-type: application/json' \
  -d '{ "decision": "approved", "note": "approved for this task" }'
```

Approved escalation requests merge only the requested tools/limits into the tenant policy, still bounded by the server tool allowlist and unsafe Docker network-mode rejection; existing `modelKeyEnv`, `executorTemplateParameters`, and API key actors are preserved. Rejections leave policy unchanged. Request and decision events are written to the tenant audit feed, including optional structured `source` metadata (`model_usage_warning`, `workspace_usage_warning`, `workspace_pr`, `run_slot_pressure`, or `manual`); approved decisions also persist non-secret `policyChange` evidence with `allowedTools.before/after/added` and `limits.before/after/changed`. The dashboard model-usage and workspace-usage warning queues can prefill token/cost budget or workspace quota escalations from warning projects, and the Project Concurrency board can prefill a run-slot escalation for queued tenant run-cap pressure, leaving the request for the user to submit and an admin to approve.

Cross-origin clients may use either `authorization: Bearer ...` or `x-loom-tenant-token`; CORS preflight allows those headers plus `last-event-id` for browser SSE reconnects.

Create a tenant run:

```bash
curl -s http://127.0.0.1:8787/runs \
  -H 'content-type: application/json' \
  -d '{
    "tenant": "alice",
    "goal": "create hello.txt",
    "allowedTools": ["file.read", "file.write", "git.diff", "git.commit", "verify.run"],
    "script": [
      {
        "message": "write file",
        "actions": [
          {
            "toolName": "file.write",
            "input": { "path": "hello.txt", "content": "hello\n" }
          }
        ]
      },
      { "message": "finish", "finish": true }
    ],
    "verify": ["test -f hello.txt"],
    "skills": ["coding"]
  }'
```

Read the run back:

```bash
curl -s http://127.0.0.1:8787/status
curl -s http://127.0.0.1:8787/tenants/alice/policy
curl -s http://127.0.0.1:8787/tenants/alice/policy/escalations
curl -s -X POST http://127.0.0.1:8787/tenants/alice/projects \
  -H 'content-type: application/json' \
  -d '{"project":"proj-a","template":"vas-lite","repo":"team/proj-a","branch":"vas/segment-001","baseBranch":"main","issue":"team/proj-a#123"}'
curl -s http://127.0.0.1:8787/tenants/alice/projects/proj-a/vas/cases
curl -s -X POST http://127.0.0.1:8787/tenants/alice/projects/proj-a/vas/cases \
  -H 'content-type: application/json' \
  -d '{"caseId":"segment-001","repo":"team/proj-a","branch":"vas/segment-001","baseBranch":"main","issue":"team/proj-a#123","source":{"kind":"video","url":"clip://segment-001","range":{"start":0,"end":8}}}'
curl -s -X POST http://127.0.0.1:8787/tenants/alice/projects/proj-a/vas/cases/segment-001/review-runs \
  -H 'content-type: application/json' \
  -d '{"clientId":"api"}'
curl -s -X POST http://127.0.0.1:8787/tenants/alice/projects/proj-a/vas/cases/segment-001/review \
  -H 'content-type: application/json' \
  -d '{"decision":"approved","note":"state sequence is trustworthy","corrections":["Rename middle state"],"learnings":["Pause after menu open is a checkpoint"]}'
curl -s -X POST http://127.0.0.1:8787/runs \
  -H 'content-type: application/json' \
  -d '{"tenant":"alice","project":"proj-a","preset":"vas-lite-review"}'
curl -s -X POST http://127.0.0.1:8787/runs \
  -H 'content-type: application/json' \
  -d '{"tenant":"alice","project":"proj-a","preset":"vas-lite-review","presetInput":{"caseId":"bootstrap"}}'
curl -s http://127.0.0.1:8787/tenants/alice/projects/proj-a/vas/cases/bootstrap/artifacts
curl -s http://127.0.0.1:8787/tenants/alice/projects
curl -s http://127.0.0.1:8787/tenants/alice/projects/default/workspace
curl -s 'http://127.0.0.1:8787/tenants/alice/projects/default/files'
curl -s 'http://127.0.0.1:8787/tenants/alice/projects/default/files?path=hello.txt'
curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/projects/default/files' \
  -H 'content-type: application/json' \
  -d '{"path":"hello.txt","content":"edited from dashboard\n"}'
curl -s -X DELETE 'http://127.0.0.1:8787/tenants/alice/projects/default/files?path=hello.txt' \
  -H 'content-type: application/json' \
  -d '{"clientId":"api"}'
curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/projects/default/commands' \
  -H 'content-type: application/json' \
  -d '{"command":"pwd && ls"}'
curl -s 'http://127.0.0.1:8787/tenants/alice/projects/default/commands'
curl -s http://127.0.0.1:8787/tenants/alice/runs
curl -s http://127.0.0.1:8787/tenants/alice/runs/<runId>
curl -s 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/workspace?project=default'
curl -s http://127.0.0.1:8787/tenants/alice/runs/<runId>/events
curl -s http://127.0.0.1:8787/tenants/alice/runs/<runId>/replay
curl -s 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/review-summary?project=default'
curl -s 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/handoff-package?project=default'
curl -s 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/handoff-runs?project=default'
```

`GET /handoff-runs` returns the source run summary, source links, and child follow-up runs without requiring the heavier `git.diff`-backed handoff package. Follow-ups started from Gitea/Forgejo comments include the triggering `giteaCommentId` and `giteaCommentUrl`; child run summaries link back to the source Workbench and source handoff package.

For long runs, create it asynchronously:

Start the server with an isolated executor and `--allow-shell` if a run needs `shell.exec` actions:

```bash
loom harness serve --workspace-root /tmp/loom-workspaces --port 8787 \
  --executor docker \
  --executor-image loom-workspace:dev \
  --executor-network none \
  --allow-shell
```

For shared sandbox servers, tune active run and session limits explicitly:

```bash
loom harness serve --workspace-root /tmp/loom-workspaces --port 8787 --allow-shell \
  --executor docker \
  --executor-image loom-workspace:dev \
  --executor-network none \
  --max-tenant-active-runs 2 \
  --workspace-command-timeout-ms 120000 \
  --max-workspace-sessions 32 \
  --max-tenant-workspace-sessions 8 \
  --workspace-session-idle-timeout-ms 1800000
```

Active run admission also writes a lease-backed project claim under `.loom/runs/.admission`; when `--max-tenant-active-runs` is configured, it also writes tenant-level active-run claims under `<tenant>/.loom/admission/active-runs`. Workspace session admission writes workspace-root-level active-session claims under `.loom/admission/workspace-sessions` for the global cap and tenant-level claims under `<tenant>/.loom/admission/workspace-sessions` for per-tenant caps. Multiple server instances sharing the same workspace root therefore cannot simultaneously take the same project slot, exceed the tenant-wide run cap before the running status file is visible, exceed the global workspace-session cap, or exceed the tenant workspace-session cap before another instance can see the in-memory session. Project session lists and project summaries use those claims to show remote running sessions as active rather than orphaned. Active-run claims also keep server/tenant status, queued-run blockers, and abandon/auto-abandon decisions aligned across shared server instances; persisted running session or run summaries without a live claim stay orphaned. Project summaries and details also expose a non-secret `concurrency` rollup with `state: "active" | "queued" | "contended"`, active run/session/collaborator counts, active run lease details, queued run counts, and latest workspace-conflict hints; Dashboard project cards and the Project Concurrency board render that as the shared multi-user/multi-agent contention signal, with Open, Pause, and Cancel actions for active-run lease holders plus a run-slot escalation prefill for queued tenant-cap pressure. When runs are active, global and tenant status expose `resources.activeRunDetails` with each run's `workspaceLeaseScope` and readable `workspaceLeaseKey` (`tenant/project` or `tenant/project/runId`) so operators and future provider adapters can see the live workspace lease topology. `loom harness smoke --check-run-controls` asserts that topology during an active run, and peer smoke asserts a second server instance sees the same lease.

To put HTTP tenant commands behind Docker, start the server with the same executor options:

```bash
loom harness serve \
  --workspace-root /tmp/loom-workspaces \
  --port 8787 \
  --profile online-sandbox \
  --executor docker \
  --executor-image loom-workspace:dev \
  --executor-network none \
  --executor-home-root /var/lib/loom-homes \
  --executor-cpus 2 \
  --executor-memory 4g \
  --executor-pids-limit 256 \
  --tenant-key-env alice=LOOM_ALICE_ADMIN_TOKEN:ops:admin \
  --tenant-key-env alice=LOOM_ALICE_DEV_TOKEN:eno:developer \
  --tenant-key-env alice=LOOM_ALICE_VIEWER_TOKEN:auditor:viewer
```

To map HTTP tenants to Coder workspaces, use templates. Supported placeholders are `{tenant}`, `{project}`, `{cwdBase}`, and `{runId}`. If the workspace is missing, `--executor-template-param name=value` is passed to `coder create --parameter name=value`; repeat it for Coder rich parameters such as `auth_mode`, `cpus`, `memory_gb`, or `pids_limit`. Tenant policy `executorTemplateParameters` are merged after CLI template parameters, so per-tenant values such as `auth_mode=subscription` can override server defaults. `--executor-cpus`, `--executor-memory`, `--executor-pids-limit`, and tenant policy executor limits override those same Coder resource parameters during workspace creation. Missing workspace creation also uses Coder parameter defaults non-interactively. Coder workspace and template names that look like CLI flags or contain whitespace/control characters are rejected before reaching `coder`. Coder template parameter names containing secret-bearing parts such as `token`, `key`, `secret`, or `password` are rejected; pass secrets through the Coder template's secret store instead. If you set `--executor-ide-url` or `--executor-preview-url` to an `http` or `https` URL template, dashboard and workbench workspace context panels show `Open IDE` and `Open Preview` links. These URLs must not include userinfo credentials, fragments, or secret-bearing query parameters such as `token`, `key`, `secret`, `password`, or `auth`.

```bash
loom harness serve \
  --workspace-root /tmp/loom-artifacts \
  --port 8787 \
  --public-url https://loom.example \
  --profile platform-readiness \
  --executor coder \
  --executor-workspace 'loom-{tenant}' \
  --executor-template loom \
  --executor-template-param auth_mode=gateway \
  --executor-template-param cpus=2 \
  --executor-template-param memory_gb=4 \
  --executor-template-param pids_limit=256 \
  --executor-remote-cwd '/home/dev/projects/{project}' \
  --executor-worktree-cwd '/home/dev/worktrees/{tenant}/{project}/{runId}' \
  --executor-ide-url 'https://coder.example.com/@{tenant}/loom-{tenant}/apps/code-server' \
  --executor-preview-url 'https://coder.example.com/@{tenant}/loom-{tenant}/apps/preview'
```

For the full platform readiness path, combine the Coder executor with control-plane PR/comment reporting, LiteLLM/OpenAI-compatible model routing, role-based tenant auth, and brain ingest, then run smoke with the explicit external checks:

`GET /status` reports `readiness.ok` plus `readiness.missing`; `loom harness smoke --profile platform-readiness` fails before starting long checks if any required integration is missing.

```bash
export LOOM_MODEL_KEY=...
export LOOM_GITEA_TOKEN=...
export LOOM_ALICE_GITEA_TOKEN=...
export LOOM_GITEA_WEBHOOK_SECRET=...
loom harness serve \
  --workspace-root /tmp/loom-artifacts \
  --port 8787 \
  --public-url https://loom.example \
  --profile platform-readiness \
  --executor coder \
  --executor-workspace 'loom-{tenant}' \
  --executor-template loom \
  --executor-remote-cwd '/home/dev/projects/{project}' \
  --executor-worktree-cwd '/home/dev/worktrees/{tenant}/{project}/{runId}' \
  --executor-ide-url 'https://coder.example.com/@{tenant}/loom-{tenant}/apps/code-server' \
  --executor-preview-url 'https://coder.example.com/@{tenant}/loom-{tenant}/apps/preview' \
  --model-base-url https://litellm.example \
  --model-key-env LOOM_MODEL_KEY \
  --default-model gpt-5 \
  --control-plane-pr \
  --control-plane-merge \
  --control-plane-comment \
  --control-plane-comment-sync \
  --control-plane-webhook-secret-env LOOM_GITEA_WEBHOOK_SECRET \
  --control-plane-url https://git.example \
  --tenant-control-plane-token-env alice=LOOM_ALICE_GITEA_TOKEN \
  --control-plane-token-env LOOM_GITEA_TOKEN \
  --ingest-brain \
  --tenant-key-env alice=LOOM_ALICE_DEV_TOKEN:eno:developer \
  --tenant-key-env alice=LOOM_ALICE_VIEWER_TOKEN:auditor:viewer \
  --tenant-key-env alice=LOOM_ALICE_ADMIN_TOKEN:ops:admin
```

```bash
LOOM_SMOKE_TOKEN=dev-secret LOOM_SMOKE_VIEWER_TOKEN=read-secret LOOM_SMOKE_ADMIN_TOKEN=admin-secret \
loom harness smoke \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --project smoke-platform \
  --template vas-lite \
  --token-env LOOM_SMOKE_TOKEN \
  --viewer-token-env LOOM_SMOKE_VIEWER_TOKEN \
  --admin-token-env LOOM_SMOKE_ADMIN_TOKEN \
  --profile platform-readiness
```

```bash
curl -s http://127.0.0.1:8787/runs \
  -H 'content-type: application/json' \
  -d '{
    "async": true,
    "queue": true,
    "tenant": "alice",
    "repo": "https://git.internal/team/proj-a.git",
    "branch": "task/alice-async",
    "baseBranch": "origin/main",
    "issue": "team/proj-a#42",
    "pullRequest": true,
    "reviewRequired": true,
    "deploymentRequired": true,
    "goal": "create async.txt",
    "script": [
      {
        "message": "write file",
        "actions": [
          {
            "toolName": "shell.exec",
            "input": { "command": "sleep 1; printf async-ok > async.txt" }
          }
        ]
      },
      { "message": "finish", "finish": true }
    ],
    "verify": ["test -f async.txt"],
    "evaluate": ["test -s async.txt"],
    "reviewer": ["printf 'reviewer: inspect generated diff'"],
    "skills": ["coding"]
  }'
```

The optional `"evaluate"` array is an independent command gate after verification. It records an `evaluation` event and `summary.evaluation`; any failing evaluator command makes the run `failed` before review or deployment gates open. The optional `"reviewer"` array is a non-gating reviewer pass after successful verification/evaluation; it records a `reviewer` event and `summary.reviewer`, then still leaves merge/deployment decisions to humans. The optional `"issue"` field is stored in `summary.json`, enriched as `metadata.issueUrl` from `--control-plane-url`, and emitted as a `run_metadata` event. Successful issue comments, PR creation, PR merges, and brain ingest append `external_effect` events with requester identity and the issue URL when available; issue comment, PR creation, and brain ingest effects also include dashboard, summary, review-summary, handoff-package, and follow-up lineage links when `--public-url` is configured. Issue comments include requester identity, the dashboard, run summary, review-summary, handoff-package, and follow-up lineage links when available, verification/evaluation/reviewer command lists, PR link when available, review/deployment gate state, and failed-run brain failure/focus hints. Review-gated run issue comments can be followed up with `/loom approve`, `/loom request-changes`, `/loom claim-review`, or `/loom release-review-claim` from a mapped developer/admin; `/loom approve` and `/loom request-changes` can also include one fenced `loom-contract-patch` JSON block with `objective`, `constraints`, and `successCriteria`, which is removed from the note and stored as `contractPatch`. Deployment-gated run issue comments can be followed up with `/loom approve-deploy` or `/loom reject-deploy` from a mapped admin. `vas-lite-review` issue comments also include the case id and the `/loom approve-vas`, `/loom request-vas-changes`, `/loom claim-vas <caseId>`, `/loom release-vas-claim <caseId>`, and `/loom run-vas-review <caseId>` follow-up commands. A mapped developer/admin can also post `/loom run-handoff-followup` on a linked run issue to start an inherited handoff follow-up run, with the remaining comment text used as the reviewer note. If a configured issue reporter fails while posting the final comment, the run is recorded as `status: "error"` with an `error` event and `summary.error`. With `"pullRequest": true`, a server started with `--control-plane-pr` creates a provider PR from `"branch"` into `"baseBranch"` through the configured control-plane adapter, writes the PR link back to the run summary, and includes requester, dashboard/run evidence links, and verification/evaluation/reviewer/gate context in the PR body; without a PR reporter configured, the request is rejected before the run starts, and PR reporter failures are recorded as `status: "error"` with an `error` event and `summary.error`. With `"reviewRequired": true`, verification and evaluation success become `status: "review_required"` until a human reviews the PR. With `"deploymentRequired": true`, verification and evaluation success become `status: "deployment_required"` until an admin approves production deployment; if both gates are set, review approval advances the run into deployment approval instead of directly passing.

To post issue comments or create PRs, start the server with an explicit reporter token:

```bash
export LOOM_GITEA_TOKEN=...
export LOOM_ALICE_GITEA_TOKEN=...
export LOOM_GITEA_WEBHOOK_SECRET=...

loom harness serve \
  --workspace-root /tmp/loom-artifacts \
  --port 8787 \
  --public-url https://loom.example \
  --control-plane-pr \
  --control-plane-merge \
  --control-plane-comment \
  --control-plane-comment-sync \
  --control-plane-webhook-secret-env LOOM_GITEA_WEBHOOK_SECRET \
  --control-plane-url http://git.internal:3000 \
  --tenant-control-plane-token-env alice=LOOM_ALICE_GITEA_TOKEN \
  --control-plane-token-env LOOM_GITEA_TOKEN
```

`--tenant-control-plane-token-env tenant=ENV_NAME` lets shared HTTP services use a tenant-scoped control-plane token for PR creation, issue comments, issue comment sync, workspace PR handoff, and merge calls. If a tenant-specific env is not configured, Loom falls back to `--control-plane-token-env`. The older `--tenant-gitea-token-env` and `--gitea-token-env` flags remain accepted for the default provider. `loom harness doctor` reports missing token or webhook env names before startup, but never prints their values. Runtime startup errors use provider-neutral `--control-plane-token-env` / `control-plane token` wording for `--control-plane-*` flags and `--control-plane-provider agent-git-service`, while legacy Gitea flags keep the old wording.

Approve or reject a review-gated run:

```bash
curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/review?project=proj-a' \
  -H 'content-type: application/json' \
  -d '{ "decision": "approved", "note": "Looks good.", "merge": true }'

curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/review?project=proj-a' \
  -H 'content-type: application/json' \
  -d '{ "decision": "rejected", "note": "Needs changes." }'
```

`merge: true` only works on approved decisions when the service was started with `--control-plane-merge`; otherwise review approval updates the run summary but does not merge the PR. `--gitea-merge` remains accepted as a compatibility alias for the default provider. Merge reporter failures keep the run pending review and append an `error` event so the merge can be retried.
The dashboard and workbench show the same approve/reject controls when a run is pending human review.

Approve or reject a deployment-gated run:

```bash
curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/deployment?project=proj-a' \
  -H 'authorization: Bearer admin-secret' \
  -H 'content-type: application/json' \
  -d '{ "decision": "approved", "note": "Approved for production." }'

curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/deployment?project=proj-a' \
  -H 'authorization: Bearer admin-secret' \
  -H 'content-type: application/json' \
  -d '{ "decision": "rejected", "note": "Hold deployment." }'
```

Deployment decisions require an `admin` key when auth is configured, append `deployment_gate` and final `finish` run events, update `summary.json`, and append a tenant `deployment_decided` audit event. The dashboard and workbench show the same approve/reject controls when a run is pending deployment approval.

Then poll or stream events; SSE streams include `id: <seq>`, and browser reconnects resume from `Last-Event-ID` even when the original stream URL still has an older `after` value:

```bash
curl -s http://127.0.0.1:8787/tenants/alice/runs/<runId>
curl -s http://127.0.0.1:8787/tenants/alice/runs
curl -s 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/events?after=2'
curl -N 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/events/stream?after=0'
curl -s 'http://127.0.0.1:8787/tenants/alice/audit?after=0'
curl -N 'http://127.0.0.1:8787/tenants/alice/audit/stream?after=0'
curl -s 'http://127.0.0.1:8787/tenants/alice/brain/signals?project=proj-a&after=0'
```

Cancel a running or queued async run:

```bash
curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/cancel?project=proj-a' \
  -H 'content-type: application/json' \
  -d '{ "reason": "user stopped the run" }'
```

If another server instance owns the live run, this returns `202` with `cancelRequested: true`; keep polling the run URL or event stream until the owning loop writes the final `cancel` and `finish` events.

Pause requests sent through run comments follow the same owner-loop rule: the comment is accepted on any server instance with a live run admission claim, and the owning loop writes the final `pause` and `finish: paused` events before its next agent step.

Signed issue-comment `/loom pause` commands use the same cross-server owner-loop path, so a webhook received by any shared server instance can pause a linked run owned by another instance without rewriting final state outside the loop.

If the server restarted and a persisted `running` status no longer has a local controller, abandon it explicitly:

```bash
curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/abandon?project=proj-a' \
  -H 'content-type: application/json' \
  -d '{ "reason": "server restarted before completion" }'
```

To clean up only an expired run lease, use the stale-only endpoint. It rejects active or missing leases with `409`:

```bash
curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/abandon-stale?project=proj-a' \
  -H 'content-type: application/json' \
  -d '{ "reason": "stale lease cleanup" }'
```

To let the server do that stale-only cleanup during startup maintenance, opt in explicitly:

```bash
loom harness serve --workspace-root /tmp/loom-workspaces --auto-abandon-stale-runs
```

To feed online harness runs into the skill-evolution brain, start HTTP mode with:

```bash
loom harness serve --workspace-root /tmp/loom-workspaces --ingest-brain
```

Completed HTTP runs ingested through this mode record both a `brain_ingest` run external effect and a `brain_signal_ingested` tenant audit event; when a reviewer pass ran, both records include `reviewerStatus`, `reviewerExitCode`, and `reviewerCommands`. Native `RunSignal` posts write the same tenant audit event. `GET /tenants/:tenant/brain/signals?project=<project>&after=<seq>&limit=<n>&runId=<runId>` derives a viewer-readable feed from tenant audit, marks entries as `completed_run` or `workspace_signal`, and omits raw notes.

With `--ingest-brain`, tenant workspaces can also POST native/Stop-hook `RunSignal` JSON to `POST /tenants/:tenant/brain/signals` using a `developer` key. The bundled Stop hook uses `LOOM_BRAIN_INGEST_URL`, optional `LOOM_BRAIN_INGEST_TOKEN`, and optional `LOOM_BRAIN_CLIENT_ID` for that central path; it also forwards optional `LOOM_RUN_ID`, `LOOM_RUN_DIR`, `LOOM_STATUS`, `LOOM_ISSUE`, `LOOM_ISSUE_URL`, `LOOM_DASHBOARD_URL`, `LOOM_SUMMARY_URL`, `LOOM_REVIEW_SUMMARY_URL`, `LOOM_HANDOFF_PACKAGE_URL`, `LOOM_HANDOFF_FOLLOWUPS_URL`, `LOOM_FAILURE_KIND`, `LOOM_MODEL_REQUEST_COUNT`, `LOOM_MODEL_PROMPT_TOKENS`, `LOOM_MODEL_COMPLETION_TOKENS`, `LOOM_MODEL_TOTAL_TOKENS`, `LOOM_MODEL_COST_USD`, and `LOOM_BRAIN_NOTES` into the signal. When `.loom/native-goal.json` is present, the hook uses it as non-secret defaults for `project`, `runId`, `runDir`, `issue`, and `issueUrl` unless the explicit env vars are set. Without `LOOM_BRAIN_INGEST_URL`, it keeps the local `loom brain ingest` fallback.

Harness-fed brain signals include structured `runId`, `status`, `runDir`, `issue`, `issueUrl`, `dashboardUrl`, `summaryUrl`, `reviewSummaryUrl`, `handoffPackageUrl`, `handoffFollowupsUrl`, `failureKind`, and non-secret model usage aggregates (`modelRequestCount`, `modelPromptTokens`, `modelCompletionTokens`, `modelTotalTokens`, `modelCostUsd`) when available. CLI/HTTP harness runs classify failed summaries as `evaluation`, `verification`, `reporter`, `agent`, `tool`, `workspace-prepare`, `failed`, `error`, or `cancelled`; native signals can pass `failureKind` directly, and `brain score` also infers a bucket from notes when older signals omit it. Failure notes include verification/evaluation exit codes and commands when those gates fail, `summary.error.message` plus bounded `summary.error.kind/details` for reporter or agent errors, reviewer pass/flag evidence when present, and handoff evidence such as review/deployment status, PR URL, branch, base, and issue links when present. Weak-skill proposals include failure-kind counts, a reviewer-focus checklist derived from those buckets, and the latest failing samples with run, issue, dashboard, summary, explicit `reviewSummary`/`handoffPackage`/`followupRuns` reviewer links when present, model usage counts/cost when present, derived links from `summaryUrl` otherwise, and note context, so reviewers can trace the exact failure without parsing free-form logs. Re-running `brain propose` or `loomd serve` skips already-opened local or tracked-remote proposal branches for the same signal timestamp. Skill identifiers are slugged before entering branch names or note paths; the original identifier stays in the proposal metadata/body. Proposal commits are path-scoped to `.brain/signals.jsonl`, `.brain/skill_evals.json`, and that skill's `IMPROVE.md`, so unrelated human edits in the skills repo stay outside the automatic branch.

When failure-kind or model usage fields are present, Dashboard and Workbench audit summaries render the same non-secret outcome, skill count, request/token counts, and cost.

Review summary and handoff-package JSON also expose structured `changedFiles` hints derived from the bounded workspace diff, plus the same compact brain evidence for failed runs as `brain.outcome`, `brain.failureKind`, and `brain.reviewerFocus`; their `modelUsage` field keeps aggregate request/token counts, `projectContract` / `projectContractStatus` keep the run's project-goal and drift evidence as explicit review-summary fields, review contract patches flow through replay details, handoff gate trails, and issue-comment message evidence, follow-up runs preserve the source run's contract/status as source evidence, and their `error` field keeps the public error message, phase, iteration, kind, and bounded non-secret scalar details for reviewer handoff. Dashboard and Workbench render this evidence in the review summary and handoff lineage panels so online reviewers can triage the failure before a weak-skill proposal exists.

Run the older native adapter:

```bash
cp hooks/loom-stop-hook.sh /usr/local/bin/loom-stop-hook && chmod +x /usr/local/bin/loom-stop-hook

export LOOM_GATEWAY_KEY=...   # your per-dev virtual key from the gateway
export LOOM_BRAIN_INGEST_URL=http://127.0.0.1:8787/tenants/alice/brain/signals
export LOOM_BRAIN_INGEST_TOKEN=dev-secret

loom workspace create alice
loom project add http://git.internal/team/proj-a.git
loom hooks-install            # native Stop hook → brain
loom goal "all tests in test/auth pass and lint is clean" -p proj-a -w task-123 -t reasoning --issue team/proj-a#123 --skill coding
# ... runs accumulate signals via the hook ...
loom brain score
loom brain propose           # opens git branches proposing fixes to weak skills
loom brain propose --gitea-pr --gitea-repo team/_skills --gitea-base main --gitea-token-env LOOM_GITEA_TOKEN
```

`loom workspace create` uses the same hardened Docker profile as `loomd`: a persistent `loom-home-<name>` volume, configured CPU/memory/pids/network/runtime caps, read-only rootfs, bounded `/tmp`, dropped capabilities, and `no-new-privileges`. In `gateway` auth mode it injects the configured LiteLLM endpoint plus your per-dev virtual key from `gatewayKeyEnv`; in `subscription` mode it injects no model credentials.

`loom goal` requires `<workspaceRoot>/<project>` to exist. It creates or reuses `<workspaceRoot>/<project>/.wt/<worktree>` before launching the native CLI; git projects get an isolated `loom/<worktree>` branch, while non-git projects get a persistent scratch directory. Each launch writes `<worktree>/.loom/native-goal.json` and exposes its path as `LOOM_NATIVE_GOAL_CONTEXT`, recording the non-secret run id, condition/model metadata, repeated `--skill` values, optional `--issue` / `issueUrl`, `cold_start` versus `resume_by_cwd`, attempt count, and exit status so native sessions leave a disk artifact even when provider resume is only best-effort. The native CLI receives `LOOM_RUN_ID` and `LOOM_RUN_DIR`; repeated `--skill` values are also forwarded through `LOOM_NATIVE_GOAL_SKILLS` / `LOOM_SKILLS`, so the bundled Stop hook can emit brain signals with active skills even when `.claude/active-skills` is absent. When `--issue owner/repo#number` is present, the native CLI also receives `LOOM_NATIVE_GOAL_ISSUE` / `LOOM_NATIVE_GOAL_ISSUE_URL`, and the hook can read the same link through `LOOM_ISSUE` / `LOOM_ISSUE_URL`. Project names must be a single safe path segment, and sanitized worktree ids must also form safe git refs.

## Config

`loom.config.json` (see the included example). Switching models later = edit `models` only; the loop, workspaces, Gitea, and brain don't change.

## Harness tools

The MVP runtime exposes a deliberately small tool surface:

- `file.read`
- `file.write`
- `shell.exec`
- `git.diff`
- `git.commit`
- `verify.run`

All tool execution goes through `WorkspaceExecutor`. The current executors are local, Docker-backed, and Coder-SSH-backed; the interface is the seam for replacing local execution with a fuller Coder lifecycle or another remote sandbox runner. The local executor only confines file APIs to the workspace path and is not an OS sandbox for commands or verification, so authenticated, non-loopback, or shell-enabled HTTP service must use Docker/Coder unless started with the explicit `--allow-unsafe-local-executor` development escape hatch. Executors also expose a non-secret `describeWorkspace()` view, surfaced through `GET /tenants/:tenant/projects/:project/workspace` and `GET /tenants/:tenant/runs/:runId/workspace?project=<project>`, so clients can see whether they are targeting a project workspace, Docker mount, Coder remote cwd, per-run worktree context, inherited project repo/branch/baseBranch defaults, a configured browser IDE URL, or a configured browser preview URL before opening files or terminals.

To run commands and verification inside Docker, build a workspace image and select the Docker executor:

```bash
docker build -t loom-workspace:dev -f docker/workspace.Dockerfile .

loom harness run "create hello.txt" \
  --cwd /tmp/loom-demo \
  --script /tmp/loom-script.json \
  --executor docker \
  --executor-image loom-workspace:dev \
  --executor-network none \
  --verify "test -f hello.txt"
```

Docker file inspect/read/write/move/delete use the mounted workspace path through `WorkspaceExecutor`; `shell.exec`, `git.diff`, `git.commit`, and `verify.run` execute through a hardened `docker run` profile: `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root `--user` mapped from the host process uid/gid, mandatory `--read-only`, a bounded `/tmp` tmpfs, pids/CPU/memory limits, and `--network none` by default. Pass `--executor-home-root /var/lib/loom-homes` to create `<home-root>/<tenant>` and bind it at `/home/dev` with `HOME=/home/dev`, giving each HTTP tenant a persistent Docker home across commands, sessions, and runs while keeping the project workspace mounted separately at `/workspace`. If the service itself runs as root or the platform lacks uid/gid APIs, Docker commands fall back to `1000:1000`; explicit root users are rejected. Custom executor tmpfs values must remain bounded `/tmp` mounts with `noexec` and `nosuid`. Pass `--executor-network <named-network>` only when the sandbox must reach an explicit gateway/Gitea network. Unsafe Docker modes (`host`, `bridge`, and `container:*`) are rejected; create a named sandbox network instead. Tune limits with `--executor-cpus`, `--executor-memory`, and `--executor-pids-limit`.

To run the same tool contract inside a Coder workspace, use the Coder executor. The bundled `coder-template/` defaults to `runsc`, a named `loom-net` network, dropped capabilities, no-new-privileges, read-only rootfs, bounded `/tmp`, pids/CPU/memory caps, and a workspace image that bakes `loom` plus `code-server` for the read-only rootfs. Set `brain_ingest_url_template` to a URL such as `http://harness.internal:8787/tenants/{tenant}/brain/signals` and `brain_ingest_token` from a secret store to wire each workspace Stop hook into central brain ingest; `{tenant}` is replaced with the Coder workspace owner. If `--executor-template` is set, missing workspaces are created from that template with `--use-parameter-defaults`; repeat `--executor-template-param name=value` to pass Coder rich parameters during creation. Workspace and template identifiers are rejected if they can be parsed as CLI flags or contain whitespace/control characters. Tenant policy `executorTemplateParameters` add per-tenant non-secret Coder parameters after CLI defaults. CLI or tenant-policy CPU, memory, and pids limits override same-named template parameters as `cpus`, `memory_gb`, and `pids_limit`; Coder network remains a deployment-level template variable. If `--executor-ide-url` or `--executor-preview-url` is set, the rendered `http`/`https` URL is included in workspace context and shown as an `Open IDE` or `Open Preview` link; it must not include userinfo credentials, fragments, or secret-bearing query parameters. If `--repo` or HTTP `"repo"` is set, prepare clones the repo into `--executor-remote-cwd` when missing, or runs `git fetch --all --prune` when it already exists. If `--branch` or HTTP `"branch"` is set, prepare switches to that branch or creates it from `--base-branch` / `"baseBranch"` (default `origin/main`). Run artifacts stay local under `--cwd` / `--run-root`, while file, command, and HTTP workspace file operations execute remotely.

For per-run isolation, add `--executor-worktree-cwd`. Then `--executor-remote-cwd` is the canonical remote repo directory, tools run inside the rendered worktree directory, and the HTTP server switches active-run admission from a project workspace lock to a run workspace lock. That lets multiple async agents work in the same tenant/project concurrently when each run has its own worktree; the merge point remains PR/review/handoff evidence rather than shared mutable files. The mode is exposed as `server.runWorkspaceIsolation` on server and tenant status, and `platform-readiness` requires `run`. Executor templates support `{tenant}`, `{project}`, `{cwdBase}`, and `{runId}`.

```bash
loom harness run "fix tests remotely" \
  --cwd /tmp/loom-artifacts \
  --script /tmp/loom-script.json \
  --executor coder \
  --executor-workspace alice-dev \
  --executor-template loom \
  --repo https://git.internal/team/proj-a.git \
  --branch task/proj-a-123 \
  --issue team/proj-a#123 \
  --require-review \
  --require-deployment \
  --public-url https://loom.example \
  --base-branch origin/main \
  --executor-remote-cwd /home/dev/projects/proj-a \
  --executor-worktree-cwd '/home/dev/worktrees/local/proj-a/{runId}' \
  --executor-ide-url 'https://coder.example.com/@local/alice-dev/apps/code-server' \
  --verify "npm test"
```

Add `--public-url` when the CLI run is reachable through a harness server, then `--gitea-pr` / `--gitea-comment` will include dashboard, summary, review-summary, handoff-package, and follow-up lineage links. Use `--require-review` to stop after verification for human merge review, and `--require-deployment` to stop at `deployment_required` until production approval. Add `--gitea-pr --gitea-token-env LOOM_GITEA_TOKEN` to create a reviewable PR from `--branch` with verification/gate context, and `--gitea-comment` to post the final CLI run summary, verification commands, PR link, gate state, and failed-run brain failure/focus hints to the linked issue; requester identity is included when the run summary has one. Without those flags, `--issue` still records metadata and `issueUrl` from `--gitea-url`. Successful CLI reporter calls append `external_effect` events; reporter failures exit non-zero and append an `error` event to the run.

Use `--agent-command` to plug in a real model agent. The command receives the current loop state as JSON on stdin and must emit one JSON AgentStep on stdout. AgentStep supports `message`, optional `plan`, `actions`, and `finish`; `plan` is recorded in `assistant_message` events and replay detail for audit, but it does not affect tool execution. Adapter output is schema-checked before any tool runs: each action needs a non-empty `toolName` and object `input`, and malformed steps fail the run as agent errors instead of leaking into the tool runtime. The OpenAI-compatible model adapter can use the default JSON AgentStep response or `--model-protocol tool-call` / HTTP `"modelProtocol": "tool-call"` to request one `agent_step` tool call. Its prompt and tool-call schema are narrowed by the latest `run_policy.allowedTools`, so model-backed runs see the same per-run tool surface the runtime will enforce. It wraps HTTP, missing-content/tool-call, JSON, and AgentStep schema failures with non-secret diagnostic `kind/details` for replay and handoff triage, and retries one model-protocol failure with an auditable `agent_retry` event before giving up.

Use `--model` to plug the loop into a LiteLLM/OpenAI-compatible chat-completions endpoint:

```bash
loom harness run "fix failing tests" \
  --cwd /path/to/project \
  --model kimi-k2.6 \
  --model-base-url http://localhost:4000 \
  --model-key-env LOOM_GATEWAY_KEY \
  --model-protocol tool-call \
  --verify "npm test" \
  --skill coding
```

`loom harness serve` exposes the same loop through HTTP. Runs are stored under `<workspace-root>/<tenant>/<project>/.loom/runs`; `project` defaults to `default`. Synchronous runs return `201` with the final summary. Asynchronous runs return `202` with `status: "running"` and later resolve through the same summary/events URLs. `POST /runs` may include a caller-generated `clientRequestId`; later retries or simultaneous creates with the same tenant, project, requester, and resolved request body read back the original run with `idempotentReplay: true`, even when the request reaches another server instance sharing the same workspace root. By default, each tenant/project allows one active run at a time; conflicting creates return `409` unless async creates include `"queue": true`, while different projects can run concurrently. With Coder `--executor-worktree-cwd`, active-run admission is run-scoped, so multiple async runs in the same tenant/project can run concurrently in separate worktrees; `--max-tenant-active-runs` still caps tenant-wide parallelism. When that tenant cap is full, the requested project workspace is busy, or a persisted running run still holds the project in project-lock mode, async creates with `"queue": true` return `202` with `status: "queued"`, `tenantQueuePosition`, `projectQueuePosition`, and the current `blockedReason`, then start automatically when the tenant/project slot opens; queued runs are persisted, recovered after server restart, and still visible through the same run URL. Running async status files include `heartbeatAt` and `leaseExpiresAt`, refreshed until the run finishes; `--run-lease-ttl-ms` controls the TTL. Persisted `running` status files also hold the project after a server restart while their lease is active or missing in project-lock mode; expired leases are reported as stale and no longer block new runs. Use `POST /tenants/:tenant/runs/:runId/abandon` to mark an orphaned running run as `cancelled`, or `POST /tenants/:tenant/runs/:runId/abandon-stale` to clean up only a lease-expired orphan; both refuse runs that still have a live active-run admission claim from another server instance. `--auto-abandon-stale-runs` opts into the same stale-only cleanup during server startup and skips live-claimed remote runs. `--ingest-brain` appends completed HTTP run outcomes to the git-backed brain and records a `brain_ingest` external effect in the run log. Running or queued async runs can be cancelled with `POST /tenants/:tenant/runs/:runId/cancel`, which appends `cancel` and `finish` events and records `status: "cancelled"`; if another server instance owns the live run admission claim, the endpoint returns `202` after persisting a cancel request, and the owning loop performs the abort and final state write. `GET /workbench?tenant=<tenant>&project=<project>&runId=<runId>` serves a focused browser workbench for a run, including workspace/executor context plus a run-filtered audit panel with readable non-secret policy/member change summaries, already-loaded follow-up child events for lineage status, and quiet audit-triggered current-run summary, replay (including gate/control changes), review-summary, handoff-package, file, command, and session refreshes that do not treat child workspace activity as source-run activity, clear active command errors, or replace already-loaded replay, review summary/handoff package panels, or follow-up lineage on transient failures. For running/queued runs, the workbench also loads current run events, keeps a `harness_event` SSE stream open with seq-based dedupe and browser-native reconnects, refreshes replay on new loop events, and closes that run stream on finish. `GET /tenants/:tenant/projects/:project/presence` lists active dashboard collaborators for that project, and `POST .../presence` heartbeats `{ clientId, label, focus }` from the dashboard's presence name and current file/run/command/session focus into a 45 second memory-plus-file presence registry under `.loom/presence/project`, so server instances sharing the workspace root can see the same project collaborators and same-file active editor hints; dashboard heartbeats also reload the full project presence list so other collaborators appear and expire without a manual refresh. `GET /tenants/:tenant/runs/:runId/presence` lists active workbench collaborators for that run, and `POST .../presence` heartbeats into the same short-TTL shape under `.loom/runs/<runId>/presence`, including `vas:<caseId>` focus while reviewing a VAS case. Dashboard and workbench presence name or focus changes trigger an immediate heartbeat instead of waiting for the next interval. `GET /tenants/:tenant/runs/:runId/replay` derives a compact human-readable timeline from the stored event log, including actor/role/clientId context, external-effect requester identity, assistant plans/action counts/finish requests, verification results, evaluator results, and reviewer command evidence when present. `POST /tenants/:tenant/runs/:runId/comments?project=<project>` appends a viewer-writable `user_message` run comment with actor/role/clientId context, updates replay/handoff views, and records `run_comment_added` in tenant audit. `POST /tenants/:tenant/runs/:runId/issue-comments/sync?project=<project>` requires `--control-plane-comment-sync`, reads the linked `metadata.issue`, pulls control-plane issue comments with the configured server token, skips empty comments and Loom-generated run-summary comments, appends new comments as idempotent `user_message` events, and records `run_issue_comments_synced` in tenant audit. `POST /tenants/:tenant/webhooks/gitea/issue-comments?project=<project>` requires `--control-plane-webhook-secret-env`, verifies the raw request body against `X-Gitea-Signature`, `X-Forgejo-Signature`, or `X-Hub-Signature-256`, extracts a Gitea/Forgejo `issue_comment` payload, finds runs and VAS cases linked to that issue, and appends the comment to matched run logs through the same idempotent path. A synced issue comment with a standalone `/loom pause` line writes a pause request for an active linked run, using the remaining comment text as the pause reason, so the loop stops before the next agent step with `pause` plus `finish: paused` events. A standalone `/loom resume` line on a linked issue comment can resume a paused run through the same persisted resume path, but only when the Gitea actor is mapped to a tenant `developer` or `admin` key. Standalone `/loom approve` and `/loom request-changes` lines decide a pending review-gated run as approved or rejected through the same review gate path; standalone `/loom claim-review` and `/loom release-review-claim` soft-claim or release the pending run review. Standalone `/loom approve-deploy` and `/loom reject-deploy` lines decide pending deployment gates, requiring the commenter to map to `admin`. Run-scoped sync targets that run, while webhook dispatch targets only the latest pending linked run for the issue. The remaining comment text becomes the review, claim, or deployment note in the synced `user_message`. Standalone `/loom approve-vas` and `/loom request-vas-changes` lines on a linked `vas-lite-review` run submit VAS case review decisions through the same human-gated path; the remaining comment text becomes the review note, while draft corrections/learnings stay as defaults, and the commenter must map to `developer` or `admin`. Standalone `/loom claim-vas [caseId]` and `/loom release-vas-claim [caseId]` lines soft-claim or release the linked VAS case for mapped developer/admin commenters; `caseId` is required when multiple cases are linked to the same issue. A standalone `/loom run-vas-review` line starts one async `vas-lite-review` run for the unique linked VAS case, including the first run when the issue is linked only through `case.issue` or a project source-default issue for a case without its own issue; use `/loom run-vas-review <caseId>` when an issue has multiple linked cases. The VAS run-start command is also developer/admin-only and dedupes across historical linked runs for the same comment and case. A standalone `/loom run-handoff-followup` line on a linked run starts one async queued handoff follow-up run from the latest matching source run; it is developer/admin-only, dedupes by comment, inherits source context, writes triggering comment id/url into the child run metadata and seed when available, and uses the remaining comment text as the reviewer note. When a browser run-comment body includes `"pause": true`, the server uses the same pause path. `POST /tenants/:tenant/runs/:runId/resume?project=<project>` requires `developer` access, rebuilds the original async run from its persisted request snapshot, appends a `resume` event, skips already-recorded scripted steps, and continues the same run id/event log until a new finish state is written; run event SSE replay stays append-only across the earlier paused finish. VAS Lite review runs can write `cases/<caseId>/reports/review-draft.json`; the artifacts endpoint returns that draft, and case review uses its note/corrections/learnings as defaults when the reviewer supplies only `decision` plus a matching `runId`, preserving the human approval gate before learnings enter `vocabulary/learned-patterns.md`. `GET /tenants/:tenant/runs/:runId/review-summary?project=<project>` returns run metadata, requester identity, review/deployment gate state, verification/evaluation/reviewer summaries, the replay timeline, structured `changedFiles` hints, and a bounded workspace git diff result that excludes `.loom`; it requires `git.diff` in the allowlist and does not require `shell.exec`. For `vas-lite-review` runs it also includes `vas.preset`, `vas.caseId`, and case artifacts/runs/reviewPackage/reviewRuns links. `GET /tenants/:tenant/runs/:runId/handoff-package?project=<project>` returns the same review summary plus workspace context, run-scoped command/session summaries, latest commit/PR handoff evidence, dashboard/API/workbench links, and the run-filtered tenant audit trail for reviewers; it also requires `git.diff`. `POST /tenants/:tenant/runs/:runId/handoff-runs?project=<project>` requires `developer` access, creates an async queued follow-up run from that handoff context, inherits repo/branch/baseBranch/issue and source `preset`/`presetInput` unless overridden, prepends a structured `handoff_followup` `user_message` with source run/package/gate/message/effect context, writes `metadata.handoffSource*` fields on the new run, and records `run_handoff_followup_created` tenant audit with `followupRunId`. `POST /tenants/:tenant/runs/:runId/review-claim?project=<project>` lets a developer/admin soft-claim or release a pending human review with `{ "action": "claim" | "release", "clientId": "..." }`, updates `summary.review.claim`, appends a `review_claim` run event, and records `run_review_claimed` in tenant audit without blocking other reviewers. Review decisions append `review_gate` plus final `finish` events with actor/client context and rewrite `summary.json`; an optional `contractPatch` with `objective`, `constraints`, and `successCriteria` is stored on the review gate and `review_decided` audit, and approved decisions apply it to the project contract through a `project_contract_updated` audit while rejected decisions keep it as evidence only. Dashboard and Workbench review forms expose the same patch fields and render recorded patches in review summaries. Deployment decisions append `deployment_gate` plus final `finish` events with actor/client context and require `admin` access when auth is configured.

GitHub-compatible providers can use `POST /tenants/:tenant/webhooks/control-plane/issue-comments?project=<project>&provider=agent-git-service` with the same webhook secret and `X-Hub-Signature-256`; when `provider` is omitted, the route defaults to the server's `--control-plane-provider`, so `--control-plane-provider agent-git-service` accepts the same endpoint without a query override. The synced events and audit records preserve `controlPlaneProvider`, comment id/url, delivery id, and provider-prefixed external actors. Add tenant policy `controlPlaneIdentities` entries such as `{ "provider": "agent-git-service", "externalActor": "octo-agent", "actor": "alice-agent", "role": "developer" }` to let signed provider comments drive review/claim/VAS/handoff commands as tenant-scoped identities without exposing tokens. `loom harness serve --control-plane-provider agent-git-service` switches issue comments, PR creation, merge calls, issue URLs, status, doctor, startup token validation, and smoke evidence onto the GitHub-compatible adapter while keeping Gitea/Forgejo as the default provider. Without explicit `--control-plane-url` or `--control-plane-token-env`, that provider reads `LOOM_AGENT_GIT_SERVICE_URL` and `LOOM_AGENT_GIT_SERVICE_TOKEN`; doctor reports only env names, `tokenMode`, tenant token env names, provider-derived `controlPlaneGitTransport.sampleRemoteUrl`, provider catalog `/api/v3` discovery/native capability evidence, and workspace branch lease evidence, never token values. Smoke uses `--check-control-plane-pr` and `--check-control-plane-comments` as the provider-neutral readiness flags, with `--check-gitea-pr` and `--check-gitea-comments` kept as compatibility aliases. The output includes provider-neutral `controlPlanePr*`, `controlPlaneComments*`, `serverControlPlaneApiBasePath`, `serverControlPlaneDiscoveryEndpoints`, and `serverControlPlaneNativeCapabilities` fields alongside the legacy `gitea*` compatibility fields, so CI can assert the shared adapter seam without binding to Gitea names. The AGS adapter also exposes `createAgentGitServiceAgent(...)` for `POST /api/v3/agents`, `grantAgentGitServiceRepoAccess(...)` for `PUT /api/v3/repos/{owner}/{repo}/collaborators/{agent}`, issue workspace presence/attachment helpers under `/api/v3/repos/{owner}/{repo}/issues/{number}/workspaces`, and wiki memory helpers under `/api/v3/repos/{owner}/{repo}/wiki/memory/{page}`. `provisionAgentGitServiceProjectAgent(...)` in `src/harness/agent-git-service-provisioning.ts` now composes those helpers for an existing tenant/project and writes only a non-secret `.loom/control-plane/agent-git-service/provisioning.json` receipt with `tokenEnvName` and `tokenMaterial: "returned-only"`; the generated agent token is returned to the caller and is not written to `.loom`. The admin HTTP provisioning endpoint below composes the same helper, can optionally write a non-secret tenant `controlPlaneIdentity` mapping in the same request, and can store the generated agent token in a server-side secret root when the server is started with `--agent-git-service-token-secret-root`. The shared control-plane provider interface also exposes `gitRemoteUrl(baseUrl, repo)`, so Gitea/Forgejo and `agent-git-service` can both derive provider-neutral `.git` remotes for clone/push wiring.

Provisioning receipt update, 2026-06-30: `POST /tenants/:tenant/projects/:project/control-plane/agent-git-service/provision` is now an admin-only endpoint for `--control-plane-provider agent-git-service`. It composes AGS agent registration plus repo permission grant for an existing tenant/project, writes only `.loom/control-plane/agent-git-service/provisioning.json` with non-secret receipt fields such as `tokenEnvName` and `tokenMaterial: "returned-only"`, and records token-free tenant audit/project activity. By default the generated AGS agent token is returned once as `agentToken`; if the request includes `"storeAgentToken": true`, the server must have `--agent-git-service-token-secret-root <path>` configured, writes the token as a `0600` file under `<path>/<tenant>/<project>/<tokenEnvName>`, and returns only token-free `agentTokenSecret` evidence such as `{ "stored": true, "tokenEnvName": "...", "secretRef": "alice/proj-a/LOOM_AGENT_TOKEN" }`. Once the receipt and secret file exist, project/run workspace prepare steps, including Coder git clone/fetch/worktree setup, run/workspace commands, and workspace sessions receive the token under `tokenEnvName` through the executor environment; Coder git prepare also gets a non-secret `gitCredential.tokenEnvName` hint and installs a temporary `GIT_ASKPASS` script for clone/fetch/worktree/switch, so the token is not written into `.git/config`, run summaries, command summaries, tenant audit, status, receipts, or project metadata. If the request includes `controlPlaneIdentity`, for example `{ "actor": "alice-agent", "role": "developer" }`, the server maps the provisioned AGS `agentLogin` as the external actor into tenant policy and audits the non-secret policy change; no role is granted unless the operator supplies this block. `GET` on the same path returns only the receipt; repeat `POST` returns `409` without calling AGS again unless the request includes `"force": true`. It is still not an automatic tenant cutover.

Provisioning plan update, 2026-07-01: `GET /tenants/:tenant/control-plane/agent-git-service/provisioning-plan` is an admin-only, read-only operator plan for `--control-plane-provider agent-git-service`. It lists every registered project in the tenant with token-free receipt/secret readiness, repo/default-source coverage, generated default `tokenEnvName`, aggregate ready/provisioned/secret-stored/missing counts, and `provisionCommandArgs` arrays for projects that need first-time provisioning or forced re-provisioning after a stored secret is missing. It checks only whether the server-side secret file exists; it does not read token material into the response, call AGS, write audit, or perform automatic rollout. This is the intended future hook for batch AGS onboarding. Operators can read the same plan through the Dashboard Server panel or `loom harness agent-git-service-provisioning-plan --url http://127.0.0.1:8787 --tenant alice --admin-token-env LOOM_ADMIN_TOKEN`; the CLI prints the server JSON without echoing the admin token. `POST /tenants/:tenant/control-plane/agent-git-service/provisioning-plan/apply` is the matching admin-only batch apply path: it applies only plan-eligible projects, stores generated project-agent tokens under `--agent-git-service-token-secret-root`, returns per-project `provisioned` / `skipped` / `failed` status without token material, and records token-free audit. Use the Dashboard Server panel's Dry Run Apply action or `loom harness apply-agent-git-service-provisioning-plan --url http://127.0.0.1:8787 --tenant alice --admin-token-env LOOM_ADMIN_TOKEN --dry-run` first; then use Dashboard Apply Plan or omit `--dry-run` to provision all eligible projects, with `--projects proj-a,proj-b` / the Dashboard projects field to constrain the batch, or `--eligible-only` / the Dashboard Eligible projects only checkbox to omit ready/skipped rows from the apply result. Dashboard project cards with missing AGS project agents can stage that same plan form for the selected project and enable eligible-only mode.

AGS native handoff update, 2026-07-01: when the server runs with `--control-plane-provider agent-git-service`, has `--control-plane-url`, `--control-plane-token-env`, and a public URL, a successful run-scoped workspace PR handoff now looks up AGS issue workspaces for the linked issue and matching branch, then publishes the run handoff package URL as an AGS workspace attachment. The run log records a token-free `external_effect` with `kind: "agent_git_service_workspace_attachment"` and the workspace/attachment ids. This is additive evidence for online sandbox handoff; it does not replace the first-party handoff package, tenant audit, review gates, or PR handoff.

AGS wiki memory update, 2026-07-01: approved `vas-lite` learnings are still written first to the project-local `vocabulary/learned-patterns.md` and tenant audit. When the server is configured for `agent-git-service` with a control-plane URL/token and the VAS case has a repo ref, the same review-approved learning is also appended to the AGS repo wiki memory page `vas/learnings`. Success or failure is recorded as token-free tenant audit (`agent_git_service_wiki_memory_updated` / `agent_git_service_wiki_memory_failed`), so AGS memory remains a projection of reviewed harness evidence rather than the source of truth.

AGS native projection smoke update, 2026-07-01: `loom harness smoke --profile platform-readiness --control-plane-provider agent-git-service` now turns those native projections into CI-visible fields. When both projections succeed, output includes `agentGitServiceNativeProjectionChecked`, `agentGitServiceHandoffWorkspaceAttachment*`, `agentGitServiceWikiMemory*`, and the `agent-git-service-native-projection` capability in `onlineSandboxGoldenPathCapabilities`. The AGS adapter also accepts common Git remote URLs such as `https://git.example/team/app.git` when a wiki-memory projection needs an `owner/repo` ref.

Cutover gate update, 2026-06-30: under `--profile platform-readiness --control-plane-provider agent-git-service`, `GET /status` and `loom harness doctor` now scan registered tenant/project directories and expose `readiness.checks.agentGitServiceProjectAgents` / `checks.agentGitServiceProjectAgents`. Any project missing the AGS provisioning receipt, or missing the stored token file under `--agent-git-service-token-secret-root`, keeps readiness false with only project refs in `missingProjects` or `missingSecretProjects`. `loom harness smoke --profile platform-readiness` includes the same non-secret `agentGitServiceProjectAgents*` diagnostics in failure details and successful JSON output when the check is present. The Dashboard Server panel renders the same non-secret check with provisioned and secret-stored project counts, plus missing receipt/secret project refs. Project list/detail responses also expose per-project `controlPlane.agentGitServiceProjectAgent` readiness with `receiptPresent`, `secretStored`, `ready`, receipt metadata, and `tokenEnvName`, but never token material. With `--control-plane-provider agent-git-service`, platform-readiness smoke also runs the cutover rehearsal by default and records `agent-git-service-cutover` in `onlineSandboxGoldenPathCapabilities`, proving the stored project-agent token is actually injected into workspace commands without exposing token material. A tenant/project is ready for the AGS path only after the token-free receipt and server-side stored secret both exist.

Operators can call the same admin endpoint through the CLI without putting the admin token in the shell history:

```bash
LOOM_ADMIN_TOKEN=admin-secret loom harness provision-agent-git-service \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --project proj-a \
  --repo team/app \
  --permission admin \
  --agent-prefix-login loom-alice-proj-a \
  --default-repo-name proj-a \
  --token-env-name LOOM_ALICE_PROJ_A_AGENT_TOKEN \
  --identity-actor alice-agent \
  --identity-role developer \
  --store-agent-token \
  --admin-token-env LOOM_ADMIN_TOKEN
```

When `--store-agent-token` is omitted, the command prints the server response including the one-time `agentToken`; when it is present, the server must have `--agent-git-service-token-secret-root` configured and the response contains token-free `agentTokenSecret` evidence instead. The Dashboard Server panel exposes the same admin-only provisioning action for the selected tenant/project, using the currently authenticated admin key and optionally asking the server to store the token without writing it into `.loom` or the browser response.

Queued run recovery writes `queued_run_recovered` or `queued_run_recovery_failed` into tenant audit with run id, queued timestamp, and queue position evidence.

Run review claim takeover records the prior `previousClaim` in the `review_claim` run event and `run_review_claimed` tenant audit while keeping claims soft.
Project `latestControlActivity` carries the same `previousClaim` for run-review and VAS claim events, so project cards can show takeover or release evidence without opening the audit feed.

For `/loom run-vas-review` commands on an existing linked VAS run, the child review run inherits the source run's `model` and non-default `modelProtocol` so tool-call model loops keep the same adapter contract. Workbench-started VAS review runs use the current run metadata the same way.

When creating an HTTP run, set `"syncIssueComments": true` with an `issue` to pull existing non-Loom Gitea/Forgejo issue comments into the new run log as initial `user_message` events before the agent loop starts. This requires the same configured issue comment reader used by `POST .../issue-comments/sync` and records `run_issue_comments_synced` tenant audit with `initial: true`.

Handoff packages also include a structured `gateTrail` derived from run gate events, so reviewers can see which review/deployment gates opened or changed and which client/actor context caused them.

Handoff packages expose `externalEffects` derived from `external_effect` run events for issue comments, PR creation, merges, and brain ingest, including requester/client context and common issue/PR/evidence links.

Handoff packages also expose structured `messages` derived from `user_message` events, so reviewers can see the original goal, browser run comments, synced issue comments, command-style comments, and `handoff_followup` seeds with actor/client metadata plus issue-comment trigger evidence when present. `links.followupRuns` is the API entry for starting inherited follow-up runs from that package, while `followupRuns[]` lists existing children with current status, links, and issue-comment trigger evidence when present. The focused workbench can start those follow-up runs with an explicit goal and reviewer note, and it renders existing child-run links so reviewers can jump between handoff generations.

Replay, review-summary, handoff-package, and handoff-runs responses include a `checkpoint` with `schemaVersion`, a short `version` hash, run event anchors, and audit/follow-up anchors where relevant. Dashboard and Workbench render the checkpoint version and use it during quiet evidence refreshes to show when loaded replay/review/handoff context changed, or when a transient refresh failure kept the previous checkpoint instead of discarding usable context. Browser-created handoff follow-up runs first ensure a handoff package checkpoint is loaded, then include its `sourceCheckpointVersion`; `POST .../handoff-runs` rejects stale versions with `409`, records `run_handoff_followup_denied` tenant audit with actor/client and observed checkpoint evidence, and returns the current checkpoint so reviewers do not continue from obsolete evidence. When that happens in the browser, the loaded handoff package is refreshed quietly and the reviewer is prompted to retry from the new checkpoint.

Issue comment sync and webhook responses also return `startedHandoffFollowups[]` entries with the child run id/status, source checkpoint version, workbench and handoff-package links, and triggering Gitea/Forgejo comment id/url when a `/loom run-handoff-followup` command starts a child run. Handoff packages and lineage responses carry the same source checkpoint on `issueCommentSeeds[]` and `followupRuns[]`, so browser evidence panels can show exactly which source evidence version produced each external follow-up. When `run_handoff_followup_denied` arrives through tenant audit, Dashboard and Workbench quietly refresh any loaded follow-up lineage too, so denied attempts advance the evidence checkpoint instead of leaving the panel stale.

Tenant audit includes `brain_signal_ingested` events for completed-run brain ingest and native Stop-hook signals, including reviewer status for completed harness runs, so dashboard/workbench refresh can see brain feedback without reading run logs.

Run-scoped workspace PR handoffs can include `"reviewRequired": true` and/or `"deploymentRequired": true`; when both are set, review approval advances the run into pending deployment approval.
When the first VAS review run is started from a `case.issue` webhook command, the command comment is copied into that new run's event log and the tenant audit entry records the new run id, case id, comment id, and delivery id.
`GET /healthz` is an unauthenticated liveness endpoint for deployment probes; it returns only `ok`, `startedAt`, and `uptimeMs`. `GET /readyz` is an unauthenticated readiness endpoint; it returns `503` until startup stale-run cleanup and queued-run recovery have completed or been disabled, then returns `200` with only readiness check names and instance timing. Smoke now records `healthProbesChecked`, `readyzCheckNames`, and `healthProbesSensitiveFieldsAbsent` after verifying those probes do not expose status-only fields such as `resources`, `policy`, `workspaceRoot`, or `tenants`. `GET /metrics` returns Prometheus-style low-cardinality gauges for readiness, active runs, queued runs, active workspace sessions, orphaned running runs, review-required runs, deployment-required runs, model-usage warning projects, workspace-usage warning projects, queued-run recovery, and stale-run cleanup. It uses the same access rule as global status: public only on unauthenticated servers, and `admin`-only once any tenant token or API key exists. Metrics intentionally avoid tenant, project, run, actor, and client labels; use authenticated status or tenant status for detailed debugging. Smoke profiles and `--check-metrics` parse that endpoint as numeric, unlabeled samples and fail on tenant/project/token text or labelled samples. `GET /status` returns server instance metadata (`workspaceRoot`, `startedAt`, `uptimeMs`), profile readiness (`readiness.ok`, `readiness.missing`, per-check details, and `readiness.goldenPath` profile capability markers), `visionLock` target/capability markers that keep the long-term multi-user sandbox platform goal visible, active/queued run counts aggregated across server instances sharing the workspace root, active run details with workspace lease scope/key evidence, active workspace session details with project/run/actor/client and idle lifecycle fields aggregated across the same shared root, per-tenant active/queued/session resource buckets with the same cross-server active-run and session view, orphaned persisted running run details without a live admission claim after restart with lease/stale state, queued run details with tenant/project queue positions and the current cross-server blocked reason, stale run cleanup audit counts/errors from startup, queued recovery audit counts/errors from startup, effective tool allowlist, and resource limits used by the dashboard Server panel, including run lease TTL, per-tenant active run caps, and global/per-tenant workspace session caps. `server.controlPlane.boundary` exposes the provider-neutral seams used by Gitea/Forgejo and `agent-git-service`: issue comments, signed webhooks, pull requests, merge, review-gate evidence, issue URLs, repo refs, source defaults, Git transport, workspace branch lease evidence, agent identity, and backup/restore migration. `server.controlPlane.apiBasePath`, `discoveryEndpoints`, `nativeCapabilities`, and `adoptionStages` expose provider catalog evidence such as AGS `/api/v3`, `/api/v3/meta`, `/api/v3/rate_limit`, durable agent identities, issue workspace presence, wiki memory, and the gated `tenant-default-cutover` stage. Aggregate status scans skip missing or malformed persisted run state files instead of failing the control-plane endpoint. It is public only when tenant auth is not configured; once any tenant token or API key exists, status requires an `admin` key because it contains cross-tenant resource details. `GET /tenants/:tenant/status` is the viewer-readable tenant-scoped status surface for authenticated dashboards; it returns non-sensitive profile `readiness` including `readiness.goldenPath` and `visionLock`, that tenant's effective `policy.allowedTools`, server limits with that tenant's policy-overridden active-run and workspace-session caps, and only that tenant's active/queued/session counts plus active run lease, active session, queued, and orphaned run details, without `workspaceRoot`, cross-tenant buckets, global recovery audits, or host run directories.
Both status surfaces expose `server.runWorkspaceIsolation`; `platform-readiness` marks `readiness.checks.runWorkspaceIsolation` missing unless the mode is `run`. They also expose `server.runCreateIdempotency` and `readiness.checks.runCreateIdempotency`, covering caller-supplied `clientRequestId`, the shared run-store request record, cross-server replay, simultaneous-create replay, and `409` conflict behavior for mismatched requests.
`GET /tenants/:tenant/access` returns the current request's tenant actor, role, and authenticated state without token values. The dashboard uses it to keep `viewer` keys read-only and reserve admin controls for `admin` keys; open unauthenticated servers report `anonymous` with `admin` role to match the open API behavior.
`GET /tenants/:tenant/policy` returns the tenant policy with API key tokens stripped. `PUT /tenants/:tenant/policy` requires `admin` access when auth is configured, writes the full `<workspace-root>/<tenant>/.loom/policy.json`, including `apiKeys` and non-secret `controlPlaneIdentities`, stores supplied plaintext `token` values as `tokenHash`, and records non-secret `policyChange` before/after evidence in the tenant audit feed. `POST /tenants/:tenant/policy/settings` also requires `admin`, updates only `modelKeyEnv`, `executorTemplateParameters`, `limits`, and `allowedTools`, preserves existing `apiKeys` and `controlPlaneIdentities`, treats `allowedTools: null` as inherit-the-server-allowlist, and records the same non-secret `policyChange` shape for settings. `POST /tenants/:tenant/policy/api-keys` creates a policy-backed tenant API key, optionally generating a `loom_...` token, stores only a hash, returns that new token once without leaking existing tokens, and audits token-free `createdApiKey` plus `apiKeysBefore/apiKeysAfter` membership evidence. `POST /tenants/:tenant/policy/api-keys/revoke` removes matching policy-backed keys by actor and optional role, and audits token-free `revokedApiKeys` plus the same membership before/after evidence. Policy `apiKeys` add tenant-specific actors/roles and can carry their own non-secret `modelKeyEnv`; that key-level env overrides the tenant-level `modelKeyEnv` for model-backed runs created with that API key. Tenant policy `controlPlaneIdentities` maps signed provider comment authors by provider/external actor into tenant actors/roles without token material. Tenant policy `modelKeyEnv` selects the tenant fallback model key environment variable without exposing the key value, `executorTemplateParameters` passes non-secret Coder template parameters for that tenant after CLI defaults, `limits.maxActiveRuns` and `limits.maxWorkspaceSessions` override the server caps for that tenant, model token/cost warning limits emit project-summary model usage warnings without blocking runs, and model token/cost hard limits reject model-backed run creation, queued-run starts, and resumes once the current project/requester aggregate is at or above the configured cap. Paused run resumes keep budget checks on the original run requester while the `resume` event and tenant audit still record the developer who resumed it. `limits.executorCpus` / `executorMemory` / `executorPidsLimit` / `executorNetwork` are passed to executor factories for per-tenant sandbox caps, and `allowedTools` narrows that tenant to a subset of the server allowlist. Docker executors apply all four executor limits at command runtime; the Coder executor maps CPU, memory, and pids into workspace creation parameters while keeping network selection in the Coder template deployment. The dashboard Server panel loads the sanitized policy, saves non-secret settings through the settings endpoint, and creates/revokes policy members without round-tripping existing token values through the browser.
`GET /tenants/:tenant/policy/escalations` lists persisted policy escalation requests from `<workspace-root>/<tenant>/.loom/escalations`. `POST /tenants/:tenant/policy/escalations` lets a tenant user request extra tools or limits with a reason. `POST /tenants/:tenant/policy/escalations/:escalationId/decision` requires `admin`; `approved` merges the requested tools/limits into policy without changing existing `modelKeyEnv`, `executorTemplateParameters`, or API key actors, stores `policyChange` before/after evidence on the escalation and audit events, and `rejected` leaves policy unchanged. The dashboard Server panel exposes the same request and decision controls, and dashboard/workbench PR handoff controls can create targeted `git.pr` requests when that tool is missing.
`GET /tenants/:tenant/audit?after=<seq>&limit=<n>&project=<project>` returns the tenant-level audit feed persisted at `<workspace-root>/<tenant>/.loom/audit.jsonl`; omit `project` for all tenant events, or pass it to filter to one project. `GET /tenants/:tenant/audit/stream?after=<seq>&project=<project>` streams the same filtered shape over SSE as `tenant_audit` events. The feed records successful project/VAS case/run creation, project source/default-skill/run-policy/contract setting updates, queued-run starts and finishes, VAS case claim changes, run comment additions with optional pause requests, linked issue comment syncs, run resume, run cancel/abandon, run review claims, review/deployment decisions, workspace file writes/moves/deletes, workspace git commits, workspace PR handoffs, workspace commands, workspace session start/input/stop/exit actions, tenant policy updates, tenant API key creation/revocation, tenant policy escalation requests/decisions, and automatic stale-run cleanup. Async `run_finished` audit events include non-secret `modelUsage` plus `modelUsageWarnings` when policy thresholds are exceeded. Events include `actor` and `role` when the request used a named tenant key, and mutable workspace actions may include a caller-supplied `clientId` to correlate browser workbench tabs or API clients. The dashboard Server panel and focused workbench load and subscribe to the tenant audit stream, format non-secret policy diffs and policy-member create/revoke evidence into readable summaries, and use matching events to quietly refresh dashboard project summary/backlog/warning/run/file/command/session/follow-up-lineage views or focused workbench run/replay (including gate/control changes)/review-summary/handoff-package/file/command/session/follow-up-lineage views without clearing active command errors or replacing already-loaded replay, evidence panels, or lineage on transient failures.
Tenant audit also records `tenant_control_plane_restore_dry_run` with provider, source/target provider, format, project names, project/run counts, missing/extra project counts, audit checkpoint count, and secret-scrub evidence. Project summaries surface that event as `latestControlActivity` for each project named in the dry-run manifest.
`GET /tenants/:tenant/control-plane/backup` returns an admin-only, non-secret tenant backup/migration manifest with schema version, generated time, current control-plane provider boundary, sanitized tenant policy plus API key count, audit checkpoint, project summaries, and lightweight per-project run metadata. It does not include workspace file contents, API key tokens, token hashes, or model key values; use it as the portable control-plane manifest before migrating from the default Gitea/Forgejo path to another provider.

`GET /tenants/:tenant/control-plane/cutover-readiness?targetProvider=agent-git-service` is an admin-only, read-only readiness shortcut for the gated `tenant-default-cutover` stage. It returns the same non-secret `cutoverReadiness` shape used by AGS-target restore dry-runs, including project-agent receipt/secret counts and missing project refs, without requiring a backup manifest or writing audit. The Dashboard Server panel can load the same gate directly next to the AGS tenant plan controls.

`POST /tenants/:tenant/control-plane/restore-dry-run` accepts that manifest and returns an admin-only, non-mutating restore/migration validation summary. Add `?targetProvider=<provider>` to validate the current manifest against another serve-enabled catalog provider before any tenant cutover; for example, default Gitea/Forgejo manifests can be checked against `agent-git-service`, and agent-git-service manifests can be checked back against `gitea-forgejo`. It checks schema version, route tenant, source provider, target provider boundary, complete manifest boundary, project entries, run ids, audit checkpoint, and secret scrubbing; the response includes `applied: false`, `sourceProvider`, `targetProvider`, expected project names, expected run count, and missing/extra project names so provider migrations can be tested before any tenant state is changed. When the target is `agent-git-service`, the response also includes non-secret `cutoverReadiness` for the gated `tenant-default-cutover` stage, including `agentGitServiceProjectAgents` receipt/secret counts plus missing project refs. Successful dry-runs append the non-secret `tenant_control_plane_restore_dry_run` audit event.

`GET /tenants/:tenant/projects` lists registered project directories plus `runCount`, latest run state, `activityAt` (latest run start, project command end, project terminal session start/end, project workspace file/commit/PR activity, project human/control-plane activity, or project creation time), `latestWorkspaceCommand` when a project command exists, `latestWorkspaceSession` when a project terminal session exists, `latestWorkspaceActivity` when project-scoped file/commit/PR audit activity exists, `latestControlActivity` when project-scoped comment/issue-sync/resume/cancel/abandon/review/deployment/handoff audit activity exists, `activeWorkspaceSessions` and active session summaries (`activeWorkspaceSessionDetails`) when present, active dashboard collaborators (`activeProjectCollaboratorCount`, `activeProjectCollaborators`) when present, active run workbench collaborators (`activeRunCollaboratorCount`, `activeRunCollaborators`) when present, any project `template`, project source defaults (`repo`, `branch`, `baseBranch`, `issue`), project `defaultSkills`, project `runPolicy`, project `contract`, project `contractStatus`, any `runningRunId`, active queue backlog (`queuedRunCount`, `queuedRunIds`, `queuedRuns` with tenant/project queue positions and blocker details) when present, pending human gate backlog (`reviewRequiredRunCount`, `reviewRequiredRunIds`, `reviewRequiredRuns`, `deploymentRequiredRunCount`, `deploymentRequiredRunIds`, `deploymentRequiredRuns`) when present, aggregate model usage (`modelUsage`), per-requester usage (`modelUsageByRequester`), policy-threshold warnings (`modelUsageWarnings`) when completed runs emitted non-secret usage data, workspace byte usage (`workspaceBytes`), configured workspace byte cap/warning threshold, and `workspaceByteWarnings` when tenant policy enables `maxWorkspaceBytes` or `workspaceByteWarning`, and for `vas-lite` projects aggregated VAS readiness (`vasCaseCount`, `vasNeedsReviewCaseCount`, `vasReviewedRunCount`, `vasUnreviewedRunCount`), so a control plane can find active, online, queued, orphaned, changed, review-pending, deployment-pending, model-expensive, workspace-heavy, contract-drifting, or recently human-touched projects before opening their run history. `GET /tenants/:tenant/model-usage/warnings` returns `{ tenant, projects }` with the same `ProjectSummary` shape filtered to projects whose policy-threshold warnings are currently active; `GET /tenants/:tenant/workspace-usage/warnings` does the same for workspace byte warnings. The dashboard loads both as warning queues and refreshes them on matching audit or policy-threshold changes. Gate run detail entries include run id, goal, status, started time, source metadata, requester, gate status, and review claim when present. `GET /tenants/:tenant/projects/:project` returns the same summary plus required `template`, `createdAt`, and the project activity index. `POST /tenants/:tenant/projects` creates a tenant project directory from `{ "project": "proj-a", "template": "empty" | "vas-lite", "repo": "team/proj-a", "branch": "task/proj-a-123", "baseBranch": "main", "issue": "team/proj-a#123", "clientId": "..." }`, requires `developer` access when auth is configured, stores source defaults in tenant control-plane metadata instead of the project file tree, returns the project summary, and appends a `project_created` tenant audit event. `PUT /tenants/:tenant/projects/:project/source-defaults` updates those source defaults from `{ "repo": "...", "branch": "...", "baseBranch": "...", "issue": "...", "clientId": "..." }`; empty strings clear fields, and an all-empty body removes the stored defaults while appending `project_source_defaults_updated`. Later `POST /runs` calls for that project inherit current source defaults when the run body omits the same fields. The default `empty` template preserves the old empty-directory behavior. The `vas-lite` template seeds a lightweight file-based video analysis system skeleton with `cases/`, `vocabulary/`, `src/loop.js`, `package.json`, and `.loom/project.json` metadata; it also seeds a project contract that keeps the multi-user online sandbox harness-loop goal, human gates, durable evidence, and VAS learning loop visible beyond the MVP. Its bootstrap case inherits project source defaults when supplied, so an online sandbox has a domain loop ready for follow-up runs. `GET /tenants/:tenant/projects/:project/vas/cases` lists `vas-lite` case summaries from `cases/<caseId>/case.json` plus effective repo/branch/baseBranch/issue metadata, `sourceDefaultFields` when any displayed source field came from project defaults rather than the case file, matching `vas-lite-review` run count, latest run id/status/time, and review coverage (`reviewedRunCount`, `unreviewedRunCount`, latest run review decision/time) from `.loom/runs` plus case reviews; `POST /tenants/:tenant/projects/:project/vas/cases` creates a new case with `{ "caseId": "segment-001", "title": "...", "repo": "team/proj-a", "branch": "vas/segment-001", "baseBranch": "main", "issue": "team/proj-a#123", "source": { "kind": "video", "url": "...", "range": { "start": 0, "end": 8 } }, "clientId": "..." }`, inherits project source defaults when any case repo/branch/baseBranch/issue field is omitted, writes the case file plus default artifact directories, and appends a `vas_case_created` audit event. `POST /tenants/:tenant/projects/:project/vas/cases/:caseId/review` applies `{ "decision": "approved" | "changes_requested", "note": "...", "corrections": ["..."], "learnings": ["..."], "runId": "<matching-vas-lite-review-run>", "clientId": "..." }` to the same `case.json`, verifies `runId` belongs to that case when supplied, sets status to `reviewed` or `needs_revision`, appends `reviews`, `corrections`, and review-sourced `learnings`, emits `vas_case_reviewed`, and for approved reviews also appends each learning to `vocabulary/learned-patterns.md`. `GET /tenants/:tenant/projects/:project/vas/learnings` returns a viewer-readable project learning index aggregated from case JSON with `caseId`, `text`, `source`, `reviewDecision`, reviewer, run id, and client metadata. `node src/loop.js status` reports `learnedPatternCount` from reviewed case learnings so the project-level loop can see accumulated learning. `POST /runs` accepts `{ "tenant": "alice", "project": "proj-a", "preset": "vas-lite-review", "presetInput": { "caseId": "bootstrap" } }` for `vas-lite` projects; `caseId` defaults to `bootstrap` and must have `cases/<caseId>/case.json`. The preset fills default goal, `node src/loop.js status` verification, and `["vas-lite", "coding"]` skills unless the request overrides them. It first runs a preset setup `file.write` action so scripted, command, and model agents can read `cases/<caseId>/reports/context.json` as structured loop input containing approved prior learnings from other cases plus bounded current-case `reviewGuidance`; the default scripted path also writes `reports/latest.md` with both sections and records `metadata.runPreset` plus `metadata.runPresetInput` counts (`priorLearningCount`, `reviewCount`, `correctionCount`, `caseLearningCount`).
Project creation and setting updates for source defaults, default skills, run policy, and contract also feed `latestControlActivity`, so project cards show the latest control-plane change with actor/client evidence.
Project template metadata may include `defaultSkills`; `vas-lite` seeds `["vas-lite", "coding"]`. Project summaries expose default skills when present, and both ordinary `POST /runs` requests and the `vas-lite-review` preset inherit them when the request omits `skills`. `PUT /tenants/:tenant/projects/:project/default-skills` accepts `{ "defaultSkills": ["vas-lite", "coding"], "clientId": "..." }`, requires `developer` access when auth is configured, writes the value into `.loom/project.json`, returns the refreshed project summary, and records `project_default_skills_updated` audit evidence; an empty array is an explicit no-default-skills override.
Project metadata may also include `runPolicy` with `preset`, `presetInput.caseId`, `reviewRequired`, and `deploymentRequired`. `PUT /tenants/:tenant/projects/:project/run-policy` accepts those fields plus `clientId`, requires `developer` access, writes the compact policy into `.loom/project.json`, returns the refreshed project summary, and records `project_run_policy_updated`; an empty policy clears the project default. Later `POST /runs` calls and async project run entrypoints inherit policy fields only when the request omits those fields, so explicit per-run `false`, preset, or preset input still wins. Runs whose request was filled by the project policy include non-secret `metadata.projectRunPolicy` evidence with the inherited field names and values, and `run_created` audit carries the same evidence for Dashboard, review packages, and handoff readers.
Project metadata may also include `contract` with `objective`, `constraints`, and `successCriteria`. `PUT /tenants/:tenant/projects/:project/contract` accepts those fields plus `clientId`, requires `developer` access, writes the compact contract into `.loom/project.json`, returns the refreshed project summary, and records `project_contract_updated`; empty strings and empty arrays clear it. Project summaries also include `contractStatus` when a contract is present or the template requires one. For `vas-lite`, the status checks that the contract still mentions the multi-user online sandbox, harness loop, human gates, durable evidence, and VAS learning markers, and smoke fails before the run if that status drifts. Later runs snapshot the current contract and status into non-secret `metadata.projectContract` / `metadata.projectContractStatus`; when the status is drifted, run creation forces the review gate even if the request tried to omit it. Approved review decisions can carry a `contractPatch` that writes the repaired contract back to project metadata and audits `project_contract_updated`; rejected decisions keep the patch as review evidence without changing the project. `run_created` audit carries the same evidence, and handoff follow-up runs copy the source run's snapshot into `metadata.handoffSourceProjectContract` / `metadata.handoffSourceProjectContractStatus` plus handoff lineage evidence so agents, reviewers, and handoff readers can see the original project goal and drift state even after the MVP evolves.
Project-scoped workspace, file, command, terminal session, diff, commit, and PR executor contexts inherit project `repo`, `branch`, and `baseBranch` defaults when no run-scoped override is present; project-scoped PR handoffs can also default `issue`, `branch`, and `baseBranch` from those project source defaults. When `runWorkspaceIsolation` is `run`, run-scoped workspace operations use the run id in their active-workspace lock, so file/command/session/commit/PR work for one run can proceed while another same-project run is still active in a different worktree; mutating file routes serialize writes, moves, and deletes against the same active run. A run-scoped PR handoff that omits `branch` derives `<fallback>/<runId>` from run metadata or project defaults so concurrent runs do not push to the same review branch; an explicit request `branch` is left unchanged.
`GET /tenants/:tenant/projects/:project/vas/cases/:caseId/artifacts` returns viewer-readable VAS loop artifacts for that case: the generated `reports/context.json` object, the generated `reports/latest.md` text when present, and both relative artifact paths.
`GET /tenants/:tenant/projects/:project/vas/cases/:caseId/runs` returns the case's effective repo/branch/baseBranch/issue plus `sourceDefaultFields`, then the full newest-first `vas-lite-review` run history for that case, including run id, status, goal, start/end time, agent mode, issue/summary links, and normalized preset input.
Each case run entry also includes relative `reviewSummaryUrl` and `handoffPackageUrl` reviewer links, PR link metadata, run-level review/deployment gate status, failure kind/focus plus bounded public error diagnostics when present, event-derived VAS artifact paths/written markers for context/report/review draft files, and per-run human review status, decision, reviewer, review client id, and reviewed timestamp when that run has been reviewed through the case review gate.
`GET /tenants/:tenant/projects/:project/vas/review-queue` returns viewer-readable case summaries that need attention because they have unreviewed runs, `needs_review`, or `needs_revision`, with direct links for review packages, runs, artifacts, reviews, and follow-up review runs.
`POST /tenants/:tenant/projects/:project/vas/cases/:caseId/claim` lets a developer/admin soft-claim or release a case with `{ "action": "claim" | "release", "clientId": "..." }`; the claim is persisted on the case summary/review package and recorded as `vas_case_claimed` audit without blocking reviews. Claim takeover records the prior `previousClaim` in audit so VAS review queue ownership stays observable while remaining soft.

VAS case creation, claim, and review audit events also feed project `latestControlActivity`, so project cards show recent VAS queue ownership, takeover evidence, and review movement alongside run controls.
`GET /tenants/:tenant/projects/:project/vas/cases/:caseId/review-package` returns the case summary, current artifacts, full run history, reviews, corrections, learnings, reviewer links, `issueCommentSeeds`, and a case-filtered tenant audit trail in one viewer-readable package for Dashboard and Workbench review handoff. VAS review-run issue-comment seed audits carry the same `presetInput.caseId`, so the package shows the initial external context sync alongside run creation and review decisions.
`POST /tenants/:tenant/projects/:project/vas/cases/:caseId/review-runs` is the case-scoped way to start an async queued `vas-lite-review` run. It requires `developer` access, returns `202` with the running or queued status, inherits repo/branch/baseBranch/issue from the case when the body omits them, inherits project `runPolicy` gate defaults when the body omits `reviewRequired` or `deploymentRequired`, preserves optional model/modelProtocol/tool fields plus `pullRequest`, `reviewRequired`, `deploymentRequired`, and `syncIssueComments` from the body, and records the same `run_created` audit event as `POST /runs`. When `syncIssueComments` is true, it seeds linked issue comments into the new VAS review run and records `run_issue_comments_synced` with `initial: true`.
`GET /tenants/:tenant/projects/:project/files?path=<relative-path>` browses the live workspace tree and reads small text files for the current tenant/project through the configured executor. `POST /tenants/:tenant/projects/:project/files` creates or saves small UTF-8 text files with `{ "path": "...", "content": "...", "baseUpdatedAt": "...", "clientId": "..." }` through the same executor boundary; when `limits.maxWorkspaceBytes` is set, writes are rejected if the post-write non-`.loom` workspace content would exceed the cap. `POST /tenants/:tenant/projects/:project/files/move` moves one file with `{ "fromPath": "...", "toPath": "...", "baseUpdatedAt": "...", "clientId": "..." }`, refuses to overwrite an existing target, and records `workspace_file_moved`; `DELETE /tenants/:tenant/projects/:project/files?path=<relative-path>` deletes one file after confirming the target is not a directory and records `workspace_file_deleted`. When `baseUpdatedAt` is provided from the previous file read, stale writes, moves, and deletes return `409` with same-file active editors instead of overwriting, moving, or removing newer content, and the dashboard/workbench expose reload-latest actions to recover. When presence focus shows other collaborators on the same `file:<path>`, the file editor title shows those names before a save conflict happens. Use `GET`/`POST`/`POST .../files/move`/`DELETE /tenants/:tenant/runs/:runId/files?project=<project>&path=<relative-path>` to inspect, create, edit, move, or delete the workspace for a specific run with the same optional stale guard on writes, moves, and deletes; `GET /tenants/:tenant/projects/:project/diff` and `GET /tenants/:tenant/runs/:runId/diff?project=<project>` return a bounded workspace git diff through `git.diff`, excluding `.loom` and without requiring `shell.exec`; `POST /tenants/:tenant/projects/:project/commits` and `POST /tenants/:tenant/runs/:runId/commits?project=<project>` create an auditable local git checkpoint with `{ "message": "...", "clientId": "..." }` through `git.commit`; `POST /tenants/:tenant/projects/:project/pull-requests` and `POST /tenants/:tenant/runs/:runId/pull-requests?project=<project>` push `HEAD` to the requested or defaulted branch and create an auditable provider PR handoff with `{ "issue": "owner/repo#42", "branch": "...", "baseBranch": "...", "reviewRequired": true, "clientId": "..." }` through `git.pr` plus `--control-plane-pr`; project-scoped handoffs can default `issue`/`branch`/`baseBranch` from project source defaults, while run-scoped handoffs can default them from run metadata, derive a runId-suffixed branch under run-scoped workspace isolation when the request omits `branch`, include requester, run evidence links plus verification/evaluation/reviewer summaries in the default PR body, and can move a passed run back to `review_required`; `GET /tenants/:tenant/runs/:runId/handoff-package?project=<project>` packages the resulting review evidence, workspace context, structured changed-file hints plus command/session summaries that Workbench can reopen directly, commit/PR handoff fields, dashboard/API/workbench links, and audit trail for human review; `POST /tenants/:tenant/runs/:runId/commands?project=<project>` runs an allowed shell command in that same run workspace and records a command summary under the run. The server passes that run's repo/branch metadata into the executor, which keeps Coder worktree contexts aligned. Paths are confined to the project workspace and `.loom` internals stay behind the dedicated run APIs. Workspace diffs and checkpoint commits also exclude `.loom`, so run logs, audit records, sessions, and control-plane metadata do not leak into review branches.

The same handoff package includes the run-derived `messages`, `gateTrail` for review/deployment gate changes, `externalEffects` for issue/PR/merge/brain side effects, `issueCommentSeeds` for initial linked issue context syncs and issue-command outcomes such as handoff follow-up starts/denials, existing child `followupRuns[]`, and a `links.followupRuns` continuation entry. Follow-up runs seed their first `handoff_followup` message with bounded source changed-file, command, and session evidence so the next developer or model can resume without reopening the full package first, while child run summaries retain source Workbench/package links for backtracking. Direct API/browser follow-ups inherit the source run's `model` and non-default `modelProtocol` unless the follow-up request overrides them; issue-comment follow-ups inherit the same fields from the source run, preserving tool-call continuations across reviewer handoff.
`POST /tenants/:tenant/projects/:project/commands` runs a one-shot workspace command and returns `{ commandId, stdout, stdoutBytes, stdoutTruncated, stderr, stderrBytes, stderrTruncated, exitCode }` plus `actor`, `role`, and `clientId` when available. It is disabled unless the server allowlist includes `shell.exec`, so start with `--allow-shell` only for isolated sandbox workspaces. If `limits.maxWorkspaceBytes` is set and the current non-`.loom` workspace content is already at or above the cap, command start is rejected. The optional request `timeoutMs` may shorten the command timeout but cannot exceed the server `--workspace-command-timeout-ms` cap, which defaults to 120 seconds; `clientId` may be supplied for audit and command-history correlation. `GET /tenants/:tenant/projects/:project/commands` and `GET /tenants/:tenant/runs/:runId/commands?project=<project>` list persisted command summaries newest first with the same request identity fields.
`POST /tenants/:tenant/projects/:project/sessions` starts a persistent workspace session with `{ "command": "sh", "clientId": "..." }`; `POST /tenants/:tenant/runs/:runId/sessions?project=<project>` does the same inside a run/worktree context. If `limits.maxWorkspaceBytes` is set and the current non-`.loom` workspace content is already at or above the cap, session start is rejected. Use `GET .../sessions` to list active and historical sessions, including the starter `actor`, `role`, `clientId`, `lastActivityAt`, and `idleExpiresAt` when available; `GET .../sessions/:sessionId/events` for persisted transcript polling, `GET .../events/stream` for SSE, `POST .../input` to write stdin, and `POST .../stop` to terminate the session. Start, input, and stop transcript events carry actor/role/client metadata when available; exit events record `exitCode` and optional `signal`, and also emit `workspace_session_exited` tenant audit for dashboard/workbench refresh. Browser Dashboard/Workbench session streams keep the EventSource open for native `Last-Event-ID` reconnects until session exit or an explicit session switch/reset. Accepted stdin writes add byte counts but not raw input text. JSON request bodies are capped at 1 MB, session input chunks are capped at 64 KiB, active workspace sessions default to 32 across server instances that share a workspace root, enforced with lease-backed claims under `.loom/admission/workspace-sessions`; the per-tenant active session cap defaults to the global cap and can be lowered with `--max-tenant-workspace-sessions`, and that per-tenant cap is also enforced across server instances with lease-backed claims under `<tenant>/.loom/admission/workspace-sessions`. Those same claims keep remote running sessions visible as active in project/session lists. Active-run claims likewise keep server and tenant status active-run counts plus queued-run blockers aligned across shared server instances, while running summaries without a current claim are treated as orphaned. Idle sessions stop after 30 minutes by default, process-backed sessions escalate from SIGTERM to SIGKILL after a 5 second stop grace, and persisted command streams/session output events are capped at 64 KiB each with original byte counts and truncation markers retained in the API response.

When `loom harness serve` is started with model options, HTTP callers can send `"model": "kimi-k2.6"` instead of `script` or `agentCommand`; set `"modelProtocol": "tool-call"` or start the server with `--model-protocol tool-call` for providers that prefer Chat Completions tool calls. The dashboard exposes the same model protocol selector.

HTTP mode denies `shell.exec` by default. The default allowed action tools are `file.read`, `file.write`, `git.diff`, `git.commit`, and `verify.run`; add `--allow-shell` or repeat `--allow-tool <name>` only for isolated workspaces. Workspace PR handoff is an external effect and additionally requires `--control-plane-pr` plus `--allow-tool git.pr`. A request may include `"allowedTools"` to further restrict one run, but it must be a subset of the server allowlist or the request fails with `400`. The effective tool policy is written to the event log as `run_policy`.

If any `--tenant-token tenant=token`, `--tenant-key-env tenant=ENV:actor:role`, `--tenant-key tenant=token:actor:role`, or tenant policy `apiKeys` values are configured, API routes for that tenant require `authorization: Bearer <token>` or `x-loom-tenant-token: <token>`. Event streams also accept `?token=<token>` because browser `EventSource` cannot send custom headers. `viewer` keys can read tenant resources, add run comments, request active-run pause, and request policy escalations; `developer` and `admin` keys can create runs, resume paused runs, edit/move/delete files, create git checkpoints, hand off workspace PRs when `git.pr` is allowed, run commands, control sessions, cancel/abandon runs, claim/release pending run reviews, and submit review decisions; only `admin` can update tenant policy, decide escalation requests, or approve/reject deployment gates. Signed Gitea `/loom resume`, `/loom approve`, `/loom request-changes`, `/loom claim-review`, `/loom release-review-claim`, `/loom approve-deploy`, `/loom reject-deploy`, `/loom approve-vas`, `/loom request-vas-changes`, `/loom claim-vas`, `/loom release-vas-claim`, `/loom run-vas-review`, and `/loom run-handoff-followup` comments inherit role from matching tenant key actors such as `gitea:alice` or `alice`; unmapped commenters remain `viewer`. Tenant audit events record the matched `actor` and `role`, never the token.

## The seams

- `src/harness/*` - first-party OpenHands-lite loop, HTTP control plane, browser dashboard/workbench, run replay, tenant policy, and executor-backed sandbox operations. The active seams are deeper model/tool protocol semantics and production hardening around remote sandbox backends.
- `src/harness/gitea.ts` - optional Gitea/Forgejo issue comment and pull request bridge for linked run summaries.
- `src/harness/executor.ts` - local workspace executor.
- `src/harness/docker-executor.ts` - Docker-backed command/verification executor with default non-root user, no-network, no-new-privileges, cap-drop, read-only rootfs, tmpfs, and resource limits.
- `src/harness/coder-executor.ts` - Coder SSH-backed executor that starts the workspace, prepares a remote project repo, and can create an isolated git worktree per run.
- `src/native.ts` — exact headless-`/goal` invocation depends on your installed CLI version (marked `SEAM`).
- `src/brain.ts` — CLI `harness run --ingest-brain`, HTTP `harness serve --ingest-brain`, and native Stop hooks can append structured run signals with concise failure notes; `propose()` opens reviewable improvement branches with linked failure samples, and `loom brain propose` / `loomd serve` can push/open Gitea PRs with `--gitea-pr`.
- `hooks/loom-stop-hook.sh` — replace the test heuristic with your real gate (reviewer verdict / CI).

## Guardrails

1. Verification is yours — `/goal` saying "done" is a claim, not a proof.
2. Read what the loop wrote — comprehension debt compounds silently.
3. Design the loop to do work you understand, not to avoid understanding it.

## Multi-tenant on a VPS (loomd)

`loomd` adds the multi-tenant layer on top. It does auth + provisioning + lifecycle + brain hosting; it does **not** coordinate the matrix (still emergent via the shared Gitea board). Each tenant can run the first-party harness or the native `/goal` adapter inside its own container.
Tenant names must match `[A-Za-z0-9][A-Za-z0-9_.-]{0,62}` because the same name is used for registry records, Docker container/volume names, and host-side activity markers.

```bash
loomd user add alice --auth subscription          # alice brings her OWN seat
loomd user add bob   --auth gateway --key-env LOOM_KEY_BOB
loomd serve --interval 30 &                        # background: local brain branches + idle GC
# or, on a shared Gitea-backed skills repo:
loomd serve --interval 30 --git-sync --gitea-pr --gitea-repo team/_skills --gitea-token-env LOOM_GITEA_TOKEN &
# SSH gateway: authorized_keys pins one key per tenant →
#   command="/usr/local/bin/loom-ssh-forcecommand alice",... ssh-ed25519 AAAA... alice
# `ssh loom@vps` with alice's key → loomd enter alice → exec into her container
```

`--git-sync` makes each brain tick run `git fetch <remote> --prune` and `git pull --ff-only <remote> <base>` against `skillsRepo` before scoring, so a central `loomd` sees signals pushed by tenant workspaces. It uses `--git-remote` and `--gitea-base` as the remote and branch, and it clears only the locally generated `.brain/skill_evals.json` when that file is safely reproducible from local signals before pulling.

`loomd enter` records an active session marker in `LOOM_STATE_DIR` while the tenant's SSH shell is attached, then updates `lastActiveAt` when the shell exits. `loomd serve` stops tenant containers only when there are no active markers and the tenant has been idle longer than `idleStopMinutes`; the volume persists. Use `--no-idle-gc` to disable that cleanup.

`loomd ps` prints Docker status plus `ACTIVE_SESSIONS`, `LAST_ACTIVE`, and `IDLE_FOR`, so the VPS operator can see whether a container is busy, merely stopped, or ready for cleanup.

### Isolation tiers (config: `runtime`)
- `runc` — Docker + named volume + dropped capabilities, no-new-privileges, read-only rootfs, bounded `/tmp`, CPU/memory/pids caps, and named-network policy.
- `runsc` — **gVisor (default)**. Syscall sandbox; the right fit because agents run arbitrary code with bypassed permissions.
- `kata-fc` — Firecracker microVM. VM-grade isolation when you need it.

Each tenant: own container, own persistent volume (`loom-home-<user>` → `/home/dev`), own `~/.claude`. The persistent volume is why native `--resume` works per tenant across sessions. Unsafe Docker networks (`host`, `bridge`, and `container:*`) are rejected; use a named network that reaches only the gateway/Gitea services the workspace needs.

### Auth modes (per tenant)
- `gateway` — loomd injects `ANTHROPIC_BASE_URL` (LiteLLM) + the tenant's virtual key. API billing, central, per-tenant budget.
- `subscription` — loomd injects **nothing**. The tenant runs `claude login` once inside their **own** container; the login lives only in their volume. **One seat per person.** loomd never stores, copies, or shares a subscription credential across tenants — there is no shared-subscription code path, and per-tenant isolation means logins can't leak between tenants.
