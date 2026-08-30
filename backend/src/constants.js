// 여러 계층이 공유하는 상수와 헬퍼.
// 별도 모듈로 둔 이유: 이 값들이 oracle.js/agent.js/llm*.js에 걸쳐 있어 어느 한쪽에 두면
// 프롬프트 조립 모듈이 DB 드라이버(oracledb)를 import하게 되고, 정의와 사용 방향이 엇갈린다.

// 조회 결과 상한 — capped 판정(oracle.js)과 사용자 안내 문구(llm*.js)가 같은 값을 봐야 한다
export const MAX_ROWS = 100;

// LLM 컨텍스트/답변에 전달할 최대 행 수 (총 건수는 totalRows로 보존)
export const MAX_RESULT_ROWS = 20;

// 셀 값 최대 길이 (CLOB 등 대형 텍스트 방어). 드라이버 경계(oracle.js)에서 바로 적용해
// 대형 LOB 문자열이 history·chat_log까지 흘러가지 않게 한다.
export const MAX_CELL_LEN = 200;

// 잘린 셀에 붙이는 표시. 자르는 쪽(oracle.js)과 그 값을 바인드로 재사용하면 안 되는 쪽(llm.js)이 함께 본다.
export const TRUNC_MARK = '…(생략)';

// ===== 프롬프트 길이 예산 =====
// knowledge.content / qa_method.method / query_sql은 전부 TEXT(최대 64KB)이고, 조회 결과 행은
// 컬럼 수에 상한이 없다 — 어느 쪽도 그 자체로는 프롬프트 크기를 묶어주지 않는다. 긴 문서 몇 건이나
// 컬럼 많은 쿼리 한 건이 등록되는 것만으로 컨텍스트를 넘겨 그 뒤 모든 질문이 'LLM 호출 실패'로 끝난다.
// Oracle 셀을 MAX_CELL_LEN으로 막는 것과 같은 이유이므로 같은 방식(경계에서 한 번)으로 막는다.
//
// 상한을 '전체 하나 + 섹션별 최소 몫'으로 두는 것이 핵심이다. 섹션마다 독립된 상한을 두면
// ① 합계가 문서와 어긋나도 아무 데서도 드러나지 않고(12k+12k+20k=44k인데 주석은 36k였다),
// ② 상한을 두지 않은 섹션 하나가 나머지 전부를 무의미하게 만든다(실행 이력이 그랬다 —
//    컬럼 10개짜리 조회 한 번이면 한 스텝에 4만 자가 들어간다).
// 전체 예산이 하나면 어느 섹션이 길어지든 합계는 반드시 이 값 안에 든다.
//
// 값은 32k 컨텍스트 모델(예: Qwen2.5-32B-Instruct)을 기준으로 잡았다. 한국어는 토큰 밀도가 높아
// 문자 수와 토큰 수가 거의 1:1까지 갈 수 있으므로 문자 기준으로 보수적으로 묶는다.
// 이 예산 밖에 있는 몫: 최근 대화(MAX_CHAT_TURNS×MAX_CHAT_LEN = 3k)와 질문(MAX_QUESTION_LEN = 2k) =
// 이미 다른 상한으로 묶여 있는 5k, 그리고 시스템 프롬프트 ~1.5k.
// 합계 ≈ 28.5k자 → 32k 모델에서 답변 몫으로 3.5k가 남는다.
export const MAX_PROMPT_TOTAL_LEN = 22_000;

// 섹션별 최소 몫 — 다른 섹션이 아무리 길어도 이만큼은 보장된다.
// 배분 순서(= 이 객체의 선언 순서)는 우선순위의 '역순'이다: 배분할 때 뒤 섹션들의 최소 몫을
// 미리 떼어놓고 나머지를 이번 섹션에 주므로, 맨 뒤에 배분받는 섹션이 앞에서 남긴 여유를 전부 가져간다.
// 가장 중요한 섹션을 맨 뒤에 둔다.
//   지식·처리방법: 잘려도 답이 부실해질 뿐이다.
//   실행 이력    : 잘리면 이미 조회해둔 결과를 버리고 같은 질문에 다시 매달린다.
//   쿼리 목록    : 잘리면 에이전트가 그 조회를 아예 못 한다 — 남는 여유는 전부 여기로 간다.
// 합계는 반드시 MAX_PROMPT_TOTAL_LEN 이하여야 한다 (아래에서 검증한다 — 이 검증이 없어서
// 섹션 상한과 전체 상한이 조용히 어긋났다).
export const PROMPT_FLOORS = {
  knowledge: 2_000,
  qaMethods: 2_000,
  history: 6_000,
  queries: 8_000,
};

