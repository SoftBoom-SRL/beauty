// data.jsx — rich demo data for yourang (The Parlour, Firenze)
// Exposed on window. Service names carry {it,en}; people names stay as-is.

// pace: duration multiplier per service category (<1 faster, >1 slower) — the same
// service takes different time depending on the operator's experience/specialty.
const OPS = [
  { id: 'sole',   name: 'Sole',   surname: 'Caputo', initials: 'SC', color: 'var(--op-sole)',   role: { it: 'Titolare · Nail artist', en: 'Owner · Nail artist' }, pace: { nail: 0.8, default: 0.95 } },
  { id: 'mara',   name: 'Mara',   surname: 'Rizzo', initials: 'MR', color: 'var(--op-mara)',   role: { it: 'Hair stylist',         en: 'Hair stylist' }, pace: { hair: 0.9, default: 1.0 } },
  { id: 'lina',   name: 'Lina',   surname: 'Bianchi', initials: 'LB', color: 'var(--op-lina)',   role: { it: 'Estetista viso',       en: 'Facialist' }, pace: { viso: 0.9, default: 1.05 } },
  { id: 'giulia', name: 'Giulia', surname: 'Valli', initials: 'GV', color: 'var(--op-giulia)', role: { it: 'Nail artist',          en: 'Nail artist' }, pace: { nail: 1.15, default: 1.1 } },
  { id: 'asia',   name: 'Asia',   surname: 'Kane', initials: 'AK', color: 'var(--op-asia)',   role: { it: 'Colorist',             en: 'Colorist' }, pace: { hair: 0.85, default: 1.0 } },
  { id: 'noor',   name: 'Noor',   surname: 'Fadil', initials: 'NF', color: 'var(--op-noor)',   role: { it: 'Massaggiatrice',       en: 'Massage therapist' }, pace: { viso: 1.0, default: 1.0 } },
  { id: 'vera',   name: 'Vera',   surname: 'Tosi', initials: 'VT', color: 'var(--op-vera)',   role: { it: 'Make-up artist',       en: 'Make-up artist' }, pace: { extra: 0.9, default: 1.0 } },
  { id: 'ines',   name: 'Inés',   surname: 'Marin', initials: 'IM', color: 'var(--op-ines)',   role: { it: 'Lash & brow',          en: 'Lash & brow' }, pace: { viso: 0.95, default: 1.05 } },
  { id: 'dafne',  name: 'Dafne',  surname: 'Pozzi', initials: 'DP', color: 'var(--op-dafne)',  role: { it: 'Nail artist junior',   en: 'Junior nail artist' }, pace: { nail: 1.2, default: 1.15 } },
];

const CATS = [
  { id: 'nail', name: { it: 'Unghie', en: 'Nails' } },
  { id: 'hair', name: { it: 'Capelli', en: 'Hair' } },
  { id: 'viso', name: { it: 'Viso', en: 'Face' } },
  { id: 'extra', name: { it: 'Extra', en: 'Extra' } },
];

const SERVICES = [
  { id: 's1',  cat: 'nail', name: { it: 'Semipermanente', en: 'Gel polish' },        dur: 60,  price: 35, ops: ['sole','giulia'] },
  { id: 's2',  cat: 'nail', name: { it: 'Ricostruzione gel', en: 'Gel extensions' }, dur: 105, price: 65, ops: ['sole','giulia'] },
  { id: 's3',  cat: 'nail', name: { it: 'Nail art', en: 'Nail art' },                dur: 30,  price: 20, ops: ['sole','giulia'] },
  { id: 's4',  cat: 'nail', name: { it: 'Pedicure estetico', en: 'Spa pedicure' },   dur: 50,  price: 40, ops: ['giulia'] },
  { id: 's5',  cat: 'hair', name: { it: 'Piega', en: 'Blow-dry' },                   dur: 40,  price: 28, ops: ['mara'] },
  { id: 's6',  cat: 'hair', name: { it: 'Taglio', en: 'Cut' },                       dur: 45,  price: 32, ops: ['mara'] },
  { id: 's7',  cat: 'hair', name: { it: 'Colore', en: 'Colour' },                    dur: 120, price: 78, ops: ['asia'] },
  { id: 's8',  cat: 'hair', name: { it: 'Balayage', en: 'Balayage' },                dur: 180, price: 145, ops: ['asia'] },
  { id: 's9',  cat: 'hair', name: { it: 'Trattamento ristrutturante', en: 'Repair treatment' }, dur: 30, price: 25, ops: ['mara','asia'] },
  { id: 's10', cat: 'viso', name: { it: 'Pulizia viso', en: 'Facial cleanse' },      dur: 60,  price: 55, ops: ['lina'] },
  { id: 's11', cat: 'viso', name: { it: 'Trattamento idratante', en: 'Hydra facial' }, dur: 75, price: 80, ops: ['lina'] },
  { id: 's12', cat: 'viso', name: { it: 'Laminazione ciglia', en: 'Lash lift' },     dur: 50,  price: 45, ops: ['lina'] },
  { id: 's13', cat: 'extra', name: { it: 'Manicure express', en: 'Express manicure' }, dur: 25, price: 18, ops: ['sole','giulia'] },
  { id: 's14', cat: 'extra', name: { it: 'Consulenza', en: 'Consultation' },         dur: 20,  price: 0,  ops: ['sole','lina','asia'] },
];

const svc = (id) => SERVICES.find(s => s.id === id);
const op = (id) => OPS.find(o => o.id === id);

