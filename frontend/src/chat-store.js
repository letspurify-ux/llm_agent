// 대화를 이 탭의 sessionStorage에 둔다. 화면의 대화는 React 상태에만 있어서, 페이지가 어떤 이유로든
// 새로 열리면(개발 서버의 재연결 새로고침, 실수로 누른 F5, 브라우저의 탭 복원) 통째로 사라졌다.
// 같은 탭에서 다시 열면 말풍선·서버로 보낼 이력·대화 번호를 그대로 되살린다 — 대화 번호가 같으니
// 서버가 아직 들고 있는 맥락(앞 턴의 조회 결과)도 이어진다. 새 탭은 sessionStorage가 따로라 새 대화다.
const KEY = 'llm-agent.chat.v1';

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.sessionStorage ?? null; } catch { return null; } // 저장소를 막은 브라우저
}

const isTurn = t => t && typeof t === 'object' && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string';

// 저장해 둔 대화. 없거나 읽을 수 없으면(형식이 다르거나 깨졌으면) null — 그때는 새 대화로 시작한다.
export function loadChat(storage) {
  const store = storageOf(storage);
  try {
    const data = JSON.parse(store?.getItem(KEY) ?? 'null');
    if (!data || typeof data.conversationId !== 'string' || !data.conversationId
      || !Array.isArray(data.messages) || !data.messages.every(isTurn)
      || !Array.isArray(data.history) || !data.history.every(isTurn)) return null;
    return { conversationId: data.conversationId, messages: data.messages, history: data.history };
  } catch {
    return null;
  }
}

// 대화를 저장한다. 용량(브라우저마다 5MB 안팎)을 넘으면 앞 답변의 실행 결과(trace — 조회 행이 대부분)부터
// 덜어 내고, 그래도 넘으면 오래된 말풍선부터 덜어 낸다. 서버로 보낼 이력은 짧아서(최근 몇 턴의 글) 그대로 둔다.
// 끝내 못 넣으면 지난 저장본을 지운다 — 옛 대화가 되살아나 지금 대화인 척하면 안 된다.
export function saveChat({ conversationId, messages, history }, storage) {
  const store = storageOf(storage);
  if (!store) return false;
  const attempt = list => {
    try {
      store.setItem(KEY, JSON.stringify({ conversationId, messages: list, history }));
      return true;
    } catch {
      return false;
    }
  };
  if (attempt(messages)) return true;
  const slim = messages.map((m, i) => (i === messages.length - 1 || !m.trace ? m : { ...m, trace: undefined }));
  if (attempt(slim)) return true;
  for (let start = 1; start < slim.length; start += 1) {
    if (attempt(slim.slice(start))) return true;
  }
  try { store.removeItem(KEY); } catch { /* 지울 수도 없으면 그대로 둔다 */ }
  return false;
}
