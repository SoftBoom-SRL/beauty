// useGridDrag — il trascinamento comune a giorno e settimana: lo stato
// mutabile del gesto, Esc che lo annulla, la fine del gesto e il clic da
// sopprimere dopo un rilascio. Dove arriva il blocco e che cosa fa il
// rilascio restano alle viste (lib/drag.js, lib/week.js).
import { useEffect, useRef, useState } from 'react';
import { EDGE_DELAY_FRAMES, edgeSpeed } from '../lib/drag.js';
import { useLatest } from './useLatest.js';

/* Un fotogramma (requestAnimationFrame dove c'è, altrimenti un timer). */
const nextFrame = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
const dropFrame = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

/** `onStop(false)`: chiamato quando il gesto finisce o si annulla con Esc (la
 *  vista giorno spegne la striscia dei giorni). `windowUpRef`: la ref
 *  dell'ultimo onUp della vista; se c'è, pointerup e pointercancel si
 *  ascoltano anche su window, così il trascinamento non resta mai «appeso»
 *  quando la cattura del puntatore non è supportata o il rilascio avviene
 *  fuori dall'area (la passano giorno e settimana). `scrollRef` e `headRef`
 *  = il contenitore che scorre e la sua intestazione fissa, `gutter` = la
 *  larghezza della colonna delle ore: servono allo scorrimento automatico
 *  ai bordi (followEdge).
 *  Ritorna { drag, justDragged, force, otherPointer, endDrag, onCancel, markDropped, startGesture,
 *  followEdge, hoverOk, pointerMoved }. */
