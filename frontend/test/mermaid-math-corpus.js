// Mermaid가 허용하는 연결 문법과 라벨 서식을 수식과 함께 사용한다.
const SHAPE_MATH = String.raw`x^2+\text{a,b: [c] \$\$d\$\$}+\frac{1}{2}`;
export const MERMAID_MATH_CASES = [
  { id: 'bidirectional', source: 'flowchart LR\nA["$$x^2$$"] <--> B', nodes: 2 },
  { id: 'multiple-nodes', source: 'flowchart LR\nA["$$x^2$$"] & B --> C', nodes: 3 },
  { id: 'label-break', source: 'flowchart LR\nA["$$x^2$$<br/>설명"] --> B', nodes: 2, label: '설명' },
  { id: 'label-entity', source: 'flowchart LR\nA["$$x^2$$"] --> B["A &amp; B"]', nodes: 2, label: 'A & B' },
  { id: 'markdown-label', source: 'flowchart LR\nA["`**수식** $$x^2$$`"] --> B', nodes: 2, label: '수식', bold: true },
  { id: 'default-direction', source: 'flowchart\nA["$$x^2$$"] --> B', nodes: 2 },
  { id: 'frontmatter', source: '---\ntitle: 혼합 그림\n---\ngraph LR\nA["$$x^2$$"] <==> B', nodes: 2 },
  { id: 'metadata-literals', source: '---\ntitle: \'원문 $$\\unknown{x}$$\'\n---\n%% $$\\unknown{x}$$\n' +
    '%%{init: {"themeVariables": {"unused": "$$ignored$$"}}}%%\nflowchart LR\nA["$$x^2$$"] --> B', nodes: 2 },
  { id: 'literal-link-tooltip', source: 'flowchart LR\nA["$$x^2$$"] --> B\n' +
    'click A "https://example.test/$$x$$" "원문 $$\\unknown{x}$$"', nodes: 2,
    href: 'https://example.test/$$x$$' },
  { id: 'literal-accessibility', source: 'flowchart LR\naccTitle: 원문 $$\\unknown{x}$$\n' +
    'accDescr { 설명 $$\\unknown$$ }\nA["$$x^2$$"] --> B', nodes: 2,
    accessibleTitle: '원문 $$\\unknown{x}$$' },
  { id: 'shape-single-quoted', source: "flowchart LR\nA@{ shape: rect, label: '$$" + SHAPE_MATH + "$$' } --> B", nodes: 2,
    mathText: 'a,b:\u00a0[c]\u00a0$$d$$', fractions: 1 },
  { id: 'shape-double-quoted', source: 'flowchart LR\nA@{ shape: rect, label: "$$' + SHAPE_MATH + '$$" } --> B', nodes: 2,
    mathText: 'a,b:\u00a0[c]\u00a0$$d$$', fractions: 1 },
  { id: 'edge-label', source: 'flowchart LR\nA -->|"$$x^2$$"| B', nodes: 2 },
  { id: 'subgraph-label', source: 'flowchart LR\nsubgraph S["$$x^2$$"]\nA --> B\nend', nodes: 2 },
  { id: 'literal-only', source: 'flowchart LR\nA --> B\n' +
    'click A "https://example.test/$$x$$" "원문 $$\\unknown{x}$$"', nodes: 2,
    href: 'https://example.test/$$x$$', mathCount: 0 },
  { id: 'shape-unquoted', source: 'flowchart LR\nA@{ shape: rect, label: $$' + SHAPE_MATH + '$$ } --> B', nodes: 2,
    mathText: 'a,b:\u00a0[c]\u00a0$$d$$', fractions: 1 },
  { id: 'node-unquoted', source: 'flowchart LR\nA[$$x^2+(a|b)$$] --> B', nodes: 2 },
  { id: 'token-literal', source: 'flowchart LR\nA["LLMMERMAIDMATH0END $$x^2$$"] --> B', nodes: 2,
    label: 'LLMMERMAIDMATH0END' },
];