// ---- Clients ----
const CLIENTS = [
  { id: 'c1', name: 'Sofia Ricci', initials: 'SR', phone: '+39 348 221 0094', wa: true, origin: { it: 'Instagram', en: 'Instagram' }, segment: 'vip', noshow: 0, latecancel: 1, depositAlways: false, since: '2022', visits: 38, value: 2140, lang: 'it', techType: 'nail',
    consents: { privacy: true, marketing: true, whatsapp: true } },
  { id: 'c2', name: 'Giada Bellini', initials: 'GB', phone: '+39 333 884 1120', wa: true, origin: { it: 'Passaparola', en: 'Word of mouth' }, segment: 'fedele', noshow: 0, latecancel: 0, depositAlways: false, since: '2021', visits: 54, value: 3260, lang: 'it', techType: 'hair',
    consents: { privacy: true, marketing: true, whatsapp: true } },
  { id: 'c3', name: 'Noor Haddad', initials: 'NH', phone: '+39 327 551 9981', wa: true, origin: { it: 'Google', en: 'Google' }, segment: 'nuovo', noshow: 2, latecancel: 1, depositAlways: true, since: '2025', visits: 3, value: 180, lang: 'en', techType: 'nail',
    consents: { privacy: true, marketing: false, whatsapp: true } },
  { id: 'c4', name: 'Elena Conti', initials: 'EC', phone: '+39 340 112 7765', wa: true, origin: { it: 'Instagram', en: 'Instagram' }, segment: 'fedele', noshow: 0, latecancel: 2, depositAlways: false, since: '2023', visits: 21, value: 1490, lang: 'it', techType: 'viso',
    consents: { privacy: true, marketing: true, whatsapp: true } },
  { id: 'c5', name: 'Marta Vinci', initials: 'MV', phone: '+39 351 770 3321', wa: true, origin: { it: 'Passaparola', en: 'Word of mouth' }, segment: 'dormiente', noshow: 1, latecancel: 0, depositAlways: false, since: '2022', visits: 12, value: 820, lang: 'it', techType: 'hair',
    consents: { privacy: true, marketing: true, whatsapp: true } },
  { id: 'c6', name: 'Aisha Diallo', initials: 'AD', phone: '+39 366 209 4410', wa: true, origin: { it: 'Instagram', en: 'Instagram' }, segment: 'fedele', noshow: 0, latecancel: 0, depositAlways: false, since: '2024', visits: 9, value: 640, lang: 'en', techType: 'nail',
    consents: { privacy: true, marketing: true, whatsapp: true } },
  { id: 'c7', name: 'Chiara Greco', initials: 'CG', phone: '+39 339 556 1208', wa: false, origin: { it: 'Sito web', en: 'Website' }, segment: 'nuovo', noshow: 0, latecancel: 0, depositAlways: false, since: '2025', visits: 1, value: 35, lang: 'it', techType: 'nail',
    consents: { privacy: true, marketing: true, whatsapp: false } },
  { id: 'c8', name: 'Valentina Russo', initials: 'VR', phone: '+39 320 447 9932', wa: true, origin: { it: 'Passaparola', en: 'Word of mouth' }, segment: 'vip', noshow: 0, latecancel: 0, depositAlways: false, since: '2020', visits: 71, value: 4980, lang: 'it', techType: 'hair',
    consents: { privacy: true, marketing: true, whatsapp: true } },
  { id: 'c9', name: 'Bianca Lombardi', initials: 'BL', phone: '+39 347 882 1190', wa: true, origin: { it: 'Instagram', en: 'Instagram' }, segment: 'dormiente', noshow: 0, latecancel: 1, depositAlways: false, since: '2023', visits: 7, value: 410, lang: 'it', techType: 'viso',
    consents: { privacy: true, marketing: true, whatsapp: true } },
  { id: 'c10', name: 'Federica Mancini', initials: 'FM', phone: '+39 333 119 2284', wa: true, origin: { it: 'Google', en: 'Google' }, segment: 'fedele', noshow: 0, latecancel: 0, depositAlways: false, since: '2022', visits: 28, value: 1870, lang: 'it', techType: 'nail',
    consents: { privacy: true, marketing: true, whatsapp: true } },
];
const client = (id) => CLIENTS.find(c => c.id === id);

