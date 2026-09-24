// Il livello API della dashboard (src/api/): ogni funzione fa UNA chiamata,
// con il metodo, il percorso, i parametri e il corpo che le sezioni scrivevano
// a mano nei componenti prima del refactoring del 24/09 — la tabella qui sotto
// li riporta uno per uno. È il contratto con il server: un percorso o un corpo
// cambiato qui senza cambiare il backend rompe la dashboard, e deve rompere
// anche questo test.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activityApi, depositRulesApi, locationsApi, outboxApi, salonApi, settingsApi } from '../src/api/core.js';
import { absencesApi, staffApi } from '../src/api/staff.js';
import { packagesApi, serviceCategoriesApi, servicesApi } from '../src/api/catalog.js';
import { clientCategoriesApi, clientNotesApi, clientsApi, techSheetsApi } from '../src/api/clients.js';
import { movementsApi, ordersApi, productCategoriesApi, productsApi, suppliersApi } from '../src/api/inventory.js';
import { salesApi, stripeConnectApi } from '../src/api/sales.js';
import { communicationsApi, couponsApi, giftCardsApi, loyaltyApi } from '../src/api/marketing.js';
import { automationsApi } from '../src/api/automations.js';
import { insightsApi } from '../src/api/insights.js';
import { invitationsApi, membersApi, rolesApi, staffAccountApi } from '../src/api/team.js';
import { yourangApi } from '../src/api/integrations.js';

/* Registratore al posto di `api` (test/shared-shim.mjs passa ogni chiamata a
 * globalThis.__api): la chiamata diventa { method, path, params?, body?, form? }
 * — `form` per i multipart di api.postForm — e riceve `reply(call)`, che la
 * funzione deve restituire così com'è (niente .then nei moduli di api/).
 * Opzioni diverse da `params` (signal, auth, headers) non ne passa nessuno. */
const calls = [];
let reply = () => REPLY;
const REPLY = Object.freeze({ risposta: true });

function rec(method, path, payload, opts) {
  const { params, ...rest } = opts || {};
  assert.deepEqual(Object.keys(rest), [], `${method} ${path}: opzioni inattese`);
  const call = { method, path };
  if (params !== undefined) call.params = params;
  if (payload?.body !== undefined) call.body = payload.body;
  if (payload && 'form' in payload) call.form = payload.form;
  calls.push(call);
  return reply(call);
}
globalThis.__api = {
  get: (path, opts) => rec('GET', path, null, opts),
  post: (path, body, opts) => rec('POST', path, { body }, opts),
  put: (path, body, opts) => rec('PUT', path, { body }, opts),
  patch: (path, body, opts) => rec('PATCH', path, { body }, opts),
  del: (path, opts) => rec('DELETE', path, null, opts),
  postForm: (path, form, opts) => rec('POST', path, { form }, opts),
};

const B = { corpo: 1 };             // un corpo qualunque: deve arrivare com'è
const P = { q: 'rossi', limit: 8 }; // parametri qualunque: idem
const FILE = { file: 'logo.png' };  // al posto di un File
const FORM = { qty: 3, invoice: FILE };

