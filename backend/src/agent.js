// Agent 처리 루프 — 시스템의 핵심 제어 흐름.
// 질문 → LLM 결정 루프(검색 / 쿼리 실행 / 답변) → 최종 답변.
// 검색은 LLM이 요청할 때만 한다(search 행동). 인사 한 줄에도 지식·처리방법·쿼리 목록을 미리 실어
// 보내던 구조를 뒤집은 것이다 — 그때는 첫 LLM 호출의 prefill이 질문과 무관하게 최대치였다.
// 루프의 유일한 상태는 history 배열(과 검색이 채우는 세 목록)이며, 매 반복 전체 컨텍스트를 LLM에 전달한다.
// 대화 맥락(chat)은 서버가 저장하지 않고 클라이언트가 매 요청에 실어 보낸다 (stateless 유지).
import { searchKnowledge, searchQaMethods, searchQueries } from './search.js';
import { loadQueriesByNames, loadQueriesMentionedIn, loadChunkRanges } from './db.js';
import { canGrow, buildItems, sameChunk, CHUNK_TARGET_LEN, CHUNK_OVERLAP } from './chunk.js';
import { absorbKnowledge, knowledgeView } from './context-items.js';
import { normalizeResultRead, readStoredResult } from './read-result.js';
import { promptParams } from './prompt-values.js';
import { runQuery } from './oracle.js';
import { bindNames } from './sql.js';
import { llm, renderAnswer, clipAnswer } from './llm.js';
import { resolveChartData, resolveTableData, MAX_TABLE_CELL_LEN, MAX_CHART_CELL_LEN } from './chart.js';
import { MAX_STEPS, MAX_SEARCHES, MAX_HISTORY_ROWS, MAX_EXPANDS, MAX_RESULT_READS, MAX_DOC_LEN, MAX_PROMPT_ITEM_LEN, MAX_RESULT_ROWS, parseItemId, MAX_CHAT_TURNS, MAX_CHAT_LEN, MAX_CELL_LEN, TRUNC_MARK, SEARCH_TARGETS, nameKey, clipText, stripLoneSurrogates, bindValue, targetDbNames, indentLines } from './constants.js';

// MAX_STEPS는 constants.js에 있다 — 실행 이력의 프롬프트 몫이 그 값에 묶여 있다.
const MAX_LOOP_MS = 180_000;   // 요청 시작부터 재는 예산(검색 포함). 초과하면 남은 스텝을 포기하고 강제 답변으로 간다.
                               // (스텝 상한과 별개로 필요하다 — 스텝 수는 LLM/조회가 얼마나 느린지를 모른다)
                               // 요청 전체 상한 = 이 값 + 마지막 LLM 호출(120초) + 강제 답변(120초) ≈ 420초.
                               // 프런트(App.jsx REQUEST_TIMEOUT_MS)가 이 계산에 맞춰져 있으니 함께 고칠 것.
const MAX_PROMPT_QUERIES = 30; // 검색 한 번의 쿼리 후보 수. 실제 표시는 별도 예산으로 제한한다.
const MAX_SAME_QUERY_TRIES = 2; // 같은 쿼리·파라미터의 최대 실행 시도 (1회 실패는 일시 오류일 수 있어 재시도 허용)
// 성립하지 않은 검색('검색 불가')의 최대 시도 수. 근거는 위와 같다 — 첫 실패는 일시 오류일 수 있다:
// 임베딩 모델이 유휴 뒤 내려가 다시 올라오는 데 수십 초가 걸리고(search.js warmUpEmbedding), 관리 DB도
// 순간 장애를 낸다. 두 번째까지 실패하면 반복을 끊는다.
const MAX_SAME_SEARCH_TRIES = 2;
// 경로A(qa_method 본문이 지목한 쿼리)에서 이름을 대조할 본문 길이 상한.
// qa_method.method는 TEXT(64KB)이고 검색은 최대 20건을 돌려주므로, 상한이 없으면 요청마다
// 1MB가 넘는 문자열을 등록된 이름마다 훑게 된다.
// 앞쪽이 관련도가 높은 처리방법이고(검색 결과 순서) 절차의 첫 단계도 본문 앞쪽에 온다 —
// 잘려도 다단계 절차의 시작은 남는다 (프롬프트 예산이 꼬리부터 버리는 것과 같은 전제다).
const MAX_ROUTE_TEXT_LEN = 20_000;
export const MAX_GUARD_HITS = 2; // 루프 가드가 '연속으로' 이만큼 걸리면 남은 스텝을 포기하고 강제 답변으로 간다. (테스트에서 쓰므로 export)
                                // (첫 1회는 LLM이 경로를 수정할 기회, 그래도 반복하면 LLM 왕복만 낭비된다.
                                //  조회에 성공하면 진도가 나간 것이므로 카운터를 되돌린다 — 다단계 절차 도중
                                //  같은 쿼리를 두 번 제안했다는 이유로 정상 흐름이 끊기면 안 된다)

// 셀 길이 제한은 드라이버 경계(oracle.js)에서 이미 적용됐다 — 여기서는 행 수만 줄인다.
const capRows = rows => rows.slice(0, MAX_RESULT_ROWS);

// 동일 실행 판정용 파라미터 키 — LLM이 준 원본이 아니라 "실제로 바인드되는 값"으로 만든다.
// runQuery가 SQL의 바인드 변수만 추려 쓰므로, 여분 키 하나가 붙었다고 다른 실행이 되지는 않는다.
// 값과 타입을 함께 비교한다. Oracle은 숫자 1과 문자열 '1'의 비교 결과가 다를 수 있다.
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
// 스칼라는 타입도 남긴다. VARCHAR2 코드가 '01'·'1'일 때 숫자 1로 비교하면 두 행이 나오지만
// 문자열 '1'로 비교하면 한 행만 나온다(실 Oracle 재현). String(v)만 비교하면 그 두 번째 조회를
// 이미 실행한 것으로 생략한다. 거부된 boolean true를 문자열 'true'로 고치는 결정도 구별해야 한다.
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
  if (typeof v !== 'object') return [typeof v, String(v)];
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

// 같은 검색의 판정 키 — 검색어(대소문자·공백 흡수)와 대상 집합(정규 순서)으로 만든다.
// 같은 검색어에 대상만 더한 검색은 새 검색이다 (아직 찾아보지 않은 대상이 있다).
// (테스트에서 쓰므로 export 한다 — loopGuard와 같은 이유로 양쪽으로 조용히 깨진다)
export const searchKey = (text, targets) =>
  JSON.stringify([nameKey(text), SEARCH_TARGETS.filter(t => (targets ?? []).includes(t))]);

// 검색은 보관된 근거를 교체하지 않고 추가한다. 펼친 항목은 표시 우선순위를 유지한다.
const rangeOf = o => (Number.isInteger(o?.from) && Number.isInteger(o?.to) ? [o.from, o.to] : null);
const within = (a, b) => !!(a && b) && a[0] >= b[0] && a[1] <= b[1];

export function mergeFront(list, rows) {
  const front = new Set();
  let progress = 0;
  for (const row of rows) {
    if (row.doc_seq != null) {
      const result = absorbKnowledge(list, row);
      list.push(...result.added);
      result.front.forEach(r => front.add(r));
      progress += result.progress;
    } else {
      const old = list.find(r => r.doc_seq == null && r.seq === row.seq);
      if (!old) { list.push(row); front.add(row); progress++; }
      else if (!old.dropped) {
        if (row.detail && !old.detail) { old.detail = true; progress++; }
        front.add(old);
      }
    }
  }
  // 앞에 고정하는 것 둘: 펼친 항목(expanded — 지식·처리방법)과 모델이 실행한 쿼리(selected — runBatch가 세운다).
  // 실행한 쿼리도 고정하는 이유: 이 검색의 결과가 목록 맨 앞에 오므로, 고정하지 않으면 뒤 검색 한 번이 후보 30건을 그 앞에
  // 쌓아 실행한 쿼리가 목록 스무 번째 뒤로 밀린다. 쿼리 목록은 짧은 줄부터 앞에서 채우고 섹션 천장(PROMPT_CEILINGS.queries)
  // 에서 꼬리를 버리므로, 입력 설명이 긴 등록(한 줄 1,300자 남짓)이면 열댓 줄에서 끝나 실행한 쿼리가 SQL·바인드는커녕
  // 이름조차 프롬프트에서 사라진다(실측 — 퍼저, 43건 중 20번째). 모델은 방금 실행한 쿼리를 '목록에 없는 이름'으로 읽고,
  // 같은 쿼리를 다른 값으로 다시 실행하는 정상 절차(서울 다음 부산)나 오류 뒤 바인드 수정에 근거를 잃는다 —
  // context.md 3절이 '선택된 쿼리의 상세 표시는 다른 후보보다 먼저 예산을 배정한다'고 적은 계약이 정확히 이 자리다.
  const pinned = list.filter(r => (r.expanded || r.selected) && !r.dropped);
  const moving = [...front].filter(r => !pinned.includes(r));
  list.splice(0, list.length, ...pinned, ...moving,
    ...list.filter(r => !pinned.includes(r) && !front.has(r)));
  return progress;
}

