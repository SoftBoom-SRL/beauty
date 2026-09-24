// lib/waitlist.js — la lista d'attesa davanti a uno slot liberato: chi è
// compatibile, in che ordine proporlo, che cosa scriverle.
// Logica pura: la caricano anche i test con `node --test`.
import { parseISO, timeLabel, toDateStr } from '@youty/shared';
import { aEndMin, aStartMin, firstName } from './appt.js';
import { DOW_EN, DOW_IT } from './calendar.js';

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

/** Operatrici coinvolte in una visita: quelle dei singoli servizi più la
 *  principale. È la stessa regola del backend (free_slot_event), che sulle voci
 *  di lista d'attesa guarda TUTTI gli item: qui si guardava solo l'operatrice
 *  principale, e chi aspettava un servizio con la collega che lo esegue
 *  davvero non veniva contato fra i match. */
export const apptOperatorIds = (appt) =>
  new Set([...(appt.items || []).map((i) => i.operator_id), appt.operator_id].filter((x) => x != null));

/** entries matching a freed appointment: same service + compatible operator, still active */
export function wlMatches(waitlist, appt) {
  const svcIds = (appt.items || []).map((i) => i.service_id);
  const opIds = apptOperatorIds(appt);
  return (waitlist || []).filter((w) =>
    w.status === 'active' &&
    svcIds.includes(w.service_id) &&
    (w.operator_id == null || opIds.has(w.operator_id))
  );
}

/** rank waitlist entries for a freed slot (service match assumed) */
export function wlRank(entries, appt) {
  const hour = Math.floor(aStartMin(appt) / 60);
  // Giorno della settimana sul calendario del SALONE: getDay() sull'ISO
  // dell'API legge il fuso del dispositivo, e da una postazione su un altro
  // fuso (o a cavallo della mezzanotte UTC) il venerdì sera diventava sabato —
  // «weekend» e «giorni precisi» premiavano le voci sbagliate.
  const dow = (parseISO(toDateStr(appt.start)).getDay() + 6) % 7;
  const opIds = apptOperatorIds(appt);
  const score = (w) => {
    let s = 10;
    if (w.operator_id != null && opIds.has(w.operator_id)) s += 5;
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
