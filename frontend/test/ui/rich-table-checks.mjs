import assert from 'node:assert/strict';
import { QUADRATIC, MEAN } from '../rich-table-corpus.js';

export async function checkRichTables(page) {
  const got = await page.eval(`(() => {
    const b = document.querySelector('.bubble.assistant');
    const tables = [...b.querySelectorAll('.md > table')];
    const size = e => e ? { w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height } : null;
    return {
      cells: tables.map(t => [...t.tBodies[0].rows].map(r => r.cells.length)),
      unordered: [...tables[0].querySelectorAll('ul li')].map(e => e.textContent),
      ordered: [...tables[0].querySelectorAll('ol li')].map(e => e.textContent),
      literalBr: tables[0].innerText.includes('<br>'),
      chart: b.querySelectorAll('.rich-cell figure.chart').length,
      bars: b.querySelectorAll('.rich-cell .recharts-bar-rectangle path').length,
      diagrams: b.querySelectorAll('.rich-cell .mermaid svg').length,
      standalone: b.querySelectorAll('.md > .mermaid svg').length,
      compound: tables[2].rows[1].cells[1].querySelectorAll('.katex, strong, ol, blockquote').length,
      quote: b.querySelector('.md > blockquote')?.textContent.trim(),
      math: size(b.querySelector('.rich-cell .mermaid math')),
      chartSize: size(b.querySelector('.rich-cell .recharts-wrapper')),
      formulas: [...b.querySelectorAll('annotation')].map(e => e.textContent),
      errors: b.querySelectorAll('.math-error').length,
      neighbors: ['흐름 이웃', '차트 이웃', '오류 이웃', '수식 이웃', '검증 끝'].every(t => b.textContent.includes(t)),
      emptyData: b.textContent.includes('자료 없는 차트') && b.textContent.includes('표시할 데이터가 없습니다'),
      code: [...b.querySelectorAll('code')].some(e => e.textContent === '<br>'),
      overflow: document.documentElement.scrollWidth - innerWidth,
      images: b.querySelectorAll('img').length,
    };
  })()`);
  assert.deepEqual(got.cells, [[2, 2], [3, 3, 3, 3], [2, 2, 2]]);
  assert.deepEqual(got.unordered, ['매출 비교', '증감률 계산', '결과 표시']);
  assert.deepEqual(got.ordered, ['데이터 수집', '수식 계산', '결과 저장']);
  assert.equal(got.literalBr, false);
  assert.equal(got.chart, 2);
  assert.equal(got.bars, 4);
  assert.equal(got.diagrams, 3);
  assert.equal(got.standalone, 1);
  assert.equal(got.compound, 4);
  assert.equal(got.quote, '표 밖의 주의사항도 인용문으로 표시합니다.');
  assert.ok(got.math?.w > 0 && got.math?.h > 0, 'Mermaid 내부 수식이 비어 있다');
  assert.ok(got.chartSize?.w > 100 && got.chartSize?.h > 100, '표 안 차트 영역이 사라졌다');
  assert.ok(got.formulas.includes(QUADRATIC));
  assert.ok(got.formulas.includes(MEAN));
  assert.ok(got.formulas.includes('a\\ne0'));
  assert.equal(got.errors, 0);
  assert.ok(got.neighbors && got.emptyData && got.code);
  assert.ok(got.overflow <= 1);
  assert.equal(got.images, 0);
}
