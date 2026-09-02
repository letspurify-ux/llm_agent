// LLM 응답 파싱 회귀 테스트 — 실행: npm test
// 이 파싱은 조용히 깨진다: 모델은 제대로 답했는데 결정을 못 읽어 "LLM 호출에 실패했습니다"가 나가고,
// temperature=0이라 재시도도 같은 응답을 받아 똑같이 실패한다. 로그를 봐도 모델 탓처럼 보인다.
import { test } from 'node:test';
import assert from 'node:assert';

process.env.LLM_BASE_URL = 'http://test.invalid/v1';
process.env.LLM_MODEL = 'test';
delete process.env.LLM_API_KEY;

const { openaiDecide } = await import('../src/llm-openai.js');
const { TRUNC_MARK, MAX_COMPLETION_TOKENS } = await import('../src/constants.js');

const CTX = { question: 'q', chat: [], knowledge: [], qaMethods: [], queries: [], history: [] };

// fetch를 스텁해 모델 응답 문자열만 갈아끼운다
function reply(content) {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }), text: async () => '' });
}

const decide = async (content, ctx = CTX) => {
  reply(content);
  return openaiDecide(ctx);
};

test('JSON 바깥의 중괄호가 파싱을 깨뜨리지 않는다', async () => {
  // 추론 모델이 <think>를 content로 흘리는 경우 — 첫 '{'가 사고 과정 안에 있다
  assert.deepStrictEqual(
    await decide('<think>{job_id}를 써야겠다.</think>\n{"action":"run_query","query_name":"batch_job_status","params":{"job_id":"BATCH001"}}'),
    { action: 'run_query', query_name: 'batch_job_status', params: { job_id: 'BATCH001' } }
  );
  // JSON 뒤에 설명문이 붙는 경우 — 마지막 '}'가 JSON 밖에 있다
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"안녕"}\n\n참고: {중괄호}'),
    { action: 'answer', answer: '안녕' }
  );
  // 결정 뒤에 예시 JSON을 덧붙이는 경우 — 앞의 진짜 결정이 이겨야 한다.
  // 뒤를 채택하면 예시 한 줄이 실행돼야 할 쿼리를 조용히 답변으로 바꿔치기한다.
  assert.deepStrictEqual(
    await decide('{"action":"run_query","query_name":"batch_job_status","params":{"job_id":"B1"}}\n예시 형식: {"action":"answer","answer":"..."}'),
    { action: 'run_query', query_name: 'batch_job_status', params: { job_id: 'B1' } }
  );
});

test('산문에 섞인 짝 없는 중괄호가 뒤의 JSON을 가리지 않는다', async () => {
  // 깊이를 한 번에 누적하면 이 '{' 하나가 깊이를 영구히 어긋내 진짜 결정을 통째로 놓친다
  assert.deepStrictEqual(
    await decide('<think>params에 {job_id 값을 넣자</think>\n{"action":"run_query","query_name":"batch_job_status","params":{"job_id":"BATCH001"}}'),
    { action: 'run_query', query_name: 'batch_job_status', params: { job_id: 'BATCH001' } }
  );
});

test('사고 과정 안의 초안 JSON을 결정으로 오인하지 않는다', async () => {
  // 추론 모델은 <think> 안에서 후보를 써 보고 뒤집는다 — 그 초안이 최종 결정을 이기면 안 된다
  assert.deepStrictEqual(
    await decide('<think>일단 {"action":"run_query","query_name":"find_customer_id","params":{"customer_name":"홍길동"}} 로 해볼까. 아니다, 이미 이력에 있으니 답변하자.</think>\n{"action":"answer","answer":"최근 주문은 O-777입니다"}'),
    { action: 'answer', answer: '최근 주문은 O-777입니다' }
  );
  // 닫히지 않은 <think>(토큰 한도로 잘린 응답)도 결정으로 새어 나오면 안 된다
  assert.equal(await decide('<think>{"action":"answer","answer":"초안"} 으로 할까'), null);
  // Qwen3·R1 계열 기본 템플릿은 <think>를 프롬프트에 미리 붙이므로 content에는 닫는 태그만 온다.
  // 여는 태그만 찾으면 이 형태에서 사고 과정이 통째로 살아남아 초안이 결정으로 잡힌다.
  assert.deepStrictEqual(
    await decide('이미 이력에 있으니 {"action":"run_query","query_name":"find_customer_id","params":{"customer_name":"홍길동"}} 로 해볼까. 아니다.</think>\n{"action":"answer","answer":"최근 주문은 O-777입니다"}'),
    { action: 'answer', answer: '최근 주문은 O-777입니다' }
  );
});

test('답변 본문에 든 사고 과정 태그가 결정을 삼키거나 훼손하지 않는다', async () => {
  // 모델이 답변에 태그 문자열을 쓰는 일이 있다(그 태그가 무엇인지 묻는 질문 등).
  // 사고 과정을 '텍스트에서 지우는' 방식은 그 태그와 진짜 태그를 구분할 수 없어 양방향으로 깨졌다.
  // 둘 다 조용하다 — temperature=0이라 재시도도 같은 응답을 받아 똑같이 반복된다.

  // ① 닫는 태그: 앞쪽(=진짜 결정)이 통째로 잘려 나갔다
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"</think> 는 사고 과정의 끝을 뜻합니다"}'),
    { action: 'answer', answer: '</think> 는 사고 과정의 끝을 뜻합니다' }
  );
  // ② 여는 태그: 태그부터 끝까지 지워져 JSON이 깨지고 결정이 사라졌다
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"<think> 는 사고 과정의 시작을 뜻합니다"}'),
    { action: 'answer', answer: '<think> 는 사고 과정의 시작을 뜻합니다' }
  );
  // ③ 짝이 맞는 태그: 이쪽이 가장 나쁘다 — JSON은 살아남고 본문만 도려낸 채
  //    '정상 결정'으로 사용자에게 나간다. 오류도 재시도도 흔적도 없다.
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"<think>사고</think> 안이 사고 과정입니다"}'),
    { action: 'answer', answer: '<think>사고</think> 안이 사고 과정입니다' }
  );
  // run_query의 바인드 값도 같은 경로를 탄다 — 훼손되면 조용히 0건 오답이 된다
  assert.deepStrictEqual(
    await decide('{"action":"run_query","query_name":"q1","params":{"k":"</think>"}}'),
    { action: 'run_query', query_name: 'q1', params: { k: '</think>' } }
  );
  // 결정 뒤 산문에 태그가 붙는 형태 — 태그는 진짜지만 결정은 그 앞에 있다
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"먼저 설명"}\n\n참고: 태그는 </think> 입니다'),
    { action: 'answer', answer: '먼저 설명' }
  );
  // 진짜 사고 과정과 본문 속 태그가 함께 있어도 갈라진다 (앞은 진짜 ②, 뒤는 본문)
  assert.deepStrictEqual(
    await decide('무엇을 물었는지 보자...</think>\n{"action":"answer","answer":"<think>는 여는 태그"}'),
    { action: 'answer', answer: '<think>는 여는 태그' }
  );
});

