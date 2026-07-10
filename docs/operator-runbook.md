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

It starts a temporary local platform server, fake model gateway, Coder-shaped local executor, tenant keys, control-plane reporter hooks, runs the read-only cutover report, and then runs the full `platform-readiness` smoke. The peer variant starts a second harness server against the same workspace root and requires cross-server active-run lease, pause, cancel, and idempotent-create evidence. The AGS variant also starts the shared contract-backed local `/api/v3`, provisions a stored project-agent token through the harness admin endpoint, generates a `platform-cutover-plan`, exports and verifies `.loom/operator-cutover-bundle`, runs safe stages from the exported bundle plan including AGS compat and staging readiness, writes bundle verify, safe-run, approved-run, platform-preflight, AGS staging, staging-targets, serve-ready, cutover-report, and smoke reports under `.loom/operator-cutover-bundle/reports/`, explicitly approves both AGS mutating gates, writes `reports/operator-approvals.json`, executes the current cockpit command through `platform-operator-cockpit-runner --execute` to write `reports/operator-cockpit-runner-execute.json`, runs strict final `platform-cutover-artifacts-verify` with the runner execute requirement to write `reports/operator-artifacts.json`, writes `reports/staging-proof.json`, emits `operatorArtifactSummary` with report hashes, explicit doctor/model/control-plane/Coder preflight gates, and `preServeEvidenceOk`/`serveReadyOk`/`operatorApprovalsOk`/`operatorCockpitRunnerExecuteOk`/`operatorArtifactsVerifyOk`/`agentGitServiceStagingReady`/post-serve gate coverage, and requires AGS cutover plus native handoff/wiki-memory projection evidence without printing token material. Treat these as repeatable local proof before moving to real Coder/Gitea/LiteLLM/AGS infrastructure.

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
  --tenant-key-env alice=LOOM_DEV_TOKEN:eno:developer \
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

## 3. Run Platform Preflight

After doctor passes, generate the token-free operator plan with the same flags as the aggregate preflight below:

```bash
loom harness platform-cutover-plan \
  --workspace-root "$LOOM_WORKSPACE_ROOT" \
  --profile platform-readiness \
  --tenant alice \
  --project smoke-platform \
  --template vas-lite \
  --isolation-tenant bob \
  --token-env LOOM_DEV_TOKEN \
  --viewer-token-env LOOM_VIEWER_TOKEN \
  --admin-token-env LOOM_ADMIN_TOKEN \
  --repo "https://git.example/team/app.git" \
  --branch "loom/{tenant}/{project}/{runId}" \
  --model-base-url "https://litellm.example" \
  --model-key-env LOOM_MODEL_KEY \
  --executor-workspace "loom-{tenant}" \
  --executor-remote-cwd "/home/dev/projects/{project}" \
  --executor-worktree-cwd "/home/dev/projects/{project}/.worktrees/{runId}" \
  --executor-ide-url "https://coder.example/@{tenant}/{project}/{runId}" \
  --executor-preview-url "https://preview.example/{tenant}/{project}/{runId}" \
  --executor-template loom \
  --executor-cpus 1 \
  --executor-memory 2g \
  --executor-pids-limit 256 \
  --control-plane-provider gitea-forgejo \
  --control-plane-pr \
  --control-plane-merge \
  --control-plane-comment-sync \
  --control-plane-webhook-secret-env LOOM_GITEA_WEBHOOK_SECRET \
  --control-plane-url "https://git.example" \
  --control-plane-token-env LOOM_GITEA_TOKEN \
  --tenant-control-plane-token-env alice=LOOM_GITEA_TOKEN \
  --tenant-key-env alice=LOOM_ADMIN_TOKEN:ops:admin \
  --tenant-key-env alice=LOOM_DEV_TOKEN:eno:developer \
  --tenant-key-env alice=LOOM_VIEWER_TOKEN:auditor:viewer \
  --tenant-key-env bob=LOOM_BOB_DEV_TOKEN:bob:developer \
  --ingest-brain \
  --allow-tool git.pr \
  --out plan.json \
  --bundle-out cutover-bundle
```

Use `commandOrder`, `stages[]`, `externalEnvironment`, and the emitted argv arrays as the CI handoff. The stdout result includes `planPath` and `operatorBundle` when `--out`/`--bundle-out` are provided, while the saved `plan.json` remains the token-free plan payload. If `sensitiveInputsOmitted` is non-empty, replace raw token flags with env-name flags before sharing or executing the plan. `externalEnvironment.systems` records the LiteLLM/model gateway, Coder executor shape, control-plane provider URL/token env, AGS token secret root, and tenant refs. `externalEnvironment.requiredVariables` is the token-free env checklist: names, source flags, purposes, tenant/role context, and the stages that need each variable. Automation may run stages with `executionMode: "read-only"`, `"dry-run"`, or `"verification"` only after their `requires` entries are satisfied. Approval-required mutating stages require the named `operatorGate` evidence before continuing. Long-running stages such as `serve` are reported as `longRunningManual` by `platform-cutover-run` and must be started by the operator outside the runner.

For real AGS staging, replace the default smoke target by adding `--control-plane-provider agent-git-service`, `--agent-git-service-staging-issue <owner/repo#number>`, `--agent-git-service-staging-repo <owner/repo>`, `--agent-git-service-staging-wiki-page <page>`, and, for the approved native write stage, `--agent-git-service-native-write-workspace-id <id>`, `--agent-git-service-native-write-attachment-url <public-evidence-url>`, and `--agent-git-service-native-write-wiki-note <text>`. The generated `agent-git-service-staging-readiness` and `agent-git-service-native-write-check` argv arrays carry those values into the bundle without embedding token material. If an imported hand-written plan has AGS readiness or native-write argv but omitted `externalEnvironment.systems.agentGitServiceStaging`, `platform-cutover-bundle` derives the token-free target from those argv values before writing the exported `plan.json` and `staging-ci.json`; pre-serve checks require native write target fields only when the native write stage is present.

The upstream `ngaut/agent-git-service` staging checklist lives in `docs/upstream-agent-git-service-integration.md`; use it when moving from local AGS contract rehearsal to a real `gh-server` candidate.

If you generated only the JSON plan, export the same operator bundle separately:

```bash
loom harness platform-cutover-bundle --plan plan.json --out cutover-bundle
```

The bundle contains `plan.json`, `manifest.json`, `env.md`, `env.sh`, `external-secrets.json`, `github-actions-staging.yml`, `commands.sh`, and `staging-ci.json`. The manifest records sha256 hashes for `plan.json`, `env.md`, `env.sh`, `external-secrets.json`, `github-actions-staging.yml`, `commands.sh`, and `staging-ci.json`. `env.sh` is token-free and sourceable; it exports the declared env names without values so CI can fill them from its secret store. `external-secrets.json` is also token-free; it records the required env inventory, `ci-secret-store` provider hint, and `source ./env.sh` injection command for CI handoff. `github-actions-staging.yml` is a token-free workflow template that can be copied to `.github/workflows/`; it maps required env names to GitHub Actions `secrets.<NAME>`, exposes `loom_bin`, `bundle_dir`, and `node_version` inputs that default to `loom`, `cutover-bundle`, and `22`, can set `bootstrap_source_tree` to use `actions/setup-node`, run `npm ci`, build the checkout, write `loom-wrapper`, and use that wrapper as `LOOM_BIN`, sets a `loom-strict-staging-${{ github.ref }}-${{ inputs.phase }}` concurrency group with `cancel-in-progress: false`, runs strict pre/post/all bundle commands from `bundle_dir`, records token-free `reports/ci-run-proof.json` from the GitHub Actions environment, and uploads `${{ inputs.bundle_dir }}/reports` as evidence. When `LOOM_BIN` is unset and an executable `loom-wrapper` exists beside `commands.sh`, the bundle script and prerequisites checker use that wrapper automatically; an explicitly bad `LOOM_BIN` still fails fast. `staging-ci.json` is a token-free `platform-staging-ci/v1` handoff manifest with strict pre/post serve commands, required env names, external target inventory, expected reports, jq checks, and `operatorApprovals[]` entries for approval-required mutating stages. Its pre-serve jq checks validate `bundle-verify.json`, `staging-prerequisites.json`, `staging-run.json`, `external-staging-audit.json`, `platform-preflight/v1` with all four probe gates and empty `missing`, AGS staging readiness with upstream `/readyz` `serverReadiness`, discovery/issue/wiki gates, external `staging-targets.json` with AGS target inventory, readiness-to-target equality, `platform-staging-evidence/v1` with `gates.preServeEvidenceOk`, and the serve-start verdict. Strict staging-run jq checks also require `platform-staging-run/v1` to be token-free, strict external, empty of missing/forbidden lists, green across bundle/env/stage/evidence/verdict gates, and hash-anchored to bundle verification, every pre-serve env/run report, staging targets, staging evidence, and staging verdict. AGS strict pre-serve jq checks also require the staging-evidence rollup to be token-free, have empty missing/forbidden lists, pass external/preflight/AGS/compat gates, and carry sha256-anchored refs for staging targets, platform preflight, AGS staging readiness, and every AGS compat artifact. Its post-serve jq checks validate `agent-git-service-native-write-check/v1` when present, compare that proof to `reports/staging-targets.json`, validate `platform-serve-ready/v1`, validate `platform-ci-run-proof/v1` from GitHub Actions, cutover report AGS readiness, smoke status, multi-agent concurrency, AGS cutover, AGS workspace-token, AGS native-projection evidence, server/tenant AGS discovery `tokenMode` plus empty missing-tenant lists, validate `operator-cockpit-runner-execute.json`, and require `operator-artifacts.json` to anchor every `staging-ci.expectedReports` entry except the final artifact/proof self-reference and final cockpit plan/next artifacts. The generated `staging-ci.json.commands.*` include `LOOM_RUN_STAGING_CI_CHECKS=1` for real external staging; local AGS contract rehearsal can still invoke `commands.sh` directly without that flag because upstream candidate mode is intentionally absent. AGS plans list `agent-git-service-compat/{manifest,baseline,candidate,compare}.json` as pre-serve artifacts and include jq checks for upstream candidate mode, non-loopback candidate URL, baseline/candidate probe contract shape, candidate probe target equality, comparison success, and comparison candidate target equality.

