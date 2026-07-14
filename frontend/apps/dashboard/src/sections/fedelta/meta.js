// meta.js — local metadata for the marketing enums this section renders
// (coupon.origin/status, gift-card.status/payment_status, loyalty enums). These are
// section-specific, not shared across the app, so they live here rather than in @youty/shared.

export const COUPON_ORIGIN_META = {
  manual: { it: 'Manuale', en: 'Manual', color: 'var(--ink-2)', bg: 'var(--paper-2)', icon: 'coupon' },
  auto: { it: 'Automatico', en: 'Automatic', color: 'var(--ok)', bg: 'var(--ok-tint)', icon: 'bolt' },
  loyalty: { it: 'Fedeltà', en: 'Loyalty', color: 'var(--clay-ink)', bg: 'var(--clay-tint)', icon: 'star' },
};

export const COUPON_STATUS_META = {
  active: { it: 'Attivo', en: 'Active', color: 'var(--ok)', bg: 'var(--ok-tint)' },
  redeemed: { it: 'Utilizzato', en: 'Redeemed', color: 'var(--muted)', bg: 'var(--paper-2)' },
  expired: { it: 'Scaduto', en: 'Expired', color: 'var(--danger)', bg: 'var(--danger-tint)' },
};

export const GC_PAYMENT_META = {
  paid: { it: 'Pagata', en: 'Paid', color: 'var(--ok)', bg: 'var(--ok-tint)' },
  unpaid: { it: 'Da pagare', en: 'Payment due', color: 'var(--warn)', bg: 'var(--warn-tint)' },
};

export const GC_STATUS_META = {
  active: { it: 'Attiva', en: 'Active', color: 'var(--ok)', bg: 'var(--ok-tint)' },
  redeemed: { it: 'Esaurita', en: 'Redeemed', color: 'var(--muted)', bg: 'var(--paper-2)' },
  expired: { it: 'Scaduta', en: 'Expired', color: 'var(--danger)', bg: 'var(--danger-tint)' },
};

export const LOYALTY_TYPES = [
  { k: 'points', it: 'A punti', en: 'Points', icon: 'star', hint: { it: 'Punti per € speso, visita o servizio', en: 'Points per € spent, visit or service' } },
  { k: 'stamps', it: 'A timbri', en: 'Stamps', icon: 'check', hint: { it: 'Un timbro per visita/servizio', en: 'A stamp per visit/service' } },
  { k: 'tiers', it: 'A livelli', en: 'Tiers', icon: 'sparkle', hint: { it: 'Livelli con vantaggi crescenti', en: 'Tiers with rising perks' } },
  { k: 'membership', it: 'Membership', en: 'Membership', icon: 'heart', hint: { it: 'Iscrizione con vantaggi riservati', en: 'Membership with member perks' } },
];

export const EARN_METRICS = [
  { k: 'per_euro', it: '€ speso', en: '€ spent' },
  { k: 'per_visit', it: 'Visita', en: 'Visit' },
  { k: 'per_service', it: 'Servizio', en: 'Service' },
];

export const REWARD_TYPES = [
  { k: 'coupon_amount', it: 'Buono €', en: '€ coupon', suffix: '€' },
  { k: 'discount_pct', it: 'Sconto %', en: '% discount', suffix: '%' },
  { k: 'free_service', it: 'Servizio omaggio', en: 'Free service', suffix: '' },
  { k: 'free_product', it: 'Prodotto omaggio', en: 'Free product', suffix: '' },
  { k: 'gift_card', it: 'Gift card', en: 'Gift card', suffix: '€' },
];

export const ENROLLMENTS = [
  { k: 'auto', it: 'Automatica', en: 'Automatic' },
  { k: 'request', it: 'Su richiesta', en: 'Opt-in' },
  { k: 'paid', it: 'A pagamento', en: 'Paid' },
];

export const BONUS_KEYS = [
  { k: 'birthday', it: 'Compleanno', en: 'Birthday' },
  { k: 'referral', it: 'Porta un’amica', en: 'Referral' },
  { k: 'prebook', it: 'Pre-prenotazione', en: 'Pre-booking' },
  { k: 'review', it: 'Recensione / social', en: 'Review / social' },
  { k: 'doubleday', it: 'Giorni doppi punti', en: 'Double-point days' },
];

export const LOYALTY_COLORS = ['#6366F1', '#B26A4F', '#6FB89A', '#5FAEC9', '#9B86E0', '#E0A85A', '#E08B9A'];

/** Compose a human label for a loyalty reward from the REAL API fields
 * (reward_type/reward_value/reward_service_id) — the prototype's free-text `reward{it,en}`
 * has no API equivalent, so the label is always derived, not editable free text. */
export function composeReward(rewardType, rewardValue, serviceName, lang) {
  const v = Number(rewardValue) || 0;
  switch (rewardType) {
    case 'discount_pct': return lang === 'en' ? `${v}% discount` : `Sconto ${v}%`;
    case 'free_service': return serviceName || (lang === 'en' ? 'Free service' : 'Servizio omaggio');
    case 'free_product': return lang === 'en' ? 'Free product' : 'Prodotto omaggio';
    case 'gift_card': return lang === 'en' ? `€${v} gift card` : `Gift card da €${v}`;
    case 'coupon_amount':
    default: return lang === 'en' ? `€${v} coupon` : `Buono da €${v}`;
  }
}
