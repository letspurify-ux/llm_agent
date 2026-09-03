// ```mermaid 블록 하나를 그림으로. 지식 답변의 절차·흐름을 모델이 흐름도로 쓸 때 쓰인다.
// App.jsx가 React.lazy로 부른다 — mermaid는 번들이 수 MB라 첫 흐름도가 나올 때까지 내려받지 않는다.
import { useEffect, useLayoutEffect, useRef, useState, useId } from 'react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  // 라벨의 HTML을 그대로 넣지 않는다(모델이 만든 글자가 곧 화면에 들어가는 자리다).
  securityLevel: 'strict',
  // 그런데 strict의 정화(DOMPurify)는 스크립트와 이벤트 속성만 걷어낸다 — <img src=…>는 살아남고,
  // 기본값인 HTML 라벨(<foreignObject> 안에 넣는다)에서는 그것이 진짜 <img>가 되어 브라우저가
  // 모델이 쓴 주소를 사용자가 누르기도 전에 부른다(실측: 라벨 하나가 외부 요청 한 건을 냈다).
  // 답변의 글자에는 조회 결과가 섞여 있으므로 그 통로 자체를 닫는다 — 라벨은 SVG 글자로 그린다.
  // (<br/>로 줄을 바꾸는 것은 글자 라벨에서도 그대로 된다)
  // 루트의 이 값이 모든 그림 종류를 덮는다 — mermaid 11에서 flowchart.htmlLabels 같은 종류별 설정은
  // 폐기됐고 루트가 우선한다. 종류마다 따로 적으면 새 그림이 늘 때마다 빠뜨릴 자리만 늘어난다.
  htmlLabels: false,
  // 문법이 틀린 그림에 mermaid가 '폭탄' 오류 SVG를 문서에 직접 끼워 넣는 것을 막는다 —
  // 그 경우는 아래에서 원문 코드로 되돌린다.
  suppressErrorRendering: true,
  theme: 'neutral',
  fontFamily: 'inherit',
});

// 라벨 글자가 이보다 작아지면 그림은 남고 글자는 사라진다 — 그 아래로는 줄이지 않는다(아래 참고).
const MIN_LABEL_PX = 9;

export default function Mermaid({ text }) {
  const [svg, setSvg] = useState(null);
  const boxRef = useRef(null);
  // mermaid.render는 문서에 이 id의 요소를 만들었다 지운다 — useId의 콜론은 CSS 선택자로 못 쓴다.
  const id = `mmd${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  useEffect(() => {
    let alive = true;
    setSvg(null);
    // 그리지 못하면(문법 오류 등) svg를 null로 둔 채 끝낸다 — 아래에서 원문을 코드로 보여준다.
    mermaid.render(id, text).then(r => { if (alive) setSvg(r.svg); }, e => console.warn('[mermaid] render failed:', e?.message ?? e));
    return () => { alive = false; };
  }, [text, id]);
  // mermaid의 SVG는 width="100%"라 상자에 맞춰 통째로 줄어든다. 좁은 상자에서는 그 배율이 끝없이
  // 내려가 그림은 다 보이는데 글자를 못 읽는 상태가 된다 — 실측: 폭 238px 상자에서 흐름도 높이 41px,
  // 라벨 글자 3px. 그래서 글자가 MIN_LABEL_PX 아래로 내려가면 거기서 멈추고 남는 폭은 .mermaid의
  // 가로 스크롤에 넘긴다(index.html). 읽히는 그림을 밀어 보는 편이, 다 보이지만 못 읽는 것보다 낫다.
  // 넓은 화면에서는 글자가 이미 크므로 아무것도 하지 않는다(데스크톱 폭에서 라벨은 9px을 넘는다).
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || svg === null) return;
    let lastW = -1;
    const fit = () => {
      const w = box.clientWidth;
      // 우리가 만든 높이 변화로 다시 불려온 것이면 할 일이 없다 — 폭이 그대로면 결과도 그대로다.
      if (w === lastW) return;
      lastW = w;
      const el = box.querySelector('svg');
      if (!el) return;
      el.style.minWidth = '';
      const natural = parseFloat(el.style.maxWidth) || Infinity; // mermaid가 인라인으로 적어 둔 제 크기
      // 글자 높이는 가장 작은 것으로 잰다. 한 그림 안에서도 크기는 자리마다 다르고(노드 이름, 화살표에
      // 붙는 말, 묶음 제목), 처음 만난 라벨 하나로 정하면 그보다 작은 글자가 기준 아래에 남는다.
      // 여러 줄로 감긴 라벨은 상자 높이가 줄 수만큼이므로 한 줄(tspan)로 잰다.
      const smallest = () => {
        const hs = [...el.querySelectorAll('.nodeLabel, text')]
          .map(n => (n.querySelector?.('tspan') ?? n).getBoundingClientRect().height)
          .filter(v => v > 0);
        return hs.length ? Math.min(...hs) : 0;
      };
      // 넓힌 뒤 다시 재서 모자라면 한 번 더 넓힌다. '폭을 두 배로 하면 글자도 두 배'가 아니기 때문이다 —
      // 브라우저는 아주 작은 글자를 어느 선 아래로는 줄이지 않아, 줄어든 그림에서 잰 글자는 실제보다
      // 크게 나온다(실측: 폭 268px에서 4px로 보이던 글자가 2.25배 넓힌 603px에서 9px이 아니라 7px).
      // 그 어긋남을 한 번의 계산으로 맞출 수는 없으므로 실제 결과를 보고 좁힌다. 늘 몇 번 안에 끝난다:
      // 글자가 커질수록 비례에 가까워지고, 제 크기(natural)에 닿으면 더 넓힐 것이 없다.
      for (let i = 0; i < 4; i++) {
        const h = smallest();
        if (!h || h >= MIN_LABEL_PX) break;
        const now = el.getBoundingClientRect().width;
        const want = Math.min(natural, Math.ceil(now * (MIN_LABEL_PX / h)));
        if (want <= now) break; // 제 크기까지 넓혀도 모자란다 — 여기까지가 최선이다
        el.style.minWidth = `${want}px`;
      }
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [svg]);
  // 그리는 동안과 실패했을 때는 원문 코드. 실패는 모델의 문법 실수가 대부분이라 원문이 곧 설명이다.
  if (svg === null) return <pre><code>{text}</code></pre>;
  return <div className="mermaid" ref={boxRef} dangerouslySetInnerHTML={{ __html: svg }} />;
}
