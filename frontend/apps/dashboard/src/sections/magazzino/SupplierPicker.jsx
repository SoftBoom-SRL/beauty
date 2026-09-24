// SupplierPicker.jsx — il fornitore del prodotto, nella scheda prodotto
// (ProductDrawer).
import { useCallback, useRef, useState } from 'react';
import { Icon } from '@youty/shared';
import { useClickAway } from '../../hooks/useClickAway.js';

/* Searchable predictive supplier picker over the in-memory `suppliers` list.
 * Matches the platform's client search (dk-search input + results dropdown).
 * Filters client-side by name; click to select; selected shows a change/clear affordance. */
export default function SupplierPicker({ suppliers, value, onChange, canWrite, t }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const selected = suppliers.find((s) => s.id === value) || null;

  // Esc con la tendina aperta chiude la tendina e basta: preventDefault()
  // dice alla pila dei livelli (ui/layers.js) di non chiudere la scheda.
  const close = useCallback(() => setOpen(false), []);
  useClickAway(boxRef, open, close, { escape: true });

  if (selected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 12, background: 'var(--surface-2)', opacity: canWrite ? 1 : 0.7 }}>
        <span style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--surface)', border: '1px solid var(--hair)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="box" size={15} color="var(--muted)" /></span>
        <span style={{ flex: 1, fontWeight: 700, fontSize: 14, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.name}</span>
        {canWrite && <button className="dk-iconbtn" style={{ width: 30, height: 30 }} onClick={() => { onChange(null); setQuery(''); setOpen(true); }} title={t('Cambia fornitore', 'Change supplier')}><Icon name="x" size={15} /></button>}
      </div>
    );
  }

  const ql = query.trim().toLowerCase();
  const matches = ql ? suppliers.filter((s) => (s.name || '').toLowerCase().includes(ql)) : suppliers;

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <div className="dk-search" style={{ width: '100%', height: 42 }}>
        <Icon name="search" size={16} color="var(--muted-2)" />
        <input value={query} disabled={!canWrite} onChange={(e) => { setQuery(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
          placeholder={t('Cerca fornitore…', 'Search supplier…')} />
        <button onClick={() => canWrite && setOpen((v) => !v)} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="chevD" size={15} color="var(--muted-2)" /></button>
      </div>
      {open && canWrite && (
        <div className="dk-card scroll" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20, padding: 6, boxShadow: 'var(--sh-pop)', maxHeight: 220, overflowY: 'auto' }}>
          {matches.map((s) => (
            <button key={s.id} className="dk-row" onClick={() => { onChange(s.id); setOpen(false); setQuery(''); }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 9, textAlign: 'left', cursor: 'pointer' }}>
              <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
            </button>
          ))}
          {!matches.length && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: 12, textAlign: 'center' }}>{t('Nessun fornitore', 'No supplier found')}</div>}
        </div>
      )}
    </div>
  );
}
