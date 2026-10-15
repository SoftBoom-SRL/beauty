// Trattamenti già pagati nell'app cliente (15/10): un regalo a trattamento, un
// trattamento pagato in anticipo, le sedute di un pacchetto. Stanno nel
// Portafoglio a parte dal credito in euro, con le sedute rimaste e la
// scadenza; in Prenota e fra le prenotazioni si chiamano per quello che sono;
// i pacchetti a listino dicono sedute e validità prima dell'acquisto.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setSalonTz } from '@youty/shared';
import {
  apptGiftLabel, coveredLabel, coveredSummary, giftCardTotals, giftFromName, myTreatments, packageSessions,
  packageValidity, sessionsLeftLabel, treatmentIcon, treatmentKind, treatmentOrigin,
} from '../src/lib/wallet.js';
import { fakeCtx, loadScreen, pending, reply, text } from './fake-app.mjs';
import { button, mount } from './load.mjs';

setSalonTz('Europe/Rome');
const t = (it) => it;
const en = (it, en_) => en_;

// Il portafoglio di Sofia, come lo manda GET /api/marketing/client/wallet.
const pacchetto = {
  id: 1, code: 'PACC', balance: '90.00', initial_value: '150.00', payment_status: 'paid', spendable: true,
  received: true, recipient_name: 'Sofia Ricci', buyer_name: 'Sofia Ricci', from_name: '',
  gift_service_id: 3, gift_service_name: 'Manicure', kind: 'package', sessions_total: 5, sessions_left: 3,
  session_value: '30.00', package_name: 'Mani perfette', expires_at: '2027-01-15T22:59:00Z',
};
const giaPagato = { ...pacchetto, id: 2, code: 'PREP', kind: 'prepaid', package_name: null, sessions_total: 1, sessions_left: 1, balance: '40.00', expires_at: null };
const regalo = { ...giaPagato, id: 3, code: 'GIFT', kind: 'gift', from_name: 'Carla', buyer_name: 'Carla' };
const credito = { id: 4, code: 'EURO', balance: '50.00', initial_value: '50.00', payment_status: 'paid', spendable: true, received: false, recipient_name: '' };
const perLaMamma = { ...regalo, id: 5, spendable: false, received: false, recipient_name: 'Mamma', from_name: '' };
const daPagare = { ...giaPagato, id: 6, payment_status: 'unpaid', spendable: false, received: false, recipient_name: '' };

test('i trattamenti non sono credito in euro: si contano a parte', () => {
  const cards = [pacchetto, giaPagato, regalo, credito, perLaMamma, daPagare];
  assert.deepEqual(giftCardTotals(cards), { spendable: 5000, spendableCount: 1, pending: 0, pendingCount: 0 });
  // i suoi: spendibili, o da pagare in salone comprati per sé; non quello per la mamma
  assert.deepEqual(myTreatments(cards).map((g) => g.id), [1, 2, 3, 6]);
});

test('tipo, icona e chi l’ha regalato (mai lei stessa)', () => {
  assert.deepEqual([pacchetto, giaPagato, regalo, credito].map(treatmentKind), ['package', 'prepaid', 'gift', 'gift']);
  assert.deepEqual([pacchetto, giaPagato, regalo].map(treatmentIcon), ['box', 'wallet', 'gift']);
  assert.equal(giftFromName(regalo), 'Carla');
  assert.equal(giftFromName(giaPagato), '');
  // un server di prima, senza from_name: conta la carta ricevuta
  assert.equal(giftFromName({ received: true, buyer_name: 'Carla' }), 'Carla');
  assert.equal(giftFromName({ received: false, buyer_name: 'Sofia' }), '');
});

test('sedute e origine in parole', () => {
  assert.equal(sessionsLeftLabel(pacchetto, t), 'Ti restano 3 sedute su 5');
  assert.equal(sessionsLeftLabel({ ...pacchetto, sessions_left: 1 }, t), 'Ultima seduta su 5');
  assert.equal(sessionsLeftLabel(giaPagato, t), '1 seduta');
  assert.equal(sessionsLeftLabel(pacchetto, en), '3 of 5 sessions left');
  assert.equal(treatmentOrigin(pacchetto, t), 'Pacchetto «Mani perfette»');
  assert.equal(treatmentOrigin(giaPagato, t), 'Pagato in anticipo');
  assert.equal(treatmentOrigin(regalo, t), 'Regalo di Carla');
});

