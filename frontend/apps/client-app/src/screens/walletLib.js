// walletLib.js — regole del portafoglio della cliente (logica pura, senza
// React: la usano Wallet, GiftCard e Prenota, e i test la provano da sola).

/** Importo decimale dell'API ("50.00") → centesimi interi. Le somme si fanno
 *  in centesimi: sommando i decimali come numeri 0,10 + 0,20 non fa 0,30. */
export const cents = (x) => Math.round(Number(x || 0) * 100);

/** La carta è destinata a un'altra persona (comprata «per Maria»). */
const forSomeoneElse = (g) => !g.received && !!g.recipient_name;

/**
 * La gift card si può spendere in salone da QUESTA cliente, adesso?
 * È il flag `spendable` del server (contratto C3), che segue la regola della
 * cassa (`gift_index`): pagata, con saldo, e sua — ne è la destinataria,
 * oppure l'ha comprata lei senza intestarla a nessuno. Sommare tutto il
 * portafoglio prometteva credito che la cassa poi rifiutava: la carta appena
 * comprata dall'app (da pagare in salone) e quella regalata alla figlia, che
 * compariva nel credito della madre E della figlia (16-03, 07-05, 16-07).
 * Con un backend che non manda ancora il flag si ricostruisce la stessa regola
 * dai campi che ci sono.
 */
export function isSpendable(g) {
  if (!g) return false;
  if (typeof g.spendable === 'boolean') return g.spendable;
  return g.payment_status !== 'unpaid' && cents(g.balance) > 0 && !forSomeoneElse(g);
}

/** Carta ancora da pagare in salone (comprata dall'app). */
export const isUnpaid = (g) => g?.payment_status === 'unpaid';

/**
 * Totali del portafoglio, in centesimi: il credito spendibile e quello che
 * diventerà suo pagando in salone (le carte da pagare comprate per sé). Le
 * carte comprate per un'altra persona non sono credito di nessuna delle due
 * finché non le paga, e dopo sono della destinataria.
 */
export function giftCardTotals(cards) {
  const out = { spendable: 0, spendableCount: 0, pending: 0, pendingCount: 0 };
  for (const g of cards || []) {
    if (isSpendable(g)) {
      out.spendable += cents(g.balance);
      out.spendableCount += 1;
    } else if (isUnpaid(g) && !forSomeoneElse(g)) {
      out.pending += cents(g.balance);
      out.pendingCount += 1;
    }
  }
  return out;
}

/** Gift card «a trattamento» che coprono un servizio prenotabile. */
export function giftServiceCards(cards) {
  return (cards || []).filter((g) => g.gift_service_id && isSpendable(g));
}

/** Percentuale di sconto com'è: 12,5 resta «12,5», non «13» (16-12). I
 *  premi fedeltà `discount_pct` possono avere decimali; arrotondando la
 *  cliente leggeva uno sconto che la cassa non le faceva. */
export function fmtPct(value, lang) {
  return Number(value || 0).toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT', { maximumFractionDigits: 2 });
}
