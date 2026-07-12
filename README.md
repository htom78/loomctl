# loomctl

Operator CLI and HTTP control plane for a multi-user online sandbox development
platform with a first-party, auditable harness loop.

Two loop paths:

1. **First-party harness loop** — `loom harness run`: event log, tool runtime,
   agent adapter, and verification-gated finish.
2. **Native adapter** — `loom goal` delegates to Claude Code / Codex `/goal`
   when you want the thin mode.

The platform shape:

- **Multi-user online sandbox dev** — per-dev persistent workspaces, projects,
  and tenant isolation.
- **Shared control plane** — Gitea/Forgejo board (default) or
  `agent-git-service` as a candidate provider, plus a central LiteLLM gateway.
- **Skill-evolution brain** — capture run signals, score skills, and open
  git-backed improvement PRs.

Approved and completed work is tracked in [`TODO.md`](TODO.md), including the
staged Tauri-based Loom Desktop client roadmap.

## Core guarantees

- Event-sourced run history under `.loom/runs/<runId>/events.jsonl` that humans
  can inspect and replay; one monotonic sequence per run, atomic appends.
- Verification is a hard gate, not a model claim. Optional evaluator commands
  gate after verification; optional reviewer commands record non-gating
  evidence. Human review/deployment gates stay separate from both.
- Tenant-scoped auth (API keys or OIDC), per-run tool allowlists with
  `shell.exec` denied by default over HTTP, and auditable `run_policy` events.
- Run summaries, issue comments, and PR bodies carry requester identity and
  bounded, non-secret error diagnostics. API keys are never written to
  summaries.

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
  --verify "test -f hello.txt"
```

Artifacts land in `.loom/runs/<runId>/events.jsonl` and `summary.json`.

For local configuration, copy `loom.config.example.json` to `loom.config.json`.
Keep credentials in environment variables or an external secret store; local
configuration and generated operator reports are intentionally ignored by Git.

## Serve over HTTP

```bash
loom harness serve --workspace-root /tmp/loom-workspaces --port 8787
```

## Loom Desktop Alpha

The first Tauri desktop client is in `apps/desktop`. It uses the typed
`@loom/api` package, stores API tokens in the operating-system keychain, and
keeps authenticated SSE credentials out of URLs.

```bash
npm run desktop:dev       # native development window
npm run desktop:build     # production frontend + native executable
npm run desktop:bundle    # platform installer/app bundle
```

Create a server profile with the Loom base URL, tenant, and API token. The
alpha supports project/run navigation, run creation, live timelines, comments,
pause/cancel/resume, human-gate decisions, and opening Coder IDE URLs externally.
OIDC, replay/abandon, full review evidence, notifications, and signed installers
remain tracked in [`TODO.md`](TODO.md).

- Async runs with queueing, cancel/pause/resume, idempotent create via
  `clientRequestId`, SSE event streaming, and a browser dashboard/workbench.
- `--profile online-sandbox` — isolated executor profile with the online
  sandbox tool allowlist; `--profile platform-readiness` — full
  Coder/control-plane/LiteLLM/brain readiness checks in `GET /status`.
- The local executor is for loopback, single-user development only.
  `--allow-unsafe-local-executor` is a bounded escape hatch: it never applies to
  a non-loopback host, and on loopback it still refuses the one cross-tenant RCE
  — multiple tenants plus `shell.exec` sharing one host and process user with no
  sandbox (a loopback bind can still be reverse-proxied to the internet, so
  "loopback" is not proof of single-user). Multi-tenant without `shell.exec` is
  limited to per-run path-guarded workspace file ops and stays allowed. Use the
  Docker or Coder executor whenever tenants need to run commands.
- The cross-tenant `GET /status` and `GET /metrics` views only accept keys the
  operator configured at startup (`--tenant-token`/`--tenant-key`). Keys a
  tenant self-issues via `POST /tenants/:tenant/policy/api-keys` never grant the
  platform-wide view, and OIDC identities never do either — every OIDC token is
  scoped to one tenant, so platform status requires a startup operator key even
  in OIDC deployments. OIDC admins keep full access to their own
  `/tenants/:tenant/status`.
- Per-client-IP request rate limiting is on by default (`--rate-limit-rps 200`,
  `--rate-limit-burst 500`; `--rate-limit-rps 0` disables). `/healthz` and
  `/readyz` are exempt so probes keep working. Behind a reverse proxy, set
  `--rate-limit-trusted-proxy-hops <n>` so limiting keys on the real client's
  `X-Forwarded-For` hop instead of the shared proxy IP; it defaults to 0 (trust
  nobody, key on the socket peer) because `X-Forwarded-For` is client-spoofable.
- `SIGTERM`/`SIGINT` (docker stop, k8s eviction, Ctrl-C) trigger graceful
  shutdown: the server stops accepting connections, lets in-flight requests
  finish, then aborts active runs, releases workspace sessions and admission
  claims, and closes the state backend before exiting — rather than a hard kill
  mid-run. Backstop timers force-close lingering connections so shutdown cannot
  hang.

For two or more instances, use PostgreSQL for durable metadata/audit and Redis
for leases and queued-run claims:

```bash
LOOM_POSTGRES_URL='postgres://loom:secret@postgres/loom' \
LOOM_REDIS_URL='redis://redis:6379' \
loom harness serve --workspace-root /data/workspaces \
  --state-backend postgres-redis
