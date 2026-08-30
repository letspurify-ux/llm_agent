// 임베딩 diff 동기화 — 기존/신규 행을 구분하지 않는다.
// 매 실행마다 "원본 텍스트의 현재 MD5 ≠ vec_store.embed_hash"인 행만 임베딩하므로
// 신규 INSERT / 내용 UPDATE / 원본 DELETE 가 전부 같은 로직으로 처리된다 (멱등).
// 실행 경로: ① server.js 기동 시 1회  ② EMBED_SYNC_INTERVAL 주기  ③ npm run embed
import 'dotenv/config';
import crypto from 'node:crypto';
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { query, getConnection, releaseConnection } from './db.js';
import { embed, EMBEDDING_MODEL, isEmbeddingEnabled, warnEmbeddingFailure } from './embedding.js';
import { SEARCH_COLUMNS } from './search.js';
import { MAX_EMBED_TEXT_LEN, clipText } from './constants.js';

// 임베딩 원문 — 검색 대상 컬럼(search.js)을 이어붙여 "이 행이 무엇인지"를 표현한다.
// 검색과 같은 정의를 써야 LIKE와 벡터가 서로 다른 내용을 보지 않는다.
// 원문 상한을 여기서 적용한다 — 모델 입력 한도를 넘는 행 하나가 배치 전체(32건)를 실패시키는 것을
// 애초에 막는다. 원본 컬럼은 TEXT(최대 64KB)라 등록만으로 한도를 넘길 수 있다.
// 자른 뒤의 텍스트로 해시를 계산하므로(아래 doSync가 toText 결과를 그대로 해싱한다) 멱등성은 유지된다.
const toText = (cols, row) => {
  return clipText(cols.map(c => row[c] ?? '').join('\n'), MAX_EMBED_TEXT_LEN);
};
const BATCH = 32;

// skipped 값 — 호출부(서버 로그, CLI 종료 코드)가 "설정상 안 쓰는 것"과 "쓰려는데 실패한 것"을
// 구분해야 한다. LIKE-only 운영은 정상 구성이므로 실패로 보고하면 안 된다.
export const SKIP = {
  NONE: false,
  BUSY: 'busy',                 // 다른 동기화가 진행 중 (이번 회차만 건너뜀)
  UNCONFIGURED: 'unconfigured', // EMBEDDING_URL 미설정 — LIKE-only 정상 구성
  UNAVAILABLE: 'unavailable',   // 임베딩 서버가 설정돼 있으나 응답하지 않음
};

// 결과 문구는 SKIP 바로 옆에 둔다 — 서버 로그와 CLI가 각자 SKIP 키 맵을 들고 있으면
// 값이 하나 추가될 때 두 곳을 손으로 맞춰야 하고, 한쪽만 고치면 그 실행 경로에서만 안내가 사라진다.
// (SKIP을 상수로 모은 이유가 '설정상 안 쓰는 것'과 '쓰려는데 실패한 것'을 호출부가 구분하게 하려는
//  것인데, 구분해서 보여줄 문구가 호출부마다 흩어져 있으면 그 목적이 반만 달성된다.)
const SKIP_NOTE = {
  [SKIP.BUSY]: '다른 동기화가 진행 중이라 건너뛰었습니다',
  [SKIP.UNCONFIGURED]: 'EMBEDDING_URL 미설정 — LIKE-only 구성이라 임베딩을 생략합니다',
  [SKIP.UNAVAILABLE]: '임베딩 서버에 연결하지 못해 일부를 건너뛰었습니다 — LIKE-only로 계속합니다',
};

// 건너뛴 행은 원본을 고치기 전까지 매 주기 다시 실패하므로 반드시 눈에 띄어야 한다
// (0건이면 문구를 붙이지 않아 평소 로그는 조용하다).
export function syncSummary(r) {
  const failed = r.failed ? `, 건너뜀 ${r.failed}건(원본 확인 필요)` : '';
  const note = SKIP_NOTE[r.skipped];
  return `생성/갱신 ${r.embedded}건, 정리 ${r.deleted}건${failed}${note ? ` — ${note}` : ''}`;
}

// 중첩 실행 가드 — 초기 대량 동기화(수 분)가 도는 동안 다른 실행이 겹쳐 같은 행을
// 중복 임베딩하는 것을 막는다. 프로세스 내부는 running 플래그로, 프로세스 간(서버 주기
// 동기화 vs npm run embed)은 MariaDB GET_LOCK으로 배타한다. 겹치면 이번 회차는 건너뛴다.
// (락은 커넥션에 귀속되므로 전용 커넥션을 동기화가 끝날 때까지 쥔다. 프로세스가 죽으면
//  커넥션이 닫히며 서버가 락을 자동 해제한다.)
let running = false;
const LOCK_NAME = 'space_voc_embed_sync';