/* [chiamata, atteso] — atteso è [metodo, percorso, { params, body, form }] */
const CASES = [
  // core
  [() => salonApi.get(), ['GET', '/api/core/salon']],
  [() => settingsApi.update(B), ['PUT', '/api/core/settings', { body: B }]],
  [() => settingsApi.uploadLogo(FILE), ['POST', '/api/core/settings/logo', { form: { logo: FILE } }]],
  [() => locationsApi.list(), ['GET', '/api/core/locations']],
  [() => locationsApi.create(B), ['POST', '/api/core/locations', { body: B }]],
  [() => locationsApi.update(4, B), ['PUT', '/api/core/locations/4', { body: B }]],
  [() => locationsApi.remove(4), ['DELETE', '/api/core/locations/4']],
  [() => depositRulesApi.list(), ['GET', '/api/core/deposit-rules']],
  [() => depositRulesApi.create(B), ['POST', '/api/core/deposit-rules', { body: B }]],
  [() => depositRulesApi.update(5, B), ['PUT', '/api/core/deposit-rules/5', { body: B }]],
  [() => depositRulesApi.remove(5), ['DELETE', '/api/core/deposit-rules/5']],
  [() => activityApi.list(P), ['GET', '/api/core/activity', { params: P }]],
  [() => activityApi.feed({ after: 12 }), ['GET', '/api/core/activity/feed', { params: { after: 12 } }]],
  [() => activityApi.feed({}), ['GET', '/api/core/activity/feed', { params: {} }]],
  [() => activityApi.streamTicket(), ['POST', '/api/core/activity/stream-ticket']],
  [() => outboxApi.status(), ['GET', '/api/core/outbox/status']],
  // staff
  [() => staffApi.list(), ['GET', '/api/staff/']],
  [() => staffApi.list({ include_inactive: true }), ['GET', '/api/staff/', { params: { include_inactive: true } }]],
  [() => staffApi.create(B), ['POST', '/api/staff/', { body: B }]],
  [() => staffApi.get(7), ['GET', '/api/staff/7']],
  [() => staffApi.update(7, B), ['PUT', '/api/staff/7', { body: B }]],
  [() => staffApi.setColor(7, '#C9B8F2'), ['PATCH', '/api/staff/7/color', { body: { color: '#C9B8F2' } }]],
  [() => staffApi.updateShifts(7, { shifts: [] }), ['PUT', '/api/staff/7/shifts', { body: { shifts: [] } }]],
  [() => staffApi.performance(7, { months: 6 }), ['GET', '/api/staff/7/performance', { params: { months: 6 } }]],
  [() => staffApi.clients(7, { q: undefined }), ['GET', '/api/staff/7/clients', { params: { q: undefined } }]],
  [() => absencesApi.list(7), ['GET', '/api/staff/7/absences']],
  [() => absencesApi.create(7, B), ['POST', '/api/staff/7/absences', { body: B }]],
  [() => absencesApi.update(7, 9, B), ['PUT', '/api/staff/7/absences/9', { body: B }]],
  [() => absencesApi.remove(7, 9), ['DELETE', '/api/staff/7/absences/9']],
  // listino
  [() => servicesApi.list(), ['GET', '/api/catalog/services']],
  [() => servicesApi.create(B), ['POST', '/api/catalog/services', { body: B }]],
  [() => servicesApi.update(3, B), ['PUT', '/api/catalog/services/3', { body: B }]],
  [() => servicesApi.remove(3), ['DELETE', '/api/catalog/services/3']],
  [() => packagesApi.list(), ['GET', '/api/catalog/packages']],
  [() => packagesApi.create(B), ['POST', '/api/catalog/packages', { body: B }]],
  [() => packagesApi.update(2, B), ['PUT', '/api/catalog/packages/2', { body: B }]],
  [() => packagesApi.remove(2), ['DELETE', '/api/catalog/packages/2']],
  [() => serviceCategoriesApi.list(), ['GET', '/api/catalog/categories']],
  [() => serviceCategoriesApi.create(B), ['POST', '/api/catalog/categories', { body: B }]],
  [() => serviceCategoriesApi.update(6, B), ['PUT', '/api/catalog/categories/6', { body: B }]],
  [() => serviceCategoriesApi.remove(6), ['DELETE', '/api/catalog/categories/6']],
  [() => serviceCategoriesApi.reorder([3, 1, 2]), ['POST', '/api/catalog/categories/reorder', { body: { ids: [3, 1, 2] } }]],
  // clienti
  [() => clientsApi.list(P), ['GET', '/api/clients/', { params: P }]],
  [() => clientsApi.get(11), ['GET', '/api/clients/11']],
  [() => clientsApi.create(B), ['POST', '/api/clients/', { body: B }]],
  [() => clientsApi.update(11, B), ['PUT', '/api/clients/11', { body: B }]],
  [() => clientsApi.reactivate(11), ['PUT', '/api/clients/11', { body: { is_active: true } }]],
  [() => clientsApi.remove(11), ['DELETE', '/api/clients/11']],
  [() => clientsApi.importRows(B), ['POST', '/api/clients/import', { body: B }]],
  [() => clientsApi.history(11), ['GET', '/api/clients/11/history']],
  [() => clientCategoriesApi.list(), ['GET', '/api/clients/categories']],
  [() => clientCategoriesApi.create(B), ['POST', '/api/clients/categories', { body: B }]],
  [() => clientCategoriesApi.update(8, B), ['PUT', '/api/clients/categories/8', { body: B }]],
  [() => clientCategoriesApi.remove(8), ['DELETE', '/api/clients/categories/8']],
  [() => clientNotesApi.list(11), ['GET', '/api/clients/11/notes']],
  [() => clientNotesApi.create(11, B), ['POST', '/api/clients/11/notes', { body: B }]],
  [() => clientNotesApi.upload(11, FORM), ['POST', '/api/clients/11/notes/upload', { form: FORM }]],
  [() => clientNotesApi.update(11, 21, B), ['PUT', '/api/clients/11/notes/21', { body: B }]],
  [() => clientNotesApi.remove(11, 21), ['DELETE', '/api/clients/11/notes/21']],
  [() => clientNotesApi.addAttachments(11, 21, FORM), ['POST', '/api/clients/11/notes/21/attachments', { form: FORM }]],
  [() => clientNotesApi.removeAttachment(11, 21, 31), ['DELETE', '/api/clients/11/notes/21/attachments/31']],
  [() => techSheetsApi.list(11), ['GET', '/api/clients/11/sheets']],
  [() => techSheetsApi.create(11, B), ['POST', '/api/clients/11/sheets', { body: B }]],
  [() => techSheetsApi.uploadPhoto(11, 41, FILE), ['POST', '/api/clients/11/sheets/41/photo', { form: { photo: FILE } }]],
  // magazzino
  [() => productsApi.list(P), ['GET', '/api/inventory/products', { params: P }]],
  [() => productsApi.get(51), ['GET', '/api/inventory/products/51']],
  [() => productsApi.create(B), ['POST', '/api/inventory/products', { body: B }]],
  [() => productsApi.update(51, B), ['PUT', '/api/inventory/products/51', { body: B }]],
  [() => productsApi.remove(51), ['DELETE', '/api/inventory/products/51']],
  [() => productsApi.movements(51, { limit: 8 }), ['GET', '/api/inventory/products/51/movements', { params: { limit: 8 } }]],
  [() => productsApi.load(51, FORM), ['POST', '/api/inventory/products/51/load', { form: FORM }]],
  [() => productsApi.unload(51, B), ['POST', '/api/inventory/products/51/unload', { body: B }]],
  [() => productsApi.loadCsv(B), ['POST', '/api/inventory/load-csv', { body: B }]],
  [() => productCategoriesApi.list(), ['GET', '/api/inventory/categories']],
  [() => productCategoriesApi.create(B), ['POST', '/api/inventory/categories', { body: B }]],
  [() => productCategoriesApi.update(61, B), ['PUT', '/api/inventory/categories/61', { body: B }]],
  [() => productCategoriesApi.remove(61), ['DELETE', '/api/inventory/categories/61']],
  [() => suppliersApi.list(), ['GET', '/api/inventory/suppliers']],
  [() => suppliersApi.create(B), ['POST', '/api/inventory/suppliers', { body: B }]],
  [() => suppliersApi.update(71, B), ['PUT', '/api/inventory/suppliers/71', { body: B }]],
  [() => suppliersApi.remove(71), ['DELETE', '/api/inventory/suppliers/71']],
  [() => movementsApi.list(P), ['GET', '/api/inventory/movements', { params: P }]],
  [() => ordersApi.list(P), ['GET', '/api/inventory/orders', { params: P }]],
  [() => ordersApi.generate(), ['POST', '/api/inventory/orders/generate']],
  [() => ordersApi.update(81, B), ['PUT', '/api/inventory/orders/81', { body: B }]],
  [() => ordersApi.send(81, { method: 'email' }), ['POST', '/api/inventory/orders/81/send', { body: { method: 'email' } }]],
  [() => ordersApi.receive(81, B), ['POST', '/api/inventory/orders/81/receive', { body: B }]],
  // vendite
  [() => salesApi.list(P), ['GET', '/api/sales/', { params: P }]],
  [() => salesApi.get(91), ['GET', '/api/sales/91']],
  [() => salesApi.pos(B), ['POST', '/api/sales/pos', { body: B }]],
  [() => salesApi.checkout(101, B), ['POST', '/api/sales/checkout/101', { body: B }]],
  [() => stripeConnectApi.status(), ['GET', '/api/sales/stripe/connect/status']],
  [() => stripeConnectApi.start(), ['POST', '/api/sales/stripe/connect/start', { body: {} }]],
  [() => stripeConnectApi.callback({ code: 'c', state: 's' }), ['POST', '/api/sales/stripe/connect/callback', { body: { code: 'c', state: 's' } }]],
  [() => stripeConnectApi.disconnect(), ['DELETE', '/api/sales/stripe/connect']],
  // marketing
  [() => couponsApi.list(P), ['GET', '/api/marketing/coupons', { params: P }]],
  [() => couponsApi.create(B), ['POST', '/api/marketing/coupons', { body: B }]],
  [() => couponsApi.update(111, B), ['PUT', '/api/marketing/coupons/111', { body: B }]],
  [() => couponsApi.remove(111), ['DELETE', '/api/marketing/coupons/111']],
  [() => couponsApi.redeem(111), ['POST', '/api/marketing/coupons/111/redeem', { body: {} }]],
  [() => giftCardsApi.list(P), ['GET', '/api/marketing/gift-cards', { params: P }]],
  [() => giftCardsApi.create(B), ['POST', '/api/marketing/gift-cards', { body: B }]],
  [() => giftCardsApi.markPaid(121, { method: 'cash' }), ['POST', '/api/marketing/gift-cards/121/mark-paid', { body: { method: 'cash' } }]],
  [() => loyaltyApi.list(), ['GET', '/api/marketing/loyalty-programs']],
  [() => loyaltyApi.list({ active: true }), ['GET', '/api/marketing/loyalty-programs', { params: { active: true } }]],
  [() => loyaltyApi.create(B), ['POST', '/api/marketing/loyalty-programs', { body: B }]],
  [() => loyaltyApi.update(131, B), ['PUT', '/api/marketing/loyalty-programs/131', { body: B }]],
  [() => loyaltyApi.remove(131), ['DELETE', '/api/marketing/loyalty-programs/131']],
  [() => loyaltyApi.accounts(131, { limit: 20, offset: 0 }), ['GET', '/api/marketing/loyalty-programs/131/accounts', { params: { limit: 20, offset: 0 } }]],
  [() => loyaltyApi.enroll(131, { client_id: 11 }), ['POST', '/api/marketing/loyalty-programs/131/accounts', { body: { client_id: 11 } }]],
  [() => communicationsApi.list(P), ['GET', '/api/marketing/communications', { params: P }]],
  [() => communicationsApi.create(B), ['POST', '/api/marketing/communications', { body: B }]],
  [() => communicationsApi.update(141, B), ['PUT', '/api/marketing/communications/141', { body: B }]],
  [() => communicationsApi.remove(141), ['DELETE', '/api/marketing/communications/141']],
  [() => communicationsApi.send(141, B), ['POST', '/api/marketing/communications/141/send', { body: B }]],
  // automazioni
  [() => automationsApi.list(), ['GET', '/api/automations/']],
  [() => automationsApi.create(B), ['POST', '/api/automations/', { body: B }]],
  [() => automationsApi.update(151, B), ['PUT', '/api/automations/151', { body: B }]],
  [() => automationsApi.remove(151), ['DELETE', '/api/automations/151']],
  [() => automationsApi.toggle(151), ['POST', '/api/automations/151/toggle']],
  [() => automationsApi.eventsCatalog(), ['GET', '/api/automations/events-catalog']],
  // analisi dati
  [() => insightsApi.kpis({ period: 'month' }), ['GET', '/api/insights/kpis', { params: { period: 'month' } }]],
  [() => insightsApi.revenueSeries(P), ['GET', '/api/insights/revenue-series', { params: P }]],
  [() => insightsApi.revenueByCategory(P), ['GET', '/api/insights/revenue-by-category', { params: P }]],
  [() => insightsApi.occupancyByWeekday(P), ['GET', '/api/insights/occupancy-by-weekday', { params: P }]],
  [() => insightsApi.ask({ question: 'come va?' }), ['POST', '/api/insights/ask', { body: { question: 'come va?' } }]],
  // team e account
  [() => membersApi.list(), ['GET', '/api/auth/members']],
  [() => membersApi.setRole(161, { role_id: 2 }), ['POST', '/api/auth/members/161/role', { body: { role_id: 2 } }]],
  [() => membersApi.remove(161), ['DELETE', '/api/auth/members/161']],
  [() => rolesApi.list(), ['GET', '/api/auth/roles']],
  [() => rolesApi.create(B), ['POST', '/api/auth/roles', { body: B }]],
  [() => rolesApi.update(171, B), ['PUT', '/api/auth/roles/171', { body: B }]],
  [() => rolesApi.remove(171), ['DELETE', '/api/auth/roles/171']],
  [() => invitationsApi.list(), ['GET', '/api/auth/invitations']],
  [() => invitationsApi.create(B), ['POST', '/api/auth/invitations', { body: B }]],
  [() => staffAccountApi.changePassword(B), ['POST', '/api/auth/staff/password', { body: B }]],
  // integrazioni
  [() => yourangApi.status(), ['GET', '/api/integrations/yourang/status']],
  [() => yourangApi.oauthStart(), ['GET', '/api/integrations/yourang/oauth/start']],
  [() => yourangApi.loginStart(), ['GET', '/api/integrations/yourang/oauth/login/start']],
  [() => yourangApi.exchange({ code: 'c', state: 's', nonce: 'n' }), ['POST', '/api/integrations/yourang/oauth/exchange', { body: { code: 'c', state: 's', nonce: 'n' } }]],
];

