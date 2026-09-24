// cart/ProductGrid.jsx — il catalogo del banco (CartTab): una scheda per
// prodotto con prezzo e giacenza; un clic lo mette nel carrello, e il numero
// in alto a destra dice quanti ce ne sono già.
import { Icon } from '@youty/shared';
import { money } from '../lib.js';

const stockMeta = (state, t) => {
  if (state === 'low') return { label: t('Scorta bassa', 'Low stock'), color: 'var(--danger)', tint: 'var(--danger-tint)' };
  if (state === 'warning') return { label: t('In esaurimento', 'Running low'), color: 'var(--warn)', tint: 'var(--warn-tint)' };
  return { label: t('Disponibile', 'In stock'), color: 'var(--muted)', tint: 'var(--paper-2)' };
};

/* `products` null = catalogo in arrivo; `list` = quello da mostrare (con la
 * ricerca); `searching` = ricerca lato server in corso. */
export default function ProductGrid({ products, list, cart, searching, onAdd, t, lang }) {
  return products === null ? (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
      {[...Array(6)].map((_, i) => <div key={i} className="skel" style={{ height: 128, borderRadius: 16 }} />)}
    </div>
  ) : (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
      {list.map((p) => {
        const inCart = cart.find((l) => l.line_type === 'product' && l.product_id === p.id);
        const sm = stockMeta(p.stock_state, t);
        return (
          <button key={p.id} onClick={() => onAdd(p)} className="dk-card"
            style={{ padding: 16, textAlign: 'left', cursor: 'pointer', border: '1px solid ' + (inCart ? 'var(--clay)' : 'var(--hair)'), position: 'relative', transition: 'border-color 140ms' }}>
            {inCart && <span style={{ position: 'absolute', top: 10, right: 10, minWidth: 22, height: 22, padding: '0 6px', borderRadius: 99, background: 'var(--clay)', color: '#fff', fontSize: 12, fontWeight: 700, display: 'grid', placeItems: 'center' }}>{inCart.qty}</span>}
            <div style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', marginBottom: 12 }}>
              <Icon name="box" size={20} color="var(--clay-ink)" />
            </div>
            <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.25 }}>{p.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
              <span className="t-num" style={{ fontSize: 16, fontWeight: 700 }}>{money(p.sale_price, lang)}</span>
              <span title={sm.label} style={{ fontSize: 11, fontWeight: 700, color: sm.color, background: sm.tint, padding: '2px 8px', borderRadius: 99, marginLeft: 'auto' }}>
                {Number(p.stock_qty)} {t('pz', 'pcs')}
              </span>
            </div>
          </button>
        );
      })}
      {!list.length && <div className="t-sm" style={{ color: 'var(--muted-2)', gridColumn: '1 / -1', textAlign: 'center', padding: 32 }}>{searching ? t('Ricerca nel catalogo…', 'Searching the catalogue…') : t('Nessun prodotto trovato', 'No products found')}</div>}
    </div>
  );
}
