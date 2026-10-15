// I colori dei trattamenti (le categorie dei servizi): le tinte proposte
// (ui/palette.js, ui/SwatchRows.jsx) e il testo leggibile sopra i blocchi
// della settimana (grid/WeekBlock.jsx). 15/10: le tinte disponibili erano
// tutte pastello, e in agenda le categorie non si distinguevano. Poi, lo
// stesso giorno: ogni servizio col colore della categoria o con uno suo
// (serviceColor, la scheda del servizio, l'agenda).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CAT_SWATCHES, TREATMENT_SWATCHES, nextTreatmentColor, serviceColor } from '../src/ui/palette.js';
import { hexRgb, wantsLightText } from '../src/sections/agenda/lib/colors.js';
import { find, findAll, installDom, loadComponent, mount, spy, textOf } from './grid-harness.mjs';

const { default: SwatchRows } = await loadComponent('apps/dashboard/src/ui/SwatchRows.jsx');
const { default: WeekBlock } = await loadComponent('apps/dashboard/src/sections/agenda/grid/WeekBlock.jsx');
const { default: SvcEditModal } = await loadComponent('apps/dashboard/src/sections/servizi/SvcEditModal.jsx');
const { useAgendaColors } = await loadComponent('apps/dashboard/src/sections/agenda/hooks/useAgendaColors.js');

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

/* ---- il colore di ogni servizio: della categoria o suo ---- */
const CATS = [{ id: 1, name_it: 'Capelli', color: '#FDE2E4' }, { id: 2, name_it: 'Unghie', color: '#039BE5' }];
const piega = { id: 7, name_it: 'Piega', category_id: 1, color: '', price: '20.00', duration_min: 30 };
const colore = { ...piega, id: 8, name_it: 'Colore', color: '#1A237E' };

test('il servizio col colore suo lo usa, senza quello della categoria', () => {
  assert.equal(serviceColor(piega, CATS), '#FDE2E4');
  assert.equal(serviceColor(colore, CATS), '#1A237E');
  assert.equal(serviceColor({ ...piega, color: undefined }, CATS), '#FDE2E4', 'un servizio letto prima del campo nuovo');
  assert.equal(serviceColor({ ...piega, category_id: 99 }, CATS), null);
  assert.equal(serviceColor(null, CATS), null);
});

test('in agenda i blocchi prendono il colore del servizio, poi della categoria, poi dell\'operatrice', () => {
  installDom();
  let colors = null;
  mount(() => { colors = useAgendaColors({ opColors: { 3: '#16A34A' }, services: [piega, colore], serviceCategories: CATS }); return null; }, {});
  assert.equal(colors.itemColor({ service_id: 8, operator_id: 3 }), '#1A237E');
  assert.equal(colors.itemColor({ service_id: 7, operator_id: 3 }), '#FDE2E4');
  assert.equal(colors.itemColor({ service_id: 99, operator_id: 3 }), '#16A34A', 'servizio che non c\'è più');
});

function svcCard(service) {
  installDom();
  const onSave = spy(() => Promise.resolve());
  const onCatColor = spy();
  const m = mount(SvcEditModal, {
    service, categories: CATS, operators: [], canTeam: false, canPricing: true,
    onSave, onClose: spy(), onCatColor, t: (it) => it, lang: 'it',
  });
  const seg = () => find(m.tree, (el) => typeof el.type === 'function' && el.props.options?.some((o) => o.value === 'own'));
  const swatches = () => find(m.tree, (el) => typeof el.type === 'function' && 'value' in el.props && el.props.t && el.props.onChange && !el.props.options);
  const save = async () => {
    // i bottoni stanno nel piede del modale (`foot`)
    const foot = find(m.tree, (el) => el.props?.foot).props.foot;
    find(foot, (el) => el.type === 'button' && textOf(el).includes('Salva')).props.onClick();
    await Promise.resolve();
    return onSave.calls.at(-1)[0];
  };
  return { m, seg, swatches, save, onCatColor };
}

test('scheda del servizio: di partenza il colore della categoria, e il salvataggio lo lascia vuoto', async () => {
  const g = svcCard(piega);
  assert.equal(g.seg().props.value, 'category');
  assert.ok(textOf(g.m.tree).includes('Vale per tutti i servizi di'), 'si modifica il colore della categoria');
  assert.equal((await g.save()).color, '');
});

test('scheda del servizio: «Personalizzato» parte dal colore della categoria e salva quello scelto', async () => {
  const g = svcCard(piega);
  g.seg().props.onChange('own');
  g.m.render();
  assert.equal(g.seg().props.value, 'own');
  assert.ok(textOf(g.m.tree).includes('Solo per questo servizio'));
  assert.equal(g.swatches().props.value, '#FDE2E4', 'il blocco non cambia finché non se ne sceglie un altro');
  g.swatches().props.onChange('#B71C1C');
  g.m.render();
  assert.equal((await g.save()).color, '#B71C1C');
  assert.equal(g.onCatColor.calls.length, 0, 'la categoria non si tocca');
});

test('scheda del servizio: un colore suo si riapre in «Personalizzato» e si può togliere', async () => {
  const g = svcCard(colore);
  assert.equal(g.seg().props.value, 'own');
  assert.equal(g.swatches().props.value, '#1A237E');
  g.seg().props.onChange('category');
  g.m.render();
  assert.equal(g.seg().props.value, 'category');
  assert.equal((await g.save()).color, '', 'torna al colore della categoria');
});
