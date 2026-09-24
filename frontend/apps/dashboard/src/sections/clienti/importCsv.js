// importCsv.js — logica pura dell'import clienti da CSV/TSV (nessun React):
// codifica, parsing, riconoscimento delle colonne, normalizzazione delle righe.
// Stava dentro BulkImportModal.jsx, dove `npm test` non poteva provarla.
import { todayStr } from '@youty/shared';

/* ---------- codifica ----------
 * Un CSV salvato da Excel italiano è in Windows-1252: letto come UTF-8 ogni
 * «à» diventava «�». La scelta della codifica e l'avviso vivevano solo nel
 * passo 1, che caricando un file si salta: nomi e note entravano rovinati
 * senza una parola (14-08). Ora «automatica» prova UTF-8 in modo rigoroso e,
 * se il file non lo è, lo rilegge come Windows-1252. */

/** byte del file → { text, encoding } (encoding = quella usata davvero). */
export function decodeCsvBytes(bytes, enc = 'auto') {
  if (enc && enc !== 'auto') return { text: new TextDecoder(enc).decode(bytes), encoding: enc };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

/** Accenti rovinati: UTF-8 letto come Windows-1252 («Ã¨») o caratteri persi («�»). */
export const looksMojibake = (text) => /[ÃÂ][\x80-\xBF]|�/.test(text || '');

/* ---------- parsing ---------- */
const DELIMS = [',', ';', '\t', '|'];
export function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 8);
  let best = ',', bestScore = -1;
  DELIMS.forEach((d) => {
    const counts = lines.map((l) => (l.split(d).length - 1));
    const min = Math.min(...counts), avg = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);
    const score = min > 0 ? avg + min * 2 : 0;
    if (score > bestScore) { bestScore = score; best = d; }
  });
  return best;
}

/** RFC 4180: virgolette, delimitatori dentro le virgolette, CRLF.
 *  → [{ cells: string[], line }] senza le righe vuote. `line` è il numero della
 *  riga nel FILE (1 = la prima, intestazione compresa, righe vuote comprese):
 *  quella che si ritrova aprendolo in Excel. Contare le sole righe di dati
 *  mandava a cercare «Riga 12» dove il file aveva la 14 (14-17). */
export function parseCsvLines(text, delim) {
  const out = []; let row = []; let cell = ''; let q = false; let line = 1;
  const s = text.replace(/^\uFEFF/, '');
  const push = () => { row.push(cell); out.push({ cells: row.map((c) => c.trim()), line }); row = []; cell = ''; line += 1; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      push();
    } else cell += ch;
  }
  if (cell !== '' || row.length) push();
  return out.filter((r) => r.cells.some((c) => c));
}

/* ---------- campi e riconoscimento ---------- */
export const FIELDS = (t) => ([
  { k: 'ignore', label: t('— ignora —', '— ignore —') },
  { k: 'full_name', label: t('Nome e cognome', 'First and last name') },
  // «ROSSI MARIA»: molti gestionali scrivono il cognome per primo. Senza un
  // campo a sé «Cognome e nome» finiva tutto nel nome, e «Nominativo»
  // diventava nome ROSSI e cognome MARIA (14-16).
  { k: 'full_name_rev', label: t('Cognome e nome', 'Last and first name') },
  { k: 'first_name', label: t('Nome', 'First name') },
  { k: 'last_name', label: t('Cognome', 'Last name') },
  { k: 'phone', label: t('Telefono', 'Phone') },
  { k: 'email', label: 'Email' },
  { k: 'gender', label: t('Genere', 'Gender') },
  { k: 'birthday', label: t('Compleanno / data di nascita', 'Birthday / date of birth') },
  // «Cliente dal» del gestionale di provenienza: senza, tutta la rubrica
  // storica risultava cliente da oggi (06-07, lato server in ImportRowIn).
  { k: 'since', label: t('Cliente dal', 'Client since') },
  { k: 'categories', label: t('Etichette', 'Labels') },
  { k: 'origin', label: t('Come ci ha conosciuto', 'Source') },
  { k: 'lang', label: t('Lingua', 'Language') },
  { k: 'note', label: t('Note', 'Notes') },
]);
/* Ordine = priorità quando un titolo contiene più sinonimi: «Cognome e nome
 * cliente» è un nominativo al contrario, non un «nome» né un «cliente». */
