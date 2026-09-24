// ClosedHours — le fasce fuori turno di una colonna in vista giorno: le ore
// della griglia fuori dalle finestre di lavoro dell'operatrice, tratteggiate,
// con «Fuori turno» (o «Non in turno», senza turni quel giorno) se c'è posto
// per scriverlo. Senza hook: nei test fa parte di DayGrid.
import { closedIntervals } from '../lib.js';

export default function ClosedHours({ windows, g0, g1, pxm, t }) {
  return closedIntervals(windows, g0, g1).map(([s, e2], i) => (
    <div key={i} style={{ position: 'absolute', left: 0, right: 0, top: (s - g0) * pxm, height: (e2 - s) * pxm, pointerEvents: 'none', borderRadius: 10, background: 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--paper) 70%, transparent) 0 6px, transparent 6px 12px)', zIndex: 1 }}>
      {(e2 - s) * pxm > 46 && (
        <span className="dk-closed-label" style={{ top: '50%', transform: 'translateY(-50%)' }}>
          {(windows || []).length ? t('Fuori turno', 'Off shift') : t('Non in turno', 'Off today')}
        </span>
      )}
    </div>
  ));
}
