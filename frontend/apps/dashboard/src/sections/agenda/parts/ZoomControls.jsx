// ZoomControls — lo zoom delle viste giorno e settimana nella barra:
// −, percentuale (torna a 100%), + e «Adatta» (vedi useAgendaZoom) per
// l'altezza delle ore; in coda la larghezza delle colonne (WidthControl: un
// bottone che apre il suo pannellino). Sta accanto al selettore di vista
// perché è la stessa famiglia di gesti — «quanto ne vedo». Con la barra
// stretta la percentuale e l'etichetta di «Adatta» lasciano il posto
// (restano nei suggerimenti e nei tasti + − 0).
import { Icon } from '@youty/shared';
import { ZOOM_MAX, ZOOM_MIN, zoomStep } from '../lib.js';
import WidthControl from './WidthControl.jsx';

/** `width`/`setWidth`/`fitWidth`: la larghezza delle colonne della vista a
 *  video (vedi WidthControl); senza `setWidth` c'è solo l'altezza. */
export default function ZoomControls({ zoom, setZoom, fitZoom, width = 1, setWidth = null, fitWidth, t }) {
  const pct = Math.round(zoom * 100) + '%';
  return (
    <div className="dk-agseg" role="group" aria-label={t('Zoom', 'Zoom') + ' ' + pct}>
      <button style={{ fontSize: 16, padding: 0 }} disabled={zoom <= ZOOM_MIN + 0.001}
        onClick={() => setZoom((z) => zoomStep(z, -1))} title={t('Rimpicciolisci: più ore sullo schermo (tasto −, o ⌘ e rotella)', 'Zoom out: more hours on screen (− key, or ⌘ and wheel)')} aria-label={t('Rimpicciolisci', 'Zoom out')}>−</button>
      <button onClick={() => setZoom(1)} title={t(`Zoom ${pct} · torna alla scala normale (0)`, `Zoom ${pct} · back to normal scale (0)`)}
        className="tabnum dk-ag-lbl" style={{ minWidth: 44, padding: '0 4px', color: Math.abs(zoom - 1) < 0.01 ? 'var(--muted)' : 'var(--ink)' }}>
        {pct}
      </button>
      <button style={{ fontSize: 16, padding: 0 }} disabled={zoom >= ZOOM_MAX - 0.001}
        onClick={() => setZoom((z) => zoomStep(z, 1))} title={t('Ingrandisci: ore più alte, si leggono i quarti (tasto +, o ⌘ e rotella)', 'Zoom in: taller hours, quarters readable (+ key, or ⌘ and wheel)')} aria-label={t('Ingrandisci', 'Zoom in')}>+</button>
      <button onClick={fitZoom} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0 9px' }}
        aria-label={t('Adatta', 'Fit')}
        title={t('Adatta: l\'orario di lavoro in una schermata, dall\'inizio', 'Fit: the working hours in one screen, from the start')}>
        <Icon name="fit" size={14} /><span className="dk-ag-lbl">{t('Adatta', 'Fit')}</span>
      </button>
      {setWidth && <WidthControl width={width} setWidth={setWidth} fitWidth={fitWidth} t={t} />}
    </div>
  );
}
