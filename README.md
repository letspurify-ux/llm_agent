# SPACE VOC Agent

사내 지식과 조회용 DB(Oracle)를 결합해 질문에 답하는 지식 관리 및 Q&A LLM Agent.

```
사용자 질문 (+ 최근 대화)
  → LLM 결정 루프 (매 스텝 행동 하나):
      search      — 사내 자료가 필요하면 지식/Q&A처리방법/쿼리 중 필요한 대상을 골라 벡터 검색 (검색어는 LLM이 쓴다)
      expand      — 잘린 지식·처리방법 본문의 전체를 청구 (search·expand에는 더는 필요 없는 자료를 버리는 drop을 함께 실을 수 있다)
      run_query   — DB 조회가 필요하면 쿼리 관리 테이블의 쿼리 실행 (여러 번 가능)
      run_queries — 서로 의존하지 않는 조회 여럿을 한 번에 (병렬 실행, 최대 4개)
      answer      — 답변 (인사·잡담은 검색 없이 바로). 조회 결과의 표는 참조(```table step: N)로 적고 서버가 채운다
  → 최종 답변 (+ 검색·실행된 쿼리 trace)
```

검색은 LLM이 요청할 때만 일어난다. 인사 한 줄에도 지식·처리방법·쿼리 목록을 미리 실어 보내던 구조를
뒤집은 것이다 — 그때는 첫 LLM 호출의 프롬프트가 질문과 무관하게 최대치였다. 검색·조회가 진행되는 동안
화면에는 그 사실이 바로 표시된다(아래 '진행 상황 스트림').

- **agent 관리 DB**: MariaDB — `knowledge`(지식), `qa_method`(Q&A 처리 방법), `query_registry`(쿼리 관리), `target_db`(조회대상 DB 접속 정보)
- **조회용 DB**: Oracle (node-oracledb — 기본은 Thin 모드라 Instant Client 불필요, `.env`의 `ORACLE_DRIVER=oci`로 Thick(OCI) 모드 전환 가능). 여러 개 등록 가능
- **LLM**: vLLM / OpenRouter 등 OpenAI 호환 API. 개발용 규칙 기반 Mock 내장
- **UI**: React(Vite) 채팅 화면과 관리자 화면. 답변은 markdown(표·제목·목록)으로 구조화되어 렌더링(react-markdown + remark-gfm), 수식은 KaTeX. 상단 **관리자**에서 DB·지식·방법·쿼리를 검색하고 추가·수정·삭제할 수 있다.

## 대화 맥락

"그럼 김철수는?", "재시작은 어떻게 해?" 같은 후속 질문을 해석한다. 서버는 세션을 저장하지 않고
클라이언트가 최근 대화를 `POST /api/chat`의 `history`에 실어 보낸다 (최근 6턴, 턴당 1,500자로 제한).

- LLM 프롬프트에 "최근 대화" 섹션으로 전달되어 지시대명사·생략된 대상을 해석한다
- 검색어는 LLM이 쓴다 — 후속 질문이면 대화에서 대상을 복원해 적는다 ("그럼 김철수는?" → "김철수 고객 주문 상태").
  Mock은 그럴 수 없으므로 첫 검색에서 처리 방법을 못 찾았을 때만 직전 질문을 덧붙여 한 번 더 찾는다 (`llm.js` mockDecide)

## 디렉토리

[context.md](context.md)에 **컨텍스트 관리 규칙**이 설계도로 정리돼 있다 — 무엇이 프롬프트에 들어가고,
어떻게 들어오고, 얼마나 실리고, 어떻게 나가는가. 상수 하나를 고칠 때 함께 봐야 할 것도 그 문서에 있다.

```
backend/
  sql/schema.sql, seed.sql   # MariaDB DDL + 데모 데이터
  src/server.js              # Express, POST /api/chat
  src/admin.js               # 관리자 CRUD·검색 API, 입력 검증·참조 보호
  src/agent.js               # agentic loop (핵심 제어 흐름)
  src/llm.js                 # LLM 인터페이스 + Mock (provider 선택)
  src/llm-openai.js          # OpenAI 호환 클라이언트 (vLLM/OpenRouter)
  src/search.js              # 벡터 검색(MariaDB VECTOR 인덱스) — 검색 구현은 이 파일에만 있다
  src/db.js                  # MariaDB 풀 + 관리 테이블 로더
  src/oracle.js              # Oracle 실행기 + SELECT 전용 가드 + mock 모드
frontend/
  src/App.jsx                # Vite + React 채팅 UI (단일 컴포넌트)
  src/AdminPanel.jsx         # DB·지식·방법·쿼리 관리 및 검색 화면
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
> **청크 구조로의 이행**(긴 지식이 앞부분만 검색되던 문제 — `context.md` 2절)은 별도 파일에 있다.
> 임베딩 저장소를 소스별로 나누고 `knowledge_chunk`를 만든다:
>
> ```bash
> mariadb --default-character-set=utf8mb4 < backend/sql/migrate-chunk.sql
> cd backend && npm run embed     # 청크 생성 + 최초 임베딩
> ```
>
> `npm run embed`는 지식 문서 수 × 평균 청크 수만큼 임베딩을 호출한다(문서 1,000건 × 10청크면 1만 회).
> 서버 기동 시에도 같은 동기화가 돌지만 그때는 첫 질문이 그 시간을 그대로 기다리므로, 한산한 시간에
> 미리 돌리는 편이 낫다. 검색이 정상인 것을 확인한 뒤 `DROP TABLE vec_store;` 로 옛 테이블을 지운다.

```bash
mariadb --default-character-set=utf8mb4 < backend/sql/seed.sql
```

앱 계정 생성 (관리자 화면의 저장·삭제를 위해 관리 테이블에도 쓰기 권한이 필요하다).
`<비밀번호>`는 직접 정하고, 같은 값을 `backend/.env`의 `MARIADB_PASSWORD`에 채운다
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
테이블이다(`context.md` 2절). 읽기만 주면 동기화가 매 주기 실패하는데, 증상은 '지식이 하나도
검색되지 않는다'로만 보인다.
```

SPACE 시스템 지식 데이터도 함께 등록:

```bash
mariadb --default-character-set=utf8mb4 < backend/sql/seed-space.sql
```

### 1-2. 조회용 Oracle 테스트 DB (Docker)

로컬에서 실제 Oracle로 테스트하려면 gvenzl/oracle-free 컨테이너를 쓴다 (`ORACLE_MOCK=1`로 두면 이 단계는 건너뛰어도 된다). 이미 있는 컨테이너를 재사용해도 되고, 없으면 새로 띄운다:

```bash
docker run -d --name oracle1521 -p 1521:1521 -e ORACLE_PASSWORD=password gvenzl/oracle-free:latest
```

`docker logs -f oracle1521`에 "DATABASE IS READY TO USE"가 뜨면 스키마·샘플 데이터·계정을 생성한다 (재실행 가능 — APP_USER가 없으면 스크립트가 직접 만든다):

```bash
docker exec -i oracle1521 sqlplus -s system/password@localhost:1521/FREEPDB1 < backend/sql/oracle-init.sql
```

생성되는 것 — `APP_USER` 계정과 그 스키마의 `BATCH_JOBS`/`CUSTOMERS`/`ORDERS` 테이블과 샘플 데이터, 그리고 **읽기 권한만 가진 조회 전용 계정 `VOC_READER`**(agent가 이 계정으로 접속). 접속 정보는 `target_db` 테이블에 `localhost:1521/FREEPDB1`로 등록되어 있다.

### 2. 백엔드

Node.js **20 이상**이 필요하다 (`backend/package.json`의 `engines` — 관리 DB 커넥터 `mariadb`가 그 아래에서는 로드를 거부해
`please upgrade node`로 기동이 멈춘다).

```bash
cd backend && npm install && cp .env.example .env
# .env의 MARIADB_PASSWORD에 위 앱 계정 생성 단계에서 정한 비밀번호를 채운 뒤:
npm start
```

`http://localhost:3001` 에서 기동. 기본값은 `LLM_PROVIDER=mock`, `ORACLE_MOCK=1` 이라 MariaDB만 있으면 동작한다.

### 3. 프론트엔드

```bash
cd frontend && npm install && npm run dev
```

