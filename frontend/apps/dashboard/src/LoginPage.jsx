import React, { useState } from 'react';
import { staffAuth, useT, Icon, ApiError } from '@youty/shared';

export default function LoginPage() {
  const { t } = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

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
        </div>
        <div className="t-sm" style={{ color: 'var(--muted-2)', textAlign: 'center', marginTop: 14 }}>
          {t('Demo: sole@theparlour.it', 'Demo: sole@theparlour.it')}
        </div>
      </div>
    </div>
  );
}
