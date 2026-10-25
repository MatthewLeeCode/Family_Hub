#!/usr/bin/env bash
# Try Family Hub with a small sample library. Needs Python 3.10 or newer.
set -euo pipefail
cd "$(dirname "$0")/.."

PY=python3
command -v "$PY" >/dev/null 2>&1 || PY=python
if [ ! -d .venv ]; then
  "$PY" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate 2>/dev/null || source .venv/Scripts/activate
pip install --quiet -r app/requirements.txt
cd app
exec python -m bookhub --demo --demo-dir ../demo "$@"
