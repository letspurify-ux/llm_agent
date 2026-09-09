// 검토용 실제 앱 검사. --production은 현재 소스를 새로 빌드해 검사한다.
// 실행: node frontend/test/review/rendering-browser.mjs --production
// 결과 JSON은 stdout, 실패 재현 시 종료 코드 1. 실제 DB/LLM 접속은 없다.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, chromePort, stopProcess, killOnExit, freePort, oneTab, Page, sleep } from '../ui/driver.mjs';
import { resolveChartData, resolveTableData } from '../../../backend/src/chart.js';
import { NESTED_BOUNDARY_ANSWER, NESTED_LITERAL_MATH } from '../nested-boundaries-corpus.js';
import { CELL_BLOCKS_ANSWER, CELL_CHART, CELL_LITERAL_ANSWER } from '../cell-blocks-corpus.js';
import { MERMAID_MATH_CASES, MERMAID_MULTILINE_MATH, MERMAID_NATIVE_MATH_CASES } from '../mermaid-math-corpus.js';
import { STRUCTURE_HEADERS, STRUCTURE_URL, STRUCTURE_DEFINITION, structureTable } from '../rich-table-structure-corpus.js';
import { MIXED_WRAPPERS } from '../mixed-content-corpus.js';
import { SERIALIZED_ATOMS, serializedBoundaryTable } from '../serialized-boundaries-corpus.js';
import { CELL_ATOMS, cellOwnershipTable } from '../cell-ownership-corpus.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VITE = join(ROOT, 'node_modules/vite/bin/vite.js');
const production = process.argv.includes('--production');
const serializedTable = [
  '| 항목 | 내용 | 끝 |', '|---|---|---|',
  '| 수식 | $z=9$ | SERIALIZED_MATH_END |',
  '| [LINK](https://example.test/`) | `mermaid<br>flowchart LR<br>A["$$x^2$$"] -->|label| B` | SERIALIZED_DIAGRAM_END |',
  '| 조회 | `chart<br>type:bar<br>data:step1` | SERIALIZED_CHART_END |',
].join('\\r\\n');
const literalChart = '`chart<br>data:step1`';
const cases = [
  { id: 'serialized-control-words', group: 'serialized-boundaries',
    // 목록 안의 '- | -'는 GFM에서도 하위 목록이다. 구분 행 앞에 |를
    // 명시해 실제 표에서 짧은 구분 행과 영문 첫 셀의 개행 복원을 확인한다.
    answer: MIXED_WRAPPERS.quoteList(['L | R', '| - | - |',
      'u | `mermaid\\nflowchart LR\\nu["$$x^2$$"] --> v`',
      'eq | `mermaid\\nflowchart LR\\neq["$$x^2$$"] --> done`',
      'ot | `chart\\ntype:bar\\nLABEL | VALUE\\n--- | ---\\nu | 7`'].join('\n')).replaceAll('\n', '\\n'),
    expected: { charts: 1, diagrams: 2, tables: 2, mermaidMath: 2, errors: 0,
      formulas: [], cellVisualsSized: true, diagramLabelWidthsFit: true, diagramMathSized: true } },
  ...CELL_ATOMS.map(atom => ({
    id: 'cell-ownership-' + atom.id, group: 'serialized-boundaries',
    answer: resolveChartData(MIXED_WRAPPERS.quoteList(cellOwnershipTable(atom, { header: '$|h|$' }))
      .replaceAll('\n', '\\r\\n'), [[{ A: 'FOUND_ROW | 원문', B: 7 }]]).replaceAll('\n', '\\n'),
    expected: { charts: 1, diagrams: 1, tables: 2, mermaidMath: 1, errors: atom.error ? 1 : 0,
      formulas: ['|h|', 'z^2'], foundRow: true, cellVisualsSized: true, cellOwnershipIntact: true,
      structureEndsReachable: true, diagramLabelWidthsFit: true, diagramMathSized: true,
      ...(atom.error && { errorSources: [atom.open] }) },
  })),
  ...SERIALIZED_ATOMS.map(atom => ({
    id: 'serialized-boundary-' + atom.id, group: 'serialized-boundaries',
    answer: resolveChartData(MIXED_WRAPPERS.quoteList(serializedBoundaryTable(atom, { header: '$|h|$' }))
      .replaceAll('\n', '\\r\\n'), [[{ A: 'FOUND_ROW | 원문', B: 7 }]]).replaceAll('\n', '\\n'),
    expected: { charts: 1, diagrams: 1, tables: 2, mermaidMath: 1, errors: atom.error ? 1 : 0,
      formulas: ['|h|', 'z^2'], foundRow: true, cellVisualsSized: true, serializedOwnershipIntact: true,
      structureEndsReachable: true, diagramLabelWidthsFit: true, diagramMathSized: true,
      ...(atom.error && { errorSources: [atom.open] }) },
  })),
  ...STRUCTURE_HEADERS.map(header => ({
    id: 'table-structure-' + header.id,
    answer: resolveChartData(MIXED_WRAPPERS.quoteList(structureTable(header.source)) + STRUCTURE_DEFINITION,
      [[{ A: 'FOUND_ROW', B: 7 }]]),
    expected: { charts: header.chart ? 2 : 1, diagrams: header.diagram ? 2 : 1,
      tables: header.chart ? 3 : 2, mermaidMath: header.diagram ? 2 : 1,
      errors: header.error ? 1 : 0, formulas: [...(header.math && !header.error ? [header.math] : []), 'z^2'],
      foundRow: true, cellVisualsSized: true, structureIntact: true, structureLink: true,
      structureEndsReachable: true, diagramLabelWidthsFit: true, diagramMathSized: true,
      headerDiagrams: header.diagram ? 1 : 0, headerCharts: header.chart ? 1 : 0 },
  })),
  ...[...MERMAID_MATH_CASES, ...MERMAID_NATIVE_MATH_CASES].map(({ id, source, nodes, label, bold, href, accessibleTitle, mathText, fractions, mathCount = 1,
    errors = 0, errorSources }) => ({
    id: 'mermaid-mixed-' + id,
    answer: '> 1. 혼합\n>\n' + ['| L | M | R |', '|---|---|---|',
      '| $z=9$ | 앞<br>- ```mermaid\\n' + source.replaceAll('\n', '\\n') + '``` | RIGHT |']
      .map(line => '>    ' + line).join('\n'),
    expected: { diagrams: 1, mermaidMath: mathCount, errors, formulas: ['z=9'],
      ...(nodes !== undefined && { diagramNodes: nodes }), diagramMathSized: true, diagramNested: true,
      diagramMarkerAligned: true,
      ...(label && { diagramLabel: true }), ...(bold && { diagramBold: true }),
      ...(href && { diagramHref: href }), ...(accessibleTitle && { diagramAccessibleTitle: accessibleTitle }),
      ...(mathText && { diagramMathText: mathText }), ...(fractions && { diagramFractions: fractions }),
      ...(errorSources && { errorSources }) },
    label,
  })),
  ...['\n', '\r\n', '\r'].map((newline, index) => ({
    id: 'mermaid-multiline-' + index,
    answer: ('본문 $z=9$\n\n> 1. 여러 줄 수식\n>\n' +
      ('```mermaid\nflowchart LR\nA["$$' + MERMAID_MULTILINE_MATH + '$$"] --> B\n```')
        .split('\n').map(line => '>    ' + line).join('\n')).replaceAll('\n', newline),
    expected: { diagrams: 1, mermaidMath: 1, errors: 0, formulas: ['z=9'],
      diagramNodes: 2, diagramMathSized: true, diagramFractions: 1 },
  })),
  { id: 'cell-literal-block-markers', answer: CELL_LITERAL_ANSWER,
    expected: { charts: 1, diagrams: 1, tables: 2, mermaidMath: 1, errors: 0, formulas: ['z=9'],
      foundRow: true, cellLiteralsIntact: true, cellEndsReachable: true, cellVisualsSized: true } },
  { id: 'serialized-mermaid-tex-commands', answer: '| 내용 |\n|---|\n| `mermaid\\nflowchart LR\\nA["$$x\\nleqq y\\nVdash z$$"] --> B` |',
    expected: { diagrams: 1, mermaidMath: 1, errors: 0, cellVisualsSized: true } },
  { id: 'serialized-mermaid-tex-br', answer: '| 내용 |\n|---|\n| `mermaid<br>flowchart LR<br>A["$$\\text{a<br>b}$$"] --> B` |',
    expected: { diagrams: 1, mermaidMath: 1, errors: 0, cellVisualsSized: true, mathLiteralBreak: true } },
  { id: 'nested-cell-blocks', answer: CELL_BLOCKS_ANSWER,
    expected: { charts: 1, diagrams: 1, tables: 2, mermaidMath: 1, errors: 0, formulas: ['z=9'],
      foundRow: true, cellEnds: 4, cellHierarchy: true, cellVisualsSized: true } },
  { id: 'optional-table-edges', answer: resolveChartData(
    ['L | M | R', '--- | --- | ---', CELL_CHART + ' | $z=9$ | ' + CELL_CHART].join('\\r\\n'), [[{ A: 'FOUND_ROW', B: 7 }]]),
    expected: { charts: 2, tables: 3, errors: 0, formulas: ['z=9'], foundRow: true, cellVisualsSized: true } },
  { id: 'serialized-table-pipes', answer: resolveChartData(serializedTable, [[{ A: 'FOUND_ROW', B: 7 }]]),
    expected: { charts: 1, diagrams: 1, tables: 2, mermaidMath: 1, errors: 0,
      formulas: ['z=9'], foundRow: true, serializedEnds: 3 } },
  { id: 'math-footnote-chart-ownership', answer: resolveChartData(
    `| 내용 | 끝 |\n|---|---|\n| $\\text{${literalChart}}$ | MATH_END |\n| [^${literalChart}] | NOTE_END |\n` +
    `\n[^${literalChart}]: FOOTNOTE_CONTENT $z^2$\n\n${literalChart}`, [[{ A: 'FOUND_ROW', B: 7 }]]),
    expected: { charts: 1, diagrams: 0, tables: 2, errors: 0, footnotes: 1, footnoteContent: true,
      formulas: [`\\text{${literalChart}}`, 'z^2'], foundRow: true } },
  { id: 'varied-container-fences', answer: resolveTableData(resolveChartData(
    '- > ```chart\n  >type:bar\n  >data:step1\n  > ```\n\n본문[^1]\n\n[^1]: ```table\n    step:1\n    ```',
    [[{ A: 'FOUND_ROW', B: 7 }]]), [[{ A: 'FOUND_ROW', B: 7 }]]),
    expected: { charts: 1, tables: 2, errors: 0, footnotes: 1, foundRow: true } },
  { id: 'nested-syntax-boundaries', answer: NESTED_BOUNDARY_ANSWER,
    expected: { charts: 1, diagrams: 1, tables: 2, mermaidMath: 1, errors: 0,
      formulas: [NESTED_LITERAL_MATH, 'z=9'], foundRow: true, boundaryEnds: 5 } },
  { id: 'normal-mixed', answer: '본문 $x=1$\n\n```chart\ntype: bar\n| A | B |\n|---|---|\n| a | 1 |\n```\n\n```mermaid\nflowchart LR\n A --> B\n```',
    expected: { charts: 1, diagrams: 1, formulas: ['x=1'], errors: 0 } },
  { id: 'unclosed-math-cross-blocks', answer: '\\[x=1\n\n```chart\ntype: bar\n| A | B |\n|---|---|\n| a | 1 |\n```\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n\\[y=2\\]\n\nEND',
    expected: { charts: 1, diagrams: 1, formulas: ['y=2'] } },
  { id: 'quoted-chart-data', answer: resolveChartData('본문 $x=1$\n\n> ```chart\n> type: bar\n> data: step 1\n> ```\n\nEND', [[{ A: 'FOUND_ROW', B: 1 }]]),
    expected: { charts: 1, formulas: ['x=1'] } },
  { id: 'quoted-table-data', answer: resolveTableData('본문 $x=1$\n\n> ```table\n> step: 1\n> ```\n\nEND', [[{ A: 'FOUND_ROW', B: 1 }]]),
    expected: { tables: 1, foundRow: true, formulas: ['x=1'] } },
  { id: 'table-cell-chart-data', answer: resolveChartData('| 항목 | 상세 |\n|---|---|\n| 조회 | `chart<br>type: bar<br>data: step 1` |',
    [[{ A: 'FOUND_ROW | 원문', B: 1 }, { A: '다음 값', B: 2 }]]),
    expected: { charts: 1, tables: 2, foundRow: true } },
  { id: 'standalone-chart-data', answer: resolveChartData('`chart\\ntype: bar\\ndata: step 1`', [[{ A: 'FOUND_ROW', B: 1 }]]),
    expected: { charts: 1, foundRow: true } },
  { id: 'flowchart-math', answer: '본문 $x^2$\n\n```mermaid\nflowchart LR\n A["$$x^2$$"] --> B[완료]\n```',
    expected: { diagrams: 1, mermaidMath: 1, formulas: ['x^2'] } },
  { id: 'sequence-math-control', answer: '```mermaid\nsequenceDiagram\n A->>B: $$\\frac{1}{2}$$\n```',
    expected: { diagrams: 1, mermaidMath: 1 } },
  { id: 'footnote-math-id', answer: '본문 [^$x$]와 $y$.\n\n[^$x$]: FOOTNOTE_CONTENT',
    expected: { footnotes: 1, footnoteContent: true, formulas: ['y'] } },
  { id: 'adjacent-inline-dollars', answer: '$x$$y$', expected: { formulas: ['x', 'y'] } },
];

