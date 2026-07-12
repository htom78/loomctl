#!/usr/bin/env sh
# Encrypted platform backup wrapper, intended for cron.
#
#   crontab: 0 * * * * /path/to/deploy/production/backup.sh >> /var/log/loom-backup.log 2>&1
#
# Runs `loom harness platform-backup` (encrypted pg_dump + Redis + workspaces).
# Reads connection details and the encryption key from the environment by NAME
# only; nothing secret is written to argv or this script. Point BACKUP_OUT at a
# durable, off-host location (a mounted object-store bucket, an NFS share) so the
# backup survives loss of the app host — the CLI does not replicate for you.
#
# Required env:
#   LOOM_POSTGRES_URL, LOOM_REDIS_URL, LOOM_WORKSPACE_ROOT
#   LOOM_BACKUP_ENCRYPTION_KEY   (32-byte key material; keep in a secret store)
# Optional:
#   BACKUP_OUT   (default /data/backups), LOOM_BIN (default: loom)
set -eu

LOOM_BIN="${LOOM_BIN:-loom}"
BACKUP_OUT="${BACKUP_OUT:-/data/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_OUT}/loom-${STAMP}"

mkdir -p "${DEST}"

# --confirm-quiesced asserts the operator has paused writes for a consistent
# logical snapshot; schedule this in a low-traffic window or gate it behind a
# brief maintenance pause. platform-backup reads the encryption key by env name
# and never echoes it.
"${LOOM_BIN}" harness platform-backup \
  --postgres-url-env LOOM_POSTGRES_URL \
  --redis-url-env LOOM_REDIS_URL \
  --workspace-root "${LOOM_WORKSPACE_ROOT}" \
  --encryption-key-env LOOM_BACKUP_ENCRYPTION_KEY \
  --out "${DEST}" \
  --confirm-quiesced

echo "loom backup written to ${DEST}"

# Retention: keep the newest 14 backup directories, drop the rest.
ls -1dt "${BACKUP_OUT}"/loom-* 2>/dev/null | tail -n +15 | while read -r old; do
  rm -rf "${old}"
done
