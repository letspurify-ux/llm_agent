import { useCallback, useEffect, useRef, useState } from 'react';
import DirectoryPicker from './DirectoryPicker.jsx';
import { useChangedState } from './changed-state.js';
import { STATE_LABELS, allowedTokens, blankForm, bodyOf, formOf, isAllowed, toggleTool, toolChoices } from './mcp-fields.js';

// MCP 도구 서버(backend/config.toml의 [[mcp_servers]]) 화면: 서버 목록과 상태, 편집기, 도구별 호출 현황, 최근 기록.
// 저장하면 서버가 바로 다시 연결한다. 비밀값은 이름만 보이고 새 값을 넣거나 지울 수만 있다.
// 명령을 실행하는 설정이라 관리자 인증 키가 없는 서버에서는 보기만 된다(서버가 403으로 막는다).
const REFRESH_MS = 5000;
const when = iso => (iso ? new Date(iso).toLocaleString('ko-KR') : '');

export default function McpPanel({ api, onStateChange }) {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(null);
  const [baseline, setBaseline] = useState('');
  const [revision, setRevision] = useState('');
  const [probe, setProbe] = useState(null);
  const [secretDraft, setSecretDraft] = useState({ name: '', value: '' });
  const [error, setError] = useState('');
  // 몇 초마다 다시 읽는 상태의 실패는 따로 둔다: 다음 읽기가 되면 지우고, 저장 오류를 덮지 않는다.
  // 서버가 내려가 있으면 5초마다 같은 문구가 온다 — 바뀔 때만 넘긴다 (changed-state.js).
  const [refreshError, setRefreshError] = useChangedState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [picker, setPicker] = useState(false);
  const feedback = useRef(null);
  const dirty = !!form && JSON.stringify(form) !== baseline;

  useEffect(() => { onStateChange({ dirty, busy }); }, [dirty, busy, onStateChange]);
  useEffect(() => {
    if (!dirty && !busy) return undefined;
    const warn = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);
  useEffect(() => { if (error) feedback.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [error]);

  const load = useCallback(async signal => {
    try {
      const result = await api('mcp', { signal });
      if (!signal?.aborted) { setData(result); setRefreshError(''); }
    } catch (e) { if (!signal?.aborted) setRefreshError(e.message); }
  }, [api]);
  // 상태는 몇 초마다 다시 읽는다(연결·재연결·호출 수가 계속 바뀐다).
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    const timer = setInterval(() => { if (!document.hidden) load(controller.signal); }, REFRESH_MS);
    return () => { clearInterval(timer); controller.abort(); };
  }, [load]);

  function open(server) {
    if (dirty && !window.confirm('저장하지 않은 변경 사항을 버리시겠습니까?')) return;
    const next = server ? formOf(server) : blankForm();
    setSelected(server ? server.name : ''); setForm(next); setBaseline(JSON.stringify(next));
    setRevision(server?.revision || ''); setProbe(null); setSecretDraft({ name: '', value: '' }); setError(''); setNotice('');
  }
  function close() {
    if (dirty && !window.confirm('저장하지 않은 변경 사항을 버리시겠습니까?')) return;
    setSelected(null); setForm(null); setBaseline(''); setProbe(null); setError('');
  }
  const update = (key, value) => setForm(f => ({ ...f, [key]: value }));

  function request() {
    const { body, problems } = bodyOf(form);
    if (problems.length) throw new Error(problems.join(' '));
    return body;
  }
  async function save(e) {
    e.preventDefault();
    if (busy) return;
    setError(''); setNotice('');
    let body;
    try { body = request(); } catch (err) { setError(err.message); return; }
    setBusy(true);
    try {
      const saved = await api(selected ? `mcp/${encodeURIComponent(selected)}` : 'mcp', {
        method: selected ? 'PUT' : 'POST', body: JSON.stringify(body),
        ...(selected ? { headers: { 'If-Match': `"${revision}"` } } : {}),
      });
      const next = formOf(saved);
      setSelected(saved.name); setForm(next); setBaseline(JSON.stringify(next)); setRevision(saved.revision);
      setNotice('저장했습니다. 다음 질문부터 이 설정으로 연결된 도구를 씁니다.');
      await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (busy || !window.confirm(`MCP 서버 '${selected}'을(를) 삭제하시겠습니까? 서버 프로세스도 멈춥니다.`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`mcp/${encodeURIComponent(selected)}`, { method: 'DELETE', headers: { 'If-Match': `"${revision}"` } });
      setSelected(null); setForm(null); setBaseline(''); setProbe(null);
      setNotice('MCP 서버를 삭제했습니다.');
      await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function restart() {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`mcp/${encodeURIComponent(selected)}/restart`, { method: 'POST' });
      setNotice('다시 연결하는 중입니다.');
      await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function check() {
    let body;
    try { body = request(); } catch (err) { setProbe({ ok: false, message: err.message }); return; }
    setChecking(true); setProbe({ pending: true, message: '연결하는 중…(최대 30초)' });
    try { setProbe(await api('mcp-check', { method: 'POST', body: JSON.stringify({ ...body, original: selected || undefined }) })); }
    catch (err) { setProbe({ ok: false, message: err.message }); }
    finally { setChecking(false); }
  }

  function toggle(tool, on) {
    setForm(f => ({ ...f, tools: toggleTool(f.tools, tool, on) }));
  }
  function changeSecret(kind, name, value) {
    setForm(f => {
      const changes = { ...f.secretChanges[kind] };
      if (value === undefined) delete changes[name]; else changes[name] = value;
      return { ...f, secretChanges: { ...f.secretChanges, [kind]: changes } };
    });
  }

  const editable = !!data?.editable;
  const current = data?.servers.find(server => server.name === selected);
  const status = current?.status;
  const listed = probe?.tools || status?.tools || [];
  const choices = form ? toolChoices(listed, form.tools) : [];
  const secretKind = form?.transport === 'http' ? 'headers' : 'env';

  if (!data) {
    return <div className="admin-feedback">{refreshError ? <div role="alert" className="admin-error">{refreshError} <button type="button" className="admin-secondary" onClick={() => load()}>다시 시도</button></div> : <div className="admin-empty" role="status">MCP 서버 목록을 불러오는 중입니다…</div>}</div>;
  }
  return <div className="admin-mcp">
    <div className="admin-feedback" aria-live="polite">
      {error && <div ref={feedback} role="alert" className="admin-error">{error}</div>}
      {notice && <div role="status" className="admin-success">{notice}</div>}
      {refreshError && <div role="status" className="admin-mcp-readonly">상태를 새로 읽지 못했습니다(아래는 마지막으로 읽은 상태): {refreshError}</div>}
      {!editable && <div className="admin-mcp-readonly">보기만 할 수 있습니다. {data.locked_reason || 'MCP 서버는 서버 PC에서 명령을 실행하므로, 관리자 인증 키를 등록하고 backend를 다시 시작해야 이 화면에서 추가·변경할 수 있습니다(config.toml 직접 편집은 언제나 가능).'}</div>}
    </div>
    <div className={`admin-workspace${form ? ' has-editor' : ''}`}>
      <section className="admin-list-panel" aria-label="MCP 서버 목록">
        <div className="admin-list-caption admin-mcp-caption"><span>서버 <strong>{data.servers.length}</strong>개</span>
          <span><button type="button" className="admin-secondary" title="상태 새로고침" aria-label="상태 새로고침" onClick={() => load()}>↻</button>
            <button type="button" className="admin-primary" disabled={!editable || busy} onClick={() => open(null)}><span aria-hidden="true">＋</span> 서버 추가</button></span>
        </div>
        <div className="admin-records">
          {!data.servers.length ? <div className="admin-empty"><span className="admin-empty-mark" aria-hidden="true">＋</span><h4>등록된 MCP 서버가 없습니다</h4><p>서버를 추가하면 그 서버의 도구 중 허용한 것을 에이전트가 씁니다.</p></div>
            : data.servers.map(server => {
              const state = server.status?.state || (server.enabled ? 'connecting' : 'disabled');
              const tools = server.status?.tools || [];
              const allowed = tools.filter(tool => tool.allowed).length;
              const calls = tools.reduce((sum, tool) => sum + tool.calls, 0);
              const failures = tools.reduce((sum, tool) => sum + tool.failures, 0);
              const refused = tools.filter(tool => tool.allowed && tool.refused).length;
              return <button type="button" key={server.name} className={`admin-record${selected === server.name ? ' selected' : ''}`}
                aria-pressed={selected === server.name} disabled={busy} onClick={() => open(server)}>
                <span className={`admin-mcp-state ${state}`}>{STATE_LABELS[state] || state}</span>
                <span className="admin-record-copy"><strong>{server.name} <small>{server.transport === 'http' ? 'HTTP' : '명령'}</small></strong>
                  <span>{server.status?.error || server.description || '설명이 없습니다.'}</span>
                  <span>도구 {allowed}/{tools.length} 허용 · 호출 {calls}회{failures ? ` · 실패 ${failures}회` : ''}{refused ? ` · 모델이 받지 않은 도구 ${refused}개` : ''}</span></span>
                <span className="admin-record-arrow" aria-hidden="true">↗</span>
              </button>;
            })}
        </div>
      </section>
      {form && <section className="admin-editor" aria-label="MCP 서버 편집" aria-busy={busy}>
        <div className="admin-editor-heading"><div><p>{selected ? `서버 ${selected}` : '새 서버'}</p><h3>MCP 서버 {selected ? '수정' : '추가'}</h3></div><span className={`admin-dirty${dirty ? ' changed' : ''}`}>{dirty ? '저장하지 않음' : selected ? '저장됨' : '새 항목'}</span></div>
        <form noValidate onSubmit={save}>
          <fieldset disabled={busy || !editable} className="admin-fields">
            <div className="admin-field"><label htmlFor="mcp-name">서버 이름<b> *</b></label>
              <input id="mcp-name" value={form.name} maxLength={24} spellCheck={false} autoComplete="off" placeholder="예: jira" onChange={e => update('name', e.target.value)} />
              <small>영문자로 시작해 영문·숫자·-·_ 24자 이하(__는 쓸 수 없고 _로 끝날 수 없음). 도구 이름 앞에 붙습니다(예: jira__search_issues).</small></div>
            <div className="admin-field"><label htmlFor="mcp-description">설명</label>
              <textarea id="mcp-description" rows={2} maxLength={2000} value={form.description} placeholder="예: 사내 Jira 이슈 조회·검색" onChange={e => update('description', e.target.value)} />
              <small>무슨 시스템인지 적으세요. 에이전트가 이 서버의 도구를 고르는 근거로 시스템 프롬프트에 실립니다.</small></div>
            <div className="admin-field admin-field-check"><label htmlFor="mcp-enabled"><input id="mcp-enabled" type="checkbox" checked={form.enabled} onChange={e => update('enabled', e.target.checked)} /> 사용</label></div>
            <div className="admin-field"><span className="admin-field-label">연결 방식</span>
              <div className="admin-mcp-choice" role="radiogroup" aria-label="연결 방식">
                <label><input type="radio" name="mcp-transport" checked={form.transport === 'stdio'} onChange={() => update('transport', 'stdio')} /> 명령 실행(stdio)</label>
                <label><input type="radio" name="mcp-transport" checked={form.transport === 'http'} onChange={() => update('transport', 'http')} /> HTTP 주소(Streamable HTTP)</label>
              </div></div>
            {form.transport === 'stdio' ? <>
              <div className="admin-field"><label htmlFor="mcp-command">실행 명령<b> *</b></label>
                <input id="mcp-command" value={form.command} spellCheck={false} autoComplete="off" placeholder="예: npx" onChange={e => update('command', e.target.value)} />
                <small>경로 없이 쓰면 서버 PC의 PATH에서 찾습니다.</small></div>
              <div className="admin-field"><label htmlFor="mcp-args">인수</label>
                <textarea id="mcp-args" rows={3} spellCheck={false} value={form.args} placeholder={'한 줄에 하나\n-y\n@modelcontextprotocol/server-everything'} onChange={e => update('args', e.target.value)} /></div>
              <div className="admin-field"><label htmlFor="mcp-cwd">작업 폴더</label>
                <div className="admin-input-action"><input id="mcp-cwd" value={form.cwd} spellCheck={false} autoComplete="off" placeholder="비우면 backend 폴더" onChange={e => update('cwd', e.target.value)} />
                  <button type="button" className="admin-secondary" onClick={() => setPicker(true)}>폴더 선택</button></div></div>
              <div className="admin-field"><label htmlFor="mcp-env">환경변수</label>
                <textarea id="mcp-env" rows={3} spellCheck={false} value={form.env} placeholder={'한 줄에 하나: 이름=값\nJIRA_URL=https://jira.example.com\nJIRA_TOKEN=ENV:JIRA_TOKEN'} onChange={e => update('env', e.target.value)} />
                <small>backend의 환경변수는 PATH 등 실행에 필요한 것만 넘어갑니다. 값을 ENV:이름으로 쓰면 backend 환경변수(.env)에서 읽습니다.</small></div>
            </> : <>
              <div className="admin-field"><label htmlFor="mcp-url">서버 주소<b> *</b></label>
                <input id="mcp-url" value={form.url} spellCheck={false} autoComplete="off" placeholder="예: http://wiki-mcp.internal:8080/mcp" onChange={e => update('url', e.target.value)} /></div>
              <div className="admin-field"><label htmlFor="mcp-headers">HTTP 헤더</label>
                <textarea id="mcp-headers" rows={2} spellCheck={false} value={form.headers} placeholder={'한 줄에 하나: 이름: 값\nX-Team: voc'} onChange={e => update('headers', e.target.value)} />
                <small>인증 토큰처럼 숨길 값은 아래 비밀값에 넣으세요.</small></div>
            </>}
            <div className="admin-field admin-field-check"><label htmlFor="mcp-disable-proxy"><input id="mcp-disable-proxy" type="checkbox" checked={form.disableProxy} onChange={e => update('disableProxy', e.target.checked)} /> 프록시 사용 안 함</label>
              <small>{form.transport === 'http'
                ? 'backend 환경변수(HTTP_PROXY·HTTPS_PROXY, .env 포함)의 프록시를 거치지 않고 서버 주소에 바로 접속합니다.'
                : 'backend의 프록시 환경변수(HTTP_PROXY·HTTPS_PROXY)를 넘기지 않고 NO_PROXY=*를 줍니다. 위 환경변수에 적은 값이 우선합니다.'}</small></div>
            <div className="admin-field"><span className="admin-field-label">비밀값({secretKind === 'env' ? '환경변수' : 'HTTP 헤더'})</span>
              <div className="admin-mcp-secrets">
                {form.secretNames[secretKind].map(name => {
                  const change = form.secretChanges[secretKind][name];
                  return <div key={name}><code>{name}</code> <span className={`admin-badge${change === null ? '' : ' on'}`}>{change === null ? '지울 예정' : change !== undefined ? '새 값 입력됨' : '등록됨'}</span>
                    {change === undefined ? <button type="button" className="admin-bind-remove" onClick={() => changeSecret(secretKind, name, null)}>지우기</button>
                      : <button type="button" className="admin-bind-remove" onClick={() => changeSecret(secretKind, name, undefined)}>취소</button>}</div>;
                })}
                {Object.entries(form.secretChanges[secretKind]).filter(([name, value]) => value !== null && !form.secretNames[secretKind].includes(name)).map(([name]) =>
                  <div key={name}><code>{name}</code> <span className="admin-badge on">새 값 입력됨</span><button type="button" className="admin-bind-remove" onClick={() => changeSecret(secretKind, name, undefined)}>취소</button></div>)}
                <div className="admin-input-action">
                  <input aria-label="비밀값 이름" placeholder={secretKind === 'env' ? '이름 (예: JIRA_TOKEN)' : '헤더 이름 (예: Authorization)'} spellCheck={false} autoComplete="off" value={secretDraft.name} onChange={e => setSecretDraft(d => ({ ...d, name: e.target.value }))} />
                  <input aria-label="비밀값" type="password" autoComplete="new-password" placeholder="값" value={secretDraft.value} onChange={e => setSecretDraft(d => ({ ...d, value: e.target.value }))} />
                  <button type="button" className="admin-secondary" disabled={!secretDraft.name.trim() || !secretDraft.value} onClick={() => { changeSecret(secretKind, secretDraft.name.trim(), secretDraft.value); setSecretDraft({ name: '', value: '' }); }}>넣기</button>
                </div>
                <small>config.credentials.json에 저장되고 화면에는 다시 보이지 않습니다. 같은 이름의 일반 값보다 우선합니다.</small>
              </div></div>
            <div className="admin-field"><label htmlFor="mcp-timeout">호출 시간 한도(초)</label>
              <input id="mcp-timeout" inputMode="numeric" value={form.timeout} placeholder={`비우면 ${data.default_timeout_secs}초(설정 탭의 도구 시간 한도)`} onChange={e => update('timeout', e.target.value)} /></div>
            <div className="admin-field"><span className="admin-field-label">허용 도구</span>
              <div className="admin-mcp-tools">
                <label className="admin-mcp-all"><input type="checkbox" checked={form.allTools} onChange={e => update('allTools', e.target.checked)} /> 모든 도구 허용(*) — 서버가 나중에 추가한 도구도 바로 쓰입니다</label>
                {!choices.length ? <p>서버가 연결되면 도구 목록이 보입니다. 저장 전이면 '연결 확인'으로 목록을 받아 오세요.</p>
                  : choices.map(tool => {
                    const hints = tool.annotations || {};
                    return <label key={tool.name} className={tool.missing ? 'missing' : ''}>
                      <input type="checkbox" disabled={form.allTools} checked={isAllowed(form, tool)} onChange={e => toggle(tool, e.target.checked)} />
                      <span><strong>{tool.name}</strong>{tool.missing ? <em> 지금 목록에 없음</em> : <>
                        {hints.readOnlyHint && <em className="safe"> 읽기 전용</em>}{hints.destructiveHint && <em> 변경·삭제 가능</em>}
                        {tool.refused && <em title={tool.refused.reason}> 모델 {tool.refused.model}이(가) 정의를 받지 않아 빠짐('다시 연결'하면 다시 시도)</em>}
                        {tool.tokens ? <small> · 약 {tool.tokens.toLocaleString()} 토큰</small> : null}
                        {tool.description && <span className="admin-mcp-tool-description">{tool.description}</span>}</>}</span>
                    </label>;
                  })}
              </div>
              <small>허용한 도구의 정의는 질문마다 모든 요청에 실립니다(지금 약 {allowedTokens(choices, form).toLocaleString()} 토큰). 꼭 필요한 도구만 고르세요. 읽기 전용 표시는 서버가 붙인 힌트일 뿐 보장이 아닙니다.</small></div>
          </fieldset>
          <div className="admin-settings-check admin-mcp-check">
            <button type="button" className="admin-secondary" disabled={!editable || busy || checking} onClick={check}>연결 확인</button>
            {probe && <span role="status" className={probe.pending ? '' : probe.ok ? 'admin-check-ok' : 'admin-check-fail'}>{probe.message}</span>}
          </div>
          <div className="admin-form-actions">{selected && editable && <button type="button" className="admin-delete" disabled={busy} onClick={remove}>삭제</button>}
            <div>{selected && editable && current?.enabled && <button type="button" className="admin-secondary" disabled={busy || dirty} title={dirty ? '저장한 뒤 다시 연결할 수 있습니다' : undefined} onClick={restart}>다시 연결</button>}
              <button type="button" className="admin-secondary" disabled={busy} onClick={close}>닫기</button>
              <button type="submit" className="admin-primary" disabled={!editable || busy || (!!selected && !dirty)}>{busy ? '처리 중…' : '저장'}</button></div>
          </div>
        </form>
        {status && <ServerStatus status={status} />}
      </section>}
    </div>
    <p className="admin-footnote">MCP 서버의 도구는 이름이 서버__도구 형식으로 에이전트에 보입니다. 연결이 끊긴 서버는 1초부터 최대 60초 간격으로 다시 연결하며, 그동안 다른 도구는 그대로 쓰입니다. 호출 수는 backend를 다시 시작하면 처음부터 셉니다.</p>
    {picker && <DirectoryPicker api={api} start={form?.cwd} onClose={() => setPicker(false)} onPick={path => { update('cwd', path); setPicker(false); }} />}
  </div>;
}

function ServerStatus({ status }) {
  const log = useRef(null);
  const last = status.log[status.log.length - 1];
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [last?.at, last?.text]);
  const info = status.server_info || {};
  return <div className="admin-mcp-status" aria-label="연결 상태">
    <h4>연결 상태</h4>
    <dl>
      <dt>상태</dt><dd><span className={`admin-mcp-state ${status.state}`}>{STATE_LABELS[status.state] || status.state}</span> {when(status.since)}부터</dd>
      {status.error && <><dt>오류</dt><dd className="admin-check-fail">{status.error}</dd></>}
      {status.retry_at && status.state === 'failed' && <><dt>다음 연결</dt><dd>{when(status.retry_at)}</dd></>}
      <dt>재연결</dt><dd>{status.restarts}회</dd>
      {info.name && <><dt>서버</dt><dd>{info.name} {info.version} · 프로토콜 {info.protocol_version}</dd></>}
    </dl>
    {info.instructions && <details><summary>서버가 준 사용 안내</summary><p className="admin-mcp-instructions">{info.instructions}</p><small>모델에게는 보내지 않습니다. 필요한 내용은 서버 설명에 옮겨 적으세요.</small></details>}
    {status.tools.length > 0 && <div className="admin-mcp-table"><table>
      <thead><tr><th>도구</th><th>허용</th><th>호출</th><th>실패</th><th>취소</th><th>평균</th><th>최근 오류</th></tr></thead>
      <tbody>{status.tools.map(tool => <tr key={tool.name}>
        <td title={tool.exposed}>{tool.name}</td>
        <td>{!tool.allowed ? '' : tool.refused ? <span className="admin-check-fail" title={`모델 ${tool.refused.model}이(가) 정의를 받지 않음: ${tool.refused.reason}`}>✓ 빠짐</span> : '✓'}</td><td>{tool.calls}</td><td>{tool.failures || ''}</td><td>{tool.cancelled || ''}</td>
        <td>{tool.avg_ms != null ? `${tool.avg_ms.toLocaleString()} ms` : ''}</td><td className="admin-mcp-error">{tool.last_error || ''}</td>
      </tr>)}</tbody>
    </table></div>}
    <h4>최근 기록</h4>
    {status.log.length ? <pre ref={log} className="admin-mcp-log">{status.log.map(line => `${when(line.at)} [${line.source}] ${line.text}`).join('\n')}</pre>
      : <p className="admin-settings-help">아직 기록이 없습니다.</p>}
  </div>;
}
