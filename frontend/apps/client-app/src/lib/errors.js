// errors.js — come l'app cliente mostra gli errori dell'API.
// Logica pura, senza React: la caricano anche i test con `node --test`.

/** Uniform ApiError → toast: il messaggio del server se una risposta è
 *  arrivata, altrimenti «Errore di rete». È toastApiError di @youty/shared,
 *  stessi argomenti (err, fireToast, t). */
export { toastApiError as errToast } from '@youty/shared';

/** Il 409 di chi prenota o sposta: l'orario scelto l'ha appena preso
 *  qualcun'altra. Stesso toast in Prenota e in Sposta. */
export function toastSlotTaken(fireToast, t) {
  fireToast({ msg: t('Questo orario è appena stato preso: scegline un altro.', 'That time was just taken: pick another.'), icon: 'alert' });
}
