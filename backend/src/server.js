import 'dotenv/config';
import { writeSync } from 'node:fs';
import express from 'express';
import { handleQuestion, normalizeQuestion } from './agent.js';
import { llmProvider } from './llm.js';
import { oracleMock } from './oracle.js';
import { syncEmbeddings, syncSummary, requestSyncStop } from './embed-sync.js';
import { insertChatLog, cleanupChatLogs, closePool } from './db.js';
import { numEnv, warnOnce, clipText, MAX_QUESTION_LEN } from './constants.js';
import { clientTrace } from './result.js';

// 종료가 시작됐는지 — 새 주기 작업을 시작하지 않기 위해 아래 runJob이 함께 본다.
// (선언을 shutdown 옆이 아니라 여기 두는 이유는 그 참조가 정의보다 먼저 평가되기 때문이다)
let shuttingDown = false;

// 놓친 promise 거부는 기록만 하고 계속 진행한다 (요청 단위 오류는 각 경로에서 이미 처리한다).
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
// 반면 uncaughtException은 모든 핸들러를 빠져나온 예외라 프로세스 상태가 정의되지 않는다 —
// finally의 conn.close()/release()를 건너뛴 채 살아남으면 커넥션이 누수되는데,
// /api/health는 DB를 건드리지 않아 계속 ok를 돌려주므로 감시자가 재시작을 걸지 못한다.
// 로그를 남기고 즉시 종료해 supervisor가 깨끗한 프로세스로 재시작하게 한다.
process.on('uncaughtException', e => {
  // stderr가 파이프(도커 로그 등)면 console.error는 비동기라 process.exit에 잘려 나간다 —
  // 종료하는 이유가 이 메시지를 남기기 위함이므로 동기로 쓴다.
  try { writeSync(2, `[uncaughtException] ${e?.stack ?? e}\n`); } catch { /* 로그 실패가 종료를 막지 않게 */ }
  process.exit(1);
});

// .env는 gitignore 대상이라 새 클론에는 없다. 없는 채로 뜨면 관리 DB 접속도, ORACLE_MOCK도
// 설정되지 않아 모든 질문이 500이 되는데 /api/health는 계속 ok를 돌려줘 원인을 찾기 어렵다.
if (!process.env.MARIADB_USER) {
  console.warn('[setup] MARIADB_USER is not set — backend/.env is missing or empty. Run `cp backend/.env.example backend/.env` and restart.');
} else if (!process.env.MARIADB_PASSWORD) {
  // .env.example은 비밀번호를 비워 배포한다(알려진 비밀번호가 운영까지 따라가지 않게 — .env.example 주석 참고).
  // 비운 채 뜨면 모든 질문이 인증 실패로 500이 되는데 /api/health는 ok라 원인이 안 보인다 — 기동 시점에 알린다.
  console.warn("[setup] MARIADB_PASSWORD is empty — fill in the management DB account password in backend/.env (the value you chose in the README's app account setup step).");
}
// LLM 쪽도 같은 함정이다: provider=openai인데 접속 정보가 비면 모든 질문이 'LLM 호출 실패'가
// 되는데 /api/health는 계속 ok고, 원인은 요청마다 warn 로그로 흩어져 남는다 — 기동 시점에 알린다.
if (llmProvider() === 'openai') {
  const missing = ['LLM_BASE_URL', 'LLM_MODEL'].filter(k => !process.env[k]);
  if (missing.length) {
    console.warn(`[setup] LLM_PROVIDER=openai but ${missing.join(', ')} is empty — every question will end in "LLM call failed". Check backend/.env.`);
  }
}

const app = express();
// 기본값(100kb)은 표 형태 답변이 쌓인 대화 이력에 부족하다 — 초과하면 핸들러에 닿기도 전에
// 413이 나고 클라이언트는 그 뒤 모든 요청이 같은 이유로 실패한다.
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// trace 스키마 버전. 형식이 바뀌어도 분석 SQL이 옛 행과 새 행을 구분할 수 있게 한다.
// 3부터 outcome이 반드시 있다 (2에는 없다 — README의 대화 로그 절 참고).
const TRACE_VERSION = 3;

