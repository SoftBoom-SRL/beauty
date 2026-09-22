import React, { useEffect } from 'react';
import { Icon } from '@youty/shared';

/**
 * Pannello laterale: sta a destra, sotto la barra in alto, e NON oscura quello
 * che c'è sotto. È il guscio giusto per tutto ciò che si fa «guardando l'agenda»
 * — il dettaglio di un appuntamento, una riprogrammazione — perché chi lavora
 * deve continuare a vedere gli orari, le colleghe e il blocco su cui sta
 * intervenendo. Lo scrim scuro di DkModal, invece, spegne la giornata dietro la
 * finestra proprio mentre serve leggerla.
 *
 * Su uno schermo stretto non c'è spazio per affiancare: il pannello prende tutta
 * la larghezza e si comporta come una schermata a sé.
 *
 * `foot` resta sempre visibile in fondo (le azioni non si cercano scorrendo).
 */
export default function DkPanel({ title, sub, onClose, foot, width = 560, children, head }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose?.(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* Finché è aperto, l'area di lavoro si restringe di tanto quanto il pannello
   * (vedi .dk-with-panel): se restasse sotto, il pannello coprirebbe proprio
   * l'appuntamento che si sta modificando. */
  useEffect(() => {
    document.body.classList.add('dk-with-panel');
    document.body.style.setProperty('--dk-panel-w', typeof width === 'number' ? width + 'px' : String(width));
    return () => {
      document.body.classList.remove('dk-with-panel');
      document.body.style.removeProperty('--dk-panel-w');
    };
  }, [width]);

  return (
    <div
      role="dialog"
      aria-label={typeof title === 'string' ? title : undefined}
      style={{
        position: 'fixed', top: 'var(--top-h)', right: 0, bottom: 0,
        width, maxWidth: '100vw', zIndex: 120,
        background: 'var(--surface)', borderLeft: '1px solid var(--hair)',
        boxShadow: 'var(--sh-pop)', display: 'flex', flexDirection: 'column',
        animation: 'dkSlideR 260ms var(--ease-emph)',
      }}
    >
      <div className="dk-modalhead" style={{ padding: '16px 20px 12px', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-title" style={{ fontSize: 19, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
          {sub && <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{sub}</div>}
        </div>
        <button className="dk-iconbtn" style={{ flexShrink: 0, marginLeft: 12, width: 34, height: 34 }} onClick={onClose} aria-label="Chiudi" title="Esc"><Icon name="x" size={16} /></button>
      </div>
      {head}
      <div className="dk-modalbody scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 20px 18px' }}>{children}</div>
      {foot && <div style={{ padding: '12px 20px 14px', borderTop: '1px solid var(--hair)', background: 'var(--surface-2)', flexShrink: 0 }}>{foot}</div>}
    </div>
  );
}