`http://localhost:5173` 접속 (`/api`는 vite proxy로 백엔드에 전달).

`start_all.sh` 또는 각 앱의 `start.sh`로 실행하면 `backend/logs/backend.log`와
`frontend/logs/frontend.log`에 표준 출력·오류를 기록한다. UTC 날짜 기준 **오늘과 이전 2일분**만
보관하며(최대 72시간), 자정에 지난 로그를 `backend.log.YYYY-MM-DD` / `frontend.log.YYYY-MM-DD`로
분리하고 오래된 파일을 삭제한다. 출력이 없어도 실행 중에는 정리하며, 중지 중에는 다음 시작 때 정리한다.
최초 적용 시 기록별 날짜를 판별할 수 없는 기존 누적 로그는 삭제한다. 같은 날 재시작한 새 로그는 유지한다.
`tail -F backend/logs/backend.log`로 날짜가 바뀌어도 계속 추적할 수 있다. 날짜 기준 보관이므로
3일 안에 발생하는 로그의 총용량 제한은 없다. `npm start` / `npm run dev`의 직접 실행은 콘솔 출력만 한다.
로그 보관·종료 동작 검증: 저장소 루트에서 `node --test scripts/retained-log.test.cjs`.

#### 회귀 검증

```bash
npm test          # 순수 함수의 계약(수식 판정·차트 파싱·trace/CSV·주소 규칙)과 띄운 것을 내리는 규칙 — 몇 초
npm run test:ui   # 화면 동작의 계약 — 진짜 Chrome을 headless로 띄운다 (약 2분)
npm run test:admin # 관리자 검색·페이지 이동·저장·인증·작은 화면 검증
npm run test:production # 현재 소스를 빌드하고 preview 서버에서 핵심 화면 동작을 검증
npm run test:all  # 위 셋을 차례로
npm run test:regression # 필수 전체 회귀: 백엔드 원문 전송 + 위 셋 (Chrome 누락도 실패)
```

`npm run test:ui`는 단위 테스트가 닿지 못하는 것을 지킨다: 답이 길어질 때 대화가 언제 따라 내려가고
언제 가만히 있는가, 좁은 화면에서 원그래프 조각과 흐름도 글자가 어떻게 남는가, 인쇄에서 무엇이
풀리는가, 모델이 쓴 주소가 저절로 불려 나가지 않는가. 실제 진입점(`src/main.jsx`)을 그대로 띄우고
`/api/chat`만 가로채므로 서버도 모델도 필요 없다. Chrome이 없으면(`CHROME_PATH`로 지정할 수 있다)
조용히 건너뛰고, 검사가 끝나면 띄운 브라우저를 확인하고 내린다.

`test:production`은 테스트용 진입점 대신 실제 빌드된 페이지를 열어 대화·수식·차트·흐름도·조회 표와
후속 질문·홈 복귀를 확인한다. 결함 재현과 수정 내역은 [frontend 검토 기록](docs/frontend-audit.md)에 있다.

수식·Markdown·차트 관련 버그별 정식 테스트는 [회귀 검사 목록](docs/rendering-regressions.md)에 정리했다.
GitHub Actions는 모든 push/PR에서 `test:regression`을 실행한다. Node 22 이상과 Chrome,
frontend/backend의 `npm ci`가 필요하며 실제 DB나 LLM 서버는 사용하지 않는다.

#### 관리자 화면

상단 **관리자**를 누르면 기존 대화와 입력 중인 질문을 유지하면서 설정 화면을 연다.
**채팅으로**를 누르면 대화로 돌아간다. 네 탭에서 목록 검색과 항목 추가·수정·삭제를 지원한다.

| 탭 | 관리 내용 | 검색 대상 |
| --- | --- | --- |
| DB | 조회 대상 Oracle DB의 이름·접속 주소·사용자명·비밀번호 | 이름·유형·접속 주소·사용자명 (비밀번호 제외) |
| 지식 | 제목·원문 | 제목·본문 |
| 방법 | 제목·Q&A 처리 절차 | 제목·처리 방법 본문 |
| 쿼리 | 이름·SQL·입력/출력 설명·대상 DB | 이름·SQL·모든 설명·대상 DB |

검색은 서버에서 전체 데이터를 대상으로 부분 일치로 수행하며, 결과는 최근 등록순으로
20개씩 나눈다. `%`와 `_`도 검색어 그대로 취급한다. 쿼리의 대상 DB는 여러 개 선택할 수 있고
DB 선택 목록 안에서도 이름으로 검색할 수 있다. 검색 대상이 많아도 본문 전체를 브라우저로
내려받지 않으며 편집할 때 해당 항목만 읽는다.

- 저장한 원본은 MariaDB에 즉시 반영된다. 검색 색인은 기존 임베딩 동기화 주기에 따라 갱신된다
  (기본 60초, `EMBED_SYNC_INTERVAL=0`이면 `npm run embed`를 직접 실행).
- DB 탭의 비밀번호는 관리용 MariaDB가 아니라 **조회 대상 Oracle DB**의 비밀번호다. 조회 API에 포함하지 않으며, 수정 시 비워 두면 기존 값을 유지한다.
  운영 비밀번호는 기존 방식대로 `ENV:변수명`을 사용한다.
- 실행 유형에서 쿼리·프로시저·함수를 선택한다. 쿼리는 SELECT/WITH, 루틴은 아래의 단일 호출 형식을 사용한다. 쿼리에서 사용 중인 DB, 처리 방법에서 언급한 쿼리는
  참조를 먼저 변경해야 삭제하거나 이름을 바꿀 수 있다. SQL로 직접 변경하는 작업은 이 검사와 별개다.
- 저장 전 탭 전환·닫기·새로고침 시 변경 내용 유실을 확인하며, 저장 실패 시 입력 내용을 유지한다.
- 항목을 연 뒤 다른 화면에서 수정했다면 오래된 수정·삭제는 거부한다. 입력 내용을 보관하고 항목을
  다시 열어 최신 내용과 합친다. 서버를 재시작한 경우에도 항목을 다시 읽어야 한다.
- `backend/.env`에 `ADMIN_TOKEN`을 설정하고 백엔드를 재시작하면 관리자 API의 읽기·쓰기에
  인증 키가 필요하다. 키는 브라우저 메모리에만 보관한다. 미설정 상태는 기존 페이지와 같은
  사내망 전용 모드이며 사용자별 권한 관리는 제공하지 않는다.

기존 설치의 앱 계정에 SELECT만 부여했다면 위의 관리 테이블 네 개에 대한
`GRANT INSERT, UPDATE, DELETE`도 적용한다. 권한이 없으면 화면에서 저장 오류를 안내한다.
기존 DB에 `schema.sql`을 다시 실행하지 않는다.

API: `/api/admin/{databases,knowledge,methods,queries}`의 GET(검색 `q`, 페이지 `page`),
POST(추가), `/:id`의 GET/PUT/DELETE. 대상 DB 선택 목록은 `/api/admin/database-options`.
모든 요청은 `X-Admin-Request: 1`, 인증 키가 설정됐다면 `X-Admin-Token` 헤더가 필요하다.
PUT/DELETE에는 해당 항목 GET 응답의 `ETag`를 `If-Match` 헤더로 보낸다. 버전이 없으면 428,
이미 바뀌었으면 409로 응답하며 데이터는 변경하지 않는다. DB 비밀번호는 응답에 포함하지 않는다.

관리자 화면의 결함 재현과 수정·검증 범위는 [관리자 검토 기록](docs/admin-review.md)에 정리했다.

#### 다른 PC에서 접속하기

dev 서버는 모든 인터페이스에 바인딩되므로, 기동 로그(`logs/frontend.log`)의 `Network:` 줄에 찍힌
주소(`http://<이 PC의 IP>:5173`)를 같은 망의 다른 PC 브라우저에 그대로 입력하면 된다.
백엔드는 열 필요가 없다 — 브라우저가 아니라 vite가 `localhost:3001`을 대신 호출한다.

| 변수 | 용도 |
|---|---|
| `FRONTEND_HOST` | 바인딩 주소. `localhost`로 주면 다시 이 PC에서만 열린다 |
| `FRONTEND_ALLOWED_HOSTS` | IP가 아니라 **도메인 이름**으로 붙을 때 그 이름을 쉼표로 나열. 없으면 vite가 `Blocked request`로 막는다 |

