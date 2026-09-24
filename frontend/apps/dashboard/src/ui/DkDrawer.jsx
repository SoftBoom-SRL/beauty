import { useRef } from 'react';
import { useEscLayer } from './layers.js';

/** Drawer laterale su scrim. Stessa regola del DkModal: chiude solo se il
 *  pointer è sceso E risalito sullo scrim (niente chiusure da selezione testo). */
export default function DkDrawer({ open, onClose, children }) {
  const downOnScrim = useRef(false);
  // Esc chiude solo la finestra in primo piano (vedi layers.js): prima vinceva
  // quella aperta per prima, cioè quella sotto.
  useEscLayer(open, () => onClose?.());
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
