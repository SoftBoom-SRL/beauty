// lines.js — le righe del conto della cassa: come nascono (check-out di un
// appuntamento in SellModal, vendita al banco in CartTab), che sconto portano
// e come partono verso l'API. Logica pura, provata da npm test
// (apps/dashboard/test/pos-lines.test.js). La `key` di una riga aggiunta al
// banco la sceglie chi chiama (con Date.now(), fuori da qui).
import { fmtEur, nameIn } from '@youty/shared';
import { centsToApi, toCents } from './money.js';

/* ---- check-out (SellModal) ----
 * { key, operator_id, line_type, service_id | product_id, name, unit_price, qty,
 *   discount_pct, is_gift, extra, value?, recipient_name? }
 * `extra`: aggiunta al banco, si può togliere; le righe dell'appuntamento no. */
export const apptItemLine = (it, i) => ({
  key: 'ai' + (it.id ?? i) + '_' + i,
  operator_id: it.operator_id,
  line_type: 'service',
  service_id: it.service_id,
  name: it.service_name,
  unit_price: Number(it.price),
  qty: 1, discount_pct: 0, is_gift: false, extra: false,
});
export const checkoutProductLine = (key, opId, p) => ({
  key, operator_id: opId,
  line_type: 'product', product_id: p.id, name: p.name, unit_price: Number(p.sale_price),
  qty: 1, discount_pct: 0, is_gift: false, extra: true,
});
export const checkoutServiceLine = (key, opId, s, lang) => ({
  key, operator_id: opId,
  line_type: 'service', service_id: s.id, name: nameIn(s, lang), unit_price: Number(s.price),
  qty: 1, discount_pct: 0, is_gift: false, extra: true,
});
export const checkoutGiftLine = (key, opId, value, recipientName, lang) => ({
  key, operator_id: opId, line_type: 'gift_card',
  name: giftLineName(value, lang), value, recipient_name: (recipientName || '').trim(),
  qty: 1, discount_pct: 0, is_gift: false, extra: true,
});
/** Sconto che parte per una riga del check-out: niente sugli omaggi. */
export const checkoutDiscountPct = (l) => (l.is_gift ? 0 : (l.discount_pct || 0));

/* ---- vendita al banco (CartTab) ----
 * { key, line_type: 'product' | 'gift_card', product_id, name, unit_price, qty,
 *   is_gift, disc, stock | value, recipient_name }
 * `disc`: lo sconto della riga; senza, vale quello sulla vendita. */
export const counterProductLine = (key, p, stock) => ({
  key, line_type: 'product', product_id: p.id,
  name: p.name, unit_price: Number(p.sale_price), qty: 1, is_gift: false, disc: 0, stock,
});
export const counterGiftLine = (key, value, recipientName, lang) => ({
  key, line_type: 'gift_card', name: giftLineName(value, lang),
  value, recipient_name: recipientName.trim(), qty: 1, is_gift: false, disc: 0,
});
/** Sconto che parte per una riga del banco: quello della riga, altrimenti
 *  quello sulla vendita; niente su gift card e omaggi. */
export const counterDiscountPct = (l, saleDisc) => (l.line_type !== 'product' || l.is_gift ? 0 : (l.disc > 0 ? l.disc : saleDisc || 0));

/* Il nome a video di una gift card venduta, con l'importo scritto come ogni
 * prezzo nella lingua dell'interfaccia (fmtEur): era il numero così com'è, e
 * 12,50 € si leggeva «€12.5», 1.000 € «€1000», nella riga del carrello e del
 * check-out (voce 41). Solo a video: il nome non va al server. Il valore è
 * sempre maggiore di zero (lo controllano check-out e banco), quindi mai
 * «Gratis». */
export const giftLineName = (value, lang) => 'Gift card · ' + fmtEur(value, lang);

/** Riga → riga dell'API (checkout e vendita al banco). Si spedisce esattamente
 *  il prezzo da cui si è calcolato il conto; `discountPct` è la regola del
 *  chiamante (checkoutDiscountPct o counterDiscountPct). Le gift card portano
 *  solo valore e destinataria. */
export function toApiLine(l, discountPct) {
  if (l.line_type === 'gift_card') {
    return { line_type: 'gift_card', value: centsToApi(toCents(l.value)), ...(l.recipient_name ? { recipient_name: l.recipient_name } : {}) };
  }
  return {
    line_type: l.line_type,
    ...(l.line_type === 'service' ? { service_id: l.service_id } : { product_id: l.product_id }),
    qty: l.qty, unit_price: centsToApi(toCents(l.unit_price)),
    discount_pct: discountPct, is_gift: !!l.is_gift,
  };
}
