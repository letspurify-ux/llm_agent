// OpenAI 호환 API 클라이언트 — vLLM / OpenRouter 공용.
// 환경변수만 설정하면 동작한다:
//   LLM_BASE_URL  예) vLLM: http://localhost:8000/v1 / OpenRouter: https://openrouter.ai/api/v1
//   LLM_API_KEY   vLLM은 보통 빈 값(헤더 생략), OpenRouter는 필수
//   LLM_MODEL     예) Qwen/Qwen2.5-32B-Instruct, anthropic/claude-sonnet-4.5
//   LLM_REASONING_EFFORT  low(기본) | medium | high | off
// SDK 없이 Node 내장 fetch 사용.
import {
  MAX_ROWS, TRUNC_MARK,
  MAX_PROMPT_ITEM_LEN, MAX_PROMPT_SQL_LEN, MAX_PROMPT_STEP_LEN,
  MAX_PROMPT_TOTAL_LEN, PROMPT_FLOORS,
  clipText,
} from './constants.js';
import { bindNames } from './sql.js';
import { rowCounts } from './result.js';

// 추론 강도. 기본을 low로 두는 이유: 이 에이전트가 모델에게 요구하는 건 매 스텝 결정 JSON 하나이고,
// 판단 근거(지식·처리방법·실행 이력)는 프롬프트에 이미 다 들어가 있다. 길게 생각할수록
// 정확해지는 문제가 아니라 왕복만 길어지는데, 그 왕복이 스텝 수만큼 곱해진다.
// 'off'는 파라미터 자체를 빼고 보낸다 — 이 필드를 모르는 OpenAI 호환 서버 대비.
const REASONING_EFFORTS = ['low', 'medium', 'high'];
const REASONING_EFFORT = resolveReasoningEffort();

function resolveReasoningEffort() {
  const raw = String(process.env.LLM_REASONING_EFFORT ?? '').trim().toLowerCase();
  if (!raw) return 'low';
  if (raw === 'off') return null;
  if (REASONING_EFFORTS.includes(raw)) return raw;
  console.warn(
    `[llm] LLM_REASONING_EFFORT 값이 올바르지 않아 기본값(low)을 사용합니다: ` +
    `${JSON.stringify(process.env.LLM_REASONING_EFFORT)} (가능: ${REASONING_EFFORTS.join(', ')}, off)`
  );
  return 'low';
}

// 서버가 이 파라미터를 거부하면 프로세스 수명 동안 다시 보내지 않는다 —
// 지원하지 않는 엔드포인트에서 모든 질문이 실패하는 것보다, 한 번 배우고 빼는 편이 낫다.
let effortAccepted = REASONING_EFFORT !== null;

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

