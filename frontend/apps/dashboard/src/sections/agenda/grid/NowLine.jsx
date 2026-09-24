// NowLine — la riga rossa dell'ora attuale, se cade nella fascia della
// griglia (nowMin null = non è oggi). In vista giorno ha il pallino e l'ora
// scritta e sta sopra i blocchi; in settimana è una riga sola, più in basso.
import { timeLabel } from '@youty/shared';
import { NOW_LINE_COLOR } from '../lib.js';

export default function NowLine({ nowMin, g0, g1, pxm, variant = 'day' }) {
  if (!(nowMin != null && nowMin >= g0 && nowMin <= g1)) return null;
  if (variant === 'week') {
    return <div style={{ position: 'absolute', left: 0, right: 0, top: (nowMin - g0) * pxm, height: 2, background: NOW_LINE_COLOR, zIndex: 6, pointerEvents: 'none' }} />;
  }
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: (nowMin - g0) * pxm, height: 2, background: NOW_LINE_COLOR, zIndex: 8, pointerEvents: 'none' }}>
      <span style={{ position: 'absolute', left: -6, top: -5, width: 12, height: 12, borderRadius: 99, background: NOW_LINE_COLOR, boxShadow: '0 0 0 3px rgba(244,112,138,0.2)' }} />
      <span className="tabnum" style={{ position: 'absolute', right: 6, top: -8, fontSize: 10, fontWeight: 800, color: NOW_LINE_COLOR, background: 'var(--paper)', padding: '0 4px', borderRadius: 4 }}>{timeLabel(nowMin)}</span>
    </div>
  );
}
