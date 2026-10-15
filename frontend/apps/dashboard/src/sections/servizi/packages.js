// packages.js — i pacchetti del listino senza React: validità e sedute.
//
// Venduto in cassa, un pacchetto diventa una carta a sedute per ogni servizio
// (le sedute sono la quantità della riga) che scade `validity_days` giorni
// dopo la vendita. Editor e schede lo dicono con le stesse parole.
// Logica pura (provata da apps/dashboard/test/crediti.test.js).

/** Giorni di validità massimi (come `MAX_PACKAGE_VALIDITY_DAYS` del server). */
export const MAX_VALIDITY_DAYS = 3650;

/** «Valido 90 giorni dalla vendita» o «Senza scadenza». */
export function validityLabel(days, t) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return t('Senza scadenza', 'No expiry');
  return n === 1
    ? t('Valido 1 giorno dalla vendita', 'Valid 1 day from purchase')
    : t(`Valido ${n} giorni dalla vendita`, `Valid ${n} days from purchase`);
}

/** Le sedute di un servizio nel pacchetto: «1 seduta», «5 sedute». */
export function sessionsText(qty, t) {
  const n = Math.max(1, Number(qty) || 1);
  return n === 1 ? t('1 seduta', '1 session') : t(`${n} sedute`, `${n} sessions`);
}

/** Il valore del campo «Valido per … giorni» da mandare: un intero, o null
 *  (vuoto = senza scadenza). */
export function validityDaysPayload(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_VALIDITY_DAYS) : null;
}
