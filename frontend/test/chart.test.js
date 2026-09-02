// 차트 블록 계약 회귀 테스트 — 실행: npm test (frontend/)
// 이 계약도 조용히 깨진다: 차트를 못 그리면 표만 보이고(눈치채기 어렵다), 잘못 그리면 숫자가 아닌
// 값이 0으로, 문자열 날짜가 범주로 그려진 그래프가 '데이터'로 읽힌다.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseChartBlock, chartBlocksToTables, chartTableMarkdown, toNumber, toTime,
  MAX_CHART_ROWS, MAX_SERIES, MAX_LABEL_LEN,
} from '../src/chart.js';

const TABLE = '| 월 | 건수 | 금액 |\n|---|---|---|\n| 2024-01 | 120 | 1,000 |\n| 2024-02 | 80 | 2,500 |';
const spec = text => { const r = parseChartBlock(text); assert.ok(r.ok, r.reason); return r.spec; };

test('설정 줄 + GFM 표를 차트 명세로 읽는다', () => {
  const s = spec(`type: bar\ntitle: 월별 처리\n${TABLE}`);
  assert.strictEqual(s.type, 'bar');
  assert.strictEqual(s.title, '월별 처리');
  assert.strictEqual(s.xKind, 'category');
  assert.strictEqual(s.xName, '월');
  assert.deepStrictEqual(s.series, [{ name: '건수', axis: 'left' }, { name: '금액', axis: 'left' }]);
  // 천 단위 쉼표는 숫자의 일부다
  assert.deepStrictEqual(s.rows.map(r => r.values), [[120, 1000], [80, 2500]]);
  assert.deepStrictEqual(s.rows.map(r => r.x), ['2024-01', '2024-02']);
});

test('x·y·y2로 열을 고른다 — 이름은 대소문자·공백을 가리지 않고, 없는 이름은 버린다', () => {
  const t = '| Name | Cnt | Rate | Note |\n|---|---|---|---|\n| a | 1 | 0.5 | x |\n| b | 2 | 0.7 | y |';
  const s = spec(`type: bar\nx: name\ny: CNT, nope\ny2: rate\n${t}`);
  assert.deepStrictEqual(s.series, [{ name: 'Cnt', axis: 'left' }, { name: 'Rate', axis: 'right' }]);
  assert.deepStrictEqual(s.rows.map(r => r.values), [[1, 0.5], [2, 0.7]]);
  // y가 전부 틀리면 숫자 열 전부로 되돌아간다 (열 이름 하나로 차트 전체를 잃지 않는다)
  assert.deepStrictEqual(spec(`type: bar\ny: nothing\n${t}`).series.map(x => x.name), ['Cnt', 'Rate']);
  // 글자가 섞인 열(Note)은 y를 비워도 시리즈가 되지 않는다
  assert.deepStrictEqual(spec(`type: bar\n${t}`).series.map(x => x.name), ['Cnt', 'Rate']);
  // y2만 적었고 왼쪽에 그릴 것이 없으면 그 열을 왼쪽에 그린다
  assert.deepStrictEqual(spec('type: bar\ny2: v\n| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |').series, [{ name: 'v', axis: 'left' }]);
  // 오른쪽 축은 둘까지 — 셋째 y2 열은 y가 비었어도 왼쪽 축으로 흘러가지 않는다
  const t4 = '| k | a | b | c | d |\n|---|---|---|---|---|\n| p | 1 | 2 | 3 | 4 |\n| q | 2 | 3 | 4 | 5 |';
  assert.deepStrictEqual(spec(`type: bar\ny2: b, c, d\n${t4}`).series, [{ name: 'a', axis: 'left' }, { name: 'b', axis: 'right' }, { name: 'c', axis: 'right' }]);
});

