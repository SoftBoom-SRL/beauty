// Spostare e annullare un appuntamento (schermi Sposta e Annulla), fino al
// POST: il giro del test di fumo si ferma prima. Gli schermi veri col React
// finto e l'API finta di test/fake-app.mjs: si guardano le chiamate, il testo
// a video, i toast e dove si va dopo.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isoAtMin, todayStr, toDateStr, addDays, parseISO } from '@youty/shared';
import { calls, fail, fakeCtx, loadScreen, lost, pending, reply, tap, text } from './fake-app.mjs';
import { button, findAll, mount, textOf } from './load.mjs';

const { default: Sposta } = await loadScreen('src/screens/Sposta.jsx');
const { default: Annulla } = await loadScreen('src/screens/Annulla.jsx');

const today = todayStr();
const dayStr = (i) => toDateStr(addDays(parseISO(today), i));
const at = (day, min) => isoAtMin(day, min);
const AVAIL = '/api/agenda/client/availability';
// Taglio con l'operatrice dell'appuntamento, Colore con la sua (voce per voce)
const APPT = {
  id: 12, start: at(dayStr(3), 600), end: at(dayStr(3), 700), status: 'confirmed',
  services: [{ service_id: 10, operator_id: null, name: 'Taglio' }, { service_id: 11, operator_id: 7, name: 'Colore' }],
  operator: { id: 5, name: 'Sole' }, deposit_status: 'none', deposit_amount: '0.00',
};
const chips = (s) => findAll(s.tree, (el) => el.type === 'button' && /^\D+\d+$/.test(textOf(el)));

test('Sposta senza appuntamento: si torna alle prenotazioni, nessuna chiamata', async () => {
  const { views } = fakeCtx({ viewParams: {} });
  const s = mount(Sposta);
  try {
    assert.match(text(s), /Seleziona prima l’appuntamento da spostare\./);
    assert.deepEqual(calls(), []);
    await tap(s, 'Le tue prenotazioni');
    assert.deepEqual(views, [['prenotazioni', undefined]]);
  } finally { s.unmount(); }
});

test('Sposta: orari con le stesse operatrici e senza l\'appuntamento, poi il nuovo orario', async () => {
  const { views, toasts } = fakeCtx({ viewParams: { appt: APPT } });
  const s = mount(Sposta);
  try {
    assert.deepEqual(calls(), [['get', AVAIL, {
      params: { date: today, items: [{ service_id: 10, operator_id: 5 }, { service_id: 11, operator_id: 7 }], exclude_appointment_id: 12 },
    }]]);
    assert.match(text(s), /Taglio \+ Colore.*10:00 · 1h 40m/);
    // un altro giorno: la risposta del primo, arrivata dopo, non conta
    chips(s)[1].props.onClick();
    s.render();
    const reqs = pending('get', AVAIL);
    assert.equal(reqs[1].args[0].params.date, dayStr(1));
    await reply(reqs[1], [{ start: at(dayStr(1), 900) }]);
    await reply(reqs[0], [{ start: at(today, 480) }]);
    s.render();
    assert.match(text(s), /Pomeriggio15:00/);
    assert.doesNotMatch(text(s), /08:00/);
    await tap(s, '15:00');
    await tap(s, 'Conferma nuovo orario');
    const post = pending('post', '/api/agenda/client/appointments/12/move');
    assert.deepEqual(post.map((c) => c.args), [[{ start: at(dayStr(1), 900) }]]);
    await reply(post[0], { ok: true });
    s.render();
    assert.match(text(s), /Spostato!Ci vediamo .* alle 15:00\. Ti abbiamo inviato la conferma su WhatsApp/);
    await tap(s, 'Torna alla home');
    assert.deepEqual(views, [['home', undefined]]);
    assert.deepEqual(toasts, []);
  } finally { s.unmount(); }
});

test('Sposta: il 400 della disponibilità si dice nel riquadro, senza «Nessun orario»', async () => {
  const { toasts } = fakeCtx({ viewParams: { appt: APPT } });
  const s = mount(Sposta);
  try {
    await fail(pending('get', AVAIL)[0], 400, 'Per spostare questa visita contatta il salone');
    s.render();
    assert.match(text(s), /Per spostare questa visita contatta il salone/);
    assert.doesNotMatch(text(s), /Nessun orario libero/);
    assert.deepEqual(toasts, []);
    assert.equal(button(s.tree, 'Conferma nuovo orario').props.disabled, true);
    // un altro errore invece è un toast; il riquadro di prima resta (il cambio
    // di giorno non lo toglie) e copre il «Nessun orario libero»
    chips(s)[2].props.onClick();
    s.render();
    await lost(pending('get', AVAIL)[1]);
    s.render();
    assert.deepEqual(toasts, [{ msg: 'Errore di rete', icon: 'alert' }]);
    assert.match(text(s), /Per spostare questa visita contatta il salone/);
    assert.doesNotMatch(text(s), /Nessun orario libero/);
  } finally { s.unmount(); }
});

