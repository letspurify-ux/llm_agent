// 검색 경계: 소스별 벡터 검색 + query_name 정확 일치.
// 빈 배열은 성공·0건, null은 검색 실패다. 정확한 쿼리명은 임베딩 없이도 찾는다.
import { query, loadChunkRanges, loadQueriesByNames } from './db.js';
import { embed, EMBEDDING_MODEL, embeddingHashExpr, isEmbeddingEnabled, warnEmbeddingFailure, embedQueryPrefix } from './embedding.js';
import { warnOnce, SEARCH_LIMIT, MIN_SEARCH_RESULTS, MAX_DOC_LEN, MAX_EMBED_TEXT_LEN, clipText } from './constants.js';
import { planRanges, buildItems, sameChunk } from './chunk.js';

const LIMIT = SEARCH_LIMIT; // 검색 한 번이 돌려주는 최대 후보 수 — 기본 20, 환경변수로 낮춘다 (constants.js SEARCH_LIMIT)
const EF_SEARCH = 150;    // MHNSW 탐색 깊이. 기본값(20)은 1024차원에서 recall이 크게 떨어진다
                          // (10k 부하 테스트에서 실측: 기본값은 최근접을 놓치고, 400이면 정확 검색과 일치·~20ms).
                          // 400에서 낮췄다 — 그 값은 한 인덱스에 세 소스를 담고 `WHERE src = ?`로 거르던 구조가
                          // 요구한 여유였다. 소스별 테이블로 나뉜 지금은 자기 인덱스에서 LIMIT건만 찾으면 되므로
                          // 훑을 양이 줄고 그만큼 빨라진다. 질의 하나가 요구하는 최대치(지식의
                          // LIMIT × CHUNK_OVERFETCH = 60)보다 커야 한다 — 그래야 ANN이 그 수를 채운다.
// 지식만 상한의 이 배수만큼 '청크'를 받는다. 청크는 문서로 병합되므로(planRanges) 20청크가 20항목이
// 되지 않는다 — 한 문서가 적중을 독차지하면 20청크가 문서 1건으로 접히고, 다른 문서는 후보에 오르지도
// 못한 채 사라진다(실측). 문서 상한을 채우려면 청크를 그 배수만큼 받아야 한다.
//
// 거리 문턱 밖의 후보도 함께 받아 둔다. 병합 뒤 최소 개수에 못 미칠 때 가까운 순서로 보충한다.
export const CHUNK_OVERFETCH = 3;  // (테스트에서 쓰므로 export 한다)
const MAX_DIST = 0.4; // 기본 관련도 문턱. 최소 개수까지만 문턱 밖의 가까운 후보를 허용한다.
const selectMatches = rows => rows && rows.filter((row, i) => i < MIN_SEARCH_RESULTS || row._dist <= MAX_DIST);
// 이전 버전이 저장한 영벡터·극단 벡터를 복구 SQL 실행 전에도 결과에서 제외한다.
// 범위는 repair-invalid-vectors.sql과 같으며 정상화된 새 벡터의 노름(약 1)은 충분히 안쪽이다.
const MIN_SAFE_NORM = 1.0842021724855044e-19;
const MAX_SAFE_NORM = 1.844674352395373e19;
const ZERO_VECTOR = JSON.stringify(Array(1024).fill(0));

// 테이블별 임베딩 원문 컬럼 (첫 컬럼 = 제목/이름). embed-sync.js가 임베딩 원문을 만들 때 쓴다 —
// 검색이 무엇을 보고 맞추는지가 곧 이 컬럼들이다. 쿼리는 SQL 원문을 넣지 않는다(질문과 닮은 것은 설명이다).
export const SEARCH_COLUMNS = {
  // 지식은 원문(knowledge)이 아니라 청크를 검색한다. 원문은 임베딩 상한(MAX_EMBED_TEXT_LEN)에서
  // 잘려 앞부분만 벡터가 되므로, 긴 문서의 뒷부분이 어떤 검색어로도 걸리지 않았다 (chunk.js 머리말).
  // 컬럼 이름이 knowledge와 같아서 여기 한 줄만 바뀐다.
  knowledge_chunk: ['title', 'content'],
  qa_method: ['title', 'method'],
  query_registry: ['query_name', 'query_desc', 'input_desc', 'output_desc'],
};

// 소스 테이블 → 그 임베딩 테이블. 규칙 하나로 파생한다 (schema.sql 참고) —
// 매핑 표를 따로 들면 테이블을 더할 때 한쪽만 고쳐지고, 그 실패는 '검색 불가'로만 보인다.
export const vecTable = table => `vec_${table}`;

