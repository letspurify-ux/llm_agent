// LLM 인터페이스 + provider 선택.
//
// 인터페이스는 함수 시그니처 하나가 전부다:
//   decide(ctx) → Promise<{action:'answer', answer}
//                        |{action:'run_query', query_name, params}>
//   ctx = {question, chat[], knowledge[], qaMethods[], queries[], history[], forceAnswer?}
//
// LLM_PROVIDER=openai 이면 vLLM/OpenRouter(OpenAI 호환 API), 아니면 규칙 기반 Mock.
// agent.js는 provider가 바뀌어도 변경되지 않는다.
import { openaiDecide } from './llm-openai.js';
import { bindNames } from './sql.js';
import { MAX_ROWS, TRUNC_MARK, MAX_BIND_LEN, MAX_ANSWER_LEN, clipText, nameKey, ownProp, warnOnce } from './constants.js';
import { rowCounts } from './result.js';

// LLM provider 선택의 단일 해석 지점.
// 정확한 문자열 일치만 보면 'OpenAI'·'openai '(뒤 공백)·'vllm'·'openrouter' 같은 값이 전부
// 조용히 Mock으로 떨어진다. 그런데 Mock도 지식과 조회 표를 그럴듯하게 렌더하므로 답변만 봐서는
// 구분되지 않고, 기동 배너는 원본 값을 그대로 찍어 'LLM=OpenAI'라고 알리며, server.js의
// 접속정보 누락 검사도 같은 비교를 쓰던 탓에 함께 비켜갔다 — 세 곳이 같은 오타에 함께 속았다.
// 그래서 해석을 여기 하나로 모으고, 모르는 값은 반드시 소리가 나게 한다
// (numEnv·LLM_REASONING_EFFORT가 잘못된 값에 경고를 남기는 것과 같은 기준이다).
// 값은 호출 시점에 읽는다 — 모듈 로드 시점에 굳히면 테스트가 실행 중에 바꾸는 경로가 깨진다.
const PROVIDERS = ['openai', 'mock'];

export function llmProvider() {
  const raw = process.env.LLM_PROVIDER;
  if (raw === undefined || String(raw).trim() === '') return 'mock';
  const v = nameKey(raw);                       // 앞뒤 공백·대소문자는 흡수한다
  if (PROVIDERS.includes(v)) return v;
  warnOnce('setup', `unknown LLM_PROVIDER ${JSON.stringify(raw)} — every answer will come from the rule-based mock (valid: ${PROVIDERS.join(', ')}). Check backend/.env.`);
  return 'mock';
}

export const llm = {
  async decide(ctx) {
    const d = await (llmProvider() === 'openai' ? openaiDecide(ctx) : mockDecide(ctx));
    return sanitizeDecision(d);
  },
};

// 실제 쿼리의 바인드 수는 한 자릿수다 — 이보다 많은 params는 퇴화한 응답이고,
// 초과분을 실어 나르면 history·chat_log·프롬프트가 함께 부푼다.
const MAX_DECISION_PARAMS = 20;

// 바인드명 상한은 Oracle 식별자 최대 길이(12.2+ 기준 128자)로 잡는다 — 그보다 짧게 자르면
// 101~128자짜리 '적법한' 바인드명이 실행 단계에서 매칭되지 않아 반드시 '값 없음'으로 실패한다.
const MAX_PARAM_NAME_LEN = 128;

// 상한을 넘겨 자른 답변에 붙이는 표시. 사용자에게 그대로 보이는 문구다 —
// 조용히 자르면 끊긴 문장을 답변의 끝으로 읽는다 (프롬프트의 TRUNC_MARK와 같은 이유).
const ANSWER_TRUNC_NOTE = '\n\n*(답변이 너무 길어 이후 내용을 생략했습니다.)*';

