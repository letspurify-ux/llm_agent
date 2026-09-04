#!/usr/bin/env bash
# 로컬 개발 스택 전체 기동 (macOS/Linux) — 인프라 3종 + 백엔드/프론트엔드.
#
# 앱은 각 디렉터리의 start.sh를 부른다. 여기서 nohup·PID 파일을 다시 쓰지 않는 이유:
# 그 사본이 생기는 순간 "떠 있는지 어떻게 판정하는가"가 두 벌이 되고, 한쪽만 고치면
# start_all로 띄운 프로세스를 stop.sh가 못 잡거나 그 반대가 된다.
#
# 인프라는 이 머신의 설치 방식(brew·docker)을 전제한다 — 다르게 설치했으면 건너뛰고
# 알린다. 없다고 실패시키지 않는 이유: 셋 다 없어도 기능이 남기 때문이다
#   Oracle 없음  → ORACLE_MOCK=1이면 stub 결과로 동작
#   Ollama 없음  → 검색이 통째로 성립하지 않는다. 서버는 뜨고 답변도 나가지만 지식·처리방법·쿼리를
#                  하나도 찾지 못하고, 그 사실이 화면과 chat_log에 '검색 불가'로 남는다
#                  (검색은 벡터 단일 경로다 — backend/src/search.js, setup/bge-m3/README.md).
#   MariaDB 없음 → 이건 진짜로 못 뜬다. 유일하게 필수라 아래에서 따로 다룬다.
set -uo pipefail
cd "$(dirname "$0")"

APPS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    -a|--apps-only) APPS_ONLY=1 ;;
    -h|--help)
      echo "사용법: $0 [--apps-only]"
      echo "  (기본)         MariaDB·Oracle·Ollama를 기동한 뒤 백엔드·프론트엔드를 띄운다"
      echo "  --apps-only    인프라는 건드리지 않고 백엔드·프론트엔드만 띄운다"
      exit 0 ;;
    *) echo "알 수 없는 인자: $arg (--help 참고)"; exit 2 ;;
  esac
done

ORACLE_CONTAINER=${ORACLE_CONTAINER:-oracle1521}
EMBEDDING_MODEL=${EMBEDDING_MODEL:-bge-m3}
# Oracle은 컨테이너 안에서 인스턴스가 열릴 때까지 시간이 걸린다(콜드 스타트 1분 내외).
ORACLE_WAIT_S=${ORACLE_WAIT_S:-180}

ok()   { echo "  [O] $*"; }
skip() { echo "  [-] $*"; }
warn() { echo "  [!] $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ===== 인프라 =====
if [ "$APPS_ONLY" -eq 0 ]; then
  echo "== 인프라 =="

  # --- MariaDB (관리 DB) — 유일한 필수 구성요소 ---
  if have mysqladmin && mysqladmin ping --silent >/dev/null 2>&1; then
    ok "MariaDB 이미 실행 중"
  elif have brew; then
    brew services start mariadb >/dev/null 2>&1
    # 기동 직후에는 소켓이 아직 안 열려 있다. 여기서 기다리지 않고 백엔드를 띄우면 기동 시
    # 임베딩 동기화와 chat_log 정리가 접속 실패로 죽고, /api/health는 계속 ok를 돌려줘
    # 원인이 보이지 않는다 (server.js 주석 참고).
    for _ in $(seq 1 30); do
      mysqladmin ping --silent >/dev/null 2>&1 && break
      sleep 1
    done
    if mysqladmin ping --silent >/dev/null 2>&1; then ok "MariaDB 기동"
    else warn "MariaDB가 30초 내에 응답하지 않는다 — 'brew services list'로 상태를 확인할 것"; fi
  else
    warn "MariaDB를 기동할 방법이 없다 (brew 없음). 관리 DB 없이는 모든 질문이 실패한다."
  fi

  # --- Oracle (조회 DB, 선택) ---
  if ! have docker; then
    skip "Oracle 건너뜀 (docker 없음) — ORACLE_MOCK=1이면 stub으로 동작"
  elif ! docker inspect "$ORACLE_CONTAINER" >/dev/null 2>&1; then
    skip "Oracle 건너뜀 ('$ORACLE_CONTAINER' 컨테이너 없음) — README '조회용 Oracle 테스트 DB' 참고"
  else
    docker start "$ORACLE_CONTAINER" >/dev/null 2>&1
    # 준비 판정에 'docker logs | grep READY'를 쓰지 않는다. 로그는 재기동을 넘어 쌓이므로
    # 지난 실행이 남긴 READY 한 줄에 곧바로 걸려, 아직 열리지 않은 DB를 '준비됨'으로 읽는다.
    # 이미지가 싣고 있는 healthcheck.sh는 실제로 인스턴스에 붙어보므로 그 착각이 없다.
    printf '  [.] Oracle 준비 대기'
    ready=0
    for _ in $(seq 1 $((ORACLE_WAIT_S / 3))); do
      if docker exec "$ORACLE_CONTAINER" healthcheck.sh >/dev/null 2>&1; then ready=1; break; fi
      printf '.'
      sleep 3
    done
    echo
    if [ "$ready" -eq 1 ]; then ok "Oracle 준비 완료 ($ORACLE_CONTAINER)"
    else warn "Oracle이 ${ORACLE_WAIT_S}초 내에 준비되지 않았다 — 'docker logs $ORACLE_CONTAINER' 확인"; fi
  fi

  # --- Ollama (임베딩) — 검색의 유일한 경로다 ---
  if ! have ollama; then
    warn "Ollama 미설치 — 검색이 성립하지 않는다. 지식·처리방법·쿼리를 하나도 찾지 못한다 (setup/bge-m3/README.md)"
  elif curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    ok "Ollama 이미 실행 중"
  else
    if have brew; then brew services start ollama >/dev/null 2>&1; else nohup ollama serve >/dev/null 2>&1 & fi
    for _ in $(seq 1 30); do
      curl -sf http://localhost:11434/api/tags >/dev/null 2>&1 && break
      sleep 1
    done
    if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then ok "Ollama 기동"
    else warn "Ollama가 30초 내에 응답하지 않는다 — 그동안의 질문은 검색 없이 답한다"; fi
  fi

  # 모델이 없으면 임베딩 호출이 매번 실패하고, 그것은 곧 검색이 없다는 뜻이다(벡터 단일 경로).
  # 답변은 나가지만 등록된 자료를 하나도 못 찾는다. 있는지만 보고, 없으면 받는다(최초 1회 ~1.2GB).
  if have ollama && curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    if ollama list 2>/dev/null | grep -q "^${EMBEDDING_MODEL}"; then
      ok "임베딩 모델 $EMBEDDING_MODEL 준비됨"
    else
      echo "  [.] $EMBEDDING_MODEL 내려받는 중 (최초 1회, ~1.2GB)..."
      if ollama pull "$EMBEDDING_MODEL" >/dev/null 2>&1; then ok "$EMBEDDING_MODEL 준비됨"
      else warn "$EMBEDDING_MODEL 다운로드 실패 — 이 모델 없이는 검색이 성립하지 않는다"; fi
    fi
  fi
  echo
fi

# ===== 앱 =====
# 인프라보다 나중에 띄운다. 백엔드는 기동 시점에 관리 DB로 임베딩 동기화와 chat_log 정리를
# 시작하므로, MariaDB보다 먼저 뜨면 그 두 작업이 접속 실패로 죽는다.
echo "== 앱 =="
./backend/start.sh
./frontend/start.sh

echo
echo "로그: backend/logs/backend.log · frontend/logs/frontend.log"
echo "중지: ./stop_all.sh"