```bash
FRONTEND_ALLOWED_HOSTS=agent.corp.local npm run dev
```

안 열린다면 방화벽부터 본다 — macOS는 첫 기동 때 수신 연결 허용 여부를 묻고, Windows는
`제어판 > Windows Defender 방화벽`에서 해당 포트의 인바운드를 허용해야 한다.
그리고 dev 서버에는 인증이 없다 — 신뢰하는 사내망에서만 열고, 공인 IP에 그대로 노출하지 않는다.

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
미완성 코드·링크·이미지·수식이 다음 행의 조회나 그림을 소유하지 않는다. 서버 조회 주입과
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
- **`answer`는 JSON 문자열이라 백슬래시를 두 번 쓰는 것이 정확하다** (`\\frac`). 한 번만 써도
  `llm-openai.js`의 `normalizeJsonEscapes`가 파싱 '전에' 되살린다. 무엇을 이스케이프로 인정할지를
  JSON.parse의 고정된 표에 맡기지 않고 우리가 정하는 것이 요점이다 — 두 번째 부류는 파싱이
  성공해버려서 맡기는 한 손댈 방법이 없다:

  | 모델이 쓴 것 | 맡겼을 때 | 지금 |
  |---|---|---|
  | `\[ x^2 \]`, `\alpha` | JSON.parse가 던져 **답변 전체가 소실** | 백슬래시로 되살린다 |
  | `\frac`, `\beta` | 폼피드·백스페이스 한 글자로 바뀌어 `rac`·`eta`만 남는다 | 되살린다 (본문에 쓰일 수 없는 문자다) |
  | `\times`, `\theta`, `\rho` | 탭·복귀 한 글자로 바뀌어 `imes`·`heta`·`ho`만 남는다 | 뒤에 영문자가 오면 되살린다 |
  | `\nabla`, `\neq` | 줄바꿈으로 바뀐다 | 명령 이름이 이어질 때만 되살린다 |
  | 문자열 안의 진짜 개행 | JSON에서 무효라 **답변 전체가 소실** | 이스케이프해 살린다 |

  대신 답변 본문에 **'탭 + 영문자'를 진짜로 쓰면 그 탭이 `\t`로 보인다.** 탭은 화면에서 공백과
  같아 잃어도 표시가 거의 없지만, `\times`·`\text`를 잃는 쪽은 수식이 통째로 깨진다.
  `response_format`(구조화 출력)으로는 이 부류가 해결되지 않는다 — `\times`는 `\t`+`imes`로 문법상
  완전히 유효해서 문법을 강제해도 그대로 통과한다 (`llm-openai.js`의 `chatCompletion` 주석 참고).

표기를 늘리거나 줄이려면 `math.js`(판정)와 백엔드 시스템 프롬프트(모델에게 알리는 표기)를 **함께**
본다 — 프롬프트는 모델이 어떤 표기를 고르게 할지만 정할 뿐, 실제로 그려지는 범위는 `math.js`가 정한다.

닫히지 않은 `$$`(토큰 한도로 잘린 응답)는 남은 답변을 통째로 수식으로 삼키므로 글자로 되돌린다.
완성된 수식 내부의 `*`나 백틱은 TeX 원문으로 보존한다. 일반 Markdown 코드 예시는
수식으로 재해석하지 않으며, KaTeX가 지원하지 않는 수식은 원문 보기로 남긴다.

#### 답변 안의 차트·흐름도

답변의 ```` ```chart ```` 코드블록은 그래프(Recharts)로, ```` ```mermaid ```` 코드블록은 흐름도(Mermaid)로
그린다. 모델에게 언제 어떻게 쓰는지는 백엔드 시스템 프롬프트가 알려 주고, 무엇을 차트로 받아들이는지는
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
`\\`로 적는다(GFM 규칙; 서버가 채우는 표도 그렇게 적고, 화면은 그 둘을 되돌려 읽는다). JSON을 쓰지 않는 이유는 `answer`
자체가 이미 JSON 문자열 안에 실려 오기 때문이다 — 그 안에 따옴표·중괄호를 또 넣으면 이스케이프가 한 번만
어긋나도 답변 전체가 파싱에서 떨어진다. 이 모양은 따옴표가 한 개도 없다.

**`data: step N`** — 모델은 조회 결과를 프롬프트에서 20행까지만 본다(`MAX_RESULT_ROWS`). 수백 행짜리
결과를 그리려면 값을 답변에 옮겨 적어야 하는데, 보지 못한 행은 적을 수 없고 본 행도 옮기는 동안 값이
바뀐다. 그래서 답변에는 이력 항목 번호만 적게 하고, 서버(`backend/src/chart.js`)가 손에 든 전체 행
(≤1,000, `MAX_ROWS`)으로 표를 채워 내보낸다. 번호는 프롬프트의 실행 이력 번호(`2. 쿼리이름 …`이면 2)와 같은
1-based 절대 인덱스이며 오류·메모 항목도 번호를 차지한다. `x`·`y`·`y2`를 함께 적으면 그 열만 싣고,
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
포기한다. 대화 이력으로 서버에 되돌려 보낼 때는
펜스와 설정 줄을 벗기고 표만(20행) 남긴다 — 모델의 다음 턴에 필요한 것은 무슨 값을 보여줬는가이지 그것을
어떻게 그렸는가가 아니다. `frontend`·`backend` 각각 `npm test`로 회귀 검증한다
(`frontend/test/chart.test.js`, `backend/test/chart.test.js`).

**Mermaid** — 절차·흐름·상태 전이 설명에 `flowchart TD` · `sequenceDiagram` 등을 쓴다.
`securityLevel: 'strict'`로 그리므로 라벨의 HTML은 글자로 취급되고, 문법이 틀리면 그림 대신 **코드 원문이
그대로** 보인다(오류 그림을 끼워 넣지 않는다). 노드 글자는 `A[글자]`처럼 따옴표 없이, 괄호·따옴표·
세미콜론 같은 특수문자는 피하는 것이 안전하다.

블록 문법을 바꾸려면 세 곳을 함께 본다 — `frontend/src/chart.js`(판정), `backend/src/chart.js`(참조
채우기), 백엔드 시스템 프롬프트(모델에게 알리는 표기).

#### 조회 결과 전체 보기 (⚡ 실행된 쿼리 패널)

모델은 조회 결과를 20행(`MAX_RESULT_ROWS`)까지만 보고 그중 몇 행만 답변에 옮겨 적는다. 조회된 행
**전부**(드라이버 상한 `MAX_ROWS` = 1,000건까지)는 답변 아래 **⚡ 패널**에 있다 (검색과 조회를 함께 세어
"검색 1회 · 실행된 쿼리 2건"으로 보인다). 줄 앞의 번호는 모델이 본 이력 번호와 같은 값이라, 답변이
"2번 조회 결과"라고 말하면 패널의 2번이 그것이다 — 스텝마다
쿼리 이름`@`대상 DB·바인드 값과 함께 행 전체를 표(세로·가로 스크롤, 머리글 고정)로 싣고, **CSV 내려받기**로
파일(UTF-8 BOM, 엑셀에서 바로 열림)로 받을 수 있다. 상한에 걸린 결과는 "N건 이상 — 조회 상한에 걸려
처음 N건만"으로 표시한다(실제는 더 많다). 오류 스텝은 우리가 만든 문구만 보이고 드라이버 원문은 로그에만
남는다. 서버 쪽 정리는 `backend/src/result.js clientTrace`, 화면의 표·CSV 규칙은 `frontend/src/trace.js`.
`chat_log`의 `steps`에는 예전처럼 20행만 남는다(로그는 분석용 표본이면 된다).

## 데모 시나리오 (seed 데이터 기준)

