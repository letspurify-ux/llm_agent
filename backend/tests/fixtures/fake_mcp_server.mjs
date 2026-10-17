#!/usr/bin/env node
// A fake MCP server for the backend tests, without dependencies: stdio by
// default, Streamable HTTP with --http (it prints "listening <port>").
// Behaviour switches come from the environment (FAKE_MCP_*), which the
// backend passes through a server's `env` setting.
import http from 'node:http';
import { spawn } from 'node:child_process';

const env = process.env;
const KNOWN = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const PAGE = Number(env.FAKE_MCP_PAGE || 3);
const httpMode = process.argv.includes('--http');

const text = value => ({ type: 'text', text: value });
const tools = [
  { name: 'echo', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'add', title: 'Add numbers', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'structured_only', description: 'Structured content without text; for text use add_tool or weird.name, or call echo.', inputSchema: { type: 'object' } },
  { name: 'slow', description: 'Wait ms milliseconds.', inputSchema: { type: 'object', properties: { ms: { type: 'integer' } } } },
  { name: 'fail', description: 'Report a tool failure.', inputSchema: { type: 'object', properties: {} } },
  { name: 'big', description: 'Return chars characters.', inputSchema: { type: 'object', properties: { chars: { type: 'integer' } } } },
  { name: 'mixed', description: 'Text, image, audio, resources.', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: 'Exit in the middle of the call.', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } },
  { name: 'env', description: 'Read an environment variable.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'spawn_child', description: 'Start a long-lived child process and return its pid.', inputSchema: { type: 'object', properties: {} } },
  { name: 'add_tool', description: 'Add the tool "extra" and announce the list change.', inputSchema: { type: 'object', properties: {} } },
  { name: 'strict', description: 'Refuse a call without x as invalid params.', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } },
  { name: 'headers', description: 'Return the Authorization header (HTTP mode).', inputSchema: { type: 'object', properties: {} } },
  { name: 'stall_input', description: 'Stop reading stdin (a hung server).', inputSchema: { type: 'object', properties: {} } },
  { name: 'flood_line', description: 'Write 17 MiB without a newline.', inputSchema: { type: 'object', properties: {} } },
  { name: 'bad_content', description: 'A result whose content block has an unknown type.', inputSchema: { type: 'object', properties: {} } },
  { name: 'bad_text', description: 'A text block without text.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ask_client', description: 'Ask the client (sampling, roots, elicitation) before answering.', inputSchema: { type: 'object', properties: {} } },
  { name: 'progress', description: 'Send progress notifications, then answer.', inputSchema: { type: 'object', properties: {} } },
  { name: 'stray_reply', description: 'Send a reply to an unknown id, then answer.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'weird.name', description: 'D'.repeat(Number(env.FAKE_MCP_DESCRIPTION || 40)),
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', anyOf: [{ required: ['item'] }],
      properties: { item: { $ref: '#/$defs/Item' } }, $defs: { Item: { type: 'object', properties: { id: { type: 'integer' }, next: { $ref: '#/$defs/Item' } } } },
    },
  },
];

let headersSeen = {};
// Requests this server sent to the client, waiting for its reply.
const asked = new Map();
let nextAsk = 1000;
for (let i = 0; i < Number(env.FAKE_MCP_WIDE || 0); i++) {
  tools.push({ name: `wide_${i}`, description: Array.from({ length: 200 }, (_, j) => `w${i}x${j}`).join(' '), inputSchema: { type: 'object', properties: {} } });
}
if (env.FAKE_MCP_HUGE_META) {
  tools.push({ name: 'huge_meta', title: 'T'.repeat(100_000), description: 'huge', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, junk: 'J'.repeat(500_000) } });
  tools.push({ name: 'huge_schema', description: 'A schema of about 1 MB.', inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`field_${i}`, { type: 'string', description: 'x'.repeat(30) }])) } });
}
// Many tools with schemas just under the client's size limit.
for (let i = 0; i < Number(env.FAKE_MCP_FAT || 0); i++) {
  tools.push({ name: `fat_${i}`, description: 'fat', inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 1_000 }, (_, j) => [`f${j}`, { type: 'string', description: `field ${j} of tool ${i}` }])) } });
}
for (let i = 0; i < Number(env.FAKE_MCP_MANY || 0); i++) tools.push({ name: `many_${i}`, description: 'one of many', inputSchema: { type: 'object' } });
let listed = 0;
if (env.FAKE_MCP_BUILTIN_NAME) tools.push({ name: 'history', description: 'A tool named like one of the agent\'s own.', inputSchema: { type: 'object' } });
if (env.FAKE_MCP_DUPLICATE) tools.push({ name: 'echo', description: 'A second echo.', inputSchema: { type: 'object' } });
for (let i = 0; i < Number(env.FAKE_MCP_MANY_BAD || 0); i++) tools.push({ name: `bad_${i}`, description: 'a schema that is a string', inputSchema: 'nope' });
if (env.FAKE_MCP_BAD_LIST) tools.push({ name: 'no_schema', description: 'A tool without inputSchema.' }, { name: 'string_schema', description: 'A tool whose schema is a string.', inputSchema: 'nope' });
const cancelled = new Set();
let limitedCalls = 0;
const log = line => process.stderr.write(`${line}\n`);

