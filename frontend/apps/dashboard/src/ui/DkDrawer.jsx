import React, { useEffect, useRef } from 'react';

/** Drawer laterale su scrim. Stessa regola del DkModal: chiude solo se il
 *  pointer è sceso E risalito sullo scrim (niente chiusure da selezione testo). */
export default function DkDrawer({ open, onClose, children }) {
  const downOnScrim = useRef(false);
  // Esc chiude (senza rubare l'evento a chi lo gestisce già, es. un drawer annidato)
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose?.(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="dk-scrim"
      onPointerDown={(e) => { downOnScrim.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (downOnScrim.current && e.target === e.currentTarget) onClose?.(); downOnScrim.current = false; }}
    >
      <div className="dk-drawer" role="dialog" aria-modal="true">{children}</div>
    </div>
  );
}
