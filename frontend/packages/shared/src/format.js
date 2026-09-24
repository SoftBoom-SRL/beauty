// format.js — currency / time / date helpers shared by both apps.
// Money from the API arrives as decimal STRINGS ("35.00"): fmtEur le legge come
// numeri, quindi fmtEur(x) e fmtEur(Number(x)) danno lo stesso risultato.

export function fmtEur(n, lang) {
  // Il denaro si scrive SEMPRE con due decimali. Senza i minimi, trentacinque
  // euro e cinquanta si leggeva «€35,5» sullo scontrino a video; senza i
  // massimi, un prezzo calcolato (sconto fornitore, medie) usciva con tre
  // decimali — «€8,415» a video contro «8,42 €» sullo stesso ordine stampato.
  // Lo zero si riconosce sul NUMERO e non sul valore grezzo: gli importi
  // arrivano dall'API come stringhe decimali, e «0.00» non è === 0, quindi la
  // stessa cifra si leggeva «Gratis» oppure «€0,00» a seconda del chiamante.
  const v = Number(n);
  if (v === 0) return lang === 'en' ? 'Free' : 'Gratis';
  return '€' + v.toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/* Il «Gratis» di fmtEur è la convenzione dei listini: un saldo, un incasso o
 * una caparra a zero sono «€0», senza decimali, come li scrivevano le sezioni
 * (chi scrive «€0,00» — riepiloghi dell'agenda, buono d'ordine, crediti
 * dell'app clienti — ha regole sue, diverse da queste). Qui due regole, che
 * differiscono solo su ciò che non è un numero (undefined, un testo non
 * numerico): */

/** Zero → «€0», tutto il resto come fmtEur — anche «€NaN» per un valore che
 *  non è un numero. È la regola di `money` del banco e degli `eur0` di
 *  fedeltà, schede cliente e grafici. */
export function fmtEurNoFree(n, lang) {
  const v = Number(n);
  return v === 0 ? '€0' : fmtEur(v, lang);
}

/** Come fmtEurNoFree, ma ciò che non è un numero conta zero: «€0» anche per
 *  un KPI che manca. È la regola di `eur` di staff, profilo e insight. */
export function fmtEurOrZero(n, lang) {
  return fmtEurNoFree(Number(n) || 0, lang);
}

/** minutes from midnight → "HH:MM" */
export function timeLabel(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/** duration in minutes → "1h 30m" / "1h" / "45m" */
export function fmtDur(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/* ---------------- dates ----------------
 * Date model: the API speaks ISO strings — "YYYY-MM-DD" for dates,
 * full ISO8601 with offset for datetimes.
 *
 * Fuso: il gestionale ragiona sull'orologio del SALONE. Le 10:00 di un
 * appuntamento sono le 10:00 alla reception, non quelle del dispositivo che le
 * guarda: da un portatile impostato su un altro fuso l'agenda mostrava orari
 * traslati, e da un telefono all'estero la cliente leggeva un orario che non
 * era quello a cui è attesa. Il fuso lo dice il server (`timezone` nelle
 * impostazioni e nel branding pubblico) e le app lo impostano al boot.
 *
 * Due categorie, da non confondere:
 * - ISTANTI (ISO con orario, `new Date()`): si convertono nell'orologio del
 *   salone — minutesOfDay, nowMinutes, todayStr, toDateStr su una stringa
 *   con la T, isoAtMin.
 * - CALENDARIO (stringhe "YYYY-MM-DD" e i Date che ne derivano): restano
 *   aritmetica di giorni, senza fuso. Convertirli sposterebbe il giorno. */

let SALON_TZ = 'Europe/Rome';

/** Imposta il fuso del salone (dal payload impostazioni/branding). */
export function setSalonTz(tz) {
  if (!tz) return;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });  // fuso sconosciuto → throw
    SALON_TZ = tz;
  } catch {
    /* fuso non riconosciuto dal browser: si resta su quello attuale */
  }
}

export function salonTz() { return SALON_TZ; }

const TZ_FMT = new Map();
function tzFormat(tz) {
  let fmt = TZ_FMT.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    TZ_FMT.set(tz, fmt);
  }
  return fmt;
}

