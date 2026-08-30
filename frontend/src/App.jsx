import { useState, useRef, useEffect, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// 서버(agent.js normalizeChat)가 실제로 쓰는 상한과 같은 값. 서버 쪽 제한은 본문을 파싱한 뒤에
// 적용되므로 요청 크기를 실제로 묶어두는 것은 이쪽뿐이다 — 넘기면 express의 본문 크기 제한에 걸려
// 이후 모든 요청이 같은 이유로 실패한다(이력은 줄지 않으므로 대화가 복구되지 않는다).
const HISTORY_TURNS = 6;
const HISTORY_LEN = 500;

// 단순 slice는 경계의 서로게이트 쌍(이모지 등)을 반으로 쪼개 짝 잃은 코드유닛을 남기고,
// 그 값은 서버를 거쳐 LLM 프롬프트로 가는 인코딩 단계에서 U+FFFD로 조용히 훼손된다.
// 경계에 걸린 상위 서로게이트 하나를 떼어 항상 온전한 문자열만 보낸다 (서버 constants.clipText와 같은 방식).
const clipTurn = s => {
  const t = String(s ?? '').slice(0, HISTORY_LEN);
  const last = t.charCodeAt(t.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? t.slice(0, -1) : t;
};

// 요청 상한. 서버 최악 = 루프 진입 예산 180초(agent.js MAX_LOOP_MS) + 마지막 LLM 호출 120초
// + 강제 답변 120초 ≈ 420초이므로 그보다 뒤에 둔다. 짧게 잡으면 서버가 답을 만들어 보내는 중에
// 클라이언트가 먼저 끊어 "서버와 통신하지 못했습니다"로 뭉개진다.
// 이게 없으면 반대로 서버가 응답하지 않을 때 타이핑 표시가 영원히 돈다.
const REQUEST_TIMEOUT_MS = 450_000;

const EXAMPLES = [
  'SPACE 시스템이 뭐야?',
  'VM Agent Dashboard 현황 알려줘',
  '너는 어떤 일을 할 수 있어?',
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
  const sendingRef = useRef(false);   // 전송 진행 중 (loading state와 달리 같은 tick에도 즉시 보인다)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // loading은 state라 같은 tick에 두 번 호출되면 두 번 다 false로 읽힐 수 있다 —
  // 실제 중복 전송을 막는 것은 ref 쪽이다 (state는 버튼 비활성화 등 렌더에만 쓴다).
  const canSend = () => !loading && !sendingRef.current;

  // 입력창에서 보내는 경로. setInput('')을 ask가 아니라 여기서 하는 이유:
  // ask는 예시 칩(ask(x))에서도 불리는데, 거기서 입력창을 비우면 사용자가 쓰던 초안이
  // 보낸 적도 없이 사라진다(빈 상태 화면은 입력 중에도 칩을 계속 보여준다).
  // 전송이 실제로 받아들여질 때만 비우도록 가드도 여기서 함께 본다.
  function submitInput() {
    const message = input.trim();
    if (!message || !canSend()) return;
    setInput('');
    ask(message);
  }

  async function ask(message) {
    if (!message || !canSend()) return;
    let answer = '서버와 통신하지 못했습니다.';
    let trace;
    let answered = false; // 서버가 실제로 '답'을 돌려줬는가 (통신 실패·타임아웃·서버 오류와 구분)
    let timer;            // finally에서 지운다 (세우기 전에 던졌으면 undefined — clearTimeout은 무해하다)
    // 플래그를 세우는 것까지 try 안에서 한다 — 세운 뒤 try 밖에서 무엇이든 던지면 finally가 돌지 않아
    // 플래그가 걸린 채 영구히 남는다. 그러면 화면은 멀쩡한데 전송만 막힌다
    // (loading은 false라 버튼도 활성으로 보인다). 바로 아래 AbortController가 없는 구형 브라우저가 그 경우다.
    try {
      sendingRef.current = true;
      // AbortSignal.timeout()이 아니라 AbortController를 쓴다 — 전자는 Chrome 103/Safari 16 이상이고
      // Vite 기본 빌드 타깃(chrome87/safari14)은 문법만 변환할 뿐 런타임 API를 폴리필하지 않는다.
      // 구형 브라우저에서 fetch 호출 전에 TypeError가 나고, 그게 아래 catch에 삼켜져
      // 모든 질문이 "서버와 통신하지 못했습니다"로 보인다 — 백엔드 장애와 구분이 안 된다.
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      // history는 현재 질문을 넣기 전에 확정한다 — 현재 질문은 message로 따로 가므로 중복 전송하지 않는다.
      // 서버가 쓰는 만큼만 보낸다 (턴 수·길이 모두). 더 보내도 서버가 버리고 본문만 커진다.
      const history = historyRef.current
        .slice(-HISTORY_TURNS)
        .map(m => ({ role: m.role, text: clipTurn(m.text) }));
      historyRef.current = [...historyRef.current, { role: 'user', text: message }];
      setMessages(m => [...m, { role: 'user', text: message }]);
      setLoading(true);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        // 서버는 상태를 저장하지 않으므로 최근 대화를 함께 보낸다 (후속 질문 해석용)
        body: JSON.stringify({ message, history }),
      });
      const data = await res.json();
      // ??가 아니라 ||인 이유: 빈 문자열도 걸러야 한다. undefined는 이력에 들어가면 다음 전송을 깨고,
      // ''는 빈 말풍선으로 렌더된 뒤 그 빈 턴이 다음 질문의 맥락으로 서버에 되돌아간다.
      // (답변은 항상 문자열이므로 0·false가 ||에 걸려 사라질 일은 없다)
      answer = data.answer || data.error || answer;
      trace = data.trace;
      // 오류 응답(4xx/5xx, 또는 error 필드)은 모델이 한 말이 아니다 — 이력에 넣지 않는다.
      answered = res.ok && !data.error;
    } catch (e) {
      // answer는 통신 오류 기본값 유지. 콘솔에는 남긴다 —
      // 네트워크 실패·타임아웃·클라이언트 예외가 화면에서는 모두 같은 문구로 보이기 때문이다.
      console.error('[chat] request failed:', e);
    } finally {
      clearTimeout(timer);
      // 화면에는 항상 남기지만, 서버로 되돌려 보내는 이력에는 서버가 준 답만 넣는다 —
      // 타임아웃·네트워크 실패 문구를 이력에 남기면 다음 질문의 '## 최근 대화'에
      // "에이전트: 서버와 통신하지 못했습니다."로 실려, 모델이 자기가 한 말로 알고 사과하거나 그걸 근거로 추론한다.
      if (answered) historyRef.current = [...historyRef.current, { role: 'assistant', text: answer }];
      setMessages(m => [...m, { role: 'assistant', text: answer, trace }]);
      setLoading(false);
      sendingRef.current = false;
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="logo">S</div>
        <div>
          <h1><span>SPACE</span> Assistant</h1>
          <p>지식 · 운영 DB 조회 기반</p>
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
        <form className="composer" onSubmit={e => { e.preventDefault(); submitInput(); }}>
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
              submitInput();
            }}
            placeholder="질문을 입력하세요"
            maxLength={2000}  /* 입력 단계 안내용 사본 — 실제 제한은 서버가 검증한다 (backend constants.js MAX_QUESTION_LEN) */
            autoFocus
          />
          <button className="send" disabled={loading || !input.trim()} aria-label="전송">➤</button>
        </form>
      </div>
    </div>
  );
}