// LLM 결정이 시스템에 들어오는 유일한 경계 — 여기서 크기를 확정한다. (테스트에서 쓰므로 export)
// Oracle 값을 드라이버 경계(oracle.js normalizeValue)에서 한 번에 정규화하는 것과 같은 이유다:
// query_name과 params는 이대로 history에 기록되어 프롬프트·chat_log·화면 trace 세 곳으로
// 흘러가는데, 하류마다 각자 자르게 두면 한 곳만 빠져도 30KB짜리 값 하나가 프롬프트 예산을 뚫어
// 그 요청의 남은 모든 LLM 호출이 컨텍스트 초과로 실패한다.
// 잘린 문자열에는 TRUNC_MARK를 붙인다 — 바인드 가드(oracle.js bindProblem)가 실행 전에 거부해,
// 조용히 잘린 값으로 조회해 0건 오답을 만드는 대신 소리 나게 실패한다. 정당한 바인드 값의
// 출처(질문·조회 결과 셀)는 전부 MAX_BIND_LEN 안이므로 이 절단이 정상 값을 건드리는 일은 없다.
export function sanitizeDecision(d) {
  if (!d) return d;
  // answer도 여기서 크기를 확정한다 (constants.MAX_ANSWER_LEN 주석 참고).
  // 상한을 요청의 max_tokens가 아니라 여기에 두는 이유: 완성을 토큰 수로 끊으면 JSON이 중간에서
  // 잘려 파싱 자체가 실패하고, 그 스텝의 결정이 통째로 버려진다 — 자를 곳은 파싱이 끝난 뒤다.
  if (d.action === 'answer') {
    const answer = String(d.answer ?? '');
    return answer.length > MAX_ANSWER_LEN
      ? { ...d, answer: clipText(answer, MAX_ANSWER_LEN) + ANSWER_TRUNC_NOTE }
      : d;
  }
  if (d.action !== 'run_query') return d;
  const clipVal = v => {
    if (typeof v === 'string') return v.length > MAX_BIND_LEN ? clipText(v, MAX_BIND_LEN) + TRUNC_MARK : v;
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    // 구조(객체·배열)는 bindProblem이 어차피 거부한다 — 거대한 구조만 문자열로 확정해 크기를 묶는다
    const s = JSON.stringify(v) ?? String(v);
    return s.length > MAX_BIND_LEN ? clipText(s, MAX_BIND_LEN) + TRUNC_MARK : v;
  };
  // Object.fromEntries로 다시 조립한다 — params[k] = v 대입은 '__proto__' 키에서 조용히 사라진다.
  // 이름을 자를 때는 겹침까지 확인한다: 앞부분이 같은 두 이름이 같은 키로 뭉개지면 fromEntries가
  // 나중 것만 남겨 다른 바인드의 값이 통째로 사라지고, 그 바인드는 실행 단계에서 '값 없음'으로
  // 실패한다 — 크기를 확정해야 할 경계가 데이터를 버리는 셈이다. 겹치면 순번을 붙여 구분한다
  // (원본 params는 객체이므로 키가 이미 유일하다 — 겹침은 오직 절단에서만 생긴다).
  const seenNames = new Set();
  const params = Object.fromEntries(
    Object.entries(d.params || {})
      .slice(0, MAX_DECISION_PARAMS)
      .map(([k0, v]) => {
        const base = k0.length > MAX_PARAM_NAME_LEN ? clipText(k0, MAX_PARAM_NAME_LEN) : k0;
        let k = base;
        for (let i = 2; seenNames.has(k); i++) k = `${base}~${i}`;
        seenNames.add(k);
        return [k, clipVal(v)];
      })
  );
  // trim: 이름 앞뒤 공백은 등록 철자와의 비교(agent.js resolveQuery)를 어긋내는 것 외에 아무 역할이 없다
  return { action: 'run_query', query_name: clipText(String(d.query_name).trim(), 200), params };
}

// ===== MockLLM: 규칙 기반 구현 (개발용) =====

