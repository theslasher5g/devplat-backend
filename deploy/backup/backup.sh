#!/usr/bin/env bash
#
# Nightly Postgres backup to Infomaniak Swiss Backup via rclone.
#
#   pg_dump -Fc  →  gpg (AES-256)  →  rclone copy  →  prune by age
#
# Run from cron as root (see README.md). Exits non-zero on any failure and
# reports the outcome to the control plane, so a broken backup shows up in the
# admin dashboard instead of being discovered the day you need it.
#
# ── One thing to know before editing this file ────────────────────────────
# Infomaniak's FAQ demonstrates `rclone sync`. Do NOT use sync here. `sync`
# makes the destination match the source, so uploading a staging directory
# that holds only tonight's dump would DELETE every older backup on the remote
# — the first run would quietly destroy your entire history. `copy` uploads
# without deleting; retention is done explicitly below, by age.
set -euo pipefail

CONFIG=${BACKUP_ENV:-/opt/devplat/backup.env}
[ -r "$CONFIG" ] || { echo "backup: cannot read $CONFIG" >&2; exit 1; }
# shellcheck source=/dev/null
set -a; . "$CONFIG"; set +a

: "${RCLONE_REMOTE:?not set in $CONFIG}"
: "${RCLONE_PATH:?not set in $CONFIG}"
: "${BACKUP_PASSPHRASE:?not set in $CONFIG}"
[ "$BACKUP_PASSPHRASE" != "CHANGE_ME" ] || { echo "backup: BACKUP_PASSPHRASE is still the placeholder" >&2; exit 1; }

COMPOSE_FILE=${COMPOSE_FILE:-/opt/devplat/docker-compose.yml}
POSTGRES_SERVICE=${POSTGRES_SERVICE:-postgres}
POSTGRES_USER=${POSTGRES_USER:-devplat}
POSTGRES_DB=${POSTGRES_DB:-devplat}
RETENTION_DAYS=${RETENTION_DAYS:-30}

STAGING=$(mktemp -d /var/tmp/devplat-backup.XXXXXX)
STARTED=$(date -u +%s)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE="devplat-${STAMP}.dump.gpg"

# Two runs at once would fight over the staging area and double the load on a
# database that is also serving traffic. flock makes a slow run skip the next
# tick rather than overlap it.
exec 9>/var/lock/devplat-backup.lock
flock -n 9 || { echo "backup: another run is still going; skipping"; exit 0; }

failure=""
cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT

# Reports the outcome to the control plane. Best-effort: a reporting outage
# must never turn a good backup into a failed one.
report() {
  local status=$1 detail=${2:-} bytes=${3:-0}
  [ -n "${BACKUP_REPORT_TOKEN:-}" ] && [ -n "${API_URL:-}" ] || return 0
  curl -fsS --max-time 15 -X POST "${API_URL}/internal/backup-report" \
    -H "Authorization: Bearer ${BACKUP_REPORT_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "$(printf '{"status":"%s","archive":"%s","bytes":%s,"durationSeconds":%s,"detail":"%s"}' \
          "$status" "$ARCHIVE" "$bytes" "$(( $(date -u +%s) - STARTED ))" "$detail")" \
    >/dev/null 2>&1 || echo "backup: could not report status (continuing)" >&2
}

fail() {
  failure=$1
  echo "backup: FAILED — $failure" >&2
  report failed "$failure"
  exit 1
}

echo "backup: dumping ${POSTGRES_DB} …"
# -Fc is Postgres's custom format: compressed, and restorable selectively or
# in parallel, unlike a plain SQL file. --no-owner/--no-privileges so the dump
# restores into a fresh cluster whose role names may differ.
docker compose -f "$COMPOSE_FILE" exec -T "$POSTGRES_SERVICE" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-privileges \
  > "$STAGING/dump" 2>"$STAGING/dump.err" || fail "pg_dump: $(tail -c 300 "$STAGING/dump.err" | tr '\n' ' ')"

# A pg_dump that fails partway can still exit 0 in a pipeline; an empty or
# absurdly small file is the tell. Refuse to upload it — a corrupt backup that
# overwrites nothing is fine, but one you believe in is worse than none.
size=$(stat -c%s "$STAGING/dump")
[ "$size" -gt 4096 ] || fail "dump is only ${size} bytes — refusing to upload"
echo "backup: dump is $(( size / 1024 )) KiB"

echo "backup: encrypting …"
# Symmetric AES-256. gpg rather than rclone's crypt remote deliberately: the
# result is a self-contained file you can decrypt with nothing but gpg and the
# passphrase. In a real disaster, fewer moving parts between you and your data
# is worth more than encrypted filenames.
printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --quiet --yes \
  --passphrase-fd 0 --pinentry-mode loopback \
  --symmetric --cipher-algo AES256 --compress-algo none \
  --output "$STAGING/$ARCHIVE" "$STAGING/dump" || fail "gpg encryption failed"
# --compress-algo none because -Fc already compressed; double-compressing
# costs CPU on a live host and saves nothing.

enc_size=$(stat -c%s "$STAGING/$ARCHIVE")
(cd "$STAGING" && sha256sum "$ARCHIVE" > "$ARCHIVE.sha256")

echo "backup: uploading to ${RCLONE_REMOTE}:${RCLONE_PATH}/ …"
rclone copy "$STAGING/$ARCHIVE" "${RCLONE_REMOTE}:${RCLONE_PATH}/" \
  --no-traverse || fail "rclone upload failed"
rclone copy "$STAGING/$ARCHIVE.sha256" "${RCLONE_REMOTE}:${RCLONE_PATH}/" \
  --no-traverse || fail "rclone checksum upload failed"

# Read it back and compare. An upload that reported success but landed
# truncated is exactly the failure mode a backup must not have, and this is
# cheap insurance against it.
echo "backup: verifying the uploaded copy …"
rclone check "$STAGING/$ARCHIVE" "${RCLONE_REMOTE}:${RCLONE_PATH}/" \
  --checksum --one-way --no-traverse >/dev/null 2>&1 \
  || fail "uploaded archive does not match the local one"

echo "backup: pruning archives older than ${RETENTION_DAYS} days …"
# Explicit age-based deletion — see the warning at the top about `sync`.
# A failure here is worth knowing about but must not mark the backup failed:
# the dump is safely uploaded, which is the part that matters.
rclone delete "${RCLONE_REMOTE}:${RCLONE_PATH}/" --min-age "${RETENTION_DAYS}d" \
  || echo "backup: prune failed (the upload itself succeeded)" >&2

echo "backup: OK — ${ARCHIVE} ($(( enc_size / 1024 )) KiB) in $(( $(date -u +%s) - STARTED ))s"
report ok "" "$enc_size"
