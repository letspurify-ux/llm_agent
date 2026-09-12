import { importBindings, returnBindName, sqlBindNames } from './admin-bindings.js';

export default function BindConfigEditor({ value, onChange, sql, queryType, id, invalid }) {
  const returning = returnBindName(sql, queryType).toLowerCase();
  const sqlNames = sqlBindNames(sql).map(name => name.toLowerCase());
  const update = (index, patch) => onChange({ error: '', rows: value.rows.map((row, i) => i === index ? { ...row, ...patch } : row) });
  return <div id={id} className="admin-bindings" role="group" aria-labelledby={`${id}-label`} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-error` : `${id}-help`}>
    <p id={`${id}-help`} className="admin-bind-help">SQL에서 이름을 불러온 뒤 입력·출력 방향과 자료형을 선택하세요.</p>
    {value.error ? <div className="admin-bind-recovery"><p role="alert">{value.error}</p><button type="button" className="admin-secondary" onClick={() => onChange(importBindings({ rows: [] }, sql, queryType))}>설정 다시 만들기</button></div> : <>
      <div className="admin-bind-actions">
        <button type="button" className="admin-secondary" disabled={!sqlNames.length} onClick={() => onChange(importBindings(value, sql, queryType))}>SQL에서 불러오기</button>
        <button type="button" className="admin-secondary" onClick={() => onChange({ error: '', rows: [...value.rows, { name: '', dir: 'IN', type: 'STRING', maxSize: '' }] })}>+ 바인드 추가</button>
      </div>
      {!value.rows.length && <p className="admin-bind-empty">아직 설정한 바인드가 없습니다.</p>}
      {value.rows.map((row, index) => {
        const name = row.name.trim().toLowerCase();
        const isReturn = !!returning && name === returning;
        const dir = isReturn || row.type === 'CURSOR' ? 'OUT' : row.dir;
        const prefix = `${id}-${index}`;
        const missing = !!name && !sqlNames.includes(name);
        return <div className="admin-bind-row" key={index}>
          <div className="admin-bind-row-heading"><span>바인드 {index + 1}{isReturn && <em>함수 반환값</em>}</span><button type="button" className="admin-bind-remove" aria-label={`${index + 1}번 바인드 삭제`} onClick={() => onChange({ error: '', rows: value.rows.filter((_, i) => i !== index) })}>삭제</button></div>
          <label htmlFor={`${prefix}-name`}>이름<input id={`${prefix}-name`} value={row.name} maxLength={128} placeholder="예: customer_id (: 제외)" spellCheck={false} onChange={e => update(index, { name: e.target.value })} /></label>
          {missing && <small className="admin-bind-warning">SQL에 없는 이름입니다. 이름을 수정하거나 삭제하세요.</small>}
          <div className="admin-bind-options">
            <label htmlFor={`${prefix}-dir`}>방향<select id={`${prefix}-dir`} value={dir} disabled={isReturn || row.type === 'CURSOR'} onChange={e => update(index, { dir: e.target.value })}><option value="IN">입력 (IN)</option><option value="OUT">출력 (OUT)</option><option value="INOUT">입력·출력 (INOUT)</option></select></label>
            <label htmlFor={`${prefix}-type`}>자료형<select id={`${prefix}-type`} value={row.type} onChange={e => update(index, { type: e.target.value, ...(e.target.value === 'CURSOR' && { dir: 'OUT' }) })}><option value="STRING">문자열 (STRING)</option><option value="NUMBER">숫자 (NUMBER)</option><option value="CURSOR">조회 결과 (CURSOR)</option></select></label>
          </div>
          {row.type === 'STRING' && dir !== 'IN' && <label htmlFor={`${prefix}-size`}>최대 출력 크기 (바이트)<input id={`${prefix}-size`} type="number" min="1" max="32767" step="1" placeholder="기본값 32767" value={row.maxSize} onChange={e => update(index, { maxSize: e.target.value })} /></label>}
        </div>;
      })}
    </>}
    <small>함수 반환값과 커서는 OUT으로 설정됩니다. 출력은 스칼라 여러 개 또는 커서 1개를 지원합니다.</small>
  </div>;
}
