import { useState, useRef, useEffect, useLayoutEffect, memo } from 'react';
import ReactMarkdown from 'react-markdown';
// 수식 표기의 계약(무엇이 수식인가 + 그것을 어떻게 그리는가)은 전부 math.js에 있다.
import { REMARK_PLUGINS, REHYPE_PLUGINS } from './math.js';

// 서버(agent.js normalizeChat)가 실제로 쓰는 상한과 같은 값. 서버 쪽 제한은 본문을 파싱한 뒤에
// 적용되므로 요청 크기를 실제로 묶어두는 것은 이쪽뿐이다 — 넘기면 express의 본문 크기 제한에 걸려
// 이후 모든 요청이 같은 이유로 실패한다(이력은 줄지 않으므로 대화가 복구되지 않는다).
const HISTORY_TURNS = 6;
const HISTORY_LEN = 1500;

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
          ? <div className="md">
              {/* 플러그인 배열은 math.js의 상수를 그대로 쓴다 — react-markdown은 렌더마다 options로
                  파이프라인을 다시 조립하므로, 여기서 새 배열 리터럴을 만들면 매 렌더가 프로세서 재구축이 된다. */}
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>{text}</ReactMarkdown>
            </div>
          : text}
        {trace?.length > 0 && (
          <details className="trace">
            <summary>⚡ 실행된 쿼리 {trace.length}건</summary>
            {trace.map((t, j) => (
              <pre key={j}>
                {/* 대상 DB가 여럿인 쿼리는 쿼리 이름만으로 무엇을 조회했는지 알 수 없다.
                    대상이 하나인 등록에서도 함께 보여준다 — 있고 없고가 등록 형태에 따라 갈리면
                    같은 화면이 어떤 줄에서만 DB를 밝히게 되어 그 차이가 뜻으로 읽힌다.
                    실행되지 않은 스텝(오류·미등록)에는 서버가 값을 주지 않을 수 있다. */}
                {t.query_name}{t.targetDb ? `@${t.targetDb}` : ''} {JSON.stringify(t.params)}
                {/* 조회 건수와 여기 실린 행 수는 다를 수 있다 — 몇 건을 보고 있는지 밝히지 않으면
                    사용자가 이 표본을 전부로 읽는다 (서버 result.js clientTrace가 omittedRows를 준다) */}
                {'\n'}{t.error
                  ? `오류: ${t.error}`
                  : `${t.rowCount}건${t.omittedRows ? ` (아래는 그중 ${t.rows.length}건)` : ''}: ${JSON.stringify(t.rows)}`}
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
  const inputRef = useRef(null);
  const historyRef = useRef([]);      // 서버로 보낼 대화 이력 (setState 비동기와 무관하게 즉시 반영)
  const composingRef = useRef(false); // IME 조합 진행 중
  const pendingSendRef = useRef(false); // 조합 중에 눌린 Enter — 조합이 확정되면 그때 보낸다
  const sendingRef = useRef(false);   // 전송 진행 중 (loading state와 달리 같은 tick에도 즉시 보인다)
  const abortRef = useRef(null);      // 진행 중인 요청 (홈으로 돌아갈 때 끊는다)
  // 대화의 세대 번호. 홈으로 돌아갈 때마다 올라가고, ask는 시작 시점의 값을 들고 있다가
  // 응답을 반영하기 전에 대조한다 — 끊긴 요청의 뒤늦은 응답이 새 대화에 끼어드는 것을 막는다.
  const sessionRef = useRef(0);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // textarea는 내용이 늘어도 스스로 커지지 않는다 — 줄 수에 맞춰 높이를 직접 맞춘다.
  // 최대 높이는 CSS(max-height)가 잡고, 그 뒤로는 입력창 안에서 스크롤된다.
  // useEffect가 아니라 useLayoutEffect인 이유: 그리기 전에 높이가 정해져야 한 프레임 깜빡이지 않는다.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // 지금 높이를 먼저 풀어야 한다 — 그러지 않으면 scrollHeight가 이미 늘어난 높이에 갇혀
    // 줄을 지워도 다시 줄어들지 않는다 (한 번 커지면 그대로 남는다).
    el.style.height = 'auto';
    // 빈 입력창은 재지 않고 rows=1이 정한 높이를 그대로 쓴다. 잴 내용이 없기도 하지만,
    // 무엇보다 mount 직후의 첫 측정은 레이아웃이 아직 서지 않아 엉뚱한 값(수백 px)을 준다 —
    // 그 값이 인라인 높이로 굳으면 빈 입력창이 처음부터 세 배 크기로 열린다.
    if (input) el.style.height = `${el.scrollHeight}px`;
    // 스크롤은 높이가 max-height에 걸려 내용이 남을 때만 켠다. 늘 켜 두면 스크롤할 것이 없어도
    // 세로 스크롤바가 자리를 차지해 입력창이 좁아 보인다 (브라우저·OS 설정에 따라 늘 보인다).
    el.style.overflowY = el.scrollHeight > el.clientHeight ? 'auto' : 'hidden';
    // 최대 높이에 걸린 뒤로는 높이가 늘지 않으므로, 새로 생긴 줄은 화면 밖에 있다 —
    // 커서가 맨 끝에 있으면 그 줄이 보이게 내린다. 그러지 않으면 Alt+Enter로 줄을 바꿔도
    // 화면은 그대로여서 보이지 않는 곳에 글을 쓰게 된다.
    // (커서가 글 중간이면 건드리지 않는다 — 그때는 브라우저가 알아서 커서를 따라간다)
    if (el.scrollHeight > el.clientHeight && el.selectionStart === el.value.length) {
      el.scrollTop = el.scrollHeight;
    }
  }, [input]);

  // loading은 state라 같은 tick에 두 번 호출되면 두 번 다 false로 읽힐 수 있다 —
  // 실제 중복 전송을 막는 것은 ref 쪽이다 (state는 버튼 비활성화 등 렌더에만 쓴다).
  const canSend = () => !loading && !sendingRef.current;

  // 첫 화면(빈 상태)으로 되돌린다. 화면이 하나뿐이라 '홈으로 이동'은 곧 대화를 접는 것이다.
  // 답을 기다리는 중에도 눌릴 수 있다 — 요청 상한이 450초라 그때까지 막아두면
  // 사실상 되돌아갈 수 없는 시간이 생긴다. 그래서 진행 중인 요청은 여기서 끊는다.
  function goHome() {
    // 세대를 먼저 올린다. abort가 일으키는 ask의 finally가 이 값을 보고 자기 응답을 버린다
    // (아래에서 내리는 loading·sendingRef를 그쪽이 다시 건드리지 않게 하는 것도 이 대조다).
    sessionRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    sendingRef.current = false;
    pendingSendRef.current = false; // 조합 중에 눌려 대기하던 Enter도 함께 없앤다
    historyRef.current = [];
    setMessages([]);
    setInput('');
    setLoading(false);
    inputRef.current?.focus();
  }

  // 입력창에서 보내는 경로. setInput('')을 ask가 아니라 여기서 하는 이유:
  // ask는 예시 칩(ask(x))에서도 불리는데, 거기서 입력창을 비우면 사용자가 쓰던 초안이
  // 보낸 적도 없이 사라진다(빈 상태 화면은 입력 중에도 칩을 계속 보여준다).
  // 전송이 실제로 받아들여질 때만 비우도록 가드도 여기서 함께 본다.
  // 보낼 글자를 인자로도 받는 이유: 조합 확정 시점의 최종 문자열은 입력창(DOM)에만 확실히 있다.
  // state는 마지막 input 이벤트가 compositionend보다 뒤에 오는 브라우저에서 한 글자 뒤처진다.
  function submitInput(text = input) {
    const message = text.trim();
    if (!message || !canSend()) return;
    setInput('');
    ask(message);
  }

  // 조합을 지금 끝낸다. 포커스를 뺐다가 되돌리면 IME가 조합 중이던 글자를 확정한다 —
  // 조합 중인 입력창의 값을 건드려도 되는 상태로 만드는 방법이 이것뿐이다.
  // (조합 중에 값을 갈아끼우면 뒤늦은 확정이 그 위에 덮여 글자가 뒤엉킨다)
  function endComposition(el) {
    const { selectionStart, selectionEnd } = el;
    el.blur();
    el.focus();
    // 포커스를 되찾을 때 커서를 글 끝으로 밀어버리는 브라우저가 있다 — 있던 자리로 되돌린다.
    el.setSelectionRange(selectionStart, selectionEnd);
    // 보통은 위 blur가 compositionend를 일으켜 이 표시가 내려가지만, 그것까지 기다리지 않는다.
    // 조합이 끝난 것은 방금 우리가 한 일이고, 이 표시가 켜진 채 남으면 그 뒤로 Enter가
    // 영영 "조합 중"으로 취급돼 전송이 통째로 멈춘다.
    composingRef.current = false;
  }

  // 줄바꿈은 직접 끼워 넣는다 — Enter를 preventDefault로 막았으므로 브라우저가 넣어주지 않는다.
  // execCommand는 폐기 예정이지만 이 용도는 아직 모든 브라우저가 지원하고, 값을 직접 갈아끼우는 것과 달리
  // 진짜 input 이벤트를 일으켜 controlled state가 따라오고 되돌리기(Ctrl+Z) 이력도 남는다.
  function insertNewline(el) {
    if (document.execCommand('insertText', false, '\n')) return;
    // 막혔을 때의 대비. 이게 없으면 Alt+Enter가 아무 일도 하지 않는 것처럼 보인다.
    const { selectionStart: start, selectionEnd: end, value } = el;
    setInput(`${value.slice(0, start)}\n${value.slice(end)}`);
    // 커서는 React가 새 값을 그린 뒤에 옮긴다 — 지금 옮기면 그 렌더가 커서를 맨 뒤로 되돌린다.
    queueMicrotask(() => el.setSelectionRange(start + 1, start + 1));
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
    // 이 요청이 속한 대화. finally에서 아직 같은 대화인지 확인하는 데 쓴다 (goHome 참고).
    const session = sessionRef.current;
    try {
      sendingRef.current = true;
      // AbortSignal.timeout()이 아니라 AbortController를 쓴다 — 전자는 Chrome 103/Safari 16 이상이고
      // Vite 기본 빌드 타깃(chrome87/safari14)은 문법만 변환할 뿐 런타임 API를 폴리필하지 않는다.
      // 구형 브라우저에서 fetch 호출 전에 TypeError가 나고, 그게 아래 catch에 삼켜져
      // 모든 질문이 "서버와 통신하지 못했습니다"로 보인다 — 백엔드 장애와 구분이 안 된다.
      const ctrl = new AbortController();
      abortRef.current = ctrl; // 홈으로 돌아갈 때 끊을 수 있도록 내둔다
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
      // 그사이 홈으로 돌아갔다면(세대가 다르면) 이 답은 이미 지난 대화의 것이다 — 비운 화면에
      // 떨어뜨리지 않는다. loading·sendingRef도 goHome이 이미 정리했으므로 건드리지 않는다
      // (여기서 내리면 그 뒤에 시작된 새 요청의 상태를 지우게 된다).
      if (sessionRef.current === session) {
        abortRef.current = null;
        if (answered) historyRef.current = [...historyRef.current, { role: 'assistant', text: answer }];
        setMessages(m => [...m, { role: 'assistant', text: answer, trace }]);
        setLoading(false);
        sendingRef.current = false;
      }
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
        {/* 대화가 없고 기다리는 것도 없으면 되돌아갈 곳이 없다 — 그때는 눌리지 않게 둔다
            (입력창의 초안은 홈이 아니어도 남는 것이므로 이 판단에 넣지 않는다). */}
        <button
          type="button"
          className="home-btn"
          onClick={goHome}
          disabled={messages.length === 0 && !loading}
          title="새 대화로 시작합니다"
        >
          <span aria-hidden="true">⌂</span><span className="home-label">홈</span>
        </button>
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
          <textarea
            ref={inputRef}
            rows={1}  /* 높이는 위 useLayoutEffect가 내용에 맞춰 준다 — 여기서는 시작 높이만 잡는다 */
            value={input}
            onChange={e => setInput(e.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={e => {
              composingRef.current = false;
              if (!pendingSendRef.current) return;
              pendingSendRef.current = false;
              // 조합 중에 눌린 Enter를 여기서 갚는다. 한글은 마지막 글자가 늘 조합 중이라
              // 그 Enter를 버리면 사용자는 언제나 Enter를 두 번 눌러야 한다.
              // 보낼 글자는 state가 아니라 입력창의 값에서 읽는다 (submitInput 주석 참고).
              submitInput(e.currentTarget.value);
            }}
            // Enter가 조합을 확정하지 못한 채 삼켜졌을 수도 있다. 그때 이 표시가 남아 있으면
            // 한참 뒤 엉뚱한 조합이 끝나는 순간 전송된다 — 입력창을 떠날 때 확실히 지운다.
            onBlur={() => { pendingSendRef.current = false; }}
            onKeyDown={e => {
              if (e.key !== 'Enter') {
                pendingSendRef.current = false; // 위와 같은 이유 (계속 타이핑하면 그 Enter는 없던 일이다)
                return;
              }
              const el = e.currentTarget;
              const composing = e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || composingRef.current;
              // 브라우저 기본 동작(줄바꿈)을 막는다 — 줄을 바꿀지 보낼지는 여기서 직접 정한다.
              e.preventDefault();
              // Alt+Enter가 줄바꿈. Shift+Enter도 함께 받는다 — 다른 채팅 입력창에서 손이 먼저
              // 기억하는 조합이라, 여기서만 전송이 되면 쓰다 만 글이 그대로 나간다.
              if (e.altKey || e.shiftKey) {
                // 줄바꿈은 조합이 끝나기를 기다리지 않는다. IME는 Alt가 눌린 Enter를 확정 키로
                // 보지 않고 그냥 흘려보내기도 하는데, 그러면 compositionEnd가 영영 오지 않아
                // 기다리던 줄바꿈이 통째로 사라진다 — 조합을 직접 끝내고 지금 넣는다.
                if (composing) endComposition(el);
                insertNewline(el);
                return;
              }
              // 전송은 미룬다. 조합 중에 보내면 아직 확정되지 않은 글자가 빠지고,
              // 뒤늦은 확정이 이미 비워둔 입력창에 다시 들어온다.
              // (Enter는 IME가 확정 키로 받으므로 compositionEnd가 곧바로 따라온다)
              if (composing) {
                pendingSendRef.current = true;
                return;
              }
              // Safari는 compositionend를 keydown보다 먼저 보내 확정 Enter가 여기로 온다 — 그대로 보낸다.
              submitInput();
            }}
            placeholder="질문을 입력하세요 (Alt+Enter 줄바꿈)"
            maxLength={2000}  /* 입력 단계 안내용 사본 — 실제 제한은 서버가 검증한다 (backend constants.js MAX_QUESTION_LEN) */
            autoFocus
          />
          <button className="send" disabled={loading || !input.trim()} aria-label="전송">➤</button>
        </form>
      </div>
    </div>
  );
}
