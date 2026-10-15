// ColorWheel.jsx — scegliere un colore liberamente, senza conoscerne il
// codice: la ruota per la tinta (il giro) e l'intensità (dal centro grigio al
// bordo pieno), la barra per il chiaro e lo scuro, e l'anteprima del testo che
// ci andrà sopra. Prima c'erano le tavolozze, il codice esadecimale e il
// selettore del browser nascosto dentro il quadratino del colore: chi voleva un
// colore suo non sapeva dove trovarlo, o doveva conoscerne il codice.
//
// `onChange(hex)` a ogni movimento (l'anteprima); `onCommit(hex)` a gesto
// finito (dito alzato, tasto lasciato), per chi salva subito sul server e non
// deve scrivere a ogni pixel. Stili in styles/controls.css (.dk-cwheel).
import { useEffect, useRef, useState } from 'react';
import { hexToHsl, hslToHex, inkOn } from './colorTools.js';

const FALLBACK = { h: 250, s: 0.6, l: 0.6 };
const HUE_STEP = 5, SAT_STEP = 0.05;

export default function ColorWheel({ value, onChange, onCommit, t, size = 132, disabled = false }) {
  const [hsl, setHsl] = useState(() => hexToHsl(value) || FALLBACK);
  const hslRef = useRef(hsl);
  hslRef.current = hsl;
  // L'ultimo colore che la ruota conosce (uscito da qui o riletto). Un colore
  // che arriva da fuori (tavolozza, codice) si rilegge; quello appena emesso
  // no: da un grigio la tinta non si ricava, e la manopola tornerebbe sul
  // rosso sotto il dito.
  const seen = useRef(value ? String(value).toUpperCase() : null);
  useEffect(() => {
    if (!value || String(value).toUpperCase() === seen.current) return;
    seen.current = String(value).toUpperCase();
    const next = hexToHsl(value);
    if (next) setHsl((cur) => ({ h: next.s === 0 ? cur.h : next.h, s: next.s, l: next.l }));
  }, [value]);

  const hex = hslToHex(hsl.h, hsl.s, hsl.l);
  const update = (patch) => {
    const next = { ...hslRef.current, ...patch };
    hslRef.current = next;
    setHsl(next);
    const out = hslToHex(next.h, next.s, next.l);
    seen.current = out;
    if (onChange) onChange(out);
  };
  const commit = () => { const c = hslRef.current; if (onCommit) onCommit(hslToHex(c.h, c.s, c.l)); };

  /* ---- la ruota: angolo = tinta, distanza dal centro = intensità ---- */
  const dragging = useRef(false);
  const fromPointer = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const h = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    const s = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
    // dal nero o dal bianco un giro di ruota non cambierebbe niente: si torna a metà
    const l = hslRef.current.l;
    update({ h, s, l: l < 0.05 || l > 0.95 ? 0.5 : l });
  };
  const onPointerDown = (e) => {
    if (disabled) return;
    e.preventDefault();
    if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    fromPointer(e);
  };
  const onPointerMove = (e) => { if (dragging.current) fromPointer(e); };
  const onPointerUp = () => { if (!dragging.current) return; dragging.current = false; commit(); };
  const onKeyDown = (e) => {
    const { h, s } = hslRef.current;
    const k = e.shiftKey ? 3 : 1;
    const moves = {
      ArrowLeft: { h: (h - HUE_STEP * k + 360) % 360 }, ArrowRight: { h: (h + HUE_STEP * k) % 360 },
      ArrowUp: { s: Math.min(1, s + SAT_STEP * k) }, ArrowDown: { s: Math.max(0, s - SAT_STEP * k) },
    };
    if (!moves[e.key]) return;
    e.preventDefault();
    update(moves[e.key]);
  };
  const onKeyUp = (e) => { if (e.key.startsWith('Arrow')) commit(); };

  const radius = size / 2;
  const rad = hsl.h * Math.PI / 180;
  const knob = { left: radius + Math.sin(rad) * hsl.s * radius, top: radius - Math.cos(rad) * hsl.s * radius };
  const ink = inkOn(hex);
  return (
    <div className="dk-cwheel" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', opacity: disabled ? 0.55 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
      <div
        className="dk-cwheel__ring" role="slider" tabIndex={disabled ? -1 : 0}
        aria-label={t('Ruota dei colori: tinta e intensità', 'Colour wheel: hue and intensity')}
        aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hsl.h)}
        aria-valuetext={`${t('tinta', 'hue')} ${Math.round(hsl.h)}°, ${t('intensità', 'intensity')} ${Math.round(hsl.s * 100)}%`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown} onKeyUp={onKeyUp}
        style={{ width: size, height: size }}
      >
        <span className="dk-cwheel__knob" style={{ ...knob, background: hex }} />
      </div>
      <div style={{ flex: '1 1 150px', minWidth: 150 }}>
        <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 8, lineHeight: 1.35 }}>
          {t('Tocca la ruota per la tinta (verso il centro è più tenue), poi scegli quanto chiaro o scuro.', 'Tap the wheel for the hue (softer towards the centre), then choose how light or dark.')}
        </div>
        <input
          type="range" className="dk-lightness" min={0} max={100} step={1} value={Math.round(hsl.l * 100)} disabled={disabled}
          aria-label={t('Chiaro o scuro', 'Light or dark')}
          onChange={(e) => update({ l: Number(e.target.value) / 100 })} onPointerUp={commit} onKeyUp={onKeyUp}
          style={{ '--track': `linear-gradient(to right, #000000, ${hslToHex(hsl.h, hsl.s, 0.5)}, #FFFFFF)`, '--thumb': hex }}
        />
        <div className="t-sm" style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--muted-2)', fontSize: 11, marginTop: 3 }}>
          <span>{t('Scuro', 'Dark')}</span><span>{t('Chiaro', 'Light')}</span>
        </div>
        {/* il testo sopra il colore, come andrà in agenda: bianco sui colori scuri */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', height: 26, padding: '0 12px', borderRadius: 8, background: hex, color: ink.ink, fontWeight: 700, fontSize: 12.5, whiteSpace: 'nowrap', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.08)' }}>
            {t('Testo di prova', 'Sample text')}
          </span>
          <span className="tabnum" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>{hex}</span>
        </div>
      </div>
    </div>
  );
}
