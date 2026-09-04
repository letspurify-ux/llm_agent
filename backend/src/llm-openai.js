// OpenAI 호환 API 클라이언트 — vLLM / OpenRouter 공용.
// 환경변수만 설정하면 동작한다:
//   LLM_BASE_URL  예) vLLM: http://localhost:8000/v1 / OpenRouter: https://openrouter.ai/api/v1
//   LLM_API_KEY   vLLM은 보통 빈 값(헤더 생략), OpenRouter는 필수
//   LLM_MODEL     예) Qwen/Qwen2.5-32B-Instruct, anthropic/claude-sonnet-4.5
//   LLM_REASONING_EFFORT  low(기본) | medium | high | off
// SDK 없이 Node 내장 fetch 사용.
import {
  MAX_ROWS, MAX_CELL_LEN, TRUNC_MARK,
  MAX_PROMPT_ITEM_LEN, MAX_PROMPT_SQL_LEN, MAX_PROMPT_STEP_LEN,
  MAX_PROMPT_PARAMS_LEN, MAX_PROMPT_TOTAL_LEN, PROMPT_FLOORS, PROMPT_FRAME_RESERVE,
  MAX_BIND_NAME_LEN, MAX_TARGET_DB_NAME_LEN, MAX_COMPLETION_TOKENS, MAX_STEPS, MAX_SEARCHES, MAX_HISTORY_ROWS, MAX_BATCH_QUERIES, MAX_RESULT_ROWS,
  MAX_EXPANDS, MAX_DOC_LEN, ITEM_PREFIX,
  SEARCH_TARGETS, clipText, warnOnce, targetDbNames, isPlainObject, joinUrl,
  readCapped, MAX_UPSTREAM_JSON_BYTES, MAX_UPSTREAM_ERROR_BYTES, numEnv,
} from './constants.js';
import { bindNames } from './sql.js';
import { canGrow } from './chunk.js';
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
    `[llm] invalid LLM_REASONING_EFFORT value, falling back to default (low): ` +
    `${JSON.stringify(process.env.LLM_REASONING_EFFORT)} (valid: ${REASONING_EFFORTS.join(', ')}, off)`
  );
  return 'low';
}

// 서버가 이 파라미터를 거부하면 프로세스 수명 동안 다시 보내지 않는다 —
// 지원하지 않는 엔드포인트에서 모든 질문이 실패하는 것보다, 한 번 배우고 빼는 편이 낫다.
let effortAccepted = REASONING_EFFORT !== null;
// stream_options(마지막 조각에 usage를 실어 달라는 요청)도 같은 방식이다 — 모르는 서버는 400으로 거절한다.
let streamOptionsAccepted = true;

// 스트림이 '흐르다 멈추면' 이만큼 기다렸다 끊는다. 전체 상한(TIMEOUT_MS)은 '정당하게 긴 답변'을 위한 것이라
// 120초인데, 도중에 죽은 엔드포인트도 그때까지 붙잡는다 — 조각이 흐르던 응답에서는 멈춤이 훨씬 먼저 보인다.
//
// 첫 조각까지는 이 상한을 걸지 않는다. 그 구간(요청이 서버의 대기열에 있고, 프롬프트를 읽고, 모델이 첫 토큰을
// 내기까지)은 '멈춤'과 구분되지 않는데, 바쁜 vLLM이나 사고 과정이 긴 모델에서는 정당하게 수십 초가 걸린다.
// 거기에 이 상한을 걸면 느릴 뿐인 요청이 두 번의 시도 끝에 실패로 끝나고, 사용자는 원인을 '멈췄습니다'로
// 잘못 안내받는다. 첫 바이트까지는 전체 상한이 지킨다(이 값이 없던 때와 같다) — 아래 armIdle을 첫 조각에서
// 처음 건다. 바이트가 흐르기 시작한 뒤의 멈춤만 이 값이 잡는다.
const IDLE_TIMEOUT_MS = numEnv('LLM_IDLE_TIMEOUT_MS', 30_000);

// 시스템 프롬프트에는 요청마다 달라지는 것을 하나도 싣지 않는다 (현재 시각도 아래 buildPrompt가
// 사용자 프롬프트 끝에 싣는다) — vLLM의 prefix caching은 앞에서부터 같은 토큰열만 재사용하므로,
// 여기 한 글자가 바뀌면 모든 요청·모든 스텝이 시스템 프롬프트부터 다시 계산한다.
const SYSTEM_PROMPT = `당신은 사내 지식 관리 및 DB 조회 Q&A 에이전트다.
지금까지 검색·실행해서 확보한 자료(관련 지식, Q&A 처리 방법, 실행 가능한 쿼리 목록, 실행 이력), 최근 대화, 그리고 사용자의 현재 질문이 이 순서로 주어진다. 자료는 처음에는 없고 네가 search로 요청해야 채워진다.
반드시 아래 세 형식 중 하나의 JSON 객체 하나만으로 응답하라. 다른 텍스트를 붙이지 마라.
생각을 적어야 한다면 <think> 와 </think> 사이에만 적어라. 그 블록 밖에는 위 JSON 하나만 남긴다.

1. 사내 자료가 필요하면 먼저 검색한다:
{"action":"search","text":"<검색어>","targets":["knowledge","qa_method","query"]}
- targets: knowledge = 사내 지식(개념·정책·절차·안내문), qa_method = 질문 유형별 처리 방법(어떤 쿼리를 어떤 순서로 실행해 답하는지), query = 조회 DB에 실행할 수 있는 쿼리 목록(현재 상태·수치·이력 조회). 필요한 것만 고르되, 무엇이 필요한지 확실하지 않으면 셋 다 넣는다. qa_method를 찾으면 그 본문이 지목한 쿼리는 함께 실린다.
- text: 질문의 핵심 낱말 2~6개(시스템명·작업 ID·고객명·절차명). 후속 질문이면 최근 대화에서 대상을 복원해 적는다 (예: "그럼 김철수는?" → "김철수 고객 주문 상태").
- 사내 시스템·업무·절차·데이터에 관한 질문은 검색 없이 답하지 마라. 검색이 0건이면 검색어를 바꿔 한 번 더 시도하고, 그래도 없으면 3의 규칙대로 답한다. 이미 검색한 검색어·대상을 반복하지 마라.
- 인사·잡담·감사 인사, 그리고 최근 대화에 이미 있는 내용의 재정리는 검색 없이 곧바로 답한다.
- drop: 앞서 받은 자료 중 더는 필요 없는 것의 번호를 함께 적는다 (예: ["k7","m2"]). 적은 것은 다음 단계부터 실리지 않아 그 자리를 관련 있는 자료가 쓴다. 첫 검색에는 필요 없다.
- 두 번째 검색부터는 drop을 함께 적어라. 새 결과가 목록 앞에 실리므로, 앞선 검색의 자료를 그대로 두면 길이 제한에 밀려 사라진다 — 어느 쪽이 이 질문에 필요한지는 너만 판단할 수 있다. 앞선 검색에서 아직 쓸 것이 있으면 이번 검색의 대상(targets)을 좁혀라.

2. 항목 앞에 번호가 붙어 있으면 그 자료를 더 청구할 수 있다:
{"action":"expand","ids":["k12"],"drop":["k7"]}
- 긴 지식은 여러 조각으로 나뉘어 있고 제목 끝의 (3~7/22) 가 전체 22조각 중 지금 실린 범위다. 청구하면 그 앞뒤가 이어져 실린다. 같은 번호를 다시 청구하면 더 넓어진다.
- 번호가 없는 항목은 더 받을 것이 없다 — 범위가 문서 전체이거나 길이 상한에 닿았다는 뜻이다. 청구해도 아무것도 늘지 않는다.
- 실린 범위 밖에 답이 있을 것 같을 때만 청구하라. 보이는 범위로 답할 수 있으면 그대로 답한다. 한 요청에 최대 ${MAX_EXPANDS}번.
- drop은 1의 것과 같다. 넓힌 본문이 자리를 많이 쓰므로 더는 필요 없는 자료를 함께 적어라.

3. 답변 전에 DB 조회가 더 필요하면:
{"action":"run_query","query_name":"<쿼리이름>","params":{"<바인드변수명>":"<값>"},"target_db":"<대상DB이름>"}
- query_name은 반드시 쿼리 목록에 있는 이름이어야 한다. 목록이 없거나 맞는 쿼리가 없으면 먼저 query를 검색하라.
- params에는 그 쿼리의 '바인드'에 적힌 변수를 전부 채워라. 키는 콜론 없이 쓴다 (:job_id → "job_id"). 값은 사용자 질문 또는 실행 이력의 결과에서 추출한다.
- 실행 이력에서 ${TRUNC_MARK} 으로 끝나는 값은 길어서 잘린 값이다. 그 값은 앞부분만 옮겨 적더라도 바인드로 쓰지 마라 — 잘리지 않은 다른 컬럼(ID 등)으로 조회하거나 사용자에게 되물어라.
- "어제", "이번 달", "최근 3일" 같은 상대 날짜는 질문 아래 '현재 시각'을 기준으로 절대 날짜로 바꿔 쓴다.
- target_db: 같은 쿼리를 어느 DB에서 실행할지 정하는 값이다. 쿼리 목록의 '대상DB'에 후보가 둘 이상이면 반드시 그중 하나를 등록된 철자 그대로 골라라 (후보가 하나뿐이면 생략해도 된다). 무엇을 고를지는 그 쿼리의 용도 설명과 질문·Q&A 처리 방법을 근거로 판단한다.
- 어느 후보를 골라야 할지 질문만으로 정할 수 없으면 지어내지 마라 — 어느 대상을 조회할지 사용자에게 되묻는 answer로 답하라.
- Q&A 처리 방법에 여러 단계가 서술되어 있으면 그 순서대로 하나씩 실행한다.
- 서로 의존하지 않는 조회가 둘 이상이면(예: 서울과 부산 재고, 두 배치의 상태) 한 번에 요청한다 — 왕복이 준다:
{"action":"run_queries","queries":[{"query_name":"<쿼리이름>","params":{…},"target_db":"<대상DB이름>"}, …]}
  최대 ${MAX_BATCH_QUERIES}개. 앞 조회의 결과가 다음 조회의 값이 되는 절차(처리 방법의 1단계→2단계)는 여기 담지 말고 run_query로 하나씩 실행한다.

4. 답변이 가능하면:
{"action":"answer","answer":"<사용자에게 보여줄 최종 답변>"}
- k12·m3 같은 자료 번호는 내부 표기다 — 답변에 옮겨 적지 마라.
- 관련 지식이나 쿼리 실행 결과가 있으면 반드시 그것에 근거해서 답하라.
- 검색을 했는데도 관련 지식·처리 방법·쿼리 결과가 전혀 없으면 너의 일반 지식으로 답하되, 답변 서두에 "*등록된 지식에 없는 내용이라 일반 지식으로 답변합니다.*" 한 줄을 붙여라. 인사·잡담에는 이 문구를 붙이지 마라.
- 실행 이력에 '검색 불가'가 있으면 등록된 자료가 없다고 단정하지 말고, 지금은 자료를 확인할 수 없다는 사실을 답변에 밝혀라.
- 일반 지식으로 답할 때도 사내 시스템의 구체적 상태(수치, 상태값, 일정 등)는 절대 지어내지 마라. 확인이 필요하면 확인 방법을 안내하라.
- 실행 이력의 오류 원문에 든 내부 정보(호스트·포트·접속 주소, 스키마·테이블·계정명, SQL 원문)는 answer에 옮겨 적지 마라. 오류는 "조회에 실패했다"는 사실과 사용자가 할 수 있는 다음 행동만 전달하라.
- answer는 markdown 형식으로 구조화하라: 조회 결과는 표(table)로, 항목 나열은 목록으로, 섹션 구분은 ### 제목으로 작성한다.
- 조회 결과를 표로 보일 때는 값을 옮겨 적지 말고 \`\`\`table 코드블록 하나에 참조만 적어라 — 서버가 그 실행의 결과(이력에 앞부분만 보인 것도, 최대 100행)로 표를 채운다. 옮겨 적는 것보다 빠르고 정확하다:
\`\`\`table
step: 2
cols: JOB_ID, STATUS, LAST_RUN_AT
limit: 20
\`\`\`
  step은 실행 이력의 번호(필수), cols는 보일 열(생략하면 앞 10열), limit은 행 수(생략하면 30). 표 위의 설명과 판단은 블록 밖에 쓴다. 결과의 한두 값만 인용할 때는 문장으로 쓰고 표를 만들지 마라.
- 수식은 LaTeX로 쓴다: 인라인은 $E=mc^2$ 또는 $$E=mc^2$$ (\\( \\), \\[ \\] 표기도 된다), 넓은 수식은 $$ 를 앞뒤 독립된 줄에 두어 별행으로 — 인라인은 접히지 않아 넓으면 잘린다. 금액 $100, 환경변수 $ORACLE_HOME 의 $는 그냥 쓴다.
- 수식을 코드블록에 넣지 마라 — 코드블록은 글자 그대로 보이라는 표기다. 여러 줄 수식(\\begin{aligned} 등)도 $$ 를 앞뒤 독립된 줄에 두어 그 안에 넣는다. 사용자가 LaTeX 원문 자체를 보여 달라고 한 경우에만 \`\`\`text 코드블록에 넣어라.
- 수치의 비교·추이·비율은 표와 함께 차트로도 보여줘라 — 값이 셋 이상이고 숫자 열이 있을 때, 한 답변에 넷 이하. 차트는 \`\`\`chart 코드블록 하나다:
\`\`\`chart
type: bar
title: 월별 처리 건수
x: 월
y: 건수
| 월 | 건수 |
|---|---|
| 2024-01 | 120 |
| 2024-02 | 95 |
\`\`\`
  type은 bar(항목 비교)·stacked-bar(구성 비교)·line(추이)·area(추이, 면적 강조)·pie(비율, 항목 8개 이하)·scatter(두 수치의 관계) 중 하나, title은 반드시 쓴다. x는 가로축 열(생략하면 첫 열), y는 값 열(쉼표로 여럿, 생략하면 x 밖의 숫자 열 전부), y2는 단위가 다른 값을 오른쪽 축에 선으로 겹칠 열, xtype: time 은 x가 날짜인 line·area에 쓴다(생략해도 날짜 형식이면 알아본다).
  표의 값은 실행 이력의 결과를 그대로 옮긴다 — 숫자에 단위·천 단위 쉼표·설명을 붙이지 말고, 날짜는 이력의 표기 그대로. 블록 밖에 같은 표를 반복하지 마라(화면이 차트 아래에 표를 함께 보여준다).
  '쿼리 실행 이력'의 결과 하나를 그대로 그릴 때는 표를 옮겨 적지 말고 \`data: step N\` 한 줄을 쓴다(N은 그 이력 항목의 번호 — "2. 쿼리이름 …"이면 2). 서버가 그 실행의 결과(이력에 앞부분만 보인 것도, 100행까지)로 표를 채우므로 옮겨 적는 것보다 정확하다. 이때도 type·title과 필요하면 x·y·y2를 함께 적는다. 결과가 문자열 위주의 목록·상세이면 차트를 쓰지 않는다. line·area는 x 값 하나에 행이 하나여야 한다 — 일자×상태처럼 같은 x가 여러 행이면 bar를 쓰거나 상태를 열로 펼친 표를 적어라.
- 절차·흐름·상태 전이를 설명할 때는 \`\`\`mermaid 코드블록에 flowchart TD 또는 sequenceDiagram을 쓸 수 있다. 노드 글자는 A[글자] 처럼 따옴표 없이 쓰고 괄호·따옴표·세미콜론 같은 특수문자는 피하라 — 문법이 틀리면 화면에 그림 대신 코드 원문이 보인다.
- answer는 JSON 문자열이므로 백슬래시는 두 번 쓴다: "$$x=\\\\frac{1}{2}$$".

## 대화 맥락
현재 질문이 이전 대화를 가리키면(예: "그럼 김철수는?", "재시작은 어떻게 해?") 최근 대화를 참고해
무엇을 묻는지 해석한 뒤 판단하라. 단, 이미 조회한 값이라도 현재 질문의 대상이 다르면 반드시 쿼리를 다시 실행하라.`;

