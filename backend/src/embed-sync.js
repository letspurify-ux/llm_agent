// 임베딩 diff 동기화 — 기존/신규 행을 구분하지 않는다.
// 매 실행마다 "원본 텍스트의 현재 MD5 ≠ vec_store.embed_hash"인 행만 임베딩하므로
// 신규 INSERT / 내용 UPDATE / 원본 DELETE 가 전부 같은 로직으로 처리된다 (멱등).
// 해시는 MariaDB가 계산한다(hashExpr) — 본문은 불일치한 행만 읽는다.
// 기존(JS 계산) 해시와 바이트 단위로 호환된다: 양쪽 다 MD5(모델명 + '\n' + 컬럼들을 '\n'으로
// 연결한 원문)이라 기존 설치에서 재임베딩이 일어나지 않는다. 예외는 MAX_EMBED_TEXT_LEN을 넘는
// 행뿐이다(예전엔 자른 뒤 해싱, 지금은 원문 전체 해싱) — 그 행만 1회 재임베딩되고 안정된다.
// 실행 경로: ① server.js 기동 시 1회  ② EMBED_SYNC_INTERVAL 주기  ③ npm run embed
import 'dotenv/config';
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { query, getConnection, releaseConnection, closePool } from './db.js';
import { embed, EMBEDDING_MODEL, isEmbeddingEnabled, warnEmbeddingFailure } from './embedding.js';
import { SEARCH_COLUMNS } from './search.js';
import { MAX_EMBED_TEXT_LEN, clipText } from './constants.js';

// 임베딩 원문 — 검색 대상 컬럼(search.js)을 이어붙여 "이 행이 무엇인지"를 표현한다.
// 검색과 같은 정의를 써야 LIKE와 벡터가 서로 다른 내용을 보지 않는다.
// 원문 상한을 여기서 적용한다 — 모델 입력 한도를 넘는 행 하나가 배치 전체(32건)를 실패시키는 것을
// 애초에 막는다. 원본 컬럼은 TEXT(최대 64KB)라 등록만으로 한도를 넘길 수 있다.
// 변경 감지 해시는 자르기 전의 원문 전체로 DB가 계산한다(hashExpr) — 상한 밖(4000자 이후)만 바뀐
// 수정도 재임베딩이 한 번 돌지만 결과 벡터는 같고, 해시가 갱신되므로 반복되지는 않는다.
const toText = (cols, row) => {
  return clipText(cols.map(c => row[c] ?? '').join('\n'), MAX_EMBED_TEXT_LEN);
};
const BATCH = 32;

// IN 절 상한 — 쿼리 하나에 싣는 플레이스홀더 수. 수만 건을 한 문장에 담으면 커넥터가
// 클라이언트에서 확장한 쿼리 문자열이 max_allowed_packet을 넘어 그 문장이 매 주기 실패한다 —
// 고아 정리가 그 상태에 빠지면 삭제된 지식이 검색에 계속 노출되는, 이 경로가 막으려던 바로 그
// 결과가 영구화된다 (storeBatch가 INSERT를 BATCH 단위로 나누는 것과 같은 이유·같은 방식).
const IN_CHUNK = 1000;

const chunked = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// 변경 감지 해시는 MariaDB가 계산한다 — 원문 전송 없이 행당 seq + 해시 32자만 받는다.
// JS로 해시하려면 매 주기(기본 60초) 세 테이블의 본문 전체(TEXT 최대 64KB × 전 행)를 실어 날라야
// 하는데, stale 집합은 거의 항상 비어 있다 — 1만 행 규모면 분당 수백 MB가 순수 낭비다.
// 모델명을 맨 앞에 붙여, EMBEDDING_MODEL 변경 시 전체 해시가 불일치 → 자동 전체 재임베딩되는
// 성질(아래 doSync 주석)은 그대로 유지한다.
// CONCAT_WS는 NULL 인자를 건너뛴다 — COALESCE로 빈 문자열을 고정하지 않으면 NULL 컬럼 유무에
// 따라 구분자 수가 달라져 같은 내용이 다른 해시가 된다. 구분자는 CHAR(10)으로 박는다
// (리터럴 '\n'은 서버의 NO_BACKSLASH_ESCAPES 설정에 따라 뜻이 바뀐다).
const hashExpr = cols =>
  `MD5(CONCAT_WS(CHAR(10), ?, ${cols.map(c => `COALESCE(${c}, '')`).join(', ')}))`;

