// ExclusiveBadge.jsx — la Exclusive Card nella testata della scheda cliente
// (ProfileHeader): fino a quando vale, o quando è scaduta, senza dover aprire
// il Portafoglio. Iscrizione e rinnovo restano nel Portafoglio
// (tabs/ExclusiveCardBox.jsx). Senza iscrizione non compare niente.
import { Icon } from '@youty/shared';
import { useResource } from '../../hooks/useResource.js';
import { exclusiveApi } from '../../api/marketing.js';
import { exclusiveBadge } from './helpers.js';

const TONES = {
  ok: ['var(--clay-tint)', 'var(--clay-ink)'],
  warn: ['var(--warn-tint)', 'var(--warn)'],
  off: ['var(--paper-2)', 'var(--muted)'],
};

export default function ExclusiveBadge({ clientId, pill, t, lang }) {
  const { data } = useResource(() => exclusiveApi.ofClient(clientId), [clientId], { fallback: null });
  const badge = exclusiveBadge(data?.membership, t, lang);
  if (!badge) return null;
  const [bg, fg] = TONES[badge.tone];
  return (
    <span data-exclusive-badge="" title={t('Iscrizione e rinnovo nel Portafoglio', 'Enrolment and renewal in the Wallet')} style={{ ...pill, background: bg, color: fg }}>
      <Icon name="star" size={12} color={fg} />{badge.text}
    </span>
  );
}
