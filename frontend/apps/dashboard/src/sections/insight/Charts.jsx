// Charts.jsx — hand-rolled chart primitives ported from desktop-insight.jsx
// (BarTrend, by-category ProgressBar rows, occupancy-by-weekday bars, new-vs-returning
// split, clients-by-category breakdown). No chart library — plain divs/SVG, same as the
// prototype.
import React from 'react';
import { ProgressBar, fmtEur } from '@youty/shared';

export const CATEGORY_PALETTE = [
  'var(--clay)', 'var(--op-mara)', 'var(--op-lina)', 'var(--op-asia)',
  'var(--op-giulia)', 'var(--info)', 'var(--ok)', 'var(--warn)',
];

function shortLabel(dateStr, granularity, lang) {
  const d = new Date(dateStr + 'T00:00:00');
  if (granularity === 'month') return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', { month: 'short' });
  if (granularity === 'week') return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', { day: 'numeric', month: 'numeric' });
  return String(d.getDate());
}

/** Revenue trend bars — one bar per point in `points` ({date, revenue}). Ports
 * BarTrend() from the prototype; labels thin out when there are many points. */
export function BarTrend({ points, granularity, lang, t }) {
  if (!points || !points.length) {
    return <div className="t-sm" style={{ color: 'var(--muted-2)', textAlign: 'center', padding: '30px 0' }}>{t('Nessun dato nel periodo', 'No data in this period')}</div>;
  }
  const vals = points.map((p) => Number(p.revenue));
  const max = Math.max(1, ...vals);
  const labelEvery = Math.max(1, Math.ceil(points.length / 10));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: points.length > 20 ? 3 : 8, height: 150 }}>
      {points.map((p, i) => {
        const v = Number(p.revenue);
        const isLast = i === points.length - 1;
        const showLabel = isLast || i % labelEvery === 0;
        return (
          <div key={p.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, height: '100%', justifyContent: 'flex-end' }}>
            <div style={{
              width: '100%', maxWidth: 40, height: (v / max) * 100 + '%', minHeight: v > 0 ? 3 : 0,
              borderRadius: '7px 7px 0 0', background: isLast ? 'var(--clay)' : 'var(--paper-2)',
              transition: 'height 700ms var(--ease-emph)', position: 'relative',
            }}>
              {isLast && v > 0 && (
                <span className="t-num" style={{ position: 'absolute', top: -22, left: '50%', transform: 'translateX(-50%)', fontSize: 12, color: 'var(--clay-ink)', whiteSpace: 'nowrap' }}>
                  {fmtEur(v, lang)}
                </span>
              )}
            </div>
            <span className="t-sm" style={{ fontSize: 10, color: 'var(--muted-2)', visibility: showLabel ? 'visible' : 'hidden' }}>
              {shortLabel(p.date, granularity, lang)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Revenue-by-category ProgressBar rows — ports the "Per categoria" card. */
export function CategoryBars({ rows, lang }) {
  if (!rows || !rows.length) return null;
  const vals = rows.map((r) => Number(r.revenue));
  const max = Math.max(1, ...vals);
  return (
    <div>
      {rows.map((r, i) => (
        <div key={r.category} style={{ marginTop: i ? 13 : 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
            <span style={{ fontWeight: 600, fontSize: 13.5 }}>{r.category}</span>
            <span className="t-num" style={{ fontSize: 14 }}>{fmtEur(Number(r.revenue), lang)}</span>
          </div>
          <ProgressBar value={(Number(r.revenue) / max) * 100} color={CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]} />
        </div>
      ))}
    </div>
  );
}

/** Occupancy-by-weekday bars — ports the min/max highlighted bar chart. */
export function OccupancyByWeekday({ rows, lang, t }) {
  if (!rows || !rows.length) return null;
  const WEEKDAY_LABEL = [
    { it: 'Lun', en: 'Mon' }, { it: 'Mar', en: 'Tue' }, { it: 'Mer', en: 'Wed' },
    { it: 'Gio', en: 'Thu' }, { it: 'Ven', en: 'Fri' }, { it: 'Sab', en: 'Sat' }, { it: 'Dom', en: 'Sun' },
  ];
  const vals = rows.map((r) => r.occupancy_pct);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const quietest = rows.reduce((a, r) => (r.occupancy_pct < a.occupancy_pct ? r : a), rows[0]);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, height: 140 }}>
        {rows.map((r) => {
          const v = r.occupancy_pct;
          const barCol = v === lo && hi > 0 ? '#F4A6A6' : v >= hi - 5 && hi > 0 ? '#BCE3C0' : '#CBCED8';
          const numCol = v === lo && hi > 0 ? '#C0524F' : v >= hi - 5 && hi > 0 ? '#3F8A50' : 'var(--muted-2)';
          return (
            <div key={r.weekday} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, height: '100%', justifyContent: 'flex-end' }}>
              <span className="t-sm" style={{ fontSize: 10.5, fontWeight: 700, color: numCol }}>{Math.round(v)}</span>
              <div style={{ width: '64%', maxWidth: 26, height: Math.max(v, 2) + '%', minHeight: 5, borderRadius: 6, background: barCol, transition: 'height 600ms var(--ease-emph)' }} />
              <span className="t-sm" style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>{t(WEEKDAY_LABEL[r.weekday].it, WEEKDAY_LABEL[r.weekday].en)}</span>
            </div>
          );
        })}
      </div>
      {hi > 0 && (
        <div className="t-sm" style={{ color: 'var(--muted-2)', textAlign: 'center', marginTop: 12 }}>
          {t(WEEKDAY_LABEL[quietest.weekday].it, WEEKDAY_LABEL[quietest.weekday].en) + ' ' + t('è il giorno più scarico', 'is the quietest day')}
        </div>
      )}
    </div>
  );
}

