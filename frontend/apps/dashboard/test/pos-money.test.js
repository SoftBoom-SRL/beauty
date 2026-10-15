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
  allocateSettlement, centsToApi, couponDiscountCents, dueLeftCents, emptyPayments, giftLabel, giftPrefill,
  giftPrefillRows, isSessionCard, lineCents, paymentsError, resolvePayments, saleTotals, toCents,
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

/* ---- conti da saldare ---- */

test('lascia da saldare: si paga una parte, il resto resta sul conto', () => {
  const v = { ...emptyPayments(), method: 'card', leaveDue: true, payNow: '40' };
  assert.deepEqual(resolvePayments(v, 10000), [{ method: 'card', amount: '40.00' }]);
  assert.equal(dueLeftCents(v, 10000), 6000);
  assert.equal(paymentsError(v, 10000, t), null);
  // niente pagato adesso: nessun pagamento, tutto da saldare
  const nothing = { ...v, payNow: '' };
  assert.deepEqual(resolvePayments(nothing, 10000), []);
  assert.equal(dueLeftCents(nothing, 10000), 10000);
  // più del dovuto resta un errore, come sul server
  assert.equal(paymentsError({ ...v, payNow: '120' }, 10000, t), 'I pagamenti superano il totale da pagare');
  // pagamento diviso: le righe possono sommare meno del dovuto
  const split = { ...emptyPayments(), split: true, leaveDue: true, rows: [{ method: 'cash', amt: '20', code: '' }, { method: 'card', amt: '30', code: '' }] };
  assert.equal(paymentsError(split, 10000, t), null);
  assert.equal(dueLeftCents(split, 10000), 5000);
  // senza «Lascia da saldare» la regola è quella di sempre
  assert.equal(dueLeftCents({ ...split, leaveDue: false }, 10000), 0);
  assert.equal(paymentsError({ ...split, leaveDue: false }, 10000, t), 'La somma dei pagamenti non corrisponde al totale');
  // un centesimo di differenza non è un debito (tolleranza del server)
  assert.equal(dueLeftCents({ ...v, payNow: '99,99' }, 10000), 0);
});

test('salda adesso: i pagamenti si ripartiscono sui conti dal più vecchio', () => {
  const dues = [{ id: 1, amount_due: '60.00' }, { id: 2, amount_due: '25.00' }];
  assert.deepEqual(allocateSettlement(dues, [{ method: 'cash', amount: '50.00' }, { method: 'card', amount: '35.00' }]), [
    { sale_id: 1, payments: [{ method: 'cash', amount: '50.00' }, { method: 'card', amount: '10.00' }] },
    { sale_id: 2, payments: [{ method: 'card', amount: '25.00' }] },
  ]);
  // una parte sola: il conto più vecchio per primo, gli altri restano aperti
  assert.deepEqual(allocateSettlement(dues, [{ method: 'card', amount: '40.00' }]), [
    { sale_id: 1, payments: [{ method: 'card', amount: '40.00' }] },
  ]);
  // la gift card porta il codice su ogni conto che paga; un saldo non porta sedute
  assert.deepEqual(allocateSettlement(dues, [{ method: 'gift_card', amount: '85.00', gift_card_code: 'GC1', sessions: 3 }]).map((s) => s.payments[0]), [
    { method: 'gift_card', amount: '60.00', gift_card_code: 'GC1' },
    { method: 'gift_card', amount: '25.00', gift_card_code: 'GC1' },
  ]);
});

/* ---- pacchetti e carte a sedute ---- */

test('pacchetto: due pezzi scontati fanno il centesimo del server (un pezzo per riga)', () => {
  // 33,33 −10% = 29,997 → 30,00 a pezzo; sull'intera riga sarebbe 59,99
  assert.equal(lineCents({ line_type: 'package', unit_price: '33.33', discount_pct: 10, qty: 2 }), 6000);
  assert.equal(lineCents({ line_type: 'package', unit_price: '450.00', qty: 1, is_gift: true }), 0);
  // il buono vale anche sui pacchetti (non sono gift card)
  assert.equal(saleTotals([{ line_type: 'package', unit_price: '100.00', qty: 1 }], { kind: 'percent', value: '10.00' }).discountCents, 1000);
});

