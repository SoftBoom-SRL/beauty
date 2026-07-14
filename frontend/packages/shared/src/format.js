// format.js — currency / time / date helpers shared by both apps.
// Money from the API arrives as decimal STRINGS ("35.00") — display with fmtEur(Number(x)).

export function fmtEur(n, lang) {
  if (n === 0) return lang === 'en' ? 'Free' : 'Gratis';
  return '€' + Number(n).toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT');
}

/** minutes from midnight → "HH:MM" */
export function timeLabel(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/** duration in minutes → "1h 30m" / "1h" / "45m" */
export function fmtDur(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/* ---------------- dates ----------------
 * Date model: the API speaks ISO strings — "YYYY-MM-DD" for dates,
 * full ISO8601 with offset for datetimes. All helpers work in LOCAL time
 * (backend TZ is Europe/Rome and slot math is salon-local). */

/** Date → "YYYY-MM-DD" (local) */
export function toDateStr(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** today as "YYYY-MM-DD" (local) */
export function todayStr() { return toDateStr(new Date()); }

/** ISO string → Date. Date-only strings ("YYYY-MM-DD") parse as LOCAL midnight
 * (native new Date('YYYY-MM-DD') would parse as UTC and shift the day). */
export function parseISO(s) {
  if (s instanceof Date) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return new Date(s);
}

/** ISO datetime → minutes from midnight, local time. The agenda grid maths on this. */
export function minutesOfDay(iso) {
  const d = parseISO(iso);
  return d.getHours() * 60 + d.getMinutes();
}

/** add n days; accepts Date or ISO string, returns a new Date */
export function addDays(date, n) {
  const d = new Date(parseISO(date));
  d.setDate(d.getDate() + n);
  return d;
}

/** Italian long date, e.g. "Mercoledì 12 novembre" (capitalized weekday).
 *  fmtDateIt(date, { weekday: false }) → "12 novembre 2026" */
export function fmtDateIt(date, { weekday = true, year = false } = {}) {
  const d = parseISO(date);
  const opts = { day: 'numeric', month: 'long' };
  if (weekday) opts.weekday = 'long';
  if (year) opts.year = 'numeric';
  const s = d.toLocaleDateString('it-IT', opts);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
