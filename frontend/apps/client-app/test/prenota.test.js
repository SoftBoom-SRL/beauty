// La prenotazione della cliente (schermo Prenota), dall'inizio alla fine: lo
// schermo vero, col React finto (test/load.mjs), un contesto finto e un'API
// finta che risponde quando lo dice la prova. Si guarda quali chiamate
// partono, con che cosa, e che cosa c'è a video: il giro del test di fumo si
// ferma prima della conferma, qui si prenota davvero — senza sessione col
// codice via SMS, con la sessione, col 409 dell'orario appena preso, col
// secondo tentativo dopo una risposta persa (16-08) e con le risposte degli
// orari arrivate fuori ordine.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isoAtMin, todayStr, toDateStr, addDays, parseISO } from '@youty/shared';
import { STEP } from '../src/screens/prenota/steps.js';
import { calls, fail, fakeCtx, loadScreen, lost, pending, reply, tap, text } from './fake-app.mjs';
import { button, findAll, mount, settle, textOf } from './load.mjs';

const { default: Prenota } = await loadScreen('src/screens/prenota/index.jsx', ['DepositDue.jsx']);

/* ---- dati del salone ---- */
const CATS = [
  { id: 1, name_it: 'Capelli', name_en: 'Hair', services: [
    { id: 10, name_it: 'Taglio', name_en: 'Haircut', price: '30.00', duration_min: 45 },
    { id: 11, name_it: 'Colore', name_en: 'Colour', price: '50.00', duration_min: 60, soak_min: 40 },
  ] },
  { id: 2, name_it: 'Unghie', name_en: 'Nails', services: [
    { id: 20, name_it: 'Manicure', name_en: 'Manicure', price: '25.00', duration_min: 30 },
  ] },
  { id: 3, name_it: 'Vuota', name_en: 'Empty', services: [] },
];
const OPS = [
  { id: 5, first_name: 'Sole', last_name: 'Rossi', initials: 'SR', color: '#eee', service_ids: [10, 11] },
  { id: 6, first_name: 'Luna', last_name: 'Bianchi', initials: 'LB', color: '#ddd', service_ids: [20] },
];
const today = todayStr();
const dayStr = (i) => toDateStr(addDays(parseISO(today), i));
const slotAt = (day, min) => ({ start: isoAtMin(day, min), assignment: [] });

/* ---- aiuti ---- */
function setup(session = null) {
  const { toasts, views } = fakeCtx({ session });
  const s = mount(Prenota);
  return { s, toasts, views };
}
const input = (s, placeholder) => findAll(s.tree, (el) => el.type === 'input' && el.props.placeholder === placeholder)[0];
function type(s, placeholder, value) { input(s, placeholder).props.onChange({ target: { value } }); s.render(); }
const back = (s) => findAll(s.tree, (el) => el.type === 'button' && findAll(el, (x) => x.props?.name === 'chevL').length)[0];

/** Fino al listino: servizi e operatrici arrivati, «Prenota nell'app». */
async function toServices(s) {
  await reply(pending('get', '/api/catalog/public/services')[0], CATS);
  await reply(pending('get', '/api/staff/public/operators')[0], OPS);
  s.render();
  await tap(s, /Prenota nell’app/);
}
/** Fino alla scelta dell'orario, con i servizi `picks`. */
async function toTime(s, picks) {
  await toServices(s);
  for (const p of picks) await tap(s, p);
  await tap(s, /^Continua/);
}
const AVAIL_PUBLIC = '/api/agenda/public/availability';
const AVAIL_CLIENT = '/api/agenda/client/availability';

