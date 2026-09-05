// Agent 처리 루프 — 시스템의 핵심 제어 흐름.
// 질문 → LLM 결정 루프(검색 / 쿼리 실행 / 답변) → 최종 답변.
// 검색은 LLM이 요청할 때만 한다(search 행동). 인사 한 줄에도 지식·처리방법·쿼리 목록을 미리 실어
// 보내던 구조를 뒤집은 것이다 — 그때는 첫 LLM 호출의 prefill이 질문과 무관하게 최대치였다.
// 루프의 유일한 상태는 history 배열(과 검색이 채우는 세 목록)이며, 매 반복 전체 컨텍스트를 LLM에 전달한다.
// 대화 맥락(chat)은 서버가 저장하지 않고 클라이언트가 매 요청에 실어 보낸다 (stateless 유지).
import { searchKnowledge, searchQaMethods, searchQueries } from './search.js';
import { loadQueryRegistry, loadQueriesByNames, loadQueriesMentionedIn, loadChunkRanges } from './db.js';
import { canGrow, buildItems } from './chunk.js';
import { runQuery } from './oracle.js';
import { bindNames } from './sql.js';
import { llm, renderAnswer, clipAnswer } from './llm.js';
import { resolveChartData, resolveTableData } from './chart.js';
import { MAX_STEPS, MAX_SEARCHES, MAX_HISTORY_ROWS, MAX_EXPANDS, MAX_DOC_LEN, MAX_PROMPT_ITEM_LEN, MAX_RESULT_ROWS, parseItemId, MAX_CHAT_TURNS, MAX_CHAT_LEN, MAX_CELL_LEN, TRUNC_MARK, SEARCH_TARGETS, nameKey, clipText, stripLoneSurrogates, bindValue, targetDbNames, indentLines } from './constants.js';

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
export const MAX_GUARD_HITS = 2; // 루프 가드가 '연속으로' 이만큼 걸리면 남은 스텝을 포기하고 강제 답변으로 간다. (테스트에서 쓰므로 export)
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

// 같은 검색의 판정 키 — 검색어(대소문자·공백 흡수)와 대상 집합(정규 순서)으로 만든다.
// 같은 검색어에 대상만 더한 검색은 새 검색이다 (아직 찾아보지 않은 대상이 있다).
// (테스트에서 쓰므로 export 한다 — loopGuard와 같은 이유로 양쪽으로 조용히 깨진다)
export const searchKey = (text, targets) =>
  JSON.stringify([nameKey(text), SEARCH_TARGETS.filter(t => (targets ?? []).includes(t))]);

