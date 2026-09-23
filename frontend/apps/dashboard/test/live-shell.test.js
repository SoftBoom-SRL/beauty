// Guscio della dashboard: feed live senza doppioni e ricarica dopo un deploy.
// Caccia ai bug del 22/09/2026 (docs/bug-hunt-2026-09-22): 08-14 (contratto C20)
// e 11-11.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBatcher, createSeen } from '../src/liveSeen.js';
import { isChunkLoadError, reloadOnce, reloadPending, RELOAD_KEY, RELOAD_WINDOW_MS } from '../src/shell/chunkReload.js';

const ev = (id, type = 'appointment.created') => ({ id, type, summary: `evento ${id}`, actor_id: 2 });

test('C20: un evento riconsegnato dal polling o dallo stream arriva una volta sola', () => {
  const seen = createSeen();
  // primo giro: lo stream consegna 10 e 11
  assert.deepEqual(seen.fresh([ev(10), ev(11)]).map((e) => e.id), [10, 11]);
  // il polling di riserva rilegge la finestra di 15 s: 11 di nuovo, più 9 arrivato in ritardo
  assert.deepEqual(seen.fresh([ev(9), ev(11)]).map((e) => e.id), [9]);
  // riconnessione dello stream: tutto già visto → niente da consegnare
  assert.deepEqual(seen.fresh([ev(9), ev(10), ev(11)]), []);
});

test('C20: anche i doppioni dentro la stessa consegna si scartano', () => {
  const seen = createSeen();
  assert.deepEqual(seen.fresh([ev(5), ev(5), ev(6)]).map((e) => e.id), [5, 6]);
});

test('C20: la memoria è limitata ma tiene gli eventi recenti', () => {
  const seen = createSeen(3);
  seen.fresh([ev(1), ev(2), ev(3), ev(4)]);
  // 1 è uscito dalla memoria (il più vecchio), 2-4 no
  assert.deepEqual(seen.fresh([ev(1), ev(2), ev(3), ev(4)]).map((e) => e.id), [1]);
});

function memStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    data,
  };
}

test('11-11: gli errori di chunk mancante si riconoscono sui tre browser e su Vite', () => {
  assert.ok(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/NewApptModal-abc123.js')));
  assert.ok(isChunkLoadError(new TypeError('error loading dynamically imported module: https://x/assets/a.js')));
  assert.ok(isChunkLoadError(new TypeError('Importing a module script failed.')));
  assert.ok(isChunkLoadError(new Error('Unable to preload CSS for /assets/index-1.css')));
  assert.ok(!isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')")));
  assert.ok(!isChunkLoadError(null));
});

test('11-11: dopo un deploy si ricarica la pagina una volta, non in un ciclo', () => {
  const storage = memStorage();
  let reloads = 0;
  const reload = () => { reloads += 1; };
  const t0 = 1_800_000_000_000;
  assert.equal(reloadOnce({ storage, now: t0, reload }), true);
  assert.equal(reloads, 1);
  assert.equal(storage.data[RELOAD_KEY], String(t0));
  assert.equal(reloadPending(), true);
  // il chunk manca anche dopo la ricarica (deploy rotto): niente secondo giro
  assert.equal(reloadOnce({ storage, now: t0 + 5000, reload }), false);
  assert.equal(reloads, 1);
  // un deploy successivo, molto dopo, si ricarica di nuovo
  assert.equal(reloadOnce({ storage, now: t0 + RELOAD_WINDOW_MS + 1, reload }), true);
  assert.equal(reloads, 2);
});

test('11-11: senza sessionStorage non si ricarica da soli (nessun ciclo possibile)', () => {
  let reloads = 0;
  assert.equal(reloadOnce({ storage: null, reload: () => { reloads += 1; } }), false);
  const broken = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => {} };
  assert.equal(reloadOnce({ storage: broken, reload: () => { reloads += 1; } }), false);
  assert.equal(reloads, 0);
});

test('useLive: le consegne arrivate nella stessa finestra passano tutte, una volta per id', () => {
  // timer finti: `run()` fa scattare quello in attesa
  let pending = null;
  const timers = { set: (fn) => { pending = fn; return 1; }, clear: () => { pending = null; } };
  const run = () => { const fn = pending; pending = null; fn?.(); };
  const got = [];
  const batcher = createBatcher(250, (list) => got.push(list.map((e) => e.id)), timers);
  // due consegne ravvicinate: la cliente 7, poi la cliente 8 (e un doppione)
  batcher.push([ev(1, 'client.updated')]);
  batcher.push([ev(2, 'client.updated'), ev(1, 'client.updated')]);
  run();
  // prima arrivava solo l'ultima consegna, e la scheda della cliente 7 restava vecchia
  assert.deepEqual(got, [[1, 2]]);
  batcher.push([]);                  // una consegna senza eventi utili non riarma niente
  assert.equal(pending, null);
  batcher.push([ev(3)]);
  batcher.cancel();                  // smontaggio: niente callback dopo
  run();
  assert.deepEqual(got, [[1, 2]]);
});

test('useLive: con i timer veri non chiama setTimeout come metodo (Illegal invocation nel browser)', async () => {
  // Chrome e Safari rifiutano setTimeout invocato con un `this` che non è la
  // finestra: qui un setTimeout finto che si comporta allo stesso modo.
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  // (il modulo è già strict: una chiamata libera arriva con `this` undefined)
  const strict = (real) => function (...args) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return real(...args);
  };
  globalThis.setTimeout = strict(realSet);
  globalThis.clearTimeout = strict(realClear);
  try {
    const got = [];
    const batcher = createBatcher(5, (list) => got.push(list.map((e) => e.id)));
    batcher.push([ev(1)]);
    batcher.push([ev(2)]);
    await new Promise((resolve) => realSet(resolve, 30));
    assert.deepEqual(got, [[1, 2]]);
    batcher.push([ev(3)]);
    batcher.cancel();
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});