// 시스템 프롬프트의 상한. 이 문자열은 프롬프트 예산(MAX_PROMPT_TOTAL_LEN) '밖'이지만 컨텍스트에는
// 매 스텝 실린다 — 예산 밖의 다른 두 몫(최근 대화·질문)은 상수가 묶고 있는데 이것만 관측값이라,
// 규칙 한 줄을 더할 때마다 조용히 자라고 context.md의 최악 합계는 근거를 잃는다. 실제로 그렇게
// 어긋나 있었다(문서 ~2k자, 실측 4.9k자). 요청마다 같은 토큰열이라 prefix caching이 재사용하므로
// 속도에는 거의 영향이 없지만, 컨텍스트 회계에는 그대로 들어간다.
// 로드 시점에 터뜨린다 — 예산 불변식과 같은 이유다(constants.js FLOOR_SUM 주석).
export const MAX_SYSTEM_PROMPT_LEN = 6000;
if (SYSTEM_PROMPT.length > MAX_SYSTEM_PROMPT_LEN) {
  throw new Error(
    `SYSTEM_PROMPT (${SYSTEM_PROMPT.length}) exceeds MAX_SYSTEM_PROMPT_LEN (${MAX_SYSTEM_PROMPT_LEN}) — ` +
    `trim the prompt or raise the ceiling together with context.md's "예산 밖의 몫" table.`
  );
}

// decide() 한 번이 쓸 수 있는 전체 시간(ms). 재시도도 이 예산을 나눠 쓴다 —
// 시도마다 타이머를 새로 주면 느린 엔드포인트에서 2배가 되고, 그 값이 다시 스텝 수만큼 곱해진다.
const TIMEOUT_MS = 120_000;

// HTTP 오류·타임아웃·파싱 실패 모두 1회 재시도하고, 그래도 결정을 얻지 못하면 null을 돌려준다.
//
// 여기서 사용자용 문구를 만들지 않는 것이 중요하다: 무엇을 안내할지는 이 요청이 지금까지 무엇을
// 해냈는지를 아는 쪽만 정할 수 있다. 조회를 세 번 성공해놓고 'LLM 호출에 실패했습니다' 한 줄만
// 내보내면 그 성과가 통째로 사라지는데, provider는 실행 이력을 해석할 위치가 아니다.
// agent.js가 null을 받아 손에 든 결과로 답을 만들고(renderAnswer), 그것마저 없을 때만 실패를 알린다.
// ctx의 두 훅은 선택이다 (agent.js가 준다):
//   onUsage(usage)          서버가 알려준 토큰 실측 — 요청별 계측(trace.timing)에 남긴다.
//   onAnswerDelta({text})   답변 문자열이 흘러오는 동안의 조각(디코딩된 답변 글자) — 화면의 미리보기.
//   onAnswerDelta({reset})  재시도로 앞선 조각을 버려야 한다.
export async function openaiDecide(ctx) {
  const userPrompt = buildPrompt(ctx);
  const deadline = Date.now() + TIMEOUT_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const preview = ctx.onAnswerDelta ? answerPreviewer(ctx.onAnswerDelta) : null;
    try {
      const { content, usage } = await chatCompletion(userPrompt, remaining, { onContent: preview?.feed });
      if (usage) ctx.onUsage?.(usage);
      const decision = parseDecision(content, ctx.forceAnswer);
      if (decision) {
        // 답변이 아닌 결정으로 끝났는데 미리보기가 나갔으면 거둬들인다. 모델이 사고 과정에서 답변 초안을
        // 적어 보고 접는 일이 흔한데(그 초안은 닫는 태그 앞에 있어 previewer가 걸러내지 못한다),
        // 거두지 않으면 사용자는 폐기된 답을 계속 보고 있고 다음 스텝의 진짜 답이 그 뒤에 이어 붙는다.
        if (decision.action !== 'answer' && preview?.emitted) ctx.onAnswerDelta({ reset: true });
        return decision;
      }
      // 결정을 못 읽었는데 미리보기는 나갔다 — 재시도 전에 화면이 그것을 버리게 한다
      if (preview?.emitted) ctx.onAnswerDelta({ reset: true });
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
        `[llm] no decision JSON found (attempt ${attempt + 1}/2): ` +
        `length=${content.length} firstChar=${JSON.stringify(content.trim()[0] ?? '')} ` +
        `hasBrace=${content.includes('{')} hasThinkTag=${/<\/?think\b/i.test(content)}`
      );
    } catch (e) {
      console.warn(`[llm] call failed (attempt ${attempt + 1}/2):`, e.message);
      if (preview?.emitted) ctx.onAnswerDelta({ reset: true });
    }
  }
  // 상세 오류는 위 warn 로그에만 남긴다 — 사용자용 문구는 호출부가 만든다 (위 주석 참고).
  return null;
}

// ===== 답변 미리보기 =====
// 응답이 흘러오는 동안 {"action":"answer","answer":"…"} 의 문자열 안쪽을 디코딩해 조각으로 내보낸다.
// 최종 답변은 파싱이 끝난 뒤 따로 확정되므로(parseDecision → agent.js finish) 이것은 '미리 보이는 글자'일 뿐이다 —
// 그래서 파서만큼 엄밀할 필요가 없고, 틀리면 화면이 done에서 바꿔 끼운다. 다만 두 가지는 지킨다:
//   ① 사고 과정 안의 초안은 내보내지 않는다 — 닫는 태그 뒤에서만 찾고, 열린 채인 여는 태그가 있으면 기다린다
//      (parseDecision이 초안 JSON을 결정으로 삼지 않는 것과 같은 이유).
//   ② JSON 이스케이프는 조각 경계를 넘어 이어질 수 있다 — 미완의 조각은 다음 조각 앞에 붙인다.
// 모르는 이스케이프(\frac 같은 LaTeX)는 글자 그대로 둔다 — 파싱 경계(normalizeJsonEscapes)와 같은 관용이다.
// 알려진 한계: 값이 백슬래시 하나로 끝나면(윈도우 경로) 그 닫는 따옴표를 이스케이프로 읽어 문자열의 끝을
// 지나친다 — 미리보기 끝에 JSON 꼬리 몇 글자가 잠깐 붙는다. 파서는 그 경우를 위해 두 번째 읽기를 두지만
// (matchingBrace의 literalBackslashBeforeQuote) 여기서는 그러지 않는다: 미리보기는 최종 답이 아니고
// (done이 갈아 끼운다) 그 판정을 하려면 뒤를 다 봐야 하는데 흘려보내는 동안에는 뒤가 아직 없다.
// (테스트에서 쓰므로 export 한다)
const ANSWER_START_RE = /"action"\s*:\s*"answer"\s*,\s*"answer"\s*:\s*"/;
// 자기닫힘 표기(<think/>)는 여는 태그가 아니다 — 열린 것으로 보면 그 뒤가 영영 사고 과정이 되어 그 모델의
// 모든 질문에서 미리보기가 통째로 사라진다. 결정 파서(scanCandidates)가 같은 표기에 같은 가드를 두고 있다:
// '모델이 이 표기를 한 번 쓰기 시작하면 모든 질문이 같은 이유로 실패한다'.
const REASONING_OPEN_RE = new RegExp(`<(?:${['thinking', 'think', 'reasoning', 'reflection', 'scratchpad', 'thought'].join('|')})\\b[^>]{0,100}(?<!/)>`, 'i');
const REASONING_CLOSE_RE = new RegExp(`</(?:${['thinking', 'think', 'reasoning', 'reflection', 'scratchpad', 'thought'].join('|')})\\s*>`, 'gi');
const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
const SEEK_TAIL = 200;   // 찾는 동안 들고 있을 원문 — 시작 패턴은 이보다 짧다

export function answerPreviewer(onDelta) {
  let state = 'seek';   // seek → inside → done
  let tail = '';        // seek: 마지막 닫는 태그 뒤의 원문 (상한 안에서)
  let inThink = false;  // 열린 채인 사고 과정 태그가 있는가
  let pending = '';     // inside: 아직 끝나지 않은 이스케이프 조각
  let emitted = false;
  const out = text => { if (text) { emitted = true; onDelta({ text }); } };

  const decode = chunk => {
    const text = pending + chunk;
    pending = '';
    let s = '';
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') { state = 'done'; break; }
      if (c !== '\\') { s += c; i++; continue; }
      const n = text[i + 1];
      if (n === undefined) { pending = '\\'; break; }
      if (n === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length < 4) { pending = text.slice(i); break; }
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { s += String.fromCharCode(parseInt(hex, 16)); i += 6; continue; }
        s += '\\u'; i += 2; continue;
      }
      s += n in SIMPLE_ESCAPES ? SIMPLE_ESCAPES[n] : `\\${n}`;
      i += 2;
    }
    return s;
  };

  return {
    feed(chunk) {
      if (!chunk || state === 'done') return;
      if (state === 'inside') { out(decode(chunk)); return; }
      tail += chunk;
      // 닫는 태그가 왔으면 그 뒤만 본다 — 앞은 사고 과정이다
      let lastClose = -1;
      REASONING_CLOSE_RE.lastIndex = 0;
      for (let m; (m = REASONING_CLOSE_RE.exec(tail));) lastClose = m.index + m[0].length;
      if (lastClose >= 0) { tail = tail.slice(lastClose); inThink = false; }
      if (REASONING_OPEN_RE.test(tail)) inThink = true;
      if (inThink) { tail = tail.slice(-SEEK_TAIL); return; }
      const m = ANSWER_START_RE.exec(tail);
      if (!m) { tail = tail.slice(-SEEK_TAIL); return; }
      state = 'inside';
      const rest = tail.slice(m.index + m[0].length);
      tail = '';
      out(decode(rest));
    },
    get emitted() { return emitted; },
  };
}

// response_format(구조화 출력, guided decoding)을 보내지 않는다. 두 가지를 재보고 내린 결론이다.
//   - 이 파일이 실제로 겪는 손상은 '유효하지 않은 JSON'이 아니라 '유효한데 뜻이 바뀐 JSON'이다.
//     \times 는 \t + "imes"로 문법상 완전히 유효하므로 문법을 강제해도 그대로 통과한다 —
//     guided decoding이 없애주는 것은 \[ 같은 무효 이스케이프뿐이고, 그건 아래 정규화가 이미 덮는다.
//     즉 가장 위험한(조용한) 부류는 구조화 출력으로 사라지지 않는다.
//   - 반대로 위험은 있다. 사고 과정 블록을 쓰는 모델에서 reasoning 파서 없이 스키마를 강제하면
//     <think> 자체를 낼 수 없게 되어(vLLM은 완성 전체에 문법을 건다) 이 파일이 공들여 다루는
//     ①②③ 형태가 서버 설정에 따라 통째로 달라진다.
// 그래서 '모델이 어떻게 쓰든 잃지 않게 읽는' 쪽(normalizeJsonEscapes)을 근본 대응으로 둔다.
// 반환: { content, usage } — usage는 서버가 주었을 때만.
// 응답은 스트림(stream: true)으로 받는다. 세 가지를 얻는다: ① 조각이 멈추면 전체 상한(120초)보다 훨씬 먼저 끊을 수
// 있다(IDLE_TIMEOUT_MS) ② 답변 문자열이 흘러오는 동안 화면에 미리보기를 낼 수 있다(onContent → answerPreviewer)
// ③ 첫 조각이 오는 시각이 '모델이 생각을 끝냈다'는 신호다. 스트림을 주지 않는 서버(JSON 하나로 답하는 프록시나
// 테스트 더블)는 예전 길로 읽는다 — 두 길이 같은 값을 돌려준다.
async function chatCompletion(userPrompt, timeoutMs, { onContent } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.LLM_API_KEY) headers.Authorization = `Bearer ${process.env.LLM_API_KEY}`;

  // 두 상한을 한 신호로 — 전체(timeoutMs)와 유휴(IDLE_TIMEOUT_MS). 유휴 타이머는 조각이 올 때마다 다시 건다.
  const ctl = new AbortController();
  let why = null;
  const total = setTimeout(() => { why = `LLM 응답이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다`; ctl.abort(); }, timeoutMs);
  let idle;
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { why = `LLM 응답이 ${Math.round(IDLE_TIMEOUT_MS / 1000)}초 동안 멈췄습니다`; ctl.abort(); }, IDLE_TIMEOUT_MS);
  };
  try {
    const res = await fetch(joinUrl(process.env.LLM_BASE_URL, 'chat/completions'), {
      method: 'POST',
      headers,
      signal: ctl.signal,
      body: JSON.stringify({
        model: process.env.LLM_MODEL,
        temperature: 0,
        // 폭주 가드이지 답변 길이 상한이 아니다 — 답변은 파싱 뒤 MAX_ANSWER_LEN이 묶는다 (constants.js 참고).
        max_tokens: MAX_COMPLETION_TOKENS,
        stream: true,
        ...(streamOptionsAccepted && { stream_options: { include_usage: true } }),
        ...(effortAccepted && { reasoning_effort: REASONING_EFFORT }),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      // 오류 본문도 상한 안에서만 받는다 — 아래에서 300자만 쓰는데 전부 받아 놓고 자르면
      // 실패한 요청이 오히려 성공한 요청보다 메모리를 더 쓴다 (constants.readCapped 주석).
      const detail = (await readCapped(res, MAX_UPSTREAM_ERROR_BYTES, 'LLM 오류')).slice(0, 300);
      // 이 파라미터를 모르는 서버는 400으로 거절한다. 한 번 겪으면 빼고 가도록 표시해두면
      // 바로 이어지는 재시도가 성공한다 (설정 하나 때문에 모든 질문이 실패하지 않게).
      if (res.status === 400 && effortAccepted && /reasoning/i.test(detail)) {
        effortAccepted = false;
        console.warn('[llm] this endpoint does not support reasoning_effort — omitting it from future requests.');
      }
      if (res.status === 400 && streamOptionsAccepted && /stream_options/i.test(detail)) {
        streamOptionsAccepted = false;
        console.warn('[llm] this endpoint does not support stream_options — omitting it from future requests (no token usage will be logged).');
      }
      throw new Error(`LLM API ${res.status}: ${detail}`);
    }
    const streamed = /text\/event-stream/i.test(res.headers.get('content-type') ?? '') && res.body?.getReader;
    const { content, usage, finish } = streamed
      ? await readEventStream(res, ctl.signal, armIdle, onContent)
      : fromJson(JSON.parse(await readCapped(res, MAX_UPSTREAM_JSON_BYTES, 'LLM')), onContent);
    // 실측을 남긴다 — 프롬프트 예산(constants.js)은 문자 기준 추정이고 토큰 수는 서버만 안다.
    // 예산을 다시 잡을 때 필요한 숫자가 이 한 줄이다 (usage를 주지 않는 서버에서는 남길 것이 없다).
    if (usage) console.log(`[llm] usage prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} finish=${finish ?? '?'}`);
    // 상한에서 끊긴 응답은 결정 JSON이 잘려 있어 아래 파싱이 실패한다. 그 실패는 '모델이 형식을 안 지켰다'
    // 로 보이므로, 원인이 길이였다는 사실을 여기서 따로 남긴다 (폭주인지 정당하게 긴 것인지는 이 로그로 가른다).
    if (finish === 'length') {
      console.warn(`[llm] completion cut at max_tokens=${MAX_COMPLETION_TOKENS} — runaway generation or an answer that needs a higher MAX_COMPLETION_TOKENS (constants.js).`);
    }
    return { content, usage };
  } catch (e) {
    // 우리가 끊은 것은 이유를 말한다 — AbortError 한 줄로는 전체 상한인지 멈춤인지 알 수 없다.
    if (why && (e?.name === 'AbortError' || ctl.signal.aborted)) throw new Error(why);
    throw e;
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
  }
}

// JSON 하나로 온 응답 (스트림을 주지 않는 서버). 미리보기도 한 번에 흘린다 — 두 길이 같은 훅을 지나게.
function fromJson(data, onContent) {
  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? '';
  if (content) onContent?.(content);
  return { content, usage: data.usage, finish: choice?.finish_reason };
}

// SSE(text/event-stream)를 읽는다. 한 줄 `data: {…}`에 조각 하나, `data: [DONE]`이 끝이다.
// choices[0].delta.content를 이어 붙이고, usage는 어느 조각에 있든(보통 마지막) 받는다.
// 크기 상한은 조각의 합으로 센다 — res.json()의 상한(constants.MAX_UPSTREAM_JSON_BYTES)과 같은 값, 같은 이유다.
// 줄 하나가 JSON이 아니면 버린다(주석 줄 `: ping`, 다른 event: 줄) — 그런 줄로 응답 전체를 잃지 않는다.
// 읽기는 신호(signal)와 경주시킨다. fetch의 abort는 본문 스트림을 끊어 주지만 그 보장은 구현마다 다르고
// (테스트 더블의 Response는 신호를 모른다), 유휴 상한의 존재 이유가 '멈춘 읽기에서 빠져나오는 것'이라
// 그 빠져나오는 길을 남의 구현에 맡기지 않는다.
async function readEventStream(res, signal, onChunk, onContent) {
  const reader = res.body.getReader();
  const aborted = new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => { /* 경주에서만 쓴다 — 홀로 남은 거부가 unhandledRejection이 되지 않게 */ });
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = '';
  let content = '';
  let usage;
  let finish;
  const takeLine = line => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(payload); } catch { return; }
    const choice = obj?.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) { content += delta; onContent?.(delta); }
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (obj?.usage) usage = obj.usage;
  };
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      onChunk();
      bytes += value.byteLength;
      if (bytes > MAX_UPSTREAM_JSON_BYTES) {
        const e = new Error(`LLM 응답이 상한(${MAX_UPSTREAM_JSON_BYTES.toLocaleString('en-US')} bytes)을 넘었습니다`);
        e.tooLarge = true;
        throw e;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) takeLine(line);
    }
    buffer += decoder.decode();
    if (buffer) takeLine(buffer);
  } finally {
    await reader.cancel().catch(() => { /* 이미 닫혔다 */ });
  }
  return { content, usage, finish };
}

