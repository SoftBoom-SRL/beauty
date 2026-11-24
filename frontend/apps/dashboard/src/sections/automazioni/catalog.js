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

/* ---- modelli WhatsApp (YR-1391) ----
 * Il modello approvato su Yourang ha {{1}}, {{2}}… nel testo e, dopo, i link
 * dinamici dei pulsanti: `parameters` li elenca in quell'ordine, e la regola
 * salva per ognuno il campo di youty che lo riempie. */
export const TEMPLATE_SAMPLE = {
  first_name: 'Sofia', full_name: 'Sofia Ricci', date: '14/11/2026', time: '15:30',
  services: 'Semipermanente', operator: 'Giulia', salon: 'The Parlour',
};
// Il campo proposto per ogni valore, finché il titolare non sceglie: dal nome
// che l'autore gli ha dato su Yourang («nome», «ora»…), altrimenti per posizione.
const DEFAULT_FIELDS = ['first_name', 'date', 'time', 'services', 'operator', 'salon', 'full_name'];
const LABEL_FIELDS = [
  [/cognome|full|complet/i, 'full_name'], [/nome|name/i, 'first_name'], [/\bor[ae]\b|orario|time|hour/i, 'time'],
  [/data|giorno|date|day/i, 'date'], [/serviz|trattament|service/i, 'services'],
  [/operat|estetist|staff/i, 'operator'], [/salon|centro|negozio|shop/i, 'salon'],
];
export const defaultTemplateFields = (parameters) => parameters.map((p, i) => {
  const hit = LABEL_FIELDS.find(([re]) => re.test(p.label || ''));
  return hit ? hit[1] : DEFAULT_FIELDS[i % DEFAULT_FIELDS.length];
});

/** Testo del modello con i valori d'esempio dei campi scelti. */
export function renderTemplate(template, fields) {
  if (!template || !template.body) return '';
  const byNumber = {};
  (template.parameters || []).forEach((p, i) => {
    const m = /^body:(\d+)$/.exec(p.key);
    if (m) byNumber[m[1]] = TEMPLATE_SAMPLE[fields[i]] || '…';
  });
  return template.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (all, n) => byNumber[n] ?? all);
}

export const templateKey = (name, language) => (name ? `${name}|${language}` : '');
