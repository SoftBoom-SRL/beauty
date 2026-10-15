// lines.js — le righe del conto della cassa: come nascono (check-out di un
// appuntamento in SellModal, vendita al banco in CartTab), che sconto portano
// e come partono verso l'API. Logica pura, provata da npm test
// (apps/dashboard/test/pos-lines.test.js). La `key` di una riga aggiunta al
// banco la sceglie chi chiama (con Date.now(), fuori da qui).
import { fmtEur, nameIn } from '@youty/shared';
import { centsToApi, centsToEur, toCents } from './money.js';

/* ---- check-out (SellModal) ----
 * { key, operator_id, line_type, service_id | product_id | package_id, name,
 *   unit_price, qty, discount_pct, is_gift, extra, value?, recipient_name?,
 *   kind?, gift_service_id?, sessions?, visit_id?, list_price? }
 * `extra`: aggiunta al banco, si può togliere; le righe dell'appuntamento no
 * (quelle di un'altra visita del conto unico se ne vanno togliendo la visita). */
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
/* Pacchetto di listino venduto nel conto: crea le sedute della cliente. Il
 * prezzo parte da quello del pacchetto; sconto e omaggio come i prodotti. */
export const checkoutPackageLine = (key, opId, pkg, lang) => ({
  key, operator_id: opId, line_type: 'package', package_id: pkg.id, name: packageLineName(pkg, lang),
  unit_price: Number(pkg.price), qty: 1, discount_pct: 0, is_gift: false, extra: true,
});
/* Trattamento pagato in anticipo dalla cliente: una gift card «prepaid» del
 * servizio, con le sue sedute; `value` è il prezzo di tutte. */
export const checkoutPrepaidLine = (key, opId, service, sessions, value, lang) => ({
  key, operator_id: opId, line_type: 'gift_card', kind: 'prepaid', gift_service_id: service.id, sessions,
  name: prepaidLineName(service, sessions, lang), value, recipient_name: '',
  qty: 1, discount_pct: 0, is_gift: false, extra: true,
});
/** Sconto che parte per una riga del check-out: niente sugli omaggi. */
export const checkoutDiscountPct = (l) => (l.is_gift ? 0 : (l.discount_pct || 0));

/* ---- conto unico (SellModal) ----
 * Le righe di una visita: come apptItemLine, con la visita da cui vengono
 * (`visit_id`: la spunta «Altre visite oggi» le aggiunge e le toglie insieme)
 * e il prezzo della visita (`list_price`), che il precompilato delle carte a
 * sedute cambia nel valore di una seduta e rimette quando la carta non copre
 * più la riga (visits.js). */
export const visitItemLine = (visitId, it, i) => ({
  ...apptItemLine(it, i),
  key: 'v' + visitId + '_' + (it.id ?? i) + '_' + i,
  visit_id: visitId,
  list_price: Number(it.price),
});

/* ---- vendita al banco (CartTab) ----
 * { key, line_type: 'product' | 'gift_card' | 'package', product_id | package_id, name,
 *   unit_price, qty, is_gift, disc, stock | value, recipient_name, kind?,
 *   gift_service_id?, sessions? }
 * `disc`: lo sconto della riga; senza, vale quello sulla vendita. */
export const counterProductLine = (key, p, stock) => ({
  key, line_type: 'product', product_id: p.id,
  name: p.name, unit_price: Number(p.sale_price), qty: 1, is_gift: false, disc: 0, stock,
});
export const counterGiftLine = (key, value, recipientName, lang) => ({
  key, line_type: 'gift_card', name: giftLineName(value, lang),
  value, recipient_name: recipientName.trim(), qty: 1, is_gift: false, disc: 0,
});
export const counterPackageLine = (key, pkg, lang) => ({
  key, line_type: 'package', package_id: pkg.id, name: packageLineName(pkg, lang),
  unit_price: Number(pkg.price), qty: 1, is_gift: false, disc: 0,
});
export const counterPrepaidLine = (key, service, sessions, value, lang) => ({
  key, line_type: 'gift_card', kind: 'prepaid', gift_service_id: service.id, sessions,
  name: prepaidLineName(service, sessions, lang), value, recipient_name: '', qty: 1, is_gift: false, disc: 0,
});
/** Sconto che parte per una riga del banco: quello della riga, altrimenti
 *  quello sulla vendita; niente su gift card e omaggi. I pacchetti si scontano
 *  come i prodotti (il server lo ammette; le gift card no). */
