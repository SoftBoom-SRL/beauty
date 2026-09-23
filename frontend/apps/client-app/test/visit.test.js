// Caccia 22/09 — regole sulle visite nell'app cliente (visitLib.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { depositDueMs, depositExpired } from '../src/screens/visitLib.js';

// 16-05: la Home lasciata aperta mostrava «Paga ora» anche dopo la scadenza
// della caparra; il pagamento arrivava dopo il rilascio dell'orario e finiva
// in un rimborso.
test('caparra: «Paga ora» solo fino alla scadenza', () => {
  const appt = { deposit_status: 'required', deposit_due_at: '2026-09-23T10:30:00+02:00' };
  const due = Date.parse('2026-09-23T08:30:00Z');
  assert.equal(depositDueMs(appt), due);
  assert.equal(depositExpired(appt, due - 60000), false);
  assert.equal(depositExpired(appt, due), true);
  assert.equal(depositExpired(appt, due + 60000), true);
});

test('caparra: senza scadenza o già pagata non scade', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  assert.equal(depositExpired({ deposit_status: 'required', deposit_due_at: null }, now), false);
  assert.equal(depositExpired({ deposit_status: 'paid', deposit_due_at: '2026-09-23T10:30:00+02:00' }, now), false);
  assert.equal(depositDueMs(null), null);
});
