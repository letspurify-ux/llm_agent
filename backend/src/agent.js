// Agent 처리 루프 — 시스템의 핵심 제어 흐름.
// 질문 → 지식/처리방법 검색 → LLM 결정 루프(답변 또는 쿼리 실행) → 최종 답변.
// 루프의 유일한 상태는 history 배열이며, 매 반복 전체 컨텍스트를 LLM에 전달한다.
// 대화 맥락(chat)은 서버가 저장하지 않고 클라이언트가 매 요청에 실어 보낸다 (stateless 유지).
import { searchKnowledge, searchQaMethods, searchQueries } from './search.js';
import { loadQueryRegistry, loadQueriesByNames } from './db.js';
import { runQuery } from './oracle.js';
import { bindNames } from './sql.js';
import { llm, renderAnswer } from './llm.js';
import { MAX_RESULT_ROWS, MAX_CHAT_TURNS, MAX_CHAT_LEN, TRUNC_MARK, nameKey, clipText, ownProp } from './constants.js';

const MAX_STEPS = 5;
const MAX_LOOP_MS = 180_000;   // 요청 시작부터 재는 예산(검색 포함). 초과하면 남은 스텝을 포기하고 강제 답변으로 간다.
                               // (스텝 상한과 별개로 필요하다 — 스텝 수는 LLM/조회가 얼마나 느린지를 모른다)
                               // 요청 전체 상한 = 이 값 + 마지막 LLM 호출(120초) + 강제 답변(120초) ≈ 420초.
                               // 프런트(App.jsx REQUEST_TIMEOUT_MS)가 이 계산에 맞춰져 있으니 함께 고칠 것.
const MAX_PROMPT_QUERIES = 30; // 프롬프트에 싣는 쿼리 상한 (~2.2k토큰)
const MAX_SAME_QUERY_TRIES = 2; // 같은 쿼리·파라미터의 최대 실행 시도 (1회 실패는 일시 오류일 수 있어 재시도 허용)
const MAX_MENTIONED_TOKENS = 100; // qa_method 본문에서 뽑아 query_registry에 물어볼 토큰 상한
const MAX_GUARD_HITS = 2;       // 루프 가드가 '연속으로' 이만큼 걸리면 남은 스텝을 포기하고 강제 답변으로 간다.
                                // (첫 1회는 LLM이 경로를 수정할 기회, 그래도 반복하면 LLM 왕복만 낭비된다.
                                //  조회에 성공하면 진도가 나간 것이므로 카운터를 되돌린다 — 다단계 절차 도중
                                //  같은 쿼리를 두 번 제안했다는 이유로 정상 흐름이 끊기면 안 된다)

// 셀 길이 제한은 드라이버 경계(oracle.js)에서 이미 적용됐다 — 여기서는 행 수만 줄인다.
const capRows = rows => rows.slice(0, MAX_RESULT_ROWS);

// 동일 실행 판정용 파라미터 키 — LLM이 준 원본이 아니라 "실제로 바인드되는 값"으로 만든다.
// runQuery가 SQL의 바인드 변수만 추려 쓰므로, 여분 키 하나가 붙었다고 다른 실행이 되지는 않는다.
// 값은 문자열로 정규화한다 (숫자 1과 문자열 '1'은 같은 컬럼에 같은 값으로 바인드된다).
// (테스트에서 쓰므로 export 한다 — 아래 loopGuard 주석 참고)
export function paramKey(bindNameList, params) {
  // 소유 키만 읽는다 (constants.ownProp) — 바인드명이 프로토타입 멤버와 겹치면 '값 없음'이어야
  // 할 자리가 다른 값으로 굳는다. 실행 경계(oracle.js runQuery)·잘린 값 가드(아래 truncatedBinds)·
  // Mock(llm.js fillParams)이 같은 함수를 쓴다 — 한 곳이라도 체인을 타면 그 경로에서만 판정이 어긋난다.
  const entries = bindNameList
    ? bindNameList.map(n => [n, ownProp(params, n)])
    : Object.entries(params || {}); // 미등록 쿼리라 바인드를 알 수 없으면 원본 그대로 비교
  return JSON.stringify(
    entries
      .map(([k, v]) => [k, v === undefined ? ['undefined'] : v === null ? ['null'] : String(v)])
      // 키 문자열로 명시 비교한다 — 비교 함수 없는 sort는 [k,v]를 이어붙인 문자열을 기준으로 삼아
      // 키에 쉼표가 들어가면 순서가 입력 순서에 좌우된다.
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  );
}