// 검색 결과 본문(knowledge.content / qa_method.method / query_sql)은 전부 TEXT라 그 자체로는 상한이 없다.
// 항목 하나가 컨텍스트를 통째로 잡아먹지 않게 항목별로 자르고, 항목 수가 많을 때를 대비해
// 섹션 합계에도 예산을 둔다. 자른 사실은 모델에게도 보이게 남긴다(TRUNC_MARK) —
// 잘린 줄 모르면 끊긴 문장을 근거로 단정한다.
const clip = (v, max = MAX_PROMPT_ITEM_LEN) => {
  const s = String(v ?? '');
  return s.length > max ? clipText(s, max) + TRUNC_MARK : s;
};

// 항목 한 건 = 목록 한 줄('- '로 시작). 본문에 든 개행을 그대로 실으면 둘째 줄부터는 어느 항목에도
// 속하지 않는 문단이 되어 항목의 경계가 사라진다 — 지식 2건이 다섯 줄로 보이면 모델은 어디까지가
// 첫 건인지 모르고, 쿼리 줄에서는 '/ SQL:' 뒤 여러 줄짜리 SQL이 목록 밖으로 흘러나와 다음 '- 이름:'
// 줄이 SQL의 일부처럼 읽힌다. 두 가지로 나눈다:
//   oneLine — SQL·설명·오류처럼 줄바꿈이 뜻을 갖지 않는 것. 공백 연속을 한 칸으로 (길이도 준다).
//   indent  — 지식 본문·대화처럼 줄 구조(번호 목록·표)가 근거인 것. 이어지는 줄을 두 칸 들여
//             markdown 목록 항목의 연속 줄로 만든다. 들여쓰기 뒤에 clip하므로 결과는 상한 안이다.
const oneLine = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const indent = v => String(v ?? '').trim().split(/\r\n?|\n/).map((l, i) => i && l ? `  ${l}` : l).join('\n');

// 제목·쿼리명처럼 '항목을 지목하는 이름'의 상한. 본문보다 짧게 잡는다 — 라벨이라 길 이유가 없다.
// 이름에도 상한이 필요한 이유: renderItems는 예산과 무관하게 최소 1건을 싣는다(그 보장이 없으면
// 등록이 조금만 많아져도 섹션이 통째로 빈다). 그래서 '한 줄의 크기'가 곧 그 섹션의 실질 상한인데,
// 지식·처리방법 줄은 본문(content/method)만 clip하고 제목은 원문 그대로 싣고 있었다.
// 지금 그 줄이 유계인 것은 schema.sql이 title을 VARCHAR(200)으로 잡아준 덕분일 뿐이다 —
// 프롬프트 예산과 아무 상관 없어 보이는 마이그레이션 한 줄(title을 TEXT로)이면 제목 하나가
// 전체 예산(MAX_PROMPT_TOTAL_LEN)을 그대로 넘기고, 그 뒤 모든 질문이 컨텍스트 초과로 끝난다.
// 예산은 다른 파일의 스키마 제약이 아니라 이 파일 안에서 확정되어야 한다.
const MAX_PROMPT_NAME_LEN = 100;

// 섹션 예산을 쓰는 모든 렌더가 공유하는 두 규칙.
//
// ① 줄 하나의 비용은 '길이 + 개행 한 칸'이다. 배분(renderSections)이 실제로 그렇게 세므로
//    기준이 같아야 한다. 지식·처리방법·실행 이력은 개행을 세지 않고 있었다 — 줄 수만큼
//    (지식 200건이면 200자) 자기 몫을 넘겨 썼고, 배분은 실제 길이를 빼므로 그 초과는
//    뒤 섹션에서 나온다. 배분 순서상 마지막이 쿼리 목록이라, 결국 '버려지면 그 조회를 아예
//    못 하는' 섹션이 다른 섹션의 계산 오차를 떠안았다.
// ② 생략 안내 줄의 몫은 미리 떼어둔다. 예산을 다 쓴 뒤에 덧붙이면 그 줄이 통째로 섹션 예산
//    밖으로 나간다. 이 몫이 실제로 전체 예산을 지키는 곳은 마지막에 배분받는 쿼리 목록이다 —
//    그 초과를 흡수해 줄 뒤 섹션이 없기 때문이다(회귀 테스트가 그쪽만 잡아낸다).
//    지식·처리방법·실행 이력에서는 그 초과(줄당 40자 남짓)를 쿼리 목록의 몫이 흡수하므로
//    지금은 증상이 없다. 그래도 같은 규칙을 두는 이유는, 규칙이 섹션마다 다르면 '어느 섹션이
//    자기 몫을 지키는가'가 그때그때 다른 값이 되어 ①처럼 조용히 어긋날 자리를 남기기 때문이다.
const lineCost = line => line.length + 1;
const omittedNote = n => `- (이하 ${n}건은 프롬프트 길이 제한으로 생략)`;
// 실행 이력은 번호 목록이라 '앞선 N건'이 아니라 빠진 번호를 말한다 — 남은 줄의 번호가 3부터
// 시작하는 이유를 모델이 이 한 줄로 알 수 있어야 한다.
const earlierOmittedNote = n => `(${n === 1 ? '1번' : `1~${n}번`} 스텝은 프롬프트 길이 제한으로 생략)`;

// 안내 줄의 몫. 길이는 건수 표기 말고는 고정이라 유계다
// (건수는 등록 건수 또는 MAX_PROMPT_QUERIES + MAX_STEPS 이하). 두 줄을 붙이는 renderQueries가
// 가장 많이 쓰므로 그쪽 기준으로 넉넉히 잡고, 한 줄만 붙이는 쪽도 같은 값을 쓴다 —
// 예산 밖으로 새지 않는 것이 목적이지 마지막 한 자를 아끼는 것이 목적이 아니다.
const NOTES_RESERVE = 200;

// 검색 결과는 관련도 순으로 정렬돼 있으므로 예산을 넘기면 뒤(덜 관련된 것)부터 버린다.
// 최소 1건은 반드시 싣는다 — 항목별 clip이 이미 1건의 크기를 묶어두었으므로 그래도 예산을 크게 벗어나지 않는다.
// 몇 건을 버렸는지 모델에게 알린다: '이게 전부'라고 읽으면 없는 것을 없다고 단정한다.
function renderItems(items, render, budget) {
  const usable = Math.max(0, budget - NOTES_RESERVE);
  const lines = [];
  let used = 0;
  for (const item of items) {
    const line = render(item);
    if (lines.length > 0 && used + lineCost(line) > usable) break;
    lines.push(line);
    used += lineCost(line);
  }
  if (lines.length < items.length) {
    lines.push(omittedNote(items.length - lines.length));
  }
  return lines;
}

// 버린 자료는 프롬프트에서 빠진다. 목록에서 지우지는 않는다 — 병합이 seq로 중복을 거르므로(agent.js
// mergeFront) 표시만 세워 두면 같은 항목이 재검색으로 되살아나지 않는다.
export const live = list => (list ?? []).filter(o => !o?.dropped);

// 자료 항목 한 줄. 본문이 잘렸고 아직 펼치지 않았으면 앞에 식별자를 붙인다 — 청구할 수 있는 자리에만
// 번호가 보이게 해서, 모델이 펼칠 수 없는 것을 청구하느라 스텝을 버리지 않게 한다. 펼친 항목은 더 긴
// 상한으로 싣고 번호를 떼는데, 번호가 없다는 것이 곧 '더 받을 것이 없다'는 표시다.
const itemLine = (prefix, titleKey, bodyKey) => o => {
  // 청크 항목(doc_seq가 있다)은 본문이 이미 문서당 상한 안이라 자를 것이 없다 — 청크 크기를
  // MAX_PROMPT_ITEM_LEN과 같게 잡은 것이 그 근거다(chunk.js CHUNK_MAX_LEN). 번호를 붙일지는
  // '길이가 잘렸는가'가 아니라 '범위 밖에 청크가 남았는가'로 정한다(canGrow) — 청크는 잘리지
  // 않으므로 옛 판정을 그대로 두면 긴 문서에도 번호가 한 번도 붙지 않는다.
  const chunk = o.doc_seq != null;
  const max = chunk || o.expanded ? MAX_DOC_LEN : MAX_PROMPT_ITEM_LEN;
  const text = indent(o[bodyKey]);
  const askable = chunk ? canGrow(o) : (!o.expanded && text.length > max);
  // 위치 표기((3~7/22))는 제목을 자른 '뒤에' 붙인다 — 제목에 이어 붙여 넘기면 긴 제목에서 이 표기부터
  // 잘려 나가, 정작 조각으로 나뉜 긴 문서에서 위치를 알 수 없게 된다 (chunk.js buildItems의 range).
  const name = clip(oneLine(o[titleKey]), MAX_PROMPT_NAME_LEN) + (o.range ?? '');
  return `- ${askable ? `${prefix}${o.seq} ` : ''}[${name}] ${clip(text, max)}`;
};

// 바인드 변수명을 SQL과 따로 싣는다 — SQL이 길어 잘리더라도 채워야 할 파라미터가 사라지지 않게.
// 사라지면 모델이 params를 비우고, runQuery가 '바인드 변수를 쓸 수 없습니다'로 실패한다.
// 개수·이름 길이에 상한을 둔다 — bindNames는 표시용 절단(MAX_PROMPT_SQL_LEN) 전의 SQL 원문
// (TEXT 64KB)을 파싱하므로, 이 목록이 이 줄에서 유일하게 유계가 아닌 부분이었다. 바인드 수백
// 개짜리 SQL 하나가 등록되면 '최소 1건 보장'을 타고 그 한 항목이 예산을 뚫는다.
// 정상 쿼리의 바인드는 한 자릿수다(llm.js MAX_DECISION_PARAMS와 같은 근거) — 20이면 개입하지 않는다.
const MAX_PROMPT_BIND_NAMES = 20;
// 이름 자체는 식별자 상한(MAX_BIND_NAME_LEN)까지 그대로 싣는다. 그보다 짧게 자르면 101~128자짜리
// 적법한 바인드명을 모델이 철자대로 적을 방법이 사라져, 그 쿼리는 반드시 '값 없음'으로 실패한다 —
// 결정 경계(llm.js)가 그 길이를 유효하다고 통과시키는 것과 어긋나면 안 된다.
// 상한 자체는 등록 경계(sql.js assertReadOnly)가 강제하므로 여기 오는 이름은 이미 그 안에 있다.
const bindList = q => {
  const binds = bindNames(q.query_sql);
  const shown = binds.slice(0, MAX_PROMPT_BIND_NAMES).map(n => `:${clip(n, MAX_BIND_NAME_LEN)}`).join(', ');
  const omitted = binds.length - Math.min(binds.length, MAX_PROMPT_BIND_NAMES);
  return `${shown || '없음'}${omitted ? ` 외 ${omitted}개` : ''}`;
};

