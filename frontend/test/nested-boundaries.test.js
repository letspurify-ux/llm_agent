import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '../src/math.js';
import { PreviewPre } from '../src/preview.js';
import { MIXED_WRAPPERS } from './mixed-content-corpus.js';
import { resolveChartData } from '../../backend/src/chart.js';
import { parseChartBlock } from '../src/chart.js';
import { inlineCodeSpans } from '../../shared/inline-code.mjs';

const encode = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
const render = (source, preview = false) => renderToStaticMarkup(React.createElement(Markdown, {
  remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS, components: preview ? { pre: PreviewPre } : {},
}, source));
const table = body => '| L | M | R |\n|---|---|---|\n| LEFT | ' + body + ' | RIGHT |';
const intact = html => {
  assert.equal([...html.matchAll(/<td(?:>| )/g)].length, 3);
  assert.ok(html.includes('<td>LEFT</td>') && html.includes('<td>RIGHT</td>'));
  assert.doesNotMatch(html, /LLMRICHTABLE|LLMMATHPLACEHOLDER/);
};

test('공통 백틱 경계는 실제 Markdown 파서의 일반 인라인 코드와 일치한다', () => {
  for (const source of ['`a `` b`', '``a ` b``', '```a `` b```', '`a \\` b',
    '\\`문자` 실제 `코드`', '``미완성 `코드`', '`` a\nb ``', '예시 `` `chart\\ndata:step1` `` 끝']) {
    const actual = [];
    renderToStaticMarkup(React.createElement(Markdown, {
      components: { code: props => { actual.push(String(props.children)); return null; } },
    }, source));
    const expected = [...inlineCodeSpans(source)].map(span => {
      const value = span.value.replace(/\r\n?|\n/g, ' ');
      return /^ .* $/.test(value) && /[^ ]/.test(value) ? value.slice(1, -1) : value;
    });
    assert.deepEqual(expected, actual, source);
  }
});

test('시각화 내부의 더 길거나 짧은 백틱은 닫는 구분자가 아니다: 1,080개 중첩 조합', () => {
  for (const lang of ['chart', 'mermaid']) for (const outer of [1, 2, 3, 4]) for (const inner of [1, 2, 3, 4]) {
    if (outer === inner) continue;
    const ticks = '`'.repeat(inner);
    const body = lang === 'mermaid' ? `flowchart LR\n A["${ticks}code${ticks} | label"] --> B`
      : `type: bar\n| A | B |\n|---|---|\n| ${ticks}code${ticks} | 3 |`;
    const code = '`'.repeat(outer) + lang + '\\n' + body.replaceAll('\n', '\\n') + '`'.repeat(outer);
    for (const wrapInline of [s => s, s => `**설명 ${s} 뒤**`, s => `[설명 ${s} 뒤](https://example.test)`])
      for (const wrap of Object.values(MIXED_WRAPPERS)) for (const newline of ['\n', '\r\n', '\r']) {
        const source = wrap(table(wrapInline(code))).replaceAll('\n', newline);
        const html = render(source);
        intact(html);
        assert.ok(html.includes(`<pre><code class="language-${lang}">${encode(body)}\n</code></pre>`), source);
        assert.doesNotMatch(html, /<(?:strong|a|p)[^>]*><pre>/);
        const preview = render(source, true);
        intact(preview);
        assert.equal([...preview.matchAll(/표·차트를 준비하고 있습니다/g)].length, 1);
      }
  }
});

test('일반 코드 안의 시각화 예시는 코드 원문을 보존한다', () => {
  for (const lang of ['chart', 'mermaid']) for (const outer of [2, 3, 4]) for (const inner of [1, 2, 3, 4]) {
    if (outer === inner) continue;
    const value = `예시 ${'`'.repeat(inner)}${lang}\\nflowchart LR\\nA-->B${'`'.repeat(inner)} 끝`;
    for (const wrap of Object.values(MIXED_WRAPPERS)) {
      const source = wrap(table('`'.repeat(outer) + value + '`'.repeat(outer)));
      const html = render(source);
      intact(html);
      assert.ok(html.includes(`<code>${encode(value)}</code>`));
      assert.doesNotMatch(html, /language-(?:chart|mermaid)/);
      assert.equal(resolveChartData(source, [[{ A: 'FOUND_ROW', B: 7 }]]), source);
    }
  }
});

test('LaTeX가 시각화 모양의 코드를 포함하면 수식 본문과 오류 원문에 실제 원문을 돌려준다', () => {
  for (const fence of ['`', '``', '```']) for (const delimiter of [['$', '$'], ['\\(', '\\)'], ['\\[', '\\]']]) {
    for (const command of ['text', 'unknowncommand']) {
      const tex = `\\${command}{${fence}mermaid<br>flowchart LR<br>A-->B${fence}}`;
      const original = delimiter[0] + tex + delimiter[1];
      const html = render(table(original));
      intact(html);
      assert.doesNotMatch(html, /language-mermaid/);
      assert.ok(html.includes(command === 'text' ? `application/x-tex">${encode(tex)}</annotation>`
        : `<code>${encode(original)}</code>`));
    }
  }
});

