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

/* ---- Le regole del numero: le STESSE di `backend/common/phone.py` ----
 * Il numero normalizzato è la chiave con cui si riconosce una cliente già in
 * rubrica: se frontend e backend lo scrivono in due modi, la stessa persona
 * diventa due schede e l'OTP parte verso un numero che non esiste. I casi di
 * prova sono una tabella sola, uguale nei due lati
 * (backend/apps/clients/tests_caccia22_telefono.py e
 * packages/shared/test/phone-rules.test.js).
 * R1 «+» o «00» = internazionale: dopo il prefisso cade UNO 0 interurbano,
 *    tranne in Italia, San Marino, Vaticano e Costa d'Avorio.
 * R2 solo cifre: 12 o più cifre che cominciano con un prefisso assegnato =
 *    già internazionale (e vale R1); altrimenti numero italiano → +39.
 * R3 dopo +39, 12 o più cifre che cominciano per 39 = prefisso ripetuto. */

/* Prefissi internazionali assegnati dall'ITU (E.164), elenco completo: è
 * `COUNTRY_CODES` di backend/common/phone.py e deve restare IDENTICO. Serve a
 * sapere dove finisce il prefisso (lunghezza variabile) e se una fila di cifre
 * senza «+» è già internazionale. COUNTRIES qui sopra resta corto perché è il
 * menu delle bandiere: usato come elenco dei prefissi, «380501234567» era
 * ucraino qui e italiano nel backend (+39380…), la stessa cliente importata da
 * Excel e digitata nell'app erano due persone (16-11). I prefissi E.164 sono
 * «prefix-free»: al più uno combacia con l'inizio di un numero. */
export const COUNTRY_CODES = [
  '1', '7',
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44',
  '45', '46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58',
  '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91',
  '92', '93', '94', '95', '98',
  '211', '212', '213', '216', '218', '220', '221', '222', '223', '224', '225',
  '226', '227', '228', '229', '230', '231', '232', '233', '234', '235', '236',
  '237', '238', '239', '240', '241', '242', '243', '244', '245', '246', '247',
  '248', '249', '250', '251', '252', '253', '254', '255', '256', '257', '258',
  '260', '261', '262', '263', '264', '265', '266', '267', '268', '269', '290',
  '291', '297', '298', '299',
  '350', '351', '352', '353', '354', '355', '356', '357', '358', '359', '370',
  '371', '372', '373', '374', '375', '376', '377', '378', '379', '380', '381',
  '382', '383', '385', '386', '387', '389',
  '420', '421', '423',
  '500', '501', '502', '503', '504', '505', '506', '507', '508', '509', '590',
  '591', '592', '593', '594', '595', '596', '597', '598', '599',
  '670', '672', '673', '674', '675', '676', '677', '678', '679', '680', '681',
  '682', '683', '685', '686', '687', '688', '689', '690', '691', '692',
  '800', '808', '850', '852', '853', '855', '856', '870', '878', '880', '881',
  '882', '883', '886', '888',
  '960', '961', '962', '963', '964', '965', '966', '967', '968', '970', '971',
  '972', '973', '974', '975', '976', '977', '979', '992', '993', '994', '995',
  '996', '997', '998',
];

/* Paesi in cui lo 0 dopo il prefisso fa parte del numero e resta anche da
 * fuori: Italia (+39 02 1234567; +39 2 1234567 non esiste), San Marino
 * (+378 0549…), Vaticano (+379 06…) e Costa d'Avorio (+225, numeri a 10 cifre
 * che cominciano per 0). Altrove è lo 0 interurbano e in E.164 cade — uno
 * solo. Con l'elenco corto di prima la cliente romena che scriveva
 * «0721 234 567» con la bandiera RO restava salvata come +40 0721…, numero
 * inesistente: niente OTP né promemoria, e senza lo 0 era una seconda scheda
 * (06-04). Togliere TUTTI gli zeri («+49 00151…») divergeva dal backend. */
const TRUNK_ZERO_KEPT = new Set(['39', '378', '379', '225']);

// Cifre massime di un numero nazionale italiano: oltre, una fila di cifre
// senza «+» porta già il suo prefisso («393331234567» da WhatsApp o da Excel).
const NATIONAL_MAX_DIGITS = 11;

const CODES_LONGEST_FIRST = [...COUNTRY_CODES].sort((a, b) => b.length - a.length);

/** Il prefisso ITU con cui cominciano le cifre, '' se non è assegnato. */
function ituCode(digits) {
  return CODES_LONGEST_FIRST.find((cc) => digits.startsWith(cc)) || '';
}

/** Cifre senza «+» già in forma internazionale (R2). Servono entrambe le
 *  condizioni: «3331234567» comincia per 33 (Francia) ma è un cellulare
 *  italiano; «289012345678» ha 12 cifre ma nessun prefisso assegnato. */
function alreadyInternational(digits) {
  return digits.length > NATIONAL_MAX_DIGITS && ituCode(digits) !== '';
}

/** Cifre E.164 (prefisso compreso, senza «+») → la forma che salva il backend.
 *  Un prefisso non assegnato lascia il numero intatto: accorciare senza sapere
 *  dove finisce il prefisso è peggio che non toccare. */
