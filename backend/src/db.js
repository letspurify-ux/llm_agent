// MariaDB (agent 관리 DB) 커넥션 풀 + 관리 테이블 로더
import mariadb from 'mariadb';
import { numEnv, nameKey, nameIndexOf, stripLoneSurrogates } from './constants.js';

// 풀은 처음 쓸 때 만든다 — import만으로 만들면 이 모듈을 (간접적으로라도) 불러오는 모든 코드가
// DB에 접속을 시도한다. 검색 로직만 import하는 테스트가 MariaDB 기동 여부에 따라 10초씩 매달리는 식이다.
// 풀 크기의 근거. 셋을 따로 두는 이유는 성격이 다르기 때문이다 — 앞의 둘은 곱해지는 양이고,
// 마지막 하나는 '짧게 빌려 쓰는' 나머지와 달리 동기화가 끝날 때까지 계속 쥐고 있는 몫이라
// 곱셈 밖에서 더해야 한다. 이전 값(10)은 실질 동시 처리가 2건이었다.
const CONNS_PER_REQUEST = 5;   // 요청 1건의 동시 점유 최대치. 커넥션을 겹쳐 쓰는 구간이 셋이고 서로 순차다:
                               //   ① 세 대상의 벡터 검색 — 임베딩 한 번 뒤 knowledge·qa_method·query_registry
                               //      조회가 병렬이다 (search.js). 피크 3.
                               //   ② 쿼리 목록 — 처리방법 본문 대조 조회 + 등록 목록 읽기가 병렬이다. 피크 2.
                               //   ③ 조회 실행 — 조회 자체는 Oracle이지만 그 앞에서 접속 정보를 읽는다
                               //      (oracle.js runQuery → loadTargetDb, 조회마다 한 번). 일괄 조회는 최대
                               //      MAX_BATCH_QUERIES(4)를 병렬로 돌리므로 피크 4다 — 여기가 최대다.
                               // 값은 피크(4)에 여유 한 칸을 더해 잡는다 — 모자라면 증상이 커넥터의 획득 대기
                               // (10초) 뒤 500이라 '질문이 어렵다'처럼 보일 뿐 풀 크기를 가리키지 않는다.
                               // 일괄 조회 수(MAX_BATCH_QUERIES)나 검색 병렬 구간을 늘리면 이 값부터 다시 셀 것.
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
//   embed-sync의 `REPLACE INTO vec_<소스>` (1024차원 벡터 배치 + VECTOR INDEX 갱신 — search.js vecTable)
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

