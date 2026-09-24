// desktop-pos.jsx — Punto Vendita (POS): quick sale not tied to an appointment
const { useState: useStatePos, useMemo: useMemoPos } = React;

// example past sales — newest first
const POS_SALES_SEED = [
  { id: 'sv1', date: '2026-06-24T11:48', sellerId: 'lina', clientId: 'c1', method: 'carta', items: [{ kind: 'product', name: { it: 'Siero viso', en: 'Face serum' }, price: 38, qty: 1 }, { kind: 'product', name: { it: 'Crema mani', en: 'Hand cream' }, price: 14, qty: 1 }] },
  { id: 'sv2', date: '2026-06-24T10:12', sellerId: 'giulia', clientId: null, method: 'contanti', items: [{ kind: 'product', name: { it: 'Olio cuticole', en: 'Cuticle oil' }, price: 12, qty: 2 }] },
  { id: 'sv3', date: '2026-06-23T17:30', sellerId: 'asia', clientId: 'c2', method: 'carta', items: [{ kind: 'gift', name: { it: 'Gift card · €100', en: 'Gift card · €100' }, price: 100, qty: 1 }] },
  { id: 'sv4', date: '2026-06-23T15:05', sellerId: 'mara', clientId: null, method: 'carta', items: [{ kind: 'product', name: { it: 'Maschera capelli', en: 'Hair mask' }, price: 24, qty: 1 }, { kind: 'product', name: { it: 'Shampoo ristrutturante', en: 'Repair shampoo' }, price: 19, qty: 1 }] },
  { id: 'sv5', date: '2026-06-22T18:40', sellerId: 'vera', clientId: 'c3', method: 'altro', items: [{ kind: 'product', name: { it: 'Smalto a casa', en: 'Take-home polish' }, price: 16, qty: 1 }, { kind: 'product', name: { it: 'Top coat lucidante', en: 'Glossy top coat' }, price: 15, qty: 1 }] },
  { id: 'sv6', date: '2026-06-20T12:20', sellerId: 'sole', clientId: null, method: 'contanti', items: [{ kind: 'gift', name: { it: 'Gift card · €50', en: 'Gift card · €50' }, price: 50, qty: 1 }, { kind: 'product', name: { it: 'Crema mani', en: 'Hand cream' }, price: 14, qty: 1 }] },
];
function posSaleTotal(s) { return s.items.reduce((a, l) => a + l.price * l.qty, 0); }
function posSaleCount(s) { return s.items.reduce((a, l) => a + l.qty, 0); }
function posDateLabel(iso, lang) {
  const d = new Date(iso); const today = new Date('2026-06-24T23:59');
  const day0 = new Date(d); day0.setHours(0, 0, 0, 0);
  const t0 = new Date(today); t0.setHours(0, 0, 0, 0);
  const diff = Math.round((t0 - day0) / 86400000); const hm = iso.slice(11, 16);
  if (diff === 0) return (lang === 'en' ? 'Today' : 'Oggi') + ' · ' + hm;
  if (diff === 1) return (lang === 'en' ? 'Yesterday' : 'Ieri') + ' · ' + hm;
  const months = lang === 'en' ? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] : ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() + ' · ' + hm;
}

