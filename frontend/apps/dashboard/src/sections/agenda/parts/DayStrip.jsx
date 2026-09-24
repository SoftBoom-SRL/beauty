// DayStrip — la striscia dei sette giorni in vista giorno, con le date vere:
// il clic sceglie il giorno, e oggi ha il suo pallino anche quando si guarda
// un altro giorno. Durante un trascinamento diventa un bersaglio (`dragOn`):
// si può lasciare un appuntamento su un giorno per spostarlo lì
// (data-daydrop, vedi dropDate in DayGrid).
import { toDateStr, todayStr } from '@youty/shared';
import { DOW_EN, DOW_IT } from '../lib.js';

export default function DayStrip({ weekDays, date, setDate, dragOn, t }) {
  const today = todayStr();
  return (
    <div className={'dk-agseg dk-agdays' + (dragOn ? ' dk-agdays--drop' : '')} role="group" aria-label={t('Giorni della settimana', 'Days of the week')}>
      {weekDays.map((d, i) => {
        const iso = toDateStr(d);
        const sel = iso === date;
        const dropTarget = dragOn && !sel;
        return (
          <button key={i} onClick={() => setDate(iso)} data-daydrop={iso} aria-pressed={sel}
            className={iso === today ? 'is-today' : undefined}
            title={dragOn ? t('Lascia qui per spostare a questo giorno', 'Drop here to move to this day') : (iso === today ? t('Oggi', 'Today') : undefined)}
            // L'evidenza NON deve usare il bordo: aggiungerlo allarga le
            // pillole, la striscia si sposta sotto il cursore e il
            // rilascio finisce nel vuoto fra una e l'altra. `outline`
            // non occupa spazio.
            style={dropTarget ? { background: 'var(--surface)', outline: '1.5px dashed var(--clay)', outlineOffset: -2 } : undefined}>
            <span className="dow">{t(DOW_IT[i], DOW_EN[i])}</span>
            <span className="num">{d.getDate()}</span>
          </button>
        );
      })}
    </div>
  );
}
