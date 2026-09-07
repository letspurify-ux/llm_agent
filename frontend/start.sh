#!/usr/bin/env bash
# Start the frontend dev server (macOS/Linux). If the default port (5173) is taken,
# vite automatically picks the next one — check the log for the actual assigned port.
set -euo pipefail
cd "$(dirname "$0")"

PID_FILE=.frontend.pid
LOG_FILE=logs/frontend.log

# Verify both the command and project directory, using the same check as stop.sh.
source ./process.sh

if [ -f "$PID_FILE" ] && is_ours "$(cat "$PID_FILE")"; then
  echo "[frontend] already running (PID $(cat "$PID_FILE")) — log: $LOG_FILE"
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "[frontend] node_modules not found — running npm install."
  npm install
fi

mkdir -p logs
# The wrapper captures both output streams and forwards shutdown signals.
# stop.sh tracks the wrapper PID; it waits for the application to exit.
APP_LOG_FILE="$LOG_FILE" APP_LOG_STOP_MS=2000 nohup node ../scripts/logged-process.cjs node_modules/vite/bin/vite.js >/dev/null 2>&1 &
echo $! > "$PID_FILE"

sleep 1
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[frontend] started (PID $(cat "$PID_FILE")) — see the log for the URL: $LOG_FILE"
else
  echo "[frontend] failed to start — check the log: $LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