test('Sposta: 400 del preavviso (riquadro e toast), 409 (orari ricaricati), altri errori', async () => {
  const { toasts } = fakeCtx({ viewParams: { appt: APPT } });
  const s = mount(Sposta);
  try {
    await reply(pending('get', AVAIL)[0], [{ start: at(today, 660) }, { start: at(today, 720) }]);
    s.render();
    await tap(s, '11:00');
    await tap(s, 'Conferma nuovo orario');
    await fail(pending('post', '/api/agenda/client/appointments/12/move')[0], 400, 'Mancano meno di 24 ore');
    s.render();
    assert.match(text(s), /Mancano meno di 24 ore/);
    assert.deepEqual(toasts, [{ msg: 'Mancano meno di 24 ore', icon: 'alert' }]);
    // 409: toast, orario tolto, gli orari del giorno chiesti di nuovo
    await tap(s, 'Conferma nuovo orario');
    await fail(pending('post', '/api/agenda/client/appointments/12/move')[1], 409, 'Occupato');
    s.render();
    assert.deepEqual(toasts[1], { msg: 'Questo orario è appena stato preso: scegline un altro.', icon: 'alert' });
    assert.equal(button(s.tree, 'Conferma nuovo orario').props.disabled, true);
    const reqs = pending('get', AVAIL);
    assert.equal(reqs.length, 2);
    assert.deepEqual(reqs[1].args, reqs[0].args);
    // il riquadro del preavviso sparisce appena si riprova a confermare
    assert.doesNotMatch(text(s), /Mancano meno di 24 ore/);
    await reply(reqs[1], [{ start: at(today, 720) }]);
    s.render();
    assert.match(text(s), /Pomeriggio12:00/);
    await tap(s, '12:00');
    await tap(s, 'Conferma nuovo orario');
    assert.match(text(s), /Spostamento…/);
    await lost(pending('post', '/api/agenda/client/appointments/12/move')[2]);
    s.render();
    assert.deepEqual(toasts[2], { msg: 'Errore di rete', icon: 'alert' });
  } finally { s.unmount(); }
});

test('Annulla senza appuntamento: si torna alle prenotazioni', async () => {
  const { views } = fakeCtx({ viewParams: {} });
  const s = mount(Annulla);
  try {
    assert.match(text(s), /Seleziona prima l’appuntamento da annullare\./);
    await tap(s, 'Le tue prenotazioni');
    assert.deepEqual(views, [['prenotazioni', undefined]]);
  } finally { s.unmount(); }
});

test('Annulla: l\'avviso dice la soglia del salone, e la caparra versata che si perde', async () => {
  fakeCtx({ viewParams: { appt: APPT } });
  let s = mount(Annulla);
  assert.match(text(s), /Sei sicura di voler annullare\? A meno di 24h dall’appuntamento l’annullamento non è consentito dall’app\./);
  assert.match(text(s), /Taglio \+ Colore.*10:00 · 1h 40m.*Sole/);
  s.unmount();
  fakeCtx({ viewParams: { appt: { ...APPT, deposit_status: 'paid', deposit_amount: '20.00' } }, brand: { name: 'X', type: 'serif', cancelMinHours: 48 } });
  s = mount(Annulla);
  assert.match(text(s), /Annullando a meno di 48h dall'appuntamento perderai il deposito di €20,00 versato\. Sei sicura\?/);
  assert.match(text(s), / · €20,00/);
  s.unmount();
});

test('Annulla: il POST senza corpo, poi «Prenota di nuovo»; 400 nel riquadro e nel toast', async () => {
  const { views, toasts } = fakeCtx({ viewParams: { appt: APPT } });
  const s = mount(Annulla);
  try {
    assert.deepEqual(calls(), []);
    button(s.tree, 'Sì, annulla').props.onClick();
    s.render();
    assert.match(text(s), /Annullamento…/);
    const post = pending('post', '/api/agenda/client/appointments/12/cancel');
    assert.deepEqual(post.map((c) => c.args), [[]]);
    await fail(post[0], 400, 'Troppo tardi per annullare dall\'app');
    s.render();
    assert.match(text(s), /Troppo tardi per annullare dall'app/);
    assert.deepEqual(toasts, [{ msg: 'Troppo tardi per annullare dall\'app', icon: 'alert' }]);
    await tap(s, 'Sì, annulla');
    await lost(pending('post', '/api/agenda/client/appointments/12/cancel')[1]);
    s.render();
    assert.deepEqual(toasts[1], { msg: 'Errore di rete', icon: 'alert' });
    await tap(s, 'Sì, annulla');
    await reply(pending('post', '/api/agenda/client/appointments/12/cancel')[2], { ok: true });
    s.render();
    assert.match(text(s), /Appuntamento annullatoCi dispiace non vederti! Prenota quando vuoi, ti aspettiamo/);
    await tap(s, 'Prenota di nuovo');
    await tap(s, 'Torna alla home');
    assert.deepEqual(views, [['prenota', undefined], ['home', undefined]]);
  } finally { s.unmount(); }
});

test('Annulla: «No, mantieni» e la freccia tornano alla home', async () => {
  const { views } = fakeCtx({ viewParams: { appt: APPT } });
  const s = mount(Annulla);
  try {
    await tap(s, 'No, mantieni');
    findAll(s.tree, (el) => el.type === 'button' && findAll(el, (x) => x.props?.name === 'chevL').length)[0].props.onClick();
    assert.deepEqual(views, [['home', undefined], ['home', undefined]]);
    assert.deepEqual(calls(), []);
  } finally { s.unmount(); }
});
