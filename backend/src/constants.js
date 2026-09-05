// 여러 계층이 공유하는 상수와 헬퍼.
// 별도 모듈로 둔 이유: 이 값들이 oracle.js/agent.js/llm*.js에 걸쳐 있어 어느 한쪽에 두면
// 프롬프트 조립 모듈이 DB 드라이버(oracledb)를 import하게 되고, 정의와 사용 방향이 엇갈린다.

// ===== 환경변수 파서 =====
// 파일 맨 앞에 둔다. 아래 상수 몇 개가 모듈이 평가되는 '그 자리에서' 이 함수를 부르는데(SEARCH_LIMIT·
// MAX_SEARCHES), 함수 선언은 호이스팅되어도 그 함수가 닫아 잡은 const(INT_RE)는 그렇지 않다 —
// 뒤에 두면 값을 설정한 순간에만 'Cannot access INT_RE before initialization'으로 모듈이 통째로 죽는다.
// 값을 비워 둔 기본 설정에서는 numEnv가 그 줄에 닿기 전에 돌아가므로 아무 일도 없어, 문서대로 값을
// 채워 넣은 설치에서만 서버가 뜨지 않는다(실측). 선언 순서가 곧 계약이라 여기서 확정한다.

// 정수 환경변수 파서. 빈 문자열('')과 공백은 미설정으로 취급한다 —
// `Number(process.env.X ?? 기본값)`은 `X=`(빈 값)에서 ??가 발동하지 않아 0이 되고,
// 0이 "타임아웃 없음"이나 "주기 동기화 끔" 같은 정반대 의미를 갖는 자리에서 조용히 기능을 꺼버린다.
// 정수만 허용하는 이유: 이 값들이 가는 곳이 전부 정수를 요구한다 —
// node-oracledb의 callTimeout 세터는 정수가 아니면 던지고(모든 조회 실패), listen()의 포트도 마찬가지다.
// 검증한다고 해놓고 소수를 흘려보내면 '검증했다'는 착각만 남는다.
// allowZero: 0을 유효한 값(끄기)으로 허용할지. 기본은 양수만 허용.
// 값이 아니라 '표기'를 먼저 본다. Number()는 16진수('0x50' → 80)와 지수 표기('1e10' → 10000000000)를
// 조용히 받아주는데, 그 결과는 정수라 Number.isInteger 검사를 그대로 통과한다 — 오타 하나가 경고 없이
// 전혀 다른 설정이 된다. ORACLE_TIMEOUT_MS=1e10은 callTimeout을 약 116일로 만들어 사실상 '타임아웃 없음'이
// 되고(바로 위 주석이 막겠다고 한 그 결과가 다른 오타로 되살아난다), MARIADB_POOL_SIZE=1e5는
// 커넥션 10만 개를 요청하며, PORT=0x50은 .env 어디에도 적혀 있지 않은 80번 포트에 바인드한다.
// 셋 다 남는 증상이 '멈춤' 또는 '접속 폭주'뿐이고 설정을 가리키는 단서는 없다.
// 안전 정수 범위도 함께 본다 — 그 밖의 값은 Number()가 근사해 적어둔 표기와 실제 값이 갈라진다.
const INT_RE = /^[+-]?\d+$/;

// 상한이 있는 정수 환경변수 — numEnv에 '이보다 크면 상한으로 낮춘다'를 더한다. 이 값들(검색 후보 수·검색 횟수)은
// 프롬프트 예산이 전제하는 최대치라 넘기면 예산 불변식이 조용히 깨진다. 낮추는 것은 알리고 받아들인다 —
// 조용히 기본값으로 되돌리면 "20으로 적었는데 왜 그대로지"가 되고, 던지면 설정 하나로 서버가 안 뜬다.
// 함수 선언이라 위(MAX_SEARCHES)에서 먼저 불러도 된다(호이스팅) — numEnv도 같은 이유로 선언문이다.
export function boundedEnv(name, fallback, max) {
  const v = numEnv(name, fallback);
  if (v <= max) return v;
  console.warn(`[env] ${name}=${v} exceeds the ceiling (${max}) the prompt budget is built for — using ${max}.`);
  return max;
}

export function numEnv(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  const s = raw === undefined ? '' : String(raw).trim();
  if (s === '') return fallback;
  const v = Number(s);
  if (INT_RE.test(s) && Number.isSafeInteger(v) && (v > 0 || (allowZero && v === 0))) return v;
  console.warn(`[env] invalid value for ${name}, falling back to default (${fallback}): ${JSON.stringify(raw)}`);
  return fallback;
}


// 조회 결과 상한 — capped 판정(oracle.js)과 사용자 안내 문구(llm*.js)가 같은 값을 봐야 한다.
// 이 행 전부가 가는 곳은 화면 trace 패널(result.js clientTrace)과 답변의 차트 참조(chart.js, 글자 예산으로
// 따로 묶인다)뿐이다 — 프롬프트·chat_log는 MAX_RESULT_ROWS(20)만 본다. 한 스텝의 최악 크기는
// MAX_ROWS × MAX_RESULT_COLS × MAX_CELL_LEN(1000 × 30 × 200자 ≈ 6MB)이고 스텝 수(MAX_STEPS)만큼 곱해진다 —
// 응답 하나가 그만큼 커질 수 있음을 알고 잡은 값이다(보통의 결과는 열 10개·셀 20자 안팎이라 수백 KB).
export const MAX_ROWS = 1000;

// LLM 컨텍스트/답변에 전달할 최대 행 수 (총 건수는 totalRows로 보존)
export const MAX_RESULT_ROWS = 20;

// 셀 값 최대 길이 (CLOB 등 대형 텍스트 방어). 드라이버 경계(oracle.js)에서 바로 적용해
// 대형 LOB 문자열이 history·chat_log까지 흘러가지 않게 한다.
export const MAX_CELL_LEN = 200;

// 잘린 셀에 붙이는 표시. 자르는 쪽(oracle.js)과 그 값을 바인드로 재사용하면 안 되는 쪽(llm.js)이 함께 본다.
export const TRUNC_MARK = '…(생략)';

// 결과 행의 컬럼 수 상한 — 셀 길이(MAX_CELL_LEN)·행 수(MAX_ROWS)와 함께 결과 크기의 세 축을
// 전부 묶는다. 이 축만 비면 SELECT *로 등록된 넓은 테이블의 행 하나(컬럼 수 × 셀 상한)가
// 프롬프트 예산과 답변·trace·chat_log를 그대로 관통한다 — 아래 프롬프트 예산이 "행 하나는
// 유계"라는 전제 위에 서 있는데, 그 전제를 보장하는 곳이 없었다. 셀과 같은 드라이버 경계
// (oracle.js normalizeCells)에서 적용하고, 잘랐다는 표시를 행 안에 남긴다 —
// 조용히 자르면 모델과 사용자가 그 컬럼을 '없다'로 단정한다.
export const MAX_RESULT_COLS = 30;

