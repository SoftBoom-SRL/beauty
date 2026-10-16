// Servizi archiviati (16/10). Un servizio che il salone non fa più si
// archivia, non solo si mette in pausa: esce dalla lista (la pausa lo lasciava
// in mezzo agli attivi, e dopo qualche stagione la lista era piena di spenti)
// e si ritrova col filtro «Archiviati», da dove si ripristina. Archiviare si
// annulla dal messaggio, e il servizio torna com'era: attivo o in pausa.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { find, findAll, installDom, loadComponent, mount, spy, textOf, tick } from './grid-harness.mjs';

const { default: ServiziSub } = await loadComponent('apps/dashboard/src/sections/servizi/ServiziSub.jsx');
const { default: SvcEditModal } = await loadComponent('apps/dashboard/src/sections/servizi/SvcEditModal.jsx');
const { default: ServiziSection } = await loadComponent('apps/dashboard/src/sections/servizi/index.jsx', {
  stubs: ['SubTabs.jsx', 'PacchettiSub.jsx', 'SvcEditModal.jsx', 'PkgEditModal.jsx'],
});

const t = (it) => it;
const CATS = [{ id: 1, name_it: 'Capelli', color: '#FDE2E4', order: 0 }];
const svc = (id, name, extra = {}) => ({
  id, name_it: name, name_en: '', category_id: 1, duration_min: 30, soak_min: 0, price: '30.00',
  product_cost: '0', supplier_cost: '0', active: true, order: id, archived_at: null, ...extra,
});
const SERVICES = [
  svc(1, 'Taglio'),
  svc(2, 'Piega', { active: false }),
  svc(3, 'Permanente', { active: false, archived_at: '2026-10-16T10:00:00Z' }),
];

function list(props = {}) {
  installDom();
  const p = {
    services: SERVICES, loading: false, categories: CATS, operators: [], canEdit: true,
    onCats: spy(), onEdit: spy(), onNew: spy(), onToggleActive: spy(), onArchive: spy(), onRestore: spy(), t, lang: 'it', ...props,
  };
  return { m: mount(ServiziSub, p), p };
}
const rows = (m) => findAll(m.tree, (el) => el.props?.['data-svc'] != null).map((el) => el.props['data-svc']);
// il filtro sta nella barra di ricerca, fra i suoi `extra`
const statusGroup = (m) => find(find(m.tree, (el) => el.props?.extra).props.extra, (el) => Array.isArray(el.props?.groups)).props.groups.find((g) => g.label === 'Stato');

test('la lista non mostra gli archiviati, e li conta a parte', () => {
  const { m } = list();
  assert.deepEqual(rows(m), [1, 2]);
  const counts = textOf(find(m.tree, (el) => el.type === 'div' && textOf(el).includes('attivi') && textOf(el).includes('servizi')));
  assert.match(counts, /2 servizi/);
  assert.match(counts, /1 attivi/);
  assert.match(counts, /1 in pausa/);
  assert.match(counts, /1 archiviato/);
  // neanche «In pausa» li mescola ai servizi in pausa
  statusGroup(m).set('paused');
  m.render();
  assert.deepEqual(rows(m), [2]);
});

test('«Archiviati» (dal filtro o dal conteggio) mostra solo loro, con «Ripristina»', () => {
  const { m, p } = list();
  assert.ok(statusGroup(m).opts.some(([k, label]) => k === 'archived' && label === 'Archiviati (1)'));
  find(m.tree, (el) => el.props?.['data-show-archived']).props.onClick();
  m.render();
  assert.deepEqual(rows(m), [3]);
  assert.ok(find(m.tree, (el) => el.props?.['data-archived-note']), 'dice che cosa sono');
  // niente interruttore né «Archivia» su un archiviato: si ripristina
  const row = find(m.tree, (el) => el.props?.['data-svc'] === 3);
  assert.equal(find(row, (el) => el.props?.['data-archive']), null);
  assert.equal(find(row, (el) => typeof el.type === 'function' && el.type.name === 'Toggle'), null);
  find(row, (el) => el.props?.['data-restore']).props.onClick();
  assert.deepEqual(p.onRestore.calls.map((c) => c[0].id), [3]);
  // «Torna alla lista»
  find(m.tree, (el) => el.type === 'button' && textOf(el) === 'Torna alla lista').props.onClick();
  m.render();
  assert.deepEqual(rows(m), [1, 2]);
});

test('ogni servizio in lista si archivia dalla sua riga, senza aprirlo', () => {
  const { m, p } = list();
  const row = find(m.tree, (el) => el.props?.['data-svc'] === 1);
  let stopped = false;
  find(row, (el) => el.props?.['data-archive']).props.onClick({ stopPropagation: () => { stopped = true; } });
  assert.deepEqual(p.onArchive.calls.map((c) => c[0].id), [1]);
  assert.ok(stopped, 'il clic non apre anche la scheda');
  assert.equal(p.onEdit.calls.length, 0);
  // senza il permesso del listino, niente pulsanti
  const ro = list({ canEdit: false }).m;
  assert.equal(find(ro, (el) => el.props?.['data-archive']), null);
});

test('ripristinato l\'ultimo archiviato si torna alla lista, dove lui ora è in pausa', () => {
  const { m, p } = list();
  find(m.tree, (el) => el.props?.['data-show-archived']).props.onClick();
  m.render();
  assert.match(textOf(find(m.tree, (el) => el.props?.['data-archived-note'])), /^1 archiviato/);
  const restored = SERVICES.map((s) => (s.id === 3 ? { ...s, archived_at: null } : s));
  m.render({ ...p, services: restored });
  m.render();
  assert.deepEqual(rows(m), [1, 2, 3]);
  assert.equal(find(m.tree, (el) => el.props?.['data-archived-note']), null);
});

