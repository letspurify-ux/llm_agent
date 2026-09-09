import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import { markdownLiteralRanges, mergeLiteralRanges } from '../../shared/inline-code.mjs';
import { normalizeSerializedMarkdown } from '../../shared/serialized-markdown.mjs';
import { analyzeRichStructure } from '../../shared/rich-table-structure.mjs';

const extensions = [gfm(), math({ singleDollarTextMath: false })];
const mdastExtensions = [gfmFromMarkdown(), mathFromMarkdown()];
const parse = source => fromMarkdown(source, { extensions, mdastExtensions });
const parseWithoutTables = source => fromMarkdown(source, {
  extensions: [...extensions, { disable: { null: ['table'] } }], mdastExtensions,
});

// 조회 주입은 화면에서 실제 코드가 되는 원문에만 적용한다. 펜스 모양만 보면
// HTML·들여쓴 코드·각주 이름·수식 안의 예시까지 데이터로 바꾸게 된다.
export function answerSyntax(source, { serialized = false } = {}) {
  try {
    let tree = parse(source);
    if (serialized) {
      const normalized = normalizeSerializedMarkdown(source, tree, parse, parseWithoutTables);
      if (normalized !== source) { source = normalized; tree = parse(source); }
    }
    const codes = new Map();
    const tableRows = [], tableCells = [], standalone = [];
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop();
      if (node.type === 'code') codes.set(node.position.start.offset, node);
      for (const child of node.children ?? []) pending.push(child);
    }
    let literals = [];
    if (serialized) {
      // 표 셀로 나뉘기 전의 링크·속성·각주를 읽되 다른 GFM 문법은 그대로 유지한다.
      const wholeRows = parseWithoutTables(source);
      const { candidates, structure, ownership } = analyzeRichStructure(source, tree, parse, () => wholeRows);
      literals = mergeLiteralRanges([
        ...markdownLiteralRanges(ownership, source),
        ...candidates.map(({ start, end }) => [start, end]),
      ]);
      // 표시 값은 원문 AST에서, 표·문단의 경계는 화면과 같은 구조 분석에서 읽는다.
      tree = structure;
    }
    const scopes = [tree];
    while (scopes.length) {
      const node = scopes.pop();
      if (node.type === 'tableRow') tableRows.push([node.position.start.offset, node.position.end.offset]);
      if (node.type === 'tableCell') tableCells.push([node.position.start.offset, node.position.end.offset]);
      if (node.type === 'paragraph') standalone.push([node.position.start.offset, node.position.end.offset]);
      for (const child of node.children ?? []) scopes.push(child);
    }
    return { source, codes, literals, tableRows, tableCells, standalone };
  } catch {
    // 파서가 처리하지 못한 극단적인 중첩은 원문으로 남긴다.
    return { source, codes: new Map(), literals: [[0, source.length]], tableRows: [], tableCells: [], standalone: [] };
  }
}
