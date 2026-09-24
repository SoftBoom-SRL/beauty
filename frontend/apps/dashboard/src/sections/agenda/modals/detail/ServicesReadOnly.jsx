// ServicesReadOnly — i servizi di una visita chiusa (o senza il permesso
// agenda): chi li fa, durata, prezzo, regalo, e il totale.
import { Icon, fmtDur, fmtEur } from '@youty/shared';
import { fmtMoney } from '../../lib.js';
import { usableCode } from '../rules.js';

export default function ServicesReadOnly({ appt, operators, t, lang }) {
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 14, padding: 14 }}>
      {(appt.items || []).map((it) => {
        const gift = (appt.gifts || []).find((g) => g.service_id === it.service_id);
        return (
          <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0' }}>
            <span style={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0 }}>{it.service_name}{gift && <span title={[t('Gift card', 'Gift card'), usableCode(gift.code)].filter(Boolean).join(' ')} style={{ marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '1px 7px', borderRadius: 99, verticalAlign: 'middle' }}><Icon name="gift" size={10} color="var(--clay-ink)" />{t('Regalo', 'Gift')}</span>}</span>
            <span className="t-sm" style={{ color: 'var(--muted)' }}>{[operators.find((x) => x.id === it.operator_id)?.first_name || it.operator_name, fmtDur(it.duration_min, lang), fmtEur(Number(it.price), lang)].filter(Boolean).join(' · ')}</span>
          </div>
        );
      })}
      <div className="hr" style={{ margin: '8px 0' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
        <span>{t('Totale', 'Total')}</span>
        <span className="t-num" style={{ fontSize: 17 }}>{fmtMoney(appt.total_price, lang)}</span>
      </div>
    </div>
  );
}
