// SalonHoursChip — gli orari del centro per il giorno a video, nella barra
// (Impostazioni → Orari di apertura, dove porta il clic).
import { Icon } from '@youty/shared';
import { openingFor } from '../lib.js';

/* ---- orari del centro per il giorno mostrato (Impostazioni → Orari di apertura) ---- */
export default function SalonHoursChip({ settings, date, t, isOwner, onOpen }) {
  const week = settings?.opening_hours_week;
  const has = week && Object.keys(week).length > 0;
  const ranges = has ? openingFor(settings, date) : null;
  /* Con la barra stretta resta solo l'essenziale («9–19», «Chiuso»,
   * «Imposta»): il resto è nel suggerimento. */
  const hours = has && ranges.length ? ranges.map(([a, b]) => `${a.replace(/^0/, '')}–${b.replace(/^0/, '')}`).join(' · ') : '';
  const [lead, main] = !has
    ? (isOwner ? [t('Orari del centro:', 'Salon hours:'), t('imposta', 'set')] : [t('Orari del centro', 'Salon hours'), t('non impostati', 'not set')])
    : ranges.length
      ? [t('Centro', 'Salon'), hours]
      : [t('Centro', 'Salon'), t('chiuso', 'closed')];
  return (
    <button type="button" onClick={onOpen} aria-label={`${lead} ${main}`} title={`${lead} ${main} · ` + t('orari di apertura del centro, clicca per modificarli', 'salon opening hours, click to edit')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 30, minWidth: 30, justifyContent: 'center', padding: '0 9px', borderRadius: 99, border: '1px solid ' + (has ? 'var(--hair)' : 'color-mix(in srgb, var(--warn) 55%, transparent)'), background: has ? 'var(--surface)' : 'var(--warn-tint)', color: has ? (ranges.length ? 'var(--ink-2)' : 'var(--muted)') : 'var(--warn)', fontSize: 12, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
      <Icon name="clock" size={13} color="currentColor" />
      {/* con la barra stretta resta solo l'icona: grigia con gli orari
          impostati (le ore chiuse si vedono nella griglia), ambra quando
          mancano, che resta un invito anche senza parole */}
      <span className={'tabnum dk-hours-txt ' + (has ? 'dk-ag-t2' : 'dk-ag-t3')}><span className="dk-ag-lbl">{lead} </span>{main}</span>
    </button>
  );
}
