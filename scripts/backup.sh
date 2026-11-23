#!/usr/bin/env bash
# Backs up the Voyago database with pg_dump (custom format, compressed) and prunes old backups.
#
#   DATABASE_URL=postgresql://... BACKUP_DIR=/var/backups/voyago scripts/backup.sh
#
# Env:
#   DATABASE_URL         required; the database to back up (read from the environment, never a file here)
#   BACKUP_DIR           where to write backups (default ./backups)
#   BACKUP_KEEP_DAYS     delete local backups older than this (default 14)
#   BACKUP_UPLOAD_CMD    optional command that copies a file off the machine; it is run once for the
#                        dump and once for its checksum, with the file path as its last argument
#                        (for example a small wrapper around your storage provider's CLI).
#                        Off-site, encrypted copies are required in production.
# See docs/OPERATIONS.md, "Backups".
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
# libpq does not understand Prisma's ?schema= parameter.
DB_URL="${DATABASE_URL%%\?*}"

mkdir -p "$BACKUP_DIR"
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/voyago-$stamp.dump"

pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$file.partial" "$DB_URL"
# A dump that cannot be listed is not a backup.
pg_restore --list "$file.partial" > /dev/null
mv "$file.partial" "$file"
sha256sum "$file" > "$file.sha256"
echo "Backup written: $file ($(du -h "$file" | cut -f1))"

if [[ -n "${BACKUP_UPLOAD_CMD:-}" ]]; then
  # shellcheck disable=SC2086
  $BACKUP_UPLOAD_CMD "$file"
  $BACKUP_UPLOAD_CMD "$file.sha256"
  echo "Copied off-site"
fi

find "$BACKUP_DIR" -name 'voyago-*.dump*' -type f -mtime +"$BACKUP_KEEP_DAYS" -print -delete
