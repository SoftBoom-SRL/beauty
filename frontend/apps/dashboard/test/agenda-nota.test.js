// Icona della nota sul blocco (richiesta Discord 1571903891501744218, punto
// 11): un appuntamento con una nota era identico agli altri, e per sapere che
// c'era qualcosa da leggere bisognava aprirlo. Ora il blocco ha il segno della
// nota (una volta per visita), in giornata e in settimana.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasNote, itemBlocks } from '../src/sections/agenda/lib.js';
import { find, installDom, loadComponent } from './grid-harness.mjs';

const { default: ItemBlock } = await loadComponent('apps/dashboard/src/sections/agenda/grid/ItemBlock.jsx');
const { default: WeekBlock } = await loadComponent('apps/dashboard/src/sections/agenda/grid/WeekBlock.jsx');

const t = (it) => it;
const noteMark = (el) => find(el, (x) => x.props?.['data-note'] === '');
const items = [
  { id: 91, service_id: 1, service_name: 'Colore', operator_id: 1, duration_min: 60, soak_min: 0, order: 0 },
  { id: 92, service_id: 2, service_name: 'Piega', operator_id: 1, duration_min: 30, soak_min: 0, order: 1 },
];
const visit = (note) => ({ id: 9, status: 'confirmed', operator_id: 1, start: '2026-10-15T10:00:00+02:00', client: { id: 7, full_name: 'Maria Russo' }, note, items });

test('hasNote: solo una nota con del testo', () => {
  assert.equal(hasNote({ note: 'Allergica al nichel' }), true);
  assert.equal(hasNote({ note: '   ' }), false);
  assert.equal(hasNote({ note: '' }), false);
  assert.equal(hasNote({}), false);
  assert.equal(hasNote(null), false);
});

test('in giornata il segno della nota sta sul primo servizio, col testo nel titolo', () => {
  installDom();
  const draw = (note, i) => {
    const block = itemBlocks(visit(note))[i];
    return ItemBlock({ block, startMin: block.startMin, activeMin: block.activeMin, soakMin: 0, color: '#C9B8F2', t, lang: 'it', canWrite: true, onDown() {}, onResizeDown() {} });
  };
  const mark = noteMark(draw('Allergica al nichel', 0));
  assert.ok(mark, 'il primo servizio ha il segno');
  assert.equal(mark.props.title, 'Allergica al nichel');
  assert.equal(noteMark(draw('Allergica al nichel', 1)), null, 'il secondo servizio no: una volta per visita');
  assert.equal(noteMark(draw('', 0)), null, 'senza nota niente segno');
});

test('in settimana il segno della nota sta sul primo pezzo della visita', () => {
  installDom();
  const a = { id: 9, status: 'confirmed', client_name: 'Maria Russo', operator_id: 1, startMin: 600, endMin: 690, items, note: 'Porta il campione' };
  const draw = (extra = {}) => WeekBlock({ a: { ...a, ...extra }, colorOf: () => '#C9B8F2', t, canWrite: true, left: 0, width: '100%' });
  assert.equal(noteMark(draw()).props.title, 'Porta il campione');
  assert.equal(noteMark(draw({ part: 2, parts: 2 })), null, 'il secondo pezzo no');
  assert.equal(noteMark(draw({ note: '' })), null);
});
