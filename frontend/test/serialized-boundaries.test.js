import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '../src/math.js';
import { PreviewPre } from '../src/preview.js';
import { resolveChartData } from '../../backend/src/chart.js';
import { answerSyntax } from '../../backend/src/markdown-syntax.js';
import { MIXED_WRAPPERS } from './mixed-content-corpus.js';
import { SERIALIZED_ATOMS, SERIALIZED_HEADERS, serializedBoundaryTable } from './serialized-boundaries-corpus.js';
import { texGroupEnds } from '../../shared/tex-environments.mjs';
import { closingMathDelimiter } from '../../shared/math-spans.mjs';

const steps = [[{ LABEL: 'FOUND_ROW | $literal$', VALUE: 7 }]];
const render = (source, preview = false) => renderToStaticMarkup(React.createElement(Markdown, {
  remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS, components: preview ? { pre: PreviewPre } : {},
}, source));
const intact = (html, atom) => {
  for (const end of ['OPEN_END', 'MATH_END', 'QUERY_END', 'DIAGRAM_END', 'CLOSE_END'])
    assert.ok(html.includes('<td>' + end + '</td>'), end + ': ' + html);
  assert.ok(html.includes('application/x-tex">z^2</annotation>'), html);
  assert.ok(html.includes(String.raw`| FOUND_ROW \| \$literal\$ | 7 |`) && html.includes('language-mermaid'), html);
  assert.equal((html.match(/class="math-error/g) ?? []).length, atom.error ? 1 : 0, html);
  assert.doesNotMatch(html, /LLMRICHTABLE|LLMMATHPLACEHOLDER|LLMCELLNODE/);
};

test('직렬화 표의 원자는 새 행의 수식·차트·그림을 소유하지 않는다: 1,600개 경계 조합', () => {
  for (const atom of SERIALIZED_ATOMS) for (const header of SERIALIZED_HEADERS)
    for (const wrap of Object.values(MIXED_WRAPPERS))
      for (const edges of [[true, true], [false, false], [true, false], [false, true]]) {
        const canonical = wrap(serializedBoundaryTable(atom, { header, edges }));
        const resolved = resolveChartData(canonical, steps);
        const expected = render(resolved);
        intact(expected, atom);
        for (const newline of ['\\n', '\\r\\n']) {
          const source = canonical.replaceAll('\n', newline);
          assert.equal(answerSyntax(source, { serialized: true }).source, canonical, source);
          const actual = resolveChartData(source, steps);
          assert.equal(actual, resolved, source);
          assert.equal(render(actual), expected, source);
          assert.equal(render(actual, true), render(resolved, true), source);
        }
      }
});

test('TeX 제어 단어·사용자 매크로의 n은 문서 개행으로 유출되지 않는다', () => {
  const formulas = [String.raw`x\nleqq y\nVdash z`, String.raw`\newcommand{\n}{x}\n`,
    String.raw`\newcommand{\nMATH}{x}\nMATH`, String.raw`\text{a\n b}`,
    String.raw`a\nless b\nexists c\nsim d`, String.raw`\nabla f\notin A`,
    String.raw`\text{a\n | b}`, String.raw`\text{a\n|b}`];
  for (const tex of formulas) for (const column of [0, 1, 2]) for (const width of [1, 3])
    for (const wrap of Object.values(MIXED_WRAPPERS)) for (const newline of ['\\n', '\\r\\n']) {
      if (column >= width) continue;
      const cells = Array(width).fill('TEXT'); cells[column] = '$' + tex + '$';
      const source = wrap(['| ' + Array(width).fill('H').join(' | ') + ' |',
        '| ' + Array(width).fill('---').join(' | ') + ' |', '| ' + cells.join(' | ') + ' |'].join('\n'));
      const encoded = source.replaceAll('\n', newline);
      assert.equal(answerSyntax(encoded, { serialized: true }).source, source, encoded);
      assert.equal(render(encoded), render(source), encoded);
    }
});

test('직렬화 표 예시를 소유한 코드·링크·이미지는 바깥 문서 구조로 승격되지 않는다', () => {
  const body = 'H | M\\n--- | ---\\nA | `chart\\ndata:step1`';
  for (const wrap of [s => '`` ' + s + ' ``', s => '[' + s + '](https://example.test)',
    s => '![' + s + '](https://example.test)']) for (const prefix of ['', '예시 ']) {
    const source = prefix + wrap(body);
    assert.equal(answerSyntax(source, { serialized: true }).source, source);
    assert.equal(resolveChartData(source, steps), source);
    assert.doesNotMatch(render(source), /<table>|language-chart|FOUND_ROW/);
  }
});

test('직렬화된 뒤 행을 수신하는 모든 접두사에서 완성된 앞 행의 원문을 보존한다', () => {
  for (const atom of SERIALIZED_ATOMS) {
    const table = serializedBoundaryTable(atom).split('\n');
    const first = table.slice(0, -1).join('\\n') + '\\n';
    const tail = table.at(-1);
    for (let end = 0; end <= tail.length; end++) {
      const source = first + tail.slice(0, end);
      const html = render(resolveChartData(source, steps), true);
      for (const marker of ['OPEN_END', 'MATH_END', 'QUERY_END', 'DIAGRAM_END'])
        assert.ok(html.includes('<td>' + marker + '</td>'), source);
      assert.ok(html.includes('application/x-tex">z^2</annotation>'), source);
      assert.doesNotMatch(html, /LLMRICHTABLE|LLMMATHPLACEHOLDER|LLMCELLNODE/);
    }
  }
});

test('직렬화·Mermaid의 TeX 그룹 인덱스는 본문 구분자와 같고 미완성 입력에서도 비용이 제한된다', () => {
  for (const source of [String.raw`{a{b}c}`, String.raw`{a\{b\}c}`, String.raw`\verb|{x}|{y}`,
    '{x% } comment\n{y}}', String.raw`{{{x}y`, String.raw`\{x\}{y}`, String.raw`{}{{}}`]) {
    for (const [start, end] of texGroupEnds(source))
      assert.equal(end, closingMathDelimiter(source, start + 1, '}'), source);
  }
  const start = performance.now();
  assert.equal(texGroupEnds('{'.repeat(70_000)).size, 0);
  assert.ok(performance.now() - start < 1000, '미완성 중괄호마다 본문을 다시 탐색한다');
});
