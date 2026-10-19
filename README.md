# SPACE VOC Agent

사내 지식·Q&A 처리 방법·조회용 DB(Oracle)·프로젝트 소스를 근거로 질문에 답하는 Q&A LLM Agent.

```
사용자 질문 (대화 번호 — 서버가 대화 맥락을 들고 있다)
  → MnemoArc 질문 모드의 답변 루프: 모델이 도구를 부르고(네이티브 tool calling), 결과를 보고 다시 부른다
      search          — 지식·처리 방법·쿼리를 의미 검색 (요약과 ID만, 개수·이어 받기는 모델이 정한다)
      knowledge_read  — 지식 문서를 처음부터 결과 한도까지 읽기 (대부분 통째로, 긴 문서는 이어 읽기 커서)
      method_read     — Q&A 처리 방법 전문 + 그 방법이 지목한 쿼리 요약
      query_describe  — 등록 쿼리의 바인드·입력/출력 설명·대상 DB·SQL
      query_run       — 등록 쿼리 실행 (미리보기 행 + step 번호, 독립 조회는 한 응답에 여럿)
      result_read     — 보관된 조회 결과의 다른 행·열 읽기 (DB 재실행 없음)
      file_read · source_search · code_outline · symbol_* · file_list — 프로젝트 소스 읽기 (쓰기 도구 없음)
  → 도구 없이 낸 응답이 최종 답변. 조회 표·차트는 참조(```table step: N)로 적고 화면이 채운다
```

backend는 Rust(axum)다 — MnemoArc의 질문 모드(일반 작업) 런타임을 바탕으로, 기억·작업 계획·체크포인트를
빼고 지식·쿼리 도구와 프로젝트 소스 도구를 붙였다. 화면(React)은 그대로이고, 관리자 화면에 **프로젝트**와 **설정** 탭이 더해졌다.

- **agent 관리 DB**: MariaDB — `knowledge`(지식), `qa_method`(Q&A 처리 방법), `query_registry`(쿼리 관리), `target_db`(조회대상 DB 접속 정보), `chat_log`, `vec_*`(벡터)
- **조회용 DB**: Oracle — Rust `oracle` 크레이트(ODPI-C)라 **Oracle Instant Client가 필요하다**. 여러 개 등록 가능
- **LLM**: OpenRouter / vLLM / Ollama 등 OpenAI 호환 `/chat/completions` (tool calling을 지원하는 모델)
- **임베딩**: Ollama 등 OpenAI 호환 `/embeddings` (1024차원 — bge-m3, qwen3-embedding:0.6b)
- **설정**: 모두 관리자 화면의 **설정** 탭에서 바꾼다 — `backend/config.toml`과 비밀값 파일 `backend/config.credentials.json`에 저장된다
- **도구 확장**: MCP(Model Context Protocol) 서버의 도구를 코드 수정 없이 붙인다 — 관리자 화면 **MCP** 탭 또는 `config.toml`의 `[[mcp_servers]]` (아래 'MCP 도구 서버로 도구 붙이기')

## 대화 맥락

화면은 대화마다 숨은 대화 번호(`conversation_id`)를 보내고, 서버가 그 대화의 이력을 들고 있다. 그래서 "그럼 김철수는?",
"그 결과를 차트로" 같은 후속 질문에서 앞 턴의 조회 결과·읽은 소스가 그대로 맥락에 남아 있다 — 다시 조회하지 않는다.

- 이력은 MnemoArc처럼 **묶음(bundle)** 단위다: 사용자 질문 하나, 또는 모델 응답 하나와 그 도구 결과 전부. 묶음은 쪼개지지 않는다.
- 요청이 입력 예산의 `high_water`(기본 90%)를 넘으면 **오래된 묶음부터** 맥락에서 빼서 `low_water`(50%) 아래로 내린다.
  지금 질문과 가장 최근 묶음은 남긴다. 뺀 묶음은 `history` 도구로 다시 찾을 수 있고, 이력 보관 용량(기본 16MiB)을 넘으면 지워진다.
  도구를 쓸 수 없는 요청(마지막 답·끊긴 답 이어 쓰기)은 뺀 것을 다시 읽을 수 없으므로, 들어가는 한 빼지 않고 넘칠 때만 넘는 만큼 뺀다.
  모델 서버가 요청을 컨텍스트보다 길다고 거절하면 거절 문구에 적힌 토큰 수로 크기 추정을 보정해 뺄 만큼만 빼고 다시 보낸다
  (수가 없거나 서버가 설정보다 작은 컨텍스트로 서빙하면 뺄 수 있는 묶음을 모두 뺀다).
  (MnemoArc는 비우기 전에 모델에게 기억·체크포인트를 저장시켰지만 여기에는 기억이 없으므로 그 단계 없이 비운다.)
- 조회 결과의 원본 행(실행당 최대 1,000행)은 대화 안에 step 번호로 보관된다(기본 32MiB, 넘으면 오래된 것부터).
- 대화는 마지막 사용 후 60분이 지나면 서버에서 지워지고(최대 200개), 서버가 재시작됐거나 대화가 지워졌으면
  화면이 함께 보내는 최근 6턴 텍스트(`history`)로 이어 간다. **홈**을 누르면 새 대화 번호로 시작한다.
- 질문은 답할 때까지 모델을 부른다 — 요청 수·한 응답의 도구 호출 수에 제한이 없고 시간만 400초다(화면은 450초에 끊는다). 끝나기 45초 전에는 도구 없이 지금까지의 근거로 답하게 한다(그 45초는 그 답의 몫이라, 아직 답을 쓰기 시작하지 않은 앞 요청과 도구 실행은 그때 멈춘다).

## 디렉토리

```
backend/                     # Rust (cargo) — 실행 파일 target/release/llm-agent
  Cargo.toml
  config.toml                # 설정 (관리자 화면 설정 탭이 쓴다 — 저장소에는 없다)
  config.credentials.json    # 비밀값: LLM API 키·관리 DB 비밀번호·관리자 인증 키 (0600)
  sql/schema.sql, seed.sql   # MariaDB DDL + 데모 데이터
  src/main.rs                # 기동·백그라운드 작업(임베딩 동기화·로그 정리)·종료
  src/web.rs                 # POST /api/chat (NDJSON), /api/health
  src/admin.rs               # /api/admin — 관리 테이블 CRUD·프로젝트·설정·폴더 선택·연결 확인
  src/agent.rs               # 답변 루프 (도구 일괄 실행·진행 이벤트·최종 답)
  src/context.rs             # 시스템 프롬프트·토큰 계수·컨텍스트 비우기
  src/session.rs             # 대화(이력 묶음·조회 결과 보관)와 대화 저장소
  src/llm.rs                 # OpenAI 호환 SSE 클라이언트 (MnemoArc)
  src/voc_tools.rs           # search·knowledge_read·method_read·query_describe·query_run·result_read
  src/tools/                 # 프로젝트 소스 도구 (MnemoArc: 검색·tree-sitter 구조·심볼 탐색·결과 한도)
  src/mcp/                   # MCP 도구 서버 연결·재연결·호출·결과 변환 (docs/mcp-design.md)
  tests/fixtures/fake_mcp_server.mjs  # 시험용 가짜 MCP 서버 (stdio·HTTP, Node)
  src/search.rs, embed_sync.rs, embedding.rs, chunk.rs   # 벡터 검색·동기화
  src/oracle.rs, sql.rs, execution.rs, numbers.rs        # Oracle 실행·조회 전용 가드·루틴·NUMBER
  tests/                     # 통합 검사 (MariaDB·Oracle은 환경변수가 있을 때만)
frontend/
  src/App.jsx                # Vite + React 채팅 UI
  src/AdminPanel.jsx         # DB·지식·방법·쿼리·프로젝트 관리 + 설정 탭(SettingsPanel.jsx)
  src/answer-fill.js         # 답변의 ```table·```chart 참조를 조회 행으로 채운다
  src/math.js                # 답변 안의 수식 표기 판정(remark 플러그인) + 렌더러 설정
```

## 설치 및 실행

### 1. MariaDB 스키마 적용

```bash
mariadb --default-character-set=utf8mb4 < backend/sql/schema.sql
```

> **이미 운영 중인 DB에는 실행하지 말 것** — schema.sql은 맨 앞에서 모든 테이블을 DROP한다.
> 기존 설치는 앱 업데이트 전에 `backend/sql/migrate-routines.sql`을 적용한다.
> 기존 실행 항목을 `QUERY`로 유지하면서 `query_type`, `bind_config`만 추가하며 재실행할 수 있다.
> 지식 본문을 65,535바이트보다 길게 저장하려면 기존 설치에 `backend/sql/migrate-knowledge-content.sql`도 적용한다.
>
> ```bash
> mariadb --default-character-set=utf8mb4 -u <관리자> -p < backend/sql/migrate-knowledge-content.sql
> ```
> 더 오래된 설치의 변경분은 아래 마이그레이션을 쓴다:
>
> ```sql
> -- chat_log.answer: TEXT(65,535바이트)로는 결과가 큰 대화가 strict 모드에서 통째로 기록되지 않는다
> ALTER TABLE chat_log MODIFY answer MEDIUMTEXT;
>
> -- 제목 UNIQUE: 시드 파일이 ON DUPLICATE KEY UPDATE로 멱등해지고,
> -- 같은 제목의 지식이 두 벌 임베딩되어 검색 결과에 나란히 뜨는 것도 막힌다.
> -- 이미 중복 제목이 있으면 ALTER가 실패하므로 아래로 먼저 확인하고 정리할 것.
> SELECT title, COUNT(*) c FROM knowledge  GROUP BY title HAVING c > 1;
> SELECT title, COUNT(*) c FROM qa_method GROUP BY title HAVING c > 1;
> -- 인덱스 이름을 uk_title로 맞춘다 — 시드 파일이 그 이름으로 존재 여부를 확인하므로,
> -- 이름이 다르면 같은 컬럼에 UNIQUE 인덱스가 두 벌 생긴다.
> ALTER TABLE knowledge  ADD UNIQUE KEY IF NOT EXISTS uk_title (title);
> ALTER TABLE qa_method ADD UNIQUE KEY IF NOT EXISTS uk_title (title);
> -- 이전 안내를 따라 이름 없이 UNIQUE를 만들었다면 인덱스 이름이 title이다. 그때만 정리한다:
> --   ALTER TABLE knowledge  DROP INDEX title;
> --   ALTER TABLE qa_method DROP INDEX title;
>
> -- collation 고정 (서버 기본값이 버전마다 달라 대소문자 비교 전제가 흔들린다).
> -- ALTER DATABASE는 '이후에 만드는' 테이블의 기본값만 바꾼다 — 이미 있는 테이블·컬럼의
> -- collation은 그대로 남으므로, 실제 비교가 일어나는 기존 컬럼은 테이블마다 변환해야
> -- nameKey()가 전제하는 대소문자 무시 비교가 정말로 고정된다 (schema.sql 주석 참고).
> ALTER DATABASE llm_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
> ALTER TABLE knowledge      CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
> ALTER TABLE qa_method      CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
> ALTER TABLE query_registry CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
> ALTER TABLE target_db      CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
> ALTER TABLE chat_log       CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
> -- vec_* 테이블은 제외 — 텍스트 컬럼이 없고, VECTOR 컬럼이 있는 테이블의 문자셋 일괄 변환은
> -- 버전에 따라 지원되지 않는다.
> ```
>
> **청크 구조로의 이행**(긴 지식이 앞부분만 검색되던 문제 — `context.md` 4절)은 별도 파일에 있다.
> 임베딩 저장소를 소스별로 나누고 `knowledge_chunk`를 만든다:
>
> ```bash
> mariadb --default-character-set=utf8mb4 < backend/sql/migrate-chunk.sql
> cd backend && cargo run --release -- embed-sync     # 청크 생성 + 최초 임베딩
> ```
>
> `embed-sync`는 지식 문서 수 × 평균 청크 수만큼 임베딩을 호출한다(문서 1,000건 × 10청크면 1만 회).
> 서버 기동 시에도 같은 동기화가 돌지만 그때는 첫 질문이 그 시간을 그대로 기다리므로, 한산한 시간에
> 미리 돌리는 편이 낫다. 검색이 정상인 것을 확인한 뒤 `DROP TABLE vec_store;` 로 옛 테이블을 지운다.

```bash
mariadb --default-character-set=utf8mb4 < backend/sql/seed.sql
```

앱 계정 생성 (관리자 화면의 저장·삭제를 위해 관리 테이블에도 쓰기 권한이 필요하다).
`<비밀번호>`는 직접 정하고, 같은 값을 관리자 화면 설정 탭의 관리 DB 비밀번호(또는 첫 기동 전 `backend/.env`의 `MARIADB_PASSWORD`)에 넣는다
(문서에 고정 비밀번호를 적어 두면 저장소에 공개된 자격증명이 운영까지 그대로 따라간다):

```bash
mariadb -e "CREATE USER IF NOT EXISTS 'agent'@'localhost' IDENTIFIED BY '<비밀번호>';
GRANT SELECT ON llm_agent.* TO 'agent'@'localhost';
GRANT INSERT, UPDATE, DELETE ON llm_agent.target_db      TO 'agent'@'localhost';
GRANT INSERT, UPDATE, DELETE ON llm_agent.knowledge      TO 'agent'@'localhost';
GRANT INSERT, UPDATE, DELETE ON llm_agent.qa_method      TO 'agent'@'localhost';
GRANT INSERT, UPDATE, DELETE ON llm_agent.query_registry TO 'agent'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.knowledge_chunk     TO 'agent'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.vec_knowledge_chunk TO 'agent'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.vec_qa_method       TO 'agent'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.vec_query_registry  TO 'agent'@'localhost';
GRANT SELECT, INSERT, DELETE ON llm_agent.chat_log TO 'agent'@'localhost';"

`knowledge_chunk`에 쓰기 권한이 필요한 이유: 청크는 `embed-sync`가 원문에서 만들어 넣는 파생
테이블이다(`context.md` 4절). 읽기만 주면 동기화가 매 주기 실패하는데, 증상은 '지식이 하나도
검색되지 않는다'로만 보인다.
```

SPACE 시스템 지식 데이터도 함께 등록:

```bash
mariadb --default-character-set=utf8mb4 < backend/sql/seed-space.sql
```

### 1-2. 조회용 Oracle 테스트 DB (Docker)

로컬에서 실제 Oracle로 테스트하려면 gvenzl/oracle-free 컨테이너를 쓴다 (설정 탭에서 Oracle mock을 켜 두면 이 단계는 건너뛰어도 된다). 이미 있는 컨테이너를 재사용해도 되고, 없으면 새로 띄운다:

```bash
docker run -d --name oracle1521 -p 1521:1521 -e ORACLE_PASSWORD=password gvenzl/oracle-free:latest
```

`docker logs -f oracle1521`에 "DATABASE IS READY TO USE"가 뜨면 스키마·샘플 데이터·계정을 생성한다 (재실행 가능 — APP_USER가 없으면 스크립트가 직접 만든다):

```bash
docker exec -i oracle1521 sqlplus -s system/password@localhost:1521/FREEPDB1 < backend/sql/oracle-init.sql
```

생성되는 것 — `APP_USER` 계정과 그 스키마의 `BATCH_JOBS`/`CUSTOMERS`/`ORDERS` 테이블과 샘플 데이터, 그리고 **읽기 권한만 가진 조회 전용 계정 `VOC_READER`**(agent가 이 계정으로 접속). 접속 정보는 `target_db` 테이블에 `localhost:1521/FREEPDB1`로 등록되어 있다.

### 2. 백엔드

실행 파일 하나(`backend/target/release/llm-agent`, Windows는 `.exe`)가 API와 화면을 함께 서빙한다 — MnemoArc처럼
`build.rs`가 화면 빌드 결과(`frontend/dist`)를 실행 파일 안에 넣는다. 빌드에는 Rust(1.88 이상, `rustup`)와 Node.js(화면 빌드)가,
실행에는 **Oracle Instant Client**가 필요하다. Instant Client는 조회 대상 Oracle이 있을 때만 쓰이고,
없으면 서버는 뜨되 쿼리 실행만 실패한다(기동 로그에 `[setup] the Oracle client library could not be loaded …`가 남는다.
설정 탭의 Oracle mock은 클라이언트 없이 동작한다).

```bash
cd backend
./start.sh            # cargo build --release(바뀐 것만, 처음 1~3분) 뒤 실행
# 또는 직접: cargo build --release && ./target/release/llm-agent
```

`cargo build --release` 하나로 화면까지 빌드된다 — `build.rs`가 화면 소스(`frontend/src`·`index.html`·`package.json`·`vite.config.js` 등)가
`frontend/dist`보다 새것이면 `npm run build`를(처음이면 `npm ci`도) 먼저 부르고 그 결과를 넣는다. 그래서 예전 화면이 들어갈 일이 없다.
npm이 없는 PC에서는 있는 `dist`를 그대로 쓰고, `dist`도 없으면 release 빌드가 실패한다(빈 화면을 내보내지 않게).
debug 빌드(`cargo build`·`cargo test`)는 화면을 빌드하지 않고 있는 것만 넣는다(없으면 `/`가 503).
화면을 고친 직후의 release 빌드는 다음 번에 한 번 더 컴파일한다(빌드 도중 바뀐 `dist`를 cargo가 본다) — 그 뒤로는 즉시 끝난다.

`http://localhost:5173`이 화면이자 API다(예전 화면 주소 그대로, 설정 탭에서 포트를 바꿀 수 있다). Windows는 `start.bat`/`stop.bat`.

