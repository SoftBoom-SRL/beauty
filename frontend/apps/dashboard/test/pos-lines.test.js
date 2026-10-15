// Righe del conto della cassa (pos/lines.js): come nascono nel check-out e al
// banco e il corpo che parte verso POST /api/sales/checkout/{id} e
// /api/sales/pos. Le attese sono quelle che SellModal e CartTab scrivevano a
// mano prima di passare da qui (refactoring del 24/09).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  apptItemLine, checkoutDiscountPct, checkoutGiftLine, checkoutPackageLine, checkoutPrepaidLine, checkoutProductLine,
  checkoutServiceLine, counterDiscountPct, counterGiftLine, counterPackageLine, counterPrepaidLine, counterProductLine,
  giftLineName, needsClient, packageSummary, prepaidValue, toApiLine, visitItemLine,
} from '../src/sections/pos/lines.js';

const item = { id: 41, operator_id: 7, service_id: 3, service_name: 'Taglio', price: '35.00' };
const shampoo = { id: 12, name: 'Shampoo', sale_price: '18.50' };
const piega = { id: 5, name_it: 'Piega', name_en: 'Blow-dry', price: '20' };

test('check-out: le righe dell’appuntamento, una per servizio, non si tolgono', () => {
  assert.deepEqual(apptItemLine(item, 0), {
    key: 'ai41_0', operator_id: 7, line_type: 'service', service_id: 3, name: 'Taglio',
    unit_price: 35, qty: 1, discount_pct: 0, is_gift: false, extra: false,
  });
  // senza id la chiave usa la posizione (due volte)
  assert.equal(apptItemLine({ ...item, id: undefined }, 2).key, 'ai2_2');
});

test('check-out: prodotto, servizio extra e gift card aggiunti al banco', () => {
  assert.deepEqual(checkoutProductLine('pl1', 7, shampoo), {
    key: 'pl1', operator_id: 7, line_type: 'product', product_id: 12, name: 'Shampoo',
    unit_price: 18.5, qty: 1, discount_pct: 0, is_gift: false, extra: true,
  });
  assert.equal(checkoutServiceLine('sl1', 7, piega, 'en').name, 'Blow-dry');
  assert.deepEqual(checkoutServiceLine('sl1', 7, piega, 'it'), {
    key: 'sl1', operator_id: 7, line_type: 'service', service_id: 5, name: 'Piega',
    unit_price: 20, qty: 1, discount_pct: 0, is_gift: false, extra: true,
  });
  assert.deepEqual(checkoutGiftLine('gl1', 7, 50, '  Anna ', 'it'), {
    key: 'gl1', operator_id: 7, line_type: 'gift_card', name: 'Gift card · €50,00', value: 50,
    recipient_name: 'Anna', qty: 1, discount_pct: 0, is_gift: false, extra: true,
  });
  assert.equal(checkoutGiftLine('gl2', 7, 50, undefined, 'it').recipient_name, '');
});

test('banco: il prodotto porta la giacenza, la gift card il destinatario', () => {
  assert.deepEqual(counterProductLine('p12_1', shampoo, 4), {
    key: 'p12_1', line_type: 'product', product_id: 12, name: 'Shampoo', unit_price: 18.5,
    qty: 1, is_gift: false, disc: 0, stock: 4,
  });
  assert.deepEqual(counterGiftLine('g1', 25, ' Bea ', 'it'), {
    key: 'g1', line_type: 'gift_card', name: 'Gift card · €25,00', value: 25, recipient_name: 'Bea',
    qty: 1, is_gift: false, disc: 0,
  });
});

test('il nome della gift card scrive l’importo come ogni prezzo, nella lingua dell’interfaccia (voce 41)', () => {
  // era il numero così com'è: «€12.5», «€1000»; ora come fmtEur scrive ogni
  // prezzo (in italiano le migliaia si separano da 10.000 in su)
  assert.equal(giftLineName(12.5, 'it'), 'Gift card · €12,50');
  assert.equal(giftLineName(1000, 'it'), 'Gift card · €1000,00');
  assert.equal(giftLineName(12.5, 'en'), 'Gift card · €12.50');
  assert.equal(giftLineName(1000, 'en'), 'Gift card · €1,000.00');
  assert.equal(checkoutGiftLine('gl3', 7, 12.5, '', 'en').name, 'Gift card · €12.50');
  assert.equal(counterGiftLine('g3', 1000, '', 'it').name, 'Gift card · €1000,00');
});

test('sconti: omaggi a zero; al banco vale quello della riga, altrimenti quello sulla vendita', () => {
  assert.equal(checkoutDiscountPct({ discount_pct: 15, is_gift: false }), 15);
  assert.equal(checkoutDiscountPct({ discount_pct: 15, is_gift: true }), 0);
  assert.equal(checkoutDiscountPct({ is_gift: false }), 0);
  const p = { line_type: 'product', is_gift: false };
  assert.equal(counterDiscountPct({ ...p, disc: 5 }, 20), 5);
  assert.equal(counterDiscountPct({ ...p, disc: 0 }, 20), 20);
  assert.equal(counterDiscountPct({ ...p, disc: 0 }, 0), 0);
  assert.equal(counterDiscountPct({ ...p, disc: 5, is_gift: true }, 20), 0);
  assert.equal(counterDiscountPct({ line_type: 'gift_card', disc: 0 }, 20), 0);
});

