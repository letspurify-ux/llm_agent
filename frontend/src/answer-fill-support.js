// answer-fill.js(답변의 ```table·```chart 참조 채우기)가 쓰는 작은 도구들.
// 채우기는 예전에 backend(Node)에서 했고, 이 함수들은 그쪽 constants.js·result.js에 있던 것을 그대로 옮겼다.
// 이제 backend(Rust)는 조회 행을 done.trace·refs로 내려 주고 채우기는 화면이 한다 — 답변을 그리는
// 파서(micromark)와 블록을 찾는 파서가 같아야 참조가 어긋나지 않기 때문이다.

// 잘린 값의 표시. backend의 셀 절단 표시와 같은 글자다 — 모델이 이 표시로 끝나는 값을
// 바인드로 옮겨 적지 않도록 서버가 같은 표시를 거부한다.
export const TRUNC_MARK = '…(생략)';

// 길이 상한으로 자른다. 상한이 음수면 아무것도 남기지 않고, 짝 잃은 상위 서로게이트로 끝나지 않게 한다.
export function clipText(s, max) {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export const ownProp = (obj, key) => (Object.hasOwn(obj ?? {}, key) ? obj[key] : undefined);

// 컬럼명·쿼리명 비교 키 — 앞뒤 공백과 대소문자를 무시한다.
export const nameKey = s => String(s ?? '').trim().toLowerCase();

// 넓은 결과에서 잘라낸 열의 안내가 든 키. 실제 컬럼 이름이 '…'일 수도 있어 이름이 아니라
// 이 표지로 판정한다. 서버는 그 키를 trace 스텝의 omittedColumnKey로 알려 주고,
// attachColumnOmission이 행에 다시 붙인다(JSON을 지나며 표지는 사라진다).
const COLUMN_OMISSION = Symbol('column omission');
export const columnOmissionKey = row => row?.[COLUMN_OMISSION];

export function attachColumnOmission(row, key) {
  if (row && typeof row === 'object' && typeof key === 'string' && Object.hasOwn(row, key)) {
    Object.defineProperty(row, COLUMN_OMISSION, { value: key });
  }
  return row;
}
