// Trattamenti già pagati (15/10): regalo, pagato in anticipo dalla cliente,
// sedute di un pacchetto. Ovunque compariva «Regalo» — giorno, settimana,
// mese, anteprima, dettaglio, nuova prenotazione, scheda cliente, Promozioni —
// una cliente col pacchetto da cinque manicure risultava «Regalo», e al banco
// non si sapeva quante sedute le restavano. Qui le etichette (fedelta/credits.js),
// la maschera della gift card (fedelta/giftCardForm.js), i pacchetti a listino
// (servizi/packages.js) e i pezzi dell'agenda che le mostrano.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isoAtMin, parseISO, setSalonTz, toDateStr, todayStr } from '@youty/shared';
import {
  creditIcon, creditKind, creditLabel, creditOrigin, creditTitle, creditsTitle, giverName, ownsCredit,
  sessionsLabel, sessionsLeftText, splitClientCredits,
} from '../src/sections/fedelta/credits.js';
import { MAX_SESSIONS, giftCardMissing, giftCardPayload, giftCardValueCents } from '../src/sections/fedelta/giftCardForm.js';
import { sessionsText, validityDaysPayload, validityLabel } from '../src/sections/servizi/packages.js';
import { usableGiftCards } from '../src/sections/agenda/modals/rules.js';
import { find, findAll, installDom, loadComponent, mount, spy, textOf } from './grid-harness.mjs';

setSalonTz('Europe/Rome');
const t = (it) => it;
const en = (it, en_) => en_;
const MARIA = 7;

// Le carte come le mandano agenda (`appt.gifts`) ed elenco di Promozioni.
const pacchetto = {
  gift_card_id: 31, code: 'PACC1234ABCD', service_id: 3, service_name: 'Manicure', balance: '90.00',
  from_name: '', kind: 'package', sessions_total: 5, sessions_left: 3, session_value: '30.00',
  package_name: 'Mani perfette', expires_at: '2027-01-15T22:59:00Z',
};
const giaPagato = { ...pacchetto, gift_card_id: 32, code: 'PREP1234ABCD', kind: 'prepaid', sessions_total: 1, sessions_left: 1, package_name: '', balance: '40.00', expires_at: null };
const regalo = { ...giaPagato, gift_card_id: 33, code: 'GIFT1234ABCD', kind: 'gift', from_name: 'Carla Ricci' };

test('tre tipi con tre icone; senza `kind` (server di prima) è un regalo', () => {
  assert.deepEqual([pacchetto, giaPagato, regalo].map(creditKind), ['package', 'prepaid', 'gift']);
  assert.deepEqual([pacchetto, giaPagato, regalo].map(creditIcon), ['box', 'wallet', 'gift']);
  assert.equal(creditKind({ code: 'X' }), 'gift');
  assert.equal(creditKind({ kind: 'abbonamento' }), 'gift');
});

test('le sedute: rimaste su totali, e nessuna parola per la carta da una seduta', () => {
  assert.equal(sessionsLabel(pacchetto, t), '3/5 sedute');
  assert.equal(sessionsLabel(giaPagato, t), '');
  assert.equal(sessionsLabel({ sessions_total: 1, sessions_left: 1 }, t, { always: true }), '1/1 seduta');
  assert.equal(sessionsLabel(pacchetto, en), '3/5 sessions');
  assert.equal(sessionsLeftText(pacchetto, t), '3 sedute rimaste su 5');
  assert.equal(sessionsLeftText({ ...pacchetto, sessions_left: 1 }, t), '1 seduta rimasta su 5');
  assert.equal(sessionsLeftText(pacchetto, en), '3 of 5 sessions left');
});

test('«Regalo · da X», «Già pagato», «Pacchetto · N/M sedute»', () => {
  assert.equal(creditLabel(regalo, t), 'Regalo · da Carla Ricci');
  assert.equal(creditLabel(giaPagato, t), 'Già pagato');
  assert.equal(creditLabel(pacchetto, t), 'Pacchetto · 3/5 sedute');
  // un pacchetto da una seduta la dice lo stesso; un già pagato a sedute le aggiunge
  assert.equal(creditLabel({ ...pacchetto, sessions_total: 1, sessions_left: 1 }, t), 'Pacchetto · 1/1 seduta');
  assert.equal(creditLabel({ ...giaPagato, sessions_total: 3, sessions_left: 2 }, t), 'Già pagato · 2/3 sedute');
  // il nome di chi regala si può accorciare, o togliere dove sta già accanto
  assert.equal(creditLabel(regalo, t, { from: 'Carla' }), 'Regalo · da Carla');
  assert.equal(creditLabel(regalo, t, { withFrom: false }), 'Regalo');
  assert.equal(creditLabel({ ...regalo, from_name: '' }, t), 'Regalo');
  assert.equal(creditLabel(pacchetto, en), 'Package · 3/5 sessions');
});

