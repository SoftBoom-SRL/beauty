// palette.js — le tavolozze di colori della dashboard (logica pura).
//   GD_PALETTE   griglia «alla Google Docs» (brand, categorie, operatrici)
//   CAT_SWATCHES dieci tinte chiare per le categorie di servizi e prodotti

/* ---- Google-Docs-style colour palette (port of prototype GD_PALETTE) ---- */
export function gdHexFromHSL(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return ('#' + f(0) + f(8) + f(4)).toUpperCase();
}
const GD_HUES = [0, 22, 45, 90, 140, 175, 205, 230, 265, 300];
export const GD_PALETTE = (() => {
  const rows = [];
  rows.push(['#000000', '#434343', '#666666', '#999999', '#B7B7B7', '#CCCCCC', '#D9D9D9', '#EFEFEF', '#F3F3F3', '#FFFFFF']);
  rows.push(GD_HUES.map((h) => gdHexFromHSL(h, 78, 50)));
  [92, 84, 74].forEach((l) => rows.push(GD_HUES.map((h) => gdHexFromHSL(h, 70, l))));
  [40, 30, 20].forEach((l) => rows.push(GD_HUES.map((h) => gdHexFromHSL(h, 65, l))));
  return rows;
})();

export const CAT_SWATCHES = ['#FDE2E4', '#DBEAFE', '#DCFCE7', '#FEF3C7', '#FCE7F3', '#EDE9FE', '#E0E7FF', '#FEE2E2', '#E0F2FE', '#F1F5F9'];
