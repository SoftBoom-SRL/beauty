// wallet.js — regole del portafoglio della cliente: credito delle gift card,
// trattamenti già pagati, coupon, scadenze (usate da Wallet, GiftCard,
// Prenota e Prenotazioni).
// Logica pura, senza React: la caricano anche i test con `node --test`.
import { fmtEur, parseISO, salonTzOpts } from '@youty/shared';

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

/** Carta «a trattamento»: un servizio (con le sue sedute), non un importo. */
export const isTreatment = (g) => g?.gift_service_id != null;

/**
 * Totali del portafoglio, in centesimi: il credito spendibile e quello che
 * diventerà suo pagando in salone (le carte da pagare comprate per sé). Le
 * carte comprate per un'altra persona non sono credito di nessuna delle due
 * finché non le paga, e dopo sono della destinataria.
 * I trattamenti (una piega regalata, le sedute di un pacchetto) non sono
 * euro da spendere: si contano a parte, come trattamenti (`myTreatments`).
 * Sommati al credito, le dieci manicure di un pacchetto diventavano «€300 di
 * credito utilizzabile» per qualunque cosa.
 */
export function giftCardTotals(cards) {
  const out = { spendable: 0, spendableCount: 0, pending: 0, pendingCount: 0 };
  for (const g of cards || []) {
    if (isTreatment(g)) continue;
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

/** Credito in centesimi → «€70,00». Zero si scrive «€0,00»: fmtEur lo legge
 *  come un prezzo e scrive «Gratis», e chi aveva solo carte ancora da pagare
 *  leggeva «Saldo gift card: Gratis». */
export function fmtCredit(amountCents, lang) {
  return '€' + (amountCents / 100).toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Gift card «a trattamento» che coprono un servizio prenotabile. */
export function giftServiceCards(cards) {
  return (cards || []).filter((g) => g.gift_service_id && isSpendable(g));
}

/* ---- trattamenti già pagati -------------------------------------------------- */

/** I suoi trattamenti già pagati: le carte a trattamento che la cassa le
 *  accetta, più quelle comprate per sé ancora da pagare in salone. Quelle
 *  comprate per un'altra persona restano fra le gift card. */
export function myTreatments(cards) {
  return (cards || []).filter((g) => isTreatment(g) && (isSpendable(g) || (isUnpaid(g) && !forSomeoneElse(g))));
}

/** Il tipo: un regalo, un trattamento che ha pagato in anticipo, le sedute di
 *  un pacchetto. Senza `kind` (un server di prima) è un regalo. */
export const treatmentKind = (g) => (g?.kind === 'prepaid' || g?.kind === 'package' ? g.kind : 'gift');

/** L'icona di ogni tipo, la stessa della dashboard. */
export const treatmentIcon = (g) => ({ gift: 'gift', prepaid: 'wallet', package: 'box' })[treatmentKind(g)];

/** Chi gliel'ha regalata: `from_name` del server, vuoto se l'ha pagata lei.
 *  Un server di prima non lo manda: si ripiega sulla carta ricevuta (su
 *  quella comprata per sé, il nome di chi l'ha pagata è il suo). */
export function giftFromName(g) {
  if (!g) return '';
  if (typeof g.from_name === 'string') return g.from_name;
  return (g.received && g.buyer_name) || '';
}

const sessionCounts = (g) => {
  const total = Math.max(1, Number(g?.sessions_total) || 1);
  const left = Math.max(0, Number(g?.sessions_left ?? total) || 0);
  return { total, left };
};

/** Le sedute che le restano: «Ti restano 3 sedute su 5», «Ultima seduta»,
 *  «1 seduta» per un trattamento singolo. */
export function sessionsLeftLabel(g, t) {
  const { total, left } = sessionCounts(g);
  if (total === 1) return t('1 seduta', '1 session');
  if (left === 1) return t(`Ultima seduta su ${total}`, `Last of ${total} sessions`);
  return t(`Ti restano ${left} sedute su ${total}`, `${left} of ${total} sessions left`);
}

/** Da dove viene: «Regalo di Carla», «Pagato in anticipo», «Pacchetto «Mani perfette»». */
export function treatmentOrigin(g, t) {
  const kind = treatmentKind(g);
  if (kind === 'package') return g.package_name ? t(`Pacchetto «${g.package_name}»`, `«${g.package_name}» package`) : t('Pacchetto', 'Package');
  if (kind === 'prepaid') return t('Pagato in anticipo', 'Paid in advance');
  const from = giftFromName(g);
  return from ? t(`Regalo di ${from}`, `A gift from ${from}`) : t('Regalo', 'Gift');
}

/** L'etichetta accanto al servizio quando prenota: «Regalo di Carla» (o «Hai
 *  un regalo»), «Già pagato», «Pacchetto · 3 sedute rimaste». */
export function coveredLabel(g, t) {
  const kind = treatmentKind(g);
  if (kind === 'prepaid') return t('Già pagato', 'Already paid');
  if (kind === 'package') {
    const { left } = sessionCounts(g);
    return left === 1
      ? t('Pacchetto · ultima seduta', 'Package · last session')
      : t(`Pacchetto · ${left} sedute rimaste`, `Package · ${left} sessions left`);
  }
  const from = giftFromName(g);
  return from ? t(`Regalo di ${from}`, `A gift from ${from}`) : t('Hai un regalo', 'You have a gift');
}

/** Riepilogo della prenotazione: il titolo («Coperto da gift card» per i
 *  regali, «Già pagato» se c'è un trattamento pagato da lei o un pacchetto) e
 *  che cosa copre, «Manicure · regalo di Carla» o «Manicure (pacchetto «Mani
 *  perfette», ti restano 3 sedute su 5)». */
export function coveredSummary(gifts, t) {
  const list = gifts || [];
  if (!list.length) return { title: '', text: '' };
  if (list.every((g) => treatmentKind(g) === 'gift')) {
    const from = giftFromName(list[0]);
    return {
      title: t('Coperto da gift card', 'Covered by a gift card'),
      text: list.map((g) => g.gift_service_name).join(', ') + (from ? t(` · regalo di ${from}`, ` · a gift from ${from}`) : ''),
    };
  }
  const detail = (g) => {
    const kind = treatmentKind(g);
    if (kind === 'gift') return treatmentOrigin(g, t);
    if (kind === 'prepaid') return t('pagato in anticipo', 'paid in advance');
    const { total } = sessionCounts(g);
    return [treatmentOrigin(g, t), total > 1 ? sessionsLeftLabel(g, t) : ''].filter(Boolean).join(', ');
  };
  return {
    title: t('Già pagato', 'Already paid'),
    text: list.map((g) => `${g.gift_service_name} (${detail(g)})`).join(', '),
  };
}

/* ---- pacchetti a listino ----------------------------------------------------- */

/** Le sedute di un servizio nel pacchetto: «1 seduta», «5 sedute». */
export function packageSessions(qty, t) {
  const n = Math.max(1, Number(qty) || 1);
  return n === 1 ? t('1 seduta', '1 session') : t(`${n} sedute`, `${n} sessions`);
}

/** Entro quando vanno fatte le sedute: «Valido 90 giorni dall'acquisto» o
 *  «Senza scadenza» (`validity_days` del listino pubblico). */
export function packageValidity(days, t) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return t('Senza scadenza', 'No expiry');
  return n === 1
    ? t('Valido 1 giorno dall’acquisto', 'Valid 1 day from purchase')
    : t(`Valido ${n} giorni dall’acquisto`, `Valid ${n} days from purchase`);
}

/** Sulla prenotazione: «In regalo da Carla», «Già pagato», «Dal pacchetto
 *  «Mani perfette»», o «Coperto da gift card». */
export function apptGiftLabel(g, t) {
  const kind = treatmentKind(g);
  if (kind === 'prepaid') return t('Già pagato', 'Already paid');
  if (kind === 'package') return g.package_name ? t(`Dal pacchetto «${g.package_name}»`, `From your «${g.package_name}» package`) : t('Dal tuo pacchetto', 'From your package');
  return g.from_name ? t(`In regalo da ${g.from_name}`, `A gift from ${g.from_name}`) : t('Coperto da gift card', 'Covered by a gift card');
}

/** Percentuale di sconto com'è: 12,5 resta «12,5», non «13» (16-12). I
 *  premi fedeltà `discount_pct` possono avere decimali; arrotondando la
 *  cliente leggeva uno sconto che la cassa non le faceva. */
export function fmtPct(value, lang) {
  return Number(value || 0).toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT', { maximumFractionDigits: 2 });
}

export function fmtExpiry(iso, lang, t) {
  if (!iso) return t('Senza scadenza', 'No expiry');
  // Le scadenze sono ISTANTI (DateTime lato server): vanno lette sul calendario
  // del SALONE. Sull'orologio del telefono una gift card che scade a mezzanotte
  // risultava scaduta il giorno prima a chi la guardava da ovest, e valida un
  // giorno in più a chi la guardava da est.
  const d = parseISO(iso);
  const s = d.toLocaleDateString(
    lang === 'en' ? 'en-GB' : 'it-IT',
    salonTzOpts({ day: 'numeric', month: 'short', year: 'numeric' }),
  ).replace(/\./g, '');
  return t('Scade il ', 'Expires ') + s;
}

export function couponLabel(c, lang, t) {
  return c.kind === 'percent'
    ? t(`Sconto del ${fmtPct(c.value, lang)}%`, `${fmtPct(c.value, lang)}% off`)
    : t(`Buono da ${fmtEur(Number(c.value), lang)}`, `${fmtEur(Number(c.value), lang)} voucher`);
}

export function couponOrigin(origin, t) {
  return origin === 'loyalty' ? t('Premio fedeltà', 'Loyalty reward') : t('Sconto', 'Discount');
}
