// ProductDrawer.jsx — unified product card: create/edit form + movement log + quick load/unload.
// Ported from the prototype's ProductDrawer (which superseded ProdEditModal); mock state →
// POST/PUT /api/inventory/products, movements from GET /products/{id}/movements.
import React, { useEffect, useState } from 'react';
import { fmtEur, Icon, toastApiError, apiErrorText } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { DkModal } from '../../ui/index.js';
import { MOVE_META, STOCK_META, UNIT_OPTIONS, eur0, fmtQty, fmtWhen, num, round2, unitCost } from './lib.js';
import { Fld, MoneyBox, NumBox, Sec, inputCss } from './bits.jsx';
import { productsApi } from '../../api/inventory.js';
import CatColorControl, { CAT_FALLBACK } from './CatColorControl.jsx';
import SupplierPicker from './SupplierPicker.jsx';

export default function ProductDrawer({ prod, cats, suppliers, canWrite, onClose, onSaved, onDeleted, onAdj, onCatColor, onCreated }) {
  const { t, lang, fireToast } = useDash();
  const isNew = !!prod._new;
  const [draft, setDraft] = useState(() => (isNew ? {
    name: '', sku: '', brand: '', category_id: cats[0]?.id ?? null, usage: 'internal',
    package_unit: '', package_qty: 1, supplier_id: suppliers[0]?.id ?? null,
    purchase_price: 0, purchase_discount_pct: 0, sale_price: 0, vat_rate: 22,
    min_threshold: 3, reorder_qty: 0, active: true, initial_qty: 0,
  } : {
    name: prod.name, sku: prod.sku || '', brand: prod.brand || '', category_id: prod.category_id,
    usage: prod.usage, package_unit: prod.package_unit || '', package_qty: num(prod.package_qty) || 1,
    supplier_id: prod.supplier_id, purchase_price: num(prod.purchase_price),
    purchase_discount_pct: num(prod.purchase_discount_pct), sale_price: num(prod.sale_price),
    vat_rate: prod.vat_rate, min_threshold: num(prod.min_threshold), reorder_qty: num(prod.reorder_qty),
    active: prod.active,
  }));
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const [busy, setBusy] = useState(false);

  /* live stock comes from the API product (changes only via movements) */
  const qty = isNew ? draft.initial_qty : num(prod.stock_qty);
  const lowItem = !isNew && prod.stock_state === 'low';
  const dot = !isNew ? (STOCK_META[prod.stock_state] || STOCK_META.ok) : null;

  /* ---- movement log (existing products) ---- */
  const [moves, setMoves] = useState(null);
  useEffect(() => {
    if (isNew) return;
    let dead = false;
    productsApi.movements(prod.id, { limit: 8 })
      .then((r) => { if (!dead) setMoves(r.items || []); })
      .catch(() => { if (!dead) setMoves([]); });
    return () => { dead = true; };
  }, [isNew, prod.id, prod.stock_qty]);

  const canSave = canWrite && draft.name.trim() && draft.supplier_id != null && !busy;

  const save = async ({ reactivate = false } = {}) => {
    if (!canSave) return;
    setBusy(true);
    const payload = {
      name: draft.name.trim(), sku: draft.sku.trim(), brand: draft.brand.trim(),
      category_id: draft.category_id, usage: draft.usage,
      package_unit: draft.package_unit, package_qty: draft.package_qty || 1,
      supplier_id: draft.supplier_id,
      purchase_price: (draft.purchase_price || 0).toFixed(2),
      purchase_discount_pct: Math.round(draft.purchase_discount_pct || 0),
      sale_price: (draft.sale_price || 0).toFixed(2),
      vat_rate: draft.vat_rate,
      min_threshold: draft.min_threshold || 0, reorder_qty: draft.reorder_qty || 0,
      active: reactivate ? true : draft.active !== false,
    };
    try {
      if (isNew) {
        const created = await productsApi.create(payload);
        /* Il prodotto c'è: da qui in poi un errore non deve lasciare la scheda
         * su «Crea prodotto». Stava nello stesso try del carico della scorta
         * iniziale, e se cadeva quello un secondo clic creava un doppione (il
         * primo a zero pezzi, 15-19). Si passa alla scheda del prodotto creato,
         * da cui la scorta si carica con «+». */
        if (draft.initial_qty > 0) {
          try {
            await productsApi.load(created.id, {
              qty: draft.initial_qty, reason: t('Scorta iniziale', 'Initial stock'),
            });
          } catch (err) {
            fireToast({ msg: t('Prodotto creato, ma la scorta iniziale non è stata caricata: caricala con «+» dalla scheda', 'Product created, but the initial stock was not loaded: add it with “+” from the card') + ' (' + apiErrorText(err, t) + ')', icon: 'alert' });
            onSaved();
            if (onCreated) onCreated(created); else onClose();
            return;
          }
        }
        fireToast({ msg: t('Prodotto creato', 'Product created'), icon: 'check' });
      } else {
        await productsApi.update(prod.id, payload);
        fireToast(reactivate
          ? { msg: t('Prodotto riattivato', 'Product reactivated'), icon: 'check' }
          : { msg: t('Prodotto salvato', 'Product saved'), icon: 'check' });
      }
      onSaved();
      onClose();
    } catch (err) {
      toastApiError(err, fireToast, t);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!canWrite || busy) return;
    setBusy(true);
    try {
      await productsApi.remove(prod.id);
      fireToast({ msg: t('Prodotto disattivato', 'Product deactivated'), icon: 'x' });
      onDeleted();
      onClose();
    } catch (err) {
      toastApiError(err, fireToast, t);
    } finally {
      setBusy(false);
    }
  };

  const curUnit = draft.package_unit || t('unità', 'units');
  const selCat = cats.find((c) => c.id === draft.category_id) || null;

  return (
    <DkModal open onClose={onClose} title={isNew ? t('Nuovo prodotto', 'New product') : t('Scheda prodotto', 'Product card')} width={580}
      foot={<React.Fragment>
        {/* Un prodotto disattivato si riattiva da qui: prima «Disattiva» era un
            clic senza ritorno, perché la scheda non aveva un comando per
            rimettere `active: true` e l'elenco non mostrava i disattivati
            (15-05). La riattivazione salva anche le modifiche della scheda. */}
        {!isNew && canWrite && prod.active && <button className="dk-btn dk-btn--ghost" style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--hair))', marginRight: 'auto' }} onClick={del} disabled={busy}><Icon name="x" size={16} color="var(--danger)" />{t('Disattiva', 'Deactivate')}</button>}
        {!isNew && canWrite && !prod.active && <button className="dk-btn dk-btn--ghost" style={{ color: 'var(--ok)', borderColor: 'color-mix(in srgb, var(--ok) 40%, var(--hair))', marginRight: 'auto' }} onClick={() => save({ reactivate: true })} disabled={!canSave}><Icon name="refresh" size={16} color="var(--ok)" />{t('Riattiva', 'Reactivate')}</button>}
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        {canWrite && <button className="dk-btn dk-btn--clay" disabled={!canSave} onClick={() => save()}><Icon name="check" size={17} color="#fff" />{isNew ? t('Crea prodotto', 'Create product') : t('Salva modifiche', 'Save changes')}</button>}
      </React.Fragment>}>

      <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('Nome prodotto', 'Product name')} disabled={!canWrite}
        style={{ border: 'none', borderBottom: '2px solid var(--hair)', outline: 'none', fontSize: 21, fontWeight: 500, fontFamily: 'var(--serif)', padding: '4px 0', background: 'transparent', width: '100%', marginBottom: 8 }} />
      {!isNew && dot && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span style={{ width: 9, height: 9, borderRadius: 99, background: dot.color }} />
          <span className="t-sm" style={{ fontWeight: 700, color: dot.color }}>{dot[lang]}</span>
          <span className="t-sm" style={{ color: 'var(--muted-2)' }}>· {fmtQty(prod.stock_qty, lang)} {curUnit} · min {fmtQty(prod.min_threshold, lang)}</span>
          {!prod.active && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--surface-2)', padding: '2px 8px', borderRadius: 99 }}>{t('Disattivato', 'Inactive')}</span>}
        </div>
      )}

      {/* ── Anagrafica ── */}
      <Sec title={t('Anagrafica', 'Identity')}>
        <Fld label={'SKU / ' + t('Codice', 'Code')}>
          <input value={draft.sku} onChange={(e) => set({ sku: e.target.value })} placeholder="es. GEL-RD-001" disabled={!canWrite} style={inputCss} />
        </Fld>
        <Fld label={t('Brand', 'Brand')}>
          <input value={draft.brand} onChange={(e) => set({ brand: e.target.value })} placeholder={t("es. OPI, L'Oréal Pro…", "e.g. OPI, L'Oréal Pro…")} disabled={!canWrite} style={inputCss} />
        </Fld>
        <Fld label={t('Categoria', 'Category')} hint={t('Il colore vale per tutti i prodotti di questa categoria ed è usato anche altrove. Le altre proprietà si gestiscono nelle Impostazioni.', 'The colour applies to every product in this category and is used elsewhere too. Other properties are managed in Settings.')}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }}>
            {cats.map((c) => {
              const on = draft.category_id === c.id;
              return (
                <button key={c.id} onClick={() => canWrite && set({ category_id: on ? null : c.id })} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 13px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: c.color || CAT_FALLBACK, boxShadow: on ? '0 0 0 1.5px rgba(255,255,255,0.55)' : 'inset 0 0 0 1px rgba(0,0,0,0.08)', flexShrink: 0 }} />
                  {c.name}
                </button>
              );
            })}
            {!cats.length && <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessuna categoria', 'No categories')}</span>}
          </div>
          {canWrite && selCat && onCatColor && (
            <CatColorControl key={selCat.id} cat={selCat} onCatColor={onCatColor} t={t} />
          )}
        </Fld>
        <Fld label={t("Tipologia d'uso", 'Usage type')} last>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              ['internal', t('Solo uso interno', 'In-salon only'), t('Consumato nei trattamenti · non al punto cassa · scarico manuale', 'Used in treatments · not at checkout · manual decrement')],
              ['retail', t('Solo vendita al dettaglio', 'Retail only'), t('Venduto alle clienti · scarico automatico al punto cassa', 'Sold to clients · auto-decrement at POS')],
              ['mixed', t('Misto', 'Mixed'), t('Trattamenti + vendita · canali tracciati separatamente', 'Treatments + retail · channels tracked separately')],
            ].map(([v, l, d]) => {
              const on = draft.usage === v;
              return (
                <button key={v} onClick={() => canWrite && set({ usage: v })} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left', padding: '11px 13px', borderRadius: 10, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)' }}>
                  <span style={{ width: 18, height: 18, borderRadius: 99, border: '1.8px solid ' + (on ? 'var(--clay)' : 'var(--faint)'), background: on ? 'var(--clay)' : 'transparent', display: 'grid', placeItems: 'center', flexShrink: 0, marginTop: 1 }}>{on && <Icon name="check" size={11} color="#fff" stroke={2.6} />}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5, color: on ? 'var(--clay-ink)' : 'var(--ink)' }}>{l}</span>
                    <span className="t-sm" style={{ color: 'var(--muted)', marginTop: 2, display: 'block', lineHeight: 1.4 }}>{d}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Fld>
      </Sec>

      {/* ── Confezione ── */}
      <Sec title={t('Confezione', 'Packaging')}>
        <Fld label={t('Unità di misura', 'Unit of measure')}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {UNIT_OPTIONS.map((u) => {
              const on = draft.package_unit === u;
              return (
                <button key={u} onClick={() => canWrite && set({ package_unit: on ? '' : u })} style={{ padding: '6px 13px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{u}</button>
              );
            })}
          </div>
        </Fld>
        <Fld label={t('Quantità per confezione', 'Quantity per package')} hint={t('Risulta: ', 'Shows as: ') + (draft.package_qty || 1) + ' ' + curUnit} last>
          <NumBox value={draft.package_qty} onChange={(v) => set({ package_qty: v })} suffix={curUnit} width={170} disabled={!canWrite} />
        </Fld>
      </Sec>

      {/* ── Fornitore ── */}
      <Sec title={<React.Fragment>{t('Fornitore', 'Supplier')} <span style={{ color: 'var(--clay)' }}>*</span></React.Fragment>}>
        <SupplierPicker suppliers={suppliers} value={draft.supplier_id} onChange={(id) => set({ supplier_id: id })} canWrite={canWrite} t={t} />
        {draft.supplier_id == null && <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 6 }}>{t('Obbligatorio per la gestione degli ordini.', 'Required for order management.')}</div>}
      </Sec>

      {/* ── Prezzi e IVA ── */}
      <Sec title={t('Prezzi e IVA', 'Pricing & VAT')}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 16px' }}>
          <div>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Prezzo di acquisto', 'Purchase price')}</div>
            <MoneyBox value={draft.purchase_price} onChange={(v) => set({ purchase_price: v })} disabled={!canWrite} />
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 4 }}>{t('IVA esclusa', 'VAT excl.')}</div>
          </div>
          <div>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Sconto', 'Discount')}</div>
            <MoneyBox value={draft.purchase_discount_pct} onChange={(v) => set({ purchase_discount_pct: v })} suffix="%" disabled={!canWrite} />
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 4 }}>{t('Fornitore o promo', 'Supplier or promo')}</div>
          </div>
          <div>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Prezzo di vendita', 'Retail price')}</div>
            <MoneyBox value={draft.sale_price} onChange={(v) => set({ sale_price: v })} disabled={!canWrite} />
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 4 }}>{t('IVA inclusa', 'VAT incl.')}</div>
          </div>
          <div>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Aliquota IVA', 'VAT rate')}</div>
            <select value={draft.vat_rate} onChange={(e) => set({ vat_rate: parseInt(e.target.value, 10) })} disabled={!canWrite} style={{ ...inputCss, cursor: 'pointer' }}>
              {[4, 10, 22].map((v) => <option key={v} value={v}>{v}%</option>)}
            </select>
          </div>
        </div>
        {(() => {
          const net = unitCost(draft);                                  /* purchase_price × (1 − discount%) */
          const vatMul = 1 + num(draft.vat_rate) / 100;
          const buyIncl = net * vatMul;                                 /* net cost + IVA */
          const sale = num(draft.sale_price);                           /* IVA inclusa */
          /* L'IVA va scorporata dal prezzo di vendita prima del confronto: il
             prezzo d'acquisto è dichiarato IVA esclusa e sottrarlo da un prezzo
             lordo gonfiava il margine di tutta l'imposta (20 € IVA inclusa su
             10 € di costo: «€10 · 50%» invece di 6,39 € e circa 32%), e il
             titolare fissava i listini su un numero che non esiste. */
          const saleNet = sale / vatMul;                                /* vendita, IVA scorporata */
          const margin = round2(saleNet - net);                         /* vendita netta − costo netto */
          const marginPct = saleNet > 0 ? (margin / saleNet) * 100 : null;  /* guard divide-by-zero */
          const marginColor = margin > 0 ? 'var(--ok)' : (margin < 0 ? 'var(--danger)' : 'var(--ink)');
          return (
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', background: 'var(--surface-2)', borderRadius: 10 }}>
                <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600 }}>{t('Prezzo di acquisto IVA inclusa', 'Purchase price incl. VAT')}</span>
                <span className="t-num" style={{ fontSize: 17 }}>{eur0(buyIncl, lang, fmtEur)}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', background: 'var(--surface-2)', borderRadius: 10 }}>
                <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600 }}>{t('Margine', 'Margin')} <span style={{ color: 'var(--muted-2)', fontWeight: 500 }}>· {t('vendita IVA esclusa − costo netto', 'sale excl. VAT − net cost')}</span></span>
                <span className="t-num" style={{ fontSize: 17, color: marginColor }}>{eur0(margin, lang, fmtEur)}{marginPct != null ? ' · ' + marginPct.toFixed(0) + '%' : ''}</span>
              </div>
            </div>
          );
        })()}
      </Sec>

      {/* ── Scorte ── */}
      <Sec title={t('Scorte', 'Stock')}>
        {isNew ? (
          <Fld label={t('Scorta iniziale', 'Initial stock')} hint={t('Dopo la creazione cambia solo con Scarico / Carico / Rettifica.', 'After creation it changes only via Issue / Restock / Adjust.')}>
            <NumBox value={draft.initial_qty} onChange={(v) => set({ initial_qty: v })} suffix={curUnit} width={170} disabled={!canWrite} />
          </Fld>
        ) : (
          <Fld label={t('Giacenza attuale', 'Current stock')} hint={t('Ogni movimento richiede una causale e finisce nel registro.', 'Every movement needs a reason and is logged.')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="dk-iconbtn" disabled={!canWrite} style={{ width: 36, height: 36, borderRadius: 9, fontSize: 22, fontWeight: 600, border: '1px solid var(--hair)', opacity: canWrite ? 1 : 0.4 }} onClick={() => onAdj(prod, 'scarico')} title={t('Scarico', 'Issue')}>−</button>
              <span className="t-num" style={{ fontSize: 18, minWidth: 30, textAlign: 'center', color: lowItem ? STOCK_META.low.color : 'var(--ink)' }}>{fmtQty(qty, lang)}</span>
              <button className="dk-iconbtn" disabled={!canWrite} style={{ width: 36, height: 36, borderRadius: 9, fontSize: 22, fontWeight: 600, border: 'none', background: 'var(--clay)', color: '#fff', opacity: canWrite ? 1 : 0.4 }} onClick={() => onAdj(prod, 'carico')} title={t('Carico rapido', 'Quick restock')}>+</button>
            </div>
          </Fld>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 16px', marginBottom: 14 }}>
          <div>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Soglia minima', 'Minimum threshold')}</div>
            <NumBox value={draft.min_threshold} onChange={(v) => set({ min_threshold: v })} suffix={curUnit} width="100%" disabled={!canWrite} />
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 4 }}>{t('Avviso sottoscorta', 'Low-stock alert')}</div>
          </div>
          <div>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Quantità di riordino', 'Reorder quantity')}</div>
            <NumBox value={draft.reorder_qty} onChange={(v) => set({ reorder_qty: v })} suffix={curUnit} width="100%" disabled={!canWrite} />
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 4 }}>{t('Proposta nelle bozze d’ordine', 'Suggested in order drafts')}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 15px', background: 'var(--surface-2)', borderRadius: 10 }}>
          <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600 }}>{t('Valore totale a magazzino', 'Total stock value')}</span>
          <span className="t-num" style={{ fontSize: 20 }}>{eur0(qty * unitCost(draft), lang, fmtEur)}</span>
        </div>
      </Sec>

      {/* ── Registro movimenti (existing only) ── */}
      {!isNew && (
        <Sec title={<React.Fragment>{t('Registro movimenti', 'Movement log')} <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 500 }}>· {t('automatico', 'automatic')}</span></React.Fragment>} last>
          {moves === null ? (
            <div className="skel" style={{ height: 90, borderRadius: 10 }} />
          ) : moves.length === 0 ? (
            <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessun movimento registrato per questo prodotto.', 'No movements recorded for this product.')}</div>
          ) : (
            <div style={{ border: '1px solid var(--hair)', borderRadius: 10, overflow: 'hidden' }}>
              {moves.map((m, i) => {
                const meta = MOVE_META[m.kind] || MOVE_META.adjustment;
                const d = num(m.qty);
                return (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 14px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
                    <div style={{ width: 30, height: 30, borderRadius: 9, background: meta.tint, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={meta.icon} size={14} color={meta.color} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="t-sm" style={{ fontWeight: 700 }}>{meta[lang]}{m.reason ? ' · ' + m.reason : ''}</div>
                      <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{fmtWhen(m.created_at, lang)}{m.author_name ? ' · ' + m.author_name : ''}</div>
                    </div>
                    <span style={{ fontWeight: 700, fontSize: 14, color: d > 0 ? 'var(--ok)' : 'var(--ink-2)', flexShrink: 0 }}>{d > 0 ? '+' : ''}{fmtQty(d, lang)} {curUnit}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Sec>
      )}
    </DkModal>
  );
}
