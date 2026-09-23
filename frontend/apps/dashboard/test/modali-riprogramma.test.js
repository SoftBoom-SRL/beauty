// «Riprogramma» dal pannello: gli orari arrivano dalla visita stessa (C1) e,
// per le righe di un'operatrice che non si prenota più, la ricerca propone una
// collega che lo spostamento deve ricevere (operator_id + from_operator_id).
// Caccia ai bug del 22/09/2026: 01-05, 02-24, 13-17 (lato pannello).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { slotReassignment } from '../src/sections/agenda/modals/rules.js';

const items = [
  { id: 1, service_id: 3, operator_id: 1, order: 0 },   // taglio con Anna
  { id: 2, service_id: 4, operator_id: 9, order: 1 },   // colore con Dora, disattivata
];

test('tutte le operatrici si prenotano ancora: si sposta e basta', () => {
  const r = slotReassignment(items, [{ service_id: 3, operator_id: 1 }, { service_id: 4, operator_id: 9 }]);
  assert.deepEqual(r, { pair: null, extra: 0 });
});

test('la collega proposta al posto di chi non lavora più lì si manda allo spostamento', () => {
  const r = slotReassignment(items, [{ service_id: 3, operator_id: 1 }, { service_id: 4, operator_id: 2 }]);
  assert.deepEqual(r, { pair: { from: 9, to: 2 }, extra: 0 });
});

test('l’ordine è quello delle righe della visita, non quello in cui arrivano', () => {
  const shuffled = [items[1], items[0]];
  const r = slotReassignment(shuffled, [{ service_id: 3, operator_id: 1 }, { service_id: 4, operator_id: 2 }]);
  assert.deepEqual(r.pair, { from: 9, to: 2 });
});

test('due operatrici da riassegnare: se ne porta una, l’altra si segnala', () => {
  const both = [{ ...items[0], operator_id: 8 }, items[1]];
  const r = slotReassignment(both, [{ service_id: 3, operator_id: 1 }, { service_id: 4, operator_id: 2 }]);
  assert.deepEqual(r, { pair: { from: 8, to: 1 }, extra: 1 });
});

test('righe non allineate o slot senza proposta: niente riassegnazione inventata', () => {
  assert.deepEqual(slotReassignment(items, [{ service_id: 4, operator_id: 2 }, { service_id: 3, operator_id: 1 }]).pair, null);
  assert.deepEqual(slotReassignment(items, undefined), { pair: null, extra: 0 });
});
