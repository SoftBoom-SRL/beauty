// HourGutter — la colonna delle ore a sinistra, in giorno e settimana (resta
// ferma scorrendo di lato): etichette in grassetto centrate sulla riga
// (line-height 14 → -7), una tacca che prolunga la riga nella colonna e la
// mezz'ora in piccolo quando c'è posto. La settimana è più fitta: colonna più
// stretta, testo più piccolo, mezz'ore scritte «:30».
import React from 'react';
import { DAY_HOURS_W, GRID_LINE_STYLE, WEEK_HOURS_W } from '../lib.js';

/* I numeri di ciascuna vista, come li scrivevano giorno e settimana. */
const VARIANT = {
  day: { width: DAY_HOURS_W, right: 10, hourSize: 11, tick: 6, halfFrom: 18, halfSize: 9.5 },
  week: { width: WEEK_HOURS_W, right: 7, hourSize: 10, tick: 5, halfFrom: 16, halfSize: 8.5 },
};

/** Le ore da g0 a g1 (minuti) alla scala `pxm`; `variant` = 'day' | 'week'. */
export default function HourGutter({ g0, g1, pxm, variant = 'day' }) {
  const v = VARIANT[variant];
  const hours = []; for (let h = g0 / 60; h <= g1 / 60; h++) hours.push(h);
  return (
    <div style={{ width: v.width, flexShrink: 0, position: 'sticky', left: 0, zIndex: 7, background: 'var(--paper)' }}>
      {hours.map((h) => (
        <React.Fragment key={h}>
          <div className="tabnum" style={{ position: 'absolute', top: (h * 60 - g0) * pxm - 7, right: v.right, fontSize: v.hourSize, lineHeight: '14px', fontWeight: 700, color: 'var(--muted)' }}>{String(h).padStart(2, '0')}:00</div>
          <div style={{ position: 'absolute', top: (h * 60 - g0) * pxm, right: 0, width: v.tick, ...GRID_LINE_STYLE.hour }} />
          {h < g1 / 60 && 30 * pxm > v.halfFrom && <div className="tabnum" style={{ position: 'absolute', top: (h * 60 + 30 - g0) * pxm - 6, right: v.right, fontSize: v.halfSize, lineHeight: '12px', fontWeight: 600, color: 'var(--muted-2)' }}>{variant === 'day' && String(h).padStart(2, '0')}:30</div>}
        </React.Fragment>
      ))}
    </div>
  );
}
