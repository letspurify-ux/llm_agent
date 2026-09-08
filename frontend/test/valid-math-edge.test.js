import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { spawnSync } from 'node:child_process';
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '../src/math.js';
import { EDGE_CASES, edgeAnswer, VALID_EDGE_ANSWER } from './valid-math-edge-corpus.js';
import { MATH_CORPUS } from './math-corpus.js';
import { compatibleEnvironments } from '../src/tex-environments.js';
const render = md => renderToStaticMarkup(React.createElement(Markdown, {
  remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS,
}, md));
const plain = md => renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [remarkGfm] }, md));
const nodes = html => {
  const found = []; const walk = n => { found.push(n); for (const c of n.children ?? []) walk(c); };
  walk(fromHtmlIsomorphic(html, { fragment: true })); return found;
};
const text = n => n.value ?? (n.children ?? []).map(text).join('');
for (const c of EDGE_CASES) test(`정상 입력 경계: ${c.name}`, () => {
  for (const newline of ['\n', '\r\n']) {
    const md = edgeAnswer(c).replaceAll('\n', newline);
    const html = render(md); const tree = nodes(html);
    assert.deepEqual(tree.filter(n => n.tagName === 'annotation').map(text), [c.tex], md);
    assert.doesNotMatch(html, /math-error|LLMMATHPLACEHOLDER/);
    assert.ok(html.includes('정상 입력 검증 끝'));
    for (const tag of ['blockquote', 'ol', 'ul', 'li'])
      assert.equal(tree.filter(n => n.tagName === tag).length, nodes(plain(md)).filter(n => n.tagName === tag).length, `${tag} 구조 변경`);
    if (c.href) {
      const links = tree.filter(n => n.tagName === 'a');
      assert.equal(links.length, 1); assert.equal(links[0].properties.href, c.href);
      assert.equal(links[0].properties.title, '수식 제목');
    }
  }
});

test('정상 입력 경계: 긴 답변에 모든 예제를 함께 넣어도 서로의 수식·링크를 침범하지 않는다', () => {
  const html = render(VALID_EDGE_ANSWER); const tree = nodes(html);
  assert.deepEqual(tree.filter(n => n.tagName === 'annotation').map(text), EDGE_CASES.map(c => c.tex));
  assert.equal(tree.filter(n => n.tagName === 'a').length, EDGE_CASES.filter(c => c.href).length);
  assert.doesNotMatch(html, /math-error|LLMMATHPLACEHOLDER/);
});

test('정상 입력 경계: 수식 24종을 참조 링크·체크 목록·각주·취소선·굵게·기울임과 조합한다', () => {
  const wrappers = [
    ['a', s => `[${s}][ref]\n\n[ref]: /go`], ['input', s => `- [x] ${s}`],
    ['section', s => `설명[^n]\n\n[^n]: ${s}`], ['del', s => `~~${s}~~`],
    ['strong', s => `**${s}**`], ['em', s => `*${s}*`],
  ];
  for (const tex of MATH_CORPUS) for (const [tag, wrap] of wrappers) {
    const md = wrap(`$${tex}$`); const html = render(md); const tree = nodes(html);
    assert.deepEqual(tree.filter(n => n.tagName === 'annotation').map(text), [compatibleEnvironments(tex)], md);
    assert.doesNotMatch(html, /math-error|LLMMATHPLACEHOLDER/);
    assert.ok(tree.some(n => n.tagName === tag), `${tag} 구조가 사라짐: ${md}`);
    if (tag === 'input') assert.ok(tree.some(n => n.tagName === 'input' && n.properties.checked));
    if (tag === 'a') assert.ok(tree.some(n => n.tagName === 'a' && n.properties.href === '/go'));
  }
});

test('정상 입력 경계: 불완전한 수식이 다른 목록·인용문의 내용을 수식으로 가져오지 않는다', () => {
  for (const md of [String.raw`- \(x=1` + '\n' + String.raw`- y=2\)`,
    String.raw`> \[x=1` + '\n\n' + String.raw`설명 보존\]`,
    '$x=1$\n\n> \\tag{2}', '- $x=1$\n- \\tag{2}']) {
    const html = render(md); const tree = nodes(html);
    assert.ok(!tree.filter(n => n.tagName === 'annotation').some(n => /y=2|설명|tag/.test(text(n))), md);
    assert.equal(tree.filter(n => n.tagName === 'li').length, nodes(plain(md)).filter(n => n.tagName === 'li').length);
  }
});

test('정상 입력 경계: 긴 일반 텍스트의 식 번호 탐색이 화면을 멈추지 않는다', () => {
  // 동기 정규식은 node:test의 timeout으로 중단되지 않는다. 자식 프로세스에 실제 제한을 건다.
  const code = `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import Markdown from 'react-markdown'; import {REMARK_PLUGINS,REHYPE_PLUGINS} from './src/math.js';
    for (const text of ['='.repeat(70000), 'x' + '='.repeat(70000) + '\\\\tag{']) {
      const html = renderToStaticMarkup(React.createElement(Markdown,
        {remarkPlugins:REMARK_PLUGINS,rehypePlugins:REHYPE_PLUGINS}, text));
      if (html.includes('katex')) throw new Error('일반 텍스트를 수식으로 바꿨다');
    }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
