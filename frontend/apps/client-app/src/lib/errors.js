// errors.js — come l'app cliente mostra gli errori dell'API.
// Logica pura, senza React: la caricano anche i test con `node --test`.
import { ApiError } from '@youty/shared';

/** Uniform ApiError → toast. */
export function errToast(err, fireToast, t) {
  if (err instanceof ApiError) fireToast({ msg: err.message, icon: 'alert' });
  else fireToast({ msg: t('Errore di rete', 'Network error'), icon: 'alert' });
}