// ---- Today's agenda (minutes from 00:00) ----
const tmin = (h, m) => h * 60 + m;
const APPTS = [
  { id: 'a1', clientId: 'c1', opId: 'sole',   serviceIds: ['s2','s3'], start: tmin(9,30),  status: 'checkin',   deposit: 'paid', note: { it: 'Allergia al nichel — usare smalti hypoallergenic', en: 'Nickel allergy — use hypoallergenic polish' } },
  { id: 'a2', clientId: 'c8', opId: 'asia',   serviceIds: ['s8'],      start: tmin(9,30),  status: 'corso',     deposit: 'paid' },
  { id: 'a3', clientId: 'c4', opId: 'lina',   serviceIds: ['s11'],     start: tmin(10,0),  status: 'confermato',deposit: 'none', note: { it: 'Pelle sensibile, evitare prodotti profumati', en: 'Sensitive skin, avoid fragranced products' } },
  { id: 'a4', clientId: 'c10',opId: 'giulia', serviceIds: ['s1'],      start: tmin(10,30), status: 'arrivo',    deposit: 'none' },
  { id: 'a5', clientId: 'c2', opId: 'mara',   serviceIds: ['s6','s5'], start: tmin(11,0),  status: 'confermato',deposit: 'none', note: { it: 'Vuole mantenere la lunghezza, solo spuntata', en: 'Keep the length, just a trim' } },
  { id: 'a6', clientId: 'c3', opId: 'sole',   serviceIds: ['s1'],      start: tmin(12,0),  status: 'confermato',deposit: 'req' },
  { id: 'a7', clientId: 'c6', opId: 'giulia', serviceIds: ['s4'],      start: tmin(14,0),  status: 'confermato',deposit: 'none' },
  { id: 'a8', clientId: 'c5', opId: 'asia',   serviceIds: ['s7'],      start: tmin(15,30), status: 'confermato',deposit: 'none' },
  { id: 'a9', clientId: 'c9', opId: 'lina',   serviceIds: ['s10'],     start: tmin(16,0),  status: 'confermato',deposit: 'none' },
  { id: 'a10', clientId: 'c7', opId: 'noor',  serviceIds: ['s9'],      start: tmin(9,45),  status: 'confermato',deposit: 'paid' },
  { id: 'a11', clientId: 'c2', opId: 'noor',  serviceIds: ['s10'],     start: tmin(11,30), status: 'confermato',deposit: 'none' },
  { id: 'a12', clientId: 'c5', opId: 'noor',  serviceIds: ['s11'],     start: tmin(15,0),  status: 'confermato',deposit: 'none' },
  { id: 'a13', clientId: 'c1', opId: 'vera',  serviceIds: ['s14'],     start: tmin(10,30), status: 'arrivo',    deposit: 'none' },
  { id: 'a14', clientId: 'c8', opId: 'vera',  serviceIds: ['s12'],     start: tmin(14,30), status: 'confermato',deposit: 'req' },
  { id: 'a15', clientId: 'c4', opId: 'ines',  serviceIds: ['s12'],     start: tmin(9,30),  status: 'corso',     deposit: 'paid' },
  { id: 'a16', clientId: 'c6', opId: 'ines',  serviceIds: ['s12'],     start: tmin(11,0),  status: 'confermato',deposit: 'none' },
  { id: 'a17', clientId: 'c10',opId: 'ines',  serviceIds: ['s14'],     start: tmin(16,30), status: 'confermato',deposit: 'none' },
  { id: 'a18', clientId: 'c3', opId: 'dafne', serviceIds: ['s13'],     start: tmin(10,0),  status: 'confermato',deposit: 'none' },
  { id: 'a19', clientId: 'c9', opId: 'dafne', serviceIds: ['s1'],      start: tmin(12,30), status: 'confermato',deposit: 'none' },
  { id: 'a20', clientId: 'c5', opId: 'dafne', serviceIds: ['s3'],      start: tmin(15,30), status: 'confermato',deposit: 'none' },
];
// duration of a service — depends ONLY on the service, never on the operator.
// (opId arg kept for call-site compatibility but intentionally ignored)
function svcDur(serviceId, opId) {
  const s = svc(serviceId);
  if (!s) return 0;
  return s.dur;
}
function apptEnd(a) { if (a.kind === 'break') return a.start + (a._dur || 60); return a.start + a.serviceIds.reduce((s, id) => s + svcDur(id, a.opId), 0); }
function apptTotal(a) { return a.serviceIds.reduce((s, id) => s + svc(id).price, 0); }

// ---- AI: proactive insights ----
const INSIGHTS = [
  { id: 'i1', kind: 'noshow', sev: 'warn',
    text: { it: 'I no-show sono saliti del 15% questo mese, soprattutto il martedì.', en: 'No-shows rose 15% this month, mostly on Tuesdays.' },
    why: { it: 'Su 9 mancate presenze, 6 erano prime visite del martedì senza deposito.', en: 'Of 9 missed visits, 6 were Tuesday first-visits without a deposit.' },
    action: { it: 'Attiva il deposito per le prime visite del martedì', en: 'Require a deposit for Tuesday first-visits' },
    expected: { it: 'Potresti recuperare ~6 clienti / mese', en: 'You could recover ~6 clients / month' } },
  { id: 'i2', kind: 'fill', sev: 'info',
    text: { it: 'Giovedì pomeriggio è pieno solo al 40%.', en: 'Thursday afternoon is only 40% full.' },
    why: { it: '12 clienti sono "in ritardo" sul ribooking rispetto al loro ritmo abituale.', en: '12 clients are overdue for rebooking vs their usual rhythm.' },
    action: { it: 'Invita i 12 clienti a prenotare giovedì', en: 'Invite the 12 clients to book Thursday' },
    expected: { it: 'Storicamente risponde ~1 su 3', en: 'Historically ~1 in 3 respond' } },
  { id: 'i3', kind: 'service', sev: 'info',
    text: { it: 'Gli smalti semipermanenti sono calati del 6% rispetto a settembre.', en: 'Gel polish is down 6% vs September.' },
    why: { it: 'Il calo è concentrato sulle clienti che non ricevono il promemoria di ribooking.', en: 'The drop is concentrated on clients who get no rebooking reminder.' },
    action: { it: 'Attiva l’automazione di riattivazione smalti', en: 'Turn on the gel-polish win-back automation' },
    expected: { it: '+€430 stimati sul mese', en: '+€430 estimated this month' } },
];

// ---- AI: analyst example questions ----
const ASK_CHIPS = [
  { it: 'Com’è andato il mese rispetto allo scorso?', en: 'How did this month go vs last?' },
  { it: 'Qual è il giorno più scarico?', en: 'Which day is the quietest?' },
  { it: 'Chi sono le mie 5 clienti top?', en: 'Who are my top 5 clients?' },
  { it: 'Come va il colore rispetto al nail?', en: 'How is colour doing vs nails?' },
  { it: 'Scontrino medio di questo mese?', en: 'Average ticket this month?' },
  { it: 'Quante clienti dormienti ho?', en: 'How many dormant clients do I have?' },
  { it: 'Quanto incasso dal retail vs servizi?', en: 'Retail vs service revenue?' },
  { it: 'Quali prodotti sono sottoscorta?', en: 'Which products are low on stock?' },
];

