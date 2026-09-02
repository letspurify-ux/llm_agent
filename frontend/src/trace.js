// 화면 trace 패널(실행된 쿼리와 조회된 행)의 계약 — 열 고르기·셀 표기·CSV 만들기.
// App.jsx가 아니라 여기 있는 이유는 chart.js와 같다: 순수 함수라 node:test로 회귀 테스트가 붙는다.
// CSV는 사용자가 결과를 다른 도구로 가져가는 출구다 — 셀 하나가 조용히 옆 열로 밀리면 그 파일로
// 한 일이 전부 틀어지고, 그것을 알려 주는 오류는 없다.

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
