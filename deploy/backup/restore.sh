#!/usr/bin/env bash
#
# Restore (or verify) a Postgres backup made by backup.sh.
#
#   ./restore.sh --list                 what's on the remote
#   ./restore.sh --verify               restore the newest into a throwaway
#                                       database and check it, changing nothing
#   ./restore.sh --into devplat_copy devplat-20260728T020000Z.dump.gpg
#   ./restore.sh --production           overwrite the live database (asks first)
#
# --verify is the one worth putting in cron. An untested backup is a belief,
# not a backup, and the usual way people find out is at the worst moment.
set -euo pipefail

usage() { sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# Arguments are parsed before the config is loaded, so `--help` works on a
# machine that has no backup.env yet — which is exactly the machine someone
# reads the help on.
MODE=""; TARGET_DB=""; ARCHIVE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list)       MODE=list; shift ;;
    --verify)     MODE=verify; shift ;;
    --production) MODE=production; shift ;;
    --into)       MODE=into; TARGET_DB=${2:?--into needs a database name}; shift 2 ;;
    -h|--help)    usage 0 ;;
    -*)           echo "restore: unknown option $1" >&2; usage 1 ;;
    *)            ARCHIVE=$1; shift ;;
  esac
done
[ -n "$MODE" ] || usage 1

CONFIG=${BACKUP_ENV:-/opt/devplat/backup.env}
[ -r "$CONFIG" ] || { echo "restore: cannot read $CONFIG" >&2; exit 1; }
# shellcheck source=/dev/null
set -a; . "$CONFIG"; set +a

: "${RCLONE_REMOTE:?not set in $CONFIG}"
: "${RCLONE_PATH:?not set in $CONFIG}"
: "${BACKUP_PASSPHRASE:?not set in $CONFIG}"

COMPOSE_FILE=${COMPOSE_FILE:-/opt/devplat/docker-compose.yml}
POSTGRES_SERVICE=${POSTGRES_SERVICE:-postgres}
POSTGRES_USER=${POSTGRES_USER:-devplat}
POSTGRES_DB=${POSTGRES_DB:-devplat}
REMOTE="${RCLONE_REMOTE}:${RCLONE_PATH}"

psql_in_container() {
  docker compose -f "$COMPOSE_FILE" exec -T "$POSTGRES_SERVICE" \
    psql -U "$POSTGRES_USER" -v ON_ERROR_STOP=1 "$@"
}

if [ "$MODE" = list ]; then
  # Newest last, so the tail of the output is what you probably want.
  rclone lsl "$REMOTE/" --include '*.dump.gpg' | sort -k2
  exit 0
fi

# Default to the newest archive on the remote when none was named.
if [ -z "$ARCHIVE" ]; then
  ARCHIVE=$(rclone lsf "$REMOTE/" --include '*.dump.gpg' | sort | tail -1)
  [ -n "$ARCHIVE" ] || { echo "restore: no backups found at $REMOTE" >&2; exit 1; }
  echo "restore: using the newest archive, $ARCHIVE"
fi

STAGING=$(mktemp -d /var/tmp/devplat-restore.XXXXXX)
trap 'rm -rf "$STAGING"' EXIT

echo "restore: downloading $ARCHIVE …"
rclone copy "$REMOTE/$ARCHIVE" "$STAGING/" --no-traverse
# The checksum is uploaded alongside; use it if it's there, but don't fail on
# an older archive that predates it.
if rclone copy "$REMOTE/$ARCHIVE.sha256" "$STAGING/" --no-traverse 2>/dev/null; then
  (cd "$STAGING" && sha256sum -c "$ARCHIVE.sha256") || { echo "restore: CHECKSUM MISMATCH" >&2; exit 1; }
  echo "restore: checksum ok"
fi

echo "restore: decrypting …"
printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --quiet --yes \
  --passphrase-fd 0 --pinentry-mode loopback \
  --decrypt --output "$STAGING/dump" "$STAGING/$ARCHIVE"

# pg_restore reads the dump from stdin inside the container.
restore_into() {
  local db=$1
  echo "restore: loading into database \"$db\" …"
  docker compose -f "$COMPOSE_FILE" exec -T "$POSTGRES_SERVICE" \
    pg_restore -U "$POSTGRES_USER" -d "$db" --no-owner --no-privileges --clean --if-exists \
    < "$STAGING/dump"
}

case "$MODE" in
  verify)
    # Restore into a scratch database, prove the data is really there, then
    # drop it. Nothing else is touched — safe to run against production nightly.
    SCRATCH="devplat_verify_$(date -u +%Y%m%d%H%M%S)"
    echo "restore: verifying into throwaway database $SCRATCH"
    psql_in_container -d postgres -c "CREATE DATABASE \"$SCRATCH\"" >/dev/null
    # shellcheck disable=SC2064
    trap "docker compose -f '$COMPOSE_FILE' exec -T '$POSTGRES_SERVICE' psql -U '$POSTGRES_USER' -d postgres -c 'DROP DATABASE IF EXISTS \"$SCRATCH\"' >/dev/null 2>&1; rm -rf '$STAGING'" EXIT

    restore_into "$SCRATCH" >/dev/null

    # A structurally valid but empty dump would restore without error, so
    # check for actual content: the tables must exist and users must be there.
    tables=$(psql_in_container -d "$SCRATCH" -tAc \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
    users=$(psql_in_container -d "$SCRATCH" -tAc "SELECT count(*) FROM users")
    migrations=$(psql_in_container -d "$SCRATCH" -tAc "SELECT count(*) FROM schema_migrations")
    echo "restore: verified — $tables tables, $users users, $migrations migrations applied"
    [ "$tables" -ge 10 ] || { echo "restore: only $tables tables — that is not a full backup" >&2; exit 1; }
    [ "$migrations" -ge 1 ] || { echo "restore: no migration ledger in the dump" >&2; exit 1; }
    echo "restore: VERIFY OK ($ARCHIVE is restorable)"
    ;;

  into)
    psql_in_container -d postgres -c "CREATE DATABASE \"$TARGET_DB\"" >/dev/null 2>&1 || true
    restore_into "$TARGET_DB"
    echo "restore: done — $ARCHIVE is now in \"$TARGET_DB\""
    ;;

  production)
    cat <<WARN

  This overwrites the LIVE database "$POSTGRES_DB" with $ARCHIVE.
  Everything written since that dump will be gone.

  Stop the API first so it can't write during the restore:
      docker compose -f $COMPOSE_FILE stop api

WARN
    read -r -p 'Type the database name to confirm: ' confirm
    [ "$confirm" = "$POSTGRES_DB" ] || { echo "restore: aborted"; exit 1; }
    restore_into "$POSTGRES_DB"
    echo "restore: done. Start the API again: docker compose -f $COMPOSE_FILE start api"
    ;;
esac
