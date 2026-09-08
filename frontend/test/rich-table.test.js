import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '../src/math.js';
import { PreviewPre } from '../src/preview.js';
import { MIXED_WRAPPERS } from './mixed-content-corpus.js';
import { resolveChartData, resolveTableData, MAX_CHART_INJECT_LEN } from '../../backend/src/chart.js';
import { parseChartBlock } from '../src/chart.js';
import { INLINE_CHART, INLINE_MERMAID, QUADRATIC, SERIALIZED_QUADRATIC, RICH_TABLE_ANSWER, MULTI_ELEMENT_TABLE, MEAN, STANDALONE_MERMAID } from './rich-table-corpus.js';
const render = (md, preview = false) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
  remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS, components: preview ? { pre: PreviewPre } : {},
}, md));
const count = (html, pattern) => [...html.matchAll(pattern)].length;

test('표의 br·이스케이프 br은 줄바꿈·목록이 되고, 수식·강조·이웃 셀을 보존한다', () => {
  for (const br of ['<br>', '<br/>', '<BR />', '\\<br>', '&lt;br&gt;'])
    for (const wrap of Object.values(MIXED_WRAPPERS)) for (const newline of ['\n', '\r\n', '\r']) {
      const md = wrap('| A | B | C |\n|---|---|---|\n| LEFT | **완료**' + br + br + '- $x^2$' + br + '- 두 번째 | RIGHT |');
      const html = render(md.replaceAll('\n', newline));
      assert.equal(count(html, /<td(?:>| )/g), 3);
      assert.ok(html.includes('<strong>완료</strong>'));
      assert.ok(html.includes('application/x-tex">x^2</annotation>'));
      assert.ok(html.includes('<td>RIGHT</td>'));
      assert.ok(html.includes('<li>두 번째</li>'));
      assert.doesNotMatch(html, /&lt;[bB][rR]|math-error|LLMMATHPLACEHOLDER/);
    }
});

test('표의 시각화는 raw·escaped 파이프, 펜스 종류, 개행·컨테이너에 상관없이 원문과 이웃 셀을 유지한다', () => {
  for (const body of [INLINE_CHART, INLINE_MERMAID]) for (const fence of ['`', '```', '\\`\\`\\`'])
    for (const pipes of [false, true]) for (const wrap of Object.values(MIXED_WRAPPERS)) for (const newline of ['\n', '\r\n', '\r']) {
      const content = pipes ? body.replaceAll('|', '\\|') : body;
      const md = wrap('| A | B | C |\n|---|---|---|\n| $x=1$ | ' + fence + content + fence + ' | RIGHT |');
      const html = render(md.replaceAll('\n', newline));
      assert.equal(count(html, /<td(?:>| )/g), 3, md);
      assert.ok(html.includes('<td>RIGHT</td>'), md);
      assert.ok(html.includes(body.startsWith('chart') ? 'language-chart' : 'language-mermaid'), md);
      if (body.startsWith('chart')) assert.ok(html.includes('| 2월 | 18 |'), md);
      assert.doesNotMatch(html, /math-error|LLMMATHPLACEHOLDER/);
    }
});

test('일반 코드·HTML·설명 속 언어 이름은 실행되지 않는다', () => {
  for (const cell of ['`<br>`', '`x\\ny`', '`chart-js\\ntype: bar`', '설명 `mermaid`', '<img src="/__probe-pixel.png">']) {
    const html = render('| A |\n|---|\n| ' + cell + ' |');
    assert.doesNotMatch(html, /<br\s*\/>|language-chart|language-mermaid|<img/);
  }
  const html = render('````text\n| A |\n|---|\n| `mermaid\\nflowchart TD\\n A-->B` |\n````');
  assert.doesNotMatch(html, /language-mermaid/);
});