// ===== 프롬프트 길이 예산 =====
// knowledge.content / qa_method.method / query_sql은 전부 TEXT(최대 64KB)이고, 조회 결과 행도
// 컬럼 수 상한까지(MAX_RESULT_COLS × MAX_CELL_LEN ≈ 6천 자) 커진다 — 어느 쪽도 그 자체로는
// 프롬프트 크기를 묶어주지 않는다. 긴 문서 몇 건이나
// 컬럼 많은 쿼리 한 건이 등록되는 것만으로 컨텍스트를 넘겨 그 뒤 모든 질문이 'LLM 호출 실패'로 끝난다.
// Oracle 셀을 MAX_CELL_LEN으로 막는 것과 같은 이유이므로 같은 방식(경계에서 한 번)으로 막는다.
//
// 상한을 '전체 하나 + 섹션별 최소 몫'으로 두는 것이 핵심이다. 섹션마다 독립된 상한을 두면
// ① 합계가 문서와 어긋나도 아무 데서도 드러나지 않고(12k+12k+20k=44k인데 주석은 36k였다),
// ② 상한을 두지 않은 섹션 하나가 나머지 전부를 무의미하게 만든다(실행 이력이 그랬다 —
//    컬럼 10개짜리 조회 한 번이면 한 스텝에 4만 자가 들어간다).
// 전체 예산이 하나면 어느 섹션이 길어지든 합계는 반드시 이 값 안에 든다.
//
// 값은 128k 컨텍스트 모델을 기준으로 잡았다. 앞선 값들과 그때 잘리던 것:
//   22k자 — 32k 모델(Qwen2.5-32B-Instruct) 기준. 지식 20/20·쿼리 35/35는 실리는데 Q&A 처리 방법
//           10/20, 실행 이력 2/5. 이력은 앞선 스텝이 Oracle 왕복을 태워 가져온 결과이자 답변의 근거 그 자체다.
//   40k자 — 최악 25k 토큰(128k의 20%)으로 안전했지만, 1000자짜리 항목이면 지식·처리 방법은 검색
//           후보 20건 중 7건·9건만 실리고, 실행 이력은 5스텝이 각자 상한까지 차면 강제 답변 스텝에서
//           1번 스텝이 빠졌다(이력 최소 몫 14k < 5 × 3k + 머리말). 100k 토큰이 놀면서 근거가 잘리고 있었다.
//
// 상한은 '천장'이지 '할당량'이 아니다. 항목마다 개별 상한(MAX_PROMPT_ITEM_LEN·SQL·STEP)이 이미
// 걸려 있고 건수도 유한하므로, 평범한 요청은 이 값을 올려도 그대로다 (실측: 4,809자 요청은
// 상한이 64k여도 4,809자). 커지는 것은 '원래 잘렸을 요청'뿐이고, 그때는 싣는 쪽이 낫다.
//
// 문자 기준으로 묶는 이유: 토크나이저는 모델(서버)마다 다르고 이 프로세스에는 없다. 문자↔토큰 비율은
// Qwen2.5 토크나이저로 실측했다 — 한국어 산문 1.5자/토큰, 쿼리 목록(SQL 섞임) 1.9, 결과 JSON 2.2,
// 프롬프트 전체 1.8. 한국어에 덜 우호적인 토크나이저(cl100k류)는 각각 1.2 / 1.6 / 2.1 / 1.5.
// 이 예산 밖에 있는 몫: 최근 대화(MAX_CHAT_TURNS×MAX_CHAT_LEN = 9k)와 질문(MAX_QUESTION_LEN = 2k) =
// 이미 다른 상한으로 묶여 있는 11k, 그리고 시스템 프롬프트(llm-openai.js MAX_SYSTEM_PROMPT_LEN = 6k,
// 실측 ~5k). 세 몫 모두 상수가 묶는다 — 시스템 프롬프트만 관측값이던 동안 이 주석의 숫자가 실제의
// 3분의 1까지 벌어져 있었다(~1.8k라 적고 실측 4.9k).
// 최악(네 섹션이 예산에 꽉 찬 요청 + 대화 + 질문 + 시스템 = 97k자) ≈ 54k 토큰, 비우호적
// 토크나이저라도 ≈ 65k → 128k의 42~50%. 출력 가드(MAX_COMPLETION_TOKENS)를 더해도 55~63%다.
//   64k자 — 통상 요청은 후보가 꽉 차도 24.5k자만 썼다(실측: 지식 11건·처리방법 10건이 잘린 채로). 남는 몫이
//           배분 순서상 맨 뒤(쿼리 목록)로만 흘렀고 그 섹션은 detail 표시 없이는 여유를 쓰지 않아 통째로
//           버려졌다. 순서를 뒤집고 천장(PROMPT_CEILINGS)을 두면서, 천장이 뜻을 가지려면 기본 몫의 합
//           위에 여유가 있어야 해서 올렸다 — 지식은 매뉴얼처럼 길다(MAX_DOC_LEN).
// 최악은 후보가 실제로 그만큼 있는 요청에서만 나오고, 그때는 싣는 쪽이 낫다. 다만 스텝마다 통째로 다시
// 보내므로(prefix caching이 재사용하는 것은 앞부분뿐) 늘어난 만큼 prefill이 스텝 수만큼 곱해진다 —
// 느려지면 이 값이 아니라 천장부터 낮춘다 (PROMPT_CEILINGS 주석).
// 컨텍스트가 더 작은 모델로 바꾸면 이 값부터 되돌릴 것 (MAX_COMPLETION_TOKENS와 함께 — 둘의 합이
// 컨텍스트 안에 들어야 한다).
export const MAX_PROMPT_TOTAL_LEN = 80_000;

