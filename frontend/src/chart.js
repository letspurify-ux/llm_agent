// 답변 안의 차트 블록을 다루는 계약 전체 — 무엇을 차트로 받아들이는가(parseChartBlock)와,
// 그 블록을 대화 이력으로 되돌려 보낼 때 어떤 모양으로 줄이는가(chartBlocksToTables).
//
// 블록의 모양은 서버 SYSTEM_PROMPT(llm-openai.js)가 모델에게 가르치고, 서버 chart.js가 `data: step N`
// 참조를 실제 표로 채워 넘긴다. 셋이 같은 줄 문법을 봐야 하므로 여기 CONFIG_RE·표 판정을 바꾸면
// 그 둘도 함께 바꾼다.
//
//   ```chart
//   type: bar | stacked-bar | line | area | pie | scatter
//   title: 제목
//   x: 열이름            (없으면 첫 열)
//   y: 열, 열            (없으면 x를 뺀 숫자 열 전부)
//   y2: 열               (오른쪽 축에 선으로 겹쳐 그릴 열)
//   xtype: time | number | category
//   | 열 | 열 | … |       GFM 표 — 값은 조회 결과 그대로
//   ```
//
// 설정은 전부 '이름: 값' 한 줄이고 표는 GFM 그대로다. JSON을 쓰지 않는 이유는 answer 자체가 이미
// JSON 문자열 안에 실려 오기 때문이다 — 그 안에 따옴표·중괄호를 또 넣으면 이스케이프가 한 번만
// 어긋나도 답변 전체가 파싱에서 떨어진다. 이 모양은 따옴표가 한 개도 없다.
//
// 실패 방향은 한쪽으로만 열려 있어야 한다: 판정하지 못하면(ok:false) 화면에는 안의 표가 그대로
// 보인다. 반대로 어설프게 그리면 숫자가 아닌 것을 0으로 그리거나, 축이 뒤집힌 그래프가 '데이터'로
// 읽힌다. 그래서 여기서는 숫자로 읽히지 않는 값을 0이 아니라 빈칸으로 두고, 그릴 것이 하나도 없으면
// 차트를 포기한다.

// 그리기 상한. 서버는 한 조회에서 1000행(MAX_ROWS)까지 가져오지만 그리는 것은 100행까지다 — 가로 막대는
// 행마다 22px씩 키가 자라(Chart.jsx) 1000행이면 2만 px이고, 세로 막대 1000개는 1px 조각이 된다. 넘는 행은
// 차트 아래에 '처음 100행만 그렸습니다'로 밝히고 '표로 보기'에는 전부 있다.
// 시리즈 6개는 범례가 한 줄에 읽히는 한계, 라벨 30자는 축 눈금이 서로를 덮지 않는 한계.
export const MAX_CHART_ROWS = 100;
export const MAX_SERIES = 6;
export const MAX_LABEL_LEN = 30;
export const MAX_TITLE_LEN = 80;
// 메시지 하나에 그릴 차트 수. 모델이 열 개를 내놓으면 열 개의 ResponsiveContainer가 리사이즈
// 관찰자를 달고 돌아간다 — 그 뒤는 표로 보여준다.
export const MAX_CHARTS_PER_MESSAGE = 4;
// 이력으로 되돌릴 때 남기는 표의 행 수. 서버가 프롬프트에 싣는 결과 행 수(MAX_RESULT_ROWS)와 같다.
const HISTORY_TABLE_ROWS = 20;

const TYPES = new Set(['bar', 'stacked-bar', 'line', 'area', 'pie', 'scatter']);
// 모델이 실제로 쓰는 변형들. 모르는 이름은 막대다 — 표만 남기는 것보다 낫고, 막대는 무엇이든 담는다.
const TYPE_ALIASES = {
  column: 'bar', columns: 'bar', bars: 'bar', histogram: 'bar',
  stacked: 'stacked-bar', stackedbar: 'stacked-bar', 'stacked-column': 'stacked-bar',
  lines: 'line', spline: 'line', trend: 'line',
  areas: 'area', 'stacked-area': 'area',
  donut: 'pie', doughnut: 'pie',
  scatterplot: 'scatter', points: 'scatter', bubble: 'scatter',
};