// 검색 결과를 컨텍스트 목록에 합친다. 이번 검색이 찾은 것은 — 새 항목이든 이미 있던 항목이든 — 검색 결과의
// 순서(관련도 순)대로 목록 맨 앞에 온다. 방금 요청한 검색이 가장 관련 높다는 전제이고, 프롬프트 예산
// (llm-openai.js renderItems)이 꼬리부터 버리기 때문이다: 이미 있던 항목을 제자리에 두면 이번 검색의 1위가
// 지난 검색의 꼬리에 남아 잘린다. 돌려주는 값은 '진도' — 새로 넣었거나 내용이 달라진 항목 수다. 순서만 바뀐
// 것은 세지 않는다(모델이 새로 얻은 것이 없다).
//
// 항목의 정체는 seq가 아니라 문서다 (dedupKey — 청크 항목은 doc_seq). 청크 항목의 seq는 '가장 가까운 청크'의
// 것이라(chunk.js buildItems) 두 번째 검색에서 다른 청크가 대표가 되면 값이 달라지는데, seq로만 거르면 같은
// 문서가 두 항목으로 들어와 지식 몫을 두 번 먹는다. 같은 문서가 다시 오면 항목을 새로 만들지 않고 그 항목의
// '구간'을 이번 검색의 것으로 바꾼다 — seq는 그대로다(모델이 이미 지목한 번호가 요청 도중 다른 것을 가리키면
// 안 된다는 것이 식별자 설계의 근거다, constants.js ITEM_PREFIX). 이번 구간이 이미 실린 구간 안에 들면 넓은
// 쪽을 둔다. 먼저 온 구간을 무조건 지키던 동안에는 뒤 검색이 같은 문서의 다른 절(3번 청크 → 15~17번)을
// 찾아도 그 절이 통째로 버려지고, 모델은 그것이 존재한다는 사실조차 볼 수 없었다 — 오류 없는 오답의 전형이다.
//
// 예외 둘.
//   펼친 항목(expanded) — 모델이 청구해 넓힌 구간이다. 자리도 구간도 지킨다: 목록 앞머리의 펼침 구간 뒤에
//     끼운다(applyExpand가 unshift로만 옮기므로 펼친 항목은 목록의 접두사를 이룬다). 그러지 않으면 본문 청구가
//     통째로 헛돈다 — 뒤이은 검색 한 번이 후보 SEARCH_LIMIT건을 그 앞에 쌓으면 펼친 본문(MAX_DOC_LEN)이 섹션 몫
//     밖으로 밀려나는데, 펼친 항목에는 번호가 붙지 않으므로 모델은 그것이 사라진 것을 볼 수도 다시 청구할 수도
//     없고 MAX_EXPANDS만 하나 잃는다(실측). 다른 구간이 필요하면 버리고(drop) 다시 찾으면 아래 규칙으로 실린다.
//   버린 항목(dropped) — 같은 내용은 되살아나지 않는다(context.md 2-4, 목록에서 지우지 않고 표시만 세우는
//     이유가 그것이다). 단 청크 항목에 '겹치지 않는' 다른 구간이 걸리면 그 구간으로 되살린다: 모델이 버린 것은
//     그 구간이지 문서가 아니고, 되살리지 않으면 관련 있는 절이 이 요청 안에서 영영 실리지 않는다.
//
// 쿼리 목록에는 펼침·버림이 없어 종전과 같이 맨 앞에 붙되, 이미 있던 행이 이번 검색의 자세한 대상(detail)으로
// 다시 왔으면 그 표시를 옮겨 받는다 — 옮기지 않으면 두 번째 query 검색의 상위 적중이 짧은 줄로 남는다(실측).
// 소규모 등록에서는 첫 검색이 전부를 실어 두 번째 검색이 새 항목을 하나도 넣지 못하므로 그 표시도 진도로 센다.
// (테스트에서 쓰므로 export 한다)
const dedupKey = r => (r?.doc_seq != null ? `d${r.doc_seq}` : `s${r?.seq}`);
const rangeOf = o => (Number.isInteger(o?.from) && Number.isInteger(o?.to) ? [o.from, o.to] : null);
const within = (a, b) => !!(a && b) && a[0] >= b[0] && a[1] <= b[1];   // a ⊆ b
const apart = (a, b) => !!(a && b) && (a[1] < b[0] || a[0] > b[1]);    // 겹치지 않는다
// 청크 항목의 구간을 이번 검색의 것으로 바꾼다. seq·expanded·dropped는 건드리지 않는다 (applyExpand가 넓힐 때와 같은 키).
const RANGE_KEYS = ['rep', 'doc_seq', 'chunk_of', 'from', 'to', 'full', 'title', 'range', 'content', '_dist'];
const adopt = (had, r) => { for (const k of RANGE_KEYS) if (k in r) had[k] = r[k]; };

