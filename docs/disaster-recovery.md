# Disaster Recovery

Loom has two complementary recovery layers:

1. managed PostgreSQL PITR, Redis persistence/replication, and volume snapshots
   provide the 15-minute production recovery-point objective;
2. `platform-backup`, `platform-restore`, and `platform-drill` provide a portable,
   application-aware checkpoint and repeatable restore proof.

The portable backup is not a live distributed transaction. Stop admission,
drain active runs and sessions, stop all harness writers, then pass
`--confirm-quiesced`. The command refuses to run without that confirmation.

## Encryption Key

Generate a 32-byte key and store it in the deployment secret manager:

```bash
openssl rand -base64 32
```

Expose it to the operator process as `LOOM_BACKUP_ENCRYPTION_KEY`. Backups use
AES-256-GCM per artifact and HMAC-SHA256 for the manifest. The key value is not
written to reports or command arguments. Retain old keys until every backup
encrypted with them has expired.

## Create A Backup

```bash
LOOM_POSTGRES_URL='postgres://...' \
LOOM_REDIS_URL='redis://...' \
loom harness platform-backup \
  --out /backups/loom/2026-07-10T1200Z \
  --workspace-root /data/workspaces \
  --postgres-schema loom \
  --redis-prefix loom \
  --encryption-key-env LOOM_BACKUP_ENCRYPTION_KEY \
  --encryption-key-id production-2026-q3 \
  --confirm-quiesced \
  --report /backups/loom/2026-07-10T1200Z-result.json
```

The output directory must be new and outside the workspace root. It contains:

- `postgres.dump.enc`;
- `redis.ndjson.enc`, containing Redis `DUMP` payloads and remaining TTLs for
  the configured prefix;
- `workspaces.tar.enc`;
- `manifest.json`, containing ciphertext/plaintext hashes, counts, IVs, auth
  tags, source database/schema names, and an HMAC.

No plaintext snapshot remains after a successful backup. `pg_dump` must be the
same major version as the server or newer. Use `--pg-dump-command` and
`--pg-restore-command` when versioned client binaries are installed outside
`PATH`.

## Verify And Restore

Create an empty target PostgreSQL database first. Use a new Redis prefix and a
workspace path that does not exist. Put target URLs in separate env vars:

```bash
loom harness platform-restore \
  --dir /backups/loom/2026-07-10T1200Z \
  --workspace-root /restore/loom-workspaces \
  --postgres-url-env LOOM_RESTORE_POSTGRES_URL \
  --redis-url-env LOOM_RESTORE_REDIS_URL \
  --redis-prefix loom-restore-20260710 \
  --encryption-key-env LOOM_BACKUP_ENCRYPTION_KEY \
  --report /restore/restore-dry-run.json
```

Without `--approve-mutating`, this verifies the manifest HMAC, ciphertext and
plaintext hashes, decrypts into a private temporary directory, runs
`pg_restore --list`, validates every Redis record, and checks all tar paths.
It does not alter a target.

After reviewing the dry-run report, repeat with `--approve-mutating`. In-place
database/prefix targets are rejected by default. `--allow-in-place` exists for
an explicitly approved emergency only and should not be used for drills.

## Recovery Drill

Run quarterly against isolated infrastructure:

```bash
loom harness platform-drill \
  --dir /backups/loom/2026-07-10T1200Z \
  --workspace-root /drills/2026-q3/workspaces \
  --postgres-url-env LOOM_RESTORE_POSTGRES_URL \
  --redis-url-env LOOM_RESTORE_REDIS_URL \
  --redis-prefix loom-drill-2026-q3 \
  --encryption-key-env LOOM_BACKUP_ENCRYPTION_KEY \
  --approve-mutating \
  --report /drills/2026-q3/drill.json
```

The drill passes only when PostgreSQL document/event counts, Redis key counts,
and extracted workspace entry counts match the signed manifest. The report
records RPO/RTO seconds and every restore gate without connection URLs or key
material.

Redis TTLs are interpreted against the backup timestamp. Keys that should have
expired before restore are skipped and counted as `redisExpiredKeysSkipped`, so
old run/session leases are not revived by a late recovery.

After a successful drill, run harness readiness and multi-user smoke against
the restored targets before recording the exercise. If a restore fails after
mutation begins, discard the isolated target and start again from a clean
database, prefix, and workspace path; do not promote a partially restored
target.