test('senza sessione: servizio, orario, dati, codice via SMS, prenotazione', async () => {
  const { s, toasts, views } = setup(null);
  try {
    // all'apertura listino e operatrici, pubblici; il portafoglio no (non c'è sessione)
    assert.deepEqual(calls(), [
      ['get', '/api/catalog/public/services', { params: { salon: 'the-parlour' }, auth: false }],
      ['get', '/api/staff/public/operators', { params: { salon: 'the-parlour' }, auth: false }],
    ]);
    assert.match(text(s), /Come preferisci prenotare da The Parlour\?/);
    await toTime(s, [/^Taglio/]);
    // passo 1: orari di oggi dall'endpoint pubblico, «prima disponibile»
    assert.match(text(s), /Passo 2 di 3 · Giorno e ora/);
    const first = pending('get', AVAIL_PUBLIC);
    assert.equal(first.length, 1);
    assert.deepEqual(first[0].args, [{ params: { salon: 'the-parlour', date: today, items: [{ service_id: 10, operator_id: null }] }, auth: false }]);
    // scelta l'operatrice, gli orari si richiedono con lei; la risposta vecchia
    // arriva dopo e non conta
    await tap(s, /^SRSole$/);
    const second = pending('get', AVAIL_PUBLIC);
    assert.equal(second.length, 2);
    assert.deepEqual(second[1].args[0].params.items, [{ service_id: 10, operator_id: 5 }]);
    await reply(second[1], [slotAt(today, 540), slotAt(today, 930)]);
    await reply(second[0], [slotAt(today, 600)]);
    s.render();
    assert.match(text(s), /Mattina09:00Pomeriggio15:30/);
    assert.doesNotMatch(text(s), /10:00/);
    await tap(s, '09:00');
    await tap(s, 'Continua');
    // passo 2: riepilogo
    const review = text(s);
    assert.match(review, /Passo 3 di 3 · Conferma/);
    assert.match(review, /Quando.* · 09:00/);
    assert.match(review, /Durata45m/);
    assert.match(review, /OperatriceSole Rossi/);
    assert.match(review, /Totale€30,00/);
    // senza sessione «Conferma prenotazione» porta ai dati
    await tap(s, /Conferma prenotazione/);
    assert.match(text(s), /Ti inviamo un codice via SMS/);
    type(s, 'Nome', 'Giada');
    type(s, 'Cognome', 'Bellini');
    // un numero a metà non parte: l'errore si vede subito
    findAll(s.tree, (el) => el.type?.name === 'PhoneInput')[0].props.onChange('333');
    s.render();
    await tap(s, 'Invia codice');
    assert.match(text(s), /Controlla il numero di telefono/);
    assert.equal(pending('requestOtp', null).length, 0);
    findAll(s.tree, (el) => el.type?.name === 'PhoneInput')[0].props.onChange(' 333 884 1120 ');
    s.render();
    button(s.tree, 'Invia codice').props.onClick();
    s.render();
    assert.match(text(s), /Invio…/);
    await reply(pending('requestOtp', null)[0], { ok: true });
    s.render();
    // passo 4: il codice, al condizionale (il server non dice se il numero c'è)
    assert.match(text(s), /Se il numero\s+333 884 1120\s+è già registrato, ti abbiamo inviato un codice a 6 cifre\./);
    assert.deepEqual(pending('requestOtp', null)[0].args, ['the-parlour', '333 884 1120']);
    findAll(s.tree, (el) => el.type === 'input' && el.props.className === 'ca-otp')[0].props.onChange({ target: { value: '12a3456' } });
    s.render();
    button(s.tree, /Conferma prenotazione/).props.onClick();
    s.render();
    await reply(pending('verifyOtp', null)[0], { access: 'jwt', client: { id: 1 } });
    s.render();
    assert.deepEqual(pending('verifyOtp', null)[0].args, ['the-parlour', '333 884 1120', '123456']);
    // poi la prenotazione, con l'operatrice scelta
    const post = pending('post', '/api/agenda/client/appointments');
    assert.equal(post.length, 1);
    assert.deepEqual(post[0].args, [{ items: [{ service_id: 10, operator_id: 5 }], start: slotAt(today, 540).start }]);
    await reply(post[0], { id: 77, start: slotAt(today, 540).start, deposit_status: 'none', deposit_amount: '0.00' });
    s.render();
    assert.match(text(s), /Fatto!Appuntamento confermato per .* alle 09:00\. Ti abbiamo inviato la conferma su WhatsApp/);
    await tap(s, 'Torna alla home');
    assert.deepEqual(views, [['home', undefined]]);
    assert.deepEqual(toasts, []);
  } finally { s.unmount(); }
});

