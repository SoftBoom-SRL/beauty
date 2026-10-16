// Il pannello delle preferenze di visualizzazione della settimana
// (parts/ViewPrefs.jsx) e le due scelte nella griglia (16/10): colonne
// dinamiche o fisse, scritte nei blocchi anche verticali o solo orizzontali.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixedColumns } from '../src/sections/agenda/lib/week.js';
import { find, findAll, installDom, loadComponent, mount, spy, textOf } from './grid-harness.mjs';

const { default: ViewPrefs } = await loadComponent('apps/dashboard/src/sections/agenda/parts/ViewPrefs.jsx', { expand: ['Choice'] });
const { default: WeekBlock } = await loadComponent('apps/dashboard/src/sections/agenda/grid/WeekBlock.jsx');

const t = (it) => it;

test('il pannello: le due scelte con quella accesa e che cosa fa', () => {
  installDom();
  const setDynamicCols = spy(), setVerticalText = spy();
  const m = mount(ViewPrefs, { dynamicCols: true, setDynamicCols, verticalText: false, setVerticalText, t });
  const toggle = find(m.tree, (el) => el.type === 'button' && el.props['aria-label'] === 'Preferenze di visualizzazione');
  assert.equal(toggle.props['aria-expanded'], false);
  toggle.props.onClick();
  m.render();
  const choice = (label) => find(m.tree, (el) => el.type === 'button' && textOf(el) === label);
  assert.deepEqual(['Dinamica', 'Fissa', 'Anche verticali', 'Solo orizzontali'].map((l) => choice(l).props['aria-pressed']), [true, false, false, true]);
  const text = textOf(m.tree);
  assert.ok(text.includes('Chi ha più appuntamenti nel giorno ha la colonna più larga'));
  assert.ok(text.includes('Mai per lungo'));
  choice('Fissa').props.onClick();
  choice('Anche verticali').props.onClick();
  assert.deepEqual(setDynamicCols.calls, [[false]]);
  assert.deepEqual(setVerticalText.calls, [[true]]);
  m.unmount();
});

test('colonne fisse: tutte le sotto-colonne larghe uguali, qualunque sia il lavoro', () => {
  const days = [{ date: '2026-10-15', dayOps: [{ id: 1, weight: 7 }, { id: 2, weight: 0.6 }] }];
  assert.deepEqual(fixedColumns(days)[0].dayOps.map((o) => o.weight), [1, 1]);
  assert.equal(days[0].dayOps[0].weight, 7, 'senza toccare i dati');
});

test('scritte solo orizzontali: niente nome per lungo, restano le iniziali e l\'ora', () => {
  installDom();
  const a = { id: 9, status: 'confirmed', client_name: 'Maria Russo', operator_id: 1, startMin: 600, endMin: 690, items: [{ id: 91, service_id: 1, service_name: 'Colore', operator_id: 1, duration_min: 90, soak_min: 0 }] };
  const draw = (vertical) => WeekBlock({ a, vertical, colorOf: () => '#C9B8F2', t, canWrite: true, left: 0, width: '100%' });
  const both = draw(true);
  assert.ok(both.props.className.includes('dk-wblock--tall'));
  assert.ok(find(both, (el) => el.props?.className === 'dk-wblock__v'));
  const flat = draw(false);
  assert.equal(flat.props.className, 'dk-wblock');
  assert.equal(find(flat, (el) => el.props?.className === 'dk-wblock__v'), null);
  assert.equal(textOf(find(flat, (el) => el.props?.className === 'dk-wblock__ini')), 'MR10:00');
  assert.equal(findAll(flat, (el) => el.props?.className === 'dk-wblock__h').length, 1, 'da larghi le righe restano');
});