/** Un istante letto sull'orologio del salone: { y, m, d, hh, mm, ss }. */
function salonParts(date) {
  const out = {};
  for (const part of tzFormat(SALON_TZ).formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return { y: out.year, m: out.month, d: out.day, hh: out.hour % 24, mm: out.minute, ss: out.second };
}

/** Scarto del fuso del salone rispetto a UTC, in millisecondi, per quell'istante. */
function salonOffsetMs(ms) {
  const p = salonParts(new Date(ms));
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000;
}

/** Istante in cui nel salone sono le hh:mm del giorno indicato. */
function salonInstant(y, m, d, hh = 0, mm = 0) {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // Due passaggi: sul cambio dell'ora lo scarto calcolato sull'istante
  // provvisorio può essere ancora quello vecchio.
  let ms = wall - salonOffsetMs(wall);
  ms = wall - salonOffsetMs(ms);
  return new Date(ms);
}

const isInstant = (x) => x instanceof Date || (typeof x === 'string' && x.includes('T'));
const pad2 = (n) => String(n).padStart(2, '0');

/** Un istante letto sull'orologio del salone: { year, month, day, hour, minute }.
 *  Da usare ovunque si mostri "quando è successo": sulle postazioni con un
 *  altro fuso i timbri orari raccontavano l'ora del dispositivo. */
export function salonDateParts(iso) {
  const p = salonParts(iso instanceof Date ? iso : new Date(iso));
  return { year: p.y, month: p.m, day: p.d, hour: p.hh, minute: p.mm };
}

/** ISO datetime → "HH:MM" nel fuso del salone. */
export function fmtTime(iso) {
  return timeLabel(minutesOfDay(iso));
}

/** Opzioni Intl con il fuso del salone, per i formati localizzati. */
export function salonTzOpts(opts = {}) {
  return { ...opts, timeZone: SALON_TZ };
}

/** "YYYY-MM-DDTHH:MM" nel fuso del salone, per <input type="datetime-local">. */
export function toDateTimeLocal(iso) {
  if (!iso) return '';
  const p = salonDateParts(iso);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Valore di <input type="datetime-local"> → ISO dell'istante, letto come ora del salone. */
export function dateTimeLocalToIso(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  return salonInstant(+m[1], +m[2], +m[3], +m[4], +m[5]).toISOString();
}

/** "YYYY-MM-DD" + minuti dalla mezzanotte → ISO8601 dell'istante nel fuso del salone. */
export function isoAtMin(dateStr, minutes) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return salonInstant(y, m, d, 0, minutes).toISOString();
}

/** Date/ISO → "YYYY-MM-DD".
 *
 *  Una stringa ISO CON ORARIO è un istante e dà il giorno del SALONE: un
 *  appuntamento a mezzanotte e mezza deve finire nel giorno giusto d'agenda.
 *  Un `Date` invece arriva quasi sempre dall'aritmetica dei giorni (mese
 *  successivo, lunedì della settimana, giorno + 1) ed è mezzanotte locale:
 *  convertirlo lo sposterebbe di un giorno indietro su ogni dispositivo più
 *  avanti del salone. Per l'istante «adesso» c'è `todayStr()`. */
export function toDateStr(date) {
  if (typeof date === 'string') {
    return date.includes('T') ? salonDayOf(new Date(date)) : date.slice(0, 10);
  }
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function salonDayOf(date) {
  const p = salonParts(date);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/** oggi come "YYYY-MM-DD" nel fuso del SALONE (non in quello del dispositivo) */
export function todayStr() { return salonDayOf(new Date()); }

/** adesso, in minuti dalla mezzanotte del salone (la riga dell'ora in agenda) */
export function nowMinutes() {
  const p = salonParts(new Date());
  return p.hh * 60 + p.mm;
}

/** ISO string → Date. Date-only strings ("YYYY-MM-DD") parse as LOCAL midnight
 * (native new Date('YYYY-MM-DD') would parse as UTC and shift the day). */
export function parseISO(s) {
  if (s instanceof Date) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return new Date(s);
}

/** ISO datetime → minuti dalla mezzanotte NEL FUSO DEL SALONE.
 *  È la base di tutta la griglia d'agenda: leggerli sull'orologio del
 *  dispositivo faceva comparire le 10:00 di Roma alle 04:00 a New York. */
export function minutesOfDay(iso) {
  if (typeof iso === 'string' && !iso.includes('T')) return 0;  // data pura
  const p = salonParts(iso instanceof Date ? iso : new Date(iso));
  return p.hh * 60 + p.mm;
}

/** add n days; accepts Date or ISO string, returns a new Date */
export function addDays(date, n) {
  const d = new Date(parseISO(date));
  d.setDate(d.getDate() + n);
  return d;
}

/** Italian long date, e.g. "Mercoledì 12 novembre" (capitalized weekday).
 *  fmtDateIt(date, { weekday: false }) → "12 novembre 2026" */
export function fmtDateIt(date, { weekday = true, year = false } = {}) {
  const d = parseISO(date);
  const opts = { day: 'numeric', month: 'long' };
  if (weekday) opts.weekday = 'long';
  if (year) opts.year = 'numeric';
  // Un istante si legge sul calendario del salone; una data pura è già un
  // giorno e va lasciata dov'è.
  if (isInstant(date)) opts.timeZone = SALON_TZ;
  const s = d.toLocaleDateString('it-IT', opts);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
