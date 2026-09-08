import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '../src/math.js';
import { MIXED_FORMULAS, MIXED_WRAPPERS, mixedContent } from './mixed-content-corpus.js';

for (const kind of Object.keys(MIXED_WRAPPERS)) for (const newline of ['\n', '\r\n']) {
  test(`복합 콘텐츠: ${kind} / ${JSON.stringify(newline)}에서 수식·표·코드·링크 보존`, () => {
    const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
      remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS,
    }, mixedContent(kind).replaceAll('\n', newline)));
    const formulas = [...html.matchAll(/<annotation encoding="application\/x-tex">([^<]*)<\/annotation>/g)].map(m => m[1].trim());
    assert.deepEqual(formulas, MIXED_FORMULAS);
    assert.doesNotMatch(html, /math-error/);
    assert.equal((html.match(/<td>/g) ?? []).length, 6);
    for (const text of ['오른쪽 보존', '복합 시작', '복합 끝', '$HOME', '$100, $200, ₩ 300', '$\\frac{a}{b}$', 'language-chart', 'language-mermaid', 'q=$HOME'])
      assert.ok(html.includes(text), `누락: ${text}`);
  });
}

test('식 번호 복구는 목록·인용·제목·표의 구분자를 수식으로 삼키지 않는다', () => {
  const tex = String.raw`E=mc^2 \tag{1}`;
  const cases = [
    [tex, '<span'], ['> ' + tex, '<blockquote>'], ['- ' + tex, '<ul>'], ['1. ' + tex, '<ol>'],
    ['> 1. ' + tex, '<blockquote>'], ['## ' + tex, '<h2>'],
    ['| 수식 | 비고 |\n|---|---|\n| ' + tex + ' | 보존 |', '<table>'],
    ['> 설명\n> ' + tex, '<blockquote>'], ['- 설명\n  ' + tex, '<ul>'],
  ];
  for (const [md, container] of cases) {
    const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
      remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS,
    }, md));
    assert.ok(html.includes(container), `${container} 사라짐: ${md}`);
    assert.ok(html.includes(`<annotation encoding="application/x-tex">${tex}</annotation>`), md);
    assert.doesNotMatch(html, /math-error/);
  }
});
