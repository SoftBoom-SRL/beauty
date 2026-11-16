// movements.js — lo storico della carta (GET /gift-cards/{id}/movements) e la
// modifica manuale del saldo (POST /gift-cards/{id}/adjust). Il saldo della
// «carta VIP» non si poteva correggere senza passare dalla cassa (Beauty
// Boutique, 11/2026). Logica pura, provata da npm test (test/fedelta.test.js).
import { centsToApi, toCents } from '../pos/money.js';

/** Corpo della modifica: `mode` 'add' | 'remove' | 'set', `amt` come digitato,
 *  `note` il motivo. → { body } oppure { error } (messaggio già tradotto). */
export function adjustBody(mode, amt, note, t) {
  const cents = toCents(amt);
  const why = (note || '').trim();
  if (mode !== 'set' && !(cents > 0)) return { error: t('Indica l’importo', 'Enter the amount') };
  if (mode === 'set' && String(amt ?? '').trim() === '') return { error: t('Indica il saldo nuovo', 'Enter the new balance') };
  if (!why) return { error: t('Scrivi il motivo della modifica', 'Write the reason for the change') };
  if (mode === 'set') return { body: { new_balance: centsToApi(cents), note: why } };
  return { body: { amount: centsToApi(mode === 'remove' ? -cents : cents), note: why } };
}

/** Il nome di un movimento a video. */
export function movementLabel(m, t) {
  switch (m.kind) {
    case 'issued': return t('Emissione', 'Issued');
    case 'load': return t('Carico in cassa', 'Loaded at the desk');
    case 'use': return t('Utilizzo', 'Used');
    case 'adjust': return t('Modifica manuale', 'Manual change');
    case 'cancel': return t('Annullata', 'Cancelled');
    default: return m.kind;
  }
}
