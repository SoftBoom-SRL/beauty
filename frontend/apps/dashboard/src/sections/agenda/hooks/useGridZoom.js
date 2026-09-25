// useGridZoom — lo zoom delle griglie di giorno e settimana: la scala si
// cambia senza perdere il punto in cui si stava guardando, e ⌘/ctrl + rotella
// (o il pinch del trackpad) la cambiano sopra la griglia.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { PXM, WHEEL_ZOOM_FACTOR } from '../constants.js';
import { clampZoom } from '../lib/grid.js';

/** `scrollRef` = il contenitore che scorre; `bodySelector` = un figlio del
 *  corpo della griglia (le colonne), il cui PADRE è il corpo: `.dk-tl-cols`
 *  in giorno, `[data-daycol]` in settimana. `g0` = inizio della fascia oraria
 *  in minuti, `onZoom(fn)` = il setter della sezione (riceve una funzione),
 *  `ready` = la griglia è disegnata (la settimana passa dallo scheletro, che
 *  il contenitore non ce l'ha). */
export function useGridZoom({ scrollRef, zoom, onZoom, g0, bodySelector, ready = true }) {
  /* Cambiando l'altezza dell'ora, lo stesso minuto resta dov'era sullo
   * schermo — sotto il puntatore col pinch, al centro coi pulsanti —
   * altrimenti a ogni scatto ci si ritrova in un'altra parte della giornata. */
  const zoomAnchor = useRef(null);   // { offset } px dal bordo alto dell'area visibile
  const lastZoom = useRef(zoom);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = lastZoom.current;
    if (!el || prev === zoom) return;
    lastZoom.current = zoom;
    // il corpo della griglia è il PADRE delle colonne: le colonne sono
    // posizionate dentro di lui, quindi il loro offsetTop è zero e l'ancoraggio
    // sbagliava di tutta l'altezza dell'intestazione
    const body = el.querySelector(bodySelector)?.parentElement;
    if (!body) return;
    const top0 = body.offsetTop;                       // dove comincia la griglia nel contenuto
    const offset = zoomAnchor.current?.offset ?? el.clientHeight / 2;
    zoomAnchor.current = null;
    const minute = g0 + (el.scrollTop + offset - top0) / (PXM * prev);
    el.scrollTop = (minute - g0) * (PXM * zoom) + top0 - offset;
    // Solo lo zoom sposta lo scroll: g0 (e il resto) si leggono come sono nel
    // render in cui lo zoom è cambiato. In settimana g0 si calcola prima di
    // chiamare questo hook (vedi WeekView).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);
  /* Pinch del trackpad (che arriva come ctrl+rotella) e ⌘/ctrl+rotella: il
   * listener è nativo e NON passivo, altrimenti il browser ingrandisce la
   * pagina intera invece della griglia. Si registra sul contenitore quando la
   * griglia è pronta (`ready`), e di nuovo ogni volta che lo torna: in
   * settimana il primo disegno è lo scheletro, senza contenitore, e anche il
   * cambio di settimana ci passa e rimonta il contenitore. Registrato una
   * volta sola (`onZoom` è stabile) non si agganciava mai, e il pinch
   * ingrandiva tutta la pagina (bug sospetti del 24/09, n. 48). */
  useEffect(() => {
    const el = scrollRef.current;
    if (!ready || !el || !onZoom) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      // con Maiusc è la larghezza delle colonne (useGridWidth)
      if (e.shiftKey) return;
      e.preventDefault();
      zoomAnchor.current = { offset: e.clientY - el.getBoundingClientRect().top };
      // valore precedente dallo stato: il pinch manda una raffica di eventi
      // nello stesso istante, e partendo tutti dallo stesso numero se ne
      // sarebbe sentito uno solo
      onZoom((z) => clampZoom(z * (e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onZoom, scrollRef, ready]);
}