// 루프 가드 — 같은 쿼리를 같은 파라미터로 반복하는 퇴화한 결정을 걸러낸다.
// 진행해도 되면 null, 아니면 모델에게 남길 안내 문구를 돌려준다 (호출부가 note로 기록한다).
//
// 순수 함수로 떼어낸 이유: 이 판정은 양쪽 방향 모두로 '조용히' 깨진다.
//   느슨해지면 — 퇴화한 LLM 응답이 결정 루프를 제자리 돌며 스텝과 Oracle 조회를 소진한다.
//   빡빡해지면 — 다단계 절차의 정상 흐름이 '이미 실행된 쿼리'로 끊겨 답변만 부실해진다.
// 둘 다 오류를 남기지 않아 배포 뒤에도 원인이 보이지 않는다. 그래서 DB 없이 돌릴 수 있게 분리해
// 회귀 테스트를 붙인다 (test/agent.test.js).
export function loopGuard(history, canonicalName, binds, params) {
  const key = paramKey(binds, params);
  const isSame = h => nameKey(h.query_name) === nameKey(canonicalName) && paramKey(binds, h.params) === key;
  // 미등록 이름의 반복도 같은 가드로 걸리도록 '등록되지 않은 쿼리' 처리보다 앞에서 부른다
  // (가장 흔한 퇴화 패턴이 그것이다).
  if (history.some(h => h.rows && isSame(h))) {
    return '이미 같은 파라미터로 실행된 쿼리 — 실행 이력의 결과로 답변하거나 다른 쿼리를 선택하라';
  }
  // 실패도 무한 반복은 막는다 (결정적 오류면 타임아웃 대기가 스텝 수만큼 쌓인다)
  if (history.filter(h => h.error && isSame(h)).length >= MAX_SAME_QUERY_TRIES) {
    return '같은 파라미터로 반복 실패한 쿼리 — 다른 쿼리를 선택하거나 지금까지의 정보로 답변하라';
  }
  return null;
}

// 잘린 셀 값 가드 — 실행 이력의 잘린 셀(TRUNC_MARK가 붙은 값)에서 표시만 보고 마크를 뗀
// 앞부분을 옮겨 적은 바인드 값을, 실행 전에 이력의 원본과 대조해 걸러낸다.
// 문제가 있는 바인드명 목록을 돌려준다 (없으면 빈 배열). (테스트에서 쓰므로 export)
//
// oracle.js의 bindProblem과 역할을 나눈다: 저쪽은 값 자체로 판정되는 문제(값 없음·구조·
// TRUNC_MARK가 그대로 붙은 값·절단 길이와 정확히 같은 값)를, 여기는 이력이 있어야 판정되는
// 문제(마크를 뗀 앞부분)를 본다. 길이 휴리스틱만으로 넓게 막으면 질문에서 온 정당한 긴 값
// (자유 검색어·경로·연결 키)까지 영구히 거부된다 — "이 값이 잘린 조각인가"는 그 값을 잘랐던
// 이력을 쥔 쪽만 정확히 답할 수 있으므로 판정을 여기로 가져온다.
// 잘린 값을 그대로 바인드하면 조용히 0건이 나오고 LLM은 그것을 "그런 데이터가 없다"로 읽는다.
export function truncatedBinds(history, bindNameList, params) {
  const prefixes = new Set();
  for (const h of history) {
    for (const row of h.rows || []) {
      for (const v of Object.values(row)) {
        if (typeof v === 'string' && v.endsWith(TRUNC_MARK)) prefixes.add(v.slice(0, -TRUNC_MARK.length));
      }
    }
  }
  if (!prefixes.size) return [];
  // 값 읽기는 paramKey·runQuery와 같은 ownProp으로 한다 — 여기만 params?.[n]으로 체인을 타면
  // 이 가드에서만 '소유 키만 본다'는 전제가 깨진다 (지금은 무해해도 전제가 갈라진 채로 남는다).
  return (bindNameList || []).filter(n => {
    const v = ownProp(params, n);
    return typeof v === 'string' && prefixes.has(v);
  });
}

