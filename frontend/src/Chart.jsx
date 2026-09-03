// 차트 블록 하나를 그린다. 무엇을 그릴지는 chart.js parseChartBlock이 이미 정했고, 여기는 그 명세를
// Recharts 요소로 옮기는 일만 한다. App.jsx가 React.lazy로 부르므로 이 파일과 recharts는 첫 차트가
// 나올 때까지 내려받지 않는다 — 대부분의 답변은 글과 표뿐이다.
import { useId, useLayoutEffect, useRef, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, PieChart, ScatterChart,
  Bar, Line, Area, Pie, Scatter, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { pieSlices } from './chart.js';

// 첫 색은 앱의 강조색(index.html --accent)을 따라가고, 나머지는 서로 구별되는 고정 팔레트다.
// 강조색은 이 모듈이 처음 실행될 때 한 번 읽는다 — 차트가 나올 시점에는 문서가 이미 그려져 있다.
const accent = (typeof getComputedStyle === 'function' && typeof document !== 'undefined'
  && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()) || '#4f46e5';
const PALETTE = [accent, '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316', '#64748b'];
const color = i => PALETTE[i % PALETTE.length];

// 조각 위에 얹는 글자의 색. 팔레트에는 밝은 색(황색 #f59e0b, 주황 #f97316)이 있어 흰 글자를 얹으면
// 대비가 2:1도 되지 않는다 — 11px 글자는 그 위에서 사실상 보이지 않는다(잘린 라벨을 고치려다
// 있으나 마나 한 라벨을 얻는다). 바탕의 밝기를 재어 흰 글자와 진한 글자 중 잘 보이는 쪽을 쓴다.
// 색을 읽지 못하면(강조색이 hex가 아닐 수 있다) 밝기 0으로 보아 흰 글자 — 지금까지의 모습 그대로다.
// 진한 쪽이 순검정인 이유: 검정과 흰색 중 잘 보이는 쪽을 고르면 어떤 바탕에서도 대비가 4.58:1
// 아래로 내려가지 않는다(두 대비가 같아지는 밝기에서의 값). 덜 검은 회색으로 하면 붉은색·보라색
// 조각이 4.5:1을 넘지 못한다 — 11px 글자는 큰 글자로 쳐 주지 않는다.
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const luminance = c => {
  const m = HEX_RE.exec(String(c).trim());
  if (!m) return 0;
  const h = m[1].length === 3 ? [...m[1]].map(x => x + x).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map(i => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
// 0.179: 흰 글자와 검은 글자의 대비가 뒤집히는 밝기다 (WCAG 대비식을 두 색에 대해 풀면 나온다).
const inkOn = c => (luminance(c) > 0.179 ? '#000' : '#fff');

// 범주가 이보다 많으면 가로 막대로 눕힌다 — 세로 막대의 x 라벨은 열둘을 넘기면 서로를 덮는다.
const HORIZONTAL_FROM = 13;
const HEIGHT = 260;

// 범례에 적는 이름의 상한. 축 눈금의 30자(chart.js MAX_LABEL_LEN)보다 넉넉하다 — 이 목록은 아래로
// 감기므로 이름 하나가 두 줄이 되어도 그림을 밀어내지 않는다. 그래도 상한은 있어야 한다: 조각 이름은
// 조회 결과의 셀 값 그대로라(chart.js는 full에 길이를 두지 않는다) 자유 텍스트 한 문단이 올 수 있고,
// 그러면 열두 개가 답변을 덮는 글자 벽이 된다.
const MAX_LEGEND_LEN = 60;
const clipLegend = s => (s.length > MAX_LEGEND_LEN ? `${s.slice(0, MAX_LEGEND_LEN - 1)}…` : s);

const fmtNum = v => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '');
const pad2 = n => String(n).padStart(2, '0');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ymdOf = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hmOf = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
// 시간 축의 눈금과 그 글자. 글자의 해상도가 눈금 간격보다 거칠면 같은 글자가 잇따라 찍힌다 — 이틀치
// 날짜 자료에 Recharts는 여섯 시간 간격으로 눈금을 세우고, 그것을 날짜로만 찍으면 '03-01'이 넷이다.
// 그래서 형식은 눈금마다 다른 글자가 나오도록 고른다:
//   값이 전부 자정(날짜 자료)이면 눈금을 자료의 날짜 자체로 세우고 연-월-일로 찍는다. 열흘을 넘는
//   범위는 Recharts의 눈금(하루 이상 간격)에 맡겨도 날짜가 겹치지 않는다.
//   시각이 있는 자료는 범위가 열흘 이상이면 눈금 간격이 하루 이상이라 연-월-일, 십 분 안쪽이면 눈금이
//   분 아래로 내려가므로 초까지, 같은 날짜 안이면 시:분, 그 밖은 월-일 시:분(같은 시각이 다른 날짜에
//   되풀이된다). 값이 하나뿐이면 다 찍는다 — 비교할 이웃이 없다.
const timeAxis = rows => {
  const xs = rows.map(r => r.x);
  const span = xs.length > 1 ? xs[xs.length - 1] - xs[0] : 0;
  const dateOnly = xs.every(x => { const d = new Date(x); return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0; });
  const sameDay = ymdOf(new Date(xs[0])) === ymdOf(new Date(xs[xs.length - 1]));
  const tickFormatter = t => {
    const d = new Date(t);
    if (dateOnly || span >= 240 * HOUR) return ymdOf(d);
    const time = span < 10 * MIN ? `${hmOf(d)}:${pad2(d.getSeconds())}` : hmOf(d);
    if (xs.length < 2) return `${ymdOf(d)} ${time}`;
    return sameDay ? time : `${ymdOf(d).slice(5)} ${time}`;
  };
  const ticks = dateOnly && span < 240 * HOUR ? [...new Set(xs)] : undefined;
  return { tickFormatter, ticks };
};

const axisStyle = { fontSize: 11, fill: '#6b7280' };
const tooltipStyle = { fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' };

// 툴팁의 제목은 잘린 라벨(label)이 아니라 원래 값(full)으로 보여준다.
const labelOf = (label, payload) => payload?.[0]?.payload?.full ?? label;

function Cartesian({ spec }) {
  const { type, xKind, series, rows } = spec;
  const hasRight = series.some(s => s.axis === 'right');
  // 범주가 많은 막대는 눕힌다. 오른쪽 축이 있으면 눕히지 않는다 — 눕힌 그래프의 '오른쪽 축'은 없다.
  const horizontal = type !== 'line' && type !== 'area' && xKind === 'category' && !hasRight && rows.length >= HORIZONTAL_FROM;
  const stacked = type === 'stacked-bar';
  const height = horizontal ? Math.max(HEIGHT, rows.length * 22 + 60) : HEIGHT;

  // x축: 범주는 라벨 그대로, 시간·숫자는 수치 축 위에 실제 값의 자리에 찍는다.
  // interval은 양끝을 지키는 쪽으로 — 기본값(preserveEnd)은 축의 왼쪽 끝에 선 첫 눈금의 글자가 축 밖으로
  // 삐져나오면 그 눈금을 지운다. 그러면 이틀치 자료의 축에 둘째 날 하나만 남는다.
  const xAxis = xKind === 'category'
    ? { dataKey: 'label', type: 'category', interval: horizontal ? 0 : 'preserveStartEnd' }
    : { dataKey: 'x', type: 'number', domain: ['dataMin', 'dataMax'], scale: xKind === 'time' ? 'time' : 'linear',
        interval: 'preserveStartEnd', ...(xKind === 'time' ? timeAxis(rows) : { tickFormatter: fmtNum }) };

  const items = series.map((s, i) => {
    const key = `${s.name}#${i}`;
    // dataKey가 함수인 이유: 행의 값은 배열(values)이라 열 이름이 'x'·'label' 같은 우리 키와 겹쳐도 안전하다.
    const common = { dataKey: d => d.values[i], name: s.name, yAxisId: s.axis, isAnimationActive: false };
    const c = color(i);
    // 오른쪽 축의 시리즈는 그래프 종류와 무관하게 선이다 — 막대 위에 겹친 다른 단위의 값은 선일 때만 읽힌다.
    if (s.axis === 'right' || type === 'line') return <Line key={key} {...common} type="monotone" stroke={c} strokeWidth={2} dot={rows.length <= 30} />;
    if (type === 'area') return <Area key={key} {...common} type="monotone" stroke={c} fill={c} fillOpacity={0.18} strokeWidth={2} />;
    // 둥근 모서리는 막대의 끝쪽 둘 — 눕힌 막대는 오른쪽 끝이다.
    return <Bar key={key} {...common} fill={c} stackId={stacked ? 'stack' : undefined} maxBarSize={48}
                radius={stacked ? 0 : horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]} />;
  });

  // Recharts 3은 범례·툴팁 항목을 이름의 가나다순으로 늘어놓는다. 표의 열 순서(=쌓인 순서)를 따라야 읽는 사람이 헷갈리지 않는다.
  const byColumn = item => { const i = series.findIndex(s => s.name === item.name); return i < 0 ? series.length : i; };
  const byColumnLegend = item => byColumn({ name: item.value });

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: hasRight ? 8 : 16, bottom: 4, left: 0 }}>
        {/* 눈금선은 값 축에만. 가로 막대에서는 값 축이 X이므로 세로선을 긋는다. */}
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={!horizontal} vertical={horizontal} />
        {horizontal
          ? <>
              <XAxis type="number" tick={axisStyle} tickFormatter={fmtNum} />
              <YAxis yAxisId="left" dataKey="label" type="category" width="auto" tick={axisStyle} interval={0} />
            </>
          : <>
              <XAxis {...xAxis} tick={axisStyle} minTickGap={12} />
              <YAxis yAxisId="left" width="auto" tick={axisStyle} tickFormatter={fmtNum} />
              {hasRight && <YAxis yAxisId="right" orientation="right" width="auto" tick={axisStyle} tickFormatter={fmtNum} />}
            </>}
        <Tooltip contentStyle={tooltipStyle} formatter={v => fmtNum(v)} labelFormatter={labelOf} itemSorter={byColumn} />
        {/* 시리즈가 하나면 제목이 곧 범례다. 제목도 없으면 이름을 보여줄 자리가 범례뿐이다. */}
        {(series.length > 1 || !spec.title) && <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={byColumnLegend} />}
        {items}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// 조각 라벨: 이름과 비율. Recharts가 라벨 자리(x·y·textAnchor)와 비율(percent)을 계산해 넘겨 준다.
const sliceLabel = ({ x, y, textAnchor, name, percent }) => (
  <text x={x} y={y} textAnchor={textAnchor} dominantBaseline="central" fontSize={11} fill="#374151">
    {`${name} ${(percent * 100).toFixed(1)}%`}
  </text>
);

// 좁은 상자에서 쓰는 라벨. 원 밖에 이름을 적으면 SVG 경계에 그대로 잘린다 — 창을 좁히면 소리 없이
// 글자가 사라진다(실측: 창 360px에서 이름이 최대 37px, 320px에서 50px 잘렸다). 그래서 좁아지면
// 비율만 조각 안에 적고 이름은 범례로 내린다. 글자가 들어갈 수 없는 얇은 조각은 비운다 — 그 조각의
// 이름과 값은 범례와 툴팁에 그대로 있다.
const insideLabel = ({ cx, cy, midAngle, outerRadius, percent, index }) => {
  if (percent < 0.06) return null;
  const rad = (-midAngle * Math.PI) / 180; // Recharts의 각도는 도(°)이고 화면 y는 아래로 자란다
  const r = outerRadius * 0.62;
  return (
    <text x={cx + r * Math.cos(rad)} y={cy + r * Math.sin(rad)} textAnchor="middle"
          dominantBaseline="central" fontSize={11} fontWeight="600" fill={inkOn(color(index))}>
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  );
};

// 상자가 좁은가. 라벨을 밖에 두려면 원 좌우로 이름이 들어갈 자리가 있어야 하는데, 그 여백은
// 상자 폭에서만 나온다(높이는 260px로 고정이다). 380px 아래에서 잘리기 시작한다 — 실측값이다.
// 재는 자리는 figure 하나다(아래 Chart). 그리는 쪽마다 따로 재면 같은 폭을 여러 번 재게 되고,
// 그 값이 필요한 곳도 한 군데씩 늘어난다 — 지금 쓰는 것은 원그래프뿐이다.
function useNarrow(limit = 380) {
  const ref = useRef(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mark = () => setNarrow(el.clientWidth > 0 && el.clientWidth < limit);
    mark();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(mark);
    ro.observe(el);
    return () => ro.disconnect();
  }, [limit]);
  return [ref, narrow];
}

