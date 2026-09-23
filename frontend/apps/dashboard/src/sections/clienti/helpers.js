// helpers.js — clienti section utilities (pure functions, no React).
import { fmtTime, salonDateParts, todayStr } from '@youty/shared';
import { composeReward } from '../fedelta/meta.js';

/* Shared input style used across the section's forms (from the prototype). */
export const inputCss = {
  border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14.5,
  padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)',
  width: '100%', boxSizing: 'border-box', color: 'var(--ink)',
};

/* Reliability score → color + label (thresholds from the prototype: 85 / 60). */
export function relMeta(score, t) {
  if (score >= 85) return { color: 'var(--ok)', label: t('Ottima', 'Excellent') };
  if (score >= 60) return { color: 'var(--warn)', label: t('Buona', 'Good') };
  return { color: 'var(--danger)', label: t('Da seguire', 'Watch') };
}

/* Reliability filter key → API range params. */
export function relRange(key) {
  if (key === 'good') return { reliability_min: 85 };
  if (key === 'watch') return { reliability_min: 60, reliability_max: 84 };
  if (key === 'risk') return { reliability_max: 59 };
  return {};
}

export function initialsOf(name) {
  return String(name || '')
    .split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
}

/* Il PUT della scheda porta SOLO i campi cambiati (contratto C15).
 *
 * Prima ogni salvataggio — un'etichetta, la lingua, «Rimuovi caparra» —
 * rimandava tutta la copia letta all'apertura della scheda, consensi compresi:
 * se nel frattempo la cliente aveva revocato il marketing dall'app, un clic
 * della reception glielo ridava e cancellava la data della revoca (14-05); lo
 * stesso per lingua, email e promemoria cambiati dall'app (06-10). Il server
 * applica solo i campi presenti nel corpo: quello che l'operatrice non ha
 * toccato non si manda.
 *
 * Gli identificativi Stripe non si mandano mai: li scrive il server quando la
 * carta viene registrata davvero (accettarli dal client permetteva di copiare
 * la carta della cliente A sulla scheda B). */

/* Campi del modulo «Modifica cliente», letti dalla scheda come il modulo li
 * mostra (stesso «vuoto»), così un campo non toccato risulta uguale. */
const EDITABLE = {
  first_name: (c) => c.first_name || '',
  last_name: (c) => c.last_name || '',
  phone: (c) => c.phone || '',
  wa: (c) => !!c.wa,
  email: (c) => c.email || '',
  lang: (c) => c.lang || 'it',
  category_ids: (c) => (c.categories || []).map((x) => x.id),
  gender: (c) => c.gender || '',
  birthday: (c) => c.birthday || null,   // 'YYYY-MM-DD' | '--MM-DD' | null
  origin: (c) => c.origin || '',
  since: (c) => c.since || null,
  deposit_always: (c) => !!c.deposit_always,
  whatsapp_reminders: (c) => !!c.whatsapp_reminders,
};

const sameIds = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/** Scheda letta all'apertura + valori del modulo → solo le chiavi cambiate.
 *  Le chiavi sconosciute del modulo si ignorano (non sono campi della scheda). */
export function clientChanges(orig, next) {
  const out = {};
  for (const [k, v] of Object.entries(next)) {
    const read = EDITABLE[k];
    if (!read) continue;
    const before = read(orig || {});
    const same = Array.isArray(before) ? sameIds(before, v || []) : before === v;
    if (!same) out[k] = v;
  }
  return out;
}

/* ---- Consensi: le date le scrive il server (C15) ----
 * Quando un flag cambia il server segna `<flag>_at` (dato) o
 * `<flag>_revoked_at` (revocato). Qui si mostra solo quello che c'è davvero:
 * la scheda prometteva di conservare «la data di raccolta» che nessuno
 * scriveva (14-14). */
const isStamp = (v) => typeof v === 'string' && v !== '' && !Number.isNaN(Date.parse(v));

/** → { kind: 'given' | 'revoked', at: ISO } oppure null se la data non c'è. */
export function consentStamp(consents, key) {
  const cs = consents || {};
  if (cs[key]) return isStamp(cs[`${key}_at`]) ? { kind: 'given', at: cs[`${key}_at`] } : null;
  return isStamp(cs[`${key}_revoked_at`]) ? { kind: 'revoked', at: cs[`${key}_revoked_at`] } : null;
}

const MONTHS_SHORT = {
  it: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};
