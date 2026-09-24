// Carica un modulo dell'app cliente che `node --test` da solo non saprebbe
// caricare, perché importa api.js, React o degli schermi .jsx: esbuild lo
// impacchetta con un '@youty/shared' finto (il sorgente `shared`, solo i nomi
// che servono alla prova) e, a richiesta, con un React finto per provare hook
// e schermi (vedi renderHook e mount). I .jsx diventano componenti muti che
// portano il nome del file, oppure, con `jsx: true`, si compilano davvero
// (salvo quelli in `stubs`), con ctx.jsx sostituito dal sorgente `ctx`. Il
// modulo `entry` si compila sempre davvero, anche quando è un .jsx: così si
// prova anche ctx.jsx (AppProvider).
// Non è un file di test: lo importano i *.test.js.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');   // apps/client-app/

/* React finto: stato per istanza (una per renderHook), slot in ordine di
 * chiamata come il React vero; gli effetti girano subito dopo il render, e
 * quando le dipendenze cambiano prima si pulisce il precedente. I setter
 * cambiano lo stato e basta: il test ridisegna con render(). */
const REACT = `
const R = globalThis.__fakeReact || (globalThis.__fakeReact = { inst: null });
const cur = () => { if (!R.inst) throw new Error('hook fuori da un render'); return R.inst; };
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
export function useState(init) {
  const inst = cur(); const i = inst.cursor++;
  if (!(i in inst.slots)) inst.slots[i] = { v: typeof init === 'function' ? init() : init };
  const s = inst.slots[i];
  if (!s.set) s.set = (nv) => { s.v = typeof nv === 'function' ? nv(s.v) : nv; inst.updates += 1; };
  return [s.v, s.set];
}
export function useRef(init) {
  const inst = cur(); const i = inst.cursor++;
  if (!(i in inst.slots)) inst.slots[i] = { current: init };
  return inst.slots[i];
}
export function useEffect(fn, deps) {
  const inst = cur(); const i = inst.cursor++;
  const prev = inst.slots[i];
  if (prev && deps && same(deps, prev.deps)) return;
  const rec = { deps, cleanup: prev ? prev.cleanup : null };
  inst.slots[i] = rec;
  inst.effects.push(() => { if (rec.cleanup) rec.cleanup(); const c = fn(); rec.cleanup = typeof c === 'function' ? c : null; });
}
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
// il contesto: il valore è sempre quello predefinito (nessun Provider sopra)
export function createContext(value) { return { Provider: 'Provider', value }; }
export function useContext(c) { return c.value; }
export const Fragment = 'Fragment';
export default { useState, useRef, useEffect, useCallback, useMemo, createContext, useContext, Fragment };
`;

/* Il runtime JSX «automatico», come nel build di Vite: elementi { type, props, key }. */
const JSX_RUNTIME = `
export const Fragment = 'Fragment';
export function jsx(type, props, key) {
  const p = { ...(props || {}) };
  return { type, props: p, key: key === undefined ? null : key };
}
export const jsxs = jsx;
`;

/** `entry` è un percorso da apps/client-app/ (es. 'src/api/client.js'). */
export async function loadModule(entry, { shared = '', react = false, jsx = false, stubs = [], ctx = '' } = {}) {
  const muto = (a) => ({ path: a.path.split('/').pop().replace(/\.jsx$/, ''), namespace: 'muto' });
  const res = await build({
    entryPoints: [join(APP, entry)],
    bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
    jsx: 'automatic', loader: { '.js': 'jsx', '.jsx': 'jsx' },
    plugins: [{
      name: 'finti',
      setup(b) {
        b.onResolve({ filter: /^@youty\/shared$/ }, () => ({ path: 'shared', namespace: 'finto' }));
        if (react) {
          b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'finto' }));
          b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx-runtime', namespace: 'finto' }));
        }
        // il modulo da provare resta quello vero (vedi l'intestazione)
        const entryPoint = (a) => a.kind === 'entry-point';
        if (jsx) {
          b.onResolve({ filter: /(^|\/)ctx\.jsx$/ }, (a) => (entryPoint(a) ? undefined : { path: 'ctx', namespace: 'finto' }));
          b.onResolve({ filter: /\.jsx$/ }, (a) => (stubs.includes(a.path.split('/').pop()) ? muto(a) : undefined));
        } else {
          b.onResolve({ filter: /\.jsx$/ }, (a) => (entryPoint(a) ? undefined : muto(a)));
        }
        const SRC = { react: REACT, 'jsx-runtime': JSX_RUNTIME, shared, ctx };
        b.onLoad({ filter: /.*/, namespace: 'finto' }, (a) => ({ contents: SRC[a.path], loader: 'js', resolveDir: APP }));
        b.onLoad({ filter: /.*/, namespace: 'muto' }, (a) => {
          const name = a.path.replace(/\W/g, '_');
          return {
            contents: `export default function ${name}() { return null; }\n${name}.stub = true;\nexport { ${name} };`,
            loader: 'js',
          };
        });
      },
    }],
  });
  return import('data:text/javascript;base64,' + Buffer.from(res.outputFiles[0].text).toString('base64'));
}

