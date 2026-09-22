// lib.js — POS helpers shared by CartTab, HistoryTab and SellModal.
import { api, fmtEur, fmtTime, parseISO, salonDateParts, toDateStr, todayStr } from '@youty/shared';

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

/* ---------------- buono sconto al banco ----------------
 * Il conto accetta un `coupon_code`: i buoni del programma fedeltà erano
 * emessi ma non spendibili, e la cassiera poteva solo scontare a mano.
 *
 * Il codice lo rivalida il SERVER al momento dell'incasso, ed è lui ad avere
 * l'ultima parola. Quello che si fa qui è solo mostrare il conto giusto prima
 * di premere «Incassa»: senza sapere lo sconto, il pagamento precompilato
 * chiederebbe l'importo pieno e la vendita verrebbe respinta con «I pagamenti
 * non corrispondono al totale». */

/** Sconto in euro del buono su un imponibile, come lo calcola il server
 *  (marketing.services.coupon_discount): mai più dell'imponibile — un buono da
 *  50 € su un conto da 30 sconta 30, non trasforma la cassa in un bancomat. */
export function couponDiscount(coupon, base) {
  const amount = round2(base);
  if (!coupon || !(amount > 0)) return 0;
  const value = Number(coupon.value || 0);
  return round2(Math.min(coupon.kind === 'percent' ? (amount * value) / 100 : value, amount));
}

/** Cerca il buono per codice e, se non è spendibile, dice PERCHÉ in una frase.
 *  Risolve { coupon } oppure { error }: gli stessi rifiuti del server
 *  (accounts/marketing services), detti prima del clic invece che dopo. */
export async function findCoupon(code, { clientId = null, t }) {
  const wanted = String(code || '').trim().toUpperCase(); // i codici sono maiuscoli
  if (!wanted) return { error: t('Inserisci un codice', 'Enter a code') };
  let rows = [];
  try {
    const res = await api.get('/api/marketing/coupons', { params: { q: wanted, limit: 20 } });
    rows = res?.items || res || [];
  } catch {
    return { error: t('Non riesco a verificare il buono: riprova', 'Cannot verify the voucher: try again') };
  }
  const coupon = rows.find((c) => String(c.code).toUpperCase() === wanted);
  if (!coupon) return { error: t('Coupon non trovato', 'Voucher not found') };
  if (coupon.expires_at && parseISO(coupon.expires_at) < new Date()) {
    return { error: t('Coupon scaduto', 'Voucher expired') };
  }
  if (coupon.status !== 'active') return { error: t('Coupon non più valido', 'Voucher no longer valid') };
  // Un buono intestato vale solo per la sua cliente: al banco, su una vendita
  // anonima, chiunque presentasse il codice di un'altra otterrebbe lo sconto.
  if (coupon.client_id && coupon.client_id !== clientId) {
    return {
      error: coupon.client_name
        ? t(`Coupon riservato a ${coupon.client_name}: intesta la vendita a lei`, `Voucher reserved for ${coupon.client_name}: assign the sale to her`)
        : t('Coupon riservato a un\u2019altra cliente: intesta la vendita', 'Voucher reserved for another client: assign the sale'),
    };
  }
  return { coupon };
}

/** "Oggi · 14:30" / "Ieri · 10:12" / "24 giu 2026 · 11:48" from an ISO datetime. */
export function saleDateLabel(iso, lang) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // «Oggi» è oggi in salone: a cavallo della mezzanotte una postazione con un
  // altro fuso datava lo scontrino al giorno sbagliato.
  const hm = fmtTime(iso);
  const day0 = toDateStr(iso);
  const diff = Math.round((parseISO(todayStr()) - parseISO(day0)) / 86400000);
  if (diff === 0) return (lang === 'en' ? 'Today' : 'Oggi') + ' · ' + hm;
  if (diff === 1) return (lang === 'en' ? 'Yesterday' : 'Ieri') + ' · ' + hm;
  const p = salonDateParts(iso);
  const months = lang === 'en'
    ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    : ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  return p.day + ' ' + months[p.month - 1] + ' ' + p.year + ' · ' + hm;
}

export const inputCss = {
  border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13,
  fontWeight: 600, padding: '8px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)',
  color: 'var(--ink)',
};