// skipped 값 — 호출부(서버 로그, CLI 종료 코드)가 "설정상 안 쓰는 것"과 "쓰려는데 실패한 것"을
// 구분해야 한다. LIKE-only 운영은 정상 구성이므로 실패로 보고하면 안 된다.
export const SKIP = {
  NONE: false,
  BUSY: 'busy',                 // 다른 동기화가 진행 중 (이번 회차만 건너뜀)
  UNCONFIGURED: 'unconfigured', // EMBEDDING_URL 미설정 — LIKE-only 정상 구성
  UNAVAILABLE: 'unavailable',   // 임베딩 서버가 설정돼 있으나 응답하지 않음
  STOPPED: 'stopped',           // 정상 종료 요청으로 도중에 접음 (다음 실행이 이어받는다)
};

// 결과 문구는 SKIP 바로 옆에 둔다 — 서버 로그와 CLI가 각자 SKIP 키 맵을 들고 있으면
// 값이 하나 추가될 때 두 곳을 손으로 맞춰야 하고, 한쪽만 고치면 그 실행 경로에서만 안내가 사라진다.
// (SKIP을 상수로 모은 이유가 '설정상 안 쓰는 것'과 '쓰려는데 실패한 것'을 호출부가 구분하게 하려는
//  것인데, 구분해서 보여줄 문구가 호출부마다 흩어져 있으면 그 목적이 반만 달성된다.)
const SKIP_NOTE = {
  [SKIP.BUSY]: 'skipped — another sync is already in progress',
  [SKIP.UNCONFIGURED]: 'EMBEDDING_URL not set — LIKE-only setup, embedding skipped',
  [SKIP.UNAVAILABLE]: 'could not reach the embedding server — some rows skipped, continuing LIKE-only',
  [SKIP.STOPPED]: 'stopped early for shutdown — the remaining rows are picked up on the next run',
};

// 건너뛴 행은 사람이 원인을 없애기 전까지 매 주기 다시 실패하므로 반드시 눈에 띄어야 한다
// (0건이면 문구를 붙이지 않아 평소 로그는 조용하다).
// 원인을 단정하지 않고 행별 경고로 넘긴다 — failed에는 성격이 다른 둘이 함께 들어온다:
// 임베딩 서버가 그 입력을 거부한 것(원본 행 문제)과 벡터를 저장하지 못한 것(차원 불일치·
// vec_store 권한/스키마 문제)이다. 한쪽을 지목하는 문구('원본 행을 확인하라')를 쓰면 나머지
// 절반에서 운영자를 엉뚱한 곳으로 보낸다. 행별 경고는 src#seq와 원문 오류를 그대로 찍으므로
// 그쪽이 정확하다 (embedRows / storeBatch의 console.warn).
export function syncSummary(r) {
  const failed = r.failed ? `, skipped ${r.failed} (see the [embed] row warnings)` : '';
  const note = SKIP_NOTE[r.skipped];
  return `created/updated ${r.embedded}, cleaned up ${r.deleted}${failed}${note ? ` — ${note}` : ''}`;
}

// 중첩 실행 가드 — 초기 대량 동기화(수 분)가 도는 동안 다른 실행이 겹쳐 같은 행을
// 중복 임베딩하는 것을 막는다. 프로세스 내부는 running 플래그로, 프로세스 간(서버 주기
// 동기화 vs npm run embed)은 MariaDB GET_LOCK으로 배타한다. 겹치면 이번 회차는 건너뛴다.
// (락은 커넥션에 귀속되므로 전용 커넥션을 동기화가 끝날 때까지 쥔다. 프로세스가 죽으면
//  커넥션이 닫히며 서버가 락을 자동 해제한다.)
let running = false;
const LOCK_NAME = 'space_voc_embed_sync';

// 정상 종료 신호. 초기 대량 동기화는 수 분이 걸릴 수 있고, 그동안 GET_LOCK 전용 커넥션을 계속
// 쥐고 있다 — 종료 경로가 이 작업을 '기다리기만' 하면 closePool()의 pool.end()가 커넥션 반납을
// 기다리다 10초 강제 타이머에 걸려, 정상 재배포가 매번 종료 코드 1로 기록된다(server.js shutdown).
// 그래서 기다리기 전에 접으라고 알린다. 접는 지점이 둘이어야 한다:
//   ① 테이블·배치 경계의 플래그 확인 — 동기화는 해시 비교 기반이라 어디서 멈춰도 멱등하고,
//      남은 행은 다음 실행이 그대로 이어받는다.
//   ② 진행 중인 embed() 호출의 중단(AbortController) — 경계 확인만 두면 SIGTERM이 호출 도중에
//      닿았을 때 그 호출의 자체 타임아웃(60초)까지 기다려야 하고, 그동안 락 커넥션을 쥔 채라
//      종료가 그대로 강제 타이머로 밀린다. 임베딩 서버가 응답하지 않는 상태가 정확히 그 경우다.
// 신호는 프로세스 수명 동안 한 번만 켜진다(되돌리지 않는다) — 켜졌다는 것은 종료 중이라는 뜻이다.
// 요청 경로의 임베딩(search.js)에는 이 신호를 주지 않는다: 처리 중인 질문은 server.close()가
// 끝까지 기다리므로, 그쪽 호출까지 끊으면 아직 응답하지 않은 요청의 검색이 무너진다.
let stopRequested = false;
const stopSignal = new AbortController();

