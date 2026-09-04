// 긴 지식을 청크로 나누고, 검색된 청크를 다시 이어 붙이는 두 순수 함수.
//
// 이 파일이 있는 이유. 임베딩은 행 하나에 벡터 하나이고 원문은 MAX_EMBED_TEXT_LEN(4,000자)에서
// 잘린다(embed-sync.js toText). 그래서 2만 자짜리 지식을 등록하면 검색은 앞 20%만 보고 판단하고,
// 뒤 16,000자는 어떤 경로로도 모델에 닿지 않는다 — 프롬프트 상한(MAX_PROMPT_ITEM_LEN 1,000자,
// 펼쳐도 MAX_DOC_LEN)도 같은 앞부분만 보여주기 때문이다. 오류가 한 줄도 남지 않는 오답이다.
// 나눠 두면 '문서의 앞 4,000자'가 아니라 '질문에 맞는 구간'이 실린다 — 그것이 이 변경의 전부다.
//
// DB를 모르는 순수 함수로 둔다 (sql.js·chart.js와 같은 자리). 분할 규칙과 병합 규칙은 양쪽으로
// 조용히 깨지는 종류라 — 너무 잘게 나누면 문맥이 끊기고, 너무 크게 나누면 벡터가 흐려진다 —
// 테스트가 유일한 방어선이고, 그러려면 DB 없이 부를 수 있어야 한다.
// 아래 세 상수는 문서 해시에 들어간다(embed-sync.js CHUNK_RULE) — 고치면 다음 동기화가 전 문서를
// 알아서 다시 나눈다. 손으로 비울 필요가 없고, 반대로 고쳐 놓고 잊어버릴 수도 없다.
import { MAX_PROMPT_ITEM_LEN, MAX_DOC_LEN } from './constants.js';

// 청크 하나의 크기. 상한을 MAX_PROMPT_ITEM_LEN과 '같게' 두는 것이 설계의 요점이다 —
// 검색된 청크가 프롬프트에서 다시 잘리지 않는다. 지금까지 지식 항목마다 붙던 '…(생략)'과
// 본문 청구 번호가 이 등식 덕분에 사라진다(llm-openai.js itemLine).
// 목표를 상한보다 낮게 두는 이유: 경계를 문단·문장에서 찾으려면 여유가 있어야 한다.
// 그 여유가 없으면 경계 탐색이 거의 항상 실패해 강제 절단으로 떨어진다.
export const CHUNK_TARGET_LEN = 900;
export const CHUNK_MAX_LEN = MAX_PROMPT_ITEM_LEN;
// 겹침. 경계에 걸친 문장이 양쪽 어디에서도 온전하지 않으면, 그 문장이 답인 질문은 두 청크 모두와
// 어중간하게 닮아 둘 다 문턱(search.js MAX_DIST) 밖으로 밀린다.
export const CHUNK_OVERLAP = 150;

// 검색 결과를 이어 붙일 때 메울 최대 간격(청크 수). 같은 문서에서 3·5번이 걸리면 4번도 싣는다 —
// 그 문서가 관련 있다는 판정은 이미 났고, 4번을 비운 채 3번과 5번을 나란히 실으면 모델은 그 사이에
// 무엇이 있었는지 모른 채 읽는다. 절차라면 단계 하나를 건너뛴 것으로 읽는다.
export const CHUNK_GAP_FILL = 2;

