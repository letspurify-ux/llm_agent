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
import { SEARCH_COLUMNS, vecTable } from './search.js';
import { MAX_EMBED_TEXT_LEN, clipText } from './constants.js';
import { splitContent, CHUNK_TARGET_LEN, CHUNK_MAX_LEN, CHUNK_OVERLAP, CHUNK_SPLIT_VERSION } from './chunk.js';

// 문서 단위 staleness의 기준. 임베딩 모델명이 아니라 '분할 규칙'을 넣는다 —
//   ① 모델을 바꾸면 벡터는 전부 다시 만들어야 하지만 청크는 그대로다. 모델명을 넣으면 그 순간
//      전 문서가 재분할되고, seq가 바뀌어 결국 벡터도 전량 재계산된다(어차피 하는 일이긴 하나,
//      분할까지 끌려가면 대량 설치에서 동기화 한 회차가 통째로 길어진다).
//   ② 반대로 분할 규칙(크기·겹침)을 고치면 재분할이 필요한데, 모델명 기준으로는 아무 일도
//      일어나지 않는다 — 규칙만 바뀌고 청크는 옛 규칙대로 남는 것이 가장 나쁜 결과다.
// 규칙을 여기 박아 두면 상수 한 줄을 고치는 것만으로 다음 동기화가 알아서 다시 나눈다.
// 분할 방식의 판(CHUNK_SPLIT_VERSION)도 넣는다 — 크기·겹침이 같아도 절단 위치 규칙이 바뀌면 다른 청크다 (chunk.js).
const CHUNK_RULE = `chunk:${CHUNK_TARGET_LEN}:${CHUNK_MAX_LEN}:${CHUNK_OVERLAP}:v${CHUNK_SPLIT_VERSION}`;

// 임베딩 원문 — 검색 대상 컬럼(search.js)을 이어붙여 "이 행이 무엇인지"를 표현한다.
// 검색 대상 컬럼의 단일 정의(search.js)를 여기서도 쓴다 — 두 곳이 갈라지면 벡터가 담은 내용과 검색이 맞추려는 내용이 어긋난다.
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
// 구분해야 한다. 임베딩을 끄고 쓰는 것은 설정상의 선택이므로 이 동기화의 실패로 보고하지 않는다 —
// 다만 그 구성에서는 검색이 성립하지 않는다(벡터 단일 경로, search.js). 그 사실은 검색 경로가
// 요청마다 알리고(warnOnce) 화면·chat_log에 '검색 불가'로 남는다.
export const SKIP = {
  NONE: false,
  BUSY: 'busy',                 // 다른 동기화가 진행 중 (이번 회차만 건너뜀)
  UNCONFIGURED: 'unconfigured', // EMBEDDING_URL 미설정 — 임베딩을 쓰지 않는 구성 (그 구성에서는 검색이 없다)
  UNAVAILABLE: 'unavailable',   // 임베딩 서버가 설정돼 있으나 응답하지 않음
  STOPPED: 'stopped',           // 정상 종료 요청으로 도중에 접음 (다음 실행이 이어받는다)
};