| 질문 | 동작 |
|---|---|
| 배치 재시작 방법 알려줘 | 쿼리 0회 — 지식만으로 답변 |
| BATCH001 작업 상태 알려줘 | `batch_job_status` 1회 → FAILED 결과 + 재시작 지식 결합 답변 |
| 홍길동 고객 주문 상태 알려줘 | 2단계 — `find_customer_id` 결과의 CUSTOMER_ID로 `order_status_by_customer` 실행 |
| 오늘 며칠이야 | **실제 LLM 필요** — 쿼리 0회. 프롬프트 끝에 실린 현재 시각(KST, 요일 포함)으로 바로 답한다. "어제", "이번 주" 같은 상대 날짜도 같은 값을 기준으로 절대 날짜로 바꾼다 (`today_date`는 DB 서버 시각 자체를 확인할 때만 실행된다) |
| 실패한 배치 다 보여줘 | **실제 LLM 필요** — `batch_list_by_status` 1회. `qa_method` 없이 `query_desc`만으로 선택되는 경로B 데모 |
| 쿠버네티스가 뭐야 (등록되지 않은 질문) | LLM의 일반 지식으로 답변 — "*등록된 지식에 없는 내용이라 일반 지식으로 답변합니다.*" 표시가 붙음 (Mock은 안내 문구만 표시) |
| (위 질문에 이어) 그럼 BATCH002는? | 후속 질문 — 최근 대화에서 "배치 상태 조회"임을 파악해 BATCH002로 재조회 |
| (위 질문에 이어) 재시작은 어떻게 해? | 후속 질문 — 직전에 확인한 BATCH001을 대상으로 재시작 방법 안내 |

> **실제 LLM 필요**로 표시한 행은 기본값(`LLM_PROVIDER=mock`)에서 재현되지 않는다. Mock은 매칭된 `qa_method` 본문에
> **이름이 적힌 쿼리만** 실행 후보로 삼기 때문이다(`llm.js`의 `plannedQueries`). 그래서 qa_method 없이 등록한 경로B 쿼리
> (`today_date`, `batch_list_by_status`)는 Mock에서 선택되지 않고, 검색된 지식만으로 답이 나간다 —
> 오류는 남지 않으므로 "라우팅이 고장났다"로 읽히기 쉽다.
>
> 이 한계를 Mock에서 없애지 않는 이유: 경로B는 `query_desc`를 읽고 고르는 판단이고, 그 판단이 LLM의 존재 이유다.
> 규칙 기반 Mock에 임계값으로 흉내 내면 양쪽으로 조용히 깨진다 — 특히 바인드 없는 `today_date`는 채울 값이 없어
> 언제나 실행 가능하므로, 임계값이 조금만 낮아도 아무 질문에나 걸리는 만능 쿼리가 된다.
> 두 행을 확인하려면 `LLM_PROVIDER=openai`로 바꿔서 실행한다.

등록된 지식·쿼리 결과가 있으면 반드시 그것에 근거해 답하고, 전혀 없을 때만 LLM 일반 지식으로 답한다. 일반 지식 답변에서도 사내 시스템의 구체적 상태(수치·상태값 등)는 지어내지 않도록 프롬프트로 제한한다 (`llm-openai.js`의 SYSTEM_PROMPT).

프롬프트(`llm-openai.js`의 `buildPrompt`)는 **자료 → 과제** 순서다: 관련 지식 → Q&A 처리 방법 → 실행 가능한 쿼리 목록 → 쿼리 실행 이력 → 최근 대화 → 사용자 질문 → 지시(현재 시각 KST + 다음 행동). 결정할 대상인 질문이 자료 뒤에 파묻히지 않게 하고, 요청마다 바뀌는 것(질문·대화·시각)을 뒤로 몰아 앞부분이 스텝 사이에 같은 토큰열로 남게(vLLM prefix caching) 한다. 같은 이유로 시스템 프롬프트에는 요청마다 달라지는 값을 싣지 않는다. 항목 한 건은 목록 한 줄이다 — 여러 줄짜리 본문은 들여쓰기로 항목 안에 묶고, SQL·오류처럼 줄바꿈이 뜻을 갖지 않는 것은 한 줄로 접는다.

```bash
curl -s localhost:3001/api/chat -H 'Content-Type: application/json' -d '{"message":"홍길동 고객 주문 상태 알려줘"}'
```

자료 섹션(관련 지식·Q&A 처리 방법·쿼리 목록)은 **검색한 뒤에만** 실린다. 찾아보지 않은 대상의 섹션은 아예 없고,
찾았는데 없으면 `(없음)`이다 — 둘을 섞으면 모델은 '등록된 것이 없다'로 읽고 검색 없이 일반 지식으로 답한다.
쿼리 목록은 짧은 형태에도 입력 설명을 포함합니다. 상세 대상에는 긴 용도·출력 설명을 더하고,
SQL 원문은 선택한 쿼리에만 표시합니다. 잘린 조회 결과는 `read_result`로 보관된 행·컬럼을 다시 읽습니다.

### 답변 안의 표 — 참조로 적고 서버가 채운다

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
서버(`backend/src/chart.js` `resolveTableData`)가 그 실행의 결과 행으로 GFM 표를 만들어 블록을 통째로 바꾼다 —
차트의 `data: step N`과 같은 기제다. `step`은 실행 이력의 번호(검색 줄도 번호를 차지한다), `cols`는 보일 열
(생략하면 앞 10열), `limit`은 행 수(생략하면 30, 최대 100). 다 싣지 못하면 표 아래에 밝히고, 전부는 ⚡ 패널에 있다.
옮겨 적다 틀리는 값(반올림·자릿수 누락)도 사라진다.

### 진행 상황 스트림 (`POST /api/chat`)

검색·조회가 시작되는 순간 화면에 보이도록 응답을 흘려보낼 수 있다. 클라이언트가 `Accept: application/x-ndjson`을
보내면 한 줄에 이벤트 하나(NDJSON)로 답하고, 없으면 위 curl처럼 JSON 하나로 답한다 — 마지막 `done` 줄의 본문이
그 JSON과 같다.

```bash
curl -sN localhost:3001/api/chat -H 'Content-Type: application/json' -H 'Accept: application/x-ndjson' \
  -d '{"message":"BATCH001 작업 상태 알려줘"}'
# {"type":"search","text":"BATCH001 배치 상태","targets":["qa_method","query"]}
# {"type":"search_done","text":"…","targets":[…],"hits":{"knowledge":null,"qaMethods":1,"queries":3}}
# {"type":"run_query","query_name":"batch_job_status","params":{"job_id":"BATCH001"},"targetDb":"ORDER_DB"}
# {"type":"run_query_done","query_name":"batch_job_status","targetDb":"ORDER_DB","rowCount":1}
# {"type":"done","answer":"…","trace":[…]}
```

| type | 시점 | 실리는 것 |
|---|---|---|
| `search` / `search_done` | 검색 시작 / 끝 | 검색어, 대상, 대상별 적중 수(`hits`), 검색이 성립하지 않은 대상(`failed`) |
| `run_query` / `run_query_done` | 조회 시작 / 끝 | 쿼리 이름, 바인드, 대상 DB, 건수 또는 화면용 오류 문구 (일괄 조회는 항목마다) |
| `answer_delta` / `answer_reset` | 답변이 생성되는 동안 | 답변 문자열의 조각(디코딩된 글자). reset은 앞선 조각을 버리라는 뜻이다 — 재시도했거나, 모델이 사고 과정에 적었던 답변 초안을 접고 조회를 택했을 때 |
| `done` | 마지막 | `{answer, trace}` — JSON 응답과 같다. 표·차트 참조가 채워진 최종 답이라 조각의 합과 다를 수 있다 |
| `error` | 헤더가 나간 뒤 실패 | `{error}` |

화면(`frontend/src/stream.js`)은 조각 경계와 예전 JSON 응답을 같은 함수로 읽고, 답을 기다리는 말풍선에 진행 줄을
세웠다가 답이 오면 같은 내용을 ⚡ 패널에 남긴다. 답변 조각은 미리보기로 그려지는데(`preview.js`), 표·차트·그림
블록은 done 뒤에야 성립하므로 그 자리는 안내 한 줄로 바꾼다. 프록시가 본문을 모아 두면 스트림의 뜻이 사라진다 — nginx는
`X-Accel-Buffering: no`를 서버가 보내고, 다른 프록시는 `Cache-Control: no-transform`을 본다.

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

