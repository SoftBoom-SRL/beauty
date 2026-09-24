// lib/slots.js — dove si può mettere un appuntamento: il perché di uno slot
// libero o no (le regole del server sui dati in pagina), e dove porta uno
// spostamento («Sposta qui», l'ombra dell'appuntamento aperto).
// Logica pura: la caricano anche i test con `node --test`.
import { timeLabel } from '@youty/shared';
import { aStartMin, firstName, itemBlocks } from './appt.js';
import { hmToMin } from './calendar.js';

/** Vero quando uno spostamento non muove niente (stesso orario, stessa
 *  operatrice): si esce prima di chiamare il server.
 *
 *  `from` va passato ESPLICITO da chi rimanda un appuntamento indietro
 *  («Annulla»): quel percorso ha in mano l'oggetto di prima dello spostamento,
 *  e confrontando il ritorno con `appt.start` il movimento sembrava un
 *  non-movimento — l'annullamento non partiva e l'appuntamento restava dove
 *  era stato spostato, senza dire niente.
 *
 *  Conta anche il GIORNO (`toDate` contro `from.date`, "YYYY-MM-DD"): «Sposta
 *  qui» sull'ombra di un altro giorno arriva proprio con la stessa ora e la
 *  stessa colonna, e confrontando solo quelle la cliente di martedì alle 10
 *  che chiedeva «giovedì, stessa ora» restava a martedì — nessuna richiesta,
 *  nessun avviso. Senza date si confrontano solo ora e operatrice. */
export const moveIsNoop = (startMin, opId, from, toDate = null) =>
  startMin === undefined || (
    startMin === from.startMin && opId === from.opId
    && (toDate == null || from.date == null || toDate === from.date)
  );

/** Servizio dell'ombra sotto il punto (colonna `opId`, minuto `minute`), o null.
 *  L'ombra è l'appuntamento aperto nel pannello disegnato su un altro giorno:
 *  un riquadro per servizio, ognuno nella colonna di chi lo fa. */
export function ghostBlockAt(ghost, opId, minute) {
  if (!ghost || minute == null) return null;
  return itemBlocks(ghost).find((b) => b.opId === opId && minute >= b.startMin && minute < b.startMin + Math.max(b.dur, 1)) || null;
}

/** Dove porta «Sposta qui»: { startMin, opId, fromOp }.
 *  - clic sull'ombra (`slot.ghostHit`): stesso orario e stesse operatrici, cambia
 *    solo il giorno. Col clic sull'ombra della piega (11:00, Giulia) la visita
 *    partiva alle 11:00 e i servizi di Anna passavano a Giulia: l'ombra diceva
 *    «qui» e l'appuntamento finiva altrove, con un'altra operatrice;
 *  - clic su uno spazio libero: la visita parte all'ora cliccata e i servizi
 *    dell'operatrice principale passano alla colonna cliccata (quelli affidati
 *    alle colleghe restano loro, spostati dello stesso tanto). */
export function moveHereTarget(appt, slot) {
  if (slot.ghostHit) return { startMin: aStartMin(appt), opId: appt.operator_id, fromOp: appt.operator_id };
  return { startMin: slot.startMin, opId: slot.opId, fromOp: appt.operator_id };
}

/* ---- Spiegazione della disponibilità di uno slot (lato client) --------------
 * Replica le regole di apps/agenda/services/ (occupancy.py, availability.py)
 * sui dati già in pagina (righe di GET /api/agenda/day): finestre di turno,
 * appuntamenti (fase attiva + posa) e pause dell'operatrice. Serve a dire PRIMA
 * di provare — e non dopo un 409 — perché in quel punto non si può inserire o
 * spostare un appuntamento.
 *
 * row      : { operator, windows, appointments, pauses }   (una riga del giorno)
 * startMin : inizio richiesto (minuti da mezzanotte), durMin: durata totale
 * opts     : { excludeApptId, nowMin (solo se la data è oggi), t, rows }
 *
 * `rows` = tutte le righe del giorno. Serve perché un appuntamento è elencato
 * nella riga dell'operatrice PRINCIPALE, ma i suoi servizi possono essere
 * eseguiti da altre: senza guardare anche le altre righe, un orario in cui
 * l'operatrice sta lavorando dentro la visita di una collega risultava
 * «Disponibile», e il server rispondeva 409 dopo il clic.
 *
 * Ritorna { ok, code, label, detail } con code ∈
 *   ok | past | off | closed | pause | busy | soak
 * `soak` è ok=true con avviso: sovrapposizione alla posa altrui (ammessa a mano).
 */
