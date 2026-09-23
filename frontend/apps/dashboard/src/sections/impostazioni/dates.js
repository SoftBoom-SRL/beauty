// dates.js — date e ore delle Impostazioni, sempre sull'orologio del SALONE
// (logica pura, provata con node --test).
import { addDays, fmtTime, salonDateParts, toDateStr, todayStr } from '@youty/shared';

const MONTHS = {
  it: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};
const pad2 = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" del salone, `n` giorni prima di `today` (aritmetica di calendario). */
export function salonDaysAgo(n, today = todayStr()) {
  return toDateStr(addDays(today, -n));
}

/**
 * Istante del registro attività → «Oggi · 10:15», «Ieri · 00:30», «3 set 2026 · 18:02».
 * Ora e giorno erano quelli del dispositivo (`toTimeString`, `setHours`): da una
 * postazione rimasta in UTC l'annullamento delle 10:15 compariva alle 08:15 e le
 * azioni delle 00:30 risultavano di «Ieri», mentre il filtro «Oggi» lo calcola
 * il server sul giorno del salone (15-09, 08-09).
 */
export function logDateLabel(iso, lang, today = todayStr()) {
  const p = salonDateParts(iso);
  const day = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  const hm = fmtTime(iso);
  if (day === today) return (lang === 'en' ? 'Today' : 'Oggi') + ' · ' + hm;
  if (day === salonDaysAgo(1, today)) return (lang === 'en' ? 'Yesterday' : 'Ieri') + ' · ' + hm;
  const months = MONTHS[lang === 'en' ? 'en' : 'it'];
  return p.day + ' ' + months[p.month - 1] + ' ' + p.year + ' · ' + hm;
}
