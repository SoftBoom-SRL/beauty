// StayCard — «Stessa permanenza» nel dettaglio: gli altri appuntamenti della
// cliente nello stesso giorno, uno dopo l'altro (GET …/stay, services/stay.py).
// Mani con Sole e piedi con Mara sono due appuntamenti ma una visita sola:
// senza questo riquadro dal dettaglio di uno non si sapeva dell'altro (il
// titolare, 15/10). Un clic apre l'altro; a conto fatto si legge «Incassata
// insieme a». Senza hook: i dati li carica il pannello.
import { Icon, fmtEur, fmtTime } from '@youty/shared';

export default function StayCard({ appt, stay, t, lang, onOpen }) {
  const mates = (stay || []).filter((v) => v.id !== appt.id);
  if (!mates.length) return null;
  const myBill = (stay.find((v) => v.id === appt.id) || {}).bill_id ?? null;
  const allTogether = myBill != null && mates.every((v) => v.bill_id === myBill);
  const note = (v) => {
    if (v.bill_id == null) return null;
    return v.bill_id === myBill ? t('stesso conto', 'same bill') : t('incassata a parte', 'paid separately');
  };
  return (
    <div style={{ padding: '10px 14px', borderRadius: 12, border: '1.5px solid var(--clay)', background: 'color-mix(in srgb, var(--clay) 6%, var(--surface))' }}>
      <div className="t-meta" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <Icon name="link" size={13} color="var(--clay-ink)" />
        {allTogether ? t('Incassata insieme a', 'Paid together with') : t('Stessa permanenza', 'Same stay')}
      </div>
      {mates.map((v) => (
        <button key={v.id} onClick={() => onOpen(v.id)}
          title={t('Apri questo appuntamento', 'Open this appointment')}
          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '7px 0', background: 'transparent', border: 'none', borderTop: '1px solid var(--hair)', cursor: 'pointer', textAlign: 'left' }}>
          <span className="tabnum" style={{ fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{fmtTime(v.start)}–{fmtTime(v.end)}</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {(v.items || []).map((it) => it.service_name + (it.operator_name ? ' · ' + it.operator_name.split(' ')[0] : '')).join(', ')}
          </span>
          {note(v) && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', flexShrink: 0 }}>{note(v)}</span>}
          <span className="t-num" style={{ fontSize: 13, flexShrink: 0 }}>{fmtEur(Number(v.total_price), lang)}</span>
          <Icon name="chevR" size={14} color="var(--muted)" />
        </button>
      ))}
    </div>
  );
}
