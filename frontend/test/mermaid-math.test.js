import { test } from 'node:test';
import assert from 'node:assert/strict';
import mermaid from 'mermaid';
import React from 'react';
import Markdown from 'react-markdown';
import { renderToStaticMarkup } from 'react-dom/server';
import { mermaidMathLabels } from '../src/markdown.js';
import { mermaidMathExpressions, replaceMermaidMath, mermaidMathML, prepareMermaidMath } from '../src/mermaid-math.js';
import { REMARK_PLUGINS, REHYPE_PLUGINS, renderMathML } from '../src/math.js';
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic';
import { MERMAID_MATH_CASES, MERMAID_MULTILINE_MATH, MERMAID_NATIVE_MATH_CASES } from './mermaid-math-corpus.js';
import { MIXED_WRAPPERS } from './mixed-content-corpus.js';

mermaid.initialize({ startOnLoad: false });

test('Mermaid 수식 후보는 실제 그림 종류로 선택하며 정상 연결·서식 기호에 가려지지 않는다', () => {
  for (const { source } of MERMAID_MATH_CASES)
    assert.equal(mermaidMathLabels(source, mermaid.detectType(source)), true, source);
  const sequence = 'sequenceDiagram\nA->>B: flowchart LR $$x^2$$';
  assert.equal(mermaidMathLabels(sequence, mermaid.detectType(sequence)), false);
});

test('Mermaid의 연결·라벨 서식·수식 원문은 표·목록·인용·개행 중첩 후에도 같다', () => {
  for (const { source } of [...MERMAID_MATH_CASES, ...MERMAID_NATIVE_MATH_CASES]) for (const wrap of Object.values(MIXED_WRAPPERS))
    for (const newline of ['\n', '\r\n', '\r']) for (const inCell of [false, true]) {
      const code = inCell ? '| L | M | R |\n|---|---|---|\n| LEFT | 앞<br>- ```mermaid\\n' + source.replaceAll('\n', '\\n') + '``` | RIGHT |'
        : '```mermaid\n' + source + '\n```';
      let tree;
      const html = renderToStaticMarkup(React.createElement(Markdown, {
        remarkPlugins: [...REMARK_PLUGINS, () => value => { tree = value; }], rehypePlugins: REHYPE_PLUGINS,
      }, wrap(code).replaceAll('\n', newline)));
      const codes = [];
      const visit = node => {
        if (node.type === 'code') codes.push(node);
        for (const child of node.children ?? []) visit(child);
      };
      visit(tree);
      assert.deepEqual(codes.map(({ lang, value }) => ({ lang, value: value.replace(/\r\n?/g, '\n') })),
        [{ lang: 'mermaid', value: source }]);
      assert.doesNotMatch(html, /LLMRICHTABLE|LLMMATHPLACEHOLDER|LLMCELLNODE/);
      if (inCell) assert.match(html, /<td>RIGHT<\/td>/);
    }
});

test('Mermaid 수식 변환은 주석·frontmatter·지시문의 코드 예시와 개행을 그대로 보존한다', () => {
  const metadata = [
    '%% $$\\unknown{x}$$\n',
    '---\ntitle: \'$$\\unknown{x}$$\'\n---\n',
    '%%{init: {\n"themeVariables": {"unused": "$$ignored$$"}\n}}%%\n',
  ];
  for (const prefix of metadata) for (const newline of ['\n', '\r\n', '\r']) {
    const source = (prefix + 'flowchart LR\nA["$$x^2$$"] --> B\n%% $$\\unknown{x}$$').replaceAll('\n', newline);
    assert.deepEqual(mermaidMathExpressions(source).map(span => span.value), ['x^2']);
    assert.equal(replaceMermaidMath(source, value => '<math>' + value + '</math>'), source.replace('$$x^2$$', '<math>x^2</math>'));
    const literalOnly = source.replace('$$x^2$$', '일반 라벨');
    assert.equal(mermaidMathLabels(literalOnly, mermaid.detectType(literalOnly.replace(/\r\n?/g, '\n'))), false);
  }
});

test('Mermaid 수식은 여러 줄·TeX 주석·verb·이스케이프 달러의 경계를 본문과 공유한다', () => {
  const formulas = [MERMAID_MULTILINE_MATH, String.raw`x^2+\verb|$$|`, String.raw`x^2+\verb*+$$+`,
    'x^2 % 닫는 표시 예시 $$\n+1', String.raw`x^2+\text{\$\$}`];
  for (const tex of formulas) for (const newline of ['\n', '\r\n', '\r']) {
    assert.doesNotThrow(() => renderMathML(tex));
    const value = tex.replaceAll('\n', newline);
    const source = 'flowchart LR\nA["$$' + value + '$$"] --> B["$$z^2$$"]';
    assert.deepEqual(mermaidMathExpressions(source).map(span => span.value), [value, 'z^2']);
    assert.equal(replaceMermaidMath(source, () => 'MATH'), 'flowchart LR\nA["MATH"] --> B["MATH"]');
  }
});

