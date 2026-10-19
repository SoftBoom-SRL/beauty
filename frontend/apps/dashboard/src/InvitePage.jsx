// InvitePage — /invito/<codice>: chi è stata invitata entra nel team.
// Prima l'invito era un codice da copiare a mano e nel gestionale non c'era
// nessun posto dove usarlo (il titolare, 19/10: «è confusionario»). Qui si
// vede dove e con quale ruolo si entra, e si accetta in un passo:
// - account nuovo: nome, cognome e password;
// - account già esistente con quell'email: la sua password;
// - account che entra con Yourang (senza password): «Accedi con Yourang», o
//   la sessione già aperta in questo browser con la stessa email.
// Fuori dalla shell (niente sessione richiesta), come i popup OAuth.
import { useEffect, useRef, useState } from 'react';
import { ApiError, Icon, staffAuth, useT } from '@youty/shared';
import { invitationsApi } from './api/team.js';
import { YOURANG_MSG, openYourangPopup, usePopupMessage } from './oauth/popup.js';

/** Il codice dal percorso /invito/<codice>. */
export const tokenFromPath = (path) => decodeURIComponent(String(path || '').replace(/^\/invito\/?/, '').split('/')[0] || '');

const DEAD = {
  accepted: ['Questo invito è già stato usato: entra dalla pagina di accesso.', 'This invitation was already used: sign in from the login page.'],
  expired: ['L’invito è scaduto: chiedi a chi ti ha invitato di rimandarlo.', 'The invitation has expired: ask whoever invited you to send it again.'],
  revoked: ['Questo invito è stato annullato.', 'This invitation was cancelled.'],
};

