// Agent 처리 루프 — 시스템의 핵심 제어 흐름.
// 질문 → 지식/처리방법 검색 → LLM 결정 루프(답변 또는 쿼리 실행) → 최종 답변.
// 루프의 유일한 상태는 history 배열이며, 매 반복 전체 컨텍스트를 LLM에 전달한다.
// 대화 맥락(chat)은 서버가 저장하지 않고 클라이언트가 매 요청에 실어 보낸다 (stateless 유지).
import { searchKnowledge, searchQaMethods, searchQueries } from './search.js';
import { loadQueryRegistry, loadQueriesByNames, loadQueriesMentionedIn } from './db.js';
import { runQuery } from './oracle.js';
import { bindNames } from './sql.js';
import { llm, renderAnswer, clipAnswer } from './llm.js';
import { MAX_STEPS, MAX_RESULT_ROWS, MAX_CHAT_TURNS, MAX_CHAT_LEN, MAX_CELL_LEN, TRUNC_MARK, nameKey, clipText, stripLoneSurrogates, bindValue, targetDbNames } from './constants.js';

// MAX_STEPS는 constants.js에 있다 — 실행 이력의 프롬프트 몫이 그 값에 묶여 있다.
const MAX_LOOP_MS = 180_000;   // 요청 시작부터 재는 예산(검색 포함). 초과하면 남은 스텝을 포기하고 강제 답변으로 간다.
                               // (스텝 상한과 별개로 필요하다 — 스텝 수는 LLM/조회가 얼마나 느린지를 모른다)
                               // 요청 전체 상한 = 이 값 + 마지막 LLM 호출(120초) + 강제 답변(120초) ≈ 420초.
                               // 프런트(App.jsx REQUEST_TIMEOUT_MS)가 이 계산에 맞춰져 있으니 함께 고칠 것.
const MAX_PROMPT_QUERIES = 30; // 프롬프트에 싣는 쿼리 상한 (~2.2k토큰)
const MAX_SAME_QUERY_TRIES = 2; // 같은 쿼리·파라미터의 최대 실행 시도 (1회 실패는 일시 오류일 수 있어 재시도 허용)
// 경로A(qa_method 본문이 지목한 쿼리)에서 관리 DB로 보내는 본문 길이 상한.
// qa_method.method는 TEXT(64KB)이고 검색은 최대 20건을 돌려주므로, 상한이 없으면 요청마다
// 1MB가 넘는 문자열이 바인드로 나가고 등록 행마다 그 길이를 훑게 된다.
// 앞쪽이 관련도가 높은 처리방법이고(검색 결과 순서) 절차의 첫 단계도 본문 앞쪽에 온다 —
// 잘려도 다단계 절차의 시작은 남는다 (프롬프트 예산이 꼬리부터 버리는 것과 같은 전제다).
const MAX_ROUTE_TEXT_LEN = 20_000;
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
  // 값 조회는 실행 경계와 같은 함수로 한다 (constants.bindValue) — 소유 키만 보고(프로토타입 멤버와
  // 겹치는 바인드명이 '값 없음'을 다른 값으로 굳히지 않게), 대소문자는 Oracle과 같이 무시한다.
  // 판정과 실행이 다른 규칙을 쓰면 그 차이만큼 가드가 조용히 비켜간다: 실행 경계가 :job_id에
  // {"JOB_ID": …}를 바인드하는데 여기서 '값 없음'으로 보면, 같은 조회를 대문자·소문자로 번갈아
  // 제안하는 반복이 매번 '다른 실행'으로 통과한다.
  const entries = bindNameList
    ? bindNameList.map(n => [n, bindValue(params, n)])
    // 미등록 쿼리라 바인드를 알 수 없으면 원본 키로 비교한다. 키는 nameKey로 낮춘다 —
    // 실행되면 어차피 같은 바인드가 될 표기 차이가 여기서 '다른 실행'이 되면 안 된다.
    : Object.entries(params || {}).map(([k, v]) => [nameKey(k), v]);
  return JSON.stringify(
    entries
      .map(([k, v]) => [k, valueKey(v)])
      // 키 문자열로 명시 비교한다 — 비교 함수 없는 sort는 [k,v]를 이어붙인 문자열을 기준으로 삼아
      // 키에 쉼표가 들어가면 순서가 입력 순서에 좌우된다.
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  );
}

