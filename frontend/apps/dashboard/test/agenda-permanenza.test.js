// La «permanenza» di una cliente (sections/agenda/lib/stay.js): i suoi
// appuntamenti dello stesso giorno, uno dopo l'altro. Il titolare, 15/10:
// separati, non si capiva che erano insieme, e in cassa non si chiudeva tutto.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dayStays, linkedIds, stayIndex, stayMateIds, stayMatesLabels } from '../src/sections/agenda/lib/stay.js';

const at = (h, m = 0) => `2026-10-17T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+02:00`;
const appt = (id, client, start, dur, extra = {}) => ({ id, client: { id: client }, start, total_duration_min: dur, status: 'confirmed', items: [], ...extra });

test('uno dopo l\'altro, anche con 30 minuti in mezzo, è una permanenza; oltre no', () => {
  const list = [
    appt(1, 7, at(10), 60),                // 10:00–11:00
    appt(2, 7, at(11), 30),                // 11:00–11:30 attaccato
    appt(3, 7, at(12), 30),                // 30' dopo: ancora insieme
    appt(4, 7, at(16), 60),                // il pomeriggio: un'altra
    appt(5, 9, at(11), 30),                // un'altra cliente
    appt(6, 7, at(13), 30, { status: 'cancelled' }),
  ];
  const s = dayStays(list);
  assert.deepEqual(s.get(1), { ids: [1, 2, 3], index: 0, size: 3 });
  assert.deepEqual(s.get(3), { ids: [1, 2, 3], index: 2, size: 3 });
  assert.equal(s.get(4), undefined, 'da sola non è legata a niente');
  assert.equal(s.get(5), undefined);
  assert.equal(s.get(6), undefined, 'gli annullati non contano');
});

test('in settimana le parti di una visita contano una volta, e vale il client_id del payload compatto', () => {
  const part = (key) => ({ id: 50, key, client_id: 7, start: at(10), duration_min: 90, status: 'confirmed' });
  const s = stayIndex([part('50:0'), part('50:1'), { id: 51, client_id: 7, start: at(11, 30), duration_min: 30, status: 'confirmed' }], {
    clientOf: (a) => a.client_id, startOf: (a) => Number(a.start.slice(11, 13)) * 60 + Number(a.start.slice(14, 16)), endOf: (a) => Number(a.start.slice(11, 13)) * 60 + Number(a.start.slice(14, 16)) + a.duration_min,
  });
  assert.deepEqual(s.get(50).ids, [50, 51]);
});

test('in cassa si mettono già nel conto le visite della stessa permanenza, non le altre del giorno', () => {
  const main = appt(1, 7, at(10), 60);
  const others = [appt(2, 7, at(11), 40), appt(3, 7, at(17), 30)];
  assert.deepEqual(stayMateIds(main, others), [2]);
  assert.deepEqual(stayMateIds(main, []), []);
  assert.deepEqual(stayMateIds(null, others), []);
});

test('l\'anteprima dice con chi e quando; si evidenziano insieme quella aperta e quella indicata', () => {
  const list = [
    appt(1, 7, at(10), 60, { items: [{ service_name: 'Manicure', operator_name: 'Sole Rossi' }] }),
    appt(2, 7, at(11), 40, { items: [{ service_name: 'Piega', operator_id: 4 }] }),
  ];
  const s = dayStays(list);
  assert.deepEqual(stayMatesLabels(s, list, 1), ['11:00 Piega']);
  assert.deepEqual(stayMatesLabels(s, list, 1, (id) => (id === 4 ? 'Mara' : '')), ['11:00 Piega · Mara']);
  assert.deepEqual(stayMatesLabels(s, list, 2), ['10:00 Manicure · Sole']);
  assert.deepEqual([...linkedIds(s, 2, null)], [1, 2]);
  assert.deepEqual([...linkedIds(s, null, 99)], []);
});
