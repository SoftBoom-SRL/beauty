// Classifica della lista d'attesa per uno slot liberato: il giorno della
// settimana va letto sul calendario del SALONE, non su quello del dispositivo
// (caccia ai bug del 22/09/2026, reperti 12-19 e 02-25).
//
// Il fuso del dispositivo si fissa qui, prima di qualunque data: il difetto si
// vede solo quando dispositivo e salone non sono d'accordo sul giorno.
process.env.TZ = 'Asia/Tokyo';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setSalonTz } from '@youty/shared';
import { wlRank } from '../src/sections/agenda/lib.js';

test('il venerdì sera del salone resta venerdì anche per un dispositivo già a sabato', () => {
  // Salone a New York: venerdì 2 ottobre alle 21:00 (a Tokyo è già sabato).
  setSalonTz('America/New_York');
  try {
    const appt = { start: '2026-10-02T21:00:00-04:00', operator_id: 1, items: [{ service_id: 5, operator_id: 1 }] };
    const created = new Date().toISOString();   // stessa anzianità: decide la preferenza
    const weekend = { id: 1, preference: 'weekend', operator_id: null, created_at: created };
    const venerdi = { id: 2, preference: 'exact', exact_days: [4], operator_id: null, created_at: created };
    const ranked = wlRank([weekend, venerdi], appt);
    assert.deepEqual(ranked.map((w) => w.id), [2, 1], 'chi ha chiesto il venerdì passa davanti a chi aspetta il weekend');
  } finally {
    setSalonTz('Europe/Rome');
  }
});