export default function InvitePage({ path, onDone = (s) => { staffAuth.applySession(s); window.location.replace('/'); } }) {
  const { t } = useT();
  const token = tokenFromPath(path);
  const [info, setInfo] = useState(null);       // preview | 'missing' | 'error'
  const [form, setForm] = useState({ first_name: '', last_name: '', password: '' });
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const session = staffAuth.getSession();
  const sameUser = !!(session && info && typeof info === 'object' && (session.user?.email || '').toLowerCase() === info.email.toLowerCase());

  useEffect(() => {
    if (!token) { setInfo('missing'); return; }
    invitationsApi.preview(token)
      .then(setInfo)
      .catch((err) => setInfo(err instanceof ApiError && err.status === 404 ? 'missing' : 'error'));
  }, [token]);

  const fail = (err) => setError(err instanceof ApiError ? err.message : t('Impossibile contattare il server', 'Cannot reach the server'));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      onDone(await invitationsApi.accept({ token, password: form.password, first_name: form.first_name.trim(), last_name: form.last_name.trim() }));
    } catch (err) { fail(err); } finally { setBusy(false); }
  };
  const withSession = async () => {
    setBusy(true); setError(null);
    try { onDone(await invitationsApi.acceptSession(token)); } catch (err) { fail(err); } finally { setBusy(false); }
  };

  // chi entra con Yourang: il popup apre la sessione, poi si accetta con quella
  const accepting = useRef(false);
  usePopupMessage(YOURANG_MSG, async (m) => {
    if (!m.ok || m.mode !== 'login' || !m.session || accepting.current) { if (!m.ok) setError(t('Accesso con Yourang non riuscito', 'Yourang login failed')); return; }
    accepting.current = true;
    staffAuth.applySession(m.session);
    await withSession();
    accepting.current = false;
  }, [token]);
  const yourang = () => { setError(null); if (!openYourangPopup('login')) setError(t('Popup bloccato: consenti i popup e riprova', 'Popup blocked: allow popups and retry')); };

  const ready = info && typeof info === 'object';
  const dead = ready && info.status !== 'pending' ? DEAD[info.status] || DEAD.revoked : null;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="dk-root" style={{ display: 'flex' }}>
      <div className="dk-login">
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 22, justifyContent: 'center' }}>
          <b style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.025em', color: 'var(--ink)' }}>youty</b>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--clay)' }} />
        </div>
        <div className="dk-card" style={{ padding: 28 }} data-invite={ready ? info.status : String(info)}>
          {info === null && <div className="skel" style={{ height: 160, borderRadius: 12 }} />}
          {(info === 'missing' || info === 'error') && (
            <div className="dk-login-err"><Icon name="alert" size={16} color="var(--danger)" />
              <span>{info === 'missing' ? t('Invito non trovato: controlla il link, o chiedi di rimandarlo.', 'Invitation not found: check the link, or ask for it again.') : t('Impossibile contattare il server', 'Cannot reach the server')}</span>
            </div>
          )}
          {ready && (
            <>
              <div className="t-title" style={{ marginBottom: 6 }}>{t(`Entra nel team di ${info.salon_name}`, `Join the ${info.salon_name} team`)}</div>
              <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 18, lineHeight: 1.5 }}>
                {info.invited_by ? t(`${info.invited_by} ti invita come «${info.role_name}».`, `${info.invited_by} invites you as “${info.role_name}”.`) : t(`Sei invitato come «${info.role_name}».`, `You are invited as “${info.role_name}”.`)}
                {' '}{t('Accedi con', 'You sign in with')} <b style={{ color: 'var(--ink)' }}>{info.email}</b>.
              </div>
              {error && <div className="dk-login-err"><Icon name="alert" size={16} color="var(--danger)" /><span>{error}</span></div>}
              {dead ? (
                <>
                  <div className="dk-login-err" data-dead><Icon name="info" size={16} color="var(--danger)" /><span>{t(dead[0], dead[1])}</span></div>
                  <a className="dk-btn dk-btn--ghost" href="/" style={{ width: '100%', marginTop: 6 }}>{t('Vai all’accesso', 'Go to sign in')}</a>
                </>
              ) : sameUser ? (
                <button type="button" data-with-session className="dk-btn dk-btn--clay" disabled={busy} onClick={withSession} style={{ width: '100%' }}>
                  {busy ? t('Un momento…', 'One moment…') : t(`Entra come ${info.email}`, `Join as ${info.email}`)}
                </button>
              ) : info.has_account && !info.has_password ? (
                <>
                  <div className="t-sm" style={{ color: 'var(--ink-2)', marginBottom: 14, lineHeight: 1.5 }}>{t('Il tuo account entra con Yourang: accedi e l’invito si accetta da solo.', 'Your account signs in with Yourang: sign in and the invitation is accepted automatically.')}</div>
                  <button type="button" data-yourang className="dk-btn dk-btn--clay" disabled={busy} onClick={yourang} style={{ width: '100%' }}>{t('Accedi con Yourang', 'Sign in with Yourang')}</button>
                </>
              ) : (
                <form onSubmit={submit}>
                  {!info.has_account && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div className="dk-field"><label htmlFor="inv-first">{t('Nome', 'First name')}</label>
                        <input id="inv-first" className="dk-input" required autoComplete="given-name" value={form.first_name} onChange={set('first_name')} /></div>
                      <div className="dk-field"><label htmlFor="inv-last">{t('Cognome', 'Last name')}</label>
                        <input id="inv-last" className="dk-input" autoComplete="family-name" value={form.last_name} onChange={set('last_name')} /></div>
                    </div>
                  )}
                  <div className="dk-field">
                    <label htmlFor="inv-pass">{info.has_account ? t('La tua password', 'Your password') : t('Scegli una password', 'Choose a password')}</label>
                    <div style={{ position: 'relative' }}>
                      <input id="inv-pass" className="dk-input" type={show ? 'text' : 'password'} required
                        autoComplete={info.has_account ? 'current-password' : 'new-password'} value={form.password} onChange={set('password')} style={{ paddingRight: 64 }} />
                      <button type="button" onClick={() => setShow((v) => !v)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, fontWeight: 700, color: 'var(--muted)', cursor: 'pointer' }}>
                        {show ? t('Nascondi', 'Hide') : t('Mostra', 'Show')}
                      </button>
                    </div>
                    <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11.5, marginTop: 5 }}>
                      {info.has_account
                        ? t('Hai già un account con questa email: entri con la stessa password.', 'You already have an account with this email: use the same password.')
                        : t('Almeno 8 caratteri, non solo numeri. La userai per entrare nel gestionale.', 'At least 8 characters, not only numbers. You will use it to sign in.')}
                    </div>
                  </div>
                  <button className="dk-btn dk-btn--clay" type="submit" disabled={busy} style={{ width: '100%', marginTop: 6, opacity: busy ? 0.7 : 1 }}>
                    {busy ? t('Un momento…', 'One moment…') : info.has_account ? t('Entra nel team', 'Join the team') : t('Crea l’account ed entra', 'Create the account and join')}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
