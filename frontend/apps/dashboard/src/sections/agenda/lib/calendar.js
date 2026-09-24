// lib/calendar.js — giorni, settimane e mesi dell'agenda (aritmetica di
// calendario, senza fuso: vedi packages/shared/src/format.js).
// Logica pura: la caricano anche i test con `node --test`.
import { parseISO, toDateStr } from '@youty/shared';

export const MONTHS_IT = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
export const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DOW_IT = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
export const DOW_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "HH:MM" → minutes of day (shift windows come as [["09:00","13:00"], ...]) */
export function hmToMin(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Monday (Date) of the week containing the given date/ISO string */
export function mondayOf(date) {
  const d = parseISO(date);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** shift an ISO date by n months, clamped to day 1 */
export function addMonths(dateStr, n) {
  const d = parseISO(dateStr);
  return toDateStr(new Date(d.getFullYear(), d.getMonth() + n, 1));
}

/** Vero se `value` ("YYYY-MM-DD" di <input type="date">) è una data da cui
 *  saltare. Scrivendo l'anno a tastiera il campo passa per 0002, 0020, 0202:
 *  sono date valide per il browser, e al primo tasto l'agenda saltava al 1902
 *  (gli anni 0–99 di Date sono il Novecento). */
export function plausibleDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return !!m && Number(m[1]) >= 1900;
}
