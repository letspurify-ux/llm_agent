// 조합별 원문·구조 회귀 코퍼스. rendering-combinations.test.js에서도 결과를 검사한다.
// 실행: node frontend/test/review/rendering-combinations.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fileURLToPath } from 'node:url';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '../../src/math.js';
import { resolveChartData, resolveTableData } from '../../../backend/src/chart.js';
import { MIXED_WRAPPERS } from '../mixed-content-corpus.js';

const render = md => renderToStaticMarkup(React.createElement(ReactMarkdown, {
  remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS,
}, md));
const count = (html, re) => [...html.matchAll(re)].length;
const facts = html => ({
  formulas: [...html.matchAll(/<annotation encoding="application\/x-tex">([^<]*)<\/annotation>/g)].map(m => m[1]),
  errors: count(html, /class="math-error/g),
  charts: count(html, /class="language-chart"/g),
  diagrams: count(html, /class="language-mermaid"/g),
  cells: count(html, /<td>/g),
  links: count(html, /href="https:\/\/example.test\/ref"/g),
  code: count(html, /class="language-text"/g),
  footnotes: count(html, /data-footnote-ref="true"/g),
  placeholder: /LLMMATHPLACEHOLDER/.test(html),
});
const empty = { formulas: [], errors: 0, charts: 0, diagrams: 0, cells: 0, links: 0, code: 0, footnotes: 0, placeholder: false };
const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
const chart = '```chart\ntype: bar\n| LABEL | VALUE |\n|---|---|\n| A | 7 |\n```';
const mermaid = '```mermaid\nflowchart LR\n A["$literal$ | 코드"] --> B[완료]\n```';
const components = [
  ['markdown', '**강조** ~~삭제~~ [LINK](https://example.test/ref)', { links: 1 }],
  ['inline', String.raw`인라인 $a_b + c_d$.`, { formulas: ['a_b + c_d'] }],
  ['display', '\\[\n\\frac{1}{2}\n\\]', { formulas: [String.raw`\frac{1}{2}`] }],
  ['latex-fence', '```latex\n\\sqrt{x}\n```', { formulas: [String.raw`\sqrt{x}`] }],
  ['table', '| 수식 | 비고 |\n|---|---|\n| $|x|$ | RIGHT |', { formulas: ['|x|'], cells: 2 }],
  ['chart', chart, { charts: 1 }],
  ['mermaid', mermaid, { diagrams: 1 }],
  ['literal', '```text\n$x$ \\[y\\] $$z$$\n```', { code: 1 }],
];
const outcomes = new Map();
function check(group, id, md, verify) {
  if (!outcomes.has(group)) outcomes.set(group, { pass: 0, fail: 0, examples: [] });
  const result = outcomes.get(group);
  try { verify(); result.pass++; }
  catch (error) {
    result.fail++;
    if (result.examples.length < 3) result.examples.push({ id, markdown: md, error: error.message });
  }
}
const combine = (a, b) => Object.fromEntries(Object.keys(empty).map(key => [key,
  key === 'formulas' ? [...(a[key] ?? []), ...(b[key] ?? [])] :
    key === 'placeholder' ? false : (a[key] ?? 0) + (b[key] ?? 0),
]));
for (const [leftId, left, leftFacts] of components) for (const [rightId, right, rightFacts] of components) {
  if (leftId === rightId) continue;
  for (const [wrapper, wrap] of Object.entries(MIXED_WRAPPERS)) for (const newline of ['\n', '\r\n', '\r']) {
    const md = wrap(left + '\n\n' + right).replaceAll('\n', newline);
    check('normal-pairs', `${leftId}/${rightId}/${wrapper}/${JSON.stringify(newline)}`, md, () => {
      const html = render(md);
      assert.deepEqual(facts(html), combine(leftFacts, rightFacts));
      for (const [id, body] of [[leftId, left], [rightId, right]]) {
        if (['chart', 'mermaid', 'literal'].includes(id)) {
          const code = body.split('\n').slice(1, -1).join('\n') + '\n';
          assert.ok(html.replace(/\r\n?/g, '\n').includes(escapeHtml(code)), `${id} 코드 원문이 변형됨`);
        }
        if (id === 'table') assert.ok(html.includes('<td>RIGHT</td>'), '수식 옆 셀 내용이 사라짐');
        if (id === 'markdown') {
          assert.ok(html.includes('<strong>강조</strong>'));
          assert.ok(html.includes('<del>삭제</del>'));
        }
      }
    });
  }
}

// 실패한 앞 수식과 별개인 블록·다음 정상 수식이 보존되어야 한다.
for (const [open, close] of [['\\[', '\\]'], ['\\(', '\\)']]) {
  for (const [middleId, middle, expected] of components) {
    for (const [wrapper, wrap] of Object.entries(MIXED_WRAPPERS)) for (const newline of ['\n', '\r\n', '\r']) {
      const md = wrap(`${open}broken=\n\n${middle}\n\n${open}z=9${close}`).replaceAll('\n', newline);
      check('unclosed-math-isolation', `${open}/${middleId}/${wrapper}/${JSON.stringify(newline)}`, md, () => {
        const actual = facts(render(md));
        assert.ok(actual.formulas.includes('z=9'), '뒤의 정상 수식 z=9가 사라짐');
        for (const [key, value] of Object.entries(expected)) if (key !== 'formulas') assert.equal(actual[key], value, key);
      });
    }
  }
}

// 앱이 정상 code 노드로 인식하는 컨테이너에서 서버도 실제 조회 결과를 채워야 한다.
const referenceWrappers = {
  ...MIXED_WRAPPERS,
  orderedFirstLine: body => '1. ' + body.split('\n').map((line, i) => i ? '   ' + line : line).join('\n'),
  unorderedFirstLine: body => '- ' + body.split('\n').map((line, i) => i ? '  ' + line : line).join('\n'),
};
for (const [lang, resolver, body] of [['chart', resolveChartData, 'type: bar\ndata: step 1'], ['table', resolveTableData, 'step: 1']]) {
  for (const fence of ['```', '~~~']) for (const [wrapper, wrap] of Object.entries(referenceWrappers)) for (const newline of ['\n', '\r\n', '\r']) {
    const md = wrap(`${fence}${lang}\n${body}\n${fence}`).replaceAll('\n', newline);
    check('nested-data-resolution', `${lang}/${fence}/${wrapper}/${JSON.stringify(newline)}`, md, () => {
      assert.ok(render(md).includes(`language-${lang}`), '시험 입력이 코드펜스로 인식되지 않음');
      assert.ok(resolver(md, [[{ LABEL: 'FOUND_ROW', VALUE: 7 }]]).includes('FOUND_ROW'), '조회 결과 FOUND_ROW가 채워지지 않음');
    });
  }
}

for (const id of ['$x$', String.raw`\(x\)`, '$$x$$', String.raw`\[x\]`]) {
  for (const newline of ['\n', '\r\n', '\r']) {
    const md = (`본문 [^${id}]와 $y$.\n\n[^${id}]: FOOTNOTE_CONTENT`).replaceAll('\n', newline);
    check('footnote-math-id', `${id}/${JSON.stringify(newline)}`, md, () => {
      const control = renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, md));
      assert.equal(facts(control).footnotes, 1, '대조군에서도 각주로 인식되지 않는 입력');
      const html = render(md);
      assert.equal(facts(html).footnotes, 1, '정상 각주 참조가 사라짐');
      assert.ok(html.includes('FOOTNOTE_CONTENT'), '각주 본문이 사라짐');
    });
  }
}
for (const [wrapper, wrap] of Object.entries({ plain: s => s, bold: s => `**${s}**`, table: s => `| 수식 |\n|---|\n| ${s} |` })) {
  for (const gap of ['', ' ', '/', ', ']) {
    const md = wrap('$x$' + gap + '$y$');
    check('adjacent-inline-dollars', `${wrapper}/${JSON.stringify(gap)}`, md,
      () => assert.deepEqual(facts(render(md)).formulas, ['x', 'y']));
  }
}

// 스트림의 모든 접두사에서, 이미 닫힌 차트·Mermaid 펜스가 뒤의 수식 조각 때문에 사라지면 안 된다.
const streaming = '\\[broken=\n\n' + chart + '\n\n' + mermaid + '\n\n\\[z=9\\]';
const stableFrom = streaming.indexOf('\n\n\\[z=9');
for (let n = stableFrom; n <= streaming.length; n++) {
  const md = streaming.slice(0, n);
  check('stream-prefix-block-preservation', String(n), md, () => {
    const actual = facts(render(md));
    assert.equal(actual.charts, 1, '완성된 차트가 뒤 수식 수신 중 사라짐');
    assert.equal(actual.diagrams, 1, '완성된 Mermaid가 뒤 수식 수신 중 사라짐');
    assert.equal(actual.placeholder, false);
  });
}
export const combinationResults = Object.fromEntries(outcomes);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(combinationResults, null, 2));
  process.exitCode = [...outcomes.values()].some(result => result.fail) ? 1 : 0;
}
