// Ricerca degli appuntamenti dalla barra in alto (richiesta Discord
// 1571903891501744218, punto 20): scrivendo nome o telefono si vedono anche
// le visite delle clienti trovate, e un clic apre l'appuntamento in agenda.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setSalonTz } from '@youty/shared';

import { apptIdOf, apptLink, hitDetail, hitWhen, shouldSearch } from '../src/shell/apptSearch.js';

test('si cerca da 2 caratteri, spazi esclusi', () => {
  assert.equal(shouldSearch(''), false);
  assert.equal(shouldSearch(' a '), false);
  assert.equal(shouldSearch('an'), true);
  assert.equal(shouldSearch(null), false);
});

test("il deepLink porta l'id dell'appuntamento, e solo quello", () => {
  assert.equal(apptLink(42), 'appt:42');
  assert.equal(apptIdOf(apptLink(42)), 42);
  assert.equal(apptIdOf('group-booking'), null);
  assert.equal(apptIdOf(null), null);
  assert.equal(apptIdOf('appt:'), null);
});

test("giorno e ora sono quelli del salone, non del dispositivo", () => {
  setSalonTz('Europe/Rome');
  try {
    // 23:30 UTC del 18 novembre = 00:30 del 19 a Roma
    const when = hitWhen({ start: '2026-11-18T23:30:00Z' }, 'it');
    assert.match(when, /19 nov/);
    assert.match(when, /00:30$/);
  } finally {
    setSalonTz('Europe/Rome');
  }
});

test('il dettaglio elenca i servizi e poi l’operatrice', () => {
  assert.equal(hitDetail({ services: ['Manicure', 'Pedicure'], operator_name: 'Giulia Bianchi' }), 'Manicure · Pedicure · Giulia Bianchi');
  assert.equal(hitDetail({ services: [], operator_name: '' }), '');
});
