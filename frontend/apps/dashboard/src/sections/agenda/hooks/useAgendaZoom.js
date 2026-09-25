// useAgendaZoom — lo zoom delle viste giorno/settimana.
// Preferenza della POSTAZIONE, non del salone: resta su questo computer e
// non tocca l'intervallo di prenotazione (Impostazioni), che è una regola di
// tutti. Come i calendari professionali: cursore personale su Fresha,
// spaziatura righe e pinch su Vagaro, «quante ore per schermata» su Apple.
import { useCallback, useEffect, useState } from 'react';
import { DK_END, DK_START, PXM } from '../constants.js';
import { clampZoom } from '../lib/grid.js';

export function useAgendaZoom() {
  const [zoom, setZoomRaw] = useState(() => {
    try { return clampZoom(parseFloat(localStorage.getItem('dk-agenda-zoom')) || 1); } catch { return 1; }
  });
  /* Il valore precedente si legge dallo stato, non dalla chiusura: premendo due
   * volte «+» in fretta il secondo clic partiva dallo stesso numero del primo e
   * non faceva niente. */
  const setZoom = useCallback((z) => {
    setZoomRaw((prev) => clampZoom(typeof z === 'function' ? z(prev) : z));
  }, []);
  useEffect(() => {
    try { localStorage.setItem('dk-agenda-zoom', String(zoom)); } catch { /* ignore */ }
  }, [zoom]);
  /* «Adatta»: la giornata di LAVORO in una schermata, dall'inizio. La griglia
   * copre le 24 ore (GRID_DAY): adattarla tutta avrebbe schiacciato la
   * giornata in un terzo di schermo. Si misura l'area visibile della griglia,
   * sotto l'intestazione fissa; la giornata la dice la griglia stessa
   * (`data-work-start`/`data-work-end` sul corpo). */
  const fitZoom = useCallback(() => {
    const el = document.querySelector('.dk-tl-cols')?.closest('.scroll')
      || document.querySelector('[data-daycol]')?.closest('.scroll');
    if (!el) return;
    const body = el.querySelector('.dk-tl-cols')?.parentElement || el.querySelector('[data-daycol]')?.parentElement;
    const top0 = body ? body.offsetTop : 0;
    const headH = body?.previousElementSibling?.offsetHeight || 0;
    const from = Number(body?.dataset?.workStart ?? DK_START);
    const to = Number(body?.dataset?.workEnd ?? DK_END);
    const g0 = Number(body?.dataset?.g0 ?? 0);
    // 8 px d'aria sopra e sotto la giornata
    const disponibile = el.clientHeight - headH - 16;
    if (disponibile <= 60 || !(to > from)) return;
    const z = clampZoom(disponibile / ((to - from) * PXM));
    setZoom(z);
    /* Poi la giornata si porta in cima. Al fotogramma dopo: prima lo zoom
     * nuovo si disegna, e useGridZoom rimette al centro il minuto che c'era. */
    const go = () => { el.scrollTop = Math.max(0, top0 + (from - g0) * PXM * z - headH - 8); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go); else setTimeout(go, 0);
  }, [setZoom]);
  return { zoom, setZoom, fitZoom };
}
