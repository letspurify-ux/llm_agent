// 조회 결과 건수 해석(result.js) 회귀 테스트 — 실행: npm test
// 이 해석은 사용자 답변(llm.js)·모델 프롬프트(llm-openai.js)·화면 trace(server.js) 세 곳이 함께 쓴다.
// 어긋나면 "총 50건"이라고 답해놓고 프롬프트에는 "100+건"이 실리는 식으로 조용히 갈라진다.
import { test } from 'node:test';
import assert from 'node:assert';
import { rowCounts } from '../src/result.js';

// rows 배열 자체는 비교 대상이 아니므로 건수만 본다
const counts = h => { const { rows, ...rest } = rowCounts(h); return rest; };
const nRows = n => new Array(n).fill({ a: 1 });

test('싣는 건수와 조회된 총 건수를 구분한다', () => {
  // MAX_RESULT_ROWS로 20건만 실었지만 조회는 50건 — 30건 생략
  assert.deepStrictEqual(counts({ rows: nRows(20), totalRows: 50 }),
    { shown: 20, totalRows: 50, omitted: 30, capped: false });
});

test('조회 상한에 걸린 결과는 capped로 남는다', () => {
  // totalRows 자체가 MAX_ROWS에 걸린 값이라 실제 총 건수는 더 많을 수 있다
  assert.deepStrictEqual(counts({ rows: nRows(20), totalRows: 100, capped: true }),
    { shown: 20, totalRows: 100, omitted: 80, capped: true });
});

test('rows가 없는 기록에도 죽지 않는다', () => {
  // 오류 기록이나 오류 메시지가 비어 분기를 빠져나온 기록 — 여기서 던지면 프롬프트 조립이
  // 통째로 실패해 이미 조회해둔 결과까지 버려진다
  assert.deepStrictEqual(counts({ error: 'x' }), { shown: 0, totalRows: 0, omitted: 0, capped: false });
  assert.deepStrictEqual(counts({}), { shown: 0, totalRows: 0, omitted: 0, capped: false });
});

test('totalRows가 없으면 실린 건수로 폴백한다', () => {
  // 재생된 trace 등 다른 출처의 기록이 섞여도 답변에 NaN이 찍히지 않아야 한다
  assert.deepStrictEqual(counts({ rows: nRows(3) }), { shown: 3, totalRows: 3, omitted: 0, capped: false });
});
