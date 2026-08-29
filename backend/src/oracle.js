// 조회용 DB(Oracle) 쿼리 실행기.
// node-oracledb Thin 모드(기본값) 사용 — Oracle Instant Client 설치 불필요.
// ORACLE_MOCK=1 이면 실제 접속 없이 하단 MOCK_DATA의 stub 결과를 반환한다.
import oracledb from 'oracledb';
import { loadTargetDb } from './db.js';

// query_sql에서 :bind 변수명 추출.
// 문자열 리터럴은 먼저 제거한다 — TO_CHAR(D, 'HH24:MI')의 :MI 같은 것이 바인드로 잡히면 안 된다.
export function bindNames(sql) {
  const withoutLiterals = sql.replace(/'(?:[^']|'')*'/g, "''");
  return [...new Set([...withoutLiterals.matchAll(/:(\w+)/g)].map(m => m[1]))];
}

// 조회 전용 가드: 의도치 않은 UPDATE/DELETE/DDL 실행 방지.
// (1) 주석 제거 후 SELECT 또는 WITH로 시작하는 문장만 허용 (Oracle의 WITH는 조회 전용)
// (2) 세미콜론이 포함된 다중 문장 금지
// 추가로 target_db의 계정 자체를 read-only 권한으로 만드는 것을 권장한다 (README 참고).
function assertReadOnly(sql) {
  const s = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!/^(SELECT|WITH)\b/i.test(s)) {
    throw new Error('조회(SELECT) 쿼리만 실행할 수 있습니다.');
  }
  if (s.replace(/;\s*$/, '').includes(';')) {
    throw new Error('다중 문장 쿼리는 실행할 수 없습니다.');
  }
}

export async function runQuery(registryRow, params = {}) {
  assertReadOnly(registryRow.query_sql);

  const missing = bindNames(registryRow.query_sql).filter(n => !(n in params));
  if (missing.length) throw new Error(`바인드 변수 누락: ${missing.join(', ')}`);

  if (process.env.ORACLE_MOCK === '1') return mockResult(registryRow.query_name, params);

  const target = await loadTargetDb(registryRow.target_db_name);
  if (!target) throw new Error(`조회대상 DB를 찾을 수 없음: ${registryRow.target_db_name}`);
  if (target.db_type && target.db_type !== 'oracle') {
    throw new Error(`지원하지 않는 db_type: ${target.db_type} (현재 oracle만 지원)`);
  }

  // 풀 없이 실행마다 접속/해제 — 사내 Q&A 트래픽 수준에 충분, 다중 target_db 관리 단순
  const conn = await oracledb.getConnection({
    user: target.db_user,
    password: resolvePassword(target.db_password),
    connectString: target.connection_info,
  });
  try {
    // 사용자 입력은 바인드 값으로만 전달한다 (SQL 문자열 결합 금지)
    const result = await conn.execute(registryRow.query_sql, params, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      maxRows: 100,
    });
    return result.rows;
  } finally {
    await conn.close();
  }
}

// 'ENV:변수명' 형식이면 서버 환경변수에서 읽는다. 평문은 개발용으로만 허용.
function resolvePassword(stored) {
  if (stored?.startsWith('ENV:')) return process.env[stored.slice(4)] || '';
  return stored;
}

// ===== ORACLE_MOCK=1 개발용 stub 데이터 =====
// batch_job_status가 FAILED를 반환해 "쿼리 결과 + 지식 결합 답변" 시나리오를 시연한다.
const MOCK_DATA = {
  batch_job_status: p => [
    { JOB_ID: p.job_id, STATUS: 'FAILED', LAST_RUN_AT: '2026-08-28 01:00' },
  ],
  find_customer_id: p => [
    { CUSTOMER_ID: 'C-1001', CUSTOMER_NAME: p.customer_name },
  ],
  order_status_by_customer: p => [
    { ORDER_ID: 'O-777', CUSTOMER_ID: p.customer_id, STATUS: '배송중', ORDER_DATE: '2026-08-27' },
  ],
};

function mockResult(queryName, params) {
  const gen = MOCK_DATA[queryName];
  if (!gen) throw new Error(`mock 데이터가 정의되지 않은 쿼리: ${queryName}`);
  return gen(params);
}
