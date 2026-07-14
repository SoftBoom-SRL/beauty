import React, { useState } from 'react';
import { Icon } from '@youty/shared';

/** Multi-dimension filter dropdown.
 *  groups = [{ label, value, set, opts: [[key, label], ...] }, ...] — value 'all' = inactive. */
export default function GroupedFilterMenu({ groups, t }) {
  const [open, setOpen] = useState(false);
  const activeCount = groups.filter((g) => g.value !== 'all').length;
  const clearAll = () => groups.forEach((g) => g.set('all'));
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button className="dk-iconbtn" onClick={() => setOpen((o) => !o)} style={{ background: activeCount || open ? 'var(--ink)' : 'var(--surface)', borderColor: activeCount || open ? 'var(--ink)' : 'var(--hair)', position: 'relative' }}>
        <Icon name="filter" size={18} color={activeCount || open ? '#fff' : 'var(--ink)'} />
        {activeCount > 0 && <span style={{ position: 'absolute', top: -5, right: -5, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 99, background: 'var(--clay)', border: '2px solid var(--paper)', fontSize: 10, fontWeight: 800, color: '#fff', display: 'grid', placeItems: 'center' }}>{activeCount}</span>}
      </button>
      {open && (
        <React.Fragment>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 252, padding: 8, boxShadow: 'var(--sh-pop)', zIndex: 61, maxHeight: 460, overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 10px 2px' }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{t ? t('Filtri', 'Filters') : 'Filtri'}</span>
              {activeCount > 0 && <button onClick={clearAll} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--clay-ink)' }}>{t ? t('Azzera', 'Clear') : 'Azzera'}</button>}
            </div>
            {groups.map((g, gi) => (
              <React.Fragment key={gi}>
                {gi > 0 && <div style={{ height: 1, background: 'var(--hair)', margin: '5px 0' }} />}
                <div style={{ marginBottom: 2 }}>
                  <div className="t-meta" style={{ padding: '8px 10px 5px' }}>{g.label}</div>
                  {g.opts.map(([k, l]) => {
                    const on = g.value === k;
                    return (
                      <button key={k} className="dk-row" onClick={() => g.set(k)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 9, textAlign: 'left' }}>
                        <span style={{ flex: 1, fontWeight: on ? 700 : 600, fontSize: 13.5, color: on ? 'var(--ink)' : 'var(--ink-2)' }}>{l}</span>
                        {on && <Icon name="check" size={15} color="var(--clay-ink)" stroke={2.4} />}
                      </button>
                    );
                  })}
                </div>
              </React.Fragment>
            ))}
          </div>
        </React.Fragment>
      )}
    </div>
  );
}