// 클라이언트가 보낸 대화 이력을 신뢰하지 않고 형식을 검증·제한한다.
// (테스트에서 쓰므로 export 한다 — 클라이언트가 보낸 값을 그대로 믿지 않는 유일한 지점이다)
export function normalizeChat(chat) {
  if (!Array.isArray(chat)) return [];
  // 내용이 빈 턴은 걸러낸다 — 프롬프트에는 '- 사용자: ' 한 줄로 실려 모델이 내용 없는 발화를
  // 맥락으로 읽고(무엇을 가리키는지 없는 지시대명사처럼 다룬다), 턴 예산 자리도 하나 차지한다.
  // 같은 판정을 절단 뒤에 한 번 더 한다: 짝 잃은 서로게이트 하나만 담긴 턴은 clipChatText가
  // 그 코드유닛을 떼면서 빈 문자열이 되므로, 앞에서만 거르면 그 경로로 빈 턴이 그대로 남는다.
  const isTurn = m =>
    m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim();
  return chat
    .filter(isTurn)
    .slice(-MAX_CHAT_TURNS)
    .map(m => ({ role: m.role, text: clipChatText(m.text) }))
    .filter(isTurn);
}

// 턴 본문은 단순 slice가 아니라 clipText로 자른다 — 경계의 서로게이트 쌍(이모지 등)을 반으로
// 쪼개면 짝 잃은 코드유닛이 프롬프트에 실려, LLM API로 보내는 인코딩 단계에서 U+FFFD로
// 조용히 훼손된다 (constants.clipText 주석 참고).
// clipText는 상한 이하 문자열에는 손대지 않으므로, 클라이언트가 자기 쪽 절단(App.jsx)에서
// 이미 쪼개 보낸 문자열은 그대로 통과한다 — 끝이 상위 서로게이트인 문자열은 절단 여부와
// 무관하게 항상 손상된 문자열이므로, 여기서 마지막 코드유닛을 마저 뗀다.
function clipChatText(text) {
  const t = clipText(text, MAX_CHAT_LEN);
  const last = t.charCodeAt(t.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? t.slice(0, -1) : t;
}

export async function handleQuestion(question, rawChat = []) {
  const chat = normalizeChat(rawChat);
  // 예산은 요청 시작점에서 잡는다 — 검색 뒤에 잡으면 임베딩 타임아웃(최대 2회 × 60초)이
  // 예산 밖에 놓여, 문서화한 요청 상한과 프런트 abort 시각이 실제보다 낙관적이 된다.
  const deadline = Date.now() + MAX_LOOP_MS;

  const [k0, m0] = await Promise.all([
    searchKnowledge(question),
    searchQaMethods(question),
  ]);
  let knowledge = k0;
  let qaMethods = m0;
  // 쿼리 검색에도 같은 문장을 써야 한다 — 아래에서 맥락을 덧붙여 재검색했는데
  // 쿼리 라우팅만 원래 질문을 보면, qa_method 없이 등록된 쿼리(경로B)는 후속 질문마다 통째로 빠진다.
  let searchText = question;

  // "그럼 김철수는?" 같은 후속 질문은 그 문장만으로는 검색되지 않는다.
  // 현재 질문으로 아무것도 못 찾았을 때만 직전 질문을 덧붙여 재검색한다
  // (평소에는 현재 질문만 쓰므로 검색 정확도가 떨어지지 않는다).
  if (!knowledge.length && !qaMethods.length && chat.length) {
    const prevQuestions = chat.filter(m => m.role === 'user').slice(-2).map(m => m.text).join(' ');
    if (prevQuestions) {
      searchText = `${prevQuestions} ${question}`;
      [knowledge, qaMethods] = await Promise.all([
        searchKnowledge(searchText),
        searchQaMethods(searchText),
      ]);
    }
  }

  const { list: queries, routed } = await selectQueries(qaMethods, searchText);

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
    // 스텝 수만으로는 소요 시간이 묶이지 않는다 — 느린 LLM 엔드포인트에서는
    // 스텝마다 LLM 타임아웃이 통째로 쌓여 요청 하나가 수십 분씩 워커를 점유한다.
    if (Date.now() > deadline) break;
    const decision = await decide(ctx());
    if (!decision) break; // 결정을 얻지 못했다 — 아래 강제 답변/폴백으로 간다
    if (decision.action === 'answer') {
      return { answer: decision.answer, trace: history, search };
    }

    // 예산은 스텝 진입에서만 보면 부족하다 — 239초에 시작한 스텝이 LLM 120초를 쓰고 나서
    // Oracle 접속·조회까지 더 태우면 프런트가 먼저 끊는 지점을 넘긴다.
    // LLM 응답을 받은 뒤 다시 확인해, 남지 않았으면 조회를 태우지 않고 강제 답변으로 간다.
    if (Date.now() > deadline) break;

    const { row: registryRow, error: resolveError, hint: resolveHint } =
      await resolveQuery(decision.query_name, queries, resolveCache);
    // 이력에는 항상 정규 이름(등록된 철자)을 남긴다 — 가드와 프롬프트가 같은 이름을 보게.
    const canonicalName = registryRow?.query_name ?? decision.query_name;
    const binds = registryRow ? bindNames(registryRow.query_sql) : null;
    // note는 LLM에게 경로를 바꾸라고 알리는 제어용 기록이다. 실제 쿼리 실패(error)와 필드를 나눈다 —
    // 같은 필드에 넣으면 사용자 trace 패널과 chat_log의 '실패한 질문' 집계에 정상 턴이 섞인다.
    // extra.safe = 이 문구를 사용자 화면(trace 패널)에 그대로 내보내도 되는가.
    // 우리가 문구를 만든 오류만 true다 — 드라이버·DB 원문은 스키마명·호스트를 담고 있다(server.js가 이 표시를 본다).
    const push = (field, msg, extra) => history.push({ query_name: canonicalName, params: decision.params, [field]: msg, ...extra });

    const guardNote = loopGuard(history, canonicalName, binds, decision.params);
    if (guardNote) {
      push('note', guardNote);
      if (++guardHits >= MAX_GUARD_HITS) break;
      continue;
    }
    if (!registryRow) {
      push('error', resolveError ?? '등록되지 않은 쿼리', {
        safe: true,
        hint: resolveHint ?? '쿼리 목록에 있는 이름만 실행할 수 있다 — 목록에서 고르거나 지금까지의 정보로 답변하라',
      });
      // 미등록 이름의 반복이 '가장 흔한 퇴화 패턴'(loopGuard 주석)인데, 모델이 매번 다른 이름을
      // 지어내면 loopGuard의 동일 실행 판정에는 한 번도 걸리지 않는다 — 스텝마다 LLM 왕복(최대
      // 120초)만 태우며 MAX_STEPS를 전부 소진한다. 이름이 무엇이든 '실행 없이 헛돈 스텝'이므로
      // guardNote와 같은 연속 카운터로 센다 (조회에 성공하면 0으로 되돌리는 것도 같다).
      if (++guardHits >= MAX_GUARD_HITS) break;
      continue;
    }
    // 프롬프트 목록 밖에서 찾은 쿼리는 목록에 넣어준다 — 다음 스텝에서 LLM이 input_desc를 보고
    // 바인드를 고칠 수 있어야 한다. 중복은 넣지 않고, 늘어나는 상한은 MAX_STEPS건이다
    // (즉 목록은 최대 MAX_PROMPT_QUERIES + MAX_STEPS건 — 무제한으로 커지지 않는다).
    // 뒤가 아니라 앞에 넣는다 — 프롬프트 예산(llm-openai.js renderItems)은 '뒤쪽일수록 관련도가 낮다'는
    // 전제로 꼬리부터 버린다. 방금 LLM이 이름을 대서 찾아낸 쿼리는 이번 스텝에서 가장 관련이 높은데,
    // 뒤에 붙이면 등록이 조금만 많아도 그 한 건이 먼저 잘려 나가 이 복구 경로 자체가 조용히 사라진다.
    if (!queries.includes(registryRow)) queries.unshift(registryRow);
    // 이력의 잘린 셀에서 옮겨 적은 값은 원본과 달라 절대 매칭되지 않는다 — Oracle 왕복 없이
    // 이 스텝만 실패 처리한다 (판정이 여기 있는 이유는 truncatedBinds 주석 참고).
    const clippedBinds = truncatedBinds(history, binds, decision.params);
    if (clippedBinds.length) {
      push('error', `바인드 변수를 쓸 수 없습니다 — ${clippedBinds.map(n => `${n}: 잘린 값이라 원본과 다름`).join(', ')}.`, {
        safe: true,
        hint: '이 값의 온전한 원본은 조회 결과에 없다 — 다른 컬럼·다른 쿼리로 원본을 구하거나 사용자에게 되물어라',
      });
      continue;
    }
    try {
      const { rows, totalRows, capped } = await runQuery(registryRow, decision.params);
      history.push({ query_name: canonicalName, params: decision.params, rows: capRows(rows), totalRows, capped });
      guardHits = 0; // 진도가 나갔다 — 가드는 '연속' 헛도는 경우만 센다
    } catch (e) {
      // 실패도 이력에 남기고 루프를 계속한다 — LLM이 에러를 보고 재시도/우회/답변을 판단.
      // 메시지가 비면 안 된다: error가 falsy면 프롬프트·답변 조립이 이 기록을 '오류'로 보지 않고
      // rows가 있는 정상 결과로 취급해 들어간다.
      push('error', e?.message || String(e), { safe: e?.safe === true, ...(e?.hint && { hint: e.hint }) });
    }
  }

  // 안전장치: MAX_STEPS 초과(또는 가드 반복) 시 강제 답변.
  // 그마저 실패하면 fallbackAnswer가 손에 든 것으로 답을 조립한다.
  const finalCtx = { ...ctx(), forceAnswer: true };
  const final = await decide(finalCtx);
  const answer = (final?.action === 'answer' && final.answer) || fallbackAnswer(finalCtx);
  return { answer, trace: history, search };
}