// 설정 줄. 콜론 뒤는 값이며 따옴표가 있어도 벗기지 않는다(모델이 따옴표를 쓰면 그것까지 제목이다 —
// 벗기기 시작하면 어디까지 벗길지가 또 하나의 규칙이 된다). `data:` 는 서버가 채우고 지우는 줄이라
// 여기까지 살아오면 서버가 처리하지 못한 것이다 — 값은 무시하되 줄은 설정으로 먹는다.
const CONFIG_RE = /^\s*(type|title|x|y|y2|xtype|data)\s*:\s*(.*?)\s*$/i;
// GFM 표의 구분 줄(|---|:--:|). 있으면 건너뛰고, 없어도 표로 받는다 — 모델이 빼먹는 일이 있고,
// 우리에게 필요한 것은 머리글과 값뿐이다.
const SEP_ROW_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

// 표 한 줄을 칸으로 쪼갠다. GFM처럼 `\|` 는 칸 안의 글자다. 양끝 파이프는 벗긴다.
function splitRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  if (cells.length && cells[0] === '' && /^\s*\|/.test(line)) cells.shift();
  if (cells.length && cells[cells.length - 1] === '' && /\|\s*$/.test(line)) cells.pop();
  return cells;
}

// 열 이름 비교는 대소문자·양끝 공백을 무시한다 (서버 constants.nameKey와 같은 규칙).
const nameKey = s => String(s ?? '').trim().toLowerCase();
const splitNames = v => String(v ?? '').split(/[,;]/).map(s => s.trim()).filter(Boolean);