test('숫자로 읽히지 않는 값은 0이 아니라 빈칸이고, 숫자 열이 없으면 차트를 포기한다', () => {
  const s = spec('type: line\n| d | v |\n|---|---|\n| 2024-01-01 | 5 |\n| 2024-01-02 | - |\n| 2024-01-03 | 7 |');
  assert.deepStrictEqual(s.rows.map(r => r.values[0]), [5, null, 7]);
  assert.strictEqual(parseChartBlock('type: bar\n| a | b |\n|---|---|\n| x | 12건 |\n| y | 3건 |').ok, false);
  assert.strictEqual(parseChartBlock('type: bar\n| a | b |\n|---|---|').ok, false);
  assert.strictEqual(parseChartBlock('type: bar\n그냥 글').ok, false);
  assert.strictEqual(parseChartBlock('').ok, false);
  // 범주가 빈 행(NULL 그룹)은 버리지 않고 이름을 붙여 남긴다; 값이 전부 결측인 행도 구분 줄로 오인하지 않는다
  const e = spec('type: bar\n| g | v |\n|---|---|\n|  | 5 |\n| - | - |\n| a | 7 |');
  assert.deepStrictEqual(e.rows.map(r => [r.label, r.values[0]]), [['(빈값)', 5], ['-', null], ['a', 7]]);
});

test('toNumber / toTime 의 경계', () => {
  assert.strictEqual(toNumber(' 1,234.5 '), 1234.5);
  assert.strictEqual(toNumber('12%'), 12);
  assert.strictEqual(toNumber('₩3,000'), 3000);
  assert.strictEqual(toNumber('-7'), -7);
  assert.strictEqual(toNumber('1e3'), 1000);
  assert.strictEqual(toNumber(''), null);
  assert.strictEqual(toNumber('N/A'), null);
  assert.strictEqual(toNumber('2024-01'), null);
  assert.strictEqual(toNumber('1.2k'), null);
  assert.strictEqual(toTime('2024-03-05'), new Date(2024, 2, 5).getTime());
  assert.strictEqual(toTime('2024/3/5 14:30'), new Date(2024, 2, 5, 14, 30).getTime());
  assert.strictEqual(toTime('2024.03'), new Date(2024, 2, 1).getTime());
  assert.strictEqual(toTime('2024-01-01T09:00:00'), new Date(2024, 0, 1, 9).getTime());
  // Oracle TIMESTAMP WITH TIME ZONE 표기의 오프셋은 읽되 무시한다
  assert.strictEqual(toTime('2024-01-01 09:00:00 +09:00'), new Date(2024, 0, 1, 9).getTime());
  assert.strictEqual(toTime('2024-01-01T09:00:00Z'), new Date(2024, 0, 1, 9).getTime());
  assert.strictEqual(toTime('2024-01-01 09:00:00 +9'), null);
  assert.strictEqual(toTime('2024-13-01'), null);
  assert.strictEqual(toTime('2024-02-30'), null);
  // 네 자리 해는 적힌 그대로 — Date 생성자의 0~99년 → 1900년대 보정을 타지 않는다
  assert.strictEqual(new Date(toTime('0099-01-01')).getFullYear(), 99);
  // 구분자 없는 8자리는 명시했을 때만 날짜다 (코드일 수 있다)
  assert.strictEqual(toTime('20240305'), null);
  assert.strictEqual(toTime('20240305', true), new Date(2024, 2, 5).getTime());
  assert.strictEqual(toTime('2024', true), new Date(2024, 0, 1).getTime());
});

test('선·영역 그래프의 날짜 x는 시간축이 되고 시간순으로 선다; 막대는 범주로 남는다', () => {
  const t = '| d | v |\n|---|---|\n| 2024-02-01 | 2 |\n| 2024-01-01 | 1 |';
  const line = spec(`type: line\n${t}`);
  assert.strictEqual(line.xKind, 'time');
  assert.deepStrictEqual(line.rows.map(r => r.label), ['2024-01-01', '2024-02-01']);
  assert.strictEqual(typeof line.rows[0].x, 'number');
  const bar = spec(`type: bar\n${t}`);
  assert.strictEqual(bar.xKind, 'category');
  assert.deepStrictEqual(bar.rows.map(r => r.x), ['2024-02-01', '2024-01-01']); // 순서 그대로
  // xtype: time 을 명시한 막대는 시간순으로 줄만 선다
  assert.deepStrictEqual(spec(`type: bar\nxtype: time\n${t}`).rows.map(r => r.x), ['2024-01-01', '2024-02-01']);
  // xtype: category 를 명시하면 날짜라도 범주다
  assert.strictEqual(spec(`type: line\nxtype: category\n${t}`).xKind, 'category');
  // 날짜가 하나라도 아니면 시간축을 추론하지 않는다
  assert.strictEqual(spec('type: line\n| d | v |\n|---|---|\n| 2024-01-01 | 1 |\n| 합계 | 1 |').xKind, 'category');
});