const LLM_FAILED = 'LLM 호출에 실패했습니다. 잠시 후 다시 시도해주세요.';

// 폴백 답변에 붙이는 머리말. 이 답을 만든 것은 모델이 아니라 이 파일이다.
// 표시가 없으면 조립된 답이 정상 답변과 글자 그대로 구분되지 않는다 — 특히 조회를 한 번도
// 못 한 요청에서는 검색된 지식 본문이 그대로 답변으로 나가므로, LLM이 통째로 죽어 있어도
// 화면은 평소와 똑같아 보이고 chat_log에도 그 사실이 남지 않는다.
// 문구 형식은 llm-openai.js의 '*등록된 지식에 없는 내용이라…*'와 같은 기울임 한 줄로 맞춘다.
const LLM_FAILED_NOTE = '*LLM 응답을 받지 못해, 조회 결과와 등록된 지식만으로 정리한 답변입니다.*';

// LLM이 끝내 결정을 내지 못했을 때의 답변.
// 조회를 몇 번 성공해놓고 'LLM 호출 실패' 한 줄만 내보내면 그 요청이 실제로 한 일이 통째로
// 사라지고, 반대로 표시 없이 조립해 내보내면 실패한 사실이 사라진다 — 둘 다 남긴다.
// (테스트에서 쓰므로 export 한다 — 두 실패 모드 다 오류를 남기지 않아 회귀가 보이지 않는다)
export function fallbackAnswer(ctx) {
  const rendered = renderAnswer(ctx);
  return rendered ? `${LLM_FAILED_NOTE}\n\n${rendered}` : LLM_FAILED;
}