const expected = ([method, path, rest = {}]) => ({ method, path, ...rest });

test('ogni funzione di api/ fa una chiamata con metodo, percorso, parametri e corpo attesi', () => {
  for (const [fn, want] of CASES) {
    calls.length = 0;
    reply = () => REPLY;
    const out = fn();
    assert.deepEqual(calls, [expected(want)], `${want[0]} ${want[1]}`);
    assert.equal(out, REPLY, `${want[0]} ${want[1]}: restituisce la risposta di api così com'è`);
  }
});

test('il corpo e i parametri arrivano com\'erano, senza copie né campi aggiunti', () => {
  calls.length = 0;
  const body = { rows: [{ name: 'A' }], update_existing: false };
  clientsApi.importRows(body);
  assert.equal(calls[0].body, body);
  const params = { q: null, is_active: true, limit: 20 };
  clientsApi.list(params);
  assert.equal(calls[1].params, params);
});

test('la tabella copre ogni funzione esportata dai moduli di api/', () => {
  const all = {
    salonApi, settingsApi, locationsApi, depositRulesApi, activityApi, outboxApi,
    staffApi, absencesApi, servicesApi, packagesApi, serviceCategoriesApi,
    clientsApi, clientCategoriesApi, clientNotesApi, techSheetsApi,
    productsApi, productCategoriesApi, suppliersApi, movementsApi, ordersApi,
    salesApi, stripeConnectApi, couponsApi, giftCardsApi, loyaltyApi, communicationsApi,
    automationsApi, insightsApi, membersApi, rolesApi, invitationsApi, staffAccountApi, yourangApi,
  };
  // le funzioni che la tabella non può provare con una chiamata sola
  const apart = new Set(['activityApi.streamUrl', 'productsApi.listAll']);
  const src = CASES.map(([fn]) => String(fn));
  const missing = Object.entries(all).flatMap(([obj, fns]) => Object.keys(fns)
    .map((k) => `${obj}.${k}`)
    .filter((name) => !apart.has(name) && !src.some((s) => s.includes(name + '('))));
  assert.deepEqual(missing, []);
});

