// MonthView — month grid built from parallel GET /api/agenda/week calls (not 30 day calls)
import React, { useEffect, useState } from 'react';
import { api, toDateStr, salonTodayStr, parseISO } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { DOW_IT, DOW_EN, mondayOf, fmtMoney, toastErr } from './lib.js';

export default function MonthView({ anchor, onOpenDay }) {
  const { t, lang, showRevenue, fireToast } = useDash();
  const [byDate, setByDate] = useState(null); // { 'YYYY-MM-DD': { count, revenue } } | null = loading

  const d0 = parseISO(anchor);
  const year = d0.getFullYear(), month = d0.getMonth();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthKey = `${year}-${month}`;

  useEffect(() => {
    let alive = true;
    setByDate(null);
    // mondays covering the visible month → 5-6 week calls in parallel
    const mondays = [];
    const cursor = mondayOf(first);
    const last = new Date(year, month, daysInMonth);
    while (cursor <= last) {
      mondays.push(toDateStr(cursor));
      cursor.setDate(cursor.getDate() + 7);
    }
    Promise.all(mondays.map((m) => api.get('/api/agenda/week', { params: { start: m } })))
      .then((weeks) => {
        if (!alive) return;
        const map = {};
        weeks.flat().forEach((day) => {
          map[day.date] = {
            count: day.count,
            revenue: (day.appointments || []).reduce((s, a) => s + Number(a.total_price || 0), 0),
          };
        });
        setByDate(map);
      })
      .catch((err) => { if (alive) { setByDate({}); toastErr(err, t, fireToast); } });
    return () => { alive = false; };
  }, [monthKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstDow = (first.getDay() + 6) % 7; // Mon = 0
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);

  const today = salonTodayStr();
  const load = (n) => (n === 0 ? 'var(--faint)' : n >= 6 ? 'var(--clay)' : n >= 3 ? 'var(--warn)' : 'var(--ok)');

  if (byDate === null) {
    return (
      <div className="scroll" style={{ flex: 1, overflow: 'auto', padding: '18px 26px 26px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
          {[...Array(7)].map((_, i) => <div key={'h' + i} className="skel" style={{ height: 16, borderRadius: 6 }} />)}
          {[...Array(35)].map((_, i) => <div key={i} className="skel" style={{ minHeight: 96, borderRadius: 14 }} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="scroll" style={{ flex: 1, overflow: 'auto', padding: '18px 26px 26px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
        {DOW_IT.map((it, i) => (
          <div key={i} style={{ textAlign: 'center', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--muted-2)', textTransform: 'uppercase', paddingBottom: 4 }}>{t(it, DOW_EN[i])}</div>
        ))}
        {cells.map((d, i) => {
          const iso = d ? toDateStr(new Date(year, month, d)) : null;
          const info = (iso && byDate[iso]) || { count: 0, revenue: 0 };
          const n = info.count;
          const isToday = iso === today;
          return (
            <button
              key={i} disabled={!d}
              onClick={() => { if (iso) onOpenDay(iso); }}
              style={{ minHeight: 96, borderRadius: 14, border: '1px solid ' + (isToday ? 'var(--ink)' : 'var(--hair)'), background: d ? (isToday ? 'var(--ink)' : 'var(--surface)') : 'transparent', padding: '9px 11px', textAlign: 'left', cursor: d ? 'pointer' : 'default', display: 'flex', flexDirection: 'column', boxShadow: isToday ? 'var(--sh-sm)' : 'none' }}
            >
              {d && (
                <React.Fragment>
                  <span className="t-num" style={{ fontSize: 15, color: isToday ? '#fff' : 'var(--ink)' }}>{d}</span>
                  {n > 0 ? (
                    <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: 99, background: isToday ? '#fff' : load(n), flexShrink: 0 }} />
                        <span style={{ fontSize: 12, fontWeight: 700, color: isToday ? '#fff' : 'var(--ink-2)' }}>{n} {t('appunt.', 'appts')}</span>
                      </div>
                      {showRevenue && <span className="t-sm" style={{ fontSize: 11, color: isToday ? 'rgba(255,255,255,0.7)' : 'var(--muted-2)' }}>{fmtMoney(info.revenue, lang)}</span>}
                    </div>
                  ) : (
                    <span style={{ marginTop: 'auto', fontSize: 10.5, fontWeight: 600, color: isToday ? 'rgba(255,255,255,0.6)' : 'var(--faint)' }}>{t('Libero', 'Free')}</span>
                  )}
                </React.Fragment>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