test('여는 태그가 실제로 있는 구간의 초안은 결정으로 새어 나오지 않는다', async () => {
  // ①③은 여는 태그가 실제로 있으니 그 안의 JSON은 초안이다 — 초안을 결정으로 내보내면
  // 잘린 응답이 그대로 실행으로 이어진다 (결정을 못 찾는 것보다 나쁘다).
  assert.equal(await decide('<think>{"action":"answer","answer":"초안"} 으로 할까'), null);
  assert.equal(
    await decide('<think>{"action":"run_query","query_name":"a","params":{}} 로 할까</think>\n결론을 내지 못했습니다'),
    null
  );
  // 초안이 자기 안에 닫는 태그를 담고 있어도 살아나지 않는다 (마스킹이 여는 태그를 지우지 못한다)
  assert.equal(await decide('<think>초안 {"action":"answer","answer":"</think>"} 어떨까'), null);
  // ② 형태에서 뒤쪽에 진짜 결정이 있으면 앞쪽 초안은 여전히 지나친다 (순서가 지켜진다)
  assert.deepStrictEqual(
    await decide('{"action":"run_query","query_name":"초안","params":{}} 아니다.</think>\n{"action":"answer","answer":"최종"}'),
    { action: 'answer', answer: '최종' }
  );
});

test('결정 앞에 놓인 JSON이 태그를 담고 있어도 결정을 찾는다', async () => {
  // 결정보다 앞에 놓인 JSON 하나가 문자열에 '<think>'를 담고 있으면(형식 예시 등), 그것을 진짜
  // 태그로 세는 순간 그 뒤 전부가 사고 과정으로 보여 진짜 결정이 후보에도 오르지 못한다.
  // 파싱에 성공한 객체를 통째로 건너뛰는 것이 이 경우를 막는다 — 그 안의 태그는 눈에 들어오지 않는다.
  const FINAL = { action: 'answer', answer: 'ok' };
  assert.deepStrictEqual(
    await decide('{"note":"<think> 를 설명합니다"}\n{"action":"answer","answer":"ok"}'), FINAL);
  assert.deepStrictEqual(
    await decide('형식: {"action":"<think>"}\n실제: {"action":"answer","answer":"ok"}'), FINAL);
  assert.deepStrictEqual(
    await decide('{"note":"</think> 를 설명합니다"}\n{"action":"answer","answer":"ok"}'), FINAL);
});

test('다른 이름의 사고 과정 태그 안에서도 초안이 새어 나오지 않는다', async () => {
  // '<think>'만 보면 다른 표기를 쓰는 모델에서 블록이 인식되지 않고, 그 안의 초안이 '사고 과정 밖'으로
  // 분류돼 후보 중 처음이라 진짜 결정보다 먼저 채택된다 — 검토하다 접은 run_query가 실제로 실행된다.
  // LLM_MODEL은 설정으로 바뀌고 시스템 프롬프트가 사고 과정 표기를 지정하지도 않으므로,
  // 어떤 표기가 올지는 이 파서가 정할 수 없다.
  const draft = '{"action":"run_query","query_name":"DRAFT","params":{}}';
  const final = '{"action":"answer","answer":"최종"}';
  for (const tag of ['thinking', 'reasoning', 'thought', 'scratchpad', 'reflection']) {
    assert.deepStrictEqual(
      await decide(`<${tag}>${draft} 로 할까. 아니다.</${tag}>\n${final}`),
      { action: 'answer', answer: '최종' }, tag);
    assert.equal(await decide(`<${tag}>${draft} 로 할까.</${tag}>\n결론 없음`), null, tag);
  }
  // 이름이 섞여도 여닫이 판정은 이름과 무관하다 (깊이만 센다)
  assert.deepStrictEqual(
    await decide(`<thinking>${draft} 아니다</think>\n${final}`), { action: 'answer', answer: '최종' });
});

test('태그 매치가 결정 JSON 안으로 넘어가지 않는다', async () => {
  // 속성 문자에 중괄호를 허용하면 매치가 결정 JSON 안으로 들어가 그 안의 '>'를 태그의 끝으로 삼는다.
  // `설명: <think 태그입니다. {"…":"a>b"}` 에서 `<think … a>` 까지가 '여는 태그'가 되어
  // 닫히지 않은 블록(③)이 되고 뒤의 정상 결정이 버려진다.
  // '>'가 답변 본문에 들어가는 것은 흔하다 — 마크다운 인용, '->', HTML 예시.
  assert.deepStrictEqual(
    await decide('설명: <think 태그입니다. {"action":"answer","answer":"a>b"}'),
    { action: 'answer', answer: 'a>b' });
  assert.deepStrictEqual(
    await decide('설명: <think 태그</think>\n{"action":"answer","answer":"a>b"}'),
    { action: 'answer', answer: 'a>b' });
  assert.deepStrictEqual(
    await decide('{"action":"run_query","query_name":"real","params":{"a":"a>b"}}'),
    { action: 'run_query', query_name: 'real', params: { a: 'a>b' } });
});

test('자기닫힘 태그가 응답 전체를 사고 과정으로 만들지 않는다', async () => {
  // '<think/>'는 내용이 없는 빈 블록인데 여는 태그로 세면 영영 닫히지 않아(③) 그 뒤 전부가
  // 사고 과정이 되고, 그 응답의 결정이 통째로 버려진다. 모델이 이 표기를 쓰기 시작하면
  // '모든 질문'이 같은 이유로 실패하는데 화면에는 'LLM 호출 실패' 한 줄만 나가 원인이 보이지 않는다.
  const FINAL = { action: 'answer', answer: 'ok' };
  for (const tag of ['<think/>', '<think />', '<think/>\n<think/>']) {
    assert.deepStrictEqual(await decide(`${tag}\n{"action":"answer","answer":"ok"}`), FINAL, tag);
  }
  // 빈 블록이라고 해서 진짜 블록의 판정이 느슨해지면 안 된다
  assert.equal(
    await decide('<think/>\n<think>{"action":"answer","answer":"초안"} 로 할까'), null);
});

test('실제 추론 모델이 내는 형태를 그대로 읽는다', async () => {
  // 이 파서가 상대하는 것은 결국 특정 몇 가지 실제 출력 형태다 — 적대적 입력만 방어하고
  // 정작 흔한 형태를 놓치면 모든 질문이 조용히 실패한다.
  const RUN = { action: 'run_query', query_name: 'batch_job_status', params: { job_id: 'BATCH001' } };
  const d = '{"action":"run_query","query_name":"batch_job_status","params":{"job_id":"BATCH001"}}';
  // DeepSeek-R1 계열: 여는 태그까지 content에 온다
  assert.deepStrictEqual(await decide(`<think>\n사용자가 BATCH001 상태를 물었다.\n</think>\n\n${d}`), RUN);
  // Qwen3 계열: 템플릿이 여는 태그를 프롬프트에 선점해 닫는 태그만 온다
  assert.deepStrictEqual(await decide(`\n사용자가 BATCH001 상태를 물었다.\n</think>\n\n${d}`), RUN);
  // 사고 과정 안에서 펜스로 초안을 써 보는 형태
  assert.deepStrictEqual(
    await decide(`<think>\n\`\`\`json\n{"action":"answer","answer":"초안"}\n\`\`\`\n아니다.\n</think>\n${d}`), RUN);
  // 결정 자체를 펜스로 감싸는 형태
  assert.deepStrictEqual(await decide(`사고중...</think>\n\`\`\`json\n${d}\n\`\`\``), RUN);
  // 여는 태그가 줄바꿈을 품는 형태
  assert.deepStrictEqual(await decide(`<think\n>초안</think>\n${d}`), RUN);
  // 추론하지 않는 모델 (태그가 아예 없다)
  assert.deepStrictEqual(await decide(d), RUN);
});