test('여러 줄 Mermaid 수식은 목록·인용·각주 중첩 뒤 원문을 유지한다', () => {
  const body = 'flowchart LR\nA["$$' + MERMAID_MULTILINE_MATH + '$$"] --> B';
  const wrappers = [...Object.values(MIXED_WRAPPERS), s => '본문[^m]\n\n[^m]: 그림\n\n' + s.split('\n').map(line => '    ' + line).join('\n')];
  for (const wrap of wrappers) for (const newline of ['\n', '\r\n', '\r']) {
    const source = wrap('```mermaid\n' + body + '\n```').replaceAll('\n', newline);
    let tree;
    renderToStaticMarkup(React.createElement(Markdown, {
      remarkPlugins: [...REMARK_PLUGINS, () => value => { tree = value; }], rehypePlugins: REHYPE_PLUGINS,
    }, source));
    const codes = [];
    const visit = node => { if (node.type === 'code') codes.push(node); for (const child of node.children ?? []) visit(child); };
    visit(tree);
    assert.deepEqual(codes.map(node => node.value.replace(/\r\n?/g, '\n')), [body]);
  }
});

test('수식 라벨 실패는 그 라벨의 원문만 돌려주며 다른 라벨·비라벨 후보는 계속 처리한다', async () => {
  const source = String.raw`flowchart LR
A["$$\unknown{x}$$"] --> B["$$x^2$$"]
click B "https://example.test/$$literal$$"`;
  // DOM이 필요한 Mermaid 파서의 실제 라벨·연결 검증은 Chrome 교차 검사에서 수행한다.
  // 여기서는 파서가 판정한 문법 역할 뒤의 오류 처리 계약과 콜백 호출 범위를 검사한다.
  const values = [];
  const result = await prepareMermaidMath(source, async marked => {
    if (marked.includes('BOUNDARY')) throw new Error('이 단위 검사는 TeX 확장 문법의 파서 결과를 제공한다');
    return { db: {
    getVertices: () => new Map([['A', { id: 'A', text: 'LLMMERMAIDMATH0END' }], ['B', { id: 'B', text: 'LLMMERMAIDMATH1END' }]]),
    getEdges: () => [], getSubGraphs: () => [],
  } }; }, tex => { values.push(tex); return mermaidMathML(renderMathML(tex)); });
  assert.deepEqual(values, [String.raw`\unknown{x}`, 'x^2']);
  assert.deepEqual(result.errors, [String.raw`$$\unknown{x}$$`]);
  assert.ok(result.math);
  assert.match(result.source, /A\["수식 오류 1"\]/);
  assert.match(result.source, /<math/);
  assert.ok(result.source.endsWith('click B "https://example.test/$$literal$$"'));
});

test('Mermaid 안의 MathML은 바깥 따옴표와 충돌하지 않고 문자·속성·수식 의미를 보존한다', () => {
  const semanticTree = value => {
    const strip = node => {
      delete node.position;
      // Mermaid가 제거하는 대체 TeX annotation은 화면 수식의 의미 트리에서 제외한다.
      if (node.children) node.children = node.children.filter(child => child.tagName !== 'annotation');
      for (const child of node.children ?? []) strip(child);
      // 같은 서식의 인접 mtext는 한 텍스트와 같은 의미다. mrow가 묶음을 유지한다.
      if (node.tagName === 'mrow' && node.children.length && node.children.every(child => child.tagName === 'mtext')) {
        for (const child of node.children) assert.deepEqual(child.properties, node.children[0].properties);
        node.tagName = 'mtext'; node.properties = node.children[0].properties;
        node.children = [{ type: 'text', value: node.children.flatMap(child => child.children).map(child => child.value).join('') }];
      }
      return node;
    };
    return strip(fromHtmlIsomorphic(value, { fragment: true }));
  };
  for (const tex of ['x^2', String.raw`\frac{1}{2}`, String.raw`\sqrt[3]{x}`, String.raw`\sum_{i=1}^n i`,
    String.raw`\text{a"b'c\;d}`, String.raw`\text{a<br>b}`, String.raw`\text{a=b}`, String.raw`\text{\&}`,
    String.raw`x^2+\text{a,b: [c]}+\frac{1}{2}`, String.raw`\text{\#1}`, String.raw`\text{\&quot;}`,
    String.raw`x^2+(a|b)`, String.raw`\text{a,b: [c] \$\$d\$\$}`,
    String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`, String.raw`\underbrace{x+y}_{z}`]) {
    const html = renderMathML(tex), embedded = mermaidMathML(html);
    assert.doesNotMatch(embedded, /["']/);
    // Mermaid의 #번호; 문자 참조는 렌더 시 HTML의 &#번호;가 된다.
    assert.deepEqual(semanticTree(embedded.replace(/#(\d+);/g, '&#$1;')), semanticTree(html), tex);
  }
});