test('da dove viene e la descrizione intera (tooltip, anteprima)', () => {
  assert.equal(creditOrigin(pacchetto, t), 'Pacchetto «Mani perfette»');
  assert.equal(creditOrigin(giaPagato, t), 'Pagato in anticipo');
  assert.equal(creditOrigin(regalo, t), 'Regalo da Carla Ricci');
  assert.equal(
    creditTitle(pacchetto, t, 'it'),
    'Manicure · Pacchetto «Mani perfette» · 3 sedute rimaste su 5 · residuo €90,00 · scade il 15/01/2027 · PACC1234ABCD',
  );
  // il codice mascherato (C21) non si mostra come codice da usare
  assert.equal(creditTitle({ ...giaPagato, code: '••••ABCD' }, t, 'it'), 'Manicure · Pagato in anticipo · residuo €40,00');
  // senza lingua (i blocchi della griglia hanno solo `t`) vale quella di t
  assert.match(creditTitle(pacchetto, en, null, { code: false }), /^Manicure · Package «Mani perfette» · 3 of 5 sessions left · left €90\.00 · expires /);
  assert.equal(creditsTitle([regalo, giaPagato], t, 'it', { code: false }).split('\n').length, 2);
});

test('chi l’ha regalata: mai la cliente stessa', () => {
  // dall'elenco di Promozioni (senza from_name): conta chi l'ha comprata
  const card = { buyer_client_id: 9, buyer_name: 'Carla Ricci', recipient_client_id: MARIA };
  assert.equal(giverName(card, MARIA), 'Carla Ricci');
  assert.equal(giverName({ ...card, buyer_client_id: MARIA, buyer_name: 'Maria Russo' }, MARIA), '');
  // dall'agenda il server l'ha già deciso
  assert.equal(giverName({ ...card, from_name: '' }, MARIA), '');
});

test('la scheda cliente: i suoi trattamenti da fare in cima, esauriti e scaduti a parte', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  const base = { gift_service_id: 3, gift_service_name: 'Manicure', payment_status: 'paid', status: 'active', recipient_client_id: MARIA, buyer_client_id: MARIA, recipient_name: 'Maria Russo' };
  const cards = [
    { ...base, id: 1, expires_at: null },                                            // senza scadenza: in fondo
    { ...base, id: 2, expires_at: '2026-11-01T22:59:00Z' },                          // scade prima: in cima
    { ...base, id: 3, status: 'redeemed' },                                          // esaurito
    { ...base, id: 4, expires_at: '2026-10-01T21:59:00Z' },                          // scaduto (attivo a database)
    { ...base, id: 5, gift_service_id: null },                                       // carta a importo
    { ...base, id: 6, recipient_client_id: 12, recipient_name: 'Giulia' },           // regalo per un'altra
    { ...base, id: 7, recipient_client_id: null, recipient_name: '' },               // comprato per sé
  ];
  const { open, closed, others } = splitClientCredits(cards, MARIA, now);
  assert.deepEqual(open.map((g) => g.id), [2, 1, 7]);
  assert.deepEqual(closed.map((g) => g.id), [3, 4]);
  assert.deepEqual(others.map((g) => g.id), [5, 6]);
  assert.equal(ownsCredit(cards[6], MARIA), true);
  assert.equal(ownsCredit({ ...cards[6], recipient_name: 'Zia Carla' }, MARIA), false);
});

test('nuova prenotazione: un pacchetto in omaggio (saldo zero) copre ancora il servizio', () => {
  const card = (extra) => ({
    id: 1, gift_service_id: 3, payment_status: 'paid', status: 'active', balance: '0.00',
    expires_at: null, recipient_client_id: MARIA, recipient_name: 'Maria Russo', buyer_client_id: MARIA, ...extra,
  });
  assert.deepEqual(usableGiftCards([card({ sessions_left: 4 })], MARIA).map((g) => g.id), [1]);
  // a saldo zero e senza sedute non copre niente (e un server senza sedute resta com'era)
  assert.deepEqual(usableGiftCards([card({ sessions_left: 0 }), card({ id: 2 })], MARIA), []);
});

