import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '../src/math.js';
import { MIXED_WRAPPERS } from './mixed-content-corpus.js';
import { TABLE_LINK_CASES, TABLE_LINK_EXPECTED, TABLE_LINK_ANSWER } from './table-link-edge-corpus.js';
const render = md => renderToStaticMarkup(React.createElement(Markdown, {
  remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS,
}, md));
const nodes = html => {
  const all=[]; const walk=n=>{all.push(n);for(const c of n.children??[])walk(c);};
  walk(fromHtmlIsomorphic(html,{fragment:true}));return all;
};
const text = n => n.value ?? (n.children ?? []).map(text).join('');
for(const [name,wrap] of Object.entries(MIXED_WRAPPERS)) test(`표 링크 경계: ${name}에서 절댓값·행렬과 모든 링크 형식을 보존한다`,()=>{
  for(const c of TABLE_LINK_CASES) for(const newline of ['\n','\r\n']) {
    const md=wrap(c.md).replaceAll('\n',newline); const html=render(md); const tree=nodes(html);
    assert.deepEqual(tree.filter(n=>n.tagName==='annotation').map(text),[c.tex],md);
    const links=tree.filter(n=>n.tagName==='a');assert.equal(links.length,1,md);
    assert.equal(links[0].properties.href,c.href);assert.equal(links[0].properties.title,'원래 제목');
    const cells=tree.filter(n=>n.tagName==='td');assert.equal(cells.length,2,md);assert.equal(text(cells[1]),'보존');
    assert.doesNotMatch(html,/math-error|LLMMATHPLACEHOLDER/);
  }
});

test('표 링크 경계: 180개 표를 합쳐도 링크가 사라지거나 중복되지 않는다', () => {
  const html = render(TABLE_LINK_ANSWER); const tree = nodes(html);
  assert.deepEqual(tree.filter(n => n.tagName === 'annotation').map(text), TABLE_LINK_EXPECTED.map(c => c.tex));
  assert.deepEqual(tree.filter(n => n.tagName === 'a').map(n => n.properties.href), TABLE_LINK_EXPECTED.map(c => c.href));
  assert.equal(tree.filter(n => n.tagName === 'td').length, TABLE_LINK_EXPECTED.length * 2);
  assert.doesNotMatch(html, /math-error|llmmathplaceholder/i);
});

test('표 링크 경계: 수식 링크가 표 머리글에 있어도 표와 링크를 보존한다', () => {
  for (const wrap of Object.values(MIXED_WRAPPERS)) for (const c of TABLE_LINK_CASES)
    for (const newline of ['\n', '\r\n']) {
      const lines = c.md.split('\n');
      lines[0] = lines[2].replace(/보존 \|$/, '비고 |');
      lines[2] = '| 데이터 | 보존 |';
      const md = wrap(lines.join('\n')).replaceAll('\n', newline);
      const html = render(md); const tree = nodes(html);
      assert.deepEqual(tree.filter(n => n.tagName === 'annotation').map(text), [c.tex], md);
      assert.deepEqual(tree.filter(n => n.tagName === 'a').map(n => n.properties.href), [c.href], md);
      assert.equal(tree.filter(n => n.tagName === 'th').length, 2, md);
      assert.deepEqual(tree.filter(n => n.tagName === 'td').map(text), ['데이터', '보존'], md);
      assert.doesNotMatch(html, /math-error|llmmathplaceholder/i);
    }
});

test('표 링크 경계: 뒤에 스트리밍 중인 코드 펜스가 있어도 앞의 완성된 링크는 유지된다', () => {
  const c = TABLE_LINK_CASES[1];
  const suffix = '\n\n```text\n[$x=1$][literal]\n```\n\n끝';
  for (let i = 0; i <= suffix.length; i++) {
    const html = render(c.md + suffix.slice(0, i)); const tree = nodes(html);
    assert.deepEqual(tree.filter(n => n.tagName === 'a').map(n => n.properties.href), [c.href]);
    assert.equal(tree.filter(n => n.tagName === 'annotation').map(text)[0], c.tex);
    assert.doesNotMatch(html, /llmmathplaceholder/i);
  }
});