test('verso l’API: servizio, prodotto e gift card, con il prezzo in centesimi esatti', () => {
  assert.deepEqual(toApiLine({ line_type: 'service', service_id: 3, qty: 1, unit_price: 35, is_gift: false }, 0),
    { line_type: 'service', service_id: 3, qty: 1, unit_price: '35.00', discount_pct: 0, is_gift: false });
  assert.deepEqual(toApiLine({ line_type: 'product', product_id: 12, qty: 2, unit_price: 18.5, is_gift: 1 }, 10),
    { line_type: 'product', product_id: 12, qty: 2, unit_price: '18.50', discount_pct: 10, is_gift: true });
  assert.deepEqual(toApiLine({ line_type: 'gift_card', value: 50, recipient_name: 'Anna', qty: 1 }, 30),
    { line_type: 'gift_card', value: '50.00', recipient_name: 'Anna' });
  assert.deepEqual(toApiLine({ line_type: 'gift_card', value: 50, recipient_name: '' }, 0),
    { line_type: 'gift_card', value: '50.00' });
  // stesso ordine dei campi che scrivevano SellModal e CartTab
  assert.deepEqual(Object.keys(toApiLine({ line_type: 'product', product_id: 1, qty: 1, unit_price: 1 }, 0)),
    ['line_type', 'product_id', 'qty', 'unit_price', 'discount_pct', 'is_gift']);
});

/* ---- pacchetti e trattamenti già pagati ---- */

const pkg = { id: 9, name: 'Mani e piedi', price: '450.00', items: [{ service_id: 3, qty: 5 }, { service_id: 4, qty: 5 }] };
const manicure = { id: 3, name_it: 'Manicure', name_en: 'Manicure', price: '40.00' };

test('pacchetto: nel conto con il suo prezzo, verso l’API con il suo id', () => {
  assert.deepEqual(checkoutPackageLine('kl1', 7, pkg, 'it'), {
    key: 'kl1', operator_id: 7, line_type: 'package', package_id: 9, name: 'Pacchetto · Mani e piedi',
    unit_price: 450, qty: 1, discount_pct: 0, is_gift: false, extra: true,
  });
  assert.equal(counterPackageLine('k1', pkg, 'en').name, 'Package · Mani e piedi');
  assert.deepEqual(toApiLine(checkoutPackageLine('kl1', 7, pkg, 'it'), 10),
    { line_type: 'package', package_id: 9, qty: 1, unit_price: '450.00', discount_pct: 10, is_gift: false });
  // al banco il pacchetto prende lo sconto sulla vendita come i prodotti
  assert.equal(counterDiscountPct(counterPackageLine('k1', pkg, 'it'), 15), 15);
  assert.equal(packageSummary(pkg, [manicure], 'it'), '5 × Manicure · 5 × #4');
});

test('trattamento già pagato: una gift card «prepaid» del servizio, con le sedute', () => {
  const line = checkoutPrepaidLine('ql1', 7, manicure, 5, 180, 'it');
  assert.equal(line.name, 'Già pagato · Manicure × 5');
  assert.deepEqual(toApiLine(line, 0), {
    line_type: 'gift_card', value: '180.00', gift_service_id: 3, sessions: 5, kind: 'prepaid',
  });
  assert.equal(counterPrepaidLine('q1', manicure, 1, 40, 'en').name, 'Prepaid · Manicure');
  // il prezzo parte da listino × sedute
  assert.equal(prepaidValue(manicure, 5), 200);
  assert.equal(prepaidValue({ price: '19.99' }, 3), 59.97);
  // una gift card normale parte come prima, senza tipo né sedute
  assert.deepEqual(toApiLine(counterGiftLine('g1', 25, '', 'it'), 0), { line_type: 'gift_card', value: '25.00' });
});

test('pacchetti e trattamenti già pagati vogliono la cliente', () => {
  assert.equal(needsClient([counterProductLine('p1', shampoo, 3)]), false);
  assert.equal(needsClient([counterGiftLine('g1', 25, '', 'it')]), false);
  assert.equal(needsClient([counterPackageLine('k1', pkg, 'it')]), true);
  assert.equal(needsClient([counterPrepaidLine('q1', manicure, 2, 70, 'it')]), true);
});

test('conto unico: le righe di un’altra visita sanno da che visita vengono', () => {
  const line = visitItemLine(55, item, 0);
  assert.equal(line.key, 'v55_41_0');
  assert.equal(line.visit_id, 55);
  assert.equal(line.list_price, 35);
  assert.equal(line.extra, false);
  assert.equal(line.operator_id, 7);
});