// ---- Stats ----
const STATS = {
  monthRevenue: 18400, monthDelta: 12, prevRevenue: 16430,
  avgTicket: 54, avgDelta: 3,
  clientsMonth: 286, clientsDelta: 8,
  occupancy: 74,
  trend: [12.1, 13.4, 12.9, 14.2, 15.0, 16.4, 15.9, 17.1, 16.8, 18.4], // last 10 (k€)
  byService: [
    { id: 'hair', label: { it: 'Capelli', en: 'Hair' }, val: 8200, delta: 9 },
    { id: 'nail', label: { it: 'Unghie', en: 'Nails' }, val: 6100, delta: -6 },
    { id: 'viso', label: { it: 'Viso', en: 'Face' }, val: 3300, delta: 14 },
    { id: 'extra', label: { it: 'Extra', en: 'Extra' }, val: 800, delta: 4 },
  ],
  weekday: [ // occupancy % Mon..Sat
    { d: { it: 'Lun', en: 'Mon' }, v: 68 }, { d: { it: 'Mar', en: 'Tue' }, v: 41 },
    { d: { it: 'Mer', en: 'Wed' }, v: 72 }, { d: { it: 'Gio', en: 'Thu' }, v: 58 },
    { d: { it: 'Ven', en: 'Fri' }, v: 91 }, { d: { it: 'Sab', en: 'Sat' }, v: 96 },
  ],
  // actionable / retention metrics
  retention: 58, retentionGoal: 70, retentionDelta: 4,
  rebooking: 62, rebookingGoal: 70, rebookingDelta: 5,
  occupancyGoal: 80,
  newClients: 74, returningClients: 212,
  retailRevenue: 3120, retailDelta: 11, retailAttach: 34, // % clients buying a product
  avgGapDays: 38, avgGapDelta: -3, // days between visits
  noShowRate: 6, noShowDelta: -2, cancelRate: 9,
  perStylist: [
    { id: 'mara', revenue: 7120, occ: 88 },
    { id: 'sole', revenue: 6480, occ: 86 },
    { id: 'giulia', revenue: 5240, occ: 79 },
    { id: 'asia', revenue: 4900, occ: 83 },
    { id: 'lina', revenue: 4310, occ: 77 },
  ],
};

// analyst structured reply (for the example question)
const ANALYST_REPLY = {
  number: '€18.400', delta: '+12%',
  spark: STATS.trend,
  interp: {
    it: 'Ottobre ha incassato €18.400, +12% su settembre. Trainano colore e trattamenti viso; gli smalti sono calati del 6%. Il martedì resta il giorno più scarico. Scontrino medio €54 (+3%).',
    en: 'October took €18,400, +12% vs September. Colour and facials lead; gel polish dropped 6%. Tuesday remains the quietest day. Average ticket €54 (+3%).',
  },
  period: { it: 'Periodo: 1–31 ottobre 2025 · confronto con settembre', en: 'Period: 1–31 Oct 2025 · vs September' },
  followups: [
    { it: 'E per operatrice?', en: 'And per stylist?' },
    { it: 'Approfondisci il martedì', en: 'Dig into Tuesday' },
    { it: 'Confronta con l’anno scorso', en: 'Compare to last year' },
  ],
};

// ---- Automations ----
const AUTOMATIONS = [
  { id: 'au1', on: true, icon: 'wave', lastSent: { it: '2 ore fa', en: '2h ago' }, openRate: 82,
    name: { it: 'Benvenuto', en: 'Welcome' }, desc: { it: 'Saluta i nuovi clienti dopo la prima prenotazione', en: 'Greet new clients after first booking' },
    trigger: { it: 'Subito dopo la prima prenotazione', en: 'Right after first booking' }, timing: 'now', segment: 'new', channel: 'whatsapp',
    result: { it: 'Inviato a 14 nuovi clienti', en: 'Sent to 14 new clients' },
    msg: { it: 'Ciao {nome}, benvenuta da The Parlour! Siamo felici di vederti il {data}. A presto 💫', en: 'Hi {name}, welcome to The Parlour! We can’t wait to see you on {date}. See you soon 💫' } },
  { id: 'au2', on: true, icon: 'bell', lastSent: { it: '20 min fa', en: '20 min ago' }, openRate: 91,
    name: { it: 'Promemoria appuntamento', en: 'Appointment reminder' }, desc: { it: 'Ricorda l’appuntamento il giorno prima', en: 'Remind the day before' },
    trigger: { it: '24 ore prima dell’appuntamento', en: '24h before the appointment' }, timing: '10', segment: 'consent', channel: 'whatsapp',
    result: { it: 'No-show ridotti del 31%', en: 'No-shows down 31%' },
    msg: { it: 'Ciao {nome}, ti aspettiamo domani alle {ora} per {servizio}. Rispondi OK per confermare 💛', en: 'Hi {name}, see you tomorrow at {time} for {service}. Reply OK to confirm 💛' } },
  { id: 'au3', on: true, icon: 'star', lastSent: { it: 'ieri', en: 'yesterday' }, openRate: 64,
    name: { it: 'Post-visita & recensione', en: 'Post-visit & review' }, desc: { it: 'Ringrazia e invita a lasciare una recensione', en: 'Thank you + review invite' },
    trigger: { it: '3 ore dopo la visita', en: '3h after the visit' }, timing: 'now', segment: 'consent', channel: 'whatsapp',
    result: { it: '+18 recensioni questo mese', en: '+18 reviews this month' },
    msg: { it: 'Grazie di essere passata, {nome}! Ci faresti felici con una recensione ⭐ {link}', en: 'Thanks for visiting, {name}! A review would make our day ⭐ {link}' } },
  { id: 'au4', on: false, icon: 'cake', lastSent: { it: 'mai', en: 'never' }, openRate: 0,
    name: { it: 'Compleanno', en: 'Birthday' }, desc: { it: 'Auguri + coupon il giorno del compleanno', en: 'Wishes + coupon on birthday' },
    trigger: { it: 'Il giorno del compleanno', en: 'On the birthday' }, timing: '10', segment: 'consent', channel: 'whatsapp',
    result: { it: '—', en: '—' },
    msg: { it: 'Buon compleanno {nome}! 🎉 Per te -20% questa settimana. Ti aspettiamo!', en: 'Happy birthday {name}! 🎉 Enjoy -20% this week. See you soon!' } },
  { id: 'au5', on: false, icon: 'revive', lastSent: { it: 'mai', en: 'never' }, openRate: 0,
    name: { it: 'Riattivazione dormienti', en: 'Win-back dormant' }, desc: { it: 'Riconquista chi non torna da un po’', en: 'Reach clients who haven’t returned' },
    trigger: { it: '90 giorni dopo l’ultima visita', en: '90 days after last visit' }, timing: '10', segment: 'dormant', channel: 'whatsapp',
    result: { it: '—', en: '—' },
    msg: { it: 'Ci manchi, {nome}! Torna a trovarci: il tuo posto è sempre qui ✨', en: 'We miss you, {name}! Come back any time — your seat is waiting ✨' } },
  { id: 'au6', on: true, icon: 'gap', lastSent: { it: '1 ora fa', en: '1h ago' }, openRate: 38,
    name: { it: 'Riempi-buco', en: 'Fill the gap' }, desc: { it: 'Proponi gli slot liberi a clienti vicini', en: 'Offer free slots to nearby clients' },
    trigger: { it: 'Quando si libera uno slot', en: 'When a slot frees up' }, timing: 'now', segment: 'consent', channel: 'whatsapp',
    result: { it: '6 buchi riempiti questo mese', en: '6 gaps filled this month' },
    msg: { it: 'Ciao {nome}, si è liberato uno slot {data} alle {ora}. Lo vuoi? Rispondi SÌ 💫', en: 'Hi {name}, a slot opened {date} at {time}. Want it? Reply YES 💫' } },
];