const FLOOR_SUM = Object.values(PROMPT_FLOORS).reduce((a, b) => a + b, 0);
if (FLOOR_SUM > MAX_PROMPT_TOTAL_LEN) {
  // import 시점에 터뜨린다 — 예산이 어긋난 채로 뜨면 등록이 늘어난 뒤에야, 그것도
  // '모든 질문이 LLM 호출 실패'라는 원인이 안 보이는 형태로 드러난다.
  throw new Error(
    `프롬프트 섹션 최소 몫 합계(${FLOOR_SUM})가 전체 예산(${MAX_PROMPT_TOTAL_LEN})을 넘습니다 — constants.js를 확인하세요.`
  );
}

export const MAX_PROMPT_ITEM_LEN = 1000;  // 항목 본문 1건
export const MAX_PROMPT_SQL_LEN = 2000;   // query_sql — 잘려도 바인드명은 프롬프트가 따로 싣는다
// 실행 이력 1스텝의 상한. 스텝 하나가 이력 예산을 통째로 먹으면 나머지 스텝이 전부 밀려난다 —
// 다단계 절차에서 앞 단계의 결과가 사라지면 모델이 그 단계를 다시 실행하려 든다.
export const MAX_PROMPT_STEP_LEN = 2500;
// 실행 이력 한 줄의 params 표시 상한 — rows와 달리 params는 LLM이 만든 값이라 그 자체로는 상한이
// 없고, renderHistory는 최소 1줄을 반드시 실으므로 줄이 유계가 아니면 전체 예산이 그대로 뚫린다.
// 표시용으로만 자른다 (실행에 쓰는 값은 MAX_BIND_LEN이 결정 경계에서 따로 묶는다).
export const MAX_PROMPT_PARAMS_LEN = 500;

// 임베딩 원문 상한 — 모델 입력 한도를 넘는 행 하나가 배치 전체를 실패시키는 것을 입력 단계에서 막는다.
// bge-m3는 8192토큰이고 한국어는 대략 문자당 1토큰 미만이라 4000자면 한도 안에 든다.
export const MAX_EMBED_TEXT_LEN = 4000;

// 서버가 클라이언트에서 받는 대화 이력 상한 — 프런트가 페이로드를 맞추는 기준이기도 하다.
export const MAX_CHAT_TURNS = 6;  // LLM에 전달할 최근 대화 턴 수 (프롬프트 비대화 방지)
export const MAX_CHAT_LEN = 500;  // 턴별 최대 길이

// 질문 한 건의 최대 길이 — 서버 입력 검증(server.js), 프롬프트 예산 계산(위 주석), 회귀 테스트가
// 같은 값을 봐야 한다. 예산의 모든 항이 이름 있는 export인데 이 항만 리터럴로 흩어져 있으면
// server.js의 숫자 하나를 올리는 순간 문서화된 합계와 테스트의 여유분이 소리 없이 어긋난다.
// (프런트 App.jsx의 maxLength는 입력 안내용 사본이다 — 실제 제한은 서버가 한다)
export const MAX_QUESTION_LEN = 2000;

// LLM 결정의 바인드 값 상한 — 결정이 시스템에 들어오는 경계(llm.js sanitizeDecision)에서 적용한다.
// 정당한 바인드 값의 출처는 질문(≤ MAX_QUESTION_LEN)과 조회 결과 셀(≤ MAX_CELL_LEN)뿐이므로
// 이보다 긴 값은 모델이 지어냈거나 어딘가에서 통째로 복사해 온 것이다. 자른 값에는 TRUNC_MARK가
// 붙어 바인드 가드(oracle.js bindProblem)가 실행 전에 거부한다 — 조용히 잘린 값으로 조회해
// 0건 오답을 만드는 대신 소리 나게 실패시킨다.
export const MAX_BIND_LEN = MAX_QUESTION_LEN;

