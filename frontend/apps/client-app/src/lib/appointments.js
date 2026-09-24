// appointments.js — regole sulle visite della cliente: caparra, durata, «è la
// stessa prenotazione?» e le etichette degli elenchi.
// Logica pura, senza React: la caricano anche i test con `node --test`.
import { parseISO, timeLabel, minutesOfDay } from '@youty/shared';
import { svcMinutes } from './catalog.js';
import { fmtDayMed } from './dates.js';

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

/** Durata di un appuntamento della cliente: dall'inizio alla fine, che nel
 *  backend comprende lavoro e posa di ogni servizio (Appointment.end). La somma
 *  delle sole durate dei servizi lasciava fuori la posa (09-07). */
export function apptMinutes(appt) {
  const span = (parseISO(appt?.end) - parseISO(appt?.start)) / 60000;
  if (Number.isFinite(span) && span > 0) return Math.round(span);
  return (appt?.services || []).reduce((sum, x) => sum + svcMinutes(x), 0);
}

const sortedIds = (ids) => ids.map(Number).sort((a, b) => a - b).join(',');

/** L'appuntamento `appt` (dall'elenco della cliente) è proprio quello tentato:
 *  stesso inizio E stessi servizi, e non annullato. Col solo orario, un taglio
 *  già fissato alle 10:00 passava per la manicure appena tentata alle 10:00 e
 *  compariva «Fatto!» per una prenotazione che non esisteva (16-08). */
export function sameBooking(appt, startIso, serviceIds) {
  if (!appt || appt.status === 'cancelled') return false;
  if (new Date(appt.start).getTime() !== new Date(startIso).getTime()) return false;
  const booked = (appt.services || []).map((s) => s.service_id);
  return sortedIds(booked) === sortedIds(serviceIds || []);
}

/** "Gio 14 nov 2026" full date + time meta for lists. */
export function fmtApptDate(iso, lang) {
  return fmtDayMed(iso, lang);
}

export function apptTime(iso) { return timeLabel(minutesOfDay(iso)); }

/** Durata di un appuntamento dell'elenco: lavoro + posa (vedi apptMinutes). */
export function apptDur(appt) {
  return apptMinutes(appt);
}

export function apptServiceNames(appt) {
  return (appt.services || []).map((s) => s.name).join(' + ');
}