export function explainSlot(row, startMin, durMin, opts = {}) {
  // `excludeItemId`: serve allo stacco, dove si muove UN servizio solo. Gli
  // altri della stessa visita restano dov'erano e occupano davvero quel tempo,
  // quindi non si può escludere l'intero appuntamento come in uno spostamento.
  // `sameClientId`: i trattamenti della STESSA cliente non si fanno concorrenza.
  // Nail art sopra la manicure in posa è una seduta sola, non uno scontro di
  // agenda: segnalarla come «occupata» costringeva a forzare un incastro che
  // incastro non è.
  const { excludeApptId = null, excludeItemId = null, excludePauseId = null, nowMin = null, sameClientId = null, t = (it) => it, rows = null } = opts;
  const endMin = startMin + Math.max(durMin || 0, 1);
  const win = (row?.windows || []).map(([a, b]) => [hmToMin(a), hmToMin(b)]).sort((x, y) => x[0] - y[0]);
  const winLabel = win.map(([a, b]) => `${timeLabel(a)}–${timeLabel(b)}`).join(' · ');

  if (nowMin != null && startMin < nowMin) {
    return { ok: false, code: 'past', label: t('Orario passato', 'Time already passed'), detail: '' };
  }
  if (!win.length) {
    return { ok: false, code: 'off', label: t('Non in turno oggi', 'Not on shift today'), detail: '' };
  }
  const inside = win.find(([a, b]) => a <= startMin && endMin <= b);
  if (!inside) {
    const starts = win.find(([a, b]) => a <= startMin && startMin < b);
    if (starts) {
      return {
        ok: false, code: 'closed',
        label: t(`Sfora la fine del turno (${timeLabel(starts[1])})`, `Runs past the end of the shift (${timeLabel(starts[1])})`),
        detail: t('Turno', 'Shift') + ' ' + winLabel,
      };
    }
    return { ok: false, code: 'closed', label: t('Fuori turno', 'Off shift'), detail: t('Turno', 'Shift') + ' ' + winLabel };
  }
  for (const p of row.pauses || []) {
    if (excludePauseId != null && p.id === excludePauseId) continue;
    const ps = aStartMin(p), pe = ps + (p.duration_min || 0);
    if (ps < endMin && pe > startMin) {
      return { ok: false, code: 'pause', label: t(`In pausa fino alle ${timeLabel(pe)}`, `On a break until ${timeLabel(pe)}`), detail: p.note || '' };
    }
  }
  let soakHit = null;
  // Gli appuntamenti di TUTTE le righe, non solo di questa: un servizio di
  // questa operatrice può vivere dentro la visita di una collega.
  const seen = new Set();
  const candidates = [];
  for (const source of (rows && rows.length ? rows : [row])) {
    for (const a of source?.appointments || []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      candidates.push(a);
    }
  }
  for (const a of candidates) {
    if (excludeApptId != null && a.id === excludeApptId) continue;
    if (sameClientId != null && a.client?.id === sameClientId) continue;
    if (a.status === 'cancelled' || a.status === 'no_show') continue;
    for (const b of itemBlocks(a)) {
      if (excludeItemId != null && b.item.id === excludeItemId) continue;
      if (b.opId !== row.operator?.id) continue;
      const activeEnd = b.startMin + b.activeMin;
      if (b.startMin < endMin && activeEnd > startMin) {
        return {
          ok: false, code: 'busy',
          label: t(`Occupata fino alle ${timeLabel(activeEnd)}`, `Busy until ${timeLabel(activeEnd)}`),
          detail: `${a.client?.full_name || ''} · ${b.item.service_name}`.trim(),
        };
      }
      if (b.soakMin && activeEnd < endMin && activeEnd + b.soakMin > startMin) soakHit = { a, until: activeEnd + b.soakMin };
    }
  }
  if (soakHit) {
    return {
      ok: true, code: 'soak',
      label: t(`Posa di ${firstName(soakHit.a.client?.full_name)} fino alle ${timeLabel(soakHit.until)}`, `${firstName(soakHit.a.client?.full_name)}'s soak until ${timeLabel(soakHit.until)}`),
      detail: t('Sovrapposizione consentita', 'Overlap allowed'),
    };
  }
  return { ok: true, code: 'ok', label: t('Disponibile', 'Available'), detail: '' };
}
