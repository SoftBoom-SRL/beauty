// useProductCatalog — catalogo prodotti per i picker del POS (CartTab, SellModal).
// Carica una prima pagina; se il catalogo è più grande di quanto caricato
// (r.count > articoli ricevuti) la ricerca digitata interroga anche il server,
// così oltre i primi POS_PAGE prodotti si vende comunque tutto. Prima il
// catalogo veniva letto una sola volta con limit 100 e il resto non era vendibile.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { productsApi } from '../../api/inventory.js';

export const POS_PAGE = 200;
const sellable = (items) => (items || []).filter((p) => Number(p.sale_price) > 0);
const matches = (p, needle) => (
  p.name.toLowerCase().includes(needle)
  || (p.sku || '').toLowerCase().includes(needle)
  || (p.brand || '').toLowerCase().includes(needle)
);

export default function useProductCatalog(q, { onError } = {}) {
  const [products, setProducts] = useState(null); // null = caricamento
  const [loaded, setLoaded] = useState(0);        // articoli ricevuti (prima del filtro vendibili)
  const [count, setCount] = useState(0);          // totale a catalogo
  const [remote, setRemote] = useState(null);     // risultati server per la ricerca corrente

  // `reloadKey` forza la rilettura del catalogo: dopo una vendita le giacenze
  // mostrate erano quelle di prima, e il banco continuava a proporre un
  // prodotto già esaurito finché non si cambiava sezione.
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let dead = false;
    productsApi.list({ limit: POS_PAGE })
      .then((r) => {
        if (dead) return;
        const items = r.items || [];
        setProducts(sellable(items));
        setLoaded(items.length);
        setCount(r.count ?? items.length);
      })
      .catch((err) => { if (dead) return; setProducts([]); onError?.(err); });
    return () => { dead = true; };
  }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const partial = products !== null && count > loaded;
  const needle = (q || '').trim().toLowerCase();

  useEffect(() => {
    if (!partial || !needle) { setRemote(null); return undefined; }
    let dead = false;
    const timer = setTimeout(() => {
      productsApi.list({ q: needle, limit: POS_PAGE })
        .then((r) => { if (!dead) setRemote(sellable(r.items)); })
        .catch(() => { if (!dead) setRemote([]); });
    }, 250);
    return () => { dead = true; clearTimeout(timer); };
  }, [needle, partial]);

  const list = useMemo(() => {
    const base = products || [];
    if (!needle) return base;
    const local = base.filter((p) => matches(p, needle));
    if (!remote) return local;
    const seen = new Set(local.map((p) => p.id));
    return [...local, ...remote.filter((p) => !seen.has(p.id))];
  }, [products, needle, remote]);

  return { products, list, partial, refresh, searching: partial && !!needle && remote === null };
}
