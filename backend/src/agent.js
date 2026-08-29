// Agent 처리 루프 — 시스템의 핵심 제어 흐름.
// 질문 → 지식/처리방법 검색 → LLM 결정 루프(답변 또는 쿼리 실행) → 최종 답변.
// 루프의 유일한 상태는 history 배열이며, 매 반복 전체 컨텍스트를 LLM에 전달한다.
// 대화 맥락(chat)은 서버가 저장하지 않고 클라이언트가 매 요청에 실어 보낸다 (stateless 유지).
import { searchKnowledge, searchQaMethods, searchQueries } from './search.js';
import { loadQueryRegistry, countQueries, loadQueriesByNames } from './db.js';
import { runQuery, MAX_ROWS } from './oracle.js';
import { llm, TRUNC_MARK } from './llm.js';

const MAX_STEPS = 5;
const MAX_PROMPT_QUERIES = 30; // 프롬프트에 싣는 쿼리 상한 (~2.2k토큰)
const MAX_RESULT_ROWS = 20; // LLM 컨텍스트/답변에 전달할 최대 행 수 (총 건수는 totalRows로 보존)
const MAX_CELL_LEN = 200;   // 셀 값 최대 길이 (CLOB 등 대형 텍스트 방어)
const MAX_CHAT_TURNS = 6;   // LLM에 전달할 최근 대화 턴 수 (프롬프트 비대화 방지)
const MAX_CHAT_LEN = 500;   // 턴별 최대 길이
const MAX_SAME_QUERY_TRIES = 2; // 같은 쿼리·파라미터의 최대 실행 시도 (1회 실패는 일시 오류일 수 있어 재시도 허용)

function capRows(rows) {
  return rows.slice(0, MAX_RESULT_ROWS).map(row =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => {
        const s = typeof v === 'string' ? v : null;
        return [k, s && s.length > MAX_CELL_LEN ? s.slice(0, MAX_CELL_LEN) + TRUNC_MARK : v];
      })
    )
  );
}

// 동일 쿼리 재실행 판정용 — 파라미터를 키 순서와 무관하게 비교한다.
const paramKey = p => JSON.stringify(Object.entries(p || {}).sort());

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

  for (let step = 0; step < MAX_STEPS; step++) {
    const decision = await llm.decide(ctx());
    if (decision.action === 'answer') {
      return { answer: decision.answer, trace: history, search };
    }

    let registryRow = queries.find(q => q.query_name === decision.query_name);
    if (!registryRow) {
      // 프롬프트 목록은 30건으로 잘릴 수 있다 — 실제 allowlist는 query_registry이므로 이름으로 재확인한다.
      // (지식·처리방법 본문이 지목한 쿼리가 라우팅에서 빠졌을 때 '등록되지 않은 쿼리'로 오진단되는 것 방지)
      [registryRow] = await loadQueriesByNames([decision.query_name]);
      if (registryRow) queries.push(registryRow); // 다음 스텝에서 다시 조회하지 않도록
    }
    if (!registryRow) {
      history.push({ query_name: decision.query_name, params: decision.params, error: '등록되지 않은 쿼리' });
      continue;
    }
    // 같은 쿼리를 같은 파라미터로 반복하지 않는다 — 퇴화한 LLM 응답이 결정 루프를
    // 제자리 돌며 스텝과 Oracle 조회를 소진하는 것 방지. 에러로 기록해 LLM이 경로를 수정하게 한다.
    const isSame = h => h.query_name === decision.query_name && paramKey(h.params) === paramKey(decision.params);
    if (history.some(h => h.rows && isSame(h))) {
      history.push({
        query_name: decision.query_name,
        params: decision.params,
        error: '이미 같은 파라미터로 실행된 쿼리 — 실행 이력의 결과로 답변하거나 다른 쿼리를 선택하라',
      });
      continue;
    }
    // 실패도 무한 반복은 막는다 (결정적 오류면 타임아웃 대기가 스텝 수만큼 쌓인다)
    if (history.filter(h => h.error && isSame(h)).length >= MAX_SAME_QUERY_TRIES) {
      history.push({
        query_name: decision.query_name,
        params: decision.params,
        error: '같은 파라미터로 반복 실패한 쿼리 — 다른 쿼리를 선택하거나 지금까지의 정보로 답변하라',
      });
      continue;
    }
    try {
      const rows = await runQuery(registryRow, decision.params);
      history.push({
        query_name: registryRow.query_name,
        params: decision.params,
        rows: capRows(rows),
        totalRows: rows.length,
        // 조회 상한에 도달했으면 실제 총 건수는 그 이상일 수 있다
        capped: rows.length >= MAX_ROWS,
      });
    } catch (e) {
      // 실패도 이력에 남기고 루프를 계속한다 — LLM이 에러를 보고 재시도/우회/답변을 판단
      history.push({ query_name: registryRow.query_name, params: decision.params, error: e.message });
    }
  }

  // 안전장치: MAX_STEPS 초과 시 강제 답변
  const final = await llm.decide({ ...ctx(), forceAnswer: true });
  return { answer: final.answer, trace: history, search };
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
