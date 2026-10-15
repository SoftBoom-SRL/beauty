// Aggiuntivi nella prenotazione della cliente (15/10): la nail art si fa
// durante la manicure. Da sola non si prenota — il server risponde 422 —,
// quindi non è fra i servizi: compare come «Aggiungi» sotto il servizio
// scelto, col suo prezzo, non allunga la visita e va nella richiesta subito
// dietro il suo servizio, senza l'operatrice scelta (la decide il server: chi
// fa il servizio, se la sa fare).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isoAtMin, todayStr } from '@youty/shared';
import { addonsOf, bookingItems, toggleAddon, toggleMain } from '../src/screens/prenota/addons.js';
import { fakeCtx, loadScreen, pending, reply, tap, text } from './fake-app.mjs';
import { button, findAll, mount } from './load.mjs';

const { default: Prenota } = await loadScreen('src/screens/prenota/index.jsx', ['DepositDue.jsx']);

const CATS = [
  { id: 2, name_it: 'Unghie', name_en: 'Nails', services: [
    { id: 20, name_it: 'Manicure', name_en: 'Manicure', price: '25.00', duration_min: 30 },
    { id: 21, name_it: 'Nail art', name_en: 'Nail art', price: '10.00', duration_min: 15, is_addon: true },
    { id: 22, name_it: 'Pedicure', name_en: 'Pedicure', price: '30.00', duration_min: 45 },
  ] },
  // una categoria di soli aggiuntivi non compare: non c'è niente da prenotare
  { id: 3, name_it: 'Extra', name_en: 'Extra', services: [
    { id: 30, name_it: 'Scrub', name_en: 'Scrub', price: '8.00', duration_min: 10, is_addon: true },
  ] },
];
const OPS = [
  // Luna fa manicure e pedicure ma non la nail art: si può scegliere lo stesso
  { id: 6, first_name: 'Luna', last_name: 'Bianchi', initials: 'LB', color: '#ddd', service_ids: [20, 22] },
  { id: 7, first_name: 'Sara', last_name: 'Verdi', initials: 'SV', color: '#eee', service_ids: [20, 21, 30] },
];
const isAddon = (id) => [21, 30].includes(id);

test('la fila degli id: ogni servizio seguito dai suoi aggiuntivi', () => {
  let ids = toggleMain([], 20, isAddon);
  ids = toggleMain(ids, 22, isAddon);
  ids = toggleAddon(ids, 20, 21, isAddon);
  ids = toggleAddon(ids, 20, 30, isAddon);
  assert.deepEqual(ids, [20, 21, 30, 22]);
  assert.deepEqual(addonsOf(ids, 20, isAddon), [21, 30]);
  assert.deepEqual(addonsOf(ids, 22, isAddon), []);
  // una volta sola per visita: scelto sotto la pedicure si sposta lì
  assert.deepEqual(toggleAddon(ids, 22, 30, isAddon), [20, 21, 22, 30]);
  // di nuovo sotto lo stesso servizio: si toglie
  assert.deepEqual(toggleAddon(ids, 20, 21, isAddon), [20, 30, 22]);
  // togliendo la manicure se ne vanno anche i suoi aggiuntivi
  assert.deepEqual(toggleMain(ids, 20, isAddon), [22]);
  // l'operatrice scelta vale per i servizi, l'aggiuntivo lo assegna il server
  assert.deepEqual(bookingItems([20, 21], 6, isAddon), [{ service_id: 20, operator_id: 6 }, { service_id: 21, operator_id: null }]);
});

