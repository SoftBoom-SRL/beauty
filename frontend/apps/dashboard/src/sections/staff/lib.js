// lib.js — staff section helpers: availability meta (prototype AVAIL_STATUS styling),
// minutes↔"HH:MM" conversions, weekly-pattern (de)serialization, local GD palette.

/* ---- availability / absence meta — ported from prototype AVAIL_STATUS ----
 * Keys follow the API: absence type ∈ vacation | holiday | other, plus the
 * synthetic work / off states used by the today-status pill. */
export const AVAIL_META = {
  work:     { it: 'Lavorativa',    en: 'Working',  c: '#3F9D6B', bg: 'rgba(63,157,107,0.14)' },
  off:      { it: 'Giorno libero', en: 'Day off',  c: '#6F6E74', bg: 'rgba(111,110,116,0.12)' },
  vacation: { it: 'Ferie',         en: 'Vacation', c: '#5FAEC9', bg: 'rgba(95,174,201,0.16)' },
  holiday:  { it: 'Festività',     en: 'Holiday',  c: '#B26A4F', bg: 'rgba(178,106,79,0.16)' },
  other:    { it: 'Altro',         en: 'Other',    c: '#8A5A6E', bg: 'rgba(138,90,110,0.14)' },
};
export const ABSENCE_TYPES = ['vacation', 'holiday', 'other'];

/* ---- weekday / month labels (weekday 0 = Monday, as the API) ---- */
export const WEEKDAYS = [
  ['Lun', 'Mon'], ['Mar', 'Tue'], ['Mer', 'Wed'], ['Gio', 'Thu'],
  ['Ven', 'Fri'], ['Sab', 'Sat'], ['Dom', 'Sun'],
];
export const MONTHS_IT = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
export const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "YYYY-MM" → short localized month label ("Giu" / "Jun") */
export function monthShort(ym, lang) {
  const [y, m] = ym.split('-').map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', { month: 'short' });
  return s.charAt(0).toUpperCase() + s.slice(1).replace('.', '');
}

/* ---- minutes ↔ "HH:MM" ---- */

/** minutes from midnight → compact label: 540 → "9", 570 → "9:30" */
export function minCompact(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}:${String(m).padStart(2, '0')}` : String(h);
}

/** "HH:MM" (from API windows) → compact label: "09:00" → "9", "09:30" → "9:30" */
export function hmCompact(hm) {
  const [h, m] = hm.split(':').map(Number);
  return m ? `${h}:${String(m).padStart(2, '0')}` : String(h);
}

/** windows [["09:00","13:00"],["14:00","19:00"]] → "9–13 · 14–19" */
export function fmtWindows(windows) {
  return (windows || []).map(([a, b]) => `${hmCompact(a)}–${hmCompact(b)}`).join(' · ');
}

/** "9" | "9:30" | "09.30" → minutes from midnight, or null if not a time */
export function hmToMin(s) {
  const m = /^(\d{1,2})(?:[:.](\d{1,2}))?$/.exec(String(s).trim());
  if (!m) return null;
  const h = +m[1], mm = m[2] ? +m[2] : 0;
  if (h > 24 || mm > 59) return null;
  return h * 60 + mm;
}

/** Range text → [startMin, endMin].
 *  Returns null for "empty / day off" ("", "—", "riposo", "off"),
 *  undefined for text that looks wrong (so the caller can flag it). */
export function parseRange(str) {
  const txt = String(str || '').trim();
  if (!txt || txt === '—' || txt === '-' || /^(ripos|off|rest|libero)/i.test(txt)) return null;
  const parts = txt.split(/\s*[–—-]\s*/).filter(Boolean);
  if (parts.length !== 2) return undefined;
  const a = hmToMin(parts[0]), b = hmToMin(parts[1]);
  if (a == null || b == null || b <= a) return undefined;
  return [a, b];
}

/** [startMin, endMin] → "9–19" / "9:30–18" */
export function fmtRange(a, b) { return `${minCompact(a)}–${minCompact(b)}`; }

/* ---- weekly pattern ↔ editor rows ----
 * Editor model: weeks = [{ days: [{ hours: "9–19"|"", brk: "13–14"|"" } × 7] }]
 * API model:    shifts = [{ week_index, weekday, start_min, end_min, break_start_min?, break_end_min? }]
 */

const emptyDay = () => ({ hours: '', brk: '' });
export const emptyWeek = () => ({ days: Array.from({ length: 7 }, emptyDay) });

/** WeeklyShiftOut[] + cycle_weeks → editor weeks. Multiple rows on the same
 *  (week, day) — split shifts — are merged into span + first gap as break. */
export function weeksFromShifts(shifts, cycleWeeks) {
  const n = Math.max(1, cycleWeeks || 1);
  const weeks = Array.from({ length: n }, emptyWeek);
  const byDay = {};
  (shifts || []).forEach((s) => {
    const wi = Math.min(s.week_index || 0, n - 1);
    (byDay[`${wi}:${s.weekday}`] = byDay[`${wi}:${s.weekday}`] || []).push(s);
  });
  Object.entries(byDay).forEach(([key, rows]) => {
    const [wi, di] = key.split(':').map(Number);
    rows.sort((a, b) => a.start_min - b.start_min);
    const day = weeks[wi].days[di];
    if (rows.length === 1) {
      const r = rows[0];
      day.hours = fmtRange(r.start_min, r.end_min);
      day.brk = r.break_start_min != null && r.break_end_min != null ? fmtRange(r.break_start_min, r.break_end_min) : '';
    } else {
      // split shift → one span with the first gap as break
      const first = rows[0], last = rows[rows.length - 1];
      day.hours = fmtRange(first.start_min, last.end_min);
      day.brk = rows[1].start_min > first.end_min ? fmtRange(first.end_min, rows[1].start_min) : '';
    }
  });
  return weeks;
}

/** Editor weeks → WeeklyShiftIn[]. Throws Error with a localized message
 *  (day label + reason) on unparsable input. */
export function shiftsFromWeeks(weeks, t) {
  const rows = [];
  weeks.forEach((w, wi) => {
    w.days.forEach((d, di) => {
      const label = t(WEEKDAYS[di][0], WEEKDAYS[di][1]) + (weeks.length > 1 ? ` · ${t('sett.', 'wk')} ${wi + 1}` : '');
      const range = parseRange(d.hours);
      if (range === undefined) throw new Error(t(`Orario non valido (${label})`, `Invalid hours (${label})`));
      if (range === null) {
        if (String(d.brk || '').trim() && parseRange(d.brk) !== null) {
          throw new Error(t(`Pausa senza orario (${label})`, `Break without hours (${label})`));
        }
        return; // day off
      }
      const [start, end] = range;
      const brk = parseRange(d.brk);
      if (brk === undefined) throw new Error(t(`Pausa non valida (${label})`, `Invalid break (${label})`));
      if (brk && !(start <= brk[0] && brk[1] <= end)) {
        throw new Error(t(`La pausa deve stare dentro l'orario (${label})`, `Break must be inside the hours (${label})`));
      }
      rows.push({
        week_index: wi,
        weekday: di,
        start_min: start,
        end_min: end,
        break_start_min: brk ? brk[0] : null,
        break_end_min: brk ? brk[1] : null,
      });
    });
  });
  return rows;
}

