// WhoWhenCard — chi e quando, modificabili qui: l'operatrice, l'ora di inizio
// (un passo prima o dopo, o scritta), il giorno da sfogliare (l'agenda di
// fianco lo segue) con «Sposta a …», e «Passa a» un'altra operatrice.
// Prima erano due scritte, e per spostare di un quarto d'ora o passare la
// cliente alla collega bisognava entrare in «Riprogramma», che è un'altra
// schermata. Senza hook: gli spostamenti sono di useMoveFromPanel.
import { Avatar, Icon, fmtDateIt, fmtDur, timeLabel } from '@youty/shared';
import { initialsOf, LAST_START_MIN } from '../../lib.js';

export default function WhoWhenCard({
  appt, o, col, t, lang, canMove, movingBusy, stepMin, startMin, endMin, dateStr, timeDraft, setTimeDraft, commitTime,
  viewDate, showDate, shiftViewDate, applyMove, visitOps, partners, opColors,
}) {
  return (
    <div style={{ padding: '13px 15px', borderRadius: 16, background: `color-mix(in srgb, ${col} 26%, #FFFFFF)` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Avatar initials={o?.initials || initialsOf((appt.items || [])[0]?.operator_name)} size={50} color={col} ring />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-meta" style={{ fontSize: 10, color: 'var(--ink-2)', opacity: 0.7, marginBottom: 1 }}>{t('Operatrice', 'Stylist')}</div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, lineHeight: 1.05 }}>{o ? o.first_name : (appt.items || [])[0]?.operator_name}</div>
          {o?.role_title && <div className="t-sm" style={{ color: 'var(--ink-2)', opacity: 0.75 }}>{o.role_title}</div>}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div className="t-meta" style={{ fontSize: 10, color: 'var(--ink-2)', opacity: 0.7, marginBottom: 3 }}>{t('Inizio', 'Starts')}</div>
          {canMove ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
              <button className="dk-iconbtn" disabled={movingBusy} title={t(`Anticipa di ${stepMin} minuti`, `${stepMin} minutes earlier`)} aria-label={t('Anticipa', 'Earlier')}
                onClick={() => applyMove({ startMin: Math.max(0, startMin - stepMin) })}
                style={{ width: 28, height: 28, borderRadius: 8, background: 'rgba(255,255,255,0.65)', border: 'none' }}><Icon name="chevL" size={14} /></button>
              <input type="time" value={timeDraft ?? timeLabel(startMin)} step={stepMin * 60} disabled={movingBusy}
                onChange={(e) => setTimeDraft(e.target.value)} onBlur={commitTime}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                aria-label={t('Ora di inizio', 'Start time')}
                style={{ width: 92, border: '1px solid rgba(17,24,39,0.18)', borderRadius: 9, padding: '5px 7px', fontSize: 14, fontWeight: 700, fontFamily: 'var(--mono, monospace)', textAlign: 'center', outline: 'none', background: 'var(--surface)', color: 'var(--ink)' }} />
              <button className="dk-iconbtn" disabled={movingBusy} title={t(`Posticipa di ${stepMin} minuti`, `${stepMin} minutes later`)} aria-label={t('Posticipa', 'Later')}
                onClick={() => applyMove({ startMin: Math.min(LAST_START_MIN, startMin + stepMin) })}
                style={{ width: 28, height: 28, borderRadius: 8, background: 'rgba(255,255,255,0.65)', border: 'none' }}><Icon name="chevR" size={14} /></button>
            </div>
          ) : (
            <div className="tabnum" style={{ fontWeight: 700, fontSize: 15 }}>{timeLabel(startMin)}</div>
          )}
          <div className="t-sm" style={{ color: 'var(--ink-2)', opacity: 0.7, marginTop: 3 }}>{fmtDur(appt.total_duration_min, lang)} · {t('fino alle', 'until')} {timeLabel(endMin)}</div>
        </div>
      </div>
      {/* Il giorno: si sfoglia da qui e l'agenda di fianco segue, così la
          cliente al telefono sente «giovedì alle dieci ho posto» mentre
          lo si sta guardando davvero. Finché non si preme «Sposta»,
          l'appuntamento non si muove. */}
      {canMove && (
        <div style={{ marginTop: 11, paddingTop: 10, borderTop: '1px dashed rgba(17,24,39,0.16)', display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <div className="t-meta" style={{ fontSize: 10, color: 'var(--ink-2)', opacity: 0.7 }}>{t('Giorno', 'Day')}</div>
          <button className="dk-iconbtn" onClick={() => shiftViewDate(-1)} title={t('Giorno prima', 'Previous day')} aria-label={t('Giorno prima', 'Previous day')}
            style={{ width: 26, height: 26, borderRadius: 8, background: 'rgba(255,255,255,0.65)', border: 'none' }}><Icon name="chevL" size={13} /></button>
          <input type="date" value={viewDate} onChange={(e) => showDate(e.target.value)}
            aria-label={t('Giorno da guardare', 'Day to look at')}
            style={{ border: '1px solid rgba(17,24,39,0.18)', borderRadius: 9, padding: '4px 7px', fontSize: 12.5, fontFamily: 'var(--sans)', fontWeight: 600, outline: 'none', background: 'var(--surface)', color: 'var(--ink)', cursor: 'pointer' }} />
          <button className="dk-iconbtn" onClick={() => shiftViewDate(1)} title={t('Giorno dopo', 'Next day')} aria-label={t('Giorno dopo', 'Next day')}
            style={{ width: 26, height: 26, borderRadius: 8, background: 'rgba(255,255,255,0.65)', border: 'none' }}><Icon name="chevR" size={13} /></button>
          {viewDate !== dateStr ? (
            <button className="dk-btn dk-btn--clay" disabled={movingBusy} style={{ height: 30, fontSize: 12, padding: '0 11px' }}
              onClick={() => applyMove({ dateIso: viewDate })}
              title={t('Sposta l’appuntamento a questo giorno, alla stessa ora', 'Move the appointment to this day, at the same time')}>
              <Icon name="calendar" size={13} color="#fff" />{t(`Sposta a ${fmtDateIt(viewDate, { weekday: false })}`, `Move to ${fmtDateIt(viewDate, { weekday: false })}`)}
            </button>
          ) : (
            <span className="t-sm" style={{ color: 'var(--ink-2)', opacity: 0.7 }}>{t('sfoglia i giorni: l’agenda ti segue', 'browse the days: the agenda follows')}</span>
          )}
        </div>
      )}
      {/* passare la visita a un'altra persona: un tocco, senza uscire di qui */}
      {canMove && visitOps.length > 1 && (
        <div style={{ marginTop: 11, paddingTop: 10, borderTop: '1px dashed rgba(17,24,39,0.16)' }}>
          <div className="t-meta" style={{ fontSize: 10, color: 'var(--ink-2)', opacity: 0.7, marginBottom: 7 }}>{t('Passa a', 'Hand over to')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {visitOps.map((op) => {
              const on = op.id === appt.operator_id;
              return (
                <button key={op.id} type="button" disabled={movingBusy || on} onClick={() => applyMove({ operatorId: op.id })}
                  className={'dk-pill dk-pill--tint' + (on ? ' dk-pill--on' : '')}
                  style={{ '--pill-c': opColors[op.id] || 'var(--clay)', padding: '3px 10px 3px 4px', fontSize: 12, cursor: on ? 'default' : 'pointer' }}>
                  <Avatar initials={op.initials} size={20} color={opColors[op.id] || 'var(--clay)'} ring={on} />
                  <span>{op.first_name}</span>
                  {on && <Icon name="check" size={12} stroke={2.6} />}
                </button>
              );
            })}
          </div>
          {partners.length > 0 && (
            <div className="t-sm" style={{ color: 'var(--ink-2)', opacity: 0.8, marginTop: 7 }}>
              {t(`Cambia mano solo la parte di ${o?.first_name || ''}: il resto resta a ${partners.join(', ')}.`, `Only ${o?.first_name || ''}'s part changes hands: the rest stays with ${partners.join(', ')}.`)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
