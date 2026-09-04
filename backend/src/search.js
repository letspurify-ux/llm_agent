// 지식/Q&A처리방법/쿼리 검색 — 벡터 검색(MariaDB VECTOR 인덱스, 코사인 거리) 단일 경로.
// 검색 구현은 이 파일에만 있다.
//
// LIKE 검색을 걷어낸 이유. 앞선 구현은 LIKE 관련도와 벡터를 병렬로 돌려 RRF로 합쳤다. LIKE는
// 인덱스를 못 쓰는 '%…%' 스캔이라 비용이 (행 수 × 낱말 수 × 조사 변형 × 컬럼 수 × 본문 길이)에
// 비례했고, 질문 낱말 30개면 행마다 LIKE를 180번 평가했다 — 지식이 만 건이면 검색 한 번이 초
// 단위였다. 검색어를 이제 모델이 핵심 낱말 몇 개로 쓰므로(llm-openai.js 시스템 프롬프트) 표현 차이는
// 벡터가 흡수하고, 정확 키워드는 검색어 자체에 들어가 벡터 거리에도 그대로 반영된다.
// 대가: 임베딩 서버가 없으면 검색이 성립하지 않는다. 그 상태를 '0건'으로 뭉개지 않고 null로 돌려
// 호출부(agent.js)가 '못 찾아봤다'를 모델과 chat_log에 남기게 한다 — 조용히 빈 결과가 되면
// 모델은 '등록된 자료가 없다'고 단정하고, 그 오답은 어디에도 기록되지 않는다.
import { query } from './db.js';
import { embed, isEmbeddingEnabled, warnEmbeddingFailure } from './embedding.js';
import { warnOnce, SEARCH_LIMIT } from './constants.js';

const LIMIT = SEARCH_LIMIT; // 검색 한 번이 돌려주는 최대 후보 수 — 기본 20, 환경변수로 낮춘다 (constants.js SEARCH_LIMIT)
const EF_SEARCH = 400;    // MHNSW 탐색 깊이. 기본값(20)은 1024차원에서 recall이 크게 떨어진다
                          // (10k 부하 테스트에서 실측: 기본값은 최근접을 놓치고, 400이면 정확 검색과 일치·~20ms)
const VEC_OVERFETCH = 5;  // vec_store는 세 소스(knowledge/qa_method/query_registry)를 한 테이블·한 인덱스에 담는다.
                          // ANN이 상위 K건을 고른 뒤 src로 거르는 순서가 되면, 큰 소스가 K건을 다 차지해
                          // 작은 소스(예: query_registry 30건)의 벡터 검색이 조용히 0~2건으로 주저앉는다 —
                          // 경로B(qa_method 없이 등록한 쿼리) 라우팅이 통째로 사라지는데 오류는 남지 않는다.
                          // 넉넉히 뽑아 거른 뒤 LIMIT을 다시 적용해 그 순서 의존을 없앤다
                          // (EF_SEARCH가 LIMIT×OVERFETCH보다 커야 의미가 있다 — 400 > 100).
const MAX_DIST = 0.55;    // 관련도 임계값 (코사인 거리). 실측: 관련 0.30~0.53, 무관 0.58~0.75.
                          // top-K는 무관해도 항상 K건을 돌려주므로, 이 필터가 없으면 "관련 지식 없음 →
                          // 일반 지식 답변" 폴백이 무력화된다.

// 테이블별 임베딩 원문 컬럼 (첫 컬럼 = 제목/이름). embed-sync.js가 임베딩 원문을 만들 때 쓴다 —
// 검색이 무엇을 보고 맞추는지가 곧 이 컬럼들이다. 쿼리는 SQL 원문을 넣지 않는다(질문과 닮은 것은 설명이다).
export const SEARCH_COLUMNS = {
  knowledge: ['title', 'content'],
  qa_method: ['title', 'method'],
  query_registry: ['query_name', 'query_desc', 'input_desc', 'output_desc'],
};

// 반환: 관련도 순 행 배열. 검색 자체가 성립하지 않았으면(임베딩 미설정·임베딩 실패·벡터 SQL 실패)
// null이다 — '찾았는데 없다'([])와 '찾아보지 못했다'(null)를 호출부가 구분해야 한다 (파일 머리말 참고).
export function searchKnowledge(text) {
  return vectorSearch('knowledge', text);
}

export function searchQaMethods(text) {
  return vectorSearch('qa_method', text);
}

// 쿼리 직접 검색 — qa_method 등록 없이도 검색어로 쿼리를 찾는 경로 (agent.js 라우팅의 경로B)
export function searchQueries(text) {
  return vectorSearch('query_registry', text);
}

