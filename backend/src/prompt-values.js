// 프롬프트에 표시한 값과 실행 가드가 기억하는 절단 조각은 같은 변환을 사용한다.
import { MAX_CELL_LEN, MAX_PROMPT_PARAMS_LEN, TRUNC_MARK, clipText } from './constants.js';

// 드라이버에서 이미 잘린 셀은 표시와 앞부분을 그대로 유지한다.
const MAX_DISPLAY_VALUE_LEN = MAX_CELL_LEN + TRUNC_MARK.length;
export const clipDisplayValue = v => {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  return s.length > MAX_DISPLAY_VALUE_LEN ? clipText(s, MAX_DISPLAY_VALUE_LEN) + TRUNC_MARK : s;
};

// JSON 전체를 slice하면 마지막 값의 임의 길이 조각이 만들어진다. 그 조각은 셀 절단 가드로
// 식별할 수 없으므로 바인드 하나씩 넣고, 들어가지 않는 항목은 건수로 알린다.
// 뒤의 짧은 ID는 계속 확인한다. 실제 표시한 값만 돌려줘 가드의 오탐도 막는다.
export function promptParams(params) {
  const entries = Object.entries(params || {}).map(([k, v]) => [k, clipDisplayValue(v)]);
  const render = kept => JSON.stringify(Object.fromEntries(kept))
    + (kept.length < entries.length ? ` (${entries.length - kept.length}개 파라미터 생략)` : '');
  let kept = entries;
  let text = render(kept);
  if (text.length > MAX_PROMPT_PARAMS_LEN) {
    kept = [];
    for (const entry of entries) {
      kept.push(entry);
      if (render(kept).length > MAX_PROMPT_PARAMS_LEN) kept.pop();
    }
    text = render(kept);
  }
  return { text, values: kept.map(([, v]) => v) };
}
