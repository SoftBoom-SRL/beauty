// rebase.js — una bozza in modifica e una versione più nuova arrivata dal server.
//
// Le schede si aggiornano da sole quando un'altra postazione cambia gli stessi
// dati (feed live). Rimpiazzare la bozza buttava via le modifiche non salvate;
// ignorare la versione nuova faceva riscrivere al primo «Salva» i campi cambiati
// altrove nel frattempo (il colore scelto in agenda, il servizio abilitato dal
// listino). Qui si fondono le due cose campo per campo, a tre vie.

/** Uguaglianza per valori JSON (stringhe, numeri, array, oggetti semplici). */
export function sameValue(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

/**
 * Fonde `draft` (partita da `oldBase`) con `newBase`.
 * - campo non toccato nella bozza → prende il valore nuovo del server;
 * - campo toccato nella bozza → resta quello della bozza;
 * - toccato in entrambi con valori diversi → resta la bozza e il campo finisce
 *   in `conflicts`, così chi guarda la scheda può essere avvisato.
 * `equal(a, b, key)` permette confronti su misura (per esempio insiemi di id).
 */
export function rebaseDraft(draft, oldBase, newBase, equal = sameValue) {
  const next = { ...draft };
  const conflicts = [];
  Object.keys(newBase || {}).forEach((k) => {
    const mine = draft[k];
    const before = oldBase ? oldBase[k] : undefined;
    const now = newBase[k];
    if (equal(mine, before, k)) next[k] = now;
    else if (!equal(now, before, k) && !equal(now, mine, k)) conflicts.push(k);
  });
  return { draft: next, conflicts };
}
