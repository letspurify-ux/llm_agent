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
// 행마다 22px씩 키가 자라(Chart.jsx) 1000행이면 2만 px이고, 세로 막대 1000개는 1px 조각이 된다. 서버가
// `data: step N`으로 채우는 표도 같은 수까지만 싣는다(backend chart.js MAX_CHART_BLOCK_ROWS — 그 위는 그려지지
// 않는 채 답변만 키우고 다른 차트의 몫을 먹는다). 넘는 행은 차트 아래에 '처음 100행만 그렸습니다'로 밝히고,
// 조회된 행 전부는 trace 패널에 있다.
// 시리즈 6개는 범례가 한 줄에 읽히는 한계, 라벨 30자는 축 눈금이 서로를 덮지 않는 한계.
export const MAX_CHART_ROWS = 100;
export const MAX_SERIES = 6;
export const MAX_LABEL_LEN = 30;
export const MAX_TITLE_LEN = 80;
// 원그래프 조각 수. 그 뒤는 '기타' 한 조각으로 모은다(작은 조각 스무 개는 범례도 색도 읽히지 않는다).
export const MAX_PIE_SLICES = 12;
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

// 표 한 줄을 칸으로 쪼갠다. GFM처럼 `\|` 는 칸 안의 파이프, `\\` 는 역슬래시 하나다 — 둘 다 되돌려야
// '표로 보기'(GFM이 그린다)와 차트의 라벨이 같은 글자가 된다(서버 cell()이 이 두 글자를 이렇게 적는다).
// 그 밖의 역슬래시는 글자다(`C:\dir`). 양끝 파이프는 벗긴다.
function splitRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && (line[i + 1] === '|' || line[i + 1] === '\\')) { cur += line[i + 1]; i++; continue; }
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

// 셀 하나를 숫자로. 조회 결과가 표에 실리는 동안 붙는 것들 — 앞의 통화 기호, 뒤의 %, 세 자리씩 묶는
// 쉼표·공백 — 은 벗긴다. 그 밖의 글자가 남으면 숫자가 아니다('12건'은 12가 아니라 빈칸이다 — 단위를 떼기
// 시작하면 '1.2k'와 '2024-01'을 어디서 멈출지 정할 수 없다). 빈칸과 대시는 결측이다.
// 구분자는 자리가 맞을 때만 벗긴다: 공백·쉼표를 무조건 지우면 '2024 01'이 202401, '1,2'가 12로 읽혀
// 글자 열이 숫자 열로 둔갑한다(실측). '1 000'·'1,000,000'은 묶음이고 '10 20'·'1,2'는 아니다.
const isMissing = s => s === '' || s === '-' || s === '–' || s === '—' || s === 'null' || /^n\/?a$/i.test(s);
const CURRENCY_RE = /^([-+]?)\s*[₩$€¥]\s*/;
// 되참조(\1)로 첫 구분자와 같은 것만 받는다 — 잡아만 두고 쓰지 않으면 '1 234,567'처럼 섞인 표기가
// 통과해 1234567이 된다(실측). 그러면 글자 열이 숫자 열로 둔갑해 없는 값이 그려진다.
const GROUPED_RE = /^[-+]?\d{1,3}(?:([, ])\d{3})(?:\1\d{3})*(?:\.\d*)?$/;
const PLAIN_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
export function toNumber(cell) {
  let s = String(cell ?? '').trim();
  if (isMissing(s)) return null;
  s = s.replace(CURRENCY_RE, '$1').replace(/\s*%$/, '');
  if (GROUPED_RE.test(s)) s = s.replace(/[, ]/g, '');
  if (!PLAIN_RE.test(s)) return null;
  const n = Number(s);
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
  // 시각도 범위를 넘으면 날짜가 아니다. Date는 12:99를 13:39로 조용히 넘겨 버려(실측), 잘못 적힌
  // 시각이 축의 엉뚱한 자리에 찍힌다 — 아래 날짜 확인은 하루를 넘길 때만 걸린다.
  if (+(h ?? 0) > 23 || +(mi ?? 0) > 59 || +(sec ?? 0) > 59) return null;
  const t = new Date(+y, +mo - 1, +(d ?? 1), +(h ?? 0), +(mi ?? 0), +(sec ?? 0));
  // 생성자는 0~99년을 1900년대로 올린다 — 네 자리로 적힌 해는 적힌 그대로다.
  t.setFullYear(+y);
  // 2024-13-45 같은 값은 Date가 조용히 다음 달로 넘겨 버린다 — 넘긴 것은 날짜가 아니었다.
  return t.getMonth() === +mo - 1 && t.getDate() === +(d ?? 1) && +mo >= 1 && +mo <= 12 ? t.getTime() : null;
}

// 글자를 n자까지 자른다. 경계에서 서로게이트 쌍(이모지 등)을 반으로 쪼개지 않는다 — 짝 잃은
// 코드유닛은 화면에서 U+FFFD가 되고, 이력으로 나가면 프롬프트 인코딩에서 같은 일이 일어난다.
// 자르는 곳이 둘이라(라벨·범례는 아래 clip, 이력은 App.jsx clipTurn) 경계 규칙만 여기 한 번 적는다.
export const sliceSafe = (s, n) => {
  if (n <= 0) return '';
  const cut = s.slice(0, n);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};
