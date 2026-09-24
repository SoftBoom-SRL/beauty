// useAgendaShortcuts — i tasti dell'agenda: N (nuova prenotazione), + − 0
// (zoom) e ⌘Z / Ctrl+Z (torna indietro). Nessuno ruba il tasto a chi sta
// scrivendo in un campo.
import { useEffect } from 'react';
import { zoomStep } from '../lib/grid.js';

export function useAgendaShortcuts({ openNewAppt, date, modal, groupOpen, setZoom, undoLast }) {
  /* groupOpen sta fra le dipendenze: senza, l'handler registrato restava
   * quello di prima e vedeva il drawer di gruppo ancora chiuso — il tasto N ci
   * apriva sopra la prenotazione singola. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      // Zoom da tastiera senza modificatori: ⌘+ e ⌘− sono del browser e
      // ingrandirebbero tutta la pagina, che qui non è quello che serve.
      if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom((z) => zoomStep(z, 1)); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom((z) => zoomStep(z, -1)); return; }
      if (e.key === '0') { e.preventDefault(); setZoom(1); return; }
      if (e.key !== 'n' && e.key !== 'N') return;
      if (modal || groupOpen) return;   // il drawer di gruppo non è un modale del registry
      e.preventDefault();
      openNewAppt({ date });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openNewAppt, date, modal, groupOpen, setZoom]);

  /* ⌘Z / Ctrl+Z: la scorciatoia che tutti provano d'istinto. Non ruba il tasto
   * a chi sta scrivendo in un campo né a un modale aperto, dove annullerebbe
   * una cosa diversa da quella che si ha davanti. */
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if ((e.key || '').toLowerCase() !== 'z') return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      if (modal || groupOpen) return;
      e.preventDefault();
      undoLast();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undoLast, modal, groupOpen]);
}
