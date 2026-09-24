// ReasonPicker — la motivazione di no-show e annullamento (per le statistiche)
// e la nota facoltativa. Sta a livello di modulo e si disegna come
// <ReasonPicker/>: definito dentro il pannello era un componente nuovo a ogni
// render, e React rimontava la textarea a ogni tasto (il campo perdeva il
// fuoco dopo ogni lettera); per questo prima lo si chiamava come funzione.
// `reasons` = [chiave, italiano, inglese]; il titolare può personalizzarle
// dalle Impostazioni.
import { reasonNoteMax } from '../rules.js';

export default function ReasonPicker({ reasons, reason, setReason, reasonNote, setReasonNote, t, session, onClose, setDeepLink, setTab }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 9 }}>
        <div className="t-meta">{t('Motivazione (per le statistiche)', 'Reason (for statistics)')}</div>
        {session?.is_owner && (
          <button type="button" onClick={() => { onClose?.(); setDeepLink?.('reasons'); setTab('impostazioni'); }} style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer', background: 'transparent', border: 'none' }}>{t('Personalizza', 'Customise')}</button>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {reasons.map(([k, it, en]) => {
          const on = reason === k;
          return <button key={k} onClick={() => setReason(k)} style={{ padding: '8px 14px', borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1.5px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{t(it, en)}</button>;
        })}
      </div>
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Nota (facoltativa)', 'Note (optional)')}</div>
      {/* motivazione + nota vanno in un campo da 255 caratteri (ReasonIn): oltre,
          il no-show non veniva registrato e l'avviso era in inglese (17-12) */}
      <textarea value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} placeholder={t('Aggiungi un dettaglio…', 'Add a detail…')} rows={2}
        maxLength={reasonNoteMax((reasons.find((r) => r[0] === reason) || [])[1] || '')}
        style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 12, padding: '10px 12px', fontSize: 13.5, fontFamily: 'var(--sans)', resize: 'vertical', outline: 'none', boxSizing: 'border-box', background: 'var(--surface)' }} />
    </div>
  );
}
