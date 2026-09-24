// cart/SaleDiscount.jsx — lo sconto su tutta la vendita del banco (CartTab):
// le scelte rapide 10/15/20% o un numero a mano. Vale per le righe prodotto
// che non hanno uno sconto proprio (counterDiscountPct).
import { NumInput } from '@youty/shared';

export default function SaleDiscount({ value, onChange, t }) {
  return (
    <>
      <div className="t-meta" style={{ margin: '18px 0 8px' }}>{t('Sconto sulla vendita', 'Sale discount')}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {[0, 10, 15, 20].map((p) => {
          const on = value === p;
          return (
            <button key={p} onClick={() => onChange(p)} style={{ flex: 1, padding: '9px 0', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>
              {p === 0 ? t('No', 'No') : p + '%'}
            </button>
          );
        })}
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, border: '1px solid ' + (value && ![10, 15, 20].includes(value) ? 'var(--clay)' : 'var(--hair)'), borderRadius: 9, padding: '0 9px', height: 36, background: 'var(--surface)' }}>
          <NumInput integer min={0} max={100} value={value}
            onChange={onChange}
            style={{ width: 34, textAlign: 'right', border: 'none', outline: 'none', background: 'transparent', fontSize: 13.5, fontWeight: 700, fontFamily: 'ui-monospace, monospace' }} />
          <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>%</span>
        </div>
      </div>
    </>
  );
}
