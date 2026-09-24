// links.js — i collegamenti verso fuori dall'app: le indicazioni per il salone
// e l'appuntamento da aggiungere al calendario del telefono.
// Logica pura (downloadIcs tocca il DOM solo quando la si chiama): la caricano
// anche i test con `node --test`.
import { parseISO } from '@youty/shared';
import { apptMinutes, apptServiceNames } from './appointments.js';

/** Google Maps directions link searching the salon by name. */
export function mapsUrl(brand) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(brand?.name || '');
}

/** Build an .ics data URL for an appointment (client-side add-to-calendar). */
export function icsDataUrl(appt, brandName) {
  // Orari in UTC (la Z finale): un .ics con l'ora "fluttuante" veniva
  // interpretato dal calendario nel fuso del telefono, e un appuntamento preso
  // dall'estero finiva in agenda all'ora sbagliata.
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  const start = parseISO(appt.start);
  const end = appt.end ? parseISO(appt.end) : new Date(start.getTime() + apptMinutes(appt) * 60000);
  const summary = (apptServiceNames(appt) || 'Appuntamento') + (brandName ? ' — ' + brandName : '');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//youty//client-app//IT', 'BEGIN:VEVENT',
    `UID:appt-${appt.id}@youty`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
    `SUMMARY:${summary.replace(/[\n,;]/g, ' ')}`, brandName ? `LOCATION:${brandName.replace(/[\n,;]/g, ' ')}` : null,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
}

export function downloadIcs(appt, brandName) {
  const a = document.createElement('a');
  a.href = icsDataUrl(appt, brandName);
  a.download = 'appuntamento.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
