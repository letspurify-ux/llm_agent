#!/usr/bin/env bash
# 프론트엔드 dev 서버 시작 (macOS/Linux). 기본 포트(5173)가 사용 중이면 vite가 자동으로
# 다음 포트를 쓴다 — 실제 배정된 포트는 로그에서 확인한다.
set -euo pipefail
cd "$(dirname "$0")"

PID_FILE=.frontend.pid
LOG_FILE=logs/frontend.log

# PID 파일의 프로세스가 '우리 vite'인지 명령행으로 확인한다 — kill -0(생존 여부)만으로 판정하면
# vite가 죽고 남은 stale PID를 무관한 프로세스가 재사용했을 때 "이미 실행 중"으로 오판하고,
# stop.sh는 같은 판정으로 그 무관한 프로세스를 강제 종료(-9)까지 한다. 판정 기준을 두 스크립트가
# 공유해야 하므로 문구를 바꾸면 stop.sh도 함께 바꿀 것.
is_ours() { [ -n "${1:-}" ] && ps -p "$1" -o command= 2>/dev/null | grep -q "vite/bin/vite.js"; }

if [ -f "$PID_FILE" ] && is_ours "$(cat "$PID_FILE")"; then
  echo "[frontend] 이미 실행 중입니다 (PID $(cat "$PID_FILE")) — 로그: $LOG_FILE"
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "[frontend] node_modules가 없어 npm install을 실행합니다."
  npm install
fi

mkdir -p logs
# 로그는 덮어쓰지 않고 이어 쓴다 — 덮어쓰면 재기동 순간 직전 실행의 크래시 원인이 사라진다.
# 회차는 시작 구분선으로 가른다.
echo "===== $(date '+%Y-%m-%d %H:%M:%S') 시작 =====" >> "$LOG_FILE"
# npm run dev가 아니라 vite를 직접 실행한다 — npm 래퍼를 거치면 $!가 npm 프로세스가 되어,
# stop.sh가 npm만 죽이고 실제 vite 프로세스는 남는 경우가 있다.
nohup node node_modules/vite/bin/vite.js >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

sleep 1
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[frontend] 시작됨 (PID $(cat "$PID_FILE")) — 접속 주소는 로그에서 확인: $LOG_FILE"
else
  echo "[frontend] 시작 실패 — 로그를 확인하세요: $LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
