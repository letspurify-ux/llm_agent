// 조회용 DB(Oracle) 쿼리 실행기.
// node-oracledb Thin 모드(기본값) 사용 — Oracle Instant Client 설치 불필요.
// ORACLE_MOCK=1 이면 실제 접속 없이 하단 MOCK_DATA의 stub 결과를 반환한다.
import oracledb from 'oracledb';
import { loadTargetDb } from './db.js';
import { bindNames, assertReadOnly } from './sql.js';
import { MAX_ROWS, MAX_CELL_LEN, TRUNC_MARK, numEnv } from './constants.js';

// 드라이버 경계에서 타입을 확정한다. LOB은 기본값이 Lob 스트림 객체라 커넥션을 닫으면 무효가 되고
// JSON 직렬화 시 순환 참조로 예외가 난다 — CLOB만이 아니라 NCLOB/BLOB도 같은 위험이므로 전부 다룬다.
// 날짜류를 STRING으로 받는 이유는 아래 NLS_SESSION_FORMATS 주석 참고.
oracledb.fetchTypeHandler = metaData => {
  switch (metaData.dbType) {
    case oracledb.DB_TYPE_DATE:
    case oracledb.DB_TYPE_TIMESTAMP:
    case oracledb.DB_TYPE_TIMESTAMP_TZ:
    case oracledb.DB_TYPE_TIMESTAMP_LTZ:
    case oracledb.DB_TYPE_CLOB:
    case oracledb.DB_TYPE_NCLOB:
      return { type: oracledb.STRING };
    case oracledb.DB_TYPE_BLOB:
      return { type: oracledb.BUFFER };
    default:
      return undefined; // 나머지는 드라이버 기본 매핑
  }
};

// 날짜/시각은 JS Date로 받지 않고 DB가 직접 포맷한 문자열로 받는다.
//   - JS Date를 로컬 getter로 다시 렌더링하면 TIMESTAMP WITH (LOCAL) TIME ZONE에서
//     Node 프로세스 TZ와 DB TZ가 다를 때 조용히 어긋난다(UTC 컨테이너 ↔ KST DB = 9시간).
//   - 세션 포맷을 고정해두면 그 문자열을 다음 스텝의 바인드로 되돌려도 같은 세션 포맷으로
//     암묵 변환되므로, multi-step 날짜 연결에서 ORA-01861이 나지 않는다.
// 부작용: 등록 SQL이 포맷 마스크 없는 TO_CHAR(d)/TO_DATE(s)를 쓰면 이제 서버 기본값이 아니라
// 이 포맷을 따른다. 서버 설정에 따라 달라지던 것이 고정되는 것이므로 등록 쿼리는 포맷을 명시할 것.
const NLS_SESSION_FORMATS =
  "ALTER SESSION SET NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS'" +
  " NLS_TIMESTAMP_FORMAT='YYYY-MM-DD HH24:MI:SS'" +
  " NLS_TIMESTAMP_TZ_FORMAT='YYYY-MM-DD HH24:MI:SS TZH:TZM'";

// 조회 타임아웃(ms). 0/음수/NaN/빈 값은 기본값으로 되돌린다 —
// 드라이버는 NaN에 NJS-004를 던지고, 0은 "타임아웃 없음"이라 오타 하나가 무한 대기를 만든다.
const TIMEOUT_MS = numEnv('ORACLE_TIMEOUT_MS', 30_000);

// 반환: { rows, totalRows, capped } — rows는 MAX_ROWS까지, 셀은 MAX_CELL_LEN까지 정규화된 값.
// capped는 "상한에 걸려 잘렸다"는 뜻이므로 MAX_ROWS+1건을 요청해 판정한다
// (정확히 MAX_ROWS건인 완전한 결과를 "더 있을 수 있음"으로 잘못 알리지 않도록).
export async function runQuery(registryRow, params = {}) {
  assertReadOnly(registryRow.query_sql);

  // SQL에 실제로 있는 바인드만 추려서 전달한다 — LLM이 여분 파라미터를 주면
  // 드라이버가 바인드 수 불일치(NJS-098)로 실패하므로 필터가 필요하다.
  const names = bindNames(registryRow.query_sql);
  const missing = names.filter(n => params?.[n] === undefined);
  if (missing.length) throw new Error(`바인드 변수 누락: ${missing.join(', ')}`);
  const binds = Object.fromEntries(names.map(n => [n, params[n]]));

  if (process.env.ORACLE_MOCK === '1') return capResult(mockResult(registryRow.query_name, binds));

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
    await setSessionFormats(conn);
    // 사용자 입력은 바인드 값으로만 전달한다 (SQL 문자열 결합 금지)
    const result = await conn.execute(registryRow.query_sql, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      maxRows: MAX_ROWS + 1,
    });
    return capResult(result.rows ?? []);
  } finally {
    await conn.close().catch(() => {}); // close 실패가 원본 쿼리 오류를 덮어쓰지 않게
  }
}

