// OAuthPopup.jsx — standalone popup page per i flussi OAuth (Yourang e Stripe).
// Rendered outside the dashboard shell (main.jsx branches on the pathname).
//
//   /oauth-popup/start?mode=login|connect → Yourang: authorize URL, redirect
//   /oauth-popup/done                     → Yourang: exchange, notify, close
//   /oauth-popup/stripe-start             → Stripe Connect: authorize URL, redirect
//   /oauth-popup/stripe-done              → Stripe Connect: exchange, notify, close
//
// Percorsi distinti per provider: entrambi tornano con ?code&state, e il percorso
// è il modo più robusto per sapere di chi è il ritorno.
//
// Modi Yourang:
//   login   → dalla pagina di login (nessuna sessione): il backend provisiona/collega
//             un salone e restituisce una sessione staff; l'opener la applica.
//   connect → dalle impostazioni (loggato): il backend collega il salone corrente.
// Stripe è sempre "connect" e solo per il titolare.
//
// Stessa origine dell'opener → api porta il Bearer staff, e postMessage ha come
// target window.location.origin.
import React, { useEffect, useState } from 'react';
import { api, useT } from '@youty/shared';

const YOURANG_START = {
  login: '/api/integrations/yourang/oauth/login/start',
  connect: '/api/integrations/yourang/oauth/start',
};

const PROVIDER = {
  '/oauth-popup/start': 'yourang',
  '/oauth-popup/done': 'yourang',
  '/oauth-popup/stripe-start': 'stripe',
  '/oauth-popup/stripe-done': 'stripe',
};

export default function OAuthPopup({ path }) {
  const { t } = useT();
  const [error, setError] = useState('');
  const provider = PROVIDER[path] || 'yourang';
  const msgType = provider === 'stripe' ? 'stripe-oauth' : 'yourang-oauth';

  useEffect(() => {
    let cancelled = false;
    const notify = (msg) => {
      if (window.opener) window.opener.postMessage(msg, window.location.origin);
    };

    (async () => {
      try {
        if (path === '/oauth-popup/stripe-start') {
          const res = await api.get('/api/integrations/stripe/oauth/start');
          window.location.replace(res.authorize_url);
          return;
        }
        if (path === '/oauth-popup/start') {
          const mode = new URLSearchParams(window.location.search).get('mode') === 'login'
            ? 'login' : 'connect';
          const res = await api.get(YOURANG_START[mode]);
          window.location.replace(res.authorize_url);
          return;
        }
        // …-done — il provider ha rimandato qui con ?code&state
        const params = new URLSearchParams(window.location.search);
        const err = params.get('error');
        if (err) throw new Error(params.get('error_description') || err);
        const code = params.get('code');
        const state = params.get('state');
        if (!code || !state) throw new Error('missing code/state');

        if (provider === 'stripe') {
          const res = await api.post('/api/integrations/stripe/oauth/exchange', { code, state });
          notify({ type: msgType, ok: true, status: res });
        } else {
          const res = await api.post('/api/integrations/yourang/oauth/exchange', { code, state });
          notify({ type: msgType, ok: true, mode: res.mode, session: res.session });
        }
        window.close();
      } catch (e) {
        if (cancelled) return;
        const message = String(e?.message || e);
        setError(message);
        notify({ type: msgType, ok: false, error: message });
      }
    })();

    return () => { cancelled = true; };
  }, [path, provider, msgType]);

  const label = provider === 'stripe' ? 'Stripe' : 'Yourang';

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh', fontFamily: 'system-ui, sans-serif', padding: 24, textAlign: 'center' }}>
      {error ? (
        <div>
          <p style={{ fontWeight: 600 }}>{t(`Connessione a ${label} non riuscita`, `${label} connection failed`)}</p>
          <p style={{ color: '#888', fontSize: 13 }}>{error}</p>
          <button onClick={() => window.close()} style={{ marginTop: 12 }}>{t('Chiudi', 'Close')}</button>
        </div>
      ) : (
        <p>{t(`Connessione a ${label} in corso…`, `Connecting to ${label}…`)}</p>
      )}
    </div>
  );
}
