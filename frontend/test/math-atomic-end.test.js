import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMathSpans } from '../../shared/math-spans.mjs';

const read = (source, atomicRanges) => {
  const tree = { type: 'root', children: [] };
  return collectMathSpans(tree, source, undefined, tree, atomicRanges).candidates;
};

test('수신 조각 마지막의 수식 구분자도 내부 언어가 소유하면 바깥 수식을 닫지 않는다', () => {
  for (const [open, close] of [['$', '$'], ['$$', '$$'], ['\\(', '\\)'], ['\\[', '\\]']]) {
    const source = open + 'x^2 CODE' + close;
    const start = source.indexOf('CODE');
    assert.deepEqual(read(source, [{ start, end: source.length }]), [], source);
    // 문서가 이어져도 원자의 마지막 문자 소유권이 달라지지 않는다.
    assert.deepEqual(read(source + ' 다음 문장', [{ start, end: source.length }]), [], source);
  }
});

test('완성 수식에 맞닿은 다음 원자와 TeX 인자 안의 코드 예시는 정상 수식을 가리지 않는다', () => {
  const adjacent = '$x^2$`CODE`';
  assert.deepEqual(read(adjacent, [{ start: 5, end: adjacent.length }]).map(span => span.value), ['x^2']);
  const source = '$\\text{`mermaid\\n문자`}$';
  assert.deepEqual(read(source, [{ start: source.indexOf('`'), end: source.lastIndexOf('`') + 1 }])
    .map(span => span.value), ['\\text{`mermaid\\n문자`}']);
});
