// fedelta/index.jsx — Promozioni section: Coupon / Fedeltà / Gift card sub-tabs.
// Ported from prototype desktop-fedelta.jsx (DkFedelta) with real marketing API calls.
import React from 'react';
import { useDash } from '../../ctx.jsx';
import CouponSub from './CouponSub.jsx';
import LoyaltySub from './LoyaltySub.jsx';
import GiftSub from './GiftSub.jsx';

export default function FedeltaSection() {
  const { t, subTab, setSubTab } = useDash();
  // the sidebar sub-nav emits 'giftcard' for the third tab — normalise to this section's 'gift'
  const sub = subTab === 'giftcard' ? 'gift' : (subTab || 'coupon');
  const tabs = [
    ['coupon', t('Coupon', 'Coupons')],
    ['fedelta', t('Fedeltà', 'Loyalty')],
    ['gift', t('Gift card', 'Gift cards')],
  ];
  return (
    <div className="dk-page" style={{ maxWidth: 1120 }}>
      <div style={{ borderBottom: '1px solid var(--hair)', display: 'flex', gap: 4, marginBottom: 22 }}>
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setSubTab(k)}
            style={{ padding: '11px 4px', marginRight: 22, fontSize: 15.5, fontWeight: 600, cursor: 'pointer', color: sub === k ? 'var(--ink)' : 'var(--muted)', borderBottom: '2px solid ' + (sub === k ? 'var(--clay)' : 'transparent'), marginBottom: -1, background: 'transparent' }}>
            {l}
          </button>
        ))}
      </div>
      {sub === 'coupon' ? <CouponSub /> : sub === 'fedelta' ? <LoyaltySub /> : <GiftSub />}
    </div>
  );
}
