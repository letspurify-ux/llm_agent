import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import { collectMathSpans } from '../../shared/math-spans.mjs';
import { markdownLiteralRanges, mergeLiteralRanges } from '../../shared/inline-code.mjs';
import { normalizeSerializedMarkdown } from '../../shared/serialized-markdown.mjs';

const extensions = [gfm(), math({ singleDollarTextMath: false })];
const mdastExtensions = [gfmFromMarkdown(), mathFromMarkdown()];
const parse = source => fromMarkdown(source, { extensions, mdastExtensions });

// 조회 주입은 화면에서 실제 코드가 되는 원문에만 적용한다. 펜스 모양만 보면
// HTML·들여쓴 코드·각주 이름·수식 안의 예시까지 데이터로 바꾸게 된다.
export function answerSyntax(source, { serialized = false } = {}) {
  try {
    let tree = parse(source);
    if (serialized) {
      const normalized = normalizeSerializedMarkdown(source, tree, parse);
      if (normalized !== source) { source = normalized; tree = parse(source); }
    }
    const codes = new Map();
    const tableRows = [], standalone = [];
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop();
      if (node.type === 'code') codes.set(node.position.start.offset, node);
      if (node.type === 'tableRow') tableRows.push([node.position.start.offset, node.position.end.offset]);
      if (node.type === 'paragraph') standalone.push([node.position.start.offset, node.position.end.offset]);
      for (const child of node.children ?? []) pending.push(child);
    }
    let literals = [];
    if (serialized) {
      // 표 셀로 나뉘기 전의 링크·속성·각주를 읽되 다른 GFM 문법은 그대로 유지한다.
      const wholeRows = fromMarkdown(source, {
        extensions: [...extensions, { disable: { null: ['table'] } }], mdastExtensions,
      });
      const { candidates } = collectMathSpans(tree, source, parse);
      literals = mergeLiteralRanges([
        ...markdownLiteralRanges(wholeRows),
        ...candidates.map(({ start, end }) => [start, end]),
      ]);
    }
    return { source, codes, literals, tableRows, standalone };
  } catch {
    // 파서가 처리하지 못한 극단적인 중첩은 원문으로 남긴다.
    return { source, codes: new Map(), literals: [[0, source.length]], tableRows: [], standalone: [] };
  }
}