// 대상 DB 후보. 목록은 실행 경계와 같은 파서로 만든다 (constants.targetDbNames) — 두 곳이
// 다르게 읽으면 '프롬프트에 보였는데 실행이 거부하는' 후보가 생기고, 그 실패는 모델이 보인 대로
// 답했는데도 나므로 고칠 방법이 없다.
// bindList와 같은 이유로 표시 개수에 상한을 둔다: 후보가 아주 많은 등록 하나가 목록 전체의
// 예산을 먹어 다른 쿼리를 밀어내지 않게 한다. 보이지 않은 후보를 모델이 지목할 수는 없지만,
// 실행 경계는 등록된 후보면 무엇이든 받으므로 정확성이 깨지지는 않는다.
const MAX_PROMPT_TARGET_DBS = 10;
const dbList = q => {
  const names = targetDbNames(q.target_db_name);
  const shown = names.slice(0, MAX_PROMPT_TARGET_DBS).map(n => clip(n, MAX_TARGET_DB_NAME_LEN)).join(' | ');
  const omitted = names.length - Math.min(names.length, MAX_PROMPT_TARGET_DBS);
  return `${shown || '미등록'}${omitted ? ` 외 ${omitted}개` : ''}`;
};

// 후보가 둘 이상인지 — 짧은 형태에 대상DB를 실을지 가르는 기준이다 (아래 queryItemShort 주석).
const hasDbChoice = q => targetDbNames(q.target_db_name).length > 1;

const queryItem = q =>
  `- ${clip(q.query_name, MAX_PROMPT_NAME_LEN)}: ${clip(oneLine(q.query_desc))}` +
  ` / 입력(${clip(oneLine(q.input_desc), 300)}) / 출력(${clip(oneLine(q.output_desc), 300)})` +
  ` / 바인드(${bindList(q)}) / 대상DB(${dbList(q)})` +
  ` / SQL: ${clip(oneLine(q.query_sql), MAX_PROMPT_SQL_LEN)}`;

// 예산이 모자랄 때 쓰는 짧은 형태 — 실행에 반드시 필요한 것만 남긴다.
//   이름   : 이것이 없으면 그 쿼리를 지목할 방법 자체가 없다
//   용도   : 어떤 질문에 쓰는 쿼리인지 고르는 근거
//   바인드 : 무엇을 채워야 하는지 (없으면 첫 실행이 반드시 '값 없음'으로 실패한다)
//   대상DB : 후보가 둘 이상일 때만. 고르지 않으면 실행 경계가 거부하므로 바인드와 같은 부류다 —
//            후보가 하나뿐인 쿼리에는 붙이지 않는다 (고를 것이 없으면 실행에 필요하지 않다).
// 입출력 설명과 SQL 원문은 뺀다 — 있으면 좋지만, 없다고 그 쿼리를 못 쓰게 되지는 않는다.
const MAX_PROMPT_SHORT_DESC_LEN = 120;
const queryItemShort = q =>
  `- ${clip(q.query_name, MAX_PROMPT_NAME_LEN)}: ${clip(oneLine(q.query_desc), MAX_PROMPT_SHORT_DESC_LEN)} / 바인드(${bindList(q)})` +
  (hasDbChoice(q) ? ` / 대상DB(${dbList(q)})` : '');

// 짧은 형태로 실린 쿼리도 그대로 실행할 수 있다는 사실을 모델에게 알린다 —
// 이 안내가 없으면 모델은 설명이 얇은 항목을 '정보가 부족한 쿼리'로 읽고 후보에서 뺀다.
const shortFormNote = n =>
  `- (위 ${n}건은 이름·용도·바인드만 표시했다 — 그대로 실행할 수 있고,` +
  ` 지목하면 전체 정의가 다음 단계에 실린다)`;

// 쿼리 목록만 renderItems와 다른 규칙으로 싣는다. 손해의 크기가 다르기 때문이다.
//   지식·처리방법 — 꼬리를 버리면 '덜 관련된 근거'가 빠져 답이 부실해진다. 회복 경로가 필요 없다.
//   쿼리 목록     — 버려진 쿼리는 모델이 이름을 댈 수 없으므로 그 조회를 아예 못 한다.
//                   오류도 남지 않아 chat_log에는 '조회 없이 지식으로만 답한 요청'으로만 보인다.
// 그래서 '버리기 전에 줄인다': 먼저 모든 쿼리의 짧은 줄을 확보하고, 남는 여유만큼만 앞에서부터
// 자세한 줄로 올린다(목록은 관련도 순이다 — agent.js selectQueries). 짧은 줄만 있어도 모델은 이름을
// 지목할 수 있고, 지목하면 agent.js resolveQuery가 등록 원문을 다시 찾아 다음 스텝의 목록 맨 앞에
// 자세한 형태로 넣어준다 — 복구 경로가 이미 있고, 이 렌더가 그 입구를 열어둔다.
// 짧은 줄로도 다 못 실을 만큼 예산이 모자라면 그때는 꼬리부터 버린다(기존 동작).
function renderQueries(queries, budget) {
  const short = queries.map(queryItemShort);
  // 줄 비용과 안내 몫은 다른 섹션과 같은 규칙을 쓴다 (lineCost·NOTES_RESERVE 주석 참고).
  const cost = lineCost;
  const usable = Math.max(0, budget - NOTES_RESERVE);
  let used = 0;
  // ① 짧은 줄만이라도 최대한 많이 — 첫 항목은 예산과 무관하게 싣는다(renderItems와 같은 보장).
  let kept = 0;
  for (; kept < short.length; kept++) {
    if (kept > 0 && used + cost(short[kept]) > usable) break;
    used += cost(short[kept]);
  }
  // ② 자세한 줄로 올릴 대상은 detail 표시가 붙은 것뿐이다 — 경로A가 지목한 절차용 쿼리, 직접 검색의
  //    상위 몇 건, 모델이 이름을 대서 찾아낸 쿼리(agent.js). 나머지는 짧은 줄로 충분하다: 고르는 근거는
  //    이름·용도·바인드이고, 지목하면 다음 스텝에 자세히 실리며, 실행하면 결과 컬럼이 이력에 보인다.
  //    예전에는 예산이 남는 만큼 앞에서부터 전부 올렸는데, 검색이 요청 시에만 도는 구조에서는 예산이
  //    늘 남아 등록 30건 × SQL 원문이 스텝마다 그대로 실렸다 — prefill이 스텝 수만큼 곱해지는 자리다.
  //    여기서는 강제 보장을 두지 않는다 — ①이 이미 '모든 항목이 최소 한 줄'을 보장했으므로,
  //    예산을 넘겨서까지 올릴 이유가 없다.
  const lines = short.slice(0, kept);
  let detailed = 0;
  for (let i = 0; i < kept; i++) {
    if (queries[i].detail !== true) continue;
    const line = queryItem(queries[i]);
    const extra = line.length - short[i].length;
    if (used + extra > usable) break;
    used += extra;
    lines[i] = line;
    detailed++;
  }
  if (detailed < kept) lines.push(shortFormNote(kept - detailed));
  if (kept < queries.length) lines.push(omittedNote(queries.length - kept));
  return lines;
}

// 예산 안에 들어가는 가장 긴 앞부분을 돌려준다. 행 단위로 줄이는 이유: JSON 문자열을 중간에서
// 자르면 모델이 파싱할 수 없는 조각이 남고, 그 조각을 값으로 읽어 바인드로 되돌린다.
// 최소 1건은 남긴다 — 0건이면 모델이 '결과가 없다'로 읽는다. 단, 셀 상한(MAX_CELL_LEN)은 행의
// 크기를 묶어주지 않으므로(컬럼 수 × 셀 상한) 그 1건이 예산을 넘으면 컬럼 단위로 줄인다(fitCols) —
// 드라이버 경계(MAX_RESULT_COLS)가 컬럼 수를 묶지만, 그 상한 안에서도 행 하나가 스텝 예산을
// 넘을 수 있고, 프롬프트 조립은 경계가 우회되거나 느슨해져도 스스로 유계여야 한다(paramsJson 참고).
function fitRows(rows, budget) {
  let used = 2; // '[]'
  for (let i = 0; i < rows.length; i++) {
    used += JSON.stringify(rows[i]).length + (i ? 1 : 0); // 구분자 ','
    if (used > budget) {
      // 첫 행부터 예산을 넘으면 행 단위로는 더 줄일 수 없다 — 컬럼 단위로 줄인다.
      return i === 0 ? [fitCols(rows[0], budget)] : rows.slice(0, i);
    }
  }
  return rows;
}

// 생략 표시의 키. 드라이버 경계(oracle.js normalizeCells)가 컬럼 수 상한으로 자를 때 쓰는 키와
// 같은 값이다 — 같은 행에 두 표시가 함께 들어오면 Object.fromEntries가 나중 것만 남기므로,
// 여기서 무심코 다시 붙이면 상류의 안내가 조용히 사라지고 모델은 '프롬프트 길이 제한으로 N개'만
// 생략된 것으로 읽는다(실제로는 두 단계에서 잘린 합계다). 없는 컬럼을 '없다'로 단정하게 만드는,
// 두 주석이 나란히 막겠다고 적어둔 바로 그 실패다. 그래서 상류 표시를 예산 경쟁에서 빼고
// 반드시 실은 뒤, 두 단계의 생략을 한 값에 합쳐 둘 다 남긴다.
const OMIT_KEY = '…';

// 행 하나를 예산 안으로 줄인다 — 컬럼(값) 단위로 자르고, 몇 개를 버렸는지 행 안에 남긴다
// (JSON을 중간에서 자르지 않는 이유는 fitRows와 같다). 여기가 유계가 아니면 renderHistory의
// '최소 1줄 보장'을 타고 행 하나가 섹션 배분 전체를 우회한다. 키·값도 표시 상한으로 자른다 —
// 드라이버 경계가 우회된 거대 셀 하나가 '컬럼 하나는 무조건 싣는다'를 뚫으면 안 된다.
function fitCols(row, budget) {
  const entries = Object.entries(row);
  const upstream = entries.find(([k]) => k === OMIT_KEY)?.[1];
  const cols = entries.filter(([k]) => k !== OMIT_KEY);
  const kept = [];
  let used = 2; // '{}'
  for (const [k0, v0] of cols) {
    const k = clip(k0, 100);
    const v = clipDisplayValue(v0);
    const len = JSON.stringify(k).length + (JSON.stringify(v) ?? 'null').length + 2; // ':' + ','
    if (kept.length > 0 && used + len > budget) break;
    kept.push([k, v]);
    used += len;
  }
  const omitted = cols.length - kept.length;
  if (omitted > 0 || upstream !== undefined) {
    const notes = [];
    if (omitted > 0) notes.push(`외 ${omitted}개 컬럼 생략 (프롬프트 길이 제한)`);
    if (upstream !== undefined) notes.push(String(clipDisplayValue(upstream)));
    kept.push([OMIT_KEY, notes.join(' / ')]);
  }
  return Object.fromEntries(kept);
}

// params 표시 — query_name과 함께 이 줄에서 유일하게 LLM이 만든(상한 없는) 값이다.
// renderHistory는 최소 1줄을 반드시 실으므로, 여기가 유계가 아니면 값 하나가 섹션 배분을 통째로
// 우회해 전체 예산(MAX_PROMPT_TOTAL_LEN)을 뚫는다 — 결정 경계(llm.js sanitizeDecision)가 이미
// 값을 묶지만, 프롬프트 조립은 그 경계가 우회되거나 느슨해져도 스스로 유계여야 한다.
// 값 단위로 먼저 잘라 JSON을 유효하게 유지하고(중간에서 자르면 모델이 조각을 값으로 되읽는다),
// 여러 값의 합이 그래도 크면 전체를 한 번 더 자른다.
function paramsJson(params) {
  const entries = Object.entries(params || {}).map(([k, v]) => [clip(k, 100), clipDisplayValue(v)]);
  return clip(JSON.stringify(Object.fromEntries(entries)), MAX_PROMPT_PARAMS_LEN);
}

// 표시용 값 절단 — params(위)와 컬럼 절단 행(fitCols)이 같은 규칙을 쓴다.
// 문자열은 아래 상한으로, 스칼라는 그대로(수 리터럴은 짧다), 구조는 직렬화해 같은 상한으로.
//
// 이름에 '표시용(Display)'을 박아 두는 이유: llm.js에도 값 절단 규칙이 하나 더 있는데 뜻이 다르다
// (그쪽은 MAX_BIND_LEN으로 묶고 자른 값에 TRUNC_MARK를 붙여 실행 경계가 거부하게 만드는
// '실행에 쓸 값'의 상한이다 — llm.js clipBindValue). 두 규칙이 한때 같은 이름을 쓰고 있었는데,
// 이름이 같으면 '값을 어떻게 묶는가'를 바꾸는 변경이 한쪽에만 들어가도 아무 데서도 드러나지 않는다.
//
// 상한이 MAX_CELL_LEN이 아니라 그 + TRUNC_MARK 길이인 이유: 셀은 드라이버 경계
// (oracle.js normalizeValue)에서 이미 MAX_CELL_LEN으로 묶여 있고, 잘린 셀에는 TRUNC_MARK가
// 붙어 딱 그만큼 더 길다. 상한을 MAX_CELL_LEN으로 잡으면 '잘린 셀'만 여기서 한 번 더 잘려,
// 모델이 보는 앞부분이 실제로 자른 앞부분과 달라진다. 그러면 그 앞부분을 옮겨 적은 바인드 값을
// 실행 경계(oracle.js bindProblem)가 원본과 대조할 방법이 없어진다 —
// 대조가 성립해야 '잘린 조각으로 조회해 0건을 얻고 그것을 없다고 단정하는' 실패를 막을 수 있다.
const MAX_DISPLAY_VALUE_LEN = MAX_CELL_LEN + TRUNC_MARK.length;
const clipDisplayValue = v =>
  typeof v === 'string' ? clip(v, MAX_DISPLAY_VALUE_LEN)
    : v === null || typeof v === 'number' || typeof v === 'boolean' ? v
      : clip(JSON.stringify(v) ?? String(v), MAX_DISPLAY_VALUE_LEN);

// 검색 기록 한 줄. 대상별 적중 수를 대상 이름과 함께 적는다 — 어느 대상을 아직 안 찾아봤는지가 이 줄에서 보여야
// 다음 검색에서 그 대상을 더할 수 있다. '검색 불가'는 0건과 다른 말이다 (search.js 머리말) — 시스템 프롬프트가
// 이 표기를 그대로 언급하므로 문구를 바꾸면 그쪽도 함께 본다.
const TARGET_LABEL = { knowledge: '지식', qa_method: '처리방법', query: '쿼리' };
const HIT_KEY = { knowledge: 'knowledge', qa_method: 'qaMethods', query: 'queries' };
const MAX_PROMPT_SEARCH_LEN = 200;   // 검색어 표시 상한 (원문은 MAX_SEARCH_TEXT_LEN까지 — 표시는 이만큼이면 알아본다)

