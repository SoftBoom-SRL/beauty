// Carica un modulo dell'app cliente che `node --test` da solo non saprebbe
// caricare, perché importa api.js, React o degli schermi .jsx: esbuild lo
// impacchetta con un '@youty/shared' finto (il sorgente `shared`, solo i nomi
// che servono alla prova), con ogni .jsx sostituito da un componente muto che
// porta il nome del file e, a richiesta, con un React finto per provare gli
// hook (vedi renderHook). Non è un file di test: lo importano i *.test.js.
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
export default { useState, useRef, useEffect, useCallback, useMemo };
`;

/** `entry` è un percorso da apps/client-app/ (es. 'src/api/client.js'). */
export async function loadModule(entry, { shared = '', react = false } = {}) {
  const res = await build({
    entryPoints: [join(APP, entry)],
    bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
    plugins: [{
      name: 'finti',
      setup(b) {
        b.onResolve({ filter: /^@youty\/shared$/ }, () => ({ path: 'shared', namespace: 'finto' }));
        if (react) b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'finto' }));
        b.onResolve({ filter: /\.jsx$/ }, (a) => ({ path: a.path.split('/').pop().replace(/\.jsx$/, ''), namespace: 'muto' }));
        b.onLoad({ filter: /.*/, namespace: 'finto' }, (a) => ({ contents: a.path === 'react' ? REACT : shared, loader: 'js' }));
        b.onLoad({ filter: /.*/, namespace: 'muto' }, (a) => ({
          contents: `export default function ${a.path.replace(/\W/g, '_')}() { return null; }`, loader: 'js',
        }));
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

/** Una Promise da risolvere o rifiutare a mano, per decidere l'ordine delle risposte. */
export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

/** Lascia girare le Promise già risolte (i .then delle risposte). */
export const settle = () => new Promise((r) => setImmediate(r));
