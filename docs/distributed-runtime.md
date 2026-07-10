# Distributed Runtime Architecture

This document records the multi-instance runtime boundary introduced after the
single-process MVP. The target remains a multi-user online sandbox with a
first-party harness/loop; PostgreSQL and Redis make that loop horizontally
coordinated, but do not move ownership into the control-plane provider.

## Runtime Modes

| Mode | Metadata and audit | Admission and queues | Intended use |
|---|---|---|---|
| `file` | workspace filesystem | workspace filesystem | local development and compatibility |
| `postgres-redis` | PostgreSQL | Redis | multi-instance staging and shared service |

The file backend remains the default. Start a distributed server with:

```bash
export LOOM_POSTGRES_URL='postgres://loom:secret@postgres/loom'
export LOOM_REDIS_URL='redis://redis:6379'

loom harness serve \
  --workspace-root /data/workspaces \
  --state-backend postgres-redis \
  --state-postgres-schema loom \
  --state-redis-prefix loom
```

`loom harness doctor` accepts the same state flags. `GET /status` reports
`server.stateBackend`, including whether metadata and coordination are truly
distributed.

## Ownership Boundaries

PostgreSQL owns durable control metadata:

- versioned documents with compare-and-swap updates;
- run status, summary, queued snapshot, and create-idempotency records;
- tenant policy and run pause/cancel requests;
- append-only run and tenant audit event streams with monotonic sequence IDs.

Redis owns short-lived coordination:

- project- or run-scoped execution leases, according to workspace isolation mode;
- tenant active-run capacity and global/tenant workspace-session capacity;
- distributed queued-run ordering, claims, release, and acknowledgement;
- owner-checked TTL refresh and release.

The workspace filesystem still stores source trees, run artifacts, and
compatibility mirrors. In production, Coder is the intended sandbox/workspace
boundary; the shared local volume in `deploy/staging` is only a two-server
coordination fixture.

Process memory owns only live handles such as HTTP streams, child processes,
and attached sessions. It is never the cross-instance admission authority.

## Required Invariants

1. Document updates use expected versions when a stale writer must be rejected.
2. Event append assigns sequence numbers atomically inside the durable store.
3. A lease can be refreshed or released only by its owner token.
4. Capacity checks and lease acquisition are one atomic operation.
5. Queue claims are owner-scoped and expire; completion acknowledges the item.
6. Run creation is idempotent before execution starts.
7. Multiple servers may run migrations concurrently; a PostgreSQL advisory lock serializes schema migration.
8. Filesystem artifacts remain available for local compatibility, but distributed admission never relies on a file lock.

Queue delivery is at least once. Durable run state, exact queue claims, and
create idempotency make retries safe. A server failure allows queued work to be
claimed by another server after claim/lease expiry. An already executing shell
or model process is not live-migrated; its evidence remains durable and stale
admission is released by TTL.

## Module Boundaries

- `src/harness/storage/contracts.ts`: backend-neutral document, event, lease,
  capacity, and queue contracts.
- `src/harness/storage/file.ts`: local compatibility backend.
- `src/harness/storage/postgres.ts`: metadata and event implementation.
- `src/harness/storage/redis.ts`: distributed coordination implementation.
- `src/harness/storage/index.ts`: backend composition.
- `src/harness/run-state.ts`: durable run-state reads/writes plus file mirrors.
- `src/cli/state-backend.ts`: CLI parsing, validation, and backend construction.
- `src/harness/server-routes.ts`: explicit route-domain dispatch for runs,
  workspace, policy, VAS, control-plane, and operator surfaces.

## Failure and Security Model

- PostgreSQL or Redis unavailability fails startup or the affected operation;
  the service never silently downgrades to filesystem coordination.
- Active runs and workspace sessions fail closed when their admission heartbeat
  can no longer refresh the owner-scoped lease.
- Redis persistence helps restart recovery, but PostgreSQL remains the durable
  metadata/audit source of truth.
- Tenant authorization is checked before state access; state keys are scoped by
  tenant/project/run and never grant authority by themselves.
- Connection URLs come from named environment variables and are not written to
  status, audit, or run artifacts.
- The staging stack uses committed local-only tokens and an unsafe local shell
  executor. It must not be exposed externally.

## Two-Instance Proof

Run the repeatable developer staging proof with:

```bash
npm run staging:up
npm run staging:smoke
npm run staging:down
```

The smoke test proves two-server readiness, atomic tenant capacity, queued-run
takeover after the owning server stops, tenant isolation, viewer write denial,
cross-instance audit visibility, and 100 concurrent status reads. CI runs the
same storage contracts against real PostgreSQL and Redis services.

## Control-Plane Provider Boundary

`ngaut/agent-git-service` remains a candidate Git/control-plane provider. It
may supply agent identity, repositories, issues, pull requests, workspace
evidence, and wiki memory. It does not own run admission, queue claims, tenant
audit, verification gates, VAS learning, or the harness loop. Any future AGS
cutover must preserve these storage contracts and pass the same two-instance
and platform concurrency gates.

## Remaining Production Work

- replace the shared-volume staging executor with real Coder workspaces;
- add managed PostgreSQL/Redis backup, restore, encryption, and credential rotation;
- add queue-lag, lease-expiry, retry, and backend saturation telemetry;
- add continuous PostgreSQL/Redis dependency probes to `/readyz`;
- define rolling migration compatibility and load targets beyond the smoke test;
- run strict non-loopback external staging before production cutover.