// 반환: 관련도 순 행 배열. 검색 자체가 성립하지 않았으면(임베딩 미설정·임베딩 실패·벡터 SQL 실패)
// null이다 — '찾았는데 없다'([])와 '찾아보지 못했다'(null)를 호출부가 구분해야 한다 (파일 머리말 참고).
// 지식 검색만 후처리가 붙는다: 적중한 청크를 문서별로 묶고, 사이의 구멍을 메우고, 이어 붙인다.
// 개수로 깎지 않는 이유와 문서당 글자 상한의 근거는 chunk.js의 병합 머리말에 있다.
// 후처리에서 무엇이 잘못돼도 검색 자체를 '불가'로 떨어뜨리지는 않는다 — null은 임베딩·벡터 검색이
// 성립하지 않았다는 뜻이고(파일 머리말), 병합 실패까지 그 뜻에 섞으면 모델은 '지금은 자료를 확인할
// 수 없다'고 답한다. 청크 원문은 이미 손에 있으므로 병합 없이 그대로 싣는 편이 낫다.
export async function searchKnowledge(text) {
  const candidates = await vectorSearch('knowledge_chunk', text, LIMIT * CHUNK_OVERFETCH);
  if (!candidates || !candidates.length) return candidates;
  const hits = selectMatches(candidates);
  let plans = planRanges(hits);
  const addClosest = rows => {
    const seen = new Set(hits.map(row => row.seq));
    for (const row of rows) {
      // 보충 읽기가 구간 안의 빈 청크를 채우면 흩어진 항목이 다시 합쳐진다.
      // 읽기 전 임시 항목 수 대신 병합 계획의 수로 최소 개수를 판단한다.
      if (plans.length >= MIN_SEARCH_RESULTS) break;
      if (seen.has(row.seq)) continue;
      seen.add(row.seq);
      hits.push(row);
      hits.sort((a, b) => a._dist - b._dist);
      plans = planRanges(hits);
    }
  };
  addClosest(candidates);
  // 한 문서가 ANN 후보를 독차지하면 그 밖의 문서가 있어도 병합 결과는 한 건이다.
  // 이때만 문서별 최근접 청크를 정확 검색해 최소 개수를 보충한다. 이미 확보한 근거는 보존한다.
  if (plans.length < MIN_SEARCH_RESULTS && candidates.length >= LIMIT * CHUNK_OVERFETCH) {
    try {
      const extra = await nearestKnowledgeDocuments(await embedText(text));
      const knownDocs = new Set(hits.map(row => row.doc_seq));
      addClosest(extra.filter(row => !knownDocs.has(row.doc_seq)));
    } catch (e) {
      warnOnce('search:knowledge-minimum', `minimum candidate refill failed — keeping matched chunks: ${e.message}`);
    }
  }
  const fallback = searchItems(plans, hits, hits);
  try {
    // 계획된 범위의 앞뒤 한 조각씩을 함께 읽는다. 항목에 싣지는 않는다(buildItems가 계획된 범위 안에서만
    // 채운다) — '더 받을 것이 남았는가'(full)를 검색 시점에 확정하는 데만 쓴다. 이웃을 모르면 번호를 붙일
    // 수밖에 없고, 그 번호로 청구한 expand가 상한 때문에 한 글자도 늘리지 못하면 모델은 왕복 하나를
    // 헛되이 태운다. 비용은 문서당 최대 두 행이다.
    const rows = await loadChunkRanges(plans.map(p => ({ ...p, from: Math.max(1, p.from - 1), to: p.to + 1 })));
    // 병합한 '문서'를 상한까지 취한다. 청크를 그보다 많이 받은 이유가 여기다 (CHUNK_OVERFETCH).
    // 검색에서 확보한 원문은 보충 읽기가 일부 행만 반환해도 보존한다.
    // 같은 청크는 검색 시점의 본문을 우선한다.
    const key = row => `${row.doc_seq}:${row.chunk_no}`;
    const current = new Map(rows.map(row => [key(row), row]));
    const changed = new Set(hits.filter(hit => !sameChunk(hit, current.get(key(hit)))).map(hit => hit.doc_seq));
    // 변경·삭제된 문서는 확보한 적중만 보관한다. 다른 문서의 정상 보충은 계속 사용한다.
    const available = new Map([...rows.filter(row => !changed.has(row.doc_seq)), ...hits].map(row => [key(row), row]));
    return selectMatches(searchItems(plans, [...available.values()], hits)).slice(0, LIMIT);
  } catch (e) {
    warnOnce('search:merge', `chunk merge failed — falling back to matched chunks: ${e.message}`);
    return selectMatches(fallback).slice(0, LIMIT);
  }
}

