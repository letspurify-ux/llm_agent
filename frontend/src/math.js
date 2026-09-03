// 답변 안의 수식 표기를 다루는 계약 전체 — 파서·렌더러 설정과, markdown이 다루지 못하는 표기를
// 이어 붙이는 remark 플러그인.
//
// 이 앱이 받아야 하는 표기는 넷이다. 모델이 실제로 그렇게 쓰기 때문이다:
//   $$…$$ / $$ 독립 줄     remark-math가 그대로 처리한다 (아래 REMARK_PLUGINS)
//   $…$                   remark-math로는 켤 수 없다 — 켜면 '비용은 $100 이고 수익은 $200 이다'의
//                         가운데가 통째로 수식이 되어 문장이 사라지고, 표 안에서 일어나면 행이 무너진다.
//                         조회 결과를 표로 보여주는 것이 이 앱의 본업이라 그 손상이 가장 크다.
//   \(…\) · \[…\]         markdown의 백슬래시 이스케이프에 먼저 먹혀 '( )' · '[ ]'만 남는다.
// 뒤의 셋을 여기서 잇는다.
//
// 핵심은 '언제' 판정하느냐다. 원문을 우리가 먼저 훑으면 파서가 이미 아는 것(여기는 코드다, 여기는
// 링크 주소다, 이 줄은 인용문이다)을 전부 다시 알아내야 한다 — 코드펜스·인라인 코드·URL·링크 목적지·
// 인용문 접두사·CRLF를 하나씩 따로 막아야 하고, 빠뜨린 자리마다 조용한 버그가 된다(전부 실측했다).
// 그래서 파싱이 끝난 뒤 '순수 텍스트 노드' 안에서만 판정한다. 코드·주소·인용문 표시는 그 시점에
// 이미 다른 노드로 갈라져 있어 우리 눈에 들어오지도 않는다. 남는 판정은 금액과 수식을 가르는 것뿐이다.
//
// 판정에는 원문이 필요하다(node.position). 파서가 만든 값에서는 \( 의 백슬래시가 이미 떨어져 나가
// 평범한 '('와 구별되지 않기 때문이다.
//
// 실패 방향은 한쪽으로만 열려 있어야 한다: 판정하지 못하면 사용자가 원문($v = d/t$)을 보지만,
// 반대로 잘못 켜면 멀쩡한 문장과 표가 수식 조판 속으로 사라진다.

import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

// KaTeX 옵션에 throwOnError를 넣지 않는다: rehype-katex가 스프레드 뒤에 자기 값(true)을 덮어쓰므로
// 넘겨도 무시된다. '문법이 틀린 수식만 붉게 남기고 나머지는 살린다'는 동작은 그 라이브러리가
// 던진 뒤 strict:'ignore'로 다시 그리는 자기 폴백에서 나온다 — 우리 옵션과 무관하다.
export const REHYPE_PLUGINS = [[rehypeKatex, {
  // \rule{1em}{500em} 한 줄이 말풍선을 7000px짜리 검은 막대로 늘리는 것을 막는다. 가로는 .bubble의
  // overflow-x: clip이 가두지만 세로는 무엇도 가두지 않아, 그 한 줄이 대화 전체를 화면 밖으로 민다.
  maxSize: 10,
  // 한글이 수식 안에 들어오면(모델이 \text 없이 쓰는 일이 흔하다) 경고를 콘솔에 쏟는 대신 그냥 그린다.
  strict: 'ignore',
  // index.html의 .md .katex [style*="#cc0000"] 가 이 색으로 오류 글자를 찾는다 — 함께 바꿔야 한다.
  errorColor: '#cc0000',
}]];

// markdown이 백슬래시를 떼는 자리는 ASCII 문장부호 앞뿐이다. 원문 조각을 화면 글자로 되돌릴 때
// 같은 규칙을 쓴다 (\$100 은 $100 으로, \www 는 그대로).
const unescapeMd = s => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');

// 수식 후보. 앞의 둘은 markdown이 먹어버리는 표기라 원문에서만 보이고, 셋째(홑 $)는 금액과 겹친다.
// 홑 $는 여는 $ 뒤와 닫는 $ 앞에 공백이 오면 후보로 삼지 않는다([^$\s]) — 문장 안에 홑 $가 흩어진
// 경우가 그렇게 걸린다('$100 이고 수익은 $200'의 뒤쪽 $가 여기서 떨어진다).
// 내용에 $를 담지 않으므로(=[^$]) 되돌아가며 훑는 일이 없어 길이에 비례한 비용으로 끝난다.
const SPAN_RE = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$([^$\s]|[^$\s][^$]*[^$\s])\$/g;

