#!/usr/bin/env bash
set -euo pipefail

VAULT="${NANOCLAW_OBSIDIAN_VAULT:-/srv/obsidian}"
MNEMON="${MNEMON_DATA_DIR:-/srv/mnemon}"
BACKUPS="${NANOCLAW_KNOWLEDGE_BACKUPS:-/srv/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUPS/knowledge-$STAMP"

mkdir -p "$DEST"

if [ -d "$VAULT" ]; then
  tar -C "$(dirname "$VAULT")" -czf "$DEST/obsidian.tar.gz" "$(basename "$VAULT")"
fi

if [ -d "$MNEMON" ]; then
  tar -C "$(dirname "$MNEMON")" -czf "$DEST/mnemon.tar.gz" "$(basename "$MNEMON")"
fi

echo "$DEST"
