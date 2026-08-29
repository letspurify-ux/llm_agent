import { useState, useRef, useEffect, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// 서버(agent.js normalizeChat)가 실제로 쓰는 상한과 같은 값. 서버 쪽 제한은 본문을 파싱한 뒤에
// 적용되므로 요청 크기를 실제로 묶어두는 것은 이쪽뿐이다 — 넘기면 express의 본문 크기 제한에 걸려
// 이후 모든 요청이 같은 이유로 실패한다(이력은 줄지 않으므로 대화가 복구되지 않는다).
const HISTORY_TURNS = 6;
const HISTORY_LEN = 500;

const EXAMPLES = [
  'SPACE 시스템이 뭐야',
  'BATCH001 작업 상태 알려줘',
  '홍길동 고객 주문 상태 알려줘',
];

// 입력창 타이핑마다 전체 대화가 다시 렌더되지 않도록 메시지 하나를 분리해 memo한다
// (assistant 답변은 markdown 파싱 비용이 있어 대화가 길어질수록 체감된다)
const Message = memo(function Message({ role, text, trace }) {
  return (
    <div className={`row ${role}`}>
      <div className={`bubble ${role}`}>
        {role === 'assistant'
          ? <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
          : text}
        {trace?.length > 0 && (
          <details className="trace">
            <summary>⚡ 실행된 쿼리 {trace.length}건</summary>
            {trace.map((t, j) => (
              <pre key={j}>
                {t.query_name} {JSON.stringify(t.params)}
                {'\n'}{t.error ? `오류: ${t.error}` : `${t.rowCount}건: ${JSON.stringify(t.rows)}`}
              </pre>
            ))}
          </details>
        )}
      </div>
    </div>
  );
});

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);
  const historyRef = useRef([]);      // 서버로 보낼 대화 이력 (setState 비동기와 무관하게 즉시 반영)
  const composingRef = useRef(false); // IME 조합 진행 중
  const justComposedRef = useRef(false); // 직전 조합을 확정한 키 입력이 아직 끝나지 않음

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function ask(message) {
    if (!message || loading) return;
    // history는 현재 질문을 넣기 전에 확정한다 — 현재 질문은 message로 따로 가므로 중복 전송하지 않는다.
    // 서버가 쓰는 만큼만 보낸다 (턴 수·길이 모두). 더 보내도 서버가 버리고 본문만 커진다.
    const history = historyRef.current
      .slice(-HISTORY_TURNS)
      .map(m => ({ role: m.role, text: m.text.slice(0, HISTORY_LEN) }));
    historyRef.current = [...historyRef.current, { role: 'user', text: message }];
    setMessages(m => [...m, { role: 'user', text: message }]);
    setInput('');
    setLoading(true);
    let answer = '서버와 통신하지 못했습니다.';
    let trace;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 서버는 상태를 저장하지 않으므로 최근 대화를 함께 보낸다 (후속 질문 해석용)
        body: JSON.stringify({ message, history }),
      });
      const data = await res.json();
      answer = data.answer ?? data.error;
      trace = data.trace;
    } catch {
      // answer는 통신 오류 기본값 유지
    } finally {
      // 오류 응답도 이력에 남겨 화면과 서버로 보내는 대화가 항상 일치하게 한다
      historyRef.current = [...historyRef.current, { role: 'assistant', text: answer }];
      setMessages(m => [...m, { role: 'assistant', text: answer, trace }]);
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="logo">S</div>
        <div>
          <h1><span>SPACE VOC</span> Agent</h1>
          <p>지식 · 운영 DB 조회 기반 Q&amp;A</p>
        </div>
      </header>

      <main className="chat">
        {messages.length === 0 && !loading && (
          <div className="empty">
            <div className="empty-icon">S</div>
            <h2>무엇을 도와드릴까요?</h2>
            <p>저장된 지식과 운영 DB 조회를 결합해 답변합니다.</p>
            <div className="chips">
              {EXAMPLES.map(x => (
                <button key={x} className="chip" onClick={() => ask(x)}>{x}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => <Message key={i} {...m} />)}

        {loading && (
          <div className="row assistant">
            <div className="bubble assistant">
              <div className="typing"><i /><i /><i /></div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      <div className="composer-wrap">
        <form className="composer" onSubmit={e => { e.preventDefault(); ask(input.trim()); }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => {
              composingRef.current = false;
              // 조합을 확정한 그 키 입력은 아직 keyup 전이다. Safari는 이 순서에서
              // compositionend를 keydown보다 먼저 보내 Enter가 isComposing=false로 도착하므로,
              // "확정 키의 keyup이 올 때까지"를 기준으로 한 번만 흘려보낸다 (시간 재기 대신 이벤트 순서로 판별).
              justComposedRef.current = true;
            }}
            onKeyUp={() => { justComposedRef.current = false; }}
            onBlur={() => { justComposedRef.current = false; }}
            onKeyDown={e => {
              if (e.key !== 'Enter') {
                justComposedRef.current = false;
                return;
              }
              // 조합 중 Enter는 폼 제출까지 막는다 — 한글 IME에서 조합 확정 Enter가 오전송되는 문제 방지.
              e.preventDefault();
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || composingRef.current) return;
              if (justComposedRef.current) {
                justComposedRef.current = false;
                return;
              }
              ask(input.trim());
            }}
            placeholder="질문을 입력하세요 (예: BATCH001 작업 상태 알려줘)"
            maxLength={2000}  /* 입력 단계 안내용 — 실제 제한은 서버가 검증한다 (server.js) */
            autoFocus
          />
          <button className="send" disabled={loading || !input.trim()} aria-label="전송">➤</button>
        </form>
      </div>
    </div>
  );
}
