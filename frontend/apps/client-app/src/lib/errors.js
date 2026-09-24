// errors.js — come l'app cliente mostra gli errori dell'API.
// Logica pura, senza React: la caricano anche i test con `node --test`.

/** Uniform ApiError → toast: il messaggio del server se una risposta è
 *  arrivata, altrimenti «Errore di rete». È toastApiError di @youty/shared,
 *  stessi argomenti (err, fireToast, t). */
export { toastApiError as errToast } from '@youty/shared';
