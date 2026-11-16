// Le cartelle dei servizi in cassa: una per categoria, come nel passo dei
// servizi di «Nuova prenotazione» (ServiceStep). In cassa «Servizio extra»
// mostrava l'elenco intero in un riquadro alto 200 px, e con decine di
// trattamenti si scorreva alla cieca (Beauty Boutique, 11/2026).

/* Le cartelle con almeno un servizio, nell'ordine delle categorie; in fondo
 * «Altri servizi» per quelli senza categoria (o con una categoria che non c'è
 * più). `null` quando le cartelle non servono: nessuna categoria, o una sola
 * cartella (sarebbe solo un clic in più). */
export function serviceFolders(services, categories, lang, t) {
  if (!categories || !categories.length) return null;
  const ids = new Set(categories.map((c) => c.id));
  const catOf = (s) => (ids.has(s.category_id) ? s.category_id : 'none');
  const folders = [
    ...categories.map((c) => ({ id: c.id, name: lang === 'en' && c.name_en ? c.name_en : c.name_it, color: c.color || null })),
    { id: 'none', name: t('Altri servizi', 'Other services'), color: null },
  ].map((f) => ({ ...f, items: services.filter((s) => catOf(s) === f.id) })).filter((f) => f.items.length);
  return folders.length > 1 ? folders : null;
}
