// 차트 블록 계약 회귀 테스트 — 실행: npm test (frontend/)
// 이 계약도 조용히 깨진다: 차트를 못 그리면 표만 보이고(눈치채기 어렵다), 잘못 그리면 숫자가 아닌
// 값이 0으로, 문자열 날짜가 범주로 그려진 그래프가 '데이터'로 읽힌다.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseChartBlock, chartBlocksToTables, chartTableMarkdown, toNumber, toTime, pieSlices, clip, sliceSafe,
  chartNotes, fmtNum, pieLabelsOverflow, MAX_CHART_ROWS, MAX_SERIES, MAX_LABEL_LEN, MAX_PIE_SLICES,
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
  // y가 전부 틀리면(표에 없는 이름) 숫자 열 전부로 되돌아간다 (열 이름 하나로 차트 전체를 잃지 않는다)
  assert.deepStrictEqual(spec(`type: bar\ny: nothing\n${t}`).series.map(x => x.name), ['Cnt', 'Rate']);
  // 그러나 이름이 표에 있는 글자 열이면 다른 열로 바꿔 그리지 않는다 — 제목은 그 열인데 그래프는 딴 열이 된다
  assert.strictEqual(parseChartBlock(`type: bar\nx: name\ny: note\n${t}`).ok, false);
  assert.strictEqual(parseChartBlock(`type: bar\nx: name\ny: cnt\ny2: note\n${t}`).ok, false);
  // 하나라도 숫자 열이면 그것만 그린다
  assert.deepStrictEqual(spec(`type: bar\nx: name\ny: note, cnt\n${t}`).series.map(x => x.name), ['Cnt']);
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
  assert.strictEqual(toNumber('12 %'), 12);
  assert.strictEqual(toNumber('₩3,000'), 3000);
  assert.strictEqual(toNumber('-₩1,000'), -1000);
  assert.strictEqual(toNumber('$ 5'), 5);
  assert.strictEqual(toNumber('1,000,000.25'), 1000000.25);
  // 세 자리 묶음일 때만 구분자다 — '2024 01'·'1,2'가 숫자로 둔갑하면 글자 열이 숫자 열이 된다
  assert.strictEqual(toNumber('10 000'), 10000);
  assert.strictEqual(toNumber('2024 01'), null);
  assert.strictEqual(toNumber('1 2'), null);
  assert.strictEqual(toNumber('1,2'), null);
  assert.strictEqual(toNumber('1,0000'), null);
  assert.strictEqual(toNumber('1.234,56'), null);
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
  // xtype 을 명시해 시간축이 되면 읽지 못한 행은 빠지되 몇 행인지 남는다(차트 아래에 밝힌다); 추론한 축은 0
  const forced = spec('type: line\nxtype: time\n| d | v |\n|---|---|\n| 2024-01-01 | 1 |\n| 2024-01-02 | 2 |\n| 합계 | 3 |');
  assert.deepStrictEqual([forced.xKind, forced.rows.length, forced.skipped], ['time', 2, 1]);
  assert.strictEqual(line.skipped, 0);
  assert.strictEqual(bar.skipped, 0);
});

