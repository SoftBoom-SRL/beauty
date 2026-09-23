// history.js — le righe dello storico vendite (HistoryTab). Regole pure,
// provate da `npm test` (apps/dashboard/test/pos-history.test.js).
import { toCents } from './money.js';

/** Importo della riga PRIMA del buono sconto, come su uno scontrino: righe,
 *  poi «Buono −X», poi il totale. Il server ora scrive `amount` al netto della
 *  quota di buono della riga (`coupon_share`), così le righe sommano il totale
 *  (per il fatturato per operatrice); senza il campo `amount` è già il lordo. */
export const lineGrossCents = (l) => toCents(l.amount) + toCents(l.coupon_share || 0);

/** Nome da mostrare per una riga di vendita.
 *  I servizi si leggevano «Servizio #12» (05-17, 14-11): ora vale il nome del
 *  listino (nella lingua della dashboard) o `service_name` della risposta
 *  (contratto C14). Una riga servizio SENZA servizio è la vendita-caparra o
 *  l'addebito di un no-show, che prima comparivano come «Servizio #». */
export function saleLineLabel(l, sale, { services = [], lang = 'it', t }) {
  if (l.line_type === 'gift_card') return 'Gift card' + (l.gift_card_code ? ' · ' + l.gift_card_code : '');
  if (l.line_type === 'product') return l.product_name || t('Prodotto', 'Product') + ' #' + (l.product_id ?? '');
  const svc = l.service_id != null ? services.find((s) => s.id === l.service_id) : null;
  if (svc) return lang === 'en' && svc.name_en ? svc.name_en : svc.name_it;
  if (l.service_name) return l.service_name;
  if (l.service_id == null && sale?.kind === 'pos') {
    // la caparra si aggancia su `deposit_appointment_id`, il no-show su `appointment_id`
    if (sale.deposit_appointment_id != null || sale.appointment_id == null) return t('Caparra', 'Deposit');
    return t('Addebito mancata presentazione', 'No-show charge');
  }
  return t('Servizio', 'Service') + (l.service_id != null ? ' #' + l.service_id : '');
}