// ---- Inventory ----
const INV_CATS = [
  { id: 'nail', name: { it: 'Unghie', en: 'Nails' } },
  { id: 'colore', name: { it: 'Colore & capelli', en: 'Colour & hair' } },
  { id: 'viso', name: { it: 'Viso & cura', en: 'Face & care' } },
  { id: 'consumabili', name: { it: 'Consumabili', en: 'Consumables' } },
];
const INVENTORY = [
  { id: 'p1', cat: 'nail', name: { it: 'Smalto gel rosso "Carmine"', en: 'Gel polish red "Carmine"' }, qty: 3, min: 5, unit: { it: 'flaconi', en: 'bottles' }, value: 14, cost: 14, retail: 26, vat: 22, discount: 10, reorderQty: 12, unitQty: '15ml', nature: 'entrambi', sku: 'GEL-RD-001', supplier: 'NailPro', brand: 'OPI' },
  { id: 'p2', cat: 'nail', name: { it: 'Base coat', en: 'Base coat' }, qty: 62, min: 4, unit: { it: 'flaconi', en: 'bottles' }, value: 11, cost: 11, retail: 0, vat: 22, discount: 5, reorderQty: 10, unitQty: '15ml', nature: 'interno', sku: 'NAIL-BC-002', supplier: 'NailPro', brand: 'OPI' },
  { id: 'p3', cat: 'colore', name: { it: 'Tinta 6.0 castano', en: 'Colour 6.0 brown' }, qty: 2, min: 6, unit: { it: 'tubi', en: 'tubes' }, value: 9, cost: 9, retail: 0, vat: 22, discount: 0, reorderQty: 12, unitQty: '100ml', nature: 'interno', sku: 'COL-60-003', supplier: 'Beauty Dist.', brand: "L'Oréal Pro" },
  { id: 'p4', cat: 'colore', name: { it: 'Ossigeno 20 vol', en: 'Developer 20 vol' }, qty: 8, min: 3, unit: { it: 'litri', en: 'litres' }, value: 7, cost: 7, retail: 0, vat: 22, discount: 0, reorderQty: 6, unitQty: '1L', nature: 'interno', sku: 'COL-OX-004', supplier: 'Beauty Dist.', brand: "L'Oréal Pro" },
  { id: 'p5', cat: 'viso', name: { it: 'Maschera ristrutturante', en: 'Repair mask' }, qty: 6, min: 3, unit: { it: 'vasetti', en: 'jars' }, value: 22, cost: 22, retail: 42, vat: 22, discount: 10, reorderQty: 6, unitQty: '200ml', nature: 'entrambi', sku: 'FACE-MK-005', supplier: 'Derma Supply', brand: 'Comfort Zone' },
  { id: 'p6', cat: 'consumabili', name: { it: 'Cotone in dischetti', en: 'Cotton pads' }, qty: 1, min: 4, unit: { it: 'confezioni', en: 'packs' }, value: 4, cost: 4, retail: 0, vat: 22, discount: 0, reorderQty: 10, unitQty: '100pz', nature: 'interno', sku: 'CONS-CT-006', supplier: 'Derma Supply', brand: 'Generic' },
];

