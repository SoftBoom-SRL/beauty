// StepDetails.jsx — passo 3, solo senza sessione: nome, cognome e telefono.
import { Icon, PhoneInput } from '@youty/shared';
import { StickyCta } from '../../components/StickyCta.jsx';
import { BlockedNotice } from './parts.jsx';

export function renderDetails(p) {
  const { t, lang, brand, head, ident, setIdent, otpErr, blocked, booking, sendBookingOtp } = p;
  const okData = ident.first_name.trim() && ident.last_name.trim() && ident.phone.trim();
  return (
    <div style={{ paddingBottom: 30, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      {head(t('I tuoi dati', 'Your details'))}
      <div style={{ padding: '4px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="t-sm" style={{ color: 'var(--muted)' }}>
          {t('Ti inviamo un codice via SMS per confermare la prenotazione.', 'We send an SMS code to confirm your booking.')}
        </div>
        {/* Il controllo sul numero scriveva in `otpErr`, che però si vedeva
          * solo allo step successivo: premendo «Invia codice» con un numero
          * troppo corto non succedeva NIENTE e non si capiva perché. */}
        {otpErr && <div className="ca-err"><Icon name="alert" size={15} color="var(--danger)" />{otpErr}</div>}
        {blocked ? <BlockedNotice t={t} brand={brand} /> : null}
        <input className="ca-input" placeholder={t('Nome', 'First name')} autoComplete="given-name"
          value={ident.first_name} onChange={(e) => setIdent((v) => ({ ...v, first_name: e.target.value }))} />
        <input className="ca-input" placeholder={t('Cognome', 'Last name')} autoComplete="family-name"
          value={ident.last_name} onChange={(e) => setIdent((v) => ({ ...v, last_name: e.target.value }))} />
        <PhoneInput variant="client" lang={lang} value={ident.phone} onChange={(v) => setIdent((s) => ({ ...s, phone: v }))} ariaLabel={t('Numero di telefono', 'Phone number')} />
      </div>
      <div style={{ flex: 1 }} />
      <StickyCta>
        <button className="btn btn--brand btn--block press" disabled={!okData || booking} style={{ opacity: okData && !booking ? 1 : 0.5 }} onClick={sendBookingOtp}>
          {booking ? t('Invio…', 'Sending…') : t('Invia codice', 'Send code')}
        </button>
      </StickyCta>
    </div>
  );
}
