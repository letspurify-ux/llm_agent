// trace 패널 계약(열·셀 표기·CSV) 회귀 테스트 — 실행: npm test (frontend/)
// CSV는 조용히 깨진다: 쉼표가 든 값 하나가 옆 열로 밀려도 파일은 열리고, 한글이 깨진 파일도 열린다.
import { test } from 'node:test';
import assert from 'node:assert';
import { columnsOf, cellText, toCsv, csvFileName } from '../src/trace.js';

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
});

test('파일 이름은 쿼리 이름@DB에서 파일에 못 쓰는 글자를 바꾼다', () => {
  assert.strictEqual(csvFileName('월별 주문', '서울DB'), '월별 주문@서울DB.csv');
  assert.strictEqual(csvFileName('a/b:c?', undefined), 'a_b_c_.csv');
  assert.strictEqual(csvFileName('', ''), 'result.csv');
  assert.strictEqual(csvFileName(undefined), 'result.csv');
});
