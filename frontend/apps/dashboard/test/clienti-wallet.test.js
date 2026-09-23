// Wallet della scheda cliente: il premio fedeltà si legge come nella sezione
// Fedeltà (caccia ai bug del 22/09/2026: 14-21, 07-16).
//
// La scheda cercava 'percent' e 'amount' dentro i tipi veri dell'API
// ('discount_pct', 'gift_card'): «Sconto 20%» e «Gift card da 20 €» uscivano
// come «Premio: 20.00».
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rewardLabel } from '../src/sections/clienti/helpers.js';

const services = [{ id: 4, name_it: 'Piega', name_en: 'Blow-dry' }];

test('sconto percentuale e gift card con la loro etichetta, non un numero nudo', () => {
  assert.equal(rewardLabel({ reward_type: 'discount_pct', reward_value: '20.00' }, services, 'it'), 'Sconto 20%');
  assert.equal(rewardLabel({ reward_type: 'gift_card', reward_value: '20.00' }, services, 'it'), 'Gift card da €20');
  assert.equal(rewardLabel({ reward_type: 'discount_pct', reward_value: '15.00' }, services, 'en'), '15% discount');
});

test('buono a importo e servizio omaggio col nome del listino', () => {
  assert.equal(rewardLabel({ reward_type: 'coupon_amount', reward_value: '10.00' }, services, 'it'), 'Buono da €10');
  assert.equal(rewardLabel({ reward_type: 'free_service', reward_value: '0', reward_service_id: 4 }, services, 'it'), 'Piega');
  assert.equal(rewardLabel({ reward_type: 'free_service', reward_value: '0', reward_service_id: 4 }, services, 'en'), 'Blow-dry');
  // servizio tolto dal listino: resta un'etichetta leggibile
  assert.equal(rewardLabel({ reward_type: 'free_service', reward_value: '0', reward_service_id: 99 }, services, 'it'), 'Servizio omaggio');
});
