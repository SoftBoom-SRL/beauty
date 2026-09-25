// La sezione agenda (index.jsx vero, montato con test/grid-harness.mjs; griglie,
// pannello laterale e drawer sono muti e se ne guardano le props). Reperti della
// caccia ai bug del 22/09/2026: 13-01 = 12-05 = 17-06 e 13-07 = 12-11 («Sposta
// qui»), 13-08 (prenotazione aperta), 12-17 (ombra in settimana), 12-13 (orario
// passato), 03-15 («Annulla» degli avvisi), C2 (ridimensionamento con
// expected_updated_at), 12-24 («Vai a una data»), 12-09 (eventi live). Bug
// sospetti del 24/09/2026: n. 49 (gesto riuscito, ricarico fallito).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isoAtMin, parseISO, toDateStr, todayStr } from '@youty/shared';
import { find, installDom, loadComponent, mount, spy, textOf } from './grid-harness.mjs';

const { default: AgendaSection } = await loadComponent('apps/dashboard/src/sections/agenda/index.jsx', {
  stubs: ['DayGrid.jsx', 'WeekView.jsx', 'MonthView.jsx', 'RightRail.jsx', 'GroupBookingDrawer.jsx'],
  // i pezzi senza hook della barra e della sezione, che per i test fanno parte di index.jsx
  expand: ['JumpTitle', 'DayStrip', 'UndoButton', 'ZoomControls', 'ViewSelector', 'PickBanner', 'RailPanel', 'SlotMenu'],
});

const TODAY = todayStr();
const plus = (n) => { const d = parseISO(TODAY); d.setDate(d.getDate() + n); return toDateStr(d); };
const TUE = plus(1), THU = plus(3);
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const OPS = [
  { id: 1, first_name: 'Anna', last_name: 'Neri', initials: 'AN' },
  { id: 2, first_name: 'Giulia', last_name: 'Verdi', initials: 'GV' },
  { id: 3, first_name: 'Carla', last_name: 'Blu', initials: 'CB' },
  { id: 4, first_name: 'Bea', last_name: 'Rossi', initials: 'BR' },
];
const it = (id, name, op, dur, order) => ({ id, service_id: id, service_name: name, operator_id: op, duration_min: dur, soak_min: 0, order });
// Maria, martedì: manicure 10:00 con Anna (principale) + piega 11:00 con Giulia
const maria = (ops = [1, 2]) => ({
  id: 41, status: 'confirmed', operator_id: ops[0], start: isoAtMin(TUE, 10 * 60), total_duration_min: 90,
  client: { id: 7, full_name: 'Maria Russo' }, items: [it(411, 'Manicure', ops[0], 60, 0), it(412, 'Piega', ops[1], 30, 1)],
  updated_at: '2026-09-20T08:00:00Z',
});
const sara = {
  id: 42, status: 'confirmed', operator_id: 1, start: isoAtMin(TODAY, 15 * 60), total_duration_min: 30,
  client: { id: 8, full_name: 'Sara Bianchi' }, items: [it(421, 'Manicure', 1, 30, 0)], updated_at: '2026-09-21T09:30:00Z',
};
const rowsFor = (appts = []) => OPS.map((o) => ({
  operator: { id: o.id, name: `${o.first_name} ${o.last_name}` }, windows: [['09:00', '19:00']],
  appointments: appts.filter((a) => a.operator_id === o.id), pauses: [],
}));

