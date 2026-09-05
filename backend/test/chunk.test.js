// 청크 분할·병합 회귀 테스트 — 실행: npm test
//
// 이 두 규칙은 양쪽으로 조용히 깨진다. 너무 잘게 나누면 문맥이 끊겨 답이 부실해지고, 너무 크게
// 나누면 벡터가 흐려져 문턱(search.js MAX_DIST) 밖으로 밀린다 — 어느 쪽도 오류를 남기지 않는다.
// 그래서 여기가 유일한 방어선이다 (loopGuard·clippedCopyDetector와 같은 이유).
import { test } from 'node:test';
import assert from 'node:assert';
import {
  splitContent, planRanges, buildItems, canGrow,
  CHUNK_TARGET_LEN, CHUNK_MAX_LEN, CHUNK_OVERLAP, CHUNK_GAP_FILL,
} from '../src/chunk.js';
import { MAX_PROMPT_ITEM_LEN, MAX_DOC_LEN } from '../src/constants.js';

const para = (n, ch = '가') => ch.repeat(n);

// ===== 분할 =====

// 청크 상한이 프롬프트 항목 상한과 '같아야' 검색된 청크가 프롬프트에서 다시 잘리지 않는다.
// 이 등식이 깨지면 청크마다 '…(생략)'이 붙고 본문 청구 번호도 잘림 기준으로 되돌아간다 —
// 청크로 나눈 이유의 절반이 그 순간 사라진다.
test('청크 상한이 프롬프트 항목 상한과 같다', () => {
  assert.equal(CHUNK_MAX_LEN, MAX_PROMPT_ITEM_LEN);
  assert.ok(CHUNK_TARGET_LEN < CHUNK_MAX_LEN, '목표가 상한과 같으면 경계 탐색이 늘 실패해 강제 절단이 된다');
  assert.ok(CHUNK_OVERLAP < CHUNK_TARGET_LEN, '겹침이 목표보다 크면 진행하지 못한다');
});

test('상한 안의 짧은 글은 나누지 않는다 — 지금까지와 같은 한 건', () => {
  assert.deepStrictEqual(splitContent('짧은 지식'), ['짧은 지식']);
  assert.equal(splitContent(para(CHUNK_MAX_LEN)).length, 1);
});

// 빈 배열을 돌려주면 그 문서는 vec_store에 행이 없어 검색에서 통째로 사라진다 —
// 등록은 되어 있으므로 '등록했는데 안 나온다'가 되고 그 실패는 아무 데도 기록되지 않는다.
test('빈 본문도 한 건을 돌려준다 — 0건이면 그 문서가 검색에서 사라진다', () => {
  assert.equal(splitContent('').length, 1);
  assert.equal(splitContent('   \n  ').length, 1);
});

test('모든 청크가 상한 안이다 — 경계를 못 찾아도', () => {
  // 빈 줄도 문장 끝도 없는 덩어리. 강제 절단 경로다.
  for (const c of splitContent(para(5000))) assert.ok(c.length <= CHUNK_MAX_LEN, `상한 초과: ${c.length}`);
});

test('경계는 빈 줄 > 마크다운 제목 > 문장 끝 순으로 고른다', () => {
  const blank = `${para(700)}\n\n${para(700)}`;
  assert.ok(splitContent(blank)[0].endsWith(para(700)), '빈 줄이 있으면 거기서 끊는다');

  const heading = `${para(700)}\n## 다음 절\n${para(700)}`;
  assert.ok(splitContent(heading)[0].endsWith(para(700)), '제목 앞에서 끊는다');

  const sentence = `${para(700)}. ${para(700)}`;
  assert.ok(splitContent(sentence)[0].endsWith('.'), '문장 끝에서 끊는다');
});