The script runs `platform-cutover-bundle-verify --dir . --report reports/bundle-verify.json --forbid-env <declared-env>` before any stage. In strict external AGS mode it writes `reports/upstream-agent-git-service-handoff.json` with `upstream-agent-git-service-handoff/v1`; that report verifies the upstream guide, `DB_DSN` server env, Loom env names, checklist structure, and secret scan without printing values. It then writes `reports/staging-prerequisites.json` with `platform-staging-prerequisites`; that gate verifies the operator shell, strict bundle commands, external targets, and upstream AGS handoff/server env names before any pre-serve stage runs. It then runs `platform-staging-run --dir . --plan plan.json --report reports/staging-run.json --forbid-env <declared-env>` for pre-serve staging. That command writes the per-stage env/run reports, `reports/staging-targets.json`, `reports/staging-evidence.json`, and `reports/staging-verdict.json` so CI can archive and approve real external staging evidence without needing cutover/smoke reports yet. Strict external mode then writes `reports/external-staging-audit.json`, a token-free operator-readable audit over bundle, env, target, prerequisites, staging evidence, staging-run, and verdict gates. `staging-run.json` uses schema `platform-staging-run/v1` and records bundle verification, env checks, pre-serve stage runs, external target classification, evidence, and verdict in one token-free artifact, and final artifact verification anchors it whenever the bundle has automatic pre-serve stages. `staging-targets.json` also carries the token-free AGS staging issue/repo/wiki/write target from the plan when AGS is selected. Set `LOOM_REQUIRE_EXTERNAL_STAGING=1` in real staging CI so the script requires external staging during upstream AGS handoff, `platform-staging-prerequisites`, `platform-staging-run`, external staging audit, final artifact verification, and staging proof; strict external mode also cross-checks `platform-preflight.json` subreports so model base URL, Coder executor kind, and control-plane provider/base URL agree with external LiteLLM/Coder/AGS staging. For AGS bundles, strict external mode also rejects compat manifests unless `candidateMode` is `upstream` and `candidateBaseUrl` classifies as external; this check is applied while writing `staging-evidence.json`, so `staging-verdict.json` blocks before manual `serve` starts. Set `LOOM_REQUIRE_OPERATOR_APPROVALS=1` when approval-required mutating stage run reports and their token-free proof artifacts must also be present and gate-matched. In post-serve mode, it first writes `reports/serve-ready.json` with token-free `/healthz`, `/readyz`, and `/status` reachability/profile evidence, runs cutover/smoke, refreshes cockpit artifacts, executes the current post-serve proof command through `platform-operator-cockpit-runner --execute` to write `reports/operator-cockpit-runner-execute.json`, then reruns `platform-cutover-artifacts-verify --dir . --plan plan.json --report reports/operator-artifacts.json --staging-evidence-report reports/staging-evidence.json --require-operator-cockpit-runner-execute --forbid-env <declared-env>` and `platform-staging-proof --dir . --plan plan.json --report reports/staging-proof.json --forbid-env <declared-env>`. The final verifier report includes the token-free report inventory, per-report hash list, hash mismatch list, stage-anchor mismatch list, pre-serve/post-serve evidence gap lists, report secret scan, gate summary, and standalone `stagingEvidence` manifest; the proof then collates staging targets, platform preflight, staging evidence, verdict, staging-run, external staging audit, serve-ready, operator approvals, operator artifacts, and the runner execute lease evidence into one token-free `platform-staging-proof/v1` artifact. Strict proof checks both `operator-artifacts.gates.operatorApprovalsOk` and the current `operator-approvals.json` status, reads `staging-ci.json.operatorApprovals[]` as the independent expected-approval list, treats `staging-ci.json.expectedReports` as proof inputs recorded under `reports.stagingCiExpectedReports`, requires external preflight subreports to match real LiteLLM/Coder/AGS targets, and requires `operator-artifacts.json` to anchor the upstream AGS handoff report, prerequisites report, external staging audit, runner execute report, core proof inputs, plus every expected approval run report after being generated with `requireOperatorApprovals: true`; for AGS native write it also requires the actual `reports/agent-git-service-native-write-check.json` proof to be `ok`, token-free, approved, and gate-complete. The generated platform-preflight, AGS staging readiness, staging-targets, serve-ready, cutover, and smoke argv write `reports/platform-preflight.json`, `reports/agent-git-service-staging-readiness.json`, `reports/staging-targets.json`, `reports/serve-ready.json`, `reports/cutover-report.json`, and `reports/smoke.json`; the final verifier requires `platform-preflight/v1` with `tokenFree: true`, preflight `ok`, all four preflight gates, empty `missing`, and `nextCommandsReady` before `gates.preServeEvidenceOk` is true, and exposes them as `gates.doctorPreflightOk`, `gates.modelPreflightOk`, `gates.controlPlanePreflightOk`, and `gates.coderPreflightOk`. It also exposes `gates.externalStagingReady` from `staging-targets.json`; with `--require-external-staging`, that gate must be true or the verifier records `stagingTargets.externalStagingReady` in `preServeEvidenceMissing`; with `--require-operator-approvals`, each approval-required mutating stage report must be `ok` and include the matching approval gate id, and AGS native write proof must exist as its own JSON artifact. With `--require-operator-cockpit-runner-execute`, the verifier also requires `operator-cockpit-runner-execute.json` to be token-free, executed, empty of `missing`, exit zero, lease-acquired, and have matching runner/lease `currentStepId` and `currentBlockingGroupId`. It also emits `stagingEvidence` (`platform-staging-evidence/v1`) with the `reports.stagingTargets` sha256/ok ref, `gates.externalStagingReady`, model gateway, control-plane, Coder, AGS staging, AGS compatibility, report sha256, and pre-serve gate coverage for one-file external staging archival. It then requires serve-ready `ok`, cutover `ok`, smoke `status: "passed"`, multi-agent concurrency evidence, and cutover/smoke server/tenant AGS discovery evidence before `gates.postServeEvidenceOk` is true. For AGS bundles, the compat stage writes `reports/agent-git-service-compat/{manifest,baseline,candidate,compare}.json`; its stage-run report records an `artifactSummary`, the manifest pins baseline/candidate/compare sha256 values, and the final verifier also requires `gates.agentGitServiceStagingReady`, `gates.serveReadyOk`, AGS preflight compatibility, project-agent cutover, and native projection smoke evidence before the relevant pre/post serve gates are true.
Final artifact verification also requires every required report to be `ok`, compares `platform-staging-run/v1` refs against the current report sha256 values, and rejects a staging-run rollup whose gate/ref summary is inconsistent, so a hand-written or tampered `readyForServe: true` cannot bypass the pre-serve evidence chain.
It also rejects a hand-written `platform-preflight.json` that has green top-level gates but lacks successful LiteLLM model usage evidence with numeric token or cost data, or lacks Coder `prepare`, `remoteCommand`, and browser URL evidence.
`platform-cutover-bundle-verify` reports `manifestFileMismatches` when `manifest.files` no longer lists the full operator payload in order.
It reports `manifestHashMissingFiles` when a listed non-manifest payload lacks a `manifest.fileSha256` entry.
AGS bundles also include `upstream-agent-git-service.json` (`upstream-agent-git-service-staging-guide/v1`), a token-free guide for the upstream `gh-server` candidate: repo URL, binary name, `/api/v3`, `DB_DSN`, Loom env names, staged AGS targets, and a structured `operatorChecklist` for upstream server, Loom env, pre-serve, serve, and post-serve evidence. It is part of the manifest/hash/secret-scan payload.
It reports `upstreamAgentGitServiceHandoffMismatches` when that guide is malformed or drifts from the current plan's AGS control-plane URL, token env names, staged target, required `DB_DSN` metadata, or checklist evidence.
Approval reports must satisfy both the operator gate and every `stage.requires` entry; `platform-operator-approvals` exposes this as `gates.allRequirementsSatisfied`, `missingRequirementReports`, and per-approval `missingRequirements`.
Strict staging proof also compares `operator-approvals.json` back to `staging-ci.json.operatorApprovals[]`, including stage id, gate id, evidence, command, selected stage, executed stage with `ok: true`, and required `requires`, before accepting an approval summary.
It also compares every `operator-artifacts.json` anchored report sha256 against the current report file, including approval run reports named by `staging-ci.json.operatorApprovals[]` even if `staging-ci.json.expectedReports` was hand-edited; the final goal audit separately requires operator artifacts to anchor the current cutover, smoke, concurrency, and runner execute reports, so rerun final artifact verification after changing those reports, preflight, AGS compatibility, native-write, or approval reports.
It also rejects any present required report whose `ok` flag is not true, and rechecks `platform-staging-run/v1` refs against current report sha256 values before accepting `staging-proof.json`.
The generated post-serve jq checks also require final artifacts to be strict artifacts: `operator-artifacts.json` must record `requireExternalStaging: true` and `requireOperatorCockpitRunnerExecute: true`, and `staging-proof.json` must record both `requireExternalStaging: true` and `requireOperatorApprovals: true`, be token-free, have empty `missing`/`missingReports`/`forbiddenValueHitReports`, pass operator artifact/post-serve/approval gates, and include hash-anchored `reports.stagingCiExpectedReports`.
`platform-cutover-bundle-verify` also reports `stagingCiStrictCommandMissing` and fails if `staging-ci.json.commands.{preServe,postServe,all}` drop the strict external/approval/JQ-check envs or `./commands.sh`, even when `manifest.json` hashes were updated to match the edited handoff.
It also reports `commandsShStrictCheckMissing` if `commands.sh` drops the strict env defaults, jq-check runner, pre/post CI check calls, or strict artifact/proof arguments.
It reports `manifestStageIdMismatches` when `manifest.stageIds` no longer matches the current `plan.json` stage order.
It reports `stagingCiExpectedReportMissing` when `staging-ci.json.expectedReports` omits reports implied by the current plan's pre/post stages.
It reports `stagingCiOperatorApprovalMismatches` when `operatorApprovals[]` no longer matches approval-required mutating stages, including gate id, command, report path, and `requires`.
It reports `stagingCiCheckMissing` when `staging-ci.json.checks` omits generated pre/post serve jq gates for the current plan.
It reports `agentGitServiceCompatTargetMismatches` when an AGS compat stage `--candidate-url` no longer matches the staged control-plane base URL.
Strict external AGS compat also rejects `agent-git-service-compat/manifest.json` when `candidateBaseUrl` does not match the staged AGS control-plane target after `/api/v3` normalization, and artifact import applies the same read-only `/api/v3` probe contract plus target binding to `agent-git-service-compat/candidate.json.baseUrl` and `agent-git-service-compat/compare.json.candidate.baseUrl`.
Pre-serve staging evidence also rejects `agent-git-service-staging-readiness.json` when its upstream `serverReadiness` is not ready or its `baseUrl` no longer matches the staged control-plane base URL.
Final artifact verification rejects `agent-git-service-native-write-check.json` when its approved write `baseUrl` no longer matches the staged control-plane base URL.
When `agentGitServiceStaging.nativeWriteAttachmentUrl` is declared, final artifact verification also rejects native-write proofs whose top-level `attachmentUrl` records a different evidence URL. When `nativeWriteWikiNote` is declared, `staging-targets.json` records its sha256 and final verification requires `agent-git-service-native-write-check.json.wikiMemory.noteSha256` to match.
Strict approval verification also rejects approval run reports that do not list the approved stage in `selectedStageIds` and include the same stage in `executed` with `ok: true`; `platform-operator-approvals/v1` reports those as `stageMismatchReports` and requires `gates.allStagesExecuted`.

