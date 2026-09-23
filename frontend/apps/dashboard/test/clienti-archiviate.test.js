// Schede archiviate (caccia ai bug del 22/09/2026: 06-02). La cliente
// archiviata che prova a rientrare dall'app o dal modulo contatti arriva nel
// feed come `client.reactivation_requested`: la sezione Clienti la propone
// finché qualcuno non riattiva la scheda (o nasconde l'avviso).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reactivationRequests } from '../src/sections/clienti/helpers.js';

const req = (id, clientId, source) => ({ id, type: 'client.reactivation_requested', summary: `scheda ${clientId}`, payload: { client_id: clientId, ...(source ? { source } : {}) } });
const upd = (id, clientId, fields) => ({ id, type: 'client.updated', payload: { client_id: clientId, fields } });

test('una segnalazione per scheda, la più recente', () => {
  // il feed arriva dal più recente
  const out = reactivationRequests([req(9, 7, 'hook'), req(5, 7), req(4, 8)]);
  assert.deepEqual(out.map((e) => e.id), [9, 4]);
});

test('riattivata dopo la richiesta: la segnalazione sparisce; archiviata e richiesta di nuovo: torna', () => {
  assert.deepEqual(reactivationRequests([upd(10, 7, ['is_active']), req(9, 7)]), []);
  // un altro campo cambiato non chiude la richiesta
  assert.deepEqual(reactivationRequests([upd(10, 7, ['email']), req(9, 7)]).map((e) => e.id), [9]);
  // server senza `fields`: resta finché non la si nasconde
  assert.deepEqual(reactivationRequests([upd(10, 7), req(9, 7)]).map((e) => e.id), [9]);
  assert.deepEqual(reactivationRequests([req(12, 7), upd(10, 7, ['is_active']), req(9, 7)]).map((e) => e.id), [12]);
});

test('nascosta a mano: non si ripropone', () => {
  assert.deepEqual(reactivationRequests([req(9, 7), req(4, 8)], new Set([9])).map((e) => e.id), [4]);
  assert.deepEqual(reactivationRequests(undefined), []);
});
