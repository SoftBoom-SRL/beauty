// Il pannello di dettaglio segue l'appuntamento e non perde le modifiche in
// sospeso. Caccia ai bug del 22/09/2026: 13-03 (pannello fermo sulla copia di
// quando si è aperto), 13-05 (servizi non salvati spariti con «›», «Passa a»,
// link caparra), 03-13 lato pannello (righe ricreate dal server).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  apptVersion, editRow, eventConcerns, gapNotes, handoverOps, isOlder, itemSpans, itemsSig, movedMeanwhile, otherOpNames,
  rebaseDraft,
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
  // un server che non dice quale appuntamento ha rimesso a posto: si rilegge
  assert.ok(eventConcerns({ type: 'appointment.undone', payload: { undo_id: 3, kind: 'move' } }, 40));
  // quando lo dice, solo i pannelli di quelle visite (anche di una tolta)
  assert.ok(eventConcerns({ type: 'appointment.undone', payload: { undo_id: 3, appointment_ids: [39, 40] } }, 40));
  assert.ok(!eventConcerns({ type: 'appointment.undone', payload: { undo_id: 3, appointment_ids: [41] } }, 40));
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

/* ---- chi prende la visita, orari delle righe e attese (erano nel pannello) ---- */
// Le espressioni del pannello, copiate com'erano.
function wasHandover(appt, operators) {
  const mainItems = (appt.items || []).filter((it) => (it.operator_id ?? appt.operator_id) === appt.operator_id);
  const visitOps = operators.filter((op) => op.id === appt.operator_id
    || (mainItems.length > 0 && mainItems.every((it) => (op.service_ids || []).includes(it.service_id))));
  const otherOpNames = [...new Set((appt.items || [])
    .filter((it) => it.operator_id && it.operator_id !== appt.operator_id)
    .map((it) => operators.find((x) => x.id === it.operator_id)?.first_name || it.operator_name)
    .filter(Boolean))];
  return { visitOps, otherOpNames };
}
function wasSpans(editItems, startMin, catalogSoak) {
  const itemSpans = (() => {
    let cursor = startMin;
    return editItems.map((it) => {
      const from = cursor;
      const to = from + Math.max(0, parseInt(it.duration_min, 10) || 0);
      const gap = Math.max(0, parseInt(it.soak_min, 10) || 0);
      cursor = to + gap;
      return { from, to, gap, next: cursor };
    });
  })();
  const gapNotes = editItems.map((it, i) => {
    if (i >= editItems.length - 1) return null;
    const extra = (itemSpans[i].gap || 0) - catalogSoak(it);
    return extra > 0 ? { index: i, minutes: extra, gap: itemSpans[i].gap } : null;
  }).filter(Boolean);
  return { itemSpans, gapNotes };
}

test('«Passa a»: l\'operatrice principale e chi sa fare tutti i suoi servizi; la parte delle colleghe resta loro', () => {
  const ops = [
    { id: 1, first_name: 'Anna', service_ids: [3, 4] },
    { id: 2, first_name: 'Giulia', service_ids: [3] },
    { id: 4, first_name: 'Bea', service_ids: [3, 4, 5] },
  ];
  const cases = [
    visit(),
    visit({ items: [...visit().items, { id: 13, service_id: 5, service_name: 'Piega', operator_id: 2, operator_name: 'Giulia', duration_min: 30 }] }),
    visit({ items: [{ id: 14, service_id: 5, operator_id: 9, operator_name: 'Ex collega', duration_min: 30 }] }),
    visit({ items: [] }),
    visit({ items: [{ id: 15, service_id: 3, operator_id: null, duration_min: 30 }] }),
  ];
  for (const a of cases) {
    const was = wasHandover(a, ops);
    assert.deepEqual(handoverOps(a, ops), was.visitOps);
    assert.deepEqual(otherOpNames(a, ops), was.otherOpNames);
  }
  assert.deepEqual(handoverOps(visit(), ops).map((o) => o.id), [1, 4]);
  assert.deepEqual(otherOpNames(cases[1], ops), ['Giulia']);
  assert.deepEqual(otherOpNames(cases[2], ops), ['Ex collega']);
});

test('orari delle righe e attese oltre la posa del listino', () => {
  const soak = { 3: 0, 4: 30, 5: 0 };
  const catalogSoak = (it) => soak[it.service_id] || 0;
  const rows = [
    [],
    draftOf(visit()),
    [...draftOf(visit()), piega],
    [{ ...draftOf(visit())[0], soak_min: 20 }, { ...draftOf(visit())[1], duration_min: '' }, { ...piega, soak_min: '15' }],
    [{ ...piega, duration_min: 'x', soak_min: -5 }, { ...piega, key: 'e10' }],
  ];
  for (const r of rows) {
    const was = wasSpans(r, 600, catalogSoak);
    const spans = itemSpans(r, 600);
    assert.deepEqual(spans, was.itemSpans);
    assert.deepEqual(gapNotes(r, spans, catalogSoak), was.gapNotes);
  }
  const spans = itemSpans(rows[3], 600);
  assert.deepEqual(spans.map((x) => [x.from, x.to, x.gap]), [[600, 630, 20], [650, 650, 30], [680, 710, 15]]);
  assert.deepEqual(gapNotes(rows[3], spans, catalogSoak), [{ index: 0, minutes: 20, gap: 20 }]);
});
