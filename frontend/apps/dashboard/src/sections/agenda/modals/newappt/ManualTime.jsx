// ManualTime — «Orario a mano»: un orario anche fuori turno o sopra un'altra
// prenotazione. Se non è fra i liberi la prenotazione si forza (vedi create).
import { Icon } from '@youty/shared';

export default function ManualTime({ manualTime, setManualTime, step, applyManualTime, inputCss, t }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, border: '1px dashed var(--line-strong)', marginBottom: 18, flexWrap: 'wrap' }}>
      <Icon name="clock" size={16} color="var(--muted)" style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 170 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{t('Orario a mano', 'Type a time')}</div>
        <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{t('Anche fuori turno o sopra un’altra prenotazione.', 'Even off shift or over another booking.')}</div>
      </div>
      <input type="time" value={manualTime} step={step * 60} onChange={(e) => setManualTime(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyManualTime(); } }} aria-label={t('Orario manuale', 'Manual time')} style={{ ...inputCss, width: 112, padding: '7px 9px', fontFamily: 'var(--mono, monospace)', fontWeight: 700 }} />
      <button type="button" className="dk-btn dk-btn--soft" style={{ height: 36, fontSize: 12.5 }} disabled={!manualTime} onClick={applyManualTime}>{t('Usa', 'Use')}</button>
    </div>
  );
}
