// Il denaro della cassa: carrello (POS) e check-out devono arrivare al
// centesimo allo stesso totale del server — Decimal con ROUND_HALF_UP in
// backend/apps/sales/services.py `line_amount` e nello sconto del buono di
// backend/apps/marketing/coupons.py `coupon_discount`. In virgola mobile la
// cassa arrotondava per difetto i mezzi centesimi e la vendita tornava 422
// «I pagamenti non corrispondono al totale» (caccia del 22/09: 05-09, 14-04,
// 17-02); con la caparra più alta del conto «Incassa» restava spento (14-02,
// 05-15, 17-03); il precompilato spendeva una seconda gift card «a
// trattamento» su altri servizi (07-12).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  centsToApi, couponDiscountCents, giftPrefillRows, lineCents, paymentsError, resolvePayments,
  saleTotals, toCents,
} from '../src/sections/pos/money.js';

const t = (it) => it;
const product = (unit_price, discount_pct = 0, qty = 1) => ({ line_type: 'product', unit_price, discount_pct, qty, is_gift: false });

test('riga scontata: centesimi HALF_UP come line_amount del server', () => {
  // i casi dei rapporti: il vecchio calcolo dava 9,99 · 16,06 · 8,07 · 8,92 · 8,99 · 18,27
  assert.equal(lineCents(product(19.99, 50)), 1000);
  assert.equal(lineCents(product(18.90, 15)), 1607);
  assert.equal(lineCents(product(9.50, 15)), 808);
  assert.equal(lineCents(product(10.50, 15)), 893);
  assert.equal(lineCents(product(17.99, 50)), 900);
  assert.equal(lineCents(product('21.50', 15)), 1828);
  // si arrotonda l'INTERA riga, non il prezzo unitario: 3 × 18,90 −15% = 48,195 → 48,20
  assert.equal(lineCents(product(18.90, 15, 3)), 4820);
  // prezzo come arriva dall'API (stringa) o già numero: stesso importo
  assert.equal(lineCents(product('18.90', 15)), lineCents(product(18.9, 15)));
  assert.equal(lineCents({ ...product(40), is_gift: true }), 0);
  assert.equal(lineCents({ line_type: 'gift_card', value: 50.5 }), 5050);
});

test('conto POS con sconto vendita: il totale è quello del server', () => {
  // 18,90 e 9,50 al 15%: la cassa diceva 24,13, il server 24,15 → 422
  assert.equal(saleTotals([product(18.90, 15), product(9.50, 15)], null).totalCents, 2415);
  // 9,50 + 10,50 al 15%: 16,99 contro 17,01
  assert.equal(saleTotals([product(9.50, 15), product(10.50, 15)], null).totalCents, 1701);
  // shampoo 19,99 e balsamo 17,99 al 50%: 18,98 contro 19,00
  assert.equal(saleTotals([product(19.99, 50), product(17.99, 50)], null).totalCents, 1900);
});

test('buono: percentuale HALF_UP sull’imponibile senza gift card, mai oltre il conto', () => {
  assert.equal(couponDiscountCents({ kind: 'percent', value: '15.00' }, 1450), 218);  // 2,175 → 2,18
  assert.equal(couponDiscountCents({ kind: 'percent', value: '12.50' }, 3333), 417);  // 4,16625 → 4,17
  assert.equal(couponDiscountCents({ kind: 'amount', value: '50.00' }, 3000), 3000);  // un buono da 50 su 30 sconta 30
  assert.equal(couponDiscountCents(null, 3000), 0);
  assert.equal(couponDiscountCents({ kind: 'amount', value: '10.00' }, 0), 0);
  // la gift card venduta resta fuori dall'imponibile del buono
  const tot = saleTotals([product(14.50), { line_type: 'gift_card', value: 100 }], { kind: 'percent', value: '15.00' });
  assert.equal(tot.couponBaseCents, 1450);
  assert.equal(tot.discountCents, 218);
  assert.equal(tot.totalCents, 10000 + 1450 - 218);
});

