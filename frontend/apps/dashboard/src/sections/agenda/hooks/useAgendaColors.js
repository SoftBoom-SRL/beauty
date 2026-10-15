// useAgendaColors — i colori dell'agenda: l'operatrice (dal server, vedi
// ctx.jsx) e il servizio: il suo colore, o quello della sua categoria.
import { useCallback } from 'react';
import { serviceColor } from '../../../ui/palette.js';

/** Ritorna { colorOf(opId), itemColor(item) }: stabili finché non cambiano
 *  colori, servizi o categorie (li ricevono griglie e blocchi). */
export function useAgendaColors({ opColors, services, serviceCategories }) {
  const colorOf = useCallback((id) => opColors[id] || 'var(--clay)', [opColors]);
  // colore per-servizio (fallback: colore operatrice)
  const itemColor = useCallback((item) => {
    const s = (services || []).find((x) => x.id === item.service_id);
    return serviceColor(s, serviceCategories) || colorOf(item.operator_id);
  }, [services, serviceCategories, colorOf]);
  return { colorOf, itemColor };
}
