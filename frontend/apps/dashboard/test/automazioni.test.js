// Automazioni: una modifica arrivata mentre si lavora nel costruttore non butta
// via la bozza. Caccia ai bug del 22/09/2026: 15-13 (e 15-07 per il rinomina).
// In fondo il campo «Copia» dell'URL del webhook (controls.jsx vero, montato
// con test/grid-harness.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeRuleDraft } from '../src/sections/automazioni/draft.js';
import { findAll, installDom, loadComponent, mount, spy } from './grid-harness.mjs';

const { DkCopyField } = await loadComponent('apps/dashboard/src/sections/automazioni/controls.jsx');

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

test('«Copia» dell\'URL del webhook: «URL copiato» solo se la copia riesce, altrimenti lo si dice (voce 47)', async () => {
  installDom();
  const clipboard = (writeText) => Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText } }, configurable: true, writable: true });
  const URL = 'https://api.youty.it/api/automations/hooks/abc';
  const written = [];
  for (const [t, ko] of [
    [(it) => it, 'Copia non riuscita: seleziona l’URL e copialo a mano'],
    [(it, en) => en, 'Copy failed: select the URL and copy it by hand'],
  ]) {
    const fireToast = spy();
    globalThis.__dash = { fireToast };
    // il toast di successo lo dà il costruttore (Builder.jsx) con onCopy
    const onCopy = spy();
    const m = mount(DkCopyField, { value: URL, onCopy, t });
    try {
      const copy = () => findAll(m.tree, (el) => el.type === 'button')[0].props.onClick();
      clipboard(async (text) => { written.push(text); });
      await copy();
      assert.equal(onCopy.calls.length, 1);
      assert.deepEqual(fireToast.calls, []);
      // permesso negato: niente «URL copiato», ma l'errore
      clipboard(async () => { throw new Error('NotAllowedError'); });
      await copy();
      assert.equal(onCopy.calls.length, 1);
      assert.deepEqual(fireToast.calls, [[{ msg: ko, icon: 'alert' }]]);
    } finally { m.unmount(); }
  }
  assert.deepEqual(written, [URL, URL]);
});
