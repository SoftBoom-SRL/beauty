// phone.js — logica pura per i numeri di telefono (nessun React).
//
// Il backend accetta E.164 e normalizza da solo: la forma da inviare è SEMPRE
// quella restituita da joinPhone(). Qui vivono l'elenco dei prefissi e le
// conversioni fra ciò che l'utente vede (bandiera + prefisso + numero
// nazionale) e ciò che si salva ("+39333…").

export const DEFAULT_ISO2 = 'IT';

// Italia per prima (mercato del prodotto), poi Europa e i paesi più presenti
// fra la clientela dei saloni italiani. `area` serve solo dove più paesi
// condividono il prefisso (+1) per riconoscere il paese al rientro del valore.
// `keepZero`: in Italia lo 0 dei fissi fa parte del numero (+39 06 …), altrove
// è il "trunk prefix" nazionale che in E.164 cade.
export const COUNTRIES = [
  { iso2: 'IT', name_it: 'Italia', name_en: 'Italy', dial: '39', flag: '🇮🇹', keepZero: true },
  { iso2: 'FR', name_it: 'Francia', name_en: 'France', dial: '33', flag: '🇫🇷' },
  { iso2: 'DE', name_it: 'Germania', name_en: 'Germany', dial: '49', flag: '🇩🇪' },
  { iso2: 'ES', name_it: 'Spagna', name_en: 'Spain', dial: '34', flag: '🇪🇸' },
  { iso2: 'PT', name_it: 'Portogallo', name_en: 'Portugal', dial: '351', flag: '🇵🇹' },
  { iso2: 'CH', name_it: 'Svizzera', name_en: 'Switzerland', dial: '41', flag: '🇨🇭' },
  { iso2: 'AT', name_it: 'Austria', name_en: 'Austria', dial: '43', flag: '🇦🇹' },
  { iso2: 'BE', name_it: 'Belgio', name_en: 'Belgium', dial: '32', flag: '🇧🇪' },
  { iso2: 'NL', name_it: 'Paesi Bassi', name_en: 'Netherlands', dial: '31', flag: '🇳🇱' },
  { iso2: 'LU', name_it: 'Lussemburgo', name_en: 'Luxembourg', dial: '352', flag: '🇱🇺' },
  { iso2: 'GB', name_it: 'Regno Unito', name_en: 'United Kingdom', dial: '44', flag: '🇬🇧' },
  { iso2: 'IE', name_it: 'Irlanda', name_en: 'Ireland', dial: '353', flag: '🇮🇪' },
  { iso2: 'GR', name_it: 'Grecia', name_en: 'Greece', dial: '30', flag: '🇬🇷' },
  { iso2: 'MT', name_it: 'Malta', name_en: 'Malta', dial: '356', flag: '🇲🇹' },
  { iso2: 'SM', name_it: 'San Marino', name_en: 'San Marino', dial: '378', flag: '🇸🇲' },
  { iso2: 'MC', name_it: 'Monaco', name_en: 'Monaco', dial: '377', flag: '🇲🇨' },
  { iso2: 'SE', name_it: 'Svezia', name_en: 'Sweden', dial: '46', flag: '🇸🇪' },
  { iso2: 'NO', name_it: 'Norvegia', name_en: 'Norway', dial: '47', flag: '🇳🇴' },
  { iso2: 'DK', name_it: 'Danimarca', name_en: 'Denmark', dial: '45', flag: '🇩🇰' },
  { iso2: 'FI', name_it: 'Finlandia', name_en: 'Finland', dial: '358', flag: '🇫🇮' },
  { iso2: 'PL', name_it: 'Polonia', name_en: 'Poland', dial: '48', flag: '🇵🇱' },
  { iso2: 'CZ', name_it: 'Repubblica Ceca', name_en: 'Czechia', dial: '420', flag: '🇨🇿' },
  { iso2: 'SK', name_it: 'Slovacchia', name_en: 'Slovakia', dial: '421', flag: '🇸🇰' },
  { iso2: 'HU', name_it: 'Ungheria', name_en: 'Hungary', dial: '36', flag: '🇭🇺' },
  { iso2: 'RO', name_it: 'Romania', name_en: 'Romania', dial: '40', flag: '🇷🇴' },
  { iso2: 'MD', name_it: 'Moldavia', name_en: 'Moldova', dial: '373', flag: '🇲🇩' },
  { iso2: 'BG', name_it: 'Bulgaria', name_en: 'Bulgaria', dial: '359', flag: '🇧🇬' },
  { iso2: 'HR', name_it: 'Croazia', name_en: 'Croatia', dial: '385', flag: '🇭🇷' },
  { iso2: 'SI', name_it: 'Slovenia', name_en: 'Slovenia', dial: '386', flag: '🇸🇮' },
  { iso2: 'RS', name_it: 'Serbia', name_en: 'Serbia', dial: '381', flag: '🇷🇸' },
  { iso2: 'BA', name_it: 'Bosnia ed Erzegovina', name_en: 'Bosnia and Herzegovina', dial: '387', flag: '🇧🇦' },
  { iso2: 'MK', name_it: 'Macedonia del Nord', name_en: 'North Macedonia', dial: '389', flag: '🇲🇰' },
  { iso2: 'AL', name_it: 'Albania', name_en: 'Albania', dial: '355', flag: '🇦🇱' },
  { iso2: 'XK', name_it: 'Kosovo', name_en: 'Kosovo', dial: '383', flag: '🇽🇰' },
  { iso2: 'UA', name_it: 'Ucraina', name_en: 'Ukraine', dial: '380', flag: '🇺🇦' },
  { iso2: 'RU', name_it: 'Russia', name_en: 'Russia', dial: '7', flag: '🇷🇺' },
  { iso2: 'GE', name_it: 'Georgia', name_en: 'Georgia', dial: '995', flag: '🇬🇪' },
  { iso2: 'TR', name_it: 'Turchia', name_en: 'Turkey', dial: '90', flag: '🇹🇷' },
  { iso2: 'US', name_it: 'Stati Uniti', name_en: 'United States', dial: '1', flag: '🇺🇸' },
  { iso2: 'CA', name_it: 'Canada', name_en: 'Canada', dial: '1', flag: '🇨🇦' },
  { iso2: 'DO', name_it: 'Repubblica Dominicana', name_en: 'Dominican Republic', dial: '1', flag: '🇩🇴', area: ['809', '829', '849'] },
  { iso2: 'MX', name_it: 'Messico', name_en: 'Mexico', dial: '52', flag: '🇲🇽' },
  { iso2: 'CU', name_it: 'Cuba', name_en: 'Cuba', dial: '53', flag: '🇨🇺' },
  { iso2: 'BR', name_it: 'Brasile', name_en: 'Brazil', dial: '55', flag: '🇧🇷' },
  { iso2: 'AR', name_it: 'Argentina', name_en: 'Argentina', dial: '54', flag: '🇦🇷' },
  { iso2: 'CO', name_it: 'Colombia', name_en: 'Colombia', dial: '57', flag: '🇨🇴' },
  { iso2: 'PE', name_it: 'Perù', name_en: 'Peru', dial: '51', flag: '🇵🇪' },
  { iso2: 'EC', name_it: 'Ecuador', name_en: 'Ecuador', dial: '593', flag: '🇪🇨' },
  { iso2: 'VE', name_it: 'Venezuela', name_en: 'Venezuela', dial: '58', flag: '🇻🇪' },
  { iso2: 'MA', name_it: 'Marocco', name_en: 'Morocco', dial: '212', flag: '🇲🇦' },
  { iso2: 'TN', name_it: 'Tunisia', name_en: 'Tunisia', dial: '216', flag: '🇹🇳' },
  { iso2: 'DZ', name_it: 'Algeria', name_en: 'Algeria', dial: '213', flag: '🇩🇿' },
  { iso2: 'EG', name_it: 'Egitto', name_en: 'Egypt', dial: '20', flag: '🇪🇬' },
  { iso2: 'NG', name_it: 'Nigeria', name_en: 'Nigeria', dial: '234', flag: '🇳🇬' },
  { iso2: 'SN', name_it: 'Senegal', name_en: 'Senegal', dial: '221', flag: '🇸🇳' },
  { iso2: 'GH', name_it: 'Ghana', name_en: 'Ghana', dial: '233', flag: '🇬🇭' },
  { iso2: 'CI', name_it: "Costa d'Avorio", name_en: 'Ivory Coast', dial: '225', flag: '🇨🇮' },
  { iso2: 'CN', name_it: 'Cina', name_en: 'China', dial: '86', flag: '🇨🇳' },
  { iso2: 'IN', name_it: 'India', name_en: 'India', dial: '91', flag: '🇮🇳' },
  { iso2: 'PK', name_it: 'Pakistan', name_en: 'Pakistan', dial: '92', flag: '🇵🇰' },
  { iso2: 'BD', name_it: 'Bangladesh', name_en: 'Bangladesh', dial: '880', flag: '🇧🇩' },
  { iso2: 'LK', name_it: 'Sri Lanka', name_en: 'Sri Lanka', dial: '94', flag: '🇱🇰' },
  { iso2: 'PH', name_it: 'Filippine', name_en: 'Philippines', dial: '63', flag: '🇵🇭' },
  { iso2: 'JP', name_it: 'Giappone', name_en: 'Japan', dial: '81', flag: '🇯🇵' },
  { iso2: 'AE', name_it: 'Emirati Arabi Uniti', name_en: 'United Arab Emirates', dial: '971', flag: '🇦🇪' },
  { iso2: 'AU', name_it: 'Australia', name_en: 'Australia', dial: '61', flag: '🇦🇺' },
];