**배포** — 빌드한 PC에서 실행 파일 하나만 옮기면 된다(Rust·Node.js 불필요). 옮긴 PC에는 Instant Client와,
실행 파일 옆(작업 폴더)의 `config.toml`·`config.credentials.json`(없으면 첫 기동에 `.env`에서 만든다)과 대상 DB 비밀번호용 `.env`만 둔다.
Windows에서 `start.bat`으로 띄우려면 실행 파일을 `backend\target\release\llm-agent.exe` 자리에 둔다.

**처음 기동할 때** `backend/config.toml`이 없으면 예전 Node 백엔드의 `backend/.env`를 읽어 만든다 —
`MARIADB_*`, `LLM_BASE_URL`·`LLM_MODEL`·`LLM_API_KEY`(LLM_PROVIDER=openai였을 때), `EMBEDDING_*`, `EMBED_SYNC_INTERVAL`,
`ORACLE_MOCK`·`ORACLE_CLIENT_*`·`ORACLE_TIMEOUT_MS`·`ORACLE_ROUTINE_READ_ONLY`, `PORT`, `ADMIN_TOKEN`.
비밀값은 `config.credentials.json`(소유자만 읽기)으로 간다. 그 뒤로는 **관리자 화면 → 설정 탭**에서 바꾼다.
`.env`는 계속 읽는다 — 조회 대상 DB 비밀번호 `ENV:변수명`이 가리키는 값(`ORDER_DB_PASSWORD` 등)을 여기 둔다.

#### Oracle Instant Client 설치

