// app/BootScreens.jsx — cosa si vede finché i dati di base non sono arrivati
// (lo scheletro della dashboard) o se il loro caricamento fallisce.
import { staffAuth } from '@youty/shared';

/* ---- loading gate ---- */
export function BootSkeleton() {
  return (
    <div className="dk-root" style={{ display: 'flex' }}>
      <aside className="dk-side" style={{ gap: 10 }}>
        <div className="skel" style={{ height: 30, width: 120, margin: '4px 10px 22px' }} />
        {[...Array(8)].map((_, i) => <div key={i} className="skel" style={{ height: 40, borderRadius: 12 }} />)}
      </aside>
      <div className="dk-main">
        <header className="dk-top">
          <div className="skel" style={{ height: 30, width: 220 }} />
          <div style={{ flex: 1 }} />
          <div className="skel" style={{ height: 42, width: 320, borderRadius: 999 }} />
        </header>
        <div className="dk-page">
          <div className="skel" style={{ height: 26, width: 280, marginBottom: 18 }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 22 }}>
            {[...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 92, borderRadius: 16 }} />)}
          </div>
          <div className="skel" style={{ height: 380, borderRadius: 16 }} />
        </div>
      </div>
    </div>
  );
}

export function BootError({ message, onRetry, t }) {
  return (
    <div className="dk-root" style={{ display: 'flex' }}>
      <div style={{ margin: 'auto', textAlign: 'center', maxWidth: 380 }}>
        <div className="t-title" style={{ marginBottom: 8 }}>{t('Errore di caricamento', 'Loading error')}</div>
        <div className="t-body" style={{ color: 'var(--muted)', marginBottom: 18 }}>{message}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button className="dk-btn dk-btn--clay" onClick={onRetry}>{t('Riprova', 'Retry')}</button>
          <button className="dk-btn dk-btn--ghost" onClick={() => staffAuth.logout()}>{t('Esci', 'Log out')}</button>
        </div>
      </div>
    </div>
  );
}