export function requestSyncStop() {
  stopRequested = true;
  stopSignal.abort();
}

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
  let stopped = false;

  for (const [src, cols] of Object.entries(SEARCH_COLUMNS)) {
    // 종료 중이면 다음 테이블로 넘어가지 않는다 — 해시 스캔 한 번이 전 행을 훑는 작업이다.
    if (stopRequested) { stopped = true; break; }
    // 임베딩 서버가 이미 끊긴 뒤라면 해시 스캔도 걸지 않는다 — 어차피 임베딩하지 않을 변경분을
    // 찾느라 DB가 매 주기 전 행을 해싱하는 일이 서버가 죽어 있는 내내 반복된다.
    const checkContent = enabled && !unavailable;
    // 해시는 DB에서 계산해 seq+해시만 받는다 (hashExpr 주석 참고). cols는 코드가 정의한 식별자다(외부 입력 아님).
    // 해시에 모델명을 포함한다 — EMBEDDING_MODEL을 바꾸면 모든 해시가 불일치해
    // 자동으로 전체 재임베딩된다 (구 모델 벡터와 새 모델 질문 벡터를 섞으면 검색이 무의미해짐)
    const rows = checkContent
      ? await query(`SELECT seq, ${hashExpr(cols)} AS h FROM ${src}`, [EMBEDDING_MODEL])
      : await query(`SELECT seq FROM ${src}`);
    const stored = new Map(
      (await query('SELECT seq, embed_hash FROM vec_store WHERE src = ?', [src])).map(r => [r.seq, r.embed_hash])
    );

    const staleHash = new Map(); // seq → 새 해시. 본문은 아래에서 불일치한 행만 읽는다.
    for (const r of rows) {
      if (checkContent && stored.get(r.seq) !== r.h) staleHash.set(r.seq, r.h);
      stored.delete(r.seq);
    }

    // 원본이 삭제된 행 정리 (stored에 남은 것 = 원본 없음). IN 절은 상한 단위로 나눈다 —
    // 대량 삭제 직후 수만 개의 플레이스홀더가 한 문장에 실리면 정리가 매 주기 실패한다 (IN_CHUNK 주석).
    for (const seqs of chunked([...stored.keys()], IN_CHUNK)) {
      const r = await query(
        `DELETE FROM vec_store WHERE src = ? AND seq IN (${seqs.map(() => '?').join(',')})`,
        [src, ...seqs]
      );
      // 지우려 한 수(seqs.length)가 아니라 실제로 지워진 수를 센다 — 다른 프로세스(락을 방금 놓은
      // 동시 `npm run embed`, 수동 정리)가 이미 지웠으면 0행인데도 요약은 정리했다고 보고한다.
      // 요약의 존재 이유가 '진짜 고아 정리'와 '아무 일도 없던 주기'를 운영자가 구분하는 것이다.
      deleted += Number(r?.affectedRows ?? 0);
    }

    // 변경된 행만 본문을 읽는다. 해시 스캔과 이 읽기 사이에 원본이 또 바뀌면 새 본문을 임베딩하면서
    // 스캔 시점 해시를 저장하게 되는데, 다음 주기에 불일치로 다시 잡혀 한 번 더 임베딩될 뿐이다(자가 치유).
    // 그 사이 삭제된 행은 여기서 빠지고, vec_store에 남은 벡터는 다음 주기의 고아 정리가 거둔다.
    //
    // 읽은 덩어리를 바로 임베딩한다 — 테이블 전체를 배열 하나에 모아두고 시작하면 메모리 최고점이
    // BATCH가 아니라 '테이블 크기'에 비례한다. 첫 동기화나 EMBEDDING_MODEL 변경(설계상 전 행의
    // 해시가 불일치한다) 뒤가 정확히 그 경우로, 5만 행 × MAX_EMBED_TEXT_LEN이면 수백 MB를
    // 동기화가 끝날 때까지(수 분) 쥐고 있게 된다 — 그동안 GET_LOCK 커넥션도 함께 잡고 있다.
    // 읽기는 이미 IN_CHUNK 단위로 나뉘어 있었으므로, 그 덩어리를 그대로 넘기면 최고점이 IN_CHUNK로 묶인다.
    for (const seqs of chunked([...staleHash.keys()], IN_CHUNK)) {
      const contentRows = await query(
        `SELECT seq, ${cols.join(', ')} FROM ${src} WHERE seq IN (${seqs.map(() => '?').join(',')})`,
        seqs
      );
      const stale = contentRows.map(r => ({ seq: r.seq, text: toText(cols, r), hash: staleHash.get(r.seq) }));
      const r = await embedStale(src, stale);
      embedded += r.embedded;
      failed += r.failed;
      // 임베딩 서버가 죽었거나 종료 요청이 들어왔으면 이 테이블의 남은 덩어리는 읽지 않는다.
      // (테이블 루프는 계속 돈다 — 뒤쪽 테이블의 고아 벡터 정리는 이 함수에만 있다)
      if (r.unavailable) { unavailable = true; break; }
      if (r.stopped) { stopped = true; break; }
    }
  }
  return { embedded, deleted, failed, skipped: stopped ? SKIP.STOPPED : unavailable ? SKIP.UNAVAILABLE : skipped };
}

