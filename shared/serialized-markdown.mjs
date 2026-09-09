import { collectMathSpans } from './math-spans.mjs';
import { scopedMermaidMathExpressions } from './mermaid-math-spans.mjs';
import { mergeLiteralRanges, inlineCodeSpans, markdownLiteralRanges } from './inline-code.mjs';

// 모델이 JSON 이스케이프를 한 겹 더 남긴 경우만 복구한다. 코드·표 셀은 각자의 문법을 유지한다.
const N_COMMAND = /^\\n(?:u|eq|e|abla|ot|ewcommand|ewenvironment|ewline|olimits|onumber|eg|i|otin|rightarrow|leftarrow|subseteq|supseteq|parallel|exists|leq|geq|less|gtr|earrow|warrow|mid|cong|sim|simeq|shortmid|shortparallel|prec|succ|preceq|succeq)(?![A-Za-z])/;
function replaceOutsideMath(value, pattern, replace, language) {
  // Mermaid 라벨의 $$...$$·TeX 구분자 내부는 개행 직렬화 문법이 아니다.
  // 명령 이름을 나열하면 새 명령·매크로마다 다시 깨지므로 수식 범위 전체를 보존한다.
  const spans = language === 'mermaid'
    ? scopedMermaidMathExpressions(value, { lineBreaks: pattern })
    : collectMathSpans({ type: 'root', children: [] }, value).candidates.sort((a, b) => a.start - b.start);
  let index = 0;
  return value.replace(pattern, (match, offset) => {
    while (index < spans.length && spans[index].end <= offset) index++;
    return index < spans.length && spans[index].start <= offset ? match : replace(match, offset);
  });
}
export function decodeSerializedLines(value, language) {
  return replaceOutsideMath(value, /\\\\|\\r\\n|\\n|\\r(?![A-Za-z])/g, (match, offset) =>
    match === '\\\\' || N_COMMAND.test(value.slice(offset)) ? match : '\n', language);
}
export const decodeVisualizationBreaks = (value, language) => replaceOutsideMath(value, /\\?<br\s*\/?>/gi, () => '\n', language);
export function decodeMathEscapes(value) {
  // 정상 TeX의 \\ 행 구분자는 건드리지 않는다. 직렬화된 개행과 이중 명령이 함께 있거나,
  // $$ 안의 앞뒤에 직렬화된 개행이 남은 경우가 추가 이스케이프의 증거다.
  if (!/\\n/.test(value) || (!/\\\\[A-Za-z]/.test(value) && !/^\s*\\n[\s\S]*\\n\s*$/.test(value))) return value;
  return value.replace(/\\\\|\\r\\n|\\n/g, (match, offset) =>
    match === '\\\\' ? '\\' : N_COMMAND.test(value.slice(offset)) ? match : '\n');
}

export function normalizeSerializedMarkdown(source, tree, parse) {
  if (!source.includes('\\n') && !source.includes('\\>')) return source;
  const ranges = [];
  const visit = node => {
    if (['code', 'inlineCode', 'table', 'html', 'definition', 'link', 'image', 'inlineMath', 'math'].includes(node.type)) {
      ranges.push([node.position.start.offset, node.position.end.offset]);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  // 이스케이프된 백틱 확장은 첫 AST에서 일반 글자·br 조각이다. 화면과 서버의
  // 공통 코드 경계로 보호해야 내부 개행이 바깥 문서의 물리적 줄이 되지 않는다.
  for (const span of inlineCodeSpans(source, markdownLiteralRanges(tree)))
    if (/^(?:chart|mermaid)(?=(?:\\r)?\\n|\\?<br\s*\/?>)/i.test(span.value.trim()))
      ranges.push([span.start, span.end]);
  // 양끝 파이프가 없는 표는 다음 행이 영문으로 시작할 수 있다. 직렬화된
  // 구분 행이 있는 문서에서만 그 개행도 복구하며, 수식 본문은 먼저 보호한다.
  const serializedTable = /\\n[ \t>]*\|?[ \t]*:?-{3,}[ \t]*:?[ \t]*\|/.test(source);
  if (serializedTable) for (const span of collectMathSpans(tree, source, parse).candidates)
    ranges.push([span.start, span.end]);
  // 직렬화된 CRLF를 한 번에 복구해야 표 구분 행 끝에 문자 \\r이 남지 않는다.
  const decode = (text, offset) => (serializedTable ? text.replace(/(?<!\\)\\r\\n|(?<!\\)\\n/g,
    (match, at) => N_COMMAND.test(text.slice(at)) ? match : '\n') : text).replace(/(?<!\\)\\r\\n|(?<!\\)\\n\\n|(?<!\\)\\n(?=[^A-Za-z]|$)/g,
    match => match === '\\n\\n' ? '\n\n' : '\n')
    .replace(/^([ \t]{0,3})\\>(?=\s|$)/gm, (match, indent, index) =>
      index > 0 || offset === 0 || /[\r\n]/.test(source[offset - 1]) ? indent + '>' : match);
  let out = '', at = 0;
  for (const [start, end] of mergeLiteralRanges(ranges)) {
    out += decode(source.slice(at, start), at) + source.slice(start, end);
    at = end;
  }
  out += decode(source.slice(at), at);
  return out;
}