const monthShort = (m, lang) => (lang === 'en' ? MONTHS_SHORT.en : MONTHS_SHORT.it)[m - 1];

/* "12 mar 2026 · 15:30" from an ISO datetime, localized. */
export function dateTimeLabel(iso, lang) {
  if (!iso) return '';
  // Ora del salone, non del dispositivo (vedi shared/format.js).
  const p = salonDateParts(iso);
  return `${p.day} ${monthShort(p.month, lang)} ${p.year} · ${fmtTime(iso)}`;
}

/* "12 mar 2026" from an ISO date/datetime. */
export function dateLabel(iso, lang) {
  if (!iso) return '';
  // Una data pura («cliente dal» 2021-05-10) è già un giorno del calendario:
  // letta come istante (mezzanotte UTC) e riportata sul fuso del salone,
  // in un salone a ovest di Greenwich diventava il giorno prima.
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (d) return `${Number(d[3])} ${monthShort(Number(d[2]), lang)} ${d[1]}`;
  return dateTimeLabel(iso, lang).split(' · ')[0];
}

/** Giorno e mese della timeline dello storico, sul calendario del SALONE:
 *  `new Date(iso).getDate()` era il giorno del dispositivo, e da una postazione
 *  su un altro fuso le visite serali cambiavano giorno (14-13, 06-18).
 *  → { day, month: 'mar', year: '' | '25' } (anno solo se non è quello in corso). */
export function timelineDate(iso, lang, today = todayStr()) {
  const p = salonDateParts(iso);
  return {
    day: p.day,
    month: monthShort(p.month, lang),
    year: p.year === Number(String(today).slice(0, 4)) ? '' : String(p.year).slice(2),
  };
}

/** Caparra di una visita come va mostrata nello storico, o null se non c'è.
 *  Prima si guardava solo «pagata» e se ne mostrava l'intero `deposit_amount`:
 *  dopo un rimborso parziale di 10 € su 30 la scheda diceva 30 €, e una
 *  caparra da restituire o in rimborso non compariva affatto (14-25).
 *  → { kind: 'paid'|'refund_due'|'refunding'|'refunded'|'forfeited', amount, refunded } */
export function depositBadge(a) {
  const amount = Number(a?.deposit_amount || 0);
  const refunded = Number(a?.deposit_refunded_amount || 0);
  // in centesimi interi: gli importi arrivano come stringhe decimali del server
  const left = Math.max(0, Math.round(amount * 100) - Math.round(refunded * 100)) / 100;
  switch (a?.deposit_status) {
    case 'paid': {
      // quello che resta in cassa e si detrae al conto (deposit_credit)
      const credit = a.deposit_credit != null ? Number(a.deposit_credit) : left;
      return credit > 0
        ? { kind: 'paid', amount: credit, refunded }
        : { kind: 'refunded', amount: refunded || amount, refunded };
    }
    case 'refund_due': return { kind: 'refund_due', amount: left, refunded };
    case 'refunding': return { kind: 'refunding', amount: left, refunded };
    case 'refunded': return { kind: 'refunded', amount: refunded || amount, refunded };
    case 'forfeited': return { kind: 'forfeited', amount: left, refunded };
    default: return null;   // nessuna caparra, o richiesta e non ancora pagata
  }
}

/** Premio di un programma fedeltà per il Wallet della scheda: la stessa
 *  etichetta della sezione Fedeltà (composeReward). La versione locale
 *  cercava 'percent'/'amount' dentro 'discount_pct'/'gift_card' e scriveva
 *  «Premio: 10.00» (14-21, 07-16). */
export function rewardLabel(p, services, lang) {
  const s = p.reward_type === 'free_service' ? (services || []).find((x) => x.id === p.reward_service_id) : null;
  const name = s ? ((lang === 'en' && s.name_en) ? s.name_en : s.name_it) : '';
  return composeReward(p.reward_type, p.reward_value, name, lang);
}

/* wa.me link from a phone number (digits only, keeps leading country code). */
export function waHref(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  return digits ? `https://wa.me/${digits}` : null;
}

/* Technical sheet fields — prototype TECH_FIELDS mapped onto the API's flat
 * TechnicalSheetIn/Out columns. `params` is a JSON object on the API: the
 * prototype's single free-text field is stored as { text: "…" }. */
