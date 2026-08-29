import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const EXAMPLES = [
  'SPACE 시스템이 뭐야',
  'BATCH001 작업 상태 알려줘',
  '홍길동 고객 주문 상태 알려줘',
];

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);
  const historyRef = useRef([]);   // 서버로 보낼 대화 이력 (setState 비동기와 무관하게 즉시 반영)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function ask(message) {
    if (!message || loading) return;
    // history는 현재 질문을 넣기 전에 확정한다 — 현재 질문은 message로 따로 가므로 중복 전송하지 않는다
    const history = historyRef.current.slice(-6);
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

        {messages.map((m, i) => (
          <div key={i} className={`row ${m.role}`}>
            <div className={`bubble ${m.role}`}>
              {m.role === 'assistant'
                ? <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown></div>
                : m.text}
              {m.trace?.length > 0 && (
                <details className="trace">
                  <summary>⚡ 실행된 쿼리 {m.trace.length}건</summary>
                  {m.trace.map((t, j) => (
                    <pre key={j}>
                      {t.query_name} {JSON.stringify(t.params)}
                      {'\n'}{t.error ? `오류: ${t.error}` : `${t.rowCount}건: ${JSON.stringify(t.rows)}`}
                    </pre>
                  ))}
                </details>
              )}
            </div>
          </div>
        ))}

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
            onKeyDown={e => {
              if (e.key !== 'Enter') return;
              // 조합 중 Enter는 폼 제출까지 막는다 — 한글 IME에서 조합 확정 Enter가 오전송되는 문제 방지.
              e.preventDefault();
              if (!e.nativeEvent.isComposing) ask(input.trim());
            }}
            placeholder="질문을 입력하세요 (예: BATCH001 작업 상태 알려줘)"
            autoFocus
          />
          <button className="send" disabled={loading || !input.trim()} aria-label="전송">➤</button>
        </form>
      </div>
    </div>
  );
}
