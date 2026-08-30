// MariaDB (agent 관리 DB) 커넥션 풀 + 관리 테이블 로더
import mariadb from 'mariadb';
import { numEnv } from './constants.js';

// 풀은 처음 쓸 때 만든다 — import만으로 만들면 이 모듈을 (간접적으로라도) 불러오는 모든 코드가
// DB에 접속을 시도한다. 검색 로직만 import하는 테스트가 MariaDB 기동 여부에 따라 10초씩 매달리는 식이다.
let pool;
function getPool() {
  pool ??= mariadb.createPool({
    host: process.env.MARIADB_HOST || 'localhost',
    port: numEnv('MARIADB_PORT', 3306), // Number()로 받으면 오타가 NaN이 되어 경고 없이 접속이 깨진다
    user: process.env.MARIADB_USER,
    password: process.env.MARIADB_PASSWORD,
    database: process.env.MARIADB_DATABASE || 'llm_agent',
    // 요청 1건이 최대 4개를 동시에 쥔다 (지식·처리방법 검색이 병렬, 각각 LIKE+벡터가 다시 병렬).
    // 여기에 embed-sync가 동기화 내내 락 커넥션 1개를 계속 쥐므로, 5면 동시 사용자 2명에서
    // 풀이 마르고 커넥터 기본 acquireTimeout(10초)에 걸려 500이 난다.
    connectionLimit: numEnv('MARIADB_POOL_SIZE', 10),
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

export async function query(sql, params = []) {
  const conn = await getPool().getConnection();
  try {
    return await conn.query(sql, params);
  } finally {
    await releaseConnection(conn);
  }
}

// 정상 종료용 — 풀을 닫아 반납된 커넥션까지 정리한다 (server.js의 shutdown 참고).
// 다시 호출되면 getPool()이 새 풀을 만들도록 참조를 비운다.
export async function closePool() {
  const p = pool;
  if (!p) return;
  pool = undefined;
  await p.end();
}

// 쿼리 관리 테이블 로드 — 소규모(라우팅 임계치 이하)일 때만 사용.
// limit은 호출부가 "임계치+1"을 넣어 규모 판정까지 겸한다 (agent.js selectQueries 참고).
// limit === undefined로 판정한다 — truthy로 보면 limit=0이 "0건"이 아니라 "전체 로드"가 되어,
// 남은 자리를 계산해 넘기는 호출부가 생기는 순간 조용히 대형 SELECT가 프롬프트 경로로 들어온다.
export function loadQueryRegistry(limit) {
  return limit === undefined
    ? query('SELECT * FROM query_registry')
    : query('SELECT * FROM query_registry LIMIT ?', [limit]);
}

// qa_method 본문이 지목한 query_name들을 로드 (라우팅 경로A)
export function loadQueriesByNames(names) {
  if (!names.length) return Promise.resolve([]);
  return query(
    `SELECT * FROM query_registry WHERE query_name IN (${names.map(() => '?').join(',')})`,
    names
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
