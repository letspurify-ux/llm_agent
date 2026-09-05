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
import { MAX_PROMPT_ITEM_LEN, MAX_DOC_LEN, indentLines, clipText } from './constants.js';

// 청크 하나의 크기. 상한을 MAX_PROMPT_ITEM_LEN과 '같게' 두는 것이 설계의 요점이다 —
// 검색된 청크가 프롬프트에서 다시 잘리지 않는다. 지금까지 지식 항목마다 붙던 '…(생략)'과
// 본문 청구 번호가 이 등식 덕분에 사라진다(llm-openai.js itemLine).
// 목표를 상한보다 낮게 두는 이유: 경계를 문단·문장에서 찾으려면 여유가 있어야 한다.
// 그 여유가 없으면 경계 탐색이 거의 항상 실패해 강제 절단으로 떨어진다.
export const CHUNK_TARGET_LEN = 900;
export const CHUNK_MAX_LEN = MAX_PROMPT_ITEM_LEN;
// 분할 '방식'의 판. 크기·겹침이 같아도 절단 위치를 고르는 규칙이 바뀌면 같은 원문이 다른 청크가 되므로, 이 값도
// 문서 해시에 들어간다(embed-sync.js CHUNK_RULE) — 올리면 다음 동기화가 전 문서를 다시 나눈다. 자리(doc_seq,
// chunk_no)를 유지하며 덮어쓰므로 실제로 내용이 달라진 청크만 다시 임베딩된다. 절단 위치를 고르는 규칙을
// 고쳤으면 이 값을 올릴 것 — 안 올리면 기존 설치의 청크는 원문을 고치기 전까지 옛 규칙대로 남는다.
//   2: 절단 위치가 서로게이트 쌍을 가르지 않는다 (alignCut)
//   3: 경계 탐색이 CR(\r)을 개행으로 본다 — CRLF 문서의 빈 줄·문장 끝이 경계가 된다 (BOUNDARIES).
//      LF 문서는 같은 자리에서 나뉘므로 다음 동기화가 다시 나눠도 내용이 같아 재임베딩되지 않는다.
export const CHUNK_SPLIT_VERSION = 3;
// 겹침. 경계에 걸친 문장이 양쪽 어디에서도 온전하지 않으면, 그 문장이 답인 질문은 두 청크 모두와
// 어중간하게 닮아 둘 다 문턱(search.js MAX_DIST) 밖으로 밀린다.
export const CHUNK_OVERLAP = 150;

// 이어 붙일 때 겹침을 떼는 최소 길이. 이보다 짧게 맞는 것은 겹침이 아니라 우연으로 본다 —
// 앞 청크의 끝 한두 글자가 뒤 청크의 첫 글자와 같은 일은 흔하고(마침표·공백·조사), 그것을 겹침으로
// 읽으면 실제 본문을 지운다. 실측 겹침은 147~150자라 이 문턱과 멀리 떨어져 있다.
// 겹침 자체를 이보다 짧게 설정한 경우에는 그 값을 쓴다 (안 그러면 그 설치에서는 한 번도 떼지 못한다).
const MIN_SEAM = 32;

