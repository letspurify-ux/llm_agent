import assert from 'node:assert/strict';
import { MIXED_FORMULAS } from '../mixed-content-corpus.js';

export async function checkMixedContent(page, root = '.bubble.assistant') {
  const got = await page.eval(`(() => {
    const b = document.querySelector(${JSON.stringify(root)});
    const tables = [...b.querySelectorAll('table')];
    return {
      formulas: [...b.querySelectorAll('annotation')].map(e => e.textContent.trim()),
      errors: b.querySelectorAll('.math-error').length,
      nested: !!b.querySelector('ol > li > ul > li > blockquote table'),
      cells: tables.map(t => [...t.querySelectorAll('tbody tr')].map(r => r.cells.length)),
      literals: ['$100, $200, ₩ 300', '$HOME', '오른쪽 보존', '복합 시작', '복합 끝'].map(s => b.textContent.includes(s)),
      code: b.querySelector('pre code.language-text')?.textContent,
      link: b.querySelector('a[href^="https://example.test/a"]')?.getAttribute('href'),
      footnotes: [...b.querySelectorAll('[data-footnote-ref], [data-footnote-backref]')]
        .map(a => b.contains(document.getElementById(a.getAttribute('href').slice(1)))),
      images: b.querySelectorAll('img').length,
      fetchedImages: performance.getEntriesByType('resource').filter(e => e.name.includes('__probe-pixel')).length,
      charts: b.querySelectorAll('figure.chart .recharts-bar-rectangle path').length,
      diagram: [...b.querySelectorAll('.mermaid .node text')].map(e => e.textContent.trim()),
      emptyMath: [...b.querySelectorAll('.katex-html')].filter(e => e.getBoundingClientRect().height <= 0).length,
      overflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - innerWidth,
    };
  })()`);
  assert.deepEqual(got.formulas, MIXED_FORMULAS);
  assert.equal(got.errors, 0);
  assert.ok(got.nested);
  assert.deepEqual(got.cells, [[3, 3], [2, 2]]);
  assert.ok(got.literals.every(Boolean));
  assert.ok(got.code.includes('$\\frac{a}{b}$') && got.code.includes('```chart'));
  assert.equal(got.link, 'https://example.test/a?q=$HOME');
  assert.deepEqual(got.footnotes, [true, true]);
  assert.equal(got.images, 0);
  assert.equal(got.fetchedImages, 0);
  assert.equal(got.charts, 2);
  assert.deepEqual(got.diagram, ['입력', '계산', '결과']);
  assert.equal(got.emptyMath, 0);
  assert.ok(got.overflow <= 1, `문서가 옆으로 넘침: ${got.overflow}px`);
}
