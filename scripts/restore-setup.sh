#!/usr/bin/env bash
# Unpack a Family Hub setup file (Admin, Hub, Setup file) into this folder.
# Needs only Docker. Asks for the passphrase. An existing .env is kept as .env.before-restore.
# Usage: scripts/restore-setup.sh family-hub-setup-2026-10-25.zip
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -ne 1 ] || [ ! -f "$1" ]; then
  echo "Usage: scripts/restore-setup.sh SETUP-FILE   (the file must be inside this folder)"
  exit 2
fi
case "$(cd "$(dirname "$1")" && pwd)/" in
  "$(pwd)/"*) ;;
  *) echo "Move the setup file into $(pwd) first."; exit 2 ;;
esac
FILE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
REL="${FILE#"$(pwd)/"}"

docker build -q -t family-hub-restore . >/dev/null
docker run --rm -it --user "$(id -u):$(id -g)" -v "$(pwd):/restore" family-hub-restore \
  python -m bookhub.setupfile restore "/restore/$REL" /restore
