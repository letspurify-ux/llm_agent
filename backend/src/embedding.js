// 로컬 임베딩 클라이언트 — Ollama의 OpenAI 호환 API 사용 (llm-openai.js와 같은 패턴).
//   EMBEDDING_URL   예) http://localhost:11434/v1 (Ollama 기본)
//   EMBEDDING_MODEL 예) bge-m3 (1024차원 — vec_store.embedding 차원과 일치해야 함)
// 실패/미설정 시 null을 반환하고, 호출부는 LIKE 검색만으로 동작한다 (graceful degradation).
// 모델명은 embed-sync의 embed_hash에도 들어간다(모델 교체 시 자동 재임베딩) — 한 곳에서만 정의한다
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'bge-m3';

// 임베딩 서버 사용 여부의 단일 판단 지점 — 호출부가 EMBEDDING_URL을 직접 읽어 같은 판단을
// 재구성하면, 여기 설정 경로가 바뀔 때 호출부만 조용히 어긋난다.
export const isEmbeddingEnabled = () => Boolean(process.env.EMBEDDING_URL);

let lastWarning = null;

const TIMEOUT_MS = 60_000; // 모델 콜드 로드가 30초+ 걸릴 수 있어 넉넉히. 초과 시 LIKE-only 폴백

export async function embed(texts) {
  const base = process.env.EMBEDDING_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`embeddings API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    // 응답 항목에 index가 있는 이유가 순서를 보장하지 않기 때문이다 (vLLM/TEI의 continuous batching은
    // 실제로 순서를 바꾼다). 위치로 짝지으면 텍스트와 벡터가 어긋난 채 올바른 해시와 함께 저장돼
    // 이후 동기화가 영영 고치지 못한다 — 반드시 index로 정렬하고 개수도 확인한다.
    const items = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (items.length !== texts.length) {
      throw new Error(`임베딩 응답 개수 불일치: 요청 ${texts.length}건, 응답 ${items.length}건`);
    }
    const vectors = items.map(d => d.embedding);
    if (vectors.some(v => !Array.isArray(v) || v.length === 0)) {
      throw new Error('임베딩 응답에 유효하지 않은 벡터가 포함되어 있습니다');
    }
    return vectors;
  } catch (e) {
    // 같은 오류가 매 주기 반복될 때 로그를 도배하지 않되, 오류의 성격이 바뀌면 반드시 다시 알린다 —
    // 접속 실패로 한 번 경고한 뒤 응답 정합성 오류(개수 불일치 등)로 바뀌면 그게 묻히면 안 된다.
    if (lastWarning !== e.message) {
      lastWarning = e.message;
      console.warn(`[embedding] 임베딩 서버 사용 불가 — LIKE 검색만 사용합니다: ${e.message}`);
    }
    return null;
  }
}
