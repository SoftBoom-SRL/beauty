// colorTools.js — i conti sui colori scelti dal salone (logica pura):
//   hexRgb / hexToHsl / hslToHex   le conversioni per la ruota dei colori
//   wantsLightText / inkOn         il testo leggibile sopra un colore
//   pillVars                       le variabili delle pillole tinte (pills.css)
// Il testo sempre scuro non si leggeva sui colori scuri (blu notte, bordeaux,
// l'indaco delle operatrici): ora vince il testo, bianco o scuro, col
// contrasto più alto. Nato in sections/agenda/lib/colors.js per i blocchi
// dell'agenda, qui per tutta la dashboard.

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

/** I toni del testo sopra `color`: principale, secondario e il fondo delle
 *  etichette piccole (chip). */
export function inkOn(color, mix = 1) {
  return wantsLightText(color, mix)
    ? { ink: '#FFFFFF', sub: 'rgba(255,255,255,0.86)', chip: 'rgba(255,255,255,0.22)' }
    : { ink: 'var(--ink)', sub: 'var(--ink-2)', chip: 'rgba(255,255,255,0.62)' };
}

/** Lo stile di una pillola `.dk-pill--tint` col colore `color`: accesa, il
 *  fondo è il colore pieno, e il testo era sempre scuro anche sull'indaco o
 *  sul blu notte di un'operatrice (pills.css legge --pill-ink). */
export const pillVars = (color) => ({ '--pill-c': color, '--pill-ink': inkOn(color).ink });

/** "#RRGGBB" → { h: 0..360, s: 0..1, l: 0..1 }, o null. */
export function hexToHsl(color) {
  const rgb = hexRgb(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => c / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

/** HSL (h 0..360, s e l 0..1) → "#RRGGBB" maiuscolo. */
export function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [0, 8, 4].map((n) => Math.round(255 * f(n)).toString(16).padStart(2, '0')).join('').toUpperCase();
}