// 섹션별 최소 몫(기본) — 다른 섹션이 아무리 길어도 이만큼은 보장된다.
// 배분 순서(= 이 객체의 선언 순서)가 곧 우선순위다: 각 섹션은 뒤 섹션들의 기본 몫을 미리 떼어놓은
// 나머지를 받되 자기 천장(PROMPT_CEILINGS)에서 멈추고, 실제로 쓴 만큼만 빠져 다음 섹션으로 넘어간다.
// 앞이 남긴 여유는 뒤로 흐르고, 뒤가 남긴 것은 앞으로 돌아오지 않는다.
//   실행 이력  : 잘리면 이미 조회해둔 결과를 버리고 같은 질문에 다시 매달린다. 줄 수 × 스텝 상한으로 묶여
//               기본 몫보다 커질 수 없으므로 천장이 없다.
//   쿼리 목록  : 잘리면 에이전트가 그 조회를 아예 못 한다. detail 표시가 붙은 것만 자세해지므로 여유가
//               있어도 그 이상 커지지 않는다.
//   처리방법   : 절차와 쿼리 이름을 지목해 라우팅을 이끈다 — 잘리면 조회 경로가 끊긴다. 지식보다 앞이다.
//   지식       : 잘리면 답의 근거만 얇아진다. 매뉴얼처럼 길어(MAX_DOC_LEN) 가장 큰 천장을 받는다.
// 옛 순서(지식 → 처리방법 → 이력 → 쿼리)에서는 여유가 맨 뒤의 쿼리 목록으로만 흘렀는데 그 섹션은 여유를
// 쓰지 않아, 후보가 꽉 찬 통상 요청이 64k 중 24.5k만 쓰고 지식 11건·처리방법 10건을 잘랐다(실측).
// 합계는 반드시 MAX_PROMPT_TOTAL_LEN 이하여야 한다 (아래에서 검증한다 — 이 검증이 없어서
// 섹션 상한과 전체 상한이 조용히 어긋났다).
export const PROMPT_FLOORS = {
  history: 25_000,   // MAX_HISTORY_ROWS 줄이 '어떤 조합으로 오든' 각자 상한까지 차도 전부 실리는 크기(필요 23,557) —
                     // llm-openai.js가 로드 시 검증한다. 조합을 세지 않는 이유는 그쪽 주석에 있다:
                     // 개수가 묶여 있는 것은 쿼리 결과·오류 줄(MAX_STEPS)뿐이고 검색 줄은 그렇지 않다.
                     // 20,000이면 MAX_PROMPT_STEP_LEN을 2,000으로 낮춰야 든다(필요 18,552) — 조회 결과를 덜 보여주는
                     // 대가라 올리는 쪽을 골랐다.
  queries: 15_000,   // 등록 30건(agent.js MAX_PROMPT_QUERIES)의 짧은 줄이 최악(이름 100자·바인드 8개·대상DB 둘)으로
                     // 10,506자 — '목록에 오른 쿼리는 한 건도 사라지지 않는다'(llm-openai.js renderQueries)가
                     // 그 최악에서도 서는 5천 단위 값. 자세한 줄 30건(~18k)은 천장(20,000)이 맡는다.
  qaMethods: 10_000, // 항목 1,000자(MAX_PROMPT_ITEM_LEN)면 9건. 펼침 총량 MAX_EXPANDS × MAX_EXPANDED_ITEM_LEN(9,000)이 이 안에 든다.
  knowledge: 25_000, // 항목 하나가 '문서의 한 구간'이라 크기를 정하는 것은 MAX_PROMPT_ITEM_LEN이 아니라 MAX_DOC_LEN이다
                     // — 실리는 건수는 등록된 글의 길이가 정한다 (1,000자면 20건 전부, 10,000자면 2건. context.md 2-2).
                     // 펼침 총량 MAX_EXPANDS × MAX_DOC_LEN(20,000)이 이 안에 들어야 한다.
};

// 섹션별 천장 — 앞 섹션이 남긴 여유를 받을 때 멈추는 자리. 없는 섹션은 여유를 전부 받을 수 있다(이력 —
// 실사용이 줄 수로 묶여 있어 뜻이 없다). 천장이 없으면 긴 문서 요청에서 지식 하나가 50k자를 먹는다 —
// 프롬프트가 두세 배가 되고 그 prefill이 스텝마다 곱해진다. 예산 불변식과는 무관하다(총량 안에서 남은 것만
// 받는다) — 이 값은 오로지 응답 속도의 손잡이다. [llm] usage prompt= 와 [agent] timing llm= 이 느려지면
// 여기부터 낮춘다.
//   쿼리 목록 20,000 — 등록 30건이 전부 자세한 줄(~600자)이어도 든다.
//   처리방법 20,000 — 검색 한 번의 후보 20건이 1,000자 항목이어도 19건까지 실린다(줄마다 제목·번호가 붙는다. 실측).
//   지식     40,000 — 10,000자 매뉴얼 창 4건, 또는 1,000자 글이면 후보 20건 전부(20k에서 멈춘다).
export const PROMPT_CEILINGS = { queries: 20_000, qaMethods: 20_000, knowledge: 40_000 };
for (const [key, cap] of Object.entries(PROMPT_CEILINGS)) {
  // 기본 몫 없는 섹션의 천장은 오타이고, 기본보다 낮은 천장은 배분(llm-openai.js renderSections)이 max(기본, …)를
  // min(천장, …)으로 다시 눌러 기본 몫 보장을 조용히 깬다.
  if (!(key in PROMPT_FLOORS) || cap < PROMPT_FLOORS[key]) {
    throw new Error(`PROMPT_CEILINGS.${key} (${cap}) must name a PROMPT_FLOORS section and be >= its floor — check constants.js.`);
  }
}

// 섹션 본문이 아닌 고정 틀의 몫 — 섹션 제목 줄(건수 포함)·블록 사이 빈 줄·질문 제목·지시 블록
// (현재 시각 한 줄과 지시문. 아직 아무것도 검색하지 않은 첫 스텝에는 안내 한 줄이 더 붙는다).
// 실측 최대치에 건수 자릿수 여유를 더해 잡았다 (llm-openai buildPrompt, 회귀 테스트가 실측한다).
// 이 몫을 떼지 않으면 네 섹션이 각자 예산에 꽉 찬 요청에서 정확히 이 길이만큼 전체 상한을
// 넘는다 — 회귀 테스트가 그 상태를 만들어 잡아내지만, 값이 어긋나면 그 전까지는 조용하다.
export const PROMPT_FRAME_RESERVE = 400;

const FLOOR_SUM = Object.values(PROMPT_FLOORS).reduce((a, b) => a + b, 0) + PROMPT_FRAME_RESERVE;
if (FLOOR_SUM > MAX_PROMPT_TOTAL_LEN) {
  // import 시점에 터뜨린다 — 예산이 어긋난 채로 뜨면 등록이 늘어난 뒤에야, 그것도
  // '모든 질문이 LLM 호출 실패'라는 원인이 안 보이는 형태로 드러난다.
  throw new Error(
    `Sum of prompt section floors and frame reserve (${FLOOR_SUM}) exceeds the total budget (${MAX_PROMPT_TOTAL_LEN}) — check constants.js.`
  );
}

