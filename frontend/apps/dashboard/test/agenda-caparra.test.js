// La caparra scritta dallo staff (sections/agenda/lib/deposit.js): l'importo
// digitato come lo legge la cassa, e quando non va bene.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cleanAmount, depositIssue, depositToApi, depositToField, sameAmount } from '../src/sections/agenda/lib/deposit.js';

test('l\'importo digitato: solo cifre e un separatore', () => {
  assert.equal(cleanAmount('€ 30,5'), '30,5');
  assert.equal(cleanAmount('1.234,50'), '1.23450');
  assert.equal(cleanAmount('abc'), '');
});

test('all\'API due decimali, nel campo la virgola in italiano', () => {
  assert.equal(depositToApi('30,5'), '30.50');
  assert.equal(depositToApi('20'), '20.00');
  assert.equal(depositToField('20.00', 'it'), '20,00');
  assert.equal(depositToField('20.00', 'en'), '20.00');
  assert.ok(sameAmount('20', '20.00'));
  assert.ok(!sameAmount('20,01', '20.00'));
});

test('vuoto, zero o oltre il totale della visita non va', () => {
  assert.equal(depositIssue('', 9500), 'empty');
  assert.equal(depositIssue('0,00', 9500), 'empty');
  assert.equal(depositIssue('95,01', 9500), 'over');
  assert.equal(depositIssue('95', 9500), null);
  assert.equal(depositIssue('30', null), null);
});
