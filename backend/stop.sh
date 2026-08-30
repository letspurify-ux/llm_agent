#!/usr/bin/env bash
# Stop the backend server (macOS/Linux). SIGTERM triggers the graceful-shutdown path
# in server.js (connection pool cleanup, etc.).
cd "$(dirname "$0")"

PID_FILE=.backend.pid

# Same check as start.sh — a live PID alone does not prove it is *our server*.
# Killing without this check would hit an unrelated process that reused a stale PID, with -9 at worst.
is_ours() { [ -n "${1:-}" ] && ps -p "$1" -o command= 2>/dev/null | grep -q "src/server.js"; }

if [ ! -f "$PID_FILE" ]; then
  echo "[backend] no running process found (.backend.pid missing)."
  exit 0
fi

PID=$(cat "$PID_FILE")
if is_ours "$PID"; then
  kill "$PID"
  echo "[backend] sent termination signal (PID $PID)."
  # server.js has its own 10-second force-exit timer — wait slightly longer than that
  # before force-killing from here.
  for _ in $(seq 1 12); do
    is_ours "$PID" || break
    sleep 1
  done
  if is_ours "$PID"; then
    echo "[backend] did not exit gracefully — force killing."
    kill -9 "$PID" 2>/dev/null || true
  else
    echo "[backend] stopped."
  fi
else
  echo "[backend] PID $PID is already gone (or the PID was reused by an unrelated process, so it is left untouched)."
fi
rm -f "$PID_FILE"