async function mockDecide(ctx) {
  const { qaMethods, queries, history, forceAnswer } = ctx;

  // 쿼리 실행 중 에러가 났으면 더 진행하지 않고 답변으로 전환 (에러 내용 포함)
  const hasError = history.some(h => h.error);

  if (!forceAnswer && !hasError) {
    // 매칭된 qa_method 본문에 등장하는 순서대로 실행할 쿼리 계획 도출
    const planned = plannedQueries(qaMethods, queries);
    for (const q of planned) {
      // 이름 비교는 nameKey로 한다 — query_registry가 대소문자를 구분하지 않으므로
      // ===로 보면 철자만 다른 같은 쿼리를 '아직 실행 안 함'으로 읽고 매 스텝 다시 제안한다.
      if (history.some(h => nameKey(h.query_name) === nameKey(q.query_name) && h.rows)) continue;
      const params = fillParams(q, ctx);
      if (params) return { action: 'run_query', query_name: q.query_name, params };
      // 바인드 값을 채울 수 없는 쿼리는 건너뛴다 (이 질문과 무관한 쿼리로 간주)
    }
  }
  // 조립할 것이 없으면 Mock은 '일반 지식이 없다'고 안내한다 — 실제 LLM 폴백은 다른 문구를 쓰므로
  // 그 판단은 renderAnswer가 아니라 각 호출부가 한다 (renderAnswer 주석 참고).
  return { action: 'answer', answer: renderAnswer(ctx) ?? MOCK_NO_KNOWLEDGE };
}

const MOCK_NO_KNOWLEDGE =
  '*등록된 지식에 없는 내용이라 일반 지식으로 답변합니다.*\n\n' +
  '(Mock LLM은 일반 지식이 없습니다 — 실제 LLM(vLLM/OpenRouter) 연결 시 이 자리에 모델의 기본 지식 답변이 표시됩니다.)';

function plannedQueries(qaMethods, queries) {
  const planned = [];
  for (const m of qaMethods) {
    // 본문의 표기와 등록 철자가 대소문자만 다를 수 있으므로 양쪽을 같은 기준으로 낮춰 찾는다
    const method = m.method.toLowerCase();
    const found = queries
      .map(q => ({ q, pos: method.indexOf(nameKey(q.query_name)) }))
      .filter(x => x.pos >= 0)
      .sort((a, b) => a.pos - b.pos);
    for (const { q } of found) {
      if (!planned.includes(q)) planned.push(q);
    }
  }
  return planned;
}

// mock 전용 하드코딩 규칙 — 실제 LLM은 질문 문맥에서 스스로 값을 추출한다.
//
// 규칙이 좁으면 '값을 못 뽑는다'로 끝나지 않는다는 점이 중요하다. 아래 fillParams가 현재 질문에서
// 못 뽑으면 이전 질문으로 넘어가 거기서 뽑으므로, 대상만 바꿔 묻는 후속 질문이 직전 대상의
// 결과로 답변된다 — "홍길동 고객 주문 상태 알려줘" 다음 "그럼 김철수는?"이 홍길동의 주문 표를
// 붙여 답하고 있었다(실측). 조회는 성공하고 오류도 없어서 사용자도 chat_log도 그것이 다른
// 사람의 답이라는 사실을 알 방법이 없다 — 이 코드베이스가 가장 나쁜 실패로 보는 형태다.
// 그래서 '이름 + 조사'라는 한국어 후속 질문의 기본형까지 규칙에 넣는다.
//
// 넓혀서 엉뚱한 명사가 잡히는 쪽은 감수한다: 그 경우 조회가 0건이 되어 "결과가 없습니다"로
// 화면에 드러나므로, 조용한 오답 대신 소리 나는 빈 결과가 된다.
// (?<![가-힣])와 (?![가-힣])는 조사처럼 보이는 글자가 낱말 가운데에 걸리지 않게 경계를 잡는다.
const CUSTOMER_NAME_RE =
  /([가-힣]{2,4})\s*(?:고객|님)|(?<![가-힣])([가-힣]{2,4})(?:은|는|이|가|의)(?![가-힣])/;

const PARAM_RULES = {
  job_id: q => (q.match(/\b[A-Z]{2,}\d+\b/) || [])[0],
  // 대안이 둘이라 캡처 그룹도 둘이다 — 먼저 맞은 쪽을 쓴다('홍길동 고객' / '김철수는').
  customer_name: q => { const m = q.match(CUSTOMER_NAME_RE); return m ? (m[1] ?? m[2]) : undefined; },
};

