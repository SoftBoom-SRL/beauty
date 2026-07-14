// Punto Vendita (POS) — Prodotti (counter-sale cart) + Storico (sales history).
// Sub-tab ids match the shell's SECTION_SUBTABS for `pos`: 'products' | 'history'.
import React from 'react';
import { Icon } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import CartTab from './CartTab.jsx';
import HistoryTab from './HistoryTab.jsx';

export default function PosSection() {
  const { t, subTab, setSubTab } = useDash();
  const tab = subTab || 'products';

  return (
    <div className="dk-page" style={{ maxWidth: 1240 }}>
      <div style={{ borderBottom: '1px solid var(--hair)', display: 'flex', gap: 4, marginBottom: 18 }}>
        {[
          ['products', t('Prodotti', 'Products'), 'box'],
          ['history', t('Storico', 'History'), 'clock'],
        ].map(([k, l, ic]) => {
          const on = tab === k;
          return (
            <button key={k} onClick={() => setSubTab(k)}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 4px', marginRight: 18, marginBottom: -1, background: 'transparent', border: 'none', borderBottom: '2px solid ' + (on ? 'var(--clay)' : 'transparent'), color: on ? 'var(--ink)' : 'var(--muted)', fontWeight: on ? 700 : 600, fontSize: 14.5, cursor: 'pointer' }}>
              <Icon name={ic} size={17} color={on ? 'var(--clay-ink)' : 'var(--muted)'} />{l}
            </button>
          );
        })}
      </div>
      {tab === 'history'
        ? <HistoryTab />
        : <CartTab onGoHistory={() => setSubTab('history')} />}
    </div>
  );
}
