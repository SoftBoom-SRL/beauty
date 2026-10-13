// importVisits.js — logica pura dell'import degli appuntamenti da un altro
// gestionale (nessun React): colonne, orari e durate, abbinamento di servizi e
// operatrici a quelli del salone, righe del file → visite da mandare al server.
// Codifica e parsing del CSV sono quelli dell'import clienti (importCsv.js).
import { isoAtMin, todayStr } from '@youty/shared';
import { parseFlexibleDate, splitFullName } from '../../clienti/importCsv.js';

/* ---------- campi e riconoscimento ---------- */
export const FIELDS = (t) => ([
  { k: 'ignore', label: t('— ignora —', '— ignore —') },
  { k: 'date', label: t('Data', 'Date') },
  { k: 'time', label: t('Ora di inizio', 'Start time') },
  { k: 'duration', label: t('Durata', 'Duration') },
  { k: 'service', label: t('Servizio', 'Service') },
  { k: 'operator', label: t('Operatrice', 'Staff member') },
  { k: 'full_name', label: t('Cliente: nome e cognome', 'Client: first and last name') },
  { k: 'full_name_rev', label: t('Cliente: cognome e nome', 'Client: last and first name') },
  { k: 'first_name', label: t('Cliente: nome', 'Client: first name') },
  { k: 'last_name', label: t('Cliente: cognome', 'Client: last name') },
  { k: 'phone', label: t('Telefono', 'Phone') },
  { k: 'email', label: 'Email' },
  { k: 'price', label: t('Prezzo', 'Price') },
  { k: 'note', label: t('Note', 'Notes') },
]);

/* Senza questi non c'è un appuntamento da scrivere. */
export const REQUIRED = ['date', 'time', 'duration', 'service', 'operator'];

/* Ordine = priorità: «Nome cliente» è il nominativo, non il nome. */
const SYN = {
  full_name_rev: ['cognome e nome', 'cognome nome', 'nominativo'],
  full_name: ['cliente', 'nome cliente', 'nome e cognome', 'nome completo', 'client', 'customer', 'client name', 'customer name', 'full name'],
  first_name: ['nome', 'first name'],
  last_name: ['cognome', 'last name', 'surname'],
  date: ['data', 'data appuntamento', 'giorno', 'date', 'day'],
  time: ['ora', 'orario', 'ora inizio', 'ora di inizio', 'inizio', 'time', 'start', 'start time'],
  duration: ['durata', 'duration', 'minuti', 'minutes'],
  service: ['servizio', 'servizi', 'trattamento', 'prestazione', 'service', 'treatment'],
  operator: ['operatrice', 'operatore', 'collaboratore', 'collaboratrice', 'dipendente', 'professionista', 'staff', 'employee', 'team member'],
  phone: ['telefono', 'tel', 'cellulare', 'cell', 'mobile', 'phone'],
  email: ['email', 'e-mail', 'mail'],
  price: ['prezzo', 'importo', 'costo', 'totale', 'price', 'amount', 'total'],
  note: ['note', 'nota', 'notes', 'commento', 'commenti'],
};
/* «Durata (h)», «Prezzo (€)»: l'unità fra parentesi non fa parte del titolo. */
const normHeader = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[_\-.:]/g, ' ').replace(/\s+/g, ' ').trim();

export function looksLikeHeader(row) {
  return guessMapping(row).some((k) => k !== 'ignore');
}

/** Mappatura iniziale colonna → campo, dai soli titoli. Prima il titolo
 *  esatto, poi quello che contiene il sinonimo come parola intera: «nome» sta
 *  dentro «cognome», e «ora» dentro «collaboratore». */
export function guessMapping(header) {
  const heads = (header || []).map(normHeader);
  const map = heads.map(() => 'ignore');
  const taken = new Set();
  const assign = (test) => {
    for (const [k, list] of Object.entries(SYN)) {
      if (taken.has(k)) continue;
      const i = heads.findIndex((h, idx) => map[idx] === 'ignore' && h && list.some((w) => test(h, w)));
      if (i >= 0) { map[i] = k; taken.add(k); }
    }
  };
  assign((h, w) => h === w);
  assign((h, w) => ` ${h} `.includes(` ${w} `));
  return map;
}

