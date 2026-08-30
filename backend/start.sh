#!/usr/bin/env bash
# 백엔드 서버 시작 (macOS/Linux). 이미 떠 있으면 그대로 두고 안내만 한다.
# PID는 .backend.pid에 남긴다 — stop.sh가 이 파일로 정확히 같은 프로세스를 종료한다.
set -euo pipefail
cd "$(dirname "$0")"

PID_FILE=.backend.pid
LOG_FILE=logs/backend.log

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[backend] 이미 실행 중입니다 (PID $(cat "$PID_FILE")) — 로그: $LOG_FILE"
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "[backend] node_modules가 없어 npm install을 실행합니다."
  npm install
fi

# .env 부트스트랩 (없으면 .env.example로 생성) — npm run dev와 같은 로직, 동기로 먼저 끝낸다.
node scripts/ensure-env.js

mkdir -p logs
# npm start가 아니라 서버 스크립트를 직접 실행한다 — npm 래퍼를 거치면 $!가 npm 프로세스가 되어,
# stop.sh가 npm만 죽이고 실제 서버(node src/server.js)는 남는 경우가 있다.
nohup node src/server.js > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

sleep 1
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[backend] 시작됨 (PID $(cat "$PID_FILE")) — 접속 주소는 로그에서 확인: $LOG_FILE"
else
  echo "[backend] 시작 실패 — 로그를 확인하세요: $LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
