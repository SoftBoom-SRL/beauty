// WeekDayHeader — la testata di un giorno in vista settimana: giorno e data
// (il clic apre il giorno), appuntamenti e incasso, i pallini degli stati e
// le testate delle sotto-colonne delle operatrici, con la stessa tinta dei
// blocchi. Senza hook: nei test fa parte di WeekView.
import { parseISO, statusMeta } from '@youty/shared';
import { DOW_EN, DOW_IT, WEEK_DAY_BORDER, WEEK_TODAY_BG, apptRevenue, fmtMoney, opDisplay } from '../lib.js';

/** `day` = il giorno di weekDays (lib/week.js), `index` = 0 lunedì … 6
 *  domenica; `isTargetDay`: il giorno d'arrivo del trascinamento; `setOpTip`
 *  mostra il nome intero dell'operatrice sopra la sua sotto-colonna. */
export default function WeekDayHeader({ day, index, width, isToday, isTargetDay, showRevenue, t, lang, onOpenDay, colorOf, opFirsts, setOpTip }) {
  const rev = apptRevenue(day.list);   // il no-show non entra, come nel mese
  const num = parseISO(day.date).getDate();
  const statuses = Object.entries(day.by_status || {});
  return (
    <div style={{ flex: '1 0 ' + width + 'px', minWidth: 0, borderLeft: WEEK_DAY_BORDER, background: isToday ? WEEK_TODAY_BG : 'transparent', boxShadow: isTargetDay ? 'inset 0 -2px 0 var(--ink)' : 'none', transition: 'box-shadow 100ms' }}>
      <button onClick={() => onOpenDay(day.date)} title={t('Apri il giorno', 'Open the day')} style={{ display: 'block', width: '100%', textAlign: 'center', padding: '6px 4px 4px', background: 'transparent', border: 'none', cursor: 'pointer' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: isToday ? 'var(--clay-ink)' : 'var(--muted)' }}>{t(DOW_IT[index], DOW_EN[index])}</span>
          <span className="t-num" style={{ fontSize: 14, color: isToday ? '#fff' : 'var(--ink)', background: isToday ? 'var(--clay)' : 'transparent', width: 24, height: 24, borderRadius: 99, display: 'grid', placeItems: 'center' }}>{num}</span>
        </div>
        {/* conteggio e pallini degli stati sulla stessa riga: prima erano due righe */}
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap', minHeight: 13 }}>
          <span className="t-sm tabnum" style={{ color: 'var(--muted-2)', fontSize: 10 }}>
            {day.count ? `${day.count}${showRevenue ? ' · ' + fmtMoney(rev, lang) : ''}` : t('Libero', 'Free')}
          </span>
          {statuses.map(([st, n]) => {
            const sm = statusMeta(st, t);
            return (
              <span key={st} title={sm.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: sm.color }} />
                <span className="tabnum" style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--muted)' }}>{n}</span>
              </span>
            );
          })}
        </div>
      </button>
      {/* operator sub-column headers: striscia colorata in alto, stessa tinta dei blocchi */}
      {day.dayOps.length > 0 && (
        <div style={{ display: 'flex' }}>
          {day.dayOps.map((o) => (
            <div key={o.id} title={o.first_name + ' ' + o.last_name} onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setOpTip({ name: o.first_name + ' ' + o.last_name, x: r.left + r.width / 2, y: r.bottom + 6 }); }} onMouseLeave={() => setOpTip(null)} style={{ flex: 1, minWidth: 0, padding: '3px 2px 4px', textAlign: 'center', borderLeft: '1px solid var(--hair-2)', borderTop: `3px solid ${colorOf(o.id)}`, cursor: 'default', background: `color-mix(in srgb, ${colorOf(o.id)} 14%, var(--paper))` }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: '0 2px' }}>{opDisplay(o.first_name, o.last_name, opFirsts)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
