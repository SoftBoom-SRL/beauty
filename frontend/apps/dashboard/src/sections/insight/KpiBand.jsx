// KpiBand.jsx — customizable 4-of-N favourites band + "Personalizza" picker,
// ported from the BAND 1 block + cfgOpen popover in desktop-insight.jsx.
import React, { useState } from 'react';
import { Icon, Delta, Sparkline } from '@youty/shared';
import { KPI_ORDER } from './kpiDefs.js';

export default function KpiBand({ allKpis, favs, onToggleFav, t }) {
  const [cfgOpen, setCfgOpen] = useState(false);
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12, position: 'relative' }}>
        <button className="dk-btn dk-btn--ghost" onClick={() => setCfgOpen((o) => !o)}>
          <Icon name="settings" size={16} />{t('Personalizza', 'Customize')}
        </button>
        {cfgOpen && (
          <React.Fragment>
            <div onClick={() => setCfgOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
            <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 31, padding: 10, width: 260, boxShadow: 'var(--sh-pop)', maxHeight: 380, overflowY: 'auto' }}>
              <div className="t-meta" style={{ padding: '2px 6px 8px' }}>{t('Scegli fino a 4 KPI', 'Pick up to 4 KPIs')}</div>
              {KPI_ORDER.filter((k) => allKpis[k]).map((k) => {
                const on = favs.includes(k);
                return (
                  <button key={k} className="dk-row" onClick={() => onToggleFav(k)} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 8px', borderRadius: 8, textAlign: 'left' }}>
                    <span style={{ width: 17, height: 17, borderRadius: 5, border: '1.6px solid ' + (on ? 'var(--clay)' : 'var(--faint)'), background: on ? 'var(--clay)' : 'transparent', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                      {on && <Icon name="check" size={11} color="#fff" stroke={2.6} />}
                    </span>
                    <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{allKpis[k].label}</span>
                  </button>
                );
              })}
            </div>
          </React.Fragment>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16 }}>
        {favs.map((k) => {
          const m = allKpis[k];
          if (!m) return null;
          return (
            <div key={k} className="dk-card" style={{ padding: 0, overflow: 'hidden', display: 'flex' }}>
              <span style={{ width: 4, flexShrink: 0, background: 'var(--clay)' }} />
              <div style={{ flex: 1, padding: '18px 20px', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8 }}>
                  <span className="t-meta" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
                  {m.delta != null && <Delta value={m.delta} invert={m.invert} />}
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
                  <div className="t-num" style={{ fontSize: 26, lineHeight: 1 }}>{m.value}</div>
                  {m.spark && <Sparkline data={m.spark} w={70} h={32} />}
                </div>
                {m.sub ? <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 8 }}>{m.sub}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
