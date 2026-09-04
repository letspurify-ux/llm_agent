// trace 패널 계약(열·셀 표기·CSV) 회귀 테스트 — 실행: npm test (frontend/)
// CSV는 조용히 깨진다: 쉼표가 든 값 하나가 옆 열로 밀려도 파일은 열리고, 한글이 깨진 파일도 열린다.
import { test } from 'node:test';
import assert from 'node:assert';
import { columnsOf, cellText, toCsv, csvFileName, countLabel, stepLabel, normalizeTrace, isSearchStep, searchLabel, targetsLabel, traceSummary, applyProgress, progressText } from '../src/trace.js';

test('열은 첫 등장 순서의 합집합이다', () => {
  assert.deepStrictEqual(columnsOf([{ B: 1, A: 2 }, { A: 3, C: 4 }, null, 'x']), ['B', 'A', 'C']);
  assert.deepStrictEqual(columnsOf([]), []);
  assert.deepStrictEqual(columnsOf(undefined), []);
});

test('셀 표기: null은 빈칸, 숫자는 그대로, 객체는 JSON', () => {
  assert.strictEqual(cellText(null), '');
  assert.strictEqual(cellText(undefined), '');
  assert.strictEqual(cellText(0), '0');
  assert.strictEqual(cellText(1.5), '1.5');
  assert.strictEqual(cellText('a\nb'), 'a\nb');
  assert.strictEqual(cellText({ a: 1 }), '{"a":1}');
});

test('CSV는 BOM으로 시작하고 CRLF로 줄을 나누며, 쉼표·따옴표·줄바꿈이 든 값을 따옴표로 감싼다', () => {
  const rows = [{ K: 'a,b', V: 1, NOTE: 'say "hi"' }, { K: 'x\ny', V: null, NOTE: '' }];
  assert.strictEqual(toCsv(rows), '﻿K,V,NOTE\r\n"a,b",1,"say ""hi"""\r\n"x\ny",,\r\n');
  // 열 이름에도 같은 규칙
  assert.strictEqual(toCsv([{ 'a,b': 1 }]), '﻿"a,b"\r\n1\r\n');
  // 열 순서를 지정하면 그 순서·그 열만
  assert.strictEqual(toCsv(rows, ['V', 'K']), '﻿V,K\r\n1,"a,b"\r\n,"x\ny"\r\n');
  assert.strictEqual(toCsv([]), '﻿\r\n');
});

test('수식으로 읽힐 문자열은 글자로 고정하되 숫자 셀과 음수 표기는 건드리지 않는다', () => {
  const csv = toCsv([{ A: '=1+1', B: '@x', C: '+cmd', D: '-5', E: -5, F: '+1', G: '\tx' }]);
  assert.strictEqual(csv.split('\r\n')[1], `'=1+1,'@x,'+cmd,-5,-5,+1,'\tx`);
  // 숫자로 시작해도 통째로 숫자 표기가 아니면 수식이다 — 전화번호 '+82-10-…'을 엑셀은 82-10-…의 뺄셈으로 계산한다
  // '-' 하나는 '없음' 표시로 흔하고 수식이 되지 않으므로 그대로 둔다
  const tel = toCsv([{ A: '+82-10-1234-5678', B: '-1-2', C: '-2024-01-01', D: '-.5', E: '-1e5', F: '12345678901234567890', G: '-', H: '+5%', I: '-abc' }]);
  assert.strictEqual(tel.split('\r\n')[1], `'+82-10-1234-5678,'-1-2,'-2024-01-01,-.5,-1e5,12345678901234567890,-,'+5%,'-abc`);
});

test('파일 이름은 쿼리 이름@DB에서 파일에 못 쓰는 글자를 바꾼다', () => {
  assert.strictEqual(csvFileName('월별 주문', '서울DB'), '월별 주문@서울DB.csv');
  assert.strictEqual(csvFileName('a/b:c?', undefined), 'a_b_c_.csv');
  assert.strictEqual(csvFileName('', ''), 'result.csv');
  assert.strictEqual(csvFileName(undefined), 'result.csv');
});

