// 조회용 DB(Oracle) 쿼리 실행기.
// node-oracledb Thin 모드(기본값) 사용 — Oracle Instant Client 설치 불필요.
// ORACLE_MOCK=1 이면 실제 접속 없이 하단 MOCK_DATA의 stub 결과를 반환한다.
import oracledb from 'oracledb';
import { loadTargetDb } from './db.js';

// CLOB은 기본값이 Lob 스트림 객체다 — 커넥션을 닫으면 무효가 되고 JSON 직렬화도 되지 않으므로
// 문자열로 받는다 (agent.js의 셀 길이 제한이 그대로 적용된다).
oracledb.fetchAsString = [oracledb.CLOB];

// 조회 결과 상한 — capped 판정(agent.js)과 사용자 안내 문구(llm*.js)가 같은 값을 봐야 한다
export const MAX_ROWS = 100;

// 조회 타임아웃(ms). 잘못된 값은 기본값으로 되돌린다 —
// 드라이버는 NaN에 NJS-004를 던지므로, 검증 없이 두면 오타 하나로 모든 조회가 실패한다.
const TIMEOUT_MS = (() => {
  const raw = process.env.ORACLE_TIMEOUT_MS;
  const v = Number(raw ?? 30_000);
  if (Number.isFinite(v) && v >= 0) return v;
  console.warn(`[oracle] ORACLE_TIMEOUT_MS 값이 올바르지 않아 기본값(30초)을 사용합니다: ${raw}`);
  return 30_000;
})();

// 문자열 리터럴과 주석을 공백으로 지운 SQL — 둘 다 "코드가 아닌 부분"이므로
// 바인드 추출과 조회 전용 가드가 같은 기준을 봐야 한다. 하나의 정규식으로 왼쪽부터 훑어
// 먼저 시작하는 쪽(리터럴 속 --, 주석 속 ' 등)이 매칭되게 한다.
const SQL_NOISE = /q'\[[\s\S]*?\]'|q'\{[\s\S]*?\}'|q'\([\s\S]*?\)'|q'<[\s\S]*?>'|'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//gi;
const stripNoise = sql => sql.replace(SQL_NOISE, ' ');

// query_sql에서 :bind 변수명 추출.
// 리터럴의 TO_CHAR(D, 'HH24:MI')나 주석 속 ':name'이 바인드로 잡히면 안 되므로 둘 다 지운 뒤 찾는다.
export function bindNames(sql) {
  return [...new Set([...stripNoise(sql).matchAll(/:(\w+)/g)].map(m => m[1]))];
}

// 조회 전용 가드: 의도치 않은 UPDATE/DELETE/DDL 실행 방지.
// (1) 주석 제거 후 SELECT 또는 WITH로 시작하는 문장만 허용 (Oracle의 WITH는 조회 전용)
// (2) 세미콜론이 포함된 다중 문장 금지
// 추가로 target_db의 계정 자체를 read-only 권한으로 만드는 것을 권장한다 (README 참고).
function assertReadOnly(sql) {
  // 리터럴도 함께 지운다 — LISTAGG(name, '; ')처럼 값에 든 세미콜론을 다중 문장으로 오판하지 않도록
  const s = stripNoise(sql).trim();
  if (!/^(SELECT|WITH)\b/i.test(s)) {
    throw new Error('조회(SELECT) 쿼리만 실행할 수 있습니다.');
  }
  if (s.replace(/;\s*$/, '').includes(';')) {
    throw new Error('다중 문장 쿼리는 실행할 수 없습니다.');
  }
}

export async function runQuery(registryRow, params = {}) {
  assertReadOnly(registryRow.query_sql);

  // SQL에 실제로 있는 바인드만 추려서 전달한다 — LLM이 여분 파라미터를 주면
  // 드라이버가 바인드 수 불일치(NJS-098)로 실패하므로 필터가 필요하다.
  const names = bindNames(registryRow.query_sql);
  const missing = names.filter(n => params?.[n] === undefined);
  if (missing.length) throw new Error(`바인드 변수 누락: ${missing.join(', ')}`);
  const binds = Object.fromEntries(names.map(n => [n, params[n]]));

  if (process.env.ORACLE_MOCK === '1') return mockResult(registryRow.query_name, binds);

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
    // 조회 타임아웃 — 느린 쿼리(락 대기, 잘못된 실행계획)가 요청을 무한 대기시키지 않게.
    // 초과 시 오류가 나고 agent가 history에 기록해 LLM이 안내 답변한다.
    // 반드시 try 안에서 설정한다 — 드라이버가 던지면 밖에서는 finally의 close가 실행되지 않아 커넥션이 샌다.
    conn.callTimeout = TIMEOUT_MS;
    // 사용자 입력은 바인드 값으로만 전달한다 (SQL 문자열 결합 금지)
    const result = await conn.execute(registryRow.query_sql, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      maxRows: MAX_ROWS,
    });
    return formatDates(result.rows ?? []);
  } finally {
    await conn.close().catch(() => {}); // close 실패가 원본 쿼리 오류를 덮어쓰지 않게
  }
}

// DATE/TIMESTAMP 컬럼은 JS Date로 오는데, JSON.stringify가 이를 UTC(toISOString)로 직렬화한다.
// 그대로 두면 KST 서버에서 DB의 '2026-08-28 01:00'이 프롬프트·로그에 9시간 어긋난 값으로 실린다.
// DB에서 보이는 그대로의 시각 문자열로 바꿔 전달한다.
function formatDates(rows) {
  return rows.map(row => Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v instanceof Date ? localDateTime(v) : v])
  ));
}

function localDateTime(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 'ENV:변수명' 형식이면 서버 환경변수에서 읽는다. 평문은 개발용으로만 허용.
function resolvePassword(stored) {
  if (stored?.startsWith('ENV:')) return process.env[stored.slice(4)] || '';
  return stored;
}

// ===== ORACLE_MOCK=1 개발용 stub 데이터 =====
// batch_job_status가 FAILED를 반환해 "쿼리 결과 + 지식 결합 답변" 시나리오를 시연한다.
// oracle-init.sql의 샘플 배치와 같은 데이터
const MOCK_JOBS = [
  { JOB_ID: 'BATCH001', JOB_NAME: '일별 정산 배치', STATUS: 'FAILED',  LAST_RUN_AT: '2026-08-28 01:00' },
  { JOB_ID: 'BATCH002', JOB_NAME: '주문 집계 배치', STATUS: 'SUCCESS', LAST_RUN_AT: '2026-08-29 02:10' },
  { JOB_ID: 'BATCH003', JOB_NAME: '고객 등급 산정', STATUS: 'RUNNING', LAST_RUN_AT: '2026-08-29 03:00' },
];

const MOCK_DATA = {
  batch_job_status: p => [
    { JOB_ID: p.job_id, STATUS: 'FAILED', LAST_RUN_AT: '2026-08-28 01:00' },
  ],
  // seed의 '경로B 데모' 쿼리 (qa_method 없이 query_desc만으로 선택된다) — 등록 SQL의 출력 컬럼과 동일하게 STATUS는 제외
  batch_list_by_status: p => MOCK_JOBS
    .filter(j => j.STATUS === String(p.status ?? '').toUpperCase())
    .map(({ STATUS, ...row }) => row),
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