test('선·영역은 같은 x에 행이 여럿이면 그리지 않는다 — 막대와 산점도는 그린다', () => {
  // 피벗되지 않은 결과(일자×상태×건수)를 x: 일자 로 그리면 선이 같은 시각에서 오르내린다
  const t = '| 일자 | 상태 | 건수 |\n|---|---|---|\n| 2024-01-01 | A | 3 |\n| 2024-01-01 | B | 4 |\n| 2024-01-02 | A | 5 |';
  assert.strictEqual(parseChartBlock(`type: line\nx: 일자\ny: 건수\n${t}`).ok, false);
  assert.strictEqual(parseChartBlock(`type: area\nx: 일자\ny: 건수\n${t}`).ok, false);
  assert.strictEqual(parseChartBlock(`type: bar\nx: 일자\ny: 건수\n${t}`).ok, true);
  assert.strictEqual(parseChartBlock(`type: scatter\nx: 일자\ny: 건수\n${t}`).ok, true);
  // 범주 축의 선도 마찬가지다(같은 라벨이 두 눈금으로 선다)
  assert.strictEqual(parseChartBlock('type: line\n| 구분 | v |\n|---|---|\n| 가 | 1 |\n| 가 | 2 |').ok, false);
  assert.strictEqual(parseChartBlock('type: line\n| 구분 | v |\n|---|---|\n| 가 | 1 |\n| 나 | 2 |').ok, true);
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
  // 뺀 행은 세어서 내보낸다 — 표에는 네 행인데 그림은 두 조각이라, 밝히지 않으면 비율의 분모가
  // 달라진 것을 사용자가 알 수 없다 (Chart.jsx가 이 수로 안내를 붙인다).
  assert.strictEqual(s.dropped, 2);
  assert.strictEqual(spec('type: bar\n| a | b |\n|---|---|\n| x | 0 |\n| y | 1 |').dropped, 0);
  assert.strictEqual(spec('type: donut\n| a | b |\n|---|---|\n| x | 1 |').type, 'pie');
});