test('산점도는 x가 수치여야 한다', () => {
  const s = spec('type: scatter\n| 크기 | 시간 | 이름 |\n|---|---|---|\n| 30 | 1.5 | b |\n| 10 | 0.4 | a |');
  assert.strictEqual(s.xKind, 'number');
  assert.deepStrictEqual(s.series, [{ name: '시간', axis: 'left' }]); // 값은 하나만
  assert.deepStrictEqual(s.rows.map(r => r.x), [10, 30]); // 정렬
  assert.strictEqual(parseChartBlock('type: scatter\n| 이름 | 값 |\n|---|---|\n| a | 1 |').ok, false);
  assert.strictEqual(spec('type: scatter\n| d | v |\n|---|---|\n| 2024-01-01 | 1 |').xKind, 'time');
});

test('원그래프는 첫 숫자 열 하나만, 0 이하와 결측 조각은 뺀다', () => {
  const s = spec('type: pie\n| 상태 | 건수 | 비율 |\n|---|---|---|\n| 완료 | 30 | 60 |\n| 대기 | 0 | 0 |\n| 실패 | -1 | 0 |\n| 진행 | 20 | 40 |');
  assert.deepStrictEqual(s.series, [{ name: '건수', axis: 'left' }]);
  assert.deepStrictEqual(s.rows.map(r => [r.x, r.values[0]]), [['완료', 30], ['진행', 20]]);
  assert.strictEqual(spec('type: donut\n| a | b |\n|---|---|\n| x | 1 |').type, 'pie');
});

test('모르는 type은 막대, 별칭은 정규화, 상한(행·시리즈·라벨)을 지킨다', () => {
  assert.strictEqual(spec('type: whatever\n| a | b |\n|---|---|\n| x | 1 |').type, 'bar');
  assert.strictEqual(spec('| a | b |\n|---|---|\n| x | 1 |').type, 'bar');
  assert.strictEqual(spec('type: Stacked Bar\n| a | b |\n|---|---|\n| x | 1 |').type, 'stacked-bar');
  assert.strictEqual(spec('type: stacked_bar\n| a | b |\n|---|---|\n| x | 1 |').type, 'stacked-bar');
  assert.strictEqual(spec('type: column\n| a | b |\n|---|---|\n| x | 1 |').type, 'bar');

  const many = ['| i | v |', '|---|---|', ...Array.from({ length: MAX_CHART_ROWS + 5 }, (_, i) => `| r${i} | ${i} |`)].join('\n');
  const s = spec(`type: bar\n${many}`);
  assert.strictEqual(s.rows.length, MAX_CHART_ROWS);
  assert.strictEqual(s.clipped, true);
  assert.strictEqual(s.total, MAX_CHART_ROWS + 5);

  const cols = Array.from({ length: MAX_SERIES + 3 }, (_, i) => `c${i}`);
  const wide = `| k | ${cols.join(' | ')} |\n|${'---|'.repeat(cols.length + 1)}\n| a | ${cols.map((_, i) => i).join(' | ')} |`;
  assert.strictEqual(spec(`type: line\n${wide}`).series.length, MAX_SERIES);
  // y2가 있으면 그만큼 왼쪽이 줄어 합이 상한이다
  const w2 = spec(`type: line\ny2: c0\n${wide}`);
  assert.strictEqual(w2.series.length, MAX_SERIES);
  assert.strictEqual(w2.series.filter(x => x.axis === 'right').length, 1);

  const long = spec(`type: bar\n| a | b |\n|---|---|\n| ${'가'.repeat(50)} | 1 |`);
  assert.strictEqual(long.rows[0].label.length, MAX_LABEL_LEN);
  assert.strictEqual(long.rows[0].full.length, 50);
});

test('표 안의 \\| 와 구분 줄 생략, 표 뒤의 설명 줄을 받아들인다', () => {
  const s = spec('type: bar\n| a | b |\n| x\\|y | 1 |\n| z | 2 |\n위 표는 예시다\ntype: 이건 설정이 아니다');
  assert.deepStrictEqual(s.rows.map(r => r.x), ['x|y', 'z']);
  assert.strictEqual(s.type, 'bar');
  // 서버가 채우지 못한 data 참조만 남았으면 차트가 아니다
  assert.strictEqual(parseChartBlock('type: bar\ndata: step 2').ok, false);
  // 이미 표가 있으면 data 줄은 무시한다
  assert.strictEqual(parseChartBlock('type: bar\ndata: step 2\n| a | b |\n|---|---|\n| x | 1 |').ok, true);
  // 홀로 선 \r도 줄 끝이다(markdown과 같은 규칙) — 펜스 안의 글자는 원문 그대로 온다
  const cr = spec('type: bar\rtitle: t\r\n| a | b |\r| x | 1 |');
  assert.strictEqual(cr.title, 't');
  assert.deepStrictEqual(cr.rows.map(r => r.values[0]), [1]);
});

