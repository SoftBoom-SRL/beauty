// Caccia 22/09 — errori di validazione 422 leggibili (17-12).
//
// django-ninja risponde alla validazione di schema con la lista di pydantic:
// il toast mostrava il primo `msg`, in inglese e senza il campo — la nota del
// no-show troppo lunga dava «String should have at most 255 characters» e il
// no-show non veniva registrato senza che si capisse perché.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readableDetail } from '../src/apiErrors.js';

test('il 422 dice il campo e il problema, in italiano', () => {
  // La forma vera di una risposta del backend (POST /api/clients/public/hook).
  const detail = [
    { type: 'string_too_long', loc: ['body', 'data', 'first_name'], msg: 'String should have at most 80 characters', ctx: { max_length: 80 } },
    { type: 'string_type', loc: ['body', 'data', 'phone'], msg: 'Input should be a valid string' },
  ];
  assert.equal(readableDetail(detail), 'Nome: al massimo 80 caratteri · Telefono: deve essere un testo');
  assert.equal(
    readableDetail([{ type: 'string_too_long', loc: ['body', 'data', 'reason'], msg: 'String should have at most 255 characters', ctx: { max_length: 255 } }]),
    'Motivo: al massimo 255 caratteri',
  );
});

test('le voci di un elenco dicono quale', () => {
  const detail = [{ type: 'less_than_equal', loc: ['body', 'payload', 'items', 1, 'soak_min'], msg: 'Input should be less than or equal to 720', ctx: { le: 720 } }];
  assert.equal(readableDetail(detail), 'Posa (n. 2): al massimo 720');
});

test('parametri della query, campi sconosciuti e campi mancanti', () => {
  assert.equal(readableDetail([{ type: 'date_parsing', loc: ['query', 'date'], msg: 'Input should be a valid date' }]), 'Data: data non valida');
  assert.equal(readableDetail([{ type: 'greater_than_equal', loc: ['body', 'data', 'slot_interval_min'], msg: '…', ctx: { ge: 5 } }]), 'Slot interval min: almeno 5');
  assert.equal(readableDetail([{ type: 'missing', loc: ['body', 'data', 'phone'], msg: 'Field required' }]), 'Telefono: obbligatorio');
  assert.equal(readableDetail([{ type: 'missing', loc: ['body', 'data'], msg: 'Field required' }]), 'Obbligatorio');
});

test('i messaggi dei validatori del backend restano i loro', () => {
  const detail = [{ type: 'value_error', loc: ['body', 'data', 'start'], msg: 'Value error, Orario senza fuso orario: usa il formato ISO con offset (es. 2026-09-18T10:00:00+02:00)' }];
  assert.equal(readableDetail(detail), 'Inizio: Orario senza fuso orario: usa il formato ISO con offset (es. 2026-09-18T10:00:00+02:00)');
});

test('gli errori scritti a mano restano com\'erano', () => {
  assert.equal(readableDetail('Orario non più disponibile'), 'Orario non più disponibile');
  assert.equal(readableDetail(null), null);
  assert.equal(readableDetail([{ msg: 'Qualcosa' }]), 'Qualcosa');
  assert.equal(readableDetail({ code: 7 }), '{"code":7}');
});

test('i campi limitati di magazzino, listino ed etichette hanno il nome che si legge nei moduli', () => {
  // Limiti dalle colonne (bug sospetti del 24/09, voce 21 e seguito): senza il
  // nome italiano il 422 diceva «Package unit», «Purchase discount pct».
  const tooLong = (field, max) => ({ type: 'string_too_long', loc: ['body', 'data', field], msg: '…', ctx: { max_length: max } });
  const tooBig = (field, le) => ({ type: 'less_than_equal', loc: ['body', 'data', field], msg: '…', ctx: { le } });
  assert.equal(readableDetail([tooLong('brand', 120)]), 'Brand: al massimo 120 caratteri');
  assert.equal(readableDetail([tooLong('package_unit', 20)]), 'Unità di misura: al massimo 20 caratteri');
  assert.equal(readableDetail([tooBig('purchase_discount_pct', 100)]), 'Sconto: al massimo 100');
  assert.equal(readableDetail([tooBig('order', 2147483647)]), 'Ordine: al massimo 2147483647');
  assert.equal(readableDetail([tooBig('package_qty', '99999999.99')]), 'Quantità per confezione: al massimo 99999999.99');
  assert.equal(readableDetail([tooBig('min_threshold', '99999999.99')]), 'Soglia minima: al massimo 99999999.99');
  // gli altri campi limitati avevano già il loro nome
  for (const [field, label] of [
    ['vat_number', 'Partita IVA'], ['sdi_pec', 'SDI o PEC'], ['address', 'Indirizzo'], ['sku', 'Codice articolo'],
    ['vat_rate', 'Aliquota IVA'], ['name_it', 'Nome'], ['name_en', 'Nome (EN)'], ['role_title', 'Ruolo'], ['note', 'Nota'],
    ['reason', 'Motivo'], ['price', 'Prezzo'], ['product_cost', 'Costo prodotto'], ['supplier_cost', 'Costo fornitore'],
    ['purchase_price', 'Prezzo d’acquisto'], ['sale_price', 'Prezzo di vendita'], ['reorder_qty', 'Quantità di riordino'],
    ['hourly_cost', 'Costo orario'], ['qty_ordered', 'Quantità ordinata'], ['qty_received', 'Quantità ricevuta'],
  ]) {
    assert.equal(readableDetail([tooBig(field, 1)]), `${label}: al massimo 1`, field);
  }
  const packageRow = { type: 'less_than_equal', loc: ['body', 'data', 'items', 0, 'qty'], msg: '…', ctx: { le: 2147483647 } };
  assert.equal(readableDetail([packageRow]), 'Quantità (n. 1): al massimo 2147483647');
});