Before running the strict pre-serve command in a real external environment, replace placeholder staging targets, generate the token-free upstream AGS server env plan, then check whether this operator shell can attempt the run:

```bash
loom harness platform-staging-targets-plan --dir cutover-bundle --report cutover-bundle/reports/staging-targets-plan.json
loom harness upstream-agent-git-service-server-env-plan --dir cutover-bundle --report cutover-bundle/reports/upstream-agent-git-service-server-env-plan.json
loom harness platform-staging-prerequisites --dir cutover-bundle --require-agent-git-service --report cutover-bundle/reports/staging-prerequisites.json
```

The staging targets plan uses schema `platform-staging-targets-plan/v1`, reads only `plan.json`, emits required `LOOM_REAL_*` env names, `envValidationCommandArgs`, `applyCommandArgs`, `inputTemplatePath`, `inputTemplate`, `applyInputCommandArgs`, a token-free `platform-staging-targets-env-check` report command, a token-free `planPatchShellCommand` for writing `plan.real-targets.json`, `realTargetsCheckCommandArgs`, `validatedRealTargetsShellCommand` for validation plus patching plus strict real-plan target proof in one shell command, `bundleRefreshCommandArgs`, and `prerequisitesCommandArgs`, and never reads or persists real endpoint values. When `LOOM_BIN` is unset and `cutover-bundle/loom-wrapper` is executable, those command arrays and shell commands use the wrapper path instead of requiring a global `loom`. After exporting real non-placeholder LiteLLM, AGS, issue, repo, and evidence targets, run `applyCommandArgs`; or write the same values to `inputTemplatePath` using `inputTemplate` and run the lower-level `applyInputCommandArgs`. Operator status and cockpit artifacts surface that file handoff as `external-targets.targetInputRefs[]`; if the file exists and validates, cockpit treats the current `real-staging-targets` step as ready to run `operator-real-staging-targets-apply`, whose argv calls `platform-operator-real-staging-targets-apply --auto-refresh-bundle` with the current input sha256 and any known proof/GitHub target flags, without reading or storing the real target values. `platform-staging-targets-apply` validates presence, shape, and placeholder rejection without printing values, writes `plan.real-targets.json`, writes `reports/real-staging-targets.json` with strict external target proof, and emits a token-free apply report containing only env names, input path/sha and `inputProof` when used, byte length, field names, output paths, sha256 values, gates, and next actions; failed input-file applies also include top-level `input.*` missing keys from `inputProof.missing[]` so operators repair the file fields instead of chasing env-only hints. The operator wrapper then consumes that report, refreshes `plan.json`, manifest, sanitized target reports, and cockpit artifacts before rerunning prerequisites/audit. The server env plan uses schema `upstream-agent-git-service-server-env-plan/v1`, reads only `upstream-agent-git-service.json`, emits `serverStartShellCommand` and `/readyz` probe args for `gh-server`, and never reads or persists `DB_DSN`. The prerequisites report uses schema `platform-staging-prerequisites/v1`, stays token-free, and checks bundle integrity, strict `commands.sh`/`staging-ci.json` contracts, required env-name presence, `jq`, external targets, and upstream AGS handoff/server env names; it accepts an explicit executable `LOOM_BIN`, a globally available `loom`, or the bundle-local executable `loom-wrapper` fallback, and its target-replacement/server-env nextActions use the same command source. In strict external mode, `platform-staging-targets` also rejects placeholder `.example`, `example.com`, `example.net`, `example.org`, `team/app`, `team/loom`, `team/loom-smoke`, `owner/repo`, and `org/repo` targets even when the URL shape is non-loopback. Strict external `commands.sh` writes both `reports/upstream-agent-git-service-server-env-plan.json` and `reports/staging-prerequisites.json` automatically before pre-serve stages, and strict artifact/proof checks hash-anchor them.

