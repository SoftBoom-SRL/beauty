// GroupBookingDrawer — book MULTIPLE clients in one session while the agenda stays visible.
// Right-side live drawer (no dark backdrop): each row = one client + services + a chosen start,
// so staff can stagger times against the live grid. Submits each row sequentially to
// POST /api/agenda/appointments, tracks per-row status, and never aborts the batch on one failure.
// Ogni riga è fatta con gli stessi pezzi di «Nuova prenotazione» (newappt/):
// guscio, barra della data, passi numerati, servizi, orari, piede. Prima le
// due prenotazioni mostravano le stesse cose in due modi diversi (15/10).
import React, { useEffect, useRef, useState } from 'react';
import { ApiError, apiErrorText, toastApiError, Avatar, Icon, addDays, fmtDur, timeLabel, minutesOfDay, todayStr, toDateStr } from '@youty/shared';
import { useDash } from '../../../ctx.jsx';
import { useEscLayer } from '../../../ui/layers.js';
import { serviceColor } from '../../../ui/palette.js';
import { usePanelSlot } from '../../../ui/DkPanel.jsx';
import { initialsOf, firstName, fmtMoney } from '../lib.js';
import ClientPicker from '../ClientPicker.jsx';
import * as agendaApi from '../agendaApi.js';
import { useGiftCards } from '../hooks/useGiftCards.js';
import { relativeDateLabel } from './rules.js';
import BookingShell, { BOOKING_PANEL_W, ReadOnlyNote } from './newappt/BookingShell.jsx';
import DateBar from './newappt/DateBar.jsx';
import StepLabel from './newappt/StepLabel.jsx';
import ServiceStep from './newappt/ServiceStep.jsx';
import TimeStep from './newappt/TimeStep.jsx';
import NoteFlexible from './newappt/NoteFlexible.jsx';

const svcName = (s, lang) => (lang === 'en' && s?.name_en ? s.name_en : s?.name_it || '');
const rowPrice = (row, services) => row.items.reduce((sum, it) => sum + Number((services || []).find((s) => s.id === it.service_id)?.price || 0), 0);
const noop = () => {};

