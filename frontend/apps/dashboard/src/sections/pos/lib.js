// lib.js — POS helpers shared by CartTab, HistoryTab and SellModal.
import { fmtEur, salonDayDiff, salonParts } from '@youty/shared';

export const round2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

/** Numero da un importo digitato a testo libero: accetta numeri o stringhe
 *  con virgola o punto ("12,50" / "12.50"); valori non validi → 0. */
export const toNum = (x) => {
  if (typeof x === 'number') return Number.isFinite(x) ? x : 0;
  const n = parseFloat(String(x ?? '').replace(',', '.').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Ripulisce ciò che si digita nel campo importo a testo libero: solo cifre e
 *  un unico separatore decimale (virgola o punto). */
export function sanitizeAmtInput(raw) {
  let s = String(raw ?? '').replace(/[^0-9.,]/g, '');
  const sep = s.search(/[.,]/);
  if (sep !== -1) s = s.slice(0, sep + 1) + s.slice(sep + 1).replace(/[.,]/g, '');
  return s;
}

/** money display — decimal strings/numbers; zero shows as "€0" (not "Gratis"). */
export const money = (x, lang) => (Number(x) === 0 ? '€0' : fmtEur(Number(x), lang));

/** payment methods (API enum order: cash | card | other | gift_card) */
export const payMethods = (t) => [
  ['cash', t('Contanti', 'Cash')],
  ['card', t('Carta', 'Card')],
  ['other', t('Altro', 'Other')],
  ['gift_card', t('Gift card', 'Gift card')],
];
export const methodLabel = (m, t) => {
  const f = payMethods(t).find(([k]) => k === m);
  return f ? f[1] : m;
};

export const opName = (o) => (o ? [o.first_name, o.last_name].filter(Boolean).join(' ') : '');

export const svcLabel = (s, lang) => (lang === 'en' && s.name_en ? s.name_en : s.name_it);

/** cart/checkout line value, mirroring the API rule:
 *  amount = qty × unit_price × (1 − discount_pct/100), 0 if is_gift; gift_card → value. */
export function lineAmount(l) {
  if (l.line_type === 'gift_card') return round2(l.value || 0);
  if (l.is_gift) return 0;
  return round2((l.qty || 1) * Number(l.unit_price || 0) * (1 - (l.discount_pct || 0) / 100));
}

/* ---------------- payments model ----------------
 * One shared shape for the single/split payment editor:
 *   { split: bool, method: 'cash', giftCode: '', rows: [{ method, amt, code }] }
 * resolvePayments() turns it into the API `payments[]` array. */

export const emptyPayments = () => ({ split: false, method: 'cash', giftCode: '', rows: [] });

export function resolvePayments(v, due) {
  if (!v.split) {
    const p = { method: v.method, amount: round2(due).toFixed(2) };
    if (v.method === 'gift_card') p.gift_card_code = (v.giftCode || '').trim();
    return [p];
  }
  return v.rows.map((r) => {
    const p = { method: r.method, amount: round2(toNum(r.amt)).toFixed(2) };
    if (r.method === 'gift_card') p.gift_card_code = (r.code || '').trim();
    return p;
  });
}

/** client-side validation matching the API ±0.01 rule; returns an error message or null. */
export function paymentsError(v, due, t) {
  const pays = resolvePayments(v, due);
  if (pays.some((p) => p.method === 'gift_card' && !p.gift_card_code)) {
    return t('Inserisci il codice della gift card', 'Enter the gift card code');
  }
  const sum = pays.reduce((s, p) => s + Number(p.amount), 0);
  if (Math.abs(sum - due) > 0.011) {
    return t('La somma dei pagamenti non corrisponde al totale', 'Payments must add up to the total');
  }
  return null;
}

/** "Oggi · 14:30" / "Ieri · 10:12" / "24 giu 2026 · 11:48" — giorno e ora del SALONE.
 *  ("oggi" per il salone, non per il fuso di chi guarda la dashboard) */
export function saleDateLabel(iso, lang) {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return '';
  const p = salonParts(iso);
  const hm = String(p.h).padStart(2, '0') + ':' + String(p.min).padStart(2, '0');
  const diff = salonDayDiff(iso);
  if (diff === 0) return (lang === 'en' ? 'Today' : 'Oggi') + ' · ' + hm;
  if (diff === 1) return (lang === 'en' ? 'Yesterday' : 'Ieri') + ' · ' + hm;
  const months = lang === 'en'
    ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    : ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  return p.d + ' ' + months[p.m - 1] + ' ' + p.y + ' · ' + hm;
}

export const inputCss = {
  border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13,
  fontWeight: 600, padding: '8px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)',
  color: 'var(--ink)',
};
