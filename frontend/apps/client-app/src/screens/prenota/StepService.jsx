// StepService.jsx — passo 0: i servizi dal listino pubblico, anche più d'uno.
import { Icon, fmtDur, fmtEur } from '@youty/shared';
import { StickyCta } from '../../components/StickyCta.jsx';
import { catIcon, svcLangName, svcMinutes } from '../../lib/catalog.js';
import { StepBar } from './parts.jsx';
import { STEP } from './steps.js';

export function renderService(p) {
  const { t, lang, setView, head, cats, serviceIds, toggleSvc, giftFor, giftFrom, price, setSlot, setDayIdx, setOperatorId, setStep } = p;
  return (
    <div style={{ paddingBottom: 30, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      {head(t('Scegli il servizio', 'Choose a service'))}
      <StepBar i={0} t={t} />
      <div style={{ padding: '0 22px' }}>
        {/* singolo servizio vs pacchetto */}
        <div style={{ display: 'flex', gap: 4, background: 'var(--paper-2)', borderRadius: 99, padding: 4, marginBottom: 8 }}>
          <button className="press" style={{ flex: 1, padding: 9, borderRadius: 99, fontSize: 13, fontWeight: 700, background: 'var(--brand)', color: 'var(--brand-on)' }}>
            {t('Servizi singoli', 'Single services')}
          </button>
          <button className="press" onClick={() => setView('pacchetti')} style={{ flex: 1, padding: 9, borderRadius: 99, fontSize: 13, fontWeight: 700, background: 'transparent', color: 'var(--muted)' }}>
            {t('Pacchetti', 'Packages')}
          </button>
        </div>
        <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16 }}>{t('Puoi selezionare più servizi per la stessa visita.', 'You can pick more than one service for the same visit.')}</div>

        {!cats ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skel" style={{ height: 72, borderRadius: 'var(--r-md)' }} />)}
          </div>
        ) : (cats.filter((c) => c.services.length).map((g, gi, arr) => (
          <div key={g.id} style={{ marginBottom: gi === arr.length - 1 ? 0 : 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
              <Icon name={catIcon(g.name_it)} size={15} color="var(--brand-ink)" />
              <span className="t-meta">{svcLangName(g, lang)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {g.services.map((sv) => {
                const on = serviceIds.includes(sv.id);
                return (
                  <button key={sv.id} className="press" onClick={() => toggleSvc(sv.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 15, borderRadius: 'var(--r-md)', textAlign: 'left', border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--hair)'), background: on ? 'var(--brand-tint)' : 'var(--paper-0)' }}>
                    <div style={{ width: 24, height: 24, borderRadius: 8, flexShrink: 0, border: '1.5px solid ' + (on ? 'var(--brand)' : 'var(--line-strong)'), background: on ? 'var(--brand)' : 'transparent', display: 'grid', placeItems: 'center' }}>
                      {on && <Icon name="check" size={15} color="var(--brand-on)" stroke={2.6} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>{svcLangName(sv, lang)}</div>
                      {/* descrizione dal listino: due righe, poi taglia */}
                      {(lang === 'en' && sv.description_en ? sv.description_en : sv.description_it) && (
                        <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                          {lang === 'en' && sv.description_en ? sv.description_en : sv.description_it}
                        </div>
                      )}
                      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="clock" size={13} color="var(--muted-2)" />{fmtDur(svcMinutes(sv))}</span>
                        {giftFor(sv.id) && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 700, color: 'var(--brand-ink)', background: 'var(--brand-tint)', padding: '2px 8px', borderRadius: 99 }}>
                            <Icon name="gift" size={12} color="var(--brand-ink)" />
                            {giftFrom(giftFor(sv.id)) ? t(`Regalo di ${giftFrom(giftFor(sv.id))}`, `A gift from ${giftFrom(giftFor(sv.id))}`) : t('Hai un regalo', 'You have a gift')}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="t-num" style={{ fontSize: 17, color: 'var(--brand-ink)', flexShrink: 0 }}>{fmtEur(Number(sv.price), lang)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )))}
      </div>
      <div style={{ flex: 1 }} />
      <StickyCta>
        <button className="btn btn--brand btn--block press" disabled={!serviceIds.length} style={{ opacity: serviceIds.length ? 1 : 0.4 }}
          onClick={() => { setSlot(null); setDayIdx(0); setOperatorId(null); setStep(STEP.TIME); }}>
          {serviceIds.length > 1
            ? t(`Continua · ${serviceIds.length} servizi · ${fmtEur(price, lang)}`, `Continue · ${serviceIds.length} services · ${fmtEur(price, lang)}`)
            : t('Continua', 'Continue')}
        </button>
      </StickyCta>
    </div>
  );
}