test('주신 복합 표와 이중 이스케이프 근의 공식은 최종·미리보기에서 유지된다', () => {
  for (const preview of [false, true]) {
    const html = render(RICH_TABLE_ANSWER, preview);
    assert.doesNotMatch(html, /math-error|LLMMATHPLACEHOLDER/);
    assert.ok(html.includes(`application/x-tex">${QUADRATIC}</annotation>`));
    assert.ok(html.includes('application/x-tex">a\\ne0</annotation>'));
    assert.ok(html.includes('<li>매출 비교</li>') && html.includes('<li>결과 저장</li>'));
    assert.ok(html.includes('<td>오류 이웃</td>'));
    assert.ok(html.includes('<code>&lt;br&gt;</code>'));
    if (preview) assert.equal(count(html, /표·차트를 준비하고 있습니다/g), 7);
    else assert.equal(count(html, /language-(chart|mermaid)/g), 7);
  }
});

test('한 셀의 수식·강조·목록·인용·설명·그림을 블록으로 유지하고 독립된 직렬화 그림도 표시한다', () => {
  const html = render(MULTI_ELEMENT_TABLE);
  assert.equal(count(html, /<td(?:>| )/g), 6);
  assert.ok(html.includes(`application/x-tex">${MEAN}</annotation>`));
  assert.ok(html.includes('<strong>계산 절차</strong>'));
  assert.ok(html.includes('<li>관측값 합산</li>'));
  assert.ok(html.includes('<blockquote>\n<p>결측값은 사전에 처리해야 합니다.</p>'));
  assert.equal(count(html, /language-(chart|mermaid)/g), 2);
  for (const wrap of Object.values(MIXED_WRAPPERS)) assert.match(render(wrap(STANDALONE_MERMAID)), /language-mermaid/);
  const emphasized = render('| A |\n|---|\n| **설명 ' + STANDALONE_MERMAID + ' 뒤** |');
  assert.match(emphasized, /language-mermaid/);
  assert.doesNotMatch(emphasized, /<strong><pre>|<p><pre>|LLMRICHTABLE/);
  assert.match(render(String.raw`\> 주의사항`), /<blockquote>/);
  for (const md of ['`\\> 주의사항`', '```text\n\\> 주의사항\n```', '설명 `mermaid<br>flowchart LR<br>A-->B`']) {
    assert.doesNotMatch(render(md), /<blockquote>|language-mermaid/);
  }
});

test('직렬화 개행 복구는 정상 TeX 명령·행 구분자·코드·주소를 보존한다', () => {
  for (const tex of [String.raw`\nu+\neq+\nabla`, String.raw`\begin{aligned}a&=1\\b&=2\end{aligned}`]) {
    assert.ok(render(`$${tex}$`).includes(`application/x-tex">${tex.replaceAll('&', '&amp;')}</annotation>`));
  }
  const mermaid = render('| A |\n|---|\n| `mermaid\\nflowchart LR\\n A["$$\\nu$$"] --> B[완료]\\n` |');
  assert.ok(mermaid.includes('$$\\nu$$'), '직렬화 개행과 TeX nu 명령을 혼동했다');
  const commands = String.raw`\rho+\rightleftharpoons+\rangle+\nearrow+\nleq`;
  assert.ok(render('| A |\n|---|\n| `mermaid\\nflowchart LR\\n A["$$' + commands + '$$"] --> B[완료]\\n` |')
    .includes(commands), '직렬화 개행과 r/n으로 시작하는 TeX 명령을 혼동했다');
  for (const md of [String.raw`$\nu+\neq+\nabla$`, String.raw`$\begin{aligned}a&=1\\b&=2\end{aligned}$`,
    '`\\n\\n`', '```js\nconst value="\\n\\n";\n```', '[주소](https://example.test/a?x=\\n\\n)']) {
    assert.ok(render(md));
    assert.doesNotMatch(render(md), /math-error|LLMMATHPLACEHOLDER/);
  }
  const html = render(SERIALIZED_QUADRATIC);
  assert.ok(html.includes('<p>단, '));
  assert.ok(html.includes(`application/x-tex">${QUADRATIC}</annotation>`));
  assert.doesNotMatch(html, /\\n\\n|\\frac.*math-error/);
});