// 세션 포맷 고정은 표기 품질을 위한 것이지 조회의 전제 조건이 아니다 —
// 실패해도 조회는 계속한다 (여기서 던지면 부가 설정 하나가 모든 조회를 막는다).
// 실패 시 날짜는 DB 기본 NLS 포맷 문자열로 오고, 그 값을 다음 스텝 바인드로 되돌릴 때만
// 포맷 불일치(ORA-01861) 가능성이 남는다.
let nlsWarned = false;
async function setSessionFormats(conn) {
  try {
    await conn.execute(NLS_SESSION_FORMATS);
  } catch (e) {
    if (!nlsWarned) {
      nlsWarned = true;
      console.warn(`[oracle] 세션 날짜 포맷 고정 실패 — DB 기본 포맷을 사용합니다: ${e.message}`);
    }
  }
}

function capResult(allRows) {
  const capped = allRows.length > MAX_ROWS;
  const rows = allRows.slice(0, MAX_ROWS).map(normalizeCells);
  return { rows, totalRows: rows.length, capped };
}

// 셀 값 정규화 — LOB/이진 값이 그대로 history와 chat_log(JSON)로 흘러가지 않게 드라이버 경계에서 처리한다.
// 길이 제한을 여기서 적용하는 이유: 대형 CLOB 문자열을 즉시 잘라내 downstream(프롬프트·로그)에
// 남지 않게 하기 위함. 단, 드라이버가 LOB을 메모리에 올리는 비용 자체는 남는다 (maxRows로만 제한됨).
function normalizeCells(row) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, normalizeValue(v)]));
}

function normalizeValue(v) {
  if (typeof v === 'string') {
    return v.length > MAX_CELL_LEN ? v.slice(0, MAX_CELL_LEN) + TRUNC_MARK : v;
  }
  if (Buffer.isBuffer(v)) return `<binary ${v.length} bytes>`;
  // fetchTypeHandler가 날짜류를 문자열로 받으므로 정상 경로에서는 Date가 오지 않는다.
  // 드라이버 매핑이 바뀌더라도 JSON.stringify가 UTC로 직렬화해 시각이 어긋나는 일이 없게 방어한다.
  if (v instanceof Date) return localDateTime(v);
  return v;
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
// oracle-init.sql의 샘플 배치와 같은 데이터 — mock과 실제 컨테이너가 다른 답을 내면
// mock으로 검증한 시나리오가 실제 배포에서 재현되지 않는다.
// BATCH001이 FAILED라 "쿼리 결과 + 지식 결합 답변" 시나리오를 시연한다.
const MOCK_JOBS = [
  { JOB_ID: 'BATCH001', JOB_NAME: '일별 정산 배치', STATUS: 'FAILED',  LAST_RUN_AT: '2026-08-28 01:00' },
  { JOB_ID: 'BATCH002', JOB_NAME: '주문 집계 배치', STATUS: 'SUCCESS', LAST_RUN_AT: '2026-08-29 02:10' },
  { JOB_ID: 'BATCH003', JOB_NAME: '고객 등급 산정', STATUS: 'RUNNING', LAST_RUN_AT: '2026-08-29 03:00' },
];

// 등록 SQL(seed.sql)과 같은 비교·정렬·출력 컬럼을 쓴다.
// Oracle 문자열 비교는 대소문자를 구분하므로 mock도 구분한다 — mock에서만 통과하는
// 파라미터(status:'failed' 등)가 실제 DB에서 0건이 되는 것을 데모 단계에서 드러내기 위함.
const MOCK_DATA = {
  batch_job_status: p => MOCK_JOBS
    .filter(j => j.JOB_ID === p.job_id)
    .map(({ JOB_ID, JOB_NAME, STATUS, LAST_RUN_AT }) => ({ JOB_ID, JOB_NAME, STATUS, LAST_RUN_AT })),
  // seed의 '경로B 데모' 쿼리 (qa_method 없이 query_desc만으로 선택된다) — 등록 SQL의 출력 컬럼과 동일하게 STATUS는 제외
  batch_list_by_status: p => MOCK_JOBS
    .filter(j => j.STATUS === p.status)
    .sort((a, b) => b.LAST_RUN_AT.localeCompare(a.LAST_RUN_AT)) // ORDER BY LAST_RUN_AT DESC
    .map(({ STATUS, ...row }) => row),
  find_customer_id: p => [
    { CUSTOMER_ID: 'C-1001', CUSTOMER_NAME: p.customer_name, GRADE: 'VIP' },
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