/** Fa girare un hook col React finto: `render(...args)` lo ridisegna (anche
 *  con argomenti nuovi) ed esegue gli effetti, `result` è l'ultimo valore
 *  restituito, `updates` quante volte un setter ha cambiato lo stato,
 *  `unmount()` esegue le pulizie. */
export function renderHook(hook, ...args) {
  const R = globalThis.__fakeReact || (globalThis.__fakeReact = { inst: null });
  const inst = { slots: [], cursor: 0, effects: [], updates: 0 };
  const h = {
    result: undefined,
    get updates() { return inst.updates; },
    render(...next) {
      if (next.length) args = next;
      const prev = R.inst;
      R.inst = inst; inst.cursor = 0; inst.effects = [];
      try { h.result = hook(...args); } finally { R.inst = prev; }
      const fx = inst.effects; inst.effects = [];
      for (const f of fx) f();
      return h.result;
    },
    unmount() {
      for (const s of inst.slots) if (s && typeof s.cleanup === 'function') s.cleanup();
    },
  };
  h.render();
  return h;
}

/** Monta uno schermo col React finto: `tree` è l'albero degli elementi che
 *  restituisce, con i componenti figli già espansi (vedi expand). */
export function mount(Comp, props = {}) {
  const h = renderHook(Comp, props);
  return {
    get tree() { return expand(h.result); },
    render: () => h.render(props),
    unmount: () => h.unmount(),
  };
}

/** Sostituisce ogni componente figlio con quello che disegna. Si possono
 *  espandere solo i componenti senza hook (un hook fuori dal render dello
 *  schermo si ferma con un errore): quelli con gli hook vanno fra gli stub.
 *  Gli stub (funzioni con `.stub = true`) restano nell'albero con le loro
 *  props, così la prova li trova (il campo del telefono, l'icona). */
export function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== 'object' || !('props' in node)) return node;
  if (typeof node.type === 'function' && !node.type.stub) return expand(node.type(node.props));
  const kids = node.props.children;
  return kids === undefined ? node : { ...node, props: { ...node.props, children: expand(kids) } };
}

const kids = (el) => {
  const c = el && typeof el === 'object' ? el.props?.children : null;
  if (c == null || c === false || c === true) return [];
  return (Array.isArray(c) ? c : [c]).flat(Infinity);
};
/** Gli elementi dell'albero che soddisfano `pred`. */
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
/** Il testo di un elemento, figli compresi. */
export function textOf(el) {
  if (el == null || el === false || el === true) return '';
  if (typeof el === 'string' || typeof el === 'number') return String(el);
  if (Array.isArray(el)) return el.map(textOf).join('');
  return kids(el).map(textOf).join('');
}
/** Il pulsante (o link) il cui testo è `label` (stringa esatta o RegExp). */
export function button(tree, label) {
  const ok = (s) => (label instanceof RegExp ? label.test(s) : s === label);
  const found = findAll(tree, (el) => (el.type === 'button' || el.type === 'a') && ok(textOf(el).trim()));
  if (found.length !== 1) throw new Error(`pulsante «${label}»: ${found.length} trovati`);
  return found[0];
}

/** Una Promise da risolvere o rifiutare a mano, per decidere l'ordine delle risposte. */
export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

/** Lascia girare le Promise già risolte (i .then delle risposte). */
export const settle = () => new Promise((r) => setImmediate(r));
