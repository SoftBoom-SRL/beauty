// useOperatorVisibility — il filtro «Team» delle viste giorno e settimana:
// quali colonne si disegnano. Un'operatrice nuova parte accesa; il filtro
// decide le COLONNE, non quali dati esistono (vedi index.jsx, allRows). Le
// spente restano spente su questa postazione (localStorage): chi in reception
// guarda sempre le stesse tre colonne le ritrovava tutte accese a ogni
// ricarica. Le regole (quali id valgono, come si leggono) stanno in lib/team.js.
import { useEffect, useState } from 'react';
import { parseHiddenIds } from '../lib/team.js';

const KEY = 'dk-agenda-hidden-ops';

function readHidden() {
  try { return parseHiddenIds(localStorage.getItem(KEY)); } catch { return []; }
}

export function useOperatorVisibility(operators) {
  const [vis, setVis] = useState(() => Object.fromEntries(readHidden().map((id) => [id, false])));
  useEffect(() => {
    // Con l'elenco arrivato si tengono solo le operatrici che ci sono: un id
    // di chi è stata tolta dal team non resta salvato per sempre.
    if (!operators.length) return;
    setVis((m) => Object.fromEntries(operators.map((o) => [o.id, m[o.id] !== false])));
  }, [operators]);
  // si salvano solo le spente: chi arriva dopo parte accesa
  useEffect(() => {
    const hidden = Object.keys(vis).filter((id) => vis[id] === false).map(Number);
    try { localStorage.setItem(KEY, JSON.stringify(hidden)); } catch { /* ignore */ }
  }, [vis]);
  const toggleVis = (id) => setVis((m) => ({ ...m, [id]: m[id] === false }));
  /* «Tutte», «Nessuna» e «Solo» toccano le operatrici che il filtro elenca
   * (`list`: quelle della sede attiva), non le altre: da una sede si
   * spegnevano, senza vederlo, le colonne di un'altra. */
  const setAll = (on, list = operators) => setVis((m) => ({ ...m, ...Object.fromEntries(list.map((o) => [o.id, on])) }));
  /* «Solo»: la giornata di una persona sola, con un clic. */
  const only = (id, list = operators) => setVis((m) => ({ ...m, ...Object.fromEntries(list.map((o) => [o.id, o.id === id])) }));
  return { vis, toggleVis, setAll, only };
}