const SYN = {
  full_name_rev: ['cognome e nome', 'cognome nome', 'cognome/nome', 'cognome, nome', 'nominativo', 'surname and name', 'surname name', 'last name first name', 'last name, first name'],
  full_name: ['nome completo', 'nome e cognome', 'nome cognome', 'nome/cognome', 'cliente', 'client', 'full name', 'fullname', 'name', 'ragione sociale', 'contatto', 'contact'],
  first_name: ['nome', 'first name', 'firstname', 'first_name', 'given name', 'given'],
  last_name: ['cognome', 'surname', 'last name', 'lastname', 'last_name', 'family name'],
  phone: ['telefono', 'tel', 'tel.', 'cell', 'cellulare', 'mobile', 'phone', 'whatsapp', 'numero', 'number', 'recapito'],
  email: ['email', 'e-mail', 'mail', 'posta'],
  gender: ['genere', 'sesso', 'gender', 'sex'],
  birthday: ['compleanno', 'nascita', 'data di nascita', 'data nascita', 'birthday', 'birth', 'dob', 'born', 'birthdate', 'nato il', 'nata il'],
  since: ['cliente dal', 'cliente da', 'data inserimento', 'data di inserimento', 'inserito il', 'inserita il', 'data iscrizione', 'iscritto il', 'iscritta il', 'data registrazione', 'registrato il', 'registrata il', 'data creazione', 'prima visita', 'client since', 'customer since', 'since', 'date added', 'first visit'],
  categories: ['etichette', 'etichetta', 'tag', 'tags', 'categoria', 'categorie', 'labels', 'label', 'gruppo', 'gruppi', 'segmento'],
  origin: ['origine', 'fonte', 'provenienza', 'source', 'origin', 'come ci ha conosciuto', 'canale'],
  lang: ['lingua', 'language', 'lang', 'idioma'],
  note: ['note', 'notes', 'nota', 'commenti', 'commento', 'osservazioni', 'annotazioni', 'memo'],
};
const norm = (s) => String(s || '').toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
export function guessFieldByHeader(header) {
  const h = norm(header);
  if (!h) return 'ignore';
  // "nome" da solo è ambiguo: se c'è anche "cognome" lo decide guessMapping
  for (const [k, list] of Object.entries(SYN)) if (list.some((w) => h === w)) return k;
  for (const [k, list] of Object.entries(SYN)) if (list.some((w) => h.includes(w))) return k;
  return 'ignore';
}

/* Un numero di telefono, non un codice o una data qualsiasi fatta di cifre:
 * internazionale (+/00), cellulare italiano (3…), fisso col distretto (0…),
 * oppure internazionale scritto senza «+». Con «almeno 8 cifre» una colonna
 * «Data inserimento» (gg/mm/aaaa) o un «Codice» a 8 cifre diventavano il
 * telefono (14-07). */
const looksPhone = (v) => {
  const s = String(v || '').trim().replace(/[\s./()-]/g, '');
  if (!/^\+?\d+$/.test(s) || looksDate(v)) return false;
  return /^(\+|00)[1-9]\d{6,14}$/.test(s) || /^3\d{8,9}$/.test(s) || /^0[1-9]\d{4,9}$/.test(s) || /^[1-9]\d{10,14}$/.test(s);
};
const looksEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || '').trim());
const looksDate = (v) => !!parseFlexibleDate(String(v || ''), 'dmy');
export function guessFieldByContent(values) {
  const vals = values.filter((v) => String(v || '').trim()).slice(0, 30);
  if (!vals.length) return 'ignore';
  const share = (fn) => vals.filter(fn).length / vals.length;
  if (share(looksEmail) > 0.6) return 'email';
  if (share(looksPhone) > 0.6) return 'phone';
  if (share(looksDate) > 0.6) return 'birthday';
  if (share((v) => !!parseGender(v)) > 0.8) return 'gender';
  return 'text';
}
export function looksLikeHeader(row) {
  return row.some((c) => guessFieldByHeader(c) !== 'ignore') && !row.some((c) => looksPhone(c) || looksEmail(c));
}