// 결과 문구는 SKIP 바로 옆에 둔다 — 서버 로그와 CLI가 각자 SKIP 키 맵을 들고 있으면
// 값이 하나 추가될 때 두 곳을 손으로 맞춰야 하고, 한쪽만 고치면 그 실행 경로에서만 안내가 사라진다.
// (SKIP을 상수로 모은 이유가 '설정상 안 쓰는 것'과 '쓰려는데 실패한 것'을 호출부가 구분하게 하려는
//  것인데, 구분해서 보여줄 문구가 호출부마다 흩어져 있으면 그 목적이 반만 달성된다.)
const SKIP_NOTE = {
  [SKIP.BUSY]: 'skipped — another sync is already in progress',
  [SKIP.UNCONFIGURED]: 'EMBEDDING_URL not set — embedding skipped; search cannot run at all without it',
  [SKIP.UNAVAILABLE]: 'could not reach the embedding server — some rows skipped; those rows stay unsearchable',
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
  // 청크 재생성은 0건일 때 적지 않는다 — 평상시 주기는 늘 0이라, 매번 적으면 '아무 일도 없던 주기'와
  // '문서가 실제로 바뀐 주기'를 운영자가 구분할 수 없게 된다 (cleaned up을 실제 삭제 수로 세는 것과 같은 이유).
  const chunks = r.chunks ? `, rechunked ${r.chunks} (replacing ${r.chunksDropped})` : '';
  return `created/updated ${r.embedded}, cleaned up ${r.deleted}${chunks}${failed}${note ? ` — ${note}` : ''}`;
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

// ===== ① 청크 재생성 (knowledge → knowledge_chunk) =====
// 벡터 동기화(②) 앞에 선다. 두 단계 모두 MD5 게으른 비교라 새 개념은 없다 —
// ①은 '문서가 바뀌었나'를 doc_hash로, ②는 '청크가 바뀌었나'를 embed_hash로 본다.
//
// 문서 하나가 바뀌면 그 문서의 청크를 통째로 지우고 다시 넣는다. 청크 단위로 diff하지 않는 이유:
// 겹침(CHUNK_OVERLAP) 때문에 앞부분을 한 글자만 고쳐도 뒤 청크의 경계가 밀린다. 부분 갱신을 흉내내면
// 어긋난 경계가 남고, 그것은 검색 결과가 이상하다는 형태로만 드러난다 — 문서 단위 비용이 작으므로
// 통째로 다시 만드는 쪽이 옳다.
// seq는 AUTO_INCREMENT라 재생성 때 바뀐다. 그래도 되는 이유: seq가 고정이어야 하는 범위는 '한 요청
// 안'이고(constants.js ITEM_PREFIX), 동기화는 요청 밖에서 돈다. 다음 요청은 새 seq로 다시 검색한다.
//
// 임베딩이 꺼져 있어도 이 단계는 돈다 — 청크는 임베딩과 무관한 원문 파생이고, 여기서 건너뛰면
// 임베딩을 다시 켰을 때 청크가 없어 지식이 통째로 검색되지 않는다.
async function rebuildChunks() {
  let built = 0, dropped = 0;
  // 문서 단위 해시. 컬럼 목록은 knowledge의 검색 대상과 같아야 한다 — 제목만 고친 수정도
  // 청크의 title 복사본에 반영되어야 하기 때문이다.
  const docs = await query(`SELECT seq, ${hashExpr(['title', 'content'])} AS h FROM knowledge`, [CHUNK_RULE]);
  const have = new Map(
    (await query('SELECT doc_seq, MIN(doc_hash) AS h FROM knowledge_chunk GROUP BY doc_seq'))
      .map(r => [r.doc_seq, r.h])
  );
  const stale = docs.filter(d => have.get(d.seq) !== d.h).map(d => ({ seq: d.seq, hash: d.h }));
  const byHash = new Map(stale.map(d => [d.seq, d.hash]));
  // 원본이 사라진 청크는 FK ON DELETE CASCADE가 이미 거둔다 — 여기서 다시 지우지 않는다.
  // (그 벡터는 ②의 고아 정리가 거둔다: 청크가 없어지면 vec 쪽이 stored에 고아로 남는다.)

  for (const seqs of chunked(stale.map(d => d.seq), IN_CHUNK)) {
    if (stopRequested) break;
    const rows = await query(
      `SELECT seq, title, content FROM knowledge WHERE seq IN (${seqs.map(() => '?').join(',')})`,
      seqs
    );
    for (const row of rows) {
      // 문서마다 확인한다. IN_CHUNK가 1,000이라 덩어리 경계에서만 보면 종료 요청 뒤에도 문서
      // 수백 건을 트랜잭션째로 계속 처리하고, 그동안 GET_LOCK 커넥션을 쥔 채 종료가 늦어진다.
      if (stopRequested) break;
      const parts = splitContent(row.content);
      const conn = await getConnection();
      try {
        // 한 트랜잭션에 묶는다. 중간에 끊기면 그 문서의 청크가 앞부분만 남아, 등록된 지식의
        // 뒷부분이 검색에서 사라진 채로 doc_hash만 갱신되는 상태가 된다 — 오류는 어디에도 없다.
        await conn.beginTransaction();
        // 자리(doc_seq, chunk_no)를 키로 덮어쓴다. 지우고 다시 넣으면 seq가 AUTO_INCREMENT로 새로
        // 발급되어, 내용이 그대로인 청크까지 ②가 '새 행'으로 보고 전부 다시 임베딩한다 —
        // 168조각짜리 문서의 오타 하나를 고치면 임베딩 168회다. 자리를 유지하면 실제로 내용이
        // 바뀐 청크만 해시가 달라져 그것들만 다시 계산된다.
        for (const [i, content] of parts.entries()) {
          await conn.query(
            `INSERT INTO knowledge_chunk (doc_seq, chunk_no, chunk_of, doc_hash, title, content)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE chunk_of = VALUES(chunk_of), doc_hash = VALUES(doc_hash),
                                     title = VALUES(title), content = VALUES(content)`,
            [row.seq, i + 1, parts.length, byHash.get(row.seq), row.title, content]
          );
        }
        // 문서가 짧아졌으면 남는 꼬리를 거둔다. 두지 않으면 지워진 대목이 검색에 계속 살아 있다.
        const del = await conn.query('DELETE FROM knowledge_chunk WHERE doc_seq = ? AND chunk_no > ?',
          [row.seq, parts.length]);
        dropped += Number(del?.affectedRows ?? 0);
        await conn.commit();
        built += parts.length;
      } catch (e) {
        await conn.rollback().catch(() => { /* 이미 끊긴 커넥션 */ });
        // 행 하나의 실패로 동기화 전체를 버리지 않는다 — 다음 주기에 해시가 여전히 불일치하므로
        // 자동으로 다시 잡힌다 (embedRows가 행별 실패를 다루는 것과 같은 방식).
        console.warn(`[embed] knowledge#${row.seq} chunking failed — skipping this document only: ${e.message}`);
      } finally {
        await releaseConnection(conn);
      }
    }
  }
  return { built, dropped };
}

async function doSync() {
  // 임베딩을 쓰지 않는 환경에서는 본문 읽기와 해시 계산을 건너뛴다.
  // 단, 원본이 삭제된 vec_store 행 정리는 이 함수에만 있으므로 그 경로는 계속 태운다 —
  // 건너뛰면 삭제된 지식의 벡터가 남아, 임베딩을 다시 켤 때까지 검색에 노출된다.
  const enabled = isEmbeddingEnabled();
  let embedded = 0, deleted = 0, failed = 0, skipped = enabled ? SKIP.NONE : SKIP.UNCONFIGURED;
  let chunked_built = 0, chunked_dropped = 0;
  // 임베딩 서버가 도중에 끊기면 임베딩만 멈추고 루프는 끝까지 돈다.
  // 여기서 return하면 뒤쪽 테이블의 고아 벡터 정리가 통째로 빠지는데, 그 정리는 이 함수에만 있어
  // 삭제된 qa_method/query_registry의 벡터가 다음 성공 동기화까지 검색에 남는다.
  let unavailable = false;
  let stopped = false;

  // 청크 재생성이 먼저다 — 아래 루프가 knowledge_chunk를 원본으로 삼으므로,
  // 순서가 뒤집히면 새로 나뉜 청크가 그 주기에는 임베딩되지 않고 한 주기를 통째로 기다린다.
  // 실패해도 벡터 동기화는 계속한다: 이미 있는 청크의 임베딩까지 함께 멈출 이유가 없다.
  try {
    const c = await rebuildChunks();
    chunked_built = c.built;
    chunked_dropped = c.dropped;
  } catch (e) {
    console.warn(`[embed] chunk rebuild failed — vector sync continues with existing chunks: ${e.message}`);
  }

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
      (await query(`SELECT seq, embed_hash FROM ${vecTable(src)}`)).map(r => [r.seq, r.embed_hash])
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
        `DELETE FROM ${vecTable(src)} WHERE seq IN (${seqs.map(() => '?').join(',')})`,
        seqs
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
  return {
    embedded, deleted, failed, chunks: chunked_built, chunksDropped: chunked_dropped,
    skipped: stopped ? SKIP.STOPPED : unavailable ? SKIP.UNAVAILABLE : skipped,
  };
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
      `REPLACE INTO ${vecTable(src)} (seq, embed_hash, embedding) VALUES ${batch.map(() => '(?, ?, VEC_FromText(?))').join(', ')}`,
      batch.flatMap((b, j) => [b.seq, b.hash, JSON.stringify(vectors[j])])
    );
    return { stored: batch.length, failed: 0 };
  } catch (e) {
    console.warn(`[embed] ${src} batch store failed — retrying row by row: ${e.message}`);
    let stored = 0;
    for (const [j, b] of batch.entries()) {
      try {
        await query(
          `REPLACE INTO ${vecTable(src)} (seq, embed_hash, embedding) VALUES (?, ?, VEC_FromText(?))`,
          [b.seq, b.hash, JSON.stringify(vectors[j])]
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
  // 실패로 종료하는 것은 "쓰려고 했는데 안 된" 경우뿐이다 — 임베딩을 끄고 쓰는 것은 설정상의
  // 선택이라(그 구성에서는 검색이 없다) 프로비저닝 스크립트가 이 명령의 종료 코드로 그것을
  // 실패로 판정하면 안 된다.
  process.exit(r.skipped === SKIP.UNAVAILABLE ? 1 : 0);
}
