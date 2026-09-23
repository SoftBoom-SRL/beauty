// Compleanno nella scheda cliente (caccia ai bug del 22/09/2026: 14-23).
// Giorno 31 e poi aprile: il 31 spariva a video ma restava nel valore,
// «--04-31», e il salvataggio rispondeva 400; togliendo il mese non si
// emetteva niente e restava salvato il compleanno vecchio.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { birthdayEdit, daysInMonth } from '../src/sections/clienti/helpers.js';

const empty = { d: '', m: '', y: '' };

test('giorno 31 e poi un mese di 30 giorni: il giorno si toglie, niente «--04-31»', () => {
  const step1 = birthdayEdit(empty, { d: '31' });
  assert.equal(step1.value, '');
  const step2 = birthdayEdit(birthdayEdit(step1.part, { m: '3' }).part, { m: '4' });
  assert.deepEqual(step2.part, { d: '', m: '4', y: '' });
  assert.equal(step2.value, '');
});

test('29 febbraio: senza anno vale, con un anno non bisestile no', () => {
  const feb29 = birthdayEdit(empty, { d: '29', m: '2' });
  assert.equal(feb29.value, '--02-29');
  assert.equal(birthdayEdit(feb29.part, { y: '1992' }).value, '1992-02-29');
  const y1991 = birthdayEdit(feb29.part, { y: '1991' });
  assert.equal(y1991.part.d, '');
  assert.equal(y1991.value, '');
  assert.equal(daysInMonth('2', '1991'), 28);
  assert.equal(daysInMonth('2', ''), 29);
  assert.equal(daysInMonth('', ''), 31);
});

test('togliere il mese cancella il compleanno invece di lasciare quello vecchio', () => {
  const full = { d: '15', m: '3', y: '1990' };
  assert.equal(birthdayEdit(full, {}).value, '1990-03-15');
  assert.equal(birthdayEdit(full, { m: '' }).value, '');
  assert.equal(birthdayEdit(full, { d: '', m: '', y: '' }).value, '');
});

test('anno a metà: vale il compleanno senza anno finché non ha 4 cifre', () => {
  const part = { d: '15', m: '3', y: '' };
  assert.equal(birthdayEdit(part, { y: '19' }).value, '--03-15');
  assert.equal(birthdayEdit(part, { y: '1990' }).value, '1990-03-15');
});
