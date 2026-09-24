// DayStrip — la striscia dei sette giorni in vista giorno, con le date vere:
// il clic sceglie il giorno. Durante un trascinamento diventa un bersaglio
// (`dragOn`): si può lasciare un appuntamento su un giorno per spostarlo lì
// (data-daydrop, vedi dropDate in DayGrid).
import { toDateStr } from '@youty/shared';
import { DOW_EN, DOW_IT } from '../lib.js';

export default function DayStrip({ weekDays, date, setDate, dragOn, t }) {
  return (
    <div style={{ display: 'flex', gap: 4, background: dragOn ? 'var(--clay-tint)' : 'var(--surface)', border: '1px solid ' + (dragOn ? 'var(--clay)' : 'var(--hair)'), borderRadius: 14, padding: 4, transition: 'background 150ms, border-color 150ms' }}>
      {weekDays.map((d, i) => {
        const iso = toDateStr(d);
        const sel = iso === date;
        const dropTarget = dragOn && !sel;
        return (
          <button key={i} onClick={() => setDate(iso)} data-daydrop={iso}
            title={dragOn ? t('Lascia qui per spostare a questo giorno', 'Drop here to move to this day') : undefined}
            // L'evidenza NON deve usare il bordo: aggiungerlo allarga le
            // pillole, la striscia si sposta sotto il cursore e il
            // rilascio finisce nel vuoto fra una e l'altra. `outline`
            // non occupa spazio.
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '6px 13px', borderRadius: 10, cursor: 'pointer', background: sel ? 'var(--ink)' : dropTarget ? 'var(--surface)' : 'transparent', color: sel ? '#fff' : 'var(--ink)', border: 'none', outline: dropTarget ? '1.5px dashed var(--clay)' : 'none', outlineOffset: -2, transition: 'background 150ms' }}>
            <span style={{ fontSize: 10.5, fontWeight: 600, opacity: sel ? 0.7 : 0.5 }}>{t(DOW_IT[i], DOW_EN[i])}</span>
            <span className="t-num" style={{ fontSize: 17, color: sel ? '#fff' : 'var(--ink)' }}>{d.getDate()}</span>
          </button>
        );
      })}
    </div>
  );
}
