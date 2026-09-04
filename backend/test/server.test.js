// 서버가 어떤 요청에도 내려가지 않고, 어떤 요청도 답 없이 매달리지 않는다 — 실행: npm test (backend/)
//
// 이 계약은 깨져도 조용하다. express 4는 async 핸들러의 거부를 잡아 주지 않으므로 그 요청은
// 오류도 아니고 응답도 아닌 채로 열려 있고, 클라이언트는 자기 타임아웃(프런트는 450초)까지
// 기다린다 — 서버 로그에는 unhandledRejection 한 줄뿐이다. 반대로 요청 경로에서 새어 나온
// 예외 하나는 uncaughtException 핸들러를 타고 프로세스를 통째로 내린다(server.js 주석).
// 그래서 여기서는 '무엇을 답했는가'가 아니라 '반드시 답했는가, 그리고 살아 있는가'만 본다.
//
// DB도 LLM도 없이 띄운다 — 그 실패는 각 경로가 이미 처리하고, 이 검사가 보는 것은 그 위의 껍데기다.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)); });
});

let proc; let port; let 로그 = '';
const base = () => `http://127.0.0.1:${port}`;
const 살아있나 = () => !!proc && proc.exitCode === null && proc.signalCode === null;

before(async () => {
  port = await freePort();
  proc = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    // 관리 DB·LLM·임베딩은 쓰지 않는다. 주기 작업을 꺼 두는 이유는 이 검사가 보는 것이
    // 요청 경로뿐이고, 켜 두면 실패 로그가 그 위를 덮기 때문이다.
    env: { ...process.env, PORT: String(port), ORACLE_MOCK: '1', LLM_PROVIDER: '', EMBED_SYNC_INTERVAL: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => { 로그 += d; });
  proc.stderr.on('data', d => { 로그 += d; });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base()}/api/health`)).ok) return; } catch { /* 아직 안 떴다 */ }
    if (!살아있나()) break;
    await sleep(250);
  }
  throw new Error(`서버가 뜨지 않았습니다: ${로그.slice(0, 500)}`);
});

after(async () => {
  proc?.kill('SIGTERM');
  for (let i = 0; i < 40 && 살아있나(); i++) await sleep(100);
  proc?.kill('SIGKILL');
});

// 답을 반드시 받아야 한다. 매달리는 것과 늦는 것을 가르려고 시간 제한을 둔다 — 아래 요청들은
// 전부 답을 만들기 전에 거부되는 것이라 에이전트 루프까지 가지 않는다(밀리초 단위로 끝난다).
async function 답(path, init, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base() + path, { method: 'POST', signal: ctrl.signal, ...init });
    return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
  } finally { clearTimeout(timer); }
}
const J = o => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const RAW = b => ({ headers: { 'Content-Type': 'application/json' }, body: b });

// 답을 만들기 전에 거부되는 요청들만 모은다 — 여기서 재는 것은 '반드시 답한다'이지 답의 내용이 아니다.
const 이상한요청 = [
  ['message 없음', '/api/chat', J({})],
  ['message가 숫자', '/api/chat', J({ message: 1 })],
  ['message가 객체', '/api/chat', J({ message: { a: 1 } })],
  ['message가 배열', '/api/chat', J({ message: ['a'] })],
  ['message가 공백뿐', '/api/chat', J({ message: '   ' })],
  ['message가 너무 김', '/api/chat', J({ message: 'a'.repeat(5000) })],
  ['본문이 배열', '/api/chat', J([1, 2, 3])],
  ['본문이 문자열', '/api/chat', J('hello')],
  ['본문이 null', '/api/chat', J(null)],
  ['본문이 숫자', '/api/chat', J(12345)],
  ['깨진 JSON', '/api/chat', RAW('{not json')],
  ['빈 본문', '/api/chat', RAW('')],
  ['깊게 중첩된 본문', '/api/chat', RAW(`{"a":${'['.repeat(5000)}${']'.repeat(5000)}}`)],
  ['__proto__ 오염 시도', '/api/chat', RAW('{"__proto__":{"message":"오염"}}')],
  ['Content-Type 없음', '/api/chat', { body: 'message=hi' }],
  ['Content-Type이 text', '/api/chat', { headers: { 'Content-Type': 'text/plain' }, body: 'hi' }],
  ['본문 크기 초과', '/api/chat', J({ message: 'a'.repeat(2_000_000) })],
  // 압축 본문. 푸는 일은 우리 코드 밖(body-parser)에서 일어나므로 그 실패도 JSON으로 돌아와야 한다.
  // 폭탄은 '푼 뒤'의 크기로 걸려야 한다 — 압축된 크기만 보면 20KB짜리 요청이 20MB를 메모리에 푼다.
  ['깨진 gzip', '/api/chat', { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: Buffer.from('not gzip at all') }],
  ['gzip 폭탄', '/api/chat', { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x61)) }],
  ['모르는 인코딩', '/api/chat', { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'bogus' }, body: '{}' }],
  ['등록되지 않은 경로', '/api/nope', J({ message: 'hi' })],
];

test('이상한 요청도 반드시 답을 받는다 — JSON으로, 매달리지 않고', async () => {
  for (const [이름, path, init] of 이상한요청) {
    const r = await 답(path, init).catch(e => { throw new Error(`${이름}: 답이 오지 않았습니다 (${e.name})`); });
    assert.ok(r.status >= 400 && r.status < 600, `${이름}: 뜻밖의 상태 ${r.status}`);
    // HTML 오류 페이지를 주면 클라이언트의 res.json()이 던져 원인이 '통신 실패'로 뭉개진다.
    assert.match(r.type, /application\/json/, `${이름}: JSON이 아닌 응답 (${r.type})`);
    assert.ok(JSON.parse(r.body).error, `${이름}: error 필드가 없다 — ${r.body.slice(0, 80)}`);
  }
  assert.ok(살아있나(), '이상한 요청에 서버가 내려갔다');
});

test('프로토타입 오염 시도가 뒤따르는 요청의 판정을 바꾸지 못한다', async () => {
  // 위 목록의 오염 시도는 그 자체로 400이라 '거부됐다'만으로는 오염 여부를 알 수 없다.
  // Object.prototype.message가 심어졌다면 message 없는 요청의 req.body?.message가 그 값을 읽어
  // 검증을 그대로 통과한다 — 서버가 낯선 질문을 답하기 시작하는데 요청 본문에는 흔적이 없다.
  await 답('/api/chat', RAW('{"__proto__":{"message":"오염"}}'));
  const r = await 답('/api/chat', J({}));
  assert.strictEqual(r.status, 400, 'message 없는 요청이 통과했다 — Object.prototype이 오염됐다');
});

test('클라이언트가 도중에 끊어도 서버는 살아 있다 (홈 단추가 실제로 이 길이다)', async () => {
  // 프런트는 홈으로 돌아갈 때 진행 중인 요청을 abort한다 — 응답을 쓰는 중에 소켓이 사라지는
  // 이 길이 매일 밟히므로, 여기서 예외가 새면 사용자가 홈을 누를 때마다 서버가 내려간다.
  for (let i = 0; i < 8; i++) {
    const ctrl = new AbortController();
    const p = fetch(`${base()}/api/chat`, { method: 'POST', signal: ctrl.signal, ...J({ message: `끊길 질문 ${i}` }) })
      .catch(() => { /* 우리가 끊었다 */ });
    await sleep(10 + i * 5);
    ctrl.abort();
    await p;
  }
  await sleep(300);
  assert.ok(살아있나(), '요청을 끊자 서버가 내려갔다');
  assert.strictEqual((await fetch(`${base()}/api/health`)).status, 200);
});

test('HTTP로 보기 어려운 요청에도 서버는 살아 있다', async () => {
  // 본문을 다 보내지 않고 끊기, 잘못된 길이·인코딩, HTTP가 아닌 바이트. 사내망이라도 스캐너와
  // 잘못 설정된 프록시가 이런 것을 보낸다 — 그 하나가 프로세스를 내리면 화면 전체가 멈춘다.
  const raws = [
    'POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"messa',
    'POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Length: -1\r\n\r\n',
    'POST /api/chat HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n',
    'GET /../../etc/passwd HTTP/1.1\r\nHost: x\r\n\r\n',
    'BOGUS /api/chat HTTP/9.9\r\n\r\n',
    '\x16\x03\x01\x00\xa5\x01\x00\x00\xa1\x03\x03',   // TLS ClientHello를 평문 포트에
  ];
  for (const raw of raws) {
    await new Promise(res => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write(raw);
        setTimeout(() => { s.destroy(); res(); }, 50);
      });
      s.on('error', () => res());
    });
  }
  await sleep(300);
  assert.ok(살아있나(), 'HTTP로 보기 어려운 요청에 서버가 내려갔다');
  assert.strictEqual((await fetch(`${base()}/api/health`)).status, 200);
});

test('요청 경로에서 새어 나온 예외도, 답 없이 매달린 요청도 없다', async () => {
  // 앞의 세 검사가 남긴 로그를 함께 본다. 이 두 줄은 '서버가 살아 있다'만으로는 보이지 않는다 —
  // uncaughtException은 로그를 남기고 프로세스를 내리고(그 뒤 검사가 전부 깨지므로 여기까지
  // 오지 못한다), unhandledRejection은 살아남지만 그 요청은 영영 답을 받지 못한다.
  const 샌것 = 로그.split('\n').filter(l => /\[uncaughtException\]|\[unhandledRejection\]/.test(l));
  assert.deepStrictEqual(샌것.slice(0, 5), [], `요청 경로에서 예외가 샜다: ${샌것.slice(0, 5).join(' | ')}`);
  assert.ok(살아있나(), '검사가 끝난 뒤 서버가 내려가 있다');
});
