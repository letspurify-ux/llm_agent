// 조회용 DB(Oracle) 쿼리 실행기.
// node-oracledb Thin 모드(기본값) 사용 — Oracle Instant Client 설치 불필요.
// ORACLE_MOCK=1 이면 실제 접속 없이 하단 MOCK_DATA의 stub 결과를 반환한다.
import oracledb from 'oracledb';
import { loadTargetDb } from './db.js';
import { bindNames, assertReadOnly } from './sql.js';
import { MAX_ROWS, MAX_CELL_LEN, MAX_RESULT_COLS, TRUNC_MARK, numEnv, nameKey, safeError, clipText, warnOnce, ownProp } from './constants.js';

// 드라이버 경계에서 타입을 확정한다. LOB은 기본값이 Lob 스트림 객체라 커넥션을 닫으면 무효가 되고
// JSON 직렬화 시 순환 참조로 예외가 난다 — CLOB만이 아니라 NCLOB/BLOB도 같은 위험이므로 전부 다룬다.
// 날짜류를 문자열로 받는 이유는 아래 NLS_SESSION_FORMATS 주석 참고.
//
// LOB·날짜에 fetchTypeHandler로 직접 타입을 지정하지 않는 이유: 핸들러가 돌려준 타입은 드라이버가
// 매핑 없이 그대로 쓰기 때문에, CLOB에 VARCHAR(oracledb.STRING)를 주면 VARCHAR 한도에서 잘린다.
// fetchAsString/fetchAsBuffer는 드라이버가 각 타입의 올바른 대상(CLOB→LONG, NCLOB→LONG_NVARCHAR,
// BLOB→LONG_RAW, DATE/TIMESTAMP/TZ/LTZ→VARCHAR)을 스스로 계산한다.
// (NUMBER만 아래에서 fetchTypeHandler를 쓴다 — 그쪽은 STRING 매핑이 정확히 의도한 동작이다.)
oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB, oracledb.DATE];
oracledb.fetchAsBuffer = [oracledb.BLOB];

// NUMBER는 기본 매핑(JS number)이 배정밀도라 16자리부터 조용히 반올림된다 — 18자리 채번 키가
// 끝자리만 다른 값으로 답변되고, 그 값이 다음 스텝의 바인드로도 흘러가 0건 오답까지 만든다.
// 날짜를 문자열로 받는 것과 같은 이유(조용한 어긋남)로, 정밀도가 보장되는 열(선언된 precision
// 1~15이면서 scale이 음수가 아닌 열)만 기본 매핑에 맡기고 나머지(선언 없는 NUMBER·식 결과 —
// precision 0 또는 미상)는 문자열로 받아 정확한 값을 확보한다. "위험이 증명된 열만 문자열"이
// 아니라 "안전이 증명된 열만 숫자"로 뒤집은 이유: 메타데이터가 비는 쪽으로 어긋나도 정확성이
// 깨지지 않는 방향이 이쪽이다.
//
// precision과 함께 scale을 보는 이유: 음수 scale은 값의 크기를 precision 밖으로 늘린다.
// 값이 가질 수 있는 자릿수는 precision이 아니라 precision - scale이므로, NUMBER(15,-2)는
// 유효 숫자 15자리지만 값은 17자리까지 가서 2^53을 넘고 그대로 반올림된다(실측:
// 12345678901234567 → …568). precision만 보면 이 열이 '안전이 증명된 열'로 분류돼,
// 위 주석이 막겠다고 한 그 반올림이 이 한 유형에서만 조용히 살아남는다.
// (FLOAT은 scale이 -127이지만 precision 검사에서 이미 걸러진다. scale이 없는 메타데이터도
//  비교가 false가 되어 문자열 경로로 가므로, 어긋나도 정확성이 지켜지는 방향은 그대로다.)
oracledb.fetchTypeHandler = md => {
  if (md.dbType === oracledb.DB_TYPE_NUMBER && !(md.precision >= 1 && md.precision <= 15 && md.scale >= 0)) {
    return { type: oracledb.STRING, converter: numberFromString };
  }
};

