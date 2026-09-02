# SPACE VOC Agent

사내 지식과 조회용 DB(Oracle)를 결합해 질문에 답하는 지식 관리 및 Q&A LLM Agent.

```
사용자 질문 (+ 최근 대화)
  → 지식/Q&A처리방법 하이브리드 검색 (LIKE + 벡터, 상위 20건) + 쿼리 라우팅 (관련 쿼리만 선별)
  → LLM 결정 루프: 답변 가능하면 답변 / DB 조회가 필요하면 쿼리 관리 테이블의 쿼리 실행 (여러 번 가능)
  → 최종 답변 (+ 실행된 쿼리 trace)
```

- **agent 관리 DB**: MariaDB — `knowledge`(지식), `qa_method`(Q&A 처리 방법), `query_registry`(쿼리 관리), `target_db`(조회대상 DB 접속 정보)
- **조회용 DB**: Oracle (node-oracledb — 기본은 Thin 모드라 Instant Client 불필요, `.env`의 `ORACLE_DRIVER=oci`로 Thick(OCI) 모드 전환 가능). 여러 개 등록 가능
- **LLM**: vLLM / OpenRouter 등 OpenAI 호환 API. 개발용 규칙 기반 Mock 내장
- **UI**: React(Vite) 채팅 화면. 답변은 markdown(표·제목·목록)으로 구조화되어 렌더링(react-markdown + remark-gfm), 수식은 KaTeX. 관리 데이터는 SQL로 직접 입력

## 대화 맥락

"그럼 김철수는?", "재시작은 어떻게 해?" 같은 후속 질문을 해석한다. 서버는 세션을 저장하지 않고
클라이언트가 최근 대화를 `POST /api/chat`의 `history`에 실어 보낸다 (최근 6턴, 턴당 1,500자로 제한).

- LLM 프롬프트에 "최근 대화" 섹션으로 전달되어 지시대명사·생략된 대상을 해석한다
- 현재 질문만으로 지식/처리방법이 **하나도 검색되지 않은 경우에만** 직전 질문을 덧붙여 재검색한다
  → 평소 검색 정확도는 그대로 두면서 후속 질문만 복구 (`agent.js`)

## 디렉토리

```
backend/
  sql/schema.sql, seed.sql   # MariaDB DDL + 데모 데이터
  src/server.js              # Express, POST /api/chat
  src/agent.js               # agentic loop (핵심 제어 흐름)
  src/llm.js                 # LLM 인터페이스 + Mock (provider 선택)
  src/llm-openai.js          # OpenAI 호환 클라이언트 (vLLM/OpenRouter)
  src/search.js              # 하이브리드 검색(LIKE 관련도 + 벡터, RRF 병합) — 검색 구현은 이 파일에만 있다
  src/db.js                  # MariaDB 풀 + 관리 테이블 로더
  src/oracle.js              # Oracle 실행기 + SELECT 전용 가드 + mock 모드
frontend/
  src/App.jsx                # Vite + React 채팅 UI (단일 컴포넌트)
  src/math.js                # 답변 안의 수식 표기 판정(remark 플러그인) + 렌더러 설정
```

## 설치 및 실행

### 1. MariaDB 스키마 적용

```bash
mariadb --default-character-set=utf8mb4 < backend/sql/schema.sql
```

> **이미 운영 중인 DB에는 실행하지 말 것** — schema.sql은 맨 앞에서 모든 테이블을 DROP한다.
> 기존 설치에 변경분만 반영하려면 아래 마이그레이션을 쓴다:
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
> -- vec_store는 제외 — 유일한 텍스트 컬럼(src)이 ASCII 고정값이라 collation의 영향이 없고,
> -- VECTOR 컬럼이 있는 테이블의 문자셋 일괄 변환은 버전에 따라 지원되지 않는다.
> ```

```bash
mariadb --default-character-set=utf8mb4 < backend/sql/seed.sql
```

앱 계정 생성 (agent 서버는 관리 테이블을 읽기만 하므로 SELECT 권한이면 충분).
`<비밀번호>`는 직접 정하고, 같은 값을 `backend/.env`의 `MARIADB_PASSWORD`에 채운다
(문서에 고정 비밀번호를 적어 두면 저장소에 공개된 자격증명이 운영까지 그대로 따라간다):

```bash
mariadb -e "CREATE USER IF NOT EXISTS 'agent'@'localhost' IDENTIFIED BY '<비밀번호>'; GRANT SELECT ON llm_agent.* TO 'agent'@'localhost'; GRANT SELECT, INSERT, UPDATE, DELETE ON llm_agent.vec_store TO 'agent'@'localhost'; GRANT SELECT, INSERT, DELETE ON llm_agent.chat_log TO 'agent'@'localhost';"
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