// 값 하나를 비교 가능한 형태로 정규화한다.
// 스칼라는 문자열로 낮춘다 (숫자 1과 문자열 '1'은 같은 컬럼에 같은 값으로 바인드된다).
// null·undefined는 배열로 감싸 문자열 'null'·'undefined'와 구분한다.
// 구조(객체·배열)를 String(v)로 낮추면 안 된다 — 전부 '[object Object]'로 뭉개져 서로 다른
// 결정이 같은 실행으로 판정된다. 값이 아닌 구조는 실행 경계(oracle.js bindProblem)가 매번
// 거부하므로 이력에는 '실패'로 남는데, 그 실패 둘이 한 실행으로 뭉개지면 MAX_GUARD_HITS가
// 실제보다 한 스텝 일찍 차서 모델이 값을 고쳐 잡을 기회를 잃는다.
// 키 순서까지 정규화한다 — {a,b}와 {b,a}는 같은 값이고, 순서로 갈리면 위 sort가 최상위에서
// 하는 정규화가 한 겹 아래에서 무너진다.
// 정규화는 JSON.stringify의 replacer가 아니라 '먼저 한 번' 훑어서 한다. replacer로 하면
// 매번 새 객체를 돌려주게 되는데, JSON.stringify의 순환 참조 탐지는 '지금 직렬화 중인 값'들의
// 스택을 보므로 원본이 그 스택에 한 번도 올라가지 않는다 — 깔끔한 TypeError 대신 스택이
// 바닥날 때까지 재귀한다(실측: RangeError). catch가 받아내긴 하지만, 결정 루프 한가운데서
// 자바스크립트 스택을 통째로 소진하는 경로를 남길 이유가 없다.
// 순환은 마커로 끊는다. seen에서 되빼는 것이 중요하다 — 빼지 않으면 같은 객체를 두 번 가리키는
// (순환이 아닌) 정상 구조까지 순환으로 오판한다.
// BigInt는 JSON.stringify가 던지므로 그때만 String(v)로 물러선다 — 여기서 던지면 가드 하나가
// 결정 루프를 통째로 죽인다.
const CYCLE_MARK = '[순환]';

function canonical(v, seen) {
  if (!v || typeof v !== 'object') return v;
  if (seen.has(v)) return CYCLE_MARK;
  seen.add(v);
  const out = Array.isArray(v)
    ? v.map(x => canonical(x, seen))
    : Object.fromEntries(
        Object.entries(v)
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([k, x]) => [k, canonical(x, seen)])
      );
  seen.delete(v);
  return out;
}

function valueKey(v) {
  if (v === undefined) return ['undefined'];
  if (v === null) return ['null'];
  if (typeof v !== 'object') return String(v);
  try {
    return ['json', JSON.stringify(canonical(v, new Set()))];
  } catch {
    return ['json', String(v)];
  }
}

// 이 스텝이 실제로 향하는 대상 DB — '모델이 고른 값'이 아니라 '실행될 값'이다.
// 고른 값을 그대로만 쓰면 후보가 하나뿐이라 target_db를 생략한 경우(기존 등록 전부가 그렇다)
// 빈 값이 되는데, 이력에는 실행 경계가 채운 등록 철자가 남아 있어 루프 가드의 동일 실행 판정이
// 한 번도 성립하지 않는다 — 목록형과 무관한 기존 쿼리에서 가드가 통째로 조용히 꺼지는 셈이다.
// 그래서 실행 경계(oracle.js resolveTargetDb)와 같은 규칙으로 맞춘다: 고른 값이 있으면 그것,
// 없고 후보가 하나뿐이면 그 하나, 여럿이면 빈 값(실행 경계가 후보를 들고 되묻는다).
// 목록 해석은 같은 파서를 쓴다 (constants.targetDbNames) — 두 곳이 다르게 세면 가드가 보는
// '같은 실행'과 실행기가 보는 '같은 실행'이 갈라진다.
function effectiveTargetDb(registryRow, chosen) {
  if (chosen) return chosen;
  const names = registryRow ? targetDbNames(registryRow.target_db_name) : [];
  return names.length === 1 ? names[0] : '';
}