const MULTI = new Set(['ignore', 'categories', 'note']);   // campi che più colonne possono riempire

/** mappatura iniziale colonna → campo.
 *  Prima i titoli riconosciuti, poi il contenuto e solo per i campi rimasti
 *  liberi: col «primo che arriva» la colonna indovinata dal contenuto rubava
 *  il campo a quella col titolo giusto — «Data inserimento» prima di
 *  «Cellulare» e i telefoni diventavano date; «Ultima visita» prima di «Data
 *  di nascita» e i compleanni diventavano ultime visite (14-07). */
export function guessMapping(header, rows) {
  const n = Math.max(header?.length || 0, ...rows.map((r) => r.length), 0);
  const map = [];
  const taken = new Set();
  // 1) titoli riconosciuti: un campo va alla prima colonna che lo nomina
  for (let i = 0; i < n; i++) {
    let k = header ? guessFieldByHeader(header[i]) : 'ignore';
    if (!MULTI.has(k)) { if (taken.has(k)) k = 'ignore'; else taken.add(k); }
    map.push(k);
  }
  // 2) contenuto, per le colonne senza un titolo riconosciuto
  for (let i = 0; i < n; i++) {
    if (map[i] !== 'ignore' || (header && guessFieldByHeader(header[i]) !== 'ignore')) continue;
    const byContent = guessFieldByContent(rows.map((r) => r[i]));
    if (byContent === 'text' || byContent === 'ignore') { if (!header && byContent === 'text') map[i] = 'text'; continue; }
    // Un titolo che non conosciamo sopra una colonna di date può essere
    // qualunque cosa («Ultima visita», «Data acquisto»): non è il compleanno.
    if (byContent === 'birthday' && header && norm(header[i])) continue;
    if (!taken.has(byContent)) { map[i] = byContent; taken.add(byContent); }
  }
  // colonne di testo senza intestazione: prima = nome (o nome completo), seconda = cognome
  const textIdx = map.map((k, i) => (k === 'text' ? i : -1)).filter((i) => i >= 0);
  if (textIdx.length >= 2) { map[textIdx[0]] = 'first_name'; map[textIdx[1]] = 'last_name'; }
  else if (textIdx.length === 1) map[textIdx[0]] = 'full_name';
  // "nome" con "cognome" presente resta nome; "nome" senza cognome → nome completo
  if (map.includes('first_name') && !map.includes('last_name') && header) {
    const i = map.indexOf('first_name');
    if (norm(header[i]) === 'nome' || norm(header[i]) === 'name') map[i] = 'full_name';
  }
  return map.map((k) => (k === 'text' ? 'ignore' : k));
}

/* ---------- normalizzazione valori ---------- */
const MONTHS = { gen: 1, gennaio: 1, jan: 1, january: 1, feb: 2, febbraio: 2, february: 2, mar: 3, marzo: 3, march: 3, apr: 4, aprile: 4, april: 4, mag: 5, maggio: 5, may: 5, giu: 6, giugno: 6, jun: 6, june: 6, lug: 7, luglio: 7, jul: 7, july: 7, ago: 8, agosto: 8, aug: 8, august: 8, set: 9, settembre: 9, sep: 9, sept: 9, september: 9, ott: 10, ottobre: 10, oct: 10, october: 10, nov: 11, novembre: 11, november: 11, dic: 12, dicembre: 12, dec: 12, december: 12 };
const pad = (n) => String(n).padStart(2, '0');
/* Calendario vero dell'anno, quando l'anno c'è: col 2000 fisso (bisestile) il
 * «29/02/1991» passava il controllo e il server scartava l'intera cliente
 * (14-15, 06-13). Senza anno il 29 febbraio resta valido. */
