import test from 'node:test';
import assert from 'node:assert/strict';
import { loadChat, saveChat, openChat, closeChat, markChatOpen, rememberTurn, HISTORY_TURNS } from '../src/chat-store.js';

function memory(limit = Infinity) {
  const items = new Map();
  return {
    getItem: k => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => {
      if (v.length > limit) throw new DOMException('quota', 'QuotaExceededError');
      items.set(k, v);
    },
    removeItem: k => items.delete(k),
    size: () => [...items.values()].reduce((n, v) => n + v.length, 0),
    // 탭 복제: 저장소를 통째로 복사한 새 탭.
    copy: () => {
      const copied = memory(limit);
      for (const [k, v] of items) copied.setItem(k, v);
      return copied;
    },
  };
}

const chat = {
  conversationId: 'c1',
  messages: [
    { role: 'user', text: '홍길동 주문?' },
    { role: 'assistant', text: '3건입니다.', trace: [{ step: 1, rows: [{ ID: 1 }] }], stopped: false },
  ],
  history: [{ role: 'user', text: '홍길동 주문?' }, { role: 'assistant', text: '3건입니다.' }],
};

test('같은 탭에서 다시 열면 말풍선·이력·대화 번호가 그대로 돌아온다', () => {
  const store = memory();
  assert.equal(saveChat(chat, store), true);
  assert.deepEqual(loadChat(store), chat);
});

test('없거나 깨졌거나 형식이 다르면 새 대화로 시작한다', () => {
  assert.equal(loadChat(memory()), null);
  assert.equal(loadChat(null), null);
  const store = memory();
  store.setItem('llm-agent.chat.v1', '{not json');
  assert.equal(loadChat(store), null);
  store.setItem('llm-agent.chat.v1', JSON.stringify({ ...chat, messages: [{ role: 'system', text: 'x' }] }));
  assert.equal(loadChat(store), null);
  store.setItem('llm-agent.chat.v1', JSON.stringify({ ...chat, conversationId: '' }));
  assert.equal(loadChat(store), null);
});

test('용량을 넘으면 앞 답변의 실행 결과부터, 그다음 오래된 말풍선부터 덜어 낸다', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ ID: i, NAME: '가'.repeat(20) }));
  const big = {
    ...chat,
    messages: [
      { role: 'user', text: '첫 질문' },
      { role: 'assistant', text: '첫 답', trace: [{ step: 1, rows }] },
      { role: 'user', text: '둘째 질문' },
      { role: 'assistant', text: '둘째 답', trace: [{ step: 2, rows: rows.slice(0, 2) }] },
    ],
  };
  const full = JSON.stringify(big).length;
  const store = memory(full - 1);
  assert.equal(saveChat(big, store), true);
  const kept = loadChat(store);
  assert.equal(kept.messages.length, 4);
  assert.equal(kept.messages[1].trace, undefined, '앞 답변의 행을 덜었다');
  assert.deepEqual(kept.messages[3].trace, big.messages[3].trace, '마지막 답은 그대로');

  const tight = memory(JSON.stringify({ ...big, messages: big.messages.slice(2) }).length);
  assert.equal(saveChat(big, tight), true);
  assert.deepEqual(loadChat(tight).messages.map(m => m.text), ['둘째 질문', '둘째 답']);
});

// 컨텍스트 관리 검토 8차: 서버로 보내는 이력은 최근 HISTORY_TURNS턴뿐인데 화면은 대화의 모든 턴을 이력으로
// 들고 통째로 저장했다 — 긴 대화에서는 보내지도 않을 옛 답변이 저장 용량을 차지해, 용량을 넘으면 말풍선부터
// 덜어 내고 끝내 이력만으로 넘으면 저장본을 지워 새로고침에 대화(대화 번호까지)를 잃었다.
test('이력은 서버가 쓰는 최근 턴만 저장하고, 그 때문에 말풍선을 덜어 내지 않는다', () => {
  const turns = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `${i}번째 턴 `.repeat(400) }));
  const big = { conversationId: 'c1', messages: turns.map(t => ({ ...t })), history: turns };
  const needed = JSON.stringify({ ...big, history: turns.slice(-HISTORY_TURNS) }).length;
  const store = memory(needed);
  assert.equal(saveChat(big, store), true);
  const kept = loadChat(store);
  assert.equal(kept.messages.length, 40, '말풍선은 모두 남는다');
  assert.deepEqual(kept.history, turns.slice(-HISTORY_TURNS));
  // 예전 저장본(모든 턴)을 읽어도 최근 턴만 이력으로 쓴다.
  const old = memory();
  old.setItem('llm-agent.chat.v1', JSON.stringify(big));
  assert.deepEqual(loadChat(old).history, turns.slice(-HISTORY_TURNS));
  assert.deepEqual(rememberTurn(turns.slice(-HISTORY_TURNS), { role: 'user', text: '다음' }), [...turns.slice(-HISTORY_TURNS + 1), { role: 'user', text: '다음' }]);
});

// 자원 누수 검토 9차: 용량을 넘긴 대화는 말풍선을 하나씩 덜어 가며 다시 넣었다 — 시도마다 대화 전체를 글자로
// 만들어, 답이 올 때마다 말풍선 수만큼 되풀이했다(Chrome 실측: 말풍선 300개에 답 하나 1초, 대화가 길수록 늘었다).
// 그리고 마지막 답의 행 하나가 용량을 넘으면 그 모든 시도가 실패해 들어갈 수 있던 말풍선까지 저장본째 지웠다.
test('용량을 넘긴 긴 대화도 몇 번의 시도로 들어가는 가장 긴 뒤쪽을 저장한다', () => {
  const messages = Array.from({ length: 600 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `${i}번 `.repeat(50) }));
  const big = { conversationId: 'c1', messages, history: [] };
  const limit = JSON.stringify({ ...big, messages: messages.slice(-137) }).length;
  const store = memory(limit);
  let calls = 0;
  const counted = { ...store, setItem: (k, v) => { calls += 1; store.setItem(k, v); } };
  assert.equal(saveChat(big, counted), true);
  assert.equal(loadChat(store).messages.length, 137, '들어가는 만큼은 모두 남는다');
  assert.ok(calls <= 2 + Math.ceil(Math.log2(messages.length)) + 1, `시도 ${calls}번`);
});

