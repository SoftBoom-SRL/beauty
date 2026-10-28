// theme.js — il white-label dell'app cliente: dal colore del salone i toni
// derivati, il colore leggibile sopra il brand e il font dei titoli.

import { onColor } from '@youty/shared';

export function hex2rgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(h, target, amt) {
  const a = hex2rgb(h), b = hex2rgb(target);
  return '#' + a.map((x, i) => Math.round(x + (b[i] - x) * amt).toString(16).padStart(2, '0')).join('');
}

export const darken = (h) => mix(h, '#000000', 0.28);
export const tintOf = (h) => mix(h, '#ffffff', 0.86);

// Il testo leggibile sopra il brand: bianco sui brand scuri, inchiostro su
// quelli chiari. Sta in @youty/shared perché l'anteprima del brand nella
// dashboard usi la stessa regola; qui si riesporta per i moduli dell'app.
export { onColor };

/** Build a brand object from a base color (from /api/core/public/branding).
 *  `cancelMinHours` è la soglia entro cui l'app non lascia più spostare o
 *  annullare: è configurabile per salone, quindi non va scritta nei testi. Il
 *  24 è solo il valore predefinito, per il branding che non la espone ancora. */
export function makeBrand({ color, name, slug, logoUrl, address = '', phone = '', openingHours = '', privacyUrl = '', privacyHolder = '', cancelMinHours = 24, type = 'serif' }) {
  return {
    color,
    ink: darken(color),
    tint: tintOf(color),
    on: onColor(color),
    name,
    slug,
    logo: logoUrl || null,
    address,
    phone,
    openingHours,
    privacyHolder, // ragione sociale, P.IVA, sede, email: titolare nell'informativa generata
    privacyUrl, // informativa privacy DEL SALONE (è lui il titolare del trattamento)
    cancelMinHours: Number(cancelMinHours) > 0 ? Number(cancelMinHours) : 24,
    type, // 'serif' | 'grotesk' — heading typography flavour
  };
}

/** CSS custom props to spread on a style prop: <div style={brandVars(brand)}> */
export function brandVars(brand) {
  return {
    '--brand': brand.color,
    '--brand-ink': brand.ink,
    '--brand-tint': brand.tint,
    '--brand-on': onColor(brand.color),
  };
}

export const headFont = (brand) => (brand.type === 'serif' ? 'var(--serif)' : 'var(--sans)');

/** Il peso dei titoli: 500 col serif, `heavy` (800, o 700 per i titoli più
 *  piccoli) col grotesk. Va con headFont. */
export const headWeight = (brand, heavy = 800) => (brand.type === 'serif' ? 500 : heavy);