function setup({ modal = null, undo = [], rows = null, storage = {} } = {}) {
  const win = installDom({ storage });
  globalThis.setInterval = () => 0;      // l'orologio dell'agenda (ogni 30 s) non serve qui
  globalThis.clearInterval = () => {};
  const ApiError = globalThis.__ApiError;
  // `dayError`: se c'è, la GET della giornata fallisce con quell'errore
  const state = { undo, appts: { 41: maria(), 42: sara }, days: { [TODAY]: rows || rowsFor([sara]) }, put: null, undoPost: null, onMovePost: null, dayError: null };
  const calls = { get: [], post: [], put: [], del: [] };
  globalThis.__api = {
    get: (url, opts) => {
      calls.get.push({ url, opts });
      if (url === '/api/agenda/day') return state.dayError ? Promise.reject(state.dayError) : Promise.resolve(state.days[opts.params.date] || rowsFor());
      if (url === '/api/agenda/undo') return Promise.resolve(state.undo);
      const m = /^\/api\/agenda\/appointments\/(\d+)$/.exec(url);
      if (m) return Promise.resolve(state.appts[m[1]]);
      return Promise.resolve([]);
    },
    post: (url, body) => {
      calls.post.push({ url, body });
      if (url === '/api/agenda/undo') return state.undoPost ? state.undoPost(body) : Promise.resolve({ ok: true, label: 'fatto' });
      if (url.endsWith('/move') && state.onMovePost) state.onMovePost(body);
      return Promise.resolve({});
    },
    put: (url, body) => { calls.put.push({ url, body }); return state.put ? state.put(body, calls.put.length) : Promise.resolve({}); },
    patch: () => Promise.resolve({}),
    del: (url) => { calls.del.push({ url }); return Promise.resolve({}); },
  };
  let liveFn = null;
  let modalSeq = 0;
  globalThis.__dash = {
    t: (x) => x, lang: 'it', operators: OPS, services: [], serviceCategories: [], hasScope: () => true,
    openModal: spy(), modal, fireToast: spy(), opColors: {}, setOpColor: spy(), opPalette: [],
    setTab: spy(), setDeepLink: spy(), showRevenue: false, setAgendaPick: spy(), setAgendaDate: spy(),
    settings: { slot_interval_min: 15 }, session: { is_owner: true }, locationId: null, toastProps: { onDone: spy() },
    live: { subscribe: (fn) => { liveFn = fn; return () => {}; } },
  };
  const m = mount(AgendaSection, {});
  const g = {
    m, calls, state, win, dash: globalThis.__dash, ApiError,
    render: () => m.render(),
    dg: () => find(m.tree, (el) => el.type?.name === 'DayGrid'),
    wv: () => find(m.tree, (el) => el.type?.name === 'WeekView'),
    button: (text) => find(m.tree, (el) => el.type === 'button' && textOf(el).includes(text)),
    live: (events) => liveFn?.({ events }),
    /* l'ultimo openModal diventa il modale aperto (come fa ctx.jsx) */
    openLast() {
      const [name, props] = g.dash.openModal.calls.at(-1);
      g.dash.modal = { id: ++modalSeq, name, props };
      m.render();
      return props;
    },
    lastToast: () => g.dash.fireToast.calls.at(-1)?.[0],
  };
  return g;
}
async function ready(g) { await flush(); g.render(); }

test('«Sposta qui» sull\'ombra di un altro giorno sposta davvero la visita, stessa ora e stesse operatrici', async () => {
  const g = setup();
  await ready(g);
  g.dg().props.onOpenAppt(maria());                 // clic sul blocco di Maria
  const panel = g.openLast();
  panel.onShowDate(THU);                             // dal pannello si sfoglia giovedì
  await ready(g);
  assert.equal(g.dg().props.ghost?.id, 41, 'giovedì compare l\'ombra di Maria');
  // clic dentro l'ombra della piega (Giulia, 11:00)
  g.dg().props.onSlotMenu(2, 11 * 60, 300, 300, { ok: true, code: 'ok', label: 'Disponibile' }, { ghostHit: true });
  g.render();
  g.button('Sposta qui').props.onClick();
  await flush();
  const mv = g.calls.post.find((p) => p.url === '/api/agenda/appointments/41/move');
  assert.ok(mv, 'la richiesta di spostamento parte');
  assert.equal(mv.body.start, isoAtMin(THU, 10 * 60), 'giovedì alle 10:00, l\'ora della visita');
  assert.equal(mv.body.operator_id, undefined, 'nessuna operatrice cambia');
});