function result(id, value) { return { jsonrpc: '2.0', id, result: value }; }
function failure(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

// The response to one request (a promise; null for none), and notifications
// to send meanwhile through `notify`.
async function handle(message, notify) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    if (env.FAKE_MCP_HANG_INIT) return new Promise(() => {});
    if (env.FAKE_MCP_SLOW_INIT_MS) await new Promise(resolve => setTimeout(resolve, Number(env.FAKE_MCP_SLOW_INIT_MS)));
    const asked = params.protocolVersion;
    const version = KNOWN.includes(asked) ? asked : '2025-06-18';
    const info = { protocolVersion: version, capabilities: { tools: { listChanged: true }, logging: {} }, serverInfo: env.FAKE_MCP_HUGE_META ? { name: 'N'.repeat(50_000), version: 'V'.repeat(50_000) } : { name: 'fake-mcp', version: '1.2.3' } };
    if (env.FAKE_MCP_HUGE_META) info.instructions = 'I'.repeat(2_000_000);
    if (env.FAKE_MCP_INSTRUCTIONS) info.instructions = env.FAKE_MCP_INSTRUCTIONS;
    return result(id, info);
  }
  if (method === 'notifications/initialized') {
    notify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', logger: 'fake', data: 'fake server ready' } });
    return null;
  }
  if (method === 'notifications/cancelled') {
    cancelled.add(params.requestId);
    log(`cancelled ${params.requestId} ${params.reason ?? ''}`);
    return null;
  }
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') {
    listed += 1;
    if (env.FAKE_MCP_LIST_STORM) { log(`listed ${listed}`); setTimeout(() => notify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }), 0); }
    if (env.FAKE_MCP_LOG_LISTS) log(`listed ${listed}`);
    if (env.FAKE_MCP_HANG_LIST) return new Promise(() => {});
    const start = env.FAKE_MCP_CURSOR_LOOP ? 0 : Number(params.cursor || 0);
    const page = tools.slice(start, start + PAGE);
    const next = env.FAKE_MCP_CURSOR_LOOP ? 'again' : start + PAGE < tools.length ? String(start + PAGE) : undefined;
    return result(id, next ? { tools: page, nextCursor: next } : { tools: page });
  }
  if (method === 'tools/call') {
    const args = params.arguments || {};
    switch (params.name) {
      // Text cut inside an emoji, as a JS server slicing a page does: the
      // JSON then holds a lone surrogate escape.
      // "bad bytes": a byte that is not UTF-8 in the text (stdio only).
      // "shape:{...}": that message as the answer, its id unless it has one.
      case 'echo':
        if (String(args.text).startsWith('shape:')) return { id, ...JSON.parse(args.text.slice(6)) }; return result(id, { content: [text(args.text === 'cut emoji' ? '잘림 😀'.slice(0, 4) : args.text === 'bad bytes' ? 'raw <0xFF> byte' : `echo: ${args.text}`)] });
      case 'add': { const sum = args.a + args.b; return result(id, { content: [text(JSON.stringify({ sum }))], structuredContent: { sum } }); }
      case 'structured_only': return result(id, { content: [], structuredContent: { ok: true, items: [1, 2] } });
      case 'slow': {
        await new Promise(resolve => setTimeout(resolve, args.ms ?? 1000));
        return cancelled.has(id) ? null : result(id, { content: [text('slept')] });
      }
      case 'fail': return result(id, { content: [text('boom: the tool failed')], isError: true });
      case 'big': return result(id, { content: [text(Array.from({ length: args.chars ?? 10 }, (_, i) => String(i % 10)).join(''))] });
      case 'mixed': return result(id, { content: [
        text('see attachment'),
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' },
        { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'resource body' } },
        { type: 'resource', resource: { uri: 'file:///b.pdf', mimeType: 'application/pdf', blob: 'JVBERi0=' } },
        { type: 'resource_link', uri: 'https://example.com/y', name: 'y', description: 'a link' },
      ] });
      case 'crash': log('crashing on purpose'); process.exit(3); break;
      case 'env': return result(id, { content: [text(env[args.name] ?? '<unset>')] });
      case 'spawn_child': {
        // A Node child, so Windows has it too (no `sleep` there).
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
        return result(id, { content: [text(String(child.pid))] });
      }
      case 'add_tool': {
        if (!tools.some(t => t.name === 'extra')) tools.push({ name: 'extra', description: 'Added later.', inputSchema: { type: 'object' } });
        notify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        return result(id, { content: [text('added')] });
      }
      case 'extra': return result(id, { content: [text('extra ran')] });
      case 'history': return result(id, { content: [text('the server history ran')] });
      case 'strict': return args.x ? result(id, { content: [text('ok')] }) : failure(id, -32602, 'x is required');
      case 'headers': return result(id, { content: [text(headersSeen.authorization ?? '<none>')] });
      case 'bad_content': return result(id, { content: [{ type: 'weird', x: 1 }] });
      case 'bad_text': return result(id, { content: [{ type: 'text' }] });
      case 'ask_client': {
        const ask = (method, params) => new Promise(resolve => {
          const askId = nextAsk++;
          asked.set(askId, resolve);
          notify({ jsonrpc: '2.0', id: askId, method, params });
        });
        const sampled = await ask('sampling/createMessage', { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], maxTokens: 10 });
        const roots = await ask('roots/list', {});
        const elicited = await ask('elicitation/create', { message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } });
        const show = r => r.error ? 'error ' + r.error.code : JSON.stringify(r.result);
        return result(id, { content: [text(`sampling: ${show(sampled)}; roots: ${show(roots)}; elicitation: ${show(elicited)}`)] });
      }
      case 'progress': {
        const token = params._meta?.progressToken;
        for (let i = 1; i <= 3; i++) notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token ?? 'none', progress: i, total: 3 } });
        return result(id, { content: [text('progressed')] });
      }
      case 'stray_reply':
        notify({ jsonrpc: '2.0', id: 987654, result: { content: [text('stray')] } });
        return result(id, { content: [text('real')] });
      case 'flood_line': {
        const chunk = 'x'.repeat(1024 * 1024);
        for (let i = 0; i < 17; i++) process.stdout.write(chunk);
        return new Promise(() => {});
      }
      case 'stall_input': process.stdin.pause(); setInterval(() => {}, 1 << 30); return result(id, { content: [text('stalled')] });
      default: return failure(id, -32601, `unknown tool ${params.name}`);
    }
  }
  return id === undefined ? null : failure(id, -32601, `unknown method ${method}`);
}

