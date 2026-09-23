// Il pannello di dettaglio segue l'appuntamento e non perde le modifiche in
// sospeso. Caccia ai bug del 22/09/2026: 13-03 (pannello fermo sulla copia di
// quando si è aperto), 13-05 (servizi non salvati spariti con «›», «Passa a»,
// link caparra), 03-13 lato pannello (righe ricreate dal server).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  apptVersion, editRow, eventConcerns, isOlder, itemsSig, movedMeanwhile, rebaseDraft,
} from '../src/sections/agenda/modals/rules.js';

/* Maria alle 10:00 con Anna (1): taglio 30' + colore 60' (posa 30). */
const visit = (extra = {}) => ({
  id: 40,
  start: '2026-09-24T08:00:00Z',
  operator_id: 1,
  status: 'confirmed',
  note: '',
  updated_at: '2026-09-23T09:00:00.000000+00:00',
  items: [
    { id: 11, service_id: 3, service_name: 'Taglio', operator_id: 1, operator_name: 'Anna', duration_min: 30, soak_min: 0, price: '35.00' },
    { id: 12, service_id: 4, service_name: 'Colore', operator_id: 1, operator_name: 'Anna', duration_min: 60, soak_min: 30, price: '60.00' },
  ],
  ...extra,
});
const draftOf = (a) => a.items.map((it, i) => editRow(it, 'e' + i));
const piega = { key: 'e9', id: undefined, service_id: 5, operator_id: 1, duration_min: 30, soak_min: 0, price: 25, name: 'Piega' };

test('la Piega aggiunta e non salvata resta dopo lo spostamento del pannello', () => {
  const base = visit();
  const rows = [...draftOf(base), piega];
  const moved = visit({ start: '2026-09-24T08:15:00Z', updated_at: '2026-09-23T09:01:00+00:00' });
  const r = rebaseDraft({ base, rows, note: '', theirs: moved });
  assert.deepEqual(r.rows.map((x) => x.name), ['Taglio', 'Colore', 'Piega']);
  assert.equal(r.lost, 0);
  // e resta una modifica da salvare
  assert.notEqual(itemsSig(r.rows), itemsSig(moved.items));
});

test('«Passa a» cambia l’operatrice delle righe non toccate, la durata allungata resta mia', () => {
  const base = visit();
  const rows = draftOf(base);
  rows[1] = { ...rows[1], duration_min: 75 };
  const handed = visit({
    operator_id: 2,
    items: base.items.map((it) => ({ ...it, operator_id: 2, operator_name: 'Bea' })),
  });
  const r = rebaseDraft({ base, rows, note: '', theirs: handed });
  assert.deepEqual(r.rows.map((x) => [x.id, x.operator_id, x.duration_min]), [[11, 2, 30], [12, 2, 75]]);
  assert.equal(r.rows[1].key, 'e1');   // stessa riga a video
});

test('il servizio aggiunto da una collega compare, quello tolto da me resta tolto', () => {
  const base = visit();
  const rows = draftOf(base).filter((x) => x.id !== 11);          // tolgo il taglio
  const theirs = visit({
    items: [...base.items, { id: 13, service_id: 6, service_name: 'Maschera', operator_id: 1, duration_min: 15, soak_min: 0, price: '20.00' }],
  });
  const r = rebaseDraft({ base, rows, note: '', theirs });
  assert.deepEqual(r.rows.map((x) => x.id), [12, 13]);
  assert.equal(r.lost, 0);
});

test('righe ricreate altrove (id nuovi): la mia modifica non si riporta e lo si dice', () => {
  const base = visit();
  const rows = draftOf(base);
  rows[0] = { ...rows[0], duration_min: 45 };
  const resaved = visit({ items: base.items.map((it) => ({ ...it, id: it.id + 100 })) });
  const r = rebaseDraft({ base, rows, note: '', theirs: resaved });
  assert.deepEqual(r.rows.map((x) => [x.id, x.duration_min]), [[111, 30], [112, 60]]);
  assert.equal(r.lost, 1);
});

test('una bozza pulita segue la versione nuova così com’è', () => {
  const base = visit();
  const theirs = visit({ items: [base.items[1]] });                 // taglio staccato in griglia
  const r = rebaseDraft({ base, rows: draftOf(base), note: '', theirs });
  assert.equal(itemsSig(r.rows), itemsSig(theirs.items));
  assert.equal(r.lost, 0);
});

test('nota: se non l’ho toccata prendo quella nuova, se l’ho scritta resta la mia', () => {
  const base = visit({ note: 'allergica al nichel' });
  const theirs = visit({ note: 'allergica al nichel, porta il suo phon' });
  assert.equal(rebaseDraft({ base, rows: draftOf(base), note: 'allergica al nichel', theirs }).note, theirs.note);
  assert.equal(rebaseDraft({ base, rows: draftOf(base), note: 'mia nota', theirs }).note, 'mia nota');
});

test('gli eventi live che riguardano il pannello', () => {
  assert.ok(eventConcerns({ type: 'appointment.moved', payload: { appointment_id: 40 } }, 40));
  assert.ok(eventConcerns({ type: 'deposit.paid', payload: { appointment_id: '40' } }, 40));
  assert.ok(eventConcerns({ type: 'appointment.split', payload: { appointment_id: 7, created_id: 40 } }, 40));
  // l'annullamento non dice quale appuntamento ha rimesso a posto
  assert.ok(eventConcerns({ type: 'appointment.undone', payload: { undo_id: 3, kind: 'move' } }, 40));
  assert.ok(!eventConcerns({ type: 'appointment.moved', payload: { appointment_id: 41 } }, 40));
  assert.ok(!eventConcerns({ type: 'pause.created', payload: { pause_id: 40 } }, 40));
  assert.ok(!eventConcerns({ type: 'appointment.updated', payload: {} }, 40));
});

test('spostata nel frattempo: ora, operatrice o stato diversi da quelli visti', () => {
  const seen = visit();
  assert.ok(!movedMeanwhile(seen, visit({ note: 'altro' })));
  assert.ok(!movedMeanwhile(seen, visit({ start: '2026-09-24T10:00:00+02:00' })));  // stesso istante
  assert.ok(movedMeanwhile(seen, visit({ start: '2026-09-24T12:00:00Z' })));
  assert.ok(movedMeanwhile(seen, visit({ operator_id: 2 })));
  assert.ok(movedMeanwhile(seen, visit({ status: 'cancelled' })));
});

test('versione: una risposta vecchia non riporta indietro, una uguale non cambia niente', () => {
  const a = visit();
  assert.equal(apptVersion(a), apptVersion(visit()));
  assert.notEqual(apptVersion(a), apptVersion(visit({ deposit_status: 'paid' })));
  assert.ok(isOlder(visit({ updated_at: '2026-09-23T08:59:00Z' }), a));
  assert.ok(!isOlder(a, visit({ updated_at: undefined })));   // senza C2 non si decide
});