export async function syncEmbeddings() {
  if (running) return { embedded: 0, deleted: 0, failed: 0, skipped: SKIP.BUSY };
  running = true;
  try {
    // 커넥션 획득도 이 try 안에서 한다 — 실패(MariaDB 다운·풀 포화) 시에도 running이 반드시 풀려야
    // 다음 주기에 재시도된다. 밖에 두면 한 번의 실패로 동기화가 재시작 전까지 영구 정지한다.
    const lockConn = await getConnection();
    try {
      const got = (await lockConn.query(`SELECT GET_LOCK('${LOCK_NAME}', 0) AS l`))[0].l;
      if (!Number(got)) return { embedded: 0, deleted: 0, failed: 0, skipped: SKIP.BUSY };
      return await doSync();
    } finally {
      // 쥐지 않은 락에 대한 RELEASE_LOCK은 0을 돌려주는 무해한 no-op이라 락 해제와 커넥션 반납을
      // 한 단계에서 처리할 수 있다 (자원 수명이 같은데 블록만 나뉘면 다음 수정이 엉뚱한 곳에 붙는다).
      await lockConn.query(`SELECT RELEASE_LOCK('${LOCK_NAME}')`).catch(() => {});
      // 반납은 db.js와 같은 함수로 한다 — 기다리지 않으면 아직 풀로 돌아가지 않은 커넥션을
      // 반납된 것으로 세어 connectionLimit을 잠시 넘겨 쓰고, 실패하면 잡는 곳이 없어 샌다.
      // 풀을 쓰는 쪽과 직접 쥐는 쪽이 반납 규칙을 따로 갖고 있으면 한쪽만 조용히 어긋난다.
      await releaseConnection(lockConn);
    }
  } finally {
    running = false;
  }
}

async function doSync() {
  // 임베딩을 쓰지 않는 환경(LIKE-only)에서는 본문 읽기와 해시 계산을 건너뛴다.
  // 단, 원본이 삭제된 vec_store 행 정리는 이 함수에만 있으므로 그 경로는 계속 태운다 —
  // 건너뛰면 삭제된 지식의 벡터가 남아, 임베딩을 다시 켤 때까지 검색에 노출된다.
  const enabled = isEmbeddingEnabled();
  let embedded = 0, deleted = 0, failed = 0, skipped = enabled ? SKIP.NONE : SKIP.UNCONFIGURED;
  // 임베딩 서버가 도중에 끊기면 임베딩만 멈추고 루프는 끝까지 돈다.
  // 여기서 return하면 뒤쪽 테이블의 고아 벡터 정리가 통째로 빠지는데, 그 정리는 이 함수에만 있어
  // 삭제된 qa_method/query_registry의 벡터가 다음 성공 동기화까지 검색에 남는다.
  let unavailable = false;

  for (const [src, cols] of Object.entries(SEARCH_COLUMNS)) {
    // 필요한 컬럼만 읽는다 — query_registry의 query_sql처럼 임베딩에 쓰지 않는 대형 TEXT를
    // 매 주기(기본 60초) 전송하지 않도록. cols는 코드가 정의한 식별자다(외부 입력 아님).
    // 임베딩 서버가 이미 끊긴 뒤라면 본문도 읽지 않는다 — 어차피 임베딩하지 않을 텍스트를
    // 실어 나르고 해시까지 계산해 버리는 일이 서버가 죽어 있는 내내 매 주기 반복된다.
    const readContent = enabled && !unavailable;
    const rows = await query(`SELECT seq${readContent ? `, ${cols.join(', ')}` : ''} FROM ${src}`);
    const stored = new Map(
      (await query('SELECT seq, embed_hash FROM vec_store WHERE src = ?', [src])).map(r => [r.seq, r.embed_hash])
    );

    // 해시에 모델명을 포함한다 — EMBEDDING_MODEL을 바꾸면 모든 해시가 불일치해
    // 자동으로 전체 재임베딩된다 (구 모델 벡터와 새 모델 질문 벡터를 섞으면 검색이 무의미해짐)
    const stale = [];
    for (const r of rows) {
      if (readContent) {
        const text = toText(cols, r);
        const hash = crypto.createHash('md5').update(`${EMBEDDING_MODEL}\n${text}`).digest('hex');
        if (stored.get(r.seq) !== hash) stale.push({ seq: r.seq, text, hash });
      }
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
      let vectors;
      try {
        vectors = await embed(batch.map(b => b.text));
      } catch (e) {
        warnEmbeddingFailure(e);
        // 서버에 닿지 못한 것이면 이번 회차는 여기서 접는다 (다음 주기에 그대로 재시도된다).
        if (e.retriable) { unavailable = true; break; }
        // 서버는 살아 있고 이 입력을 거부했다. 배치를 통째로 포기하면 성한 31건이 매 주기 되풀이되고,
        // 뒤쪽 테이블은 아예 건너뛰게 된다 — 문제 행 하나가 전체 동기화를 영구히 멈춰 세우는 셈이다.
        // storeBatch가 저장 실패에 쓰는 것과 같은 방식으로 행을 갈라 성한 행만 진도를 낸다.
        const r = await embedRows(src, batch);
        embedded += r.embedded;
        failed += r.failed;
        if (r.unavailable) { unavailable = true; break; }
        continue;
      }
      embedded += await storeBatch(src, batch, vectors);
    }
  }
  return { embedded, deleted, failed, skipped: unavailable ? SKIP.UNAVAILABLE : skipped };
}

