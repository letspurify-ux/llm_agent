// 차트 블록 계약 회귀 테스트 — 실행: npm test (frontend/)
// 이 계약도 조용히 깨진다: 차트를 못 그리면 표만 보이고(눈치채기 어렵다), 잘못 그리면 숫자가 아닌
// 값이 0으로, 문자열 날짜가 범주로 그려진 그래프가 '데이터'로 읽힌다.
import { test } from 'node:test';

import assert from 'node:assert';
import {
  parseChartBlock, chartBlocksToTables, chartTableMarkdown, toNumber, toTime, pieSlices, clip, sliceSafe,
  chartNotes, fmtNum, pieLabelsOverflow, fitText, chartFences, normalizeTable, parseTable, CHART_FENCE_RE, MAX_CHART_ROWS, MAX_SERIES, MAX_LABEL_LEN, MAX_NAME_LEN, MAX_PIE_SLICES,
} from '../src/chart.js';

const TABLE = '| 월 | 건수 | 금액 |\n|---|---|---|\n| 2024-01 | 120 | 1,000 |\n| 2024-02 | 80 | 2,500 |';
const spec = text => { const r = parseChartBlock(text); assert.ok(r.ok, r.reason); return r.spec; };

test('시간대가 명시된 시각은 실제 순간으로 비교하고 원래 표기를 보존한다', () => {
  const utc = Date.UTC(2026, 8, 6, 3, 0, 0, 123);
  for (const date of ['2026-09-06T03:00:00.123Z', '2026-09-06 12:00:00.123 +09:00', '2026-09-05 22:00:00.123 -0500']) {
    assert.equal(toTime(date), utc, date);
  }
  const s = spec('type: line\n| 시각 | 값 |\n|---|---|\n| 2026-09-06 12:00:00 +00:00 | 2 |\n| 2026-09-06 12:00:00 +09:00 | 1 |');
  assert.equal(s.xKind, 'time');
  assert.equal(s.rows[1].x - s.rows[0].x, 9 * 60 * 60 * 1000);
  assert.deepEqual(s.rows.map(r => r.values[0]), [1, 2]);
  assert.equal(s.rows[0].full, '2026-09-06 12:00:00 +09:00');
  assert.equal(parseChartBlock('type: line\n| 시각 | 값 |\n|---|---|\n| 2026-09-06T03:00:00Z | 1 |\n| 2026-09-06 12:00:00 +09:00 | 2 |').ok, false, '같은 순간을 다른 시간대로 적어도 중복 x다');
});

test('잘못된 시간대와 날짜는 거절하고 명시된 시간대의 윤년을 판정한다', () => {
  for (const date of ['2026-09-06 12:00:00 +24:00', '2026-09-06 12:00:00 -09:60', '2026-02-29T00:00:00Z', '0099-02-29T00:00:00Z']) {
    assert.equal(toTime(date), null, date);
  }
  const early = new Date(toTime('0000-02-29T00:00:00Z'));
  assert.equal(early.getUTCFullYear(), 0);
  assert.equal(early.getUTCDate(), 29);
});

// 시간대를 바꿔 재는 시험들. TZ는 프로세스 전역이라 반드시 되돌린다 — 이 파일의 시험은 한 프로세스에서
// 차례로 도므로, 되돌리지 않으면 뒤 시험이 엉뚱한 시간대에서 돌고 그 실패는 원인이 보이지 않는다.
const 시간대에서 = (tz, fn) => {
  const 원래 = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { if (원래 === undefined) delete process.env.TZ; else process.env.TZ = 원래; }
};

// 서머타임이 시작되는 날에는 지역 시간에 '없는 시각'이 한 시간(어떤 곳은 30분) 생긴다. Date는 그런 값을
// 거절하지 않고 조용히 다음 시각으로 옮긴다 — 적힌 것과 다른 자리에 찍히는 것이라, 위 '12:99를 13:39로
// 넘긴다'와 같은 부류다. 실측(America/New_York, 2024-03-10): '02:30'이 03:30이 되어 03:30 행과 같은
// 순간이 됐고, 그 표는 '같은 x에 행이 여럿'으로 차트가 통째로 표가 됐다. 그 행 하나뿐이면 더 조용하다 —
// 표와 툴팁에는 02:30인데 축에는 03:30으로 찍힌다.
// 조회 결과가 늘 브라우저와 같은 시간대의 값일 이유는 없다: 한국 DB의 평범한 '2024-03-10 02:30' 한 줄이
// 서머타임을 쓰는 PC에서 이 자리에 걸린다.
test('서머타임으로 없어진 시각은 다른 자리에 찍지 않고 거절한다', () => {
  시간대에서('America/New_York', () => {   // 2024-03-10 02:00 → 03:00 (한 시간이 없다)
    for (const s of ['2024-03-10 02:00', '2024-03-10 02:30', '2024-03-10 02:59:59'])
      assert.equal(toTime(s), null, `${s}: 없는 시각을 다음 시각으로 옮겨 받았다`);
    // 그 앞뒤의 있는 시각은 그대로다
    assert.notEqual(toTime('2024-03-10 01:30'), null);
    assert.notEqual(toTime('2024-03-10 03:30'), null);
    // 가을에 두 번 오는 시각은 '없는 시각'이 아니다 — 거절하면 그 한 시간이 통째로 사라진다
    assert.notEqual(toTime('2024-11-03 01:30'), null);
    // 시각을 적지 않은 날짜에는 걸지 않는다. 자정에 시계를 옮기는 시간대에서는 그 하루가 통째로 빠지는데,
    // 날짜만 적힌 값에서 하루 안의 어느 순간인가는 뜻이 없다(라벨도 정렬도 그대로다).
    assert.notEqual(toTime('2024-03-10'), null);
    // 시간대를 명시한 값은 지역 시간을 거치지 않으므로 서머타임과 무관하다
    assert.equal(toTime('2024-03-10 02:30:00 -05:00'), Date.UTC(2024, 2, 10, 7, 30));
  });
  // 30분만 옮기는 시간대의 빠진 30분도 같다 — 시(時)만 보면 이 값은 지나간다(02:15 → 02:45).
  시간대에서('Australia/Lord_Howe', () => {   // 2024-10-06 02:00 → 02:30
    assert.equal(toTime('2024-10-06 02:15'), null, '빠진 30분을 02:45로 옮겨 받았다');
    assert.notEqual(toTime('2024-10-06 01:59'), null);
    assert.notEqual(toTime('2024-10-06 02:30'), null);
  });
});