function searchItems(plans, rows, hits) {
  const items = buildItems(plans, rows, { maxDocLen: MAX_DOC_LEN });
  let remaining = hits;
  for (;;) {
    const covered = new Set(items.flatMap(item => item.chunks.map(row => `${row.doc_seq}:${row.chunk_no}`)));
    remaining = remaining.filter(row => !covered.has(`${row.doc_seq}:${row.chunk_no}`));
    if (!remaining.length) break;
    // 보충 실패로 구멍이 남았거나 긴 병합 구간이 상한에 닿으면,
    // 아직 싣지 못한 적중을 독립 구간으로 남긴다.
    const extra = buildItems(planRanges(remaining, { gapFill: 0 }), remaining, { maxDocLen: MAX_DOC_LEN });
    if (!extra.length) break;
    items.push(...extra);
  }
  return items.sort((a, b) => a._dist - b._dist);
}

export async function searchQaMethods(text) {
  return selectMatches(await vectorSearch('qa_method', text));
}

// 쿼리 직접 검색 — qa_method 등록 없이도 검색어로 쿼리를 찾는 경로 (agent.js 라우팅의 경로B)
export async function searchQueries(text) {
  const name = String(text ?? '').trim();
  if (!name) return [];
  let exactFailed = false;
  // query_name의 UNIQUE 인덱스로 정확한 이름을 먼저 해석한다. 적중하면 임베딩도 필요 없다.
  // VARCHAR(100)의 이름과 소문자 변형은 UTF-16 최대 200자다.
  // İ → i + 결합점처럼 문자 수도 늘 수 있으므로 코드포인트 100자로 제한하지 않는다.
  if (name.length <= 200) {
    try {
      const exact = await loadQueriesByNames([name]);
      if (exact.length) return exact.map(row => ({ ...row, exact: true }));
    } catch (e) {
      exactFailed = true;
      warnOnce('search:query-name', `exact query lookup failed: ${e.message}`);
    }
  }
  const matches = selectMatches(await vectorSearch('query_registry', text));
  // 아직 임베딩되지 않은 등록명도 정확 조회로 찾을 수 있다. 그 조회가 실패했으면
  // 빈 벡터 결과만으로 정상 0건이라고 단정하지 않는다. 그래야 같은 검색을 재시도할 수 있다.
  return exactFailed && !matches?.length ? null : matches;
}