// 문자열로 받은 NUMBER를, JS number로 정밀도 손실 없이 왕복될 때만 숫자로 되돌린다.
// 전부 문자열로 두면 mock(숫자 리터럴)과 실제가 JSON 표기부터 달라져, mock으로 검증한 시나리오가
// 실제 배포에서 재현되지 않는다(MOCK_DATA 주석과 같은 원칙). 왕복이 어긋나는 값(16자리+)만
// 문자열 그대로 남아 정확한 자릿수를 지킨다. (테스트에서 쓰므로 export)
//
// 판정 기준은 '값이 보존되는가'이지 '표기가 같은가'가 아니다. 앞선 구현(String(n) === v)은 표기를
// 물었고, 그래서 Oracle의 지극히 정상적인 표기를 전부 손실로 오판했다 — 실측: '.5'(앞의 0을 생략),
// '1.0'·'0.10'(선언된 scale만큼 0을 유지)이 모두 문자열로 남았다. 그런데 이 변환기를 타는 열은
// '선언된 precision이 없는 NUMBER', 즉 SUM()·AVG()·비율 같은 모든 식의 결과다. 결과적으로 집계값이
// {"AVG_AMOUNT":".5"}처럼 따옴표 붙은 채로 프롬프트·답변·chat_log에 들어가, 모델은 mock(숫자
// 리터럴)에서와 다른 타입을 놓고 추론하게 된다 — 이 함수가 막겠다고 적어둔 바로 그 어긋남이다.
//
// 무손실 여부를 자릿수로 어림하지 않고 직접 증명한다. 두 표기를 같은 정규형으로 바꿔 비교하면
// '표기는 달라도 값이 같은가'라는, 이 함수가 원래 물었어야 할 질문에 정확히 답할 수 있다.
//
// "유효숫자 15자리 이하면 배정밀도를 왕복해도 안전하다"는 어림은 정규수(normal)에서만 성립한다.
// 2^-1022(약 2.2e-308) 아래의 비정규수(subnormal)는 가수 비트가 점점 줄어 5e-324에서는 한 비트만
// 남으므로, 유효숫자가 몇 자리든 값이 뭉개진다 (실측: '20980e-326' → 2.08e-322,
// '7765e-327' → 1e-323). 자릿수만 세는 판정은 이 구간을 통째로 놓친다.
// (Oracle NUMBER의 범위는 1e-130~9.99e125라 실무에서 이 구간에 닿지는 않지만, 이 함수의 존재
//  이유가 '왕복이 정확한 값만 숫자로'이므로 어림이 아니라 증명으로 판정한다.)
//
// 정규형은 (부호, 앞뒤 0을 뗀 유효숫자, 10의 지수)다 — '1.0'·'1'·'0.1e1'·'10e-1'이 모두 '1e0'이 된다.
// String(n)은 그 double로 되돌아오는 '가장 짧은 표기'이므로, 두 정규형이 같다는 것은
// JSON으로 나가는 값도 다음 스텝의 바인드로 되돌린 값도 원본과 같은 값이라는 뜻이다.
const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function decimalParts(s) {
  const m = DECIMAL_RE.exec(s);
  if (!m) return null;
  const frac = m[3] ?? '';
  let digits = (m[2] ?? '') + frac;
  if (!digits) return null;                     // 숫자가 한 자리도 없다 ('', '+', '.', 'e5')
  let exp = Number(m[4] || 0) - frac.length;
  digits = digits.replace(/^0+/, '');           // 앞의 0은 유효숫자가 아니다
  const trimmed = digits.replace(/0+$/, '');    // 뒤의 0은 지수로 옮긴다
  exp += digits.length - trimmed.length;
  // 값이 0이면 부호·지수와 무관하게 정규형이 하나다 ('0', '-0', '0.000', '0e10')
  return trimmed ? `${m[1] === '-' ? '-' : ''}${trimmed}e${exp}` : '0';
}

export function numberFromString(v) {
  if (v === null || typeof v !== 'string') return v;
  const s = v.trim();
  const want = decimalParts(s);
  // 숫자 표기가 아니면 손대지 않는다 (빈 문자열, 'Infinity', 서버 로케일이 넣은 구분기호 등)
  if (want === null) return v;
  const n = Number(s);
  // 표현 범위를 벗어나면 값을 통째로 잃는다 (1e400 → Infinity). 아래 비교로도 걸리지만,
  // String(Infinity)는 정규형을 갖지 않으므로 뜻이 분명한 자리에서 먼저 갈라둔다.
  if (!Number.isFinite(n)) return v;
  return decimalParts(String(n)) === want ? n : v;
}

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

