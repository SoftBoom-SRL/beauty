// shell/ApptSearchResults.jsx — sotto la ricerca della barra in alto: gli
// appuntamenti delle clienti che rispondono a quello che si scrive (nome o
// telefono). Prima si trovava solo la scheda della cliente, e per sapere «a
// che ora ho domani?» bisognava aprirla e cercare nello storico (Beauty
// Boutique, 11/2026). Un clic apre l'appuntamento in agenda.
import { useEffect, useState } from 'react';
import { Icon } from '@youty/shared';
import { searchAppointments } from '../sections/agenda/agendaApi.js';
import { hitDetail, hitWhen, shouldSearch } from './apptSearch.js';

const DEBOUNCE_MS = 250;

export default function ApptSearchResults({ q, onPick, t, lang }) {
  const [state, setState] = useState({ q: '', hits: [], loading: false });
  useEffect(() => {
    if (!shouldSearch(q)) { setState({ q: '', hits: [], loading: false }); return undefined; }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      searchAppointments(q.trim())
        .then((hits) => { if (alive) setState({ q, hits: hits || [], loading: false }); })
        .catch(() => { if (alive) setState({ q, hits: [], loading: false }); });
    }, DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [q]);

  if (!shouldSearch(q)) return null;
  const { hits, loading } = state;
  return (
    <div className="dk-card scroll" style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, width: 380, maxWidth: '90vw', zIndex: 61, padding: 6, boxShadow: 'var(--sh-pop)', maxHeight: 'min(440px, 70vh)', overflowY: 'auto' }}>
      <div className="t-meta" style={{ padding: '6px 10px 4px' }}>{t('Appuntamenti', 'Appointments')}</div>
      {loading && !hits.length && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '8px 10px' }}>{t('Ricerca…', 'Searching…')}</div>}
      {!loading && !hits.length && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '8px 10px' }}>{t('Nessun appuntamento', 'No appointments')}</div>}
      {hits.map((h) => (
        <button key={h.id} type="button" className="dk-row" onClick={() => onPick(h)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 8, textAlign: 'left', cursor: 'pointer' }}>
          <Icon name="calendar" size={15} color="var(--clay-ink)" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {h.client.full_name} · <span className="t-num" style={{ fontWeight: 600 }}>{hitWhen(h, lang)}</span>
            </div>
            <div className="t-sm" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hitDetail(h)}</div>
          </div>
          <Icon name="chevR" size={13} color="var(--muted-2)" />
        </button>
      ))}
    </div>
  );
}