export const MAX_PROMPT_ITEM_LEN = 1000;  // 항목 본문 1건
// query_sql의 표시 상한. 잘려도 바인드명은 프롬프트가 따로 싣는다. 2,000이던 것을 줄였다 — SQL은
// 쿼리를 '고르는' 근거가 아니라(용도·입출력 설명이 그 근거다) 바인드가 어느 컬럼에 걸리는지, 결과가
// 몇 건으로 제한되는지 같은 보조 정보이고, 등록 SQL 대부분은 이 길이 안이다. 목록 30건에 각 2,000자를
// 실으면 그것만으로 스텝마다 60k자를 다시 보낸다(prefill이 스텝 수만큼 곱해진다).
export const MAX_PROMPT_SQL_LEN = 800;
// 에이전트 루프의 스텝 상한(agent.js). 여기 두는 이유: 실행 이력의 최소 몫(PROMPT_FLOORS.history)은
// 'MAX_STEPS 스텝이 각자 상한까지 차도 전부 실린다'가 근거인데, 그 검증(llm-openai.js)이 이 값을
// 봐야 한다. agent.js 안의 리터럴이면 스텝 수를 올리는 변경이 이력 몫과 어긋나도 아무 데서도 드러나지 않는다.
export const MAX_STEPS = 5;
// 검색 행동(search)의 횟수 상한 (agent.js). 쿼리 실행 스텝(MAX_STEPS)과 따로 센다 — 실행 이력의
// 최소 몫은 '어떤 종류의 줄이 몇 개까지 오는가'로 계산되므로(llm-openai.js HISTORY_FLOOR_NEEDED),
// 두 카운터를 섞으면 그 근거가 무너진다. 3인 이유: 기본 검색 1회 + 검색어를 고쳐 다시 1회 +
// 두 주제를 함께 묻는 질문의 추가 1회. 그 이상은 검색이 아니라 헛도는 것이다.
// 환경변수로 '낮출' 수 있다 (MAX_SEARCHES=1~3) — 계측(chat_log의 timing·search)에서 두 번째 검색이 거의
// 진도를 내지 못하는 것으로 보이면 줄인다. 올리지는 못한다: 이력의 최소 몫이 이 상한을 전제로 검증된다.
export const MAX_SEARCHES_CEILING = 3;
export const MAX_SEARCHES = boundedEnv('MAX_SEARCHES', MAX_SEARCHES_CEILING, MAX_SEARCHES_CEILING);
// 검색 한 번이 소스당 돌려주는 최대 후보 수 (search.js). 환경변수로 '낮출' 수 있다 (SEARCH_LIMIT=1~20) —
// 모델이 검색어를 핵심 낱말로 쓰므로 후보 정밀도가 높고, 후보를 줄이면 스텝마다 다시 보내는 prefill이 그만큼 준다.
// 근거는 계측이다: 검색 뒤 LLM 호출의 prompt 토큰(trace.timing.llm[].prompt)과 적중 수(search.knowledge 등)가
// 상한에 붙어 있는가(README '검색 후보 수·검색 횟수 조정'). 올리지는 못한다: 프롬프트 최소 몫이 이 값을 전제한다.
export const MAX_SEARCH_LIMIT = 20;
export const SEARCH_LIMIT = boundedEnv('SEARCH_LIMIT', MAX_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
// 이력(history)에 남길 수 있는 줄 수의 상한. 프롬프트 예산의 이력 몫(PROMPT_FLOORS.history)이 '이만큼은
// 반드시 전부 실린다'를 보장하는 근거이므로, 루프가 이 수를 넘겨 기록하면 그 보장이 조용히 깨진다 —
// 넘친 만큼 가장 오래된 줄이 프롬프트에서 빠지고, 그것은 앞선 조회가 통째로 헛수고가 됐다는 뜻이다.
// 쿼리 줄 MAX_STEPS + 검색 줄 MAX_SEARCHES + 상한 안내 한 줄(agent.js가 잘라 낸 일괄 조회를 알리는 줄).
// 일괄 조회 전에는 루프 반복 수(MAX_STEPS + MAX_SEARCHES)가 곧 줄 수여서 저절로 지켜졌는데, 결정 하나가
// 조회 여럿을 만들게 되면서 그 등식이 깨졌다 — 그래서 줄 수를 직접 센다 (agent.js가 이 값을 본다).
export const MAX_HISTORY_ROWS = MAX_STEPS + MAX_SEARCHES + 1;

// ===== 자료 항목의 식별자 =====
// 지식·처리방법 항목을 모델이 지목하는 방법. 제목으로는 지목할 수 없다 — title은 VARCHAR(200)인데
// 프롬프트에는 MAX_PROMPT_NAME_LEN(100)으로 잘려 실리므로, 긴 제목은 모델이 온전한 형태를 본 적이
// 없어 옮겨 적는 것이 불가능하다. 쿼리는 사정이 반대라(query_name이 짧은 식별자로 설계돼 온전히
// 실린다) 번호를 만들지 않는다 — 한 대상에 표기가 둘이 되는 값을 치를 이유가 없다.
//
// seq를 쓰는 이유: 목록 안의 위치는 검색 결과가 앞에 붙을 때마다 바뀌므로(agent.js mergeFront)
// 1스텝에서 본 번호가 2스텝에서 다른 항목을 가리킨다. seq는 요청 내내 고정이다.
export const ITEM_PREFIX = { knowledge: 'k', qaMethods: 'm' };
const ITEM_LIST = { k: 'knowledge', m: 'qaMethods' };
const ITEM_ID_RE = /^([km])([1-9][0-9]*)$/;

// 'k12' → { list: 'knowledge', seq: 12 }. 형식이 아니면 null.
// 대소문자는 흡수한다 — 모델이 'K12'로 적었다고 지목을 잃을 이유가 없다 (nameKey와 같은 기준).
export function parseItemId(id) {
  const m = ITEM_ID_RE.exec(String(id ?? '').trim().toLowerCase());
  return m ? { list: ITEM_LIST[m[1]], seq: Number(m[2]) } : null;
}

// 결정에 실려 온 식별자 목록을 정규화한다 — 배열이든 하나든 받고, 형식이 아닌 것은 버리고,
// 중복을 없애고, 개수를 확정한다. 형식이 아닌 값을 버리되 결정 자체는 버리지 않는다:
// 모델이 넷 중 하나를 잘못 적었다고 나머지 셋까지 다시 요청하게 할 이유가 없다.
export function normalizeItemIds(raw, max) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const parsed = parseItemId(v);
    if (!parsed) continue;
    const id = `${ITEM_PREFIX[parsed.list]}${parsed.seq}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

// 한 요청에서 본문을 '넓힌' 횟수와, 한 문서가 지식 섹션에서 차지할 수 있는 글자 상한.
// 횟수 × 펼침 상한이 그 섹션의 최소 몫 안에 들어야 한다 — 지식은 MAX_EXPANDS × MAX_DOC_LEN(20,000자)
// < PROMPT_FLOORS.knowledge, 처리방법은 MAX_EXPANDS × MAX_EXPANDED_ITEM_LEN(9,000자) < PROMPT_FLOORS.qaMethods.
// 둘 다 한 섹션에 몰려도 다른 후보 몇 건이 함께 실릴 자리가 남는다. 이 곱을 키우려면 그 몫부터 다시 본다.
//
// 세는 단위는 '항목 하나를 한 번 넓힌 것'이다 — 항목 수도, 결정(expand 행동) 수도 아니다.
// 항목 수가 아닌 이유: 청크 구조에서 expand는 항목을 새로 펼치는 것이 아니라 이미 있는 항목의 '범위를
// 넓히는' 일이다(chunk.js buildItems, agent.js applyExpand). 항목 수로 세면 같은 항목을 두 번 넓히는 것이
// 한 개로 세어져 상한이 걸리지 않고, 그 사이 프롬프트만 계속 커진다.
// 결정 수가 아닌 이유: 한 결정의 ids 둘이 다 넓혀지면 둘로 센다(llm.js sanitizeDecision이 ids를 이 값까지만
// 받는다). 결정 수로 세면 결정 하나에 실린 항목 수만큼 위 곱이 조용히 커진다.
export const MAX_EXPANDS = 2;
// 한 문서(= 한 항목)의 글자 상한. 검색은 이 값을 채우지 않는다 — 적중한 구간과 그 사이 구멍만
// 싣고, 여기까지 넓히는 것은 expand의 몫이다. 검색이 먼저 채워 버리면 expand가 할 일이 없어지고
// 모델이 왕복 하나를 헛되이 태운다 (chunk.js buildItems의 grow 인자).
//
// 상한을 두는 이유는 하나뿐이다: '이 문서가 답'이라는 검색 판정이 틀렸을 때의 보험. 그 요청에
// 다른 문서가 하나도 안 보이면 모델은 대안을 볼 수 없고, 그 오답은 오류를 남기지 않는다.
// 관련도 순 자체는 건드리지 않는다 — 개수로 깎으면 더 가까운 것을 버리고 더 먼 것을 싣게 된다
// (chunk.js 병합 머리말). 원칙이 아니라 튜닝 값이고, 근거는 trace.search의 거리 분포다.
// 4,500이던 것을 올렸다 — 매뉴얼 한 절차가 그 창에 들지 않았고, 128k 컨텍스트의 여유가 놀고 있었다. 이 값의 두 배가
// 지식 기본 몫(PROMPT_FLOORS.knowledge) 안에 들어야 하고, 한 번의 청구로 이 창을 채우려면 agent.js GROW_WINDOW가
// 이 값 ÷ 청크 크기(chunk.js CHUNK_TARGET_LEN) 이상이어야 한다.
export const MAX_DOC_LEN = 10_000;
// 청크가 아닌 항목(처리방법)을 펼쳤을 때 싣는 본문 상한. 처리방법은 나누지 않고(chunk.js 머리말) 짧으므로
// 문서 창(MAX_DOC_LEN)과 따로 둔다 — 같은 값을 쓰면 문서 창을 넓힐 때마다 처리방법 몫도 함께 커져야 한다
// (MAX_EXPANDS × 이 값 < PROMPT_FLOORS.qaMethods).
export const MAX_EXPANDED_ITEM_LEN = 4500;
// 결정 하나가 버릴 수 있는 항목 수. 검색 한 번이 소스당 SEARCH_LIMIT건을 얹으므로 그 두 배면
// 한 결정으로 앞선 검색 결과를 통째로 정리할 수 있다.
export const MAX_DROPS = 40;

// 결정 하나(run_queries)에 담을 수 있는 조회 수. 서로 의존하지 않는 조회를 한 번에 요청해 LLM 왕복을 줄이는
// 길이다 — 조회는 병렬로 돈다. 4인 이유는 둘이다: 정당한 질문이 한 번에 묻는 독립 조회가 그 안이고
// ('서울·부산·대전 재고'), 조회 DB에 요청 하나가 여는 세션 수가 곧 이 값이다 — 조회 DB 풀은 이 값을
// 근거로 크기를 잡는다(oracle.js POOL_MAX = 이 값 × 2, 그런 요청 둘이 겹쳐도 기다리지 않게).
// 이 값을 올리면 그 풀이 운영 DB에 여는 세션도 함께 늘어난다.
export const MAX_BATCH_QUERIES = 4;
// 검색어 상한. 정당한 검색어는 질문의 핵심 낱말 몇 개라 이보다 길 수 없다 — 넘으면 자른다.
// 바인드 값과 달리 실행을 거부하지 않는다: 잘린 검색어로도 검색은 성립하고, 임베딩 원문 상한
// (MAX_EMBED_TEXT_LEN)보다 훨씬 작아 그쪽 경계에 닿지 않는다.
export const MAX_SEARCH_TEXT_LEN = 500;
// 검색 대상의 단일 정의. 결정 경계(llm.js)·프롬프트(llm-openai.js)·검색 실행(agent.js)·Mock이 같은
// 이름을 봐야 한다 — 한 곳이 다른 철자를 쓰면 모델이 프롬프트대로 적은 대상이 '모르는 값'이 되어
// 셋 다로 조용히 넓어진다(아래 normalizeSearchTargets의 기본값). 순서는 프롬프트 표기 순서이자
// 같은 검색인지 판정하는 정규 순서다(agent.js searchKey).
export const SEARCH_TARGETS = ['knowledge', 'qa_method', 'query'];

// 결정의 targets를 정규화한다 — 배열이든 문자열 하나든 받고, 대소문자·공백을 흡수하고, 모르는 값은
// 버린다. 남는 것이 없으면(생략·빈 배열·전부 오타) 셋 다로 본다: 모델이 대상을 고르지 못한 것은
// '아무것도 찾지 마라'가 아니라 '무엇이 필요한지 모르겠다'이고, 그때 가장 싼 실패는 넓게 찾는 것이다
// (세 검색은 병렬이고 임베딩은 한 번이다). 결과는 SEARCH_TARGETS 순서로 돌려준다.
export function normalizeSearchTargets(raw) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const keys = new Set(list.map(v => nameKey(v)));
  const picked = SEARCH_TARGETS.filter(t => keys.has(t));
  return picked.length ? picked : [...SEARCH_TARGETS];
}
// 실행 이력 1스텝의 결과 JSON 상한. 스텝 하나가 이력 예산을 통째로 먹으면 나머지 스텝이 전부 밀려난다 —
// 다단계 절차에서 앞 단계의 결과가 사라지면 모델이 그 단계를 다시 실행하려 든다.
// (한 줄의 상한은 이 값 + 머리말이다 — 쿼리명·대상DB·params·건수 안내. 각각 이름 있는 상한으로 묶여 있다.)
export const MAX_PROMPT_STEP_LEN = 3000;
// 실행 이력 한 줄의 params 표시 상한 — rows와 달리 params는 LLM이 만든 값이라 그 자체로는 상한이
// 없고, renderHistory는 최소 1줄을 반드시 실으므로 줄이 유계가 아니면 전체 예산이 그대로 뚫린다.
// 표시용으로만 자른다 (실행에 쓰는 값은 MAX_BIND_LEN이 결정 경계에서 따로 묶는다).
export const MAX_PROMPT_PARAMS_LEN = 500;

// 임베딩 원문 상한 — 모델 입력 한도를 넘는 행 하나가 배치 전체를 실패시키는 것을 입력 단계에서 막는다.
// bge-m3는 8192토큰이고 한국어는 대략 문자당 1토큰 미만이라 4000자면 한도 안에 든다.
export const MAX_EMBED_TEXT_LEN = 4000;

// 서버가 클라이언트에서 받는 대화 이력 상한 — 프런트가 페이로드를 맞추는 기준이기도 하다.
// 프런트(App.jsx HISTORY_TURNS·HISTORY_LEN)가 같은 값으로 페이로드를 자른다 — 함께 고칠 것.
export const MAX_CHAT_TURNS = 6;   // LLM에 전달할 최근 대화 턴 수 (프롬프트 비대화 방지)
// 턴별 최대 길이. 에이전트 턴은 직전 답변이고 그 안의 표가 후속 질문("그럼 김철수는?")의 근거다 —
// 500자에서는 표의 머리만 남아 모델이 방금 무엇을 보여줬는지 모른 채 답했다.
// 6턴 × 1,500자 = 9k자 ≈ 5k 토큰, 128k 컨텍스트에서 가장 싼 품질 몫이다 (MAX_PROMPT_TOTAL_LEN 참고).
export const MAX_CHAT_LEN = 1500;

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

// LLM 답변(answer)의 상한 — 바인드 값과 같은 이유로 같은 경계(llm.js sanitizeDecision)에서 적용한다.
// 결정에 실려 오는 세 값 중 이것만 상한이 없었다: query_name은 200자, params는 MAX_BIND_LEN으로
// 묶으면서 정작 가장 큰 값이 그대로 통과했다. answer는 응답 JSON·chat_log.answer·화면으로 나가며
// JSON 직렬화를 두 번 지난다 — 퇴화한 응답(temperature=0의 반복)이나 64KB짜리 지식 본문을 그대로
// 실은 폴백 답변(llm.js renderAnswer) 하나가 응답과 로그를 통째로 부풀린다.
// 값의 근거: 정상 답변은 프롬프트에 실린 근거(MAX_PROMPT_TOTAL_LEN)보다 길 수 없다.
// 그보다 넉넉히 잡아 정당한 답변은 건드리지 않으면서 퇴화한 응답만 묶는다.
// 총량과 연동된 값이므로 MAX_PROMPT_TOTAL_LEN을 고치면 여기도 함께 본다 —
// 한쪽만 올리면 근거는 다 실렸는데 그것을 요약한 답변이 상한에 걸리는 조합이 생긴다.
// 실제로 이 값에 닿는 LLM 답변은 없다 — 모델 출력을 실질적으로 묶는 것은 시간(llm-openai.js
// TIMEOUT_MS 120초, 30~50 tok/s면 4~6k 토큰)과 폭주 가드(MAX_COMPLETION_TOKENS)다. 이 값은 그 둘이
// 못 보는 경로, 즉 조회 결과와 지식 본문을 그대로 싣는 폴백 답변(llm.js renderAnswer)의 천장이다.
//
// 사용자에게 나가는 답변은 이 값보다 클 수 있다: 참조를 실제 표로 채우는 일이 이 절단 '뒤에' 일어나기
// 때문이다(agent.js finish → chart.js). 그 몫은 각자 상한이 있으므로 최악은 이 값 + MAX_TABLE_INJECT_LEN +
// MAX_CHART_INJECT_LEN(각 30k)이고, 그 합이 응답 본문과 chat_log.answer(MEDIUMTEXT)의 실제 천장이다.
// 채움을 절단보다 먼저 할 수는 없다 — 참조가 가리키는 스텝 번호는 이력이 다 끝난 뒤에야 확정된다.
export const MAX_ANSWER_LEN = 70_000;

// LLM 한 번 호출의 출력 토큰 상한(max_tokens) — 답변 길이 상한이 아니라 폭주 가드다.
// 답변 길이는 위 MAX_ANSWER_LEN이 파싱 뒤에 묶는다(토큰에서 자른 JSON은 파싱 자체가 안 돼 답변을
// 통째로 잃는다 — llm.js 참고). 이 값은 그보다 훨씬 위에 두어 정당한 결정은 건드리지 않고,
// temperature=0의 반복 퇴화만 끊는다. 보내지 않으면 vLLM은 '남은 컨텍스트 전부'(≈ 100k 토큰)를
// 상한으로 잡는다: 클라이언트 타임아웃의 abort가 프록시·OpenRouter를 넘어 서버의 생성을 멈춘다는
// 보장이 없고, 유료 API는 그 토큰이 그대로 과금되며, 로그에는 원인 모를 타임아웃만 남는다
// (finish_reason=length 로 남기면 '폭주'와 '느림'이 구분된다 — llm-openai.js chatCompletion).
// 값의 근거: 정당한 결정 JSON은 근거의 요약이라 5k 토큰을 넘기 어렵고, 사고 과정을 쓰는 모델은
// 그 토큰도 이 상한에 포함되므로(vLLM) reasoning_effort=low의 몫(수 k)을 더해도 16k는 넉넉하다.
// 입력 최악 ≈ 54k 토큰(MAX_PROMPT_TOTAL_LEN 주석)에 이 값을 더해도 128k의 절반 남짓이다.
// 컨텍스트가 더 작은 모델로 바꾸면 MAX_PROMPT_TOTAL_LEN과 함께 되돌릴 것.
export const MAX_COMPLETION_TOKENS = 16_384;

// 길이 상한으로 문자열을 자르는 단일 지점.
// 단순 slice는 서로게이트 쌍(이모지 등 BMP 밖 문자)을 반으로 쪼개 짝 잃은 코드유닛을 남긴다.
// 그 문자열은 JSON.stringify는 통과하지만(\uD83D로 이스케이프된다) 유효한 UTF-8이 아니라서
// 받는 쪽(임베딩 서버·LLM API)이 거부하거나 U+FFFD로 바꿔 놓는다 —
// 임베딩에서는 그 한 행이 매 주기 거부되고, 프롬프트에서는 본문이 조용히 훼손된다.
// 경계에 걸린 상위 서로게이트 하나를 떼어 항상 온전한 문자열을 돌려준다.
export function clipText(s, max) {
  // 음수 상한은 '아무것도 남기지 않는다'로 본다. 이 한 줄이 없으면 slice(0, -1)이 뒤에서 세어
  // 'abcdef'가 'abcde'가 된다 — 길이를 묶으라고 부른 함수가 상한보다 긴 글자를 돌려주는 셈이라,
  // 상한 계산이 한 번 음수로 떨어지는 날 이 파일의 모든 예산이 조용히 무의미해진다.
  // 지금은 부르는 쪽이 전부 양수 상수를 넘기므로 닿지 않는 길이지만, 이 함수는 '길이 상한으로
  // 자르는 단일 지점'이라 그 보장이 부르는 쪽의 기억이어서는 안 된다.
  // 같은 규칙을 적어 둔 프런트(frontend/src/chart.js sliceSafe)는 이미 이 경계를 지키고 있었다 —
  // '같은 방식'이라고 적어 둔 둘이 경계에서만 갈라져 있으면 그 주석 자체가 거짓이 된다.
  if (max <= 0) return '';
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// 짝 잃은 서로게이트를 제거한다 — clipText가 '우리가 자른 경계'를 지키는 것과 같은 이유를,
// '남이 잘라서 보낸 문자열'에 적용한다.
// clipText만으로는 절반만 막힌다: 그쪽은 절단면(끝)의 상위 서로게이트 하나만 보므로, 클라이언트가
// 이모지 한가운데를 자르고 '뒷조각'을 보내면 맨 앞의 하위 서로게이트가 그대로 통과한다. 그 문자열은
// JSON.stringify를 지나(\udc00으로 이스케이프된다) 유효한 UTF-8이 아닌 채로 LLM·임베딩 서버까지 가서,
// 요청이 통째로 거부되거나(그 대화의 이후 질문이 전부 실패한다) 본문이 U+FFFD로 조용히 훼손된다.
// 양쪽 경계만 다루는 대신 문자열 전체에서 짝 없는 코드유닛을 없앤다 — 가운데에 끼어 있는 경우
// (조각 두 개를 이어 붙인 입력)까지 같은 규칙으로 덮이고, 규칙이 하나면 한쪽만 빠질 수 없다.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripLoneSurrogates(s) {
  const str = String(s ?? '');
  // 서로게이트가 아예 없는 문자열(대부분의 입력)은 정규식 치환 없이 그대로 돌려준다
  return /[\uD800-\uDFFF]/.test(str) ? str.replace(LONE_SURROGATE_RE, '') : str;
}

// 프롬프트 항목의 본문 형태 — 항목 한 줄('- ')에 이어지는 줄을 두 칸 들여 markdown 목록의 연속 줄로 만든다
// (llm-openai.js itemLine·최근 대화). 여기 두는 이유: MAX_DOC_LEN이 재는 것은 '한 문서가 지식 섹션에서
// 차지하는 글자'이므로 청크 병합(chunk.js buildItems·canGrow)도 같은 자로 재야 한다. 원문 길이로 재면 줄이
// 많은 본문(마크다운 목록·표)이 들여쓰기만큼 상한을 넘겨 프롬프트에서 다시 잘리고 잘림 표시까지 붙는다 —
// '검색된 청크는 프롬프트에서 다시 잘리지 않는다'(context.md 2-5)가 정확히 그 자리에서 깨졌다(실측 355자).
export const indentLines = v =>
  String(v ?? '').trim().split(/\r\n?|\n/).map((l, i) => (i && l ? `  ${l}` : l)).join('\n');

// 소유 키만 읽는 프로퍼티 접근.
// 바인드명·쿼리명이 '__proto__'·'toString' 같은 프로토타입 멤버와 겹치면 obj[key]가 값 대신
// Object.prototype의 멤버를 돌려준다. 그러면 '값 없음'이어야 할 자리가 다른 문자열·함수로 굳어
// 실행 판정이 어긋나거나(agent 루프 가드), 함수가 아닌 값을 호출하다 결정 루프가 통째로 죽는다.
// 판정(agent.js)·실행(oracle.js)·Mock(llm.js, oracle.js)이 전부 이 함수를 쓴다 — 사본을 두면
// 한 곳이 체인을 타도 그 경로에서만 조용히 어긋나고, 어긋난 쪽은 '값이 있다'고 판정할 뿐이라
// 오류를 남기지 않는다. 그래서 nameKey와 같은 이유로 접근 방식 자체를 여기 하나로 모은다.
export const ownProp = (obj, key) => (Object.hasOwn(obj ?? {}, key) ? obj[key] : undefined);

// '키-값 객체인가' — 결정의 params처럼 JSON에서 온 값이 배열·문자열·숫자로도 올 수 있는 자리의 판정.
// typeof만 보면 배열과 null이 통과하고, Object.entries는 문자열까지 받아 글자마다 '0','1' 키를 만든다 —
// 그 잡키는 어느 바인드와도 맞지 않아 '값 없음'으로 끝나지만, 프롬프트·trace·chat_log에 그대로 실려
// 모델이 자기가 낸 적 없는 params를 보게 된다. 형식 경계(llm-openai.js toDecision)와 크기 경계
// (llm.js sanitizeDecision)가 같은 판정을 쓴다 — 한쪽만 고치면 다른 문으로 들어온 값이 그대로 샌다.
export const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// 바인드명 최대 길이 — Oracle 식별자 상한(12.2+ 기준 128자)이다.
// 이 값을 보는 곳이 둘이고, 둘이 같은 값을 봐야 한다:
//   등록 경계(sql.js assertReadOnly) — 이보다 긴 이름을 쓴 SQL은 실행 자체가 불가능하므로 거부한다.
//   결정 경계(llm.js sanitizeDecision) — 이보다 긴 params 키는 어떤 바인드와도 대응할 수 없으므로 버린다.
// 한쪽에만 있으면 '등록은 되는데 절대 실행되지 않는 쿼리'가 만들어진다: 등록 SQL이 129자짜리
// 바인드를 쓰면 결정 경계가 그 키를 버리므로 매 실행이 '값 없음'으로 끝나는데, 모델은 값을
// 제대로 채워 보냈으므로 오류만 보고는 무엇을 고쳐야 할지 알 수 없다 (실제로 그 상태였다).
// 프롬프트에 이름을 싣는 쪽(llm-openai.js bindList)도 이 값까지는 자르지 않아야 한다 —
// 100자로 자르면 101~128자짜리 적법한 이름을 모델이 철자대로 적을 방법이 사라진다.
export const MAX_BIND_NAME_LEN = 128;

// 쿼리 이름 비교 키. query_registry 조회는 MariaDB 기본 collation(대소문자·후행 공백 무시)이라
// JS의 ===로 비교하면 'BATCH_JOB_STATUS'와 'batch_job_status'가 서로 다른 쿼리로 보인다.
// 이름으로 무언가를 판정하는 곳(agent의 루프 가드, mock의 실행 계획과 stub 데이터 조회)은 전부 이 키를 쓴다 —
// 한 곳이라도 ===로 남으면 그 경로에서만 가드가 조용히 무력화된다.
export const nameKey = s => String(s ?? '').trim().toLowerCase();

// 조회대상 DB 이름 상한. target_db.db_name이 VARCHAR(100)이므로 그보다 긴 이름은 어떤 등록 DB와도
// 대응할 수 없다. 바인드명(MAX_BIND_NAME_LEN)은 상한을 넘으면 자르지 않고 버리는데, 여기서는 자른다 —
// 두 실패가 모델에게 보이는 모습이 다르기 때문이다. 버리면 '고르지 않았다'가 되어 모델은 자기가
// 이름을 적었다는 사실과 어긋나는 오류를 받지만, 자르면 '등록되지 않은 대상 DB: xxx (후보: …)'가
// 되어 무엇을 어떻게 고칠지가 그 문구 안에 다 들어 있다 (DB 후보는 목록이 있어 자가 교정이 된다).
export const MAX_TARGET_DB_NAME_LEN = 100;

// 조회대상 DB 목록의 단일 해석 지점.
// query_registry.target_db_name은 ';'로 구분한 목록이다 — 'ORDER_DB' 하나면 지금까지와 똑같고,
// 'STOCK_SEOUL;STOCK_BUSAN'처럼 둘 이상이면 LLM이 그중 하나를 골라 실행한다.
// 프롬프트(llm-openai.js dbList)와 실행 경계(oracle.js resolveTargetDb)가 반드시 같은 목록을 봐야 한다:
// 한쪽만 규칙이 달라지면 '프롬프트에 보였는데 실행이 모르는 이름이라고 거부하는' 후보가 생기고,
// 그 실패는 모델이 목록대로 답했는데도 나므로 고칠 방법이 없다. 그래서 규칙을 여기 하나로 둔다
// (sql.js assertReadOnly가 가드와 실행용 SQL을 함께 돌려주는 것과 같은 이유).
//
// 빈 조각은 버린다 — 'ORDER_DB;'나 'A;;B' 같은 흔한 표기에서 빈 이름이 후보로 올라오면
// loadTargetDb가 0건을 돌려주고, 그 실패는 '접속 정보가 등록되어 있지 않다'로 보고되어
// 원인이 등록 문자열의 세미콜론 하나라는 사실을 어디에서도 가리키지 않는다.
// 중복은 첫 철자만 남긴다 — target_db 조회는 대소문자를 무시하는 collation이라 'A;a'는 한 개이고,
// 둘로 세면 프롬프트가 같은 DB를 두 번 보여주면서 모델에게 '고를 것이 둘'이라고 말하게 된다.
export function targetDbNames(raw) {
  const seen = new Set();
  const names = [];
  for (const part of String(raw ?? '').split(';')) {
    const name = part.trim();
    const key = nameKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

// 바인드명으로 값을 찾는 단일 지점 — Oracle의 바인드명은 대소문자를 구분하지 않는다.
// (:job_id와 :JOB_ID는 같은 바인드이고, 드라이버도 그렇게 다룬다)
// exact-case 읽기만 하면 모델이 값을 제대로 채워 보내도 '값 없음'이 된다: 프롬프트는 SQL 원문의
// 컬럼명(JOB_ID)과 바인드명(:job_id)을 함께 보여주고 조회 결과 행의 키도 대문자라, 모델이
// {"JOB_ID": "BATCH001"}로 답하는 것은 흔한 정상 경로다 — 그 실패는 스텝 하나와 LLM 왕복 하나를
// 버리면서 오류 문구는 '값을 안 줬다'고 말해 모델을 엉뚱한 수정으로 보낸다.
// llm.js valueFromHistory가 컬럼명을 같은 이유로 대소문자 무시하고 맞추는데, 실행 경계만
// 엄격하게 남아 있었다. 판정(agent.js paramKey)과 실행(oracle.js runQuery)이 같은 함수를 쓴다 —
// 한쪽만 관대하면 같은 바인드로 도는 반복을 루프 가드가 못 잡는다.
//
// 정확히 일치하는 키를 먼저 본다(ownProp) — 프로토타입 멤버와 겹치는 이름도 그쪽에서 막힌다.
// 대소문자만 다른 키가 여럿이면 먼저 선언된 것을 쓴다. 값이 undefined인 항목은 건너뛴다 —
// '키는 있는데 값이 없는' 항목이 실제 값을 가진 다른 표기를 가리면 안 된다.
// 비교 키가 nameKey라 앞뒤 공백도 함께 흡수한다 ({" job_id": …}도 :job_id에 바인드된다).
// Oracle 식별자에는 공백이 들어갈 수 없으므로 ' job_id'가 별개의 정당한 바인드일 수는 없다 —
// 거부해봐야 값은 맞는데 스텝 하나를 버릴 뿐이다. query_name을 trim하는 것과 같은 판단이다.
// 세는 쪽(sql.js bindNames)도 같은 nameKey로 중복을 제거한다 — 한쪽만 관대하면 "같은 바인드인가"를
// 두 곳이 다르게 판정하게 되고, 그 차이가 곧 드라이버까지 내려가는 실패가 된다.
export function bindValue(params, name) {
  const exact = ownProp(params, name);
  if (exact !== undefined) return exact;
  const key = nameKey(name);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && nameKey(k) === key) return v;
  }
  return undefined;
}

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

// base URL 뒤에 경로를 붙인다. 끝의 '/' 유무는 설정하는 사람마다 다르고(`…/v1`과 `…/v1/`), 그대로
// 이으면 `…/v1//chat/completions`가 된다 — 대부분의 서버는 받아주지만 경로를 엄격히 대조하는
// 프록시는 404를 내고, 화면에는 'LLM 호출 실패'만 남아 .env의 슬래시 하나를 의심하기 어렵다.
// LLM(llm-openai.js)과 임베딩(embedding.js)이 같은 함수를 쓴다. path는 앞에 '/' 없이 적는다.
// 미설정(undefined)은 그대로 통과시킨다 — '/chat/completions'는 fetch가 URL 파싱 오류로 거부하고,
// 그 상황은 기동 시점 경고(server.js)가 이미 가리킨다.
export const joinUrl = (base, path) => `${String(base ?? '').replace(/\/+$/, '')}/${path}`;

// 상류(LLM·임베딩) 응답 본문의 상한.
// 이 시스템의 다른 I/O 경계에는 모두 예산이 있다 — 질문 1MB(server.js express.json), 행 수·셀
// 길이·컬럼 수(oracle.js), 프롬프트 총량(MAX_PROMPT_TOTAL_LEN), 조회·LLM·임베딩·관리 DB의 시간
// 상한. 상류가 돌려주는 본문만 res.json()으로 통째로 받고 있었다. 그 한 자리가 예산 밖이면
// 상한을 정하는 것은 우리가 아니라 상대다: 폭주하는 엔드포인트나 잘못 가리킨 주소
// (LLM_BASE_URL의 오타 하나면 큰 파일을 가리킬 수 있다) 하나가 워커의 메모리를 그대로 가져간다.
// 확인: 64MB짜리 응답 한 건에 백엔드 RSS가 86MB → 365MB로 올랐다(버퍼·문자열·파싱 결과가 겹친다).
//
// 값의 근거. 완성은 MAX_COMPLETION_TOKENS(16,384)로 이미 묶여 있다 — 한 토큰이 최악으로 길고
// (한글은 토큰당 3바이트 남짓) JSON 이스케이프까지 겹쳐도 1MB 안쪽이고, 사고 과정 블록과
// usage·id 같은 껍데기를 넉넉히 얹어도 이 값에 닿지 않는다. 임베딩도 같은 값을 쓴다: 한 번에
// BATCH(32)건 × 1024차원이라 실측 1MB 이하다. 즉 이 상한에 걸리는 응답은 우리가 요청한 것이 아니다.
export const MAX_UPSTREAM_JSON_BYTES = 8 * 1024 * 1024;
// 오류 응답은 앞부분만 로그에 남긴다(LLM 300자·임베딩 200자) — 그 이상은 받을 이유가 없다.
export const MAX_UPSTREAM_ERROR_BYTES = 64 * 1024;

// 상류 응답 본문을 상한 안에서만 읽는다. 다 받아 놓고 자르면 이미 메모리는 다 쓴 뒤다 —
// 넘는 순간 거기서 끊고 스트림을 취소한다(연결도 함께 놓는다).
// what은 오류 문구에 들어갈 이름이다: 이 실패는 'LLM 호출 실패' 한 줄로 뭉개지면 원인을 알 수 없다.
// 넘쳤다는 사실은 tooLarge로 표시해 둔다 — 같은 입력을 다시 보내도 결과가 같으므로 재시도 대상이
// 아니고, 그 판정을 부르는 쪽이 해야 한다(embedding.js의 retriable).
// body가 없는 응답은 text()로 물러선다. 실제 fetch는 언제나 본문 스트림을 주므로 이 길은
// 스텁(테스트 더블)을 위한 것이다.
export async function readCapped(res, maxBytes, what) {
  if (!res?.body?.getReader) return String(await res.text());
  const reader = res.body.getReader();
  const 조각 = [];
  let 크기 = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      크기 += value.byteLength;
      if (크기 > maxBytes) {
        const e = new Error(`${what} 응답이 상한(${maxBytes.toLocaleString('en-US')} bytes)을 넘었습니다`);
        e.tooLarge = true;
        throw e;
      }
      조각.push(value);
    }
  } finally {
    // 끝까지 읽었으면 아무 일도 하지 않고, 도중에 끊었으면 남은 본문을 버리고 연결을 놓는다.
    await reader.cancel().catch(() => { /* 이미 닫혔다 */ });
  }
  return Buffer.concat(조각).toString('utf8');
}