// 바인드 값 채우기: ① 이전 쿼리 결과의 컬럼명 매칭(대소문자 무시) → multi-step 연결
//                  ② 현재 질문 → 최근 질문 순으로 정규식 추출 (후속 질문 대응)
//                  ③ 따옴표 문자열 fallback. 하나라도 못 채우면 null.
function fillParams(registryRow, ctx) {
  // 대입(params[name] = v)이 아니라 entries로 모은다 — '__proto__' 바인드명은 대입 시
  // setter를 타고 조용히 사라져, 채웠다고 믿은 값이 실행 단계에서 '값 없음'으로 실패한다.
  const entries = [];
  // 현재 질문을 먼저 본다 — 이전 질문의 오래된 값이 현재 대상을 덮어쓰지 않도록.
  const texts = [ctx.question, ...(ctx.chat || []).filter(m => m.role === 'user').map(m => m.text).reverse()];

  for (const name of bindNames(registryRow.query_sql)) {
    let value = valueFromHistory(name, ctx.history);
    // 소유 키만 본다 (constants.ownProp) — 바인드명이 '__proto__' 같은 프로토타입 멤버와 겹치면
    // 함수가 아닌 값을 호출하다 결정 루프 전체가 죽는다 (oracle.js mockResult와 같은 이유·같은 방식).
    const rule = ownProp(PARAM_RULES, name);
    if (value === undefined && rule) {
      for (const t of texts) {
        value = rule(t);
        if (value !== undefined) break;
      }
    }
    if (value === undefined) value = (ctx.question.match(/["']([^"']+)["']/) || [])[1];
    if (value === undefined) return null;
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

function valueFromHistory(name, history) {
  for (let i = history.length - 1; i >= 0; i--) {
    for (const row of history[i].rows || []) {
      for (const [col, val] of Object.entries(row)) {
        // capRows가 자른 값은 원본이 아니므로 바인드 값으로 쓰지 않는다
        if (typeof val === 'string' && val.endsWith(TRUNC_MARK)) continue;
        // NULL 컬럼도 '값을 못 찾았다'로 다룬다 — 그대로 돌려주면 undefined가 아니라는 이유로
        // 아래 fillParams가 질문·따옴표 fallback을 건너뛰고 params를 null로 확정하는데,
        // 그 null은 runQuery의 bindProblem이 '값 없음'으로 반드시 실패시킨다.
        // 실패가 확정된 쿼리를 제안하느라 스텝 하나와 왕복 한 번을 버리는 셈이다.
        if (val === null || val === undefined) continue;
        if (col.toLowerCase() === name.toLowerCase()) return val;
      }
    }
  }
  return undefined;
}

// 답변 조립 (markdown 형식): 쿼리 실행 결과 요약 + 관련 지식 첨부.
//
// 두 곳이 쓴다: Mock provider의 답변이자, 실제 LLM이 끝내 결정을 내지 못했을 때 agent.js가 쓰는
// 폴백이다. 조회에 성공해놓고 'LLM 호출 실패' 한 줄만 내보내면 그 요청이 실제로 한 일이 통째로
// 사라지는데, 손에 든 행과 지식으로 답을 만드는 방법은 이미 여기 있다.
// 조립할 것이 하나도 없으면 null을 돌려주고 무엇을 안내할지는 호출부가 정한다 —
// Mock은 '일반 지식 없음', agent 폴백은 'LLM 호출 실패'로 서로 다른 말을 해야 한다.
export function renderAnswer({ knowledge, history }) {
  const parts = [];
  for (const h of history) {
    if (h.error) {
      // 이 답변은 사용자에게 그대로 나간다 — 드라이버·DB 원문은 스키마명·호스트를 담고 있으므로
      // 화면 trace(server.js)와 같은 기준을 적용한다: 우리가 문구를 만든 오류(h.safe)만 원문으로.
      parts.push(`**${h.query_name}** 실행 오류: ${h.safe ? h.error : '조회 중 오류가 발생했습니다.'}`);
    } else if (h.rows?.length) {
      // 건수 해석은 rowCounts 한 곳에서만 한다 — 프롬프트(llm-openai.js)·화면 trace(server.js)가
      // 같은 기록을 각자 렌더하므로, 해석이 갈리면 사용자와 모델이 다른 건수를 보게 된다.
      const { rows, totalRows, omitted, capped } = rowCounts(h);
      const note = capped
        ? `\n\n_외 ${omitted}건 이상 생략 (조회 상한 ${MAX_ROWS}건 도달 — 실제는 더 많을 수 있음)_`
        : omitted > 0 ? `\n\n_외 ${omitted}건 생략 (총 ${totalRows}건)_` : '';
      parts.push(`### ${h.query_name} 조회 결과\n\n${rowsToMarkdownTable(rows)}${note}`);
    } else if (h.rows) {
      parts.push(`**${h.query_name}** 조회 결과가 없습니다.`);
    }
  }
  // 지식 첨부 규칙: 쿼리를 실행하지 않았으면 항상, 실행했으면 결과 값이 지식 내용에
  // 등장할 때만 첨부한다 (예: STATUS=FAILED ↔ "FAILED 상태이면 …" 지식).
  // 짧은 값은 매칭에서 뺀다 — ''는 모든 문자열에 포함되고(항상 참), 한 글자 값('Y', 등급 'A',
  // 상태코드 '1')은 어지간한 한국어 본문에 다 들어 있어 무관한 지식이 딸려온다.
  const MIN_MATCH_LEN = 2;
  // 기준은 "쿼리를 실행했는가"가 아니라 "조회가 성공했는가"다.
  //   조회가 전부 실패했으면(에러만 있음) 첨부한다 — 손에 든 지식 대신 드라이버 오류 문구만 남으면 안 된다.
  //   조회가 성공했으면 0건이어도 값 일치를 요구한다 — 여기서 무조건 첨부하면
  //   "BATCH999는 없습니다" 뒤에 존재하지도 않는 작업의 재시작 절차가 확신에 차서 붙는다.
  // (h.rows는 성공 시 빈 배열이라도 존재하므로 length가 아니라 유무로 판정한다)
  const querySucceeded = history.some(h => h.rows);
  // 비교할 셀 값 집합을 지식 루프 '밖에서' 한 번만 만든다. 지식마다 이력을 다시 훑으면
  // (지식 20건 × 행 20개 × 컬럼 30개 = 12,000회) 매번 최대 64KB짜리 TEXT 본문을 스캔하며
  // 그동안 이벤트 루프가 통째로 막힌다 — find는 '맞는 지식이 없을 때'(가장 흔한 경우)
  // 언제나 전액을 지불하므로 최악이 곧 평상시다. 값은 많아야 수백 개이고 전부 짧다(MAX_CELL_LEN).
  const cellValues = querySucceeded
    ? [...new Set(history.flatMap(h => (h.rows || []).flatMap(row =>
        Object.values(row).map(v => String(v ?? '')).filter(s => s.length >= MIN_MATCH_LEN))))]
    : null;
  const attach = knowledge.find(k => !cellValues || cellValues.some(s => k.content.includes(s)));
  if (attach) {
    parts.push(`### 관련 지식: ${attach.title}\n\n${attach.content}`);
  }
  return parts.length ? parts.join('\n\n') : null;
}

// 셀 값에 든 '|'와 개행은 표 문법 그 자체다 — 그대로 흘리면 remark-gfm가 컬럼 수를 잘못 세어
// 그 행부터 값이 밀리거나(파이프), 표가 중간에 끊기고 나머지가 본문으로 렌더된다(개행).
// 역슬래시를 '먼저' 이스케이프해야 한다: 나중에 하면 'C:\|share'가 'C:\\|share'가 되어
// GFM이 '\\'를 역슬래시 한 글자로 읽고 그 뒤 '|'를 살아 있는 구분자로 처리한다 (막으려던 그 오정렬).
const cell = v => String(v ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/\|/g, '\\|')
  .replace(/\r?\n/g, ' ');

// 컬럼은 모든 행의 합집합으로 잡는다(등장 순서 유지). 첫 행만 보면 뒤 행에만 있는 컬럼의 값이
// 표에서 조용히 사라진다 — 드라이버가 주는 행은 보통 동종이지만, 값이 사라지는 실패는 오류를
// 남기지 않아 답변을 읽는 쪽에서 확인할 방법이 없다. 없는 컬럼은 빈 칸으로 채운다.
function rowsToMarkdownTable(rows) {
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  return [
    `| ${cols.map(cell).join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${cols.map(c => cell(r[c])).join(' | ')} |`),
  ].join('\n');
}
