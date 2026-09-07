// 요청 안의 자료 보관과 프롬프트 표시를 분리한다. 보관한 청크는 검색 순서가 바뀌어도 잃지 않는다.
import { buildItems, planRanges, canGrow, sameChunk } from './chunk.js';
import { MAX_DOC_LEN, indentLines } from './constants.js';

const overlaps = (a, b) => a.doc_seq === b.doc_seq && a.from <= b.to && b.from <= a.to;
const contains = (a, b) => a.from <= b.from && a.to >= b.to;
const cost = row => indentLines(row.content).length;

// context는 '범위를 정하는 데는 쓰지 않고 full 판정에만 보태는' 조각들이다 (chunk.js buildItems의 edges).
// 구간 계획은 chunks만 보고 세우고, buildItems에는 둘을 함께 넘긴다 — buildItems는 계획된 범위 안에서만
// 본문을 채우므로(grow=false) context가 본문에 섞이지 않고, 범위 밖 이웃이 상한에 들어가는지만 알려준다.
// 이 갈래가 없으면 합친 구간이 검색이 확정해 둔 full 판정을 세울 근거를 잃는다 (buildItems의 edges 주석).
// 같은 조각이 양쪽에 있으면 검색이 확보한 쪽을 남긴다 (Map은 나중 것이 이긴다).
function parts(chunks, distance, maxDocLen = MAX_DOC_LEN, context = []) {
  const hits = chunks.map(c => ({ ...c, _dist: c._dist ?? distance }));
  hits.sort((a, b) => a._dist - b._dist);
  const plans = planRanges(hits, { gapFill: 0 });
  return buildItems(plans, context.length ? [...context, ...hits] : hits, { maxDocLen });
}

// 두 구간이 들고 있던 '범위 밖 이웃'을 합친다.
const edgesOf = (...items) => items.flatMap(o => o?.edges ?? []);

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
      const original = new Map(old.chunks.map(c => [c.chunk_no, c]));
      const sameVersion = row.chunks.every(c =>
        c.doc_hash === old.chunks[0].doc_hash
        && (!original.has(c.chunk_no) || sameChunk(c, original.get(c.chunk_no))));
      const byNo = new Map([...row.chunks, ...old.chunks].map(c => [c.chunk_no, c]));
      const merged = sameVersion
        ? parts([...byNo.values()], Math.min(old._dist, row._dist), MAX_DOC_LEN, edgesOf(old, row))
        : [];
      if (merged.length === 1 && contains(merged[0], old) && contains(merged[0], row) && cost(merged[0]) <= MAX_DOC_LEN) {
        const progress = merged[0].content !== old.content ? 1 : 0;
        // full(더 받을 것이 없다)의 근거를 잃지 않는다. 잃으면 '(확대 가능)'이 되살아나고, 모델이 그 표시를 따라
        // 청구하면 한 글자도 늘지 않은 채 '더 넓힐 수 없다' 안내와 헛돈 스텝을 받는다 — 청구 기회는 둘뿐이다.
        // 근거를 지키는 길이 둘이고 둘 다 필요하다.
        //   ① 이웃 조각을 함께 넘긴다(edgesOf) — 검색이 계획 범위의 앞뒤 한 조각을 읽어 확정해 둔 판정을
        //      합친 구간에서도 그대로 다시 세울 수 있다. 이것이 없으면 각각은 더 넓힐 수 있었으나 합쳐서
        //      상한에 닿은 구간이 full=false로 남는다(실측: 3~8과 7~18이 3~18 9,452자가 되면 이웃 두 조각
        //      모두 상한을 넘는데 표시는 남아 있었다). ①은 ②가 답할 수 없는 이 경우를 답한다.
        //   ② 한쪽이 full이면 합친 구간도 full로 둔다 — 합친 구간은 그쪽을 품고, 이어 붙인 본문의 길이는
        //      구간이 넓어질수록 줄지 않으므로 그쪽 이웃이 들어가지 않았으면 합친 구간의 이웃도 들어가지
        //      않는다(문서 경계도 그대로다). 이웃을 읽지 못한 검색(보충 읽기 실패)에서는 ①이 비므로 ②가 남는다.
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
    const added = parts(unseen, row._dist, MAX_DOC_LEN, edgesOf(row));
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
    // 한 항목은 한 줄이다 — 줄의 번호가 곧 그 항목의 ID이고, 모델은 그 번호 하나로 확대·숨김을 지목한다.
    // 앞선 항목이 이 항목의 '가운데'를 이미 실었으면 남은 청크가 두 구간으로 갈라진다. 확대(agent.js growItem)는
    // 대표 청크에서 상한까지 넓히므로 같은 문서의 다른 보관 구간을 통째로 삼킬 수 있고, 그 구간이 뒤이어 복구
    // (applyExpand의 숨김 복구·우선 표시)로 앞에 오면 정확히 그 모양이 된다. 두 조각을 다 실으면 같은 번호의
    // 줄이 두 개가 되어 — 모델은 어느 쪽을 가리키는지 적을 방법이 없고, 하나를 버리려 해도 둘이 함께 사라지며,
    // 섹션 머리말의 건수(항목 수)보다 본문 줄이 많아져 '몇 건 중 몇 건이 실렸는가'가 어긋난다(실측·퍼저).
    // 그래서 한 구간만 싣는다. 고르는 기준은 대표 청크(rep)와의 거리다 — 검색이 '질문에 가장 가까운 청크'로
    // 고른 자리이므로 잘라야 한다면 그쪽을 남긴다. 나머지는 지워지지 않고 보관에 그대로 남아,
    // moreStored가 '보관 구간 더 있음'으로 알리고 같은 ID를 앞으로 가져오면(expand) 전부 실린다.
    const ranges = parts(unseen, item._dist, Math.max(0, room));
    const away = p => (item.rep < p.from ? p.from - item.rep : item.rep > p.to ? item.rep - p.to : 0);
    const best = Number.isInteger(item.rep)
      ? ranges.reduce((a, b) => (away(b) < away(a) ? b : a), ranges[0])
      : ranges[0];
    const shown = [];
    if (best && cost(best) <= MAX_DOC_LEN - doc.used) {
      doc.used += cost(best);
      best.chunks.forEach(c => doc.seen.add(c.chunk_no));
      shown.push({ ...best, seq: item.seq, expanded: item.expanded, more: canGrow(item) });
    }
    if (shown.length && shown[0].chunks.length < unseen.length) shown[0].moreStored = true;
    // 실을 것이 하나도 없는 이유는 둘로 갈린다. 남은 청크가 있는데 자리가 없어 밀린 것(viewOmitted)은
    // 같은 ID를 앞으로 가져오면(expand) 실린다 — 프롬프트의 보관 목록이 그것을 약속한다.
    // 반면 남은 청크가 아예 없는 것(covered)은 이 항목의 본문이 같은 문서의 앞선 항목으로 이미 전부
    // 실려 있다는 뜻이다. 확대가 다른 보관 구간을 통째로 삼킨 뒤가 그 상태다. 그 항목을 앞으로 가져오면
    // 새로 보이는 글자는 없이 문서 상한(MAX_DOC_LEN)만 나눠 쓰게 되어, 지금 보이던 본문이 그만큼 줄어든다
    // (실측: 12청크가 10청크로). 청구를 받는 쪽(agent.js applyExpand)이 그 둘을 갈라 보게 표시를 남긴다.
    return shown.length ? shown : [{ ...item, viewOmitted: true, ...(unseen.length ? {} : { covered: true }) }];
  });
}
