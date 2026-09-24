// MarginSection — il margine stimato della visita, dietro un piccolo
// interruttore: ricavo, costi (prodotti, fornitori, lavoro) e margine.
import { Icon } from '@youty/shared';
import { fmtMoney } from '../../lib.js';

export default function MarginSection({ showMargin, setShowMargin, margin, t, lang }) {
  return (
    <div>
      <button onClick={() => setShowMargin((v) => !v)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', background: 'transparent', border: 'none', fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', padding: 0 }}>
        <Icon name="insights" size={14} color="var(--muted)" />{showMargin ? t('Nascondi margine', 'Hide margin') : t('Mostra margine', 'Show margin')}
        <Icon name="chevD" size={12} color="var(--muted)" style={{ transform: showMargin ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} />
      </button>
      {showMargin && (
        !margin ? <div className="skel" style={{ height: 96, borderRadius: 12, marginTop: 8 }} /> : (
          <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '11px 14px', marginTop: 8 }}>
            {/* fmtMoney e non fmtEur: un costo nullo è «€0,00», non
                «− Gratis» (e un ricavo nullo non è un omaggio) */}
            {[[t('Ricavo', 'Revenue'), margin.revenue, false], [t('Costo prodotti', 'Product cost'), margin.product_cost, true], [t('Costo fornitori', 'Supplier cost'), margin.supplier_cost, true], [t('Costo lavoro', 'Labour cost'), margin.labor_cost, true]].map(([l, v, neg], i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                <span className="t-sm" style={{ color: 'var(--muted)' }}>{l}</span>
                <span className="tabnum" style={{ fontSize: 12.5 }}>{neg && Number(v) ? '− ' : ''}{fmtMoney(v, lang)}</span>
              </div>
            ))}
            <div className="hr" style={{ margin: '6px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontWeight: 700, fontSize: 13.5 }}>{t('Margine stimato', 'Estimated margin')}</span>
              <span className="t-num" style={{ fontWeight: 800, fontSize: 16, color: Number(margin.margin) >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtMoney(margin.margin, lang)} · {margin.margin_pct}%</span>
            </div>
          </div>
        )
      )}
    </div>
  );
}