const daysIn = (m, y) => new Date(Date.UTC(y || 2000, m, 0)).getUTCDate();
const valid = (d, m, y = null) => m >= 1 && m <= 12 && d >= 1 && d <= daysIn(m, y);
const fixYear = (y) => { if (y.length === 4) return Number(y); const n = Number(y); const cur = new Date().getFullYear() % 100; return n <= cur ? 2000 + n : 1900 + n; };
/** → 'YYYY-MM-DD' | '--MM-DD' | null. order: 'dmy' | 'mdy' per le date numeriche ambigue */
export function parseFlexibleDate(raw, order = 'dmy') {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ t].*)?$/.exec(s);
  if (m) { const y = +m[1], mo = +m[2], d = +m[3]; return valid(d, mo, y) ? `${y}-${pad(mo)}-${pad(d)}` : null; }
  m = /^--?(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) { const mo = +m[1], d = +m[2]; return valid(d, mo) ? `--${pad(mo)}-${pad(d)}` : null; }
  m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2}|\d{4}))?$/.exec(s);
  if (m) {
    const a = +m[1], b = +m[2];
    const y = m[3] ? fixYear(m[3]) : null;
    let d = a, mo = b;
    if (order === 'mdy') { d = b; mo = a; }
    if (!valid(d, mo, y) && valid(mo, d, y)) { [d, mo] = [mo, d]; } // unico ordine possibile
    if (!valid(d, mo, y)) return null;
    return y ? `${y}-${pad(mo)}-${pad(d)}` : `--${pad(mo)}-${pad(d)}`;
  }
  m = /^(\d{1,2})\s+([a-zà-ú]+)\.?(?:\s+(\d{4}))?$/.exec(s);
  if (m) { const mo = MONTHS[m[2]] || MONTHS[m[2].slice(0, 3)]; const d = +m[1]; const y = m[3] ? +m[3] : null; if (!mo || !valid(d, mo, y)) return null; return y ? `${y}-${pad(mo)}-${pad(d)}` : `--${pad(mo)}-${pad(d)}`; }
  m = /^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(s);
  if (m) { const mo = MONTHS[m[1]] || MONTHS[m[1].slice(0, 3)]; const d = +m[2]; const y = m[3] ? +m[3] : null; if (!mo || !valid(d, mo, y)) return null; return y ? `${y}-${pad(mo)}-${pad(d)}` : `--${pad(mo)}-${pad(d)}`; }
  return null;
}
export function parseGender(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (/^(f|femm\w*|donna|woman|female|w|she|signora|sig\.?ra)$/.test(s)) return 'female';
  if (/^(m|masc\w*|uomo|man|male|he|signore|sig\.?)$/.test(s)) return 'male';
  if (/^(altro|other|x|nb|non binario|non-binary)$/.test(s)) return 'other';
  return '';
}
const parseLang = (raw) => { const s = String(raw || '').trim().toLowerCase(); if (/^(it|ita|italiano|italian)$/.test(s)) return 'it'; if (/^(en|eng|english|inglese)$/.test(s)) return 'en'; return ''; };
// il «+» vale solo in testa: «3,93482E+11» non deve diventare «393482+11»
const cleanPhone = (raw) => { const s = String(raw || '').trim(); return (s.startsWith('+') ? '+' : '') + s.replace(/\D/g, ''); };
const phoneKey = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('0039')) d = d.slice(4); else if (d.startsWith('39') && d.length > 10) d = d.slice(2); return d; };
/* Excel che ha trasformato il numero in notazione scientifica: le ultime cifre
 * sono perse per sempre, e numeri diversi diventano lo stesso «3,93482E+11». */
const excelScientific = (raw) => /^\d+([.,]\d+)?e\+?\d+$/i.test(String(raw || '').replace(/\s/g, ''));

/* Particelle dei cognomi: «DE LUCA MARIA» è Maria De Luca, non Luca Maria De. */
const PARTICLES = new Set(['de', 'di', 'da', 'del', 'della', 'dello', 'delle', 'dei', 'degli', 'dal', 'dalla', 'dalle', 'dai', 'lo', 'la', 'le', 'li', 'van', 'von', 'der', 'den', 'mc', 'mac', 'san', 'santa', 'st']);

