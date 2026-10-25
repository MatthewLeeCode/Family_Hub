#!/usr/bin/env bash
# Bundle a tested setup so it can be copied to the home server.
# Stops the containers first so nothing is half-written.
# The archive holds .env (every password) UNLOCKED. To pass the setup on safely, use
# Admin, Hub, Setup file instead (a locked zip, guide 7).
# Usage: scripts/pack-for-server.sh [--with-library]
set -euo pipefail
cd "$(dirname "$0")/.."

STACK_DIR="${STACK_DIR:-./stack}"
OUT="bookhub-move-$(date +%Y-%m-%d).tar.gz"
DATA_ROOT="${DATA_ROOT:-$STACK_DIR/data}"
# Films, TV and downloads stay behind: on the server DATA_ROOT points at the storage disk.
EXCLUDES=(--exclude="$STACK_DIR/downloads" --exclude="$DATA_ROOT" --exclude="$STACK_DIR/gluetun" --exclude="$STACK_DIR/jellyfin-config" --exclude="./demo" --exclude="./.venv" --exclude="./backups" --exclude="./bookhub-move-*.tar.gz")
if [ "${1:-}" != "--with-library" ]; then
  EXCLUDES+=(--exclude="$STACK_DIR/library")
  echo "Leaving the book files out. Copy your library folder separately, or rerun with --with-library."
fi

if command -v docker >/dev/null 2>&1; then
  docker compose --profile search --profile torrent --profile media --profile watch --profile series stop || true
fi
tar -czf "$OUT" "${EXCLUDES[@]}" .
echo "Created $OUT"
echo "Copy it to the server, unpack it, check .env, then run: docker compose --profile search --profile torrent --profile media up -d --build"