function searchLine(h, step) {
  const targets = (h.targets ?? []).map(t => TARGET_LABEL[t] ?? clip(oneLine(t), 20)).join('·');
  const head = `${step}. 검색 "${clip(oneLine(h.search), MAX_PROMPT_SEARCH_LEN)}" [${targets || '전체'}]`;
  if (h.note) return `${head} → 실행하지 않음: ${clip(oneLine(h.note))}`;
  const failed = new Set(h.failed ?? []);
  const parts = SEARCH_TARGETS.map(t => {
    if (failed.has(t)) return `${TARGET_LABEL[t]} 검색 불가`;
    const n = h.hits?.[HIT_KEY[t]];
    return n === null || n === undefined ? null : `${TARGET_LABEL[t]} ${n}건`;
  }).filter(Boolean);
  return `${head} → ${parts.length ? parts.join(' · ') : '결과 없음'}`;
}

// step은 이력 안의 절대 순번(1부터)이다. 앞선 스텝이 예산으로 생략돼도 번호가 당겨지지 않아야
// 처리 방법의 "2단계"와 모델이 보는 스텝이 어긋나지 않고, 화면 trace의 순번과도 같은 값을 가리킨다.
// 검색 기록도 같은 번호열을 쓴다 — 차트의 `data: step N`이 history 인덱스를 가리키므로 종류별로 따로 세면 어긋난다.
function historyLine(h, step) {
  if (h.search !== undefined) return searchLine(h, step);
  // 본문 청구가 헛돌았을 때만 이력에 남는다 — 성공하면 자료 섹션의 본문이 길어지는 것으로 드러나므로
  // 따로 적을 것이 없다 (쿼리 상세 경로와 같다). 실행되지 못한 줄이라 결과도 오류도 없다.
  if (h.expand !== undefined) {
    return `${step}. 본문 청구 "${clip(oneLine((h.expand ?? []).join(', ')), MAX_PROMPT_NAME_LEN)}" → 실행하지 않음: ${clip(oneLine(h.note))}`;
  }
  // 어느 DB에서 돈 스텝인지 함께 싣는다 — 대상DB 후보가 여럿인 쿼리에서 이것이 없으면 모델은
  // 방금 무엇을 조회했는지 알 수 없어, 다음 스텝에서 다른 후보를 골라 놓고 같은 결과를 기대하거나
  // 이미 본 DB를 다시 조회한다 (루프 가드는 이름·바인드만 보므로 그 반복을 잡지 못한다).
  const at = h.targetDb ? `@${clip(h.targetDb, MAX_TARGET_DB_NAME_LEN)}` : '';
  const head = `${step}. ${clip(h.query_name, 100)}${at} params=${paramsJson(h.params)}`;
  if (h.note) {
    // 루프 가드가 남긴 제어용 기록 — 실패가 아니므로 '오류'로 알리지 않는다 (모델이 실패로 오해해 불필요한 우회를 하지 않게)
    return `${head} → 실행하지 않음: ${clip(oneLine(h.note))}`;
  }
  if (h.error) {
    // 드라이버 오류 원문은 길고 여러 줄이다(ORA 메시지 뒤에 Help 링크 줄이 붙는다) — 항목 상한과 한 줄 규칙을 여기에도 건다.
    // hint는 모델 전용 복구 지침이다 — 사용자 trace에는 나가지 않으므로 여기서만 붙인다 (constants.safeError 참고).
    return `${head} → 오류: ${clip(oneLine(h.error))}${h.hint ? ` / 대응: ${clip(oneLine(h.hint))}` : ''}`;
  }
  // 건수 해석은 rowCounts 한 곳에서만 한다 (사용자 답변·화면 trace도 같은 해석을 쓴다).
  // 여기서 더 줄이는 것은 '몇 건을 인쇄하는가'뿐이므로 해석이 갈라지지 않는다: printed ≤ shown ≤ totalRows.
  const { rows, totalRows, capped } = rowCounts(h);
  const printedRows = fitRows(rows, MAX_PROMPT_STEP_LEN);
  const printed = printedRows.length;
  const note = capped
    ? ` (조회 상한 ${MAX_ROWS}건 도달 — 실제 총 건수는 더 많을 수 있음, 처음 ${printed}건만 표시)`
    : totalRows > printed ? ` (총 ${totalRows}건 중 처음 ${printed}건만 표시)` : '';
  return `${head} → 결과 ${totalRows}${capped ? '+' : ''}건${note}: ${JSON.stringify(printedRows)}`;
}

// 실행 이력은 다른 섹션과 반대로 '뒤에서부터' 채운다 — 최신 기록이 가장 중요하기 때문이다.
// 꼬리부터 버리면 방금 조회한 결과가 먼저 사라져 그 스텝이 통째로 헛수고가 되고,
// 모델은 결과를 못 본 채 같은 쿼리를 다시 제안한다(그러면 루프 가드에 걸려 답변만 부실해진다).
// 표시 순서는 시간순으로 되돌린다.
function renderHistory(history, budget) {
  const usable = Math.max(0, budget - NOTES_RESERVE);
  const lines = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const line = historyLine(history[i], i + 1);
    if (lines.length > 0 && used + lineCost(line) > usable) break;
    lines.push(line);
    used += lineCost(line);
  }
  lines.reverse();
  const omitted = history.length - lines.length;
  if (omitted > 0) lines.unshift(earlierOmittedNote(omitted));
  return lines;
}

// 섹션별 예산 배분 — 전체 상한 하나를 PROMPT_FLOORS 선언 순서대로 나눠준다.
// 각 섹션의 몫 = max(자기 최소 몫, 남은 예산 - 뒤 섹션들의 최소 몫 합).
// 뒤 섹션들의 최소 몫을 미리 떼어놓으므로 앞 섹션이 뒤를 굶기지 못하고, 앞이 짧으면 그 여유가
// 그대로 뒤로 넘어간다 — 그래서 가장 중요한 섹션(쿼리 목록)을 맨 뒤에 두었다(constants.js 참고).
// 이 배분 덕에 어느 섹션이 얼마나 길어지든 합계는 MAX_PROMPT_TOTAL_LEN을 넘지 않는다.
// 배분에 앞서 고정 틀의 몫(PROMPT_FRAME_RESERVE — 제목 줄·빈 줄·지시 블록)을 뗀다. 본문만 세면
// 네 섹션이 각자 예산에 꽉 찬 요청에서 틀의 길이만큼 정확히 전체 상한을 넘는다.
function renderSections(ctx) {
  const builders = {
    knowledge: budget => renderItems(live(ctx.knowledge), itemLine(ITEM_PREFIX.knowledge, 'title', 'content'), budget),
    qaMethods: budget => renderItems(live(ctx.qaMethods), itemLine(ITEM_PREFIX.qaMethods, 'title', 'method'), budget),
    history: budget => renderHistory(ctx.history, budget),
    queries: budget => renderQueries(ctx.queries, budget),
  };
  const keys = Object.keys(PROMPT_FLOORS);
  const out = {};
  let remaining = MAX_PROMPT_TOTAL_LEN - PROMPT_FRAME_RESERVE;
  keys.forEach((key, i) => {
    const reserved = keys.slice(i + 1).reduce((sum, k) => sum + PROMPT_FLOORS[k], 0);
    const lines = builders[key](Math.max(PROMPT_FLOORS[key], remaining - reserved));
    remaining -= lines.reduce((sum, line) => sum + lineCost(line), 0); // 줄마다 개행 한 칸 (lineCost)
    out[key] = lines;
  });
  return out;
}

// 프롬프트에 싣는 '현재 시각'의 시간대. 조회대상 DB의 today_date 쿼리(seed.sql)와 같은 KST로
// 고정한다 — 둘이 다르면 모델이 프롬프트의 날짜로 계산한 기준일과 DB가 돌려준 기준일이 자정
// 전후 몇 시간 동안 하루 어긋나고, 그 차이는 오류 없이 답변의 날짜에만 나타난다.
const PROMPT_TIME_ZONE = 'Asia/Seoul';
const PROMPT_TIME_ZONE_LABEL = 'KST';
// sv-SE 로케일은 ISO 형태(YYYY-MM-DD HH:MM)를 준다. 요일은 붙여 준다 — "이번 주", "지난 금요일"을
// 절대 날짜로 바꾸려면 오늘이 무슨 요일인지도 알아야 하는데, 모델이 날짜에서 요일을 셈하는 것은
// 틀리기 쉽고 틀려도 티가 나지 않는다.
const DATE_TIME_FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: PROMPT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const WEEKDAY_FMT = new Intl.DateTimeFormat('ko-KR', { timeZone: PROMPT_TIME_ZONE, weekday: 'short' });
// (테스트에서 쓰므로 export 한다)
export function formatNow(now) {
  const [date, time] = DATE_TIME_FMT.format(now).split(' ');
  return `${date} (${WEEKDAY_FMT.format(now)}) ${time} ${PROMPT_TIME_ZONE_LABEL}`;
}

// 섹션 하나 = 제목 줄 + 본문 줄들. 네 섹션 모두 제목에 건수를 달고, 비면 '(없음)'을 싣는다 —
// 규칙이 섹션마다 다르면(어떤 제목엔 건수가 있고 어떤 본문은 빈 채로 끝나면) 모델은 '비어 있음'과
// '누락됨'을 구분할 수 없고, 건수는 생략 안내와 맞춰 볼 때 '몇 건 중 몇 건이 실렸는지'를 준다.
// 버린 건수는 따로 적는다 — 건수만 줄여 보이면 모델은 자기가 버린 것을 길이 제한으로 잘린 것으로 읽는다.
const section = (title, count, lines, unit = '건', dropped = 0) =>
  [`## ${title} (${count}${unit}${dropped ? `, 버림 ${dropped}건` : ''})`, ...(lines.length ? lines : ['(없음)'])].join('\n');

// (테스트에서 쓰므로 export 한다 — 예산이 어긋나도 티가 나지 않는 종류의 실패라 회귀 테스트가 필요하다)
// now를 인자로 받는 이유: 테스트가 시각을 고정할 수 있어야 한다 (기본값은 호출 시각).
export function buildPrompt(ctx, now = new Date()) {
  // 배분 순서와 출력 순서는 별개다 — 배분은 우선순위대로, 출력은 모델이 읽기 좋은 고정 순서로.
  const s = renderSections(ctx);

  // 출력 순서는 '자료 → 과제' 다. 근거(지식·처리 방법·쿼리 목록·이력)를 먼저 보이고 질문과 지시를
  // 맨 끝에 둔다. 두 가지 이유다.
  //   ① 모델은 마지막에 읽은 것을 가장 강하게 붙든다(recency). 결정해야 할 것은 현재 질문이므로
  //      그것이 자료 4천 자 앞에 묻혀 있으면 안 된다 — 특히 후속 질문("그럼 김철수는?")은 짧아서
  //      앞에 두면 그대로 파묻힌다.
  //   ② 한 요청 안에서 스텝마다 바뀌는 것은 실행 이력과 지시(forceAnswer)뿐이다(목록 밖 쿼리를
  //      지목해 agent.js resolveQuery가 목록 앞에 끼워 넣는 드문 스텝은 예외). 요청마다 바뀌는 것
  //      (질문·대화·시각)까지 뒤로 몰면, 앞부분(시스템 프롬프트·지식·처리 방법·쿼리 목록)이 스텝
  //      사이에 같은 토큰열로 남아 vLLM prefix caching이 그만큼을 재사용한다.
  // 대화와 질문은 예산 밖이다: 각각 MAX_CHAT_TURNS×MAX_CHAT_LEN과 서버의 2,000자 제한으로
  // 이미 묶여 있고, 둘 다 빠지면 질문 자체가 성립하지 않아 버릴 수 있는 대상이 아니다.
  const chat = ctx.chat ?? [];
  // 자료 섹션은 '한 번이라도 찾아본' 대상만 싣는다. 찾아보지 않은 대상의 섹션을 '(없음)'으로 실으면
  // 모델은 '등록된 것이 없다'로 읽는다 — 비어 있음과 누락됨을 가르는 규칙(section 주석)의 연장이다.
  // 목록에 무언가 있으면 찾아본 적이 없어도 싣는다: 쿼리는 처리방법이 지목해서(경로A) 들어오기도 한다.
  const searched = new Set(ctx.searched ?? []);
  // 건수와 표시 판정은 '살아 있는' 목록으로 한다 — 버린 항목은 프롬프트에 실리지 않으므로 세지도 않는다.
  const kn = live(ctx.knowledge);
  const qa = live(ctx.qaMethods);
  const show = (target, list) => searched.has(target) || list.length > 0;
  // '아직 아무것도 안 찾아봤다'는 안내는 정말 한 번도 찾아보지 않았을 때만 붙인다. 찾아봤는데 검색이
  // 성립하지 않아 섹션이 비어 있는 요청에까지 '먼저 찾으라'고 말하면 남은 검색 기회를 그대로 태운다
  // (그 상황은 이력의 '검색 불가' 줄이 말한다).
  const nothingYet = !ctx.tried
    && !show('knowledge', kn) && !show('qa_method', qa) && !show('query', ctx.queries);
  const blocks = [
    show('knowledge', kn) && section('관련 지식', kn.length, s.knowledge, '건', ctx.knowledge.length - kn.length),
    show('qa_method', qa) && section('Q&A 처리 방법', qa.length, s.qaMethods, '건', ctx.qaMethods.length - qa.length),
    show('query', ctx.queries) && section('실행 가능한 쿼리 목록', ctx.queries.length, s.queries),
    section('실행 이력 (검색·쿼리)', ctx.history.length, s.history),
    section('최근 대화', chat.length, chat.map(m => `- ${m.role === 'user' ? '사용자' : '에이전트'}: ${indent(m.text)}`), '턴'),
    `## 사용자 질문 (현재)\n${ctx.question}`,
    // 지시는 항상 싣는다 — 마지막 스텝에만 붙으면 모델은 그 전까지 '지시가 없는 프롬프트'를 받아
    // 무엇을 하라는 것인지를 시스템 프롬프트에서 다시 찾아야 한다. 현재 시각도 여기 둔다: 질문과
    // 함께 읽혀야 하는 값이고, 매 분 바뀌는 값이라 앞쪽에 두면 ②의 재사용을 스스로 깬다.
    // 아직 아무것도 찾아보지 않은 첫 스텝에는 그 사실을 한 줄 더 적는다 — 자료 섹션이 통째로 없는
    // 프롬프트를 모델이 '자료가 없는 질문'으로 읽지 않게.
    `## 지시\n현재 시각: ${formatNow(now)}\n` + (ctx.forceAnswer
      ? '더 이상 검색하거나 쿼리를 실행할 수 없다. 지금까지의 정보만으로 action="answer"로 최종 답변하라.'
      : (nothingYet ? `${NOT_SEARCHED_NOTE}\n` : '') + '위 자료를 근거로 현재 질문에 대한 다음 행동 하나를 JSON으로 결정하라.'),
  ].filter(Boolean);
  return blocks.join('\n\n');
}

const NOT_SEARCHED_NOTE = '아직 검색한 자료가 없다. 사내 지식·처리 방법·쿼리가 필요한 질문이면 search로 먼저 찾고, 인사·잡담이면 바로 답하라.';

