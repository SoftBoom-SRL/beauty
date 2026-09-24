// sell/LinePicker.jsx — la ricerca per aggiungere un prodotto o un servizio
// extra al blocco di un'operatrice nel check-out (SellModal).
import { Icon } from '@youty/shared';
import { money, svcLabel } from '../lib.js';

/* `type` 'product' | 'service'; `items` = i risultati da mostrare;
 * `products` null = catalogo prodotti ancora in arrivo; `searching` = ricerca
 * lato server in corso. */
export default function LinePicker({ type, q, onQ, onClose, items, products, searching, onPick, t, lang }) {
  return (
    <div style={{ position: 'relative', marginTop: 10 }}>
      <div className="dk-search" style={{ width: '100%', height: 36 }}>
        <Icon name="search" size={15} color="var(--muted-2)" />
        <input autoFocus value={q} onChange={(e) => onQ(e.target.value)}
          placeholder={type === 'product' ? t('Cerca un prodotto…', 'Search a product…') : t('Cerca un servizio…', 'Search a service…')} />
        <button onClick={onClose} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
          <Icon name="x" size={14} color="var(--muted-2)" />
        </button>
      </div>
      <div className="dk-card scroll" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20, padding: 6, boxShadow: 'var(--sh-pop)', maxHeight: 200, overflowY: 'auto' }}>
        {type === 'product' && products === null && <div style={{ padding: 6 }}>{[0, 1].map((i) => <div key={i} className="skel" style={{ height: 32, borderRadius: 8, marginBottom: i === 0 ? 6 : 0 }} />)}</div>}
        {items.map((x) => (
          <button key={x.id} className="dk-row" onClick={() => onPick(x)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 8, textAlign: 'left', cursor: 'pointer' }}>
            <Icon name={type === 'product' ? 'box' : 'scissors'} size={15} color="var(--muted-2)" />
            <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {type === 'product' ? x.name : svcLabel(x, lang)}
            </span>
            <span className="t-num" style={{ fontSize: 13, color: 'var(--muted)' }}>{money(type === 'product' ? x.sale_price : x.price, lang)}</span>
          </button>
        ))}
        {!items.length && (type !== 'product' || products !== null) && (
          <div className="t-sm" style={{ color: 'var(--muted-2)', padding: 12, textAlign: 'center' }}>
            {type === 'product' ? (searching ? t('Ricerca nel catalogo…', 'Searching the catalogue…') : t('Nessun prodotto', 'No products')) : t('Nessun servizio', 'No services')}
          </div>
        )}
      </div>
    </div>
  );
}