function PieView({ spec, narrow }) {
  // 조각 고르기(큰 것 남기고 나머지는 '기타')는 chart.js pieSlices — 표 순서와 무관하게 값으로 고른다.
  const data = pieSlices(spec.rows);
  const total = data.reduce((a, d) => a + d.value, 0);
  const pct = v => (total > 0 ? `${((v / total) * 100).toFixed(1)}%` : '');
  return (
    <>
    <ResponsiveContainer width="100%" height={HEIGHT}>
      <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <Pie data={data} dataKey="value" nameKey="name" outerRadius={narrow ? '62%' : '72%'} isAnimationActive={false}
             label={narrow ? insideLabel : sliceLabel} labelLine={narrow ? false : { stroke: '#9ca3af' }}>
          {data.map((d, i) => <Cell key={i} fill={color(i)} />)}
        </Pie>
        {/* 이름은 조각(범주)의 것이다 — 시리즈 이름은 제목이 이미 말하고, 툴팁이 답해야 할 것은 '어느 조각인가'다.
            조각 라벨은 잘린 것(name)이고 원래 값은 full에 있다. */}
        <Tooltip contentStyle={tooltipStyle} formatter={(v, name, item) => [`${fmtNum(v)} (${pct(v)})`, item?.payload?.full ?? name]} />
      </PieChart>
    </ResponsiveContainer>
    {/* 이름이 조각 밖으로 나가지 못하는 폭에서만 범례를 단다 — 넓은 화면에서는 라벨이 이미 이름을 말한다.
        recharts의 <Legend>가 아니라 평범한 목록인 이유: 그 범례는 260px 상자 '안'에 들어가 그래프 몫의
        높이를 가져간다. 이름이 길고 조각이 많으면(최대 12개 × 30자) 좁은 폭에서 열 줄 넘게 감겨 남는
        높이가 0 아래로 내려가고, 그러면 원의 중심과 반지름이 엉뚱한 값이 되어 그래프가 상자 밖으로
        밀려 잘린다. 밖에 두면 그냥 아래로 자란다 — 잘리는 것도, 그래프를 먹는 것도 없다.
        이름은 잘리지 않은 것(full)으로 적는다 — 축 눈금과 달리 이 목록은 아래로 감기므로 줄일 이유가
        없고, 이름이 잘려 사라지는 것을 막으려 단 범례가 다시 잘린 이름을 보여줄 수는 없다. */}
    {narrow && (
      <ul className="chart-legend">
        {data.map((d, i) => (
          <li key={i}><i style={{ background: color(i) }} />{clipLegend(String(d.full ?? d.name))}</li>
        ))}
      </ul>
    )}
    </>
  );
}

