// NewApptModal — il drawer "Nuova prenotazione": UNICO punto d'ingresso per
// creare un appuntamento (topbar, clic su uno slot in agenda, lista d'attesa,
// slot liberato, scheda cliente). Pannello laterale senza scrim: l'agenda resta
// visibile e cliccabile — cliccando uno slot libero orario e operatrice entrano
// qui (ctx.agendaPick). Cliente con creazione rapida, servizi, operatrice per
// servizio, orario: se l'orario richiesto non è disponibile, spiega PERCHÉ e
// propone le alternative più vicine. Il pulsante finale dice cosa manca.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, Avatar, Icon, Toggle, fmtEur, fmtDur, nowMinutes, timeLabel, minutesOfDay, todayStr, toDateStr, parseISO } from '@youty/shared';
import { useDash } from '../../../ctx.jsx';
import { useEscLayer } from '../../../ui/layers.js';
import { usePanelSlot } from '../../../ui/DkPanel.jsx';
import { toastErr, fmtMoney, explainSlot, firstName, isoAtMin, hmToMin } from '../lib.js';
import ClientPicker from '../ClientPicker.jsx';

const svcName = (s, lang) => (lang === 'en' && s?.name_en ? s.name_en : s?.name_it || '');

export default function NewApptModal({ prefill, onClose, onCreated }) {
  const { t, lang, services, serviceCategories, operators, fireToast, hasScope, settings, agendaPick, setAgendaPick, setTab, locationId } = useDash();
  const pf = prefill || {};
  const canWrite = hasScope('agenda');
  const step = settings?.slot_interval_min || 15;

  /* ---- cliente ---- */
  const [client, setClient] = useState(pf.clientId ? { id: pf.clientId, full_name: pf.clientName || '…' } : null);
  useEffect(() => { if (pf.clientId) api.get(`/api/clients/${pf.clientId}`).then(setClient).catch(() => {}); }, [pf.clientId]);

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

  /* ---- regali: gift card «a trattamento» attive e pagate della cliente ----
   * Compaiono accanto ai servizi coperti, così chi prenota vede subito che il
   * trattamento è già pagato da qualcuno (e il checkout lo userà). */
  const [gifts, setGifts] = useState([]);
  useEffect(() => {
    if (!client?.id) { setGifts([]); return undefined; }
    let alive = true;
    api.get('/api/marketing/gift-cards', { params: { client_id: client.id, status: 'active', payment_status: 'paid' } })
      .then((r) => { if (alive) setGifts((r.items || []).filter((g) => g.gift_service_id && (g.recipient_client_id === client.id || (!g.recipient_client_id && g.buyer_client_id === client.id)))); })
      .catch(() => { if (alive) setGifts([]); });
    return () => { alive = false; };
  }, [client?.id]);
  const giftFor = (serviceId) => gifts.find((g) => g.gift_service_id === serviceId) || null;

  /* ---- orario manuale: lo staff può andare oltre le regole ----
   * Se l'orario digitato non è fra gli slot liberi (fuori turno, centro chiuso,
   * sovrapposizione) la prenotazione viene creata con force=true e resta
   * marcata «forzata»: straordinario o "ci incastriamo" sono decisioni del salone. */
  const [manualTime, setManualTime] = useState('');
  const [forceCreate, setForceCreate] = useState(false);

  /* ---- servizi ---- */
  const seq = useRef(1);
  const eligibleOps = (serviceId) => operators.filter((o) => (o.service_ids || []).includes(serviceId));
  const isEligible = (serviceId, opId) => !!opId && eligibleOps(serviceId).some((o) => o.id === opId);
  const [items, setItems] = useState(() => (pf.serviceIds || []).map((sid) => ({
    key: 'i' + seq.current++, service_id: sid, operator_id: isEligible(sid, pf.operatorId) ? pf.operatorId : null,
  })));
  const [svcQ, setSvcQ] = useState('');
  const activeServices = (services || []).filter((s) => s.active !== false);
  const svcOf = (id) => (services || []).find((s) => s.id === id);
  const catColor = (catId) => (serviceCategories || []).find((c) => c.id === catId)?.color || 'var(--clay)';
  const isSelected = (sid) => items.some((x) => x.service_id === sid);
  const toggleService = (sid) => {
    if (isSelected(sid)) setItems((l) => l.filter((x) => x.service_id !== sid));
    else setItems((l) => [...l, { key: 'i' + seq.current++, service_id: sid, operator_id: isEligible(sid, req?.operatorId) ? req.operatorId : null }]);
  };
  const setItemOp = (key, opId) => setItems((l) => l.map((x) => (x.key === key ? { ...x, operator_id: opId } : x)));
  const removeItem = (key) => setItems((l) => l.filter((x) => x.key !== key));
  const totalPrice = items.reduce((s, it) => s + Number(svcOf(it.service_id)?.price || 0), 0);
  const totalDur = items.reduce((s, it) => { const sv = svcOf(it.service_id); return s + (sv?.duration_min || 0) + (sv?.soak_min || 0); }, 0);

  /* ---- slot scelto in agenda mentre il drawer è aperto ---- */
  useEffect(() => {
    if (!agendaPick) return;
    setDate(agendaPick.date);
    const startMin = minutesOfDay(agendaPick.start);
    setReq({ operatorId: agendaPick.operatorId || null, startMin });
    setItems((l) => l.map((it) => (isEligible(it.service_id, agendaPick.operatorId) ? { ...it, operator_id: agendaPick.operatorId } : it)));
    setShowAll(false);
    setSelStart(null);
  }, [agendaPick?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setAgendaPick(null), [setAgendaPick]);

  /* ---- Esc chiude, se il drawer è in primo piano ----
   * Dalla pila unica di layers.js, come ogni altro pannello: l'ascoltatore
   * proprio su window scattava anche con la tendina della ricerca cliente
   * aperta, e chiudeva tutto il drawer (13-10). */
  useEscLayer(true, () => onClose?.());

  /* Area di lavoro ristretta finché il drawer è aperto, e sopra i pannelli
   * aperti prima (13-19): in modalità scelta orario copriva le ultime colonne. */
  const zIndex = usePanelSlot(500);

  /* Una risposta che arriva quando al posto del drawer c'è già un altro
   * pannello non deve chiudere quello (onClose è globale, 13-20). */
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  /* ---- giornata (per spiegare perché uno slot non è disponibile) ---- */
  const [dayRows, setDayRows] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/api/agenda/day', { params: { date, location_id: locationId } }).then((rows) => { if (alive) setDayRows(rows); }).catch(() => {});
    return () => { alive = false; };
  }, [date, locationId]);

  /* ---- disponibilità ---- */
  const [slots, setSlots] = useState([]);         // null = caricamento
  const [selStart, setSelStart] = useState(null); // ISO dello slot scelto
  const [showAll, setShowAll] = useState(!(pf.start));
  const itemsKey = JSON.stringify(items.map((i) => [i.service_id, i.operator_id]));
  useEffect(() => {
    if (!items.length || !date) { setSlots([]); setSelStart(null); return; }
    let alive = true;
    setSlots(null);
    api.get('/api/agenda/availability', { params: { date, location_id: locationId, items: items.map((i) => ({ service_id: i.service_id, operator_id: i.operator_id })) } })
      .then((res) => {
        if (!alive) return;
        setSlots(res);
        setSelStart((prev) => {
          if (prev && res.some((s) => s.start === prev)) return prev;
          if (req?.startMin != null) {
            const exact = res.find((s) => minutesOfDay(s.start) === req.startMin);
            if (exact) { setForceCreate(false); return exact.start; }
            // Fuori turno o sopra un'altra cliente: si prende lo stesso. Prima
            // restava tutto vuoto e bisognava scovare «Inserisci comunque» per
            // riscrivere l'ora che si era appena cliccata in agenda.
            setForceCreate(true);
            return isoAtMin(date, req.startMin);
          }
          return null;
        });
      })
      .catch((err) => { if (alive) { setSlots([]); toastErr(err, t, fireToast); } });
    return () => { alive = false; };
  }, [date, itemsKey, req?.startMin]); // eslint-disable-line react-hooks/exhaustive-deps

  const isToday = date === todayStr();
  const nowMin = nowMinutes();
  const selSlot = (slots || []).find((s) => s.start === selStart) || null;
  const assignedName = (serviceId) => {
    const a = selSlot?.assignment?.find((x) => x.service_id === serviceId);
    const o = a && operators.find((op) => op.id === a.operator_id);
    return o ? o.first_name : null;
  };

  /* stato dell'orario richiesto: disponibile / non disponibile + motivo + alternative */
  const reqStatus = useMemo(() => {
    if (!req || req.startMin == null || !items.length) return null;
    if (slots === null) return { loading: true };
    const exact = (slots || []).find((s) => minutesOfDay(s.start) === req.startMin);
    if (exact) return { ok: true, slot: exact };
    let label = '', detail = '';
    const notEligible = reqOp ? items.filter((it) => !isEligible(it.service_id, reqOp.id)) : [];
    if (reqOp && notEligible.length) {
      label = t(`${reqOp.first_name} non esegue ${svcName(svcOf(notEligible[0].service_id), lang)}`, `${reqOp.first_name} doesn't perform ${svcName(svcOf(notEligible[0].service_id), lang)}`);
      detail = t('Abilita il servizio in Staff oppure scegli un’altra operatrice', 'Enable the service in Staff or pick another stylist');
    } else if (reqOp && dayRows) {
      const row = dayRows.find((r) => r.operator.id === reqOp.id);
      const v = row ? explainSlot(row, req.startMin, totalDur || step, { nowMin: isToday ? nowMin : null, sameClientId: client?.id ?? null, t, rows: dayRows }) : null;
      if (v && !v.ok) { label = `${reqOp.first_name}: ${v.label}`; detail = v.detail; }
      else label = t(`${reqOp.first_name} non è libera per tutta la durata (${fmtDur(totalDur, lang)})`, `${reqOp.first_name} isn't free for the whole duration (${fmtDur(totalDur, lang)})`);
    } else if (!reqOp) {
      label = t(`Nessuna operatrice libera alle ${timeLabel(req.startMin)}`, `No stylist free at ${timeLabel(req.startMin)}`);
    } else {
      label = t(`${reqOp.first_name} non è disponibile alle ${timeLabel(req.startMin)}`, `${reqOp.first_name} isn't available at ${timeLabel(req.startMin)}`);
    }
    const alternatives = [...(slots || [])]
      .sort((a, b) => Math.abs(minutesOfDay(a.start) - req.startMin) - Math.abs(minutesOfDay(b.start) - req.startMin))
      .slice(0, 4)
      .sort((a, b) => minutesOfDay(a.start) - minutesOfDay(b.start));
    return { ok: false, label, detail, alternatives };
  }, [req, reqOp, items, slots, dayRows, totalDur, isToday, nowMin, lang, step, client]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const dateLabel = (() => {
    const d = new Date(date + 'T00:00');
    const today = new Date(todayStr() + 'T00:00');
    const diff = Math.round((d - today) / 86400000);
    const base = d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
    if (diff === 0) return t('Oggi', 'Today') + ' · ' + base;
    if (diff === 1) return t('Domani', 'Tomorrow') + ' · ' + base;
    return base;
  })();
  const shiftDate = (n) => { const d = parseISO(date); d.setDate(d.getDate() + n); const iso = toDateStr(d); if (iso >= todayStr()) { setDate(iso); setSelStart(null); } };

  async function create(force) {
    if (!canWrite) { fireToast({ msg: t('Non hai i permessi per creare prenotazioni', 'You lack permission to create bookings'), icon: 'lock' }); return; }
    if (missing.length) {
      fireToast({ msg: t('Manca: ', 'Missing: ') + missing.map((m) => m.label).join(' · '), icon: 'alert' });
      missing[0].ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (saving) return;
    setSaving(true);
   
    const forced = forceCreate || force === true;
    try {
      const res = await api.post('/api/agenda/appointments', {
        client_id: client.id,
        items: items.map((i) => ({ service_id: i.service_id, operator_id: i.operator_id })),
        start: selStart, note, flexible, location_id: locationId, force: forced,
      });
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
        undoFn: link ? () => { navigator.clipboard?.writeText(link); fireToast({ msg: t('Link copiato', 'Link copied'), icon: 'check' }); } : undefined,
      });
      onCreated?.(res);
      if (alive.current) onClose?.();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !forced) {
        // Lo slot non è (più) libero: chi prenota al banco ha già deciso, quindi
        // si scrive comunque invece di aprire un riquadro «crea comunque» che
        // costava un giro in più nel momento peggiore della giornata.
        setSaving(false);
        await create(true);
        return;
      }
      toastErr(err, t, fireToast);
    } finally { if (alive.current) setSaving(false); }
  }

  /* orario digitato a mano → selezionato; se non è fra gli slot liberi serve forzare */
  const applyManualTime = () => {
    if (!manualTime) return;
    const minutes = hmToMin(manualTime);
    const iso = isoAtMin(date, minutes);
    const exact = (slots || []).find((s) => minutesOfDay(s.start) === minutes);
    setSelStart(exact ? exact.start : iso);
    setForceCreate(!exact);
    setShowAll(false);
   
  };
  const pickSlot = (start) => { setSelStart(start); setForceCreate(false); setShowAll(false); };
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 13.5, padding: '9px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)', boxSizing: 'border-box' };

  /* ---- chrome del drawer ---- */
  const shell = ({ title, sub, foot, children }) => (
    <div role="dialog" aria-label={title} style={{ position: 'fixed', top: 'var(--top-h)', right: 0, bottom: 0, width: 500, maxWidth: '94vw', zIndex, background: 'var(--surface)', borderLeft: '1px solid var(--hair)', boxShadow: 'var(--sh-pop)', display: 'flex', flexDirection: 'column', animation: 'dkSlideR 280ms var(--ease-emph)' }}>
      <div className="dk-modalhead" style={{ padding: '18px 22px 12px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-title" style={{ fontSize: 20, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
          {sub && <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{sub}</div>}
        </div>
        <button className="dk-iconbtn" style={{ flexShrink: 0, marginLeft: 12, width: 36, height: 36 }} onClick={onClose} aria-label={t('Chiudi', 'Close')} title="Esc"><Icon name="x" size={17} /></button>
      </div>
      <div className="dk-modalbody" style={{ flex: 1, minHeight: 0, padding: '0 22px 22px' }}>{children}</div>
      {foot && <div style={{ padding: '12px 22px 14px', borderTop: '1px solid var(--hair)', background: 'var(--surface-2)' }}>{foot}</div>}
    </div>
  );

  /* ---- sola lettura ---- */
  if (!canWrite) {
    return shell({
      title: t('Nuova prenotazione', 'New booking'),
      foot: <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Chiudi', 'Close')}</button></div>,
      children: (
        <div style={{ textAlign: 'center', padding: '40px 20px', border: '1.5px dashed var(--line-strong)', borderRadius: 14, color: 'var(--muted)' }}>
          <Icon name="lock" size={26} color="var(--muted-2)" style={{ margin: '0 auto 10px' }} />
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)', marginBottom: 4 }}>{t('Sola lettura', 'Read only')}</div>
          <div className="t-sm">{t('Il tuo ruolo non include il permesso “agenda”: chiedi alla titolare di abilitarlo.', 'Your role lacks the “agenda” permission: ask the owner to enable it.')}</div>
        </div>
      ),
    });
  }

  const filteredServices = activeServices.filter((s) => !svcQ || svcName(s, lang).toLowerCase().includes(svcQ.toLowerCase()));
  const morning = (slots || []).filter((s) => minutesOfDay(s.start) < 13 * 60);
  const afternoon = (slots || []).filter((s) => minutesOfDay(s.start) >= 13 * 60);
  const anyRecommended = (slots || []).some((s) => s.recommended) && (slots || []).some((s) => s.recommended === false);
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

  const foot = (
    <React.Fragment>
      {/* checklist: cosa manca per poter creare */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10, fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>
        {[
          { ok: !!client, label: client ? firstName(client.full_name) : t('Cliente', 'Client'), ref: clientRef },
          { ok: items.length > 0, label: items.length ? t(`${items.length} serviz${items.length === 1 ? 'io' : 'i'} · ${fmtDur(totalDur, lang)}`, `${items.length} service${items.length === 1 ? '' : 's'} · ${fmtDur(totalDur, lang)}`) : t('Servizio', 'Service'), ref: svcRef },
          { ok: !!selStart, label: selStart ? timeLabel(minutesOfDay(selStart)) + ' · ' + dateLabel : t('Orario', 'Time'), ref: timeRef },
        ].map((c, i) => (
          <button key={i} type="button" onClick={() => c.ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', borderRadius: 99, border: 'none', cursor: 'pointer', background: c.ok ? 'var(--ok-tint)' : 'var(--surface)', color: c.ok ? 'var(--ok)' : 'var(--muted)', boxShadow: c.ok ? 'none' : 'inset 0 0 0 1px var(--hair)' }}>
            <Icon name={c.ok ? 'check' : 'clock'} size={12} stroke={2.6} color={c.ok ? 'var(--ok)' : 'var(--muted-2)'} />{c.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" aria-disabled={!ready} onClick={create} style={{ flex: 1 }} title={missing.length ? t('Manca: ', 'Missing: ') + missing.map((m) => m.label).join(', ') : ''}>
          <Icon name="plus" size={17} color="#fff" />
          {saving ? t('Creazione…', 'Creating…') : missing.length ? t('Manca ', 'Missing ') + missing.map((m) => m.label).join(' · ') : t('Crea prenotazione', 'Create booking') + ' · ' + fmtMoney(totalPrice, lang)}
        </button>
      </div>
    </React.Fragment>
  );

  return shell({
    title: t('Nuova prenotazione', 'New booking'),
    sub: t('Clicca uno slot libero in agenda per riempire orario e operatrice', 'Click a free slot in the agenda to fill time and stylist'),
    foot,
    children: (
      <div>
        {/* ── contesto: data + orario/operatrice richiesti ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, padding: '10px 12px', borderRadius: 12, border: '1px solid var(--hair)', background: 'var(--surface-2)' }}>
          <button type="button" className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 8 }} onClick={() => shiftDate(-1)} disabled={date <= todayStr()} aria-label={t('Giorno precedente', 'Previous day')}><Icon name="chevL" size={15} /></button>
          <label style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', cursor: 'pointer' }}>
            <span className="t-meta" style={{ fontSize: 9.5 }}>{t('Data', 'Date')}</span>
            <span style={{ fontWeight: 700, fontSize: 14, textTransform: 'capitalize', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{dateLabel}</span>
            <input type="date" value={date} min={todayStr()} onChange={(e) => { if (e.target.value) { setDate(e.target.value); setSelStart(null); } }} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
          </label>
          <button type="button" className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 8 }} onClick={() => shiftDate(1)} aria-label={t('Giorno successivo', 'Next day')}><Icon name="chevR" size={15} /></button>
          {req && (req.startMin != null || reqOp) && (
            <span className="dk-pill dk-pill--on" style={{ gap: 6, padding: '5px 8px 5px 6px', cursor: 'default' }} title={t('Richiesta dall’agenda', 'Requested from the agenda')}>
              {reqOp && <Avatar initials={reqOp.initials} size={20} color={reqOp.color} />}
              {reqOp && <span>{reqOp.first_name}</span>}
              {req.startMin != null && <span className="tabnum">{timeLabel(req.startMin)}</span>}
              <button type="button" onClick={() => { setReq(null); setShowAll(true); setItems((l) => l.map((it) => ({ ...it, operator_id: null }))); }} aria-label={t('Rimuovi richiesta', 'Clear request')} style={{ display: 'grid', placeItems: 'center', width: 18, height: 18, borderRadius: 99, background: 'rgba(255,255,255,0.2)', cursor: 'pointer' }}><Icon name="x" size={11} color="#fff" stroke={2.6} /></button>
            </span>
          )}
        </div>

        {/* ── 1. cliente ── */}
        <div ref={clientRef} style={{ marginBottom: 18 }}>
          <StepLabel n={1} done={!!client} t={t}>{t('Cliente', 'Client')}</StepLabel>
          <ClientPicker value={client} onChange={setClient} autoFocus={!client} />
        </div>

        {/* ── 2. servizi ── */}
        <div ref={svcRef} style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StepLabel n={2} done={items.length > 0} t={t}>{t('Servizi', 'Services')}</StepLabel>
            {activeServices.length > 10 && (
              <input value={svcQ} onChange={(e) => setSvcQ(e.target.value)} placeholder={t('Filtra…', 'Filter…')} style={{ ...inputCss, marginLeft: 'auto', width: 130, padding: '5px 9px', fontSize: 12.5, marginBottom: 8 }} />
            )}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {/* La pillola prende il colore della sua categoria, piena: è lo
                stesso codice colore dei blocchi in agenda, e con il solo
                pallino il servizio si leggeva solo parola per parola. */}
            {filteredServices.map((s) => {
              const on = isSelected(s.id);
              const noOps = !eligibleOps(s.id).length;
              const cat = catColor(s.category_id);
              return (
                <button key={s.id} type="button" onClick={() => toggleService(s.id)} className="dk-pill" title={noOps ? t('Nessuna operatrice abilitata', 'No stylist enabled') : `${fmtDur(s.duration_min, lang)} · ${fmtEur(Number(s.price), lang)}`}
                  style={{
                    padding: '5px 11px', fontSize: 12.5, opacity: noOps && !on ? 0.55 : 1, color: 'var(--ink)',
                    borderWidth: 2, fontWeight: on ? 700 : 600,
                    background: on ? `color-mix(in srgb, ${cat} 70%, #FFFFFF)` : `color-mix(in srgb, ${cat} 26%, var(--surface))`,
                    borderColor: on ? `color-mix(in srgb, ${cat} 60%, var(--ink))` : `color-mix(in srgb, ${cat} 50%, transparent)`,
                    boxShadow: on ? `0 0 0 3px color-mix(in srgb, ${cat} 32%, transparent)` : 'none',
                  }}>
                  {svcName(s, lang)}
                  {giftFor(s.id) && <Icon name="gift" size={12} color="var(--clay-ink)" title={t('Coperto da una gift card', 'Covered by a gift card')} />}
                  <Icon name={on ? 'check' : 'plus'} size={12} stroke={2.6} color={on ? 'var(--ink)' : 'var(--ink-2)'} />
                </button>
              );
            })}
            {!filteredServices.length && <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessun servizio corrisponde', 'No service matches')}</span>}
          </div>

          {items.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              {items.map((it) => {
                const s = svcOf(it.service_id);
                if (!s) return null;
                const eligible = eligibleOps(it.service_id);
                const assigned = it.operator_id === null && selSlot ? assignedName(it.service_id) : null;
                return (
                  <div key={it.key} style={{ border: '1px solid var(--hair)', borderRadius: 12, overflow: 'hidden', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 11px', background: `color-mix(in srgb, ${catColor(s.category_id)} 16%, var(--surface))`, borderBottom: '1px solid var(--hair)' }}>
                      <span style={{ width: 9, height: 9, borderRadius: 99, background: catColor(s.category_id), flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{svcName(s, lang)}</div>
                        <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 12 }}>
                          {fmtDur((s.duration_min || 0) + (s.soak_min || 0), lang)}{s.soak_min ? ' · ' + t('incl. posa', 'incl. soak') + ' ' + fmtDur(s.soak_min, lang) : ''}
                          {assigned && <span> · {t('farà', 'by')} <b style={{ color: 'var(--ink)' }}>{assigned}</b></span>}
                        </div>
                      </div>
                      {giftFor(s.id) && (
                        <span title={t(`Gift card ${giftFor(s.id).code}`, `Gift card ${giftFor(s.id).code}`)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--clay) 40%, transparent)', padding: '2px 8px', borderRadius: 99, flexShrink: 0 }}>
                          <Icon name="gift" size={11} color="var(--clay-ink)" />{t('Regalo', 'Gift')}{giftFor(s.id).buyer_name ? ' · ' + firstName(giftFor(s.id).buyer_name) : ''}
                        </span>
                      )}
                      <span className="t-num" style={{ fontSize: 13.5, fontWeight: 700, flexShrink: 0, textDecoration: giftFor(s.id) ? 'line-through' : 'none', color: giftFor(s.id) ? 'var(--muted-2)' : undefined }}>{fmtEur(Number(s.price), lang)}</span>
                      <button type="button" className="dk-iconbtn" style={{ width: 26, height: 26, borderRadius: 8, flexShrink: 0 }} onClick={() => removeItem(it.key)} aria-label={t('Rimuovi', 'Remove')}><Icon name="x" size={13} /></button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 11px' }}>
                      <button type="button" onClick={() => setItemOp(it.key, null)} className={'dk-pill' + (it.operator_id === null ? ' dk-pill--on' : '')} style={{ padding: '4px 10px', fontSize: 12 }}>
                        <Icon name="sparkle" size={12} color={it.operator_id === null ? '#fff' : 'var(--muted-2)'} />{t('Prima disponibile', 'First available')}
                      </button>
                      {eligible.map((o) => {
                        const on = o.id === it.operator_id;
                        return (
                          <button key={o.id} type="button" onClick={() => setItemOp(it.key, o.id)} className={'dk-pill dk-pill--tint' + (on ? ' dk-pill--on' : '')} style={{ '--pill-c': o.color || 'var(--clay)', padding: '3px 10px 3px 4px', fontSize: 12 }}>
                            <Avatar initials={o.initials} size={20} color={o.color || 'var(--clay)'} ring={on} />
                            <span>{o.first_name}</span>
                            {on && <Icon name="check" size={12} stroke={2.6} />}
                          </button>
                        );
                      })}
                      {!eligible.length && (
                        <span className="t-sm" style={{ color: 'var(--danger)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <Icon name="alert" size={13} color="var(--danger)" />{t('Nessuna operatrice abilitata a questo servizio', 'No stylist can perform this service')}
                          <button type="button" onClick={() => { onClose?.(); setTab('staff'); }} style={{ color: 'var(--clay-ink)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>{t('Abilita in Staff', 'Enable in Staff')}</button>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── 3. orario ── */}
        {items.length > 0 && (
          <div ref={timeRef} style={{ marginBottom: 18 }}>
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
                      <div style={{ fontWeight: 700, fontSize: 14 }}><span className="tabnum">{timeLabel(req.startMin)}</span> · {t('non libero, si prenota lo stesso', 'not free, booking anyway')}</div>
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
        )}

        {/* ── orario manuale (oltre le regole) ── */}
        {items.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, border: '1px dashed var(--line-strong)', marginBottom: 18, flexWrap: 'wrap' }}>
            <Icon name="clock" size={16} color="var(--muted)" style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 170 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{t('Orario a mano', 'Type a time')}</div>
              <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{t('Anche fuori turno o sopra un’altra prenotazione.', 'Even off shift or over another booking.')}</div>
            </div>
            <input type="time" value={manualTime} step={step * 60} onChange={(e) => setManualTime(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyManualTime(); } }} aria-label={t('Orario manuale', 'Manual time')} style={{ ...inputCss, width: 112, padding: '7px 9px', fontFamily: 'var(--mono, monospace)', fontWeight: 700 }} />
            <button type="button" className="dk-btn dk-btn--soft" style={{ height: 36, fontSize: 12.5 }} disabled={!manualTime} onClick={applyManualTime}>{t('Usa', 'Use')}</button>
          </div>
        )}

        {/* ── nota + flessibile ── */}
        <div style={{ marginBottom: 12 }}>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Nota (facoltativa)', 'Note (optional)')}</div>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={t('es. preferisce il tono più freddo…', 'e.g. prefers the cooler tone…')} style={{ ...inputCss, width: '100%', resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 13px', background: 'var(--surface-2)', borderRadius: 12 }}>
          <Icon name="refresh" size={17} color="var(--clay-ink)" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Cliente flessibile', 'Flexible client')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 12 }}>{t('Disponibile a spostarsi per ottimizzare l’agenda', 'Open to being moved to optimise the agenda')}</div>
          </div>
          <Toggle on={flexible} onChange={setFlexible} />
        </div>
      </div>
    ),
  });
}

function StepLabel({ n, done, children, t }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span style={{ width: 20, height: 20, borderRadius: 99, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, background: done ? 'var(--ok)' : 'var(--ink)', color: '#fff' }} aria-label={done ? t('completato', 'done') : ''}>
        {done ? <Icon name="check" size={11} color="#fff" stroke={3} /> : n}
      </span>
      <span className="t-meta" style={{ color: 'var(--ink-2)' }}>{children}</span>
    </div>
  );
}
