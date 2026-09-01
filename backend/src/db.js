// MariaDB (agent 관리 DB) 커넥션 풀 + 관리 테이블 로더
import mariadb from 'mariadb';
import { numEnv, nameKey } from './constants.js';

// 풀은 처음 쓸 때 만든다 — import만으로 만들면 이 모듈을 (간접적으로라도) 불러오는 모든 코드가
// DB에 접속을 시도한다. 검색 로직만 import하는 테스트가 MariaDB 기동 여부에 따라 10초씩 매달리는 식이다.
// 풀 크기의 근거. 셋을 따로 두는 이유는 성격이 다르기 때문이다 — 앞의 둘은 곱해지는 양이고,
// 마지막 하나는 '짧게 빌려 쓰는' 나머지와 달리 동기화가 끝날 때까지 계속 쥐고 있는 몫이라
// 곱셈 밖에서 더해야 한다. 이전 값(10)은 실질 동시 처리가 2건이었다.
const CONNS_PER_REQUEST = 4;   // 요청 1건의 동시 점유 최대치. 요청 하나가 커넥션을 겹쳐 쓰는 구간이 둘이다:
                               //   ① 지식·처리방법 검색 — 둘이 병렬이고 각각 LIKE+벡터가 다시 병렬이다
                               //      (search.js hybrid). 벡터 쪽은 임베딩 응답을 먼저 기다리므로
                               //      실측 피크는 4가 아니라 2다(LIKE 2 → 벡터 2 순).
                               //   ② 쿼리 목록의 관련도 정렬 — 본문 대조 조회 + LIKE + 벡터가 병렬이다
                               //      (agent.js rankQueries). 실측 피크 3으로, 여기가 최대다.
                               //   ①과 ②는 순차라 겹치지 않는다 (②는 ①의 결과를 받아 돈다).
                               // 값은 실측 피크(3)에 여유 한 칸을 더해 잡는다 — 임베딩 캐시 적중 여부에
                               // 따라 ①의 순서가 달라질 수 있고, 모자라면 증상이 '질문이 어렵다'처럼 보인다.
const CONCURRENT_REQUESTS = 4; // 이 크기로 감당하려는 동시 질문 수 (사내 Q&A 트래픽 기준).
const RESERVED_FOR_SYNC = 1;   // embed-sync가 동기화 내내 쥐는 GET_LOCK 전용 커넥션.
const POOL_SIZE = CONNS_PER_REQUEST * CONCURRENT_REQUESTS + RESERVED_FOR_SYNC;

// 관리 DB 조회 상한(ms). 이 시스템에서 유일하게 예산 없는 I/O였다 — Oracle은 callTimeout,
// LLM은 AbortSignal.timeout, 임베딩은 자체 타임아웃으로 전부 묶여 있는데 관리 DB만 무제한이었다.
// 검색(search.js)은 agent 루프의 deadline '검사 지점'보다 앞에서 돌기 때문에, 여기서 매달리면
// 문서화된 요청 상한(agent.js 주석의 약 420초)이 통째로 성립하지 않는다 — 프런트는 450초에
// 끊고 '서버와 통신하지 못했습니다'를 띄우지만 워커는 커넥션을 쥔 채 계속 남는다.
//
// socketTimeout이 아니라 queryTimeout을 쓴다. socketTimeout은 커넥션을 만들 때 한 번 걸고 다시
// 세팅하지 않는 '무활동' 타이머라, 풀에서 놀고 있는 커넥션이 그대로 걸린다 — 실측: 2초로 두고
// 5초 유휴하니 커넥션이 죽고 재생성되면서 fatal 'socket timeout' 오류가 4건 찍혔다.
// 트래픽이 뜸한 시간대마다 오류 로그가 쌓이는 셈이라 쓸 수 없다.
// queryTimeout은 접속 시 `SET max_statement_time`을 한 번 걸 뿐 쿼리 문자열을 건드리지 않으므로,
// search.js의 `SET STATEMENT mhnsw_ef_search=… FOR …`와도 부딪히지 않는다(실측 확인).
// 적용 범위는 '이 풀이 보내는 모든 문장'이다 — 조회만이 아니다. MariaDB의 max_statement_time은
// MySQL의 max_execution_time(읽기 전용)과 달리 DML에도 걸리고, 커넥터는 커넥션마다
// `SET max_statement_time=<초>`를 한 번 발행한다(mariadb/lib/connection.js).
// 그래서 요청 경로 밖의 쓰기도 이 상한 안에서 끝나야 한다:
//   embed-sync의 `REPLACE INTO vec_store` (1024차원 벡터 배치 + VECTOR INDEX 갱신)
//   보존 정책의 `DELETE FROM chat_log`
// 둘 중 하나가 상한을 넘기면 'Query execution was interrupted'로 끊기고 로그에는
// '[embed] batch store failed' / '[chat_log] cleanup failed'만 남는다 — 메시지에 타임아웃이라는
// 단서가 없으므로, 그 문구를 만나면 먼저 이 값(MARIADB_TIMEOUT_MS)을 의심할 것.
const QUERY_TIMEOUT_MS = numEnv('MARIADB_TIMEOUT_MS', 30_000);

