// StepReview.jsx — passo 2: il riepilogo e la conferma.
import { Icon, fmtDur, fmtEur, minutesOfDay, timeLabel } from '@youty/shared';
import { headFont, headWeight } from '../../theme.js';
import { DetailRow } from '../../components/DetailRow.jsx';
import { StickyCta } from '../../components/StickyCta.jsx';
import { catIcon, svcLangName } from '../../lib/catalog.js';
import { fmtDayMed } from '../../lib/dates.js';
import { StepBar } from './parts.jsx';
import { STEP } from './steps.js';

export function renderReview(p) {
  const { t, lang, brand, session, head, s, svcs, slot, dur, selectedOperator, price, giftedSelected, giftFrom, booking, confirm, setStep } = p;
  return (
    <div style={{ paddingBottom: 30, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      {head(t('Conferma prenotazione', 'Confirm booking'))}
      <StepBar i={2} t={t} />
      <div style={{ padding: '0 22px' }}>
        <div className="card" style={{ padding: 20, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--hair)' }}>
            <div style={{ width: 46, height: 46, borderRadius: 13, background: 'var(--brand-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
              <Icon name={catIcon(s?.catName)} size={23} color="var(--brand-ink)" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: headFont(brand), fontSize: 19, fontWeight: headWeight(brand, 700), lineHeight: 1.2 }}>
                {svcs.map((sv) => svcLangName(sv, lang)).join(' + ')}
              </div>
            </div>
          </div>
          {svcs.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--hair)' }}>
              {svcs.map((sv) => (
                <div key={sv.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5 }}>
                  <span style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{svcLangName(sv, lang)}</span>
                  <span className="t-num" style={{ color: 'var(--muted)' }}>{fmtEur(Number(sv.price), lang)}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            <DetailRow icon="calendar" label={t('Quando', 'When')} value={slot ? fmtDayMed(slot.start, lang) + ' · ' + timeLabel(minutesOfDay(slot.start)) : '—'} />
            <DetailRow icon="clock" label={t('Durata', 'Duration')} value={fmtDur(dur)} />
            <DetailRow icon="user" label={t('Operatrice', 'Stylist')} value={selectedOperator ? `${selectedOperator.first_name} ${selectedOperator.last_name}` : t('Prima disponibile', 'First available')} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--hair)' }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>{t('Totale', 'Total')}</span>
            <span className="t-num" style={{ fontSize: 22, color: 'var(--brand-ink)' }}>{fmtEur(price, lang)}</span>
          </div>
          {/* trattamenti già regalati: si vedono qui, non alla cassa */}
          {giftedSelected.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 12, padding: '11px 13px', borderRadius: 'var(--r-md)', background: 'var(--brand-tint)' }}>
              <Icon name="gift" size={17} color="var(--brand-ink)" />
              <div style={{ fontSize: 13, lineHeight: 1.45, color: 'var(--ink-2)' }}>
                <b style={{ color: 'var(--brand-ink)' }}>{t('Coperto da gift card', 'Covered by a gift card')}</b>
                {': '}
                {giftedSelected.map((g) => g.gift_service_name).join(', ')}
                {giftFrom(giftedSelected[0]) ? t(` · regalo di ${giftFrom(giftedSelected[0])}`, ` · a gift from ${giftFrom(giftedSelected[0])}`) : ''}
                {'. '}
                {t('In salone non pagherai questa parte.', 'You will not pay this part in the salon.')}
              </div>
            </div>
          )}
        </div>
        <div className="t-sm" style={{ color: 'var(--muted)', display: 'flex', alignItems: 'flex-start', gap: 7 }}>
          <Icon name="check" size={14} color="var(--ok)" stroke={2.4} />
          <span style={{ flex: 1 }}>{t('Mostriamo solo orari davvero liberi: se richiesta, la caparra ti verrà comunicata alla conferma.', 'We only show truly free times: if a deposit is required, you’ll be told on confirmation.')}</span>
        </div>
      </div>
      <div style={{ flex: 1 }} />
      <StickyCta>
        <button className="btn btn--brand btn--block press" disabled={booking} style={{ opacity: booking ? 0.6 : 1 }}
          onClick={() => (session ? confirm() : setStep(STEP.DETAILS))}>
          <Icon name="check" size={18} color="var(--brand-on)" />
          {booking ? t('Prenotazione…', 'Booking…') : t('Conferma prenotazione', 'Confirm booking')}
        </button>
      </StickyCta>
    </div>
  );
}
