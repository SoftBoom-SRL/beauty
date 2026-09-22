// Corsie e spine dell'agenda. Il caso che conta: un appuntamento inserito sopra
// un altro (l'incastro che lo staff forza a mano) deve restare LEGGIBILE —
// prima i due riquadri finivano l'uno sull'altro e di quello sotto si vedeva
// solo il nome della cliente che spuntava da sotto.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COL_GUTTER, laneCss, laneLayout, serviceBands, visitSpines } from '../src/sections/agenda/lanes.js';

/** blocco finto: un servizio di `apptId`, dalle `start` per `dur` minuti */
const blk = (apptId, start, dur, { items = 1, soak = 0, itemId = null, client = 'Aisha' } = {}) => ({
  b: {
    apptId,
    item: { id: itemId ?? apptId * 100 + start },
    appt: { items: Array.from({ length: items }, (_, i) => ({ id: i })), client: { full_name: client } },
    activeMin: dur,
    soakMin: soak,
  },
  pos: { startMin: start, activeMin: dur, soakMin: soak },
});

const laneOf = (out, apptId) => out.find((x) => x.b.apptId === apptId);

test('appuntamenti che non si toccano stanno tutti a tutta larghezza', () => {
  const out = laneLayout([blk(1, 600, 60), blk(2, 720, 30)]);
  for (const x of out) {
    assert.equal(x.lane, 0);
    assert.equal(x.laneCount, 1);
  }
});

test('due appuntamenti sovrapposti finiscono in due corsie affiancate', () => {
  const out = laneLayout([blk(1, 600, 60), blk(2, 600, 30)]);
  assert.equal(laneOf(out, 1).laneCount, 2);
  assert.equal(laneOf(out, 2).laneCount, 2);
  assert.notEqual(laneOf(out, 1).lane, laneOf(out, 2).lane);
});

test('i servizi della stessa visita restano nella stessa corsia', () => {
  // Una visita di due servizi in fila, più un incastro sopra il primo.
  const out = laneLayout([
    blk(1, 600, 60, { items: 2, itemId: 11 }),
    blk(1, 660, 45, { items: 2, itemId: 12 }),
    blk(2, 600, 30),
  ]);
  const visita = out.filter((x) => x.b.apptId === 1);
  assert.equal(visita.length, 2);
  assert.equal(visita[0].lane, visita[1].lane, 'la visita non deve spezzarsi fra due corsie');
  assert.notEqual(visita[0].lane, laneOf(out, 2).lane);
});

test('un terzo sovrapposto porta a tre corsie, un quarto separato no', () => {
  const out = laneLayout([blk(1, 600, 60), blk(2, 600, 60), blk(3, 610, 20), blk(4, 800, 30)]);
  assert.equal(laneOf(out, 1).laneCount, 3);
  assert.equal(laneOf(out, 4).laneCount, 1);
  assert.equal(new Set([laneOf(out, 1).lane, laneOf(out, 2).lane, laneOf(out, 3).lane]).size, 3);
});

test('la posa conta nell’ingombro: due visite si sovrappongono solo per la posa', () => {
  // 30 minuti di lavoro + 60 di posa: la cliente occupa la poltrona fino alle 11:30.
  const out = laneLayout([blk(1, 600, 30, { soak: 60 }), blk(2, 660, 30)]);
  assert.equal(laneOf(out, 1).laneCount, 2, 'la posa deve contare come occupazione');
});

test('laneCss lascia sempre libero il corridoio a destra', () => {
  // Il corridoio è l'unico punto su cui passare il mouse quando un appuntamento
  // occupa la colonna: senza, non c'è dove cliccare per aggiungerne un altro.
  const intera = laneCss(0, 1);
  assert.equal(intera.left, 4);
  assert.equal(intera.right, 4 + COL_GUTTER);

  // Stringhe INTERE, non sottostringhe: `(100% - 30px)` e `/ 2` compaiono
  // identici in TUTTE le corsie, quindi gli assert su pezzi passavano anche se
  // il numero di corsia veniva ignorato del tutto — cioè proprio nel caso che
  // questo test dovrebbe sorvegliare.
  const slot = `((100% - ${4 + 4 + COL_GUTTER}px) / 2)`;
  const prima = laneCss(0, 2);
  const seconda = laneCss(1, 2);
  assert.equal(prima.left, `calc(4px + 0 * ${slot})`);
  assert.equal(seconda.left, `calc(4px + 1 * ${slot})`);
  // la larghezza tolta alla colonna comprende il corridoio, ed è la stessa per
  // tutte le corsie: a cambiare dev'essere solo il punto di partenza.
  assert.equal(prima.width, `calc(${slot} - 3px)`);
  assert.equal(seconda.width, prima.width);
  assert.notEqual(seconda.left, prima.left, 'due corsie diverse devono partire da punti diversi');

  // Anche a larghezza fissa (la spina della visita) la corsia conta: altrimenti
  // le spine di due appuntamenti incastrati si sovrapporrebbero sul bordo.
  const spina = laneCss(1, 2, 5);
  assert.equal(spina.left, seconda.left);
  assert.equal(spina.width, 5);
  assert.notEqual(spina.left, laneCss(0, 2, 5).left);
});

test('la spina copre tutta la visita e solo le visite multi-servizio', () => {
  const placed = laneLayout([
    blk(1, 600, 60, { items: 2, itemId: 11 }),
    blk(1, 660, 45, { items: 2, itemId: 12 }),
    blk(2, 780, 30),
  ]);
  const spine = visitSpines(placed);
  assert.equal(spine.length, 1, 'una sola spina: l’appuntamento singolo non ne ha');
  assert.equal(spine[0].apptId, 1);
  assert.equal(spine[0].startMin, 600);
  assert.equal(spine[0].endMin, 705);
  assert.equal(spine[0].count, 2);
});

test('nessuna spina se della visita in questa colonna c’è un solo servizio', () => {
  // L’altro servizio lo fa un’altra operatrice: in questa colonna non c’è nulla da legare.
  const placed = laneLayout([blk(1, 600, 60, { items: 2, itemId: 11 })]);
  assert.deepEqual(visitSpines(placed), []);
});

test('serviceBands divide la visita in proporzione alle durate', () => {
  const visita = { items: [
    { service_name: 'Colore', duration_min: 30, soak_min: 30, operator_id: 1 },
    { service_name: 'Piega', duration_min: 60, soak_min: 0, operator_id: 1 },
  ] };
  const b = serviceBands(visita);
  assert.equal(b.length, 2);
  assert.equal(b[0].fromPct, 0);
  assert.equal(b[0].toPct, 50);   // 60 minuti su 120, posa compresa
  assert.equal(b[1].fromPct, 50);
  assert.equal(b[1].toPct, 100);
  assert.equal(b[0].name, 'Colore');
});

test('serviceBands non divide niente con un servizio solo', () => {
  assert.deepEqual(serviceBands({ items: [{ service_name: 'Taglio', duration_min: 30 }] }), []);
  assert.deepEqual(serviceBands({ items: [] }), []);
  assert.deepEqual(serviceBands({}), []);
});
