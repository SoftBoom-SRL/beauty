// Drawer «Nuova prenotazione»: il «Regalo» con la regola del server e l'orario
// scelto che non torna da solo a quello cliccato in agenda.
// Caccia ai bug del 22/09/2026: 13-09 (= 17-09, 07-07), 13-11, 13-18.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isoAtMin, setSalonTz } from '@youty/shared';
import { nextSelection, usableGiftCards } from '../src/sections/agenda/modals/rules.js';

setSalonTz('Europe/Rome');
const NOW = Date.parse('2026-09-23T10:00:00Z');
const MARIA = 7;
const card = (extra = {}) => ({
  id: 1, code: 'GIFT-AAAA-1111', gift_service_id: 3, payment_status: 'paid', status: 'active',
  balance: '45.00', expires_at: '2026-12-31T23:00:00Z',
  buyer_client_id: MARIA, recipient_client_id: null, recipient_name: '',
  ...extra,
});

test('«Regalo» solo con le carte che la cassa accetterà (regola di gift_index)', () => {
  const ok = [
    card({ id: 1 }),                                                    // comprata da Maria per sé
    card({ id: 2, buyer_client_id: 9, recipient_client_id: MARIA }),    // regalata a Maria
    card({ id: 3, expires_at: null }),                                   // senza scadenza
  ];
  const ko = [
    card({ id: 10, recipient_name: 'Giulia' }),                          // comprata da Maria per «Giulia»
    card({ id: 11, recipient_client_id: 12 }),                           // per un'altra cliente
    card({ id: 12, expires_at: '2026-09-20T10:00:00Z' }),                // scaduta
    card({ id: 13, balance: '0.00' }),                                   // già usata
    card({ id: 14, payment_status: 'pending' }),                         // non pagata
    card({ id: 15, status: 'redeemed' }),
    card({ id: 16, gift_service_id: null }),                             // carta a valore
  ];
  const got = usableGiftCards([...ok, ...ko], MARIA, NOW).map((g) => g.id);
  assert.deepEqual(got, [1, 2, 3]);
  assert.deepEqual(usableGiftCards(ok, null, NOW), []);
});

const DAY = '2026-09-24';
const at = (hh, mm = 0) => isoAtMin(DAY, hh * 60 + mm);
const free = (...isos) => isos.map((start) => ({ start, assignment: [] }));

test('l’orario cliccato in agenda: libero si prende, occupato si prende forzato', () => {
  assert.deepEqual(nextSelection({ prev: null, src: null, slots: free(at(10)), reqStartMin: 600, date: DAY }),
    { start: at(10), src: 'req', force: false, dropped: null });
  assert.deepEqual(nextSelection({ prev: null, src: null, slots: free(at(11)), reqStartMin: 600, date: DAY }),
    { start: at(10), src: 'req', force: true, dropped: null });
});

test('un’alternativa scelta resta anche cambiando i servizi, finché è libera', () => {
  const r = nextSelection({ prev: at(10, 30), src: 'slot', slots: free(at(10, 30), at(11)), reqStartMin: 600, date: DAY });
  assert.deepEqual(r, { start: at(10, 30), src: 'slot', force: false, dropped: null });
});

test('un orario libero preso nel frattempo si toglie, senza tornare a quello cliccato forzato', () => {
  const r = nextSelection({ prev: at(10, 30), src: 'slot', slots: free(at(11)), reqStartMin: 600, date: DAY });
  assert.deepEqual(r, { start: null, src: 'dropped', force: false, dropped: at(10, 30) });
  // e al ricarico dopo resta vuoto finché chi prenota non sceglie
  assert.deepEqual(nextSelection({ prev: null, src: 'dropped', slots: free(at(11)), reqStartMin: 600, date: DAY, refreshed: true }),
    { start: null, src: 'dropped', force: false, dropped: null });
});

test('l’orario cliccato era libero e un’altra postazione lo prende: non si forza sopra', () => {
  const r = nextSelection({ prev: at(10), src: 'req', prevForced: false, slots: free(at(11)), reqStartMin: 600, date: DAY, refreshed: true });
  assert.deepEqual(r, { start: null, src: 'dropped', force: false, dropped: at(10) });
});

test('l’orario cliccato sopra un altro impegno resta forzato anche ai ricarichi', () => {
  const r = nextSelection({ prev: at(10), src: 'req', prevForced: true, slots: free(at(11)), reqStartMin: 600, date: DAY, refreshed: true });
  assert.deepEqual(r, { start: at(10), src: 'req', force: true, dropped: null });
});

test('cambiando i servizi l’orario cliccato si tiene (forzato se non ci sta più)', () => {
  const r = nextSelection({ prev: at(10), src: 'req', prevForced: false, slots: free(at(11)), reqStartMin: 600, date: DAY, refreshed: false });
  assert.deepEqual(r, { start: at(10), src: 'req', force: true, dropped: null });
});

test('l’orario scritto a mano resta, forzato solo se non è fra i liberi', () => {
  assert.deepEqual(nextSelection({ prev: at(10, 10), src: 'manual', slots: free(at(10)), reqStartMin: 600, date: DAY }),
    { start: at(10, 10), src: 'manual', force: true, dropped: null });
  assert.deepEqual(nextSelection({ prev: at(10, 10), src: 'manual', slots: free(at(10, 10)), reqStartMin: 600, date: DAY }),
    { start: at(10, 10), src: 'manual', force: false, dropped: null });
});

test('senza orario cliccato né scelto non si inventa niente', () => {
  assert.deepEqual(nextSelection({ prev: null, src: null, slots: free(at(10)), reqStartMin: null, date: DAY }),
    { start: null, src: null, force: false, dropped: null });
});
