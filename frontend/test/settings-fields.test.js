import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTING_GROUPS, formOf, configOf } from '../src/settings-fields.js';

// 서버 설정(backend config.rs)의 모양과 입력 글자 사이 변환은 왕복이 맞아야 한다 — 어긋나면
// 저장할 때마다 값이 조금씩 바뀌거나(비율·MiB) 비운 값이 0으로 저장된다.
const SERVER = {
  assistant: { name: 'SPACE Assistant', subtitle: '지식 · 운영 DB 조회 기반', persona: '당신은 SPACE VOC 에이전트다.\n사내 용어를 쓴다.',
    examples: ['SPACE 시스템이 뭐야?', '너는 어떤 일을 할 수 있어?'], knowledge: true, database: false, search_first: true },
  llm: { base_url: 'http://x/v1', model: 'm', proxy: null, disable_proxy: false, context_tokens: 128000, output_tokens: 16384,
    reasoning_effort: 'low', enable_thinking: true, legacy_max_tokens: false, stream_usage: true, request_timeout_secs: 120, retries: 2 },
  embedding: { url: '', model: 'bge-m3', query_prefix: 'Instruct\\nQuery: ', sync_interval_secs: 60, max_distance: 0.4, ef_search: 150, timeout_secs: 60 },
  mariadb: { host: 'localhost', port: 3306, user: 'agent', database: 'llm_agent', pool_size: 21, timeout_ms: 30000 },
  oracle: { client_lib_dir: '', client_config_dir: '', timeout_ms: 30000, routine_read_only: true, mock: false },
  agent: { run_seconds: 400, high_water: 0.9, low_water: 0.5, history_bytes: 16777216, result_tokens: null,
    tool_timeout_secs: 30, session_idle_minutes: 60, max_sessions: 200, result_store_bytes: 33554432 },
  server: { port: 3001, chat_log_retention_days: 3, allowed_hosts: ['voc.corp.local', 'agent.local'] },
};

test('설정 값은 화면 글자로 갔다가 같은 값으로 돌아온다', () => {
  const form = formOf(SERVER);
  assert.equal(form['agent.high_water'], '90');
  assert.equal(form['agent.history_bytes'], '16');
  assert.equal(form['agent.result_tokens'], '');
  assert.equal(configOf({ ...form, 'agent.result_tokens': '8000' }).config.agent.result_tokens, 8000);
  const { config, problems } = configOf(form);
  assert.deepEqual(problems, []);
  assert.deepEqual(config, SERVER);
});

test('목록 칸은 쉼표로 나눈 이름들이고 비우면 빈 목록이다', () => {
  const form = formOf(SERVER);
  assert.equal(form['server.allowed_hosts'], 'voc.corp.local, agent.local');
  assert.deepEqual(configOf({ ...form, 'server.allowed_hosts': ' a.local ,, b ' }).config.server.allowed_hosts, ['a.local', 'b']);
  assert.deepEqual(configOf({ ...form, 'server.allowed_hosts': '' }).config.server.allowed_hosts, []);
});

test('숫자 칸의 잘못된 글자는 저장 전에 알린다', () => {
  const form = formOf(SERVER);
  const { problems } = configOf({ ...form, 'llm.output_tokens': '1.5', 'agent.high_water': 'abc', 'agent.result_tokens': '-3' });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /출력 한도/);
});

test('모든 항목은 서버 구역 안에 있다', () => {
  for (const group of SETTING_GROUPS) {
    for (const [key] of group.fields) assert.ok(key.split('.')[0] in SERVER, key);
  }
});

test('반올림해 보이는 칸은 손대지 않으면 서버의 값 그대로 돌아간다', () => {
  // MiB·% 칸은 화면에 소수 둘째·첫째 자리로 보인다. 그 글자를 다시 바꾸면 config.toml에 직접 적은 딱 떨어지지 않는
  // 값이 다른 칸 하나를 고쳐 저장할 때마다 조용히 바뀌었다(실측: history_bytes 100000 → 104858).
  const server = { ...SERVER, agent: { ...SERVER.agent, history_bytes: 100_000, result_store_bytes: 1_000_000, high_water: 0.9255, low_water: 0.333 } };
  const form = formOf(server);
  assert.equal(form['agent.history_bytes'], '0.1');
  const { config, problems } = configOf({ ...form, 'server.port': '3002' }, server);
  assert.deepEqual(problems, []);
  assert.deepEqual(config.agent, server.agent);
  assert.equal(config.server.port, 3002);
  // 고친 칸은 고친 값으로 간다 — 앞뒤 공백만 다른 것은 고친 것이 아니다.
  const edited = configOf({ ...form, 'agent.history_bytes': '2', 'agent.high_water': ' 92.6 ' }, server).config.agent;
  assert.equal(edited.history_bytes, 2 * 1024 * 1024);
  assert.equal(edited.high_water, 0.9255);
  assert.equal(configOf({ ...form, 'agent.high_water': '92.5' }, server).config.agent.high_water, 0.925);
});

test('예시 질문은 고정된 세 칸이고 빈 칸은 빠진다', () => {
  const form = formOf(SERVER);
  assert.deepEqual(form['assistant.examples'], ['SPACE 시스템이 뭐야?', '너는 어떤 일을 할 수 있어?', '']);
  assert.equal(form['assistant.persona'], '당신은 SPACE VOC 에이전트다.\n사내 용어를 쓴다.');
  const edited = configOf({ ...form, 'assistant.examples': [' 첫 질문 ', '', '셋째 질문'] }).config.assistant;
  assert.deepEqual(edited.examples, ['첫 질문', '셋째 질문']);
  assert.deepEqual(configOf({ ...form, 'assistant.examples': ['', ' ', ''] }).config.assistant.examples, []);
  // 예시가 없거나 모양이 어긋난 서버 값도 세 칸으로 보인다.
  assert.deepEqual(formOf({ ...SERVER, assistant: { ...SERVER.assistant, examples: undefined } })['assistant.examples'], ['', '', '']);
  assert.deepEqual(formOf({ ...SERVER, assistant: { ...SERVER.assistant, examples: ['a', 3, 'b', 'c'] } })['assistant.examples'], ['a', '', 'b']);
  assert.equal(SETTING_GROUPS[0].id, 'assistant', '역할이 설정 화면의 맨 앞이다');
});
