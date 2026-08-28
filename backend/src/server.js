import 'dotenv/config';
import express from 'express';
import { handleQuestion } from './agent.js';

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/chat', async (req, res) => {
  const message = req.body?.message;
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message가 필요합니다.' });
  }
  try {
    // history: 클라이언트가 보내는 최근 대화 [{role:'user'|'assistant', text}] (서버는 상태를 저장하지 않는다)
    const { answer, trace } = await handleQuestion(message.trim(), req.body?.history);
    res.json({
      answer,
      trace: trace.map(h => ({
        query_name: h.query_name,
        params: h.params,
        rowCount: h.totalRows ?? h.rows?.length ?? 0,
        rows: h.rows?.slice(0, 10),
        ...(h.error && { error: h.error }),
      })),
    });
  } catch (e) {
    console.error('[chat error]', e);
    res.status(500).json({ answer: '처리 중 오류가 발생했습니다.' });
  }
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(
    `agent server: http://localhost:${port} ` +
    `(LLM=${process.env.LLM_PROVIDER || 'mock'}, ORACLE_MOCK=${process.env.ORACLE_MOCK || '0'})`
  );
});