// 루프 가드 — 같은 쿼리를 같은 파라미터로 반복하는 퇴화한 결정을 걸러낸다.
// 진행해도 되면 null, 아니면 모델에게 남길 안내 문구를 돌려준다 (호출부가 note로 기록한다).
//
// 순수 함수로 떼어낸 이유: 이 판정은 양쪽 방향 모두로 '조용히' 깨진다.
//   느슨해지면 — 퇴화한 LLM 응답이 결정 루프를 제자리 돌며 스텝과 Oracle 조회를 소진한다.
//   빡빡해지면 — 다단계 절차의 정상 흐름이 '이미 실행된 쿼리'로 끊겨 답변만 부실해진다.
// 둘 다 오류를 남기지 않아 배포 뒤에도 원인이 보이지 않는다. 그래서 DB 없이 돌릴 수 있게 분리해
// 회귀 테스트를 붙인다 (test/agent.test.js).
// targetDb까지 보는 이유: 대상 DB가 여럿인 쿼리에서 이것을 빼면 '서울 재고를 보고 이어서 부산
// 재고를 본다'는 정상 흐름이 '이미 같은 파라미터로 실행된 쿼리'로 끊긴다 — 이름도 바인드도 같고
// 다른 것은 DB뿐이기 때문이다. 두 번째 DB는 영영 조회되지 않는데 남는 기록은 note 한 줄뿐이라,
// 모델은 조회한 적 없는 DB에 대해 '이미 실행됨'이라는 안내를 받는다.
// 비교는 nameKey로 한다 — 이력에는 성공 기록의 등록 철자와 실패 기록의 요청 철자가 섞여 있다.
export function loopGuard(history, canonicalName, binds, params, targetDb) {
  const key = paramKey(binds, params);
  const dbKey = nameKey(targetDb);
  const isSame = h =>
    nameKey(h.query_name) === nameKey(canonicalName) &&
    nameKey(h.targetDb) === dbKey &&
    paramKey(binds, h.params) === key;
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
// 자르기 '전에' 짝 잃은 코드유닛을 걷어낸다. clipText는 상한 이하 문자열에 손대지 않으므로,
// 클라이언트가 자기 쪽 절단(App.jsx)에서 이미 쪼개 보낸 조각은 그대로 통과한다 —
// 그런데 앞선 구현은 '끝'의 상위 서로게이트 하나만 봤다. 클라이언트가 이모지 한가운데를 자르고
// 뒷조각을 보내면 맨 앞에 하위 서로게이트가 남는데(예: '\uDC00 재시작은 어떻게 해?'), 그쪽은
// 검사를 통째로 비켜 가서 프롬프트에 그대로 실렸다. 한쪽 경계만 지키는 가드였던 셈이다.
// stripLoneSurrogates는 양쪽 경계와 가운데를 같은 규칙으로 없앤다 — 규칙이 하나면 한쪽만 빠질 수 없다.
// 앞뒤 공백은 여기서 뗀다. 위 isTurn이 '.trim()이 비었는가'로 빈 턴을 걸러내면서 정작 저장은
// 원본을 그대로 했던 탓에, '  BATCH001 상태  '가 프롬프트에 '- 사용자:   BATCH001 상태  '로
// 실리고 그 공백이 MAX_CHAT_LEN 예산까지 함께 먹었다 — 판정과 저장이 다른 문자열을 보고 있었다.
// 현재 질문은 서버 입력 검증(server.js)이 같은 처리를 한다. 이력만 빠져 있었다.
// 서로게이트를 걷어낸 '뒤에' 공백을 뗀다 — 순서가 반대면 클라이언트가 이모지 한가운데를 자른
// 조각('\uDC00 재시작은 어떻게 해?')에서 코드유닛만 사라지고 그 자리의 공백이 그대로 남는다.
function clipChatText(text) {
  return clipText(stripLoneSurrogates(text).trim(), MAX_CHAT_LEN);
}

// 질문 정규화의 단일 지점.
// 클라이언트가 이모지 한가운데를 자른 조각을 보내면 그 요청의 모든 LLM 호출이 인코딩 단계에서
// 실패하거나 본문이 U+FFFD로 훼손되므로, 대화 턴과 같은 처리를 질문에도 한다(clipChatText 참고).
//
// 이 함수를 export 하는 이유: 이 정리를 서버 입력 검증(server.js)도 해야 한다 — 그쪽은 길이
// 검증과 chat_log 기록에 같은 값을 써야 하기 때문이다. 두 곳이 각자 적으면 규칙이 갈라진다.
// 실제로 갈라져 있었다: server.js는 정리 뒤 trim까지 했고 여기는 하지 않아, 같은 입력이
// 어느 문으로 들어오느냐에 따라 다른 질문이 됐다.
// 양쪽 경계에서 모두 부른다 — 멱등이라 두 번 불러도 값이 같고(두 번째는 서로게이트가 없어
// 정규식 검사 한 번에 끝난다), 그래야 handleQuestion을 직접 부르는 경로도 같은 규칙을 받는다.
export const normalizeQuestion = raw => stripLoneSurrogates(raw).trim();

export async function handleQuestion(rawQuestion, rawChat = []) {
  const question = normalizeQuestion(rawQuestion);
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

  // 쿼리 목록 로드 실패로 요청 전체를 버리지 않는다 — 함께 버려지는 것이 바로 위에서 이미
  // 조회해둔 지식·처리방법이고, 그중에는 DB 조회가 아예 필요 없는 순수 지식 질문도 있다.
  // 같은 테이블의 같은 실패를 한 스텝 뒤(resolveQuery)에서는 이미 이렇게 다루고 있었다 —
  // 경계가 갈라져 있어서, 관리 DB가 흔들리면 모든 질문이 500이 되고 여기만 그 이유가 됐다.
  const { list: queries, routed, failed: queriesFailed } =
    await selectQueries(qaMethods, searchText).catch(e => {
      // 상세는 로그에만 — 화면 문구는 호출부가 만들고, MariaDB 원문에는 스키마·호스트가 들어 있다.
      console.warn('[agent] failed to load the query list:', e.message);
      return { list: [], routed: false, failed: true };
    });

  // 검색 적중 수 — chat_log 분석용: 검색 0건(지식/쿼리 신규 등록 필요)과
  // 적중은 했지만 답이 부실한 경우(내용 보강 필요)를 구분할 수 있게 한다.
  // queries는 라우팅이 동작할 때(등록 30건 초과)만 적중 수이고, 전체를 싣는 소규모에서는 null (적중 개념 없음).
  const search = {
    knowledge: knowledge.length,
    qaMethods: qaMethods.length,
    queries: routed ? queries.length : null,
    // 목록을 못 읽어 조회 경로가 통째로 빠진 요청은 '등록이 없어서 못 답한 질문'과 구분되어야 한다 —
    // 둘을 섞으면 chat_log 분석이 지식 보강이 필요한 질문으로 잘못 집계한다.
    ...(queriesFailed && { queriesFailed: true }),
  };

  const history = [];
  const ctx = () => ({ question, chat, knowledge, qaMethods, queries, history });
  const resolveCache = new Map(); // 프롬프트 목록 밖 이름의 해석 결과 (미등록도 캐시한다)
  const clippedCopy = clippedCopyDetector(chat);
  let guardHits = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    // 스텝 수만으로는 소요 시간이 묶이지 않는다 — 느린 LLM 엔드포인트에서는
    // 스텝마다 LLM 타임아웃이 통째로 쌓여 요청 하나가 수십 분씩 워커를 점유한다.
    if (Date.now() > deadline) break;
    const decision = await decide(ctx());
    if (!decision) break; // 결정을 얻지 못했다 — 아래 강제 답변/폴백으로 간다
    if (decision.action === 'answer') {
      const answer = answerOf(decision);
      if (answer) return { answer, trace: history, search };
      break;   // 쓸 수 있는 답변이 아니다 — 아래 강제 답변/폴백으로 간다
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
    // 이 스텝이 실제로 향하는 대상 DB. 가드·이력·실행이 같은 값을 봐야 한다.
    const dbChoice = effectiveTargetDb(registryRow, decision.target_db);
    // note는 LLM에게 경로를 바꾸라고 알리는 제어용 기록이다. 실제 쿼리 실패(error)와 필드를 나눈다 —
    // 같은 필드에 넣으면 사용자 trace 패널과 chat_log의 '실패한 질문' 집계에 정상 턴이 섞인다.
    // extra.safe = 이 문구를 사용자 화면(trace 패널)에 그대로 내보내도 되는가.
    // 우리가 문구를 만든 오류만 true다 — 드라이버·DB 원문은 스키마명·호스트를 담고 있다(server.js가 이 표시를 본다).
    // targetDb는 실패 기록에 dbChoice를 그대로 남긴다 — 성공 기록(아래)은 실행 경계가 돌려준
    // 등록 철자다. 실패의 흔한 원인이 '요청한 이름이 후보에 없다'인데, 그때 등록 철자로 바꿔
    // 적으면 모델은 자기가 무엇을 잘못 적었는지 볼 수 없고 오류 문구와 이력이 서로 다른 이름을
    // 가리키게 된다.
    const push = (field, msg, extra) => history.push({
      query_name: canonicalName, params: decision.params,
      ...(dbChoice && { targetDb: dbChoice }),
      [field]: msg, ...extra,
    });

    const guardNote = loopGuard(history, canonicalName, binds, decision.params, dbChoice);
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
    // 이력의 잘린 셀에서 마크만 떼고 옮겨 적은 바인드 값은 여기서 따로 훑지 않는다 —
    // 판정은 실행 경계 한 곳(oracle.js bindProblem)에서 하고, 이 파일은 그 판정에 필요한
    // '무엇을 잘랐는가'만 넘긴다(clippedCopy). 값을 모으는 비용은 조회 1회당 한 번이고,
    // 스텝마다 이력 전체를 다시 훑지 않는다.
    try {
      // 대상 DB 선택은 실행 경계가 판정한다 (oracle.js resolveTargetDb) — 여기서 미리 고르거나
      // 검증하지 않는다. 돌려받은 targetDb는 등록 철자이므로 이력·trace·프롬프트가 같은 이름을 본다.
      const { rows, totalRows, capped, targetDb } = await runQuery(
        registryRow, decision.params, clippedCopy.isCopy, dbChoice
      );
      clippedCopy.record(rows);
      history.push({ query_name: canonicalName, params: decision.params, targetDb, rows: capRows(rows), totalRows, capped });
      guardHits = 0; // 진도가 나갔다 — 가드는 '연속' 헛도는 경우만 센다
    } catch (e) {
      // 실패도 이력에 남기고 루프를 계속한다 — LLM이 에러를 보고 재시도/우회/답변을 판단.
      // 메시지가 비면 안 된다: error가 falsy면 프롬프트·답변 조립이 이 기록을 '오류'로 보지 않고
      // rows가 있는 정상 결과로 취급해 들어간다.
      push('error', e?.message || String(e), { safe: e?.safe === true, ...(e?.hint && { hint: e.hint }) });
      // 조회를 시작하지도 못하고 거부된 실패(oracle.js wastedStep — 대상 DB를 후보에서 못 골랐다)는
      // 미등록 쿼리 이름과 같은 부류다: DB를 건드리지 않았고, 고를 수 있는 값은 오류 문구가 이미
      // 열거해 줬다. 그래서 같은 연속 카운터로 센다.
      // 이 카운터가 없으면 모델이 매번 다른 틀린 이름을 대는 동안 loopGuard의 동일 실행 판정
      // (이름·대상DB·바인드가 모두 같아야 한다)에 한 번도 걸리지 않아 MAX_STEPS를 전부 소진한다 —
      // 실측: 왕복 5회 + 강제 답변 1회. 조회 성공은 아래에서 카운터를 0으로 되돌리므로,
      // 여러 DB를 차례로 도는 정상 흐름은 이 상한에 걸리지 않는다.
      if (e?.wastedStep && ++guardHits >= MAX_GUARD_HITS) break;
    }
  }

  // 안전장치: MAX_STEPS 초과(또는 가드 반복) 시 강제 답변.
  // 그마저 실패하면 fallbackAnswer가 손에 든 것으로 답을 조립한다.
  const finalCtx = { ...ctx(), forceAnswer: true };
  const final = await decide(finalCtx);
  const answer = answerOf(final) || fallbackAnswer(finalCtx);
  return { answer, trace: history, search };
}

// '이 바인드 값이 우리가 잘라서 보여준 값의 앞부분인가'를 답하는 판정자.
//
// 모델은 잘린 셀을 보면 TRUNC_MARK를 뗀 앞부분만 옮겨 적는 일이 잦다. 그 값으로 조회하면 원본과
// 다르므로 반드시 0건이 나오고, 모델은 그 0건을 "그런 데이터가 없다"로 읽는다 —
// 오류가 한 줄도 남지 않는 오답이라 이 코드베이스가 가장 나쁘게 보는 형태다.
//
// 길이로 짐작하지 않고 '실제로 자른 앞부분'을 모아 두었다가 그대로 대조한다
// (길이 판정의 대가는 oracle.js bindProblem 주석에 적혀 있다). 모델이 그 앞부분을 볼 수 있는
// 곳이 정확히 둘이므로 둘 다 같은 집합에 넣는다:
//   ① 이번 요청의 조회 결과 — 프롬프트의 실행 이력에 셀 값이 그대로 실린다.
//      마크가 붙은 셀에서 마크를 떼어 넣는다 (조회 1회당 한 번, 행 × 컬럼).
//   ② 지난 턴의 답변 — 대화 이력으로 되돌아온 텍스트 안에 '<앞부분>…(생략)'이 그대로 들어 있다.
//      여기서는 앞부분이 어디서 시작하는지가 텍스트만 봐서는 안 보이지만, 알 필요가 없다:
//      그 값을 자른 것이 우리고 clipText는 정확히 두 길이만 남긴다 — MAX_CELL_LEN, 그리고
//      절단 경계가 서로게이트 쌍을 가른 경우의 MAX_CELL_LEN-1. 마크 앞에서 그 두 길이를
//      떼어내면 화면에 실렸던 앞부분이 그대로 복원된다.
//      (앞부분을 '마크에 붙어 있는 문자열'로 찾으면 안 된다 — 그러면 마크 바로 앞에 오는 짧고
//       정당한 값까지 전부 잘린 조각으로 오판한다. 판정은 '값 전체가 그 앞부분과 같은가'여야 한다.)
//      대화 턴이 MAX_CHAT_LEN으로 잘려 앞부분이 온전히 남지 않았으면 복원되지 않는다 —
//      그 경우 모델도 온전한 앞부분을 보지 못했으므로 옮겨 적을 수도 없다.
//
// 그래서 판정은 집합 조회 한 번이다 — 검색도, 길이 분기도 없다.
// (테스트에서 쓰므로 export 한다 — 양쪽으로 조용히 깨지는 판정이다: 느슨해지면 잘린 조각으로
//  조회해 0건 오답이 나가고, 빡빡해지면 정당한 값으로 그 쿼리를 영영 실행할 수 없다.
//  어느 쪽도 오류를 남기지 않으므로 테스트가 유일한 방어선이다 — loopGuard와 같은 이유다.)
const CLIPPED_PREFIX_LENS = [MAX_CELL_LEN, MAX_CELL_LEN - 1];

export function clippedCopyDetector(chat) {
  const clipped = new Set();
  const addFromMark = (text, markAt) => {
    for (const len of CLIPPED_PREFIX_LENS) {
      if (markAt >= len) clipped.add(text.slice(markAt - len, markAt));
    }
  };
  for (const { text } of chat) {
    for (let i = text.indexOf(TRUNC_MARK); i >= 0; i = text.indexOf(TRUNC_MARK, i + 1)) {
      addFromMark(text, i);
    }
  }
  return {
    record(rows) {
      for (const row of rows) {
        for (const v of Object.values(row)) {
          if (typeof v === 'string' && v.endsWith(TRUNC_MARK)) clipped.add(v.slice(0, -TRUNC_MARK.length));
        }
      }
    },
    // oracle.js가 그대로 호출하므로 this에 기대지 않는다 (메서드를 값으로 넘긴다)
    isCopy: v => clipped.has(v),
  };
}

// 결정에서 '쓸 수 있는 답변'만 꺼낸다 (없으면 null).
// 답변이 이 함수를 통해서만 나가게 하는 이유: 답변 경로가 둘인데(루프 안에서 답한 결정, 그리고
// 마지막 강제 답변) 한쪽만 판정을 갖고 있으면 나머지 한쪽이 조용히 그 보호 밖에 남는다.
// 실제로 그랬다 — 강제 답변 쪽만 falsy 검사를 하고 루프 쪽은 결정의 answer를 그대로 돌려줬다.
// 결정 경계(llm.js sanitizeDecision)는 answer의 타입을 일부러 정규화하지 않는다:
// 'falsy한 answer는 폴백으로 간다'는 전제를 지키려고 그렇게 두었는데, 그 전제를 실제로 지키는
// 곳이 한 곳뿐이면 전제가 반쪽만 참이 된다. 빈 답변이 나가면 화면에 빈 말풍선이 뜨고,
// 그 빈 턴이 다음 질문의 맥락으로 서버에 되돌아온다.
// (테스트에서 쓰므로 export 한다)
export const answerOf = d => (d?.action === 'answer' && d.answer) || null;

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
// 크기는 LLM의 답변과 같은 경계로 묶는다 (llm.js clipAnswer). 이 답은 llm.decide를 거치지 않아
// sanitizeDecision의 상한 밖에 있었는데, 조립 재료가 조회 결과(스텝 × 행 × 컬럼)와 지식 본문
// (TEXT 64KB)이라 정상 답변보다 오히려 커질 수 있다 — 실측 57만 자짜리 답변이 응답 본문과
// chat_log.answer로 그대로 나갔다. MAX_ANSWER_LEN이 막겠다고 주석에 적어둔 바로 그 경로다.
export function fallbackAnswer(ctx) {
  const rendered = renderAnswer(ctx);
  return rendered ? clipAnswer(`${LLM_FAILED_NOTE}\n\n${rendered}`) : LLM_FAILED;
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

// 프롬프트에 실을 쿼리를 관련도 순으로 정렬한다. 두 경로의 합집합이다:
//   경로A: 매칭된 qa_method 본문이 지목한 query_name (다단계 절차 보장 — 본문 등장 순서를 지킨다)
//   경로B: 질문으로 query_registry 자체를 하이브리드 검색(LIKE 관련도 + 벡터 RRF) —
//          qa_method 등록 없이 등록된 쿼리도 질문만으로 찾는다
// 지식·처리방법이 같은 hybrid()로 관련도 순을 만드는 것과 같은 순서 규칙이다.
async function rankQueries(qaMethods, question) {
  // 경로A는 '본문에서 이름처럼 보이는 토큰을 뽑아 IN 절로 묻는' 방식이었다. 그 추출식이
  // /[A-Za-z_][A-Za-z0-9_]{2,}/ 라서 한글 query_name은 어떤 본문에서도 한 번도 뽑히지 않았다 —
  // query_name은 VARCHAR(100)에 문자 제한이 없고 이 코드베이스는 다른 곳에 전부 한글을 쓴다.
  // 그러면 '배치상태조회 를 실행한다'라고 적어도 경로A가 빈손이 되어, 이 경로가 존재하는 이유인
  // 다단계 절차의 순서 보장('본문 등장 순서를 지킨다')이 통째로 사라진다. 경로B로 뒤늦게
  // 올라오더라도 순서가 틀리고, 빠졌다는 사실은 어디에도 남지 않는다.
  // 토큰화로는 고칠 수 없는 문제다: 한국어는 조사가 낱말에 붙어 '배치상태조회를'이 한 낱말이므로
  // 이름의 끝을 공백으로 알 수 없고, 조사 변형을 다 만들면 본문의 평범한 낱말들이 상한을 채운다.
  //
  // 그래서 방향을 뒤집는다 — '등록된 이름이 본문에 들어 있는가'를 관리 DB가 직접 본다
  // (db.js loadQueriesMentionedIn). 토큰화가 사라지므로 문자 종류에 좌우되지 않고, 이름 길이
  // 제한(3자 이상)도 없어지며, 등장 위치를 DB가 함께 돌려주므로 순서 보장이 오히려 정확해진다.
  // Mock provider가 같은 판정을 이미 이렇게 하고 있었다 (llm.js plannedQueries의 indexOf) —
  // 두 곳이 '본문이 어떤 쿼리를 지목했는가'를 서로 다르게 답하고 있던 셈이다.
  //
  // 본문은 검색 결과 순서대로 이어 붙인다 — 위치 순서가 곧 '관련도 높은 처리방법 먼저,
  // 그 안에서는 등장 순서대로'가 된다. method는 NOT NULL이지만 컬럼 하나가 완화되거나 임포터가
  // NULL을 넣는 순간 여기서 죽는다 — 이 값의 다른 소비자(llm-openai clip, embed-sync toText)는
  // 전부 NULL을 견딘다. 소문자화는 자르기 전에 한다 (자른 뒤에 하면 길이가 상한을 넘을 수 있다).
  const routeText = clipText(
    qaMethods.map(m => String(m.method ?? '')).join('\n').toLowerCase(),
    MAX_ROUTE_TEXT_LEN
  );
  const [named, direct] = await Promise.all([
    loadQueriesMentionedIn(routeText),
    searchQueries(question),
  ]);

  const seen = new Set();
  const ranked = [];
  for (const q of [...named, ...direct]) {       // 절차용(경로A)을 우선 포함
    if (seen.has(q.seq)) continue;
    seen.add(q.seq);
    ranked.push(q);
  }
  return ranked;
}

// 프롬프트에 실을 쿼리 선정.
// 반환: { list, routed } — routed=false면 등록 전체를 실은 것이므로 '적중 수' 개념이 없다.
//
// 규모와 무관하게 목록은 반드시 '관련도 순'이어야 한다. 프롬프트 예산(llm-openai.js renderQueries)이
// 뒤쪽일수록 덜 관련됐다는 전제로 뒤에서부터 줄이기 때문이다. 등록 30건 이하에서는 관련도 검색을
// 아예 돌리지 않고 저장 순서 그대로 넘기고 있었는데, 그러면 예산이 버리는 것이 '덜 관련된 쿼리'가
// 아니라 '나중에 등록한 쿼리'가 된다 — 하필 방금 등록한 쿼리부터 프롬프트에서 사라지고,
// 로그·trace·chat_log 어디에도 그 사실이 남지 않는다.
// 전체를 싣는 규모에서도 순서를 만들어 그 전제를 참으로 만든다. 추가 비용은 관리 DB 왕복이
// 요청당 최대 3회(이름 조회 + LIKE + 벡터, 실측 평균 +2.75회) 늘어나는 것뿐이다 —
// 질문 임베딩은 지식·처리방법 검색이 이미 계산해 두었고 search.js가 캐시하므로 다시 부르지 않는다.
// 동시 점유는 3으로 CONNS_PER_REQUEST(4) 안이다(db.js 풀 산식 주석에 실측이 적혀 있다).
async function selectQueries(qaMethods, question) {
  // 상한+1건만 읽어 "전체를 실어도 되는 규모인지"를 같은 왕복에서 판정한다.
  // COUNT 후 다시 SELECT하면 매 요청이 왕복 2회 + 풀 점유 2회가 되고, 그렇다고 무조건
  // 전체를 읽으면 등록이 많을 때 대형 SELECT가 된다 — 상한+1은 양쪽 다 피한다.
  // 대가: 라우팅이 도는 규모(등록 30건 초과)에서는 이 31행이 그대로 버려진다.
  // 31행은 상한이 걸린 고정 비용이라 지금은 왕복 1회 쪽이 낫다고 봤다 —
  // 등록이 크게 늘고 설명 컬럼이 길어져 이 전송이 부담이 되면
  // 규모 판정만 `SELECT seq … LIMIT 31`로 떼고 전체 로드를 조건부로 되돌릴 것.
  const head = await loadQueryRegistry(MAX_PROMPT_QUERIES + 1);
  // 등록이 하나도 없으면 순서를 만들 대상이 없다 — 관리 DB 왕복 2회를 태우지 않는다
  if (!head.length) return { list: [], routed: false };
  const routed = head.length > MAX_PROMPT_QUERIES;

  // 관련도 검색이 실패했을 때 무엇을 할지가 규모에 따라 다르다 — 손에 쥔 폴백이 다르기 때문이다.
  //   라우팅 규모: 검색 결과가 곧 목록이다. 폴백이 없으므로 삼키지 않고 호출부로 올린다 —
  //     그래야 chat_log에 queriesFailed로 남아 '등록이 없어서 못 답한 질문'과 구분된다.
  //     여기서 읽어둔 31건으로 대신 채우면 목록은 그럴듯한데 순서는 등록 순서라, 실패가
  //     '정상 라우팅 30건 적중'으로 기록되면서 조용히 사라진다.
  //   전체를 싣는 규모: 등록 목록 전체(head)를 이미 손에 쥐고 있다. 순서만 잃고 계속한다 —
  //     여기서 던지면 이 규모에서는 원래 없던 실패 경로가 새로 생긴다.
  const ranked = routed
    ? await rankQueries(qaMethods, question)
    : await rankQueries(qaMethods, question).catch(e => {
        console.warn('[agent] failed to rank the query list — falling back to registration order:', e.message);
        return [];
      });

  const seen = new Set();
  const list = [];
  // 관련도 순이 먼저, 그다음이 검색에 걸리지 않은 나머지(등록 순서).
  // 라우팅 규모에서는 head가 표본일 뿐이므로 뒤쪽을 붙이지 않는다 — 관련도 없는 31건 중 일부를
  // 채워 넣으면 상한 자리만 차지하고 정작 관련 있는 쿼리를 밀어낸다.
  for (const q of routed ? ranked : [...ranked, ...head]) {
    if (seen.has(q.seq)) continue;
    seen.add(q.seq);
    list.push(q);
    if (list.length >= MAX_PROMPT_QUERIES) break;
  }
  return { list, routed };
}