async function vectorSearch(table, text) {
  // 빈 검색어는 '아무것도 찾지 않았다'다 — 임베딩 서버에 빈 입력을 보내면 거부되어 '검색 불가'로
  // 잘못 기록된다. 호출부는 빈 검색어를 질문으로 대체하므로(agent.js) 정상 경로에서는 오지 않는다.
  if (!String(text ?? '').trim()) return [];
  const vector = await embedText(text);
  if (!vector) return null;
  return vecQuery(table, vector).catch(e => {
    // 억제는 warnOnce에 맡긴다 — '한 번만 경고' 플래그를 쓰면 vec_store 미생성으로 한 번 알린 뒤
    // 차원 불일치·인덱스 손상 같은 전혀 다른 이유로 벡터 검색이 죽어도 로그가 남지 않는다.
    // 검색이 통째로 없는 상태라 로그와 이력의 '검색 불가' 표시가 유일한 단서다.
    // scope를 테이블별로 나눈다 — 드라이버가 돌려주는 e.message에 대상 테이블이 섞여 들어오므로,
    // 한 scope로 묶으면 요청마다 세 문구가 번갈아 들어와 억제가 걸리지 않는다.
    warnOnce(`search:${table}`, `vector search failed on ${table} — this search returns nothing: ${e.message}`);
    return null;
  });
}

// ===== 임베딩 =====
// 같은 검색어는 임베딩을 1회만 계산한다 — 검색 한 번이 세 소스를 병렬로 돌리므로,
// promise를 캐시해 병렬 호출까지 합친다.
const embedCache = new Map();
const EMBED_CACHE_MAX = 100;

function embedText(text) {
  if (!isEmbeddingEnabled()) {
    // 설정상 검색이 없는 상태다. 오류는 아니지만 '검색 불가'가 매 요청 조용히 반복되므로 한 번은 알린다.
    warnOnce('search:embedding', 'EMBEDDING_URL is not set — every search returns nothing (vector search is the only search path). Set it in backend/.env.');
    return null;
  }
  const hit = embedCache.get(text);
  if (hit) {
    // 적중한 항목을 맨 뒤로 옮긴다 — 삽입 순서만 보고 밀어내면(FIFO) 가장 자주 묻는 검색어가
    // 한 번 들어간 뒤 스쳐 가는 검색어 100건에 그대로 밀려난다. 캐시는 가득 찬 채로 적중률만
    // 0에 수렴하고, 오류는 나지 않은 채 같은 검색어마다 임베딩 왕복(최대 60초)이 되돌아온다.
    // sql.js analysisCache가 같은 이유로 같은 방식(delete 후 재삽입)을 쓴다.
    embedCache.delete(text);
    embedCache.set(text, hit);
    return hit;
  }
  // 가득 차면 통째로 비우지 않고 가장 오래 '안 쓴' 것부터 하나씩 밀어낸다 (Map은 삽입 순서를
  // 지키고, 위에서 적중할 때마다 맨 뒤로 다시 넣으므로 그 순서가 곧 LRU다).
  // clear()는 아직 응답을 기다리는 최신 항목까지 버려서, 같은 검색어의 다음 검색이
  // 진행 중인 요청에 합류하지 못하고 60초짜리 임베딩 호출을 한 번 더 만든다.
  while (embedCache.size >= EMBED_CACHE_MAX) {
    embedCache.delete(embedCache.keys().next().value);
  }
  const p = embed([text])
    .then(v => v[0])
    .catch(e => {
      warnEmbeddingFailure(e);
      // 실패는 캐시하지 않는다 (다음 요청에서 재시도). 단, 그 자리에 있는 것이 '이 promise'일 때만
      // 지운다 — 느린 실패가 돌아오는 사이 위의 LRU가 이 항목을 밀어내고 같은 검색어의 새 요청이
      // 새 promise를 넣었을 수 있는데, 키로만 지우면 그 진행 중인 항목까지 함께 버려
      // 다음 검색이 합류하지 못하고 60초짜리 임베딩 호출을 한 번 더 만든다.
      if (embedCache.get(text) === p) embedCache.delete(text);
      return null;                 // 검색 불가 — vectorSearch가 null로 알린다
    });
  embedCache.set(text, p);
  return p;
}

// 임베딩 모델을 미리 올려 둔다. Ollama는 유휴 뒤 모델을 내리므로(기본 5분, OLLAMA_KEEP_ALIVE로
// 바꾼다 — README) 한산한 시간대의 첫 검색이 모델 재적재(수 초)를 그대로 낸다. 기동 시 한 번
// 불러 두면 최소한 첫 질문은 그 비용을 내지 않는다. 실패해도 조용히 넘긴다 — 검색 시점에 다시
// 시도하고 그때의 실패는 그쪽이 알린다. 미설정이면 아무것도 하지 않는다(경고는 검색 시점에 한 번).
export async function warmUpEmbedding() {
  if (!isEmbeddingEnabled()) return false;
  try {
    await embed(['warm-up']);
    return true;
  } catch (e) {
    warnEmbeddingFailure(e);
    return false;
  }
}

// 검색어 임베딩 후 vec_store에서 코사인 거리 상위 LIMIT건 → 원본 행 JOIN.
function vecQuery(table, vector) {
  return query(
    `SET STATEMENT mhnsw_ef_search=${EF_SEARCH} FOR
     SELECT t.* FROM (
       SELECT seq, VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS _dist
       FROM vec_store WHERE src = ? ORDER BY _dist LIMIT ${LIMIT * VEC_OVERFETCH}
     ) v JOIN ${table} t ON t.seq = v.seq WHERE v._dist <= ${MAX_DIST}
     ORDER BY v._dist LIMIT ${LIMIT}`,
    [JSON.stringify(vector), table]
  );
}
