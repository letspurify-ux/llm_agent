// 로컬 임베딩 클라이언트 — Ollama의 OpenAI 호환 API 사용 (llm-openai.js와 같은 패턴).
//   EMBEDDING_URL   예) http://localhost:11434/v1 (Ollama 기본)
//   EMBEDDING_MODEL 예) bge-m3 (1024차원 — vec_store.embedding 차원과 일치해야 함)
// 실패/미설정 시 null을 반환하고, 호출부는 LIKE 검색만으로 동작한다 (graceful degradation).
let warned = false;

const TIMEOUT_MS = 60_000; // 모델 콜드 로드가 30초+ 걸릴 수 있어 넉넉히. 초과 시 LIKE-only 폴백

export async function embed(texts) {
  const base = process.env.EMBEDDING_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.EMBEDDING_MODEL || 'bge-m3', input: texts }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`embeddings API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.data.map(d => d.embedding);
  } catch (e) {
    if (!warned) {
      warned = true;
      console.warn(`[embedding] 임베딩 서버 사용 불가 — LIKE 검색만 사용합니다: ${e.message}`);
    }
    return null;
  }
}