// 넘치면 끝을 …로 대신한다 (그 한 글자 자리를 비워 둔다).
export const clip = (s, n) => {
  if (s.length <= n) return s;
  // 자리가 한 글자뿐이면 …를 붙일 자리도 없다 — 붙이면 상한을 넘긴다.
  return n <= 1 ? sliceSafe(s, n) : `${sliceSafe(s, n - 1)}…`;
};
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
// block: 부르는 쪽이 이미 splitBlock한 것이 있으면 그것을 준다 — 화면은 같은 블록을 표로도 그리므로
// 두 번 훑을 이유가 없다 (없으면 여기서 가른다).
export function parseChartBlock(text, block) {
  const { config, table } = block ?? splitBlock(text);
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
  // 이름이 표에 있는데 그 열을 하나도 그릴 수 없으면(전부 결측이거나 글자) 차트를 포기한다 — 다른 숫자 열로
  // 바꿔 그리면 제목은 '매출'인데 그래프는 건수다(실측). 채움은 이름이 표에 없을 때(오타)만이다.
  const used = new Set([xi]);
  const y2Named = config.y2 ? resolveColumns(splitNames(config.y2), header, used) : [];
  y2Named.forEach(i => used.add(i));
  const y2Numeric = y2Named.filter(i => isNumericColumn(rows, i));
  const yNamed = config.y ? resolveColumns(splitNames(config.y), header, used) : [];
  let y = yNamed.filter(i => isNumericColumn(rows, i));
  // pie·scatter는 값 하나만 그리므로 y2는 애초에 그리지 않는다 — 그 설정이 숫자 열이 아니라고
  // 그릴 수 있는 그래프까지 포기하면, 쓰이지도 않는 줄 하나 때문에 표만 남는다.
  const single = type === 'pie' || type === 'scatter';
  if ((yNamed.length && !y.length) || (!single && y2Named.length && !y2Numeric.length)) return { ok: false, reason: '지정한 열이 숫자 열이 아님' };
  const y2 = single ? [] : y2Numeric.slice(0, 2);
  if (!y.length) y = header.map((_, i) => i).filter(i => !used.has(i) && isNumericColumn(rows, i));
  // 왼쪽에 그릴 것이 없고 오른쪽만 있으면(y2만 적은 블록) 그것을 왼쪽에 그린다 — 축 하나면 오른쪽일
  // 이유가 없다. pie·scatter에서는 y2를 비워 두므로(위 single) 그 이름들을 여기서 되찾아야 한다 —
  // 그러지 않으면 'y2: 건수'라고만 적은 원그래프가 그릴 열을 하나도 찾지 못한다(실측).
  if (!y.length && (y2.length || y2Numeric.length)) y = y2.length ? y2.splice(0) : y2Numeric.slice(0, 1);
  if (!y.length) return { ok: false, reason: '숫자 열 없음' };
  // pie·scatter는 값 하나만 그린다 — 둘째 시리즈부터는 겹쳐 그릴 자리가 없다.
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
  // 시간·숫자 축인데 x를 읽지 못한 행 수. 추론한 축에서는 0이고(전부 읽혀야 추론한다) 명시한 xtype에서만
  // 생긴다 — 조용히 빠지면 '합계' 행이나 '2024-Q1' 라벨이 없어진 것을 알 길이 없어 차트 아래에 밝힌다.
  let skipped = 0;
  // 원그래프가 그리지 못해 뺀 행 수(값이 0 이하) — 아래 dropped 참고.
  let dropped = 0;
  for (const r of rows) {
    let label = String(r[xi] ?? '').trim();
    const t = sortByTime ? toTime(label, explicit === 'time') : null;
    let x = label;
    if (xKind === 'time') { if (t === null) { skipped++; continue; } x = t; }
    else if (xKind === 'number') { x = toNumber(label); if (x === null) { skipped++; continue; } }
    // 범주가 비어 있는 행(GROUP BY의 NULL 그룹 등)도 그린다 — 표에는 있는 행이 그래프에서만 빠지면 합계가 어긋나 보인다.
    else if (!label) label = x = EMPTY_LABEL;
    const values = series.map(s => toNumber(r[s.col]));
    // 원그래프에서 값이 없거나 음수인 조각은 그릴 수 없다(Recharts는 음수 조각을 0으로 뭉갠다).
    // 다른 그래프에서는 값이 전부 빈 행도 남긴다 — 그 범주가 축에 있어야 '값이 없다'가 보인다.
    // 뺀 행은 세어 둔다: 표에는 있는 행이 그림에서만 없어지면 비율의 분모가 달라진 것을 알 길이 없다
    // (x를 읽지 못해 뺀 행을 skipped로 밝히는 것과 같은 이유다 — 조용히 빠지는 행이 있어서는 안 된다).
    if (type === 'pie' && !(values[0] > 0)) { dropped++; continue; }
    data.push({ x, label: clip(label, MAX_LABEL_LEN), full: label, values, t });
  }
  if (!data.length) return { ok: false, reason: '그릴 행 없음' };
  // 선·영역은 x 하나에 값이 하나여야 한다. 피벗되지 않은 결과(일자×상태×건수)를 `x: 일자`로 그리면 같은
  // 시각에 점이 여럿 서서 선이 수직으로 오르내리고, 그것이 추세로 읽힌다(실측) — 그리지 않고 표를 보인다.
  // 산점도는 같은 x의 점 여럿이 정상이고, 범주 축의 막대는 행마다 자기 자리가 있다.
  if (continuous && type !== 'scatter' && new Set(data.map(d => d.x)).size < data.length) return { ok: false, reason: '같은 x에 행이 여럿' };
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
      skipped,
      dropped,
    },
  };
}

