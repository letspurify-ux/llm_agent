import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '../src/math.js';
import { PreviewPre } from '../src/preview.js';
import { parseChartBlock } from '../src/chart.js';
import { resolveChartData } from '../../backend/src/chart.js';
import { answerSyntax } from '../../backend/src/markdown-syntax.js';
import { MIXED_WRAPPERS } from './mixed-content-corpus.js';
import { CELL_ATOMS, cellOwnershipTable } from './cell-ownership-corpus.js';
import { STRUCTURE_DIAGRAM, STRUCTURE_DIAGRAM_CODE, STRUCTURE_HEADERS } from './rich-table-structure-corpus.js';
import { decodeSerializedLines, decodeMathEscapes } from '../../shared/serialized-markdown.mjs';

const steps = [[{ LABEL: 'FOUND_ROW | $literal$', VALUE: 7 }]];
const nodes = (node, type) => [...(node.type === type ? [node] : []), ...(node.children ?? []).flatMap(n => nodes(n, type))];
const render = (source, preview = false) => {
  let tree;
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    remarkPlugins: [...REMARK_PLUGINS, () => value => { tree = value; }], rehypePlugins: REHYPE_PLUGINS,
    components: preview ? { pre: PreviewPre } : {},
  }, source));
  assert.doesNotMatch(html, /LLMRICHTABLE|LLMMATHPLACEHOLDER|LLMCELLNODE/);
  return { html, tree };
};
const check = (source, atom, reverse = false) => {
  const resolved = resolveChartData(source, steps);
  const { tree, html } = render(resolved);
  const table = nodes(tree, 'table')[0];
  assert.ok(table, source);
  const row = table.children[1];
  assert.equal(row.children.length, 7, source);
  assert.equal(nodes(row.children[0], 'text')[0]?.value, 'LEFT', source);
  assert.equal(nodes(row.children[6], 'text')[0]?.value, 'RIGHT', source);
  const payload = row.children.slice(2, 5);
  if (reverse) payload.reverse();
  assert.equal(nodes(payload[0], 'inlineMath')[0]?.value, 'z^2', source);
  assert.equal(nodes(payload[1], 'code')[0]?.value, STRUCTURE_DIAGRAM, source);
  const chart = parseChartBlock(nodes(payload[2], 'code')[0]?.value);
  assert.ok(chart.ok, source);
  assert.equal(chart.spec.title, 'METRIC | 원문', source);
  assert.equal(chart.spec.rows[0].full, 'FOUND_ROW | $literal$', source);
  assert.deepEqual(chart.spec.rows[0].values, [7], source);
  assert.equal((html.match(/class="math-error/g) ?? []).length, atom.error ? 1 : 0, source);
  const preview = render(resolved, true).html;
  assert.ok(preview.includes('<td>RIGHT</td>') && preview.includes('application/x-tex">z^2</annotation>'), source);
  return resolved;
};

test('같은 행의 서로 다른 셀에서 열린 원자는 정상 수식·차트·그림을 소유하지 않는다: 2,000개 조합', () => {
  for (const atom of CELL_ATOMS) for (const wrap of Object.values(MIXED_WRAPPERS))
    for (const edges of [[true, true], [false, false], [true, false], [false, true]]) for (const reverse of [false, true]) {
      const canonical = wrap(cellOwnershipTable(atom, { edges, reverse }));
      const expected = check(canonical, atom, reverse);
      for (const newline of ['\r\n', '\r', '\\n', '\\r\\n']) {
        const source = canonical.replaceAll('\n', newline);
        const resolved = check(source, atom, reverse);
        assert.equal(render(resolved).html, render(expected).html, source);
      }
    }
});

test('수식·시각화 머리글이 있는 표에서도 셀 소유 범위를 확정한다', () => {
  for (const atom of CELL_ATOMS.filter(atom => !atom.error)) for (const header of STRUCTURE_HEADERS.filter(header => !header.error)) {
    const source = cellOwnershipTable(atom, { header: header.source }) + '\n\n[ref]: https://example.test/ref';
    check(source, atom);
    assert.equal(render(resolveChartData(source.replaceAll('\n', '\\n'), steps)).html,
      render(resolveChartData(source, steps)).html, source);
  }
});

test('표의 직렬화 개행은 다음 셀의 글자나 구분 행 대시 개수와 무관하다', () => {
  for (const head of ['u', 'eq', 'ewcommand', 'ot', 'abla', 'x', '한글']) for (const dashes of ['-', '--', '---', '-----'])
    for (const edges of [[true, true], [false, false], [true, false], [false, true]]) for (const wrap of Object.values(MIXED_WRAPPERS)) {
      const source = wrap([['L', 'R'], [dashes, dashes], [head, '$\\nu + \\nleqq$']]
        .map(cells => (edges[0] ? '| ' : '') + cells.join(' | ') + (edges[1] ? ' |' : '')).join('\n'));
      for (const newline of ['\\n', '\\r\\n']) {
        const encoded = source.replaceAll('\n', newline);
        assert.equal(answerSyntax(encoded, { serialized: true }).source, source, encoded);
        assert.equal(render(encoded).html, render(source).html, encoded);
      }
    }
});

test('뒤 셀을 수신하는 동안에도 완성된 셀의 수식과 시각화를 유지한다', () => {
  for (const atom of CELL_ATOMS) for (const header of ['MATH', '$|h|$']) for (const newline of ['\n', '\\n']) for (const reverse of [false, true]) {
    const source = cellOwnershipTable(atom, { header, reverse }).replaceAll('\n', newline);
    const at = source.indexOf(STRUCTURE_DIAGRAM_CODE);
    const diagramEnd = at + STRUCTURE_DIAGRAM_CODE.length;
    for (let end = at; end <= source.length; end++) {
      const { tree, html } = render(resolveChartData(source.slice(0, end), steps), true);
      if (!reverse || source.slice(0, end).includes('$z^2$'))
        assert.equal(nodes(tree, 'inlineMath').find(node => node.value === 'z^2')?.value, 'z^2', source.slice(0, end));
      if (reverse) {
        const chart = parseChartBlock(nodes(tree, 'code').find(node => node.lang === 'chart')?.value);
        assert.ok(chart.ok, source.slice(0, end));
        assert.equal(chart.spec.rows[0].full, 'FOUND_ROW | $literal$');
        assert.deepEqual(chart.spec.rows[0].values, [7]);
      }
      assert.ok(html.includes('<td>LEFT</td>'), source.slice(0, end));
      if (end >= diagramEnd) {
        assert.equal(nodes(tree, 'code').find(node => node.lang === 'mermaid')?.value, STRUCTURE_DIAGRAM, source.slice(0, end));
        assert.ok(html.includes('표·차트를 준비하고 있습니다'), source.slice(0, end));
      }
    }
  }
});

test('시각화 행의 첫 단어와 TeX 제어 단어를 명령 이름 목록 없이 구별한다', () => {
  for (const word of ['u', 'eq', 'ewcommand', 'ot', 'abla', 'x']) for (const newline of ['\\n', '\\r\\n']) {
    const diagram = 'flowchart LR\n' + word + '["$$\\nu+\\nleqq$$"] --> done';
    assert.equal(decodeSerializedLines(diagram.replaceAll('\n', newline), 'mermaid'), diagram);
    const source = '| L | R |\n|---|---|\n| `mermaid' + newline + diagram.replaceAll('\n', newline) + '` | RIGHT |';
    assert.equal(nodes(render(source).tree, 'code')[0]?.value, diagram);
    const chart = 'type:bar\nLABEL | VALUE\n--- | ---\n' + word + ' | 7';
    assert.equal(decodeSerializedLines(chart.replaceAll('\n', newline), 'chart'), chart);
  }
  for (const tex of [String.raw`\nleqq`, String.raw`\nVdash`, String.raw`\nCUSTOM`])
    for (const newline of ['\\n', '\\r\\n']) for (const leading of ['', 'x=']) {
      assert.equal(decodeMathEscapes(newline + leading + String.raw`\\frac{1}{2}+` + tex + newline),
        '\n' + leading + '\\frac{1}{2}+' + tex + '\n');
    }
  for (const newline of ['\\n', '\\r\\n']) {
    assert.equal(decodeMathEscapes(newline + 'x^2' + newline), '\nx^2\n');
    assert.ok(render('$$' + newline + 'x^2' + newline + '$$').html.includes('application/x-tex">x^2</annotation>'));
  }
});
