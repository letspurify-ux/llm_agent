import test from 'node:test';
import assert from 'node:assert/strict';
import { loadChat, saveChat } from '../src/chat-store.js';

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

test('끝내 못 넣으면 지난 저장본을 지워 옛 대화가 되살아나지 않게 한다', () => {
  const store = memory();
  saveChat(chat, store);
  const tiny = { ...store, setItem: () => { throw new Error('quota'); } };
  assert.equal(saveChat({ ...chat, conversationId: 'c2' }, tiny), false);
  assert.equal(loadChat(store), null);
});
