#!/usr/bin/env bash
# Stop the frontend dev server (macOS/Linux).
cd "$(dirname "$0")"

PID_FILE=.frontend.pid

# Same check as start.sh — a live PID alone does not prove it is *our vite*.
# Killing without this check would hit an unrelated process that reused a stale PID, with -9 at worst.
is_ours() { [ -n "${1:-}" ] && ps -p "$1" -o command= 2>/dev/null | grep -q "vite/bin/vite.js"; }

if [ ! -f "$PID_FILE" ]; then
  echo "[frontend] no running process found (.frontend.pid missing)."
  exit 0
fi

PID=$(cat "$PID_FILE")
if is_ours "$PID"; then
  kill "$PID"
  echo "[frontend] sent termination signal (PID $PID)."
  for _ in 1 2 3; do
    is_ours "$PID" || break
    sleep 1
  done
  if is_ours "$PID"; then
    kill -9 "$PID" 2>/dev/null || true
  fi
  echo "[frontend] stopped."
else
  echo "[frontend] PID $PID is already gone (or the PID was reused by an unrelated process, so it is left untouched)."
fi
rm -f "$PID_FILE"
