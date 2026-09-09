import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { REMARK_PLUGINS, REHYPE_PLUGINS, renderMathML } from '../src/math.js';
import { PreviewPre } from '../src/preview.js';
import { MIXED_WRAPPERS } from './mixed-content-corpus.js';
import { CELL_CONTAINERS, CELL_CHART, CELL_MERMAID } from './cell-blocks-corpus.js';
import { resolveChartData } from '../../backend/src/chart.js';

const render = (source, preview = false) => {
  let tree;
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    remarkPlugins: [...REMARK_PLUGINS, () => value => { tree = value; }],
    rehypePlugins: REHYPE_PLUGINS, components: preview ? { pre: PreviewPre } : {},
  }, source));
  return { tree, html };
};
const find = (node, predicate) => predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean);
const structure = node => {
  const children = (node.children ?? []).flatMap(structure);
  return ['list', 'listItem', 'blockquote'].includes(node.type)
    ? [{ type: node.type, ordered: node.ordered, start: node.start, checked: node.checked, children }]
    : children;
};
const payloadPath = (node, predicate, path = []) => {
  if (['list', 'listItem', 'blockquote'].includes(node.type)) path = [...path, node.type];
  return predicate(node) ? path : node.children?.map(child => payloadPath(child, predicate, path)).find(Boolean);
};
const table = cell => '| L | M | R |\n|---|---|---|\n| LEFT | ' + cell + ' | RIGHT |';

test('표 셀의 다단 목록·인용·작업 목록은 표 밖 Markdown과 같은 구조로 수식·코드·시각화를 포함한다', () => {
  const contents = [
    { source: '**강조** $x^2$ [주소](https://example.test/\\n) `LLMCELLNODE0END`', type: 'inlineMath', value: 'x^2' },
    { source: '$\\unknown{x}$', type: 'inlineMath', value: '\\unknown{x}' },
    { source: CELL_CHART, type: 'code', value: 'type:bar\ndata:step1' },
    { source: CELL_MERMAID, type: 'code', value: 'flowchart LR\nA["$$x^2$$"] -->|label| B' },
  ];
  for (const container of CELL_CONTAINERS) {
    const expected = render(container('PAYLOAD')).tree;
    const expectedPath = payloadPath(expected, node => node.type === 'text' && node.value.includes('PAYLOAD'));
    for (const content of contents) for (const br of ['<br>', '\\<br>', '&lt;br&gt;'])
      for (const wrap of Object.values(MIXED_WRAPPERS)) for (const newline of ['\n', '\r\n', '\r']) {
        const source = wrap(table(container(content.source).replaceAll('\n', br))).replaceAll('\n', newline);
        const { tree, html } = render(source);
        const row = find(tree, node => node.type === 'tableRow' && node.children.some(cell => cell.children?.[0]?.value === 'LEFT'));
        assert.ok(row, source);
        assert.equal(row.children.length, 3, source);
        const cell = row.children[1];
        assert.deepEqual(structure(cell), structure(expected), source);
        assert.deepEqual(payloadPath(cell, node => node.type === content.type && node.value === content.value), expectedPath, source);
        assert.match(html, /<td>RIGHT<\/td>/);
        assert.doesNotMatch(html, /LLMRICHTABLE|LLMMATHPLACEHOLDER|<p><pre>|<strong><pre>/);
        // 사용자 원문의 토큰 모양 문자열도 그대로 남으며, 내부 토큰은 노출되지 않는다.
        assert.equal((html.match(/LLMCELLNODE\d+END/g) ?? []).length, content.source.includes('LLMCELLNODE') ? 1 : 0);
      }
  }
});

