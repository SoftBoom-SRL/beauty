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
// The start page keeps the nonce of the flow in sessionStorage and the done page
// sends it back with the signed state (see flow.js): a code that was not asked
// for by this window is never redeemed.
import React, { useEffect, useState } from 'react';
import { api, staffAuth, useT } from '@youty/shared';
import { claimRestart, clearRestart, saveFlow, takeFlow } from './flow.js';

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

    // sessionStorage può lanciare già all'accesso (cookie bloccati).
    const storage = (() => { try { return window.sessionStorage; } catch { return null; } })();
    const standalone = !window.opener || window.opener === window;

    (async () => {
      try {
        if (path === '/oauth-popup/start') {
          const mode = new URLSearchParams(window.location.search).get('mode') === 'login'
            ? 'login' : 'connect';
          const res = await api.get(START[mode]);
          // Senza il nonce salvato il ritorno verrebbe rifiutato: meglio dirlo
          // subito che mandare la persona fino al consenso per niente.
          if (!saveFlow(storage, mode, res.nonce)) {
            throw new Error(t('Il browser non permette di completare il collegamento (memoria di sessione bloccata)',
              'The browser does not allow completing the connection (session storage blocked)'));
          }
          window.location.replace(res.authorize_url);
          return;
        }
        // /oauth-popup/done — the proxy redirected back with ?yr_link, plus the
        // ?mode and ?state we put in return_to.
        const params = new URLSearchParams(window.location.search);
        const err = params.get('error');
        if (err) throw new Error(err);
        const code = params.get('yr_link');
        const mode = params.get('mode') === 'login' ? 'login' : 'connect';
        if (!code) throw new Error('missing yr_link');
        const flow = takeFlow(storage, mode);
        if (!flow) {
          // Nessun flusso avviato da questa finestra: il codice non si riscatta.
          // Un login in una scheda normale (la scorciatoia di Yourang) riparte
          // una volta da capo con uno state suo; il resto è un errore.
          if (mode === 'login' && standalone && claimRestart(storage)) {
            window.location.replace('/oauth-popup/start?mode=login');
            return;
          }
          throw new Error(mode === 'login'
            ? t('Accesso non avviato da questa finestra: riprova dalla pagina di accesso', 'Sign-in not started from this window: try again from the sign-in page')
            : t('Collegamento non avviato da questa finestra: riprova da Impostazioni', 'Connection not started from this window: try again from Settings'));
        }
        clearRestart(storage);
        const res = await api.post('/api/integrations/yourang/oauth/exchange', {
          code, mode, state: params.get('state') || '', nonce: flow.nonce,
        });
        // Nessun opener = flow aperto dalla scorciatoia nella sidebar di Yourang,
        // in una tab normale. window.close() non funziona su una finestra non
        // aperta da script e resteremmo sullo spinner: applichiamo qui la
        // sessione (stessa origin, localStorage) ed entriamo nell'app.
        if (standalone) {
          if (res.mode === 'login' && res.session) staffAuth.applySession(res.session);
          window.location.replace('/');
          return;
        }
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
          {/* Senza opener close() è bloccato: il bottone deve riportare al login. */}
          <button
            onClick={() => (window.opener ? window.close() : window.location.replace('/'))}
            style={{ marginTop: 12 }}
          >
            {window.opener ? t('Chiudi', 'Close') : t('Torna al login', 'Back to sign in')}
          </button>
        </div>
      ) : (
        <p>{t('Connessione a Yourang in corso…', 'Connecting to Yourang…')}</p>
      )}
    </div>
  );
}
