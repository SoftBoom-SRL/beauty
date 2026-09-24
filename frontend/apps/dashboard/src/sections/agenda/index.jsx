// Agenda — day/week/month calendar wired to /api/agenda/* (port of desktop-agenda.jsx)
// Lo stato e i gesti stanno negli hook (hooks/): che cosa si guarda
// (useAgendaNav), zoom, dati del giorno e della colonna di destra
// (useAgendaData), live, «torna indietro» (useUndo), tasti e gesti che
// scrivono (useAgendaMutations). Qui restano la barra, le chip, il menu dello
// slot e il montaggio delle viste.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Icon, fmtDateIt, timeLabel, toDateStr, todayStr, parseISO, NumInput } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import {
  MONTHS_IT, MONTHS_EN, DOW_IT, DOW_EN, hoverPlacement,
  isoAtMin, mondayOf, weekDaysOf, periodLabel, isTodayInWeek, firstName, opDisplay, aStartMin,
  ZOOM_MIN, ZOOM_MAX, HOVER_CLEAR_DAY, BREAK_PRESETS, BREAK_DEFAULT_MIN, LIVE_DEBOUNCE_DAY_MS, zoomStep,
} from './lib.js';
import { useAgendaNav } from './hooks/useAgendaNav.js';
import { useStoredFlag } from './hooks/useStoredFlag.js';
import { useAgendaZoom } from './hooks/useAgendaZoom.js';
import { useNowMinutes } from './hooks/useNowMinutes.js';
import { useAgendaData } from './hooks/useAgendaData.js';
import { useOpenApptCopy } from './hooks/useOpenApptCopy.js';
import { useAgendaLive } from './hooks/useAgendaLive.js';
import { useOperatorVisibility } from './hooks/useOperatorVisibility.js';
import { useAgendaColors } from './hooks/useAgendaColors.js';
import { useUndo } from './hooks/useUndo.js';
import { useAgendaShortcuts } from './hooks/useAgendaShortcuts.js';
import { useAgendaMutations } from './hooks/useAgendaMutations.js';
import DayGrid from './DayGrid.jsx';
import ApptHoverCard from './grid/ApptHoverCard.jsx';
import DaySkeleton from './grid/DaySkeleton.jsx';
import JumpPopover from './parts/JumpPopover.jsx';
import SalonHoursChip from './parts/SalonHoursChip.jsx';
import WeekView from './WeekView.jsx';
import MonthView from './MonthView.jsx';
import RightRail from './RightRail.jsx';
import GroupBookingDrawer from './modals/GroupBookingDrawer.jsx';

