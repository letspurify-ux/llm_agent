// Agent 처리 루프 — 시스템의 핵심 제어 흐름.
// 질문 → 지식/처리방법 검색 → LLM 결정 루프(답변 또는 쿼리 실행) → 최종 답변.
// 루프의 유일한 상태는 history 배열이며, 매 반복 전체 컨텍스트를 LLM에 전달한다.
// 대화 맥락(chat)은 서버가 저장하지 않고 클라이언트가 매 요청에 실어 보낸다 (stateless 유지).
import { searchKnowledge, searchQaMethods, searchQueries } from './search.js';
import { loadQueryRegistry, countQueries, loadQueriesByNames } from './db.js';
import { runQuery } from './oracle.js';
import { bindNames } from './sql.js';
import { llm } from './llm.js';
import { MAX_RESULT_ROWS, MAX_CHAT_TURNS, MAX_CHAT_LEN } from './constants.js';

const MAX_STEPS = 5;
const MAX_PROMPT_QUERIES = 30; // 프롬프트에 싣는 쿼리 상한 (~2.2k토큰)
const MAX_SAME_QUERY_TRIES = 2; // 같은 쿼리·파라미터의 최대 실행 시도 (1회 실패는 일시 오류일 수 있어 재시도 허용)
const MAX_GUARD_HITS = 2;       // 루프 가드가 반복해서 걸리면 남은 스텝을 포기하고 강제 답변으로 간다.
                                // (첫 1회는 LLM이 경로를 수정할 기회, 그래도 반복하면 LLM 왕복만 낭비된다)

// 셀 길이 제한은 드라이버 경계(oracle.js)에서 이미 적용됐다 — 여기서는 행 수만 줄인다.
const capRows = rows => rows.slice(0, MAX_RESULT_ROWS);

// 쿼리 이름 비교 키. query_registry 조회는 MariaDB 기본 collation(대소문자·후행 공백 무시)이라
// JS의 ===로 비교하면 'BATCH_JOB_STATUS'와 'batch_job_status'가 서로 다른 쿼리로 보여
// 아래 반복 실행 가드가 통째로 무력화된다 (같은 쿼리가 매 스텝 재실행된다).
const nameKey = s => String(s ?? '').trim().toLowerCase();

// 동일 실행 판정용 파라미터 키 — LLM이 준 원본이 아니라 "실제로 바인드되는 값"으로 만든다.
// runQuery가 SQL의 바인드 변수만 추려 쓰므로, 여분 키 하나가 붙었다고 다른 실행이 되지는 않는다.
// 값은 문자열로 정규화한다 (숫자 1과 문자열 '1'은 같은 컬럼에 같은 값으로 바인드된다).
function paramKey(registryRow, params) {
  const entries = registryRow
    ? bindNames(registryRow.query_sql).map(n => [n, params?.[n]])
    : Object.entries(params || {});
  return JSON.stringify(
    entries
      .map(([k, v]) => [k, v === undefined ? ['undefined'] : v === null ? ['null'] : String(v)])
      // 키 문자열로 명시 비교한다 — 비교 함수 없는 sort는 [k,v]를 이어붙인 문자열을 기준으로 삼아
      // 키에 쉼표가 들어가면 순서가 입력 순서에 좌우된다.
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  );
}

