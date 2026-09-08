import assert from 'node:assert/strict';
import { TABLE_LINK_EXPECTED } from '../table-link-edge-corpus.js';

export async function checkTableLinks(page, selector = '.bubble.assistant') {
  await page.eval('document.fonts.ready.then(() => true)');
  const got = await page.eval(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)});
    const tables = [...root.querySelectorAll('table')].map(table => {
      const cells = [...table.querySelectorAll('tbody td')];
      table.scrollLeft = table.scrollWidth;
      const last = cells.at(-1)?.getBoundingClientRect(), box = table.getBoundingClientRect();
      const reachable = !!last && last.right <= box.right + 2 && last.left >= box.left - 2;
      table.scrollLeft = 0;
      return { columns: cells.length, marker: cells.at(-1)?.textContent,
        formulas: [...table.querySelectorAll('annotation')].map(e => e.textContent),
        links: [...table.querySelectorAll('a')].map(e => ({ href: e.getAttribute('href'), title: e.title })),
        painted: [...table.querySelectorAll('.katex-html')].every(e => e.getBoundingClientRect().height > 0), reachable };
    });
    return { tables, errors: root.querySelectorAll('.math-error').length,
      leaked: /llmmathplaceholder/i.test(root.textContent),
      overflow: document.documentElement.scrollWidth > innerWidth };
  })()`);
  assert.equal(got.tables.length, TABLE_LINK_EXPECTED.length);
  got.tables.forEach((actual, i) => {
    const c = TABLE_LINK_EXPECTED[i];
    assert.equal(actual.columns, 2, c.md); assert.equal(actual.marker, '보존');
    assert.deepEqual(actual.formulas, [c.tex], c.md);
    assert.deepEqual(actual.links, [{ href: c.href, title: '원래 제목' }], c.md);
    assert.ok(actual.painted && actual.reachable, c.md);
  });
  assert.equal(got.errors, 0); assert.equal(got.leaked, false); assert.equal(got.overflow, false);
}
