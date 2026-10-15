// deposit.js — la caparra scritta dallo staff: quanto ha versato la cliente e
// come. Molti saloni la prendono fuori da beauty (bonifico o link di
// pagamento di un'altra banca come Nexi, contanti o POS alla prenotazione):
// chi prende l'appuntamento la registra, e il server la mette in cassa.
import { centsToApi, toCents } from '../../pos/money.js';

/** Come può essere arrivata. `id` è il metodo di pagamento del server. */
export const DEPOSIT_METHODS = [
  { id: 'transfer', it: 'bonifico / Nexi', en: 'transfer / Nexi' },
  { id: 'cash', it: 'contanti', en: 'cash' },
  { id: 'card', it: 'POS', en: 'card' },
];

/** Solo cifre e un separatore («30,5», «30.50»): come il campo importo della cassa. */
export function cleanAmount(raw) {
  let s = String(raw ?? '').replace(/[^0-9.,]/g, '');
  const sep = s.search(/[.,]/);
  if (sep !== -1) s = s.slice(0, sep + 1) + s.slice(sep + 1).replace(/[.,]/g, '');
  return s;
}

/** Che cosa non va nell'importo digitato: null se va bene, 'empty' se manca
 *  o è zero, 'over' se supera il totale della visita (`maxCents`): al conto
 *  la cassa dovrebbe restituire la differenza, e il server lo rifiuta. */
export function depositIssue(text, maxCents) {
  const cents = toCents(text);
  if (cents <= 0) return 'empty';
  if (maxCents != null && cents > maxCents) return 'over';
  return null;
}

/** L'importo per l'API («30.50»). */
export const depositToApi = (text) => centsToApi(toCents(text));

/** Un importo dell'API («20.00») come lo si scrive nel campo («20,00» in italiano). */
export const depositToField = (amount, lang) => {
  const s = centsToApi(toCents(amount));
  return lang === 'en' ? s : s.replace('.', ',');
};

/** L'importo è cambiato rispetto a quello chiesto? Solo allora lo si manda. */
export const sameAmount = (a, b) => toCents(a) === toCents(b);
