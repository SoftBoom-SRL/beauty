// Banco di prova per i componenti della griglia d'agenda (DayGrid, WeekView)
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
export function createElement(type, props, ...children) {
  const p = { ...(props || {}) };
  if (children.length) p.children = children.length === 1 ? children[0] : children;
  return { type, props: p, key: p.key ?? null };
}
export default { createElement, Fragment, useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo };
`;

/* @youty/shared: gli helper veri di format.js, componenti muti, api finta. */
const SHARED = `
export * from ${JSON.stringify(FORMAT)};
export const Avatar = () => null;
export const Icon = () => null;
export const NumInput = () => null;
export const statusMeta = (s) => ({ label: String(s || ''), color: '#999' });
// la stessa classe per il componente e per il test (globalThis.__ApiError)
export const ApiError = globalThis.__ApiError || (globalThis.__ApiError = class ApiError extends Error {
  constructor(status, message, data) { super(message); this.name = 'ApiError'; this.status = status; this.data = data; }
});
const call = (m) => (...a) => globalThis.__api[m](...a);
export const api = { get: call('get'), post: call('post'), put: call('put'), patch: call('patch'), del: call('del') };
`;
const CTX = 'export const useDash = () => globalThis.__dash;';

/** Compila `entry` (percorso dal frontend/) e ne restituisce i moduli esportati.
 *  `stubs`: nomi di file (es. 'RightRail.jsx') da sostituire con componenti muti
 *  che portano lo stesso nome — si guardano le props che ricevono. */
export async function loadComponent(entry, { stubs = [] } = {}) {
  const res = await build({
    entryPoints: [join(FRONT, entry)],
    bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
    jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
    loader: { '.js': 'jsx', '.jsx': 'jsx' },
    plugins: [{
      name: 'finti',
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'finto' }));
        b.onResolve({ filter: /^@youty\/shared$/ }, () => ({ path: 'shared', namespace: 'finto' }));
        b.onResolve({ filter: /ctx\.jsx$/ }, () => ({ path: 'ctx', namespace: 'finto' }));
        b.onResolve({ filter: /\.jsx$/ }, (a) => {
          const base = a.path.split('/').pop();
          return stubs.includes(base) ? { path: 'stub:' + base, namespace: 'finto' } : undefined;
        });
        b.onLoad({ filter: /.*/, namespace: 'finto' }, (a) => {
          if (a.path.startsWith('stub:')) {
            const name = a.path.slice(5).replace(/\.jsx$/, '');
            return { contents: `export default function ${name}() { return null; }\nexport function ApptHoverCard() { return null; }`, loader: 'js' };
          }
          return { contents: { react: REACT, shared: SHARED, ctx: CTX }[a.path], loader: 'js', resolveDir: FRONT };
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
const kids = (el) => {
  const c = el && typeof el === 'object' ? el.props?.children : null;
  if (c == null || c === false || c === true) return [];
  return (Array.isArray(c) ? c : [c]).flat(Infinity);
};
/** Tutti gli elementi (non espande i componenti funzione) che soddisfano `pred`. */
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
    body: { classList: { add() {}, remove() {} } },
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
