// lib/colors.js — il testo leggibile sopra un colore scelto dal salone. I
// colori li sceglie il salone (operatrici e categorie, vedi seed_demo): con il
// testo sempre scuro, un blocco su un colore scuro (blu notte, bordeaux, o
// l'operatrice quando il servizio non ha categoria) non si leggeva.

/** "#RGB" / "#RRGGBB" → [r, g, b] 0..255, o null (per esempio 'var(--clay)'). */
export function hexRgb(color) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** Luminanza relativa WCAG di [r, g, b]. */
function luminance([r, g, b]) {
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const INK_LUM = luminance([0x1A, 0x1A, 0x2E]);   // --ink del tema

/** Il fondo è scuro abbastanza da volere il testo bianco? `mix` = quanto
 *  colore c'è (0..1) sopra il bianco, come in `color-mix(… mix%, #FFFFFF)`.
 *  Vince il testo col contrasto più alto; un colore che non si sa leggere
 *  (una variabile CSS) resta col testo scuro, come prima. */
export function wantsLightText(color, mix = 1) {
  const rgb = hexRgb(color);
  if (!rgb) return false;
  const mixed = rgb.map((c) => c * mix + 255 * (1 - mix));
  const L = luminance(mixed);
  return (1.05 / (L + 0.05)) > ((L + 0.05) / (INK_LUM + 0.05));
}

/** I due toni del testo sopra `color`: principale e secondario. */
export function inkOn(color, mix = 1) {
  return wantsLightText(color, mix)
    ? { ink: '#FFFFFF', sub: 'rgba(255,255,255,0.86)', chip: 'rgba(255,255,255,0.22)' }
    : { ink: 'var(--ink)', sub: 'var(--ink-2)', chip: 'rgba(255,255,255,0.62)' };
}
