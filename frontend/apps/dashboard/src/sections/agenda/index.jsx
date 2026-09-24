// Agenda — day/week/month calendar wired to /api/agenda/* (port of desktop-agenda.jsx)
// Lo stato e i gesti stanno negli hook (hooks/): che cosa si guarda
// (useAgendaNav), zoom, dati del giorno e della colonna di destra
// (useAgendaData), live, «torna indietro» (useUndo), tasti e gesti che
// scrivono (useAgendaMutations). Qui restano la barra (col filtro «Team»), il
// menu dello slot e il montaggio delle viste.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, toDateStr, todayStr, parseISO } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import {
  MONTHS_IT, MONTHS_EN, hoverPlacement, isoAtMin, mondayOf, weekDaysOf, periodLabel, isTodayInWeek,
  visibleDayRows, restingIds, itemBlocks, HOVER_CLEAR_DAY, LIVE_DEBOUNCE_DAY_MS,
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
import TeamFilter from './parts/TeamFilter.jsx';
import PickBanner from './parts/PickBanner.jsx';
import RailPanel from './parts/RailPanel.jsx';
import SlotMenu from './parts/SlotMenu.jsx';
import WeekView from './WeekView.jsx';
import MonthView from './MonthView.jsx';
import RightRail from './RightRail.jsx';
import GroupBookingDrawer from './modals/GroupBookingDrawer.jsx';

/* Le frecce della barra dicono dove portano: [indietro it, en, avanti it, en]. */
const NAV_LABELS = {
  day: ['Giorno precedente', 'Previous day', 'Giorno successivo', 'Next day'],
  week: ['Settimana precedente', 'Previous week', 'Settimana successiva', 'Next week'],
  month: ['Mese precedente', 'Previous month', 'Mese successivo', 'Next month'],
};

