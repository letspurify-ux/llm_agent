import 'dotenv/config';
import { writeSync } from 'node:fs';
import express from 'express';
import { handleQuestion } from './agent.js';
import { syncEmbeddings, syncSummary } from './embed-sync.js';
import { insertChatLog, cleanupChatLogs, closePool } from './db.js';
import { numEnv, MAX_QUESTION_LEN } from './constants.js';
import { rowCounts } from './result.js';

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
  console.warn('[setup] MARIADB_USER가 없습니다 — backend/.env가 없거나 비어 있습니다. `cp backend/.env.example backend/.env` 후 다시 실행하세요.');
} else if (!process.env.MARIADB_PASSWORD) {
  // .env.example은 비밀번호를 비워 배포한다(알려진 비밀번호가 운영까지 따라가지 않게 — .env.example 주석 참고).
  // 비운 채 뜨면 모든 질문이 인증 실패로 500이 되는데 /api/health는 ok라 원인이 안 보인다 — 기동 시점에 알린다.
  console.warn('[setup] MARIADB_PASSWORD가 비어 있습니다 — backend/.env에 관리 DB 계정 비밀번호를 채우세요 (README의 앱 계정 생성 단계에서 정한 값).');
}
// LLM 쪽도 같은 함정이다: provider=openai인데 접속 정보가 비면 모든 질문이 'LLM 호출 실패'가
// 되는데 /api/health는 계속 ok고, 원인은 요청마다 warn 로그로 흩어져 남는다 — 기동 시점에 알린다.
if (process.env.LLM_PROVIDER === 'openai') {
  const missing = ['LLM_BASE_URL', 'LLM_MODEL'].filter(k => !process.env[k]);
  if (missing.length) {
    console.warn(`[setup] LLM_PROVIDER=openai인데 ${missing.join(', ')}이(가) 비어 있습니다 — 모든 질문이 "LLM 호출 실패"로 끝납니다. backend/.env를 확인하세요.`);
  }
}

const app = express();
// 기본값(100kb)은 표 형태 답변이 쌓인 대화 이력에 부족하다 — 초과하면 핸들러에 닿기도 전에
// 413이 나고 클라이언트는 그 뒤 모든 요청이 같은 이유로 실패한다.
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/chat', async (req, res) => {
  const message = req.body?.message;
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message가 필요합니다.' });
  }
  // 상한은 constants.js가 정한다 — 프롬프트 예산 계산과 회귀 테스트가 같은 값을 본다.
  if (message.length > MAX_QUESTION_LEN) {
    return res.status(400).json({ error: `질문이 너무 깁니다 (최대 ${MAX_QUESTION_LEN.toLocaleString('ko-KR')}자).` });
  }
  try {
    // history: 클라이언트가 보내는 최근 대화 [{role:'user'|'assistant', text}] (서버는 상태를 저장하지 않는다)
    const { answer, trace, search } = await handleQuestion(message.trim(), req.body?.history);
    // 대화 로그 (비동기 — 기록 실패가 응답을 막지 않는다). search(검색 적중 수)를 함께 남겨
    // "검색 0건이라 못 답한 질문"을 SQL로 바로 찾을 수 있게 한다 (README의 chat_log 예시 참고).
    // v는 trace 스키마 버전 — 형식이 바뀌어도 분석 SQL이 옛 행과 새 행을 구분할 수 있게 한다.
    insertChatLog(message.trim(), answer, { v: 2, search, steps: trace })
      .catch(e => console.warn('[chat_log] 기록 실패:', e.message));
    res.json({
      answer,
      // note만 있는 항목은 루프 가드가 LLM에게 남긴 제어용 기록이고 실행된 쿼리가 아니다 —
      // 화면의 '실행된 쿼리 N건' 목록에서 제외한다 (내부 지시문이 사용자에게 노출되지 않게).
      trace: trace.filter(h => !h.note).map(h => {
        const { totalRows, capped } = rowCounts(h);
        return {
          query_name: h.query_name,
          params: h.params,
          rowCount: capped ? `${totalRows}+` : totalRows,
          rows: h.rows?.slice(0, 10),
          // 드라이버·DB가 던진 원문은 스키마명·테이블명·접속 주소를 담고 있다 —
          // 화면에는 우리가 문구를 만든 오류(h.safe)만 내보내고 원문은 로그와 chat_log에만 남긴다.
          // (사용자에게 일반화된 문구만 주는 llm-openai.js와 같은 기준이다)
          ...(h.error && { error: h.safe ? h.error : '조회 중 오류가 발생했습니다.' }),
        };
      }),
    });
  } catch (e) {
    console.error('[chat error]', e);
    // 실패는 400/413/500 어느 경로든 error 필드로 통일한다 — 여기만 answer로 보내면
    // error 유무로 실패를 판정하는 클라이언트가 서버 오류를 정상 답변으로 읽는다.
    res.status(500).json({ error: '처리 중 오류가 발생했습니다.' });
  }
});

