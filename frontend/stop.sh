#!/usr/bin/env bash
# 프론트엔드 dev 서버 종료 (macOS/Linux).
cd "$(dirname "$0")"

PID_FILE=.frontend.pid

# start.sh와 같은 판정 — PID가 살아 있다는 것만으로는 '우리 vite'라는 보장이 없다.
# stale PID를 무관한 프로세스가 재사용한 상태에서 확인 없이 죽이면 그 프로세스가 -9까지 맞는다.
is_ours() { [ -n "${1:-}" ] && ps -p "$1" -o command= 2>/dev/null | grep -q "vite/bin/vite.js"; }

if [ ! -f "$PID_FILE" ]; then
  echo "[frontend] 실행 중인 프로세스를 찾지 못했습니다 (.frontend.pid 없음)."
  exit 0
fi

PID=$(cat "$PID_FILE")
if is_ours "$PID"; then
  kill "$PID"
  echo "[frontend] 종료 신호를 보냈습니다 (PID $PID)."
  for _ in 1 2 3; do
    is_ours "$PID" || break
    sleep 1
  done
  if is_ours "$PID"; then
    kill -9 "$PID" 2>/dev/null || true
  fi
  echo "[frontend] 종료되었습니다."
else
  echo "[frontend] PID $PID 프로세스가 이미 종료되어 있습니다 (또는 무관한 프로세스가 그 PID를 재사용 중이라 건드리지 않습니다)."
fi
rm -f "$PID_FILE"
