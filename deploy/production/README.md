# Production deployment

Two harness instances behind an Nginx TLS reverse proxy, backed by PostgreSQL +
Redis. This is the deployable form of the `platform-readiness` profile: an
isolated executor, control-plane wiring, and a reverse-proxy-aware rate limiter.

Unlike [`../staging`](../staging/), this does **not** pass
`--allow-unsafe-local-executor` — runs execute in the Docker executor (or Coder;
see below), not in the server process.

## 1. Configure

```bash
cp deploy/production/.env.example deploy/production/.env
# Fill every CHANGE_ME. Keep .env out of version control.
```

Then validate the inputs without starting anything or contacting external
systems:

```bash
npm run production:check
```

It checks the required env, HTTPS URLs, and secret-env names, then runs the
non-networked `harness doctor` for the profile. Green before you continue.

## 2. TLS certificate

Put a certificate chain and key where the nginx service expects them:

```bash
mkdir -p deploy/production/tls
cp fullchain.pem deploy/production/tls/fullchain.pem
cp privkey.pem   deploy/production/tls/privkey.pem
```

Use a real CA (Let's Encrypt / your PKI). The reverse proxy terminates TLS and
forwards to the instances over the internal network.

## 3. Bring it up

```bash
docker compose -f deploy/production/compose.yml --env-file deploy/production/.env up -d --build
```

This starts `loom-a`, `loom-b`, `nginx`, `postgres`, and `redis`. For real
production, point `LOOM_POSTGRES_URL` / `LOOM_REDIS_URL` at managed instances and
delete the `postgres` / `redis` services and their volumes from the compose file
— the app is stateless apart from the workspace volumes.

### Executor choice

The compose file uses `--executor docker` and mounts the host Docker socket.
That shares the host kernel; for stronger multi-tenant isolation switch to the
Coder executor:

```
--executor coder --executor-workspace loom-{tenant}
--executor-remote-cwd /home/dev/projects/{project}
--executor-worktree-cwd /home/dev/projects/{project}/.worktrees/{runId}
```

Coder isolation is not yet validated at runtime here (see the top-level
readiness notes); treat the Docker executor as the interim boundary.

## 4. Verify

```bash
curl https://YOUR_HOST/healthz                         # process is up
curl https://YOUR_HOST/readyz                          # PG/Redis ready (503 if not)
curl -H "authorization: Bearer $LOOM_OPERATOR_TOKEN" https://YOUR_HOST/status
```

Then walk [`../../docs/operator-runbook.md`](../../docs/operator-runbook.md) for
the full readiness smoke.

## 5. Backups

Schedule [`backup.sh`](./backup.sh) via cron on a host that can reach Postgres
and Redis. It runs the encrypted `platform-backup` and keeps the newest 14.
Point `BACKUP_OUT` at durable off-host storage — the CLI does not replicate for
you, and PITR (WAL replay) is not included; add managed-PG PITR separately if
you need a tighter recovery point.

## 6. Operational notes

- **Graceful shutdown** is wired: `docker compose stop` sends SIGTERM, each
  instance drains in-flight requests, aborts active runs, and releases
  sessions/claims before exiting.
- **Rate limiting**: the serve command trusts exactly one proxy hop
  (`--rate-limit-trusted-proxy-hops 1`) and nginx sets `X-Forwarded-For` to the
  real client IP. If you add more proxies in front, raise the hop count to match
  or the limiter will key on a proxy IP.
- **Operator token gates /status and /metrics**: the serve command configures
  an operator key (`--tenant-key-env production=LOOM_OPERATOR_TOKEN:...`). Without
  a status key those cross-tenant views are **open**, leaking run metadata and
  host paths — so `LOOM_OPERATOR_TOKEN` is required, not optional.
- **Monitoring** (opt-in profile): a ready Prometheus + Grafana stack ships in
  [`../observability/`](../observability/). Drop the operator token into the file
  Prometheus reads, then start the profile:

  ```bash
  mkdir -p deploy/production/secrets
  printf '%s' "$LOOM_OPERATOR_TOKEN" > deploy/production/secrets/loom_operator_token
  docker compose -f deploy/production/compose.yml --env-file deploy/production/.env \
    --profile observability up -d
  ```

  Prometheus (`:9090`) scrapes both instances' `/metrics` with that bearer token
  and loads the alert rules in
  [`../observability/loom-alerts.yml`](../observability/loom-alerts.yml); Grafana
  (`:3000`, admin password `GRAFANA_ADMIN_PASSWORD`) auto-provisions the
  datasource and the **Loom Harness** dashboard. The `secrets/` dir and `*.pem`
  TLS material are gitignored.
- **Backups / durability**: `backup.sh` takes an encrypted logical snapshot
  (see §5). That is point-in-*backup*, not point-in-*time* — it does not replay
  WAL. For a tight RPO, run Postgres on a managed service with PITR enabled, or
  add continuous WAL archiving (e.g. pgBackRest / wal-g) to off-host storage; the
  logical backup is the portable fallback, not the primary recovery path.
- **Soak / load gate**: `npm run soak` drives a live instance with sustained
  concurrent mixed load and fails on any 5xx, any cross-tenant read, or runaway
  memory. Default run is short; before a real cutover run a long one against the
  staging instance: `LOOM_SOAK=1 SOAK_DURATION_MS=120000 SOAK_CONCURRENCY=32
  node --expose-gc --import tsx --test tests/soak.test.ts`.
- **Not yet proven in a real environment** (do not skip before real production):
  non-loopback external staging and Coder runtime isolation — both need a real
  host / real Coder and cannot be validated from the repo.
