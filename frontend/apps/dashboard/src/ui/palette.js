// palette.js — le tavolozze di colori della dashboard (logica pura).
//   GD_PALETTE   griglia «alla Google Docs» (brand, categorie, operatrici)
//   CAT_SWATCHES dieci tinte chiare per le categorie di servizi e prodotti
//   TREATMENT_SWATCHES le tinte dei trattamenti in tre file: vivaci, scure, tenui

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

/* Le tinte proposte per le categorie dei TRATTAMENTI. C'erano solo le dieci
 * chiare qui sopra, tutte pastello: in agenda i blocchi di categorie diverse
 * si confondevano e bisognava leggere per capire che lavoro fosse. Ora tre
 * file: vivaci e scure sature, con le tinte ben distanti fra loro (rosso,
 * arancio, ambra, verde chiaro, verde, petrolio, azzurro, blu, viola, rosa),
 * poi le tenui di prima per chi le preferisce. Sui blocchi scuri il testo
 * diventa bianco da solo (sections/agenda/lib/colors.js). */
export const TREATMENT_SWATCHES = [
  { key: 'vivid', it: 'Vivaci', en: 'Vivid', colors: ['#E53935', '#FB8C00', '#F9A825', '#5FA81E', '#16A34A', '#00897B', '#039BE5', '#4F46E5', '#8E24AA', '#D81B60'] },
  { key: 'deep', it: 'Scure', en: 'Deep', colors: ['#B71C1C', '#BF360C', '#7A5200', '#33691E', '#1B5E20', '#00574B', '#01579B', '#1A237E', '#4A148C', '#880E4F'] },
  { key: 'soft', it: 'Tenui', en: 'Soft', colors: CAT_SWATCHES },
];

/** Il colore di una categoria di trattamenti nuova: la prima tinta vivace che
 *  le categorie `list` non hanno ancora. A caso nella griglia usciva spesso un
 *  grigio o un pastello quasi uguale a una categoria che c'era già. */
export function nextTreatmentColor(list) {
  const used = new Set((list || []).map((c) => String(c.color || '').toLowerCase()));
  const vivid = TREATMENT_SWATCHES[0].colors;
  return vivid.find((c) => !used.has(c.toLowerCase())) ?? vivid[(list || []).length % vivid.length];
}
