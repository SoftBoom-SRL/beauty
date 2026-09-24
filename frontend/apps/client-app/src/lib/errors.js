// errors.js — i messaggi d'errore dell'app cliente che non sono il semplice
// toast dell'API (quello è toastApiError di @youty/shared).
// Logica pura, senza React: la caricano anche i test con `node --test`.

/** Il 409 di chi prenota o sposta: l'orario scelto l'ha appena preso
 *  qualcun'altra. Stesso toast in Prenota e in Sposta. */
export function toastSlotTaken(fireToast, t) {
  fireToast({ msg: t('Questo orario è appena stato preso: scegline un altro.', 'That time was just taken: pick another.'), icon: 'alert' });
}