// 접속 단계 상한(초). 주소마다 적용되므로 작게 잡는다 — 아래 getConnection 주석 참고.
// 사내망의 정상 접속은 1초 안쪽이라 10초면 넉넉하고, 주소 2개여도 최악 20초로 묶인다.
const CONNECT_TIMEOUT_S = 10;
const TRANSPORT_CONNECT_TIMEOUT_S = 5;

// ORACLE_MOCK의 단일 해석 지점. '1'만 보면 ORACLE_MOCK=true·yes·on이 전부 '실제 접속'으로
// 떨어지는데, 기동 배너는 원본 값을 그대로 찍어 'ORACLE_MOCK=true'라고 알린다 —
// mock인 줄 알고 운영 DB에 그대로 붙는다. LLM_PROVIDER와 같은 함정이라 같은 방식으로 막는다.
// 모르는 값은 '실제 접속'으로 두되(현재 동작 유지) 반드시 소리가 나게 한다 — 조용히 mock으로
// 돌리면 운영 DB를 조회한다고 믿는 답변이 stub 데이터로 나간다.
// 값은 호출 시점에 읽는다 (test/oracle.test.js가 import 뒤에 설정한다).
const MOCK_ON = ['1', 'true', 'yes', 'on'];
const MOCK_OFF = ['0', 'false', 'no', 'off'];

export function oracleMock() {
  const raw = process.env.ORACLE_MOCK;
  if (raw === undefined || String(raw).trim() === '') return false;
  const v = nameKey(raw);
  if (MOCK_ON.includes(v)) return true;
  if (MOCK_OFF.includes(v)) return false;
  warnOnce('setup', `unknown ORACLE_MOCK ${JSON.stringify(raw)} — treating it as off, so queries go to the real Oracle (valid: ${[...MOCK_ON, ...MOCK_OFF].join(', ')}). Check backend/.env.`);
  return false;
}

