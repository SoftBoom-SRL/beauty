// Dati finti per la pagina di anteprima dell'agenda (solo sviluppo).
// Oltre a rispondere alle GET, tengono uno stato in memoria: spostare un blocco
// o modificare i servizi dal pannello cambia davvero la giornata, come farebbe
// il server. Senza, ogni gesto tornava indietro al primo ricarico e l'anteprima
// non diceva se la modifica aveva funzionato.
const today = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const TODAY = iso(today);
const at = (day, h, m = 0) => `${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;

const SVC_OPS = { 10: [3], 11: [3], 12: [1, 2], 13: [1, 2] };

export const OPERATORS = [
  { id: 1, first_name: 'Anna', last_name: 'Ferri', initials: 'AF', name: 'Anna Ferri', role_title: 'Hair stylist', active: true },
  { id: 2, first_name: 'Giulia', last_name: 'Neri', initials: 'GN', name: 'Giulia Neri', role_title: 'Estetista', active: true },
  { id: 3, first_name: 'Sara', last_name: 'Blu', initials: 'SB', name: 'Sara Blu', role_title: 'Nail artist', active: true },
].map((o) => ({
  // come il payload vero di /api/staff/: l'elenco dei servizi che sa fare
  ...o,
  service_ids: Object.keys(SVC_OPS).filter((sid) => SVC_OPS[sid].includes(o.id)).map(Number),
}));

export const SERVICES = [
  { id: 10, name_it: 'Manicure gel', name_en: 'Gel manicure', duration_min: 60, soak_min: 0, price: '35.00', category_id: 100, active: true, operators: SVC_OPS[10] },
  // 20 minuti: la durata che NON cade sulle fasce da 15 — serve a provare
  // l'aggancio al vicino durante il trascinamento
  { id: 11, name_it: 'Nail art', name_en: 'Nail art', duration_min: 20, soak_min: 0, price: '15.00', category_id: 100, active: true, operators: SVC_OPS[11] },
  { id: 12, name_it: 'Colore', name_en: 'Colour', duration_min: 45, soak_min: 30, price: '60.00', category_id: 101, active: true, operators: SVC_OPS[12] },
  { id: 13, name_it: 'Piega', name_en: 'Blow-dry', duration_min: 30, soak_min: 0, price: '25.00', category_id: 101, active: true, operators: SVC_OPS[13] },
];
export const SERVICE_CATEGORIES = [
  { id: 100, name: 'Unghie', color: '#8A5A6E' },
  { id: 101, name: 'Capelli', color: '#5E748C' },
];

const svcOf = (id) => SERVICES.find((s) => s.id === id);
const opName = (id) => OPERATORS.find((o) => o.id === id)?.first_name;

const item = (id, service, opId, order) => ({
  id, service_id: service.id, service_name: service.name_it, operator_id: opId,
  operator_name: opName(opId),
  duration_min: service.duration_min, soak_min: service.soak_min, price: service.price, order,
});

// visita multi-servizio (colore + piega) + una visita singola + due sovrapposte
const SEED = (day) => [
  {
    id: 501, start: at(day, 9, 0), end: at(day, 10, 45), operator_id: 1, status: 'confirmed',
    client: { id: 90, full_name: 'Marta Rossi', phone: '+39 333 111 2233' },
    client_name: 'Marta Rossi', client_phone: '+39 333 111 2233',
    total_duration_min: 105, duration_min: 105, total_price: '85.00', note: 'Allergia alla tinta scura',
    deposit_status: 'none', forced: false, gifts: [],
    items: [item(9001, SERVICES[2], 1, 0), item(9002, SERVICES[3], 1, 1)],
  },
  {
    id: 502, start: at(day, 11, 30), end: at(day, 11, 50), operator_id: 3, status: 'confirmed',
    client: { id: 91, full_name: 'Lucia Bianchi', phone: '+39 347 555 8899' },
    client_name: 'Lucia Bianchi', client_phone: '+39 347 555 8899',
    total_duration_min: 20, duration_min: 20, total_price: '15.00', note: '',
    deposit_status: 'required', deposit_amount: '10.00', forced: false, gifts: [],
    items: [item(9003, SERVICES[1], 3, 0)],   // Nail art: 20 minuti, 11:30–11:50
  },
  {
    id: 503, start: at(day, 14, 0), end: at(day, 15, 0), operator_id: 2, status: 'checked_in',
    client: { id: 92, full_name: 'Elena Verdi', phone: '+39 320 777 4411' },
    client_name: 'Elena Verdi', client_phone: '+39 320 777 4411',
    total_duration_min: 30, duration_min: 30, total_price: '25.00', note: '',
    deposit_status: 'none', forced: true, gifts: [],
    items: [item(9004, SERVICES[3], 2, 0)],
  },
];

/* ---- stato in memoria: una giornata per data, creata alla prima richiesta ---- */
const STORE = new Map();
const dayOf = (isoStart) => String(isoStart).slice(0, 10);
const appointmentsOf = (day) => {
  // La giornata finta è UNA: gli altri giorni nascono vuoti, e si riempiono solo
  // con quello che ci si sposta davvero. Seminarli tutti creava un secondo
  // appuntamento con lo stesso id a ogni giorno visitato, e dopo uno
  // spostamento di data non si capiva più quale fosse quello vero.
  if (!STORE.has(day)) STORE.set(day, day === TODAY ? SEED(day) : []);
  return STORE.get(day);
};
export const APPOINTMENTS = (day) => appointmentsOf(day);
const findAppt = (id) => {
  for (const list of STORE.values()) {
    const hit = list.find((a) => a.id === id);
    if (hit) return hit;
  }
  return null;
};

/** Ricalcola fine, durata e totale dopo una modifica (come fa il server). */
function recompute(a) {
  const minutes = a.items.reduce((s, it) => s + (it.duration_min || 0) + (it.soak_min || 0), 0);
  a.total_duration_min = minutes;
  a.duration_min = minutes;
  a.total_price = a.items.reduce((s, it) => s + Number(it.price || 0), 0).toFixed(2);
  a.operator_id = a.items[0]?.operator_id ?? a.operator_id;
  const start = new Date(a.start);
  a.end = new Date(start.getTime() + minutes * 60000).toISOString();
  a.items.forEach((it, i) => { it.order = i; it.operator_name = opName(it.operator_id); });
  return a;
}

/** POST /appointments/{id}/move — stessa regola del server su from_operator_id. */
export function moveAppointment(id, body) {
  const a = findAppt(id);
  if (!a) return { detail: 'non trovato' };
  const before = dayOf(a.start);
  a.start = body.start;
  if (body.operator_id) {
    const from = body.from_operator_id || a.operator_id;
    const bad = a.items.find((it) => it.operator_id === from && !(SVC_OPS[it.service_id] || []).includes(body.operator_id));
    if (bad) return { __status: 400, detail: 'Operatrice non idonea per il servizio selezionato' };
    a.items.forEach((it) => { if (it.operator_id === from) it.operator_id = body.operator_id; });
  }
  recompute(a);
  const after = dayOf(a.start);
  if (after !== before) {
    STORE.set(before, appointmentsOf(before).filter((x) => x.id !== id));
    appointmentsOf(after).push(a);
  }
  return a;
}

/** PUT /appointments/{id} — lista completa dei servizi e/o nota. */
export function editAppointment(id, body) {
  const a = findAppt(id);
  if (!a) return { detail: 'non trovato' };
  if (body.note !== undefined) a.note = body.note;
  if (body.items) {
    let seq = 9900;
    a.items = body.items.map((raw) => {
      const previous = a.items.find((x) => x.id === raw.id && x.service_id === raw.service_id);
      const s = svcOf(raw.service_id);
      const opId = raw.operator_id ?? (SVC_OPS[raw.service_id] || [])[0] ?? a.operator_id;
      if (!(SVC_OPS[raw.service_id] || []).includes(opId)) return { __bad: true };
      return {
        id: previous ? previous.id : ++seq,
        service_id: raw.service_id, service_name: s?.name_it || '',
        operator_id: opId, operator_name: opName(opId),
        duration_min: raw.duration_min || previous?.duration_min || s?.duration_min || 30,
        // l'attesa dopo il servizio si può scrivere, come sul server
        soak_min: Number.isInteger(raw.soak_min) ? raw.soak_min : (previous ? previous.soak_min : (s?.soak_min || 0)),
        price: previous ? previous.price : (s?.price || '0.00'),
        order: 0,
      };
    });
    if (a.items.some((x) => x.__bad)) return { __status: 400, detail: 'Operatrice non idonea per il servizio selezionato' };
  }
  recompute(a);
  return a;
}

export const APPOINTMENT = (id) => findAppt(id) || appointmentsOf(TODAY)[0];

export const DAY_ROWS = (day) => OPERATORS.map((o) => ({
  operator: { id: o.id, name: o.name, first_name: o.first_name, last_name: o.last_name, initials: o.initials, role_title: o.role_title },
  windows: o.id === 3 ? [['09:00', '13:00']] : [['09:00', '13:00'], ['14:00', '19:00']],
  // un appuntamento è elencato una volta sola, nella riga dell'operatrice principale
  appointments: appointmentsOf(day).filter((a) => a.operator_id === o.id),
  pauses: o.id === 1 ? [{ id: 700, operator_id: 1, start: at(day, 13, 0), duration_min: 60, note: 'pranzo' }] : [],
}));

/* La settimana ha un payload PIÙ POVERO del giorno (vedi agenda_week in
 * apps/agenda/api/agenda_views.py): niente oggetto cliente, niente prezzi per riga. Qui si
 * riproduce esattamente quello, altrimenti l'anteprima è più generosa del
 * server e un campo che manca davvero si scopre solo in salone — è già successo
 * col colore dei servizi, che senza `service_id` ripiegava sull'operatrice. */
const compact = (a) => ({
  id: a.id, start: a.start, client_name: a.client_name, client_phone: a.client_phone,
  operator_id: a.operator_id, status: a.status, duration_min: a.total_duration_min,
  total_price: a.total_price, forced: a.forced, deposit_status: a.deposit_status,
  note: a.note, gifts: a.gifts || [],
  items: a.items.map((it) => ({
    service_id: it.service_id, operator_id: it.operator_id,
    duration_min: it.duration_min, soak_min: it.soak_min, service_name: it.service_name,
  })),
});

export const WEEK = (startIso) => {
  const base = new Date(startIso + 'T00:00');
  return [...Array(7)].map((_, i) => {
    const d = new Date(base); d.setDate(base.getDate() + i);
    const day = iso(d);
    const appts = appointmentsOf(day);
    return { date: day, count: appts.length, by_status: {}, appointments: appts.map(compact) };
  });
};

export const SALON = {
  id: 1, name: 'The Parlour', slug: 'the-parlour',
  locations: [{ id: 1, name: 'Sede principale', is_default: true }],
  settings: { timezone: 'Europe/Rome', slot_interval_min: 15, currency: 'EUR' },
};

/* ---- «torna indietro» ------------------------------------------------------
 * Il ripristino vero lo fa il server (apps/agenda/undo.py): qui basta uno
 * storico in memoria, per vedere il tasto accendersi, la frase che ne esce e
 * l'appuntamento che torna al suo posto. */
const UNDO = [];
let undoSeq = 1;

/** Fotografa l'appuntamento PRIMA di toccarlo. La chiama l'anteprima nelle rotte. */
export function rememberUndo(id, label) {
  const a = findAppt(id);
  if (!a) return;
  UNDO.unshift({
    id: undoSeq++,
    label,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 10 * 60000).toISOString(),
    kind: 'move',
    snap: { id: a.id, start: a.start, operator_id: a.operator_id, items: JSON.parse(JSON.stringify(a.items)) },
  });
  UNDO.splice(20);
}

export const UNDO_STACK = () => UNDO.map(({ snap, ...rest }) => rest);

export function undoLast(entryId) {
  const index = entryId ? UNDO.findIndex((e) => e.id === entryId) : 0;
  if (index < 0 || !UNDO.length) return { __status: 404, detail: 'Non c’è niente da annullare' };
  const [entry] = UNDO.splice(index, 1);
  const a = findAppt(entry.snap.id);
  if (!a) return { __status: 409, detail: 'L’appuntamento non esiste più' };
  const before = dayOf(a.start);
  a.start = entry.snap.start;
  a.operator_id = entry.snap.operator_id;
  a.items = entry.snap.items;
  recompute(a);
  const after = dayOf(a.start);
  if (after !== before) {
    STORE.set(before, appointmentsOf(before).filter((x) => x.id !== a.id));
    appointmentsOf(after).push(a);
  }
  return { ok: true, label: entry.label, date: after, appointment_ids: [a.id] };
}