// LLM 호출은 무엇이 실패하든 요청 전체를 500으로 만들지 않는다 — 함께 버려지는 것이
// 이미 조회해둔 결과이기 때문이다. provider는 자기 재시도 루프 안의 실패만 흡수하므로
// (HTTP·타임아웃·파싱), 그 밖의 실패는 여기서 받는다: 프롬프트 조립 오류, mock provider의 예외,
// ctx에 예상 밖의 값이 섞인 경우. 보장은 provider가 아니라 '누적된 성과를 쥐고 있는' 이 경계에 둔다.
// 결정을 얻지 못하면 null을 돌려주고, 호출부가 강제 답변 또는 폴백 답변으로 넘어간다.
async function decide(ctx) {
  try {
    return await llm.decide(ctx);
  } catch (e) {
    // 원문은 로그에만 — 스키마명·호스트가 섞일 수 있고, 사용자 문구는 호출부가 만든다.
    console.error('[agent] LLM decision failed:', e);
    return null;
  }
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
    // DB 조회도 정규화한 키로 한다 — 프롬프트 목록 검색은 nameKey로 맞추면서 여기만 원본을 쓰면,
    // 앞 공백이 붙은 이름이 '목록에 있으면 실행되고, 라우팅에서 빠졌으면 미등록'이 된다
    // (MariaDB collation은 대소문자·뒤 공백은 무시하지만 앞 공백은 구분한다) —
    // 같은 이름이 등록 규모에 따라 다르게 동작하는 셈이다. 소문자화는 collation이 흡수한다.
    const [row = null] = await loadQueriesByNames([key]);
    cache.set(key, row);
    return { row };
  } catch (e) {
    // 상세는 로그에만 남긴다 — 이 문구는 프롬프트와 화면 양쪽으로 나가는데, MariaDB 원문에는
    // 스키마·호스트가 들어 있고 모델의 복구 판단에 보탬이 되지도 않는다.
    // hint(모델 전용 지침)와 error(화면에도 나가는 문구)를 나눈다 — constants.safeError 참고.
    console.warn('[agent] failed to re-fetch query_registry:', e.message);
    return { row: null, error: '쿼리 목록을 조회하지 못했습니다.', hint: '다른 쿼리를 선택하거나 지금까지의 정보로 답변하라' };
  }
}