test('겹침이 있어 경계에 걸친 문장이 어느 한쪽에는 온전히 남는다', () => {
  const parts = splitContent(para(3000));
  assert.ok(parts.length > 1);
  // 앞 청크의 꼬리가 다음 청크의 머리에 다시 나타난다.
  for (let i = 1; i < parts.length; i++) {
    const tail = parts[i - 1].slice(-40);
    assert.ok(parts[i].startsWith(tail.slice(0, 20)) || parts[i].includes(tail.slice(0, 20)),
      `겹침이 사라졌다 (${i}번째 경계)`);
  }
});

test('아주 긴 원문도 유한 번에 끝난다 — 진행이 멈추지 않는다', () => {
  const parts = splitContent(para(50_000));
  assert.ok(parts.length > 50 && parts.length < 200, `청크 수가 이상하다: ${parts.length}`);
});

// ===== 병합 계획 =====

const hit = (doc, no, dist, of = 22) => ({ doc_seq: doc, chunk_no: no, _dist: dist, chunk_of: of });

test('같은 문서의 흩어진 적중을 하나의 범위로 잇고 사이 구멍을 메운다', () => {
  const [p] = planRanges([hit(1, 3, 0.31), hit(1, 5, 0.36), hit(1, 6, 0.4)]);
  assert.deepStrictEqual({ from: p.from, to: p.to, rep: p.rep }, { from: 3, to: 6, rep: 3 });
});

test('간격이 상한보다 멀면 잇지 않고 대표가 있는 쪽만 남긴다', () => {
  const far = CHUNK_GAP_FILL + 5;
  const [p] = planRanges([hit(1, 3, 0.31), hit(1, 3 + far, 0.36)]);
  assert.equal(p.from, 3);
  assert.ok(p.to < 3 + far, '동떨어진 두 구간을 다 실으면 글자 상한을 나눠 갖느라 양쪽 다 얕아진다');
});

test('문서 순서와 대표 청크는 최소 거리에서 나온다 — 관련도 순을 보존한다', () => {
  const plans = planRanges([hit(2, 7, 0.30), hit(1, 4, 0.42), hit(2, 8, 0.44)]);
  assert.deepStrictEqual(plans.map(p => p.doc_seq), [2, 1]);
  assert.equal(plans[0].rep, 7);
});

// ===== 항목 조립 =====

const row = (doc, no, len = 900, of = 22) =>
  ({ seq: doc * 1000 + no, doc_seq: doc, chunk_no: no, chunk_of: of, title: `문서${doc}`, content: para(len) });

// 범위는 title에 이어 붙이지 않고 따로 둔다. 붙여서 넘기면 프롬프트가 제목을 MAX_PROMPT_NAME_LEN으로
// 자를 때 뒤에 있는 범위부터 사라져, 정작 조각으로 나뉜 긴 문서에서 위치를 알 수 없게 된다(실측).
test('범위는 제목과 따로 실린다 — 제목이 잘려도 위치가 살아남게', () => {
  const plans = planRanges([hit(1, 3, 0.31), hit(1, 4, 0.35)]);
  const [item] = buildItems(plans, [row(1, 3), row(1, 4)]);
  assert.equal(item.title, '문서1');
  assert.equal(item.range, ' (3~4/22)');

  const [one] = buildItems(planRanges([hit(1, 5, 0.31)]), [row(1, 5)]);
  assert.equal(one.range, ' (5/22)');

  // 청크가 하나뿐인 문서(= 짧은 지식)에는 범위를 붙이지 않는다 — 지금까지와 같은 표기다.
  const [whole] = buildItems(planRanges([hit(2, 1, 0.31, 1)]), [row(2, 1, 900, 1)]);
  assert.equal(whole.title, '문서2');
  assert.equal(whole.range, '');
});