// ---- Service editable metadata (deposit + useful salon info) ----
// depositPct = % of price held as deposit. buffer = clean-up/reset minutes after.
// online = bookable from the client web app. patch = patch test / consult required.
const SVC_META = {
  s1:  { depositOn: false, depositPct: 30, online: true,  buffer: 5,  patch: false, active: true,  desc: { it: 'Smalto semipermanente, tenuta fino a 3 settimane.', en: 'Gel polish, lasts up to 3 weeks.' } },
  s2:  { depositOn: true,  depositPct: 30, online: true,  buffer: 10, patch: false, active: true,  desc: { it: 'Ricostruzione in gel su misura, allungamento e rinforzo.', en: 'Custom gel build, extension and reinforcement.' } },
  s3:  { depositOn: false, depositPct: 30, online: true,  buffer: 0,  patch: false, active: true,  desc: { it: 'Decorazioni e finiture artistiche.', en: 'Artistic finishes and decorations.' } },
  s4:  { depositOn: false, depositPct: 30, online: true,  buffer: 10, patch: false, active: true,  desc: { it: 'Pedicure estetico con cura della cuticola.', en: 'Aesthetic pedicure with cuticle care.' } },
  s5:  { depositOn: false, depositPct: 30, online: true,  buffer: 5,  patch: false, active: true,  desc: { it: 'Piega a phon, styling su richiesta.', en: 'Blow-dry styling on request.' } },
  s6:  { depositOn: false, depositPct: 30, online: true,  buffer: 5,  patch: false, active: true,  desc: { it: 'Taglio personalizzato con consulenza.', en: 'Personalised cut with consultation.' } },
  s7:  { depositOn: true,  depositPct: 30, online: true,  buffer: 10, patch: true,  active: true,  desc: { it: 'Colore professionale. Patch test 48h prima per nuove clienti.', en: 'Professional colour. Patch test 48h before for new clients.' } },
  s8:  { depositOn: true,  depositPct: 40, online: false, buffer: 15, patch: true,  active: true,  desc: { it: 'Schiariture a mano libera. Consulenza obbligatoria.', en: 'Freehand lightening. Consultation required.' } },
  s9:  { depositOn: false, depositPct: 30, online: true,  buffer: 5,  patch: false, active: true,  desc: { it: 'Trattamento ristrutturante in cabina.', en: 'In-salon repair treatment.' } },
  s10: { depositOn: false, depositPct: 30, online: true,  buffer: 10, patch: false, active: true,  desc: { it: 'Pulizia viso profonda con estrazione.', en: 'Deep facial cleanse with extraction.' } },
  s11: { depositOn: true,  depositPct: 20, online: true,  buffer: 10, patch: false, active: true,  desc: { it: 'Trattamento idratante intensivo.', en: 'Intensive hydrating treatment.' } },
  s12: { depositOn: false, depositPct: 30, online: true,  buffer: 5,  patch: true,  active: true,  desc: { it: 'Laminazione ciglia, effetto curvatura naturale.', en: 'Lash lift, natural curl effect.' } },
  s13: { depositOn: false, depositPct: 30, online: true,  buffer: 0,  patch: false, active: true,  desc: { it: 'Manicure rapida senza semipermanente.', en: 'Quick manicure without gel.' } },
  s14: { depositOn: false, depositPct: 30, online: true,  buffer: 0,  patch: false, active: true,  desc: { it: 'Consulenza gratuita pre-trattamento.', en: 'Free pre-treatment consultation.' } },
};
function svcMeta(id) { return SVC_META[id] || { depositOn: false, depositPct: 30, online: true, buffer: 0, patch: false, active: true, desc: { it: '', en: '' } }; }

// ---- Retail products (for Registra vendita) ----
const RETAIL = [
  { id: 'pr1', name: { it: 'Smalto a casa', en: 'Take-home polish' }, price: 16 },
  { id: 'pr2', name: { it: 'Olio cuticole', en: 'Cuticle oil' }, price: 12 },
  { id: 'pr3', name: { it: 'Maschera capelli', en: 'Hair mask' }, price: 24 },
  { id: 'pr4', name: { it: 'Shampoo ristrutturante', en: 'Repair shampoo' }, price: 19 },
  { id: 'pr5', name: { it: 'Siero viso', en: 'Face serum' }, price: 38 },
  { id: 'pr6', name: { it: 'Crema mani', en: 'Hand cream' }, price: 14 },
  { id: 'pr7', name: { it: 'Top coat lucidante', en: 'Glossy top coat' }, price: 15 },
  { id: 'pr8', name: { it: 'Spray termoprotettore', en: 'Heat-protect spray' }, price: 17 },
];
// commission % each staff earns on sales (0 = none → hidden). Editable in Settings.
const STAFF_COMMISSION = { sole: 0, mara: 10, lina: 12, giulia: 8, asia: 15, noor: 10, vera: 12, ines: 10, dafne: 6 };
// products sold this month per staff
const STAFF_SOLD = { sole: 24, mara: 18, lina: 9, giulia: 21, asia: 13, noor: 11, vera: 16, ines: 14, dafne: 7 };

// ---- Coupon templates (managed in Coupon & Fedeltà, assignable to clients) ----
const COUPON_TEMPLATES = [
  { id: 'ct1', code: 'BENVENUTA', desc: { it: 'Sconto prima visita', en: 'First-visit discount' }, kind: 'percent', amount: 10, services: [], validity: { it: '60 giorni dall’assegnazione', en: '60 days from assignment' }, active: true, auto: 'new' },
  { id: 'ct2', code: 'GRAZIE20', desc: { it: 'Sconto fedeltà', en: 'Loyalty discount' }, kind: 'percent', amount: 20, services: [], validity: { it: 'Scade 31 dic 2025', en: 'Expires 31 Dec 2025' }, active: true, auto: 'none' },
  { id: 'ct3', code: 'NAILGIFT', desc: { it: 'Nail art in omaggio', en: 'Free nail art' }, kind: 'gift', amount: 0, giftText: { it: 'Nail art', en: 'Nail art' }, services: ['s3'], validity: { it: '90 giorni', en: '90 days' }, active: true, auto: 'none' },
  { id: 'ct4', code: 'TORNADANOI', desc: { it: 'Ti aspettiamo', en: 'Come back to us' }, kind: 'percent', amount: 15, services: [], validity: { it: '30 giorni', en: '30 days' }, active: false, auto: 'dormant' },
  { id: 'ct5', code: 'COMPLEANNO', desc: { it: 'Regalo di compleanno', en: 'Birthday gift' }, kind: 'amount', amount: 15, services: [], validity: { it: 'Valido nel mese del compleanno', en: 'Valid in birthday month' }, active: true, auto: 'birthday' },
  { id: 'ct6', code: 'PUNTI10', desc: { it: 'Buono fedeltà €10', en: '€10 loyalty reward' }, kind: 'amount', amount: 10, services: [], validity: { it: '90 giorni dal riscatto', en: '90 days from redemption' }, active: true, auto: 'loyalty', program: 'lp1' },
];