// 본문 파싱 실패(413 등)도 JSON으로 답한다 — 기본 HTML 오류 페이지를 주면
// 클라이언트의 res.json()이 던져 원인이 "서버와 통신하지 못했습니다"로 뭉개진다.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const tooLarge = err?.type === 'entity.too.large';
  if (tooLarge) console.warn('[chat] 요청 본문이 너무 큽니다:', err.length);
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

// 임베딩 diff 동기화: 기동 시 1회 + 주기 실행 (SQL로 직접 등록한 데이터도 자동 반영).
// 결과 문구는 embed-sync.js가 SKIP 옆에서 만든다 — 여기서 SKIP 키 맵을 다시 들면
// 값이 하나 늘 때 CLI와 손으로 맞춰야 하고, 한쪽만 고치면 그 경로에서만 안내가 사라진다.
syncEmbeddings()
  .then(r => console.log(`[embed] 동기화: ${syncSummary(r)}`))
  .catch(e => console.warn('[embed] 동기화 실패:', e.message));
// 0은 "주기 동기화 끔"이라는 의도된 값이므로 허용하되, 빈 값·오타는 기본값으로 되돌린다
// (검증이 없으면 EMBED_SYNC_INTERVAL= 한 줄로 주기 동기화가 로그 없이 사라진다).
const syncInterval = numEnv('EMBED_SYNC_INTERVAL', 60, { allowZero: true });
if (syncInterval > 0) {
  everyMs(() => {
    syncEmbeddings()
      .then(r => { if (r.embedded || r.deleted || r.failed) console.log(`[embed] 동기화: ${syncSummary(r)}`); })
      .catch(() => {});
  }, syncInterval * 1000);
} else {
  console.log('[embed] 주기 동기화 꺼짐 (EMBED_SYNC_INTERVAL=0) — npm run embed로 수동 동기화');
}

// 대화 로그 보존: 3일 지난 행을 기동 시 + 1시간 주기로 정리
const CHAT_LOG_RETENTION_DAYS = 3;
const cleanupLogs = () =>
  cleanupChatLogs(CHAT_LOG_RETENTION_DAYS)
    .then(r => { if (r.affectedRows) console.log(`[chat_log] ${r.affectedRows}건 정리 (${CHAT_LOG_RETENTION_DAYS}일 경과)`); })
    .catch(e => console.warn('[chat_log] 정리 실패:', e.message));
cleanupLogs();
everyMs(cleanupLogs, 3600 * 1000);

// PORT=0은 '빈 포트를 아무거나'라는 의도된 값이므로 허용한다 (빈 값·오타만 기본값으로)
const port = numEnv('PORT', 3001, { allowZero: true });
const server = app.listen(port, () => {
  // PORT=0이면 OS가 빈 포트를 고르므로 실제 배정된 포트를 찍는다 (로그가 유일한 확인 수단)
  console.log(
    `agent server: http://localhost:${server.address().port} ` +
    `(LLM=${process.env.LLM_PROVIDER || 'mock'}, ORACLE_MOCK=${process.env.ORACLE_MOCK || '0'})`
  );
});
server.on('error', e => {
  // 기동 실패(포트 충돌 등)는 이벤트로 오므로 uncaughtException 경로를 타지 않는다 — 명시 종료한다
  console.error('[listen] 기동 실패:', e.message);
  process.exit(1);
});

// 정상 종료 — 진행 중인 요청을 끝내고 타이머·커넥션 풀을 정리한 뒤 빠진다.
// 위 uncaughtException 핸들러는 '커넥션이 샌 채로 살아남는 것'을 막으려고 즉시 종료까지 하는데,
// 정작 재배포마다 반드시 도는 정상 종료 경로가 비어 있으면 같은 누수를 매번 만들면서
// 사용자에게는 '서버와 통신하지 못했습니다'로만 보인다(원인이 앱 오류처럼 읽힌다).
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return; // 두 번째 시그널은 무시한다 — 종료 도중 다시 들어오는 일이 흔하다
  shuttingDown = true;
  console.log(`[shutdown] ${signal} 수신 — 정리 후 종료합니다.`);
  for (const t of timers) clearInterval(t);
  // 안전장치: keep-alive 연결이 남아 close가 끝나지 않을 수 있다. supervisor의 SIGKILL을
  // 기다리지 않고 우리가 먼저 접는다. unref로 이 타이머 자체가 종료를 붙잡지 않게 한다.
  const force = setTimeout(() => {
    console.warn('[shutdown] 정리 시간 초과 — 강제 종료합니다.');
    process.exit(1);
  }, 10_000);
  force.unref();
  await new Promise(resolve => server.close(resolve));
  await closePool().catch(e => console.warn('[shutdown] 커넥션 풀 종료 실패:', e.message));
  clearTimeout(force);
  process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));