let pool;
function getPool() {
  pool ??= mariadb.createPool({
    host: process.env.MARIADB_HOST || 'localhost',
    port: numEnv('MARIADB_PORT', 3306), // Number()로 받으면 오타가 NaN이 되어 경고 없이 접속이 깨진다
    user: process.env.MARIADB_USER,
    password: process.env.MARIADB_PASSWORD,
    database: process.env.MARIADB_DATABASE || 'llm_agent',
    // 기본값은 손으로 고른 수가 아니라 아래 세 항의 식이다 (POOL_SIZE 주석 참고) —
    // 풀이 마르면 커넥터 기본 acquireTimeout(10초) 뒤 500이 나는데, 그 500은 '질문이 어렵다'처럼
    // 보일 뿐 원인이 풀 크기라는 단서를 남기지 않는다. 근거를 식으로 적어두면 어느 항이
    // 바뀌어 부족해졌는지 계산으로 확인할 수 있다.
    connectionLimit: numEnv('MARIADB_POOL_SIZE', POOL_SIZE),
    queryTimeout: QUERY_TIMEOUT_MS,
  });
  return pool;
}

// 커넥션을 직접 쥐어야 할 때 사용 (예: embed-sync의 GET_LOCK — 락은 커넥션에 귀속된다)
export function getConnection() {
  return getPool().getConnection();
}

// 커넥션 반납의 단일 지점 — 직접 쥔 쪽(embed-sync)도 반드시 이 함수를 쓴다.
// 반납을 기다린다: 기다리지 않으면 아직 풀로 돌아가지 않은 커넥션을 반납된 것으로 세어
// connectionLimit을 잠시 넘겨 쓰고, 뒤이은 요청이 커넥터 기본 acquireTimeout(10초)에 걸려 500이 난다.
// 반납 실패가 원래 결과(또는 원래 오류)를 덮지 않도록 여기서 삼킨다 —
// 삼키지 않으면 잡는 곳이 없어 unhandledRejection으로 새고, 로그에는 원인 없는 거부만 남는다.
export async function releaseConnection(conn) {
  try {
    await conn.release();
  } catch (e) {
    console.warn('[db] failed to release connection:', e.message);
  }
}

// 획득도 반납과 같은 단일 지점을 쓴다 (getConnection) — 여기서 getPool().getConnection()을
// 다시 적으면 획득 경로가 둘이 되어, 나중에 붙일 것(획득 타임아웃·재시도·계측)이 getConnection에만
// 들어가고 읽기 경로 전체가 조용히 빠진다. 반납만 한 곳으로 모여 있었다.
export async function query(sql, params = []) {
  const conn = await getConnection();
  try {
    return await conn.query(sql, params);
  } finally {
    await releaseConnection(conn);
  }
}

// 정상 종료용 — 풀을 닫아 반납된 커넥션까지 정리한다 (server.js의 shutdown 참고).
// 다시 호출되면 getPool()이 새 풀을 만들도록 참조를 비우되, 그 시점은 end()가 끝난 뒤여야 한다.
// 먼저 비우면 종료 도중 도착한 쿼리가 getPool()에서 '아무도 닫지 않는 두 번째 풀'을 만든다 —
// 호출부(server.js)는 방금 닫은 풀만 기다리고 곧바로 process.exit를 부르므로, 새 풀의 커넥션은
// 핸드셰이크 도중 끊기고 그 위에서 돌던 기록(chat_log INSERT)은 흔적 없이 사라진다.
// 참조를 나중에 비우면 같은 쿼리가 닫히는 중인 풀에서 오류로 끝난다 — 조용한 누수보다 낫다.
export async function closePool() {
  const p = pool;
  if (!p) return;
  try {
    await p.end();
  } finally {
    if (pool === p) pool = undefined;
  }
}

