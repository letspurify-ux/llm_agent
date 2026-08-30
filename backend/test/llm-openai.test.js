// LLM 응답 파싱 회귀 테스트 — 실행: npm test
// 이 파싱은 조용히 깨진다: 모델은 제대로 답했는데 결정을 못 읽어 "LLM 호출에 실패했습니다"가 나가고,
// temperature=0이라 재시도도 같은 응답을 받아 똑같이 실패한다. 로그를 봐도 모델 탓처럼 보인다.
import { test } from 'node:test';
import assert from 'node:assert';

process.env.LLM_BASE_URL = 'http://test.invalid/v1';
process.env.LLM_MODEL = 'test';
delete process.env.LLM_API_KEY;

const { openaiDecide } = await import('../src/llm-openai.js');

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
  // 후보 예산을 나누는 '잠정 구간'은 아직 본문 속 태그를 걸러내기 전이라 틀릴 수 있다.
  // 그것으로 후보를 탈락시키면 마스킹이 그 구간을 지워줄 기회 자체가 사라진다 —
  // 결정보다 앞에 놓인 JSON 하나가 문자열에 '<think>'를 담고 있으면(형식 예시 등)
  // 그 뒤 전부가 사고 과정으로 보여 진짜 결정이 후보에도 오르지 못한다.
  // 비용 문제(예산)와 채택 문제(구간)를 한 곳에 섞으면 정확히 이렇게 깨진다.
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

test('구역이 아무리 많아도 후보 탐색 총량이 이차로 늘지 않는다', async () => {
  // 후보 상한을 '구역별로만' 주면 matchingBrace 호출 수가 구역 수 × 구역 예산이 되어 전역 비용
  // 상한이 사라진다. 바로 위 테스트가 이 경로를 놓친 이유는 후보가 전부 '{"d":0}'처럼 짝이 맞아
  // matchingBrace가 즉시 끝나기 때문이다 — 짝 없는 '{"'라야 매번 남은 텍스트를 끝까지 훑는다.
  // 실측(전역 상한 없을 때): 43KB 349ms, 86KB 1,580ms, 172KB 6.3s — 크기 2배마다 4배.
  // 그 시간은 동기 작업이라 동시에 처리 중인 모든 요청이 함께 멈춘다.
  const t0 = Date.now();
  await decide('</think>{"a'.repeat(16_000));   // 약 172KB, 구역 1만 6천 개 · 전부 짝 없는 후보
  assert.ok(Date.now() - t0 < 2000, `파싱이 너무 오래 걸림: ${Date.now() - t0}ms`);
});

test('앞선 사고 과정 구간이 뒤 구간의 후보 예산을 먹지 않는다', async () => {
  // 후보 상한을 '구간 종류'로 묶으면 통이 explicit/assumed 둘뿐이라, 후보가 잔뜩 든 구간 하나가
  // 같은 종류의 '다른' 구간 몫까지 먹는다. 그 구간에 진짜 결정이 있으면 후보로 오르지도 못해
  // 파싱이 통째로 실패한다 (실측: 고치기 전 null → 사용자에게는 'LLM 호출 실패'만 나갔다).
  // 닫는 태그만 오는 형태(②)는 Qwen3·R1 기본 템플릿의 기본값이라 두 번 이어지는 것이 드물지 않다.
  const noisy = Array.from({ length: 150 }, (_, i) => `{"draft":${i}}`).join(' ');
  assert.deepStrictEqual(
    await decide(`${noisy} </think>\n{"action":"answer","answer":"최종"} </think>`),
    { action: 'answer', answer: '최종' }
  );
});

test('장황한 사고 과정이 뒤따르는 진짜 결정의 후보 예산을 먹지 않는다', async () => {
  // 후보 상한(MAX_JSON_CANDIDATES)을 한 통에 세면, 초안이 잔뜩 든 사고 과정 하나가 상한을
  // 다 먹어 그 뒤의 진짜 결정에 닿지 못한다 — 사고 과정을 지워버리던 때는 없던 노출이다.
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
  // 구간은 정렬·비겹침이어야 이분 탐색(rangeAt)이 성립한다. 닫는 태그마다 직전 구간의 끝에서
  // 새로 시작하지 않으면 구간이 겹쳐, 어떤 후보가 어느 구간에 속하는지가 무너진다.
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
