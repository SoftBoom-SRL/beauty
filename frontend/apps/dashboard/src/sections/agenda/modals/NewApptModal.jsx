// NewApptModal — il drawer "Nuova prenotazione": UNICO punto d'ingresso per
// creare un appuntamento (topbar, clic su uno slot in agenda, lista d'attesa,
// slot liberato, scheda cliente). Pannello laterale senza scrim: l'agenda resta
// visibile e cliccabile — cliccando uno slot libero orario e operatrice entrano
// qui (ctx.agendaPick). Cliente con creazione rapida, servizi, operatrice per
// servizio, orario: se l'orario richiesto non è disponibile, spiega PERCHÉ e
// propone le alternative più vicine. Il pulsante finale dice cosa manca.
import { useEffect, useMemo, useRef, useState } from 'react';
import { toastApiError, addDays, nowMinutes, timeLabel, minutesOfDay, todayStr, toDateStr } from '@youty/shared';
import { useDash, useLive } from '../../../ctx.jsx';
import { useEscLayer } from '../../../ui/layers.js';
import { serviceColor } from '../../../ui/palette.js';
import { usePanelSlot } from '../../../ui/DkPanel.jsx';
import {
  firstName, isoAtMin, hmToMin, slotStep, isAddonRow, isAddonService, insertAddonRow, removeRowWithAddons, setRowOperator, bookingRows,
} from '../lib.js';
import ClientPicker from '../ClientPicker.jsx';
import { copyText, relativeDateLabel, requestStatus } from './rules.js';
import { withForceRetry } from '../lib/retry.js';
import * as agendaApi from '../agendaApi.js';
import { useGiftCards } from '../hooks/useGiftCards.js';
import { useBookingSlots } from '../hooks/useBookingSlots.js';
import StepLabel from './newappt/StepLabel.jsx';
import DateBar from './newappt/DateBar.jsx';
import ServiceStep from './newappt/ServiceStep.jsx';
import TimeStep from './newappt/TimeStep.jsx';
import ManualTime from './newappt/ManualTime.jsx';
import BookingFoot from './newappt/BookingFoot.jsx';
import BookingShell, { BOOKING_PANEL_W, ReadOnlyNote } from './newappt/BookingShell.jsx';
import NoteFlexible from './newappt/NoteFlexible.jsx';

const svcName = (s, lang) => (lang === 'en' && s?.name_en ? s.name_en : s?.name_it || '');

