# 지식 관리 및 Q&A LLM Agent 구현 계획

## Context

사내 지식 관리 + Q&A LLM Agent를 신규 개발한다.

- 단순 지식 질문 → MariaDB에 저장된 지식으로 답변
- DB 상태 조회가 필요한 질문 → 쿼리 관리 테이블의 쿼리를 조회용 DB(Oracle)에 실행하여 답변. 최종 상태 확인을 위해 **여러 쿼리를 순차 실행**할 수 있어야 함
- 검색은 현재 LIKE, 향후 vector로 교체 가능하게 검색 함수만 격리
- LLM은 **vLLM / OpenRouter**에 연결 — 둘 다 OpenAI 호환 API이므로 OpenAI 호환 클라이언트 하나로 커버, **환경변수 설정만으로 동작**. 개발 중에는 Mock LLM 사용
- 원칙: **simple is best** — 계층/추상화 최소화

확정 사항: 백엔드 Node.js(Express), 조회용 DB는 Oracle, UI는 React 채팅 화면만(관리 데이터는 SQL 직접 입력), LLM은 인터페이스+Mock으로 개발 후 설정으로 실제 연결.

## 핵심 결정

| 항목 | 결정 |
|---|---|
| 언어 | JavaScript (ESM). 전체 ~800줄 규모라 TS 빌드 체계가 오히려 복잡도 증가 |
| 백엔드 | Express 4, 소스 파일 6개. service/repository 계층 없음 |
| 프론트 | Vite + React, 단일 `App.jsx` 컴포넌트 |
| LLM 인터페이스 | `decide(ctx) → decision JSON` 함수 시그니처 하나가 인터페이스 전부 |
| 실제 LLM | OpenAI 호환 API 클라이언트 (Node 내장 `fetch`, SDK 미사용). vLLM·OpenRouter 공용 |
| LLM 선택 | `LLM_PROVIDER=mock \| openai` 환경변수. openai 선택 시 `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`만 설정하면 동작 |
| Oracle | node-oracledb 6.x **Thin 모드** (Instant Client 불필요). `ORACLE_MOCK=1`로 stub 모드 |
| MariaDB | `mariadb` 드라이버, 커넥션 풀 1개 |
| 검색 | SQL LIKE (토큰 분리 후 OR 매칭, LIMIT 5). `search.js`만 교체하면 vector 전환 |
| API | `POST /api/chat` 단일 엔드포인트, stateless |

## 디렉토리 구조 (총 15개 파일)

```
llm_agent/
├── README.md                  # 설치/실행/데모/LLM·Oracle 연결 가이드
├── backend/
│   ├── package.json           # express, mariadb, oracledb, dotenv ("type":"module")
│   ├── .env.example           # 아래 환경변수 전체 목록
│   ├── sql/
│   │   ├── schema.sql         # MariaDB DDL (4개 테이블)
│   │   └── seed.sql           # 데모 3종 시나리오 샘플 데이터
│   └── src/
│       ├── server.js          # Express + POST /api/chat (엔트리포인트)
│       ├── agent.js           # agentic loop (핵심 제어 흐름)
│       ├── llm.js             # LLM 인터페이스 + provider 선택 (mock/openai)
│       ├── llm-openai.js      # OpenAI 호환 클라이언트 (vLLM/OpenRouter)
│       ├── search.js          # LIKE 검색 2함수 (vector 교체 지점)
│       ├── db.js              # MariaDB 풀, query_registry/target_db 로더
│       └── oracle.js          # Oracle Thin 실행기 + mock 모드
└── frontend/
    ├── package.json           # react, react-dom, vite
    ├── vite.config.js         # /api → localhost:3001 proxy
    ├── index.html
    └── src/
        ├── main.jsx
        └── App.jsx            # 채팅 UI 전체 (단일 컴포넌트)
```

## 환경변수 (.env.example)

```bash
# MariaDB (agent 관리 DB)
MARIADB_HOST=localhost
MARIADB_PORT=3306
MARIADB_USER=agent
MARIADB_PASSWORD=...
MARIADB_DATABASE=llm_agent

# LLM — mock: 규칙 기반 Mock / openai: vLLM·OpenRouter (OpenAI 호환)
LLM_PROVIDER=mock
LLM_BASE_URL=http://localhost:8000/v1   # vLLM 예시. OpenRouter는 https://openrouter.ai/api/v1
LLM_API_KEY=                            # vLLM은 보통 불필요(빈 값 허용), OpenRouter는 필수
LLM_MODEL=                              # 예: Qwen/Qwen2.5-32B-Instruct 또는 anthropic/claude-sonnet-4.5

# Oracle 조회 DB — 1이면 stub 결과 반환 (개발용)
ORACLE_MOCK=1
ORDER_DB_PASSWORD=...                   # target_db.db_password='ENV:ORDER_DB_PASSWORD' 참조용
```

## MariaDB 스키마 (schema.sql)

`target_db`에 `db_name` 컬럼 추가 — `query_registry.target_db_name`과의 조인 키가 원 정의에 없어서 필요 (관리자가 SQL로 직접 입력하므로 seq FK보다 이름 참조가 읽기 쉬움).