// 내용 때문에 거부된 배치를 행 단위로 갈라 성한 행만 저장한다.
// 도중에 서버가 죽으면(retriable) 남은 행을 붙잡지 않고 즉시 물러난다 —
// 죽은 서버에 행마다 매달리면 회차 하나가 임베딩 타임아웃(60초) × 행 수만큼 늘어진다.
async function embedRows(src, batch) {
  let embedded = 0, failed = 0;
  for (const b of batch) {
    try {
      embedded += await storeBatch(src, [b], await embed([b.text]));
    } catch (e) {
      warnEmbeddingFailure(e);
      if (e.retriable) return { embedded, failed, unavailable: true };
      failed++;
      // 이 행은 이번에도 다음에도 같은 이유로 거부된다 — 해시가 갱신되지 않아 매 주기 재시도되므로
      // 원본을 고치기 전까지 계속 남는다. 조용히 빠지지 않도록 seq를 찍는다.
      console.warn(`[embed] ${src}#${b.seq} 임베딩 실패 — 이 행만 건너뜁니다: ${e.message}`);
    }
  }
  return { embedded, failed, unavailable: false };
}

// 배치 전체를 한 문장으로 쓴다 — 행마다 왕복하면 초기 1만건 동기화가 1만 번 왕복이 된다.
// 다만 한 문장은 전부 아니면 전무라, 행 하나가 문제(차원 불일치 등)면 정상인 31건까지 매 주기
// 다시 임베딩되고 버려진다. 실패하면 행 단위로 한 번 더 시도해 성한 행은 진도를 나가게 한다.
async function storeBatch(src, batch, vectors) {
  try {
    await query(
      `REPLACE INTO vec_store (src, seq, embed_hash, embedding) VALUES ${batch.map(() => '(?, ?, ?, VEC_FromText(?))').join(', ')}`,
      batch.flatMap((b, j) => [src, b.seq, b.hash, JSON.stringify(vectors[j])])
    );
    return batch.length;
  } catch (e) {
    console.warn(`[embed] ${src} 배치 저장 실패 — 행 단위로 재시도합니다: ${e.message}`);
    let ok = 0;
    for (const [j, b] of batch.entries()) {
      try {
        await query(
          'REPLACE INTO vec_store (src, seq, embed_hash, embedding) VALUES (?, ?, ?, VEC_FromText(?))',
          [src, b.seq, b.hash, JSON.stringify(vectors[j])]
        );
        ok++;
      } catch (e2) {
        console.warn(`[embed] ${src}#${b.seq} 저장 실패: ${e2.message}`);
      }
    }
    return ok;
  }
}

// CLI: npm run embed
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const t = Date.now();
  const r = await syncEmbeddings();
  // stdout이 파이프(tee, CI 로그, docker build 등)면 console.log는 비동기라 아래 process.exit에
  // 잘려 나간다 — 이 명령의 존재 이유가 프로비저닝 스크립트에 결과를 알리는 것이므로 동기로 쓴다.
  // try/catch는 필수다: 논블로킹 파이프에서 writeSync는 EAGAIN을 던지는데, 그게 새어 나가면
  // 아래 process.exit가 실행되지 않아 성공한 동기화가 0이 아닌 종료 코드로 보고된다.
  // (server.js의 uncaughtException 핸들러가 같은 이유로 같은 형태를 쓴다)
  const summary = `임베딩 동기화 완료: ${syncSummary(r)}, ${((Date.now() - t) / 1000).toFixed(1)}s\n`;
  try { writeSync(1, summary); } catch { /* 로그 실패가 종료 코드를 바꾸지 않게 */ }
  // 실패로 종료하는 것은 "쓰려고 했는데 안 된" 경우뿐이다 — LIKE-only는 지원되는 구성이므로
  // 프로비저닝 스크립트가 이 명령의 종료 코드로 실패 판정을 하면 안 된다.
  process.exit(r.skipped === SKIP.UNAVAILABLE ? 1 : 0);
}
