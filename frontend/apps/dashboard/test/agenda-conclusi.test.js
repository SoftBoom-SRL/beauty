// Visite concluse e visite da fare, a colpo d'occhio (16/10): una visita
// chiusa alle 10 e una da fare alle 15 erano blocchi identici, in giorno, in
// settimana e nel mese, e per sapere che cosa restava della giornata
// bisognava aprirle. Ora la conclusa ha il colore appena accennato, il testo
// spento e la spunta; quella da fare il colore pieno (lib/colors.js, blockLook).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blockLook, inkOn, isDone, itemBlocks } from '../src/sections/agenda/lib.js';
import { find, installDom, loadComponent } from './grid-harness.mjs';

const { default: ItemBlock } = await loadComponent('apps/dashboard/src/sections/agenda/grid/ItemBlock.jsx');
const { default: WeekBlock } = await loadComponent('apps/dashboard/src/sections/agenda/grid/WeekBlock.jsx');
const { ApptLine } = await loadComponent('apps/dashboard/src/sections/agenda/month/DayParts.jsx');

const t = (it) => it;
const DARK = '#1A237E';
const done = (el) => find(el, (x) => x.props?.['data-done'] === '');

test('il colore di un blocco: pieno da fare, appena accennato e col testo spento se concluso', () => {
  assert.equal(isDone('closed'), true);
  for (const st of ['confirmed', 'checked_in', 'in_progress', 'no_show']) assert.equal(isDone(st), false, st);
  const todo = blockLook(DARK, 'in_progress');
  assert.deepEqual(todo, { done: false, bg: `color-mix(in srgb, ${DARK} 82%, #FFFFFF)`, ink: inkOn(DARK, 0.82), ring: null });
  assert.equal(todo.ink.ink, '#FFFFFF', 'da fare: bianco sul blu notte');
  const closed = blockLook(DARK, 'closed');
  assert.equal(closed.done, true);
  assert.equal(closed.bg, `color-mix(in srgb, ${DARK} 20%, #FFFFFF)`);
  assert.equal(closed.ink.ink, 'var(--ink-2)', 'concluso: testo spento, anche sul blu notte');
  assert.match(closed.ring, /^inset 0 0 0 1px /);
});

const visit = (status) => ({
  id: 9, status, operator_id: 1, start: '2026-10-15T10:00:00+02:00', client: { id: 7, full_name: 'Maria Russo' }, deposit_status: 'paid',
  items: [{ id: 91, service_id: 1, service_name: 'Colore', operator_id: 1, duration_min: 60, soak_min: 0, order: 0 }],
});

test('in giornata la conclusa ha la spunta al posto della caparra, niente ombra e il colore spento', () => {
  installDom();
  const draw = (status) => {
    const block = itemBlocks(visit(status))[0];
    return ItemBlock({ block, startMin: block.startMin, activeMin: block.activeMin, soakMin: 0, color: DARK, soakLabel: 'POSA', t, lang: 'it', canWrite: true, onDown() {}, onResizeDown() {} });
  };
  const todo = draw('confirmed');
  assert.equal(done(todo), null);
  assert.ok(find(todo, (x) => x.props?.title === 'Caparra incassata'), 'da fare: la caparra incassata');
  assert.equal(todo.props.style.background, blockLook(DARK, 'confirmed').bg);
  const closed = draw('closed');
  assert.ok(done(closed));
  assert.equal(find(closed, (x) => x.props?.title === 'Caparra incassata'), null, 'a conto chiuso la caparra non conta più');
  assert.equal(closed.props.style.background, blockLook(DARK, 'closed').bg);
  assert.equal(closed.props.style.boxShadow, blockLook(DARK, 'closed').ring);
});

test('in settimana la conclusa è spenta e la spunta sta una volta sola per gruppo di servizi attaccati', () => {
  installDom();
  const a = { id: 9, status: 'closed', client_name: 'Maria Russo', operator_id: 1, startMin: 600, endMin: 660, items: visit('closed').items };
  const draw = (extra = {}) => WeekBlock({ a, colorOf: () => '#C9B8F2', itemColor: () => DARK, t, canWrite: true, left: 0, width: '100%', ...extra });
  const tree = draw();
  assert.equal(tree.props.style.background, blockLook(DARK, 'closed').bg);
  assert.equal(tree.props.style.boxShadow, blockLook(DARK, 'closed').ring);
  assert.equal(find(tree, (x) => x.props?.className === 'dk-wblock__h').props.style.color, 'var(--ink-2)');
  assert.ok(done(tree));
  assert.equal(done(draw({ joinTop: true })), null, 'il servizio attaccato sotto non la ripete');
  assert.equal(done(WeekBlock({ a: { ...a, status: 'checked_in' }, colorOf: () => '#C9B8F2', itemColor: () => DARK, t, canWrite: true })), null);
});

test('nel mese la conclusa ha la spunta e il testo spento', () => {
  installDom();
  const a = { id: 9, start: '2026-10-15T10:00:00+02:00', client_name: 'Maria Russo', status: 'closed', gifts: [] };
  const line = ApptLine({ a, color: '#E53935', t });
  assert.ok(done(line));
  assert.equal(find(line, (x) => x.type === 'span' && x.props.children === 'Maria Russo').props.style.color, 'var(--muted)');
  const todo = ApptLine({ a: { ...a, status: 'confirmed' }, color: '#E53935', t });
  assert.equal(done(todo), null);
  assert.equal(find(todo, (x) => x.type === 'span' && x.props.children === 'Maria Russo').props.style.color, 'var(--ink)');
});
