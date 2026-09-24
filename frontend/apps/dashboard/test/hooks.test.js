// Gli hook generici della dashboard (src/hooks/): li usano più sezioni, e un
// cambio che ne sposta il comportamento si vedrebbe solo nel browser, una
// sezione alla volta. esbuild li compila con un React finto (hook in ordine di
// chiamata come quello vero, effetti subito dopo il render, stato aggiornato
// in un microtask) e qui si guarda che cosa restituiscono.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hooks');

const REACT = `
const R = globalThis.__hooksReact;
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
const slot = () => { const inst = R.inst; return [inst, inst.cursor++]; };
export function useState(init) {
  const [inst, i] = slot();
  if (!(i in inst.slots)) {
    const s = { v: typeof init === 'function' ? init() : init };
    s.set = (nv) => {
      const v = typeof nv === 'function' ? nv(s.v) : nv;
      if (Object.is(v, s.v)) return;
      s.v = v;
      inst.schedule();
    };
    inst.slots[i] = s;
  }
  return [inst.slots[i].v, inst.slots[i].set];
}
export function useRef(init) {
  const [inst, i] = slot();
  if (!(i in inst.slots)) inst.slots[i] = { current: init };
  return inst.slots[i];
}
export function useEffect(fn, deps) {
  const [inst, i] = slot();
  const prev = inst.slots[i];
  if (prev && deps && same(deps, prev.deps)) return;
  const rec = { deps, cleanup: prev ? prev.cleanup : null };
  inst.slots[i] = rec;
  inst.effects.push(() => { if (rec.cleanup) rec.cleanup(); const c = fn(); rec.cleanup = typeof c === 'function' ? c : null; });
}
export function useCallback(fn, deps) {
  const [inst, i] = slot();
  const prev = inst.slots[i];
  if (prev && deps && same(deps, prev.deps)) return prev.v;
  inst.slots[i] = { v: fn, deps };
  return fn;
}
`;

async function loadHooks() {
  const res = await build({
    stdin: {
      contents: ['useClickAway', 'useDebounced', 'useLatestRequest', 'useOnModalClosed', 'useResource', 'useStoredState']
        .map((n) => `export * from './${n}.js';`).join('\n'),
      resolveDir: HOOKS, loader: 'js',
    },
    bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
    plugins: [{
      name: 'react-finto',
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'finto' }));
        b.onLoad({ filter: /.*/, namespace: 'finto' }, () => ({ contents: REACT, loader: 'js' }));
      },
    }],
  });
  return import('data:text/javascript;base64,' + Buffer.from(res.outputFiles[0].text).toString('base64'));
}

const R = (globalThis.__hooksReact = { inst: null });
const H = await loadHooks();

/** Monta `runHook(props)`: `result` è l'ultimo valore restituito; gli
 *  aggiornamenti di stato ridisegnano in un microtask, tutti insieme. */
function mount(runHook, props) {
  const inst = { slots: [], cursor: 0, effects: [], props, result: undefined, pending: false, gone: false };
  const render = (next) => {
    if (next) inst.props = next;
    R.inst = inst; inst.cursor = 0; inst.effects = [];
    try { inst.result = runHook(inst.props); } finally { R.inst = null; }
    const fx = inst.effects; inst.effects = [];
    for (const f of fx) f();
    return inst.result;
  };
  inst.schedule = () => {
    if (inst.pending || inst.gone) return;
    inst.pending = true;
    queueMicrotask(() => { inst.pending = false; if (!inst.gone) render(); });
  };
  render();
  return {
    render,
    get result() { return inst.result; },
    unmount() {
      inst.gone = true;
      for (const s of inst.slots) if (s && typeof s.cleanup === 'function') s.cleanup();
    },
  };
}
const flush = () => new Promise((r) => setImmediate(r));

/** Una richiesta finta che si risolve (o fallisce) quando lo dice il test. */
function deferred() {
  const calls = [];
  const load = (tag) => () => new Promise((resolve, reject) => calls.push({ tag, resolve, reject }));
  return { calls, load };
}

/* ---------------------------------------------------------------- useResource */

test('useResource: carica all\'apertura, con loading acceso finché non risponde', async () => {
  const { calls, load } = deferred();
  const h = mount(() => H.useResource(load('a'), []));
  assert.equal(calls.length, 1);
  assert.deepEqual([h.result.data, h.result.loading], [null, true]);
  calls[0].resolve({ items: [1], count: 1 });
  await flush();
  assert.deepEqual([h.result.data, h.result.loading], [{ items: [1], count: 1 }, false]);
});

