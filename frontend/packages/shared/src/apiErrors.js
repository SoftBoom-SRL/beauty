// apiErrors.js — gli errori dell'API → testo leggibile.
// Logica pura (la usa api.js; i test la provano da sola, senza fetch). Qui
// stanno anche la classe ApiError e il testo/toast che se ne mostra: i moduli
// provati con `npm test` li importano senza tirarsi dietro api.js, che al
// caricamento legge import.meta.env (in Node non c'è).

/** Risposta dell'API con uno status d'errore: `status`, il messaggio già
 *  leggibile (vedi readableDetail) e il corpo della risposta in `data`. La
 *  lancia api.js; un errore di rete o un'eccezione nel codice non è un ApiError. */
export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/** L'errore di una chiamata all'API → il testo da mostrare: il messaggio del
 *  server se una risposta è arrivata, altrimenti «Errore di rete». È la regola
 *  che le sezioni riscrivevano a mano in ogni catch
 *  (`err instanceof ApiError ? err.message : t('Errore di rete', 'Network error')`). */
export function apiErrorText(err, t) {
  return err instanceof ApiError ? err.message : t('Errore di rete', 'Network error');
}

/** Il toast d'errore di una chiamata all'API:
 *  fireToast({ msg: apiErrorText(err, t), icon: 'alert' }).
 *  Argomenti (err, fireToast, t): l'ordine dei due aiuti già usati da più file,
 *  `toastErr` delle Impostazioni e `errToast` dell'app clienti, che così ne
 *  diventano sinonimi senza toccare le chiamate. Attenzione al `toastErr`
 *  dell'agenda: è (err, t, fireToast), con gli ultimi due scambiati. */
export function toastApiError(err, fireToast, t) {
  fireToast({ msg: apiErrorText(err, t), icon: 'alert' });
}

/* Nomi dei campi dei moduli, come li chiama il backend → come li legge chi usa
 * l'app. Un campo che non è qui si legge col suo nome, senza trattini bassi. */
const FIELD_LABELS = {
  reason: 'Motivo', note: 'Nota', notes: 'Note', text: 'Testo', body: 'Testo', title: 'Titolo',
  name: 'Nome', first_name: 'Nome', last_name: 'Cognome', phone: 'Telefono', email: 'Email',
  address: 'Indirizzo', birthday: 'Compleanno', gender: 'Genere', lang: 'Lingua',
  description: 'Descrizione', description_it: 'Descrizione', description_en: 'Descrizione (EN)',
  name_it: 'Nome', name_en: 'Nome (EN)', code: 'Codice', sku: 'Codice articolo', category: 'Categoria',
  price: 'Prezzo', amount: 'Importo', value: 'Valore', qty: 'Quantità', unit_price: 'Prezzo unitario',
  sale_price: 'Prezzo di vendita', purchase_price: 'Prezzo d’acquisto', supplier_cost: 'Costo fornitore',
  product_cost: 'Costo prodotto', hourly_cost: 'Costo orario', discount_pct: 'Sconto %',
  vat_rate: 'Aliquota IVA', vat_number: 'Partita IVA', sdi_pec: 'SDI o PEC',
  duration_min: 'Durata', soak_min: 'Posa', start: 'Inizio', date: 'Data', date_from: 'Dal', date_to: 'Al',
  expires_at: 'Scadenza', delivery_date: 'Data di consegna', scheduled_at: 'Data di invio', exact_time: 'Orario',
  treatment: 'Trattamento', zone: 'Zona', reliability: 'Affidabilità', next_step: 'Prossimo passo',
  threshold: 'Soglia', reward_value: 'Valore del premio', recipient_name: 'Destinataria',
  password: 'Password', new_password: 'Nuova password', current_password: 'Password attuale',
  color: 'Colore', cta_label: 'Testo del pulsante', cta_url: 'Link del pulsante', question: 'Domanda',
  advice: 'Consiglio', role_title: 'Ruolo', opening_hours: 'Orari', privacy_policy_url: 'Link all’informativa privacy',
  qty_ordered: 'Quantità ordinata', qty_received: 'Quantità ricevuta', reorder_qty: 'Quantità di riordino',
  rows: 'Righe', items: 'Servizi', lines: 'Righe',
};

/** `loc` di pydantic → nome del campo: ["body", "data", "reason"] → «Motivo»,
 *  ["body", "data", "items", 1, "soak_min"] → «Posa (n. 2)», ["query", "date"]
 *  → «Data». Nel corpo il secondo elemento è il nome del parametro della view. */