test('«Sposta qui» alla stessa ora e nella stessa colonna di un altro giorno non è un non-movimento', async () => {
  const g = setup();
  await ready(g);
  g.dg().props.onOpenAppt(maria());
  const panel = g.openLast();
  panel.onShowDate(THU);
  await ready(g);
  // «10:00 · qui» nella colonna di Anna, dove l'ombra dice «qui»
  g.dg().props.onSlotMenu(1, 10 * 60, 300, 300, { ok: true, code: 'ok', label: 'Disponibile' }, { ghostHit: true });
  g.render();
  g.button('Sposta qui').props.onClick();
  await flush();
  const mv = g.calls.post.find((p) => p.url === '/api/agenda/appointments/41/move');
  assert.ok(mv, 'prima non partiva nessuna richiesta e Maria restava a martedì');
  assert.equal(mv.body.start, isoAtMin(THU, 10 * 60));
  assert.match(g.dash.fireToast.calls.map(([x]) => x.msg).join(' | '), /Spostato a/);
});

test('«Sposta qui» parte dall\'operatrice di adesso, non da quella dell\'apertura', async () => {
  const g = setup();
  await ready(g);
  g.dg().props.onOpenAppt(maria());
  const panel = g.openLast();
  // dal pannello la manicure passa da Anna a Bea: il pannello lo segnala
  g.state.appts[41] = maria([4, 2]);
  panel.onMutate();
  await ready(g);
  panel.onShowDate(THU);
  await ready(g);
  const ghost = g.dg().props.ghost;
  assert.equal(ghost?.operator_id, 4, 'l\'ombra è nella colonna di Bea');
  // clic su uno spazio libero di Carla alle 15:00
  g.dg().props.onSlotMenu(3, 15 * 60, 300, 300, { ok: true, code: 'ok', label: 'Disponibile' });
  g.render();
  g.button('Sposta qui').props.onClick();
  await flush();
  const mv = g.calls.post.find((p) => p.url === '/api/agenda/appointments/41/move');
  assert.ok(mv);
  assert.deepEqual([mv.body.operator_id, mv.body.from_operator_id], [3, 4], 'i servizi di Bea passano a Carla');
});

test('con la prenotazione aperta un clic in griglia sceglie l\'orario e non la sostituisce', async () => {
  const g = setup({ modal: { id: 50, name: 'newappt', props: {} } });
  await ready(g);
  g.dg().props.onOpenAppt(sara);                    // clic su un blocco esistente
  assert.equal(g.dash.openModal.calls.length, 0, 'il dettaglio non prende il posto della prenotazione');
  assert.equal(g.lastToast()?.icon, 'info');
  g.button('Settimana').props.onClick();
  g.render();
  assert.match(textOf(g.m.tree), /Scelta orario/, 'anche in settimana si dice che si sta scegliendo l\'orario');
  const start = isoAtMin(THU, 11 * 60);
  g.wv().props.onNewAppt({ operatorId: 2, start, date: THU });
  assert.equal(g.dash.openModal.calls.length, 0, 'nessun drawer nuovo');
  assert.deepEqual(g.dash.setAgendaPick.calls.at(-1)?.[0], { operatorId: 2, start, date: THU });
});

test('in settimana aprendo un appuntamento il giorno scelto diventa il suo: niente ombra altrove', async () => {
  const g = setup();
  await ready(g);
  g.button('Settimana').props.onClick();
  g.render();
  const thuSara = { ...sara, id: 43, start: isoAtMin(THU, 15 * 60) };
  g.state.appts[43] = thuSara;
  g.wv().props.onOpenAppt(thuSara, () => {});
  g.openLast();
  await ready(g);
  assert.equal(g.wv().props.ghostDate, THU);
  assert.equal(g.wv().props.ghost, null, 'nessuna ombra sul giorno che la sezione aveva prima');
});

test('un rilascio su un orario già passato prova senza forzare', async () => {
  const g = setup();
  await ready(g);
  g.dg().props.onInvalidDrop({ ok: false, code: 'past', label: 'Orario passato' }, {}, { kind: 'appt', appt: sara, newApptStart: 10 * 60, opArg: 1, fromOp: 1 });
  await flush();
  const mv = g.calls.post.find((p) => p.url === '/api/agenda/appointments/42/move');
  assert.ok(mv);
  assert.equal(mv.body.force, false);
});

