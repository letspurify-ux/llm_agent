import 'dotenv/config';
import express from 'express';
import { handleQuestion } from './agent.js';
import { syncEmbeddings } from './embed-sync.js';
import { insertChatLog, cleanupChatLogs } from './db.js';

// 최후 방어선 — 놓친 promise 거부/예외로 프로세스 전체가 내려가지 않게 한다 (Node 기본은 즉시 종료).
// 요청 단위 오류는 각 경로에서 처리하고 있으므로, 여기 도달하는 건 코드 버그다: 로그를 남기고 생존한다.
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/chat', async (req, res) => {
  const message = req.body?.message;
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message가 필요합니다.' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: '질문이 너무 깁니다 (최대 2,000자).' });
  }
  try {
    // history: 클라이언트가 보내는 최근 대화 [{role:'user'|'assistant', text}] (서버는 상태를 저장하지 않는다)
    const { answer, trace, search } = await handleQuestion(message.trim(), req.body?.history);
    // 대화 로그 (비동기 — 기록 실패가 응답을 막지 않는다). search(검색 적중 수)를 함께 남겨
    // "검색 0건이라 못 답한 질문"을 SQL로 바로 찾을 수 있게 한다 (README의 chat_log 예시 참고)
    insertChatLog(message.trim(), answer, { search, steps: trace }).catch(e => console.warn('[chat_log] 기록 실패:', e.message));
    res.json({
      answer,
      trace: trace.map(h => ({
        query_name: h.query_name,
        params: h.params,
        rowCount: h.capped ? `${h.totalRows}+` : (h.totalRows ?? 0),
        rows: h.rows?.slice(0, 10),
        ...(h.error && { error: h.error }),
      })),
    });
  } catch (e) {
    console.error('[chat error]', e);
    res.status(500).json({ answer: '처리 중 오류가 발생했습니다.' });
  }
});

// 임베딩 diff 동기화: 기동 시 1회 + 주기 실행 (SQL로 직접 등록한 데이터도 자동 반영)
syncEmbeddings()
  .then(r => console.log(`[embed] 동기화: 생성/갱신 ${r.embedded}건, 정리 ${r.deleted}건${r.skipped ? ' (임베딩 서버 없음 — LIKE-only)' : ''}`))
  .catch(e => console.warn('[embed] 동기화 실패:', e.message));
const syncInterval = Number(process.env.EMBED_SYNC_INTERVAL ?? 60);
if (syncInterval > 0) {
  setInterval(() => {
    syncEmbeddings()
      .then(r => { if (r.embedded || r.deleted) console.log(`[embed] 동기화: 생성/갱신 ${r.embedded}건, 정리 ${r.deleted}건`); })
      .catch(() => {});
  }, syncInterval * 1000);
}

// 대화 로그 보존: 3일 지난 행을 기동 시 + 1시간 주기로 정리
const CHAT_LOG_RETENTION_DAYS = 3;
const cleanupLogs = () =>
  cleanupChatLogs(CHAT_LOG_RETENTION_DAYS)
    .then(r => { if (r.affectedRows) console.log(`[chat_log] ${r.affectedRows}건 정리 (${CHAT_LOG_RETENTION_DAYS}일 경과)`); })
    .catch(e => console.warn('[chat_log] 정리 실패:', e.message));
cleanupLogs();
setInterval(cleanupLogs, 3600 * 1000);

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(
    `agent server: http://localhost:${port} ` +
    `(LLM=${process.env.LLM_PROVIDER || 'mock'}, ORACLE_MOCK=${process.env.ORACLE_MOCK || '0'})`
  );
}).on('error', e => {
  // 기동 실패(포트 충돌 등)는 fail-fast — uncaughtException 그물이 삼켜 좀비로 남지 않게 명시 종료
  console.error('[listen] 기동 실패:', e.message);
  process.exit(1);
});
