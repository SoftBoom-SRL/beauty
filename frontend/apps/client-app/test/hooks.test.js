// useApiData (src/hooks/useApiData.js): la chiamata all'apertura dello
// schermo e la guardia contro le risposte arrivate tardi, quella che ogni
// schermo si scriveva a mano con `let alive = true`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deferred, loadModule, renderHook, settle } from './load.mjs';

const { useApiData } = await loadModule('src/hooks/useApiData.js', { react: true });

test('prima null, poi i dati; con un errore, error e onError una volta sola', async () => {
  const ok = deferred();
  const h = renderHook(() => useApiData(() => ok.promise, []));
  assert.equal(h.result.data, null);
  assert.equal(h.result.error, null);
  ok.resolve({ gift_cards: [] });
  await settle();
  h.render();
  assert.deepEqual(h.result.data, { gift_cards: [] });
  assert.equal(h.result.error, null);

  const ko = deferred();
  const seen = [];
  const e = renderHook(() => useApiData(() => ko.promise, [], { onError: (err) => seen.push(err) }));
  const boom = new Error('rete');
  ko.reject(boom);
  await settle();
  e.render();
  assert.equal(e.result.data, null);
  assert.equal(e.result.error, boom);
  assert.deepEqual(seen, [boom]);
});

test('la chiamata si rifà quando cambiano le dipendenze, e conta solo l\'ultima', async () => {
  const calls = [];
  const load = (key) => () => { const d = deferred(); calls.push({ key, d }); return d.promise; };
  const h = renderHook((key) => useApiData(load(key), [key]), 'lun');
  h.render('lun');                  // stesse dipendenze: nessuna chiamata nuova
  assert.equal(calls.length, 1);
  h.render('mar');
  assert.deepEqual(calls.map((c) => c.key), ['lun', 'mar']);
  // la risposta di martedì arriva prima di quella, superata, di lunedì
  calls[1].d.resolve('orari di martedì');
  calls[0].d.resolve('orari di lunedì');
  await settle();
  h.render('mar');
  assert.equal(h.result.data, 'orari di martedì');
  // anche l'errore di una chiamata superata si ignora
  const errors = [];
  const g = renderHook((key) => useApiData(load(key), [key], { onError: (err) => errors.push(err) }), 'a');
  g.render('b');
  calls[2].d.reject(new Error('vecchia'));
  calls[3].d.resolve('nuova');
  await settle();
  g.render('b');
  assert.equal(g.result.data, 'nuova');
  assert.equal(g.result.error, null);
  assert.deepEqual(errors, []);
});

test('a schermo chiuso la risposta non si scrive e onError non parte', async () => {
  const ok = deferred();
  const h = renderHook(() => useApiData(() => ok.promise, []));
  h.unmount();
  ok.resolve('tardi');
  await settle();
  assert.equal(h.updates, 0);

  const ko = deferred();
  const errors = [];
  const e = renderHook(() => useApiData(() => ko.promise, [], { onError: (err) => errors.push(err) }));
  e.unmount();
  ko.reject(new Error('tardi'));
  await settle();
  assert.equal(e.updates, 0);
  assert.deepEqual(errors, []);
});

test('setData cambia i dati (aggiornamento ottimistico)', async () => {
  const ok = deferred();
  const h = renderHook(() => useApiData(() => ok.promise, []));
  ok.resolve({ lang: 'it', whatsapp_reminders: true });
  await settle();
  h.render();
  h.result.setData((m) => ({ ...m, lang: 'en' }));
  h.render();
  assert.deepEqual(h.result.data, { lang: 'en', whatsapp_reminders: true });
});

test('load e onError sono quelli del render in cui parte la chiamata', async () => {
  const ko = deferred();
  const seen = [];
  const h = renderHook((lang) => useApiData(() => ko.promise, [], { onError: () => seen.push(lang) }), 'it');
  h.render('en');                   // la chiamata è partita col primo render
  ko.reject(new Error('rete'));
  await settle();
  assert.deepEqual(seen, ['it']);
});
