// useGridWidth — lo zoom in orizzontale delle griglie di giorno e settimana:
// la larghezza delle colonne (vedi WIDTH_STEPS in constants.js). Cambiandola
// lo stesso punto resta dov'era — sotto il puntatore con la rotella, al
// centro coi pulsanti della barra — e trascinando il bordo di una testata la
// griglia resta ferma e il bordo segue il puntatore, come in un foglio di
// calcolo. ⌘/ctrl + Maiusc + rotella la cambiano sopra la griglia.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { WHEEL_ZOOM_FACTOR } from '../constants.js';
import { clampWidth } from '../lib/grid.js';

/** `scrollRef` = il contenitore che scorre, `width` = la larghezza attuale,
 *  `onWidth(fn | valore)` = il setter della sezione, `gutter` = la colonna
 *  delle ore (ferma a sinistra), `ready` = la griglia è disegnata (la
 *  settimana passa dallo scheletro). Ritorna `gripProps(unit, fixed, onFit)`:
 *  i gestori della maniglia sul bordo destro di una testata, che dalla
 *  colonna delle ore dista `unit` px a larghezza 1 più `fixed` px che non
 *  cambiano (gli spazi fra le colonne); il doppio clic chiama `onFit`. */
export function useGridWidth({ scrollRef, width, onWidth, gutter = 0, ready = true }) {
  /* Dove tenere fermo il contenuto al prossimo cambio: { offset } = px dal
   * bordo sinistro del contenitore, { keep: true } = non toccare lo scroll
   * (maniglia), null = il centro della parte a destra delle ore. */
  const anchor = useRef(null);
  const last = useRef({ width, sw: 0 });
  /* Dopo ogni disegno: se la larghezza è cambiata, il punto ancorato torna
   * dov'era (le colonne crescono tutte insieme: basta la proporzione sulla
   * larghezza del contenuto); poi si misura il contenuto per il giro dopo. */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !ready) return;
    const prev = last.current;
    const sw = el.scrollWidth || 0;
    if (prev.width !== width && prev.sw > gutter && sw > gutter) {
      const a = anchor.current;
      if (!a?.keep) {
        const offset = a?.offset ?? gutter + ((el.clientWidth || 0) - gutter) / 2;
        const f = ((el.scrollLeft || 0) + offset - gutter) / (prev.sw - gutter);
        el.scrollLeft = Math.max(0, f * (sw - gutter) + gutter - offset);
      }
    }
    anchor.current = null;
    last.current = { width, sw };
  });

  /* ⌘/ctrl + Maiusc + rotella: più strette o più larghe, ferme sotto il
   * puntatore. Senza Maiusc la rotella con ⌘/ctrl resta lo zoom in altezza
   * (useGridZoom). Con Maiusc il browser del Mac manda lo scorrimento come
   * orizzontale: conta deltaX quando deltaY è zero. Il listener è nativo e
   * non passivo, come quello dell'altezza. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!ready || !el || !onWidth) return undefined;
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      const d = e.deltaY || e.deltaX;
      if (!d) return;
      e.preventDefault();
      anchor.current = { offset: e.clientX - el.getBoundingClientRect().left };
      onWidth((w) => clampWidth(w * (d < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWidth, scrollRef, ready]);

  /* La maniglia: il bordo segue il puntatore. Il bordo sta a gutter + fixed +
   * unit × larghezza dall'inizio del contenuto (davanti ci sono anche le
   * colonne a sinistra, che cambiano insieme), quindi ogni px di puntatore
   * vale 1 / unit di larghezza. Si parte dalla larghezza VERA della colonna
   * (può essere cresciuta a riempire lo schermo) e si conta lo spostamento
   * del puntatore: ricavandola a ogni movimento dal punto del contenuto sotto
   * il puntatore, in fondo alla griglia lo scorrimento si accorciava da solo
   * col contenuto e le colonne si stringevano a catena fino al minimo. */
  const grip = useRef(null);
  function endGrip(e) {
    const g = grip.current;
    if (!g || (g.id != null && e?.pointerId != null && e.pointerId !== g.id)) return;
    grip.current = null;
    document.body.classList.remove('dk-gesture');
  }
  function gripProps(unit, fixed, onFit) {
    return {
      onPointerDown: (e) => {
        if (!onWidth || (e.button !== undefined && e.button !== 0)) return;
        e.preventDefault();
        e.stopPropagation();
        const el = scrollRef.current;
        const cell = e.currentTarget.parentElement;
        if (!el || !cell) return;
        const edge = cell.getBoundingClientRect().right - el.getBoundingClientRect().left - (el.clientLeft || 0) + (el.scrollLeft || 0);
        grip.current = { unit, x: e.clientX, w0: (edge - gutter - fixed) / unit, id: e.pointerId };
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* non supportato */ }
        // i tasti dell'agenda tacciono durante il gesto (useAgendaShortcuts)
        document.body.classList.add('dk-gesture');
      },
      onPointerMove: (e) => {
        const g = grip.current;
        if (!g || (g.id != null && e.pointerId != null && e.pointerId !== g.id)) return;
        anchor.current = { keep: true };
        onWidth(clampWidth(g.w0 + (e.clientX - g.x) / g.unit));
      },
      onPointerUp: endGrip,
      onPointerCancel: endGrip,
      onLostPointerCapture: endGrip,
      onDoubleClick: (e) => { e.stopPropagation(); onFit && onFit(); },
      onClick: (e) => e.stopPropagation(),
    };
  }
  useEffect(() => () => { if (grip.current) document.body.classList.remove('dk-gesture'); }, []);
  return { gripProps };
}
