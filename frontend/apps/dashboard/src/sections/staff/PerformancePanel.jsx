// PerformancePanel.jsx — linguetta «Performance» della scheda operatrice
// (StaffPage): incasso, vendite e clienti del mese, andamento su 6 mesi.
import { Icon } from '@youty/shared';
import { HIDDEN, eur, monthShort, perfStats } from './lib.js';

/* ================= Performance (hand-rolled bar chart, port of prototype) ================= */
export default function PerformancePanel({ perf, clients, color, hourlyCost, rev, t, lang }) {
  const { hidden, max, last, delta, avg } = perfStats(perf);
  const chartH = 150;
  const salesThisMonth = perf[perf.length - 1] ? perf[perf.length - 1].sales_count : 0;

  const metrics = [
    { label: t('Incasso mese', 'Month revenue'), value: rev(hidden ? null : last) },
    { label: t('Vendite (mese)', 'Sales (month)'), value: salesThisMonth },
    { label: t('Clienti serviti', 'Clients served'), value: clients ? clients.length : '—' },
    { label: t('Costo orario', 'Hourly cost'), value: hourlyCost == null ? HIDDEN : eur(hourlyCost, lang) },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div className="t-meta" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="insights" size={14} color="var(--muted)" />{t('Performance del mese', 'This month’s performance')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {metrics.map((m, i) => (
            <div key={i} className="dk-card" style={{ padding: 14, boxShadow: 'none', border: '1px solid var(--hair)' }}>
              <div className="t-meta" style={{ fontSize: 9.5, marginBottom: 5 }}>{m.label}</div>
              <div className="t-num" style={{ fontSize: 19 }}>{m.value}</div>
            </div>
          ))}
        </div>
      </div>

      {hidden ? (
        /* Il fatturato mese per mese di un'operatrice è un dato di cassa: senza
         * il permesso vendite il server non lo manda (C6). Un grafico a zero
         * sarebbe un dato falso, non un dato nascosto. */
        <div className="dk-card" style={{ padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="lock" size={16} color="var(--muted)" />
          <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600 }}>
            {t('Gli incassi per operatrice sono visibili solo al titolare e a chi ha il permesso «Vendite».', 'Per-stylist revenue is visible only to the owner and to whoever holds the “Sales” permission.')}
          </span>
        </div>
      ) : (
      <div className="dk-card" style={{ padding: '18px 20px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <div className="t-meta" style={{ marginBottom: 4 }}>{t('Andamento incassi · 6 mesi', 'Revenue trend · 6 months')}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span className="t-num" style={{ fontSize: 24, fontWeight: 800 }}>{rev(last)}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: delta >= 0 ? 'var(--ok)' : 'var(--danger)', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <Icon name={delta >= 0 ? 'arrowUp' : 'arrowDn'} size={13} color={delta >= 0 ? 'var(--ok)' : 'var(--danger)'} />{Math.abs(delta)}%
              </span>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="t-meta" style={{ marginBottom: 4 }}>{t('Media', 'Average')}</div>
            <span className="t-num" style={{ fontSize: 15, fontWeight: 700, color: 'var(--muted)' }}>{rev(avg)}</span>
          </div>
        </div>
        <div style={{ position: 'relative', height: chartH }}>
          {[0, 0.5, 1].map((g) => (
            <div key={g} style={{ position: 'absolute', left: 0, right: 0, bottom: g * (chartH - 22) + 22, height: 1, background: 'var(--hair)', opacity: g === 0 ? 1 : 0.5 }} />
          ))}
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: (avg / max) * (chartH - 22) + 22, height: 1, borderTop: '1px dashed var(--clay)', opacity: 0.6 }} />
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 14 }}>
            {perf.map((p, i) => {
              const v = Number(p.revenue);
              const isLast = i === perf.length - 1;
              return (
                <div key={p.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, height: '100%', justifyContent: 'flex-end' }}>
                  <span className="t-sm" style={{ fontSize: 10.5, fontWeight: 700, color: isLast ? color : 'var(--muted-2)' }}>{rev(v)}</span>
                  <div style={{ width: '100%', maxWidth: 38, height: Math.max(2, (v / max) * (chartH - 22)) + 'px', borderRadius: '7px 7px 0 0', background: isLast ? color : 'color-mix(in srgb, ' + color + ' 30%, var(--paper-2))', transition: 'height 400ms var(--ease)' }} />
                  <span className="t-sm" style={{ fontSize: 10.5, fontWeight: isLast ? 700 : 500, color: isLast ? 'var(--ink)' : 'var(--muted-2)' }}>{monthShort(p.month, lang)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