Browser cockpit admins can also submit the same `platform-staging-targets-input/v1` object through `POST /tenants/<tenant>/operator/real-staging-target-input`; the server writes only the plan-derived bundle-local `inputTemplatePath`, rejects obvious placeholders, refreshes `reports/operator-handoff-packet.json` with any supplied proof flags and GitHub target, and returns/audits only path, sha256, byte length, field names, handoff packet path, and token-free handoff metadata. The cockpit **Apply input file** action first saves the current form values, then posts the returned `inputSha256` plus `autoRefreshBundle: true` to `POST /tenants/<tenant>/operator/real-staging-targets-apply`, so a successful apply also consumes the apply report, refreshes `plan.json`/manifest/sanitized target reports, and advances to the next blocking group; headless operators can run `loom harness platform-operator-real-staging-targets-apply --dir cutover-bundle --auto-refresh-bundle --repo-root <repo-root> --repo <owner/repo> --ref <branch>` for the same apply/refresh/cockpit update path. The separate **Save input file** action remains a draft save, and **Refresh bundle** remains a retry path.

Then ask the bundle what proof is still missing:

```bash
loom harness platform-external-staging-audit --dir cutover-bundle --report cutover-bundle/reports/external-staging-audit.json
```

The audit uses schema `platform-external-staging-audit/v1`, stays token-free, and aggregates bundle verification, pre-serve env-name presence, external target classification, placeholder-target rejection, `staging-prerequisites.json`, strict staging evidence, `staging-run.json`, and `staging-verdict.json`. It exits non-zero until the real LiteLLM/Coder/AGS env names and reports are present, and its `nextActions` points placeholder gaps back to `platform-staging-targets-plan` with the bundle wrapper fallback plus the bundle's strict pre-serve command.

Before dispatching the real GitHub Actions handoff, check this operator shell and repository:

```bash
loom harness platform-ci-handoff-preflight --dir cutover-bundle --repo-root <repo-root> --repo <owner/repo> --ref <branch> --report cutover-bundle/reports/ci-handoff-preflight.json
```

The preflight report uses schema `platform-ci-handoff-preflight/v1`, stays token-free, and checks the local bundle directory, `github-actions-staging.yml`, `external-secrets.json`, `staging-ci.json`, optional `--repo-root` workflow install sha256, `gh auth status`, `gh repo view`, `gh workflow view`, and `gh secret list --app actions` without storing `gh` output. Instead of repeating `--repo`/`--ref`, an operator can write `cutover-bundle/github-actions-target.input.json` with schema `platform-ci-target-input/v1` (`repo`, `ref`) and pass `--target cutover-bundle/github-actions-target.input.json`; preflight records only the target input path and sha256, and explicit CLI `--repo`/`--ref` still override the file. When `--repo-root` is supplied, the `gh` probes run from that repository root so a handoff started from a bundle subdirectory still sees the target checkout remote. If the configured GitHub CLI is missing, preflight emits `missing: ["github.cli"]` and waits to report auth/repo/workflow/secret gaps until the CLI exists. It records required/present/missing required env names plus token-free `gh secret set` command args for missing required names, never secret values or unrelated repository secret names. It also emits `missing` and `nextActions`; if `local.workflowInstall` is missing, run the emitted `platform-ci-handoff-install --repo-root <repo-root>` command. If `github.workflow` is missing, run the emitted `platform-ci-workflow-publish-plan` command, then run its git add/commit/push and `gh workflow view` commands so GitHub can see the workflow before dispatch. If `github.secrets.requiredEnv` is missing, run the emitted `platform-ci-secrets-plan` command, export the required env names locally, run the emitted `secretSetShellCommands`, and rerun preflight. When `LOOM_BIN` is unset and an executable `loom-wrapper` exists in the bundle directory, these preflight install/publish/secrets command args and nextActions use the wrapper; GitHub probes and secret commands still start with `gh`. The publish plan report uses schema `platform-ci-workflow-publish-plan/v1`, records the installed workflow sha256 match, git status/add/commit/push args, `repoDiscoveryCommandArgs`/`repoDiscoveryCwd` for deriving `nameWithOwner` and `defaultBranchRef.name` when repo/ref were omitted, workflow verify args, and preflight args without running git or storing command output. The secrets plan report uses schema `platform-ci-secrets-plan/v1`, reads only `external-secrets.json`, emits `printf ... | gh secret set ...` commands that keep secret values off `gh` argv, and remains token-free even when the shell env contains real values. Use `--repo-root` when the bundle is in a subdirectory, and use `--repo` and `--ref` or `--target` whenever the target Actions repo/ref is not the shell's current GitHub checkout. It moves common handoff failures ahead of `platform-ci-handoff-run`; it is advisory evidence, while final readiness still depends on the install report and GitHub Actions run proof.

For a single operator-readable phase rollup, run:

```bash
loom harness platform-operator-status --dir cutover-bundle --require-external-staging --require-operator-approvals --require-agent-git-service --report cutover-bundle/reports/operator-status.json
loom harness platform-operator-cockpit-plan --dir cutover-bundle --require-external-staging --require-operator-approvals --require-agent-git-service --report cutover-bundle/reports/operator-cockpit-plan.json
loom harness platform-operator-cockpit-next --dir cutover-bundle --require-external-staging --require-operator-approvals --require-agent-git-service --report cutover-bundle/reports/operator-cockpit-next.json
loom harness platform-operator-handoff-packet --dir cutover-bundle --require-external-staging --require-operator-approvals --require-agent-git-service --report cutover-bundle/reports/operator-handoff-packet.json
loom harness platform-operator-approvals --dir cutover-bundle --report cutover-bundle/reports/operator-approvals.json
loom harness platform-operator-cockpit-runner --dir cutover-bundle --report cutover-bundle/reports/operator-cockpit-runner.json
loom harness platform-operator-cockpit-loop --dir cutover-bundle --require-external-staging --require-operator-approvals --require-agent-git-service --report cutover-bundle/reports/operator-cockpit-loop.json
```

When the checkout has no GitHub remote, or when an old preflight target should be overridden, pass the same explicit `--repo <owner/repo> --ref <branch>` to `platform-operator-status`, `platform-operator-cockpit-plan`, `platform-operator-cockpit-next`, `platform-operator-handoff-packet`, and `platform-operator-cockpit-loop`; the generated CI command refs then carry that target instead of relying on repo discovery. The handoff packet uses schema `platform-operator-handoff-packet/v1`; it exits zero when the packet is exported, while `ok` remains the production readiness signal. It carries the compact cockpit next action, all missing input refs, flattened command refs, GitHub target/secret refs, AGS summary, blocking groups, report refs, and next actions as one token-free external operator handoff artifact. Each flattened command ref includes `stepId`, `blockingGroupId`, `runnerCommandArgs`, and `runnerExecuteCommandArgs`, letting UI or multi-agent executors route a command through `platform-operator-handoff-runner` without re-parsing the full cockpit plan or reconstructing selector flags. `platform-operator-approvals` uses schema `platform-operator-approvals/v1` and summarizes approval-required reports from `staging-ci.json.operatorApprovals[]` into missing/failed/gate/stage/requirement buckets plus copyable `nextActions`. `platform-operator-cockpit-loop` refreshes `reports/operator-handoff-packet.json` automatically from the same status snapshot it writes to `reports/operator-status.json`. The HTTP harness exposes the same handoff export as `GET /tenants/<tenant>/operator/handoff-packet?requireExternalStaging=1&requireOperatorApprovals=1&requireAgentGitService=1&repo=<owner/repo>&ref=<branch>` and the approval summary as `GET /tenants/<tenant>/operator/approvals?clientId=<id>`; both require tenant `admin`, do not require `shell.exec`, write their matching report under `reports/`, and record token-free audit metadata.

