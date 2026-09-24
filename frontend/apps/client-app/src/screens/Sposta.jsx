// Sposta.jsx — reschedule an upcoming appointment: day strip + availability
// with the SAME service items AND the same operators (the move keeps them), the
// appointment itself excluded from the busy map, then
// POST /api/agenda/client/appointments/{id}/move.
// Il 400 del preavviso minimo (ore configurabili per salone) si mostra
// inline (banner) + toast, con il testo che arriva dal server.
import React from 'react';
import { ApiError, Icon, fmtDur, fmtTime, minutesOfDay, timeLabel, toDateStr, toastApiError } from '@youty/shared';
import { useApp } from '../ctx.jsx';
import { getAvailability, moveAppointment } from '../api/client.js';
import { ClientSubHead } from '../components/ClientSubHead.jsx';
import { DayStrip } from '../components/DayStrip.jsx';
import { Meta } from '../components/Meta.jsx';
import { MissingAppt } from '../components/MissingAppt.jsx';
import { SlotPicker } from '../components/SlotPicker.jsx';
import { StickyCta } from '../components/StickyCta.jsx';
import { SuccessScreen } from '../components/SuccessScreen.jsx';
import { toastSlotTaken } from '../lib/errors.js';
import { useTodayKey } from '../hooks/useTodayKey.js';
import { apptMinutes, apptServiceNames } from '../lib/appointments.js';
import { nextDays, fmtDayMed } from '../lib/dates.js';