// 대화 로그 기록은 응답을 막지 않는다(await 하지 않는다) — 대신 진행 중인 기록을 붙잡아 두어
// 종료 경로가 기다릴 수 있게 한다. 재배포의 SIGTERM이 res.json 직후에 닿으면 shutdown이
// 커넥션 풀을 닫아버려 아직 날아가지 않은 INSERT가 통째로 사라지는데, 남는 것은
// '[chat_log] failed to record' 한 줄뿐이다. chat_log는 '답하지 못한 질문' 분석의 유일한
// 출처이므로(README) 그 손실은 정작 데이터에서는 보이지 않는다 — 배포 직전 질문만 조용히 빈다.
//
// 기록은 결과가 무엇이든 남긴다. 앞서는 성공 경로에만 붙어 있어서, 정작 이 로그가 찾아내야 할
// 요청(서버 오류, 거부된 입력, 본문 크기 초과)만 데이터에 흔적 없이 사라졌다 — 관리 DB 장애나
// 클라이언트의 체계적인 버그가 이어지는 동안 chat_log는 '질문이 줄었다'로만 보이고, 단서는
// 콘솔 한 줄뿐이다. 무엇으로 끝났는지는 trace.outcome에 남긴다.
//
// 진행 중인 기록에 상한을 둔다. 거부된 요청까지 기록하게 되면서 이 집합의 유입 속도가 달라졌기
// 때문이다 — 답변까지 가는 요청은 에이전트 루프(초 단위)가 스스로 속도를 묶어 주지만,
// 400/413은 즉시 돌아가므로 클라이언트 하나가 초당 수천 건을 만들 수 있다. 관리 DB가 그보다
// 느리면 아직 날아가지 않은 기록이 질문 본문째로 쌓이고, 그 집합은 종료 경로가 기다리는
// 대상이기도 해서 정상 종료까지 함께 늘어진다.
// 넘치면 기록을 포기한다 — 그 상황 자체는 아래 경고 한 줄로 드러나고, 로그가 목적이지
// 로그 때문에 서버가 흔들리면 안 된다. 응답은 어느 쪽이든 영향받지 않는다.
const MAX_PENDING_LOG_WRITES = 1000;

const pendingLogWrites = new Set();
function recordChatLog(question, answer, extra) {
  if (pendingLogWrites.size >= MAX_PENDING_LOG_WRITES) {
    warnOnce('chat_log', `${MAX_PENDING_LOG_WRITES}건이 아직 기록 중이라 새 대화 로그를 건너뜁니다 — 관리 DB가 밀리고 있는지 확인할 것.`);
    return;
  }
  // 실패를 먼저 삼킨 promise를 담는다 — 그래야 종료 경로의 Promise.all이 기록 실패로 거부되지 않는다.
  const p = insertChatLog(question, answer, { v: TRACE_VERSION, ...extra })
    .catch(e => console.warn('[chat_log] failed to record:', e.message))
    .finally(() => pendingLogWrites.delete(p));
  pendingLogWrites.add(p);
}

// 답변까지 가지 못하고 거부된 요청의 기록. question은 NOT NULL이라 없으면 빈 문자열로 남긴다 —
// '무엇을 물었는지조차 읽지 못한 요청'도 건수로는 보여야 한다.
// 질문 본문은 상한 안으로 잘라 넣는다: 거부 사유가 '너무 김'인 요청은 본문이 1MB까지 올 수 있다.
const recordRejected = (question, reason, extra) =>
  recordChatLog(clipText(String(question ?? ''), MAX_QUESTION_LEN), null, { outcome: 'rejected', reason, ...extra });

