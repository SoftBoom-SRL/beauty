// NoteFlexible — la nota della prenotazione e «Cliente flessibile» (disposta
// a spostarsi per ottimizzare l'agenda): in fondo a «Nuova prenotazione» e a
// ogni cliente della prenotazione di gruppo, dove prima mancavano e si
// dovevano aggiungere dopo, appuntamento per appuntamento.
import { Icon, Toggle } from '@youty/shared';

export default function NoteFlexible({ note, setNote, flexible, setFlexible, inputCss, t }) {
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div className="t-meta" style={{ marginBottom: 6 }}>{t('Nota (facoltativa)', 'Note (optional)')}</div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={t('es. preferisce il tono più freddo…', 'e.g. prefers the cooler tone…')} style={{ ...inputCss, width: '100%', resize: 'vertical' }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 13px', background: 'var(--surface-2)', borderRadius: 12 }}>
        <Icon name="refresh" size={17} color="var(--clay-ink)" />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Cliente flessibile', 'Flexible client')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 12 }}>{t('Disponibile a spostarsi per ottimizzare l’agenda', 'Open to being moved to optimise the agenda')}</div>
        </div>
        <Toggle on={flexible} onChange={setFlexible} label={t('Cliente flessibile', 'Flexible client')} />
      </div>
    </div>
  );
}
