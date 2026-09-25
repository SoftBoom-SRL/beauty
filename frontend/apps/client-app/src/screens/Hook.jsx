// Hook.jsx — form pubblico di raccolta contatti del salone.
// Vive su /<slug>/hook: nessuna sessione, nessun OTP, solo lascia i tuoi dati.
// Il branding (logo, colore) è quello del salone, già caricato da ctx.
import React, { useState } from 'react';
import { Icon, PhoneInput, apiErrorText, isPlausiblePhone } from '@youty/shared';
import { useApp, SALON_SLUG } from '../ctx.jsx';
import { sendHook } from '../api/client.js';
import { BrandHero } from '../components/BrandHero.jsx';

export default function Hook() {
  const { t, lang, brand } = useApp();
  const [f, setF] = useState({ first_name: '', last_name: '', phone: '', email: '' });
  const [marketing, setMarketing] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [trap, setTrap] = useState(false); // honeypot: deve restare false
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const canSend = f.first_name.trim() && isPlausiblePhone(f.phone) && privacy && !busy;

  const submit = async () => {
    if (!canSend) return;
    setError(null);
    setBusy(true);
    try {
      await sendHook({
        salon_slug: SALON_SLUG,
        first_name: f.first_name.trim(),
        last_name: f.last_name.trim(),
        phone: f.phone.trim(),
        email: f.email.trim(),
        marketing,
        privacy,
        trap,
        // La lingua in cui la cliente ha compilato il modulo (contratto C13):
        // il contatto nuovo nasceva sempre in italiano, e conferme e promemoria
        // le arrivavano in una lingua che magari non legge (06-20).
        lang,
      });
      setDone(true);
    } catch (err) {
      // Il messaggio del server se una risposta è arrivata, altrimenti «Errore
      // di rete» (apiErrorText): con `err.message` senza rete compariva il
      // testo del browser, «Failed to fetch» (voce 31). Una risposta senza
      // messaggio resta «Errore di rete», come prima.
      setError(apiErrorText(err, t) || t('Errore di rete', 'Network error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      {/* hero col brand del salone */}
      <BrandHero brand={brand}
        subtitle={done ? t('Grazie!', 'Thank you!') : t('Lascia i tuoi contatti', 'Leave your contact details')} />

      <div style={{ padding: '26px 24px 40px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {done ? (
          <React.Fragment>
            <div className="t-h3">{t('Ti abbiamo registrata', 'You are on the list')}</div>
            <div className="t-body" style={{ color: 'var(--muted)' }}>
              {t('Ti contatteremo presto. A presto da ', 'We will be in touch soon. See you at ')}{brand.name}.
            </div>
          </React.Fragment>
        ) : (
          <React.Fragment>
            <div className="t-body" style={{ color: 'var(--muted)' }}>
              {t('Compila il modulo: ti ricontattiamo noi.', 'Fill in the form and we will get back to you.')}
            </div>

            {error && <div className="ca-err"><Icon name="alert" size={15} color="var(--danger)" />{error}</div>}

            <input className="ca-input" placeholder={t('Nome', 'First name')} autoComplete="given-name"
              value={f.first_name} onChange={set('first_name')} />
            <input className="ca-input" placeholder={t('Cognome', 'Last name')} autoComplete="family-name"
              value={f.last_name} onChange={set('last_name')} />
            <PhoneInput variant="client" lang={lang} value={f.phone} onChange={(v) => setF((s) => ({ ...s, phone: v }))} ariaLabel={t('Telefono', 'Phone')} />
            <input className="ca-input" type="email" inputMode="email" autoComplete="email" placeholder={t('Email', 'Email')}
              value={f.email} onChange={set('email')} />

            {/* Honeypot: una CHECKBOX, non un campo di testo. L'autofill di Chrome
              * riempiva il vecchio input `website` e faceva scartare utenti veri
              * in silenzio; le checkbox l'autofill non le spunta, mentre un bot
              * che compila tutto quello che trova sì. */}
            <input type="checkbox" tabIndex={-1} aria-hidden="true" checked={trap}
              onChange={(e) => setTrap(e.target.checked)}
              style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }} />

            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.45, cursor: 'pointer' }}>
              <input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)}
                style={{ marginTop: 2, width: 18, height: 18, accentColor: 'var(--brand)', flex: '0 0 auto' }} />
              <span>
                {t('Ho letto e accetto l’', 'I have read and accept the ')}
                {/* Senza URL configurato resta testo, non un link a vuoto: il
                  * modulo raccoglie lo stesso (scelta commerciale, vedi
                  * public_hook) e l'avviso alla titolare sta in dashboard. */}
                {brand.privacyUrl
                  ? <a href={brand.privacyUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand)', fontWeight: 700 }}>
                      {t('informativa privacy', 'privacy policy')}
                    </a>
                  : <strong>{t('informativa privacy', 'privacy policy')}</strong>}
                {t(' del salone.', ' of the salon.')}
              </span>
            </label>

            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.45, cursor: 'pointer' }}>
              <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)}
                style={{ marginTop: 2, width: 18, height: 18, accentColor: 'var(--brand)', flex: '0 0 auto' }} />
              <span style={{ color: 'var(--muted)' }}>
                {t('Acconsento a ricevere offerte e comunicazioni promozionali (facoltativo).',
                   'I agree to receive offers and promotional messages (optional).')}
              </span>
            </label>

            <button className="btn btn--brand btn--block press" disabled={!canSend}
              style={{ opacity: canSend ? 1 : 0.5 }} onClick={submit}>
              {busy ? t('Invio…', 'Sending…') : t('Invia', 'Send')}
            </button>
          </React.Fragment>
        )}
      </div>
    </div>
  );
}
