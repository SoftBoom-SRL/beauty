// Banco di prova per i componenti dell'agenda (le griglie DayGrid e WeekView,
// la sezione, il pannello di dettaglio, il drawer «Nuova prenotazione»)
// senza browser. esbuild compila il componente VERO con un React finto — gli
// hook girano in modo sincrono, gli effetti subito dopo il render — e un DOM
// minimo fatto di rettangoli. Si chiamano gli stessi gestori che chiamerebbe
// il browser (pointerdown sul blocco, pointermove / pointerup / scroll sul
// contenitore, keydown su window) e si guarda che cosa arriva ai callback del
// padre. Non è un file di test: lo importano i *.test.js.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FRONT = join(here, '..', '..', '..');                         // frontend/
const FORMAT = join(FRONT, 'packages', 'shared', 'src', 'format.js');

/* React finto: stato per istanza (una per componente montato con mount()),
 * slot in ordine di chiamata come il React vero. */
const REACT = `
const R = globalThis.__mockReact || (globalThis.__mockReact = { inst: null });
const cur = () => { if (!R.inst) throw new Error('hook fuori da un render'); return R.inst; };
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
export function useState(init) {
  const inst = cur(); const i = inst.cursor++;
  if (!(i in inst.slots)) inst.slots[i] = { v: typeof init === 'function' ? init() : init };
  const s = inst.slots[i];
  return [s.v, (nv) => { s.v = typeof nv === 'function' ? nv(s.v) : nv; inst.dirty = true; }];
}
export function useRef(init) {
  const inst = cur(); const i = inst.cursor++;
  if (!(i in inst.slots)) inst.slots[i] = { current: init };
  return inst.slots[i];
}
function effect(fn, deps) {
  const inst = cur(); const i = inst.cursor++;
  const prev = inst.slots[i];
  if (prev && deps && same(deps, prev.deps)) return;
  const rec = { deps, cleanup: prev ? prev.cleanup : null };
  inst.slots[i] = rec;
  inst.effects.push(() => { if (rec.cleanup) rec.cleanup(); const c = fn(); rec.cleanup = typeof c === 'function' ? c : null; });
}
export const useEffect = effect;
export const useLayoutEffect = effect;
export function useCallback(fn, deps) {
  const inst = cur(); const i = inst.cursor++;
  const prev = inst.slots[i];
  if (prev && deps && same(deps, prev.deps)) return prev.v;
  inst.slots[i] = { v: fn, deps };
  return fn;
}
export function useMemo(fn, deps) {
  const inst = cur(); const i = inst.cursor++;
  const prev = inst.slots[i];
  if (prev && deps && same(deps, prev.deps)) return prev.v;
  const v = fn();
  inst.slots[i] = { v, deps };
  return v;
}
export const Fragment = 'Fragment';
// memo senza memoria: qui ogni render ridisegna comunque tutto (MonthGrid)
export const memo = (c) => c;
export function createElement(type, props, ...children) {
  const p = { ...(props || {}) };
  if (children.length) p.children = children.length === 1 ? children[0] : children;
  return { type, props: p, key: p.key ?? null };
}
export default { createElement, Fragment, memo, useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo };
`;

/* Il runtime JSX «automatico», lo stesso del build di Vite: i componenti non
 * importano React per scrivere JSX. Stessa forma degli elementi di
 * createElement (la key resta anche fra le props), così i test li leggono
 * allo stesso modo. */
const JSX_RUNTIME = `
export const Fragment = 'Fragment';
export function jsx(type, props, key) {
  const p = { ...(props || {}) };
  if (key !== undefined) p.key = key;
  return { type, props: p, key: p.key ?? null };
}
export const jsxs = jsx;
`;

/* @youty/shared: gli helper veri di format.js, labels.js, apiErrors.js e
 * clipboard.js, componenti muti, api finta. */