test('lo stream del feed live: URL con il ticket codificato e il cursore', () => {
  assert.equal(activityApi.streamUrl('a b/c', 0), 'http://localhost:8000/api/core/activity/stream?ticket=a%20b%2Fc&after=0');
  assert.equal(activityApi.streamUrl('t1', 42), 'http://localhost:8000/api/core/activity/stream?ticket=t1&after=42');
});

test('listAll: tutto il catalogo a pagine da 500 fino a count, anche i disattivati', async () => {
  calls.length = 0;
  const page = (n, from) => Array.from({ length: n }, (_, i) => ({ id: from + i }));
  reply = (c) => Promise.resolve(c.params.offset === 0 ? { items: page(500, 0), count: 700 } : { items: page(200, 500), count: 700 });
  const res = await productsApi.listAll();
  assert.deepEqual(calls, [
    { method: 'GET', path: '/api/inventory/products', params: { limit: 500, offset: 0, include_inactive: true } },
    { method: 'GET', path: '/api/inventory/products', params: { limit: 500, offset: 500, include_inactive: true } },
  ]);
  assert.equal(res.items.length, 700);
  assert.equal(res.partial, false);
});

test('listAll: una pagina vuota ferma il giro; oltre 20 pagine lo snapshot è parziale', async () => {
  calls.length = 0;
  reply = () => Promise.resolve({ items: [], count: 900 });
  assert.deepEqual(await productsApi.listAll(), { items: [], partial: false });
  assert.equal(calls.length, 1);

  calls.length = 0;
  reply = (c) => Promise.resolve({ items: Array.from({ length: 500 }, (_, i) => ({ id: c.params.offset + i })), count: 20000 });
  const res = await productsApi.listAll();
  assert.equal(calls.length, 20);
  assert.equal(calls[19].params.offset, 9500);
  assert.equal(res.items.length, 10000);
  assert.equal(res.partial, true);
});
