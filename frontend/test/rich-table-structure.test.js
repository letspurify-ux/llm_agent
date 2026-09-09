import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '../src/math.js';
import { parseChartBlock } from '../src/chart.js';
import { PreviewPre } from '../src/preview.js';
import { resolveChartData } from '../../backend/src/chart.js';
import { answerSyntax } from '../../backend/src/markdown-syntax.js';
import { MIXED_WRAPPERS } from './mixed-content-corpus.js';
import { STRUCTURE_HEADERS, STRUCTURE_DIAGRAM, STRUCTURE_QUERY, STRUCTURE_URL,
  STRUCTURE_DEFINITION, structureTable } from './rich-table-structure-corpus.js';

const steps = [[{ LABEL: 'FOUND_ROW | $literal$', VALUE: 7 }]];
const nodesOf = (node, type) => [ ...(node.type === type ? [node] : []),
  ...(node.children ?? []).flatMap(child => nodesOf(child, type)) ];
const render = (source, preview = false) => {
  let tree;
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    remarkPlugins: [...REMARK_PLUGINS, () => value => { tree = value; }], rehypePlugins: REHYPE_PLUGINS,
    components: preview ? { pre: PreviewPre } : {},
  }, source));
  assert.doesNotMatch(html, /LLMRICHTABLE|LLMMATHPLACEHOLDER|LLMCELLNODE/);
  return { html, tree };
};
const check = (source, header, column = 1) => {
  const resolved = resolveChartData(source, steps);
  const { tree, html } = render(resolved);
  const tables = nodesOf(tree, 'table');
  assert.equal(tables.length, 1, source);
  const rows = tables[0].children;
  assert.equal(rows.length, 5, source);
  for (const row of rows) assert.equal(row.children.length, 3, source);
  assert.deepEqual(rows.slice(1).map(row => nodesOf(row.children[2], 'text').map(n => n.value).join('')),
    ['MATH_END', 'DIAGRAM_END', 'QUERY_END', 'LINK_END']);
  const formulas = [...nodesOf(tree, 'math'), ...nodesOf(tree, 'inlineMath')].map(n => n.value).sort();
  assert.deepEqual(formulas, [header.math, 'z^2'].filter(Boolean).sort(), source);
  assert.equal((html.match(/class="math-error/g) ?? []).length, header.error ? 1 : 0, source);
  if (header.error) assert.ok(html.includes('$\\unknown{a|b}$'), source);
  if (header.math) assert.equal(nodesOf(rows[0].children[column], 'inlineMath')[0]?.value, header.math, source);
  const codes = nodesOf(tree, 'code');
  assert.deepEqual(codes.filter(n => n.lang === 'mermaid').map(n => n.value),
    Array(header.diagram ? 2 : 1).fill(STRUCTURE_DIAGRAM), source);
  const charts = codes.filter(n => n.lang === 'chart');
  assert.equal(charts.length, header.chart ? 2 : 1, source);
  for (const chart of charts) {
    const result = parseChartBlock(chart.value);
    assert.ok(result.ok, chart.value);
    assert.equal(result.spec.title, 'METRIC | 원문');
    assert.equal(result.spec.rows[0].full, 'FOUND_ROW | $literal$');
    assert.deepEqual(result.spec.rows[0].values, [7]);
  }
  const literal = rows[4].children[1];
  const control = render(STRUCTURE_URL).tree;
  assert.deepEqual(nodesOf(literal, 'link').map(n => [n.url, n.children[0].value]),
    nodesOf(control, 'link').map(n => [n.url, n.children[0].value]), source);
  const syntax = answerSyntax(source, { serialized: true });
  assert.equal(syntax.tableRows.length, 5, source);
  assert.ok(syntax.tableRows.some(([start, end]) => syntax.source.slice(start, end).includes(STRUCTURE_QUERY)), source);
};

test('머리글의 내부 언어가 표 구조·조회 주입을 결정하지 않는다: 13종 × 컨테이너 5종 × 개행 5종 × 열 3종', () => {
  for (const header of STRUCTURE_HEADERS) for (const wrap of Object.values(MIXED_WRAPPERS))
    for (const newline of ['\n', '\r\n', '\r', '\\n', '\\r\\n']) for (const column of [0, 1, 2]) {
      const source = (wrap(structureTable(header.source, { column })) + STRUCTURE_DEFINITION).replaceAll('\n', newline);
      check(source, header, column);
    }
});

test('미완성 코드의 백틱은 다른 표 행의 코드·수식·조회와 짝을 만들지 않는다', () => {
  for (const head of ['MIDDLE', '$|x|$', '`ordinary']) for (const ticks of ['`', '``', '```'])
    for (const language of ['ordinary', 'chart', 'mermaid']) for (const wrap of Object.values(MIXED_WRAPPERS))
      for (const newline of ['\n', '\r\n', '\r']) {
        const source = wrap(['| L | ' + head + ' | R |', '|---|---|---|',
          '| OPEN | ' + ticks + language + '\\ndata:step1 | OPEN_END |',
          '| MATH | $x^2$ | MATH_END |', '| QUERY | ' + STRUCTURE_QUERY + ' | QUERY_END |',
          '| DIAGRAM | `mermaid\\n' + STRUCTURE_DIAGRAM.replaceAll('\n', '\\n') + '` | DIAGRAM_END |',
        ].join('\n')).replaceAll('\n', newline);
        const resolved = resolveChartData(source, steps);
        assert.equal((resolved.match(/FOUND_ROW/g) ?? []).length, 1, source);
        const { tree } = render(resolved);
        const rows = nodesOf(tree, 'table')[0]?.children;
        assert.equal(rows?.length, 5, source);
        assert.equal(nodesOf(rows[2].children[1], 'inlineMath')[0]?.value, 'x^2', source);
        assert.ok(parseChartBlock(nodesOf(rows[3].children[1], 'code')[0]?.value).ok, source);
        assert.equal(nodesOf(rows[4].children[1], 'code')[0]?.value, STRUCTURE_DIAGRAM, source);
        assert.deepEqual(rows.slice(1).map(row => nodesOf(row.children[2], 'text')[0]?.value),
          ['OPEN_END', 'MATH_END', 'QUERY_END', 'DIAGRAM_END'], source);
      }
});

test('양끝 파이프 없는 표와 각주 안의 표도 원문 좌표·서식·그림을 보존한다', () => {
  for (const header of STRUCTURE_HEADERS) for (const edges of [[false, false], [true, false], [false, true], [true, true]])
    for (const newline of ['\n', '\r\n', '\r']) {
      const source = ('본문[^note]\n\n[^note]: 표\n\n' +
        structureTable(header.source, { edges }).split('\n').map(line => '    ' + line).join('\n') +
        STRUCTURE_DEFINITION).replaceAll('\n', newline);
      check(source, header);
      assert.match(render(resolveChartData(source, steps)).html, /data-footnote-ref="true"/);
    }
});

test('자동 링크 안의 코드는 주소로 남고 이웃 셀의 차트만 조회로 채운다', () => {
  for (const fence of ['`', '``', '```']) for (const language of ['chart', 'mermaid']) {
    const url = 'https://example.test/' + fence + language + '\\ndata:step1' + fence;
    for (const link of [url, '<' + url + '>', '[주소](' + url + ')'])
      for (const header of ['MIDDLE', '$|x|$']) for (const wrap of Object.values(MIXED_WRAPPERS)) {
        const source = wrap(`| L | ${header} | R |\n|---|---|---|\n| LEFT | ${link} | RIGHT |`);
        assert.equal(resolveChartData(source, steps), source);
        const { tree } = render(source);
        const reference = renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [remarkGfm] }, link));
        assert.ok(render(source).html.includes(reference.slice(3, -4)), source);
        assert.equal(nodesOf(tree, 'code').length, 0, source);
        const mixed = source + '\n\n' + STRUCTURE_QUERY;
        const mixedTree = render(resolveChartData(mixed, steps)).tree;
        assert.equal(nodesOf(mixedTree, 'code').filter(n => n.lang === 'chart').length, 1, mixed);
      }
  }
});