// 클라이언트가 보낸 대화 이력을 신뢰하지 않고 형식을 검증·제한한다.
function normalizeChat(chat) {
  if (!Array.isArray(chat)) return [];
  return chat
    .filter(m => m && typeof m.text === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .slice(-MAX_CHAT_TURNS)
    .map(m => ({ role: m.role, text: m.text.slice(0, MAX_CHAT_LEN) }));
}

export async function handleQuestion(question, rawChat = []) {
  const chat = normalizeChat(rawChat);

  const [k0, m0] = await Promise.all([
    searchKnowledge(question),
    searchQaMethods(question),
  ]);
  let knowledge = k0;
  let qaMethods = m0;

  // "그럼 김철수는?" 같은 후속 질문은 그 문장만으로는 검색되지 않는다.
  // 현재 질문으로 아무것도 못 찾았을 때만 직전 질문을 덧붙여 재검색한다
  // (평소에는 현재 질문만 쓰므로 검색 정확도가 떨어지지 않는다).
  if (!knowledge.length && !qaMethods.length && chat.length) {
    const prevQuestions = chat.filter(m => m.role === 'user').slice(-2).map(m => m.text).join(' ');
    if (prevQuestions) {
      [knowledge, qaMethods] = await Promise.all([
        searchKnowledge(`${prevQuestions} ${question}`),
        searchQaMethods(`${prevQuestions} ${question}`),
      ]);
    }
  }

  const { list: queries, routed } = await selectQueries(qaMethods, question);

  // 검색 적중 수 — chat_log 분석용: 검색 0건(지식/쿼리 신규 등록 필요)과
  // 적중은 했지만 답이 부실한 경우(내용 보강 필요)를 구분할 수 있게 한다.
  // queries는 라우팅이 동작할 때(등록 30건 초과)만 적중 수이고, 전체를 싣는 소규모에서는 null (적중 개념 없음).
  const search = {
    knowledge: knowledge.length,
    qaMethods: qaMethods.length,
    queries: routed ? queries.length : null,
  };

  const history = [];
  const ctx = () => ({ question, chat, knowledge, qaMethods, queries, history });
  const resolveCache = new Map(); // 프롬프트 목록 밖 이름의 해석 결과 (미등록도 캐시한다)
  let guardHits = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const decision = await llm.decide(ctx());
    if (decision.action === 'answer') {
      return { answer: decision.answer, trace: history, search };
    }

    const { row: registryRow, error: resolveError } =
      await resolveQuery(decision.query_name, queries, resolveCache);
    // 이력에는 항상 정규 이름(등록된 철자)을 남긴다 — 가드와 프롬프트가 같은 이름을 보게.
    const canonicalName = registryRow?.query_name ?? decision.query_name;
    const key = paramKey(registryRow, decision.params);
    const isSame = h => nameKey(h.query_name) === nameKey(canonicalName) && paramKey(registryRow, h.params) === key;
    // note는 LLM에게 경로를 바꾸라고 알리는 제어용 기록이다. 실제 쿼리 실패(error)와 필드를 나눈다 —
    // 같은 필드에 넣으면 사용자 trace 패널과 chat_log의 '실패한 질문' 집계에 정상 턴이 섞인다.
    const push = (field, msg) => history.push({ query_name: canonicalName, params: decision.params, [field]: msg });

    // 같은 쿼리를 같은 파라미터로 반복하지 않는다 — 퇴화한 LLM 응답이 결정 루프를
    // 제자리 돌며 스텝과 Oracle 조회를 소진하는 것 방지. 미등록 이름의 반복도 같은 가드로 걸리도록
    // '등록되지 않은 쿼리' 처리보다 앞에 둔다 (가장 흔한 퇴화 패턴이 그것이다).
    if (history.some(h => h.rows && isSame(h))) {
      push('note', '이미 같은 파라미터로 실행된 쿼리 — 실행 이력의 결과로 답변하거나 다른 쿼리를 선택하라');
      if (++guardHits >= MAX_GUARD_HITS) break;
      continue;
    }
    // 실패도 무한 반복은 막는다 (결정적 오류면 타임아웃 대기가 스텝 수만큼 쌓인다)
    if (history.filter(h => h.error && isSame(h)).length >= MAX_SAME_QUERY_TRIES) {
      push('note', '같은 파라미터로 반복 실패한 쿼리 — 다른 쿼리를 선택하거나 지금까지의 정보로 답변하라');
      if (++guardHits >= MAX_GUARD_HITS) break;
      continue;
    }
    if (!registryRow) {
      push('error', resolveError ?? '등록되지 않은 쿼리');
      continue;
    }
    try {
      const { rows, totalRows, capped } = await runQuery(registryRow, decision.params);
      history.push({ query_name: canonicalName, params: decision.params, rows: capRows(rows), totalRows, capped });
    } catch (e) {
      // 실패도 이력에 남기고 루프를 계속한다 — LLM이 에러를 보고 재시도/우회/답변을 판단
      push('error', e.message);
    }
  }

  // 안전장치: MAX_STEPS 초과(또는 가드 반복) 시 강제 답변
  const final = await llm.decide({ ...ctx(), forceAnswer: true });
  return { answer: final.answer, trace: history, search };
}

// 결정된 query_name → query_registry 행. 프롬프트 목록은 MAX_PROMPT_QUERIES로 잘릴 수 있으므로
// (지식·처리방법 본문이 지목한 쿼리가 라우팅에서 빠질 수 있다) 목록에 없으면 이름으로 재확인한다.
// 결과는 요청 단위로 캐시한다 — 미등록 이름을 LLM이 반복해도 관리 DB를 매 스텝 왕복하지 않도록.
// 조회 실패는 캐시하지 않고 오류로 돌려준다 (요청 전체를 500으로 버리지 않고 이 스텝만 실패 처리).
async function resolveQuery(name, queries, cache) {
  const key = nameKey(name);
  if (!key) return { row: null };
  const hit = queries.find(q => nameKey(q.query_name) === key);
  if (hit) return { row: hit };
  if (cache.has(key)) return { row: cache.get(key) };
  try {
    const [row = null] = await loadQueriesByNames([name]);
    cache.set(key, row);
    return { row };
  } catch (e) {
    console.warn('[agent] query_registry 재조회 실패:', e.message);
    return { row: null, error: `쿼리 조회 실패: ${e.message}` };
  }
}

// 프롬프트에 실을 쿼리 선정. 등록 수가 적으면 전체(가장 정확), 많으면 두 경로의 합집합:
//   경로A: 매칭된 qa_method 본문이 지목한 query_name (다단계 절차 보장)
//   경로B: 질문으로 query_registry 자체를 하이브리드 검색 — qa_method 등록 없는 쿼리도 찾는다
// 반환: { list, routed } — routed=false면 전체를 실은 것이므로 '적중 수' 개념이 없다.
async function selectQueries(qaMethods, question) {
  if (await countQueries() <= MAX_PROMPT_QUERIES) return { list: await loadQueryRegistry(), routed: false };

  const mentioned = [...new Set(
    qaMethods.flatMap(m => m.method.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [])
  )];
  const [named, direct] = await Promise.all([
    loadQueriesByNames(mentioned),   // query_name이 아닌 토큰은 IN 절에서 자연히 걸러진다
    searchQueries(question),
  ]);

  const seen = new Set();
  const picked = [];
  for (const q of [...named, ...direct]) {       // 절차용(경로A)을 우선 포함
    if (seen.has(q.seq)) continue;
    seen.add(q.seq);
    picked.push(q);
    if (picked.length >= MAX_PROMPT_QUERIES) break;
  }
  return { list: picked, routed: true };
}
