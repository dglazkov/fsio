#!/usr/bin/env bash
# Dev loop for the web workbench: fresh host on ~/fsio-demo + static server.
#
#   scripts/dev.sh          # kill stale processes, wipe .fsio, start both
#
# Then open http://localhost:8765/web/ and pick ~/fsio-demo.
# Ctrl-C stops both. Logs are prefixed [host] / [serve].
set -euo pipefail

cd "$(dirname "$0")/.."
DIR="${FSIO_DIR:-$HOME/fsio-demo}"
PORT="${FSIO_PORT:-8765}"

# ---- stop stale instances (previous dev runs), clear old sessions
pkill -f "host/fsio-host.js" 2>/dev/null && echo "stopped stale host" || true
pkill -f "host/serve.js" 2>/dev/null && echo "stopped stale server" || true
sleep 0.2
mkdir -p "$DIR"

# ---- start both; die together
cleanup() {
  kill "$HOST_PID" "$SERVE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --fresh wipes .fsio (old sessions, stale host.json) on startup
node host/fsio-host.js "$DIR" --fresh --allow-shell 2>&1 | sed 's/^/[host]  /' &
HOST_PID=$!
node host/serve.js "$PORT" 2>&1 | sed 's/^/[serve] /' &
SERVE_PID=$!

sleep 0.5
echo
echo "workbench:  http://localhost:$PORT/web/"
echo "pick:       $DIR"
echo
wait
