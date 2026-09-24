// SlotPicker.jsx — gli orari liberi di un giorno, divisi fra mattina e
// pomeriggio: la stessa griglia in Prenota e in Sposta.
import React from 'react';
import { minutesOfDay, timeLabel } from '@youty/shared';

/** I pulsanti degli orari. Sta fuori dal render di chi lo usa: definito lì
 *  dentro era un componente nuovo a ogni render, e React rifaceva da capo
 *  tutti i pulsanti a ogni tocco. */
function TimeGrid({ list, slot, onPick }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: 9 }}>
      {list.map((sl) => {
        const on = slot?.start === sl.start;
        return (
          <button key={sl.start} className="press tabnum" onClick={() => onPick(sl)}
            style={{ padding: '13px 0', borderRadius: 12, fontWeight: 700, fontSize: 14.5, border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--hair)'), background: on ? 'var(--brand)' : 'var(--paper-0)', color: on ? 'var(--brand-on)' : 'var(--ink)' }}>
            {timeLabel(minutesOfDay(sl.start))}
          </button>
        );
      })}
    </div>
  );
}

/** `slots`: gli SlotOut del giorno ({ start, … }), null mentre arrivano (nove
 *  segnaposto). `slot` è quello scelto, `onPick(sl)` il tocco. Senza orari
 *  si mostra `empty` (null = niente), che ogni schermo scrive a modo suo.
 *  Mattina = prima delle 12:00 in salone. */
export function SlotPicker({ slots, slot, onPick, empty, t }) {
  if (slots === null) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: 9 }}>
        {Array.from({ length: 9 }).map((_, i) => <div key={i} className="skel" style={{ height: 46, borderRadius: 12 }} />)}
      </div>
    );
  }
  const free = slots || [];
  const morning = free.filter((sl) => minutesOfDay(sl.start) < 720);
  const afternoon = free.filter((sl) => minutesOfDay(sl.start) >= 720);
  if (!free.length) return empty;
  return (
    <React.Fragment>
      {morning.length > 0 && (
        <div style={{ marginBottom: afternoon.length ? 18 : 0 }}>
          <div className="t-meta" style={{ marginBottom: 10 }}>{t('Mattina', 'Morning')}</div>
          <TimeGrid list={morning} slot={slot} onPick={onPick} />
        </div>
      )}
      {afternoon.length > 0 && (
        <div>
          <div className="t-meta" style={{ marginBottom: 10 }}>{t('Pomeriggio', 'Afternoon')}</div>
          <TimeGrid list={afternoon} slot={slot} onPick={onPick} />
        </div>
      )}
    </React.Fragment>
  );
}
