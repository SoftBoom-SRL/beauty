// Storico vendite: i servizi si leggevano «Servizio #12» e la caparra
// «Servizio #» (caccia del 22/09/2026: 05-17, 14-11, contratto C14); con il
// buono ripartito sulle righe (`coupon_share`) l'importo di riga è al netto.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lineGrossCents, saleLineLabel } from '../src/sections/pos/history.js';

const t = (it) => it;
const services = [{ id: 12, name_it: 'Piega', name_en: 'Blow-dry' }];
const checkout = { kind: 'checkout', appointment_id: 7 };

test('riga servizio: il nome, non «Servizio #12»', () => {
  const line = { line_type: 'service', service_id: 12 };
  assert.equal(saleLineLabel(line, checkout, { services, lang: 'it', t }), 'Piega');
  assert.equal(saleLineLabel(line, checkout, { services, lang: 'en', t }), 'Blow-dry');
  // servizio non più nel listino: vale service_name della risposta (C14)
  assert.equal(saleLineLabel({ ...line, service_id: 99, service_name: 'Colore' }, checkout, { services, t }), 'Colore');
  assert.equal(saleLineLabel({ ...line, service_id: 99 }, checkout, { services, t }), 'Servizio #99');
});

test('riga senza servizio: caparra o addebito del no-show, non «Servizio #»', () => {
  const line = { line_type: 'service', service_id: null, service_name: '' };
  assert.equal(saleLineLabel(line, { kind: 'pos', appointment_id: null, deposit_appointment_id: 7 }, { t }), 'Caparra');
  assert.equal(saleLineLabel(line, { kind: 'pos', appointment_id: null }, { t }), 'Caparra');
  assert.equal(saleLineLabel(line, { kind: 'pos', appointment_id: 7, deposit_appointment_id: null }, { t }), 'Addebito mancata presentazione');
  assert.equal(saleLineLabel(line, checkout, { t }), 'Servizio');
});

test('prodotti e gift card come prima', () => {
  assert.equal(saleLineLabel({ line_type: 'product', product_id: 3, product_name: 'Shampoo' }, checkout, { t }), 'Shampoo');
  assert.equal(saleLineLabel({ line_type: 'gift_card', gift_card_code: 'GC-1' }, checkout, { t }), 'Gift card · GC-1');
});

test('importo di riga prima del buono, con o senza coupon_share', () => {
  assert.equal(lineGrossCents({ amount: '36.00', coupon_share: '4.00' }), 4000);
  assert.equal(lineGrossCents({ amount: '40.00' }), 4000);   // risposta senza il campo: amount è già il lordo
});