An online harness server can serve the browser cockpit at `GET /operator-cockpit?tenant=<tenant>`. Start `loom harness serve` with `--operator-bundle-dir <dir>` when the operator bundle is not at the default `<workspaceRoot>/cutover-bundle`; `loom harness doctor` reports the resolved cockpit bundle directory in `checks.operatorCockpitBundle`. The page accepts an admin API token, optional GitHub `repo`/`ref` values, optional CI artifact directory/phase/run-id values, optional `maxSteps` value, scrubs any `token` query value from the browser URL, refreshes the same dry-run cockpit loop through `GET /tenants/<tenant>/operator/cockpit-loop?requireExternalStaging=1&requireOperatorApprovals=1&requireAgentGitService=1&repo=<owner/repo>&ref=<branch>`, renders the current CI target in the summary, renders the execution lane from `GET /tenants/<tenant>/operator/cockpit-execution-status`, renders missing current-step `inputRefs` with target/placeholder/env-check details plus copyable shell export/check snippets, expands every blocking group's token-free env/server-env/target/GitHub secret refs with presence status and copyable commands, and enables execution only after the current command is dry-runnable and the operator confirms it. The route requires tenant `admin` access when tenant auth is configured, uses the server-configured operator bundle directory, writes `reports/operator-cockpit-loop.json`, and does not execute `commandRef.commandArgs` through GET. Its **Save CI target** control writes the top-level `repo`/`ref` fields and current proof flags through `POST /tenants/<tenant>/operator/github-actions-target-input`, so operators can persist `github-actions-target.input.json` and refresh `reports/operator-handoff-packet.json` before the cockpit reaches the GitHub Actions step. Its **Import CI artifact** control calls `POST /tenants/<tenant>/operator/ci-artifact-import` with a bundle-local downloaded artifact directory, phase, optional run id, current proof flags, and optional `repo`/`ref`; that route requires tenant `admin`, does not require `shell.exec`, rejects artifact directories outside the operator bundle, writes `reports/ci-artifact-import.json`, imports only the `staging-ci.expectedReports` allowlist, clears stale invalid destination reports through the shared importer, refreshes `reports/operator-handoff-packet.json`, and audits only token-free path/count/gate metadata. Its **Sync AGS evidence** control calls `POST /tenants/<tenant>/operator/ags-evidence-sync` with the same proof flags, phase, optional run id, and target context, downloads the Actions reports artifact, writes `reports/ags-evidence-sync.json` plus `reports/ags-evidence-import.json`, filters the selected phase to AGS-specific expected reports, refreshes `operator-status.json`, cockpit plan/next, and handoff packet, and has the headless equivalent `loom harness platform-operator-ags-evidence-sync --dir cutover-bundle --run-id <github-run-id> --phase pre-serve --repo-root <repo-root> --repo <owner/repo> --ref <branch>`. Its **Import AGS evidence** control calls `POST /tenants/<tenant>/operator/ags-evidence-import` for an already downloaded bundle-local artifact directory and has the headless equivalent `loom harness platform-operator-ags-evidence-import --dir cutover-bundle --artifact-dir <downloaded-ags-artifact-dir> --phase pre-serve --repo-root <repo-root> --repo <owner/repo> --ref <branch>`; use `--phase post-serve` for native-write evidence. Its **Export handoff** control calls `GET /tenants/<tenant>/operator/handoff-packet` with the same proof flags and optional `repo`/`ref` plus `clientId`; its **Export approvals** control calls `GET /tenants/<tenant>/operator/approvals` with `clientId`; both display token-free JSON in the report pane and still do not require `shell.exec`. To execute from a cockpit, use `POST /tenants/<tenant>/operator/cockpit-loop` with JSON `{ "execute": true, "confirm": "execute-current-cockpit-command", "queue": true, "repo": "<owner/repo>", "ref": "<branch>", "maxSteps": 1 }`; the route requires tenant `admin` plus server `shell.exec`, writes `reports/operator-cockpit-runner-execute.json`, records tenant audit event `operator_cockpit_loop_executed`, and still omits command stdout/stderr from the execution report. Omitting `maxSteps`, or setting it to `1`, preserves the single-current-command execution path based on `operator-cockpit-next.json` and then refreshes the dry-run loop report with the same explicit CI target. Setting `maxSteps` to `2` through `20` executes the refreshed `platform-operator-cockpit-loop` in confirmed mode, advances multiple ready audited commands until the loop stops, writes `operator-cockpit-loop.json`, writes the last executed or blocked runner to `operator-cockpit-runner-execute.json`, and audits `maxSteps`, `iterationCount`, and `executedCount`. Concurrent executes are guarded by the bundle-local `.loom/operator-cockpit-runner.lock`; if another cockpit or agent already holds it and `queue: true` is supplied, the POST returns token-free `202 platform-operator-cockpit-loop-queue/v1`, the request appears in `cockpit-execution-status.queue[]`, and the server executes it automatically after the lane becomes available. If `queue` is omitted, the POST returns `409` with `execution.mode: "blocked"`, writes the token-free blocked runner report, and records `operator_cockpit_loop_execution_blocked` with the same target context. The lock records token-free `owner`, `currentStepId`, `currentBlockingGroupId`, `acquiredAt`, `expiresAt`, and `ttlMs`; the status endpoint reports only that token-free metadata as `idle`, `locked`, `stale`, or `invalid`, plus queue entries and the latest queued execution result. An expired lock is replaced before execution and the runner report marks `executionLease.recoveredStale: true` with the stale holder summary.

Queued cockpit executions are persisted as token-free bundle-local `.loom/operator-cockpit-queue/<queueId>.json` files and restored on harness server restart. Shared-bundle server instances acquire token-free `.loom/operator-cockpit-queue/<queueId>.claim.json` ownership before execution; `cockpit-execution-status.queue[].claim` exposes only the claim owner and timing metadata. Recovered queue items execute as `system/admin`, and both queue and claim files are removed after the queued execution finishes.

Use `loom harness serve --operator-cockpit-queue-backend agent-git-service --operator-cockpit-queue-ags-repo <owner/repo>` to move cockpit queue coordination into AGS; pass `--operator-cockpit-queue-ags-path <path>` only when the default `.loom/operator-cockpit-queue/store.json` path should change. The repo must be a safe `owner/repo` value, and the Contents path must be relative with no empty, `.` or `..` segments; `doctor` rejects invalid values before serve.

Check `/status.server.concurrencyAdmission.operatorCockpitQueue` before wiring external coordination: it declares the requested backend, active backend, queue/claim file patterns, restart recovery, shared-bundle claims, stale-claim cleanup, claim TTL, and the active `store`. An AGS store reports only its token-free repo and Contents path; the browser cockpit shows the same data through the execution-status endpoint. `candidateBackends.agentGitService.ready` becomes true only when the server is configured with the AGS provider, an AGS base URL, and an admin or tenant-scoped control-plane token. Requesting `agent-git-service` without a ready candidate or queue repo, or with invalid store configuration, keeps `activeBackend=filesystem` and reports a token-free fallback reason.

For `target-input-file` refs, the browser cockpit renders fields from `inputTemplate.targets` and posts them to `POST /tenants/<tenant>/operator/real-staging-target-input` with the current proof flags and optional GitHub `repo`/`ref`; that route requires tenant `admin`, does not require `shell.exec`, writes `real-staging-targets.input.json` atomically, refreshes `operator-handoff-packet.json`, and records `operator_real_staging_target_input_written` without target values. CLI operators can run `loom harness platform-operator-real-staging-target-input --dir cutover-bundle --input <platform-staging-targets-input.json> --repo-root <repo-root> --repo <owner/repo> --ref <branch>` to copy a local input JSON into the bundle path and refresh `operator-status.json`, cockpit plan/next, and handoff packet with only token-free path/hash/field metadata in the report, then `loom harness platform-operator-real-staging-targets-apply --dir cutover-bundle --auto-refresh-bundle --repo-root <repo-root> --repo <owner/repo> --ref <branch>` to apply it, refresh the bundle from `plan.real-targets.json`, and advance the cockpit state.

For `github-target` refs, the browser cockpit renders the `platform-ci-target-input/v1` repo/ref template and posts it to `POST /tenants/<tenant>/operator/github-actions-target-input` with the current proof flags; that route requires tenant `admin`, does not require `shell.exec`, writes `github-actions-target.input.json` atomically inside the operator bundle, rejects placeholder repos such as `owner/repo`, refreshes `reports/operator-handoff-packet.json`, and records `operator_github_actions_target_input_written` with only the repo/ref target, path, sha256, byte length, field names, handoff packet path, and token-free handoff metadata. CLI operators can run `loom harness platform-operator-github-actions-target-input --dir cutover-bundle --repo <owner/repo> --ref <branch> --repo-root <repo-root>` to write the same file and refresh `operator-status.json`, cockpit plan/next, and handoff packet without starting the browser cockpit. A saved target file lets the next operator-status refresh generate CI preflight and handoff-run command refs with `--target <path>` even before the preflight report has been rerun.