// 청크 항목의 범위를 문서당 상한(MAX_DOC_LEN)까지 넓힌다 — 본문 청구(expand)의 실제 동작.
// 읽어올 창은 현재 범위의 앞뒤 GROW_WINDOW개다. 문서 전체를 읽지 않는 이유: 문서는 수백 청크일 수 있고,
// 상한(MAX_DOC_LEN)을 넘는 것은 어차피 버린다. 창은 한쪽만으로도 상한을 채울 만큼 잡는다 — 문서 끝에
// 걸린 적중은 한쪽으로만 넓힐 수 있는데, 상한을 채우기 전에 창이 먼저 바닥나면 이웃을 읽지 못해 full을
// 확정할 수 없고(chunk.js buildItems), 번호가 남은 항목을 모델이 다시 청구하면 그 청구는 한 글자도 늘리지
// 못한 채 MAX_EXPANDS 하나와 왕복 하나를 태운다.
//
// 조각 하나의 순증은 CHUNK_TARGET_LEN이 아니라 CHUNK_TARGET_LEN − CHUNK_OVERLAP이다 — 이어 붙일 때 이음매마다
// 겹침을 떼기 때문이다(chunk.js cutSeam). 12로 두고 "12 × 900 = 10,800 ≥ 10,000"으로 세던 동안 실제로는 13조각
// 9,900자에서 창이 바닥났다: 14번째 조각을 읽지 않았으니 '들어가지 않는다'를 알 수 없어 full이 서지 않고 번호가
// 남았고, 두 번째 청구가 그 조각을 읽어 보고서야 '더 넓힐 수 없다'로 끝났다(실측 — 합성 900자 청크와 마크다운
// 문단 문서의 실제 분할(평균 866자) 모두). 1,000자 청크에서만 우연히 창이 맞았다(11조각 9,500자 + 12번째 읽힘).
// 그래서 상수에서 파생한다: 첫 조각 뒤로 창을 채우는 데 드는 조각 수, +1은 상한에 들어가지 않는 첫 이웃까지
// 읽어 그 자리에서 full을 확정하기 위한 것, +1은 목표보다 조금 짧은 조각의 여유다(짧을수록 순증이 준다 —
// 800자면 650자). 그보다 훨씬 짧은 조각(경계를 못 찾아 540자까지 내려간 문서)은 두 번째 청구가 이어받는다.
// 실패하면 null을 돌려 호출부가 '진도 없음'으로 처리하게 한다 (요청을 버리지 않는다).
// (테스트에서 쓰므로 export 한다)
export const GROW_WINDOW = Math.ceil((MAX_DOC_LEN - CHUNK_TARGET_LEN) / (CHUNK_TARGET_LEN - CHUNK_OVERLAP)) + 2;
// 계측에 남길 지식 적중 수 (검색 한 번당). chat_log의 trace가 요청마다 커지지 않게 상위만 센다.
const TOP_TRACE = 5;

async function growItem(row, loadChunks = loadChunkRanges) {
  const lo = Math.max(1, row.from - GROW_WINDOW);
  const hi = Math.min(row.chunk_of, row.to + GROW_WINDOW);
  try {
    const rows = await loadChunks([{ doc_seq: row.doc_seq, from: lo, to: hi }]);
    // 동기화가 요청 도중 원문을 갱신할 수 있다. 이미 확보한 청크가
    // 바뀌었으면 다른 판본으로 확대하지 않고 기존 근거를 보존한다.
    const byNo = new Map(rows.map(chunk => [chunk.chunk_no, chunk]));
    if (row.chunks?.some(chunk => !sameChunk(chunk, byNo.get(chunk.chunk_no)))) return null;
    // buildItems에 grow=true를 주면 계획된 범위를 넘어 상한까지 채운다. 대표 청크(rep)를 그대로
    // 넘기는 것이 중요하다: 중심이 옮겨 다니면 두 번째 청구가 첫 번째가 준 구간을 되밟고, 무엇보다
    // 항목의 seq가 대표 청크의 것이라 중심이 바뀌면 seq도 바뀐다 — 모델이 방금 청구한 번호가
    // 다음 스텝에 사라진다 (chunk.js buildItems의 rep 주석).
    const [item] = buildItems(
      [{ doc_seq: row.doc_seq, rep: row.rep ?? row.from, from: row.from, to: row.to, chunk_of: row.chunk_of, dist: row._dist }],
      rows, { maxDocLen: MAX_DOC_LEN, grow: true }
    );
    return item && within(rangeOf(row), rangeOf(item)) ? item : null;
  } catch (e) {
    console.warn('[agent] chunk expand failed:', e?.message ?? e);
    return null;
  }
}

// 검색 한 번의 기록 — history에 남아 프롬프트 한 줄·chat_log·화면 trace로 나간다.
//   search: 검색어, targets: 검색한 대상, hits: 대상별 적중 수(검색하지 않은 대상은 null),
//   failed: 검색이 성립하지 않은 대상(임베딩·벡터 검색 실패 — '0건'이 아니다), note: 실행하지 않은 이유(가드).
// hits의 키는 ctx 목록 이름과 같다 — chat_log의 search 요약과 같은 이름을 쓰게.
const HIT_KEY = { knowledge: 'knowledge', qa_method: 'qaMethods', query: 'queries' };

