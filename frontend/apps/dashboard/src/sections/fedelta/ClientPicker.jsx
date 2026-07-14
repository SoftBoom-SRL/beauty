import React, { useEffect, useState } from 'react';
import { api, Icon } from '@youty/shared';

/** Optional client search-picker: `client` is null or `{id, full_name}`.
 * Used by CouponEditModal (client_id) and GiftCardModal (buyer/recipient client_id).
 * Debounced search against GET /api/clients/?q=. */
export default function ClientPicker({ client, onChange, placeholder, t }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !q.trim()) { setResults([]); return; }
    let alive = true;
    setLoading(true);
    const tm = setTimeout(() => {
      api.get('/api/clients/', { params: { q, limit: 8 } })
        .then((res) => { if (alive) setResults(res.items || []); })
        .catch(() => { if (alive) setResults([]); })
        .finally(() => { if (alive) setLoading(false); });
    }, 250);
    return () => { alive = false; clearTimeout(tm); };
  }, [q, open]);

  if (client) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 12px', height: 42, background: 'var(--surface)' }}>
        <Icon name="user" size={15} color="var(--muted-2)" />
        <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{client.full_name}</span>
        <button onClick={() => onChange(null)} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <div className="dk-search" style={{ width: '100%' }}>
        <Icon name="search" size={16} color="var(--muted-2)" />
        <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder={placeholder} />
        {q && <button onClick={() => { setQ(''); setOpen(false); }} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>}
      </div>
      {open && q.trim() && (
        <React.Fragment>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, padding: 6, zIndex: 61, maxHeight: 260, overflowY: 'auto', boxShadow: 'var(--sh-pop)' }}>
            {loading ? (
              <div className="t-sm" style={{ padding: 10, color: 'var(--muted)' }}>{t('Ricerca…', 'Searching…')}</div>
            ) : results.length ? results.map((c) => (
              <button key={c.id} className="dk-row" onClick={() => { onChange(c); setOpen(false); setQ(''); }}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', padding: '8px 10px', borderRadius: 9, textAlign: 'left' }}>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{c.full_name}</span>
                <span className="t-sm" style={{ color: 'var(--muted)' }}>{c.phone}</span>
              </button>
            )) : <div className="t-sm" style={{ padding: 10, color: 'var(--muted)' }}>{t('Nessun risultato', 'No results')}</div>}
          </div>
        </React.Fragment>
      )}
    </div>
  );
}
