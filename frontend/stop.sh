#!/usr/bin/env bash
# 프론트엔드 dev 서버 종료 (macOS/Linux).
cd "$(dirname "$0")"

PID_FILE=.frontend.pid

if [ ! -f "$PID_FILE" ]; then
  echo "[frontend] 실행 중인 프로세스를 찾지 못했습니다 (.frontend.pid 없음)."
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "[frontend] 종료 신호를 보냈습니다 (PID $PID)."
  for _ in 1 2 3; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null || true
  fi
  echo "[frontend] 종료되었습니다."
else
  echo "[frontend] PID $PID 프로세스가 이미 종료되어 있습니다."
fi
rm -f "$PID_FILE"