// 쿼리 관리 테이블 로드 — 소규모(라우팅 임계치 이하)일 때만 사용.
// limit은 호출부가 "임계치+1"을 넣어 규모 판정까지 겸한다 (agent.js selectQueries 참고).
// limit === undefined로 판정한다 — truthy로 보면 limit=0이 "0건"이 아니라 "전체 로드"가 되어,
// 남은 자리를 계산해 넘기는 호출부가 생기는 순간 조용히 대형 SELECT가 프롬프트 경로로 들어온다.
//
// ORDER BY가 반드시 있어야 한다. LIMIT만 걸면 '어떤 행이 오는가'도 '어떤 순서로 오는가'도
// SQL이 보장하지 않는다 — 실행계획이 바뀌는 것만으로(query_name 인덱스 추가, ANALYZE, 온라인 ALTER)
// 같은 코드가 다른 표본을 돌려준다. 규모 판정(31건 중 몇 건인가)은 그래도 성립하지만, 임계치
// 이하에서는 이 결과가 곧 프롬프트에 실리는 목록이라 '에이전트가 도달할 수 있는 쿼리 집합'이
// 재시작마다 달라지면서 아무 로그도 남기지 않는다.
// 형제 로더(loadQueriesByNames)가 호출부 순서를 복원하는 것과 같은 이유다 — 그쪽만 고쳐져 있었다.
// 정렬 키는 PK(seq) = 등록 순서다. 관련도 순서는 호출부가 검색 결과로 따로 만든다(agent.js rankQueries).
export function loadQueryRegistry(limit) {
  return limit === undefined
    ? query('SELECT * FROM query_registry ORDER BY seq')
    : query('SELECT * FROM query_registry ORDER BY seq LIMIT ?', [limit]);
}

// qa_method 본문이 지목한 query_name들을 로드 (라우팅 경로A).
// 요청한 이름 순서를 유지해 돌려준다 — 호출부(agent.js selectQueries)는 '앞쪽이 절차의 첫 단계'라는
// 전제로 상한을 두고, 프롬프트 예산(llm-openai.js renderItems)도 같은 전제로 꼬리부터 버린다.
// SQL은 IN(...)의 인자 순서를 결과 순서로 보장하지 않으므로(인덱스·PK 순으로 돌아온다) 그 전제가
// 이 경계에서 조용히 사라졌다: 다단계 절차의 '첫 단계'가 프롬프트에서 잘려 나가면 에이전트는
// 절차를 시작조차 못 하는데, 어디에도 오류가 남지 않는다.
// 비교는 nameKey로 한다 — 매칭 자체가 대소문자를 가리지 않는 collation이라, 본문 표기와 등록
// 철자가 대소문자만 다르면 ===로는 순서를 되돌리지 못하고 그 행만 맨 뒤로 밀린다.
export async function loadQueriesByNames(names) {
  if (!names.length) return [];
  const rows = await query(
    `SELECT * FROM query_registry WHERE query_name IN (${names.map(() => '?').join(',')})`,
    names
  );
  const order = new Map();
  names.forEach((n, i) => { const k = nameKey(n); if (!order.has(k)) order.set(k, i); });
  return rows.sort((a, b) =>
    (order.get(nameKey(a.query_name)) ?? Infinity) - (order.get(nameKey(b.query_name)) ?? Infinity));
}

