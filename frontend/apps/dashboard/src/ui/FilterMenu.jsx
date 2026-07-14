import React, { useState } from 'react';
import { Icon } from '@youty/shared';

/** Single-dimension filter dropdown. options = [[key, label], ...] — first entry is "all". */
export default function FilterMenu({ options, active, onChange, title }) {
  const [open, setOpen] = useState(false);
  const allKey = options[0][0];
  const activeNotAll = active !== allKey;
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button className="dk-iconbtn" onClick={() => setOpen((o) => !o)} style={{ background: activeNotAll || open ? 'var(--ink)' : 'var(--surface)', borderColor: activeNotAll || open ? 'var(--ink)' : 'var(--hair)', position: 'relative' }}>
        <Icon name="filter" size={18} color={activeNotAll || open ? '#fff' : 'var(--ink)'} />
        {activeNotAll && <span style={{ position: 'absolute', top: -4, right: -4, width: 16, height: 16, borderRadius: 99, background: 'var(--clay)', border: '2px solid var(--paper)' }} />}
      </button>
      {open && (
        <React.Fragment>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 220, padding: 8, boxShadow: 'var(--sh-pop)', zIndex: 61, maxHeight: 360, overflowY: 'auto' }}>
            <div className="t-meta" style={{ padding: '6px 10px 8px' }}>{title}</div>
            {options.map(([k, l]) => {
              const on = active === k;
              return (
                <button key={k} className="dk-row" onClick={() => { onChange(k); setOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, textAlign: 'left' }}>
                  <span style={{ flex: 1, fontWeight: on ? 700 : 600, fontSize: 13.5, color: on ? 'var(--ink)' : 'var(--ink-2)' }}>{l}</span>
                  {on && <Icon name="check" size={15} color="var(--clay-ink)" stroke={2.4} />}
                </button>
              );
            })}
          </div>
        </React.Fragment>
      )}
    </div>
  );
}