| OS | 방법 |
|---|---|
| macOS (Apple Silicon) | [Instant Client Basic](https://www.oracle.com/database/technologies/instant-client/macos-arm64-downloads.html) dmg를 풀어 `~/lib` 또는 원하는 폴더에 둔다 |
| Linux | Basic 패키지(rpm/zip) 설치 후 `LD_LIBRARY_PATH` 또는 `ldconfig` |
| Windows | Basic zip을 풀고 그 폴더를 `PATH`에 넣는다 (Visual C++ 재배포 패키지 필요) |

OS 검색 경로에 두지 않았다면 설정 탭의 **Instant Client 폴더**에 그 폴더를 지정하고 서버를 다시 시작한다
(클라이언트 라이브러리는 프로세스에 한 번만 불러온다). 불러왔는지는 기동 로그의 `[oracle] Oracle client 23.x loaded`와
설정 탭의 Oracle 상태 줄, **연결 확인** 단추로 본다. `tnsnames.ora`를 쓰면 그 폴더를 **TNS_ADMIN** 칸에 넣는다.

#### 설정 탭

| 묶음 | 항목 |
|---|---|
| 모델 연결 | 주소·모델·API 키(쓰기 전용)·추론 강도·thinking·컨텍스트/출력 토큰·무응답 한도·재시도·프록시 — **연결 확인**은 일반 응답·스트리밍·도구 호출 왕복을 시험한다. 요청은 앞 요청이 남긴 연결을 4초 유휴까지 다시 쓴다(임베딩도 같다) |
| 임베딩·검색 | 주소(비우면 의미 검색 끔)·모델·검색어 앞 지시문·동기화 주기·관련도 거리 문턱(0.4)·벡터 탐색 깊이(150) |
| 관리 DB | MariaDB 호스트·포트·사용자·비밀번호(쓰기 전용)·DB 이름·연결 수(풀 상한 — 쓴 연결은 초기화해 1분 유휴까지 다시 쓰고 닫는다) — 저장하면 다음 요청부터 새 접속 |
| Oracle | Instant Client 폴더·TNS_ADMIN(재시작 필요)·조회 한도·루틴 읽기 전용·mock |
| 실행·컨텍스트 | 질문당 시간, 맥락 비우기 시작/목표(%), 도구 결과 한도, 이력·조회 결과 보관 용량, 대화 보관 시간·개수 |
| 서버 | 포트(재시작 필요)·대화 로그 보관 일수·관리자 인증 키(쓰기 전용) |

비밀값은 화면에 돌아오지 않는다 — 등록 여부만 보이고, 새 값을 넣거나 지울 수 있다. 저장은 다른 탭과 같이 버전(If-Match)을
대조해 다른 화면의 변경을 덮지 않는다.

### 3. 화면 개발 (Vite 개발 서버)

운영에는 위 실행 파일이 화면을 내장해 서빙하므로 이 단계가 필요 없다. 화면 코드를 고칠 때만 쓴다:

```bash
cd frontend && npm install && npm run dev
```

`http://localhost:5174` 접속(`FRONTEND_PORT`로 바꾼다. `/api`는 vite proxy로 백엔드(`127.0.0.1:5173`, 포트를 바꿨다면 `BACKEND_PORT`)에 전달).
개발 서버는 브라우저와의 웹소켓(`server.ws`)을 꺼 두었다 — 켜 두면 연결이 끊길 때(절전 복귀, 사내 프록시의 유휴 연결 정리,
서버 재시작) Vite가 페이지를 새로고침해 대화가 사라졌다. 그래서 코드를 고치면 브라우저를 직접 새로고침한다.
화면의 대화는 그 탭의 `sessionStorage`에 저장돼, 같은 탭을 새로고침하면 말풍선·이력·대화 번호가 되살아난다(새 탭은 새 대화).
탭 복제는 `sessionStorage`를 복사하므로, 복제된 탭은 말풍선·이력을 이어 받되 대화 번호는 새로 받는다 — 두 탭의 질문이 서버의 한 대화에
섞이거나 서로의 진행 중인 답을 취소하지 않는다(`chat-store.js`의 '열림' 표시, 떠날 때 `pagehide`로 지운다).

인프라(MariaDB·Oracle·Ollama)와 앱을 한 번에 올리고 내리려면 `./start_all.sh` / `./stop_all.sh`,
Windows는 `start_all.bat` / `stop_all.bat`을 쓴다(`--apps-only`는 앱만). Windows판은 MSI가 등록한 MariaDB 서비스
(이름이 다르면 `MARIADB_SERVICE`), Docker Desktop의 `oracle1521` 컨테이너, PATH의 `ollama`를 전제한다. 서비스 시작·중지에는
관리자 권한이 필요해서 일반 창에서 실행하면 UAC 확인이 한 번 뜨고, Docker Desktop이 꺼져 있으면 대신 띄우지 않고 Oracle만 건너뛴다.
`stop_all.bat`은 Ollama 트레이 앱까지 끝낸다(`setup/qwen3-embedding/stop.bat`과 같다).

`start_all.sh` 또는 각 앱의 `start.sh`로 실행하면 `backend/logs/backend.log`와
`frontend/logs/frontend.log`에 표준 출력·오류를 기록한다. UTC 날짜 기준 **오늘과 이전 2일분**만
보관하며(최대 72시간), 자정에 지난 로그를 `backend.log.YYYY-MM-DD` / `frontend.log.YYYY-MM-DD`로
분리하고 오래된 파일을 삭제한다. 출력이 없어도 실행 중에는 정리하며, 중지 중에는 다음 시작 때 정리한다.
최초 적용 시 기록별 날짜를 판별할 수 없는 기존 누적 로그는 삭제한다. 같은 날 재시작한 새 로그는 유지한다.
`tail -F backend/logs/backend.log`로 날짜가 바뀌어도 계속 추적할 수 있다. 날짜 기준 보관이므로
3일 안에 발생하는 로그의 총용량 제한은 없다. `cargo run` / `npm run dev`의 직접 실행은 콘솔 출력만 한다.
Windows의 `start.bat`(`start_all.bat`도 이것을 부른다)은 같은 파일에 덧붙이기만 하고 날짜별 정리는 하지 않는다.
로그 보관·종료 동작 검증: 저장소 루트에서 `node --test scripts/retained-log.test.cjs`.

#### 회귀 검증

```bash
cd backend && cargo test   # 청커·SQL 가드·바인드·NUMBER·설정·도구 한도·맥락 비우기·관리 API·답변 루프·MCP — DB 없이 1~2분
```

MCP 검사(`tests/mcp.rs`)는 `node`로 가짜 MCP 서버(`tests/fixtures/fake_mcp_server.mjs`)를 stdio·HTTP로 띄워 연결·호출·시간 초과와 취소·
호출 중 프로세스 죽음과 재연결·stdout 오염·stderr 폭주·도구 목록 변경·손자 프로세스 정리·SIGTERM 뒤 종료·버린 요청의 취소·환경 격리·관리 API를 잰다(node가 없으면 건너뛴다).

MariaDB·Oracle·임베딩이 필요한 통합 검사는 환경변수가 있을 때만 돈다(없으면 건너뛰었다고 찍는다).
검사마다 `llm_agent_rs_test_*` DB를 새로 만들어 `schema.sql`·`seed.sql`을 싣고 끝나면 지운다 — 운영 DB는 건드리지 않는다.

| 변수 | 켜지는 검사 |
|---|---|
| `LLM_AGENT_TEST_MARIADB=user:password@127.0.0.1:3306` | 관리 API 계약(버전·잠금·참조 검사)·HTTP·NDJSON·대화 로그·답변 루프(가짜 LLM) — CREATE/DROP DATABASE 권한이 있는 계정 |
| `LLM_AGENT_TEST_EMBEDDING=http://localhost:11434/v1` | 위 검사의 임베딩 동기화·의미 검색 (기본값이 이 주소다) |
| `LLM_AGENT_TEST_ORACLE=1` + `ORDER_DB_PASSWORD` + `ORACLE_CLIENT_LIB_DIR` | 실제 Oracle(아래 1-2단계 컨테이너)의 쿼리·REF CURSOR 프로시저·NUMBER 함수·자료형·취소 |

```bash
cd frontend
npm test          # 순수 함수의 계약(수식 판정·차트 파싱·표 채우기·trace/CSV·설정 변환·주소 규칙)과 띄운 것을 내리는 규칙 — 몇 초
npm run test:ui   # 화면 동작의 계약 — 진짜 Chrome을 headless로 띄운다 (약 2분)
npm run test:admin # 관리자 검색·페이지 이동·저장·인증·작은 화면, MCP 탭(상태·허용 도구·비밀값·연결 확인·보기 전용) 검증
npm run test:production # 현재 소스를 빌드하고 preview 서버에서 핵심 화면 동작을 검증
npm run test:all  # 위 넷과 수식 화면 검사를 차례로
npm run test:regression # 필수 전체 회귀 (Chrome 누락도 실패)
```

`npm run test:ui`는 단위 테스트가 닿지 못하는 것을 지킨다: 답이 길어질 때 대화가 언제 따라 내려가고
언제 가만히 있는가, 좁은 화면에서 원그래프 조각과 흐름도 글자가 어떻게 남는가, 인쇄에서 무엇이
풀리는가, 모델이 쓴 주소가 저절로 불려 나가지 않는가. 실제 진입점(`src/main.jsx`)을 그대로 띄우고
`/api/chat`만 가로채므로 서버도 모델도 필요 없다. Chrome이 없으면(`CHROME_PATH`로 지정할 수 있다)
조용히 건너뛰고, 검사가 끝나면 띄운 브라우저를 확인하고 내린다.

`test:production`은 테스트용 진입점 대신 실제 빌드된 페이지를 열어 대화·수식·차트·흐름도·조회 표와
후속 질문·홈 복귀를 확인한다. 결함 재현과 수정 내역은 [frontend 검토 기록](docs/frontend-audit.md)에 있다.

수식·Markdown·차트 관련 버그별 정식 테스트는 [회귀 검사 목록](docs/rendering-regressions.md)에 정리했다.
GitHub Actions는 모든 push/PR에서 백엔드의 `cargo test`를 실행하고, Windows에서 MCP 검사(`cargo test --test mcp`)를 따로 돌린다.
실제 DB나 LLM 서버는 사용하지 않는다. 프런트의 `test:regression`(Chrome 화면 검사)은 CI에서 빼고 로컬에서 돌린다.

#### 관리자 화면

상단 **관리자**를 누르면 기존 대화와 입력 중인 질문을 유지하면서 설정 화면을 연다.
**채팅으로**를 누르면 대화로 돌아간다. 다섯 탭에서 목록 검색과 항목 추가·수정·삭제를, **MCP** 탭에서 도구 서버를, **설정** 탭에서 서버 설정을 한다.

| 탭 | 관리 내용 | 검색 대상 |
| --- | --- | --- |
| DB | 조회 대상 Oracle DB의 이름·접속 주소·사용자명·비밀번호 | 이름·유형·접속 주소·사용자명 (비밀번호 제외) |
| 지식 | 제목·원문 | 제목·본문 |
| 방법 | 제목·Q&A 처리 절차 | 제목·처리 방법 본문 |
| 쿼리 | 이름·SQL·입력/출력 설명·대상 DB | 이름·SQL·모든 설명·대상 DB |
| 프로젝트 | 이름·설명·소스 폴더·참고 문서·포함/제외 패턴 (아래 '프로젝트 소스로 답하기') | 이름·설명·폴더 |
| MCP | 도구 서버의 연결(명령·HTTP)·허용 도구·비밀값과 연결 상태·도구별 호출 현황·최근 기록 (아래 'MCP 도구 서버로 도구 붙이기') | — |
| 설정 | 모델 연결·임베딩·관리 DB·Oracle·실행/컨텍스트·서버 (위 '설정 탭') | — |

검색은 서버에서 전체 데이터를 대상으로 부분 일치로 수행하며, 결과는 최근 등록순으로
20개씩 나눈다. `%`와 `_`도 검색어 그대로 취급한다. 쿼리의 대상 DB는 여러 개 선택할 수 있고
DB 선택 목록 안에서도 이름으로 검색할 수 있다. 검색 대상이 많아도 본문 전체를 브라우저로
내려받지 않으며 편집할 때 해당 항목만 읽는다.

- 저장한 원본은 MariaDB에 즉시 반영된다. 검색 색인은 임베딩 동기화 주기에 따라 갱신된다
  (기본 60초, 설정 탭에서 0으로 두면 `backend/target/release/llm-agent embed-sync`를 직접 실행).
- DB 탭의 비밀번호는 관리용 MariaDB가 아니라 **조회 대상 Oracle DB**의 비밀번호다. 조회 API에 포함하지 않으며, 수정 시 비워 두면 기존 값을 유지한다.
  운영 비밀번호는 기존 방식대로 `ENV:변수명`을 사용한다(값은 `backend/.env`나 프로세스 환경에서 읽는다).
- 실행 유형에서 쿼리·프로시저·함수를 선택한다. 쿼리는 SELECT/WITH, 루틴은 아래의 단일 호출 형식을 사용한다. 쿼리에서 사용 중인 DB, 처리 방법에서 언급한 쿼리는
  참조를 먼저 변경해야 삭제하거나 이름을 바꿀 수 있다. SQL로 직접 변경하는 작업은 이 검사와 별개다.
- 프로젝트는 MariaDB가 아니라 `backend/config.toml`에 저장된다. 폴더는 **폴더 선택**으로 서버 PC의 폴더를 고른다
  (브라우저는 서버의 파일 시스템을 볼 수 없으므로 목록은 서버가 준다). 저장할 때 폴더와 참고 문서가 실제로 있는지 확인한다.
- 저장 전 탭 전환·닫기·새로고침 시 변경 내용 유실을 확인하며, 저장 실패 시 입력 내용을 유지한다.
- 항목을 연 뒤 다른 화면에서 수정했다면 오래된 수정·삭제는 거부한다. 입력 내용을 보관하고 항목을
  다시 열어 최신 내용과 합친다. 서버를 재시작한 경우에도 항목을 다시 읽어야 한다.
- 설정 탭의 **관리자 인증 키**를 등록하면 관리자 API의 읽기·쓰기에 그 키가 필요하다(저장 즉시 적용).
  키는 브라우저 메모리에만 보관한다. 미등록 상태는 기존 페이지와 같은 사내망 전용 모드이며 사용자별 권한 관리는 제공하지 않는다.
  미등록 상태에서는 설정 탭으로 LLM API 키·관리 DB 비밀번호를 바꿀 수 있으므로, 사내망 밖에 열 때는 반드시 등록한다.

기존 설치의 앱 계정에 SELECT만 부여했다면 위의 관리 테이블 네 개에 대한
`GRANT INSERT, UPDATE, DELETE`도 적용한다. 권한이 없으면 화면에서 저장 오류를 안내한다.
기존 DB에 `schema.sql`을 다시 실행하지 않는다.

API: `/api/admin/{databases,knowledge,methods,queries,projects}`의 GET(검색 `q`, 페이지 `page`),
POST(추가), `/:id`의 GET/PUT/DELETE. 대상 DB 선택 목록은 `/api/admin/database-options`, 폴더 목록은
`/api/admin/directories?path=`, 설정은 `/api/admin/settings`의 GET/PUT과 연결 확인 `POST /api/admin/settings/check`
(`{target: llm|embedding|mariadb|oracle_client, config, secrets}` — 저장하지 않은 값으로 확인한다).
모든 요청은 `X-Admin-Request: 1`, 인증 키가 설정됐다면 `X-Admin-Token` 헤더가 필요하다.
PUT/DELETE에는 해당 항목 GET 응답의 `ETag`를 `If-Match` 헤더로 보낸다. 버전이 없으면 428,
이미 바뀌었으면 409로 응답하며 데이터는 변경하지 않는다. DB 비밀번호와 설정의 비밀값은 응답에 포함하지 않는다.

관리자 화면의 결함 재현과 수정·검증 범위는 [관리자 검토 기록](docs/admin-review.md)에 정리했다.

#### 다른 PC에서 접속하기

실행 파일은 모든 인터페이스(`0.0.0.0`)에 바인딩되므로 같은 망의 다른 PC에서 `http://<이 PC의 IP>:5173`(설정 탭의 서버 포트)로 들어온다.
아래 변수는 Vite 개발 서버(5174)로 열 때의 것이다 — 개발 서버는 모든 인터페이스에 바인딩되고, 백엔드는 vite가 `127.0.0.1:5173`으로 대신 호출한다.

| 변수 | 용도 |
|---|---|
| `FRONTEND_HOST` | 바인딩 주소. `localhost`로 주면 다시 이 PC에서만 열린다 |
| `FRONTEND_ALLOWED_HOSTS` | IP가 아니라 **도메인 이름**으로 붙을 때 그 이름을 쉼표로 나열. 없으면 vite가 `Blocked request`로 막는다 |

```bash
FRONTEND_ALLOWED_HOSTS=agent.corp.local npm run dev
```

안 열린다면 방화벽부터 본다 — macOS는 첫 기동 때 수신 연결 허용 여부를 묻고, Windows는
`제어판 > Windows Defender 방화벽`에서 해당 포트의 인바운드를 허용해야 한다.
그리고 화면에는 로그인이 없다(관리자 API만 인증 키를 쓴다) — 신뢰하는 사내망에서만 열고, 공인 IP에 그대로 노출하지 않는다.

#### 답변 안의 수식 (LaTeX)

답변의 LaTeX 수식을 KaTeX로 그린다. `frontend/src/remark-preserve-math.js`가 수식 원문을
보호하고, `math.js`가 렌더링한다. 표 셀·제목·목록·인용문 안에서도 같은 경로를 사용한다.

| 쓰는 법 | 결과 |
|---|---|
| `$v = d/t$` | 인라인 수식. 표 셀·제목·목록 안에서도 그린다 |
| `$$E=mc^2$$` | 별행 수식 |
| `$$` 를 **앞뒤 각각 독립된 줄**에 두고 그 사이 | 별행 수식(가운데 정렬). 말풍선보다 넓으면 그 안에서 가로 스크롤된다 |
| `\(...\)` | 인라인 수식 |
| `\[...\]` | 별행 수식 |
| ```` ```math ````·```` ```latex ````·```` ```tex ```` 코드펜스 | 별행 수식. 원문 자체를 보여 줄 때는 ```` ```text ````를 쓴다 |
| `$100`, `$ORACLE_HOME` | **수식이 아니다.** 그대로 나온다 |

판정을 remark-math에 맡기지 않는 이유는 그 옵션(`singleDollarTextMath`) 하나로는 양쪽이 다 깨지기
때문이다. 켜면 `비용은 $100 이고 수익은 $200 이다`의 가운데가 통째로 수식이 되어 문장이 사라지고
(표 안에서 일어나면 행이 무너진다), 끄면 모델이 가장 흔히 쓰는 `$v = d/t$`가 원문 그대로 노출된다.
`\( \)` · `\[ \]`는 어느 쪽이든 markdown의 백슬래시 이스케이프에 먼저 먹혀 `( )` · `[ ]`만 남는다.

Markdown 파싱과 공통 구조 분석이 코드·주소·문단·표 행의 경계를 제공한다. 머리글의
수식·시각화에 파이프가 있어도 내부 언어의 열 구분자를 먼저 보호해 표를 발견한다.
그 좌표로 원문에서 수식을 추출해 보호한 뒤 Markdown을 다시 파싱한다. 수식 안의 `|`·`_`·`*` 때문에 표가 갈라지거나 수식이
강조로 바뀌지 않는다. 구분자 안의 앞뒤 공백도 허용한다. 홑 `$`는 문단·표 행을 넘어 짝짓지
않으며, 통화·환경변수·코드·주소는 수식으로 바꾸지 않는다.

수식 경계 인식과 LaTeX 문법 검증은 분리한다. 중괄호가 틀려도 구분자로 감싼 원문은 먼저
보호하고 KaTeX에서 검증한다. 표에서 닫는 구분자가 없는 명확한 TeX 입력은 `shared/table-math.mjs`가
표의 열 수와 이웃 수식을 기준으로 해당 셀에 격리한다. 미지원·불완전한 수식은 접힌 원문 보기로
안내하며, 분모나 식의 내용을 임의로 채우지 않는다.

문자 `\n`·`\r\n`으로 직렬화된 표도 복원 전에 행 경계를 확인한다. 서로 다른 행의
미완성 코드·링크·이미지·수식이 다음 행의 조회나 그림을 소유하지 않는다. 조회 표 채우기(`answer-fill.js`)와
화면이 [같은 원문 분석](docs/serialized-table-ownership-review.md)을 사용하며, TeX의 제어
단어와 사용자 매크로, 코드·주소 안의 표 예시는 원문으로 보존한다.

새 수식을 생성할 때는 표의 절댓값에 `\lvert x\rvert`, 노름에 `\lVert x\rVert`, 조건부 확률에
`\mid`를 쓰도록 안내한다. 기존 답변의 raw `|`도 수식 경계 안에서는 보존한다. 호환 환경과
검증 범위는 [수식 표시 개선 기록](docs/math-rendering-review.md)에 정리했다. `frontend`에서
`npm test`로 실제 ReactMarkdown·KaTeX 렌더링을, `npm run test:ui`로 화면을 검증한다.

알고 있어야 할 두 가지.

- **넓은 수식은 해당 컨테이너 안에서 가로 스크롤한다.** 별행 수식뿐 아니라 문단·제목·중첩 목록·링크의
  인라인 수식도 실제 줄 폭보다 넓을 때만 스크롤 영역으로 전환한다. 짧은 수식의 기준선과 줄 높이,
  KaTeX가 허용하는 자연스러운 줄바꿈은 유지한다. 표 안에서는 표의 기존 스크롤을 사용한다.
  화면 크기와 글꼴 로딩에 맞춰 다시 측정하고, 인쇄에서는 넓은 인라인 수식의 전체 폭에 축척을 맞춘다.
  세로로 과도하게 큰 수식(`\rule{500em}`)은 KaTeX의 `maxSize`로 제한한다.
- **답변은 JSON 문자열이 아니다 — LaTeX는 백슬래시 하나로 적는다** (`\frac`). 예전 백엔드는 답변을 JSON 결정 안에
  실어 받았기 때문에 `\frac`·`\times`의 백슬래시가 폼피드·탭 같은 이스케이프로 먹혀 `rac`·`imes`만 남거나 답변 전체가
  파싱에서 떨어지는 일을 따로 막아야 했다. 지금은 모델이 도구 없이 낸 일반 텍스트가 그대로 답변이므로 그 부류의 손실이 없다.

표기를 늘리거나 줄이려면 `math.js`(판정)와 백엔드 시스템 프롬프트(모델에게 알리는 표기)를 **함께**
본다 — 프롬프트는 모델이 어떤 표기를 고르게 할지만 정할 뿐, 실제로 그려지는 범위는 `math.js`가 정한다.

닫히지 않은 `$$`(토큰 한도로 잘린 응답)는 남은 답변을 통째로 수식으로 삼키므로 글자로 되돌린다.
완성된 수식 내부의 `*`나 백틱은 TeX 원문으로 보존한다. 일반 Markdown 코드 예시는
수식으로 재해석하지 않으며, KaTeX가 지원하지 않는 수식은 원문 보기로 남긴다.

#### 답변 안의 차트·흐름도

답변의 ```` ```chart ```` 코드블록은 그래프(Recharts)로, ```` ```mermaid ```` 코드블록은 흐름도(Mermaid)로
그린다. 모델에게 언제 어떻게 쓰는지는 백엔드 시스템 프롬프트(`backend/src/context.rs`)가 알려 주고, 무엇을 차트로 받아들이는지는
`frontend/src/chart.js`가 정한다. 그리는 쪽(`Chart.jsx`·`Mermaid.jsx`, recharts·mermaid 번들)은 첫
차트·흐름도가 나올 때 내려받는다 — 글과 표뿐인 대화는 그 비용을 치르지 않는다.

```chart
type: bar
title: 월별 처리 건수
x: 월
y: 건수, 금액
y2: 성공률
| 월 | 건수 | 금액 | 성공률 |
|---|---|---|---|
| 2024-01 | 120 | 30500 | 97.5 |
| 2024-02 | 95 | 21000 | 98.1 |
```

| 줄 | 뜻 |
|---|---|
| `type:` | `bar` · `stacked-bar` · `line` · `area` · `pie` · `scatter`. 모르는 이름은 `bar` (column·donut 같은 별칭은 알아듣는다) |
| `title:` | 차트 제목 (80자) |
| `x:` | 가로축 열 이름. 없으면 첫 열 |
| `y:` | 값 열(쉼표로 여럿). 없으면(또는 적은 이름이 표에 없으면) x 밖의 **숫자 열 전부**. 적은 열이 표에 있는데 숫자 열이 아니면 다른 열로 바꿔 그리지 않고 표를 보인다 |
| `y2:` | 오른쪽 축에 **선으로 겹칠** 열 (단위가 다른 값 — 건수 위의 비율 등). 최대 2개 |
| `xtype:` | `time` · `number` · `category`. 없으면 line·area·scatter에서 x가 전부 날짜면 시간축, scatter에서 전부 숫자면 수치축, 그 밖은 범주. 명시한 축으로 읽지 못한 행은 빼고 그 수를 차트 아래에 적는다 |
| `data: step N` | 표 대신 **쿼리 실행 이력 N번의 결과**를 쓴다 (아래) |
| GFM 표 | 값은 조회 결과 그대로. `1,000` · `10 000` · `12%` · `₩3,000`은 숫자로 읽고 `12건` · `2024 01` · `1,2` · `-` · 빈칸은 결측(0이 아니다) — 쉼표·공백은 세 자리 묶음일 때만 구분자다 |

설정은 전부 따옴표 없는 `이름: 값` 한 줄이고 표는 GFM 그대로다 — 셀 안의 파이프는 `\|`, 역슬래시는
`\\`로 적는다(GFM 규칙; `data: step N`으로 채우는 표도 그렇게 적고, 화면은 그 둘을 되돌려 읽는다). JSON을 쓰지 않는 이유는
모델이 따옴표·중괄호의 이스케이프를 한 번만 어긋나게 적어도 블록 전체가 파싱에서 떨어지기 때문이다. 이 모양은 따옴표가 한 개도 없다.

**`data: step N`** — 모델은 조회 결과를 미리보기 행(기본 20)과 `result_read`로 읽은 만큼만 본다. 수백 행짜리
결과를 그리려면 값을 답변에 옮겨 적어야 하는데, 보지 못한 행은 적을 수 없고 본 행도 옮기는 동안 값이
바뀐다. 그래서 답변에는 조회 번호만 적게 하고, 화면(`frontend/src/answer-fill.js`)이 `done`에 실려 온 전체 행
(≤1,000, `MAX_ROWS`)으로 표를 채운다. 번호는 `query_run`이 돌려준 `step`(대화 전체에 이어 매기는 번호)이며
실패한 조회도 번호를 차지한다. `x`·`y`·`y2`를 함께 적으면 그 열만 싣고,
없으면 앞의 8열이다. 채우지 못한 참조(없는 번호, 실패한 실행, 0건)는 블록 대신 짧은 안내 문장이 된다.
블록 하나에 싣는 행은 100까지(`MAX_CHART_BLOCK_ROWS` — 화면이 그리는 행 수와 같다; 그 위는 그려지지도
않으면서 답변만 키운다), 답변 하나의 표 총량은 30,000자까지(`MAX_CHART_INJECT_LEN`)다. 총량은 채울 블록
수로 **나눠서** 준다 — 첫 블록이 다 쓰고 둘째 차트가 안내 문장이 되지 않게(남은 몫은 다음 블록으로
넘어간다). 잘라 실은 블록은 차트 아래에 그 사실을 적는다.

화면 규칙 몇 가지. 차트 아래에는 늘 **'표로 보기'**가 접혀 있다(그래프로는 정확한 값·잘린 라벨·그리지
않은 열을 읽을 수 없다; 셀의 URL은 새 탭에서 열린다). 범주가 13개 이상인 막대는 가로로 눕히고, 원그래프는
12조각을 넘으면 **값이 큰** 11조각을 남기고 나머지를 '기타'로 모은다(표 순서의 꼬리가 아니다 — 이름순
결과에서 큰 조각이 기타에 묻히지 않게). 한 메시지에 차트는 4개까지 그리고 그 뒤는 표다. 시리즈는 6개(y2
포함), 그리는 행은 100까지(넘는 행은 차트 아래에 밝힌다). 조회된 행 전부는 ⚡ 실행된 쿼리 패널에 있다(아래).

**실패 방향은 한쪽으로만 열려 있다** — 차트로 읽지 못하면(숫자 열이 없다, `y`로 지정한 열이 숫자 열이
아니다, 산점도의 x가 수치가 아니다, 선·영역 그래프에서 같은 x에 행이 여럿이다 — 피벗되지 않은 결과를
`x: 일자`로 그리면 선이 같은 시각에서 오르내린다 —, 그리는 중에 예외가 났다) 그 블록은 **안의 표를
그대로** 보여준다. 반대로 어설프게 그리면 숫자가 아닌 값이 0으로, 문자열 날짜가 범주로 그려진 그래프가
'데이터'로 읽힌다. 그래서 숫자로 읽히지 않는 값은 0이 아니라 빈칸이고, 그릴 것이 하나도 없으면 차트를
포기한다. 서버가 대화를 잃었을 때 쓰라고 함께 보내는 이력 텍스트에서는
펜스와 설정 줄을 벗기고 표만(20행) 남긴다 — 모델의 다음 턴에 필요한 것은 무슨 값을 보여줬는가이지 그것을
어떻게 그렸는가가 아니다. `frontend`의 `npm test`로 회귀 검증한다
(`frontend/test/chart.test.js`, `frontend/test/answer-fill.test.js`).

**Mermaid** — 절차·흐름·상태 전이 설명에 `flowchart TD` · `sequenceDiagram` 등을 쓴다.
`securityLevel: 'strict'`로 그리므로 라벨의 HTML은 글자로 취급되고, 문법이 틀리면 그림 대신 **코드 원문이
그대로** 보인다(오류 그림을 끼워 넣지 않는다). 노드 글자는 `A[글자]`처럼 따옴표 없이, 괄호·따옴표·
세미콜론 같은 특수문자는 피하는 것이 안전하다.

블록 문법을 바꾸려면 세 곳을 함께 본다 — `frontend/src/chart.js`(판정), `frontend/src/answer-fill.js`(참조
채우기), `backend/src/context.rs`의 시스템 프롬프트(모델에게 알리는 표기).

#### 조회 결과 전체 보기 (⚡ 실행된 쿼리 패널)

모델은 조회 결과를 미리보기 행(기본 20, 최대 100)과 `result_read`로 읽은 행만 보고 그중 몇 행만 답변에 옮겨 적는다. 조회된 행
**전부**(드라이버 상한 `MAX_ROWS` = 1,000건까지)는 답변 아래 **⚡ 패널**에 있다 (검색·조회·소스 읽기를 함께 세어
"검색 1회 · 실행된 쿼리 2건 · 자료·소스 읽기 3회"로 보인다). 줄 앞의 번호는 `query_run`이 돌려준 step과 같은 값이라, 답변이
"2번 조회 결과"라고 말하면 패널의 2번이 그것이다 — 스텝마다
쿼리 이름`@`대상 DB·바인드 값과 함께 행 전체를 표(세로·가로 스크롤, 머리글 고정)로 싣고, **CSV 내려받기**로
파일(UTF-8 BOM, 엑셀에서 바로 열림)로 받을 수 있다. 상한에 걸린 결과는 "N건 이상 — 조회 상한에 걸려
처음 N건만"으로 표시한다(실제는 더 많다). 오류 스텝은 우리가 만든 문구만 보이고 드라이버 원문은 로그에만
남는다. 지식·처리 방법·소스를 읽은 줄은 한 줄 요약(예: `[llm_agent] 파일 읽기 backend/src/search.rs`)으로 남는다.
서버 쪽 정리는 `backend/src/agent.rs`(`execute_batch`), 화면의 표·CSV 규칙은 `frontend/src/trace.js`.
`chat_log`의 `steps`에는 20행과 전체 행 수(`totalRows`)만 남는다(로그는 분석용 표본이면 된다).

## 데모 시나리오 (seed 데이터 기준)

tool calling을 지원하는 실제 모델이 필요하다(예전 Node 백엔드의 규칙 기반 `LLM_PROVIDER=mock`은 옮기지 않았다).
Oracle은 설정 탭의 mock을 켜면 데모 쿼리 5개가 고정된 행을 돌려준다.

| 질문 | 동작 |
|---|---|
| 배치 재시작 방법 알려줘 | 쿼리 0회 — `search` → `knowledge_read`로 지식만 읽고 답변 |
| BATCH001 작업 상태 알려줘 | `search` → `method_read` → `query_run batch_job_status` → FAILED 결과 + 재시작 지식 결합 답변 |
| 홍길동 고객 주문 상태 알려줘 | 2단계 — `find_customer_id` 결과의 CUSTOMER_ID로 `order_status_by_customer` 실행 |
| 홍길동 주문 목록을 프로시저로 조회해줘 | `get_customer_orders_proc` 1회 — `GET_CUSTOMER_ORDERS`의 OUT REF CURSOR 결과 |
| 홍길동 주문 합계를 함수로 계산해줘 | `get_customer_order_total_fn` 1회 — `GET_CUSTOMER_ORDER_TOTAL`의 NUMBER 반환값 |
| 오늘 며칠이야 | 쿼리 0회. 매 요청 끝에 실린 현재 시각(KST, 요일 포함)으로 바로 답한다. "어제", "이번 주" 같은 상대 날짜도 같은 값을 기준으로 절대 날짜로 바꾼다 (`today_date`는 DB 서버 시각 자체를 확인할 때만 실행된다) |
| 실패한 배치 다 보여줘 | `batch_list_by_status` 1회. `qa_method` 없이 쿼리 설명(`query_desc`)만으로 선택되는 경로B 데모 |
| 쿠버네티스가 뭐야 (등록되지 않은 질문) | `search`로 찾아본 뒤 LLM의 일반 지식으로 답변 — "*등록된 지식에 없는 내용이라 일반 지식으로 답변합니다.*" 표시가 붙음. 아무것도 찾아보지 않고 답의 첫 줄을 이 문구로 열면 서버가 화면에 보내기 전에 멈추고 먼저 찾게 한다(context.md 7절) |
| (위 질문에 이어) 그럼 BATCH002는? | 후속 질문 — 서버가 들고 있는 대화에서 "배치 상태 조회"였음을 보고 BATCH002로 재조회 |
| (위 질문에 이어) 재시작은 어떻게 해? | 후속 질문 — 이미 읽은 지식과 조회 결과로 답한다(다시 찾지 않는다) |
| 검색 문턱은 어디서 정해? (이 저장소를 프로젝트로 등록했을 때) | 프로젝트의 참고 문서 → `source_search` → `file_read`로 `backend/src/config.rs`의 `max_distance`를 찾아 `경로:줄` 근거로 답한다 |

등록된 지식·쿼리 결과가 있으면 반드시 그것에 근거해 답하고, 전혀 없을 때만 LLM 일반 지식으로 답한다. 일반 지식 답변에서도 사내 시스템의 구체적 상태(수치·상태값 등)는 지어내지 않도록 프롬프트로 제한한다 (`backend/src/context.rs`의 시스템 프롬프트).

요청은 MnemoArc와 같은 모양이다: **고정 시스템 프롬프트 → 대화 이력 묶음(이전 턴의 도구 결과 포함) → 맨 끝의 실행 상태 한 줄**
(남은 시간·안내, 현재 시각 KST, 지금 질문, 프로젝트 목록, 검색 가능 여부). 요청마다 바뀌는 것을 끝으로 몰아
앞부분이 라운드 사이에 같은 토큰열로 남게(vLLM·OpenRouter prefix caching) 하고, 시스템 프롬프트에는 요청마다 달라지는 값을 싣지 않는다.

```bash
curl -s localhost:5173/api/chat -H 'Content-Type: application/json' -d '{"message":"홍길동 고객 주문 상태 알려줘"}'
```

### 답변 안의 표 — 참조로 적고 화면이 채운다

조회 결과를 표로 보일 때 모델은 값을 옮겨 적지 않는다. 20행 × 6열이면 수백에서 천 토큰을 한 글자씩 생성해야 하고
그 출력이 답변 지연의 큰 몫이었다(출력 토큰은 prefill보다 수십 배 느리다). 대신 참조 한 줄을 적는다:

````
```table
step: 2
cols: JOB_ID, STATUS, LAST_RUN_AT
limit: 20
```
````

참조가 없는 ```` ```table ```` 블록은 펜스만 벗겨 본문을 그대로 내보낸다(모델이 표를 손수 적었으면 표로 보인다).
화면(`frontend/src/answer-fill.js` `fillAnswer`)이 `done`의 `trace`·`refs`에 실린 그 실행의 결과 행으로 GFM 표를 만들어 블록을 통째로 바꾼다 —
차트의 `data: step N`과 같은 기제다. `step`은 `query_run`이 돌려준 번호(대화 전체에 이어 매기므로 이전 턴의 조회도 가리킬 수 있다 —
서버가 그 행을 `refs`로 함께 보낸다), `cols`는 보일 열(생략하면 앞 10열), `limit`은 행 수(생략하면 30, 최대 100).
다 싣지 못하면 표 아래에 밝히고, 전부는 ⚡ 패널에 있다. 옮겨 적다 틀리는 값(반올림·자릿수 누락)도 사라진다.
서버의 대화 이력에는 채우지 않은 참조 원문이 남는다 — 다음 턴의 맥락이 표 크기만큼 커지지 않는다.

### 진행 상황 스트림 (`POST /api/chat`)

본문은 `{message, history?, conversation_id?}`다. `conversation_id`(영문·숫자·`_`·`-` 100자 이내)가 같으면 서버가 들고 있는
대화를 이어 가고, 없으면 그 요청 한 번짜리 대화다. `history`(최근 6턴의 `{role, text}`)는 서버가 그 대화를 잃었을 때만 쓴다.
같은 대화에 새 요청이 오면 진행 중이던 요청을 멈추고 이어 받는다(정지 직후 재질문). 멈춘 답변이 그때까지 화면에 보낸
부분은 다음 질문의 맥락에 남는다(화면도 보인 조각을 이력으로 보낸다). 도구 실행 중에 멈추면 그 응답의 도구 호출과 결과(멈춘
호출은 `cancelled`, 서버에 간 MCP 호출은 효과가 이미 났을 수 있다는 말과 함께)도 남는다 — MCP 도구는 이미 효과를 냈을 수 있어,
다음 질문이 모르고 다시 부르지 않게 한다.

검색·조회가 시작되는 순간 화면에 보이도록 응답을 흘려보낼 수 있다. 클라이언트가 `Accept: application/x-ndjson`을
보내면 한 줄에 이벤트 하나(NDJSON)로 답하고, 없으면 위 curl처럼 JSON 하나로 답한다 — 마지막 `done` 줄의 본문이
그 JSON과 같다.

```bash
curl -sN localhost:5173/api/chat -H 'Content-Type: application/json' -H 'Accept: application/x-ndjson' \
  -d '{"message":"BATCH001 작업 상태 알려줘","conversation_id":"demo-1"}'
# {"type":"search","id":1,"text":"BATCH001 배치 상태","targets":["qa_method","query"]}
# {"type":"search_done","id":1,"text":"…","targets":[…],"hits":{"qaMethods":1,"queries":3}}
# {"type":"tool","id":2,"name":"method_read","summary":"처리 방법 읽기 m3"}
# {"type":"tool_done","id":2,"name":"method_read","status":"ok","ms":12}
# {"type":"run_query","id":3,"query_name":"batch_job_status","params":{"job_id":"BATCH001"},"targetDb":"ORDER_DB"}
# {"type":"run_query_done","id":3,"query_name":"batch_job_status","targetDb":"ORDER_DB","rowCount":1}
# {"type":"answer_delta","text":"BATCH001은 "}
# {"type":"done","answer":"…","trace":[…]}
```

| type | 시점 | 실리는 것 |
|---|---|---|
| `search` / `search_done` | 검색 시작 / 끝 | 짝 번호(`id`), 검색어, 대상, 대상별 적중 수(`hits`), 검색이 성립하지 않은 대상(`failed`) |
| `run_query` / `run_query_done` | 조회 시작 / 끝 | 짝 번호, 쿼리 이름, 바인드, 대상 DB, 건수 또는 화면용 오류 문구 (한 응답의 여러 조회는 병렬, 항목마다) |
| `tool` / `tool_done` | 그 밖의 도구(지식·처리 방법·쿼리 정의·결과 읽기·소스·MCP) 시작 / 끝 | 짝 번호, 도구 이름, 한 줄 요약(시작 — MCP 도구는 `서버 · 도구 "첫 문자열 인수"`), `status`(`ok`/`error`/`cancelled`)와 소요 ms(끝) |
| `answer_delta` / `answer_reset` | 모델이 글을 쓰는 동안 | 답변 조각. reset은 앞선 조각을 버리라는 뜻이다 — 모델이 글을 쓰다 도구를 부르기로 했거나, 빈 응답이었거나, 재시도했을 때. 출력 한도에서 끊긴 답의 조각은 버리지 않고 이어 쓴 글이 뒤에 붙는다(이어 쓰다 실패해 쓴 데까지가 답이 될 때 그 응답이 보인 글도). 이어 쓰던 중에 reset하면 그때까지의 조각을 delta 하나로 다시 보낸다. 질문에서 아직 아무것도 찾아보지 않았으면 답의 첫 줄이 일반 지식 문구인지 정해질 때까지(줄이 끝나거나 60자, 앞의 빈 줄·짧은 제목 줄은 합쳐 240자까지) 보내지 않고 모아 두었다가 한꺼번에 보낸다(그 사이 멈추면 보내지 않고, 멈춘 답으로 남기지도 않는다). 그 문구 때문에 보낸 조각을 reset하지는 않는다 |
| `done` | 마지막 | `{answer, trace, refs?}` — JSON 응답과 같다. `answer`는 참조를 채우기 전 원문이고 화면이 채운다. `refs`는 답변이 가리킨 이전 턴 조회의 행 |
| `error` | 헤더가 나간 뒤 실패 | `{error}` |

화면(`frontend/src/stream.js`)은 조각 경계와 예전 JSON 응답을 같은 함수로 읽고, 답을 기다리는 말풍선에 진행 줄을
세웠다가 답이 오면 같은 내용을 ⚡ 패널에 남긴다. 답변 조각은 미리보기로 그려지는데(`preview.js`), 표·차트·그림
블록은 done 뒤에야 성립하므로 그 자리는 안내 한 줄로 바꾼다. 연결이 끊기면(정지·창 닫기) 서버는 모델 요청과
Oracle 실행(`break`)을 멈추고, 관리 DB를 기다리던 검색·지식·처리 방법·쿼리 정의 읽기도 그 자리에서 그만둔다(쿼리마다
관리 DB 한도(30초)까지 기다리던 동안 같은 대화의 다음 질문도 기다렸다). 프록시가 본문을 모아 두면 스트림의 뜻이 사라진다 — nginx는
`X-Accel-Buffering: no`를 서버가 보내고, 다른 프록시는 `Cache-Control: no-transform`을 본다.

## 도구 — 얼마나 가져갈지는 모델이 정한다

예전에는 검색 3회·결과 20건·조회 5건처럼 범위가 고정이었다. 이제 모델이 MnemoArc의 도구처럼 **찾고 나서 읽고**,
개수·위치·이어 읽기를 스스로 정한다. 런타임은 기본값과 상한만 지키고, 상한으로 줄인 값은 결과의 `adjusted_arguments`로 알린다.
결과 하나는 도구 결과 한도(기본 25,000토큰, 컨텍스트가 작으면 그 1/8) 안으로 줄이고 줄인 결과에는 이어 읽을 커서·offset을 붙인다.
Claude Code·opencode처럼 결과마다 따로 받고 호출 수로 나누지 않는다 — 한 응답의 결과가 맥락에 다 들어가지 않을 때만 큰 결과부터 줄인다.
한 응답에 넣은 여러 호출은 병렬로 실행하고, 같은 범위를 거듭 읽으면 막는다. 한 응답 안의 같은 MCP 호출(같은 도구·같은 인수)은 하나만
실행한다 — 모델의 병렬 호출은 가끔 같은 호출을 두 번 담는데, 이슈 생성처럼 효과가 있는 도구가 두 번 돌면 안 된다.
한 응답의 호출은 모두 실행한다 — 256개를 넘는 응답만 잘못된 응답으로 본다. 다만 호출 자체(인수와 그 앞의 글)에 결과마다 최소
크기(200토큰)를 더하면 남은 맥락을 넘는 응답은 하나도 실행하지 않고, 인수나 호출 수를 줄여 다시 하라고 청한다 — 실행해도 결과가
담기지 않아 질문이 끝나는데, MCP 도구는 그 전에 효과를 낸다(올릴 문서 같은 큰 인수). 같은 도구가 거듭 실패해도 막지 않고, 같은 인자로
같은 실패를 되풀이할 때만 경고를 붙인다.

| 도구 | 하는 일 | 기본 / 상한 |
|---|---|---|
| `search` | 지식(청크 구간)·처리 방법·쿼리를 의미 검색. 대상(`targets`)·`limit`·`offset`을 고른다. 요약과 ID(`k12`·`m3`·쿼리명)만 준다. 쿼리명 정확 일치는 맨 앞, 첫 페이지에는 제목(쿼리는 이름·설명)에 낱말이 든 항목(`title_match`, 최대 5건)이 그다음 | 대상별 10 / 50건 |
| `knowledge_read` | 지식 문서를 처음부터 결과 한도까지 통째 청크로 읽는다. 긴 문서는 `cursor`로 잇거나 검색의 `matched_chunks`를 `start_chunk`로 | 결과 한도 / 500청크 |
| `method_read` | 처리 방법 전문 + 본문이 지목한 쿼리의 요약(이름·용도·입력·대상 DB) | 한 번에 10건 |
| `query_describe` | 쿼리의 실행 유형·바인드·입력/출력 설명·대상 DB·SQL | 한 번에 10건 |
| `query_run` | 등록 쿼리 실행. 결과는 `step` 번호와 미리보기 행. 대상 DB가 여럿이면 `target_db`로 고른다 | 미리보기 20 / 100행 |
| `result_read` | 보관된 조회 결과의 다른 행·열을 읽는다(DB 재실행 없음) | 50 / 200행 |
| `file_list`·`source_search`·`code_outline`·`symbol_search`·`symbol_relations`·`symbol_read`·`file_read` | 프로젝트 소스 읽기(아래) | MnemoArc 기본값, `file_read`는 2,000줄 |
| `history` | 지난 질문·답·도구 결과(맥락에서 빠진 것 포함)를 찾고 다시 읽기. 무언가 맥락에서 빠진 뒤에 생긴다 | — |
| `서버__도구` | 연결된 MCP 서버의 도구 중 허용한 것(아래 'MCP 도구 서버로 도구 붙이기') | 서버가 정한다, 결과는 같은 한도 |

보호 장치는 예전 것을 이어받았다 — 한 질문 안에서 같은 쿼리·대상 DB·바인드의 반복 실행 거절(다음 질문에서는 다시
실행해 지금 값을 받는다), 화면에서 잘린 값(`…(생략)`)을 바인드로 옮겨 적으면 거절, 대상 DB 후보가 여럿인데 고르지 않으면
후보와 함께 거절, 드라이버 오류 원문은 모델에만 주고 화면에는 우리가 만든 문구만. 쿼리 실행은 질문의 등록 쿼리 이름과
바인드 값만 받는다 — 모델은 SQL을 쓰지 못한다.

## 프로젝트 소스로 답하기

관리자 화면 **프로젝트** 탭에 프로젝트를 등록하면 그 소스를 근거로도 답한다.

| 항목 | 뜻 |
|---|---|
| 이름 | 모델이 도구에 적는 프로젝트 이름(고유) |
| 설명 | 모델이 질문에 맞는 프로젝트를 고르는 근거 — 어떤 시스템·업무의 소스인지 적는다 |
| 소스 폴더 | 서버 PC의 절대 경로(폴더 선택으로 고른다) |
| 참고 문서 | 먼저 읽을 md 문서(한 줄에 하나, 폴더 기준 상대 경로 또는 절대 경로 — 폴더 밖 문서도 여기 적은 것만 읽힌다) |
| 포함 / 제외 | glob 패턴(한 줄에 하나). 비우면 전부 / 없음. `.git`·`node_modules`·`target` 같은 빌드·도구 폴더는 늘 뺀다 |

모델은 실행 상태에 실린 프로젝트 목록(이름·설명·참고 문서)을 보고 프로젝트를 고른 뒤, 참고 문서 → `source_search`·`symbol_search`
→ `file_read`·`symbol_read` 순으로 좁혀 읽고 `경로:시작-끝` 줄 번호로 근거를 단다. 프로젝트가 하나면 이름을 생략해도 된다. 둘 이상이면 도구 정의가 `project`를 필수로 요구하고(설정된 이름 중 선택),
그래도 빠진 호출은 경로가 한 프로젝트에만 있을 때 그 프로젝트로 실행한다.
구조 도구(`code_outline`·`symbol_*`)는 같은 파일을 다시 볼 때를 위해 최근 구문 트리 몇 개(원본 합계 4MiB까지)를 남기고,
5분 동안 쓰이지 않은 트리는 버린다(1분마다 확인) — 트리는 원본 1바이트에 40~130바이트라 4MiB 파일 하나가 170~520MiB다.
도구는 전부 읽기 전용이다 — 파일 쓰기·명령 실행·DB 쓰기 도구는 없다. 경로는 정규화한 뒤 소스 폴더 안이어야 하고
(심볼릭 링크·`..`로 밖에 나가면 거절), 예외는 그 프로젝트의 참고 문서로 적은 정확한 파일뿐이다. 서버 프로세스가 읽을 수 있는
폴더만 등록할 수 있으므로, 비밀이 든 폴더(`.env`·키 파일)는 제외 패턴에 적거나 등록하지 않는다.

## MCP 도구 서버로 도구 붙이기

에이전트가 쓰는 도구를 코드 수정 없이 늘린다. MCP(Model Context Protocol) 서버를 등록하면 그 서버가 내놓는 도구 중
**허용한 것만** `서버__도구` 이름으로 모델에 보인다. 설계와 결정 근거는 [MCP 설계](docs/mcp-design.md)에 있다.

```toml
# backend/config.toml — 직접 고치면 재시작해야 반영된다(관리자 화면 MCP 탭은 저장 즉시 반영)
[[mcp_servers]]
name = "jira"                       # 영문자로 시작, 영문·숫자·-·_ 24자 이하("__" 금지, "_"로 끝나지 않음) — 도구 이름 앞부분
description = "사내 Jira 이슈 조회"  # 모델이 서버를 고르는 근거(시스템 프롬프트에 실린다)
command = "npx"                     # 명령 실행(stdio, 상대 경로는 cwd 기준) — 또는 url = "http://…/mcp" (Streamable HTTP)
args = ["-y", "jira-mcp-server"]
tools = ["search_issues", "get_issue"]  # 허용 도구(서버의 이름 또는 jira__search_issues). ["*"]는 전부, 비우면 하나도 안 보인다
timeout_secs = 30                   # 호출 한도. 비우면 설정의 도구 시간 한도
disable_proxy = true                # 프록시 사용 안 함(기본 false) — HTTP는 HTTP_PROXY 등을 거치지 않고 바로 접속, 명령은 프록시 변수 대신 NO_PROXY=*

[mcp_servers.env]
JIRA_URL = "https://jira.example.com"
JIRA_TOKEN = "ENV:JIRA_TOKEN"       # ENV:이름 = backend 환경변수(.env 포함)에서 읽는다
```

- **연결 방식**: 명령 실행(stdio)과 Streamable HTTP(`url` + `headers`). 공식 Rust SDK(`rmcp`)를 쓴다. 서버가 보내는 sampling 요청은
  지원하지 않는다고, 사용자 입력 요청(elicitation)은 거절로 답한다 — 이 화면에는 도중에 사용자에게 묻는 창이 없다.
- **비밀값**: 토큰처럼 숨길 환경변수·헤더는 MCP 탭의 비밀값에 넣는다.
  - `config.credentials.json`의 `mcp.<서버>`에 저장되고 화면에 다시 보이지 않는다.
  - 같은 이름의 일반 값보다 우선한다(헤더는 대소문자를 가리지 않는다). 파일로 관리할 때는 `ENV:이름` 참조를 쓴다.
  - HTTP 주소의 호스트를 바꾸면 저장된 비밀 헤더는 새 주소로 가지 않는다. 다시 넣거나 지워야 저장된다(주소 오타로 토큰이 새는 것을 막는다).
- **명령의 환경**: backend의 환경변수를 통째로 넘기지 않는다(`.env`의 DB 비밀번호가 따라간다). PATH·HOME·USERPROFILE·TEMP·
  SYSTEMROOT·프록시·CA 인증서 변수처럼 실행에 필요한 것만 상속하고 설정한 `env`를 더한다.
- **프록시 사용 안 함**(`disable_proxy`, MCP 탭의 체크박스): 사내 서버처럼 프록시를 거치면 안 되는 서버에 쓴다. HTTP 서버는 backend 환경변수
  (`HTTP_PROXY`·`HTTPS_PROXY`·`ALL_PROXY`, `.env` 포함)의 프록시를 무시하고 바로 접속한다. 명령은 프록시 변수를 상속하지 않고 `NO_PROXY=*`를 받는다
  (macOS·Windows의 시스템 프록시를 읽는 Python 등도 바로 접속한다). 서버의 `env`에 `NO_PROXY`나 프록시 변수를 적으면 그것이 우선한다.
- **질문 하나 동안 같은 도구**: 질문이 시작될 때 연결된 서버의 허용 도구를 정해, 그 질문의 모든 요청에 같은 정의를 보낸다(제공자 프롬프트 캐시가 유지된다).
  - 도구 설명 속 같은 서버의 다른 도구 이름은 모델이 보는 이름(`exa__web_fetch_exa`)으로 바꿔 싣는다. 모델이 원래 이름으로 부르면, 그 이름의 도구가 하나뿐일 때 그 도구로 실행하고 쓸 이름을 알린다.
  - 도구 설명은 1,024자까지 싣는다. OpenAI는 이보다 긴 함수 설명이 하나라도 있으면 요청 전체를 거절한다.
  - 입력 스키마는 제공자가 받는 모양으로 고쳐 싣는다(받는 값은 그대로). 최상위 결합자(`allOf`·`anyOf`·`oneOf`)와 스키마 자체가 정의를 가리키는 `$ref`(Go invopop/jsonschema의 기본 출력)는 그 안의 속성을 객체 속성으로 옮겨 풀고(`allOf`의 필수 속성은 필수로 남는다) `$ref`도 펼치며(자기 안에서 다시 나오는 재귀 정의는 다시 펼치지 않고, 펼친 정의는 모두 64KiB까지, 매개변수가 JSON 64단계를 넘지 않게 — 펼친 사본이 요청마다 실린다), 안쪽까지 `items` 없는 배열에 `items: {}`, 객체가 아닌 `properties`(PHP 서버의 `[]`)는 `{}`로 바꾸고, `required`에만 있는 필드는 `{}` 속성으로 정의한다. OpenAI·Gemini는 `items` 없는 배열 하나로, Gemini는 정의 없는 필수 필드 하나로 요청 전체를 거절한다.
  - 한 요청의 도구는 128개까지다(OpenAI 한도). 내장 도구가 먼저이고, 넘는 MCP 도구는 서버·도구 순서의 뒤에서부터 빼고 그 서버 기록에 한 번 남긴다.
  - 호출은 그 순간의 설정과 연결로 간다. 질문 도중 다시 연결되거나 설정이 바뀐 서버도 쓰이고, 허용에서 뺀 도구는 거절된다.
- **결과**: 텍스트·텍스트 리소스·링크는 `data.text`로 이어 붙이고, 이미지·오디오·바이너리는 싣지 못해 `omitted_content`에 종류만 적는다(20개까지, 나머지는 개수).
  구조화 결과는 텍스트가 없을 때만 JSON으로 싣는다. 텍스트는 200,000자에서 자르고, 그 결과도 다른 도구처럼 결과 한도로 줄여
  나머지는 `history`에서 읽게 한다. 도구가 실패를 알리면(`isError`) `mcp_tool_error`, 시간 초과는 `mcp_timeout`(서버에 취소를 보내고,
  효과가 이미 났을 수 있다고 알린다 — 서버에 간 뒤 사용자가 멈춘 호출의 `cancelled`도 같다), 연결이 없으면 `mcp_server_unavailable`, 서버가 인수를 거절하면 `invalid_tool_arguments`로 모델에게 알린다(서버의 실패·오류 문구는 4,000자까지).
  대화에서 전에 부른 도구를 이번 질문이 내놓지 않으면(서버가 꺼짐·미연결, 허용에서 빠짐) '없는 도구'가 아니라 그 이유를 알린다.
  연결되지 않은 서버는 상태와 원인만 알리고, 서버 출력(stderr)은 MCP 탭에만 보인다(실패 원인 옆에는 그 연결 시도에서 띄운 프로세스의 출력만 붙는다).
  오류 옆에 `"result": null`을 함께 보내는 서버(JSON-RPC 1.0 모양)의 오류도 오류로 읽는다(stdio·SSE). 오류 코드가 32비트를 넘거나 실수(`-32602.0`)여도 그렇다.
  JSON이 쓸 수 없는 수(Python `json.dumps`의 `NaN`·`Infinity`)는 null로, double 범위를 넘는 수(400자리 정수)는 그 숫자의 문자열로 읽는다(stdio·SSE).
  그래도 읽지 못하는 답(128단계를 넘는 중첩 등)은 그 호출만 바로 실패로, `result`가 빠진 답은 '예상치 못한 응답'으로 알린다 — 전에는 stdio 호출이 시간 한도까지 기다렸고 SSE는 세션이 끊겼다.
  연결 오류의 문구에서 모델에게는 서버 주소의 호스트만 간다(Zapier·Make 같은 호스팅 서비스는 주소 경로에 비밀값을 넣는다). 설정한 주소 그대로는 MCP 탭에만 보인다.
  HTTP 오류 응답의 본문(프록시의 오류 페이지 등)은 1,000자까지만 인용한다.
- **장애 격리**: 서버가 뜨지 않거나 죽어도 backend 시작과 다른 도구는 영향받지 않는다.
  - 끊긴 서버는 1초부터 두 배씩 최대 60초 간격으로 다시 연결하고, 그동안 새 질문에는 그 서버의 도구를 내놓지 않는다.
  - HTTP 서버는 호출이 연결 오류(서버 없음·토큰 거절·세션을 잃은 서버)를 만나면 그때 다시 연결해, 실패하면 '실패'로 바뀐다.
    재시작한 서버가 모르는 세션에 '어느 요청의 답도 아닌 오류'(`"id": null`, TypeScript SDK 예제 서버)로 답해도 호출을 바로 끝내고 세션을 새로 맺는다.
    세션 전의 초기화를 그렇게 거절하면(초기화를 한 번만 받는 서버, 토큰·프로토콜 버전 거절) 세션을 잃었다고 하지 않고 서버의 문구로 알린다.
    명세대로 잊은 세션에 404로 답하는 서버는 SDK가 같은 연결에서 새 세션을 연다. 그때 도구 목록을 다시 읽는다(재배포로 바뀐 도구를 바로 반영하고, 서버 기록에 남긴다).
    서버가 보내는 이벤트 스트림(GET)은 끊겨도 한 연결에서 8번까지만 바로 다시 열고 그 뒤로는 1초에 한 번 연다. 전에는 열자마자 끊는 서버·프록시에 초당 수천 번 요청했다.
  - 호출이 시간 한도를 넘으면 ping을 보내, 5초 안에 답하지 않는 서버(처리기 교착 등)는 멈춘 것으로 보고 다시 연결한다. 느리기만 한 서버는 그대로 둔다.
    그동안 다른 호출이 답을 받으면 살아 있는 것으로 본다(요청을 하나씩 처리하는 서버에서는 ping이 다른 대화의 호출 뒤에 줄을 선다).
    서버 하나를 모든 대화가 함께 쓰므로, HTTP 연결 하나에는 호출을 62개까지 동시에 보내고 남은 자리는 ping에 둔다. 넘는 호출은 자리를 기다린다(기다리는 시간도 호출 한도에 든다).
  - 호출 한도와 정지는 입력을 읽지 않는 서버에도 걸린다.
  - 호출이 그 요청 하나에 대한 HTTP 응답(429 요청 수 제한, 408·413·422 등, 5xx)을 받으면 그 호출만 실패로 알리고 연결은 유지한다(같은 세션의 다른 호출은 이어진다). 키 없는 호스팅 서비스는 사용량 제한에 걸리기 쉽다.
    5xx(프록시가 긴 호출에 내는 504 등)나 서버가 일하는 중에 끊긴 연결은 도구가 이미 실행됐을 수 있다고 알린다. 거절(4xx)·연결 거부는 그러지 않는다.
  - 호출 하나의 SSE 스트림이 답 전에 끊기면(프록시의 유휴 시간 제한이 긴 호출을 끊는 경우 — nginx 기본 60초) 그 호출만 실패로 알리고, 서버에 ping을 보내 답이 없을 때만 다시 연결한다. 전에는 세션을 새로 맺어 같은 서버를 쓰는 다른 대화의 호출까지 끊었다.
  - 연결 실패에는 원인 안내가 앞에 붙는다: 인증서 불신(HTTPS는 서버 PC 운영체제의 신뢰 저장소로 검증하므로, 사설 인증 기관은 거기에 등록한다), 연결 거부, 호스트 이름 조회 실패, 인증 거절, 시간 초과. HTTP 응답이면 그 응답의 상태로 안내한다(본문이 다른 상태를 적어도 따르지 않는다).
  - 스키마가 틀린 도구가 섞인 서버도 연결된다. 그 도구만 인수 없이 받고, 이유를 기록에 남긴다.
  - 도구 목록 요청(`tools/list`)을 모르는 서버(리소스·프롬프트만 내놓는 서버)는 도구 0개로 연결된다. 실패로 보고 다시 띄우지 않는다.
  - 모델 서버가 MCP 도구의 정의를 거절하면(HTTP 400·422가 그 도구를 이름이나 순번으로 가리킬 때) 그 질문은 그 도구만 빼고 이어 간다(문구가 가리키는 도구는 모두 한 번에 뺀다). 그 뒤 같은 모델 서버·모델로 가는 질문도 그 도구를 뺀다. 정의가 바뀌거나 **다시 연결**하면 다시 싣는다. MCP 탭의 도구 목록·서버 기록에 거절 문구가 보인다.
    모델이 쓴 도구 호출을 제공자가 검사해 거절한 것(Groq의 `tool_use_failed` — 호출이 도구 스키마와 맞지 않음)은 정의 거절이 아니다. 도구를 빼지 않고, 쓸 수 없는 호출처럼 무엇이 틀렸는지 알려 다시 청한다.
  - stdio 서버의 출력은 한 줄 16 MiB까지 읽는다. 넘는 줄을 보내면 연결을 끊고 다시 연결한다. HTTP 서버의 답(일반 JSON, SSE 이벤트, 오류 응답의 본문)도 16 MiB까지만 읽는다. 넘는 답은 그 호출만 '16 MiB가 넘는 답이라 읽지 않았다(서버에서는 실행됨)'로 실패하고 세션은 그대로 둔다.
  - 서버가 보내는 것에도 상한이 있다: 도구 1,000개, 도구당 입력 스키마 64 KiB(넘는 도구는 받지 않는다), 이름·제목 200자, 안내문 8,000자. 목록 변경 알림이 몰려도 1초에 한 번만 다시 읽는다. stderr는 계속 읽어 비우고(최근 200줄 보관),
  stdout에 섞인 JSON 아닌 줄은 건너뛴다. 명령은 Unix에서는 프로세스 그룹, Windows에서는 Job Object로 띄워 멈출 때(종료·재연결·삭제)
  손자 프로세스까지 정리한다. 멈출 때는 입력을 닫고 2초, 그래도 남으면 SIGTERM을 보내고 2초 더 기다린 뒤 죽인다(MCP 명세의 순서).
  `docker run -i --rm`으로 띄우는 서버에는 `--init`을 붙인다 — 없으면 컨테이너 안의 첫 프로세스가 SIGTERM을 무시해, 입력이 닫혀도 끝나지 않는 서버의 컨테이너가 남는다.
  서버는 표준 입출력 말고는 backend가 연 파일(다른 서버의 파이프, 연결)을 물려받지 않는다 — macOS에서 함께 뜬 서버가 서로의 파이프를 쥐면, 끝난 서버가 끝난 것으로 보이지 않아 호출이 시간 한도까지 기다렸다.
  서버가 띄운 프로세스가 서버의 표준 입출력을 물려받아 서버가 끝난 뒤에도 출력이 열려 있으면, 1초 뒤 ping으로 묻고 답이 없으면 다시 연결한다.
  끝난 서버 프로세스는 연결을 닫을 때까지 거두지 않는다(Unix) — 먼저 거두면 그 ID를 받은 다른 프로그램이 닫을 때의 그룹 종료를 맞을 수 있었다.
  답을 받기 전에 버린 요청(한도를 넘은 도구 목록 다시 읽기, ping)은 서버에 취소를 알린다. 연결 확인 도중 화면을 떠나거나 backend가 멈춰도 확인한 서버는 같은 순서로 닫는다.
- **MCP 탭**: 서버 목록과 상태(준비됨·연결 중·실패·꺼짐), 편집기(연결 방식·명령/주소·인수·작업 폴더·환경변수/헤더·비밀값·
  호출 한도·허용 도구), **연결 확인**(저장 전 설정으로 잠깐 연결해 도구 목록을 받아 온다 — 허용할 도구를 체크박스로 고른다),
  **다시 연결**, 그리고 연결 상태·서버 정보·서버가 준 안내문·도구별 호출/실패/취소/평균 시간/최근 오류·최근 기록을 보여 준다.
  허용한 도구 정의가 요청마다 차지하는 토큰 수도 보인다 — 도구 정의는 매 요청에 실리므로 꼭 필요한 도구만 허용한다.
  호출 수는 메모리에만 있어 backend를 다시 시작하면 처음부터 센다.
- **화면 편집은 관리자 인증 키가 있을 때만**: MCP 서버는 서버 PC에서 명령을 실행하는 설정이라, backend가 시작될 때 관리자 인증 키가 이미 등록되어 있어야
  MCP 탭에서 추가·수정·삭제·연결 확인·다시 연결을 할 수 있다(아니면 403, 화면은 보기 전용과 그 이유).
  - 실행 중에 키를 처음 등록했다면 backend를 다시 시작한 뒤부터 열린다. 키 없이 관리 API가 열려 있는 동안 다른 사람이 키를 먼저 등록하고 명령을 추가하는 것을 막기 위해서다.
  - `config.toml` 직접 편집은 언제나 된다.
  설정 탭의 저장은 `mcp_servers`를 건드리지 않는다.
- **지원하지 않는 것**: 사용자별 로그인(OAuth) 서버 — 모든 사용자가 등록한 공용 계정 권한으로 쓴다, 실행 전 사용자 승인,
  대화마다 따로 띄우는 서버(상태를 가진 서버는 대화끼리 상태를 나눠 쓴다), MCP의 resources·prompts.
  Windows 경로(Job Object 정리, `npx.cmd` 같은 배치 파일 실행)는 GitHub Actions의 Windows 작업이 MCP 검사로 잰다.

## 실제 LLM 연결 (vLLM / OpenRouter / Ollama)

관리자 화면 **설정 → 모델 연결**에서 주소·모델·API 키를 넣고 **연결 확인**을 누른다 — 일반 응답·스트리밍·도구 호출 왕복을
차례로 시험해 어디서 막히는지 알려 준다. 일반 응답 단계도 질문처럼 과부하·한도 초과(HTTP 429·5xx, 그리고 OpenRouter가 HTTP 200 본문의 `error`로 전하는 "Upstream error … temporarily overloaded")는 설정한 재시도 횟수만큼 다시 청하고, 끝내 안 되면 서버가 한 말을 그대로 보인다 — 무료 모델(`:free`)은 이런 과부하가 잦다. 저장하면 다음 질문부터 쓴다(재시작 없음). **tool calling을 지원하는 모델**이어야 한다.

| 서버 | 주소 | 모델 예 | 비고 |
|---|---|---|---|
| vLLM | `http://localhost:8000/v1` | `Qwen/Qwen2.5-32B-Instruct` | `--enable-auto-tool-choice --tool-call-parser hermes`로 띄워야 도구 호출이 온다 |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4.5` | API 키 필요 |
| Ollama | `http://localhost:11434/v1` | `qwen3:8b` 등 | 키 없음. 작은 모델(0.6b)은 배관 확인용일 뿐 답의 질이 낮다 |

**컨텍스트 토큰**(기본 128,000)과 **출력 한도**(16,384)는 모델 서버가 실제로 받는 값에 맞춘다. 서버가 실제로 그 길이를 받는지는
코드가 알 수 없으니 연결 후 한 번 확인한다:

```bash
curl -s http://localhost:8000/v1/models | python3 -c 'import json,sys; print([m.get("max_model_len") for m in json.load(sys.stdin)["data"]])'   # vLLM: 131072 이어야 한다
```

- Ollama는 모델을 작은 컨텍스트(기본 4,096)로 올리고, 넘치는 요청을 거절하지 않고 잘라 받는다(서버 로그의 `truncating input prompt`).
  시스템 프롬프트와 도구 정의만으로 그만큼을 거의 다 쓰므로(프로젝트가 있으면 넘는다) `OLLAMA_CONTEXT_LENGTH`(예: `launchctl setenv OLLAMA_CONTEXT_LENGTH 32768` 뒤 Ollama 재기동,
  Windows는 `setx`)로 늘리고 설정의 컨텍스트 토큰을 그 값에 맞춘다. 잘린 요청은 서버가 센 토큰 수로 알아보고, 남은 것만 보고 답하는 대신
  그렇게 안내하며 질문을 끝낸다.
- vLLM은 모델 config의 `max_position_embeddings`를 기본값으로 쓴다. `Qwen/Qwen2.5-32B-Instruct`는 그 값이 32,768이라 그대로 띄우면 **32k**다 — 128k는 YaRN을 켜야 나온다: `--max-model-len 131072 --hf-overrides '{"rope_scaling":{"rope_type":"yarn","factor":4.0,"original_max_position_embeddings":32768}}'` (정적 YaRN이라 짧은 입력의 품질이 조금 떨어진다는 것이 Qwen 쪽 안내다).
- 컨텍스트가 더 작은 모델이면 설정의 컨텍스트 토큰을 그 값으로 줄인다 — 도구 결과 한도와 맥락 비우기 기준이 함께 줄어든다.
  설정이 실제보다 커서 서버가 요청을 길다고 거절하면 오래된 묶음을 모두 빼고 다시 보내 대화는 이어지지만, 거절마다 요청이 한 번 더 든다.
  매 호출의 실제 토큰 수는 서버 로그의 `[llm] usage prompt=… completion=… cached=… ms=…` 한 줄로 확인할 수 있다.
- 토큰 수는 tiktoken으로 세고, 모르는 모델은 25% 여유를 둔 뒤 서버가 알려 준 usage로 대화마다 보정한다(MnemoArc 방식).
  크기로 거절된 요청은 usage가 없으므로 거절 문구에 적힌 토큰 수(OpenAI·vLLM·llama.cpp·LM Studio·OpenRouter·Anthropic·Gemini·TGI)로 보정한다.

호출은 스트림이다. 응답이 시작되기 전과 스트림 도중에 **무응답 한도**(기본 120초) 동안 조각이 오지 않으면 끊고 재시도하므로
죽은 엔드포인트를 일찍 알아채고, 답변이 흘러오는 동안 화면에 미리보기를 낸다(위 '진행 상황 스트림'의 `answer_delta`).
서버가 일시적으로 없으면(5xx·연결 실패, 답을 쓰던 스트림이 끊겼을 때도 — 그때는 보인 글을 미리보기에서 거둔다) 5초·15초 쉬었다 다시 부른다. 모델이 출력 한도에 닿아 끊기면 이어 쓰게 하고(2회, 이어 쓸 자리가 없으면 쓴 데까지가 답),
빈 응답이면 다시 요청한다(2회 — 출력 한도에 닿을 때까지 글이 없던 응답도 같고, 끝내 그러면 출력 한도를 늘리거나 추론 강도를 낮추라고 안내한다). `reasoning_effort`·`stream_options`를 이름을 대며 거절하는 서버(400·422 — "Unrecognized request argument supplied: reasoning_effort" 같은)에는 그 값을 빼고 다시 보내고, 그 서버·모델에는 그 뒤로 보내지 않는다(연결 확인도 같다). 출력 한도는 `max_completion_tokens`로 보내는데, 답이 그보다 길게 오면(Ollama는 `max_tokens`만 읽는다 — 한도 30에 285토큰을 썼다) 한도가 걸리지 않는 서버이므로 그 서버·모델에는 그 뒤로 `max_tokens`로 보낸다(서버가 따로 알려 준 추론 토큰은 빼고 잰다). 설정의 'max_tokens 이름으로 보내기'를 켜 두면 처음부터 그렇게 보낸다. 도구 호출 앞에 글을 쓴 응답의 호출이 깨졌으면(인수가 JSON이 아니다 등) 미리보기를 거두고 다시 청한다(연속 2회).

## 실제 Oracle 연결

1. Oracle Instant Client 설치(위 '백엔드' 절) — 설정 탭의 Oracle 상태 줄이 "loaded"인지 확인
2. `target_db` 테이블(관리자 화면 DB 탭)에 접속 정보 등록 — `connection_info`는 Easy Connect 문자열(`host:1521/SERVICE`) 또는 tnsnames 별칭, `db_password`는 `ENV:변수명` 형식 권장
3. 설정 탭에서 Oracle **mock**을 끄고, 참조하는 비밀번호 환경변수(`ORDER_DB_PASSWORD`)를 `backend/.env`에 둔다(서버 재시작 필요 — `.env`는 기동할 때 읽는다)
4. `query_registry`의 쿼리를 실제 테이블 구조에 맞게 등록

QUERY·PROCEDURE·FUNCTION은 모두 실행할 커넥션에서 `DBMS_OUTPUT.ENABLE(NULL)`을 호출해
`SERVEROUTPUT ON` 상태로 동작한다. 매 실행 전에 이전 버퍼를 비우고, 조회 결과를 읽고 커서를
닫은 뒤 버퍼를 정리한다. `DBMS_OUTPUT` 버퍼를 컬렉션이나 파이프라인 함수로 읽어 OUT CURSOR를
만드는 루틴도 이 설정을 사용한다. 앱은 버퍼를 별도로 읽어 답변에 붙이지 않으므로, 결과로 사용할
내용은 해당 실행의 조회 행이나 OUT 바인드로 반환해야 한다. 버퍼는 별도 실행 간에 공유하지 않는다.
이 동작은 설정 탭의 '루틴 읽기 전용'과 관계없이 적용된다.

### 프로시저와 함수 등록

`query_registry`를 공통 실행 목록으로 사용한다. `query_type`은 `QUERY`(기본값),
`PROCEDURE`, `FUNCTION`이고, 이름·설명·대상 DB·벡터 검색·처리 방법에서의 참조는 동일하다.
기존 INSERT는 컬럼을 추가하지 않아도 QUERY로 등록된다. 루틴 등록 후에는 기존 쿼리처럼
임베딩 동기화를 실행하고, `query_desc`에는 용도, `input_desc`에는 입력값의 의미와 형식을 적는다.

기존 관리 DB는 **앱 업데이트 전에** 아래 파일을 적용한다. `schema.sql`로 초기화하지 않는다.

```bash
mariadb --default-character-set=utf8mb4 -u <관리자> -p < backend/sql/migrate-routines.sql
```

관리자 화면의 쿼리 탭에서 실행 유형과 SQL을 입력한다. 바인드 설정은 프로시저·함수에만 표시된다.
`SQL에서 불러오기`로 바인드 이름을 가져온 뒤 각 행에서 방향·자료형·문자열 출력 크기를 선택한다.
행을 직접 추가하거나 삭제할 수도 있다. 함수 반환값과 커서는 OUT으로 고정되며, 설정은 저장 시 자동으로 JSON으로 변환된다.
기존 JSON 설정도 폼으로 불러온다. 쿼리로 전환해 저장하면 바인드 설정은 비워진다.
Oracle에 이미 존재하고 대상 계정에 EXECUTE 권한이 있는 조회용 루틴을 등록한다.

| 유형 | 실행 SQL 예시 | 결과 |
|---|---|---|
| QUERY | `SELECT * FROM orders WHERE customer_id = :id` | 조회 행 |
| PROCEDURE | `BEGIN app.get_orders(:id, :result); END;` | `result` OUT CURSOR의 행 |
| FUNCTION | `BEGIN :result := app.get_total(:id); END;` | `result` 컬럼 한 행 |

프로시저 예시의 바인드 설정:

```json
{
  "id": { "dir": "IN", "type": "STRING" },
  "result": { "dir": "OUT", "type": "CURSOR" }
}
```

함수 예시의 바인드 설정:

```json
{
  "id": { "dir": "IN", "type": "STRING" },
  "result": { "dir": "OUT", "type": "NUMBER" }
}
```

- 루틴의 모든 바인드에 `dir`(`IN`, `OUT`, `INOUT`)과 `type`(`STRING`, `NUMBER`, `CURSOR`)을 명시한다. QUERY는 설정을 비워둔다.
- 모델에는 IN/INOUT 이름만 입력 바인드로 제공한다. OUT 값과 함수 반환값은 서버가 받으며, 루프의 중복 실행 판정도 실제 입력만 비교한다.
- 출력은 여러 스칼라 OUT/INOUT 또는 **단독 OUT CURSOR 1개**를 지원한다. CURSOR 반환 함수도 가능하다. 출력 없는 프로시저, 여러 커서, 커서와 스칼라의 혼합, 객체·컬렉션·LOB 바인드는 지원하지 않는다.
- 스칼라는 바인드 이름을 컬럼명으로 한 행에 반환한다. NUMBER 출력은 NUMBER로 바인드하고 큰 수의 정밀도를 보존하도록 문자열로 읽은 뒤, 조회 컬럼과 같이 정밀도를 잃지 않는 값만 숫자로 바꾼다(`.5` → `0.5`, 16자리 이상의 정수는 문자열 그대로). STRING 출력의 `maxSize`는 1~32767바이트이며 기본값은 32767이다. 받은 결과에는 기존 행·컬럼·셀 길이 제한을 적용한다.
- 입력값은 기존 쿼리처럼 필수이며 null·빈 문자열은 받지 않는다. NUMBER 입력은 Oracle NUMBER가 담을 수 있는 값(0 또는 절댓값 1e-130 이상 1e126 미만)만 받는다 — 범위 밖 값은 Oracle이 오류 없이 무한대(`~`)나 0으로 바꾸므로 실행 전에 거부한다. 날짜는 STRING과 루틴의 명시적 변환을 사용한다. 빈 조회 결과는 NULL 커서 대신 열린 빈 REF CURSOR로 반환해야 한다.
- 호출 이름은 `루틴`, `패키지.루틴`, `스키마.패키지.루틴` 형태를 지원한다. 인수는 바인드만 사용하며 `p_id => :id` 같은 명명 인수도 가능하다. 주석·리터럴·추가 문장·DECLARE·SQL*Plus의 `/`는 넣지 않는다.
- 루틴은 mock을 끈 실제 Oracle에서 실행한다. mock에서는 지원하지 않는다는 오류를 반환한다.

프로시저·함수의 실행/결과 읽기 오류는 해당 조회 이력의 실패로 기록하고 에이전트 흐름을 계속한다.
병렬 실행에서는 실패한 항목과 관계없이 다른 항목의 결과를 보존한다. 커서 닫기·rollback·연결 반납의
오류가 원래 결과를 덮지 않으며, 정리에 실패한 연결은 재사용하지 않도록 폐기한다.

루틴은 기본적으로 읽기 전용 트랜잭션으로 실행한다. 이것은 **실수로 섞인 DML을 막는 장치이지 쓰기 차단 경계가 아니다.**
실제 Oracle에서 아래 변경은 이 설정이 켜져 있어도 그대로 기록된다(QUERY의 SELECT가 부르는 함수도 마찬가지다).

- 루틴 안에서 `COMMIT`(또는 암묵 커밋하는 DDL)을 먼저 실행한 뒤의 DML — 커밋이 읽기 전용 트랜잭션을 끝내고, 그 뒤는 일반 트랜잭션이다.
- `PRAGMA AUTONOMOUS_TRANSACTION` 루틴(호출 로그 기록 등)의 DML과 커밋.
- DB 링크·외부 호출로 다른 시스템에 일으킨 변경.

루틴은 기본적으로 정의자 권한(definer rights)으로 실행되므로, 조회 계정에서 테이블 권한을 빼도 루틴 소유자의 권한으로 쓴다.
따라서 쓰기를 막는 유일한 경계는 **등록 전에 루틴 본문(호출하는 하위 루틴 포함)에 위 패턴이 없는지 검토하는 것**이다.

내부에서 DML이 필요한 루틴은
설정 탭 Oracle의 **프로시저·함수를 읽기 전용 트랜잭션으로 실행**을 끄면 `SET TRANSACTION READ ONLY`를 생략한다(다음 조회부터 적용).
이 설정은 등록된 PROCEDURE·FUNCTION 전체에 적용하며, QUERY의 SELECT/WITH 전용 검사는 유지한다.
DB 계정 권한은 별도로 필요하며, 설정과 관계없이 자동 커밋 없이 실행하고 결과를 읽은 뒤 rollback한다.
따라서 읽기 전용 해제는 자동 커밋을 켜는 설정이 아니다. 루틴 내부에서 명시적으로 커밋하거나
자율 트랜잭션·외부 호출로 수행한 변경은 설정과 관계없이 마지막 rollback으로 취소되지 않는다.

기존 테스트 Oracle 컨테이너에서 루틴 통합 검증만 실행하려면:

```bash
cd backend
LLM_AGENT_TEST_ORACLE=1 LLM_AGENT_TEST_MARIADB=<user:password@127.0.0.1:3306> \
  ORDER_DB_PASSWORD=<VOC_READER 비밀번호> ORACLE_CLIENT_LIB_DIR=<Instant Client 폴더> \
  cargo test --test oracle_live
```

이 검사는 Oracle에 새 객체를 만들거나 데이터를 바꾸지 않는다. 기존 `VOC_READER` 계정으로 시드의 쿼리·프로시저·함수와
자료형 확인 쿼리를 실행하고, 느린 조회를 도중에 끊은 뒤 같은 풀이 계속 쓰이는지 본다(관리 DB는 임시 DB를 만들었다 지운다).

바인드 방향과 REF CURSOR 처리는 Rust [`oracle` 크레이트](https://docs.rs/oracle)(ODPI-C)를 따른다.

### 같은 쿼리를 여러 DB 중 하나에서 실행하기

`target_db_name`에 `;`로 후보를 나열하면 LLM이 그중 하나를 골라 실행한다. 하나만 적으면 지금까지와 같이 그 DB로 고정된다.

```sql
INSERT INTO query_registry (query_name, query_desc, input_desc, query_sql, output_desc, target_db_name) VALUES
('재고조회', '공장별 재고 DB에서 품목 재고를 조회한다. 질문에 "서울"이 있으면 STOCK_SEOUL, "부산"이면 STOCK_BUSAN을 고른다',
 ':item_cd = 품목코드', 'SELECT ITEM_CD, QTY FROM STOCK WHERE ITEM_CD = :item_cd', '품목별 재고량',
 'STOCK_SEOUL;STOCK_BUSAN');
```

**`query_desc`에 "어느 질문일 때 어느 DB를 고르는가"를 반드시 적을 것.** 모델에게 주어지는 것은 후보 이름과 이 설명뿐이라, `STOCK_BUSAN`이라는 이름만으로는 "부산 재고"를 그 후보와 연결하지 못한다. 여러 단계라면 `qa_method`에 절차로 적어도 된다.

동작 규칙은 이렇다.

- 후보가 **하나**면 모델이 고르지 않아도 그대로 실행된다 — 목록형을 쓰지 않는 기존 등록은 전부 그대로 동작한다.
- 후보가 **여럿인데 고르지 않으면** 실행하지 않고 후보 목록과 함께 되묻는다. 첫 후보로 폴백하지 않는 이유는, 그러면 엉뚱한 DB의 결과가 정답 행세를 하면서 답변·trace·`chat_log` 어디에도 흔적을 남기지 않기 때문이다.
- 후보 **밖의 이름**을 고르면 거부한다. 오류 문구가 후보 목록을 함께 주므로 모델이 다음 스텝에서 스스로 고친다.
- 한 질문 안에서 **여러 DB를 차례로** 조회할 수 있다 (예: 서울·부산 재고 비교). 루프 가드는 이름·바인드에 더해 대상 DB까지 보고 '같은 실행'을 판정하므로 두 번째 DB 조회가 중복으로 막히지 않는다.
- 어느 후보인지 질문만으로 정할 수 없으면 모델은 조회하지 않고 사용자에게 되묻는다.

조회한 DB 이름은 화면의 실행 trace에 `쿼리이름@DB이름`으로 나오고 `query_run` 결과의 `target_db`로 모델에게도 돌아간다. 그러므로 `target_db.db_name`에는 **사람이 읽을 이름**을 등록할 것 (접속 주소·계정은 `target_db`의 다른 컬럼이고 화면에 나가지 않는다).

구 스키마(`target_db_name VARCHAR(100)`)에 목록을 넣으면 뒤가 잘린 채 저장되어 후보가 조용히 사라진다 — `sql/seed.sql`이 재실행 시 `VARCHAR(500)`으로 넓힌다.

### 로컬 테스트 컨테이너로 확인하기

로컬 테스트 컨테이너(위 1-2단계)를 쓰는 경우 접속 정보는 이미 `target_db`에 등록되어 있다.
설정 탭에서 Oracle mock을 끄고, `backend/.env`의 `ORDER_DB_PASSWORD`에 조회 계정 `VOC_READER`의 비밀번호
(`oracle-init.sql`의 `CREATE USER ... IDENTIFIED BY`에 있는 값)를 채운 뒤 서버를 다시 시작하면 된다.
`.env.example`에 값을 넣어두지 않는 이유는, 채워져 있으면 "여기는 내가 채워야 한다"는 신호가 사라져
저장소에 적힌 비밀번호가 그대로 운영 조회 계정에 남기 때문이다.

## 보안

- **조회 전용 가드**: QUERY 유형은 실행 직전 SELECT/WITH로 시작하는 단일 문장만 허용 — UPDATE/DELETE/DDL/다중 문장은 차단된다 (`backend/src/sql.rs`의 `assert_read_only`).
  `SELECT … FOR UPDATE`도 거부한다 — 조회 문장이라 '첫 키워드' 검사는 통과하지만 조회대상 DB의 행에 잠금을 걸어 운영 트랜잭션을 대기시킨다.
  문자열 리터럴·주석 경계는 정규식이 아니라 단일 패스 스캐너로 판정한다 — Oracle q-quote(`q'!...!'`)는 구분자가 임의 문자라
  일부만 모델링하면 리터럴에 숨은 세미콜론을 놓치거나 정상 쿼리를 오탐한다. 경계를 확정할 수 없는 SQL(닫히지 않은 리터럴)은 거부한다.
  두 방향 모두 `cargo test`로 회귀 검증한다 (Node 판정 사례를 옮긴 `sql.rs` 검사)
- LLM은 SQL을 직접 쓸 수 없고 `query_registry`에 등록된 쿼리의 **이름만 선택**한다. 사용자 입력은 바인드 변수 값으로만 전달 (문자열 결합 없음)
- 그래도 조회 계정(`target_db.db_user`)은 **read-only 권한 계정**을 사용할 것 (심층 방어).
  Oracle 12c+라면 `GRANT SELECT`가 아니라 `GRANT READ`를 준다 — 차이는 딱 하나, READ에는 `LOCK TABLE`과 `SELECT … FOR UPDATE`가 빠져 있어
  위 가드와 같은 규칙이 계정 차원에서도 강제된다 (`sql/oracle-init.sql`이 그렇게 부여한다)
- `db_password`는 `ENV:변수명` 형식으로 환경변수 참조 권장. 평문 저장은 개발용만
- **프로젝트 소스 도구는 읽기 전용**이고 등록한 폴더 밖(심볼릭 링크·`..` 포함)은 읽지 않는다. 파일 쓰기·명령 실행 도구는 아예 없다
- **MCP 도구는 등록한 서버가 하는 일을 그대로 한다** — 쓰기·삭제를 하는 도구도 있고, 모델은 사람 승인 없이 부른다. 허용 목록(`tools`)이
  유일한 통제다. 서버가 붙인 '읽기 전용' 힌트는 믿지 말고 도구가 실제로 하는 일을 보고 허용한다. 도구 결과에 섞인 지시문은 근거 자료로만
  다루라고 시스템 프롬프트가 일러 두지만, 신뢰하지 않는 내용을 돌려주는 서버는 등록하지 않는다
- **MCP 서버 명령은 backend 계정 권한으로 돈다** — 그래서 화면에서의 추가·변경은 관리자 인증 키가 있을 때만 되고, 명령에는 backend의
  환경변수(비밀번호 등)를 넘기지 않는다
- **외부 서비스 MCP 도구에는 모델이 넣은 인수(검색어·주소 등)가 그 회사 서버로 나간다.** 모델이 조회 결과 같은 사내 데이터를 검색어에 넣으면 외부로 나갈 수 있다. 코드로 막을 수 없으니, 민감한 데이터를 다루는 환경에서는 외부 검색 도구를 허용하기 전에 이 점을 따진다
- **MCP 연결 오류 문구는 서버 주소의 쿼리 값과 사용자 정보를 가린다**(`https://host/mcp?…`). 이 문구는 콘솔 로그와 상태 화면에 남고,
  호출 오류로 LLM 제공자에게도 가기 때문이다. 키는 주소보다 비밀 헤더에 두는 것이 낫다. 서버의 stderr(연결 문자열·토큰을 찍을 수 있다)는
  MCP 탭의 오류·기록에만 남고 모델에게 가는 오류에는 싣지 않는다
- **설정의 비밀값**(LLM API 키·관리 DB 비밀번호·관리자 인증 키·MCP 서버의 비밀 환경변수/헤더)은 `backend/config.credentials.json`(소유자만 읽기)에만 저장되고 화면·API 응답으로 돌아오지 않는다
- 관리 DB 조회 한도(설정 '관리 DB → 쿼리 한도', 기본 30초) — 검색은 답변 루프의 시간 검사보다 앞에서 돌기 때문에, 여기가 매달리면 요청 상한이 통째로 성립하지 않는다
- 조회 쿼리 한도(설정 'Oracle → 조회 한도', 기본 30초) — 느린 쿼리가 요청을 무한 대기시키지 않는다. 한도·정지·연결 끊김에는 실행 중인 문장을 `break`로 끊는다.
  세션을 기다리던 중(풀 8개가 다 쓰이는 중, 새 세션을 만드는 중)에 멈춘 실행은 세션을 받자마자 아무것도 실행하지 않고 끝낸다 — 끊을 문장이 없어, 멈춘 뒤에도 그 문장이 끝까지(조회 한도까지) 돌았다
- 조회 결과는 1,000행(`MAX_ROWS`) 제한. 셀당 4,000자 절단은 드라이버 경계(`oracle.rs`)에서, 모델에게 보이는 행 수는 `query_run`의 미리보기와 `result_read`가 정한다.
  LOB/이진 값도 이 경계에서 문자열로 정규화된다

## 검색 (벡터 — 10,000건 이상 대응)

지식·처리방법은 **벡터 검색**(MariaDB 네이티브 `VECTOR(1024)` + 벡터 인덱스, 코사인 거리)이다 (`backend/src/search.rs`).
쿼리는 query_name 정확 일치를 먼저 찾고, 일치하지 않으면 벡터 검색합니다.
첫 페이지에는 검색어 낱말이 **제목**에 든 항목을 벡터 결과 앞에 둔다(제목 일치, 아래).
검색어는 LLM이 질문의 핵심 낱말 몇 개로 쓰고(`backend/src/context.rs` 시스템 프롬프트), 대상은 셋 중 필요한 것만 고른다 —
`knowledge`(지식), `qa_method`(처리방법), `query`(쿼리 목록). 무엇이 필요한지 확실하지 않으면 셋 다 찾는다.
임베딩은 검색어마다 한 번만 계산된다(검색어 단위 LRU 캐시). 몇 건을 받을지·더 볼지는 모델이 `limit`·`offset`으로 정한다.

캐시는 임베딩 서버·모델·실제 전송 입력(질의 접두 포함)을 구분한다. 응답은 1024차원과 FP32
유효성을 검사하고 단위 길이로 정규화한 뒤 저장·캐시한다. 잘못된 응답은 검색 불가로 알리며,
다음 요청에서 다시 시도한다.

검색 후보는 현재 본문·모델의 해시와 대조한다. 평상시는 벡터 인덱스 후보를 PK로 읽는 한 번의
조회이며, 오래된 벡터나 삭제된 원본이 후보를 차지하면 유효한 결과를 정확 검색으로 보충한다.
이 예외 경로는 전체 벡터를 검사할 수 있고 관리 DB 쿼리 한도의 제한을 받는다. 보충 실패 시
이미 검증한 후보는 보존하며, 그런 후보도 없으면 검색 불가로 알린다.

- **본문 LIKE 검색은 없앴다.** 인덱스를 못 쓰는 `%…%` 스캔이라 비용이 (행 수 × 낱말 수 × 조사 변형 × 컬럼 수 × 본문 길이)에
  비례했고, 질문 낱말 30개면 행마다 LIKE를 180번 평가했다 — 지식이 만 건이면 검색 한 번이 초 단위였다.
- **제목 일치(title match)는 제목만 LIKE로 찾는다.** 벡터는 식별자·고유명사·드문 낱말을 그 항목 가까이 두지 못할 때가 있다 —
  bge-m3로 제목 낱말 24개를 검색하면 정답 9개가 거리 문턱(0.4) 밖이었고, 그때는 '가까운 3건' 보충 덕에만 보였다(문서가 늘면
  `beyond_threshold`로 빠져 `offset`으로도 못 받는다). 그래서 첫 페이지(`offset` 0)에서 검색어 낱말이 지식 제목·처리 방법 제목·
  쿼리 이름(`_`를 띄어 씀)과 설명(`query_desc`)에 든 항목을 벡터 결과 앞에 `title_match`·`matched_words`로 싣는다.
  - 순위: 낱말 점수는 1/(그 낱말이 든 행 수) — 드문 낱말일수록 무겁다. 낱말 일부에만 걸리면(앞에 글자·숫자·`_`, 뒤에 영문·숫자·`_`:
    `term342`의 `term34`, `고객주문`의 `주문`) 절반, 뒤에 붙은 한글(조사)은 온전하다(`프로시저로`). 행 점수는 그 합이고
    **1위 점수의 절반을 넘는 행만** 남는다 — 낱말이 다 맞으면 1위, 드문 낱말 하나면 남고, 흔한 낱말만 맞은 행은 빠진다.
    값이 섞인 검색어(`홍길동 주문 상태`)의 값 낱말은 0점이라 방해하지 않는다. 동점은 제목=검색어 → 검색어 통째 포함 →
    벡터 거리 → 짧은 글 순. 한 글자 낱말은 보지 않는다.
  - 상한: 최대 5건, 벡터 검색이 돌면 `limit − 1`건까지(벡터 결과가 한 칸은 남아 `next_offset`이 같은 호출을 가리키지 않는다).
    나머지 칸은 벡터 결과라 결과 크기는 그대로다(벡터 결과가 다 나온 마지막 페이지면 남은 칸을 뒤의 제목 일치로 채운다). 걸린 전체 수는 `title_matches`, 다 싣지 못하면 낱말을 더 붙이라는 `note`(결과 크기 때문에 덜어 내면 그만큼 다시 센다 — 벡터 결과를 먼저 덜고 하나는 남긴다).
    제목 일치는 `offset`으로 이어 받지 않는다 — 많이 걸린다는 것은 흔한 낱말이라는 뜻이고 그 사이의 순위는 벡터가 매긴다.
  - 비용: 대상마다 쿼리 두 번(일치 조합별 행 수 → 상위 행). 10만 행 제목에서 0.1초대, 등록 자료 수백 건이면 1ms 안쪽이다.
    같은 계산을 창 함수(`SUM/COUNT OVER`) 한 번으로 짜면 10만 행 중 3만 건이 걸릴 때 몇 분이 걸린다 — 두 단계로 둔다.
    본문은 보지 않는다(위의 본문 LIKE 비용). 쿼리 설명은 TEXT지만 쿼리 수가 적다.
- **임베딩 서버가 없으면 벡터 검색은 성립하지 않는다.** 쿼리명 정확 일치와 제목 일치는 임베딩 없이도 동작한다(제목 일치만 찾았다는 `note`).
  제목 일치도 없는 대상은 '0건'이 아니라 **검색 불가**로 프롬프트·화면·chat_log에
  남는다(도구 결과의 `status: search_unavailable`) — 모델이 '등록된 자료가 없다'고 단정하지 않게 하고, 분석 SQL이 그 질문을 지식 보강 후보로 잘못 세지 않게 한다.
- **벡터 저장**: 별도 vector DB 없이 `vec_<소스>` 테이블(`vec_knowledge_chunk`·`vec_qa_method`·`vec_query_registry`).
  원본 테이블은 변경하지 않는 companion 구조. 소스마다 인덱스를 나눈 이유는 한 인덱스에 담고 `src`로
  거르면 큰 소스가 상위 K건을 차지해 작은 소스의 검색이 조용히 주저앉기 때문이다
- **지식 청킹**: 긴 지식은 `knowledge_chunk`로 나뉘어 검색된다(원문은 `knowledge`에 그대로).
  임베딩 상한(4,000자) 때문에 긴 문서의 뒷부분이 어떤 검색어로도 걸리지 않던 문제를 없앤다 —
  검색·읽기 규칙은 `context.md` 4절
- **임베딩**: 로컬 Ollama의 OpenAI 호환 API (`backend/src/embedding.rs`). 기본 모델 qwen3-embedding:0.6b(1024차원, bge-m3도 쓸 수 있다). 기동 시 한 번 예열한다
- **동기화**: `backend/src/embed_sync.rs`가 원본 텍스트의 MD5를 비교해 신규/변경분만 임베딩(diff, 멱등).
  서버 기동 시 1회 + 설정의 동기화 주기(기본 60초) + `llm-agent embed-sync` 수동.
  한 번에 하나만 돌도록 잡는 잠금(`GET_LOCK`)은 풀 밖의 연결 하나로 쥔다 — 풀에서 꺼내 쥐면 연결 수 1인 설정에서
  동기화가 나머지 일에 쓸 연결을 영영 못 얻어 매번 DB 한도의 두 배를 기다린 뒤 실패했고, 그동안 다른 DB 사용도 막혔다.
  청크 규칙·해시 식은 Node 백엔드와 바이트 단위로 같아, 이전한 설치에서 다시 나누거나 다시 임베딩하지 않는다.
  SQL로 직접 등록한 데이터는 다음 동기화(최대 1분) 뒤부터 검색된다

청크 규칙 v4는 문서 내부 공백을 보존하여 긴 빈 줄과 반복 문구가 병합에서 손실되지 않게 한다.
업데이트 후 첫 동기화에서 기존 청크를 자동으로 다시 나누고, 텍스트가 달라진 청크만 재임베딩한다.
청크가 일부 누락된 경우에도 다음 동기화에서 복원하며, 정상 청크의 ID와 벡터는 유지한다.
검색 전체의 결함 재현·수정 및 검증 범위는 [검색 검토 기록](docs/vector-search-review.md)에 있다.

이전 버전에서 영벡터나 극단적인 크기의 벡터가 성공으로 저장됐던 설치는 다음 복구를 한 번 실행한다. 정상 단위 벡터와 원본은
보존하며 스키마 변경은 없다. 아래 DB 이름은 실제 관리 DB 이름으로 바꾼다. SQL은 반복 실행 가능하다.

```bash
mariadb -u agent -p llm_agent < backend/sql/repair-invalid-vectors.sql
cd backend && cargo run --release -- embed-sync
```

복구 SQL은 저장 벡터를 한 번 스캔한다. MariaDB는 영벡터도 자기 코사인 거리를 0으로 반환하므로,
영벡터까지의 유클리드 거리로 노름을 계산해 FP32 제곱합의 안전 범위 밖에 있는 행을 제거한다.
새 버전에서는 잘못된 응답을 거부하고 유효한 벡터는 정규화하여 저장한다.
검색 시에도 ANN 상위 후보의 노름을 확인하므로 복구 전 불량 벡터가 결과로 노출되지는 않는다.
복구 SQL은 불량 후보마다 정확 보충 검색이 발생하는 비용을 없애기 위해 실행한다.

### 임베딩 준비 (벡터 검색에 필요)

macOS:

```bash
brew services run ollama
```

```bash
ollama pull qwen3-embedding:0.6b
```

Windows: `setup/qwen3-embedding/start.bat` 실행 (설치 확인·모델 다운로드·검증까지 자동, 중지는 `stop.bat`).
자세한 내용은 [setup/qwen3-embedding/README.md](setup/qwen3-embedding/README.md) 참고 — 관련도 거리 문턱(설정, 기본 0.4)을
그대로 써도 되는지 실측한 표와, `registry.ollama.ai`가 막힌 사내망에 모델을 파일로 반입하는 절차가 함께 있다.

**bge-m3를 쓰려면** — 같은 1024차원이라 설정 탭의 임베딩 모델만 `bge-m3`로 바꾸면 된다(1.2GB). 같은 형식의 스크립트가
[setup/bge-m3/](setup/bge-m3/README.md)에 있다.

**모델을 내리지 않게 한다.** Ollama는 5분 유휴 뒤 모델을 메모리에서 내리고 다음 요청에서 다시 올리므로(수 초),
한산한 시간대의 첫 질문이 그 비용을 그대로 낸다. `OLLAMA_KEEP_ALIVE=-1`로 끈다 — macOS는
`launchctl setenv OLLAMA_KEEP_ALIVE -1` 뒤 Ollama 재기동, Windows는 `setx OLLAMA_KEEP_ALIVE -1` 뒤 새 터미널에서
`start.bat` (그 스크립트가 이 값을 함께 걸어 준다). 서버는 기동 시 한 번 예열 호출을 보내 첫 질문만은 지켜 준다.

### 조회 실행

조회 DB 접속은 대상 DB(`target_db` 행)마다 커넥션 풀을 쓴다 (`backend/src/oracle.rs`, Instant Client의 세션 풀). 실행마다 접속·해제하면
세션 생성(수백 ms)과 NLS `ALTER SESSION` 왕복을 매번 낸다. 풀은 처음 쓸 때 만들고, 등록을 고치면 다음 조회부터 새 풀이
붙는다(접속정보·계정의 해시가 키다). 세션은 대상마다 최대 8개, 5분 유휴면 정리하고, 새 세션에만 NLS 형식을 건다.
5분 동안 한 번도 쓰이지 않은 풀은 통째로 닫는다(1분마다 확인) — 등록을 바꾸거나 지운 대상의 풀이 남지 않고, 유휴 세션을
스스로 정리하지 않는 클라이언트 버전에서도 대상 DB에 세션이 남지 않는다.
결과 행은 상한(1,001행)까지 가져와 1,000행을 넘으면 상한에 걸렸다고 표시한다.

## 대화 로그

모든 문답이 `chat_log` 테이블에 기록된다 (질문·답변·검색 요약·구간별 소요·검색과 실행 쿼리와 도구의 trace·시각). 용도는
두 가지 — 평가셋 구축, 그리고 "못 답한 질문"을 찾아 지식/쿼리를 보강하는 운영 루프.

- **보존 기간**: 서버가 기동 시 + 1시간 주기로 보존 기간(설정 '서버 → 대화 로그 보관', 기본 3일)이 지난 행을 정리한다
- 기록은 비동기라 실패해도 응답에 영향 없다. 모델 출력에 짝 잃은 서로게이트가 섞여도 저장 전에 걷어 내 행이 사라지지 않는다

못 답한 질문 찾기 예시:

```sql
SELECT question, created_at FROM chat_log
WHERE JSON_VALUE(trace, '$.outcome') IN ('error', 'rejected', 'cancelled')  -- 답변에 닿지도 못한 요청
   OR answer LIKE '%일반 지식으로 답변%'
   OR JSON_EXTRACT(trace, '$.steps[*].error') IS NOT NULL
   OR JSON_EXTRACT(trace, '$[*].error') IS NOT NULL   -- v 표기 없는 옛 행 (steps 배열이 최상위였던 형식)
ORDER BY created_at DESC;
```

쿼리 실행 오류는 답변 문구가 아니라 `trace`로 판별한다 — 실제 LLM은 답변을 자유롭게 쓰므로
특정 문구(`실행 오류` 등)로 거르면 정작 실패한 경우를 놓친다.
`trace.steps[].error`에는 실제 쿼리 실패만 들어간다. 반복 실행 거절 같은 제어용 거절은 모델에게만 알리고 스텝으로 남기지 않는다.

`trace.v`는 스키마 버전이다 (현재 5 — `{v, outcome, conversation_id, rounds, search, timing, steps}`. 이 필드가 없는 행은 trace가 steps 배열
자체였던 옛 형식). `steps`에는 이번 질문의 기록이 순서대로 섞인다 — 검색 `{search, targets, hits, failed?}`, 조회
`{step, query_name, params, targetDb, rowCount, rows(≤20), totalRows, capped?}` 또는 `{step, query_name, params, error}`, 그 밖의 도구
`{tool, summary, status}`(MCP 도구는 `tool`이 `서버__도구`, `summary`가 `서버 · 도구 "첫 인수"`). `search`는 요약 `{searches, targets, knowledge, qaMethods, queries, searchFailed?}`이고(적중 수는 검색마다의 합, 그 대상을
찾아본 적 없으면 null), `timing`은 `{total, llm[{ms, prompt, completion, cached, estimate}], tools[{ms, calls}]}`(ms)이다.
아무것도 찾아보기 전에 답의 첫 줄을 일반 지식 문구로 열어 되돌린 질문은 `searchFirst: true`가 붙고, 되돌린 요청의 `timing.llm` 항목에도 `searchFirst: true`가 있다.
v4(Node 백엔드)의 `timing.search`·`timing.oracle`은 v5에서 `timing.tools`(한 응답의 도구 일괄 실행 경과)로 합쳐졌다.

`trace.outcome`은 그 요청이 무엇으로 끝났는지다. 답변까지 간 요청만이 아니라
**답변에 닿지 못한 요청도 반드시 한 행을 남긴다** — 서버 오류·거부된 입력·본문 크기 초과가 기록되지
않으면, 정작 이 로그가 찾아내야 할 요청만 데이터에서 사라지고 장애는 '질문이 줄었다'로만 보인다.

| `outcome` | 뜻 | 함께 남는 것 |
| --- | --- | --- |
| `answered` | 답변까지 갔다 | `search`, `timing`, `steps` |
| `error` | 처리 중 서버 오류 | `error`(오류 원문 — 화면에는 나가지 않는다) |
| `cancelled` | 사용자가 멈췄거나 같은 대화의 새 질문이 앞 요청을 멈췄다 | — |
| `rejected` | 입력 단계에서 거부(400/413) | `reason` = `no_message` / `empty_message` / `too_long` / `body_too_large` / `bad_body` |

```sql
-- 거부·오류 추이 (클라이언트 버그나 장애를 건수로 본다)
SELECT JSON_VALUE(trace, '$.outcome') AS outcome,
       JSON_VALUE(trace, '$.reason')  AS reason,
       COUNT(*)
FROM chat_log
WHERE JSON_VALUE(trace, '$.outcome') <> 'answered'
GROUP BY outcome, reason ORDER BY COUNT(*) DESC;
```

검색이 아무것도 못 찾은 질문 (지식/쿼리 신규 등록 후보 — `trace.search`에 검색 요약이 남는다):

```sql
SELECT question, created_at FROM chat_log
WHERE JSON_VALUE(trace, '$.search.searches') > 0      -- 검색을 했는데 (인사처럼 검색 없이 답한 질문은 후보가 아니다)
  AND COALESCE(JSON_VALUE(trace, '$.search.knowledge'), 0) = 0   -- 찾아본 적 없으면 null, 찾았는데 없으면 0
  AND COALESCE(JSON_VALUE(trace, '$.search.qaMethods'), 0) = 0
  -- 경로B(qa_method 없이 쿼리만 등록)로 답한 질문을 후보로 잡지 않도록 쿼리 적중도 함께 본다.
  AND COALESCE(JSON_VALUE(trace, '$.search.queries'), 0) = 0
  -- 검색이 성립하지 않은 요청(임베딩 서버 없음)은 후보에서 뺀다 — 등록이 부족한 것이 아니다.
  AND JSON_VALUE(trace, '$.search.searchFailed') IS NULL
  AND JSON_VALUE(trace, '$.search.queriesFailed') IS NULL   -- v4 행
ORDER BY created_at DESC;
```

검색 없이 답한 질문 (모델이 검색을 건너뛴 경우 — 인사가 아닌데 여기 잡히면 시스템 프롬프트의 검색 규칙을 의심할 것.
프로젝트 소스만 읽고 답한 질문도 여기 잡힌다 — `steps[*].tool`로 구분한다):

```sql
SELECT question, LEFT(answer, 80) AS answer, created_at FROM chat_log
WHERE JSON_VALUE(trace, '$.outcome') = 'answered' AND JSON_VALUE(trace, '$.search.searches') = 0
ORDER BY created_at DESC;
```

검색 없이 일반 지식 문구로 답하려다 되돌려진 질문 (`searchFirst`) — 건수가 많으면 시스템 프롬프트의 검색 규칙을 다시 볼 것.
문구가 그대로 남은 답(가드가 질문당 한 번만 걸리므로, 되돌린 뒤에도 모델이 검색 없이 같은 답을 낸 경우. 소스 파일·MCP 도구로만 찾아보고 쓴 답과 문구를 인용한 답도 걸린다)도 함께 본다:

```sql
SELECT question, JSON_VALUE(trace, '$.search.searches') AS searches, LEFT(answer, 80) AS answer, created_at FROM chat_log
WHERE JSON_VALUE(trace, '$.searchFirst') IS NOT NULL   -- 되돌리지 않은 질문에는 없다
   OR (answer LIKE '%등록된 지식에 없는 내용이라%' AND JSON_VALUE(trace, '$.search.searches') = 0)
ORDER BY created_at DESC;
```

어디가 느린가 (요청당 구간별 소요 — 서버 로그의 `[agent] timing …` 한 줄과 같은 값. `timing.llm`의 토큰 수는 서버가 usage를 줄 때만 있고
`cached`는 prefix cache에 맞은 입력 토큰이다):

```sql
SELECT question,
       JSON_VALUE(trace, '$.timing.total') AS total_ms,
       JSON_VALUE(trace, '$.rounds') AS rounds,
       JSON_EXTRACT(trace, '$.timing.llm[*].ms') AS llm_ms,
       JSON_EXTRACT(trace, '$.timing.llm[*].prompt') AS prompt_tokens,
       JSON_EXTRACT(trace, '$.timing.llm[*].cached') AS cached_tokens,
       JSON_EXTRACT(trace, '$.timing.llm[*].completion') AS completion_tokens,
       JSON_EXTRACT(trace, '$.timing.tools[*].ms') AS tool_ms
FROM chat_log WHERE JSON_VALUE(trace, '$.v') >= 5
ORDER BY CAST(JSON_VALUE(trace, '$.timing.total') AS UNSIGNED) DESC LIMIT 20;
```

### 속도 조정

모델 요청 수와 요청 크기가 지연의 대부분이다. 손잡이는 설정 탭에 있다.

- **컨텍스트 토큰** — 줄이면 맥락 비우기 기준이 함께 줄어 요청이 작아진다(20만 아래에서는 도구 결과 한도도 그 1/8로 준다).
  모델이 실제로 받는 길이보다 크게 두지 않는다.
- **맥락 비우기 시작/목표** — 시작을 낮추면 긴 대화의 요청이 일찍 작아진다. 너무 낮으면 같은 결과를 다시 읽느라 요청 수가 는다.
- **도구 결과 하나** — 비우면 25,000. 대화 후반이 느리면 낮춘다 — 요청이 작아지는 대신 이어 읽는 요청이 는다.
- **질문당 시간** — 질문은 답할 때까지 모델을 부르고, 끝나기 45초 전에는 도구 없이 지금까지의 근거로 답하게 한다(그 45초는 그 답의 몫이라, 아직 답을 쓰기 시작하지 않은 앞 요청과 도구 실행은 그때 멈춘다).

```sql
SELECT ROUND(AVG(JSON_VALUE(trace, '$.rounds')), 1) AS rounds,
       ROUND(AVG(JSON_VALUE(trace, '$.timing.llm[0].prompt'))) AS first_prompt,
       ROUND(AVG(JSON_VALUE(trace, '$.timing.total'))) AS total_ms,
       COUNT(*) AS answered
FROM chat_log WHERE JSON_VALUE(trace, '$.v') >= 5 AND JSON_VALUE(trace, '$.outcome') = 'answered';
```

값을 바꾸면 `[llm] usage`·`[agent] timing` 로그와 위 SQL로 전후를 비교한다.

## 향후 확장 지점

- **새 쿼리/지식 추가**: 관리자 화면에서 추가하거나 MariaDB 테이블에 INSERT (임베딩은 기본 1분 주기로 자동 동기화).
  단일 쿼리는 `query_desc`·`input_desc`만 성실히 작성하면 되고, 다단계 절차는 `qa_method.method` 본문에 `query_name`을 순서대로 언급
- **임베딩 모델 교체**: 설정 탭의 임베딩 모델만 변경 (1024차원 유지 시). vLLM/TEI 등 OpenAI 호환 서버는 임베딩 주소로 전환.
  지시문을 학습한 모델(Qwen3-Embedding·Harrier 계열)은 **검색어 앞 지시문**으로 **질의에만** 접두를 붙인다
  (문서에는 붙지 않는다 — 그 비대칭이 모델의 학습 형식이다). 바꾸면 전 행이 자동으로 다시 임베딩되고,
  관련도 거리 문턱(기본 0.4)이 그 모델에서도 성립하는지는 등록 지식으로 직접 잴 것
- **새 도구**: 먼저 MCP 서버로 붙일 수 있는지 본다(위 'MCP 도구 서버로 도구 붙이기' — 코드 수정 없음). 결과 나눠 읽기·표 참조처럼
  대화 상태에 붙은 전용 처리가 필요한 도구만 `backend/src/voc_tools.rs`(지식·쿼리 쪽) 또는 `backend/src/tools/`(소스 쪽)에 정의와
  실행을 더하고, 시스템 프롬프트(`backend/src/context.rs`)에 언제 쓰는지 적는다. 내장 도구에는 쓰기 도구를 더하지 않는다
- **MCP 다음 단계**(설계만, [MCP 설계](docs/mcp-design.md)): 도구가 수십 개를 넘으면 '도구 찾기' 도구로 정의를 필요할 때만 싣기,
  상태를 가진 서버를 위한 대화별 서버 프로세스, 쓰기 도구를 위한 실행 전 승인 창(서버의 elicitation도 이 창이 필요하다),
  사용자 로그인과 사용자별 OAuth
