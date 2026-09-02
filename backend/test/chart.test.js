// 차트 참조 채우기 회귀 테스트 — 실행: npm test
// 이 변환은 조용히 깨진다: 참조를 못 채우면 화면에 차트 대신 설정 줄만 든 코드블록이 남고,
// 번호를 어긋나게 읽으면 다른 조회의 표가 '그 질문의 답'으로 그려진다.
import { test } from 'node:test';
import assert from 'node:assert';
import { resolveChartData, MAX_CHART_COLS, MAX_CHART_CELL_LEN, MAX_CHART_INJECT_LEN } from '../src/chart.js';

const rows = [
  { MONTH: '2024-01', CNT: 120, AMT: 1000.5, NOTE: 'a|b' },
  { MONTH: '2024-02', CNT: null, AMT: 2500, NOTE: 'x\ny' },
];
const block = (body, indent = '') => `${indent}\`\`\`chart\n${body}\n${indent}\`\`\``;

test('data: step N 을 그 스텝의 전체 행으로 만든 표로 바꾼다', () => {
  const out = resolveChartData(`앞\n\n${block('type: bar\ntitle: 월별\ndata: step 1')}\n\n뒤`, [rows]);
  assert.strictEqual(out, [
    '앞', '',
    '```chart', 'type: bar', 'title: 월별',
    '| MONTH | CNT | AMT | NOTE |', '| --- | --- | --- | --- |',
    // null은 빈칸, 숫자는 그대로, 파이프는 \|, 줄바꿈은 공백
    '| 2024-01 | 120 | 1000.5 | a\\|b |', '| 2024-02 |  | 2500 | x y |',
    '```', '', '뒤',
  ].join('\n'));
});

test('스텝 번호는 이력의 1-based 절대 인덱스다 — 오류·메모 항목도 번호를 차지한다', () => {
  const steps = [null, rows, null]; // 1: 오류, 2: 성공, 3: 메모
  assert.match(resolveChartData(block('type: bar\ndata: step 2'), steps), /\| 2024-01 \| 120 \|/);
  assert.match(resolveChartData(block('type: bar\ndata: step 1'), steps), /^_차트를 그리지 못했습니다: 실행 1의 결과가 없습니다_$/);
  assert.match(resolveChartData(block('type: bar\ndata: step 3'), steps), /실행 3의 결과가 없습니다/);
  assert.match(resolveChartData(block('type: bar\ndata: step 4'), steps), /실행 4의 결과가 없습니다/);
  assert.match(resolveChartData(block('type: bar\ndata: step 0'), steps), /실행 0의 결과가 없습니다/);
  // 번호 표기는 너그럽게: '2' · '실행 2' · '#2'
  for (const v of ['2', '실행 2', '#2', 'Step2']) assert.match(resolveChartData(block(`type: bar\ndata: ${v}`), steps), /2024-01/, v);
  assert.match(resolveChartData(block('title: 제목\ndata: 전부'), steps), /^_'제목' 차트를 그리지 못했습니다: data 참조에 실행 번호가 없습니다_$/);
});

test('0건·열 부족은 안내 문장으로 바꾸고, 참조가 없는 블록은 건드리지 않는다', () => {
  assert.match(resolveChartData(block('type: bar\ndata: step 1'), [[]]), /조회 결과가 0건/);
  assert.match(resolveChartData(block('type: bar\ndata: step 1'), [[{ ONLY: 1 }]]), /그릴 열이 부족/);
  const inline = block('type: bar\n| a | b |\n|---|---|\n| x | 1 |');
  assert.strictEqual(resolveChartData(inline, [rows]), inline);
  assert.strictEqual(resolveChartData('차트 없음 ```sql\nselect 1\n```', [rows]), '차트 없음 ```sql\nselect 1\n```');
  assert.strictEqual(resolveChartData(null, [rows]), '');
  // 표가 함께 있으면 표가 이기고 data 줄만 사라진다
  assert.strictEqual(
    resolveChartData(block('type: bar\ndata: step 1\n| a | b |\n|---|---|\n| x | 1 |'), [rows]),
    block('type: bar\n| a | b |\n|---|---|\n| x | 1 |')
  );
});

test('셀의 줄바꿈은 어떤 표기든 공백이 된다 — 홀로 선 CR도 markdown은 줄 끝으로 읽는다', () => {
  const out = resolveChartData(block('type: bar\ndata: step 1'), [[{ K: 'a', V: 1, NOTE: 'p\rq\r\nr\ns' }]]);
  assert.match(out, /\| a \| 1 \| p q r s \|/);
  assert.ok(!out.includes('\r'));
});

