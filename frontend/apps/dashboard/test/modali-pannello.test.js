// Il pannello di dettaglio (ApptDetailModal.jsx vero, montato con
// test/grid-harness.mjs; DkPanel non si disegna e se ne guardano le props):
// che cosa manda al server e che cosa dice, gesto per gesto. Sono i
// comportamenti da tenere fermi mentre il pannello si divide in pezzi:
// «Passa a», orario e giorno (409 → si forza, versione cambiata nel frattempo,
// «Annulla» dell'avviso), salvataggio di servizi e nota (409, 412),
// annullamento e no-show, caparra, «Riprogramma».
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { fmtDateIt, isoAtMin, parseISO, toDateStr, todayStr } from '@youty/shared';
import { find, installDom, loadComponent, mount, spy, textOf } from './grid-harness.mjs';

const { default: ApptDetailModal } = await loadComponent('apps/dashboard/src/sections/agenda/modals/ApptDetailModal.jsx');

const TODAY = todayStr();
const plus = (n) => { const d = parseISO(TODAY); d.setDate(d.getDate() + n); return toDateStr(d); };
const DAY = plus(3);   // la visita: fra tre giorni alle 10:00 (niente penali, nessun timer)
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const OPS = [
  { id: 1, first_name: 'Anna', last_name: 'Neri', initials: 'AN', service_ids: [3, 4] },
  { id: 4, first_name: 'Bea', last_name: 'Rossi', initials: 'BR', service_ids: [3, 4] },
];
const SERVICES = [
  { id: 3, name_it: 'Taglio', duration_min: 30, soak_min: 0, price: '35.00', category_id: 1 },
  { id: 4, name_it: 'Colore', duration_min: 60, soak_min: 30, price: '60.00', category_id: 1 },
];
const item = (id, sid, name, dur, soak, price) => ({ id, service_id: sid, service_name: name, operator_id: 1, operator_name: 'Anna', duration_min: dur, soak_min: soak, price });
const visit = (extra = {}) => ({
  id: 41, status: 'confirmed', operator_id: 1, start: isoAtMin(DAY, 10 * 60), total_duration_min: 120, total_price: '95.00',
  client: { id: 7, full_name: 'Maria Russo' }, note: '', deposit_status: 'none', deposit_amount: '0.00',
  items: [item(411, 3, 'Taglio', 30, 0, '35.00'), item(412, 4, 'Colore', 60, 30, '60.00')],
  updated_at: '2026-09-20T08:00:00.000000+00:00',
  ...extra,
});

function setup(appt = visit(), dash = {}) {
  installDom();
  const ApiError = globalThis.__ApiError;
  const calls = { get: [], post: [], put: [] };
  const state = {
    server: appt, undo: [{ id: 90, kind: 'move', label: 'Spostamento di Maria' }], waitlist: [], slots: [],
    onPost: null, onPut: null,
  };
  globalThis.__api = {
    get: (url, opts) => {
      calls.get.push({ url, opts });
      if (url === '/api/agenda/appointments/41') return Promise.resolve(state.server);
      if (url === '/api/agenda/undo') return Promise.resolve(state.undo);
      if (url === '/api/agenda/waitlist') return Promise.resolve(state.waitlist);
      if (url === '/api/agenda/availability') return Promise.resolve(state.slots);
      if (url === '/api/clients/7') return Promise.resolve({ id: 7, visits: 0 });
      return Promise.resolve([]);
    },
    post: (url, body) => {
      calls.post.push({ url, body });
      return state.onPost ? state.onPost(url, body, calls.post.length) : Promise.resolve({ ...state.server });
    },
    put: (url, body) => {
      calls.put.push({ url, body });
      return state.onPut ? state.onPut(body, calls.put.length) : Promise.resolve({ ...state.server, ...body });
    },
    patch: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  };
  globalThis.__dash = {
    t: (it) => it, lang: 'it', operators: OPS, opColors: {}, services: SERVICES, serviceCategories: [],
    settings: { slot_interval_min: 15, cancel_min_hours: 24 }, session: { is_owner: true },
    fireToast: spy(), openModal: spy(), setTab: spy(), setDeepLink: spy(), setSelClient: spy(), hasScope: () => true,
    ...dash,
  };
  const props = { appointment: appt, onMutate: spy(), onClose: spy(), onShowDate: spy() };
  const m = mount(ApptDetailModal, props);
  mounted.push(m);
  const g = {
    m, calls, state, props, ApiError, dash: globalThis.__dash,
    render: () => m.render(),
    panel: () => find(m.tree, (el) => el.type?.name === 'DkPanel'),
    /** il primo bottone (nel corpo del pannello, o in `where`) che dice `text` */
    button: (text, where) => find(where ?? m.tree, (el) => el.type === 'button' && textOf(el).includes(text)),
    footButton: (text) => find(g.panel().props.foot, (el) => el.type === 'button' && textOf(el).includes(text)),
    toasts: () => g.dash.fireToast.calls.map(([x]) => x),
    lastToast: () => g.dash.fireToast.calls.at(-1)?.[0],
    moves: () => calls.post.filter((p) => p.url === '/api/agenda/appointments/41/move'),
  };
  return g;
}
async function settle(g) { await flush(); g.render(); }
const conflict = (g) => new g.ApiError(409, 'Orario non più disponibile', { detail: 'Orario non più disponibile' });
// ogni pannello montato si smonta a fine test, anche se un'asserzione fallisce:
// i timer del pannello (l'orologio del no-show) non devono tenere vivo il file
const mounted = [];
afterEach(() => { while (mounted.length) mounted.pop().unmount(); });