// 본문을 읽어온 행들을 BATCH 단위로 임베딩·저장한다.
// 반환의 unavailable/stopped는 '남은 행을 두고 물러났다'는 뜻이다 — 호출부가 이 둘을 받아
// 적지 않으면 도중에 접은 회차가 정상 완료와 구분되지 않는다 (doSync의 SKIP 판정).
async function embedStale(src, stale) {
  let embedded = 0, failed = 0;
  const left = (unavailable, stopped) => ({ embedded, failed, unavailable, stopped });
  for (let i = 0; i < stale.length; i += BATCH) {
    // 배치 경계에서 접는다 — 해시가 갱신되지 않은 행은 다음 실행에서 그대로 다시 잡힌다(멱등).
    if (stopRequested) return left(false, true);
    const batch = stale.slice(i, i + BATCH);
    let vectors;
    try {
      vectors = await embed(batch.map(b => b.text), stopSignal.signal);
    } catch (e) {
      // 종료 신호로 끊긴 호출은 실패가 아니다 — 경고를 남기면 정상 재배포마다
      // '임베딩 서버에 닿지 못했다'는 오해를 부르는 줄이 로그에 쌓인다.
      if (stopRequested) return left(false, true);
      warnEmbeddingFailure(e);
      // 서버에 닿지 못한 것이면 이번 회차는 여기서 접는다 (다음 주기에 그대로 재시도된다).
      if (e.retriable) return left(true, false);
      // 서버는 살아 있고 이 입력을 거부했다. 배치를 통째로 포기하면 성한 31건이 매 주기 되풀이되고,
      // 뒤쪽 테이블은 아예 건너뛰게 된다 — 문제 행 하나가 전체 동기화를 영구히 멈춰 세우는 셈이다.
      // storeBatch가 저장 실패에 쓰는 것과 같은 방식으로 행을 갈라 성한 행만 진도를 낸다.
      const r = await embedRows(src, batch);
      embedded += r.embedded;
      failed += r.failed;
      if (r.unavailable || r.stopped) return left(r.unavailable, r.stopped);
      continue;
    }
    const r = await storeBatch(src, batch, vectors);
    embedded += r.stored;
    failed += r.failed;
  }
  return left(false, false);
}

