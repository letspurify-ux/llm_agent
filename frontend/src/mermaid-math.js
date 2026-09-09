// Mermaid가 본문에서 제외하는 frontmatter·지시문·주석에는 수식 라벨이 없다.
// 원문과 같은 길이로 가려 위치를 유지하고, 실제 표현식만 치환한다.
// 경계는 설치된 Mermaid의 preprocess/frontmatter/comments 규칙을 따른다.
import { decodeString } from 'micromark-util-decode-string';
const mask = value => value.replace(/[^\r\n]/g, ' ');
export function mermaidMathExpressions(source) {
  let text = source.replace(/^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/s, mask);
  let at = 0, masked = '';
  for (let start = text.indexOf('%%{'); start >= 0; start = text.indexOf('%%{', at)) {
    const close = text.indexOf('}%%', start + 3);
    const end = close < 0 ? text.length : close + 3;
    masked += text.slice(at, start) + mask(text.slice(start, end));
    at = end;
  }
  text = (masked + text.slice(at)).replace(/^\s*%%(?!{)[^\r\n]+(?:\r\n?|\n)?/gm, mask);
  return [...text.matchAll(/\$\$([^\r\n]+?)\$\$/g)].map(match => ({
    start: match.index, end: match.index + match[0].length, value: match[1],
  }));
}

export function replaceMermaidMath(source, render) {
  let out = '', at = 0;
  for (const span of mermaidMathExpressions(source)) {
    out += source.slice(at, span.start) + render(span.value);
    at = span.end;
  }
  return out + source.slice(at);
}

// Mermaid 문법을 별도로 추측하지 않는다. 수식 후보를 충돌 없는 글자로 가린 뒤
// 실제 파서가 만든 라벨에서만 찾는다. 주소·툴팁·접근성 설명·스타일·식별자의
// 같은 달러 표기는 원문으로 남으며, 노드·연결선·하위 그래프·shape label은 같다.
export async function prepareMermaidMath(source, parse, render) {
  const spans = mermaidMathExpressions(source);
  if (!spans.length) return { source, math: false };
  let prefix = 'LLMMERMAIDMATH';
  while (source.includes(prefix)) prefix += 'X';
  const tokens = spans.map((_, index) => `${prefix}${index}END`);
  let index = 0;
  const diagram = await parse(replaceMermaidMath(source, () => tokens[index++]));
  const vertices = [...diagram.db.getVertices().values()];
  const edges = diagram.db.getEdges();
  const groups = diagram.db.getSubGraphs();
  const labels = [...vertices.map(node => node.text), ...edges.map(edge => edge.text), ...groups.map(group => group.title)];
  const ids = [...vertices.map(node => node.id), ...edges.map(edge => edge.id), ...groups.map(group => group.id)];
  const pattern = new RegExp(`${prefix}\\d+END`, 'g');
  const containedTokens = values => new Set(values.flatMap(value => typeof value === 'string' ? value.match(pattern) ?? [] : []));
  const labelTokens = containedTokens(labels), idTokens = containedTokens(ids);
  index = 0;
  return {
    source: replaceMermaidMath(source, value => {
      const token = tokens[index++];
      // 생략된 라벨은 노드 ID 자체다. ID를 HTML로 바꾸면 연결·class·click이
      // 끊어진다. 그 경우 원문 라벨의 조판은 Mermaid에 맡긴다.
      return labelTokens.has(token) && !idTokens.has(token) ? render(value) : `$$${value}$$`;
    }),
    math: labelTokens.size > 0,
  };
}

// KaTeX가 만든 HTML의 값은 유지하고 바깥 Mermaid/YAML 문법이 될 문자만
// 문자 참조로 표현한다. 큰/작은따옴표 라벨뿐 아니라 shape의 평문 값에서도
// TeX annotation의 ^·중괄호·백슬래시가 문법을 끊지 않는다. 사용자 HTML용이 아니다.
// Mermaid는 #번호;를 파싱 동안 보호하고 HTML의 &#번호;로 복원한다.
// HTML 표기를 직접 넣으면 앞의 &가 중복되어 표시 문자열·속성이 달라진다.
const reference = char => `#${char.codePointAt(0)};`;
// 구두점은 모두 문자 참조로 써서 바깥 문법의 구분자나 다음 수식 후보가 되지
// 않게 한다. 기존 HTML 문자 참조도 같은 값의 Mermaid 표기로 한 번만 옮긴다.
const literalText = value => value.replace(/&(?:#x[\da-f]+|#\d+|[a-z][\da-z]*);|[\x00-\x1f\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]/gi,
  value => value.length === 1 ? reference(value) : [...decodeString(value)].map(reference).join(''));
export const mermaidMathML = html => html
  // Mermaid 자체 KaTeX 경로도 annotation을 제거한다. 이 대체 원문은 그림의
  // 라벨이 아니며 Markdown 재해석 중 이스케이프가 풀리면 새 수식이 될 수 있다.
  .replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/g, '')
  // HTML 디코딩 뒤에도 $$를 다시 찾으므로 연속 달러만 인접한 MathML 텍스트로
  // 나눈다. 같은 mrow 안에서 서식·글자·폭은 유지하며 HTML span의 CSS도 받지 않는다.
  .replace(/<mtext([^>]*)>([^<]*)<\/mtext>/g, (whole, attrs, value) => value.includes('$$')
    ? `<mrow><mtext${attrs}>${value.replace(/\$(?=\$)/g, `$</mtext><mtext${attrs}>`)}</mtext></mrow>` : whole)
  .replace(/="([^"]*)"/g, (_, value) => '=' + literalText(value).replace(/[\s=<>]/g, reference) + ' ')
  .replace(/>([^<]*)(?=<)/g, (_, value) => '>' + literalText(value));
