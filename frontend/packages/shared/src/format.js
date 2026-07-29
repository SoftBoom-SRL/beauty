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
 * Two DISTINCT kinds of value come from the API — do not mix them up:
 *
 *  1. CALENDAR DATES — "YYYY-MM-DD". Timezone-free labels. `parseISO` turns them
 *     into a Date at browser-local midnight, used purely as a carrier for
 *     calendar arithmetic (addDays, month grids, weekday of a grid cell).
 *     Round-trips losslessly through `toDateStr` in any browser timezone.
 *
 *  2. INSTANTS — full ISO8601 with offset ("...T09:00:00+02:00" or "...T07:00:00Z",
 *     the API emits both for the same moment). These must be rendered in the
 *     SALON's timezone, never the browser's: server slot math is salon-local, so
 *     a staff member or a client opening the app from another timezone would
 *     otherwise see the whole agenda shifted. Use the `salon*` helpers below.
 */

// ---- salon timezone ------------------------------------------------------
// Set once at app boot from the API (`settings.timezone` for the dashboard,
// `branding.timezone` for the client app). Falls back to the backend default.

let salonTz = 'Europe/Rome';

/** Pin the timezone all instant→clock conversions render in. */
export function setSalonTimeZone(tz) {
  if (tz && typeof tz === 'string') salonTz = tz;
}

export function salonTimeZone() { return salonTz; }

const _fmtCache = new Map();

function _partsFmt(tz) {
  if (!_fmtCache.has(tz)) {
    _fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }));
  }
  return _fmtCache.get(tz);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** An instant (ISO datetime string or Date) → its wall-clock parts in the salon
 *  timezone: { y, m, d, h, min, dow } with dow 0=Sunday (like Date#getDay).
 *  A date-only string is returned as-is at midnight (no conversion applied). */
export function salonParts(value, tz = salonTz) {
  if (typeof value === 'string') {
    const m = DATE_ONLY.exec(value);
    if (m) {
      const [y, mo, d] = [+m[1], +m[2], +m[3]];
      return { y, m: mo, d, h: 0, min: 0, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  const p = {};
  for (const { type, value: v } of _partsFmt(tz).formatToParts(date)) p[type] = v;
  const y = +p.year, mo = +p.month, d = +p.day;
  return {
    y, m: mo, d,
    // some engines render midnight as "24" under hour12:false
    h: (+p.hour) % 24,
    min: +p.minute,
    dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay(),
  };
}

/** Date → "YYYY-MM-DD" (browser-local calendar parts — for CALENDAR DATES) */
export function toDateStr(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** today as "YYYY-MM-DD" (browser-local) */
export function todayStr() { return toDateStr(new Date()); }

/** today as "YYYY-MM-DD" IN THE SALON's timezone — use this whenever "today"
 *  is compared against API data or sent to the API as a `date=` filter. */
export function salonTodayStr() {
  const p = salonParts(new Date());
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** minutes from midnight, right now, in the salon timezone (the agenda "now" line) */
export function salonNowMinutes() {
  const p = salonParts(new Date());
  return p.h * 60 + p.min;
}

/** ISO string → Date. Date-only strings ("YYYY-MM-DD") parse as LOCAL midnight
 * (native new Date('YYYY-MM-DD') would parse as UTC and shift the day). */
export function parseISO(s) {
  if (s instanceof Date) return s;
  const m = DATE_ONLY.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return new Date(s);
}

/** INSTANT → minutes from midnight in the SALON's timezone.
 *  The agenda grid positions every block with this. Both API offset flavours
 *  ("+02:00" from /availability and "Z" from /day) resolve identically. */
export function minutesOfDay(iso) {
  const p = salonParts(iso);
  return p.h * 60 + p.min;
}

/** INSTANT → weekday in the salon timezone, 0=Sunday (like Date#getDay) */
export function salonWeekday(iso) { return salonParts(iso).dow; }

/** INSTANT → "YYYY-MM-DD" of the salon's calendar day it falls on */
export function salonDateStr(iso) {
  const p = salonParts(iso);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** whole salon-days between an INSTANT and today: 0 = today, 1 = yesterday, … */
export function salonDayDiff(iso) {
  const a = salonDateStr(iso).split('-').map(Number);
  const b = salonTodayStr().split('-').map(Number);
  return Math.round(
    (Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000,
  );
}

/** INSTANT → "HH:MM" in the salon timezone */
export function fmtTimeSalon(iso) {
  const p = salonParts(iso);
  return String(p.h).padStart(2, '0') + ':' + String(p.min).padStart(2, '0');
}

const MONTHS_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** INSTANT → "12 novembre 2026 · 14:30" in the salon timezone.
 *  Used for every stored timestamp we show (vendite, movimenti, log, invii). */
export function fmtDateTimeSalon(iso, lang) {
  if (!iso) return '';
  const p = salonParts(iso);
  const months = lang === 'en' ? MONTHS_EN : MONTHS_IT;
  const hm = String(p.h).padStart(2, '0') + ':' + String(p.min).padStart(2, '0');
  return `${p.d} ${months[p.m - 1]} ${p.y} · ${hm}`;
}

/** UTC offset of the salon timezone, in minutes, at a given instant (DST-aware) */
function _salonOffsetMin(date, tz = salonTz) {
  const p = salonParts(date, tz);
  const asIfUTC = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  const floored = Math.floor(date.getTime() / 60000) * 60000;
  return (asIfUTC - floored) / 60000;
}

/** WRITE PATH: calendar date + minutes-of-day (as read off the agenda grid) →
 *  ISO8601 carrying the SALON's offset, e.g. "2026-07-06T10:30:00+02:00".
 *  Using the browser's offset here would persist the wrong instant whenever the
 *  user is not in the salon's timezone — this is a data bug, not a display one. */
export function salonIsoAt(dateStr, minutes) {
  const pad = (n) => String(n).padStart(2, '0');
  const base = typeof dateStr === 'string' && DATE_ONLY.test(dateStr)
    ? DATE_ONLY.exec(dateStr)
    : DATE_ONLY.exec(toDateStr(parseISO(dateStr)));
  const y = +base[1], mo = +base[2], d = +base[3];
  const h = Math.floor(minutes / 60), min = ((minutes % 60) + 60) % 60;
  // Resolve the instant whose salon wall-clock is exactly y-mo-d h:min.
  const wall = Date.UTC(y, mo - 1, d, h, min);
  let off = _salonOffsetMin(new Date(wall));
  const off2 = _salonOffsetMin(new Date(wall - off * 60000));
  if (off2 !== off) off = off2; // DST edge: re-resolve with the corrected offset
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(min)}:00`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** add n days; accepts Date or ISO string, returns a new Date */
export function addDays(date, n) {
  const d = new Date(parseISO(date));
  d.setDate(d.getDate() + n);
  return d;
}

/** Italian long date, e.g. "Mercoledì 12 novembre" (capitalized weekday).
 *  fmtDateIt(date, { weekday: false }) → "12 novembre 2026"
 *  Calendar dates and Date carriers keep browser-local parts; a full ISO
 *  datetime (an INSTANT) is rendered in the salon timezone. */
export function fmtDateIt(date, { weekday = true, year = false } = {}) {
  const opts = { day: 'numeric', month: 'long' };
  if (weekday) opts.weekday = 'long';
  if (year) opts.year = 'numeric';
  const isInstant = typeof date === 'string' && !DATE_ONLY.test(date);
  if (isInstant) opts.timeZone = salonTz;
  const s = parseISO(date).toLocaleDateString('it-IT', opts);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