The status report uses schema `platform-operator-status/v1`, stays token-free, and reads `staging-ci.json`, `plan.json`, `github-actions-staging.yml`, `external-secrets.json`, current reports, and a live `platform-goal-audit` result. It reports `prepare-pre-serve`, `ready-for-serve`, `run-post-serve-proof`, or `production-cutover-ready`, plus the next strict pre-serve, manual serve, post-serve command, external audit `nextActions`, CI handoff preflight command, CI handoff-run command, CI workflow install command, audited workflow dispatch/wait commands, artifact sync/import commands, and GitHub Actions `workflow_dispatch` phase. During `prepare-pre-serve`, it lifts `external-staging-audit.json.nextActions` ahead of CI handoff actions, so placeholder target replacement and required env-name gaps remain visible before Actions dispatch. It also includes `reports.bundleVerify`, `reports.stagingPrerequisites`, `reports.stagingTargetsPlan`, `reports.stagingTargetsEnvCheck`, `reports.upstreamAgentGitServiceServerEnvPlan`, `reports.stagingRun`, `reports.stagingTargets`, `reports.stagingEvidence`, `reports.ciWorkflowPublishPlan`, and `reports.ciSecretsPlan` when those reports exist and lifts their `nextActions`, so bundle integrity, prerequisite env/tooling gaps, real target replacement, replacement env validation gaps, upstream `gh-server` env/startup, pre-serve run/target/evidence gaps, repo/ref discovery, and GitHub secret injection remain visible from the single status rollup. Its `ciHandoff` block records the workflow file, workflow name, sha256, required secret env names, workflow concurrency guard, `bundle_dir=cutover-bundle`, `workflowInstall` source/destination and command steps for `.github/workflows/github-actions-staging.yml`, `platform-ci-handoff-install` command args, installed workflow path/existence/sha256 plus `matchesBundle`, install-report path/sha256 plus `matchesBundle`, `preflight` including any preflight `missing`, `nextActions`, target input path/sha256/template when emitted, required secret env summary, and missing-secret `gh secret set` command args, `handoffRun`, `workflowRun` proof path/run URL/sha256 plus `matchesHandoff`, `workflowDispatch`, `workflowWait`, `artifactSync`, and `artifactImport` report/command fields, `node_version=22`, the `bootstrap_source_tree=true` checkout-backed default, and both `workflowDispatchCommandArgs` plus copyable `workflowDispatchCommand` for `gh workflow run` without exposing secret values. When `LOOM_BIN` is unset and an executable `loom-wrapper` exists in the bundle directory, those operator-status `ciHandoff` harness command arrays and copyable commands use the wrapper instead of requiring a global `loom`; `gh workflow run` commands still start with `gh`. If the bundle is in a subdirectory, pass `--repo-root <path>` to `platform-ci-handoff-install`, `platform-operator-status`, and `platform-ci-handoff-run` so workflow install and run proof checks use the actual repository root. Prefer `loom harness platform-ci-handoff-run --dir cutover-bundle --repo-root <repo-root> --repo <owner/repo> --ref <branch> --phase post-serve --preflight --report cutover-bundle/reports/ci-handoff-run.json` for the real external handoff; with an explicit repo root it first installs or refreshes the local workflow, then runs preflight, dispatches it, waits for completion, downloads/imports the reports artifact, and writes operator status while preserving the individual subreports. If `--repo` and `--ref` are passed to operator status or cockpit commands, that explicit target overrides stale/missing preflight discovery and is carried into handoff-run, workflow dispatch, workflow wait, artifact sync, preflight, and copyable `gh workflow run` commands; otherwise, a preflight report with recorded `targetInputPath` is reused in generated preflight/handoff-run commands as `--target <path>`, and recorded repo/ref are still carried into workflow dispatch/wait/sync commands. If `--ref` is omitted, a successful preflight lets handoff-run use the repository default branch from `gh repo view` for dispatch, run listing, waiting, and artifact sync. Workflow dispatch run-id discovery filters `gh run list` to `workflow_dispatch` and the target ref to avoid matching another branch or event. If the run already dispatched or completed and a later step failed, add `--resume` to reuse matching successful dispatch/wait reports instead of creating a duplicate Actions run; resume reuse is accepted only when the saved dispatch/wait reports match the current phase and GitHub target repo/ref. The separate fallback steps are `platform-ci-handoff-preflight`, `platform-ci-handoff-install`, `platform-ci-workflow-dispatch`, `platform-ci-workflow-wait`, `platform-ci-artifact-sync`, and `platform-ci-artifact-import`. The checkout does not need to contain the local install report, but if it does, `platform-ci-run-proof` verifies it. It is a status rollup, not a replacement for the strict reports it references. The strict post-serve script refreshes `reports/operator-status.json`, `reports/operator-cockpit-plan.json`, `reports/operator-cockpit-next.json`, and `reports/operator-handoff-packet.json` before final proof, executes the current `post-serve-proof` command through `platform-operator-cockpit-runner --execute` to write `reports/operator-cockpit-runner-execute.json`, then reruns final artifact verification with `--require-operator-cockpit-runner-execute`, staging proof, goal audit, status, cockpit artifacts, and handoff packet; generated jq checks require final status to be `production-cutover-ready`, require `gates.ciHandoffReady`, validate runner execute lease evidence, and validate the cockpit plan/next/handoff packet schemas, so a missing or stale installed workflow, installer report, workflow dispatch report, CI run proof, runner lease proof, or cockpit artifact keeps the final handoff blocked and leaves a preflight/install/handoff-run/dispatch/wait/sync/import action in `nextActions`.
Artifact import follows `staging-ci.expectedReports`, rejects `ci-run-proof.json` when its phase does not match the import phase or, when an expected run id is supplied by artifact sync or operator-status, its `github.runId` does not match the downloaded run, and rejects `operator-cockpit-runner-execute.json` instead of copying it when the report is not token-free executed lease evidence with `execution.exitCode: 0`, empty `missing`, and `executionLease.acquired: true`; rejected or missing reports also remove any stale destination report so an older green proof cannot survive a failed import.
Final CI handoff readiness requires `ci-run-proof.json.phase == "post-serve"`; a pre-serve Actions proof can guide the handoff but cannot satisfy production cutover. When `ci-workflow-dispatch.json` or `ci-workflow-wait.json` is present, `operator-status.json` also requires the CI proof `github.runId` to match that audited run id. `platform-ci-artifact-sync` also defaults to the audited wait/dispatch run id before falling back to any existing proof, so stale local proof cannot choose the artifact download target.
When `reports.stagingRun`, `reports.stagingTargets`, or `reports.stagingEvidence` are absent, operator status adds a pre-serve evidence action that names the missing reports and the strict pre-serve command that should generate them.
When `--require-agent-git-service` is set, `operator-status.json` also includes `agentGitService`, a token-free provider contract summary over `upstream-agent-git-service-server-env-plan.json`, `upstream-agent-git-service-handoff.json`, `agent-git-service-staging-readiness.json`, optional post-serve `agent-git-service-native-write-check.json`, and `agent-git-service-compat/{manifest,baseline,candidate,compare}.json`; it reports per-report refs, `serverEnvPlanOk`, `upstreamHandoffOk`, `stagingReadinessOk`, `nativeWriteCheckOk`, `compatOk`, `nativeWriteCheckRequired`, `missing`, and copyable next actions without storing token values. The matching `upstream-agent-git-service.commandRefs[]` exposes `ags-evidence-sync` for downloading a GitHub Actions artifact by run id and focused-importing AGS reports, `ags-evidence-import` for already downloaded pre-serve AGS artifacts, the upstream handoff command, and the plan-derived `agent-git-service-staging-readiness` and `agent-git-service-compat-rehearsal` argv when those reports are missing. Once the bundle reaches post-serve proof and the plan or staging CI requires AGS native write, the `post-serve-proof` blocking group also exposes `reports.agentGitServiceNativeWriteCheck`, uses the plan-derived `agent-git-service-native-write-check` command as the default runnable proof command, and keeps both `ags-evidence-sync --phase post-serve` and focused `ags-evidence-import --phase post-serve` refs for native-write evidence before final artifact/proof commands.
It also emits `cockpitPlan` (`platform-operator-cockpit-plan/v1`), a token-free ordered handoff plan that connects the grouped refs into UI/CI execution order: `real-staging-targets`, `upstream-agent-git-service`, `operator-env`, `github-actions`, `pre-serve-evidence`, then `post-serve-proof`; its `execution` summary exposes `state`, pending step count, missing input count, command ref count, and the current step id so a cockpit or CI runner can decide whether to collect inputs or run the next audited command without parsing prose. When `execution.state` is `needs-input`, `execution.nextInputRefs[]` contains the current step's missing token-free inputs; when it is `ready-to-run`, `execution.nextCommandRef` contains the next audited command. `platform-operator-cockpit-plan` exports the full plan, and `platform-operator-cockpit-next` exports the compact `platform-operator-cockpit-next/v1` artifact with only the current state plus `inputRefs` or `commandRef`; both exit zero when the export succeeds, while readiness remains governed by `platform-operator-status`. `platform-operator-cockpit-runner` consumes that compact artifact: it exits nonzero with `inputRefs` when inputs are missing, dry-runs ready commands by default, and only runs `commandRef.commandArgs` when `--execute` is explicit; execute mode uses an atomic bundle-local lease and reports `mode: "blocked"` plus `missing: ["executionLease"]` instead of running when another cockpit/agent is already executing. If `--execute` is called after the cockpit is already complete and a successful execute report already exists at the same report path, the runner preserves that earlier executed lease report instead of overwriting it with a complete/no-op report. Its report records the exit code but not command stdout/stderr. `platform-operator-cockpit-loop` is the outer automation step: each iteration refreshes `operator-status.json`, `operator-cockpit-plan.json`, `operator-cockpit-next.json`, `operator-handoff-packet.json`, and `operator-cockpit-runner.json`, includes a token-free status summary with `agentGitService`, `blockingGroups`, `missing`, `gates`, and `nextActions`, then stops on missing inputs, dry-run, completion, blocked lease, or failed execution; with `--execute --max-steps N` it can advance ready commands and refresh before the next decision. Generated bundles list `operator-cockpit-runner-execute.json`, `operator-cockpit-plan.json`, `operator-cockpit-next.json`, and `operator-handoff-packet.json` in `staging-ci.expectedReports.postServe` so CI archives them; final `operator-artifacts.json` anchors the runner execute report, while the cockpit plan/next/handoff packet files are generated after final status and are not used as earlier proof inputs. It also emits `blockingGroups[]`, a token-free machine-readable checklist grouped by `local-mvp`, `operator-env`, `tooling`, `external-targets`, `upstream-agent-git-service`, `pre-serve-evidence`, `github-actions`, and `post-serve-proof`, so operators and CI can clear one class of blockers at a time without parsing prose-only `nextActions`. The `local-mvp` group keeps `visionLock`, `onlineSandbox`, and `concurrencyAudit` gaps from `platform-goal-audit` visible, exposes a `platform-cutover-run` cutover/smoke command when the plan has those stages, then exposes the audited `platform-concurrency-audit` command. The browser cockpit renders the AGS provider summary and those groups above the current input/action panel so the full cutover target remains visible while clearing one step. The `operator-env` group exposes `envRefs[]` with env names, `requiredFor`, and whitelisted `uses` metadata only; it does not include secret values. The `external-targets` group exposes `targetEnvRefs[]` with the `LOOM_REAL_*` env names, target field names, placeholder ids, presence status, and token-free env-check snippets for real LiteLLM/Coder/AGS target replacement; it also exposes `targetInputRefs[]` with the `real-staging-targets.input.json` template path/object and operator `applyInputCommandArgs`, and if that file validates the cockpit advances directly to `operator-real-staging-targets-apply`, which applies the input, refreshes the bundle, and refreshes cockpit artifacts without reading file contents into status. The `upstream-agent-git-service` group exposes `serverEnvRefs[]` for upstream `gh-server` env names such as `DB_DSN`, including presence status and token-free env-check shell snippets. The `github-actions` group exposes `githubTargetRefs[]` for missing or discovered `repo`/`ref` inputs, including `inputTemplatePath`/`inputTemplate` when preflight emitted the `platform-ci-target-input/v1` file format, plus `secretRefs[]` with required GitHub Actions secret env names, presence status, and token-free `gh secret set` command args when preflight recorded them. Groups that already have audited command arrays also expose `commandRefs[]` with a short label, copyable command string, and `commandArgs`; current refs cover local MVP cutover/smoke and concurrency audit, target env validation, operator real-target apply/refresh, real-target proof, bundle refresh, prerequisites rerun, upstream AGS start/readyz/handoff/evidence import, AGS staging readiness, AGS compat rehearsal, post-serve AGS native-write proof/evidence import, strict pre-serve, post-serve artifact/proof/audit, and the CI handoff preflight/run/proof/dispatch/wait/artifact steps. `platform-operator-handoff-packet` flattens command refs from every current blocking group; non-cockpit checklist groups such as `local-mvp` use their group id as `stepId`, and each flattened ref carries both dry-run and execute `platform-operator-handoff-runner` argv. `platform-operator-handoff-runner --dir cutover-bundle --blocking-group local-mvp --label platform-cutover-run-cutover-smoke` consumes those flattened refs, dry-runs by default, and only executes the selected command with `--execute`; execute mode uses its own bundle-local lease so a blocked current cockpit step does not force operators to copy/paste unrelated checklist commands. Generated post-serve jq checks require this array to exist and be empty before accepting final operator status.