export function mergeFront(list, rows) {
  const byKey = new Map(list.map(o => [dedupKey(o), o]));
  const front = [];
  const seen = new Set();
  let progress = 0;
  for (const r of rows) {
    const key = dedupKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    const had = byKey.get(key);
    if (!had) { byKey.set(key, r); front.push(r); progress++; continue; }
    const chunk = r?.doc_seq != null;
    if (had.dropped) {
      if (!(chunk && apart(rangeOf(r), rangeOf(had)))) continue;   // 같은 내용(겹치는 구간)은 버린 채로 둔다
      adopt(had, r);
      had.dropped = false;
      had.expanded = false;                                       // 펼쳤던 구간은 버려졌다 — 새 구간은 핀이 아니다
      progress++;
    } else if (had.expanded) {
      continue;                                                   // 청구한 구간은 자리도 내용도 지킨다
    } else {
      // 범위를 모르는 행(병합 실패 시의 청크 원문, search.js 폴백)은 구간을 바꾸지 않는다 — 본문만 갈아 끼우면
      // 위치 표기는 옛 구간을 가리키고 본문은 다른 조각이 되어 서로 어긋난다(실측).
      if (chunk && rangeOf(r) && !within(rangeOf(r), rangeOf(had))) {
        const before = had.content;
        adopt(had, r);
        if (had.content !== before) progress++;
      }
      if (r.detail && !had.detail) { had.detail = true; progress++; }
    }
    front.push(had);
  }
  // 앞으로 옮길 기존 항목을 제자리에서 뺀 뒤, 남은 펼침 접두사 뒤에 이번 검색 순서대로 끼운다.
  const moving = new Set(front);
  for (let i = list.length - 1; i >= 0; i--) if (moving.has(list[i])) list.splice(i, 1);
  const pinned = list.findIndex(o => !o?.expanded);
  list.splice(pinned < 0 ? list.length : pinned, 0, ...front);
  return progress;
}

// 청크 항목의 범위를 문서당 상한(MAX_DOC_LEN)까지 넓힌다 — 본문 청구(expand)의 실제 동작.
// 읽어올 창은 현재 범위의 앞뒤 WINDOW개다. 문서 전체를 읽지 않는 이유: 문서는 수백 청크일 수 있고,
// 상한이 4,500자라 그 이상은 어차피 버린다. 창을 넉넉히 잡는 것은 청크가 작을 때(문서 끝의 짧은
// 조각)를 위한 여유다 — 상한을 채우기 전에 창이 먼저 바닥나면 모델은 '더 있는데 안 준다'를 본다.
// 실패하면 null을 돌려 호출부가 '진도 없음'으로 처리하게 한다 (요청을 버리지 않는다).
const GROW_WINDOW = 8;
// 계측에 남길 지식 적중 수 (검색 한 번당). chat_log의 trace가 요청마다 커지지 않게 상위만 센다.
const TOP_TRACE = 5;

