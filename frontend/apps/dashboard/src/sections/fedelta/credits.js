// credits.js — i trattamenti già pagati letti per tipo: un regalo, un
// trattamento che la cliente ha pagato in anticipo, le sedute di un pacchetto.
//
// Dal 15/10 una gift card «a trattamento» può essere tutte e tre le cose
// (`kind` dell'API) e coprire più sedute. Ovunque compariva «Regalo» — blocchi
// dell'agenda in giorno, settimana e mese, anteprima al passaggio del mouse,
// dettaglio della visita, nuova prenotazione, scheda cliente, Promozioni — una
// cliente col pacchetto da cinque manicure risultava «Regalo», e chi era al
// banco non poteva sapere quante sedute le restavano. Qui etichette, icone e
// descrizioni di tutte quelle viste, uguali dappertutto.
// Logica pura (provata da apps/dashboard/test/crediti.test.js).
import { fmtEurNoFree } from '@youty/shared';
import { shortDate } from './dates.js';
import { effectiveStatus, isMaskedCode } from './meta.js';

export const CREDIT_KINDS = ['gift', 'prepaid', 'package'];

/** Il tipo della carta; senza `kind` (un server di prima) è un regalo. */
export const creditKind = (g) => (CREDIT_KINDS.includes(g?.kind) ? g.kind : 'gift');

/** L'icona di ogni tipo: il pacco regalo, il portafoglio di chi ha già
 *  pagato, la scatola delle sedute di un pacchetto. */
export const CREDIT_ICONS = { gift: 'gift', prepaid: 'wallet', package: 'box' };
export const creditIcon = (g) => CREDIT_ICONS[creditKind(g)];

const num = (x, fallback) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
};

/** Sedute rimaste su totali, «3/5 sedute» («1/1 seduta»). Vuoto per una
 *  carta da una seduta sola, a meno di `always` (un pacchetto le dice sempre). */
export function sessionsLabel(g, t, { always = false } = {}) {
  const total = Math.max(1, num(g?.sessions_total, 1));
  const left = Math.max(0, num(g?.sessions_left, total));
  if (total === 1 && !always) return '';
  return `${left}/${total} ` + (total === 1 ? t('seduta', 'session') : t('sedute', 'sessions'));
}

/** Le stesse sedute in parole, per le descrizioni: «3 sedute rimaste su 5». */
export function sessionsLeftText(g, t) {
  const total = Math.max(1, num(g?.sessions_total, 1));
  const left = Math.max(0, num(g?.sessions_left, total));
  return left === 1
    ? t(`1 seduta rimasta su ${total}`, `1 of ${total} sessions left`)
    : t(`${left} sedute rimaste su ${total}`, `${left} of ${total} sessions left`);
}

/** Etichetta breve del tipo, per chip e pillole: «Regalo · da Anna»,
 *  «Già pagato», «Pacchetto · 3/5 sedute». Le sedute si aggiungono quando
 *  sono più di una (sul pacchetto sempre). `from` = chi l'ha regalata (di
 *  solito `from_name`, vuoto se l'ha pagata la cliente stessa); `withFrom:
 *  false` per le righe dove il nome sta già accanto. */
export function creditLabel(g, t, { from, withFrom = true } = {}) {
  const kind = creditKind(g);
  const who = withFrom ? (from ?? g?.from_name ?? '') : '';
  const head = kind === 'package'
    ? t('Pacchetto', 'Package')
    : kind === 'prepaid'
      ? t('Già pagato', 'Prepaid')
      : t('Regalo', 'Gift') + (who ? ' · ' + t('da', 'from') + ' ' + who : '');
  return [head, sessionsLabel(g, t, { always: kind === 'package' })].filter(Boolean).join(' · ');
}

/** Da dove viene il trattamento, in parole: «Regalo da Anna Rossi»,
 *  «Pagato in anticipo», «Pacchetto «Mani perfette»». */
