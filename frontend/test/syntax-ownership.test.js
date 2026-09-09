import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '../src/math.js';
import { PreviewPre } from '../src/preview.js';
import { MIXED_WRAPPERS } from './mixed-content-corpus.js';
import { resolveChartData, resolveTableData } from '../../backend/src/chart.js';

const render = (source, preview = false) => renderToStaticMarkup(React.createElement(Markdown, {
  remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS, components: preview ? { pre: PreviewPre } : {},
}, source));
const table = body => '| L | M | R |\n|---|---|---|\n| LEFT | ' + body + ' | RIGHT |';
const steps = [[{ A: 'FOUND_ROW', B: 7 }]];
const intact = html => {
  assert.ok(html.includes('<td>LEFT</td>') && html.includes('<td>RIGHT</td>'), html);
  assert.doesNotMatch(html, /LLMRICHTABLE|LLMMATHPLACEHOLDER/);
};
const encode = source => source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#x27;');

test('직렬화 개행 복구로 새로 생긴 표도 시각화의 내부 파이프와 이웃 셀을 보호한다', () => {
  for (const lang of ['mermaid', 'chart']) for (const separator of ['\\n', '<br>', '<br/>', '\\<br>']) {
    const body = lang === 'mermaid' ? 'flowchart LR\n A["$$x^2$$"] -->|label| B'
      : 'type: bar\n| A | B |\n|---|---|\n| a | 7 |';
    for (const fence of ['`', '``', '```']) for (const wrap of [s => s, s => `**설명 ${s} 뒤**`])
      for (const newline of ['\\n', '\\r\\n']) {
      const source = table(wrap(fence + lang + separator + body.replaceAll('\n', separator) + fence)).replaceAll('\n', newline);
      const html = render(source);
      intact(html);
      assert.ok(html.includes(`<code class="language-${lang}">${encode(body)}\n</code>`), html);
      const preview = render(source, true);
      intact(preview);
      assert.equal([...preview.matchAll(/표·차트를 준비하고 있습니다/g)].length, 1);
    }
  }
});

test('서버를 거친 LaTeX 내부 chart 예시는 수식과 오류 원문을 그대로 보존한다', () => {
  const literal = '`chart<br>data:step1`';
  for (const [open, close] of [['$', '$'], ['$$', '$$'], ['\\(', '\\)'], ['\\[', '\\]']])
    for (const command of ['text', 'unknowncommand']) for (const wrap of Object.values(MIXED_WRAPPERS)) {
      const tex = `\\${command}{${literal}}`;
      const source = wrap(table(open + tex + close));
      assert.equal(resolveChartData(source, steps), source);
      const html = render(source);
      intact(html);
      assert.doesNotMatch(html, /language-chart|FOUND_ROW/);
      assert.ok(html.includes(command === 'text' ? `application/x-tex">${encode(tex)}</annotation>`
        : `<code>${encode(open + tex + close)}</code>`));
    }
});

test('각주 참조·정의의 이름은 보존하고 같은 각주 본문의 실제 차트만 채운다', () => {
  const name = '`chart<br>data:step1`';
  for (const newline of ['\n', '\r\n', '\r']) {
    const source = (table(`[^${name}]`) + `\n\n[^${name}]: FOOTNOTE_CONTENT $z^2$`).replaceAll('\n', newline);
    assert.equal(resolveChartData(source, steps), source);
    const html = render(source);
    intact(html);
    assert.equal([...html.matchAll(/data-footnote-ref="true"/g)].length, 1);
    assert.ok(html.includes('FOOTNOTE_CONTENT') && html.includes('application/x-tex">z^2</annotation>'));
    assert.doesNotMatch(html, /language-chart|FOUND_ROW/);
    const chart = source + '\n\n[^second]: 실제 조회\n\n    ```chart\n    data:step1\n    ```\n\n본문[^second]';
    const resolved = resolveChartData(chart, steps);
    const result = render(resolved);
    intact(result);
    assert.ok(result.includes('FOUND_ROW') && result.includes('language-chart'));
  }
});

test('공백이 달라지는 인용과 각주·목록의 펜스도 AST 경계대로 조회를 채운다', () => {
  for (const [lang, resolve, config] of [['chart', resolveChartData, 'data:step1'], ['table', resolveTableData, 'step:1']]) {
    for (const source of [
      `> \`\`\`${lang}\n>${config}\n> \`\`\``,
      `- > \`\`\`${lang}\n  >${config}\n  > \`\`\``,
      `본문[^1]\n\n[^1]: \`\`\`${lang}\n    ${config}\n    \`\`\``,
      `10. 항목\n\n    \`\`\`${lang}\n    ${config}\n    \`\`\``,
    ]) for (const newline of ['\n', '\r\n', '\r']) {
      const resolved = resolve(source.replaceAll('\n', newline), steps);
      const html = render(resolved);
      assert.ok(html.includes('FOUND_ROW'), `${source}\n${resolved}`);
      assert.ok(html.includes(lang === 'chart' ? 'language-chart' : '<table>'));
      assert.doesNotMatch(html, /LLMRICHTABLE|LLMMATHPLACEHOLDER/);
    }
  }
});

test('수신 중 직렬화 표의 앞 완성 행은 뒤 시각화가 완성될 때까지 보존된다', () => {
  const prefix = table('$x^2$').replaceAll('\n', '\\n') + '\\n';
  const next = '| next | `mermaid\\nflowchart LR\\n A -->|label| B` | END |';
  for (let end = 0; end <= next.length; end++) {
    const html = render(prefix + next.slice(0, end), true);
    intact(html);
    assert.ok(html.includes('application/x-tex">x^2</annotation>'));
  }
});

test('주소·HTML·참조 이름의 홑백틱은 이웃 시각화의 여는 기호를 소비하지 않는다', () => {
  for (const ticks of ['`', '``', '```']) for (const lang of ['chart', 'mermaid']) {
    const body = lang === 'chart' ? 'data:step1' : 'flowchart LR\\nA -->|label| B';
    const code = ticks + lang + '\\n' + body + ticks;
    const definitions = `\n\n[${ticks}]: https://example.test\n\n[^${ticks}]: FOOTNOTE_CONTENT`;
    for (const label of [`[LINK](https://example.test/${ticks})`, `![IMG](https://example.test/${ticks})`,
      `<span title="${ticks}">TEXT</span>`, `[LINK][${ticks}]`, `[^${ticks}]`]) {
      for (const side of ['left', 'right']) {
        const source = table(side === 'left' ? label + ' ' + code : code + ' ' + label) + definitions;
        const resolved = resolveChartData(source, steps);
        const html = render(resolved);
        intact(html);
        assert.ok(html.includes(`language-${lang}`));
        assert.ok(html.includes(lang === 'chart' ? 'FOUND_ROW' : 'A --&gt;|label| B'));
        assert.equal([...html.matchAll(/language-(?:chart|mermaid)/g)].length, 1);
      }
    }
  }
});
