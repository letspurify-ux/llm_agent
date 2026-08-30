#!/usr/bin/env bash
# Start the backend server (macOS/Linux). If it is already running, leave it as is.
# The PID is kept in .backend.pid — stop.sh uses this file to kill exactly the same process.
set -euo pipefail
cd "$(dirname "$0")"

PID_FILE=.backend.pid
LOG_FILE=logs/backend.log

# Verify that the process in the PID file is really *our server* by checking its command line —
# judging by kill -0 (liveness) alone, a stale PID reused by an unrelated process makes this
# script misreport "already running", and stop.sh would even force-kill (-9) that process.
# The two scripts must share this check — if you change the pattern, change stop.sh too.
is_ours() { [ -n "${1:-}" ] && ps -p "$1" -o command= 2>/dev/null | grep -q "src/server.js"; }

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
# Append to the log instead of overwriting — overwriting on restart erases the crash cause
# of the previous run. Runs are separated by a start marker line.
echo "===== $(date '+%Y-%m-%d %H:%M:%S') start =====" >> "$LOG_FILE"
# Run the server script directly instead of npm start — through the npm wrapper, $! would be
# the npm process, and stop.sh could end up killing only npm while the actual server
# (node src/server.js) keeps running.
nohup node src/server.js >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

sleep 1
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[backend] started (PID $(cat "$PID_FILE")) — see the log for the listen address: $LOG_FILE"
else
  echo "[backend] failed to start — check the log: $LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