test('pieSlices: 조각이 많으면 값이 큰 것을 남기고 나머지를 기타로 모은다 — 표 순서의 꼬리가 아니다', () => {
  const rows = n => Array.from({ length: n }, (_, i) => ({ label: `c${i}`, full: `C${i}`, values: [i + 1] }));
  // 상한 이하는 그대로
  assert.deepStrictEqual(pieSlices(rows(MAX_PIE_SLICES)).map(d => d.name), rows(MAX_PIE_SLICES).map(r => r.label));
  assert.deepStrictEqual(pieSlices(rows(2))[0], { name: 'c0', full: 'C0', value: 1 });
  // 15조각, 값은 1..15 — 큰 11개(5..15)를 표 순서대로 남기고 1..4(합 10)가 기타
  const out = pieSlices(rows(15));
  assert.strictEqual(out.length, MAX_PIE_SLICES);
  assert.deepStrictEqual(out.slice(0, -1).map(d => d.name), ['c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12', 'c13', 'c14']);
  // 모아 놓은 조각은 full에도 개수가 남는다 — 좁은 화면 범례와 툴팁이 full을 이름으로 쓰기 때문이다
  assert.deepStrictEqual(out.at(-1), { name: '기타 (4)', full: '기타 (4)', value: 10 });
  // 이름순 결과에서 큰 조각이 뒤에 있어도 조각으로 남는다
  const mixed = rows(15).map((r, i) => ({ ...r, values: [i === 14 ? 500 : i === 0 ? 400 : 1] }));
  const names = pieSlices(mixed).map(d => d.name);
  assert.ok(names.includes('c14') && names.includes('c0'));
  assert.strictEqual(pieSlices(mixed).at(-1).value, 4);
  // max 를 넘겨 조각 수를 바꿀 수 있다
  assert.deepStrictEqual(pieSlices(rows(5), 3).map(d => [d.name, d.value]), [['c3', 4], ['c4', 5], ['기타 (3)', 6]]);
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
  // GFM 규칙대로 `\\` 는 역슬래시 하나, `\\\|` 는 역슬래시 + 파이프(서버 cell()이 이렇게 적는다); 홀로 선 역슬래시는 글자
  const bs = spec('type: bar\n| a | b |\n| C:\\\\dir | 1 |\n| a\\\\\\|b | 2 |\n| x\\y | 3 |');
  assert.deepStrictEqual(bs.rows.map(r => r.x), ['C:\\dir', 'a\\|b', 'x\\y']);
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
  // 구분 줄이 빠진 표는 채워서 보낸다 — 화면(chartTableMarkdown)이 채워 그린 것과 같은 표여야 한다.
  // 그러지 않으면 모델의 '## 최근 대화'에는 표가 아닌 파이프 글자 묶음이 실린다.
  assert.strictEqual(chartBlocksToTables('```chart\r\n| a | b |\r\n| x | 1 |\r\n```\r\n뒤'), '| a | b |\n| --- | --- |\n| x | 1 |\n뒤');
  // markdown 파서가 펜스로 읽는 것은 다 잡는다: 4칸 들여쓰기(`10. ` 항목 안)·언어 뒤 덧말·백틱 4개로 닫기
  assert.strictEqual(chartBlocksToTables('10. 항목\n    ```chart\n    | a | b |\n    | x | 1 |\n    ```'), '10. 항목\n    | a | b |\n    | --- | --- |\n    | x | 1 |');
  assert.strictEqual(chartBlocksToTables('```chart 월별\n| a | b |\n| x | 1 |\n````'), '| a | b |\n| --- | --- |\n| x | 1 |');
  assert.strictEqual(chartBlocksToTables('```charts\n| a | b |\n```'), '```charts\n| a | b |\n```');
  // 물결 펜스(~~~chart)와 백틱 넷 펜스도 markdown은 펜스로 읽어 화면에 차트가 선다 — 이력에서도 표여야 한다
  // (실측: 이 둘이 이력에는 설정 줄째 그대로 실려 갔다). 닫는 펜스는 여는 것과 같은 글자·같은 수 이상이다:
  // ````chart 안의 ``` 줄은 markdown에게 끝이 아니라 내용이고, ~~~를 ```로는 닫지 못한다.
  assert.strictEqual(chartBlocksToTables('~~~chart\ntitle: 물결\n| a | b |\n| x | 1 |\n~~~'), '물결\n| a | b |\n| --- | --- |\n| x | 1 |');
  assert.strictEqual(chartBlocksToTables('````chart\n| a | b |\n```\n| x | 1 |\n````'), '| a | b |\n| --- | --- |\n| x | 1 |');
  assert.strictEqual(chartBlocksToTables('````chart\n| a | b |\n```'), '````chart\n| a | b |\n```');
  assert.strictEqual(chartBlocksToTables('~~~chart\n| a | b |\n```'), '~~~chart\n| a | b |\n```');
    assert.strictEqual(chartBlocksToTables('```chart\n| a | b |\n```~'), '```chart\n| a | b |\n```~'); // 섞인 글자는 닫는 펜스가 아니다
    // 빈 블록(여는 펜스 바로 아래 닫는 펜스)도 markdown에게는 닫힌 블록이다 — 본문 한 줄을 요구하면 그 여는 펜스가
    // 다음 차트 블록의 닫는 펜스와 짝이 되어 사이의 문장까지 삼킨다(실측: 빈 블록 뒤의 설명 문장이 이력에서 사라졌다).
    assert.strictEqual(chartBlocksToTables('```chart\n```\n\n설명\n\n```chart\n| a | b |\n| x | 1 |\n```'), '\n\n설명\n\n| a | b |\n| --- | --- |\n| x | 1 |');
    // 첫 본문 줄이 더 긴 같은 글자 펜스면 그것이 닫는 펜스다(빈 블록) — 뒤의 표는 블록 밖이다
    assert.strictEqual(chartBlocksToTables('```chart\n````\n| x | 1 |\n```'), '\n| x | 1 |\n```');
  // 긴 표는 20행 + 건수
  const rows = Array.from({ length: 25 }, (_, i) => `| r${i} | ${i} |`);
  const out = chartBlocksToTables(`\`\`\`chart\n| a | b |\n|---|---|\n${rows.join('\n')}\n\`\`\``);
  assert.strictEqual(out.split('\n').length, 2 + 20 + 1); // 머리글 + 구분 줄 + 20행 + 건수
  assert.ok(out.endsWith('(외 5행)'));
  // 목록 안의 블록에서 우리가 새로 적는 줄(제목·건수)도 펜스의 들여쓰기를 따른다. 표 줄은 원문의
  // 들여쓰기를 그대로 두는데 이 줄들만 왼쪽 끝에 붙으면 제목이 목록 밖의 문단이 되어 항목이 거기서
  // 끝나고, 뒤의 표는 목록에서 떨어져 나간다(실측: `목록 안\n    | a | b |…`로 나갔다).
  const inList = `1. 항목\n\n    \`\`\`chart\n    title: 목록 안\n    | a | b |\n    |---|---|\n${
    Array.from({ length: 21 }, (_, i) => `    | r${i} | ${i} |`).join('\n')}\n    \`\`\``;
  const listOut = chartBlocksToTables(inList);
  assert.ok(listOut.startsWith('1. 항목\n\n    목록 안\n    | a | b |\n    |---|---|\n    | r0 | 0 |'), listOut);
  assert.ok(listOut.endsWith('    | r19 | 19 |\n    (외 1행)'), listOut);
  // 차트가 아닌 코드펜스와 닫히지 않은 펜스는 그대로
  assert.strictEqual(chartBlocksToTables('```sql\nselect 1\n```'), '```sql\nselect 1\n```');
  assert.strictEqual(chartBlocksToTables('```chart\ntype: bar\n| a | b |'), '```chart\ntype: bar\n| a | b |');
  // 표 없이 제목만 남은 블록은 제목 한 줄, 아무것도 없으면 빈 줄
  assert.strictEqual(chartBlocksToTables('```chart\ntitle: 제목\ndata: step 1\n```'), '제목');
  assert.strictEqual(chartBlocksToTables('```chart\ntype: bar\n```'), '');
});

