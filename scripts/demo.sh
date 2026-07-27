#!/usr/bin/env bash
# Dev loop for the /terminal demo (#16): terminal-demo helper on a working
# folder + the demo page on vite. The production flow replaces this with
# `npx github:dglazkov/fsio#terminal-demo` (S5) + the Cloud Run page (S6).
#
#   scripts/demo.sh [dir]     # default: ~/fsio-demo (never /tmp — F9)
#
# Then open http://localhost:8766/ and pick the folder.
# Ctrl-C stops both. Logs are prefixed [helper] / [demo].
set -euo pipefail

cd "$(dirname "$0")/.."
DIR="${1:-${FSIO_DIR:-$HOME/fsio-demo}}"
PORT="${FSIO_DEMO_PORT:-8766}"

pkill -f "terminal-demo/dist/helper.js" 2>/dev/null && echo "stopped stale helper" || true
lsof -ti "tcp:$PORT" 2>/dev/null | xargs kill 2>/dev/null && echo "stopped stale demo server" || true
sleep 0.2
mkdir -p "$DIR"

cleanup() {
  kill "$HELPER_PID" "$WEB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

npm run build
node packages/terminal-demo/dist/helper.js "$DIR" 2>&1 | sed 's/^/[helper] /' &
HELPER_PID=$!
(cd packages/terminal-demo && npx vite --port "$PORT" --strictPort 2>&1 | sed 's/^/[demo]   /') &
WEB_PID=$!

sleep 0.5
echo
echo "demo page:  http://localhost:$PORT/"
echo "pick:       $DIR"
echo
wait