// 제목이 상한을 넘겨도 위치 표기는 살아 있어야 한다 — 이 조합이 정확히 실측에서 깨진 자리다.
test('제목이 길어도 프롬프트에 위치 표기가 남는다', async () => {
  const { buildPrompt } = await import('../src/llm-openai.js');
  const long = '가'.repeat(300);
  // 간격이 CHUNK_GAP_FILL 안이어야 하나로 이어진다 — 3과 6은 이어지고, 3과 7은 이어지지 않는다.
  const [item] = buildItems(planRanges([hit(1, 3, 0.31), hit(1, 6, 0.35)]),
    [3, 4, 5, 6].map(n => ({ ...row(1, n, 100), title: long })));
  const line = buildPrompt({
    knowledge: [item], qaMethods: [], queries: [], history: [], chat: [],
    question: 'q', searched: ['knowledge'], tried: true,
  }).split('\n').find(l => l.startsWith('- '));
  assert.match(line, /\(3~6\/22\)\]/, '제목이 잘리면서 위치 표기까지 사라졌다');
});

test('검색은 문서당 상한을 채우지 않는다 — 그것은 expand의 몫이다', () => {
  // 적중 하나뿐인 문서. grow=false면 계획된 범위(3~3)만 실린다.
  const plans = planRanges([hit(1, 3, 0.31)]);
  const rows = Array.from({ length: 10 }, (_, i) => row(1, i + 1));
  const [item] = buildItems(plans, rows);
  assert.equal(item.from, 3);
  assert.equal(item.to, 3);
  assert.ok(item.content.length < MAX_DOC_LEN, '검색이 먼저 상한을 채우면 모델이 청구 왕복을 헛되이 태운다');
});

test('expand는 대표를 중심으로 양쪽으로 넓히고 문서당 상한에서 멈춘다', () => {
  const rows = Array.from({ length: 22 }, (_, i) => row(1, i + 1));
  const [item] = buildItems(
    [{ doc_seq: 1, rep: 10, from: 10, to: 10, chunk_of: 22, dist: 0.3 }],
    rows, { grow: true }
  );
  assert.ok(item.content.length <= MAX_DOC_LEN, '문서당 상한을 넘었다');
  assert.ok(item.from < 10 && item.to > 10, '한쪽만 채우면 답이 반대쪽에 있을 때 상한을 다 쓰고도 못 닿는다');
});

// expand는 넓히기만 해야 한다. 대표 청크를 중심으로 다시 균형을 잡으면, 상한이 빠듯할 때 앞서
// 보여준 청크가 새로 딸려온 것에 밀려 사라진다 — 모델은 방금 읽은 대목이 없어진 프롬프트를 받는다.
test('expand는 이미 실린 범위를 절대 줄이지 않는다', () => {
  // 청크가 커서(1,000자) 상한 4,500자에 네 개면 꽉 찬다 — 균형을 다시 잡으면 뒤쪽이 밀려난다.
  const rows = Array.from({ length: 22 }, (_, i) => row(1, i + 1, 1000));
  const [item] = buildItems(
    [{ doc_seq: 1, rep: 10, from: 10, to: 13, chunk_of: 22, dist: 0.3 }],
    rows, { grow: true }
  );
  assert.ok(item.from <= 10 && item.to >= 13, `이미 실린 10~13이 줄었다: ${item.from}~${item.to}`);
  assert.ok(item.content.length <= MAX_DOC_LEN);
});

test('문서 끝에 붙은 범위는 남은 한쪽으로만 넓힌다', () => {
  const rows = Array.from({ length: 22 }, (_, i) => row(1, i + 1));
  const [item] = buildItems(
    [{ doc_seq: 1, rep: 1, from: 1, to: 1, chunk_of: 22, dist: 0.3 }],
    rows, { grow: true }
  );
  assert.equal(item.from, 1);
  assert.ok(item.to > 1);
});

// ===== 더 받을 것이 남았는가 =====

