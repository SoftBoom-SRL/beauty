// StepService.jsx — passo 0: i servizi dal listino pubblico, anche più d'uno.
// Gli aggiuntivi (la nail art durante la manicure) non sono fra i servizi: da
// soli non si prenotano. Sotto ogni servizio scelto c'è «Aggiungi», col loro
// prezzo e senza tempo in più (vedi addons.js).
import React from 'react';
import { Icon, fmtDur, fmtEur } from '@youty/shared';
import { StickyCta } from '../../components/StickyCta.jsx';
import { catIcon, svcLangName, svcMinutes } from '../../lib/catalog.js';
import { coveredLabel, treatmentIcon } from '../../lib/wallet.js';
import { StepBar } from './parts.jsx';
import { STEP } from './steps.js';

export function renderService(p) {
  const {
    t, lang, setView, head, cats, serviceIds, toggleSvc, giftFor, price, setSlot, setDayIdx, setOperatorId, setStep,
    addonSvcs = [], toggleAddon, addonsFor, mainIds = serviceIds,
  } = p;
  const mains = (g) => g.services.filter((sv) => !sv.is_addon);
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
        ) : (cats.filter((c) => mains(c).length).map((g, gi, arr) => (
          <div key={g.id} style={{ marginBottom: gi === arr.length - 1 ? 0 : 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
              <Icon name={catIcon(g.name_it)} size={15} color="var(--brand-ink)" />
              <span className="t-meta">{svcLangName(g, lang)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {mains(g).map((sv) => {
                const on = serviceIds.includes(sv.id);
                const chosen = on && addonsFor ? addonsFor(sv.id) : [];
                return (
                  <React.Fragment key={sv.id}>
                    <button className="press" onClick={() => toggleSvc(sv.id)}
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
                          {/* già pagato: un regalo, un trattamento pagato in anticipo, una seduta del pacchetto */}
                          {giftFor(sv.id) && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 700, color: 'var(--brand-ink)', background: 'var(--brand-tint)', padding: '2px 8px', borderRadius: 99 }}>
                              <Icon name={treatmentIcon(giftFor(sv.id))} size={12} color="var(--brand-ink)" />
                              {coveredLabel(giftFor(sv.id), t)}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="t-num" style={{ fontSize: 17, color: 'var(--brand-ink)', flexShrink: 0 }}>{fmtEur(Number(sv.price), lang)}</span>
                    </button>
                    {/* «Aggiungi»: gli aggiuntivi di questo servizio, si fanno durante
                        lui e non allungano la visita */}
                    {on && addonSvcs.length > 0 && toggleAddon && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 7, margin: '-2px 0 2px 37px' }}>
                        <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 700 }}>{t('Aggiungi', 'Add')}</span>
                        {addonSvcs.map((a) => {
                          const added = chosen.includes(a.id);
                          return (
                            <button key={a.id} className="press" onClick={() => toggleAddon(sv.id, a.id)} aria-pressed={added}
                              title={t('Si fa durante il servizio: non allunga la visita', 'Done during the service: does not lengthen the visit')}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 11px', borderRadius: 99, fontSize: 13, fontWeight: 700, border: '1.5px solid ' + (added ? 'var(--brand)' : 'var(--hair)'), background: added ? 'var(--brand)' : 'var(--paper-0)', color: added ? 'var(--brand-on)' : 'var(--ink)' }}>
                              <Icon name={added ? 'check' : 'plus'} size={13} color={added ? 'var(--brand-on)' : 'var(--brand-ink)'} stroke={2.4} />
                              {svcLangName(a, lang)}
                              <span className="t-num" style={{ fontWeight: 600, opacity: 0.8 }}>{fmtEur(Number(a.price), lang)}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </React.Fragment>
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
          {/* i servizi si contano senza gli aggiuntivi, il prezzo li comprende */}
          {mainIds.length > 1
            ? t(`Continua · ${mainIds.length} servizi · ${fmtEur(price, lang)}`, `Continue · ${mainIds.length} services · ${fmtEur(price, lang)}`)
            : serviceIds.length > 1 ? t(`Continua · ${fmtEur(price, lang)}`, `Continue · ${fmtEur(price, lang)}`)
              : t('Continua', 'Continue')}
        </button>
      </StickyCta>
    </div>
  );
}
