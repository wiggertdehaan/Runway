#!/usr/bin/env bash
set -euo pipefail

# Back up the Runway SQLite database.
# Usage: ./scripts/backup-db.sh [backup-dir]
#
# Defaults to /data/backups inside the control container,
# or ./backups when run on the host.

BACKUP_DIR="${1:-${BACKUP_DIR:-./backups}}"
DB_PATH="${DB_PATH:-/data/runway.db}"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_FILE="$BACKUP_DIR/runway-$TIMESTAMP.db"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
  echo "Database not found at $DB_PATH"
  exit 1
fi

# Use SQLite's .backup command for a consistent snapshot
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Keep only the last 7 backups
ls -t "$BACKUP_DIR"/runway-*.db 2>/dev/null | tail -n +8 | xargs -r rm --

echo "Backup saved: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
