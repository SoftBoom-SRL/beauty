// DayStrip.jsx — la striscia dei prossimi giorni di Prenota e Sposta.
import { dayStripLabel } from '../lib/dates.js';

/** I chip dei giorni: `days` sono i Date di nextDays (mezzanotte locale),
 *  `dayIdx` il giorno scelto, `onPick(i)` il tocco su un giorno. */
export function DayStrip({ days, dayIdx, onPick, lang }) {
  return (
    <div className="scroll" style={{ display: 'flex', gap: 9, overflowX: 'auto', paddingBottom: 6, marginBottom: 20, marginInline: -2, paddingInline: 2 }}>
      {days.map((d, i) => {
        const on = i === dayIdx;
        const { wd, num } = dayStripLabel(d, lang);
        return (
          <button key={i} className="press" onClick={() => onPick(i)}
            style={{ flexShrink: 0, minWidth: 62, padding: '9px 14px', borderRadius: 14, border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--hair)'), background: on ? 'var(--brand)' : 'var(--paper-0)', color: on ? 'var(--brand-on)' : 'var(--ink)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, opacity: on ? 0.85 : 0.6 }}>{wd}</span>
            <span className="tabnum" style={{ fontSize: 15, fontWeight: 800 }}>{num}</span>
          </button>
        );
      })}
    </div>
  );
}
