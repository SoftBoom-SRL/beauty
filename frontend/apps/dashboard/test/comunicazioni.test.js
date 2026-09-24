// Comunicazioni: niente invii programmati nel passato (caccia del 22/09/2026,
// 07-14). La data del campo è l'ora del SALONE, e «adesso» conta già come
// passata: il server rifiuta scheduled_at <= now. In fondo la sezione vera
// (test/grid-harness.mjs, modali muti): la lista e il suo caricamento.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setSalonTz } from '@youty/shared';
import { isPastSchedule, nowDtLocal } from '../src/sections/comunicazioni/helpers.js';
import { findAll, installDom, loadComponent, mount, spy, tick } from './grid-harness.mjs';

const { default: ComunicazioniSection } = await loadComponent('apps/dashboard/src/sections/comunicazioni/index.jsx', {
  stubs: ['ComEditModal.jsx', 'SendConfirmModal.jsx'],
});

test('una data di invio passata (o adesso) non si programma', () => {
  const now = Date.parse('2026-09-23T10:00:00+02:00');   // le 10 a Roma
  try {
    setSalonTz('Europe/Rome');
    assert.equal(isPastSchedule('2026-08-20T09:00', now), true);    // la bozza di un mese fa
    assert.equal(isPastSchedule('2026-09-23T09:59', now), true);
    assert.equal(isPastSchedule('2026-09-23T10:00', now), true);    // adesso: il server la rifiuta
    assert.equal(isPastSchedule('2026-09-23T10:01', now), false);
    assert.equal(isPastSchedule('', now), false);                   // nessuna data: nessun controllo
    // l'ora del campo è quella del salone: le 9 a New York sono le 15 a Roma
    setSalonTz('America/New_York');
    assert.equal(isPastSchedule('2026-09-23T09:00', now), false);
    assert.equal(isPastSchedule('2026-09-23T03:59', now), true);
  } finally {
    setSalonTz('Europe/Rome');
  }
});

test('il minimo del campo è adesso, sull’orologio del salone', () => {
  assert.match(nowDtLocal(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(isPastSchedule(nowDtLocal(), Date.now() + 60_000), true);
});

/* ---- la lista: filtro e caricamento ---- */

/** La sezione montata; ogni GET della lista aspetta la risposta della prova. */
function section() {
  installDom();
  globalThis.__dash = { t: (it) => it, lang: 'it', clientCategories: [], hasScope: () => true, fireToast: spy() };
  const reqs = [];
  globalThis.__api = {
    get: (url, opts) => new Promise((resolve) => reqs.push({ url, params: opts.params, resolve })),
  };
  const m = mount(ComunicazioniSection);
  const answer = async (req, items, count = items.length) => { req.resolve({ count, items }); await tick(); m.render(); };
  return {
    m, reqs, answer,
    filter: (v) => { findAll(m.tree, (el) => el.type?.name === 'GroupedFilterMenu')[0].props.groups[0].set(v); m.render(); },
    skeleton: () => findAll(m.tree, (el) => el.props?.className === 'skel').length > 0,
    cards: () => findAll(m.tree, (el) => el.type?.name === 'ComCard').map((el) => el.props.comm.title),
  };
}
const comm = (id, title, status) => ({ id, title, status, body: '', audience: 'all' });

test('cambiando filtro con una richiesta in volo resta lo scheletro, non la lista di prima (voce 46)', async () => {
  const s = section();
  try {
    await s.answer(s.reqs[0], [comm(1, 'Natale', 'sent')]);
    assert.deepEqual(s.cards(), ['Natale']);
    // «Bozze», e subito «Programmate» mentre le bozze sono ancora in volo
    s.filter('draft');
    s.filter('scheduled');
    assert.deepEqual(s.reqs.map((r) => r.params.status), ['', 'draft', 'scheduled']);
    assert.equal(s.skeleton(), true);
    // la risposta delle bozze, superata, arriva: non conta e non toglie lo
    // scheletro, che lasciava a video le campagne di «Tutti» sotto il filtro nuovo
    await s.answer(s.reqs[1], [comm(2, 'Bozza di primavera', 'draft')]);
    assert.equal(s.skeleton(), true);
    assert.deepEqual(s.cards(), []);
    await s.answer(s.reqs[2], [comm(3, 'Saldi estivi', 'scheduled')]);
    assert.equal(s.skeleton(), false);
    assert.deepEqual(s.cards(), ['Saldi estivi']);
  } finally { s.m.unmount(); }
});

test('«Carica altre» superato da un cambio di filtro non resta «Caricamento…»', async () => {
  const s = section();
  const more = () => findAll(s.m.tree, (el) => el.type === 'button' && el.props.className === 'dk-btn dk-btn--ghost')[0];
  try {
    await s.answer(s.reqs[0], [comm(1, 'Natale', 'sent')], 30);
    more().props.onClick();
    s.m.render();
    assert.equal(more().props.disabled, true);
    assert.equal(s.reqs[1].params.offset, 1);
    s.filter('draft');
    await s.answer(s.reqs[1], [comm(2, 'Pasqua', 'sent')], 30);
    await s.answer(s.reqs[2], [comm(3, 'Bozza di primavera', 'draft')], 30);
    assert.deepEqual(s.cards(), ['Bozza di primavera']);
    assert.equal(more().props.disabled, false);
  } finally { s.m.unmount(); }
});
