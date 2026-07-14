// helpers.js — clienti section utilities (pure functions, no React).

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

/* Build a FULL ClientIn payload from a ClientOut/ClientDetailOut + patch.
 * PUT /api/clients/{id} takes the whole ClientIn (unset fields fall back to
 * schema defaults), so partial bodies would clobber data — always send it all. */
export function toClientIn(c, patch = {}) {
  return {
    first_name: c.first_name,
    last_name: c.last_name || '',
    phone: c.phone,
    email: c.email || '',
    wa: !!c.wa,
    lang: c.lang || 'it',
    category_ids: (c.categories || []).map((x) => x.id),
    reliability: c.reliability ?? 100,
    origin: c.origin || '',
    birthday: c.birthday || null,
    since: c.since || null,
    consents: { ...(c.consents || {}) },
    whatsapp_reminders: !!c.whatsapp_reminders,
    stripe_customer_id: c.stripe_customer_id || '',
    stripe_payment_method_id: c.stripe_payment_method_id || '',
    deposit_always: !!c.deposit_always,
    is_active: c.is_active !== false,
    ...patch,
  };
}

/* The list/marketing `q` filters match single fields (icontains on first OR
 * last name) — a full name with a space matches nothing. Query with the most
 * selective single word, then filter exactly by client id on the caller side. */
export function clientQueryWord(c) {
  return (c.last_name || c.first_name || c.full_name || '').trim().split(/\s+/).pop() || '';
}

/* "12 mar 2026 · 15:30" from an ISO datetime, localized. */
export function dateTimeLabel(iso, lang) {
  if (!iso) return '';
  const d = new Date(iso);
  const months = lang === 'en'
    ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    : ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} · ${hm}`;
}

/* "12 mar 2026" from an ISO date/datetime. */
export function dateLabel(iso, lang) {
  if (!iso) return '';
  return dateTimeLabel(iso, lang).split(' · ')[0];
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
