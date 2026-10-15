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

# The binary carries the screen (build.rs embeds ../frontend/dist), so the screen is built
# first: when it is missing or older than a frontend source file. A machine without npm keeps
# the dist it has (or a prebuilt binary).
UI=../frontend
UI_SOURCES=("$UI/src" "$UI/index.html" "$UI/package.json" "$UI/vite.config.js" "$UI/mermaid-math-adapter.mjs")
if [ ! -f "$UI/dist/index.html" ] || [ -n "$(find "${UI_SOURCES[@]}" -newer "$UI/dist/index.html" -print -quit 2>/dev/null)" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "[backend] building the screen (npm run build in frontend)..."
    [ -d "$UI/node_modules" ] || (cd "$UI" && npm ci)
    (cd "$UI" && npm run build)
  elif [ ! -f "$UI/dist/index.html" ] && [ ! -x "$BINARY" ]; then
    echo "[backend] frontend/dist not found and npm is not installed — install Node.js or copy a prebuilt binary to $BINARY."
    exit 1
  fi
fi

# Build when the binary is missing or older than a source file or the built screen. A machine
# without the Rust toolchain needs a prebuilt binary at target/release/llm-agent.
if [ ! -x "$BINARY" ] || [ -n "$(find src Cargo.toml build.rs "$UI/dist/index.html" -newer "$BINARY" -print -quit 2>/dev/null)" ]; then
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
  echo "[backend] started (PID $(cat "$PID_FILE")) — the screen and the API share its address (see the log): $LOG_FILE"
  if [ "$FRESH" -eq 1 ]; then
    echo "[backend] config.toml did not exist — the server creates it from .env (if any); finish the settings in the admin screen's 설정 tab."
  fi
else
  echo "[backend] failed to start — check the log: $LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