// 원그래프의 조각. MAX_PIE_SLICES를 넘으면 '값이 큰' 것들을 남기고 나머지를 '기타' 하나로 모은다 — 표 순서의
// 꼬리를 모으면 `data: step N`(쿼리 정렬 그대로, 이름순일 때가 많다)에서 큰 조각이 기타에 묻히고 1짜리가
// 조각으로 남는다(실측). 남긴 조각은 표 순서를 지키고 기타는 맨 뒤다. Chart.jsx가 아니라 여기 있는 이유는
// 순수 함수라 테스트가 붙기 때문이다.
export function pieSlices(rows, max = MAX_PIE_SLICES) {
  const data = rows.map(r => ({ name: r.label, full: r.full, value: r.values[0] }));
  if (data.length <= max) return data;
  const keep = new Set(data.map((d, i) => i).sort((a, b) => data[b].value - data[a].value).slice(0, max - 1));
  const rest = data.filter((_, i) => !keep.has(i));
  // full은 '잘리지 않은 이름'이고 범례·툴팁이 그것을 쓴다 — 모아 놓은 조각에서는 개수까지가 이름이다.
  const other = `기타 (${rest.length})`;
  return [...data.filter((_, i) => keep.has(i)), { name: other, full: other, value: rest.reduce((a, d) => a + d.value, 0) }];
}

// 블록 안의 표만 markdown으로. 차트를 그리지 못할 때·그리기 전에·'표로 보기'에 그대로 렌더한다.
// 구분 줄이 빠졌거나 칸 수가 머리글과 다른 표는 GFM이 표로 인정하지 않는다(파이프 글자가 문단으로
// 그대로 보인다) — 머리글 칸 수에 맞춰 넣어 준다. 위 splitBlock·parseTable은 어느 쪽이든 읽으므로
// 차트는 그려지는데 '표로 보기'만 깨지는 일이 없어야 한다.
// 표 줄들을 GFM이 표로 인정하는 모양으로: 머리글 · 구분 줄 · 값 줄들. 구분 줄이 없거나 칸 수가
// 머리글과 다르면 채워 넣는다 — 모델이 빼먹는 일이 있다. 화면과 이력이 같은 함수를 쓰는 이유는,
// 한쪽만 고쳐 두면 화면에는 표인 것이 모델에게는 파이프 글자 묶음으로 가기 때문이다(실측).
export function normalizeTable(table) {
  if (!table.length) return null;
  const cols = splitRow(table[0]).length;
  const isSep = table.length > 1 && SEP_ROW_RE.test(table[1]);
  // 채워 넣는 구분 줄은 머리글과 같은 들여쓰기로 — 이력에서는 원문의 줄 모양을 그대로 두기 때문에
  // (목록 안의 표는 항목 폭만큼 들여 온다) 이 줄만 왼쪽 끝에 붙으면 그 표가 목록에서 떨어져 나간다.
  const indent = /^\s*/.exec(table[0])[0];
  const sep = isSep && splitRow(table[1]).length === cols ? table[1] : `${indent}|${' --- |'.repeat(cols)}`;
  return { header: table[0], sep, rows: table.slice(isSep ? 2 : 1) };
}

// 이미 가른 블록에서 바로. 화면은 한 블록을 두 번(제목 있는 표·'표로 보기') 그리므로, 부르는 쪽이
// splitBlock을 한 번만 하고 그 결과를 돌려쓸 수 있어야 한다.
export function chartTableMarkdownFrom(block) {
  // 줄 앞의 공백은 벗긴다 — 펜스 안에서는 뜻이 없던 들여쓰기가 표만 떼어 렌더하면 4칸부터 코드블록이다.
  const t = normalizeTable(block.table.map(l => l.trim()));
  return t ? [t.header, t.sep, ...t.rows].join('\n') : '';
}
export const chartTableMarkdown = text => chartTableMarkdownFrom(splitBlock(text));

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
    const t = normalizeTable(table);
    if (t) {
      out.push(t.header, t.sep, ...t.rows.slice(0, HISTORY_TABLE_ROWS));
      if (t.rows.length > HISTORY_TABLE_ROWS) out.push(`(외 ${t.rows.length - HISTORY_TABLE_ROWS}행)`);
    }
    return out.join('\n');
  });
}
