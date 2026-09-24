// «Aggiungi al calendario» e «Indicazioni» dell'app cliente (lib/links.js).
//
// L'.ics porta gli orari in UTC, con la Z finale: con l'ora «fluttuante» il
// calendario del telefono la leggeva nel proprio fuso, e un appuntamento preso
// dall'estero finiva all'ora sbagliata. Il fuso del dispositivo qui è apposta
// diverso da quello del salone.
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { icsDataUrl, mapsUrl } from '../src/lib/links.js';

const PREFIX = 'data:text/calendar;charset=utf-8,';

/** Le righe dell'.ics, con il DTSTAMP (l'istante di adesso) controllato a parte. */
function icsLines(appt, brandName) {
  const url = icsDataUrl(appt, brandName);
  assert.ok(url.startsWith(PREFIX));
  const lines = decodeURIComponent(url.slice(PREFIX.length)).split('\r\n');
  const stamp = lines.filter((l) => l.startsWith('DTSTAMP:'));
  assert.equal(stamp.length, 1);
  assert.match(stamp[0], /^DTSTAMP:\d{8}T\d{4}00Z$/);
  return lines.filter((l) => !l.startsWith('DTSTAMP:'));
}

test('ics: inizio e fine in UTC, servizi e salone nel titolo', () => {
  const appt = {
    id: 42, start: '2026-11-14T10:00:00+01:00', end: '2026-11-14T11:40:00+01:00',
    services: [{ name: 'Colore' }, { name: 'Piega' }],
  };
  assert.deepEqual(icsLines(appt, 'The Parlour'), [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//youty//client-app//IT', 'BEGIN:VEVENT',
    'UID:appt-42@youty', 'DTSTART:20261114T090000Z', 'DTEND:20261114T104000Z',
    'SUMMARY:Colore + Piega — The Parlour', 'LOCATION:The Parlour',
    'END:VEVENT', 'END:VCALENDAR',
  ]);
});

test('ics: senza la fine vale la durata dei servizi, posa compresa (anche sul cambio dell\'ora)', () => {
  // Notte del passaggio all'ora legale a Roma: 01:30 +01:00 = 00:30 UTC.
  const appt = { id: 7, start: '2026-03-29T01:30:00+01:00', services: [{ name: 'Colore', duration_min: 60, soak_min: 40 }] };
  const lines = icsLines(appt, 'Bar, Caffè; e\nsalone');
  assert.ok(lines.includes('DTSTART:20260329T003000Z'));
  assert.ok(lines.includes('DTEND:20260329T021000Z'));
  // virgole, punti e virgola e a capo del nome diventano spazi
  assert.ok(lines.includes('SUMMARY:Colore — Bar  Caffè  e salone'));
  assert.ok(lines.includes('LOCATION:Bar  Caffè  e salone'));
});

test('ics: senza servizi né salone, «Appuntamento» e niente LOCATION', () => {
  const lines = icsLines({ id: 8, start: '2026-11-14T10:00:00+01:00', services: [] }, '');
  assert.ok(lines.includes('SUMMARY:Appuntamento'));
  assert.ok(lines.includes('DTEND:20261114T090000Z'));
  assert.equal(lines.some((l) => l.startsWith('LOCATION:')), false);
});

test('indicazioni: ricerca su Google Maps col nome del salone', () => {
  assert.equal(mapsUrl({ name: 'The Parlour & Co' }), 'https://www.google.com/maps/search/?api=1&query=The%20Parlour%20%26%20Co');
  assert.equal(mapsUrl(null), 'https://www.google.com/maps/search/?api=1&query=');
  assert.equal(mapsUrl({}), 'https://www.google.com/maps/search/?api=1&query=');
});