```sql
CREATE TABLE knowledge (
  seq     INT AUTO_INCREMENT PRIMARY KEY,
  title   VARCHAR(200) NOT NULL,
  content TEXT NOT NULL
);
CREATE TABLE qa_method (
  seq    INT AUTO_INCREMENT PRIMARY KEY,
  title  VARCHAR(200) NOT NULL,
  method TEXT NOT NULL            -- 처리 절차 서술. 실행할 query_name을 순서대로 본문에 언급
);
CREATE TABLE query_registry (
  seq            INT AUTO_INCREMENT PRIMARY KEY,
  query_name     VARCHAR(100) NOT NULL UNIQUE,
  input_desc     TEXT,            -- 바인드 변수 설명 (":job_id = 배치작업ID, 예 BATCH001")
  query_sql      TEXT NOT NULL,   -- :param 바인드 변수 사용
  output_desc    TEXT,
  target_db_name VARCHAR(100) NOT NULL
);
CREATE TABLE target_db (
  seq             INT AUTO_INCREMENT PRIMARY KEY,
  db_name         VARCHAR(100) NOT NULL UNIQUE,
  db_type         VARCHAR(20)  NOT NULL DEFAULT 'oracle',
  connection_info VARCHAR(500) NOT NULL,   -- Thin connectString: "host:1521/SERVICE"
  db_user         VARCHAR(100),
  db_password     VARCHAR(200)   -- 'ENV:변수명'이면 환경변수 참조, 평문은 개발용만 (주석 경고)
);
```

**핵심 규약**: `qa_method.method` 본문에 실행할 `query_name`을 순서대로 그대로 언급한다. 이것이 Mock 규칙의 근거이자 실제 LLM 프롬프트로도 그대로 쓰인다 (별도 순서 테이블 불필요).

### seed.sql — 데모 3종 시나리오

- knowledge: "배치 재시작 방법", "시스템 점검 일정"
- qa_method: "배치 작업 상태 확인" (`batch_job_status` 1-step), "고객 주문 상태 확인" (`find_customer_id` → `order_status_by_customer` 2-step)
- query_registry: 위 3개 쿼리 (Oracle 문법, `:job_id`/`:customer_name`/`:customer_id` 바인드)
- target_db: `ORDER_DB` / oracle / `ENV:ORDER_DB_PASSWORD`

## Agent 루프 (agent.js)

```
handleQuestion(question):
  knowledge = searchKnowledge(question)     # LIKE, 최대 5건
  qaMethods = searchQaMethods(question)     # LIKE, 최대 5건
  queries   = loadQueryRegistry()           # 전체 로드 (소규모 테이블)

  history = []                              # 유일한 루프 상태
  for step in 1..MAX_STEPS(5):
    decision = llm.decide({question, knowledge, qaMethods, queries, history})
    #  {action:'answer', answer} | {action:'run_query', query_name, params}
    if decision.action == 'answer': return {answer, trace: history}
    q = queries.find(query_name); 없으면 history에 error 기록 후 continue
    try:  rows = runQuery(q, decision.params); history.push({query_name, params, rows})
    catch e: history.push({query_name, params, error: e.message})   # 루프 계속

  final = llm.decide({..., forceAnswer: true})    # 안전장치: 강제 답변
  return {answer: final.answer, trace: history}
```

- multi-step은 history 누적으로 자연 해결. 무한 루프 방지는 `MAX_STEPS + forceAnswer`가 전부.
- 쿼리 실패도 history에 남기고 계속 → LLM이 에러를 보고 재시도/우회/답변 판단.

## LLM 계층 (llm.js + llm-openai.js)

인터페이스는 함수 시그니처 하나:

```js
// decide(ctx) → Promise<{action:'answer',answer} | {action:'run_query',query_name,params}>
// ctx = {question, knowledge[], qaMethods[], queries[], history[], forceAnswer?}
export const llm = { decide: process.env.LLM_PROVIDER === 'openai' ? openaiDecide : mockDecide };
```

### MockLLM (llm.js 내부, 규칙 기반)

1. 매칭된 qaMethods 본문에서 query_name 등장 순서대로 실행 계획 도출
2. 아직 성공 실행 안 된 첫 쿼리가 있으면 `run_query` (forceAnswer/에러 발생 시 제외)
3. 바인드 값 채우기: ① history의 이전 결과 컬럼명 매칭(`customer_id` ↔ `CUSTOMER_ID`) — multi-step 연결 ② 질문 정규식 추출 (`job_id`: `/\b[A-Z]{2,}\d+\b/`, `customer_name`: 한글 이름+고객/님 패턴, fallback: 따옴표 문자열) — mock 전용 하드코딩임을 주석 명시
4. 답변 조립: history 결과 요약 + 관련 knowledge 첨부

### OpenAI 호환 클라이언트 (llm-openai.js) — vLLM/OpenRouter 공용

