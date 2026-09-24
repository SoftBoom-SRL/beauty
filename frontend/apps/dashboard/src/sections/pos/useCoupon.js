// useCoupon.js — il buono sconto presentato alla cassa, nel check-out
// (SellModal) e nella vendita al banco (CartTab): era scritto due volte.
//
// Il codice si verifica prima di incassare (findCoupon, lib.js), così il
// pagamento parte già dall'importo giusto; la parola definitiva resta del
// server, che lo rivalida e lo consuma dentro la transazione della vendita.
import { useEffect, useState } from 'react';
import { findCoupon } from './lib.js';

/** → { couponCode, setCouponCode, coupon, setCoupon, couponErr, setCouponErr,
 *      couponBusy, applyCoupon({ baseCents, clientId }), clearCoupon() } */
export function useCoupon(t) {
  const [couponCode, setCouponCode] = useState('');
  const [coupon, setCoupon] = useState(null);
  const [couponErr, setCouponErr] = useState(null);
  const [couponBusy, setCouponBusy] = useState(false);

  /* `baseCents`: la parte del conto che il buono può scontare (le gift card
   * vendute no); `clientId`: la cliente del conto, per i buoni intestati. */
  const applyCoupon = async ({ baseCents, clientId }) => {
    if (couponBusy) return;
    setCouponBusy(true);
    setCouponErr(null);
    try {
      if (!(baseCents > 0)) {
        setCouponErr(t('Coupon non applicabile alla vendita di una gift card', 'Voucher cannot be applied to a gift card sale'));
        return;
      }
      const { coupon: found, error } = await findCoupon(couponCode, { clientId, t });
      if (error) { setCoupon(null); setCouponErr(error); return; }
      setCoupon(found);
      setCouponCode(found.code);
    } finally { setCouponBusy(false); }
  };
  const clearCoupon = () => { setCoupon(null); setCouponCode(''); setCouponErr(null); };

  return { couponCode, setCouponCode, coupon, setCoupon, couponErr, setCouponErr, couponBusy, applyCoupon, clearCoupon };
}

/** Buono applicato e conto che cambia sotto di lui: tolti i prodotti, tutto in
 *  omaggio o rimasta solo una gift card, non c'è più niente da scontare e il
 *  server rifiutava la vendita solo al Conferma (422), con «Buono applicato»
 *  ancora a video (14-12). Si toglie subito dicendo perché; il codice resta nel
 *  campo, per riapplicarlo con un clic. `roomCents`: la parte scontabile. */
export function useCouponRoom({ coupon, setCoupon, setCouponErr }, roomCents, t) {
  useEffect(() => {
    if (coupon && !(roomCents > 0)) {
      setCoupon(null);
      setCouponErr(t('Buono tolto: nel conto non resta niente da scontare (le gift card non si scontano)', 'Voucher removed: nothing left to discount (gift cards cannot be discounted)'));
    }
  }, [coupon, roomCents]); // eslint-disable-line react-hooks/exhaustive-deps
}