// 값 읽기의 실패 방향은 한쪽으로만 열려 있어야 한다: 읽지 못하면 빈칸(그리지 않음)이지, 그럴듯한
// 숫자로 읽어 없는 값을 그려서는 안 된다. 아래 두 가지는 실제로 그렇게 새던 자리다.
test('구분자가 섞인 표기는 숫자가 아니다 — 묶음은 자리가 맞을 때만 벗긴다', () => {
  assert.strictEqual(toNumber('1 234,567'), null);   // 섞였다 (되참조가 없으면 1234567로 읽혔다)
  assert.strictEqual(toNumber('1,234 567'), null);
  assert.strictEqual(toNumber('1,234,567'), 1234567); // 같은 구분자로 자리가 맞는다
  assert.strictEqual(toNumber('1 234 567'), 1234567);
  assert.strictEqual(toNumber('1,2'), null);          // 자리가 안 맞는다
  assert.strictEqual(toNumber('2024 01'), null);
});

test('시각도 범위를 넘으면 날짜가 아니다 — 넘긴 값은 조용히 다른 시각이 된다', () => {
  assert.strictEqual(toTime('2024-01-01 12:99'), null);  // Date는 13:39로 넘겨 버린다
  assert.strictEqual(toTime('2024-01-01 24:00'), null);
  assert.strictEqual(toTime('2024-01-01 12:30:99'), null);
  assert.strictEqual(new Date(toTime('2024-01-01 23:59:59')).getHours(), 23);
  assert.strictEqual(new Date(toTime('2024-01-01 12:30')).getMinutes(), 30);
});

test('pie·scatter는 y2를 그리지 않으므로 그 설정 때문에 차트를 포기하지 않는다', () => {
  const t = '| 상태 | 건수 | 비고 |\n|---|---|---|\n| 가 | 3 | 좋음 |\n| 나 | 4 | 나쁨 |';
  // y2가 글자 열이어도 원그래프는 그린다 (그 설정은 원그래프가 쓰지 않는다)
  const pie = spec(`type: pie\ny2: 비고\n${t}`);
  assert.deepStrictEqual(pie.series, [{ name: '건수', axis: 'left' }]);
  // y2만 적었으면 그 열을 왼쪽에 그린다 — 축이 하나뿐인 그래프에서 '오른쪽'은 없다
  assert.deepStrictEqual(spec(`type: pie\ny2: 건수\n${t}`).series, [{ name: '건수', axis: 'left' }]);
  assert.deepStrictEqual(spec(`type: bar\ny2: 건수\n${t}`).series, [{ name: '건수', axis: 'left' }]);
  // 막대에서는 y2가 글자 열이면 그대로 포기한다 (오른쪽 축에 두라던 열을 왼쪽에 그리면 조용한 오답이다)
  assert.strictEqual(parseChartBlock(`type: bar\ny2: 비고\n${t}`).ok, false);
});