test('canGrow는 범위와 글자 상한을 함께 본다', () => {
  const base = { doc_seq: 1, chunk_of: 22, content: para(900) };
  assert.ok(canGrow({ ...base, from: 3, to: 7 }), '범위 밖 청크가 남았으면 청구할 수 있다');
  assert.ok(!canGrow({ ...base, from: 1, to: 22 }), '문서 전체가 실렸으면 더 받을 것이 없다');
  assert.ok(!canGrow({ ...base, from: 3, to: 7, content: para(MAX_DOC_LEN) }), '상한에 닿았으면 청구해도 늘지 않는다');
  assert.ok(!canGrow({ seq: 1, content: '본문' }), '청크가 아닌 항목(qa_method)은 이 판정 밖이다');
});

// 항목의 seq는 대표 청크의 것이다. 범위를 넓히면서 중심이 옮겨 가면 seq가 바뀌는데, 그러면 모델이
// 방금 청구한 k12가 다음 스텝에 존재하지 않아 다시 청구할 수도 버릴 수도 없다 —
// 'seq는 요청 내내 고정'이 식별자 설계의 근거이므로(constants.js ITEM_PREFIX) 여기서 깨지면 안 된다.
test('expand로 범위를 넓혀도 항목의 seq가 바뀌지 않는다', () => {
  const rows = Array.from({ length: 22 }, (_, i) => row(1, i + 1, 300));
  // 대표(가장 가까운 것)가 범위 한가운데인 경우 — from과 rep이 다르다.
  const [first] = buildItems(planRanges([hit(1, 7, 0.30), hit(1, 5, 0.40), hit(1, 9, 0.45)]), rows);
  assert.equal(first.rep, 7);
  assert.notEqual(first.from, first.rep, '이 시나리오는 from ≠ rep이어야 의미가 있다');

  const [grown] = buildItems(
    [{ doc_seq: 1, rep: first.rep, from: first.from, to: first.to, chunk_of: 22, dist: 0.3 }],
    rows, { grow: true }
  );
  assert.equal(grown.seq, first.seq, '범위를 넓혔더니 항목의 seq가 바뀌었다');
});

// ===== 더 받을 것이 남았는가 — 이웃 조각이 상한에 들어가는가 =====
// 범위와 글자 수만 보면 이웃 한 조각이 상한에 안 들어가는 항목에도 번호가 남는다. 900자 청크면 네 조각(3,603자)
// 에서 다섯째(4,504자)가 막히는데, 그 항목은 범위 밖 청크도 남아 있고 상한에도 안 닿아 옛 판정으로는 '청구할
// 수 있다'였다. 모델이 그 번호로 청구한 expand는 한 글자도 늘리지 못하고, 안내는 '번호가 붙은 항목만 청구할 수
// 있다'라 모순이며, 두 번이면 강제 답변으로 넘어갔다(실측).
test('이웃 조각이 상한에 들어가지 않으면 full이 서고 번호가 사라진다', () => {
  const rows = Array.from({ length: 22 }, (_, i) => row(1, i + 1));   // 900자 청크
  const [item] = buildItems([{ doc_seq: 1, rep: 5, from: 5, to: 5, chunk_of: 22, dist: 0.3 }], rows, { grow: true });
  assert.ok(item.content.length < MAX_DOC_LEN && item.to < 22, '이 시나리오는 상한에 닿지 않고 범위 밖 청크가 남아야 뜻이 있다');
  assert.equal(item.full, true, '읽어 온 이웃이 상한에 안 들어가면 더 받을 것이 없다');
  assert.ok(!canGrow(item), '늘지 않을 항목에 번호가 붙으면 모델이 그 번호로 청구하느라 스텝을 버린다');
  // 같은 항목을 다시 넓혀도 한 글자도 늘지 않는다 — full이 참이어야 하는 근거다.
  const [again] = buildItems([{ doc_seq: 1, rep: 5, from: item.from, to: item.to, chunk_of: 22, dist: 0.3 }], rows, { grow: true });
  assert.equal(again.content.length, item.content.length);
});

