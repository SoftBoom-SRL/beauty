// RescheduleFlow — «Riprogramma» dal pannello di dettaglio: gli orari liberi
// per QUESTA visita (contratto C1) in un giorno scelto, o un orario scritto a
// mano, e lo spostamento (POST /move). Uno slot libero preso nel frattempo
// ferma lo spostamento finché non si preme di nuovo «Sposta qui» (allora si
// forza); un orario a mano fuori dagli slot si forza subito, se serve.
// `busy`/`setBusy` sono del pannello, che resta aperto sotto.
import React, { useEffect, useRef, useState } from 'react';
import { toastApiError, Icon, timeLabel, minutesOfDay, fmtDateIt, todayStr, toDateStr } from '@youty/shared';
import DkPanel from '../../../ui/DkPanel.jsx';
import { aStartMin, isoAtMin, hmToMin } from '../lib.js';
import { apptVersion, slotReassignment } from './rules.js';
import { withForceRetry } from '../lib/retry.js';
import * as agendaApi from '../agendaApi.js';

/* ---- Riprogramma: pick a new slot via availability, then POST /move ---- */
export default function RescheduleFlow({ appt, t, lang, fireToast, busy, setBusy, onBack, onClose, onDone, onMutate }) {
  const [manual, setManual] = useState('');
  const [needForce, setNeedForce] = useState(false); // orario fuori dagli slot liberi o appena occupato
  const needForceRef = useRef(false);
  needForceRef.current = needForce;
  const apptDay = toDateStr(appt.start);   // giorno del salone, non quello UTC
  const [date, setDate] = useState(apptDay >= todayStr() ? apptDay : todayStr());
  const [slots, setSlots] = useState(null);
  const [selStart, setSelStart] = useState(null);
  const selRef = useRef(null);
  selRef.current = selStart;
  const [reloadKey, setReloadKey] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const items = (appt.items || []).map((it) => ({ service_id: it.service_id, operator_id: it.operator_id }));

  /* Orari liberi PER QUESTA VISITA (contratto C1): con exclude_appointment_id
   * il server costruisce il piano dalla visita stessa — righe in ordine,
   * durate e pose scritte, operatrici — e non la conta come occupata. Prima
   * si cercava col listino di oggi e con la visita in agenda: spostarla di
   * mezz'ora non era mai possibile e gli orari proposti a una visita allungata
   * finivano in un 409 (01-05, 02-24, 13-17). `items` resta per un server che
   * non conosce ancora il parametro. Si ricarica anche quando la visita cambia
   * (il pannello la segue) o dopo un 409. */
  const version = apptVersion(appt);
  const lastDay = useRef(null);
  useEffect(() => {
    let on = true;
    const sameDay = lastDay.current === date;
    lastDay.current = date;
    if (!sameDay) { setSlots(null); setSelStart(null); setNeedForce(false); }
    agendaApi.getAvailability({ date, items, location_id: appt.location_id, exclude_appointment_id: appt.id })
      .then((res) => {
        if (!on) return;
        setSlots(res);
        const cur = selRef.current;
        if (sameDay && cur && !needForceRef.current && !res.some((x) => x.start === cur)) {
          setSelStart(null);
          fireToast({ msg: t(`Le ${timeLabel(minutesOfDay(cur))} non sono più libere: scegli un altro orario`, `${timeLabel(minutesOfDay(cur))} is no longer free: pick another time`), icon: 'alert' });
        }
      })
      .catch((err) => { if (on) { setSlots([]); toastApiError(err, fireToast, t); } });
    return () => { on = false; };
  }, [date, version, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function move() {
    if (!selStart || busy) return;
    setBusy(true);
    const when = timeLabel(minutesOfDay(selStart));
    // La ricerca può proporre una collega per le righe di un'operatrice che
    // non si prenota più: lo spostamento la applica solo se la si manda.
    const sel = (slots || []).find((x) => x.start === selStart);
    const re = sel ? slotReassignment(appt.items, sel.assignment) : { pair: null, extra: 0 };
    const body = { start: selStart, ...(re.pair ? { operator_id: re.pair.to, from_operator_id: re.pair.from } : {}) };
    try {
      // Sempre prima senza forzare: un orario a mano fuori dalla griglia
      // degli slot ma libero restava segnato «forzato» per niente.
      const out = await withForceRetry((force) => agendaApi.moveAppointment(appt.id, { ...body, force }), {
        retry: () => {
          if (needForce) return true;
          // Era fra gli orari liberi: nel frattempo lo ha preso qualcun altro.
          // Si ricarica e si lascia decidere: un altro orario, o di nuovo
          // «Sposta qui» per forzare (prima l'avviso citava un «Sposta
          // comunque» che non c'era).
          if (alive.current) { setNeedForce(true); setReloadKey((k) => k + 1); }
          fireToast({ msg: t(`Le ${when} sono state appena occupate: scegli un altro orario, o premi di nuovo «Sposta qui» per spostarla comunque (resterà segnata come forzata)`, `${when} was just taken: pick another time, or press “Move here” again to move it anyway (it will be marked as forced)`), icon: 'alert' });
          return false;
        },
      });
      if (out.stopped) return;
      const { res, forced } = out;
      fireToast({
        msg: t('Appuntamento riprogrammato alle ' + when, 'Rescheduled to ' + when)
          + (forced ? t(' · forzato', ' · forced') : '')
          + (re.extra ? t(' · controlla chi fa i servizi: una sola operatrice non più disponibile si riassegna per volta', ' · check who performs the services: only one unavailable stylist is reassigned at a time') : ''),
        icon: forced || re.extra ? 'alert' : 'calendar',
      });
      onMutate?.(res);
      if (alive.current) onDone();
    } catch (err) {
      toastApiError(err, fireToast, t);
    } finally { setBusy(false); }   // `busy` è del pannello, che può essere ancora aperto
  }
  const applyManual = () => {
    if (!manual) return;
    const minutes = hmToMin(manual);
    const exact = (slots || []).find((s) => minutesOfDay(s.start) === minutes);
    setSelStart(exact ? exact.start : isoAtMin(date, minutes));
    setNeedForce(!exact);
  };
  const anyRecommended = (slots || []).some((s) => s.recommended) && (slots || []).some((s) => s.recommended === false);

  return (
    <DkPanel onClose={onClose} title={t('Riprogramma', 'Reschedule')} sub={`${appt.client?.full_name} · ${t('attuale', 'currently')} ${fmtDateIt(apptDay, { weekday: false })} ${timeLabel(aStartMin(appt))}`}
      foot={
        <React.Fragment>
          <button className="dk-btn dk-btn--ghost" onClick={onBack}>{t('Indietro', 'Back')}</button>
          <button className="dk-btn dk-btn--clay" disabled={!selStart || busy} onClick={move}>
            <Icon name="calendar" size={16} color="#fff" />{t('Sposta qui', 'Move here')}{selStart ? ' · ' + timeLabel(minutesOfDay(selStart)) : ''}
          </button>
        </React.Fragment>
      }>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, padding: '11px 14px', borderRadius: 12, border: '1px solid var(--hair)', background: 'var(--surface)' }}>
        <Icon name="calendar" size={17} color="var(--clay-ink)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-meta" style={{ fontSize: 9.5, marginBottom: 1 }}>{t('Nuova data', 'New date')}</div>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{fmtDateIt(date)}</div>
        </div>
        <input type="date" value={date} min={todayStr()} onChange={(e) => setDate(e.target.value || todayStr())} style={{ border: '1px solid var(--hair)', borderRadius: 8, padding: '6px 8px', fontSize: 12.5, fontFamily: 'var(--sans)', outline: 'none', cursor: 'pointer', color: 'var(--ink)' }} />
      </div>
      <div className="t-meta" style={{ marginBottom: 9 }}>{t('Orari disponibili', 'Available times')}</div>
      {slots === null ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {[...Array(12)].map((_, i) => <div key={i} className="skel" style={{ width: 56, height: 30, borderRadius: 8 }} />)}
        </div>
      ) : slots.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {slots.map((s) => {
            const sel = s.start === selStart;
            const meh = s.recommended === false;
            return (
              <button key={s.start} onClick={() => { setSelStart(s.start); setNeedForce(false); }} className="tabnum" title={meh ? t('Lascerebbe un buco troppo corto per un altro servizio', 'Would leave a gap too short for another service') : ''} style={{ padding: '5px 9px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1.5px solid ' + (sel ? 'var(--ink)' : 'var(--hair)'), background: sel ? 'var(--ink)' : 'var(--surface)', color: sel ? '#fff' : 'var(--ink)', opacity: meh && !sel ? 0.55 : 1 }}>
                {timeLabel(minutesOfDay(s.start))}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="t-sm" style={{ color: 'var(--danger)', fontWeight: 600 }}>{t('Nessuno slot libero in questa data', 'No free slot on this date')}</div>
      )}
      {anyRecommended && <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11.5, marginTop: 8 }}>{t('Gli orari attenuati lascerebbero buchi invendibili.', 'Dimmed times would leave unsellable gaps.')}</div>}
      {/* orario a mano: anche fuori turno o sopra un'altra prenotazione (forzato) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, border: '1px dashed var(--line-strong)', marginTop: 14, flexWrap: 'wrap' }}>
        <Icon name="clock" size={16} color="var(--muted)" />
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{t('Orario a mano', 'Type a time')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{t('Fuori turno o sovrapposto: si sposta forzando.', 'Off shift or overlapping: moved with override.')}</div>
        </div>
        <input type="time" value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyManual(); } }} style={{ border: '1px solid var(--hair)', borderRadius: 8, padding: '6px 8px', fontSize: 12.5, fontFamily: 'var(--mono, monospace)', fontWeight: 700, outline: 'none', width: 110 }} />
        <button className="dk-btn dk-btn--soft" disabled={!manual} style={{ height: 34, fontSize: 12.5 }} onClick={applyManual}>{t('Usa', 'Use')}</button>
      </div>
      {needForce && selStart && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px', borderRadius: 12, background: 'var(--warn-tint)', marginTop: 10 }}>
          <Icon name="alert" size={15} color="var(--warn)" />
          <span className="t-sm" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{t(`Le ${timeLabel(minutesOfDay(selStart))} non sono fra gli orari liberi: l’appuntamento verrà spostato comunque e segnato come forzato.`, `${timeLabel(minutesOfDay(selStart))} is not a free time: the appointment will be moved anyway and marked as forced.`)}</span>
        </div>
      )}
    </DkPanel>
  );
}