// 반환: { rows, totalRows, capped } — rows는 MAX_ROWS까지, 셀은 MAX_CELL_LEN까지 정규화된 값.
// capped는 "상한에 걸려 잘렸다"는 뜻이므로 MAX_ROWS+1건을 요청해 판정한다
// (정확히 MAX_ROWS건인 완전한 결과를 "더 있을 수 있음"으로 잘못 알리지 않도록).
export async function runQuery(registryRow, params = {}) {
  // 가드가 '실행용 SQL'까지 함께 돌려준다 — 무엇을 허용했는지 아는 쪽이 무엇을 실행할지도 정한다.
  // 실행부가 따로 문자열을 손보면 둘의 판단이 갈라진다 (sql.js assertReadOnly 주석 참고).
  const sql = assertReadOnly(registryRow.query_sql);

  // SQL에 실제로 있는 바인드만 추려서 전달한다 — LLM이 여분 파라미터를 주면
  // 드라이버가 바인드 수 불일치(NJS-098)로 실패하므로 필터가 필요하다.
  const names = bindNames(registryRow.query_sql);
  // 소유 키만 읽는다 (constants.ownProp) — 바인드명이 '__proto__' 같은 프로토타입 멤버와 겹치면
  // Object.prototype이 돌아와 '값 없음'이어야 할 판정이 '값이 아닌 구조'로 어긋난다.
  const val = n => ownProp(params, n);
  const bad = names.map(n => [n, bindProblem(val(n))]).filter(([, p]) => p);
  if (bad.length) {
    // 두 번째 인자(hint)는 모델 전용 지침 — 사용자 trace에는 message만 나간다 (constants.safeError 참고)
    throw safeError(
      `바인드 변수를 쓸 수 없습니다 — ${bad.map(([n, p]) => `${n}: ${p}`).join(', ')}.`,
      '질문이나 실행 이력에서 값을 확인하고, 알 수 없으면 사용자에게 되묻거나 다른 쿼리를 선택하라'
    );
  }
  const binds = Object.fromEntries(names.map(n => [n, val(n)]));

  if (oracleMock()) return capResult(mockResult(registryRow.query_name, binds));

  const target = await loadTargetDb(registryRow.target_db_name);
  if (!target) throw safeError(`조회대상 DB를 찾을 수 없음: ${registryRow.target_db_name}`);
  // 이름 비교는 nameKey로 한다 — target_db는 대소문자를 무시하는 collation이라 db_name 조회는
  // 'order_db'로도 'ORDER_DB' 행을 찾아준다. 그런데 db_type만 JS ===로 보면 'Oracle'로 등록한
  // 순간 그 DB의 모든 조회가 '지원하지 않는 db_type'으로 죽고, 화면에 나가는 문구는 등록 철자가
  // 아니라 DB 종류를 탓하는 것처럼 읽힌다. query_name에 nameKey를 둔 것과 같은 이유·같은 방식이다.
  if (target.db_type && nameKey(target.db_type) !== 'oracle') {
    throw safeError(`지원하지 않는 db_type: ${target.db_type} (현재 oracle만 지원)`);
  }

  // 풀 없이 실행마다 접속/해제 — 사내 Q&A 트래픽 수준에 충분, 다중 target_db 관리 단순
  const conn = await oracledb.getConnection({
    user: target.db_user,
    password: resolvePassword(target.db_password),
    connectString: target.connection_info,
    // 접속 자체에도 상한이 필요하다 — callTimeout은 커넥션이 생긴 뒤부터 적용되므로,
    // 리스너가 TCP는 받아주고 핸드셰이크를 끝내지 않는 상태(기동 중이거나 멈춘 DB)에서는
    // 여기서 무한정 매달려 agent의 요청 예산 검사가 무의미해진다. 단위는 초다(callTimeout만 ms).
    //
    // 둘 다 지정한다: 드라이버는 "둘 다 미설정"일 때만 transportConnectTimeout 기본값(20초)을 넣으므로,
    // connectTimeout만 주면 TCP 단계의 기본 상한이 오히려 사라진다 (sessionAtts.js).
    // 값을 작게 잡는 이유는 이 상한이 '주소마다' 적용되기 때문이다 — connect1이 주소 목록을
    // do/while로 돌며 시도마다 타이머를 새로 건다. 'localhost'는 ::1과 127.0.0.1 둘로 풀리므로
    // 실제 최악은 주소 수 × 값이다. 조회 타임아웃(ORACLE_TIMEOUT_MS)과 별개인 것도 그래서다.
    connectTimeout: CONNECT_TIMEOUT_S,
    transportConnectTimeout: TRANSPORT_CONNECT_TIMEOUT_S,
  });
  try {
    // 조회 타임아웃 — 느린 쿼리(락 대기, 잘못된 실행계획)가 요청을 무한 대기시키지 않게.
    // 초과 시 오류가 나고 agent가 history에 기록해 LLM이 안내 답변한다.
    // 반드시 try 안에서 설정한다 — 드라이버가 던지면 밖에서는 finally의 close가 실행되지 않아 커넥션이 샌다.
    conn.callTimeout = TIMEOUT_MS;
    await setSessionFormats(conn);
    // 사용자 입력은 바인드 값으로만 전달한다 (SQL 문자열 결합 금지).
    // sql은 가드가 승인하며 만든 실행용 형태다 — 여기서 다시 손보지 않는다.
    const result = await conn.execute(sql, binds, {
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
async function setSessionFormats(conn) {
  try {
    await conn.execute(NLS_SESSION_FORMATS);
  } catch (e) {
    // 억제는 warnOnce에 맡긴다 (search.js의 벡터 검색 경고와 같은 이유) — '한 번만' 플래그로 두면
    // 권한 문제로 한 번 알린 뒤 접속 자체가 다른 이유로 흔들려도 로그가 남지 않는다.
    warnOnce('oracle', `failed to fix session date format — falling back to the DB's default format: ${e.message}`);
  }
}

function capResult(allRows) {
  const capped = allRows.length > MAX_ROWS;
  const rows = allRows.slice(0, MAX_ROWS).map(normalizeCells);
  return { rows, totalRows: rows.length, capped };
}

// 셀 값 정규화 + 컬럼 수 상한 — LOB/이진 값이 그대로 history와 chat_log(JSON)로 흘러가지 않게
// 드라이버 경계에서 처리한다. 길이 제한을 여기서 적용하는 이유: 대형 CLOB 문자열을 즉시 잘라내
// downstream(프롬프트·로그)에 남지 않게 하기 위함. 단, 드라이버가 LOB을 메모리에 올리는 비용
// 자체는 남는다 (maxRows로만 제한됨).
// 컬럼 수도 같은 경계에서 묶는다 — 셀 길이·행 수만 막고 이 축을 열어두면 SELECT * 넓은 테이블의
// 행 하나(컬럼 수 × 셀 상한)가 프롬프트 예산과 답변·trace·chat_log를 그대로 관통한다
// (constants.MAX_RESULT_COLS 주석 참고). (테스트에서 쓰므로 export)
export function normalizeCells(row) {
  const entries = Object.entries(row);
  const kept = entries.slice(0, MAX_RESULT_COLS).map(([k, v]) => [k, normalizeValue(v)]);
  // 자른 사실은 행 안에 표시로 남긴다 — 조용히 자르면 모델과 사용자가 그 컬럼을 '없다'로 읽는다.
  if (entries.length > MAX_RESULT_COLS) {
    kept.push(['…', `외 ${entries.length - MAX_RESULT_COLS}개 컬럼 생략 (컬럼 수 상한 ${MAX_RESULT_COLS}개)`]);
  }
  return Object.fromEntries(kept);
}

function normalizeValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    return v.length > MAX_CELL_LEN ? clipText(v, MAX_CELL_LEN) + TRUNC_MARK : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  // BigInt는 JSON.stringify가 던진다 — 여기서 문자열로 확정하지 않으면 프롬프트 조립과
  // chat_log 기록이 함께 죽는다 (드라이버가 큰 NUMBER를 BigInt로 주도록 설정이 바뀌는 경우).
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return `<binary ${v.length} bytes>`;
  // fetchTypeHandler가 날짜류를 문자열로 받으므로 정상 경로에서는 Date가 오지 않는다.
  // 드라이버 매핑이 바뀌더라도 JSON.stringify가 UTC로 직렬화해 시각이 어긋나는 일이 없게 방어한다.
  if (v instanceof Date) return localDateTime(v);
  // 남은 것은 전부 드라이버 객체다 — LOB 스트림, 객체/컬렉션 타입(DbObject), 중첩 커서(ResultSet).
  // 이 함수가 '드라이버 경계에서 한 번' 정규화한다고 해놓고 문자열·이진값만 다루면 그 약속이 깨진다:
  // 이 값들은 커넥션에 묶여 있어 아래 finally의 close() 뒤에는 무효이고, JSON.stringify가
  // 순환 참조로 던지거나 '{}'로 직렬화한다. 던지는 쪽이 특히 나쁘다 — 프롬프트 조립이 통째로
  // 실패해 이미 조회해둔 결과까지 버려진다. 값의 정체를 남긴 문자열로 확정한다.
  return `<${v?.constructor?.name ?? typeof v} 값 — 지원하지 않는 컬럼 타입>`;
}

function localDateTime(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 바인드로 쓸 수 없는 값이면 그 이유를 돌려준다 (쓸 수 있으면 null).
// 앞의 세 경우는 실패시키지 않으면 조용히 0건이 나오고, LLM은 그 0건을 "그런 데이터가 없다"로 읽어
// 확신에 찬 오답을 만든다. 마지막 하나(true/false)는 조용하지 않게 실패하지만, 실패하는 곳이
// 드라이버 안이라 원문이 화면에서 가려지고(server.js) 모델에게도 단서가 남지 않는다.
// 넷 다 여기서, 접속하기 전에 실패시켜야 LLM이 되묻거나 다른 경로를 잡는다.
//   값 없음    → Oracle에서 `WHERE col = NULL`은 영원히 참이 아니다 (빈 문자열도 NULL로 취급된다)
//   true/false → node-oracledb가 23ai 미만 서버에 boolean을 바인드하지 못한다 (아래 상세 참고)
//   구조       → node-oracledb가 객체/배열을 바인드 서술자로 해석해 val 없이 NULL을 바인드한다
//   잘린 값    → normalizeValue가 MAX_CELL_LEN에서 자르고 TRUNC_MARK를 붙인 값이다. 그 값이 프롬프트를
//              거쳐 다음 스텝의 바인드로 되돌아오면 원본과 다르므로 절대 매칭되지 않는다.
//              (mock provider는 llm.js에서 아예 제안조차 하지 않게 막지만, 실제 LLM에는 그 가드가 없다)
//              표시만 보고 TRUNC_MARK를 뗀 앞부분만 넣는 경우가 더 흔하다 — 그 앞부분의 길이는
//              반드시 clipText가 남기는 절단 길이이므로, 이력을 대조하지 않아도 여기서 전부 걸린다.
//              (이력을 훑어 원본과 대조하는 가드를 agent.js에 따로 두었었지만, 걸러내는 값이
//               이 판정과 완전히 겹치면서 스텝마다 O(이력 × 행 × 컬럼) 스캔만 더하고 있었다.)
//              길이는 isClippedLen이 정한다 — '이상'이 아니라 '그 길이들'만 본다.
//              '이상'으로 잡으면 질문에서 온 정당한 긴 값(자유 검색어·경로·연결 키)까지 영구히 거부돼
//              그 입력으로는 등록 쿼리를 아예 실행할 수 없게 된다.
// 주의: `WHERE (:opt IS NULL OR col = :opt)` 같은 선택적 필터 패턴은 이 가드에 걸린다 —
// 그런 쿼리는 '전체'를 뜻하는 별도 센티널 값(예: 'ALL')을 쓰도록 등록할 것.
// clipText가 남기는 절단 길이. 보통 MAX_CELL_LEN이지만, 절단 경계가 서로게이트 쌍(이모지 등)을
// 가르면 짝 잃은 상위 서로게이트 하나를 더 떼므로 MAX_CELL_LEN-1이 된다.
// 이 한 칸을 빼놓으면 그 셀에서만 가드가 조용히 빠진다 — 실측: 199자 + 이모지 셀의 잘린
// 앞부분은 200자가 아니라 199자여서, 마크를 뗀 조각이 그대로 바인드되고 조회가 0건이 된다.
// 모델은 그 0건을 "그런 데이터가 없다"로 읽으므로 오류 하나 없이 확신에 찬 오답이 나가고,
// 하필 이모지가 든 셀에서만 재현되어 원인을 잡기 어렵다.
// 늘어나는 오탐은 '정확히 MAX_CELL_LEN-1자인 정당한 값' 하나뿐이다 — MAX_CELL_LEN자를 이미
// 거부하기로 한 것과 같은 성격·같은 크기의 대가라, 위 주석의 판단이 그대로 적용된다.
const isClippedLen = n => n === MAX_CELL_LEN || n === MAX_CELL_LEN - 1;

function bindProblem(v) {
  if (v === undefined || v === null || v === '') return '값 없음';
  // boolean은 '값이 아닌 구조'와 다른 이유로 거부한다: 모양은 스칼라지만 node-oracledb가
  // Oracle 23ai 미만에 바인드할 수 없는 타입이다(DB_TYPE_BOOLEAN 바인딩은 23ai부터).
  // 통과시키면 접속을 열고 세션 포맷까지 건 뒤 conn.execute 안에서 드라이버 원문 오류로 죽는데,
  // safeError가 아니라 사용자에게는 '조회 중 오류가 발생했습니다'만 나가고 모델에게도 단서가 없다 —
  // 스텝 하나와 Oracle 접속 왕복 한 번을 매번 버린다. ':active = 활성 여부'처럼 설명된 바인드에
  // 모델이 true/false를 채우는 것은 지극히 자연스러운 완성이라 실제로 들어온다.
  // 여기서 소리 나게 실패시켜야 모델이 컬럼에 실제로 저장된 값('Y'/'N', 1/0)으로 고쳐 잡는다.
  // 대가: Oracle 23ai의 진짜 BOOLEAN 컬럼에 true/false를 바인드하는 등록도 함께 막힌다.
  // 서버 버전은 이 시점에 알 수 없고(가드는 접속 전에 돈다), 압도적으로 흔한 쪽은 'Y'/'N' 컬럼에
  // 모델이 true를 지어내는 경우다. 23ai 전용 BOOLEAN 바인드가 필요해지면 등록 SQL에서
  // DECODE(:flag,'Y',TRUE,FALSE) 같은 변환을 쓰거나, target_db에 서버 버전을 두고 여기서 갈라야 한다.
  if (typeof v === 'boolean') return "true/false는 바인드할 수 없음 — 컬럼에 저장된 값(예: 'Y'/'N', 1/0)으로 지정할 것";
  if (typeof v !== 'string' && typeof v !== 'number') return '값이 아닌 구조';
  if (typeof v === 'string' && (v.endsWith(TRUNC_MARK) || isClippedLen(v.length))) {
    return '잘린 값이라 원본과 다름';
  }
  return null;
}

// 'ENV:변수명' 형식이면 서버 환경변수에서 읽는다. 평문은 개발용으로만 허용.
// 변수가 비어 있으면 빈 비밀번호로 접속을 시도하지 않고 여기서 멈춘다 —
// 시도하면 DB는 ORA-01017(잘못된 사용자명/비밀번호)을 돌려주고, 운영자는 설정 누락이 아니라
// 저장된 자격증명이 틀렸다고 읽는다. 게다가 빈 비밀번호 로그인이 매 조회마다 반복되면
// 공용 조회 계정이 FAILED_LOGIN_ATTEMPTS에 걸려 잠긴다.
// 접두사 판정은 대소문자를 가리지 않는다 — 'env:'로 등록하면 그 문자열 자체가 비밀번호로 전송돼
// 매 조회마다 ORA-01017이 나고, 바로 위 주석이 막으려던 계정 잠금(FAILED_LOGIN_ATTEMPTS)이
// 그대로 재현된다. 게다가 오류 원문은 화면에 나가지 않으므로 원인이 보이지 않는다.
const ENV_PREFIX = /^\s*env:/i;

function resolvePassword(stored) {
  if (typeof stored === 'string' && ENV_PREFIX.test(stored)) {
    const name = stored.replace(ENV_PREFIX, '').trim();
    const value = process.env[name];
    if (!value) throw safeError(`조회대상 DB 비밀번호 환경변수(${name})가 설정되지 않았습니다.`);
    return value;
  }
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

const MOCK_CUSTOMERS = [
  { CUSTOMER_ID: 'C-1001', CUSTOMER_NAME: '홍길동', GRADE: 'VIP' },
  { CUSTOMER_ID: 'C-1002', CUSTOMER_NAME: '김철수', GRADE: 'GOLD' },
  { CUSTOMER_ID: 'C-1003', CUSTOMER_NAME: '이영희', GRADE: 'SILVER' },
];

const MOCK_ORDERS = [
  { ORDER_ID: 'O-777', CUSTOMER_ID: 'C-1001', STATUS: '배송중',   ORDER_DATE: '2026-08-27', AMOUNT: 128000 },
  { ORDER_ID: 'O-778', CUSTOMER_ID: 'C-1001', STATUS: '결제완료', ORDER_DATE: '2026-08-25', AMOUNT: 45000 },
  { ORDER_ID: 'O-779', CUSTOMER_ID: 'C-1001', STATUS: '배송완료', ORDER_DATE: '2026-08-20', AMOUNT: 233000 },
  { ORDER_ID: 'O-801', CUSTOMER_ID: 'C-1002', STATUS: '배송완료', ORDER_DATE: '2026-08-26', AMOUNT: 71000 },
  { ORDER_ID: 'O-802', CUSTOMER_ID: 'C-1003', STATUS: '주문접수', ORDER_DATE: '2026-08-29', AMOUNT: 19900 },
];

// 등록 SQL(seed.sql)과 같은 비교·정렬·출력 컬럼을 쓴다. 출력 컬럼이 하나라도 다르면
// mock으로 검증한 시나리오가 실제 배포에서 그대로 재현되지 않는다 — 없는 컬럼을 근거로 답하거나
// (mock에만 있는 CUSTOMER_ID), 있는 컬럼을 못 쓰거나(실제에만 있는 AMOUNT) 한다.
// Oracle 문자열 비교는 대소문자를 구분하므로 mock도 구분한다 — mock에서만 통과하는
// 파라미터(status:'failed' 등)가 실제 DB에서 0건이 되는 것을 데모 단계에서 드러내기 위함.
const pick = (row, cols) => Object.fromEntries(cols.map(c => [c, row[c]]));

const MOCK_DATA = {
  // SELECT JOB_ID, JOB_NAME, STATUS, LAST_RUN_AT ... WHERE JOB_ID = :job_id
  batch_job_status: p => MOCK_JOBS
    .filter(j => j.JOB_ID === p.job_id)
    .map(j => pick(j, ['JOB_ID', 'JOB_NAME', 'STATUS', 'LAST_RUN_AT'])),
  // seed의 '경로B 데모' 쿼리 (qa_method 없이 query_desc만으로 선택된다)
  // SELECT JOB_ID, JOB_NAME, LAST_RUN_AT ... WHERE STATUS = :status ORDER BY LAST_RUN_AT DESC
  batch_list_by_status: p => MOCK_JOBS
    .filter(j => j.STATUS === p.status)
    .sort((a, b) => b.LAST_RUN_AT.localeCompare(a.LAST_RUN_AT))
    .map(j => pick(j, ['JOB_ID', 'JOB_NAME', 'LAST_RUN_AT'])),
  // SELECT CUSTOMER_ID, CUSTOMER_NAME, GRADE ... WHERE CUSTOMER_NAME = :customer_name
  find_customer_id: p => MOCK_CUSTOMERS
    .filter(c => c.CUSTOMER_NAME === p.customer_name)
    .map(c => pick(c, ['CUSTOMER_ID', 'CUSTOMER_NAME', 'GRADE'])),
  // SELECT ORDER_ID, STATUS, ORDER_DATE, AMOUNT ... WHERE CUSTOMER_ID = :customer_id
  //   ORDER BY ORDER_DATE DESC FETCH FIRST 5 ROWS ONLY
  order_status_by_customer: p => MOCK_ORDERS
    .filter(o => o.CUSTOMER_ID === p.customer_id)
    .sort((a, b) => b.ORDER_DATE.localeCompare(a.ORDER_DATE))
    .slice(0, 5)
    .map(o => pick(o, ['ORDER_ID', 'STATUS', 'ORDER_DATE', 'AMOUNT'])),
  // 바인드 없는 쿼리 (params를 보지 않는다)
  // SELECT TO_CHAR(SYSTIMESTAMP AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS TODAY, … AS NOW_TIME FROM DUAL
  // 등록 SQL이 KST로 고정되어 있으므로 mock도 프로세스 로컬 시각이 아니라 KST로 맞춘다 —
  // 다른 타임존 노트북에서 mock으로 검증한 답이 실제 실행과 하루 어긋나지 않도록.
  // 위 고정 데이터와 달리 이 값만 실행할 때마다 달라진다 — 원래 그런 쿼리이므로 고정하지 않는다.
  today_date: () => {
    // sv-SE 로케일이 'YYYY-MM-DD HH:MM:SS' 형식을 준다 (등록 SQL의 출력 형식과 같다)
    const [TODAY, NOW_TIME] = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium',
    }).format(new Date()).split(' ');
    return [{ TODAY, NOW_TIME }];
  },
};

// MOCK_DATA 키는 소문자다. query_registry.query_name은 MariaDB collation상 대소문자를 구분하지 않아
// 'Batch_Job_Status'로 등록해도 다른 경로는 모두 정상 동작하므로, 여기만 대소문자를 구분하면
// 철자 하나 때문에 데모 시나리오가 'mock 데이터 미정의'로 죽는다.
function mockResult(queryName, params) {
  // 소유 키만 본다 (constants.ownProp) — 'constructor'나 '__proto__' 같은 이름이 프로토타입 체인을
  // 타면 !gen 가드를 지나쳐 함수가 아닌 값을 호출하다 unsafe TypeError로 죽는다
  // (safe 안내 대신 일반 오류 문구가 나간다).
  const key = nameKey(queryName);
  const gen = ownProp(MOCK_DATA, key);
  if (!gen) throw safeError(`mock 데이터가 정의되지 않은 쿼리: ${queryName}`);
  return gen(params);
}