app.post('/api/chat', async (req, res) => {
  const raw = req.body?.message;
  if (typeof raw !== 'string') {
    recordRejected('', 'no_message');
    return res.status(400).json({ error: 'message가 필요합니다.' });
  }
  // 짝 잃은 서로게이트를 여기서 걷어낸다 — 클라이언트가 이모지 한가운데를 자른 조각을 보내면
  // 그 문자열은 유효한 UTF-8이 아니라서 LLM 요청이 통째로 거부되거나 본문이 U+FFFD로 훼손되고,
  // chat_log INSERT도 같은 이유로 깨진다. 대화 턴이 normalizeChat에서 같은 처리를 받는 것과
  // 같은 이유다 (agent.js clipChatText). 규칙 자체는 agent.js가 갖고 있고 여기서도 그 함수를
  // 부른다 — 두 경계가 각자 적으면 어느 문으로 들어오느냐에 따라 질문이 달라진다.
  const message = normalizeQuestion(raw);
  if (!message) {
    recordRejected(raw, 'empty_message');
    return res.status(400).json({ error: 'message가 필요합니다.' });
  }
  // 상한은 constants.js가 정한다 — 프롬프트 예산 계산과 회귀 테스트가 같은 값을 본다.
  if (message.length > MAX_QUESTION_LEN) {
    recordRejected(message, 'too_long', { length: message.length });
    return res.status(400).json({ error: `질문이 너무 깁니다 (최대 ${MAX_QUESTION_LEN.toLocaleString('ko-KR')}자).` });
  }
  try {
    // history: 클라이언트가 보내는 최근 대화 [{role:'user'|'assistant', text}] (서버는 상태를 저장하지 않는다)
    const { answer, trace, search } = await handleQuestion(message, req.body?.history);
    // 대화 로그 (비동기 — 기록 실패가 응답을 막지 않는다). search(검색 적중 수)를 함께 남겨
    // "검색 0건이라 못 답한 질문"을 SQL로 바로 찾을 수 있게 한다 (README의 chat_log 예시 참고).
    recordChatLog(message, answer, { outcome: 'answered', search, steps: trace });
    // 화면용 정리(제어용 기록 제외, 원문 오류 가리기, 행 상한과 생략 건수)는 result.js가 한다 —
    // 건수 해석을 답변 본문·프롬프트와 한 곳에서 공유해야 하고, 여기 두면 테스트가 붙지 않는다.
    res.json({ answer, trace: clientTrace(trace) });
  } catch (e) {
    console.error('[chat error]', e);
    // 답하지 못한 질문 중 가장 중요한 부류가 이것이다 — 반드시 기록한다.
    // 오류 원문은 chat_log에만 남긴다(화면에는 아래 일반 문구만 나간다). trace.steps[].error가
    // 이미 드라이버 원문을 담는 필드이므로 같은 기준이다.
    recordChatLog(message, null, { outcome: 'error', error: e?.message ?? String(e) });
    // 실패는 400/413/500 어느 경로든 error 필드로 통일한다 — 여기만 answer로 보내면
    // error 유무로 실패를 판정하는 클라이언트가 서버 오류를 정상 답변으로 읽는다.
    res.status(500).json({ error: '처리 중 오류가 발생했습니다.' });
  }
});

// 등록되지 않은 경로도 JSON으로 답한다 — express 기본 404는 HTML 페이지라,
// 바로 아래 오류 핸들러가 본문 파싱 실패에 대해 막아둔 것과 똑같은 실패가 이 문으로 되살아난다
// (클라이언트의 res.json()이 던지고, 그 예외가 통신 실패와 구분되지 않는 한 문구로 뭉개진다).
// 오류 핸들러보다 앞에 둔다 — 본문 파서 오류는 next(err)로 오므로 이 핸들러를 건너뛰고
// 아래로 곧장 간다(413 경로는 그대로다).
// ⚠ 새 라우트는 반드시 이 줄 '위'에 등록할 것 — 아래에 붙이면 이 핸들러가 먼저 잡아
//   그 경로만 조용히 404가 된다(라우트는 등록 순서대로 매칭된다).
app.use((req, res) => res.status(404).json({ error: '요청한 경로를 찾을 수 없습니다.' }));

