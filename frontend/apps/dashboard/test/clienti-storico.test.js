// Storico cliente: date sul calendario del salone e caparra dopo i rimborsi
// (caccia ai bug del 22/09/2026: 14-13, 06-18, 14-25), più le date pure e il
// «compleanno tra N giorni» della scheda.
//
// I test girano con il fuso del processo (di solito UTC): è proprio il caso
// della postazione su un altro fuso rispetto al salone di Roma.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setSalonTz } from '../../../packages/shared/src/format.js';
import { dateLabel, daysToBirthday, depositBadge, timelineDate } from '../src/sections/clienti/helpers.js';

test('visita serale: nella timeline vale il giorno del salone, non quello del dispositivo', () => {
  setSalonTz('Europe/Rome');
  // 23:30 UTC del 14 marzo = 00:30 del 15 a Roma
  assert.deepEqual(timelineDate('2026-03-14T23:30:00Z', 'it', '2026-09-23'), { day: 15, month: 'mar', year: '' });
  // Capodanno: a Roma è già il 2026, sul dispositivo in UTC ancora il 2025
  assert.deepEqual(timelineDate('2025-12-31T23:30:00Z', 'en', '2026-09-23'), { day: 1, month: 'Jan', year: '' });
  assert.deepEqual(timelineDate('2025-06-02T10:00:00+02:00', 'it', '2026-09-23'), { day: 2, month: 'giu', year: '25' });
});

test('una data pura resta quel giorno anche per un salone a ovest di Greenwich', () => {
  setSalonTz('America/New_York');
  try {
    assert.equal(dateLabel('2021-05-10', 'it'), '10 mag 2021');
    // un istante invece si legge sull'orologio del salone
    assert.equal(dateLabel('2021-05-10T02:00:00Z', 'it'), '9 mag 2021');
  } finally {
    setSalonTz('Europe/Rome');
  }
});

test('compleanno: i giorni si contano da «oggi» del salone', () => {
  assert.equal(daysToBirthday('--03-15', '2026-03-15'), 0);
  assert.equal(daysToBirthday('1990-03-16', '2026-03-15'), 1);
  // appena passato → l'anno prossimo (e il cambio dell'ora non sposta il conto)
  assert.equal(daysToBirthday('--03-14', '2026-03-15'), 364);
  assert.equal(daysToBirthday('--03-30', '2026-03-28'), 2);
  assert.equal(daysToBirthday('', '2026-03-15'), null);
});

test('caparra pagata e poi rimborsata in parte: si mostra quanto resta a credito', () => {
  const a = { deposit_status: 'paid', deposit_amount: '30.00', deposit_refunded_amount: '10.00', deposit_credit: '20.00' };
  assert.deepEqual(depositBadge(a), { kind: 'paid', amount: 20, refunded: 10 });
  // risposta senza deposit_credit: lo stesso conto, in centesimi
  assert.deepEqual(depositBadge({ deposit_status: 'paid', deposit_amount: '30.10', deposit_refunded_amount: '10.05' }), { kind: 'paid', amount: 20.05, refunded: 10.05 });
});

test('caparra da restituire o in rimborso: compare, con quanto manca', () => {
  assert.deepEqual(depositBadge({ deposit_status: 'refund_due', deposit_amount: '30.00', deposit_refunded_amount: '0.00' }), { kind: 'refund_due', amount: 30, refunded: 0 });
  assert.deepEqual(depositBadge({ deposit_status: 'refunding', deposit_amount: '30.00', deposit_refunded_amount: '10.00' }), { kind: 'refunding', amount: 20, refunded: 10 });
  assert.equal(depositBadge({ deposit_status: 'refunded', deposit_amount: '30.00', deposit_refunded_amount: '30.00' }).kind, 'refunded');
  assert.deepEqual(depositBadge({ deposit_status: 'forfeited', deposit_amount: '25.00' }), { kind: 'forfeited', amount: 25, refunded: 0 });
});

test('nessuna caparra, o richiesta e non pagata: niente etichetta', () => {
  assert.equal(depositBadge({ deposit_status: 'none', deposit_amount: '0.00' }), null);
  assert.equal(depositBadge({ deposit_status: 'required', deposit_amount: '30.00' }), null);
});