function DkPos() {
  const { t, lang, fireToast, giftcards, setGiftcards, commission, subTab, setSubTab } = useDk();

  const [sales, setSales] = useStatePos(() => POS_SALES_SEED.map(s => ({ ...s })));

  // cart: { key, kind:'product'|'gift', id, name, price, qty }
  const [cart, setCart] = useStatePos([]);
  const [globalDisc, setGlobalDisc] = useStatePos(0);
  const [q, setQ] = useStatePos('');
  const tab = subTab || 'products';
  const setTab = setSubTab;
  const [clientId, setClientId] = useStatePos(null);
  const [clientQuery, setClientQuery] = useStatePos('');
  const [clientPick, setClientPick] = useStatePos(false);
  const [sellerId, setSellerId] = useStatePos('sole');
  const [method, setMethod] = useStatePos('carta');
  const [giftAmt, setGiftAmt] = useStatePos(50);
  const [done, setDone] = useStatePos(false);

  const methods = [['carta', t('Carta', 'Card')], ['contanti', t('Contanti', 'Cash')], ['altro', t('Altro', 'Other')]];
  const seller = op(sellerId);
  const sellerPct = commission[sellerId] || 0;

  const prodList = useMemoPos(() => RETAIL.filter(p => !q || p.name[lang].toLowerCase().includes(q.toLowerCase())), [q, lang]);
  const clientList = useMemoPos(() => CLIENTS.filter(c => !clientQuery || c.name.toLowerCase().includes(clientQuery.toLowerCase())).slice(0, 20), [clientQuery]);
  const selClient = clientId ? client(clientId) : null;

  const addLine = (line) => setCart(c => {
    const existing = c.find(l => l.kind === line.kind && l.id === line.id);
    if (existing) return c.map(l => l === existing ? { ...l, qty: l.qty + 1 } : l);
    return [...c, { ...line, key: line.kind + '_' + line.id + '_' + Date.now(), qty: 1 }];
  });
  const addProduct = (p) => addLine({ kind: 'product', id: p.id, name: p.name[lang], price: p.price });
  const addGift = () => { if (giftAmt > 0) addLine({ kind: 'gift', id: 'g' + giftAmt, name: t('Gift card', 'Gift card') + ' · €' + giftAmt, price: giftAmt }); };
  const setQty = (key, d) => setCart(c => c.map(l => l.key === key ? { ...l, qty: Math.max(1, l.qty + d) } : l));
  const toggleGift = (key) => setCart(c => c.map(l => l.key === key ? { ...l, gifted: !l.gifted } : l));
  const removeLine = (key) => setCart(c => c.filter(l => l.key !== key));

  const subtotal = cart.reduce((s, l) => s + (l.gifted ? 0 : l.price * l.qty), 0);
  const discAmt = Math.round(subtotal * (globalDisc || 0) / 100);
  const total = subtotal - discAmt;
  const itemCount = cart.reduce((s, l) => s + l.qty, 0);
  const hasGift = cart.some(l => l.kind === 'gift');

  const complete = () => {
    const giftLines = [];
    if (giftLines.length) {
      const newCards = [];
      giftLines.forEach(l => {
        for (let i = 0; i < l.qty; i++) {
          newCards.push({
            id: 'gc' + Date.now() + Math.random().toString(36).slice(2, 5), code: 'TP-GC-' + Math.random().toString(36).slice(2, 6).toUpperCase(),
            value: l.price, used: 0, buyerId: clientId || 'c1', recipId: null, recipName: selClient ? selClient.name : t('Da banco', 'Walk-in'),
            payment: { status: 'paid', date: { it: 'Oggi', en: 'Today' }, method: { it: methods.find(m => m[0] === method)[1], en: methods.find(m => m[0] === method)[1] } },
            delivery: { mode: 'hand', date: '', time: '09:00' }, expiry: { it: '6 mesi', en: '6 months' }, status: 'active',
          });
        }
      });
      setGiftcards(l => [...newCards, ...l]);
    }
    // record the sale in history
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    setSales(l => [{ id: 'sv' + Date.now(), date: iso, sellerId, clientId: clientId || null, method, discount: globalDisc || 0, items: cart.map(c => ({ kind: c.kind, name: { it: c.name, en: c.name }, price: c.gifted ? 0 : Math.round(c.price * (1 - (globalDisc || 0) / 100)), qty: c.qty, gifted: !!c.gifted })) }, ...l]);
    setDone(true);
    fireToast({ msg: t(`Vendita registrata · ${fmtEur(total, lang)} · accreditata a ${seller.name}`, `Sale recorded · ${fmtEur(total, lang)} · credited to ${seller.name}`), icon: 'check' });
  };

  const reset = () => { setCart([]); setClientId(null); setClientQuery(''); setMethod('carta'); setGlobalDisc(0); setQ(''); setDone(false); };

  const subTabs = (
    <div style={{ borderBottom: '1px solid var(--hair)', display: 'flex', gap: 4, marginBottom: 18 }}>
      {[['products', t('Prodotti', 'Products'), 'box'], ['history', t('Storico', 'History'), 'clock']].map(([k, l, ic]) => {
        const on = tab === k;
        return <button key={k} onClick={() => { setTab(k); if (done) setDone(false); }} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 4px', marginRight: 18, borderBottom: '2px solid ' + (on ? 'var(--clay)' : 'transparent'), color: on ? 'var(--ink)' : 'var(--muted)', fontWeight: on ? 700 : 600, fontSize: 14.5, cursor: 'pointer', marginBottom: -1 }}><Icon name={ic} size={17} color={on ? 'var(--clay-ink)' : 'var(--muted)'} />{l}</button>;
      })}
    </div>
  );

  if (done) {
    return (
      <div className="dk-page" style={{ maxWidth: 1240 }}>
        {subTabs}
        <div className="dk-card pop-in" style={{ padding: '44px 36px', textAlign: 'center', maxWidth: 540, margin: '0 auto' }}>
          <div style={{ width: 68, height: 68, borderRadius: 99, background: 'var(--ok-tint)', display: 'grid', placeItems: 'center', margin: '0 auto 18px' }}><Icon name="check" size={34} color="var(--ok)" stroke={2.4} /></div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500 }}>{t('Vendita completata', 'Sale complete')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 6 }}>{itemCount} {t('articoli', 'items')} · {fmtEur(total, lang)} · {methods.find(m => m[0] === method)[1]}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{t('Accreditata a', 'Credited to')} {seller.name}{selClient ? ' · ' + selClient.name : ''}</div>
          {hasGift && <div className="t-sm" style={{ color: 'var(--ok)', marginTop: 10, fontWeight: 600 }}><Icon name="gift" size={15} color="var(--ok)" style={{ verticalAlign: '-2px', marginRight: 5 }} />{t('Gift card aggiunta al monitoraggio', 'Gift card added to monitoring')}</div>}
          <button className="dk-btn dk-btn--clay" style={{ marginTop: 24, width: '100%', height: 48 }} onClick={reset}><Icon name="plus" size={18} color="#fff" />{t('Nuova vendita', 'New sale')}</button>
          <button className="dk-btn dk-btn--ghost" style={{ marginTop: 10, width: '100%', height: 44 }} onClick={() => setTab('history')}><Icon name="clock" size={16} />{t('Vedi storico vendite', 'View sales history')}</button>
        </div>
      </div>
    );
  }

  if (tab === 'history') {
    return (
      <div className="dk-page" style={{ maxWidth: 1240 }}>
        {subTabs}
        <div style={{ maxWidth: 900 }}><PosHistory sales={sales} t={t} lang={lang} /></div>
      </div>
    );
  }

  return (
    <div className="dk-page" style={{ maxWidth: 1240, height: '100%', boxSizing: 'border-box' }}>
      {subTabs}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', gap: 22, alignItems: 'start', height: 'calc(100% - 62px)' }}>

        {/* LEFT — catalogo */}
        <div>
          <div style={{ marginBottom: 16 }}>
            <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Vendita rapida da banco, senza appuntamento. Aggiungi prodotti, poi incassa.', 'Quick counter sale, no appointment. Add products, then take payment.')}</div>
          </div>

          <React.Fragment>
              <div className="dk-search" style={{ width: '100%', marginBottom: 16 }}>
                <Icon name="search" size={18} color="var(--muted-2)" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Cerca un prodotto…', 'Search a product…')} />
                {q && <button onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={15} color="var(--muted-2)" /></button>}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
                {prodList.map(p => {
                  const inCart = cart.find(l => l.kind === 'product' && l.id === p.id);
                  return (
                    <button key={p.id} onClick={() => addProduct(p)} className="dk-card" style={{ padding: 16, textAlign: 'left', cursor: 'pointer', border: '1px solid ' + (inCart ? 'var(--clay)' : 'var(--hair)'), position: 'relative', transition: 'border-color 140ms' }}>
                      {inCart && <span style={{ position: 'absolute', top: 10, right: 10, minWidth: 22, height: 22, padding: '0 6px', borderRadius: 99, background: 'var(--clay)', color: '#fff', fontSize: 12, fontWeight: 700, display: 'grid', placeItems: 'center' }}>{inCart.qty}</span>}
                      <div style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', marginBottom: 12 }}><Icon name="box" size={20} color="var(--clay-ink)" /></div>
                      <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.25 }}>{p.name[lang]}</div>
                      <div className="t-num" style={{ fontSize: 16, fontWeight: 700, marginTop: 7 }}>{fmtEur(p.price, lang)}</div>
                    </button>
                  );
                })}
                {!prodList.length && <div className="t-sm" style={{ color: 'var(--muted-2)', gridColumn: '1 / -1', textAlign: 'center', padding: 32 }}>{t('Nessun prodotto trovato', 'No products found')}</div>}
              </div>
          </React.Fragment>
        </div>

        {/* RIGHT — cart / checkout */}
        <div className="dk-card" style={{ position: 'sticky', top: 0, display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - var(--top-h) - 68px)', overflow: 'hidden' }}>
          <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--hair)', display: 'flex', alignItems: 'center', gap: 9 }}>
            <Icon name="wallet" size={19} color="var(--clay-ink)" />
            <div style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500, flex: 1 }}>{t('Carrello', 'Cart')}</div>
            {itemCount > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '3px 10px', borderRadius: 99 }}>{itemCount} {t('art.', 'items')}</span>}
          </div>

          <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
            {/* client (optional) */}
            <div className="t-meta" style={{ marginBottom: 7 }}>{t('Cliente (facoltativo)', 'Client (optional)')}</div>
            {selClient ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 12, background: 'var(--surface-2)', marginBottom: 16 }}>
                <Avatar initials={selClient.initials} size={32} color="var(--clay)" />
                <span style={{ flex: 1, fontWeight: 700, fontSize: 14 }}>{selClient.name}</span>
                <button className="dk-iconbtn" style={{ width: 30, height: 30 }} onClick={() => { setClientId(null); setClientQuery(''); }}><Icon name="x" size={15} /></button>
              </div>
            ) : (
              <div style={{ position: 'relative', marginBottom: 16 }}>
                <div className="dk-search" style={{ width: '100%', height: 40 }}>
                  <Icon name="search" size={16} color="var(--muted-2)" />
                  <input value={clientQuery} onChange={e => { setClientQuery(e.target.value); setClientPick(true); }} onFocus={() => setClientPick(true)} placeholder={t('Cerca o scegli dall\'elenco · "da banco"', 'Search or pick from list · "walk-in"')} />
                  <button onClick={() => setClientPick(v => !v)} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="chevD" size={15} color="var(--muted-2)" /></button>
                </div>
                {clientPick && (
                  <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20, padding: 6, boxShadow: 'var(--sh-pop)', maxHeight: 220, overflowY: 'auto' }}>
                    {clientList.map(c => (
                      <button key={c.id} className="dk-row" onClick={() => { setClientId(c.id); setClientPick(false); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 9, textAlign: 'left' }}>
                        <Avatar initials={c.initials} size={28} color="var(--clay)" />
                        <span style={{ fontWeight: 600, fontSize: 13.5 }}>{c.name}</span>
                      </button>
                    ))}
                    {!clientList.length && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: 12, textAlign: 'center' }}>{t('Nessuna cliente', 'No client found')}</div>}
                  </div>
                )}
              </div>
            )}

            {/* line items */}
            {cart.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '36px 12px', color: 'var(--muted-2)' }}>
                <Icon name="box" size={30} color="var(--faint)" />
                <div className="t-sm" style={{ marginTop: 10 }}>{t('Il carrello è vuoto', 'The cart is empty')}</div>
                <div className="t-sm" style={{ marginTop: 2 }}>{t('Aggiungi prodotti dal catalogo', 'Add products from the catalogue')}</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {cart.map(l => (
                  <div key={l.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, background: 'var(--surface-2)', border: l.gifted ? '1px solid var(--ok)' : '1px solid transparent' }}>
                    <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--surface)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={l.kind === 'gift' ? 'gift' : 'box'} size={16} color={l.gifted ? 'var(--ok)' : 'var(--clay-ink)'} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name}</div>
                      <div className="t-sm" style={{ color: l.gifted ? 'var(--ok)' : 'var(--muted)', fontWeight: l.gifted ? 700 : 400 }}>{l.gifted ? t('Omaggio', 'Free gift') : fmtEur(l.price, lang)}{!l.gifted && l.qty > 1 ? ' × ' + l.qty : ''}{l.gifted && l.qty > 1 ? ' · ×' + l.qty : ''}</div>
                    </div>
                    {l.kind === 'product' && <button onClick={() => toggleGift(l.key)} title={t('Ometti pagamento', 'Comp this item')} className="dk-iconbtn" style={{ width: 26, height: 26, flexShrink: 0, background: l.gifted ? 'var(--ok-tint)' : 'transparent', borderRadius: 7 }}><Icon name="gift" size={14} color={l.gifted ? 'var(--ok)' : 'var(--muted-2)'} /></button>}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      <button className="dk-iconbtn" style={{ width: 26, height: 26, fontSize: 16, fontWeight: 700, lineHeight: 1, color: 'var(--ink-2)' }} onClick={() => l.qty === 1 ? removeLine(l.key) : setQty(l.key, -1)}>{l.qty === 1 ? <Icon name="x" size={13} /> : '−'}</button>
                      <span className="t-num" style={{ minWidth: 18, textAlign: 'center', fontWeight: 700, fontSize: 13.5 }}>{l.qty}</span>
                      <button className="dk-iconbtn" style={{ width: 26, height: 26 }} onClick={() => setQty(l.key, 1)}><Icon name="plus" size={13} /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* seller — credit for productivity */}
            <div className="t-meta" style={{ margin: '18px 0 8px' }}>{t('Operatrice · accredito vendita', 'Stylist · sale credit')}</div>
            <select value={sellerId} onChange={e => setSellerId(e.target.value)} style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14, fontWeight: 600, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', cursor: 'pointer', color: 'var(--ink)' }}>
              {OPS.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            {total > 0 && sellerPct > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 8 }}>
                <Avatar initials={seller.initials} size={22} color={seller.color} />
                <span className="t-sm" style={{ flex: 1, color: 'var(--muted)' }}>{t('Commissione', 'Commission')} · {sellerPct}%</span>
                <span className="t-num" style={{ fontSize: 13.5, fontWeight: 700, color: seller.color }}>{fmtEur(Math.round(total * sellerPct / 100), lang)}</span>
              </div>
            )}

            {/* payment method */}
            <div className="t-meta" style={{ margin: '18px 0 8px' }}>{t('Metodo di pagamento', 'Payment method')}</div>
            <div style={{ display: 'flex', gap: 8 }}>{methods.map(([k, l]) => <button key={k} onClick={() => setMethod(k)} style={{ flex: 1, padding: '10px', borderRadius: 10, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (method === k ? 'var(--ink)' : 'var(--hair)'), background: method === k ? 'var(--ink)' : 'var(--surface)', color: method === k ? '#fff' : 'var(--ink)' }}>{l}</button>)}</div>

            {/* sale-level discount */}
            <div className="t-meta" style={{ margin: '18px 0 8px' }}>{t('Sconto sulla vendita', 'Sale discount')}</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {[0, 10, 15, 20].map(p => { const on = globalDisc === p; return (
                <button key={p} onClick={() => setGlobalDisc(p)} style={{ flex: 1, padding: '9px 0', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{p === 0 ? t('No', 'No') : p + '%'}</button>
              ); })}
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, border: '1px solid ' + (globalDisc && ![10,15,20].includes(globalDisc) ? 'var(--clay)' : 'var(--hair)'), borderRadius: 9, padding: '0 9px', height: 36, background: 'var(--surface)' }}>
                <input type="number" min={0} max={100} value={globalDisc || 0} onChange={e => setGlobalDisc(Math.max(0, Math.min(100, parseInt(e.target.value) || 0)))} style={{ width: 34, textAlign: 'right', border: 'none', outline: 'none', background: 'transparent', fontSize: 13.5, fontWeight: 700, fontFamily: 'var(--mono, monospace)' }} />
                <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>%</span>
              </div>
            </div>
          </div>

          {/* footer total + complete */}
          <div style={{ flexShrink: 0, padding: '14px 20px 16px', borderTop: '1px solid var(--hair)', background: 'var(--surface)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
              {globalDisc > 0 ? (
                <div>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{t('Totale', 'Total')}</span>
                  <div className="t-sm" style={{ color: 'var(--clay-ink)', fontWeight: 600 }}>{t('Sconto', 'Discount')} -{globalDisc}% · −{fmtEur(discAmt, lang)}</div>
                </div>
              ) : <span style={{ fontWeight: 700, fontSize: 15 }}>{t('Totale', 'Total')}</span>}
              <span className="t-num" style={{ fontSize: 24, fontWeight: 800 }}>{total === 0 ? '€0' : fmtEur(total, lang)}</span>
            </div>
            <button className="dk-btn dk-btn--clay" style={{ width: '100%', height: 50, fontSize: 15, fontWeight: 700 }} disabled={!cart.length} onClick={complete}><Icon name="check" size={19} color="#fff" />{t('Completa vendita', 'Complete sale')}</button>
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 9, textAlign: 'center' }}>{t('Registrazione non fiscale', 'Non-fiscal record')}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PosHistory({ sales, t, lang }) {
  const [q, setQ] = useStatePos('');
  const [seller, setSeller] = useStatePos('all');
  const [pay, setPay] = useStatePos('all');
  const [openId, setOpenId] = useStatePos(null);
  const methodLabel = { carta: t('Carta', 'Card'), contanti: t('Contanti', 'Cash'), altro: t('Altro', 'Other') };
  const sellers = OPS.filter(o => sales.some(s => s.sellerId === o.id));
  const list = sales.filter(s => {
    const okS = seller === 'all' || s.sellerId === seller;
    const okP = pay === 'all' || s.method === pay;
    const cName = s.clientId ? (client(s.clientId) ? client(s.clientId).name : '') : '';
    const okQ = !q || s.items.some(l => l.name[lang].toLowerCase().includes(q.toLowerCase())) || cName.toLowerCase().includes(q.toLowerCase()) || (op(s.sellerId) && op(s.sellerId).name.toLowerCase().includes(q.toLowerCase()));
    return okS && okP && okQ;
  });
  const totRevenue = list.reduce((a, s) => a + posSaleTotal(s), 0);
  const totItems = list.reduce((a, s) => a + posSaleCount(s), 0);
  const giftSold = list.reduce((a, s) => a + s.items.filter(l => l.kind === 'gift').reduce((x, l) => x + l.price * l.qty, 0), 0);
  const inputCss = { border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13, fontWeight: 600, padding: '8px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)', cursor: 'pointer', color: 'var(--ink)' };

  return (
    <React.Fragment>
      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16 }}>{t('Tutte le vendite da banco registrate al Punto Vendita.', 'All counter sales recorded at the Point of Sale.')}</div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 18 }}>
        {[[t('Incasso totale', 'Total revenue'), totRevenue === 0 ? '€0' : fmtEur(totRevenue, lang), t('da queste vendite', 'from these sales'), 'wallet'], [t('N° vendite', 'Sales count'), String(list.length), totItems + ' ' + t('articoli venduti', 'items sold'), 'box'], [t('Gift card vendute', 'Gift cards sold'), giftSold === 0 ? '€0' : fmtEur(giftSold, lang), t('valore prepagato', 'prepaid value'), 'gift']].map(([l, v, cap, ic], i) => (
          <div key={i} className="dk-card" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}><Icon name={ic} size={15} color="var(--clay-ink)" /><span className="t-meta">{l}</span></div>
            <div className="t-num" style={{ fontSize: 20, fontWeight: 800 }}>{v}</div>
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 2 }}>{cap}</div>
          </div>
        ))}
      </div>

      {/* search + filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="dk-search" style={{ flex: 1, minWidth: 200 }}>
          <Icon name="search" size={17} color="var(--muted-2)" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Cerca per prodotto, cliente o operatrice…', 'Search by product, client or stylist…')} />
          {q && <button className="press" onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>}
        </div>
        <select value={seller} onChange={e => setSeller(e.target.value)} style={{ ...inputCss, minWidth: 140 }}>
          <option value="all">{t('Tutte le operatrici', 'All stylists')}</option>
          {sellers.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <select value={pay} onChange={e => setPay(e.target.value)} style={{ ...inputCss, minWidth: 120 }}>
          <option value="all">{t('Tutti i metodi', 'All methods')}</option>
          {Object.entries(methodLabel).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>

      <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 10 }}>{list.length} {t('vendite', 'sales')}</div>
      <div className="dk-card" style={{ overflow: 'hidden' }}>
        {list.map((s, i) => {
          const o = op(s.sellerId); const cl = s.clientId ? client(s.clientId) : null;
          const tot = posSaleTotal(s); const cnt = posSaleCount(s);
          const open = openId === s.id; const hasGift = s.items.some(l => l.kind === 'gift');
          return (
            <div key={s.id} style={{ borderTop: i ? '1px solid var(--hair)' : 'none' }}>
              <button onClick={() => setOpenId(open ? null : s.id)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', width: '100%', textAlign: 'left', cursor: 'pointer', background: 'transparent', border: 'none' }}>
                <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={hasGift ? 'gift' : 'box'} size={17} color="var(--clay-ink)" /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{cnt} {t('articoli', 'items')} · {s.items.map(l => l.name[lang] + (l.qty > 1 ? ' ×' + l.qty : '')).join(', ')}</div>
                  <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Avatar initials={o.initials} size={18} color={o.color} />{o.name}</span>
                    <span>· {methodLabel[s.method]}</span>
                    {cl ? <span>· {cl.name}</span> : <span style={{ color: 'var(--muted-2)' }}>· {t('Da banco', 'Walk-in')}</span>}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div className="t-num" style={{ fontSize: 16, fontWeight: 800 }}>{tot === 0 ? '€0' : fmtEur(tot, lang)}</div>
                  <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{posDateLabel(s.date, lang)}</div>
                </div>
                <Icon name="chevD" size={16} color="var(--muted-2)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms', flexShrink: 0 }} />
              </button>
              {open && (
                <div style={{ padding: '0 18px 16px 70px' }}>
                  <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '6px 14px' }}>
                    {s.items.map((l, j) => (
                      <div key={j} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderTop: j ? '1px solid var(--hair)' : 'none' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13.5, fontWeight: 600 }}><Icon name={l.kind === 'gift' ? 'gift' : 'box'} size={15} color="var(--muted)" />{l.name[lang]}{l.qty > 1 ? ' × ' + l.qty : ''}</span>
                        <span className="t-num" style={{ fontWeight: 700 }}>{fmtEur(l.price * l.qty, lang)}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderTop: '1px solid var(--hair)' }}>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{t('Totale', 'Total')}</span>
                      <span className="t-num" style={{ fontWeight: 800, fontSize: 16 }}>{tot === 0 ? '€0' : fmtEur(tot, lang)}</span>
                    </div>
                  </div>
                  <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 8 }}>{t('Registrazione non fiscale', 'Non-fiscal record')} · {s.id}</div>
                </div>
              )}
            </div>
          );
        })}
        {!list.length && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '36px 16px', textAlign: 'center' }}>{t('Nessuna vendita per i filtri selezionati.', 'No sales for the selected filters.')}</div>}
      </div>
    </React.Fragment>
  );
}

Object.assign(window, { DkPos, POS_SALES_SEED, posSaleTotal });