/* ---- la maschera «Nuova gift card» -------------------------------------- */

const SOFIA = { id: 4, full_name: 'Sofia Ricci' };
const ANNA = { id: 5, full_name: 'Anna Neri' };
const PIEGA = { id: 3, price: '25.00' };
const form = (extra) => ({
  kind: 'gift', type: 'service', value: 50, service: PIEGA, sessions: 3, buyer: ANNA, recipient: SOFIA,
  recipientName: '', byName: false, paid: true, paidMethod: 'card', scheduled: true, deliveryDate: '2026-12-24',
  expiryMonths: 0, canCash: true, canPayLater: true, ...extra,
});

test('il valore di un trattamento è il listino per le sedute', () => {
  assert.equal(giftCardValueCents(form()), 7500);
  assert.equal(giftCardValueCents(form({ type: 'amount', value: 40.5 })), 4050);
  assert.equal(giftCardValueCents(form({ service: null })), 0);
});

test('che cosa manca per salvare, detto e non solo spento', () => {
  assert.deepEqual(giftCardMissing(form(), t), []);
  assert.deepEqual(giftCardMissing(form({ service: null }), t), ['Scegli il trattamento']);
  assert.deepEqual(giftCardMissing(form({ sessions: 0 }), t), [`Le sedute vanno da 1 a ${MAX_SESSIONS}`]);
  assert.deepEqual(giftCardMissing(form({ sessions: MAX_SESSIONS + 1 }), t), [`Le sedute vanno da 1 a ${MAX_SESSIONS}`]);
  assert.deepEqual(giftCardMissing(form({ kind: 'prepaid', recipient: null }), t), ['Scegli la cliente che ha pagato']);
  assert.deepEqual(giftCardMissing(form({ recipient: null }), t), ['Indica chi riceve il regalo']);
  assert.deepEqual(giftCardMissing(form({ recipient: null, byName: true, recipientName: 'Zia Carla' }), t), []);
  assert.deepEqual(giftCardMissing(form({ canCash: false }), t), ['Serve il permesso «vendite» per incassare']);
});

test('«Già pagato»: una cliente sola, acquirente e destinataria, senza consegna', () => {
  const body = giftCardPayload(form({ kind: 'prepaid', buyer: ANNA }));
  assert.deepEqual(body, {
    kind: 'prepaid', value: '75.00', gift_service_id: 3, sessions: 3,
    buyer_client_id: 4, recipient_client_id: 4, recipient_name: 'Sofia Ricci',
    paid: true, paid_method: 'card', delivery_date: null, expires_at: null,
  });
});

test('un regalo resta com’era, con le sedute se è un trattamento', () => {
  assert.deepEqual(giftCardPayload(form({ expiryMonths: 6 }), '2026-08-31'), {
    kind: 'gift', value: '75.00', gift_service_id: 3, sessions: 3,
    buyer_client_id: 5, recipient_client_id: 4, recipient_name: 'Sofia Ricci',
    paid: true, paid_method: 'card', delivery_date: '2026-12-24', expires_at: '2027-02-28T22:59:00.000Z',
  });
  const amount = giftCardPayload(form({ type: 'amount', value: 50, recipient: null, byName: true, recipientName: ' Zia Carla ', paid: false }));
  assert.deepEqual(amount, {
    kind: 'gift', value: '50.00', buyer_client_id: 5, recipient_client_id: null, recipient_name: 'Zia Carla',
    paid: false, paid_method: '', delivery_date: '2026-12-24', expires_at: null,
  });
});

/* ---- i pacchetti a listino ------------------------------------------------ */

test('validità e sedute dei pacchetti', () => {
  assert.equal(validityLabel(90, t), 'Valido 90 giorni dalla vendita');
  assert.equal(validityLabel(1, t), 'Valido 1 giorno dalla vendita');
  assert.equal(validityLabel(null, t), 'Senza scadenza');
  assert.equal(validityLabel(365, en), 'Valid 365 days from purchase');
  assert.equal(sessionsText(5, t), '5 sedute');
  assert.equal(sessionsText(1, t), '1 seduta');
  // il campo vuoto è «senza scadenza»; il server non accetta oltre dieci anni
  assert.equal(validityDaysPayload(''), null);
  assert.equal(validityDaysPayload(0), null);
  assert.equal(validityDaysPayload(180), 180);
  assert.equal(validityDaysPayload(99999), 3650);
});