/** «Nome e cognome» / «Cognome e nome» → { first, last }. */
export function splitFullName(full, surnameFirst = false) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first: parts[0] || '', last: '' };
  if (!surnameFirst) return { first: parts[0], last: parts.slice(1).join(' ') };
  // il cognome è la prima parola, con le particelle che la precedono
  let i = 0;
  while (i < parts.length - 2 && PARTICLES.has(parts[i].toLowerCase())) i++;
  return { first: parts.slice(i + 1).join(' '), last: parts.slice(0, i + 1).join(' ') };
}

/** applica la mappatura → righe normalizzate con avvisi.
 *  - `lines`: numero di riga nel file di ogni riga di dati (vedi parseCsvLines);
 *  - `plausiblePhone`: la regola del telefono (isPlausiblePhone di
 *    @youty/shared, la stessa del server): la passa chi chiama, così questo
 *    modulo resta provabile senza il pacchetto intero;
 *  - `today`: «oggi» del salone, per il «cliente dal» nel futuro. */
export function buildRows(dataRows, mapping, { dateOrder = 'dmy', lines = null, plausiblePhone = null, today = todayStr() } = {}) {
  const out = [];
  const seenPhones = new Map();
  dataRows.forEach((cells, idx) => {
    const line = lines ? lines[idx] : idx + 1;
    const r = { first_name: '', last_name: '', phone: '', email: '', gender: '', birthday: '', since: '', origin: '', lang: '', note: '', categories: [] };
    const warn = [];
    let full = '', rev = '';
    mapping.forEach((k, i) => {
      const v = String(cells[i] ?? '').trim();
      if (!v || k === 'ignore') return;
      if (k === 'full_name') full = v;
      else if (k === 'full_name_rev') rev = v;
      else if (k === 'phone') {
        const p = cleanPhone(v);
        if (!phoneKey(p)) warn.push('phone');   // «n/d», «-»: niente cifre
        // cifre perse: importarlo farebbe di più clienti diverse la stessa
        // persona (stesso «numero»), meglio la riga senza telefono
        else if (excelScientific(v)) warn.push('phonesci:' + v);
        // «348 221 0094 / 06 1234567», «333»: la scheda nasce col testo com'è
        // (il server lo tiene e lo segnala), ma chi importa lo sa prima (14-15)
        else if (plausiblePhone && !plausiblePhone(p)) { r.phone = v; warn.push('badphone:' + v); }
        else r.phone = p;
      }
      else if (k === 'gender') { r.gender = parseGender(v); if (!r.gender) warn.push('gender:' + v); }
      else if (k === 'birthday') { const b = parseFlexibleDate(v, dateOrder); if (b) r.birthday = b; else warn.push('birthday:' + v); }
      else if (k === 'since') {
        const d = parseFlexibleDate(v, dateOrder);
        if (d && !d.startsWith('--') && d <= today) r.since = d;
        else warn.push('since:' + v);
      }
      else if (k === 'categories') r.categories = [...r.categories, ...v.split(/[,;|/]+/).map((x) => x.trim()).filter(Boolean)];
      else if (k === 'lang') r.lang = parseLang(v);
      else if (k === 'note') r.note = r.note ? r.note + '\n' + v : v;
      else if (k === 'email') { if (looksEmail(v)) r.email = v; else warn.push('email:' + v); }
      else r[k] = v;
    });
    const whole = full || rev;
    if (whole && !r.first_name) {
      const { first, last } = splitFullName(whole, !full);
      r.first_name = first; r.last_name = r.last_name || last;
    } else if (whole && !r.last_name) {
      r.last_name = whole.replace(r.first_name, '').trim();
    }
    if (!r.first_name) warn.push('name');
    if (!r.phone) warn.push('nophone');
    if (r.phone) { const k = phoneKey(r.phone); if (seenPhones.has(k)) warn.push('dup:' + seenPhones.get(k)); else seenPhones.set(k, line); }
    out.push({ ...r, _idx: idx, _line: line, _warn: warn, _skip: !r.first_name || (!r.phone && !r.email) });
  });
  return out;
}

/** Riga dell'esito del server (indice dentro il blocco inviato) → riga del
 *  FILE, come nell'anteprima: `ready` sono le righe inviate, `offset` il primo
 *  indice del blocco. */
export function fileLineOf(ready, offset, row) {
  const src = ready[offset + row];
  return src ? src._line : offset + row + 1;
}
