// 지식/Q&A처리방법/쿼리 검색 — 하이브리드(LIKE 관련도 + 벡터, RRF 병합).
// 검색 구현은 이 파일에만 있다. 임베딩 서버가 없으면 자동으로 LIKE-only로 동작한다.
import { query } from './db.js';
import { embed } from './embedding.js';

const LIMIT = 20;         // LLM에 넘길 최대 후보 수 (건당 약 84토큰)
const TITLE_WEIGHT = 3;   // 제목(첫 컬럼) 매칭은 본문 매칭보다 높게
const RRF_K = 60;         // Reciprocal Rank Fusion 상수 (표준값)
const EF_SEARCH = 400;    // MHNSW 탐색 깊이. 기본값(20)은 1024차원에서 recall이 크게 떨어진다
                          // (10k 부하 테스트에서 실측: 기본값은 최근접을 놓치고, 400이면 정확 검색과 일치·~20ms)

export function searchKnowledge(question) {
  return hybrid('knowledge', ['title', 'content'], question);
}

export function searchQaMethods(question) {
  return hybrid('qa_method', ['title', 'method'], question);
}

// 쿼리 직접 검색 — qa_method 등록 없이도 질문으로 쿼리를 찾는 경로 (agent.js 라우팅에서 사용)
export function searchQueries(question) {
  return hybrid('query_registry', ['query_name', 'query_desc', 'input_desc', 'output_desc'], question);
}

// LIKE(정확 키워드에 강함)와 벡터(표현 차이에 강함)를 병렬 실행 후 RRF로 병합.
// RRF는 순위만 쓰므로 점수 스케일 튜닝이 필요 없다: score = Σ 1/(K + rank)
async function hybrid(table, columns, question) {
  const [likeRows, vecRows] = await Promise.all([
    likeSearch(table, columns, question),
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
// 질문을 임베딩(요청당 1회)해 vec_store에서 코사인 거리 상위 LIMIT건 → 원본 행 JOIN
async function vecSearch(table, question) {
  const vectors = await embed([question]);
  if (!vectors) return null;
  return query(
    `SET STATEMENT mhnsw_ef_search=${EF_SEARCH} FOR
     SELECT t.* FROM (
       SELECT seq, VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS _dist
       FROM vec_store WHERE src = ? ORDER BY _dist LIMIT ${LIMIT}
     ) v JOIN ${table} t ON t.seq = v.seq ORDER BY v._dist`,
    [JSON.stringify(vectors[0]), table]
  );
}

// ===== LIKE 검색 (관련도 점수) =====
// 점수 = Σ (컬럼 가중치 × 토큰 길이)
//   - 여러 토큰이 맞을수록, 첫 컬럼(제목/이름)에 맞을수록, 긴(구체적인) 토큰이 맞을수록 높다
//   - 조사를 뗀 변형 토큰은 원형보다 짧으므로 자연히 낮게 반영된다
async function likeSearch(table, columns, question) {
  const tokens = [...new Set(question.split(/\s+/).flatMap(expandToken).filter(t => t.length >= 2))];
  if (tokens.length === 0) return [];

  const scoreParts = [];
  const params = [];
  for (const tok of tokens) {
    columns.forEach((col, i) => {
      const weight = (i === 0 ? TITLE_WEIGHT : 1) * tok.length;
      scoreParts.push(`CASE WHEN ${col} LIKE ? THEN ${weight} ELSE 0 END`);
      params.push(`%${tok}%`);
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
