// 차트 참조 채우기 회귀 테스트 — 실행: npm test
// 이 변환은 조용히 깨진다: 참조를 못 채우면 화면에 차트 대신 설정 줄만 든 코드블록이 남고,
// 번호를 어긋나게 읽으면 다른 조회의 표가 '그 질문의 답'으로 그려진다.
import { test } from 'node:test';
import assert from 'node:assert';
import { resolveChartData, MAX_CHART_COLS, MAX_CHART_CELL_LEN, MAX_CHART_INJECT_LEN, MAX_CHART_BLOCK_ROWS } from '../src/chart.js';

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

test('물결·백틱 넷 펜스의 data 참조도 채운다 — 프런트가 차트로 그리는 펜스는 다 같은 규칙이다', () => {
  // 실측: 백틱 셋만 받던 때에는 ~~~chart·````chart로 적힌 data: 참조가 그대로 남아 화면에 '채우지 못했습니다'로 갔다.
  // 다시 쓸 때 펜스 글자도 그대로 써야 markdown이 같은 블록으로 읽는다.
  const table = ['| MONTH | CNT | AMT | NOTE |', '| --- | --- | --- | --- |', '| 2024-01 | 120 | 1000.5 | a\\|b |', '| 2024-02 |  | 2500 | x y |'];
  assert.strictEqual(resolveChartData('~~~chart\ntype: bar\ndata: step 1\n~~~', [rows]),
    ['~~~chart', 'type: bar', ...table, '~~~'].join('\n'));
  assert.strictEqual(resolveChartData('````chart\ndata: step 1\n````', [rows]),
    ['````chart', ...table, '````'].join('\n'));
  // 표가 이미 있으면 data 줄만 빼고 펜스는 그대로 (닫는 펜스가 더 길어도 여는 것에 맞춰 다시 쓴다)
  assert.strictEqual(resolveChartData('~~~chart\ndata: step 1\n| a | b |\n| x | 1 |\n~~~~', [rows]),
    '~~~chart\n| a | b |\n| x | 1 |\n~~~');
  // markdown 규칙대로 닫는 펜스는 여는 것과 같은 글자·같은 수 이상이어야 한다 — 아니면 블록이 아니니 손대지 않는다
  for (const md of ['````chart\ndata: step 1\n```', '~~~chart\ndata: step 1\n```', '```chart\ndata: step 1\n~~~', '```chart\ndata: step 1\n```~']) {
    assert.strictEqual(resolveChartData(md, [rows]), md);
  }
});

