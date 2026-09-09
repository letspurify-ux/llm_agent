import { SERIALIZED_ATOMS } from './serialized-boundaries-corpus.js';
import { STRUCTURE_DIAGRAM_CODE, STRUCTURE_QUERY } from './rich-table-structure-corpus.js';

export const CELL_ATOMS = SERIALIZED_ATOMS;
export function cellOwnershipTable(atom, { edges = [true, true], header = 'MATH', reverse = false } = {}) {
  const values = ['앞<br>> - **수식** $z^2$', '앞<br>- ' + STRUCTURE_DIAGRAM_CODE, '앞<br>> - ' + STRUCTURE_QUERY];
  if (reverse) values.reverse();
  return [
    ['L', 'OPEN', header, 'GRAPH', 'QUERY', 'CLOSE', 'R'],
    Array(7).fill('---'),
    ['LEFT', atom.open, ...values, atom.close, 'RIGHT'],
  ].map(cells => (edges[0] ? '| ' : '') + cells.join(' | ') + (edges[1] ? ' |' : '')).join('\n');
}
