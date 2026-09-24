// StepChoice.jsx — passo -1 della prenotazione: prenotare nell'app o i pacchetti.
import { Icon } from '@youty/shared';
import { STEP } from './steps.js';

export function renderChoice(p) {
  const { t, brand, setView, setStep, head } = p;
  return (
    <div style={{ paddingBottom: 30 }}>
      {head(t('Prenota', 'Book'))}
      <div style={{ padding: '4px 22px' }} className="stagger">
        <div className="t-body" style={{ color: 'var(--muted)', marginBottom: 22, maxWidth: 320 }}>
          {t(`Come preferisci prenotare da ${brand.name}?`, `How would you like to book at ${brand.name}?`)}
        </div>

        {/* hero — recommended */}
        <button className="press" onClick={() => setStep(STEP.SERVICE)}
          style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 15, padding: '20px 18px', borderRadius: 'var(--r-lg, 20px)', background: 'var(--brand)', color: 'var(--brand-on)', marginBottom: 22, boxShadow: 'var(--sh-card)' }}>
          <div style={{ width: 50, height: 50, borderRadius: 15, background: 'rgba(255,255,255,0.16)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <Icon name="calendar" size={26} color="var(--brand-on)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '3px 9px', borderRadius: 99, background: 'rgba(255,255,255,0.2)', marginBottom: 7 }}>{t('Consigliato', 'Recommended')}</span>
            <div style={{ fontWeight: 700, fontSize: 18, lineHeight: 1.1 }}>{t('Prenota nell’app', 'Book in the app')}</div>
            <div style={{ fontSize: 13, opacity: 0.82, marginTop: 3 }}>{t('In 3 passaggi, solo orari liberi', '3 steps, only free times')}</div>
          </div>
          <Icon name="chevR" size={20} color="var(--brand-on)" />
        </button>

        <div className="t-meta" style={{ marginBottom: 12 }}>{t('Oppure', 'Or')}</div>
        <button className="press" onClick={() => setView('pacchetti')}
          style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 13, padding: 15, borderRadius: 'var(--r-md)', border: '1px solid var(--hair)', background: 'var(--paper-0)' }}>
          <div style={{ width: 44, height: 44, borderRadius: 99, background: 'var(--brand-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <Icon name="gift" size={21} color="var(--brand-ink)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15.5, color: 'var(--ink)' }}>{t('Pacchetti & offerte', 'Packages & offers')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Percorsi completi a prezzo speciale', 'Full journeys at a special price')}</div>
          </div>
          <Icon name="chevR" size={18} color="var(--muted-2)" />
        </button>
      </div>
    </div>
  );
}