test('빈 차트 블록은 다음 블록과 그 사이의 문장을 삼키지 않는다', () => {
  // 실측: ```chart 바로 아래 ```인 빈 블록(markdown에게는 닫힌 블록)의 여는 펜스가 다음 차트 블록의 닫는 펜스와
  // 짝이 되어, 그 사이의 설명 문장이 표로 다시 쓰인 한 블록 안으로 들어가 답변에서 사라졌다.
  const out = resolveChartData('```chart\n```\n\n설명 문장\n\n```chart\ntype: bar\ndata: step 1\n```', [rows]);
  assert.strictEqual(out, [
    '```chart', '```', '', '설명 문장', '',
    '```chart', 'type: bar',
    '| MONTH | CNT | AMT | NOTE |', '| --- | --- | --- | --- |',
    '| 2024-01 | 120 | 1000.5 | a\\|b |', '| 2024-02 |  | 2500 | x y |',
    '```',
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

  // 예산은 채울 블록 수로 나눈다 — 넓은 표 셋이면 셋 다 몫만큼 실리고(앞 블록이 뒤를 굶기지 않는다), 합은 예산 안이다
  const many = Array.from({ length: 100 }, (_, i) => ({ K: `k${i}`, V: 'v'.repeat(MAX_CHART_CELL_LEN), W: 'w'.repeat(MAX_CHART_CELL_LEN), X: 'x'.repeat(MAX_CHART_CELL_LEN) }));
  const three = resolveChartData(`${block('type: bar\ndata: step 1')}\n${block('type: bar\ndata: step 1')}\n${block('type: bar\ndata: step 1')}`, [many]);
  const injected = three.length - 3 * block('type: bar\ndata: step 1').length;
  assert.ok(injected <= MAX_CHART_INJECT_LEN + 3 * 200, `${injected}`); // 안내 문장 몫만큼만 넘을 수 있다
  assert.strictEqual(three.split('```chart').length - 1, 3);
  const notes = [...three.matchAll(/_\(표는 100행 중 처음 (\d+)행까지만 실었습니다\)_/g)].map(m => Number(m[1]));
  assert.strictEqual(notes.length, 3);
  assert.ok(notes.every(n => n > 0 && Math.abs(n - notes[0]) <= 1), notes.join(','));
  // 덜 쓴 몫은 뒤로 넘어간다 — 좁은 표가 앞이면 뒤의 넓은 표가 그 여유를 받는다
  const narrow = Array.from({ length: 5 }, (_, i) => ({ K: `k${i}`, V: i }));
  const mixed = resolveChartData(`${block('type: bar\ndata: step 1')}\n${block('type: bar\ndata: step 2')}`, [narrow, many]);
  assert.strictEqual(mixed.split('\n').filter(l => /^\| k\d+ \| v/.test(l)).length, 100);
  assert.ok(!mixed.includes('행까지만'));
  // 채우지 못한 블록(없는 번호)은 몫을 쓰지 않는다
  const skipped = resolveChartData(`${block('type: bar\ndata: step 9')}\n${block('type: bar\ndata: step 1')}`, [many]);
  assert.strictEqual(skipped.split('\n').filter(l => /^\| k\d+ \| v/.test(l)).length, 100);
});

test('블록 하나에 싣는 행은 MAX_CHART_BLOCK_ROWS까지 — 프런트가 그리는 행 수와 같고, 나머지는 trace 패널의 몫이다', () => {
  const big = Array.from({ length: MAX_CHART_BLOCK_ROWS + 50 }, (_, i) => ({ K: `k${i}`, V: i }));
  const out = resolveChartData(block('type: bar\ndata: step 1'), [big]);
  assert.strictEqual(out.split('\n').filter(l => /^\| k\d+ \|/.test(l)).length, MAX_CHART_BLOCK_ROWS);
  assert.ok(out.endsWith(`_(표는 ${MAX_CHART_BLOCK_ROWS + 50}행 중 처음 ${MAX_CHART_BLOCK_ROWS}행까지만 실었습니다)_`), out.slice(-80));
  // 행 순서는 조회 순서다 — 앞의 100행
  assert.match(out, /\| k0 \| 0 \|\n/);
  assert.ok(!out.includes(`| k${MAX_CHART_BLOCK_ROWS} |`));
  // 같은 스텝을 두 번 참조해도(막대 + 원) 둘 다 표를 받는다 — 예전에는 첫 블록이 예산을 다 써 둘째가 안내 문장이 됐다
  const twice = resolveChartData(`${block('type: bar\ndata: step 1')}\n${block('type: pie\ndata: step 1')}`, [Array.from({ length: 1000 }, (_, i) => ({ K: `k${i}`, V: i, W: 'x'.repeat(40) }))]);
  assert.strictEqual(twice.split('```chart').length - 1, 2);
  assert.ok(!twice.includes('양을 넘었습니다'));
});

test('역슬래시는 GFM 규칙대로 두 개로 적는다 — 값 속의 \\| 가 열을 밀지 않게', () => {
  const out = resolveChartData(block('type: bar\ndata: step 1'), [[{ K: 'a\\|b', V: 1 }, { K: 'C:\\dir\\', V: 2 }]]);
  assert.match(out, /\| a\\\\\\\|b \| 1 \|\n/);
  assert.match(out, /\| C:\\\\dir\\\\ \| 2 \|\n/);
});

test('표는 파이프 줄이 둘 이상일 때다 — 파이프 하나 든 설명 줄은 표가 아니고, 채울 때는 설정 줄만 남긴다', () => {
  const out = resolveChartData(block('type: bar\ndata: step 1\n1월 | 2월 비교입니다\n설명 문장'), [rows]);
  assert.match(out, /^```chart\ntype: bar\n\| MONTH \| CNT \| AMT \| NOTE \|\n/);
  assert.ok(!out.includes('비교입니다') && !out.includes('설명 문장'));
  // 머리글 한 줄뿐인 표도 표가 아니다(프런트가 '행 없음'으로 버린다) — 참조로 채운다
  assert.match(resolveChartData(block('type: bar\ndata: step 1\n| a | b |'), [rows]), /\| MONTH \| CNT \|/);
  // 파이프 줄이 둘이면 표다 — 표가 이긴다
  assert.strictEqual(resolveChartData(block('type: bar\ndata: step 1\n| a | b |\n| x | 1 |'), [rows]), block('type: bar\n| a | b |\n| x | 1 |'));
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

// ===== ```table 블록 =====
import { resolveTableData, MAX_TABLE_BLOCK_ROWS, DEFAULT_TABLE_ROWS, MAX_TABLE_COLS, MAX_TABLE_CELL_LEN, MAX_TABLE_INJECT_LEN } from '../src/chart.js';

const tblock = (body, indent = '') => `${indent}\`\`\`table\n${body}\n${indent}\`\`\``;

test('table 블록의 step: N 을 그 스텝의 행으로 만든 GFM 표로 바꾼다 — 펜스 없이', () => {
  const out = resolveTableData(`앞\n\n${tblock('step: 1')}\n\n뒤`, [rows]);
  assert.strictEqual(out, [
    '앞', '',
    '| MONTH | CNT | AMT | NOTE |', '| --- | --- | --- | --- |',
    '| 2024-01 | 120 | 1000.5 | a\\|b |', '| 2024-02 |  | 2500 | x y |',
    '', '뒤',
  ].join('\n'));
  // 차트 습관(data: step N)과 '실행 2' 표기도 받는다
  assert.ok(resolveTableData(tblock('data: 실행 1'), [rows]).startsWith('| MONTH |'));
});

test('cols로 열을 고르고(대소문자 무시·없는 이름은 버림), limit으로 행 수를 정한다', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ A: i, B: `b${i}`, C: 'c' }));
  const out = resolveTableData(tblock('step: 1\ncols: b, A, nope\nlimit: 3'), [many]);
  assert.strictEqual(out, ['| B | A |', '| --- | --- |', '| b0 | 0 |', '| b1 | 1 |', '| b2 | 2 |',
    '_(50행 중 처음 3행만 실었습니다 — 전부는 아래 ⚡ 패널에 있습니다)_'].join('\n'));
  // limit이 없으면 기본 행 수, 상한을 넘겨 적으면 상한까지
  assert.equal((resolveTableData(tblock('step: 1'), [many]).match(/^\| \d+ \|/gm) || []).length, DEFAULT_TABLE_ROWS);
  const big = Array.from({ length: MAX_TABLE_BLOCK_ROWS + 20 }, (_, i) => ({ A: i }));
  assert.equal((resolveTableData(tblock('step: 1\nlimit: 999'), [big]).match(/^\| \d/gm) || []).length, MAX_TABLE_BLOCK_ROWS);
  // cols가 전부 틀리면 앞 열들로 — 이름 하나 틀렸다고 표를 잃지 않는다
  assert.ok(resolveTableData(tblock('step: 1\ncols: x, y'), [rows]).startsWith('| MONTH | CNT |'));
});

test('cols를 적지 않은 넓은 결과는 앞 열들만 싣고 그 사실을 밝힌다', () => {
  const wide = [Object.fromEntries(Array.from({ length: MAX_TABLE_COLS + 5 }, (_, i) => [`C${i}`, i]))];
  const out = resolveTableData(tblock('step: 1'), [wide]);
  assert.equal((out.split('\n')[0].match(/\|/g) || []).length, MAX_TABLE_COLS + 1);
  assert.match(out, new RegExp(`${MAX_TABLE_COLS + 5}열 중 앞 ${MAX_TABLE_COLS}열만 실었습니다`));
});

test('0건·없는 스텝·번호 없는 참조는 안내 문장으로, 참조 없는 table 펜스는 그대로 둔다', () => {
  assert.strictEqual(resolveTableData(tblock('step: 1'), [[]]), '_실행 1의 조회 결과가 0건입니다_');
  assert.strictEqual(resolveTableData(tblock('step: 3'), [rows]), '_표를 채우지 못했습니다: 실행 3의 결과가 없습니다_');
  assert.strictEqual(resolveTableData(tblock('step: 1'), [null]), '_표를 채우지 못했습니다: 실행 1의 결과가 없습니다_');
  assert.strictEqual(resolveTableData(tblock('step: 없음'), [rows]), '_표를 채우지 못했습니다: step 참조에 실행 번호가 없습니다_');
  // 설정 줄도 참조도 없으면 모델이 펜스를 다른 용도로 쓴 것이다 — 펜스만 벗겨 본문이 그대로 렌더되게 한다.
  // 코드블록으로 남기면 화면이 파이프 원문을 코드로 보여주고(프런트는 chart·mermaid 펜스만 따로 알아본다)
  // 사용자는 그것이 무엇인지 모른다.
  assert.strictEqual(resolveTableData(tblock('| a | b |\n| 1 | 2 |'), [rows]), '| a | b |\n| 1 | 2 |');
  assert.strictEqual(resolveTableData(tblock('그냥 글', '  '), [rows]), '그냥 글');
  // 이 블록을 쓰려다 step만 빠뜨린 경우는 다르다 — 본문을 그대로 내보내면 'cols: A' 같은 설정 줄이
  // 답변 글자로 사용자에게 보인다.
  assert.match(resolveTableData(tblock('cols: A\nlimit: 5'), [rows]), /^_표를 채우지 못했습니다: step 참조가 없습니다_$/);
  assert.ok(!resolveTableData(tblock('cols: A\nlimit: 5'), [rows]).includes('cols:'));
  assert.strictEqual(resolveTableData('표 없는 답', [rows]), '표 없는 답');
});

test('표 블록도 스텝 번호는 이력의 절대 인덱스이고, 들여쓴 펜스는 같은 들여쓰기로 채운다', () => {
  const out = resolveTableData(tblock('step: 2', '  '), [null, rows]);
  assert.ok(out.startsWith('  | MONTH |') && out.includes('\n  | --- |'), out);
});

test('긴 셀과 총량 예산을 지킨다 — 표 하나가 답변을 통째로 차지하지 않는다', () => {
  const long = [{ T: 'x'.repeat(MAX_TABLE_CELL_LEN + 50) }];
  const out = resolveTableData(tblock('step: 1'), [long]);
  assert.ok(!out.includes('x'.repeat(MAX_TABLE_CELL_LEN + 1)), '셀이 상한을 넘겼다');
  const fat = Array.from({ length: MAX_TABLE_BLOCK_ROWS }, (_, i) => ({ A: `${i}-${'y'.repeat(MAX_TABLE_CELL_LEN)}`, B: 'z'.repeat(MAX_TABLE_CELL_LEN) }));
  const two = resolveTableData(`${tblock('step: 1\nlimit: 100')}\n\n${tblock('step: 1\nlimit: 100')}`, [fat]);
  assert.ok(two.length <= MAX_TABLE_INJECT_LEN + 400, `총량 예산을 넘었다: ${two.length}`);
  assert.match(two, /행만 실었습니다/, '다 싣지 못한 사실을 밝혀야 한다');
});

test('차트와 표 참조가 한 답변에 함께 있어도 각자 채워진다', () => {
  const out = resolveChartData(resolveTableData(`${tblock('step: 1\ncols: MONTH, CNT')}\n\n${block('type: bar\ndata: step 1')}`, [rows]), [rows]);
  assert.ok(out.startsWith('| MONTH | CNT |'));
  assert.ok(out.includes('```chart\ntype: bar\n| MONTH | CNT | AMT | NOTE |'));
});

test('참조 없는 블록은 채울 표의 예산을 나눠 갖지 않는다', () => {
  // 예산을 블록 수로 나누는데 참조 없는 블록까지 세면, 아무것도 쓰지 않는 블록이 몫을 가져가 정작 채우는
  // 표가 잘린다 (실측: 참조 없는 블록 넷이 섞이자 87행이 17행이 됐다).
  const wide = Array.from({ length: MAX_TABLE_BLOCK_ROWS }, (_, i) => ({ A: `${i}-${'x'.repeat(110)}`, B: 'y'.repeat(110), C: 'z'.repeat(110) }));
  const ref = tblock(`step: 1\nlimit: ${MAX_TABLE_BLOCK_ROWS}`);
  const refless = tblock('| a |\n| --- |\n| 1 |');
  const count = md => (resolveTableData(md, [wide]).match(/^\| \d+-x/gm) || []).length;
  const alone = count(ref);
  assert.ok(alone > 0);
  assert.equal(count([ref, refless, refless, refless, refless].join('\n\n')), alone, '참조 없는 블록이 예산을 가져갔다');
});
