// DayGrid — la giornata, una colonna per operatrice, sulla fascia oraria del
// giorno (orari del centro e turni, allargata per quello che c'è: vedi
// dayGridRange; non più fissa 08:00–20:00).
// Ogni SERVIZIO di una visita è un blocco a sé, nella colonna della sua operatrice,
// all'orario concatenato dallo start della visita, colorato per categoria di servizio.
// Drag di un blocco = sposta QUEL servizio, da solo: un'operatrice in ritardo
// passa un trattamento alla collega senza altri passaggi. Per muovere tutta la
// visita insieme si trascina la spina scura sul bordo sinistro, che è lì a
// mostrare quali blocchi sono la stessa visita. Trascinando il bordo inferiore
// si modifica la durata di QUEL servizio. Le pause restano blocchi
// spostabili/ridimensionabili.
//
// Feedback durante il drag: traccia tratteggiata dell'origine, colonna di
// destinazione evidenziata, badge con orario di arrivo. Niente indicatore al
// passaggio del mouse: chi lavora in salone conosce i propri orari, e la
// striscia sotto il cursore era solo rumore su una griglia già piena.
import { useEffect, useRef } from 'react';
import { useDash } from '../../ctx.jsx';
import {
  PXM, COLW, DAY_HOURS_W, aStartMin, firstName, itemBlocks, explainSlot, gridMarks,
  ghostBlockAt, dayGridRange, openingFor, slotStep, openApptIdOf,
} from './lib.js';
import {
  dayDragContext, opFirstName, visitVerdict, validateDrag, bestSnap, snapStart, resizeStep, dragDy, dropIntent,
  itemPosition, pausePosition, verdictTone,
} from './lib/drag.js';
import { useGridZoom } from './hooks/useGridZoom.js';
import { useScrollMemo } from './hooks/useScrollMemo.js';
import { useGridDrag } from './hooks/useGridDrag.js';
import OperatorHeaderCell from './grid/OperatorHeaderCell.jsx';
import HourGutter from './grid/HourGutter.jsx';
import GridLines from './grid/GridLines.jsx';
import NowLine from './grid/NowLine.jsx';
import ClosedHours from './grid/ClosedHours.jsx';
import GhostBlocks from './grid/GhostBlocks.jsx';
import VisitBlocks from './grid/VisitBlocks.jsx';
import PauseBlock from './grid/PauseBlock.jsx';
import DayDragBadge from './grid/DayDragBadge.jsx';