function canonicalDigits(digits) {
  let d = digits;
  // R1: uno 0 interurbano dopo il prefisso, dove non fa parte del numero.
  const cc = ituCode(d);
  if (cc && !TRUNK_ZERO_KEPT.has(cc) && d.startsWith('0', cc.length)) d = cc + d.slice(cc.length + 1);
  // R3: «+39 39 333 1234567» → «+39 333 1234567». Un nazionale italiano ha al
  // più 11 cifre: «+39 393 1234567» (10) è un cellulare vero e resta.
  const national = d.slice(2);
  if (d.startsWith('39') && national.length > NATIONAL_MAX_DIGITS && national.startsWith('39')) d = '39' + national.slice(2);
  return d;
}

// Prefissi dei paesi del menu dal più lungo al più corto: il primo che combacia
// vince. A parità di prefisso vince chi sta prima nell'elenco (USA prima di Canada).
const DIALS = [...new Set(COUNTRIES.map((c) => c.dial))].sort((a, b) => b.length - a.length);

const digitsOnly = (s) => String(s || '').replace(/\D/g, '');

function countryForDial(dial, national) {
  const same = COUNTRIES.filter((c) => c.dial === dial);
  return same.find((c) => c.area && c.area.some((a) => national.startsWith(a))) || same[0] || null;
}

/** Cifre internazionali (prefisso compreso) → { iso2, dial, national } sui
 *  paesi del menu. Prefisso fuori menu → iso2 '' e tutte le cifre in `national`. */
function splitIntl(digits) {
  const dial = DIALS.find((d) => digits.startsWith(d));
  if (!dial) return { iso2: '', dial: '', national: digits };
  const national = digits.slice(dial.length);
  const c = countryForDial(dial, national);
  return { iso2: c ? c.iso2 : '', dial, national };
}

/**
 * Qualunque stringa (E.164, "00…", legacy con spazi/trattini/parentesi) →
 * { iso2, dial, national }. Senza prefisso si assume l'Italia (R2). Prefisso
 * internazionale fuori dal menu → iso2 '' e tutte le cifre in `national`.
 */
export function splitPhone(value) {
  // Come il backend: via tutto fuorché cifre e «+» PRIMA di guardare come
  // comincia. «(+39) 333 1234567» incollato cominciava per «(», non era letto
  // come internazionale e diventava +39 39 333… (16-02).
  const s = String(value || '').replace(/[^\d+]/g, '');
  if (s.startsWith('+')) return splitIntl(digitsOnly(s));
  if (s.startsWith('00')) return splitIntl(digitsOnly(s.slice(2))); // "00" = "+"
  const digits = digitsOnly(s);
  if (alreadyInternational(digits)) return splitIntl(digits);
  return { iso2: DEFAULT_ISO2, dial: '39', national: digits };
}

/** (iso2, cifre nazionali) → E.164 "+<dial><cifre>", oppure '' se vuoto.
 *  Paese ignoto (iso2 ''): le cifre contengono già il prefisso. */
export function joinPhone(iso2, national) {
  const n = digitsOnly(national);
  if (!n) return '';
  const c = countryOf(iso2);
  const full = canonicalDigits(c ? c.dial + n : n);
  // Restava solo lo 0 interurbano («+44 0»): non è ancora un numero.
  if (c && full === c.dial) return '';
  return '+' + full;
}

/**
 * Il testo del campo numero di PhoneInput, con la bandiera `iso2` scelta →
 * { iso2, national, pending }: la bandiera da mostrare e le cifre da tenere in
 * campo (joinPhone(iso2, national) è il valore). `pending` è il testo da
 * lasciare com'è finché un «+» o un «00» battuti non hanno ancora un prefisso
 * riconoscibile ("+", "+4", "003"): intanto il valore è vuoto.
 * - «+»/«00» davanti (anche incollati fra parentesi): numero internazionale,
 *   il prefisso passa nella bandiera. Il «+» da solo veniva tolto come un
 *   carattere qualsiasi, e «+39 333…» battuto a mano diventava +39 39 333…,
 *   «+44 7911…» diventava +39 44 7911… (16-02).
 * - bandiera 🌐 (iso2 ''): le cifre in campo contengono già il prefisso.
 * - bandiera italiana e più di 11 cifre con un prefisso assegnato: il prefisso
 *   è stato scritto o incollato insieme al numero (R2, come splitPhone e il
 *   backend). Solo per l'Italia, di cui si sa che il nazionale non supera le
 *   11 cifre: altrove un numero lungo può cominciare con il prefisso di un
 *   altro paese.
 */
export function readPhoneField(iso2, text) {
  const s = String(text || '').replace(/[^\d+]/g, '');
  let intl;
  if (s.startsWith('+') || s.startsWith('00')) {
    const lead = s.startsWith('+') ? '+' : '00';
    intl = digitsOnly(s.slice(lead.length));
    // I prefissi hanno al più tre cifre: prima si aspetta la prossima, dopo è
    // un prefisso non assegnato e il numero si tiene com'è (bandiera 🌐).
    if (!ituCode(intl) && intl.length < 3) return { iso2, national: '', pending: lead + intl };
  } else {
    const digits = digitsOnly(s);
    if (iso2 && !(iso2 === DEFAULT_ISO2 && alreadyInternational(digits))) return { iso2, national: digits, pending: '' };
    intl = digits;
  }
  const p = splitIntl(intl);
  return { iso2: p.iso2, national: p.national, pending: '' };
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

/** Valore qualsiasi (anche legacy) → E.164 pronto per l'API: per ogni numero
 *  che il backend accetta, la stessa scrittura di `normalize_phone` (R1–R3). */
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