test('Prenota: l’etichetta del servizio e il riepilogo', () => {
  assert.equal(coveredLabel(pacchetto, t), 'Pacchetto · 3 sedute rimaste');
  assert.equal(coveredLabel({ ...pacchetto, sessions_left: 1 }, t), 'Pacchetto · ultima seduta');
  assert.equal(coveredLabel(giaPagato, t), 'Già pagato');
  assert.equal(coveredLabel(regalo, t), 'Regalo di Carla');
  assert.equal(coveredLabel({ ...regalo, from_name: '' }, t), 'Hai un regalo');
  // solo regali: come prima
  assert.deepEqual(coveredSummary([regalo], t), { title: 'Coperto da gift card', text: 'Manicure · regalo di Carla' });
  assert.deepEqual(coveredSummary([pacchetto, { ...giaPagato, gift_service_name: 'Piega' }], t), {
    title: 'Già pagato',
    text: 'Manicure (Pacchetto «Mani perfette», Ti restano 3 sedute su 5), Piega (pagato in anticipo)',
  });
  assert.deepEqual(coveredSummary([], t), { title: '', text: '' });
});

test('sulla prenotazione: in regalo, già pagato, dal pacchetto', () => {
  assert.equal(apptGiftLabel({ kind: 'gift', from_name: 'Carla' }, t), 'In regalo da Carla');
  assert.equal(apptGiftLabel({ kind: 'gift', from_name: '' }, t), 'Coperto da gift card');
  assert.equal(apptGiftLabel({ from_name: '' }, t), 'Coperto da gift card');
  assert.equal(apptGiftLabel({ kind: 'prepaid', from_name: '' }, t), 'Già pagato');
  assert.equal(apptGiftLabel({ kind: 'package', package_name: 'Mani perfette' }, t), 'Dal pacchetto «Mani perfette»');
});

test('pacchetti a listino: sedute per servizio e validità', () => {
  assert.equal(packageSessions(5, t), '5 sedute');
  assert.equal(packageSessions(1, t), '1 seduta');
  assert.equal(packageValidity(90, t), 'Valido 90 giorni dall’acquisto');
  assert.equal(packageValidity(null, t), 'Senza scadenza');
  assert.equal(packageValidity(30, en), 'Valid 30 days from purchase');
});

/* ---- gli schermi --------------------------------------------------------------- */

const { default: Wallet } = await loadScreen('src/screens/Wallet.jsx');
const { default: Pacchetti } = await loadScreen('src/screens/Pacchetti.jsx');

test('Portafoglio: prima i trattamenti già pagati, con sedute e scadenza; il credito è solo in euro', async () => {
  const { views } = fakeCtx({});
  const s = mount(Wallet);
  try {
    await reply(pending('get', '/api/marketing/client/wallet')[0], { gift_cards: [pacchetto, regalo, credito], coupons: [], loyalty: [] });
    s.render();
    const all = text(s);
    assert.match(all, /Trattamenti già pagati2Prenotali quando vuoi/);
    assert.match(all, /ManicurePacchetto «Mani perfette»3\/5Ti restano 3 sedute su 5· Scade il 15 gen 2027/);
    assert.match(all, /ManicureRegalo di Carla1 seduta· Senza scadenza/);
    // il credito utilizzabile è la sola carta in euro
    assert.match(all, /Credito utilizzabile€50,00/);
    assert.ok(all.indexOf('Trattamenti già pagati') < all.indexOf('Credito utilizzabile'), 'i trattamenti vengono prima');
    button(s.tree, /Prenota un trattamento/).props.onClick();
    assert.deepEqual(views.at(-1), ['prenota', undefined]);
  } finally { s.unmount(); }
});

test('Pacchetti: le sedute di ogni servizio e fino a quando valgono', async () => {
  fakeCtx({});
  const s = mount(Pacchetti);
  try {
    await reply(pending('get', '/api/catalog/public/services')[0], [
      { id: 1, name_it: 'Unghie', services: [{ id: 3, name_it: 'Manicure', price: '40.00' }] },
    ]);
    await reply(pending('get', '/api/catalog/public/packages')[0], [
      { id: 9, name: 'Mani perfette', description: '', price: '150.00', validity_days: 180,
        items: [{ service_id: 3, name_it: 'Manicure', name_en: 'Manicure', soak_min: 0, qty: 5 }] },
    ]);
    s.render();
    assert.match(text(s), /Valido 180 giorni dall’acquisto/);
    assert.match(text(s), /Manicure5 sedute/);
  } finally { s.unmount(); }
});