// 건수 문구는 '실린 것을 전부로 읽는 것'을 막는 유일한 자리다 — 서버가 주는 모양(capped·omittedRows·
// '1000+'꼴 rowCount)마다 무엇을 말하는지 못박아 둔다.
test('건수 문구: 상한·생략·둘 다·근거 없음을 각각 말한다', () => {
  const rows = n => Array.from({ length: n }, (_, i) => ({ a: i }));
  assert.strictEqual(countLabel({ rowCount: 30, rows: rows(30) }), '30건');
  assert.strictEqual(countLabel({ rowCount: 100, omittedRows: 80, rows: rows(20) }), '100건 (아래는 그중 20건)');
  assert.match(countLabel({ rowCount: '1000+', capped: true, rows: rows(1000) }), /^1000건 이상 — 조회 상한에 걸려/);
  // 상한에 걸리고 실린 행도 일부면 둘 다 말한다. '1000+건'과 '1000건 이상'이 한 패널에 섞이지 않게
  // 표기도 하나로 (서버는 capped일 때 rowCount를 '1000+'로 준다).
  assert.strictEqual(countLabel({ rowCount: '1000+', capped: true, omittedRows: 980, rows: rows(20) }),
    '1000건 이상 — 조회 상한에 걸렸고, 아래는 그중 20건입니다');
  // rowCount가 없으면 '몇 건 중 몇 건'을 말할 근거가 없다 — 'undefined건'도, 스스로 어긋난 말도 안 된다
  assert.strictEqual(countLabel({ rows: rows(12) }), '12건');
  assert.strictEqual(countLabel({ omittedRows: 8, rows: rows(12) }), '12건');
  assert.strictEqual(countLabel({ rows: [] }), '0건');
});

test('스텝의 문구: 실행되지 못한 스텝은 건수 대신 오류를 말한다', () => {
  // 화면(App.jsx TraceStep)도 픽스처도 이 함수를 부른다 — 오류 줄을 화면에서 따로 지으면 그 글자에
  // 임자가 없어, 문구를 다듬은 날 앱은 맞는데 검사가 깨지거나 앱이 내지 않는 글자를 검사가 보증한다.
  assert.strictEqual(stepLabel({ rowCount: 0, error: '조회 중 오류가 발생했습니다.' }), '오류: 조회 중 오류가 발생했습니다.');
  // 오류가 없으면 건수 문구 그대로다 (rows까지 온 스텝은 오류가 있어도 건수를 말하지 않는다)
  assert.strictEqual(stepLabel({ rowCount: 30, rows: Array.from({ length: 30 }, () => ({ a: 1 })) }), '30건');
  assert.strictEqual(stepLabel({ rows: [] }), '0건');
  // 스텝은 있어야 한다. 없는 것을 받으면 그 자리에서 무슨 일인지 밝힌다 — 조용히 '0건'으로 답하면
  // 없는 스텝이 화면에 조회 성공으로 남고, 그대로 넘기면 countLabel이 'rows를 읽을 수 없다'로 죽어
  // 임자(없는 스텝을 집은 부르는 쪽)가 아니라 trace.js를 가리킨다.
  // 실제로 픽스처가 스텝을 find로 집어 온다(test/ui/fixtures.js) — 그 find가 빗나가는 날이 이 길이다.
  assert.throws(() => stepLabel(undefined), /스텝이 없습니다/);
  assert.throws(() => stepLabel(null), /스텝이 없습니다/);
});

