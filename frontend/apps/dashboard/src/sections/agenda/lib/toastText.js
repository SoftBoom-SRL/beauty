// lib/toastText.js — gli avvisi dell'agenda.
// Logica pura: la caricano anche i test con `node --test`.
import { ApiError } from '@youty/shared';

/** ApiError → toast, with network fallback */
export function toastErr(err, t, fireToast) {
  if (err instanceof ApiError) fireToast({ msg: err.message, icon: 'alert' });
  else fireToast({ msg: t('Errore di rete', 'Network error'), icon: 'alert' });
}
