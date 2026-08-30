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
  assert.match(
    (await decide('<think>{"action":"answer","answer":"초안"} 으로 할까')).answer,
    /LLM 호출에 실패/
  );
  // Qwen3·R1 계열 기본 템플릿은 <think>를 프롬프트에 미리 붙이므로 content에는 닫는 태그만 온다.
  // 여는 태그만 찾으면 이 형태에서 사고 과정이 통째로 살아남아 초안이 결정으로 잡힌다.
  assert.deepStrictEqual(
    await decide('이미 이력에 있으니 {"action":"run_query","query_name":"find_customer_id","params":{"customer_name":"홍길동"}} 로 해볼까. 아니다.</think>\n{"action":"answer","answer":"최근 주문은 O-777입니다"}'),
    { action: 'answer', answer: '최근 주문은 O-777입니다' }
  );
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
  assert.match((await decide('{"action":"answer","answer":"   "}')).answer, /LLM 호출에 실패/);
  assert.match((await decide('{"action":"run_query","query_name":""}')).answer, /LLM 호출에 실패/);
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

test('결정을 못 읽으면 500 대신 안내 답변으로 정상 응답한다', async () => {
  const r = await decide('죄송합니다. 답변할 수 없습니다.');
  assert.equal(r.action, 'answer');
  assert.match(r.answer, /LLM 호출에 실패/);
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
  const r = await decide('{"action":"run_query","query_name":"a","params":{}}', { ...CTX, forceAnswer: true });
  assert.equal(r.action, 'answer');
});
