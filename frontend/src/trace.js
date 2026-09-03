// 화면 trace 패널(실행된 쿼리와 조회된 행)의 계약 — 열 고르기·셀 표기·CSV 만들기.
// App.jsx가 아니라 여기 있는 이유는 chart.js와 같다: 순수 함수라 node:test로 회귀 테스트가 붙는다.
// CSV는 사용자가 결과를 다른 도구로 가져가는 출구다 — 셀 하나가 조용히 옆 열로 밀리면 그 파일로
// 한 일이 전부 틀어지고, 그것을 알려 주는 오류는 없다.

// 한 스텝의 '건수' 자리에 놓을 문구. 실행되지 못한 스텝은 건수가 아니라 오류를 말한다 —
// 그 갈래를 화면에서 가르면 오류 줄만 임자 없는 글자로 남아, 검사도 픽스처도 그것을 베껴 적게 된다
// (그러면 문구를 다듬은 날 앱은 맞는데 검사가 깨지거나, 앱이 내지도 않는 글자를 검사가 보증한다).
// 스텝은 있어야 한다. 없는 것을 받으면 여기서 무슨 말인지 밝히고 멈춘다 — 조용히 넘기면 아래
// countLabel이 없는 값을 만지다 'rows를 읽을 수 없다'로 죽고, 그 말은 임자(없는 스텝을 집은 부르는
// 쪽)가 아니라 이 파일을 가리킨다. 실제로 픽스처가 스텝 하나를 find로 집어 온다(test/ui/fixtures.js).
export const stepLabel = t => {
  if (!t) throw new TypeError('stepLabel: 스텝이 없습니다 — 부르는 쪽이 없는 스텝을 집었습니다');
  return t.error ? `오류: ${t.error}` : countLabel(t);
};

// 조회 건수 문구. 조회 건수와 실린 행 수는 다를 수 있다 — 몇 건을 보고 있는지 밝히지 않으면
// 사용자가 실린 것을 전부로 읽는다 (서버 result.js clientTrace가 omittedRows·capped를 준다).
export function countLabel(t) {
  const n = t.rows?.length ?? 0;
  // rowCount는 서버가 늘 준다(result.js clientTrace). 없으면 실린 행 수로 말한다 — 'undefined건'은
  // 화면에 나가서는 안 되는 글자이고, 이 패널의 다른 값들도 모두 없을 때를 정해 두고 있다.
  if (t.rowCount === undefined) return `${n}건`; // 몇 건 중 몇 건인지 말할 근거가 없다
  // 상한에 걸린 것과 실린 행이 일부인 것은 함께 올 수 있다(서버 result.js) — 그때 둘 중 하나만
  // 말하면 '왜 이만큼뿐인가'의 절반이 사라진다.
  // 상한에 걸린 rowCount는 서버가 '1000+'처럼 준다(result.js) — 같은 패널에서 '건 이상'과 '+건'이
  // 섞이지 않게 여기서도 같은 말로 푼다.
  if (t.capped && t.omittedRows) return `${String(t.rowCount).replace(/\+$/, '')}건 이상 — 조회 상한에 걸렸고, 아래는 그중 ${n}건입니다`;
  if (t.omittedRows) return `${t.rowCount}건 (아래는 그중 ${n}건)`;
  if (t.capped) return `${n}건 이상 — 조회 상한에 걸려 처음 ${n}건만 가져왔습니다`;
  return `${t.rowCount}건`;
}

// 행들의 열 이름 — 첫 등장 순서. 드라이버가 준 행은 열이 모두 같지만(oracle.js normalizeCells),
// 다른 출처의 trace가 섞여도 한 행에만 있는 열이 빠지지 않게 합집합으로 모은다.
export function columnsOf(rows) {
  const cols = [];
  const seen = new Set();
  for (const r of rows ?? []) {
    if (!r || typeof r !== 'object') continue;
    for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  }
  return cols;
}

// 셀의 표기. null·undefined는 빈칸(문자열 'null'이 값처럼 보이지 않게), 숫자는 그대로,
// 객체가 오면(드라이버 경계가 막지만) JSON으로 — [object Object]로 뭉개지지 않게.
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

// 스프레드시트가 수식으로 읽는 첫 글자(= @ 탭 CR + -)로 시작하는 문자열은 앞에 '를 붙여 글자로 고정한다 —
// DB의 자유 텍스트(VOC 본문 등)가 파일을 연 사람의 PC에서 수식으로 실행되지 않게. 숫자 셀은 문자열이
// 아니므로 -5 같은 값은 건드리지 않고, 문자열이라도 통째로 숫자 표기인 것('-5', 16자리 넘어 문자열로 온
// NUMBER)과 '-' 하나뿐인 값('없음' 표시로 흔하다)은 그대로 둔다 — 스프레드시트도 그것은 수식이 아니라
// 숫자·글자로 읽는다. '+82-10-1234-5678' 같은 전화번호는 예외가 아니다: '+'로 시작하는 문자열을 엑셀은
// 수식으로 읽어 82-10-1234-5678 = -6840을 보여주고, '-abc'는 #NAME? 오류가 된다.
const FORMULA_START = /^[=@\t\r+-]/;
const NOT_FORMULA = /^(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[+-])$/i;
const guardFormula = (v, s) => typeof v === 'string' && FORMULA_START.test(s) && !NOT_FORMULA.test(s) ? `'${s}` : s;

// RFC 4180: 쉼표·따옴표·줄바꿈이 든 값은 따옴표로 감싸고 따옴표는 두 번 쓴다. 앞에 BOM을 붙인다 —
// 엑셀은 BOM 없는 UTF-8 CSV를 로캘 인코딩으로 읽어 한글을 깨뜨린다.
export function toCsv(rows, cols = columnsOf(rows)) {
  const field = v => {
    const s = guardFormula(v, cellText(v));
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const line = vals => vals.map(field).join(',');
  return '﻿' + [line(cols), ...(rows ?? []).map(r => line(cols.map(c => r?.[c])))].join('\r\n') + '\r\n';
}

// 내려받을 파일 이름. 쿼리 이름은 등록자가 정한 문자열이라 파일 이름에 못 쓰는 글자가 섞일 수 있다.
export function csvFileName(name, targetDb) {
  const base = `${name || 'result'}${targetDb ? `@${targetDb}` : ''}`.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim();
  return `${base || 'result'}.csv`;
}
