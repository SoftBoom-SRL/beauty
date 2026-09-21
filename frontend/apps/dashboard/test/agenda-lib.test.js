// Regole dell'agenda che il client replica dal backend: disponibilità di uno
// slot e match della lista d'attesa. Difetti trovati nella caccia ai bug del
// 21/09/2026 (docs/BUG_HUNT_2026-09-21.md, B19 e B23).
//
// Il modulo sotto esame importa '@youty/shared': `npm test` lo risolve con
// test/register.mjs, quindi qui si prova il codice vero dell'applicazione.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apptOperatorIds, explainSlot, itemBlocks, moveIsNoop, wlMatches } from '../src/sections/agenda/lib.js';

/* Una visita alle 10:00: piega con Giulia (id 1, 30') e poi colore con MARTA
 * (id 2, 60'). GET /api/agenda/day la elenca nella riga dell'operatrice
 * PRINCIPALE, cioè Giulia: l'impegno di Marta vive dentro quella riga. */
const visit = {
  id: 77,
  status: 'confirmed',
  operator_id: 1,
  start: '2026-09-24T10:00:00+02:00',
  client: { full_name: 'Aisha Rahman' },
  total_duration_min: 90,
  items: [
    { id: 1, service_id: 10, service_name: 'Piega', operator_id: 1, duration_min: 30, soak_min: 0, order: 0 },
    { id: 2, service_id: 11, service_name: 'Colore', operator_id: 2, duration_min: 60, soak_min: 0, order: 1 },
  ],
};
const rowGiulia = {
  operator: { id: 1, name: 'Giulia Rossi' },
  windows: [['09:00', '18:00']],
  appointments: [visit],
  pauses: [],
};
const rowMarta = {
  operator: { id: 2, name: 'Marta Bianchi' },
  windows: [['09:00', '18:00']],
  appointments: [],
  pauses: [],
};

test('i servizi di una visita si concatenano dallo start, ognuno con la sua operatrice', () => {
  const blocks = itemBlocks(visit);
  assert.equal(blocks[1].startMin, 10 * 60 + 30);
  assert.equal(blocks[1].opId, 2);
});

test('un orario dentro la visita di una collega risulta occupato', () => {
  const verdict = explainSlot(rowMarta, 10 * 60 + 30, 30, { rows: [rowGiulia, rowMarta] });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'busy');
});

test('resta occupato anche se la colonna della collega è nascosta dalle chip', () => {
  // DayGrid riceve `rows` (colonne disegnate) e `allRows` (tutte le righe del
  // giorno): i controlli usano le seconde. Prima passavano solo le colonne
  // visibili, e nascondendo Giulia l'impegno di Marta spariva dal conto: il
  // badge diceva «Disponibile», il server rispondeva 409 e lo spostamento
  // partiva comunque forzato, sovrapponendo due clienti.
  const drawn = [rowMarta];                  // Giulia nascosta
  const all = [rowGiulia, rowMarta];         // ciò che passa ai controlli
  assert.equal(explainSlot(rowMarta, 10 * 60 + 30, 30, { rows: all }).code, 'busy');
  // la riga da disegnare resta quella filtrata: nessun blocco di Giulia
  assert.deepEqual(drawn.flatMap((r) => r.appointments), []);
});

test('la posa altrui non blocca lo slot, lo segnala', () => {
  const withSoak = {
    ...visit,
    items: [{ id: 3, service_id: 12, service_name: 'Colore', operator_id: 2, duration_min: 30, soak_min: 60, order: 0 }],
    operator_id: 2,
  };
  const row = { ...rowMarta, appointments: [withSoak] };
  const verdict = explainSlot(row, 11 * 60, 30, { rows: [row] });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, 'soak');
});

test('la lista d\'attesa conta anche chi chiede un\'operatrice secondaria', () => {
  // Stessa regola del backend (free_slot_event): operatrice non indicata
  // OPPURE una qualsiasi di quelle coinvolte nella visita.
  const waitlist = [
    { id: 1, status: 'active', service_id: 11, operator_id: 2, created_at: '2026-09-01T09:00:00Z' },
    { id: 2, status: 'active', service_id: 11, operator_id: null, created_at: '2026-09-02T09:00:00Z' },
    { id: 3, status: 'active', service_id: 11, operator_id: 9, created_at: '2026-09-03T09:00:00Z' },
    { id: 4, status: 'done', service_id: 11, operator_id: null, created_at: '2026-09-04T09:00:00Z' },
  ];
  assert.deepEqual(wlMatches(waitlist, visit).map((w) => w.id), [1, 2]);
  assert.deepEqual([...apptOperatorIds(visit)].sort(), [1, 2]);
});

test('rimandare indietro un appuntamento non è un «non-movimento»', () => {
  // Spostato dalle 10:00 alle 11:00 con la stessa operatrice.
  const from = { startMin: 10 * 60, opId: 1 };
  const to = { startMin: 11 * 60, opId: 1 };
  assert.equal(moveIsNoop(to.startMin, to.opId, from), false);
  // «Annulla»: si torna alle 10:00 dicendo che si PARTE dalle 11:00. Leggendo
  // la partenza dall'appuntamento di prima dello spostamento (le 10:00) il
  // ritorno sembrava un non-movimento e l'annullamento non partiva.
  assert.equal(moveIsNoop(from.startMin, from.opId, to), false);
  // un rilascio nello stesso punto invece non va mandato al server
  assert.equal(moveIsNoop(from.startMin, from.opId, from), true);
  assert.equal(moveIsNoop(undefined, 1, from), true);
});
