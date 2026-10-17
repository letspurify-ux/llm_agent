// MCP 서버 편집 화면의 입력값 ↔ 관리 API 본문 변환(순수 함수, test/mcp-fields.test.js).
// 서버는 비밀값(환경변수·헤더)의 이름만 돌려준다. 화면은 새 값을 넣거나(문자열) 지우기(null)만 보낸다.

export const STATE_LABELS = { ready: '준비됨', connecting: '연결 중', failed: '실패', disabled: '꺼짐', stopped: '멈춤' };

const PAIR = { env: { separator: '=', label: '환경변수' }, headers: { separator: ':', label: 'HTTP 헤더' } };

export function blankForm() {
  return {
    name: '', description: '', enabled: true, transport: 'stdio', command: '', args: '', cwd: '', url: '',
    env: '', headers: '', allTools: false, tools: [], timeout: '',
    secretNames: { env: [], headers: [] }, secretChanges: { env: {}, headers: {} },
  };
}

export function pairsText(map, kind) {
  const separator = kind === 'headers' ? ': ' : '=';
  return Object.entries(map || {}).map(([key, value]) => `${key}${separator}${value}`).join('\n');
}

// "이름=값"(환경변수) 또는 "이름: 값"(헤더) 줄들. 빈 줄은 건너뛴다.
export function parsePairs(text, kind) {
  const { separator, label } = PAIR[kind];
  const values = {};
  const problems = [];
  String(text || '').split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return;
    const at = line.indexOf(separator);
    if (at <= 0) { problems.push(`${label} ${index + 1}번째 줄은 "이름${separator}값" 형식이어야 합니다.`); return; }
    const key = line.slice(0, at).trim();
    const value = kind === 'headers' ? line.slice(at + 1).trim() : line.slice(at + 1);
    if (Object.prototype.hasOwnProperty.call(values, key)) { problems.push(`${label} ${key}이(가) 두 번 있습니다.`); return; }
    values[key] = value;
  });
  return { values, problems };
}

export function formOf(server) {
  const tools = server.tools || [];
  return {
    name: server.name || '', description: server.description || '', enabled: server.enabled !== false,
    transport: server.transport || (server.url ? 'http' : 'stdio'),
    command: server.command || '', args: (server.args || []).join('\n'), cwd: server.cwd || '', url: server.url || '',
    env: pairsText(server.env, 'env'), headers: pairsText(server.headers, 'headers'),
    allTools: tools.includes('*'), tools: tools.filter(tool => tool !== '*'),
    timeout: server.timeout_secs == null ? '' : String(server.timeout_secs),
    secretNames: { env: [...(server.secrets?.env || [])], headers: [...(server.secrets?.headers || [])] },
    secretChanges: { env: {}, headers: {} },
  };
}

// 저장·연결 확인에 보낼 본문과, 보내기 전에 막을 입력 문제.
export function bodyOf(form) {
  const problems = [];
  if (!form.name.trim()) problems.push('서버 이름을 입력해주세요.');
  const http = form.transport === 'http';
  if (http && !form.url.trim()) problems.push('서버 주소를 입력해주세요.');
  if (!http && !form.command.trim()) problems.push('실행 명령을 입력해주세요.');
  const timeout = form.timeout.trim();
  if (timeout && !/^[1-9]\d*$/.test(timeout)) problems.push('호출 시간 한도는 1 이상의 정수(초)로 입력하거나 비워두세요.');
  const env = parsePairs(http ? '' : form.env, 'env');
  const headers = parsePairs(http ? form.headers : '', 'headers');
  problems.push(...env.problems, ...headers.problems);
  const secrets = {};
  for (const kind of http ? ['headers'] : ['env']) {
    const changes = form.secretChanges[kind];
    if (Object.keys(changes).length) secrets[kind] = { ...changes };
  }
  const body = {
    name: form.name.trim(), description: form.description, enabled: form.enabled,
    command: http ? '' : form.command.trim(),
    args: http ? [] : form.args.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.trim()),
    cwd: http ? '' : form.cwd.trim(), url: http ? form.url.trim() : '',
    env: env.values, headers: headers.values,
    tools: form.allTools ? ['*'] : [...form.tools],
    timeout_secs: timeout ? Number(timeout) : null,
  };
  if (Object.keys(secrets).length) body.secrets = secrets;
  return { body, problems };
}

// 허용 목록 항목은 서버의 도구 이름이나 모델이 보는 이름(서버__도구)이다(서버의 allows와 같다).
const names = tool => [tool.name, tool.exposed].filter(Boolean);
export const isAllowed = (form, tool) => form.allTools || names(tool).some(name => form.tools.includes(name));

// 도구 하나를 허용하거나 뺀다. 빼면 그 도구를 가리키던 항목(두 이름)을 모두 지운다.
export function toggleTool(tools, tool, on) {
  const rest = tools.filter(name => !names(tool).includes(name));
  return on ? [...rest, tool.name] : rest;
}

// 체크박스로 고를 도구 목록: 서버가 알려준 도구와, 허용했지만 지금 목록에 없는 도구.
export function toolChoices(listed, allowed) {
  const choices = (listed || []).map(tool => ({ ...tool, missing: false }));
  for (const name of allowed) {
    if (!choices.some(tool => names(tool).includes(name))) choices.push({ name, missing: true });
  }
  return choices;
}

// 허용한 도구 정의가 매 요청에 차지하는 토큰 수(서버가 센 값의 합).
export function allowedTokens(choices, form) {
  return choices.filter(tool => !tool.missing && isAllowed(form, tool))
    .reduce((sum, tool) => sum + (tool.tokens || 0), 0);
}
