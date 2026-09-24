// StepTime.jsx — passo 1: operatrice, giorno e orario.
import { Icon } from '@youty/shared';
import { DayStrip } from '../../components/DayStrip.jsx';
import { SlotPicker } from '../../components/SlotPicker.jsx';
import { StickyCta } from '../../components/StickyCta.jsx';
import { StepBar, SummaryChip } from './parts.jsx';
import { STEP } from './steps.js';

export function renderTime(p) {
  const { t, lang, setView, head, svcs, dur, price, splitVisit, eligibleOperators, operatorId, setOperatorId, days, dayIdx, setDayIdx, slots, slot, setSlot, serviceIds, setStep } = p;
  return (
    <div style={{ paddingBottom: 30, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      {head(t('Scegli giorno e ora', 'Choose day & time'))}
      <StepBar i={1} t={t} />
      <div style={{ padding: '0 22px' }}>
        <SummaryChip svcs={svcs} dur={dur} price={price} lang={lang} />
        {/* Nessuna operatrice copre l'intera selezione: si prenota comunque,
          * ma la visita viene divisa. Senza questa riga la cliente vedeva
          * solo sparire il selettore. */}
        {splitVisit && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginBottom: 20, padding: '11px 13px', borderRadius: 'var(--r-md)', background: 'var(--paper-2)' }}>
            <Icon name="info" size={16} color="var(--muted-2)" />
            <div className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.45 }}>
              {t('Nessuna operatrice svolge tutti i servizi che hai scelto: ognuno sarà affidato a chi è libera in quel momento.',
                'No single stylist does all the services you picked: each one goes to whoever is free at that time.')}
            </div>
          </div>
        )}
        {/* stylist picker — "prima disponibile" + operatrici idonee ai servizi scelti */}
        {eligibleOperators.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div className="t-meta" style={{ marginBottom: 10 }}>{t('Operatrice', 'Stylist')}</div>
            <div className="scroll" style={{ display: 'flex', gap: 9, overflowX: 'auto', paddingBottom: 6, marginInline: -2, paddingInline: 2 }}>
              <button className="press" onClick={() => setOperatorId(null)}
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderRadius: 99, border: '1.5px solid ' + (operatorId === null ? 'var(--brand)' : 'var(--hair)'), background: operatorId === null ? 'var(--brand)' : 'var(--paper-0)', color: operatorId === null ? 'var(--brand-on)' : 'var(--ink)' }}>
                <Icon name="sparkle" size={15} color={operatorId === null ? 'var(--brand-on)' : 'var(--brand-ink)'} />
                <span style={{ fontSize: 13.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{t('Prima disponibile', 'First available')}</span>
              </button>
              {eligibleOperators.map((op) => {
                const on = operatorId === op.id;
                return (
                  <button key={op.id} className="press" onClick={() => setOperatorId(op.id)}
                    style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px 7px 7px', borderRadius: 99, border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--hair)'), background: on ? 'var(--brand)' : 'var(--paper-0)', color: on ? 'var(--brand-on)' : 'var(--ink)' }}>
                    <div style={{ width: 24, height: 24, borderRadius: 99, background: op.color, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: '#2a2a2a' }}>{op.initials}</span>
                    </div>
                    <span style={{ fontSize: 13.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{op.first_name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {/* day strip — next 14 days */}
        <DayStrip days={days} dayIdx={dayIdx} onPick={setDayIdx} lang={lang} />

        <SlotPicker slots={slots} slot={slot} onPick={setSlot} t={t} empty={(
          <div style={{ padding: '28px 16px', borderRadius: 'var(--r-md)', border: '1px dashed var(--hair)', textAlign: 'center' }}>
            <Icon name="clock" size={26} color="var(--muted-2)" />
            <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 8, marginBottom: 14 }}>
              {t('Nessun orario libero questo giorno. Prova un altro giorno o mettiti in lista d’attesa.', 'No free time this day. Try another day or join the waiting list.')}
            </div>
            <button className="press" onClick={() => setView('waitlist-new', { serviceId: serviceIds[0] || null })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 18px', borderRadius: 99, background: 'var(--brand-tint)', color: 'var(--brand-ink)', fontWeight: 700, fontSize: 13.5 }}>
              <Icon name="clock" size={15} color="var(--brand-ink)" />{t('Vai alla lista d’attesa', 'Go to waiting list')}
            </button>
          </div>
        )} />
      </div>
      <div style={{ flex: 1 }} />
      <StickyCta>
        <button className="btn btn--brand btn--block press" disabled={!slot} style={{ opacity: slot ? 1 : 0.4 }} onClick={() => setStep(STEP.REVIEW)}>
          {t('Continua', 'Continue')}
        </button>
      </StickyCta>
    </div>
  );
}
