#!/usr/bin/env bash
# Restore drill: restores a backup into a new, empty scratch database, checks it, then drops it.
# It never touches the database the backup came from.
#
#   RESTORE_ADMIN_URL=postgresql://user:pass@host:5432/postgres scripts/restore-drill.sh backups/voyago-....dump
#
# Env:
#   RESTORE_ADMIN_URL   required; a connection to a maintenance database (e.g. /postgres) on a server
#                       where a scratch database may be created. Use a staging server, not production.
#   KEEP_DRILL_DB=1     keep the restored database for inspection instead of dropping it
# See docs/OPERATIONS.md, "Restore drills".
set -euo pipefail

file="${1:?Usage: restore-drill.sh <backup.dump>}"
: "${RESTORE_ADMIN_URL:?Set RESTORE_ADMIN_URL}"
admin="${RESTORE_ADMIN_URL%%\?*}"
[[ -f "$file" ]] || { echo "No such file: $file" >&2; exit 1; }
if [[ -f "$file.sha256" ]]; then
  sha256sum --check --quiet "$file.sha256"
  echo "Checksum OK"
fi

db="voyago_restore_drill_$(date -u +%Y%m%d%H%M%S)"
target="${admin%/*}/$db"
started=$(date +%s)

cleanup() {
  if [[ "${KEEP_DRILL_DB:-0}" != "1" ]]; then
    psql "$admin" -qc "DROP DATABASE IF EXISTS \"$db\"" > /dev/null
  else
    echo "Kept $db"
  fi
}
trap cleanup EXIT

psql "$admin" -qc "CREATE DATABASE \"$db\"" > /dev/null
# PostGIS must exist before the restore creates geography columns.
psql "$target" -qc 'CREATE EXTENSION IF NOT EXISTS postgis' > /dev/null
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$target" "$file" 2> >(grep -v 'already exists' >&2) || {
  echo "Restore failed" >&2
  exit 1
}

echo "Restored into $db in $(( $(date +%s) - started ))s. Sanity checks:"
psql "$target" -v ON_ERROR_STOP=1 -At <<'SQL'
SELECT 'migrations applied:   ' || count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;
SELECT 'failed migrations:    ' || count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;
SELECT 'users:                ' || count(*) FROM users;
SELECT 'trips:                ' || count(*) FROM trips;
SELECT 'bookings:             ' || count(*) FROM bookings;
SELECT 'payments:             ' || count(*) FROM payments;
SELECT 'ledger entries:       ' || count(*) FROM ledger_entries;
SELECT 'audit log entries:    ' || count(*) FROM audit_logs;
SELECT 'postgis:              ' || postgis_version();
SQL
failed=$(psql "$target" -At -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL")
if [[ "$failed" != "0" ]]; then
  echo "The backup holds a half-applied migration" >&2
  exit 1
fi
echo "Restore drill passed"