function ScatterView({ spec }) {
  const { rows, series, xKind, xName } = spec;
  const data = rows.map(r => ({ x: r.x, y: r.values[0], full: r.full }));
  const xAxis = xKind === 'time' ? timeAxis(rows) : { tickFormatter: fmtNum };
  const xFmt = xAxis.tickFormatter;
  return (
    <ResponsiveContainer width="100%" height={HEIGHT}>
      <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="x" type="number" name={xName} domain={['dataMin', 'dataMax']} tick={axisStyle} {...xAxis}
               scale={xKind === 'time' ? 'time' : 'linear'} interval="preserveStartEnd" />
        <YAxis dataKey="y" type="number" name={series[0]?.name} width="auto" tick={axisStyle} tickFormatter={fmtNum} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ strokeDasharray: '3 3' }}
                 formatter={(v, name) => [name === xName ? (xKind === 'time' ? rows.find(r => r.x === v)?.full ?? xFmt(v) : fmtNum(v)) : fmtNum(v), name]} />
        <Scatter data={data} fill={color(0)} isAnimationActive={false} />
      </ScatterChart>
    </ResponsiveContainer>
  );
}

// 제목 + 그래프. 표는 App.jsx가 <details>로 아래에 붙인다 — 이 컴포넌트는 그리는 것만 안다.
export default function Chart({ spec }) {
  const id = useId();
  const [boxRef, narrow] = useNarrow();
  const View = spec.type === 'pie' ? PieView : spec.type === 'scatter' ? ScatterView : Cartesian;
  return (
    <figure className="chart" ref={boxRef} aria-labelledby={spec.title ? id : undefined}>
      {spec.title && <figcaption id={id}>{spec.title}</figcaption>}
      <View spec={spec} narrow={narrow} />
      {spec.clipped && <div className="chart-note">처음 {spec.rows.length}행만 그렸습니다 (전체 {spec.total}행).</div>}
      {/* 명시한 xtype으로 읽지 못해 뺀 행 — '합계' 행이나 다른 꼴의 날짜가 조용히 사라지지 않게 밝힌다. */}
      {spec.skipped > 0 && <div className="chart-note">x를 {spec.xKind === 'time' ? '시간' : '숫자'}으로 읽지 못한 {spec.skipped}행은 그리지 않았습니다.</div>}
      {/* 원그래프가 조각으로 만들 수 없어 뺀 행(값이 0 이하). 표에는 있는 행이라 밝히지 않으면
          비율의 분모가 달라진 것을 사용자가 알 수 없다. */}
      {spec.dropped > 0 && <div className="chart-note">값이 없거나 0 이하인 {spec.dropped}행은 조각으로 그리지 않았습니다.</div>}
    </figure>
  );
}
