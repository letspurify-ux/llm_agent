// 여러 계층이 공유하는 상수와 환경변수 헬퍼.
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

// 서버가 클라이언트에서 받는 대화 이력 상한 — 프런트가 페이로드를 맞추는 기준이기도 하다.
export const MAX_CHAT_TURNS = 6;  // LLM에 전달할 최근 대화 턴 수 (프롬프트 비대화 방지)
export const MAX_CHAT_LEN = 500;  // 턴별 최대 길이

// 숫자 환경변수 파서. 빈 문자열('')과 공백은 미설정으로 취급한다 —
// `Number(process.env.X ?? 기본값)`은 `X=`(빈 값)에서 ??가 발동하지 않아 0이 되고,
// 0이 "타임아웃 없음"이나 "주기 동기화 끔" 같은 정반대 의미를 갖는 자리에서 조용히 기능을 꺼버린다.
// allowZero: 0을 유효한 값(끄기)으로 허용할지. 기본은 양수만 허용.
export function numEnv(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const v = Number(raw);
  if (Number.isFinite(v) && (v > 0 || (allowZero && v === 0))) return v;
  console.warn(`[env] ${name} 값이 올바르지 않아 기본값(${fallback})을 사용합니다: ${JSON.stringify(raw)}`);
  return fallback;
}
