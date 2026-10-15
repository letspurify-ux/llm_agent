import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTING_GROUPS, formOf, configOf } from '../src/settings-fields.js';

// 서버 설정(backend config.rs)의 모양과 입력 글자 사이 변환은 왕복이 맞아야 한다 — 어긋나면
// 저장할 때마다 값이 조금씩 바뀌거나(비율·MiB) 비운 값이 0으로 저장된다.
const SERVER = {
  llm: { base_url: 'http://x/v1', model: 'm', proxy: null, disable_proxy: false, context_tokens: 128000, output_tokens: 16384,
    reasoning_effort: 'low', enable_thinking: true, legacy_max_tokens: false, stream_usage: true, request_timeout_secs: 120, retries: 2 },
  embedding: { url: '', model: 'bge-m3', query_prefix: 'Instruct\\nQuery: ', sync_interval_secs: 60, max_distance: 0.4, ef_search: 150, timeout_secs: 60 },
  mariadb: { host: 'localhost', port: 3306, user: 'agent', database: 'llm_agent', pool_size: 21, timeout_ms: 30000 },
  oracle: { client_lib_dir: '', client_config_dir: '', timeout_ms: 30000, routine_read_only: true, mock: false },
  agent: { run_seconds: 400, high_water: 0.9, low_water: 0.5, history_bytes: 16777216, result_tokens: null,
    tool_timeout_secs: 30, repeated_read_limit: 2, session_idle_minutes: 60, max_sessions: 200, result_store_bytes: 33554432 },
  server: { port: 3001, chat_log_retention_days: 3 },
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
