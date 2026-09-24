// SalonHoursChip — gli orari del centro per il giorno a video, nella barra
// (Impostazioni → Orari di apertura, dove porta il clic).
import { Icon } from '@youty/shared';
import { openingFor } from '../lib.js';

/* ---- orari del centro per il giorno mostrato (Impostazioni → Orari di apertura) ---- */
export default function SalonHoursChip({ settings, date, t, isOwner, onOpen }) {
  const week = settings?.opening_hours_week;
  const has = week && Object.keys(week).length > 0;
  const ranges = has ? openingFor(settings, date) : null;
  const label = !has
    ? (isOwner ? t('Orari del centro: imposta', 'Salon hours: set') : t('Orari del centro non impostati', 'Salon hours not set'))
    : ranges.length
      ? t('Centro', 'Salon') + ' ' + ranges.map(([a, b]) => `${a.replace(/^0/, '')}–${b.replace(/^0/, '')}`).join(' · ')
      : t('Centro chiuso', 'Salon closed');
  return (
    <button type="button" onClick={onOpen} title={t('Orari di apertura del centro · clicca per modificarli', 'Salon opening hours · click to edit')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 12px', borderRadius: 99, border: '1px solid ' + (has ? 'var(--hair)' : 'var(--warn)'), background: has ? 'var(--surface)' : 'var(--warn-tint)', color: has ? (ranges.length ? 'var(--ink-2)' : 'var(--muted)') : 'var(--warn)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
      <Icon name="clock" size={13} color="currentColor" />
      <span className="tabnum">{label}</span>
    </button>
  );
}