test('주소·HTML 속성 속의 시각화 표기는 재해석하거나 임시 토큰으로 바꾸지 않는다', () => {
  for (const code of ['`mermaid<br>flowchart-LR`', '``chart\\ntype:bar``']) {
    const source = table(`[LINK](https://example.test/${code})`);
    const html = render(source);
    intact(html);
    assert.ok(html.includes('href="https://example.test/'));
    assert.doesNotMatch(html, /language-(chart|mermaid)/);
    const literal = render(table(`<span title="${code}">TEXT</span>`));
    intact(literal);
    assert.ok(literal.includes(encode(code)));
    for (const prefix of ['', '!']) {
      const reference = render(table(`${prefix}[LABEL][${code}]`) + `\n\n[${code}]: https://example.test`);
      intact(reference);
      assert.doesNotMatch(reference, /language-(chart|mermaid)/);
      assert.ok(reference.includes('https://example.test'));
    }
  }
});

test('서버 조회 주입과 프런트 시각화가 같은 정확한 백틱 경계를 사용한다', () => {
  for (const outer of [1, 2, 3, 4]) for (const inner of [1, 2, 3, 4]) {
    if (outer === inner) continue;
    const title = `값 ${'`'.repeat(inner)}인용${'`'.repeat(inner)}`;
    const code = '`'.repeat(outer) + `chart\\ntype: bar\\ntitle: ${title}\\ndata: step 1` + '`'.repeat(outer);
    for (const wrap of Object.values(MIXED_WRAPPERS)) {
      const resolved = resolveChartData(wrap(table(code)), [[{ A: 'FOUND_ROW', B: 7 }]]);
      const html = render(resolved);
      intact(html);
      assert.doesNotMatch(html, /data: step/);
      const spans = [...inlineCodeSpans(resolved)].filter(span => span.value.startsWith('chart\\n'));
      assert.equal(spans.length, 1);
      const parsed = parseChartBlock(spans[0].value.slice(7).replaceAll('\\n', '\n').replaceAll('\\|', '|'));
      assert.ok(parsed.ok);
      assert.equal(parsed.spec.title, title);
      assert.equal(parsed.spec.rows[0].full, 'FOUND_ROW');
    }
  }
});

test('서버도 주소·HTML·참조 이름 속 chart 코드를 조회 주입 대상으로 삼지 않는다', () => {
  const code = '`chart<br>data:step1`';
  const cases = [
    table(`[LINK](https://example.test/${code})`),
    table(`![ALT](https://example.test/${code})`),
    table(`<span title="${code}">TEXT</span>`),
    table(`[LINK][${code}]`) + `\n\n[${code}]: https://example.test`,
    table(`![ALT][${code}]`) + `\n\n[${code}]: https://example.test`,
    '``코드 예시\n| LEFT | ' + code + ' | RIGHT |\n``',
    '    ' + code,
  ];
  for (const source of cases) {
    assert.equal(resolveChartData(source, [[{ A: 'FOUND_ROW', B: 7 }]]), source);
    assert.doesNotMatch(render(source), /LLMRICHTABLE|language-chart|FOUND_ROW/);
  }
});

test('다른 길이의 백틱을 수신하는 동안 이미 완성된 표 행은 유지된다', () => {
  const first = table('$x^2$') + '\n';
  const next = '| 다음 | `mermaid\\nflowchart LR\\n A["``code`` | label"] --> B` | END |';
  for (let end = 0; end <= next.length; end++) {
    const html = render(first + next.slice(0, end), true);
    assert.ok(html.includes('<td>RIGHT</td>'));
    assert.ok(html.includes('application/x-tex">x^2</annotation>'));
    assert.doesNotMatch(html, /LLMRICHTABLE|LLMMATHPLACEHOLDER/);
  }
});

test('코드 안쪽의 패딩 공백도 시각화 본문·조회 데이터·이웃 셀을 보존한다', () => {
  for (const pad of [' ', '  ', '\t']) for (const lang of ['chart', 'mermaid']) {
    const body = lang === 'chart' ? 'type: bar\n| A | B |\n|---|---|\n| code | 7 |'
      : 'flowchart LR\n A["label | code"] --> B';
    const html = render(table('`' + pad + lang + '\\n' + body.replaceAll('\n', '\\n') + pad + '`'));
    intact(html);
    assert.ok(html.includes(`<pre><code class="language-${lang}">${encode(body)}\n</code></pre>`));
    const resolved = resolveChartData(table('`' + pad + 'chart\\ndata:step1' + pad + '`'), [[{ A: 'FOUND_ROW', B: 7 }]]);
    intact(render(resolved));
    assert.ok(resolved.includes('FOUND_ROW'));
  }
});
