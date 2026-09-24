// waitlist.js — la preferenza oraria di una richiesta di lista d'attesa, a
// parole, e i giorni della settimana per sceglierla.
// Logica pura, senza React: la caricano anche i test con `node --test`.

/** Waitlist preference label. */
export function prefLabel(entry, t, lang) {
  switch (entry.preference) {
    case 'morning': return t('Mattina', 'Morning');
    case 'afternoon': return t('Pomeriggio', 'Afternoon');
    case 'weekend': return t('Weekend', 'Weekend');
    case 'exact': {
      const days = (entry.exact_days || []).map((d) => (WEEKDAYS_SHORT[d] ? WEEKDAYS_SHORT[d][lang === 'en' ? 1 : 0] : '')).filter(Boolean).join(' ');
      const time = entry.exact_time ? String(entry.exact_time).slice(0, 5) : '';
      return [days, time].filter(Boolean).join(' · ') || t('Orario preciso', 'Exact time');
    }
    default: return t('Qualsiasi orario', 'Any time');
  }
}

/** 0=Monday … 6=Sunday (backend convention). [it, en, letterIt, letterEn] */
export const WEEKDAYS_SHORT = [
  ['Lun', 'Mon', 'L', 'M'], ['Mar', 'Tue', 'M', 'T'], ['Mer', 'Wed', 'M', 'W'],
  ['Gio', 'Thu', 'G', 'T'], ['Ven', 'Fri', 'V', 'F'], ['Sab', 'Sat', 'S', 'S'], ['Dom', 'Sun', 'D', 'S'],
];
