// app/useOperatorColors.js — il colore di ogni operatrice in agenda.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { staffApi } from '../api/staff.js';

export const OP_FALLBACK_PALETTE = ['#C9B8F2', '#B3DDF7', '#F7C5D9', '#FBE7A1', '#C2E8CB', '#FBD7B5', '#BFE9E1', '#C3CDF7', '#D2E5BE'];

/* ---- colori operatrice: dal server, condivisi fra le postazioni ----
 * Il colore scelto in agenda viene salvato (PATCH /api/staff/{id}/color): prima
 * viveva solo nello stato locale e ogni pc vedeva il suo. L'override locale
 * serve solo come feedback immediato finché il server non conferma; le altre
 * postazioni ricevono `operator.updated` dal feed live e ricaricano.
 * → { opColors: { [id]: colore }, setOpColor(id, colore) } */
export function useOperatorColors({ operators, reload, fireToast, t }) {
  const [opColorOverrides, setOpColorOverrides] = useState({});
  const opColors = useMemo(() => {
    const m = {};
    operators.forEach((o, i) => {
      m[o.id] = opColorOverrides[o.id] || o.color || OP_FALLBACK_PALETTE[i % OP_FALLBACK_PALETTE.length];
    });
    return m;
  }, [operators, opColorOverrides]);
  /* Il selettore colore nativo emette un evento a ogni movimento del cursore:
   * salvare a ogni evento voleva dire decine di PATCH, altrettanti ricarichi
   * dell'elenco operatrici e un evento live a tutte le postazioni per un solo
   * colore scelto. L'anteprima resta immediata, la scrittura parte a mano ferma. */
  const colorTimers = useRef({});
  useEffect(() => () => { Object.values(colorTimers.current).forEach(clearTimeout); }, []);
  const setOpColor = useCallback((id, c) => {
    setOpColorOverrides((m) => ({ ...m, [id]: c }));
    clearTimeout(colorTimers.current[id]);
    colorTimers.current[id] = setTimeout(() => {
      delete colorTimers.current[id];
      staffApi.setColor(id, c)
        .then(() => reload.operators().catch(() => {}))
        .then(() => setOpColorOverrides((m) => { const next = { ...m }; delete next[id]; return next; }))
        .catch(() => {
          setOpColorOverrides((m) => { const next = { ...m }; delete next[id]; return next; });
          fireToast({ msg: t('Colore non salvato: riprova', 'Colour not saved: try again'), icon: 'alert' });
        });
    }, 400);
  }, [reload, fireToast, t]);
  return { opColors, setOpColor };
}
