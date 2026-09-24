// Anteprime del pannello di dettaglio (annullamento, no-show, importi, scadenza
// della caparra): devono dire quello che poi farà davvero il server.
// Caccia ai bug del 22/09/2026: 13-02 (= 02-10), 13-15, 13-21, 13-14 (= 02-25, 17-15).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setSalonTz } from '@youty/shared';
import { cancelSteps, fmtMoney, lateCancel, noShowSteps } from '../src/sections/agenda/lib.js';
import { depositDueLabel } from '../src/sections/agenda/modals/rules.js';

const t = (it) => it;
const inTwoHours = () => new Date(Date.now() + 2 * 3600000).toISOString();

const paidVisit = (extra = {}) => ({
  id: 5,
  start: inTwoHours(),
  total_duration_min: 60,
  items: [{ id: 1, service_id: 3, operator_id: 1, duration_min: 60 }],
  deposit_status: 'paid',
  deposit_amount: '30.00',
  deposit_refunded_amount: '0.00',
  deposit_credit: '30.00',
  ...extra,
});

test('annullare dal gestionale due ore prima rimborsa la caparra: niente «Caparra trattenuta»', () => {
  const steps = cancelSteps(paidVisit(), 2, t, 'it');
  assert.equal(steps[1].title, 'Caparra da rimborsare');
  assert.equal(steps[1].detail, '€30,00');
  assert.ok(steps.every((s) => s.title !== 'Caparra trattenuta'));
});

test('la disdetta della cliente registrata dalla reception: in ritardo la caparra resta al salone', () => {
  // due ore prima, con 24 ore minime (come l'app): caparra trattenuta, disdetta tardiva
  const late = cancelSteps(paidVisit(), 0, t, 'it', { byClient: true, minHours: 24 });
  assert.equal(late[1].title, 'Caparra trattenuta');
  assert.equal(late[1].detail, '€30,00');
  assert.equal(late[0].detail, 'Disdetta tardiva');
  // tre giorni prima: la caparra torna alla cliente, niente disdetta tardiva
  const inTime = cancelSteps(paidVisit({ start: new Date(Date.now() + 72 * 3600000).toISOString() }), 0, t, 'it',
    { byClient: true, minHours: 24 });
  assert.equal(inTime[1].title, 'Caparra da rimborsare');
  assert.equal(inTime[0].detail, undefined);
  // senza caparra pagata la disdetta resta tardiva, ma non c'è niente da trattenere
  const unpaid = cancelSteps(paidVisit({ deposit_status: 'required' }), 0, t, 'it', { byClient: true, minHours: 24 });
  assert.equal(unpaid[1].title, 'Nessuna caparra');
  assert.equal(unpaid[0].detail, 'Disdetta tardiva');
});

test('ore minime: il conto del ritardo è quello del server', () => {
  const now = Date.parse('2026-09-24T10:00:00Z');
  const at = (iso) => ({ start: iso });
  assert.equal(lateCancel(at('2026-09-25T09:59:00Z'), 24, now), true);   // 23 h 59'
  assert.equal(lateCancel(at('2026-09-25T10:00:00Z'), 24, now), false);  // 24 h esatte: in tempo
  assert.equal(lateCancel(at('2026-09-24T09:00:00Z'), 24, now), true);   // già cominciata
  assert.equal(lateCancel(at('2026-09-25T09:00:00Z'), undefined, now), false); // soglia ignota: decide il server
});

test('dopo un rimborso parziale le anteprime usano la quota ancora in cassa', () => {
  const visit = paidVisit({ deposit_refunded_amount: '10.00', deposit_credit: '20.00' });
  assert.equal(cancelSteps(visit, 0, t, 'it')[1].detail, '€20,00');
  const noShow = noShowSteps(visit, 0, t, 'it')[1];
  assert.equal(noShow.title, 'Caparra trattenuta');
  assert.equal(noShow.detail, '€20,00');
});

test('senza deposit_credit (server vecchio) vale il versato', () => {
  const visit = paidVisit();
  delete visit.deposit_credit;
  assert.equal(noShowSteps(visit, 0, t, 'it')[1].detail, '€30,00');
});

test('senza caparra pagata non si promette niente', () => {
  const steps = cancelSteps(paidVisit({ deposit_status: 'required' }), 0, t, 'it');
  assert.equal(steps[1].title, 'Nessuna caparra');
});

test('lo zero si scrive con i decimali, come gli altri importi', () => {
  assert.equal(fmtMoney(0, 'it'), '€0,00');
  assert.equal(fmtMoney('0.00', 'en'), '€0.00');
  assert.equal(fmtMoney(null, 'it'), '€0,00');
  assert.equal(fmtMoney('45.5', 'it'), '€45,50');
});

test('la scadenza della caparra si legge nel fuso del salone', () => {
  try {
    setSalonTz('Europe/Rome');
    assert.equal(depositDueLabel('2026-09-24T16:00:00Z', 'it'), '24/09, 18:00');
    setSalonTz('America/New_York');
    assert.equal(depositDueLabel('2026-09-24T16:00:00Z', 'en'), '24/09, 12:00');
  } finally {
    setSalonTz('Europe/Rome');
  }
  assert.equal(depositDueLabel(null, 'it'), '');
});
