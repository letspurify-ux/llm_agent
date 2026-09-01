// 로컬 임베딩 클라이언트 — Ollama의 OpenAI 호환 API 사용 (llm-openai.js와 같은 패턴).
//   EMBEDDING_URL   예) http://localhost:11434/v1 (Ollama 기본)
//   EMBEDDING_MODEL 예) bge-m3 (1024차원 — vec_store.embedding 차원과 일치해야 함)
// 실패 시 EmbeddingError를 던진다 — 호출부가 '재시도할 실패'와 '입력이 거부된 실패'를 구분해야 하기 때문이다.
// 미설정(LIKE-only)은 실패가 아니므로 호출부가 isEmbeddingEnabled()로 먼저 갈라낸다.
// 모델명은 embed-sync의 embed_hash에도 들어간다(모델 교체 시 자동 재임베딩) — 한 곳에서만 정의한다
import { warnOnce } from './constants.js';

export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'bge-m3';

// 임베딩 서버 사용 여부의 단일 판단 지점 — 호출부가 EMBEDDING_URL을 직접 읽어 같은 판단을
// 재구성하면, 여기 설정 경로가 바뀔 때 호출부만 조용히 어긋난다.
export const isEmbeddingEnabled = () => Boolean(process.env.EMBEDDING_URL);

const TIMEOUT_MS = 60_000; // 모델 콜드 로드가 30초+ 걸릴 수 있어 넉넉히. 초과 시 LIKE-only 폴백

// 임베딩 실패는 성격이 둘로 갈리고, 호출부가 해야 할 일이 정반대다 —
// null 하나로 뭉개면 embed-sync가 둘을 구분하지 못해, 입력 한 건이 거부된 것을
// '서버가 죽었다'로 읽고 남은 테이블의 동기화를 통째로 포기한다.
//   retriable=true  서버에 닿지 못했거나 서버가 5xx/429로 실패했다 — 같은 입력으로 다음 주기에 재시도하면 된다.
//   retriable=false 서버는 살아 있고 이 입력을 거부했다 — 재시도해도 결과가 같으므로 호출부가 문제 행을 갈라내야 한다.
export class EmbeddingError extends Error {
  constructor(message, retriable) {
    super(message);
    this.name = 'EmbeddingError';
    this.retriable = retriable;
  }
}

// 같은 오류가 매 주기 반복될 때 로그를 도배하지 않되, 오류의 성격이 바뀌면 반드시 다시 알린다 —
// 접속 실패로 한 번 경고한 뒤 응답 정합성 오류(개수 불일치 등)로 바뀌면 그게 묻히면 안 된다.
// embed()가 던지게 되면서 경고 시점이 호출부로 옮겨졌으므로, 이름은 여기 남기고
// 억제 방식은 constants.js의 warnOnce 하나로 모은다 (벡터 검색·NLS 포맷도 같은 것을 쓴다).
export function warnEmbeddingFailure(e) {
  warnOnce('embedding', `embedding call failed: ${e.message}`);
}

// 성공하면 texts와 같은 길이·순서의 벡터 배열, 실패하면 EmbeddingError를 던진다.
//
// signal(선택)은 호출부가 이 호출을 '먼저 끊을' 수 있는 통로다. 정상 종료가 그것을 쓴다:
// 타임아웃만 있으면 종료 시각과 무관하게 최대 60초를 더 기다려야 하는데, 그동안 embed-sync가
// GET_LOCK 전용 커넥션을 쥐고 있어 closePool()이 끝나지 않고 종료가 강제 타이머로 밀린다
// (server.js shutdown, embed-sync requestSyncStop 주석).
// AbortSignal.any는 Node 20.3+에만 있어 쓰지 않는다 — 이 저장소는 engines 제약이 없어
// Node 18에서도 뜨고, 거기서는 그 한 줄이 모든 임베딩을 TypeError로 죽인다.
export async function embed(texts, signal) {
  const base = process.env.EMBEDDING_URL;
  if (!base) throw new EmbeddingError('EMBEDDING_URL이 설정되지 않았습니다', false);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      // 5xx·429는 서버 사정이라 재시도 가치가 있고, 4xx는 이 입력을 거부한 것이라 없다.
      const retriable = res.status >= 500 || res.status === 429;
      throw new EmbeddingError(`embeddings API ${res.status}: ${(await res.text()).slice(0, 200)}`, retriable);
    }
    const data = await res.json();
    // 응답 항목에 index가 있는 이유가 순서를 보장하지 않기 때문이다 (vLLM/TEI의 continuous batching은
    // 실제로 순서를 바꾼다). 위치로 짝지으면 텍스트와 벡터가 어긋난 채 올바른 해시와 함께 저장돼
    // 이후 동기화가 영영 고치지 못한다 — 반드시 index로 정렬하고 개수도 확인한다.
    const items = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    // 응답 정합성 문제는 같은 입력을 다시 보내도 같은 결과다 — 재시도 대상이 아니다.
    if (items.length !== texts.length) {
      throw new EmbeddingError(`임베딩 응답 개수 불일치: 요청 ${texts.length}건, 응답 ${items.length}건`, false);
    }
    const vectors = items.map(d => d.embedding);
    if (vectors.some(v => !Array.isArray(v) || v.length === 0)) {
      throw new EmbeddingError('임베딩 응답에 유효하지 않은 벡터가 포함되어 있습니다', false);
    }
    return vectors;
  } catch (e) {
    if (e instanceof EmbeddingError) throw e;
    // fetch 자체가 던진 것 — 접속 실패·타임아웃·중단. 서버에 닿지 못했으므로 재시도 대상이다.
    throw new EmbeddingError(e.message, true);
  } finally {
    // 타이머와 리스너를 반드시 건다 — 남겨두면 타이머가 이벤트 루프를 붙잡아 CLI(npm run embed)의
    // 종료가 최대 60초 늦어지고, 리스너는 signal이 살아 있는 동안 호출 수만큼 쌓인다.
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
