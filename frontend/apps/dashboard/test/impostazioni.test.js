// Impostazioni: condizioni su etichette sparite, acconto in percentuale, orari
// e registro attività nel fuso del salone. Caccia ai bug del 22/09/2026: 15-07,
// 15-16, 15-09 (+ 08-09), 15-22.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setSalonTz } from '../../../packages/shared/src/format.js';
import { amountForType, depositFields, dropCurrent, ruleSentence } from '../src/sections/impostazioni/rules.js';
import { todayRanges } from '../src/sections/impostazioni/hours.js';
import { logDateLabel, salonDaysAgo } from '../src/sections/impostazioni/dates.js';

const t = (it) => it;
const cats = [{ id: 1, name: 'Nuova' }, { id: 2, name: 'Da seguire' }, { id: 3, name: 'VIP' }];

test('15-07: un’etichetta che non c’è più si vede com’è, non come la prima della lista', () => {
  const f = depositFields(cats, t, 'it').find((x) => x.id === 'categories');
  const cur = dropCurrent(f.options, 'A rischio', { missingLabel: f.missingLabel, loose: f.loose });
  assert.equal(cur.missing, true);
  assert.equal(cur.label, 'etichetta non trovata: A rischio');
  assert.notEqual(cur.label, 'Nuova');
});

test('15-07: le etichette si riconoscono senza badare a maiuscole, come sul server', () => {
  const f = depositFields(cats, t, 'it').find((x) => x.id === 'categories');
  const cur = dropCurrent(f.options, 'vip', { missingLabel: f.missingLabel, loose: f.loose });
  assert.equal(cur.missing, false);
  assert.equal(cur.label, 'VIP');
});

test('15-07: la frase della regola dice che l’etichetta non c’è più', () => {
  const fields = depositFields(cats, t, 'it');
  const s = ruleSentence({ op: 'and', rules: [{ field: 'categories', cmp: 'contains', value: 'A rischio' }] }, fields, t, 'it');
  assert.equal(s, 'Etichetta cliente = etichetta non trovata: A rischio');
  const ok = ruleSentence({ op: 'and', rules: [{ field: 'categories', cmp: 'contains', value: 'Da seguire' }] }, fields, t, 'it');
  assert.equal(ok, 'Etichetta cliente = Da seguire');
});

test('menu senza valore: un trattino, non la prima opzione', () => {
  assert.deepEqual(dropCurrent([{ value: 'a', label: 'A' }], '').label, '—');
});

test('15-16: da 150 € fissi a percentuale l’acconto non resta 150 %', () => {
  assert.equal(amountForType(150, 'pct'), 100);
  assert.equal(amountForType(12.6, 'pct'), 13);
  assert.equal(amountForType(-5, 'pct'), 0);
  assert.equal(amountForType(30, 'fixed'), 30);
  assert.equal(amountForType(12.5, 'fixed'), 12.5);
});

test('15-22: «Oggi» negli orari è il giorno del salone, non del dispositivo', () => {
  setSalonTz('Europe/Rome');
  const week = { 5: [['09:00', '13:00']], 6: [] };
  // domenica 4 ottobre 2026, 00:30 a Roma = sabato 3 ottobre 22:30 UTC
  assert.deepEqual(todayRanges(week, new Date('2026-10-03T22:30:00Z')), []);
  // sabato 3 ottobre 12:00 a Roma
  assert.deepEqual(todayRanges(week, new Date('2026-10-03T10:00:00Z')), [['09:00', '13:00']]);
  assert.equal(todayRanges({}, new Date()), null);
});

test('15-09: ora e «Oggi/Ieri» del registro sono quelli del salone', () => {
  setSalonTz('Europe/Rome');
  // 10:15 a Roma (08:15 UTC): prima compariva alle 08:15 da una postazione in UTC
  assert.equal(logDateLabel('2026-09-22T08:15:00Z', 'it', '2026-09-22'), 'Oggi · 10:15');
  // 00:30 del 22 a Roma = 22:30 UTC del 21: è di oggi, non di «Ieri»
  assert.equal(logDateLabel('2026-09-21T22:30:00Z', 'it', '2026-09-22'), 'Oggi · 00:30');
  assert.equal(logDateLabel('2026-09-21T08:00:00Z', 'en', '2026-09-22'), 'Yesterday · 10:00');
  assert.equal(logDateLabel('2026-09-03T16:02:00Z', 'it', '2026-09-22'), '3 set 2026 · 18:02');
});

test('i periodi del registro partono dal giorno del salone', () => {
  assert.equal(salonDaysAgo(7, '2026-03-02'), '2026-02-23');
  assert.equal(salonDaysAgo(1, '2026-01-01'), '2025-12-31');
  assert.equal(salonDaysAgo(30, '2026-03-29'), '2026-02-27');
});
