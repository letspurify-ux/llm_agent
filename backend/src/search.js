// 지식/Q&A처리방법/쿼리 검색 — 하이브리드(LIKE 관련도 + 벡터, RRF 병합).
// 검색 구현은 이 파일에만 있다. 임베딩 서버가 없으면 자동으로 LIKE-only로 동작한다.
import { query } from './db.js';
import { embed, isEmbeddingEnabled, warnEmbeddingFailure } from './embedding.js';
import { warnOnce } from './constants.js';

const LIMIT = 20;         // LLM에 넘길 최대 후보 수 (건당 약 84토큰)
const TITLE_WEIGHT = 3;   // 제목(첫 컬럼) 매칭은 본문 매칭보다 높게
const RRF_K = 60;         // Reciprocal Rank Fusion 상수 (표준값)
const EF_SEARCH = 400;    // MHNSW 탐색 깊이. 기본값(20)은 1024차원에서 recall이 크게 떨어진다
                          // (10k 부하 테스트에서 실측: 기본값은 최근접을 놓치고, 400이면 정확 검색과 일치·~20ms)
const VEC_OVERFETCH = 5;  // vec_store는 세 소스(knowledge/qa_method/query_registry)를 한 테이블·한 인덱스에 담는다.
                          // ANN이 상위 K건을 고른 뒤 src로 거르는 순서가 되면, 큰 소스가 K건을 다 차지해
                          // 작은 소스(예: query_registry 30건)의 벡터 검색이 조용히 0~2건으로 주저앉는다 —
                          // 경로B(qa_method 없이 등록한 쿼리) 라우팅이 통째로 사라지는데 오류는 남지 않는다.
                          // 넉넉히 뽑아 거른 뒤 LIMIT을 다시 적용해 그 순서 의존을 없앤다
                          // (EF_SEARCH가 LIMIT×OVERFETCH보다 커야 의미가 있다 — 400 > 100).
const MAX_DIST = 0.55;    // 벡터 매칭 관련도 임계값 (코사인 거리). 실측: 관련 0.30~0.53, 무관 0.58~0.75.
                          // top-K는 무관해도 항상 K건을 돌려주므로, 이 필터가 없으면 "관련 지식 없음 →
                          // 일반 지식 답변" 폴백이 무력화된다. LIKE 쪽은 무필터(정확 키워드 보존).

// 테이블별 검색 대상 컬럼 (첫 컬럼 = 제목/이름, 가중치가 높다).
// embed-sync.js가 임베딩 원문을 만들 때도 같은 정의를 쓴다 — LIKE와 벡터가 서로 다른 내용을 보지 않도록.
export const SEARCH_COLUMNS = {
  knowledge: ['title', 'content'],
  qa_method: ['title', 'method'],
  query_registry: ['query_name', 'query_desc', 'input_desc', 'output_desc'],
};

export function searchKnowledge(question) {
  return hybrid('knowledge', question);
}

export function searchQaMethods(question) {
  return hybrid('qa_method', question);
}

// 쿼리 직접 검색 — qa_method 등록 없이도 질문으로 쿼리를 찾는 경로 (agent.js 라우팅에서 사용)
export function searchQueries(question) {
  return hybrid('query_registry', question);
}

// LIKE(정확 키워드에 강함)와 벡터(표현 차이에 강함)를 병렬 실행 후 RRF로 병합.
// RRF는 순위만 쓰므로 점수 스케일 튜닝이 필요 없다: score = Σ 1/(K + rank)
async function hybrid(table, question) {
  const [likeRows, vecRows] = await Promise.all([
    likeSearch(table, SEARCH_COLUMNS[table], question),
    vecSearch(table, question),
  ]);
  if (!vecRows) return likeRows; // 임베딩 불가 → LIKE-only 폴백
  return rrfMerge(likeRows, vecRows).slice(0, LIMIT);
}