test('닫는 태그 앞의 초안 쿼리는 2순위로도 실행 결정이 되지 않는다', async () => {
  // 2순위(= '사고 과정일 것'이라고 본 구간에서 꺼내 오는 뒷문)는 그 JSON이 초안일 가능성이
  // 남아 있다. 손해가 양쪽으로 전혀 다르다: answer는 덜 다듬어진 답변이 보일 뿐이지만,
  // run_query는 모델이 검토하다 접은 쿼리를 조회대상 DB에 실제로 실행하고 그 결과가 다시
  // 최종 답변의 근거가 된다 — 여는 태그가 있는 구간에서 초안을 막는 이유가 그대로 여기에도 있다.
  // ②는 가장 흔한 형태이고(Qwen3·R1 기본 템플릿) 뒤쪽 응답이 잘리는 것도 흔하다.
  const draft = '{"action":"run_query","query_name":"DRAFT","params":{"job_id":"X"}}';
  for (const tail of ['\n{"action":"ans', '\n음... 잘 모르겠습니다', '\n{"action":"answer","answer":"  "}', '']) {
    assert.equal(await decide(`${draft} 로 할까</think>${tail}`), null, JSON.stringify(tail));
  }
  // 뒤쪽에 진짜 결정이 있으면 그것이 1순위로 채택된다 (초안은 여전히 지나친다)
  assert.deepStrictEqual(
    await decide(`${draft} 아니다</think>\n{"action":"answer","answer":"최종"}`),
    { action: 'answer', answer: '최종' }
  );
  // 2순위의 answer는 계속 살린다 — 이 뒷문이 원래 막으려던 경우다
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"먼저 설명"}\n\n참고: 태그는 </think> 입니다'),
    { action: 'answer', answer: '먼저 설명' }
  );
});

test('사고 과정이 태그 이름을 언급해도 뒤의 닫는 태그를 삼키지 않는다', async () => {
  // 태그 속성 문자에 '<'를 허용하면 매치가 태그 경계를 넘어 다음 태그를 통째로 삼킨다:
  // `<think 태그를 물었다</think>` 가 '여는 태그 하나'로 잡혀 진짜 닫는 태그가 사라지고,
  // 닫히지 않은 블록(③)이 되어 그 뒤의 정상 결정이 통째로 버려진다.
  // 하필 이 파일이 지키려는 바로 그 상황에서 터진다 — 사용자가 think 태그를 물으면 모델의
  // 사고 과정이 자연스럽게 '<think'를 언급하고, 그 언급은 JSON 밖이라 마스킹도 구해주지 못한다.
  const FINAL = { action: 'answer', answer: 'ok' };
  assert.deepStrictEqual(
    await decide('사용자가 <think 태그를 물었다</think>\n{"action":"answer","answer":"ok"}'), FINAL);
  assert.deepStrictEqual(
    await decide('사용자가 </think 를 물었다</think>\n{"action":"answer","answer":"ok"}'), FINAL);
  // 여는 태그가 실제로 있는 블록 안에서 언급해도 그 블록은 정상적으로 닫혀야 한다
  assert.deepStrictEqual(
    await decide('<think>사용자가 <think 를 물었다</think>\n{"action":"answer","answer":"ok"}'), FINAL);
  // 삼킴이 없어야 초안 차단도 그대로 성립한다 (블록이 닫히는 것과 초안이 새는 것은 별개다)
  assert.equal(
    await decide('<think><think 를 보자 {"action":"answer","answer":"초안"}</think>\n결론 없음'), null);
});

test('닫히지 않은 여는 태그가 반복돼도 파싱이 이벤트 루프를 붙잡지 않는다', async () => {
  // 태그 정규식의 속성 부분에 상한이 없으면(`[^>]*`) '>'가 없는 입력에서 매 '<think'마다 남은
  // 텍스트를 끝까지 훑고 되돌아온다 — 시작점 수 × 길이라 정확히 이차다(ReDoS).
  // 실측: 상한 없이 94KB에서 578ms, 크기 2배마다 시간은 4배 → 1MB면 1분을 넘긴다.
  // temperature=0에서 같은 토큰을 반복하는 퇴화한 응답은 실제로 나오고, 그 한 건이 동시에
  // 처리 중인 모든 요청을 그만큼 멈춰 세운다.
  const t0 = Date.now();
  await decide('<think'.repeat(170_000));   // 약 1MB, '>'가 하나도 없다
  assert.ok(Date.now() - t0 < 2000, `파싱이 너무 오래 걸림: ${Date.now() - t0}ms`);
});

test('속성이 붙은 태그는 인식하되 상한을 넘으면 태그로 보지 않는다', async () => {
  // 상한(100자)은 실제 템플릿이 내는 태그에 개입하지 않아야 한다 — 개입하면 진짜 사고 과정을
  // 놓쳐 그 안의 초안이 결정으로 새어 나온다.
  assert.equal(
    await decide('<think type="draft">{"action":"answer","answer":"초안"}</think>\n결론 없음'), null);
  // 상한을 넘는 것은 태그가 아니라 산문이다 — '>' 없는 '<think'를 태그로 치지 않는 것과 같은 취급이다.
  // ('미완성 여는 태그'로 취급하면 태그 이름을 언급한 질문의 정상 답변이 통째로 버려진다)
  assert.deepStrictEqual(
    await decide(`<think ${'a'.repeat(500)}>\n{"action":"answer","answer":"ok"}`),
    { action: 'answer', answer: 'ok' }
  );
  assert.deepStrictEqual(
    await decide('모델은 <think 라고 씁니다\n{"action":"answer","answer":"ok"}'),
    { action: 'answer', answer: 'ok' }
  );
});

test('태그와 후보가 뒤섞여 많아도 파싱이 이벤트 루프를 붙잡지 않는다', async () => {
  // 사고 과정을 구간으로 다루면 구간 수도 응답 길이에 비례해 늘어난다. 구간을 선형으로 훑으면
  // 조회 수 × 구간 수가 되어, '</think>{"…}'가 번갈아 든 응답 하나가 이벤트 루프를 십수 초
  // 붙잡는다(실측 11.5초) — 위 '짝 없는 중괄호' 테스트가 막으려는 것과 같은 종류의 실패가
  // 후보 쪽이 아니라 구간 쪽 문으로 되살아난다. 동시에 처리 중인 모든 요청이 함께 멈춘다.
  const t0 = Date.now();
  await decide(Array.from({ length: 50_000 }, (_, i) => `</think>{"d":${i}}`).join(''));
  assert.ok(Date.now() - t0 < 2000, `파싱이 너무 오래 걸림: ${Date.now() - t0}ms`);
});

