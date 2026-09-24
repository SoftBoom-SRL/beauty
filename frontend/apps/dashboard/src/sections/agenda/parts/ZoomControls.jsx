// ZoomControls — lo zoom delle viste giorno e settimana nella barra:
// −, percentuale (torna a 100%), + e «Adatta» (vedi useAgendaZoom). Zoom:
// quanto è alta un'ora sullo schermo. Sta accanto al selettore di vista
// perché è la stessa famiglia di gesti — «quanto ne vedo».
import { ZOOM_MAX, ZOOM_MIN, zoomStep } from '../lib.js';

export default function ZoomControls({ zoom, setZoom, fitZoom, t }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 12, padding: 4, flexShrink: 0 }}>
      <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 17, fontWeight: 700, lineHeight: 1 }} disabled={zoom <= ZOOM_MIN + 0.001}
        onClick={() => setZoom((z) => zoomStep(z, -1))} title={t('Rimpicciolisci: più ore sullo schermo (tasto −, o ⌘ e rotella)', 'Zoom out: more hours on screen (− key, or ⌘ and wheel)')} aria-label={t('Rimpicciolisci', 'Zoom out')}>−</button>
      <button onClick={() => setZoom(1)} title={t('Torna alla scala normale (0)', 'Back to normal scale (0)')}
        className="tabnum" style={{ minWidth: 44, padding: '0 4px', height: 30, borderRadius: 9, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: Math.abs(zoom - 1) < 0.01 ? 'var(--muted)' : 'var(--ink)' }}>
        {Math.round(zoom * 100)}%
      </button>
      <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 17, fontWeight: 700, lineHeight: 1 }} disabled={zoom >= ZOOM_MAX - 0.001}
        onClick={() => setZoom((z) => zoomStep(z, 1))} title={t('Ingrandisci: ore più alte, si leggono i quarti (tasto +, o ⌘ e rotella)', 'Zoom in: taller hours, quarters readable (+ key, or ⌘ and wheel)')} aria-label={t('Ingrandisci', 'Zoom in')}>+</button>
      <button onClick={fitZoom} style={{ height: 30, padding: '0 9px', borderRadius: 9, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--ink-2)' }}
        title={t('Adatta: tutta la giornata in una schermata, senza scorrere', 'Fit: the whole day in one screen, no scrolling')}>{t('Adatta', 'Fit')}</button>
    </div>
  );
}
