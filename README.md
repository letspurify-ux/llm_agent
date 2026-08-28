# SPACE VOC Agent

사내 지식과 조회용 DB(Oracle)를 결합해 질문에 답하는 지식 관리 및 Q&A LLM Agent.

```
사용자 질문
  → 지식/Q&A 처리방법 LIKE 검색 (MariaDB, 여러 건 매칭 가능)
  → LLM 결정 루프: 답변 가능하면 답변 / DB 조회가 필요하면 쿼리 관리 테이블의 쿼리 실행 (여러 번 가능)
  → 최종 답변 (+ 실행된 쿼리 trace)
```

- **agent 관리 DB**: MariaDB — `knowledge`(지식), `qa_method`(Q&A 처리 방법), `query_registry`(쿼리 관리), `target_db`(조회대상 DB 접속 정보)
- **조회용 DB**: Oracle (node-oracledb Thin 모드, Instant Client 불필요). 여러 개 등록 가능
- **LLM**: vLLM / OpenRouter 등 OpenAI 호환 API. 개발용 규칙 기반 Mock 내장
- **UI**: React(Vite) 채팅 화면. 답변은 markdown(표·제목·목록)으로 구조화되어 렌더링(react-markdown + remark-gfm). 관리 데이터는 SQL로 직접 입력

## 디렉토리

```
backend/
  sql/schema.sql, seed.sql   # MariaDB DDL + 데모 데이터
  src/server.js              # Express, POST /api/chat
  src/agent.js               # agentic loop (핵심 제어 흐름)
  src/llm.js                 # LLM 인터페이스 + Mock (provider 선택)
  src/llm-openai.js          # OpenAI 호환 클라이언트 (vLLM/OpenRouter)
  src/search.js              # LIKE 검색 — vector 검색 교체 지점
  src/db.js                  # MariaDB 풀 + 관리 테이블 로더
  src/oracle.js              # Oracle 실행기 + SELECT 전용 가드 + mock 모드
frontend/                    # Vite + React 채팅 UI (App.jsx 단일 컴포넌트)
```

## 설치 및 실행

### 1. MariaDB 스키마 적용

```bash
mariadb --default-character-set=utf8mb4 < backend/sql/schema.sql
```

```bash
mariadb --default-character-set=utf8mb4 < backend/sql/seed.sql
```

앱 계정 생성 (agent 서버는 관리 테이블을 읽기만 하므로 SELECT 권한이면 충분):

```bash
mariadb -e "CREATE USER IF NOT EXISTS 'agent'@'localhost' IDENTIFIED BY 'agent1234'; GRANT SELECT ON llm_agent.* TO 'agent'@'localhost';"
```

SPACE 시스템 지식 데이터도 함께 등록:

```bash
mariadb --default-character-set=utf8mb4 < backend/sql/seed-space.sql
```

### 1-2. 조회용 Oracle 테스트 DB (Docker)

로컬에서 실제 Oracle로 테스트하려면 컨테이너를 띄운다 (`ORACLE_MOCK=1`로 두면 이 단계는 건너뛰어도 된다):

```bash
docker run -d --name space-voc-oracle -p 1521:1521 -e ORACLE_PASSWORD=oracle_sys_1234 -e APP_USER=app_user -e APP_USER_PASSWORD=app_user_1234 gvenzl/oracle-free:latest
```

`docker logs -f space-voc-oracle`에 "DATABASE IS READY TO USE"가 뜨면 스키마·샘플 데이터·조회 계정을 생성한다 (재실행 가능):

```bash
docker exec -i space-voc-oracle sqlplus -s system/oracle_sys_1234@localhost:1521/FREEPDB1 < backend/sql/oracle-init.sql
```

생성되는 것 — `APP_USER` 스키마의 `BATCH_JOBS`/`CUSTOMERS`/`ORDERS` 테이블과 샘플 데이터, 그리고 **SELECT 권한만 가진 조회 전용 계정 `VOC_READER`**(agent가 이 계정으로 접속). 접속 정보는 `target_db` 테이블에 `localhost:1521/FREEPDB1`로 등록되어 있다.

### 2. 백엔드

```bash
cd backend && npm install && cp .env.example .env && npm start
```

`http://localhost:3001` 에서 기동. 기본값은 `LLM_PROVIDER=mock`, `ORACLE_MOCK=1` 이라 MariaDB만 있으면 동작한다.