export default function GroupBookingDrawer({ date, onClose, onCreated }) {
  const { t, lang, services, fireToast, hasScope, locationId } = useDash();
  const canWrite = hasScope('agenda');
  const baseDate = date || todayStr();

  const seq = useRef(1);
  const newRow = () => ({
    key: 'r' + seq.current++,
    client: null,
    items: [],          // [{ key, service_id, operator_id }]
    date: baseDate,
    selStart: null,     // ISO string of chosen slot
    note: '',           // nota e «flessibile», come in «Nuova prenotazione»
    flexible: false,
    reloadKey: 0,       // bump → force availability refetch
    status: 'pending',  // pending | creating | done | error
    error: '',
    created: null,      // AppointmentOut after success
  });

  const [rows, setRows] = useState(() => [newRow()]);
  const [batchRunning, setBatchRunning] = useState(false);

  /* Esc chiude, come ogni altro drawer della dashboard (vedi DkDrawer). Questo
   * pannello si disegna da sé e la scorciatoia mancava: l'unica via d'uscita
   * era il pulsante. Durante la creazione non si chiude, per non lasciare a metà
   * una serie di prenotazioni. Passa dalla pila di layers.js: con l'ascoltatore
   * proprio su window, Esc per chiudere la tendina della ricerca cliente
   * chiudeva il drawer con le righe già compilate (13-10). */
  useEscLayer(true, () => { if (!batchRunning) onClose?.(); });

  /* Area di lavoro ristretta e drawer sopra i pannelli aperti prima: col
   * dettaglio di un appuntamento aperto si apriva nascosto dietro (13-19). */
  const zIndex = usePanelSlot(BOOKING_PANEL_W);
  // le schede delle clienti, per portarci dal piede (come i passi di «Nuova prenotazione»)
  const rowEls = useRef({});

  const patchRow = (key, partial) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...(typeof partial === 'function' ? partial(r) : partial) } : r)));
  const addRow = () => setRows((rs) => [...rs, newRow()]);
  const removeRow = (key) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : rs));
  const resetAll = () => { seq.current = 1; setRows([newRow()]); };

  const isReady = (r) => r.client && r.items.length > 0 && r.selStart && r.status !== 'done';
  const readyCount = rows.filter(isReady).length;
  const doneCount = rows.filter((r) => r.status === 'done').length;
  const allDone = rows.length > 0 && rows.every((r) => r.status === 'done');

  /* ---- sequential batch create — one failure never aborts the rest ---- */
  async function createAll() {
    if (batchRunning || !canWrite) return;
    const snapshot = rows.filter((r) => r.status !== 'done' && r.client && r.items.length && r.selStart);
    if (!snapshot.length) return;
    setBatchRunning(true);
    for (const row of snapshot) {
      patchRow(row.key, { status: 'creating', error: '' });
      try {
        const res = await agendaApi.createAppointment({
          client_id: row.client.id,
          items: row.items.map((i) => ({ service_id: i.service_id, operator_id: i.operator_id })),
          start: row.selStart,
          note: row.note,
          flexible: row.flexible,
          location_id: locationId,
        });
        patchRow(row.key, { status: 'done', created: res });
        onCreated?.(); // refresh the agenda behind so the next slot picks against updated availability
      } catch (err) {
        const msg = err instanceof ApiError && err.status === 409
          ? t('Orario non più disponibile', 'Time no longer available')
          : apiErrorText(err, t);
        // 409 → the slot is gone: clear it and force a fresh availability fetch so staff can re-pick
        patchRow(row.key, (r) => ({
          status: 'error', error: msg,
          selStart: err instanceof ApiError && err.status === 409 ? null : r.selStart,
          reloadKey: r.reloadKey + 1,
        }));
        if (!(err instanceof ApiError)) toastApiError(err, fireToast, t);
      }
    }
    setBatchRunning(false);
    onCreated?.();
  }

  /* ---- guscio: lo stesso di «Nuova prenotazione» (BookingShell) ---- */
  const shell = (body, footer) => (
    <BookingShell
      title={t('Prenotazione di gruppo', 'Group booking')} sub={t('Prenota più clienti in una sola sessione', 'Book several clients in one session')}
      foot={footer} onClose={onClose} closeDisabled={batchRunning} zIndex={zIndex} t={t}
    >
      {body}
    </BookingShell>
  );

  /* ---- read-only gate ---- */
  if (!canWrite) {
    return shell(
      <ReadOnlyNote t={t} />,
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Chiudi', 'Close')}</button></div>
    );
  }

  /* ---- all done: summary ---- */
  if (allDone) {
    return shell(
      <React.Fragment>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 16px', borderRadius: 14, background: 'var(--ok-tint)', marginBottom: 16 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--ok)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="check" size={20} color="#fff" stroke={2.6} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{t(`${doneCount} prenotazioni create`, `${doneCount} bookings created`)}</div>
            <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Il gruppo è stato inserito in agenda.', 'The group has been added to the agenda.')}</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r) => (
            <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, background: 'var(--surface-2)' }}>
              <Avatar initials={initialsOf(r.client?.full_name)} size={30} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.client?.full_name}</div>
                <div className="t-sm" style={{ color: 'var(--muted)' }}>{(r.created?.items || r.items).map((i) => i.service_name || (services || []).find((s) => s.id === i.service_id)?.[lang === 'en' ? 'name_en' : 'name_it']).filter(Boolean).join(' + ')}</div>
              </div>
              {r.created?.start && <span className="t-num" style={{ fontSize: 14, fontWeight: 700 }}>{timeLabel(minutesOfDay(r.created.start))}</span>}
              <Icon name="check" size={16} color="var(--ok)" stroke={2.6} />
            </div>
          ))}
        </div>
      </React.Fragment>,
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="dk-btn dk-btn--ghost" onClick={resetAll}><Icon name="plus" size={16} />{t('Nuovo gruppo', 'New group')}</button>
        <button className="dk-btn dk-btn--clay" style={{ flex: 1 }} onClick={onClose}><Icon name="check" size={16} color="#fff" />{t('Chiudi', 'Close')}</button>
      </div>
    );
  }

  /* ---- normal: list of client rows ---- */
  const readyPrice = rows.filter(isReady).reduce((sum, r) => sum + rowPrice(r, services), 0);
  /* Nessuna riga pronta: come in «Nuova prenotazione» il pulsante resta
   * premibile, dice che cosa manca e porta alla prima scheda da completare. */
  const create = () => {
    if (readyCount > 0) { createAll(); return; }
    const i = rows.findIndex((r) => r.status !== 'done' && !isReady(r));
    if (i < 0) return;
    const r = rows[i];
    const missing = [!r.client && t('cliente', 'client'), !r.items.length && t('servizio', 'service'), r.items.length > 0 && !r.selStart && t('orario', 'time')].filter(Boolean);
    fireToast({ msg: t(`Cliente ${i + 1} · manca: `, `Client ${i + 1} · missing: `) + missing.join(' · '), icon: 'alert' });
    rowEls.current[r.key]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  return shell(
    <React.Fragment>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {rows.map((row, i) => (
          <GroupRow
            key={row.key}
            row={row}
            index={i}
            canRemove={rows.length > 1}
            busy={batchRunning}
            onPatch={(partial) => patchRow(row.key, partial)}
            onRemove={() => removeRow(row.key)}
            rowRef={(el) => { rowEls.current[row.key] = el; }}
            onCloseDrawer={onClose}
          />
        ))}
      </div>
      <button
        onClick={addRow}
        disabled={batchRunning}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', marginTop: 14, padding: '12px', borderRadius: 12, border: '1.5px dashed var(--line-strong)', background: 'transparent', color: 'var(--clay-ink)', fontWeight: 700, fontSize: 13.5, cursor: batchRunning ? 'default' : 'pointer', opacity: batchRunning ? 0.5 : 1 }}
      >
        <Icon name="plus" size={16} color="var(--clay-ink)" />{t('Aggiungi cliente', 'Add client')}
      </button>
    </React.Fragment>,
    /* Il piede come quello di «Nuova prenotazione» (BookingFoot): sopra chi è
       pronta e chi no (un clic porta alla sua scheda), sotto «Annulla» e il
       pulsante che crea, col totale. */
    <React.Fragment>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10, fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>
        {rows.map((r, i) => {
          const ok = r.status === 'done' || isReady(r);
          const label = (r.client ? firstName(r.client.full_name) : t(`Cliente ${i + 1}`, `Client ${i + 1}`))
            + (r.selStart ? ' · ' + timeLabel(minutesOfDay(r.selStart)) : '');
          return (
            <button key={r.key} type="button" onClick={() => rowEls.current[r.key]?.scrollIntoView({ behavior: 'smooth', block: 'center' })} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', borderRadius: 99, border: 'none', cursor: 'pointer', background: ok ? 'var(--ok-tint)' : 'var(--surface)', color: ok ? 'var(--ok)' : 'var(--muted)', boxShadow: ok ? 'none' : 'inset 0 0 0 1px var(--hair)' }}>
              <Icon name={ok ? 'check' : 'clock'} size={12} stroke={2.6} color={ok ? 'var(--ok)' : 'var(--muted-2)'} />{label}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="dk-btn dk-btn--ghost" onClick={onClose} disabled={batchRunning}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" style={{ flex: 1 }} disabled={batchRunning} aria-disabled={readyCount === 0} onClick={create}
          title={readyCount === 0 ? t('Per ogni cliente: chi è, i servizi e l’orario', 'For each client: who, the services and the time') : ''}>
          <Icon name="plus" size={17} color="#fff" />
          {batchRunning
            ? t('Creazione…', 'Creating…')
            : readyCount === 0
              ? t('Manca cliente, servizio o orario', 'Missing client, service or time')
              : t(`Crea ${readyCount} prenotazion${readyCount === 1 ? 'e' : 'i'}`, `Create ${readyCount} booking${readyCount === 1 ? '' : 's'}`) + ' · ' + fmtMoney(readyPrice, lang)}
        </button>
      </div>
    </React.Fragment>
  );
}

/* ============================================================= *
 *  A single client row: client picker + services + time picker  *
 * ============================================================= */
function GroupRow({ row, index, canRemove, busy, onPatch, onRemove, rowRef, onCloseDrawer }) {
  const { t, lang, services, serviceCategories, operators, fireToast, locationId, setTab } = useDash();
  const itemSeq = useRef(1);
  const locked = busy || row.status === 'creating' || row.status === 'done';

  const activeServices = (services || []).filter((s) => s.active !== false);
  const svcOf = (id) => (services || []).find((s) => s.id === id);
  // il colore del servizio: il suo, o quello della categoria (ui/palette.js)
  const svcColor = (s) => serviceColor(s, serviceCategories) || 'var(--clay)';
  const eligibleOps = (serviceId) => (operators || []).filter((o) => (o.service_ids || []).includes(serviceId));
  // i regali della cliente, accanto ai servizi coperti (come in «Nuova prenotazione»)
  const giftFor = useGiftCards(row.client?.id);

  /* ---- servizi: si scelgono e si tolgono come in «Nuova prenotazione»
   * (prima ogni clic aggiungeva un'altra copia dello stesso servizio) ---- */
  const [svcQ, setSvcQ] = useState('');
  const filteredServices = activeServices.filter((s) => !svcQ || svcName(s, lang).toLowerCase().includes(svcQ.toLowerCase()));
  const isSelected = (sid) => row.items.some((x) => x.service_id === sid);
  const setItems = (fn) => onPatch((r) => ({ items: typeof fn === 'function' ? fn(r.items) : fn, selStart: null }));
  const toggleService = (sid) => setItems((l) => (l.some((x) => x.service_id === sid)
    ? l.filter((x) => x.service_id !== sid)
    : [...l, { key: 'it' + itemSeq.current++, service_id: sid, operator_id: null }]));
  const removeItem = (key) => setItems((l) => l.filter((x) => x.key !== key));
  const setItemOp = (key, opId) => setItems((l) => l.map((x) => (x.key === key ? { ...x, operator_id: opId } : x)));

  const totalPrice = rowPrice(row, services);
  // La posa occupa lo slot come il lavoro attivo (come in NewApptModal):
  // senza, colore 45' + 30' di posa si annunciava «45m» e la cliente trovava
  // occupata un'ora e un quarto.
  const totalDur = row.items.reduce((s, it) => { const sv = svcOf(it.service_id); return s + (sv?.duration_min || 0) + (sv?.soak_min || 0); }, 0);

  /* ---- giorno: le frecce e il calendario di «Nuova prenotazione» (DateBar) ---- */
  const dateLabel = relativeDateLabel(row.date, lang, t);
  const setDate = (d) => onPatch({ date: d, selStart: null });
  const shiftDate = (n) => { const iso = toDateStr(addDays(row.date, n)); if (iso >= todayStr()) setDate(iso); };

  /* ---- availability ---- */
  const [slots, setSlots] = useState([]); // null = loading, [] = none
  const itemsKey = JSON.stringify(row.items.map((i) => [i.service_id, i.operator_id]));
  useEffect(() => {
    if (!row.items.length || !row.date) { setSlots([]); return; }
    let alive = true;
    setSlots(null);
    agendaApi.getAvailability({ date: row.date, location_id: locationId, items: row.items.map((i) => ({ service_id: i.service_id, operator_id: i.operator_id })) })
      .then((res) => {
        if (!alive) return;
        setSlots(res);
        if (row.selStart && !res.some((s) => s.start === row.selStart)) onPatch({ selStart: null });
      })
      .catch((err) => { if (alive) { setSlots([]); toastApiError(err, fireToast, t); } });
    return () => { alive = false; };
  }, [row.date, itemsKey, row.reloadKey, locationId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- orario: gli orari di «Nuova prenotazione» (TimeStep); scelto, resta
   * la riga dell'orario con «Cambia orario», e le schede restano corte ---- */
  const [showAll, setShowAll] = useState(false);
  const pickSlot = (start) => { onPatch({ selStart: start }); setShowAll(false); };
  const selSlot = (slots || []).find((s) => s.start === row.selStart) || null;
  const assignedName = (serviceId) => {
    const a = selSlot?.assignment?.find((x) => x.service_id === serviceId);
    const o = a && (operators || []).find((op) => op.id === a.operator_id);
    return o ? o.first_name : null;
  };
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 13.5, padding: '9px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)', boxSizing: 'border-box' };

  /* ---- row header status ---- */
  const statusBadge = () => {
    if (row.status === 'done') return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: 'var(--ok)', background: 'var(--ok-tint)', padding: '3px 9px', borderRadius: 99 }}><Icon name="check" size={12} color="var(--ok)" stroke={2.6} />{t('Creata', 'Created')}</span>;
    if (row.status === 'creating') return <span className="t-sm" style={{ fontWeight: 700, color: 'var(--clay-ink)' }}>{t('Creazione…', 'Creating…')}</span>;
    if (row.status === 'error') return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: 'var(--danger)', background: 'var(--danger-tint, rgba(220,80,80,0.12))', padding: '3px 9px', borderRadius: 99 }}><Icon name="alert" size={12} color="var(--danger)" />{t('Errore', 'Error')}</span>;
    return null;
  };

  /* ---- done rows collapse to a compact confirmed line ---- */
  if (row.status === 'done') {
    return (
      <div ref={rowRef} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', borderRadius: 14, border: '1px solid var(--ok)', background: 'var(--ok-tint)' }}>
        <Avatar initials={initialsOf(row.client?.full_name)} size={32} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.client?.full_name}</div>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{row.items.map((it) => { const s = svcOf(it.service_id); return s ? svcName(s, lang) : null; }).filter(Boolean).join(' + ')}</div>
        </div>
        {row.selStart && <span className="t-num" style={{ fontSize: 14, fontWeight: 700 }}>{timeLabel(minutesOfDay(row.selStart))}</span>}
        <Icon name="check" size={17} color="var(--ok)" stroke={2.6} />
      </div>
    );
  }

  return (
    <div ref={rowRef} style={{ border: '1px solid ' + (row.status === 'error' ? 'var(--danger)' : 'var(--hair)'), borderRadius: 16, overflow: 'hidden', background: 'var(--surface)', opacity: row.status === 'creating' ? 0.7 : 1 }}>
      {/* row header: chi è, durata e prezzo (in «Nuova prenotazione» stanno nel piede) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', background: 'var(--surface-2)', borderBottom: '1px solid var(--hair)' }}>
        <span style={{ width: 22, height: 22, borderRadius: 99, background: 'var(--clay-tint)', color: 'var(--clay-ink)', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{index + 1}</span>
        <span style={{ flex: 1, fontWeight: 700, fontSize: 13.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: row.client ? 'var(--ink)' : 'var(--muted)' }}>
          {row.client ? row.client.full_name : t(`Cliente ${index + 1}`, `Client ${index + 1}`)}
        </span>
        {row.items.length > 0 && (
          <span className="t-sm tabnum" style={{ color: 'var(--muted)', fontWeight: 600, flexShrink: 0 }}>{fmtDur(totalDur, lang)} · {fmtMoney(totalPrice, lang)}</span>
        )}
        {statusBadge()}
        {canRemove && !locked && (
          <button className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0 }} onClick={onRemove} aria-label={t('Rimuovi riga', 'Remove row')}><Icon name="x" size={14} /></button>
        )}
      </div>

      <div style={{ padding: '14px 14px 0', pointerEvents: locked ? 'none' : 'auto' }}>
        {/* error message */}
        {row.status === 'error' && row.error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, padding: '9px 11px', borderRadius: 10, background: 'var(--danger-tint, rgba(220,80,80,0.12))' }}>
            <Icon name="alert" size={15} color="var(--danger)" />
            <span className="t-sm" style={{ fontWeight: 600, color: 'var(--danger)' }}>{row.error}</span>
          </div>
        )}

        <DateBar
          date={row.date} dateLabel={dateLabel} shiftDate={shiftDate} setDate={setDate} choose={noop}
          req={null} reqOp={null} setReq={noop} setShowAll={setShowAll} setItems={setItems} t={t}
        />

        {/* 1. cliente — componente condiviso con il drawer nuova prenotazione */}
        <div style={{ marginBottom: 18 }}>
          <StepLabel n={1} done={!!row.client} t={t}>{t('Cliente', 'Client')}</StepLabel>
          <ClientPicker value={row.client} onChange={(c) => onPatch({ client: c })} />
        </div>

        {/* 2. servizi e chi li fa */}
        <ServiceStep
          items={row.items} activeServices={activeServices} filteredServices={filteredServices} svcQ={svcQ} setSvcQ={setSvcQ}
          inputCss={inputCss} isSelected={isSelected} toggleService={toggleService} eligibleOps={eligibleOps} svcColor={svcColor}
          svcOf={svcOf} svcName={svcName} giftFor={giftFor} selSlot={selSlot} assignedName={assignedName} removeItem={removeItem}
          setItemOp={setItemOp} onClose={onCloseDrawer} setTab={setTab} t={t} lang={lang}
        />

        {/* 3. orario */}
        {row.items.length > 0 && (
          <TimeStep
            slots={slots} selStart={row.selStart} pickSlot={pickSlot} reqStatus={null} req={null} reqOp={null}
            setReq={noop} totalDur={totalDur} showAll={showAll} setShowAll={setShowAll} dateLabel={dateLabel} items={row.items}
            setItems={setItems} eligibleOps={eligibleOps} shiftDate={shiftDate} operators={operators || []} t={t}
          />
        )}

        {/* nota e cliente flessibile, come in «Nuova prenotazione» */}
        <div style={{ marginBottom: 14 }}>
          <NoteFlexible
            note={row.note} setNote={(note) => onPatch({ note })} flexible={row.flexible} setFlexible={(flexible) => onPatch({ flexible })}
            inputCss={inputCss} t={t}
          />
        </div>
      </div>
    </div>
  );
}