// 문단 경계를 우선순위대로 찾는다. 앞에 있는 것일수록 '뜻이 끊기지 않는' 경계다.
//   ① 빈 줄        문단 경계. 글쓴이가 직접 그은 선이라 가장 믿을 만하다.
//   ② 마크다운 제목 절 경계. 등록된 지식 상당수가 마크다운이다.
//   ③ 문장 끝      마침표·물음표·느낌표 뒤 공백. 한국어는 '다.' '요.' 뒤가 대부분이다.
//   ④ 강제         위 셋이 창 안에 없을 때. 표나 코드블록이 통째로 길면 여기로 온다.
// 창(window)은 [target - 여유, max] 구간이다 — 그 안에서 가장 앞선 우선순위의, 가장 뒤쪽 경계를 쓴다.
// 가장 뒤쪽을 쓰는 이유: 앞쪽을 고르면 청크가 잘아져 같은 문서가 더 많은 조각으로 흩어진다.
//
// atStart는 '경계 표시를 어느 쪽 청크에 붙일까'다. 제목만 앞에 붙인다 — 제목은 뒤따르는 절의
// 머리말이므로 앞 청크의 꼬리에 남으면 그 절의 내용과 떨어진다. 그러면 "## 재시작 절차"라는
// 제목과 그 절차 본문이 서로 다른 청크에 들어가, 제목으로 검색한 질문이 정작 절차를 못 찾는다.
// 빈 줄과 문장 끝은 반대다 — 그 표시는 앞 문단·앞 문장에 속한다.
const BOUNDARIES = [
  { re: /\n[ \t]*\n/g, atStart: false },   // ① 빈 줄
  { re: /\n#{1,6}[ \t]/g, atStart: true },  // ② 마크다운 제목
  { re: /[.!?][ \t\n]/g, atStart: false },  // ③ 문장 끝
];

// 창 안에서 마지막으로 맞는 경계의 절단 위치를 돌려준다. 없으면 -1.
function lastBoundary(text, lo, hi) {
  for (const { re, atStart } of BOUNDARIES) {
    re.lastIndex = 0;
    let at = -1;
    let m;
    while ((m = re.exec(text)) !== null) {
      const cut = atStart ? m.index : m.index + m[0].length;
      if (cut > hi) break;
      if (cut >= lo) at = cut;
      // 제로 길이 매치는 없다(모든 패턴이 최소 2자) — lastIndex를 직접 만질 필요가 없다.
    }
    if (at >= 0) return at;
  }
  return -1;
}

// 원문 → 청크 배열. 빈 문자열이면 빈 배열이 아니라 한 건을 돌려준다 —
// 청크가 0건이면 그 문서는 vec_store에 행이 없어 검색에서 통째로 사라지는데,
// 등록은 되어 있으므로 '등록했는데 안 나온다'가 되고 그 실패는 아무 데도 기록되지 않는다.
// (knowledge.content는 NOT NULL이지만 공백만 든 행은 막지 않는다.)
export function splitContent(text, {
  target = CHUNK_TARGET_LEN, max = CHUNK_MAX_LEN, overlap = CHUNK_OVERLAP,
} = {}) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return [s];

  const out = [];
  let at = 0;
  while (at < s.length) {
    const remain = s.length - at;
    if (remain <= max) { out.push(s.slice(at)); break; }
    // 창: 목표의 60% 지점부터 상한까지. 아래쪽을 열어두지 않으면 문단이 짧은 글에서
    // 경계가 창에 하나도 안 들어와 매번 강제 절단이 된다.
    const lo = at + Math.floor(target * 0.6);
    const hi = at + max;
    const cut = lastBoundary(s, lo, hi);
    const end = cut > at ? cut : hi;
    out.push(s.slice(at, end).trim());
    // 겹침은 '다음 청크의 시작을 당기는' 방식이다. end에서 그대로 이어가면 경계에 걸친 문장이
    // 앞 청크에만 온전히 남는다. 진행이 멈추지 않도록 최소 1자는 전진한다.
    const next = Math.max(at + 1, end - overlap);
    at = next;
  }
  const parts = out.filter(c => c.length > 0);
  // 빈 배열을 돌려주면 안 된다. 그 문서는 청크가 0건이라 검색에 한 번도 안 나오는데, 동기화는
  // doc_hash를 저장할 행이 없어 매 주기 같은 문서를 다시 분할한다 — 조용히 안 나오면서 조용히 도는
  // 상태다. 공백만 든 슬라이스가 전부 걸러지는 경우(본문 대부분이 공백)가 그 경로다.
  return parts.length ? parts : [s.slice(0, max)];
}