test('닫는 태그가 반복돼도 후보 탐색 총량이 이차로 늘지 않는다', async () => {
  // 예산을 구간이 닫힐 때마다 되돌리므로(뒤의 결정을 굶기지 않기 위해) 되돌림과 무관한 전역
  // 상한이 함께 있어야 한다. 없으면 매 구간이 예산을 새로 받아 전역 비용 상한이 사라진다.
  // 바로 위 테스트가 이 경로를 놓친 이유는 후보가 전부 '{"d":0}'처럼 짝이 맞아 matchingBrace가
  // 즉시 끝나기 때문이다 — 짝 없는 '{"'라야 매번 남은 텍스트를 끝까지 훑는다.
  // 실측(전역 상한 없을 때): 43KB 349ms, 86KB 1,580ms, 172KB 6.3s — 크기 2배마다 4배.
  // 그 시간은 동기 작업이라 동시에 처리 중인 모든 요청이 함께 멈춘다.
  const t0 = Date.now();
  await decide('</think>{"a'.repeat(16_000));   // 약 172KB, 구간 1만 6천 개 · 전부 짝 없는 후보
  assert.ok(Date.now() - t0 < 2000, `파싱이 너무 오래 걸림: ${Date.now() - t0}ms`);
});

test('앞선 사고 과정 구간이 뒤 구간의 후보 예산을 먹지 않는다', async () => {
  // 앞 구간에서 쓴 예산을 그대로 이어가면, 후보가 잔뜩 든 구간 하나가 뒤 구간의 몫까지 먹는다.
  // 그 뒤에 진짜 결정이 있으면 후보로 오르지도 못해 파싱이 통째로 실패한다
  // (실측: 고치기 전 null → 사용자에게는 'LLM 호출 실패'만 나갔다).
  // 닫는 태그만 오는 형태(②)는 Qwen3·R1 기본 템플릿의 기본값이라 두 번 이어지는 것이 드물지 않다.
  const noisy = Array.from({ length: 150 }, (_, i) => `{"draft":${i}}`).join(' ');
  assert.deepStrictEqual(
    await decide(`${noisy} </think>\n{"action":"answer","answer":"최종"} </think>`),
    { action: 'answer', answer: '최종' }
  );
});

test('장황한 사고 과정이 뒤따르는 진짜 결정의 후보 예산을 먹지 않는다', async () => {
  // 초안이 잔뜩 든 사고 과정 하나가 후보 예산을 다 먹으면 그 뒤의 진짜 결정에 닿지 못한다.
  // (지금은 정상 파싱되는 초안이 예산을 쓰지 않고, 구간이 닫힐 때 예산이 되돌아온다.)
  // 결과는 '결정 JSON을 찾지 못함'이고, 모델은 제대로 답했으므로 로그만 봐서는 모델 탓처럼 보인다.
  const drafts = n => Array.from({ length: n }, (_, i) => `{"draft":${i},"why":"이걸 써볼까"}`).join(' 아니다. ');
  const FINAL = '{"action":"answer","answer":"최종"}';
  for (const content of [
    `<think>${drafts(500)}</think>\n${FINAL}`,   // ① 여는 태그가 있는 구간
    `${drafts(500)}</think>\n${FINAL}`,          // ② 닫는 태그만 오는 구간
    `${FINAL}\n예시들: ${drafts(500)}`,           // 결정 뒤 설명문
  ]) {
    assert.deepStrictEqual(await decide(content), { action: 'answer', answer: '최종' }, content.slice(0, 40));
  }
});

// 경고 로그를 잡아 본다 — 이 감지의 존재 이유가 '로그로 드러나는 것'이므로 로그를 검증한다.
async function decideWithWarnings(content) {
  const seen = [];
  const orig = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try {
    const decision = await decide(content);
    return { decision, markup: seen.filter(l => l.includes('unrecognized reasoning markup')) };
  } finally {
    console.warn = orig;
  }
}

test('모르는 사고 과정 표기가 오면 로그로 알린다', async () => {
  // 목록 밖의 표기를 쓰는 모델에서는 블록이 인식되지 않아 그 안의 초안이 결정으로 채택된다.
  // 그 실패는 '정상 응답'처럼 보인다 — 결정 JSON은 멀쩡하고 오류도 재시도도 없다.
  // 사고 과정 태그는 대개 모델의 채팅 템플릿이 붙이는 것이라 시스템 프롬프트로 완전히 통제되지
  // 않고 LLM_MODEL도 설정으로 바뀌므로, 무엇을 지원해야 하는지 알 단서는 이 로그뿐이다.
  const draft = '{"action":"run_query","query_name":"DRAFT","params":{}}';
  for (const [open, close] of [['<|thinking|>', '<|/thinking|>'], ['◁think▶', '◁/think▶'],
                               ['<thoughts>', '</thoughts>'], ['<analysis>', '</analysis>']]) {
    const { markup } = await decideWithWarnings(`${open}${draft} 아니다${close}\n{"action":"answer","answer":"최종"}`);
    assert.equal(markup.length, 1, `${open} 를 알려야 한다`);
    assert.ok(markup[0].includes(open), `어떤 표기였는지 로그에 남아야 한다: ${markup[0]}`);
  }
});

test('아는 표기와 무관한 마크업에는 경고하지 않는다', async () => {
  // 무관한 것까지 알리면 진짜 신호가 로그에 묻힌다.
  const draft = '{"action":"run_query","query_name":"DRAFT","params":{}}';
  for (const tag of ['think', 'thinking', 'reasoning', 'scratchpad']) {
    const { markup } = await decideWithWarnings(`<${tag}>${draft} 아니다</${tag}>\n{"action":"answer","answer":"최종"}`);
    assert.deepStrictEqual(markup, [], tag);
  }
  for (const content of [
    '<b>강조</b><br/>\n{"action":"answer","answer":"ok"}',        // 사고 과정과 무관한 마크업
    '{"action":"answer","answer":"ok"}',                          // 마크업 없음
    // 답변 본문이 태그를 '설명'하는 경우 — 이 파일이 지키려는 바로 그 상황이다
    '{"action":"answer","answer":"<thoughts> 는 사고 과정 태그입니다"}',
    '{"action":"answer","answer":"<|thinking|> 도 같은 뜻입니다"}',
  ]) {
    const { markup } = await decideWithWarnings(content);
    assert.deepStrictEqual(markup, [], content);
  }
});

// ===== 아래 네 개는 뮤테이션 테스트로 찾은 '고정되지 않은 동작'을 못 박는다 =====
// 파싱 로직에 인위적 결함을 심어 보면 기존 테스트가 전부 통과하는 자리가 있었다.
// 동작 자체는 옳았지만, 테스트가 잡아주지 않으면 다음 변경이 조용히 깨뜨린다.

test('사고 과정 밖의 결정이 추정 구간 안의 결정을 이긴다', async () => {
  // 순위를 뒤집어도 기존 테스트가 전부 통과했다 — 2순위는 어디까지나 뒷문이라는 것이
  // 어디에도 고정돼 있지 않았다. 뒤집히면 닫는 태그 앞의 초안 answer가 진짜 답변을 덮는다.
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"추정구간"}</think>\n{"action":"answer","answer":"구간밖"}'),
    { action: 'answer', answer: '구간밖' }
  );
});

