// OpenAI 호환 API 클라이언트 — vLLM / OpenRouter 공용.
// 환경변수만 설정하면 동작한다:
//   LLM_BASE_URL  예) vLLM: http://localhost:8000/v1 / OpenRouter: https://openrouter.ai/api/v1
//   LLM_API_KEY   vLLM은 보통 빈 값(헤더 생략), OpenRouter는 필수
//   LLM_MODEL     예) Qwen/Qwen2.5-32B-Instruct, anthropic/claude-sonnet-4.5
// SDK 없이 Node 내장 fetch 사용.

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

export async function openaiDecide(ctx) {
  const userPrompt = buildPrompt(ctx);
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await chatCompletion(userPrompt);
    const decision = parseDecision(content, ctx.forceAnswer);
    if (decision) return decision;
  }
  return { action: 'answer', answer: 'LLM 응답을 해석하지 못했습니다. 잠시 후 다시 시도해주세요.' };
}

async function chatCompletion(userPrompt) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.LLM_API_KEY) headers.Authorization = `Bearer ${process.env.LLM_API_KEY}`;

  const res = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
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
    if (h.error) {
      lines.push(`- ${h.query_name} params=${JSON.stringify(h.params)} → 오류: ${h.error}`);
    } else {
      const note = h.totalRows > h.rows.length ? ` (총 ${h.totalRows}건 중 처음 ${h.rows.length}건만 표시)` : '';
      lines.push(`- ${h.query_name} params=${JSON.stringify(h.params)} → 결과 ${h.totalRows ?? h.rows.length}건${note}: ${JSON.stringify(h.rows)}`);
    }
  }

  if (ctx.forceAnswer) {
    lines.push('\n## 지시\n더 이상 쿼리를 실행할 수 없다. 지금까지의 정보만으로 action="answer"로 최종 답변하라.');
  }
  return lines.join('\n');
}

// 코드펜스 등으로 감싸진 응답 대비, 첫 '{'부터 마지막 '}'까지를 JSON으로 파싱한다.
function parseDecision(content, forceAnswer) {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let d;
  try {
    d = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (d.action === 'answer' && typeof d.answer === 'string') return d;
  if (!forceAnswer && d.action === 'run_query' && typeof d.query_name === 'string') {
    return { action: 'run_query', query_name: d.query_name, params: d.params || {} };
  }
  return null;
}
