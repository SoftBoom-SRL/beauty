// I colori dei trattamenti (le categorie dei servizi): le tinte proposte
// (ui/palette.js, ui/SwatchRows.jsx) e il testo leggibile sopra i blocchi
// della settimana (grid/WeekBlock.jsx). 15/10: le tinte disponibili erano
// tutte pastello, e in agenda le categorie non si distinguevano.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CAT_SWATCHES, TREATMENT_SWATCHES, nextTreatmentColor } from '../src/ui/palette.js';
import { hexRgb, wantsLightText } from '../src/sections/agenda/lib/colors.js';
import { find, findAll, installDom, loadComponent, spy, textOf } from './grid-harness.mjs';

const { default: SwatchRows } = await loadComponent('apps/dashboard/src/ui/SwatchRows.jsx');
const { default: WeekBlock } = await loadComponent('apps/dashboard/src/sections/agenda/grid/WeekBlock.jsx');

/** Saturazione HSL (0..1) di un "#RRGGBB". */
function saturation(hex) {
  const [r, g, b] = hexRgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

test('tre file di tinte: vivaci e scure sature, poi le tenui di prima', () => {
  assert.deepEqual(TREATMENT_SWATCHES.map((r) => r.key), ['vivid', 'deep', 'soft']);
  const [vivid, deep, soft] = TREATMENT_SWATCHES.map((r) => r.colors);
  assert.equal(soft, CAT_SWATCHES, 'le pastello restano per chi le preferisce');
  const all = [...vivid, ...deep];
  assert.equal(new Set(all.map((c) => c.toLowerCase())).size, all.length, 'nessun doppione');
  for (const c of all) assert.ok(saturation(c) >= 0.55, `${c} è saturo (${saturation(c).toFixed(2)})`);
  // le scure in agenda (all'82% sul bianco, come i blocchi) vogliono il testo bianco: si leggono
  for (const c of deep) assert.ok(wantsLightText(c, 0.82), `${c} è scuro davvero`);
  // le pastello di prima no: erano tutte chiarissime
  for (const c of soft) assert.equal(wantsLightText(c, 0.82), false);
});

test('una categoria nuova parte dalla prima tinta vivace che le altre non hanno', () => {
  const vivid = TREATMENT_SWATCHES[0].colors;
  assert.equal(nextTreatmentColor([]), vivid[0]);
  assert.equal(nextTreatmentColor([{ color: vivid[0].toLowerCase() }, { color: '#FDE2E4' }]), vivid[1]);
  // tutte usate: si ricomincia dal giro
  assert.equal(nextTreatmentColor(vivid.map((c) => ({ color: c }))), vivid[0]);
});

test('le file con il loro nome; il clic sceglie, la spunta si legge anche sulle scure', () => {
  installDom();
  const onChange = spy();
  const deep = TREATMENT_SWATCHES[1].colors[7];
  const tree = SwatchRows({ value: deep, onChange, t: (it) => it });
  assert.deepEqual(findAll(tree, (el) => el.type === 'span' && ['Vivaci', 'Scure', 'Tenui'].includes(textOf(el))).map(textOf), ['Vivaci', 'Scure', 'Tenui']);
  const sel = find(tree, (el) => el.type === 'button' && el.props['aria-pressed'] === true);
  assert.equal(sel.props.title, deep);
  const check = find(sel, (el) => typeof el.type === 'function');
  assert.equal(check.props.color, '#fff', 'spunta bianca sul blu notte');
  find(tree, (el) => el.type === 'button' && el.props.title === TREATMENT_SWATCHES[0].colors[0]).props.onClick();
  assert.deepEqual(onChange.calls, [[TREATMENT_SWATCHES[0].colors[0]]]);
});

test('in settimana il testo del blocco è bianco sulle tinte scure, scuro sulle chiare', () => {
  installDom();
  const a = {
    id: 1, startMin: 600, endMin: 660, client_name: 'Sara Bianchi', operator_id: 1, status: 'confirmed',
    items: [{ service_id: 5, operator_id: 1, duration_min: 60, soak_min: 0, service_name: 'Colore' }],
  };
  const nameColor = (col) => {
    const tree = WeekBlock({ a, colorOf: () => '#C9B8F2', itemColor: () => col, t: (it) => it, canWrite: true, left: 0, width: '100%' });
    return find(tree, (el) => el.type === 'div' && textOf(el) === 'Sara').props.style.color;
  };
  assert.equal(nameColor(TREATMENT_SWATCHES[1].colors[0]), '#FFFFFF', 'prima restava scuro sul rosso scuro');
  assert.equal(nameColor('#FDE2E4'), 'var(--ink)');
});