test('chartTableMarkdown: 표만 남기고, 구분 줄이 없으면 넣어 준다', () => {
  assert.strictEqual(chartTableMarkdown(`type: bar\ntitle: t\n${TABLE}`), TABLE);
  assert.strictEqual(chartTableMarkdown('type: bar\n| a | b |\n| x | 1 |'), '| a | b |\n| --- | --- |\n| x | 1 |');
  assert.strictEqual(chartTableMarkdown('type: bar\ndata: step 1'), '');
  // 구분 줄의 칸 수가 머리글과 다르면 GFM이 표로 읽지 않는다 — 머리글에 맞춰 다시 만든다. 맞으면 정렬 표시까지 그대로.
  assert.strictEqual(chartTableMarkdown('| a | b |\n| --- |\n| 1 | 2 |'), '| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.strictEqual(chartTableMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |'), '| a | b |\n|:--|--:|\n| 1 | 2 |');
  assert.strictEqual(chartTableMarkdown('type: bar\n    | a | b |\n    | 1 | 2 |'), '| a | b |\n| --- | --- |\n| 1 | 2 |');
});

test('chartBlocksToTables: 이력으로 보낼 때 펜스·설정을 벗기고 표(20행)만 남긴다', () => {
  const md = `앞 문장\n\n\`\`\`chart\ntype: bar\ntitle: 월별 처리\n${TABLE}\n\`\`\`\n\n뒤 문장`;
  assert.strictEqual(chartBlocksToTables(md), `앞 문장\n\n월별 처리\n${TABLE}\n\n뒤 문장`);
  // 대소문자·들여쓰기(목록 안)·CRLF
  assert.strictEqual(chartBlocksToTables('  ```Chart\r\ntype: pie\r\n| a | b |\r\n|---|---|\r\n| x | 1 |\r\n  ```'), '| a | b |\n|---|---|\n| x | 1 |');
  assert.strictEqual(chartBlocksToTables('```chart\r\n| a | b |\r\n| x | 1 |\r\n```\r\n뒤'), '| a | b |\n| x | 1 |\n뒤');
  // markdown 파서가 펜스로 읽는 것은 다 잡는다: 4칸 들여쓰기(`10. ` 항목 안)·언어 뒤 덧말·백틱 4개로 닫기
  assert.strictEqual(chartBlocksToTables('10. 항목\n    ```chart\n    | a | b |\n    | x | 1 |\n    ```'), '10. 항목\n    | a | b |\n    | x | 1 |');
  assert.strictEqual(chartBlocksToTables('```chart 월별\n| a | b |\n| x | 1 |\n````'), '| a | b |\n| x | 1 |');
  assert.strictEqual(chartBlocksToTables('```charts\n| a | b |\n```'), '```charts\n| a | b |\n```');
  // 긴 표는 20행 + 건수
  const rows = Array.from({ length: 25 }, (_, i) => `| r${i} | ${i} |`);
  const out = chartBlocksToTables(`\`\`\`chart\n| a | b |\n|---|---|\n${rows.join('\n')}\n\`\`\``);
  assert.strictEqual(out.split('\n').length, 2 + 20 + 1);
  assert.ok(out.endsWith('(외 5행)'));
  // 차트가 아닌 코드펜스와 닫히지 않은 펜스는 그대로
  assert.strictEqual(chartBlocksToTables('```sql\nselect 1\n```'), '```sql\nselect 1\n```');
  assert.strictEqual(chartBlocksToTables('```chart\ntype: bar\n| a | b |'), '```chart\ntype: bar\n| a | b |');
  // 표 없이 제목만 남은 블록은 제목 한 줄, 아무것도 없으면 빈 줄
  assert.strictEqual(chartBlocksToTables('```chart\ntitle: 제목\ndata: step 1\n```'), '제목');
  assert.strictEqual(chartBlocksToTables('```chart\ntype: bar\n```'), '');
});
