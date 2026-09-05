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
// 그래서 파싱이 끝난 뒤 '순수 텍스트 노드' 안에서만 판정한다. 코드·주소는 그 시점에 이미 다른 노드로
// 갈라져 있어 우리 눈에 들어오지도 않는다. 노드가 여러 줄에 걸치면 원문 조각의 줄 앞뒤에 파서가 뗀 것
// (인용문의 >, 목록의 들여쓰기, 소프트 줄바꿈의 공백)이 남는데, 그것은 아래 alignedRaw가 파서와 같은 규칙으로
// 떼어 낸다. 남는 판정은 금액과 수식을 가르는 것뿐이다.
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
// 모델이 수식을 코드펜스에 넣는 일이 잦다. ```math 는 rehype-katex가 알아보지만(language-math 클래스)
// ```latex·```tex 는 평범한 코드블록이 되어 원문이 그대로 화면에 남는다 — 코드블록은 markdown이
// '글자 그대로 보이라'고 정의한 것이라 화면 잘못이 아니다. 실측: 'latex 어려운 수식 10개' 요청의 답이
// 통째로 ```latex 블록이었고, 사용자는 \begin{aligned}…를 글자로 봤다.
// 그래서 세 이름을 같은 것으로 본다 — 렌더 전에 클래스만 갈아 준다. rehype-katex는 pre>code에 붙은
// language-math를 보면 pre째로 별행 수식으로 바꾼다(그 라이브러리의 ```math 처리와 같은 길이다).
//
// 대가가 하나 있다: 'LaTeX 원문을 보여 달라'는 요청에 모델이 ```latex 를 쓰면 원문 대신 조판된 수식이
// 보인다. 그 경우에는 ```text 를 쓰라고 시스템 프롬프트가 따로 말한다 (backend/src/llm-openai.js).
// 이름을 늘릴 때는 그 프롬프트와 함께 볼 것 — 한쪽만 늘리면 그 언어로 쓴 원문이 조용히 사라진다.
const MATH_FENCE_CLASSES = ['language-latex', 'language-tex'];

const mathFence = () => tree => {
  const walk = node => {
    const cls = node?.properties?.className;
    if (node?.tagName === 'code' && Array.isArray(cls) && cls.some(c => MATH_FENCE_CLASSES.includes(c))) {
      node.properties.className = cls.map(c => (MATH_FENCE_CLASSES.includes(c) ? 'language-math' : c));
    }
    for (const child of node?.children ?? []) walk(child);
  };
  walk(tree);
};

