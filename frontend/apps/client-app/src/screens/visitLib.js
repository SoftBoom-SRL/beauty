// visitLib.js — regole sulle visite della cliente (logica pura, senza React:
// la usano lib.jsx e Prenota, e i test la provano da sola).
import { parseISO } from '@youty/shared';

/** Scadenza della caparra da versare, in ms (null se non c'è). */
export function depositDueMs(appt) {
  if (!appt || appt.deposit_status !== 'required' || !appt.deposit_due_at) return null;
  const ms = new Date(appt.deposit_due_at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** La caparra è ancora da pagare ma il tempo per farlo è finito: l'orario
 *  non è più tenuto. Il «Paga ora» restava e apriva il link vecchio: il
 *  pagamento arrivava dopo il rilascio e finiva in un rimborso, mentre il
 *  ritorno nell'app diceva «Ci vediamo in salone» (16-05). */
export function depositExpired(appt, now = Date.now()) {
  const due = depositDueMs(appt);
  return due != null && due <= now;
}

/** Minuti di un servizio del listino pubblico: lavoro + posa (contratto C4).
 *  L'app chiamava «Durata» il solo lavoro: colore 60' + 40' di posa si
 *  leggeva «1h», e l'agenda la teneva 1h 40' (09-07). Senza `soak_min` (backend
 *  vecchio) resta la sola durata. */
export function svcMinutes(sv) {
  return (Number(sv?.duration_min) || 0) + (Number(sv?.soak_min) || 0);
}

/** Durata di un appuntamento della cliente: dall'inizio alla fine, che nel
 *  backend comprende lavoro e posa di ogni servizio (Appointment.end). La somma
 *  delle sole durate dei servizi lasciava fuori la posa (09-07). */
export function apptMinutes(appt) {
  const span = (parseISO(appt?.end) - parseISO(appt?.start)) / 60000;
  if (Number.isFinite(span) && span > 0) return Math.round(span);
  return (appt?.services || []).reduce((sum, x) => sum + svcMinutes(x), 0);
}
