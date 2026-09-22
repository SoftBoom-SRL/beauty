// Dati finti per la pagina di anteprima dell'agenda (solo sviluppo).
const today = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const TODAY = iso(today);
const at = (day, h, m = 0) => `${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;

export const OPERATORS = [
  { id: 1, first_name: 'Anna', last_name: 'Ferri', initials: 'AF', name: 'Anna Ferri', role_title: 'Hair stylist', active: true },
  { id: 2, first_name: 'Giulia', last_name: 'Neri', initials: 'GN', name: 'Giulia Neri', role_title: 'Estetista', active: true },
  { id: 3, first_name: 'Sara', last_name: 'Blu', initials: 'SB', name: 'Sara Blu', role_title: 'Nail artist', active: true },
];

export const SERVICES = [
  { id: 10, name_it: 'Manicure gel', name_en: 'Gel manicure', duration_min: 60, soak_min: 0, price: '35.00', category_id: 100, active: true, operators: [3] },
  { id: 11, name_it: 'Nail art', name_en: 'Nail art', duration_min: 30, soak_min: 0, price: '15.00', category_id: 100, active: true, operators: [3] },
  { id: 12, name_it: 'Colore', name_en: 'Colour', duration_min: 45, soak_min: 30, price: '60.00', category_id: 101, active: true, operators: [1] },
  { id: 13, name_it: 'Piega', name_en: 'Blow-dry', duration_min: 30, soak_min: 0, price: '25.00', category_id: 101, active: true, operators: [1, 2] },
];
export const SERVICE_CATEGORIES = [
  { id: 100, name: 'Unghie', color: '#8A5A6E' },
  { id: 101, name: 'Capelli', color: '#5E748C' },
];

const item = (id, service, opId, order, start) => ({
  id, service_id: service.id, service_name: service.name_it, operator_id: opId,
  operator_name: OPERATORS.find((o) => o.id === opId)?.first_name,
  duration_min: service.duration_min, soak_min: service.soak_min, price: service.price, order,
});

// visita multi-servizio (colore + piega) + una visita singola + due sovrapposte
export const APPOINTMENTS = (day) => [
  {
    id: 501, start: at(day, 9, 0), end: at(day, 10, 45), operator_id: 1, status: 'confirmed',
    client: { id: 90, full_name: 'Marta Rossi', phone: '+39 333 111 2233' },
    client_name: 'Marta Rossi', client_phone: '+39 333 111 2233',
    total_duration_min: 105, duration_min: 105, total_price: '85.00', note: 'Allergia alla tinta scura',
    deposit_status: 'none', forced: false, gifts: [],
    items: [item(9001, SERVICES[2], 1, 0), item(9002, SERVICES[3], 1, 1)],
  },
  {
    id: 502, start: at(day, 11, 30), end: at(day, 12, 30), operator_id: 3, status: 'confirmed',
    client: { id: 91, full_name: 'Lucia Bianchi', phone: '+39 347 555 8899' },
    client_name: 'Lucia Bianchi', client_phone: '+39 347 555 8899',
    total_duration_min: 60, duration_min: 60, total_price: '35.00', note: '',
    deposit_status: 'required', deposit_amount: '10.00', forced: false, gifts: [],
    items: [item(9003, SERVICES[0], 3, 0)],
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

export const DAY_ROWS = (day) => OPERATORS.map((o) => ({
  operator: { id: o.id, name: o.name, first_name: o.first_name, last_name: o.last_name, initials: o.initials, role_title: o.role_title },
  windows: o.id === 3 ? [['09:00', '13:00']] : [['09:00', '13:00'], ['14:00', '19:00']],
  appointments: APPOINTMENTS(day).filter((a) => a.operator_id === o.id),
  pauses: o.id === 1 ? [{ id: 700, operator_id: 1, start: at(day, 13, 0), duration_min: 60, note: 'pranzo' }] : [],
}));

export const WEEK = (startIso) => {
  const base = new Date(startIso + 'T00:00');
  return [...Array(7)].map((_, i) => {
    const d = new Date(base); d.setDate(base.getDate() + i);
    const day = iso(d);
    const appts = i === 1 || i === 3 ? APPOINTMENTS(day) : (i === 5 ? APPOINTMENTS(day).slice(0, 1) : []);
    return { date: day, count: appts.length, by_status: {}, appointments: appts };
  });
};

export const SALON = {
  id: 1, name: 'The Parlour', slug: 'the-parlour',
  locations: [{ id: 1, name: 'Sede principale', is_default: true }],
  settings: { timezone: 'Europe/Rome', slot_interval_min: 15, currency: 'EUR' },
};
