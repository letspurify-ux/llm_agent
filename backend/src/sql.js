// SQL 어휘 분석 및 조회 전용 가드.
// oracle.js에서 분리한 이유: 바인드 추출(bindNames)은 프롬프트 조립(llm.js)에서도 필요한데,
// oracle.js에 두면 프롬프트 모듈이 네이티브 드라이버(oracledb)와 그 전역 설정까지 끌어오게 된다.
//
// 문자열 리터럴과 주석을 공백으로 지운 SQL — 둘 다 "코드가 아닌 부분"이므로
// 바인드 추출과 조회 전용 가드가 같은 기준을 봐야 한다.
// 정규식이 아니라 단일 패스 스캐너인 이유: Oracle q-quote는 구분자로 임의의 문자를 쓸 수 있어
// (q'!...!', q'#...#') 정규식으로 일부 구분자만 모델링하면 나머지에서 리터럴 경계가 어긋난다.
// 어긋나면 리터럴 안의 세미콜론이 코드로 보이거나(정상 쿼리 오탐), 반대로 진짜 문장 구분자가
// 리터럴에 삼켜져 조회 전용 가드를 통과한다(가드 우회). 경계 판정은 정확해야 한다.
// 다루는 어휘: 한 줄/블록 주석, q-quote(임의 구분자 + 괄호쌍), 일반 문자열('' 이스케이프),
// 따옴표 식별자("..."). 이 중 하나라도 빠지면 그 뒤의 스캔이 통째로 어긋난다.
import { safeError } from './constants.js';

const Q_CLOSER = { '[': ']', '{': '}', '(': ')', '<': '>' };
const isIdentChar = c => c !== undefined && /[A-Za-z0-9_$#]/.test(c);

// 지운 구간은 '같은 길이의 공백'으로 채운다 — text의 인덱스가 원문과 1:1로 맞는다.
// 그래야 가드가 승인한 지점(후행 세미콜론)을 원문에서 정확히 집어낼 수 있다 (assertReadOnly 참고).
// 길이를 보존해도 토큰 경계는 유지된다: 리터럴·주석은 최소 두 글자라 공백이 최소 한 칸은 남는다.
const blank = n => ' '.repeat(n);

function scanSql(sql) {
  const s = String(sql ?? '');
  let out = '';
  let i = 0;
  let unterminated = false;
  const skip = end => { out += blank(end - i); i = end; };
  // 경계를 찾지 못한 어휘 — 남은 전부를 지우고 끝낸다 (경계 미확정 SQL은 호출부가 거부한다)
  const cut = () => { unterminated = true; skip(s.length); };

  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];

    if (c === '-' && next === '-') {                    // 한 줄 주석
      const nl = s.indexOf('\n', i);
      skip(nl < 0 ? s.length : nl);                     // 개행은 남긴다
      continue;
    }
    if (c === '/' && next === '*') {                    // 블록 주석
      const end = s.indexOf('*/', i + 2);
      if (end < 0) cut(); else skip(end + 2);
      continue;
    }
    if ((c === 'q' || c === 'Q') && next === "'" && isQuoteStart(s, i)) {
      const delim = s[i + 2];
      if (delim === undefined) { cut(); continue; }
      const close = (Q_CLOSER[delim] ?? delim) + "'";
      const end = s.indexOf(close, i + 3);
      if (end < 0) cut(); else skip(end + close.length);
      continue;
    }
    if (c === '"') {                                    // 따옴표 식별자 ("a'b" 처럼 아포스트로피를 담을 수 있다)
      const end = s.indexOf('"', i + 1);
      if (end < 0) cut(); else skip(end + 1);
      continue;
    }
    if (c === "'") {                                    // 일반 문자열 ('' 는 이스케이프된 따옴표)
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] !== "'") continue;
        if (s[j + 1] === "'") { j++; continue; }
        break;
      }
      if (j >= s.length) cut(); else skip(j + 1);
      continue;
    }
    out += c;
    i++;
  }
  return { text: out, unterminated };
}

