import React, { useRef } from 'react';
import { useEscLayer } from './layers.js';
import { Icon } from '@youty/shared';

/**
 * Modale centrato su scrim. Si chiude cliccando lo scrim SOLO se il gesto è
 * iniziato e finito sullo scrim: una selezione di testo che parte dentro il
 * modale e rilascia fuori genera un `click` sullo scrim (target comune) e
 * prima chiudeva la finestra a tradimento.
 */
export default function DkModal({ open, onClose, title, sub, children, width, foot }) {
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
      <div className="dk-modal" role="dialog" aria-modal="true" style={{ width }}>
        <div className="dk-modalhead">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="t-title" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
            {sub && <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4 }}>{sub}</div>}
          </div>
          <button className="dk-iconbtn" style={{ flexShrink: 0, marginLeft: 12 }} onClick={onClose} aria-label="Chiudi"><Icon name="x" size={18} /></button>
        </div>
        <div className="dk-modalbody">{children}</div>
        {foot && <div style={{ padding: '16px 24px', borderTop: '1px solid var(--hair)', display: 'flex', gap: 12, justifyContent: 'flex-end', background: 'var(--surface-2)' }}>{foot}</div>}
      </div>
    </div>
  );
}