test('닫는 태그가 이어져도 구간이 서로 겹치지 않는다', async () => {
  // 닫는 태그를 만나면 '직전 구간 뒤에 쌓인 후보'만 추정으로 표시해야 한다. 이미 분류한 것까지
  // 다시 훑으면 어떤 후보가 어느 구간에 속하는지가 무너지고, 그 자체가 이차 비용이 된다.
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"A"}</think>{"action":"answer","answer":"B"}</think>\n{"action":"answer","answer":"C"}'),
    { action: 'answer', answer: 'C' }
  );
  // 구간 끝에 '붙여 쓴' 결정은 구간 밖이다 — 경계가 한 칸 어긋나면 run_query가 2순위로 밀려 버려진다
  assert.deepStrictEqual(
    await decide('</think>{"action":"run_query","query_name":"real","params":{}}'),
    { action: 'run_query', query_name: 'real', params: {} }
  );
});

test('여는 태그가 겹쳐도 바깥 블록이 끝까지 유지된다', async () => {
  // 깊이를 세지 않거나 여는 위치를 매번 갱신하면 바깥 블록이 안쪽 태그에서 끝난 것으로 보여,
  // 그 앞뒤의 초안이 '사고 과정 밖'으로 분류돼 결정으로 새어 나온다.
  assert.equal(
    await decide('<think>{"action":"answer","answer":"초안A"}<think>{"action":"answer","answer":"초안B"}'), null);
  assert.equal(
    await decide('<think>x<think>y</think>{"action":"answer","answer":"샜다"}'), null);
});

test('answer 본문의 이스케이프와 짝 없는 중괄호가 경계를 어긋내지 않는다', async () => {
  // matchingBrace의 문자열·이스케이프 추적을 없애도 기존 테스트는 통과했다 —
  // 본문의 따옴표·중괄호가 '짝이 맞는' 예시뿐이라 상태가 두 번 뒤집혀 우연히 같은 답이 나왔다.
  // 짝이 맞지 않으면 경계가 어긋나 JSON.parse가 실패하고, 제대로 답한 응답이 통째로 버려진다.
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"예시는 {\\"a\\":1} 입니다"}'),
    { action: 'answer', answer: '예시는 {"a":1} 입니다' });
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"그는 \\"안녕\\"}"}'),
    { action: 'answer', answer: '그는 "안녕"}' });
  // 이스케이프가 '홀수 개'여야 추적을 검증한다 — 짝수 개면 문자열 상태가 두 번 뒤집혀
  // 추적이 없어도 우연히 같은 경계가 나온다(그래서 위 예시들만으로는 고정되지 않았다).
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"따옴표 \\" 뒤 중괄호 }"}'),
    { action: 'answer', answer: '따옴표 " 뒤 중괄호 }' });
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"여는 중괄호 { 하나"}'),
    { action: 'answer', answer: '여는 중괄호 { 하나' });
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"닫는 중괄호 } 하나"}'),
    { action: 'answer', answer: '닫는 중괄호 } 하나' });
});

test('짝 없는 중괄호가 많아도 파싱이 이벤트 루프를 붙잡지 않는다', async () => {
  // 토큰 한도에서 잘린 응답은 짝 없는 '{'를 대량으로 남긴다. 시작점마다 끝까지 훑으면
  // 그 한 건이 동시에 처리 중인 다른 요청까지 수 초간 멈춰 세운다.
  const t0 = Date.now();
  await decide('{"'.repeat(40_000));
  assert.ok(Date.now() - t0 < 2000, `파싱이 너무 오래 걸림: ${Date.now() - t0}ms`);
});

test('JSON 바깥 산문의 홀수 따옴표가 스캔을 삼키지 않는다', async () => {
  // 중괄호 밖에서까지 문자열 상태를 세면 따옴표 하나가 뒤 전체를 '문자열 안'으로 삼킨다
  assert.deepStrictEqual(
    await decide('<think>사용자가 "배치 상태를 물었다. 조회하자.</think>\n{"action":"answer","answer":"결과입니다"}'),
    { action: 'answer', answer: '결과입니다' }
  );
});

test('내용이 빈 결정은 결정으로 보지 않는다', async () => {
  // 빈 말풍선이 뜨고 그 빈 턴이 다음 질문의 맥락으로 되돌아오는 것을 막는다
  assert.equal(await decide('{"action":"answer","answer":"   "}'), null);
  assert.equal(await decide('{"action":"run_query","query_name":""}'), null);
});

test('answer 본문에 든 중괄호·따옴표는 경계를 어긋내지 않는다', async () => {
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"쿼리는 {a:1} 형태입니다"}'),
    { action: 'answer', answer: '쿼리는 {a:1} 형태입니다' }
  );
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"그는 \\"안녕\\" 이라 했다 {x}"}'),
    { action: 'answer', answer: '그는 "안녕" 이라 했다 {x}' }
  );
});

test('들여쓴 JSON도 결정으로 읽는다', async () => {
  // 후보를 '{ 뒤 고정 길이 창'으로 판정하면 들여쓰기가 창 밖으로 밀려 후보가 0건이 된다 —
  // 제대로 답한 응답이 통째로 버려지고, temperature=0이라 재시도도 같은 응답을 받아 똑같이 실패한다.
  assert.deepStrictEqual(
    await decide(JSON.stringify({ action: 'answer', answer: '안녕' }, null, 6)),
    { action: 'answer', answer: '안녕' }
  );
  const run = { action: 'run_query', query_name: 'batch_job_status', params: { job_id: 'BATCH001' } };
  assert.deepStrictEqual(await decide(`\`\`\`json\n${JSON.stringify(run, null, 4)}\n\`\`\``), run);
  assert.deepStrictEqual(await decide(JSON.stringify(run, null, 8)), run);
});

test('기존에 되던 형태는 그대로 된다', async () => {
  assert.deepStrictEqual(await decide('{"action":"answer","answer":"안녕"}'), { action: 'answer', answer: '안녕' });
  assert.deepStrictEqual(await decide('```json\n{"action":"answer","answer":"안녕"}\n```'), { action: 'answer', answer: '안녕' });
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"### 결과\\n\\n| a |\\n| --- |\\n| 1 |"}'),
    { action: 'answer', answer: '### 결과\n\n| a |\n| --- |\n| 1 |' }
  );
});

test('결정을 못 읽으면 null을 돌려준다 (사용자 문구는 호출부가 만든다)', async () => {
  // provider가 여기서 '실패했습니다' 답변을 지어내면, 조회를 세 번 성공한 요청도 그 한 줄로 끝난다.
  // 무엇을 안내할지는 실행 이력을 쥔 agent.js가 정한다 (renderAnswer 폴백).
  assert.equal(await decide('죄송합니다. 답변할 수 없습니다.'), null);
});

// LLM_REASONING_EFFORT는 모듈 로드 시점에 읽으므로, 값마다 캐시를 우회해 새로 import한다.
async function sentBody(envValue) {
  if (envValue === undefined) delete process.env.LLM_REASONING_EFFORT;
  else process.env.LLM_REASONING_EFFORT = envValue;
  const mod = await import(`../src/llm-openai.js?effort=${encodeURIComponent(String(envValue))}`);
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"answer","answer":"ok"}' } }] }), text: async () => '' };
  };
  await mod.openaiDecide(CTX);
  delete process.env.LLM_REASONING_EFFORT;
  return body;
}

