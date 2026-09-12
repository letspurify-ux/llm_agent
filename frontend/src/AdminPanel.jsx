import { useCallback, useEffect, useRef, useState } from 'react';
import './admin.css';
import BindConfigEditor from './BindConfigEditor.jsx';
import { readBindings, serializeBindings } from './admin-bindings.js';

const SECTIONS = {
  databases: { label: 'DB', title: '조회 대상 DB 설정', description: '에이전트가 실제로 조회할 Oracle DB의 접속 정보를 관리합니다. 관리용 MariaDB 설정은 서버 환경변수에서 관리합니다.', name: 'db_name', search: 'DB 이름, 접속 주소, 사용자명 검색',
    fields: [
      ['db_name', 'DB 이름', 'text', 100, true, '예: ORDER_DB'],
      ['db_type', 'DB 유형', 'select', 20, true],
      ['connection_info', '접속 주소', 'text', 500, true, '예: localhost:1521/FREEPDB1'],
      ['db_user', '사용자명', 'text', 100, true, '예: VOC_READER'],
      ['db_password', '조회 대상 DB 비밀번호 또는 환경변수 참조', 'password', 200, true, '예: ENV:ORDER_DB_PASSWORD'],
    ] },
  knowledge: { label: '지식', title: '지식 관리', description: '답변의 근거가 되는 문서와 업무 지식을 관리합니다.', name: 'title', search: '지식 제목 또는 본문 검색',
    fields: [['title', '제목', 'text', 200, true, '예: SPACE 시스템 소개'], ['content', '지식 본문', 'textarea', null, true, '업무 지식이나 문서 내용을 입력하세요.']] },
  methods: { label: '방법', title: 'Q&A 처리 방법', description: '질문을 해결하는 절차와 사용할 쿼리를 관리합니다.', name: 'title', search: '방법 제목, 처리 절차, 쿼리 이름 검색',
    fields: [['title', '제목', 'text', 200, true, '예: 주문 상태 확인'], ['method', '처리 방법', 'textarea', null, true, '처리 순서와 사용할 쿼리 이름을 구체적으로 입력하세요.']] },
  queries: { label: '쿼리', title: '쿼리 관리', description: '답변에 사용할 조회 SQL, 프로시저, 함수와 입력·출력 설명을 관리합니다.', name: 'query_name', search: '쿼리 이름, SQL, 설명, 대상 DB 검색',
    fields: [
      ['query_type', '실행 유형', 'select', 20, true],
      ['query_name', '쿼리 이름', 'text', 100, true, '예: CUSTOMER_ORDERS'],
      ['query_desc', '쿼리 설명', 'textarea', null, false, '어떤 질문에 사용하는 쿼리인지 설명하세요.'],
      ['target_db_name', '대상 DB', 'databases', 500, true],
      ['query_sql', '실행 SQL', 'sql', null, true, 'SELECT * FROM orders WHERE customer_id = :customer_id'],
      ['bind_config', '바인드 설정', 'bindings', null, false],
      ['input_desc', '입력 설명', 'textarea', 1000, false, '예: customer_id — 고객 번호 (필수, 숫자)'],
      ['output_desc', '출력 설명', 'textarea', null, false, '조회 결과의 컬럼과 의미를 설명하세요.'],
    ] },
};
const blank = kind => Object.fromEntries(SECTIONS[kind].fields.map(([key]) => [key, key === 'db_type' ? 'oracle' : key === 'query_type' ? 'QUERY' : key === 'bind_config' ? readBindings('') : '']));
const valuesOf = (kind, row) => Object.fromEntries(SECTIONS[kind].fields.map(([key]) => [key,
  key === 'db_type' ? String(row[key] || 'oracle').toLowerCase() : key === 'query_type' ? row[key] ?? 'QUERY' : key === 'bind_config' ? readBindings(row[key]) : row[key] ?? '',
]));
const dbNames = text => text.split(';').map(s => s.trim()).filter(Boolean);
const REQUIRED_ERROR = '필수 입력 항목을 확인해주세요.';