// ===== 검색 결과 병합 =====
//
// 왜 개수로 자르지 않는가. 관련도 순으로 뽑아 놓고 '문서당 3건'처럼 개수로 깎으면 더 가까운 것을
// 버리고 더 먼 것을 싣게 된다 — 임베딩이 제 일을 했다면 한 문서가 상위를 차지하는 것은 정답이다.
// 고칠 것은 '몇 개를 버릴까'가 아니라 '흩어진 조각을 어떻게 다시 붙일까'다. 조각 사이의 구멍은
// 관련도 문제가 아니라 청킹이 만든 인공물이므로, 그것만 메운다.
//
// 문서당 글자 상한(MAX_DOC_LEN)은 남긴다. 이유는 하나뿐이다 — '이 문서가 답'이라는 판정이
// 틀렸을 때의 보험이다. 그 요청에 다른 문서가 하나도 안 보이면 모델은 대안을 볼 수 없고,
// 그 오답은 오류를 남기지 않는다. 원칙이 아니라 튜닝 값이다 (계측 근거는 context.md 8-).

// ① 검색 적중 → 문서별로 읽어와야 할 청크 범위. 순수 함수라 DB 왕복 전에 계획이 확정된다.
// hits는 관련도 순(거리 오름차순)이어야 한다 — 문서의 순서와 대표 청크가 그 순서에서 나온다.
export function planRanges(hits, { gapFill = CHUNK_GAP_FILL } = {}) {
  const byDoc = new Map();
  for (const h of hits) {
    const cur = byDoc.get(h.doc_seq);
    if (cur) { cur.nos.push(h.chunk_no); continue; }
    // 첫 적중이 곧 그 문서의 최소 거리다(입력이 거리 순이므로) — 대표 청크이자 문서 정렬 키.
    byDoc.set(h.doc_seq, { doc_seq: h.doc_seq, rep: h.chunk_no, dist: h._dist, chunk_of: h.chunk_of, nos: [h.chunk_no] });
  }
  return [...byDoc.values()].map(d => {
    const nos = [...new Set(d.nos)].sort((a, b) => a - b);
    // 간격이 gapFill 이하인 것끼리 이어 하나의 범위로. 그보다 멀면 대표가 있는 쪽만 남긴다 —
    // 한 문서에서 동떨어진 두 구간을 다 실으면 글자 상한을 그 둘이 나눠 갖느라 양쪽 다 얕아진다.
    const runs = [];
    for (const n of nos) {
      const last = runs[runs.length - 1];
      if (last && n - last.to <= gapFill + 1) last.to = n;
      else runs.push({ from: n, to: n });
    }
    const run = runs.find(r => r.from <= d.rep && d.rep <= r.to) ?? runs[0];
    return { doc_seq: d.doc_seq, rep: d.rep, dist: d.dist, chunk_of: d.chunk_of, from: run.from, to: run.to };
  });
}