/** New vs returning split — from kpis.new_clients / kpis.returning_clients. */
export function NewVsReturning({ cur, t }) {
  const nw = cur?.new_clients || 0;
  const rt = cur?.returning_clients || 0;
  const tot = nw + rt || 1;
  return (
    <React.Fragment>
      <div style={{ display: 'flex', height: 16, borderRadius: 99, overflow: 'hidden', marginBottom: 12 }}>
        <div style={{ width: (rt / tot * 100) + '%', background: 'var(--clay)' }} />
        <div style={{ width: (nw / tot * 100) + '%', background: 'var(--op-asia)' }} />
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: 99, background: 'var(--clay)' }} />
            <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Di ritorno', 'Returning')}</span>
          </div>
          <div className="t-num" style={{ fontSize: 20, marginTop: 3 }}>{rt} <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{Math.round(rt / tot * 100)}%</span></div>
        </div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: 99, background: 'var(--op-asia)' }} />
            <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Nuovi', 'New')}</span>
          </div>
          <div className="t-num" style={{ fontSize: 20, marginTop: 3 }}>{nw} <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{Math.round(nw / tot * 100)}%</span></div>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Frequenza media', 'Avg frequency')}</div>
          <div className="t-num" style={{ fontSize: 20, marginTop: 3 }}>{Number(cur?.avg_frequency || 0).toFixed(1)} {t('visite', 'visits')}</div>
        </div>
      </div>
    </React.Fragment>
  );
}

/** Clients-by-category breakdown — from kpis.clients_by_category, coloured by
 * matching the real clientCategories (ctx) when possible. */
export function ClientsByCategory({ rows, clientCategories, lang, t }) {
  if (!rows || !rows.length) return null;
  const withColor = rows.map((r, i) => {
    const match = clientCategories.find((c) => c.name === r.category);
    return { ...r, color: match?.color || CATEGORY_PALETTE[i % CATEGORY_PALETTE.length] };
  });
  const tot = withColor.reduce((a, x) => a + x.count, 0) || 1;
  const nonZero = withColor.filter((x) => x.count > 0);
  if (!nonZero.length) {
    return <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessun cliente categorizzato', 'No categorized clients yet')}</div>;
  }
  return (
    <React.Fragment>
      <div style={{ display: 'flex', height: 16, borderRadius: 99, overflow: 'hidden', marginBottom: 14 }}>
        {withColor.map((x) => x.count > 0 && <div key={x.category} title={x.category} style={{ width: (x.count / tot * 100) + '%', background: x.color }} />)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 18px' }}>
        {withColor.map((x) => (
          <div key={x.category} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: 99, background: x.color, flexShrink: 0 }} />
            <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5, color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.category}</span>
            <span className="t-num" style={{ fontSize: 14 }}>{x.count}</span>
            <span className="t-sm" style={{ color: 'var(--muted-2)', minWidth: 34, textAlign: 'right' }}>{Math.round(x.count / tot * 100)}%</span>
          </div>
        ))}
      </div>
    </React.Fragment>
  );
}