/* ---- ISO week: which week of the cycle is the current one ----
 * Backend: week_index = date.isocalendar()[1] % cycle_weeks */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}
export function currentWeekIndex(cycleWeeks) {
  return isoWeek(new Date()) % Math.max(1, cycleWeeks || 1);
}

/* ---- Google-Docs-style colour palette (local port of prototype GD_PALETTE) ---- */
function gdHexFromHSL(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return ('#' + f(0) + f(8) + f(4)).toUpperCase();
}
const GD_HUES = [0, 22, 45, 90, 140, 175, 205, 230, 265, 300];
export const GD_PALETTE = (() => {
  const rows = [];
  rows.push(['#000000', '#434343', '#666666', '#999999', '#B7B7B7', '#CCCCCC', '#D9D9D9', '#EFEFEF', '#F3F3F3', '#FFFFFF']);
  rows.push(GD_HUES.map((h) => gdHexFromHSL(h, 78, 50)));
  [92, 84, 74].forEach((l) => rows.push(GD_HUES.map((h) => gdHexFromHSL(h, 70, l))));
  [40, 30, 20].forEach((l) => rows.push(GD_HUES.map((h) => gdHexFromHSL(h, 65, l))));
  return rows;
})();

/* ---- misc ---- */
export const inputCss = {
  border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5,
  padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: '100%',
  boxSizing: 'border-box',
};

export function opName(o) { return `${o.first_name} ${o.last_name}`.trim(); }

/** € for revenue/cost figures: 0 must read "€0", not fmtEur's "Gratis"/"Free". */
export function eur(v, lang) {
  return '€' + (Number(v) || 0).toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT');
}

/** derive the today-status pill from OperatorStatusOut (port of staffTodayStatus) */
export function todayStatus(op, t, lang) {
  if (op.absence_type) {
    const meta = AVAIL_META[op.absence_type] || AVAIL_META.off;
    return { key: op.absence_type, label: meta[lang === 'en' ? 'en' : 'it'], color: meta.c, bg: meta.bg, hours: '' };
  }
  if (op.on_shift && (op.windows || []).length) {
    const m = AVAIL_META.work;
    return { key: 'work', label: m[lang === 'en' ? 'en' : 'it'], color: m.c, bg: m.bg, hours: fmtWindows(op.windows) };
  }
  const m = AVAIL_META.off;
  return { key: 'off', label: m[lang === 'en' ? 'en' : 'it'], color: m.c, bg: m.bg, hours: '' };
}

export function svcLabel(s, lang) { return lang === 'en' ? (s.name_en || s.name_it) : s.name_it; }