// ===== 예산 불변식 — 모듈 로드 시 검증 =====
// 실행 이력의 최소 몫(constants.js PROMPT_FLOORS.history)은 'MAX_STEPS 스텝이 각자 상한까지 차도 전부
// 실린다'가 근거다. 그 근거가 성립하지 않으면 강제 답변 스텝(이력이 MAX_STEPS건인 유일한 호출)에서
// 1번 스텝이 빠진다 — 실제로 그랬다(몫 14k < 5 × 3k + 머리말). 오류 없이 답변의 근거만 사라지는 종류라
// 값을 바꾸는 순간 드러나야 한다.
// 한 줄의 상한을 상수의 합으로 다시 적지 않고 잰다: 합을 적어두면 historyLine의 형식(머리말·건수 안내)이
// 바뀔 때마다 두 곳을 맞춰야 하고 어긋나도 티가 나지 않는다. 모든 항이 상한에 닿은 스텝을 실제로
// 렌더해 그 길이를 쓰되, 결과 JSON 몫은 fitRows가 보장하는 상한(MAX_PROMPT_STEP_LEN)으로 바꿔 넣는다.
// 결과 줄과 오류 줄 중 긴 쪽이 한 줄의 상한이다.
function maxHistoryLineLen() {
  const over = n => 'x'.repeat(n + 1); // 상한을 넘겨 clip이 '상한 + TRUNC_MARK'까지 채우게 한다
  const head = { query_name: over(MAX_PROMPT_NAME_LEN), targetDb: over(MAX_TARGET_DB_NAME_LEN), params: { p: over(MAX_PROMPT_PARAMS_LEN) } };
  const rows = Array.from({ length: MAX_RESULT_ROWS }, () => ({ C: 'x'.repeat(MAX_CELL_LEN) }));
  const resultLine = historyLine({ ...head, rows, totalRows: MAX_ROWS, capped: true }, MAX_HISTORY_ROWS);
  const rowsLen = JSON.stringify(fitRows(rows, MAX_PROMPT_STEP_LEN)).length;
  const errorLine = historyLine({ ...head, error: over(MAX_PROMPT_ITEM_LEN), hint: over(MAX_PROMPT_ITEM_LEN) }, MAX_HISTORY_ROWS);
  return Math.max(resultLine.length - rowsLen + MAX_PROMPT_STEP_LEN, errorLine.length);
}
// 쿼리 결과·오류 줄이 아닌 나머지 모양의 상한. 이력에 오는 줄은 넷이다 — 쿼리 결과·오류(위),
// 쿼리 모양의 안내(루프 가드·조회 상한), 검색, 본문 청구 실패. 뒤 셋은 결과도 오류도 없어 머리말과
// 안내 문구뿐이라 위 상한보다 짧다. 그 줄들에 결과 줄의 상한을 매기면 이력 몫이 실제로 필요한 것보다
// 훨씬 커져 다른 섹션을 굶긴다.
//
// 넷을 '모양별 개수'로 세지 않고 한 상한으로 합치는 이유: 개수가 묶여 있는 것은 쿼리 줄뿐이다.
// 검색 줄은 MAX_SEARCHES개가 아니다 — 중복 검색·횟수 상한에 걸린 줄(agent.js의 guardNote)은 검색
// 모양으로 이력에 남지만 searches를 올리지 않으므로, 진도가 난 검색과 번갈아 나오면 검색 모양 줄이
// MAX_SEARCHES를 넘는다(가드는 '연속' 헛돌 때만 끊는다). 본문 청구 실패 줄도 MAX_EXPANDS와 별개다.
// 종전 계산은 '쿼리 MAX_STEPS + 안내 1 + 검색 MAX_SEARCHES'라는 한 조합만 쟀는데, 그 조합이 최악인
// 것은 검색 줄이 쿼리 줄보다 짧다는 사실 덕분이지 개수 회계가 성립해서가 아니었다 — 안내 문구나
// MAX_PROMPT_SEARCH_LEN이 길어지면 검증이 통과한 채로 근거만 사라진다.
function maxOtherLineLen() {
  const over = n => 'x'.repeat(n + 1);
  const search = { search: over(MAX_PROMPT_SEARCH_LEN), targets: [...SEARCH_TARGETS] };
  const step = MAX_HISTORY_ROWS; // 번호는 이력 안의 절대 순번 — 자릿수가 가장 큰 값으로 잰다
  return Math.max(
    historyLine({
      query_name: over(MAX_PROMPT_NAME_LEN), targetDb: over(MAX_TARGET_DB_NAME_LEN),
      params: { p: over(MAX_PROMPT_PARAMS_LEN) }, note: over(MAX_PROMPT_ITEM_LEN),
    }, step).length,
    historyLine({ ...search, hits: { knowledge: MAX_ROWS, qaMethods: MAX_ROWS, queries: MAX_ROWS } }, step).length,
    historyLine({ ...search, failed: [...SEARCH_TARGETS] }, step).length,
    historyLine({ ...search, note: over(MAX_PROMPT_ITEM_LEN) }, step).length,
    historyLine({ expand: [over(MAX_PROMPT_NAME_LEN)], note: over(MAX_PROMPT_ITEM_LEN) }, step).length,
  );
}

// 이력이 받을 수 있는 줄은 MAX_HISTORY_ROWS개다(constants.js — agent.js가 그 수를 지킨다).
// 길이로 따진 최악은 '쿼리 줄을 최대한 많이'다: 쿼리 결과·오류 줄은 MAX_STEPS개까지만 생기고
// (agent.js runs가 가드에 걸린 항목까지 함께 세므로 그 상한이 실제로 지켜진다), 남는 자리는 어떤
// 모양이 오든 maxOtherLineLen을 넘지 않는다. 그래서 이 합은 '어떤 조합이 오더라도'의 상한이다 —
// 모양별 개수를 세지 않으므로 루프가 줄의 구성을 바꿔도 근거가 무너지지 않는다.
// 이 합이 몫 안에 들어야 '이력은 전부 실린다'가 참이 된다 — 넘치면 가장 오래된 조회 결과가 조용히 빠진다.
const OTHER_ROWS = MAX_HISTORY_ROWS - MAX_STEPS;
const HISTORY_FLOOR_NEEDED =
  MAX_STEPS * (maxHistoryLineLen() + 1) + OTHER_ROWS * (maxOtherLineLen() + 1)
  + NOTES_RESERVE; // +1: 줄마다 개행 (lineCost)
if (PROMPT_FLOORS.history < HISTORY_FLOOR_NEEDED) {
  throw new Error(
    `PROMPT_FLOORS.history (${PROMPT_FLOORS.history}) cannot hold MAX_HISTORY_ROWS (${MAX_HISTORY_ROWS}) full history lines ` +
    `— ${MAX_STEPS} query + ${OTHER_ROWS} other (${HISTORY_FLOOR_NEEDED} needed) — ` +
    `raise the floor or lower MAX_PROMPT_STEP_LEN in constants.js.`
  );
}

// ===== 응답 텍스트 → 결정 JSON =====
//
// 응답에서 최상위 {…} 덩어리를 뽑아 결정을 고른다.
// "첫 '{'부터 마지막 '}'까지"로 자르면 JSON 바깥에 중괄호가 하나만 있어도 슬라이스가 JSON이 아니게 된다
// (추론 모델의 <think> 블록, JSON 뒤에 붙는 설명문, 계획+결정 두 덩어리 — 전부 실제로 나오는 형태다).
// 그러면 정상 응답이 파싱 실패로 버려지고, temperature=0이라 재시도도 같은 응답을 받아 똑같이 실패한다.
//
// 사고 과정(<think>) 블록도 가려내야 한다. 그 안에는 "일단 {…}로 해볼까, 아니다" 식의 초안 JSON이
// 들어 있는 일이 있어, 그냥 두면 초안이 최종 결정보다 먼저 잡힌다. 세 형태가 실제로 나온다:
//   ① <think>…</think>  짝이 맞는 경우
//   ② …</think>         Qwen3·R1 계열의 기본 채팅 템플릿은 <think>를 프롬프트에 미리 붙이므로
//                       content에는 닫는 태그만 온다 — 이 형태가 오히려 더 흔하다
//   ③ <think>…(끝)      토큰 한도로 잘려 닫히지 않은 경우
//
// 첫 번째 규칙은 사고 과정을 '텍스트에서 지우지 않는다'는 것이다.
// 지우는 방식은 태그가 JSON 문자열 안에 있는 경우와 진짜 태그를 구분할 수 없어, 모델이 답변 본문에
// 태그 문자열을 쓰는 순간(그 태그가 무엇인지 묻는 질문 등) 양방향으로 깨졌다:
//   {"answer":"<think> 는 …"}      → 태그부터 끝까지 지워져 JSON이 깨지고 결정이 통째로 사라진다
//   {"answer":"<think>x</think>"}  → 본문만 도려낸 채 '정상 결정'으로 나간다
// 뒤쪽이 특히 나쁘다 — 훼손된 답변이 오류도 재시도도 없이 그대로 사용자에게 간다.
// 앞쪽도 temperature=0이라 재시도가 같은 응답을 받아 똑같이 실패한다.
// (닫는 태그만 되돌려 보는 식으로 한 갈래씩 막으면 나머지 갈래가 그대로 남는다.)
//
// 원문은 건드리지 않고 한 번만 훑는다. 후보 JSON과 태그를 같은 스캔에서 읽되,
// 파싱에 성공한 객체는 통째로 건너뛴다. 그 한 가지가 태그와 본문을 정확히 갈라준다:
//   ⓐ 유효한 JSON에서 '<'는 문자열 리터럴 안에만 올 수 있다 → 파싱되는 객체 안의 태그는 태그가
//      아니라 answer 본문의 글자다. 건너뛰므로 애초에 눈에 들어오지 않는다(마스킹이 부산물이 된다).
//   ⓑ 그렇게 남은 진짜 태그로 깊이를 세면, 깊이 0에서 시작하는 첫 후보가 곧 모델의 최종 결정이다.
// 훑기가 한 번이라 구간 목록·병합·이분 탐색이 필요 없고, '후보를 먼저 파싱해야 마스킹할 수 있는데
// 후보를 뽑으려면 구간이 필요하다'는 순환도 생기지 않는다.

// text[start]가 '{'일 때 짝이 되는 '}'를 찾는다.
// 문자열 리터럴 안의 중괄호·따옴표는 세지 않는다 — answer 본문에 '{'가 들어갈 수 있다.
//
// 반환: { end, escapedQuote }
//   end          — 짝이 되는 '}'의 인덱스 (닫히지 않으면 -1)
//   escapedQuote — 스캔 중 '\"'를 이스케이프된 따옴표로 읽은 적이 있는가 (아래 두 번째 읽기의 조건)
//
// literalBackslashBeforeQuote: '\"'를 '이스케이프된 따옴표'가 아니라 '리터럴 백슬래시 + 닫는
// 따옴표'로 읽는다. 두 가지 읽기가 필요한 이유는 이 파일이 normalizeJsonEscapes를 두는 이유와
// 정확히 같다 — 모델은 백슬래시를 한 번만 쓴다. 값이 백슬래시로 끝나면(윈도우 경로 'C:\',
// LaTeX의 행 바꿈 '\\') 그 값의 닫는 따옴표가 '\"'가 되어, 엄격하게 읽으면 문자열이 영영
// 닫히지 않고 후보가 통째로 버려진다(-1). temperature=0이라 재시도도 같은 텍스트를 받아 똑같이
// 실패하므로, 모델의 진짜 답변이 오류 하나 없이 사라진다 — 이 파일이 가장 나쁘게 보는 형태다.
//
// 정규화(normalizeJsonEscapes)가 이 문제를 대신 풀어줄 수는 없다. 그쪽은 '후보의 끝이 어디인가'가
// 이미 정해진 뒤에 도는데, 여기서 -1이면 후보 자체가 없어 정규화가 실행될 기회가 없기 때문이다.
// 그래서 같은 판단을 후보의 끝을 정하는 이 스캔에서도 할 수 있어야 하고, 두 함수가 반드시 같은
// 해석을 써야 한다 — 한쪽만 관대하면 닫는 따옴표를 서로 다르게 세어 파싱이 반드시 실패한다.
// 그 짝은 parseCandidate가 묶어 둔다.
function matchingBrace(text, start, literalBackslashBeforeQuote = false) {
  let depth = 0, inStr = false, esc = false, escapedQuote = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') {
        // 두 번째 읽기에서는 다음 글자를 소비하지 않는다 — 다음 회차의 '"'가 문자열을 닫는다
        if (literalBackslashBeforeQuote && text[i + 1] === '"') continue;
        if (text[i + 1] === '"') escapedQuote = true;
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { end: i, escapedQuote };
  }
  return { end: -1, escapedQuote };
}

// 후보 하나를 읽는다 — 끝을 정하고(matchingBrace) 같은 해석으로 정규화해 파싱한다.
// 두 단계를 한 함수에 묶어 두는 이유: 끝을 정하는 규칙과 파싱 직전 정규화 규칙이 갈라지면
// 파싱이 반드시 실패하므로, 둘을 따로 부르는 자리를 남기지 않는다.
//
// 엄격한 읽기를 먼저 한다 — 정상적으로 이스케이프된 따옴표가 압도적으로 흔하다.
// 두 번째 읽기는 ① 엄격한 읽기로 후보가 닫히지 않았고 ② 그 원인이 될 수 있는 '\"'를 실제로
// 본 경우에만 돈다. 조건 ②가 대부분의 퇴화한 응답을 걸러낸다: 짝 없는 '{"'가 반복되는 입력
// (MAX_UNMATCHED_* 주석의 그 입력)에는 '\"'가 없으므로 두 번째 스캔이 시작되지도 않는다.
//
// 그것만으로는 부족하다 — '{"a\"' 가 반복되면 조건 ②가 매번 참이 되어 후보마다 두 번씩 훑는다
// (실측: 203KB에서 925ms로, 같은 크기의 '{"a' 반복보다 2.4배). 그래서 실제로 몇 번 훑었는지를
// 함께 돌려주고, 호출부가 그 수를 전역 예산(MAX_UNMATCHED_TOTAL)에 청구한다.
// 예산이 '후보 수'가 아니라 '훑은 횟수'를 세면 두 번째 읽기를 더해도 총량이 그대로 묶인다 —
// 그 시간은 동기 작업이라 동시에 처리 중인 모든 요청이 함께 멈추므로, 상한은 유지되어야 한다.
//
// 조건 ①을 '엄격한 읽기가 실패했을 때'가 아니라 '문자열을 못 닫았을 때'로 좁혀 둔다.
// 끝을 찾았는데 파싱만 실패한 경우는 텍스트가 어디서 망가졌는지 알 수 없어, 더 짧은 읽기를
// 채택하는 것이 '값이 잘린 결정'을 만들어낼 수 있다 — 그건 이 파일이 2순위에서 run_query를
// 받지 않는 것과 같은 이유로 피한다(초안을 실행하는 것보다 결정을 못 찾는 편이 낫다).
// 반면 '문자열이 끝까지 안 닫혔다'는 백슬래시로 끝난 값이 내는 바로 그 증상이라 근거가 분명하다.
// 실제 응답 형태(결정 뒤 산문·코드펜스·think 태그·한 겹 감싼 결정)는 전부 이 조건으로 복구된다.
//
// 반환: 성공이면 { value, end, scans }, 실패면 { scans } (value === undefined).
function parseCandidate(text, start) {
  const strict = matchingBrace(text, start);
  if (strict.end > 0) {
    const value = tryParse(text.slice(start, strict.end + 1), false);
    if (value !== undefined) return { value, end: strict.end, scans: 1 };
  }
  if (strict.end < 0 && strict.escapedQuote) {
    const lenient = matchingBrace(text, start, true);
    if (lenient.end > 0) {
      const value = tryParse(text.slice(start, lenient.end + 1), true);
      if (value !== undefined) return { value, end: lenient.end, scans: 2 };
    }
    return { scans: 2 };
  }
  return { scans: 1 };
}

