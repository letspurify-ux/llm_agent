import { MAX_RESULT_ROWS, MAX_RESULT_COLS } from './constants.js';

export function normalizeResultRead(d) {
  const offset = d.offset ?? 0;
  const limit = d.limit ?? MAX_RESULT_ROWS;
  const cols = d.cols ?? [];
  const invalid = d.invalid === true || !Number.isSafeInteger(d.step) || d.step < 1
    || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(limit) || limit < 1
    || !Array.isArray(cols) || cols.length > MAX_RESULT_COLS
    || cols.some(c => typeof c !== 'string' || !c.trim() || c.length > 128);
  if (invalid) return { action: 'read_result', invalid: true };
  return { action: 'read_result', step: d.step, offset, limit: Math.min(limit, MAX_RESULT_ROWS), cols: [...new Set(cols)] };
}

// 실행 완료된 행만 읽는다. 원본 배열과 셀은 바꾸지 않으며 컬럼을 잘라 다른 이름으로 조회하지 않는다.
export function readStoredResult(rows, request) {
  const d = normalizeResultRead(request);
  if (d.invalid) throw new Error('step은 양의 정수, offset은 0 이상, limit은 양의 정수, cols는 정확한 컬럼명 목록이어야 한다');
  if (!rows) throw new Error('해당 실행 번호에 보관된 조회 결과가 없다');
  if (d.offset >= rows.length && (d.offset > 0 || rows.length > 0)) throw new Error(`보관된 결과는 ${rows.length}행이다. 그 안의 offset을 지정하라`);
  const names = new Set(rows.flatMap(row => Object.keys(row)));
  const missing = d.cols.filter(c => !names.has(c));
  if (missing.length) throw new Error(`없는 컬럼: ${missing.join(', ')}. 사용 가능한 컬럼: ${[...names].join(', ')}`);
  return {
    rows: rows.slice(d.offset, d.offset + d.limit).map(row => d.cols.length
      ? Object.fromEntries(d.cols.filter(c => Object.hasOwn(row, c)).map(c => [c, row[c]])) : row),
    rowOffset: d.offset,
    resultRead: true,
  };
}