if (production) await promisify(execFile)(process.execPath, [VITE, 'build'], { cwd: ROOT, timeout: 60_000 });
const port = await freePort();
const profile = await mkdtemp(join(tmpdir(), 'render-review-chrome-'));
let chrome, page;
const vite = spawn(process.execPath, [VITE, ...(production ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
killOnExit(() => [{ proc: chrome, group: true }, { proc: vite }]);
try {
  const url = `http://127.0.0.1:${port}/`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    assert.equal(vite.exitCode, null, 'Vite가 종료됐다');
    try { ready = (await fetch(url)).ok; } catch {}
    if (ready) break;
    await sleep(100);
  }
  assert.ok(ready, 'Vite 시작 실패');
  chrome = launchChrome({ bin: await findChrome({ required: true }), profile });
  page = await Page.open((await oneTab(await chromePort(profile))).webSocketDebuggerUrl);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const originalFetch = window.fetch.bind(window);
    window.fetch = (url, opts) => url === '/api/chat'
      ? Promise.resolve(new Response(JSON.stringify({ answer: window.__reviewAnswer }), { headers: { 'Content-Type': 'application/json' } }))
      : originalFetch(url, opts);
  ` });
  const results = [];
  const selectedCase = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
  const selectedGroup = process.argv.find(arg => arg.startsWith('--group='))?.slice(8) ?? 'core';
  if (selectedCase) assert.ok(cases.some(item => item.id === selectedCase), '존재하지 않는 브라우저 검사 사례');
  else assert.ok(cases.some(item => (item.group ?? 'core') === selectedGroup), '존재하지 않는 브라우저 검사 그룹');
  const selected = cases.filter(item => selectedCase ? item.id === selectedCase : (item.group ?? 'core') === selectedGroup);
  for (const { id, answer, expected, label } of selected) for (const width of [1000, 320]) {
    await page.viewport(width, 760);
    await page.goto(url, '.chip');
    await page.eval(`window.__reviewAnswer=${JSON.stringify(answer)};document.querySelector('.chip').click()`);
    await page.until(`document.querySelector('.bubble.assistant') && !document.querySelector('.typing')`);
    // 다른 셀의 수식 오류는 비동기 그림의 완료 신호가 아니다. 필요한 그림이
    // 모두 게시된 뒤 크기·내용을 판정하고, 실패하면 아래 진단에 원문을 남긴다.
    if (expected.diagrams) await page.until(`document.querySelectorAll('.mermaid svg').length === ${expected.diagrams}`)
      .catch(async error => {
        const state = await page.eval(`({ visibility: document.visibilityState,
          text: document.querySelector('.bubble.assistant')?.innerText,
          codes: [...document.querySelectorAll('.bubble.assistant pre code')].map(node => node.textContent),
          diagrams: document.querySelectorAll('.mermaid svg').length,
          charts: document.querySelectorAll('figure.chart .recharts-surface').length })`).catch(() => null);
        throw new Error(`${id}/${width}: ${error.message}\n${JSON.stringify({ state, logs: page.logs })}`);
      });
    // production의 지연 로딩 동안에는 데이터 표만 먼저 표시된다.
    if (expected.charts) await page.until(`document.querySelectorAll('figure.chart .recharts-surface').length === ${expected.charts}`);
    await page.eval('document.fonts.ready.then(() => true)');
    const actual = await page.eval(`(() => {
      const b = document.querySelector('.bubble.assistant');
      const literalCell = label => [...b.querySelectorAll('tr')].find(row => row.cells[0]?.textContent === label)?.cells[1];
      const cellEndsReachable = () => {
        const table = literalCell('ESCAPE')?.closest('table');
        if (!table) return false;
        const left = table.scrollLeft;
        table.scrollLeft = table.scrollWidth;
        const box = table.getBoundingClientRect();
        const visible = [...table.tBodies[0].rows].every(row => {
          const end = row.cells[2].getBoundingClientRect();
          return end.left >= box.left - 1 && end.right <= box.right + 1;
        });
        table.scrollLeft = left;
        return visible;
      };
      const outerTable = b.querySelector('blockquote > ol table');
      const structureEndsReachable = () => {
        if (!outerTable?.tBodies[0]) return false;
        const left = outerTable.scrollLeft;
        outerTable.scrollLeft = outerTable.scrollWidth;
        const box = outerTable.getBoundingClientRect();
        const visible = [...outerTable.tBodies[0].rows].every(row => {
          const end = row.cells[row.cells.length - 1]?.getBoundingClientRect();
          return end && end.left >= box.left - 1 && end.right <= box.right + 1;
        });
        outerTable.scrollLeft = left;
        return visible;
      };
      return {
        text: b.innerText,
        charts: b.querySelectorAll('figure.chart .recharts-surface').length,
        diagrams: b.querySelectorAll('.mermaid svg').length,
        tables: b.querySelectorAll('table').length,
        errors: b.querySelectorAll('.math-error').length,
        errorSources: [...b.querySelectorAll('.math-error pre code')].map(node => node.textContent),
        formulas: [...b.querySelectorAll('annotation')].map(e => e.textContent),
        mermaidMath: b.querySelectorAll('.mermaid math').length,
        diagramNodes: b.querySelectorAll('.mermaid g.node').length,
        diagramLabel: [...b.querySelectorAll('.mermaid .nodeLabel')].some(e => e.textContent.includes(${JSON.stringify(label ?? '')})),
        diagramBold: [...b.querySelectorAll('.mermaid strong')].some(e => e.textContent === '수식'),
        diagramHref: b.querySelector('.mermaid a')?.getAttribute('href'),
        diagramAccessibleTitle: b.querySelector('.mermaid svg > title')?.textContent,
        diagramMathText: [...b.querySelectorAll('.mermaid mtext')].map(node => node.textContent).join(''),
        diagramFractions: b.querySelectorAll('.mermaid mfrac').length,
        diagramNested: !!b.querySelector('blockquote > ol .rich-cell > ul > li .mermaid svg') &&
          [...b.querySelectorAll('td')].some(e => e.textContent === 'RIGHT'),
        diagramMathSized: [...b.querySelectorAll('.mermaid math')].every(e => {
          const r = e.getBoundingClientRect();
          return r.width > 5 && r.height > 9 && e.querySelector('msup')?.textContent === 'x2';
        }),
        mathLiteralBreak: [...b.querySelectorAll('.mermaid mtext')].some(e => e.textContent === 'a<br>b'),
        footnotes: b.querySelectorAll('[data-footnote-ref]').length,
        footnoteContent: b.textContent.includes('FOOTNOTE_CONTENT'),
        foundRow: b.textContent.includes('FOUND_ROW'),
        boundaryEnds: ['DIAGRAM_END', 'CHART_END', 'CODE_END', 'MATH_END', 'LINK_END'].filter(s => b.textContent.includes(s)).length,
        serializedEnds: ['SERIALIZED_MATH_END', 'SERIALIZED_DIAGRAM_END', 'SERIALIZED_CHART_END'].filter(s => b.textContent.includes(s)).length,
        cellEnds: ['CELL_MATH_END', 'CELL_DIAGRAM_END', 'CELL_CHART_END', 'CELL_TASK_END'].filter(s => b.textContent.includes(s)).length,
        cellHierarchy: !!b.querySelector('.rich-cell > ul > li > ul > li annotation') &&
          !!b.querySelector('.rich-cell > blockquote > ul > li > ol > li .mermaid svg') &&
          !!b.querySelector('.rich-cell > ol > li > blockquote > ul > li figure.chart .recharts-surface') &&
          b.querySelectorAll('.rich-cell ul ul input[type=checkbox]').length === 1,
        cellLiteralsIntact: ['ESCAPE', 'ENTITY', 'GRAPH', 'QUERY'].every(label => {
          const cell = literalCell(label);
          return cell && ![...cell.querySelectorAll('ul, ol, blockquote, h1, h2, h3, input')]
            .some(node => !node.closest('figure.chart, .mermaid')) &&
            cell.parentElement.cells[2]?.textContent === label + '_END';
        }) && literalCell('ESCAPE')?.textContent.includes('- 목록 문자') &&
          literalCell('ESCAPE')?.textContent.includes('1. 번호 문자') &&
          literalCell('ENTITY')?.textContent.includes('> 인용 문자') &&
          literalCell('TASK')?.textContent.includes('[x] 작업 문자') &&
          literalCell('TASK')?.querySelectorAll('input:checked').length === 1,
        cellVisualsSized: [...b.querySelectorAll('.rich-cell .recharts-surface, .rich-cell .mermaid svg')]
          .every(e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 20; }),
        cellEndsReachable: cellEndsReachable(),
        structureIntact: outerTable?.tHead?.rows[0]?.cells.length === 3 &&
          outerTable.tBodies[0]?.rows.length === 4 && [...outerTable.tBodies[0].rows].every((row, i) =>
            row.cells.length === 3 && row.cells[2].textContent === ['MATH_END', 'DIAGRAM_END', 'QUERY_END', 'LINK_END'][i]) &&
          !!outerTable.querySelector('td > blockquote > ul .chart') && !!outerTable.querySelector('td > ul .mermaid'),
        serializedOwnershipIntact: outerTable?.tHead?.rows[0]?.cells.length === 3 &&
          outerTable.tBodies[0]?.rows.length === 5 && [...outerTable.tBodies[0].rows].every((row, i) =>
            row.cells.length === 3 && row.cells[2].textContent === ['OPEN_END', 'MATH_END', 'QUERY_END', 'DIAGRAM_END', 'CLOSE_END'][i]) &&
          !!outerTable.querySelector('td > blockquote > ul .chart') && !!outerTable.querySelector('td > ul .mermaid'),
        cellOwnershipIntact: outerTable?.tHead?.rows[0]?.cells.length === 7 &&
          outerTable.tBodies[0]?.rows.length === 1 && (() => {
            const cells = outerTable.tBodies[0].rows[0].cells;
            return cells.length === 7 && cells[0].textContent === 'LEFT' && cells[6].textContent === 'RIGHT' &&
              cells[2].querySelector('blockquote > ul annotation')?.textContent === 'z^2' &&
              !!cells[3].querySelector('ul .mermaid svg') && !!cells[4].querySelector('blockquote > ul .chart .recharts-surface');
          })(),
        structureLink: literalCell('BODY_LITERAL')?.querySelector('a')?.textContent === ${JSON.stringify(STRUCTURE_URL)} &&
          literalCell('BODY_LITERAL')?.querySelector('a')?.getAttribute('href') === 'https://example.test/%60chart%5Cndata:step1%60',
        structureEndsReachable: structureEndsReachable(),
        headerDiagrams: outerTable?.tHead?.querySelectorAll('.mermaid svg').length,
        headerCharts: outerTable?.tHead?.querySelectorAll('figure.chart .recharts-surface').length,
        diagramLabelWidthsFit: [...b.querySelectorAll('.mermaid foreignObject')].every(node => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const text = range.getBoundingClientRect(), box = node.getBoundingClientRect();
          // Range의 높이는 MathML 글리프 바깥의 선택 행 상자도 포함한다. 여기서는
          // 서식 상속 때문에 글자가 옆으로 잘리는 폭을 검사하고 수식 크기는 별도로 잰다.
          return text.left >= box.left - 1 && text.right <= box.right + 1;
        }),
        diagramLabelBoxes: [...b.querySelectorAll('.mermaid foreignObject')].map(node => {
          const range = document.createRange(); range.selectNodeContents(node);
          const text = range.getBoundingClientRect(), box = node.getBoundingClientRect();
          return { text: node.textContent, fontWeight: getComputedStyle(node).fontWeight,
            left: text.left - box.left, right: text.right - box.right,
            top: text.top - box.top, bottom: text.bottom - box.bottom };
        }),
        placeholders: /LLMRICHTABLE|LLMMATHPLACEHOLDER|LLMCELLNODE/.test(b.innerHTML),
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    })()`);
    if (expected.diagramMarkerAligned) {
      // ::marker는 DOM 선택자/일반 bounding box에 잡히지 않는다. 실제 Chrome이
      // 배치한 가상 요소와 그림의 좌표를 대조해 아래로 내려간 목록 기호를 잡는다.
      const { root } = await page.send('DOM.getDocument', { depth: 1 });
      const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.rich-cell > ul > li' });
      const { node } = await page.send('DOM.describeNode', { nodeId, depth: 1, pierce: true });
      const marker = node.pseudoElements?.find(part => part.pseudoType === 'marker');
      assert.ok(marker, '그림을 포함한 목록의 기호가 없다');
      const { nodeId: visualId } = await page.send('DOM.querySelector', { nodeId, selector: '.mermaid' });
      const [markerBox, visualBox] = await Promise.all([
        page.send('DOM.getBoxModel', { backendNodeId: marker.backendNodeId }),
        page.send('DOM.getBoxModel', { nodeId: visualId }),
      ]);
      actual.diagramMarkerAligned = Math.abs(markerBox.model.content[1] - visualBox.model.content[1]) < 3;
    }
    const failures = [];
    for (const [key, value] of Object.entries(expected)) {
      try { assert.deepEqual(actual[key], value); }
      catch { failures.push({ key, expected: value, actual: actual[key] }); }
    }
    if (actual.overflow > 1) failures.push({ key: 'overflow', actual: actual.overflow });
    if (actual.placeholders) failures.push({ key: 'placeholders', actual: true });
    const logs = page.logs.splice(0);
    if (logs.length) failures.push({ key: 'console', actual: logs });
    if (process.env.REVIEW_SCREENSHOT_DIR && id === (process.env.REVIEW_SCREENSHOT_CASE ?? 'cell-literal-block-markers')) {
      await mkdir(process.env.REVIEW_SCREENSHOT_DIR, { recursive: true });
      const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(join(process.env.REVIEW_SCREENSHOT_DIR, `${id}-${width}.png`), Buffer.from(shot.data, 'base64'));
      await page.eval(`document.querySelector('.bubble.assistant').scrollIntoView({ block: 'start' })`);
      for (const edge of ['start', 'end']) {
        await page.eval(`(() => { const table = document.querySelector('.bubble.assistant table');
          table.scrollLeft = ${edge === 'start' ? '0' : 'table.scrollWidth'}; })()`);
        const image = await page.send('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(process.env.REVIEW_SCREENSHOT_DIR, `${id}-${width}-${edge}.png`), Buffer.from(image.data, 'base64'));
      }
    }
    results.push({ id, width, pass: !failures.length, failures, actual });
  }
  console.log(JSON.stringify({ mode: production ? 'production' : 'development', pass: results.filter(r => r.pass).length,
    fail: results.filter(r => !r.pass).length, results }, null, 2));
  // 자식 프로세스의 전체 stdout은 Node 오류 표시에서 잘릴 수 있다. 실패의
  // 식별자·판정값은 별도로 남겨 재현 사례를 잃지 않는다. 판정 조건은 같다.
  const failures = results.filter(result => !result.pass);
  if (failures.length) console.error(JSON.stringify(failures.map(({ id, width, failures }) => ({ id, width, failures }))));
  process.exitCode = results.some(r => !r.pass) ? 1 : 0;
} finally {
  page?.ws.close();
  const browserStopped = await stopProcess(chrome, { group: true });
  const serverStopped = await stopProcess(vite);
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  assert.ok(browserStopped && serverStopped, '검사가 띄운 프로세스가 남았다');
}