test('trace는 화면이 그릴 수 있는 모양으로만 들어온다 — 어긋난 값에 화면이 죽지 않는다', () => {
  // 이 값의 모양은 우리가 정하지 못한다(배포가 어긋난 서버·중간에 낀 프록시). 어긋난 것이 그대로
  // 화면에 닿으면 렌더 도중에 던지고, 이 화면에서 그것은 '대화가 통째로 사라진다'와 같은 말이다.
  // 아래 세 모양은 실제로 백지를 만들던 것들이다(화면 재현으로 확인).
  assert.deepStrictEqual(normalizeTrace('배열이 아니다'), []);      // trace.map이 없다
  assert.deepStrictEqual(normalizeTrace({}), []);
  assert.deepStrictEqual(normalizeTrace(undefined), []);
  assert.deepStrictEqual(normalizeTrace([null, 1, '글자', []]), []); // 스텝이 아닌 원소는 버린다
  // query_name·targetDb는 화면의 자식이 되고 CSV 파일 이름이 된다 — 객체가 오면 React가 던진다
  const [t] = normalizeTrace([{ query_name: { a: 1 }, targetDb: { d: 2 }, params: { x: 1 }, rowCount: 3, rows: [{ a: 1 }] }]);
  assert.strictEqual(t.query_name, '{"a":1}');
  assert.strictEqual(t.targetDb, '{"d":2}');
  // 행이 배열이 아니면 행이 없는 것으로 본다 (표도 CSV 단추도 없는 '실행되지 못한 스텝'과 같은 모양)
  assert.strictEqual(normalizeTrace([{ query_name: 'q', rows: '행이 아니다' }])[0].rows, undefined);
  assert.strictEqual(normalizeTrace([{ query_name: 'q' }])[0].rows, undefined);
  // 성한 스텝은 그대로 지나간다 — 정리한다는 이유로 화면이 쓰는 값을 잃어서는 안 된다
  const 성한 = { step: 2, query_name: 'q', targetDb: 'db', params: { a: 1 }, rowCount: '1000+', capped: true, omittedRows: 970, rows: [{ a: 1 }] };
  assert.deepStrictEqual(normalizeTrace([성한]), [성한]);
  // 정리한 스텝도 화면이 부르는 문구 함수를 그대로 통과해야 한다 (여기서 던지면 정리한 뜻이 없다)
  for (const step of normalizeTrace([{ query_name: {}, rows: 'x', rowCount: {}, error: {} }, { query_name: 'q', rows: [null, 'x', { a: 1 }] }]))
    assert.strictEqual(typeof stepLabel(step), 'string');
  // 행 안의 이상한 값도 표·CSV가 받아 낸다 (열은 객체 행에서만 모은다)
  const rows = normalizeTrace([{ query_name: 'q', rows: [null, '글자', { a: 1 }] }])[0].rows;
  assert.deepStrictEqual(columnsOf(rows), ['a']);
  assert.strictEqual(toCsv(rows), '\ufeffa\r\n\r\n\r\n1\r\n');
});

// ===== 검색 항목과 진행 줄 =====

test('검색 결과 문구: 적중 수·검색 불가·찾지 않은 대상을 가른다', () => {
  assert.equal(searchLabel({ hits: { knowledge: 2, qaMethods: null, queries: 3 } }), '지식 2건 · 쿼리 3건');
  assert.equal(searchLabel({ hits: { knowledge: 0 }, failed: ['qa_method', 'query'] }), '지식 0건 · 처리방법 검색 불가 · 쿼리 검색 불가');
  assert.equal(searchLabel({}), '결과 없음');
  assert.equal(searchLabel({ hits: 'x', failed: 'y' }), '결과 없음', '모양이 어긋난 값에 죽지 않는다');
  assert.equal(targetsLabel(['knowledge', 'query', 'bogus']), '지식·쿼리·bogus');
  assert.equal(targetsLabel([]), '전체');
});

