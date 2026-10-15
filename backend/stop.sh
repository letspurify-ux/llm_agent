#!/usr/bin/env bash
# Stop the backend server (macOS/Linux). SIGTERM triggers the server's graceful shutdown
# (in-flight answers finish, chat logs are written, connections close).
cd "$(dirname "$0")"

PID_FILE=.backend.pid

# Same ownership check as start.sh, including the checkout directory.
source ./process.sh

if [ ! -f "$PID_FILE" ]; then
  echo "[backend] no running process found (.backend.pid missing)."
  exit 0
fi

PID=$(cat "$PID_FILE")
if is_ours "$PID"; then
  kill "$PID"
  echo "[backend] sent termination signal (PID $PID)."
  # The wrapper force-kills the server 11 seconds after forwarding the signal — wait a
  # little longer than that before force-killing from here.
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
