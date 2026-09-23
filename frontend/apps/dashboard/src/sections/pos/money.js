// money.js — il denaro della cassa in CENTESIMI INTERI, arrotondato come il server.
//
// Carrello e check-out calcolavano in virgola mobile e arrotondavano con
// Math.round un valore già sporco: 18,90 −15% vale 16,065, che in binario è
// 16,06499… e diventava 16,06, mentre il server (Decimal, ROUND_HALF_UP in
// sales.services.line_amount) scrive 16,07. Con due righe così il dovuto a
// video restava due centesimi sotto il totale del server: 422 «I pagamenti non
// corrispondono al totale», e nemmeno digitando la cifra giusta si passava,
// perché il controllo dei pagamenti confrontava col dovuto sbagliato (05-09,
// 14-04, 17-02). Qui ogni importo è un intero di centesimi e ogni divisione
// arrotonda come `quantize(Decimal("0.01"), ROUND_HALF_UP)`.
//
// Niente import da '@youty/shared': sono regole pure, provate con `npm test`
// (apps/dashboard/test/pos-money.test.js). lib.js le riesporta.
import { isMaskedCode } from '../fedelta/meta.js';

/** Tolleranza dei pagamenti del server (sales.services.PAYMENT_TOLERANCE, 0,01 €). */
export const PAYMENT_TOLERANCE_CENTS = 1;

/** num/den con arrotondamento HALF_UP (la metà si allontana dallo zero, come
 *  Decimal.ROUND_HALF_UP). `num` intero, `den` intero positivo. */
export function divHalfUp(num, den) {
  const a = Math.abs(num);
  const r = a % den;
  const q = (a - r) / den;
  const out = r * 2 >= den ? q + 1 : q;
  return num < 0 ? -out : out;
}

/** Importo in euro (numero, o testo con virgola o punto: "12,50", "12.5") →
 *  centesimi interi, HALF_UP sul terzo decimale come fa il server con i
 *  Decimal. Testo non valido → 0. Il testo si legge cifra per cifra, senza
 *  passare dai float: "0,285" è 29 centesimi, non 28. */
export function toCents(x) {
  let s;
  let neg = false;
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) return 0;
    neg = x < 0;
    // toFixed(10) scrive il valore decimale del float: 18.9 → "18.9000000000".
    s = Math.abs(x).toFixed(10);
  } else {
    // prima virgola → punto, via tutto il resto (un importo digitato non è
    // mai negativo: il campo accetta solo cifre e un separatore)
    s = String(x ?? '').replace(',', '.').replace(/[^0-9.]/g, '');
  }
  const m = /^(\d*)(?:\.(\d*))?/.exec(s);
  const int = m[1] || '';
  const frac = m[2] || '';
  if (!int && !frac) return 0;
  let cents = Number(int || '0') * 100 + Number((frac + '00').slice(0, 2));
  if (Number(frac.charAt(2) || '0') >= 5) cents += 1;
  return neg ? -cents : cents;
}

/** centesimi → importo per l'API ("16.07"): sempre due decimali, mai un float. */
export function centsToApi(c) {
  const n = Math.round(Number(c) || 0);
  const a = Math.abs(n);
  return (n < 0 ? '-' : '') + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
}

/** centesimi → euro, solo per mostrarli (money/fmtEur li scrivono con due decimali). */
export const centsToEur = (c) => (Number(c) || 0) / 100;

/** Importo di riga in centesimi, come sales.services.line_amount:
 *  qty × unit_price × (100 − sconto)/100 arrotondato HALF_UP sull'INTERA riga
 *  (non sul prezzo unitario), 0 se omaggio. Gift card → il suo valore: la riga
 *  parte senza qty né sconto, e il server usa qty 1 (lo sconto lo rifiuta). */
export function lineCents(l) {
  if (l.line_type === 'gift_card') return toCents(l.value || 0);
  if (l.is_gift) return 0;
  const qty = Math.trunc(Number(l.qty)) || 1;                 // int(qty or 1)
  const disc = Math.trunc(Number(l.discount_pct)) || 0;       // int(discount_pct or 0)
  return divHalfUp(qty * toCents(l.unit_price || 0) * (100 - disc), 100);
}

/** Sconto del buono in centesimi, come marketing.services.coupon_discount:
 *  percentuale sull'imponibile arrotondata HALF_UP, e mai più dell'imponibile
 *  (un buono da 50 € su un conto da 30 sconta 30). */
export function couponDiscountCents(coupon, baseCents) {
  if (!coupon || !(baseCents > 0)) return 0;
  const valueCents = toCents(coupon.value || 0);
  const off = coupon.kind === 'percent' ? divHalfUp(baseCents * valueCents, 10000) : valueCents;
  return Math.min(off, baseCents);
}

