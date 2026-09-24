// useOperatorVisibility — il filtro «Team» della vista giorno: quali colonne
// si disegnano. Un'operatrice nuova parte accesa; il filtro decide le
// COLONNE, non quali dati esistono (vedi index.jsx, allRows). Le spente
// restano spente su questa postazione (localStorage): chi in reception guarda
// sempre le stesse tre colonne le ritrovava tutte accese a ogni ricarica.
import { useEffect, useState } from 'react';

const KEY = 'dk-agenda-hidden-ops';

function readHidden() {
  try {
    const ids = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(ids) ? ids : [];
  } catch { return []; }
}

export function useOperatorVisibility(operators) {
  const [vis, setVis] = useState(() => Object.fromEntries(readHidden().map((id) => [id, false])));
  useEffect(() => {
    setVis((m) => {
      const next = { ...m };
      operators.forEach((o) => { if (next[o.id] === undefined) next[o.id] = true; });
      return next;
    });
  }, [operators]);
  // si salvano solo le spente: chi arriva dopo parte accesa
  useEffect(() => {
    const hidden = Object.keys(vis).filter((id) => vis[id] === false).map(Number);
    try { localStorage.setItem(KEY, JSON.stringify(hidden)); } catch { /* ignore */ }
  }, [vis]);
  const visCount = operators.filter((o) => vis[o.id] !== false).length;
  const allOn = operators.every((o) => vis[o.id] !== false);
  const toggleVis = (id) => setVis((m) => ({ ...m, [id]: m[id] === false }));
  const setAll = (on) => setVis(() => { const m = {}; operators.forEach((o) => { m[o.id] = on; }); return m; });
  /* «Solo lei»: l'operatrice che guarda la propria giornata, con un clic. */
  const only = (id) => setVis(() => { const m = {}; operators.forEach((o) => { m[o.id] = o.id === id; }); return m; });
  return { vis, visCount, allOn, toggleVis, setAll, only };
}