/* ---- scheda del servizio --------------------------------------------------- */

function card(service, props = {}) {
  installDom();
  const p = { service, categories: CATS, operators: [], canTeam: false, canPricing: true, onSave: spy(), onArchive: spy(), onRestore: spy(), onClose: spy(), onCatColor: spy(), t, lang: 'it', ...props };
  return { m: mount(SvcEditModal, p), p };
}
const foot = (m) => find(m.tree, (el) => el.props?.foot).props.foot;

test('scheda: «Archivia» in fondo per un servizio in lista, non per uno nuovo', () => {
  const { m, p } = card(SERVICES[0]);
  find(foot(m), (el) => el.props?.['data-archive']).props.onClick();
  assert.equal(p.onArchive.calls.length, 1);
  assert.equal(find(m.tree, (el) => el.props?.['data-archived-banner']), null);
  const nuovo = card(null).m;
  assert.equal(find(foot(nuovo), (el) => el.props?.['data-archive']), null);
});

test('scheda di un archiviato: lo dice in cima, si ripristina, e riattivarlo lo toglie dall\'archivio', () => {
  const { m, p } = card(SERVICES[2]);
  assert.equal(find(foot(m), (el) => el.props?.['data-archive']), null);
  const banner = find(m.tree, (el) => el.props?.['data-archived-banner']);
  assert.match(textOf(banner), /Servizio archiviato/);
  find(banner, (el) => el.props?.['data-restore']).props.onClick();
  assert.equal(p.onRestore.calls.length, 1);
  const row = () => find(m.tree, (el) => typeof el.type === 'function' && el.type.name === 'FRow' && el.props.label === 'Servizio attivo');
  assert.equal(row().props.hint, 'Archiviato, non prenotabile');
  find(row(), (el) => typeof el.type === 'function' && 'on' in el.props).props.onChange(true);
  m.render();
  assert.equal(row().props.hint, 'Prenotabile: salvando esce dall’archivio');
});

/* ---- la sezione: chiamate e «Annulla» -------------------------------------- */

function section(services) {
  installDom();
  const calls = [];
  globalThis.__api = {
    get: (url) => { calls.push(['GET', url]); return Promise.resolve(url === '/api/catalog/services' ? services : []); },
    post: (url, body) => {
      calls.push(['POST', url, body]);
      const id = Number(url.split('/')[4]);
      const s = services.find((x) => x.id === id);
      return Promise.resolve(url.endsWith('/archive') ? { ...s, active: false, archived_at: '2026-10-16T12:00:00Z' } : { ...s, archived_at: null });
    },
    put: (url, body) => { calls.push(['PUT', url, body]); return Promise.resolve({ id: Number(url.split('/').pop()), ...body, archived_at: null }); },
    patch: () => Promise.resolve({}), del: (url) => { calls.push(['DEL', url]); return Promise.resolve({}); },
  };
  const toasts = [];
  globalThis.__dash = {
    t, lang: 'it', subTab: 'servizi', setSubTab: spy(), serviceCategories: CATS, operators: [],
    reload: { services: spy(() => Promise.resolve()) }, fireToast: (x) => toasts.push(x), hasScope: () => true, openModal: spy(),
  };
  const m = mount(ServiziSection, {});
  return { m, calls, toasts };
}
const sub = (m) => find(m.tree, (el) => typeof el.type === 'function' && el.type.name === 'ServiziSub');

test('archiviare un servizio attivo: «Annulla» lo riporta attivo', async () => {
  const { m, calls, toasts } = section([svc(1, 'Taglio')]);
  await tick(); m.render();
  await sub(m).props.onArchive(svc(1, 'Taglio'));
  m.render();
  assert.deepEqual(calls.filter((c) => c[0] === 'POST').map((c) => c[1]), ['/api/catalog/services/1/archive']);
  assert.ok(sub(m).props.services[0].archived_at, 'la lista lo vede archiviato subito');
  const toast = toasts.at(-1);
  assert.equal(toast.msg, '«Taglio» archiviato: lo trovi col filtro Archiviati');
  assert.equal(toast.undo, 'Annulla');
  await toast.undoFn();
  const put = calls.find((c) => c[0] === 'PUT');
  assert.equal(put[1], '/api/catalog/services/1');
  assert.equal(put[2].active, true);
  // la riattivazione non porta il colore: resta quello di prima
  assert.equal('color' in put[2], false);
});

test('archiviare uno in pausa: «Annulla» lo ripristina e resta in pausa; «Ripristina» dice che è in pausa', async () => {
  const paused = svc(2, 'Piega', { active: false });
  const { m, calls, toasts } = section([paused]);
  await tick(); m.render();
  await sub(m).props.onArchive(paused);
  await toasts.at(-1).undoFn();
  assert.deepEqual(calls.filter((c) => c[0] === 'POST').map((c) => c[1]), ['/api/catalog/services/2/archive', '/api/catalog/services/2/restore']);
  assert.equal(calls.some((c) => c[0] === 'PUT'), false);
  await sub(m).props.onRestore({ ...paused, archived_at: '2026-10-16T12:00:00Z' });
  assert.equal(calls.filter((c) => c[0] === 'POST').at(-1)[1], '/api/catalog/services/2/restore');
  assert.equal(toasts.at(-1).msg, '«Piega» è di nuovo in lista, in pausa: attivalo quando vuoi');
});
