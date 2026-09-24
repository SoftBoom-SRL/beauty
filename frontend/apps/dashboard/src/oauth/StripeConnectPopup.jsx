// StripeConnectPopup.jsx — popup del collegamento Stripe Connect (titolare).
//   /stripe-connect/start → chiede l'URL OAuth al backend e ci va
//   /stripe-connect/done  → Stripe torna con ?code&state: li scambia, avvisa l'opener, si chiude
// Stessa origine dell'opener: `api` porta il Bearer dello staff e il
// postMessage punta a window.location.origin (come OAuthPopup per Yourang).
import { useEffect, useState } from 'react';
import { api, useT } from '@youty/shared';

export default function StripeConnectPopup({ path }) {
  const { t } = useT();
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const notify = (msg) => { if (window.opener) window.opener.postMessage(msg, window.location.origin); };
    (async () => {
      try {
        if (path === '/stripe-connect/start') {
          const res = await api.post('/api/sales/stripe/connect/start', {});
          window.location.replace(res.url);
          return;
        }
        const params = new URLSearchParams(window.location.search);
        const err = params.get('error');
        if (err) throw new Error(params.get('error_description') || err);
        const code = params.get('code');
        const state = params.get('state');
        if (!code || !state) throw new Error('missing code/state');
        await api.post('/api/sales/stripe/connect/callback', { code, state });
        notify({ type: 'stripe-connect', ok: true });
        window.close();
      } catch (e) {
        if (cancelled) return;
        const message = String(e?.message || e);
        setError(message);
        notify({ type: 'stripe-connect', ok: false, error: message });
      }
    })();
    return () => { cancelled = true; };
  }, [path]);

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh', fontFamily: 'system-ui, sans-serif', padding: 24, textAlign: 'center' }}>
      {error ? (
        <div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{t('Collegamento Stripe non riuscito', 'Stripe connection failed')}</div>
          <div style={{ color: '#6b6b6b', fontSize: 14 }}>{error}</div>
          <button onClick={() => window.close()} style={{ marginTop: 16, padding: '8px 16px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', cursor: 'pointer' }}>{t('Chiudi', 'Close')}</button>
        </div>
      ) : (
        <div style={{ color: '#6b6b6b' }}>{t('Collegamento a Stripe in corso…', 'Connecting to Stripe…')}</div>
      )}
    </div>
  );
}
