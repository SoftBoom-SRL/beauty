// SlotMenu — il menu di uno spazio della griglia (clic su uno slot, o tasto
// destro su un blocco): esito dello slot, «Sposta qui» con un appuntamento
// aperto nel pannello, nuova prenotazione e pausa (con la sua durata).
// `slotMenu` = { opId, startMin, x, y, verdict?, ghostHit?, mode?, dur? }.
import React from 'react';
import { Icon, NumInput, fmtDateIt, isoAtMin, timeLabel, toDateStr } from '@youty/shared';
import { BREAK_DEFAULT_MIN, BREAK_PRESETS, aStartMin, firstName } from '../lib.js';

export default function SlotMenu({ slotMenu, setSlotMenu, operators, openAppt, date, t, onMoveHere, onNewAppt, onAddBreak }) {
  return (
    <React.Fragment>
      <div onClick={() => setSlotMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 95 }} />
      <div className="dk-card" style={{ position: 'fixed', boxSizing: 'border-box', top: Math.min(slotMenu.y, window.innerHeight - (slotMenu.mode === 'break' ? 300 : 130)), left: Math.min(slotMenu.x, window.innerWidth - 246), zIndex: 96, width: 234, padding: 6, boxShadow: 'var(--sh-pop)', overflow: 'hidden' }}>
        <div style={{ padding: '8px 10px 6px' }}>
          <div className="t-meta">{firstName((operators.find((o) => o.id === slotMenu.opId) || {}).first_name)} · {timeLabel(slotMenu.startMin)}</div>
          {/* Lo slot «non libero» resta prenotabile: qui si avvisa in ambra,
              non si vieta in rosso. */}
          {slotMenu.verdict && (() => {
            const free = slotMenu.verdict.ok && slotMenu.verdict.code !== 'soak';
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, fontSize: 12.5, fontWeight: 700, color: free ? 'var(--ok)' : 'var(--warn)' }}>
                <Icon name={free ? 'check' : 'alert'} size={13} stroke={2.6} color="currentColor" />
                <span>{slotMenu.verdict.label}</span>
              </div>
            );
          })()}
          {slotMenu.verdict?.detail && <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2, fontSize: 12 }}>{slotMenu.verdict.detail}</div>}
        </div>
        {slotMenu.mode === 'break' ? (
          <div style={{ padding: '4px 8px 8px' }}>
            <div className="t-sm" style={{ fontWeight: 700, color: 'var(--muted)', margin: '4px 2px 8px' }}>{t('Durata pausa', 'Break duration')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 8 }}>
              {BREAK_PRESETS.map((d) => {
                const on = (slotMenu.dur || BREAK_DEFAULT_MIN) === d;
                return (
                  <button key={d} onClick={() => setSlotMenu((m) => ({ ...m, dur: d }))} style={{ padding: '8px 0', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{d < 60 ? d + ' min' : (d / 60) + ' h'}</button>
                );
              })}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '0 2px' }}>
              <span className="t-sm" style={{ color: 'var(--muted)', flex: 1 }}>{t('Personalizzata', 'Custom')}</span>
              <NumInput integer min={5} value={slotMenu.dur || BREAK_DEFAULT_MIN} onChange={(dur) => setSlotMenu((m) => ({ ...m, dur }))} style={{ width: 64, textAlign: 'right', border: '1px solid var(--hair)', borderRadius: 8, padding: '6px 8px', fontSize: 13, fontWeight: 700, fontFamily: 'var(--mono, monospace)', outline: 'none' }} />
              <span className="t-sm" style={{ color: 'var(--muted-2)' }}>min</span>
            </div>
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 10, padding: '0 2px' }}>{timeLabel(slotMenu.startMin)}–{timeLabel(slotMenu.startMin + (slotMenu.dur || BREAK_DEFAULT_MIN))}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="dk-btn dk-btn--ghost" style={{ flex: 1, minWidth: 0, height: 36, padding: '0 6px', boxSizing: 'border-box' }} onClick={() => setSlotMenu((m) => ({ ...m, mode: null }))}>{t('Indietro', 'Back')}</button>
              <button className="dk-btn dk-btn--clay" style={{ flex: 1, minWidth: 0, height: 36, padding: '0 6px', boxSizing: 'border-box' }} onClick={() => onAddBreak(slotMenu.opId, slotMenu.startMin, slotMenu.dur || BREAK_DEFAULT_MIN)}><Icon name="check" size={15} color="#fff" />{t('Aggiungi', 'Add')}</button>
            </div>
          </div>
        ) : (
          <React.Fragment>
            {/* Col dettaglio aperto, il primo gesto è spostare QUELLA
                cliente: si sfogliano i giorni dal pannello e si clicca lo
                spazio giusto, senza passare da nessun'altra schermata. */}
            {openAppt && (
              <button className="dk-row" onClick={() => onMoveHere(openAppt, slotMenu)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, textAlign: 'left', border: 'none', background: 'transparent' }}>
                <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="calendar" size={15} color="var(--clay-ink)" /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t(`Sposta qui ${firstName(openAppt.client?.full_name)}`, `Move ${firstName(openAppt.client?.full_name)} here`)}</div>
                  <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{t(`da ${fmtDateIt(toDateStr(openAppt.start), { weekday: false })} ${timeLabel(aStartMin(openAppt))}`, `from ${fmtDateIt(toDateStr(openAppt.start), { weekday: false })} ${timeLabel(aStartMin(openAppt))}`)}</div>
                </div>
              </button>
            )}
            <button className="dk-row" onClick={() => { const m = slotMenu; setSlotMenu(null); onNewAppt({ operatorId: m.opId, start: isoAtMin(date, m.startMin), date }); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, textAlign: 'left', border: 'none', background: 'transparent' }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="plus" size={15} color="var(--clay-ink)" /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Nuovo appuntamento', 'New appointment')}</div>
                {/* Quando l'ora non è libera si può comunque insistere: il
                    pannello dell'orario, nel drawer, offre «Inserisci comunque».
                    Prometteva solo alternative, e chi voleva incastrare una
                    cliente sopra un'altra si fermava qui. */}
                <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{slotMenu.verdict && !slotMenu.verdict.ok ? t(`alle ${timeLabel(slotMenu.startMin)} anche se occupato, o scegli un'alternativa`, `at ${timeLabel(slotMenu.startMin)} even if busy, or pick an alternative`) : t(`alle ${timeLabel(slotMenu.startMin)}`, `at ${timeLabel(slotMenu.startMin)}`)}</div>
              </div>
            </button>
            <button className="dk-row" onClick={() => setSlotMenu((m) => ({ ...m, mode: 'break', dur: BREAK_DEFAULT_MIN }))} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, textAlign: 'left', border: 'none', background: 'transparent' }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--surface-2)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="clock" size={15} color="var(--muted)" /></div>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Aggiungi pausa', 'Add break')}</span>
            </button>
          </React.Fragment>
        )}
      </div>
    </React.Fragment>
  );
}
