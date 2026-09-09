import { test } from 'node:test';
import assert from 'node:assert/strict';
import mermaid from 'mermaid';
import React from 'react';
import Markdown from 'react-markdown';
import { renderToStaticMarkup } from 'react-dom/server';
import { mermaidMathLabels } from '../src/markdown.js';
import { mermaidMathExpressions, replaceMermaidMath, mermaidMathML } from '../src/mermaid-math.js';
import { REMARK_PLUGINS, REHYPE_PLUGINS, renderMathML } from '../src/math.js';
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic';
import { MERMAID_MATH_CASES } from './mermaid-math-corpus.js';
import { MIXED_WRAPPERS } from './mixed-content-corpus.js';

mermaid.initialize({ startOnLoad: false });

test('Mermaid 수식 후보는 실제 그림 종류로 선택하며 정상 연결·서식 기호에 가려지지 않는다', () => {
  for (const { source } of MERMAID_MATH_CASES)
    assert.equal(mermaidMathLabels(source, mermaid.detectType(source)), true, source);
  const sequence = 'sequenceDiagram\nA->>B: flowchart LR $$x^2$$';
  assert.equal(mermaidMathLabels(sequence, mermaid.detectType(sequence)), false);
});

test('Mermaid의 연결·라벨 서식·수식 원문은 표·목록·인용·개행 중첩 후에도 같다', () => {
  for (const { source } of MERMAID_MATH_CASES) for (const wrap of Object.values(MIXED_WRAPPERS))
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
