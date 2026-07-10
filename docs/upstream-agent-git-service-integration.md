# Upstream agent-git-service Integration

Status: tracked candidate, not the harness/loop owner.

Reference: https://github.com/ngaut/agent-git-service

As of 2026-07-02, upstream describes `agent-git-service` as a self-hosted, GitHub-compatible API server for agents. The useful surfaces for us are REST v3, selected GraphQL v4, OAuth device flow, Git Smart HTTP, bare Git repository storage, TiDB/MySQL-compatible metadata storage, durable agent identities, scoped tokens, default workspaces, issue workspace features, and wiki memory.

The local integration entry is `scripts/upstream-agent-git-service-local.sh`. It pins upstream commit `9ab722e07b0797b67da05ecb72ad3c0feae6abd3`, builds upstream's own Dockerfile, requires the real TiDB/MySQL `DB_DSN` contract, waits for the real `/readyz`, and runs Loom's compatibility rehearsal in `candidateMode: upstream`. Its reports use `targetClass: local-upstream-e2e`; they prove that Loom can talk to the real upstream implementation.

```bash
# Existing TiDB/MySQL-compatible DB_DSN
scripts/upstream-agent-git-service-local.sh fetch
scripts/upstream-agent-git-service-local.sh build
DB_DSN="$DB_DSN" scripts/upstream-agent-git-service-local.sh start
scripts/upstream-agent-git-service-local.sh wait
scripts/upstream-agent-git-service-local.sh verify
scripts/upstream-agent-git-service-local.sh stop

# Disposable one-command rehearsal using upstream's TiDB Zero quickstart API
LOOM_AGS_DATABASE_MODE=tidb-zero scripts/upstream-agent-git-service-local.sh e2e-zero
```

The script passes `DB_DSN` and the local AGS token by environment name, never writes either value to reports, refuses a dirty or wrong-revision source checkout, and only removes containers/volumes carrying its ownership label. `e2e-zero` removes its ephemeral container and Git volume after verification; the image and token-free evidence remain for inspection.

## Boundary

Keep these inside loom:

- harness loop, run lifecycle, pause/resume/cancel, idempotent create
- tenant audit, auth policy, model-key accounting, human gates
- Coder/local/docker executor isolation
- VAS-lite cases, learning projection, brain signals

Borrow these from upstream AGS only through the `control-plane-provider` seam:

- issue comments, signed webhooks, pull requests, merge/review evidence
- Git Smart HTTP clone/fetch/push URLs
- durable agent accounts and repo grants
- issue workspace presence/attachments
- wiki memory pages used by VAS learning projection

## Integration Steps

1. Run upstream `gh-server` as the candidate control plane.
2. Point `LOOM_AGENT_GIT_SERVICE_URL` at its external `/api/v3` URL and keep tokens in CI secret storage.
3. Probe it with `loom harness control-plane-preflight --control-plane-provider agent-git-service`.
4. Compare API behavior against the local contract with `loom harness agent-git-service-compat-compare` / `agent-git-service-compat-rehearsal`; require `candidateMode: "upstream"` in the compat manifest.
5. Check readiness with `loom harness agent-git-service-staging-readiness`; upstream `/readyz` must report `status: "ready"`.
6. Provision project agents through `loom harness provision-agent-git-service` (or the plan/apply pair) so every project has a receipt and a stored project-agent token.
7. Ask a running server for the read-only rollup with `loom harness cutover-report --control-plane-provider agent-git-service`; follow its `nextActions` until green.
8. Run the `platform-readiness` smoke against the AGS-configured server before switching any tenant.

## Open Questions

- Which DB deployment is acceptable for production AGS metadata: TiDB Cloud, self-hosted TiDB, or MySQL-compatible managed DB?
- Do we map loom tenant users to AGS durable agents directly, or keep a per-project loom agent plus tenant policy identity mapping?
- Should VAS wiki memory write through AGS wiki APIs only, or keep a mirrored loom-side memory cache for resilience?
- What Git credential shape should Coder workspaces use for AGS Smart HTTP push without exposing long-lived tokens?
- Which upstream GraphQL endpoints are worth depending on, given the current partial parity claim?
