// OAuthPopup.jsx — standalone popup page for the Yourang OAuth flow.
// Rendered outside the dashboard shell (main.jsx branches on the pathname).
//   /oauth-popup/start?mode=login|connect → get authorize URL, redirect there
//   /oauth-popup/done                      → exchange the code, notify opener, close
// Two modes:
//   login   → from the login page (no session): backend provisions/links a salon
//             and returns a staff session; opener applies it and enters the app.
//   connect → from settings (logged in): backend links the current salon.
// Same origin as the opener → api carries the staff Bearer (connect), and
// postMessage targets window.location.origin.
import React, { useEffect, useState } from 'react';
import { api, useT } from '@youty/shared';

const START = {
  login: '/api/integrations/yourang/oauth/login/start',
  connect: '/api/integrations/yourang/oauth/start',
};

export default function OAuthPopup({ path }) {
  const { t } = useT();
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const notify = (msg) => {
      if (window.opener) window.opener.postMessage(msg, window.location.origin);
    };

    (async () => {
      try {
        if (path === '/oauth-popup/start') {
          const mode = new URLSearchParams(window.location.search).get('mode') === 'login'
            ? 'login' : 'connect';
          const res = await api.get(START[mode]);
          window.location.replace(res.authorize_url);
          return;
        }
        // /oauth-popup/done — Yourang redirected back with ?code&state
        const params = new URLSearchParams(window.location.search);
        const err = params.get('error');
        if (err) throw new Error(err);
        const code = params.get('code');
        const state = params.get('state');
        if (!code || !state) throw new Error('missing code/state');
        const res = await api.post('/api/integrations/yourang/oauth/exchange', { code, state });
        notify({ type: 'yourang-oauth', ok: true, mode: res.mode, session: res.session });
        window.close();
      } catch (e) {
        if (cancelled) return;
        const message = String(e?.message || e);
        setError(message);
        notify({ type: 'yourang-oauth', ok: false, error: message });
      }
    })();

    return () => { cancelled = true; };
  }, [path]);

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh', fontFamily: 'system-ui, sans-serif', padding: 24, textAlign: 'center' }}>
      {error ? (
        <div>
          <p style={{ fontWeight: 600 }}>{t('Connessione a Yourang non riuscita', 'Yourang connection failed')}</p>
          <p style={{ color: '#888', fontSize: 13 }}>{error}</p>
          <button onClick={() => window.close()} style={{ marginTop: 12 }}>{t('Chiudi', 'Close')}</button>
        </div>
      ) : (
        <p>{t('Connessione a Yourang in corso…', 'Connecting to Yourang…')}</p>
      )}
    </div>
  );
}