export default function AgendaSection() {
  const {
    t, lang, operators, services, serviceCategories, hasScope,
    openModal, modal, fireToast, opColors, setOpColor, opPalette,
    setTab, setDeepLink, showRevenue, live, setAgendaPick, setAgendaDate, settings, session, locationId,
    toastProps,
  } = useDash();
  const canWrite = hasScope('agenda');
  const noWrite = useCallback(() => fireToast({ msg: t('Il tuo ruolo non ha il permesso “agenda”: puoi solo consultare', 'Your role lacks the “agenda” permission: read only'), icon: 'lock' }), [fireToast, t]);

  /* ---- navigation state ---- */
  const { date, setDate, calView, setCalView, jumpOpen, setJumpOpen, navPrev, navNext, jumpToMonth, jumpToDate, openDay } = useAgendaNav();
  const [railOpen, setRailOpen] = useStoredFlag('dk-agenda-rail');

  /* ---- zoom delle viste giorno/settimana: preferenza della postazione ---- */
  const { zoom, setZoom, fitZoom } = useAgendaZoom();

  /* ---- real "now" (updated every 30s) ---- */
  const nowMin = useNowMinutes();
  const isToday = date === todayStr();
  useEffect(() => { setAgendaDate(date); return () => setAgendaDate(null); }, [date, setAgendaDate]);

  /* ---- day data ---- */
  const {
    dayData, waitlist, summary, released, undoStack, dateRef, fetchDay, fetchUndo, refetchAll, refetchAllRef,
  } = useAgendaData({ date, locationId, t, fireToast });
  // minuto in cima alla griglia del giorno: sopravvive allo scheletro fra un
  // giorno e l'altro (vedi DayGrid, `scrollMemo`)
  const dayScroll = useRef(null);

  /* Copia fresca dell'appuntamento aperto nel pannello (vedi useOpenApptCopy):
   * l'ombra e «Sposta qui» devono partire da dov'è adesso. */
  const { modalRef, reloadOpenAppt, openAppt } = useOpenApptCopy(modal);

  /* live: quando un'altra postazione tocca l'agenda, ricarica (debounce breve,
   * vedi useAgendaLive). `deposit.`: la caparra pagata online deve comparire da
   * sola, senza che nessuno ricarichi la pagina. `operator.` e `settings.`
   * (turni, assenze, orari del centro): vedi AGENDA_LIVE_RE.
   * Con il pannello aperto si rilegge anche il suo appuntamento, che può
   * essere stato cambiato altrove: l'ombra deve stare dove sta davvero. */
  const onAgendaLive = useCallback(() => {
    refetchAll();
    const m = modalRef.current;
    if (m?.name === 'apptdetail' && m.props?.appointment?.id) reloadOpenAppt(m.props.appointment.id);
  }, [refetchAll, reloadOpenAppt, modalRef]);
  useAgendaLive(live, onAgendaLive, LIVE_DEBOUNCE_DAY_MS);

  /* refetch after any modal closes — mutations happen inside modals, keep the grid fresh */
  const prevModal = useRef(modal);
  useEffect(() => {
    if (prevModal.current && !modal) refetchAll();
    prevModal.current = modal;
  }, [modal, refetchAll]);

  /* ---- operator visibility chips ---- */
  const { vis, visCount, allOn, toggleVis, setAll } = useOperatorVisibility(operators);
  const opFirsts = operators.map((o) => o.first_name); // disambiguazione omonimie nelle chip

  const { colorOf, itemColor } = useAgendaColors({ opColors, services, serviceCategories });

  /* ---- interactions state ---- */
  const [hover, setHover] = useState(null);       // { a, x, y, side }
  const [slotMenu, setSlotMenu] = useState(null); // { opId, startMin, x, y, mode?, dur? }
  const [picker, setPicker] = useState(null);     // opId whose colour picker is open

  const onHover = (a, el) => {
    if (!a) { setHover(null); return; }
    setHover({ a, ...hoverPlacement(el.getBoundingClientRect(), window, HOVER_CLEAR_DAY) });
  };

  /* ---- nuova prenotazione: UN solo drawer (modale 'newappt'), da qualunque punto si parta ----
   * Mentre è aperto l'agenda è in "pick mode": un clic su uno slot libero
   * passa orario e operatrice al drawer invece di aprire il menu. */
  const [groupOpen, setGroupOpen] = useState(false);
  const pickMode = modal?.name === 'newappt';
  const openNewAppt = useCallback((prefill) => {
    if (!canWrite) { noWrite(); return; }
    openModal('newappt', { prefill: prefill || {}, onCreated: () => refetchAllRef.current() });
  }, [canWrite, noWrite, openModal, refetchAllRef]);   // la ref è stabile
  /* Con la prenotazione aperta, un clic in griglia SCEGLIE l'orario: aprire un
   * altro drawer (vista settimana) o il dettaglio di un blocco sostituiva quello
   * in corso, e cliente, servizi e nota scritti al telefono sparivano. */
  const pickNewAppt = useCallback((prefill) => {
    if (pickMode) {
      if (!canWrite) { noWrite(); return; }
      setAgendaPick({ operatorId: prefill?.operatorId, start: prefill?.start, date: prefill?.date });
      return;
    }
    openNewAppt(prefill);
  }, [pickMode, canWrite, noWrite, setAgendaPick, openNewAppt]);

  /* Dettaglio di un appuntamento, da qualunque punto dell'agenda.
   * `extraMutate`: la vista settimana ricarica anche la sua griglia. */
  const openApptDetail = (a, extraMutate) => {
    if (!a) return;
    if (pickMode) {
      fireToast({ msg: t('Prenotazione in corso: scegli uno spazio libero, o chiudila per aprire questo appuntamento', 'Booking in progress: pick a free space, or close it to open this appointment'), icon: 'info' });
      return;
    }
    /* In settimana il giorno «scelto» non si vede: aprendo un appuntamento di
     * giovedì con la sezione ferma su lunedì, l'ombra compariva su lunedì, alla
     * stessa ora, senza niente che dicesse perché. Qui il giorno scelto diventa
     * quello dell'appuntamento: l'ombra compare solo quando si sfoglia davvero
     * un altro giorno dal pannello — che quel giorno lo mostra. */
    if (calView === 'week') {
      const day = toDateStr(a.start);
      if (day && day !== dateRef.current) setDate(day);
    }
    /* Già aperto sulla stessa visita (un secondo clic sul blocco): riaprirlo
     * rimontava il pannello e buttava servizi e nota non ancora salvati
     * (13-05). Il pannello si rilegge da sé con gli eventi live; qui si
     * rinfresca solo la copia che muove l'ombra e «Sposta qui». */
    const cur = modalRef.current;
    if (cur?.name === 'apptdetail' && cur.props?.appointment?.id === a.id) {
      reloadOpenAppt(a.id);
      return;
    }
    openModal('apptdetail', {
      appointment: a,
      onMutate: () => { refetchAllRef.current(); extraMutate?.(); reloadOpenAppt(a.id); },
      onShowDate: setDate,
    });
  };

  /* ---- torna indietro (bottone «Indietro», ⌘Z, «Annulla» degli avvisi) ---- */
  const { undoing, undoLast, undoMark, undoAfter } = useUndo({
    canWrite, noWrite, fireToast, t, toastProps, dateRef, setDate, refetchAllRef, fetchUndo, undoStack,
  });
  // N, + − 0 e ⌘Z
  useAgendaShortcuts({ openNewAppt, date, modal, groupOpen, setZoom, undoLast });

  /* ---- mutations (drag & drop, pauses) ---- */
  const {
    pending, moveAppt, splitItem, moveOpenApptHere, moveApptToDate, onInvalidDrop, restoreReleased,
    movePause, resizePause, deletePause, resizeItem, addBreak,
  } = useAgendaMutations({
    canWrite, noWrite, date, operators, t, fireToast,
    undoMark, undoAfter, fetchDay, fetchUndo, refetchAll, reloadOpenAppt, setSlotMenu,
  });
  // Trascinamento in corso in vista giorno: accende i giorni in alto come
  // bersaglio, altrimenti nessuno immagina di poterci lasciare sopra un blocco.
  const [dragOn, setDragOn] = useState(false);

  /* Ombra dell'appuntamento aperto: mentre dal pannello si sfogliano i
   * giorni, si vede dove andrebbe a finire — alla sua ora, nella colonna di
   * chi lo fa. Sul suo giorno non serve: lì c'è il blocco vero, cerchiato. */
  const ghostAppt = openAppt && toDateStr(openAppt.start) !== date ? openAppt : null;

  /* ---- toolbar helpers ---- */
  const MONTHS = lang === 'en' ? MONTHS_EN : MONTHS_IT;
  const cur = parseISO(date);
  const monday = mondayOf(date);
  const weekDays = weekDaysOf(monday);

  // Nessun fallback "mostra tutte": spegnendo tutte le chip la griglia deve
  // restare vuota (lo stato vuoto è già previsto), non riaccendere tutto.
  /* Le chip decidono quali COLONNE si disegnano, non quali dati esistono: il
   * payload elenca ogni appuntamento una volta sola, nella riga dell'operatrice
   * principale, ma i suoi servizi possono essere di altre. Filtrando anche i
   * dati, spegnere una chip faceva sparire il lavoro delle colleghe rimaste e
   * dichiarava «Disponibile» uno slot occupato davvero. */
  const allRows = dayData || [];
  const visibleRows = allRows.filter((r) => vis[r.operator.id] !== false);

  // Prenotazione aperta: un clic sulla griglia (giorno o settimana) sceglie
  // l'orario. Stava solo in vista giorno, e in settimana il clic apriva un
  // drawer nuovo sopra quello in corso.
  const pickBanner = pickMode ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 26px', background: 'var(--clay-tint)', borderBottom: '1px solid var(--hair)', color: 'var(--clay-ink)', fontSize: 13, fontWeight: 600 }}>
      <Icon name="target" size={15} color="var(--clay-ink)" />
      {t('Scelta orario: clicca uno spazio libero per impostare orario e operatrice nella prenotazione', 'Pick a time: click a free space to set time and stylist in the booking')}
    </div>
  ) : null;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* timeline column */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* sub toolbar */}
        {/* va a capo quando lo spazio non basta: prima il selettore vista (Giorno/
          * Settimana/Mese) veniva tagliato dal pannello laterale aperto. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, rowGap: 10, padding: '16px 26px', borderBottom: '1px solid var(--hair)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <button className="dk-iconbtn" style={{ width: 38, height: 38 }} onClick={navPrev}><Icon name="chevL" size={18} /></button>
            <button className="dk-iconbtn" style={{ width: 38, height: 38 }} onClick={navNext}><Icon name="chevR" size={18} /></button>
          </div>
          {calView === 'day' ? (
            <React.Fragment>
              <div style={{ position: 'relative' }}>
                <button onClick={() => setJumpOpen((o) => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap' }}>
                  {MONTHS[cur.getMonth()] + ' ' + cur.getFullYear()}
                  <Icon name="chevD" size={15} color="var(--muted)" style={{ transform: jumpOpen ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} />
                </button>
                {jumpOpen && <JumpPopover t={t} MONTHS={MONTHS} curM={cur.getMonth()} curY={cur.getFullYear()} onClose={() => setJumpOpen(false)} onMonth={jumpToMonth} onDate={jumpToDate} />}
              </div>
              {/* week day strip — real dates */}
              {/* Durante un trascinamento la striscia diventa un bersaglio: si può
                  lasciare un appuntamento su un giorno per spostarlo lì. */}
              <div style={{ display: 'flex', gap: 4, background: dragOn ? 'var(--clay-tint)' : 'var(--surface)', border: '1px solid ' + (dragOn ? 'var(--clay)' : 'var(--hair)'), borderRadius: 14, padding: 4, transition: 'background 150ms, border-color 150ms' }}>
                {weekDays.map((d, i) => {
                  const iso = toDateStr(d);
                  const sel = iso === date;
                  const dropTarget = dragOn && !sel;
                  return (
                    <button key={i} onClick={() => setDate(iso)} data-daydrop={iso}
                      title={dragOn ? t('Lascia qui per spostare a questo giorno', 'Drop here to move to this day') : undefined}
                      // L'evidenza NON deve usare il bordo: aggiungerlo allarga le
                      // pillole, la striscia si sposta sotto il cursore e il
                      // rilascio finisce nel vuoto fra una e l'altra. `outline`
                      // non occupa spazio.
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '6px 13px', borderRadius: 10, cursor: 'pointer', background: sel ? 'var(--ink)' : dropTarget ? 'var(--surface)' : 'transparent', color: sel ? '#fff' : 'var(--ink)', border: 'none', outline: dropTarget ? '1.5px dashed var(--clay)' : 'none', outlineOffset: -2, transition: 'background 150ms' }}>
                      <span style={{ fontSize: 10.5, fontWeight: 600, opacity: sel ? 0.7 : 0.5 }}>{t(DOW_IT[i], DOW_EN[i])}</span>
                      <span className="t-num" style={{ fontSize: 17, color: sel ? '#fff' : 'var(--ink)' }}>{d.getDate()}</span>
                    </button>
                  );
                })}
              </div>
              {!isToday && <button className="dk-btn dk-btn--soft" style={{ height: 40 }} onClick={() => setDate(todayStr())}>{t('Oggi', 'Today')}</button>}
            </React.Fragment>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ position: 'relative' }}>
                <button onClick={() => setJumpOpen((o) => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: 'var(--serif)', fontSize: 21, fontWeight: 500, color: 'var(--ink)' }}>
                  {periodLabel(calView, date, weekDays, MONTHS)}
                  <Icon name="chevD" size={16} color="var(--muted)" style={{ transform: jumpOpen ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} />
                </button>
                {jumpOpen && <JumpPopover t={t} MONTHS={MONTHS} curM={cur.getMonth()} curY={cur.getFullYear()} onClose={() => setJumpOpen(false)} onMonth={jumpToMonth} onDate={jumpToDate} />}
              </div>
              {!isToday && <button className="dk-btn dk-btn--soft" style={{ height: 36 }} onClick={() => setDate(todayStr())}>{t('Oggi', 'Today')}</button>}
            </div>
          )}
          <SalonHoursChip settings={settings} date={date} t={t} isOwner={!!session?.is_owner} onOpen={() => { setDeepLink && setDeepLink('hours'); setTab('impostazioni'); }} />
          <div style={{ flex: 1, minWidth: 0 }} />
          {canWrite && (
            <React.Fragment>
              {/* Torna indietro. Sta qui, sempre allo stesso posto, e non compare
                * e scompare: chi ha appena sbagliato un gesto deve trovarlo dove
                * si aspetta, non cercarlo. Spento quando non c'è niente da
                * annullare, con l'ultima azione scritta nel suggerimento. */}
              <button
                className="dk-btn dk-btn--soft"
                style={{ height: 40, flexShrink: 0, opacity: undoStack.length && !undoing ? 1 : 0.4, cursor: undoStack.length && !undoing ? 'pointer' : 'default' }}
                disabled={!undoStack.length || undoing}
                onClick={() => undoLast(undoStack[0]?.id)}
                aria-label={t('Torna indietro', 'Undo')}
                title={(undoStack[0]
                  ? t(`Torna indietro · ${undoStack[0].label}`, `Undo · ${undoStack[0].label}`)
                  : t('Niente da annullare', 'Nothing to undo')) + '  (⌘Z)'}
              >
                <Icon name="undo" size={16} />{t('Indietro', 'Undo')}
              </button>
              <button className="dk-btn dk-btn--soft" style={{ height: 40, flexShrink: 0 }} onClick={() => setGroupOpen(true)} title={t('Prenota più clienti insieme', 'Book several clients together')}>
                <Icon name="clients" size={16} />{t('Gruppo', 'Group')}
              </button>
            </React.Fragment>
          )}
          {/* Zoom: quanto è alta un'ora sullo schermo. Sta accanto al selettore
              di vista perché è la stessa famiglia di gesti — «quanto ne vedo».
              Nel mese non ha senso: lì non c'è una linea del tempo da stirare,
              e il comando sparisce invece di restare lì a non fare niente. */}
          {calView !== 'month' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 12, padding: 4, flexShrink: 0 }}>
              <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 17, fontWeight: 700, lineHeight: 1 }} disabled={zoom <= ZOOM_MIN + 0.001}
                onClick={() => setZoom((z) => zoomStep(z, -1))} title={t('Rimpicciolisci: più ore sullo schermo (tasto −, o ⌘ e rotella)', 'Zoom out: more hours on screen (− key, or ⌘ and wheel)')} aria-label={t('Rimpicciolisci', 'Zoom out')}>−</button>
              <button onClick={() => setZoom(1)} title={t('Torna alla scala normale (0)', 'Back to normal scale (0)')}
                className="tabnum" style={{ minWidth: 44, padding: '0 4px', height: 30, borderRadius: 9, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: Math.abs(zoom - 1) < 0.01 ? 'var(--muted)' : 'var(--ink)' }}>
                {Math.round(zoom * 100)}%
              </button>
              <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 17, fontWeight: 700, lineHeight: 1 }} disabled={zoom >= ZOOM_MAX - 0.001}
                onClick={() => setZoom((z) => zoomStep(z, 1))} title={t('Ingrandisci: ore più alte, si leggono i quarti (tasto +, o ⌘ e rotella)', 'Zoom in: taller hours, quarters readable (+ key, or ⌘ and wheel)')} aria-label={t('Ingrandisci', 'Zoom in')}>+</button>
              <button onClick={fitZoom} style={{ height: 30, padding: '0 9px', borderRadius: 9, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--ink-2)' }}
                title={t('Adatta: tutta la giornata in una schermata, senza scorrere', 'Fit: the whole day in one screen, no scrolling')}>{t('Adatta', 'Fit')}</button>
            </div>
          )}
          {/* view selector: Giorno / Settimana / Mese */}
          <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 12, padding: 4, flexShrink: 0 }}>
            {[['day', 'Giorno', 'Day'], ['week', 'Settimana', 'Week'], ['month', 'Mese', 'Month']].map(([v, it, en]) => {
              const sel = calView === v;
              return <button key={v} onClick={() => setCalView(v)} style={{ padding: '8px 15px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', background: sel ? 'var(--ink)' : 'transparent', color: sel ? '#fff' : 'var(--ink)', transition: 'all 140ms' }}>{t(it, en)}</button>;
            })}
          </div>
        </div>

        {/* body — day / week / month */}
        {calView === 'week' ? (
          <React.Fragment>
            {pickBanner}
            <WeekView weekStart={toDateStr(monday)} operators={operators} colorOf={colorOf} itemColor={itemColor} nowMin={isTodayInWeek(weekDays) ? nowMin : null} onOpenDay={openDay} onNewAppt={pickNewAppt} onOpenAppt={openApptDetail} pickMode={pickMode} undoMark={undoMark} undoAfter={undoAfter} ghost={ghostAppt} ghostDate={date} zoom={zoom} onZoom={setZoom} />
          </React.Fragment>
        ) : calView === 'month' ? (
          <MonthView anchor={date} onOpenDay={openDay} />
        ) : (
          <React.Fragment>
            {/* staff visibility filter chips */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 26px', borderBottom: '1px solid var(--hair)', overflowX: 'auto' }}>
              <span className="t-meta" style={{ flexShrink: 0 }}>{t('Calendari', 'Calendars')}</span>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'nowrap' }}>
                {operators.map((o) => {
                  const on = vis[o.id] !== false;
                  const col = colorOf(o.id);
                  return (
                    <button key={o.id} onClick={() => toggleVis(o.id)} aria-pressed={on} title={`${o.first_name} ${o.last_name}`.trim() + (o.role_title ? ' · ' + o.role_title : '') + ' · ' + (on ? t('visibile', 'shown') : t('nascosta', 'hidden'))} className={'dk-pill dk-pill--tint' + (on ? ' dk-pill--on' : ' dk-pill--muted')} style={{ '--pill-c': col, padding: '4px 11px 4px 5px', flexShrink: 0 }}>
                      <Avatar initials={o.initials} size={24} color={col} ring={on} />
                      <span>{opDisplay(o.first_name, o.last_name, opFirsts)}</span>
                      <Icon name={on ? 'check' : 'plus'} size={13} stroke={2.6} color={on ? 'var(--ink)' : 'var(--muted-2)'} />
                    </button>
                  );
                })}
              </div>
              <div style={{ flex: 1, minWidth: 8 }} />
              <span className="t-sm tabnum" style={{ color: 'var(--muted)', fontWeight: 600, flexShrink: 0 }}>{visCount}/{operators.length}</span>
              <button className="dk-btn dk-btn--soft" style={{ height: 32, fontSize: 12.5, flexShrink: 0 }} onClick={() => setAll(!allOn)}>{allOn ? t('Deseleziona', 'Clear') : t('Tutte', 'All')}</button>
            </div>

            {pickBanner}
            {dayData === null ? (
              <DaySkeleton />
            ) : (
              <DayGrid
                rows={visibleRows}
                ghost={ghostAppt}
                scrollMemo={dayScroll}
                zoom={zoom}
                onZoom={setZoom}
                allRows={allRows}
                date={date}
                pickMode={pickMode}
                nowMin={isToday ? nowMin : null}
                colorOf={colorOf}
                itemColor={itemColor}
                pending={pending}
                canWrite={canWrite}
                showRevenue={showRevenue}
                picker={picker}
                setPicker={setPicker}
                setOpColor={setOpColor}
                opPalette={opPalette}
                onHover={onHover}
                onLeave={() => setHover(null)}
                onOpenAppt={(a) => openApptDetail(a)}
                onInvalidDrop={onInvalidDrop}
                onDropOnDate={moveApptToDate}
                onDragChange={setDragOn}
                onSplitItem={splitItem}
                onSlotMenu={(opId, startMin, x, y, verdict, extra) => {
                  if (!canWrite) { noWrite(); return; }
                  if (pickMode) { setAgendaPick({ operatorId: opId, start: isoAtMin(date, startMin), date }); return; }
                  // `ghostHit`: il clic è caduto sull'ombra dell'appuntamento aperto
                  setSlotMenu({ opId, startMin, x, y, verdict, ghostHit: !!extra?.ghostHit });
                }}
                onMoveAppt={moveAppt}
                onResizeItem={resizeItem}
                onMovePause={movePause}
                onResizePause={resizePause}
                onDeletePause={deletePause}
              />
            )}
          </React.Fragment>
        )}
      </div>

      {/* right rail — collapsible */}
      {railOpen ? (
        <aside className="dk-rail" style={{ width: 'var(--rail-w)', flexShrink: 0, borderLeft: '1px solid var(--hair)', background: 'var(--paper)', overflowY: 'auto', padding: '14px 22px 22px' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button className="dk-rail-toggle" onClick={() => setRailOpen(false)} title={t('Comprimi pannello', 'Collapse panel')} style={{ width: 30, height: 30, border: 'none' }}><Icon name="chevR" size={16} /></button>
          </div>
          <RightRail
            summary={summary}
            waitlist={waitlist}
            released={released}
            onRestore={(a) => restoreReleased(a)}
            onRebook={(a) => openNewAppt({ clientId: a.client?.id, clientName: a.client?.full_name, serviceIds: (a.items || []).map((i) => i.service_id), date })}
            onOpenAppt={(a) => openApptDetail(a)}
            onOpenLog={() => { setDeepLink && setDeepLink('log-today'); setTab('impostazioni'); }}
            onOpenWaitlist={() => openModal('waitlist')}
            onOpenOpportunity={() => openModal('opportunity')}
          />
        </aside>
      ) : (
        <aside style={{ width: 52, flexShrink: 0, borderLeft: '1px solid var(--hair)', background: 'var(--paper)', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 14, gap: 4 }}>
          <button className="dk-rail-toggle" onClick={() => setRailOpen(true)} title={t('Espandi pannello', 'Expand panel')} style={{ width: 30, height: 30, border: 'none' }}><Icon name="chevL" size={16} /></button>
          <Icon name="calendar" size={18} color="var(--muted-2)" style={{ marginTop: 10 }} />
        </aside>
      )}

      {hover && <ApptHoverCard hover={hover} t={t} lang={lang} operators={operators} colorOf={colorOf} />}

      {/* slot menu — new appointment / add break */}
      {slotMenu && (
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
                  <button className="dk-btn dk-btn--clay" style={{ flex: 1, minWidth: 0, height: 36, padding: '0 6px', boxSizing: 'border-box' }} onClick={() => addBreak(slotMenu.opId, slotMenu.startMin, slotMenu.dur || BREAK_DEFAULT_MIN)}><Icon name="check" size={15} color="#fff" />{t('Aggiungi', 'Add')}</button>
                </div>
              </div>
            ) : (
              <React.Fragment>
                {/* Col dettaglio aperto, il primo gesto è spostare QUELLA
                    cliente: si sfogliano i giorni dal pannello e si clicca lo
                    spazio giusto, senza passare da nessun'altra schermata. */}
                {openAppt && (
                  <button className="dk-row" onClick={() => moveOpenApptHere(openAppt, slotMenu)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, textAlign: 'left', border: 'none', background: 'transparent' }}>
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="calendar" size={15} color="var(--clay-ink)" /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t(`Sposta qui ${firstName(openAppt.client?.full_name)}`, `Move ${firstName(openAppt.client?.full_name)} here`)}</div>
                      <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{t(`da ${fmtDateIt(toDateStr(openAppt.start), { weekday: false })} ${timeLabel(aStartMin(openAppt))}`, `from ${fmtDateIt(toDateStr(openAppt.start), { weekday: false })} ${timeLabel(aStartMin(openAppt))}`)}</div>
                    </div>
                  </button>
                )}
                <button className="dk-row" onClick={() => { const m = slotMenu; setSlotMenu(null); openNewAppt({ operatorId: m.opId, start: isoAtMin(date, m.startMin), date }); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, textAlign: 'left', border: 'none', background: 'transparent' }}>
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
      )}

      {/* #6 — prenotazione di gruppo: drawer con l'agenda visibile per scaglionare gli slot */}
      {groupOpen && (
        <GroupBookingDrawer date={date} onClose={() => setGroupOpen(false)} onCreated={refetchAll} />
      )}
    </div>
  );
}