// 본문 파싱 실패(413 등)도 JSON으로 답한다 — 기본 HTML 오류 페이지를 주면
// 클라이언트의 res.json()이 던져 원인이 "서버와 통신하지 못했습니다"로 뭉개진다.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const tooLarge = err?.type === 'entity.too.large';
  if (tooLarge) console.warn('[chat] request body too large:', err.length);
  // 본문을 읽지 못해 핸들러에 닿지도 못한 요청도 기록한다 — 그 요청이 바로 chat_log가 찾아야 할
  // '답하지 못한 질문'이고, 이 경로만 빠지면 클라이언트가 계속 너무 큰 본문을 보내는 상황이
  // 데이터에서는 '질문이 줄었다'로만 보인다. 질문 본문은 파싱 자체가 실패해 남길 것이 없다.
  // /api/chat만 기록한다 — 다른 경로의 본문 오류는 이 로그의 관심사가 아니다
  // (등록되지 않은 경로는 위 404 핸들러가 먼저 받으므로 여기까지 오지 않는다).
  if (req.path === '/api/chat') {
    recordRejected('', tooLarge ? 'body_too_large' : 'bad_body', tooLarge && err.length ? { length: err.length } : undefined);
  }
  // 본문 파서 오류는 status를 채워 보낸다(400/413). status가 없으면 클라이언트 잘못이 아니라
  // 서버 버그이므로 500으로 둔다 — 전부 400으로 뭉개면 원인 분류가 뒤집힌다.
  const status = err?.status ?? err?.statusCode ?? 500;
  if (status >= 500) console.error('[server error]', err);
  res.status(status).json({
    error: tooLarge ? '요청이 너무 큽니다. 새 대화로 다시 시도해주세요.'
      : status >= 500 ? '처리 중 오류가 발생했습니다.' : '잘못된 요청입니다.',
  });
});

// 정상 종료 때 멈춰야 할 타이머 — 등록과 정리가 떨어져 있으면 새 주기 작업이 추가될 때
// 종료 경로만 조용히 빠진다. 만드는 자리에서 바로 모은다.
const timers = [];
const everyMs = (fn, ms) => timers.push(setInterval(fn, ms));

// 응답 경로 밖에서 도는 작업(임베딩 동기화·chat_log 정리)도 커넥션 풀을 쓴다.
// 타이머만 멈추고 closePool()을 부르면 '이미 시작된' 작업이 커넥션을 쥔 채 남아 pool.end()가
// 끝나지 않는다 — 기동 직후 재배포하면 초기 대량 동기화(수 분)가 정확히 그 상태이고,
// 10초 강제 타이머가 터져 정상 종료가 매번 종료 코드 1로 기록된다. 그러면 supervisor의 재시작
// 판정이 어긋나고, 이 경로가 하려던 일(풀 정리)도 실행되지 않는다 — shutdown 주석이 막겠다고
// 적어둔 바로 그 결과다. chat_log 기록(pendingLogWrites)만 그렇게 다뤄지고 있었다.
// 시작한 자리에서 붙잡아 두고, 종료 경로가 접으라고 알린 뒤(requestSyncStop) 기다린다.
const backgroundJobs = new Set();
function runJob(fn) {
  if (shuttingDown) return;   // 종료 중에는 새 작업을 시작하지 않는다 (타이머가 방금 해제됐어도)
  const p = Promise.resolve()
    .then(fn)
    // 실패를 먼저 삼킨다 — 종료 경로의 Promise.all이 작업 실패로 거부되지 않게
    // (각 작업은 자기 오류를 이미 처리하지만, 동기 예외까지 여기서 받는다)
    .catch(e => console.warn('[job] background task failed:', e?.message ?? e))
    .finally(() => backgroundJobs.delete(p));
  backgroundJobs.add(p);
}

// 임베딩 diff 동기화: 기동 시 1회 + 주기 실행 (SQL로 직접 등록한 데이터도 자동 반영).
// 결과 문구는 embed-sync.js가 SKIP 옆에서 만든다 — 여기서 SKIP 키 맵을 다시 들면
// 값이 하나 늘 때 CLI와 손으로 맞춰야 하고, 한쪽만 고치면 그 경로에서만 안내가 사라진다.
runJob(() => syncEmbeddings()
  .then(r => console.log(`[embed] sync: ${syncSummary(r)}`))
  .catch(e => console.warn('[embed] sync failed:', e.message)));
