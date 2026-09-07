// 서버가 어떤 요청에도 내려가지 않고, 어떤 요청도 답 없이 매달리지 않는다 — 실행: npm test (backend/)
//
// 이 계약은 깨져도 조용하다. express 4는 async 핸들러의 거부를 잡아 주지 않으므로 그 요청은
// 오류도 아니고 응답도 아닌 채로 열려 있고, 클라이언트는 자기 타임아웃(프런트는 450초)까지
// 기다린다 — 서버 로그에는 unhandledRejection 한 줄뿐이다. 반대로 요청 경로에서 새어 나온
// 예외 하나는 uncaughtException 핸들러를 타고 프로세스를 통째로 내린다(server.js 주석).
// 그래서 여기서는 '무엇을 답했는가'가 아니라 '반드시 답했는가, 그리고 살아 있는가'만 본다.
//
// DB도 LLM도 없이 띄운다 — 그 실패는 각 경로가 이미 처리하고, 이 검사가 보는 것은 그 위의 껍데기다.
import { test, before, after, describe } from 'node:test';
import { createServer as httpServer } from 'node:http';
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
  const deadPort = await freePort();
  proc = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    // 관리 DB·LLM·임베딩은 쓰지 않는다. 주기 작업을 꺼 두는 이유는 이 검사가 보는 것이
    // 요청 경로뿐이고, 켜 두면 실패 로그가 그 위를 덮기 때문이다.
    env: {
      ...process.env, PORT: String(port), ORACLE_MOCK: '1', LLM_PROVIDER: '', EMBED_SYNC_INTERVAL: '0',
      EMBEDDING_URL: '', MARIADB_HOST: '127.0.0.1', MARIADB_PORT: String(deadPort),
      MARIADB_USER: 'backend_test', MARIADB_PASSWORD: '', MARIADB_DATABASE: 'backend_test',
    },
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