test('차트 안내 문구: 빠진 행을 밝히고, 조사는 축의 표기를 따른다', () => {
  // 문구는 순수 함수(chartNotes)가 만든다 — JSX 안에 문자열이 살면 이 결함은 브라우저에서만
  // 보인다. 실제로 xtype: number의 skipped 문구가 '숫자' + '으로'로 붙어 '숫자으로'로 나가고
  // 있었다(화면 재현으로 확인). 명세는 손으로 짓지 않고 진짜 파서에 원문을 넣어 받는다 —
  // 여기서 spec 모양을 지어내면 파서가 skipped를 세는 방식이 바뀐 날 검사만 옛 모양을 본다.
  const num = spec('type: scatter\nxtype: number\n| x | y |\n|---|---|\n| 10 | 1 |\n| 합계 | 9 |');
  assert.deepStrictEqual(chartNotes(num), ['x를 숫자로 읽지 못한 1행은 그리지 않았습니다.']);
  const time = spec('type: line\nxtype: time\n| 일자 | 값 |\n|---|---|\n| 2024-01-01 | 1 |\n| 합계 | 9 |\n| 2024-01-02 | 2 |');
  assert.deepStrictEqual(chartNotes(time), ['x를 시간으로 읽지 못한 1행은 그리지 않았습니다.']);
  const pie = spec('type: pie\n| 항목 | 값 |\n|---|---|\n| 가 | 5 |\n| 나 | 0 |\n| 다 | - |');
  assert.deepStrictEqual(chartNotes(pie), ['값이 없거나 0 이하인 2행은 조각으로 그리지 않았습니다.']);
  const rows = Array.from({ length: MAX_CHART_ROWS + 3 }, (_, i) => `| 항목${i} | ${i + 1} |`).join('\n');
  const clipped = spec(`type: bar\n| 항목 | 값 |\n|---|---|\n${rows}`);
  assert.deepStrictEqual(chartNotes(clipped), [`처음 ${MAX_CHART_ROWS}행만 그렸습니다 (전체 ${MAX_CHART_ROWS + 3}행).`]);
  // 빠진 행이 없는 차트에는 아무 문구도 붙지 않는다 — 문구가 곧 '빠졌다'는 신호이기 때문이다
  assert.deepStrictEqual(chartNotes(spec(`type: bar\n${TABLE}`)), []);
});

test('원그래프 바깥 라벨의 자리: Recharts가 놓는 자리 그대로 세어, 들어가지 않는 글자만 안으로 보낸다', () => {
  // 상자 폭 하나로 가르던 때에는(380px 아래에서만 안으로) 데스크톱 폭에서도 스무 자 이름이 양끝에서
  // 잘렸다(화면 재현으로 확인: 폭 574px 상자에서 네 이름의 폭이 227·208·212·149px일 때 왼쪽 24px·
  // 오른쪽 3px). 같은 자리에 100px 이름은 들어간다. 그리는 쪽(Chart.jsx useLabelsFit)은 글자의 폭만
  // 재어 여기에 묻는다 — 자리의 셈은 Recharts를 따른다: 여백 4px을 뺀 짧은 변(260-8)의 절반에 0.72를
  // 곱한 반지름에 20px을 더한 점에서, 중심의 오른쪽이면 오른쪽 끝까지, 왼쪽이면 왼쪽 끝까지가 자리다.
  const box = { width: 574, height: 260, margin: 4, radiusRatio: 0.72 };
  assert.strictEqual(pieLabelsOverflow({ ...box, values: [40, 35, 30, 25], widths: [227, 208, 212, 149] }), true);
  assert.strictEqual(pieLabelsOverflow({ ...box, values: [40, 35, 30, 25], widths: [100, 100, 100, 100] }), false);
  // 조각 하나뿐이면 가운데 각도가 180°(9시)라 왼쪽으로 뻗는다 — 자리는 중심에서 라벨 점까지를 뺀 나머지다
  const room = 574 / 2 - (0.72 * ((260 - 8) / 2) + 20);
  assert.strictEqual(pieLabelsOverflow({ ...box, values: [1], widths: [room - 1] }), false);
  assert.strictEqual(pieLabelsOverflow({ ...box, values: [1], widths: [room + 1] }), true);
  // 자리는 각도에 달려 있다: 반반이면 가운데 각도가 90°(12시)·270°(6시)라 라벨 점이 중심에 서고,
  // 그때는 양쪽 중 좁은 쪽(상자의 반)이 자리다 — 3시 방향이라면 들어가지 못했을 글자가 여기서는 들어간다.
  assert.strictEqual(pieLabelsOverflow({ ...box, values: [1, 1], widths: [280, 280] }), false);
  assert.strictEqual(pieLabelsOverflow({ ...box, values: [1, 1], widths: [300, 0] }), true);
  // 좁은 상자에서는 짧은 이름도 들어가지 않는다 — 지금까지 380px 아래에서 안으로 보내던 길이 여기 있다
  assert.strictEqual(pieLabelsOverflow({ ...box, width: 340, values: [1], widths: [80] }), true);
  // 상자의 크기를 아직 모르면(0) 넘칠 것도 없다 — 크기가 서면 그리는 쪽이 다시 묻는다
  assert.strictEqual(pieLabelsOverflow({ ...box, width: 0, values: [1], widths: [999] }), false);
});

