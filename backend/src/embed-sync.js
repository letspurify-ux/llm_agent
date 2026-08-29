// 임베딩 diff 동기화 — 기존/신규 행을 구분하지 않는다.
// 매 실행마다 "원본 텍스트의 현재 MD5 ≠ vec_store.embed_hash"인 행만 임베딩하므로
// 신규 INSERT / 내용 UPDATE / 원본 DELETE 가 전부 같은 로직으로 처리된다 (멱등).
// 실행 경로: ① server.js 기동 시 1회  ② EMBED_SYNC_INTERVAL 주기  ③ npm run embed
import 'dotenv/config';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { query, getConnection } from './db.js';
import { embed, EMBEDDING_MODEL } from './embedding.js';
import { SEARCH_COLUMNS } from './search.js';

// 임베딩 원문 — 검색 대상 컬럼(search.js)을 이어붙여 "이 행이 무엇인지"를 표현한다.
// 검색과 같은 정의를 써야 LIKE와 벡터가 서로 다른 내용을 보지 않는다.
const toText = (cols, row) => cols.map(c => row[c] ?? '').join('\n');
const BATCH = 32;

// 중첩 실행 가드 — 초기 대량 동기화(수 분)가 도는 동안 다른 실행이 겹쳐 같은 행을
// 중복 임베딩하는 것을 막는다. 프로세스 내부는 running 플래그로, 프로세스 간(서버 주기
// 동기화 vs npm run embed)은 MariaDB GET_LOCK으로 배타한다. 겹치면 이번 회차는 건너뛴다.
// (락은 커넥션에 귀속되므로 전용 커넥션을 동기화가 끝날 때까지 쥔다. 프로세스가 죽으면
//  커넥션이 닫히며 서버가 락을 자동 해제한다.)
let running = false;
const LOCK_NAME = 'space_voc_embed_sync';

export async function syncEmbeddings() {
  // 임베딩 서버를 쓰지 않는 환경(LIKE-only)에서는 원본 스캔 자체가 무의미하다 —
  // 전 테이블 읽기와 해시 계산을 통째로 건너뛴다 (10k 규모에서 매분 수십 MB 절약)
  if (!process.env.EMBEDDING_URL) return { embedded: 0, deleted: 0, skipped: true };
  if (running) return { embedded: 0, deleted: 0, skipped: false };
  running = true;
  try {
    // 커넥션 획득도 이 try 안에서 한다 — 실패(MariaDB 다운·풀 포화) 시에도 running이 반드시 풀려야
    // 다음 주기에 재시도된다. 밖에 두면 한 번의 실패로 동기화가 재시작 전까지 영구 정지한다.
    const lockConn = await getConnection();
    try {
      const got = (await lockConn.query(`SELECT GET_LOCK('${LOCK_NAME}', 0) AS l`))[0].l;
      if (!Number(got)) return { embedded: 0, deleted: 0, skipped: false };
      try {
        return await doSync();
      } finally {
        await lockConn.query(`SELECT RELEASE_LOCK('${LOCK_NAME}')`).catch(() => {});
      }
    } finally {
      lockConn.release();
    }
  } finally {
    running = false;
  }
}

async function doSync() {
  let embedded = 0, deleted = 0;

  for (const [src, cols] of Object.entries(SEARCH_COLUMNS)) {
    const rows = await query(`SELECT * FROM ${src}`);
    const stored = new Map(
      (await query('SELECT seq, embed_hash FROM vec_store WHERE src = ?', [src])).map(r => [r.seq, r.embed_hash])
    );

    // 해시에 모델명을 포함한다 — EMBEDDING_MODEL을 바꾸면 모든 해시가 불일치해
    // 자동으로 전체 재임베딩된다 (구 모델 벡터와 새 모델 질문 벡터를 섞으면 검색이 무의미해짐)
    const stale = [];
    for (const r of rows) {
      const text = toText(cols, r);
      const hash = crypto.createHash('md5').update(`${EMBEDDING_MODEL}\n${text}`).digest('hex');
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
      // 배치 전체를 한 문장으로 쓴다 — 행마다 왕복하면 초기 1만건 동기화가 1만 번 왕복이 된다
      await query(
        `REPLACE INTO vec_store (src, seq, embed_hash, embedding) VALUES ${batch.map(() => '(?, ?, ?, VEC_FromText(?))').join(', ')}`,
        batch.flatMap((b, j) => [src, b.seq, b.hash, JSON.stringify(vectors[j])])
      );
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
