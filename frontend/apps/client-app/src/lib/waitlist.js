// waitlist.js — la preferenza oraria di una richiesta di lista d'attesa, a
// parole, e i giorni della settimana per sceglierla.
// Logica pura, senza React: la caricano anche i test con `node --test`.
import { WEEKDAYS_SHORT_EN, WEEKDAYS_SHORT_IT } from '@youty/shared';

/** Waitlist preference label. */
export function prefLabel(entry, t, lang) {
  switch (entry.preference) {
    case 'morning': return t('Mattina', 'Morning');
    case 'afternoon': return t('Pomeriggio', 'Afternoon');
    case 'weekend': return t('Weekend', 'Weekend');
    case 'exact': {
      // exact_days: 0 = lunedì, come nell'API e nelle tabelle condivise
      const names = lang === 'en' ? WEEKDAYS_SHORT_EN : WEEKDAYS_SHORT_IT;
      const days = (entry.exact_days || []).map((d) => names[d] || '').filter(Boolean).join(' ');
      const time = entry.exact_time ? String(entry.exact_time).slice(0, 5) : '';
      return [days, time].filter(Boolean).join(' · ') || t('Orario preciso', 'Exact time');
    }
    default: return t('Qualsiasi orario', 'Any time');
  }
}

/** Le iniziali dei giorni per i pulsanti dei giorni: 0 = lunedì … 6 =
 *  domenica, come nell'API. I nomi abbreviati sono le tabelle condivise
 *  WEEKDAYS_SHORT_IT/EN; le iniziali servono solo qui. */
export const WEEKDAY_LETTERS_IT = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];
export const WEEKDAY_LETTERS_EN = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
