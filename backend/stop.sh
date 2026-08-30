#!/usr/bin/env bash
# 백엔드 서버 종료 (macOS/Linux). SIGTERM으로 server.js의 정상 종료 경로(커넥션 풀 정리 등)를 태운다.
cd "$(dirname "$0")"

PID_FILE=.backend.pid

# start.sh와 같은 판정 — PID가 살아 있다는 것만으로는 '우리 서버'라는 보장이 없다.
# stale PID를 무관한 프로세스가 재사용한 상태에서 확인 없이 죽이면 그 프로세스가 -9까지 맞는다.
is_ours() { [ -n "${1:-}" ] && ps -p "$1" -o command= 2>/dev/null | grep -q "src/server.js"; }

if [ ! -f "$PID_FILE" ]; then
  echo "[backend] 실행 중인 프로세스를 찾지 못했습니다 (.backend.pid 없음)."
  exit 0
fi

PID=$(cat "$PID_FILE")
if is_ours "$PID"; then
  kill "$PID"
  echo "[backend] 종료 신호를 보냈습니다 (PID $PID)."
  # server.js 자체에 10초짜리 강제 종료 타이머가 있다 — 그보다 조금 더 기다린 뒤에만 여기서 강제 종료한다.
  for _ in $(seq 1 12); do
    is_ours "$PID" || break
    sleep 1
  done
  if is_ours "$PID"; then
    echo "[backend] 정상 종료되지 않아 강제 종료합니다."
    kill -9 "$PID" 2>/dev/null || true
  else
    echo "[backend] 종료되었습니다."
  fi
else
  echo "[backend] PID $PID 프로세스가 이미 종료되어 있습니다 (또는 무관한 프로세스가 그 PID를 재사용 중이라 건드리지 않습니다)."
fi
rm -f "$PID_FILE"