test('importi digitati e verso l’API: mai un float', () => {
  assert.equal(toCents('12,50'), 1250);
  assert.equal(toCents('12.5'), 1250);
  assert.equal(toCents('0,285'), 29);         // HALF_UP sul terzo decimale scritto
  assert.equal(toCents(16.065), 1607);         // il float 16,06499… vale il decimale che rappresenta
  assert.equal(toCents(''), 0);
  assert.equal(toCents('abc'), 0);
  assert.equal(toCents(undefined), 0);
  assert.equal(centsToApi(1607), '16.07');
  assert.equal(centsToApi(5), '0.05');
  assert.equal(centsToApi(0), '0.00');
  assert.equal(centsToApi(-1234), '-12.34');
});

test('pagamenti: la tolleranza è quella del server, ±1 centesimo', () => {
  const split = (a, b) => ({ split: true, method: 'cash', giftCode: '', rows: [{ method: 'cash', amt: a, code: '' }, { method: 'card', amt: b, code: '' }] });
  assert.equal(paymentsError(split('10,00', '6,07'), 1607, t), null);
  assert.equal(paymentsError(split('10,00', '6,06'), 1607, t), null);   // 1 centesimo: il server lo accetta
  assert.equal(paymentsError(split('10,00', '6,05'), 1607, t), 'La somma dei pagamenti non corrisponde al totale');
  // pagamento unico: parte esattamente il dovuto
  assert.deepEqual(resolvePayments({ split: false, method: 'card', giftCode: '', rows: [] }, 1607), [{ method: 'card', amount: '16.07' }]);
  assert.deepEqual(resolvePayments(split('10', '6,07'), 1607).map((p) => p.amount), ['10.00', '6.07']);
  assert.equal(
    paymentsError({ split: false, method: 'gift_card', giftCode: ' ', rows: [] }, 1607, t),
    'Inserisci il codice della gift card',
  );
});

test('caparra più alta del conto: niente pagamenti, l’eccedenza si vede (C17)', () => {
  // servizio ridotto da 100 a 20 con caparra di 50
  const tot = saleTotals([{ line_type: 'service', unit_price: '20.00', qty: 1 }], null, 5000);
  assert.equal(tot.dueCents, -3000);
  assert.equal(tot.excessCents, 3000);
  // buono 40 su 60 con caparra 30: dovuto −10
  const withCoupon = saleTotals([{ line_type: 'service', unit_price: '60.00', qty: 1 }], { kind: 'amount', value: '40.00' }, 3000);
  assert.equal(withCoupon.excessCents, 1000);
  const pay = { split: false, method: 'cash', giftCode: '', rows: [] };
  assert.deepEqual(resolvePayments(pay, tot.dueCents), []);
  assert.equal(paymentsError(pay, tot.dueCents, t), null);
  // caparra che copre il conto al centesimo: nessun pagamento da 0,00
  assert.deepEqual(resolvePayments(pay, 0), []);
});

test('gift card «a trattamento»: ogni carta paga solo il suo servizio (07-12)', () => {
  const items = [{ service_id: 1, price: '40.00' }, { service_id: 2, price: '60.00' }];
  const gifts = [{ service_id: 1, code: 'PIEGA-A', balance: '40.00' }, { service_id: 1, code: 'PIEGA-B', balance: '40.00' }];
  // Piega 40 + Colore 60 con due carte «Piega»: la seconda NON paga il colore
  assert.deepEqual(giftPrefillRows(items, gifts, 0), [
    { method: 'gift_card', amt: 40, code: 'PIEGA-A' },
    { method: 'cash', amt: 60, code: '' },
  ]);
  // due pieghe nella visita: ognuna la sua carta
  const two = [{ service_id: 1, price: '40.00' }, { service_id: 1, price: '40.00' }];
  assert.deepEqual(giftPrefillRows(two, gifts, 0).map((r) => [r.code, r.amt]), [['PIEGA-A', 40], ['PIEGA-B', 40]]);
  // il residuo parte dopo la caparra: regalo da 50 su un servizio da 50 con 30 di caparra
  assert.deepEqual(
    giftPrefillRows([{ service_id: 3, price: '50.00' }], [{ service_id: 3, code: 'RITUALE', balance: '50.00' }], 3000),
    [{ method: 'gift_card', amt: 20, code: 'RITUALE' }],
  );
  // un codice mascherato («••••1234», chi non vede la cassa) non si spende
  assert.equal(giftPrefillRows(items, [{ service_id: 1, code: '••••1234', balance: '40.00' }], 0), null);
});
