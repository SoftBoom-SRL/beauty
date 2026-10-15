// sell/OtherVisits.jsx — «Altre visite di <cliente> oggi» nel check-out: le
// visite aperte della stessa cliente nello stesso giorno, ancora da incassare
// (GET /api/sales/checkout/{id}/other-visits), con una spunta per chiuderle
// nello stesso conto. Mani e piedi con due operatrici sono due appuntamenti:
// spuntata, la seconda visita porta le sue righe nel blocco della sua
// operatrice e la sua caparra nel conto (visits.js). Quelle della stessa
// permanenza (`stayIds`: una dopo l'altra, agenda/lib/stay.js) arrivano già
// spuntate dalla cassa e qui si leggono «insieme».
import { Icon, fmtTime } from '@youty/shared';
import { money } from '../lib.js';

export default function OtherVisits({ visits, included, stayIds = [], onToggle, clientName, t, lang }) {
  if (!visits || !visits.length) return null;
  const together = stayIds.length > 0;
  return (
    <div style={{ border: together ? '1.5px solid var(--clay)' : '1px dashed var(--hair)', borderRadius: 14, padding: '10px 14px', background: together ? 'color-mix(in srgb, var(--clay) 6%, var(--surface))' : 'transparent' }}>
      <div className="t-meta" style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
        {together && <Icon name="link" size={13} color="var(--clay-ink)" />}
        {together
          ? t(`Conto unico: la permanenza di ${clientName || 'questa cliente'} oggi`, `Single bill: ${clientName || 'this client'}'s stay today`)
          : clientName ? t(`Altre visite di ${clientName} oggi`, `${clientName}'s other visits today`) : t('Altre visite oggi', 'Other visits today')}
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
            {stayIds.includes(v.id) && (
              <span title={t('Subito prima o dopo questa visita: la stessa permanenza', 'Right before or after this visit: the same stay')}
                style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--clay-ink)', background: 'color-mix(in srgb, var(--clay) 14%, transparent)', borderRadius: 6, padding: '1px 6px', flexShrink: 0 }}>
                {t('insieme', 'together')}
              </span>
            )}
            <span className="t-num" style={{ fontSize: 13, flexShrink: 0 }}>{money(v.total_price, lang)}</span>
          </button>
        );
      })}
      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4 }}>
        {together
          ? t('Già nel conto: togli la spunta se paga a parte. Ogni servizio resta accreditato alla sua operatrice.', 'Already in the bill: untick if paid separately. Each service stays credited to its stylist.')
          : t('Spuntale per un conto unico: ogni servizio resta accreditato alla sua operatrice.', 'Tick them for a single bill: each service stays credited to its stylist.')}
      </div>
    </div>
  );
}