test('la nail art non è fra i servizi: si aggiunge sotto la manicure, non allunga la visita e la richiesta la porta dietro', async () => {
  fakeCtx({ session: { access: 'jwt', client: { id: 1 } } });
  const s = mount(Prenota);
  try {
    await reply(pending('get', '/api/catalog/public/services')[0], CATS);
    await reply(pending('get', '/api/staff/public/operators')[0], OPS);
    await reply(pending('get', '/api/marketing/client/wallet')[0], { gift_cards: [] });
    s.render();
    await tap(s, /Prenota nell’app/);
    // fra le schede dei servizi niente aggiuntivi, né la categoria che ne ha soltanto
    assert.doesNotMatch(text(s), /Nail art|Scrub|Extra/);
    await tap(s, /^Manicure/);
    // sotto la manicure scelta: «Aggiungi» con gli aggiuntivi e il loro prezzo
    assert.match(text(s), /AggiungiNail art€10,00Scrub€8,00/);
    await tap(s, 'Nail art€10,00');
    assert.equal(findAll(s.tree, (el) => el.type === 'button' && el.props['aria-pressed'] === true).length, 1);
    // un servizio, il prezzo con la nail art
    await tap(s, 'Continua · €35,00');
    assert.match(text(s), /Passo 2 di 3/);
    // la durata resta quella della manicure
    assert.match(text(s), /Manicure \+ Nail art30m · €35,00/);
    let req = pending('get', '/api/agenda/client/availability');
    assert.deepEqual(req.at(-1).args[0].params.items, [{ service_id: 20, operator_id: null }, { service_id: 21, operator_id: null }]);
    // Luna non fa la nail art ma la manicure sì: si può scegliere, e la nail art resta al server
    await tap(s, /^LBLuna$/);
    req = pending('get', '/api/agenda/client/availability');
    assert.deepEqual(req.at(-1).args[0].params.items, [{ service_id: 20, operator_id: 6 }, { service_id: 21, operator_id: null }]);
    const start = isoAtMin(todayStr(), 600);
    await reply(req.at(-1), [{ start, assignment: [] }]);
    s.render();
    await tap(s, '10:00');
    await tap(s, 'Continua');
    // riepilogo: la nail art sotto la manicure, la durata della manicure
    assert.match(text(s), /Manicure€25,00\+ Nail art€10,00/);
    assert.match(text(s), /Durata30m/);
    assert.match(text(s), /Totale€35,00/);
    button(s.tree, /Conferma prenotazione/).props.onClick();
    const post = pending('post', '/api/agenda/client/appointments');
    assert.deepEqual(post[0].args, [{ items: [{ service_id: 20, operator_id: 6 }, { service_id: 21, operator_id: null }], start }]);
  } finally { s.unmount(); }
});

test('togliendo la manicure se ne va anche la sua nail art', async () => {
  fakeCtx();
  const s = mount(Prenota);
  try {
    await reply(pending('get', '/api/catalog/public/services')[0], CATS);
    await reply(pending('get', '/api/staff/public/operators')[0], OPS);
    s.render();
    await tap(s, /Prenota nell’app/);
    await tap(s, /^Manicure/);
    await tap(s, 'Nail art€10,00');
    await tap(s, /^Manicure/);
    assert.doesNotMatch(text(s), /Nail art/);
    assert.equal(button(s.tree, 'Continua').props.disabled, true);
  } finally { s.unmount(); }
});

test('la nail art già pagata (una seduta del pacchetto) lo dice nel suo «Aggiungi»', async () => {
  fakeCtx({ session: { access: 'jwt', client: { id: 1 } } });
  const s = mount(Prenota);
  try {
    await reply(pending('get', '/api/catalog/public/services')[0], CATS);
    await reply(pending('get', '/api/staff/public/operators')[0], OPS);
    await reply(pending('get', '/api/marketing/client/wallet')[0], { gift_cards: [{
      id: 9, code: 'PACC', balance: '20.00', payment_status: 'paid', spendable: true, received: false, from_name: '',
      gift_service_id: 21, gift_service_name: 'Nail art', kind: 'package', sessions_total: 2, sessions_left: 2, package_name: 'Unghie da festa',
    }] });
    s.render();
    await tap(s, /Prenota nell’app/);
    await tap(s, /^Manicure/);
    const nailArt = button(s.tree, 'Nail art€10,00');
    assert.match(nailArt.props.title, / · Pacchetto · 2 sedute rimaste$/);
    assert.equal(findAll(nailArt, (el) => el.props?.name === 'box').length, 1);
    // lo scrub non è coperto
    const scrub = button(s.tree, 'Scrub€8,00');
    assert.doesNotMatch(scrub.props.title, /Pacchetto/);
    assert.equal(findAll(scrub, (el) => el.props?.name === 'box').length, 0);
  } finally { s.unmount(); }
});