const BY_ISO = new Map(COUNTRIES.map((c) => [c.iso2, c]));

/** Paese per codice ISO2 (null se sconosciuto). */
export function countryOf(iso2) {
  return BY_ISO.get(String(iso2 || '').toUpperCase()) || null;
}

// Prefissi dal più lungo al più corto: il primo che combacia vince. A parità
// di prefisso vince chi sta prima nell'elenco (USA prima di Canada).
const DIALS = [...new Set(COUNTRIES.map((c) => c.dial))].sort((a, b) => b.length - a.length);

const digitsOnly = (s) => String(s || '').replace(/\D/g, '');

function countryForDial(dial, national) {
  const same = COUNTRIES.filter((c) => c.dial === dial);
  return same.find((c) => c.area && c.area.some((a) => national.startsWith(a))) || same[0] || null;
}

/**
 * Qualunque stringa (E.164, "00…", legacy con spazi/trattini/parentesi) →
 * { iso2, dial, national }. Senza prefisso si assume l'Italia. Prefisso
 * internazionale sconosciuto → iso2 '' e tutte le cifre in `national`.
 */
export function splitPhone(value) {
  let s = String(value || '').trim();
  if (/^00/.test(s)) s = '+' + s.slice(2); // "00" = "+" internazionale
  const digits = digitsOnly(s);
  // Un numero nazionale italiano non supera le 11 cifre: oltre, è un numero
  // internazionale salvato senza "+" (es. "393331234567").
  const intl = s.startsWith('+') || digits.length > 11;
  if (!intl) return { iso2: DEFAULT_ISO2, dial: '39', national: digits };
  const dial = DIALS.find((d) => digits.startsWith(d));
  if (!dial) return { iso2: '', dial: '', national: digits };
  const national = digits.slice(dial.length);
  const c = countryForDial(dial, national);
  return { iso2: c ? c.iso2 : '', dial, national };
}

