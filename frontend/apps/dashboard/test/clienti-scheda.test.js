// Scheda cliente: il PUT porta solo i campi cambiati e i consensi mostrano
// solo le date che il server ha registrato (caccia ai bug del 22/09/2026:
// 14-05, 06-10, 14-14; contratto C15).
//
// Prima ogni salvataggio rimandava l'intera copia letta all'apertura: la
// cliente revocava il marketing dall'app, la reception cambiava un'etichetta
// o correggeva il nome e il marketing tornava attivo, con la data della
// revoca cancellata.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clientChanges, consentStamp } from '../src/sections/clienti/helpers.js';

/* La scheda come l'ha letta la reception aprendo «Modifica». */
const opened = {
  id: 7,
  first_name: 'Maria',
  last_name: 'Rossi',
  phone: '+393331234567',
  email: '',
  wa: true,
  lang: 'it',
  categories: [{ id: 3, name: 'VIP' }, { id: 5, name: 'Colore' }],
  gender: 'female',
  birthday: '--03-15',
  origin: 'Instagram',
  since: '2021-05-10',
  deposit_always: false,
  whatsapp_reminders: true,
  consents: { privacy: true, marketing: true, marketing_at: '2026-01-10T09:00:00+01:00' },
  reliability: 92,
  is_active: true,
};

/* I valori del modulo come li costruisce NewClientModal. */
const form = (patch = {}) => ({
  first_name: 'Maria', last_name: 'Rossi', phone: '+393331234567', wa: true,
  email: '', lang: 'it', category_ids: [5, 3], gender: 'female', birthday: '--03-15',
  origin: 'Instagram', since: '2021-05-10', deposit_always: false, whatsapp_reminders: true,
  ...patch,
});

test('modulo non toccato: nessun campo da mandare (anche con le etichette in altro ordine)', () => {
  assert.deepEqual(clientChanges(opened, form()), {});
});

test('corretto solo il nome: parte solo il nome, mai consensi, lingua o promemoria', () => {
  const body = clientChanges(opened, form({ first_name: 'Marta' }));
  assert.deepEqual(body, { first_name: 'Marta' });
  for (const k of ['consents', 'lang', 'whatsapp_reminders', 'is_active', 'reliability']) {
    assert.equal(k in body, false, `${k} non deve viaggiare`);
  }
});

test('i consensi non partono mai dal modulo anagrafica, nemmeno se qualcuno li passa', () => {
  const body = clientChanges(opened, { ...form(), consents: { marketing: true } });
  assert.deepEqual(body, {});
});

test('svuotare compleanno e «cliente dal» manda null, cambiare le etichette manda la lista', () => {
  assert.deepEqual(
    clientChanges(opened, form({ birthday: null, since: null, category_ids: [3] })),
    { birthday: null, since: null, category_ids: [3] },
  );
});

test('i campi vuoti della scheda (null, assenti) valgono come i vuoti del modulo', () => {
  const sparse = { id: 8, first_name: 'Anna', phone: '+393330000000', categories: [] };
  const same = {
    first_name: 'Anna', last_name: '', phone: '+393330000000', wa: false, email: '', lang: 'it',
    category_ids: [], gender: '', birthday: null, origin: '', since: null,
    deposit_always: false, whatsapp_reminders: false,
  };
  assert.deepEqual(clientChanges(sparse, same), {});
  assert.deepEqual(clientChanges(sparse, { ...same, email: 'anna@example.com' }), { email: 'anna@example.com' });
});

test('consenso dato con la data del server: si mostra', () => {
  assert.deepEqual(
    consentStamp({ privacy: true, privacy_at: '2026-09-20T10:15:00+02:00' }, 'privacy'),
    { kind: 'given', at: '2026-09-20T10:15:00+02:00' },
  );
});

test('consenso revocato: si mostra la revoca, non la vecchia data di concessione', () => {
  const cs = { marketing: false, marketing_at: '', marketing_revoked_at: '2026-09-21T18:02:00+02:00' };
  assert.deepEqual(consentStamp(cs, 'marketing'), { kind: 'revoked', at: '2026-09-21T18:02:00+02:00' });
  // dati di prima della correzione: la revoca lasciava `marketing_at` e basta
  assert.equal(consentStamp({ marketing: false, marketing_at: '2026-01-10T09:00:00+01:00' }, 'marketing'), null);
});

test('nessuna data registrata (o illeggibile): nessuna promessa', () => {
  assert.equal(consentStamp({ card_charge: true }, 'card_charge'), null);
  assert.equal(consentStamp({ privacy: true, privacy_at: 'ieri' }, 'privacy'), null);
  assert.equal(consentStamp(undefined, 'privacy'), null);
});