test('없는 시각이 섞여도 그 행만 빼고 그린다 — 차트가 통째로 표가 되지 않는다', () => {
  시간대에서('America/New_York', () => {
    const md = 'type: line\nxtype: time\n| 일시 | 값 |\n|---|---|\n| 2024-03-10 01:30 | 1 |\n| 2024-03-10 02:30 | 2 |\n| 2024-03-10 03:30 | 3 |';
    const r = parseChartBlock(md);
    assert.ok(r.ok, r.reason);   // 예전에는 02:30이 03:30이 되어 '같은 x에 행이 여럿'으로 떨어졌다
    assert.deepEqual(r.spec.rows.map(x => x.label), ['2024-03-10 01:30', '2024-03-10 03:30']);
    assert.equal(r.spec.skipped, 1);
    assert.deepEqual(chartNotes(r.spec), ['x를 시간으로 읽지 못한 1행은 그리지 않았습니다.']);
  });
});

test('대소문자가 다른 컬럼은 x·y·y2의 정확한 이름으로 선택한다', () => {
  const parsed = parseChartBlock(`type: bar
x: LABEL
y: amount
y2: AMOUNT
| label | LABEL | amount | AMOUNT |
| --- | --- | --- | --- |
| wrong | A | 10 | 100 |`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.spec.xName, 'LABEL');
  assert.equal(parsed.spec.rows[0].label, 'A');
  assert.deepEqual(parsed.spec.series, [{ name: 'amount', axis: 'left' }, { name: 'AMOUNT', axis: 'right' }]);
  assert.deepEqual(parsed.spec.rows[0].values, [10, 100]);
});
test('일반 코드펜스 안의 차트 문법 예시는 대화 이력에서 그대로 남는다', () => {
  for (const fence of ['````markdown', '~~~text']) {
    const close = fence.startsWith('`') ? '````' : '~~~';
    const md = `${fence}\n\`\`\`chart\ntype: bar\n${TABLE}\n\`\`\`\n${close}`;
    assert.equal(chartBlocksToTables(md), md);
  }
});

test('소수 초가 다른 시각은 서로 다른 x로 남아 선 그래프가 그려진다', () => {
  const base = toTime('2026-09-06 12:30:45');
  for (const [fraction, ms] of [['1', 100], ['12', 120], ['123', 123], ['123456', 123]]) {
    assert.equal(toTime(`2026-09-06 12:30:45.${fraction}`), base + ms);
  }
  const s = spec('type: line\n| 시각 | 값 |\n|---|---|\n| 2026-09-06 12:30:45.100 | 1 |\n| 2026-09-06 12:30:45.200 | 2 |');
  assert.equal(s.xKind, 'time');
  assert.equal(s.rows[1].x - s.rows[0].x, 100);
});

test('두 자리 이하의 연도도 그 해의 윤년 규칙으로 판정한다', () => {
  assert.equal(new Date(toTime('0000-02-29')).getFullYear(), 0);
  assert.equal(new Date(toTime('0096-02-29')).getDate(), 29);
  assert.equal(toTime('0099-02-29'), null);
});

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
  // Oracle TIMESTAMP WITH TIME ZONE과 ISO 표기는 그 오프셋을 실제 순간에 반영한다.
  assert.strictEqual(toTime('2024-01-01 09:00:00 +09:00'), Date.UTC(2024, 0, 1));
  assert.strictEqual(toTime('2024-01-01T09:00:00Z'), Date.UTC(2024, 0, 1, 9));
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

test('모르는 type은 무엇이든 막대다 — 별칭 표가 프로토타입까지 뒤지지 않는다', () => {
  // 별칭 표를 평범한 객체로 두면 [] 조회가 프로토타입까지 올라간다. `type: constructor` 한 줄이면
  // Object 함수가 '아는 이름'으로 돌아와 spec.type이 문자열이 아니게 되고, 그 값은 모델이 쓴 글자
  // 하나로 정해진다 — 그리는 쪽은 type을 문자열로 비교하므로(Chart.jsx) 이 계약이 깨지는 것은
  // 조용하다. 소문자 이름만 걸리므로(nameKey가 내리므로) 다른 프로토타입 멤버는 이미 막대였다.
  for (const t of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
    const s = spec(`type: ${t}\n| a | b |\n|---|---|\n| x | 1 |`);
    assert.strictEqual(s.type, 'bar', `type: ${t} 가 막대가 아니다 (${typeof s.type})`);
  }
});

