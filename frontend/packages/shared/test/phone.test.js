// Test sul controllo di plausibilità del telefono. La regola DEVE restare
// quella del backend (`backend/common/phone.py`: `[1-9]\d{6,14}` sull'E.164
// senza «+»): quando qui bastavano 6 cifre, quattro cifre digitate per sbaglio
// superavano il controllo, la registrazione riusciva, il salone pagava un SMS
// verso un numero inesistente e la cliente restava ferma sulla schermata del
// codice, con una scheda fantasma in anagrafica.
// Si esegue con `npm test` (node --test, nessuna dipendenza).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPlausiblePhone, normalizePhone } from '../src/phone.js';

test('i numeri veri passano, comunque siano scritti', () => {
  for (const v of [
    '333 123 4567',          // mobile italiano senza prefisso
    '+39 333 123 4567',
    '00393331234567',
    '06 1234567',            // fisso italiano: lo 0 di distretto resta
    '+44 020 7946 0958',     // Londra: lo 0 interurbano cade, come nel backend
    '+1 809 555 1234',
  ]) assert.ok(isPlausiblePhone(v), `doveva essere plausibile: ${v}`);
});

test('quello che il backend non normalizzerebbe non passa', () => {
  for (const v of [
    '', '   ', 'abc',
    '1234',                  // le 4 cifre del caso reale: +391234, 6 cifre
    '+39',                   // solo il prefisso
    '+393331234567890123',   // oltre le 15 cifre dell'E.164
  ]) assert.ok(!isPlausiblePhone(v), `non doveva essere plausibile: ${v}`);
});

test('il limite è a 7 cifre totali, prefisso compreso', () => {
  // "+39" + 4 cifre = 6 cifre: il vecchio controllo si fermava qui e passava.
  assert.equal(normalizePhone('1234'), '+391234');
  assert.equal(isPlausiblePhone('1234'), false);
  // Una cifra in più fa 7 e il backend la normalizza: qui deve passare.
  assert.equal(normalizePhone('12345'), '+3912345');
  assert.equal(isPlausiblePhone('12345'), true);
});

test('quindici cifre sono il massimo dell\'E.164', () => {
  assert.ok(isPlausiblePhone('+123456789012345'));
  assert.ok(!isPlausiblePhone('+1234567890123456'));
});