// q'…' 의 q가 식별자의 일부가 아닌지 확인한다 (freq'x' 는 q-quote가 아니다).
// nq'…'(national q-quote)는 허용하므로 앞 글자가 n/N이면 그 앞을 본다.
function isQuoteStart(s, i) {
  const prev = s[i - 1];
  return (prev === 'n' || prev === 'N') ? !isIdentChar(s[i - 2]) : !isIdentChar(prev);
}

const stripNoise = sql => scanSql(sql).text;

// query_sql에서 :bind 변수명 추출.
// 리터럴의 TO_CHAR(D, 'HH24:MI')나 주석 속 ':name'이 바인드로 잡히면 안 되므로 둘 다 지운 뒤 찾는다.
//
// 결과를 캐시한다: 같은 query_sql이 요청 하나 안에서 반복해 들어온다 —
// 프롬프트 조립은 스텝마다 쿼리 목록 전체(최대 35건)에 대해 다시 부르므로 요청당 최대 175회이고,
// 파싱은 SQL 전체를 도는 문자 단위 스캐너다. agent.js가 같은 이유로 '스텝당 1회만 파싱'이라고
// 손으로 캐시해 두었는데, 캐시를 함수 안에 두면 호출부마다 그 요령을 반복할 필요가 없다.
// 키가 외부에서 온 문자열이므로 상한을 두고 가장 오래 '안 쓴' 것부터 밀어낸다
// (Map은 삽입 순서를 지키므로, 적중할 때마다 맨 뒤로 다시 넣으면 그 순서가 곧 LRU가 된다).
// 돌려주는 배열은 freeze한다 — 캐시된 같은 배열을 여러 호출부가 나눠 쓰므로 한 곳의 변형이
// 다른 곳으로 번지면 안 된다.
const bindCache = new Map();
const BIND_CACHE_MAX = 500;