export default function AgendaSection() {
  const {
    t, lang, operators, services, serviceCategories, hasScope,
    openModal, modal, fireToast, opColors, setOpColor, opPalette,
    setTab, deepLink, setDeepLink, showRevenue, live, setAgendaPick, setAgendaDate, settings, session, locationId,
    toastProps,
  } = useDash();
  const canWrite = hasScope('agenda');
  const noWrite = useCallback(() => fireToast({ msg: t('Il tuo ruolo non ha il permesso “agenda”: puoi solo consultare', 'Your role lacks the “agenda” permission: read only'), icon: 'lock' }), [fireToast, t]);

  /* ---- navigation state ---- */
  const { date, setDate, calView, setCalView, jumpOpen, setJumpOpen, navPrev, navNext, jumpToMonth, jumpToDate, openDay } = useAgendaNav();
  /* Il pannello di destra parte chiuso sugli schermi sotto i 1600 px (finché
   * non lo si apre: poi resta come lo si lascia). Aperto si prendeva 312 px
   * di un portatile, un terzo dell'agenda; chiuso mostra comunque i numeri
   * che chiedono un'azione (vedi RailPanel). */
  const [railOpen, setRailOpen] = useStoredFlag('dk-agenda-rail', typeof window !== 'undefined' && window.innerWidth >= 1600);

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

  /* ---- filtro «Team»: quali colonne, e «Solo chi lavora oggi» ---- */
  const { vis, toggleVis, setAll, only } = useOperatorVisibility(operators);
  const [onlyWorking, setOnlyWorking] = useStoredFlag('dk-agenda-only-working');

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
  /* «Prenotazione di gruppo» sta nel menu di «Prenota» in alto, con le altre
   * creazioni: il menu passa di qui (deepLink) perché il drawer vive con
   * l'agenda, che deve restare visibile dietro per scaglionare gli orari. */
  useEffect(() => {
    if (deepLink !== 'group-booking') return;
    setDeepLink(null);
    if (!canWrite) { noWrite(); return; }
    setGroupOpen(true);
  }, [deepLink, setDeepLink, canWrite, noWrite]);
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
  // N, + − 0, ⌘Z; T (oggi), ← → (indietro e avanti), G S M (la vista)
  useAgendaShortcuts({ openNewAppt, date, modal, groupOpen, setZoom, undoLast, goToday: () => setDate(todayStr()), navPrev, navNext, setCalView });

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

  // Nessun fallback "mostra tutte": spegnendo tutto il team la griglia deve
  // restare vuota (lo stato vuoto è già previsto), non riaccendere tutto.
  /* Il filtro «Team» decide quali COLONNE si disegnano, non quali dati esistono: il
   * payload elenca ogni appuntamento una volta sola, nella riga dell'operatrice
   * principale, ma i suoi servizi possono essere di altre. Filtrando anche i
   * dati, spegnere un'operatrice faceva sparire il lavoro delle colleghe rimaste e
   * dichiarava «Disponibile» uno slot occupato davvero. */
  const allRows = dayData || [];
  /* «Solo chi lavora oggi» non nasconde mai la colonna dove cade l'ombra
   * dell'appuntamento aperto nel pannello. */
  const keepOps = ghostAppt ? [...new Set(itemBlocks(ghostAppt).map((b) => b.opId))] : [];
  const visibleRows = visibleDayRows(allRows, vis, { onlyWorking, keep: keepOps });
  const resting = onlyWorking && dayData ? restingIds(allRows, vis, keepOps) : [];

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
        {/* La barra: una riga sola (vedi .dk-agbar in agenda.css). A sinistra
          * dove si è (Oggi, frecce, periodo, giorni), a destra come lo si
          * guarda (team, indietro, zoom, vista). Stretta, prima perde le
          * etichette ripetute nei suggerimenti e solo alla fine va a capo. */}
        <div className="dk-agbar">
          <div className="dk-agbar__group">
            {/* «Oggi» sempre allo stesso posto: compariva solo lontano da oggi e
                spostava tutta la barra al primo clic su un altro giorno */}
            <button type="button" className="dk-agbtn" onClick={() => setDate(todayStr())} aria-current={isToday && calView === 'day' ? 'date' : undefined}
              title={t('Vai a oggi (T)', 'Go to today (T)')}>{t('Oggi', 'Today')}</button>
            <button type="button" className="dk-agicon" onClick={navPrev} aria-label={t(NAV_LABELS[calView][0], NAV_LABELS[calView][1])} title={t(NAV_LABELS[calView][0], NAV_LABELS[calView][1]) + ' (←)'}><Icon name="chevL" size={17} /></button>
            <button type="button" className="dk-agicon" onClick={navNext} aria-label={t(NAV_LABELS[calView][2], NAV_LABELS[calView][3])} title={t(NAV_LABELS[calView][2], NAV_LABELS[calView][3]) + ' (→)'}><Icon name="chevR" size={17} /></button>
            {calView === 'day'
              ? <JumpTitle compact label={MONTHS[cur.getMonth()] + ' ' + cur.getFullYear()} short={MONTHS[cur.getMonth()].slice(0, 3) + ' ' + cur.getFullYear()} {...jumpProps} />
              : <JumpTitle label={periodLabel(calView, date, weekDays, MONTHS)} short={periodLabel(calView, date, weekDays, MONTHS.map((m) => m.slice(0, 3)))} {...jumpProps} />}
          </div>
          {calView === 'day' && <DayStrip weekDays={weekDays} date={date} setDate={setDate} dragOn={dragOn} t={t} />}
          <SalonHoursChip settings={settings} date={date} t={t} isOwner={!!session?.is_owner} onOpen={() => { setDeepLink && setDeepLink('hours'); setTab('impostazioni'); }} />
          <div className="dk-agbar__spacer" />
          <div className="dk-agbar__group">
            {calView === 'day' && (
              <TeamFilter operators={operators} vis={vis} toggleVis={toggleVis} setAll={setAll} only={only} colorOf={colorOf}
                onlyWorking={onlyWorking} setOnlyWorking={setOnlyWorking} resting={resting}
                // mentre la giornata carica non ci sono righe: niente «0/5» di passaggio
                shown={dayData ? visibleRows.length : null} total={dayData ? allRows.length : operators.length} t={t} />
            )}
            {canWrite && <UndoButton undoStack={undoStack} undoing={undoing} undoLast={undoLast} t={t} />}
            {/* Nel mese lo zoom non ha senso: lì non c'è una linea del tempo da
                stirare, e il comando sparisce invece di restare lì a non fare
                niente. */}
            {calView !== 'month' && <ZoomControls zoom={zoom} setZoom={setZoom} fitZoom={fitZoom} t={t} />}
            <ViewSelector calView={calView} setCalView={setCalView} t={t} />
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
      <RailPanel open={railOpen} setOpen={setRailOpen} t={t}
        badges={{ released: (released || []).length, waitlist: (waitlist || []).filter((w) => w.status === 'active' || w.status === 'contacted').length }}>
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
