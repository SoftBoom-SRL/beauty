// sell/OtherVisits.jsx — «Altre visite di <cliente> oggi» nel check-out: le
// visite aperte della stessa cliente nello stesso giorno, ancora da incassare
// (GET /api/sales/checkout/{id}/other-visits), con una spunta per chiuderle
// nello stesso conto. Mani e piedi con due operatrici sono due appuntamenti:
// spuntata, la seconda visita porta le sue righe nel blocco della sua
// operatrice e la sua caparra nel conto (visits.js).
import { Icon, fmtTime } from '@youty/shared';
import { money } from '../lib.js';

export default function OtherVisits({ visits, included, onToggle, clientName, t, lang }) {
  if (!visits || !visits.length) return null;
  return (
    <div style={{ border: '1px dashed var(--hair)', borderRadius: 14, padding: '10px 14px' }}>
      <div className="t-meta" style={{ marginBottom: 4 }}>
        {clientName ? t(`Altre visite di ${clientName} oggi`, `${clientName}'s other visits today`) : t('Altre visite oggi', 'Other visits today')}
      </div>
      {visits.map((v) => {
        const on = included.includes(v.id);
        return (
          <button key={v.id} onClick={() => onToggle(v)} aria-pressed={on}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 0', background: 'transparent', border: 'none', borderTop: '1px solid var(--hair)', cursor: 'pointer', textAlign: 'left' }}>
            <span style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, display: 'grid', placeItems: 'center', border: '1.5px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)' }}>
              {on && <Icon name="check" size={13} color="#fff" stroke={2.6} />}
            </span>
            <span className="tabnum" style={{ fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{fmtTime(v.start)}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: on ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {(v.items || []).map((it) => it.service_name + (it.operator_name ? ' · ' + it.operator_name : '')).join(', ')}
            </span>
            <span className="t-num" style={{ fontSize: 13, flexShrink: 0 }}>{money(v.total_price, lang)}</span>
          </button>
        );
      })}
      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4 }}>
        {t('Spuntale per un conto unico: ogni servizio resta accreditato alla sua operatrice.', 'Tick them for a single bill: each service stays credited to its stylist.')}
      </div>
    </div>
  );
}
