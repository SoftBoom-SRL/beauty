// Comunicazioni: niente invii programmati nel passato (caccia del 22/09/2026,
// 07-14). La data del campo è l'ora del SALONE, e «adesso» conta già come
// passata: il server rifiuta scheduled_at <= now.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setSalonTz } from '@youty/shared';
import { isPastSchedule, nowDtLocal } from '../src/sections/comunicazioni/helpers.js';

test('una data di invio passata (o adesso) non si programma', () => {
  const now = Date.parse('2026-09-23T10:00:00+02:00');   // le 10 a Roma
  try {
    setSalonTz('Europe/Rome');
    assert.equal(isPastSchedule('2026-08-20T09:00', now), true);    // la bozza di un mese fa
    assert.equal(isPastSchedule('2026-09-23T09:59', now), true);
    assert.equal(isPastSchedule('2026-09-23T10:00', now), true);    // adesso: il server la rifiuta
    assert.equal(isPastSchedule('2026-09-23T10:01', now), false);
    assert.equal(isPastSchedule('', now), false);                   // nessuna data: nessun controllo
    // l'ora del campo è quella del salone: le 9 a New York sono le 15 a Roma
    setSalonTz('America/New_York');
    assert.equal(isPastSchedule('2026-09-23T09:00', now), false);
    assert.equal(isPastSchedule('2026-09-23T03:59', now), true);
  } finally {
    setSalonTz('Europe/Rome');
  }
});

test('il minimo del campo è adesso, sull’orologio del salone', () => {
  assert.match(nowDtLocal(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(isPastSchedule(nowDtLocal(), Date.now() + 60_000), true);
});