test('구조 분석은 일반 코드·산문·잘못된 구분 행을 새 표나 조회 대상으로 만들지 않는다', () => {
  for (const header of STRUCTURE_HEADERS) {
    const table = structureTable(header.source) + STRUCTURE_DEFINITION;
    for (const source of ['````text\n' + table + '\n````', table.split('\n').map(line => '    ' + line).join('\n'),
      table.replace('| --- | --- | --- |', '| --- | --- |'), '설명 | ' + STRUCTURE_QUERY + ' | 끝']) {
      assert.equal(resolveChartData(source, steps), source, source);
      const { tree } = render(source);
      assert.equal(nodesOf(tree, 'table').length, 0, source);
      assert.equal(nodesOf(tree, 'code').filter(n => n.lang === 'chart').length, 0, source);
    }
  }
  for (const prefix of ['', '예시 ']) for (const ticks of ['``', '```']) {
    const value = 'H | M\\n--- | ---\\nA | `chart\\ndata:step1`';
    const source = prefix + ticks + ' ' + value + ' ' + ticks;
    assert.equal(resolveChartData(source, steps), source);
    const { html, tree } = render(source);
    assert.equal(nodesOf(tree, 'table').length, 0, source);
    assert.ok(html.includes(value), source);
  }
});

test('수식 머리글로 새로 발견한 표에서도 미완성 수식을 원래 셀에 격리한다', () => {
  for (const header of STRUCTURE_HEADERS) for (const open of ['$', '$$', '\\(', '\\['])
    for (const wrap of Object.values(MIXED_WRAPPERS)) for (const newline of ['\n', '\r\n', '\r']) {
      const incomplete = open + 'a=\\frac{1}{|x|}';
      const source = (wrap(structureTable(header.source).replace('앞<br>> - **강조** $z^2$', () => incomplete)) +
        STRUCTURE_DEFINITION).replaceAll('\n', newline);
      const { html, tree } = render(resolveChartData(source, steps));
      const rows = nodesOf(tree, 'table')[0]?.children;
      assert.ok(rows && rows.length === 5, source);
      assert.equal(rows[1].children.length, 3, source);
      assert.equal(nodesOf(rows[1].children[2], 'text')[0]?.value, 'MATH_END', source);
      assert.ok(html.includes('<code>' + incomplete + '</code>'), source);
      assert.equal((html.match(/class="math-error/g) ?? []).length, header.error ? 2 : 1, source);
      assert.equal(nodesOf(tree, 'code').filter(n => n.lang === 'chart').length, header.chart ? 2 : 1, source);
    }
});

test('수신 중 머리글·새 행의 모든 접두사에서 토큰을 감추고 이미 완성된 행을 유지한다', () => {
  for (const header of STRUCTURE_HEADERS) {
    const first = structureTable(header.source) + '\n';
    const tail = '| NEXT | `mermaid\\nflowchart LR\\nA -->|next| B` $q^2$ | STREAM_END |';
    for (let end = 0; end <= first.length + tail.length; end++) {
      const source = (first + tail).slice(0, end) + STRUCTURE_DEFINITION;
      const { tree } = render(source, true);
      if (end >= first.length) {
        const table = nodesOf(tree, 'table')[0];
        assert.ok(table, source);
        assert.deepEqual(table.children.slice(1, 5).map(row => nodesOf(row.children[2], 'text').map(n => n.value).join('')),
          ['MATH_END', 'DIAGRAM_END', 'QUERY_END', 'LINK_END'], source);
      }
    }
  }
});
