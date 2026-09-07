#!/usr/bin/env bash
# Start the backend server (macOS/Linux). If it is already running, leave it as is.
# The PID is kept in .backend.pid — stop.sh uses this file to kill exactly the same process.
set -euo pipefail
cd "$(dirname "$0")"

PID_FILE=.backend.pid
LOG_FILE=logs/backend.log

# Verify the Node entry point and this checkout's working directory.
source ./process.sh

if [ -f "$PID_FILE" ] && is_ours "$(cat "$PID_FILE")"; then
  echo "[backend] already running (PID $(cat "$PID_FILE")) — log: $LOG_FILE"
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "[backend] node_modules not found — running npm install."
  npm install
fi

# Bootstrap .env (created from .env.example if missing) — same logic as npm run dev, done synchronously first.
node scripts/ensure-env.js

mkdir -p logs
# The wrapper captures both output streams and forwards shutdown signals.
# stop.sh tracks the wrapper PID; it waits for the application to exit.
APP_LOG_FILE="$LOG_FILE" APP_LOG_STOP_MS=11000 nohup node ../scripts/logged-process.cjs src/server.js >/dev/null 2>&1 &
echo $! > "$PID_FILE"

sleep 1
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[backend] started (PID $(cat "$PID_FILE")) — see the log for the listen address: $LOG_FILE"
else
  echo "[backend] failed to start — check the log: $LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