After the post-serve cutover and smoke reports exist, collapse the concurrency evidence into one rollout gate:

```bash
loom harness platform-concurrency-audit --cutover-report cutover-bundle/reports/cutover-report.json --smoke-report cutover-bundle/reports/smoke.json --require-agent-git-service --report cutover-bundle/reports/concurrency-audit.json
```

The report uses schema `platform-concurrency-audit/v1`, stays token-free, and fails until cutover/smoke both show valid concurrency admission, run-scoped workspaces, run-suffixed branch lease evidence, multi-agent smoke proof, AGS project-agent token injection, and AGS native projection through handoff workspace attachment plus VAS wiki memory. The post-serve `commands.sh` path writes this report automatically and final artifact verification anchors it through `operator-artifacts.json` and `staging-proof.json`.

After final artifacts and staging proof exist, ask whether the whole original target is still green:

```bash
loom harness platform-goal-audit --dir cutover-bundle --require-external-staging --require-operator-approvals --require-agent-git-service --report cutover-bundle/reports/goal-audit.json
```

The report uses schema `platform-goal-audit/v1`, stays token-free, and fails until local MVP proof, online sandbox smoke, concurrency audit, current post-serve CI run proof, current strict staging prerequisites, current strict `staging-run.json`, current `external-staging-audit.json`, staging proof hash anchoring for those pre-serve reports plus current operator artifacts, approvals, and CI proof, strict-mode operator artifacts including `requireOperatorCockpitRunnerExecute`, operator-artifacts hash anchoring for the current pre-serve reports and current cutover/smoke/concurrency/CI reports, strict external staging proof, operator approval proof, confirmed `operator-cockpit-runner-execute.json` lease evidence, and AGS provider evidence all compose into `gates.productionCutoverReady`. In AGS-required mode, the online sandbox gate requires smoke to explicitly set `agentGitServiceNativeProjectionChecked: true` and include `agent-git-service-native-projection` in `onlineSandboxGoldenPathCapabilities`; an omitted field is not enough, and both `platform-ci-artifact-import` plus generated staging CI checks enforce the same capability proof. The CI gates are `ciRunProofOk`, `ciRunProofAnchorOk`, `ciRunProofStagingProofAnchorOk`, and `ciRunProofHandoffOk`; they require a successful post-serve GitHub Actions proof, the current `ci-run-proof.json` sha256 anchored by both `operator-artifacts.json` and `staging-proof.json`, and, when audited dispatch/wait reports exist, the proof `github.runId` matching that post-serve workflow run. The cockpit runner gates are `operatorCockpitRunnerExecuteOk` and `operatorCockpitRunnerProofAnchorOk`; they require a token-free executed runner report with `execution.exitCode: 0`, empty `missing`, `executionLease.acquired: true`, matching runner/lease `currentStepId` and `currentBlockingGroupId`, and the current runner report sha256 anchored by `operator-artifacts.json`. The pre-serve `commands.sh` path writes token-free `operator-status.json`, `operator-cockpit-plan.json`, and `operator-cockpit-next.json` before stopping for manual `serve`; the post-serve path writes those cockpit artifacts before final proof, executes the current `post-serve-proof` command through the runner, then reruns artifact verification with `--require-operator-cockpit-runner-execute`, `staging-proof.json`, `goal-audit.json`, final status, and final cockpit artifacts; generated jq checks reject a bundle whose final goal audit is missing, whose final operator status is not `production-cutover-ready`, whose runner execute proof is invalid, or whose cockpit artifacts are missing.

Use `LOOM_CUTOVER_PHASE=pre-serve ./commands.sh` when CI should stop after `reports/staging-run.json`, `reports/staging-targets.json`, `reports/staging-evidence.json`, `reports/staging-verdict.json`, `reports/external-staging-audit.json`, and the pre-serve operator cockpit artifacts, then wait for a human to start `serve`; add `LOOM_REQUIRE_EXTERNAL_STAGING=1` for real staging and `LOOM_REQUIRE_OPERATOR_APPROVALS=1` when mutating approval proof is required. The verdict is token-free and reports `decision: "ready-for-serve"` or `decision: "blocked"` with `failedGates`, `missing`, and `nextActions`. After `serve` is reachable, use `LOOM_CUTOVER_PHASE=post-serve ./commands.sh` to skip the already-approved pre-serve probes and run serve-ready, cutover/smoke, concurrency audit, cockpit post-serve proof execution, final artifact verification, `reports/staging-proof.json`, `reports/goal-audit.json`, final `reports/operator-status.json`, final `reports/operator-cockpit-plan.json`, and final `reports/operator-cockpit-next.json`. The final artifact verifier requires `staging-targets.json`, `staging-evidence.json`, `staging-verdict.json`, `staging-run.json`, external staging audit, `serve-ready.json`, and `concurrency-audit.json` in strict external mode, requires `operator-cockpit-runner-execute.json` after cockpit execution, includes them in the hash and forbidden-secret scan, and rejects a verdict whose `evidenceSha256` no longer matches `staging-evidence.json`. In strict external AGS mode, `platform-staging-proof` also includes the current `agent-git-service-compat/{manifest,baseline,candidate,compare}.json` reports and every safe `staging-ci.json.expectedReports` entry except the final cockpit plan/next artifacts, then requires `operator-artifacts.json` to anchor them where an operator artifact can reasonably do so. Leave the variables unset, or set `LOOM_CUTOVER_PHASE=all`, to rerun the full flow.
If `loom` is not globally installed and the bundle has an executable `loom-wrapper` beside `commands.sh`, leave `LOOM_BIN` unset and the script will use that wrapper. Set `LOOM_BIN` only when you want to override the bundle-local wrapper with another executable path or command name.
When `LOOM_RUN_STAGING_CI_CHECKS=1`, the bundle script requires `jq` in `PATH` before bundle verification or any stage runs because it executes the generated `staging-ci.json` jq checks directly.
Before sharing the bundle, verify it. Repeat `--forbid` for any known secret value available to the CI job, or use `--forbid-env ENV_NAME` to avoid putting the value in argv; the report returns missing files, hash mismatches, and hit file names/counts, not the forbidden value. Use `--report path.json` when the verifier is run outside `commands.sh`.