export default function AdminPanel({ onStateChange }) {
  const [kind, setKind] = useState('databases');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [list, setList] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState(null);
  const [draft, setDraft] = useState({});
  const [baseline, setBaseline] = useState('');
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [options, setOptions] = useState([]);
  const [optionSearch, setOptionSearch] = useState('');
  const [optionError, setOptionError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [token, setToken] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [authError, setAuthError] = useState('');
  const [authAttempted, setAuthAttempted] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);
  const generation = useRef(0);
  const mutation = useRef(false);
  const firstField = useRef(null);
  const feedbackRef = useRef(null);
  const optionErrorRef = useRef(null);
  const fieldRefs = useRef({});
  const config = SECTIONS[kind];
  const dirty = !!editor && JSON.stringify(draft) !== baseline;

  const api = useCallback(async (path, { signal, headers, ...init } = {}) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, 60_000);
    try {
      const response = await fetch(`/api/admin/${path}`, { ...init, signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1', 'X-Admin-Token': token, ...headers },
      });
      if (response.status === 204) return null;
      const data = await response.json().catch(() => { throw new Error('서버 응답을 읽지 못했습니다. 백엔드 실행 상태를 확인해주세요.'); });
      if (response.status === 401) {
        setNeedsAuth(true); setList(null);
        if (authAttempted) setAuthError('인증에 실패했습니다. 관리자 인증 키를 확인한 후 다시 입력해주세요.');
      }
      if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
      setNeedsAuth(false); setAuthError(''); setAuthAttempted(false);
      return data;
    } catch (e) {
      if (controller.signal.aborted && !signal?.aborted) throw new Error('서버 응답이 늦어지고 있습니다. 목록을 새로고침해 저장 여부를 확인해주세요.');
      if (e instanceof TypeError) throw new Error('서버에 연결하지 못했습니다. 연결 상태를 확인해주세요.');
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }, [token, authAttempted]);

  useEffect(() => {
    onStateChange({ dirty, busy });
  }, [dirty, busy, onStateChange]);
  useEffect(() => {
    const key = Object.keys(fieldErrors)[0];
    const target = key ? fieldRefs.current[key] : needsAuth && (authError || (authAttempted && error)) ? feedbackRef.current : error ? feedbackRef.current : optionError ? optionErrorRef.current : null;
    if (!target) return undefined;
    const frame = requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'smooth', block: key ? 'center' : 'start' });
      if (key) target.querySelector('input:not([type="checkbox"]), textarea, select')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [error, optionError, fieldErrors, authError, authAttempted, needsAuth]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);
  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const timer = setTimeout(async () => {
      try {
        const result = await api(`${kind}?${new URLSearchParams({ q: search, page: String(page) })}`, { signal: controller.signal });
        if (!controller.signal.aborted) setList(result);
      } catch (e) { if (!controller.signal.aborted) { setError(e.message); setList(null); } }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, search ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [kind, search, page, refresh, api]);
  useEffect(() => {
    if (kind !== 'queries') return;
    const controller = new AbortController();
    setOptions([]);
    setOptionError('');
    api('database-options', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setOptions(result.items);
    }).catch(e => { if (!controller.signal.aborted) setOptionError(e.message); });
    return () => controller.abort();
  }, [kind, api, refresh]);
  useEffect(() => { if (editor) firstField.current?.focus(); }, [editor]);

  function canLeave() {
    return !busy && !mutation.current && (!dirty || window.confirm('저장하지 않은 변경 사항을 버리시겠습니까?'));
  }
  function clearEditor() {
    generation.current += 1;
    setEditor(null); setDraft({}); setBaseline(''); setOpening(false); setOptionSearch(''); setFieldErrors({}); setError(''); setOptionError('');
    fieldRefs.current = {};
  }
  function changeSection(next) {
    if (next === kind || !canLeave()) return;
    clearEditor(); setKind(next); setSearch(''); setPage(1); setList(null); setNotice('');
  }
  async function openEditor(item) {
    if (!canLeave()) return;
    const current = ++generation.current;
    setError(''); setNotice(''); setFieldErrors({}); setOpening(true);
    try {
      const row = item ? await api(`${kind}/${item.seq}`) : {};
      if (current !== generation.current) return;
      const next = item ? valuesOf(kind, row) : blank(kind);
      setDraft(next); setBaseline(JSON.stringify(next)); setEditor(row); setOptionSearch('');
    } catch (e) { if (current === generation.current) setError(e.message); }
    finally { if (current === generation.current) setOpening(false); }
  }
  function validateRequiredFields() {
    const missing = {};
    for (const [key, label, type, , required] of config.fields) {
      const keepPassword = key === 'db_password' && !!editor?.seq;
      if (!required || keepPassword) continue;
      const value = draft[key] ?? '';
      const empty = type === 'databases' ? dbNames(value).length === 0 : !String(value).trim();
      if (empty) missing[key] = `${label}을(를) 입력해주세요.`;
    }
    if (kind === 'queries' && draft.query_type !== 'QUERY') {
      try { serializeBindings(draft.bind_config, draft.query_sql, draft.query_type); }
      catch (e) { missing.bind_config = e.message; }
    }
    if (!Object.keys(missing).length) return true;
    setFieldErrors(missing);
    setError(REQUIRED_ERROR);
    return false;
  }
  function updateField(key, value) {
    setDraft(d => ({ ...d, [key]: value }));
    setFieldErrors(errors => {
      if (!errors[key]) return errors;
      const next = { ...errors };
      delete next[key];
      return next;
    });
    setError(current => current === REQUIRED_ERROR ? '' : current);
  }
  async function save(e) {
    e.preventDefault();
    if (mutation.current) return;
    setFieldErrors({});
    if (!validateRequiredFields()) return;
    mutation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const row = await api(`${kind}${editor.seq ? `/${editor.seq}` : ''}`, {
        method: editor.seq ? 'PUT' : 'POST', body: JSON.stringify(kind === 'queries'
          ? { ...draft, bind_config: serializeBindings(draft.bind_config, draft.query_sql, draft.query_type) } : draft),
        ...(editor.seq ? { headers: { 'If-Match': `"${editor.revision}"` } } : {}),
      });
      const next = valuesOf(kind, row);
      setEditor(row); setDraft(next); setBaseline(JSON.stringify(next));
      setNotice(`${config.label} 설정을 저장했습니다.`); setRefresh(n => n + 1);
    } catch (e) { setError(e.message); }
    finally { mutation.current = false; setBusy(false); }
  }
  async function remove() {
    if (mutation.current || !window.confirm(`'${editor[config.name]}' 항목을 삭제하시겠습니까? 삭제한 데이터는 복구할 수 없습니다.`)) return;
    mutation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await api(`${kind}/${editor.seq}`, { method: 'DELETE', headers: { 'If-Match': `"${editor.revision}"` } });
      clearEditor(); setNotice('항목을 삭제했습니다.'); setRefresh(n => n + 1);
    } catch (e) { setError(e.message); }
    finally { mutation.current = false; setBusy(false); }
  }

  return <main className="admin" aria-label="관리자 화면">
    <div className="admin-shell">
      <nav className="admin-tabs" aria-label="관리 항목">
        {Object.entries(SECTIONS).map(([key, section], index) => <button type="button" key={key}
          aria-current={kind === key ? 'page' : undefined} disabled={busy} onClick={() => changeSection(key)}>
          <span className="admin-tab-number" aria-hidden="true">0{index + 1}</span>{section.label}
        </button>)}
      </nav>
      {needsAuth ? <form className="admin-auth" noValidate onSubmit={e => {
        e.preventDefault();
        if (!keyInput.trim()) { setAuthError('관리자 인증 키를 입력해주세요.'); return; }
        setAuthError(''); setAuthAttempted(true); setToken(keyInput); setKeyInput(''); setRefresh(n => n + 1);
      }}>
        <h3>관리자 인증</h3><p>서버에 설정된 관리자 인증 키를 입력하세요.</p>
        <label htmlFor="admin-token">관리자 인증 키</label><input id="admin-token" type="password" autoComplete="off" required aria-invalid={authError ? 'true' : undefined} aria-describedby={authError ? 'admin-token-error' : undefined} value={keyInput} onChange={e => { setKeyInput(e.target.value); setAuthError(''); setError(''); }} />
        {(authError || (authAttempted && error)) && <p id="admin-token-error" ref={feedbackRef} role="alert" className="admin-error">{authError || error}</p>}<button className="admin-primary" type="submit">인증하기</button>
      </form> : <>
        <div className="admin-section-heading"><div><h3>{config.title}</h3><p>{config.description}</p></div>
          <button className="admin-primary" type="button" disabled={busy || opening || loading} onClick={() => openEditor(null)}><span aria-hidden="true">＋</span> {config.label} 추가</button>
        </div>
        <div className="admin-feedback" aria-live="polite">
          {error && <div ref={feedbackRef} role="alert" className="admin-error">{error}</div>}
          {notice && <div role="status" className="admin-success">{notice}</div>}
        </div>
        <div className={`admin-workspace${editor ? ' has-editor' : ''}`}>
          <section className="admin-list-panel" aria-label={`${config.label} 목록`}>
            <div className="admin-search-row">
              <div className="admin-search"><span aria-hidden="true">⌕</span><input type="search" aria-label={`${config.label} 검색`} placeholder={config.search} maxLength={200}
                value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} /></div>
              <button type="button" className="admin-secondary" title="목록 새로고침" aria-label="목록 새로고침" disabled={loading || busy} onClick={() => setRefresh(n => n + 1)}>↻</button>
            </div>
            <div className="admin-list-caption"><span>{search ? '검색 결과' : '전체 항목'} <strong>{loading ? '…' : (list?.total ?? 0).toLocaleString()}</strong>건</span><span>최근 등록순 · 20개씩</span></div>
            <div className="admin-records" aria-busy={loading || opening}>
              {loading ? <div className="admin-empty" role="status">목록을 불러오는 중입니다…</div>
                : !list ? <div className="admin-empty"><h4>목록을 불러오지 못했습니다</h4><p>연결 상태를 확인하고 다시 시도하세요.</p><button className="admin-secondary" type="button" onClick={() => setRefresh(n => n + 1)}>다시 시도</button></div>
                  : !list.items.length ? <div className="admin-empty"><span className="admin-empty-mark" aria-hidden="true">{search ? '⌕' : '＋'}</span><h4>{search ? '검색 결과가 없습니다' : `등록된 ${config.label} 항목이 없습니다`}</h4><p>{search ? '다른 검색어로 찾아보세요.' : '첫 항목을 추가해 설정을 시작하세요.'}</p>{search && <button type="button" className="admin-secondary" onClick={() => { setSearch(''); setPage(1); }}>검색 초기화</button>}</div>
                    : list.items.map(item => <button type="button" key={item.seq} className={`admin-record${editor?.seq === item.seq ? ' selected' : ''}`}
                      aria-pressed={editor?.seq === item.seq} disabled={busy || opening} onClick={() => openEditor(item)}>
                      <span className="admin-record-id">#{item.seq}</span><span className="admin-record-copy"><strong>{kind === 'queries' && item.query_type && `[${({ QUERY: '쿼리', PROCEDURE: '프로시저', FUNCTION: '함수' })[item.query_type] || item.query_type}] `}{item.name}</strong><span>{item.summary || '설명이 없습니다.'}</span></span><span className="admin-record-arrow" aria-hidden="true">↗</span>
                    </button>)}
            </div>
            {list && !loading && list.total > 0 && <div className="admin-pagination">
              <span>{(list.page - 1) * list.pageSize + 1}–{Math.min(list.page * list.pageSize, list.total)} / {list.total.toLocaleString()}건</span>
              <div><button type="button" aria-label="이전 페이지" disabled={list.page <= 1} onClick={() => setPage(list.page - 1)}>이전</button><span>{list.page} / {Math.ceil(list.total / list.pageSize)}</span><button type="button" aria-label="다음 페이지" disabled={list.page * list.pageSize >= list.total} onClick={() => setPage(list.page + 1)}>다음</button></div>
            </div>}
          </section>
          {editor && <section className="admin-editor" aria-label={`${config.label} 편집`} aria-busy={busy || opening}>
            <div className="admin-editor-heading"><div><p>{editor.seq ? `항목 #${editor.seq}` : '새 항목'}</p><h3>{config.label} {editor.seq ? '수정' : '추가'}</h3></div><span className={`admin-dirty${dirty ? ' changed' : ''}`}>{dirty ? '저장하지 않음' : editor.seq ? '저장됨' : '새 항목'}</span></div>
            <form noValidate onSubmit={save}>
              <fieldset disabled={busy || opening} className="admin-fields">
                {config.fields.map(([key, label, type, limit, required, placeholder], index) => {
                  if (type === 'bindings' && draft.query_type === 'QUERY') return null;
                  const id = `admin-field-${key}`;
                  const keepPassword = key === 'db_password' && !!editor.seq;
                  const fieldError = fieldErrors[key];
                  const props = { id, ref: index === 0 ? firstField : undefined, value: draft[key] ?? '', required: required && !keepPassword,
                    maxLength: limit || undefined, placeholder, 'aria-invalid': fieldError ? 'true' : undefined,
                    'aria-describedby': fieldError ? `${id}-error` : undefined, onChange: e => updateField(key, e.target.value) };
                  return <div className="admin-field" key={key} ref={node => { fieldRefs.current[key] = node; }}>
                    {type === 'databases' || type === 'bindings' ? <span className="admin-field-label" id={`${id}-label`}>{label}{required && <b>*</b>}</span>
                      : <label htmlFor={id}>{label}{required && !keepPassword && <b> *</b>}{limit && type === 'textarea' && <small>{(draft[key] || '').length} / {limit}</small>}</label>}
                    {type === 'bindings' ? <BindConfigEditor id={id} value={draft.bind_config} sql={draft.query_sql} queryType={draft.query_type} invalid={!!fieldError} onChange={value => updateField(key, value)} />
                      : type === 'select' ? <select {...props}>{key === 'query_type' ? <><option value="QUERY">쿼리 (QUERY)</option><option value="PROCEDURE">프로시저 (PROCEDURE)</option><option value="FUNCTION">함수 (FUNCTION)</option></> : <option value="oracle">Oracle</option>}</select>
                      : type === 'databases' ? <div className={`admin-db-picker${fieldError ? ' has-error' : ''}`} role="group" aria-labelledby={`${id}-label`} aria-invalid={fieldError ? 'true' : undefined} aria-describedby={fieldError ? `${id}-error` : undefined}>
                        <input type="search" aria-label="대상 DB 목록 검색" placeholder="등록된 DB 검색" value={optionSearch} onChange={e => setOptionSearch(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }} />
                        {optionError ? <p ref={optionErrorRef} role="alert" className="admin-error">{optionError}</p> : !options.length ? <p>등록된 DB가 없습니다. DB 탭에서 먼저 추가해주세요.</p> : <div className="admin-db-options">
                          {options.filter(option => option.db_name.toLowerCase().includes(optionSearch.toLowerCase())).map(option => <label key={option.seq}>
                            <input type="checkbox" checked={dbNames(draft[key]).some(n => n.toLowerCase() === option.db_name.toLowerCase())} onChange={e => updateField(key, (e.target.checked ? [...dbNames(draft[key]), option.db_name] : dbNames(draft[key]).filter(n => n.toLowerCase() !== option.db_name.toLowerCase())).join(';'))} />{option.db_name}
                          </label>)}
                        </div>}
                        <div className="admin-selected-dbs" aria-label="선택한 대상 DB">
                          {dbNames(draft[key]).map(name => <span key={name}>{name}<button type="button" aria-label={`${name} 선택 해제`}
                            onClick={() => updateField(key, dbNames(draft[key]).filter(n => n !== name).join(';'))}>×</button></span>)}
                        </div>
                        <small>{draft[key] ? '목록에 없는 기존 DB도 위에서 선택 해제할 수 있습니다.' : '선택한 DB가 없습니다.'} 여러 DB를 선택할 수 있습니다.</small>
                        {fieldError && <p id={`${id}-error`} role="alert" className="admin-field-error">{fieldError}</p>}
                      </div>
                        : type === 'textarea' || type === 'sql' ? <textarea {...props} className={type === 'sql' ? 'admin-sql' : ''} rows={['content', 'method', 'query_sql'].includes(key) ? 12 : 3} spellCheck={type === 'sql' ? false : undefined} />
                          : <input {...props} type={type} autoComplete={type === 'password' ? 'new-password' : 'off'} placeholder={keepPassword ? '변경할 때만 입력하세요' : placeholder} />}
                    {type !== 'databases' && fieldError && <p id={`${id}-error`} role="alert" className="admin-field-error">{fieldError}</p>}
                    {keepPassword && <small>현재 비밀번호: {editor.has_password ? '설정됨' : '없음'}. 비워 두면 기존 값을 유지합니다.</small>}
                    {key === 'db_password' && <small>서버 환경변수를 사용하려면 ENV:변수명 형식으로 입력하세요.</small>}
                    {key === 'query_sql' && <small>{draft.query_type === 'PROCEDURE' ? '예: BEGIN app.get_orders(:id, :result); END;' : draft.query_type === 'FUNCTION' ? '예: BEGIN :result := app.get_total(:id); END;' : 'SELECT 또는 WITH 조회를 등록하세요. 입력값은 :파라미터 바인드를 사용하세요.'}</small>}
                    {key === 'method' && <small>사용할 쿼리 이름을 본문에 적으면 에이전트가 해당 쿼리를 찾습니다.</small>}
                  </div>;
                })}
              </fieldset>
              <div className="admin-form-actions">{editor.seq && <button type="button" className="admin-delete" disabled={busy || opening} onClick={remove}>삭제</button>}
                <div><button type="button" className="admin-secondary" disabled={busy || opening} onClick={() => { if (canLeave()) clearEditor(); }}>닫기</button><button type="submit" className="admin-primary" disabled={busy || opening || (!!editor.seq && !dirty)}>{busy ? '처리 중…' : '저장'}</button></div>
              </div>
            </form>
          </section>}
        </div>
        <p className="admin-footnote">DB와 쿼리 설정은 저장 후 조회에 적용됩니다. 지식·방법·쿼리의 검색 색인은 서버의 다음 임베딩 동기화 후 갱신됩니다.</p>
      </>}
    </div>
  </main>;
}
