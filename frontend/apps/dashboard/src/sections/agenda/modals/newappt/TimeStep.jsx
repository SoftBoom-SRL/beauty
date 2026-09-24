// TimeStep — il passo 3 del drawer: l'esito dell'orario chiesto dall'agenda
// (libero, o perché no, con le alternative più vicine: requestStatus), gli
// orari liberi di mattina e di pomeriggio, e «nessun orario libero» con le
// strade per trovarne uno. `stepRef` è la ref del passo.
import { Icon, minutesOfDay, timeLabel } from '@youty/shared';
import { firstName, AFTERNOON_MIN } from '../../lib.js';
import StepLabel from './StepLabel.jsx';

export default function TimeStep({
  stepRef, slots, selStart, pickSlot, reqStatus, req, reqOp, setReq, totalDur, showAll, setShowAll, dateLabel, items, setItems,
  eligibleOps, shiftDate, operators, t,
}) {
  const morning = (slots || []).filter((s) => minutesOfDay(s.start) < AFTERNOON_MIN);
  const afternoon = (slots || []).filter((s) => minutesOfDay(s.start) >= AFTERNOON_MIN);
  const anyRecommended = (slots || []).some((s) => s.recommended) && (slots || []).some((s) => s.recommended === false);
  /* Il bottone di un orario. È definito qui dentro e quindi è un componente
   * nuovo a ogni render: React rimonta i bottoni degli orari a ogni
   * disegno (e il fuoco si perde). Così era, e così resta (bug segnalato,
   * da correggere a parte). */
  const SlotChip = ({ s }) => {
    const sel = s.start === selStart;
    const who = (s.assignment || []).map((a) => firstName(operators.find((o) => o.id === a.operator_id)?.first_name)).filter(Boolean);
    const meh = s.recommended === false; // lascerebbe un buco invendibile: si può scegliere, ma è attenuato
    const title = [who.length ? t('Con ', 'With ') + [...new Set(who)].join(', ') : '', meh ? t('Lascerebbe un buco troppo corto per un altro servizio', 'Would leave a gap too short for another service') : (anyRecommended ? t('Consigliato: non lascia buchi', 'Recommended: leaves no gaps') : '')].filter(Boolean).join(' · ');
    return (
      <button key={s.start} type="button" onClick={() => pickSlot(s.start)} className={'dk-slot' + (sel ? ' dk-slot--on' : '')} title={title} style={meh && !sel ? { opacity: 0.55 } : undefined}>
        {timeLabel(minutesOfDay(s.start))}{!meh && anyRecommended && !sel && <span aria-hidden="true" style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 99, background: 'var(--ok)', marginLeft: 5, verticalAlign: 'middle' }} />}
      </button>
    );
  };
  return (
    <div ref={stepRef} style={{ marginBottom: 18 }}>
      <StepLabel n={3} done={!!selStart} t={t}>{t('Orario', 'Time')}</StepLabel>

      {/* orario richiesto: esito esplicito */}
      {reqStatus && !reqStatus.loading && (
        reqStatus.ok ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, background: 'var(--ok-tint)', border: '1px solid color-mix(in srgb, var(--ok) 35%, transparent)', marginBottom: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--ok)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="check" size={16} color="#fff" stroke={2.6} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }} className="tabnum">{timeLabel(req.startMin)}–{timeLabel(req.startMin + totalDur)}{reqOp ? ' · ' + reqOp.first_name : ''}</div>
              <div className="t-sm" style={{ color: 'var(--ok)', fontWeight: 600 }}>{t('Disponibile', 'Available')}{selStart ? ' · ' + t('selezionato', 'selected') : ''}</div>
            </div>
            <button type="button" onClick={() => setShowAll((v) => !v)} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer' }}>{showAll ? t('Nascondi altri', 'Hide others') : t('Altri orari', 'Other times')}</button>
          </div>
        ) : (
          /* Ambra e non rosso: l'orario chiesto si può prendere lo stesso
             (il pulsante «Inserisci comunque» è qui sotto), quindi questo
             pannello avvisa, non nega. */
          <div style={{ padding: '10px 12px', borderRadius: 12, background: 'var(--warn-tint)', border: '1px solid color-mix(in srgb, var(--warn) 40%, transparent)', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--warn)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="alert" size={16} color="#fff" stroke={2.6} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}><span className="tabnum">{timeLabel(req.startMin)}</span> · {selStart && minutesOfDay(selStart) === req.startMin
                  ? t('non libero, si prenota lo stesso', 'not free, booking anyway')
                  : t('non libero: scegli un altro orario', 'not free: pick another time')}</div>
                <div className="t-sm" style={{ color: 'var(--warn)', fontWeight: 600 }}>{reqStatus.label}</div>
                {reqStatus.detail && <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{reqStatus.detail}</div>}
              </div>
            </div>
            {reqStatus.alternatives.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="t-sm" style={{ fontWeight: 700, color: 'var(--ink-2)', marginBottom: 6 }}>{t('Alternative più vicine', 'Closest alternatives')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{reqStatus.alternatives.map((s) => <SlotChip key={s.start} s={s} />)}</div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
              {reqOp && <button type="button" onClick={() => { setReq((r) => ({ ...r, operatorId: null })); setItems((l) => l.map((it) => ({ ...it, operator_id: null }))); }} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer' }}>{t('Chiunque sia libera a quest’ora', 'Anyone free at this time')}</button>}
              <button type="button" onClick={() => setShowAll(true)} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer' }}>{t('Tutti gli orari del giorno', 'All times today')}</button>
            </div>
          </div>
        )
      )}

      {slots === null ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{[...Array(10)].map((_, i) => <div key={i} className="skel" style={{ width: 58, height: 32, borderRadius: 9 }} />)}</div>
      ) : (showAll || (!reqStatus && !selStart)) && slots.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[[t('Mattina', 'Morning'), morning], [t('Pomeriggio', 'Afternoon'), afternoon]].filter(([, l]) => l.length).map(([label, list]) => (
            <div key={label}>
              <div className="t-meta" style={{ fontSize: 10, marginBottom: 6 }}>{label} · {list.length}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{list.map((s) => <SlotChip key={s.start} s={s} />)}</div>
            </div>
          ))}
          {anyRecommended && (
            <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 5, height: 5, borderRadius: 99, background: 'var(--ok)' }} />{t('Consigliati: non lasciano buchi invendibili. Gli altri restano disponibili, attenuati.', 'Recommended: leave no unsellable gaps. The others stay available, dimmed.')}
            </div>
          )}
        </div>
      ) : slots.length === 0 ? (
        <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--warn-tint)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Icon name="alert" size={16} color="var(--warn)" style={{ marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{t('Nessun orario libero', 'No free time')} · {dateLabel}</div>
            <div className="t-sm" style={{ color: 'var(--ink-2)', marginTop: 2 }}>
              {items.some((it) => !eligibleOps(it.service_id).length)
                ? t('Un servizio scelto non ha operatrici abilitate.', 'A chosen service has no enabled stylist.')
                : items.some((it) => it.operator_id) ? t('L’operatrice scelta non ha spazio per questa durata: prova “Prima disponibile” o un altro giorno.', 'The chosen stylist has no room for this duration: try “First available” or another day.')
                  : t('Nessuna operatrice abilitata ha spazio per questa durata: prova un altro giorno.', 'No enabled stylist has room for this duration: try another day.')}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button type="button" className="dk-btn dk-btn--ghost" style={{ height: 32, fontSize: 12.5 }} onClick={() => shiftDate(1)}>{t('Giorno dopo', 'Next day')}<Icon name="chevR" size={14} /></button>
              {items.some((it) => it.operator_id) && <button type="button" className="dk-btn dk-btn--ghost" style={{ height: 32, fontSize: 12.5 }} onClick={() => setItems((l) => l.map((it) => ({ ...it, operator_id: null })))}><Icon name="sparkle" size={14} />{t('Prima disponibile', 'First available')}</button>}
            </div>
          </div>
        </div>
      ) : selStart && !showAll ? (
        !reqStatus && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, background: 'var(--surface-2)' }}>
            <Icon name="clock" size={16} color="var(--clay-ink)" />
            <span className="tabnum" style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{timeLabel(minutesOfDay(selStart))}–{timeLabel(minutesOfDay(selStart) + totalDur)}</span>
            <button type="button" onClick={() => setShowAll(true)} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer' }}>{t('Cambia orario', 'Change time')}</button>
          </div>
        )
      ) : null}
    </div>
  );
}