test('자르기는 상한을 넘지 않고 서로게이트 쌍을 쪼개지 않는다', () => {
  assert.strictEqual(clip('abcd', 4), 'abcd');
  assert.strictEqual(clip('abcd', 3), 'ab…');
  assert.strictEqual(clip('abcd', 1), 'a');   // …를 붙일 자리가 없다
  assert.strictEqual(clip('abcd', 0), '');
  assert.strictEqual(sliceSafe('ab', -1), '');
  // 이모지가 경계에 걸리면 짝 잃은 코드유닛이 남아 화면에서 U+FFFD가 된다
  const emoji = `${'가'.repeat(58)}🙂꼬리`;
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clip(emoji, 60)));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(sliceSafe(emoji, 59)));
  assert.ok(clip(emoji, 60).length <= 60);
});

test('차트의 숫자 표기: 소수 두 자리로 담기지 않는 작은 값을 0이라고 말하지 않는다', () => {
  // 축 눈금과 툴팁이 같은 함수를 쓴다(Chart.jsx). 소수 두 자리로 자르던 때에는 비율 열(0.0012)의
  // 축이 통째로 '0'이었고, 막대에 손을 얹은 사람은 값이 0이라는 답을 들었다 — 표에는 있는 값을
  // 그림이 없다고 말하는 조용한 오답이라, 이 파일이 막으려던 것과 같은 결함이다(화면 재현으로 확인).
  assert.strictEqual(fmtNum(0.0012), '0.0012');
  assert.strictEqual(fmtNum(-0.001), '-0.001');
  assert.strictEqual(fmtNum(0.000025), '0.000025');
  // 아주 작은 값은 지수로 — 유효숫자로만 세면 눈금 하나가 수백 자가 된다(모델이 쓴 표에는 무엇이든 온다)
  assert.ok(fmtNum(5e-324).length <= 12, `아주 작은 값의 표기가 길다: ${fmtNum(5e-324)}`);
  assert.strictEqual(Number(fmtNum(1e-7)), 1e-7);
  // 0.01 이상은 지금까지의 표기 그대로다 — 천 단위 쉼표와 소수 두 자리
  assert.strictEqual(fmtNum(0), '0');
  assert.strictEqual(fmtNum(0.01), '0.01');
  assert.strictEqual(fmtNum(0.5), '0.5');
  assert.strictEqual(fmtNum(1234.567), '1,234.57');
  assert.strictEqual(fmtNum(1234567), '1,234,567');
  // 값이 없는 칸은 빈 글자다 — 결측을 0으로 그리지 않는다는 규칙이 표기에서도 같아야 한다
  // (툴팁은 toNumber가 null로 둔 칸을 그대로 받는다)
  for (const v of [null, undefined, NaN, Infinity, -Infinity, '3', {}]) assert.strictEqual(fmtNum(v), '');
});
