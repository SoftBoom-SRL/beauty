// hours.js — orari di apertura: etichette e fasce di oggi (logica pura, provata
// con node --test; HoursDrawer.jsx la riesporta).
import { salonDateParts } from '@youty/shared';

/** giorno → etichetta "9:00–13:00 · 14:00–19:00" / "chiuso" */
export function dayLabel(ranges, t) {
  if (!ranges || !ranges.length) return t('chiuso', 'closed');
  return ranges.map(([a, b]) => `${a.replace(/^0/, '')}–${b.replace(/^0/, '')}`).join(' · ');
}

/** Orari di oggi da settings.opening_hours_week (0 = lunedì).
 *  «Oggi» è il giorno del SALONE: con `getDay()` del dispositivo, alle 00:30 di
 *  domenica a Roma un portatile in UTC mostrava ancora gli orari del sabato
 *  (15-22). `now` è un istante (Date o ISO con orario). */
export function todayRanges(week, now = new Date()) {
  if (!week || !Object.keys(week).length) return null;
  const { year, month, day } = salonDateParts(now);
  const idx = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return week[String(idx)] || week[idx] || [];
}