test('con la sessione: regalo, orari personali, 409 e nuovo orario', async () => {
  const { s, toasts } = setup({ access: 'jwt', client: { id: 1, first_name: 'Giada' } });
  try {
    assert.deepEqual(calls().map((c) => c[1]), ['/api/catalog/public/services', '/api/staff/public/operators', '/api/marketing/client/wallet']);
    await reply(pending('get', '/api/marketing/client/wallet')[0], {
      gift_cards: [
        { id: 1, gift_service_id: 20, gift_service_name: 'Manicure', spendable: true, received: true, buyer_name: 'Carla' },
        { id: 2, gift_service_id: 11, gift_service_name: 'Colore', spendable: false },
      ],
    });
    await toServices(s);
    // il regalo si vede già nel listino, solo sulla carta che la cassa accetta
    assert.equal(textOf(button(s.tree, /^Manicure/)), 'Manicure30mRegalo di Carla€25,00');
    assert.equal(textOf(button(s.tree, /^Colore/)), 'Colore1h 40m€50,00');
    await tap(s, /^Manicure/);
    await tap(s, /^Continua/);
    const req = pending('get', AVAIL_CLIENT);
    assert.equal(req.length, 1);
    assert.deepEqual(req[0].args, [{ params: { date: today, items: [{ service_id: 20, operator_id: null }] } }]);
    await reply(req[0], [slotAt(today, 660), slotAt(today, 690)]);
    s.render();
    await tap(s, '11:00');
    await tap(s, 'Continua');
    assert.match(text(s), /Coperto da gift card: Manicure · regalo di Carla\. In salone non pagherai questa parte\./);
    // con la sessione si prenota subito
    button(s.tree, /Conferma prenotazione/).props.onClick();
    s.render();
    assert.match(text(s), /Prenotazione…/);
    await fail(pending('post', '/api/agenda/client/appointments')[0], 409, 'Orario non disponibile');
    s.render();
    assert.deepEqual(toasts, [{ msg: 'Questo orario è appena stato preso: scegline un altro.', icon: 'alert' }]);
    // si torna agli orari, ricaricati, senza più l'orario scelto. Gli orari si
    // chiedono una volta sola, dall'effetto del passo 1: li chiedeva anche il
    // gestore del 409, e senza sessione la richiesta in più pesava sul tetto
    // dell'endpoint pubblico (voce 35).
    assert.match(text(s), /Passo 2 di 3/);
    const again = pending('get', AVAIL_CLIENT);
    assert.equal(again.length, 2);
    assert.deepEqual(again[1].args, again[0].args);
    assert.equal(button(s.tree, 'Continua').props.disabled, true);
    await reply(again[1], [slotAt(today, 690)]);
    s.render();
    assert.doesNotMatch(text(s), /11:00/);
    await tap(s, '11:30');
    await tap(s, 'Continua');
    button(s.tree, /Conferma prenotazione/).props.onClick();
    const post = pending('post', '/api/agenda/client/appointments');
    assert.equal(post.length, 2);
    assert.deepEqual(post[1].args, [{ items: [{ service_id: 20, operator_id: null }], start: slotAt(today, 690).start }]);
    await reply(post[1], { id: 78, start: slotAt(today, 690).start, deposit_status: 'required', deposit_amount: '10.00' });
    s.render();
    assert.match(text(s), /Fatto!.*Per confermare serve una caparra di €10,00, che verrà scalata dal totale\./);
    const dep = findAll(s.tree, (el) => el.type?.name === 'DepositDue');
    assert.equal(dep.length, 1);
    assert.equal(dep[0].props.appt.id, 78);
  } finally { s.unmount(); }
});