```

See [`docs/distributed-runtime.md`](docs/distributed-runtime.md) for ownership
and failure semantics, or run the two-instance proof with `npm run staging:up`,
`npm run staging:smoke`, `npm run staging:down`.

Before starting a shared service, run `loom harness doctor` with the same
`serve` flags — it validates the full flag shape, tenant role coverage, and
executor safety without starting the server or contacting external systems.
Then follow [`docs/operator-runbook.md`](docs/operator-runbook.md).

For the production-shaped gate, copy `deploy/production/.env.example` into
your secret/configuration system and run `npm run production:check`. It builds
the CLI, validates the required Coder, PostgreSQL, Redis, model gateway,
control-plane, OIDC, and operator-key inputs, then invokes the existing
`platform-readiness` doctor. The JSON report is token-free; set
`LOOM_PRODUCTION_CHECK_REPORT=reports/production-check.json` to persist it.

## Brain

```bash
loom brain ingest   # capture run signals
loom brain score    # score skills from accumulated signals
loom brain propose  # open git-backed improvement PRs
```

See [`docs/brain-benchmark.md`](docs/brain-benchmark.md) for the benchmark
harness.

## Map

| piece | where |
|---|---|
| first-party loop | `loom harness run`, `src/harness/loop.ts` |
| HTTP control plane | `loom harness serve`, `src/harness/server.ts` |
| execution boundary | `src/harness/executor.ts` (local), `docker-executor.ts`, `coder-executor.ts` |
| control plane providers | `src/harness/gitea.ts`, `src/harness/agent-git-service.ts` |
| model gateway adapter | `src/harness/model-agent.ts` (LiteLLM/OpenAI-compatible) |
| state backends | file default; `src/harness/storage/postgres.ts` + `redis.ts` distributed |
| skill-evolution brain | `loom brain ingest / score / propose`, `src/brain.ts` |
| disaster recovery | `loom platform-backup / platform-restore / platform-drill`, [`docs/disaster-recovery.md`](docs/disaster-recovery.md) |

## Docs

- [`docs/operator-runbook.md`](docs/operator-runbook.md) — fresh shell to verified platform
- [`docs/authentication.md`](docs/authentication.md) — tenant keys, OIDC, rotation
- [`docs/distributed-runtime.md`](docs/distributed-runtime.md) — multi-instance semantics
- [`docs/disaster-recovery.md`](docs/disaster-recovery.md) — backup/restore/drill
- [`docs/slo.md`](docs/slo.md) — service levels and alerts
- [`docs/upstream-agent-git-service-integration.md`](docs/upstream-agent-git-service-integration.md) — AGS candidate provider
- [`VISION.md`](VISION.md) — vision lock and MVP boundary

## Tests

```bash
npm test
```

Real PostgreSQL/Redis integration tests are skipped unless
`LOOM_TEST_POSTGRES_URL` and `LOOM_TEST_REDIS_URL` are set.

中文说明见 [README.zh-CN.md](README.zh-CN.md)。
