import assert from 'node:assert/strict';
import { EDGE_CASES } from '../valid-math-edge-corpus.js';

export async function checkValidEdges(page, selector = '.bubble.assistant') {
  const got = await page.eval(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)});
    const heads = [...root.querySelectorAll('h2')].filter(e => /^정상 예제 /.test(e.textContent));
    return {
      cases: heads.map((h, i) => {
        const r = document.createRange(); r.setStartAfter(h);
        if (heads[i + 1]) r.setEndBefore(heads[i + 1]); else r.setEnd(root, root.childNodes.length);
        const fragment = r.cloneContents();
        return { heading: h.textContent,
          formulas: [...fragment.querySelectorAll('annotation')].map(e => e.textContent),
          links: [...fragment.querySelectorAll('a')].map(e => ({ href: e.getAttribute('href'), title: e.title })),
          structure: ['blockquote', 'ol', 'ul', 'li'].map(tag => fragment.querySelectorAll(tag).length) };
      }),
      errors: root.querySelectorAll('.math-error').length,
      leak: root.textContent.includes('LLMMATHPLACEHOLDER'),
      empty: [...root.querySelectorAll('.katex-html')].filter(e => e.getBoundingClientRect().height <= 0).length,
      collisions: [...root.querySelectorAll('.katex-display .katex-html')].flatMap(e => {
        const tag = e.querySelector(':scope > .tag');
        if (!tag) return [];
        const bases = [...e.querySelectorAll(':scope > .base, :scope > .math-equation > .base')];
        const right = Math.max(...bases.map(b => b.getBoundingClientRect().right));
        const left = tag.getBoundingClientRect().left;
        return right > left - 3 ? [{ right, left, tex: e.parentElement.querySelector('annotation')?.textContent }] : [];
      }),
      overflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - innerWidth,
      ended: root.textContent.includes('정상 입력 검증 끝'),
    };
  })()`);
  assert.equal(got.cases.length, EDGE_CASES.length);
  const structure = { plain: [0, 0, 0, 0], quote: [1, 0, 0, 0], list: [0, 1, 0, 1], nested: [1, 1, 1, 2], quoteList: [1, 1, 0, 1] };
  got.cases.forEach((actual, i) => {
    const c = EDGE_CASES[i];
    assert.equal(actual.heading, `정상 예제 ${i + 1}`);
    assert.deepEqual(actual.formulas, [c.tex], c.name);
    assert.deepEqual(actual.links, c.href ? [{ href: c.href, title: '수식 제목' }] : [], c.name);
    assert.deepEqual(actual.structure, structure[c.name.split('/')[0]] ?? [0, 0, 0, 0], c.name);
  });
  assert.equal(got.errors, 0); assert.equal(got.leak, false); assert.equal(got.empty, 0);
  assert.deepEqual(got.collisions, [], '수식과 식 번호가 겹친다');
  assert.ok(got.ended); assert.ok(got.overflow <= 1, `페이지 가로 넘침 ${got.overflow}px`);
}