test('마지막 답의 행만으로 넘치면 그 행만 덜고 말풍선은 남긴다', () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ ID: i, DOC: '가'.repeat(40) }));
  const messages = [
    { role: 'user', text: '첫 질문' },
    { role: 'assistant', text: '첫 답', trace: [{ step: 1, rows: rows.slice(0, 3) }] },
    { role: 'user', text: '둘째 질문' },
    { role: 'assistant', text: '둘째 답', trace: [{ step: 2, rows }] },
  ];
  const big = { conversationId: 'c1', messages, history: [] };
  const store = memory(JSON.stringify({ ...big, messages: messages.map(m => ({ ...m, trace: undefined })) }).length);
  assert.equal(saveChat(big, store), true);
  const kept = loadChat(store);
  assert.deepEqual(kept.messages.map(m => m.text), ['첫 질문', '첫 답', '둘째 질문', '둘째 답']);
  assert.ok(kept.messages.every(m => m.trace === undefined));
  // 행을 덜어도 넘치면 오래된 말풍선부터 덜어 낸다.
  const tight = memory(JSON.stringify({ ...big, messages: [{ role: 'user', text: '둘째 질문' }, { role: 'assistant', text: '둘째 답' }] }).length);
  assert.equal(saveChat(big, tight), true);
  assert.deepEqual(loadChat(tight).messages.map(m => m.text), ['둘째 질문', '둘째 답']);
});

// 하나씩 덜어 가던 예전 방식이 남기던 것과 같은 것을 남기는가 (그 방식이 들어가는 경우에 한해 — 마지막 행만으로
// 넘치던 경우는 예전에는 저장본을 지웠다).
test('반씩 좁혀 찾은 저장본은 하나씩 덜어 낸 것과 같다', () => {
  let seed = 7;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 300; round += 1) {
    const messages = Array.from({ length: 1 + rand(40) }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(1 + rand(200)),
      ...(i % 2 && rand(2) ? { trace: [{ step: i, rows: Array.from({ length: rand(30) }, () => ({ V: 'y'.repeat(rand(50)) })) }] } : {}),
    }));
    const chatNow = { conversationId: 'c', messages, history: [] };
    const limit = rand(JSON.stringify(chatNow).length + 50);
    const expected = (() => {
      const store = memory(limit);
      const put = list => { try { store.setItem('k', JSON.stringify({ ...chatNow, messages: list })); return true; } catch { return false; } };
      if (put(messages)) return messages;
      const slim = messages.map((m, i) => (i === messages.length - 1 || !m.trace ? m : { ...m, trace: undefined }));
      for (let start = 0; start < slim.length; start += 1) if (put(slim.slice(start))) return slim.slice(start);
      return null;
    })();
    const store = memory(limit);
    const ok = saveChat(chatNow, store);
    if (expected) {
      assert.equal(ok, true);
      assert.deepEqual(loadChat(store).messages, JSON.parse(JSON.stringify(expected)), `round ${round}`);
    } else if (ok) {
      // 예전에는 지우던 경우 — 이제는 행을 모두 덜고 들어가는 만큼 남긴다.
      assert.ok(loadChat(store).messages.every(m => m.trace === undefined), `round ${round}`);
    } else {
      assert.equal(loadChat(store), null, `round ${round}`);
    }
  }
});

test('끝내 못 넣으면 지난 저장본을 지워 옛 대화가 되살아나지 않게 한다', () => {
  const store = memory();
  saveChat(chat, store);
  const tiny = { ...store, setItem: () => { throw new Error('quota'); } };
  assert.equal(saveChat({ ...chat, conversationId: 'c2' }, tiny), false);
  assert.equal(loadChat(store), null);
});

test('복제한 탭은 말풍선·이력을 이어 받되 대화 번호는 새로 받는다 (새로고침은 같은 번호)', () => {
  const tab = memory();
  saveChat(chat, tab);
  assert.deepEqual(openChat(tab), chat, '처음 연 탭');
  // 그 탭이 대화를 보여 주는 동안 복제하면 저장소(대화 번호 포함)가 복사된다 — 같은 번호를 쓰면 두 탭의
  // 질문이 서버의 한 대화에 섞이고 서로의 진행 중인 답을 취소한다.
  const twin = tab.copy();
  const forked = openChat(twin);
  assert.equal(forked.conversationId, null, '새 번호를 만들게 한다');
  assert.deepEqual(forked.messages, chat.messages);
  assert.deepEqual(forked.history, chat.history);
  // 새로고침(떠날 때 표시를 지우고 다시 연다)은 같은 대화다.
  closeChat(tab);
  assert.deepEqual(openChat(tab), chat);
  // 뒤로 가기 캐시에서 되살아난 탭도 다시 연 것으로 친다 — 그 뒤의 복제도 알아본다.
  closeChat(tab);
  markChatOpen(tab);
  assert.equal(openChat(tab.copy()).conversationId, null);
  // 저장해 둔 대화가 없으면 복제여도 null(새 대화)이다.
  const empty = memory();
  openChat(empty);
  assert.equal(openChat(empty.copy()), null);
});
