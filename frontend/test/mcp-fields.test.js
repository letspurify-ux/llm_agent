import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedTokens, blankForm, bodyOf, formOf, isAllowed, parsePairs, toggleTool, toolChoices } from '../src/mcp-fields.js';

const SERVER = {
  name: 'jira', description: '사내 Jira', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'jira-mcp'], cwd: '',
  url: '', tools: ['search', 'get'], timeout_secs: 20, env: { JIRA_URL: 'https://j', TOKEN: 'ENV:JIRA_TOKEN' }, headers: {},
  secrets: { env: ['HIDDEN'], headers: [] }, revision: 'r', status: null,
};

test('저장된 서버는 화면 글자로 갔다가 같은 본문으로 돌아온다', () => {
  const { body, problems } = bodyOf(formOf(SERVER));
  assert.deepEqual(problems, []);
  assert.deepEqual(body, {
    name: 'jira', description: '사내 Jira', enabled: true, command: 'npx', args: ['-y', 'jira-mcp'], cwd: '', url: '',
    env: { JIRA_URL: 'https://j', TOKEN: 'ENV:JIRA_TOKEN' }, headers: {}, tools: ['search', 'get'], timeout_secs: 20,
  });
});

test('비밀값은 바꾼 것만 보내고, 지우기는 null이다', () => {
  const form = formOf(SERVER);
  form.secretChanges.env = { HIDDEN: null, NEW: 'v' };
  assert.deepEqual(bodyOf(form).body.secrets, { env: { HIDDEN: null, NEW: 'v' } });
});

test('HTTP로 바꾸면 명령 쪽 값은 보내지 않는다', () => {
  const form = { ...formOf(SERVER), transport: 'http', url: ' https://wiki/mcp ', headers: 'Authorization: Bearer x\nX-Team:voc' };
  form.secretChanges = { env: { A: 'b' }, headers: { 'X-Key': 'k' } };
  const { body, problems } = bodyOf(form);
  assert.deepEqual(problems, []);
  assert.equal(body.url, 'https://wiki/mcp');
  assert.equal(body.command, '');
  assert.deepEqual(body.args, []);
  assert.deepEqual(body.env, {});
  assert.deepEqual(body.headers, { Authorization: 'Bearer x', 'X-Team': 'voc' });
  assert.deepEqual(body.secrets, { headers: { 'X-Key': 'k' } });
});

test('모든 도구 허용은 * 하나로 보낸다', () => {
  const form = { ...formOf({ ...SERVER, tools: ['*'] }) };
  assert.equal(form.allTools, true);
  assert.deepEqual(bodyOf(form).body.tools, ['*']);
});

test('입력 문제를 저장 전에 알린다', () => {
  const form = { ...blankForm(), timeout: '0', env: 'NOVALUE\nA=1\nA=2' };
  const { problems } = bodyOf(form);
  assert.ok(problems.some(p => p.includes('서버 이름')));
  assert.ok(problems.some(p => p.includes('실행 명령')));
  assert.ok(problems.some(p => p.includes('시간 한도')));
  assert.ok(problems.some(p => p.includes('1번째 줄')));
  assert.ok(problems.some(p => p.includes('두 번')));
  assert.ok(bodyOf({ ...blankForm(), name: 'w', transport: 'http' }).problems.some(p => p.includes('서버 주소')));
});

test('환경변수 값의 = 와 공백은 그대로, 헤더 값은 앞뒤 공백을 뺀다', () => {
  assert.deepEqual(parsePairs('A=b=c \r\n\nB=', 'env').values, { A: 'b=c ', B: '' });
  assert.deepEqual(parsePairs('X-A:  1 ', 'headers').values, { 'X-A': '1' });
  assert.equal(parsePairs('=x', 'env').problems.length, 1);
});

test('허용했지만 지금 목록에 없는 도구도 고를 수 있게 남고, 토큰은 허용한 것만 센다', () => {
  const listed = [{ name: 'search', tokens: 100 }, { name: 'delete', tokens: 50 }];
  const choices = toolChoices(listed, ['search', 'gone']);
  assert.deepEqual(choices.map(c => [c.name, c.missing]), [['search', false], ['delete', false], ['gone', true]]);
  assert.equal(allowedTokens(choices, { allTools: false, tools: ['search', 'gone'] }), 100);
  assert.equal(allowedTokens(choices, { allTools: true, tools: [] }), 150);
});

test('모델이 보는 이름(서버__도구)으로 적은 허용 항목도 그 도구에 체크되고, 빼면 두 이름 모두 지운다', () => {
  const listed = [{ name: 'search', exposed: 'jira__search', tokens: 10 }, { name: 'get', exposed: 'jira__get', tokens: 5 }];
  const form = { allTools: false, tools: ['jira__search'] };
  const choices = toolChoices(listed, form.tools);
  assert.deepEqual(choices.map(c => c.name), ['search', 'get'], '목록에 없는 항목으로 따로 남지 않는다');
  assert.equal(isAllowed(form, choices[0]), true);
  assert.equal(allowedTokens(choices, form), 10);
  assert.deepEqual(toggleTool(['jira__search', 'search', 'get'], choices[0], false), ['get']);
  assert.deepEqual(toggleTool(['get'], choices[0], true), ['get', 'search']);
});