test('secondo tentativo dopo una risposta persa: prima si guarda se la prenotazione c\'è già (16-08)', async () => {
  const { s, toasts } = setup({ access: 'jwt', client: { id: 1 } });
  try {
    await reply(pending('get', '/api/marketing/client/wallet')[0], { gift_cards: [] });
    await toTime(s, [/^Taglio/, /^Colore/]);
    await reply(pending('get', AVAIL_CLIENT)[0], [slotAt(today, 600)]);
    s.render();
    await tap(s, '10:00');
    await tap(s, 'Continua');
    const start = slotAt(today, 600).start;
    button(s.tree, /Conferma prenotazione/).props.onClick();
    await lost(pending('post', '/api/agenda/client/appointments')[0]);
    s.render();
    assert.deepEqual(toasts, [{ msg: 'Errore di rete', icon: 'alert' }]);
    // stesso orario, stessi servizi: prima l'elenco, e nessun secondo POST se c'è
    button(s.tree, /Conferma prenotazione/).props.onClick();
    await settle();
    const list = pending('get', '/api/agenda/client/appointments');
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].args, []);
    // c'è un taglio alle 10:00 ma senza il colore: non è questa prenotazione
    await reply(list[0], { upcoming: [{ id: 9, start, status: 'confirmed', services: [{ service_id: 10 }] }] });
    const posts = pending('post', '/api/agenda/client/appointments');
    assert.equal(posts.length, 2);
    await lost(posts[1]);
    s.render();
    // terzo tocco: questa volta la prenotazione c'è (stesso istante, stessi servizi)
    button(s.tree, /Conferma prenotazione/).props.onClick();
    await settle();
    const booked = { id: 12, start: new Date(start).toISOString(), status: 'confirmed', services: [{ service_id: 11 }, { service_id: 10 }] };
    await reply(pending('get', '/api/agenda/client/appointments')[1], { upcoming: [booked] });
    s.render();
    assert.equal(pending('post', '/api/agenda/client/appointments').length, 2);
    assert.match(text(s), /Fatto!/);
    // l'elenco che non arriva non blocca: si riprova il POST
  } finally { s.unmount(); }
});

test('secondo tentativo con l\'elenco che non arriva: si rifà il POST', async () => {
  const { s } = setup({ access: 'jwt', client: { id: 1 } });
  try {
    await reply(pending('get', '/api/marketing/client/wallet')[0], { gift_cards: [] });
    await toTime(s, [/^Manicure/]);
    await reply(pending('get', AVAIL_CLIENT)[0], [slotAt(today, 600)]);
    s.render();
    await tap(s, '10:00');
    await tap(s, 'Continua');
    button(s.tree, /Conferma prenotazione/).props.onClick();
    await fail(pending('post', '/api/agenda/client/appointments')[0], 502, 'Bad Gateway');
    button(s.tree, /Conferma prenotazione/).props.onClick();
    await settle();
    await lost(pending('get', '/api/agenda/client/appointments')[0]);
    assert.equal(pending('post', '/api/agenda/client/appointments').length, 2);
  } finally { s.unmount(); }
});