export const counterDiscountPct = (l, saleDisc) => ((l.line_type !== 'product' && l.line_type !== 'package') || l.is_gift ? 0 : (l.disc > 0 ? l.disc : saleDisc || 0));

/* Pacchetti e trattamenti già pagati diventano sedute DELLA cliente: senza
 * cliente il server rifiuta la vendita (422). Vero se nel conto ce n'è uno. */
export const needsClient = (lines) => (lines || []).some((l) => l.line_type === 'package' || l.kind === 'prepaid');

/* Il nome a video di una gift card venduta, con l'importo scritto come ogni
 * prezzo nella lingua dell'interfaccia (fmtEur): era il numero così com'è, e
 * 12,50 € si leggeva «€12.5», 1.000 € «€1000», nella riga del carrello e del
 * check-out (voce 41). Solo a video: il nome non va al server. Il valore è
 * sempre maggiore di zero (lo controllano check-out e banco), quindi mai
 * «Gratis». */
export const giftLineName = (value, lang) => 'Gift card · ' + fmtEur(value, lang);
/** «Pacchetto · Mani e piedi»: solo a video, come il nome della gift card. */
export const packageLineName = (pkg, lang) => (lang === 'en' ? 'Package · ' : 'Pacchetto · ') + (pkg?.name || '');
/** «Già pagato · Manicure × 5»: il trattamento pagato in anticipo, con le sedute se più di una. */
export const prepaidLineName = (service, sessions, lang) =>
  (lang === 'en' ? 'Prepaid · ' : 'Già pagato · ') + nameIn(service, lang) + (sessions > 1 ? ' × ' + sessions : '');
/** Il prezzo che parte per un trattamento già pagato: listino × sedute (in euro,
 *  dai centesimi). Si può cambiare: chi compra dieci sedute di solito paga meno. */
export const prepaidValue = (service, sessions) => centsToEur(toCents(service?.price || 0) * Math.max(1, Math.trunc(Number(sessions)) || 1));
/** Cosa c'è in un pacchetto, per sceglierlo: «5 × Manicure · 5 × Pedicure». */
export const packageSummary = (pkg, services, lang) => (pkg?.items || [])
  .map((it) => {
    const svc = (services || []).find((s) => s.id === it.service_id);
    return it.qty + ' × ' + (svc ? nameIn(svc, lang) : '#' + it.service_id);
  })
  .join(' · ');

/** Riga → riga dell'API (checkout e vendita al banco). Si spedisce esattamente
 *  il prezzo da cui si è calcolato il conto; `discountPct` è la regola del
 *  chiamante (checkoutDiscountPct o counterDiscountPct). Le gift card portano
 *  solo valore e destinataria, più servizio, sedute e tipo se sono «a
 *  trattamento» (un trattamento già pagato è `kind: 'prepaid'`). Il pacchetto
 *  porta il suo id: le sedute le crea il server. */
export function toApiLine(l, discountPct) {
  if (l.line_type === 'gift_card') {
    return {
      line_type: 'gift_card', value: centsToApi(toCents(l.value)),
      ...(l.recipient_name ? { recipient_name: l.recipient_name } : {}),
      ...(l.gift_service_id ? { gift_service_id: l.gift_service_id, sessions: l.sessions || 1 } : {}),
      ...(l.kind && l.kind !== 'gift' ? { kind: l.kind } : {}),
    };
  }
  if (l.line_type === 'package') {
    return {
      line_type: 'package', package_id: l.package_id,
      qty: l.qty, unit_price: centsToApi(toCents(l.unit_price)),
      discount_pct: discountPct, is_gift: !!l.is_gift,
    };
  }
  return {
    line_type: l.line_type,
    ...(l.line_type === 'service' ? { service_id: l.service_id } : { product_id: l.product_id }),
    qty: l.qty, unit_price: centsToApi(toCents(l.unit_price)),
    discount_pct: discountPct, is_gift: !!l.is_gift,
  };
}