// 길이 상한으로 문자열을 자르는 단일 지점.
// 단순 slice는 서로게이트 쌍(이모지 등 BMP 밖 문자)을 반으로 쪼개 짝 잃은 코드유닛을 남긴다.
// 그 문자열은 JSON.stringify는 통과하지만(\uD83D로 이스케이프된다) 유효한 UTF-8이 아니라서
// 받는 쪽(임베딩 서버·LLM API)이 거부하거나 U+FFFD로 바꿔 놓는다 —
// 임베딩에서는 그 한 행이 매 주기 거부되고, 프롬프트에서는 본문이 조용히 훼손된다.
// 경계에 걸린 상위 서로게이트 하나를 떼어 항상 온전한 문자열을 돌려준다.
export function clipText(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// 쿼리 이름 비교 키. query_registry 조회는 MariaDB 기본 collation(대소문자·후행 공백 무시)이라
// JS의 ===로 비교하면 'BATCH_JOB_STATUS'와 'batch_job_status'가 서로 다른 쿼리로 보인다.
// 이름으로 무언가를 판정하는 곳(agent의 루프 가드, mock의 실행 계획과 stub 데이터 조회)은 전부 이 키를 쓴다 —
// 한 곳이라도 ===로 남으면 그 경로에서만 가드가 조용히 무력화된다.
export const nameKey = s => String(s ?? '').trim().toLowerCase();

// 반복되는 경고의 단일 억제 지점.
// 같은 오류가 매 주기·매 요청 반복될 때 로그를 도배하지 않되, 오류의 '성격'이 바뀌면 반드시 다시 알린다.
// 무조건 1회만 경고하는 플래그(let warned = true)는 첫 원인이 해소된 뒤 전혀 다른 이유로 같은 기능이
// 죽어도 로그를 한 줄도 남기지 않는다 — 벡터 검색과 NLS 포맷 고정이 그 상태였고, 둘 다 실패해도
// 기능이 조용히 폴백만 하므로 로그가 유일한 단서다. 억제 방식을 한 곳으로 모아 셋이 같게 동작하게 한다.
const lastWarned = new Map();
export function warnOnce(scope, message) {
  if (lastWarned.get(scope) === message) return;
  lastWarned.set(scope, message);
  console.warn(`[${scope}] ${message}`);
}

// 사용자에게 그대로 보여도 되는 오류 — 우리가 문구를 만든 오류에만 붙인다.
// 드라이버·DB가 던진 원문은 스키마명·호스트·계정을 담고 있어 화면으로 나가면 안 된다(server.js가 이 표시를 본다).
// 프롬프트와 chat_log에는 양쪽 다 원문이 들어간다 — 모델의 복구 판단과 운영 분석에는 상세가 필요하다.
//
// 두 번째 인자(hint)는 모델에게만 주는 복구 지침이다 — 프롬프트(llm-openai.js historyLine)에는 붙고,
// 사용자 trace 패널(server.js)에는 message만 나간다. 한 문자열에 섞으면 "…쿼리를 선택하라"류의
// 내부 지시문이 safe 표시를 타고 화면까지 나간다 — note와 error를 나눈 것과 같은 이유로 필드를 나눈다.
export const safeError = (msg, hint) => Object.assign(new Error(msg), { safe: true, ...(hint && { hint }) });

// 정수 환경변수 파서. 빈 문자열('')과 공백은 미설정으로 취급한다 —
// `Number(process.env.X ?? 기본값)`은 `X=`(빈 값)에서 ??가 발동하지 않아 0이 되고,
// 0이 "타임아웃 없음"이나 "주기 동기화 끔" 같은 정반대 의미를 갖는 자리에서 조용히 기능을 꺼버린다.
// 정수만 허용하는 이유: 이 값들이 가는 곳이 전부 정수를 요구한다 —
// node-oracledb의 callTimeout 세터는 정수가 아니면 던지고(모든 조회 실패), listen()의 포트도 마찬가지다.
// 검증한다고 해놓고 소수를 흘려보내면 '검증했다'는 착각만 남는다.
// allowZero: 0을 유효한 값(끄기)으로 허용할지. 기본은 양수만 허용.
export function numEnv(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const v = Number(raw);
  if (Number.isInteger(v) && (v > 0 || (allowZero && v === 0))) return v;
  console.warn(`[env] ${name} 값이 올바르지 않아 기본값(${fallback})을 사용합니다: ${JSON.stringify(raw)}`);
  return fallback;
}
