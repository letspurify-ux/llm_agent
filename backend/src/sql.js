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
const Q_CLOSER = { '[': ']', '{': '}', '(': ')', '<': '>' };
const isIdentChar = c => c !== undefined && /[A-Za-z0-9_$#]/.test(c);

function scanSql(sql) {
  const s = String(sql ?? '');
  let out = '';
  let i = 0;
  let unterminated = false;

  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];

    if (c === '-' && next === '-') {                    // 한 줄 주석
      const nl = s.indexOf('\n', i);
      out += ' ';
      i = nl < 0 ? s.length : nl;                       // 개행은 남긴다
      continue;
    }
    if (c === '/' && next === '*') {                    // 블록 주석
      const end = s.indexOf('*/', i + 2);
      out += ' ';
      if (end < 0) { unterminated = true; i = s.length; } else { i = end + 2; }
      continue;
    }
    if ((c === 'q' || c === 'Q') && next === "'" && isQuoteStart(s, i)) {
      const delim = s[i + 2];
      if (delim === undefined) { unterminated = true; out += ' '; break; }
      const close = (Q_CLOSER[delim] ?? delim) + "'";
      const end = s.indexOf(close, i + 3);
      out += ' ';
      if (end < 0) { unterminated = true; i = s.length; } else { i = end + close.length; }
      continue;
    }
    if (c === '"') {                                    // 따옴표 식별자 ("a'b" 처럼 아포스트로피를 담을 수 있다)
      const end = s.indexOf('"', i + 1);
      out += ' ';
      if (end < 0) { unterminated = true; i = s.length; } else { i = end + 1; }
      continue;
    }
    if (c === "'") {                                    // 일반 문자열 ('' 는 이스케이프된 따옴표)
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] !== "'") continue;
        if (s[j + 1] === "'") { j++; continue; }
        break;
      }
      out += ' ';
      if (j >= s.length) { unterminated = true; i = s.length; } else { i = j + 1; }
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
export function bindNames(sql) {
  return [...new Set([...stripNoise(sql).matchAll(/:(\w+)/g)].map(m => m[1]))];
}

// 조회 전용 가드: 의도치 않은 UPDATE/DELETE/DDL 실행 방지.
// (1) 리터럴·주석 제거 후 SELECT 또는 WITH로 시작하는 문장만 허용 (Oracle의 WITH는 조회 전용)
// (2) 세미콜론이 포함된 다중 문장 금지
// (3) 닫히지 않은 리터럴/주석은 거부 — 경계를 확정할 수 없으면 (1)(2)를 신뢰할 수 없다
// 추가로 target_db의 계정 자체를 read-only 권한으로 만드는 것을 권장한다 (README 참고).
export function assertReadOnly(sql) {
  // 리터럴도 함께 지운다 — LISTAGG(name, '; ')처럼 값에 든 세미콜론을 다중 문장으로 오판하지 않도록
  const { text, unterminated } = scanSql(sql);
  if (unterminated) {
    throw new Error('닫히지 않은 문자열 리터럴 또는 주석이 있어 실행할 수 없습니다.');
  }
  const s = text.trim();
  if (!/^(SELECT|WITH)\b/i.test(s)) {
    throw new Error('조회(SELECT) 쿼리만 실행할 수 있습니다.');
  }
  if (s.replace(/;\s*$/, '').includes(';')) {
    throw new Error('다중 문장 쿼리는 실행할 수 없습니다.');
  }
}
