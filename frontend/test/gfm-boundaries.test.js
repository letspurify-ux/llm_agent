import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { fromMarkdown } from 'mdast-util-from-markdown';
import remarkGfmBounded from '../src/remark-gfm.js';
import { MIXED_WRAPPERS } from './mixed-content-corpus.js';

const render = (source, plugin) => renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [plugin] }, source));
const cases = [
  'a@example.test, <b@example.test>와 c+d@example.test.',
  'abc@localhost 및 a.b-c_d+e@example.test/path',
  'a!b#c$d%e&f\'g*h+i/j=k?l^m_n`o{p|q}r~s@example.test',
  'https://example.test/(a) HTTP://example.test/x?y=1&z=2 www.example.test/a.',
  'www.example.test/a_b 및 WWW.example.test/x',
  'https://example.test/a@b 와 [라벨](https://example.test/ref)',
  '주소 a\\@example.test, a&#64;example.test, a&nbsp;@example.test',
  '`a@example.test`와 `www.example.test`',
  '[a@example.test][ref]\n\n[ref]: https://example.test',
  '![a@example.test](https://example.test/image.png)',
  '\\[ x '.repeat(100) + ' contact@example.test',
  '| 주소 | 값 |\n|---|---|\n| a@example.test | www.example.test |',
  '- [x] **완료** ~~취소~~\n\n본문[^1]\n\n[^1]: a@example.test',
];

test('자동 링크 후보 최적화는 GFM의 링크·표·강조·각주·코드 결과와 동일하다', () => {
  for (const body of cases) for (const wrap of Object.values(MIXED_WRAPPERS)) for (const newline of ['\n', '\r\n', '\r']) {
    const source = wrap(body).replaceAll('\n', newline);
    assert.equal(render(source, remarkGfmBounded), render(source, remarkGfm), source);
  }
});

test('같은 파서로 다시 분석해도 이전 문서의 링크 후보 상태가 남지 않는다', () => {
  const bounded = unified().use(remarkParse).use(remarkGfmBounded);
  const control = unified().use(remarkParse).use(remarkGfm);
  for (const source of ['문자만', ...cases, '문자만', ...cases.toReversed()])
    assert.deepEqual(bounded.parse(source), control.parse(source));
});

test('확장을 독립 구조 분석에 전달해도 GFM 자동 링크 경계가 유지된다', () => {
  const bounded = unified().use(remarkParse).use(remarkGfmBounded).freeze();
  const control = unified().use(remarkParse).use(remarkGfm).freeze();
  const parse = (processor, source) => fromMarkdown(source, {
    extensions: [...processor.data('micromarkExtensions'), { disable: { null: ['table'] } }],
    mdastExtensions: processor.data('fromMarkdownExtensions'),
  });
  for (const source of [...cases, 'https://example.test/`chart\\ndata:step1`'])
    assert.deepEqual(parse(bounded, source), parse(control, source));
});
