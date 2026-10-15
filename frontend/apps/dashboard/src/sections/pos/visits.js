// visits.js — il conto unico del check-out (SellModal): le visite nel conto, le
// loro righe, le caparre e il pagamento precompilato con le carte della
// cliente. Mani e piedi in contemporanea con due operatrici sono due
// appuntamenti, ma il conto è uno: la cassa apre quello della visita su cui si
// è cliccato e propone le «Altre visite di oggi» della cliente
// (GET /api/sales/checkout/{id}/other-visits) con una spunta. Logica pura,
// provata da npm test (apps/dashboard/test/pos-visits.test.js).
import { centsToEur, emptyPayments, giftPrefill, lineCents, toCents } from './money.js';
import { checkoutDiscountPct, visitItemLine } from './lines.js';

/** Caparra detraibile di una visita: la quota ancora in cassa (`deposit_credit`,
 *  al netto dei rimborsi già fatti), in centesimi. */
export const depositCentsOf = (appt) => toCents(appt?.deposit_credit ?? (appt?.deposit_status === 'paid' ? appt.deposit_amount : 0) ?? 0);

/** Le righe di una visita: una per servizio, con la sua operatrice. */
export const visitLines = (visit) => (visit?.items || []).map((it, i) => visitItemLine(visit.id, it, i));

/** Le carte delle visite del conto, ognuna una volta sola: le carte sono della
 *  cliente, e la stessa compare su ogni sua visita che ne ha il servizio. */
export function visitGifts(visits) {
  const seen = new Set();
  return (visits || []).flatMap((v) => v?.gifts || []).filter((g) => {
    const id = g.gift_card_id ?? g.code;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Le operatrici dei blocchi del conto, nell'ordine in cui compaiono le righe:
 *  prima quelle della visita principale, poi quelle delle visite aggiunte. */
export const blockOperatorIds = (lines) => [...new Set((lines || []).map((l) => l.operator_id))];

/**
 * Righe e pagamento del check-out per le visite `visits` (la principale per prima).
 *
 * `lines` sono le righe di adesso: quelle aggiunte al banco restano, quelle
 * delle visite tolte se ne vanno, quelle delle visite nuove arrivano in fondo
 * (le righe di una visita già nel conto restano com'erano, omaggi compresi).
 * Poi le carte della cliente ripartono da capo (giftPrefill): le righe coperte
 * da una carta a sedute prendono il valore della seduta, le altre il loro
 * prezzo, e il pagamento riparte dal dovuto nuovo — righe aggiunte al banco
 * comprese, che nessuna carta copre (le carte coprono i servizi delle visite).
 * Le caparre detraibili sono quelle di tutte le visite del conto.
 *
 * → { lines, pay, depositCents }
 */
export function checkoutState(lines, visits) {
  const list = (visits || []).filter(Boolean);
  const ids = new Set(list.map((v) => v.id));
  const kept = (lines || []).filter((l) => l.visit_id == null || ids.has(l.visit_id));
  const have = new Set(kept.map((l) => l.key));
  const all = [...kept, ...list.flatMap(visitLines).filter((l) => !have.has(l.key))];
  const depositCents = list.reduce((s, v) => s + depositCentsOf(v), 0);
  const items = all.map((l) => (l.visit_id != null
    ? { service_id: l.service_id, price: l.list_price }
    : { service_id: null, price: centsToEur(lineCents({ ...l, discount_pct: checkoutDiscountPct(l) })) }));
  const { rows, prices } = giftPrefill(items, visitGifts(list), depositCents);
  const priced = all.map((l, i) => {
    if (l.visit_id == null) return l;
    return { ...l, unit_price: prices[i] != null ? centsToEur(prices[i]) : l.list_price };
  });
  return { lines: priced, pay: rows ? { ...emptyPayments(), split: true, rows } : emptyPayments(), depositCents };
}