프롬프트 예산(`backend/src/constants.js`의 `MAX_PROMPT_TOTAL_LEN`·`PROMPT_FLOORS`)과 출력 가드(`MAX_COMPLETION_TOKENS`)는 **128k 컨텍스트** 기준이다 — 입력 최악 ≈ 54~65k 토큰 + 출력 16k. 서버가 실제로 그 길이를 받는지는 코드가 알 수 없으니 연결 후 한 번 확인한다:

```bash
curl -s $LLM_BASE_URL/models | python3 -c 'import json,sys; print([m.get("max_model_len") for m in json.load(sys.stdin)["data"]])'   # vLLM: 131072 이어야 한다
```

- vLLM은 모델 config의 `max_position_embeddings`를 기본값으로 쓴다. `Qwen/Qwen2.5-32B-Instruct`는 그 값이 32,768이라 그대로 띄우면 **32k**다 — 128k는 YaRN을 켜야 나온다: `--max-model-len 131072 --hf-overrides '{"rope_scaling":{"rope_type":"yarn","factor":4.0,"original_max_position_embeddings":32768}}'` (정적 YaRN이라 짧은 입력의 품질이 조금 떨어진다는 것이 Qwen 쪽 안내다).
- 컨텍스트가 더 작은 모델이면 `MAX_PROMPT_TOTAL_LEN`과 `MAX_COMPLETION_TOKENS`를 함께 줄인다 (둘의 합이 컨텍스트 안에 들어야 한다). 매 호출의 실제 토큰 수는 서버 로그의 `[llm] usage prompt=… completion=… finish=…` 한 줄로 확인할 수 있다 — `finish=length`면 출력 가드에서 끊긴 것이다.

LLM 인터페이스는 `llm.js`의 `decide(ctx) → {action:'answer'|'search'|'run_query'|'run_queries', ...}` 함수 하나다. 다른 provider가 필요하면 같은 시그니처의 함수를 추가하고 `llm.js`의 분기에 연결한다. `agent.js`는 변경되지 않는다.

