// dates.js — scadenze e date della sezione Promozioni sull'orologio del SALONE.
//
// Le scadenze di coupon e gift card si scrivevano e si leggevano col fuso del
// dispositivo (`setHours`, `new Date(giorno + 'T23:59')`, toLocaleDateString
// senza fuso): da una postazione su un altro fuso la scadenza si spostava a
// ogni salvataggio e le date a video cambiavano giorno. E «+6 mesi» con
// setMonth sforava a fine mese: una carta del 31 agosto scadeva il 3 marzo
// (07-15, 14-13, 17-15). Solo helper di packages/shared/src/format.js, quindi
// provati da `npm test` (apps/dashboard/test/fedelta.test.js).
import { isoAtMin, parseISO, salonTzOpts, todayStr, toDateStr } from '@youty/shared';

const END_OF_DAY_MIN = 23 * 60 + 59;
const pad2 = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" + n mesi di calendario, fermandosi all'ultimo giorno del mese:
 *  31 agosto + 6 mesi = 28 (o 29) febbraio, non 3 marzo. */
export function addMonthsClamped(dateStr, n) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ty = Math.floor(idx / 12);
  const tm = idx - ty * 12 + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();  // giorno 0 del mese dopo = ultimo di questo
  return `${ty}-${pad2(tm)}-${pad2(Math.min(d, last))}`;
}

/** Le 23:59 di quel giorno nel fuso del salone, come ISO: è la scadenza di un
 *  coupon o di una carta «fino al giorno X». */
export const endOfSalonDayIso = (dateStr) => isoAtMin(dateStr, END_OF_DAY_MIN);

/** Scadenza «fra n mesi» da oggi (in salone): stesso giorno, fine giornata. */
export const expiryInMonthsIso = (months, today = todayStr()) => endOfSalonDayIso(addMonthsClamped(today, months));

/** Istante dell'API → "YYYY-MM-DD" del salone, per un <input type="date">. */
export const salonDay = (iso) => (iso ? toDateStr(iso) : null);

/** Data breve (gg/mm/aaaa) di un valore dell'API: un istante sul calendario
 *  del salone, una data pura ("YYYY-MM-DD", la consegna) così com'è. */
export function shortDate(iso, lang) {
  if (!iso) return '';
  const locale = lang === 'en' ? 'en-GB' : 'it-IT';
  if (typeof iso === 'string' && !iso.includes('T')) return parseISO(iso).toLocaleDateString(locale);
  return new Date(iso).toLocaleDateString(locale, salonTzOpts());
}