// JSON.parse는 undefined를 돌려주지 않으므로 undefined를 '파싱 실패'로 쓸 수 있다.
function tryParse(slice, literalBackslashBeforeQuote) {
  // 이스케이프 정규화를 거쳐 파싱한다 — LaTeX를 한 번만 이스케이프한 응답도 여기서 살아난다.
  try { return JSON.parse(normalizeJsonEscapes(slice, literalBackslashBeforeQuote)); }
  catch { return undefined; }  /* JSON이 아닌 중괄호 덩어리 */
}

// ===== 이스케이프 정규화 =====
//
// answer·params는 JSON 문자열 필드인데 LaTeX는 백슬래시투성이다. 모델이 백슬래시를 한 번만 쓰면
// JSON의 이스케이프 표와 LaTeX 명령이 같은 두 글자를 놓고 부딪치고, 그 결과가 두 갈래로 갈린다:
//   \[ x^2 \]  → JSON에 없는 이스케이프라 JSON.parse가 던진다 → 후보 0건 → 답변이 통째로 소실
//   \frac \times → JSON에 '있는' 이스케이프라 파싱이 성공하면서 명령이 제어문자 한 글자로 바뀐다
//                  (\f→폼피드+rac, \t→탭+imes). 오류가 없어 로그에도 남지 않고, 화면에는
//                  'rac'·'imes'만 남는다 — 조용해서 가장 나쁜 쪽이다.
//
// 그래서 파싱 전에 '무엇을 이스케이프로 인정할지'를 우리가 정한다. JSON.parse의 고정된 표에
// 맡기는 한 두 번째 갈래는 손댈 수 없다 — 파싱이 성공해버리므로 실패를 볼 기회 자체가 없다.
// 판단 기준은 하나다: 그 제어문자가 markdown 답변 본문에 정말로 쓰일 수 있는가.
//   \b \f (백스페이스·폼피드) — 쓰일 일이 없다 → 항상 두 글자로 되돌린다 (\beta \begin \frac \forall).
//   \t \r (탭·복귀)          — 쓰일 수 있다 → 뒤에 영문자가 올 때만 되돌린다. 명령 이름은 반드시
//                              영문자로 이어지므로, 탭+'{'·탭+공백처럼 명령이 될 수 없는 자리는
//                              탭 그대로 둔다 (\times \text \theta \to \rho \right \rightarrow).
//   \n (줄바꿈)              — markdown의 뼈대다 → 아래 목록에 있는 명령 이름이 통째로 이어질
//                              때만 되돌린다. 이 조건이 없으면 멀쩡한 답변의 줄바꿈이 전부 깨진다.
// 되돌리지 못하는 경우가 남지만(예: 줄바꿈 뒤에 우연히 'eq'로 시작하는 줄) 그때도 손해는
// '수식 한 줄이 이상하게 보인다'이지, 답변이 사라지거나 조용히 바뀌는 것이 아니다.
//
// 문자열 '안'에서만 동작한다 — 구조를 이루는 중괄호·콜론은 건드리지 않는다.
// 항상 돌린다. 파싱에 실패했을 때만 돌리면 두 번째 갈래(파싱은 성공하는 손상)를 영원히 놓친다.

// JSON이 인정하는 한 글자 이스케이프 중 '뜻이 하나뿐인' 것들. \u는 뒤에 16진수 4자리가 붙어야 유효하다.
const UNAMBIGUOUS_ESCAPES = '"\\/';

// \n 다음에 이것이 이어지면 줄바꿈이 아니라 LaTeX 명령으로 본다(\nabla, \neq, …). 긴 것부터 본다 —
// 'otin'을 'ot'으로 먼저 끊으면 \notin이 \not+in이 된다.
// 답변에서 '줄이 이 글자로 시작할 수 있는가'만 기준으로 골랐다. 그래서 \ne·\ni·\nu(줄이 'e '·'i '·'u '로
// 시작하는 것은 수식 안에서 흔하다)는 일부러 뺐다 — 그쪽은 되돌리지 않는 편이 안전하다.
const N_COMMAND_TAILS = ['rightarrow', 'leftarrow', 'subseteq', 'supseteq', 'parallel', 'onumber', 'exists', 'ewline', 'otin', 'abla', 'eq'];

// 문자열 안에 그대로 온 제어문자(0x1F 이하)는 JSON에서 무효라 파싱이 통째로 실패한다.
// 모델이 answer 안에서 진짜로 줄을 바꿔 쓰는 일은 드물지 않은데, 그 한 번이 '답변 소실'이 된다.
// 뜻이 분명하므로(줄바꿈은 줄바꿈이다) 유효한 이스케이프로 바꿔 살린다.
const CONTROL_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
const escapeControl = c => CONTROL_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;

const isLetter = c => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

// text[i+1]이 n일 때, 그 이스케이프를 '제어문자'로 볼지(true) 'LaTeX 명령'으로 볼지(false).
function keepsControlMeaning(text, i, n) {
  if (n === 'b' || n === 'f') return false;                 // 답변 본문에 올 수 없는 문자
  if (n === 't' || n === 'r') return !isLetter(text[i + 2]); // 명령 이름이 될 수 있는 자리에서만 되돌린다
  // n — 뒤에 명령 이름이 통째로 이어지고 그 뒤가 영문자가 아닐 때만 명령으로 본다.
  // 여기서 남은 문자열을 잘라내면(slice) '이스케이프 수 × 응답 길이'라 긴 응답에서 이차가 된다.
  return !N_COMMAND_TAILS.some(tail => text.startsWith(tail, i + 2) && !isLetter(text[i + 2 + tail.length]));
}

function normalizeJsonEscapes(text, literalBackslashBeforeQuote = false) {
  let out = '', inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inStr) { if (c === '"') inStr = true; out += c; continue; }
    if (c === '"') { inStr = false; out += c; continue; }
    if (c < ' ') { out += escapeControl(c); continue; }
    if (c !== '\\') { out += c; continue; }
    const n = text[i + 1];
    // 후보의 끝을 그렇게 읽었으면 여기서도 그렇게 읽는다 (matchingBrace 주석 참고) —
    // 백슬래시를 리터럴로 되돌리고 다음 글자('"')는 소비하지 않아 문자열이 거기서 닫힌다.
    if (literalBackslashBeforeQuote && n === '"') { out += '\\\\'; continue; }
    // \uXXXX는 뜻이 분명하다 — 16진수 4자리가 붙어야 유효하고, 아니면 아래에서 \upsilon처럼 명령으로 산다.
    if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { out += c + n; i++; continue; }
    if (n !== undefined && UNAMBIGUOUS_ESCAPES.includes(n)) { out += c + n; i++; continue; }
    if (n !== undefined && 'bfnrt'.includes(n) && keepsControlMeaning(text, i, n)) { out += c + n; i++; continue; }
    // 남은 것은 전부 '백슬래시 그 자체' — 무효한 이스케이프(\[, \alpha)와 위에서 명령으로 판정된
    // 자리(\times, \beta)가 여기로 온다. 다음 글자는 소비하지 않고 평범한 글자로 흘려보낸다
    // (제어문자면 다음 회차에서 이스케이프된다).
    out += '\\\\';
  }
  return out;
}

// 태그 안(<think 와 > 사이)에서 허용하는 문자와 그 길이 상한.
//
// '<'를 빼는 것이 핵심이다. 속성에 raw '<'가 오는 태그는 없는데, 허용하면 매치가 태그 경계를 넘어
// 다음 태그를 통째로 삼킨다: `<think 태그를 물었다</think>` 가 통째로 '여는 태그 하나'로 잡혀
// 진짜 닫는 태그가 사라지고, 닫히지 않은 블록(③)이 되어 그 뒤의 정상 결정이 통째로 버려진다.
// 하필 이 파일이 지키려는 바로 그 상황에서 터진다 — 사용자가 think 태그를 물으면 모델의 사고
// 과정이 자연스럽게 '<think'를 언급하고, 그 언급은 JSON 밖이라 마스킹도 구해주지 못한다.
// (실측: 같은 문장에서 '<think' 언급만 빼면 정상 동작했다.)
//
// 길이 상한이 없으면(`*`) '>'가 없는 입력에서 매 '<think'마다 남은 텍스트를 끝까지 훑고
// 되돌아온다 — 시작점 수 × 길이라 정확히 이차다(ReDoS). 실측: '<think'만 반복한 응답이 94KB에서
// 578ms, 크기를 2배로 하면 시간은 4배가 되어 1MB면 1분을 넘긴다. temperature=0에서 모델이 같은
// 토큰을 반복하는 퇴화한 응답은 실제로 나오고, 그 한 건이 동시에 처리 중인 모든 요청을 그만큼
// 멈춰 세운다 (후보 예산이 막으려던 것과 같은 종류의 실패다).
// 상한을 두면 되돌아오는 폭이 상수라 전체가 선형이 된다(같은 입력 3ms). 실제 템플릿이 내는 태그는
// '<think>'·'</think>' 그대로이고 속성이 붙어도 짧다 — 100자면 개입하지 않는다.
// '{'와 '}'도 같은 이유로 뺀다. 속성에 중괄호가 오는 태그는 없는데, 허용하면 매치가 결정 JSON
// 안으로 들어가 그 안의 '>'를 태그의 끝으로 삼는다: `설명: <think 태그입니다. {"…"a>b"}` 에서
// `<think … a>` 까지가 '여는 태그'가 되어 닫히지 않은 블록(③)이 되고, 뒤의 정상 결정이 버려진다.
// ('>'가 답변 본문에 들어가는 것은 흔하다 — 마크다운 인용, '->', HTML 예시.)
//
// 상한을 넘거나 '<'·'{'·'}'를 만난 것은 태그로 보지 않는다: '>' 없는 '<think'를 태그로 치지 않는
// 지금 동작과 같다. (반대로 '미완성 여는 태그'로 취급하면, 산문에서 태그 이름을 언급한 질문의
// 정상 답변이 통째로 사고 과정으로 몰려 버려진다.)
const MAX_TAG_ATTR_LEN = 100;

// 사고 과정 블록에 쓰이는 태그 이름. '<think>'만 보면 다른 표기를 쓰는 모델에서 초안이 그대로
// 결정으로 새어 나온다 — 블록이 인식되지 않으니 그 안의 JSON이 '사고 과정 밖'으로 분류되고,
// 후보 중 처음이라 진짜 결정보다 먼저 채택된다(실측: 검토하다 접은 run_query가 실행됐다).
// LLM_MODEL은 설정으로 바뀌고 시스템 프롬프트가 사고 과정 표기를 지정하지도 않으므로, 어떤 표기가
// 올지는 이쪽이 정할 수 없다. 초안을 실행하는 것보다 결정을 못 찾는 편이 낫다는 이 파일의 기준대로,
// 널리 쓰이는 표기를 모두 사고 과정으로 본다.
// 긴 이름을 앞에 둔다 — 뒤의 \b가 'think'와 'thinking'을 갈라주지만 순서가 분명한 편이 읽기 좋다.
const REASONING_TAGS = ['thinking', 'think', 'reasoning', 'reflection', 'scratchpad', 'thought'];

// ===== 모르는 사고 과정 표기 감지 =====
//
// 위 목록 밖의 표기를 쓰는 모델에서는 사고 과정 블록이 인식되지 않는다. 그러면 그 안의 초안이
// '사고 과정 밖'으로 분류돼 후보 중 처음이라 진짜 결정보다 먼저 채택된다 — 모델이 검토하다 접은
// 쿼리가 실제로 실행되고, 그 결과가 최종 답변의 근거가 된다.
// 문제는 그 실패가 '정상 응답'처럼 보인다는 것이다: 결정 JSON은 멀쩡하고, 오류도 재시도도 없다.
// 시스템 프롬프트로 <think> 표기를 지정하지만 사고 과정 태그는 대개 모델의 채팅 템플릿이 붙이는
// 것이라 지시로 완전히 통제되지 않는다 — LLM_MODEL도 설정으로 바뀐다.
// 그래서 '모르는 표기가 왔다'는 사실만은 반드시 소리가 나게 한다. 무엇을 지원해야 하는지
// (REASONING_TAGS에 무엇을 더해야 하는지) 알 수 있는 단서는 이 로그뿐이다.
//
// 마커 후보를 넓게 훑되 길이 상한을 둔다 — 태그 정규식과 같은 이유로 되돌아오는 폭을 상수로 묶어
// 전체를 선형으로 유지한다. 특수 토큰(<|…|>)과 일부 모델이 쓰는 ◁…▶ 형태까지 본다.
const MARKER_RE = () => new RegExp(
  `<\\|[^|<>]{0,${MAX_TAG_ATTR_LEN}}\\|>` +          // <|thinking|>, <|begin_of_thought|>
  `|◁[^◁▶]{0,${MAX_TAG_ATTR_LEN}}▶` +               // ◁think▶
  `|</?[A-Za-z][^<>{}]{0,${MAX_TAG_ATTR_LEN}}>`,    // <thoughts>, <analysis>
  'g');
// 마커 이름이 '생각'을 가리키는지 — 무관한 XML 태그(<b>, <br/>)까지 알리면 로그만 시끄러워진다.
const REASONING_WORD = /think|thought|reason|reflect|scratch|analysis|monologue/i;
// 이미 다루는 표기인지 (부분이 아니라 마커 전체가 우리 태그여야 한다)
const handledTagRe = () => new RegExp(
  `^</?(?:${REASONING_TAGS.join('|')})\\b[^<>{}]{0,${MAX_TAG_ATTR_LEN}}>$`, 'i');

// insideDecision(i): 그 위치가 파싱된 결정 JSON 안인지. 답변 본문이 태그를 '설명'하는 경우
// (이 파일이 지키려는 바로 그 상황)까지 경고하면 진짜 신호가 묻힌다.
//
// 물음의 위치는 오름차순으로만 온다(matchAll이 앞에서부터 훑는다) — insideDecision은 그 전제 위에
// 서 있는 커서라(insideDecisionChecker), 위치를 되돌려 물으면 답이 틀린다.
function warnUnknownReasoningMarkup(content, insideDecision) {
  const handled = handledTagRe();
  for (const m of content.matchAll(MARKER_RE())) {
    if (!REASONING_WORD.test(m[0]) || handled.test(m[0]) || insideDecision(m.index)) continue;
    warnOnce('llm',
      `unrecognized reasoning markup ${JSON.stringify(m[0])} — this model's reasoning block is not ` +
      `being separated from its decision, so a discarded draft can be executed. ` +
      `Add the tag name to REASONING_TAGS in llm-openai.js if this is a reasoning marker.`);
    return; // 한 종류만 알리면 충분하다 — 나머지는 그 표기를 지원한 뒤 다시 드러난다
  }
}