/* ---------- orari, durate, prezzi ---------- */
/** «09:00», «9.30», «9h30» → minuti da mezzanotte; null se non è un orario. */
export function parseTime(raw) {
  const m = /^(\d{1,2})[:.h](\d{2})(?::\d{2})?$/.exec(String(raw || '').trim().toLowerCase());
  if (!m) return null;
  const h = +m[1], min = +m[2];
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/* «13/10/2026 09:00» in una colonna sola: la data, e l'ora se c'è. */
const splitDateTime = (raw) => {
  const m = /^(\S+)[ t]+(\d{1,2}[:.h]\d{2}(?::\d{2})?)$/i.exec(String(raw || '').trim());
  return m ? [m[1], m[2]] : [String(raw || '').trim(), ''];
};

export const DURATION_UNITS = (t) => ([
  { k: 'hm', label: t('ore,minuti · 1,30 = 1 h 30', 'hours,minutes · 1,30 = 1 h 30') },
  { k: 'dec', label: t('ore decimali · 1,5 = 1 h 30', 'decimal hours · 1.5 = 1 h 30') },
  { k: 'min', label: t('minuti · 90', 'minutes · 90') },
]);

/* Una visita non dura più di dodici ore (il tetto del server): «90» letto come
 * ore,minuti sarebbero novanta ore, ed è un file in minuti. */
const sane = (min) => (min >= 1 && min <= 12 * 60 ? min : null);

/** Durata → minuti, null se non si legge. `unit` vale per i numeri con la
 *  virgola: Treatwell scrive «0,45» per quarantacinque minuti (ore,minuti),
 *  altri «0,75» (ore decimali). «1:30» e «1h30» sono sempre ore e minuti. */
export function parseDuration(raw, unit = 'hm') {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  let m = /^(\d{1,2})(?::|h|ore?)(\d{1,2})?(?:m|min)?$/.exec(s);
  if (m) return m[2] && +m[2] >= 60 ? null : sane((+m[1]) * 60 + (+m[2] || 0));
  m = /^(\d{1,3})(?:m|min|minuti)?$/.exec(s);
  if (m && (unit === 'min' || /m/.test(s))) return sane(+m[1]);
  m = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m || unit === 'min') return null;
  if (unit === 'dec') return sane(Math.round(Number(`${m[1]}.${m[2] || 0}`) * 60));
  if (m[2] && (m[2].length !== 2 || +m[2] >= 60)) return null;   // «1,5» o «0,75» non sono ore,minuti
  return sane((+m[1]) * 60 + (+m[2] || 0));
}

/** L'unità più probabile per la colonna: numeri interi → minuti; una virgola
 *  seguita da una cifra sola o da 60 e più → ore decimali; altrimenti
 *  ore,minuti. «0,50» resta ambiguo: lo decide chi importa, che al passo di
 *  verifica vede i minuti. */
export function guessDurationUnit(values) {
  const vals = values.map((v) => String(v || '').trim()).filter(Boolean);
  if (vals.length && vals.every((v) => /^\d+$/.test(v)) && vals.some((v) => +v >= 10)) return 'min';
  const frac = vals.map((v) => /^\d+[.,](\d+)$/.exec(v)?.[1]).filter(Boolean);
  return frac.some((f) => f.length !== 2 || +f >= 60) ? 'dec' : 'hm';
}

/** «36,00», «€ 36.00», «1.250,00» → '36.00' (testo: i soldi non passano da float
 *  fino al server); null se vuoto o illeggibile. */
export function parsePrice(raw) {
  let s = String(raw || '').replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [units, cents = ''] = s.split('.');
  return `${+units}.${cents.padEnd(2, '0')}`;
}

const looksEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

/** Applica la mappatura → una riga per servizio, con gli avvisi.
 *  `_skip`: la riga non può diventare un appuntamento (data, ora, durata,
 *  servizio od operatrice mancanti, cliente senza nome né telefono, giorno
 *  già passato). `today` è «oggi» del salone. */
export function buildRows(dataRows, mapping, { dateOrder = 'dmy', durationUnit = 'hm', lines = null, today = todayStr() } = {}) {
  return dataRows.map((cells, idx) => {
    const r = { date: '', startMin: null, durationMin: null, service: '', operator: '', first_name: '', last_name: '', phone: '', email: '', price: null, note: '' };
    const warn = [];
    let full = '', rev = '', time = '';
    mapping.forEach((k, i) => {
      const v = String(cells[i] ?? '').trim();
      if (!v || k === 'ignore') return;
      if (k === 'full_name') full = v;
      else if (k === 'full_name_rev') rev = v;
      else if (k === 'date') {
        const [d, hm] = splitDateTime(v);
        const iso = parseFlexibleDate(d, dateOrder);
        if (iso && !iso.startsWith('--')) r.date = iso; else warn.push('date:' + v);
        time = time || hm;
      }
      else if (k === 'time') time = v;
      else if (k === 'duration') { r.durationMin = parseDuration(v, durationUnit); if (!r.durationMin) warn.push('duration:' + v); }
      else if (k === 'price') { r.price = parsePrice(v); if (!r.price) warn.push('price:' + v); }
      else if (k === 'email') { if (looksEmail(v)) r.email = v; }
      else if (k === 'note') r.note = r.note ? r.note + '\n' + v : v;
      else r[k] = v;
    });
    if (time) { r.startMin = parseTime(time); if (r.startMin == null) warn.push('time:' + time); }
    const whole = full || rev;
    if (whole && !r.first_name) {
      const { first, last } = splitFullName(whole, !full);
      r.first_name = first; r.last_name = r.last_name || last;
    }
    const missing = ['date', 'startMin', 'durationMin', 'service', 'operator'].filter((k) => r[k] == null || r[k] === '');
    if (!r.first_name && !r.phone) missing.push('client');
    if (missing.length) warn.push('missing:' + missing.join(','));
    const past = r.date && r.date < today;
    if (past) warn.push('past');
    return { ...r, _idx: idx, _line: lines ? lines[idx] : idx + 1, _warn: warn, _skip: missing.length > 0 || !!past };
  });
}

