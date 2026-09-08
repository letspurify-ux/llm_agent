import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '../src/math.js';
import { normalizeMath } from '../src/remark-preserve-math.js';
import { LATEX_200_CASES, LATEX_200_MARKDOWN } from './latex-table-200.js';

const descendants = (node, tag) => [
  ...(node.tagName === tag ? [node] : []),
  ...(node.children ?? []).flatMap(child => descendants(child, tag)),
];
const textOf = node => node.value ?? (node.children ?? []).map(textOf).join('');

test('200개 수식 표: 서로 다른 수식 200개와 실제 Markdown 파일을 검사한다', async () => {
  assert.equal(LATEX_200_CASES.length, 200);
  assert.equal(new Set(LATEX_200_CASES.map(row => row.tex)).size, 200);
  assert.equal(new Set(LATEX_200_CASES.map(row => row.id)).size, 200);
  const counts = new Map();
  for (const row of LATEX_200_CASES) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  assert.equal(counts.size, 20);
  assert.ok([...counts.values()].every(count => count === 10));
  assert.equal(await readFile(new URL('./fixtures/latex-table-200.md', import.meta.url), 'utf8'), LATEX_200_MARKDOWN);
  assert.equal(normalizeMath('₩forall x,₩ x^2'), String.raw`\forall x,\ x^2`);
  assert.equal(normalizeMath('가격 ₩ 100, ￦ 200'), '가격 ₩ 100, ￦ 200');
});

test('200개 수식 표: 실제 Markdown 렌더에서 200/200 수식과 800개 셀이 보존된다', () => {
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS,
  }, LATEX_200_MARKDOWN));
  assert.doesNotMatch(html, /math-error|katex-error|LLMMATHPLACEHOLDER/);
  const tree = fromHtmlIsomorphic(html, { fragment: true });
  const tables = descendants(tree, 'table');
  assert.equal(tables.length, 1);
  assert.equal(descendants(tree, 'annotation').length, 200);
  assert.equal(descendants(tree, 'td').length, 800);
  const rows = descendants(descendants(tables[0], 'tbody')[0], 'tr');
  assert.equal(rows.length, 200);
  for (const [index, row] of rows.entries()) {
    const expected = LATEX_200_CASES[index];
    const cells = descendants(row, 'td');
    assert.equal(cells.length, 4, expected.id);
    assert.equal(textOf(cells[0]), expected.id);
    assert.equal(textOf(cells[1]), expected.category);
    assert.equal(textOf(cells[3]), expected.marker, `행 ${expected.id} 마지막 열이 잘렸다`);
    const formulas = descendants(cells[2], 'annotation');
    assert.equal(formulas.length, 1, `행 ${expected.id} 수식이 빠지거나 쪼개졌다`);
    assert.equal(textOf(formulas[0]), expected.tex, `행 ${expected.id} 수식 원문이 바뀌었다`);
  }
});