const SHARED = `
import * as apiErrors from ${JSON.stringify(join(FRONT, 'packages', 'shared', 'src', 'apiErrors.js'))};
export * from ${JSON.stringify(FORMAT)};
export * from ${JSON.stringify(join(FRONT, 'packages', 'shared', 'src', 'labels.js'))};
// la copia negli appunti vera: usa navigator e document di globalThis, che il test imposta
export { copyText } from ${JSON.stringify(join(FRONT, 'packages', 'shared', 'src', 'clipboard.js'))};
export const Avatar = () => null;
export const EmptyState = () => null;
export const Icon = () => null;
export const NumInput = () => null;
export const Toggle = () => null;
export const statusMeta = (s) => ({ label: String(s || ''), color: '#999' });
export { depositMeta } from ${JSON.stringify(join(FRONT, 'packages', 'shared', 'src', 'ui', 'meta.js'))};
// ApiError, apiErrorText e toastApiError sono quelli veri di apiErrors.js, con
// la stessa classe per il componente, per gli aiuti e per il test
// (globalThis.__ApiError). Ogni loadComponent è un bundle con la sua copia del
// modulo: si tiene quella del primo, altrimenti con due componenti caricati
// nello stesso file di test gli aiuti dell'uno non riconoscerebbero gli
// ApiError dell'altro.
const E = globalThis.__apiErrors || (globalThis.__apiErrors = apiErrors);
globalThis.__ApiError = E.ApiError;
export const { ApiError, apiErrorText, toastApiError } = E;
const call = (m) => (...a) => globalThis.__api[m](...a);
export const api = { get: call('get'), post: call('post'), put: call('put'), patch: call('patch'), del: call('del') };
// il valore di api.js quando VITE_API_URL manca (come in test/shared-shim.mjs)
export const API_URL = 'http://localhost:8000';
// i percorsi dei file così come sono (le copertine delle comunicazioni)
export const mediaUrl = (path) => path;
`;
/* ctx.jsx: il contesto è globalThis.__dash; useLive tiene l'ultima callback in
 * globalThis.__useLive, e il test la chiama con gli eventi (il debounce di 250
 * ms del vero useLive qui non c'è). */
const CTX = `export const useDash = () => globalThis.__dash;
export const useLive = (match, fn) => { globalThis.__useLive = fn; };`;

/** Compila `entry` (percorso dal frontend/) e ne restituisce i moduli esportati.
 *  `stubs`: nomi di file (es. 'RightRail.jsx') da sostituire con componenti muti
 *  che portano lo stesso nome — si guardano le props che ricevono.
 *  `expand`: nomi di sotto-componenti senza hook che findAll, find e textOf
 *  attraversano come se fossero scritti nel padre (vedi EXPAND).
 *  `import.meta.env` è vuoto, come in un build senza le variabili VITE_*: i
 *  moduli che lo leggono al caricamento (Impostazioni) si caricano lo stesso. */
export async function loadComponent(entry, { stubs = [], expand = [] } = {}) {
  expand.forEach((name) => EXPAND.add(name));
  const res = await build({
    entryPoints: [join(FRONT, entry)],
    bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
    define: { 'import.meta.env': '{}' },
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.jsx': 'jsx' },
    plugins: [{
      name: 'finti',
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'finto' }));
        b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx-runtime', namespace: 'finto' }));
        b.onResolve({ filter: /^@youty\/shared$/ }, () => ({ path: 'shared', namespace: 'finto' }));
        b.onResolve({ filter: /ctx\.jsx$/ }, () => ({ path: 'ctx', namespace: 'finto' }));
        b.onResolve({ filter: /\.jsx$/ }, (a) => {
          const base = a.path.split('/').pop();
          return stubs.includes(base) ? { path: 'stub:' + base, namespace: 'finto' } : undefined;
        });
        b.onLoad({ filter: /.*/, namespace: 'finto' }, (a) => {
          if (a.path.startsWith('stub:')) {
            const name = a.path.slice(5).replace(/\.jsx$/, '');
            return { contents: `export default function ${name}() { return null; }`, loader: 'js' };
          }
          return { contents: { react: REACT, 'jsx-runtime': JSX_RUNTIME, shared: SHARED, ctx: CTX }[a.path], loader: 'js', resolveDir: FRONT };
        });
      },
    }],
  });
  const code = res.outputFiles[0].text;
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}

/** Monta un componente: `render()` lo ridisegna (dopo un cambio di stato o di
 *  props), `attach(tree)` collega i nodi finti alle ref prima degli effetti. */
