// 차트 블록 하나를 그린다. 무엇을 그릴지는 chart.js parseChartBlock이 이미 정했고, 여기는 그 명세를
// Recharts 요소로 옮기는 일만 한다. App.jsx가 React.lazy로 부르므로 이 파일과 recharts는 첫 차트가
// 나올 때까지 내려받지 않는다 — 대부분의 답변은 글과 표뿐이다.
import { useId } from 'react';
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

// 범주가 이보다 많으면 가로 막대로 눕힌다 — 세로 막대의 x 라벨은 열둘을 넘기면 서로를 덮는다.
const HORIZONTAL_FROM = 13;
const HEIGHT = 260;

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

function PieView({ spec }) {
  // 조각 고르기(큰 것 남기고 나머지는 '기타')는 chart.js pieSlices — 표 순서와 무관하게 값으로 고른다.
  const data = pieSlices(spec.rows);
  const total = data.reduce((a, d) => a + d.value, 0);
  const pct = v => (total > 0 ? `${((v / total) * 100).toFixed(1)}%` : '');
  return (
    <ResponsiveContainer width="100%" height={HEIGHT}>
      <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <Pie data={data} dataKey="value" nameKey="name" outerRadius="72%" isAnimationActive={false}
             label={sliceLabel} labelLine={{ stroke: '#9ca3af' }}>
          {data.map((d, i) => <Cell key={i} fill={color(i)} />)}
        </Pie>
        {/* 이름은 조각(범주)의 것이다 — 시리즈 이름은 제목이 이미 말하고, 툴팁이 답해야 할 것은 '어느 조각인가'다.
            조각 라벨은 잘린 것(name)이고 원래 값은 full에 있다. */}
        <Tooltip contentStyle={tooltipStyle} formatter={(v, name, item) => [`${fmtNum(v)} (${pct(v)})`, item?.payload?.full ?? name]} />
      </PieChart>
    </ResponsiveContainer>
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
  const View = spec.type === 'pie' ? PieView : spec.type === 'scatter' ? ScatterView : Cartesian;
  return (
    <figure className="chart" aria-labelledby={spec.title ? id : undefined}>
      {spec.title && <figcaption id={id}>{spec.title}</figcaption>}
      <View spec={spec} />
      {spec.clipped && <div className="chart-note">처음 {spec.rows.length}행만 그렸습니다 (전체 {spec.total}행).</div>}
      {/* 명시한 xtype으로 읽지 못해 뺀 행 — '합계' 행이나 다른 꼴의 날짜가 조용히 사라지지 않게 밝힌다. */}
      {spec.skipped > 0 && <div className="chart-note">x를 {spec.xKind === 'time' ? '시간' : '숫자'}으로 읽지 못한 {spec.skipped}행은 그리지 않았습니다.</div>}
    </figure>
  );
}