test('스텝 문구: 검색 항목은 적중 수를, 쿼리 항목은 건수·오류를 말한다', () => {
  assert.equal(stepLabel({ search: 'x', hits: { knowledge: 1 } }), '지식 1건');
  assert.ok(isSearchStep({ search: 'x' }) && !isSearchStep({ query_name: 'q' }) && !isSearchStep(null));
});

test('패널 머리띠: 검색이 없으면 예전 그대로, 있으면 둘을 함께 말한다', () => {
  assert.equal(traceSummary([{ query_name: 'q', rows: [] }]), '실행된 쿼리 1건');
  assert.equal(traceSummary([{ search: 'x' }, { query_name: 'q' }, { query_name: 'r' }]), '검색 1회 · 실행된 쿼리 2건');
  assert.equal(traceSummary([{ search: 'x' }]), '검색 1회');
  assert.equal(traceSummary([]), '실행된 쿼리 0건');
  assert.equal(traceSummary('x'), '실행된 쿼리 0건');
});

test('normalizeTrace는 검색 항목을 한 줄짜리 모양으로만 남긴다', () => {
  const [s, q] = normalizeTrace([{ search: '배치', targets: ['knowledge', 3], hits: 'x', failed: null, rows: [{ a: 1 }] }, { query_name: 'q', rows: [] }]);
  assert.deepStrictEqual(s, { search: '배치', targets: ['knowledge'], hits: {}, failed: [] });
  assert.ok(!('rows' in s), '검색 항목에 표가 붙으면 안 된다');
  assert.equal(q.query_name, 'q');
});

test('진행 줄: 시작이 줄을 세우고 끝이 그 줄에 결과를 붙인다 — 순서가 어긋나거나 모르는 종류가 와도 깨지지 않는다', () => {
  let list = [];
  list = applyProgress(list, { type: 'search', text: '배치', targets: ['knowledge', 'query'] });
  assert.deepStrictEqual(list, [{ kind: 'search', text: '배치', targets: ['knowledge', 'query'], pending: true }]);
  assert.equal(progressText(list[0]), '검색 "배치" (지식·쿼리)');
  list = applyProgress(list, { type: 'search_done', text: '배치', targets: ['knowledge', 'query'], hits: { knowledge: 2, queries: 0 } });
  assert.equal(list.length, 1);
  assert.equal(list[0].pending, false);
  assert.equal(progressText(list[0]), '검색 "배치" (지식·쿼리) → 지식 2건 · 쿼리 0건');
  list = applyProgress(list, { type: 'run_query', query_name: 'q', targetDb: 'D', params: {} });
  assert.equal(progressText(list[1]), '조회 q@D');
  list = applyProgress(list, { type: 'run_query_done', query_name: 'q', targetDb: 'D', rowCount: '1000+' });
  assert.equal(progressText(list[1]), '조회 q@D → 1000건 이상');   // 패널과 같은 말로 푼다 (아래 전용 검사)
  list = applyProgress(list, { type: 'run_query_done', query_name: 'r', error: '조회 중 오류가 발생했습니다.' });
  assert.equal(list.length, 3, '짝 없는 끝 이벤트는 새 줄로 선다');
  assert.equal(progressText(list[2]), '조회 r → 오류: 조회 중 오류가 발생했습니다.');
  assert.equal(applyProgress(list, { type: 'ping' }), list, '모르는 종류는 그대로');
  assert.deepStrictEqual(applyProgress('x', null), [], '모양이 어긋난 값에 죽지 않는다');
  // 이름 없는 조회·검색 불가
  assert.equal(progressText({ kind: 'query', pending: false, rowCount: 0 }), '조회 (이름 없음) → 0건');
  assert.equal(progressText({ kind: 'search', text: 'x', targets: ['qa_method'], failed: ['qa_method'], pending: false }), '검색 "x" (처리방법) → 처리방법 검색 불가');
});

