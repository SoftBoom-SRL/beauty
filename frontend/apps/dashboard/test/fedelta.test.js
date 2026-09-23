// Promozioni (fedeltà, coupon, gift card): le regole pure della sezione.
// Caccia ai bug del 22/09/2026 — 07-01/14-01 (timbri per euro), 07-07 (scadute
// «attive»), C21 (codici mascherati), 07-15/14-13/17-15 (fuso del salone e
// «+N mesi» che sforava a fine mese).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { earnFields, earnMetricsFor, effectiveStatus, isMaskedCode, STAMP_METRICS } from '../src/sections/fedelta/meta.js';

test('tessera a timbri: mai «per euro», rapporto 1 (C18)', () => {
  // il modello vuoto della dashboard nasce per_euro: scegliendo «A timbri» partiva così,
  // e il server dava un timbro per ogni euro (una piega da 45 € = quattro premi)
  assert.deepEqual(earnFields('stamps', 'per_euro', 1), { earn_metric: 'per_visit', earn_ratio: '1.00' });
  assert.deepEqual(earnFields('stamps', undefined, undefined), { earn_metric: 'per_visit', earn_ratio: '1.00' });
  // visita o servizio si scelgono; un rapporto rimasto dai punti non passa (0,5 → nessun timbro)
  assert.deepEqual(earnFields('stamps', 'per_service', '0.50'), { earn_metric: 'per_service', earn_ratio: '1.00' });
  assert.deepEqual(earnFields('stamps', 'per_visit', 3), { earn_metric: 'per_visit', earn_ratio: '1.00' });
  // il selettore dei timbri offre solo visita e servizio
  assert.deepEqual(earnMetricsFor('stamps').map((m) => m.k), STAMP_METRICS);
  assert.deepEqual(STAMP_METRICS, ['per_visit', 'per_service']);
});

test('programmi a punti: metrica e rapporto restano quelli scelti', () => {
  assert.deepEqual(earnFields('points', 'per_euro', 2), { earn_metric: 'per_euro', earn_ratio: '2.00' });
  assert.deepEqual(earnFields('points', 'per_visit', '1.5'), { earn_metric: 'per_visit', earn_ratio: '1.50' });
  assert.deepEqual(earnFields('tiers', undefined, undefined), { earn_metric: 'per_euro', earn_ratio: '1.00' });
  assert.ok(earnMetricsFor('points').some((m) => m.k === 'per_euro'));
});

test('carta o coupon oltre la scadenza si mostra «scaduto» (07-07, C21)', () => {
  const now = Date.parse('2026-09-23T10:00:00+02:00');
  // «Piega» regalata scaduta la settimana scorsa: a database resta «active»
  assert.equal(effectiveStatus({ status: 'active', expires_at: '2026-09-16T23:59:00+02:00' }, now), 'expired');
  assert.equal(effectiveStatus({ status: 'active', expires_at: '2026-09-30T23:59:00+02:00' }, now), 'active');
  assert.equal(effectiveStatus({ status: 'active', expires_at: null }, now), 'active');
  // gli altri stati restano quelli del server (già calcolato lì: C21)
  assert.equal(effectiveStatus({ status: 'redeemed', expires_at: '2026-09-16T23:59:00+02:00' }, now), 'redeemed');
  assert.equal(effectiveStatus({ status: 'expired', expires_at: null }, now), 'expired');
});

test('codici mascherati per chi non ha marketing né cassa (C21)', () => {
  assert.equal(isMaskedCode('••••1234'), true);
  assert.equal(isMaskedCode('GC-7Q2K-1234'), false);
  assert.equal(isMaskedCode(null), false);
});
