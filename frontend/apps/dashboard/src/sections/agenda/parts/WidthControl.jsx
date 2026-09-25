// WidthControl — la larghezza delle colonne (lo zoom di lato) nella barra: un
// bottone solo, accanto allo zoom in altezza, che apre un pannellino con il
// cursore, − e +, «Tutte in vista» e «Normale». Tre bottoni in più in barra
// la mandavano a capo sotto i 1600 px, e la larghezza si cambia una volta
// ogni tanto; i gesti restano a portata di mano: il bordo delle testate (doppio
// clic: tutte in vista) e ⌘/ctrl + Maiusc + rotella sopra la griglia.
import { useCallback, useRef, useState } from 'react';
import { Icon } from '@youty/shared';
import { useClickAway } from '../../../hooks/useClickAway.js';
import { WIDTH_MAX, WIDTH_MIN, clampWidth, widthStep } from '../lib.js';

const AWAY = { event: 'pointerdown', capture: true, escape: true };
/* Il cursore va sul logaritmo della larghezza: ogni tratto raddoppia o
 * dimezza allo stesso modo, da un quarto a tre volte. */
const LO = Math.log(WIDTH_MIN), HI = Math.log(WIDTH_MAX);
const toPos = (w) => Math.round(((Math.log(clampWidth(w)) - LO) / (HI - LO)) * 1000);
const fromPos = (p) => clampWidth(Math.exp(LO + (Number(p) / 1000) * (HI - LO)));

/** `width` = la larghezza della vista a video, `setWidth(valore | fn)`,
 *  `fitWidth()` = tutte le colonne in vista (la calcola la vista). */
export default function WidthControl({ width = 1, setWidth, fitWidth, t }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useClickAway(ref, open, close, AWAY);
  const pct = Math.round(width * 100) + '%';
  const normal = Math.abs(width - 1) < 0.01;
  const label = t('Larghezza delle colonne', 'Column width');
  return (
    <div ref={ref} className="dk-agseg__pop">
      <button type="button" aria-expanded={open} aria-haspopup="dialog" aria-label={label + ' ' + pct}
        onClick={() => setOpen((o) => !o)}
        title={label + ' · ' + pct + t(' · anche trascinando il bordo di una testata', ' · also by dragging a header edge')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 8px', ...(normal ? {} : { color: 'var(--clay-ink)' }) }}>
        <Icon name="width" size={15} />
        {!normal && <span className="tabnum dk-ag-lbl" style={{ fontSize: 11.5 }}>{pct}</span>}
      </button>
      {open && (
        <div className="dk-card dk-widthpop" role="dialog" aria-label={label}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <span className="t-meta" style={{ flex: 1 }}>{label}</span>
            <span className="tabnum" style={{ fontSize: 12.5, fontWeight: 700, color: normal ? 'var(--muted)' : 'var(--ink)' }}>{pct}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button type="button" className="dk-agbtn dk-agbtn--quiet dk-widthpop__step" disabled={width <= WIDTH_MIN + 0.001}
              onClick={() => setWidth((w) => widthStep(w, -1))} aria-label={t('Colonne più strette', 'Narrower columns')} title={t('Più strette: più colonne sullo schermo', 'Narrower: more columns on screen')}>−</button>
            <input type="range" min={0} max={1000} step={1} value={toPos(width)} aria-label={label}
              onChange={(e) => setWidth(fromPos(e.target.value))} style={{ flex: 1, minWidth: 0, accentColor: 'var(--clay)' }} />
            <button type="button" className="dk-agbtn dk-agbtn--quiet dk-widthpop__step" disabled={width >= WIDTH_MAX - 0.001}
              onClick={() => setWidth((w) => widthStep(w, 1))} aria-label={t('Colonne più larghe', 'Wider columns')} title={t('Più larghe: blocchi più leggibili', 'Wider: easier-to-read blocks')}>+</button>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button type="button" className="dk-agbtn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => fitWidth && fitWidth()}
              title={t('Tutte le colonne in una schermata, senza scorrere di lato', 'All columns in one screen, no sideways scrolling')}>
              <Icon name="fitw" size={14} />{t('Tutte in vista', 'Fit all')}
            </button>
            <button type="button" className="dk-agbtn dk-agbtn--quiet" disabled={normal} onClick={() => setWidth(1)}>{t('Normale', 'Normal')}</button>
          </div>
          <div className="t-sm" style={{ marginTop: 10, color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.4 }}>
            {t('Anche trascinando il bordo di una testata (doppio clic: tutte in vista) o con ⌘/Ctrl + Maiusc e la rotella sulla griglia.', 'Also by dragging a header edge (double-click: fit all) or with ⌘/Ctrl + Shift and the wheel over the grid.')}
          </div>
        </div>
      )}
    </div>
  );
}
