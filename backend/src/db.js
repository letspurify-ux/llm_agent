// MariaDB (agent 관리 DB) 커넥션 풀 + 관리 테이블 로더
import mariadb from 'mariadb';

const pool = mariadb.createPool({
  host: process.env.MARIADB_HOST || 'localhost',
  port: Number(process.env.MARIADB_PORT || 3306),
  user: process.env.MARIADB_USER,
  password: process.env.MARIADB_PASSWORD,
  database: process.env.MARIADB_DATABASE || 'llm_agent',
  connectionLimit: 5,
});

export async function query(sql, params = []) {
  const conn = await pool.getConnection();
  try {
    return await conn.query(sql, params);
  } finally {
    conn.release();
  }
}

// 쿼리 관리 테이블 전체 로드 — 소규모(라우팅 임계치 이하)일 때만 사용
export function loadQueryRegistry() {
  return query('SELECT * FROM query_registry');
}

export async function countQueries() {
  return Number((await query('SELECT COUNT(*) AS c FROM query_registry'))[0].c);
}

// qa_method 본문이 지목한 query_name들을 로드 (라우팅 경로A)
export function loadQueriesByNames(names) {
  if (!names.length) return Promise.resolve([]);
  return query(
    `SELECT * FROM query_registry WHERE query_name IN (${names.map(() => '?').join(',')})`,
    names
  );
}

// 조회대상 DB 접속 정보 로드
export async function loadTargetDb(dbName) {
  const rows = await query(
    'SELECT seq, db_name, db_type, connection_info, db_user, db_password FROM target_db WHERE db_name = ?',
    [dbName]
  );
  return rows[0];
}
