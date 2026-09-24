// dates.js — giorni ed etichette di data dell'app cliente. Gli istanti si
// leggono sul calendario del SALONE (vedi il fuso in format.js di
// @youty/shared); i Date di mezzanotte locale sono aritmetica di giorni.
// Logica pura, senza React: la caricano anche i test con `node --test`.
import { parseISO, timeLabel, minutesOfDay, toDateStr, todayStr, addDays, salonTzOpts } from '@youty/shared';

const locale = (lang) => (lang === 'en' ? 'en-GB' : 'it-IT');

/** I prossimi n giorni come Date[], a partire da OGGI IN SALONE.
 *
 *  Partivano da `new Date()`, cioè dal calendario del telefono: da Los Angeles
 *  il primo chip era un giorno che per il salone è già passato e usciva sempre
 *  vuoto; da Tokyo la striscia partiva da domani e gli orari ancora liberi di
 *  oggi sparivano. I Date restano mezzanotte LOCALE, perché da qui in poi sono
 *  aritmetica di giorni (etichette e toDateStr), non istanti. */
export function nextDays(n = 14) {
  const today = parseISO(todayStr());
  return Array.from({ length: n }, (_, i) => addDays(today, i));
}

/** Short strip label parts, e.g. { wd: 'Gio', num: '14' }. */
export function dayStripLabel(date, lang) {
  const wd = date.toLocaleDateString(locale(lang), { weekday: 'short' }).replace('.', '');
  return { wd: wd.charAt(0).toUpperCase() + wd.slice(1), num: String(date.getDate()) };
}

/** "Gio 14 nov" style medium label. */
export function fmtDayMed(dateish, lang) {
  const d = parseISO(dateish);
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  // Un istante si legge sul calendario del salone; una data pura è già un giorno.
  const s = d.toLocaleDateString(
    locale(lang),
    typeof dateish === 'string' && !dateish.includes('T') ? opts : salonTzOpts(opts),
  ).replace(/\./g, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Big relative label for the next appointment: "Oggi alle 15:30" / "Domani alle 10:00" / "Gio 14 nov · 10:00". */
export function relLabel(iso, lang, t) {
  const d = parseISO(iso);
  // «Oggi» e «domani» si contano sul calendario del SALONE: dall'estero la
  // cliente leggeva l'ora del proprio telefono, e a cavallo della mezzanotte
  // anche il giorno sbagliato.
  const days = Math.round((parseISO(toDateStr(iso)) - parseISO(todayStr())) / 86400000);
  const hm = timeLabel(minutesOfDay(iso));
  if (days === 0) return t('Oggi alle ', 'Today at ') + hm;
  if (days === 1) return t('Domani alle ', 'Tomorrow at ') + hm;
  if (days > 1 && days < 7) {
    const wd = d.toLocaleDateString(locale(lang), salonTzOpts({ weekday: 'long' }));
    return wd.charAt(0).toUpperCase() + wd.slice(1) + t(' alle ', ' at ') + hm;
  }
  return fmtDayMed(d, lang) + ' · ' + hm;
}
