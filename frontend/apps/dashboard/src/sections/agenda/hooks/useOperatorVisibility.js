// useOperatorVisibility — le chip «Calendari» della vista giorno: quali
// colonne si disegnano. Un'operatrice nuova parte accesa; le chip decidono le
// COLONNE, non quali dati esistono (vedi index.jsx, allRows).
import { useEffect, useState } from 'react';

export function useOperatorVisibility(operators) {
  const [vis, setVis] = useState({});
  useEffect(() => {
    setVis((m) => {
      const next = { ...m };
      operators.forEach((o) => { if (next[o.id] === undefined) next[o.id] = true; });
      return next;
    });
  }, [operators]);
  const visCount = operators.filter((o) => vis[o.id]).length;
  const allOn = operators.every((o) => vis[o.id]);
  const toggleVis = (id) => setVis((m) => ({ ...m, [id]: !m[id] }));
  const setAll = (on) => setVis(() => { const m = {}; operators.forEach((o) => { m[o.id] = on; }); return m; });
  return { vis, visCount, allOn, toggleVis, setAll };
}
