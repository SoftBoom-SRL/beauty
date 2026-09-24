// useAgendaShortcuts — i tasti dell'agenda: N (nuova prenotazione), + − 0
// (zoom), ⌘Z / Ctrl+Z (torna indietro), T (oggi), ← → (giorno, settimana o
// mese prima e dopo) e G S M (la vista; anche D W in inglese). Nessuno ruba il
// tasto a chi sta scrivendo in un campo, e i tasti che cambiano la vista
// tacciono con un pannello aperto: ← in un pannello non deve sfogliare
// l'agenda dietro.
import { useEffect } from 'react';
import { zoomStep } from '../lib/grid.js';

const VIEW_KEYS = { g: 'day', d: 'day', s: 'week', w: 'week', m: 'month' };

export function useAgendaShortcuts({ openNewAppt, date, modal, groupOpen, setZoom, undoLast, goToday, navPrev, navNext, setCalView }) {
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
      if (modal || groupOpen) return;   // il drawer di gruppo non è un modale del registry
      // dopo un clic su «Oggi» o su una freccia il fuoco resta sul bottone: le
      // frecce devono funzionare anche lì (i campi sono già esclusi sopra)
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey) {
        const go = e.key === 'ArrowLeft' ? navPrev : navNext;
        if (go) { e.preventDefault(); go(); }
        return;
      }
      const key = (e.key || '').toLowerCase();
      if (key === 't' && goToday) { e.preventDefault(); goToday(); return; }
      if (VIEW_KEYS[key] && setCalView) { e.preventDefault(); setCalView(VIEW_KEYS[key]); return; }
      if (key !== 'n') return;
      e.preventDefault();
      openNewAppt({ date });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openNewAppt, date, modal, groupOpen, setZoom, goToday, navPrev, navNext, setCalView]);

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
