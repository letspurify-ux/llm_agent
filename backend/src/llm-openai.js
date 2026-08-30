// OpenAI 호환 API 클라이언트 — vLLM / OpenRouter 공용.
// 환경변수만 설정하면 동작한다:
//   LLM_BASE_URL  예) vLLM: http://localhost:8000/v1 / OpenRouter: https://openrouter.ai/api/v1
//   LLM_API_KEY   vLLM은 보통 빈 값(헤더 생략), OpenRouter는 필수
//   LLM_MODEL     예) Qwen/Qwen2.5-32B-Instruct, anthropic/claude-sonnet-4.5
// SDK 없이 Node 내장 fetch 사용.
import { MAX_ROWS } from './constants.js';

const SYSTEM_PROMPT = `당신은 사내 지식 관리 및 DB 조회 Q&A 에이전트다.
사용자 질문과 함께 관련 지식, Q&A 처리 방법, 실행 가능한 쿼리 목록, 지금까지의 쿼리 실행 이력이 주어진다.
반드시 아래 두 형식 중 하나의 JSON 객체 하나만으로 응답하라. 다른 텍스트를 붙이지 마라.

1. 답변 전에 DB 조회가 더 필요하면:
{"action":"run_query","query_name":"<쿼리이름>","params":{"<바인드변수명>":"<값>"}}
- query_name은 반드시 쿼리 목록에 있는 이름이어야 한다.
- params에는 해당 쿼리 SQL의 모든 :바인드 변수 값을 채워라. 값은 사용자 질문 또는 실행 이력의 결과에서 추출한다.
- Q&A 처리 방법에 여러 단계가 서술되어 있으면 그 순서대로 하나씩 실행한다.

2. 답변이 가능하면:
{"action":"answer","answer":"<사용자에게 보여줄 최종 답변>"}
- 관련 지식이나 쿼리 실행 결과가 있으면 반드시 그것에 근거해서 답하라.
- 관련 지식·처리 방법·쿼리 결과가 전혀 없으면 너의 일반 지식으로 답하되, 답변 서두에 "*등록된 지식에 없는 내용이라 일반 지식으로 답변합니다.*" 한 줄을 붙여라.
- 일반 지식으로 답할 때도 사내 시스템의 구체적 상태(수치, 상태값, 일정 등)는 절대 지어내지 마라. 확인이 필요하면 확인 방법을 안내하라.
- answer는 markdown 형식으로 구조화하라: 조회 결과는 표(table)로, 항목 나열은 목록으로, 섹션 구분은 ### 제목으로 작성한다.

## 대화 맥락
최근 대화가 함께 주어진다. 현재 질문이 이전 대화를 가리키면(예: "그럼 김철수는?", "재시작은 어떻게 해?") 최근 대화를 참고해
무엇을 묻는지 해석한 뒤 판단하라. 단, 이미 조회한 값이라도 현재 질문의 대상이 다르면 반드시 쿼리를 다시 실행하라.`;

// decide() 한 번이 쓸 수 있는 전체 시간(ms). 재시도도 이 예산을 나눠 쓴다 —
// 시도마다 타이머를 새로 주면 느린 엔드포인트에서 2배가 되고, 그 값이 다시 스텝 수만큼 곱해진다.
const TIMEOUT_MS = 120_000;

// HTTP 오류·타임아웃·파싱 실패 모두 1회 재시도하고, 그래도 실패하면 500 대신
// 오류 안내 답변으로 정상 응답한다 (이미 실행한 쿼리 결과가 버려지지 않도록).
export async function openaiDecide(ctx) {
  const userPrompt = buildPrompt(ctx);
  const deadline = Date.now() + TIMEOUT_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const content = await chatCompletion(userPrompt, remaining);
      const decision = parseDecision(content, ctx.forceAnswer);
      if (decision) return decision;
      // 응답은 받았는데 결정 형식이 아니다 — 재시도한다.
      // temperature=0이라 같은 응답이 올 확률이 높지만, vLLM/OpenRouter의 continuous batching은
      // 실제로 결정론을 보장하지 않는다. 특히 forceAnswer 단계에서 여기 걸리면 이미 조회해둔
      // 결과를 통째로 버리고 실패 문구만 내보내게 되므로, 낮은 확률이라도 복구 시도가 남는 편이 낫다.
      // 헛수고 비용은 위의 공유 deadline이 묶는다 (남은 예산이 없으면 두 번째 시도 자체가 없다).
      // 로그에는 응답 '모양'만 남긴다 — 파싱에 실패하는 응답은 대개 산문이고, 그 산문에는
      // 조회 결과(고객명·주문번호 등 운영 DB 값)가 그대로 들어 있다. 아래 46행이 사용자에게
      // 내부 정보를 숨긴다고 해놓고 로그로 흘리면 숨긴 의미가 없다.
      // 길이·첫 글자·중괄호와 </think> 유무면 "산문인지 / 잘렸는지 / 사고 과정이 샜는지"는 구분된다.
      console.warn(
        `[llm] 결정 JSON을 찾지 못함 (시도 ${attempt + 1}/2): ` +
        `길이=${content.length} 첫글자=${JSON.stringify(content.trim()[0] ?? '')} ` +
        `중괄호=${content.includes('{')} 사고과정태그=${/<\/?think\b/i.test(content)}`
      );
    } catch (e) {
      console.warn(`[llm] 호출 실패 (시도 ${attempt + 1}/2):`, e.message);
    }
  }
  // 상세 오류는 위 warn 로그에만 남긴다 — 사용자에게는 일반화된 메시지 (내부 정보 노출 방지)
  return { action: 'answer', answer: 'LLM 호출에 실패했습니다. 잠시 후 다시 시도해주세요.' };
}

