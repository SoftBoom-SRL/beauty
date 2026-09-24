// fedelta/index.jsx — Promozioni section: Coupon / Fedeltà / Gift card sub-tabs.
// Ported from prototype desktop-fedelta.jsx (DkFedelta) with real marketing API calls.
import { useDash } from '../../ctx.jsx';
import SubTabs from '../../ui/SubTabs.jsx';
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
      <SubTabs tabs={tabs} value={sub} onChange={setSubTab} />
      {sub === 'coupon' ? <CouponSub /> : sub === 'fedelta' ? <LoyaltySub /> : <GiftSub />}
    </div>
  );
}
