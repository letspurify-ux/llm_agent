export const STRUCTURE_DIAGRAM = 'flowchart LR\nA["$$x^2$$"] -->|label| B';
export const STRUCTURE_DIAGRAM_CODE = '`mermaid\\n' + STRUCTURE_DIAGRAM.replaceAll('\n', '\\n') + '`';
export const STRUCTURE_QUERY = '`chart\\ntype:bar\\ntitle: METRIC | 원문\\ndata:step1`';
export const STRUCTURE_URL = 'https://example.test/`chart\\ndata:step1`';
export const STRUCTURE_HEADERS = [
  { id: 'dollar', source: '$|x|$', math: '|x|' },
  { id: 'unclosed-code', source: '$|x|$ `ordinary', math: '|x|' },
  { id: 'double-dollar', source: '$$|x|$$', math: '|x|' },
  { id: 'parentheses', source: String.raw`\(a|b\)`, math: 'a|b' },
  { id: 'display', source: String.raw`\[a|b\]`, math: 'a|b' },
  { id: 'environment', source: String.raw`\begin{array}{c|c}a&b\end{array}`,
    math: String.raw`\begin{array}{c|c}a&b\end{array}` },
  { id: 'error', source: String.raw`$\unknown{a|b}$`, math: String.raw`\unknown{a|b}`, error: true },
  { id: 'emphasis', source: '**수식 $|x|$**', math: '|x|' },
  { id: 'link', source: '[**수식 $|x|$**](https://example.test/ref)', math: '|x|' },
  { id: 'reference', source: '[**수식 $|x|$**][ref]', math: '|x|' },
  { id: 'literal-in-math', source: '$\\text{`chart<br>data:step1` | 원문}$',
    math: '\\text{`chart<br>data:step1` | 원문}' },
  { id: 'mermaid', source: STRUCTURE_DIAGRAM_CODE, diagram: true },
  { id: 'chart', source: STRUCTURE_QUERY, chart: true },
];

export function structureTable(header, { column = 1, edges = [true, true] } = {}) {
  const cells = ['HEAD_LEFT', 'HEAD_MIDDLE', 'HEAD_RIGHT'];
  cells[column] = header;
  return [cells, ['---', '---', '---'],
    ['BODY_MATH', '앞<br>> - **강조** $z^2$', 'MATH_END'],
    ['BODY_DIAGRAM', '앞<br>- ' + STRUCTURE_DIAGRAM_CODE, 'DIAGRAM_END'],
    ['BODY_QUERY', '앞<br>> - ' + STRUCTURE_QUERY, 'QUERY_END'],
    ['BODY_LITERAL', STRUCTURE_URL, 'LINK_END'],
  ].map(row => (edges[0] ? '| ' : '') + row.join(' | ') + (edges[1] ? ' |' : '')).join('\n');
}
export const STRUCTURE_DEFINITION = '\n\n[ref]: https://example.test/ref';
