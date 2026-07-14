// OpportunityModal — placeholder: the AI suggestions engine ships with phase 2.
import React from 'react';
import { Icon } from '@youty/shared';
import DkModal from '../../../ui/DkModal.jsx';
import { useDash } from '../../../ctx.jsx';

export default function OpportunityModal({ onClose }) {
  const { t } = useDash();
  return (
    <DkModal open onClose={onClose} title={t('Opportunità di oggi', 'Today’s opportunities')} sub={t('Suggerimenti AI — fase 2', 'AI suggestions — phase 2')} width={480}
      foot={<button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Chiudi', 'Close')}</button>}>
      <div style={{ textAlign: 'center', padding: '26px 18px 10px' }}>
        <div style={{ width: 62, height: 62, borderRadius: 20, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', margin: '0 auto 14px' }}>
          <Icon name="sparkle" size={28} color="var(--clay-ink)" />
        </div>
        <div className="t-title" style={{ marginBottom: 8 }}>{t('Suggerimenti AI — fase 2', 'AI suggestions — phase 2')}</div>
        <div className="t-body" style={{ color: 'var(--muted)', maxWidth: 340, margin: '0 auto', lineHeight: 1.5 }}>
          {t(
            'Qui arriveranno i suggerimenti automatici di Youty: buchi in agenda da riempire, clienti da riattivare e proposte last-minute, con invio via Yourang. Il motore AI è previsto nella fase 2.',
            'This is where Youty’s automatic suggestions will live: schedule gaps to fill, clients to win back and last-minute offers, sent via Yourang. The AI engine ships in phase 2.'
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18, flexWrap: 'wrap' }}>
        {[
          ['gap', t('Buchi in agenda', 'Schedule gaps')],
          ['revive', t('Riattivazioni', 'Win-backs')],
          ['bolt', t('Last-minute', 'Last-minute')],
        ].map(([icon, label]) => (
          <span key={icon} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--muted)', background: 'var(--surface-2)', padding: '6px 12px', borderRadius: 99 }}>
            <Icon name={icon} size={13} color="var(--muted-2)" />{label}
          </span>
        ))}
      </div>
    </DkModal>
  );
}