export const TECH_FIELDS = (t) => ([
  { k: 'treatment', label: t('Trattamento eseguito', 'Treatment performed'), type: 'text', required: true, ph: t('es. Gel, Balayage, Pulizia viso…', 'e.g. Gel, Balayage, Facial…') },
  { k: 'zone', label: t('Zona / area trattata', 'Area treated'), type: 'text', ph: t('es. mani, viso, capelli, gambe', 'e.g. hands, face, hair, legs') },
  { k: 'products', label: t('Prodotti utilizzati', 'Products used'), type: 'text', ph: t('marca, linea, tonalità…', 'brand, line, shade…') },
  { k: 'params', label: t('Parametri / impostazioni', 'Parameters / settings'), type: 'text', ph: t('es. formula, vol., tempo di posa, potenza', 'e.g. formula, vol., processing, intensity') },
  { k: 'outcome', label: t('Esito', 'Outcome'), type: 'select', opts: [t('Ottimo', 'Excellent'), t('Buono', 'Good'), t('Da monitorare', 'To monitor'), t('Reazione / problema', 'Reaction / issue')] },
  { k: 'duration_hold', label: t('Durata / tenuta', 'Duration / hold'), type: 'text', ph: t('es. 90 min · tenuta 3 settimane', 'e.g. 90 min · holds 3 weeks') },
  { k: 'advice', label: t('Consigli post-trattamento', 'Aftercare advice'), type: 'textarea' },
  { k: 'protocol', label: t('Note di protocollo', 'Protocol notes'), type: 'textarea' },
  { k: 'next_step', label: t('Prossimo step consigliato', 'Recommended next step'), type: 'text', ph: t('es. richiamo a 4 settimane', 'e.g. follow-up in 4 weeks') },
]);

/* Read a sheet field for display; `params` object → its text / joined pairs. */
export function sheetVal(sheet, key) {
  const v = sheet[key];
  if (key === 'params') {
    if (!v || typeof v !== 'object') return v || '';
    if (typeof v.text === 'string') return v.text;
    return Object.entries(v).map(([k, x]) => `${k}: ${x}`).join(' · ');
  }
  return v || '';
}

/* ---- Genere: definizione condivisa in ui/GenderPicker.jsx ----
 * Si importa da lì, non da qui: ri-esportarla tirava un .jsx dentro questo
 * modulo di funzioni pure, che così non si poteva provare con `npm test`. */

/* ---- Compleanno: 'YYYY-MM-DD' (anno noto) oppure '--MM-DD' (solo giorno e mese) ----
 * Alcune clienti non vogliono dire l'età ma dicono volentieri quando festeggiano:
 * l'API accetta e restituisce il formato ISO 8601 senza anno. */
export const MONTHS_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
export const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** → { d, m, y } (y = null se l'anno non è noto) oppure null */
export function parseBirthday(v) {
  if (!v) return null;
  let m = /^--(\d{2})-(\d{2})$/.exec(v);
  if (m) return { d: Number(m[2]), m: Number(m[1]), y: null };
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return { d: Number(m[3]), m: Number(m[2]), y: Number(m[1]) };
  return null;
}
/** { d, m, y } → stringa API ('' se incompleto) */
export function buildBirthday({ d, m, y }) {
  if (!d || !m) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return y ? `${y}-${pad(m)}-${pad(d)}` : `--${pad(m)}-${pad(d)}`;
}
/** "15 marzo" · "15 marzo 1990" */
export function formatBirthday(v, lang) {
  const b = parseBirthday(v);
  if (!b) return '';
  const months = lang === 'en' ? MONTHS_EN : MONTHS_IT;
  const base = lang === 'en' ? `${months[b.m - 1]} ${b.d}` : `${b.d} ${months[b.m - 1]}`;
  return b.y ? `${base} ${b.y}` : base;
}
/** giorni al prossimo compleanno (0 = oggi), null se non impostato.
 *  «Oggi» è quello del SALONE (todayStr): con la mezzanotte del dispositivo
 *  una postazione su un altro fuso annunciava il compleanno il giorno sbagliato.
 *  Aritmetica in UTC: niente ore saltate col cambio dell'ora. */
export function daysToBirthday(v, today = todayStr()) {
  const b = parseBirthday(v);
  if (!b) return null;
  const [y, m, d] = String(today).split('-').map(Number);
  const t0 = Date.UTC(y, m - 1, d);
  let next = Date.UTC(y, b.m - 1, b.d);
  if (next < t0) next = Date.UTC(y + 1, b.m - 1, b.d);
  return Math.round((next - t0) / 86400000);
}
