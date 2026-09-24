// Magazzino — inventory section. Sub-tabs (ctx subTab): prodotti / ordini / fornitori / storico.
// Shared reference data (categories, suppliers, full products snapshot) is loaded here and
// passed to the sub-tabs; each sub-tab fetches its own paginated lists.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toastApiError } from '@youty/shared';
import { useDash, useLive } from '../../ctx.jsx';
import { STOCK_META } from './lib.js';
import ProdottiSub from './ProdottiSub.jsx';
import OrdiniSub from './OrdiniSub.jsx';
import FornitoriSub from './FornitoriSub.jsx';
import StoricoSub from './StoricoSub.jsx';
import { productCategoriesApi, productsApi, suppliersApi } from '../../api/inventory.js';
import SubTabs from '../../ui/SubTabs.jsx';

export default function MagazzinoSection() {
  const { t, subTab, setSubTab, fireToast, hasScope } = useDash();
  const sub = subTab || 'prodotti';
  const canWrite = hasScope('inventory');

  /* ---- shared reference data ---- */
  const [cats, setCats] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [allProds, setAllProds] = useState(null); // full snapshot for metrics/pickers/enrichment
  const [prodsPartial, setProdsPartial] = useState(false); // snapshot incompleto (catalogo oltre il tetto)

  const loadShared = useCallback(async (silent = false) => {
    try {
      const [c, s, p] = await Promise.all([
        productCategoriesApi.list(),
        suppliersApi.list(),
        // tutto il catalogo, a pagine fino a `count` (vedi productsApi.listAll)
        productsApi.listAll(),
      ]);
      setCats(c || []);
      setSuppliers(s || []);
      setAllProds(p.items);
      setProdsPartial(p.partial);
    } catch (err) {
      if (!silent) toastApiError(err, fireToast, t);
      setAllProds((prev) => prev || []);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // All'apertura non in silenzio: nessuno la chiamava con silent = false, e se
  // il primo caricamento falliva categorie, fornitori e catalogo restavano
  // vuoti (indicatori a zero, menu vuoti nei moduli) senza dire perché (voce
  // 39). Le riletture (feed live, dopo una scrittura) restano silenziose.
  useEffect(() => { loadShared(); }, [loadShared]);
  const refreshShared = useCallback(() => { loadShared(true); }, [loadShared]);
  /* Da un'altra postazione (o da una vendita: `stock.sold`) si aggiornavano
   * solo le cifre in testata: la riga del prodotto mostrava la giacenza vecchia
   * e un ordine inviato altrove restava «Bozza» con «Conferma e invia», che poi
   * rispondeva 400 (15-21, 09-08). Il feed ricarica anche le liste paginate. */
  const [liveTick, setLiveTick] = useState(0);
  useLive(/^(product|stock|order|supplier)\./, () => { refreshShared(); setLiveTick((n) => n + 1); });

  const lowCount = useMemo(
    () => (allProds || []).filter((p) => p.active && p.stock_state === 'low').length,
    [allProds],
  );

  const tabs = [
    ['prodotti', t('Prodotti', 'Products')],
    ['ordini', t('Ordini', 'Orders')],
    ['fornitori', t('Fornitori', 'Suppliers')],
    ['storico', t('Storico', 'History')],
  ];

  const shared = { cats, suppliers, allProds, prodsPartial, canWrite, refreshShared, liveTick };

  return (
    <div className="dk-page" style={{ maxWidth: 1080 }}>
      {/* sub-tabs */}
      <SubTabs tabs={tabs} value={sub} onChange={setSubTab} tabStyle={{ position: 'relative' }}
        extra={(k) => k === 'ordini' && lowCount > 0 && <span style={{ position: 'absolute', top: 6, right: -2, width: 7, height: 7, borderRadius: 99, background: STOCK_META.low.color }} />} />

      {allProds === null ? (
        /* boot skeleton for the whole section */
        <div>
          <div style={{ display: 'flex', gap: 14, marginBottom: 16 }}>
            {[...Array(3)].map((_, i) => <div key={i} className="skel" style={{ flex: 1, height: 74, borderRadius: 14 }} />)}
          </div>
          <div className="skel" style={{ height: 42, borderRadius: 999, marginBottom: 16 }} />
          <div className="skel" style={{ height: 320, borderRadius: 16 }} />
        </div>
      ) : (
        <React.Fragment>
          {sub === 'prodotti' && <ProdottiSub {...shared} />}
          {sub === 'ordini' && <OrdiniSub {...shared} />}
          {sub === 'fornitori' && <FornitoriSub {...shared} />}
          {sub === 'storico' && <StoricoSub {...shared} />}
        </React.Fragment>
      )}
    </div>
  );
}