async function vectorSearch(table, text, limit) {
  // 빈 검색어는 '아무것도 찾지 않았다'다 — 임베딩 서버에 빈 입력을 보내면 거부되어 '검색 불가'로
  // 잘못 기록된다. 호출부는 빈 검색어를 질문으로 대체하므로(agent.js) 정상 경로에서는 오지 않는다.
  if (!String(text ?? '').trim()) return [];
  const vector = await embedText(text);
  if (!vector) return null;
  return vecQuery(table, vector, limit).catch(e => {
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
    warnOnce('search:embedding', 'EMBEDDING_URL is not set — vector search is unavailable; exact query-name lookup still works. Set it in backend/.env.');
    return null;
  }
  // 실제 서버·모델·전송 입력을 키로 삼는다. 접두/서버가 바뀐 호출은 이전 벡터와
  // 합치지 않고, 상한 밖 원문만 다른 검색어는 같은 요청으로 합친다.
  const input = clipText(embedQueryPrefix() + text, MAX_EMBED_TEXT_LEN);
  const key = JSON.stringify([process.env.EMBEDDING_URL, EMBEDDING_MODEL, input]);
  const hit = embedCache.get(key);
  if (hit) {
    // 적중한 항목을 맨 뒤로 옮긴다 — 삽입 순서만 보고 밀어내면(FIFO) 가장 자주 묻는 검색어가
    // 한 번 들어간 뒤 스쳐 가는 검색어 100건에 그대로 밀려난다. 캐시는 가득 찬 채로 적중률만
    // 0에 수렴하고, 오류는 나지 않은 채 같은 검색어마다 임베딩 왕복(최대 60초)이 되돌아온다.
    // sql.js analysisCache가 같은 이유로 같은 방식(delete 후 재삽입)을 쓴다.
    embedCache.delete(key);
    embedCache.set(key, hit);
    return hit;
  }
  // 가득 차면 통째로 비우지 않고 가장 오래 '안 쓴' 것부터 하나씩 밀어낸다 (Map은 삽입 순서를
  // 지키고, 위에서 적중할 때마다 맨 뒤로 다시 넣으므로 그 순서가 곧 LRU다).
  // clear()는 아직 응답을 기다리는 최신 항목까지 버려서, 같은 검색어의 다음 검색이
  // 진행 중인 요청에 합류하지 못하고 60초짜리 임베딩 호출을 한 번 더 만든다.
  while (embedCache.size >= EMBED_CACHE_MAX) {
    embedCache.delete(embedCache.keys().next().value);
  }
  const p = embed([input])
    .then(v => v[0])
    .catch(e => {
      warnEmbeddingFailure(e);
      // 실패는 캐시하지 않는다 (다음 요청에서 재시도). 단, 그 자리에 있는 것이 '이 promise'일 때만
      // 지운다 — 느린 실패가 돌아오는 사이 위의 LRU가 이 항목을 밀어내고 같은 검색어의 새 요청이
      // 새 promise를 넣었을 수 있는데, 키로만 지우면 그 진행 중인 항목까지 함께 버려
      // 다음 검색이 합류하지 못하고 60초짜리 임베딩 호출을 한 번 더 만든다.
      if (embedCache.get(key) === p) embedCache.delete(key);
      return null;                 // 검색 불가 — vectorSearch가 null로 알린다
    });
  embedCache.set(key, p);
  return p;
}

// 임베딩 모델을 미리 올려 둔다. Ollama는 유휴 뒤 모델을 내리므로(기본 5분, OLLAMA_KEEP_ALIVE로
// 바꾼다 — README) 한산한 시간대의 첫 검색이 모델 재적재(수 초)를 그대로 낸다. 기동 시 한 번
// 불러 두면 최소한 첫 질문은 그 비용을 내지 않는다. 실패해도 조용히 넘긴다 — 검색 시점에 다시
// 시도하고 그때의 실패는 그쪽이 알린다. 미설정이면 아무것도 하지 않는다(경고는 검색 시점에 한 번).
//
// signal은 정상 종료 신호다(embed-sync.js shutdownSignal — 배선은 server.js가 한다). 반드시 받아야 한다:
// 이 호출은 종료 경로가 기다리는 backgroundJobs의 하나인데(server.js), 임베딩 서버가 응답하지 않으면
// embed()의 자체 타임아웃 60초까지 매달린다 — 모델 콜드 로드가 30초+ 걸리는 것이 정상이라 그 창은
// 기동 직후 재배포와 정확히 겹친다. 신호가 없던 동안 SIGTERM이 그 사이에 닿으면 종료가 10초 강제
// 타이머로 밀려 종료 코드 1이 되고, 그 타이머는 process.exit이라 closePool()·closeOraclePools()가
// 실행되지 않았다(실측). 같은 신호를 쓰는 embed-sync는 처음부터 그렇게 하고 있었다 — 형제 갈래만 빠져 있었다.
// 요청 경로의 임베딩(embedText)에는 여전히 주지 않는다 (embed-sync.js의 신호 주석).
export async function warmUpEmbedding(signal) {
  if (!isEmbeddingEnabled()) return false;
  try {
    await embed(['warm-up'], signal);
    return true;
  } catch (e) {
    // 종료 신호로 끊긴 호출은 실패가 아니다 — 경고를 남기면 정상 재배포마다 '임베딩 서버에 닿지
    // 못했다'는 오해를 부르는 줄이 쌓인다 (embed-sync.js embedStale이 쓰는 것과 같은 판정).
    if (!signal?.aborted) warnEmbeddingFailure(e);
    return false;
  }
}

// 검색어 임베딩 후 그 소스의 임베딩 테이블에서 코사인 거리 상위 LIMIT건 → 원본 행 JOIN.
// _dist를 함께 돌려준다 — 청크 병합이 대표 청크와 문서 순서를 이 값으로 정하고(chunk.js planRanges),
// 계측(agent.js trace.search.top)도 이 값을 남겨 문서당 상한을 나중에 데이터로 다시 잡는다.
// table은 코드가 정의한 식별자다(SEARCH_COLUMNS의 키) — 외부 입력이 아니다.
async function vecQuery(table, vector, limit) {
  const n = Number.isInteger(limit) && limit > 0 ? limit : LIMIT;
  const currentHash = embeddingHashExpr(SEARCH_COLUMNS[table].map(c => `t.${c}`));
  const encoded = JSON.stringify(vector);
  // LEFT JOIN으로 후보를 보존한다. 해시 불일치/원본 삭제를 WHERE에서 제거하면
  // 정상적인 0건과 '무효 후보가 자리를 차지한 0건'을 구분할 수 없어 보충할 수 없다.
  // LIMIT이 있는 파생 테이블을 왼쪽에 두어 평상시 본문 조회와 해싱은 후보에만 적용한다.
  const candidates = await query(
    `SET STATEMENT mhnsw_ef_search=${EF_SEARCH} FOR
     SELECT t.*, v._dist,
       (t.seq IS NULL OR v.embed_hash <> ${currentHash}) AS _stale,
       (COALESCE(v._norm, 0) NOT BETWEEN ${MIN_SAFE_NORM} AND ${MAX_SAFE_NORM}) AS _invalid FROM (
       SELECT seq, embed_hash, VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS _dist,
         VEC_DISTANCE_EUCLIDEAN(embedding, VEC_FromText(?)) AS _norm
       FROM ${vecTable(table)} ORDER BY _dist LIMIT ${n}
     ) v LEFT JOIN ${table} t ON t.seq = v.seq
     ORDER BY v._dist, v.seq LIMIT ${n}`,
    [EMBEDDING_MODEL, encoded, ZERO_VECTOR]
  );
  const valid = candidates.filter(row => !Number(row._stale) && !Number(row._invalid))
    .map(({ _stale, _invalid, ...row }) => row);
  if (valid.length === candidates.length) return valid;
  // 무효 후보가 있는 회차만 정확 검색으로 보충한다. 고정 배수로 늘리면 오래된 벡터가
  // 그 배수보다 많을 때 같은 누락이 재발한다. 벡터 인덱스를 배제하여 필터 후 LIMIT을
  // 적용하고 현재 본문/모델이 유효한 결과를 찾는다. DB의 queryTimeout으로 비용을 제한한다.
  // 평상시는 위 한 번의 ANN 조회뿐이다. 재조회도 하나의 SELECT 스냅샷에서 검증한다.
  return query(
    `SELECT t.*, VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(?)) AS _dist
     FROM ${vecTable(table)} v IGNORE INDEX (embedding) JOIN ${table} t ON t.seq = v.seq
     WHERE v.embed_hash = ${currentHash}
       AND COALESCE(VEC_DISTANCE_EUCLIDEAN(v.embedding, VEC_FromText(?)), 0)
         BETWEEN ${MIN_SAFE_NORM} AND ${MAX_SAFE_NORM}
     ORDER BY _dist, v.seq LIMIT ${n}`,
    [encoded, EMBEDDING_MODEL, ZERO_VECTOR]
  ).catch(e => {
    // 보충 실패가 이미 확보한 정상 근거까지 버리지 않게 한다. 정상 후보가 하나도
    // 없으면 상위 호출이 null(검색 불가)로 보고하며 0건으로 숨기지 않는다.
    if (!valid.length) throw e;
    warnOnce(`search:refill:${table}`, `candidate refill failed on ${table} — keeping validated matches: ${e.message}`);
    return valid;
  });
}

// 가까운 청크가 한 문서에 몰린 경우에만 사용한다. 판본·벡터 유효성을 먼저 검증하고
// 문서별 가장 가까운 청크를 뽑으므로, 오래된 벡터나 고아 행으로 최소 개수를 채우지 않는다.
async function nearestKnowledgeDocuments(vector) {
  if (!vector) throw new Error('query embedding unavailable');
  const encoded = JSON.stringify(vector);
  const currentHash = embeddingHashExpr(SEARCH_COLUMNS.knowledge_chunk.map(c => `t.${c}`));
  const rows = await query(
    `SELECT ranked.* FROM (
       SELECT t.*, VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(?)) AS _dist,
         ROW_NUMBER() OVER (PARTITION BY t.doc_seq
           ORDER BY VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(?)), t.seq) AS _doc_rank
       FROM vec_knowledge_chunk v IGNORE INDEX (embedding) JOIN knowledge_chunk t ON t.seq = v.seq
       WHERE v.embed_hash = ${currentHash}
         AND COALESCE(VEC_DISTANCE_EUCLIDEAN(v.embedding, VEC_FromText(?)), 0)
           BETWEEN ${MIN_SAFE_NORM} AND ${MAX_SAFE_NORM}
     ) ranked WHERE _doc_rank = 1 ORDER BY _dist, seq LIMIT ${MIN_SEARCH_RESULTS}`,
    [encoded, encoded, EMBEDDING_MODEL, ZERO_VECTOR]
  );
  return rows.map(({ _doc_rank, ...row }) => row);
}