test('읽어 오지 않은 이웃은 모른다 — full은 서지 않고 번호가 남는다', () => {
  // 계획된 범위(3~4)의 행만 있고 이웃은 없다. 넓힐 수 있을지 모르므로 청구할 수 있어야 한다.
  const [item] = buildItems(planRanges([hit(1, 3, 0.31), hit(1, 4, 0.35)]), [row(1, 3), row(1, 4)]);
  assert.equal(item.full, false);
  assert.ok(canGrow(item));
  // 이웃을 함께 읽었고(search.js가 그렇게 읽는다) 그것이 들어가면 역시 청구할 수 있다 — 싣지는 않는다.
  const [open] = buildItems(planRanges([hit(1, 3, 0.31), hit(1, 4, 0.35)]), [row(1, 2), row(1, 3), row(1, 4), row(1, 5)]);
  assert.equal(open.full, false);
  assert.deepStrictEqual([open.from, open.to], [3, 4], '검색은 계획된 범위 밖의 이웃을 싣지 않는다');
  // 문서 전체가 실렸으면 이웃이 문서 밖이라 full이다.
  const [whole] = buildItems(planRanges([hit(1, 1, 0.31, 2), hit(1, 2, 0.35, 2)]), [row(1, 1, 900, 2), row(1, 2, 900, 2)]);
  assert.equal(whole.full, true);
  assert.ok(!canGrow(whole));
});

test('검색 시점에 이웃을 읽었으면 그 자리에서 full이 확정된다', () => {
  // 계획된 범위(1~4, 1,000자씩)는 꽉 찼고 이웃 5번(1,000자)은 안 들어간다 — 번호 없이 실려야 한다.
  const rows = Array.from({ length: 5 }, (_, i) => row(1, i + 1, 1000, 8));
  const [item] = buildItems([{ doc_seq: 1, rep: 2, from: 1, to: 4, chunk_of: 8, dist: 0.3 }], rows);
  assert.deepStrictEqual([item.from, item.to], [1, 4]);
  assert.equal(item.full, true);
  assert.ok(!canGrow(item));
});

// ===== 문서당 상한은 프롬프트에 실리는 형태로 잰다 =====
// 원문 길이로 재면 줄이 많은 본문(마크다운 목록·표)이 들여쓰기만큼 상한을 넘겨 프롬프트가 다시 자르고 잘림 표시를
// 붙인다 — 4,499자짜리 병합 항목이 355자를 잃고 '…(생략)'을 달고 나갔다(실측). '검색된 청크는 프롬프트에서 다시
// 잘리지 않는다'(context.md 2-5)가 이 자리에서만 깨져 있었다.
test('줄이 많은 본문도 문서당 상한 안에서 병합되어 프롬프트에서 다시 잘리지 않는다', async () => {
  const { buildPrompt } = await import('../src/llm-openai.js');
  const { indentLines, TRUNC_MARK } = await import('../src/constants.js');
  const list = (n, w) => Array.from({ length: n }, (_, i) => `- ${String(i).padStart(2, '0')} ${'가'.repeat(w - 5)}`).join('\n');
  const rows = [1, 2, 3, 4].map(n => ({ ...row(9, n, 0, 5), content: list(40, 24) }))   // 999자·40줄
    .concat([{ ...row(9, 5, 0, 5), content: list(20, 24) }]);                           // 499자·20줄
  const [item] = buildItems([{ doc_seq: 9, rep: 3, from: 1, to: 5, chunk_of: 5, dist: 0.3 }], rows, { grow: true });
  assert.ok(item.content.length < MAX_DOC_LEN, '이 시나리오는 원문으로는 상한 안이어야 뜻이 있다');
  assert.ok(indentLines(item.content).length <= MAX_DOC_LEN, `프롬프트 형태가 상한을 넘는다: ${indentLines(item.content).length}`);
  const p = buildPrompt({ knowledge: [item], qaMethods: [], queries: [], history: [], chat: [], question: 'q', searched: ['knowledge'], tried: true });
  assert.ok(!p.includes(TRUNC_MARK), '청크 항목이 프롬프트에서 다시 잘렸다');
  assert.ok(p.includes(`- ${String(19).padStart(2, '0')} `) || p.includes(`- ${String(39).padStart(2, '0')} `), '실린 범위의 마지막 줄이 사라졌다');
});

