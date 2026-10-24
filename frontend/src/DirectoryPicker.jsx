import { useEffect, useRef, useState } from 'react';

// 서버 PC의 폴더를 고르는 창. 프로젝트 폴더와 Oracle Instant Client 폴더를 직접 타이핑하지 않고 고르게 한다.
// 목록은 서버가 준다(/api/admin/directories) — 브라우저는 서버의 파일 시스템을 볼 수 없다.
export default function DirectoryPicker({ api, start, onPick, onClose }) {
  const [listing, setListing] = useState(null);
  const [path, setPath] = useState(start || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const dialog = useRef(null);
  // 나중에 보낸 요청의 답만 받는다 — 처음 여는 목록이 늦게 오면 그사이 이동한 폴더를 덮어쓴다.
  const latest = useRef(0);

  async function open(next) {
    const request = ++latest.current;
    setLoading(true);
    setError('');
    try {
      const result = await api(`directories${next ? `?${new URLSearchParams({ path: next })}` : ''}`);
      if (request !== latest.current) return;
      setListing(result);
      // 기다리는 사이 사용자가 경로 칸에 친 글자는 덮지 않는다.
      setPath(current => (current === (next || start || '') || current === '' ? result.path : current));
    } catch (e) {
      if (request === latest.current) setError(e.message);
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }
  useEffect(() => { open(start || ''); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 초점은 처음 열 때 한 번만 창에 준다. onClose는 부르는 쪽이 렌더마다 새로 만드는 함수라 의존성에 두면 이 효과가
  // 부모의 렌더마다 다시 돌아, 경로 칸에 치는 중에도 초점을 창으로 빼앗았다(MCP 탭은 5초마다 상태를 읽어 다시 그린다).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    dialog.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return <div className="admin-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="admin-modal" role="dialog" aria-modal="true" aria-label="폴더 선택" tabIndex={-1} ref={dialog}>
      <h3>폴더 선택</h3>
      <form className="admin-picker-path" onSubmit={e => { e.preventDefault(); open(path); }}>
        <input aria-label="폴더 경로" value={path} onChange={e => setPath(e.target.value)} spellCheck={false} />
        <button type="submit" className="admin-secondary" disabled={loading}>이동</button>
      </form>
      {error && <p role="alert" className="admin-error">{error}</p>}
      <div className="admin-picker-list" aria-busy={loading}>
        {listing?.parent && <button type="button" onClick={() => open(listing.parent)}>⬑ 상위 폴더</button>}
        {listing?.directories?.length === 0 && <p>하위 폴더가 없습니다.</p>}
        {listing?.directories?.map(d => <button type="button" key={d.path} onClick={() => open(d.path)}>📁 {d.name}</button>)}
      </div>
      <div className="admin-form-actions"><span />
        <div>
          <button type="button" className="admin-secondary" onClick={onClose}>취소</button>
          <button type="button" className="admin-primary" disabled={!listing || loading} onClick={() => onPick(listing.path)}>이 폴더 선택</button>
        </div>
      </div>
    </div>
  </div>;
}
