// useAgendaNav — che cosa si guarda: il giorno (anche in settimana e nel
// mese è il giorno «scelto»), la vista e il selettore di mese/data aperto,
// con le frecce e i salti della barra.
import { useState } from 'react';
import { toDateStr, todayStr } from '@youty/shared';
import { shiftAnchor } from '../lib/calendar.js';

export function useAgendaNav() {
  const [date, setDate] = useState(todayStr());
  const [calView, setCalView] = useState('day'); // day | week | month
  const [jumpOpen, setJumpOpen] = useState(false);
  // un giorno, una settimana o un mese indietro/avanti (shiftAnchor)
  const navPrev = () => setDate(shiftAnchor(calView, date, -1));
  const navNext = () => setDate(shiftAnchor(calView, date, 1));
  const jumpToMonth = (m, y) => { setCalView('month'); setDate(toDateStr(new Date(y, m, 1))); setJumpOpen(false); };
  const jumpToDate = (iso) => { if (!iso) return; setDate(iso); setCalView('day'); setJumpOpen(false); };
  const openDay = (iso) => { setDate(iso); setCalView('day'); };
  return { date, setDate, calView, setCalView, jumpOpen, setJumpOpen, navPrev, navNext, jumpToMonth, jumpToDate, openDay };
}