// 프롬프트에 실을 쿼리 선정. 등록 수가 적으면 전체(가장 정확), 많으면 두 경로의 합집합:
//   경로A: 매칭된 qa_method 본문이 지목한 query_name (다단계 절차 보장)
//   경로B: 질문으로 query_registry 자체를 하이브리드 검색 — qa_method 등록 없는 쿼리도 찾는다
// 반환: { list, routed } — routed=false면 전체를 실은 것이므로 '적중 수' 개념이 없다.
async function selectQueries(qaMethods, question) {
  // 상한+1건만 읽어 "전체를 실어도 되는 규모인지"를 같은 왕복에서 판정한다.
  // COUNT 후 다시 SELECT하면 매 요청이 왕복 2회 + 풀 점유 2회가 되고, 그렇다고 무조건
  // 전체를 읽으면 등록이 많을 때 대형 SELECT가 된다 — 상한+1은 양쪽 다 피한다.
  // 대가: 라우팅이 도는 규모(등록 30건 초과)에서는 이 31행이 그대로 버려진다.
  // 31행은 상한이 걸린 고정 비용이라 지금은 왕복 1회 쪽이 낫다고 봤다 —
  // 등록이 크게 늘고 설명 컬럼이 길어져 이 전송이 부담이 되면
  // 규모 판정만 `SELECT seq … LIMIT 31`로 떼고 전체 로드를 조건부로 되돌릴 것.
  const head = await loadQueryRegistry(MAX_PROMPT_QUERIES + 1);
  if (head.length <= MAX_PROMPT_QUERIES) return { list: head, routed: false };

  // 본문의 영문 토큰은 대부분 query_name이 아니다(상태값·명령어·영단어). 전부 IN 절에 실으면
  // 매 요청이 수백 개짜리 플레이스홀더 목록을 보내게 된다 — 걸러지는 곳이 MariaDB라 이미 늦다.
  // 등장 순서를 유지한 채 상한을 둔다: 앞쪽이 절차의 첫 단계이므로 잘려도 다단계 절차의 시작은 남는다.
  // (likeSearch가 검색 토큰에 두는 상한과 같은 이유·같은 방식이다)
  const mentioned = [...new Set(
    qaMethods.flatMap(m => m.method.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [])
  )].slice(0, MAX_MENTIONED_TOKENS);
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