// ② 읽어온 청크 행 → 프롬프트 항목. 대표 청크에서 바깥으로 번갈아 넓히며 글자 상한을 채운다.
// 바깥으로 번갈아 가는 이유: 앞이나 뒤 한쪽만 채우면 대표가 구간 끝에 걸려, 정작 답이 반대쪽에
// 있을 때 상한을 다 쓰고도 못 닿는다.
//
// grow=true면 범위 밖 청크까지 상한까지 끌어온다(expand). false면 계획된 범위 안에서만 채운다(검색) —
// 검색이 먼저 상한을 채워 버리면 expand가 할 일이 없어지고, 모델이 왕복 하나를 헛되이 태운다.
export function buildItems(plans, rows, { maxDocLen = MAX_DOC_LEN, grow = false } = {}) {
  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.doc_seq)) byDoc.set(r.doc_seq, new Map());
    byDoc.get(r.doc_seq).set(r.chunk_no, r);
  }
  const items = [];
  for (const p of plans) {
    const have = byDoc.get(p.doc_seq);
    if (!have) continue;
    const lo = grow ? 1 : p.from;
    const hi = grow ? (p.chunk_of ?? Number.MAX_SAFE_INTEGER) : p.to;
    const rep = have.get(p.rep) ?? have.get(p.from);
    if (!rep) continue;

    let from = p.rep, to = p.rep;
    let len = rep.content.length;
    // 대표 청크에서 번갈아 바깥으로 넓힌다. 한쪽이 막히면 다른 쪽만 계속 넓힌다.
    const widen = (min, max) => {
      for (;;) {
        const before = from, after = to;
        for (const dir of [1, -1]) {
          const no = dir > 0 ? to + 1 : from - 1;
          if (no < min || no > max) continue;
          const row = have.get(no);
          if (!row) continue;
          const add = row.content.length + 1; // 이어 붙일 때의 개행 한 칸
          if (len + add > maxDocLen) continue;
          len += add;
          if (dir > 0) to = no; else from = no;
        }
        if (from === before && to === after) break;
      }
    };
    // 두 단계로 나눈다. 먼저 이미 실려 있던 범위를 채우고, 그다음에만 그 밖으로 나간다 —
    // 한 번에 [1, chunk_of]로 넓히면 대표 청크를 중심으로 다시 균형을 잡느라, 상한이 빠듯할 때
    // 앞서 보여준 뒤쪽 청크가 새로 딸려온 앞쪽 청크에 밀려 사라진다. 본문 청구가 보여주던 것을
    // 도로 가져가는 셈이라, 모델은 방금 읽은 대목이 없어진 프롬프트를 받는다.
    widen(p.from, p.to);
    if (grow) widen(lo, hi);
    const parts = [];
    for (let n = from; n <= to; n++) if (have.get(n)) parts.push(have.get(n).content);
    const chunkOf = rep.chunk_of;
    items.push({
      // rep(대표 청크의 순번)을 항목에 남긴다. 본문 청구가 범위를 넓힐 때 이 값을 다시 넘겨야
      // seq가 그대로 유지된다 — seq는 '가장 가까운 청크'의 것인데, 넓히면서 중심을 범위 시작으로
      // 옮기면 항목의 seq가 바뀐다. 그러면 모델이 방금 청구한 k12가 다음 스텝에 존재하지 않아
      // 다시 청구할 수도, 버릴 수도 없다 — seq가 요청 내내 고정이라는 계약이 깨지는 자리다.
      seq: rep.seq, rep: p.rep, doc_seq: p.doc_seq, chunk_of: chunkOf, from, to,
      title: rep.title,
      // 위치 표기를 제목에 이어 붙이지 않고 따로 둔다. 붙여서 넘기면 프롬프트가 제목을
      // MAX_PROMPT_NAME_LEN(100자)으로 자를 때 뒤에 있는 이 표기부터 사라진다 — 제목이 긴 문서일수록
      // '몇 번째 조각인가'를 잃는데, 그것을 알려주는 것이 이 표기의 존재 이유다(실측으로 확인).
      // llm-openai.js itemLine이 제목을 자른 '뒤에' 붙인다. 길이는 유계다(chunk_of는 SMALLINT).
      range: chunkOf > 1 ? ` (${from === to ? from : `${from}~${to}`}/${chunkOf})` : '',
      content: parts.join('\n'),
      _dist: p.dist,
    });
  }
  // 문서 정렬은 그 문서의 최소 거리 순 — 관련도 순을 그대로 보존한다.
  return items.sort((a, b) => a._dist - b._dist);
}

// 이 항목이 본문 청구(expand)로 더 받을 것이 남았는가.
// 두 조건이 모두 서야 한다: 문서에 범위 밖 청크가 남아 있고, 글자 상한에 아직 닿지 않았다.
// 둘 중 하나만 보면 모델이 더 받을 수 없는 항목을 청구하느라 스텝을 버린다.
export const canGrow = (o, maxDocLen = MAX_DOC_LEN) =>
  !!o?.doc_seq && (o.from > 1 || o.to < o.chunk_of) && String(o.content ?? '').length < maxDocLen;