// 상태 코드는 원인 분류다 — 서버는 '클라이언트가 고칠 수 있는 요청'(400·413)과 '없는 경로'(404)와
// '서버 버그'(500)를 코드로 갈라 보내기로 했고(server.js의 오류 핸들러 주석: 전부 400으로 뭉개면
// 원인 분류가 뒤집힌다), 감시자·프록시·접속 로그는 그 코드만 본다. 위 검사는 '4xx/5xx 중 하나'만 재므로
// 그 약속이 통째로 무너져도 통과한다(변이 검사로 확인: 400·404·500을 서로 바꿔도 아무 테스트도 잡지 않았다).
test('거부의 상태 코드가 원인을 가른다 — 잘못된 요청 400, 없는 경로 404, 너무 큰 본문 413', async () => {
  const 기대 = [
    [400, '/api/chat', J({})],
    [400, '/api/chat', J({ message: '   ' })],
    [400, '/api/chat', J({ message: 'a'.repeat(5000) })],
    [400, '/api/chat', RAW('{not json')],
    [413, '/api/chat', J({ message: 'a'.repeat(2_000_000) })],
    [404, '/api/nope', J({ message: 'hi' })],
  ];
  for (const [status, path, init] of 기대) {
    const r = await 답(path, init);
    assert.strictEqual(r.status, status, `${path} ${JSON.stringify(init.body).slice(0, 40)}`);
  }
  assert.strictEqual((await fetch(`${base()}/api/health`)).status, 200);
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

// ===== 진행 상황 스트림 =====
// 검색·조회 이벤트를 흘려보내는 응답(NDJSON)과, Accept가 없을 때의 JSON 하나가 같은 본문을 담는지 본다.
// 이 검사는 관리 DB·임베딩 없이 돈다 — LLM은 아래 가짜 엔드포인트가 대본대로 답하고, 검색은 knowledge만
// 요청해 임베딩 미설정으로 '검색 불가'가 되게 한다(그 경로는 관리 DB를 만지지 않는다 — agent.js runSearch).
// 그래서 여기서 재는 것은 응답의 '모양'이지 검색의 결과가 아니다.
describe('진행 상황 스트림', () => {
  let llm; let llmPort; let sproc; let sport; let slog = '';
  const script = [];   // 가짜 LLM이 차례로 돌려줄 결정 JSON
  const sbase = () => `http://127.0.0.1:${sport}`;
  const 살아있나2 = () => !!sproc && sproc.exitCode === null && sproc.signalCode === null;

  before(async () => {
    llmPort = await freePort();
    // 진짜 엔드포인트처럼 SSE로 답한다 — 결정 JSON을 조각 셋으로 나눠 흘리고 마지막에 usage를 준다.
    // 서버가 stream:true를 보내지 않으면(회귀) JSON 하나로 답해 그 사실이 드러나게 한다.
    llm = httpServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        const content = script.shift() ?? '{"action":"answer","answer":"대본이 끝났다"}';
        const wantsStream = (() => { try { return JSON.parse(body).stream === true; } catch { return false; } })();
        if (!wantsStream) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
          return;
        }
        res.setHeader('Content-Type', 'text/event-stream');
        const size = Math.ceil(content.length / 3);
        for (let i = 0; i < content.length; i += size) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + size) } }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise(r => llm.listen(llmPort, '127.0.0.1', r));
    sport = await freePort();
    const deadPort = await freePort();   // 아무도 듣지 않는 포트 — 관리 DB는 여기서 쓰지 않는다
    sproc = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env, PORT: String(sport), ORACLE_MOCK: '1', EMBED_SYNC_INTERVAL: '0',
        LLM_PROVIDER: 'openai', LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, LLM_MODEL: 'test', LLM_API_KEY: '',
        EMBEDDING_URL: '', MARIADB_HOST: '127.0.0.1', MARIADB_PORT: String(deadPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    sproc.stdout.on('data', d => { slog += d; });
    sproc.stderr.on('data', d => { slog += d; });
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`${sbase()}/api/health`)).ok) return; } catch { /* 아직 안 떴다 */ }
      if (!살아있나2()) break;
      await sleep(250);
    }
    throw new Error(`서버가 뜨지 않았습니다: ${slog.slice(0, 500)}`);
  });

  after(async () => {
    sproc?.kill('SIGTERM');
    for (let i = 0; i < 40 && 살아있나2(); i++) await sleep(100);
    sproc?.kill('SIGKILL');
    if (llm) await new Promise(r => llm.close(r));
  });

  const lines = text => text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

  test('Accept가 NDJSON이면 검색 이벤트가 줄로 흘러오고 마지막 줄이 done이다', async () => {
    script.push('{"action":"search","text":"배치 재시작","targets":["knowledge"]}', '{"action":"answer","answer":"ok"}');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(`${sbase()}/api/chat`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ message: '배치 재시작 방법', history: [] }),
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/x-ndjson/);
      const events = lines(await res.text());
      // 답변 조각(answer_delta)이 done보다 먼저 흘러온다 — 조각의 합이 답이다
      const deltas = events.filter(e => e.type === 'answer_delta');
      assert.ok(deltas.length >= 1, `답변 조각이 없다: ${JSON.stringify(events.map(e => e.type))}`);
      assert.equal(deltas.map(e => e.text).join(''), 'ok');
      assert.deepStrictEqual(events.filter(e => e.type !== 'answer_delta').map(e => e.type), ['search', 'search_done', 'done'], JSON.stringify(events));
      assert.deepStrictEqual(events[0], { type: 'search', text: '배치 재시작', targets: ['knowledge'] });
      // 임베딩이 없으니 '검색 불가' — 0건이 아니다
      assert.deepStrictEqual(events[1].failed, ['knowledge']);
      assert.equal(events[1].hits.knowledge, null);
      const done = events[events.length - 1];
      assert.equal(done.answer, 'ok');
      assert.deepStrictEqual(done.trace, [{ step: 1, search: '배치 재시작', targets: ['knowledge'], hits: { knowledge: null, qaMethods: null, queries: null }, failed: ['knowledge'] }]);
    } finally { clearTimeout(timer); }
  });

  test('Accept가 없으면 지금까지처럼 JSON 하나이고, done 줄과 같은 본문이다', async () => {
    script.push('{"action":"answer","answer":"바로 답"}');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(`${sbase()}/api/chat`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '안녕', history: [] }),
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      assert.deepStrictEqual(await res.json(), { answer: '바로 답', trace: [] });
    } finally { clearTimeout(timer); }
  });

  test('스트림 도중 클라이언트가 끊어도 서버는 살아 있고 다음 요청에 답한다', async () => {
    script.push('{"action":"search","text":"x","targets":["knowledge"]}', '{"action":"answer","answer":"늦은 답"}');
    const ctrl = new AbortController();
    const res = await fetch(`${sbase()}/api/chat`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ message: 'x', history: [] }),
    });
    const reader = res.body.getReader();
    await reader.read();      // 첫 줄(검색 시작)을 받자마자 끊는다
    ctrl.abort();
    await sleep(200);
    assert.ok(살아있나2(), '스트림 도중 끊긴 요청이 프로세스를 내렸다');
    assert.ok((await fetch(`${sbase()}/api/health`)).ok);
    script.length = 0;
    script.push('{"action":"answer","answer":"다음 답"}');
    const next = await fetch(`${sbase()}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'y', history: [] }),
    });
    assert.equal((await next.json()).answer, '다음 답');
  });
});

// ===== 정상 종료 =====
// 재배포는 SIGTERM으로 온다. 그 경로가 강제 타이머(10초)에 걸리면 두 가지를 함께 잃는다:
// 종료 코드가 1이 되어 supervisor의 재시작 판정이 어긋나고, 그 타이머는 process.exit이라
// closePool()·closeOraclePools()가 실행되지 않아 관리 DB에는 끊긴 커넥션이, 조회 DB에는 세션이 남는다.
// server.js가 그 경로에 공들인 이유가 그것인데, 종료 경로가 기다리는 작업(backgroundJobs) 하나가
// 신호를 받지 않으면 그 공이 통째로 무의미해진다 — 실제로 임베딩 예열이 그랬다(실측 10.0초/코드 1).
// 이 검사는 '예열이 신호를 지나는가'를 프로세스 경계에서 본다 — 단위 검사(search.test.js)는 함수만 보므로
// server.js가 신호를 넘기지 않는 회귀는 여기서만 드러난다.
describe('정상 종료', () => {
  let embed; let embedPort; let kproc; let klog = '';
  const 열린요청 = [];
  const 살아있나3 = () => !!kproc && kproc.exitCode === null && kproc.signalCode === null;
  const 로그에 = re => new Promise(async resolve => {
    for (let i = 0; i < 200; i++) {
      if (re.test(klog)) return resolve(true);
      if (!살아있나3()) return resolve(false);
      await sleep(100);
    }
    resolve(false);
  });

  before(async () => {
    embedPort = await freePort();
    // 절대 답하지 않는 임베딩 서버 — 모델 콜드 로드가 길어진 상태를 그대로 흉내낸다.
    embed = httpServer((req, res) => { 열린요청.push(res); });
    await new Promise(r => embed.listen(embedPort, '127.0.0.1', r));
    const deadPort = await freePort();
    kproc = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env, PORT: String(await freePort()), ORACLE_MOCK: '1', LLM_PROVIDER: '', EMBED_SYNC_INTERVAL: '0',
        EMBEDDING_URL: `http://127.0.0.1:${embedPort}/v1`,
        MARIADB_HOST: '127.0.0.1', MARIADB_PORT: String(deadPort),
        MARIADB_USER: 'backend_test', MARIADB_PASSWORD: '', MARIADB_DATABASE: 'backend_test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    kproc.stdout.on('data', d => { klog += d; });
    kproc.stderr.on('data', d => { klog += d; });
  });

  after(async () => {
    kproc?.kill('SIGKILL');
    for (const res of 열린요청) res.destroy();
    if (embed) await new Promise(r => embed.close(r));
  });

  test('임베딩 예열이 매달려 있어도 SIGTERM이 정상 종료로 끝난다', async () => {
    assert.ok(await 로그에(/agent server: http/), `서버가 뜨지 않았다: ${klog.slice(0, 400)}`);
    // 예열 요청이 실제로 나가서 매달려 있는 상태를 만든 뒤에 종료한다.
    for (let i = 0; i < 100 && !열린요청.length; i++) await sleep(50);
    assert.equal(열린요청.length, 1, '임베딩 예열 요청이 나가지 않았다 — 이 검사가 아무것도 재지 못한다');
    // 관리 DB가 없는 환경이라 나머지 주기 작업은 커넥터의 획득 상한(10초)까지 매달린다. 그 둘이
    // 끝난 것을 확인하고 종료해야 이 검사가 재는 것이 '예열' 하나로 남는다 (강제 타이머와 경주하지 않게).
    assert.ok(await 로그에(/\[embed\] sync failed/), '주기 동기화가 실패로 끝나지 않았다');
    assert.ok(await 로그에(/\[chat_log\] cleanup failed/), 'chat_log 정리가 실패로 끝나지 않았다');

    const 시작 = Date.now();
    kproc.kill('SIGTERM');
    // 강제 타이머(10초)보다 넉넉히 기다린다 — 회귀했을 때 '아직 살아 있다'가 아니라 '강제 종료로 끝났다'는
    // 정확한 실패 문구가 나오게. 정상 경로에서는 첫 몇 번의 확인 안에 끝난다.
    for (let i = 0; i < 260 && 살아있나3(); i++) await sleep(50);
    const 걸린시간 = Date.now() - 시작;
    assert.equal(살아있나3(), false, `SIGTERM 뒤에도 프로세스가 남아 있다 (${걸린시간}ms)`);
    assert.equal(kproc.exitCode, 0, `정상 종료가 강제 종료로 끝났다 (${걸린시간}ms, 로그: ${klog.slice(-300)})`);
    assert.ok(!/cleanup timed out/.test(klog), `종료가 강제 타이머까지 갔다 (${걸린시간}ms)`);
    assert.ok(걸린시간 < 5000, `정상 종료가 ${걸린시간}ms 걸렸다 — 예열이 종료 신호를 받지 못한다`);
  });
});