test('«Passa a Bea»: rilegge la visita, sposta con from_operator_id e dice a chi è passata', async () => {
  const g = setup();
  await settle(g);
  // la pillola di «Passa a» (quelle delle righe dei servizi non hanno `disabled`)
  const bea = find(g.m.tree, (el) => el.type === 'button' && textOf(el).includes('Bea') && 'disabled' in el.props);
  bea.props.onClick();
  await settle(g);
  assert.ok(g.calls.get.some((x) => x.url === '/api/agenda/appointments/41'), 'prima si rilegge la visita');
  assert.deepEqual(g.moves().map((p) => p.body), [{ start: isoAtMin(DAY, 600), operator_id: 4, from_operator_id: 1, force: false }]);
  const toast = g.lastToast();
  assert.equal(toast.msg, 'Passato a Bea, 10:00');
  assert.equal(toast.icon, 'calendar');
  assert.equal(toast.undo, 'Annulla');
  assert.deepEqual(g.props.onShowDate.calls.at(-1), [DAY]);
  assert.equal(g.props.onMutate.calls.length, 1);
});

test('spostamento dal pannello su uno slot occupato: al 409 si riscrive forzando', async () => {
  const g = setup();
  g.state.onPost = (url, body, n) => (n === 1 ? Promise.reject(conflict(g)) : Promise.resolve({ ...g.state.server }));
  await settle(g);
  // orario scritto a mano: 11:15
  let time = find(g.m.tree, (el) => el.type === 'input' && el.props['aria-label'] === 'Ora di inizio');
  time.props.onChange({ target: { value: '11:15' } });
  g.render();
  time = find(g.m.tree, (el) => el.type === 'input' && el.props['aria-label'] === 'Ora di inizio');
  time.props.onBlur();
  await settle(g);
  assert.deepEqual(g.moves().map((p) => p.body), [
    { start: isoAtMin(DAY, 675), force: false },
    { start: isoAtMin(DAY, 675), force: true },
  ]);
  assert.equal(g.lastToast().msg, 'Spostato · 11:15');
});

test('la visita spostata nel frattempo: niente spostamento, e lo si dice', async () => {
  const g = setup();
  await settle(g);
  g.state.server = visit({ start: isoAtMin(DAY, 14 * 60), updated_at: '2026-09-20T09:00:00.000000+00:00' });
  const later = find(g.m.tree, (el) => el.type === 'button' && el.props['aria-label'] === 'Posticipa');
  later.props.onClick();
  await settle(g);
  assert.equal(g.moves().length, 0);
  assert.equal(g.lastToast().msg, 'L’appuntamento è cambiato nel frattempo: controlla l’orario e riprova');
});

test('un altro giorno sfogliato dal pannello: «Sposta a …» alla stessa ora, e «Annulla» passa dal torna indietro', async () => {
  const g = setup();
  await settle(g);
  const next = find(g.m.tree, (el) => el.type === 'button' && el.props['aria-label'] === 'Giorno dopo');
  next.props.onClick();
  g.render();
  const day4 = plus(4);
  assert.deepEqual(g.props.onShowDate.calls.at(-1), [day4], 'l\'agenda di fianco segue il giorno');
  g.button('Sposta a').props.onClick();
  await settle(g);
  assert.deepEqual(g.moves().map((p) => p.body), [{ start: isoAtMin(day4, 600), force: false }]);
  assert.equal(g.lastToast().msg, `Spostato · ${fmtDateIt(day4)} · 10:00`);
  // «Annulla» dell'avviso: la voce del gesto, dalla pila del server
  g.state.onPost = (url) => Promise.resolve(url === '/api/agenda/undo' ? { label: 'Spostamento di Maria', date: DAY } : {});
  g.lastToast().undoFn();
  await settle(g);
  const undo = g.calls.post.filter((p) => p.url === '/api/agenda/undo');
  assert.deepEqual(undo.map((p) => p.body), [{ entry_id: 90 }]);
  assert.equal(g.lastToast().msg, 'Annullato · Spostamento di Maria');
  assert.deepEqual(g.props.onShowDate.calls.at(-1), [DAY]);
});