- Node 20 내장 `fetch`로 `POST {LLM_BASE_URL}/chat/completions` 호출 (SDK 의존성 없음)
- 헤더: `Authorization: Bearer {LLM_API_KEY}` (빈 값이면 생략 — vLLM 로컬 대응)
- system 프롬프트: 역할 설명 + ctx(지식/처리방법/쿼리목록/실행이력) 직렬화 + "반드시 JSON 하나로만 응답: {action:...}" 지시. forceAnswer면 answer만 허용한다고 명시
- 응답 파싱: `choices[0].message.content`에서 JSON 추출 (코드펜스 감싸짐 대비 `{...}` 블록 추출), 파싱 실패 시 1회 재요청 후 실패면 `{action:'answer', answer:'...오류 안내'}` 폴백
- `temperature: 0`. `response_format`은 지원 서버가 제한적이므로 프롬프트 지시+파싱으로 처리
- **agent.js는 provider가 바뀌어도 한 글자도 안 바뀜**

## Oracle 실행기 (oracle.js)

- node-oracledb **Thin 모드** (기본값, Instant Client 불필요)
- 실행마다 `getConnection → execute → close(finally)`. 풀 없음 (Q&A 트래픽 수준에 충분, 다중 target_db 관리 단순)
- `db_password`가 `ENV:`로 시작하면 환경변수에서 읽음
- `ORACLE_MOCK=1`이면 파일 하단 `MOCK_DATA` 맵에서 stub 반환. `batch_job_status`는 FAILED를 반환하게 하여 "쿼리 결과+지식 결합 답변" 데모
- 바인드 검증: `query_sql`에서 추출한 바인드명이 params에 모두 있는지 확인, 누락 시 throw → history에 error로 기록
- SQL injection: 쿼리는 관리자 등록이라 신뢰, 사용자 입력은 **바인드 값으로만** 전달 (문자열 결합 금지). `maxRows: 100`

## 검색 (search.js) — vector 교체 지점

```js
export async function searchKnowledge(q) { return likeSearch('knowledge', ['title','content'], q); }
export async function searchQaMethods(q) { return likeSearch('qa_method', ['title','method'], q); }
// 내부: 공백 분리 → 2자 이상 토큰 → 컬럼별 LIKE '%tok%' OR 결합 (? 플레이스홀더) → LIMIT 5
```

## API (server.js)

- `POST /api/chat` `{message}` → `{answer, trace:[{query_name, params, rowCount, rows(최대10행), error?}]}`
- `GET /api/health` → `{ok:true}`
- 400 (message 누락) / 500 (일반화 메시지, 상세는 서버 로그만)

## React UI (App.jsx)

- 상태 3개: `messages`, `input`, `loading`
- 말풍선 리스트 + assistant 메시지에 trace 있으면 `<details>실행된 쿼리 N건</details>` 접이식
- `fetch('/api/chat')`, vite proxy로 CORS 회피. CSS는 인라인 ~40줄, 프레임워크 없음

## 구현 순서

1. `backend/sql/schema.sql` + `seed.sql` — MariaDB 적용 확인
2. `backend/package.json` + `.env.example` — express, mariadb, oracledb, dotenv
3. `src/db.js` + `src/search.js` — 풀, 로더, LIKE 검색
4. `src/oracle.js` — mock 모드 우선 검증, 실 접속 코드는 작성 (Oracle 환경 생기면 검증)
5. `src/llm.js`(인터페이스+Mock) + `src/llm-openai.js`(vLLM/OpenRouter 클라이언트)
6. `src/agent.js` — 루프, 시나리오 3종 함수 레벨 통과
7. `src/server.js` — curl 3종 통과 = 백엔드 완성
8. `frontend/` — Vite React 생성 후 App.jsx 교체, 브라우저 확인
9. `README.md` — 설치/실행/데모 + vLLM/OpenRouter 연결 방법(환경변수 4개), vector 전환 지점 명시

## 검증 (E2E)

준비: schema+seed 적용 → `LLM_PROVIDER=mock ORACLE_MOCK=1 node src/server.js` (MariaDB만 실제 필요)

| # | 질문 | 기대 |
|---|---|---|
| 1 | "배치 재시작 방법 알려줘" | 쿼리 0회, knowledge로 답변 (trace 빈 배열) |
| 2 | "BATCH001 작업 상태 알려줘" | `batch_job_status` 1회 → FAILED + 재시작 지식 결합 답변 |
| 3 | "홍길동 고객 주문 상태 알려줘" | 2-step: `find_customer_id` → CUSTOMER_ID 연결 → `order_status_by_customer`, trace에 2건 순서대로 |

```bash
curl -s localhost:3001/api/chat -H 'Content-Type: application/json' -d '{"message":"홍길동 고객 주문 상태 알려줘"}'
```

이후 브라우저(Vite dev 서버)에서 동일 3종 확인. vLLM/OpenRouter 실 연결 검증은 endpoint 제공 시 `LLM_PROVIDER=openai` + 환경변수 3개 설정으로 수행.

## 향후 교체 지점 (지금 구현하지 않음)

- vector 검색: `search.js` 내부만 교체
- 실 Oracle: `ORACLE_MOCK=1` 제거 (코드는 이미 존재)
- LLM 전환: 환경변수만 변경 (mock ↔ vLLM ↔ OpenRouter)
