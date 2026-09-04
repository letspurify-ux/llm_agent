// 조회 결과 건수 해석(result.js) 회귀 테스트 — 실행: npm test
// 이 해석은 사용자 답변(llm.js)·모델 프롬프트(llm-openai.js)·화면 trace(server.js) 세 곳이 함께 쓴다.
// 어긋나면 "총 50건"이라고 답해놓고 프롬프트에는 "100+건"이 실리는 식으로 조용히 갈라진다.
import { test } from 'node:test';
import assert from 'node:assert';
import { rowCounts, clientTrace } from '../src/result.js';

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

// ===== 화면 trace 패널 (clientTrace) =====
// 같은 기록의 세 번째 대상. 여기서 조용히 깨지는 것이 셋이다 —
//   ① 조회된 행 전부를 볼 수 있는 자리가 이 패널뿐인데, history의 20행으로 물러나 버리면 사용자는
//      그 표본을 전부로 읽는다(모델은 그중 몇 행만 답변에 옮겨 적는다).
//   ② 총 건수는 말하면서 행은 말없이 잘라 보내도 같은 일이 일어난다.
//   ③ 드라이버 원문을 가리는 판정이 뚫리면 스키마명·접속 주소가 화면으로 나간다.
// 셋 다 오류를 남기지 않으므로 회귀 테스트가 유일한 방어선이다.

test('trace 패널에는 history의 20행이 아니라 조회된 행 전부가 실린다', () => {
  const h = { query_name: 'q', params: { a: 1 }, rows: nRows(20), totalRows: 100, capped: true };
  const full = Array.from({ length: 100 }, (_, i) => ({ a: i }));
  const [t] = clientTrace([h], new Map([[h, full]]));
  assert.equal(t.rowCount, '100+');
  assert.equal(t.capped, true, "'+'의 뜻(상한에 걸려 더 있을 수 있음)을 화면이 문구로 풀 수 있어야 한다");
  assert.strictEqual(t.rows, full);
  assert.ok(!('omittedRows' in t), '전부 실었으면 생략 표시가 없어야 한다');
  // 오류 기록은 fullRows에 없다 — rows가 undefined로 남아야 한다(빈 배열이면 0건 성공으로 읽힌다)
  const e = { query_name: 'q', params: {}, error: 'x', safe: true };
  assert.equal(clientTrace([e], new Map([[h, full]]))[0].rows, undefined);
});

test('전체 행이 없는 기록은 history의 행으로 물러나되 감춘 행 수를 함께 알린다', () => {
  const [t] = clientTrace([{ query_name: 'q', params: { a: 1 }, rows: nRows(20), totalRows: 100, capped: true }]);
  assert.equal(t.rowCount, '100+');
  assert.equal(t.rows.length, 20);
  assert.equal(t.omittedRows, 80, '몇 건을 감췄는지 화면이 알 수 있어야 한다');
});

test('다 실은 결과에는 생략·상한 표시를 붙이지 않는다', () => {
  const h = { query_name: 'q', params: {}, rows: nRows(3), totalRows: 3 };
  const [t] = clientTrace([h], new Map([[h, h.rows]]));
  assert.equal(t.rowCount, 3);
  assert.ok(!('omittedRows' in t) && !('capped' in t), '평소 패널은 조용해야 한다');
});

test('제어용 note 기록은 실행된 쿼리 목록에서 빠진다', () => {
  // 루프 가드가 LLM에게 남긴 내부 지시문이라 사용자에게 노출되면 안 된다
  assert.deepStrictEqual(clientTrace([{ query_name: 'q', params: {}, note: '다른 쿼리를 선택하라' }]), []);
});

test('safe 표시가 없는 오류 원문은 화면으로 나가지 않는다', () => {
  const [driver, ours] = clientTrace([
    { query_name: 'q1', params: {}, error: 'ORA-00942: table or view does not exist (SCHEMA.T@host:1521)' },
    { query_name: 'q2', params: {}, error: '등록되지 않은 쿼리', safe: true, hint: '목록에서 고르거나 답변하라' },
  ]);
  assert.equal(driver.error, '조회 중 오류가 발생했습니다.', '드라이버 원문은 스키마명·접속 주소를 담고 있다');
  assert.equal(ours.error, '등록되지 않은 쿼리');
  assert.ok(!('hint' in ours), 'hint는 모델 전용 지침이라 화면에 나가면 안 된다');
  assert.equal(driver.rows, undefined, '오류 기록에 빈 배열을 주면 화면이 0건 조회 성공으로 읽는다');
});

test('검색 기록은 검색어·대상·적중 수로 패널에 나가고, 가드 note는 나가지 않는다', () => {
  const out = clientTrace([
    { search: '배치 재시작', targets: ['knowledge', 'query'], hits: { knowledge: 2, qaMethods: null, queries: 3 } },
    { search: '배치 재시작', targets: ['knowledge'], note: '이미 같은 검색어' },
    { search: 'x', targets: ['qa_method'], hits: { knowledge: null, qaMethods: null, queries: null }, failed: ['qa_method'] },
    { query_name: 'q', params: {}, rows: [{ a: 1 }], totalRows: 1 },
  ]);
  assert.equal(out.length, 3);
  assert.deepStrictEqual(out[0], { step: 1, search: '배치 재시작', targets: ['knowledge', 'query'], hits: { knowledge: 2, qaMethods: null, queries: 3 } });
  assert.deepStrictEqual(out[1], { step: 3, search: 'x', targets: ['qa_method'], hits: { knowledge: null, qaMethods: null, queries: null }, failed: ['qa_method'] });
  assert.equal(out[2].query_name, 'q');
  // 번호는 이력의 절대 순번이다 — 제외된 note 항목(2번)만큼 건너뛴다. 모델이 보는 번호와 같아야 한다.
  assert.equal(out[2].step, 4);
  assert.ok(!('search' in out[2]) && !('query_name' in out[0]), '검색 항목과 쿼리 항목의 모양이 섞였다');
});