/* ---------- abbinamento a listino e staff ---------- */
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘ʼ`´]/g, "'").toLowerCase().replace(/\s+/g, ' ').trim();

/** I nomi distinti di una colonna (`key` = 'service' | 'operator') nelle righe
 *  importabili, dal più frequente: [{ name, count }]. */
export function distinctNames(rows, key) {
  const counts = new Map();
  rows.forEach((r) => { if (!r._skip) counts.set(r[key], (counts.get(r[key]) || 0) + 1); });
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export const serviceOptions = (services, lang) => (services || []).filter((s) => s.active !== false).map((s) => ({
  id: s.id, label: (lang === 'en' && s.name_en) || s.name_it || s.name_en || '', aliases: [s.name_it, s.name_en],
}));
export const operatorOptions = (operators) => (operators || []).filter((o) => o.active !== false).map((o) => ({
  id: o.id, label: `${o.first_name || ''} ${o.last_name || ''}`.trim(),
  aliases: [`${o.first_name} ${o.last_name}`, `${o.last_name} ${o.first_name}`, o.first_name],
}));

/** Nome del file → id del salone quando il nome coincide con UNA sola voce
 *  (maiuscole e accenti a parte); gli altri restano da scegliere a mano (null):
 *  indovinare «Pedicure» fra «Pedicure curativo» e «Pedicure estetico»
 *  metterebbe in agenda il servizio sbagliato senza che nessuno lo veda. */
export function matchNames(names, options) {
  const out = {};
  names.forEach(({ name }) => {
    const hits = options.filter((o) => o.aliases.some((a) => a && fold(a) === fold(name)));
    out[name] = hits.length === 1 ? hits[0].id : null;
  });
  return out;
}

/* ---------- righe → visite ---------- */
const MAX_ITEMS = 12;   // MAX_ITEMS_PER_REQUEST del server
const clientKey = (r) => r.phone.replace(/\D/g, '') || fold(`${r.first_name} ${r.last_name}`);

/** Le righe abbinate → visite da inviare, nell'ordine del file.
 *  Un file ha una riga per servizio: quelle della stessa cliente, nello stesso
 *  giorno, che cominciano dove finisce la precedente sono UNA visita con più
 *  servizi (una cassa sola). Due servizi che si sovrappongono o con un buco
 *  in mezzo restano visite separate: una visita è una catena senza salti.
 *  `excluded` = righe lasciate fuori perché il loro servizio o la loro
 *  operatrice non sono stati abbinati. */
export function groupVisits(rows, serviceMap, operatorMap) {
  const ready = rows.filter((r) => !r._skip);
  const mapped = ready.filter((r) => serviceMap[r.service] && operatorMap[r.operator]);
  const sorted = [...mapped].sort((a, b) => clientKey(a).localeCompare(clientKey(b)) || a.date.localeCompare(b.date) || a.startMin - b.startMin || a._idx - b._idx);
  const visits = [];
  let last = null, lastEnd = 0;
  sorted.forEach((r) => {
    const item = { service_id: serviceMap[r.service], operator_id: operatorMap[r.operator], duration_min: r.durationMin, price: r.price };
    const chained = last && clientKey(r) === last._key && r.date === last._date && r.startMin === lastEnd && last.items.length < MAX_ITEMS;
    if (chained) {
      last.items.push(item); last._rows.push(r);
      if (r.note && !last.note.split('\n').includes(r.note)) last.note = last.note ? `${last.note}\n${r.note}` : r.note;
    } else {
      last = {
        first_name: r.first_name, last_name: r.last_name, phone: r.phone, email: r.email,
        start: isoAtMin(r.date, r.startMin), note: r.note, items: [item],
        _key: clientKey(r), _date: r.date, _startMin: r.startMin, _line: r._line, _rows: [r],
      };
      visits.push(last);
    }
    lastEnd = r.startMin + r.durationMin;
  });
  visits.sort((a, b) => a._line - b._line);
  return { visits, excluded: ready.length - mapped.length };
}

/** La visita com'è nel corpo della richiesta: senza i campi di lavoro (`_…`). */
export const visitPayload = (v) => Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')));