// 셀 하나를 숫자로. 조회 결과가 표에 실리는 동안 붙는 것들 — 천 단위 쉼표, %, 통화 기호, 단위 앞뒤의
// 공백 — 은 벗긴다. 그 밖의 글자가 남으면 숫자가 아니다('12건'은 12가 아니라 빈칸이다 — 단위를 떼기
// 시작하면 '1.2k'와 '2024-01'을 어디서 멈출지 정할 수 없다). 빈칸과 대시는 결측이다.
const isMissing = s => s === '' || s === '-' || s === '–' || s === '—' || s === 'null' || /^n\/?a$/i.test(s);
export function toNumber(cell) {
  const s = String(cell ?? '').trim();
  if (isMissing(s)) return null;
  const t = s.replace(/[\s,₩$€¥%]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// 셀 하나를 시각(ms)으로. 구분자가 있는 날짜만 받는다 — 20240101 같은 숫자는 코드일 수도 있어
// xtype: time 을 명시했을 때만 날짜로 읽는다. 시각은 지역 시간으로 만든다: 축의 눈금 글자도 지역
// 시간으로 찍으므로 왕복이 맞아야 '2024-01-01'이 '2023-12-31'로 보이지 않는다.
// 뒤의 Z·+09:00 은 읽되 무시한다 — Oracle의 TIMESTAMP WITH TIME ZONE 표기(NLS_TIMESTAMP_TZ_FORMAT)가 그렇게
// 오고, 그 오프셋은 조회한 DB 자신의 시간대라 지역 시간으로 읽는 것과 같은 축에 놓인다.
const DATE_RE = /^(\d{4})[-./](\d{1,2})(?:[-./](\d{1,2}))?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:\s*(?:Z|[-+]\d{2}:?\d{2}))?$/;
const COMPACT_DATE_RE = /^(\d{4})(\d{2})(\d{2})?$/;
export function toTime(cell, explicit = false) {
  const s = String(cell ?? '').trim();
  let m = DATE_RE.exec(s);
  if (!m && explicit) m = COMPACT_DATE_RE.exec(s) || (/^\d{4}$/.test(s) ? [s, s, '1'] : null);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const t = new Date(+y, +mo - 1, +(d ?? 1), +(h ?? 0), +(mi ?? 0), +(sec ?? 0));
  // 생성자는 0~99년을 1900년대로 올린다 — 네 자리로 적힌 해는 적힌 그대로다.
  t.setFullYear(+y);
  // 2024-13-45 같은 값은 Date가 조용히 다음 달로 넘겨 버린다 — 넘긴 것은 날짜가 아니었다.
  return t.getMonth() === +mo - 1 && t.getDate() === +(d ?? 1) && +mo >= 1 && +mo <= 12 ? t.getTime() : null;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const EMPTY_LABEL = '(빈값)';

// 블록 본문(펜스 안의 글자)을 설정과 표 줄로 가른다. 설정은 표가 시작되기 전까지만 읽는다 —
// 표 뒤에 'type: …' 같은 줄이 오면 그것은 모델이 표 아래 붙인 설명이지 설정이 아니다.
// 줄 끝은 markdown과 같은 규칙으로 본다 — 홀로 선 \r도 줄 끝이다(펜스 안의 글자는 원문 그대로 오므로
// 여기서 가르지 않으면 두 줄이 한 줄로 붙고, 표만 떼어 다시 렌더할 때는 markdown이 거기서 줄을 가른다).
export function splitBlock(text) {
  const config = {};
  const table = [];
  let inTable = false;
  for (const raw of String(text ?? '').split(/\r\n?|\n/)) {
    if (!raw.trim()) continue;
    if (!inTable) {
      const m = CONFIG_RE.exec(raw);
      if (m) { config[m[1].toLowerCase()] = m[2]; continue; }
    }
    if (raw.includes('|')) { inTable = true; table.push(raw); }
    // 파이프도 설정도 아닌 줄(설명 문장 등)은 버린다 — 표를 깨뜨리지 않는 것이 우선이다.
  }
  return { config, table };
}

// 표 줄들을 머리글과 값 행으로. 머리글이 두 칸 미만이면 표가 아니다. 구분 줄은 GFM처럼 둘째 줄에서만
// 찾는다 — 그 아래의 `| - | - |`는 값이 전부 결측인 행이지 구분 줄이 아니다.
export function parseTable(lines) {
  if (!lines.length) return null;
  const header = splitRow(lines[0]);
  if (header.length < 2) return null;
  const body = lines.slice(1).filter((l, i) => !(i === 0 && SEP_ROW_RE.test(l))).map(splitRow);
  return { header, rows: body };
}

const normalizeType = t => {
  const k = nameKey(t).replace(/[\s_]+/g, '-');
  return TYPES.has(k) ? k : (TYPE_ALIASES[k] ?? 'bar');
};

// 열 이름 목록을 열 번호로. 없는 이름은 버린다(있는 것만으로 그린다 — 하나가 틀렸다고 전부 표로
// 돌아가면, 모델이 열 이름의 대소문자 하나 틀린 값으로 차트 전체를 잃는다).
const resolveColumns = (names, header, exclude) =>
  names.map(n => header.findIndex(h => nameKey(h) === nameKey(n)))
    .filter((i, at, arr) => i >= 0 && !exclude.has(i) && arr.indexOf(i) === at);

// 열 하나가 '숫자 열'인가: 값이 있는 칸이 하나 이상이고 그 전부가 숫자로 읽혀야 한다(결측 표시는
// 값이 아니다). 숫자와 글자가 섞인 열(상태 코드 등)은 그리지 않는다.
const isNumericColumn = (rows, i) => {
  let seen = false;
  for (const r of rows) {
    const c = String(r[i] ?? '').trim();
    if (isMissing(c)) continue;
    if (toNumber(c) === null) return false;
    seen = true;
  }
  return seen;
};

// 블록 본문 → 그릴 수 있는 명세. 그릴 수 없으면 { ok:false, reason } — reason은 개발자용 문자열이며
// 화면에는 표만 보인다.
export function parseChartBlock(text) {
  const { config, table } = splitBlock(text);
  if (config.data !== undefined && !table.length) return { ok: false, reason: 'data 참조가 채워지지 않음' };
  const parsed = parseTable(table);
  if (!parsed) return { ok: false, reason: '표 없음' };
  const { header, rows } = parsed;
  if (!rows.length) return { ok: false, reason: '행 없음' };

  const type = normalizeType(config.type);
  const title = clip(String(config.title ?? '').trim(), MAX_TITLE_LEN);

  // x 열: 지정된 이름이 있으면 그 열, 없거나 못 찾으면 첫 열.
  let xi = config.x ? header.findIndex(h => nameKey(h) === nameKey(config.x)) : 0;
  if (xi < 0) xi = 0;

  // 시리즈: y가 있으면 그 열들(숫자 열만), 없거나 하나도 못 찾으면 x 밖의 숫자 열 전부. y2는 오른쪽 축.
  // y2로 적힌 열은 그리지 못하는 것(숫자 아님·셋째 이후)까지 전부 '쓴 열'로 표시한다 — 그러지 않으면
  // y가 비었을 때의 채움(아래)이 그 열을 왼쪽 축에 그린다(오른쪽 축에 두라던 열이 왼쪽에 서는 조용한 오답).
  const used = new Set([xi]);
  const y2Named = config.y2 ? resolveColumns(splitNames(config.y2), header, used) : [];
  y2Named.forEach(i => used.add(i));
  const y2 = y2Named.filter(i => isNumericColumn(rows, i)).slice(0, 2);
  let y = (config.y ? resolveColumns(splitNames(config.y), header, used) : []).filter(i => isNumericColumn(rows, i));
  if (!y.length) y = header.map((_, i) => i).filter(i => !used.has(i) && isNumericColumn(rows, i));
  // 왼쪽에 그릴 것이 없고 오른쪽만 있으면(y2만 적은 블록) 그것을 왼쪽에 그린다 — 축 하나면 오른쪽일 이유가 없다.
  if (!y.length && y2.length) { y = y2.splice(0); }
  if (!y.length) return { ok: false, reason: '숫자 열 없음' };
  // pie·scatter는 값 하나만 그린다 — 둘째 시리즈부터는 겹쳐 그릴 자리가 없다.
  const single = type === 'pie' || type === 'scatter';
  y = y.slice(0, single ? 1 : MAX_SERIES - y2.length);

  // x의 종류. 명시(xtype)가 우선이고, 없으면 시간·숫자 축이 뜻이 있는 그래프에서만 추론한다.
  // 막대·원은 언제나 범주다 — 날짜 라벨의 막대는 범주로 그려도 옳고, 숫자 축으로 그리면 막대 폭이
  // 날짜 간격에 따라 제각각이 된다. 다만 xtype: time 이 명시된 막대는 시간순으로 줄은 세운다.
  const explicit = nameKey(config.xtype);
  const continuous = type === 'line' || type === 'area' || type === 'scatter';
  let xKind = 'category';
  if (explicit === 'time' || explicit === 'number' || explicit === 'category') xKind = explicit;
  else if (continuous) {
    if (rows.every(r => toTime(r[xi]) !== null)) xKind = 'time';
    else if (type === 'scatter' && rows.every(r => toNumber(r[xi]) !== null)) xKind = 'number';
  }
  const sortByTime = xKind === 'time';
  if (!continuous) xKind = 'category';
  // 산점도는 x가 수치여야 한다 — 범주 x의 점들은 그냥 세로줄이다.
  if (type === 'scatter' && xKind === 'category') return { ok: false, reason: '산점도의 x가 수치가 아님' };

  const series = [
    ...y.map(i => ({ name: header[i], col: i, axis: 'left' })),
    ...(single ? [] : y2.map(i => ({ name: header[i], col: i, axis: 'right' }))),
  ];

  const data = [];
  for (const r of rows) {
    let label = String(r[xi] ?? '').trim();
    const t = sortByTime ? toTime(label, explicit === 'time') : null;
    let x = label;
    if (xKind === 'time') { if (t === null) continue; x = t; }
    else if (xKind === 'number') { x = toNumber(label); if (x === null) continue; }
    // 범주가 비어 있는 행(GROUP BY의 NULL 그룹 등)도 그린다 — 표에는 있는 행이 그래프에서만 빠지면 합계가 어긋나 보인다.
    else if (!label) label = x = EMPTY_LABEL;
    const values = series.map(s => toNumber(r[s.col]));
    // 원그래프에서 값이 없거나 음수인 조각은 그릴 수 없다(Recharts는 음수 조각을 0으로 뭉갠다).
    // 다른 그래프에서는 값이 전부 빈 행도 남긴다 — 그 범주가 축에 있어야 '값이 없다'가 보인다.
    if (type === 'pie' && !(values[0] > 0)) continue;
    data.push({ x, label: clip(label, MAX_LABEL_LEN), full: label, values, t });
  }
  if (!data.length) return { ok: false, reason: '그릴 행 없음' };
  // 시간·숫자 축은 정렬돼 있어야 선이 되돌아가지 않는다. 시간순 막대는 날짜를 전부 읽었을 때만 세운다.
  if (xKind === 'number' || xKind === 'time') data.sort((a, b) => a.x - b.x);
  else if (sortByTime && data.every(d => d.t !== null)) data.sort((a, b) => a.t - b.t);
  for (const d of data) delete d.t;

  const clipped = data.length > MAX_CHART_ROWS;
  return {
    ok: true,
    spec: {
      type, title, xKind,
      xName: header[xi],
      series: series.map(({ name, axis }) => ({ name, axis })),
      rows: clipped ? data.slice(0, MAX_CHART_ROWS) : data,
      clipped,
      total: data.length,
    },
  };
}

// 블록 안의 표만 markdown으로. 차트를 그리지 못할 때·그리기 전에·'표로 보기'에 그대로 렌더한다.
// 구분 줄이 빠졌거나 칸 수가 머리글과 다른 표는 GFM이 표로 인정하지 않는다(파이프 글자가 문단으로
// 그대로 보인다) — 머리글 칸 수에 맞춰 넣어 준다. 위 splitBlock·parseTable은 어느 쪽이든 읽으므로
// 차트는 그려지는데 '표로 보기'만 깨지는 일이 없어야 한다.
export function chartTableMarkdown(text) {
  // 줄 앞의 공백은 벗긴다 — 펜스 안에서는 뜻이 없던 들여쓰기가 표만 떼어 렌더하면 4칸부터 코드블록이다.
  const table = splitBlock(text).table.map(l => l.trim());
  if (!table.length) return '';
  const cols = splitRow(table[0]).length;
  const hasSep = table.length > 1 && SEP_ROW_RE.test(table[1]);
  if (hasSep && splitRow(table[1]).length === cols) return table.join('\n');
  return [table[0], `|${' --- |'.repeat(cols)}`, ...table.slice(hasSep ? 2 : 1)].join('\n');
}

// 답변 본문에서 ```chart 펜스를 찾는다. markdown 파서(react-markdown)가 펜스로 읽는 것과 같은 범위를
// 잡아야 한다 — 이쪽이 놓친 블록은 화면에서는 차트인데 이력에서는 설정 줄째 남고, 서버(backend chart.js)의
// 같은 정규식이 놓치면 `data:` 참조가 채워지지 않은 채 화면에 온다. 그래서 들여쓰기는 칸 수를 따지지 않고
// (목록 안의 펜스는 항목 번호 폭만큼 들여 온다 — `10. `이면 4칸), 언어 뒤의 덧말(```chart 월별)과
// 3개 넘는 백틱으로 닫는 펜스, CRLF도 받는다. 닫는 펜스가 없는 블록(토큰 한도로 잘린 응답)은 잡히지 않고 그대로 남는다.
export const CHART_FENCE_RE = /^[ \t]*```[ \t]*chart(?:[ \t]+[^\r\n]*)?\r?\n([\s\S]*?)\r?\n[ \t]*`{3,}[ \t]*\r?$/gim;

// 대화 이력으로 보낼 때 차트 블록을 평범한 표로 되돌린다. 모델의 다음 턴에 필요한 것은 '무슨 값을
// 보여줬는가'이지 그것을 어떻게 그렸는가가 아니다 — 펜스와 설정 줄을 그대로 돌려보내면 이력
// 상한(HISTORY_LEN)의 일부를 그 글자가 먹고, 모델은 그 모양을 답변마다 흉내 낸다.
// 표는 20행까지만 남기고 나머지는 건수로 적는다.
export function chartBlocksToTables(md) {
  return String(md ?? '').replace(CHART_FENCE_RE, (_, body) => {
    const { config, table } = splitBlock(body);
    const title = String(config.title ?? '').trim();
    const out = [];
    if (title) out.push(title);
    if (table.length) {
      const header = table[0];
      const rest = table.slice(1);
      const sep = rest.length && SEP_ROW_RE.test(rest[0]) ? rest.shift() : null;
      out.push(header);
      if (sep) out.push(sep);
      out.push(...rest.slice(0, HISTORY_TABLE_ROWS));
      if (rest.length > HISTORY_TABLE_ROWS) out.push(`(외 ${rest.length - HISTORY_TABLE_ROWS}행)`);
    }
    return out.join('\n');
  });
}
