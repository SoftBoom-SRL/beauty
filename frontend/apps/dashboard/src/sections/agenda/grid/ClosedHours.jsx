// ClosedHours — le fasce fuori turno di una colonna: le ore della griglia
// fuori dalle finestre di lavoro, grigie e a righe sottili, uguali per ogni
// colore di colonna, con una scritta se c'è posto. In vista giorno le
// finestre sono i turni dell'operatrice («Fuori turno», o «Non in turno»
// senza turni quel giorno); in settimana gli orari del centro (`labels`).
// Senza hook: nei test fa parte di DayGrid e WeekView.
import { closedIntervals } from '../lib.js';

/* Dove va la scritta. Ora che la griglia copre le 24 ore, la notte è una fascia
 * di nove ore: al centro la scritta finiva alle 4 del mattino e non la vedeva
 * nessuno. Nelle fasce lunghe sta vicino all'orario di lavoro — in fondo a
 * quella del mattino, in cima a quella della sera — e al centro nelle altre
 * (la pausa pranzo, il giorno intero senza turni). */
function labelSpot(s, e2, g0, g1) {
  const whole = s === g0 && e2 === g1;
  if (whole || e2 - s <= 180) return { top: '50%', transform: 'translateY(-50%)' };
  if (s === g0) return { bottom: 14 };
  if (e2 === g1) return { top: 14 };
  return { top: '50%', transform: 'translateY(-50%)' };
}

/** `labels` = { some, none }: la scritta quando ci sono finestre di lavoro e
 *  quando non ce n'è nessuna (null = niente scritta). */
export default function ClosedHours({ windows, g0, g1, pxm, t, labels = null }) {
  const has = (windows || []).length > 0;
  const text = labels
    ? (has ? labels.some : labels.none)
    : (has ? t('Fuori turno', 'Off shift') : t('Non in turno', 'Off today'));
  return closedIntervals(windows, g0, g1).map(([s, e2], i) => (
    <div key={i} style={{ position: 'absolute', left: 0, right: 0, top: (s - g0) * pxm, height: (e2 - s) * pxm, pointerEvents: 'none', background: 'repeating-linear-gradient(135deg, rgba(17,24,39,0.07) 0 1px, transparent 1px 7px), rgba(17,24,39,0.035)', zIndex: 1 }}>
      {text && (e2 - s) * pxm > 46 && (
        <span className="dk-closed-label" style={labelSpot(s, e2, g0, g1)}>{text}</span>
      )}
    </div>
  ));
}
