// 임베딩 diff 동기화 — 기존/신규 행을 구분하지 않는다.
// 매 실행마다 "원본 텍스트의 현재 MD5 ≠ vec_store.embed_hash"인 행만 임베딩하므로
// 신규 INSERT / 내용 UPDATE / 원본 DELETE 가 전부 같은 로직으로 처리된다 (멱등).
// 실행 경로: ① server.js 기동 시 1회  ② EMBED_SYNC_INTERVAL 주기  ③ npm run embed
import 'dotenv/config';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { query } from './db.js';
import { embed } from './embedding.js';

// 테이블별 임베딩 원문 — 요약(제목/용도)과 본문을 합쳐 "이 행이 무엇인지"를 표현한다
const SOURCES = {
  knowledge: r => `${r.title}\n${r.content}`,
  qa_method: r => `${r.title}\n${r.method}`,
  query_registry: r => `${r.query_name}\n${r.query_desc ?? ''}\n${r.input_desc ?? ''}\n${r.output_desc ?? ''}`,
};
const BATCH = 32;

// 중첩 실행 가드 — 초기 대량 동기화(수 분)가 도는 동안 주기 실행이 겹쳐
// 같은 행을 중복 임베딩하는 것을 막는다. 겹치면 이번 회차는 건너뛴다.
let running = false;

export async function syncEmbeddings() {
  if (running) return { embedded: 0, deleted: 0, skipped: false };
  running = true;
  try {
    return await doSync();
  } finally {
    running = false;
  }
}

async function doSync() {
  let embedded = 0, deleted = 0;

  for (const [src, toText] of Object.entries(SOURCES)) {
    const rows = await query(`SELECT * FROM ${src}`);
    const stored = new Map(
      (await query('SELECT seq, embed_hash FROM vec_store WHERE src = ?', [src])).map(r => [r.seq, r.embed_hash])
    );

    const stale = [];
    for (const r of rows) {
      const text = toText(r);
      const hash = crypto.createHash('md5').update(text).digest('hex');
      if (stored.get(r.seq) !== hash) stale.push({ seq: r.seq, text, hash });
      stored.delete(r.seq);
    }

    // 원본이 삭제된 행 정리 (stored에 남은 것 = 원본 없음)
    if (stored.size) {
      await query(
        `DELETE FROM vec_store WHERE src = ? AND seq IN (${[...stored.keys()].map(() => '?').join(',')})`,
        [src, ...stored.keys()]
      );
      deleted += stored.size;
    }

    for (let i = 0; i < stale.length; i += BATCH) {
      const batch = stale.slice(i, i + BATCH);
      const vectors = await embed(batch.map(b => b.text));
      if (!vectors) return { embedded, deleted, skipped: true }; // 임베딩 서버 없음 — 다음 주기에 재시도
      for (let j = 0; j < batch.length; j++) {
        await query(
          'REPLACE INTO vec_store (src, seq, embed_hash, embedding) VALUES (?, ?, ?, VEC_FromText(?))',
          [src, batch[j].seq, batch[j].hash, JSON.stringify(vectors[j])]
        );
      }
      embedded += batch.length;
    }
  }
  return { embedded, deleted, skipped: false };
}

// CLI: npm run embed
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const t = Date.now();
  const r = await syncEmbeddings();
  console.log(
    `임베딩 동기화 완료: 생성/갱신 ${r.embedded}건, 정리 ${r.deleted}건, ${((Date.now() - t) / 1000).toFixed(1)}s` +
    (r.skipped ? ' — 임베딩 서버에 연결하지 못해 일부를 건너뛰었습니다' : '')
  );
  process.exit(r.skipped ? 1 : 0);
}