function rrfMerge(...lists) {
  const score = new Map();
  const rows = new Map();
  for (const list of lists) {
    list.forEach((r, rank) => {
      rows.set(r.seq, r);
      score.set(r.seq, (score.get(r.seq) || 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([seq]) => rows.get(seq));
}

// ===== 벡터 검색 =====
// 같은 질문은 임베딩을 1회만 계산한다 — 요청 1건이 지식/처리방법/쿼리 검색으로
// vecSearch를 3회 이상 호출하므로, promise를 캐시해 병렬 호출까지 합친다.
const embedCache = new Map();
const EMBED_CACHE_MAX = 100;

function embedQuestion(question) {
  if (!isEmbeddingEnabled()) return null; // 설정상 LIKE-only — 오류 경로가 아니다
  const hit = embedCache.get(question);
  if (hit) return hit;
  // 가득 차면 통째로 비우지 않고 오래된 것부터 하나씩 밀어낸다 (Map은 삽입 순서를 지킨다).
  // clear()는 아직 응답을 기다리는 최신 항목까지 버려서, 같은 질문의 다음 검색이
  // 진행 중인 요청에 합류하지 못하고 60초짜리 임베딩 호출을 한 번 더 만든다.
  while (embedCache.size >= EMBED_CACHE_MAX) {
    embedCache.delete(embedCache.keys().next().value);
  }
  const p = embed([question])
    .then(v => v[0])
    .catch(e => {
      warnEmbeddingFailure(e);
      // 실패는 캐시하지 않는다 (다음 요청에서 재시도). 단, 그 자리에 있는 것이 '이 promise'일 때만
      // 지운다 — 느린 실패가 돌아오는 사이 위의 LRU가 이 항목을 밀어내고 같은 질문의 새 요청이
      // 새 promise를 넣었을 수 있는데, 키로만 지우면 그 진행 중인 항목까지 함께 버려
      // 다음 검색이 합류하지 못하고 60초짜리 임베딩 호출을 한 번 더 만든다.
      if (embedCache.get(question) === p) embedCache.delete(question);
      return null;                 // 검색은 LIKE-only로 계속한다
    });
  embedCache.set(question, p);
  return p;
}

// 질문 임베딩 후 vec_store에서 코사인 거리 상위 LIMIT건 → 원본 행 JOIN.
// SQL 오류(vec_store 미생성, 차원 불일치 등)도 null로 폴백해 LIKE-only로 계속 동작한다.
async function vecSearch(table, question) {
  const vector = await embedQuestion(question);
  if (!vector) return null;
  return vecQuery(table, vector).catch(e => {
    // 억제는 warnOnce에 맡긴다 — '한 번만 경고' 플래그를 쓰면 vec_store 미생성으로 한 번 알린 뒤
    // 차원 불일치·인덱스 손상 같은 전혀 다른 이유로 벡터 검색이 죽어도 로그가 남지 않는다.
    // 이 경로는 조용히 LIKE-only로 폴백하므로 로그가 유일한 단서다.
    warnOnce('search', `vector search failed — falling back to LIKE-only search: ${e.message}`);
    return null;
  });
}

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

// ===== LIKE 검색 (관련도 점수) =====
// 점수 = Σ (컬럼 가중치 × 토큰 길이)
//   - 여러 토큰이 맞을수록, 첫 컬럼(제목/이름)에 맞을수록, 긴(구체적인) 토큰이 맞을수록 높다
//   - 조사를 뗀 변형 토큰은 원형보다 짧으므로 자연히 낮게 반영된다
async function likeSearch(table, columns, question) {
  // 토큰 상한: 대형 입력이 CASE 절 수천 개짜리 SQL을 만들면 MariaDB thread stack overrun이 난다
  const tokens = searchTokens(question).slice(0, 50);
  if (tokens.length === 0) return [];

  const scoreParts = [];
  const params = [];
  for (const tok of tokens) {
    columns.forEach((col, i) => {
      const weight = (i === 0 ? TITLE_WEIGHT : 1) * tok.length;
      scoreParts.push(`CASE WHEN ${col} LIKE ? THEN ${weight} ELSE 0 END`);
      params.push(`%${tok.replace(/[\\%_]/g, '\\$&')}%`); // %와 _는 LIKE 와일드카드이므로 이스케이프
    });
  }

  // LIKE '%...%'는 인덱스를 못 쓰므로 WHERE로 거르나 HAVING으로 거르나 비용이 같다.
  // 점수를 한 번만 계산하도록 HAVING을 쓴다 (파라미터 중복 없음).
  return query(
    `SELECT *, ${scoreParts.join(' + ')} AS _score FROM ${table}
     HAVING _score > 0 ORDER BY _score DESC, seq LIMIT ${LIMIT}`,
    params
  );
}

// 질문 → LIKE 검색 토큰. 공백으로 나눈 뒤 앞뒤 문장부호를 떼고 조사 변형을 붙인다.
// 문장부호 제거가 먼저여야 한다: expandToken의 조사 판정이 /[가-힣]$/라서, 물음표 하나만 붙어도
// 판정이 실패해 변형이 하나도 만들어지지 않는다. "가상계측이란?"은 그 상태로 0건이 되고
// "가상계측이란"은 정상 적중한다 — 한국어 질문에 물음표를 붙이는 건 지극히 자연스러운 입력이다.
// (테스트에서 쓰므로 export 한다)
export function searchTokens(question) {
  return [...new Set(
    String(question ?? '')
      .split(/\s+/)
      .map(stripPunctuation)
      .flatMap(expandToken)
      .filter(t => t.length >= 2)
  )];
}

// 토큰 앞뒤의 문장부호·따옴표·괄호를 뗀다. 가운데는 건드리지 않는다 —
// 'BATCH-001'이나 'restart_batch.sh'처럼 부호가 식별자의 일부인 경우가 있다.
const stripPunctuation = t => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

// 한국어는 조사가 붙어("가상계측이") 원형("가상계측")과 LIKE 매칭이 되지 않는다.
// 3자 이상 토큰은 끝 1~2글자를 뗀 형태도 함께 검색해 조사를 흡수한다.
function expandToken(token) {
  const variants = [token];
  if (/[가-힣]$/.test(token)) {
    if (token.length >= 3) variants.push(token.slice(0, -1));
    if (token.length >= 5) variants.push(token.slice(0, -2));
  }
  return variants;
}
