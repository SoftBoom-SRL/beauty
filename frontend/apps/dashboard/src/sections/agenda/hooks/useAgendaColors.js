// useAgendaColors — i colori dell'agenda: l'operatrice (dal server, vedi
// ctx.jsx) e il servizio, dalla sua categoria.
import { useCallback } from 'react';

/** Ritorna { colorOf(opId), itemColor(item) }: stabili finché non cambiano
 *  colori, servizi o categorie (li ricevono griglie e blocchi). */
export function useAgendaColors({ opColors, services, serviceCategories }) {
  const colorOf = useCallback((id) => opColors[id] || 'var(--clay)', [opColors]);
  const catColor = useCallback((catId) => {
    const c = (serviceCategories || []).find((x) => x.id === catId);
    return c ? c.color : null;
  }, [serviceCategories]);
  // colore per-servizio, dalla categoria del servizio (fallback: colore operatrice)
  const itemColor = useCallback((item) => {
    const s = (services || []).find((x) => x.id === item.service_id);
    const col = s ? catColor(s.category_id) : null;
    return col || colorOf(item.operator_id);
  }, [services, catColor, colorOf]);
  return { colorOf, itemColor };
}
