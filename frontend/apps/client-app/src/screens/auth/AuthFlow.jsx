// AuthFlow.jsx — client login: phone → OTP (via SMS) → session.
// La registrazione è un'azione della schermata del codice, non una conseguenza
// della risposta del server: vedi `sendOtp`.
import React, { useState } from 'react';
import { Icon, PhoneInput, isPlausiblePhone } from '@youty/shared';
import { useApp } from '../../ctx.jsx';
import { BrandHero } from '../../components/BrandHero.jsx';
import { useOtpFlow } from '../../hooks/useOtpFlow.js';

export default function AuthFlow({ onClose }) {
  const { t, lang, setLang, brand } = useApp();
  const [step, setStep] = useState('phone'); // phone | register | otp | blocked
  const [phone, setPhone] = useState('');
  const [reg, setReg] = useState({ first_name: '', last_name: '', email: '' });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  // Gli errori si leggono sotto il campo (vedi useOtpFlow).
  const { error, setError, codeSurelySent, request, register, verify: verifyCode } = useOtpFlow({ phone, t });

  const run = async (fn) => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  /* Richiesta del codice. La risposta è SEMPRE la stessa, numero noto o no: il
   * server non ammette più quali numeri sono in anagrafica (bastava ciclarli
   * per farsi la rubrica del salone). Quindi non c'è nessun 404 da cui dedurre
   * «cliente nuova»: si va sempre alla schermata del codice, con un messaggio
   * al condizionale, e chi non è ancora registrata si registra da lì. */
  const sendOtp = () => run(async () => {
    // Il codice appena rispedito rende invalido quello precedente: lasciarlo
    // nel campo faceva fallire il tocco successivo con «codice non valido».
    setCode('');
    if (await request()) setStep('otp');
  });

  const doRegister = () => run(async () => {
    setCode('');
    const res = await register({
      first_name: reg.first_name.trim(),
      last_name: reg.last_name.trim(),
      phone: phone.trim(),
      email: reg.email.trim(),
      lang,
    });
    if (res === 'ok') setStep('otp');
    // «Numero già registrato». Da quando l'accesso non rivela più chi è in
    // anagrafica, questo non basta a dire QUALE dei due casi sia: o la scheda
    // esiste ed è attiva (il codice chiesto poco fa è davvero partito, basta
    // inserirlo) oppure esiste ma è disattivata, e allora da qui non si entra.
    // Non potendo distinguerli si mostra lo schermo dedicato, che dice
    // entrambe le cose e lascia due uscite invece di un vicolo cieco.
    else if (res === 'blocked') setStep('blocked');
  });

  const verify = () => run(async () => {
    await verifyCode(code.trim());
    // AppProvider is subscribed to the session store → app switches to Home.
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
      <BrandHero brand={brand} subtitle={t('La tua area personale', 'Your personal area')} />

      <div style={{ padding: '26px 24px 40px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {step === 'phone' && (
          <React.Fragment>
            <div className="t-h3">{t('Accedi con il tuo numero', 'Sign in with your number')}</div>
            <div className="t-body" style={{ color: 'var(--muted)' }}>
              {t('Ti invieremo un codice di accesso via SMS.', 'We will send you an access code by SMS.')}
            </div>
            {error && <div className="ca-err"><Icon name="alert" size={15} color="var(--danger)" />{error}</div>}
            {/* Invio vale quanto il pulsante: solo con un numero plausibile.
              * Controllava solo che il campo non fosse vuoto, e un numero a metà
              * passava alla schermata del codice consumando i tentativi per
              * IP e per salone (16-10). */}
            <PhoneInput variant="client" lang={lang} value={phone} onChange={setPhone} onEnter={() => { if (isPlausiblePhone(phone)) sendOtp(); }} ariaLabel={t('Numero di telefono', 'Phone number')} />
            <button className="btn btn--brand btn--block press" disabled={!isPlausiblePhone(phone) || busy}
              style={{ opacity: !isPlausiblePhone(phone) || busy ? 0.5 : 1 }} onClick={sendOtp}>
              {busy ? t('Invio…', 'Sending…') : t('Ricevi il codice', 'Get the code')}
            </button>
          </React.Fragment>
        )}

        {step === 'register' && (
          <React.Fragment>
            <div className="t-h3">{t('Crea il tuo profilo', 'Create your profile')}</div>
            <div className="t-body" style={{ color: 'var(--muted)' }}>
              {t('È la prima volta qui? Bastano nome e cognome: ti invieremo subito il codice di accesso.',
                'First time here? Just first and last name: we will send you the access code right away.')}
            </div>
            {error && <div className="ca-err"><Icon name="alert" size={15} color="var(--danger)" />{error}</div>}
            <input className="ca-input" placeholder={t('Nome', 'First name')} autoComplete="given-name"
              value={reg.first_name} onChange={(e) => setReg((r) => ({ ...r, first_name: e.target.value }))} />
            <input className="ca-input" placeholder={t('Cognome', 'Last name')} autoComplete="family-name"
              value={reg.last_name} onChange={(e) => setReg((r) => ({ ...r, last_name: e.target.value }))} />
            <input className="ca-input" type="email" placeholder={t('Email (facoltativa)', 'Email (optional)')} autoComplete="email"
              value={reg.email} onChange={(e) => setReg((r) => ({ ...r, email: e.target.value }))} />
            <PhoneInput variant="client" lang={lang} value={phone} onChange={setPhone} ariaLabel={t('Numero di telefono', 'Phone number')} />
            <button className="btn btn--brand btn--block press"
              disabled={!reg.first_name.trim() || !reg.last_name.trim() || !isPlausiblePhone(phone) || busy}
              style={{ opacity: !reg.first_name.trim() || !reg.last_name.trim() || !isPlausiblePhone(phone) || busy ? 0.5 : 1 }}
              onClick={doRegister}>
              {busy ? t('Creazione…', 'Creating…') : t('Crea profilo e ricevi il codice', 'Create profile & get the code')}
            </button>
            <button className="press" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}
              onClick={() => { setStep('otp'); setError(null); }}>
              {t('← Ho già un profilo: inserisco il codice', '← I already have a profile: enter the code')}
            </button>
          </React.Fragment>
        )}

        {/* «Numero già registrato»: o la cliente c'è già (e il codice chiesto
          * poco fa le è arrivato) oppure la sua scheda è disattivata e da qui
          * non si entra. Si dicono entrambe le cose e si lasciano due uscite:
          * tornare al codice, o chiamare il salone se non arriva niente. */}
        {step === 'blocked' && (
          <React.Fragment>
            <div className="t-h3">{t('Numero già registrato', 'Number already registered')}</div>
            <div className="t-body" style={{ color: 'var(--muted)' }}>
              {t('Questo numero è già in anagrafica: se hai ricevuto il codice, inseriscilo e accedi. Se non ti arriva nulla la scheda potrebbe non essere attiva: contatta il salone per riattivarla.',
                'This number is already on file: if you got the code, enter it and sign in. If nothing arrives your profile may not be active: contact the salon to reactivate it.')}
            </div>
            <button className="btn btn--brand btn--block press" onClick={() => { setStep('otp'); setError(null); }}>
              {t('Inserisci il codice', 'Enter the code')}
            </button>
            {brand.phone && (
              <a href={`tel:${brand.phone}`} className="btn btn--ghost btn--block press" style={{ textDecoration: 'none' }}>
                <Icon name="phone" size={17} color="var(--ink)" />{t('Chiama il salone', 'Call the salon')}
              </a>
            )}
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
              {codeSurelySent
                ? <React.Fragment>{t('Ti abbiamo inviato un codice a 6 cifre via SMS al numero ', 'We sent a 6-digit code by SMS to ')}<b>{phone}</b>.</React.Fragment>
                : <React.Fragment>{t('Se il numero ', 'If ')}<b>{phone}</b>{t(' è registrato, ti abbiamo inviato un codice a 6 cifre via SMS.', ' is registered, we have sent a 6-digit code by SMS.')}</React.Fragment>}
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
            {/* L'unica via per chi è nuova: il server non può dirci che il
              * numero non esiste, quindi glielo chiediamo noi. Deve restare
              * ben visibile, altrimenti la cliente nuova aspetta un SMS che
              * nessuno le ha mandato. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
              <div style={{ flex: 1, height: 1, background: 'var(--hair)' }} />
              <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('oppure', 'or')}</span>
              <div style={{ flex: 1, height: 1, background: 'var(--hair)' }} />
            </div>
            <button className="btn btn--ghost btn--block press" onClick={() => { setStep('register'); setError(null); }}>
              {t('È la prima volta? Registrati', 'First time here? Sign up')}
            </button>
          </React.Fragment>
        )}
      </div>
    </div>
  );
}
