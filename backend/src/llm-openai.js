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
  MAX_PROMPT_PARAMS_LEN, MAX_PROMPT_TOTAL_LEN, PROMPT_FLOORS,
  clipText, warnOnce,
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
    `[llm] invalid LLM_REASONING_EFFORT value, falling back to default (low): ` +
    `${JSON.stringify(process.env.LLM_REASONING_EFFORT)} (valid: ${REASONING_EFFORTS.join(', ')}, off)`
  );
  return 'low';
}

// 서버가 이 파라미터를 거부하면 프로세스 수명 동안 다시 보내지 않는다 —
// 지원하지 않는 엔드포인트에서 모든 질문이 실패하는 것보다, 한 번 배우고 빼는 편이 낫다.
let effortAccepted = REASONING_EFFORT !== null;

const SYSTEM_PROMPT = `당신은 사내 지식 관리 및 DB 조회 Q&A 에이전트다.
사용자 질문과 함께 관련 지식, Q&A 처리 방법, 실행 가능한 쿼리 목록, 지금까지의 쿼리 실행 이력이 주어진다.
반드시 아래 두 형식 중 하나의 JSON 객체 하나만으로 응답하라. 다른 텍스트를 붙이지 마라.
생각을 적어야 한다면 <think> 와 </think> 사이에만 적어라. 그 블록 밖에는 위 JSON 하나만 남긴다.

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
- 실행 이력의 오류 원문에 든 내부 정보(호스트·포트·접속 주소, 스키마·테이블·계정명, SQL 원문)는 answer에 옮겨 적지 마라. 오류는 "조회에 실패했다"는 사실과 사용자가 할 수 있는 다음 행동만 전달하라.
- answer는 markdown 형식으로 구조화하라: 조회 결과는 표(table)로, 항목 나열은 목록으로, 섹션 구분은 ### 제목으로 작성한다.
- 수식은 LaTeX로 쓴다. 문장 안에 넣는 인라인 수식은 $E=mc^2$ 또는 $$E=mc^2$$, 넓은 수식은 $$ 를 앞뒤로 각각 '독립된 줄'에 두어 별행으로 써라 — 인라인 수식은 접히지 않아 넓으면 잘린다. \\( \\) 와 \\[ \\] 표기도 그대로 인식되므로 익숙한 쪽을 쓰면 된다.
- 수식이 아닌 $ 기호(금액 $100, 환경변수 $ORACLE_HOME 등)는 이스케이프 없이 그냥 써라 — 화면에 그대로 나오고 수식으로 오인되지 않는다.
- answer는 JSON 문자열이므로 그 안의 백슬래시는 두 번 쓰는 것이 정확하다: "$$x=\\\\frac{1}{2}$$", "$$a \\\\times b$$". (한 번만 써도 대부분 복구하지만, 두 번 쓰면 복구에 기대지 않는다.)

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
        `[llm] no decision JSON found (attempt ${attempt + 1}/2): ` +
        `length=${content.length} firstChar=${JSON.stringify(content.trim()[0] ?? '')} ` +
        `hasBrace=${content.includes('{')} hasThinkTag=${/<\/?think\b/i.test(content)}`
      );
    } catch (e) {
      console.warn(`[llm] call failed (attempt ${attempt + 1}/2):`, e.message);
    }
  }
  // 상세 오류는 위 warn 로그에만 남긴다 — 사용자용 문구는 호출부가 만든다 (위 주석 참고).
  return null;
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
      console.warn('[llm] this endpoint does not support reasoning_effort — omitting it from future requests.');
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
// 개수·이름 길이에 상한을 둔다 — bindNames는 표시용 절단(MAX_PROMPT_SQL_LEN) 전의 SQL 원문
// (TEXT 64KB)을 파싱하므로, 이 목록이 이 줄에서 유일하게 유계가 아닌 부분이었다. 바인드 수백
// 개짜리 SQL 하나가 등록되면 '최소 1건 보장'을 타고 그 한 항목이 예산을 뚫는다.
// 정상 쿼리의 바인드는 한 자릿수다(llm.js MAX_DECISION_PARAMS와 같은 근거) — 20이면 개입하지 않는다.
const MAX_PROMPT_BIND_NAMES = 20;
const bindList = q => {
  const binds = bindNames(q.query_sql);
  const shown = binds.slice(0, MAX_PROMPT_BIND_NAMES).map(n => `:${clip(n, 100)}`).join(', ');
  const omitted = binds.length - Math.min(binds.length, MAX_PROMPT_BIND_NAMES);
  return `${shown || '없음'}${omitted ? ` 외 ${omitted}개` : ''}`;
};

const queryItem = q =>
  `- ${clip(q.query_name, 100)}: ${clip(q.query_desc)}` +
  ` / 입력(${clip(q.input_desc, 300)}) / 출력(${clip(q.output_desc, 300)})` +
  ` / 바인드(${bindList(q)})` +
  ` / SQL: ${clip(q.query_sql, MAX_PROMPT_SQL_LEN)}`;

// 예산이 모자랄 때 쓰는 짧은 형태 — 실행에 반드시 필요한 것만 남긴다.
//   이름   : 이것이 없으면 그 쿼리를 지목할 방법 자체가 없다
//   용도   : 어떤 질문에 쓰는 쿼리인지 고르는 근거
//   바인드 : 무엇을 채워야 하는지 (없으면 첫 실행이 반드시 '값 없음'으로 실패한다)
// 입출력 설명과 SQL 원문은 뺀다 — 있으면 좋지만, 없다고 그 쿼리를 못 쓰게 되지는 않는다.
const MAX_PROMPT_SHORT_DESC_LEN = 120;
const queryItemShort = q =>
  `- ${clip(q.query_name, 100)}: ${clip(q.query_desc, MAX_PROMPT_SHORT_DESC_LEN)} / 바인드(${bindList(q)})`;

// 짧은 형태로 실린 쿼리도 그대로 실행할 수 있다는 사실을 모델에게 알린다 —
// 이 안내가 없으면 모델은 설명이 얇은 항목을 '정보가 부족한 쿼리'로 읽고 후보에서 뺀다.
const shortFormNote = n =>
  `- (위 ${n}건은 길이 제한으로 이름·용도·바인드만 표시했다 — 그대로 실행할 수 있고,` +
  ` 지목하면 전체 정의가 다음 단계에 실린다)`;
const omittedNote = n => `- (이하 ${n}건은 프롬프트 길이 제한으로 생략)`;

// 위 안내 두 줄의 몫. 예산을 다 쓴 뒤에 안내를 덧붙이면 그만큼이 섹션 예산 밖으로 나가는데,
// 쿼리 목록은 '마지막에 배분받는' 섹션이라 그 초과를 흡수해 줄 뒤 섹션이 없다 —
// 전체 예산(MAX_PROMPT_TOTAL_LEN)을 그대로 넘어가고, 넘긴 만큼이 컨텍스트 한도를 밀어낸다.
// 두 줄의 길이는 건수 표기 말고는 고정이라 유계다 (건수는 MAX_PROMPT_QUERIES + MAX_STEPS 이하).
const NOTES_RESERVE = 200;

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
  // 줄마다 줄바꿈 한 칸을 함께 센다 — 배분(renderSections)이 그렇게 세므로 기준이 같아야 한다.
  // 이 섹션은 다른 섹션보다 줄 수가 훨씬 많아질 수 있어(모든 쿼리가 한 줄씩) 그 한 칸이 쌓인다.
  const cost = line => line.length + 1;
  const usable = Math.max(0, budget - NOTES_RESERVE);
  let used = 0;
  // ① 짧은 줄만이라도 최대한 많이 — 첫 항목은 예산과 무관하게 싣는다(renderItems와 같은 보장).
  let kept = 0;
  for (; kept < short.length; kept++) {
    if (kept > 0 && used + cost(short[kept]) > usable) break;
    used += cost(short[kept]);
  }
  // ② 남는 여유만큼 앞에서부터 자세한 줄로 승격. 여기서는 강제 보장을 두지 않는다 —
  //    ①이 이미 '모든 항목이 최소 한 줄'을 보장했으므로, 예산을 넘겨서까지 올릴 이유가 없다.
  const lines = [];
  let full = 0;
  for (; full < kept; full++) {
    const line = queryItem(queries[full]);
    const extra = line.length - short[full].length;
    if (used + extra > usable) break;
    used += extra;
    lines.push(line);
  }
  for (let i = full; i < kept; i++) lines.push(short[i]);
  if (full < kept) lines.push(shortFormNote(kept - full));
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
    const v = clipVal(v0);
    const len = JSON.stringify(k).length + (JSON.stringify(v) ?? 'null').length + 2; // ':' + ','
    if (kept.length > 0 && used + len > budget) break;
    kept.push([k, v]);
    used += len;
  }
  const omitted = cols.length - kept.length;
  if (omitted > 0 || upstream !== undefined) {
    const notes = [];
    if (omitted > 0) notes.push(`외 ${omitted}개 컬럼 생략 (프롬프트 길이 제한)`);
    if (upstream !== undefined) notes.push(String(clipVal(upstream)));
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
  const entries = Object.entries(params || {}).map(([k, v]) => [clip(k, 100), clipVal(v)]);
  return clip(JSON.stringify(Object.fromEntries(entries)), MAX_PROMPT_PARAMS_LEN);
}

// 표시용 값 절단 — params(위)와 컬럼 절단 행(fitCols)이 같은 규칙을 쓴다.
// 문자열은 셀 상한으로, 스칼라는 그대로(수 리터럴은 짧다), 구조는 직렬화해 같은 상한으로.
const clipVal = v =>
  typeof v === 'string' ? clip(v, MAX_CELL_LEN)
    : v === null || typeof v === 'number' || typeof v === 'boolean' ? v
      : clip(JSON.stringify(v) ?? String(v), MAX_CELL_LEN);

function historyLine(h) {
  const head = `- ${clip(h.query_name, 100)} params=${paramsJson(h.params)}`;
  if (h.note) {
    // 루프 가드가 남긴 제어용 기록 — 실패가 아니므로 '오류'로 알리지 않는다 (모델이 실패로 오해해 불필요한 우회를 하지 않게)
    return `${head} → 실행하지 않음: ${h.note}`;
  }
  if (h.error) {
    // 드라이버 오류 원문은 길 수 있다 — 항목 상한을 여기에도 건다.
    // hint는 모델 전용 복구 지침이다 — 사용자 trace에는 나가지 않으므로 여기서만 붙인다 (constants.safeError 참고).
    return `${head} → 오류: ${clip(h.error)}${h.hint ? ` / 대응: ${clip(h.hint)}` : ''}`;
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
    queries: budget => renderQueries(ctx.queries, budget),
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

function normalizeJsonEscapes(text) {
  let out = '', inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inStr) { if (c === '"') inStr = true; out += c; continue; }
    if (c === '"') { inStr = false; out += c; continue; }
    if (c < ' ') { out += escapeControl(c); continue; }
    if (c !== '\\') { out += c; continue; }
    const n = text[i + 1];
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
const MAX_UNMATCHED_CANDIDATES = 100;
const MAX_UNMATCHED_TOTAL = 500;

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
      const end = matchingBrace(text, m.index);
      let value;
      if (end > 0) {
        // 이스케이프 정규화를 거쳐 파싱한다 — LaTeX를 한 번만 이스케이프한 응답도 여기서 살아난다.
        try { value = JSON.parse(normalizeJsonEscapes(text.slice(m.index, end + 1))); } catch { /* JSON이 아닌 중괄호 덩어리 */ }
      }
      if (value === undefined) { unmatched++; spent++; continue; }
      objects.push({ value, draft: depth > 0, assumed: false, start: m.index, end });
      re.lastIndex = end + 1; // ⓐ 파싱된 객체 안의 태그는 answer 본문의 글자다
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
  if (!answerOnly && d.action === 'run_query' && typeof d.query_name === 'string' && d.query_name.trim()) {
    return { action: 'run_query', query_name: d.query_name, params: d.params || {} };
  }
  return null;
}

function parseDecision(content, forceAnswer) {
  const objects = scanCandidates(content);

  // 모르는 표기가 왔다는 사실만은 소리 나게 한다 — 이 실패는 '정상 응답'처럼 보여 로그가 유일한
  // 단서다. 파싱된 객체 안의 마커는 답변 본문이 태그를 설명하는 것이므로 세지 않는다.
  // 객체 span은 서로 겹치지 않는다(성공하면 그 끝으로 건너뛰므로) — 그래서 그냥 훑으면 된다.
  warnUnknownReasoningMarkup(content, i => objects.some(o => i > o.start && i <= o.end));

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