// '파싱된 결정 JSON 안인가'의 판정자. 마커 위치(matchAll)와 객체 span(scanCandidates)이 둘 다
// 오름차순이고 span은 서로 겹치지 않으므로, 커서 하나를 앞으로만 움직이며 함께 훑는다 —
// 전체 비용이 '마커 수 + 객체 수'로 유계다.
// 마커마다 목록을 처음부터 다시 보면(objects.some) 비용이 '마커 수 × 객체 수'라 정확히 이차다.
// 작은 결정 JSON마다 사고 과정 낱말이 든 미지의 마커가 하나씩 실린 응답('{"a":"<rethink>"}' 반복 —
// temperature=0의 토큰 반복 퇴화가 정확히 이런 모양을 만든다)에서 실측 256KB 211ms → 512KB 776ms
// → 1MB 2.8초, 크기 2배마다 4배. 응답 상한(MAX_UPSTREAM_JSON_BYTES, 8MB)까지 가면 분 단위가 되고,
// 그 시간은 동기 작업이라 동시에 처리 중인 모든 요청이 함께 멈춘다 — 후보 예산(MAX_UNMATCHED_*)과
// 태그 상한(MAX_TAG_ATTR_LEN)이 막는 것과 같은 종류의 실패가 경고 스캔 문으로 되살아난 것이다.
// 커서를 지나간 객체로 되돌리지 않아도 되는 이유: end < i인 객체는 이 위치에도, 그보다 뒤의
// 어떤 위치에도 답이 될 수 없다(마커 위치는 오름차순이다).
function insideDecisionChecker(objects) {
  let k = 0;
  return i => {
    while (k < objects.length && objects[k].end < i) k++;
    return k < objects.length && i > objects[k].start && i <= objects[k].end;
  };
}

// 후보와 태그를 함께 읽는 토큰. 후보는 '{' 다음이 (공백을 건너뛰어) '"'인 것만 본다 — 우리가 찾는
// 결정 객체는 반드시 키로 시작하므로, 산문 속 '{job_id'나 '{중괄호}'는 애초에 후보가 아니다.
// 정확도와 비용을 함께 줄인다. lastIndex를 공유하면 호출이 겹칠 때 서로의 탐색 위치를 밟으므로
// 호출마다 새로 만든다.
const tokenRe = () => {
  const name = `(?:${REASONING_TAGS.join('|')})`;
  const attr = `[^<>{}]{0,${MAX_TAG_ATTR_LEN}}`;
  return new RegExp(`<${name}\\b${attr}>|</${name}\\b${attr}>|\\{\\s*"`, 'gi');
};

// 예산은 '실패한 후보'에만 매긴다. 비싼 것은 짝 없는 '{"' 하나가 남은 텍스트를 끝까지 훑는 경우뿐이고
// (시작점 수 × 길이라 정확히 이차다), 파싱에 성공한 후보는 자기 길이만큼 텍스트를 소비하므로
// 전부 합쳐도 선형이다. 그래서 초안이 아무리 많아도 그것이 정상 JSON이면 예산을 쓰지 않는다.
//
// 구간마다 되돌리는 몫과, 되돌림과 무관한 전역 상한이 둘 다 필요하다:
//   구간 몫만 두면  → '</think>{"a' 가 1만 6천 번 반복된 응답에서 매 구간이 예산을 되돌려 받아
//                     짝 없는 후보가 매번 끝까지 훑는다. 실측 172KB 5.7초(크기 2배마다 4배).
//   전역 상한만 두면 → 앞의 시끄러운 사고 과정 하나가 상한을 다 먹어 뒤의 진짜 결정에 닿지 못한다.
//                     ②(닫는 태그만)는 Qwen3·R1 기본 템플릿의 기본값이라 드문 조합이 아니다.
// 그 시간은 동기 작업이라 그 요청만이 아니라 동시에 처리 중인 모든 요청이 함께 멈춘다.
const MAX_UNMATCHED_CANDIDATES = 100;  // 구간별 — 후보 수로 센다
const MAX_UNMATCHED_TOTAL = 500;       // 전역 — '훑은 횟수'로 센다 (parseCandidate 주석 참고)

// 파싱된 후보 목록. 각 후보에 사고 과정과의 관계를 함께 단다:
//   draft   — 여는 태그가 실제로 있는 블록 안(①③)이다. 초안이므로 어느 순위에도 넣지 않는다.
//   assumed — 닫는 태그만 온 구간(②) 안이다. "여는 태그가 프롬프트에 있었다"는 추정이라 틀릴 수 있다.
// 둘 다 아니면 사고 과정 밖이다.
function scanCandidates(text) {
  const objects = [];
  const re = tokenRe();
  let depth = 0, unmatched = 0, spent = 0;
  let pending = 0; // 아직 어느 구간에도 속하지 않은 객체의 시작 인덱스
  for (let m; (m = re.exec(text)); ) {
    const tok = m[0];
    if (tok[0] === '{') {
      if (unmatched >= MAX_UNMATCHED_CANDIDATES || spent >= MAX_UNMATCHED_TOTAL) continue;
      const parsed = parseCandidate(text, m.index);
      // spent는 '훑은 횟수'다 — 후보 하나가 두 번 훑었으면 두 번으로 센다 (parseCandidate 주석 참고).
      // unmatched(구간별)는 후보 수 그대로 센다: 그쪽은 비용이 아니라 '시끄러운 구간 하나가
      // 뒤의 진짜 결정을 가리지 않게' 하는 몫이고, 총 비용은 spent가 이미 묶는다.
      if (parsed.value === undefined) { unmatched++; spent += parsed.scans; continue; }
      objects.push({ value: parsed.value, draft: depth > 0, assumed: false, start: m.index, end: parsed.end });
      re.lastIndex = parsed.end + 1; // ⓐ 파싱된 객체 안의 태그는 answer 본문의 글자다
      continue;
    }
    const closing = tok[1] === '/';
    if (!closing) {
      // '<think/>' — 내용이 없는 빈 블록이다. 여는 태그로 세면 영영 닫히지 않아(③) 그 뒤 전부가
      // 사고 과정이 되고 그 응답의 결정이 통째로 버려진다. 모델이 이 표기를 한 번 쓰기 시작하면
      // 모든 질문이 같은 이유로 실패하는데, 화면에는 'LLM 호출 실패' 한 줄만 나가 원인이 보이지 않는다.
      if (!tok.endsWith('/>')) depth++;
      continue;
    }
    if (depth === 0) {
      // ② 여는 태그 없이 닫는 태그만 — 직전 구간 뒤부터 여기까지가 사고 과정이다.
      // 객체마다 한 번씩만 손댄다. 닫는 태그마다 목록 전체를 다시 훑으면 그 자체가 이차가 된다
      // (실측: '</think>{"d":i}' 5만 개에서 2.8초).
      for (let k = pending; k < objects.length; k++) objects[k].assumed = !objects[k].draft;
    } else if (--depth > 0) {
      continue; // ① 안쪽 태그는 바깥 블록을 닫지 않는다
    }
    pending = objects.length;
    unmatched = 0;
  }
  return objects;
}

// 모델이 결정을 한 겹 감싸 보내는 일이 있다({"decision":{"action":…}}). 그때 텍스트를 다시 훑는 대신
// 이미 파싱된 값의 안쪽만 본다 — 훑는 쪽은 문자열 안의 '{"'까지 후보로 세어 예시나 목록을 결정으로
// 오인할 수 있다. 깊이와 개수를 묶어 값이 아무리 커도 비용이 유계다.
function findDecision(value, answerOnly, depth = 0) {
  const decision = toDecision(value, answerOnly);
  if (decision || depth >= 2 || !value || typeof value !== 'object') return decision;
  for (const inner of Object.values(value).slice(0, 20)) {
    if (inner && typeof inner === 'object') {
      const found = findDecision(inner, answerOnly, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// 결정 형식 검증. 빈 answer는 결정으로 보지 않는다 — 화면에 빈 말풍선이 뜨고, 그 빈 턴이
// 다음 질문의 맥락으로 서버에 되돌아온다. 형식만 맞고 내용이 없는 응답은 실패로 처리하는 편이 낫다.
// answerOnly면 run_query를 결정으로 받지 않는다 — 강제 답변 단계(더 이상 조회할 수 없다)와
// 아래 2순위 채택(조회까지 맡기기에는 근거가 약하다)이 같은 판정을 쓴다.
//
// '빈 답변인가'를 여기서 재도 되는 것은 이스케이프 정규화(normalizeJsonEscapes)가 파싱 '전에'
// 끝났기 때문이다. 정규화 없이 재면 \f·\b로 시작하는 수식이 폼피드·백스페이스 한 글자가 되고,
// trim()이 그 문자를 공백으로 세어 멀쩡한 답변이 빈 답변으로 오판된다(퍼징으로 잡은 회귀).
function toDecision(d, answerOnly) {
  if (!d || typeof d !== 'object') return null;
  if (d.action === 'answer' && typeof d.answer === 'string' && d.answer.trim()) return d;
  // 검색 결정. text가 없거나 글자가 아니면 빼고 넘긴다 — 호출부(agent.js)가 현재 질문으로 대신한다.
  // targets는 그대로 넘긴다 — 정규화(모르는 값 버리기·비면 셋 다)는 결정 경계(llm.js sanitizeDecision)의 일이다.
  // answerOnly면 받지 않는다 — 강제 답변 단계에서는 더 찾아볼 수 없고, 2순위 채택(사고 과정 안의 초안)에서는
  // 초안 검색어로 검색을 태울 이유가 없다 (run_query와 같은 판정).
  if (!answerOnly && d.action === 'search') {
    const text = typeof d.text === 'string' && d.text.trim() ? d.text : undefined;
    return { action: 'search', ...(text && { text }), targets: d.targets, ...(d.drop !== undefined && { drop: d.drop }) };
  }
  // 본문 청구. ids가 목록이 아니거나 비어 있으면 결정이 아니다 — 청구할 것이 없는 청구다.
  // 형식·개수 확정은 결정 경계(llm.js sanitizeDecision)가 한다. answerOnly 판정은 search와 같다.
  if (!answerOnly && d.action === 'expand' && Array.isArray(d.ids) && d.ids.length) {
    return { action: 'expand', ids: d.ids, ...(d.drop !== undefined && { drop: d.drop }) };
  }
  if (!answerOnly && d.action === 'run_query' && typeof d.query_name === 'string' && d.query_name.trim()) {
    // target_db는 문자열일 때만 싣는다 — 크기 확정은 결정 경계(llm.js sanitizeDecision)가 한다.
    // 여기 일은 형식 검증이고, 없거나 형식이 아니면 '고르지 않음'으로 두면 된다:
    // 후보가 하나뿐인 쿼리는 그대로 실행되고, 여럿이면 실행 경계가 후보를 들고 되묻는다.
    const targetDb = typeof d.target_db === 'string' && d.target_db.trim() ? d.target_db : undefined;
    // params는 키-값 객체일 때만 싣고, 아니면(배열·문자열·숫자·null) '없음'으로 둔다. 결정 자체를
    // 버리지 않는 이유: 버리면 같은 프롬프트로 재시도해 같은 응답을 받고(temperature=0) 폴백으로
    // 끝나는데, 모델은 무엇이 틀렸는지 듣지 못한다. 빈 params로 실행 경계까지 보내면 바인드가 있는
    // 쿼리는 '값 없음'과 hint가 다음 프롬프트의 이력에 남아 모델이 형식을 고칠 기회가 생기고,
    // 바인드가 없는 쿼리는 그냥 실행된다 — 어느 쪽도 잡키('0','1')를 프롬프트에 싣지 않는다.
    const params = isPlainObject(d.params) ? d.params : {};
    return { action: 'run_query', query_name: d.query_name, params, ...(targetDb && { target_db: targetDb }) };
  }
  // 일괄 조회 — 항목마다 단일 조회와 같은 검증을 지나고, 형식이 아닌 항목은 버린다(결정 전체를 버리지 않는다:
  // 모델이 넷 중 하나를 잘못 적었다고 나머지 셋까지 다시 요청하게 할 이유가 없다). 남는 항목이 없으면 결정이 아니다.
  // 개수 상한은 결정 경계(llm.js sanitizeDecision)가 한 번 더 확정하지만 여기서도 자른다 — 형식 검증이 수백 항목을
  // 돌지 않게. answerOnly 판정은 run_query와 같다.
  if (!answerOnly && d.action === 'run_queries' && Array.isArray(d.queries)) {
    const items = d.queries.slice(0, MAX_BATCH_QUERIES)
      .map(q => (isPlainObject(q) ? toDecision({ ...q, action: 'run_query' }, false) : null))
      .filter(Boolean)
      .map(({ action, ...item }) => item);
    return items.length ? { action: 'run_queries', queries: items } : null;
  }
  return null;
}

function parseDecision(content, forceAnswer) {
  const objects = scanCandidates(content);

  // 모르는 표기가 왔다는 사실만은 소리 나게 한다 — 이 실패는 '정상 응답'처럼 보여 로그가 유일한
  // 단서다. 파싱된 객체 안의 마커는 답변 본문이 태그를 설명하는 것이므로 세지 않는다.
  // 객체 span은 서로 겹치지 않고 오름차순이다(성공하면 그 끝으로 건너뛰므로) — 판정은 그 성질을
  // 쓰는 커서 스캔이다. 마커마다 목록을 처음부터 다시 훑으면 이차가 된다(insideDecisionChecker 주석).
  warnUnknownReasoningMarkup(content, insideDecisionChecker(objects));

  // 1순위 = 사고 과정 밖. 2순위 = 추정 구간(②) 안 — 그 추정이 틀렸을 때(모델이 답변에 '</think>'를
  // 쓴 경우처럼) 제대로 답한 응답을 통째로 버리지 않기 위한 뒷문이다.
  // 2순위에서는 run_query를 받지 않는다. 손해가 양쪽으로 전혀 다르기 때문이다:
  //   answer    — 최악이라도 사용자가 덜 다듬어진 답변을 본다.
  //   run_query — 모델이 검토하다 접은 쿼리를 조회대상 DB에 실제로 실행하고, 그 결과가 다시
  //               최종 답변의 근거가 된다. 초안을 실행하는 것보다 결정을 못 찾는 편이 낫다.
  // 순위 안에서는 '처음' 유효한 결정을 채택한다 — 모델이 결정을 먼저 내고 뒤에 설명이나 예시를
  // 붙이는 쪽이 훨씬 흔하다. 마지막을 고르면 '예시 형식: {"action":"answer",…}' 한 줄이 진짜 결정을
  // 덮어써서, 실행돼야 할 쿼리가 실행되지 않고 예시 문자열이 답변으로 나간다.
  for (const [tier, answerOnly] of [
    [objects.filter(o => !o.draft && !o.assumed), forceAnswer],
    [objects.filter(o => o.assumed), true],
  ]) {
    for (const o of tier) {
      const decision = findDecision(o.value, answerOnly);
      if (decision) return decision;
    }
  }
  return null;
}
