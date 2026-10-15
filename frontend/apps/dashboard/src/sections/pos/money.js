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
import { creditLabel } from '../fedelta/credits.js';

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
 *  parte senza qty né sconto, e il server usa qty 1 (lo sconto lo rifiuta).
 *  Pacchetto → il server lo spezza in una riga per pezzo e arrotonda il pezzo:
 *  qui lo stesso, così due pacchetti scontati fanno il centesimo del server. */
export function lineCents(l) {
  if (l.line_type === 'gift_card') return toCents(l.value || 0);
  if (l.is_gift) return 0;
  const qty = Math.trunc(Number(l.qty)) || 1;                 // int(qty or 1)
  const disc = Math.trunc(Number(l.discount_pct)) || 0;       // int(discount_pct or 0)
  if (l.line_type === 'package') return qty * divHalfUp(toCents(l.unit_price || 0) * (100 - disc), 100);
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
 *   { split: bool, method: 'cash', giftCode: '', rows: [{ method, amt, code, sessions? }],
 *     leaveDue: bool, payNow: '' }
 * `amt` è in euro come lo si legge nel campo (numero o testo digitato);
 * resolvePayments() turns it into the API `payments[]` array.
 * `leaveDue`: la cliente paga adesso meno del dovuto (`payNow` col pagamento
 * unico, la somma delle righe con quello diviso) e il resto resta da saldare
 * (`leave_due` del checkout e del banco). `sessions` su una riga gift card: le
 * sedute che scala (carte a sedute, vedi giftPrefill). */

export const emptyPayments = () => ({ split: false, method: 'cash', giftCode: '', rows: [], leaveDue: false, payNow: '' });

function rowToApi(r) {
  const p = { method: r.method, amount: centsToApi(toCents(r.amt)) };
  if (r.method === 'gift_card') {
    p.gift_card_code = (r.code || '').trim();
    if (r.sessions > 1) p.sessions = r.sessions;
  }
  return p;
}

export function resolvePayments(v, dueCents) {
  // Niente da incassare — la caparra copre tutto il conto (anche di più) o il
  // conto è a zero: nessun pagamento. Prima partiva un pagamento da 0,00 e,
  // con la caparra più alta del conto, «Incassa» restava spento per sempre;
  // il server accetta `payments: []` e restituisce l'eccedenza (C17).
  // Restano solo le sedute a valore zero (un pacchetto in omaggio): non
  // muovono denaro, ma la seduta fatta va scalata dalla carta.
  if (!(dueCents > 0)) {
    return v.split ? v.rows.filter((r) => r.method === 'gift_card' && r.sessions && toCents(r.amt) === 0).map(rowToApi) : [];
  }
  if (!v.split) {
    const cents = v.leaveDue ? toCents(v.payNow) : dueCents;
    if (!(cents > 0)) return [];
    const p = { method: v.method, amount: centsToApi(cents) };
    if (v.method === 'gift_card') p.gift_card_code = (v.giftCode || '').trim();
    return [p];
  }
  return v.rows.map(rowToApi);
}

/** Quanto resta da saldare con questi pagamenti (0 senza «Lascia da saldare»,
 *  o se pagano tutto entro la tolleranza del server). */
export function dueLeftCents(v, dueCents) {
  if (!v.leaveDue || !(dueCents > 0)) return 0;
  const paid = resolvePayments(v, dueCents).reduce((s, p) => s + toCents(p.amount), 0);
  const left = dueCents - paid;
  return left > PAYMENT_TOLERANCE_CENTS ? left : 0;
}

/** client-side validation matching the API ±0.01 rule; returns an error message or null.
 *  Con «Lascia da saldare» si può pagare meno del dovuto, mai di più. */
export function paymentsError(v, dueCents, t) {
  if (!(dueCents > 0)) return null;
  const pays = resolvePayments(v, dueCents);
  if (pays.some((p) => p.method === 'gift_card' && !p.gift_card_code)) {
    return t('Inserisci il codice della gift card', 'Enter the gift card code');
  }
  const paid = pays.reduce((s, p) => s + toCents(p.amount), 0);
  if (v.leaveDue) {
    if (paid - dueCents > PAYMENT_TOLERANCE_CENTS) {
      return t('I pagamenti superano il totale da pagare', 'Payments exceed the amount due');
    }
    return null;
  }
  if (!paymentsMatch(paid, dueCents)) {
    return t('La somma dei pagamenti non corrisponde al totale', 'Payments must add up to the total');
  }
  return null;
}

/* ---------------- carte della cliente al check-out ---------------- */

/** Carta a sedute: un pacchetto, un trattamento già pagato, una carta con più
 *  sedute. `kind`, `sessions_total`, `sessions_left` e `session_value` arrivano
 *  in AppointmentOut.gifts; se mancano (server di prima) la carta resta
 *  monetaria, come sempre. */
export const isSessionCard = (g) => Number(g?.sessions_total) > 1 || g?.kind === 'prepaid' || g?.kind === 'package';

/** Sedute rimaste di una carta a sedute (almeno 0). */
const sessionsLeft = (g) => Math.max(0, Math.trunc(Number(g.sessions_left ?? g.sessions_total ?? 1)) || 0);

/** Valore della prossima seduta in centesimi: `session_value` del server, o lo
 *  stesso calcolo (saldo / sedute rimaste, per difetto). */
function sessionCents(g, left) {
  if (g.session_value != null && g.session_value !== '') return toCents(g.session_value);
  const balance = toCents(g.balance || 0);
  return left > 1 ? Math.floor(balance / left) : balance;
}

/** Vero se, finita la modifica della riga `i`, l'ALTRA riga di un pagamento
 *  diviso in due si può pareggiare da sola sul dovuto (PaymentsPanel). No con
 *  «Lascia da saldare» (la differenza resta da saldare) e no se l'altra è una
 *  carta a sedute: il suo importo sono le sue sedute, e abbassando i contanti
 *  la differenza finiva lì — una seduta da 30 € ne scalava 40 dal pacchetto. */
export function canBalance(v, i, leaveDue) {
  if (!v?.rows || v.rows.length !== 2 || leaveDue) return false;
  const other = v.rows[i === 0 ? 1 : 0];
  return !(other.method === 'gift_card' && other.sessions);
}

/** L'etichetta della carta nel riquadro del check-out: la stessa di agenda,
 *  scheda cliente e promozioni (`fedelta/credits.creditLabel`): «Regalo · da
 *  X», «Già pagato», «Pacchetto · 7/10 sedute». Due scritture diverse dello
 *  stesso credito, in cassa e in agenda, sembravano due crediti diversi. */
export function giftLabel(g, t) {
  return creditLabel(g, t);
}

/** Pagamento precompilato del check-out con le gift card «a trattamento»
 *  della cliente (AppointmentOut.gifts): righe gift card per la parte coperta
 *  e il resto in contanti. Ritorna { rows, prices }: `rows` null se nessun
 *  regalo copre niente; `prices[i]` il prezzo in centesimi che la riga i deve
 *  prendere (null = il suo).
 *
 *  Ogni carta paga SOLO le righe del proprio servizio, e mai più di quanto
 *  costano: prima il tetto era il residuo dell'intero conto e la riga coperta
 *  non veniva segnata, così con due carte «Piega» su Piega 40 + Colore 60 la
 *  seconda pagava il colore senza che nessuno se ne accorgesse (07-12).
 *  Il residuo parte da quanto resta DOPO la caparra già incassata. I codici
 *  mascherati («••••1234», chi non vede la cassa) non si possono spendere.
 *
 *  Le carte a sedute (isSessionCard) pagano a sedute: ogni riga del loro
 *  servizio, fino alle sedute rimaste, prende come prezzo il valore di una
 *  seduta (un pacchetto da 10 manicure a 250 € vale 25 a seduta, non il listino
 *  da 30), e il pagamento con la carta è la somma di quelle righe con
 *  `sessions` = quante sono. Se le righe finiscono le sedute, l'ultima prende
 *  il resto del saldo, come fa il server. */
export function giftPrefill(items, gifts, depositCents = 0) {
  const list = items || [];
  const prices = list.map(() => null);
  const usable = (gifts || []).filter((g) => g.code && !isMaskedCode(g.code));
  // 1. le carte a sedute si prendono le righe del loro servizio
  const claimed = list.map(() => false);
  const plan = new Map();
  usable.forEach((g) => {
    if (!isSessionCard(g)) return;
    const left = sessionsLeft(g);
    const value = sessionCents(g, left);
    const balance = toCents(g.balance || 0);
    const taken = [];
    list.forEach((it, i) => {
      if (claimed[i] || it.service_id !== g.service_id || taken.length >= left) return;
      claimed[i] = true;
      taken.push(i);
    });
    taken.forEach((i, n) => {
      prices[i] = n === left - 1 ? Math.max(0, balance - value * (left - 1)) : value;
    });
    if (taken.length) plan.set(g, taken);
  });
  // 2. i pagamenti, sui prezzi già sistemati
  const room = list.map((it, i) => (prices[i] != null ? prices[i] : toCents(it.price || 0)));   // quanto di ogni riga resta da coprire
  let remaining = room.reduce((s, c) => s + c, 0) - depositCents;
  const rows = [];
  usable.forEach((g) => {
    const taken = plan.get(g);
    if (taken) {
      const amt = Math.max(0, Math.min(taken.reduce((s, i) => s + room[i], 0), remaining));
      taken.forEach((i) => { room[i] = 0; });
      rows.push({ method: 'gift_card', amt: centsToEur(amt), code: g.code, sessions: taken.length });
      remaining -= amt;
      return;
    }
    if (isSessionCard(g) || remaining <= 0) return;
    let balance = toCents(g.balance || 0);
    let amt = 0;
    list.forEach((it, i) => {
      if (it.service_id !== g.service_id) return;
      const take = Math.min(balance, room[i], remaining - amt);
      if (take > 0) { room[i] -= take; balance -= take; amt += take; }
    });
    if (amt > 0) {
      rows.push({ method: 'gift_card', amt: centsToEur(amt), code: g.code });
      remaining -= amt;
    }
  });
  if (!rows.length) return { rows: null, prices };
  if (remaining > 0) rows.push({ method: 'cash', amt: centsToEur(remaining), code: '' });
  return { rows, prices };
}

/** Solo le righe del pagamento di giftPrefill (null se nessun regalo copre niente). */
export const giftPrefillRows = (items, gifts, depositCents = 0) => giftPrefill(items, gifts, depositCents).rows;

/* ---------------- conti da saldare ---------------- */

/** «Salda adesso»: i pagamenti della cliente ripartiti sui suoi conti aperti,
 *  dal più vecchio (`dues` come li dà GET /api/sales/dues, già in ordine).
 *  Ritorna [{ sale_id, payments }] da mandare uno per conto a POST
 *  /api/sales/{id}/settle: un pagamento più grande di un conto passa al
 *  successivo per la parte che avanza, e nessun conto riceve più del suo
 *  dovuto. Un saldo è denaro, non sedute: le righe partono senza `sessions`. */
export function allocateSettlement(dues, payments) {
  const left = (payments || []).map((p) => toCents(p.amount));
  const plan = [];
  (dues || []).forEach((sale) => {
    let need = toCents(sale.amount_due);
    const parts = [];
    (payments || []).forEach((p, j) => {
      if (need <= 0 || left[j] <= 0) return;
      const take = Math.min(need, left[j]);
      parts.push({ method: p.method, amount: centsToApi(take), ...(p.gift_card_code ? { gift_card_code: p.gift_card_code } : {}) });
      left[j] -= take;
      need -= take;
    });
    if (parts.length) plan.push({ sale_id: sale.id, payments: parts });
  });
  return plan;
}
