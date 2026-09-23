import React, { useLayoutEffect, useRef } from 'react';
import { useEscLayer } from './layers.js';
import { Icon } from '@youty/shared';

/* ---- posto dei pannelli laterali ------------------------------------------
 * Pannelli aperti, dal più vecchio. Ognuno scriveva da sé la classe che
 * restringe l'area di lavoro: i drawer «Nuova prenotazione» e «Gruppo» non la
 * mettevano (coprivano le ultime colonne proprio mentre si sceglie l'orario in
 * agenda), e con due pannelli aperti quello che si chiudeva la toglieva anche
 * all'altro. A z-index uguale, poi, vinceva l'ordine nel DOM: «Gruppo» aperto
 * col dettaglio finiva nascosto dietro (13-19). */
const openPanels = [];
const PANEL_Z = 120;
const PANEL_Z_MAX = 149;   // sotto il pulsante AI (150), le finestre con scrim (200) e i toast (300)

function syncBody() {
  if (typeof document === 'undefined') return;
  const body = document.body;
  if (!openPanels.length) {
    body.classList.remove('dk-with-panel');
    body.style.removeProperty('--dk-panel-w');
    return;
  }
  body.classList.add('dk-with-panel');
  body.style.setProperty('--dk-panel-w', Math.max(...openPanels.map((p) => p.width)) + 'px');
}

/**
 * Il posto di un pannello laterale (DkPanel e i drawer che si disegnano da sé):
 * finché è aperto l'area di lavoro si restringe della larghezza del pannello
 * più largo aperto (vedi .dk-with-panel), e l'ultimo aperto sta sopra gli
 * altri — lo stesso ordine con cui Esc li chiude (layers.js).
 * Ritorna lo z-index da usare.
 */
export function usePanelSlot(width) {
  const px = typeof width === 'number' ? width : (parseInt(width, 10) || 560);
  const slot = useRef(null);
  if (!slot.current) {
    const top = openPanels.reduce((z, p) => Math.max(z, p.z), PANEL_Z - 1);
    slot.current = { width: px, z: Math.min(PANEL_Z_MAX, top + 1) };
  }
  slot.current.width = px;
  useLayoutEffect(() => {
    const me = slot.current;
    openPanels.push(me);
    syncBody();
    return () => {
      const i = openPanels.indexOf(me);
      if (i >= 0) openPanels.splice(i, 1);
      syncBody();
    };
  }, []);
  useLayoutEffect(() => { syncBody(); }, [px]);
  return slot.current.z;
}

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
  // Esc chiude il pannello solo se è lui in primo piano (vedi layers.js)
  useEscLayer(true, () => onClose?.());

  /* Finché è aperto, l'area di lavoro si restringe di tanto quanto il pannello
   * (vedi .dk-with-panel): se restasse sotto, il pannello coprirebbe proprio
   * l'appuntamento che si sta modificando. */
  const zIndex = usePanelSlot(width);

  return (
    <div
      role="dialog"
      aria-label={typeof title === 'string' ? title : undefined}
      style={{
        position: 'fixed', top: 'var(--top-h)', right: 0, bottom: 0,
        width, maxWidth: '100vw', zIndex,
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