/** Totali del conto nello stesso ordine di sales.services.finalize_sale:
 *  righe → buono (sull'imponibile senza le gift card vendute) → caparra.
 *  `dueCents` può essere NEGATIVO: la caparra supera il conto scontato, il
 *  server detrae solo fino al totale e restituisce l'eccedenza (contratto C17). */
export function saleTotals(lines, coupon, depositCents = 0) {
  const grossCents = lines.reduce((s, l) => s + lineCents(l), 0);
  const giftCardCents = lines.filter((l) => l.line_type === 'gift_card').reduce((s, l) => s + lineCents(l), 0);
  const couponBaseCents = grossCents - giftCardCents;
  const discountCents = couponDiscountCents(coupon, couponBaseCents);
  const totalCents = grossCents - discountCents;
  const dueCents = totalCents - depositCents;
  return {
    grossCents, giftCardCents, couponBaseCents, discountCents, totalCents, depositCents, dueCents,
    excessCents: Math.max(0, -dueCents),
  };
}

/** Pagamenti e dovuto coincidono entro la tolleranza del server (±1 centesimo). */
export const paymentsMatch = (paidCents, dueCents) => Math.abs(paidCents - dueCents) <= PAYMENT_TOLERANCE_CENTS;

/* ---------------- payments model ----------------
 * One shared shape for the single/split payment editor:
 *   { split: bool, method: 'cash', giftCode: '', rows: [{ method, amt, code }] }
 * `amt` è in euro come lo si legge nel campo (numero o testo digitato);
 * resolvePayments() turns it into the API `payments[]` array. */

export const emptyPayments = () => ({ split: false, method: 'cash', giftCode: '', rows: [] });

export function resolvePayments(v, dueCents) {
  // Niente da incassare — la caparra copre tutto il conto (anche di più) o il
  // conto è a zero: nessun pagamento. Prima partiva un pagamento da 0,00 e,
  // con la caparra più alta del conto, «Incassa» restava spento per sempre;
  // il server accetta `payments: []` e restituisce l'eccedenza (C17).
  if (!(dueCents > 0)) return [];
  if (!v.split) {
    const p = { method: v.method, amount: centsToApi(dueCents) };
    if (v.method === 'gift_card') p.gift_card_code = (v.giftCode || '').trim();
    return [p];
  }
  return v.rows.map((r) => {
    const p = { method: r.method, amount: centsToApi(toCents(r.amt)) };
    if (r.method === 'gift_card') p.gift_card_code = (r.code || '').trim();
    return p;
  });
}

/** client-side validation matching the API ±0.01 rule; returns an error message or null. */
export function paymentsError(v, dueCents, t) {
  if (!(dueCents > 0)) return null;
  const pays = resolvePayments(v, dueCents);
  if (pays.some((p) => p.method === 'gift_card' && !p.gift_card_code)) {
    return t('Inserisci il codice della gift card', 'Enter the gift card code');
  }
  const paid = pays.reduce((s, p) => s + toCents(p.amount), 0);
  if (!paymentsMatch(paid, dueCents)) {
    return t('La somma dei pagamenti non corrisponde al totale', 'Payments must add up to the total');
  }
  return null;
}

/** Pagamento precompilato del check-out con le gift card «a trattamento»
 *  della cliente (AppointmentOut.gifts): righe gift card per la parte coperta
 *  e il resto in contanti, oppure null se nessun regalo copre niente.
 *
 *  Ogni carta paga SOLO le righe del proprio servizio, e mai più di quanto
 *  costano: prima il tetto era il residuo dell'intero conto e la riga coperta
 *  non veniva segnata, così con due carte «Piega» su Piega 40 + Colore 60 la
 *  seconda pagava il colore senza che nessuno se ne accorgesse (07-12).
 *  Il residuo parte da quanto resta DOPO la caparra già incassata. I codici
 *  mascherati («••••1234», chi non vede la cassa) non si possono spendere. */
export function giftPrefillRows(items, gifts, depositCents = 0) {
  const room = (items || []).map((it) => toCents(it.price || 0));   // quanto di ogni riga resta da coprire
  let remaining = room.reduce((s, c) => s + c, 0) - depositCents;
  const rows = [];
  (gifts || []).forEach((g) => {
    if (remaining <= 0 || !g.code || isMaskedCode(g.code)) return;
    let balance = toCents(g.balance || 0);
    let amt = 0;
    (items || []).forEach((it, i) => {
      if (it.service_id !== g.service_id) return;
      const take = Math.min(balance, room[i], remaining - amt);
      if (take > 0) { room[i] -= take; balance -= take; amt += take; }
    });
    if (amt > 0) {
      rows.push({ method: 'gift_card', amt: centsToEur(amt), code: g.code });
      remaining -= amt;
    }
  });
  if (!rows.length) return null;
  if (remaining > 0) rows.push({ method: 'cash', amt: centsToEur(remaining), code: '' });
  return rows;
}