export function useGridDrag({ onStop, windowUpRef = null, scrollRef = null, headRef = null, gutter = 0 } = {}) {
  /* Il gesto in corso è un oggetto MUTABILE (drag.current), aggiornato a ogni
   * movimento del puntatore, e `force` ridisegna: tenerlo nello stato
   * vorrebbe dire un oggetto nuovo per ogni pointermove. */
  const drag = useRef(null);
  const justDragged = useRef(false);   // sopprime il click che segue un rilascio
  const [, force] = useState(0);
  const onStopRef = useLatest(onStop);
  /* Scorrimento automatico ai bordi (edgeSpeed): un fotogramma dopo l'altro
   * finché il puntatore resta nella fascia del bordo e la griglia ha ancora
   * da scorrere. Ogni passo fa scattare lo scroll della griglia, e la vista
   * ricalcola dove arriva il blocco (il suo onDragScroll). */
  const edge = useRef({ frame: 0, x: 0, y: 0, wait: 0, dir: '0,0' });
  /* Dove si è lasciato l'ultimo blocco: lì l'anteprima al passaggio del mouse
   * tace finché il puntatore non si muove davvero (vedi hoverOk). */
  const quiet = useRef(null);
  /* Un secondo dito sul tablet non prende il trascinamento in corso: prima lo
   * spostava e al primo sollevamento lo rilasciava. Si tiene il puntatore che
   * ha cominciato (pointerId) e i suoi soli eventi. */
  const otherPointer = (e) => {
    const d = drag.current;
    return !!(d && e && e.pointerId != null && d.pointerId != null && e.pointerId !== d.pointerId);
  };

  /* Smontata a metà gesto (un altro giorno o un'altra vista da tastiera, un
   * aggiornamento che rimonta la griglia): il gesto finisce anche per chi lo
   * guardava da fuori, o la striscia dei giorni restava accesa come bersaglio
   * di un trascinamento che non c'era più. */
  useEffect(() => () => {
    stopEdge();
    document.body.classList.remove('dk-dragging', 'dk-gesture');
    if (drag.current) { drag.current = null; onStopRef.current?.(false); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /* Esc annulla il drag in corso. `preventDefault` è il contratto di
   * ui/layers.js: quell'Esc è del trascinamento, e il pannello di dettaglio
   * aperto sotto non deve chiudersi insieme a lui. In cattura, così arriva
   * prima di chi ascolta su `window` e guarda `defaultPrevented` subito (il
   * drawer della prenotazione). Gli eventi di un altro dito non chiudono il
   * trascinamento (vedi otherPointer). */
  useEffect(() => {
    const cancel = () => {
      settle(drag.current);
      drag.current = null;
      document.body.classList.remove('dk-dragging', 'dk-gesture');
      onStopRef.current?.(false);   // la striscia dei giorni torna normale
      force((x) => x + 1);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape' || !drag.current) return;
      e.preventDefault();
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    if (!windowUpRef) return () => window.removeEventListener('keydown', onKey, true);
    const onWinUp = (e) => { if (drag.current && !otherPointer(e)) windowUpRef.current?.(e); };
    const onWinCancel = (e) => { if (drag.current && !otherPointer(e)) cancel(); };
    window.addEventListener('pointerup', onWinUp);
    window.addEventListener('pointercancel', onWinCancel);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerup', onWinUp);
      window.removeEventListener('pointercancel', onWinCancel);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Il gesto finisce: si toglie e si ridisegna; ritorna quello che c'era. */
  function endDrag() {
    const d = drag.current;
    settle(d);
    drag.current = null;
    document.body.classList.remove('dk-dragging', 'dk-gesture');
    onStop && onStop(false);
    force((x) => x + 1);
    return d;
  }
  function onCancel(e) { if (!otherPointer(e)) endDrag(); }
  /** Dopo un rilascio vero il click che segue non deve aprire niente. */
  function markDropped() {
    justDragged.current = true;
    setTimeout(() => { justDragged.current = false; }, 0);
  }
  /** Un gesto comincia (anche un ridimensionamento, o un trascinamento non
   *  ancora oltre la soglia): `dk-gesture` sul body dice ai tasti dell'agenda
   *  di tacere finché non finisce. `dk-dragging` arriva solo quando il blocco
   *  si muove davvero, e il ridimensionamento non lo accende mai. */
  function startGesture() { document.body.classList.add('dk-gesture'); }

  /** Il gesto `d` finisce (rilascio, Esc, pointercancel): si ferma lo
   *  scorrimento ai bordi e, se il blocco si era mosso, l'anteprima tace dove
   *  il puntatore è rimasto. Il blocco arrivato (o tornato) sotto il
   *  puntatore fermo faceva comparire da sola la scheda, con l'orario di prima
   *  dello spostamento, sopra la griglia appena toccata. */
  function settle(d) {
    stopEdge();
    if (d && d.moved) quiet.current = { x: d.cx, y: d.cy };
  }
  function stopEdge() {
    if (edge.current.frame) dropFrame(edge.current.frame);
    edge.current = { frame: 0, x: 0, y: 0, wait: 0, dir: '0,0' };
  }
  function edgeStep() {
    const e = edge.current;
    e.frame = 0;
    const el = scrollRef?.current;
    if (!el || !drag.current || (!e.x && !e.y)) return;
    // prima un attimo di attesa nella fascia (EDGE_DELAY_FRAMES)
    if (e.wait < EDGE_DELAY_FRAMES) { e.wait += 1; e.frame = nextFrame(edgeStep); return; }
    const top = el.scrollTop || 0, left = el.scrollLeft || 0;
    if (e.y) el.scrollTop = top + e.y;
    if (e.x) el.scrollLeft = left + e.x;
    // arrivati in cima o in fondo: niente più da scorrere, il ciclo si ferma
    if ((el.scrollTop || 0) === top && (el.scrollLeft || 0) === left) return;
    e.frame = nextFrame(edgeStep);
  }
  /** A ogni movimento del trascinamento: il puntatore (cx, cy) è vicino a un
   *  bordo della parte che si vede della griglia? Sotto l'intestazione fissa
   *  e a destra della colonna delle ore; `x: false` = solo in verticale. */
  function followEdge(cx, cy, { x = true } = {}) {
    const el = scrollRef?.current;
    if (!el?.getBoundingClientRect || !drag.current) return;
    const r = el.getBoundingClientRect();
    const inTop = r.top + (el.clientTop || 0), inLeft = r.left + (el.clientLeft || 0);
    const head = headRef?.current?.getBoundingClientRect?.();
    const top = head ? Math.max(inTop, head.bottom) : inTop, bottom = inTop + (el.clientHeight ?? r.height);
    const left = inLeft + gutter, right = inLeft + (el.clientWidth ?? r.width);
    // Il puntatore deve stare nella griglia su tutti e due gli assi: sopra
    // l'intestazione vicino al bordo destro le colonne scorrevano di lato, e
    // sulla colonna delle ore vicino al fondo la griglia scendeva mentre il
    // blocco era già tornato al suo posto («fuori dalla griglia»).
    const e = edge.current;
    e.y = cx >= left && cx <= right ? edgeSpeed(cy, top, bottom) : 0;
    e.x = x && cy >= top && cy <= bottom ? edgeSpeed(cx, left, right) : 0;
    // uscendo dalla fascia, o passando a un altro bordo, l'attesa ricomincia da capo
    const dir = Math.sign(e.x) + ',' + Math.sign(e.y);
    if (dir !== e.dir) { e.wait = 0; e.dir = dir; }
    if (!e.x && !e.y) return;
    if (!e.frame) e.frame = nextFrame(edgeStep);
  }

  /** Si può mostrare l'anteprima di un appuntamento? Non durante un gesto, e
   *  dopo un rilascio non finché il puntatore non si è mosso (pointerMoved). */
  const hoverOk = () => !drag.current && !quiet.current;
  /** Un movimento del puntatore senza gesto in corso: oltre 4 px da dove si è
   *  lasciato il blocco l'anteprima torna. I movimenti «finti» che il browser
   *  manda quando sotto il puntatore fermo cambia il disegno hanno le stesse
   *  coordinate, e non contano. */
  function pointerMoved(e) {
    const q = quiet.current;
    if (q && e && Math.hypot(e.clientX - q.x, e.clientY - q.y) > 4) quiet.current = null;
  }
  return { drag, justDragged, force, otherPointer, endDrag, onCancel, markDropped, startGesture, followEdge, hoverOk, pointerMoved };
}
