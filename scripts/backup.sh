#!/usr/bin/env bash
# Save a full copy of Family Hub's data (profiles, tags, ratings, history).
# Usage: scripts/backup.sh [destination folder]
# The book files themselves are not included; back up the library separately.
set -euo pipefail
cd "$(dirname "$0")/.."

STACK_DIR="${STACK_DIR:-./stack}"
if [ -f .env ]; then
  value=$(grep -E '^STACK_DIR=' .env | tail -n1 | cut -d= -f2- || true)
  [ -n "${value:-}" ] && STACK_DIR="$value"
fi
DEST="${1:-./backups}"
mkdir -p "$DEST"
STAMP=$(date +%Y-%m-%d-%H%M)
OUT="$DEST/bookhub-data-$STAMP.tar.gz"

if [ ! -d "$STACK_DIR/bookhub" ]; then
  echo "No Family Hub data found at $STACK_DIR/bookhub" >&2
  exit 1
fi
tar -czf "$OUT" -C "$STACK_DIR" bookhub
echo "Saved $OUT"