test('여러 조회가 동시에 돌 때 끝 이벤트는 이름이 맞는 줄에 붙는다 — 줄이 뒤바뀌거나 사라지지 않는다', () => {
  // 일괄 조회(backend run_queries)는 조회 여럿을 병렬로 돌리므로 끝나는 순서가 시작 순서와 다르다.
  // 마지막 미완 줄에 붙이던 때에는 가운데가 먼저 끝나는 순간 그 줄이 다른 이름을 뒤집어써서
  // 같은 이름이 두 줄로 보이고 한 조회는 화면에서 사라졌다.
  let list = [];
  for (const e of [
    { type: 'run_query', query_name: 'A', targetDb: 'D' },
    { type: 'run_query', query_name: 'B', targetDb: 'D' },
    { type: 'run_query', query_name: 'C', targetDb: 'D' },
    { type: 'run_query_done', query_name: 'B', targetDb: 'D', rowCount: 2 },
  ]) list = applyProgress(list, e);
  assert.deepStrictEqual(list.map(progressText), ['조회 A@D', '조회 B@D → 2건', '조회 C@D']);
  for (const e of [
    { type: 'run_query_done', query_name: 'C', targetDb: 'D', rowCount: 3 },
    { type: 'run_query_done', query_name: 'A', targetDb: 'D', rowCount: 1 },
  ]) list = applyProgress(list, e);
  assert.deepStrictEqual(list.map(progressText), ['조회 A@D → 1건', '조회 B@D → 2건', '조회 C@D → 3건']);
  // 같은 쿼리를 다른 DB에서 도는 흔한 경우도 갈린다
  let two = [];
  for (const e of [
    { type: 'run_query', query_name: 'stock', targetDb: '서울' },
    { type: 'run_query', query_name: 'stock', targetDb: '부산' },
    { type: 'run_query_done', query_name: 'stock', targetDb: '서울', rowCount: 5 },
  ]) two = applyProgress(two, e);
  assert.deepStrictEqual(two.map(progressText), ['조회 stock@서울 → 5건', '조회 stock@부산']);
  // 이름을 주지 않는 끝 이벤트는 마지막 미완 줄로 물러선다 (옛 배포·다른 서버)
  let fb = applyProgress(applyProgress([], { type: 'run_query', query_name: 'A' }), { type: 'run_query_done', rowCount: 9 });
  assert.equal(fb.length, 1);
  assert.match(progressText(fb[0]), /9건/);
});

test('조회의 시작·끝은 서버가 준 짝 번호로 잇는다 — 이름·대상 DB로는 짝을 지을 수 없다', () => {
  // 같은 쿼리를 다른 값으로 두 번 부르는 배치가 정당하고, 대상 DB의 철자도 시작 이벤트(모델이 적은 것)와
  // 끝 이벤트(등록 철자)가 다를 수 있다 — 이름으로 짝을 지으면 그 두 경우에 줄이 뒤바뀐다.
  let list = [];
  for (const e of [
    { type: 'run_query', id: 1, query_name: 'stock', targetDb: 'PROD' },   // 모델이 적은 철자
    { type: 'run_query', id: 2, query_name: 'stock', targetDb: 'PROD' },   // 같은 쿼리·같은 DB, 다른 값
    { type: 'run_query_done', id: 2, query_name: 'stock', targetDb: 'prod', rowCount: 7 },  // 등록 철자
  ]) list = applyProgress(list, e);
  assert.deepStrictEqual(list.map(progressText), ['조회 stock@PROD', '조회 stock@prod → 7건']);
  list = applyProgress(list, { type: 'run_query_done', id: 1, query_name: 'stock', targetDb: 'prod', rowCount: 3 });
  assert.deepStrictEqual(list.map(progressText), ['조회 stock@prod → 3건', '조회 stock@prod → 7건']);
});