/* ---- l'agenda: blocchi, anteprima, dettaglio ------------------------------ */

const { default: ItemBlock } = await loadComponent('apps/dashboard/src/sections/agenda/grid/ItemBlock.jsx');
const { default: WeekBlock } = await loadComponent('apps/dashboard/src/sections/agenda/grid/WeekBlock.jsx');
const { default: ApptHoverCard } = await loadComponent('apps/dashboard/src/sections/agenda/grid/ApptHoverCard.jsx');
const { default: ServicesReadOnly } = await loadComponent('apps/dashboard/src/sections/agenda/modals/detail/ServicesReadOnly.jsx');
const { default: ClientMetaBar } = await loadComponent('apps/dashboard/src/sections/agenda/modals/detail/ClientMetaBar.jsx');
const { ApptLine } = await loadComponent('apps/dashboard/src/sections/agenda/month/DayParts.jsx');

const visit = {
  id: 9, client: { id: MARIA, full_name: 'Maria Russo', phone: '' }, client_name: 'Maria Russo', operator_id: 1, status: 'confirmed',
  start: '2026-10-20T10:00:00+02:00', startMin: 600, endMin: 690, deposit_status: 'none', total_price: '75.00',
  items: [
    { id: 1, service_id: 3, service_name: 'Manicure', operator_id: 1, duration_min: 45, price: '40.00' },
    { id: 2, service_id: 4, service_name: 'Piega', operator_id: 1, duration_min: 45, price: '35.00' },
  ],
  gifts: [pacchetto],
};
const iconsOf = (tree) => findAll(tree, (el) => typeof el.type === 'function' && el.props?.name).map((el) => el.props.name);

test('vista giorno: il servizio coperto ha l’icona del suo tipo, l’altro no', () => {
  installDom();
  const block = (item) => ItemBlock({
    block: { item, appt: visit, isFirst: item.id === 1, index: item.id - 1, activeMin: 45, soakMin: 0 },
    startMin: 600, color: '#FDE2E4', t, lang: 'it', canWrite: true, onDown: () => {},
  });
  const covered = block(visit.items[0]);
  const mark = find(covered, (el) => el.props?.role === 'img');
  assert.match(mark.props['aria-label'], /^Manicure · Pacchetto «Mani perfette» · 3 sedute rimaste su 5/);
  assert.ok(iconsOf(covered).includes('box'));
  assert.equal(find(block(visit.items[1]), (el) => el.props?.role === 'img'), null);
});

test('vista settimana e mese: l’icona del tipo, con le sedute nel tooltip', () => {
  installDom();
  const a = { ...visit, gifts: [giaPagato] };
  const week = WeekBlock({ a, colorOf: () => '#C9B8F2', t, canWrite: true, left: 0, width: '100%' });
  const flag = find(week, (el) => el.type === 'span' && /Pagato in anticipo/.test(el.props?.title || ''));
  assert.ok(flag, 'il tooltip dice «Pagato in anticipo»');
  assert.ok(iconsOf(flag).includes('wallet'));
  const line = ApptLine({ a: { ...visit, gifts: [pacchetto] }, color: '#999', t });
  const icon = find(line, (el) => el.props?.role === 'img');
  assert.match(icon.props.title, /Pacchetto «Mani perfette» · 3 sedute rimaste su 5/);
  assert.ok(iconsOf(icon).includes('box'));
});

test('anteprima e dettaglio: «Pacchetto · 3/5 sedute», «Regalo · da Carla Ricci»', () => {
  installDom();
  const hover = ApptHoverCard({ hover: { a: visit, x: 0, y: 0, side: 'right' }, t, lang: 'it', operators: [], colorOf: () => '#999' });
  assert.match(textOf(hover), /Manicure · Pacchetto · 3\/5 sedute/);
  const rows = ServicesReadOnly({ appt: visit, operators: [], t, lang: 'it' });
  const chip = find(rows, (el) => el.type === 'span' && /Pacchetto/.test(el.props?.title || ''));
  assert.equal(textOf(chip), 'Pacchetto · 3/5 sedute');
  const bar = ClientMetaBar({ appt: { ...visit, gifts: [regalo, pacchetto] }, sm: { label: 'Confermato', color: '#000', tint: '#eee' }, t, lang: 'it', openClient: () => {} });
  const chips = findAll(bar, (el) => el.type === 'span' && el.props?.title && /Manicure/.test(el.props.title)).map(textOf);
  assert.deepEqual(chips, ['Regalo · da Carla Ricci', 'Pacchetto · 3/5 sedute']);
});