test('l\'«Annulla» dell\'avviso annulla quel gesto (con l\'id della sua voce)', async () => {
  const g = setup({ undo: [{ id: 7, kind: 'move', label: 'Gesto di prima' }] });
  await ready(g);
  g.state.onMovePost = () => { g.state.undo = [{ id: 8, kind: 'move', label: 'Spostamento di Sara' }, { id: 7, kind: 'move', label: 'Gesto di prima' }]; };
  g.dg().props.onMoveAppt(sara, 16 * 60, 1, { fromOp: 1 });
  await ready(g);
  const toast = g.lastToast();
  assert.equal(typeof toast?.undoFn, 'function');
  toast.undoFn();
  await flush();
  const undo = g.calls.post.filter((p) => p.url === '/api/agenda/undo');
  assert.deepEqual(undo.map((p) => p.body), [{ entry_id: 8 }]);
});

test('«Indietro» e poi «Annulla» durante la richiesta: un annullamento solo, e l\'avviso si chiude', async () => {
  const g = setup({ undo: [{ id: 7, kind: 'move', label: 'Gesto di prima' }] });
  await ready(g);
  g.state.onMovePost = () => { g.state.undo = [{ id: 8, kind: 'move', label: 'Spostamento di Sara' }, { id: 7, kind: 'move', label: 'Gesto di prima' }]; };
  g.dg().props.onMoveAppt(sara, 16 * 60, 1, { fromOp: 1 });
  await ready(g);
  const toast = g.lastToast();
  let release;
  g.state.undoPost = () => new Promise((r) => { release = () => r({ ok: true, label: 'Spostamento di Sara' }); });
  const back = find(g.m.tree, (el) => el.type === 'button' && el.props['aria-label'] === 'Torna indietro');
  back.props.onClick();                              // «Indietro» in barra: richiesta in volo
  assert.ok(g.dash.toastProps.onDone.calls.length >= 1, 'l\'avviso con «Annulla» si chiude');
  toast.undoFn();                                    // «Annulla» premuto subito dopo
  await flush();
  assert.equal(g.calls.post.filter((p) => p.url === '/api/agenda/undo').length, 1, 'un solo POST /undo');
  release();
  await flush();
});

test('ridimensionare manda expected_updated_at e al 412 ricarica senza forzare', async () => {
  const g = setup();
  await ready(g);
  g.state.put = () => Promise.reject(new g.ApiError(412, 'L\'appuntamento è stato modificato nel frattempo: ricarica e riprova'));
  const dayLoads = () => g.calls.get.filter((x) => x.url === '/api/agenda/day').length;
  const before = dayLoads();
  g.dg().props.onResizeItem(sara, sara.items[0], 45);
  await flush();
  assert.equal(g.calls.put.length, 1, 'nessun secondo tentativo, men che meno forzato');
  assert.equal(g.calls.put[0].body.expected_updated_at, sara.updated_at);
  assert.equal(g.calls.put[0].body.force, false);
  assert.equal(g.lastToast()?.icon, 'alert');
  assert.ok(dayLoads() > before, 'la giornata si ricarica');
});

test('ridimensionare su uno slot occupato forza una volta, sempre con expected_updated_at', async () => {
  const g = setup();
  await ready(g);
  g.state.put = (body, n) => (n === 1 ? Promise.reject(new g.ApiError(409, 'Orario non più disponibile')) : Promise.resolve({}));
  g.dg().props.onResizeItem(sara, sara.items[0], 45);
  await flush();
  assert.equal(g.calls.put.length, 2);
  assert.deepEqual(g.calls.put.map((p) => [p.body.force, p.body.expected_updated_at]), [[false, sara.updated_at], [true, sara.updated_at]]);
});

test('«Vai a una data» scritta a tastiera non salta al 1902', async () => {
  const g = setup();
  await ready(g);
  const year = String(parseISO(TODAY).getFullYear());
  g.button(year).props.onClick();                    // apre il selettore di mese/data
  g.render();
  const pop = find(g.m.tree, (el) => el.type?.name === 'JumpPopover');
  assert.ok(pop);
  const input = find(pop.type(pop.props), (el) => el.type === 'input' && el.props.type === 'date');
  input.props.onChange({ target: { value: '0002-10-01' } });   // primo tasto dell'anno
  g.render();
  assert.equal(g.dg().props.date, TODAY, 'nessun salto');
  input.props.onChange({ target: { value: plus(10) } });
  g.render();
  await ready(g);
  assert.equal(g.dg().props.date, plus(10));
});