/* Lo 0 iniziale del numero nazionale è il prefisso interurbano e in alcuni
 * paesi va tolto (+44 020 7946 0958 = +44 20 7946 0958), in altri fa parte del
 * numero (+39 02 1234567). La regola DEVE coincidere con quella del backend
 * (`backend/common/phone.py`): è la chiave con cui si riconosce una cliente
 * già in rubrica. Togliendolo dove il backend non lo toglie, la stessa persona
 * diventava due identità e non riusciva più ad accedere.
 * Elenco volutamente corto: un prefisso che non c'è lascia il numero intatto. */
const TRUNK_ZERO_DROP = new Set(['44', '49', '33', '34', '41', '43', '32', '31', '30', '351', '353', '420']);

/** (iso2, cifre nazionali) → E.164 "+<dial><cifre>", oppure '' se vuoto. */
export function joinPhone(iso2, national) {
  let n = digitsOnly(national);
  if (!n) return '';
  const c = countryOf(iso2);
  if (!c) return '+' + n; // paese ignoto: le cifre contengono già il prefisso
  if (TRUNK_ZERO_DROP.has(c.dial)) n = n.replace(/^0+/, '');
  return n ? '+' + c.dial + n : '';
}

/** Cifre nazionali → gruppi di 3 per leggibilità ("333 123 4567"). */
export function formatNational(iso2, national) {
  const n = digitsOnly(national);
  if (!n) return '';
  const groups = n.match(/.{1,3}/g) || [];
  // niente coda di una cifra sola: "333 123 4567", non "333 123 456 7"
  if (groups.length > 1 && groups[groups.length - 1].length === 1) {
    const last = groups.pop();
    groups[groups.length - 1] += last;
  }
  return groups.join(' ');
}

/** Valore qualsiasi → "+39 333 123 4567" per la sola visualizzazione. */
export function formatPhone(value) {
  const { iso2, dial, national } = splitPhone(value);
  if (!dial && !national) return '';
  return '+' + dial + (national ? ' ' + formatNational(iso2, national) : '');
}

/** Valore qualsiasi (anche legacy) → E.164 pronto per l'API. */
export function normalizePhone(value) {
  const { iso2, national } = splitPhone(value);
  return joinPhone(iso2, national);
}

/** Numero che il backend saprebbe normalizzare: 7–15 cifre col prefisso e
 *  nessuno 0 iniziale. La regola è la stessa di `backend/common/phone.py`
 *  (`[1-9]\d{6,14}`) e deve restare tale: qui bastavano 6 cifre, così quattro
 *  cifre digitate per sbaglio superavano il controllo, la registrazione
 *  riusciva, il salone pagava un SMS verso un numero inesistente e la cliente
 *  restava bloccata sulla schermata del codice con una scheda fantasma. */
export function isPlausiblePhone(value) {
  return /^\+[1-9]\d{6,14}$/.test(normalizePhone(value));
}