export default function DayGrid({
  rows, allRows, date, nowMin, colorOf, itemColor, pending, canWrite, showRevenue,
  picker, setPicker, setOpColor, opPalette, pickMode, ghost, zoom = 1, onZoom, scrollMemo,
  onHover, onLeave, onOpenAppt, onSlotMenu, onInvalidDrop, onDropOnDate, onDragChange, onSplitItem,
  onMoveAppt, onResizeItem, onMovePause, onResizePause, onDeletePause,
}) {
  const { t, lang, settings, modal, operators: allOperators, services: allServices } = useDash();
  /* Appuntamento aperto nel pannello di dettaglio: il suo blocco resta cerchiato
   * in agenda, così si vede sempre su cosa si sta intervenendo. */
  const openApptId = openApptIdOf(modal);
  const step = slotStep(settings);   // granularità fasce orarie (Impostazioni)
  const scrollRef = useRef(null);
  const headRef = useRef(null);                      // intestazione fissa delle operatrici
  const onUpRef = useRef(null);                      // ultimo onUp (chiusura fresca) per il rilascio su window

  // px per minuto alla scala scelta da chi guarda (zoom personale)
  const pxm = PXM * (zoom || 1);
  /* Fascia oraria del giorno (12-04): orari del centro e turni, allargata per
   * appuntamenti, pause e l'ombra dell'appuntamento aperto (vedi dayGridRange).
   * Prima era fissa 08–20. */
  const { start: G0, end: G1 } = dayGridRange(allRows || rows, openingFor(settings, date), ghost);
  const marks = gridMarks(step, G0, G1);             // ora piena / mezz'ora / quarti (solo passo 15)
  const gridH = (G1 - G0) * pxm;
  /* `rows` = le colonne da disegnare (le operatrici spente nel filtro «Team» non ci
   * sono). `dataRows` = TUTTE le righe del giorno: i conti vanno fatti su
   * quelle, perché un appuntamento è elencato una volta sola nella riga
   * dell'operatrice principale mentre i suoi servizi possono essere di altre.
   * Con i soli dati visibili, spegnere un'operatrice nascondeva il lavoro delle
   * colleghe dentro le visite rimaste e faceva dire «Disponibile» a uno slot
   * occupato — ci si prenotava sopra davvero. */
  const dataRows = allRows || rows;
  const ops = rows.map((r) => r.operator);
  // primo servizio dell'ombra che cade in una colonna disegnata: lì va «qui»
  const ghostFirstId = ghost ? (itemBlocks(ghost).find((b) => ops.some((o) => o.id === b.opId))?.item.id ?? null) : null;
  const opFirsts = ops.map((o) => firstName(o.name)); // disambiguazione omonimie
  /* I conti del trascinamento (lib/drag.js: aggancio ai vicini, esito del
   * rilascio, abilitazione al servizio) si fanno su `dataRows`. */
  const dragCtx = dayDragContext({ rows: dataRows, operators: allOperators, step, nowMin, t });
  const { blocks: allBlocks, pauses: allPauses } = dragCtx;
  const opName = (opId) => opFirstName(dragCtx, opId);
  /* La fascia tratteggiata sotto un servizio è la posa del listino oppure
   * l'attesa che il salone ha lasciato di proposito prima del trattamento
   * dopo: chiamarla «POSA» in tutti e due i casi faceva cercare un colore che
   * non c'era. */
  const soakLabel = (item) => (
    ((allServices || []).find((s) => s.id === item.service_id)?.soak_min || 0) >= (item.soak_min || 0)
      ? t('POSA', 'SOAK')
      : t('ATTESA', 'WAIT')
  );

  // Zoom: cambiando scala lo stesso minuto resta dov'era; ⌘/ctrl + rotella e pinch
  useGridZoom({ scrollRef, zoom, onZoom, g0: G0, bodySelector: '.dk-tl-cols' });
  /* Sfogliando i giorni la griglia si rimonta (scheletro mentre carica): il
   * minuto in cima si ricorda in `scrollMemo`, che vive nella sezione e
   * sopravvive al rimontaggio, e l'ombra fuori vista si porta in vista. */
  const rememberScroll = useScrollMemo({ scrollRef, headRef, memo: scrollMemo, g0: G0, pxm, ghost, dayKey: date, initialMin: nowMin != null && nowMin > G0 && nowMin < G1 ? nowMin - 60 : null });
  function onGridScroll() {
    rememberScroll();
    onDragScroll();
  }

  /* Il trascinamento (drag.current mutabile, Esc che lo annulla): alla fine la
   * striscia dei giorni torna normale (onDragChange). Come in settimana,
   * pointerup e pointercancel si ascoltano anche su window (onUpRef =
   * l'ultimo onUp): dove la cattura del puntatore non è supportata o si
   * perde, il rilascio fuori dalla griglia non arrivava a nessuno e il blocco
   * restava attaccato al puntatore (bug sospetti del 24/09, n. 51). */
  const { drag, justDragged, force, otherPointer, endDrag, onCancel, markDropped, startGesture } = useGridDrag({ onStop: onDragChange, windowUpRef: onUpRef });

  /* Aprendo il dettaglio, il suo blocco viene portato in vista: può stare a
   * un'ora che in quel momento non è sullo schermo, e il contesto serviva
   * proprio lì. */
  useEffect(() => {
    if (!openApptId) return;
    const el = scrollRef.current?.querySelector(`[data-appt="${openApptId}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [openApptId]);

  /* Operatrice sotto il puntatore, o null se si è usciti dalla griglia.
   * Senza il null (prima si "agganciava" alla colonna di bordo) trascinare
   * fuori per annullare riassegnava l'appuntamento alla prima o all'ultima
   * operatrice, e il rilascio partiva davvero. */
  function colFromX(clientX) {
    const grid = scrollRef.current?.querySelector('.dk-tl-cols');
    if (!grid || !ops.length) return null;
    const r = grid.getBoundingClientRect();
    if (clientX < r.left || clientX >= r.right) return null;
    const colW = r.width / ops.length;
    const idx = Math.max(0, Math.min(ops.length - 1, Math.floor((clientX - r.left) / colW)));
    return ops[idx].id;
  }

  /* Il punto cade nella parte di griglia che si vede davvero? Le colonne, sotto
   * l'intestazione fissa delle operatrici e a destra della colonna delle ore.
   * Fuori da qui il puntatore non indica né un'ora né un'operatrice. */
  function inGrid(x, y) {
    const el = scrollRef.current;
    const cols = el?.querySelector('.dk-tl-cols');
    if (!el || !cols) return false;
    const v = el.getBoundingClientRect();
    const c = cols.getBoundingClientRect();
    const head = headRef.current?.getBoundingClientRect();
    const left = Math.max(c.left, v.left + DAY_HOURS_W), right = Math.min(c.right, v.right);
    const top = Math.max(c.top, head ? head.bottom : v.top), bottom = Math.min(c.bottom, v.bottom);
    return x >= left && x < right && y >= top && y < bottom;
  }

  /** Giorno della striscia sotto (x, y), con un margine di tolleranza. La
   *  pillola del giorno a video non conta: le forbici lasciate lì creavano un
   *  appuntamento a parte alla stessa ora, spezzando la visita. */
  function dropDate(x, y) {
    let best = null;
    document.querySelectorAll('[data-daydrop]').forEach((el) => {
      const iso = el.getAttribute('data-daydrop');
      if (iso === date) return;
      const r = el.getBoundingClientRect();
      const pad = 4;   // le pillole sono piccole: un po' di margine aiuta la mira
      if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) {
        best = iso;
      }
    });
    return best;
  }

  /* Un secondo dito sul tablet non prende il trascinamento in corso: si
   * tiene il puntatore che ha cominciato (pointerId, vedi otherPointer) e i
   * suoi soli eventi; `startScroll` serve a seguire la rotella (vedi track). */
  function beginDrag(e, d) {
    if (e.isPrimary === false) return false;
    startGesture();
    drag.current = { ...d, cx: e.clientX, cy: e.clientY, pointerId: e.pointerId, startScroll: scrollRef.current?.scrollTop || 0 };
    try { scrollRef.current?.setPointerCapture?.(e.pointerId); } catch { /* non supportato */ }
    return true;
  }

  // Drag di un blocco-servizio → muove QUEL servizio e basta.
  // Prima muoveva tutta la visita e per spostarne uno solo bisognava prima
  // capire le forbici, poi staccare, poi spostare: tre gesti per la cosa più
  // frequente della giornata (l'operatrice è in ritardo, un trattamento passa
  // alla collega). Ora il singolo servizio è il caso normale e la visita
  // intera si muove dalla spina (`whole`), che è anche il segno di cosa tiene
  // insieme i blocchi.
  function onItemDown(e, block, { whole = false } = {}) {
    if (!canWrite) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Con un servizio solo «staccare» non vuol dire niente: è la visita.
    const detach = !whole && (block.appt.items || []).length > 1;
    beginDrag(e, {
      kind: 'item', apptId: block.apptId, itemId: block.item.id, block, detach,
      startY: e.clientY, orig: block.startMin, origOp: block.opId,
      apptStart: aStartMin(block.appt), ns: block.startMin, nop: block.opId, moved: false,
    });
  }
  // Trascinamento bordo inferiore → durata di QUEL servizio
  function onItemResizeDown(e, block) {
    if (!canWrite) return;
    e.preventDefault(); e.stopPropagation();
    beginDrag(e, {
      kind: 'item', mode: 'resize', apptId: block.apptId, itemId: block.item.id, block,
      startY: e.clientY, orig: block.startMin, origDur: block.activeMin, ndur: block.activeMin, moved: false,
    });
  }
  function onPauseDown(e, pause) {
    if (!canWrite) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    beginDrag(e, {
      kind: 'pause', id: pause.id, obj: pause, startY: e.clientY,
      orig: aStartMin(pause), origOp: pause.operator_id, ns: aStartMin(pause), nop: pause.operator_id, moved: false,
    });
  }
  function onPauseResizeDown(e, pause) {
    if (!canWrite) return;
    e.preventDefault(); e.stopPropagation();
    beginDrag(e, {
      kind: 'pause', mode: 'resize', id: pause.id, obj: pause, startY: e.clientY,
      orig: aStartMin(pause), origDur: pause.duration_min, ndur: pause.duration_min, moved: false,
    });
  }

  function onMove(e) {
    const d = drag.current;
    if (!d || otherPointer(e)) return;
    d.cx = e.clientX; d.cy = e.clientY;
    track(d);
  }
  /* Scorrendo la griglia (rotella) durante un trascinamento il puntatore non si
   * muove, ma sotto di lui passa un altro orario: i minuti si ricalcolano
   * anche da qui. Prima venivano solo da clientY − startY e il blocco si
   * staccava dal puntatore. */
  function onDragScroll() {
    const d = drag.current;
    if (d) track(d);
  }
  function startedMoving() {
    document.body.classList.add('dk-dragging');
    onLeave && onLeave();
    onDragChange && onDragChange(true);
  }

  /* Posizione del trascinamento: dal puntatore (d.cx, d.cy) più quanto è
   * scorsa la griglia da quando è cominciato (dragDy). */
  function track(d) {
    const dy = dragDy(d, scrollRef.current?.scrollTop || 0);
    if (d.mode === 'resize') {
      // la durata nuova: passi di 5 minuti, aggancio al vicino, mai oltre la mezzanotte
      Object.assign(d, resizeStep(dragCtx, d, dy, pxm));
      force((x) => x + 1);
      return;
    }
    const wasMoved = d.moved;
    /* Fuori dalla griglia che si vede (sopra la striscia dei giorni, fra la
     * striscia e la griglia, sull'intestazione, fuori dal riquadro) non c'è né
     * un'ora né una colonna: il blocco resta al suo posto e il badge dice cosa
     * farà il rilascio — su una pillola «stesso orario, quel giorno», altrove
     * niente. Prima ora e colonna venivano dal dy e dalla sola X: sopra la
     * pillola di giovedì il badge diceva «08:00 · Giulia · Fuori turno», e un
     * rilascio fra la striscia e la griglia spostava davvero (forzato) all'ora
     * schiacciata in cima e alla colonna sotto la X. */
    if (!inGrid(d.cx, d.cy)) {
      d.outside = true;
      d.dayTarget = d.kind === 'item' ? dropDate(d.cx, d.cy) : null;
      d.ns = d.orig; d.nop = d.origOp; d.snap = null; d.verdict = null;
      d.moved = true;
      if (!wasMoved) startedMoving();
      force((x) => x + 1);
      return;
    }
    d.outside = false; d.dayTarget = null;
    const rawMin = d.orig + dy / pxm;
    const nop = colFromX(d.cx) ?? d.origOp;
    const { ns, snap } = snapStart(rawMin, step, bestSnap(dragCtx, rawMin, d, nop), G0, G1);
    d.snap = snap;
    d.ns = ns; d.nop = nop;
    d.moved = d.moved || Math.abs(dy) > 4 || nop !== d.origOp;
    if (d.moved && !wasMoved) startedMoving();
    if (d.moved) d.verdict = validateDrag(dragCtx, d);
    force((x) => x + 1);
  }

  function onUp(e) {
    if (otherPointer(e)) return;   // si solleva un altro dito: il trascinamento continua
    const d = endDrag();
    if (!d) return;
    if (d.mode === 'resize') {
      if (d.moved && d.ndur !== d.origDur) {
        if (d.kind === 'item') onResizeItem(d.block.appt, d.block.item, d.ndur);
        else onResizePause(d.obj, d.ndur);
      }
      return;
    }
    if (!d.moved) {
      // click semplice: apre il dettaglio (il click nativo è soppresso per non
      // aprirlo anche dopo un vero trascinamento)
      if (d.kind === 'item') { onLeave && onLeave(); onOpenAppt(d.block.appt); }
      return;
    }
    markDropped();   // il click nativo che segue non apre niente
    // Fuori dalla griglia conta solo una pillola della striscia; altrove il
    // rilascio annulla (vedi track).
    if (!d.outside) { commitDrop(d); return; }
    // Rilascio sopra la striscia dei giorni: in vista giorno non esiste un'altra
    // colonna dove portare l'appuntamento, e spostarlo a domani voleva dire
    // aprirlo e passare da «Riprogramma». I giorni in alto fanno da bersaglio.
    // Il bersaglio si cerca confrontando i rettangoli, non con elementFromPoint:
    // quello restituisce ciò che sta in cima nel punto esatto, e basta un
    // pixel di stacco fra una pillola e l'altra per farlo cadere nel vuoto.
    const dayTarget = d.kind === 'item' ? dropDate(d.cx, d.cy) : null;
    if (!dayTarget) return;
    if (onSplitItem && d.detach) {
      // Le forbici staccano QUEL servizio, anche quando lo si lascia su un
      // altro giorno: il controllo sul bersaglio «giorno» veniva prima di
      // guardare d.detach, e il rilascio sulla pillola spostava l'INTERA
      // visita senza staccare niente (l'avviso diceva pure «Spostato a...»).
      // Orario e operatrice restano quelli di partenza: salendo sulla striscia
      // il cursore esce dalla griglia e non indica né un'ora né una colonna.
      onSplitItem(d.block.appt, d.block.item, d.orig, d.origOp, { dateIso: dayTarget });
      return;
    }
    // Orario ORIGINALE: salendo sulla striscia il cursore esce dalla griglia e
    // l'ora si schiaccerebbe all'inizio del tabellone. Chi trascina su un
    // giorno sta dicendo «stesso orario, altro giorno».
    if (onDropOnDate) onDropOnDate(d.block.appt, dayTarget, d.apptStart);
  }
  onUpRef.current = onUp;

  /* Rilascio dentro la griglia: spostamento, stacco o pausa (vedi dropIntent). */
  function commitDrop(d) {
    const intent = dropIntent(d);
    if (!intent) return;
    const verdict = validateDrag(dragCtx, d);
    if (verdict && !verdict.ok) {
      onInvalidDrop && onInvalidDrop(verdict, d, intent); // i primi due argomenti restano quelli di prima
      return; // il blocco torna al suo posto: nessuna chiamata al server
    }
    if (intent.kind === 'split') onSplitItem(intent.appt, intent.item, intent.startMin, intent.opId);
    else if (intent.kind === 'appt') onMoveAppt(intent.appt, intent.newApptStart, intent.opArg, { fromOp: intent.fromOp });
    else onMovePause(intent.pause, intent.startMin, intent.opId);
  }

  /* Clic su uno spazio libero di una colonna: il menu dello slot all'ora sotto
   * il puntatore, a passi di `step`. */
  function onColumnClick(e, row) {
    const o = row.operator;
    if (e.target !== e.currentTarget) return;
    if (justDragged.current || drag.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = G0 + (e.clientY - rect.top) / pxm;
    /* Clic sull'ombra dell'appuntamento aperto: vuol dire «qui,
     * a quest'ora, con chi lo fa» — cambia solo il giorno. Letto
     * come uno slot qualsiasi, il clic sull'ombra della piega di
     * Giulia faceva partire la visita alle 11 e passava a Giulia
     * anche i servizi di Anna. Il menu mostra l'esito dello
     * spostamento intero, non di un quarto d'ora di quella colonna. */
    const gb = ghostBlockAt(ghost, o.id, raw);
    if (gb) {
      onSlotMenu(o.id, gb.startMin, e.clientX, e.clientY, visitVerdict(dragCtx, ghost, 0, ghost.operator_id, ghost.operator_id), { ghostHit: true });
      return;
    }
    const snapped = Math.max(G0, Math.min(G1 - step, Math.floor(raw / step) * step));
    onSlotMenu(o.id, snapped, e.clientX, e.clientY, explainSlot(row, snapped, step, { nowMin, t, rows: dataRows }));
  }

  /* posizione: ghost del drag attivo > override ottimistico (pending) > valore server */
  const itemPos = (block) => itemPosition(block, drag.current, pending);
  const pausePos = (p) => pausePosition(p, drag.current, pending);

  const d = drag.current;
  const dragging = d && d.moved && d.mode !== 'resize';
  // colonna di arrivo evidenziata: nessuna quando il puntatore è fuori dalla griglia
  const targetOp = dragging && !d.outside ? d.nop : null;

  return (
    <div
      ref={scrollRef} className="scroll" style={{ flex: 1, overflow: 'auto', position: 'relative' }}
      onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel} onScroll={onGridScroll}
    >
      {/* operator header (sticky top) */}
      <div ref={headRef} style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 9, background: 'var(--paper)', gap: 0, paddingTop: 6, borderBottom: '1px solid var(--hair)' }}>
        <div style={{ width: DAY_HOURS_W, flexShrink: 0, position: 'sticky', left: 0, zIndex: 11, background: 'var(--paper)' }} />
        <div style={{ flex: 1, display: 'flex', gap: 6, paddingRight: 4 }}>
          {rows.map((row) => (
            <OperatorHeaderCell
              key={row.operator.id} row={row} col={colorOf(row.operator.id)} isTarget={targetOp === row.operator.id}
              opFirsts={opFirsts} showRevenue={showRevenue} t={t} lang={lang}
              picker={picker} setPicker={setPicker} setOpColor={setOpColor} opPalette={opPalette}
            />
          ))}
        </div>
      </div>

      {/* grid body — `data-span-min`: quanti minuti copre, per «Adatta» */}
      {/* 8 px d'aria sotto l'intestazione: l'etichetta della prima ora (centrata
          sulla sua riga) finiva sotto la testata e si leggeva a metà */}
      <div data-span-min={G1 - G0} style={{ display: 'flex', position: 'relative', height: gridH, marginTop: 8 }}>
        {/* hour gutter (sticky left) */}
        <HourGutter g0={G0} g1={G1} pxm={pxm} variant="day" />
        {/* columns */}
        <div className="dk-tl-cols" style={{ flex: 1, display: 'flex', position: 'relative', gap: 6, paddingRight: 4 }}>
          <GridLines marks={marks} g0={G0} pxm={pxm} />
          {/* passato (solo oggi): velo leggero — non si prenota indietro nel tempo */}
          {nowMin != null && nowMin > G0 && (
            <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: (Math.min(nowMin, G1) - G0) * pxm, background: 'rgba(17,24,39,0.035)', pointerEvents: 'none', zIndex: 3 }} />
          )}
          <NowLine nowMin={nowMin} g0={G0} g1={G1} pxm={pxm} variant="day" />
          {rows.map((row) => {
            const o = row.operator;
            const isTarget = targetOp === o.id;
            const tone = isTarget ? verdictTone(d.verdict) : '';
            return (
              <div
                key={o.id}
                className={isTarget ? (tone === 'warn' ? 'dk-col--target-warn' : 'dk-col--target') : ''}
                onClick={(e) => onColumnClick(e, row)}
                style={{ flex: '1 0 ' + COLW + 'px', position: 'relative', minWidth: 0, borderRadius: '0 0 10px 10px', background: `color-mix(in srgb, ${colorOf(o.id)} 6%, #FFFFFF)`, cursor: canWrite ? (pickMode ? 'pointer' : 'copy') : 'default', transition: 'box-shadow 120ms' }}
              >
                <ClosedHours windows={row.windows} g0={G0} g1={G1} pxm={pxm} t={t} />
                {/* traccia dell'origine durante il drag.
                    Con le forbici si muove UN servizio: la traccia sotto tutti
                    quelli della visita faceva sembrare che partisse tutta,
                    mentre gli altri restano fermi davvero (vedi itemPos). */}
                {dragging && d.kind === 'item' && itemBlocks(d.block.appt).filter((b) => b.opId === o.id && (!d.detach || b.item.id === d.itemId)).map((b) => (
                  <div key={'g' + b.item.id} className="dk-drag-ghost" style={{ top: (b.startMin - G0) * pxm + 1.5, height: b.dur * pxm - 3 }} />
                ))}
                {dragging && d.kind === 'pause' && d.origOp === o.id && (
                  <div className="dk-drag-ghost" style={{ top: (d.orig - G0) * pxm + 1.5, height: d.obj.duration_min * pxm - 3 }} />
                )}
                {/* l'ombra dell'appuntamento aperto nel pannello (vedi GhostBlocks) */}
                {ghost && <GhostBlocks ghost={ghost} opId={o.id} firstId={ghostFirstId} g0={G0} pxm={pxm} t={t} />}
                {/* servizi nelle loro corsie, con la spina di ogni visita (vedi VisitBlocks) */}
                <VisitBlocks
                  opId={o.id} blocks={allBlocks} itemPos={itemPos} g0={G0} pxm={pxm} t={t} lang={lang} canWrite={canWrite}
                  dragging={dragging} openApptId={openApptId} itemColor={itemColor} colorOf={colorOf} soakLabel={soakLabel}
                  onItemDown={onItemDown} onItemResizeDown={onItemResizeDown} onHover={onHover} onLeave={onLeave}
                  onSlotMenuAt={(startMin, x, y) => onSlotMenu(o.id, startMin, x, y, explainSlot(row, startMin, step, { nowMin, t, rows: dataRows }))}
                />
                {/* pauses */}
                {allPauses.filter((p) => pausePos(p).opId === o.id).map((p) => {
                  const pos = pausePos(p);
                  return (
                    <PauseBlock
                      key={'p' + p.id} pxm={pxm} g0={G0} p={p} startMin={pos.startMin} dur={pos.dur ?? p.duration_min} dragging={pos.dragging} tone={pos.dragging ? verdictTone(pos.verdict) : ''} t={t} lang={lang}
                      canWrite={canWrite}
                      onDown={(e) => onPauseDown(e, p)}
                      onResizeDown={(e) => onPauseResizeDown(e, p)}
                      onRemove={() => onDeletePause(p)}
                    />
                  );
                })}
              </div>
            );
          })}
          {!rows.length && (
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
              <div className="t-sm" style={{ color: 'var(--muted-2)' }}>
                {/* il team c'è ma il filtro lo nasconde tutto: si dice dove riaccenderlo */}
                {(allRows || []).length
                  ? t('Nessuna colonna da mostrare: sceglile dal filtro «Team» in alto', 'No columns to show: pick them from the «Team» filter above')
                  : t('Nessuna operatrice attiva', 'No active staff')}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* badge che segue il cursore durante il drag: orario di arrivo + esito */}
      {dragging && <DayDragBadge d={d} t={t} opName={opName} />}
    </div>
  );
}