test('짝 번호를 주지 않는 서버에서는 이름과 대상 DB로 물러서되 철자 차이는 흡수한다', () => {
  let list = [];
  for (const e of [
    { type: 'run_query', query_name: 'A', targetDb: 'PROD' },
    { type: 'run_query', query_name: 'B', targetDb: 'PROD' },
    { type: 'run_query_done', query_name: ' a ', targetDb: 'prod', rowCount: 1 },
  ]) list = applyProgress(list, e);
  // 짝은 철자 차이를 넘어 지어지고, 화면에 보이는 이름은 서버가 준 그대로다 (정규화는 비교에만 쓴다)
  assert.deepStrictEqual(list.map(progressText), ['조회  a @prod → 1건', '조회 B@PROD']);
});

test('패널의 번호는 서버가 준 이력의 절대 순번을 그대로 쓴다', () => {
  // 모델이 답변에서 "3번 조회 결과"라고 말할 때 사용자가 패널에서 세는 번호와 같아야 한다 —
  // 걸러진 항목(가드 안내)만큼 어긋나면 다른 조회를 가리킨다.
  const [s1, q1] = normalizeTrace([
    { step: 1, search: 'x', targets: ['knowledge'], hits: { knowledge: 1 } },
    { step: 4, query_name: 'q', params: {}, rows: [{ a: 1 }], rowCount: 1 },
  ]);
  assert.equal(s1.step, 1);
  assert.equal(q1.step, 4);
});

test('상한에 걸린 건수는 진행 줄과 패널이 같은 말로 푼다', () => {
  // 서버는 '1000+'로 준다. 진행 줄이 그대로 찍으면 같은 조회가 몇 초 사이에 '1000+건'이었다가
  // '1000건 이상'이 된다 — 사용자는 둘을 다른 일로 읽는다.
  let l = applyProgress([], { type: 'run_query', id: 1, query_name: 'q', targetDb: 'D' });
  l = applyProgress(l, { type: 'run_query_done', id: 1, query_name: 'q', targetDb: 'D', rowCount: '1000+' });
  assert.equal(progressText(l[0]), '조회 q@D → 1000건 이상');
  assert.match(countLabel({ rowCount: '1000+', capped: true, omittedRows: 980, rows: new Array(20) }), /^1000건 이상 —/);
});

test('짝 없는 번호의 끝 이벤트는 남의 줄을 덮지 않고 자기 줄을 세운다', () => {
  // 시작을 못 받았거나 끝이 두 번 온 경우다. 남의 줄에 붙이면 그 줄이 다른 조회의 이름과 건수를
  // 뒤집어쓰고(한 조회는 화면에서 사라진다) 진짜 끝이 나중에 와서 세 번째 줄을 만든다.
  let l = [];
  for (const e of [
    { type: 'run_query', id: 1, query_name: 'A' },
    { type: 'run_query', id: 3, query_name: 'C' },
    { type: 'run_query_done', id: 2, query_name: 'B', rowCount: 2 },
  ]) l = applyProgress(l, e);
  assert.deepStrictEqual(l.map(progressText), ['조회 A', '조회 C', '조회 B → 2건']);
  // 번호를 주지 않는 옛 배포는 그대로 마지막 미완 줄로 물러선다
  let old = applyProgress(applyProgress([], { type: 'run_query', query_name: 'A' }), { type: 'run_query_done', query_name: '모르는이름', rowCount: 9 });
  assert.equal(old.length, 1);
});

test('스텝 번호는 정수일 때만 화면으로 나간다', () => {
  // 이 값은 React의 자식이 된다 — 객체가 그대로 통과하면 렌더가 던지고 패널이 통째로 사라진다.
  assert.equal(normalizeTrace([{ step: { n: 3 }, query_name: 'q', rows: [] }])[0].step, undefined);
  assert.equal(normalizeTrace([{ step: '2', search: 'x' }])[0].step, undefined);
  assert.equal(normalizeTrace([{ step: 2, search: 'x' }])[0].step, 2);
  assert.equal(normalizeTrace([{ step: 0, query_name: 'q' }])[0].step, undefined);
});
