// 모델이 JSON 이스케이프를 한 겹 더 남긴 경우만 복구한다. 코드·표 셀은 각자의 문법을 유지한다.
const N_COMMAND = /^\\n(?:u|eq|e|abla|ot|ewcommand|ewenvironment|ewline|olimits|onumber|eg|i|otin|rightarrow|leftarrow|subseteq|supseteq|parallel|exists|leq|geq|less|gtr|earrow|warrow|mid|cong|sim|simeq|shortmid|shortparallel|prec|succ|preceq|succeq)(?![A-Za-z])/;
export function decodeSerializedLines(value) {
  return value.replace(/\\\\|\\r\\n|\\n|\\r(?![A-Za-z])/g, (match, offset) =>
    match === '\\\\' || N_COMMAND.test(value.slice(offset)) ? match : '\n');
}
export function decodeMathEscapes(value) {
  // 정상 TeX의 \\ 행 구분자는 건드리지 않는다. 직렬화된 개행과 이중 명령이 함께 있거나,
  // $$ 안의 앞뒤에 직렬화된 개행이 남은 경우가 추가 이스케이프의 증거다.
  if (!/\\n/.test(value) || (!/\\\\[A-Za-z]/.test(value) && !/^\s*\\n[\s\S]*\\n\s*$/.test(value))) return value;
  return value.replace(/\\\\|\\r\\n|\\n/g, (match, offset) =>
    match === '\\\\' ? '\\' : N_COMMAND.test(value.slice(offset)) ? match : '\n');
}

export default function remarkSerializedMarkdown() {
  const processor = this;
  return (tree, file) => {
    const source = String(file);
    if (!source.includes('\\n') && !source.includes('\\>')) return tree;
    const ranges = [];
    const visit = node => {
      if (['code', 'inlineCode', 'table', 'html', 'definition', 'link', 'image', 'inlineMath', 'math'].includes(node.type)) {
        ranges.push([node.position.start.offset, node.position.end.offset]);
        return;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
    const decode = (text, offset) => text.replace(/(?<!\\)\\n\\n|(?<!\\)\\n(?=[^A-Za-z]|$)/g,
      match => match === '\\n\\n' ? '\n\n' : '\n')
      .replace(/^([ \t]{0,3})\\>(?=\s|$)/gm, (match, indent, index) =>
        index > 0 || offset === 0 || /[\r\n]/.test(source[offset - 1]) ? indent + '>' : match);
    let out = '', at = 0;
    for (const [start, end] of ranges) {
      out += decode(source.slice(at, start), at) + source.slice(start, end);
      at = end;
    }
    out += decode(source.slice(at), at);
    if (out === source) return tree;
    file.value = out;
    return processor.parse(out);
  };
}
