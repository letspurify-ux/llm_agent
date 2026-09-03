import { useState, useRef, useEffect, useLayoutEffect, memo, lazy, Suspense, Component, createContext, useContext } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
// 수식 표기의 계약(무엇이 수식인가 + 그것을 어떻게 그리는가)은 전부 math.js에 있다.
import { REMARK_PLUGINS, REHYPE_PLUGINS } from './math.js';
// 차트 블록의 계약(무엇을 차트로 받는가 + 이력으로 되돌릴 때의 모양)은 chart.js에 있다.
import { parseChartBlock, splitBlock, chartTableMarkdown, chartBlocksToTables, MAX_CHARTS_PER_MESSAGE } from './chart.js';
// trace 패널의 계약(열·셀 표기·CSV)은 trace.js에 있다.
import { columnsOf, cellText, toCsv, csvFileName } from './trace.js';

// 그리는 쪽(recharts·mermaid)은 첫 차트·흐름도가 나올 때 내려받는다 — 둘을 합치면 앱 본체의 몇 배라,
// 글과 표뿐인 대부분의 대화가 그 값을 치를 이유가 없다. 내려받는 동안과 실패했을 때는 표·코드가 보인다.
const Chart = lazy(() => import('./Chart.jsx'));
const Mermaid = lazy(() => import('./Mermaid.jsx'));

// 서버(agent.js normalizeChat)가 실제로 쓰는 상한과 같은 값. 서버 쪽 제한은 본문을 파싱한 뒤에
// 적용되므로 요청 크기를 실제로 묶어두는 것은 이쪽뿐이다 — 넘기면 express의 본문 크기 제한에 걸려
// 이후 모든 요청이 같은 이유로 실패한다(이력은 줄지 않으므로 대화가 복구되지 않는다).
const HISTORY_TURNS = 6;
const HISTORY_LEN = 1500;

