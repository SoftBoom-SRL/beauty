// giftCardForm.js — la maschera «Nuova gift card» senza React: che cosa manca
// per salvare e che cosa parte verso il server (POST /api/marketing/gift-cards).
//
// Dal 15/10 la stessa maschera crea anche i trattamenti che la cliente paga
// oggi e farà più avanti («Già pagato»: chi paga e chi riceve sono lei) e le
// carte a più sedute di un trattamento (tre pieghe, dieci manicure): il valore
// è il listino per le sedute, e il server lo ricalcola comunque.
// Logica pura (provata da apps/dashboard/test/crediti.test.js).
import { expiryInMonthsIso } from './dates.js';

/** Sedute massime su una carta (come `MAX_SESSIONS` del server). */
export const MAX_SESSIONS = 100;

/** Un intero fra 1 e MAX_SESSIONS. */
export const validSessions = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_SESSIONS;

/** Il valore della carta: listino × sedute per un trattamento, l'importo
 *  scritto per una carta a valore. In centesimi, per non sommare decimali. */
export function giftCardValueCents(f) {
  if (f.type === 'service') {
    if (!f.service) return 0;
    const sessions = validSessions(f.sessions) ? f.sessions : 1;
    return Math.round(Number(f.service.price || 0) * 100) * sessions;
  }
  return Math.round(Number(f.value || 0) * 100);
}

/** Che cosa manca per salvare, nell'ordine della maschera ([] = si salva).
 *  Il pulsante non si spegne in silenzio: al clic si dice la prima voce. */
export function giftCardMissing(f, t) {
  const out = [];
  if (f.type === 'service') {
    if (!f.service) out.push(t('Scegli il trattamento', 'Choose the treatment'));
    if (!validSessions(f.sessions)) out.push(t(`Le sedute vanno da 1 a ${MAX_SESSIONS}`, `Sessions go from 1 to ${MAX_SESSIONS}`));
  } else if (!(giftCardValueCents(f) > 0)) {
    out.push(t('Indica il valore della gift card', 'Enter the gift card value'));
  }
  if (f.kind === 'prepaid') {
    if (!f.recipient) out.push(t('Scegli la cliente che ha pagato', 'Choose the client who paid'));
  } else if (f.byName ? !String(f.recipientName || '').trim() : !f.recipient) {
    out.push(t('Indica chi riceve il regalo', 'Say who receives the gift'));
  }
  if (f.paid ? !f.canCash : !f.canPayLater) {
    out.push(f.paid
      ? t('Serve il permesso «vendite» per incassare', 'The «sales» permission is required to take payment')
      : t('Serve il permesso «marketing» per una carta da pagare dopo', 'The «marketing» permission is required for a card paid later'));
  }
  return out;
}

/** Il corpo della richiesta. «Già pagato»: la stessa cliente come acquirente
 *  e destinataria, niente consegna (non è un regalo da consegnare). */
export function giftCardPayload(f, today) {
  const prepaid = f.kind === 'prepaid';
  const client = f.recipient || null;
  const service = f.type === 'service' ? f.service : null;
  return {
    kind: prepaid ? 'prepaid' : 'gift',
    value: (giftCardValueCents(f) / 100).toFixed(2),
    ...(service ? { gift_service_id: service.id, sessions: f.sessions } : {}),
    buyer_client_id: prepaid ? (client ? client.id : null) : (f.buyer ? f.buyer.id : null),
    recipient_client_id: client ? client.id : null,
    recipient_name: client ? client.full_name : (prepaid ? '' : String(f.recipientName || '').trim()),
    paid: !!f.paid,
    paid_method: f.paid ? f.paidMethod : '',
    delivery_date: !prepaid && f.scheduled && f.deliveryDate ? f.deliveryDate : null,
    // oggi in salone + n mesi (senza sforare a fine mese), alle 23:59 del salone
    expires_at: f.expiryMonths ? expiryInMonthsIso(f.expiryMonths, today) : null,
  };
}
