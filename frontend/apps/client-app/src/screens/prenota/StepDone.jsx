// StepDone.jsx — prenotato: la conferma, e la caparra se il salone la chiede.
import { Icon, fmtEur, minutesOfDay, timeLabel } from '@youty/shared';
import { DepositDue } from '../../components/DepositDue.jsx';
import { SuccessScreen } from '../../components/SuccessScreen.jsx';
import { fmtDayMed } from '../../lib/dates.js';

export function renderDone(p) {
  const { t, lang, brand, setView, fireToast, booked } = p;
  const dep = Number(booked.deposit_amount || 0);
  const depRequired = booked.deposit_status === 'required' && dep > 0;
  return (
    <SuccessScreen brand={brand} title={t('Fatto!', 'All set!')}
      text={t(`Appuntamento confermato per ${fmtDayMed(booked.start, lang)} alle ${timeLabel(minutesOfDay(booked.start))}. Ti abbiamo inviato la conferma su WhatsApp 💫`,
        `Appointment confirmed for ${fmtDayMed(booked.start, lang)} at ${timeLabel(minutesOfDay(booked.start))}. We've sent your confirmation on WhatsApp 💫`)}>
      {depRequired && (
        <div style={{ maxWidth: 340, width: '100%', textAlign: 'left' }}>
          <div style={{ display: 'flex', gap: 12, padding: 15, background: 'var(--brand-tint)', borderRadius: 'var(--r-md)', marginTop: 18 }}>
            <Icon name="coupon" size={20} color="var(--brand-ink)" />
            <div style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--ink-2)' }}>
              {t(`Per confermare serve una caparra di ${fmtEur(dep, lang)}, che verrà scalata dal totale.`,
                `To confirm we need a ${fmtEur(dep, lang)} deposit, which is deducted from the total.`)}
            </div>
          </div>
          {/* pagamento subito: il link è già pronto se il salone incassa online */}
          <DepositDue appt={booked} t={t} lang={lang} fireToast={fireToast} />
        </div>
      )}
      {booked.deposit_status === 'paid' && dep > 0 && (
        <div className="t-sm" style={{ color: 'var(--ok)', marginTop: 14, fontWeight: 700 }}>
          {t(`Deposito di ${fmtEur(dep, lang)} versato`, `${fmtEur(dep, lang)} deposit paid`)}
        </div>
      )}
      <button className="btn btn--brand press" style={{ marginTop: 26 }} onClick={() => setView('home')}>{t('Torna alla home', 'Back to home')}</button>
    </SuccessScreen>
  );
}