// 단순 slice는 경계의 서로게이트 쌍(이모지 등)을 반으로 쪼개 짝 잃은 코드유닛을 남기고,
// 그 값은 서버를 거쳐 LLM 프롬프트로 가는 인코딩 단계에서 U+FFFD로 조용히 훼손된다.
// 경계에 걸린 상위 서로게이트 하나를 떼어 항상 온전한 문자열만 보낸다 (서버 constants.clipText와 같은 방식).
const clipTurn = s => {
  const t = String(s ?? '').slice(0, HISTORY_LEN);
  const last = t.charCodeAt(t.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? t.slice(0, -1) : t;
};

// 요청 상한. 서버 최악 = 루프 진입 예산 180초(agent.js MAX_LOOP_MS) + 마지막 LLM 호출 120초
// + 강제 답변 120초 ≈ 420초이므로 그보다 뒤에 둔다. 짧게 잡으면 서버가 답을 만들어 보내는 중에
// 클라이언트가 먼저 끊어 "서버와 통신하지 못했습니다"로 뭉개진다.
// 이게 없으면 반대로 서버가 응답하지 않을 때 타이핑 표시가 영원히 돈다.
const REQUEST_TIMEOUT_MS = 450_000;

const EXAMPLES = [
  'SPACE 시스템이 뭐야?',
  'VM Agent Dashboard 현황 알려줘',
  '너는 어떤 일을 할 수 있어?',
];

// 차트 블록 안의 표만 렌더할 때의 파이프라인. 값은 조회 결과 그대로라 수식 처리는 필요 없다.
const TABLE_PLUGINS = [remarkGfm];
// '표로 보기'의 표도 본문과 같은 링크 규칙이다(NewTabLink, 아래) — 셀의 URL은 GFM이 자동 링크로 만들고,
// 그것이 같은 탭에서 열리면 대화가 사라진다.
// 그림도 본문과 같은 규칙이다 (AltImage, 아래) — 셀 안의 ![](주소)도 저절로 불려 나가서는 안 된다.
const TABLE_COMPONENTS = { a: NewTabLink, img: AltImage };

// 차트 블록의 표를 평범한 표로. 차트를 그리지 못할 때·내려받는 동안·'표로 보기'가 모두 이것이다.
// 차트를 그리지 않을 때(파싱 실패·예산 초과)는 제목까지 표 위에 남긴다 — 차트 밑 '표로 보기'에서는 제목이 이미 보인다.
// 제목은 markdown에 섞지 않고 글자 그대로 놓는다 — 모델이 쓴 제목의 `*`·`_`·`[`가 강조·링크로 읽히면 안 된다.
// 표가 없는 블록: `data:` 참조가 남아 있으면 서버가 채우지 못한 것이다(서버가 못 알아본 펜스 등) —
// 설정 줄을 코드로 보여줘 봐야 사용자는 읽을 수 없으니 서버가 쓰는 것과 같은 안내 문장으로 바꾼다.
// 참조도 표도 없는 블록은 무엇인지 모르므로(모델이 펜스를 다른 용도로 썼을 수 있다) 원문 그대로 둔다.
function ChartTable({ text, withTitle = false }) {
  const md = chartTableMarkdown(text);
  const { config } = splitBlock(text);
  const title = String(config.title ?? '').trim();
  if (!md) {
    if (config.data === undefined) return <pre><code>{text}</code></pre>;
    return <p><em>{title ? `'${title}' ` : ''}차트를 그리지 못했습니다: 조회 결과를 채우지 못했습니다</em></p>;
  }
  return (
    <>
      {withTitle && title && <p><strong>{title}</strong></p>}
      <ReactMarkdown remarkPlugins={TABLE_PLUGINS} components={TABLE_COMPONENTS}>{md}</ReactMarkdown>
    </>
  );
}

// 그리는 쪽이 렌더 중에 던지면(모델이 만든 값이라 무엇이 올지 모른다) React는 앱 전체를 내린다 —
// 대화가 통째로 사라진다. 그 블록 하나만 폴백으로 바꾼다.
class BlockBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e) { console.warn('[chart] render failed:', e?.message ?? e); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

// 메시지 하나에 그리는 차트 수의 예산. 블록은 자기가 몇 번째인지 모르므로 메시지가 렌더될 때마다
// 새 카운터를 내려 주고 블록이 차례로 가져간다. 렌더 순서가 곧 문서 순서라 앞의 넷이 차트가 된다.
// (Message는 memo라 본문이 그대로면 다시 렌더되지 않고, 다시 렌더되면 카운터도 새것이다.)
const ChartBudget = createContext(null);

function ChartBlock({ text }) {
  const budget = useContext(ChartBudget);
  const parsed = parseChartBlock(text);
  const draw = parsed.ok && budget && budget.n++ < MAX_CHARTS_PER_MESSAGE;
  const titled = <ChartTable text={text} withTitle />;
  if (!draw) return titled;
  const table = <ChartTable text={text} />;
  // 그리다 던지면 '그리지 않은 블록'과 같은 모양(제목 + 표)으로 — '표로 보기'까지 경계 안에 두어 표가 두 번 남지 않게 한다.
  return (
    <BlockBoundary fallback={titled}>
      <Suspense fallback={table}>
        <Chart spec={parsed.spec} />
      </Suspense>
      {/* 차트는 값을 읽는 데 한계가 있다(정확한 수치·잘린 라벨·그리지 않은 열). 표는 늘 곁에 둔다. */}
      <details className="chart-table"><summary>표로 보기</summary>{table}</details>
    </BlockBoundary>
  );
}

function MermaidBlock({ text }) {
  const code = <pre><code>{text}</code></pre>;
  return (
    <BlockBoundary fallback={code}>
      <Suspense fallback={code}>
        <Mermaid text={text} />
      </Suspense>
    </BlockBoundary>
  );
}

// 코드펜스의 언어 표시(```chart → class="language-chart")를 hast 노드에서 읽는다. react-markdown은
// <pre> 컴포넌트에 node를 넘겨 주고, 그 첫 자식이 <code>다. 언어가 chart·mermaid면 우리가 그리고,
// 그 밖은 원래대로 코드블록이다. 대소문자는 가리지 않는다(```Chart 도 온다).
const codeOf = node => {
  const code = node?.children?.[0];
  if (code?.type !== 'element' || code.tagName !== 'code') return null;
  const cls = code.properties?.className;
  const lang = (Array.isArray(cls) ? cls : [cls]).map(c => /^language-(.+)$/i.exec(String(c ?? ''))?.[1]).find(Boolean);
  const text = (code.children ?? []).map(c => (c.type === 'text' ? c.value : '')).join('').replace(/\n$/, '');
  return { lang: lang?.toLowerCase(), text };
};
function PreOrBlock({ node, children, ...props }) {
  const code = codeOf(node);
  if (code?.lang === 'chart') return <ChartBlock text={code.text} />;
  if (code?.lang === 'mermaid') return <MermaidBlock text={code.text} />;
  return <pre {...props}>{children}</pre>;
}
// 답변 속 링크는 새 탭에서 연다 — 같은 탭에서 열리면 대화가 통째로 사라진다(이력은 서버에 없다).
// 페이지 안 앵커(#…)만 제자리에서 연다. noopener는 새 탭이 이 창(window.opener)을 만지지 못하게,
// noreferrer는 사내 URL이 링크 대상에 referer로 새지 않게 한다.
// javascript: 같은 위험한 주소는 react-markdown이 걸러 href=""로 넘기는데, 빈 href는 '현재 문서'라
// 누르면 페이지가 다시 읽혀 대화가 사라진다 — 그런 것은 href 없는 글자로만 남긴다.
// 링크 안인가. 그 안에서는 <a>를 또 열 수 없다 — 중첩 앵커는 DOM이 받아들이지 않고(React가 경고를
// 내며 그대로 그린다) 바깥 링크가 눌리지 않게 된다. 그림(AltImage)이 이것을 보고 글자로만 남는다.
const InLink = createContext(false);
function NewTabLink({ node, href, children, ...props }) {
  const inPage = typeof href === 'string' && href.startsWith('#');
  const link = typeof href !== 'string' || href === ''
    ? <a {...props}>{children}</a>
    : <a href={href} {...props} {...(inPage ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>{children}</a>;
  return <InLink.Provider value={true}>{link}</InLink.Provider>;
}
// 답변 속 그림(![글자](주소))은 자동으로 불러오지 않는다. 그 주소는 모델이 쓴 것이고, 모델이 보는
// 재료에는 조회 결과(자유 텍스트가 섞인다)가 들어 있다 — 브라우저는 사용자가 누르기도 전에 그 주소를
// 부르므로, 사내 화면이 밖으로 신호를 보내는(그것도 주소에 값을 실어) 유일한 통로가 그것이다.
// 링크에 noreferrer까지 붙여 사내 주소가 새지 않게 하는 이 화면에서, 저절로 나가는 요청은 앞뒤가 맞지 않는다.
// 이 앱의 답변에 그림이 실릴 자리도 없다 — 차트도 흐름도도 우리가 그린다. 그래서 주소는 링크로만 남긴다:
// 무엇을 가리키는지 보이고, 열지 말지는 사람이 정한다. (그림을 정말 띄워야 하는 날이 오면 여기만 되돌린다)
function AltImage({ node, src, alt, title }) {
  const label = String(alt || title || '').trim();
  const inLink = useContext(InLink);
  // 링크로 남기는 것은 http(s)와 주소만 적힌 상대 경로(chart.png, /img/a.png, ?id=3)뿐이다.
  // 그 밖의 방식(mailto:·tel:·data: 등)은 그림 자리에 올 것이 아니고, 눌러서 좋을 것도 없다.
  // 라이브러리가 위험한 주소를 걸러 주는 것에 기대지 않고 여기서도 한 번 더 좁힌다.
  // 링크 안이면(inLink) <a>를 또 열 수 없으므로 글자로만 — 누를 자리는 바깥 링크가 이미 만들어 두었다.
  // '//호스트/…'는 콜론이 없어 상대 주소처럼 보이지만 바깥으로 나가는 주소다 — 함께 막는다.
  const scheme = typeof src === 'string' && /^[a-z][a-z0-9+.-]*:/i.exec(src);
  if (typeof src !== 'string' || src === '' || inLink || src.startsWith('//')
      || (scheme && !/^https?:$/i.test(scheme[0]))) {
    return <em>🖼 {label || '이미지'}</em>;
  }
  return <a href={src} target="_blank" rel="noopener noreferrer" title={title || undefined}>🖼 {label || src}</a>;
}
// 플러그인 배열과 마찬가지로 모듈 상수여야 한다 — 새 객체를 넘기면 매 렌더가 파이프라인 재구축이다.
const MD_COMPONENTS = { pre: PreOrBlock, a: NewTabLink, img: AltImage };

// 입력창 타이핑마다 전체 대화가 다시 렌더되지 않도록 메시지 하나를 분리해 memo한다
// (assistant 답변은 markdown 파싱 비용이 있어 대화가 길어질수록 체감된다)
// 조회된 행을 CSV 파일로 내려준다. 클립보드가 아닌 파일인 이유: navigator.clipboard는 https·localhost
// 밖(사내망의 http 배포)에서는 없고, 수백 행짜리 결과는 어차피 다른 도구로 가져가 쓰는 것이다.
function downloadCsv(step) {
  const url = URL.createObjectURL(new Blob([toCsv(step.rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = csvFileName(step.query_name, step.targetDb);
  // 문서에 붙였다 뗀다 — 떠 있는 앵커의 click()은 브라우저에 따라 내려받기를 시작하지 않는다(구형 Firefox).
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 즉시 해제하면 일부 브라우저가 내려받기를 시작하기 전에 URL을 잃는다 — 한 틱 뒤에 해제한다.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 조회 건수 문구. 조회 건수와 실린 행 수는 다를 수 있다 — 몇 건을 보고 있는지 밝히지 않으면
// 사용자가 실린 것을 전부로 읽는다 (서버 result.js clientTrace가 omittedRows·capped를 준다).
function countLabel(t) {
  const n = t.rows?.length ?? 0;
  // rowCount는 서버가 늘 준다(result.js clientTrace). 없으면 실린 행 수로 말한다 — 'undefined건'은
  // 화면에 나가서는 안 되는 글자이고, 이 패널의 다른 값들도 모두 없을 때를 정해 두고 있다.
  const total = t.rowCount ?? n;
  if (t.omittedRows) return `${total}건 (아래는 그중 ${n}건)`;
  if (t.capped) return `${n}건 이상 — 조회 상한에 걸려 처음 ${n}건만 가져왔습니다`;
  return `${total}건`;
}

// 실행된 쿼리 한 건: 이름·대상 DB·바인드 한 줄 + 조회된 행 전부의 표.
// 모델은 결과를 20행까지만 보고 그중 몇 행만 답변에 옮겨 적으므로, 사용자가 조회 결과 전체를 보는
// 자리는 이 표뿐이다. 그래서 여기서는 행을 자르지 않는다(서버도 자르지 않는다 — result.js).
// showGrid: 표는 패널이 한 번 펼쳐진 뒤에만 만든다(Message가 준다). 한 스텝이 1000행 × 30열이면 셀
// 6만 개다 — 답변마다 펼치지도 않은 표를 DOM에 올리면 대화가 길어질수록 화면 전체가 무거워진다.
function TraceStep({ step: t, showGrid }) {
  const rows = t.rows ?? [];
  return (
    <div className="trace-step">
      <div className="trace-head">
        {/* 대상 DB가 여럿인 쿼리는 쿼리 이름만으로 무엇을 조회했는지 알 수 없다.
            대상이 하나인 등록에서도 함께 보여준다 — 있고 없고가 등록 형태에 따라 갈리면
            같은 화면이 어떤 줄에서만 DB를 밝히게 되어 그 차이가 뜻으로 읽힌다.
            실행되지 않은 스텝(오류·미등록)에는 서버가 값을 주지 않을 수 있다. */}
        <code>{t.query_name}{t.targetDb ? `@${t.targetDb}` : ''} {JSON.stringify(t.params)}</code>
        <span className="trace-count">{t.error ? `오류: ${t.error}` : countLabel(t)}</span>
        {rows.length > 0 && <button type="button" className="trace-csv" onClick={() => downloadCsv(t)}>CSV 내려받기</button>}
      </div>
      {showGrid && rows.length > 0 && <TraceGrid rows={rows} />}
    </div>
  );
}

function TraceGrid({ rows }) {
  const cols = columnsOf(rows);
  const ref = useRef(null);
  // 이 표가 상자 밖으로 나가 있는가(세로든 가로든). 종이에는 스크롤이 없어 그만큼이 그냥 잘리므로,
  // 잘리는 표에만 인쇄용 안내를 붙인다 — 다 들어가는 표에까지 붙이면 거짓말이 된다.
  const [clipped, setClipped] = useState(false);
  // 세로 스크롤바가 실제로 생긴 표는 휠을 붙잡는다(overscroll-behavior: contain) — 표 위에서 굴린 휠은
  // 표만 움직이고, 끝에 닿아도 대화로 번지지 않는다. 그냥 두면 Chrome은 휠 제스처를 표에 걸어(latching)
  // 끝에 닿은 뒤로는 멈춘 듯하다가 잠깐 쉬면 그때부터 대화가 움직여, 같은 자리에서 굴려도 표가 움직일지
  // 대화가 움직일지 매번 다르다. 대화를 내리려면 표 밖(말풍선 옆 여백)에서 굴린다.
  // 스크롤바가 없는 표에 걸면 안 된다 — Chrome은 contain인 상자를 굴릴 것이 없어도 경계로 삼아,
  // 몇 줄짜리 표가 휠이 죽는 자리가 된다. 그래서 CSS가 아니라 여기서 실제로 넘치는지 재어 건다.
  // 숨은 부분이 보이는 높이의 절반도 안 되는 표도 걸지 않는다 — 몇 px 움직이고 멎는 표는 읽을 것이
  // 있는 스크롤 상자가 아니라 휠이 죽는 자리다. 그런 표는 원래 규칙대로 잠깐 쉬면 대화로 넘어간다.
  // 높이 상한이 55vh라 창 높이에 따라 넘치고 안 넘치고가 달라지므로 크기가 바뀔 때마다 다시 잰다
  // (패널이 접혀 있으면 높이가 0이라 걸리지 않고, 펼치면 크기가 바뀌어 다시 잰다).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const mark = () => {
      el.style.overscrollBehavior = el.scrollHeight - el.clientHeight > el.clientHeight / 2 ? 'contain' : '';
      setClipped(el.scrollHeight - el.clientHeight > 1 || el.scrollWidth - el.clientWidth > 1);
    };
    mark();
    const ro = new ResizeObserver(mark);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows]);
  return (
    <>
    <div className="trace-grid" ref={ref}>
      <table>
        <thead>
          <tr><th className="idx">#</th>{cols.map(c => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="idx">{i + 1}</td>
              {cols.map(c => {
                const v = r?.[c];
                return <td key={c} className={typeof v === 'number' ? 'num' : v == null ? 'null' : undefined}><div className="cell">{cellText(v)}</div></td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {/* 화면에서는 감춰 두고 인쇄에서만 보인다 (index.html의 @media print) */}
    {clipped && <p className="trace-print-note">인쇄물에는 이 표의 화면에 보이던 부분만 담깁니다 — 전체 {rows.length}행은 ‘CSV 내려받기’로 저장하세요.</p>}
    </>
  );
}

// '⚡ 실행된 쿼리' 패널. 펼침 상태를 Message가 아니라 여기 두는 이유: Message가 다시 렌더되면 markdown을
// 다시 파싱하고 차트를 다시 그린다 — 패널을 여닫는 일이 그 비용을 내서는 안 된다.
function TracePanel({ trace }) {
  // 한 번이라도 펼쳤는가 — 그 뒤로는 접어도 표를 지우지 않는다(다시 펼칠 때 재생성 비용을 내지 않게).
  const [opened, setOpened] = useState(false);
  return (
    <details className="trace" onToggle={e => { if (e.currentTarget.open) setOpened(true); }}>
      <summary>⚡ 실행된 쿼리 {trace.length}건</summary>
      {trace.map((t, j) => <TraceStep key={j} step={t} showGrid={opened} />)}
    </details>
  );
}

const Message = memo(function Message({ role, text, trace }) {
  return (
    <div className={`row ${role}`}>
      <div className={`bubble ${role}`}>
        {role === 'assistant'
          ? <div className="md">
              {/* 플러그인 배열은 math.js의 상수를 그대로 쓴다 — react-markdown은 렌더마다 options로
                  파이프라인을 다시 조립하므로, 여기서 새 배열 리터럴을 만들면 매 렌더가 프로세서 재구축이 된다. */}
              <ChartBudget.Provider value={{ n: 0 }}>
                <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MD_COMPONENTS}>{text}</ReactMarkdown>
              </ChartBudget.Provider>
            </div>
          : text}
        {trace?.length > 0 && <TracePanel trace={trace} />}
      </div>
    </div>
  );
});

// '동작 줄이기' 설정. MediaQueryList를 한 번 만들어 두고 쓸 때마다 .matches를 읽는다 — 값이 아니라
// 창을 들고 있는 셈이라 설정이 바뀌면 다음 스크롤부터 바로 따른다. 오래된 환경(matchMedia 없음)에서는
// undefined가 되고, 쓰는 쪽의 ?.가 '줄이지 않음'으로 읽는다.
const REDUCED = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

// 손을 뗀 뒤에도 이만큼은 '만지는 중'으로 친다 (아래 busy 참고). 손가락을 뗀 화면은 관성으로 더
// 미끄러지고, 표 위에서 굴린 휠도 한 번에 오지 않고 몇십 ms 간격으로 이어 온다.
const BUSY_MS = 600;

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const historyRef = useRef([]);      // 서버로 보낼 대화 이력 (setState 비동기와 무관하게 즉시 반영)
  const composingRef = useRef(false); // IME 조합 진행 중
  const pendingSendRef = useRef(false); // 조합 중에 눌린 Enter — 조합이 확정되면 그때 보낸다
  const sendingRef = useRef(false);   // 전송 진행 중 (loading state와 달리 같은 tick에도 즉시 보인다)
  const abortRef = useRef(null);      // 진행 중인 요청 (홈으로 돌아갈 때 끊는다)
  // 대화의 세대 번호. 홈으로 돌아갈 때마다 올라가고, ask는 시작 시점의 값을 들고 있다가
  // 응답을 반영하기 전에 대조한다 — 끊긴 요청의 뒤늦은 응답이 새 대화에 끼어드는 것을 막는다.
  const sessionRef = useRef(0);
  const chatRef = useRef(null);
  // 화면이 대화의 바닥에 붙어 있는가. 말풍선이 뒤늦게 커질 때 따라 내려갈지를 이것으로 정한다.
  const stuckRef = useRef(true);
  const lastTopRef = useRef(0);
  const inputAtRef = useRef(0);   // 사용자가 마지막으로 화면을 만진 시각 (아래 byUser 참고)
  const lastHeightRef = useRef(0); // 마지막으로 본 내용 높이 — 관찰자와 onChatScroll이 함께 갱신한다
  const growRef = useRef(null); // 말풍선 크기 변화를 보는 ResizeObserver (아래 효과가 처음 필요할 때 만든다)
  const glideRef = useRef(null); // 진행 중인 미끄러짐 { raf, expect } (아래 glide 참고)
  const dragRef = useRef(null); // 대화 안에서 끌고 있는 중인가 { x, y, moved, vertical } (아래 holding 참고)
  const panRef = useRef(false);   // 손가락으로 화면을 밀고 있는가 (touchmove가 켜고 touchend가 끈다)
  const busyRef = useRef(0);      // 이 시각까지는 만지는 중으로 친다 (아래 busy 참고)
  const busyTimerRef = useRef(0); // 그 여운이 끝나면 한 번 더 확인하는 타이머 (아래 markBusy 참고)
  const pendingRef = useRef(false); // 만지는 중이라 건너뛴 크기 변화가 있는가 (그 타이머가 갚는다)
  const emptyRef = useRef(true); // 대화가 비었는가 — ResizeObserver 콜백은 한 번만 만들어져 messages를 못 본다

  // 대화를 목표까지 미끄러뜨린다. 브라우저의 smooth 스크롤(scrollIntoView·scrollBy)을 쓰지 않는 이유:
  // 그 애니메이션이 도는 동안(1000px에 1초쯤) 사용자의 휠은 통째로 버려진다 — Chrome은 진행 중인 프로그램
  // 스크롤 애니메이션에 휠을 얹지 못한다. 답이 온 순간 위로 굴려도 화면은 끝까지 내려가고 만다.
  // 여기서는 매 프레임 scrollTop을 직접 놓고, 우리가 놓은 값과 다른 scrollTop이 보이면(휠·썸 드래그·키보드,
  // onChatScroll이 본다) 그 자리에서 멈춘다 — 사용자가 언제나 이긴다. 목표는 매 프레임 다시 재므로
  // '바닥'은 내려가는 동안 더 자라도(차트가 늦게 서도) 그 바닥이다.
  const stopGlide = () => { if (glideRef.current) cancelAnimationFrame(glideRef.current.raf); glideRef.current = null; };
  function glide(el, target, instant) {
    stopGlide();
    // '동작 줄이기'를 켠 사람에게는 한 번에 놓는다. 브라우저의 smooth 스크롤은 이 설정을 스스로 지켰지만
    // 우리가 프레임을 직접 놓기 시작한 이상 지키는 것도 우리 몫이다 — 화면이 흐르는 것 자체가 어지러운
    // 사람들이 있다. 매번 다시 묻는 이유는 설정이 대화 도중에도 바뀌기 때문이다.
    if (instant || REDUCED?.matches) { el.scrollTop = target(); return; }
    const t0 = performance.now(); const from = el.scrollTop; const D = 350;
    const g = glideRef.current = { raf: 0, expect: from };
    const step = now => {
      const p = Math.min(1, (now - t0) / D);
      el.scrollTop = from + (target() - from) * (1 - (1 - p) ** 3);
      g.expect = el.scrollTop; // 실제로 놓인 값(반올림·경계에 걸린 값)과 비교해야 한다
      if (p < 1) { g.raf = requestAnimationFrame(step); return; }
      glideRef.current = null;
      // 다 내려왔는데도 바닥이 남아 있으면 한 번 더 놓는다. 미끄러지는 마지막 프레임과 겹쳐 내용이
      // 자라면 그 변화의 ResizeObserver는 아직 우리가 미끄러지는 중일 때 와서 같은 목표를 세워 두고
      // 가고, 그 뒤로는 크기가 잠잠해 아무도 다시 알려 주지 않는다 — 답의 끝 몇 십 px이 입력창 뒤에
      // 남는 자리가 여기다(실측 25px). 붙어 있고 손을 대고 있지 않을 때만이다.
      if (stuckRef.current && !holding() && el.scrollHeight - el.scrollTop - el.clientHeight >= 8) el.scrollTop = target();
    };
    g.raf = requestAnimationFrame(step);
  }
  // 이 화면이 '쉬는 자리'. 대화가 있으면 바닥(새 말이 붙는 곳)이지만, 비어 있으면 맨 위다 — 첫 화면은
  // 인사말과 예시 질문 한 덩어리라, 창이 낮아 다 안 들어갈 때 바닥으로 내리면 인사말과 로고가 화면
  // 위로 넘어가 버린다(높이 300px에서 열면 칩 몇 개만 보였다). 처음 여는 화면은 처음부터 보여야 한다.
  const restOf = el => () => (emptyRef.current ? 0 : el.scrollHeight - el.clientHeight);
  // 대화 안에서 뭔가를 잡고 있는 중인가(마우스로 글을 고르는 중·표를 끄는 중, 손가락으로 미는 중).
  // 그동안은 화면을 움직이지 않는다 — 잡고 있는 것이 손 밑에서 달아나면 고르던 글도, 보던 행도 잃는다.
  // 누르기만 한 것(클릭·탭)은 잡은 것이 아니다: 답이 도착한 그 찰나에 아무 데나 눌렀다고 답을 놓치면 안 된다.
  const holding = () => !!dragRef.current?.moved || panRef.current;
  // 화면이 움직인 것이 사용자 때문인가. 스크롤 이벤트만으로는 알 수 없다 — 같은 이벤트를 우리(glide)도,
  // 브라우저도(내용이 위에서 자라거나 줄면 보던 것을 붙잡으려고 스스로 자리를 옮긴다) 일으키기 때문이다.
  // 세 번을 고쳐 보고 나서야 안 것은, 그 둘을 자리와 높이의 산수로는 가를 수 없다는 것이다(자라는 쪽과
  // 줄어드는 쪽이 한 프레임에 같이 오면 셈이 맞지 않는다). 그래서 짐작 대신 사용자 입력을 직접 듣는다:
  // 휠·키·누름·손가락. 그 신호 없이 자리가 바뀐 것은 사용자의 뜻이 아니므로 따라가기를 끊지 않는다.
  const INPUT_MS = 400; // 입력 하나가 일으키는 스크롤이 이 안에 온다 (관성·부드러운 스크롤 포함)
  const noteInput = () => { inputAtRef.current = performance.now(); };
  const byUser = () => performance.now() - inputAtRef.current < INPUT_MS;
  // 브라우저가 스스로 자리를 옮기는 것은 내용의 크기가 변할 때뿐이다(위가 자라면 보던 것을 붙잡으려
  // 밀어 내리고, 줄면 바닥 너머로 나간 자리를 깎는다). 그래서 '지금 크기가 막 변했는가'를 함께 본다.
  // 시각(타임스탬프)이 아니라 높이로 재는 이유: 한 프레임 안에서 스크롤 이벤트가 ResizeObserver보다
  // 먼저 온다(HTML 명세의 렌더링 갱신 순서). 시각으로 재면 그 첫 스크롤이 늘 '크기 변화 밖'으로 보인다.
  // 크기가 변하지 않았는데 우리가 놓지도 않은 움직임이면 그것은 사용자다 — 입력 신호가 오지 않는
  // 길들(파이어폭스의 스크롤바 끌기, 페이지 내 찾기, 가운데 단추 자동 스크롤)이 여기로 걸린다.
  const resizing = el => el.scrollHeight !== lastHeightRef.current;
  // 여기에 '방금 전까지 만지던 동안'을 더한 것. 손을 뗀 화면은 관성으로 더 미끄러지고, 표 위의 휠은
  // 이어서 온다 — 그 틈을 비워 두면 그 사이에 자란 차트가 읽던 자리를 끌어내린다. 뒤늦게 커지는 것을
  // 따라갈지는 이것으로 정하고, 새 말풍선은 이 여운까지 기다리지 않는다(holding만 본다).
  const markBusy = () => {
    busyRef.current = performance.now() + BUSY_MS;
    // 여운이 끝나면 한 번 더 확인한다. ResizeObserver는 '변할 때'만 오므로, 여운 안에 온 변화를
    // 건너뛰면 다시 알려 주는 것이 없다 — 표를 굴리는 사이에 차트 하나가 서고 끝난 답은 그 끝이
    // 입력창 뒤에 영영 남았다(실측 316px). 그동안 사용자가 계속 만지고 있으면 그쪽에서 여운을
    // 다시 늘리므로 이 확인도 그만큼 미뤄진다.
    clearTimeout(busyTimerRef.current);
    busyTimerRef.current = setTimeout(() => {
      const el = chatRef.current;
      // 관찰자가 만지는 중이라 건너뛴 것이 있을 때만 갚는다. 조건도 그쪽과 같아야 한다 — 특히 빈 첫
      // 화면(emptyRef)에서는 '쉬는 자리'가 맨 위라, 여기서 따라가면 칩을 보려고 내려 둔 화면이 맨 위로
      // 튕긴다. 조건을 한 번 더 적는 대신 건너뛴 사실만 표시로 남겨 두는 이유가 이것이다.
      if (!pendingRef.current || !el || emptyRef.current || !stuckRef.current || busy()) return;
      pendingRef.current = false;
      glide(el, restOf(el));
    }, BUSY_MS + 20);
  };
  const busy = () => holding() || performance.now() < busyRef.current;

  // 새 말풍선이 붙으면 바닥으로 내린다. 그런데 답변은 그려진 뒤에도 더 커진다 — 차트는 모듈을 내려받은
  // 뒤에, 흐름도는 그린 뒤에 자리를 잡고 그 전에는 표·코드가 대신 서 있다. 이 스크롤은 그 전에 일어나므로
  // 그대로 두면 답의 끝(차트)이 화면 밖으로 밀려나 사용자가 직접 내려야 한다. 그래서 말풍선의 크기가
  // 변할 때 바닥에 붙어 있었으면 다시 바닥으로 따라간다. 위로 올려 옛 답을 읽는 중이면 두는데 —
  // 그때 커지는 것은 사용자가 편 '표로 보기'이지 우리가 따라갈 일이 아니다(붙어 있는지는 onScroll이 판정한다).
  useEffect(() => {
    // 내가 보낸 말은 언제나 바닥으로 — 보려고 보낸 것이다. 답이 온 것은 붙어 있을 때만 따라간다: 답을
    // 기다리는 동안(조회가 길면 몇 분) 위로 올려 옛 답을 읽고 있는데 도착했다고 바닥으로 끌어내리면
    // 읽던 자리를 잃는다. 내려가 보면 답은 거기 있고, 바닥에 닿으면 다시 붙는다.
    const last = messages[messages.length - 1];
    const el = chatRef.current;
    if (!el) return;
    emptyRef.current = !last;
    if (!last || last.role === 'user' || (stuckRef.current && !holding())) {
      glide(el, restOf(el));
      stuckRef.current = true; // 새 말풍선은 바닥으로 내려가 보는 것이 뜻이다 — 내려가는 동안 커지는 것도 따라간다
    }
    if (typeof ResizeObserver === 'undefined') return;
    if (!growRef.current) {
      growRef.current = new ResizeObserver(entries => {
        // 건너뛰든 따라가든 '크기가 여기까지 변했다'는 것은 남긴다 — 그러지 않으면 onChatScroll의
        // 기준이 낡아, 한참 뒤의 평범한 스크롤까지 크기 변화 중인 것으로 보인다.
        lastHeightRef.current = el.scrollHeight;

        // 비어 있는 첫 화면에는 따라갈 것이 없다. 그 '쉬는 자리'는 맨 위인데(restOf), 크기가 바뀔 때마다
        // 그것을 다시 놓으면 낮은 창에서 예시 칩을 보려고 내려 둔 화면이 입력창이 한 줄 자랄 때마다,
        // 창을 조금 줄일 때마다 맨 위로 튕긴다 — 맨 위로 되돌리는 것은 홈으로 돌아갈 때 한 번이면 된다.
        if (emptyRef.current || !stuckRef.current) return;
        // 만지는 중이면 건너뛰되 '건너뛰었다'를 남긴다. ResizeObserver는 '변할 때'만 오므로, 그냥
        // 돌아가면 그 변화는 아무도 다시 알려 주지 않아 답의 끝이 입력창 뒤에 영영 남는다(실측 316px).
        if (busy()) { pendingRef.current = true; return; }
        pendingRef.current = false;
        // 스크롤 상자 자신이 변한 것(입력창이 여러 줄로 커짐, 창 크기 조정)은 즉시 붙인다 — 부드럽게 하면
        // 창을 끄는 동안 바닥이 한 박자 뒤에서 따라와 흔들린다. 내용이 자란 것은 부드럽게 내려간다.
        const boxResized = entries.some(x => x.target === el);
        glide(el, restOf(el), boxResized);
      });
    }
    // 둘을 본다. 안쪽 열(.chat-inner)은 어느 말풍선이 커져도 그만큼 자란다 — 내용의 변화. 스크롤 상자
    // (.chat) 자신은 내용이 늘어도 그대로지만 입력창이 여러 줄로 커지거나 창 높이가 줄면 작아진다 —
    // 그때 브라우저는 scrollTop을 두므로 바닥에 붙어 있던 화면의 끝이 입력창 뒤로 숨는다(폭이 바뀌면
    // 열도 함께 변해 잡히지만, 높이만 바뀌면 열은 그대로다). 이미 보고 있는 요소를 다시 넣는 것은
    // 무해하다(첫 보고가 한 번 더 올 뿐이고, 그 처리는 바닥으로 내리는 것이다).
    growRef.current.observe(el);
    growRef.current.observe(el.firstElementChild);
  }, [messages, loading]);
  useEffect(() => {
    // 사용자가 '표로 보기'·실행 과정을 직접 펼치거나 접은 것은 따라가지 않는다 — 펼친 것은 위(머리글)부터
    // 읽으려는 것인데 바닥으로 내리면 그 끝이 보인다. 뗐다가 스크롤이 바닥에 닿으면 다시 붙는다.
    // toggle은 버블링하지 않으므로 목록에서 capture로 듣는다.
    // summary의 click도 듣는 이유: toggle은 open이 바뀐 뒤 과제(task)로 뒤늦게 오는데, '표로 보기'처럼
    // 내용이 미리 그려져 있는 패널은 클릭한 그 프레임에 열이 자라고 ResizeObserver는 같은 프레임의
    // 렌더링 단계에서 그것을 본다 — toggle보다 먼저. 그러면 아직 붙어 있는 줄 알고 바닥으로 내려
    // 표의 끝이 보인다. click은 열리기 전에 오므로 여기서 먼저 뗀다(키보드 Enter·Space도 click을 낸다).
    // toggle은 그 밖의 경로(페이지 내 찾기가 접힌 내용을 스스로 펼치는 것)를 위해 남긴다.
    // 떼는 것은 '펼침'뿐이다. 접는 것은 내용을 줄일 뿐이라 바닥에 붙어 있던 화면은 그대로 바닥이다 —
    // 여기서도 떼 버리면 답을 기다리며 패널을 접은 사람은 바닥에 있으면서도 도착한 답을 못 본다
    // (답은 붙어 있을 때만 따라가므로 화면 밑에 놓인다).
    const el = chatRef.current;
    const unstick = () => { stuckRef.current = false; };
    const onSummaryClick = e => { const d = e.target.closest?.('summary')?.parentElement; if (d && !d.open) unstick(); };
    const onToggle = e => { if (e.target.open) unstick(); };
    el?.addEventListener('click', onSummaryClick, true);
    el?.addEventListener('toggle', onToggle, true);

    // 헤더와 입력창 위에서 굴린 휠은 아무 일도 하지 않는다 — 이 화면에서 스크롤되는 것은 대화뿐인데
    // 그 둘은 대화 밖에 있고, 사슬의 끝인 뷰포트는 움직이지 않기 때문이다. 창이 낮으면 그 죽은 자리가
    // 화면의 1/3이다(높이 360px에서 헤더 69 + 입력창 88). 대화로 넘긴다 — PageUp·PageDown과 같은 규칙으로,
    // 입력창이 그 방향으로 더 갈 수 있으면 입력창 몫으로 둔다. 대화 안에서 굴린 것은 손대지 않는다:
    // 브라우저가 이미 처리했고(표 안이면 표가 받는다) 여기서 더하면 두 번 움직인다.
    // 대화 안에서 무언가를 끌기 시작하면(글 고르기, 안쪽 표 끌기) 그동안은 따라가지 않는다 — 답이
    // 도착했다고 화면을 내리면 고르던 글이, 보던 행이 손 밑에서 달아난다(실측: 답이 오는 순간
    // 1,000px가 미끄러져 잡고 있던 표가 화면 위로 사라졌다). 놓는 곳은 대화 밖일 수 있으므로
    // 움직임·놓음은 창에서 듣는다. (손가락으로 미는 것은 pointer 이벤트로 잡히지 않는다 — 바로 아래 참고)
    const onDown = e => {
      // 오른쪽·가운데 단추로 누른 것은 끄는 것이 아니다(글을 고르지도, 표를 끌지도 않는다). 두 번째
      // 손가락도 마찬가지다 — 첫 손가락의 시작점을 덮어쓰면 그중 하나만 떼어도 끌기가 통째로 풀린다.
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      dragRef.current = { x: e.clientX, y: e.clientY, moved: false, vertical: false };
    };
    const onMove = e => {
      const d = dragRef.current;
      if (!d) return;
      // 놓은 것을 놓치는 경로가 있다: 오른쪽 클릭 메뉴가 뜬 사이의 pointerup, 창 밖에서 뗀 단추.
      // 눌린 단추 없이 오는 마우스 움직임이 곧 '이미 놓았다'는 뜻이다 — 여기서 끝낸 것으로 친다.
      // 놓친 채로 두면 dragRef가 영영 남아 새로고침할 때까지 따라가기가 죽는다.
      if (e.pointerType === 'mouse' && !e.buttons) { endDrag(); return; }
      noteInput();
      if (Math.abs(e.clientY - d.y) > 4) d.vertical = true;
      // 끌기 시작이 곧 사용자의 개입이다. 앞으로의 미끄러짐은 holding()이 막지만, 이미 돌고 있는 것은
      // 여기서 멈추지 않으면 계속 흘러 고르던 글의 시작점이 손 밑에서 떠내려간다.
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) { d.moved = true; stopGlide(); }
    };
    // 놓을 때 실제 위치로 '붙어 있는가'를 다시 판정한다: 잡고 있는 동안 답이 자랐다면 이미 바닥이
    // 아니므로 붙어 있던 것으로 치지 않는다(놓자마자 바닥으로 끌려가면 잡고 있던 뜻이 없다).
    // 세로로 움직인 끌기만 그렇게 한다 — 표를 가로로 끈 것은 대화에서 떨어지겠다는 뜻이 아닌데,
    // 그사이 답이 자랐다는 이유로 떼어 버리면 그 뒤로 도착하는 것(늦게 서는 차트, 다음 답)을 따라가지
    // 않아 사용자에게는 대화가 그냥 멎은 것으로 보인다.
    const endDrag = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d?.moved) return;
      markBusy(); // 놓은 손은 아직 그 자리를 보고 있다 — 놓자마자 화면이 뛰지 않게 여운을 둔다
      if (d.vertical && el) stuckRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    };
    el?.addEventListener('pointerdown', onDown);
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', endDrag);
    addEventListener('pointercancel', endDrag);
    // 창이 초점을 잃으면(다른 창으로 넘어감, 오른쪽 클릭 메뉴) 놓았다는 소식이 오지 않는다.
    // 잡고 있던 표시가 그대로 남으면 그 뒤로 이 대화가 끝날 때까지 따라가기가 죽는다 — 여기서 다 푼다.
    // 창이 초점을 잃으면 손가락을 떼는 소식(touchend)이 오지 않는다 — 밀던 것을 여기서 끝내되,
    // 끝냈다는 것을 markBusy로 알려야 그동안 미뤄 둔 크기 변화(pendingRef)를 갚는 타이머가 선다.
    const onWindowBlur = () => { endDrag(); if (panRef.current) { panRef.current = false; markBusy(); } };
    addEventListener('blur', onWindowBlur);

    // 손가락으로 미는 중인가는 pointer 이벤트로 알 수 없다 — 브라우저가 스크롤을 가져가는 순간
    // pointercancel이 오고 그 뒤로는 아무 소식이 없다(뗀 것조차 오지 않는다). 그래서 손가락은 touch
    // 이벤트로 따로 본다. 손가락이 실제로 움직였을 때만 '미는 중'이다(아래 onTouchMove) — 그냥 톡
    // 누른 것까지 미는 중으로 치면 그 찰나에 도착한 답을 놓친다.

    // 손가락이 움직였다 = 미는 중이다. 스크롤이 났는지로 미루어 짐작하지 않는다 — 우리가 놓은 값도,
    // 브라우저가 옮긴 값도 스크롤 이벤트로 오기 때문에, 화면에 손만 얹고 답을 기다린 사람이 미는 중으로
    // 잡혀 뒤늦게 서는 차트를 놓쳤다(실측: 답의 끝 115~148px이 남았다).
    const onTouchMove = () => { panRef.current = true; noteInput(); };
    // 사용자가 화면을 움직이려 했다는 신호(byUser 참고)는 문서 전체에서 듣는다. 대화 상자에만 걸면
    // 놓치는 길이 많다 — 대화는 초점을 받지 못하는 <main>이라 키보드 스크롤의 keydown은 body에
    // 떨어지고(대화를 거치지 않는다), 헤더·입력창 위에서 굴린 휠도 대화 밖에서 온다.
    // capture로 듣는 이유는 중간에서 멈추는 이벤트도 우리에게는 '사용자가 만졌다'이기 때문이다.
    // 입력창에서 글을 쓰는 키는 뺀다 — 그것은 대화를 움직이려는 뜻이 아니다(PageUp·PageDown은
    // 그쪽에서 직접 다룬다). 누름은 스크롤바를 잡은 것만 센다: 대화 안을 그냥 누른 것(클릭)까지
    // 세면, 답이 도착한 찰나에 아무 데나 누른 사람이 그 뒤의 브라우저 보정에 따라가기를 잃는다.
    const onKeyInput = e => { if (!inputRef.current?.contains(e.target)) noteInput(); };
    const onScrollbarDown = e => { if (e.target === el && e.offsetX >= el.clientWidth) noteInput(); };
    addEventListener('keydown', onKeyInput, true);
    addEventListener('wheel', noteInput, { capture: true, passive: true });
    el?.addEventListener('pointerdown', onScrollbarDown);
    const onTouchEnd = e => {
      if (e.touches.length > 0) return; // 아직 다른 손가락이 닿아 있다
      if (panRef.current) markBusy(); // 뗀 뒤에도 관성으로 더 미끄러진다 — 그동안도 만지는 중이다
      panRef.current = false;
    };
    el?.addEventListener('touchmove', onTouchMove, { passive: true });
    addEventListener('touchend', onTouchEnd);
    addEventListener('touchcancel', onTouchEnd);

    // 대화 안의 다른 스크롤 상자(조회 표, 코드블록)를 굴리는 중이라면 미끄러짐을 멈춘다. 그 스크롤은
    // onChatScroll에 오지 않아(scroll은 위로 오르지 않는다) 여기서 붙잡는다 — 사용자가 표를 읽는 동안
    // 대화가 저 혼자 흐르면 읽던 행이 달아난다. 붙어 있다는 판정 자체는 건드리지 않는다: 표를 다 본 뒤
    // 대화가 바닥에 있으면 여전히 바닥이다.
    const onInnerScroll = e => {
      if (e.target === el) return;
      stopGlide();
      // 굴리는 그 순간만이 아니라 직후의 짧은 동안도 만지는 중으로 친다. 멈추기만 하고 두면 바로 다음
      // 크기 변화(늦게 서는 차트·흐름도)가 미끄러짐을 되살려, 읽던 표가 결국 화면 밖으로 달아난다.
      markBusy();
    };
    el?.addEventListener('scroll', onInnerScroll, true);

    const app = el?.parentElement;
    const onOutsideWheel = e => {
      if (!el || el.contains(e.target)) return;
      // 확대 제스처(트랙패드 핀치, Ctrl+휠)는 휠 이벤트로 오지만 스크롤이 아니다 — 확대만 하고 지나간다.
      // 가로로만 스친 것(deltaY 0)도 여기서 할 일이 없다: 아래에서 0을 더하면 스크롤 이벤트조차 나지
      // 않아, 따라가던 미끄러짐만 소리 없이 끊기고 답의 끝이 화면 밑에 남는다.
      if (e.ctrlKey || !e.deltaY) return;
      const ta = e.target.closest?.('textarea');
      if (ta) {
        const room = e.deltaY < 0 ? ta.scrollTop : ta.scrollHeight - ta.clientHeight - ta.scrollTop;
        if (room > 1) return;
      }
      // deltaMode: 픽셀(0)이 보통이지만 줄(1)·쪽(2)으로 오는 환경이 있다 — 픽셀로 환산한다.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      stopGlide();
      el.scrollTop += e.deltaY * unit;
    };
    app?.addEventListener('wheel', onOutsideWheel, { passive: true });

    return () => {
      el?.removeEventListener('click', onSummaryClick, true);
      el?.removeEventListener('toggle', onToggle, true);
      el?.removeEventListener('pointerdown', onDown);
      removeEventListener('pointermove', onMove);
      removeEventListener('keydown', onKeyInput, true);
      removeEventListener('wheel', noteInput, true);
      el?.removeEventListener('pointerdown', onScrollbarDown);
      removeEventListener('pointerup', endDrag);
      removeEventListener('pointercancel', endDrag);
      removeEventListener('blur', onWindowBlur);
      el?.removeEventListener('touchmove', onTouchMove);
      removeEventListener('touchend', onTouchEnd);
      removeEventListener('touchcancel', onTouchEnd);
      el?.removeEventListener('scroll', onInnerScroll, true);
      app?.removeEventListener('wheel', onOutsideWheel);
      growRef.current?.disconnect();
      clearTimeout(busyTimerRef.current);
      stopGlide();
    };
  }, []);

  // 바닥에 닿으면 붙고, 위로 올리면 뗀다. 아래로 내려가는 중에는 바꾸지 않는다 — 우리가 건 smooth 스크롤이
  // 바닥에 닿기 전에 차트가 자리를 잡아도 계속 따라가야 하고, 그 사이의 스크롤 이벤트는 전부 '아래로'다.
  // 내용이 줄어 브라우저가 scrollTop을 깎은 경우는 바닥에 닿은 것이라 앞 조건에서 붙은 채로 남는다.
  function onChatScroll(e) {
    const el = e.currentTarget;
    // 이 스크롤이 우리가 놓은 것인가(미끄러지는 중이고 그 값이 우리가 마지막에 쓴 값인가).
    // 2px: 배율 화면의 반올림 차이는 1px 미만, 휠 한 칸·화살표 키는 40px 이상.
    const ours = glideRef.current && Math.abs(el.scrollTop - glideRef.current.expect) <= 2;
    // 우리가 놓지 않은 값이 보이면 사용자가 움직인 것 — 거기서 멈춘다 (glide 참고). 멈추기만 하고
    // 자리는 브라우저가 놓은 그대로 둔다: 우리 궤적을 마저 그리면 화면이 뒤로 튄다. 이어서 갈 일이면
    // 크기 변화를 본 ResizeObserver가 그 자리에서 다시 시작한다.
    if (glideRef.current && !ours) stopGlide();
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 8) stuckRef.current = true;
    // 위로 올라간 것을 '떨어지겠다는 뜻'으로 읽는 것은 사용자가 방금 만졌을 때뿐이다(byUser).
    // 우리가 놓은 값(ours)도, 브라우저가 스스로 옮긴 값도 아니어야 한다 — 그 둘을 뜻으로 읽으면
    // 차트·흐름도가 자리를 잡는 순간에 따라가기가 끊겨 답의 끝이 입력창 뒤에 남는다(실측 25~110px).
    else if (!ours && (byUser() || !resizing(el)) && el.scrollTop < lastTopRef.current) stuckRef.current = false;
    lastTopRef.current = el.scrollTop;
    lastHeightRef.current = el.scrollHeight;
  }

  // textarea는 내용이 늘어도 스스로 커지지 않는다 — 줄 수에 맞춰 높이를 직접 맞춘다.
  // 최대 높이는 CSS(max-height)가 잡고, 그 뒤로는 입력창 안에서 스크롤된다.
  // useEffect가 아니라 useLayoutEffect인 이유: 그리기 전에 높이가 정해져야 한 프레임 깜빡이지 않는다.
  function fitInput() {
    const el = inputRef.current;
    if (!el) return;
    // 지금 높이를 먼저 풀어야 한다 — 그러지 않으면 scrollHeight가 이미 늘어난 높이에 갇혀
    // 줄을 지워도 다시 줄어들지 않는다 (한 번 커지면 그대로 남는다).
    el.style.height = 'auto';
    // 빈 입력창은 재지 않고 rows=1이 정한 높이를 그대로 쓴다. 잴 내용이 없기도 하지만,
    // 무엇보다 mount 직후의 첫 측정은 레이아웃이 아직 서지 않아 엉뚱한 값(수백 px)을 준다 —
    // 그 값이 인라인 높이로 굳으면 빈 입력창이 처음부터 세 배 크기로 열린다.
    if (el.value) el.style.height = `${el.scrollHeight}px`;
    // 스크롤은 높이가 max-height에 걸려 내용이 남을 때만 켠다. 늘 켜 두면 스크롤할 것이 없어도
    // 세로 스크롤바가 자리를 차지해 입력창이 좁아 보인다 (브라우저·OS 설정에 따라 늘 보인다).
    el.style.overflowY = el.scrollHeight > el.clientHeight ? 'auto' : 'hidden';
    // 최대 높이에 걸린 뒤로는 높이가 늘지 않으므로, 새로 생긴 줄은 화면 밖에 있다 —
    // 커서가 맨 끝에 있으면 그 줄이 보이게 내린다. 그러지 않으면 Alt+Enter로 줄을 바꿔도
    // 화면은 그대로여서 보이지 않는 곳에 글을 쓰게 된다.
    // (커서가 글 중간이면 건드리지 않는다 — 그때는 브라우저가 알아서 커서를 따라간다)
    if (el.scrollHeight > el.clientHeight && el.selectionStart === el.value.length) {
      el.scrollTop = el.scrollHeight;
    }
  }
  useLayoutEffect(fitInput, [input]);
  // 창 폭이 바뀌면 같은 글이 다른 줄 수로 감기는데 높이는 글이 바뀔 때만 재므로 그대로 남는다 —
  // 창을 좁히면 마지막 줄이 입력창 밑으로 잘려 보이지 않고(스크롤은 꺼져 있다), 넓히면 빈 줄이 남는다.
  useEffect(() => {
    addEventListener('resize', fitInput);
    return () => removeEventListener('resize', fitInput);
  }, []);

  // loading은 state라 같은 tick에 두 번 호출되면 두 번 다 false로 읽힐 수 있다 —
  // 실제 중복 전송을 막는 것은 ref 쪽이다 (state는 버튼 비활성화 등 렌더에만 쓴다).
  const canSend = () => !loading && !sendingRef.current;

  // 첫 화면(빈 상태)으로 되돌린다. 화면이 하나뿐이라 '홈으로 이동'은 곧 대화를 접는 것이다.
  // 답을 기다리는 중에도 눌릴 수 있다 — 요청 상한이 450초라 그때까지 막아두면
  // 사실상 되돌아갈 수 없는 시간이 생긴다. 그래서 진행 중인 요청은 여기서 끊는다.
  function goHome() {
    // 세대를 먼저 올린다. abort가 일으키는 ask의 finally가 이 값을 보고 자기 응답을 버린다
    // (아래에서 내리는 loading·sendingRef를 그쪽이 다시 건드리지 않게 하는 것도 이 대조다).
    sessionRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    sendingRef.current = false;
    pendingSendRef.current = false; // 조합 중에 눌려 대기하던 Enter도 함께 없앤다
    historyRef.current = [];
    setMessages([]);
    setInput('');
    setLoading(false);
    inputRef.current?.focus();
  }

  // 입력창에서 보내는 경로. setInput('')을 ask가 아니라 여기서 하는 이유:
  // ask는 예시 칩(ask(x))에서도 불리는데, 거기서 입력창을 비우면 사용자가 쓰던 초안이
  // 보낸 적도 없이 사라진다(빈 상태 화면은 입력 중에도 칩을 계속 보여준다).
  // 전송이 실제로 받아들여질 때만 비우도록 가드도 여기서 함께 본다.
  // 보낼 글자를 인자로도 받는 이유: 조합 확정 시점의 최종 문자열은 입력창(DOM)에만 확실히 있다.
  // state는 마지막 input 이벤트가 compositionend보다 뒤에 오는 브라우저에서 한 글자 뒤처진다.
  function submitInput(text = input) {
    const message = text.trim();
    if (!message || !canSend()) return;
    setInput('');
    ask(message);
  }

  // 조합을 지금 끝낸다. 포커스를 뺐다가 되돌리면 IME가 조합 중이던 글자를 확정한다 —
  // 조합 중인 입력창의 값을 건드려도 되는 상태로 만드는 방법이 이것뿐이다.
  // (조합 중에 값을 갈아끼우면 뒤늦은 확정이 그 위에 덮여 글자가 뒤엉킨다)
  function endComposition(el) {
    const { selectionStart, selectionEnd } = el;
    el.blur();
    el.focus();
    // 포커스를 되찾을 때 커서를 글 끝으로 밀어버리는 브라우저가 있다 — 있던 자리로 되돌린다.
    el.setSelectionRange(selectionStart, selectionEnd);
    // 보통은 위 blur가 compositionend를 일으켜 이 표시가 내려가지만, 그것까지 기다리지 않는다.
    // 조합이 끝난 것은 방금 우리가 한 일이고, 이 표시가 켜진 채 남으면 그 뒤로 Enter가
    // 영영 "조합 중"으로 취급돼 전송이 통째로 멈춘다.
    composingRef.current = false;
  }

  // 줄바꿈은 직접 끼워 넣는다 — Enter를 preventDefault로 막았으므로 브라우저가 넣어주지 않는다.
  // execCommand는 폐기 예정이지만 이 용도는 아직 모든 브라우저가 지원하고, 값을 직접 갈아끼우는 것과 달리
  // 진짜 input 이벤트를 일으켜 controlled state가 따라오고 되돌리기(Ctrl+Z) 이력도 남는다.
  function insertNewline(el) {
    if (document.execCommand('insertText', false, '\n')) return;
    // 막혔을 때의 대비. 이게 없으면 Alt+Enter가 아무 일도 하지 않는 것처럼 보인다.
    const { selectionStart: start, selectionEnd: end, value } = el;
    setInput(`${value.slice(0, start)}\n${value.slice(end)}`);
    // 커서는 React가 새 값을 그린 뒤에 옮긴다 — 지금 옮기면 그 렌더가 커서를 맨 뒤로 되돌린다.
    queueMicrotask(() => el.setSelectionRange(start + 1, start + 1));
  }

  async function ask(message) {
    if (!message || !canSend()) return;
    let answer = '서버와 통신하지 못했습니다.';
    let trace;
    let answered = false; // 서버가 실제로 '답'을 돌려줬는가 (통신 실패·타임아웃·서버 오류와 구분)
    let timer;            // finally에서 지운다 (세우기 전에 던졌으면 undefined — clearTimeout은 무해하다)
    // 플래그를 세우는 것까지 try 안에서 한다 — 세운 뒤 try 밖에서 무엇이든 던지면 finally가 돌지 않아
    // 플래그가 걸린 채 영구히 남는다. 그러면 화면은 멀쩡한데 전송만 막힌다
    // (loading은 false라 버튼도 활성으로 보인다). 바로 아래 AbortController가 없는 구형 브라우저가 그 경우다.
    // 이 요청이 속한 대화. finally에서 아직 같은 대화인지 확인하는 데 쓴다 (goHome 참고).
    const session = sessionRef.current;
    try {
      sendingRef.current = true;
      // AbortSignal.timeout()이 아니라 AbortController를 쓴다 — 전자는 Chrome 103/Safari 16 이상이고
      // Vite 기본 빌드 타깃(chrome87/safari14)은 문법만 변환할 뿐 런타임 API를 폴리필하지 않는다.
      // 구형 브라우저에서 fetch 호출 전에 TypeError가 나고, 그게 아래 catch에 삼켜져
      // 모든 질문이 "서버와 통신하지 못했습니다"로 보인다 — 백엔드 장애와 구분이 안 된다.
      const ctrl = new AbortController();
      abortRef.current = ctrl; // 홈으로 돌아갈 때 끊을 수 있도록 내둔다
      timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      // history는 현재 질문을 넣기 전에 확정한다 — 현재 질문은 message로 따로 가므로 중복 전송하지 않는다.
      // 서버가 쓰는 만큼만 보낸다 (턴 수·길이 모두). 더 보내도 서버가 버리고 본문만 커진다.
      // 답변의 차트 블록은 표로 되돌려 보낸다 — 길이 상한 안에서 값이 남아야지 그리기 설정이 남을 이유가 없다
      // (chart.js chartBlocksToTables). 잘라내기(clipTurn)는 그 뒤에 한다.
      const history = historyRef.current
        .slice(-HISTORY_TURNS)
        .map(m => ({ role: m.role, text: clipTurn(m.role === 'assistant' ? chartBlocksToTables(m.text) : m.text) }));
      historyRef.current = [...historyRef.current, { role: 'user', text: message }];
      setMessages(m => [...m, { role: 'user', text: message }]);
      setLoading(true);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        // 서버는 상태를 저장하지 않으므로 최근 대화를 함께 보낸다 (후속 질문 해석용)
        body: JSON.stringify({ message, history }),
      });
      const data = await res.json();
      // ??가 아니라 ||인 이유: 빈 문자열도 걸러야 한다. undefined는 이력에 들어가면 다음 전송을 깨고,
      // ''는 빈 말풍선으로 렌더된 뒤 그 빈 턴이 다음 질문의 맥락으로 서버에 되돌아간다.
      // (답변은 항상 문자열이므로 0·false가 ||에 걸려 사라질 일은 없다)
      answer = data.answer || data.error || answer;
      trace = data.trace;
      // 오류 응답(4xx/5xx, 또는 error 필드)은 모델이 한 말이 아니다 — 이력에 넣지 않는다.
      // 답이 비어 있을 때(200인데 answer가 '')도 마찬가지다: 그때 화면에 서는 것은 위의 기본 문구인데,
      // 그것을 '답'으로 세면 클라이언트가 만든 실패 문구가 모델의 지난 턴으로 서버에 되돌아간다
      // (실측: 다음 질문의 이력에 assistant "서버와 통신하지 못했습니다."가 실려 갔다).
      answered = res.ok && !data.error && !!data.answer;
    } catch (e) {
      // answer는 통신 오류 기본값 유지. 콘솔에는 남긴다 —
      // 네트워크 실패·타임아웃·클라이언트 예외가 화면에서는 모두 같은 문구로 보이기 때문이다.
      console.error('[chat] request failed:', e);
    } finally {
      clearTimeout(timer);
      // 화면에는 항상 남기지만, 서버로 되돌려 보내는 이력에는 서버가 준 답만 넣는다 —
      // 타임아웃·네트워크 실패 문구를 이력에 남기면 다음 질문의 '## 최근 대화'에
      // "에이전트: 서버와 통신하지 못했습니다."로 실려, 모델이 자기가 한 말로 알고 사과하거나 그걸 근거로 추론한다.
      // 그사이 홈으로 돌아갔다면(세대가 다르면) 이 답은 이미 지난 대화의 것이다 — 비운 화면에
      // 떨어뜨리지 않는다. loading·sendingRef도 goHome이 이미 정리했으므로 건드리지 않는다
      // (여기서 내리면 그 뒤에 시작된 새 요청의 상태를 지우게 된다).
      if (sessionRef.current === session) {
        abortRef.current = null;
        if (answered) historyRef.current = [...historyRef.current, { role: 'assistant', text: answer }];
        setMessages(m => [...m, { role: 'assistant', text: answer, trace }]);
        setLoading(false);
        sendingRef.current = false;
      }
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="logo">S</div>
        <div>
          <h1><span>SPACE</span> Assistant</h1>
          <p>지식 · 운영 DB 조회 기반</p>
        </div>
        {/* 대화가 없고 기다리는 것도 없으면 되돌아갈 곳이 없다 — 그때는 눌리지 않게 둔다
            (입력창의 초안은 홈이 아니어도 남는 것이므로 이 판단에 넣지 않는다). */}
        <button
          type="button"
          className="home-btn"
          onClick={goHome}
          disabled={messages.length === 0 && !loading}
          title="새 대화로 시작합니다"
        >
          <span aria-hidden="true">⌂</span><span className="home-label">홈</span>
        </button>
      </header>

      <main className="chat" ref={chatRef} onScroll={onChatScroll}>
        <div className="chat-inner">
          {messages.length === 0 && !loading && (
            <div className="empty">
              <div className="empty-icon">S</div>
              <h2>무엇을 도와드릴까요?</h2>
              <p>저장된 지식과 운영 DB 조회를 결합해 답변합니다.</p>
              <div className="chips">
                {EXAMPLES.map(x => (
                  <button key={x} className="chip" onClick={() => ask(x)}>{x}</button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => <Message key={i} {...m} />)}

          {loading && (
            <div className="row assistant">
              <div className="bubble assistant">
                <div className="typing"><i /><i /><i /></div>
              </div>
            </div>
          )}
        </div>
      </main>

      <div className="composer-wrap">
        <form className="composer" onSubmit={e => { e.preventDefault(); submitInput(); }}>
          <textarea
            ref={inputRef}
            rows={1}  /* 높이는 위 useLayoutEffect가 내용에 맞춰 준다 — 여기서는 시작 높이만 잡는다 */
            value={input}
            onChange={e => setInput(e.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={e => {
              composingRef.current = false;
              if (!pendingSendRef.current) return;
              pendingSendRef.current = false;
              // 조합 중에 눌린 Enter를 여기서 갚는다. 한글은 마지막 글자가 늘 조합 중이라
              // 그 Enter를 버리면 사용자는 언제나 Enter를 두 번 눌러야 한다.
              // 보낼 글자는 state가 아니라 입력창의 값에서 읽는다 (submitInput 주석 참고).
              submitInput(e.currentTarget.value);
            }}
            // Enter가 조합을 확정하지 못한 채 삼켜졌을 수도 있다. 그때 이 표시가 남아 있으면
            // 한참 뒤 엉뚱한 조합이 끝나는 순간 전송된다 — 입력창을 떠날 때 확실히 지운다.
            onBlur={() => { pendingSendRef.current = false; }}
            onKeyDown={e => {
              if (e.key !== 'Enter') {
                pendingSendRef.current = false; // 위와 같은 이유 (계속 타이핑하면 그 Enter는 없던 일이다)
                // PageUp·PageDown은 대화를 넘긴다. 보낸 뒤에는 초점이 여기 남는데, 브라우저는 초점 잡힌
                // 요소의 스크롤 상자만 넘기므로 입력창 밖을 한 번 클릭하기 전엔 키보드로 답변을 읽어
                // 내려갈 길이 없다. 입력창 자신이 넘쳐 스크롤되는 동안은 입력창 몫으로 둔다.
                if ((e.key === 'PageDown' || e.key === 'PageUp') && chatRef.current) {
                  const el = e.currentTarget;
                  if (el.scrollHeight <= el.clientHeight + 1) {
                    e.preventDefault();
                    const chat = chatRef.current;
                    const to = chat.scrollTop + (e.key === 'PageDown' ? 1 : -1) * chat.clientHeight * 0.875; // 브라우저와 같은 한 화면 분량
                    // 키로 올린 것은 옛 답을 읽으러 간 것이다 — 여기서 직접 뗀다. 이 스크롤은 우리가
                    // 놓는 값이라 onChatScroll의 '위로 올렸다'에 걸리지 않아, 그러지 않으면 뒤늦게 서는
                    // 차트에 다시 바닥으로 끌려간다(실측). 내려가 바닥에 닿으면 그쪽이 다시 붙인다.
                    // 더 올라갈 데가 없으면 화면은 그대로다 — 그때까지 뗐다고 하면 도착한 답을
                    // 따라가지 않으면서 사용자에게는 아무 일도 일어나지 않은 것으로 보인다.
                    if (e.key === 'PageUp' && chat.scrollTop > 0) stuckRef.current = false;
                    glide(chat, () => to);
                  }
                }
                return;
              }
              const el = e.currentTarget;
              const composing = e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || composingRef.current;
              // 브라우저 기본 동작(줄바꿈)을 막는다 — 줄을 바꿀지 보낼지는 여기서 직접 정한다.
              e.preventDefault();
              // Alt+Enter가 줄바꿈. Shift+Enter도 함께 받는다 — 다른 채팅 입력창에서 손이 먼저
              // 기억하는 조합이라, 여기서만 전송이 되면 쓰다 만 글이 그대로 나간다.
              if (e.altKey || e.shiftKey) {
                // 줄바꿈은 조합이 끝나기를 기다리지 않는다. IME는 Alt가 눌린 Enter를 확정 키로
                // 보지 않고 그냥 흘려보내기도 하는데, 그러면 compositionEnd가 영영 오지 않아
                // 기다리던 줄바꿈이 통째로 사라진다 — 조합을 직접 끝내고 지금 넣는다.
                if (composing) endComposition(el);
                insertNewline(el);
                return;
              }
              // 전송은 미룬다. 조합 중에 보내면 아직 확정되지 않은 글자가 빠지고,
              // 뒤늦은 확정이 이미 비워둔 입력창에 다시 들어온다.
              // (Enter는 IME가 확정 키로 받으므로 compositionEnd가 곧바로 따라온다)
              if (composing) {
                pendingSendRef.current = true;
                return;
              }
              // Safari는 compositionend를 keydown보다 먼저 보내 확정 Enter가 여기로 온다 — 그대로 보낸다.
              submitInput();
            }}
            placeholder="질문을 입력하세요 (Alt+Enter 줄바꿈)"
            maxLength={2000}  /* 입력 단계 안내용 사본 — 실제 제한은 서버가 검증한다 (backend constants.js MAX_QUESTION_LEN) */
            autoFocus
          />
          <button className="send" disabled={loading || !input.trim()} aria-label="전송">➤</button>
        </form>
      </div>
    </div>
  );
}