test('turni e assenze cambiati altrove ricaricano la giornata', async () => {
  const g = setup();
  await ready(g);
  const dayLoads = () => g.calls.get.filter((x) => x.url === '/api/agenda/day').length;
  const before = dayLoads();
  g.live([{ type: 'operator.absence_created' }]);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(dayLoads() > before);
});

test('il pannello aperto non si rimonta: né al secondo clic sul blocco né dopo «Sposta qui»', async () => {
  // 13-05: riaprirlo (openModal con un id nuovo) rimontava il pannello e
  // buttava servizi e nota non ancora salvati. Il pannello si rilegge da sé
  // con gli eventi live; la sezione rinfresca solo la copia dell'ombra.
  const g = setup();
  await ready(g);
  g.dg().props.onOpenAppt(maria());
  const panel = g.openLast();
  g.dg().props.onOpenAppt(maria());                  // secondo clic sullo stesso blocco
  assert.equal(g.dash.openModal.calls.length, 1, 'nessuna riapertura al secondo clic');
  panel.onShowDate(THU);
  await ready(g);
  g.state.onMovePost = (body) => { g.state.appts[41] = { ...maria(), start: body.start }; };
  g.dg().props.onSlotMenu(1, 10 * 60, 300, 300, { ok: true, code: 'ok', label: 'Disponibile' }, { ghostHit: true });
  g.render();
  g.button('Sposta qui').props.onClick();
  await ready(g);
  assert.ok(g.calls.post.some((p) => p.url === '/api/agenda/appointments/41/move'));
  assert.equal(g.dash.openModal.calls.length, 1, 'il pannello resta quello aperto');
  assert.equal(g.dg().props.ghost ?? null, null, 'la copia fresca è già su giovedì: niente più ombra');
});

test('«Prenotazione di gruppo» dal menu di «Prenota» apre il drawer dell\'agenda', async () => {
  const g = setup();
  await ready(g);
  assert.equal(find(g.m.tree, (el) => el.type?.name === 'GroupBookingDrawer'), null);
  g.dash.deepLink = 'group-booking';                 // quello che fa la barra in alto
  g.render();
  g.render();
  assert.ok(find(g.m.tree, (el) => el.type?.name === 'GroupBookingDrawer'), 'il drawer si apre');
  assert.deepEqual(g.dash.setDeepLink.calls.at(-1), [null], 'il collegamento si consuma');
});

test('«Solo chi lavora oggi» toglie la colonna di chi è a riposo, non i suoi dati', async () => {
  // Bea (id 4) oggi non ha turno né appuntamenti
  const rows = rowsFor([sara]).map((r) => (r.operator.id === 4 ? { ...r, windows: [] } : r));
  const g = setup({ rows });
  await ready(g);
  assert.deepEqual(g.dg().props.rows.map((r) => r.operator.id), [1, 2, 3], 'la sua colonna non c\'è');
  assert.deepEqual(g.dg().props.allRows.map((r) => r.operator.id), [1, 2, 3, 4], 'i conti la vedono ancora');
});

test('i tasti T, ← e → e G S M muovono l\'agenda; con un pannello aperto tacciono', async () => {
  const g = setup();
  await ready(g);
  // un giorno nuovo passa dallo scheletro: si aspetta che la giornata arrivi
  const key = async (k, target = { tagName: 'BODY' }) => { g.win.fire('keydown', { key: k, target, preventDefault() {} }); g.render(); await ready(g); };
  await key('ArrowRight');
  assert.equal(g.dg().props.date, plus(1), '→ il giorno dopo');
  await key('ArrowLeft');
  await key('ArrowLeft');
  assert.equal(g.dg().props.date, plus(-1), '← il giorno prima');
  await key('t');
  assert.equal(g.dg().props.date, TODAY, 'T torna a oggi');
  await key('ArrowRight', { tagName: 'INPUT' });
  assert.equal(g.dg().props.date, TODAY, 'chi scrive in un campo tiene le sue frecce');
  await key('s');
  assert.ok(g.wv(), 'S apre la settimana');
  await key('g');
  assert.ok(g.dg(), 'G torna al giorno');
  g.dash.modal = { id: 9, name: 'apptdetail', props: {} };
  g.render();
  await key('ArrowRight');
  assert.equal(g.dg().props.date, TODAY, 'con il dettaglio aperto ← → non sfogliano l\'agenda dietro');
});