// 지식 청크를 문서·순번 범위로 읽는다. 범위를 여럿 받아 한 문장으로 묶는 이유는 왕복 수다 —
// 검색 한 번이 여러 문서에 걸리므로 문서마다 조회하면 그만큼 왕복이 늘고, 그 시간은 스텝마다 곱해진다.
// 정렬을 걸어 돌려준다: 호출부(chunk.js buildItems)는 doc_seq·chunk_no로 Map을 만들지만, 정렬이
// 서 있어야 그 Map을 만들기 전에 결과를 눈으로 확인할 수 있고 테스트도 순서를 기대할 수 있다.
// 범위가 비면 왕복하지 않는다 — 적중이 없는 검색에서 빈 IN 절로 문장을 만들면 문법 오류가 난다.
export function loadChunkRanges(ranges) {
  const rs = (ranges ?? []).filter(r => r && r.doc_seq != null);
  if (!rs.length) return Promise.resolve([]);
  const where = rs.map(() => '(doc_seq = ? AND chunk_no BETWEEN ? AND ?)').join(' OR ');
  return query(
    `SELECT seq, doc_seq, chunk_no, chunk_of, doc_hash, title, content FROM knowledge_chunk
     WHERE ${where} ORDER BY doc_seq, chunk_no`,
    rs.flatMap(r => [r.doc_seq, r.from, r.to])
  );
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
  const order = new Map();
  names.forEach((n, i) => { const k = nameKey(n); if (k && !order.has(k)) order.set(k, i); });
  if (!order.size) return [];
  const rows = await query(
    `SELECT * FROM query_registry WHERE query_name IN (${names.map(() => '?').join(',')})`,
    names
  );
  // 일반적인 정확 조회는 UNIQUE 인덱스 한 번으로 끝낸다. collation은 악센트와
  // 다른 이모지도 같게 보므로 실행·반복 가드와 같은 nameKey로 후보를 확인한다.
  const valid = rows.filter(r => order.has(nameKey(r.query_name)));
  const found = new Set(valid.map(r => nameKey(r.query_name)));
  const missing = new Set([...order.keys()].filter(k => !found.has(k)));
  // 대부분의 검색어(ASCII·한글·숫자·이모지)는 UNIQUE 인덱스 조회 한 번이면 충분하다.
  // 등록명 전체 확인은 DB Unicode 표와 JS 변환이 달라질 수 있는 비ASCII 대소문자·결합 문자에만 한다.
  // 예외적으로 K는 JS 소문자화 결과가 ASCII k다. 요청이 이미 k로 들어오면 정규화한 키만 보고
  // 원래 등록명에 비ASCII 문자가 있었음을 알 수 없으므로 k를 포함한 미적중도 보충한다.
  // 이 제한이 없으면 자연어 query 검색마다 등록명 전체를 한 번 더 읽게 된다.
  const needsUnicodeFallback = [...missing].some(s =>
    s.includes('k') || [...s].some(ch =>
      (ch.codePointAt(0) > 0x7f && ch.toLowerCase() !== ch.toUpperCase()) || /\p{M}/u.test(ch)));
  if (needsUnicodeFallback) {
    // DB와 JS의 Unicode 소문자화는 다르다(İ → i + 결합점 등).
    // 인덱스가 놓친 이름은 번호·이름만 읽어 확인하고 해당 PK의 상세만 가져온다.
    const refs = (await queryNames()).filter(r => missing.has(nameKey(r.query_name)));
    const extra = await queriesByIds(refs.map(r => r.seq));
    // 두 조회 사이 이름이 바뀌면 요청하지 않은 SQL이 될 수 있다. 현재 이름을 재확인한다.
    valid.push(...extra.filter(r => missing.has(nameKey(r.query_name))));
  }
  return valid.sort((a, b) => order.get(nameKey(a.query_name)) - order.get(nameKey(b.query_name)));
}

const queryNames = () => query('SELECT seq, query_name FROM query_registry');
const queriesByIds = ids => ids.length
  ? query(`SELECT * FROM query_registry WHERE seq IN (${ids.map(() => '?').join(',')})`, ids)
  : Promise.resolve([]);

// 처리방법 본문에 있는 등록명을 첫 등장 순서로 읽는다. 한글 조사와 1~2자 이름도
// 매칭하며 '_'·'%'는 리터럴이다. 짧은 이름이 긴 이름 안에도 잡히는 부분 문자열 계약은
// 유지한다. 흔한 낱말보다 변별력 있는 query_name을 등록해야 한다.
//
// DB LOWER/LOCATE는 JS와 Unicode 규칙이 달라 정상 이름을 놓치거나 다른 이모지를
// 선택한다. 실행·정확 조회와 같은 nameKey로 판정한다. 첫 조회는 이름과 번호뿐이며,
// 본문에 맞는 상위 후보만 PK로 읽는다. 등록된 SQL·설명 전체를 전송하거나 캐시하지 않는다.
// limit은 호출부의 후보 상한이다. 두 SELECT 사이 변경된 이름도 상세를 받은 뒤 재검증한다.
export async function loadQueriesMentionedIn(text, limit = Infinity) {
  const body = String(text ?? '');
  if (!body.trim() || limit <= 0) return [];
  const matching = rows => rows.map(r => ({ ...r, _pos: nameIndexOf(body, r.query_name) }))
    .filter(r => r._pos >= 0).sort((a, b) => a._pos - b._pos || a.seq - b.seq);
  const refs = matching(await queryNames()).slice(0, limit);
  return matching(await queriesByIds(refs.map(r => r.seq)));
}

