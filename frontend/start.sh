#!/usr/bin/env bash
# Start the frontend dev server (macOS/Linux). If the default port (5173) is taken,
# vite automatically picks the next one — check the log for the actual assigned port.
set -euo pipefail
cd "$(dirname "$0")"

PID_FILE=.frontend.pid
LOG_FILE=logs/frontend.log

# Verify that the process in the PID file is really *our vite* by checking its command line —
# judging by kill -0 (liveness) alone, a stale PID reused by an unrelated process makes this
# script misreport "already running", and stop.sh would even force-kill (-9) that process.
# The two scripts must share this check — if you change the pattern, change stop.sh too.
is_ours() { [ -n "${1:-}" ] && ps -p "$1" -o command= 2>/dev/null | grep -q "vite/bin/vite.js"; }

if [ -f "$PID_FILE" ] && is_ours "$(cat "$PID_FILE")"; then
  echo "[frontend] already running (PID $(cat "$PID_FILE")) — log: $LOG_FILE"
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "[frontend] node_modules not found — running npm install."
  npm install
fi

mkdir -p logs
# Append to the log instead of overwriting — overwriting on restart erases the crash cause
# of the previous run. Runs are separated by a start marker line.
echo "===== $(date '+%Y-%m-%d %H:%M:%S') start =====" >> "$LOG_FILE"
# Run vite directly instead of npm run dev — through the npm wrapper, $! would be
# the npm process, and stop.sh could end up killing only npm while the actual vite
# process keeps running.
nohup node node_modules/vite/bin/vite.js >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

sleep 1
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[frontend] started (PID $(cat "$PID_FILE")) — see the log for the URL: $LOG_FILE"
else
  echo "[frontend] failed to start — check the log: $LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
