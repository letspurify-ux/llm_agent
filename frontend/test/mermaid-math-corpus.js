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
  { id: 'verb-dollars', source: String.raw`flowchart LR
A["$$x^2+\verb|$$|$$"] --> B`, nodes: 2, mathText: '$$' },
  { id: 'invalid-label-isolation', source: String.raw`flowchart LR
A["$$\unknown{x}$$"] --> B["$$x^2$$"] --> C[정상]`, nodes: 3, errors: 1,
    errorSources: [String.raw`$$\unknown{x}$$`], label: '수식 오류 1' },
  { id: 'unclosed-label-before-math', source: 'flowchart LR\nA["$$unfinished"] --> B["$$x^2$$"] --> C',
    nodes: 3, label: '$$unfinished' },
  { id: 'unclosed-label-after-math', source: 'flowchart LR\nA["$$x^2$$"] --> B["cost $$"] --> C["literal $$"]',
    nodes: 3, label: 'cost $$' },
  { id: 'unclosed-edge-before-math', source: 'flowchart LR\nA -->|"cost $$"| B["$$x^2$$"] --> C', nodes: 3 },
  { id: 'unclosed-accessibility-before-math', source: 'flowchart LR\naccTitle: cost $$\nA["$$x^2$$"] --> B',
    nodes: 2, accessibleTitle: 'cost $$' },
  { id: 'unclosed-link-before-math', source: 'flowchart LR\nA --> B\nclick A "https://example.test/$$"\nB["$$x^2$$"]',
    nodes: 2, href: 'https://example.test/$$' },
  { id: 'unclosed-subgraph-before-math', source: 'flowchart LR\nsubgraph S["cost $$"]\nA["$$x^2$$"] --> B\nend', nodes: 2 },
  { id: 'unclosed-label-before-extended-math', source: String.raw`flowchart LR
A["$$\frac{1"] --> B@{label: '$$x^2+\frac{1}{2}$$'} --> C`, nodes: 3, fractions: 1, label: '$$\\frac{1' },
  { id: 'unclosed-edge-before-extended-math', source: String.raw`flowchart LR
A -- cost $$ --> B -->|"$$x^2+\text{a"b}$$"| C`, nodes: 3 },
  { id: 'parenthesis-node-math', source: 'flowchart LR\nA(($$x^2+(a|b)$$)) --> B', nodes: 2 },
  { id: 'unquoted-root-math', source: String.raw`flowchart LR
A[$$\sqrt[3]{x^2}$$] --> B`, nodes: 2 },
];

export const MERMAID_MULTILINE_MATH = String.raw`\begin{aligned}
 x^2 &= 1 \\
 y &= \frac{1}{2}
\end{aligned}`;

export const MERMAID_NATIVE_MATH_CASES = [
  { id: 'sequence-verb', source: String.raw`sequenceDiagram
A->>B: $$x^2+\verb|$$|$$`, mathText: '$$' },
  { id: 'sequence-literal-br', source: String.raw`sequenceDiagram
A->>B: $$x^2+\text{a<br>b}$$`, mathText: 'a<br>b' },
  { id: 'sequence-aligned', source: String.raw`sequenceDiagram
A->>B: $$\begin{aligned}x^2&=1\\y&=\frac{1}{2}\end{aligned}$$`, fractions: 1 },
  { id: 'sequence-invalid-isolation', source: String.raw`sequenceDiagram
A->>B: $$\unknown{x}$$
B-->>A: $$x^2$$`, errors: 1, errorSources: [String.raw`$$\unknown{x}$$`] },
  { id: 'state-verb', source: String.raw`stateDiagram-v2
s1: $$x^2+\verb|$$|$$
[*] --> s1`, mathText: '$$' },
  { id: 'class-verb', source: String.raw`classDiagram
class A["$$x^2+\verb|$$|$$"]`, mathText: '$$' },
  { id: 'class-literal-br', source: String.raw`classDiagram
class A["$$x^2+\text{a<br>b}$$"]`, mathText: 'a<br>b' },
  { id: 'state-literal-br', source: String.raw`stateDiagram-v2
s1: $$x^2+\text{a<br>b}$$
[*] --> s1`, mathText: 'a<br>b' },
  { id: 'state-invalid-isolation', source: String.raw`stateDiagram-v2
bad: $$\unknown{x}$$
good: $$x^2$$
[*] --> bad
bad --> good`, errors: 1, errorSources: [String.raw`$$\unknown{x}$$`] },
  { id: 'class-invalid-isolation', source: String.raw`classDiagram
class A["$$\unknown{x}$$"]
class B["$$x^2$$"]
A --> B`, errors: 1, errorSources: [String.raw`$$\unknown{x}$$`] },
];