// 0은 "주기 동기화 끔"이라는 의도된 값이므로 허용하되, 빈 값·오타는 기본값으로 되돌린다
// (검증이 없으면 EMBED_SYNC_INTERVAL= 한 줄로 주기 동기화가 로그 없이 사라진다).
const syncInterval = numEnv('EMBED_SYNC_INTERVAL', 60, { allowZero: true });
if (syncInterval > 0) {
  everyMs(() => runJob(() => {
    return syncEmbeddings()
      .then(r => { if (r.embedded || r.deleted || r.failed) console.log(`[embed] sync: ${syncSummary(r)}`); })
      // 삼키면 안 된다 — 임베딩 서버 쪽 실패는 embed-sync가 스스로 알리지만, 관리 DB 오류
      // (vec_store 권한 상실·테이블 유실 등)로 query()가 던지면 그 실패는 여기로만 온다.
      // 조용히 버리면 벡터가 낡아가는 동안 검색은 LIKE 폴백으로 계속 동작하므로 로그 말고는
      // 단서가 없다 — 바로 위 기동 시 1회 실행은 이 실패를 알리고 있었고 주기 실행만 빠져 있었다.
      // warnOnce로 억제해 매 주기 도배는 막되, 오류의 성격이 바뀌면 반드시 다시 알린다.
      .catch(e => warnOnce('embed', `periodic sync failed: ${e.message}`));
  }), syncInterval * 1000);
} else {
  console.log('[embed] periodic sync disabled (EMBED_SYNC_INTERVAL=0) — run `npm run embed` to sync manually');
}

// 대화 로그 보존: 3일 지난 행을 기동 시 + 1시간 주기로 정리
const CHAT_LOG_RETENTION_DAYS = 3;
const cleanupLogs = () =>
  cleanupChatLogs(CHAT_LOG_RETENTION_DAYS)
    .then(r => { if (r.affectedRows) console.log(`[chat_log] cleaned up ${r.affectedRows} rows (older than ${CHAT_LOG_RETENTION_DAYS} days)`); })
    .catch(e => console.warn('[chat_log] cleanup failed:', e.message));
runJob(cleanupLogs);
everyMs(() => runJob(cleanupLogs), 3600 * 1000);

// PORT=0은 '빈 포트를 아무거나'라는 의도된 값이므로 허용한다 (빈 값·오타만 기본값으로)
const port = numEnv('PORT', 3001, { allowZero: true });
const server = app.listen(port, () => {
  // PORT=0이면 OS가 빈 포트를 고르므로 실제 배정된 포트를 찍는다 (로그가 유일한 확인 수단)
  // 원본 환경변수가 아니라 '실제로 고른 것'을 찍는다 — 원본을 찍으면 오타 하나가
  // 'LLM=OpenAI'처럼 멀쩡해 보이는 배너를 남기면서 실제로는 Mock이 돈다
  // (llmProvider/oracleMock 주석 참고). 배너의 존재 이유가 이 확인이다.
  console.log(
    `agent server: http://localhost:${server.address().port} ` +
    `(LLM=${llmProvider()}, ORACLE_MOCK=${oracleMock() ? '1' : '0'})`
  );
});
server.on('error', e => {
  // 기동 실패(포트 충돌 등)는 이벤트로 오므로 uncaughtException 경로를 타지 않는다 — 명시 종료한다.
  // 종료 정리는 정상 종료와 같은 경로로 한다: listen에 실패한 시점에는 위 기동 작업(임베딩
  // 동기화·chat_log 정리)이 이미 관리 DB 커넥션을 쥐고 돌고 있다. 그대로 process.exit하면 그
  // 소켓들이 문장 도중에 끊겨 MariaDB 에러 로그에 'Aborted connection … Got an error reading
  // communication packets'가 쌓인다 — embed-sync.js의 CLI가 closePool을 부르는 것과 같은 이유인데,
  // 이 세 번째 종료 경로만 빠져 있었다. 포트 충돌은 재배포마다 나는 흔한 실패라 매번 반복된다.
  console.error('[listen] failed to start:', e.message);
  // 종료 코드 보장은 정리보다 우선한다. shutdown은 async라 여기서 거부되면 unhandledRejection
  // 핸들러가 로그만 남기고 넘어가는데, 강제 타이머는 unref라 이벤트 루프를 붙잡지 않는다 —
  // 기동에 실패한 프로세스가 종료 코드 0으로 조용히 빠져나가고 supervisor는 정상 종료로 읽는다.
  // 정리를 못 하더라도 '실패로 나간다'는 사실만은 반드시 남긴다.
  shutdown('listen failed', 1).catch(() => process.exit(1));
});

