// meta.js — status / deposit / segment metadata, keyed on the REAL API enums.
// Prototype keys are still accepted and mapped: checkin→checked_in, corso→in_progress,
// arrivo/confermato→confirmed, noshow→no_show, req→required.

const LEGACY_STATUS = {
  checkin: 'checked_in',
  corso: 'in_progress',
  arrivo: 'confirmed',
  confermato: 'confirmed',
  noshow: 'no_show',
};

/** Appointment status ∈ confirmed | checked_in | in_progress | closed | no_show | cancelled.
 *  t = translate fn from useT(). Returns { label, color, tint, icon }. */
export function statusMeta(status, t) {
  const s = LEGACY_STATUS[status] || status;
  switch (s) {
    case 'checked_in':  return { label: t('Check-in', 'Checked in'),     color: 'var(--ok)',      tint: 'var(--ok-tint)',     icon: 'check' };
    case 'in_progress': return { label: t('In corso', 'In progress'),    color: 'var(--info)',    tint: 'var(--info-tint)',   icon: 'clock' };
    case 'closed':      return { label: t('Completato', 'Completed'),    color: 'var(--ink-2)',   tint: 'var(--paper-2)',     icon: 'check' };
    case 'no_show':     return { label: t('No-show', 'No-show'),         color: 'var(--danger)',  tint: 'var(--danger-tint)', icon: 'alert' };
    case 'cancelled':   return { label: t('Annullato', 'Cancelled'),     color: 'var(--muted-2)', tint: 'var(--paper-2)',     icon: 'x' };
    case 'confirmed':
    default:            return { label: t('Confermato', 'Confirmed'),    color: 'var(--muted)',   tint: 'var(--paper-2)',     icon: 'calendar' };
  }
}

/** Deposit status ∈ none | required | paid | refunded | forfeited.
 *  Returns { label, color, dot } or null for "none". */
export function depositMeta(dep, t) {
  const d = dep === 'req' ? 'required' : dep;
  switch (d) {
    case 'paid':      return { label: t('Deposito versato', 'Deposit paid'),       color: 'var(--ok)',     dot: 'var(--ok)' };
    case 'required':  return { label: t('Deposito richiesto', 'Deposit due'),      color: 'var(--warn)',   dot: 'var(--warn)' };
    case 'refunded':  return { label: t('Deposito rimborsato', 'Deposit refunded'), color: 'var(--info)',   dot: 'var(--info)' };
    case 'forfeited': return { label: t('Deposito trattenuto', 'Deposit forfeited'), color: 'var(--danger)', dot: 'var(--danger)' };
    default:          return null; // 'none'
  }
}

/** Client segment chip metadata (UI-side concept, not an API enum). */
export function segMeta(seg, t) {
  switch (seg) {
    case 'vip':       return { label: 'VIP', color: 'var(--op-lina)' };
    case 'fedele':    return { label: t('Fedele', 'Loyal'), color: 'var(--ok)' };
    case 'nuovo':     return { label: t('Nuovo', 'New'), color: 'var(--info)' };
    case 'dormiente': return { label: t('Dormiente', 'Dormant'), color: 'var(--muted-2)' };
    default:          return { label: seg, color: 'var(--muted)' };
  }
}
