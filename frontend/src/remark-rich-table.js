// GFM 표 셀의 제한된 확장: <br> 줄바꿈과 언어가 명시된 직렬화 시각화만 처리한다.
// 일반 HTML·일반 인라인 코드는 실행하거나 재해석하지 않는다.
import { decodeSerializedLines } from './serialized-markdown.js';
const BR = /\\?<br\s*\/?>/gi;

// GFM은 인라인 코드 안의 |도 열 구분자로 읽는다. 명시적인 시각화 코드 안의
// 파이프만 먼저 보호해 표가 데이터 열을 버리지 않도록 한다. 개행 수는 바뀌지 않는다.
export function remarkProtectTableVisualizations() {
  const processor = this;
  return (tree, file) => {
    const source = String(file);
    const edits = [];
    let prefix = 'LLMRICHTABLE';
    while (source.includes(prefix)) prefix += 'X';
    const values = new Map();
    const visit = node => {
      if (node.type === 'tableRow') {
        const start = node.position.start.offset;
        const row = source.slice(start, node.position.end.offset);
        const opener = /((?:\\?`)+)(chart|mermaid)(?=(?:\\r)?\\n|\\?<br\s*\/?>)/gi;
        for (const match of row.matchAll(opener)) {
          if (edits.at(-1)?.end > start + match.index) continue;
          const fence = match[1];
          const bodyStart = match.index + fence.length;
          const end = row.indexOf(fence, bodyStart + match[2].length);
          if (end < 0) continue;
          // 바깥 GFM 표의 이스케이프 한 겹을 벗긴다. 내부 표 값의 \|는
          // 바깥 셀에서 \\\|로 써야 하며, 코드 노드로 재파싱하며 잃지 않도록 보관한다.
          const body = row.slice(bodyStart, end).replace(/(\\+)\|/g,
            (_whole, slashes) => '\\'.repeat(Math.floor(slashes.length / 2)) + '|');
          const token = prefix + values.size;
          values.set(token, body);
          edits.push({ start: start + match.index, end: start + end + fence.length, value: '`' + token + '`' });
        }
        return;
      }
      if (node.type === 'code') return;
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
    if (!edits.length) return tree;
    let result = '', at = 0;
    for (const edit of edits) { result += source.slice(at, edit.start) + edit.value; at = edit.end; }
    result += source.slice(at);
    if (result === source) return tree;
    file.data.richTableVisualizations = values;
    file.value = result;
    return processor.parse(result);
  };
}

export function tableVisualization(value) {
  const raw = String(value ?? '').trim();
  const match = /^(?:`+|~{3,})?(mermaid|chart)(?:(?:\\r)?\\n|\r\n?|\n|\\?<br\s*\/?>)/i.exec(raw);
  if (!match) return null;
  let body = raw.slice(match[0].length).replace(/(?:`+|~{3,})\s*$/, '');
  // \n으로 직렬화된 조회 데이터의 '<br>' 값은 그대로다. br 구분자를 선택한 코드만 변환한다.
  body = /<br/i.test(match[0]) ? body.replace(BR, '\n') : decodeSerializedLines(body);
  body = body.trim();
  return { type: 'code', lang: match[1].toLowerCase(), value: body };
}

// 강조·링크 안의 줄바꿈도 서식을 유지하면서 줄 단위로 나눈다.
function linesOf(node) {
  if (node.type === 'inlineCode') {
    const code = tableVisualization(node.value);
    if (code) return [[], [code], []];
  }
  if (node.type === 'break' || (node.type === 'html' && /^<br\s*\/?>$/i.test(node.value))) return [[], []];
  if (node.type === 'text') return node.value.split(BR).map(value => value ? [{ ...node, value }] : []);
  if (['strong', 'emphasis', 'delete', 'link', 'linkReference'].includes(node.type)) {
    const lines = splitLines(node.children);
    return lines.map(children => children.length === 1 && children[0].type === 'code'
      ? children : children.length ? [{ ...node, children }] : []);
  }
  return [[node]];
}
function splitLines(children) {
  const lines = [[]];
  for (const child of children) {
    const split = linesOf(child);
    lines.at(-1).push(...split[0]);
    lines.push(...split.slice(1));
  }
  return lines;
}
const paragraph = children => ({ type: 'paragraph', children });
function blocksOf(lines) {
  const blocks = [];
  let current = [];
  const flush = () => { if (current.length) blocks.push(paragraph(current)); current = []; };
  for (const line of lines) {
    if (!line.some(node => node.type !== 'text' || node.value.trim())) { flush(); continue; }
    if (line.length === 1 && line[0].type === 'code') { flush(); blocks.push(line[0]); continue; }
    const first = line[0];
    const quote = first?.type === 'text' && /^\s*>\s?/.exec(first.value);
    if (quote) {
      flush();
      let block = blocks.at(-1);
      if (block?.type !== 'blockquote') { block = { type: 'blockquote', children: [] }; blocks.push(block); }
      block.children.push(paragraph([{ ...first, value: first.value.slice(quote[0].length) }, ...line.slice(1)]));
      continue;
    }
    const marker = first?.type === 'text' && /^\s*(?:([-+*])|(\d+)[.)])\s+/.exec(first.value);
    if (marker) {
      flush();
      const ordered = !!marker[2];
      let list = blocks.at(-1);
      if (list?.type !== 'list' || list.ordered !== ordered) {
        list = { type: 'list', ordered, start: ordered ? Number(marker[2]) : undefined, spread: false, children: [] };
        blocks.push(list);
      }
      list.children.push({ type: 'listItem', spread: false, children: [paragraph([
        { ...first, value: first.value.slice(marker[0].length) }, ...line.slice(1),
      ])] });
    } else {
      if (current.length) current.push({ type: 'break' });
      current.push(...line);
    }
  }
  flush();
  return blocks;
}
export default function remarkRichTable() {
  return (tree, file) => {
    const restore = node => {
      if (node.type === 'inlineCode' && file.data.richTableVisualizations?.has(node.value)) {
        node.value = file.data.richTableVisualizations.get(node.value);
      }
      for (const child of node.children ?? []) restore(child);
    };
    restore(tree);
    const visit = node => {
      // 표 밖에서도 독립된 시각화 코드 한 덩어리는 같은 렌더 경로를 사용한다.
      if (node.type === 'paragraph') {
        const meaningful = node.children.filter(child => child.type !== 'text' || child.value.trim());
        if (meaningful.length === 1 && ['inlineCode', 'text'].includes(meaningful[0].type)) {
          const code = tableVisualization(meaningful[0].value);
          if (code) return code;
        }
      }
      if (node.type === 'tableCell') {
        // 전체 셀의 시각화 또는 설명 사이의 완전한 시각화 코드만 블록으로 승격한다.
        const meaningful = node.children.filter(child => child.type !== 'text' || child.value.trim());
        const only = meaningful.length === 1 && meaningful[0];
        const code = only && ['inlineCode', 'text'].includes(only.type) && tableVisualization(only.value);
        if (code) node.children = [code];
        else {
          const lines = splitLines(node.children);
          if (lines.length <= 1) return node;
          node.children = blocksOf(lines);
        }
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, className: ['rich-cell'] } };
        return node;
      }
      if (node.children) node.children = node.children.map(visit);
      return node;
    };
    visit(tree);
  };
}
