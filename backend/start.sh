#!/usr/bin/env bash
# Start the backend server (macOS/Linux). If it is already running, leave it as is.
# The PID is kept in .backend.pid — stop.sh uses this file to stop exactly the same process.
set -euo pipefail
cd "$(dirname "$0")"

PID_FILE=.backend.pid
LOG_FILE=logs/backend.log

# Verify the binary path and this checkout's working directory.
source ./process.sh

if [ -f "$PID_FILE" ] && is_ours "$(cat "$PID_FILE")"; then
  echo "[backend] already running (PID $(cat "$PID_FILE")) — log: $LOG_FILE"
  exit 0
fi

# Build when the binary is missing or older than a source file. A machine without the Rust
# toolchain needs a prebuilt binary at target/release/llm-agent.
if [ ! -x "$BINARY" ] || [ -n "$(find src Cargo.toml -newer "$BINARY" -print -quit 2>/dev/null)" ]; then
  if command -v cargo >/dev/null 2>&1; then
    echo "[backend] building the release binary (cargo build --release)..."
    cargo build --release
  elif [ ! -x "$BINARY" ]; then
    echo "[backend] $BINARY not found and cargo is not installed — install Rust (https://rustup.rs) or copy a prebuilt binary there."
    exit 1
  fi
fi

FRESH=0
[ -f config.toml ] || FRESH=1

mkdir -p logs
# The wrapper captures both output streams and forwards shutdown signals.
# stop.sh tracks the wrapper PID; it waits for the server to exit.
APP_LOG_FILE="$LOG_FILE" APP_LOG_STOP_MS=11000 nohup node ../scripts/logged-process.cjs --exec "$BINARY" >/dev/null 2>&1 &
echo $! > "$PID_FILE"

sleep 1
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[backend] started (PID $(cat "$PID_FILE")) — see the log for the listen address: $LOG_FILE"
  if [ "$FRESH" -eq 1 ]; then
    echo "[backend] config.toml did not exist — the server creates it from .env (if any); finish the settings in the admin screen's 설정 tab."
  fi
else
  echo "[backend] failed to start — check the log: $LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