export function creditOrigin(g, t, { from } = {}) {
  const kind = creditKind(g);
  if (kind === 'package') return t('Pacchetto', 'Package') + (g?.package_name ? ` «${g.package_name}»` : '');
  if (kind === 'prepaid') return t('Pagato in anticipo', 'Paid in advance');
  const who = from ?? g?.from_name ?? '';
  return who ? t(`Regalo da ${who}`, `Gift from ${who}`) : t('Regalo', 'Gift');
}

/** La descrizione intera, per il tooltip e l'anteprima: servizio, origine,
 *  sedute, valore residuo, scadenza e codice (non quello mascherato, C21).
 *  «Taglio · Pacchetto «Tagli dell'anno» · 3 sedute rimaste su 4 · residuo
 *  €75,00 · scade il 15/10/2027 · ABCD2345EFGH». Senza `lang` (i blocchi
 *  della griglia ricevono solo `t`) la lingua è quella di `t`. */
export function creditTitle(g, t, lang, { from, code = true } = {}) {
  if (!g) return '';
  lang = lang || t('it', 'en');
  const kind = creditKind(g);
  const total = Math.max(1, num(g.sessions_total, 1));
  const parts = [
    g.service_name || g.gift_service_name || '',
    creditOrigin(g, t, { from }),
    total > 1 || kind === 'package' ? sessionsLeftText(g, t) : '',
    g.balance != null ? t('residuo', 'left') + ' ' + fmtEurNoFree(g.balance, lang) : '',
    g.expires_at ? t('scade il', 'expires') + ' ' + shortDate(g.expires_at, lang) : '',
    code && g.code && !isMaskedCode(g.code) ? g.code : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Più carte sulla stessa visita: una riga per carta. */
export const creditsTitle = (gifts, t, lang, opts) => (gifts || []).map((g) => creditTitle(g, t, lang, opts)).join('\n');

/** Chi l'ha regalata a `clientId`: il nome di chi l'ha comprata, se è
 *  un'altra persona. Le carte dell'elenco di Promozioni non hanno `from_name`
 *  (non sanno per chi le si guarda): una carta comprata per sé si leggeva
 *  «Regalo da» lei stessa. */
export function giverName(g, clientId) {
  if (!g) return '';
  if (typeof g.from_name === 'string') return g.from_name;
  return g.buyer_client_id != null && g.buyer_client_id !== clientId ? (g.buyer_name || '') : '';
}

/** La carta è della cliente `clientId`: ne è la destinataria, oppure l'ha
 *  comprata lei senza intestarla a nessuno (né scheda né nome). È la regola
 *  del server (contratto C3, `spendable_gift_cards`). */
export function ownsCredit(g, clientId) {
  if (!g || clientId == null) return false;
  return g.recipient_client_id === clientId
    || (g.recipient_client_id == null && !g.recipient_name && g.buyer_client_id === clientId);
}

const expiryKey = (g) => (g.expires_at ? Date.parse(g.expires_at) : Infinity);

/** Le carte della scheda cliente divise per la sua sezione «Trattamenti già
 *  pagati»: `open` quelli ancora da fare (prima quelli che scadono prima),
 *  `closed` quelli esauriti o scaduti, `others` tutto il resto — carte a
 *  importo, e trattamenti comprati per un'altra persona — che resta fra le
 *  gift card. */
export function splitClientCredits(cards, clientId, now = Date.now()) {
  const open = [];
  const closed = [];
  const others = [];
  for (const g of cards || []) {
    if (g?.gift_service_id == null || !ownsCredit(g, clientId)) { others.push(g); continue; }
    (effectiveStatus(g, now) === 'active' ? open : closed).push(g);
  }
  open.sort((a, b) => {
    const x = expiryKey(a);
    const y = expiryKey(b);
    return x === y ? 0 : x < y ? -1 : 1;
  });
  return { open, closed, others };
}