test('nota modificata: «Salva» scrive sulla versione letta (expected_updated_at)', async () => {
  const g = setup();
  await settle(g);
  find(g.m.tree, (el) => el.type === 'textarea').props.onChange({ target: { value: 'Porta la foto' } });
  g.render();
  g.footButton('Salva').props.onClick();
  await settle(g);
  assert.deepEqual(g.calls.put.map((p) => [p.url, p.body]), [
    ['/api/agenda/appointments/41', { expected_updated_at: '2026-09-20T08:00:00.000000+00:00', note: 'Porta la foto' }],
  ]);
  assert.deepEqual(g.lastToast(), { msg: 'Appuntamento aggiornato', icon: 'check' });
  assert.equal(g.props.onMutate.calls.length, 1);
});

test('salvataggio sopra un altro impegno (409): si scrive forzando e lo si dice', async () => {
  const g = setup();
  g.state.onPut = (body, n) => (n === 1 ? Promise.reject(conflict(g)) : Promise.resolve({ ...g.state.server, ...body }));
  await settle(g);
  find(g.m.tree, (el) => el.type === 'textarea').props.onChange({ target: { value: 'Porta la foto' } });
  g.render();
  g.footButton('Salva').props.onClick();
  await settle(g);
  assert.deepEqual(g.calls.put.map((p) => p.body.force), [undefined, true]);
  assert.deepEqual(g.lastToast(), { msg: 'Appuntamento aggiornato · si sovrappone a un altro impegno', icon: 'alert' });
});

test('salvataggio su una versione superata (412): mai forzare, si ricarica e si dice perché', async () => {
  const g = setup();
  g.state.onPut = () => Promise.reject(new g.ApiError(412, 'L’appuntamento è stato modificato da un’altra postazione', {}));
  await settle(g);
  find(g.m.tree, (el) => el.type === 'textarea').props.onChange({ target: { value: 'Porta la foto' } });
  g.render();
  const before = g.calls.get.filter((x) => x.url === '/api/agenda/appointments/41').length;
  g.footButton('Salva').props.onClick();
  await settle(g);
  assert.equal(g.calls.put.length, 1);
  assert.ok(g.calls.get.filter((x) => x.url === '/api/agenda/appointments/41').length >= before + 2, 'rilettura prima e ricarico dopo');
  assert.deepEqual(g.lastToast(), { msg: 'L’appuntamento è stato modificato da un’altra postazione', icon: 'alert' });
});

test('annullamento chiesto dalla cliente sotto le 24 ore: by_client e caparra trattenuta', async () => {
  const appt = visit({ start: new Date(Date.now() + 2 * 3600000).toISOString(), deposit_status: 'paid', deposit_amount: '20.00' });
  const g = setup(appt);
  await settle(g);
  g.footButton('Cancella').props.onClick();
  g.render();
  assert.equal(g.panel().props.title, 'Cancella appuntamento');
  g.button('La cliente, che ha disdetto').props.onClick();
  g.render();
  assert.match(textOf(g.panel()), /Mancano meno di 24 ore/);
  assert.equal(g.footButton('Conferma cancellazione').props.disabled, true, 'senza motivazione non si conferma');
  g.button('Richiesta cliente').props.onClick();
  g.render();
  g.footButton('Conferma cancellazione').props.onClick();
  await settle(g);
  assert.deepEqual(g.calls.post.map((p) => [p.url, p.body]), [
    ['/api/agenda/appointments/41/cancel', { reason: 'Richiesta cliente', by_client: true }],
  ]);
  assert.deepEqual(g.lastToast(), { msg: 'Appuntamento cancellato · caparra trattenuta', icon: 'x' });
  assert.equal(g.props.onMutate.calls.length, 1);
  assert.ok(g.calls.get.some((x) => x.url === '/api/agenda/waitlist'), 'lo slot liberato si offre alla lista d\'attesa');
  assert.equal(g.props.onClose.calls.length, 1, 'nessuna in attesa: il pannello si chiude');
});

test('no-show di una visita cominciata: la motivazione proposta e lo slot liberato', async () => {
  const g = setup(visit({ start: new Date(Date.now() - 3600000).toISOString() }));
  await settle(g);
  g.footButton('No-show').props.onClick();
  g.render();
  assert.equal(g.panel().props.title, 'Segna no-show');
  g.footButton('Conferma no-show').props.onClick();
  await settle(g);
  assert.deepEqual(g.calls.post.map((p) => [p.url, p.body]), [
    ['/api/agenda/appointments/41/no-show', { reason: 'Mancata presenza' }],
  ]);
  assert.deepEqual(g.lastToast(), { msg: 'No-show registrato · slot liberato', icon: 'alert' });
  assert.equal(g.props.onClose.calls.length, 1);
});