test('useResource: una dipendenza cambiata rilancia e la risposta vecchia si scarta', async () => {
  const { calls, load } = deferred();
  const h = mount(({ q }) => H.useResource(load(q), [q]), { q: 'a' });
  h.render({ q: 'a' });                  // stesse dipendenze: nessuna richiesta nuova
  assert.equal(calls.length, 1);
  h.render({ q: 'b' });
  assert.deepEqual(calls.map((c) => c.tag), ['a', 'b']);
  calls[1].resolve('B');
  await flush();
  calls[0].resolve('A');                 // arriva dopo, ma è di una richiesta superata
  await flush();
  assert.deepEqual([h.result.data, h.result.loading], ['B', false]);
});

test('useResource: se fallisce, `fallback` (quando c\'è) e onError una volta', async () => {
  const { calls, load } = deferred();
  const errs = [];
  const h = mount(() => H.useResource(load('a'), [], { fallback: { items: [], count: 0 }, onError: (e) => errs.push(e.message) }));
  calls[0].reject(new Error('rete'));
  await flush();
  assert.deepEqual([h.result.data, h.result.loading, errs], [{ items: [], count: 0 }, false, ['rete']]);
});

test('useResource: senza `fallback` un errore lascia il dato com\'era', async () => {
  const { calls, load } = deferred();
  const errs = [];
  const h = mount(({ n }) => H.useResource(load(n), [n], { onError: (e) => errs.push(e.message) }), { n: 1 });
  calls[0].resolve('primo');
  await flush();
  h.render({ n: 2 });
  await flush();                         // loading si riaccende nell'effetto
  assert.equal(h.result.loading, true);
  calls[1].reject(new Error('no'));
  await flush();
  assert.deepEqual([h.result.data, h.result.loading, errs], ['primo', false, ['no']]);
});

test('useResource: `enabled` falso non chiede niente e non segna il caricamento', async () => {
  const { calls, load } = deferred();
  const h = mount(({ on }) => H.useResource(load('x'), [], { enabled: on, initial: 'vuoto' }), { on: false });
  assert.equal(calls.length, 0);
  assert.deepEqual([h.result.data, h.result.loading], ['vuoto', false]);
  h.render({ on: true });
  assert.equal(calls.length, 1);
  await flush();
  assert.equal(h.result.loading, true);
});

test('useResource: a componente chiuso la risposta e l\'errore si ignorano', async () => {
  const { calls, load } = deferred();
  const errs = [];
  const h = mount(() => H.useResource(load('a'), [], { onError: (e) => errs.push(e) }));
  h.unmount();
  calls[0].reject(new Error('tardi'));
  await flush();
  assert.deepEqual(errs, []);
});

test('useResource: load e onError sono quelli del render che ha fatto partire la richiesta', async () => {
  const { calls, load } = deferred();
  const seen = [];
  const h = mount(({ lang }) => H.useResource(load(lang), [], { onError: () => seen.push(lang) }), { lang: 'it' });
  h.render({ lang: 'en' });              // nessuna dipendenza cambiata: la richiesta resta quella
  calls[0].reject(new Error('x'));
  await flush();
  assert.deepEqual([calls.length, seen], [1, ['it']]);
});

/* ---------------------------------------------------------- useLatestRequest */

test('useLatestRequest: vale solo l\'ultimo biglietto, e l\'oggetto non cambia fra i render', () => {
  const h = mount(() => H.useLatestRequest());
  const req = h.result;
  const a = req.begin();
  const b = req.begin();
  assert.deepEqual([req.isLatest(a), req.isLatest(b)], [false, true]);
  h.render();
  assert.equal(h.result, req);
  assert.equal(h.result.isLatest(b), true);
});

/* -------------------------------------------------------------- useDebounced */

test('useDebounced: il valore arriva dopo `ms` di quiete, e una battuta nuova riparte da capo', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = mount(({ v }) => H.useDebounced(v, 300), { v: '' });
    assert.equal(h.result, '');
    h.render({ v: 'ro' });
    mock.timers.tick(200);
    h.render({ v: 'ros' });              // prima dei 300 ms: il conto riparte
    mock.timers.tick(200);
    await flush();
    assert.equal(h.result, '');
    mock.timers.tick(100);
    await flush();
    assert.equal(h.result, 'ros');
  } finally { mock.timers.reset(); }
});