/* ---- nuova prenotazione: il servizio già pagato col suo nome, prezzo barrato ---- */

const { default: NewApptModal } = await loadComponent('apps/dashboard/src/sections/agenda/modals/NewApptModal.jsx', {
  stubs: ['ClientPicker.jsx'],
  expand: ['BookingFoot', 'DateBar', 'ServiceStep', 'TimeStep', 'ManualTime'],
});

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

async function drawerWith(cards) {
  installDom();
  const d = parseISO(todayStr());
  d.setDate(d.getDate() + 3);
  const day = toDateStr(d);
  globalThis.__api = {
    get: (url) => {
      if (url === '/api/clients/7') return Promise.resolve({ id: MARIA, full_name: 'Maria Russo' });
      if (url === '/api/marketing/gift-cards') return Promise.resolve({ items: cards });
      return Promise.resolve([]);
    },
    post: () => Promise.resolve({}), put: () => Promise.resolve({}), patch: () => Promise.resolve({}), del: () => Promise.resolve({}),
  };
  globalThis.__dash = {
    t, lang: 'it', serviceCategories: [], fireToast: spy(), hasScope: () => true, settings: { slot_interval_min: 15 },
    agendaPick: null, setAgendaPick: spy(), setTab: spy(), locationId: null,
    services: [{ id: 3, name_it: 'Manicure', duration_min: 45, soak_min: 0, price: '40.00', category_id: 1 }],
    operators: [{ id: 1, first_name: 'Anna', last_name: 'Neri', initials: 'AN', service_ids: [3] }],
  };
  const m = mount(NewApptModal, {
    prefill: { clientId: MARIA, clientName: 'Maria Russo', serviceIds: [3], date: day, start: isoAtMin(day, 600), operatorId: 1 },
    onClose: spy(), onCreated: spy(),
  });
  await flush(); m.render(); await flush(); m.render();
  return m;
}

const owned = (extra) => ({
  id: 40, code: 'PACC1234ABCD', gift_service_id: 3, gift_service_name: 'Manicure', payment_status: 'paid', status: 'active',
  balance: '0.00', initial_value: '0.00', expires_at: null, buyer_client_id: MARIA, buyer_name: 'Maria Russo',
  recipient_client_id: MARIA, recipient_name: 'Maria Russo', ...extra,
});

test('nuova prenotazione: «Pacchetto · 4/5 sedute» e «Già pagato» col prezzo barrato, «Regalo» da chi l’ha regalato', async () => {
  const chipOf = (m) => find(m.tree, (el) => el.type === 'span' && /^Manicure ·/.test(el.props?.title || ''));
  const priceOf = (m) => find(m.tree, (el) => el.type === 'span' && el.props?.className === 't-num' && textOf(el) === '€40,00');

  // pacchetto in omaggio: saldo zero, quattro sedute su cinque
  let m = await drawerWith([owned({ kind: 'package', sessions_total: 5, sessions_left: 4, package_name: 'Mani perfette' })]);
  assert.equal(textOf(chipOf(m)), 'Pacchetto · 4/5 sedute');
  assert.equal(priceOf(m).props.style.textDecoration, 'line-through');
  m.unmount();

  m = await drawerWith([owned({ kind: 'prepaid', balance: '40.00' })]);
  assert.equal(textOf(chipOf(m)), 'Già pagato');
  assert.equal(priceOf(m).props.style.textDecoration, 'line-through');
  m.unmount();

  // comprata da lei senza `kind` (un server di prima): «Regalo», senza il suo nome
  m = await drawerWith([owned({ balance: '40.00' })]);
  assert.equal(textOf(chipOf(m)), 'Regalo');
  m.unmount();
  m = await drawerWith([owned({ balance: '40.00', buyer_client_id: 9, buyer_name: 'Carla Ricci' })]);
  assert.equal(textOf(chipOf(m)), 'Regalo · da Carla');
  m.unmount();
});