// qa_method 본문이 지목한 쿼리를 등장 순서대로 로드 (라우팅 경로A).
//
// '본문에서 이름처럼 보이는 토큰을 뽑아 IN 절로 묻는' 방식이 아니라, 등록된 이름이 본문에
// 들어 있는지를 DB가 직접 본다. 토큰화가 성립하지 않기 때문이다: query_name에는 문자 제한이
// 없는데(VARCHAR(100)) 한국어는 조사가 낱말에 붙어 '배치상태조회를'이 한 낱말이므로, 공백으로
// 나눠서는 이름의 끝을 알 수 없다. 실제로 앞선 구현의 추출식(/[A-Za-z_][A-Za-z0-9_]{2,}/)은
// 한글 이름과 1~2자 이름을 한 번도 뽑지 못했고, 그 쿼리들은 경로A에서 통째로 빠졌다 —
// 오류는 남지 않고 다단계 절차의 순서 보장만 조용히 사라진다 (agent.js rankQueries 주석 참고).
//
// LIKE가 아니라 LOCATE를 쓴다. LIKE는 패턴 쪽이 컬럼이 되어 query_name 안의 '_'와 '%'가
// 와일드카드로 살아나는데, query_name은 snake_case라 '_'가 거의 항상 들어 있다
// (batch_job_status가 'batchXjobYstatus'에도 맞는다). LOCATE는 와일드카드 개념이 없고,
// 덤으로 '본문 어디에 나왔는가'를 그대로 돌려줘 정렬 키가 된다 — 호출부가 원하는 값이 정확히 그것이다.
// 빈 이름을 제외하는 이유: LOCATE('', s)는 1이라 등록 전체가 매칭된다.
// 부분 문자열 매칭이므로 짧은 이름이 긴 이름 안에서도 잡힌다('batch'가 'batch_job_status'를 쓴
// 본문에서 함께 걸린다). 의도한 동작이다 — 결과는 '프롬프트 목록이 넓어진다'뿐이고, 무엇을
// 실행할지는 모델이 목록에서 고른다. Mock provider의 판정(llm.js plannedQueries)도 같다.
// 다만 '조회'처럼 흔한 낱말을 이름으로 등록하면 거의 모든 처리방법에 걸려 상한(MAX_PROMPT_QUERIES)
// 자리를 차지하므로, query_name은 그 자체로 변별력 있게 지을 것.
// 대소문자는 양쪽을 낮춰 맞춘다 — collation이 이미 무시하지만, 그 전제를 이 SQL 안에서 확정한다
// (호출부가 본문을 낮춰 보낸다 — 낮추는 지점이 하나여야 길이 상한과 어긋나지 않는다).
// 정렬의 2차 키는 seq다 — 같은 위치에서 시작하는 이름은 없지만, ORDER BY가 유일하지 않으면
// 실행계획이 바뀌는 것만으로 순서가 달라진다 (loadQueryRegistry 주석과 같은 이유).
export function loadQueriesMentionedIn(text) {
  // 빈 본문이면 왕복하지 않는다. 공백만 남은 경우까지 함께 본다 — method는 NOT NULL이지만
  // 컬럼 하나가 완화되거나 임포터가 NULL 행을 넣으면 호출부가 개행만 이어 붙인 문자열을 보낸다.
  if (!text?.trim()) return Promise.resolve([]);
  return query(
    `SELECT *, LOCATE(LOWER(query_name), ?) AS _pos FROM query_registry
     WHERE query_name <> '' HAVING _pos > 0 ORDER BY _pos, seq`,
    [text]
  );
}

// 대화 로그 기록 — 평가셋/미답변 질문 발굴용. 실패해도 응답에는 영향 없다 (호출부 catch).
// async여야 한다: JSON.stringify는 query() 호출 전에 동기로 평가되므로, 일반 함수면
// 직렬화 실패(순환 참조 등)가 호출부의 .catch가 붙기도 전에 동기 예외로 튀어나가
// /api/chat의 try에 잡히고, 다 계산해둔 정상 답변이 500으로 버려진다.
export async function insertChatLog(question, answer, trace) {
  return query(
    'INSERT INTO chat_log (question, answer, trace) VALUES (?, ?, ?)',
    [question, answer, JSON.stringify(trace)]
  );
}

export function cleanupChatLogs(days) {
  return query('DELETE FROM chat_log WHERE created_at < NOW() - INTERVAL ? DAY', [days]);
}

// 조회대상 DB 접속 정보 로드
export async function loadTargetDb(dbName) {
  const rows = await query(
    'SELECT seq, db_name, db_type, connection_info, db_user, db_password FROM target_db WHERE db_name = ?',
    [dbName]
  );
  return rows[0];
}