test('caparra da versare: link di pagamento, Stripe non configurato, incasso al banco', async () => {
  const due = new Date(Date.now() + 5 * 86400000).toISOString();
  const g = setup(visit({ deposit_status: 'required', deposit_amount: '20.00', deposit_due_at: due }));
  g.state.onPost = (url) => Promise.resolve(url.endsWith('/deposit-link') ? { url: 'https://pay.example/x', due_at: due } : { ...g.state.server, deposit_status: 'paid' });
  await settle(g);
  g.button('Invia link di pagamento').props.onClick();
  await settle(g);
  assert.deepEqual(g.calls.post.at(-1), { url: '/api/sales/appointments/41/deposit-link', body: {} });
  assert.deepEqual(g.lastToast(), { msg: 'Link di pagamento inviato alla cliente', icon: 'check' });
  assert.equal(g.props.onMutate.calls.at(-1)[0].deposit_payment_link, 'https://pay.example/x');
  // col link già mandato il bottone sollecita
  g.state.onPost = () => Promise.reject(new g.ApiError(503, 'Stripe non configurato', {}));
  g.button('Sollecita').props.onClick();
  await settle(g);
  assert.equal(g.lastToast().msg, 'Pagamenti online non configurati: collega Stripe in Impostazioni → Pagamenti');
  g.state.onPost = () => Promise.resolve({ ...g.state.server, deposit_status: 'paid' });
  g.button('Incassata: contanti').props.onClick();
  await settle(g);
  assert.deepEqual(g.calls.post.at(-1), { url: '/api/agenda/appointments/41/deposit-cashed', body: { method: 'cash' } });
  assert.deepEqual(g.lastToast(), { msg: 'Caparra incassata e registrata in cassa', icon: 'check' });
});

test('«Riprogramma»: orari liberi per questa visita, e l\'orario preso nel frattempo si forza solo al secondo «Sposta qui»', async () => {
  const g = setup();
  const s1 = isoAtMin(DAY, 11 * 60), s2 = isoAtMin(DAY, 11 * 60 + 30);
  g.state.slots = [{ start: s1, assignment: [] }, { start: s2, assignment: [] }];
  await settle(g);
  g.footButton('Riprogramma').props.onClick();
  await settle(g);
  const el = find(g.m.tree, (x) => x.type?.name === 'RescheduleFlow');
  assert.ok(el, 'il flusso di riprogrammazione');
  const rf = mount(el.type, el.props);
  mounted.push(rf);
  await flush(); rf.render();
  const avail = g.calls.get.filter((x) => x.url === '/api/agenda/availability');
  assert.deepEqual(avail.at(-1).opts.params, {
    date: DAY, items: [{ service_id: 3, operator_id: 1 }, { service_id: 4, operator_id: 1 }], location_id: undefined, exclude_appointment_id: 41,
  });
  const panel = () => find(rf.tree, (x) => x.type?.name === 'DkPanel');
  find(rf.tree, (x) => x.type === 'button' && textOf(x) === '11:00').props.onClick();
  rf.render();
  // 11:00 era libero, ma intanto lo ha preso un'altra: ci si ferma e si ricarica
  g.state.onPost = (url, body, n) => (n === 1 || (n === 2 && !body.force) ? Promise.reject(conflict(g)) : Promise.resolve({ ...g.state.server, start: s1 }));
  find(panel().props.foot, (x) => x.type === 'button' && textOf(x).includes('Sposta qui')).props.onClick();
  await flush(); rf.render();
  assert.deepEqual(g.moves().map((p) => p.body), [{ start: s1, force: false }]);
  assert.match(g.lastToast().msg, /^Le 11:00 sono state appena occupate/);
  assert.equal(g.calls.get.filter((x) => x.url === '/api/agenda/availability').length, avail.length + 1, 'orari ricaricati');
  // di nuovo «Sposta qui»: adesso si sposta comunque
  find(panel().props.foot, (x) => x.type === 'button' && textOf(x).includes('Sposta qui')).props.onClick();
  await flush(); rf.render();
  assert.deepEqual(g.moves().map((p) => p.body), [{ start: s1, force: false }, { start: s1, force: false }, { start: s1, force: true }]);
  assert.deepEqual(g.lastToast(), { msg: 'Appuntamento riprogrammato alle 11:00 · forzato', icon: 'alert' });
  assert.equal(g.props.onClose.calls.length, 1, 'riprogrammato: il pannello si chiude');
});
