// 요청 안의 자료 보관과 프롬프트 표시를 분리한다. 보관한 청크는 검색 순서가 바뀌어도 잃지 않는다.
import { buildItems, planRanges, canGrow } from './chunk.js';
import { MAX_DOC_LEN, indentLines } from './constants.js';

const overlaps = (a, b) => a.doc_seq === b.doc_seq && a.from <= b.to && b.from <= a.to;
const contains = (a, b) => a.from <= b.from && a.to >= b.to;
const cost = row => indentLines(row.content).length;

function parts(chunks, distance, maxDocLen = MAX_DOC_LEN) {
  const hits = chunks.map(c => ({ ...c, _dist: c._dist ?? distance }));
  hits.sort((a, b) => a._dist - b._dist);
  return buildItems(planRanges(hits, { gapFill: 0 }), hits, { maxDocLen });
}

// 새 구간에서 이미 보관한 청크를 빼고 추가한다. 겹치는 한 구간과 합쳐도 상한 안이면 합친다.
// 기존 식별자는 삭제하거나 바꾸지 않는다. 숨긴 구간도 보관하므로 재검색만으로 되살아나지 않는다.
export function absorbKnowledge(list, row) {
  if (!Number.isInteger(row.from) || !Number.isInteger(row.to)) {
    const old = list.find(r => r.doc_seq === row.doc_seq);
    return old ? { front: old.dropped ? [] : [old], added: [], progress: 0 }
      : { front: [row], added: [row], progress: 1 };
  }
  const matched = list.filter(old => overlaps(old, row));
  const front = matched.filter(old => !old.dropped);
  if (!matched.length) return { front: [row], added: [row], progress: 1 };

  if (row.chunks?.length) {
    if (matched.length === 1 && !matched[0].dropped && !matched[0].expanded && matched[0].chunks?.length) {
      const old = matched[0];
      const byNo = new Map([...row.chunks, ...old.chunks].map(c => [c.chunk_no, c]));
      const merged = parts([...byNo.values()], Math.min(old._dist, row._dist));
      if (merged.length === 1 && contains(merged[0], old) && contains(merged[0], row) && cost(merged[0]) <= MAX_DOC_LEN) {
        const progress = merged[0].content !== old.content ? 1 : 0;
        // full(더 받을 것이 없다)은 지운 채 다시 세우지 않는다. 병합은 두 구간의 청크만 손에 들고 있어 이웃을 모르므로
        // buildItems가 세운 full은 문서 경계에서만 참이다 — 그대로 덮어쓰면 검색이 이웃 한 조각을 함께 읽어 확정한
        // '이웃이 문서당 상한에 들어가지 않는다'(chunk.js buildItems의 closed)가 같은 구간의 재검색 한 번에 사라지고,
        // 그 항목에 '(확대 가능)'이 되살아난다. 모델이 그 표시를 따라 청구하면 한 글자도 늘지 않은 채 '더 넓힐 수 없다'
        // 안내와 헛돈 스텝을 받는다(실측 — 상한 근처까지 찬 절 하나가 두 검색에 연속 적중하는 경우). 한쪽이 full이면
        // 합친 구간도 full이다: 합친 구간은 그쪽을 품고, 이어 붙인 본문의 길이는 구간이 넓어질수록 줄지 않으므로
        // 그쪽 이웃이 들어가지 않았으면 합친 구간의 이웃도 들어가지 않는다(문서 경계도 그대로다).
        // rep(대표 청크)도 지킨다 — seq가 그 청크의 것이라 둘은 함께 움직여야 한다(chunk.js buildItems의 rep 주석).
        Object.assign(old, merged[0], {
          seq: old.seq, rep: old.rep ?? merged[0].rep,
          full: Boolean(old.full || row.full || merged[0].full),
        });
        return { front, added: [], progress };
      }
    }
    const unseen = row.chunks.filter(c => !matched.some(old =>
      old.chunks ? old.chunks.some(h => h.chunk_no === c.chunk_no) : c.chunk_no >= old.from && c.chunk_no <= old.to));
    const added = parts(unseen, row._dist);
    return { front: [...front, ...added], added, progress: added.length };
  }

  // 청크 원본 없는 호출도 기존 근거를 교체하지 않는다. 온전히 이미 있는 구간만 중복으로 본다.
  if (matched.some(old => contains(old, row))) return { front, added: [], progress: 0 };
  const same = matched.find(old => old.seq === row.seq);
  if (same) {
    if (!same.dropped && !same.expanded && contains(row, same)) {
      Object.assign(same, row);
      return { front, added: [], progress: 1 };
    }
    return { front, added: [], progress: 0 };
  }
  return { front: [...front, row], added: [row], progress: 1 };
}

// 표시할 때만 문서별 총량을 적용한다. 펼친 구간과 검색 구간이 겹쳐도 같은 청크를 두 번 싣지 않는다.
export function knowledgeView(items) {
  const docs = new Map();
  return items.flatMap(item => {
    if (item.dropped || item.doc_seq == null) return [item];
    if (!docs.has(item.doc_seq)) docs.set(item.doc_seq, { used: 0, seen: new Set() });
    const doc = docs.get(item.doc_seq);
    const room = MAX_DOC_LEN - doc.used;
    if (!item.chunks?.length) {
      if (Math.min(cost(item), MAX_DOC_LEN) > room) return [{ ...item, viewOmitted: true }];
      doc.used += Math.min(cost(item), MAX_DOC_LEN);
      return [item];
    }
    const unseen = item.chunks.filter(c => !doc.seen.has(c.chunk_no));
    const shown = [];
    for (const part of parts(unseen, item._dist, Math.max(0, room))) {
      if (cost(part) > MAX_DOC_LEN - doc.used) continue;
      doc.used += cost(part);
      part.chunks.forEach(c => doc.seen.add(c.chunk_no));
      shown.push({ ...part, seq: item.seq, expanded: item.expanded, more: canGrow(item) });
    }
    if (shown.length && shown.reduce((n, p) => n + p.chunks.length, 0) < unseen.length) {
      shown[0].moreStored = true;
    }
    return shown.length ? shown : [{ ...item, viewOmitted: true }];
  });
}