// ---- Gift card (denaro prepagato: incassato in anticipo, da monitorare fino al riscatto) ----
const GIFT_CARDS = [
  { id: 'gc1', code: 'TP-GC-7K2F', value: 100, used: 0, buyerId: 'c2', recipId: null, recipName: 'Marta Ricci',
    payment: { status: 'paid', date: { it: '2 nov 2025', en: '2 Nov 2025' }, method: { it: 'Carta', en: 'Card' } },
    delivery: { mode: 'scheduled', when: { it: 'Sab 23 nov · 08:00 · compleanno', en: 'Sat 23 Nov · 08:00 · birthday' } },
    expiry: { it: '2 mag 2026', en: '2 May 2026' }, status: 'active' },
  { id: 'gc2', code: 'TP-GC-3N9Q', value: 50, used: 32, buyerId: 'c5', recipId: 'c7', recipName: null,
    payment: { status: 'paid', date: { it: '28 ott 2025', en: '28 Oct 2025' }, method: { it: 'Contanti', en: 'Cash' } },
    delivery: { mode: 'hand' },
    expiry: { it: '28 apr 2026', en: '28 Apr 2026' }, status: 'active' },
  { id: 'gc3', code: 'TP-GC-5D1A', value: 75, used: 0, buyerId: 'c1', recipId: null, recipName: 'Elena Bardi',
    payment: { status: 'due' },
    delivery: { mode: 'hand' },
    expiry: { it: '6 mesi dal pagamento', en: '6 months from payment' }, status: 'active' },
  { id: 'gc4', code: 'TP-GC-9X4T', value: 60, used: 60, buyerId: 'c3', recipId: 'c9', recipName: null,
    payment: { status: 'paid', date: { it: '12 set 2025', en: '12 Sep 2025' }, method: { it: 'Carta', en: 'Card' } },
    delivery: { mode: 'hand' },
    expiry: { it: '12 mar 2026', en: '12 Mar 2026' }, status: 'redeemed', redeemedOn: { it: '30 ott 2025', en: '30 Oct 2025' } },
];
// ---- Loyalty programs ----
const LOYALTY_PROGRAMS = [
  { id: 'lp1', name: { it: 'Raccolta punti', en: 'Points collection' }, type: 'points', active: true,
    earn: 1, earnPer: 1, threshold: 200, reward: { it: 'Buono da €10', en: '€10 coupon' }, audTags: [], audClients: [],
    desc: { it: '1 punto ogni €1 speso. A 200 punti, buono da €10.', en: '1 point per €1 spent. At 200 points, a €10 coupon.' } },
  { id: 'lp2', name: { it: 'Tessera timbri manicure', en: 'Manicure stamp card' }, type: 'stamps', active: true,
    earn: 1, threshold: 10, reward: { it: 'Manicure in omaggio', en: 'Free manicure' }, audTags: ['vip', 'fedele'], audClients: ['c4'],
    desc: { it: '1 timbro per ogni manicure. La 10ª è gratis.', en: '1 stamp per manicure. The 10th is free.' } },
];
// per-client loyalty progress (demo)
const CLIENT_LOYALTY = {
  c1: { lp1: 320, lp2: 7 }, c2: { lp1: 540, lp2: 3 }, c8: { lp1: 980, lp2: 9 },
  c4: { lp1: 210, lp2: 2 }, c10: { lp1: 410, lp2: 5 },
};
function clientLoyalty(id) { return CLIENT_LOYALTY[id] || { lp1: Math.round((id.charCodeAt(1) || 3) * 23), lp2: (id.charCodeAt(1) || 3) % 10 }; }

// ---- Lista d'attesa (slot cancellati → riempimento automatico) ----
const WAITING_LIST = [
  { id: 'w1', clientId: 'c3',  serviceIds: ['s1'],       opId: null,   prefDays: ['lun','mer','ven'], prefTime: 'morning', note: '', added: { it: '8 nov', en: '8 Nov' } },
  { id: 'w2', clientId: 'c6',  serviceIds: ['s2','s3'],  opId: 'sole', prefDays: ['sab'],            prefTime: 'any',     note: 'Solo mattina presto', added: { it: '10 nov', en: '10 Nov' } },
  { id: 'w3', clientId: 'c10', serviceIds: ['s5'],       opId: null,   prefDays: ['mar','gio'],       prefTime: 'afternoon', note: '', added: { it: '11 nov', en: '11 Nov' } },
  { id: 'w4', clientId: 'c9',  serviceIds: ['s7','s8'],  opId: 'asia', prefDays: ['ven'],             prefTime: 'any',     note: 'Disponibile da venerdì pomeriggio', added: { it: '12 nov', en: '12 Nov' } },
];
const PACKAGES = [
  { id: 'pk1', name: { it: 'Pacchetto Sposa', en: 'Bridal package' }, occasion: { it: 'Matrimoni', en: 'Weddings' },
    serviceIds: ['s8', 's5', 's2', 's10'], price: 249, depositPct: 30, active: true,
    period: { it: 'Su prenotazione', en: 'By appointment' }, desc: { it: 'Il percorso completo bellezza per il giorno sì.', en: 'The full beauty journey for the big day.' } },
  { id: 'pk2', name: { it: 'Beauty Day', en: 'Beauty Day' }, occasion: { it: 'Relax', en: 'Relax' },
    serviceIds: ['s1', 's4', 's10'], price: 99, depositPct: 25, active: true,
    period: { it: 'Tutto l’anno', en: 'All year' }, desc: { it: 'Mani, piedi e viso in un’unica seduta.', en: 'Hands, feet and face in one sitting.' } },
  { id: 'pk3', name: { it: 'Pacchetto 5 Manicure', en: '5-Manicure pack' }, occasion: { it: 'Fidelizzazione', en: 'Loyalty' },
    serviceIds: ['s1', 's1', 's1', 's1', 's1'], price: 149, depositPct: 20, active: true,
    period: { it: 'Valido 6 mesi', en: 'Valid 6 months' }, desc: { it: 'Cinque semipermanenti, paghi come quattro.', en: 'Five gel manicures, pay for four.' } },
  { id: 'pk4', name: { it: 'Black Friday Colore', en: 'Black Friday Colour' }, occasion: { it: 'Black Friday', en: 'Black Friday' },
    serviceIds: ['s7', 's6', 's9'], price: 99, depositPct: 30, active: false,
    period: { it: '22–30 nov', en: '22–30 Nov' }, desc: { it: 'Colore, taglio e trattamento a prezzo speciale.', en: 'Colour, cut and treatment at a special price.' } },
];
function pkgOriginal(p) { return p.serviceIds.reduce((s, id) => s + (svc(id) ? svc(id).price : 0), 0); }