test('객체가 아닌 params는 빈 params로 읽되 결정은 버리지 않는다', async () => {
  // 결정을 버리면 같은 프롬프트로 재시도해 같은 응답을 받고(temperature=0) 폴백으로 끝난다 — 모델은
  // 무엇이 틀렸는지 듣지 못한다. 빈 params로 실행 경계까지 보내면 '값 없음'과 hint가 다음 프롬프트의
  // 이력에 남아 형식을 고칠 기회가 생기고, 바인드가 없는 쿼리는 그냥 실행된다.
  for (const raw of ['["BATCH001"]', '"job_id=BATCH001"', '7', 'null']) {
    assert.deepStrictEqual(
      await decide(`{"action":"run_query","query_name":"q","params":${raw}}`),
      { action: 'run_query', query_name: 'q', params: {} }, raw);
  }
});

test('LLM_BASE_URL 끝의 슬래시가 요청 경로에 //를 만들지 않는다', async () => {
  const saved = process.env.LLM_BASE_URL;
  process.env.LLM_BASE_URL = 'http://test.invalid/v1/';
  let url;
  globalThis.fetch = async (u) => {
    url = u;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"answer","answer":"ok"}' } }] }), text: async () => '' };
  };
  try {
    await openaiDecide(CTX);
  } finally {
    process.env.LLM_BASE_URL = saved;
  }
  assert.equal(url, 'http://test.invalid/v1/chat/completions');
});

test('reasoning_effort 기본값은 low다', async () => {
  // 매 스텝 결정 JSON 하나만 받는 구조라 추론을 길게 돌릴수록 왕복만 길어진다 (실측 5.4초 → 1.9초)
  assert.equal((await sentBody(undefined)).reasoning_effort, 'low');
  assert.equal((await sentBody('')).reasoning_effort, 'low');
});

test('reasoning_effort를 설정으로 바꿀 수 있다', async () => {
  assert.equal((await sentBody('high')).reasoning_effort, 'high');
  assert.equal((await sentBody(' MEDIUM ')).reasoning_effort, 'medium'); // 공백·대소문자 허용
});

test('off면 파라미터를 아예 보내지 않는다', async () => {
  // 이 필드를 모르는 OpenAI 호환 서버에서 400이 나지 않게 하는 탈출구
  assert.ok(!('reasoning_effort' in (await sentBody('off'))));
});

test('알 수 없는 값은 기본값으로 되돌린다', async () => {
  assert.equal((await sentBody('아주높게')).reasoning_effort, 'low');
});

test('forceAnswer일 때는 run_query를 결정으로 받지 않는다', async () => {
  assert.equal(await decide('{"action":"run_query","query_name":"a","params":{}}', { ...CTX, forceAnswer: true }), null);
});

// ===== LaTeX 수식이 JSON 문자열을 건너오는 길 =====
// answer·params는 JSON 문자열 필드인데 LaTeX는 백슬래시투성이다. 모델이 백슬래시를 한 번만 쓰면
// 두 가지로 깨지고 둘 다 오류처럼 보이지 않는다:
//   - JSON에 없는 이스케이프(\[, \alpha) → JSON.parse가 던져 후보가 0건이 되고
//     "LLM 호출에 실패했습니다"가 나간다. 모델은 제대로 답했는데 답이 사라진다.
//   - JSON에 있는 이스케이프(\f, \t)     → 파싱이 '성공'하면서 명령이 제어문자 한 글자로 바뀐다
//     (\frac → 폼피드+rac, \times → 탭+imes). 오류가 없어 로그에도 남지 않는다.
// 테스트 문자열에 백슬래시를 직접 적지 않는다 — JS 리터럴에서 한 번, JSON에서 또 한 번 먹혀
// '무엇을 검증하는지'가 보이지 않게 된다. B로 한 개를 명시적으로 만든다.
const B = String.fromCharCode(92);
const answerOf = async content => (await decide(content))?.answer ?? null;

test('JSON에 없는 이스케이프가 답변을 통째로 버리지 않는다', async () => {
  assert.equal(
    await answerOf(`{"action":"answer","answer":"${B}[ x^2 ${B}] 와 $${B}alpha$"}`),
    `${B}[ x^2 ${B}] 와 $${B}alpha$`
  );
});

test('JSON에 있는 이스케이프와 겹치는 명령이 제어문자로 뭉개지지 않는다', async () => {
  // 파싱이 '성공'하는 쪽이라 오류도 로그도 없다 — 화면에만 'rac'·'imes'가 남는다.
  // \t로 시작하는 명령(\times \text \theta \tau \to)은 LaTeX에서 가장 흔한 축에 든다.
  for (const cmd of ['frac{1}{2}', 'beta', 'times', 'text{합계}', 'theta', 'rho', 'right)', 'nabla', 'neq']) {
    assert.equal(await answerOf(`{"action":"answer","answer":"$$${B}${cmd}$$"}`), `$$${B}${cmd}$$`, cmd);
  }
});

test('제대로 이스케이프한 수식은 해석이 바뀌지 않는다', async () => {
  // 수리는 '어차피 유효한 JSON이 아닌' 자리만 건드려야 한다.
  assert.equal(await answerOf(`{"action":"answer","answer":"$x=${B}${B}frac{1}{2}$"}`), `$x=${B}frac{1}{2}$`);
});

test('답변의 진짜 줄바꿈·탭은 복원 대상이 아니다', async () => {
  // 명령 이름이 될 수 없는 자리(뒤가 영문자가 아니다)의 제어문자는 그대로 둔다.
  // 여기를 되돌리면 멀쩡한 답변의 줄바꿈이 전부 깨져 markdown이 통째로 무너진다.
  assert.equal(await answerOf(`{"action":"answer","answer":"### 제목${B}n${B}n본문${B}n- 항목"}`), '### 제목\n\n본문\n- 항목');
  assert.equal(await answerOf(`{"action":"answer","answer":"a${B}t| b"}`), 'a\t| b');
  // 줄바꿈 뒤에 글자가 이어져도 그것이 명령 이름이 아니면 줄바꿈이다 (\nabla와 갈리는 지점)
  assert.equal(await answerOf(`{"action":"answer","answer":"1줄${B}nx = 2"}`), '1줄\nx = 2');
});

test('문자열 안에 그대로 온 제어문자가 답변을 통째로 버리지 않는다', async () => {
  // JSON에서 무효라 파싱이 실패하는 자리다. 뜻은 분명하므로(줄바꿈은 줄바꿈이다) 살려서 읽는다 —
  // 모델이 answer 안에서 진짜로 줄을 바꾸는 일은 드물지 않은데, 그 한 번이 '답변 소실'이 된다.
  assert.equal(await answerOf('{"action":"answer","answer":"1줄\n2줄"}'), '1줄\n2줄');
  assert.equal(await answerOf('{"action":"answer","answer":"a\tb"}'), 'a\tb');
});

