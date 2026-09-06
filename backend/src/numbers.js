// DB 결과와 LLM JSON의 숫자 정밀도 판정을 공유한다. 드라이버 의존성이 없는 순수 변환이다.
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