### 3. 프론트엔드

```bash
cd frontend && npm install && npm run dev
```

`http://localhost:5173` 접속 (`/api`는 vite proxy로 백엔드에 전달).

## 데모 시나리오 (seed 데이터 기준)

| 질문 | 동작 |
|---|---|
| 배치 재시작 방법 알려줘 | 쿼리 0회 — 지식만으로 답변 |
| BATCH001 작업 상태 알려줘 | `batch_job_status` 1회 → FAILED 결과 + 재시작 지식 결합 답변 |
| 홍길동 고객 주문 상태 알려줘 | 2단계 — `find_customer_id` 결과의 CUSTOMER_ID로 `order_status_by_customer` 실행 |
| 쿠버네티스가 뭐야 (등록되지 않은 질문) | LLM의 일반 지식으로 답변 — "*등록된 지식에 없는 내용이라 일반 지식으로 답변합니다.*" 표시가 붙음 (Mock은 안내 문구만 표시) |

등록된 지식·쿼리 결과가 있으면 반드시 그것에 근거해 답하고, 전혀 없을 때만 LLM 일반 지식으로 답한다. 일반 지식 답변에서도 사내 시스템의 구체적 상태(수치·상태값 등)는 지어내지 않도록 프롬프트로 제한한다 (`llm-openai.js`의 SYSTEM_PROMPT).

```bash
curl -s localhost:3001/api/chat -H 'Content-Type: application/json' -d '{"message":"홍길동 고객 주문 상태 알려줘"}'
```

## 실제 LLM 연결 (vLLM / OpenRouter)

`backend/.env`만 수정하면 된다 — 코드 변경 없음:

```bash
# vLLM
LLM_PROVIDER=openai
LLM_BASE_URL=http://localhost:8000/v1
LLM_API_KEY=
LLM_MODEL=Qwen/Qwen2.5-32B-Instruct

# OpenRouter
LLM_PROVIDER=openai
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-...
LLM_MODEL=anthropic/claude-sonnet-4.5
```

LLM 인터페이스는 `llm.js`의 `decide(ctx) → {action:'answer'|'run_query', ...}` 함수 하나다. 다른 provider가 필요하면 같은 시그니처의 함수를 추가하고 `llm.js`의 분기에 연결한다. `agent.js`는 변경되지 않는다.

## 실제 Oracle 연결

1. `target_db` 테이블에 접속 정보 등록 — `connection_info`는 Thin connectString(`host:1521/SERVICE`), `db_password`는 `ENV:변수명` 형식 권장
2. `.env`에서 `ORACLE_MOCK=0`, 참조하는 비밀번호 환경변수(`ORDER_DB_PASSWORD`) 설정
3. `query_registry`의 쿼리를 실제 테이블 구조에 맞게 등록

로컬 테스트 컨테이너(위 1-2단계)를 쓰는 경우 이미 이 값들로 설정되어 있다.

## 보안

- **조회 전용 가드**: 실행 직전 SELECT/WITH로 시작하는 단일 문장만 허용 — UPDATE/DELETE/DDL/다중 문장은 차단된다 (`oracle.js`의 `assertReadOnly`)
- LLM은 SQL을 직접 쓸 수 없고 `query_registry`에 등록된 쿼리의 **이름만 선택**한다. 사용자 입력은 바인드 변수 값으로만 전달 (문자열 결합 없음)
- 그래도 조회 계정(`target_db.db_user`)은 **read-only 권한 계정**을 사용할 것 (심층 방어)
- `db_password`는 `ENV:변수명` 형식으로 환경변수 참조 권장. 평문 저장은 개발용만
- 조회 결과는 `maxRows: 100` 제한. 결과가 길면 LLM 컨텍스트/답변에는 20행·셀당 200자까지만 전달하고 "외 N건 생략 (총 N건)"으로 표기 (`agent.js`의 `capRows`)

## 향후 확장 지점

- **vector 검색**: `search.js`의 두 함수 내부만 교체 (다른 파일 변경 없음)
- **새 쿼리/지식 추가**: 코드 변경 없이 MariaDB 테이블에 INSERT. `qa_method.method` 본문에 실행할 `query_name`을 순서대로 언급하는 것이 규약
