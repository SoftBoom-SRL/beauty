// catalog.js — local (frontend-only) UI copy that has no backing API field: icons per
// event, short hints, sample WhatsApp-style messages for the live preview, and the
// value-input "kind" per condition field. Everything else (events/operators/fields
// themselves, labels) comes from GET /api/automations/events-catalog.

export const EVENT_ICONS = {
  new_client: 'user',
  appointment_created: 'calendar',
  appointment_upcoming: 'clock',
  visit_completed: 'check',
  birthday: 'cake',
  client_inactive: 'revive',
  no_show: 'alert',
  slot_freed: 'gap',
};
export const eventIcon = (value) => EVENT_ICONS[value] || 'bolt';

// Short bilingual sub-label under the event picker — cosmetic only, mirrors what each
// event means (see backend apps.core.services.emit_event call sites).
export const EVENT_HINTS = {
  new_client: { it: 'Alla registrazione di un nuovo cliente', en: 'When a new client registers' },
  appointment_created: { it: 'Quando viene creato un appuntamento', en: 'When an appointment is created' },
  appointment_upcoming: { it: 'In base a un appuntamento in agenda', en: 'Relative to a booked appointment' },
  visit_completed: { it: 'Quando una visita viene chiusa', en: 'When a visit is closed out' },
  birthday: { it: 'Nella data di nascita del cliente', en: 'On the client’s birthday' },
  client_inactive: { it: 'Dopo un periodo senza visite', en: 'After a period with no visits' },
  no_show: { it: 'Quando un cliente non si presenta', en: 'When a client fails to show up' },
  slot_freed: { it: 'Quando si libera un posto in agenda', en: 'When a calendar slot opens up' },
};
export const eventHint = (value, lang) => (EVENT_HINTS[value] || {})[lang] || '';

/* ---- timing offset units — mirrors Automation.OffsetUnit (minutes/hours/days) ---- */
export const OFFSET_UNITS = [
  { id: 'minutes', label: { it: 'minuti', en: 'minutes' }, one: { it: 'minuto', en: 'minute' } },
  { id: 'hours', label: { it: 'ore', en: 'hours' }, one: { it: 'ora', en: 'hour' } },
  { id: 'days', label: { it: 'giorni', en: 'days' }, one: { it: 'giorno', en: 'day' } },
];
export const offsetUnitMeta = (id) => OFFSET_UNITS.find((u) => u.id === id) || OFFSET_UNITS[1];

export function offsetPhrase(dir, n, unitId, lang) {
  if (!n) return lang === 'en' ? 'Right away' : 'Subito';
  const u = offsetUnitMeta(unitId);
  const ul = (n === 1 ? u.one : u.label)[lang];
  const d = dir === 'before' ? (lang === 'en' ? 'before' : 'prima') : (lang === 'en' ? 'after' : 'dopo');
  return `${n} ${ul} ${d}`;
}

/* ---- live WhatsApp-preview token substitution (client-side nicety only —
 * the real message template + variables are authored and sent from Yourang) ---- */
export const DK_SAMPLE = {
  '{nome}': 'Sofia', '{name}': 'Sofia',
  '{data}': 'gio 14 nov', '{date}': 'Thu 14 Nov',
  '{ora}': '15:30', '{time}': '15:30',
  '{servizio}': 'semipermanente', '{service}': 'gel polish',
  '{link}': 'theparlour.it/r',
};
export const dkRender = (s) => (s || '').replace(/\{[^}]+\}/g, (m) => DK_SAMPLE[m] || m);

// Illustrative sample body per event — shown only until Yourang has synced a real
// `message_preview` onto the rule (that field is read-only from our API).
export const EVENT_SAMPLE_MESSAGE = {
  new_client: { it: 'Ciao {nome}! Benvenuta da The Parlour 💛', en: 'Hi {name}! Welcome to The Parlour 💛' },
  appointment_created: { it: 'Appuntamento confermato per {data} alle {ora}.', en: 'Appointment confirmed for {date} at {time}.' },
  appointment_upcoming: { it: 'Promemoria: il tuo appuntamento per {servizio} è {data} alle {ora}.', en: 'Reminder: your {service} appointment is {date} at {time}.' },
  visit_completed: { it: 'Grazie per la visita, {nome}! Com’è andata?', en: 'Thanks for stopping by, {name}! How did it go?' },
  birthday: { it: 'Buon compleanno {nome}! Un pensiero speciale per te 🎂', en: 'Happy birthday {name}! A little gift for you 🎂' },
  client_inactive: { it: 'Ci manchi, {nome}! Torna a trovarci con uno sconto speciale.', en: 'We miss you, {name}! Come back with a special discount.' },
  no_show: { it: 'Ciao {nome}, ci dispiace per l’appuntamento mancato. Vuoi riprenotare?', en: 'Hi {name}, sorry we missed you. Want to rebook?' },
  slot_freed: { it: 'Si è liberato un posto {data} alle {ora}: prenota su {link}', en: 'A slot opened up {date} at {time}: book now at {link}' },
};

/* ---- value-input kind per condition field (from events-catalog `fields`) ----
 * mirrors apps.clients.services.client_facts: reliability/visits/noshow_count are
 * numbers, total_spent is money, categories is a list of label names (matched via
 * "contains") — free-text kept generic so any future field degrades to text safely. */
export const FIELD_KINDS = {
  reliability: 'num',
  total_spent: 'money',
  visits: 'num',
  noshow_count: 'num',
  categories: 'text',
};
export const fieldKind = (value) => FIELD_KINDS[value] || 'text';

export const catLabel = (item, lang) => (item ? (lang === 'en' ? item.label_en : item.label_it) : '');
