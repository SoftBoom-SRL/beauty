// lib.js — agenda section helpers (grid math, ISO building, waitlist ranking)
import { ApiError, fmtEur, minutesOfDay, parseISO, timeLabel, toDateStr } from '@youty/shared';

export const DK_START = 8 * 60;   // grid 08:00
export const DK_END = 20 * 60;    // grid 20:00
export const PXM = 1.35;          // px per minute
export const COLW = 158;          // min operator column width

export const MONTHS_IT = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
export const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DOW_IT = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
export const DOW_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* ---- appointment helpers (day/week payload objects) ---- */
export const aStartMin = (a) => minutesOfDay(a.start);
export const aDur = (a) => a.total_duration_min ?? a.duration_min ?? 0;
export const aEndMin = (a) => aStartMin(a) + aDur(a);
export const svcLabel = (a) => (a.items || []).map((i) => i.service_name).join(' + ');
export const firstName = (full) => String(full || '').split(' ')[0];
export const lastName = (full) => String(full || '').trim().split(/\s+/).slice(1).join(' ');

/** Nome da mostrare in agenda: solo nome di battesimo; in caso di omonimia tra le
 *  operatrici (`firsts` = pool di nomi) aggiunge l'iniziale del cognome ("Giulia V.").
 *  Il nome completo resta per l'hover (title). */
export function opDisplay(first, last, firsts) {
  const f = String(first || '');
  const clash = (firsts || []).filter((x) => String(x || '').toLowerCase() === f.toLowerCase()).length > 1;
  return clash && last ? `${f} ${String(last)[0].toUpperCase()}.` : f;
}
export const initialsOf = (full) =>
  String(full || '').split(' ').filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

/** €-format that never says "Gratis" for zero sums */
export const fmtMoney = (n, lang) => (Number(n) ? fmtEur(Number(n), lang) : '€0');

/** Espande un appuntamento in blocchi per-servizio concatenati dallo `start`.
 *  Ogni servizio è un blocco nella colonna della sua operatrice, con orario e
 *  durata propri (la catena riflette chi fa cosa e quando). Ritorna:
 *  [{ item, appt, apptId, startMin, dur, opId, order, index, isFirst, isLast }] */
export function itemBlocks(appt) {
  const base = aStartMin(appt);
  const items = [...(appt.items || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  let cursor = base;
  return items.map((item, i) => {
    const activeMin = item.duration_min || 0;   // fase attiva (operatrice al lavoro)
    const soakMin = item.soak_min || 0;          // fase di posa (operatrice non impegnata)
    const dur = activeMin + soakMin;             // durata totale per il cliente
    const block = {
      item, appt, apptId: appt.id, startMin: cursor, dur, activeMin, soakMin,
      opId: item.operator_id, order: item.order ?? i, index: i,
      isFirst: i === 0, isLast: i === items.length - 1,
    };
    cursor += dur;
    return block;
  });
}

/** "YYYY-MM-DD" + minutes-of-day → local ISO8601 with offset ("2026-07-06T10:30:00+02:00") */
export function isoAtMin(dateStr, minutes) {
  const d = parseISO(dateStr);
  d.setHours(0, minutes, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
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

/** ApiError → toast, with network fallback */
export function toastErr(err, t, fireToast) {
  if (err instanceof ApiError) fireToast({ msg: err.message, icon: 'alert' });
  else fireToast({ msg: t('Errore di rete', 'Network error'), icon: 'alert' });
}

/** "HH:MM" → minutes of day (shift windows come as [["09:00","13:00"], ...]) */
export function hmToMin(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** pack overlapping blocks into side-by-side lanes (week view) — blocks need startMin/endMin */
export function weekLayout(list) {
  const sorted = list.map((a) => ({ ...a })).sort((x, y) => x.startMin - y.startMin || y.endMin - x.endMin);
  const out = [];
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const laneEnds = [];
    cluster.forEach((a) => {
      let l = laneEnds.findIndex((e) => e <= a.startMin);
      if (l === -1) { l = laneEnds.length; laneEnds.push(a.endMin); } else laneEnds[l] = a.endMin;
      a._lane = l;
    });
    const lc = Math.max(1, laneEnds.length);
    cluster.forEach((a) => { a._laneCount = lc; out.push(a); });
    cluster = [];
  };
  sorted.forEach((a) => {
    if (cluster.length && a.startMin >= clusterEnd) { flush(); clusterEnd = -1; }
    cluster.push(a);
    clusterEnd = Math.max(clusterEnd, a.endMin);
  });
  flush();
  return out;
}

/* ---- waitlist helpers ---- */

/** label for a WaitlistOut preference */
export function prefLabel(w, t) {
  const days = (w.exact_days || []).map((d) => t(DOW_IT[d], DOW_EN[d])).join(', ');
  switch (w.preference) {
    case 'morning': return t('Mattina', 'Morning');
    case 'afternoon': return t('Pomeriggio', 'Afternoon');
    case 'weekend': return t('Weekend', 'Weekend');
    case 'exact': return [days, w.exact_time ? String(w.exact_time).slice(0, 5) : ''].filter(Boolean).join(' · ') || t('Giorni precisi', 'Exact days');
    default: return t('Qualsiasi orario', 'Any time');
  }
}

/** entries matching a freed appointment: same service + compatible operator, still active */
export function wlMatches(waitlist, appt) {
  const svcIds = (appt.items || []).map((i) => i.service_id);
  return (waitlist || []).filter((w) =>
    w.status === 'active' &&
    svcIds.includes(w.service_id) &&
    (w.operator_id == null || w.operator_id === appt.operator_id)
  );
}

/** rank waitlist entries for a freed slot (service match assumed) */
export function wlRank(entries, appt) {
  const hour = Math.floor(aStartMin(appt) / 60);
  const dow = (parseISO(appt.start).getDay() + 6) % 7;
  const score = (w) => {
    let s = 10;
    if (w.operator_id != null && w.operator_id === appt.operator_id) s += 5;
    if (w.preference === 'morning' && hour < 13) s += 4;
    else if (w.preference === 'afternoon' && hour >= 13) s += 4;
    else if (w.preference === 'weekend' && dow >= 5) s += 4;
    else if (w.preference === 'exact' && (w.exact_days || []).includes(dow)) s += 4;
    else if (w.preference === 'any') s += 2;
    const days = Math.max(0, (Date.now() - new Date(w.created_at).getTime()) / 86400000);
    s += Math.min(days * 0.3, 5);
    return s;
  };
  return [...entries].sort((a, b) => score(b) - score(a));
}

/** days on the waiting list (from created_at) */
export function wlDaysWaiting(w) {
  return Math.max(0, Math.floor((Date.now() - new Date(w.created_at).getTime()) / 86400000));
}

/** WhatsApp suggestion copy for a freed slot (display only — Yourang sends) */
export function wlWhatsAppMsg(w, appt, lang, salonName) {
  const name = firstName(w.client_name);
  const slot = timeLabel(aStartMin(appt)) + '–' + timeLabel(aEndMin(appt));
  const svc = w.service_name;
  if (lang === 'en') return `Hi ${name}, a slot just opened up for ${svc} at ${slot}. Would you like to book it? 💜 ${salonName || ''}`.trim();
  return `Ciao ${name}, si è liberato un posto per ${svc} alle ${slot}. Ti interessa prenotarlo? 💜 ${salonName || ''}`.trim();
}