test('범례·툴팁에 서는 이름은 상한 안이다 — 조회 결과가 그대로 이름이 되는 자리', () => {
  // 열 이름과 조각 이름은 조회 결과의 셀·열 이름 그대로다(서버 MAX_CELL_LEN 200자). 축 눈금(label)만
  // 묶어 두었을 때, 240자짜리 범주 이름 하나가 툴팁을 2,513px 상자로 부풀려 1,000px 창의 오른쪽
  // 1,653px 밖으로 나갔다(실측, 창 380px에서는 2,173px). 그렇게 나간 글자는 말풍선의 overflow-x: clip에
  // 잘려 어디에서도 읽을 수 없다 — 잘리지 않은 값은 차트 곁의 '표로 보기'에 있다.
  const 긴것 = '노드'.repeat(120);
  const s = spec(`type: bar\nx: 이름\n| 이름 | ${긴것} | ${긴것}2 |\n|---|---|---|\n| ${긴것} | 1 | 2 |\n| 짧은것 | 3 | 4 |`);
  assert.ok(s.xName.length <= MAX_NAME_LEN, `x 이름이 ${s.xName.length}자다`);
  for (const x of s.series) assert.ok(x.name.length <= MAX_NAME_LEN, `시리즈 이름이 ${x.name.length}자다`);
  for (const r of s.rows) assert.ok(r.full.length <= MAX_NAME_LEN, `full이 ${r.full.length}자다`);
  // 축 눈금은 그보다 더 짧게 남아 있어야 한다 — 이름 상한이 눈금 상한을 덮어써서는 안 된다
  assert.strictEqual(s.rows[0].label.length, MAX_LABEL_LEN);
  // 짧은 이름은 그대로다 (상한이 모든 이름을 자르는 규칙이 되어서는 안 된다)
  assert.strictEqual(s.rows[1].full, '짧은것');
  // 오른쪽 축의 이름도 같은 문을 지난다
  const 두축 = spec(`type: bar\nx: 이름\ny: ${긴것}\ny2: ${긴것}2\n| 이름 | ${긴것} | ${긴것}2 |\n|---|---|---|\n| a | 1 | 2 |`);
  for (const x of 두축.series) assert.ok(x.name.length <= MAX_NAME_LEN, `두 축의 이름이 ${x.name.length}자다`);
  assert.strictEqual(두축.series.filter(x => x.axis === 'right').length, 1);
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
  // 표 없이 제목만 남은 블록(서버가 채우지 못한 `data:` 참조)은 제목 한 줄
  assert.strictEqual(chartBlocksToTables('```chart\ntitle: 제목\ndata: step 1\n```'), '제목');
  assert.strictEqual(chartBlocksToTables('```chart\ndata: step 1\n```'), '');
});

test('표도 `data:` 참조도 없는 chart 펜스는 화면에 남는 그대로 이력에도 남는다', () => {
  // 그런 블록은 차트가 아니다 — 모델이 펜스를 다른 용도로 쓴 것이라, 화면은 그 글자를 원문 그대로
  // 코드로 보인다(App.jsx ChartTable: '참조도 표도 없는 블록은 무엇인지 모르므로 원문 그대로 둔다').
  // 이력에서만 지우면 사용자가 보고 있는 글을 모델만 보지 못한다 — 다음 질문의 '## 최근 대화'에
  // 그 자리가 통째로 비어, 모델은 자기가 방금 한 말을 근거로 답할 수 없다. 오류는 나지 않는다.
  assert.strictEqual(chartBlocksToTables('앞\n\n```chart\n이건 그냥 글입니다\n```\n\n뒤'), '앞\n\n이건 그냥 글입니다\n\n뒤');
  // 설정 줄만 있는 블록도 같다 — 화면은 그 줄을 코드로 보인다
  assert.strictEqual(chartBlocksToTables('```chart\ntype: bar\n```'), 'type: bar');
  // 제목이 있어도 표가 없으면 화면은 원문을 보인다(제목 한 줄로 바꾸지 않는다) — 이력도 그래야 한다
  assert.strictEqual(chartBlocksToTables('```chart\ntitle: 제목만\n아무 글\n```'), 'title: 제목만\n아무 글');
  // 표가 있으면 지금까지대로 제목 + 표다 (원문을 그대로 두는 것은 표가 없을 때뿐이다)
  assert.strictEqual(chartBlocksToTables('```chart\ntitle: 제목\n| a | b |\n|---|---|\n| x | 1 |\n```'),
    '제목\n| a | b |\n|---|---|\n| x | 1 |');
  // 본문의 들여쓰기는 원문 그대로 둔다 — 목록 안의 블록이 목록 밖으로 떨어져 나가지 않게
  assert.strictEqual(chartBlocksToTables('1. 항목\n\n    ```chart\n    그냥 글\n    ```'), '1. 항목\n\n    그냥 글');
});