test('params 값의 백슬래시도 같은 규칙으로 읽는다', async () => {
  // 답변만의 문제가 아니다. 무효한 이스케이프면 결정 전체가 사라지고(C:\Users),
  // 유효한 이스케이프면 값이 조용히 제어문자로 바뀐 채 그대로 DB 조회에 바인드된다(C:\backup,
  // C:\temp) — 오류 없이 엉뚱한 결과가 나오고, 그 결과가 최종 답변의 근거가 된다.
  for (const path of ['C:' + B + 'Users', 'C:' + B + 'backup', 'C:' + B + 'temp', 'C:' + B + 'files']) {
    assert.deepStrictEqual(
      await decide(`{"action":"run_query","query_name":"q","params":{"p":"${path}"}}`),
      { action: 'run_query', query_name: 'q', params: { p: path } }, path
    );
  }
});

test('이스케이프 정규화가 사고 과정 판정을 흔들지 않는다', async () => {
  // 정규화는 파싱되는 후보를 늘리고, 후보 span 안의 태그는 '본문의 글자'로 마스킹된다(ⓐ).
  // 두 규칙이 겹치는 자리에서 진짜 결정을 잃지 않는지 — 어느 한쪽만 보는 테스트로는 드러나지 않는다.
  assert.deepStrictEqual(
    await decide(`<think>초안 {"action":"run_query","query_name":"x","params":{"p":"${B}alpha"}} 은 접자</think>{"action":"answer","answer":"$$a ${B}times b$$"}`),
    { action: 'answer', answer: `$$a ${B}times b$$` }
  );
  // 답변 본문이 태그를 '설명'하는 경우도 그대로다 — 그 태그는 문자열 안이라 태그가 아니다
  assert.equal(
    await answerOf(`{"action":"answer","answer":"${B}times 는 곱셈이고 </think> 는 사고 태그다"}`),
    `${B}times 는 곱셈이고 </think> 는 사고 태그다`
  );
});

test('복구 전에 빈 답변으로 오판하지 않는다', async () => {
  // \f는 파싱되면 폼피드가 되고 그 문자는 trim()이 공백으로 센다. '빈 답변인가'를 복구 전에
  // 재면, 원래 LaTeX 명령이던 자리가 공백으로 계산돼 답변이 통째로 버려진다.
  // 판정은 반드시 정규화를 마친 값으로 해야 한다 (퍼징으로 잡은 회귀).
  assert.equal(await answerOf(`{"action":"answer","answer":"${B}f"}`), `${B}f`);
});

test('긴 응답에서도 이스케이프 정규화가 선형으로 끝난다', async () => {
  // 정규화는 후보마다 원문을 한 번 훑는다. 그 안에서 남은 문자열을 잘라내는 순간
  // '이스케이프 수 × 응답 길이'가 되어, 수식이 많은 긴 답변 하나가 이벤트 루프를 붙잡는다
  // (동기 작업이라 그 요청만이 아니라 동시에 처리 중인 모든 요청이 함께 멈춘다).
  const answer = `$$${B}nabla f + a ${B}times b${B}n${B}n`.repeat(20000); // 약 1MB
  const t0 = performance.now();
  const d = await decide(`{"action":"answer","answer":"${answer}"}`);
  assert.ok(performance.now() - t0 < 2000);
  assert.ok(d.answer.includes(`${B}nabla`) && d.answer.includes(`${B}times`));
});

test('값이 백슬래시로 끝나는 답변이 통째로 버려지지 않는다', async () => {
  // 모델은 백슬래시를 한 번만 쓴다 — 이 파일이 normalizeJsonEscapes를 두는 바로 그 이유다.
  // 값이 백슬래시로 끝나면 닫는 따옴표가 '\"'가 되어, 엄격하게 읽으면 문자열이 영영 닫히지
  // 않고 후보의 끝을 못 찾는다(-1). 그러면 정규화가 실행될 기회조차 없이 결정이 버려지고,
  // temperature=0이라 재시도도 같은 텍스트를 받아 똑같이 실패한다 —
  // 오류 하나 없이 모델의 진짜 답변이 사라지는, 이 파일이 가장 나쁘게 보는 형태다.
  // 모델이 보낸 원문: {"action":"answer","answer":"경로는 C:\"}
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"경로는 C:\\"}'),
    { action: 'answer', answer: '경로는 C:\\' }
  );
  // 바인드 값에서도 같다 — 여기서 버려지면 그 조회가 통째로 사라진다.
  // 원문: {"action":"run_query",…,"params":{"path":"\\share\"}}  (앞의 \\는 정상 이스케이프)
  assert.deepStrictEqual(
    await decide('{"action":"run_query","query_name":"q","params":{"path":"\\\\share\\"}}'),
    { action: 'run_query', query_name: 'q', params: { path: '\\share\\' } }
  );
});

test('정상적으로 이스케이프된 따옴표를 두 번째 읽기가 망치지 않는다', async () => {
  // 엄격한 읽기가 먼저이고, 그 읽기로 후보가 닫히면 두 번째 읽기는 돌지 않는다.
  // 순서가 뒤바뀌면 답변 속 인용부호가 문자열을 조기에 닫아 본문이 잘린 채 나간다.
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"그는 \\"안녕\\"이라 했다"}'),
    { action: 'answer', answer: '그는 "안녕"이라 했다' }
  );
  // 이스케이프된 따옴표 뒤에 '}'가 오는 경우 — 두 번째 읽기라면 여기서 객체가 닫힌 것으로 본다
  assert.deepStrictEqual(
    await decide('{"action":"answer","answer":"닫는 괄호는 \\"}\\" 입니다"}'),
    { action: 'answer', answer: '닫는 괄호는 "}" 입니다' }
  );
});

test('닫히지 않은 후보가 반복돼도 두 번째 읽기가 총 비용을 늘리지 않는다', async () => {
  // 두 번째 읽기는 '\"'를 실제로 본 후보에만 돌지만, 그 조건만으로는 부족하다 —
  // '{"a\"' 가 반복되면 조건이 매번 참이 되어 후보마다 두 번씩 훑는다(실측 2.4배).
  // 그래서 예산(MAX_UNMATCHED_TOTAL)이 후보 수가 아니라 '훑은 횟수'를 센다.
  // 이 스캔은 동기 작업이라 그 요청만이 아니라 동시에 처리 중인 모든 요청이 함께 멈춘다.
  const plain = '</think>{"a'.repeat(6_000);
  const withEscapedQuote = '</think>{"a\\"'.repeat(6_000);   // 두 번째 읽기를 매번 유발한다

  const ms = async text => { const t0 = Date.now(); assert.equal(await decide(text), null); return Date.now() - t0; };
  await ms(plain);                                    // 워밍업 (JIT 편차 제거)
  const basePerKb = (await ms(plain)) / (plain.length / 1024);
  const escPerKb = (await ms(withEscapedQuote)) / (withEscapedQuote.length / 1024);

  // 길이당 비용이 같은 수준이어야 한다 — 예산이 스캔 횟수를 세지 않으면 여기서 2배가 된다.
  assert.ok(escPerKb < basePerKb * 1.6,
    `'\\"'가 섞인 입력의 길이당 비용이 크게 늘었다: ${escPerKb.toFixed(2)}ms/KB vs ${basePerKb.toFixed(2)}ms/KB`);
});