test('표 시각화의 모든 수신 접두사에서 앞의 완성된 행·열은 유지된다', () => {
  const first = '| A | B | C |\n|---|---|---|\n| 완료 | $x=1$ | RIGHT |\n';
  const row = '| 차트 | `' + INLINE_CHART.replaceAll('|', '\\|') + '` | END |';
  for (let n = 0; n <= row.length; n++) {
    const html = render(first + row.slice(0, n), true);
    assert.ok(html.includes('<td>RIGHT</td>'));
    assert.ok(html.includes('application/x-tex">x=1</annotation>'));
    assert.doesNotMatch(html, /LLMMATHPLACEHOLDER/);
  }
});

test('직렬화된 표 안/독립 차트도 조회 결과를 채우며 원문 값·이웃 셀·예산을 보존한다', () => {
  const steps = [[{ 월: '1월', 건수: 12 }, { 월: '2월', 건수: 18 }]];
  for (const br of ['<br>', '\\n']) for (const fence of ['`', '```', '\\`\\`\\`'])
    for (const wrap of Object.values(MIXED_WRAPPERS)) for (const newline of ['\n', '\r\n', '\r']) {
      const code = fence + ['chart', 'type: bar', 'data: step 1', ''].join(br) + fence;
      const md = wrap('| A | B | C |\n|---|---|---|\n| LEFT | ' + code + ' | RIGHT |').replaceAll('\n', newline);
      const html = render(resolveChartData(md, steps));
      assert.equal(count(html, /<td(?:>| )/g), 3, md);
      assert.ok(html.includes('<td>RIGHT</td>') && html.includes('| 2월 | 18 |'), md);
      assert.doesNotMatch(html, /data: step|LLMRICHTABLE/);
      const alone = render(resolveChartData(code, steps));
      assert.match(alone, /language-chart/);
      assert.ok(alone.includes('| 1월 | 12 |'));
    }
  const values = ['a|b', String.raw`a\|b`, String.raw`C:\notes`, '<br>', '`code`', '$x$', '&amp;', '한글'];
  const md = resolveChartData('| A | B |\n|---|---|\n| 데이터 | `chart\\ntype: bar\\ndata: step 1` |',
    [values.map((value, i) => ({ 이름: value, 값: i + 1 }))]);
  let spec;
  renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS,
    components: { code: props => { spec = parseChartBlock(String(props.children)); return React.createElement('code', null, props.children); } },
  }, md));
  assert.ok(spec.ok);
  assert.deepEqual(spec.spec.rows.map(row => row.full), values);
  for (const code of ['````text\n`chart\\ntype: bar\\ndata: step 1`\n````',
    '```text\n`chart\\ntype: bar\\ndata: step 1`', '``예제 `chart\\ndata: step 1` 예제``',
    '설명 `chart\\ntype: bar\\ndata: step 1`입니다.']) assert.equal(resolveChartData(code, steps), code);
  const missing = resolveChartData('| A | B |\n|---|---|\n| 데이터 | `chart<br>type: bar<br>data: step 2` |', steps);
  assert.match(render(missing), /실행 2의 결과가 없습니다/);
  const many = '| A | B |\n|---|---|\n' + '| 값 | `chart\\ntype: bar\\ndata: step 1` |\n'.repeat(20);
  const large = [[...Array(100)].map((_, i) => ({ 이름: '값|'.repeat(20) + i, 값: i }))];
  assert.ok(resolveChartData(many, large).length - many.length < MAX_CHART_INJECT_LEN + 2000);
});

test('조회 표의 문자로 저장된 br은 모델이 쓴 셀 줄바꿈과 구별해 보존한다', () => {
  const values = ['<br>', '앞<br>뒤', '<BR />', String.raw`앞\<br>뒤`, '`<br>`', '<br>\\|<br>'];
  const answer = resolveTableData('```table\nstep: 1\n```', [values.map(value => ({ '<br>': value }))]);
  const actual = [];
  renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS,
    components: { td: props => {
      const html = renderToStaticMarkup(React.createElement('span', null, props.children));
      actual.push(html.replace(/<[^>]*>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
      assert.doesNotMatch(html, /<br\s*\/>/);
      return React.createElement('td', null, props.children);
    } } }, answer));
  assert.deepEqual(actual, values);
});
