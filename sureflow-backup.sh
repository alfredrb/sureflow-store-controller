#!/usr/bin/env bash
# sureflow-backup.sh — runs ON the relay VM (systemd timer, hourly).
# Backs up the local SQLite database and .env so a dead VM can be rebuilt without
# losing queued offline sales. Restore mode reverses it.
set -euo pipefail

RELAY_DIR=/opt/sureflow-relay
BACKUP_DIR="${BACKUP_DIR:-/var/backups/sureflow}"
DB="${DB_PATH:-$RELAY_DIR/relay.db}"
KEEP=48

mode="${1:-backup}"
sudo mkdir -p "$BACKUP_DIR"

if [ "$mode" = "backup" ]; then
  STAMP=$(date +%Y%m%d-%H%M%S)
  OUT="$BACKUP_DIR/relay-$STAMP"
  # sqlite3 .backup is safe on a live database; plain cp is not.
  if command -v sqlite3 >/dev/null; then
    sudo sqlite3 "$DB" ".backup '$OUT.db'"
  else
    sudo cp "$DB" "$OUT.db"
  fi
  sudo cp "$RELAY_DIR/.env" "$OUT.env"
  sudo chmod 600 "$OUT.env"
  sudo gzip -f "$OUT.db"
  ls -1t "$BACKUP_DIR"/relay-*.db.gz | tail -n +$((KEEP+1)) | xargs -r sudo rm -f
  echo "backup written: $OUT.db.gz"
  exit 0
fi

if [ "$mode" = "restore" ]; then
  FILE="${2:-$(ls -1t "$BACKUP_DIR"/relay-*.db.gz | head -1)}"
  [ -n "$FILE" ] || { echo "no backup found in $BACKUP_DIR"; exit 2; }
  echo "restoring $FILE"
  sudo systemctl stop sureflow-relay
  sudo cp "$DB" "$DB.pre-restore" 2>/dev/null || true
  sudo gunzip -c "$FILE" | sudo tee "$DB" > /dev/null
  sudo systemctl start sureflow-relay
  sleep 4
  curl -s http://localhost:${PORT:-3000}/api/pending
  echo "restore complete — queued sales above will upload on the next sync"
  exit 0
fi

echo "usage: sureflow-backup.sh [backup|restore <file.db.gz>]"
exit 2