// 이웃한 두 청크를 이을 때, 뒤 청크의 앞머리에서 앞 청크와 겹치는 만큼을 뗀다.
//
// 겹침(CHUNK_OVERLAP)은 '각 청크가 홀로 검색되게' 하려고 둔 것이다 — 경계에 걸친 문장이 어느
// 한쪽에는 온전히 남아야 그 문장이 답인 질문이 문턱 밖으로 밀리지 않는다. 그것은 임베딩의 사정이지
// 프롬프트의 사정이 아니다. 떼지 않고 그대로 이으면 이음매마다 150자가 두 번 실린다 — 5청크 구간에서
// 3,787자 중 594자(15.7%)가 같은 문장의 되풀이였고, 모델은 문장을 읽고 나서 그 문장의 꼬리를 낱말
// 한가운데부터 다시 읽는다(실측). 손해는 셋이다: 문서당 상한(MAX_DOC_LEN)의 6분의 1이 중복에 쓰이고,
// 그만큼 상한에 일찍 닿아 full이 서므로 실제 본문을 덜 싣고 청구(expand) 경로까지 먼저 닫히며,
// 폴백 답변(llm.js renderAnswer)에서는 그 되풀이가 사용자에게 그대로 나간다.
// context.md 2-5가 병합을 '하나의 연속 구간'이라고 적어둔 것이 이 함수가 지키는 계약이다.
//
// 저장된 청크는 건드리지 않는다 — 분할 규칙도 문서 해시도 그대로이므로 재분할·재임베딩이 없다.
// 길이를 정확히 아는 대신 문자열로 맞춰 보는 이유: 청크 행에는 원문에서의 위치가 없고, 저장 시
// 앞뒤 공백을 떼므로(splitContent) 실제 겹침은 CHUNK_OVERLAP보다 한두 글자 짧다(실측 147~150).
// 가장 긴 것부터 찾아 첫 일치를 쓴다 — 짧은 우연이 긴 진짜 겹침을 가리지 않게.
//
// 남은 앞머리는 **원문 그대로** 돌려준다 — 앞 공백도 떼지 않는다. 그 공백이 원문의 공백이기 때문이다:
// 일치한 길이만큼 떼고 나면 남는 것은 '앞 청크의 끝 바로 다음 글자'부터이고, 앞 청크가 저장될 때
// 잘려 나간 꼬리 공백(문단 사이의 빈 줄까지)은 뒤 청크 안에 그대로 남아 있다. 그래서 호출부는 뗀
// 이음매에 구분자를 넣지 않고 이어 붙이기만 하면 원문이 정확히 복원된다 (buildItems joined).
// 앞 공백을 떼고 개행 하나로 대신하던 동안 이음매마다 원문이 세 가지로 어긋났다(운영 데이터 135개
// 이음매 실측): 문단 경계 30자리가 빈 줄을 잃어 제목이 앞 문단에 붙었고, 줄 안의 공백 87자리가 개행이
// 되어 문장이 두 줄로 갈라졌으며, 강제 절단으로 원래 공백이 없던 18자리에서는 개행이 낱말 한가운데로
// 들어갔다 — 'Time Person of the Year (2021)'이 'Time Person of the Yea / r (2021)'로 실렸다.
// 마지막 것이 특히 나쁘다: 겹침을 떼어 막으려던 '낱말 한가운데'가 이번에는 절단면에서 다시 생겼다.
//
// 뒤 청크가 서로게이트 쌍으로 시작하면 대조 상한을 **한 코드유닛 넉넉히** 잡는다. 겹침 시작(end - overlap)이
// 쌍의 한가운데면 splitContent의 alignCut이 한 칸 앞으로 물려 다음 청크를 시작하므로, 실제 겹침이 overlap + 1
// 코드유닛이 된다. 앞 청크의 끝에 잘려 나갈 공백이 없고(제목 경계) 뒤 청크가 이모지로 시작하는 자리가 정확히
// 그 경우다 — 상한을 overlap으로 두던 동안 그 이음매는 어떤 n에서도 맞지 않아 한 글자도 떼지 못했고, 151자가
// 개행까지 붙어 두 번 실렸다(퍼징으로 잡았다). 겹침을 떼는 함수가 겹침 한 칸 때문에 통째로 헛도는 셈이다.
// 조건 없이 늘 한 칸 넉넉히 보면 안 된다 — 같은 글자가 151자 이상 이어지는 자리(구분선 '----')에서는 150자
// 겹침에 151자가 맞아 원문 한 글자를 지운다(퍼징으로 잡았다). 쌍으로 시작하는 청크에서는 그 오판이 생기지
// 않는다: 151번째 코드유닛이 쌍의 앞 절반이면 앞 청크가 그것으로 끝나야 하는데, 절단 위치가 쌍을 가르지
// 않으므로(alignCut) 청크는 짝 없는 앞 절반으로 끝나는 일이 없다. 그 한 칸 너머는 보지 않는다 — alignCut이
// 물리는 폭이 정확히 한 칸이고, 그 이상 같은 것은 겹침이 아니라 본문이 닮은 것이다.
export function cutSeam(text, next, overlap = CHUNK_OVERLAP) {
  const floor = Math.min(MIN_SEAM, overlap);
  const aligned = isHigh(next.charCodeAt(0)) && isLow(next.charCodeAt(1)) ? 1 : 0;
  const max = Math.min(overlap + aligned, text.length, next.length);
  for (let n = max; n >= floor; n--) if (text.endsWith(next.slice(0, n))) return next.slice(n);
  return next;
}

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
//
// CR(\r)도 개행 자리로 본다. 등록 본문은 운영자가 Windows 편집기에서 붙여 넣은 CRLF(\r\n)일 수 있고, 이 저장소의
// 다른 자리는 전부 그것을 개행으로 다룬다(constants.indentLines, llm.js cell). 여기만 LF만 보던 동안 CRLF 문서에서
// ①과 ③이 한 번도 맞지 않았다 — '.\r\n'은 '[.!?]' 뒤가 '\r'이고, '\r\n\r\n'은 두 '\n' 사이에 '\r'이 끼어 있다.
// 그래서 한 줄에 한 문장씩 끝나는 절차 안내문이 이음매마다 강제 절단(④)으로 떨어져 낱말 한가운데에서 갈렸다
// (실측: 4개 이음매 전부). 오류는 남지 않고 임베딩이 흐려지고 프롬프트의 구간이 낱말 한가운데에서 시작할 뿐이다.
// LF 문서의 절단 위치는 그대로다 — '\r'이 없는 글에서 두 정규식은 종전과 같은 자리에 맞는다.
const BOUNDARIES = [
  { re: /\n[ \t\r]*\n/g, atStart: false },   // ① 빈 줄
  { re: /\n#{1,6}[ \t]/g, atStart: true },    // ② 마크다운 제목
  { re: /[.!?][ \t\r\n]/g, atStart: false },  // ③ 문장 끝
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

// 절단 위치가 서로게이트 쌍(이모지 등 BMP 밖 문자)의 한가운데면 한 칸 앞으로 옮긴다. 경계 탐색이 찾은 자리는
// 개행·문장 부호라 쌍을 가르지 않지만, 강제 절단(hi)과 겹침 시작(end - overlap)은 임의의 코드유닛 위치다 —
// 거기가 이모지 한가운데면 앞 청크는 상위 서로게이트로 끝나고 다음 청크는 하위 서로게이트로 시작한다(실측).
// 그 문자열은 유효한 UTF-8이 아니라 임베딩 서버가 그 행을 매 주기 거부하거나 U+FFFD로 바꿔 놓고, 프롬프트에
// 실리면 LLM 호출이 인코딩 단계에서 실패한다 — constants.clipText가 절단면에서 막는 것과 같은 실패다.
// 앞으로 옮기면 끝 절단에서는 쌍이 통째로 다음 청크로 가고, 시작에서는 쌍이 온전히 그 청크에 든다.
const isHigh = c => c >= 0xd800 && c <= 0xdbff;
const isLow = c => c >= 0xdc00 && c <= 0xdfff;
const alignCut = (s, i) =>
  (i > 0 && i < s.length && isLow(s.charCodeAt(i)) && isHigh(s.charCodeAt(i - 1)) ? i - 1 : i);

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
    // 꼬리도 다른 청크와 같이 앞뒤 공백을 뗀다 — 겹침 시작이 빈 줄 구간에 떨어지면 앞 공백이 최대 겹침 길이만큼
    // 붙는데, 그 공백은 임베딩 원문과 청크 저장소에 그대로 들어가 다른 청크와 모양이 달라진다(퍼징으로 잡았다).
    if (remain <= max) { out.push(s.slice(at).trim()); break; }
    // 창: 목표의 60% 지점부터 상한까지. 아래쪽을 열어두지 않으면 문단이 짧은 글에서
    // 경계가 창에 하나도 안 들어와 매번 강제 절단이 된다.
    const lo = at + Math.floor(target * 0.6);
    const hi = at + max;
    const cut = lastBoundary(s, lo, hi);
    const end = cut > at ? cut : alignCut(s, hi);
    out.push(s.slice(at, end).trim());
    // 겹침은 '다음 청크의 시작을 당기는' 방식이다. end에서 그대로 이어가면 경계에 걸친 문장이
    // 앞 청크에만 온전히 남는다. 진행이 멈추지 않도록 최소 한 글자는 전진한다 — 그 글자가
    // 서로게이트 쌍이면 두 코드유닛이다(한 코드유닛만 나가면 쌍의 가운데에서 다시 시작한다).
    let next = alignCut(s, end - overlap);
    if (next <= at) next = at + (isHigh(s.charCodeAt(at)) && isLow(s.charCodeAt(at + 1)) ? 2 : 1);
    at = next;
  }
  const parts = out.filter(c => c.length > 0);
  // 빈 배열을 돌려주면 안 된다. 그 문서는 청크가 0건이라 검색에 한 번도 안 나오는데, 동기화는
  // doc_hash를 저장할 행이 없어 매 주기 같은 문서를 다시 분할한다 — 조용히 안 나오면서 조용히 도는
  // 상태다. 공백만 든 슬라이스가 전부 걸러지는 경우(본문 대부분이 공백)가 그 경로다.
  return parts.length ? parts : [clipText(s, max)];
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
//
// 글자 수는 프롬프트에 실리는 형태(constants.js indentLines)로 잰다 — MAX_DOC_LEN이 재는 것이 그 길이다.
// 원문 길이로 재면 줄이 많은 본문(마크다운 목록·표)이 들여쓰기만큼 상한을 넘겨 프롬프트가 다시 자르고
// 잘림 표시를 붙인다. 4,499자짜리 병합 항목이 355자를 잃고 '…(생략)'을 달고 나갔다(실측) —
// '청크는 프롬프트에서 다시 잘리지 않는다'가 이 자에서만 깨져 있었다.
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
    // 대표 행이 없으면(검색과 읽기 사이에 다시 나뉜 문서) 범위 시작을 대표로 삼는다 — 중심은 실제로 있는 행이어야 한다.
    const repNo = have.has(p.rep) ? p.rep : p.from;
    const rep = have.get(repNo);
    if (!rep) continue;
    const chunkOf = rep.chunk_of;

    // [a, b] 구간을 이어 붙였을 때의 본문과 그 프롬프트 길이. 사이에 없는 행은 건너뛴다.
    // 이웃한 청크끼리만 겹침을 뗀다(cutSeam) — 사이가 비어 있으면(구멍을 메우지 못한 범위, 재분할 도중)
    // 두 조각은 원문에서 이어져 있지 않으므로 겹칠 것도 없고, 우연한 일치로 본문을 지우면 안 된다.
    //
    // 겹침을 실제로 뗐으면(add !== c) 남은 앞머리는 원문에서 text의 끝에 곧바로 이어지는 자리이고
    // 그 사이의 공백까지 앞머리에 들어 있다 — 구분자를 넣지 않아야 원문이 그대로 복원된다(cutSeam 주석).
    // 넣던 동안 이음매마다 문단 경계가 사라지고 낱말이 개행으로 갈라졌다(실측).
    // 못 뗐을 때만 개행 하나로 잇는다: 그 둘은 원문에서 이어져 있다는 보장이 없으므로 붙여 쓰면
    // 두 낱말이 한 낱말로 붙는다. 뗀 길이는 최소 MIN_SEAM자라 add !== c가 곧 '뗐다'이다.
    const joined = (a, b) => {
      let text = '';
      let prev = null;
      for (let n = a; n <= b; n++) {
        if (!have.has(n)) continue;
        const c = have.get(n).content;
        // 겹침을 떼고 남는 것이 없으면(겹침보다 짧은 꼬리 청크) 이음매도 만들지 않는다 —
        // 빈 조각을 개행으로 이으면 본문 끝에 빈 줄만 남는다.
        const add = prev === n - 1 ? cutSeam(text, c) : c;
        if (prev !== null && !add) { prev = n; continue; }
        text = prev === null ? c : `${text}${add === c ? '\n' : ''}${add}`;
        prev = n;
      }
      return text;
    };
    const cost = (a, b) => indentLines(joined(a, b)).length;

    let from = repNo, to = repNo;
    // 대표 청크에서 번갈아 바깥으로 넓힌다. 한쪽이 막히면 다른 쪽만 계속 넓힌다.
    const widen = (min, max) => {
      for (;;) {
        const before = from, after = to;
        for (const dir of [1, -1]) {
          const no = dir > 0 ? to + 1 : from - 1;
          if (no < min || no > max || !have.has(no)) continue;
          if ((dir > 0 ? cost(from, no) : cost(no, to)) > maxDocLen) continue;
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

    // 더 받을 것이 남았는가(full). 양쪽 이웃이 모두 '문서 밖'이거나 '읽어 왔는데 상한에 들어가지 않는다'면
    // 끝이다. 읽어 오지 않은 이웃은 모른다(full=false) — 그 자리는 expand가 창을 넓혀 읽은 뒤에 다시
    // 판정한다(agent.js growItem). 검색은 계획된 범위의 앞뒤 한 조각을 함께 읽어(search.js) 이 판정을
    // 검색 시점에 확정한다. 범위와 글자 수만 보면(옛 canGrow) 이웃 한 조각이 상한에 안 들어가는 항목에도
    // 번호가 남아 — 900자 청크면 다섯 조각(3,900자)에서 여섯째(4,650자)가 막힌다 — 모델이 그 번호로 청구한
    // expand가 한 글자도 늘리지 못하고, 안내는 '번호가 붙은 항목만 청구할 수 있다'라 모순이며, 두 번이면
    // 강제 답변으로 넘어갔다(실측).
    const closed = no =>
      no < 1 || no > chunkOf || (have.has(no) && (no > to ? cost(from, no) : cost(no, to)) > maxDocLen);
    const full = closed(from - 1) && closed(to + 1);

    items.push({
      // rep(대표 청크의 순번)을 항목에 남긴다. 본문 청구가 범위를 넓힐 때 이 값을 다시 넘겨야
      // seq가 그대로 유지된다 — seq는 '가장 가까운 청크'의 것인데, 넓히면서 중심을 범위 시작으로
      // 옮기면 항목의 seq가 바뀐다. 그러면 모델이 방금 청구한 k12가 다음 스텝에 존재하지 않아
      // 다시 청구할 수도, 버릴 수도 없다 — seq가 요청 내내 고정이라는 계약이 깨지는 자리다.
      seq: rep.seq, rep: repNo, doc_seq: p.doc_seq, chunk_of: chunkOf, from, to, full,
      title: rep.title,
      // 위치 표기를 제목에 이어 붙이지 않고 따로 둔다. 붙여서 넘기면 프롬프트가 제목을
      // MAX_PROMPT_NAME_LEN(100자)으로 자를 때 뒤에 있는 이 표기부터 사라진다 — 제목이 긴 문서일수록
      // '몇 번째 조각인가'를 잃는데, 그것을 알려주는 것이 이 표기의 존재 이유다(실측으로 확인).
      // llm-openai.js itemLine이 제목을 자른 '뒤에' 붙인다. 길이는 유계다(chunk_of는 SMALLINT).
      range: chunkOf > 1 ? ` (${from === to ? from : `${from}~${to}`}/${chunkOf})` : '',
      content: joined(from, to),
      _dist: p.dist,
    });
  }
  // 문서 정렬은 그 문서의 최소 거리 순 — 관련도 순을 그대로 보존한다.
  return items.sort((a, b) => a._dist - b._dist);
}

// 이 항목이 본문 청구(expand)로 더 받을 것이 남았는가.
// 세 조건이 모두 서야 한다: 문서에 범위 밖 청크가 남아 있고, 글자 상한에 아직 닿지 않았고, 이웃 조각이
// 그 상한에 들어간다는 것이 부정되지 않았다(buildItems의 full). 하나만 빠져도 모델이 더 받을 수 없는
// 항목을 청구하느라 스텝을 버린다 — 앞의 둘만 보던 동안 세 번째가 정확히 그렇게 새고 있었다.
// 글자 수는 프롬프트에 실리는 형태로 잰다(buildItems와 같은 자).
export const canGrow = (o, maxDocLen = MAX_DOC_LEN) =>
  !!o?.doc_seq && !o.full && (o.from > 1 || o.to < o.chunk_of) && indentLines(o.content).length < maxDocLen;
