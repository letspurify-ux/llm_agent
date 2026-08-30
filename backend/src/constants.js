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

// 프롬프트에 싣는 검색 결과 본문 상한.
// knowledge.content / qa_method.method / query_sql은 전부 TEXT(최대 64KB)라 그 자체로는 상한이 없다 —
// 긴 문서 몇 건이 등록되는 것만으로 컨텍스트를 넘겨 그 뒤 모든 질문이 'LLM 호출 실패'로 끝난다.
// Oracle 셀을 MAX_CELL_LEN으로 막는 것과 같은 이유이므로 같은 방식(경계에서 한 번)으로 막는다.
// 값은 32k 컨텍스트 모델(예: Qwen2.5-32B-Instruct)을 기준으로 잡았다. 한국어는 토큰 밀도가 높아
// 문자 수와 토큰 수가 거의 1:1까지 갈 수 있으므로 문자 기준으로 보수적으로 묶는다.
// 최악(세 섹션이 동시에 예산을 꽉 채움) ≈ 36k자 + 실행 이력 + 대화. 등록 내용이 평범한 길이면
// 예산에 닿지도 않는다 — 이 상한은 '긴 문서 한 건이 전부를 망가뜨리는 것'을 막기 위한 것이다.
export const MAX_PROMPT_ITEM_LEN = 1000;      // 항목 본문 1건
export const MAX_PROMPT_SQL_LEN = 2000;       // query_sql — 잘려도 바인드명은 프롬프트가 따로 싣는다
export const MAX_PROMPT_SECTION_LEN = 12_000; // 지식·처리방법 섹션 합계
// 쿼리 목록은 따로, 더 넉넉히 잡는다. 지식은 빠져도 답이 부실해질 뿐이지만 쿼리가 빠지면
// 에이전트가 그 조회를 아예 못 한다 — 지식/처리방법과 같은 무게로 다룰 것이 아니다.
// 등록 수는 이미 MAX_PROMPT_QUERIES(+MAX_STEPS)로 묶여 있고 실측상 항목당 300~450자라,
// 12k는 평범한 등록 30건에서 이미 잘리기 시작한다(실측: 항목당 447자 → 26/31건만 실림).
export const MAX_PROMPT_QUERY_SECTION_LEN = 20_000;

// 임베딩 원문 상한 — 모델 입력 한도를 넘는 행 하나가 배치 전체를 실패시키는 것을 입력 단계에서 막는다.
// bge-m3는 8192토큰이고 한국어는 대략 문자당 1토큰 미만이라 4000자면 한도 안에 든다.
export const MAX_EMBED_TEXT_LEN = 4000;

// 서버가 클라이언트에서 받는 대화 이력 상한 — 프런트가 페이로드를 맞추는 기준이기도 하다.
export const MAX_CHAT_TURNS = 6;  // LLM에 전달할 최근 대화 턴 수 (프롬프트 비대화 방지)
export const MAX_CHAT_LEN = 500;  // 턴별 최대 길이

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

// 사용자에게 그대로 보여도 되는 오류 — 우리가 문구를 만든 오류에만 붙인다.
// 드라이버·DB가 던진 원문은 스키마명·호스트·계정을 담고 있어 화면으로 나가면 안 된다(server.js가 이 표시를 본다).
// 프롬프트와 chat_log에는 양쪽 다 원문이 들어간다 — 모델의 복구 판단과 운영 분석에는 상세가 필요하다.
export const safeError = msg => Object.assign(new Error(msg), { safe: true });

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