test('carte a sedute: ogni riga coperta vale una seduta, il pagamento le conta', () => {
  const items = [{ service_id: 1, price: '30.00' }, { service_id: 1, price: '30.00' }, { service_id: 2, price: '40.00' }];
  // pacchetto da 10 manicure a 250 €: 8 sedute rimaste, 200 € di saldo
  const pkg = { service_id: 1, code: 'PKG1', balance: '200.00', kind: 'package', sessions_total: 10, sessions_left: 8, session_value: '25.00' };
  const { rows, prices } = giftPrefill(items, [pkg], 0);
  assert.deepEqual(prices, [2500, 2500, null]);
  assert.deepEqual(rows, [
    { method: 'gift_card', amt: 50, code: 'PKG1', sessions: 2 },
    { method: 'cash', amt: 40, code: '' },
  ]);
  // verso l'API il pagamento porta le sedute
  assert.deepEqual(resolvePayments({ ...emptyPayments(), split: true, rows }, 9000)[0],
    { method: 'gift_card', amount: '50.00', gift_card_code: 'PKG1', sessions: 2 });
});

test('carte a sedute: mai oltre le sedute rimaste, e l’ultima prende il resto del saldo', () => {
  const three = [1, 2, 3].map(() => ({ service_id: 1, price: '40.00' }));
  // 2 sedute rimaste su 3 righe: la terza resta a listino e si paga in contanti
  const left2 = { service_id: 1, code: 'PRE', balance: '50.01', kind: 'prepaid', sessions_total: 5, sessions_left: 2 };
  const { rows, prices } = giftPrefill(three, [left2], 0);
  // 50,01 / 2 per difetto = 25,00; l'ultima seduta prende 25,01
  assert.deepEqual(prices, [2500, 2501, null]);
  assert.deepEqual(rows, [
    { method: 'gift_card', amt: 50.01, code: 'PRE', sessions: 2 },
    { method: 'cash', amt: 40, code: '' },
  ]);
  // senza session_value lo stesso calcolo del server
  assert.deepEqual(giftPrefill([three[0]], [{ ...left2, sessions_left: 3, balance: '100.00' }], 0).prices, [3333]);
});

test('carte a sedute: un pacchetto in omaggio scala la seduta anche senza denaro', () => {
  const free = { service_id: 1, code: 'FREE', balance: '0.00', kind: 'package', sessions_total: 5, sessions_left: 5, session_value: '0.00' };
  const { rows, prices } = giftPrefill([{ service_id: 1, price: '30.00' }], [free], 0);
  assert.deepEqual(prices, [0]);
  assert.deepEqual(rows, [{ method: 'gift_card', amt: 0, code: 'FREE', sessions: 1 }]);
  // dovuto zero: nessun denaro, ma la seduta parte lo stesso
  assert.deepEqual(resolvePayments({ ...emptyPayments(), split: true, rows }, 0),
    [{ method: 'gift_card', amount: '0.00', gift_card_code: 'FREE' }]);
});

test('carte di prima (senza tipo né sedute) e regali da una seduta: come sempre', () => {
  assert.equal(isSessionCard({ service_id: 1, balance: '40.00' }), false);
  assert.equal(isSessionCard({ kind: 'gift', sessions_total: 1 }), false);
  assert.equal(isSessionCard({ kind: 'gift', sessions_total: 3 }), true);
  assert.equal(isSessionCard({ kind: 'prepaid', sessions_total: 1 }), true);
  const items = [{ service_id: 1, price: '40.00' }];
  const gift = { service_id: 1, code: 'REG', balance: '40.00', kind: 'gift', sessions_total: 1, sessions_left: 1 };
  assert.deepEqual(giftPrefill(items, [gift], 0), { rows: [{ method: 'gift_card', amt: 40, code: 'REG' }], prices: [null] });
});

test('le etichette delle carte nel check-out', () => {
  assert.equal(giftLabel({ kind: 'gift', from_name: 'Anna' }, t), 'Regalo · da Anna');
  assert.equal(giftLabel({ from_name: '' }, t), 'Regalo');
  assert.equal(giftLabel({ kind: 'prepaid', sessions_total: 1, sessions_left: 1 }, t), 'Già pagato');
  assert.equal(giftLabel({ kind: 'prepaid', sessions_total: 5, sessions_left: 3 }, t), 'Già pagato · 3 sedute rimaste');
  assert.equal(giftLabel({ kind: 'package', sessions_total: 10, sessions_left: 1 }, t), 'Pacchetto · 1 seduta rimasta');
  assert.equal(giftLabel({ kind: 'package', sessions_total: 10, sessions_left: 7 }, t), 'Pacchetto · 7 sedute rimaste');
});