export async function handleQuestion(rawQuestion, rawChat = [], { onEvent, deps } = {}) {
  // deps는 테스트가 검색·조회·LLM을 스텁으로 바꿔 끼우는 자리다. 이 루프의 판정(검색 반복·상한·강제
  // 답변 전환·이력 기록 모양)은 DB 없이 검증할 수 있어야 한다 — loopGuard를 순수 함수로 떼어낸 것과
  // 같은 이유다: 어긋나도 오류를 남기지 않는 종류의 실패라 테스트가 유일한 방어선이다.
  const { search = runSearch, run = runQuery, decide: decideFn = llm.decide, loadChunks = loadChunkRanges } = deps ?? {};
  const question = normalizeQuestion(rawQuestion);
  const chat = normalizeChat(rawChat);
  const started = Date.now();
  // 예산은 요청 시작점에서 잡는다 — 검색(임베딩 타임아웃 최대 60초)도 이 예산 안에서 돈다.
  const deadline = started + MAX_LOOP_MS;

  // 구간별 소요(ms). 어디가 느린지는 이 숫자 없이는 알 수 없다 — 로그 한 줄과 chat_log(trace.timing)로 나간다.
  const timing = { llm: [], search: [], oracle: [] };
  const timed = async (bucket, fn) => {
    const t0 = Date.now();
    try { return await fn(); } finally { bucket.push(Date.now() - t0); }
  };
  // 진행 이벤트(검색·조회의 시작과 끝). 듣는 쪽(server.js의 스트림 응답)이 던져도 루프는 계속된다 —
  // 화면 표시가 답을 막으면 안 된다.
  const emit = (type, data) => {
    if (!onEvent) return;
    try { onEvent({ type, ...data }); } catch (e) { console.warn('[agent] progress listener failed:', e?.message ?? e); }
  };

  // 세 목록은 비어서 시작하고 search 행동이 채운다 (파일 머리말).
  // searched = 한 번이라도 '찾아본' 대상, succeeded = 그중 검색이 실제로 '성립한' 대상.
  // 프롬프트에 나가는 것은 succeeded다 — 그 이유는 아래 ctx 주석에 있다.
  const knowledge = [], qaMethods = [], queries = [];
  const searched = new Set();
  const succeeded = new Set();   // 검색이 실제로 성립한 대상 — chat_log의 적중 수는 이쪽 기준이다 (아래 done 주석)
  const targetCounts = Object.fromEntries(SEARCH_TARGETS.map(t => [t, 0]));
  let queriesFailed = false;     // 관리 DB에서 쿼리 목록을 못 읽었다
  let searchFailed = false;      // 어느 검색이든 성립하지 않은 대상이 있었다
  const history = [];
  // 프롬프트에는 성공한 검색 대상과 남은 행동 수를 전달한다.
  // 조회 원본·실행 이력은 유지하고 resultViews로 해당 실행의 표시 범위만 교체한다.
  const ctx = () => ({
    question, chat, knowledge, qaMethods, queries,
    history: history.map(h => resultViews.has(h) ? { ...h, ...resultViews.get(h) } : h),
    contextNote, resultReadsLeft: Math.max(0, MAX_RESULT_READS - resultReads),
    searched: [...succeeded], tried: searched.size > 0,
    canExpand: expands < MAX_EXPANDS, canSearch: searches < MAX_SEARCHES,
    queriesLeft: Math.max(0, Math.min(MAX_STEPS - runs, MAX_HISTORY_ROWS - history.length)),
    // expandsLeft — 남은 청구 수. 상한보다 적어지면 지시 블록이 그 수를 말한다: 하나 남은 자리에 번호 둘을 적은 결정에서
    // 둘째 번호가 안내 한 줄 없이 버려졌다(applyExpand의 break — 실측). 다음 프롬프트에서 남은 수를 알려야 한다.
    expandsLeft: Math.max(0, MAX_EXPANDS - expands),
  });
  // 성공한 조회의 전체 행(≤MAX_ROWS). history에는 capRows로 자른 20행만 싣는다 — history는 프롬프트와
  // chat_log(steps)로 흘러가므로 거기에 전체를 실으면 둘이 함께 다섯 배 커진다.
  // 전체 행이 필요한 곳은 둘이다: 답변의 차트 참조(`data: step N`, 아래 finish)와 화면 trace 패널
  // (server.js → result.js clientTrace — 사용자가 조회된 행 전부를 보는 유일한 자리다). 둘 다 이 요청의
  // 응답 안에서 끝나므로 history와 나란히 들고 있다가 함께 돌려준다.
  const fullRows = new Map();
  const resultViews = new Map();
  const readKeys = new Map();
  let resultReads = 0;
  let contextNote = '';
  // 답변이 나가는 두 출구(모델의 answer, 강제 답변)가 같은 마무리를 지난다 — 표 참조(```table step: N)와 차트 참조
  // (data: step N)를 실제 행으로 채운다. 스텝 번호는 history의 1-based 절대 인덱스(프롬프트의 'N.'과 같다 —
  // 검색 줄도 번호를 차지한다, chart.js 주석 참고).
  const finish = answer => {
    const stepRows = history.map(h => fullRows.get(h) ?? null);
    return resolveChartData(resolveTableData(answer, stepRows), stepRows);
  };
  const resolveCache = new Map(); // 프롬프트 목록 밖 이름의 해석 결과 (미등록도 캐시한다)
  const clippedCopy = clippedCopyDetector(chat);
  // LLM 호출 하나의 계측 항목은 {ms, prompt?, completion?}이다 — 토큰 실측은 provider가 훅으로 준다
  // (llm-openai.js openaiDecide의 onUsage). 검색 후보 수·검색 횟수 상한을 조정할 근거가 이 숫자다 (README).
  // 답변 조각 훅(onAnswerDelta)은 화면 미리보기다 — 최종 답변은 아래 finish가 확정한다.
  const decideSafe = async c => {
    const entry = { ms: 0 };
    timing.llm.push(entry);
    const t0 = Date.now();
    try {
      return await decide({
        ...c,
        onUsage: u => {
          // 파싱 실패 뒤 재시도까지 실제 사용량에 합산한다.
          for (const [key, value] of [['prompt', u.prompt_tokens], ['completion', u.completion_tokens], ['cached', u.prompt_tokens_details?.cached_tokens]]) {
            if (Number.isFinite(value) && value >= 0) entry[key] = (entry[key] ?? 0) + value;
          }
        },
        // 듣는 쪽이 없으면 훅을 주지 않는다 — provider는 이 훅이 있을 때만 답변 미리보기를 조립하므로
        // (llm-openai.js answerPreviewer), 스트림을 요청하지 않은 요청에서 그 해독을 조각마다 헛돌게 하지 않는다.
        ...(onEvent && {
          onAnswerDelta: d => emit(d?.reset ? 'answer_reset' : 'answer_delta', d?.reset ? {} : { text: d.text }),
        }),
      }, async input => {
        // 성공·오류·가드 안내 모두 params를 표시한다. 그 호출에 보인 절단 조각을 기억해야
        // 모델이 표시를 떼고 재조회해도 '다른 파라미터'로 실행되지 않는다.
        // 표시 변환의 실패도 decide의 기존 예외 경계에서 처리한다.
        for (const h of input.history) clippedCopy.recordParams(h.params);
        return decideFn(input);
      });
    } finally {
      entry.ms = Date.now() - t0;
    }
  };
  let guardHits = 0;
  let queryEventSeq = 0;         // 조회 진행 이벤트의 짝 번호 (아래 emit 주석)
  let expands = 0;               // 확대·복구·우선 표시 수 (≤ MAX_EXPANDS)
  let drops = 0;                 // 모델이 버린 항목 수
  let searches = 0;              // 실제로 실행한 검색 수 (≤ MAX_SEARCHES)
  const topHits = [];            // 지식 적중의 (문서, 거리) — 계측 전용 (absorb 주석)
  let runs = 0;                  // run_query 결정 수 — 가드에 걸린 것도 이력 한 줄이므로 함께 센다 (≤ MAX_STEPS).
                                 // 이 두 상한이 실행 이력의 최소 몫(constants PROMPT_FLOORS.history)의 근거다.

  // 식별자로 자료를 찾는 두 손잡이. 목록 이름은 식별자가 정한다 (constants.parseItemId).
  const lists = { knowledge, qaMethods };
  const rowAt = id => {
    const at = parseItemId(id);
    const list = at && lists[at.list];
    return list ? { list, i: list.findIndex(o => o.seq === at.seq) } : { list: null, i: -1 };
  };

  // 숨김은 search·expand에 붙인다. 요청 안의 원본과 ID를 남겨 재검색으로 되살아나지 않게 한다.
  const applyDrop = ids => {
    let n = 0;
    for (const id of ids ?? []) {
      const { list, i } = rowAt(id);
      if (i < 0 || list[i].dropped) continue;   // 목록에 없거나 이미 버린 것은 조용히 넘긴다
      list[i].dropped = true;
      n++;
      drops++;
    }
    return n;
  };

  // 청구가 '앞으로 가져오기'로 할 수 있는 일이 남았는가. 없으면 그 이유를 돌려준다.
  //   front   — 이미 목록 맨 앞이라 옮길 자리가 없다. 그 자리는 문서별 첫 항목이자 renderItems가 '첫 본문 한 건은
  //             반드시 싣는다'로 보장하는 자리라, 옮기지 못한다는 것과 이미 실려 있다는 것이 같은 말이다.
  //   covered — 같은 문서의 앞선 항목이 이 항목의 청크를 이미 전부 싣고 있다 (knowledgeView의 covered).
  //             확대가 다른 보관 구간을 통째로 삼킨 뒤의 상태다. 삼켜진 구간은 ID가 남으므로 본문 없이
  //             '- (보관 중, expand로 다시 표시: k37)'로 안내되는데, 모델이 그 안내를 그대로 따르면 새로 보이는
  //             글자는 없이 문서 상한(MAX_DOC_LEN)만 나눠 쓰게 되어 지금 보이던 본문이 줄어든다
  //             (퍼저 실측: 한 문서의 실린 청크가 12개에서 10개로). 청구가 보여주던 것을 도로 가져가는 셈이다.
  // 넓힐 것이 남은 청구는 이 판정보다 먼저 처리한다 — 삼켜진 구간이라도 문서 바깥쪽으로는 더 읽을 수 있고,
  // 그때 늘어난 본문은 어느 항목도 싣고 있지 않은 진짜 새 내용이다.
  const noRoomToBringForward = (row, i) => {
    if (i === 0) return 'front';
    if (row.doc_seq == null) return null;
    return knowledgeView(knowledge).find(view => view.seq === row.seq)?.covered ? 'covered' : null;
  };

  // 확대·복구한 항목은 앞에 고정한다. 이후 검색도 이 우선순위를 유지한다.
  // done은 성공한 ID, saturated는 읽어도 본문이 늘지 않은 수, unread는 DB 읽기 실패 수,
  // covered는 이미 다른 항목으로 전부 실려 있어 청구할 것이 없던 수다.
  const applyExpand = async ids => {
    const done = [];
    let saturated = 0;
    let unread = 0;
    let covered = 0;
    for (const id of ids ?? []) {
      if (expands >= MAX_EXPANDS) break;
      const { list, i } = rowAt(id);
      if (i < 0) continue;
      const row = list[i];
      // 숨긴 자료의 복원은 저장된 본문으로 끝낸다. DB 읽기나 재검색이 필요 없다.
      // 숨김은 먼저 걷는다 — 모델이 그만두겠다고 한 일이고, 아래 판정도 숨김이 걷힌 상태를 봐야 답이
      // 맞는다(knowledgeView는 숨긴 항목을 건너뛰므로 dropped인 채로는 '이미 실려 있는가'를 물을 수 없다).
      if (row.dropped || (row.expanded && i > 0)) {
        row.dropped = false;
        // 앞으로 가져오는 일만 따로 막는다: 이 항목의 청크가 이미 같은 문서의 앞선 항목으로 전부 실려 있으면
        // 맨 앞으로 옮겨도 새로 보이는 글자는 없이 문서 상한(MAX_DOC_LEN)만 나눠 쓰게 되어, 지금 보이던 본문이
        // 그만큼 줄어든다 — 아래 !canGrow·포화 갈래가 covered로 막는 것과 같은 손해이고, 시스템 프롬프트가
        // '넓힌 본문이 자리를 많이 쓰므로 더는 필요 없는 자료를 함께 적어라'로 권하는 흐름이 곧 이 자리다:
        // 확대와 함께 버린 번호를 나중에 되살리면 그 확대가 삼킨 구간을 앞으로 부르게 된다
        // (실측: 확대가 8~10을 삼킨 뒤 그 번호를 drop했다가 복구하니 실린 청크가 17개에서 10개로 줄었다).
        // 숨김을 걷은 것 자체는 되돌리지 않는다 — 그 항목은 다시 보관 목록의 일부이고, 앞선 항목이 나중에
        // 버려지거나 좁아지면 그때 저절로 실린다.
        if (noRoomToBringForward(row, i) === 'covered') { covered++; continue; }
        row.expanded = true;
        list.splice(i, 1);
        list.unshift(row);
        expands++;
        done.push(id);
        continue;
      }
      if (row.doc_seq != null) {
        // 청구한 구간의 ID를 유지하며 앞뒤 청크를 읽는다. 다른 구간은 캐시에 그대로 남는다.
        if (!canGrow(row)) {
          // 표시 예산에 밀린 구간도 같은 ID로 앞으로 가져올 수 있다 — 옮길 자리와 실을 것이 남아 있을 때만이다.
          const blocked = noRoomToBringForward(row, i);
          if (blocked === 'covered') { covered++; continue; }
          if (blocked) continue;
          row.expanded = true;
          list.splice(i, 1);
          list.unshift(row);
          expands++;
          done.push(id);
          continue;
        }
        const grown = await growItem(row, loadChunks);
        // 본문이 늘지 않아도(읽기 실패·상한 포화) 청구에는 할 일이 하나 남아 있다 — '앞으로 가져오기'다.
        // 그 일은 DB를 읽지 않으며, 표시 예산에 밀려 보관 목록에만 있던 항목에는 그것이 곧 '본문이 실리는가'를
        // 가른다. 시스템 프롬프트가 "보관 목록의 ID를 청구하면 저장된 본문을 다시 우선 표시한다"고, context.md 2절이
        // "expand는 … 보관된 항목을 앞으로 가져온다"고 내건 약속이 이 자리다. 두 갈래에서 그대로 continue 하던 동안
        // 그 약속이 깨졌다: 프롬프트가 '- (보관 중, expand로 다시 표시: k37)'로 이름을 대 준 항목을 모델이 그대로
        // 청구했는데 본문은 끝내 실리지 않고, 안내는 '지금 범위로 답변하라'라 — 모델은 본 적 없는 범위로 답하라는
        // 말을 듣는다. 둘뿐인 청구 기회가 그렇게 둘 다 사라지면 강제 답변으로 넘어간다(퍼저 실측).
        // 그래서 판정을 '늘었는가'가 아니라 '이 청구로 할 수 있는 일이 남았는가'로 옮긴다. 남은 일이 없는 경우는
        // 하나뿐이다 — 이미 목록 맨 앞이면 옮길 자리가 없고, 그 자리는 반드시 표시된다(문서별 첫 항목이자
        // renderItems의 '첫 본문 한 건은 반드시 싣는다'). 위 !canGrow 갈래가 쓰는 것과 같은 기준이다.
        if (!grown) {
          // 읽기 실패 — 판정(full)할 근거가 없으니 기존 본문과 표시를 그대로 보존한다.
          const blocked = noRoomToBringForward(row, i);
          if (blocked === 'covered') { covered++; continue; }
          if (blocked) { unread++; continue; }
        } else {
          // seq는 덮어쓰지 않는다. 모델이 지목한 번호가 그 스텝에 바뀌면 방금 청구한 항목을 다시
          // 청구할 수도 버릴 수도 없다 — 'seq는 요청 내내 고정'이 식별자 설계의 근거다
          // (constants.js ITEM_PREFIX). rep을 그대로 넘기므로 지금은 같은 값이 오지만, 그 계약을
          // 호출 인자에 기대지 않고 여기서 구조로 못 박는다.
          const { seq: _ignored, ...widened } = grown;
          const progressed = grown.content.length > row.content.length;
          // 늘지 않았어도 판정(full)은 받아 적는다 — 그래야 다음 프롬프트에서 확대 표시가 사라진다. 이 표시를 세우지
          // 않으면 모델은 같은 번호를 다시 청구하고, 그 헛도는 스텝이 둘이면 강제 답변으로 넘어간다(실측).
          Object.assign(row, widened);
          if (!progressed) {
            const blocked = noRoomToBringForward(row, i);
            if (blocked === 'covered') { covered++; continue; }
            if (blocked) { saturated++; continue; }   // 옮길 자리도 없고 늘지도 않았으면 진도가 아니다
          }
        }
        // 핀 표시. mergeFront가 이 표시로 펼침 구간을 알아보고 그 뒤에 새 검색 결과를 끼운다 —
        // 표시를 세우지 않으면 다음 검색이 청구한 구간을 그대로 앞에서 밀어낸다.
        row.expanded = true;
      } else {
        if (row.expanded) continue;                  // 청크가 아닌 항목(qa_method)은 한 번만 펼친다
        // 이미 맨 앞에 온 짧은 항목은 확대도 우선순위 변경도 할 필요가 없다.
        if (i === 0 && indentLines(list === qaMethods ? row.method : row.content).length <= MAX_PROMPT_ITEM_LEN) continue;
        row.expanded = true;
      }
      // 펼친 항목은 목록 맨 앞으로. 예산이 뒤에서부터 버리므로 그 자리라야 살아남는다.
      list.splice(i, 1);
      list.unshift(row);
      expands++;
      done.push(id);
    }
    return { done, saturated, unread, covered };
  };

  // 이력 줄은 상한이 있다 — 자리가 없으면 안내를 접는다. 그때는 루프가 곧 그 상한에서 멈추므로
  // 모델이 그 안내를 읽을 스텝 자체가 없다 (constants.MAX_HISTORY_ROWS).
  const pushNote = row => { if (history.length < MAX_HISTORY_ROWS) history.push(row); };

  // 요청의 결과를 조립한다. 검색 요약(chat_log 분석용): 검색 횟수와 대상별 횟수, 대상별 누적 적중 수,
  // 그리고 목록·검색이 성립하지 않았다는 표시. 적중 수는 '검색이 성립한 적 있는' 대상만 숫자다 —
  // 한 번도 찾지 않았거나 찾을 때마다 실패한 대상은 null이다. 0으로 적으면 '찾았는데 없다'와 섞여
  // chat_log 분석이 임베딩 장애 동안의 질문을 전부 '지식 보강 후보'로 잘못 집계한다 (README의 SQL).
  const done = (answer, forced) => {
    const total = Date.now() - started;
    const summary = {
      searches,
      targets: { ...targetCounts },
      knowledge: succeeded.has('knowledge') ? knowledge.length : null,
      qaMethods: succeeded.has('qa_method') ? qaMethods.length : null,
      queries: succeeded.has('query') ? queries.length : null,
      // 모델이 자료를 얼마나 손봤는가 — 자주 버려지는 지식은 등록 품질 신호다 (README의 운영 루프).
      ...(expands && { expanded: expands }),
      ...(drops && { dropped: drops }),
      ...(resultReads && { resultReads }),
      ...(topHits.length && { top: topHits }),
      ...(queriesFailed && { queriesFailed: true }),
      ...(searchFailed && { searchFailed: true }),
    };
    const sum = a => a.reduce((x, y) => x + y, 0);
    const llmMs = sum(timing.llm.map(l => l.ms));
    const tokens = timing.llm.some(l => l.prompt !== undefined)
      ? `, prompt ${sum(timing.llm.map(l => l.prompt ?? 0))} tok, completion ${sum(timing.llm.map(l => l.completion ?? 0))} tok`
      : '';
    console.log(
      `[agent] timing total=${total}ms llm=${timing.llm.length}(${llmMs}ms${tokens}) ` +
      `search=${timing.search.length}(${sum(timing.search)}ms) oracle=${timing.oracle.length}(${sum(timing.oracle)}ms)` +
      `${forced ? ' forced' : ''}`
    );
    return { answer, trace: history, search: summary, fullRows, timing: { total, ...timing } };
  };

  // 검색 결과를 컨텍스트에 흡수하고 이력 기록의 재료를 만든다. 넣은 항목 수도 돌려준다 (0이면 진도가 없다).
  const absorb = (r, targets) => {
    const want = new Set(targets);
    const hits = { knowledge: null, qaMethods: null, queries: null };
    const failed = [];
    let added = 0;
    const take = (target, rows, list) => {
      if (rows === undefined) return;                       // 요청하지 않은 대상
      searched.add(target);
      targetCounts[target]++;
      if (rows === null) { failed.push(target); return; }   // 검색이 성립하지 않았다 — 0건과 다르다
      succeeded.add(target);
      hits[HIT_KEY[target]] = rows.length;
      // 거리·구간·청크 수를 함께 기록한다. 정답 여부는 평가셋으로 판단한다.
      if (target === 'knowledge') {
        for (const r of rows.slice(0, TOP_TRACE)) {
          if (r?.doc_seq != null) topHits.push({ doc: r.doc_seq, d: Math.round(r._dist * 1000) / 1000,
            from: r.from, to: r.to, chunks: r.chunks?.length });
        }
      }
      added += mergeFront(list, rows);
    };
    take('knowledge', r.knowledge, knowledge);
    take('qa_method', r.qaMethods, qaMethods);
    // 쿼리 목록은 경로A(처리방법이 지목)만으로도 실린다 — 그때는 'query'를 검색한 것이 아니므로 searched에 넣지 않는다.
    if (r.queries !== undefined) {
      if (want.has('query')) { searched.add('query'); targetCounts.query++; }
      // '검색 불가'도 찾아본 대상에만 적는다. 경로A만 돈 검색(query를 찾지 않았다)에서 관리 DB가 목록을 못 읽으면
      // r.queries가 null인데, 그것을 failed에 넣으면 이력 줄이 `[처리방법] → 처리방법 1건 · 쿼리 검색 불가`가 된다 —
      // 찾지도 않은 대상이 '검색이 성립하지 않았다'로 적히고(context.md 1-), 모델은 시스템 프롬프트의 '검색 불가면
      // 자료를 확인할 수 없다고 밝혀라'를 따라 query 검색을 시도조차 않고 답한다. chat_log에는 searchFailed가 서서
      // 임베딩 장애로 집계된다(README의 분석 SQL). 그 실패는 queriesFailed가 따로 남기고(아래), 모델은 목록이 없는
      // 처리방법을 보고 query를 검색하거나 이름을 지목하므로(resolveQuery) 관리 DB가 살아나면 그 자리에서 이어진다.
      if (r.queries === null) {
        if (want.has('query')) failed.push('query');
      } else {
        // succeeded는 한 번 성립하면 계속 유지된다(Set은 덧셈만 한다) — 앞선 검색이 목록을 채워 놓고도
        // 뒤이은 검색이 관리 DB 실패로 null을 주는 순간 지워지면, chat_log에는 '한 번도 못 찾았거나
        // 매번 실패했다'로 남아(README의 분석 SQL) 정반대로 읽힌다.
        if (want.has('query') && !r.directFailed) succeeded.add('query');
        // 경로A만 돈 검색(query를 찾지 않았다)에서 지목된 쿼리가 없으면 적중 수를 적지 않는다(null). '쿼리 0건'으로
        // 실리면 찾아보지 않은 대상이 '찾았는데 없다'로 보여, 모델은 query 검색을 이미 한 것으로 읽고 건너뛴다 —
        // 프롬프트가 세 상태를 가르는 이유가 정확히 그것이다(llm-openai.js section 주석, context.md 1-). 실측.
        if (want.has('query') || r.queries.length) hits.queries = r.queries.length;
        // 이미 있던 행의 자세한 표시(detail)는 병합이 옮겨 받아 진도로 센다 (mergeFront 주석).
        added += mergeFront(queries, r.queries);
      }
    }
    if (r.queriesFailed) queriesFailed = true;
    if (r.directFailed && !failed.includes('query')) failed.push('query');
    if (failed.length) searchFailed = true;
    return { added, hits, failed };
  };

  // 조회 결정(하나 또는 일괄)을 실행한다. 두 단계다.
  //   ① 순차 준비 — 이름 해석·루프 가드·미등록 판정. 실행할 항목은 자리(entry)를 먼저 이력에 넣어 배치 순서를
  //      지킨다: 병렬 실행이 끝나는 순서는 정해져 있지 않고, 이력의 번호는 프롬프트·차트·표 참조가 보는 값이다.
  //   ② 병렬 실행 — 각 항목의 결과를 자기 자리에 채운다. 단일 조회도 항목 하나짜리 배치다 — 길이 하나여야
  //      한쪽만 조용히 어긋나지 않는다.
  // 반환: progressed(하나라도 성공했다), wasted(전부 실행 없이 헛돈 항목이었다 — 가드·미등록·대상 DB 미선택).
  // 실패의 종류에 따라 이력 필드를 나눈다: note는 LLM에게 경로를 바꾸라고 알리는 제어용 기록이고 error는 실제
  // 실패다 — 같은 필드에 넣으면 사용자 trace 패널과 chat_log의 '실패한 질문' 집계에 정상 턴이 섞인다.
  // safe는 이 문구를 사용자 화면에 그대로 내보내도 되는가 — 우리가 문구를 만든 오류만 true다 (드라이버·DB 원문은
  // 스키마명·호스트를 담고 있다). 실패 기록의 targetDb는 모델이 고른 값(dbChoice) 그대로다 — 성공 기록은 실행 경계가
  // 돌려준 등록 철자인데, 실패의 흔한 원인이 '요청한 이름이 후보에 없다'라 등록 철자로 바꿔 적으면 모델은 자기가
  // 무엇을 잘못 적었는지 볼 수 없다.
  const runBatch = async batch => {
    const planned = [];
    const seenInBatch = new Set();
    let wastedCount = 0;
    for (const item of batch) {
      const { row: registryRow, error: resolveError, hint: resolveHint } =
        await resolveQuery(item.query_name, queries, resolveCache);
      // 이력에는 항상 정규 이름(등록된 철자)을 남긴다 — 가드와 프롬프트가 같은 이름을 보게.
      const canonicalName = registryRow?.query_name ?? item.query_name;
      const binds = registryRow ? bindNames(registryRow.query_sql) : null;
      // 이 항목이 실제로 향하는 대상 DB. 가드·이력·실행이 같은 값을 봐야 한다.
      const dbChoice = effectiveTargetDb(registryRow, item.target_db);
      const base = { query_name: canonicalName, params: item.params, ...(dbChoice && { targetDb: dbChoice }) };
      // 같은 배치 안의 중복은 아직 이력에 없어 루프 가드가 못 본다 — 같은 키로 여기서 잡는다.
      const dupKey = JSON.stringify([nameKey(canonicalName), nameKey(dbChoice), paramKey(binds, item.params)]);
      const guardNote = loopGuard(history, canonicalName, binds, item.params, dbChoice)
        ?? (seenInBatch.has(dupKey) ? '같은 배치 안에 같은 조회가 둘 있다 — 하나만 실행한다' : null);
      if (guardNote) {
        history.push({ ...base, note: guardNote });
        wastedCount++;
        continue;
      }
      if (!registryRow) {
        // 미등록 이름의 반복이 '가장 흔한 퇴화 패턴'(loopGuard 주석)인데, 모델이 매번 다른 이름을 지어내면
        // 동일 실행 판정에는 한 번도 걸리지 않는다 — 이름이 무엇이든 '실행 없이 헛돈 항목'으로 센다.
        history.push({
          ...base, error: resolveError ?? '등록되지 않은 쿼리', safe: true,
          hint: resolveHint ?? '쿼리 목록에 있는 이름만 실행할 수 있다 — 목록에서 고르거나 query를 검색하거나 지금까지의 정보로 답변하라',
        });
        wastedCount++;
        continue;
      }
      // 모델이 지목한 쿼리는 다음 스텝에 자세한 형태(입출력 설명·SQL)로 보인다 — 바인드를 고칠 수 있어야 한다
      // (llm-openai.js renderQueries 주석). 프롬프트 목록 밖에서 찾은 쿼리는 목록 앞에 넣는다: 뒤가 아니라 앞이다 —
      // 프롬프트 예산은 '뒤쪽일수록 관련도가 낮다'는 전제로 꼬리부터 버린다. 중복은 넣지 않고, 이 경로가
      // 늘리는 상한은 MAX_STEPS건이다. 목록 전체의 상한은 그것과 다르다 — MAX_PROMPT_QUERIES는 검색 한 번이
      // 돌려주는 수이고(selectQueries의 slice) 목록은 검색마다 병합되므로, 최악은
      // MAX_SEARCHES × MAX_PROMPT_QUERIES + MAX_STEPS까지 자란다. 그래도 프롬프트가 넘치지는 않는다:
      // renderQueries가 짧은 줄부터 확보하고 남는 만큼만 자세히 올린 뒤 꼬리를 버린다.
      registryRow.detail = true;
      registryRow.selected = true;
      const previousIndex = queries.indexOf(registryRow);
      if (previousIndex >= 0) queries.splice(previousIndex, 1);
      queries.unshift(registryRow);
      seenInBatch.add(dupKey);
      const entry = { ...base };
      history.push(entry);
      // 진행 이벤트의 짝 번호. 일괄 조회는 조회 여럿이 동시에 돌고 끝나는 순서가 시작 순서와 다르므로,
      // 듣는 쪽이 '어느 줄의 끝인가'를 이름으로 짐작하면 안 된다 — 같은 쿼리를 다른 값으로 두 번 부르는
      // 정당한 배치도 있고, 시작 이벤트의 대상 DB는 모델이 적은 철자인데 끝 이벤트는 실행 경계가 돌려준
      // 등록 철자라 둘이 다를 수 있다(oracle.js resolveTargetDb). 번호는 요청 안에서만 뜻이 있다.
      planned.push({ entry, registryRow, item, dbChoice, canonicalName, id: ++queryEventSeq });
    }

    let progressed = false;
    // 배치의 조회 시간은 '실제로 흐른 시간'으로 한 번만 잰다. 항목마다 재면 병렬로 겹친 시간이 그 수만큼
    // 더해져(4건이 2초에 끝나도 8초로 남는다) 계측이 조회 몫을 부풀린다 — README가 그 숫자를 보고
    // 검색 후보 수·검색 횟수를 조정하라고 가리키는데, 부풀린 값은 그 판단을 반대로 이끈다.
    // 실행할 것이 하나도 없으면(전부 가드·미등록) 아예 재지 않는다 — 0ms짜리 항목이 조회 횟수를 부풀린다.
    if (!planned.length) return { progressed, wasted: wastedCount === batch.length };
    await timed(timing.oracle, () => Promise.all(planned.map(async ({ entry, registryRow, item, dbChoice, canonicalName, id }) => {
      emit('run_query', { id, query_name: canonicalName, params: item.params, ...(dbChoice && { targetDb: dbChoice }) });
      // 이력의 잘린 셀에서 마크만 떼고 옮겨 적은 바인드 값은 여기서 따로 훑지 않는다 — 판정은 실행 경계 한 곳
      // (oracle.js bindProblem)에서 하고, 이 파일은 그 판정에 필요한 '무엇을 잘랐는가'만 넘긴다(clippedCopy).
      try {
        // 대상 DB 선택은 실행 경계가 판정한다 (oracle.js resolveTargetDb) — 여기서 미리 고르거나 검증하지 않는다.
        // 돌려받은 targetDb는 등록 철자이므로 이력·trace·프롬프트가 같은 이름을 본다.
        const { rows, totalRows, capped, targetDb } = await run(registryRow, item.params, clippedCopy.isCopy, dbChoice);
        clippedCopy.record(rows);
        Object.assign(entry, { targetDb, rows: capRows(rows), totalRows, capped });
        fullRows.set(entry, rows);
        progressed = true;
        emit('run_query_done', { id, query_name: canonicalName, targetDb, rowCount: capped ? `${totalRows}+` : totalRows });
      } catch (e) {
        // 실패도 이력에 남기고 루프를 계속한다 — LLM이 에러를 보고 재시도/우회/답변을 판단.
        // 메시지가 비면 안 된다: error가 falsy면 프롬프트·답변 조립이 이 기록을 '오류'로 보지 않고
        // rows가 있는 정상 결과로 취급해 들어간다.
        Object.assign(entry, { error: e?.message || String(e), safe: e?.safe === true, ...(e?.hint && { hint: e.hint }) });
        // 조회를 시작하지도 못하고 거부된 실패(oracle.js wastedStep — 대상 DB를 못 골랐거나, 등록·설정 오류로 어떤
        // 파라미터로도 실행이 시작되지 않는다)는 미등록 이름과 같은 부류다: 조회 DB를 건드리지 않았고, 모델이 고칠
        // 수 있는 것은 오류 문구가 이미 열거해 줬거나 아예 없다.
        if (e?.wastedStep) wastedCount++;
        // 화면으로 나가는 문구는 trace 패널과 같은 기준이다 (result.js clientTrace) — 우리가 만든 문구만 원문으로.
        emit('run_query_done', {
          id, query_name: canonicalName, ...(dbChoice && { targetDb: dbChoice }),
          error: e?.safe === true ? (e.message || String(e)) : '조회 중 오류가 발생했습니다.',
        });
      }
    })));
    return { progressed, wasted: !progressed && wastedCount === batch.length };
  };

  for (let i = 0; i < MAX_STEPS + MAX_SEARCHES + MAX_EXPANDS + MAX_RESULT_READS; i++) {
    // 이력 줄 수도 상한이다 — 결정 하나가 조회 여럿을 만들 수 있으므로(일괄 조회) 반복 수만으로는 줄 수가
    // 묶이지 않는다. 넘기면 프롬프트의 이력 몫이 보장하는 '전부 실린다'가 깨져 가장 오래된 조회 결과가
    // 조용히 빠진다 (constants.MAX_HISTORY_ROWS).
    if (history.length >= MAX_HISTORY_ROWS) break;
    // 스텝 수만으로는 소요 시간이 묶이지 않는다 — 느린 LLM 엔드포인트에서는
    // 스텝마다 LLM 타임아웃이 통째로 쌓여 요청 하나가 수십 분씩 워커를 점유한다.
    if (Date.now() > deadline) break;

    const decision = await decideSafe(ctx());
    if (!decision) break; // 결정을 얻지 못했다 — 아래 강제 답변/폴백으로 간다
    if (decision.action === 'answer') {
      const answer = answerOf(decision);
      if (answer) return done(finish(answer), false);
      break;   // 쓸 수 있는 답변이 아니다 — 아래 강제 답변/폴백으로 간다
    }

    // 예산은 스텝 진입에서만 보면 부족하다 — 239초에 시작한 스텝이 LLM 120초를 쓰고 나서
    // 검색·조회까지 더 태우면 프런트가 먼저 끊는 지점을 넘긴다.
    if (Date.now() > deadline) break;

    if (decision.action === 'read_result') {
      if (resultReads >= MAX_RESULT_READS) {
        contextNote = '조회 결과 추가 읽기 기회를 다 썼다. 현재 표시된 결과로 답변하라';
        if (++guardHits >= MAX_GUARD_HITS) break;
        continue;
      }
      resultReads++;
      const request = normalizeResultRead(decision);
      const key = JSON.stringify(request);
      try {
        const entry = history[request.step - 1];
        if (readKeys.get(entry) === key) throw new Error('같은 결과 범위를 이미 읽었다. 다른 행·컬럼을 지정하거나 표시된 결과로 답변하라');
        const view = readStoredResult(fullRows.get(entry), request);
        resultViews.set(entry, view);
        readKeys.set(entry, key);
        contextNote = '';
        guardHits = 0;
      } catch (e) {
        contextNote = clipText(`결과 추가 읽기 불가: ${e.message}`, 200);
        if (++guardHits >= MAX_GUARD_HITS) break;
      }
      continue;
    }

    // 자료를 늘리는 결정만 자료를 줄일 수 있다 (search·expand). 검색보다 '먼저' 적용한다 —
    // 새 결과가 병합되기 전에 표시가 서 있어야 방금 버린 것이 그 검색으로 되살아나지 않는다.
    const droppedNow = decision.action === 'search' || decision.action === 'expand'
      ? applyDrop(decision.drop) : 0;

    if (decision.action === 'expand') {
      const { done: grownIds, saturated, unread, covered } = await applyExpand(decision.ids);
      // 펼쳤거나 버렸으면 자료가 달라졌다 — 진도로 본다. 둘 다 없으면 헛돈 스텝이다.
      if (grownIds.length || droppedNow) { guardHits = 0; continue; }
      // 번호가 붙어 있던 항목이 늘지 않은 경우는 따로 말한다 — '번호가 붙은 항목만 청구할 수 있다'는 안내는
      // 모델이 방금 그렇게 한 상황에서 모순이고, 왜 안 됐는지도 다음 행동도 담고 있지 않다.
      // 읽기 실패(unread)가 그중 먼저다: 늘지 않은 항목(saturated)은 full이 서서 다음 프롬프트에서 확대 표시가 사라지지만,
      // 읽지 못한 항목은 아무것도 바뀌지 않아 번호가 그대로 남는다. 그 앞에 '번호가 붙은 항목만'을 적으면 모델은
      // 같은 번호를 다시 청구하고, 두 번째 실패에서 강제 답변으로 넘어갔다(실측 — 관리 DB 타임아웃 한 번이면 그렇게 된다).
      pushNote({
        expand: decision.ids,
        note: expands >= MAX_EXPANDS
          ? `본문 청구 상한(${MAX_EXPANDS}건)에 닿았다 — 지금까지의 자료로 답변하라`
          : unread
            ? '청구한 본문을 읽어 오지 못했다 (관리 DB 오류 또는 검색 이후 본문 변경) — 같은 번호를 다시 청구하지 말고 지금 범위로 답변하라'
            // 보관 목록에 있는 번호를 그대로 청구했는데 그 본문이 이미 다른 항목으로 실려 있는 경우다.
            // 여기에 '보관 목록에 있는 항목을 청구하라'는 기본 안내를 주면 모델이 방금 한 일과 모순된다 —
            // 같은 번호를 다시 청구하고 둘째 헛돈 스텝에서 강제 답변으로 넘어간다.
            : covered
              ? '청구한 항목의 본문은 이미 같은 문서의 다른 항목으로 실려 있다 — 그 번호는 다시 청구하지 말고 지금 보이는 본문으로 답변하라'
              : saturated
                ? '청구한 항목은 더 넓힐 수 없다 — 이웃 조각이 문서당 글자 상한에 들어가지 않는다. 지금 범위로 답변하라'
                : '표시할 새 내용이 없다 — 확대 가능하거나 보관 목록에 있는 항목을 청구하라',
      });
      if (++guardHits >= MAX_GUARD_HITS) break;
      continue;
    }

    if (decision.action === 'search') {
      const text = decision.text || question;   // 빈 검색어는 현재 질문으로 (llm.js sanitizeDecision 주석)
      const targets = decision.targets;
      const key = searchKey(text, targets);
      // 같은 검색의 반복과 횟수 상한은 루프 가드와 같은 부류다 — note로 남기고 연속 카운터를 올린다.
      // '같은 부류'에는 루프 가드가 성공과 실패를 가르는 것도 포함된다(loopGuard의 MAX_SAME_QUERY_TRIES):
      // 요청한 대상이 전부 '검색 불가'였던 시도는 아무것도 찾아보지 못한 것이라 반복으로 셀 수 없다.
      // 세던 동안 임베딩 서버가 한 번 늦게 답한 것만으로 그 검색어가 그 요청에서 영영 막혔고, 안내는
      // '검색된 자료로 답변하라'라 — 자료가 하나도 없는 상태에서 있지도 않은 자료로 답하라는 말이 된다
      // (시스템 프롬프트가 '검색 불가'에 대해 지시하는 것과도 어긋난다). 두 번째 실패까지 세어 반복은 끊는다.
      const sameKey = history.filter(h => h.search !== undefined && !h.note && searchKey(h.search, h.targets) === key);
      const nothingSearched = h => (h.failed?.length ?? 0) > 0
        && SEARCH_TARGETS.filter(t => (h.targets ?? []).includes(t)).every(t => h.failed.includes(t));
      const guardNote = sameKey.some(h => !nothingSearched(h))
        ? '이미 같은 검색어·대상으로 검색했다 — 검색된 자료로 답변하거나 다른 검색어를 쓰라'
        : sameKey.length >= MAX_SAME_SEARCH_TRIES
          ? '같은 검색어·대상으로 반복했으나 검색이 성립하지 않았다 — 다른 검색어를 쓰거나 지금까지의 자료로 답변하라'
          : searches >= MAX_SEARCHES
            ? `검색 횟수 상한(${MAX_SEARCHES}회)에 닿았다 — 지금까지의 자료로 답변하라`
            : null;
      if (guardNote) {
        history.push({ search: text, targets, note: guardNote });
        if (++guardHits >= MAX_GUARD_HITS) break;
        continue;
      }
      searches++;
      emit('search', { text, targets });
      // 검색 실패로 요청 전체를 버리지 않는다 — 함께 버려지는 것이 이미 조회해둔 결과다. 결정(decideSafe)과
      // 조회(runBatch)가 각자 그 이유로 예외를 삼키는데, 검색을 루프 안으로 들여오면서 이 await만 밖에 있었다.
      // runSearch는 자기가 아는 실패를 이미 삼키므로 여기 오는 것은 그 밖의 것이다(경고 함수의 예외 등) —
      // 요청한 대상 전부가 '검색 불가'였던 것으로 기록하고 루프를 계속한다.
      let result;
      try {
        result = await timed(timing.search, () => search(text, targets));
      } catch (e) {
        console.warn('[agent] search failed:', e?.message ?? e);
        const asked = t => (targets.includes(t) ? null : undefined);
        result = {
          knowledge: asked('knowledge'), qaMethods: asked('qa_method'), queries: asked('query'),
          queriesFailed: false, directFailed: false,
        };
      }
      const { added, hits, failed } = absorb(result, targets);
      history.push({ search: text, targets, hits, ...(failed.length && { failed }) });
      emit('search_done', { text, targets, hits, ...(failed.length && { failed }) });
      // 새 자료가 하나도 없으면 헛돈 스텝이다 — 미등록 쿼리 이름과 같은 연속 카운터로 센다.
      // (검색어를 바꿔 한 번 더 시도할 기회는 남는다 — 첫 1회는 카운터만 오른다)
      // 같은 결정으로 버린 것이 있으면 헛돈 것이 아니다 — 바로 위 expand 갈래가 쓰는 것과 같은 판정이다
      // ('펼쳤거나 버렸으면 자료가 달라졌다'). 시스템 프롬프트가 검색·청구에 drop을 함께 적으라고 권하는데,
      // 이미 아는 자료만 돌아온 검색(added === 0)에 정리를 겹치면 그 스텝이 진도 없음으로 세어졌다 —
      // 그런 결정 둘이면 남은 검색·청구·조회를 다 남긴 채 강제 답변으로 넘어간다(실측).
      // 버리기는 되풀이될 수 없어 이 완화가 루프를 열지 않는다: 이미 버린 항목은 applyDrop이 건너뛰므로
      // droppedNow가 0이 되고, 그때부터 카운터가 다시 오른다.
      // 가드에 걸려 '실행하지 않은' 검색은 종전대로 센다 — 그쪽은 결정 자체가 이미 한 일을 다시 낸 것이다.
      if (added === 0 && !droppedNow) { if (++guardHits >= MAX_GUARD_HITS) break; } else guardHits = 0;
      continue;
    }

    // run_query / run_queries — 하나든 여럿이든 같은 길(runBatch)을 지난다. 일괄 조회는 서로 의존하지 않는 조회를
    // 한 결정에 담아 LLM 왕복을 줄이는 길이다. 결정 수가 아니라 조회 수로 센다 — 가드·미등록으로 실행되지 않은
    // 항목도 이력 한 줄을 차지한다. 상한을 넘는 항목은 잘라 낸다 (이력의 최소 몫이 MAX_STEPS 줄 기준이다).
    if (runs >= MAX_STEPS) break;
    const items = decision.action === 'run_queries' ? decision.queries : [decision];
    // 실을 수 있는 항목 수 — 조회 수 상한과 이력 줄 수 상한 둘 다에 맞춘다. 다 싣지 못하면 그 사실을 알리는
    // 안내 줄이 한 자리를 더 쓰므로(아래) 그 자리까지 셈에 넣는다. 자리를 늘 비워 두지는 않는다 —
    // 그러면 안내가 필요 없는 배치에서 마지막 조회 하나를 공연히 잃는다.
    // 같은 이유로 안내 줄이 '실행할 수 있었던 마지막 조회'를 밀어내서도 안 된다. 남은 자리가 하나뿐인데
    // 그 한 줄을 안내에 내주면 실행 수가 0이 되어, 프롬프트가 방금 "조회는 1건까지 더 실행할 수 있다"고
    // 알려준 그 한 건까지 사라진다 — 모델은 지시를 어긴 만큼(하나 더 담았다)이 아니라 전부를 잃고,
    // 그 스텝은 헛돈 것으로 세어져 강제 답변으로 넘어간다(실서버 재현: 두 조회 중 하나도 실행되지 않았다).
    // 안내보다 결과가 먼저다 — 최소 한 건은 실행하고, 안내는 자리가 남을 때만 적는다(아래 pushNote).
    const roomRows = MAX_HISTORY_ROWS - history.length;
    const want = Math.min(items.length, MAX_STEPS - runs);
    const take = want + (want < items.length ? 1 : 0) <= roomRows ? want : Math.max(1, roomRows - 1);
    const batch = items.slice(0, take);
    runs += batch.length;
    const { progressed, wasted } = await runBatch(batch);
    // 상한에 걸려 실행하지 못한 항목은 조용히 사라지지 않게 남긴다 — 모델은 자기가 넷을 요청했다는 것을
    // 알고 있는데 이력에는 둘만 보이면, 나머지가 실패한 것인지 아직 도는 중인지 알 수 없다.
    // 실행 줄 '뒤에' 적는다: 앞에 적으면 아직 나오지도 않은 결과를 두고 '실행하지 않았다'가 먼저 읽힌다.
    // note라 실패 집계에는 섞이지 않는다 (loopGuard 기록과 같은 필드).
    if (items.length > batch.length) {
      // 어느 상한에 걸렸는지 정확히 말한다. 조회 수(MAX_STEPS)가 아니라 이력 줄 수(MAX_HISTORY_ROWS)에 걸려 잘린
      // 배치에 '조회 스텝 상한 5회'라고 적으면, 조회를 두 번밖에 안 한 모델이 사실과 다른 이유를 받는다(실측).
      // runs는 이미 이번 배치를 더한 값이다 — 조회 수 상한에 닿았으면 그것이 이유이고, 아니면 줄 수가 막은 것이다.
      const limit = runs >= MAX_STEPS
        ? `조회 스텝 상한(${MAX_STEPS}회)` : `실행 이력 줄 수 상한(${MAX_HISTORY_ROWS}줄)`;
      // 자리가 남았을 때만 적는다 (pushNote) — 마지막 자리를 조회에 내준 경우가 그렇지 않은 경우다.
      // 그때 이 안내가 없어도 모델이 길을 잃지는 않는다: 이력이 상한에 닿아 루프가 곧 끝나고,
      // 강제 답변 프롬프트의 지시 블록이 '더 조회할 수 없다'를 말한다(queriesLeft = 0).
      pushNote({
        query_name: items.slice(batch.length).map(q => q.query_name).join(', '),
        params: {},
        note: `${limit}에 걸려 실행하지 않았다 — 지금까지의 결과로 답변하라`,
      });
    }
    if (progressed) guardHits = 0;                        // 진도가 나갔다 — 가드는 '연속' 헛도는 경우만 센다
    else if (wasted && ++guardHits >= MAX_GUARD_HITS) break;
  }

  // 안전장치: 상한 초과(또는 가드 반복) 시 강제 답변.
  // 그마저 실패하면 fallbackAnswer가 손에 든 것으로 답을 조립한다.
  const finalCtx = { ...ctx(), forceAnswer: true };
  const final = await decideSafe(finalCtx);
  const answer = answerOf(final) || fallbackAnswer(finalCtx);
  return done(finish(answer), true);
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
//      그 값을 자른 것이 우리고 clipText는 정해진 길이만 남긴다. 자르는 자리가 셋이다 —
//      드라이버 경계(MAX_CELL_LEN, oracle.js normalizeValue)와, 답변에 채워 넣는 표·차트의 칸
//      (MAX_TABLE_CELL_LEN·MAX_CHART_CELL_LEN, chart.js) — 그리고 각각 절단 경계가 서로게이트 쌍을
//      가른 경우의 한 칸 짧은 길이. 마크 앞에서 그 길이들을 떼어내면 화면에 실렸던 앞부분이 그대로 복원된다.
//      뒤의 둘을 세지 않던 동안 이 가드는 반쪽이었다: 실제 LLM의 답변에서 사용자가 보는 표는 폴백 표가
//      아니라 chart.js가 채운 표이고, 그 칸은 120자에서 다시 잘린다. 200자 앞부분은 대화 이력 어디에도
//      없으니 모델이 옮겨 적는 것은 120자 조각인데, 그 길이는 이 집합에 없어 조회가 그대로 실행됐다(실측 —
//      0건이 나오고 모델은 "없다"로 읽는다). 이 집합은 '우리가 어디에서 자르는가'와 같아야 한다.
//      (앞부분을 '마크에 붙어 있는 문자열'로 찾으면 안 된다 — 그러면 마크 바로 앞에 오는 짧고
//       정당한 값까지 전부 잘린 조각으로 오판한다. 판정은 '값 전체가 그 앞부분과 같은가'여야 한다.)
//      대화 턴이 MAX_CHAT_LEN으로 잘려 앞부분이 온전히 남지 않았으면 복원되지 않는다 —
//      그 경우 모델도 온전한 앞부분을 보지 못했으므로 옮겨 적을 수도 없다.
//
// 그래서 판정은 집합 조회 한 번이다 — 검색도, 길이 분기도 없다.
// (테스트에서 쓰므로 export 한다 — 양쪽으로 조용히 깨지는 판정이다: 느슨해지면 잘린 조각으로
//  조회해 0건 오답이 나가고, 빡빡해지면 정당한 값으로 그 쿼리를 영영 실행할 수 없다.
//  어느 쪽도 오류를 남기지 않으므로 테스트가 유일한 방어선이다 — loopGuard와 같은 이유다.)
//
// 두 부류로 나눠 본다. 산문의 마크는 드라이버 경계의 길이(MAX_CELL_LEN)만 본다 — 그 값은 모델의 산문("값이
// abc…(생략) 입니다")에도 실릴 수 있어 시작을 알 방법이 없으니 길이로 되돌아간다. 표의 칸(GFM 표 행)은 시작을 안다 —
// 이스케이프되지 않은 '|'가 칸의 경계다 — 그래서 칸의 시작부터 마크까지를 통째로 되돌린다.
//
// 칸에서는 '마크에서 자른 길이만큼 되돌아가는' 방식을 쓰면 안 된다. 표·차트의 칸(chart.js tableCell·cell)과 폴백 표
// (llm.js cell)는 값을 자른 '뒤에' GFM 이스케이프를 건다 — 역슬래시는 둘로, 파이프는 '\|'로, 개행은 공백으로. 칸에
// 실린 글자 수가 자른 길이와 달라지므로, 값에 '|'나 '\'가 든 순간(경로·로그 메시지) 그 길이만큼 되돌아간 자리는
// 칸의 시작이 아니다(실측 — 'a|'가 되풀이되는 300자 값에서 120자 조각도 이스케이프된 표시도 걸리지 않았다).
// 이 함수가 존재하는 이유가 '잘린 조각으로 조회해 0건을 얻고 그것을 없다고 단정하는' 실패인데, 긴 값에 파이프·
// 역슬래시가 드는 것은 그 실패가 가장 흔한 자리(자유 텍스트 컬럼)에서 흔하다.
// 되돌린 값이 우리가 자르는 길이(드라이버 경계·표·차트의 칸, 각각의 서로게이트 한 칸 짧은 길이) 중 하나일 때만 넣는다.
// 길이 조건을 남기는 이유는 종전과 같다 — 마크에 붙은 문자열이면 무엇이든 넣으면, 모델이 스스로 줄여 쓴
// '서울시…(생략)' 같은 칸에서 '서울시'가 잘린 조각이 되어 그 정당한 값으로는 어떤 쿼리도 실행할 수 없다.
// 이스케이프를 되돌린 값과 보이는 그대로의 값을 둘 다 넣는다 — 모델이 옮겨 적는 것이 어느 쪽인지는 정할 수 없다.
const DRIVER_CLIP_LENS = [MAX_CELL_LEN, MAX_CELL_LEN - 1];
const CELL_CLIP_LENS = [MAX_TABLE_CELL_LEN, MAX_CHART_CELL_LEN].flatMap(n => [n, n - 1]);
const CLIP_LENS = new Set([...DRIVER_CLIP_LENS, ...CELL_CLIP_LENS]);

// GFM 칸의 이스케이프를 되돌린다 — 쓰는 쪽(chart.js escapeCell, 그것을 그대로 쓰는 llm.js cell)과
// 프런트(frontend/src/chart.js splitRow)가 같은 목록을 쓴다. 목록에는 파이프·역슬래시 말고도 값에 든
// 강조·코드·링크·취소선·HTML·엔터티 표기가 들어 있다(escapeCell 주석) — 여기만 두 글자로 남으면 그런 값이
// 실린 칸에서 되돌린 길이가 '우리가 자른 길이'와 어긋나 가드가 자기가 보여준 앞부분을 못 알아본다.
// 개행을 공백으로 바꾼 것은 되돌릴 수 없다(그 값은 모델도 공백으로 본다).
const unescapeCell = s => s.replace(/`(<br\s*\/?>)`/gi, '$1').replace(/\\([\\|`*~[\]<_&$])/g, '$1');

// 마크(markAt)가 든 GFM 표 행에서, 그 칸의 시작부터 마크 직전까지 보이는 글자. 표의 행이 아니면 null.
// 칸의 경계는 이스케이프되지 않은 '|'다 — 앞의 연속 역슬래시가 홀수면 값 속의 파이프('\|')이고 짝수면 구분자다
// ('\\|'는 역슬래시 하나 뒤의 구분자). 쓰는 쪽은 구분자 뒤에 공백 하나를 두므로 그 한 칸만 뗀다 — trim으로 다
// 떼면 값 앞의 공백이 사라져 원본과 어긋난다.
function cellShownBefore(text, markAt) {
  const lineStart = text.lastIndexOf('\n', markAt - 1) + 1;
  let i = markAt - 1;
  for (; i >= lineStart; i--) {
    if (text[i] !== '|') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= lineStart && text[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 0) break;
  }
  if (i < lineStart) return null;
  const shown = text.slice(i + 1, markAt);
  return shown.startsWith(' ') ? shown.slice(1) : shown;
}

export function clippedCopyDetector(chat) {
  const clipped = new Set();
  const recordValues = values => {
    for (const v of values) {
      if (typeof v === 'string' && v.endsWith(TRUNC_MARK)) clipped.add(v.slice(0, -TRUNC_MARK.length));
    }
  };
  const addFromMark = (text, markAt) => {
    for (const len of DRIVER_CLIP_LENS) {
      if (markAt >= len) clipped.add(text.slice(markAt - len, markAt));
    }
    const shown = cellShownBefore(text, markAt);
    if (shown) {
      const raw = unescapeCell(shown);
      if (CLIP_LENS.has(raw.length)) { clipped.add(raw); clipped.add(shown); }
    }
  };
  for (const { text } of chat) {
    for (let i = text.indexOf(TRUNC_MARK); i >= 0; i = text.indexOf(TRUNC_MARK, i + 1)) {
      addFromMark(text, i);
    }
  }
  return {
    record(rows) {
      for (const row of rows) recordValues(Object.values(row));
    },
    recordParams: params => recordValues(promptParams(params).values),
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
  // 버린 항목은 여기서도 뺀다. 프롬프트에서 뺀 것(llm-openai.js live)을 폴백이 '관련 지식'으로 붙이면, 모델이
  // 무관하다고 판정한 본문이 그 판정을 무시한 채 사용자에게 나가고 정작 남긴 지식은 그 뒤에 가려진다(실측).
  const rendered = renderAnswer({ ...ctx, knowledge: knowledgeView(ctx.knowledge ?? []).filter(k => !k?.dropped && !k.viewOmitted) });
  return rendered ? clipAnswer(`${LLM_FAILED_NOTE}\n\n${rendered}`) : LLM_FAILED;
}

// LLM 호출은 무엇이 실패하든 요청 전체를 500으로 만들지 않는다 — 함께 버려지는 것이
// 이미 조회해둔 결과이기 때문이다. provider는 자기 재시도 루프 안의 실패만 흡수하므로
// (HTTP·타임아웃·파싱), 그 밖의 실패는 여기서 받는다: 프롬프트 조립 오류, mock provider의 예외,
// ctx에 예상 밖의 값이 섞인 경우. 보장은 provider가 아니라 '누적된 성과를 쥐고 있는' 이 경계에 둔다.
// 결정을 얻지 못하면 null을 돌려주고, 호출부가 강제 답변 또는 폴백 답변으로 넘어간다.
// fn은 테스트가 LLM을 스텁으로 바꿔 끼우는 자리다 (handleQuestion의 deps).
async function decide(ctx, fn = llm.decide) {
  try {
    return await fn(ctx);
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

// 검색 실행 — search 행동 한 번. 세 대상의 벡터 검색은 병렬이고 임베딩은 한 번만 계산된다(search.js 캐시).
// 반환값의 세 목록은 셋을 구분한다 — 프롬프트가 '없다'와 '못 찾아봤다'를 갈라야 하기 때문이다:
//   undefined = 요청하지 않은 대상, null = 검색이 성립하지 않음(임베딩·벡터 검색 실패), [] = 찾았는데 없음.
// 쿼리 목록은 두 경로의 합집합이다 (selectQueries 주석) — qa_method를 찾았으면 'query'를 요청하지 않았어도
// 경로A로 실린다. 절차만 있고 쿼리 정의가 없으면 실행할 수 없어 왕복만 하나 더 늘기 때문이다.
async function runSearch(text, targets) {
  const want = new Set(targets);
  const [knowledge, qaMethods, direct] = await Promise.all([
    want.has('knowledge') ? searchKnowledge(text) : undefined,
    want.has('qa_method') ? searchQaMethods(text) : undefined,
    want.has('query') ? searchQueries(text) : undefined,
  ]);
  const out = { knowledge, qaMethods, queries: undefined, queriesFailed: false, directFailed: direct === null && want.has('query') };
  if (!want.has('query') && !qaMethods?.length) return out;
  // 쿼리 목록 로드 실패로 검색 전체를 버리지 않는다 — 함께 버려지는 것이 방금 찾은 지식·처리방법이고,
  // 그중에는 DB 조회가 아예 필요 없는 순수 지식 질문도 있다. 실패는 표시로 남겨 chat_log가
  // '등록이 없어서 못 답한 질문'과 구분하게 한다 (queriesFailed).
  try {
    out.queries = await selectQueries(qaMethods ?? [], direct);
  } catch (e) {
    // 상세는 로그에만 — 화면 문구는 호출부가 만들고, MariaDB 원문에는 스키마·호스트가 들어 있다.
    console.warn('[agent] failed to load the query list:', e.message);
    out.queries = direct == null ? null : await selectQueries([], direct);
    out.queriesFailed = true;
  }
  return out;
}

// 직접 검색(경로B)의 상위 몇 건까지 자세한 형태(입출력 설명·SQL)로 보일지. 나머지도 이름·용도·바인드·입력 설명을
// 보인다 — 고르는 데는 그것이면 되고, 지목하면 다음 스텝에 자세히 실린다 (llm-openai.js renderQueries).
const DETAIL_TOP = 5;

// 프롬프트에 실을 쿼리 선정. 관련도 순으로 두 경로를 합친다:
//   경로A: 찾은 qa_method 본문이 지목한 query_name (다단계 절차 보장 — 본문 등장 순서를 지킨다)
//   경로B: 검색어로 query_registry 자체를 벡터 검색한 결과 (search.js) — qa_method 없이 등록한 쿼리도 찾는다
// 이 둘의 합집합만 싣는다 — 등록 규모가 작다고 검색에 안 걸린 나머지까지 얹지 않는다. 예전에는 등록
// 30건 이하면 벡터 거리와 무관하게 전부 붙였는데("설명이 얇아 검색에 안 걸린 쿼리도 이름은 보여야
// 모델이 지목할 수 있다"), 그 폴백이 MAX_DIST가 '관련 없음'으로 이미 걸러낸 것까지 무효로 만들었다 —
// 무관한 질문에도 등록된 쿼리 전부가 후보로 실려 모델이 억지로 하나를 고를 여지가 생겼다(실측: "일론
// 머스크의 위기" 같은 질문에 업무 쿼리 5건이 그대로 붙었다). 얇은 설명으로 인한 recall 손실은 경로A가
// 이미 절차 쪽에서 보완한다.
// 경로A는 '본문에서 이름처럼 보이는 토큰을 뽑아 IN 절로 묻는' 방식이었다. 그 추출식이
// /[A-Za-z_][A-Za-z0-9_]{2,}/ 라서 한글 query_name은 어떤 본문에서도 한 번도 뽑히지 않았다 —
// query_name은 VARCHAR(100)에 문자 제한이 없고 이 코드베이스는 다른 곳에 전부 한글을 쓴다.
// 한국어는 조사가 낱말에 붙어 '배치상태조회를'이 한 낱말이므로 토큰화로는 고칠 수 없다.
// 그래서 방향을 뒤집는다 — 관리 DB의 등록명을 읽어 '이름이 본문에 들어 있는가'를 본다
// (db.js loadQueriesMentionedIn). 공통 이름 규칙으로 첫 등장 위치를 계산해 순서를 보장한다.
// 본문은 검색 결과 순서대로 이어 붙인다 — 위치 순서가 곧 '관련도 높은 처리방법 먼저, 그 안에서는
// 등장 순서대로'가 된다. method는 NOT NULL이지만 컬럼 하나가 완화되거나 임포터가 NULL을 넣는
// 순간 여기서 죽는다 — 이 값의 다른 소비자(llm-openai clip, embed-sync toText)는 전부 NULL을 견딘다.
// 원문을 상한 안에서 넘긴다. 본문 전체를 소문자화하면 주변 글자 때문에 이름의 판정이 달라진다.
async function selectQueries(qaMethods, direct) {
  const routeText = clipText(
    qaMethods.map(m => String(m.method ?? '')).join('\n'),
    MAX_ROUTE_TEXT_LEN
  );
  const named = await loadQueriesMentionedIn(routeText, MAX_PROMPT_QUERIES);   // 빈 본문이면 왕복하지 않는다 (db.js)

  const seen = new Set();
  const list = [];
  const push = (q, detail) => {
    if (seen.has(q.seq)) return;
    seen.add(q.seq);
    if (detail) q.detail = true;
    list.push(q);
  };
  (direct ?? []).filter(q => q.exact).forEach(q => push(q, true));
  named.forEach(q => push(q, true));
  (direct ?? []).forEach((q, i) => push(q, i < DETAIL_TOP));
  return list.slice(0, MAX_PROMPT_QUERIES);
}
