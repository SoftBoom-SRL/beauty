// «Sposta qui» dal menu dello slot, con il dettaglio aperto e un altro giorno a
// video (caccia ai bug del 22/09/2026, reperti 13-01 = 12-05 = 17-06, 12-11,
// 13-07) e gli eventi live che fanno ricaricare le viste (12-09, 12-25, 17-08,
// 08-03).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENDA_LIVE_RE, ghostBlockAt, moveHereTarget, moveIsNoop } from '../src/sections/agenda/lib.js';

/* Maria, martedì 29 settembre: manicure 10:00–11:00 con Anna (id 1, la
 * principale), poi piega 11:00–11:30 con Giulia (id 2). */
const maria = {
  id: 41,
  status: 'confirmed',
  operator_id: 1,
  start: '2026-09-29T10:00:00+02:00',
  client: { id: 7, full_name: 'Maria Russo' },
  items: [
    { id: 1, service_name: 'Manicure', operator_id: 1, duration_min: 60, soak_min: 0, order: 0 },
    { id: 2, service_name: 'Piega', operator_id: 2, duration_min: 30, soak_min: 0, order: 1 },
  ],
};

test('stessa ora e stessa colonna su un ALTRO giorno è uno spostamento vero', () => {
  // Si sfoglia giovedì dal pannello e si sceglie «Sposta qui» sull'ombra delle
  // 10:00 di Anna: prima il confronto guardava solo ora e colonna, e la
  // cliente restava martedì senza nessuna richiesta al server.
  const from = { startMin: 10 * 60, opId: 1, date: '2026-09-29' };
  assert.equal(moveIsNoop(10 * 60, 1, from, '2026-10-01'), false);
  // sullo stesso giorno, stessa ora e stessa colonna resta un non-movimento
  assert.equal(moveIsNoop(10 * 60, 1, from, '2026-09-29'), true);
  // e cambiando l'ora o la colonna lo spostamento parte comunque
  assert.equal(moveIsNoop(11 * 60, 1, from, '2026-09-29'), false);
  assert.equal(moveIsNoop(10 * 60, 2, from, '2026-09-29'), false);
});

test('il clic sull\'ombra della piega non sposta la visita alle 11 né la dà a Giulia', () => {
  // Giovedì a video: l'ombra disegna la manicure nella colonna di Anna alle
  // 10:00 e la piega in quella di Giulia alle 11:00. Il clic cade dentro
  // l'ombra della piega (11:10 nella colonna di Giulia).
  const hit = ghostBlockAt(maria, 2, 11 * 60 + 10);
  assert.ok(hit, 'il punto cade dentro l\'ombra della piega');
  assert.equal(hit.item.id, 2);
  const target = moveHereTarget(maria, { opId: 2, startMin: hit.startMin, ghostHit: true });
  // «qui» = stessa ora della visita, stesse operatrici: cambia solo il giorno
  assert.deepEqual(target, { startMin: 10 * 60, opId: 1, fromOp: 1 });
  const from = { startMin: 10 * 60, opId: 1, date: '2026-09-29' };
  assert.equal(moveIsNoop(target.startMin, target.opId, from, '2026-10-01'), false);
});

test('fuori dall\'ombra il clic vale per l\'ora e la colonna cliccate', () => {
  assert.equal(ghostBlockAt(maria, 2, 10 * 60 + 30), null, 'alle 10:30 Giulia non ha ombra');
  assert.equal(ghostBlockAt(maria, 3, 10 * 60), null, 'nella colonna di un\'altra non c\'è ombra');
  assert.equal(ghostBlockAt(null, 1, 10 * 60), null);
  // uno spazio libero di Carla (id 3) alle 15:00: la visita parte alle 15 e i
  // servizi della principale passano a Carla
  assert.deepEqual(moveHereTarget(maria, { opId: 3, startMin: 15 * 60 }), { startMin: 15 * 60, opId: 3, fromOp: 1 });
});

test('«Sposta qui» parte dall\'operatrice di ADESSO, non da quella dell\'apertura', () => {
  // Dal pannello Maria è passata da Anna a Bea (id 4): la copia fresca dice
  // Bea, ed è da lei che devono partire i servizi (from_operator_id).
  const fresca = { ...maria, operator_id: 4, items: maria.items.map((it) => (it.operator_id === 1 ? { ...it, operator_id: 4 } : it)) };
  assert.deepEqual(moveHereTarget(fresca, { opId: 3, startMin: 15 * 60 }), { startMin: 15 * 60, opId: 3, fromOp: 4 });
  assert.equal(ghostBlockAt(fresca, 1, 10 * 60 + 5), null, 'l\'ombra non è più nella colonna di Anna');
  assert.equal(ghostBlockAt(fresca, 4, 10 * 60 + 5)?.item.id, 1);
});

test('le viste si ricaricano per caparre, incassi, chiusura del conto, turni e orari', () => {
  for (const type of [
    'appointment.moved', 'appointment.closed', 'pause.updated',
    'deposit.paid', 'deposit.refunded', 'sale.created',
    'operator.absence_created', 'operator.shifts_updated', 'operator.updated',
    'settings.updated',
  ]) {
    assert.ok(AGENDA_LIVE_RE.test(type), type);
  }
  // le regole caparra e le anagrafiche clienti non toccano la griglia
  for (const type of ['deposit_rule.created', 'client.updated', 'giftcard.created']) {
    assert.equal(AGENDA_LIVE_RE.test(type), false, type);
  }
});