export function mount(Comp, props, { attach } = {}) {
  const R = globalThis.__mockReact || (globalThis.__mockReact = { inst: null });
  const inst = { slots: [], cursor: 0, effects: [], dirty: false, props };
  const m = {
    tree: null,
    render(nextProps) {
      if (nextProps) inst.props = nextProps;
      const prev = R.inst;
      R.inst = inst; inst.cursor = 0; inst.effects = []; inst.dirty = false;
      try { m.tree = Comp(inst.props); } finally { R.inst = prev; }
      if (attach) attach(m.tree);
      const fx = inst.effects; inst.effects = [];
      for (const f of fx) f();
      return m.tree;
    },
    get props() { return inst.props; },
    get dirty() { return inst.dirty; },
    /** smontaggio: le pulizie degli effetti (ascoltatori, timer) */
    unmount() {
      for (const sl of inst.slots) if (sl && typeof sl.cleanup === 'function') sl.cleanup();
    },
  };
  m.render();
  return m;
}

/* ---- albero degli elementi ---- */
/* Sotto-componenti «trasparenti»: i pezzi senza hook di una vista (la colonna
 * delle ore, il badge del trascinamento, le testate…). Nel browser li disegna
 * il React vero; qui l'albero si ferma ai componenti funzione, e per i test
 * quei pezzi fanno parte del padre: findAll, find e textOf li attraversano
 * chiamandoli come funzioni, e l'elemento del componente resta trovabile. Li
 * elenca loadComponent({ expand }); gli altri componenti (i blocchi, che i
 * test chiamano da sé) non si attraversano. */
const EXPAND = new Set();
const kids = (el) => {
  if (!el || typeof el !== 'object') return [];
  if (typeof el.type === 'function' && EXPAND.has(el.type.name)) return [el.type(el.props)].flat(Infinity);
  const c = el.props?.children;
  if (c == null || c === false || c === true) return [];
  return (Array.isArray(c) ? c : [c]).flat(Infinity);
};
/** Tutti gli elementi (non espande i componenti funzione, tranne quelli di
 *  `expand`) che soddisfano `pred`. */
export function findAll(tree, pred) {
  const out = [];
  const walk = (el) => {
    if (Array.isArray(el)) { el.forEach(walk); return; }
    if (!el || typeof el !== 'object' || !('props' in el)) return;
    if (pred(el)) out.push(el);
    kids(el).forEach(walk);
  };
  walk(tree);
  return out;
}
export const find = (tree, pred) => findAll(tree, pred)[0] || null;
/** Il testo di un elemento, figli compresi. */
export function textOf(el) {
  if (el == null || el === false || el === true) return '';
  if (typeof el === 'string' || typeof el === 'number') return String(el);
  if (Array.isArray(el)) return el.map(textOf).join('');
  return kids(el).map(textOf).join('');
}

/* ---- DOM finto ---- */
export const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });

/** window/document minimi. `pills`: [{ iso, rect }] della striscia dei giorni. */
export function installDom({ pills = [] } = {}) {
  const listeners = {};
  globalThis.window = {
    innerWidth: 1400, innerHeight: 900,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
  };
  globalThis.document = {
    body: { classList: { add() {}, remove() {} }, style: { setProperty() {}, removeProperty() {} } },
    querySelectorAll: (sel) => (sel === '[data-daydrop]'
      ? pills.map((p) => ({ getAttribute: () => p.iso, getBoundingClientRect: () => p.rect }))
      : []),
    querySelector: () => null,
  };
  return {
    fire(type, ev) { for (const fn of [...(listeners[type] || [])]) fn(ev); },
  };
}

/** Un evento puntatore con i campi che leggono i gestori. */
export function ptr(x, y, { id = 1, primary = true, button = 0 } = {}) {
  return {
    clientX: x, clientY: y, pointerId: id, isPrimary: primary, button,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  };
}

/** Registra le chiamate: spy.calls = [[...args], …]. */
export function spy(ret) {
  const f = (...a) => { f.calls.push(a); return typeof ret === 'function' ? ret(...a) : ret; };
  f.calls = [];
  return f;
}

export const tick = () => new Promise((r) => setImmediate(r));
