# Loom Service Levels and Alerts

This document defines production targets. A target is not evidence that the
service currently meets it. Soak reports and monitoring data provide that
evidence.

Backup and drill procedures are defined in `docs/disaster-recovery.md`.

## Service Level Indicators

| SLI | Production target | Measurement |
|---|---:|---|
| Harness control-plane availability | 99.9% per rolling 30 days | successful `/readyz` probes |
| Authenticated status latency | p95 below 500 ms | HTTP duration at the ingress |
| Run admission latency | p95 below 2 s, excluding intentionally queued runs | create request to running/queued durable state |
| Queue wait | 99% below 5 minutes | `loom_harness_queue_oldest_age_seconds` |
| Durable run evidence | 99.9% of terminal runs have summary and ordered events | scheduled evidence audit |
| State dependency availability | 99.95% per rolling 30 days | metadata and coordination probe metrics |
| OIDC identity-provider availability | 99.95% per rolling 30 days when configured | discovery/JWKS readiness and `loom_harness_oidc_ready` |
| Backup recovery point | 15 minutes or less | latest verified backup timestamp |
| Recovery time | 60 minutes or less | quarterly restore exercise |

Error-budget policy:

- below 50% remaining monthly budget: stop non-essential platform features;
- below 25%: only reliability, security, and rollback work may ship;
- exhausted budget: freeze production changes until the triggering class of
  incident has a verified corrective action.

## Readiness

`/healthz` only proves that the HTTP process is alive. `/readyz` additionally
requires startup queue recovery, stale-run cleanup readiness, and a fresh
successful probe of each configured state dependency. A failed, timed-out, or
stale PostgreSQL/Redis probe returns HTTP 503. Probe reports contain backend
names and bounded counters, never connection URLs or raw errors.

When OIDC is configured, readiness also requires successful discovery and a
non-empty JWKS fetch; tokens and provider errors are never included in health
responses.

See `docs/authentication.md` for claim and credential-rotation contracts.

The probe controls are:

- `--state-probe-interval-ms` (default `5000`);
- `--state-probe-timeout-ms` (default `2000`);
- `--state-probe-max-staleness-ms` (default `15000`).

## Metrics

The `/metrics` endpoint is admin-only when tenant authentication is configured.
Metrics intentionally avoid tenant, project, run, actor, and token labels.

Core production signals:

- `loom_harness_state_backend_ready`;
- `loom_harness_oidc_ready`;
- `loom_harness_metadata_dependency_up`;
- `loom_harness_coordination_dependency_up`;
- `loom_harness_*_dependency_probe_latency_ms`;
- `loom_harness_*_dependency_probe_failures_total`;
- `loom_harness_queue_oldest_age_seconds`;
- `loom_harness_expired_run_leases`;
- `loom_harness_queue_recovery_failures`;
- `loom_harness_tenant_run_capacity_utilization`;
- `loom_harness_workspace_session_capacity_utilization`.

## Alerts

Prometheus rules live in `deploy/observability/loom-alerts.yml`.

For a dependency alert:

1. stop new mutating operator actions;
2. inspect `/readyz` and dependency-specific `*_up` metrics;
3. verify PostgreSQL or Redis directly from the harness network;
4. do not switch to the file backend;
5. restore dependency service or credentials, then wait for a green fresh probe;
6. inspect expired leases, orphaned runs, and queue recovery before reopening
   admission.

For queue lag or capacity alerts, preserve FIFO order, inspect blocked reasons,
and increase capacity only after checking executor and model-gateway saturation.
Do not delete queue items to clear an alert.

For an OIDC alert, keep existing API keys available for break-glass access,
verify the issuer discovery document and JWKS from the harness network, and
check issuer/audience values before changing keys or claim mappings.