test('셀 블록 재구성은 들여쓴 인라인 원문·서식·주소를 다시 해석하지 않는다', () => {
  const { html } = render(table('앞<br><br>    **굵게** $x$ &ast;문자&ast; `LLMCELLNODE0END` [주소](https://example.test/a?x=\\n)'));
  assert.match(html, /<strong>굵게<\/strong>/);
  assert.match(html, /application\/x-tex">x<\/annotation>/);
  assert.match(html, /\*문자\*/);
  assert.doesNotMatch(html, /<em>문자|<pre>|LLMCELLNODE[1-9]/);
  assert.match(html, /href="https:\/\/example.test\/a\?x=%5Cn"/);
});

test('셀의 문자 참조·이스케이프는 수식 복원과 시각화 분리 후에도 블록 문법이 되지 않는다', () => {
  const literals = [[String.raw`\- 문자`, '- 문자'], [String.raw`\+ 문자`, '+ 문자'], [String.raw`\* 문자`, '* 문자'],
    [String.raw`1\. 문자`, '1. 문자'], [String.raw`1\) 문자`, '1) 문자'], [String.raw`\# 문자`, '# 문자'],
    ['&gt; 문자', '> 문자'], ['&num; 문자', '# 문자'], ['&#45; 문자', '- 문자'], ['&#x2a; 문자', '* 문자'],
    ['&#49;. 문자', '1. 문자'], ['-&#32;문자', '- 문자'], ['&#32;  - 문자', '   - 문자'], ['&Tab;- 문자', '\t- 문자']];
  const payloads = ['', '$x^2$', '$\\unknown{x}$', CELL_CHART, CELL_MERMAID];
  for (const [literal, value] of literals) for (const payload of payloads) for (const br of ['<br>', '\\<br>', '&lt;br&gt;'])
    for (const wrap of Object.values(MIXED_WRAPPERS)) for (const newline of ['\n', '\r\n', '\r']) {
      const source = wrap(table('앞' + br + literal + ' ' + payload)).replaceAll('\n', newline);
      const { tree, html } = render(source);
      const cell = find(tree, node => node.type === 'tableRow' && node.children[0]?.children[0]?.value === 'LEFT')?.children[1];
      assert.ok(cell, source);
      assert.equal(find(cell, node => ['list', 'blockquote', 'heading'].includes(node.type)), undefined, source);
      assert.ok(find(cell, node => node.type === 'text' && node.value.includes(value)), source);
      assert.match(html, /<td>RIGHT<\/td>/);
      assert.doesNotMatch(html, /LLMRICHTABLE|LLMMATHPLACEHOLDER|LLMCELLNODE/);
      if (payload.startsWith('$')) assert.equal(find(cell, node => node.type === 'inlineMath')?.value, payload.slice(1, -1), source);
      if (payload.startsWith('`')) assert.equal(find(cell, node => node.type === 'code')?.lang, payload.slice(1).split('\\n')[0], source);
    }
});

test('작업 목록 문자는 원문에 실제로 쓴 경우만 체크박스가 되며 인용·하위 목록의 위치를 보존한다', () => {
  for (const marker of ['&#91;x&#93;', '[&#120;]', '[x&#93;', '&#x5b;x]', '[x]']) {
    for (const container of CELL_CONTAINERS) for (const math of ['', '$x$']) {
      const source = table(container('- ' + marker + ' 문자 ' + math).replaceAll('\n', '<br>'));
      const { tree, html } = render(source);
      const cell = find(tree, node => node.type === 'tableRow' && node.children[0]?.children[0]?.value === 'LEFT').children[1];
      const expected = render(container('- ' + marker + ' 문자 ' + math)).tree;
      assert.deepEqual(structure(cell), structure(expected), source);
      if (marker !== '[x]') assert.match(html, /\[x\] 문자/);
    }
  }
});

test('셀 이스케이프의 모든 수신 접두사에서 앞 수식과 완성된 행·문자를 유지한다', () => {
  const first = table('$z=9$') + '\n';
  const next = '| next | 앞&lt;br&gt;\\- 문자 $x$<br>&gt; 인용 예시<br>' + CELL_MERMAID + ' | END |';
  for (let end = 0; end <= next.length; end++) {
    const { html } = render(first + next.slice(0, end), true);
    assert.match(html, /<td>RIGHT<\/td>/);
    assert.match(html, /application\/x-tex">z=9<\/annotation>/);
    assert.doesNotMatch(html, /<ul>|<blockquote>|LLMRICHTABLE|LLMMATHPLACEHOLDER|LLMCELLNODE/);
  }
});

test('다단 셀 시각화의 수신 접두사마다 앞 완성 행을 유지하고 완료 뒤 같은 목록 안에 그림을 둔다', () => {
  const first = table('$z=9$') + '\n';
  const next = '| next | ' + CELL_CONTAINERS[2](CELL_MERMAID).replaceAll('\n', '<br>') + ' | END |';
  for (let end = 0; end <= next.length; end++) {
    const { html } = render(first + next.slice(0, end), true);
    assert.match(html, /<td>RIGHT<\/td>/);
    assert.match(html, /application\/x-tex">z=9<\/annotation>/);
    assert.doesNotMatch(html, /LLMRICHTABLE|LLMMATHPLACEHOLDER|LLMCELLNODE/);
  }
  const { html } = render(first + next, true);
  assert.match(html, /표·차트를 준비하고 있습니다/);
});

test('표의 바깥 파이프를 생략해도 첫·중간·마지막 셀의 조회 차트를 채운다', () => {
  for (const left of ['', '|']) for (const right of ['', '|']) for (const column of [0, 1, 2])
    for (const wrap of Object.values(MIXED_WRAPPERS)) for (const newline of ['\n', '\r\n', '\r', '\\n', '\\r\\n']) {
      const cells = ['LEFT', '$x^2$', 'RIGHT']; cells[column] = CELL_CHART;
      const source = wrap([['L', 'M', 'R'], ['---', '---', '---'], cells]
        .map(row => left + row.join(' | ') + right).join('\n')).replaceAll('\n', newline);
      const result = resolveChartData(source, [[{ A: 'FOUND_ROW', B: 7 }]]);
      const { html } = render(result);
      assert.match(html, /language-chart/, source);
      assert.match(html, /FOUND_ROW/, source);
      assert.doesNotMatch(html, /data:step1|LLMRICHTABLE|LLMMATHPLACEHOLDER/, source);
      assert.equal((html.match(/<td(?: |\>)/g) ?? []).length, 3, source);
    }
});

test('시각화 안의 수식 전체는 명령 이름·br 모양과 무관하게 개행 복구에서 보호된다', () => {
  const formulas = ['nleqq', 'ngeqq', 'nleqslant', 'ngeqslant', 'ntriangleleft', 'ntriangleright',
    'ntrianglelefteq', 'ntrianglerighteq', 'nVdash', 'nvdash', 'nvDash', 'nVDash'].map(name => '\\' + name);
  formulas.push('\\text{<br>}', '\\text{line<br/>tail}', '\\text{line<BR />tail}');
  for (const tex of formulas) {
    assert.doesNotThrow(() => renderMathML(tex), tex);
    for (const sep of ['\\n', '\\r\\n', '<br>', '\\<br>']) for (const container of CELL_CONTAINERS) {
      const body = 'flowchart LR\nA["$$' + tex + '$$"] --> B';
      const source = table(container('`mermaid' + sep + body.replaceAll('\n', sep) + '`').replaceAll('\n', '<br>'));
      const { tree } = render(source);
      assert.equal(find(tree, node => node.type === 'code' && node.lang === 'mermaid')?.value, body);
      const chart = table(container('`chart' + sep + 'title: $$' + tex + '$$' + sep + 'data:step1`').replaceAll('\n', '<br>'));
      const resolved = render(resolveChartData(chart, [[{ A: 'FOUND_ROW', B: 7 }]])).tree;
      const code = find(resolved, node => node.type === 'code' && node.lang === 'chart');
      assert.ok(code?.value.includes('title: $$' + tex + '$$'));
      assert.ok(code?.value.includes('FOUND_ROW'));
    }
  }
});
