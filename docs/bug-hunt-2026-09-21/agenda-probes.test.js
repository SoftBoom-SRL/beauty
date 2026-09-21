// Probe frontend: si caricano i VERI helper della sezione agenda
// (apps/dashboard/src/sections/agenda/lib.js) con '@youty/shared' rimappato su
// format.js. Le asserzioni descrivono il comportamento ATTUALE.
//
//   node --import ./register.mjs --test agenda-probes.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';

const lib = await import('../../frontend/apps/dashboard/src/sections/agenda/lib.js');
const { explainSlot, wlMatches, itemBlocks } = lib;

/* Giornata finta con due operatrici. Giulia (1) e Marta (2).
 * UNA visita di Aisha alle 10:00: piega con Giulia (30') e poi colore con
 * MARTA (60'). L'appuntamento è elencato nella riga dell'operatrice
 * PRINCIPALE (Giulia), come fa GET /api/agenda/day. */
const visit = {
  id: 77,
  status: 'confirmed',
  operator_id: 1,
  start: '2026-09-24T10:00:00+02:00',
  client: { full_name: 'Aisha Rahman' },
  total_duration_min: 90,
  items: [
    { id: 1, service_id: 10, service_name: 'Piega', operator_id: 1, duration_min: 30, soak_min: 0, price: 20, order: 0 },
    { id: 2, service_id: 11, service_name: 'Colore', operator_id: 2, duration_min: 60, soak_min: 0, price: 60, order: 1 },
  ],
};
const rowGiulia = {
  operator: { id: 1, name: 'Giulia Rossi' },
  windows: [['09:00', '18:00']],
  appointments: [visit],   // la visita sta QUI: Giulia è la principale
  pauses: [],
};
const rowMarta = {
  operator: { id: 2, name: 'Marta Bianchi' },
  windows: [['09:00', '18:00']],
  appointments: [],        // il colore di Marta non è elencato qui
  pauses: [],
};

test('PROBE F0: con tutte le righe, le 10:30 di Marta risultano occupate (corretto)', () => {
  const blocks = itemBlocks(visit);
  assert.equal(blocks[1].startMin, 10 * 60 + 30);   // il colore parte alle 10:30
  assert.equal(blocks[1].opId, 2);                  // e lo fa Marta

  const all = [rowGiulia, rowMarta];
  const verdict = explainSlot(rowMarta, 10 * 60 + 30, 30, { rows: all });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'busy');
});

test('PROBE F1: nascondendo la colonna di Giulia, lo stesso orario di Marta torna «Disponibile»', () => {
  // index.jsx passa a DayGrid `visibleRows`, non tutte le righe del giorno:
  //   const visibleRows = (dayData || []).filter((r) => vis[r.operator.id] !== false)
  // Spegnendo la chip di Giulia la visita esce dai dati e il colore di Marta
  // non è più visto da nessuna parte.
  const visibleRows = [rowMarta];
  const verdict = explainSlot(rowMarta, 10 * 60 + 30, 30, { rows: visibleRows });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, 'ok');
  assert.equal(verdict.label, 'Disponibile');
  console.log('PROBE F1: colonna nascosta → 10:30 di Marta «Disponibile» mentre sta lavorando (il server poi dà 409)');
});

test('PROBE F2: la lista d\'attesa del cliente legata a un\'operatrice secondaria non viene contata', () => {
  // Il backend (free_slot_event) considera compatibili le voci senza operatrice
  // O con QUALSIASI operatrice coinvolta nella visita:
  //   operator_ids = {item.operator_id for item in items} | {appointment.operator_id}
  const waitlist = [
    { id: 1, status: 'active', service_id: 11, operator_id: 2, client_name: 'Chiara', created_at: '2026-09-01T09:00:00Z' },
    { id: 2, status: 'active', service_id: 11, operator_id: null, client_name: 'Dalia', created_at: '2026-09-02T09:00:00Z' },
  ];
  const matched = wlMatches(waitlist, visit).map((w) => w.id);
  // la voce 1 chiede il colore CON Marta, che nella visita lo esegue davvero
  assert.deepEqual(matched, [2]);
  console.log('PROBE F2: la voce che chiede l\'operatrice secondaria (Marta) non compare fra i match del client');
});

test('PROBE F3: il badge del drag durante uno stacco usa la durata di TUTTA la visita', () => {
  // DayGrid.jsx (badge del drag):
  //   const durMin = d.kind === 'pause' ? ... : (d.block.appt.total_duration_min || d.block.dur);
  //   const start  = d.apptStart + (d.ns - d.orig);
  // Staccando il 2º servizio (colore, 60') e portandolo alle 14:00:
  const blocks = itemBlocks(visit);
  const dragged = blocks[1];                     // colore: 10:30, 60'
  const apptStart = 10 * 60, ns = 14 * 60, orig = dragged.startMin;
  const badgeStart = apptStart + (ns - orig);    // 13:30 (!), non 14:00
  const badgeDur = visit.total_duration_min;     // 90' (tutta la visita), non 60'
  assert.equal(badgeStart, 13 * 60 + 30);
  assert.equal(badgeDur, 90);
  // quello che accade davvero: il colore va alle 14:00 e dura 60'
  assert.equal(ns, 14 * 60);
  assert.equal(dragged.dur, 60);
  console.log('PROBE F3: stacco alle 14:00 di un servizio da 60\' → il badge annuncia 13:30–15:00');
});
