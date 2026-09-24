// lib.js — POS helpers shared by CartTab, HistoryTab and SellModal.
import { MONTHS_SHORT_EN, MONTHS_SHORT_IT, api, fmtTime, parseISO, salonDateParts, toDateStr, todayStr } from '@youty/shared';
import { centsToEur, lineCents } from './money.js';

// Il denaro si conta in centesimi interi con gli arrotondamenti del server:
// le regole stanno in money.js (senza dipendenze, quindi provate da npm test).
export {
  PAYMENT_TOLERANCE_CENTS, centsToApi, centsToEur, couponDiscountCents, emptyPayments,
  giftPrefillRows, lineCents, paymentsError, paymentsMatch, resolvePayments, saleTotals, toCents,
} from './money.js';

/** Ripulisce ciò che si digita nel campo importo a testo libero: solo cifre e
 *  un unico separatore decimale (virgola o punto). */
export function sanitizeAmtInput(raw) {
  let s = String(raw ?? '').replace(/[^0-9.,]/g, '');
  const sep = s.search(/[.,]/);
  if (sep !== -1) s = s.slice(0, sep + 1) + s.slice(sep + 1).replace(/[.,]/g, '');
  return s;
}

/** importi a video — stringhe decimali o numeri; lo zero è «€0», non «Gratis»
 *  (la regola di fmtEurNoFree, con il nome che usa la cassa). */
export { fmtEurNoFree as money } from '@youty/shared';

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

export { nameIn as svcLabel } from '@youty/shared';

/** cart/checkout line value in euro, for display: the API rule computed in
 *  cents (see money.js lineCents). */
export const lineAmount = (l) => centsToEur(lineCents(l));

/* ---------------- buono sconto al banco ----------------
 * Il conto accetta un `coupon_code`: i buoni del programma fedeltà erano
 * emessi ma non spendibili, e la cassiera poteva solo scontare a mano.
 *
 * Il codice lo rivalida il SERVER al momento dell'incasso, ed è lui ad avere
 * l'ultima parola. Quello che si fa qui è solo mostrare il conto giusto prima
 * di premere «Incassa»: senza sapere lo sconto, il pagamento precompilato
 * chiederebbe l'importo pieno e la vendita verrebbe respinta con «I pagamenti
 * non corrispondono al totale». Lo sconto lo calcola couponDiscountCents
 * (money.js), in centesimi come marketing.services.coupon_discount. */

/** Cerca il buono per codice e, se non è spendibile, dice PERCHÉ in una frase.
 *  Risolve { coupon } oppure { error }: gli stessi rifiuti del server
 *  (accounts/marketing services), detti prima del clic invece che dopo. */
export async function findCoupon(code, { clientId = null, t }) {
  const wanted = String(code || '').trim().toUpperCase(); // i codici sono maiuscoli
  if (!wanted) return { error: t('Inserisci un codice', 'Enter a code') };
  let rows;
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
  const months = lang === 'en' ? MONTHS_SHORT_EN : MONTHS_SHORT_IT;
  return p.day + ' ' + months[p.month - 1] + ' ' + p.year + ' · ' + hm;
}

export const inputCss = {
  border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13,
  fontWeight: 600, padding: '8px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)',
  color: 'var(--ink)',
};
