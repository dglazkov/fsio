#!/usr/bin/env bash
# Dev loop for the workbench: fresh host on ~/fsio-demo + static server.
#
#   scripts/dev.sh          # kill stale processes, wipe .fsio, start both
#
# Then open http://localhost:8765/ and pick ~/fsio-demo.
# Ctrl-C stops both. Logs are prefixed [host] / [wb].
set -euo pipefail

cd "$(dirname "$0")/.."
DIR="${FSIO_DIR:-$HOME/fsio-demo}"
PORT="${FSIO_PORT:-8765}"

# ---- stop stale instances (previous dev runs), clear old sessions
pkill -f "host/dist/fsio-host.js" 2>/dev/null && echo "stopped stale host" || true
# vite's argv doesn't name the project; the port does (strictPort in config)
lsof -ti "tcp:$PORT" 2>/dev/null | xargs kill 2>/dev/null && echo "stopped stale workbench server" || true
sleep 0.2
mkdir -p "$DIR"

# ---- start both; die together
cleanup() {
  kill "$HOST_PID" "$WEB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --fresh wipes .fsio (old sessions, stale host.json) on startup
npm run build
node packages/host/dist/fsio-host.js "$DIR" --fresh --allow-shell 2>&1 | sed 's/^/[host] /' &
HOST_PID=$!
(cd packages/workbench && npx vite --port "$PORT" --strictPort 2>&1 | sed 's/^/[wb]   /') &
WEB_PID=$!

sleep 0.5
echo
echo "workbench:  http://localhost:$PORT/"
echo "pick:       $DIR"
echo
wait
