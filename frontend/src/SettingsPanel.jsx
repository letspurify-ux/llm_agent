import { useEffect, useRef, useState } from 'react';
import DirectoryPicker from './DirectoryPicker.jsx';
import { SETTING_GROUPS, SECRETS, formOf, configOf } from './settings-fields.js';

// 서버 설정(backend/config.toml) 화면. 비밀값(API 키·관리 DB 비밀번호·관리자 인증 키)은 서버가 돌려주지 않는다 —
// 등록 여부만 보이고, 새 값을 넣거나 지울 수만 있다. 저장은 다른 화면과 같은 revision 대조(If-Match)를 거친다.
export default function SettingsPanel({ api, onStateChange }) {
  const [loaded, setLoaded] = useState(null);
  const [form, setForm] = useState(null);
  const [baseline, setBaseline] = useState('');
  const [secrets, setSecrets] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState({});
  const [picker, setPicker] = useState(null);
  const feedback = useRef(null);
  const dirty = !!form && (JSON.stringify(form) !== baseline || Object.keys(secrets).length > 0);

  useEffect(() => { onStateChange({ dirty, busy }); }, [dirty, busy, onStateChange]);
  useEffect(() => {
    if (!dirty && !busy) return undefined;
    const warn = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);
  useEffect(() => { if (error) feedback.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [error]);

  function accept(result) {
    const next = formOf(result.config);
    setLoaded(result); setForm(next); setBaseline(JSON.stringify(next)); setSecrets({});
  }
  async function load() {
    setError('');
    try { accept(await api('settings')); } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function body() {
    const { config, problems } = configOf(form);
    if (problems.length) throw new Error(problems.join(' '));
    return { config, secrets };
  }
  async function save(e) {
    e.preventDefault();
    if (busy) return;
    setError(''); setNotice('');
    let request;
    try { request = body(); } catch (err) { setError(err.message); return; }
    setBusy(true);
    try {
      const result = await api('settings', { method: 'PUT', body: JSON.stringify(request), headers: { 'If-Match': `"${loaded.revision}"` } });
      accept(result);
      setNotice(result.restart_required?.length
        ? `설정을 저장했습니다. 다음 항목은 서버를 다시 시작해야 적용됩니다: ${result.restart_required.join(', ')}`
        : '설정을 저장했습니다. 다음 질문부터 적용됩니다.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function check(target) {
    let request;
    try { request = body(); } catch (err) { setChecks(c => ({ ...c, [target]: { ok: false, message: err.message } })); return; }
    setChecks(c => ({ ...c, [target]: { pending: true, message: '확인하는 중…' } }));
    try {
      const result = await api('settings/check', { method: 'POST', body: JSON.stringify({ ...request, target }) });
      setChecks(c => ({ ...c, [target]: result }));
    } catch (err) { setChecks(c => ({ ...c, [target]: { ok: false, message: err.message } })); }
  }
  const update = (key, value) => setForm(f => ({ ...f, [key]: value }));

  if (!form) {
    return <div className="admin-feedback">{error ? <div ref={feedback} role="alert" className="admin-error">{error} <button type="button" className="admin-secondary" onClick={load}>다시 시도</button></div> : <div className="admin-empty" role="status">설정을 불러오는 중입니다…</div>}</div>;
  }
  return <form className="admin-settings" noValidate onSubmit={save}>
    <div className="admin-feedback" aria-live="polite">
      {error && <div ref={feedback} role="alert" className="admin-error">{error}</div>}
      {notice && <div role="status" className="admin-success">{notice}</div>}
    </div>
    {SETTING_GROUPS.map(group => <fieldset key={group.id} className="admin-settings-group" disabled={busy}>
      <legend>{group.title}</legend>
      {group.description && <p className="admin-settings-help">{group.description}</p>}
      {group.status && loaded.status?.[group.status] && <p className="admin-settings-status">{loaded.status[group.status].message}</p>}
      <div className="admin-settings-grid">
        {group.fields.map(([key, label, type, help]) => {
          const id = `setting-${key.replace('.', '-')}`;
          return <div key={key} className={`admin-field${type === 'boolean' ? ' admin-field-check' : ''}`}>
            {type === 'boolean'
              ? <label htmlFor={id}><input id={id} type="checkbox" checked={!!form[key]} onChange={e => update(key, e.target.checked)} /> {label}</label>
              : <label htmlFor={id}>{label}</label>}
            {type === 'effort' ? <select id={id} value={form[key]} onChange={e => update(key, e.target.value)}>
              <option value="">보내지 않음</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
            </select>
              : type === 'folder' ? <div className="admin-input-action">
                <input id={id} value={form[key]} spellCheck={false} onChange={e => update(key, e.target.value)} />
                <button type="button" className="admin-secondary" onClick={() => setPicker(key)}>폴더 선택</button>
              </div>
                : type !== 'boolean' && <input id={id} value={form[key]} spellCheck={false} inputMode={['text', 'url', 'optionalText', 'list'].includes(type) ? undefined : 'decimal'}
                  onChange={e => update(key, e.target.value)} />}
            {help && <small>{help}</small>}
          </div>;
        })}
      </div>
      {SECRETS.filter(s => s.group === group.id).map(secret => {
        const registered = loaded.secrets?.[secret.key];
        const pending = secrets[secret.key];
        return <div key={secret.key} className="admin-secret">
          <div><strong>{secret.label}</strong> <span className={`admin-badge${registered ? ' on' : ''}`}>{pending === null ? '지울 예정' : registered ? '등록됨' : '미등록'}</span></div>
          <div className="admin-input-action">
            <input type="password" autoComplete="new-password" aria-label={`${secret.label} 새 값`} placeholder={registered ? '바꿀 때만 입력하세요' : '값을 입력하세요'}
              value={typeof pending === 'string' ? pending : ''} onChange={e => setSecrets(s => {
                const next = { ...s };
                if (e.target.value) next[secret.key] = e.target.value; else delete next[secret.key];
                return next;
              })} />
            {registered && <button type="button" className="admin-secondary" onClick={() => setSecrets(s => ({ ...s, [secret.key]: null }))}>지우기</button>}
          </div>
          {secret.help && <small>{secret.help}</small>}
        </div>;
      })}
      {group.check && <div className="admin-settings-check">
        <button type="button" className="admin-secondary" disabled={busy || checks[group.check]?.pending} onClick={() => check(group.check)}>연결 확인</button>
        {checks[group.check] && <span role="status" className={checks[group.check].pending ? '' : checks[group.check].ok ? 'admin-check-ok' : 'admin-check-fail'}>{checks[group.check].message}</span>}
      </div>}
    </fieldset>)}
    <div className="admin-form-actions"><span className={`admin-dirty${dirty ? ' changed' : ''}`}>{dirty ? '저장하지 않음' : '저장됨'}</span>
      <div><button type="button" className="admin-secondary" disabled={busy || !dirty} onClick={() => { if (window.confirm('변경 사항을 버리고 저장된 설정으로 되돌리시겠습니까?')) load(); }}>되돌리기</button>
        <button type="submit" className="admin-primary" disabled={busy || !dirty}>{busy ? '처리 중…' : '설정 저장'}</button></div>
    </div>
    {picker && <DirectoryPicker api={api} start={form[picker]} onClose={() => setPicker(null)} onPick={path => { update(picker, path); setPicker(null); }} />}
  </form>;
}
