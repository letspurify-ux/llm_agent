import { useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useChangedState } from './changed-state.js';

// Markdown의 인라인 서식은 폭을 제공하지 않는다. 실제 줄을 배치하는
// 문단·목록 항목·제목·셀까지 올라가 사용 가능한 내용 폭을 읽는다.
function containingBlock(element) {
  let parent = element.parentElement;
  while (parent && ['inline', 'contents'].includes(getComputedStyle(parent).display)) parent = parent.parentElement;
  return parent;
}

// 같은 배치로 다시 잰 것은 바뀐 것이 아니다 — 창 크기가 바뀔 때마다 수식마다 다시 재므로, 그것을 setState로
// 넘기면 렌더되지 않는 업데이트가 쌓인다(changed-state.js).
const sameLayout = (a, b) => a.scroll === b.scroll && Math.abs(a.scale - b.scale) < 0.001;

// 수식들은 관찰자 하나를 함께 쓰고, 같은 문단·셀은 한 번만 관찰한다. 브라우저는 그려지는 프레임마다 관찰 중인
// 요소를 하나하나 다시 재 보는데(크기가 그대로여도), 수식마다 관찰자를 달면 그 일이 대화에 쌓인 수식 수만큼
// 늘었다 — 머리글 로봇이 쉬지 않고 프레임을 그리므로 가만히 둔 화면에서도 매 프레임 치르는 값이다
// (실측, headless Chrome: 답 160개 화면에서 관찰을 훑는 데만 프레임마다 0.5 ms, 관찰을 모두 끊으면 0.05 ms).
// 한 문단에 수식이 여럿이면 관찰은 하나다.
const watched = new Map(); // 문단·셀 → 그 안의 수식들이 다시 잴 함수
let observer = null;
function watch(block, measure) {
  if (typeof ResizeObserver === 'undefined') return () => {};
  observer ??= new ResizeObserver(entries => {
    for (const entry of entries) watched.get(entry.target)?.forEach(m => m());
  });
  let measures = watched.get(block);
  if (!measures) {
    watched.set(block, measures = new Set());
    observer.observe(block);
  }
  measures.add(measure);
  return () => {
    measures.delete(measure);
    if (measures.size) return;
    watched.delete(block);
    observer.unobserve(block);
  };
}

export default function InlineMath({ inLink, className, children, style, ...props }) {
  const ref = useRef(null);
  const [layout, setLayout] = useChangedState({ scroll: false, scale: 1 }, sameLayout);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || element.closest('.katex-display')) return;
    const block = containingBlock(element);
    if (!block) return;
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const css = getComputedStyle(block);
      const available = block.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
      // KaTeX의 base는 줄을 나눌 수 없는 단위다. 이미 여러 base 사이에서
      // 자연스럽게 줄바꿈한 수식을 불필요하게 한 줄로 늘리지 않는다.
      const bases = [...element.querySelectorAll(':scope > .katex-html > .base')];
      const width = Math.max(0, ...bases.map(base => base.offsetWidth));
      const scroll = available > 0 && width > available + 1;
      // 스크롤 상자에서는 여러 base를 한 줄에 놓는다. 인쇄 축척에는
      // 가장 넓은 base만이 아니라 그 줄 전체의 폭이 필요하다.
      const lineWidth = bases.reduce((sum, base) => sum + base.offsetWidth, 0);
      const scale = scroll ? Math.min(1, available / (lineWidth + bases.length)) : 1;
      setLayout({ scroll, scale });
    };
    measure();
    const unwatch = watch(block, measure);
    document.fonts?.ready.then(measure);
    // 인쇄는 ResizeObserver의 다음 프레임을 기다리지 않는다. 인쇄용 CSS가
    // 적용된 폭에서 동기적으로 배치하고, 종이에서는 스크롤 대신 크기를 맞춘다.
    const print = () => flushSync(measure);
    window.addEventListener('beforeprint', print);
    window.addEventListener('afterprint', measure);
    window.addEventListener('resize', measure);
    return () => {
      alive = false;
      unwatch();
      window.removeEventListener('beforeprint', print);
      window.removeEventListener('afterprint', measure);
      window.removeEventListener('resize', measure);
    };
  }, [children]);
  return <span {...props} ref={ref} className={className + (layout.scroll ? ' math-scroll' : '')}
    style={layout.scroll ? { ...style, '--math-print-scale': layout.scale } : style}
    tabIndex={layout.scroll && !inLink ? 0 : undefined}
    role={layout.scroll && !inLink ? 'group' : undefined}
    aria-label={layout.scroll && !inLink ? '가로로 스크롤할 수식' : undefined}>{children}</span>;
}