async function chatCompletion(userPrompt, timeoutMs) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.LLM_API_KEY) headers.Authorization = `Bearer ${process.env.LLM_API_KEY}`;

  const res = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function buildPrompt(ctx) {
  const lines = [];

  if (ctx.chat?.length) {
    lines.push('## 최근 대화');
    for (const m of ctx.chat) lines.push(`- ${m.role === 'user' ? '사용자' : '에이전트'}: ${m.text}`);
    lines.push('');
  }
  lines.push(`## 사용자 질문 (현재)\n${ctx.question}`);

  lines.push(`\n## 관련 지식 (${ctx.knowledge.length}건)`);
  for (const k of ctx.knowledge) lines.push(`- [${k.title}] ${k.content}`);

  lines.push(`\n## Q&A 처리 방법 (${ctx.qaMethods.length}건)`);
  for (const m of ctx.qaMethods) lines.push(`- [${m.title}] ${m.method}`);

  lines.push('\n## 실행 가능한 쿼리 목록');
  for (const q of ctx.queries) {
    lines.push(`- ${q.query_name}: ${q.query_desc ?? ''} / 입력(${q.input_desc}) / 출력(${q.output_desc}) / SQL: ${q.query_sql}`);
  }

  lines.push('\n## 쿼리 실행 이력');
  if (!ctx.history.length) lines.push('(없음)');
  for (const h of ctx.history) {
    if (h.note) {
      // 루프 가드가 남긴 제어용 기록 — 실패가 아니므로 '오류'로 알리지 않는다 (모델이 실패로 오해해 불필요한 우회를 하지 않게)
      lines.push(`- ${h.query_name} params=${JSON.stringify(h.params)} → 실행하지 않음: ${h.note}`);
    } else if (h.error) {
      lines.push(`- ${h.query_name} params=${JSON.stringify(h.params)} → 오류: ${h.error}`);
    } else {
      // rows가 없는 기록(오류 메시지가 빈 문자열이라 위 분기를 빠져나온 경우)에도 죽지 않게 한다 —
      // 여기서 던지면 buildPrompt가 try 밖이라 요청 전체가 500이 되고, 이미 조회한 결과까지 버려진다.
      const rows = h.rows ?? [];
      const totalRows = h.totalRows ?? rows.length;
      const note = h.capped
        ? ` (조회 상한 ${MAX_ROWS}건 도달 — 실제 총 건수는 더 많을 수 있음, 처음 ${rows.length}건만 표시)`
        : totalRows > rows.length ? ` (총 ${totalRows}건 중 처음 ${rows.length}건만 표시)` : '';
      lines.push(`- ${h.query_name} params=${JSON.stringify(h.params)} → 결과 ${totalRows}${h.capped ? '+' : ''}건${note}: ${JSON.stringify(rows)}`);
    }
  }

  if (ctx.forceAnswer) {
    lines.push('\n## 지시\n더 이상 쿼리를 실행할 수 없다. 지금까지의 정보만으로 action="answer"로 최종 답변하라.');
  }
  return lines.join('\n');
}

