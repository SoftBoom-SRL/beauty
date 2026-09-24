// PickBanner — la fascia «Scelta orario» sopra la griglia, in giorno e
// settimana, mentre è aperta una prenotazione: un clic su uno spazio libero
// passa orario e operatrice al drawer invece di aprire il menu.
import { Icon } from '@youty/shared';

export default function PickBanner({ t }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 26px', background: 'var(--clay-tint)', borderBottom: '1px solid var(--hair)', color: 'var(--clay-ink)', fontSize: 13, fontWeight: 600 }}>
      <Icon name="target" size={15} color="var(--clay-ink)" />
      {t('Scelta orario: clicca uno spazio libero per impostare orario e operatrice nella prenotazione', 'Pick a time: click a free space to set time and stylist in the booking')}
    </div>
  );
}
