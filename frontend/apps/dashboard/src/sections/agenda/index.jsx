// Agenda — day/week/month calendar wired to /api/agenda/* (port of desktop-agenda.jsx)
// Lo stato e i gesti stanno negli hook (hooks/): che cosa si guarda
// (useAgendaNav), zoom, dati del giorno e della colonna di destra
// (useAgendaData), live, «torna indietro» (useUndo), tasti e gesti che
// scrivono (useAgendaMutations). Qui restano la barra, le chip, il menu dello
// slot e il montaggio delle viste.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, toDateStr, todayStr, parseISO } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import {
  MONTHS_IT, MONTHS_EN, hoverPlacement, isoAtMin, mondayOf, weekDaysOf, periodLabel, isTodayInWeek,
  HOVER_CLEAR_DAY, LIVE_DEBOUNCE_DAY_MS,
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
import JumpTitle from './parts/JumpTitle.jsx';
import DayStrip from './parts/DayStrip.jsx';
import SalonHoursChip from './parts/SalonHoursChip.jsx';
import UndoButton from './parts/UndoButton.jsx';
import ZoomControls from './parts/ZoomControls.jsx';
import ViewSelector from './parts/ViewSelector.jsx';
import OperatorChips from './parts/OperatorChips.jsx';
import PickBanner from './parts/PickBanner.jsx';
import RailPanel from './parts/RailPanel.jsx';
import SlotMenu from './parts/SlotMenu.jsx';
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

  // il titolo della barra apre il selettore di mese e data (JumpTitle)
  const jumpProps = { open: jumpOpen, setOpen: setJumpOpen, t, MONTHS, cur, onMonth: jumpToMonth, onDate: jumpToDate };

  // Prenotazione aperta: un clic sulla griglia (giorno o settimana) sceglie
  // l'orario. Stava solo in vista giorno, e in settimana il clic apriva un
  // drawer nuovo sopra quello in corso.
  const pickBanner = pickMode ? <PickBanner t={t} /> : null;

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
              <JumpTitle compact label={MONTHS[cur.getMonth()] + ' ' + cur.getFullYear()} {...jumpProps} />
              <DayStrip weekDays={weekDays} date={date} setDate={setDate} dragOn={dragOn} t={t} />
              {!isToday && <button className="dk-btn dk-btn--soft" style={{ height: 40 }} onClick={() => setDate(todayStr())}>{t('Oggi', 'Today')}</button>}
            </React.Fragment>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <JumpTitle label={periodLabel(calView, date, weekDays, MONTHS)} {...jumpProps} />
              {!isToday && <button className="dk-btn dk-btn--soft" style={{ height: 36 }} onClick={() => setDate(todayStr())}>{t('Oggi', 'Today')}</button>}
            </div>
          )}
          <SalonHoursChip settings={settings} date={date} t={t} isOwner={!!session?.is_owner} onOpen={() => { setDeepLink && setDeepLink('hours'); setTab('impostazioni'); }} />
          <div style={{ flex: 1, minWidth: 0 }} />
          {canWrite && (
            <React.Fragment>
              <UndoButton undoStack={undoStack} undoing={undoing} undoLast={undoLast} t={t} />
              <button className="dk-btn dk-btn--soft" style={{ height: 40, flexShrink: 0 }} onClick={() => setGroupOpen(true)} title={t('Prenota più clienti insieme', 'Book several clients together')}>
                <Icon name="clients" size={16} />{t('Gruppo', 'Group')}
              </button>
            </React.Fragment>
          )}
          {/* Nel mese lo zoom non ha senso: lì non c'è una linea del tempo da
              stirare, e il comando sparisce invece di restare lì a non fare
              niente. */}
          {calView !== 'month' && <ZoomControls zoom={zoom} setZoom={setZoom} fitZoom={fitZoom} t={t} />}
          <ViewSelector calView={calView} setCalView={setCalView} t={t} />
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
            <OperatorChips operators={operators} vis={vis} visCount={visCount} allOn={allOn} toggleVis={toggleVis} setAll={setAll} colorOf={colorOf} t={t} />

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
      <RailPanel open={railOpen} setOpen={setRailOpen} t={t}>
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
      </RailPanel>

      {hover && <ApptHoverCard hover={hover} t={t} lang={lang} operators={operators} colorOf={colorOf} />}

      {/* slot menu — new appointment / add break */}
      {slotMenu && (
        <SlotMenu
          slotMenu={slotMenu} setSlotMenu={setSlotMenu} operators={operators} openAppt={openAppt} date={date} t={t}
          onMoveHere={moveOpenApptHere} onNewAppt={openNewAppt} onAddBreak={addBreak}
        />
      )}

      {/* #6 — prenotazione di gruppo: drawer con l'agenda visibile per scaglionare gli slot */}
      {groupOpen && (
        <GroupBookingDrawer date={date} onClose={() => setGroupOpen(false)} onCreated={refetchAll} />
      )}
    </div>
  );
}