test('gesto riuscito e ricarico della giornata fallito: resta l\'avviso del gesto, nessun errore', async () => {
  const g = setup();
  await ready(g);
  // una visita di oggi con due servizi (per lo stacco) e la pausa pranzo di Anna
  const visita = { ...maria(), start: isoAtMin(TODAY, 10 * 60) };
  const pausa = { id: 5, operator_id: 1, start: isoAtMin(TODAY, 13 * 60), duration_min: 60, note: '' };
  const dg = () => g.dg().props;
  const menuButton = (text) => find(find(g.m.tree, (el) => el.type?.name === 'SlotMenu'), (el) => el.type === 'button' && textOf(el) === text);
  // [gesto, come si fa, avviso del gesto riuscito (null: non ne ha), con «Annulla»]
  const gesti = [
    ['stacco', () => dg().onSplitItem(visita, visita.items[1], 12 * 60, 2), 'Piega staccato alle 12:00', true],
    ['pausa spostata', () => dg().onMovePause(pausa, 14 * 60, 1), 'Pausa spostata alle 14:00', true],
    ['pausa allungata', () => dg().onResizePause(pausa, 90), null, false],
    ['pausa rimossa', () => dg().onDeletePause(pausa), 'Pausa rimossa', true],
    ['durata', () => dg().onResizeItem(sara, sara.items[0], 45), 'Durata aggiornata', false],
    ['pausa aggiunta', () => {
      dg().onSlotMenu(1, 12 * 60, 300, 300, { ok: true, code: 'ok', label: 'Disponibile' });
      g.render();
      menuButton('Aggiungi pausa').props.onClick();
      g.render();
      return menuButton('Aggiungi').props.onClick();
    }, 'Pausa aggiunta · Anna alle 12:00', false],
  ];
  const reads = (url) => g.calls.get.filter((x) => x.url === url).length;
  // da qui la giornata non si rilegge: la rete cade subito dopo la scrittura
  g.state.dayError = new TypeError('Failed to fetch');
  for (const [nome, gesto, msg, annulla] of gesti) {
    const from = g.dash.fireToast.calls.length;
    const days = reads('/api/agenda/day'), undos = reads('/api/agenda/undo');
    await gesto();
    await flush();
    g.render();
    const avvisi = g.dash.fireToast.calls.slice(from).map(([x]) => x);
    assert.ok(reads('/api/agenda/day') > days, `${nome}: la giornata si ricarica (e non risponde)`);
    assert.deepEqual(avvisi.filter((x) => x.icon === 'alert').map((x) => x.msg), [], `${nome}: nessun errore, il gesto è riuscito`);
    assert.deepEqual(avvisi.map((x) => x.msg), msg ? [msg] : [], `${nome}: resta l'avviso del gesto`);
    if (annulla) {
      assert.equal(avvisi[0].undo, 'Annulla', `${nome}: l'avviso ha il suo «Annulla»`);
      assert.equal(typeof avvisi[0].undoFn, 'function');
    }
    assert.ok(reads('/api/agenda/undo') > undos, `${nome}: la pila di «torna indietro» si rilegge lo stesso`);
  }
  // ogni scrittura è partita una volta sola: niente secondi tentativi
  assert.deepEqual(g.calls.post.map((p) => p.url), ['/api/agenda/appointments/41/split', '/api/agenda/pauses']);
  assert.deepEqual(g.calls.put.map((p) => p.url), ['/api/agenda/pauses/5', '/api/agenda/pauses/5', '/api/agenda/appointments/42']);
  assert.deepEqual(g.calls.del.map((p) => p.url), ['/api/agenda/pauses/5']);
});

