// trace 패널 계약(열·셀 표기·CSV) 회귀 테스트 — 실행: npm test (frontend/)
// CSV는 조용히 깨진다: 쉼표가 든 값 하나가 옆 열로 밀려도 파일은 열리고, 한글이 깨진 파일도 열린다.
import { test } from 'node:test';
import assert from 'node:assert';
import { columnsOf, cellText, toCsv, csvFileName, countLabel, stepLabel, normalizeTrace } from '../src/trace.js';

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
  const 성한 = { query_name: 'q', targetDb: 'db', params: { a: 1 }, rowCount: '1000+', capped: true, omittedRows: 970, rows: [{ a: 1 }] };
  assert.deepStrictEqual(normalizeTrace([성한]), [성한]);
  // 정리한 스텝도 화면이 부르는 문구 함수를 그대로 통과해야 한다 (여기서 던지면 정리한 뜻이 없다)
  for (const step of normalizeTrace([{ query_name: {}, rows: 'x', rowCount: {}, error: {} }, { query_name: 'q', rows: [null, 'x', { a: 1 }] }]))
    assert.strictEqual(typeof stepLabel(step), 'string');
  // 행 안의 이상한 값도 표·CSV가 받아 낸다 (열은 객체 행에서만 모은다)
  const rows = normalizeTrace([{ query_name: 'q', rows: [null, '글자', { a: 1 }] }])[0].rows;
  assert.deepStrictEqual(columnsOf(rows), ['a']);
  assert.strictEqual(toCsv(rows), '\ufeffa\r\n\r\n\r\n1\r\n');
});
