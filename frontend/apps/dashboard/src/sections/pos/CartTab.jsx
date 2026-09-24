// CartTab — "Prodotti": quick counter sale (walk-in POS), not tied to an appointment.
// Products from GET /api/inventory/products (retail = sale_price), submit → POST /api/sales/pos.
import { useState } from 'react';
import { Avatar, Icon, toastApiError } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import ClientPicker from './ClientPicker.jsx';
import PaymentsPanel from './PaymentsPanel.jsx';
import CouponField from './CouponField.jsx';
import ConfirmPaymentModal from './ConfirmPaymentModal.jsx';
import SaleDone from './cart/SaleDone.jsx';
import ProductGrid from './cart/ProductGrid.jsx';
import GiftCardBuilder from './cart/GiftCardBuilder.jsx';
import CartLine from './cart/CartLine.jsx';
import SaleDiscount from './cart/SaleDiscount.jsx';
import { useCoupon, useCouponRoom } from './useCoupon.js';
import { counterDiscountPct, counterGiftLine, counterProductLine, toApiLine } from './lines.js';
import useProductCatalog from './useProductCatalog.js';
import { salesApi } from '../../api/sales.js';
import {
  centsToEur, emptyPayments, lineCents, money, opName,
  paymentsError, resolvePayments, saleTotals, toCents,
} from './lib.js';

