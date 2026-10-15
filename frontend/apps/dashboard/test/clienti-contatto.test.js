// Scheda cliente senza telefono, «si contatta tramite», affidabilità calcolata
// e debito: le funzioni pure di sections/clienti/helpers.js che le mostrano.
//
// Portando i dati di un salone da un altro gestionale: 114 clienti senza un
// numero valido e 64 numeri usati da 130 schede (madre e figlia, coppie).
// La scheda senza numero si legge «senza telefono» o «tramite Laura», si
// chiama al numero di chi la rappresenta, e il numero già di un'altra cliente
// diventa una proposta («Usa il numero di Laura come contatto»).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  amountDue, clientChanges, dependentsNotice, phoneHolderOf, phoneLine, reachPhone, reliabilityExplain,
} from '../src/sections/clienti/helpers.js';

const t = (it) => it;
const laura = { id: 4, full_name: 'Laura Rossi', phone: '+393331112233' };

test('il telefono in lista e in testata: il numero, «tramite …» o «senza telefono»', () => {
  assert.deepEqual(phoneLine({ phone: '+393334445566', contact: laura }, t), { kind: 'phone', text: '+393334445566' });
  assert.deepEqual(phoneLine({ phone: '', contact: laura }, t), { kind: 'contact', text: 'tramite Laura Rossi' });
  assert.deepEqual(phoneLine({ phone: '', contact: null }, t), { kind: 'none', text: 'senza telefono' });
  assert.deepEqual(phoneLine({}, t), { kind: 'none', text: 'senza telefono' });
});

test('si chiama e si scrive al numero suo, altrimenti a quello del contatto', () => {
  assert.equal(reachPhone({ phone: '+393334445566', contact: laura }), '+393334445566');
  assert.equal(reachPhone({ phone: '', contact: laura }), '+393331112233');
  assert.equal(reachPhone({ phone: '', contact: null }), '');
});

test('il numero già di un’altra cliente: chi lo ha e se può fare da contatto', () => {
  const err = { status: 400, data: { detail: 'Telefono già registrato', phone_holder_id: 4, phone_holder_name: 'Laura Rossi', contact_allowed: true } };
  assert.deepEqual(phoneHolderOf(err), { id: 4, name: 'Laura Rossi', allowed: true });
  assert.deepEqual(phoneHolderOf({ ...err, data: { ...err.data, contact_allowed: false } }), { id: 4, name: 'Laura Rossi', allowed: false });
  // la scheda archiviata è un 409 con un'altra proposta (riattivarla), non questa
  assert.equal(phoneHolderOf({ status: 409, data: { archived_client_id: 4 } }), null);
  assert.equal(phoneHolderOf({ status: 400, data: { detail: 'Il nome è obbligatorio' } }), null);
  assert.equal(phoneHolderOf(new Error('rete')), null);
});

test('il PUT porta il contatto solo se cambia: collegare, cambiare, scollegare', () => {
  const opened = { first_name: 'Giulia', phone: '', contact: laura, categories: [] };
  const form = (patch) => ({ first_name: 'Giulia', phone: '', contact_client_id: 4, category_ids: [], ...patch });
  assert.deepEqual(clientChanges(opened, form()), {});
  assert.deepEqual(clientChanges(opened, form({ contact_client_id: null })), { contact_client_id: null });
  assert.deepEqual(clientChanges(opened, form({ contact_client_id: 9 })), { contact_client_id: 9 });
  // un numero suo: il collegamento si toglie insieme
  assert.deepEqual(
    clientChanges(opened, form({ phone: '+393339990000', contact_client_id: null })),
    { phone: '+393339990000', contact_client_id: null },
  );
  // chi non aveva contatto e resta senza: niente da mandare
  assert.deepEqual(clientChanges({ first_name: 'Sola', phone: '' }, { first_name: 'Sola', phone: '', contact_client_id: null }), {});
});

test('affidabilità calcolata: la regola e i conteggi degli ultimi 12 mesi', () => {
  const none = reliabilityExplain({ no_shows: 0, late_cancellations: 0, since: '2025-10-15' }, t);
  assert.match(none.rule, /ultimi 12 mesi/);
  assert.match(none.rule, /meno 25 per ogni giorno con un no-show e 10 per ogni giorno con un annullamento tardivo/);
  assert.equal(none.counts, 'Nessun no-show né annullamento tardivo in 12 mesi');
  assert.equal(reliabilityExplain({ no_shows: 1, late_cancellations: 0 }, t).counts, '1 no-show in 12 mesi');
  assert.equal(reliabilityExplain({ no_shows: 2, late_cancellations: 1 }, t).counts, '2 no-show · 1 annullamento tardivo in 12 mesi');
  assert.equal(reliabilityExplain({ no_shows: 0, late_cancellations: 3 }, t).counts, '3 annullamenti tardivi in 12 mesi');
  // un server che non manda i conteggi: resta la regola
  assert.deepEqual(reliabilityExplain(null, t), { rule: none.rule, counts: '' });
});

test('«Da saldare» solo se c’è davvero qualcosa (null = nascosto, mai 0)', () => {
  assert.equal(amountDue({ amount_due: '40.50' }), 40.5);
  assert.equal(amountDue({ amount_due: '0.00' }), null);
  assert.equal(amountDue({ amount_due: null }), null);
  assert.equal(amountDue({}), null);
  assert.equal(amountDue({ amount_due: '0.004' }), null);
});

test('archiviare chi fa da contatto: la conferma dice chi perde il numero', () => {
  assert.equal(dependentsNotice([], t), '');
  assert.equal(dependentsNotice(undefined, t), '');
  assert.equal(
    dependentsNotice([{ id: 7, full_name: 'Giulia Rossi' }], t),
    'Giulia Rossi si contatta tramite questa scheda: archiviandola perde il collegamento e resta senza numero di contatto.',
  );
  assert.match(
    dependentsNotice([{ id: 7, full_name: 'Giulia Rossi' }, { id: 8, full_name: 'Marco Bianchi' }], t),
    /^Giulia Rossi, Marco Bianchi si contattano tramite questa scheda: archiviandola perdono il collegamento/,
  );
});
