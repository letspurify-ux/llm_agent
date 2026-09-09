import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mermaidMathExpressions, scopedMermaidMathExpressions } from '../../shared/mermaid-math-spans.mjs';
import { decodeSerializedLines, decodeVisualizationBreaks } from '../../shared/serialized-markdown.mjs';
import { prepareMermaidMath, replaceMermaidMath } from '../src/mermaid-math.js';

const formulas = ['x^2', String.raw`x^2+\frac{1}{2}`, String.raw`\sqrt[3]{x^2}`,
  String.raw`x^2+\text{a"b'c [d]}`, String.raw`x^2+\verb|$$|`, String.raw`x^2+\unknown{y}`];
const literals = ['cost $$', '$$unfinished', String.raw`$$\frac{1`];
const wrappers = [s => `A["${s}"]`, s => `A("${s}")`, s => `A{"${s}"}`,
  s => `A@{label: '${s}'}`, s => `A -->|"${s}"| B`, s => `subgraph S["${s}"]\nA-->B\nend`];

test('문법 범위 안에서만 수식을 짝짓고 비수식 원문을 한 글자도 삭제하지 않는다: 648개 조합', () => {
  for (const literal of literals) for (const wrap of wrappers) for (const tex of formulas)
    for (const newline of ['\n', '\r\n', '\r']) for (const first of [false, true]) {
      const math = `C["$$${tex}$$"] --> D`;
      const body = first ? math + '\n' + wrap(literal) : wrap(literal) + '\n' + math;
      const source = ('flowchart LR\n' + body).replaceAll('\n', newline);
      const spans = mermaidMathExpressions(source);
      assert.deepEqual(spans.map(span => span.value), [tex], source);
      assert.equal(replaceMermaidMath(source, () => 'FORMULA'), source.replace(`$$${tex}$$`, 'FORMULA'));
    }
});

test('직렬화 복원도 라벨 경계를 공유하고 TeX 명령·문자 br·verb 달러를 보존한다', () => {
  for (const literal of literals) for (const wrap of wrappers) for (const separator of ['\\n', '\\r\\n', '<br>', '<br/>']) {
    const tex = String.raw`x^2+\nleqq y+\text{a<br>b}+\verb|$$|`;
    const source = 'flowchart LR\n' + wrap(literal) + '\nC["$$' + tex + '$$"] --> D';
    const encoded = source.replaceAll('\n', separator);
    const decode = separator.startsWith('<') ? decodeVisualizationBreaks : decodeSerializedLines;
    assert.equal(decode(encoded, 'mermaid'), source, encoded);
    assert.deepEqual(scopedMermaidMathExpressions(source).map(span => span.value), [tex]);
  }
});

const diagram = (labels, edges = [{ start: 'A', end: 'B', type: 'arrow_point' }]) => ({ db: {
  getVertices: () => new Map(labels.map((text, index) => [index, { id: String.fromCharCode(65 + index), type: 'square', text }])),
  getEdges: () => edges, getSubGraphs: () => [],
} });

test('실제 파서가 다른 라벨로 분류한 구분자는 TeX 내용이 유효해도 결합하지 않는다', async () => {
  const source = 'flowchart LR\nA["cost $$"] --> B["$$x^2$$"]';
  const observed = [];
  const result = await prepareMermaidMath(source, async marked => {
    observed.push(marked);
    return marked.includes('BOUNDARY')
      ? diagram(['cost LLMMERMAIDMATHBOUNDARY0END', 'LLMMERMAIDMATHBOUNDARY1ENDx^2LLMMERMAIDMATHBOUNDARY2END'])
      : diagram(['cost $$', 'LLMMERMAIDMATH0END']);
  }, tex => { assert.equal(tex, 'x^2'); return 'FORMULA'; });
  assert.equal(result.source, 'flowchart LR\nA["cost $$"] --> B["FORMULA"]');
  assert.equal(observed.length, 2);
  assert.ok(observed.every(value => value.includes('] --> B[')));
});

test('파서의 후속 결과가 노드·연결·그룹을 변경하면 치환 결과를 거부한다', async () => {
  const source = 'flowchart LR\nA["$$x^2$$"] --> B';
  for (const mutate of [
    d => { d.db.getVertices = () => new Map([['A', { id: 'A', type: 'square', text: 'LLMMERMAIDMATH0END' }]]); },
    d => { d.db.getEdges = () => [{ start: 'B', end: 'A', type: 'arrow_point' }]; },
    d => { d.db.getSubGraphs = () => [{ id: 'new', nodes: ['A'] }]; },
  ]) {
    let rendered = false;
    await assert.rejects(prepareMermaidMath(source, async marked => {
      const d = diagram([marked.includes('BOUNDARY') ? 'LLMMERMAIDMATHBOUNDARY0ENDx^2LLMMERMAIDMATHBOUNDARY1END' : 'LLMMERMAIDMATH0END', 'B']);
      if (!marked.includes('BOUNDARY')) mutate(d);
      return d;
    }, () => { rendered = true; return 'FORMULA'; }), /그래프 구조/);
    assert.equal(rendered, false);
  }
});
