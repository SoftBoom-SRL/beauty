// ClosedHours — le fasce fuori turno di una colonna in vista giorno: le ore
// della griglia fuori dalle finestre di lavoro dell'operatrice, grigie e a
// righe sottili, uguali per ogni colore di colonna,
// con «Fuori turno» (o «Non in turno», senza turni quel giorno) se c'è posto
// per scriverlo. Senza hook: nei test fa parte di DayGrid.
import { closedIntervals } from '../lib.js';

export default function ClosedHours({ windows, g0, g1, pxm, t }) {
  return closedIntervals(windows, g0, g1).map(([s, e2], i) => (
    <div key={i} style={{ position: 'absolute', left: 0, right: 0, top: (s - g0) * pxm, height: (e2 - s) * pxm, pointerEvents: 'none', background: 'repeating-linear-gradient(135deg, rgba(17,24,39,0.07) 0 1px, transparent 1px 7px), rgba(17,24,39,0.035)', zIndex: 1 }}>
      {(e2 - s) * pxm > 46 && (
        <span className="dk-closed-label" style={{ top: '50%', transform: 'translateY(-50%)' }}>
          {(windows || []).length ? t('Fuori turno', 'Off shift') : t('Non in turno', 'Off today')}
        </span>
      )}
    </div>
  ));
}
