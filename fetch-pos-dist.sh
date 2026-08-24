#!/bin/bash
# fetch-pos-dist.sh — populate ./pos-dist with the POS build (local fallback).
# Run by 'npm run build', which the controller installer already calls.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/pos-dist"
SRC="${POS_DIST_URL:-}"

mkdir -p "$DEST"

if [ -z "$SRC" ]; then
  echo "pos-dist: POS_DIST_URL is not set — skipping the local POS fallback."
  echo "pos-dist: lanes will boot the cloud POS, which is the normal path."
  exit 0
fi

echo "pos-dist: fetching from $SRC"
TMP="$(mktemp -d)"
if ! curl -fsSL --max-time 180 "$SRC" -o "$TMP/pos-dist.tar.gz"; then
  echo "pos-dist: download FAILED — leaving the existing fallback in place." >&2
  rm -rf "$TMP"
  exit 0
fi

if tar tzf "$TMP/pos-dist.tar.gz" >/dev/null 2>&1; then
  rm -rf "$DEST"
  mkdir -p "$DEST"
  tar xzf "$TMP/pos-dist.tar.gz" -C "$DEST" --strip-components=1 2>/dev/null \
    || tar xzf "$TMP/pos-dist.tar.gz" -C "$DEST"
  echo "pos-dist: installed $(find "$DEST" -type f | wc -l) files."
else
  echo "pos-dist: the download was not a gzipped tar — ignoring it." >&2
fi
rm -rf "$TMP"

if [ ! -f "$DEST/index.html" ]; then
  echo "pos-dist: no index.html present — the relay will report 'POS build not deployed'."
fi
exit 0
