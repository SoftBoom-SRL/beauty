// StepOtp.jsx — passo 4, solo senza sessione: il codice via SMS, o la registrazione.
import React from 'react';
import { Icon } from '@youty/shared';
import { StickyCta } from '../../components/StickyCta.jsx';
import { BlockedNotice } from './parts.jsx';

export function renderOtp(p) {
  const { t, brand, head, ident, otp, setOtp, otpErr, blocked, codeSurelySent, booking, sendBookingOtp, registerAndOtp, verifyAndBook } = p;
  return (
    <div style={{ paddingBottom: 30, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      {head(t('Conferma il numero', 'Confirm your number'))}
      <div style={{ padding: '4px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="t-sm" style={{ color: 'var(--muted)' }}>
          {codeSurelySent
            ? <React.Fragment>{t('Inserisci il codice a 6 cifre inviato al ', 'Enter the 6-digit code sent to ')}<b>{ident.phone}</b>.</React.Fragment>
            : <React.Fragment>{t('Se il numero ', 'If ')}<b>{ident.phone}</b>{t(' è già registrato, ti abbiamo inviato un codice a 6 cifre.', ' is already registered, we have sent you a 6-digit code.')}</React.Fragment>}
        </div>
        {otpErr && <div className="ca-err"><Icon name="alert" size={15} color="var(--danger)" />{otpErr}</div>}
        {blocked ? <BlockedNotice t={t} brand={brand} /> : null}
        <input className="ca-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="······"
          value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={(e) => { if (e.key === 'Enter' && otp.length === 6) verifyAndBook(); }} />
        <button className="press" style={{ alignSelf: 'flex-start', fontSize: 13, fontWeight: 700, color: 'var(--brand-ink)', background: 'none', border: 'none', cursor: 'pointer' }}
          onClick={sendBookingOtp} disabled={booking}>{t('Reinvia codice', 'Resend code')}</button>
        {/* L'unica via per chi è nuova: il server non può dirci che il numero
          * non esiste, quindi glielo chiediamo noi. Senza questo pulsante la
          * cliente nuova resta qui ad aspettare un SMS che nessuno le manda. */}
        {!codeSurelySent && (
          <React.Fragment>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <div style={{ flex: 1, height: 1, background: 'var(--hair)' }} />
              <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('oppure', 'or')}</span>
              <div style={{ flex: 1, height: 1, background: 'var(--hair)' }} />
            </div>
            <button className="btn btn--ghost btn--block press" onClick={registerAndOtp} disabled={booking}>
              {booking ? t('Attendi…', 'Please wait…') : t('È la prima volta? Registrati', 'First time here? Sign up')}
            </button>
          </React.Fragment>
        )}
      </div>
      <div style={{ flex: 1 }} />
      <StickyCta>
        <button className="btn btn--brand btn--block press" disabled={otp.length !== 6 || booking} style={{ opacity: otp.length === 6 && !booking ? 1 : 0.5 }} onClick={verifyAndBook}>
          <Icon name="check" size={18} color="var(--brand-on)" />
          {booking ? t('Conferma…', 'Confirming…') : t('Conferma prenotazione', 'Confirm booking')}
        </button>
      </StickyCta>
    </div>
  );
}