// 바인드 '후보' = ':' 뒤에 이어지는 Oracle 식별자 문자열.
// \w+ 로 잡으면 안 된다: \w는 [A-Za-z0-9_]라 '$'·'#'이 든 이름(EMP$NO, TAB#ID — 둘 다 적법한
// Oracle 식별자다)을 앞에서 잘라 ':emp'로 만든다. 그 잘린 이름이 프롬프트에 실리고 모델은 그것으로
// params를 채우므로, 실행 단계에서 드라이버가 진짜 바인드(:emp$no)의 값을 찾지 못해
// NJS-098/ORA-01008로 죽는다 — 드라이버 원문이라 화면에는 '조회 중 오류' 한 줄만 나가고
// (server.js가 원문을 숨긴다) 그 쿼리는 등록된 채로 영원히 실행되지 않는다.
// 같은 파일 안에서 식별자 판정이 두 갈래로 갈라져 있던 것이 원인이다.
const BIND_RE = /:([A-Za-z0-9_$#]+)/g;

// 후보 중 '이 실행기가 실제로 바인드할 수 있는 이름'의 규칙 — Oracle 비인용 식별자와 같다:
// 반드시 영문자로 시작한다. 이 판정이 없으면 위 후보 정규식이 위치 바인드(:1)까지 이름으로 잡아
// bindNames가 '1'을 돌려주고, 프롬프트는 '바인드(:1)'을 보여주며, 모델은 params {"1": …}을 채운다.
// 그런데 node-oracledb는 위치 바인드에 '객체'가 아니라 '배열'을 요구하므로 conn.execute가
// NJS-098/ORA-01008로 죽는다 — 드라이버 원문이라 화면에는 '조회 중 오류' 한 줄만 나가고,
// 그 쿼리는 등록된 채로 영원히 실행되지 않는다. (JDBC/PL-SQL 원본을 옮겨 적으면 자연히 나오는 표기다)
const isExecutableBind = n => /^[A-Za-z]/.test(n);
const bindCandidates = text => [...new Set([...text.matchAll(BIND_RE)].map(m => m[1]))];

export function bindNames(sql) {
  const hit = bindCache.get(sql);
  if (hit) {
    // 적중한 항목을 맨 뒤로 옮긴다 — 삽입 순서만 보고 밀어내면(FIFO) 활성 SQL이 상한을 넘는
    // 순간 '방금 쓴 항목'부터 차례로 밀려나, 캐시가 가득 찬 채로 적중률이 0에 수렴한다.
    // 오류는 나지 않고 요청마다 같은 SQL을 다시 파싱하는 비용만 조용히 되돌아온다.
    bindCache.delete(sql);
    bindCache.set(sql, hit);
    return hit;
  }
  const names = Object.freeze(bindCandidates(stripNoise(sql)).filter(isExecutableBind));
  while (bindCache.size >= BIND_CACHE_MAX) bindCache.delete(bindCache.keys().next().value);
  bindCache.set(sql, names);
  return names;
}

// 조회 전용 가드: 의도치 않은 UPDATE/DELETE/DDL 실행 방지.
// (1) 리터럴·주석 제거 후 SELECT 또는 WITH로 시작하는 문장만 허용 (Oracle의 WITH는 조회 전용)
// (2) 세미콜론이 포함된 다중 문장 금지
// (3) 닫히지 않은 리터럴/주석은 거부 — 경계를 확정할 수 없으면 (1)(2)를 신뢰할 수 없다
// 추가로 target_db의 계정 자체를 read-only 권한으로 만드는 것을 권장한다 (README 참고).
//
// 통과하면 '실행용 SQL'을 돌려준다 — 호출부는 원문이 아니라 이 값을 실행해야 한다.
// 가드와 실행이 각자 문자열을 손보면 둘의 판단이 갈라진다. 실제로 갈라져 있었다: 가드는 주석을
// 지운 뒤 후행 ';'를 단일 문장으로 인정하는데 실행부는 원문에 /;\s*$/를 걸어, `SELECT … ; -- 메모`
// 처럼 ';' 뒤에 주석이 붙으면 정규식이 매치되지 않아 ';'가 남은 채 드라이버로 나갔다.
// 그 결과가 서버 버전에 좌우된다는 점이 특히 나쁘다 — Oracle 23ai는 후행 ';'를 그냥 받아주지만
// (실측: 23.26에서 `SELECT 1 FROM DUAL;`도 `; -- 주석`도 통과) 19c 이하는 ORA-00911로 거부한다.
// 개발 컨테이너에서는 멀쩡하다가 운영 DB에서만 죽고, 그 오류는 드라이버 원문이라 화면에는
// '조회 중 오류' 한 줄만 나가 원인이 보이지 않는다.
// 승인한 쪽이 실행할 형태까지 함께 돌려주면 그 어긋남이 구조적으로 불가능해진다.
export function assertReadOnly(sql) {
  // 리터럴도 함께 지운다 — LISTAGG(name, '; ')처럼 값에 든 세미콜론을 다중 문장으로 오판하지 않도록
  const { text, unterminated } = scanSql(sql);
  if (unterminated) {
    throw safeError('닫히지 않은 문자열 리터럴 또는 주석이 있어 실행할 수 없습니다.');
  }
  const s = text.trim();
  // 여는 괄호는 건너뛰고 첫 키워드를 본다 — `(SELECT …) FETCH FIRST n ROWS ONLY`처럼
  // 괄호로 시작하는 정상 조회 쿼리가 '조회가 아니다'로 거부되던 것을 막는다.
  // 괄호를 걷어낸 뒤에도 SELECT/WITH만 허용하므로 DML은 그대로 걸린다.
  if (!/^(SELECT|WITH)\b/i.test(s.replace(/^[(\s]+/, ''))) {
    throw safeError('조회(SELECT) 쿼리만 실행할 수 있습니다.');
  }
  if (s.replace(/;\s*$/, '').includes(';')) {
    throw safeError('다중 문장 쿼리는 실행할 수 없습니다.');
  }
  // (4) SELECT … FOR UPDATE 금지 — 조회 문장이지만 조회대상 DB의 행에 잠금을 건다.
  // 위 (1)은 '첫 키워드가 SELECT인가'만 보므로 이 문장은 그대로 통과한다. LLM은 SQL을 만들지
  // 못하니 들어오는 경로는 등록 실수뿐인데, 등록 실수를 잡는 것이 이 가드의 존재 이유다.
  // 잠금은 트랜잭션이 끝날 때까지 유지되고 이 실행기는 조회마다 접속을 여닫으므로(oracle.js),
  // 잠긴 행을 기다리는 쪽은 운영 트랜잭션이 된다 — 그런데 화면에는 '조회 중 오류' 한 줄만 남아
  // (server.js가 드라이버 원문을 숨긴다) 조회 Q&A가 원인이라는 사실 자체가 보이지 않는다.
  // 리터럴·주석은 위에서 이미 지워졌고 FOR는 Oracle 예약어라 식별자로 쓸 수 없다 — 오탐 경로가 없다.
  // FOR UPDATE OF/NOWAIT/SKIP LOCKED는 전부 이 접두에서 걸린다.
  if (/\bFOR\s+UPDATE\b/i.test(s)) {
    throw safeError('행 잠금을 거는 쿼리(FOR UPDATE)는 실행할 수 없습니다.');
  }
  // (5) 이 실행기가 바인드할 수 없는 표기 금지 — 위치 바인드(:1)와 영문자로 시작하지 않는 이름.
  // bindNames가 걸러내기만 하면 그 쿼리는 '바인드가 없는 쿼리'로 보여 드라이버까지 내려가고,
  // 거기서 ORA-01008(값이 바인드되지 않음)로 죽는다 — 드라이버 원문은 화면에서 가려지므로
  // 사용자도 모델도 원인을 볼 수 없고, 그 쿼리는 등록된 채 영원히 실행되지 않는다.
  // FOR UPDATE와 같은 성격의 등록 실수이므로 같은 자리에서 같은 방식으로, 소리 나게 거부한다.
  const unsupported = bindCandidates(text).filter(n => !isExecutableBind(n));
  if (unsupported.length) {
    throw safeError(
      `실행할 수 없는 바인드 표기입니다: ${unsupported.map(n => `:${n}`).join(', ')} ` +
      '— 바인드명은 영문자로 시작해야 합니다 (위치 바인드 :1은 지원하지 않습니다).'
    );
  }
  return executableSql(String(sql ?? ''), text);
}

// 가드가 허용한 후행 세미콜론을 원문에서 떼어낸다(공백으로 바꾼다).
// Oracle 19c 이하는 SQL 문장 끝의 ';'를 ORA-00911로 거부한다 — 등록 표기로 허용하기로 했으면
// 실행까지 허용해야 한다. 23ai처럼 받아주는 서버에서도 떼어내는 편이 안전하다(동작이 같아진다).
// 위치는 스캔 결과에서 찾는다 — text는 원문과 길이·인덱스가 같고 리터럴·주석은 공백으로 지워져
// 있으므로, "마지막 코드 문자가 ';'인가"가 곧 "문장 끝의 세미콜론인가"다.
// 정규식으로 원문을 직접 자르지 않는 이유가 이것이다: ';' 뒤에 주석이 붙으면 /;\s*$/는 매치되지
// 않고, 반대로 리터럴 끝의 ';'를 매치할 수도 있다. 경계 판정은 스캐너 한 곳에서만 한다.
// 잘라내지 않고 공백으로 바꾸는 이유: 뒤에 남은 주석은 Oracle이 그대로 받아들이고,
// 인덱스를 보존하면 오류 메시지의 문자 위치가 등록 SQL과 계속 일치한다.
function executableSql(raw, text) {
  const last = text.trimEnd().length - 1;   // 마지막 코드 문자의 인덱스 (원문과 같다)
  return last >= 0 && text[last] === ';'
    ? `${raw.slice(0, last)} ${raw.slice(last + 1)}`
    : raw;
}