/* ------------------------------------------------------------ useStoredState */

function withStorage(storage, fn) {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { if (storage instanceof Error) throw storage; return storage; } });
  try { return fn(); } finally { delete globalThis.localStorage; }
}
const memStorage = (data = {}) => ({ data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } });
const flag = { read: (v) => v !== '0', write: (v) => (v ? '1' : '0'), fallback: true };

test('useStoredState: parte dal valore salvato e salva subito ogni cambio', async () => {
  const st = memStorage({ 'dk-x': '0' });
  await withStorage(st, async () => {
    const h = mount(() => H.useStoredState('dk-x', flag));
    assert.equal(h.result[0], false);
    h.result[1](true);
    assert.equal(st.data['dk-x'], '1');
    await flush();
    assert.equal(h.result[0], true);
  });
});

test('useStoredState: senza localStorage parte da `fallback` e non lancia', async () => {
  await withStorage(new Error('bloccato'), async () => {
    const h = mount(() => H.useStoredState('dk-x', flag));
    assert.equal(h.result[0], true);
    h.result[1](false);                  // il salvataggio fallisce in silenzio
    await flush();
    assert.equal(h.result[0], false);
  });
});

/* ---------------------------------------------------------- useOnModalClosed */

test('useOnModalClosed: solo quando si chiude uno dei modali indicati', () => {
  let n = 0;
  const h = mount(({ modal }) => H.useOnModalClosed(modal, ['newclient', 'bulkimport'], () => { n += 1; }), { modal: null });
  h.render({ modal: { name: 'newclient' } });
  assert.equal(n, 0);                    // l'apertura non conta
  h.render({ modal: null });
  assert.equal(n, 1);
  h.render({ modal: { name: 'catsmgr' } });
  h.render({ modal: null });
  assert.equal(n, 1);                    // un altro modale: niente
  h.render({ modal: { name: 'bulkimport' } });
  h.render({ modal: { name: 'newclient' } });   // passa da un modale all'altro: non è una chiusura
  assert.equal(n, 1);
});

/* -------------------------------------------------------------- useClickAway */

function fakeDocument() {
  const on = [];
  return {
    on,
    addEventListener: (type, fn, capture = false) => on.push({ type, fn, capture: !!capture }),
    removeEventListener: (type, fn, capture = false) => {
      const i = on.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture);
      if (i >= 0) on.splice(i, 1);
    },
    fire(type, ev) { for (const l of on.filter((x) => x.type === type)) l.fn(ev); },
  };
}

test('useClickAway: chiude al clic fuori, non dentro, e smette di ascoltare da chiuso', () => {
  const doc = fakeDocument();
  globalThis.document = doc;
  try {
    const inside = {};
    const ref = { current: { contains: (el) => el === inside } };
    let closed = 0;
    const onClose = () => { closed += 1; };
    const h = mount(({ open }) => H.useClickAway(ref, open, onClose), { open: false });
    assert.equal(doc.on.length, 0);
    h.render({ open: true });
    assert.deepEqual(doc.on.map((l) => [l.type, l.capture]), [['mousedown', false]]);
    doc.fire('mousedown', { target: inside });
    assert.equal(closed, 0);
    doc.fire('mousedown', { target: {} });
    assert.equal(closed, 1);
    h.render({ open: false });
    assert.equal(doc.on.length, 0);
  } finally { delete globalThis.document; }
});

test('useClickAway: con `escape` chiude con Esc e lo segna come preso; un Esc già preso si ignora', () => {
  const doc = fakeDocument();
  globalThis.document = doc;
  try {
    const ref = { current: { contains: () => false } };
    let closed = 0;
    const onClose = () => { closed += 1; };
    mount(() => H.useClickAway(ref, true, onClose, { event: 'pointerdown', capture: true, escape: true }));
    assert.deepEqual(doc.on.map((l) => [l.type, l.capture]), [['pointerdown', true], ['keydown', false]]);
    const esc = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    doc.fire('keydown', esc);
    assert.deepEqual([closed, esc.defaultPrevented], [1, true]);
    doc.fire('keydown', { key: 'Escape', defaultPrevented: true, preventDefault() {} });
    doc.fire('keydown', { key: 'Enter', defaultPrevented: false, preventDefault() {} });
    assert.equal(closed, 1);
  } finally { delete globalThis.document; }
});
