// SearchToolbar.jsx — campo di ricerca + filtri (`extra`) + pulsante «Nuovo»,
// in cima alle liste di Servizi, Pacchetti e Prodotti (era copiato in due
// sezioni).
import { Icon } from '@youty/shared';

/* Il pulsante «Nuovo» c'è se `canAdd` (di default: se c'è `onAdd`). */
export default function SearchToolbar({ q, setQ, placeholder, onAdd, addLabel, canAdd = !!onAdd, extra }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
      <div className="dk-search" style={{ flex: 1, minWidth: 0, width: 'auto' }}>
        <Icon name="search" size={18} color="var(--muted-2)" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} />
        {q && (
          <button className="press" onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
            <Icon name="x" size={15} color="var(--muted-2)" />
          </button>
        )}
      </div>
      {extra}
      {canAdd && (
        <button className="dk-btn dk-btn--clay" onClick={onAdd} style={{ flexShrink: 0 }}>
          <Icon name="plus" size={17} color="#fff" />{addLabel}
        </button>
      )}
    </div>
  );
}