test('il filtro «Team» vale anche in settimana, senza l\'interruttore dei turni', async () => {
  const g = setup();
  await ready(g);
  const team = () => find(g.m.tree, (el) => el.type?.name === 'TeamFilter');
  team().props.toggleVis(1);                         // Anna spenta dalla vista giorno
  g.render();
  assert.deepEqual(g.dg().props.rows.map((r) => r.operator.id), [2, 3, 4]);
  g.button('Settimana').props.onClick();
  g.render();
  assert.deepEqual(g.wv().props.hiddenOps, [1], 'la settimana riceve le spente');
  assert.equal(team().props.setOnlyWorking, undefined, '«Solo chi lavora oggi» è del giorno');
  assert.equal(team().props.shown, 3);
});

test('le colonne spente restano sulla postazione, e «Solo» lascia una colonna sola', async () => {
  const storage = {};
  const g = setup({ storage });
  await ready(g);
  const team = () => find(g.m.tree, (el) => el.type?.name === 'TeamFilter');
  team().props.toggleVis(2);                         // Giulia spenta
  g.render();
  assert.deepEqual(g.dg().props.rows.map((r) => r.operator.id), [1, 3, 4]);
  assert.equal(storage['dk-agenda-hidden-ops'], '[2]', 'si salvano solo le spente');
  g.m.unmount();
  const again = setup({ storage });                  // la pagina ricaricata
  await ready(again);
  assert.deepEqual(again.dg().props.rows.map((r) => r.operator.id), [1, 3, 4], 'Giulia resta spenta');
  find(again.m.tree, (el) => el.type?.name === 'TeamFilter').props.only(3);
  again.render();
  assert.deepEqual(again.dg().props.rows.map((r) => r.operator.id), [3]);
});

test('un id spento di un\'operatrice che non è più in elenco non nasconde la sua riga orfana', async () => {
  // Bea (4) è stata disattivata: non è più fra le operatrici, ma il server
  // manda ancora la sua riga perché i suoi appuntamenti restino riassegnabili
  const storage = { 'dk-agenda-hidden-ops': '[4]' };
  const g = setup({ storage });
  g.dash.operators = OPS.filter((o) => o.id !== 4);
  g.render();
  await ready(g);
  assert.deepEqual(g.dg().props.rows.map((r) => r.operator.id), [1, 2, 3, 4]);
});

test('i tasti di navigazione tacciono a metà trascinamento', async () => {
  const g = setup();
  await ready(g);
  document.body.classList.add('dk-dragging');
  g.win.fire('keydown', { key: 'ArrowRight', target: { tagName: 'BODY' }, preventDefault() {} });
  g.render();
  assert.equal(g.dg().props.date, TODAY, 'il blocco in mano non cade in un altro giorno');
  document.body.classList.remove('dk-dragging');
});

test('cambiando giorno da tastiera si chiudono il menu dello slot e la scheda di anteprima', async () => {
  const g = setup();
  await ready(g);
  g.dg().props.onSlotMenu(1, 11 * 60, 300, 300, { ok: true, code: 'ok', label: 'Disponibile' });
  g.dg().props.onHover(sara, { getBoundingClientRect: () => ({ left: 100, right: 260, top: 200, bottom: 240, width: 160, height: 40 }) });
  g.render();
  assert.ok(find(g.m.tree, (el) => el.type?.name === 'SlotMenu'), 'il menu è aperto');
  assert.ok(find(g.m.tree, (el) => el.type?.name === 'ApptHoverCard'), 'la scheda è aperta');
  g.win.fire('keydown', { key: 'ArrowRight', target: { tagName: 'BODY' }, preventDefault() {} });
  g.render();
  await ready(g);
  assert.equal(g.dg().props.date, plus(1));
  assert.equal(find(g.m.tree, (el) => el.type?.name === 'SlotMenu'), null, 'il menu del giorno prima si chiude');
  assert.equal(find(g.m.tree, (el) => el.type?.name === 'ApptHoverCard'), null, 'la scheda del giorno prima sparisce');
});

test('«Solo chi lavora oggi» non nasconde niente quando nessuno ha turni quel giorno', async () => {
  const rows = rowsFor([sara]).map((r) => ({ ...r, windows: [] }));   // un salone che i turni non li usa
  const g = setup({ rows });
  await ready(g);
  assert.deepEqual(g.dg().props.rows.map((r) => r.operator.id), [1, 2, 3, 4]);
});
