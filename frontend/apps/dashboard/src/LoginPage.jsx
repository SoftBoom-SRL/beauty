import React, { useEffect, useState } from 'react';
import { staffAuth, useT, Icon, ApiError } from '@youty/shared';

export default function LoginPage() {
  const { t } = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [yourangBusy, setYourangBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await staffAuth.login(email.trim(), password);
      // App.jsx is subscribed to the session store and switches to the shell.
    } catch (err) {
      if (err instanceof ApiError) setError(err.message || t('Credenziali non valide', 'Invalid credentials'));
      else setError(t('Impossibile contattare il server', 'Cannot reach the server'));
    } finally {
      setBusy(false);
    }
  };

  // Login con Yourang (stile "accedi con Google"): il popup completa l'OAuth e
  // restituisce la sessione staff; qui la applichiamo e App.jsx entra nella shell.
  useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== window.location.origin || e.data?.type !== 'yourang-oauth') return;
      setYourangBusy(false);
      if (e.data.ok && e.data.mode === 'login' && e.data.session) {
        staffAuth.applySession(e.data.session);
      } else if (!e.data.ok) {
        setError(t('Login con Yourang non riuscito', 'Yourang login failed'));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [t]);

  const loginWithYourang = () => {
    setError(null);
    const popup = window.open('/oauth-popup/start?mode=login', 'yourang-oauth', 'width=520,height=680');
    if (!popup) { setError(t('Popup bloccato: consenti i popup e riprova', 'Popup blocked: allow popups and retry')); return; }
    setYourangBusy(true);
  };

  return (
    <div className="dk-root" style={{ display: 'flex' }}>
      <div className="dk-login">
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 22, justifyContent: 'center' }}>
          <b style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.025em', color: 'var(--ink)' }}>youty</b>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--clay)' }} />
        </div>
        <div className="dk-card" style={{ padding: 28 }}>
          <div className="t-title" style={{ marginBottom: 4 }}>{t('Accedi', 'Sign in')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 20 }}>
            {t('Area salone · accesso staff', 'Salon area · staff access')}
          </div>
          {error && (
            <div className="dk-login-err">
              <Icon name="alert" size={16} color="var(--danger)" />
              <span>{error}</span>
            </div>
          )}
          <form onSubmit={submit}>
            <div className="dk-field">
              <label htmlFor="login-email">{t('Email', 'Email')}</label>
              <input id="login-email" className="dk-input" type="email" autoComplete="username" required
                placeholder="sole@theparlour.it"
                value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="dk-field">
              <label htmlFor="login-password">{t('Password', 'Password')}</label>
              <input id="login-password" className="dk-input" type="password" autoComplete="current-password" required
                value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <button className="dk-btn dk-btn--clay" type="submit" disabled={busy}
              style={{ width: '100%', marginTop: 6, opacity: busy ? 0.7 : 1 }}>
              {busy ? t('Accesso…', 'Signing in…') : t('Entra', 'Sign in')}
            </button>
          </form>

          {/* Divider + login con Yourang (OAuth popup, stile Google) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '18px 0' }}>
            <div style={{ height: 1, flex: 1, background: 'var(--hair)' }} />
            <span className="t-sm" style={{ color: 'var(--muted-2)', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 11 }}>{t('oppure', 'or')}</span>
            <div style={{ height: 1, flex: 1, background: 'var(--hair)' }} />
          </div>
          <button type="button" onClick={loginWithYourang} disabled={yourangBusy}
            className="dk-btn dk-btn--ghost"
            aria-label={t('Accedi con Yourang', 'Sign in with Yourang')}
            style={{ width: '100%', opacity: yourangBusy ? 0.7 : 1 }}>
            {yourangBusy
              ? t('Connessione…', 'Connecting…')
              : <img src="/yourang-logo.png" alt="yourang.ai" style={{ height: 24, objectFit: 'contain' }} />}
          </button>
        </div>
        <div className="t-sm" style={{ color: 'var(--muted-2)', textAlign: 'center', marginTop: 14 }}>
          {t('Demo: sole@theparlour.it', 'Demo: sole@theparlour.it')}
        </div>
      </div>
    </div>
  );
}
