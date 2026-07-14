// SectionStub.jsx — placeholder rendered by not-yet-ported sections.
import React from 'react';
import { Icon } from '@youty/shared';
import { useDash } from '../ctx.jsx';

export default function SectionStub({ name, nameEn, icon = 'sparkle' }) {
  const { t } = useDash();
  return (
    <div className="dk-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div className="dk-card" style={{ padding: '48px 56px', textAlign: 'center', maxWidth: 420 }}>
        <div style={{ width: 64, height: 64, borderRadius: 20, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', margin: '0 auto 18px' }}>
          <Icon name={icon} size={28} color="var(--clay-ink)" />
        </div>
        <div className="t-title" style={{ marginBottom: 8 }}>{t(name, nameEn || name)}</div>
        <div className="t-body" style={{ color: 'var(--muted)' }}>
          {t('Sezione in migrazione…', 'Section being migrated…')}
        </div>
      </div>
    </div>
  );
}