// ---- Client (Sofia) wallet for The Parlour app ----
const CLIENT_BOOKING = {
  clientName: 'Sofia',
  service: { it: 'Ricostruzione gel + Nail art', en: 'Gel extensions + Nail art' },
  op: 'Sole', date: { it: 'Giovedì 14 novembre', en: 'Thursday 14 November' }, time: '15:30', dur: 135,
  deposit: 20,
  rel: { it: 'Tra 2 giorni', en: 'In 2 days' },
};
// upcoming (oltre al prossimo) + storico per "Le tue prenotazioni"
const CLIENT_HISTORY = {
  upcoming: [
    { service: { it: 'Manicure semipermanente', en: 'Gel manicure' }, op: 'Lina', date: { it: 'Sab 30 novembre', en: 'Sat 30 November' }, time: '11:00', dur: 60, status: 'confermato' },
  ],
  past: [
    { service: { it: 'Piega + styling', en: 'Blow-dry + styling' }, op: 'Giulia', date: { it: 'Gio 24 ottobre', en: 'Thu 24 October' }, time: '16:30', dur: 45, status: 'completato' },
    { service: { it: 'Ricostruzione gel', en: 'Gel extensions' }, op: 'Sole', date: { it: 'Sab 5 ottobre', en: 'Sat 5 October' }, time: '10:00', dur: 120, status: 'completato' },
    { service: { it: 'Trattamento viso', en: 'Facial treatment' }, op: 'Asia', date: { it: 'Mer 18 settembre', en: 'Wed 18 September' }, time: '15:00', dur: 60, status: 'annullato' },
  ],
};
const CLIENT_SLOTS = [
  { day: { it: 'Mer 13 nov', en: 'Wed 13 Nov' }, times: ['10:00', '14:30'] },
  { day: { it: 'Gio 14 nov', en: 'Thu 14 Nov' }, times: ['11:00', '15:30', '17:00'] },
  { day: { it: 'Ven 15 nov', en: 'Fri 15 Nov' }, times: ['09:30', '16:00'] },
];
const CLIENT_WALLET = {
  coupons: [
    { id: 'cp1', title: { it: '-20% sul prossimo colore', en: '-20% on your next colour' }, sub: { it: 'Scade il 30 nov', en: 'Expires 30 Nov' }, kind: 'percent' },
    { id: 'cp2', title: { it: 'Nail art in omaggio', en: 'Free nail art' }, sub: { it: 'Cliente fedele · 1 disponibile', en: 'Loyalty · 1 available' }, kind: 'gift' },
  ],
  giftcard: 40,
  packages: [{ name: { it: 'Pacchetto 5 manicure', en: '5-manicure pack' }, left: 2, total: 5 }],
  points: 320,
};
// gift card prepagate della cliente (saldo residuo, codice, scadenza)
const CLIENT_GIFTCARDS = [
  { id: 'gc1', code: 'TP-GC-8842', value: 100, balance: 40, from: { it: 'Regalo di Marta V.', en: 'Gift from Marta V.' }, expiry: { it: 'Scade 12 dic 2026', en: 'Expires 12 Dec 2026' } },
  { id: 'gc2', code: 'TP-GC-2199', value: 50, balance: 50, from: { it: 'Acquistata da te', en: 'Bought by you' }, expiry: { it: 'Scade 3 mar 2027', en: 'Expires 3 Mar 2027' } },
];
// lista d'attesa della cliente (richieste attive) + preset
const CLIENT_WAITLIST = [
  { id: 'wl1', service: { it: 'Balayage', en: 'Balayage' }, op: { it: 'Qualsiasi operatrice', en: 'Any stylist' }, pref: { it: 'Sabato mattina', en: 'Saturday morning' }, since: { it: 'da 2 giorni', en: '2 days ago' } },
];

Object.assign(window, {
  OPS, CATS, SERVICES, CLIENTS, APPTS, INSIGHTS, ASK_CHIPS, STATS, ANALYST_REPLY,
  AUTOMATIONS, INVENTORY, INV_CATS, CLIENT_BOOKING, CLIENT_HISTORY, CLIENT_SLOTS, CLIENT_WALLET, CLIENT_GIFTCARDS, CLIENT_WAITLIST,
  svc, op, client, apptEnd, apptTotal, svcDur, svcMeta, pkgOriginal, SVC_META, PACKAGES, RETAIL, STAFF_COMMISSION, STAFF_SOLD, COUPON_TEMPLATES, LOYALTY_PROGRAMS, GIFT_CARDS, WAITING_LIST, clientLoyalty, tmin,
});