// trace를 chat_log.trace(JSON 컬럼)에 넣을 글자로 만든다. (테스트에서 쓰므로 export)
//
// 짝 잃은 서로게이트를 여기서 걷어내는 이유: JSON 컬럼은 MariaDB가 INSERT에서 검사하는데
// (`CHECK (json_valid(trace))`), JSON.stringify가 짝 잃은 코드유닛을 `\udXXX` 이스케이프로 내보내면
// 그 JSON은 검사를 통과하지 못한다 — 실측: `CONSTRAINT chat_log.trace failed`. 그러면 그 요청의
// **대화 로그 한 줄이 통째로** 사라지고 남는 것은 '[chat_log] failed to record' 한 줄뿐이다.
// chat_log는 '답하지 못한 질문'을 찾는 유일한 출처인데(README), 하필 모델 출력이 깨진 요청 —
// 가장 들여다볼 값어치가 있는 요청 — 만 데이터에서 빠진다.
//
// 들어오는 통로는 params다. 결정 경계(llm.js sanitizeDecision)는 검색어·query_name·target_db에서만
// 짝 잃은 코드유닛을 걷어내고 params는 일부러 건드리지 않는다 — 그 값은 실행에 쓰이므로 말없이 고치면
// '잘린 값으로 조회해 0건을 없다고 단정하는' 실패를 그 경계가 스스로 만들게 되기 때문이다(그쪽 주석).
// 그 판단은 그대로 둔다. 실행에 쓰는 값과 로그에 남기는 글자는 다른 소비자이고, 제약도 다르다 —
// 그래서 '저장하는 쪽'인 여기서 한 번만 맞춘다. 모델은 출력이 토큰 상한에서 이모지 한가운데로 끊기면
// 실제로 반쪽짜리 코드유닛을 낸다(llm.js sanitizeDecision 머리말).
//
// 키도 같은 통로다 — params의 키는 모델이 적은 바인드명이다. 그런데 replacer는 키를 고칠 수 없고,
// 키를 고치려고 replacer에서 '새 객체'를 돌려주면 안 된다: JSON.stringify의 순환 참조 탐지는
// '지금 직렬화 중인 값'의 스택을 보므로 원본이 그 스택에 한 번도 올라가지 않아, 깔끔한 TypeError 대신
// 스택이 바닥날 때까지 재귀한다 (agent.js valueKey에 같은 교훈을 적어 두었다).
// 그래서 두 걸음으로 나눈다: ① 값만 고치는 replacer로 한 번 만들고 ② 그래도 짝 잃은 이스케이프가
// 남아 있으면(= 키에 남은 것이다) 그때만 키까지 훑어 다시 만든다. ②는 순환을 마커로 끊는다.
// 성한 trace는 ①에서 끝나고 글자가 한 글자도 달라지지 않는다.
const safeString = (key, value) => (typeof value === 'string' ? stripLoneSurrogates(value) : value);
// JSON.stringify가 `\uXXXX`로 내보내는 것은 제어문자(0000~001F)와 짝 잃은 코드유닛뿐이다 —
// D800~DFFF 범위의 이스케이프가 남았다는 것은 곧 짝 잃은 코드유닛이 남았다는 뜻이다.
// (값에 든 리터럴 백슬래시는 `\\`로 나가므로 여기 걸려도 손해는 ②를 한 번 더 도는 것뿐이다.)
const LONE_ESCAPE_RE = /\\u[dD][89abAB][0-9a-fA-F]{2}|\\u[dD][c-fC-F][0-9a-fA-F]{2}/;
const CYCLE_MARK = '[순환]';
function stripKeysDeep(v, seen) {
  if (!v || typeof v !== 'object') return v;
  if (seen.has(v)) return CYCLE_MARK;
  seen.add(v);
  const out = Array.isArray(v)
    ? v.map(x => stripKeysDeep(x, seen))
    : Object.fromEntries(Object.entries(v).map(([k, x]) => [stripLoneSurrogates(k), stripKeysDeep(x, seen)]));
  seen.delete(v);
  return out;
}
export function traceJson(trace) {
  const text = JSON.stringify(trace, safeString);
  return LONE_ESCAPE_RE.test(text ?? '') ? JSON.stringify(stripKeysDeep(trace, new Set()), safeString) : text;
}

// 대화 로그 기록 — 평가셋/미답변 질문 발굴용. 실패해도 응답에는 영향 없다 (호출부 catch).
// async여야 한다: JSON.stringify는 query() 호출 전에 동기로 평가되므로, 일반 함수면
// 직렬화 실패(순환 참조 등)가 호출부의 .catch가 붙기도 전에 동기 예외로 튀어나가
// /api/chat의 try에 잡히고, 다 계산해둔 정상 답변이 500으로 버려진다.
export async function insertChatLog(question, answer, trace) {
  return query(
    'INSERT INTO chat_log (question, answer, trace) VALUES (?, ?, ?)',
    [question, answer, traceJson(trace)]
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
