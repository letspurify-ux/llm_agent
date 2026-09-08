import assert from 'node:assert/strict';
import { LATEX_200_CASES } from '../latex-table-200.js';

// 개발 UI와 배포 번들에서 동일한 200행을 전수 검사한다. 렌더 개수만 세지 않고 셀별 원문·조판 영역도 확인한다.
export async function checkLatex200(page, root = '.bubble.assistant') {
  const result = await page.eval(`(() => {
    const parent = document.querySelector(${JSON.stringify(root)});
    const table = [...parent.querySelectorAll('table')].find(t => t.querySelectorAll('tbody tr').length === 200);
    if (!table) return { missing: true };
    const rows = [...table.querySelectorAll('tbody tr')].map(row => {
      const cell = row.children[2];
      const visual = cell?.querySelector('.katex-html');
      const rect = visual?.getBoundingClientRect();
      const cellRect = cell?.getBoundingClientRect();
      const bases = [...(visual?.querySelectorAll('.base,.tag') ?? [])].map(e => e.getBoundingClientRect());
      return { id: row.children[0]?.textContent, category: row.children[1]?.textContent,
        marker: row.children[3]?.textContent, columns: row.children.length,
        formulas: [...row.querySelectorAll('annotation')].map(e => e.textContent),
        painted: !!rect && rect.width > 0 && rect.height > 0 && getComputedStyle(visual).visibility !== 'hidden',
        verticalFit: bases.every(r => r.top >= cellRect.top - 2 && r.bottom <= cellRect.bottom + 2) };
    });
    const errors = table.querySelectorAll('.math-error,.katex-error').length;
    table.scrollLeft = table.scrollWidth;
    const last = table.querySelector('tbody tr td:last-child').getBoundingClientRect();
    const bounds = table.getBoundingClientRect();
    const lastColumnReachable = last.right <= bounds.right + 2 && last.left >= bounds.left - 2;
    table.scrollLeft = 0;
    return { rows, errors, lastColumnReachable, overflow: document.documentElement.scrollWidth > innerWidth };
  })()`);
  assert.ok(!result.missing, '200행 표를 찾지 못했다');
  assert.equal(result.errors, 0);
  assert.equal(result.rows.length, 200);
  for (const [index, actual] of result.rows.entries()) {
    const expected = LATEX_200_CASES[index];
    assert.equal(actual.columns, 4, expected.id);
    assert.equal(actual.id, expected.id);
    assert.equal(actual.category, expected.category);
    assert.equal(actual.marker, expected.marker);
    assert.deepEqual(actual.formulas, [expected.tex], `행 ${expected.id}: ${expected.tex}`);
    assert.ok(actual.painted, `행 ${expected.id}의 실제 수식 표시 영역이 없다`);
    assert.ok(actual.verticalFit, `행 ${expected.id} 수식이 셀의 위아래를 벗어난다`);
  }
  assert.ok(result.lastColumnReachable, '표의 마지막 열에 가로 스크롤로 접근할 수 없다');
  assert.ok(!result.overflow, '표가 페이지 자체를 가로로 밀어냈다');
}
