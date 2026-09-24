// NotesTab.jsx — note libere sul cliente (non legate a una visita): composer con
// foto/documenti + elenco. Le note di trattamento vivono nello Storico, sotto la
// visita a cui appartengono, ma compaiono anche qui (con il riferimento).
import { useEffect, useState } from 'react';
import { api, EmptyState, Icon, toastApiError } from '@youty/shared';
import { useDash } from '../../../ctx.jsx';
import { NoteCard, NoteComposer } from '../NoteBits.jsx';
import { dateLabel } from '../helpers.js';

export { VisibilityToggle } from '../NoteBits.jsx';

export default function NotesTab({ clientId }) {
  const { t, lang, fireToast, hasScope } = useDash();
  const canWrite = hasScope('clients');
  const [notes, setNotes] = useState(null);
  const [filter, setFilter] = useState('all'); // all | free | visit | files

  useEffect(() => {
    let dead = false;
    setNotes(null);
    api.get(`/api/clients/${clientId}/notes`)
      .then((rows) => { if (!dead) setNotes(rows); })
      .catch((err) => { if (!dead) { setNotes([]); toastApiError(err, fireToast, t); } });
    return () => { dead = true; };
  }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = (notes || []).filter((n) => filter === 'all' || (filter === 'free' && !n.appointment_id) || (filter === 'visit' && n.appointment_id) || (filter === 'files' && n.attachments?.length));
  const aiCount = (notes || []).filter((n) => n.visibility === 'ai' || n.visibility === 'shared').length;
  const filesCount = (notes || []).reduce((s, n) => s + (n.attachments?.length || 0), 0);

  return (
    <div style={{ maxWidth: 680 }}>
      {canWrite && (
        <div style={{ marginBottom: 14 }}>
          <NoteComposer clientId={clientId} onSaved={(n) => setNotes((l) => [n, ...(l || [])])} />
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {[['all', t('Tutte', 'All'), (notes || []).length], ['free', t('Generali', 'General'), (notes || []).filter((n) => !n.appointment_id).length], ['visit', t('Di trattamento', 'Treatment'), (notes || []).filter((n) => n.appointment_id).length], ['files', t('Con allegati', 'With files'), (notes || []).filter((n) => n.attachments?.length).length]].map(([k, l, n]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} className={'dk-pill' + (filter === k ? ' dk-pill--on' : '')} style={{ padding: '4px 11px', fontSize: 12.5 }}>{l} <span style={{ opacity: 0.7 }}>· {n}</span></button>
        ))}
        <span className="t-sm" style={{ marginLeft: 'auto', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon name="sparkle" size={13} color="var(--clay-ink)" />{aiCount} {t("visibili all'AI", 'visible to AI')} · <Icon name="camera" size={13} color="var(--muted)" />{filesCount} {t('allegati', 'files')}
        </span>
      </div>

      {notes == null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[...Array(2)].map((_, i) => <div key={i} className="skel" style={{ height: 86, borderRadius: 12 }} />)}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map((n) => (
            <div key={n.id}>
              {n.appointment_id && <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11.5, margin: '0 0 4px 4px', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="calendar" size={11} color="var(--muted-2)" />{t('Nota di trattamento', 'Treatment note')} · {dateLabel(n.created_at, lang)}</div>}
              <NoteCard note={n} clientId={clientId} canWrite={canWrite}
                onChanged={(u) => setNotes((l) => l.map((x) => (x.id === u.id ? u : x)))}
                onDeleted={(d) => setNotes((l) => l.filter((x) => x.id !== d.id))} />
            </div>
          ))}
          {!list.length && <EmptyState icon="edit" title={t('Nessuna nota', 'No notes')} sub={filter === 'all' ? t('Aggiungi la prima nota su questo cliente, anche con una foto.', 'Add the first note about this client, photos welcome.') : t('Nessuna nota in questo filtro.', 'No notes match this filter.')} />}
        </div>
      )}
    </div>
  );
}
