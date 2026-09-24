// Ritorno del popup Yourang: il codice si scambia solo se il flusso è stato
// avviato in QUESTA finestra. Il caso che conta: il link
// /oauth-popup/done?code=…&state=… dell'accesso di un altro, aperto qui, non
// deve trovare nessun nonce, quindi l'exchange non parte.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FLOW_KEY, RESTART_KEY, claimRestart, clearRestart, saveFlow, takeFlow,
} from '../src/oauth/flow.js';

/** sessionStorage finto: una Map con l'interfaccia di Storage. */
function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    has: (k) => data.has(k),
  };
}

/** Storage che lancia a ogni accesso (cookie bloccati). */
const brokenStorage = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('SecurityError'); },
  removeItem() { throw new Error('SecurityError'); },
};

test('il flusso salvato all\'avvio si ritrova al ritorno, una volta sola', () => {
  const s = memoryStorage();
  assert.equal(saveFlow(s, 'connect', 'n-1'), true);
  assert.deepEqual(takeFlow(s, 'connect'), { mode: 'connect', nonce: 'n-1' });
  // consumato: un secondo ritorno (link riaperto, refresh) non lo ritrova
  assert.equal(takeFlow(s, 'connect'), null);
  assert.equal(s.has(FLOW_KEY), false);
});

test('una finestra che non ha avviato il flusso non ha nonce', () => {
  assert.equal(takeFlow(memoryStorage(), 'connect'), null);
  assert.equal(takeFlow(memoryStorage(), 'login'), null);
});

test('un ritorno con un altro mode non usa il flusso (e lo consuma)', () => {
  const s = memoryStorage();
  saveFlow(s, 'login', 'n-2');
  assert.equal(takeFlow(s, 'connect'), null);
  assert.equal(takeFlow(s, 'login'), null);
});

test('storage illeggibile, corrotto o senza nonce: nessun flusso', () => {
  assert.equal(saveFlow(null, 'login', 'n'), false);
  assert.equal(saveFlow(brokenStorage, 'login', 'n'), false);
  assert.equal(saveFlow(memoryStorage(), 'login', ''), false);
  assert.equal(takeFlow(null, 'login'), null);
  assert.equal(takeFlow(brokenStorage, 'login'), null);
  const s = memoryStorage();
  s.setItem(FLOW_KEY, '{non json');
  assert.equal(takeFlow(s, 'login'), null);
  s.setItem(FLOW_KEY, JSON.stringify({ mode: 'login' }));
  assert.equal(takeFlow(s, 'login'), null);
});

test('il login senza flusso riparte da capo una volta sola, poi errore', () => {
  const s = memoryStorage();
  assert.equal(claimRestart(s), true);   // prima volta: si riparte da /start
  assert.equal(claimRestart(s), false);  // di nuovo senza flusso: niente giri infiniti
  assert.equal(s.has(RESTART_KEY), false);
  assert.equal(claimRestart(s), true);   // il contatore si è azzerato con l'errore
  clearRestart(s);                       // flusso valido: si azzera
  assert.equal(s.has(RESTART_KEY), false);
  assert.equal(claimRestart(null), false);
  assert.equal(claimRestart(brokenStorage), false);
});

test('senza mode (ritorno del flusso OAuth diretto) vale quello salvato all\'avvio', () => {
  const s = memoryStorage();
  saveFlow(s, 'login', 'n-3');
  assert.deepEqual(takeFlow(s), { mode: 'login', nonce: 'n-3' });
  assert.equal(takeFlow(s), null);
});