export default function Sposta() {
  const { t, lang, brand, setView, viewParams, fireToast } = useApp();
  const appt = viewParams?.appt || null;
  const [dayIdx, setDayIdx] = React.useState(0);
  const [slot, setSlot] = React.useState(null);
  const [slots, setSlots] = React.useState(null);
  const [moving, setMoving] = React.useState(false);
  const [policyErr, setPolicyErr] = React.useState(null);
  const [done, setDone] = React.useState(null); // new start ISO on success
  const todayKey = useTodayKey();
  // ricalcolata quando cambia il giorno: vedi useTodayKey
  // eslint-disable-next-line react-hooks/exhaustive-deps -- todayKey è il motivo del ricalcolo
  const days = React.useMemo(() => nextDays(14), [todayKey]);

  // Stesse operatrici dell'appuntamento: lo spostamento le conserva, quindi la
  // disponibilità deve cercarle esplicitamente (uno slot libero per un'altra
  // operatrice verrebbe poi rifiutato con 409).
  const items = React.useMemo(
    () => (appt?.services || []).map((s) => ({ service_id: s.service_id, operator_id: s.operator_id ?? appt?.operator?.id ?? null })),
    [appt],
  );
  const availabilityParams = React.useCallback(
    (d) => ({ date: toDateStr(d), items, exclude_appointment_id: appt?.id }),
    [items, appt],
  );

  React.useEffect(() => {
    if (!appt || done) return;
    let alive = true;
    setSlots(null);
    setSlot(null);
    getAvailability(availabilityParams(days[dayIdx]))
      .then((list) => { if (alive) setSlots(list); })
      .catch((err) => {
        if (!alive) return;
        setSlots([]);
        // 400 = questa visita dall'app non si sposta (per esempio due
        // operatrici non più prenotabili: «Per spostare questa visita
        // contatta il salone»). Si dice nel riquadro in alto, come il rifiuto
        // del preavviso: sotto un toast restava «Nessun orario libero questo
        // giorno: prova un altro giorno», e la cliente provava giorno per giorno.
        if (err instanceof ApiError && err.status === 400) setPolicyErr(err.message);
        else toastApiError(err, fireToast, t);
      });
    return () => { alive = false; };
    // `days` fra le dipendenze: a mezzanotte la striscia scivola di un giorno
    // ma senza ricaricare restavano a video gli orari del giorno prima, con lo
    // stesso chip selezionato. Lo spostamento sarebbe finito nel giorno
    // sbagliato (o rifiutato con un 409 incomprensibile).
  }, [appt, dayIdx, done, days]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!appt) {
    return (
      <MissingAppt t={t} onBookings={() => setView('prenotazioni')}
        text={t('Seleziona prima l’appuntamento da spostare.', 'First pick the appointment to reschedule.')} />
    );
  }

  /* success state */
  if (done) {
    return (
      <SuccessScreen brand={brand} title={t('Spostato!', 'Rescheduled!')}
        text={t(`Ci vediamo ${fmtDayMed(done, lang)} alle ${timeLabel(minutesOfDay(done))}. Ti abbiamo inviato la conferma su WhatsApp 💫`,
          `See you ${fmtDayMed(done, lang)} at ${timeLabel(minutesOfDay(done))}. We've sent your confirmation on WhatsApp 💫`)}>
        <button className="btn btn--brand press" style={{ marginTop: 26 }} onClick={() => setView('home')}>{t('Torna alla home', 'Back to home')}</button>
      </SuccessScreen>
    );
  }

  const confirm = async () => {
    if (!slot || moving) return;
    setMoving(true);
    setPolicyErr(null);
    try {
      await moveAppointment(appt.id, slot.start);
      setDone(slot.start);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setPolicyErr(err.message); // preavviso minimo — si mostra com'è, chiaro
        fireToast({ msg: err.message, icon: 'alert' });
      } else if (err instanceof ApiError && err.status === 409) {
        toastSlotTaken(fireToast, t);
        setSlot(null);
        setSlots(null);
        getAvailability(availabilityParams(days[dayIdx]))
          .then(setSlots).catch(() => setSlots([]));
      } else {
        toastApiError(err, fireToast, t);
      }
    } finally {
      setMoving(false);
    }
  };

  return (
    <div style={{ paddingBottom: 30, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <ClientSubHead brand={brand} title={t('Sposta appuntamento', 'Reschedule')} onBack={() => setView('home')} />
      <div style={{ padding: '8px 22px' }}>
        {/* current appointment recap */}
        <div style={{ padding: '12px 14px', borderRadius: 'var(--r-md)', background: 'var(--brand-tint)', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--brand-ink)' }}>{apptServiceNames(appt)}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 6 }}>
            <Meta icon="calendar" text={fmtDayMed(appt.start, lang)} />
            <Meta icon="clock" text={fmtTime(appt.start) + ' · ' + fmtDur(apptMinutes(appt))} />
          </div>
        </div>

        {policyErr && (
          <div style={{ display: 'flex', gap: 12, padding: 15, background: 'var(--danger-tint)', borderRadius: 'var(--r-md)', marginBottom: 16 }}>
            <Icon name="alert" size={20} color="var(--danger)" />
            <div style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--ink-2)', flex: 1 }}>{policyErr}</div>
          </div>
        )}

        <div className="t-body" style={{ color: 'var(--muted)', marginBottom: 16 }}>
          {t('Scegli un nuovo orario. Mostriamo solo gli slot davvero disponibili.', 'Pick a new time. We only show slots that are actually free.')}
        </div>

        {/* day strip */}
        <DayStrip days={days} dayIdx={dayIdx} onPick={setDayIdx} lang={lang} />

        <SlotPicker slots={slots} slot={slot} onPick={setSlot} t={t} empty={policyErr ? null : (
          <div style={{ padding: '28px 16px', borderRadius: 'var(--r-md)', border: '1px dashed var(--hair)', textAlign: 'center' }}>
            <Icon name="clock" size={26} color="var(--muted-2)" />
            <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 8 }}>
              {t('Nessun orario libero questo giorno: prova un altro giorno.', 'No free time this day: try another day.')}
            </div>
          </div>
        )} />
      </div>
      <div style={{ flex: 1 }} />
      <StickyCta>
        <button className="btn btn--brand btn--block press" disabled={!slot || moving} style={{ opacity: !slot || moving ? 0.4 : 1 }} onClick={confirm}>
          {moving ? t('Spostamento…', 'Rescheduling…') : t('Conferma nuovo orario', 'Confirm new time')}
        </button>
      </StickyCta>
    </div>
  );
}