// ===== 분할 경계와 서로게이트 쌍 =====
// 강제 절단과 겹침 시작은 임의의 코드유닛 위치라 이모지 한가운데에 떨어질 수 있다. 그러면 앞 청크는 상위
// 서로게이트로 끝나고 다음 청크는 하위 서로게이트로 시작한다(실측) — 유효한 UTF-8이 아니라 임베딩 서버가
// 그 행을 매 주기 거부하거나 U+FFFD로 바꿔 놓고, 프롬프트에 실리면 LLM 호출이 인코딩 단계에서 실패한다.
// constants.clipText·stripLoneSurrogates가 막는 실패 부류가 이 경계에서만 빠져 있었다.
test('분할은 서로게이트 쌍(이모지)을 반으로 쪼개지 않는다', async () => {
  const { stripLoneSurrogates } = await import('../src/constants.js');
  const intact = parts => parts.every(p => stripLoneSurrogates(p) === p);
  // 겹침 시작(경계 - CHUNK_OVERLAP)에 이모지가 걸리는 글
  const overlapHit = '가'.repeat(551) + '🚀' + '가'.repeat(147) + '\n\n' + '나'.repeat(1500);
  const a = splitContent(overlapHit);
  assert.ok(intact(a), `겹침 시작에서 쌍이 갈라졌다: ${a.map(p => p.charCodeAt(0).toString(16)).join(',')}`);
  assert.ok(a.some(p => p.includes('🚀')), '이모지가 어느 청크에도 온전히 남지 않았다');
  // 강제 절단(상한 자리)에 이모지가 걸리는 덩어리
  const forcedHit = '가'.repeat(CHUNK_MAX_LEN - 1) + '🚀' + '가'.repeat(2000);
  const b = splitContent(forcedHit);
  assert.ok(intact(b), '강제 절단에서 쌍이 갈라졌다');
  for (const c of b) assert.ok(c.length <= CHUNK_MAX_LEN, `상한 초과: ${c.length}`);
  // 이모지만으로 된 글 — 모든 위치가 쌍의 안팎이다. 유한 번에 끝나고 어느 조각도 깨지지 않아야 한다.
  const emojiOnly = '🚀'.repeat(3000);
  const c = splitContent(emojiOnly);
  assert.ok(c.length > 3 && c.length < 100, `청크 수가 이상하다: ${c.length}`);
  assert.ok(intact(c), '이모지만 든 글에서 쌍이 갈라졌다');
});

// 꼬리 청크만 앞 공백을 떼지 않고 있었다 — 겹침 시작이 빈 줄 구간에 떨어지면 앞 공백이 최대 겹침 길이만큼 붙어
// 임베딩 원문과 청크 저장소에 그대로 들어갔다(퍼징으로 잡았다). 모든 청크가 같은 모양이어야 한다.
test('모든 청크는 앞뒤 공백 없이 저장된다 — 꼬리 청크도', () => {
  // 경계(빈 줄) 뒤 겹침 구간이 통째로 빈 줄이라 꼬리 청크의 시작이 공백에 떨어지는 글
  const s = '가'.repeat(800) + '\n'.repeat(200) + '나'.repeat(300);
  const parts = splitContent(s);
  assert.ok(parts.length >= 2, `이 시나리오는 두 청크 이상이어야 뜻이 있다: ${parts.length}`);
  for (const [i, p] of parts.entries()) assert.equal(p, p.trim(), `${i + 1}번 청크에 앞뒤 공백이 남았다`);
  assert.ok(parts.every(p => p.length > 0));
});