function fieldLabel(loc) {
  if (!Array.isArray(loc)) return '';
  const path = loc.slice(loc[0] === 'body' || loc[0] === 'form' ? 2 : 1);
  let i = path.length - 1;
  while (i >= 0 && typeof path[i] !== 'string') i -= 1;
  if (i < 0) return '';
  const name = path[i];
  const raw = FIELD_LABELS[name] || name.replace(/_/g, ' ');
  const label = raw.charAt(0).toUpperCase() + raw.slice(1);
  const idx = path.slice(0, i).reverse().find((p) => typeof p === 'number');
  return idx === undefined ? label : `${label} (n. ${idx + 1})`;
}

/** Il problema di un errore pydantic, in italiano. */
function problem(e) {
  const c = e.ctx || {};
  switch (e.type) {
    case 'missing': return 'obbligatorio';
    case 'string_too_long': return `al massimo ${c.max_length} caratteri`;
    case 'string_too_short': return Number(c.min_length) > 1 ? `almeno ${c.min_length} caratteri` : 'obbligatorio';
    case 'too_long': return `al massimo ${c.max_length} elementi`;
    case 'too_short': return `almeno ${c.min_length} elementi`;
    case 'less_than_equal': return `al massimo ${c.le}`;
    case 'less_than': return `meno di ${c.lt}`;
    case 'greater_than_equal': return `almeno ${c.ge}`;
    case 'greater_than': return `più di ${c.gt}`;
    case 'multiple_of': return `multiplo di ${c.multiple_of}`;
    case 'int_parsing': case 'int_type': case 'int_from_float': return 'deve essere un numero intero';
    case 'float_parsing': case 'float_type': case 'decimal_parsing': case 'decimal_type': case 'finite_number':
      return 'deve essere un numero';
    case 'decimal_max_places': return `al massimo ${c.decimal_places} decimali`;
    case 'decimal_max_digits': case 'decimal_whole_digits': return 'numero troppo grande';
    case 'bool_parsing': case 'bool_type': return 'valore non valido';
    case 'string_type': return 'deve essere un testo';
    case 'date_parsing': case 'date_type': case 'date_from_datetime_parsing': case 'date_from_datetime_inexact':
      return 'data non valida';
    case 'datetime_parsing': case 'datetime_type': case 'datetime_from_date_parsing': case 'timezone_aware':
      return 'data e ora non valide';
    case 'time_parsing': case 'time_type': return 'orario non valido';
    case 'literal_error': case 'enum': return 'valore non ammesso';
    case 'string_pattern_mismatch': return 'formato non valido';
    case 'uuid_parsing': case 'uuid_type': return 'codice non valido';
    case 'url_parsing': case 'url_type': case 'url_scheme': return 'indirizzo non valido';
    case 'extra_forbidden': return 'campo non previsto';
    case 'list_type': return 'deve essere un elenco';
    case 'value_error': {
      // I validatori del backend scrivono già in italiano: si tiene il loro testo.
      const m = String(e.msg || '').replace(/^Value error, /, '');
      if (/not a valid email/i.test(m)) return 'indirizzo email non valido';
      return m || 'valore non valido';
    }
    default: return 'valore non valido';
  }
}

function describe(e) {
  // Una voce senza `type` non è di pydantic: il suo messaggio com'è.
  if (typeof e.type !== 'string') return e.msg;
  const what = problem(e);
  const field = fieldLabel(e.loc);
  return field ? `${field}: ${what}` : what.charAt(0).toUpperCase() + what.slice(1);
}

/* Un campo d'errore → testo leggibile.
 * Gli HttpError scritti a mano mandano `detail` come stringa, ma la
 * validazione di schema di django-ninja (422) manda una LISTA di dizionari
 * pydantic: il toast stampava `[{"type":"less_than_equal","loc":[...],…}]`, e
 * poi il primo `msg`, in inglese e senza dire quale campo — «String should have
 * at most 255 characters», e il no-show con la nota lunga non si registrava
 * senza che si capisse perché (17-12). Ora ogni voce dice il campo (da `loc`)
 * e il problema in italiano: «Motivo: al massimo 255 caratteri». */
export function readableDetail(value) {
  if (typeof value === 'string' && value) return value;
  if (Array.isArray(value)) {
    const errs = value.filter((e) => e && typeof e === 'object'
      && (typeof e.type === 'string' || (typeof e.msg === 'string' && e.msg)));
    if (errs.length) {
      const parts = [...new Set(errs.map(describe))];
      return parts.slice(0, 3).join(' · ') + (parts.length > 3 ? ' …' : '');
    }
  }
  if (value !== null && value !== undefined) {
    try { return JSON.stringify(value); } catch { return null; }
  }
  return null;
}
