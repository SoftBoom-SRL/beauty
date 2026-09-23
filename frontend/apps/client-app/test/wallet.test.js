// Caccia 22/09 — credito gift card nell'app cliente (16-03, 07-05, 17-14,
// 16-07, contratto C3) e sconto in percentuale (16-12).
//
// La schermata Gift card sommava TUTTE le carte e scriveva «spendibili in
// salone»: la carta appena comprata dall'app (da pagare in salone) e quella
// comprata per un'amica entravano nel saldo, e la cassa poi le rifiutava. Il
// Portafoglio escludeva le carte da pagare ma contava come credito della
// madre la carta regalata alla figlia. Prenota, al contrario, non diceva
// «Coperto da gift card» per la carta «a trattamento» comprata per sé.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cents, fmtPct, giftCardTotals, giftServiceCards, isSpendable,
} from '../src/screens/walletLib.js';

// Il portafoglio di Sofia, come lo manda GET /api/marketing/client/wallet.
const mine = { id: 1, balance: '50.00', payment_status: 'paid', recipient_name: '', received: false };
const fromMum = { id: 2, balance: '20.00', payment_status: 'paid', recipient_name: 'Sofia', received: true, buyer_name: 'Carla' };
const boughtInApp = { id: 3, balance: '30.00', payment_status: 'unpaid', recipient_name: '', received: false };
const forHerFriend = { id: 4, balance: '40.00', payment_status: 'unpaid', recipient_name: 'Giulia', received: false };
const forHerMum = { id: 5, balance: '100.00', payment_status: 'paid', recipient_name: 'Mamma', received: false };
const treatment = { id: 6, balance: '35.00', payment_status: 'paid', recipient_name: '', received: false, gift_service_id: 9 };

const withFlag = (g, spendable) => ({ ...g, spendable });

test('nel saldo solo le carte che la cassa accetta da lei (flag del server)', () => {
  const cards = [
    withFlag(mine, true), withFlag(fromMum, true), withFlag(boughtInApp, false),
    withFlag(forHerFriend, false), withFlag(forHerMum, false),
  ];
  assert.deepEqual(giftCardTotals(cards), {
    spendable: 7000, spendableCount: 2,   // 50 + 20
    pending: 3000, pendingCount: 1,       // la sua carta da pagare, non quella dell'amica
  });
});

test('senza il flag (backend vecchio) vale la stessa regola', () => {
  const cards = [mine, fromMum, boughtInApp, forHerFriend, forHerMum];
  assert.deepEqual(giftCardTotals(cards), {
    spendable: 7000, spendableCount: 2, pending: 3000, pendingCount: 1,
  });
  assert.equal(isSpendable(boughtInApp), false);
  assert.equal(isSpendable(forHerMum), false);
  assert.equal(isSpendable({ ...mine, balance: '0.00' }), false);
});

test('il flag del server vince sulla regola locale', () => {
  // Per esempio una carta scaduta: la regola locale non lo sa.
  assert.equal(isSpendable(withFlag(mine, false)), false);
  assert.deepEqual(giftCardTotals([withFlag(mine, false)]).spendable, 0);
});

test('«Coperto da gift card»: anche la carta a trattamento comprata per sé', () => {
  const cards = [treatment, { ...forHerMum, gift_service_id: 9 }, { ...boughtInApp, gift_service_id: 9 }, mine];
  assert.deepEqual(giftServiceCards(cards).map((g) => g.id), [6]);
  assert.deepEqual(giftServiceCards([withFlag(treatment, false)]), []);
});

test('le somme si fanno in centesimi', () => {
  assert.equal(cents('0.10') + cents('0.20'), 30);
  assert.equal(giftCardTotals([{ ...mine, balance: '0.10' }, { ...mine, balance: '0.20' }]).spendable, 30);
});

test('lo sconto in percentuale non si arrotonda', () => {
  assert.equal(fmtPct('12.50', 'it'), '12,5');
  assert.equal(fmtPct('12.50', 'en'), '12.5');
  assert.equal(fmtPct('10.00', 'it'), '10');
});
