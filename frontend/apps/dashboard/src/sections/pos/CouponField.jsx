// CouponField.jsx — il campo del buono sconto della cassa (check-out e vendita
// al banco), sopra al pagamento: così il dovuto è già quello giusto. Lo stato
// è quello di useCoupon.
import { Icon } from '@youty/shared';
import { inputCss, money } from './lib.js';

/* `onApply()`: verifica il codice (useCoupon.applyCoupon con il conto di chi
 * chiama); `discount`: lo sconto del buono applicato, in euro. `label`,
 * `placeholder` e i due stili sono quelli di ciascuna schermata. */
export default function CouponField({ cp, onApply, discount, label, placeholder, style, labelStyle, t, lang }) {
  const { couponCode, setCouponCode, coupon, couponErr, setCouponErr, couponBusy, clearCoupon } = cp;
  return (
    <div style={style}>
      <div className="t-meta" style={labelStyle}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input value={couponCode} disabled={!!coupon}
          onChange={(e) => { setCouponCode(e.target.value.toUpperCase()); setCouponErr(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !coupon) onApply(); }}
          placeholder={placeholder}
          style={{ ...inputCss, flex: 1, minWidth: 0, letterSpacing: '0.06em', opacity: coupon ? 0.75 : 1 }} />
        {coupon ? (
          <button className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5 }} onClick={clearCoupon}>
            <Icon name="x" size={13} />{t('Togli', 'Remove')}
          </button>
        ) : (
          <button className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5 }} disabled={couponBusy || !couponCode.trim()} onClick={onApply}>
            <Icon name="coupon" size={13} />{couponBusy ? t('Verifica…', 'Checking…') : t('Applica', 'Apply')}
          </button>
        )}
      </div>
      {couponErr && (
        <div className="t-sm" style={{ color: 'var(--danger)', fontWeight: 600, marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="alert" size={13} color="var(--danger)" />{couponErr}
        </div>
      )}
      {coupon && (
        <div className="t-sm" style={{ color: 'var(--ok)', fontWeight: 600, marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="check" size={13} color="var(--ok)" stroke={2.4} />{t('Buono applicato', 'Voucher applied')} · −{money(discount, lang)}
        </div>
      )}
    </div>
  );
}
