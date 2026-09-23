// Automazioni: una modifica arrivata mentre si lavora nel costruttore non butta
// via la bozza. Caccia ai bug del 22/09/2026: 15-13 (e 15-07 per il rinomina).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeRuleDraft } from '../src/sections/automazioni/draft.js';

const base = {
  name: 'Promemoria 24h', event: 'appointment_upcoming', offset_direction: 'before', offset_value: 24,
  offset_unit: 'hours', send_time: null, join: 'and',
  conds: [{ id: 'c1', field: 'reliability', cmp: 'gte', value: 60 }],
  trigger_origin: 'yourang', active: true,
};

test('15-13: mettere in pausa dalla lista non cancella filtri e anticipo non salvati', () => {
  // nel costruttore: anticipo portato a 48 h e un filtro in più (non salvati)
  const cur = { ...base, offset_value: 48, conds: [...base.conds, { id: 'c2', field: 'visits', cmp: 'gte', value: 2 }] };
  // intanto l'interruttore della lista mette in pausa la stessa regola
  const fresh = { ...base, active: false, conds: [{ id: 'r9', field: 'reliability', cmp: 'gte', value: 60 }] };
  const { draft, conflicts } = mergeRuleDraft(cur, base, fresh);
  assert.deepEqual(conflicts, []);
  assert.equal(draft.active, false);          // il gesto della lista vale
  assert.equal(draft.offset_value, 48);       // le mie modifiche restano
  assert.equal(draft.conds.length, 2);
});

test('15-07: il rinomina dell’etichetta riscritto dal server arriva nelle condizioni non toccate', () => {
  const b = { ...base, conds: [{ id: 'c1', field: 'categories', cmp: 'contains', value: 'A rischio' }] };
  const fresh = { ...b, conds: [{ id: 'r1', field: 'categories', cmp: 'contains', value: 'Da seguire' }] };
  const { draft, conflicts } = mergeRuleDraft({ ...b, name: 'Richiamo' }, b, fresh);
  assert.deepEqual(conflicts, []);
  assert.equal(draft.conds[0].value, 'Da seguire');
  assert.equal(draft.name, 'Richiamo');
});

test('lo stesso campo cambiato qui e altrove resta il mio ed è segnalato', () => {
  const { draft, conflicts } = mergeRuleDraft({ ...base, offset_value: 48 }, base, { ...base, offset_value: 12 });
  assert.equal(draft.offset_value, 48);
  assert.deepEqual(conflicts, ['offset_value']);
});

test('condizioni uguali: si tengono le righe della bozza (key stabili)', () => {
  const fresh = { ...base, conds: [{ id: 'r5', field: 'reliability', cmp: 'gte', value: 60 }] };
  const { draft } = mergeRuleDraft(base, base, fresh);
  assert.equal(draft.conds, base.conds);
});
