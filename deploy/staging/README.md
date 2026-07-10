# Two-instance staging

This stack exercises the distributed harness state path with two HTTP servers,
PostgreSQL metadata/audit storage, Redis leases/queues, and a shared workspace
volume.

```bash
docker compose -f deploy/staging/compose.yml up -d --build
node scripts/staging-two-instance.mjs
docker compose -f deploy/staging/compose.yml down
```

The smoke script verifies readiness, atomic tenant run capacity, queued-run
takeover after `harness-a` stops, cross-instance audit visibility, tenant auth
isolation, viewer mutation denial, and 100 concurrent status reads. It restarts
`harness-a` before exiting.

The committed token defaults and unsafe local executor are only for isolated
developer staging. External staging must override all three token env vars and
use the Coder executor/profile described in the main platform cutover bundle.
