#!/usr/bin/env bash
# sureflow-selfupdate.sh — runs ON the relay VM (systemd timer, nightly).
# Pulls the relay service files + POS build from the store's update source, applies
# them atomically, restarts the service and rolls back if the relay stops answering.
set -euo pipefail

RELAY_DIR=/opt/sureflow-relay
SRC="${UPDATE_SOURCE:-}"            # rsync/ssh source, e.g. build@buildhost:/srv/sureflow/current
PORT="${PORT:-3000}"
STAMP=$(date +%Y%m%d-%H%M%S)

[ -n "$SRC" ] || { echo "UPDATE_SOURCE is not set in $RELAY_DIR/.env"; exit 2; }

echo "==> snapshotting current install"
sudo cp -a "$RELAY_DIR" "$RELAY_DIR.bak-$STAMP"

echo "==> pulling update from $SRC"
sudo rsync -a --delete \
  --exclude '.env' --exclude 'relay.db' --exclude 'node_modules' --exclude '*.bak-*' \
  "$SRC/" "$RELAY_DIR/"

echo "==> installing dependencies"
cd "$RELAY_DIR" && sudo npm install --omit=dev

echo "==> restarting relay"
sudo systemctl restart sureflow-relay
sleep 5

CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/connectivity" || echo 000)
if [ "$CODE" != "200" ]; then
  echo "!! relay unhealthy after update (HTTP $CODE) — rolling back"
  sudo rsync -a --delete "$RELAY_DIR.bak-$STAMP/" "$RELAY_DIR/"
  sudo systemctl restart sureflow-relay
  exit 1
fi

echo "==> update ok, pruning old snapshots (keeping 3)"
ls -1dt "$RELAY_DIR".bak-* 2>/dev/null | tail -n +4 | xargs -r sudo rm -rf
echo "relay updated at $STAMP"