// 펜스 줄의 '공백'은 markdown과 같이 스페이스·탭뿐이다. 여기가 넓으면 가리기(maskLiteralFences)가
// 화면과 다른 자리에서 코드블록을 열고 닫아, 사용자가 코드로 본 글이 모델에게는 표로 간다.
test('펜스 줄의 공백은 스페이스·탭뿐이다 — NBSP·전각공백이 붙은 펜스는 화면과 같이 펜스가 아니다', () => {
  const NB = '\u00a0';
  // 닫는 줄에 NBSP가 붙으면 markdown은 그 리터럴 블록을 닫지 않는다 — 뒤의 ```chart는 그 안의 글자다.
  // `.trim()`으로 세던 때에는 여기서 닫힌 것으로 보아 뒤를 가리지 않았고, 그 ```chart가 이력에서만
  // 표로 바뀌었다(펜스·구분 줄·닫는 줄이 사라진 채).
  const inLiteral = `\`\`\`\`text\n\`\`\`\`${NB}\n\`\`\`chart\n| a | b |\n|---|---|\n| x | 1 |\n\`\`\`\n뒤`;
  assert.strictEqual(chartBlocksToTables(inLiteral), inLiteral);
  // 전각공백·얇은공백·수직탭도 같다 (markdown은 스페이스·탭만 센다)
  for (const ws of ['\u3000', '\u2009', '\u000b', '\u000c']) {
    const md = `\`\`\`\`text\n\`\`\`\`${ws}\n\`\`\`chart\n| a | b |\n| x | 1 |\n\`\`\`\n뒤`;
    assert.strictEqual(chartBlocksToTables(md), md, `닫는 꼬리 ${JSON.stringify(ws)}`);
  }
  // 여는 줄도 같다: ```chart 다음이 NBSP면 markdown의 언어는 'chart\u00a0월별'이라 그냥 코드블록이다 —
  // 그 안에 적힌 ```chart 예시를 이력에서 표로 바꾸면 화면과 다른 글을 모델에게 보내게 된다.
  const notChart = `\`\`\`chart${NB}월별\n\`\`\`chart\n| a | b |\n|---|---|\n| x | 1 |\n\`\`\``;
  assert.strictEqual(chartBlocksToTables(notChart), notChart);
  // 스페이스·탭은 지금까지대로 펜스의 공백이다 (좁히면서 함께 막히지 않았는지)
  assert.strictEqual(chartBlocksToTables('```text\n```\t\n```chart\n| a | b |\n| x | 1 |\n```'),
    '```text\n```\t\n| a | b |\n| --- | --- |\n| x | 1 |');
  assert.strictEqual(chartBlocksToTables('``` chart \n| a | b |\n| x | 1 |\n``` '),
    '| a | b |\n| --- | --- |\n| x | 1 |');
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

test('fitText: 자리보다 넓은 글자는 그 자리 안으로 줄인다 (넘치면 소리 없이 잘리는 자리)', () => {
  // 눕힌 막대의 범주 축은 라벨이 긴 만큼 넓어지고(Chart.jsx width="auto"), 라벨은 조회 결과의 셀
  // 값이라 상한(MAX_LABEL_LEN 30자)까지 온다 — 좁은 화면에서는 축 하나가 상자를 통째로 먹어
  // 막대도 축도 눈금선도 사라졌다(실측: 창 320px). 그래서 축에 내주는 자리를 정하고 그 안으로 줄인다.
  // 폭을 재는 일은 부르는 쪽(글꼴을 아는 자리)의 몫이라 여기서는 어떤 재기 함수든 받는다.
  const measure = t => [...t].reduce((w, c) => w + (/[가-힣]/.test(c) ? 11 : 6), 0);
  const 이름 = '항목이름'.repeat(7) + '00';   // 30자
  assert.strictEqual(measure(이름), 28 * 11 + 2 * 6);
  // 자리에 맞게 줄이되 그 자리를 넘지 않는다 (…도 폭을 차지한다 — 그것까지 세어야 한다)
  for (const room of [11, 30, 100, 200, 300]) {
    const got = fitText(이름, room, measure);
    assert.ok(measure(got) <= room, `자리 ${room}px에 ${measure(got)}px짜리를 남겼다: ${JSON.stringify(got)}`);
    assert.ok(got.length < 이름.length, `줄이지 않았다: ${JSON.stringify(got)}`);
  }
  // 줄인 것은 줄였다고 보여야 한다 — 표시 없이 잘린 이름은 그것이 원래 이름인 줄 알게 만든다
  // (…를 붙일 자리조차 없는 한 글자짜리는 clip의 규칙대로 그냥 한 글자다)
  assert.ok(fitText(이름, 100, measure).endsWith('…'));
  assert.strictEqual(fitText(이름, 11, measure), '항');
  // 자리가 넉넉하면 그대로 둔다 — 들어가는 이름까지 줄이면 읽을 수 있던 것이 …가 된다
  assert.strictEqual(fitText(이름, 1000, measure), 이름);
  assert.strictEqual(fitText('가', 1000, measure), '가');
  // 자리가 없거나 말이 안 되면 빈 글자다 (상자 폭을 아직 재지 못한 첫 렌더 등)
  assert.strictEqual(fitText(이름, 0, measure), '');
  assert.strictEqual(fitText(이름, -1, measure), '');
  assert.strictEqual(fitText(이름, NaN, measure), '');
  // 한 글자도 못 들어가는 자리에서는 아무것도 남기지 않는다 (한 글자를 억지로 세우지 않는다)
  assert.strictEqual(fitText(이름, 3, measure), '');
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

test('차트의 숫자 표기: 아주 큰 값도 눈금 하나가 그래프를 밀어낼 만큼 길어지지 않는다', () => {
  // 값 축은 width="auto"라(Chart.jsx) 눈금 글자가 넓은 만큼 그림에서 폭을 가져간다. 자릿수 표기는
  // 값이 커질수록 끝없이 자라므로(1e308 한 칸이 쉼표까지 410자다) 큰 값 하나가 그래프를 없앤다 —
  // 실측(창 1000px, 그림 상자 574px): 1e75에서 막대도 눈금선도 0개, 눈금 글자만 상자 밖으로 나갔다.
  // 아무 오류도 나지 않아 사용자에게는 그냥 차트가 없는 답변이다. 작은 값 쪽(1e-6)과 같은 처방이다.
  assert.strictEqual(fmtNum(1e21), '1.00e+21');
  assert.strictEqual(fmtNum(-1e308), '-1.00e+308');
  assert.strictEqual(Number(fmtNum(1.5e30)), 1.5e30);
  // 경계 바로 아래는 지금까지의 표기 그대로다 — 조·경 단위의 실제 조회 값이 여기 있다
  assert.strictEqual(fmtNum(1e12), '1,000,000,000,000');
  assert.strictEqual(fmtNum(Number.MAX_SAFE_INTEGER), '9,007,199,254,740,991');
  assert.ok(fmtNum(1e20).includes(','), `1e20은 자릿수 표기여야 한다: ${fmtNum(1e20)}`);
  // 어떤 크기에서도 눈금 하나의 길이가 묶여 있어야 한다 (1e21 아래는 정수부 21자리 + 쉼표 + 소수 두 자리)
  for (let e = -320; e <= 308; e++) {
    for (const v of [10 ** e, -(10 ** e), 1.23456 * 10 ** e]) {
      if (!Number.isFinite(v)) continue;
      assert.ok(fmtNum(v).length <= 31, `${v}의 표기가 길다(${fmtNum(v).length}자): ${fmtNum(v)}`);
    }
  }
});

// 아래 넷은 이 파일이 말로만 적어 두고 아무 시험도 지키지 않던 계약이다(돌연변이 검사로 찾았다 —
// 그 자리를 뒤집어도 검사가 전부 통과했다). 계약이 깨져도 오류는 나지 않는다: 그릴 수 있는 열이
// 사라지거나, 표 아래 설명이 제목이 되거나, 그릴 것이 없는 명세가 그리는 쪽으로 넘어갈 뿐이다.
test('숫자 열의 판정: 결측이 섞여도 숫자 열이고, 값이 하나도 없으면 아니다', () => {
  // 조회 결과에 NULL이 섞이는 것은 예사다(LEFT JOIN·GROUP BY). 그 열을 숫자 열에서 빼면 그릴 것이
  // 사라지고, 차트는 조용히 표로 주저앉는다.
  const s = spec('type: bar\n| 월 | 건수 |\n|---|---|\n| 1월 | 10 |\n| 2월 |  |\n| 3월 | - |\n| 4월 | N/A |\n| 5월 | 30 |');
  assert.deepEqual(s.series.map(x => x.name), ['건수']);
  assert.deepEqual(s.rows.map(r => r.values[0]), [10, null, null, null, 30]);
  // 값이 하나도 없는 열은 숫자 열이 아니다 — 전부 결측인 열을 0의 줄로 그리면 없는 값을 그린 것이 된다
  assert.equal(parseChartBlock('type: bar\n| 월 | 건수 |\n|---|---|\n| 1월 |  |\n| 2월 | - |').ok, false);
});

test('설정 줄은 표가 시작되기 전까지만 읽는다 — 표 아래 설명은 설정이 아니다', () => {
  // 모델은 표 아래에 설명을 붙인다. 그 줄이 설정으로 읽히면 제목이 설명 문장으로 바뀌고,
  // `x:`·`y:` 한 줄이면 그리는 열까지 달라진다.
  const s = spec('type: bar\ntitle: 진짜 제목\n| 이름 | 값 |\n|---|---|\n| 가 | 1 |\n| 나 | 2 |\ntitle: 표 아래 설명\ny: 이름');
  assert.equal(s.title, '진짜 제목');
  assert.deepEqual(s.series.map(x => x.name), ['값']);
});

test('그릴 행이 하나도 남지 않으면 차트를 포기한다 — 빈 명세를 그리는 쪽으로 넘기지 않는다', () => {
  // 원그래프는 값이 0 이하인 조각을 그릴 수 없다(Recharts가 음수를 0으로 뭉갠다). 전부 그렇다면 그릴 것이 없다.
  const r = parseChartBlock('type: pie\n| 이름 | 값 |\n|---|---|\n| 가 | 0 |\n| 나 | -5 |');
  assert.equal(r.ok, false);
  assert.equal(r.spec, undefined, 'ok가 아닌 답에 명세가 딸려 오면 그리는 쪽이 그것을 믿는다');
  // 시간 축으로 명시했는데 한 줄도 시각이 아니면 마찬가지다
  assert.equal(parseChartBlock('type: line\nxtype: time\n| 구간 | 값 |\n|---|---|\n| 합계 | 1 |\n| 소계 | 2 |').ok, false);
});

test('x로 적은 이름이 표에 없으면 첫 열이 x다 — 값 열을 x로 삼지 않는다', () => {
  const s = spec('type: bar\nx: 없는열\n| 이름 | 값 |\n|---|---|\n| 가 | 1 |\n| 나 | 2 |');
  assert.equal(s.xName, '이름');
  assert.deepEqual(s.rows.map(r => r.label), ['가', '나']);
  assert.deepEqual(s.series.map(x => x.name), ['값']);
  // 첫 열을 y·y2로 지목하면 그 열을 그린다(0번 열이라고 버리지 않는다 — 이름을 못 찾은 것과 다르다)
  const t = spec('type: bar\nx: 이름\ny: 값\n| 값 | 이름 |\n|---|---|\n| 1 | 가 |\n| 2 | 나 |');
  assert.equal(t.xName, '이름');
  assert.deepEqual(t.series.map(x => x.name), ['값']);
  assert.deepEqual(t.rows.map(r => r.values[0]), [1, 2]);
  // y2가 첫 열이면 오른쪽 축에 선다. 버려지면 그 열은 왼쪽 축의 채움으로 넘어가거나 통째로 사라진다.
  const u = spec('type: bar\nx: 이름\ny: 건수\ny2: 값\n| 값 | 이름 | 건수 |\n|---|---|---|\n| 1 | 가 | 10 |\n| 2 | 나 | 20 |');
  assert.deepEqual(u.series, [{ name: '건수', axis: 'left' }, { name: '값', axis: 'right' }]);
});

// 줄 단위 탐색(chartFences)은 CHART_FENCE_RE와 같은 블록을 찾아야 한다 — 정규식은 서버(backend chart.js)와 나누는 '모양'이고
// 탐색은 그것을 길이에 비례하게 다시 쓴 것이라, 둘이 갈리면 화면·이력·서버가 서로 다른 블록을 본다. 무작위 문서로
// 대조한다: 펜스 글자·길이·들여쓰기(탭·4칸 포함)·덧말·CRLF·닫히지 않은 펜스·다른 언어의 펜스·목록·인용문을 섞는다.
test('chartFences는 CHART_FENCE_RE와 같은 블록을 찾는다 (무작위 문서 대조)', () => {
  let seed = 20260906;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const doc = () => {
    const parts = [];
    for (let b = 0; b < int(1, 4); b++) {
      const ch = pick(['`', '~']); const f = ch.repeat(int(3, 5));
      parts.push(`${pick(['', ' ', '  ', '   ', '    ', '\t', '> '])}${f}${pick(['', ' '])}${pick(['chart', 'Chart', 'CHART', 'charts', 'mermaid', 'js', ''])}${pick(['', '', ' 월별', ' x `y`', '\t덧말', ' '])}`);
      for (let j = 0; j < int(0, 4); j++) parts.push(pick(['type: bar', '| a | b |', '|---|---|', '| x | 1 |', '  | y | 2 |', '', '글', '```', '~~~', '````', '- 목록', 'data: step 1', '```chart']));
      if (rnd() < 0.85) parts.push(`${pick(['', ' ', '   ', '    ', '\t'])}${rnd() < 0.8 ? f : pick(['```', '~~~', '````', '~~~~'])}${pick(['', ' ', '\t', ' x'])}`);
      parts.push(pick(['', '문장', '> 인용']));
    }
    return parts.join(pick(['\n', '\n', '\r\n'])) + pick(['', '\n', '\r\n']);
  };
  const byRe = md => [...md.matchAll(CHART_FENCE_RE)].map(m => ({ indent: m[1], fence: m[2], ch: m[3], body: m[4], at: m.index }));
  const byScan = md => { const { lines, blocks } = chartFences(md); let off = 0; const starts = lines.map(l => { const o = off; off += l.length + 1; return o; });
    return blocks.map(b => ({ indent: b.indent, fence: b.fence, ch: b.ch, body: b.body, at: starts[b.start] })); };
  for (let i = 0; i < 3000; i++) {
    const md = doc();
    assert.deepStrictEqual(byScan(md), byRe(md), `블록이 갈렸다: ${JSON.stringify(md)}`);
  }
  // 정규식으로 바꿔 넣은 것과 탐색으로 바꿔 넣은 것도 같아야 한다 (바꿔 넣는 범위까지)
  const viaRe = md => md.replace(CHART_FENCE_RE, (_, indent, _f, _c, body = '') => `[${indent}|${body}]`);
  const viaScan = md => { const { lines, blocks } = chartFences(md); const out = []; let at = 0;
    for (const b of blocks) { out.push(...lines.slice(at, b.start), `[${b.indent}|${b.body ?? ''}]`); at = b.end + 1; } out.push(...lines.slice(at)); return out.join('\n'); };
  for (let i = 0; i < 1000; i++) { const md = doc(); assert.strictEqual(viaScan(md), viaRe(md), `바꿔 넣은 범위가 갈렸다: ${JSON.stringify(md)}`); }
});

// 닫히지 않은 여는 펜스가 되풀이되는 퇴화한 답변에서 정규식은 '여는 줄 수 × 길이'였다(실측: 상한 안의 7,500줄에 487ms,
// 길이 두 배에 네 배). 이력 변환은 그 답변이 최근 여섯 턴에 있는 동안 매 전송마다 다시 도므로 질문마다 반초씩 멈췄다.
test('chartBlocksToTables는 닫히지 않은 펜스가 아무리 많아도 비용이 길이에 비례한다', () => {
  const degenerate = n => '```chart\n'.repeat(n);
  const ms = n => { const t0 = performance.now(); chartBlocksToTables(degenerate(n)); return performance.now() - t0; };
  ms(2000);
  const one = Math.max(0.5, ms(2000));
  const four = ms(8000);
  assert.ok(four < one * 8, `길이가 4배인데 비용이 ${(four / one).toFixed(1)}배다 (${one.toFixed(1)}ms → ${four.toFixed(1)}ms)`);
  // 결과도 같아야 한다 — 닫히지 않은 펜스는 블록이 아니라 그대로 남는다
  assert.strictEqual(chartBlocksToTables(degenerate(3)), degenerate(3));
  // dead 표시는 '이 길이 이상의 닫는 펜스가 끝까지 없다'일 뿐이다 — 더 짧은 여는 줄은 여전히 제 닫는 줄을 찾는다
  assert.strictEqual(chartBlocksToTables('````chart\n글\n```chart\n| a | b |\n| x | 1 |\n```'), '````chart\n글\n| a | b |\n| --- | --- |\n| x | 1 |');
});

// ===== 서버가 채운 표의 칸이 화면에서 원문 그대로 읽히는가 =====
// 채운 칸은 markdown 표의 인라인 문맥이라 값에 든 강조·코드·링크·취소선·HTML·엔터티 표기가 그대로
// 해석된다 — 파이프처럼 열을 밀지는 않지만 값을 조용히 바꾼다(실측: 치수 '10*20*30'이 '102030'으로,
// '~미사용~'이 '미사용'으로, '__init__'이 'init'으로, '&amp;'가 '&'로 나갔다).
// 서버가 짝이 있을 때만 막아 보내고(backend/src/chart.js escapeCell) 여기 splitRow가 같은 목록을
// 되돌린다 — 두 규칙이 갈라지면 화면에 백슬래시가 남거나 값이 바뀐다. 그래서 실제 렌더러까지 통과시켜
// 잰다(math.test.js와 같은 이유): 판정과 remark-gfm이 그 판정을 어떻게 읽는지가 함께 있어야 계약이다.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resolveTableData, resolveChartData } from '../../backend/src/chart.js';

const 표의_칸 = md => [...renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, md))
  .matchAll(/<(td|th)\b[^>]*>(.*?)<\/\1>/g)]
  .map(m => m[2].replace(/<[^>]*>/g, '')
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));

const 값들 = ['10*20*30', '~미사용~', '__init__', '노트: `code`', '[확인](http://x)', '&amp;',
  '<b>굵게</b>', 'BATCH_JOB_STATUS', 'C:\\logs\\a|b', '재고 부족 — *긴급*', '2026-09-07 10:23:45'];

test('서버가 채운 표의 칸은 화면에서 조회 결과 원문 그대로 읽힌다', () => {
  const rows = 값들.map(v => ({ 값: v, N: 1 }));
  const md = resolveTableData('```table\nstep: 1\nlimit: 100\n```', [rows]);
  const cells = 표의_칸(md);
  // 머리글 두 칸을 지나 값 칸만 (열이 둘이므로 두 칸씩)
  const shown = cells.slice(2).filter((_, i) => i % 2 === 0);
  assert.deepEqual(shown, 값들);
});

test('차트 블록의 칸은 라벨(splitRow)과 표로 보기(GFM) 양쪽에서 같은 글자다', () => {
  const rows = 값들.map((v, i) => ({ 값: v, N: i + 1 }));
  const filled = resolveChartData('```chart\ntype: bar\nx: 값\ny: N\ndata: step 1\n```', [rows]);
  const body = filled.split('\n').slice(1, -1).join('\n');
  const parsed = parseChartBlock(body);
  assert.ok(parsed.ok, parsed.reason);
  // 라벨은 표시 상한(MAX_LABEL_LEN)에서 잘릴 수 있으므로 full을 본다
  assert.deepEqual(parsed.spec.rows.map(r => r.full), 값들);
  // 같은 표를 '표로 보기'로 렌더해도 같은 글자여야 한다
  const shown = 표의_칸(chartTableMarkdown(body)).slice(2).filter((_, i) => i % 2 === 0);
  assert.deepEqual(shown, 값들);
});

test('채운 표는 앞뒤 블록에 흡수되지 않는다 — 펜스와 달리 GFM 표는 스스로 끝나지 않는다', () => {
  const steps = [[{ JOB: 'BATCH001', STATUS: 'FAILED' }], [{ CODE: 'X9' }]];
  const T1 = '```table\nstep: 1\n```', T2 = '```table\nstep: 2\n```';
  const 표 = md => [...renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, md))
    .matchAll(/<table>([\s\S]*?)<\/table>/g)]
    .map(t => [...t[1].matchAll(/<(td|th)\b[^>]*>(.*?)<\/\1>/g)].map(c => c[2]));

  // ① 표 블록 둘이 빈 줄 없이 이어져도 표 둘이다 (뒤 표의 머리글·구분 줄이 앞 표의 행이 되지 않는다)
  assert.deepEqual(표(resolveTableData(`${T1}\n${T2}`, steps)),
    [['JOB', 'STATUS', 'BATCH001', 'FAILED'], ['CODE', 'X9']]);
  // ② 모델이 손으로 쓴 표 바로 뒤에 와도 흡수되지 않는다 — 흡수되면 열 수가 적은 앞 표에 맞춰 STATUS가 사라진다
  assert.deepEqual(표(resolveTableData(`| a |\n| --- |\n| 1 |\n${T1}`, steps)),
    [['a', '1'], ['JOB', 'STATUS', 'BATCH001', 'FAILED']]);
  // ③ 표 바로 뒤의 설명 문장이 표의 행이 되지 않는다
  assert.deepEqual(표(resolveTableData(`${T1}\n다음 단계는 재시작입니다.`, steps)),
    [['JOB', 'STATUS', 'BATCH001', 'FAILED']]);
});

