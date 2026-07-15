// AuthFlow.jsx — client login: phone → OTP (via SMS) → session.
// Unknown number (404) → inline registration form → OTP.
import React, { useState } from 'react';
import { ApiError, Icon, clientAuth } from '@youty/shared';
import { useApp, SALON_SLUG } from '../../ctx.jsx';
import { headFont } from '../../theme.js';

export default function AuthFlow({ onClose }) {
  const { t, lang, setLang, brand } = useApp();
  const [step, setStep] = useState('phone'); // phone | register | otp
  const [phone, setPhone] = useState('');
  const [reg, setReg] = useState({ first_name: '', last_name: '', email: '' });
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const sendOtp = () => run(async () => {
    try {
      await clientAuth.requestOtp(SALON_SLUG, phone.trim());
      setStep('otp');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setStep('register'); // "Numero non registrato" → offer registration
      } else if (err instanceof ApiError && err.status === 429) {
        setError(t('Troppi codici richiesti. Riprova tra qualche minuto.', 'Too many codes requested. Try again in a few minutes.'));
      } else {
        setError(err?.message || t('Errore di rete', 'Network error'));
      }
    }
  });

  const doRegister = () => run(async () => {
    try {
      await clientAuth.register({
        salon_slug: SALON_SLUG,
        first_name: reg.first_name.trim(),
        last_name: reg.last_name.trim(),
        phone: phone.trim(),
        email: reg.email.trim(),
        lang,
      });
      setStep('otp'); // register already issues the OTP
    } catch (err) {
      setError(err?.message || t('Errore di rete', 'Network error'));
    }
  });

  const verify = () => run(async () => {
    try {
      await clientAuth.verifyOtp(SALON_SLUG, phone.trim(), code.trim());
      // AppProvider is subscribed to the session store → app switches to Home.
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError(t('Codice non valido o scaduto', 'Invalid or expired code'));
      } else if (err instanceof ApiError && err.status === 429) {
        setError(t('Troppi tentativi. Riprova tra qualche minuto.', 'Too many attempts. Try again in a few minutes.'));
      } else {
        setError(err?.message || t('Errore di rete', 'Network error'));
      }
    }
  });

  return (
    <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
      {/* torna indietro (chiude l'overlay e riporta alla schermata precedente) */}
      {onClose && (
        <button className="press" onClick={onClose} aria-label={t('Indietro', 'Back')}
          style={{ position: 'absolute', top: 'calc(var(--safe-top) - 4px)', left: 14, zIndex: 30, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '7px 13px 7px 9px', borderRadius: 99, background: 'rgba(255,255,255,0.92)', color: 'var(--ink)', fontSize: 12.5, fontWeight: 700, border: 'none', cursor: 'pointer', boxShadow: 'var(--sh-sm)' }}>
          <Icon name="chevL" size={16} />{t('Indietro', 'Back')}
        </button>
      )}
      {/* lang toggle + chiusura overlay */}
      <div style={{ position: 'absolute', top: 'calc(var(--safe-top) - 4px)', right: 14, zIndex: 30, display: 'flex', alignItems: 'center', gap: 8 }}>
        {onClose && (
          <button className="press" onClick={onClose} aria-label="Chiudi"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 99, background: 'rgba(255,255,255,0.92)', border: 'none', cursor: 'pointer', marginRight: 8, boxShadow: 'var(--sh-sm)' }}>
            <Icon name="x" size={16} />
          </button>
        )}
        <button className="press" onClick={() => setLang(lang === 'it' ? 'en' : 'it')} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 99, background: 'rgba(255,255,255,0.92)', fontSize: 12, fontWeight: 700, color: 'var(--ink)', boxShadow: 'var(--sh-sm)', border: 'none', cursor: 'pointer' }}>
          <Icon name="globe" size={14} />{lang.toUpperCase()}
        </button>
      </div>

      {/* brand hero */}
      <div style={{ background: 'var(--brand)', padding: 'calc(var(--safe-top) + 34px) 24px 30px' }}>
        <div style={{ width: 62, height: 62, borderRadius: 99, background: 'var(--brand-on)', display: 'grid', placeItems: 'center', overflow: 'hidden', marginBottom: 14, boxShadow: '0 4px 14px rgba(0,0,0,0.18)' }}>
          {brand.logo
            ? <img src={brand.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ fontFamily: 'var(--serif)', fontSize: 28, fontStyle: 'italic', color: 'var(--brand)', lineHeight: 1 }}>{brand.name.charAt(0)}</span>}
        </div>
        <div style={{ fontFamily: headFont(brand), fontSize: 30, fontWeight: brand.type === 'serif' ? 500 : 800, color: 'var(--brand-on)', lineHeight: 1.05 }}>{brand.name}</div>
        <div style={{ color: 'var(--brand-on)', opacity: 0.75, fontSize: 13, fontWeight: 600, marginTop: 6 }}>
          {t('La tua area personale', 'Your personal area')}
        </div>
      </div>

      <div style={{ padding: '26px 24px 40px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {step === 'phone' && (
          <React.Fragment>
            <div className="t-h3">{t('Accedi con il tuo numero', 'Sign in with your number')}</div>
            <div className="t-body" style={{ color: 'var(--muted)' }}>
              {t('Ti invieremo un codice di accesso via SMS.', 'We will send you an access code by SMS.')}
            </div>
            {error && <div className="ca-err"><Icon name="alert" size={15} color="var(--danger)" />{error}</div>}
            <input className="ca-input" type="tel" inputMode="tel" autoComplete="tel" placeholder="+39 333 000 0000"
              value={phone} onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && phone.trim()) sendOtp(); }} />
            <button className="btn btn--brand btn--block press" disabled={!phone.trim() || busy}
              style={{ opacity: !phone.trim() || busy ? 0.5 : 1 }} onClick={sendOtp}>
              {busy ? t('Invio…', 'Sending…') : t('Ricevi il codice', 'Get the code')}
            </button>
          </React.Fragment>
        )}

        {step === 'register' && (
          <React.Fragment>
            <div className="t-h3">{t('Numero non registrato', 'Number not registered')}</div>
            <div className="t-body" style={{ color: 'var(--muted)' }}>
              {t('Crea il tuo profilo: bastano nome e cognome.', 'Create your profile: just first and last name.')}
            </div>
            {error && <div className="ca-err"><Icon name="alert" size={15} color="var(--danger)" />{error}</div>}
            <input className="ca-input" placeholder={t('Nome', 'First name')} autoComplete="given-name"
              value={reg.first_name} onChange={(e) => setReg((r) => ({ ...r, first_name: e.target.value }))} />
            <input className="ca-input" placeholder={t('Cognome', 'Last name')} autoComplete="family-name"
              value={reg.last_name} onChange={(e) => setReg((r) => ({ ...r, last_name: e.target.value }))} />
            <input className="ca-input" type="email" placeholder={t('Email (facoltativa)', 'Email (optional)')} autoComplete="email"
              value={reg.email} onChange={(e) => setReg((r) => ({ ...r, email: e.target.value }))} />
            <input className="ca-input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <button className="btn btn--brand btn--block press"
              disabled={!reg.first_name.trim() || !reg.last_name.trim() || !phone.trim() || busy}
              style={{ opacity: !reg.first_name.trim() || !reg.last_name.trim() || !phone.trim() || busy ? 0.5 : 1 }}
              onClick={doRegister}>
              {busy ? t('Creazione…', 'Creating…') : t('Crea profilo e ricevi il codice', 'Create profile & get the code')}
            </button>
            <button className="press" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}
              onClick={() => { setStep('phone'); setError(null); }}>
              {t('← Usa un altro numero', '← Use another number')}
            </button>
          </React.Fragment>
        )}

        {step === 'otp' && (
          <React.Fragment>
            <div className="t-h3">{t('Inserisci il codice', 'Enter the code')}</div>
            <div className="t-body" style={{ color: 'var(--muted)' }}>
              {t('Ti abbiamo inviato un codice a 6 cifre via SMS al numero ', 'We sent a 6-digit code by SMS to ')}<b>{phone}</b>.
            </div>
            {error && <div className="ca-err"><Icon name="alert" size={15} color="var(--danger)" />{error}</div>}
            <input className="ca-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="······"
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6) verify(); }} />
            <button className="btn btn--brand btn--block press" disabled={code.length !== 6 || busy}
              style={{ opacity: code.length !== 6 || busy ? 0.5 : 1 }} onClick={verify}>
              {busy ? t('Verifica…', 'Verifying…') : t('Entra', 'Sign in')}
            </button>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <button className="press" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}
                onClick={() => { setStep('phone'); setCode(''); setError(null); }}>
                {t('← Cambia numero', '← Change number')}
              </button>
              <button className="press" style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--brand-ink)', background: 'none', border: 'none', cursor: 'pointer' }}
                onClick={sendOtp} disabled={busy}>
                {t('Reinvia codice', 'Resend code')}
              </button>
            </div>
          </React.Fragment>
        )}
      </div>
    </div>
  );
}