export default function CartTab({ onGoHistory }) {
  const { t, lang, operators, opColors, fireToast, hasScope } = useDash();
  const canSell = hasScope('sales');

  /* ---- products: prima pagina + ricerca lato server oltre la pagina ---- */
  const [q, setQ] = useState('');
  const { products, list: prodList, searching, refresh: refreshProducts } = useProductCatalog(q, {
    onError: (err) => toastApiError(err, fireToast, t),
  });

  /* ---- cart ---- */
  // line: { key, line_type:'product'|'gift_card', product_id, name, unit_price, qty, is_gift, disc, stock, value, recipient_name }
  const [cart, setCart] = useState([]);
  const [globalDisc, setGlobalDisc] = useState(0);
  const [clientSel, setClientSel] = useState(null);
  const [sellerId, setSellerId] = useState(() => operators[0]?.id ?? null);
  const [pay, setPay] = useState(emptyPayments());
  const [giftAmt, setGiftAmt] = useState('50');
  const [giftName, setGiftName] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null); // SaleDetailOut after a successful sale
  const [confirmOpen, setConfirmOpen] = useState(false); // conferma prima di finalizzare
  /* Buono sconto al banco: stesso campo del check-out (useCoupon). Il
   * server lo rivalida e lo consuma; qui serve a mostrare il dovuto giusto. */
  const cp = useCoupon(t);
  const { coupon, setCoupon, setCouponCode, setCouponErr } = cp;

  const addProduct = (p) => {
    setCart((c) => {
      const existing = c.find((l) => l.line_type === 'product' && l.product_id === p.id);
      const stock = p.stock_qty != null ? Number(p.stock_qty) : null;
      if (existing) {
        if (stock != null && existing.qty >= stock) {
          fireToast({ msg: t('Giacenza insufficiente', 'Not enough stock'), icon: 'alert' });
          return c;
        }
        return c.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l));
      }
      if (stock != null && stock < 1) {
        fireToast({ msg: t('Giacenza insufficiente', 'Not enough stock'), icon: 'alert' });
        return c;
      }
      return [...c, counterProductLine('p' + p.id + '_' + Date.now(), p, stock)];
    });
  };
  const addGiftCard = () => {
    const v = centsToEur(toCents(giftAmt));
    if (!(v > 0)) return;
    setCart((c) => [...c, counterGiftLine('g' + Date.now(), v, giftName, lang)]);
    setGiftName('');
  };
  const patchLine = (key, patch) => setCart((c) => c.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const stepQty = (l, d) => {
    const next = l.qty + d;
    if (next < 1) return;
    if (d > 0 && l.stock != null && next > l.stock) {
      fireToast({ msg: t('Giacenza insufficiente', 'Not enough stock'), icon: 'alert' });
      return;
    }
    patchLine(l.key, { qty: next });
  };
  const removeLine = (key) => setCart((c) => c.filter((l) => l.key !== key));

  /* ---- totals (global discount maps to per-line discount_pct for lines without their own) ----
   * In centesimi con gli arrotondamenti del server (money.js): è quello che il
   * server ricalcola, e il pagamento deve coincidere al centesimo. */
  const effDisc = (l) => counterDiscountPct(l, globalDisc);
  // Si spedisce esattamente il prezzo da cui si è calcolato il conto (lines.js).
  const asApiLine = (l) => toApiLine(l, effDisc(l));
  const lineVal = (l) => centsToEur(lineCents({ ...l, discount_pct: effDisc(l) }));
  // Le gift card vendute restano fuori dal buono: scontarne una da 100
  // incassandone 80 significa regalare la differenza (regola del server).
  const totals = saleTotals(cart.map((l) => ({ ...l, discount_pct: effDisc(l) })), coupon);
  const subtotalCents = cart.reduce((s, l) => s + lineCents({ ...l, discount_pct: 0 }), 0);
  const couponBaseCents = totals.couponBaseCents;
  const couponAmt = centsToEur(totals.discountCents);
  const totalCents = totals.totalCents;
  const total = centsToEur(totalCents);
  const discAmt = centsToEur(subtotalCents - totals.grossCents);
  const itemCount = cart.reduce((s, l) => s + (l.qty || 1), 0);
  const payErr = paymentsError(pay, totalCents, t);
  const seller = operators.find((o) => o.id === Number(sellerId)) || null;

  /* Il buono applicato va rivisto quando il conto cambia sotto di lui (14-12,
   * vedi useCouponRoom) o quando cambia la cliente (qui sotto). */
  useCouponRoom(cp, couponBaseCents, t);
  const changeClient = (c) => {
    setClientSel(c);
    // Un buono intestato vale solo per la sua cliente (come in findCoupon).
    if (coupon?.client_id && coupon.client_id !== (c?.id ?? null)) {
      setCoupon(null);
      setCouponErr(coupon.client_name
        ? t(`Buono tolto: è riservato a ${coupon.client_name}`, `Voucher removed: it is reserved for ${coupon.client_name}`)
        : t('Buono tolto: è riservato a un’altra cliente', 'Voucher removed: it is reserved for another client'));
    }
  };

  const applyCoupon = () => cp.applyCoupon({ baseCents: couponBaseCents, clientId: clientSel?.id ?? null });

  /* ---- submit ---- */
  const complete = async () => {
    if (saving || !cart.length) return;
    if (payErr) { fireToast({ msg: payErr, icon: 'alert' }); return; }
    setSaving(true);
    try {
      const sale = await salesApi.pos({
        client_id: clientSel ? clientSel.id : null,
        blocks: [{ operator_id: seller ? seller.id : null, lines: cart.map(asApiLine) }],
        payments: resolvePayments(pay, totalCents),
        ...(coupon ? { coupon_code: coupon.code } : {}),
      });
      setDone(sale);
      refreshProducts();  // le giacenze sono cambiate: il banco deve vederlo subito
      fireToast({ msg: t(`Vendita registrata · ${money(sale.total, lang)}`, `Sale recorded · ${money(sale.total, lang)}`), icon: 'check' });
    } catch (err) {
      setConfirmOpen(false);
      toastApiError(err, fireToast, t);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setCart([]); setClientSel(null); setGlobalDisc(0); setQ('');
    setPay(emptyPayments()); setGiftAmt('50'); setGiftName(''); setDone(null); setConfirmOpen(false);
    setCoupon(null); setCouponCode(''); setCouponErr(null);
  };

  /* ---- completion screen ---- */
  if (done) {
    return <SaleDone done={done} seller={seller} onNew={reset} onGoHistory={onGoHistory} t={t} lang={lang} />;
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', gap: 22, alignItems: 'start' }}>
      {/* LEFT — catalogue */}
      <div>
        <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16 }}>
          {t('Vendita rapida da banco, senza appuntamento. Aggiungi prodotti, poi incassa.', 'Quick counter sale, no appointment. Add products, then take payment.')}
        </div>
        <div className="dk-search" style={{ width: '100%', marginBottom: 16 }}>
          <Icon name="search" size={18} color="var(--muted-2)" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Cerca per nome o codice a barre…', 'Search by name or barcode…')} />
          {q && <button onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={15} color="var(--muted-2)" /></button>}
        </div>

        <ProductGrid products={products} list={prodList} cart={cart} searching={searching} onAdd={addProduct} t={t} lang={lang} />

        {/* gift-card line builder */}
        <GiftCardBuilder amt={giftAmt} setAmt={setGiftAmt} name={giftName} setName={setGiftName} onAdd={addGiftCard} t={t} />
      </div>

      {/* RIGHT — cart / checkout */}
      <div className="dk-card" style={{ position: 'sticky', top: 0, display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - var(--top-h) - 68px)', overflow: 'hidden' }}>
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--hair)', display: 'flex', alignItems: 'center', gap: 9 }}>
          <Icon name="wallet" size={19} color="var(--clay-ink)" />
          <div style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500, flex: 1 }}>{t('Carrello', 'Cart')}</div>
          {itemCount > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '3px 10px', borderRadius: 99 }}>{itemCount} {t('art.', 'items')}</span>}
        </div>

        {/* riepilogo totale — in alto */}
        <div style={{ flexShrink: 0, padding: '12px 20px', borderBottom: '1px solid var(--hair)', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          {discAmt > 0 || couponAmt > 0 ? (
            <div>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{t('Totale', 'Total')}</span>
              {discAmt > 0 && <div className="t-sm" style={{ color: 'var(--clay-ink)', fontWeight: 600 }}>{t('Sconto', 'Discount')} · −{money(discAmt, lang)}</div>}
              {couponAmt > 0 && <div className="t-sm" style={{ color: 'var(--clay-ink)', fontWeight: 600 }}>{t('Buono', 'Voucher')} {coupon.code} · −{money(couponAmt, lang)}</div>}
            </div>
          ) : <span style={{ fontWeight: 700, fontSize: 15 }}>{t('Totale', 'Total')}</span>}
          <span className="t-num" style={{ fontSize: 24, fontWeight: 800 }}>{money(total, lang)}</span>
        </div>

        <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
          {/* client (optional) */}
          <div className="t-meta" style={{ marginBottom: 7 }}>{t('Cliente (facoltativo)', 'Client (optional)')}</div>
          <div style={{ marginBottom: 16 }}>
            <ClientPicker value={clientSel} onChange={changeClient} t={t} />
          </div>

          {/* line items */}
          {cart.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '36px 12px', color: 'var(--muted-2)' }}>
              <Icon name="box" size={30} color="var(--faint)" />
              <div className="t-sm" style={{ marginTop: 10 }}>{t('Il carrello è vuoto', 'The cart is empty')}</div>
              <div className="t-sm" style={{ marginTop: 2 }}>{t('Aggiungi prodotti dal catalogo', 'Add products from the catalogue')}</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cart.map((l) => (
                <CartLine key={l.key} l={l} val={lineVal(l)} d={effDisc(l)} onPatch={patchLine} onStep={stepQty} onRemove={removeLine} t={t} lang={lang} />
              ))}
            </div>
          )}

          {/* seller — credit for productivity */}
          <div className="t-meta" style={{ margin: '18px 0 8px' }}>{t('Operatrice · accredito vendita', 'Stylist · sale credit')}</div>
          <select value={sellerId ?? ''} onChange={(e) => setSellerId(Number(e.target.value))}
            style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14, fontWeight: 600, padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', cursor: 'pointer', color: 'var(--ink)' }}>
            {operators.map((o) => <option key={o.id} value={o.id}>{opName(o)}</option>)}
          </select>
          {seller && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 8 }}>
              <Avatar initials={seller.initials} size={22} color={opColors[seller.id]} />
              <span className="t-sm" style={{ flex: 1, color: 'var(--muted)' }}>{t('Vendita accreditata a', 'Sale credited to')} {opName(seller)}</span>
            </div>
          )}

          {/* sale-level discount */}
          <SaleDiscount value={globalDisc} onChange={setGlobalDisc} t={t} />

          {/* buono sconto — prima del pagamento, così il dovuto è già quello giusto */}
          <CouponField cp={cp} onApply={applyCoupon} discount={couponAmt}
            label={t('Buono sconto (facoltativo)', 'Voucher (optional)')} placeholder={t('Codice del buono', 'Voucher code')}
            style={{ margin: '18px 0 0' }} labelStyle={{ marginBottom: 7 }} t={t} lang={lang} />

          {/* metodo di pagamento — in basso */}
          <div style={{ margin: '18px 0 0' }}>
            <PaymentsPanel value={pay} onChange={setPay} dueCents={totalCents} t={t} lang={lang} compact />
          </div>
        </div>

        {/* footer — solo il pulsante (il totale è in alto) */}
        <div style={{ flexShrink: 0, padding: '14px 20px 16px', borderTop: '1px solid var(--hair)', background: 'var(--surface)' }}>
          <button className="dk-btn dk-btn--clay" style={{ width: '100%', height: 50, fontSize: 15, fontWeight: 700 }}
            disabled={!cart.length || saving || !canSell || !!payErr} onClick={() => setConfirmOpen(true)}
            title={!canSell ? t('Permesso "vendite" mancante', 'Missing "sales" permission') : (payErr || undefined)}>
            <Icon name="check" size={19} color="#fff" />{t('Completa vendita', 'Complete sale')} · {money(total, lang)}
          </button>
          <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 9, textAlign: 'center' }}>
            {!canSell ? t('Serve il permesso "vendite" per incassare', 'The "sales" permission is required') : t('Registrazione non fiscale', 'Non-fiscal record')}
          </div>
        </div>
      </div>

      {/* conferma prima di finalizzare la vendita */}
      <ConfirmPaymentModal open={confirmOpen} saving={saving} onBack={() => setConfirmOpen(false)} onConfirm={complete}
        summary={<>{itemCount} {t('articoli', 'items')} · {money(total, lang)}{seller ? ' · ' + opName(seller) : ''}</>}
        t={t} />
    </div>
  );
}