// 표를 읽는 규칙(parseTable)과 그것을 다시 내보내는 규칙(normalizeTable)이 갈리면, 차트는 그려지는데
// '표로 보기'만 파이프 글자 묶음이 된다 — 차트를 못 그린 블록에서는 그 글자가 값을 보는 유일한 자리다.
// 그래서 판정이 아니라 실제 렌더러로 잰다: 우리가 표로 읽은 블록은 remark-gfm도 표로 읽어야 하고,
// 행 수와 칸의 글자가 우리가 읽은 것과 같아야 한다.
const 표들 = md => [...renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, md))
  .matchAll(/<table>([\s\S]*?)<\/table>/g)]
  .map(t => [...t[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map(r => [...r[1].matchAll(/<(td|th)\b[^>]*>(.*?)<\/\1>/g)].map(c => c[2].replace(/<[^>]*>/g, ''))));

test("표로 읽은 블록은 '표로 보기'·이력에서도 GFM 표다 (구분 줄·줄머리 파이프)", () => {
  const 블록들 = {
    // 파이프 없이 시작하는 한 칸 대시 구분 줄: markdown이 목록 항목으로 먼저 읽어 표가 통째로 깨졌다
    // (실측: '표로 보기'에 글머리표 하나와 파이프 글자가 남았고, 차트를 못 그린 블록에서는 그것이 전부였다).
    '한 칸 대시': '이름 | 값\n- | -\n가 | 1\n나 | 2',
    // 구분 줄의 공백이 스페이스·탭이 아니면 micromark는 구분 줄로 읽지 않는다 — `\s`로 보던 우리만 읽었다.
    'NBSP 구분 줄': '| 이름 | 값 |\n| --- | --- |\n| 가 | 1 |\n| 나 | 2 |',
    '전각공백 구분 줄': '| 이름 | 값 |\n|　---　|　---　|\n| 가 | 1 |\n| 나 | 2 |',
    // 머리글의 첫 칸이 markdown의 블록 표시로 시작하면 그 줄이 제목·목록이 된다 (조회 결과의 '#' 열 등)
    '# 머리글': '# | 이름 | 값\n--- | --- | ---\n1 | 가 | 10\n2 | 나 | 20',
    '* 값 행': '| 이름 | 값 |\n| --- | --- |\n* | 1 |\n나 | 2',
    // 지금까지도 되던 모양들 — 함께 지킨다
    '구분 줄 없음': '| 이름 | 값 |\n| 가 | 1 |\n| 나 | 2 |',
    '칸 수 다름': '| 이름 | 값 |\n| --- |\n| 가 | 1 |\n| 나 | 2 |',
    '정렬 표시': '| 이름 | 값 |\n|:---|---:|\n| 가 | 1 |\n| 나 | 2 |',
  };
  for (const [why, body] of Object.entries(블록들)) {
    const parsed = parseChartBlock(`type: bar\n${body}`);
    assert.ok(parsed.ok, `${why}: 차트로 읽지 못했다 (${parsed.reason})`);
    const 읽은행 = parsed.spec.rows.length;
    for (const [어디, md] of [['표로 보기', chartTableMarkdown(body)], ['이력', chartBlocksToTables(`\`\`\`chart\ntype: bar\n${body}\n\`\`\``)]]) {
      const 표 = 표들(md);
      assert.strictEqual(표.length, 1, `${why} · ${어디}: 표가 아니다 — ${JSON.stringify(md)}`);
      assert.strictEqual(표[0].length, 읽은행 + 1, `${why} · ${어디}: 행 수가 다르다 — ${JSON.stringify(md)}`);
    }
  }
});

test('우리가 넣는 줄머리 파이프는 칸을 하나도 늘리지 않는다 (무작위 줄 대조)', () => {
  // 표를 세우려던 파이프가 칸을 늘리면 머리글과 구분 줄의 칸 수가 어긋나 그 표가 도로 깨진다.
  // 특히 전각공백·NBSP로 들여쓴 줄이 그렇다 — splitRow는 그 공백을 앞의 빈 칸으로 세지 않으므로
  // '파이프가 없다'고 보고 하나 더 붙이면 거기서 칸이 하나 늘어난다.
  let seed = 20260907;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const SP = [' ', '', '\t', '\u00a0', '\u3000', '  '];
  const CELL = ['이름', '값', '가', '1', '', '#', '-', '*', 'a b'];
  for (let i = 0; i < 3000; i++) {
    const cols = 2 + Math.floor(rnd() * 3);
    const cells = Array.from({ length: cols }, () => `${pick(SP)}${pick(CELL)}${pick(SP)}`);
    const line = pick(SP) + (rnd() < 0.5 ? '|' : '') + cells.join('|') + (rnd() < 0.5 ? '|' : '');
    const 원래 = parseTable([line, '| x | y |']);
    const 내보낸 = normalizeTable([line, '| x | y |']);
    if (!원래) continue;
    assert.deepStrictEqual(parseTable([내보낸.header, 내보낸.sep]).header, 원래.header,
      `줄머리 파이프가 칸을 바꿨다: ${JSON.stringify(line)} → ${JSON.stringify(내보낸.header)}`);
  }
});

test("정렬 표시가 든 구분 줄은 그대로 두고, GFM이 읽지 못하는 것만 새로 만든다", () => {
  // 새로 만들면 정렬이 사라지므로, GFM이 그대로 읽어 주는 구분 줄은 손대지 않는다.
  assert.strictEqual(chartTableMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |'), '| a | b |\n|:--|--:|\n| 1 | 2 |');
  assert.strictEqual(chartTableMarkdown('| a | b |\n| - | - |\n| 1 | 2 |'), '| a | b |\n| - | - |\n| 1 | 2 |');
  // 목록 안의 표는 들여쓰기를 지킨다 — 우리가 넣는 파이프는 들여쓰기 뒤에 온다
  assert.strictEqual(chartBlocksToTables('1. 항목\n   ```chart\n   a | b\n   - | -\n   1 | 2\n   ```'),
    '1. 항목\n   |a | b\n   | --- | --- |\n   |1 | 2');
});