// 응답 텍스트에서 최상위 {…} 덩어리를 순서대로 뽑는다.
// "첫 '{'부터 마지막 '}'까지"로 자르면 JSON 바깥에 중괄호가 하나만 있어도 슬라이스가 JSON이 아니게 된다
// (추론 모델의 <think> 블록, JSON 뒤에 붙는 설명문, 계획+결정 두 덩어리 — 전부 실제로 나오는 형태다).
// 그러면 정상 응답이 파싱 실패로 버려지고, temperature=0이라 재시도도 같은 응답을 받아 똑같이 실패한다.
// 추론 모델의 사고 과정 블록을 먼저 걷어낸다. 그 안에는 "일단 {…}로 해볼까, 아니다" 식의
// 초안 JSON이 들어 있는 일이 있어, 남겨두면 초안이 최종 결정보다 먼저 잡힌다.
// 세 가지 형태를 모두 다룬다:
//   ① <think>…</think>  짝이 맞는 경우
//   ② …</think>         Qwen3·R1 계열의 기본 채팅 템플릿은 <think>를 프롬프트에 미리 붙이므로
//                       content에는 닫는 태그만 온다 — 이 형태가 오히려 더 흔하다
//   ③ <think>…(끝)      토큰 한도로 잘려 닫히지 않은 경우
const stripReasoning = text => text
  .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, ' ')
  .replace(/^[\s\S]*?<\/think>/i, ' ')
  .replace(/<think\b[^>]*>[\s\S]*$/i, ' ');

// text[start]가 '{'일 때 짝이 되는 '}'의 인덱스 (없으면 -1).
// 문자열 리터럴 안의 중괄호·따옴표는 세지 않는다 — answer 본문에 '{'가 들어갈 수 있다.
function matchingBrace(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

// 후보 시작점 상한. 시작점마다 최악 끝까지 훑으므로 상한이 없으면 시작점 수 × 길이가 된다 —
// 토큰 한도에서 잘려 짝 없는 '{'가 수만 개 남은 응답 하나가 이벤트 루프를 수 초간 잡아,
// 그 요청만이 아니라 동시에 처리 중인 모든 요청이 멈춘다.
// 진짜 결정 앞에 이만큼의 '{"' 가 놓인 응답이라면 어차피 신뢰할 수 없다.
const MAX_JSON_CANDIDATES = 100;

// '{'마다 독립적으로 짝을 찾는다. 한 번의 스캔으로 깊이를 누적하면 산문에 섞인 짝 없는 '{' 하나가
// ("params에 {job_id 값을 넣자") 깊이를 영구히 어긋내 뒤의 진짜 JSON을 통째로 놓친다.
// 시작점마다 따로 훑으면 그런 시작점은 그냥 실패하고 다음 후보로 넘어간다.
// 후보는 '{' 다음이 (공백을 건너뛰어) '"'인 것만 본다 — 우리가 찾는 결정 객체는 반드시 키로 시작하므로,
// 산문 속 '{job_id'나 '{중괄호}'는 애초에 후보가 아니다. 정확도와 비용을 함께 줄인다.
function* jsonObjects(text) {
  let tried = 0;
  for (let i = 0; i < text.length && tried < MAX_JSON_CANDIDATES; i++) {
    if (text[i] !== '{' || !/^\{\s*"/.test(text.slice(i, i + 8))) continue;
    tried++;
    const end = matchingBrace(text, i);
    if (end > 0) yield text.slice(i, end + 1);
  }
}

// 후보 중 '처음' 유효한 결정을 채택한다.
// 모델이 결정을 먼저 내고 뒤에 설명이나 예시를 붙이는 쪽이 훨씬 흔하다 —
// 마지막을 고르면 '예시 형식: {"action":"answer","answer":"..."}' 한 줄이 진짜 결정을 덮어써서
// 실행돼야 할 쿼리가 실행되지 않고 사용자에게 예시 문자열이 답변으로 나간다 (오류 흔적도 남지 않는다).
// 반대 방향(사고 과정 속 초안이 먼저 잡히는 것)은 위 stripReasoning이 막는다.
function parseDecision(content, forceAnswer) {
  for (const raw of jsonObjects(stripReasoning(content))) {
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      continue; // JSON이 아닌 중괄호 덩어리 — 다음 후보로
    }
    // 빈 answer는 결정으로 보지 않는다 — 화면에 빈 말풍선이 뜨고, 그 빈 턴이 다음 질문의 맥락으로
    // 서버에 되돌아온다. 형식만 맞고 내용이 없는 응답은 실패로 처리하는 편이 낫다.
    if (d.action === 'answer' && typeof d.answer === 'string' && d.answer.trim()) return d;
    if (!forceAnswer && d.action === 'run_query' && typeof d.query_name === 'string' && d.query_name.trim()) {
      return { action: 'run_query', query_name: d.query_name, params: d.params || {} };
    }
  }
  return null;
}