if (httpMode) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/moved')) { res.writeHead(302, { Location: '/mcp' }).end(); return; }
    if (req.url.startsWith('/page')) { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>login</html>'); return; }
    if (!req.url.startsWith('/mcp')) { res.writeHead(404).end('not found'); return; }
    if (env.FAKE_MCP_AUTH && req.headers.authorization !== env.FAKE_MCP_AUTH) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    headersSeen = req.headers;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const message = JSON.parse(body);
      // A rate limit or a proxy error on the first tool call only, the
      // session fine.
      if (env.FAKE_MCP_CALL_STATUS && message.method === 'tools/call' && limitedCalls++ === 0) {
        res.writeHead(Number(env.FAKE_MCP_CALL_STATUS), { 'Content-Type': 'text/plain', 'Retry-After': '30' }).end('slow down');
        return;
      }
      const notes = [];
      const answer = await handle(message, note => notes.push(note));
      if (answer === null) { res.writeHead(202).end(); return; }
      const headers = { 'Content-Type': env.FAKE_MCP_SSE ? 'text/event-stream' : 'application/json' };
      if (message.method === 'initialize' && !env.FAKE_MCP_STATELESS) headers['Mcp-Session-Id'] = 'fake-session';
      res.writeHead(200, headers);
      if (env.FAKE_MCP_SSE) {
        for (const note of notes) res.write(`event: message\ndata: ${JSON.stringify(note)}\n\n`);
        res.end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
      } else {
        res.end(JSON.stringify(answer));
      }
    });
  });
  const fixed = process.argv.indexOf('--port');
  server.listen(fixed > 0 ? Number(process.argv[fixed + 1]) : 0, '127.0.0.1', () => process.stdout.write(`listening ${server.address().port}\n`));
} else {
  for (let i = 0; i < Number(env.FAKE_MCP_STDERR || 0); i++) log(`stderr line ${i}`);
  if (env.FAKE_MCP_EXIT_BEFORE_INIT) { log('fatal: missing configuration'); process.exit(2); }
  // Windows-style output: a byte order mark before the first line, CRLF.
  let bom = env.FAKE_MCP_WINDOWS ? '\ufeff' : '';
  const end = env.FAKE_MCP_WINDOWS ? '\r\n' : '\n';
  const send = message => {
    if (env.FAKE_MCP_GARBAGE) process.stdout.write('this is not json\n');
    const [before, after] = `${bom}${JSON.stringify(message)}${end}`.split('<0xFF>');
    process.stdout.write(after === undefined ? before : Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)]));
    bom = '';
  };
  if (env.FAKE_MCP_GARBAGE) process.stdout.write('starting up (not json)\n');
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === undefined && asked.has(message.id)) {
        asked.get(message.id)(message);
        asked.delete(message.id);
        continue;
      }
      Promise.resolve(handle(message, send)).then(answer => { if (answer) send(answer); });
    }
  });
  process.stdin.on('end', () => { log('stdin closed'); process.exit(0); });
}
