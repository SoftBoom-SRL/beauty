// Gli endpoint dell'app cliente (src/api/client.js): per ogni funzione il
// metodo, il percorso, il corpo e le opzioni che arrivano ad `api` di
// @youty/shared, con le chiavi nell'ordine della query string. Sono il
// contratto HTTP dell'app: un percorso o un `auth: false` persi per strada si
// vedrebbero solo nel browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModule } from './load.mjs';

const SHARED = `
const call = (m) => (...args) => globalThis.__apiCall(m, ...args);
export const api = { get: call('get'), post: call('post'), put: call('put'), patch: call('patch'), del: call('del') };
`;

const calls = [];
globalThis.__apiCall = (...args) => { calls.push(args); return Promise.resolve({ ok: true }); };
const C = await loadModule('src/api/client.js', { shared: SHARED });

const items = [{ service_id: 3, operator_id: null }];
const CASES = [
  // pubblici: il salone come slug, senza sessione
  [() => C.getBranding('the-parlour'), ['get', '/api/core/public/branding', { params: { salon: 'the-parlour' }, auth: false }]],
  [() => C.getPublicServices('the-parlour'), ['get', '/api/catalog/public/services', { params: { salon: 'the-parlour' }, auth: false }]],
  [() => C.getPublicPackages('the-parlour'), ['get', '/api/catalog/public/packages', { params: { salon: 'the-parlour' }, auth: false }]],
  [() => C.getPublicOperators('the-parlour'), ['get', '/api/staff/public/operators', { params: { salon: 'the-parlour' }, auth: false }]],
  [() => C.getPublicAvailability({ salon: 'the-parlour', date: '2026-09-24', items }),
    ['get', '/api/agenda/public/availability', { params: { salon: 'the-parlour', date: '2026-09-24', items }, auth: false }]],
  [() => C.sendHook({ salon_slug: 'the-parlour', first_name: 'Sofia' }),
    ['post', '/api/clients/public/hook', { salon_slug: 'the-parlour', first_name: 'Sofia' }, { auth: false }]],
  // della cliente: con la sessione (nessuna opzione)
  [() => C.getAvailability({ date: '2026-09-24', items }), ['get', '/api/agenda/client/availability', { params: { date: '2026-09-24', items } }]],
  [() => C.getAvailability({ date: '2026-09-24', items, exclude_appointment_id: 12 }),
    ['get', '/api/agenda/client/availability', { params: { date: '2026-09-24', items, exclude_appointment_id: 12 } }]],
  [() => C.getAppointments(), ['get', '/api/agenda/client/appointments']],
  [() => C.createAppointment({ items, start: '2026-09-24T08:00:00Z' }),
    ['post', '/api/agenda/client/appointments', { items, start: '2026-09-24T08:00:00Z' }]],
  [() => C.moveAppointment(12, '2026-09-25T08:00:00Z'), ['post', '/api/agenda/client/appointments/12/move', { start: '2026-09-25T08:00:00Z' }]],
  // l'annullamento parte senza corpo
  [() => C.cancelAppointment(12), ['post', '/api/agenda/client/appointments/12/cancel']],
  [() => C.createDepositLink(12), ['post', '/api/sales/client/appointments/12/deposit-link', {}]],
  [() => C.getWaitlist(), ['get', '/api/agenda/client/waitlist']],
  [() => C.joinWaitlist({ service_id: 3, preference: 'any' }), ['post', '/api/agenda/client/waitlist', { service_id: 3, preference: 'any' }]],
  [() => C.leaveWaitlist(5), ['del', '/api/agenda/client/waitlist/5']],
  [() => C.getWallet(), ['get', '/api/marketing/client/wallet']],
  [() => C.buyGiftCard({ value: '50.00', recipient_name: '' }), ['post', '/api/marketing/client/gift-cards', { value: '50.00', recipient_name: '' }]],
  [() => C.setMarketingConsent(false), ['post', '/api/marketing/client/marketing-consent', { accepted: false }]],
  [() => C.getMe(), ['get', '/api/auth/client/me']],
  [() => C.updateMe({ lang: 'en' }), ['put', '/api/auth/client/me', { lang: 'en' }]],
];

test('ogni endpoint: stesso metodo, percorso, corpo e opzioni', async () => {
  for (const [run, want] of CASES) {
    calls.length = 0;
    assert.deepEqual(await run(), { ok: true });
    // JSON.stringify: anche il numero di argomenti e l'ordine delle chiavi
    assert.equal(JSON.stringify(calls), JSON.stringify([want]), want[1]);
  }
});

test('nessun endpoint senza la sua prova', () => {
  const tested = new Set(CASES.map(([run]) => /C\.(\w+)\(/.exec(String(run))[1]));
  assert.deepEqual(Object.keys(C).filter((name) => !tested.has(name)), []);
});