// HTTP 오류·타임아웃·파싱 실패 모두 1회 재시도하고, 그래도 결정을 얻지 못하면 null을 돌려준다.
//
// 여기서 사용자용 문구를 만들지 않는 것이 중요하다: 무엇을 안내할지는 이 요청이 지금까지 무엇을
// 해냈는지를 아는 쪽만 정할 수 있다. 조회를 세 번 성공해놓고 'LLM 호출에 실패했습니다' 한 줄만
// 내보내면 그 성과가 통째로 사라지는데, provider는 실행 이력을 해석할 위치가 아니다.
// agent.js가 null을 받아 손에 든 결과로 답을 만들고(renderAnswer), 그것마저 없을 때만 실패를 알린다.
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
  // 상세 오류는 위 warn 로그에만 남긴다 — 사용자용 문구는 호출부가 만든다 (위 주석 참고).
  return null;
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
      ...(effortAccepted && { reasoning_effort: REASONING_EFFORT }),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    // 이 파라미터를 모르는 서버는 400으로 거절한다. 한 번 겪으면 빼고 가도록 표시해두면
    // 바로 이어지는 재시도가 성공한다 (설정 하나 때문에 모든 질문이 실패하지 않게).
    if (res.status === 400 && effortAccepted && /reasoning/i.test(detail)) {
      effortAccepted = false;
      console.warn('[llm] 이 엔드포인트가 reasoning_effort를 지원하지 않아 이후 요청에서 제외합니다.');
    }
    throw new Error(`LLM API ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// 검색 결과 본문(knowledge.content / qa_method.method / query_sql)은 전부 TEXT라 그 자체로는 상한이 없다.
// 항목 하나가 컨텍스트를 통째로 잡아먹지 않게 항목별로 자르고, 항목 수가 많을 때를 대비해
// 섹션 합계에도 예산을 둔다. 자른 사실은 모델에게도 보이게 남긴다(TRUNC_MARK) —
// 잘린 줄 모르면 끊긴 문장을 근거로 단정한다.
const clip = (v, max = MAX_PROMPT_ITEM_LEN) => {
  const s = String(v ?? '');
  return s.length > max ? clipText(s, max) + TRUNC_MARK : s;
};

// 검색 결과는 관련도 순으로 정렬돼 있으므로 예산을 넘기면 뒤(덜 관련된 것)부터 버린다.
// 최소 1건은 반드시 싣는다 — 항목별 clip이 이미 1건의 크기를 묶어두었으므로 그래도 예산을 크게 벗어나지 않는다.
// 몇 건을 버렸는지 모델에게 알린다: '이게 전부'라고 읽으면 없는 것을 없다고 단정한다.
function renderItems(items, render, budget) {
  const lines = [];
  let used = 0;
  for (const item of items) {
    const line = render(item);
    if (lines.length > 0 && used + line.length > budget) break;
    lines.push(line);
    used += line.length;
  }
  if (lines.length < items.length) {
    lines.push(`- (이하 ${items.length - lines.length}건은 프롬프트 길이 제한으로 생략)`);
  }
  return lines;
}

// 바인드 변수명을 SQL과 따로 싣는다 — SQL이 길어 잘리더라도 채워야 할 파라미터가 사라지지 않게.
// 사라지면 모델이 params를 비우고, runQuery가 '바인드 변수를 쓸 수 없습니다'로 실패한다.
const queryItem = q =>
  `- ${q.query_name}: ${clip(q.query_desc)}` +
  ` / 입력(${clip(q.input_desc, 300)}) / 출력(${clip(q.output_desc, 300)})` +
  ` / 바인드(${bindNames(q.query_sql).map(n => `:${n}`).join(', ') || '없음'})` +
  ` / SQL: ${clip(q.query_sql, MAX_PROMPT_SQL_LEN)}`;

// 예산 안에 들어가는 가장 긴 앞부분을 돌려준다. 행 단위로 줄이는 이유: JSON 문자열을 중간에서
// 자르면 모델이 파싱할 수 없는 조각이 남고, 그 조각을 값으로 읽어 바인드로 되돌린다.
// 최소 1건은 남긴다 — 0건이면 모델이 '결과가 없다'로 읽고, 1건의 크기는 셀 상한(MAX_CELL_LEN)이 이미 묶었다.
function fitRows(rows, budget) {
  let used = 2; // '[]'
  for (let i = 0; i < rows.length; i++) {
    used += JSON.stringify(rows[i]).length + (i ? 1 : 0); // 구분자 ','
    if (i > 0 && used > budget) return rows.slice(0, i);
  }
  return rows;
}

function historyLine(h) {
  if (h.note) {
    // 루프 가드가 남긴 제어용 기록 — 실패가 아니므로 '오류'로 알리지 않는다 (모델이 실패로 오해해 불필요한 우회를 하지 않게)
    return `- ${h.query_name} params=${JSON.stringify(h.params)} → 실행하지 않음: ${h.note}`;
  }
  if (h.error) {
    // 드라이버 오류 원문은 길 수 있다 — 항목 상한을 여기에도 건다.
    return `- ${h.query_name} params=${JSON.stringify(h.params)} → 오류: ${clip(h.error)}`;
  }
  // 건수 해석은 rowCounts 한 곳에서만 한다 (사용자 답변·화면 trace도 같은 해석을 쓴다).
  // 여기서 더 줄이는 것은 '몇 건을 인쇄하는가'뿐이므로 해석이 갈라지지 않는다: printed ≤ shown ≤ totalRows.
  const { rows, totalRows, capped } = rowCounts(h);
  const printedRows = fitRows(rows, MAX_PROMPT_STEP_LEN);
  const printed = printedRows.length;
  const note = capped
    ? ` (조회 상한 ${MAX_ROWS}건 도달 — 실제 총 건수는 더 많을 수 있음, 처음 ${printed}건만 표시)`
    : totalRows > printed ? ` (총 ${totalRows}건 중 처음 ${printed}건만 표시)` : '';
  return `- ${h.query_name} params=${JSON.stringify(h.params)} → 결과 ${totalRows}${capped ? '+' : ''}건${note}: ${JSON.stringify(printedRows)}`;
}

// 실행 이력은 다른 섹션과 반대로 '뒤에서부터' 채운다 — 최신 기록이 가장 중요하기 때문이다.
// 꼬리부터 버리면 방금 조회한 결과가 먼저 사라져 그 스텝이 통째로 헛수고가 되고,
// 모델은 결과를 못 본 채 같은 쿼리를 다시 제안한다(그러면 루프 가드에 걸려 답변만 부실해진다).
// 표시 순서는 시간순으로 되돌린다.
function renderHistory(history, budget) {
  if (!history.length) return ['(없음)'];
  const lines = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const line = historyLine(history[i]);
    if (lines.length > 0 && used + line.length > budget) break;
    lines.push(line);
    used += line.length;
  }
  lines.reverse();
  const omitted = history.length - lines.length;
  if (omitted > 0) lines.unshift(`- (앞선 ${omitted}건은 프롬프트 길이 제한으로 생략)`);
  return lines;
}

// 섹션별 예산 배분 — 전체 상한 하나를 PROMPT_FLOORS 선언 순서대로 나눠준다.
// 각 섹션의 몫 = max(자기 최소 몫, 남은 예산 - 뒤 섹션들의 최소 몫 합).
// 뒤 섹션들의 최소 몫을 미리 떼어놓으므로 앞 섹션이 뒤를 굶기지 못하고, 앞이 짧으면 그 여유가
// 그대로 뒤로 넘어간다 — 그래서 가장 중요한 섹션(쿼리 목록)을 맨 뒤에 두었다(constants.js 참고).
// 이 배분 덕에 어느 섹션이 얼마나 길어지든 합계는 MAX_PROMPT_TOTAL_LEN을 넘지 않는다.
function renderSections(ctx) {
  const builders = {
    knowledge: budget => renderItems(ctx.knowledge, k => `- [${k.title}] ${clip(k.content)}`, budget),
    qaMethods: budget => renderItems(ctx.qaMethods, m => `- [${m.title}] ${clip(m.method)}`, budget),
    history: budget => renderHistory(ctx.history, budget),
    queries: budget => renderItems(ctx.queries, queryItem, budget),
  };
  const keys = Object.keys(PROMPT_FLOORS);
  const out = {};
  let remaining = MAX_PROMPT_TOTAL_LEN;
  keys.forEach((key, i) => {
    const reserved = keys.slice(i + 1).reduce((sum, k) => sum + PROMPT_FLOORS[k], 0);
    const lines = builders[key](Math.max(PROMPT_FLOORS[key], remaining - reserved));
    remaining -= lines.reduce((sum, line) => sum + line.length + 1, 0); // +1 = 개행
    out[key] = lines;
  });
  return out;
}

// (테스트에서 쓰므로 export 한다 — 예산이 어긋나도 티가 나지 않는 종류의 실패라 회귀 테스트가 필요하다)
export function buildPrompt(ctx) {
  // 배분 순서와 출력 순서는 별개다 — 배분은 우선순위대로, 출력은 모델이 읽기 좋은 고정 순서로.
  const s = renderSections(ctx);
  const lines = [];

  // 대화와 질문은 이 예산 밖이다: 각각 MAX_CHAT_TURNS×MAX_CHAT_LEN과 서버의 2,000자 제한으로
  // 이미 묶여 있고, 둘 다 빠지면 질문 자체가 성립하지 않아 버릴 수 있는 대상이 아니다.
  if (ctx.chat?.length) {
    lines.push('## 최근 대화');
    for (const m of ctx.chat) lines.push(`- ${m.role === 'user' ? '사용자' : '에이전트'}: ${m.text}`);
    lines.push('');
  }
  lines.push(`## 사용자 질문 (현재)\n${ctx.question}`);

  lines.push(`\n## 관련 지식 (${ctx.knowledge.length}건)`, ...s.knowledge);
  lines.push(`\n## Q&A 처리 방법 (${ctx.qaMethods.length}건)`, ...s.qaMethods);
  lines.push('\n## 실행 가능한 쿼리 목록', ...s.queries);
  lines.push('\n## 쿼리 실행 이력', ...s.history);

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
//
// 그 판정을 '{ 뒤 8글자'라는 고정 길이 창으로 하면 안 된다: 창 밖으로 밀려난 들여쓰기가 후보를
// 통째로 떨어뜨린다. 모델이 JSON을 6칸 이상 들여쓰면 후보가 0건이 되고, 제대로 답한 응답이
// '결정 JSON을 찾지 못함'으로 버려진다 (temperature=0이라 재시도도 같은 응답을 받아 똑같이 실패한다).
// 전역 정규식으로 한 번에 훑으면 들여쓰기 길이와 무관하고 전체 비용도 선형이다.
// lastIndex를 공유하면 제너레이터가 겹칠 때 서로의 탐색 위치를 밟으므로 호출마다 새로 만든다.
function* jsonObjects(text) {
  const candidate = /\{\s*"/g;
  for (let tried = 0, m; tried < MAX_JSON_CANDIDATES && (m = candidate.exec(text)); tried++) {
    const end = matchingBrace(text, m.index);
    if (end > 0) yield text.slice(m.index, end + 1);
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
