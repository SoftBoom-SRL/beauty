// ScreenStub.jsx — placeholder rendered by not-yet-ported client screens.
import React from 'react';
import { Icon } from '@youty/shared';
import { useApp } from '../ctx.jsx';

export default function ScreenStub({ name, nameEn, icon = 'sparkle', back = null }) {
  const { t, setView } = useApp();
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 30px', textAlign: 'center' }}>
      <div style={{ width: 64, height: 64, borderRadius: 20, background: 'var(--brand-tint)', display: 'grid', placeItems: 'center', marginBottom: 16 }}>
        <Icon name={icon} size={28} color="var(--brand-ink)" />
      </div>
      <div className="t-title" style={{ marginBottom: 6 }}>{t(name, nameEn || name)}</div>
      <div className="t-body" style={{ color: 'var(--muted)', maxWidth: 260 }}>
        {t('Schermata in migrazione…', 'Screen being migrated…')}
      </div>
      {back && (
        <button className="btn btn--brand press" style={{ marginTop: 22 }} onClick={() => setView(back)}>
          {t('Torna alla home', 'Back to home')}
        </button>
      )}
    </div>
  );
}