// ===== 요청 본문 — 시스템 프롬프트 =====

// 실제로 보낸 요청 본문을 잡는다 (응답은 아무 결정이나)
async function capturedRequest(ctx = CTX) {
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"answer","answer":"a"}' } }] }), text: async () => '' };
  };
  await openaiDecide(ctx);
  return body;
}

test('시스템 프롬프트에는 요청마다 달라지는 것이 없다', async () => {
  // vLLM prefix caching은 앞에서부터 같은 토큰열만 재사용한다 — 시스템 프롬프트에 시각 같은 값이
  // 섞이면 모든 요청·모든 스텝이 첫 토큰부터 다시 계산한다. 현재 시각은 사용자 프롬프트 끝에 싣는다.
  const a = await capturedRequest();
  const b = await capturedRequest({ ...CTX, question: '다른 질문', history: [{ query_name: 'q', params: {}, rows: [{ A: 1 }], totalRows: 1 }] });
  assert.equal(a.messages[0].role, 'system');
  assert.equal(a.messages[0].content, b.messages[0].content, '시스템 프롬프트가 요청에 따라 달라졌다');
  assert.doesNotMatch(a.messages[0].content, /현재 시각:|\d{4}-\d{2}-\d{2}/, '시스템 프롬프트에 시각이 들어갔다');
  assert.match(a.messages[1].content, /현재 시각: \d{4}-\d{2}-\d{2} /, '현재 시각은 사용자 프롬프트에 있어야 한다');
});

test('시스템 프롬프트가 프롬프트 표기와 같은 규칙을 말한다', async () => {
  // 규칙은 한 곳(코드)에서 나와야 한다: 잘린 값의 표시는 constants.TRUNC_MARK 그대로여야 모델이
  // 이력에서 그 표시를 알아보고, 바인드 키는 프롬프트가 ':이름'으로 보여주므로 '콜론 없이'를 말해야
  // 하며, 수식 표기는 frontend/src/math.js가 받는 네 가지와 같아야 한다 (README '대화 맥락' 참고 —
  // 한쪽만 바꾸면 모델이 쓴 수식이 화면에서 그대로 글자로 보인다).
  const sys = (await capturedRequest()).messages[0].content;
  assert.ok(sys.includes(`${TRUNC_MARK} 으로 끝나는 값`), '잘린 값 표시가 상수와 어긋난다');
  assert.match(sys, /콜론 없이/);
  for (const notation of ['$E=mc^2$', '$$E=mc^2$$', '\\( \\)', '\\[ \\]']) {
    assert.ok(sys.includes(notation), `수식 표기 안내가 빠졌다: ${notation}`);
  }
  // 백슬래시 두 번 예시는 모델이 그대로 따라 쓰는 문자열이다 — JSON 문자열 안에서 \\frac 이 되어야 한다
  assert.ok(sys.includes('"$$x=\\\\frac{1}{2}$$"'), '이스케이프 예시가 두 번 쓴 백슬래시가 아니다');
});

test('요청에 출력 폭주 가드(max_tokens)를 싣는다', async () => {
  // 보내지 않으면 vLLM은 남은 컨텍스트 전부(≈100k 토큰)를 상한으로 잡는다 — temperature=0의 반복 퇴화가
  // 클라이언트 타임아웃까지 서버를 붙들고, 유료 API면 그 토큰이 과금된다. 답변 길이 상한은 아니다
  // (그건 파싱 뒤 MAX_ANSWER_LEN) — 정당한 결정보다 훨씬 위여야 한다.
  const body = await capturedRequest();
  assert.equal(body.max_tokens, MAX_COMPLETION_TOKENS);
  assert.ok(Number.isInteger(MAX_COMPLETION_TOKENS) && MAX_COMPLETION_TOKENS >= 8_000, '가드가 정당한 답변(수 k 토큰)을 자를 만큼 낮다');
});

// 로그를 잡아 본다 — 두 로그의 존재 이유가 '로그로 드러나는 것'이라 로그를 검증한다.
async function decideCapturingLogs(response) {
  const logs = [], warns = [];
  const [origLog, origWarn] = [console.log, console.warn];
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => response, text: async () => '' });
    const decision = await openaiDecide(CTX);
    return { decision, logs, warns };
  } finally {
    [console.log, console.warn] = [origLog, origWarn];
  }
}

test('상한에서 끊긴 응답은 원인이 길이였음을 로그로 남긴다', async () => {
  // 잘린 JSON은 파싱에 실패하고, 그 실패는 '모델이 형식을 안 지켰다'로 보인다 — 폭주였는지
  // 정당하게 긴 답변이었는지(가드를 올려야 하는지)는 finish_reason 로그로만 가를 수 있다.
  const { decision, warns } = await decideCapturingLogs({
    choices: [{ finish_reason: 'length', message: { content: '{"action":"answer","answer":"긴 답변의 앞부' } }],
  });
  assert.equal(decision, null);
  const cut = warns.filter(l => l.includes(`max_tokens=${MAX_COMPLETION_TOKENS}`));
  assert.ok(cut.length >= 1, `길이에서 끊겼다는 경고가 없다: ${JSON.stringify(warns)}`);
});

test('서버가 알려준 토큰 실측을 로그로 남긴다', async () => {
  // 프롬프트 예산(constants.js)은 문자 기준 추정이다 — 예산을 다시 잡을 실측은 이 로그로만 쌓인다.
  const { logs } = await decideCapturingLogs({
    usage: { prompt_tokens: 1234, completion_tokens: 56 },
    choices: [{ finish_reason: 'stop', message: { content: '{"action":"answer","answer":"a"}' } }],
  });
  assert.ok(logs.some(l => l.includes('usage prompt=1234 completion=56 finish=stop')), JSON.stringify(logs));
  // usage를 주지 않는 서버에서는 '?'만 남는 줄을 찍지 않는다
  const { logs: none } = await decideCapturingLogs({ choices: [{ message: { content: '{"action":"answer","answer":"a"}' } }] });
  assert.ok(!none.some(l => l.includes('usage')), '실측이 없는데 usage 줄을 남겼다');
});

test('answer 안의 차트·mermaid 코드블록이 파싱을 그대로 통과한다', async () => {
  // 차트 블록은 따옴표 없는 '이름: 값' 줄과 GFM 표로만 이뤄져 JSON 문자열 안에서 이스케이프할 것이 없다 —
  // 그 성질이 깨지면(예: 블록 문법에 따옴표가 들어가면) 답변 전체가 파싱에서 떨어진다.
  const md = '### 월별\n\n```chart\ntype: bar\ntitle: 월별 처리\nx: 월\ny: 건수\n| 월 | 건수 |\n|---|---|\n| 2024-01 | 120 |\n```\n\n```chart\ntype: line\ndata: step 2\n```\n\n```mermaid\nflowchart TD\n  A[시작] --> B[끝]\n```';
  const d = await decide(JSON.stringify({ action: 'answer', answer: md }));
  assert.deepStrictEqual(d, { action: 'answer', answer: md });
});