// 정상 종료 — 진행 중인 요청을 끝내고 타이머·커넥션 풀을 정리한 뒤 빠진다.
// 위 uncaughtException 핸들러는 '커넥션이 샌 채로 살아남는 것'을 막으려고 즉시 종료까지 하는데,
// 정작 재배포마다 반드시 도는 정상 종료 경로가 비어 있으면 같은 누수를 매번 만들면서
// 사용자에게는 '서버와 통신하지 못했습니다'로만 보인다(원인이 앱 오류처럼 읽힌다).
// code: 종료 코드. 시그널로 들어온 정상 종료는 0, 기동 실패는 1이다 — 정리 절차는 같고
// '왜 나가는가'만 다르므로 경로를 나누지 않는다 (나누면 한쪽만 조용히 정리를 빼먹는다).
async function shutdown(reason, code = 0) {
  if (shuttingDown) return; // 두 번째 시그널은 무시한다 — 종료 도중 다시 들어오는 일이 흔하다
  shuttingDown = true;
  console.log(`[shutdown] ${reason} — cleaning up and exiting.`);
  for (const t of timers) clearInterval(t);
  // 타이머 해제만으로는 '이미 시작된' 작업이 멈추지 않는다 — 접으라고 알린다.
  // 동기화는 해시 비교 기반이라 어디서 멈춰도 멱등하고, 남은 행은 다음 기동이 이어받는다.
  requestSyncStop();
  // 안전장치: keep-alive 연결이 남아 close가 끝나지 않을 수 있다. supervisor의 SIGKILL을
  // 기다리지 않고 우리가 먼저 접는다. unref로 이 타이머 자체가 종료를 붙잡지 않게 한다.
  const force = setTimeout(() => {
    console.warn('[shutdown] cleanup timed out — forcing exit.');
    process.exit(1);
  }, 10_000);
  force.unref();
  // close()는 새 접속만 막을 뿐 이미 열린 keep-alive 연결은 기다린다 — 브라우저 탭 하나가
  // 남긴 idle 연결 때문에 아래 10초 강제 타이머까지 갔다가 종료 코드 1로 빠질 수 있다.
  // 정상 종료가 매번 실패로 기록되면 supervisor의 재시작 판정이 어긋나고, 무엇보다 이 경로가
  // 하려던 일(풀 정리)이 타이머에 밀려 실행되지 않는다.
  // Node 19+는 close()가 idle 연결을 스스로 닫아주므로 지금 런타임에서는 이 호출이 동작을
  // 바꾸지 않는다(실측 확인). 그래도 명시하는 이유는 이 보장이 런타임 버전에 딸려 오는 것이라
  // Node 18에서는 그대로 사라지기 때문이다 — engines 제약이 없어 그 버전으로도 뜬다.
  // 처리 중인 요청의 연결은 건드리지 않고 idle 연결만 닫는다.
  const closed = new Promise(resolve => server.close(resolve));
  server.closeIdleConnections();
  await closed;
  // 풀을 닫기 전에 진행 중인 chat_log 기록을 마저 기다린다 — 응답은 이미 나갔지만 기록은
  // 아직 날아가는 중일 수 있다 (recordChatLog 주석 참고). 무한정 기다리지는 않는다:
  // 위 10초 강제 타이머가 상한이고, 각 promise는 자기 실패를 이미 삼켰다.
  if (pendingLogWrites.size) await Promise.all(pendingLogWrites);
  // 주기 작업도 같은 이유로 기다린다 — 이쪽은 커넥션을 '쥐고 있는' 몫이라 기다리지 않으면
  // pool.end()가 끝나지 않는다 (backgroundJobs 주석 참고). 위 requestSyncStop이 이미
  // 접으라고 알렸으므로 여기서 오래 매달리지 않는다. 상한은 아래 10초 강제 타이머다.
  if (backgroundJobs.size) await Promise.all(backgroundJobs);
  await closePool().catch(e => console.warn('[shutdown] failed to close connection pool:', e.message));
  clearTimeout(force);
  process.exit(code);
}
// 시그널 경로도 같은 이유로 거부를 받는다 — 여기서 새면 종료가 통째로 멈춘 채 프로세스만 남고
// (강제 타이머는 unref라 붙잡지 않는다) supervisor의 SIGKILL을 기다리게 된다.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => shutdown(`received ${sig}`).catch(e => {
    console.error('[shutdown] cleanup failed:', e);
    process.exit(1);
  }));
}
