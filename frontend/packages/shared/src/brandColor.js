// brandColor.js — il testo leggibile sopra il colore del brand (logica pura):
// bianco sui brand scuri, inchiostro su quelli chiari. Lo usano l'app cliente
// (theme.js, --brand-on) e l'anteprima del brand nella dashboard
// (Impostazioni → Brand): prima l'anteprima scriveva sempre in bianco, e su un
// brand chiaro mostrava un testo che l'app poi non avrebbe avuto.

/** "#RRGGBB" → il colore del testo sopra: '#FFFFFF' o l'inchiostro '#211C18'. */
export function onColor(hex) {
  const n = parseInt(String(hex || '').slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; // relative luminance approx.
  return lum > 0.62 ? '#211C18' : '#FFFFFF';
}
