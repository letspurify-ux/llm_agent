import { STRUCTURE_DIAGRAM_CODE, STRUCTURE_QUERY } from './rich-table-structure-corpus.js';

export const SERIALIZED_ATOMS = [
  { id: 'code', open: '`ordinary', close: '`' },
  { id: 'link', open: '[link', close: '](https://example.test)' },
  { id: 'reference', open: '[link][ref', close: 'name]' },
  { id: 'image', open: '![alt', close: '](https://example.test)' },
  { id: 'html', open: '<span title="', close: '">CONTENT</span>' },
  { id: 'autolink', open: '<https://example.test/', close: '>' },
  { id: 'dollar', open: '$x^2', close: '$', error: true },
  { id: 'double-dollar', open: '$$x^2', close: '$$', error: true },
  { id: 'parentheses', open: '\\(x^2', close: '\\)', error: true },
  { id: 'display', open: '\\[x^2', close: '\\]', error: true },
];
export const SERIALIZED_HEADERS = ['HEAD', '$|h|$', STRUCTURE_QUERY, STRUCTURE_DIAGRAM_CODE];
export function serializedBoundaryTable(atom, { header = 'HEAD', edges = [true, true] } = {}) {
  return [
    ['L', header, 'R'], ['---', '---', '---'],
    ['OPEN', atom.open, 'OPEN_END'],
    ['MATH', '$z^2$', 'MATH_END'],
    ['QUERY', '앞<br>> - ' + STRUCTURE_QUERY, 'QUERY_END'],
    ['DIAGRAM', '앞<br>- ' + STRUCTURE_DIAGRAM_CODE, 'DIAGRAM_END'],
    ['CLOSE', atom.close, 'CLOSE_END'],
  ].map(row => (edges[0] ? '| ' : '') + row.join(' | ') + (edges[1] ? ' |' : '')).join('\n');
}