// 내용 때문에 거부된 배치를 행 단위로 갈라 성한 행만 저장한다.
// 도중에 서버가 죽으면(retriable) 남은 행을 붙잡지 않고 즉시 물러난다 —
// 죽은 서버에 행마다 매달리면 회차 하나가 임베딩 타임아웃(60초) × 행 수만큼 늘어진다.
// 접고 물러날 때는 그 사실을 반드시 돌려준다(stopped). break로 조용히 빠져나오면 호출부는
// '이 배치를 끝까지 처리했다'와 구분하지 못한다 — 마지막 테이블의 마지막 배치에서 종료 신호를
// 받은 회차가 정상 완료로 보고되어(SKIP.STOPPED 없음), 남겨둔 행이 있다는 사실이 로그에서
// 통째로 사라진다. SKIP.STOPPED가 존재하는 유일한 이유가 그 구분이다.
async function embedRows(src, batch) {
  let embedded = 0, failed = 0;
  const left = (unavailable, stopped) => ({ embedded, failed, unavailable, stopped });
  for (const b of batch) {
    if (stopRequested) return left(false, true);   // 종료 중에는 남은 행을 붙잡지 않는다 (다음 실행이 그대로 이어받는다)
    try {
      const r = await storeBatch(src, [b], await embed([b.text], stopSignal.signal));
      embedded += r.stored;
      failed += r.failed;   // 저장에 실패한 행도 다음 주기에 그대로 되돌아온다 (storeBatch 주석)
    } catch (e) {
      if (stopRequested) return left(false, true);
      warnEmbeddingFailure(e);
      if (e.retriable) return left(true, false);
      failed++;
      // 이 행은 이번에도 다음에도 같은 이유로 거부된다 — 해시가 갱신되지 않아 매 주기 재시도되므로
      // 원본을 고치기 전까지 계속 남는다. 조용히 빠지지 않도록 seq를 찍는다.
      console.warn(`[embed] ${src}#${b.seq} embedding failed — skipping this row only: ${e.message}`);
    }
  }
  return left(false, false);
}

// 배치 전체를 한 문장으로 쓴다 — 행마다 왕복하면 초기 1만건 동기화가 1만 번 왕복이 된다.
// 다만 한 문장은 전부 아니면 전무라, 행 하나가 문제(차원 불일치 등)면 정상인 31건까지 매 주기
// 다시 임베딩되고 버려진다. 실패하면 행 단위로 한 번 더 시도해 성한 행은 진도를 나가게 한다.
//
// 반환은 {stored, failed}다 — 저장하지 못한 행은 해시가 갱신되지 않아 다음 주기에 그대로
// 되돌아오므로, 임베딩이 거부된 행(embedRows)과 똑같이 집계에 잡혀야 한다. 성공 수만 돌려주면
// 그 행들이 syncSummary의 skipped 집계에서 통째로 빠져, 로그에는
// "created/updated 27, cleaned up 0"처럼 정상 회차와 글자 그대로 같은 줄만 남는다 —
// 매 주기 조용히 되풀이되는 실패에 눈에 띄는 표시를 남기려고 failed를 둔 것인데(위 syncSummary
// 주석), 이 경로만 그 집계 밖에 있었다.
async function storeBatch(src, batch, vectors) {
  try {
    await query(
      `REPLACE INTO vec_store (src, seq, embed_hash, embedding) VALUES ${batch.map(() => '(?, ?, ?, VEC_FromText(?))').join(', ')}`,
      batch.flatMap((b, j) => [src, b.seq, b.hash, JSON.stringify(vectors[j])])
    );
    return { stored: batch.length, failed: 0 };
  } catch (e) {
    console.warn(`[embed] ${src} batch store failed — retrying row by row: ${e.message}`);
    let stored = 0;
    for (const [j, b] of batch.entries()) {
      try {
        await query(
          'REPLACE INTO vec_store (src, seq, embed_hash, embedding) VALUES (?, ?, ?, VEC_FromText(?))',
          [src, b.seq, b.hash, JSON.stringify(vectors[j])]
        );
        stored++;
      } catch (e2) {
        console.warn(`[embed] ${src}#${b.seq} store failed: ${e2.message}`);
      }
    }
    return { stored, failed: batch.length - stored };
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
  const summary = `embedding sync complete: ${syncSummary(r)}, ${((Date.now() - t) / 1000).toFixed(1)}s\n`;
  try { writeSync(1, summary); } catch { /* 로그 실패가 종료 코드를 바꾸지 않게 */ }
  // 풀을 닫고 나간다 — process.exit는 풀에 남은 커넥션을 정리하지 않고 소켓째 끊으므로,
  // 프로비저닝 진입점인 이 명령을 돌릴 때마다 MariaDB 에러 로그에 커넥션 수만큼
  // 'Aborted connection … Got an error reading communication packets'가 쌓인다.
  // server.js의 정상 종료가 closePool을 부르는 것과 같은 이유인데 이쪽 종료 경로만 빠져 있었다.
  await closePool().catch(e => console.warn('[embed] failed to close connection pool:', e.message));
  // 실패로 종료하는 것은 "쓰려고 했는데 안 된" 경우뿐이다 — LIKE-only는 지원되는 구성이므로
  // 프로비저닝 스크립트가 이 명령의 종료 코드로 실패 판정을 하면 안 된다.
  process.exit(r.skipped === SKIP.UNAVAILABLE ? 1 : 0);
}