호출은 스트림(`stream: true`)이다. 조각이 `LLM_IDLE_TIMEOUT_MS`(기본 30초) 동안 오지 않으면 끊고 재시도하므로 죽은
엔드포인트를 전체 상한(120초) 전에 알아채고, 답변 문자열이 흘러오는 동안 화면에 미리보기를 낸다(위 '진행 상황
스트림'의 `answer_delta`). 마지막 조각의 `usage`(`stream_options: {include_usage: true}`)를 요청별 계측에 남기며,
그 파라미터를 모르는 서버(400)에는 다음부터 보내지 않는다 — `reasoning_effort`와 같은 규칙이다. SSE가 아니라
JSON 하나로 답하는 프록시도 같은 길로 읽는다.

## 실제 Oracle 연결

1. `target_db` 테이블에 접속 정보 등록 — `connection_info`는 Easy Connect 문자열(`host:1521/SERVICE`) 또는 tnsnames 별칭, `db_password`는 `ENV:변수명` 형식 권장
2. `.env`에서 `ORACLE_MOCK=0`, 참조하는 비밀번호 환경변수(`ORDER_DB_PASSWORD`) 설정
3. `query_registry`의 쿼리를 실제 테이블 구조에 맞게 등록

### 프로시저와 함수 등록

`query_registry`를 공통 실행 목록으로 사용한다. `query_type`은 `QUERY`(기본값),
`PROCEDURE`, `FUNCTION`이고, 이름·설명·대상 DB·벡터 검색·처리 방법에서의 참조는 동일하다.
기존 INSERT는 컬럼을 추가하지 않아도 QUERY로 등록된다. 루틴 등록 후에는 기존 쿼리처럼
임베딩 동기화를 실행하고, `query_desc`에는 용도, `input_desc`에는 입력값의 의미와 형식을 적는다.

기존 관리 DB는 **앱 업데이트 전에** 아래 파일을 적용한다. `schema.sql`로 초기화하지 않는다.

```bash
mariadb --default-character-set=utf8mb4 -u <관리자> -p < backend/sql/migrate-routines.sql
```

관리자 화면의 쿼리 탭에서 실행 유형과 SQL, 바인드 설정(JSON)을 입력한다.
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
- 스칼라는 바인드 이름을 컬럼명으로 한 행에 반환한다. NUMBER 출력은 큰 수의 정밀도를 보존하도록 문자열로 받는다. STRING 출력의 `maxSize`는 1~32767바이트이며 기본값은 32767이다. 받은 결과에는 기존 행·컬럼·셀 길이 제한을 적용한다.
- 입력값은 기존 쿼리처럼 필수이며 null·빈 문자열은 받지 않는다. 날짜는 STRING과 루틴의 명시적 변환을 사용한다. 빈 조회 결과는 NULL 커서 대신 열린 빈 REF CURSOR로 반환해야 한다.
- 호출 이름은 `루틴`, `패키지.루틴`, `스키마.패키지.루틴` 형태를 지원한다. 인수는 바인드만 사용하며 `p_id => :id` 같은 명명 인수도 가능하다. 주석·리터럴·추가 문장·DECLARE·SQL*Plus의 `/`는 넣지 않는다.
- 루틴은 `ORACLE_MOCK=0`인 실제 Oracle에서 실행한다. mock에서는 지원하지 않는다는 오류를 반환한다.

프로시저·함수의 실행/결과 읽기 오류는 해당 조회 이력의 실패로 기록하고 에이전트 흐름을 계속한다.
병렬 실행에서는 실패한 항목과 관계없이 다른 항목의 결과를 보존한다. 커서 닫기·rollback·연결 반납의
오류가 원래 결과를 덮지 않으며, 정리에 실패한 연결은 재사용하지 않도록 폐기한다.

루틴은 읽기 전용 트랜잭션과 `autoCommit: false`로 실행하고 결과를 읽은 뒤 rollback한다.
루틴 내부의 일반 DML은 거부되지만, 명시적 COMMIT/ROLLBACK이나 자율 트랜잭션·외부 호출의
부작용까지 SQL 호출 형식 검사로 보장할 수는 없다. 따라서 조회 전용으로 검증한 루틴만 등록하고
대상 계정에는 해당 루틴의 EXECUTE 권한만 추가한다. 데이터를 변경하는 업무 실행은 이 기능의 범위에 포함하지 않는다.

기존 테스트 Oracle 컨테이너에서 루틴 통합 검증만 실행하려면:

```bash
cd backend
ORACLE_TEST_EXISTING_CONTAINER=oracle1521 node --test --test-name-pattern='등록 프로시저' test/oracle/oracle.test.js
```

이 모드는 새 DB를 만들거나 기존 데이터를 초기화하지 않는다. 기존 `APP_USER`, `VOC_READER`
샘플 계정을 사용하며, 고유 이름의 검증용 루틴과 테이블만 생성한 뒤 정리한다.

바인드 방향과 REF CURSOR 처리 방식은 [node-oracledb 바인드 문서](https://node-oracledb.readthedocs.io/en/latest/user_guide/bind.html)를 따른다.

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

조회한 DB 이름은 화면의 실행 trace에 `쿼리이름@DB이름`으로 나오고 프롬프트의 실행 이력에도 같은 형태로 실린다. 그러므로 `target_db.db_name`에는 **사람이 읽을 이름**을 등록할 것 (접속 주소·계정은 `target_db`의 다른 컬럼이고 화면에 나가지 않는다).

구 스키마(`target_db_name VARCHAR(100)`)에 목록을 넣으면 뒤가 잘린 채 저장되어 후보가 조용히 사라진다 — `sql/seed.sql`이 재실행 시 `VARCHAR(500)`으로 넓힌다.

### 드라이버 모드 (thin / oci)

`.env`의 `ORACLE_DRIVER`로 고른다. 기본은 `thin`이고, 그대로 두면 설치할 것이 없다.

| 값 | 설명 | 추가 설치 |
|---|---|---|
| `thin` (기본) | 드라이버가 Oracle 프로토콜을 직접 말한다 | 없음 |
| `oci` (= `thick`) | 이 머신에 설치된 Oracle Client 라이브러리를 거쳐 붙는다 — 사내 표준이 OCI이거나 thin이 지원하지 않는 접속(외부 인증, 일부 wallet/Kerberos 구성, 구형 서버)이 필요할 때 | Oracle Instant Client |

`oci`로 쓸 때 필요하면 함께 지정한다 (둘 다 비워 두는 것이 정상 경로다).

- `ORACLE_CLIENT_LIB_DIR` — Instant Client(libclntsh) 디렉터리. 비우면 OS 기본 검색 경로(Linux `LD_LIBRARY_PATH`·ldconfig / Windows `PATH` / macOS `~/lib`)
- `ORACLE_CLIENT_CONFIG_DIR` — `tnsnames.ora`·`sqlnet.ora` 디렉터리. 비우면 `TNS_ADMIN`

Thick 초기화는 프로세스에 한 번뿐이고 첫 접속보다 먼저여야 하므로 기동 시점에 한다.
Client 라이브러리를 찾지 못하면 기동 로그에 `[setup] ORACLE_DRIVER=oci but the Oracle Client
could not be initialized …`가 남고 조회는 전부 실패한다 — 이 실패를 첫 질문이 아니라 기동
로그에서 보라고 기동 시점에 확인한다. 실제로 어느 모드로 떴는지는 기동 배너의
`ORACLE_DRIVER=…`가 알려준다(원본 환경변수가 아니라 해석된 값이다).

접속 단계 타임아웃(`connectTimeout`/`transportConnectTimeout`)은 thin 전용이다 — `oci`에서 같은
상한이 필요하면 `sqlnet.ora`의 `SQLNET.OUTBOUND_CONNECT_TIMEOUT`이나 접속 문자열의
`(CONNECT_TIMEOUT=…)`로 준다. 조회 타임아웃(`ORACLE_TIMEOUT_MS`)은 두 모드 모두에 적용된다.

로컬 테스트 컨테이너(위 1-2단계)를 쓰는 경우 접속 정보는 이미 `target_db`에 등록되어 있다.
`.env`에서 `ORACLE_MOCK=0`으로 바꾸고, `ORDER_DB_PASSWORD`에 조회 계정 `VOC_READER`의 비밀번호
(`oracle-init.sql`의 `CREATE USER ... IDENTIFIED BY`에 있는 값)를 채우면 된다.
`.env.example`에 값을 넣어두지 않는 이유는, 채워져 있으면 "여기는 내가 채워야 한다"는 신호가 사라져
저장소에 적힌 비밀번호가 그대로 운영 조회 계정에 남기 때문이다.

## 보안

- **조회 전용 가드**: QUERY 유형은 실행 직전 SELECT/WITH로 시작하는 단일 문장만 허용 — UPDATE/DELETE/DDL/다중 문장은 차단된다 (`sql.js`의 `assertReadOnly`).
  `SELECT … FOR UPDATE`도 거부한다 — 조회 문장이라 '첫 키워드' 검사는 통과하지만 조회대상 DB의 행에 잠금을 걸어 운영 트랜잭션을 대기시킨다.
  문자열 리터럴·주석 경계는 정규식이 아니라 단일 패스 스캐너로 판정한다 — Oracle q-quote(`q'!...!'`)는 구분자가 임의 문자라
  일부만 모델링하면 리터럴에 숨은 세미콜론을 놓치거나 정상 쿼리를 오탐한다. 경계를 확정할 수 없는 SQL(닫히지 않은 리터럴)은 거부한다.
  두 방향 모두 `backend`에서 `npm test`로 회귀 검증한다 (`backend/test/sql.test.js`)
- LLM은 SQL을 직접 쓸 수 없고 `query_registry`에 등록된 쿼리의 **이름만 선택**한다. 사용자 입력은 바인드 변수 값으로만 전달 (문자열 결합 없음)
- 그래도 조회 계정(`target_db.db_user`)은 **read-only 권한 계정**을 사용할 것 (심층 방어).
  Oracle 12c+라면 `GRANT SELECT`가 아니라 `GRANT READ`를 준다 — 차이는 딱 하나, READ에는 `LOCK TABLE`과 `SELECT … FOR UPDATE`가 빠져 있어
  위 가드와 같은 규칙이 계정 차원에서도 강제된다 (`sql/oracle-init.sql`이 그렇게 부여한다)
- `db_password`는 `ENV:변수명` 형식으로 환경변수 참조 권장. 평문 저장은 개발용만
- 관리 DB 조회 타임아웃 `MARIADB_TIMEOUT_MS`(기본 30초) — 관리 DB만 예산 없는 I/O였다(Oracle·LLM·임베딩은 전부 상한이 있다).
  검색은 agent 루프의 예산 검사보다 앞에서 돌기 때문에, 여기가 매달리면 문서화된 요청 상한이 통째로 성립하지 않는다.
  커넥터의 `socketTimeout`이 아니라 `queryTimeout`을 쓴다 — 전자는 다시 세팅되지 않는 무활동 타이머라 풀에서 노는 커넥션이 그대로 걸린다
  (실측: 2초로 두면 유휴 5초마다 커넥션이 죽고 fatal 오류가 로그에 쌓인다)
- 조회 쿼리 타임아웃 `ORACLE_TIMEOUT_MS`(기본 30초) — 느린 쿼리가 요청을 무한 대기시키지 않는다.
  빈 값·0·오타는 기본값으로 되돌리고 경고를 남긴다 (0은 드라이버에서 "타임아웃 없음"을 뜻하므로 그대로 두면 정반대로 동작한다)
- 조회 결과는 `maxRows: 1000`(`MAX_ROWS`) 제한. 셀당 200자 절단은 드라이버 경계(`oracle.js`)에서, 프롬프트·로그의 20행 절단은 `agent.js`의 `capRows`에서 적용하고
  "외 N건 생략 (총 N건)"으로 표기한다. LOB/이진 값도 이 경계에서 문자열로 정규화된다 (커넥션을 닫으면 무효가 되는 스트림 객체가 로그·프롬프트로 새지 않도록)

## 검색 (벡터 — 10,000건 이상 대응)

지식·처리방법은 **벡터 검색**(MariaDB 네이티브 `VECTOR(1024)` + 벡터 인덱스, 코사인 거리)이다 (`search.js`).
쿼리는 query_name 정확 일치를 먼저 찾고, 일치하지 않으면 벡터 검색합니다.
검색어는 LLM이 질문의 핵심 낱말 몇 개로 쓰고(`llm-openai.js` 시스템 프롬프트), 대상은 셋 중 필요한 것만 고른다 —
`knowledge`(지식), `qa_method`(처리방법), `query`(쿼리 목록). 무엇이 필요한지 확실하지 않으면 셋 다 찾는다.
세 검색은 병렬이고 임베딩은 한 번만 계산된다(검색어 단위 LRU 캐시).

캐시는 임베딩 서버·모델·실제 전송 입력(질의 접두 포함)을 구분한다. 응답은 1024차원과 FP32
유효성을 검사하고 단위 길이로 정규화한 뒤 저장·캐시한다. 잘못된 응답은 검색 불가로 알리며,
다음 요청에서 다시 시도한다.

검색 후보는 현재 본문·모델의 해시와 대조한다. 평상시는 벡터 인덱스 후보를 PK로 읽는 한 번의
조회이며, 오래된 벡터나 삭제된 원본이 후보를 차지하면 유효한 결과를 정확 검색으로 보충한다.
이 예외 경로는 전체 벡터를 검사할 수 있고 `MARIADB_TIMEOUT_MS`의 제한을 받는다. 보충 실패 시
이미 검증한 후보는 보존하며, 그런 후보도 없으면 검색 불가로 알린다.

- **LIKE 검색은 없앴다.** 인덱스를 못 쓰는 `%…%` 스캔이라 비용이 (행 수 × 낱말 수 × 조사 변형 × 컬럼 수 × 본문 길이)에
  비례했고, 질문 낱말 30개면 행마다 LIKE를 180번 평가했다 — 지식이 만 건이면 검색 한 번이 초 단위였다.
  정확 키워드(BATCH001 등)는 검색어에 그대로 들어가 벡터 거리에 반영된다.
- **임베딩 서버가 없으면 벡터 검색은 성립하지 않는다.** 쿼리명 정확 일치는 임베딩 없이도 동작한다. 그 상태는 '0건'이 아니라 **검색 불가**로 프롬프트·화면·chat_log에
  남는다 — 모델이 '등록된 자료가 없다'고 단정하지 않게 하고, 분석 SQL이 그 질문을 지식 보강 후보로 잘못 세지 않게 한다.
- **벡터 저장**: 별도 vector DB 없이 `vec_<소스>` 테이블(`vec_knowledge_chunk`·`vec_qa_method`·`vec_query_registry`).
  원본 테이블은 변경하지 않는 companion 구조. 소스마다 인덱스를 나눈 이유는 한 인덱스에 담고 `src`로
  거르면 큰 소스가 상위 K건을 차지해 작은 소스의 검색이 조용히 주저앉기 때문이다
- **지식 청킹**: 긴 지식은 `knowledge_chunk`로 나뉘어 검색된다(원문은 `knowledge`에 그대로).
  임베딩 상한(4,000자) 때문에 긴 문서의 뒷부분이 어떤 검색어로도 걸리지 않던 문제를 없앤다 —
  검색·병합·본문 청구 규칙은 `context.md` 2절
- **임베딩**: 로컬 Ollama의 OpenAI 호환 API (`embedding.js`). 기본 모델 bge-m3(1024차원). 기동 시 한 번 예열한다
- **동기화**: `embed-sync.js`가 원본 텍스트의 MD5를 비교해 신규/변경분만 임베딩(diff, 멱등).
  서버 기동 시 1회 + `EMBED_SYNC_INTERVAL`(기본 60초) 주기 + `npm run embed` 수동.
  SQL로 직접 등록한 데이터는 다음 동기화(최대 1분) 뒤부터 검색된다

청크 규칙 v4는 문서 내부 공백을 보존하여 긴 빈 줄과 반복 문구가 병합에서 손실되지 않게 한다.
업데이트 후 첫 동기화에서 기존 청크를 자동으로 다시 나누고, 텍스트가 달라진 청크만 재임베딩한다.
청크가 일부 누락된 경우에도 다음 동기화에서 복원하며, 정상 청크의 ID와 벡터는 유지한다.
검색 전체의 결함 재현·수정 및 검증 범위는 [검색 검토 기록](docs/vector-search-review.md)에 있다.

이전 버전에서 영벡터나 극단적인 크기의 벡터가 성공으로 저장됐던 설치는 다음 복구를 한 번 실행한다. 정상 단위 벡터와 원본은
보존하며 스키마 변경은 없다. 아래 DB 이름은 실제 관리 DB 이름으로 바꾼다. SQL은 반복 실행 가능하다.

```bash
mariadb -u agent -p llm_agent < backend/sql/repair-invalid-vectors.sql
cd backend && npm run embed
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
ollama pull bge-m3
```

Windows: `setup/bge-m3/start.bat` 실행 (설치 확인·모델 다운로드·검증까지 자동, 중지는 `stop.bat`).
자세한 내용은 [setup/bge-m3/README.md](setup/bge-m3/README.md) 참고.

**다른 모델을 쓰려면** — `qwen3-embedding:0.6b`(1024차원, 640MB)용 같은 형식의 스크립트가
[setup/qwen3-embedding/](setup/qwen3-embedding/README.md)에 있다. 관련도 문턱(`MAX_DIST`)을 그대로 써도 되는지
실측한 표와, `registry.ollama.ai`가 막힌 사내망에 모델을 파일로 반입하는 절차가 함께 있다.

**모델을 내리지 않게 한다.** Ollama는 5분 유휴 뒤 모델을 메모리에서 내리고 다음 요청에서 다시 올리므로(수 초),
한산한 시간대의 첫 질문이 그 비용을 그대로 낸다. `OLLAMA_KEEP_ALIVE=-1`로 끈다 — macOS는
`launchctl setenv OLLAMA_KEEP_ALIVE -1` 뒤 Ollama 재기동, Windows는 `setx OLLAMA_KEEP_ALIVE -1` 뒤 새 터미널에서
`start.bat` (그 스크립트가 이 값을 함께 걸어 준다). 서버는 기동 시 한 번 예열 호출을 보내 첫 질문만은 지켜 준다.

### 자료 확대·복구·숨김

검색한 자료는 요청 동안 보관하고, 프롬프트에는 예산에 맞는 부분만 표시합니다.
ID는 항상 유지하며 `확대 가능` 표시가 본문을 더 읽을 수 있는지를 알립니다.

```json
{"action":"expand","ids":["k12"],"drop":["k7","m2"]}
```

`drop`은 본문을 숨길 뿐 원본을 지우지 않습니다. 보관 목록의 ID를 `expand`로 지정하면 다시 표시합니다.
확대·복구·우선 표시를 합해 요청당 2건이며, 펼친 처리방법은 최대 4,500자입니다.
같은 문서의 떨어진 지식 구간도 보관하고, 표시할 때 문서별 본문 총량을 10,000자로 제한합니다.
확보한 근거를 재검색으로 교체하지 않습니다. 상세 규칙은 [context.md](context.md)를 참고하세요.

### 쿼리 목록

후보는 정확한 쿼리명 적중, 처리방법 본문이 지목한 쿼리, 벡터 검색 결과를 합쳐 구성합니다.
검색당 최대 30개이며, 요청 안에서는 기존 목록과 병합합니다. 실제 표시량은 프롬프트 예산에 따릅니다.

짧은 형태에도 이름·용도·바인드·입력 설명과 선택해야 할 대상 DB를 표시합니다.
`input_desc`에는 필수 파라미터의 의미·형식·허용값을 1,000자 안에 적으세요.
처리방법이 지목한 쿼리와 직접 검색 상위 5건에는 긴 용도·출력 설명을 더합니다.
SQL 원문은 선택된 쿼리에만 표시합니다. 잘린 입력 설명이나 없는 규칙을 모델이 추측하도록 두지 않습니다.

### 보관된 조회 결과 다시 읽기

```json
{"action":"read_result","step":2,"cols":["NEXT_JOB_ID"],"offset":20,"limit":5}
```

실행 이력 2번의 결과 중 21행부터 5행을 읽습니다. `cols`는 정확한 컬럼명 목록이며 생략하면 전체입니다.
DB 재실행 없이 기존 `fullRows`를 읽고, 해당 실행의 프롬프트 표시 범위만 바꿉니다.
실행 번호·표와 차트 참조·로그의 초기 미리보기는 유지합니다. 요청당 최대 2회이며,
잘못된 요청도 횟수에 포함됩니다. 드라이버가 이미 잘라 보관한 셀은 복원되지 않습니다.
`trace.search.resultReads`에 시도 횟수가 남습니다.

### 조회 실행

조회 DB 접속은 대상 DB(`target_db` 행)마다 커넥션 풀을 쓴다 (`oracle.js`). 실행마다 접속·해제하던 때는 세션 생성
(수백 ms)과 NLS `ALTER SESSION` 왕복을 매 스텝 냈다. 풀은 처음 쓸 때 만들고, 등록을 고치면 다음 조회부터 새 풀이
붙는다(접속정보·계정의 해시가 키다). 세션은 최대 4개, 5분 유휴면 정리한다. 결과 행은 상한(1,001행)까지 한 번에
가져온다(`fetchArraySize`).

## 대화 로그

모든 문답이 `chat_log` 테이블에 기록된다 (질문·답변·검색 요약·구간별 소요·검색과 실행 쿼리의 trace·시각). 용도는
두 가지 — 평가셋 구축, 그리고 "못 답한 질문"을 찾아 지식/쿼리를 보강하는 운영 루프.

- **3일 보존**: 서버가 기동 시 + 1시간 주기로 3일 지난 행을 정리한다 (`server.js`의 `CHAT_LOG_RETENTION_DAYS`)
- 기록은 비동기라 실패해도 응답에 영향 없다

못 답한 질문 찾기 예시:

```sql
SELECT question, created_at FROM chat_log
WHERE JSON_VALUE(trace, '$.outcome') IN ('error', 'rejected')  -- 답변에 닿지도 못한 요청
   OR answer LIKE '%일반 지식으로 답변%'
   OR JSON_EXTRACT(trace, '$.steps[*].error') IS NOT NULL
   OR JSON_EXTRACT(trace, '$[*].error') IS NOT NULL   -- v 표기 없는 옛 행 (steps 배열이 최상위였던 형식)
ORDER BY created_at DESC;
```

쿼리 실행 오류는 답변 문구가 아니라 `trace`로 판별한다 — 실제 LLM은 답변을 자유롭게 쓰므로
특정 문구(`실행 오류` 등)로 거르면 정작 실패한 경우를 놓친다.
`trace.steps[].error`에는 실제 쿼리 실패만 들어간다. 루프 가드가 남기는 제어용 기록(같은 쿼리 반복 등)은
`note` 필드라 이 집계에 섞이지 않는다 — 정상적으로 답한 턴이 실패로 잡히지 않게 하기 위함.
`trace.v`는 스키마 버전이다 (현재 4 — `{v, outcome, search, timing, steps}`. 이 필드가 없는 행은 trace가 steps 배열
자체였던 옛 형식). 4부터 `steps`에는 검색 기록 `{search, targets, hits, failed?}`이 쿼리 기록과 같은 배열에 순서대로
섞인다(번호가 곧 프롬프트의 스텝 번호), `search`는 요약 `{searches, targets, knowledge, qaMethods, queries,
queriesFailed?, searchFailed?}`이고, `timing`은 `{total, llm[], search[], oracle[]}`(ms)이다.

`trace.outcome`은 그 요청이 무엇으로 끝났는지다 (v3부터 반드시 있다). 답변까지 간 요청만이 아니라
**답변에 닿지 못한 요청도 반드시 한 행을 남긴다** — 서버 오류·거부된 입력·본문 크기 초과가 기록되지
않으면, 정작 이 로그가 찾아내야 할 요청만 데이터에서 사라지고 장애는 '질문이 줄었다'로만 보인다.

| `outcome` | 뜻 | 함께 남는 것 |
| --- | --- | --- |
| `answered` | 답변까지 갔다 | `search`, `steps` |
| `error` | 처리 중 서버 오류(500) | `error`(오류 원문 — 화면에는 나가지 않는다) |
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
  -- 'query'를 직접 검색한 적 없는 요청(경로A만 돈 요청)에서는 null이라 COALESCE가 0으로 보고 조건을 통과시킨다.
  AND COALESCE(JSON_VALUE(trace, '$.search.queries'), 0) = 0
  -- 검색이 성립하지 않았거나(임베딩 서버 없음) 관리 DB 장애로 쿼리 목록을 못 읽은 요청은 후보에서 뺀다
  -- (등록이 부족한 것이 아니다). 그 요청은 search.searchFailed / search.queriesFailed 가 true로 남는다.
  AND JSON_VALUE(trace, '$.search.searchFailed') IS NULL
  AND JSON_VALUE(trace, '$.search.queriesFailed') IS NULL
ORDER BY created_at DESC;
```

검색 없이 답한 질문 (모델이 검색을 건너뛴 경우 — 인사가 아닌데 여기 잡히면 시스템 프롬프트의 검색 규칙을 의심할 것):

```sql
SELECT question, LEFT(answer, 80) AS answer, created_at FROM chat_log
WHERE JSON_VALUE(trace, '$.outcome') = 'answered' AND JSON_VALUE(trace, '$.search.searches') = 0
ORDER BY created_at DESC;
```

어디가 느린가 (요청당 구간별 소요 — 서버 로그의 `[agent] timing …` 한 줄과 같은 값. `timing.llm`의 항목은
`{ms, prompt, completion}`이고 토큰 수는 서버가 usage를 줄 때만 있다. `timing.oracle`의 항목은 조회 '한 번'이
아니라 결정 한 번의 경과다 — 일괄 조회는 병렬로 돌므로 항목마다 재면 겹친 시간이 그 수만큼 더해진다):

```sql
SELECT question,
       JSON_VALUE(trace, '$.timing.total') AS total_ms,
       JSON_LENGTH(trace, '$.timing.llm') AS llm_calls,
       JSON_EXTRACT(trace, '$.timing.llm[*].ms') AS llm_ms,
       JSON_EXTRACT(trace, '$.timing.llm[*].prompt') AS prompt_tokens,
       JSON_EXTRACT(trace, '$.timing.llm[*].completion') AS completion_tokens,
       JSON_EXTRACT(trace, '$.timing.search') AS search_ms,
       JSON_EXTRACT(trace, '$.timing.oracle') AS oracle_ms
FROM chat_log WHERE JSON_VALUE(trace, '$.v') >= 4
ORDER BY CAST(JSON_VALUE(trace, '$.timing.total') AS UNSIGNED) DESC LIMIT 20;
```

### 검색 후보 수·검색 횟수 조정

두 값은 `.env`로 낮출 수 있다 — `SEARCH_LIMIT`(소스당 후보 수, 3~20, 기본 20)과 `MAX_SEARCHES`(검색 횟수 상한, 기본 3).
올리지는 못한다: 프롬프트 예산(`constants.js`)이 그 최대치를 전제로 검증된다. 낮출 근거는 계측이다.
지식·처리방법·쿼리 벡터 검색은 거리 문턱 0.4 안의 결과가 3개 미만이면 가까운 후보로 3개까지 보충한다.
지식은 청크 병합 후 구간 수를 센다. 유효한 자료 자체가 부족하면 있는 만큼 반환하며,
정확한 쿼리명 조회는 해당 쿼리만 반환한다. `SEARCH_LIMIT`를 1이나 2로 설정해도 최소값 3을 적용한다.

후보 수를 낮출 근거 — 검색 뒤 LLM 호출의 프롬프트가 크고(두 번째 호출의 `prompt` 토큰), 적중이 상한에 붙어 있다
(20건이 늘 차면 관련도 임계값이 아니라 상한이 후보를 자르고 있다는 뜻이다). 절반으로 줄이면 그 호출의 prefill이
대략 그만큼 준다:

```sql
SELECT ROUND(AVG(JSON_VALUE(trace, '$.timing.llm[1].prompt'))) AS prompt_after_search,
       SUM(JSON_VALUE(trace, '$.search.knowledge') >= 20) AS knowledge_saturated,
       SUM(JSON_VALUE(trace, '$.search.qaMethods') >= 20) AS qa_saturated,
       COUNT(*) AS answered
FROM chat_log
WHERE JSON_VALUE(trace, '$.v') >= 4 AND JSON_VALUE(trace, '$.search.searches') >= 1;
```

검색 횟수를 낮출 근거 — 두 번째·세 번째 검색이 새 자료를 거의 더하지 않는다. 검색이 둘 이상인 요청의 비율과 그때
답변까지의 LLM 호출 수를 본다:

```sql
SELECT JSON_VALUE(trace, '$.search.searches') AS searches,
       COUNT(*) AS requests,
       ROUND(AVG(JSON_LENGTH(trace, '$.timing.llm'))) AS llm_calls,
       ROUND(AVG(JSON_VALUE(trace, '$.timing.total'))) AS total_ms
FROM chat_log WHERE JSON_VALUE(trace, '$.v') >= 4 AND JSON_VALUE(trace, '$.outcome') = 'answered'
GROUP BY searches ORDER BY searches;
```

값을 바꾸면 `[agent] timing` 로그의 `prompt … tok`과 위 SQL로 전후를 비교한다.

## 향후 확장 지점

- **새 쿼리/지식 추가**: 관리자 화면에서 추가하거나 MariaDB 테이블에 INSERT (임베딩은 기본 1분 주기로 자동 동기화).
  단일 쿼리는 `query_desc`만 성실히 작성하면 되고, 다단계 절차는 `qa_method.method` 본문에 `query_name`을 순서대로 언급
- **임베딩 모델 교체**: `EMBEDDING_MODEL`만 변경 (1024차원 유지 시). vLLM/TEI 등 OpenAI 호환 서버는 `EMBEDDING_URL`로 전환.
  지시문을 학습한 모델(Qwen3-Embedding·Harrier 계열)은 `EMBEDDING_QUERY_PREFIX`로 **질의에만** 접두를 붙인다
  (문서에는 붙지 않는다 — 그 비대칭이 모델의 학습 형식이다). 바꾸면 전 행이 자동으로 다시 임베딩되고,
  관련도 문턱(`search.js MAX_DIST`)이 그 모델에서도 성립하는지는 등록 지식으로 직접 잴 것