export default function NewApptModal({ prefill, onClose, onCreated }) {
  const { t, lang, services, serviceCategories, operators, fireToast, hasScope, settings, agendaPick, setAgendaPick, setTab, locationId } = useDash();
  const pf = prefill || {};
  const canWrite = hasScope('agenda');
  const step = slotStep(settings);

  /* ---- cliente ---- */
  const [client, setClient] = useState(pf.clientId ? { id: pf.clientId, full_name: pf.clientName || '…' } : null);
  useEffect(() => { if (pf.clientId) agendaApi.getClient(pf.clientId).then(setClient).catch(() => {}); }, [pf.clientId]);

  /* ---- data + richiesta (operatrice/orario cliccati in agenda) ---- */
  // toDateStr e non slice(0, 10): `pf.start` è un istante UTC, e per un
  // appuntamento serale i primi dieci caratteri sono il giorno prima.
  const [date, setDate] = useState(pf.date || (pf.start ? toDateStr(pf.start) : todayStr()));
  const [req, setReq] = useState(() => (
    pf.start || pf.operatorId
      ? { operatorId: pf.operatorId || null, startMin: pf.start ? minutesOfDay(pf.start) : null }
      : null
  ));
  const reqOp = req?.operatorId ? operators.find((o) => o.id === req.operatorId) : null;

  /* ---- regali: gift card «a trattamento» attive e pagate della cliente (useGiftCards) ---- */
  const giftFor = useGiftCards(client?.id);

  /* ---- orario manuale: lo staff può andare oltre le regole ----
   * Se l'orario digitato non è fra gli slot liberi (fuori turno, centro chiuso,
   * sovrapposizione) e il server lo rifiuta (409), la prenotazione viene
   * creata con force=true e resta marcata «forzata»: straordinario o "ci
   * incastriamo" sono decisioni del salone. `forceCreate` = l'orario scelto NON
   * è fra i liberi, quindi forzarlo è stato deciso. */
  const [manualTime, setManualTime] = useState('');
  const [forceCreate, setForceCreate] = useState(false);

  /* ---- servizi ----
   * Le righe stanno in fila come la catena che parte al server: ogni servizio
   * seguito dai suoi aggiuntivi (la nail art durante la manicure), che si
   * aggiungono col «+» sotto il servizio e non ne allungano la durata
   * (lib/addons.js). */
  const seq = useRef(1);
  const eligibleOps = (serviceId) => operators.filter((o) => (o.service_ids || []).includes(serviceId));
  const isEligible = (serviceId, opId) => !!opId && eligibleOps(serviceId).some((o) => o.id === opId);
  const svcOf = (id) => (services || []).find((s) => s.id === id);
  // «Rifai la visita» porta anche gli aggiuntivi: vanno dietro al loro servizio
  const [items, setItems] = useState(() => bookingRows(pf.serviceIds, (sid) => isAddonService(svcOf(sid)), (sid) => ({
    key: 'i' + seq.current++, service_id: sid, operator_id: isEligible(sid, pf.operatorId) ? pf.operatorId : null,
  })));
  const [svcQ, setSvcQ] = useState('');
  const [addonFor, setAddonFor] = useState(null);   // servizio con la scelta degli aggiuntivi aperta
  const activeServices = (services || []).filter((s) => s.active !== false && !isAddonService(s));
  const addonServices = (services || []).filter((s) => s.active !== false && isAddonService(s));
  // il colore del servizio: il suo, o quello della categoria (ui/palette.js)
  const svcColor = (s) => serviceColor(s, serviceCategories) || 'var(--clay)';
  const mainItems = items.filter((x) => !isAddonRow(x));
  const isSelected = (sid) => mainItems.some((x) => x.service_id === sid);
  const toggleService = (sid) => {
    const on = mainItems.find((x) => x.service_id === sid);
    // togliendo un servizio se ne vanno anche i suoi aggiuntivi
    if (on) setItems((l) => removeRowWithAddons(l, on.key));
    else setItems((l) => [...l, { key: 'i' + seq.current++, service_id: sid, operator_id: isEligible(sid, req?.operatorId) ? req.operatorId : null }]);
  };
  /* Un aggiuntivo sotto il servizio `parentKey`: a chi fa il servizio, se lo
   * sa fare; altrimenti «prima disponibile» (il server lo dà alla prima
   * abilitata, senza cercarla libera: non le prende tempo). */
  const addAddon = (parentKey, sid) => {
    const key = 'i' + seq.current++;
    setItems((l) => {
      const parent = l.find((x) => x.key === parentKey);
      const who = parent && isEligible(sid, parent.operator_id) ? parent.operator_id : null;
      return insertAddonRow(l, parentKey, { key, service_id: sid, operator_id: who });
    });
  };
  // gli aggiuntivi seguono chi fa il loro servizio, se lo sanno fare
  const setItemOp = (key, opId) => setItems((l) => setRowOperator(l, key, opId, isEligible));
  const removeItem = (key) => setItems((l) => removeRowWithAddons(l, key));
  const totalPrice = items.reduce((s, it) => s + Number(svcOf(it.service_id)?.price || 0), 0);
  // la durata è quella dei servizi: un aggiuntivo si fa durante il suo
  const totalDur = mainItems.reduce((s, it) => { const sv = svcOf(it.service_id); return s + (sv?.duration_min || 0) + (sv?.soak_min || 0); }, 0);

  /* ---- slot scelto in agenda mentre il drawer è aperto ---- */
  useEffect(() => {
    if (!agendaPick) return;
    setDate(agendaPick.date);
    const startMin = minutesOfDay(agendaPick.start);
    setReq({ operatorId: agendaPick.operatorId || null, startMin });
    setItems((l) => l.map((it) => (isEligible(it.service_id, agendaPick.operatorId) ? { ...it, operator_id: agendaPick.operatorId } : it)));
    setShowAll(false);
    choose(null, null, false);
  }, [agendaPick?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setAgendaPick(null), [setAgendaPick]);

  /* ---- Esc chiude, se il drawer è in primo piano ----
   * Dalla pila unica di layers.js, come ogni altro pannello: l'ascoltatore
   * proprio su window scattava anche con la tendina della ricerca cliente
   * aperta, e chiudeva tutto il drawer (13-10). */
  useEscLayer(true, () => onClose?.());

  /* Area di lavoro ristretta finché il drawer è aperto, e sopra i pannelli
   * aperti prima (13-19): in modalità scelta orario copriva le ultime colonne. */
  const zIndex = usePanelSlot(BOOKING_PANEL_W);

  /* Una risposta che arriva quando al posto del drawer c'è già un altro
   * pannello non deve chiudere quello (onClose è globale, 13-20). */
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  /* ---- le altre postazioni ----
   * Giornata e orari liberi si ricaricano quando l'agenda cambia altrove:
   * tenendo selezionate le 10:00 di Anna per due minuti al telefono, uno slot
   * preso intanto da un'altra postazione restava «libero» (13-11). */
  const [liveTick, setLiveTick] = useState(0);
  useLive(['appointment.', 'pause.', 'operator.', 'settings.', 'service.'], () => setLiveTick((n) => n + 1));

  /* ---- giornata (per spiegare perché uno slot non è disponibile) ---- */
  const [dayRows, setDayRows] = useState(null);
  useEffect(() => {
    let alive = true;
    agendaApi.getDay(date, locationId).then((rows) => { if (alive) setDayRows(rows); }).catch(() => {});
    return () => { alive = false; };
  }, [date, locationId, liveTick]);

  /* ---- disponibilità e orario scelto (useBookingSlots) ---- */
  const { slots, selStart, showAll, setShowAll, choose, quietDrop } = useBookingSlots({
    items, date, locationId, req, liveTick, initialShowAll: !(pf.start), setForceCreate, t, fireToast,
  });

  const isToday = date === todayStr();
  const nowMin = nowMinutes();
  const selSlot = (slots || []).find((s) => s.start === selStart) || null;
  const assignedName = (serviceId) => {
    const a = selSlot?.assignment?.find((x) => x.service_id === serviceId);
    const o = a && operators.find((op) => op.id === a.operator_id);
    return o ? o.first_name : null;
  };

  /* stato dell'orario richiesto: disponibile / non disponibile + motivo + alternative (requestStatus) */
  // sui soli servizi: chi non fa la nail art non rende «non libero» l'orario,
  // l'aggiuntivo va a un'altra abilitata
  const reqStatus = useMemo(() => requestStatus({
    req, reqOp, items: mainItems, slots, dayRows, totalDur, step, nowMin: isToday ? nowMin : null, clientId: client?.id ?? null,
    t, lang, serviceName: (serviceId) => svcName(svcOf(serviceId), lang), isEligible,
  }), [req, reqOp, items, slots, dayRows, totalDur, isToday, nowMin, lang, step, client]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- nota / flessibile / invio ---- */
  const [note, setNote] = useState('');
  const [flexible, setFlexible] = useState(false);
  const [saving, setSaving] = useState(false);
  const clientRef = useRef(null), svcRef = useRef(null), timeRef = useRef(null);

  const missing = [
    !client && { key: 'client', label: t('cliente', 'client'), ref: clientRef },
    !items.length && { key: 'svc', label: t('servizio', 'service'), ref: svcRef },
    items.length > 0 && !selStart && { key: 'time', label: t('orario', 'time'), ref: timeRef },
  ].filter(Boolean);
  const ready = canWrite && !missing.length && !saving;

  const dateLabel = relativeDateLabel(date, lang, t);
  const shiftDate = (n) => { const iso = toDateStr(addDays(date, n)); if (iso >= todayStr()) { setDate(iso); choose(null, null, false); } };

  /* «Copia link caparra» dall'avviso: si conferma solo a copia riuscita, e
   * l'avviso nuovo parte dopo che quello cliccato si è chiuso (13-25). */
  const copyLink = (link) => {
    copyText(link).then((ok) => fireToast(ok
      ? { msg: t('Link copiato', 'Link copied'), icon: 'check' }
      : { msg: t('Copia non riuscita: il link è nel dettaglio dell’appuntamento («Copia link»)', 'Copy failed: the link is in the appointment detail (“Copy link”)'), icon: 'alert' }));
  };

  async function create() {
    if (!canWrite) { fireToast({ msg: t('Non hai i permessi per creare prenotazioni', 'You lack permission to create bookings'), icon: 'lock' }); return; }
    if (missing.length) {
      fireToast({ msg: t('Manca: ', 'Missing: ') + missing.map((m) => m.label).join(' · '), icon: 'alert' });
      missing[0].ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (saving) return;
    setSaving(true);
    // Forzare è deciso solo per un orario che non era fra i liberi (scritto a
    // mano, cliccato in agenda sopra un altro impegno o fuori turno).
    const deliberate = forceCreate;
    const when = timeLabel(minutesOfDay(selStart));
    const body = {
      client_id: client.id,
      items: items.map((i) => ({ service_id: i.service_id, operator_id: i.operator_id })),
      start: selStart, note, flexible, location_id: locationId,
    };
    try {
      // Sempre prima senza forzare (13-12): un orario a mano libero ma fuori
      // griglia restava segnato «forzato», e con «Prima disponibile» il
      // server forzato prendeva la prima operatrice in elenco anche occupata.
      const out = await withForceRetry((force) => agendaApi.createAppointment({ ...body, force }), {
        retry: () => {
          // Chi prenota al banco ha già deciso: si scrive comunque, invece di
          // aprire un riquadro «crea comunque» che costava un giro in più nel
          // momento peggiore della giornata.
          if (deliberate) return true;
          // L'orario era libero: nel frattempo lo ha preso un'altra
          // prenotazione. Si ricaricano giornata e orari e si lascia scegliere,
          // invece di scrivere sopra l'altra cliente senza che nessuno l'abbia
          // deciso (13-11).
          if (alive.current) { quietDrop.current = true; setLiveTick((n) => n + 1); }
          fireToast({ msg: t(`Le ${when} sono appena state occupate: scegli un altro orario, o scrivilo in «Orario a mano» per inserirla comunque`, `${when} was just taken: pick another time, or type it under “Type a time” to book it anyway`), icon: 'alert' });
          return false;
        },
      });
      if (out.stopped) return;
      const { res } = out;
      // La prenotazione è fatta: il drawer si chiude e basta. Prima restava una
      // schermata di riepilogo con «Chiudi», un clic in più su un'azione già
      // conclusa e visibile in agenda.
      const link = res?.deposit_status === 'required' ? res.deposit_payment_link : null;
      fireToast({
        msg: t(`${timeLabel(minutesOfDay(res.start))} · appuntamento creato per ${firstName(client.full_name)}`, `${timeLabel(minutesOfDay(res.start))} · appointment created for ${firstName(client.full_name)}`)
          + (res?.deposit_status === 'required' ? t(' · caparra da versare', ' · deposit due') : ''),
        icon: 'check',
        // unica cosa che si perdeva chiudendo subito: il link della caparra
        undo: link ? t('Copia link caparra', 'Copy deposit link') : undefined,
        undoFn: link ? () => copyLink(link) : undefined,
      });
      onCreated?.(res);
      if (alive.current) onClose?.();
    } catch (err) {
      toastApiError(err, fireToast, t);
    } finally { if (alive.current) setSaving(false); }
  }

  /* orario digitato a mano → selezionato; se non è fra gli slot liberi serve forzare */
  const applyManualTime = () => {
    if (!manualTime) return;
    const minutes = hmToMin(manualTime);
    const iso = isoAtMin(date, minutes);
    const exact = (slots || []).find((s) => minutesOfDay(s.start) === minutes);
    choose(exact ? exact.start : iso, 'manual', !exact);
    setShowAll(false);
   
  };
  const pickSlot = (start) => { choose(start, 'slot', false); setShowAll(false); };
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 13.5, padding: '9px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)', boxSizing: 'border-box' };

  /* ---- chrome del drawer: lo stesso della prenotazione di gruppo (BookingShell) ---- */
  const shell = ({ title, sub, foot, children }) => (
    <BookingShell title={title} sub={sub} foot={foot} onClose={onClose} zIndex={zIndex} t={t}>{children}</BookingShell>
  );

  /* ---- sola lettura ---- */
  if (!canWrite) {
    return shell({
      title: t('Nuova prenotazione', 'New booking'),
      foot: <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Chiudi', 'Close')}</button></div>,
      children: <ReadOnlyNote t={t} />,
    });
  }

  const filteredServices = activeServices.filter((s) => !svcQ || svcName(s, lang).toLowerCase().includes(svcQ.toLowerCase()));

  const foot = (
    <BookingFoot
      client={client} items={items} totalDur={totalDur} totalPrice={totalPrice} selStart={selStart} dateLabel={dateLabel}
      clientRef={clientRef} svcRef={svcRef} timeRef={timeRef} missing={missing} ready={ready} saving={saving} create={create}
      onClose={onClose} t={t} lang={lang}
    />
  );

  return shell({
    title: t('Nuova prenotazione', 'New booking'),
    sub: t('Clicca uno slot libero in agenda per riempire orario e operatrice', 'Click a free slot in the agenda to fill time and stylist'),
    foot,
    children: (
      <div>
        {/* ── contesto: data + orario/operatrice richiesti ── */}
        <DateBar
          date={date} dateLabel={dateLabel} shiftDate={shiftDate} setDate={setDate} choose={choose}
          req={req} reqOp={reqOp} setReq={setReq} setShowAll={setShowAll} setItems={setItems} t={t}
        />

        {/* ── 1. cliente ── */}
        <div ref={clientRef} style={{ marginBottom: 18 }}>
          <StepLabel n={1} done={!!client} t={t}>{t('Cliente', 'Client')}</StepLabel>
          <ClientPicker value={client} onChange={setClient} autoFocus={!client} />
        </div>

        {/* ── 2. servizi ── */}
        <ServiceStep
          stepRef={svcRef} items={items} activeServices={activeServices} filteredServices={filteredServices} svcQ={svcQ} setSvcQ={setSvcQ}
          inputCss={inputCss} isSelected={isSelected} toggleService={toggleService} eligibleOps={eligibleOps} svcColor={svcColor}
          svcOf={svcOf} svcName={svcName} giftFor={giftFor} selSlot={selSlot} assignedName={assignedName} removeItem={removeItem}
          setItemOp={setItemOp} onClose={onClose} setTab={setTab} t={t} lang={lang}
          addonServices={addonServices} addAddon={addAddon} addonFor={addonFor} setAddonFor={setAddonFor}
        />

        {/* ── 3. orario ── */}
        {items.length > 0 && (
          <TimeStep
            stepRef={timeRef} slots={slots} selStart={selStart} pickSlot={pickSlot} reqStatus={reqStatus} req={req} reqOp={reqOp}
            setReq={setReq} totalDur={totalDur} showAll={showAll} setShowAll={setShowAll} dateLabel={dateLabel} items={items}
            setItems={setItems} eligibleOps={eligibleOps} shiftDate={shiftDate} operators={operators} t={t}
          />
        )}

        {/* ── orario manuale (oltre le regole) ── */}
        {items.length > 0 && (
          <ManualTime manualTime={manualTime} setManualTime={setManualTime} step={step} applyManualTime={applyManualTime} inputCss={inputCss} t={t} />
        )}

        {/* ── nota + flessibile (anche in ogni cliente del gruppo) ── */}
        <NoteFlexible note={note} setNote={setNote} flexible={flexible} setFlexible={setFlexible} inputCss={inputCss} t={t} />
      </div>
    ),
  });
}
