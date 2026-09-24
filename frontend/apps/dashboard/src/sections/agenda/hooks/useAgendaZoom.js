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
  /* «Adatta»: la giornata intera in una schermata, senza scorrere. Si misura
   * l'area visibile della griglia — è lei che detta quanto ci sta. */
  const fitZoom = useCallback(() => {
    const el = document.querySelector('.dk-tl-cols')?.closest('.scroll')
      || document.querySelector('[data-daycol]')?.closest('.scroll');
    if (!el) return;
    const body = el.querySelector('.dk-tl-cols')?.parentElement || el.querySelector('[data-daycol]')?.parentElement;
    const disponibile = el.clientHeight - (body ? body.offsetTop : 0) - 8;
    // la fascia oraria non è più fissa (08–20): la dice la griglia stessa
    const span = Number(body?.dataset?.spanMin) || (DK_END - DK_START);
    if (disponibile > 60) setZoom(disponibile / (span * PXM));
  }, [setZoom]);
  return { zoom, setZoom, fitZoom };
}
