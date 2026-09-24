// I sostituti di '@youty/shared' nei test devono esportare gli stessi aiuti
// puri dell'indice del pacchetto (src/index.js): test/shared-shim.mjs per i
// moduli provati con `npm test`, lo SHARED di apps/dashboard/test/grid-harness.mjs
// per i componenti dell'agenda. Un nome che c'è solo nel sostituto fa passare
// i test e rompe il build; un nome che c'è solo nell'indice fa il contrario:
// il modulo che lo importa non si carica sotto `npm test`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as shim from '@youty/shared';   // → test/shared-shim.mjs (vedi test/shared-loader.mjs)
import { loadComponent } from '../../../apps/dashboard/test/grid-harness.mjs';

/* I nomi esportati da un indice scritto a mano (blocchi `export { … } from`,
 * `export * from` da seguire, `export * as nome from`), per modulo d'origine:
 * { <url del modulo>: ['fmtEur', …], '*': ['staffAuth', …] }. */
function exportsOf(url, out = {}) {
  const src = readFileSync(url, 'utf8').replace(/\/\/.*$/gm, '');
  for (const [, list, from] of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const names = list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.split(/\s+as\s+/).pop());
    (out[new URL(from, url).href] ||= []).push(...names);
  }
  for (const [, ns] of src.matchAll(/export\s*\*\s*as\s+(\w+)\s+from/g)) (out['*'] ||= []).push(ns);
  for (const [, from] of src.matchAll(/export\s*\*\s*from\s*'([^']+)'/g)) exportsOf(new URL(from, url), out);
  return out;
}

const src = (f) => new URL(`../src/${f}`, import.meta.url).href;
const INDEX = exportsOf(new URL('../src/index.js', import.meta.url));
const ALL = new Set(Object.values(INDEX).flat());
// I moduli puri, che i sostituti riesportano veri (gli altri tirano dentro React o fetch).
const PURE = ['format.js', 'phone.js', 'apiErrors.js'];
// Lo SHARED della griglia non ha il telefono: i componenti che carica non lo usano.
const HARNESS = ['format.js', 'apiErrors.js'];
const missingIn = (mods, ns) => mods.flatMap((m) => INDEX[src(m)].filter((n) => !(n in ns)).map((n) => `${m}: ${n}`));

test('la lettura dell\'indice trova i moduli puri e i componenti', () => {
  for (const m of PURE) assert.ok(INDEX[src(m)]?.length, m);
  assert.ok(ALL.has('Avatar') && ALL.has('staffAuth') && ALL.has('api'));
});

test('test/shared-shim.mjs non esporta niente che l\'indice non abbia', () => {
  assert.deepEqual(Object.keys(shim).filter((n) => !ALL.has(n)), []);
});

test('test/shared-shim.mjs esporta ogni aiuto puro dell\'indice', () => {
  assert.deepEqual(missingIn(PURE, shim), []);
});

test('lo SHARED di grid-harness.mjs esporta gli aiuti puri, con un solo ApiError', async () => {
  const probe = (x) => `packages/shared/test/fixtures/harness-probe-${x}.js`;
  const { shared: a } = await loadComponent(probe('a'));
  assert.deepEqual(missingIn(HARNESS, a), []);
  assert.deepEqual(Object.keys(a).filter((n) => !ALL.has(n)), []);
  // Due componenti nello stesso file di test sono due bundle, ciascuno con la
  // sua copia di apiErrors.js: la classe resta una, quella che i test prendono
  // da globalThis.__ApiError.
  const { shared: b } = await loadComponent(probe('b'));
  assert.equal(b.ApiError, a.ApiError);
  assert.equal(globalThis.__ApiError, a.ApiError);
  const t = (it) => it;
  const err = new globalThis.__ApiError(409, 'Orario non più disponibile');
  assert.equal(a.apiErrorText(err, t), 'Orario non più disponibile');
  assert.equal(b.apiErrorText(err, t), 'Orario non più disponibile');
  assert.equal(b.apiErrorText(new Error('x'), t), 'Errore di rete');
});