async function growItem(row, loadChunks = loadChunkRanges) {
  const lo = Math.max(1, row.from - GROW_WINDOW);
  const hi = Math.min(row.chunk_of, row.to + GROW_WINDOW);
  try {
    const rows = await loadChunks([{ doc_seq: row.doc_seq, from: lo, to: hi }]);
    // buildItems에 grow=true를 주면 계획된 범위를 넘어 상한까지 채운다. 대표 청크(rep)를 그대로
    // 넘기는 것이 중요하다: 중심이 옮겨 다니면 두 번째 청구가 첫 번째가 준 구간을 되밟고, 무엇보다
    // 항목의 seq가 대표 청크의 것이라 중심이 바뀌면 seq도 바뀐다 — 모델이 방금 청구한 번호가
    // 다음 스텝에 사라진다 (chunk.js buildItems의 rep 주석).
    const [item] = buildItems(
      [{ doc_seq: row.doc_seq, rep: row.rep ?? row.from, from: row.from, to: row.to, chunk_of: row.chunk_of, dist: row._dist }],
      rows, { maxDocLen: MAX_DOC_LEN, grow: true }
    );
    return item ?? null;
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
  let routed = null;             // 마지막 쿼리 검색의 라우팅 여부 — chat_log의 queries 적중 수 의미를 정한다
  let queriesFailed = false;     // 관리 DB에서 쿼리 목록을 못 읽었다
  let searchFailed = false;      // 어느 검색이든 성립하지 않은 대상이 있었다
  const history = [];
  // ctx.searched에 담기는 것은 succeeded다 — 이름은 '찾아본 대상'이지만 뜻은 '찾아낸 대상'이다.
  // 프롬프트의 자료 섹션은 '검색이 성립한' 대상만 보인다(succeeded). 검색해 봤지만 성립하지 않은 대상까지
  // 넣으면 그 섹션이 '(없음)'으로 실려 모델이 '등록된 자료가 없다'로 읽는다 — 프롬프트가 '비어 있음'과
  // '누락됨'을 가르는 이유가 정확히 그것인데, 검색 불가를 '없음' 쪽에 세우면 그 구분이 뒤집힌다.
  // tried는 '한 번이라도 찾아봤는가'다 — '아직 아무것도 안 찾아봤다'는 안내를 붙일지만 가른다(검색이
  // 성립하지 않아 섹션이 없는 요청에 '먼저 찾으라'고 다시 말하면 남은 검색 기회를 그대로 태운다).
  const ctx = () => ({
    question, chat, knowledge, qaMethods, queries, history,
    searched: [...succeeded], tried: searched.size > 0,
  });
  // 성공한 조회의 전체 행(≤MAX_ROWS). history에는 capRows로 자른 20행만 싣는다 — history는 프롬프트와
  // chat_log(steps)로 흘러가므로 거기에 전체를 실으면 둘이 함께 다섯 배 커진다.
  // 전체 행이 필요한 곳은 둘이다: 답변의 차트 참조(`data: step N`, 아래 finish)와 화면 trace 패널
  // (server.js → result.js clientTrace — 사용자가 조회된 행 전부를 보는 유일한 자리다). 둘 다 이 요청의
  // 응답 안에서 끝나므로 history와 나란히 들고 있다가 함께 돌려준다.
  const fullRows = new Map();
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
        onUsage: u => Object.assign(entry, { prompt: u.prompt_tokens, completion: u.completion_tokens }),
        // 듣는 쪽이 없으면 훅을 주지 않는다 — provider는 이 훅이 있을 때만 답변 미리보기를 조립하므로
        // (llm-openai.js answerPreviewer), 스트림을 요청하지 않은 요청에서 그 해독을 조각마다 헛돌게 하지 않는다.
        ...(onEvent && {
          onAnswerDelta: d => emit(d?.reset ? 'answer_reset' : 'answer_delta', d?.reset ? {} : { text: d.text }),
        }),
      }, decideFn);
    } finally {
      entry.ms = Date.now() - t0;
    }
  };
  let guardHits = 0;
  let queryEventSeq = 0;         // 조회 진행 이벤트의 짝 번호 (아래 emit 주석)
  let expands = 0;               // 본문을 펼친 항목 수 (≤ MAX_EXPANDS)
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

  // 버리기 — 자료를 늘리는 결정(search·expand)에 얹혀 온다. 표시만 세우고 목록에서 지우지 않는다:
  // 병합이 seq로 중복을 거르므로(mergeFront) 남겨 두어야 같은 항목이 재검색으로 되살아나지 않는다.
  // 효력은 이 요청 안에서만이다 — 다음 질문까지 남기면 한 번의 오판이 계속 따라다니고 보이지 않는다.
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

  // 본문 청구 — 잘린 항목의 전체 본문을 다음 스텝부터 싣는다. 목록 앞으로 옮기는 것이 중요하다:
  // 프롬프트 예산은 뒤에서부터 버리므로, 그냥 두면 정작 펼친 항목이 잘려 나간다.
  // 그 자리는 이후 검색이 와도 지켜진다 — mergeFront가 펼침 구간 뒤에 끼운다(위 주석).
  // 이미 펼쳤거나 버린 항목, 목록에 없는 식별자는 넘긴다 — 성공한 것의 목록을 돌려준다.
  // 반환: done — 실제로 펼친 식별자, saturated — 번호가 붙어 있었지만(canGrow) 창을 넓혀 읽어 보니 이웃 조각이
  // 상한에 들어가지 않아 한 글자도 늘지 않은 항목 수. 뒤의 것은 검색 시점에 이웃을 읽지 못한 항목에서만 난다.
  const applyExpand = async ids => {
    const done = [];
    let saturated = 0;
    for (const id of ids ?? []) {
      if (expands >= MAX_EXPANDS) break;
      const { list, i } = rowAt(id);
      if (i < 0 || list[i].dropped) continue;
      const row = list[i];
      if (row.doc_seq != null) {
        // 청크 항목 — 범위를 넓힌다. 항목을 새로 만들지 않는 이유: 항목이 곧 '문서의 한 구간'이라
        // 같은 항목을 다시 청구하는 것이 자연스러운 이어받기가 된다. 별도 항목으로 넣으면 같은
        // 문서가 여러 항목으로 흩어져 mergeFront의 문서 단위 중복 제거와 어긋난다.
        if (!canGrow(row)) continue;                 // 상한에 닿았거나 범위 밖 청크가 없다
        const grown = await growItem(row, loadChunks);
        if (!grown) continue;                        // 읽기 실패 — 판정할 근거가 없으니 아무것도 바꾸지 않는다
        // seq는 덮어쓰지 않는다. 모델이 지목한 번호가 그 스텝에 바뀌면 방금 청구한 항목을 다시
        // 청구할 수도 버릴 수도 없다 — 'seq는 요청 내내 고정'이 식별자 설계의 근거다
        // (constants.js ITEM_PREFIX). rep을 그대로 넘기므로 지금은 같은 값이 오지만, 그 계약을
        // 호출 인자에 기대지 않고 여기서 구조로 못 박는다.
        const { seq: _ignored, ...widened } = grown;
        const progressed = grown.content.length > row.content.length;
        // 늘지 않았어도 판정(full)은 받아 적는다 — 그래야 다음 프롬프트에서 번호가 사라진다. 이 표시를 세우지
        // 않으면 모델은 같은 번호를 다시 청구하고, 그 헛도는 스텝이 둘이면 강제 답변으로 넘어간다(실측).
        Object.assign(row, widened);
        if (!progressed) { saturated++; continue; }   // 늘지 않았으면 진도가 아니다
        // 핀 표시. mergeFront가 이 표시로 펼침 구간을 알아보고 그 뒤에 새 검색 결과를 끼운다 —
        // 표시를 세우지 않으면 다음 검색이 청구한 구간을 그대로 앞에서 밀어낸다.
        row.expanded = true;
      } else {
        if (row.expanded) continue;                  // 청크가 아닌 항목(qa_method)은 한 번만 펼친다
        // 번호가 붙지 않은(잘리지 않은) 항목은 청구할 것이 없다 — 프롬프트와 같은 판정이다(llm-openai.js itemLine:
        // 프롬프트에 실리는 형태가 항목 상한을 넘어야 번호가 붙는다). 받아 주면 한 글자도 늘지 않는 청구가
        // '성공'으로 세어져 MAX_EXPANDS 하나를 먹고, 모델은 아무 안내 없이 같은 프롬프트를 다시 받는다(실측).
        if (indentLines(list === qaMethods ? row.method : row.content).length <= MAX_PROMPT_ITEM_LEN) continue;
        row.expanded = true;
      }
      // 펼친 항목은 목록 맨 앞으로. 예산이 뒤에서부터 버리므로 그 자리라야 살아남는다.
      list.splice(i, 1);
      list.unshift(row);
      expands++;
      done.push(id);
    }
    return { done, saturated };
  };

  // 이력 줄은 상한이 있다 — 자리가 없으면 안내를 접는다. 그때는 루프가 곧 그 상한에서 멈추므로
  // 모델이 그 안내를 읽을 스텝 자체가 없다 (constants.MAX_HISTORY_ROWS).
  const pushNote = row => { if (history.length < MAX_HISTORY_ROWS) history.push(row); };

  // 요청의 결과를 조립한다. 검색 요약(chat_log 분석용): 검색 횟수와 대상별 횟수, 대상별 누적 적중 수,
  // 그리고 목록·검색이 성립하지 않았다는 표시. 적중 수는 '검색이 성립한 적 있는' 대상만 숫자다 —
  // 한 번도 찾지 않았거나 찾을 때마다 실패한 대상은 null이다. 0으로 적으면 '찾았는데 없다'와 섞여
  // chat_log 분석이 임베딩 장애 동안의 질문을 전부 '지식 보강 후보'로 잘못 집계한다 (README의 SQL).
  // queries는 라우팅이 동작할 때(등록 30건 초과)만 적중 수이고, 전체를 싣는 소규모에서는 null (적중 개념 없음).
  const done = (answer, forced) => {
    const total = Date.now() - started;
    const summary = {
      searches,
      targets: { ...targetCounts },
      knowledge: succeeded.has('knowledge') ? knowledge.length : null,
      qaMethods: succeeded.has('qa_method') ? qaMethods.length : null,
      queries: succeeded.has('query') && routed ? queries.length : null,
      // 모델이 자료를 얼마나 손봤는가 — 자주 버려지는 지식은 등록 품질 신호다 (README의 운영 루프).
      ...(expands && { expanded: expands }),
      ...(drops && { dropped: drops }),
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
      // 지식 적중의 거리 분포를 남긴다 — 문서당 글자 상한(MAX_DOC_LEN)이 옳은지는 논증이 아니라
      // 이 숫자로 갈린다: 한 문서가 상위를 차지할 때 거리가 촘촘하게 낮으면(0.30~0.40) 그 문서가
      // 정답이니 상한을 올릴 근거이고, 문턱 근처에 흩어져 있으면(0.48~0.55) 긴 문서가 청크 수로
      // 밀고 들어온 것이니 유지할 근거다. 상위 몇 건만 센다 — chat_log가 요청마다 커지면 안 된다.
      if (target === 'knowledge') {
        for (const r of rows.slice(0, TOP_TRACE)) {
          if (r?.doc_seq != null) topHits.push({ doc: r.doc_seq, d: Math.round(r._dist * 1000) / 1000 });
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
        // routed는 '성립한' 쿼리 검색의 판정만 기록한다. 마지막 값으로 덮어쓰면, 앞선 검색이 라우팅 규모를
        // 확인해 목록을 채워 놓고도 뒤이은 검색이 관리 DB 실패로 null을 주는 순간 그 판정이 지워진다 —
        // chat_log에는 '한 번도 못 찾았거나 매번 실패했다'로 남아(README의 분석 SQL) 정반대로 읽힌다.
        if (want.has('query') && !r.directFailed) { succeeded.add('query'); routed = r.routed; }
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
      // 돌려주는 수이고(selectQueries의 slice) 목록은 검색마다 병합되므로, 라우팅 규모에서는
      // MAX_SEARCHES × MAX_PROMPT_QUERIES + MAX_STEPS까지 자란다 (소규모 등록에서는 등록 수를 넘지 않는다 —
      // 매 검색이 같은 전체 목록을 돌려준다). 그래도 프롬프트가 넘치지는 않는다: renderQueries가 짧은 줄부터
      // 확보하고 남는 만큼만 자세히 올린 뒤 꼬리를 버린다.
      registryRow.detail = true;
      if (!queries.includes(registryRow)) queries.unshift(registryRow);
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

  for (let i = 0; i < MAX_STEPS + MAX_SEARCHES + MAX_EXPANDS; i++) {
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

    // 자료를 늘리는 결정만 자료를 줄일 수 있다 (search·expand). 검색보다 '먼저' 적용한다 —
    // 새 결과가 병합되기 전에 표시가 서 있어야 방금 버린 것이 그 검색으로 되살아나지 않는다.
    const droppedNow = decision.action === 'search' || decision.action === 'expand'
      ? applyDrop(decision.drop) : 0;

    if (decision.action === 'expand') {
      const { done: grownIds, saturated } = await applyExpand(decision.ids);
      // 펼쳤거나 버렸으면 자료가 달라졌다 — 진도로 본다. 둘 다 없으면 헛돈 스텝이다.
      if (grownIds.length || droppedNow) { guardHits = 0; continue; }
      // 번호가 붙어 있던 항목이 늘지 않은 경우는 따로 말한다 — '번호가 붙은 항목만 청구할 수 있다'는 안내는
      // 모델이 방금 그렇게 한 상황에서 모순이고, 왜 안 됐는지도 다음 행동도 담고 있지 않다.
      pushNote({
        expand: decision.ids,
        note: expands >= MAX_EXPANDS
          ? `본문 청구 상한(${MAX_EXPANDS}건)에 닿았다 — 지금까지의 자료로 답변하라`
          : saturated
            ? '청구한 항목은 더 넓힐 수 없다 — 이웃 조각이 문서당 글자 상한에 들어가지 않는다. 번호가 사라진 것이 그 표시이니 지금 범위로 답변하라'
            : '펼칠 수 있는 항목이 없다 — 번호가 붙은 항목만 청구할 수 있다',
      });
      if (++guardHits >= MAX_GUARD_HITS) break;
      continue;
    }

    if (decision.action === 'search') {
      const text = decision.text || question;   // 빈 검색어는 현재 질문으로 (llm.js sanitizeDecision 주석)
      const targets = decision.targets;
      const key = searchKey(text, targets);
      // 같은 검색의 반복과 횟수 상한은 루프 가드와 같은 부류다 — note로 남기고 연속 카운터를 올린다.
      const guardNote = history.some(h => h.search !== undefined && !h.note && searchKey(h.search, h.targets) === key)
        ? '이미 같은 검색어·대상으로 검색했다 — 검색된 자료로 답변하거나 다른 검색어를 쓰라'
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
          routed: null, queriesFailed: false, directFailed: false,
        };
      }
      const { added, hits, failed } = absorb(result, targets);
      history.push({ search: text, targets, hits, ...(failed.length && { failed }) });
      emit('search_done', { text, targets, hits, ...(failed.length && { failed }) });
      // 새 자료가 하나도 없으면 헛돈 스텝이다 — 미등록 쿼리 이름과 같은 연속 카운터로 센다.
      // (검색어를 바꿔 한 번 더 시도할 기회는 남는다 — 첫 1회는 카운터만 오른다)
      if (added === 0) { if (++guardHits >= MAX_GUARD_HITS) break; } else guardHits = 0;
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
    const roomRows = MAX_HISTORY_ROWS - history.length;
    const want = Math.min(items.length, MAX_STEPS - runs);
    const take = want + (want < items.length ? 1 : 0) <= roomRows ? want : Math.max(0, roomRows - 1);
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
      history.push({
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
  // 버린 항목은 여기서도 뺀다. 프롬프트에서 뺀 것(llm-openai.js live)을 폴백이 '관련 지식'으로 붙이면, 모델이
  // 무관하다고 판정한 본문이 그 판정을 무시한 채 사용자에게 나가고 정작 남긴 지식은 그 뒤에 가려진다(실측).
  const rendered = renderAnswer({ ...ctx, knowledge: (ctx.knowledge ?? []).filter(k => !k?.dropped) });
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
  const out = { knowledge, qaMethods, queries: undefined, routed: null, queriesFailed: false, directFailed: false };
  if (!want.has('query') && !qaMethods?.length) return out;
  // 쿼리 목록 로드 실패로 검색 전체를 버리지 않는다 — 함께 버려지는 것이 방금 찾은 지식·처리방법이고,
  // 그중에는 DB 조회가 아예 필요 없는 순수 지식 질문도 있다. 실패는 표시로 남겨 chat_log가
  // '등록이 없어서 못 답한 질문'과 구분하게 한다 (queriesFailed).
  try {
    const { list, routed } = await selectQueries(qaMethods ?? [], direct, want.has('query'));
    out.queries = list;
    out.routed = routed;
    // 직접 검색이 성립하지 않았는데(direct === null) 등록이 소규모라 전체를 실었으면 그건 정상이다 —
    // 목록에 없는 쿼리가 없다. 라우팅 규모에서만 '검색 불가'로 알린다 (경로A 쿼리만 실린 목록이므로).
    out.directFailed = direct === null && routed === true;
  } catch (e) {
    // 상세는 로그에만 — 화면 문구는 호출부가 만들고, MariaDB 원문에는 스키마·호스트가 들어 있다.
    console.warn('[agent] failed to load the query list:', e.message);
    out.queries = null;
    out.queriesFailed = true;
  }
  return out;
}

// 직접 검색(경로B)의 상위 몇 건까지 자세한 형태(입출력 설명·SQL)로 보일지. 나머지는 이름·용도·바인드만
// 보인다 — 고르는 데는 그것이면 되고, 지목하면 다음 스텝에 자세히 실린다 (llm-openai.js renderQueries).
const DETAIL_TOP = 5;

// 프롬프트에 실을 쿼리 선정. 관련도 순으로 두 경로를 합친다:
//   경로A: 찾은 qa_method 본문이 지목한 query_name (다단계 절차 보장 — 본문 등장 순서를 지킨다)
//   경로B: 검색어로 query_registry 자체를 벡터 검색한 결과 (search.js) — qa_method 없이 등록한 쿼리도 찾는다
// 등록 30건 이하면 검색에 걸리지 않은 나머지까지 전부 뒤에 이어 붙인다(짧은 형태) — 설명이 얇아 검색에
// 안 걸린 쿼리도 이름은 보여야 모델이 지목할 수 있다. 초과하면 검색 결과만 싣는다(라우팅).
// 반환: { list, routed } — routed는 'query'를 검색했을 때만 true/false이고, 경로A만 돌았으면 null.
//
// 경로A는 '본문에서 이름처럼 보이는 토큰을 뽑아 IN 절로 묻는' 방식이었다. 그 추출식이
// /[A-Za-z_][A-Za-z0-9_]{2,}/ 라서 한글 query_name은 어떤 본문에서도 한 번도 뽑히지 않았다 —
// query_name은 VARCHAR(100)에 문자 제한이 없고 이 코드베이스는 다른 곳에 전부 한글을 쓴다.
// 한국어는 조사가 낱말에 붙어 '배치상태조회를'이 한 낱말이므로 토큰화로는 고칠 수 없다.
// 그래서 방향을 뒤집는다 — '등록된 이름이 본문에 들어 있는가'를 관리 DB가 직접 본다
// (db.js loadQueriesMentionedIn). 등장 위치를 DB가 함께 돌려주므로 순서 보장이 정확하다.
// 본문은 검색 결과 순서대로 이어 붙인다 — 위치 순서가 곧 '관련도 높은 처리방법 먼저, 그 안에서는
// 등장 순서대로'가 된다. method는 NOT NULL이지만 컬럼 하나가 완화되거나 임포터가 NULL을 넣는
// 순간 여기서 죽는다 — 이 값의 다른 소비자(llm-openai clip, embed-sync toText)는 전부 NULL을 견딘다.
// 소문자화는 자르기 전에 한다 (자른 뒤에 하면 길이가 상한을 넘을 수 있다).
async function selectQueries(qaMethods, direct, wantDirect) {
  const routeText = clipText(
    qaMethods.map(m => String(m.method ?? '')).join('\n').toLowerCase(),
    MAX_ROUTE_TEXT_LEN
  );
  // 상한+1건만 읽어 "전체를 실어도 되는 규모인지"를 같은 왕복에서 판정한다 (COUNT 후 다시 SELECT하면
  // 왕복 2회). 라우팅 규모에서는 이 31행이 버려진다 — 상한이 걸린 고정 비용이라 왕복 1회 쪽이 낫다.
  const [named, head] = await Promise.all([
    loadQueriesMentionedIn(routeText),               // 빈 본문이면 왕복하지 않는다 (db.js)
    wantDirect ? loadQueryRegistry(MAX_PROMPT_QUERIES + 1) : [],
  ]);
  const routed = wantDirect ? head.length > MAX_PROMPT_QUERIES : null;

  const seen = new Set();
  const list = [];
  const push = (q, detail) => {
    if (seen.has(q.seq)) return;
    seen.add(q.seq);
    if (detail) q.detail = true;
    list.push(q);
  };
  named.forEach(q => push(q, true));                      // 절차용(경로A)이 먼저, 자세히
  (direct ?? []).forEach((q, i) => push(q, i < DETAIL_TOP));
  if (routed === false) head.forEach(q => push(q, false)); // 소규모: 나머지 등록 전부 (짧은 형태)
  return { list: list.slice(0, MAX_PROMPT_QUERIES), routed };
}
