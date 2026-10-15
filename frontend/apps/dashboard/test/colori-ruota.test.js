// La ruota dei colori (ui/ColorWheel.jsx) e il testo leggibile sopra i colori
// del salone (ui/colorTools.js). 15/10: chi voleva un colore suo non lo
// trovava (il selettore del browser stava nascosto nel quadratino) o doveva
// conoscerne il codice; e sui colori scuri testi e icone restavano scuri.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hexToHsl, hslToHex, inkOn, pillVars } from '../src/ui/colorTools.js';
import { find, installDom, loadComponent, mount, ptr, rect, spy } from './grid-harness.mjs';

const { default: ColorWheel } = await loadComponent('apps/dashboard/src/ui/ColorWheel.jsx');

test('da codice a tinta, intensità e luce, e ritorno', () => {
  for (const hex of ['#E53935', '#1A237E', '#FDE2E4', '#00897B', '#7A5200', '#000000', '#FFFFFF', '#808080']) {
    const { h, s, l } = hexToHsl(hex);
    assert.equal(hslToHex(h, s, l), hex, hex);
  }
  assert.deepEqual(hexToHsl('#FF0000'), { h: 0, s: 1, l: 0.5 });
  assert.equal(hslToHex(120, 1, 0.25), '#008000');
  assert.equal(hexToHsl('var(--clay)'), null);
});

test('le pillole accese: testo bianco sui colori scuri, scuro sui chiari', () => {
  assert.deepEqual(pillVars('#1A237E'), { '--pill-c': '#1A237E', '--pill-ink': '#FFFFFF' });
  assert.deepEqual(pillVars('#FDE2E4'), { '--pill-c': '#FDE2E4', '--pill-ink': 'var(--ink)' });
  assert.equal(pillVars('var(--clay)')['--pill-ink'], 'var(--ink)', 'un colore che non si sa leggere resta com\'era');
  assert.equal(inkOn('#000000').ink, '#FFFFFF');
});

function wheel(value = '#E53935', extra = {}) {
  installDom();
  const onChange = spy(), onCommit = spy();
  const m = mount(ColorWheel, { value, onChange, onCommit, t: (it) => it, size: 132, ...extra });
  const ring = () => find(m.tree, (el) => el.props?.className === 'dk-cwheel__ring');
  const slider = () => find(m.tree, (el) => el.type === 'input' && el.props.type === 'range');
  const sample = () => find(m.tree, (el) => el.type === 'span' && el.props.children === 'Testo di prova');
  // la ruota a schermo: 132 px, centro a (66, 66)
  const at = (x, y) => ({ ...ptr(x, y), currentTarget: { getBoundingClientRect: () => rect(0, 0, 132, 132), setPointerCapture() {} } });
  return { m, onChange, onCommit, ring, slider, sample, at };
}

test('la ruota: il giro è la tinta, la distanza dal centro l\'intensità; si salva a dito alzato', () => {
  const g = wheel('#E53935');
  const { l } = hexToHsl('#E53935');
  // bordo destro: tinta 90° (verde-giallo), piena
  g.ring().props.onPointerDown(g.at(132, 66));
  g.m.render();
  assert.equal(g.onChange.calls.at(-1)[0], hslToHex(90, 1, l));
  // trascinando verso il basso, a metà raggio: tinta 180° (ciano), intensità 0,5
  g.ring().props.onPointerMove(g.at(66, 99));
  g.m.render();
  assert.equal(g.onChange.calls.at(-1)[0], hslToHex(180, 0.5, l));
  assert.equal(g.onCommit.calls.length, 0, 'mentre si trascina non si salva');
  g.ring().props.onPointerUp(g.at(66, 99));
  assert.deepEqual(g.onCommit.calls, [[hslToHex(180, 0.5, l)]]);
  // senza dito premuto il movimento non cambia niente
  g.ring().props.onPointerMove(g.at(0, 66));
  assert.equal(g.onChange.calls.length, 2);
});

test('la barra chiaro/scuro va dal nero al bianco passando per il colore', () => {
  const g = wheel('#E53935');
  const { h, s } = hexToHsl('#E53935');
  assert.equal(g.slider().props.style['--track'], `linear-gradient(to right, #000000, ${hslToHex(h, s, 0.5)}, #FFFFFF)`);
  g.slider().props.onChange({ target: { value: '20' } });
  g.m.render();
  assert.equal(g.onChange.calls.at(-1)[0], hslToHex(h, s, 0.2));
  // l'anteprima del testo: sul colore scuro diventa bianco
  assert.equal(g.sample().props.style.color, '#FFFFFF');
  g.slider().props.onChange({ target: { value: '90' } });
  g.m.render();
  assert.equal(g.sample().props.style.color, 'var(--ink)');
  g.slider().props.onPointerUp();
  assert.equal(g.onCommit.calls.at(-1)[0], hslToHex(h, s, 0.9));
});

test('dal nero un tocco sulla ruota porta a metà luce: altrimenti non cambierebbe niente', () => {
  const g = wheel('#000000');
  g.ring().props.onPointerDown(g.at(132, 66));
  assert.equal(g.onChange.calls.at(-1)[0], hslToHex(90, 1, 0.5));
});

test('un colore scelto altrove (tavolozza, codice) sposta la ruota; quello appena uscito no', () => {
  const g = wheel('#E53935');
  g.ring().props.onPointerDown(g.at(66, 66));   // al centro: grigio, la tinta non si ricava dal colore
  g.m.render();
  const grey = g.onChange.calls.at(-1)[0];
  g.m.render({ ...g.m.props, value: grey });
  // la tinta di prima resta: la barra non diventa rossa di colpo
  assert.equal(g.slider().props.style['--track'], `linear-gradient(to right, #000000, ${hslToHex(hexToHsl('#E53935').h, 0, 0.5)}, #FFFFFF)`);
  g.m.render({ ...g.m.props, value: '#1A237E' });
  g.m.render();
  assert.equal(g.slider().props.style['--thumb'], '#1A237E');
  // e di nuovo il grigio uscito dalla ruota: è un colore scelto altrove anche lui
  g.m.render({ ...g.m.props, value: grey });
  g.m.render();
  assert.equal(g.slider().props.style['--thumb'], grey);
});

test('dalla tastiera: frecce per tinta e intensità, il salvataggio al tasto lasciato', () => {
  const g = wheel('#FF0000');
  const key = (k, extra = {}) => ({ key: k, shiftKey: false, preventDefault() {}, ...extra });
  g.ring().props.onKeyDown(key('ArrowRight'));
  assert.equal(g.onChange.calls.at(-1)[0], hslToHex(5, 1, 0.5));
  g.ring().props.onKeyDown(key('ArrowDown', { shiftKey: true }));
  assert.equal(g.onChange.calls.at(-1)[0], hslToHex(5, 0.85, 0.5));
  g.ring().props.onKeyUp(key('ArrowDown'));
  assert.equal(g.onCommit.calls.length, 1);
  g.ring().props.onKeyDown(key('a'));
  assert.equal(g.onChange.calls.length, 2, 'gli altri tasti non toccano il colore');
});

test('in sola lettura la ruota non si tocca', () => {
  const g = wheel('#E53935', { disabled: true });
  g.ring().props.onPointerDown(g.at(132, 66));
  assert.equal(g.onChange.calls.length, 0);
  assert.equal(g.slider().props.disabled, true);
});