test('x·y·y2로 열을 고른다 — x는 언제나 맨 앞, 이름은 대소문자 무시, 없는 이름은 버린다', () => {
  const out = resolveChartData(block('type: line\nx: month\ny: amt, nope\ny2: cnt\ndata: step 1'), [rows]);
  assert.match(out, /\| MONTH \| AMT \| CNT \|\n/);
  assert.match(out, /\| 2024-01 \| 1000\.5 \| 120 \|/);
  // x를 적지 않으면 첫 열이 x다 — 프런트도 첫 열을 x로 쓰므로 y만 실으면 y의 첫 열이 x가 되어 버린다
  assert.match(resolveChartData(block('type: bar\ny: amt, cnt\ndata: step 1'), [rows]), /\| MONTH \| AMT \| CNT \|\n/);
  assert.match(resolveChartData(block('type: bar\ny2: amt\ndata: step 1'), [rows]), /\| MONTH \| AMT \|\n/);
  // x가 y에도 적혀 있으면 한 번만
  assert.match(resolveChartData(block('type: bar\nx: month\ny: month, cnt\ndata: step 1'), [rows]), /\| MONTH \| CNT \|\n/);
  // x로 적은 이름이 없으면 첫 열이 x다(프런트와 같은 규칙)
  assert.match(resolveChartData(block('type: bar\nx: nope\ny: cnt\ndata: step 1'), [rows]), /\| MONTH \| CNT \|\n/);
  // 값 열 이름이 하나도 맞지 않으면 앞 열들로 채운다 (프런트가 숫자 열을 고른다)
  assert.match(resolveChartData(block('type: bar\nx: month\ndata: step 1'), [rows]), /\| MONTH \| CNT \| AMT \| NOTE \|/);
  assert.match(resolveChartData(block('type: bar\ny: nope\ndata: step 1'), [rows]), /\| MONTH \| CNT \| AMT \| NOTE \|/);
  // 넓은 결과는 MAX_CHART_COLS열까지, '…' 표시 열은 뺀다
  const wide = [Object.fromEntries([...Array.from({ length: 12 }, (_, i) => [`C${i}`, i]), ['…', '외 5개 컬럼 생략']])];
  const header = resolveChartData(block('type: bar\ndata: step 1'), [wide]).split('\n')[2];
  assert.strictEqual(header.split('|').length - 2, MAX_CHART_COLS);
  assert.ok(!header.includes('…'));
  // 뒤쪽 열을 x로 적고 값 열이 맞지 않으면, 앞 열들에 그 x를 결과 순서대로 끼운다
  assert.strictEqual(resolveChartData(block('type: bar\nx: c11\ndata: step 1'), [wide]).split('\n')[3], '| C0 | C1 | C2 | C3 | C4 | C5 | C6 | C11 |');
  // 뒤쪽 열을 y로 적으면 x(첫 열)와 그 열만 — 빠지면 프런트가 다른 숫자 열을 그린다
  assert.strictEqual(resolveChartData(block('type: bar\ny: c11\ndata: step 1'), [wide]).split('\n')[3], '| C0 | C11 |');
});

test('긴 셀과 총량 예산을 지키고, 다 싣지 못하면 차트 아래에 밝힌다', () => {
  const long = [{ K: 'a', V: 'x'.repeat(500) }];
  const out = resolveChartData(block('type: bar\ndata: step 1'), [long]);
  const cellLen = out.split('\n')[4].split('|')[2].trim().length;
  assert.ok(cellLen <= MAX_CHART_CELL_LEN, `${cellLen}`);

  const many = Array.from({ length: 100 }, (_, i) => ({ K: `k${i}`, V: 'v'.repeat(MAX_CHART_CELL_LEN), W: 'w'.repeat(MAX_CHART_CELL_LEN), X: 'x'.repeat(MAX_CHART_CELL_LEN) }));
  const two = resolveChartData(`${block('type: bar\ndata: step 1')}\n${block('type: bar\ndata: step 1')}\n${block('type: bar\ndata: step 1')}`, [many]);
  const injected = two.length - 3 * block('type: bar\ndata: step 1').length;
  assert.ok(injected <= MAX_CHART_INJECT_LEN + 3 * 200, `${injected}`); // 안내 문장 몫만큼만 넘을 수 있다
  assert.match(two, /_\(표는 100행 중 처음 \d+행까지만 실었습니다\)_/);
  // 예산이 바닥난 뒤의 블록은 표 없이 안내만
  assert.ok(two.split('```chart').length - 1 < 3);
});

test('들여쓴 펜스(목록 안)는 같은 들여쓰기로 채운다 — 안내 문장도', () => {
  const out = resolveChartData(`- 항목\n\n${block('  type: bar\n  data: step 1', '  ')}`, [rows]);
  assert.match(out, /\n  \| MONTH \| CNT \| AMT \| NOTE \|\n  \| --- /);
  assert.ok(out.endsWith('\n  ```'));
  assert.strictEqual(resolveChartData(block('  type: bar\n  data: step 2', '  '), [rows]), "  _차트를 그리지 못했습니다: 실행 2의 결과가 없습니다_");
  // `10. ` 항목 안은 4칸이다 — 프런트의 markdown 파서는 펜스로 읽으므로 여기서도 채워야 한다
  const deep = resolveChartData(`10. 항목\n${block('    type: bar\n    data: step 1', '    ')}`, [rows]);
  assert.match(deep, /\n    \| MONTH \| CNT \| AMT \| NOTE \|\n    \| --- /);
  assert.ok(!deep.includes('data: step'));
});

test('markdown 파서가 펜스로 읽는 변형을 다 받는다 — 언어 뒤 덧말·백틱 4개로 닫기·CRLF', () => {
  assert.match(resolveChartData('```chart 월별\ntype: bar\ndata: step 1\n````', [rows]), /^```chart\ntype: bar\n\| MONTH \|.*\n```$/s);
  assert.strictEqual(resolveChartData('```chart\r\ntitle: t\r\ndata: step 2\r\n```\r\n뒤', [rows]), "_'t' 차트를 그리지 못했습니다: 실행 2의 결과가 없습니다_\n뒤");
  // ```charts 는 차트 펜스가 아니다
  assert.strictEqual(resolveChartData('```charts\ndata: step 1\n```', [rows]), '```charts\ndata: step 1\n```');
});