test('giorni: la risposta superata non conta; operatrice che non fa tutti i servizi', async () => {
  const { s } = setup(null);
  try {
    await toTime(s, [/^Taglio/]);
    // si sceglie l'operatrice, poi si torna ad aggiungere un servizio che lei non fa
    await tap(s, /^SRSole$/);
    back(s).props.onClick();
    s.render();
    await tap(s, /^Manicure/);
    await tap(s, /^Continua · 2 servizi · €55,00/);
    assert.match(text(s), /Nessuna operatrice svolge tutti i servizi che hai scelto/);
    assert.doesNotMatch(text(s), /Prima disponibile/);
    const reqs = pending('get', AVAIL_PUBLIC);
    const last = reqs[reqs.length - 1];
    assert.deepEqual(last.args[0].params.items, [{ service_id: 10, operator_id: null }, { service_id: 20, operator_id: null }]);
    // giorno 3, poi giorno 2 prima che il 3 risponda: vale il 2
    const chips = findAll(s.tree, (el) => el.type === 'button' && /^\D+\d+$/.test(textOf(el)));
    assert.equal(chips.length, 14);
    chips[3].props.onClick();
    s.render();
    findAll(s.tree, (el) => el.type === 'button' && /^\D+\d+$/.test(textOf(el)))[2].props.onClick();
    s.render();
    const days = pending('get', AVAIL_PUBLIC).slice(-2);
    assert.deepEqual(days.map((r) => r.args[0].params.date), [dayStr(3), dayStr(2)]);
    await reply(days[1], [slotAt(dayStr(2), 480)]);
    await reply(days[0], [slotAt(dayStr(3), 1020)]);
    s.render();
    assert.match(text(s), /Mattina08:00/);
    assert.doesNotMatch(text(s), /17:00/);
    // un giorno senza orari: la lista d'attesa, col primo servizio
    findAll(s.tree, (el) => el.type === 'button' && /^\D+\d+$/.test(textOf(el)))[4].props.onClick();
    s.render();
    await reply(pending('get', AVAIL_PUBLIC).slice(-1)[0], []);
    s.render();
    assert.match(text(s), /Nessun orario libero questo giorno\. Prova un altro giorno o mettiti in lista d’attesa\./);
    const views = [];
    globalThis.__ctx.setView = (v, p) => views.push([v, p]);
    s.render();
    await tap(s, /Vai alla lista d’attesa/);
    assert.deepEqual(views, [['waitlist-new', { serviceId: 10 }]]);
  } finally { s.unmount(); }
});

test('indietro: un passo alla volta fino alla scelta, poi la home', async () => {
  const { s, views } = setup(null);
  try {
    await toTime(s, [/^Taglio/]);
    await reply(pending('get', AVAIL_PUBLIC)[0], [slotAt(today, 600)]);
    s.render();
    await tap(s, '10:00');
    await tap(s, 'Continua');
    await tap(s, /Conferma prenotazione/);
    type(s, 'Nome', 'Giada');
    type(s, 'Cognome', 'Bellini');
    findAll(s.tree, (el) => el.type?.name === 'PhoneInput')[0].props.onChange('333 884 1120');
    s.render();
    button(s.tree, 'Invia codice').props.onClick();
    await reply(pending('requestOtp', null)[0], { ok: true });
    s.render();
    const titles = [];
    for (let i = 0; i < 6; i++) {
      titles.push(findAll(s.tree, (el) => el.type === 'div' && el.props.style?.fontSize === 21)[0]?.props.children);
      back(s).props.onClick();
      s.render();
    }
    assert.deepEqual(titles, ['Conferma il numero', 'I tuoi dati', 'Conferma prenotazione', 'Scegli giorno e ora', 'Scegli il servizio', 'Prenota']);
    assert.deepEqual(views, [['home', undefined]]);
  } finally { s.unmount(); }
});

test('i passi hanno i numeri di sempre: «indietro» fa step - 1', () => {
  assert.deepEqual({ ...STEP }, { CHOICE: -1, SERVICE: 0, TIME: 1, REVIEW: 2, DETAILS: 3, OTP: 4, DONE: 9 });
  assert.ok(Object.isFrozen(STEP));
  // la sequenza di «indietro», dal codice alla scelta
  const chain = [STEP.OTP, STEP.DETAILS, STEP.REVIEW, STEP.TIME, STEP.SERVICE, STEP.CHOICE];
  chain.slice(1).forEach((prev, i) => assert.equal(chain[i] - 1, prev));
});