// 한글이 든 홑 $ 구간은 수학 기호나 백슬래시 명령이 함께 있을 때만 수식으로 본다.
// TeX에는 한글 조판이 없어서, 기호도 명령도 없이 한글만 든 구간($가,$나)은 수식이었을 리가 없다.
// $$로 명시한 구간에는 걸지 않는다 — 그쪽은 모델이 수식 표기를 골라서 쓴 것이라 뜻이 분명하다.
const CJK_RE = /[ᄀ-ᇿ぀-ヿ㄰-㆏一-鿿가-힣]/;
const MATH_SIGNAL_RE = /[\\=+\-*/^_<>]/;

// hName·hProperties·hChildren은 mdast→hast 변환에 '이 노드는 이렇게 만들어라'를 직접 지시한다.
// rehype-katex는 math-inline / math-display 클래스를 보고 그리므로, remark-math가 내는 것과 같은
// 모양으로 만들어 주면 그다음은 똑같이 흘러간다.
const mathNode = (tex, display) => ({
  type: display ? 'math' : 'inlineMath',
  value: tex,
  data: {
    hName: display ? 'div' : 'span',
    hProperties: { className: ['math', display ? 'math-display' : 'math-inline'] },
    hChildren: [{ type: 'text', value: tex }],
  },
});

// 홑 $ 구간을 수식으로 받아들일지. 금액·환경변수와 갈라야 하는 자리다.
//   앞이 영숫자면 안 된다(A$B), 뒤가 영숫자여도 안 된다($HOME/$PATH).
// 한글 조사는 영숫자가 아니므로 '$v$는 속도'는 그대로 수식이 된다.
const acceptDollar = (tex, raw, from, to) =>
  !/[A-Za-z0-9]/.test(raw[from - 1] ?? '') &&
  !/[A-Za-z0-9]/.test(raw[to] ?? '') &&
  (!CJK_RE.test(tex) || MATH_SIGNAL_RE.test(tex));

// 텍스트 노드 하나를 [글자, 수식, 글자, …]로 쪼갠다. 쪼갤 것이 없으면 null.
function splitText(node, source) {
  const from = node.position?.start?.offset;
  const to = node.position?.end?.offset;
  if (from === undefined || to === undefined) return null;
  const raw = source.slice(from, to);
  if (!raw.includes('$') && !raw.includes('\\')) return null;
  // 원문을 글자로 되돌린 것이 파서가 만든 값과 다르면(엔티티 등) 이 노드는 건드리지 않는다 —
  // 원문 조각을 그대로 내보내면 &amp; 같은 것이 화면에 그대로 보인다.
  if (unescapeMd(raw) !== node.value) return null;

  const parts = [];
  let last = 0;
  SPAN_RE.lastIndex = 0;
  for (let m; (m = SPAN_RE.exec(raw)); ) {
    const tex = (m[1] ?? m[2] ?? m[3]).trim();
    if (m[3] !== undefined && !acceptDollar(tex, raw, m.index, m.index + m[0].length)) {
      // 물린 후보의 여는 자리 바로 뒤에서 다시 시작한다 — 매치 끝까지 건너뛰면 그 안에 있던
      // 진짜 수식을 놓친다('$100 이고 … $200 이다 $v=d/t$'의 마지막이 그렇게 사라졌다).
      SPAN_RE.lastIndex = m.index + 1;
      continue;
    }
    if (!tex) continue;
    if (m.index > last) parts.push({ type: 'text', value: unescapeMd(raw.slice(last, m.index)) });
    parts.push(mathNode(tex, false));
    last = m.index + m[0].length;
  }
  if (!parts.length) return null;
  if (last < raw.length) parts.push({ type: 'text', value: unescapeMd(raw.slice(last)) });
  return parts;
}