// mathFence가 rehypeKatex보다 앞에 와야 한다 — 클래스를 갈아 준 뒤에 그것을 읽는다.
export const REHYPE_PLUGINS = [mathFence, [rehypeKatex, {
  // \rule{1em}{500em} 한 줄이 말풍선을 7000px짜리 검은 막대로 늘리는 것을 막는다. 가로는 .bubble의
  // overflow-x: clip이 가두지만 세로는 무엇도 가두지 않아, 그 한 줄이 대화 전체를 화면 밖으로 민다.
  maxSize: 10,
  // 한글이 수식 안에 들어오면(모델이 \text 없이 쓰는 일이 흔하다) 경고를 콘솔에 쏟는 대신 그냥 그린다.
  strict: 'ignore',
  // 문법이 틀린 자리를 붉게 남기는 색. 이 색으로 오류 글자를 '찾는' CSS는 없다 — React가 인라인
  // 스타일을 CSSOM으로 얹어 style 속성에 16진수가 남지 않기 때문이고, 찾아서 접어 봐야 KaTeX의
  // 중첩된 inline-block이 한 글자 폭으로 무너진다(index.html의 .katex-error 옆 주석 참고).
  // 그러니 이 값은 '보이는 색'을 정할 뿐이고, 바꿔도 다른 파일과 어긋날 것이 없다.
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

// 그 자리의 글자가 markdown의 백슬래시 이스케이프에 물려 있는가 — 바로 앞에 이어진 백슬래시가 홀수 개면
// 그렇다. `\$`는 글자 $이고(모델이 금액을 그렇게 적는다 — 수식으로 읽힐까 봐), `\\$`는 백슬래시 하나 뒤의
// 진짜 $다. `\\(`도 같다: 백슬래시 하나 뒤의 여는 괄호이지 수식 표시가 아니다.
const escapedAt = (raw, i) => {
  let n = 0;
  while (i - 1 - n >= 0 && raw[i - 1 - n] === '\\') n++;
  return n % 2 === 1;
};

// 텍스트 노드의 원문을 파서가 만든 값과 줄 단위로 맞춘다. 파서는 줄 사이에서 셋을 뗀다 — 컨테이너 표시(인용문의 >,
// 목록 항목의 들여쓰기), 소프트 줄바꿈 앞뒤의 공백, 백슬래시 이스케이프. 원문 조각을 통째로 값과 비교하던 동안에는
// 앞의 둘이 든 노드가 전부 '다르다'로 걸려, 두 줄 넘게 이어 쓴 목록 항목·인용문 안의 수식이 하나도 그려지지
// 않았다(실측: '- 항목 $x$ 는\n  이어서 $y$'에서 둘 다 원문으로 남았다 — 한 줄로 쓰면 그려지는 같은 글이다).
// 줄마다 파서가 뗀 것을 원문에서도 떼어 값과 같은 모양으로 만든 뒤 비교한다. 첫 줄의 앞과 마지막 줄의 뒤는
// 손대지 않는다 — 그 자리의 공백은 이웃 노드(*강조* 뒤의 ' b')와의 경계라 값에도 그대로 있다.
// 되돌린 원문이 값과 다르면(엔티티 등) null — 그 노드는 건드리지 않는다. 원문 조각을 그대로 내보내면 &amp; 같은
// 것이 화면에 그대로 보인다.
function alignedRaw(raw, value) {
  const rawLines = raw.split('\n');
  const valLines = String(value ?? '').split('\n');
  if (rawLines.length !== valLines.length) return null;
  const last = rawLines.length - 1;
  const lines = rawLines.map((line, i) => {
    if (i > 0) line = line.replace(/^[ \t>]*/, '');
    if (i < last) line = line.replace(/[ \t]+(\r?)$/, '$1');
    return line;
  });
  return lines.every((line, i) => unescapeMd(line) === valLines[i]) ? lines.join('\n') : null;
}

// 텍스트 노드 하나를 [글자, 수식, 글자, …]로 쪼갠다. 쪼갤 것이 없으면 null.
function splitText(node, source) {
  const from = node.position?.start?.offset;
  const to = node.position?.end?.offset;
  if (from === undefined || to === undefined) return null;
  const slice = source.slice(from, to);
  if (!slice.includes('$') && !slice.includes('\\')) return null;
  const raw = alignedRaw(slice, node.value);
  if (raw === null) return null;

  const parts = [];
  let last = 0;
  SPAN_RE.lastIndex = 0;
  for (let m; (m = SPAN_RE.exec(raw)); ) {
    const tex = (m[1] ?? m[2] ?? m[3]).trim();
    const end = m.index + m[0].length;
    // 여는 표시나 닫는 표시가 이스케이프된 것이면 후보가 아니다. 그것을 수식 표시로 읽으면 글자 $가
    // 사라지고 끝에 남은 백슬래시가 조판 오류로 붉게 선다(실측: '가격은 \$5이고 이익은 \$.'가
    // '가격은 \5이고 이익은 \.'로 나왔다). 홑 $는 그 글자 자리를, \(·\[는 백슬래시 자리를 본다.
    const close = m[3] !== undefined ? end - 1 : end - 2;
    if (escapedAt(raw, m.index) || escapedAt(raw, close)) {
      SPAN_RE.lastIndex = m.index + 1;
      continue;
    }
    if (m[3] !== undefined && !acceptDollar(tex, raw, m.index, end)) {
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
// \[ … \] 덩어리. 비탐욕(+?)이어야 한 문단에 둘이 있을 때 그 사이까지 한 수식으로 삼키지 않는다.
const BRACKET_ALL_RE = /\\\[([\s\S]+?)\\\]/g;
// 문단에 글은 없고 수식만 있으면 별행으로 올린다. 하나든, 빈 줄 없이 잇달아 쓴 여럿이든 마찬가지다 —
// 모델은 유도 과정을 빈 줄 없이 줄바꿈만으로 잇대어 쓴다(실측: $$ 쪽은 가운데 정렬도 넘칠 때의 가로
// 스크롤도 없이 문장 속 표기로 남았고, \[…\] 쪽은 둘을 한 덩어리로 물어 수식으로 인식되지도 않았다).
// 글자가 섞인 문단은 올리지 않는다 — 그것은 문장 속 표기다.
function displayParagraph(node, source) {
  if (node.type !== 'paragraph') return null;
  const out = [];
  for (const child of node.children) {
    const from = child.position?.start?.offset;
    if (from === undefined) return null;
    if (child.type === 'inlineMath') {
      // 지금의 계약(아래 REMARK_PLUGINS의 singleDollarTextMath: false)에서 inlineMath로 오는 것은
      // $$뿐이라 이 확인은 늘 참이다 — 계약이 풀렸을 때를 위해 남겨 둔다. 홑 $ 하나짜리($v=d/t$)는
      // 그때에도 별행으로 올리지 않는다: 그것을 쓴 사람은 문장 속 표기를 쓴 것이다.
      if (!source.startsWith('$$', from) || !child.value.trim()) return null;
      out.push(mathNode(child.value, true));
      continue;
    }
    if (child.type !== 'text') return null;
    // 인용문·목록 안에서는 원문 줄 앞에 컨테이너 표시가 남아 있다 — 값과 맞춘 원문으로 본다(alignedRaw).
    // 그러지 않으면 '> \[a\]\n> \[b\]'의 둘째 줄 앞 '>'가 '덩어리 밖의 글자'로 읽혀 별행이 되지 못한다.
    const raw = alignedRaw(source.slice(from, child.position.end.offset), child.value);
    if (raw === null) return null;
    if (!raw.trim()) continue; // 수식 사이의 줄바꿈·공백
    const parts = [...raw.matchAll(BRACKET_ALL_RE)].filter(m => m[1].trim());
    // 덩어리 밖에 글자가 남으면 그것은 문장이다
    if (!parts.length || raw.replace(BRACKET_ALL_RE, '').trim()) return null;
    for (const m of parts) out.push(mathNode(m[1].trim(), true));
  }
  return out.length ? out : null;
}

// remark-math는 '$$' 뒤에 이어 쓴 글자를 코드펜스의 언어처럼 meta에 담는다 — 닫힌 블록에서도 그렇다.
// 그것을 그대로 두면 '$$ \bar{x} = 1' 로 시작한 수식이 빈 조판 블록이 되어 화면에서 통째로 사라진다
// (실측: 여는 줄에 쓴 글자가 없어지고, 본문이 함께 있으면 그 줄만 남았다).
// 노드를 고쳐 쓰지 않고 새로 만드는 이유: remark-math는 이미 data.hChildren에 '무엇을 그릴지'를
// 구워 두었다(빈 값 그대로). 값만 바꿔 끼우면 화면에는 여전히 빈 블록이 나온다(실측).
const withMeta = node => (node.type === 'math' && node.meta
  ? mathNode(node.value ? `${node.meta}\n${node.value}` : node.meta, true)
  : null);

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
    const replaced = displayParagraph(child, source) ?? unclosedMath(child, source) ?? withMeta(child);
    if (replaced) {
      const nodes = Array.isArray(replaced) ? replaced : [replaced];
      children.splice(i, 1, ...nodes);
      i += nodes.length - 1;
      continue;
    }
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