답변의 LaTeX 수식을 KaTeX로 그린다. **모델이 어떤 표기로 쓰든 그린다** — `$$`는 remark-math가,
markdown이 다루지 못하는 나머지(`$…$`, `\(…\)`, `\[…\]`)는 `frontend/src/math.js`의 remark
플러그인이 맡는다. 표 셀·제목·목록·인용문 안에서 모두 동작한다.

| 쓰는 법 | 결과 |
|---|---|
| `$v = d/t$` | 인라인 수식. 표 셀·제목·목록 안에서도 그린다 |
| `$$E=mc^2$$` | 인라인 수식 |
| `$$` 를 **앞뒤 각각 독립된 줄**에 두고 그 사이 | 별행 수식(가운데 정렬). 말풍선보다 넓으면 그 안에서 가로 스크롤된다 |
| `\(...\)` | 인라인 수식 |
| `\[...\]` | 문단을 혼자 차지하면 별행, 문장 안이면 인라인 |
| ```` ```math ```` 코드펜스 | 별행 수식 (rehype-katex가 직접 그린다) |
| `$100`, `$ORACLE_HOME` | **수식이 아니다.** 그대로 나온다 |

판정을 remark-math에 맡기지 않는 이유는 그 옵션(`singleDollarTextMath`) 하나로는 양쪽이 다 깨지기
때문이다. 켜면 `비용은 $100 이고 수익은 $200 이다`의 가운데가 통째로 수식이 되어 문장이 사라지고
(표 안에서 일어나면 행이 무너진다), 끄면 모델이 가장 흔히 쓰는 `$v = d/t$`가 원문 그대로 노출된다.
`\( \)` · `\[ \]`는 어느 쪽이든 markdown의 백슬래시 이스케이프에 먼저 먹혀 `( )` · `[ ]`만 남는다.

**판정은 markdown 파싱이 끝난 뒤, 순수 텍스트 노드 안에서만 한다** (`math.js`의 remark 플러그인).
원문을 먼저 훑으면 파서가 이미 아는 것(여기는 코드다, 여기는 링크 주소다, 이 줄은 인용문이다)을
전부 다시 알아내야 하고, 빠뜨린 자리마다 조용한 버그가 된다 — 코드펜스·인라인 코드·맨 URL·링크
목적지·인용문 접두사·CRLF에서 실제로 그렇게 깨졌다. 파싱 뒤에는 그것들이 이미 다른 노드로 갈라져
있어 **판정 대상에 들어오지도 않는다.** 그래서 남는 규칙은 금액과 수식을 가르는 둘뿐이다:

- 여는 `$` 뒤와 닫는 `$` 앞에 공백이 오면 수식이 아니다 → `$100 이고 … $200`이 여기서 걸린다
- 여는 `$` 앞이나 닫는 `$` 뒤가 영숫자면 수식이 아니다 → `A$B`, `$HOME/$PATH`가 여기서 걸린다.
  한글 조사는 영숫자가 아니므로 `$v$는 속도`는 그대로 수식이 된다
- (덧붙임) 한글이 든 홑 `$` 구간은 수학 기호나 백슬래시 명령이 함께 있을 때만 수식이다
  (`$가,$나` ✗ / `$속도 = 거리/시간$` ✓ — TeX에는 한글 조판이 없다). `$$`로 명시한 구간에는 걸지 않는다

판정하지 못한 `$`는 그냥 글자로 남는다. **실패 방향은 한쪽으로만 열려 있다** — 못 그리면 사용자가
원문을 보지만, 반대로 잘못 켜면 멀쩡한 문장과 표가 조판 속으로 사라진다. `frontend`에서 `npm test`로
회귀 검증한다 (`frontend/test/math.test.js` — 판정만이 아니라 실제 렌더까지 통과시켜 확인한다).

알고 있어야 할 두 가지.

- **넓은 수식은 별행(`$$` 독립 줄, `\[ \]` 단독 줄)으로 쓴다.** 별행 수식은 말풍선 안에서 가로
  스크롤되지만 **인라인 수식은 접히지도 스크롤되지도 않는다** — KaTeX가 `.base`에 `white-space: nowrap`을
  걸어 한 덩어리로 다루기 때문이다. CSS로 푸는 세 방법(`inline-block`+`overflow`, 문단 `overflow-x`,
  `.text`의 `white-space`)을 모두 재봤고 각각 기준선 5px 어긋남 / 분수 세로 잘림 / 한 글자씩
  줄바꿈을 일으켜 채택하지 않았다. 대신 `.bubble`의 `overflow-x: clip`이 넘치는 부분을 상자 안에
  가둔다(잘려서 안 보일 뿐 말풍선을 뚫지는 않는다). 세로로 뚫는 것(`\rule{500em}`)은 CSS가 가둘 수
  없어 KaTeX의 `maxSize`로 막는다.
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
수식 안에 `*`나 백틱이 있으면 markdown이 먼저 강조·코드로 가져가 수식이 되지 못한다(원문이 보인다) —
LaTeX에서는 `\times`·`\cdot`을 쓰므로 실제로는 드물다.

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
| `y:` | 값 열(쉼표로 여럿). 없으면 x 밖의 **숫자 열 전부**. 숫자와 글자가 섞인 열은 그리지 않는다 |
| `y2:` | 오른쪽 축에 **선으로 겹칠** 열 (단위가 다른 값 — 건수 위의 비율 등). 최대 2개 |
| `xtype:` | `time` · `number` · `category`. 없으면 line·area·scatter에서 x가 전부 날짜면 시간축, scatter에서 전부 숫자면 수치축, 그 밖은 범주 |
| `data: step N` | 표 대신 **쿼리 실행 이력 N번의 결과 전체**를 쓴다 (아래) |
| GFM 표 | 값은 조회 결과 그대로. `1,000` · `12%`는 숫자로 읽고 `12건` · `-` · 빈칸은 결측(0이 아니다) |

설정은 전부 따옴표 없는 `이름: 값` 한 줄이고 표는 GFM 그대로다. JSON을 쓰지 않는 이유는 `answer`
자체가 이미 JSON 문자열 안에 실려 오기 때문이다 — 그 안에 따옴표·중괄호를 또 넣으면 이스케이프가 한 번만
어긋나도 답변 전체가 파싱에서 떨어진다. 이 모양은 따옴표가 한 개도 없다.

**`data: step N`** — 모델은 조회 결과를 프롬프트에서 20행까지만 본다(`MAX_RESULT_ROWS`). 100행짜리
결과를 그리려면 값을 답변에 옮겨 적어야 하는데, 보지 못한 행은 적을 수 없고 본 행도 옮기는 동안 값이
바뀐다. 그래서 답변에는 이력 항목 번호만 적게 하고, 서버(`backend/src/chart.js`)가 손에 든 전체 행
(≤100)으로 표를 채워 내보낸다. 번호는 프롬프트의 실행 이력 번호(`2. 쿼리이름 …`이면 2)와 같은
1-based 절대 인덱스이며 오류·메모 항목도 번호를 차지한다. `x`·`y`·`y2`를 함께 적으면 그 열만 싣고,
없으면 앞의 8열이다. 채우지 못한 참조(없는 번호, 실패한 실행, 0건)는 블록 대신 짧은 안내 문장이 된다.
채워 넣는 표는 답변 하나에 30,000자까지다 — 그 위로는 행을 잘라 싣고 차트 아래에 그 사실을 적는다.

화면 규칙 몇 가지. 차트 아래에는 늘 **'표로 보기'**가 접혀 있다(그래프로는 정확한 값·잘린 라벨·그리지
않은 열을 읽을 수 없다). 범주가 13개 이상인 막대는 가로로 눕히고, 원그래프는 12조각을 넘으면 '기타'로
모은다. 한 메시지에 차트는 4개까지 그리고 그 뒤는 표다. 시리즈는 6개(y2 포함), 행은 100까지.

**실패 방향은 한쪽으로만 열려 있다** — 차트로 읽지 못하면(숫자 열이 없다, 산점도의 x가 수치가 아니다,
그리는 중에 예외가 났다) 그 블록은 **안의 표를 그대로** 보여준다. 반대로 어설프게 그리면 숫자가 아닌
값이 0으로, 문자열 날짜가 범주로 그려진 그래프가 '데이터'로 읽힌다. 그래서 숫자로 읽히지 않는 값은
0이 아니라 빈칸이고, 그릴 것이 하나도 없으면 차트를 포기한다. 대화 이력으로 서버에 되돌려 보낼 때는
펜스와 설정 줄을 벗기고 표만(20행) 남긴다 — 모델의 다음 턴에 필요한 것은 무슨 값을 보여줬는가이지 그것을
어떻게 그렸는가가 아니다. `frontend`·`backend` 각각 `npm test`로 회귀 검증한다
(`frontend/test/chart.test.js`, `backend/test/chart.test.js`).

**Mermaid** — 절차·흐름·상태 전이 설명에 `flowchart TD` · `sequenceDiagram` 등을 쓴다.
`securityLevel: 'strict'`로 그리므로 라벨의 HTML은 글자로 취급되고, 문법이 틀리면 그림 대신 **코드 원문이
그대로** 보인다(오류 그림을 끼워 넣지 않는다). 노드 글자는 `A[글자]`처럼 따옴표 없이, 괄호·따옴표·
세미콜론 같은 특수문자는 피하는 것이 안전하다.

블록 문법을 바꾸려면 세 곳을 함께 본다 — `frontend/src/chart.js`(판정), `backend/src/chart.js`(참조
채우기), 백엔드 시스템 프롬프트(모델에게 알리는 표기).

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

프롬프트 예산(`backend/src/constants.js`의 `MAX_PROMPT_TOTAL_LEN`·`PROMPT_FLOORS`)과 출력 가드(`MAX_COMPLETION_TOKENS`)는 **128k 컨텍스트** 기준이다 — 입력 최악 ≈ 42~50k 토큰 + 출력 16k. 서버가 실제로 그 길이를 받는지는 코드가 알 수 없으니 연결 후 한 번 확인한다:

```bash
curl -s $LLM_BASE_URL/models | python3 -c 'import json,sys; print([m.get("max_model_len") for m in json.load(sys.stdin)["data"]])'   # vLLM: 131072 이어야 한다
```

- vLLM은 모델 config의 `max_position_embeddings`를 기본값으로 쓴다. `Qwen/Qwen2.5-32B-Instruct`는 그 값이 32,768이라 그대로 띄우면 **32k**다 — 128k는 YaRN을 켜야 나온다: `--max-model-len 131072 --hf-overrides '{"rope_scaling":{"rope_type":"yarn","factor":4.0,"original_max_position_embeddings":32768}}'` (정적 YaRN이라 짧은 입력의 품질이 조금 떨어진다는 것이 Qwen 쪽 안내다).
- 컨텍스트가 더 작은 모델이면 `MAX_PROMPT_TOTAL_LEN`과 `MAX_COMPLETION_TOKENS`를 함께 줄인다 (둘의 합이 컨텍스트 안에 들어야 한다). 매 호출의 실제 토큰 수는 서버 로그의 `[llm] usage prompt=… completion=… finish=…` 한 줄로 확인할 수 있다 — `finish=length`면 출력 가드에서 끊긴 것이다.

LLM 인터페이스는 `llm.js`의 `decide(ctx) → {action:'answer'|'run_query', ...}` 함수 하나다. 다른 provider가 필요하면 같은 시그니처의 함수를 추가하고 `llm.js`의 분기에 연결한다. `agent.js`는 변경되지 않는다.

## 실제 Oracle 연결

1. `target_db` 테이블에 접속 정보 등록 — `connection_info`는 Easy Connect 문자열(`host:1521/SERVICE`) 또는 tnsnames 별칭, `db_password`는 `ENV:변수명` 형식 권장
2. `.env`에서 `ORACLE_MOCK=0`, 참조하는 비밀번호 환경변수(`ORDER_DB_PASSWORD`) 설정
3. `query_registry`의 쿼리를 실제 테이블 구조에 맞게 등록

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

- **조회 전용 가드**: 실행 직전 SELECT/WITH로 시작하는 단일 문장만 허용 — UPDATE/DELETE/DDL/다중 문장은 차단된다 (`sql.js`의 `assertReadOnly`).
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
- 조회 결과는 `maxRows: 100` 제한. 셀당 200자 절단은 드라이버 경계(`oracle.js`)에서, 20행 절단은 `agent.js`의 `capRows`에서 적용하고
  "외 N건 생략 (총 N건)"으로 표기한다. LOB/이진 값도 이 경계에서 문자열로 정규화된다 (커넥션을 닫으면 무효가 되는 스트림 객체가 로그·프롬프트로 새지 않도록)

## 검색 (하이브리드 — 10,000건 이상 대응)

지식·처리방법·쿼리 모두 **LIKE(관련도 정렬)와 벡터 검색을 병렬 실행해 RRF로 병합**한 상위 20건을 쓴다 (`search.js`).
정확 키워드(BATCH001 등)는 LIKE가, 표현 차이("측정 안 하고 품질 아는 법" ↔ "가상계측")는 벡터가 잡는다.

- **벡터 저장**: 별도 vector DB 없이 MariaDB 네이티브 `VECTOR(1024)` + 벡터 인덱스 (`vec_store` 테이블).
  원본 3개 테이블은 변경하지 않는 companion 구조
- **임베딩**: 로컬 Ollama의 OpenAI 호환 API (`embedding.js`). 기본 모델 bge-m3(1024차원)
- **폴백**: 임베딩 서버가 없으면 자동으로 LIKE-only로 동작 — Ollama 없는 환경에서도 그대로 돌아간다.
  Ollama를 아예 쓰지 않는다면 `.env`의 `EMBEDDING_URL`을 비워 두면 매 주기 임베딩 시도 자체를 건너뛴다
  (원본이 삭제된 벡터 정리는 이 경우에도 계속 수행된다). 이 구성에서 `npm run embed`는 정상 종료(0)한다 —
  종료 코드 1은 "임베딩 서버가 설정돼 있는데 응답하지 않은" 경우뿐이다
- **동기화**: `embed-sync.js`가 원본 텍스트의 MD5를 비교해 신규/변경분만 임베딩(diff, 멱등).
  서버 기동 시 1회 + `EMBED_SYNC_INTERVAL`(기본 60초) 주기 + `npm run embed` 수동.
  SQL로 직접 등록한 데이터도 1분 내 자동 반영되며, 그 사이에도 LIKE로는 즉시 검색된다

### 임베딩 준비 (선택 — 없으면 LIKE-only)

macOS:

```bash
brew services run ollama
```

```bash
ollama pull bge-m3
```

Windows: `setup/bge-m3/start.bat` 실행 (설치 확인·모델 다운로드·검증까지 자동, 중지는 `stop.bat`).
자세한 내용은 [setup/bge-m3/README.md](setup/bge-m3/README.md) 참고.

### 쿼리 라우팅 (프롬프트 폭발 방지)

쿼리 목록은 **등록 규모와 무관하게 질문 관련도 순으로 정렬해** 프롬프트에 싣는다
(지식·처리방법과 같은 하이브리드 검색을 쓴다). 순서는 두 경로의 합집합이다 (`agent.js`의 `selectQueries`):

- **경로A**: 매칭된 `qa_method` 본문이 지목한 `query_name` — 다단계 절차 보장 (본문 등장 순서를 지킨다)
- **경로B**: 질문으로 `query_registry` 자체를 하이브리드 검색(LIKE + 벡터 RRF) — **qa_method 등록 없이 쿼리만 등록해도 찾는다**

30건 이하면 검색에 걸리지 않은 쿼리까지 전부 뒤에 이어 붙이고, 초과하면 관련도 상위 30건만 싣는다.
정렬이 규모와 무관해야 하는 이유는 프롬프트 예산이 "뒤쪽일수록 덜 관련됐다"는 전제로 뒤에서부터
줄이기 때문이다 — 저장 순서로 넘기면 예산이 버리는 것이 '덜 관련된 쿼리'가 아니라 '나중에 등록한 쿼리'가 된다.

예산이 모자라면 **버리기 전에 줄인다**: 뒤쪽 쿼리는 `이름 / 용도 / 바인드`만 남긴 짧은 형태로 실린다.
이름만 있어도 모델이 지목할 수 있고, 지목하면 서버가 등록 원문을 다시 찾아 다음 단계의 목록 맨 앞에
전체 정의로 넣어준다. 즉 **등록한 쿼리가 프롬프트에서 통째로 사라지는 일은 없다**.

따라서 `qa_method`는 여러 쿼리를 순서대로 쓰는 절차가 필요할 때만 등록하면 되고,
단일 쿼리는 `query_registry`의 **`query_desc`(용도 요약)**를 성실히 쓰는 것으로 충분하다.
`query_desc`는 벡터/LIKE 검색과 LLM 선택의 근거이므로 "어떤 질문일 때 무엇을 조회하는지"를 반드시 적을 것.
(짧은 형태로 실릴 때 남는 설명이 `query_desc` 앞부분이라는 점에서도 그렇다.)

> 등록 SQL의 바인드는 **영문자로 시작하는 이름**이어야 한다 (`:job_id`). Oracle 위치 바인드(`:1`)는
> 이 실행기가 값을 채울 수 없으므로 실행 직전 가드가 거부한다.

## 대화 로그

모든 문답이 `chat_log` 테이블에 기록된다 (질문·답변·검색 적중 수·실행 쿼리 trace·시각). 용도는 두 가지 —
평가셋 구축, 그리고 "못 답한 질문"을 찾아 지식/쿼리를 보강하는 운영 루프.

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
`trace.v`는 스키마 버전이다 (현재 3 — `{v, outcome, …}`. 이 필드가 없는 행은 trace가 steps 배열 자체였던 옛 형식).

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

검색이 아무것도 못 찾은 질문 (지식/쿼리 신규 등록 후보 — `trace.search`에 검색 적중 수가 남는다):

```sql
SELECT question, created_at FROM chat_log
WHERE JSON_VALUE(trace, '$.search.knowledge') = 0   -- search는 답변까지 간 요청(outcome='answered')에만 있다
  AND JSON_VALUE(trace, '$.search.qaMethods') = 0
  -- 경로B(qa_method 없이 쿼리만 등록)로 답한 질문을 후보로 잡지 않도록 쿼리 적중도 함께 본다.
  -- 라우팅이 동작하지 않는 소규모에서는 null이므로 그때는 이 조건을 적용하지 않는다.
  AND COALESCE(JSON_VALUE(trace, '$.search.queries'), 0) = 0
  -- 관리 DB 장애로 쿼리 목록 자체를 못 읽은 요청은 후보에서 뺀다 (등록이 부족한 것이 아니다).
  -- 그 요청은 `search.queriesFailed`가 true로 남는다 — 없으면 정상 경로다.
  AND JSON_VALUE(trace, '$.search.queriesFailed') IS NULL
ORDER BY created_at DESC;
```

## 향후 확장 지점

- **새 쿼리/지식 추가**: 코드 변경 없이 MariaDB 테이블에 INSERT (임베딩은 1분 내 자동 동기화).
  단일 쿼리는 `query_desc`만 성실히 작성하면 되고, 다단계 절차는 `qa_method.method` 본문에 `query_name`을 순서대로 언급
- **임베딩 모델 교체**: `EMBEDDING_MODEL`만 변경 (1024차원 유지 시). vLLM/TEI 등 OpenAI 호환 서버는 `EMBEDDING_URL`로 전환
