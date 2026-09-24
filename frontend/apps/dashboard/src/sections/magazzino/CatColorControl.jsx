// CatColorControl.jsx — il colore della categoria del prodotto, nella scheda
// prodotto (ProductDrawer).
import { useEffect, useRef, useState } from 'react';
import { CAT_SWATCHES } from '../../ui/palette.js';

/* category colour: fallback + pastel presets offered in the picker (CAT_SWATCHES) */
export const CAT_FALLBACK = '#E0E7FF';
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

/* Compact colour control for the currently-selected category. Keeps a local
 * draft of the hex; commits to the parent via onCatColor only on blur / swatch
 * click / colour-picker close — never on every keystroke. Remount via `key`
 * (parent passes key={cat.id}) resets local state when the selection changes.
 * Il selettore nativo emette `onChange` a ogni movimento del cursore: salvare lì
 * voleva dire decine di PUT della categoria e altrettante ricariche di tutto il
 * magazzino, in parallelo, con la categoria che poteva restare su un colore
 * intermedio (15-12). Lì si aggiorna solo l'anteprima; la scrittura parte a mano
 * ferma (400 ms, come il colore operatrice in app/useOperatorColors.js),
 * all'uscita dal campo o se la scheda si chiude prima. */
export default function CatColorControl({ cat, onCatColor, t }) {
  const current = cat.color || CAT_FALLBACK;
  const [hex, setHex] = useState(current);
  const committed = useRef(current);
  const pickTimer = useRef(null);
  const pickPending = useRef(null);
  const commit = (raw) => {
    clearTimeout(pickTimer.current);
    pickPending.current = null;
    let v = String(raw == null ? hex : raw).trim();
    if (v && v[0] !== '#') v = '#' + v;
    if (!HEX_RE.test(v)) { setHex(current); return; }
    setHex(v);
    if (v.toLowerCase() !== committed.current.toLowerCase()) {
      committed.current = v;
      onCatColor(cat.id, v);
    }
  };
  const pick = (v) => {
    setHex(v);
    pickPending.current = v;
    clearTimeout(pickTimer.current);
    pickTimer.current = setTimeout(() => commit(v), 400);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => {
    clearTimeout(pickTimer.current);
    if (pickPending.current) commitRef.current(pickPending.current);
  }, []);
  const swatch = HEX6_RE.test(hex) ? hex : (HEX6_RE.test(current) ? current : CAT_FALLBACK);
  return (
    <div style={{ marginTop: 12, padding: 12, border: '1px solid var(--hair)', borderRadius: 10, background: 'var(--surface-2)' }}>
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Colore di', 'Colour of')} «{cat.name}»</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input type="color" value={swatch} onChange={(e) => pick(e.target.value)} onBlur={() => { if (pickPending.current) commit(pickPending.current); }} title={t('Scegli colore', 'Pick colour')}
          style={{ width: 38, height: 38, padding: 0, border: '1px solid var(--hair)', borderRadius: 9, background: 'var(--surface)', cursor: 'pointer' }} />
        <input value={hex} onChange={(e) => setHex(e.target.value)} onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(e.target.value); } }}
          placeholder={CAT_FALLBACK} spellCheck={false} maxLength={7}
          style={{ width: 100, border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13.5, fontFamily: 'var(--mono, ui-monospace, monospace)', padding: '9px 10px', background: 'var(--surface)', textTransform: 'uppercase' }} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {CAT_SWATCHES.map((p) => {
            const on = p.toLowerCase() === hex.toLowerCase();
            return (
              <button key={p} onClick={() => commit(p)} title={p}
                style={{ width: 22, height: 22, borderRadius: 99, cursor: 'pointer', background: p, border: '1px solid rgba(0,0,0,0.08)', boxShadow: on ? '0 0 0 2px var(--surface-2), 0 0 0 3px var(--ink)' : 'none' }} />
            );
          })}
        </div>
      </div>
      <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 8 }}>{t('Vale per tutti i prodotti di questa categoria · usato anche altrove.', 'Applies to every product in this category · used elsewhere too.')}</div>
    </div>
  );
}
