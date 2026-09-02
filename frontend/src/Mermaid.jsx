// ```mermaid 블록 하나를 그림으로. 지식 답변의 절차·흐름을 모델이 흐름도로 쓸 때 쓰인다.
// App.jsx가 React.lazy로 부른다 — mermaid는 번들이 수 MB라 첫 흐름도가 나올 때까지 내려받지 않는다.
import { useEffect, useState, useId } from 'react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  // 라벨의 HTML을 그대로 넣지 않는다(모델이 만든 글자가 곧 화면에 들어가는 자리다).
  securityLevel: 'strict',
  // 문법이 틀린 그림에 mermaid가 '폭탄' 오류 SVG를 문서에 직접 끼워 넣는 것을 막는다 —
  // 그 경우는 아래에서 원문 코드로 되돌린다.
  suppressErrorRendering: true,
  theme: 'neutral',
  fontFamily: 'inherit',
});

export default function Mermaid({ text }) {
  const [svg, setSvg] = useState(null);
  // mermaid.render는 문서에 이 id의 요소를 만들었다 지운다 — useId의 콜론은 CSS 선택자로 못 쓴다.
  const id = `mmd${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  useEffect(() => {
    let alive = true;
    setSvg(null);
    // 그리지 못하면(문법 오류 등) svg를 null로 둔 채 끝낸다 — 아래에서 원문을 코드로 보여준다.
    mermaid.render(id, text).then(r => { if (alive) setSvg(r.svg); }, e => console.warn('[mermaid] render failed:', e?.message ?? e));
    return () => { alive = false; };
  }, [text, id]);
  // 그리는 동안과 실패했을 때는 원문 코드. 실패는 모델의 문법 실수가 대부분이라 원문이 곧 설명이다.
  if (svg === null) return <pre><code>{text}</code></pre>;
  return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