// 수식이 문단 하나를 통째로 차지하면 별행 수식으로 만든다(가운데 정렬 + 넘칠 때 가로 스크롤).
// 문장 안에 있으면 인라인 그대로다 — 그쪽은 위의 splitText와 remark-math가 이미 맡는다.
// 두 가지가 여기로 온다:
//   \[ … \]        markdown이 백슬래시를 떼어 remark-math에는 보이지도 않는다(원문에서 알아본다)
//   $$ … $$ 한 줄   remark-math의 '별행'은 $$가 제 줄에 홀로 설 때뿐이라, 한 줄로 쓴 것은 인라인이 된다.
//                   모델은 별행 수식을 거의 언제나 한 줄로 쓴다 — 그대로 두면 가운데 정렬도, 넘칠 때의
//                   가로 스크롤(.katex-display)도 없이 말풍선의 overflow-x: clip에 잘려 오른쪽이 통째로
//                   닿을 수 없게 된다(실측: 폭 574px 말풍선에 2,069px짜리 수식, 1,478px이 잘렸다).
const BRACKET_BLOCK_RE = /^\\\[([\s\S]+)\\\]$/;
function displayParagraph(node, source) {
  if (node.type !== 'paragraph' || node.children.length !== 1) return null;
  const child = node.children[0];
  const from = child.position?.start?.offset;
  if (from === undefined) return null;
  // remark-math가 만든 한 줄짜리 $$…$$. 지금의 계약(아래 REMARK_PLUGINS의 singleDollarTextMath: false)
  // 아래에서 inlineMath로 오는 것은 $$뿐이라 이 확인은 늘 참이다 — 계약이 풀렸을 때를 위해 남겨 둔다.
  // 홑 $ 하나짜리($v=d/t$ 한 줄)는 그때에도 별행으로 올리지 않는다: 그것을 쓴 사람은 문장 속 표기를
  // 쓴 것이고, 우리 판정(splitText)도 인라인으로 내놓는다.
  if (child.type === 'inlineMath') return source.startsWith('$$', from) ? mathNode(child.value, true) : null;
  if (child.type !== 'text') return null;
  const m = BRACKET_BLOCK_RE.exec(source.slice(from, child.position.end.offset).trim());
  return m && m[1].trim() ? mathNode(m[1].trim(), true) : null;
}

// 닫히지 않은 별행 수식($$ 뒤에 닫는 줄이 없는 경우)은 남은 답변을 통째로 수식으로 삼킨다.
// 토큰 한도로 잘린 응답에서 실제로 나오고, 그러면 본문이 조판 속으로 사라진다.
// 원문이 $$로 끝나지 않으면 닫히지 않은 것이므로 글자로 되돌린다.
function unclosedMath(node, source) {
  if (node.type !== 'math') return null;
  const from = node.position?.start?.offset;
  if (from === undefined) return null;
  if (source.slice(from, node.position.end.offset).trimEnd().endsWith('$$')) return null;
  // 원문이 아니라 파서가 뽑아 준 내용을 쓴다 — 인용문·목록 안이면 원문에는 줄마다 '>'가 붙어 있다.
  // 여는 줄에 이어 쓴 글자는 value가 아니라 meta에 담긴다 — remark-math는 별행 수식을 코드펜스처럼
  // 읽어서 '$$' 뒤의 나머지를 펜스의 언어 자리로 본다. 그것을 빠뜨리면 잘린 답변에서 가장 흔한 모양
  // ($$ 뒤에 수식을 이어 쓰다 끊긴 것)이 화면에 '$$' 한 줄만 남기고 통째로 사라진다(실측).
  const head = node.meta ? `$$ ${node.meta}` : '$$';
  return { type: 'paragraph', children: [{ type: 'text', value: node.value ? `${head}\n${node.value}` : head }] };
}

// 대괄호로 직접 쓴 링크인가([글자](주소)). GFM은 맨 URL과 <꺾쇠>도 링크로 만드는데, 그 둘은
// 링크의 '글자'가 곧 주소다 — 그 안의 $를 수식으로 바꾸면 화면에 보이는 주소가 달라진다.
const isExplicitLink = (node, source) => source[node.position?.start?.offset] === '[';

// 트리를 훑으며 위 셋을 적용한다.
function walk(node, source) {
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const replaced = displayParagraph(child, source) ?? unclosedMath(child, source);
    if (replaced) { children[i] = replaced; continue; }
    if (child.type === 'text') {
      const parts = splitText(child, source);
      if (parts) { children.splice(i, 1, ...parts); i += parts.length - 1; }
      continue;
    }
    // 참조 링크([글자][ref])도 대괄호로 시작하므로 여기서 걸리지 않는다 — 막을 것은 맨 URL뿐이다.
    if (child.type !== 'link' || isExplicitLink(child, source)) walk(child, source);
  }
}

function remarkLooseMath() {
  return (tree, file) => walk(tree, String(file));
}

// $$ 표기는 remark-math가 인라인·별행 모두 처리한다. singleDollarTextMath=false가 계약의 나머지
// 반쪽이다 — 홑 $의 판정은 remarkLooseMath가 맡아야 하므로 파서는 거기에 손대지 않아야 한다.
export const REMARK_PLUGINS = [remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkLooseMath];
