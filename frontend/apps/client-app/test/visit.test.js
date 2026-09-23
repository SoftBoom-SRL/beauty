// Caccia 22/09 — regole sulle visite nell'app cliente (visitLib.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  apptMinutes, depositDueMs, depositExpired, sameBooking, svcMinutes,
} from '../src/screens/visitLib.js';

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

// 09-07 (contratto C4): colore 60' + 40' di posa si leggeva «1h» nel listino
// e nel riepilogo, mentre l'agenda tiene la cliente 1h 40'.
test('durata del listino = lavoro + posa', () => {
  assert.equal(svcMinutes({ duration_min: 60, soak_min: 40 }), 100);
  assert.equal(svcMinutes({ duration_min: 45 }), 45);            // backend senza soak_min
  assert.equal(svcMinutes({ duration_min: 30, soak_min: 0 }), 30);
});

test('durata di un appuntamento = dall\'inizio alla fine, posa compresa', () => {
  const appt = {
    start: '2026-09-24T10:00:00+02:00',
    end: '2026-09-24T11:40:00+02:00',
    services: [{ service_id: 3, duration_min: 60 }],
  };
  assert.equal(apptMinutes(appt), 100);
  // senza la fine: la somma dei servizi (con la posa, se c'è)
  assert.equal(apptMinutes({ services: [{ duration_min: 60, soak_min: 40 }, { duration_min: 30 }] }), 130);
});

// 16-08: la cliente ha già il taglio alle 10:00 e prenota la manicure alle
// 10:00; il primo POST si perde per strada, lei riprova e il controllo «esiste
// già?» trovava il taglio: «Fatto!» per una manicure mai creata.
test('riprova: è la stessa prenotazione solo con lo stesso orario E gli stessi servizi', () => {
  const taglio = { start: '2026-09-24T10:00:00+02:00', status: 'confirmed', services: [{ service_id: 1 }] };
  const start = '2026-09-24T08:00:00.000Z'; // stesso istante, scritto come lo manda la disponibilità
  assert.equal(sameBooking(taglio, start, [2]), false);
  assert.equal(sameBooking(taglio, start, [1]), true);
  const coppia = { ...taglio, services: [{ service_id: 2 }, { service_id: 1 }] };
  assert.equal(sameBooking(coppia, start, [1, 2]), true);
  assert.equal(sameBooking(coppia, start, [1]), false);
  assert.equal(sameBooking({ ...taglio, status: 'cancelled' }, start, [1]), false);
  assert.equal(sameBooking(taglio, '2026-09-24T08:30:00.000Z', [1]), false);
});
