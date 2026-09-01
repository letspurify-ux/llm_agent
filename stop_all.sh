#!/usr/bin/env bash
# 로컬 개발 스택 전체 중지 (macOS/Linux) — start_all.sh의 역순.
#
# 순서가 역순이어야 하는 이유: 백엔드가 관리 DB 커넥션을 쥔 채로 MariaDB를 내리면 문장
# 도중에 소켓이 끊겨 MariaDB 에러 로그에 'Aborted connection … Got an error reading
# communication packets'가 쌓인다. 백엔드의 SIGTERM 경로가 풀을 정리하고 나갈 시간을 준다
# (backend/src/server.js shutdown).
#
# 앱은 각 디렉터리의 stop.sh를 부른다 — PID 파일과 '우리 프로세스인가' 판정이 그쪽에 있고,
# 여기서 다시 kill을 짜면 그 판정이 두 벌이 되어 한쪽만 고쳐질 때 엉뚱한 프로세스를 죽인다.
set -uo pipefail
cd "$(dirname "$0")"

APPS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    -a|--apps-only) APPS_ONLY=1 ;;
    -h|--help)
      echo "사용법: $0 [--apps-only]"
      echo "  (기본)         백엔드·프론트엔드를 내린 뒤 MariaDB·Oracle·Ollama도 내린다"
      echo "  --apps-only    인프라는 그대로 두고 백엔드·프론트엔드만 내린다"
      exit 0 ;;
    *) echo "알 수 없는 인자: $arg (--help 참고)"; exit 2 ;;
  esac
done

ORACLE_CONTAINER=${ORACLE_CONTAINER:-oracle1521}

ok()   { echo "  [O] $*"; }
skip() { echo "  [-] $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "== 앱 =="
./frontend/stop.sh
./backend/stop.sh

if [ "$APPS_ONLY" -eq 1 ]; then
  echo
  echo "인프라는 그대로 두었다 (--apps-only)."
  exit 0
fi

echo
echo "== 인프라 =="
# 인프라는 이 저장소만 쓰는 것이 아닐 수 있다 — 다른 프로젝트가 같은 MariaDB나 Ollama를
# 쓰고 있으면 여기서 내리는 것이 뜻밖의 결과가 된다. 그래서 무엇을 내리는지 한 줄씩 밝히고,
# 앱만 내리고 싶을 때를 위해 --apps-only를 둔다.

if have brew && brew services list 2>/dev/null | grep -qE '^mariadb\s+started'; then
  brew services stop mariadb >/dev/null 2>&1 && ok "MariaDB 정지" || skip "MariaDB 정지 실패"
else
  skip "MariaDB 실행 중이 아님"
fi

if have docker && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$ORACLE_CONTAINER"; then
  # stop은 SIGTERM 뒤 유예를 준다 — 컨테이너 안에서 인스턴스가 정상 종료(shutdown immediate)할
  # 시간을 주지 않으면 다음 기동이 인스턴스 복구부터 시작해 훨씬 오래 걸린다.
  docker stop "$ORACLE_CONTAINER" >/dev/null 2>&1 && ok "Oracle 정지 ($ORACLE_CONTAINER)" || skip "Oracle 정지 실패"
else
  skip "Oracle 실행 중이 아님"
fi

if have brew && brew services list 2>/dev/null | grep -qE '^ollama\s+started'; then
  brew services stop ollama >/dev/null 2>&1 && ok "Ollama 정지" || skip "Ollama 정지 실패"
elif curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  # brew로 띄운 것이 아니면(트레이 앱·수동 serve·도커) 우리가 띄운 프로세스가 아닐 수 있다.
  # 남의 프로세스를 죽이지 않고 알리기만 한다.
  skip "Ollama가 brew 서비스가 아니다 — 직접 내릴 것 (11434 응답 중)"
else
  skip "Ollama 실행 중이 아님"
fi
