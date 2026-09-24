// JumpPopover — il selettore di mese e data sotto il titolo della barra:
// l'anno, i dodici mesi e «Vai a una data». Senza hook: i test lo aprono
// chiamandolo come una funzione.
import React from 'react';
import { Icon } from '@youty/shared';
import { plausibleDate } from '../lib.js';

/* ---- month/date jump popover ---- */
export default function JumpPopover({ t, MONTHS, curM, curY, onClose, onMonth, onDate }) {
  return (
    <React.Fragment>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
      <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 41, padding: 12, width: 260, boxShadow: 'var(--sh-pop)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <button className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} onClick={() => onMonth(curM, curY - 1)}><Icon name="chevL" size={14} /></button>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{curY}</span>
          <button className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} onClick={() => onMonth(curM, curY + 1)}><Icon name="chevR" size={14} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginBottom: 12 }}>
          {MONTHS.map((mo, mi) => {
            const on = mi === curM;
            return (
              <button key={mi} onClick={() => onMonth(mi, curY)} style={{ padding: '8px 4px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{mo.slice(0, 3)}</button>
            );
          })}
        </div>
        <div style={{ borderTop: '1px solid var(--hair)', paddingTop: 10 }}>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Vai a una data', 'Jump to a date')}</div>
          {/* Si salta solo con una data piena: scrivendo l'anno a tastiera il
              primo tasto dava «0002» e l'agenda finiva nel 1902. */}
          <input type="date" onChange={(e) => { if (plausibleDate(e.target.value)) onDate(e.target.value); }} style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13.5, padding: '8px 10px', fontFamily: 'var(--sans)', background: 'var(--surface)', boxSizing: 'border-box' }} />
        </div>
      </div>
    </React.Fragment>
  );
}