```bash
loom harness platform-cutover-bundle-verify --dir cutover-bundle --forbid "$LOOM_DEV_TOKEN"
```

The shortest CI execution path is:

```bash
cd cutover-bundle
LOOM_REQUIRE_EXTERNAL_STAGING=1 LOOM_REQUIRE_OPERATOR_APPROVALS=1 LOOM_RUN_STAGING_CI_CHECKS=1 LOOM_CUTOVER_PHASE=pre-serve ./commands.sh
jq -e '.schemaVersion == "platform-staging-run/v1" and .gates.readyForServe == true' reports/staging-run.json
jq -e '.tokenFree == true and .gates.externalStagingReady == true' reports/staging-targets.json
jq -e '.ok == true and .decision == "ready-for-serve"' reports/staging-verdict.json
# Start the manual serve stage, run each staging-ci.json operatorApprovals[].command after approval, then verify them:
loom harness platform-operator-approvals --dir . --report reports/operator-approvals.json
jq -e '.ok == true and .gates.allGatesApproved == true and .gates.allRequirementsSatisfied == true' reports/operator-approvals.json
LOOM_REQUIRE_EXTERNAL_STAGING=1 LOOM_REQUIRE_OPERATOR_APPROVALS=1 LOOM_RUN_STAGING_CI_CHECKS=1 LOOM_CUTOVER_PHASE=post-serve ./commands.sh
jq -e '
  .ok == true and
  .tokenFree == true and
  .missingReports == [] and
  .hashMismatchedReports == [] and
  .stageAnchorMismatchedReports == [] and
  .postServeEvidenceMissing == [] and
  .forbiddenValueHitReports == [] and
  .gates.bundleVerifyOk == true and
  .gates.stageRunReportsOk == true and
  .gates.operatorApprovalsOk == true and
  .gates.postServeEvidenceOk == true and
  (.gates.agentGitServiceCompatOk // true) == true and
  (.gates.agentGitServiceStagingReady // true) == true
' reports/operator-artifacts.json
```

When `commands.sh` includes post-serve verification stages, start the long-running server first, verify it is reachable, then rerun the script or run the listed `platform-cutover-run --satisfy ...` command manually. AGS post-serve jq checks and artifact verification require cutover/smoke AGS readiness plus server/tenant discovery evidence: `tokenMode` must be `admin` or `tenant-scoped`, and missing-tenant lists must be empty. Approval-required AGS mutating stages stay out of automatic runs until the operator has reviewed the evidence and passes the matching `--approve` gate. The generated approval command preserves all `stage.requires` entries as `--satisfy` flags and starts with `"${LOOM_BIN:-loom}"`, so keep extra change-window or external-evidence requirements in the plan instead of editing them into CI by hand. `platform-operator-approvals --dir .` reads `staging-ci.json.operatorApprovals[]` and the reports under `reports/`, then exits non-zero until every approval report is present, `ok: true`, carries the matching gate id, and records all `stage.requires` entries in `satisfiedRequirements`; final artifact verification enforces the same requirement proof before `gates.operatorApprovalsOk` can pass.

Before executing stages in a real shell, verify the env checklist for the stage group you are about to run:

```bash
loom harness platform-cutover-env-check --plan plan.json --stage platform-preflight --report pre-serve-env.json
loom harness platform-cutover-env-check --plan plan.json --stage smoke --report smoke-env.json
```

To execute the safe stages from a saved plan:

```bash
loom harness platform-cutover-run --plan plan.json --stage platform-preflight --check-env --report pre-serve-run.json
loom harness platform-cutover-run --plan plan.json --satisfy serve-running --check-env --report safe-run.json
```

To run an approval-required stage, select it explicitly and pass the matching gate id after reviewing the required evidence:

```bash
loom harness platform-cutover-run \
  --plan plan.json \
  --stage agent-git-service-provisioning-plan-apply \
  --satisfy serve-running \
  --check-env \
  --approve agent-git-service-provisioning-approval \
  --report ags-apply-run.json
```

For an AGS native write proof after `serve` is reachable, run the generated `agent-git-service-native-write-check` stage the same way. The stage posts a staging issue comment, attaches the evidence URL to an AGS issue workspace, updates wiki memory, and writes only token-free ids/counts/gates. In strict approval mode, final artifacts require both this run report and `reports/agent-git-service-native-write-check.json`; the approval summary alone is not enough.

```bash
loom harness platform-cutover-run \
  --plan plan.json \
  --stage agent-git-service-native-write-check \
  --satisfy serve-running \
  --check-env \
  --approve agent-git-service-native-write-approval \
  --report ags-native-write-run.json
```

Then run the aggregate platform preflight. It reuses the same `serve` shape, then probes the real model gateway, control plane, and Coder executor before any shared service starts:

```bash
loom harness platform-preflight \
  --workspace-root "$LOOM_WORKSPACE_ROOT" \
  --profile platform-readiness \
  --tenant alice \
  --project smoke-platform \
  --template vas-lite \
  --isolation-tenant bob \
  --token-env LOOM_DEV_TOKEN \
  --viewer-token-env LOOM_VIEWER_TOKEN \
  --admin-token-env LOOM_ADMIN_TOKEN \
  --repo "https://git.example/team/app.git" \
  --branch "loom/{tenant}/{project}/{runId}" \
  --model-base-url "https://litellm.example" \
  --model-key-env LOOM_MODEL_KEY \
  --executor-workspace "loom-{tenant}" \
  --executor-remote-cwd "/home/dev/projects/{project}" \
  --executor-worktree-cwd "/home/dev/projects/{project}/.worktrees/{runId}" \
  --executor-ide-url "https://coder.example/@{tenant}/{project}/{runId}" \
  --executor-preview-url "https://preview.example/{tenant}/{project}/{runId}" \
  --executor-template loom \
  --executor-cpus 1 \
  --executor-memory 2g \
  --executor-pids-limit 256 \
  --control-plane-provider gitea-forgejo \
  --control-plane-pr \
  --control-plane-merge \
  --control-plane-comment-sync \
  --control-plane-webhook-secret-env LOOM_GITEA_WEBHOOK_SECRET \
  --control-plane-url "https://git.example" \
  --control-plane-token-env LOOM_GITEA_TOKEN \
  --tenant-control-plane-token-env alice=LOOM_GITEA_TOKEN \
  --tenant-key-env alice=LOOM_ADMIN_TOKEN:ops:admin \
  --tenant-key-env alice=LOOM_DEV_TOKEN:eno:developer \
  --tenant-key-env alice=LOOM_VIEWER_TOKEN:auditor:viewer \
  --tenant-key-env bob=LOOM_BOB_DEV_TOKEN:bob:developer \
  --ingest-brain \
  --allow-tool git.pr
```

The result contains `doctor`, `model`, `controlPlane`, and `coder` subreports plus `gates`, `missing`, `nextCommandsReady`, `cutoverReportCommandArgs`, and `smokeCommandArgs`. It does not print token material. Pass `--report reports/platform-preflight.json` when this is part of an operator bundle; the final artifact verifier requires that report before `serve`. Do not proceed until top-level `ok: true`; if `nextCommandsReady` is false, provide the missing env-name/template/isolation inputs and rerun before handing the result to CI.

For focused troubleshooting, run the individual probes:

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
  --tenant-key-env alice=LOOM_DEV_TOKEN:eno:developer \
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
  --tenant-key-env alice=LOOM_DEV_TOKEN:eno:developer \
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

Before cutover, provision project agents through the harness, not manually. If `platform-cutover-plan` or `cutover-report` emitted the AGS provisioning argv fields, execute those exact arrays; the commands below are the equivalent manual form:

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
