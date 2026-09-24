// lib/calendar.js — giorni, settimane e mesi dell'agenda (aritmetica di
// calendario, senza fuso: vedi packages/shared/src/format.js).
// Logica pura: la caricano anche i test con `node --test`.
import {
  MONTHS_LONG_EN, MONTHS_LONG_IT, WEEKDAYS_SHORT_EN, WEEKDAYS_SHORT_IT, addDays, parseISO, timeLabel, toDateStr, todayStr,
} from '@youty/shared';

/* Nomi dei mesi (0 = gennaio) e dei giorni (0 = lunedì, come l'API) con i
 * nomi che l'agenda usa da sempre: sono le tabelle condivise di
 * @youty/shared, congelate (qui si leggono e basta). */
export const MONTHS_IT = MONTHS_LONG_IT;
export const MONTHS_EN = MONTHS_LONG_EN;
export const DOW_IT = WEEKDAYS_SHORT_IT;
export const DOW_EN = WEEKDAYS_SHORT_EN;

/** Giorno della settimana di un Date, con lo 0 al LUNEDÌ come l'API e le
 *  tabelle dei nomi (getDay() parte dalla domenica). */
export const dowIndex = (d) => (d.getDay() + 6) % 7;

/** «Lun 5»: giorno della settimana e del mese di "YYYY-MM-DD". */
export function dayLabel(date, t) {
  const d = parseISO(date);
  return `${t(DOW_IT[dowIndex(d)], DOW_EN[dowIndex(d)])} ${d.getDate()}`;
}

/** «Lun 5, 10:00»: il giorno e l'ora di arrivo negli avvisi degli
 *  spostamenti su un altro giorno. */
export function dayTimeLabel(date, startMin, t) {
  const d = parseISO(date);
  return t(`${DOW_IT[dowIndex(d)]} ${d.getDate()}, ${timeLabel(startMin)}`, `${DOW_EN[dowIndex(d)]} ${d.getDate()}, ${timeLabel(startMin)}`);
}

/** "HH:MM" → minutes of day (shift windows come as [["09:00","13:00"], ...]) */
export function hmToMin(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Monday (Date) of the week containing the given date/ISO string */
export function mondayOf(date) {
  const d = parseISO(date);
  const dow = dowIndex(d); // 0 = Monday
  d.setDate(d.getDate() - dow);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** shift an ISO date by n months, clamped to day 1 */
export function addMonths(dateStr, n) {
  const d = parseISO(dateStr);
  return toDateStr(new Date(d.getFullYear(), d.getMonth() + n, 1));
}

/** Il giorno a video dopo le frecce della barra (`dir` = −1 o +1): un giorno
 *  in vista giorno, una settimana in vista settimana, un mese (dal primo) nel
 *  mese. */
export function shiftAnchor(view, date, dir) {
  if (view === 'day' || view === 'week') return toDateStr(addDays(date, dir * (view === 'week' ? 7 : 1)));
  return addMonths(date, dir);
}

/** I sette giorni (Date) della settimana che comincia con `monday`. */
export function weekDaysOf(monday) {
  return [...Array(7)].map((_, i) => {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    return d;
  });
}

/** Titolo della barra in settimana e nel mese: «Settembre 2026»,
 *  «21–27 Settembre 2026», «28 Set – 4 Ott 2026». `months` = i nomi nella
 *  lingua dell'interfaccia. */
export function periodLabel(view, date, weekDays, months) {
  const cur = parseISO(date);
  if (view === 'month') return months[cur.getMonth()] + ' ' + cur.getFullYear();
  const s = weekDays[0], e = weekDays[6];
  return s.getMonth() === e.getMonth()
    ? `${s.getDate()}–${e.getDate()} ${months[e.getMonth()]} ${e.getFullYear()}`
    : `${s.getDate()} ${months[s.getMonth()].slice(0, 3)} – ${e.getDate()} ${months[e.getMonth()].slice(0, 3)} ${e.getFullYear()}`;
}

/** Oggi (nel fuso del salone) è uno dei giorni `weekDays`? */
export function isTodayInWeek(weekDays) {
  const today = todayStr();
  return weekDays.some((d) => toDateStr(d) === today);
}

/** Vero se `value` ("YYYY-MM-DD" di <input type="date">) è una data da cui
 *  saltare. Scrivendo l'anno a tastiera il campo passa per 0002, 0020, 0202:
 *  sono date valide per il browser, e al primo tasto l'agenda saltava al 1902
 *  (gli anni 0–99 di Date sono il Novecento). */
export function plausibleDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return !!m && Number(m[1]) >= 1900;
}
